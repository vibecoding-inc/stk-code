import test from "node:test";
import assert from "node:assert/strict";
import { handleMatches, ensure_gzipped_bytes } from "../../worker/matches.mjs";
import { sign_jwt } from "../../worker/jwt.mjs";

const TEST_JWT_SECRET = "matches-test-jwt-secret-0123456789";
const TEST_GATEWAY_SECRET = "gateway-test-bearer-secret-abcdef";

function create_mock_db() {
  let matches = new Map();
  let match_results = [];
  let users = new Map();
  let scope_members = new Map();

  return {
    _state: {matches, match_results, users, scope_members},
    prepare(sql) {
      let norm = sql.replace(/\s+/g, " ").trim();
      let bound = [];
      let stmt = {
        bind(...args) {
          bound = args;
          return stmt;
        },
        async run() {
          if (norm.startsWith("INSERT INTO matches")) {
            let [
              match_id,
              instance_id,
              scope_type,
              scope_id,
              channel_id,
              track,
              mode,
              difficulty,
              laps,
              reverse,
              played_at,
            ] = bound;
            matches.set(match_id, {
              match_id,
              instance_id,
              scope_type,
              scope_id,
              channel_id,
              track,
              mode,
              difficulty,
              laps,
              reverse,
              played_at,
              replay_r2_key: null,
              replay_version: null,
              replay_bytes: null,
            });
            return {success: true};
          }
          if (norm.startsWith("INSERT INTO match_results")) {
            let [
              match_id,
              kart_index,
              discord_user_id,
              display_name,
              kart,
              kart_color,
              rank,
              finish_time_ms,
              dnf,
              is_ai,
            ] = bound;
            match_results.push({
              match_id,
              kart_index,
              discord_user_id,
              display_name,
              kart,
              kart_color,
              rank,
              finish_time_ms,
              dnf,
              is_ai,
            });
            return {success: true};
          }
          if (norm.startsWith("INSERT INTO users")) {
            let [user_id, username, display_name, avatar, updated_at] = bound;
            users.set(user_id, {user_id, username, display_name, avatar, updated_at});
            return {success: true};
          }
          if (norm.startsWith("INSERT INTO scope_members")) {
            let [scope_type, scope_id, user_id, joined_at] = bound;
            scope_members.set(`${scope_type}|${scope_id}|${user_id}`, {
              scope_type,
              scope_id,
              user_id,
              joined_at,
            });
            return {success: true};
          }
          if (norm.startsWith("UPDATE matches SET replay_r2_key = ?")) {
            let [replay_r2_key, replay_version, replay_bytes, match_id] = bound;
            let row = matches.get(match_id);
            if (row) {
              row.replay_r2_key = replay_r2_key;
              row.replay_version = replay_version;
              row.replay_bytes = replay_bytes;
            }
            return {success: true};
          }
          throw new Error(`Unhandled run() SQL: ${norm}`);
        },
        async first() {
          if (norm.startsWith("SELECT match_id, track, replay_r2_key FROM matches WHERE match_id = ?")) {
            return matches.get(bound[0]) || null;
          }
          if (norm.startsWith("SELECT match_id, instance_id, scope_type, scope_id, channel_id")) {
            return matches.get(bound[0]) || null;
          }
          if (norm.startsWith("SELECT match_id, scope_type, scope_id, replay_r2_key FROM matches WHERE match_id = ?")) {
            return matches.get(bound[0]) || null;
          }
          if (norm.startsWith("SELECT 1 AS ok FROM match_results WHERE match_id = ? AND discord_user_id = ?")) {
            let [match_id, uid] = bound;
            let found = match_results.find(
              (r) => r.match_id === match_id && r.discord_user_id === uid
            );
            return found ? {ok: 1} : null;
          }
          throw new Error(`Unhandled first() SQL: ${norm}`);
        },
        async all() {
          if (norm.startsWith("SELECT match_id, instance_id, scope_type, scope_id, channel_id")) {
            let [scope_type, scope_id, limit] = bound;
            let rows = Array.from(matches.values())
              .filter((m) => m.scope_type === scope_type && m.scope_id === scope_id)
              .sort((a, b) => b.played_at - a.played_at)
              .slice(0, limit);
            return {results: rows};
          }
          if (norm.startsWith("SELECT kart_index, discord_user_id, display_name, kart, kart_color")) {
            let [match_id] = bound;
            let rows = match_results
              .filter((r) => r.match_id === match_id)
              .sort((a, b) => a.rank - b.rank || a.kart_index - b.kart_index);
            return {results: rows};
          }
          throw new Error(`Unhandled all() SQL: ${norm}`);
        },
      };
      return stmt;
    },
  };
}

function create_mock_r2() {
  let objects = new Map();
  return {
    _objects: objects,
    async put(key, value, opts = {}) {
      let bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      objects.set(key, {bytes, httpMetadata: opts.httpMetadata || {}});
    },
    async get(key) {
      let obj = objects.get(key);
      if (!obj) return null;
      return {
        body: obj.bytes,
        httpMetadata: obj.httpMetadata,
      };
    },
  };
}

function make_env() {
  return {
    GATEWAY_API_SECRET: TEST_GATEWAY_SECRET,
    JWT_SECRET: TEST_JWT_SECRET,
    TIME_TRIALS_DB: create_mock_db(),
    REPLAYS: create_mock_r2(),
  };
}

