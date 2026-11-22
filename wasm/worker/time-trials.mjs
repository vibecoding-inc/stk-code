// SuperTuxKart Discord Activity Time Trials backend (Cloudflare Workers + D1 + R2).
//
// Routes (handled under /api/timetrials/*):
//   GET  /api/timetrials/challenges/:challenge_id  -> challenge config + leaderboard + ghost list
//   GET  /api/timetrials/runs/:run_id/replay       -> streams gzipped .replay from R2
//   POST /api/timetrials/runs                      -> uploads gzipped .replay, updates PB, refreshes Discord embeds

import { verify_jwt } from "./jwt.mjs";
import {
  get_track,
  get_difficulty_name,
  format_time_ms,
  format_kart_name,
} from "./tracks.mjs";

const MAX_REPLAY_BYTES = 512 * 1024; // 512 KiB gzipped
const MAX_GHOSTS_RETURNED = 20;
const EMBED_TOP_N = 10;
const MAX_INTERACTION_FOLLOWUPS = 5;
const DISCORD_API_BASE = "https://discord.com/api/v10";

const MEDALS = ["🥇", "🥈", "🥉"];

function json_response(body, status = 200, extra_headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...extra_headers,
    },
  });
}

function extract_bearer(request) {
  let header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Bearer ")) return null;
  let token = header.slice("Bearer ".length).trim();
  return token || null;
}

export async function authenticate_session(request, env) {
  if (!env.JWT_SECRET) {
    return {error: json_response({error: "JWT_SECRET is not configured."}, 503)};
  }
  let token = extract_bearer(request);
  if (!token) {
    return {error: json_response({error: "Missing Bearer session token."}, 401)};
  }
  let claims = await verify_jwt(token, env.JWT_SECRET);
  if (!claims || !claims.sub || !claims.scope_type || !claims.scope_id) {
    return {error: json_response({error: "Invalid or expired session token."}, 401)};
  }
  return {claims};
}

export async function upsert_user(db, {user_id, username, display_name, avatar = null}, now = Date.now()) {
  if (!db || !user_id) return;
  let safe_username = String(username || "Player").slice(0, 64);
  let safe_display = String(display_name || safe_username).slice(0, 64);
  let safe_avatar = typeof avatar === "string" && avatar.trim() ? avatar.trim().slice(0, 128) : null;
  await db
    .prepare(
      `INSERT INTO users (user_id, username, display_name, avatar, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         username = excluded.username,
         display_name = excluded.display_name,
         avatar = COALESCE(excluded.avatar, users.avatar),
         updated_at = excluded.updated_at`
    )
    .bind(user_id, safe_username, safe_display, safe_avatar, now)
    .run();
}

export async function ensure_scope_member(
  db,
  {
    scope_type,
    scope_id,
    user_id,
    guild_nick = null,
    guild_avatar = null,
    update_guild_profile = false,
  },
  now = Date.now()
) {
  if (!db || !scope_type || !scope_id || !user_id) return;
  let safe_nick = typeof guild_nick === "string" && guild_nick.trim() ? guild_nick.trim().slice(0, 64) : null;
  let safe_guild_avatar = typeof guild_avatar === "string" && guild_avatar.trim()
    ? guild_avatar.trim().slice(0, 128)
    : null;

  if (update_guild_profile) {
    await db
      .prepare(
        `INSERT INTO scope_members (scope_type, scope_id, user_id, joined_at, guild_nick, guild_avatar)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope_type, scope_id, user_id) DO UPDATE SET
           guild_nick = excluded.guild_nick,
           guild_avatar = excluded.guild_avatar`
      )
      .bind(scope_type, scope_id, user_id, now, safe_nick, safe_guild_avatar)
      .run();
  }
  else {
    await db
      .prepare(
        `INSERT INTO scope_members (scope_type, scope_id, user_id, joined_at, guild_nick, guild_avatar)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope_type, scope_id, user_id) DO NOTHING`
      )
      .bind(scope_type, scope_id, user_id, now, safe_nick, safe_guild_avatar)
      .run();
  }
}

/**
 * Queries the scope leaderboard for a specific track configuration.
 * Joins scope_members with user_pbs so PBs automatically carry over across Guilds/DMs
 * without leaking usernames to scopes the user has never participated in.
 */
