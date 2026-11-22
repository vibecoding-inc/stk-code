import test from "node:test";
import assert from "node:assert/strict";
import { handleInteractions } from "../../worker/interactions.mjs";
import { handleTokenExchange } from "../../worker/token.mjs";
import { handleTimeTrials } from "../../worker/time-trials.mjs";
import { sign_jwt } from "../../worker/jwt.mjs";
import { autocomplete_tracks } from "../../worker/tracks.mjs";

const TEST_JWT_SECRET = "time-trials-test-jwt-secret-0123456789";

function bytes_to_hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function generate_ed25519_keypair() {
  let pair = await crypto.subtle.generateKey({name: "Ed25519"}, true, ["sign", "verify"]);
  let raw_pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    privateKey: pair.privateKey,
    publicKeyHex: bytes_to_hex(raw_pub),
  };
}

async function make_signed_interaction_request(body_obj, {privateKey}) {
  let raw = JSON.stringify(body_obj);
  let timestamp = String(Math.floor(Date.now() / 1000));
  let sig = new Uint8Array(
    await crypto.subtle.sign("Ed25519", privateKey, new TextEncoder().encode(timestamp + raw))
  );
  return new Request("https://example.workers.dev/api/interactions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Signature-Ed25519": bytes_to_hex(sig),
      "X-Signature-Timestamp": timestamp,
    },
    body: raw,
  });
}

