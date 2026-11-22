-- SuperTuxKart Discord Activity Time Trials schema (Cloudflare D1 / SQLite)
--
-- Apply locally:  npx wrangler d1 migrations apply stk-time-trials --local
-- Apply remote:   npx wrangler d1 migrations apply stk-time-trials --remote

CREATE TABLE IF NOT EXISTS users (
  user_id      TEXT PRIMARY KEY,
  username     TEXT NOT NULL,
  display_name TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- Canonical Personal Best per user + track configuration.
-- Joined with scope_members so PBs carry over across Guilds/DMs where the user participates,
-- without exposing any global leaderboard or leaking usernames to other servers.
CREATE TABLE IF NOT EXISTS user_pbs (
  user_id        TEXT NOT NULL REFERENCES users(user_id),
  track          TEXT NOT NULL,
  difficulty     INTEGER NOT NULL,
  laps           INTEGER NOT NULL,
  reverse        INTEGER NOT NULL DEFAULT 0,
  run_id         TEXT NOT NULL UNIQUE,
  kart           TEXT NOT NULL,
  kart_color     REAL NOT NULL DEFAULT 0.0,
  time_ms        INTEGER NOT NULL,
  r2_key         TEXT NOT NULL,
  replay_version INTEGER NOT NULL DEFAULT 4,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (user_id, track, difficulty, laps, reverse)
);

CREATE INDEX IF NOT EXISTS idx_user_pbs_config_time
  ON user_pbs (track, difficulty, laps, reverse, time_ms ASC);

-- Privacy boundary: only users who interacted with the Activity in a given Guild or DM
-- appear on that scope's leaderboard.
CREATE TABLE IF NOT EXISTS scope_members (
  scope_type TEXT NOT NULL, -- 'guild' | 'dm'
  scope_id   TEXT NOT NULL, -- guild_id for 'guild', dm channel_id for 'dm'
  user_id    TEXT NOT NULL REFERENCES users(user_id),
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (scope_type, scope_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_scope_members_scope
  ON scope_members (scope_type, scope_id);

-- Each /timetrial embed message posted to a channel or DM.
CREATE TABLE IF NOT EXISTS challenges (
  challenge_id      TEXT PRIMARY KEY,
  scope_type        TEXT NOT NULL, -- 'guild' | 'dm'
  scope_id          TEXT NOT NULL,
  channel_id        TEXT NOT NULL,
  message_id        TEXT,
  track             TEXT NOT NULL,
  difficulty        INTEGER NOT NULL,
  laps              INTEGER NOT NULL,
  reverse           INTEGER NOT NULL DEFAULT 0,
  created_by        TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  interaction_token TEXT,
  token_expires_at  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_challenges_scope_config
  ON challenges (scope_type, scope_id, track, difficulty, laps, reverse, created_at DESC);

-- Short-lived handoff from "Play Time Trial" button click (LAUNCH_ACTIVITY)
-- to Activity iframe bootstrap (/api/token), plus active interaction token for
-- refreshing embeds & posting #1 announcements in DMs / User-Installed contexts.
CREATE TABLE IF NOT EXISTS pending_launches (
  user_id           TEXT NOT NULL,
  channel_id        TEXT NOT NULL,
  challenge_id      TEXT NOT NULL REFERENCES challenges(challenge_id),
  message_id        TEXT,
  interaction_token TEXT NOT NULL,
  token_expires_at  INTEGER NOT NULL,
  followups_used    INTEGER NOT NULL DEFAULT 0,
  expires_at        INTEGER NOT NULL,
  consumed          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, channel_id)
);
