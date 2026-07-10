import assert from "node:assert/strict";
import test from "node:test";

import { handleTokenExchange } from "../../worker/token.mjs";

test("handleTokenExchange exchanges a Discord authorization code", {concurrency: false}, async () => {
  let original_fetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://discord.com/api/oauth2/token");
    assert.equal(init.method, "POST");
    assert.equal(init.headers["Content-Type"], "application/x-www-form-urlencoded");

    let body = init.body instanceof URLSearchParams ? init.body : new URLSearchParams(init.body);
    assert.equal(body.get("client_id"), "client-id");
    assert.equal(body.get("client_secret"), "client-secret");
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.equal(body.get("code"), "auth-code");

    return Response.json({access_token: "discord-access-token"});
  };

  try {
    let request = new Request("https://example.com/api/token", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({code: "auth-code"}),
    });
    let response = await handleTokenExchange({
      request,
      env: {
        DISCORD_CLIENT_ID: "client-id",
        DISCORD_CLIENT_SECRET: "client-secret",
      },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {access_token: "discord-access-token"});
  }
  finally {
    globalThis.fetch = original_fetch;
  }
});

test("handleTokenExchange rejects a missing authorization code", {concurrency: false}, async () => {
  let request = new Request("https://example.com/api/token", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({}),
  });
  let response = await handleTokenExchange({
    request,
    env: {
      DISCORD_CLIENT_ID: "client-id",
      DISCORD_CLIENT_SECRET: "client-secret",
    },
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {error: "Missing authorization code."});
});

test("handleTokenExchange returns Discord errors", {concurrency: false}, async () => {
  let original_fetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return Response.json({error: "invalid_grant"}, {status: 400});
  };

  try {
    let request = new Request("https://example.com/api/token", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({code: "bad-code"}),
    });
    let response = await handleTokenExchange({
      request,
      env: {
        DISCORD_CLIENT_ID: "client-id",
        DISCORD_CLIENT_SECRET: "client-secret",
      },
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {error: "invalid_grant"});
  }
  finally {
    globalThis.fetch = original_fetch;
  }
});