export async function query_scope_leaderboard(
  db,
  {scope_type, scope_id, track, difficulty, laps, reverse, limit = 50}
) {
  let rows_result = await db
    .prepare(
      `SELECT u.user_id, u.display_name, u.username, u.avatar,
              sm.guild_nick, sm.guild_avatar,
              p.run_id, p.kart, p.kart_color, p.time_ms, p.updated_at
       FROM scope_members sm
       INNER JOIN user_pbs p
         ON p.user_id = sm.user_id
        AND p.track = ?
        AND p.difficulty = ?
        AND p.laps = ?
        AND p.reverse = ?
       INNER JOIN users u
         ON u.user_id = sm.user_id
       WHERE sm.scope_type = ? AND sm.scope_id = ?
       ORDER BY p.time_ms ASC, p.updated_at ASC
       LIMIT ?`
    )
    .bind(track, difficulty, laps, reverse ? 1 : 0, scope_type, scope_id, limit)
    .all();

  let count_row = await db
    .prepare(
      `SELECT COUNT(*) AS total
       FROM scope_members sm
       INNER JOIN user_pbs p
         ON p.user_id = sm.user_id
        AND p.track = ?
        AND p.difficulty = ?
        AND p.laps = ?
        AND p.reverse = ?
       WHERE sm.scope_type = ? AND sm.scope_id = ?`
    )
    .bind(track, difficulty, laps, reverse ? 1 : 0, scope_type, scope_id)
    .first();

  let guild_id = scope_type === "guild" ? scope_id : null;
  let entries = (rows_result && rows_result.results ? rows_result.results : []).map((row, idx) => ({
    rank: idx + 1,
    run_id: row.run_id,
    user_id: row.user_id,
    display_name: row.guild_nick || row.display_name || row.username || "Player",
    avatar: row.avatar || null,
    guild_avatar: row.guild_avatar || null,
    guild_id,
    kart: row.kart,
    kart_color: typeof row.kart_color === "number" ? row.kart_color : 0,
    time_ms: Number(row.time_ms),
    updated_at: Number(row.updated_at),
  }));

  return {
    entries,
    total_players: Number(count_row && count_row.total ? count_row.total : entries.length),
  };
}

/**
 * Computes a short deterministic content hash for a challenge's Top-3 podium state.
 * Returns null if no entries exist yet.
 */
