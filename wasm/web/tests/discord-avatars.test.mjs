import test from "node:test";
import assert from "node:assert/strict";
import {
  build_discord_avatar_url,
  create_discord_avatar_cache,
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

test("build_discord_avatar_url builds custom and default Discord CDN URLs", () => {
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
