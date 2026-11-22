/**
 * SSRF-safe Discord CDN avatar URL construction and fetching.
 *
 * Never accepts arbitrary URLs from callers; only constructs verified
 * https://cdn.discordapp.com/... URLs from strict Discord snowflake/hash fields.
 */

import { createLogger } from "./logger.mjs";

const log = createLogger("podium_renderer::avatars");

const SNOWFLAKE_RE = /^\d{1,25}$/;
const HASH_RE = /^[a-zA-Z0-9_-]{1,128}$/;

export function buildDiscordAvatarUrls({ user_id, guild_id, avatar, guild_avatar }) {
  const uid = String(user_id || "").trim();
  const gid = String(guild_id || "").trim();
  const av = String(avatar || "").trim();
  const gav = String(guild_avatar || "").trim();

  const urls = [];
  if (SNOWFLAKE_RE.test(uid)) {
    if (SNOWFLAKE_RE.test(gid) && HASH_RE.test(gav)) {
      urls.push(
        `https://cdn.discordapp.com/guilds/${gid}/users/${uid}/avatars/${gav}.png?size=128`
      );
    }
    if (HASH_RE.test(av)) {
      urls.push(`https://cdn.discordapp.com/avatars/${uid}/${av}.png?size=128`);
    }
    let idx = 0;
    try {
      idx = Number((BigInt(uid) >> 22n) % 6n);
    } catch {
      idx = 0;
    }
    urls.push(`https://cdn.discordapp.com/embed/avatars/${idx}.png`);
  }
  return urls;
}

const FALLBACK_PALETTE = [
  "#5865F2",
  "#EB459E",
  "#3BA55D",
  "#FAA61A",
  "#00A8FC",
  "#9B59B6",
];

export function makeFallbackAvatarDataUri(displayName, seedStr = "") {
  const clean = String(displayName || "P").trim();
  const initial = (clean[0] || "P").toUpperCase();
  let hash = 0;
  const key = String(seedStr || clean);
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  const bg = FALLBACK_PALETTE[hash % FALLBACK_PALETTE.length];
  const safeChar = initial.replace(/[<>&"']/g, "P");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" rx="64" fill="${bg}"/><text x="64" y="78" text-anchor="middle" font-family="sans-serif" font-weight="700" font-size="56" fill="#ffffff">${safeChar}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

export async function fetchAvatarDataUri(entry, { fetchImpl = fetch, timeoutMs = 2500 } = {}) {
  const urls = buildDiscordAvatarUrls(entry);
  for (const url of urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetchImpl(url, {
        signal: controller.signal,
        headers: { "User-Agent": "stk-podium-renderer/1.0" },
      });
      if (!resp.ok) {
        log.debug("avatar fetch non-200, trying fallback", {
          user_id: entry.user_id,
          status: resp.status,
          url,
        });
        continue;
      }
      const contentType = (resp.headers.get("content-type") || "image/png").split(";")[0].trim();
      if (!contentType.startsWith("image/")) continue;
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length === 0 || buf.length > 2 * 1024 * 1024) continue;
      return `data:${contentType};base64,${buf.toString("base64")}`;
    } catch (err) {
      log.warn("avatar fetch failed, trying fallback", {
        user_id: entry.user_id,
        error: err && err.message ? err.message : String(err),
      });
    } finally {
      clearTimeout(timer);
    }
  }
  log.debug("using monogram fallback avatar", { user_id: entry.user_id });
  return makeFallbackAvatarDataUri(entry.display_name, entry.user_id);
}
