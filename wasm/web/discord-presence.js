// Discord Embedded App SDK Rich Presence manager for SuperTuxKart WASM.
//
// Receives compact state snapshots from C++ (`src/io/rich_presence.cpp`) and
// JS boot code (`script.js`), resolves public track/kart thumbnail URLs from
// `/game/presence/manifest.json`, deduplicates identical payloads, throttles
// in-race updates to respect Discord RPC rate limits, and fails open whenever
// running outside Discord or before authentication finishes.

const DEFAULT_MIN_INTERVAL_MS = 8000;
const MANIFEST_URL = "/game/presence/manifest.json";
const FALLBACK_ICON_PATH = "/supertuxkart_64.png";

export function format_ordinal(n) {
  let num = Number(n);
  if (!Number.isInteger(num) || num <= 0) {
    return "";
  }
  let mod100 = num % 100;
  if (mod100 >= 11 && mod100 <= 13) {
    return `${num}th`;
  }
  switch (num % 10) {
    case 1: return `${num}st`;
    case 2: return `${num}nd`;
    case 3: return `${num}rd`;
    default: return `${num}th`;
  }
}

function clean_text(value, max_len = 128) {
  if (typeof value !== "string") return "";
  let trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.length > max_len ? trimmed.slice(0, max_len) : trimmed;
}

function normalize_origin(origin) {
  if (typeof origin !== "string" || !origin) return null;
  try {
    let parsed = new URL(origin);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      return parsed.origin;
    }
  }
  catch {}
  return null;
}

function resolve_asset_url(public_origin, rel_path) {
  let origin = normalize_origin(public_origin);
  if (!origin || typeof rel_path !== "string" || !rel_path) {
    return null;
  }
  let normalized = rel_path.startsWith("/") ? rel_path : `/game/presence/${rel_path}`;
  return `${origin}${normalized}`;
}

export function build_presence_activity(snapshot, {
  manifest = null,
  public_origin = null,
  instance_id = null,
  start_timestamp_sec = null,
} = {}) {
  let s = snapshot && typeof snapshot === "object" ? snapshot : {};
  let phase = typeof s.phase === "string" ? s.phase : "menu";
  let track_ident = clean_text(s.track_ident, 64);
  let track_name = clean_text(s.track_name, 96);
  let kart_ident = clean_text(s.kart_ident, 64);
  let kart_name = clean_text(s.kart_name, 64);
  let mode_name = clean_text(s.mode_name, 64);
  let rank = Number.isInteger(s.rank) ? s.rank : 0;
  let total_karts = Number.isInteger(s.total_karts) ? s.total_karts : 0;
  let is_time_trial = Boolean(s.is_time_trial);
  let in_multiplayer = Boolean(s.in_multiplayer);
  let human_players = Number.isInteger(s.human_players) ? s.human_players : 0;
  let max_players = Number.isInteger(s.max_players) ? s.max_players : 0;

  let details = "In Main Menu";
  let state = "";
  let use_track_asset = false;
  let use_kart_asset = false;

  switch (phase) {
    case "loading":
      details = "Loading SuperTuxKart";
      break;
    case "lobby":
      details = "In Lobby";
      state = "Waiting to race";
      break;
    case "spectating":
      details = track_name || "Racing";
      state = "Spectating";
      use_track_asset = true;
      break;
    case "race":
      details = track_name || "Racing";
      if (is_time_trial) {
        state = "Time Trial";
      }
      else if (rank > 0 && total_karts > 0) {
        state = `${format_ordinal(rank)} of ${total_karts}`;
      }
      else if (mode_name) {
        state = mode_name;
      }
      else {
        state = "Racing";
      }
      use_track_asset = true;
      use_kart_asset = true;
      break;
    case "results":
      details = track_name || "Race Finished";
      if (!is_time_trial && rank > 0 && total_karts > 0) {
        state = `Finished ${format_ordinal(rank)} of ${total_karts}`;
      }
      else if (is_time_trial) {
        state = "Finished Time Trial";
      }
      else {
        state = "Finished";
      }
      use_track_asset = true;
      use_kart_asset = true;
      break;
    case "menu":
    default:
      details = "In Main Menu";
      break;
  }

  let activity = {
    type: 0,
    details,
  };
  if (state) {
    activity.state = state;
  }

  let ts = Number.isFinite(start_timestamp_sec) && start_timestamp_sec > 0
    ? Math.floor(start_timestamp_sec)
    : null;
  if (ts !== null) {
    activity.timestamps = {start: ts};
  }

  let tracks_map = manifest && manifest.tracks && typeof manifest.tracks === "object"
    ? manifest.tracks
    : null;
  let karts_map = manifest && manifest.karts && typeof manifest.karts === "object"
    ? manifest.karts
    : null;

  let large_image = null;
  let large_text = "SuperTuxKart";
  if (use_track_asset && track_ident && tracks_map && tracks_map[track_ident]) {
    large_image = resolve_asset_url(public_origin, tracks_map[track_ident]);
    large_text = track_name || "SuperTuxKart";
  }
  else {
    large_image = resolve_asset_url(public_origin, FALLBACK_ICON_PATH);
    if (use_track_asset && track_name) {
      large_text = track_name;
    }
  }

  let small_image = null;
  let small_text = "";
  if (use_kart_asset && kart_ident && karts_map && karts_map[kart_ident]) {
    small_image = resolve_asset_url(public_origin, karts_map[kart_ident]);
    small_text = kart_name || kart_ident;
  }

  let assets = {};
  if (large_image) {
    assets.large_image = large_image;
    assets.large_text = large_text;
  }
  if (small_image) {
    assets.small_image = small_image;
    if (small_text) {
      assets.small_text = small_text;
    }
  }
  if (Object.keys(assets).length > 0) {
    activity.assets = assets;
  }

  // Only count human players in party.size so AI bots never mark a lobby full.
  if (in_multiplayer && instance_id && human_players >= 1) {
    let cap = max_players >= human_players ? max_players : human_players;
    activity.party = {
      id: String(instance_id),
      size: [human_players, cap],
    };
  }

  return activity;
}

