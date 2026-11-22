-- Store per-guild nickname and guild-specific avatar hash on scope_members
-- so Time Trial leaderboards and in-game ghosts display server-specific profiles
-- without overwriting the user's global profile or requiring Bot guild access.
--
-- Apply remote: npx wrangler d1 migrations apply stk-time-trials --remote

ALTER TABLE scope_members ADD COLUMN guild_nick TEXT;
ALTER TABLE scope_members ADD COLUMN guild_avatar TEXT;
