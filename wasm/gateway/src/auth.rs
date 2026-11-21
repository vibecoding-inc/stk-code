use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::StatusCode;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedSession {
    pub user_id: String,
    pub username: String,
    pub instance_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthError {
    InvalidInput(String),
    InvalidToken,
    InstanceNotFound,
    UserNotInInstance,
    GuildNotAllowed,
    Upstream(String),
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidInput(msg) => write!(f, "invalid_input: {msg}"),
            Self::InvalidToken => write!(f, "invalid_token"),
            Self::InstanceNotFound => write!(f, "instance_not_found"),
            Self::UserNotInInstance => write!(f, "user_not_in_instance"),
            Self::GuildNotAllowed => write!(f, "guild_not_allowed"),
            Self::Upstream(msg) => write!(f, "upstream_error: {msg}"),
        }
    }
}

pub type AuthFuture<'a> =
    Pin<Box<dyn Future<Output = Result<VerifiedSession, AuthError>> + Send + 'a>>;

pub trait AuthVerifier: Send + Sync {
    fn verify<'a>(&'a self, access_token: &'a str, instance_id: &'a str) -> AuthFuture<'a>;
}

/// Validates basic syntax of an `instance_id` to prevent path traversal or URL injection
/// when calling Discord's `/activity-instances/{instance_id}` endpoint.
pub fn validate_instance_id(instance_id: &str) -> Result<(), AuthError> {
    if instance_id.is_empty() || instance_id.len() > 128 {
        return Err(AuthError::InvalidInput(
            "instance_id length out of bounds".to_string(),
        ));
    }
    if !instance_id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(AuthError::InvalidInput(
            "instance_id contains invalid characters".to_string(),
        ));
    }
    Ok(())
}

/// Extracts the `guild_id` from a Discord guild-channel Activity `instance_id` of the form:
/// `i-<launch_id>-gc-<guild_id>-<channel_id>`
pub fn extract_guild_id(instance_id: &str) -> Option<&str> {
    let parts: Vec<&str> = instance_id.split('-').collect();
    if parts.len() >= 5 && parts[0] == "i" && parts[2] == "gc" {
        Some(parts[3])
    } else {
        None
    }
}

#[derive(Debug, Clone)]
struct CachedUser {
    user_id: String,
    username: String,
    expires_at: Instant,
}

