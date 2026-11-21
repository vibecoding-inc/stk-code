use std::collections::HashSet;
use std::env;
use std::net::SocketAddr;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct Config {
    pub listen_addr: SocketAddr,
    pub discord_application_id: String,
    pub discord_bot_token: String,
    pub discord_api_base: String,
    pub allowed_guild_ids: Option<HashSet<String>>,
    pub dev_insecure_auth: bool,
    pub stk_binary: String,
    pub stk_data_dir: Option<String>,
    pub bind_ip: String,
    pub port_range_start: u16,
    pub port_range_end: u16,
    pub max_players_per_room: u8,
    pub room_idle_timeout: Duration,
    pub auth_handshake_timeout: Duration,
    pub auth_cache_ttl: Duration,
    pub max_datagram_bytes: usize,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let listen_addr: SocketAddr = env::var("GATEWAY_LISTEN_ADDR")
            .unwrap_or_else(|_| "0.0.0.0:8080".to_string())
            .parse()
            .map_err(|e| format!("Invalid GATEWAY_LISTEN_ADDR: {e}"))?;

        let dev_insecure_auth = matches!(
            env::var("DEV_INSECURE_AUTH").as_deref(),
            Ok("1") | Ok("true") | Ok("TRUE")
        );

        let discord_application_id = env::var("DISCORD_APPLICATION_ID")
            .or_else(|_| env::var("DISCORD_CLIENT_ID"))
            .unwrap_or_default();
        let discord_bot_token = env::var("DISCORD_BOT_TOKEN").unwrap_or_default();

        if !dev_insecure_auth {
            if discord_application_id.is_empty() {
                return Err(
                    "DISCORD_APPLICATION_ID (or DISCORD_CLIENT_ID) is required unless DEV_INSECURE_AUTH=1"
                        .to_string(),
                );
            }
            if discord_bot_token.is_empty() {
                return Err(
                    "DISCORD_BOT_TOKEN is required unless DEV_INSECURE_AUTH=1".to_string(),
                );
            }
        }

        let discord_api_base = env::var("DISCORD_API_BASE")
            .unwrap_or_else(|_| "https://discord.com/api/v10".to_string())
            .trim_end_matches('/')
            .to_string();

        let allowed_guild_ids = env::var("ALLOWED_GUILD_IDS").ok().and_then(|raw| {
            let set: HashSet<String> = raw
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            if set.is_empty() {
                None
            } else {
                Some(set)
            }
        });

        let stk_binary = env::var("STK_SERVER_BIN")
            .unwrap_or_else(|_| "/usr/local/bin/supertuxkart".to_string());
        let stk_data_dir = env::var("STK_DATA_DIR")
            .ok()
            .filter(|s| !s.trim().is_empty());

        let bind_ip = env::var("STK_BIND_IP").unwrap_or_else(|_| "127.0.0.1".to_string());

        let port_range_start: u16 = env::var("PORT_RANGE_START")
            .unwrap_or_else(|_| "30000".to_string())
            .parse()
            .map_err(|e| format!("Invalid PORT_RANGE_START: {e}"))?;
        let port_range_end: u16 = env::var("PORT_RANGE_END")
            .unwrap_or_else(|_| "30016".to_string())
            .parse()
            .map_err(|e| format!("Invalid PORT_RANGE_END: {e}"))?;

        if port_range_end <= port_range_start {
            return Err("PORT_RANGE_END must be greater than PORT_RANGE_START".to_string());
        }

        let max_players_per_room: u8 = env::var("MAX_PLAYERS_PER_ROOM")
            .unwrap_or_else(|_| "16".to_string())
            .parse()
            .map_err(|e| format!("Invalid MAX_PLAYERS_PER_ROOM: {e}"))?;

        let room_idle_secs: u64 = env::var("ROOM_IDLE_TIMEOUT_SECS")
            .unwrap_or_else(|_| "120".to_string())
            .parse()
            .map_err(|e| format!("Invalid ROOM_IDLE_TIMEOUT_SECS: {e}"))?;

        let auth_timeout_secs: u64 = env::var("AUTH_HANDSHAKE_TIMEOUT_SECS")
            .unwrap_or_else(|_| "5".to_string())
            .parse()
            .map_err(|e| format!("Invalid AUTH_HANDSHAKE_TIMEOUT_SECS: {e}"))?;

        let auth_cache_secs: u64 = env::var("AUTH_CACHE_TTL_SECS")
            .unwrap_or_else(|_| "300".to_string())
            .parse()
            .map_err(|e| format!("Invalid AUTH_CACHE_TTL_SECS: {e}"))?;

        let max_datagram_bytes: usize = env::var("MAX_DATAGRAM_BYTES")
            .unwrap_or_else(|_| "1500".to_string())
            .parse()
            .map_err(|e| format!("Invalid MAX_DATAGRAM_BYTES: {e}"))?;

        Ok(Self {
            listen_addr,
            discord_application_id,
            discord_bot_token,
            discord_api_base,
            allowed_guild_ids,
            dev_insecure_auth,
            stk_binary,
            stk_data_dir,
            bind_ip,
            port_range_start,
            port_range_end,
            max_players_per_room,
            room_idle_timeout: Duration::from_secs(room_idle_secs),
            auth_handshake_timeout: Duration::from_secs(auth_timeout_secs),
            auth_cache_ttl: Duration::from_secs(auth_cache_secs),
            max_datagram_bytes,
        })
    }
}
