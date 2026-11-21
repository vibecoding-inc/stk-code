use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use tokio::process::{Child, Command};
use tokio::sync::{oneshot, Mutex};
use tokio::task::JoinHandle;
use tracing::{info, warn};

pub trait RoomProcess: Send + Sync {
    fn kill_and_cleanup(&mut self);
}

pub struct StkChildProcess {
    child: Child,
    config_path: PathBuf,
}

impl RoomProcess for StkChildProcess {
    fn kill_and_cleanup(&mut self) {
        let _ = self.child.start_kill();
        let _ = std::fs::remove_file(&self.config_path);
    }
}

pub trait ServerSpawner: Send + Sync {
    fn spawn(&self, instance_id: &str, port: u16) -> Result<Box<dyn RoomProcess>, String>;
}

pub struct StkServerSpawner {
    stk_binary: String,
    stk_data_dir: Option<String>,
    max_players: u8,
}

impl StkServerSpawner {
    pub fn new(stk_binary: String, stk_data_dir: Option<String>, max_players: u8) -> Self {
        Self {
            stk_binary,
            stk_data_dir,
            max_players,
        }
    }

    pub fn build_server_config_xml(port: u16, max_players: u8) -> String {
        format!(
            r#"<?xml version="1.0"?>
<server-config version="6" >
    <server-name value="Discord Activity" />
    <server-port value="{port}" />
    <server-mode value="3" />
    <server-difficulty value="1" />
    <wan-server value="false" />
    <enable-console value="false" />
    <server-max-players value="{max_players}" />
    <owner-less value="true" />
    <start-game-counter value="30.0" />
    <min-start-game-players value="2" />
    <auto-end value="false" />
    <sql-management value="false" />
    <strict-players value="false" />
</server-config>
"#
        )
    }
}

impl ServerSpawner for StkServerSpawner {
    fn spawn(&self, instance_id: &str, port: u16) -> Result<Box<dyn RoomProcess>, String> {
        let config_path = std::env::temp_dir().join(format!("stk-room-{port}.xml"));
        let xml = Self::build_server_config_xml(port, self.max_players);
        std::fs::write(&config_path, xml)
            .map_err(|e| format!("failed to write server config for port {port}: {e}"))?;

        let mut cmd = Command::new(&self.stk_binary);
        cmd.arg(format!("--server-config={}", config_path.display()))
            .arg("--no-console-log")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);

        if let Some(data_dir) = &self.stk_data_dir {
            cmd.env("SUPERTUXKART_DATADIR", data_dir);
        }

        let child = cmd.spawn().map_err(|e| {
            let _ = std::fs::remove_file(&config_path);
            format!(
                "failed to spawn STK server '{}' for instance '{}': {e}",
                self.stk_binary, instance_id
            )
        })?;

        info!(
            instance_id = %instance_id,
            port = port,
            pid = ?child.id(),
            "spawned headless STK server"
        );

        Ok(Box::new(StkChildProcess { child, config_path }))
    }
}

struct RoomEntry {
    port: u16,
    process: Box<dyn RoomProcess>,
    /// Active clients keyed by Discord `user_id` -> (connection_id, kick sender).
    clients: HashMap<String, (u64, oneshot::Sender<()>)>,
    idle_reaper: Option<JoinHandle<()>>,
}

struct RoomState {
    rooms: HashMap<String, RoomEntry>,
    free_ports: VecDeque<u16>,
    next_conn_id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoomError {
    CapacityReached,
    RoomFull,
    SpawnFailed(String),
}

impl std::fmt::Display for RoomError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::CapacityReached => write!(f, "server_capacity_reached"),
            Self::RoomFull => write!(f, "room_full"),
            Self::SpawnFailed(msg) => write!(f, "spawn_failed: {msg}"),
        }
    }
}

pub struct RoomLease {
    pub instance_id: String,
    pub user_id: String,
    pub conn_id: u64,
    pub port: u16,
    pub newly_spawned: bool,
    pub kick_rx: oneshot::Receiver<()>,
}