test("POST /api/matches rejects missing or invalid gateway secret", async () => {
  let env = make_env();
  let req = new Request("https://example.workers.dev/api/matches", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer wrong-secret",
    },
    body: JSON.stringify({instance_id: "i-1-gc-111-222", track: "abyss", results: []}),
  });
  let res = await handleMatches({request: req, env});
  assert.equal(res.status, 401);
});

test("Scoreboard persists independently of replay and replay auto-gzips into R2", async () => {
  let env = make_env();

  // 1. Gateway posts scoreboard only (no replay yet)
  let create_req = new Request("https://example.workers.dev/api/matches", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_GATEWAY_SECRET}`,
    },
    body: JSON.stringify({
      instance_id: "i-abc-gc-999-888",
      scope_type: "guild",
      scope_id: "999",
      channel_id: "888",
      track: "abyss",
      mode: "normal",
      difficulty: 2,
      laps: 3,
      reverse: false,
      played_at: 1730000000000,
      results: [
        {
          kart_index: 0,
          discord_user_id: "u1",
          username: "alice",
          display_name: "Alice",
          kart: "tux",
          kart_color: 0.25,
          rank: 1,
          finish_time_ms: 91234,
          dnf: false,
          is_ai: false,
        },
        {
          kart_index: 1,
          discord_user_id: null,
          display_name: "AI Bot",
          kart: "nolok",
          kart_color: 0,
          rank: 2,
          finish_time_ms: null,
          dnf: true,
          is_ai: true,
        },
      ],
    }),
  });

  let create_res = await handleMatches({request: create_req, env});
  assert.equal(create_res.status, 201);
  let created = await create_res.json();
  assert.ok(created.match_id);
  assert.equal(created.result_count, 2);

  // Verify user & scope_member were upserted for human player only
  assert.ok(env.TIME_TRIALS_DB._state.users.has("u1"));
  assert.ok(env.TIME_TRIALS_DB._state.scope_members.has("guild|999|u1"));

  // 2. Client in same guild can immediately read the scoreboard (has_replay: false)
  let token = await sign_jwt(
    {sub: "u2", scope_type: "guild", scope_id: "999", exp: Math.floor(Date.now() / 1000) + 300},
    TEST_JWT_SECRET
  );
  let list_res = await handleMatches({
    request: new Request("https://example.workers.dev/api/matches", {
      headers: {Authorization: `Bearer ${token}`},
    }),
    env,
  });
  assert.equal(list_res.status, 200);
  let listed = await list_res.json();
  assert.equal(listed.matches.length, 1);
  assert.equal(listed.matches[0].has_replay, false);
  assert.equal(listed.matches[0].replay_url, null);
  assert.equal(listed.matches[0].results.length, 2);
  assert.equal(listed.matches[0].results[1].dnf, true);
  assert.equal(listed.matches[0].results[1].finish_time_ms, null);

  // 3. Gateway uploads plain ASCII .replay; Worker auto-gzips and stores in R2
  let replay_ascii = "version: 4\nstk_version: 1.5\nkart: tux Alice\nkart_list_end\ntrack: abyss\n";
  let upload_res = await handleMatches({
    request: new Request(
      `https://example.workers.dev/api/matches/${created.match_id}/replay`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${TEST_GATEWAY_SECRET}`,
          "Content-Type": "application/octet-stream",
          "X-Replay-Version": "4",
        },
        body: replay_ascii,
      }
    ),
    env,
  });
  assert.equal(upload_res.status, 200);
  let uploaded = await upload_res.json();
  assert.equal(uploaded.replay_r2_key, `mp/abyss/${created.match_id}.replay.gz`);
  assert.equal(uploaded.replay_version, 4);

  let stored = env.REPLAYS._objects.get(uploaded.replay_r2_key);
  assert.ok(stored);
  assert.equal(stored.bytes[0], 0x1f);
  assert.equal(stored.bytes[1], 0x8b);

  // 4. Client in same guild can fetch the gzipped replay; outsider in another guild gets 403
  let get_replay_res = await handleMatches({
    request: new Request(
      `https://example.workers.dev/api/matches/${created.match_id}/replay`,
      {headers: {Authorization: `Bearer ${token}`}}
    ),
    env,
  });
  assert.equal(get_replay_res.status, 200);
  let downloaded = new Uint8Array(await get_replay_res.arrayBuffer());
  assert.deepEqual(downloaded, stored.bytes);

  let outsider_token = await sign_jwt(
    {sub: "outsider", scope_type: "guild", scope_id: "other-guild", exp: Math.floor(Date.now() / 1000) + 300},
    TEST_JWT_SECRET
  );
  let forbidden_res = await handleMatches({
    request: new Request(
      `https://example.workers.dev/api/matches/${created.match_id}/replay`,
      {headers: {Authorization: `Bearer ${outsider_token}`}}
    ),
    env,
  });
  assert.equal(forbidden_res.status, 403);
});

test("ensure_gzipped_bytes passes through already-gzipped data unchanged", async () => {
  let plain = new TextEncoder().encode("version: 4\ntrack: abyss\n");
  let gz = await ensure_gzipped_bytes(plain);
  assert.equal(gz[0], 0x1f);
  assert.equal(gz[1], 0x8b);
  let gz2 = await ensure_gzipped_bytes(gz);
  assert.deepEqual(gz2, gz);
});