// Lightweight in-memory D1 mock supporting the exact SQL statements used by Time Trials.
function create_mock_db() {
  let users = new Map();
  let user_pbs = new Map(); // key: user_id|track|difficulty|laps|reverse
  let scope_members = new Set(); // key: scope_type|scope_id|user_id
  let challenges = new Map(); // key: challenge_id
  let pending_launches = new Map(); // key: user_id|channel_id

  function pb_key(user_id, track, difficulty, laps, reverse) {
    return `${user_id}|${track}|${difficulty}|${laps}|${reverse ? 1 : 0}`;
  }

  function query_lb(track, difficulty, laps, reverse, scope_type, scope_id, limit) {
    let rows = [];
    for (let pb of user_pbs.values()) {
      if (
        pb.track === track &&
        pb.difficulty === difficulty &&
        pb.laps === laps &&
        pb.reverse === (reverse ? 1 : 0) &&
        scope_members.has(`${scope_type}|${scope_id}|${pb.user_id}`)
      ) {
        let u = users.get(pb.user_id) || {username: "Player", display_name: "Player"};
        rows.push({
          user_id: pb.user_id,
          display_name: u.display_name,
          username: u.username,
          run_id: pb.run_id,
          kart: pb.kart,
          kart_color: pb.kart_color,
          time_ms: pb.time_ms,
          updated_at: pb.updated_at,
        });
      }
    }
    rows.sort((a, b) => a.time_ms - b.time_ms || a.updated_at - b.updated_at);
    return typeof limit === "number" ? rows.slice(0, limit) : rows;
  }

  return {
    _state: {users, user_pbs, scope_members, challenges, pending_launches},
    prepare(sql) {
      let norm = sql.replace(/\s+/g, " ").trim();
      let bound = [];
      let stmt = {
        bind(...args) {
          bound = args;
          return stmt;
        },
        async run() {
          if (norm.startsWith("INSERT INTO users")) {
            let [user_id, username, display_name, updated_at] = bound;
            users.set(user_id, {user_id, username, display_name, updated_at});
          }
          else if (norm.startsWith("INSERT INTO scope_members")) {
            let [scope_type, scope_id, user_id] = bound;
            scope_members.add(`${scope_type}|${scope_id}|${user_id}`);
          }
          else if (norm.startsWith("INSERT INTO challenges")) {
            let [
              challenge_id, scope_type, scope_id, channel_id, message_id,
              track, difficulty, laps, reverse, created_by, created_at,
              interaction_token, token_expires_at,
            ] = bound;
            challenges.set(challenge_id, {
              challenge_id, scope_type, scope_id, channel_id, message_id,
              track, difficulty, laps, reverse, created_by, created_at,
              interaction_token, token_expires_at,
            });
          }
          else if (norm.startsWith("UPDATE challenges")) {
            let [message_id, interaction_token, token_expires_at, challenge_id] = bound;
            let c = challenges.get(challenge_id);
            if (c) {
              c.message_id = c.message_id || message_id;
              c.interaction_token = interaction_token;
              c.token_expires_at = token_expires_at;
            }
          }
          else if (norm.startsWith("INSERT INTO pending_launches")) {
            let [
              user_id, channel_id, challenge_id, message_id,
              interaction_token, token_expires_at, expires_at,
            ] = bound;
            pending_launches.set(`${user_id}|${channel_id}`, {
              user_id, channel_id, challenge_id, message_id,
              interaction_token, token_expires_at, followups_used: 0,
              expires_at, consumed: 0,
            });
          }
          else if (norm.startsWith("UPDATE pending_launches SET consumed = 1")) {
            let [user_id, channel_id] = bound;
            let p = pending_launches.get(`${user_id}|${channel_id}`);
            if (p) p.consumed = 1;
          }
          else if (norm.startsWith("UPDATE pending_launches SET followups_used")) {
            let [user_id, channel_id] = bound;
            let p = pending_launches.get(`${user_id}|${channel_id}`);
            if (p) p.followups_used += 1;
          }
          else if (norm.startsWith("INSERT INTO user_pbs")) {
            let [
              user_id, track, difficulty, laps, reverse,
              run_id, kart, kart_color, time_ms, r2_key, replay_version, updated_at,
            ] = bound;
            user_pbs.set(pb_key(user_id, track, difficulty, laps, reverse), {
              user_id, track, difficulty, laps, reverse,
              run_id, kart, kart_color, time_ms, r2_key, replay_version, updated_at,
            });
          }
          return {success: true};
        },
        async all() {
          if (norm.includes("FROM scope_members sm INNER JOIN user_pbs p")) {
            let [track, difficulty, laps, reverse, scope_type, scope_id, limit] = bound;
            return {results: query_lb(track, difficulty, laps, reverse, scope_type, scope_id, limit)};
          }
          return {results: []};
        },
        async first() {
          if (norm.startsWith("SELECT COUNT(*) AS total")) {
            let [track, difficulty, laps, reverse, scope_type, scope_id] = bound;
            return {total: query_lb(track, difficulty, laps, reverse, scope_type, scope_id).length};
          }
          if (norm.startsWith("SELECT * FROM challenges WHERE challenge_id")) {
            return challenges.get(bound[0]) || null;
          }
          if (norm.startsWith("SELECT p.challenge_id, c.track")) {
            let [user_id, channel_id, now] = bound;
            let p = pending_launches.get(`${user_id}|${channel_id}`);
            if (!p || p.consumed !== 0 || p.expires_at <= now) return null;
            let c = challenges.get(p.challenge_id);
            if (!c) return null;
            return {
              challenge_id: p.challenge_id,
              track: c.track,
              difficulty: c.difficulty,
              laps: c.laps,
              reverse: c.reverse,
              scope_type: c.scope_type,
              scope_id: c.scope_id,
            };
          }
          if (norm.startsWith("SELECT p.r2_key, p.user_id FROM user_pbs p")) {
            let [scope_type, scope_id, run_id] = bound;
            for (let pb of user_pbs.values()) {
              if (pb.run_id === run_id && scope_members.has(`${scope_type}|${scope_id}|${pb.user_id}`)) {
                return {r2_key: pb.r2_key, user_id: pb.user_id};
              }
            }
            return null;
          }
          if (norm.startsWith("SELECT run_id, time_ms, r2_key FROM user_pbs")) {
            let [user_id, track, difficulty, laps, reverse] = bound;
            return user_pbs.get(pb_key(user_id, track, difficulty, laps, reverse)) || null;
          }
          if (norm.startsWith("SELECT message_id, interaction_token")) {
            let [user_id, channel_id] = bound;
            return pending_launches.get(`${user_id}|${channel_id}`) || null;
          }
          if (norm.startsWith("SELECT challenge_id, channel_id, message_id")) {
            let [scope_type, scope_id, track, difficulty, laps, reverse, exclude_id] = bound;
            let matching = [...challenges.values()].filter(
              (c) =>
                c.scope_type === scope_type &&
                c.scope_id === scope_id &&
                c.track === track &&
                c.difficulty === difficulty &&
                c.laps === laps &&
                c.reverse === reverse &&
                c.challenge_id !== exclude_id
            );
            matching.sort((a, b) => b.created_at - a.created_at);
            return matching[0] || null;
          }
          return null;
        },
      };
      return stmt;
    },
  };
}

