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
  on_lifecycle = () => {},
} = {}) {
  let path_by_key = new Map();
  let inflight_by_key = new Map();

  function is_image_response(resp) {
    let ct = resp && resp.headers && typeof resp.headers.get === "function"
      ? (resp.headers.get("content-type") || "")
      : "";
    // Allow missing content-type in unit test mocks, but reject explicit HTML/JSON/text fallbacks.
    if (!ct) return true;
    return ct.toLowerCase().startsWith("image/");
  }

  async function fetch_and_store({user_id, avatar}) {
    let fs = get_fs();
    if (!fs || !user_id) return null;

    let safe_id = String(user_id).replace(/[^A-Za-z0-9_-]/g, "_");
    let cache_key = `${safe_id}:${avatar || "default"}`;
    if (path_by_key.has(cache_key)) {
      return path_by_key.get(cache_key);
    }

    let primary_url = build_discord_avatar_url({user_id, avatar, cdn_base, size});
    let active_url = primary_url;
    let used_fallback = false;
    let resp = await fetch_impl(primary_url);

    // Fall back to Discord default avatar if custom avatar hash returned 404.
    if (!resp.ok && avatar) {
      used_fallback = true;
      active_url = build_discord_avatar_url({user_id, avatar: null, cdn_base, size});
      resp = await fetch_impl(active_url);
    }
    if (!resp.ok) {
      logger.warn(`Failed to fetch Discord avatar for ${user_id} (${resp.status}) from ${active_url}`);
      on_lifecycle("discord_avatar_failed", {
        user_id: String(user_id),
        url: active_url,
        status: resp.status,
        reason: "http_error",
      });
      return null;
    }

    if (!is_image_response(resp)) {
      let ct = resp.headers.get("content-type") || "";
      logger.warn(
        `Unexpected Content-Type "${ct}" fetching Discord avatar from ${active_url} (check Discord URL Mapping /discord-cdn -> cdn.discordapp.com)`
      );
      on_lifecycle("discord_avatar_failed", {
        user_id: String(user_id),
        url: active_url,
        status: resp.status,
        content_type: ct,
        reason: "non_image_content_type",
      });
      return null;
    }

    let blob = await resp.blob();
    let png_bytes = await crop_impl(blob, size);
    if (!png_bytes || png_bytes.length === 0) {
      logger.warn(`Discord avatar crop returned empty bytes for ${user_id}`);
      on_lifecycle("discord_avatar_failed", {
        user_id: String(user_id),
        url: active_url,
        reason: "empty_png",
      });
      return null;
    }

    ensure_dir(fs, AVATAR_DIR);
    let memfs_path = `${AVATAR_DIR}/${safe_id}.png`;
    fs.writeFile(memfs_path, png_bytes);
    path_by_key.set(cache_key, memfs_path);
    on_lifecycle("discord_avatar_loaded", {
      user_id: String(user_id),
      used_fallback,
      bytes: png_bytes.length,
    });
    return memfs_path;
  }

  return {
    cdn_base,

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
          on_lifecycle("discord_avatar_failed", {
            user_id: String(user_id),
            reason: err && err.message ? err.message : String(err),
          });
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

const text_encoder = new TextEncoder();

function push_participant_to_cpp(module, get_heap_u8, {username, display_name, avatar_path}) {
  if (!module || typeof module._stk_discord_register_participant !== "function") {
    return false;
  }
  let alloc = module._stk_tt_alloc || module._malloc;
  let free = module._stk_tt_free || module._free;
  if (typeof alloc !== "function") return false;

  let u_bytes = text_encoder.encode(String(username || ""));
  let d_bytes = text_encoder.encode(String(display_name || ""));
  let a_bytes = text_encoder.encode(String(avatar_path || ""));

  let u_ptr = alloc(u_bytes.length + 1);
  let d_ptr = alloc(d_bytes.length + 1);
  let a_ptr = alloc(a_bytes.length + 1);
  if (!u_ptr || !d_ptr || !a_ptr) {
    if (typeof free === "function") {
      if (u_ptr) free(u_ptr);
      if (d_ptr) free(d_ptr);
      if (a_ptr) free(a_ptr);
    }
    return false;
  }

  try {
    let heap = typeof get_heap_u8 === "function" ? get_heap_u8() : get_heap_u8;
    heap.set(u_bytes, u_ptr);
    heap[u_ptr + u_bytes.length] = 0;
    heap.set(d_bytes, d_ptr);
    heap[d_ptr + d_bytes.length] = 0;
    heap.set(a_bytes, a_ptr);
    heap[a_ptr + a_bytes.length] = 0;
    module._stk_discord_register_participant(u_ptr, d_ptr, a_ptr);
    return true;
  }
  finally {
    if (typeof free === "function") {
      free(u_ptr);
      free(d_ptr);
      free(a_ptr);
    }
  }
}

/**
 * Keeps Discord Activity multiplayer participants' display names and circular
 * avatars synced into Emscripten MEMFS and C++'s DiscordAvatarManager.
 *
 * Uses `discordSdk.commands.getInstanceConnectedParticipants()` for initial
 * state and subscribes to `ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE` for live joins.
 */
export function create_participant_avatar_sync({
  avatar_cache,
  get_discord_sdk = () => globalThis.discordSdk || null,
  get_discord_auth = () => globalThis.discordAuth || null,
  get_module = () => (typeof Module !== "undefined" ? Module : null),
  get_heap_u8 = () => (typeof HEAPU8 !== "undefined" ? HEAPU8 : (typeof Module !== "undefined" ? Module.HEAPU8 : null)),
  logger = console,
  on_lifecycle = () => {},
} = {}) {
  let entries_by_username = new Map();
  let subscribed = false;

  async function sync_users(users, source = "unknown") {
    if (!Array.isArray(users) || !avatar_cache) return;
    let avatars_loaded = 0;
    await Promise.all(
      users.map(async (u) => {
        if (!u || !u.id || !u.username) return;
        let username = String(u.username);
        let display_name = String(u.nickname || u.global_name || u.username);
        let avatar_path = (await avatar_cache.ensureAvatar({
          user_id: String(u.id),
          avatar: u.avatar ? String(u.avatar) : null,
        })) || "";
        if (avatar_path) avatars_loaded++;

        let entry = {username, display_name, avatar_path};
        entries_by_username.set(username.toLowerCase(), entry);
        push_participant_to_cpp(get_module(), get_heap_u8, entry);
      })
    );
    on_lifecycle("discord_participants_synced", {
      source,
      count: users.length,
      avatars_loaded,
      cdn_base: avatar_cache.cdn_base || null,
    });
  }

  return {
    async start() {
      let auth = get_discord_auth();
      if (auth && auth.user) {
        await sync_users([auth.user], "auth_self");
      }

      let sdk = get_discord_sdk();
      if (!sdk) return;

      if (sdk.commands && typeof sdk.commands.getInstanceConnectedParticipants === "function") {
        try {
          let res = await sdk.commands.getInstanceConnectedParticipants();
          if (res && Array.isArray(res.participants)) {
            await sync_users(res.participants, "initial_participants");
          }
        }
        catch (err) {
          logger.warn("getInstanceConnectedParticipants failed:", err);
          on_lifecycle("discord_participants_sync_failed", {
            stage: "initial",
            reason: err && err.message ? err.message : String(err),
          });
        }
      }

      if (!subscribed && typeof sdk.subscribe === "function") {
        subscribed = true;
        try {
          sdk.subscribe("ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE", (evt) => {
            if (evt && Array.isArray(evt.participants)) {
              sync_users(evt.participants, "live_update").catch((err) => {
                logger.warn("Participant avatar update failed:", err);
              });
            }
          });
        }
        catch (err) {
          subscribed = false;
          logger.warn("Subscribe to ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE failed:", err);
        }
      }
    },

    flushToWasm() {
      let mod = get_module();
      if (!mod || typeof mod._stk_discord_register_participant !== "function") {
        logger.warn("flushToWasm skipped: _stk_discord_register_participant is not exported on Module.");
        return;
      }
      let pushed = 0;
      for (let entry of entries_by_username.values()) {
        if (push_participant_to_cpp(mod, get_heap_u8, entry)) pushed++;
      }
      on_lifecycle("discord_participants_flushed", {count: pushed});
    },

    _getEntries() {
      return entries_by_username;
    },
  };
}
