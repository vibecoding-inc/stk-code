import test from "node:test";
import assert from "node:assert/strict";
import {
  build_discord_avatar_url,
  create_discord_avatar_cache,
  create_participant_avatar_sync,
  default_avatar_index,
} from "../discord-avatars.js";

function create_mock_fs() {
  let files = new Map();
  let dirs = new Set(["/"]);
  return {
    _files: files,
    mkdir(p) {
      if (dirs.has(p)) throw new Error("EEXIST");
      dirs.add(p);
    },
    writeFile(p, bytes) {
      files.set(p, new Uint8Array(bytes));
    },
  };
}

test("build_discord_avatar_url builds guild, custom, and default Discord CDN URLs", () => {
  assert.equal(
    build_discord_avatar_url({
      user_id: "123456789012345678",
      avatar: "a_hash",
      guild_id: "555555",
      guild_avatar: "g_hash",
      cdn_base: "/.proxy/discord-cdn",
    }),
    "/.proxy/discord-cdn/guilds/555555/users/123456789012345678/avatars/g_hash.png?size=64"
  );
  assert.equal(
    build_discord_avatar_url({user_id: "123456789012345678", avatar: "a_hash", cdn_base: "/.proxy/discord-cdn"}),
    "/.proxy/discord-cdn/avatars/123456789012345678/a_hash.png?size=64"
  );
  let idx = default_avatar_index("123456789012345678");
  assert.equal(
    build_discord_avatar_url({user_id: "123456789012345678", avatar: null, cdn_base: "/.proxy/discord-cdn"}),
    `/.proxy/discord-cdn/embed/avatars/${idx}.png`
  );
});

test("create_discord_avatar_cache fetches, caches, and falls back to default avatar on 404", async () => {
  let fs = create_mock_fs();
  let requested = [];
  let fetch_impl = async (url) => {
    requested.push(url);
    if (url.includes("/stale_hash.png")) {
      return new Response("Not Found", {status: 404});
    }
    return new Response(new Uint8Array([137, 80, 78, 71]), {
      status: 200,
      headers: {"Content-Type": "image/png"},
    });
  };

  let cache = create_discord_avatar_cache({
    fetch_impl,
    get_fs: () => fs,
    crop_impl: async (blob) => new Uint8Array(await blob.arrayBuffer()),
    cdn_base: "/.proxy/discord-cdn",
  });

  let path1 = await cache.ensureAvatar({user_id: "999999999999999999", avatar: "stale_hash"});
  assert.equal(path1, "/tmp/discord_avatars/999999999999999999.png");
  assert.equal(requested.length, 2); // custom 404 -> fallback embed avatar
  assert.ok(fs._files.has(path1));

  // Second call hits cache without extra fetches
  let path2 = await cache.ensureAvatar({user_id: "999999999999999999", avatar: "stale_hash"});
  assert.equal(path2, path1);
  assert.equal(requested.length, 2);
});

test("create_participant_avatar_sync syncs connected participants and live updates to WASM", async () => {
  let fs = create_mock_fs();
  let heap = new Uint8Array(8192);
  let next_ptr = 64;
  let decoder = new TextDecoder();
  let registered = [];
  let read_cstr = (ptr) => {
    let end = ptr;
    while (end < heap.length && heap[end] !== 0) end++;
    return decoder.decode(heap.subarray(ptr, end));
  };

  let mock_module = {
    _stk_tt_alloc(n) {
      let p = next_ptr;
      next_ptr += n + 8;
      return p;
    },
    _stk_tt_free() {},
    _stk_discord_register_participant(u_ptr, d_ptr, a_ptr) {
      registered.push({
        username: read_cstr(u_ptr),
        display_name: read_cstr(d_ptr),
        avatar_path: read_cstr(a_ptr),
      });
    },
  };

  let cache = create_discord_avatar_cache({
    fetch_impl: async () => new Response(new Uint8Array([137, 80, 78, 71]), {status: 200}),
    get_fs: () => fs,
    crop_impl: async (blob) => new Uint8Array(await blob.arrayBuffer()),
    cdn_base: "/.proxy/discord-cdn",
  });

  let update_handler = null;
  let mock_sdk = {
    commands: {
      async getInstanceConnectedParticipants() {
        return {
          participants: [
            {id: "111", username: "alice", global_name: "Alice!", avatar: "hash1"},
          ],
        };
      },
    },
    subscribe(event_name, cb) {
      if (event_name === "ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE") {
        update_handler = cb;
      }
    },
  };

  let sync = create_participant_avatar_sync({
    avatar_cache: cache,
    get_discord_sdk: () => mock_sdk,
    get_discord_auth: () => null,
    get_module: () => mock_module,
    get_heap_u8: () => heap,
  });

  await sync.start();
  // Must NOT call WASM exports before C++ invokes flushToWasm() (runtime init guard).
  assert.equal(registered.length, 0);

  // Once C++ boots and invokes flushToWasm(), buffered participants are pushed.
  sync.flushToWasm();
  assert.equal(registered.length, 1);
  assert.equal(registered[0].username, "alice");
  assert.equal(registered[0].display_name, "Alice!");
  assert.equal(registered[0].avatar_path, "/tmp/discord_avatars/111.png");

  // Subsequent live joins push immediately now that WASM is running.
  update_handler({
    participants: [
      {id: "111", username: "alice", global_name: "Alice!", avatar: "hash1"},
      {id: "222", username: "bob", nickname: "Bobby", avatar: "hash2"},
    ],
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(registered.some((r) => r.username === "bob" && r.display_name === "Bobby"));
});
