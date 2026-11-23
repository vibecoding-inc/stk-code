mod auth;
mod bridge;
mod config;
mod matches;
mod rooms;

use std::sync::Arc;

use axum::extract::{State, WebSocketUpgrade};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;
use tracing::{info, warn};

use crate::auth::{AuthVerifier, DevInsecureVerifier, DiscordApiVerifier};
use crate::bridge::{handle_ws, BridgeContext};
use crate::config::Config;
use crate::matches::MatchUploader;
use crate::rooms::{RoomManager, StkServerSpawner};

#[derive(Clone)]
struct AppState {
    bridge: Arc<BridgeContext>,
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    active_rooms: usize,
    max_rooms: usize,
    active_clients: usize,
}

async fn healthz(State(state): State<AppState>) -> Json<HealthResponse> {
    let stats = state.bridge.rooms.stats().await;
    Json(HealthResponse {
        status: "ok",
        active_rooms: stats.active_rooms,
        max_rooms: stats.max_rooms,
        active_clients: stats.active_clients,
    })
}

async fn ws_lan(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    let ctx = Arc::clone(&state.bridge);
    ws.on_upgrade(move |socket| handle_ws(socket, ctx))
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut sig) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            sig.recv().await;
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "stk_gateway=info".into()),
        )
        .init();

    let cfg = match Config::from_env() {
        Ok(c) => c,
        Err(err) => {
            eprintln!("Configuration error: {err}");
            std::process::exit(1);
        }
    };

    let verifier: Arc<dyn AuthVerifier> = if cfg.dev_insecure_auth {
        warn!("DEV_INSECURE_AUTH=1 is enabled — Discord token/instance verification is BYPASSED");
        Arc::new(DevInsecureVerifier)
    } else {
        Arc::new(DiscordApiVerifier::new(
            cfg.discord_api_base.clone(),
            cfg.discord_application_id.clone(),
            cfg.discord_bot_token.clone(),
            cfg.allowed_guild_ids.clone(),
            cfg.auth_cache_ttl,
        ))
    };

    let match_uploader = match (&cfg.match_upload_url, &cfg.gateway_api_secret) {
        (Some(url), Some(secret)) => {
            info!(url = %url, "multiplayer match scoreboard & replay upload enabled");
            Some(Arc::new(MatchUploader::new(url.clone(), secret.clone())))
        }
        _ => {
            info!("MATCH_UPLOAD_URL / GATEWAY_API_SECRET not set — multiplayer match uploads disabled");
            None
        }
    };

    let spawner = Arc::new(StkServerSpawner::new(
        cfg.stk_binary.clone(),
        cfg.stk_data_dir.clone(),
        cfg.max_players_per_room,
        match_uploader,
    ));

    let rooms = Arc::new(RoomManager::new(
        spawner,
        cfg.port_range_start,
        cfg.port_range_end,
        cfg.max_players_per_room,
        cfg.room_idle_timeout,
    ));

    let bridge = Arc::new(BridgeContext {
        verifier,
        rooms: Arc::clone(&rooms),
        bind_ip: cfg.bind_ip.clone(),
        auth_timeout: cfg.auth_handshake_timeout,
        max_datagram_bytes: cfg.max_datagram_bytes,
    });

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/api/lan", get(ws_lan))
        .route("/api/lan/", get(ws_lan))
        .route("/", get(ws_lan))
        .with_state(AppState { bridge });

    let listener = tokio::net::TcpListener::bind(cfg.listen_addr)
        .await
        .expect("failed to bind gateway listener");

    info!(
        addr = %cfg.listen_addr,
        ports = %format!("{}..{}", cfg.port_range_start, cfg.port_range_end),
        "stk-gateway listening"
    );

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("server error");

    rooms.shutdown_all().await;
    info!("stk-gateway stopped cleanly");
}
