// Browser-side JS <-> WASM bridge for Discord Activity Time Trials.
//
// Responsibilities:
//   1. Fetches challenge metadata + up to 20 ghosts (+ player's own PB) and writes
//      the decompressed .replay files into Emscripten MEMFS (/tmp/tt_ghosts/).
//   2. Exposes synchronous getters for C++ startup (getPreparedChallengeJson).
//   3. Handles async C++ -> JS requests (refresh ghosts on Restart, submit finished
//      .replay compressed with gzip) and delivers JSON responses back to C++ via
//      EMSCRIPTEN_KEEPALIVE callbacks on the main thread.

const GHOST_DIR = "/tmp/tt_ghosts";
const text_encoder = new TextEncoder();

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

function clear_dir(fs, dir) {
  try {
    let entries = fs.readdir(dir);
    for (let entry of entries) {
      if (entry === "." || entry === "..") continue;
      try {
        fs.unlink(`${dir}/${entry}`);
      }
      catch {
        // Ignore non-file entries
      }
    }
  }
  catch {
    // Directory did not exist yet
  }
}

function invoke_cpp_json_callback(module, heap_u8, fn_name, req_id, http_status, payload_obj) {
  let alloc = module && (module._stk_tt_alloc || module._malloc);
  let free = module && (module._stk_tt_free || module._free);
  if (!module || typeof module[fn_name] !== "function" || typeof alloc !== "function") {
    return false;
  }
  let json_bytes = text_encoder.encode(JSON.stringify(payload_obj || {}));
  let ptr = alloc(json_bytes.length + 1);
  if (!ptr) return false;
  try {
    let heap = typeof heap_u8 === "function" ? heap_u8() : heap_u8;
    heap.set(json_bytes, ptr);
    heap[ptr + json_bytes.length] = 0;
    module[fn_name](req_id, http_status, ptr);
    return true;
  }
  finally {
    if (typeof free === "function") {
      free(ptr);
    }
  }
}

