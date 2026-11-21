use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::net::UdpSocket;
use tracing::{debug, info, warn};

use crate::auth::AuthVerifier;
use crate::rooms::RoomManager;

#[derive(Debug, Deserialize)]
struct AuthHandshake {
    access_token: String,
    instance_id: String,
}

#[derive(Debug, Serialize)]
struct HandshakeResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    instance_id: Option<String>,
}

pub struct BridgeContext {
    pub verifier: Arc<dyn AuthVerifier>,
    pub rooms: Arc<RoomManager>,
    pub bind_ip: String,
    pub auth_timeout: Duration,
    pub max_datagram_bytes: usize,
}

async fn send_handshake_error(ws: &mut WebSocket, code: &str) {
    let payload = serde_json::to_string(&HandshakeResponse {
        ok: false,
        error: Some(code.to_string()),
        user_id: None,
        username: None,
        instance_id: None,
    })
    .unwrap_or_else(|_| r#"{"ok":false,"error":"internal_error"}"#.to_string());
    let _ = ws.send(Message::Text(payload.into())).await;
    let _ = ws.send(Message::Close(None)).await;
}

pub async fn handle_ws(mut ws: WebSocket, ctx: Arc<BridgeContext>) {
    // Step 1: Expect a JSON text auth frame within `auth_timeout`.
    let auth_msg = match tokio::time::timeout(ctx.auth_timeout, ws.recv()).await {
        Ok(Some(Ok(Message::Text(text)))) => text,
        Ok(Some(Ok(_))) => {
            send_handshake_error(&mut ws, "expected_text_handshake").await;
            return;
        }
        Ok(_) => return,
        Err(_) => {
            send_handshake_error(&mut ws, "auth_timeout").await;
            return;
        }
    };

    let handshake: AuthHandshake = match serde_json::from_str(&auth_msg) {
        Ok(h) => h,
        Err(_) => {
            send_handshake_error(&mut ws, "invalid_handshake_json").await;
            return;
        }
    };

    // Step 2: Verify Discord user token + Activity instance membership.
    let session = match ctx
        .verifier
        .verify(&handshake.access_token, &handshake.instance_id)
        .await
    {
        Ok(s) => s,
        Err(err) => {
            warn!(error = %err, "rejected WebSocket auth");
            send_handshake_error(&mut ws, &err.to_string()).await;
            return;
        }
    };

    // Step 3: Join existing room or spawn headless STK server for this instance_id.
    let lease = match ctx
        .rooms
        .join_or_spawn(&session.instance_id, &session.user_id)
        .await
    {
        Ok(lease) => lease,
        Err(err) => {
            warn!(
                instance_id = %session.instance_id,
                user_id = %session.user_id,
                error = %err,
                "failed to join/spawn room"
            );
            send_handshake_error(&mut ws, &err.to_string()).await;
            return;
        }
    };

    // Give a freshly spawned STK server a brief window to bind its UDP port.
    if lease.newly_spawned {
        tokio::time::sleep(Duration::from_millis(600)).await;
    }

    // Step 4: Bind a dedicated ephemeral local UDP socket for this client.
    let bind_addr = format!("{}:0", ctx.bind_ip);
    let target_addr = format!("{}:{}", ctx.bind_ip, lease.port);
    let udp = match UdpSocket::bind(&bind_addr).await {
        Ok(sock) => sock,
        Err(err) => {
            warn!(error = %err, "failed to bind per-client UDP socket");
            ctx.rooms
                .leave(&lease.instance_id, &lease.user_id, lease.conn_id)
                .await;
            send_handshake_error(&mut ws, "udp_bind_failed").await;
            return;
        }
    };
    if let Err(err) = udp.connect(&target_addr).await {
        warn!(error = %err, target = %target_addr, "failed to connect UDP socket");
        ctx.rooms
            .leave(&lease.instance_id, &lease.user_id, lease.conn_id)
            .await;
        send_handshake_error(&mut ws, "udp_connect_failed").await;
        return;
    }

    // Step 5: Acknowledge handshake; subsequent binary frames are raw ENet datagrams.
    let ok_payload = serde_json::to_string(&HandshakeResponse {
        ok: true,
        error: None,
        user_id: Some(session.user_id.clone()),
        username: Some(session.username.clone()),
        instance_id: Some(session.instance_id.clone()),
    })
    .unwrap();
    if ws.send(Message::Text(ok_payload.into())).await.is_err() {
        ctx.rooms
            .leave(&lease.instance_id, &lease.user_id, lease.conn_id)
            .await;
        return;
    }

    info!(
        instance_id = %session.instance_id,
        user_id = %session.user_id,
        room_port = lease.port,
        "client bridged to STK room"
    );

    let (mut ws_tx, mut ws_rx) = ws.split();
    let mut kick_rx = lease.kick_rx;
    let mut udp_buf = vec![0u8; 2048];
    let max_bytes = ctx.max_datagram_bytes;

    loop {
        tokio::select! {
            _ = &mut kick_rx => {
                debug!(user_id = %session.user_id, "connection superseded by reconnect");
                let _ = ws_tx.send(Message::Close(None)).await;
                break;
            }
            ws_item = ws_rx.next() => {
                match ws_item {
                    Some(Ok(Message::Binary(data))) => {
                        if data.is_empty() || data.len() > max_bytes {
                            debug!(len = data.len(), "dropped out-of-bounds datagram");
                            continue;
                        }
                        if let Err(err) = udp.send(&data).await {
                            debug!(error = %err, "udp send error");
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        if ws_tx.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(err)) => {
                        debug!(error = %err, "ws recv error");
                        break;
                    }
                }
            }
            udp_res = udp.recv(&mut udp_buf) => {
                match udp_res {
                    Ok(n) if n > 0 => {
                        if ws_tx.send(Message::Binary(udp_buf[..n].to_vec().into())).await.is_err() {
                            break;
                        }
                    }
                    Ok(_) => {}
                    Err(err) => {
                        // ICMP port-unreachable can happen briefly while STK finishes binding.
                        debug!(error = %err, "udp recv error");
                    }
                }
            }
        }
    }

    ctx.rooms
        .leave(&lease.instance_id, &lease.user_id, lease.conn_id)
        .await;
    info!(
        instance_id = %session.instance_id,
        user_id = %session.user_id,
        "client disconnected from STK room"
    );
}