#[derive(Debug, Clone)]
pub struct RoomStats {
    pub active_rooms: usize,
    pub max_rooms: usize,
    pub active_clients: usize,
}

pub struct RoomManager {
    spawner: Arc<dyn ServerSpawner>,
    state: Arc<Mutex<RoomState>>,
    max_rooms: usize,
    max_players_per_room: usize,
    idle_timeout: Duration,
}

impl RoomManager {
    pub fn new(
        spawner: Arc<dyn ServerSpawner>,
        port_range_start: u16,
        port_range_end: u16,
        max_players_per_room: u8,
        idle_timeout: Duration,
    ) -> Self {
        let free_ports: VecDeque<u16> = (port_range_start..port_range_end).collect();
        let max_rooms = free_ports.len();
        Self {
            spawner,
            state: Arc::new(Mutex::new(RoomState {
                rooms: HashMap::new(),
                free_ports,
                next_conn_id: 1,
            })),
            max_rooms,
            max_players_per_room: max_players_per_room as usize,
            idle_timeout,
        }
    }

    pub async fn join_or_spawn(
        &self,
        instance_id: &str,
        user_id: &str,
    ) -> Result<RoomLease, RoomError> {
        let mut guard = self.state.lock().await;
        let conn_id = guard.next_conn_id;
        guard.next_conn_id += 1;

        let mut newly_spawned = false;
        if !guard.rooms.contains_key(instance_id) {
            let port = guard
                .free_ports
                .pop_front()
                .ok_or(RoomError::CapacityReached)?;
            let process = match self.spawner.spawn(instance_id, port) {
                Ok(p) => p,
                Err(err) => {
                    guard.free_ports.push_back(port);
                    return Err(RoomError::SpawnFailed(err));
                }
            };
            guard.rooms.insert(
                instance_id.to_string(),
                RoomEntry {
                    port,
                    process,
                    clients: HashMap::new(),
                    idle_reaper: None,
                },
            );
            newly_spawned = true;
        }

        let room = guard.rooms.get_mut(instance_id).expect("room exists");

        // Cancel any pending idle shutdown timer since a player is joining.
        if let Some(handle) = room.idle_reaper.take() {
            handle.abort();
        }

        // If this user is not already in the room, enforce max players.
        if !room.clients.contains_key(user_id) && room.clients.len() >= self.max_players_per_room {
            return Err(RoomError::RoomFull);
        }

        let (kick_tx, kick_rx) = oneshot::channel();
        // Replace any existing connection for the same user (e.g. tab reload).
        if let Some((_, old_kick)) = room.clients.insert(user_id.to_string(), (conn_id, kick_tx)) {
            let _ = old_kick.send(());
        }

        Ok(RoomLease {
            instance_id: instance_id.to_string(),
            user_id: user_id.to_string(),
            conn_id,
            port: room.port,
            newly_spawned,
            kick_rx,
        })
    }

    pub async fn leave(&self, instance_id: &str, user_id: &str, conn_id: u64) {
        let mut guard = self.state.lock().await;
        let Some(room) = guard.rooms.get_mut(instance_id) else {
            return;
        };

        // Only remove if this connection is still the active one for `user_id`.
        let should_remove = room
            .clients
            .get(user_id)
            .map(|(active_id, _)| *active_id == conn_id)
            .unwrap_or(false);
        if should_remove {
            room.clients.remove(user_id);
        }

        if room.clients.is_empty() && room.idle_reaper.is_none() {
            let state = Arc::clone(&self.state);
            let id = instance_id.to_string();
            let timeout = self.idle_timeout;
            room.idle_reaper = Some(tokio::spawn(async move {
                tokio::time::sleep(timeout).await;
                let mut g = state.lock().await;
                let is_still_empty = g
                    .rooms
                    .get(&id)
                    .map(|r| r.clients.is_empty())
                    .unwrap_or(false);
                if is_still_empty {
                    if let Some(mut entry) = g.rooms.remove(&id) {
                        info!(instance_id = %id, port = entry.port, "reaping idle STK room");
                        entry.process.kill_and_cleanup();
                        g.free_ports.push_back(entry.port);
                    }
                }
            }));
        }
    }