function create_mock_r2() {
  let blobs = new Map();
  return {
    _blobs: blobs,
    async put(key, data) {
      blobs.set(key, new Uint8Array(data));
    },
    async get(key) {
      let data = blobs.get(key);
      if (!data) return null;
      return {body: data};
    },
    async delete(key) {
      blobs.delete(key);
    },
  };
}

test("autocomplete_tracks filters standard STK race tracks", () => {
  let results = autocomplete_tracks("aby");
  assert.equal(results.length, 1);
  assert.equal(results[0].value, "abyss");
  assert.ok(autocomplete_tracks("").length >= 20);
});

test("POST /api/interactions verifies Ed25519 signature and handles PING", async () => {
  let keys = await generate_ed25519_keypair();
  let env = {DISCORD_PUBLIC_KEY: keys.publicKeyHex};

  let req = await make_signed_interaction_request({type: 1}, keys);
  let resp = await handleInteractions({request: req, env});
  assert.equal(resp.status, 200);
  assert.deepEqual(await resp.json(), {type: 1});

  let bad_req = new Request("https://example.workers.dev/api/interactions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Signature-Ed25519": "00".repeat(64),
      "X-Signature-Timestamp": "12345",
    },
    body: JSON.stringify({type: 1}),
  });
  let bad_resp = await handleInteractions({request: bad_req, env});
  assert.equal(bad_resp.status, 401);
});

