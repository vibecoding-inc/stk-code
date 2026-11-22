import test from "node:test";
import assert from "node:assert/strict";
import { handleInteractions } from "../../worker/interactions.mjs";
import { handleTokenExchange } from "../../worker/token.mjs";
import {
  handleTimeTrials,
  compute_podium_hash,
  ensure_podium_image,
  build_challenge_embed,
} from "../../worker/time-trials.mjs";
import { sign_jwt } from "../../worker/jwt.mjs";
import { autocomplete_tracks } from "../../worker/tracks.mjs";
import { register_commands } from "../../scripts/register-commands.mjs";

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
  let scope_members = new Map(); // key: scope_type|scope_id|user_id -> { guild_nick, guild_avatar }
  let challenges = new Map(); // key: challenge_id
  let pending_launches = new Map(); // key: user_id|channel_id

  function pb_key(user_id, track, difficulty, laps, reverse) {
    return `${user_id}|${track}|${difficulty}|${laps}|${reverse ? 1 : 0}`;
  }

  function query_lb(track, difficulty, laps, reverse, scope_type, scope_id, limit) {
    let rows = [];
    for (let pb of user_pbs.values()) {
      let sm = scope_members.get(`${scope_type}|${scope_id}|${pb.user_id}`);
      if (
        pb.track === track &&
        pb.difficulty === difficulty &&
        pb.laps === laps &&
        pb.reverse === (reverse ? 1 : 0) &&
        sm
      ) {
        let u = users.get(pb.user_id) || {username: "Player", display_name: "Player", avatar: null};
        rows.push({
          user_id: pb.user_id,
          display_name: u.display_name,
          username: u.username,
          avatar: u.avatar || null,
          guild_nick: sm.guild_nick || null,
          guild_avatar: sm.guild_avatar || null,
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
            let [user_id, username, display_name, avatar, updated_at] = bound;
            let prev = users.get(user_id);
            users.set(user_id, {
              user_id,
              username,
              display_name,
              avatar: avatar || (prev && prev.avatar) || null,
              updated_at,
            });
          }
          else if (norm.startsWith("INSERT INTO scope_members")) {
            let [scope_type, scope_id, user_id, _joined, guild_nick, guild_avatar] = bound;
            let key = `${scope_type}|${scope_id}|${user_id}`;
            if (norm.includes("DO UPDATE") || !scope_members.has(key)) {
              scope_members.set(key, {
                guild_nick: guild_nick || null,
                guild_avatar: guild_avatar || null,
              });
            }
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
    if (String(url).includes("/users/@me/guilds/guild_A/member")) {
      return new Response(JSON.stringify({nick: "SpeedDemon", avatar: "guild_av_1"}), {status: 200});
    }
    if (String(url).includes("/users/@me")) {
      return new Response(JSON.stringify({id: "user_1", username: "alice", global_name: "Alice", avatar: "global_av_1"}), {status: 200});
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

  // 1. User runs /timetrial track:abyss in Guild A (with a guild-specific nickname + guild avatar)
  let cmd_req = await make_signed_interaction_request(
    {
      type: 2,
      guild_id: "guild_A",
      channel_id: "chan_1",
      token: "cmd_tok_1",
      member: {
        nick: "SpeedDemon",
        avatar: "guild_av_1",
        user: {id: "user_1", username: "alice", global_name: "Alice", avatar: "global_av_1"},
      },
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
  assert.deepEqual(cmd_body.data.embeds[0].fields[0], {name: "Laps", value: "2", inline: true});
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
      member: {
        nick: "SpeedDemon",
        avatar: "guild_av_1",
        user: {id: "user_1", username: "alice", global_name: "Alice", avatar: "global_av_1"},
      },
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
  assert.equal(tok_body.pending_time_trial.laps, 2);

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
  // Guild leaderboard preserves Guild A's guild-specific nickname & guild avatar even after /api/token
  assert.equal(submit_body.leaderboard[0].display_name, "SpeedDemon");
  assert.equal(submit_body.leaderboard[0].guild_avatar, "guild_av_1");
  assert.equal(submit_body.leaderboard[0].guild_id, "guild_A");
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

test("register_commands preserves Discord PRIMARY_ENTRY_POINT (type 4) command during global bulk PUT", async () => {
  let put_body = null;
  let fetch_impl = async (url, init) => {
    if (init.method === "GET") {
      return new Response(
        JSON.stringify([
          {
            id: "entry_1",
            application_id: "app_123",
            version: "999",
            type: 4,
            name: "launch",
            description: "Launch SuperTuxKart",
            handler: 2,
            integration_types: [0, 1],
            contexts: [0, 1, 2],
          },
          {
            id: "old_cmd",
            type: 1,
            name: "deprecated",
            description: "Old command",
          },
        ]),
        {status: 200}
      );
    }
    assert.equal(init.method, "PUT");
    put_body = JSON.parse(init.body);
    return new Response(JSON.stringify(put_body), {status: 200});
  };

  let registered = await register_commands({
    client_id: "app_123",
    bot_token: "bot_123",
    fetch_impl,
  });

  assert.equal(registered.length, 2);
  assert.ok(put_body.some((c) => c.name === "timetrial" && c.type === 1));
  let entry = put_body.find((c) => c.type === 4);
  assert.ok(entry);
  assert.equal(entry.name, "launch");
  assert.equal(entry.handler, 2);
  assert.equal(entry.application_id, undefined);
});


test("compute_podium_hash is deterministic and ignores entries beyond Top 3", async () => {
  let challenge = {track: "hacienda", difficulty: 3, laps: 3, reverse: 0};
  let top3 = [
    {rank: 1, user_id: "1", display_name: "Alice", kart: "tux", time_ms: 80000},
    {rank: 2, user_id: "2", display_name: "Bob", kart: "nolok", time_ms: 81000},
    {rank: 3, user_id: "3", display_name: "Cara", kart: "hexley", time_ms: 82000},
  ];
  let h1 = await compute_podium_hash(challenge, top3);
  let h2 = await compute_podium_hash(challenge, [
    ...top3,
    {rank: 4, user_id: "4", display_name: "Dan", kart: "gnu", time_ms: 90000},
  ]);
  let h3 = await compute_podium_hash(challenge, [
    {...top3[0], time_ms: 79500},
    top3[1],
    top3[2],
  ]);

  assert.match(h1, /^[a-f0-9]{24}$/);
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.equal(await compute_podium_hash(challenge, []), null);
});

test("ensure_podium_image renders via Workers VPC on cache miss, caches in R2, and serves via GET route", async () => {
  let store = new Map();
  let r2 = {
    async head(key) {
      return store.has(key) ? {key} : null;
    },
    async put(key, value) {
      store.set(key, new Uint8Array(value));
    },
    async get(key) {
      return store.has(key) ? {body: store.get(key)} : null;
    },
  };

  let fake_png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let vpc_calls = [];
  let env = {
    REPLAYS: r2,
    PODIUM_RENDER_SECRET: "super-secret-token",
    PODIUM_RENDERER: {
      async fetch(url, init) {
        vpc_calls.push({url, init});
        return new Response(fake_png, {status: 200, headers: {"Content-Type": "image/png"}});
      },
    },
  };

  let challenge = {track: "hacienda", difficulty: 3, laps: 3, reverse: 0};
  let leaderboard = {
    entries: [
      {
        rank: 1,
        user_id: "1001",
        guild_id: "9001",
        display_name: "SpeedyTux",
        avatar: "av1",
        guild_avatar: "gav1",
        kart: "tux",
        time_ms: 82415,
      },
    ],
    total_players: 1,
  };

  let url1 = await ensure_podium_image({
    env,
    challenge,
    leaderboard,
    public_origin: "https://stk.example.workers.dev",
  });
  assert.match(url1, /^https:\/\/stk\.example\.workers\.dev\/api\/timetrials\/podium\/[a-f0-9]{24}\.png$/);
  assert.equal(vpc_calls.length, 1);
  assert.equal(vpc_calls[0].init.headers.Authorization, "Bearer super-secret-token");

  // Second call hits R2 cache without calling Workers VPC again
  let url2 = await ensure_podium_image({
    env,
    challenge,
    leaderboard,
    public_origin: "https://stk.example.workers.dev",
  });
  assert.equal(url2, url1);
  assert.equal(vpc_calls.length, 1);

  // Embed includes image URL
  let embed = build_challenge_embed(challenge, leaderboard, {podium_image_url: url1});
  assert.deepEqual(embed.image, {url: url1});

  // Public GET route streams cached PNG with immutable Cache-Control
  let get_resp = await handleTimeTrials({
    request: new Request(url1, {method: "GET"}),
    env,
  });
  assert.equal(get_resp.status, 200);
  assert.equal(get_resp.headers.get("Content-Type"), "image/png");
  assert.match(get_resp.headers.get("Cache-Control"), /immutable/);
  let body_bytes = new Uint8Array(await get_resp.arrayBuffer());
  assert.deepEqual(body_bytes, fake_png);

  // Missing hash returns 404
  let miss_resp = await handleTimeTrials({
    request: new Request("https://stk.example.workers.dev/api/timetrials/podium/000000000000000000000000.png"),
    env,
  });
  assert.equal(miss_resp.status, 404);
});

test("ensure_podium_image fails open when Workers VPC binding is absent or errors", async () => {
  let r2 = {async head() { return null; }};
  let challenge = {track: "hacienda", difficulty: 3, laps: 3, reverse: 0};
  let leaderboard = {
    entries: [{rank: 1, user_id: "1", display_name: "Alice", kart: "tux", time_ms: 80000}],
    total_players: 1,
  };

  let no_vpc = await ensure_podium_image({
    env: {REPLAYS: r2},
    challenge,
    leaderboard,
    public_origin: "https://stk.example.workers.dev",
  });
  assert.equal(no_vpc, null);

  let err_vpc = await ensure_podium_image({
    env: {
      REPLAYS: r2,
      PODIUM_RENDERER: {
        async fetch() {
          throw new Error("tunnel offline");
        },
      },
    },
    challenge,
    leaderboard,
    public_origin: "https://stk.example.workers.dev",
  });
  assert.equal(err_vpc, null);
});
