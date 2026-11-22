import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync, gunzipSync } from "node:zlib";
import { create_time_trials_bridge } from "../time-trials.js";

function create_mock_fs() {
  let files = new Map();
  let dirs = new Set(["/"]);
  return {
    _files: files,
    mkdir(p) {
      if (dirs.has(p)) throw new Error("EEXIST");
      dirs.add(p);
    },
    readdir(p) {
      let prefix = p.endsWith("/") ? p : `${p}/`;
      let out = [".", ".."];
      for (let k of files.keys()) {
        if (k.startsWith(prefix)) {
          let rest = k.slice(prefix.length);
          if (!rest.includes("/")) out.push(rest);
        }
      }
      return out;
    },
    unlink(p) {
      files.delete(p);
    },
    writeFile(p, bytes) {
      files.set(p, new Uint8Array(bytes));
    },
  };
}

function create_mock_wasm() {
  let heap = new Uint8Array(64 * 1024);
  let next_ptr = 1024;
  let calls = [];
  let decoder = new TextDecoder();

  function read_cstr(ptr) {
    let end = ptr;
    while (end < heap.length && heap[end] !== 0) end++;
    return decoder.decode(heap.subarray(ptr, end));
  }

  let module = {
    HEAPU8: heap,
    _malloc(size) {
      let ptr = next_ptr;
      next_ptr += size + 16;
      return ptr;
    },
    _free() {},
    _stk_tt_on_ghosts_ready(req_id, status, json_ptr) {
      calls.push({fn: "ghosts", req_id, status, payload: JSON.parse(read_cstr(json_ptr))});
    },
    _stk_tt_on_submit_result(req_id, status, json_ptr) {
      calls.push({fn: "submit", req_id, status, payload: JSON.parse(read_cstr(json_ptr))});
    },
  };

  return {module, heap, calls};
}

test("fetchChallengeAndGhosts downloads ghosts into MEMFS and exposes prepared JSON", async () => {
  let fs = create_mock_fs();
  let wasm = create_mock_wasm();
  let fetch_impl = async (url) => {
    if (url.includes("/api/timetrials/challenges/ch1")) {
      return new Response(
        JSON.stringify({
          challenge: {challenge_id: "ch1", track: "abyss", difficulty: 2, laps: 3, reverse: false},
          me: {user_id: "u1", display_name: "SpeedDemon", avatar: "av1", guild_avatar: "gav1", guild_id: "g1"},
          total_players: 1,
          leaderboard: [{rank: 1, run_id: "r1", display_name: "SpeedDemon", kart: "tux", time_ms: 84000}],
          ghosts: [{run_id: "r1", user_id: "u1", is_self: true, display_name: "SpeedDemon", url: "/api/timetrials/runs/r1/replay"}],
        }),
        {status: 200}
      );
    }
    if (url === "/api/timetrials/runs/r1/replay") {
      return new Response("version: 4\nstk_version: 1.5\n", {status: 200});
    }
    return new Response("Not Found", {status: 404});
  };

  let bridge = create_time_trials_bridge({
    fetch_impl,
    get_session_token: () => "jwt-token",
    get_fs: () => fs,
    get_module: () => wasm.module,
    get_heap_u8: () => wasm.heap,
  });

  let result = await bridge.fetchChallengeAndGhosts("ch1");
  assert.deepEqual(result.ghost_files, ["/tmp/tt_ghosts/r1.replay"]);
  assert.deepEqual(result.ghost_names, ["SpeedDemon (PB)"]);
  assert.equal(result.self_name, "SpeedDemon");
  assert.ok(fs._files.has("/tmp/tt_ghosts/r1.replay"));
  assert.equal(JSON.parse(bridge.getPreparedChallengeJson()).challenge.track, "abyss");
});

test("requestSubmitRun copies heap bytes, gzips, posts, and invokes C++ callback", async () => {
  let wasm = create_mock_wasm();
  let replay_text = new TextEncoder().encode("version: 4\ntrack: abyss\n");
  let ptr = wasm.module._malloc(replay_text.length);
  wasm.heap.set(replay_text, ptr);

  let posted_form = null;
  let fetch_impl = async (url, init) => {
    assert.equal(url, "/api/timetrials/runs");
    assert.equal(init.headers.Authorization, "Bearer jwt-tok");
    posted_form = init.body;
    return new Response(JSON.stringify({is_new_pb: true, is_new_first: true, rank: 1, total_players: 1}), {status: 200});
  };

  let bridge = create_time_trials_bridge({
    fetch_impl,
    get_session_token: () => "jwt-tok",
    get_module: () => wasm.module,
    get_heap_u8: () => wasm.heap,
    gzip_impl: (bytes) => bytes,
  });

  bridge.requestSubmitRun(7, JSON.stringify({challenge_id: "ch1", kart: "tux", time_ms: 81000}), ptr, replay_text.length);
  // Zero out heap right away to prove synchronous copy happened before async fetch.
  wasm.heap.fill(0, ptr, ptr + replay_text.length);

  await new Promise((r) => setTimeout(r, 20));
  assert.ok(posted_form instanceof FormData);
  assert.equal(wasm.calls.length, 1);
  assert.equal(wasm.calls[0].fn, "submit");
  assert.equal(wasm.calls[0].req_id, 7);
  assert.equal(wasm.calls[0].status, 200);
  assert.equal(wasm.calls[0].payload.is_new_pb, true);
});

test("fetchChallengeAndGhosts decompresses gzipped replay payloads before writing to MEMFS", async () => {
  let fs = create_mock_fs();
  let wasm = create_mock_wasm();
  let plain_replay = "version: 4\nstk_version: 1.5\ntrack: volcano_island\n";
  let gzipped_replay = gzipSync(Buffer.from(plain_replay, "utf8"));

  let fetch_impl = async (url) => {
    if (url.includes("/api/timetrials/challenges/ch2")) {
      return new Response(
        JSON.stringify({
          challenge: {challenge_id: "ch2", track: "volcano_island", difficulty: 2, laps: 1, reverse: false},
          total_players: 1,
          leaderboard: [],
          ghosts: [{run_id: "r_gz", url: "/api/timetrials/runs/r_gz/replay"}],
        }),
        {status: 200}
      );
    }
    if (url === "/api/timetrials/runs/r_gz/replay") {
      return new Response(gzipped_replay, {
        status: 200,
        headers: {"Content-Type": "application/octet-stream"},
      });
    }
    return new Response("Not Found", {status: 404});
  };

  let bridge = create_time_trials_bridge({
    fetch_impl,
    get_session_token: () => "jwt-token",
    get_fs: () => fs,
    get_module: () => wasm.module,
    get_heap_u8: () => wasm.heap,
    ungzip_impl: (bytes) => gunzipSync(Buffer.from(bytes)),
  });

  let result = await bridge.fetchChallengeAndGhosts("ch2");
  assert.deepEqual(result.ghost_files, ["/tmp/tt_ghosts/r_gz.replay"]);
  let written = new TextDecoder().decode(fs._files.get("/tmp/tt_ghosts/r_gz.replay"));
  assert.equal(written, plain_replay);
});