export function create_time_trials_bridge({
  fetch_impl = (...args) => fetch(...args),
  get_session_token = () => globalThis.discordSessionToken || null,
  get_pending = () => globalThis.stkPendingTimeTrial || null,
  get_fs = () => (typeof FS !== "undefined" ? FS : null),
  get_module = () => (typeof Module !== "undefined" ? Module : null),
  get_heap_u8 = () => (typeof HEAPU8 !== "undefined" ? HEAPU8 : (typeof Module !== "undefined" ? Module.HEAPU8 : null)),
  gzip_impl,
  ungzip_impl,
  avatar_cache = null,
  logger = console,
  on_lifecycle = () => {},
} = {}) {
  let prepared_challenge = null;
  let pending_submit_promise = null;

  function maybe_ungzip(bytes) {
    if (
      bytes &&
      bytes.length >= 2 &&
      bytes[0] === 0x1f &&
      bytes[1] === 0x8b &&
      typeof ungzip_impl === "function"
    ) {
      return new Uint8Array(ungzip_impl(bytes));
    }
    return bytes;
  }

  async function fetch_challenge_and_ghosts(challenge_id) {
    // Wait for any in-flight run upload to settle before refreshing ghosts so
    // clicking Restart immediately after finishing includes the new PB.
    if (pending_submit_promise) {
      await pending_submit_promise.catch(() => {});
    }

    let token = get_session_token();
    if (!token) {
      throw new Error("Missing Discord Time Trial session token.");
    }
    let resp = await fetch_impl(`/api/timetrials/challenges/${encodeURIComponent(challenge_id)}`, {
      headers: {Authorization: `Bearer ${token}`},
    });
    if (!resp.ok) {
      let err_text = await resp.text().catch(() => "");
      throw new Error(`Failed to fetch Time Trial challenge (${resp.status}): ${err_text}`);
    }
    let data = await resp.json();
    let ghosts = Array.isArray(data.ghosts) ? data.ghosts : [];

    let fs = get_fs();
    let ghost_files = [];
    let ghost_user_ids = [];
    let ghost_names = [];
    let ghost_avatars = [];
    let ghost_is_self = [];
    let me = data.me || null;
    let self_user_id = (me && me.user_id) || "";
    let self_name = (me && me.display_name) || "";
    let self_avatar = "";
    if (fs) {
      ensure_dir(fs, GHOST_DIR);
      clear_dir(fs, GHOST_DIR);

      let self_avatar_promise =
        me && me.user_id && avatar_cache && typeof avatar_cache.ensureAvatar === "function"
          ? avatar_cache.ensureAvatar({
              user_id: me.user_id,
              avatar: me.avatar || null,
              guild_id: me.guild_id || null,
              guild_avatar: me.guild_avatar || null,
            })
          : Promise.resolve(null);

      let [resolved_self_avatar, downloaded] = await Promise.all([
        self_avatar_promise,
        Promise.all(
          ghosts.map(async (g) => {
            try {
              let replay_promise = fetch_impl(g.url, {
                headers: {Authorization: `Bearer ${token}`},
              });
              let avatar_promise = avatar_cache && typeof avatar_cache.ensureAvatar === "function"
                ? avatar_cache.ensureAvatar({
                    user_id: g.user_id,
                    avatar: g.avatar || null,
                    guild_id: g.guild_id || null,
                    guild_avatar: g.guild_avatar || null,
                  })
                : Promise.resolve(null);

              let [r, avatar_path] = await Promise.all([replay_promise, avatar_promise]);
              if (!r.ok) {
                logger.warn(`Failed to download ghost ${g.run_id} (${r.status})`);
                on_lifecycle("time_trial_ghost_load_failed", {run_id: g.run_id, reason: `http_${r.status}`});
                return null;
              }
              let raw_bytes = new Uint8Array(await r.arrayBuffer());
              if (raw_bytes.length === 0) {
                on_lifecycle("time_trial_ghost_load_failed", {run_id: g.run_id, reason: "empty_body"});
                return null;
              }
              let bytes = maybe_ungzip(raw_bytes);
              // Sanity check header ("version:") so corrupt/encoded blobs are logged clearly.
              let header_preview = new TextDecoder().decode(bytes.subarray(0, 16));
              if (!header_preview.startsWith("version:")) {
                logger.warn(`Ghost ${g.run_id} has unexpected header: ${JSON.stringify(header_preview)}`);
                on_lifecycle("time_trial_ghost_load_failed", {run_id: g.run_id, reason: "bad_header"});
                return null;
              }
              let path = `${GHOST_DIR}/${g.run_id}.replay`;
              fs.writeFile(path, bytes);
              let is_self = Boolean(g.is_self || (me && me.user_id && g.user_id === me.user_id));
              return {
                path,
                user_id: g.user_id ? String(g.user_id) : "",
                name: g.display_name || "",
                avatar: avatar_path || "",
                is_self,
              };
            }
            catch (err) {
              logger.warn(`Ghost download error for ${g.run_id}:`, err);
              on_lifecycle("time_trial_ghost_load_failed", {
                run_id: g.run_id,
                reason: err && err.message ? err.message : String(err),
              });
              return null;
            }
          })
        ),
      ]);
      self_avatar = resolved_self_avatar || "";
      for (let item of downloaded) {
        if (!item) continue;
        ghost_files.push(item.path);
        ghost_user_ids.push(item.user_id);
        ghost_names.push(item.name);
        ghost_avatars.push(item.avatar);
        ghost_is_self.push(item.is_self ? "1" : "0");
      }
    }

    prepared_challenge = {
      challenge: data.challenge,
      total_players: data.total_players || 0,
      leaderboard: data.leaderboard || [],
      self_user_id,
      self_name,
      self_avatar,
      ghost_files,
      ghost_user_ids,
      ghost_names,
      ghost_avatars,
      ghost_is_self,
    };

    on_lifecycle("time_trial_ghosts_loaded", {
      challenge_id,
      ghost_count: ghost_files.length,
    });

    return prepared_challenge;
  }

  return {
    getPendingChallenge() {
      return get_pending();
    },

    getPreparedChallengeJson() {
      return prepared_challenge ? JSON.stringify(prepared_challenge) : "";
    },

    fetchChallengeAndGhosts: fetch_challenge_and_ghosts,

    requestRefreshGhosts(req_id, challenge_id) {
      fetch_challenge_and_ghosts(challenge_id)
        .then((data) => {
          invoke_cpp_json_callback(
            get_module(),
            get_heap_u8,
            "_stk_tt_on_ghosts_ready",
            req_id,
            200,
            data
          );
        })
        .catch((err) => {
          logger.warn("Time Trial ghost refresh failed:", err);
          invoke_cpp_json_callback(
            get_module(),
            get_heap_u8,
            "_stk_tt_on_ghosts_ready",
            req_id,
            500,
            {error: err && err.message ? err.message : String(err)}
          );
        });
    },

    requestSubmitRun(req_id, metadata_json, replay_ptr, replay_len) {
      let token = get_session_token();
      if (!token) {
        invoke_cpp_json_callback(
          get_module(),
          get_heap_u8,
          "_stk_tt_on_submit_result",
          req_id,
          401,
          {error: "Missing session token"}
        );
        return;
      }

      // Copy replay bytes out of WASM heap synchronously before returning to C++.
      let heap = get_heap_u8();
      let raw_copy = new Uint8Array(replay_len);
      raw_copy.set(heap.subarray(replay_ptr, replay_ptr + replay_len));

      let submit_promise = (async () => {
        try {
          let gzipped = typeof gzip_impl === "function"
            ? gzip_impl(raw_copy)
            : raw_copy;

          let form = new FormData();
          form.append("metadata", metadata_json);
          form.append("replay", new Blob([gzipped], {type: "application/gzip"}), "run.replay.gz");

          let resp = await fetch_impl("/api/timetrials/runs", {
            method: "POST",
            headers: {Authorization: `Bearer ${token}`},
            body: form,
          });
          let body = await resp.json().catch(() => ({}));
          on_lifecycle("time_trial_run_submitted", {
            status: resp.status,
            is_new_pb: Boolean(body && body.is_new_pb),
            is_new_first: Boolean(body && body.is_new_first),
            rank: body && body.rank ? body.rank : null,
          });
          invoke_cpp_json_callback(
            get_module(),
            get_heap_u8,
            "_stk_tt_on_submit_result",
            req_id,
            resp.status,
            body
          );
        }
        catch (err) {
          logger.warn("Time Trial run submission failed:", err);
          invoke_cpp_json_callback(
            get_module(),
            get_heap_u8,
            "_stk_tt_on_submit_result",
            req_id,
            500,
            {error: err && err.message ? err.message : String(err)}
          );
        }
        finally {
          if (pending_submit_promise === submit_promise) {
            pending_submit_promise = null;
          }
        }
      })();
      pending_submit_promise = submit_promise;
    },
  };
}