export async function compute_podium_hash(challenge, entries) {
  let top3 = Array.isArray(entries) ? entries.slice(0, 3) : [];
  if (top3.length === 0) return null;

  let canonical = JSON.stringify({
    v: 1,
    track: challenge.track,
    difficulty: challenge.difficulty,
    laps: challenge.laps,
    reverse: Boolean(challenge.reverse),
    entries: top3.map((e, idx) => ({
      rank: e.rank || idx + 1,
      user_id: String(e.user_id || ""),
      display_name: String(e.display_name || ""),
      avatar: e.avatar || null,
      guild_avatar: e.guild_avatar || null,
      guild_id: e.guild_id || null,
      kart: String(e.kart || ""),
      time_ms: Number(e.time_ms) || 0,
    })),
  });

  let digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  let bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < 12; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Ensures the Top-3 podium PNG exists in R2 (rendering via the Workers VPC
 * `PODIUM_RENDERER` service on cache miss) and returns its public Worker URL.
 * Always fail-open: returns null if rendering is unconfigured or fails.
 */
export async function ensure_podium_image({env, challenge, leaderboard, public_origin}) {
  if (!env || !env.REPLAYS || !public_origin) return null;
  let entries = (leaderboard && leaderboard.entries) || [];
  if (entries.length === 0) return null;

  let hash = await compute_podium_hash(challenge, entries);
  if (!hash) return null;

  let r2_key = `podiums/${hash}.png`;
  let public_url = `${public_origin}/api/timetrials/podium/${hash}.png`;

  try {
    let existing = await env.REPLAYS.head(r2_key);
    if (existing) return public_url;
  }
  catch {
    // Proceed to render attempt
  }

  if (!env.PODIUM_RENDERER || typeof env.PODIUM_RENDERER.fetch !== "function") {
    return null;
  }

  let track_info = get_track(challenge.track);
  let payload = {
    track: challenge.track,
    track_name: track_info ? track_info.name : challenge.track,
    difficulty: get_difficulty_name(challenge.difficulty),
    laps: challenge.laps,
    reverse: Boolean(challenge.reverse),
    entries: entries.slice(0, 3).map((e, idx) => ({
      rank: e.rank || idx + 1,
      user_id: e.user_id,
      guild_id: e.guild_id || null,
      display_name: e.display_name,
      avatar: e.avatar || null,
      guild_avatar: e.guild_avatar || null,
      kart: e.kart,
      time_ms: e.time_ms,
    })),
  };

  let headers = {"Content-Type": "application/json"};
  if (env.PODIUM_RENDER_SECRET) {
    headers.Authorization = `Bearer ${env.PODIUM_RENDER_SECRET}`;
  }

  try {
    let resp = await env.PODIUM_RENDERER.fetch("http://podium-renderer:3000/render", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      console.warn(`Podium render returned HTTP ${resp.status} for ${hash}`);
      return null;
    }
    let png_bytes = await resp.arrayBuffer();
    if (!png_bytes || png_bytes.byteLength === 0) return null;

    await env.REPLAYS.put(r2_key, png_bytes, {
      httpMetadata: {
        contentType: "image/png",
        cacheControl: "public, max-age=31536000, immutable",
      },
    });
    return public_url;
  }
  catch (err) {
    console.warn("Podium render failed (fail-open):", err && err.message ? err.message : err);
    return null;
  }
}

/**
 * Builds the Discord embed for a Time Trial challenge message.
 */
export function build_challenge_embed(challenge, {entries, total_players}, options = {}) {
  let track_info = get_track(challenge.track);
  let track_name = track_info ? track_info.name : challenge.track;
  let diff_name = get_difficulty_name(challenge.difficulty);
  let dir_label = challenge.reverse ? "Reverse" : "Normal";

  let top = entries.slice(0, EMBED_TOP_N);
  let description;
  if (top.length === 0) {
    description = "No times recorded yet! Click **Play Time Trial** below to set the first record.";
  }
  else {
    let lines = top.map((e) => {
      let prefix = e.rank <= 3 ? MEDALS[e.rank - 1] : `\`#${e.rank}\``;
      return `${prefix} **${e.display_name}** — \`${format_time_ms(e.time_ms)}\` (${format_kart_name(e.kart)})`;
    });
    description = lines.join("\n");
  }

  let embed = {
    title: `🏁 Time Trial — ${track_name}`,
    color: 0x3b82f6,
    description,
    fields: [
      {name: "Laps", value: String(challenge.laps), inline: true},
      {name: "Difficulty", value: diff_name, inline: true},
      {name: "Direction", value: dir_label, inline: true},
    ],
    footer: {
      text: `${total_players} ${total_players === 1 ? "racer" : "racers"} • Race against up to ${MAX_GHOSTS_RETURNED} ghosts`,
    },
    timestamp: new Date().toISOString(),
  };

  if (options && options.podium_image_url) {
    embed.image = {url: options.podium_image_url};
  }

  return embed;
}

export function build_challenge_components(challenge_id) {
  return [
    {
      type: 1, // Action Row
      components: [
        {
          type: 2, // Button
          style: 1, // Primary (Blurple)
          label: "Play Time Trial",
          emoji: {name: "🏁"},
          custom_id: `tt:play:${challenge_id}`,
        },
      ],
    },
  ];
}

async function edit_message_via_webhook({app_id, interaction_token, message_id, payload, fetch_impl}) {
  let target = message_id || "@original";
  let url = `${DISCORD_API_BASE}/webhooks/${encodeURIComponent(app_id)}/${encodeURIComponent(interaction_token)}/messages/${encodeURIComponent(target)}`;
  let resp = await fetch_impl(url, {
    method: "PATCH",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(payload),
  });
  return resp.ok;
}

async function edit_message_via_bot({bot_token, channel_id, message_id, payload, fetch_impl}) {
  if (!bot_token || !channel_id || !message_id) return false;
  let url = `${DISCORD_API_BASE}/channels/${encodeURIComponent(channel_id)}/messages/${encodeURIComponent(message_id)}`;
  let resp = await fetch_impl(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bot ${bot_token}`,
    },
    body: JSON.stringify(payload),
  });
  return resp.ok;
}

async function send_followup_via_webhook({app_id, interaction_token, payload, fetch_impl}) {
  let url = `${DISCORD_API_BASE}/webhooks/${encodeURIComponent(app_id)}/${encodeURIComponent(interaction_token)}`;
  let resp = await fetch_impl(url, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(payload),
  });
  return resp.ok;
}

async function send_message_via_bot({bot_token, channel_id, payload, fetch_impl}) {
  if (!bot_token || !channel_id) return false;
  let url = `${DISCORD_API_BASE}/channels/${encodeURIComponent(channel_id)}/messages`;
  let resp = await fetch_impl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bot ${bot_token}`,
    },
    body: JSON.stringify(payload),
  });
  return resp.ok;
}

