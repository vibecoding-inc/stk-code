-- Add Discord avatar hash to users table so clients can construct Discord CDN
-- avatar URLs via Discord Activity URL Mapping (/.proxy/discord-cdn/avatars/...).
--
-- Apply remote: npx wrangler d1 migrations apply stk-time-trials --remote

ALTER TABLE users ADD COLUMN avatar TEXT;
