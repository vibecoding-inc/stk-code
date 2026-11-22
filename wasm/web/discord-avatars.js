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
  guild_id = null,
  guild_avatar = null,
  cdn_base = "/.proxy/discord-cdn",
  size = 64,
}) {
  let base = String(cdn_base || "/.proxy/discord-cdn").replace(/\/+$/, "");
  if (
    user_id &&
    guild_id &&
    guild_avatar &&
    typeof guild_avatar === "string" &&
    guild_avatar.trim()
  ) {
    return `${base}/guilds/${encodeURIComponent(guild_id)}/users/${encodeURIComponent(user_id)}/avatars/${encodeURIComponent(guild_avatar.trim())}.png?size=${size}`;
  }
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

  async function fetch_and_store({user_id, avatar, guild_id = null, guild_avatar = null}) {
    let fs = get_fs();
    if (!fs || !user_id) return null;

    let safe_id = String(user_id).replace(/[^A-Za-z0-9_-]/g, "_");
    let safe_gid = guild_id ? String(guild_id).replace(/[^A-Za-z0-9_-]/g, "_") : "";
    let cache_key = `${safe_id}:${safe_gid}:${guild_avatar || ""}:${avatar || "default"}`;
    if (path_by_key.has(cache_key)) {
      return path_by_key.get(cache_key);
    }

    // Build ordered fallback chain: guild avatar -> global avatar -> default embed avatar.
    let candidates = [];
    if (guild_id && guild_avatar) {
      candidates.push(build_discord_avatar_url({user_id, guild_id, guild_avatar, cdn_base, size}));
    }
    if (avatar) {
      candidates.push(build_discord_avatar_url({user_id, avatar, cdn_base, size}));
    }
    candidates.push(build_discord_avatar_url({user_id, avatar: null, cdn_base, size}));

    let resp = null;
    let active_url = candidates[0];
    let used_fallback = false;
    for (let i = 0; i < candidates.length; i++) {
      active_url = candidates[i];
      used_fallback = i > 0;
      resp = await fetch_impl(active_url);
      if (resp.ok) break;
    }
    if (!resp || !resp.ok) {
      let status = resp ? resp.status : 0;
      logger.warn(`Failed to fetch Discord avatar for ${user_id} (${status}) from ${active_url}`);
      on_lifecycle("discord_avatar_failed", {
        user_id: String(user_id),
        url: active_url,
        status,
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
    let filename = safe_gid && guild_avatar ? `${safe_id}_g_${safe_gid}.png` : `${safe_id}.png`;
    let memfs_path = `${AVATAR_DIR}/${filename}`;
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

    async ensureAvatar({user_id, avatar = null, guild_id = null, guild_avatar = null}) {
      if (!user_id) return null;
      let safe_id = String(user_id).replace(/[^A-Za-z0-9_-]/g, "_");
      let safe_gid = guild_id ? String(guild_id).replace(/[^A-Za-z0-9_-]/g, "_") : "";
      let cache_key = `${safe_id}:${safe_gid}:${guild_avatar || ""}:${avatar || "default"}`;
      if (path_by_key.has(cache_key)) {
        return path_by_key.get(cache_key);
      }
      if (inflight_by_key.has(cache_key)) {
        return inflight_by_key.get(cache_key);
      }
      let p = fetch_and_store({user_id, avatar, guild_id, guild_avatar})
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

    getCachedPath({user_id, avatar = null, guild_id = null, guild_avatar = null}) {
      if (!user_id) return null;
      let safe_id = String(user_id).replace(/[^A-Za-z0-9_-]/g, "_");
      let safe_gid = guild_id ? String(guild_id).replace(/[^A-Za-z0-9_-]/g, "_") : "";
      return path_by_key.get(`${safe_id}:${safe_gid}:${guild_avatar || ""}:${avatar || "default"}`) || null;
    },
  };
}

const text_encoder = new TextEncoder();

function push_user_to_cpp(module, get_heap_u8, {user_id, display_name, avatar_path}) {
  if (
    !module ||
    module.ABORT ||
    typeof module._stk_discord_register_user !== "function"
  ) {
    return false;
  }
  let alloc = module._stk_tt_alloc || module._malloc;
  let free = module._stk_tt_free || module._free;
  if (typeof alloc !== "function") return false;

  let id_bytes = text_encoder.encode(String(user_id || ""));
  let d_bytes = text_encoder.encode(String(display_name || ""));
  let a_bytes = text_encoder.encode(String(avatar_path || ""));

  let id_ptr = alloc(id_bytes.length + 1);
  let d_ptr = alloc(d_bytes.length + 1);
  let a_ptr = alloc(a_bytes.length + 1);
  if (!id_ptr || !d_ptr || !a_ptr) {
    if (typeof free === "function") {
      if (id_ptr) free(id_ptr);
      if (d_ptr) free(d_ptr);
      if (a_ptr) free(a_ptr);
    }
    return false;
  }

  try {
    let heap = typeof get_heap_u8 === "function" ? get_heap_u8() : get_heap_u8;
    heap.set(id_bytes, id_ptr);
    heap[id_ptr + id_bytes.length] = 0;
    heap.set(d_bytes, d_ptr);
    heap[d_ptr + d_bytes.length] = 0;
    heap.set(a_bytes, a_ptr);
    heap[a_ptr + a_bytes.length] = 0;
    module._stk_discord_register_user(id_ptr, d_ptr, a_ptr);
    return true;
  }
  finally {
    if (typeof free === "function") {
      free(id_ptr);
      free(d_ptr);
      free(a_ptr);
    }
  }
}

/**
 * Keeps Discord Activity participants' display names and circular avatars synced
 * into Emscripten MEMFS and C++'s DiscordAvatarManager (keyed by Discord user_id).
 *
 * Uses `discordSdk.commands.getInstanceConnectedParticipants()` for initial
 * state and subscribes to `ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE` for live joins.
 */
export function create_participant_avatar_sync({
  avatar_cache,
  fetch_impl = (...args) => fetch(...args),
  get_discord_sdk = () => globalThis.discordSdk || null,
  get_discord_auth = () => globalThis.discordAuth || null,
  get_session_token = () => globalThis.discordSessionToken || null,
  get_guild_member = () => globalThis.discordGuildMember || null,
  get_module = () => (typeof Module !== "undefined" ? Module : null),
  get_heap_u8 = () => (typeof HEAPU8 !== "undefined" ? HEAPU8 : (typeof Module !== "undefined" ? Module.HEAPU8 : null)),
  logger = console,
  on_lifecycle = () => {},
} = {}) {
  let entries_by_id = new Map();
  let subscribed = false;
  let initial_sync_promise = null;
  // Never call exported WASM functions (_stk_tt_alloc / _stk_discord_register_user)
  // before C++'s main() invokes flushToWasm(); calling native functions while on the
  // pre-launch HTML screen triggers Emscripten's -sASSERTIONS=1 runtime-init abort.
  let wasm_ready = false;

  async function fetch_scope_profiles(user_ids) {
    let token = get_session_token();
    if (!token || !Array.isArray(user_ids) || user_ids.length === 0) {
      return new Map();
    }
    try {
      let resp = await fetch_impl(
        `/api/timetrials/scope-profiles?ids=${encodeURIComponent(user_ids.join(","))}`,
        {headers: {Authorization: `Bearer ${token}`}}
      );
      if (!resp.ok) return new Map();
      let body = await resp.json();
      let map = new Map();
      for (let p of (body && Array.isArray(body.profiles) ? body.profiles : [])) {
        if (p && p.user_id) map.set(String(p.user_id), p);
      }
      return map;
    }
    catch {
      return new Map();
    }
  }

  async function sync_users(users, source = "unknown") {
    if (!Array.isArray(users) || !avatar_cache) return;
    let ids = users.map((u) => (u && u.id ? String(u.id) : null)).filter(Boolean);
    let scope_profiles = await fetch_scope_profiles(ids);
    let self_auth = get_discord_auth();
    let self_id = self_auth && self_auth.user && self_auth.user.id ? String(self_auth.user.id) : null;
    let self_member = get_guild_member();

    let avatars_loaded = 0;
    await Promise.all(
      users.map(async (u) => {
        if (!u || !u.id) return;
        let user_id = String(u.id);
        let prev = entries_by_id.get(user_id);
        let sp = scope_profiles.get(user_id) || null;
        let is_self = self_id && user_id === self_id;

        let guild_id =
          (is_self && self_member && self_member.guild_id) ||
          (sp && sp.guild_id) ||
          (prev && prev.guild_id) ||
          null;
        let guild_nick =
          (is_self && self_member && self_member.guild_nick) ||
          (sp && sp.guild_nick) ||
          (u.nickname ? String(u.nickname) : null) ||
          (source === "auth_self" && prev ? prev.guild_nick : null);
        let guild_avatar =
          (is_self && self_member && self_member.guild_avatar) ||
          (sp && sp.guild_avatar) ||
          (prev && prev.guild_avatar) ||
          null;
        let global_name = u.global_name
          ? String(u.global_name)
          : (prev ? prev.global_name : null);
        let username = u.username
          ? String(u.username)
          : (prev ? prev.username : "Player");
        let display_name = guild_nick || global_name || username;

        let avatar_path = (await avatar_cache.ensureAvatar({
          user_id,
          avatar: (u.avatar ? String(u.avatar) : null) || (sp && sp.avatar) || null,
          guild_id,
          guild_avatar,
        })) || (prev ? prev.avatar_path : "");
        if (avatar_path) avatars_loaded++;

        let entry = {
          user_id,
          username,
          global_name,
          guild_id,
          guild_nick,
          guild_avatar,
          display_name,
          avatar_path,
        };
        entries_by_id.set(user_id, entry);
        if (wasm_ready) {
          push_user_to_cpp(get_module(), get_heap_u8, entry);
        }
      })
    );
    on_lifecycle("discord_participants_synced", {
      source,
      count: users.length,
      avatars_loaded,
      scope_profiles_matched: scope_profiles.size,
      cdn_base: avatar_cache.cdn_base || null,
    });
  }

  return {
    start() {
      initial_sync_promise = (async () => {
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
      })();
      return initial_sync_promise;
    },

    async waitForInitialSync(timeout_ms = 1500) {
      if (!initial_sync_promise) return;
      await Promise.race([
        initial_sync_promise.catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, timeout_ms)),
      ]);
    },

    flushToWasm() {
      wasm_ready = true;
      let mod = get_module();
      if (!mod || typeof mod._stk_discord_register_user !== "function") {
        logger.warn("flushToWasm skipped: _stk_discord_register_user is not exported on Module.");
        return;
      }
      let pushed = 0;
      for (let entry of entries_by_id.values()) {
        if (push_user_to_cpp(mod, get_heap_u8, entry)) pushed++;
      }
      on_lifecycle("discord_participants_flushed", {count: pushed});
    },

    _getEntries() {
      return entries_by_id;
    },
  };
}
