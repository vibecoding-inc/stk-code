-- Multiplayer lobby match scoreboards & optional server-recorded replays (Cloudflare D1 / SQLite)
--
-- Scoreboards (matches + match_results) are persisted independently of replays
-- (replay_r2_key is nullable) so replays can be omitted, pruned, or expired on R2
-- without losing match history.

CREATE TABLE IF NOT EXISTS matches (
  match_id       TEXT PRIMARY KEY,
  instance_id    TEXT NOT NULL,
  scope_type     TEXT,          -- 'guild' | 'dm' | NULL
  scope_id       TEXT,          -- guild_id for 'guild', channel_id for 'dm'
  channel_id     TEXT,
  track          TEXT NOT NULL,
  mode           TEXT NOT NULL,
  difficulty     INTEGER NOT NULL,
  laps           INTEGER NOT NULL,
  reverse        INTEGER NOT NULL DEFAULT 0,
  played_at      INTEGER NOT NULL,
  replay_r2_key  TEXT,
  replay_version INTEGER,
  replay_bytes   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_matches_scope_played
  ON matches (scope_type, scope_id, played_at DESC);

CREATE INDEX IF NOT EXISTS idx_matches_instance_played
  ON matches (instance_id, played_at DESC);

CREATE TABLE IF NOT EXISTS match_results (
  match_id        TEXT NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE,
  kart_index      INTEGER NOT NULL,
  discord_user_id TEXT,
  display_name    TEXT NOT NULL,
  kart            TEXT NOT NULL,
  kart_color      REAL NOT NULL DEFAULT 0.0,
  rank            INTEGER NOT NULL,
  finish_time_ms  INTEGER,      -- NULL when DNF / eliminated
  dnf             INTEGER NOT NULL DEFAULT 0,
  is_ai           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (match_id, kart_index)
);

CREATE INDEX IF NOT EXISTS idx_match_results_user
  ON match_results (discord_user_id, match_id);
