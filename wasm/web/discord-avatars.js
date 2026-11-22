// Shared Discord avatar fetcher, circular PNG cropper, and Emscripten MEMFS cache.
//
// Used by Time Trials (ghost karts) and designed to be reused directly by
// regular Discord Activity multiplayer (Step 2) via getInstanceConnectedParticipants().
//
// Requires a Discord Developer Portal URL Mapping:
//   Prefix: /discord-cdn   ->   Target: cdn.discordapp.com
// Inside a Discord Activity iframe, avatars are fetched via /.proxy/discord-cdn/...
// (same-origin, zero Worker bandwidth, no CSP issues).

const AVATAR_DIR = "/tmp/discord_avatars";

function ensure_dir(fs, dir) {
  let parts = dir.split("/").filter(Boolean);
  let cur = "";
  for (let part of parts) {
    cur += "/" + part;
    try {
      fs.mkdir(cur);
    }
    catch {
      // Directory already exists
    }
  }
}

export function default_avatar_index(user_id) {
  try {
    if (typeof user_id === "string" && /^\d+$/.test(user_id)) {
      return Number((BigInt(user_id) >> 22n) % 6n);
    }
  }
  catch {
    // Fall back to 0
  }
  return 0;
}

export function resolve_discord_cdn_base(location_obj = globalThis.location) {
  let host = (location_obj && location_obj.hostname) || "";
  let search = (location_obj && location_obj.search) || "";
  if (
    host.includes("discordsays.com") ||
    host.includes("discordsez.com") ||
    new URLSearchParams(search).has("frame_id")
  ) {
    return "/.proxy/discord-cdn";
  }
  return "https://cdn.discordapp.com";
}

export function build_discord_avatar_url({
  user_id,
  avatar = null,
  cdn_base = "/.proxy/discord-cdn",
  size = 64,
}) {
  let base = String(cdn_base || "/.proxy/discord-cdn").replace(/\/+$/, "");
  if (user_id && avatar && typeof avatar === "string" && avatar.trim()) {
    return `${base}/avatars/${encodeURIComponent(user_id)}/${encodeURIComponent(avatar.trim())}.png?size=${size}`;
  }
  return `${base}/embed/avatars/${default_avatar_index(user_id)}.png`;
}

/**
 * Crops an image Blob into a circular `size x size` PNG with a subtle white ring
 * so it reads cleanly against both 3D tracks and minimaps.
 */
export async function circle_crop_blob_to_png(blob, size = 64) {
  if (
    typeof createImageBitmap !== "function" ||
    typeof document === "undefined" ||
    !document.createElement
  ) {
    return new Uint8Array(await blob.arrayBuffer());
  }

  let bitmap = await createImageBitmap(blob);
  try {
    let canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    let ctx = canvas.getContext("2d");
    if (!ctx) {
      return new Uint8Array(await blob.arrayBuffer());
    }

    let r = size / 2;
    let border = 2;
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.beginPath();
    ctx.arc(r, r, r - border / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(bitmap, 0, 0, size, size);
    ctx.restore();

    ctx.beginPath();
    ctx.arc(r, r, r - border / 2, 0, Math.PI * 2);
    ctx.lineWidth = border;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
    ctx.stroke();

    let png_blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas.toBlob failed"))), "image/png");
    });
    return new Uint8Array(await png_blob.arrayBuffer());
  }
  finally {
    if (typeof bitmap.close === "function") {
      bitmap.close();
    }
  }
}

export function create_discord_avatar_cache({
  fetch_impl = (...args) => fetch(...args),
  get_fs = () => (typeof FS !== "undefined" ? FS : null),
  crop_impl = circle_crop_blob_to_png,
  cdn_base = resolve_discord_cdn_base(),
  size = 64,
  logger = console,
} = {}) {
  let path_by_key = new Map();
  let inflight_by_key = new Map();

  async function fetch_and_store({user_id, avatar}) {
    let fs = get_fs();
    if (!fs || !user_id) return null;

    let safe_id = String(user_id).replace(/[^A-Za-z0-9_-]/g, "_");
    let cache_key = `${safe_id}:${avatar || "default"}`;
    if (path_by_key.has(cache_key)) {
      return path_by_key.get(cache_key);
    }

    let primary_url = build_discord_avatar_url({user_id, avatar, cdn_base, size});
    let resp = await fetch_impl(primary_url);

    // Fall back to Discord default avatar if custom avatar hash returned 404.
    if (!resp.ok && avatar) {
      let fallback_url = build_discord_avatar_url({user_id, avatar: null, cdn_base, size});
      resp = await fetch_impl(fallback_url);
    }
    if (!resp.ok) {
      logger.warn(`Failed to fetch Discord avatar for ${user_id} (${resp.status})`);
      return null;
    }

    let blob = await resp.blob();
    let png_bytes = await crop_impl(blob, size);
    if (!png_bytes || png_bytes.length === 0) return null;

    ensure_dir(fs, AVATAR_DIR);
    let memfs_path = `${AVATAR_DIR}/${safe_id}.png`;
    fs.writeFile(memfs_path, png_bytes);
    path_by_key.set(cache_key, memfs_path);
    return memfs_path;
  }

  return {
    async ensureAvatar({user_id, avatar = null}) {
      if (!user_id) return null;
      let safe_id = String(user_id).replace(/[^A-Za-z0-9_-]/g, "_");
      let cache_key = `${safe_id}:${avatar || "default"}`;
      if (path_by_key.has(cache_key)) {
        return path_by_key.get(cache_key);
      }
      if (inflight_by_key.has(cache_key)) {
        return inflight_by_key.get(cache_key);
      }
      let p = fetch_and_store({user_id, avatar})
        .catch((err) => {
          logger.warn(`Discord avatar load error for ${user_id}:`, err);
          return null;
        })
        .finally(() => {
          inflight_by_key.delete(cache_key);
        });
      inflight_by_key.set(cache_key, p);
      return p;
    },

    getCachedPath({user_id, avatar = null}) {
      if (!user_id) return null;
      let safe_id = String(user_id).replace(/[^A-Za-z0-9_-]/g, "_");
      return path_by_key.get(`${safe_id}:${avatar || "default"}`) || null;
    },
  };
}
