import assert from "node:assert/strict";
import test from "node:test";

import { handleShareAttachment } from "../../worker/share-attachment.mjs";

test("handleShareAttachment uploads PNG to Discord and returns CDN url", {concurrency: false}, async () => {
  let original_fetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://discord.com/api/applications/app-123/attachment");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, "Bearer user-token-abc");
    assert.ok(init.body instanceof FormData);

    let uploaded = init.body.get("file");
    assert.ok(uploaded);
    assert.equal(uploaded.name, "scoreboard.png");
    assert.equal(uploaded.type, "image/png");
    let bytes = new Uint8Array(await uploaded.arrayBuffer());
    assert.deepEqual(Array.from(bytes), [137, 80, 78, 71]);

    return Response.json({
      attachment: {
        url: "https://cdn.discordapp.com/ephemeral-attachments/123/scoreboard.png",
      },
    });
  };

  try {
    let form = new FormData();
    form.append("file", new Blob([new Uint8Array([137, 80, 78, 71])], {type: "image/png"}), "scoreboard.png");

    let request = new Request("https://example.com/api/share-attachment", {
      method: "POST",
      headers: {Authorization: "Bearer user-token-abc"},
      body: form,
    });
    let response = await handleShareAttachment({
      request,
      env: {DISCORD_CLIENT_ID: "app-123"},
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      url: "https://cdn.discordapp.com/ephemeral-attachments/123/scoreboard.png",
    });
  }
  finally {
    globalThis.fetch = original_fetch;
  }
});

test("handleShareAttachment rejects non-POST methods", async () => {
  let request = new Request("https://example.com/api/share-attachment", {method: "GET"});
  let response = await handleShareAttachment({
    request,
    env: {DISCORD_CLIENT_ID: "app-123"},
  });
  assert.equal(response.status, 405);
});

test("handleShareAttachment rejects missing Bearer token", async () => {
  let form = new FormData();
  form.append("file", new Blob(["png"], {type: "image/png"}), "scoreboard.png");
  let request = new Request("https://example.com/api/share-attachment", {
    method: "POST",
    body: form,
  });
  let response = await handleShareAttachment({
    request,
    env: {DISCORD_CLIENT_ID: "app-123"},
  });
  assert.equal(response.status, 401);
});

test("handleShareAttachment rejects missing file field", async () => {
  let form = new FormData();
  let request = new Request("https://example.com/api/share-attachment", {
    method: "POST",
    headers: {Authorization: "Bearer user-token"},
    body: form,
  });
  let response = await handleShareAttachment({
    request,
    env: {DISCORD_CLIENT_ID: "app-123"},
  });
  assert.equal(response.status, 400);
});

test("handleShareAttachment propagates Discord API errors", {concurrency: false}, async () => {
  let original_fetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return Response.json({message: "Unauthorized"}, {status: 401});
  };

  try {
    let form = new FormData();
    form.append("file", new Blob(["png"], {type: "image/png"}), "scoreboard.png");
    let request = new Request("https://example.com/api/share-attachment", {
      method: "POST",
      headers: {Authorization: "Bearer bad-token"},
      body: form,
    });
    let response = await handleShareAttachment({
      request,
      env: {DISCORD_CLIENT_ID: "app-123"},
    });

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {error: "Unauthorized"});
  }
  finally {
    globalThis.fetch = original_fetch;
  }
});
