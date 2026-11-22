// Discord HTTP Interactions Endpoint handler (POST /api/interactions).
//
// Handles:
//   - Type 1: PING (Discord endpoint verification)
//   - Type 4: APPLICATION_COMMAND_AUTOCOMPLETE (/timetrial track autocomplete)
//   - Type 2: APPLICATION_COMMAND (/timetrial -> creates challenge embed + Play button)
//   - Type 3: MESSAGE_COMPONENT (tt:play:<challenge_id> -> stores pending launch, returns LAUNCH_ACTIVITY)

import { verify_discord_signature } from "./discord-verify.mjs";
import {
  autocomplete_tracks,
  get_track,
  DEFAULT_LAPS,
  MIN_LAPS,
  MAX_LAPS,
  DEFAULT_DIFFICULTY,
} from "./tracks.mjs";
import {
  upsert_user,
  ensure_scope_member,
  query_scope_leaderboard,
  build_challenge_embed,
  build_challenge_components,
} from "./time-trials.mjs";

const INTERACTION_TYPE = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  APPLICATION_COMMAND_AUTOCOMPLETE: 4,
};

const RESPONSE_TYPE = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  APPLICATION_COMMAND_AUTOCOMPLETE_RESULT: 8,
  LAUNCH_ACTIVITY: 12,
};

const PENDING_LAUNCH_TTL_MS = 3 * 60 * 1000; // 3 minutes for Activity iframe boot
const INTERACTION_TOKEN_TTL_MS = 14 * 60 * 1000; // 14 min (Discord expires at 15 min)

function json_response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {"Content-Type": "application/json"},
  });
}

function get_interaction_user(interaction) {
  let u = (interaction.member && interaction.member.user) || interaction.user;
  if (!u || !u.id) return null;
  let nick = interaction.member && interaction.member.nick;
  let guild_avatar = interaction.member && interaction.member.avatar;
  return {
    user_id: String(u.id),
    username: String(u.username || "Player"),
    display_name: String(u.global_name || u.username || "Player"),
    avatar: u.avatar ? String(u.avatar) : null,
    guild_nick: nick ? String(nick) : null,
    guild_avatar: guild_avatar ? String(guild_avatar) : null,
  };
}

function get_interaction_scope(interaction) {
  let channel_id = interaction.channel_id || (interaction.channel && interaction.channel.id);
  if (!channel_id) return null;
  if (interaction.guild_id) {
    return {
      scope_type: "guild",
      scope_id: String(interaction.guild_id),
      channel_id: String(channel_id),
    };
  }
  return {
    scope_type: "dm",
    scope_id: String(channel_id),
    channel_id: String(channel_id),
  };
}

function get_option(options, name) {
  if (!Array.isArray(options)) return undefined;
  let opt = options.find((o) => o && o.name === name);
  return opt ? opt.value : undefined;
}