#[derive(Debug, Deserialize)]
struct DiscordUserResponse {
    id: String,
    username: String,
    #[serde(default)]
    global_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ActivityInstanceResponse {
    #[serde(default)]
    users: Vec<String>,
}

pub struct DiscordApiVerifier {
    client: reqwest::Client,
    api_base: String,
    application_id: String,
    bot_token: String,
    allowed_guild_ids: Option<HashSet<String>>,
    cache_ttl: Duration,
    user_cache: Arc<Mutex<HashMap<[u8; 32], CachedUser>>>,
}

impl DiscordApiVerifier {
    pub fn new(
        api_base: String,
        application_id: String,
        bot_token: String,
        allowed_guild_ids: Option<HashSet<String>>,
        cache_ttl: Duration,
    ) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .expect("failed to build reqwest client");
        Self {
            client,
            api_base,
            application_id,
            bot_token,
            allowed_guild_ids,
            cache_ttl,
            user_cache: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn hash_token(token: &str) -> [u8; 32] {
        let mut hasher = Sha256::new();
        hasher.update(token.as_bytes());
        hasher.finalize().into()
    }

    async fn resolve_user(&self, access_token: &str) -> Result<(String, String), AuthError> {
        if access_token.trim().is_empty() {
            return Err(AuthError::InvalidToken);
        }

        let key = Self::hash_token(access_token);
        {
            let mut cache = self.user_cache.lock().await;
            if let Some(entry) = cache.get(&key) {
                if entry.expires_at > Instant::now() {
                    return Ok((entry.user_id.clone(), entry.username.clone()));
                }
                cache.remove(&key);
            }
        }

        let url = format!("{}/users/@me", self.api_base);
        let resp = self
            .client
            .get(&url)
            .header("Authorization", format!("Bearer {access_token}"))
            .send()
            .await
            .map_err(|e| AuthError::Upstream(format!("users/@me request failed: {e}")))?;

        match resp.status() {
            StatusCode::OK => {
                let user: DiscordUserResponse = resp
                    .json()
                    .await
                    .map_err(|e| AuthError::Upstream(format!("users/@me parse failed: {e}")))?;
                let display = user.global_name.unwrap_or(user.username);
                let mut cache = self.user_cache.lock().await;
                if cache.len() > 4096 {
                    let now = Instant::now();
                    cache.retain(|_, v| v.expires_at > now);
                }
                cache.insert(
                    key,
                    CachedUser {
                        user_id: user.id.clone(),
                        username: display.clone(),
                        expires_at: Instant::now() + self.cache_ttl,
                    },
                );
                Ok((user.id, display))
            }
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Err(AuthError::InvalidToken),
            status => Err(AuthError::Upstream(format!(
                "users/@me returned HTTP {status}"
            ))),
        }
    }

    async fn verify_instance_membership(
        &self,
        instance_id: &str,
        user_id: &str,
    ) -> Result<(), AuthError> {
        let url = format!(
            "{}/applications/{}/activity-instances/{}",
            self.api_base, self.application_id, instance_id
        );
        let resp = self
            .client
            .get(&url)
            .header("Authorization", format!("Bot {}", self.bot_token))
            .send()
            .await
            .map_err(|e| AuthError::Upstream(format!("activity-instances request failed: {e}")))?;

        match resp.status() {
            StatusCode::OK => {
                let instance: ActivityInstanceResponse = resp.json().await.map_err(|e| {
                    AuthError::Upstream(format!("activity-instances parse failed: {e}"))
                })?;
                if instance.users.iter().any(|u| u == user_id) {
                    Ok(())
                } else {
                    Err(AuthError::UserNotInInstance)
                }
            }
            StatusCode::NOT_FOUND => Err(AuthError::InstanceNotFound),
            status => Err(AuthError::Upstream(format!(
                "activity-instances returned HTTP {status}"
            ))),
        }
    }
}

impl AuthVerifier for DiscordApiVerifier {
    fn verify<'a>(&'a self, access_token: &'a str, instance_id: &'a str) -> AuthFuture<'a> {
        Box::pin(async move {
            validate_instance_id(instance_id)?;

            if let Some(allowed) = &self.allowed_guild_ids {
                match extract_guild_id(instance_id) {
                    Some(gid) if allowed.contains(gid) => {}
                    _ => return Err(AuthError::GuildNotAllowed),
                }
            }

            let (user_id, username) = self.resolve_user(access_token).await?;
            self.verify_instance_membership(instance_id, &user_id).await?;

            Ok(VerifiedSession {
                user_id,
                username,
                instance_id: instance_id.to_string(),
            })
        })
    }
}

/// Development-only verifier enabled explicitly via `DEV_INSECURE_AUTH=1`.
pub struct DevInsecureVerifier;

impl AuthVerifier for DevInsecureVerifier {
    fn verify<'a>(&'a self, access_token: &'a str, instance_id: &'a str) -> AuthFuture<'a> {
        Box::pin(async move {
            validate_instance_id(instance_id)?;
            let user_id = if access_token.trim().is_empty() {
                "dev-user".to_string()
            } else {
                format!("dev-{}", &access_token[..access_token.len().min(16)])
            };
            Ok(VerifiedSession {
                username: user_id.clone(),
                user_id,
                instance_id: instance_id.to_string(),
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_instance_id_format() {
        assert!(validate_instance_id("i-1276580072400224306-gc-912952092627435520-912954213460484116").is_ok());
        assert!(validate_instance_id("dev_room_1").is_ok());
        assert!(validate_instance_id("").is_err());
        assert!(validate_instance_id("../etc/passwd").is_err());
        assert!(validate_instance_id("id?foo=bar").is_err());
    }

    #[test]
    fn extracts_guild_id_from_guild_channel_instance() {
        assert_eq!(
            extract_guild_id("i-1276580072400224306-gc-912952092627435520-912954213460484116"),
            Some("912952092627435520")
        );
        assert_eq!(extract_guild_id("i-1276580072400224306-dm-12345"), None);
        assert_eq!(extract_guild_id("custom-room"), None);
    }
}
