use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tracing::{info, warn};

pub const MATCH_RESULT_PREFIX: &str = "STK_GATEWAY_MATCH_RESULT=";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientIdentity {
    pub user_id: String,
    pub username: String,
}

/// Maps a room's per-client ephemeral local UDP source port to the verified Discord identity.
pub type PeerRegistry = Arc<Mutex<HashMap<u16, ClientIdentity>>>;

#[derive(Debug, Clone, Deserialize)]
pub struct RawKartResult {
    pub kart_index: usize,
    pub display_name: String,
    pub kart: String,
    #[serde(default)]
    pub kart_color: f64,
    pub rank: i32,
    pub finish_time_ms: Option<i64>,
    #[serde(default)]
    pub dnf: bool,
    #[serde(default)]
    pub is_ai: bool,
    pub peer_port: Option<u16>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RawMatchResult {
    pub track: String,
    pub mode: String,
    pub difficulty: i32,
    pub laps: i32,
    #[serde(default)]
    pub reverse: bool,
    #[serde(default = "default_replay_version")]
    pub replay_version: i32,
    pub replay_path: Option<String>,
    pub results: Vec<RawKartResult>,
}

fn default_replay_version() -> i32 {
    4
}

#[derive(Debug, Clone, Serialize)]
struct EnrichedKartResult {
    kart_index: usize,
    discord_user_id: Option<String>,
    username: Option<String>,
    display_name: String,
    kart: String,
    kart_color: f64,
    rank: i32,
    finish_time_ms: Option<i64>,
    dnf: bool,
    is_ai: bool,
}

#[derive(Debug, Clone, Serialize)]
struct CreateMatchPayload {
    instance_id: String,
    scope_type: Option<String>,
    scope_id: Option<String>,
    channel_id: Option<String>,
    track: String,
    mode: String,
    difficulty: i32,
    laps: i32,
    reverse: bool,
    played_at: u64,
    results: Vec<EnrichedKartResult>,
}

#[derive(Debug, Deserialize)]
struct CreateMatchResponse {
    match_id: String,
}

/// Parses a `STK_GATEWAY_MATCH_RESULT={...}` line emitted on headless STK stdout.
pub fn parse_match_result_line(line: &str) -> Option<RawMatchResult> {
    let idx = line.find(MATCH_RESULT_PREFIX)?;
    let json_str = line[idx + MATCH_RESULT_PREFIX.len()..].trim();
    match serde_json::from_str::<RawMatchResult>(json_str) {
        Ok(parsed) => Some(parsed),
        Err(err) => {
            warn!(error = %err, "failed to parse STK_GATEWAY_MATCH_RESULT JSON");
            None
        }
    }
}

/// Extracts `(scope_type, scope_id, channel_id)` from a Discord Activity `instance_id`:
/// - `i-<launch>-gc-<guild_id>-<channel_id>` -> `("guild", guild_id, channel_id)`
/// - `i-<launch>-dm-<channel_id>` / `i-<launch>-gd-<channel_id>` -> `("dm", channel_id, channel_id)`
pub fn extract_scope_from_instance(
    instance_id: &str,
) -> (Option<String>, Option<String>, Option<String>) {
    let parts: Vec<&str> = instance_id.split('-').collect();
    if parts.len() >= 5 && parts[0] == "i" && parts[2] == "gc" {
        return (
            Some("guild".to_string()),
            Some(parts[3].to_string()),
            Some(parts[4].to_string()),
        );
    }
    if parts.len() >= 4 && parts[0] == "i" && (parts[2] == "dm" || parts[2] == "gd") {
        return (
            Some("dm".to_string()),
            Some(parts[3].to_string()),
            Some(parts[3].to_string()),
        );
    }
    (None, None, None)
}

#[derive(Clone)]
pub struct MatchUploader {
    client: reqwest::Client,
    base_url: String,
    api_secret: String,
}

impl MatchUploader {
    pub fn new(base_url: String, api_secret: String) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("failed to build reqwest client for match uploader");
        Self {
            client,
            base_url: base_url.trim_end_matches('/').to_string(),
            api_secret,
        }
    }

    pub async fn upload_match(
        &self,
        instance_id: &str,
        raw: RawMatchResult,
        peers: &HashMap<u16, ClientIdentity>,
    ) -> Result<String, String> {
        let replay_path = raw.replay_path.clone();
        let replay_version = raw.replay_version;
        let result = self
            .upload_match_inner(instance_id, raw, peers, replay_path.as_deref(), replay_version)
            .await;

        // Always clean up the temporary server replay file so disk usage stays bounded.
        if let Some(ref path) = replay_path {
            if let Err(err) = tokio::fs::remove_file(Path::new(path)).await {
                if err.kind() != std::io::ErrorKind::NotFound {
                    warn!(path = %path, error = %err, "failed to remove temp replay file");
                }
            }
        }

        result
    }