    pub async fn stats(&self) -> RoomStats {
        let guard = self.state.lock().await;
        let active_clients = guard.rooms.values().map(|r| r.clients.len()).sum();
        RoomStats {
            active_rooms: guard.rooms.len(),
            max_rooms: self.max_rooms,
            active_clients,
        }
    }

    pub async fn shutdown_all(&self) {
        let mut guard = self.state.lock().await;
        let drained: Vec<_> = guard.rooms.drain().collect();
        for (id, mut entry) in drained {
            if let Some(handle) = entry.idle_reaper.take() {
                handle.abort();
            }
            for (_, (_, kick)) in entry.clients.drain() {
                let _ = kick.send(());
            }
            warn!(instance_id = %id, port = entry.port, "shutting down STK room");
            entry.process.kill_and_cleanup();
            guard.free_ports.push_back(entry.port);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct FakeProcess {
        killed: Arc<AtomicUsize>,
    }

    impl RoomProcess for FakeProcess {
        fn kill_and_cleanup(&mut self) {
            self.killed.fetch_add(1, Ordering::SeqCst);
        }
    }

    struct FakeSpawner {
        spawned: Arc<AtomicUsize>,
        killed: Arc<AtomicUsize>,
    }

    impl ServerSpawner for FakeSpawner {
        fn spawn(&self, _instance_id: &str, _port: u16) -> Result<Box<dyn RoomProcess>, String> {
            self.spawned.fetch_add(1, Ordering::SeqCst);
            Ok(Box::new(FakeProcess {
                killed: Arc::clone(&self.killed),
            }))
        }
    }

    #[tokio::test]
    async fn enforces_room_capacity_and_reaps_idle_rooms() {
        let spawned = Arc::new(AtomicUsize::new(0));
        let killed = Arc::new(AtomicUsize::new(0));
        let spawner = Arc::new(FakeSpawner {
            spawned: Arc::clone(&spawned),
            killed: Arc::clone(&killed),
        });

        let mgr = RoomManager::new(spawner, 30000, 30002, 2, Duration::from_millis(50));

        let l1 = mgr.join_or_spawn("room-a", "u1").await.unwrap();
        assert!(l1.newly_spawned);
        assert_eq!(l1.port, 30000);

        let l2 = mgr.join_or_spawn("room-a", "u2").await.unwrap();
        assert!(!l2.newly_spawned);
        assert_eq!(l2.port, 30000);

        // Room is full (max_players_per_room = 2).
        assert_eq!(
            mgr.join_or_spawn("room-a", "u3").await.err(),
            Some(RoomError::RoomFull)
        );

        // Second room takes the last port.
        let l3 = mgr.join_or_spawn("room-b", "u3").await.unwrap();
        assert_eq!(l3.port, 30001);

        // Third room exceeds capacity.
        assert_eq!(
            mgr.join_or_spawn("room-c", "u4").await.err(),
            Some(RoomError::CapacityReached)
        );

        // Reconnecting u1 kicks old connection without leaking slot.
        let mut old_kick = l1.kick_rx;
        let l1_new = mgr.join_or_spawn("room-a", "u1").await.unwrap();
        assert!(old_kick.try_recv().is_ok());

        // Leaving room-b triggers idle reap and frees port.
        mgr.leave("room-b", "u3", l3.conn_id).await;
        tokio::time::sleep(Duration::from_millis(120)).await;
        assert_eq!(killed.load(Ordering::SeqCst), 1);

        let l4 = mgr.join_or_spawn("room-c", "u4").await.unwrap();
        assert_eq!(l4.port, 30001);

        mgr.leave("room-a", "u1", l1_new.conn_id).await;
        mgr.leave("room-a", "u2", l2.conn_id).await;
        mgr.leave("room-c", "u4", l4.conn_id).await;
        mgr.shutdown_all().await;
    }
}
