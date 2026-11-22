import test from "node:test";
import assert from "node:assert/strict";
import { buildDiscordAvatarUrls, makeFallbackAvatarDataUri } from "../src/avatars.mjs";
import { formatKartLabel, formatTimeMs } from "../src/compositor.mjs";

test("buildDiscordAvatarUrls prioritizes guild avatar, then global, then default embed avatar", () => {
  const urls = buildDiscordAvatarUrls({
    user_id: "123456789012345678",
    guild_id: "987654321098765432",
    avatar: "a_globalhash123",
    guild_avatar: "guildhash456",
  });
  assert.equal(urls.length, 3);
  assert.equal(
    urls[0],
    "https://cdn.discordapp.com/guilds/987654321098765432/users/123456789012345678/avatars/guildhash456.png?size=128"
  );
  assert.equal(
    urls[1],
    "https://cdn.discordapp.com/avatars/123456789012345678/a_globalhash123.png?size=128"
  );
  assert.match(urls[2], /^https:\/\/cdn\.discordapp\.com\/embed\/avatars\/[0-5]\.png$/);
});

test("buildDiscordAvatarUrls rejects SSRF / path traversal inputs", () => {
  const urls = buildDiscordAvatarUrls({
    user_id: "123456789012345678",
    guild_id: "../evil.com",
    avatar: "../../etc/passwd",
    guild_avatar: "http://169.254.169.254/latest",
  });
  assert.equal(urls.length, 1);
  assert.match(urls[0], /^https:\/\/cdn\.discordapp\.com\/embed\/avatars\/[0-5]\.png$/);
});

test("makeFallbackAvatarDataUri returns a valid SVG data URI", () => {
  const uri = makeFallbackAvatarDataUri("Tux", "1001");
  assert.ok(uri.startsWith("data:image/svg+xml;base64,"));
  const decoded = Buffer.from(uri.split(",")[1], "base64").toString("utf-8");
  assert.ok(decoded.includes(">T</text>"));
});

test("formatTimeMs and formatKartLabel format cleanly", () => {
  assert.equal(formatTimeMs(82415), "1:22.415");
  assert.equal(formatTimeMs(60005), "1:00.005");
  assert.equal(formatKartLabel("sara_the_racer"), "Sara The Racer");
});
