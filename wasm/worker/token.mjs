// Discord OAuth2 authorization-code -> access-token exchange, performed
// server-side inside the Worker so the client secret never reaches the browser.
//
// When `instance_id` is supplied (Discord Activity launch) and `DISCORD_BOT_TOKEN`
// + `JWT_SECRET` are configured, this handler also verifies the user's live
// Activity instance via `GET /applications/{app_id}/activity-instances/{instance_id}`
// (no extra `guilds` OAuth scope required), mints a standard HS256 JWT session
// token, and checks for a pending Time Trial challenge launch from a chat embed.
//
// Worker secrets (configured via `wrangler secret put ...`):
//   DISCORD_CLIENT_ID      the Discord application (client) id.
//   DISCORD_CLIENT_SECRET  the Discord application client secret.
//   DISCORD_BOT_TOKEN      Discord bot token (for /activity-instances/ verification).
//   JWT_SECRET             random >=32-char secret for signing HS256 session JWTs.

import { sign_jwt } from "./jwt.mjs";
import { get_track } from "./tracks.mjs";
import { upsert_user } from "./time-trials.mjs";

const DISCORD_API_BASE = "https://discord.com/api/v10";

function json_response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {"Content-Type": "application/json"},
  });
}

function is_valid_instance_id(instance_id) {
  return (
    typeof instance_id === "string" &&
    instance_id.length > 0 &&
    instance_id.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(instance_id)
  );
}

export async function handleTokenExchange({request, env, fetch_impl = fetch}) {
  let payload;
  try {
    payload = await request.json();
  }
  catch {
    return json_response({error: "Invalid JSON body."}, 400);
  }

  if (!payload.code) {
    return json_response({error: "Missing authorization code."}, 400);
  }
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) {
    return json_response({error: "Discord OAuth environment variables are not configured."}, 500);
  }

  let body = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    client_secret: env.DISCORD_CLIENT_SECRET,
    grant_type: "authorization_code",
    code: payload.code,
  });

  let response = await fetch_impl("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: {"Content-Type": "application/x-www-form-urlencoded"},
    body,
  });

  let result;
  try {
    result = await response.json();
  }
  catch {
    return json_response({error: "Discord returned an invalid response."}, 502);
  }

  if (!response.ok || !result.access_token) {
    return json_response({
      error: result.error_description || result.error || "Discord token exchange failed.",
    }, response.status || 502);
  }

  let out = {access_token: result.access_token};

  // Optional Time Trial session verification & pending-launch handoff.
  // Fail-open on regular launches if bot/JWT secrets are not configured yet.
  let instance_id = payload.instance_id;
  if (is_valid_instance_id(instance_id) && env.DISCORD_BOT_TOKEN && env.JWT_SECRET) {
    try {
      let [user_resp, inst_resp] = await Promise.all([
        fetch_impl(`${DISCORD_API_BASE}/users/@me`, {
          headers: {Authorization: `Bearer ${result.access_token}`},
        }),
        fetch_impl(
          `${DISCORD_API_BASE}/applications/${encodeURIComponent(env.DISCORD_CLIENT_ID)}/activity-instances/${encodeURIComponent(instance_id)}`,
          {headers: {Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`}}
        ),
      ]);

      if (user_resp.ok && inst_resp.ok) {
        let user = await user_resp.json();
        let inst = await inst_resp.json();
        let users = Array.isArray(inst.users) ? inst.users : [];
        let location = inst.location || {};

        if (user && user.id && users.includes(user.id) && location.channel_id) {
          let scope_type = location.guild_id ? "guild" : "dm";
          let scope_id = String(location.guild_id || location.channel_id);
          let channel_id = String(location.channel_id);
          let display_name = String(user.global_name || user.username || "Player");

          if (env.TIME_TRIALS_DB) {
            await upsert_user(env.TIME_TRIALS_DB, {
              user_id: String(user.id),
              username: String(user.username || "Player"),
              display_name,
            });
          }

          out.session_token = await sign_jwt(
            {
              iss: "supertuxkart-wasm",
              sub: String(user.id),
              username: String(user.username || "Player"),
              display_name,
              scope_type,
              scope_id,
              channel_id,
              instance_id,
            },
            env.JWT_SECRET,
            {ttl_seconds: 3600}
          );

          // Check for a pending Time Trial launch triggered by clicking "Play Time Trial".
          if (env.TIME_TRIALS_DB) {
            let now = Date.now();
            let pending = await env.TIME_TRIALS_DB
              .prepare(
                `SELECT p.challenge_id, c.track, c.difficulty, c.laps, c.reverse,
                        c.scope_type, c.scope_id
                 FROM pending_launches p
                 INNER JOIN challenges c ON c.challenge_id = p.challenge_id
                 WHERE p.user_id = ? AND p.channel_id = ?
                   AND p.consumed = 0 AND p.expires_at > ?`
              )
              .bind(String(user.id), channel_id, now)
              .first();

            if (pending && pending.scope_type === scope_type && pending.scope_id === scope_id) {
              await env.TIME_TRIALS_DB
                .prepare(
                  `UPDATE pending_launches SET consumed = 1
                   WHERE user_id = ? AND channel_id = ?`
                )
                .bind(String(user.id), channel_id)
                .run();

              let track_info = get_track(pending.track);
              out.pending_time_trial = {
                challenge_id: pending.challenge_id,
                track: pending.track,
                track_name: track_info ? track_info.name : pending.track,
                difficulty: Number(pending.difficulty),
                laps: Number(pending.laps),
                reverse: Boolean(pending.reverse),
              };
            }
          }
        }
      }
    }
    catch (err) {
      console.warn("Time Trial session verification skipped:", err && err.message ? err.message : err);
    }
  }

  return json_response(out);
}