export async function handleInteractions({request, env}) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {status: 405});
  }

  if (!env.DISCORD_PUBLIC_KEY) {
    return json_response({error: "DISCORD_PUBLIC_KEY is not configured."}, 500);
  }

  let raw_body = await request.text();
  let signature_hex = request.headers.get("X-Signature-Ed25519") || "";
  let timestamp = request.headers.get("X-Signature-Timestamp") || "";

  let verified = await verify_discord_signature({
    public_key_hex: env.DISCORD_PUBLIC_KEY,
    signature_hex,
    timestamp,
    raw_body,
  });
  if (!verified) {
    return new Response("Invalid request signature", {status: 401});
  }

  let interaction;
  try {
    interaction = JSON.parse(raw_body);
  }
  catch {
    return json_response({error: "Invalid JSON payload."}, 400);
  }

  // 1. PING
  if (interaction.type === INTERACTION_TYPE.PING) {
    return json_response({type: RESPONSE_TYPE.PONG});
  }

  // 2. Autocomplete for /timetrial track
  if (interaction.type === INTERACTION_TYPE.APPLICATION_COMMAND_AUTOCOMPLETE) {
    let data = interaction.data || {};
    if (data.name === "timetrial") {
      let focused = Array.isArray(data.options)
        ? data.options.find((o) => o && o.focused)
        : null;
      let query = focused && focused.name === "track" ? focused.value : "";
      return json_response({
        type: RESPONSE_TYPE.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
        data: {choices: autocomplete_tracks(query)},
      });
    }
    return json_response({
      type: RESPONSE_TYPE.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
      data: {choices: []},
    });
  }

  // 3. Slash command: /timetrial
  if (interaction.type === INTERACTION_TYPE.APPLICATION_COMMAND) {
    let data = interaction.data || {};
    if (data.name !== "timetrial") {
      return json_response({
        type: RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {content: "Unknown command.", flags: 64},
      });
    }

    if (!env.TIME_TRIALS_DB) {
      return json_response({
        type: RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {content: "Time Trials database is not configured yet.", flags: 64},
      });
    }

    let user = get_interaction_user(interaction);
    let scope = get_interaction_scope(interaction);
    if (!user || !scope) {
      return json_response({
        type: RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {content: "Could not determine Discord user or channel context.", flags: 64},
      });
    }

    let track_id = get_option(data.options, "track");
    let track = get_track(track_id);
    if (!track) {
      return json_response({
        type: RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {content: `Unknown track \`${String(track_id || "")}\`. Please select a track from autocomplete.`, flags: 64},
      });
    }

    let raw_laps = get_option(data.options, "laps");
    let laps = raw_laps === undefined ? DEFAULT_LAPS : Math.max(MIN_LAPS, Math.min(MAX_LAPS, Math.round(Number(raw_laps))));
    let raw_diff = get_option(data.options, "difficulty");
    let difficulty = raw_diff === undefined ? DEFAULT_DIFFICULTY : Math.max(0, Math.min(3, Math.round(Number(raw_diff))));
    let reverse = Boolean(get_option(data.options, "reverse"));

    let now = Date.now();
    let challenge_id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);

    await upsert_user(env.TIME_TRIALS_DB, user, now);
    await ensure_scope_member(env.TIME_TRIALS_DB, {
      scope_type: scope.scope_type,
      scope_id: scope.scope_id,
      user_id: user.user_id,
      guild_nick: user.guild_nick,
      guild_avatar: user.guild_avatar,
      update_guild_profile: scope.scope_type === "guild",
    }, now);

    let challenge = {
      challenge_id,
      scope_type: scope.scope_type,
      scope_id: scope.scope_id,
      channel_id: scope.channel_id,
      message_id: null,
      track: track.id,
      difficulty,
      laps,
      reverse: reverse ? 1 : 0,
      created_by: user.user_id,
      created_at: now,
      interaction_token: interaction.token || null,
      token_expires_at: interaction.token ? now + INTERACTION_TOKEN_TTL_MS : 0,
    };

    await env.TIME_TRIALS_DB
      .prepare(
        `INSERT INTO challenges (
           challenge_id, scope_type, scope_id, channel_id, message_id,
           track, difficulty, laps, reverse, created_by, created_at,
           interaction_token, token_expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        challenge.challenge_id,
        challenge.scope_type,
        challenge.scope_id,
        challenge.channel_id,
        challenge.message_id,
        challenge.track,
        challenge.difficulty,
        challenge.laps,
        challenge.reverse,
        challenge.created_by,
        challenge.created_at,
        challenge.interaction_token,
        challenge.token_expires_at
      )
      .run();

    let leaderboard = await query_scope_leaderboard(env.TIME_TRIALS_DB, {
      scope_type: scope.scope_type,
      scope_id: scope.scope_id,
      track: track.id,
      difficulty,
      laps,
      reverse,
      limit: 10,
    });

    return json_response({
      type: RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [build_challenge_embed(challenge, leaderboard)],
        components: build_challenge_components(challenge_id),
      },
    });
  }

  // 4. Button click: Play Time Trial -> LAUNCH_ACTIVITY (type 12)
  if (interaction.type === INTERACTION_TYPE.MESSAGE_COMPONENT) {
    let custom_id = String((interaction.data && interaction.data.custom_id) || "");
    if (!custom_id.startsWith("tt:play:")) {
      return json_response({
        type: RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {content: "Unknown button action.", flags: 64},
      });
    }

    let challenge_id = custom_id.slice("tt:play:".length).trim();
    let user = get_interaction_user(interaction);
    let scope = get_interaction_scope(interaction);
    let message_id = interaction.message && interaction.message.id ? String(interaction.message.id) : null;
    let interaction_token = String(interaction.token || "");

    if (env.TIME_TRIALS_DB && user && scope && challenge_id) {
      let now = Date.now();
      await upsert_user(env.TIME_TRIALS_DB, user, now);
      await ensure_scope_member(env.TIME_TRIALS_DB, {
        scope_type: scope.scope_type,
        scope_id: scope.scope_id,
        user_id: user.user_id,
        guild_nick: user.guild_nick,
        guild_avatar: user.guild_avatar,
        update_guild_profile: scope.scope_type === "guild",
      }, now);

      // Persist message_id and fresh interaction_token on the challenge so secondary refreshes work.
      if (message_id) {
        await env.TIME_TRIALS_DB
          .prepare(
            `UPDATE challenges
             SET message_id = COALESCE(message_id, ?),
                 interaction_token = ?,
                 token_expires_at = ?
             WHERE challenge_id = ?`
          )
          .bind(message_id, interaction_token, now + INTERACTION_TOKEN_TTL_MS, challenge_id)
          .run();
      }

      // Record pending launch handoff for (user_id, channel_id).
      await env.TIME_TRIALS_DB
        .prepare(
          `INSERT INTO pending_launches (
             user_id, channel_id, challenge_id, message_id,
             interaction_token, token_expires_at, followups_used, expires_at, consumed
           ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0)
           ON CONFLICT(user_id, channel_id) DO UPDATE SET
             challenge_id = excluded.challenge_id,
             message_id = excluded.message_id,
             interaction_token = excluded.interaction_token,
             token_expires_at = excluded.token_expires_at,
             followups_used = 0,
             expires_at = excluded.expires_at,
             consumed = 0`
        )
        .bind(
          user.user_id,
          scope.channel_id,
          challenge_id,
          message_id,
          interaction_token,
          now + INTERACTION_TOKEN_TTL_MS,
          now + PENDING_LAUNCH_TTL_MS
        )
        .run();
    }

    return json_response({type: RESPONSE_TYPE.LAUNCH_ACTIVITY});
  }

  return json_response({error: "Unsupported interaction type."}, 400);
}
