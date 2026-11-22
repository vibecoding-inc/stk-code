import assert from "node:assert/strict";
import test from "node:test";

import {
  capture_canvas_blob,
  create_scoreboard_sharer,
  is_discord_share_available,
  share_scoreboard_blob,
} from "../discord-share.js";

function make_mock_canvas_factory({blob_bytes = [1, 2, 3]} = {}) {
  let calls = [];
  let create_canvas = () => {
    let offscreen = {
      width: 0,
      height: 0,
      getContext(kind) {
        assert.equal(kind, "2d");
        return {
          drawImage(src, x, y, w, h) {
            calls.push({src, x, y, w, h});
          },
        };
      },
      toBlob(cb, mime) {
        assert.equal(mime, "image/png");
        cb(new Blob([new Uint8Array(blob_bytes)], {type: "image/png"}));
      },
    };
    return offscreen;
  };
  return {create_canvas, calls};
}

test("is_discord_share_available requires SDK command and access token", () => {
  assert.equal(is_discord_share_available({}), false);
  assert.equal(
    is_discord_share_available({
      discordSdk: {commands: {openShareMomentDialog: async () => {}}},
    }),
    false
  );
  assert.equal(
    is_discord_share_available({
      discordSdk: {commands: {openShareMomentDialog: async () => {}}},
      discordAccessToken: "tok-1",
    }),
    true
  );
});

test("capture_canvas_blob draws synchronously and scales down wide canvases", async () => {
  let {create_canvas, calls} = make_mock_canvas_factory();
  let source = {width: 2560, height: 1440};

  let promise = capture_canvas_blob({
    canvas: source,
    create_canvas,
    max_width: 1280,
  });

  // Must have copied WebGL buffer synchronously before awaiting!
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {src: source, x: 0, y: 0, w: 1280, h: 720});

  let blob = await promise;
  assert.equal(blob.type, "image/png");
  assert.equal(blob.size, 3);
});

test("share_scoreboard_blob uploads and calls openShareMomentDialog in Discord", async () => {
  let dialog_calls = [];
  let lifecycle_events = [];
  let global_scope = {
    discordAccessToken: "access-xyz",
    discordSdk: {
      commands: {
        async openShareMomentDialog(args) {
          dialog_calls.push(args);
        },
      },
    },
  };

  let fetch_impl = async (url, init) => {
    assert.equal(url, "/api/share-attachment");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, "Bearer access-xyz");
    assert.ok(init.body instanceof FormData);
    return Response.json({
      url: "https://cdn.discordapp.com/ephemeral-attachments/999/scoreboard.png",
    });
  };

  let result = await share_scoreboard_blob({
    blob: new Blob(["png-data"], {type: "image/png"}),
    global_scope,
    fetch_impl,
    download_blob: () => {
      throw new Error("should not download inside Discord");
    },
    on_lifecycle: (event, details) => lifecycle_events.push({event, details}),
  });

  assert.deepEqual(result, {
    mode: "discord",
    url: "https://cdn.discordapp.com/ephemeral-attachments/999/scoreboard.png",
  });
  assert.deepEqual(dialog_calls, [
    {mediaUrl: "https://cdn.discordapp.com/ephemeral-attachments/999/scoreboard.png"},
  ]);
  assert.equal(lifecycle_events[0].event, "scoreboard_share_ok");
  assert.equal(lifecycle_events[0].details.mode, "discord");
});

test("share_scoreboard_blob falls back to PNG download outside Discord", async () => {
  let downloads = [];
  let blob = new Blob(["png-data"], {type: "image/png"});

  let result = await share_scoreboard_blob({
    blob,
    global_scope: {},
    fetch_impl: () => {
      throw new Error("should not call fetch outside Discord");
    },
    download_blob: (b, filename) => downloads.push({size: b.size, filename}),
  });

  assert.deepEqual(result, {mode: "download"});
  assert.deepEqual(downloads, [{size: 8, filename: "supertuxkart-scoreboard.png"}]);
});

test("create_scoreboard_sharer deduplicates concurrent shares and resets after completion", async () => {
  let {create_canvas} = make_mock_canvas_factory();
  let resolve_upload;
  let upload_count = 0;

  let sharer = create_scoreboard_sharer({
    get_canvas: () => ({width: 800, height: 600}),
    create_canvas,
    global_scope: {
      discordAccessToken: "tok",
      discordSdk: {
        commands: {
          async openShareMomentDialog() {},
        },
      },
    },
    fetch_impl: () => {
      upload_count++;
      return new Promise((resolve) => {
        resolve_upload = () =>
          resolve(Response.json({url: "https://cdn.discordapp.com/x.png"}));
      });
    },
    logger: {warn() {}},
  });

  let first = sharer.capture_and_share();
  assert.equal(first.started, true);
  assert.equal(sharer.is_in_flight(), true);

  // Second call while first is still running must be ignored.
  let second = sharer.capture_and_share();
  assert.deepEqual(second, {started: false, reason: "in_flight"});

  // Wait a microtask for toBlob -> fetch to start, then finish upload.
  await new Promise((r) => setTimeout(r, 0));
  resolve_upload();
  await first.promise;

  assert.equal(upload_count, 1);
  assert.equal(sharer.is_in_flight(), false);
});