test("Full Time Trial flow: /timetrial -> Play button -> /api/token -> submit -> embed refresh & #1 announcement + PB carryover", async () => {
  let keys = await generate_ed25519_keypair();
  let db = create_mock_db();
  let r2 = create_mock_r2();
  let discord_calls = [];

  let mock_fetch = async (url, init) => {
    discord_calls.push({url: String(url), method: (init && init.method) || "GET", body: init && init.body});
    if (String(url).includes("/oauth2/token")) {
      return new Response(JSON.stringify({access_token: "discord-access-tok"}), {status: 200});
    }
    if (String(url).includes("/users/@me")) {
      return new Response(JSON.stringify({id: "user_1", username: "alice", global_name: "Alice"}), {status: 200});
    }
    if (String(url).includes("/activity-instances/inst_guild_1")) {
      return new Response(
        JSON.stringify({
          users: ["user_1"],
          location: {kind: "gc", guild_id: "guild_A", channel_id: "chan_1"},
        }),
        {status: 200}
      );
    }
    return new Response(JSON.stringify({id: "msg_ok"}), {status: 200});
  };

  let env = {
    DISCORD_PUBLIC_KEY: keys.publicKeyHex,
    DISCORD_CLIENT_ID: "app_123",
    DISCORD_CLIENT_SECRET: "secret_123",
    DISCORD_BOT_TOKEN: "bot_123",
    JWT_SECRET: TEST_JWT_SECRET,
    TIME_TRIALS_DB: db,
    REPLAYS: r2,
  };

  // 1. User runs /timetrial track:abyss in Guild A
  let cmd_req = await make_signed_interaction_request(
    {
      type: 2,
      guild_id: "guild_A",
      channel_id: "chan_1",
      token: "cmd_tok_1",
      member: {user: {id: "user_1", username: "alice", global_name: "Alice"}},
      data: {
        name: "timetrial",
        options: [{name: "track", value: "abyss"}],
      },
    },
    keys
  );
  let cmd_resp = await handleInteractions({request: cmd_req, env});
  assert.equal(cmd_resp.status, 200);
  let cmd_body = await cmd_resp.json();
  assert.equal(cmd_body.type, 4);
  assert.match(cmd_body.data.embeds[0].title, /Abyss/);
  let play_custom_id = cmd_body.data.components[0].components[0].custom_id;
  assert.ok(play_custom_id.startsWith("tt:play:"));
  let challenge_id = play_custom_id.slice("tt:play:".length);

  // 2. User clicks "Play Time Trial" button -> LAUNCH_ACTIVITY (type 12)
  let btn_req = await make_signed_interaction_request(
    {
      type: 3,
      guild_id: "guild_A",
      channel_id: "chan_1",
      token: "btn_tok_1",
      message: {id: "msg_embed_1"},
      member: {user: {id: "user_1", username: "alice", global_name: "Alice"}},
      data: {custom_id: play_custom_id},
    },
    keys
  );
  let btn_resp = await handleInteractions({request: btn_req, env});
  assert.equal(btn_resp.status, 200);
  assert.deepEqual(await btn_resp.json(), {type: 12});

  // 3. Activity iframe exchanges OAuth code + instance_id -> gets JWT + pending_time_trial
  let tok_req = new Request("https://example.workers.dev/api/token", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({code: "oauth_code", instance_id: "inst_guild_1"}),
  });
  let tok_resp = await handleTokenExchange({request: tok_req, env, fetch_impl: mock_fetch});
  assert.equal(tok_resp.status, 200);
  let tok_body = await tok_resp.json();
  assert.ok(tok_body.session_token);
  assert.equal(tok_body.pending_time_trial.challenge_id, challenge_id);
  assert.equal(tok_body.pending_time_trial.track, "abyss");

  // 4. Submit a completed Time Trial run
  let form = new FormData();
  form.append(
    "metadata",
    JSON.stringify({
      challenge_id,
      kart: "tux",
      kart_color: 0,
      time_ms: 84231,
      replay_version: 4,
    })
  );
  form.append("replay", new Blob([new Uint8Array([31, 139, 8, 0, 1, 2, 3])], {type: "application/gzip"}), "run.replay.gz");

  let submit_req = new Request("https://example.workers.dev/api/timetrials/runs", {
    method: "POST",
    headers: {Authorization: `Bearer ${tok_body.session_token}`},
    body: form,
  });
  let submit_resp = await handleTimeTrials({request: submit_req, env, fetch_impl: mock_fetch});
  assert.equal(submit_resp.status, 200);
  let submit_body = await submit_resp.json();
  assert.equal(submit_body.is_new_pb, true);
  assert.equal(submit_body.is_new_first, true);
  assert.equal(submit_body.rank, 1);
  assert.equal(r2._blobs.size, 1);

  // Verify Discord embed PATCH and #1 followup POST both fired via button interaction token
  assert.ok(discord_calls.some((c) => c.method === "PATCH" && c.url.includes("/webhooks/app_123/btn_tok_1/messages/msg_embed_1")));
  assert.ok(discord_calls.some((c) => c.method === "POST" && c.url.includes("/webhooks/app_123/btn_tok_1")));

  // 5. Privacy check: another guild (guild_B) where Alice hasn't played cannot download Alice's replay
  let other_guild_jwt = await sign_jwt(
    {
      sub: "user_2",
      username: "bob",
      display_name: "Bob",
      scope_type: "guild",
      scope_id: "guild_B",
      channel_id: "chan_9",
    },
    TEST_JWT_SECRET
  );
  let steal_req = new Request(
    `https://example.workers.dev/api/timetrials/runs/${submit_body.run_id}/replay`,
    {headers: {Authorization: `Bearer ${other_guild_jwt}`}}
  );
  let steal_resp = await handleTimeTrials({request: steal_req, env});
  assert.equal(steal_resp.status, 404);

  // 6. PB carryover: Alice creates a /timetrial in a DM with Bob -> her 84231ms PB carries over automatically!
  let dm_cmd_req = await make_signed_interaction_request(
    {
      type: 2,
      channel_id: "dm_chan_42",
      token: "dm_tok_1",
      user: {id: "user_1", username: "alice", global_name: "Alice"},
      data: {
        name: "timetrial",
        options: [{name: "track", value: "abyss"}],
      },
    },
    keys
  );
  let dm_cmd_resp = await handleInteractions({request: dm_cmd_req, env});
  let dm_cmd_body = await dm_cmd_resp.json();
  assert.match(dm_cmd_body.data.embeds[0].description, /Alice/);
  assert.match(dm_cmd_body.data.embeds[0].description, /1:24\.231/);
});