    async fn upload_match_inner(
        &self,
        instance_id: &str,
        raw: RawMatchResult,
        peers: &HashMap<u16, ClientIdentity>,
        replay_path: Option<&str>,
        replay_version: i32,
    ) -> Result<String, String> {
        let (scope_type, scope_id, channel_id) = extract_scope_from_instance(instance_id);
        let played_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        let enriched_results: Vec<EnrichedKartResult> = raw
            .results
            .into_iter()
            .map(|r| {
                let identity = if r.is_ai {
                    None
                } else {
                    r.peer_port.and_then(|port| peers.get(&port))
                };
                EnrichedKartResult {
                    kart_index: r.kart_index,
                    discord_user_id: identity.map(|id| id.user_id.clone()),
                    username: identity.map(|id| id.username.clone()),
                    display_name: r.display_name,
                    kart: r.kart,
                    kart_color: r.kart_color,
                    rank: r.rank,
                    finish_time_ms: r.finish_time_ms,
                    dnf: r.dnf,
                    is_ai: r.is_ai,
                }
            })
            .collect();

        let payload = CreateMatchPayload {
            instance_id: instance_id.to_string(),
            scope_type,
            scope_id,
            channel_id,
            track: raw.track,
            mode: raw.mode,
            difficulty: raw.difficulty,
            laps: raw.laps,
            reverse: raw.reverse,
            played_at,
            results: enriched_results,
        };

        let create_url = format!("{}/api/matches", self.base_url);
        let resp = self
            .client
            .post(&create_url)
            .bearer_auth(&self.api_secret)
            .json(&payload)
            .send()
            .await
            .map_err(|e| format!("POST /api/matches failed: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("POST /api/matches returned {status}: {body}"));
        }

        let created: CreateMatchResponse = resp
            .json()
            .await
            .map_err(|e| format!("invalid POST /api/matches JSON response: {e}"))?;

        info!(
            instance_id = %instance_id,
            match_id = %created.match_id,
            "persisted multiplayer match scoreboard"
        );

        // Upload the replay independently; failure here does not roll back the scoreboard.
        if let Some(path) = replay_path {
            match tokio::fs::read(path).await {
                Ok(bytes) if !bytes.is_empty() => {
                    let replay_url = format!(
                        "{}/api/matches/{}/replay",
                        self.base_url, created.match_id
                    );
                    match self
                        .client
                        .put(&replay_url)
                        .bearer_auth(&self.api_secret)
                        .header("Content-Type", "application/octet-stream")
                        .header("X-Replay-Version", replay_version.to_string())
                        .body(bytes)
                        .send()
                        .await
                    {
                        Ok(r) if r.status().is_success() => {
                            info!(
                                instance_id = %instance_id,
                                match_id = %created.match_id,
                                "uploaded multiplayer replay"
                            );
                        }
                        Ok(r) => {
                            let status = r.status();
                            let body = r.text().await.unwrap_or_default();
                            warn!(
                                instance_id = %instance_id,
                                match_id = %created.match_id,
                                status = %status,
                                body = %body,
                                "PUT /api/matches/:id/replay failed (scoreboard preserved)"
                            );
                        }
                        Err(err) => {
                            warn!(
                                instance_id = %instance_id,
                                match_id = %created.match_id,
                                error = %err,
                                "PUT /api/matches/:id/replay request error (scoreboard preserved)"
                            );
                        }
                    }
                }
                Ok(_) => {
                    warn!(path = %path, "server replay file was empty, skipping upload");
                }
                Err(err) => {
                    warn!(path = %path, error = %err, "failed to read server replay file");
                }
            }
        }

        Ok(created.match_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Bytes;
    use axum::extract::{Path as AxumPath, State};
    use axum::http::{HeaderMap, StatusCode};
    use axum::routing::{post, put};
    use axum::{Json, Router};

    #[test]
    fn parses_match_result_stdout_line() {
        let line = r#"STK_GATEWAY_MATCH_RESULT={"track":"abyss","mode":"normal","difficulty":2,"laps":3,"reverse":false,"replay_version":4,"replay_path":"/tmp/test.replay","results":[{"kart_index":0,"display_name":"Alice","kart":"tux","kart_color":0.25,"rank":1,"finish_time_ms":91234,"dnf":false,"is_ai":false,"peer_port":51234},{"kart_index":1,"display_name":"Bot","kart":"nolok","kart_color":0,"rank":2,"finish_time_ms":null,"dnf":true,"is_ai":true,"peer_port":null}]}"#;
        let parsed = parse_match_result_line(line).expect("should parse");
        assert_eq!(parsed.track, "abyss");
        assert_eq!(parsed.laps, 3);
        assert_eq!(parsed.replay_path.as_deref(), Some("/tmp/test.replay"));
        assert_eq!(parsed.results.len(), 2);
        assert_eq!(parsed.results[0].peer_port, Some(51234));
        assert_eq!(parsed.results[1].dnf, true);
        assert!(parse_match_result_line("regular log line").is_none());
    }

    #[test]
    fn extracts_scope_from_discord_instance_ids() {
        assert_eq!(
            extract_scope_from_instance("i-launch123-gc-11111-22222"),
            (
                Some("guild".to_string()),
                Some("11111".to_string()),
                Some("22222".to_string())
            )
        );
        assert_eq!(
            extract_scope_from_instance("i-launch123-dm-33333"),
            (
                Some("dm".to_string()),
                Some("33333".to_string()),
                Some("33333".to_string())
            )
        );
        assert_eq!(
            extract_scope_from_instance("dev-room"),
            (None, None, None)
        );
    }

    #[derive(Default)]
    struct MockWorkerState {
        created_payload: Mutex<Option<serde_json::Value>>,
        uploaded_replay: Mutex<Option<(String, Vec<u8>)>>,
    }

    #[tokio::test]
    async fn uploads_enriched_scoreboard_and_replay_then_cleans_up_temp_file() {
        let state = Arc::new(MockWorkerState::default());

        let app = Router::new()
            .route(
                "/api/matches",
                post(
                    |State(st): State<Arc<MockWorkerState>>,
                     headers: HeaderMap,
                     Json(body): Json<serde_json::Value>| async move {
                        let auth = headers
                            .get("authorization")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("");
                        if auth != "Bearer test-secret" {
                            return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({})));
                        }
                        *st.created_payload.lock().await = Some(body);
                        (
                            StatusCode::CREATED,
                            Json(serde_json::json!({"match_id": "match-123"})),
                        )
                    },
                ),
            )
            .route(
                "/api/matches/{match_id}/replay",
                put(
                    |State(st): State<Arc<MockWorkerState>>,
                     AxumPath(match_id): AxumPath<String>,
                     headers: HeaderMap,
                     body: Bytes| async move {
                        let auth = headers
                            .get("authorization")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("");
                        if auth != "Bearer test-secret" {
                            return StatusCode::UNAUTHORIZED;
                        }
                        *st.uploaded_replay.lock().await = Some((match_id, body.to_vec()));
                        StatusCode::OK
                    },
                ),
            )
            .with_state(Arc::clone(&state));

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let tmp_replay = std::env::temp_dir().join("stk-gateway-test-upload.replay");
        tokio::fs::write(&tmp_replay, b"version: 4\ntrack: abyss\n")
            .await
            .unwrap();

        let uploader = MatchUploader::new(format!("http://{addr}"), "test-secret".to_string());
        let mut peers = HashMap::new();
        peers.insert(
            51234,
            ClientIdentity {
                user_id: "discord-user-1".to_string(),
                username: "alice".to_string(),
            },
        );

        let raw = RawMatchResult {
            track: "abyss".to_string(),
            mode: "normal".to_string(),
            difficulty: 2,
            laps: 3,
            reverse: false,
            replay_version: 4,
            replay_path: Some(tmp_replay.to_string_lossy().to_string()),
            results: vec![RawKartResult {
                kart_index: 0,
                display_name: "Alice".to_string(),
                kart: "tux".to_string(),
                kart_color: 0.5,
                rank: 1,
                finish_time_ms: Some(90000),
                dnf: false,
                is_ai: false,
                peer_port: Some(51234),
            }],
        };

        let match_id = uploader
            .upload_match("i-xyz-gc-999-888", raw, &peers)
            .await
            .expect("upload should succeed");
        assert_eq!(match_id, "match-123");

        let created = state.created_payload.lock().await.clone().unwrap();
        assert_eq!(created["scope_type"], "guild");
        assert_eq!(created["scope_id"], "999");
        assert_eq!(created["results"][0]["discord_user_id"], "discord-user-1");
        assert_eq!(created["results"][0]["username"], "alice");

        let uploaded = state.uploaded_replay.lock().await.clone().unwrap();
        assert_eq!(uploaded.0, "match-123");
        assert_eq!(uploaded.1, b"version: 4\ntrack: abyss\n");

        // Temp replay file should have been cleaned up
        assert!(!tmp_replay.exists());
    }
}