export function create_discord_presence({
  get_discord_sdk = () => globalThis.discordSdk || null,
  get_discord_auth = () => globalThis.discordAuth || null,
  get_public_origin = () => globalThis.stkPublicOrigin || null,
  fetch_impl = (...args) => fetch(...args),
  now_ms = () => Date.now(),
  set_timeout = (...args) => setTimeout(...args),
  clear_timeout = (...args) => clearTimeout(...args),
  min_interval_ms = DEFAULT_MIN_INTERVAL_MS,
  logger = console,
  on_lifecycle = () => {},
} = {}) {
  let manifest = null;
  let manifest_promise = null;
  let last_sent_json = null;
  let last_sent_ms = 0;
  let pending_timer = null;
  let latest_snapshot = null;
  let active_phase_group = null;
  let active_track_ident = "";
  let phase_start_sec = Math.floor(now_ms() / 1000);
  let disposed = false;

  function can_send() {
    let sdk = get_discord_sdk();
    let auth = get_discord_auth();
    return Boolean(
      !disposed &&
      sdk &&
      auth &&
      sdk.commands &&
      typeof sdk.commands.setActivity === "function"
    );
  }

  function resolve_phase_group(phase) {
    if (phase === "race" || phase === "spectating" || phase === "results") {
      return "in_race";
    }
    if (phase === "lobby") {
      return "lobby";
    }
    return "session";
  }

  function update_timer_anchor(snapshot) {
    let phase = snapshot && typeof snapshot.phase === "string" ? snapshot.phase : "menu";
    let group = resolve_phase_group(phase);
    let track = snapshot && typeof snapshot.track_ident === "string" ? snapshot.track_ident : "";

    let explicit_start = snapshot && Number.isFinite(snapshot.start_timestamp_sec) && snapshot.start_timestamp_sec > 0
      ? Math.floor(snapshot.start_timestamp_sec)
      : null;

    if (explicit_start !== null) {
      phase_start_sec = explicit_start;
      active_phase_group = group;
      active_track_ident = track;
      return;
    }

    let entered_new_group = group !== active_phase_group;
    let started_new_track = group === "in_race" && track && track !== active_track_ident && phase !== "results";
    if (entered_new_group || started_new_track) {
      phase_start_sec = Math.floor(now_ms() / 1000);
      active_phase_group = group;
      active_track_ident = track;
    }
  }

  async function send_now(snapshot) {
    if (!can_send()) {
      return false;
    }
    let sdk = get_discord_sdk();
    let activity = build_presence_activity(snapshot, {
      manifest,
      public_origin: get_public_origin(),
      instance_id: sdk.instanceId || null,
      start_timestamp_sec: phase_start_sec,
    });
    let serialized = JSON.stringify(activity);
    if (serialized === last_sent_json) {
      return false;
    }
    last_sent_json = serialized;
    last_sent_ms = now_ms();
    try {
      await sdk.commands.setActivity({activity});
      on_lifecycle("discord_presence_updated", {
        phase: snapshot && snapshot.phase ? snapshot.phase : "menu",
        details: activity.details,
        state: activity.state || null,
      });
      return true;
    }
    catch (err) {
      // Allow retry on next update if RPC failed transiently.
      last_sent_json = null;
      logger.warn("Discord setActivity failed.", err);
      return false;
    }
  }

  function schedule_flush(delay_ms) {
    if (pending_timer !== null || disposed) {
      return;
    }
    pending_timer = set_timeout(() => {
      pending_timer = null;
      if (latest_snapshot) {
        send_now(latest_snapshot);
      }
    }, Math.max(0, delay_ms));
  }

  function update(snapshot, {force = false} = {}) {
    if (disposed || !snapshot || typeof snapshot !== "object") {
      return Promise.resolve(false);
    }
    latest_snapshot = snapshot;
    update_timer_anchor(snapshot);

    if (!can_send()) {
      return Promise.resolve(false);
    }

    let elapsed = now_ms() - last_sent_ms;
    if (force || last_sent_ms === 0 || elapsed >= min_interval_ms) {
      if (pending_timer !== null) {
        clear_timeout(pending_timer);
        pending_timer = null;
      }
      return send_now(snapshot);
    }

    schedule_flush(min_interval_ms - elapsed);
    return Promise.resolve(false);
  }

  async function loadManifest() {
    if (manifest_promise) {
      return manifest_promise;
    }
    manifest_promise = (async () => {
      try {
        let resp = await fetch_impl(MANIFEST_URL);
        if (!resp || !resp.ok) {
          return null;
        }
        let data = await resp.json();
        if (data && typeof data === "object") {
          manifest = data;
          if (latest_snapshot && can_send()) {
            await send_now(latest_snapshot);
          }
          return manifest;
        }
      }
      catch {}
      return null;
    })();
    return manifest_promise;
  }

  function dispose() {
    disposed = true;
    if (pending_timer !== null) {
      clear_timeout(pending_timer);
      pending_timer = null;
    }
  }

  return {
    update,
    loadManifest,
    dispose,
  };
}