/**
 * Refreshes the clicked challenge embed (and the most recent embed for the same
 * scope + track config if distinct), using the fresh button interaction_token
 * first (works in DMs and User-Installed guilds) and falling back to Bot token.
 */
async function refresh_challenge_embeds({
  env,
  db,
  challenge,
  launch_row,
  leaderboard,
  public_origin,
  now,
  fetch_impl,
}) {
  let app_id = env.DISCORD_CLIENT_ID;
  let bot_token = env.DISCORD_BOT_TOKEN;
  let podium_image_url = await ensure_podium_image({
    env,
    challenge,
    leaderboard,
    public_origin,
  });
  let embed = build_challenge_embed(challenge, leaderboard, {podium_image_url});

  let refreshed_message_ids = new Set();

  // 1. Refresh the clicked challenge's embed
  let clicked_payload = {
    embeds: [embed],
    components: build_challenge_components(challenge.challenge_id),
  };
  let clicked_msg_id = (launch_row && launch_row.message_id) || challenge.message_id;
  let updated = false;

  if (
    app_id &&
    launch_row &&
    launch_row.interaction_token &&
    launch_row.token_expires_at > now
  ) {
    try {
      updated = await edit_message_via_webhook({
        app_id,
        interaction_token: launch_row.interaction_token,
        message_id: clicked_msg_id,
        payload: clicked_payload,
        fetch_impl,
      });
    }
    catch {
      updated = false;
    }
  }
  if (!updated && bot_token && clicked_msg_id && challenge.scope_type === "guild") {
    try {
      updated = await edit_message_via_bot({
        bot_token,
        channel_id: challenge.channel_id,
        message_id: clicked_msg_id,
        payload: clicked_payload,
        fetch_impl,
      });
    }
    catch {
      updated = false;
    }
  }
  if (clicked_msg_id) refreshed_message_ids.add(clicked_msg_id);

  // 2. Also refresh the most recent embed for the same scope + config (if different)
  try {
    let recent = await db
      .prepare(
        `SELECT challenge_id, channel_id, message_id, interaction_token, token_expires_at
         FROM challenges
         WHERE scope_type = ? AND scope_id = ?
           AND track = ? AND difficulty = ? AND laps = ? AND reverse = ?
           AND challenge_id != ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .bind(
        challenge.scope_type,
        challenge.scope_id,
        challenge.track,
        challenge.difficulty,
        challenge.laps,
        challenge.reverse ? 1 : 0,
        challenge.challenge_id
      )
      .first();

    if (recent && recent.message_id && !refreshed_message_ids.has(recent.message_id)) {
      let recent_payload = {
        embeds: [embed],
        components: build_challenge_components(recent.challenge_id),
      };
      let recent_ok = false;
      if (app_id && recent.interaction_token && recent.token_expires_at > now) {
        recent_ok = await edit_message_via_webhook({
          app_id,
          interaction_token: recent.interaction_token,
          message_id: recent.message_id,
          payload: recent_payload,
          fetch_impl,
        });
      }
      if (!recent_ok && bot_token && challenge.scope_type === "guild") {
        await edit_message_via_bot({
          bot_token,
          channel_id: recent.channel_id,
          message_id: recent.message_id,
          payload: recent_payload,
          fetch_impl,
        });
      }
    }
  }
  catch {
    // Best-effort secondary embed refresh
  }
}

/**
 * Announces a new #1 record in chat (fail-open).
 * Uses the button interaction_token (within 15 min & 5-followup cap) so it works
 * in DMs and User-Installed guilds, falling back to Bot token in guilds.
 */
async function announce_new_first_place({
  env,
  db,
  challenge,
  launch_row,
  user_id,
  display_name,
  kart,
  time_ms,
  previous_first_ms,
  now,
  fetch_impl,
}) {
  let track_info = get_track(challenge.track);
  let track_name = track_info ? track_info.name : challenge.track;
  let delta_text = "";
  if (typeof previous_first_ms === "number" && previous_first_ms > time_ms) {
    let diff_s = ((previous_first_ms - time_ms) / 1000).toFixed(3);
    delta_text = ` (−${diff_s}s)`;
  }

  let content = `🏆 **New 1st Place on ${track_name}!** <@${user_id}> set **${format_time_ms(time_ms)}**${delta_text} with **${format_kart_name(kart)}**!`;
  let payload = {
    content,
    allowed_mentions: {users: []},
  };

  let app_id = env.DISCORD_CLIENT_ID;
  let sent = false;

  if (
    app_id &&
    launch_row &&
    launch_row.interaction_token &&
    launch_row.token_expires_at > now &&
    (launch_row.followups_used || 0) < MAX_INTERACTION_FOLLOWUPS
  ) {
    try {
      sent = await send_followup_via_webhook({
        app_id,
        interaction_token: launch_row.interaction_token,
        payload,
        fetch_impl,
      });
      if (sent) {
        await db
          .prepare(
            `UPDATE pending_launches
             SET followups_used = followups_used + 1
             WHERE user_id = ? AND channel_id = ?`
          )
          .bind(user_id, challenge.channel_id)
          .run();
      }
    }
    catch {
      sent = false;
    }
  }

  if (!sent && env.DISCORD_BOT_TOKEN && challenge.scope_type === "guild") {
    try {
      await send_message_via_bot({
        bot_token: env.DISCORD_BOT_TOKEN,
        channel_id: challenge.channel_id,
        payload,
        fetch_impl,
      });
    }
    catch {
      // Fail-open if bot is not installed in this guild
    }
  }
}

async function handleGetChallenge({request, env, challenge_id}) {
  if (!env.TIME_TRIALS_DB) {
    return json_response({error: "TIME_TRIALS_DB is not configured."}, 503);
  }
  let auth = await authenticate_session(request, env);
  if (auth.error) return auth.error;
  let {claims} = auth;

  let challenge = await env.TIME_TRIALS_DB
    .prepare("SELECT * FROM challenges WHERE challenge_id = ?")
    .bind(challenge_id)
    .first();

  if (!challenge) {
    return json_response({error: "Challenge not found."}, 404);
  }
  if (challenge.scope_type !== claims.scope_type || challenge.scope_id !== claims.scope_id) {
    return json_response({error: "Forbidden: challenge belongs to another Discord context."}, 403);
  }

  let now = Date.now();
  await ensure_scope_member(env.TIME_TRIALS_DB, {
    scope_type: claims.scope_type,
    scope_id: claims.scope_id,
    user_id: claims.sub,
  }, now);

  let lb = await query_scope_leaderboard(env.TIME_TRIALS_DB, {
    scope_type: challenge.scope_type,
    scope_id: challenge.scope_id,
    track: challenge.track,
    difficulty: challenge.difficulty,
    laps: challenge.laps,
    reverse: Boolean(challenge.reverse),
    limit: MAX_GHOSTS_RETURNED,
  });

  // Always include the requesting player's own PB in the ghost list even if outside top 20.
  let ghosts = [...lb.entries];
  let caller_in_top = ghosts.some((e) => e.user_id === claims.sub);
  if (!caller_in_top) {
    let my_pb = await env.TIME_TRIALS_DB
      .prepare(
        `SELECT u.user_id, u.display_name, u.username, u.avatar,
                sm.guild_nick, sm.guild_avatar,
                p.run_id, p.kart, p.kart_color, p.time_ms, p.updated_at
         FROM user_pbs p
         INNER JOIN users u ON u.user_id = p.user_id
         LEFT JOIN scope_members sm
           ON sm.user_id = p.user_id
          AND sm.scope_type = ?
          AND sm.scope_id = ?
         WHERE p.user_id = ? AND p.track = ? AND p.difficulty = ? AND p.laps = ? AND p.reverse = ?`
      )
      .bind(
        challenge.scope_type,
        challenge.scope_id,
        claims.sub,
        challenge.track,
        challenge.difficulty,
        challenge.laps,
        challenge.reverse ? 1 : 0
      )
      .first();

    if (my_pb) {
      ghosts.push({
        rank: 0,
        run_id: my_pb.run_id,
        user_id: my_pb.user_id,
        display_name: my_pb.guild_nick || my_pb.display_name || my_pb.username || "Player",
        avatar: my_pb.avatar || null,
        guild_avatar: my_pb.guild_avatar || null,
        guild_id: challenge.scope_type === "guild" ? challenge.scope_id : null,
        kart: my_pb.kart,
        kart_color: typeof my_pb.kart_color === "number" ? my_pb.kart_color : 0,
        time_ms: Number(my_pb.time_ms),
        updated_at: Number(my_pb.updated_at),
      });
    }
  }

  let track_info = get_track(challenge.track);
  let me_row = await env.TIME_TRIALS_DB
    .prepare(
      `SELECT u.user_id, u.display_name, u.username, u.avatar,
              sm.guild_nick, sm.guild_avatar
       FROM users u
       LEFT JOIN scope_members sm
         ON sm.user_id = u.user_id
        AND sm.scope_type = ?
        AND sm.scope_id = ?
       WHERE u.user_id = ?`
    )
    .bind(challenge.scope_type, challenge.scope_id, claims.sub)
    .first();

  let scope_guild_id = challenge.scope_type === "guild" ? challenge.scope_id : null;
  let me = {
    user_id: claims.sub,
    display_name: (me_row && (me_row.guild_nick || me_row.display_name || me_row.username)) ||
      claims.display_name || claims.username || "Player",
    avatar: (me_row && me_row.avatar) || null,
    guild_avatar: (me_row && me_row.guild_avatar) || null,
    guild_id: scope_guild_id,
  };

  return json_response({
    challenge: {
      challenge_id: challenge.challenge_id,
      track: challenge.track,
      track_name: track_info ? track_info.name : challenge.track,
      difficulty: challenge.difficulty,
      laps: challenge.laps,
      reverse: Boolean(challenge.reverse),
    },
    me,
    total_players: lb.total_players,
    leaderboard: lb.entries,
    ghosts: ghosts.map((g) => ({
      run_id: g.run_id,
      user_id: g.user_id,
      is_self: g.user_id === claims.sub,
      display_name: g.display_name,
      avatar: g.avatar || null,
      guild_avatar: g.guild_avatar || null,
      guild_id: g.guild_id || null,
      kart: g.kart,
      time_ms: g.time_ms,
      url: `/api/timetrials/runs/${encodeURIComponent(g.run_id)}/replay`,
    })),
  });
}

async function handleGetReplay({request, env, run_id}) {
  if (!env.TIME_TRIALS_DB || !env.REPLAYS) {
    return json_response({error: "Time Trials storage is not configured."}, 503);
  }
  let auth = await authenticate_session(request, env);
  if (auth.error) return auth.error;
  let {claims} = auth;

  // Verify the replay belongs to a member of the caller's verified scope (privacy boundary).
  let row = await env.TIME_TRIALS_DB
    .prepare(
      `SELECT p.r2_key, p.user_id
       FROM user_pbs p
       INNER JOIN scope_members sm
         ON sm.user_id = p.user_id
        AND sm.scope_type = ?
        AND sm.scope_id = ?
       WHERE p.run_id = ?`
    )
    .bind(claims.scope_type, claims.scope_id, run_id)
    .first();

  if (!row) {
    return json_response({error: "Replay not found."}, 404);
  }

  let obj = await env.REPLAYS.get(row.r2_key);
  if (!obj) {
    return json_response({error: "Replay blob missing."}, 404);
  }

  return new Response(obj.body, {
    status: 200,
    headers: {
      // Serve raw gzipped bytes without Content-Encoding so neither Cloudflare's
      // edge nor Discord's proxy re-compresses or strips the encoding; the
      // browser client decompresses explicitly via vendored pako.ungzip.
      "Content-Type": "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

async function handleSubmitRun({request, env, ctx, fetch_impl = fetch}) {
  if (!env.TIME_TRIALS_DB || !env.REPLAYS) {
    return json_response({error: "Time Trials storage is not configured."}, 503);
  }
  let auth = await authenticate_session(request, env);
  if (auth.error) return auth.error;
  let {claims} = auth;

  let form;
  try {
    form = await request.formData();
  }
  catch {
    return json_response({error: "Expected multipart/form-data."}, 400);
  }

  let metadata_raw = form.get("metadata");
  let replay_file = form.get("replay");
  if (typeof metadata_raw !== "string") {
    return json_response({error: "Missing metadata JSON field."}, 400);
  }
  if (!replay_file || typeof replay_file === "string" || typeof replay_file.arrayBuffer !== "function") {
    return json_response({error: "Missing replay file field."}, 400);
  }
  if (replay_file.size <= 0 || replay_file.size > MAX_REPLAY_BYTES) {
    return json_response({error: "Replay file size out of allowed bounds."}, 413);
  }

  let meta;
  try {
    meta = JSON.parse(metadata_raw);
  }
  catch {
    return json_response({error: "Invalid metadata JSON."}, 400);
  }

  let challenge_id = String(meta.challenge_id || "").trim();
  let kart = String(meta.kart || "").trim().slice(0, 64);
  let kart_color = Number.isFinite(Number(meta.kart_color)) ? Number(meta.kart_color) : 0;
  let time_ms = Math.round(Number(meta.time_ms));
  let replay_version = Number.isInteger(Number(meta.replay_version)) ? Number(meta.replay_version) : 4;

  if (!challenge_id || !kart || !Number.isFinite(time_ms) || time_ms <= 0 || time_ms > 3600000) {
    return json_response({error: "Invalid run metadata."}, 400);
  }

  let challenge = await env.TIME_TRIALS_DB
    .prepare("SELECT * FROM challenges WHERE challenge_id = ?")
    .bind(challenge_id)
    .first();

  if (!challenge) {
    return json_response({error: "Challenge not found."}, 404);
  }
  if (challenge.scope_type !== claims.scope_type || challenge.scope_id !== claims.scope_id) {
    return json_response({error: "Forbidden: challenge belongs to another Discord context."}, 403);
  }

  let now = Date.now();
  await ensure_scope_member(env.TIME_TRIALS_DB, {
    scope_type: challenge.scope_type,
    scope_id: challenge.scope_id,
    user_id: claims.sub,
  }, now);

  // Check current #1 in this scope BEFORE updating so we know if #1 changed.
  let prev_top = await query_scope_leaderboard(env.TIME_TRIALS_DB, {
    scope_type: challenge.scope_type,
    scope_id: challenge.scope_id,
    track: challenge.track,
    difficulty: challenge.difficulty,
    laps: challenge.laps,
    reverse: Boolean(challenge.reverse),
    limit: 1,
  });
  let prev_first = prev_top.entries[0] || null;

  // Check user's existing canonical PB for this track configuration.
  let existing_pb = await env.TIME_TRIALS_DB
    .prepare(
      `SELECT run_id, time_ms, r2_key
       FROM user_pbs
       WHERE user_id = ? AND track = ? AND difficulty = ? AND laps = ? AND reverse = ?`
    )
    .bind(claims.sub, challenge.track, challenge.difficulty, challenge.laps, challenge.reverse ? 1 : 0)
    .first();

  let previous_pb_ms = existing_pb ? Number(existing_pb.time_ms) : null;
  let is_new_pb = previous_pb_ms === null || time_ms < previous_pb_ms;
  let run_id = existing_pb ? existing_pb.run_id : null;

  if (is_new_pb) {
    run_id = crypto.randomUUID();
    let r2_key = `replays/${challenge.track}/${run_id}.replay.gz`;
    let replay_bytes = await replay_file.arrayBuffer();

    await env.REPLAYS.put(r2_key, replay_bytes, {
      httpMetadata: {
        contentType: "text/plain; charset=utf-8",
        contentEncoding: "gzip",
      },
      customMetadata: {
        user_id: claims.sub,
        track: challenge.track,
        time_ms: String(time_ms),
      },
    });

    await env.TIME_TRIALS_DB
      .prepare(
        `INSERT INTO user_pbs (
           user_id, track, difficulty, laps, reverse,
           run_id, kart, kart_color, time_ms, r2_key, replay_version, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, track, difficulty, laps, reverse) DO UPDATE SET
           run_id = excluded.run_id,
           kart = excluded.kart,
           kart_color = excluded.kart_color,
           time_ms = excluded.time_ms,
           r2_key = excluded.r2_key,
           replay_version = excluded.replay_version,
           updated_at = excluded.updated_at`
      )
      .bind(
        claims.sub,
        challenge.track,
        challenge.difficulty,
        challenge.laps,
        challenge.reverse ? 1 : 0,
        run_id,
        kart,
        kart_color,
        time_ms,
        r2_key,
        replay_version,
        now
      )
      .run();

    // Clean up superseded R2 object in the background.
    if (existing_pb && existing_pb.r2_key) {
      let cleanup = env.REPLAYS.delete(existing_pb.r2_key).catch(() => {});
      if (ctx && typeof ctx.waitUntil === "function") {
        ctx.waitUntil(cleanup);
      }
      else {
        await cleanup;
      }
    }
  }

  let updated_lb = await query_scope_leaderboard(env.TIME_TRIALS_DB, {
    scope_type: challenge.scope_type,
    scope_id: challenge.scope_id,
    track: challenge.track,
    difficulty: challenge.difficulty,
    laps: challenge.laps,
    reverse: Boolean(challenge.reverse),
    limit: MAX_GHOSTS_RETURNED,
  });

  let my_entry = updated_lb.entries.find((e) => e.user_id === claims.sub) || null;
  let new_first = updated_lb.entries[0] || null;
  let is_new_first = Boolean(
    is_new_pb &&
    new_first &&
    new_first.user_id === claims.sub &&
    (!prev_first || time_ms < prev_first.time_ms)
  );

  // Refresh Discord embed(s) and announce new #1 if applicable.
  if (is_new_pb) {
    let launch_row = await env.TIME_TRIALS_DB
      .prepare(
        `SELECT message_id, interaction_token, token_expires_at, followups_used
         FROM pending_launches
         WHERE user_id = ? AND channel_id = ?`
      )
      .bind(claims.sub, challenge.channel_id)
      .first();

    let public_origin = new URL(request.url).origin;
    let discord_updates = (async () => {
      await refresh_challenge_embeds({
        env,
        db: env.TIME_TRIALS_DB,
        challenge,
        launch_row,
        leaderboard: updated_lb,
        public_origin,
        now,
        fetch_impl,
      });
      if (is_new_first) {
        await announce_new_first_place({
          env,
          db: env.TIME_TRIALS_DB,
          challenge,
          launch_row,
          user_id: claims.sub,
          display_name: (my_entry && my_entry.display_name) || claims.display_name || claims.username || "Player",
          kart,
          time_ms,
          previous_first_ms: prev_first ? prev_first.time_ms : null,
          now,
          fetch_impl,
        });
      }
    })();

    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(discord_updates);
    }
    else {
      await discord_updates;
    }
  }

  return json_response({
    run_id,
    is_new_pb,
    previous_pb_ms,
    is_new_first,
    rank: my_entry ? my_entry.rank : null,
    total_players: updated_lb.total_players,
    leaderboard: updated_lb.entries,
  });
}

async function handleGetScopeProfiles({request, env}) {
  if (!env.TIME_TRIALS_DB) {
    return json_response({error: "TIME_TRIALS_DB is not configured."}, 503);
  }
  let auth = await authenticate_session(request, env);
  if (auth.error) return auth.error;
  let {claims} = auth;

  let url = new URL(request.url);
  let raw_ids = (url.searchParams.get("ids") || "").trim();
  let ids = raw_ids
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s))
    .slice(0, 50);

  if (ids.length === 0) {
    return json_response({
      scope_type: claims.scope_type,
      scope_id: claims.scope_id,
      profiles: [],
    });
  }

  let placeholders = ids.map(() => "?").join(", ");
  let rows_result = await env.TIME_TRIALS_DB
    .prepare(
      `SELECT u.user_id, u.display_name, u.username, u.avatar,
              sm.guild_nick, sm.guild_avatar
       FROM scope_members sm
       INNER JOIN users u ON u.user_id = sm.user_id
       WHERE sm.scope_type = ? AND sm.scope_id = ?
         AND sm.user_id IN (${placeholders})`
    )
    .bind(claims.scope_type, claims.scope_id, ...ids)
    .all();

  let guild_id = claims.scope_type === "guild" ? claims.scope_id : null;
  let profiles = (rows_result && rows_result.results ? rows_result.results : []).map((row) => ({
    user_id: row.user_id,
    display_name: row.guild_nick || row.display_name || row.username || "Player",
    guild_nick: row.guild_nick || null,
    avatar: row.avatar || null,
    guild_avatar: row.guild_avatar || null,
    guild_id,
  }));

  return json_response({
    scope_type: claims.scope_type,
    scope_id: claims.scope_id,
    profiles,
  });
}

async function handleGetPodium({env, hash}) {
  if (!env.REPLAYS) {
    return new Response("Not Found", {status: 404});
  }
  let obj = await env.REPLAYS.get(`podiums/${hash}.png`);
  if (!obj) {
    return new Response("Not Found", {status: 404});
  }
  return new Response(obj.body, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

export async function handleTimeTrials({request, env, ctx, fetch_impl = fetch}) {
  let url = new URL(request.url);
  let path = url.pathname;

  let podium_match = path.match(/^\/api\/timetrials\/podium\/([a-f0-9]{16,64})\.png$/);
  if (podium_match) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", {status: 405});
    }
    return handleGetPodium({env, hash: podium_match[1]});
  }

  if (path === "/api/timetrials/scope-profiles") {
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", {status: 405});
    }
    return handleGetScopeProfiles({request, env});
  }

  let challenge_match = path.match(/^\/api\/timetrials\/challenges\/([A-Za-z0-9_-]+)$/);
  if (challenge_match) {
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", {status: 405});
    }
    return handleGetChallenge({request, env, challenge_id: challenge_match[1]});
  }

  let replay_match = path.match(/^\/api\/timetrials\/runs\/([A-Za-z0-9_-]+)\/replay$/);
  if (replay_match) {
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", {status: 405});
    }
    return handleGetReplay({request, env, run_id: replay_match[1]});
  }

  if (path === "/api/timetrials/runs") {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {status: 405});
    }
    return handleSubmitRun({request, env, ctx, fetch_impl});
  }

  return json_response({error: "Not Found"}, 404);
}
