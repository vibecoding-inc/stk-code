import assert from "node:assert/strict";
import test from "node:test";

import { init_discord_activity } from "../discord-activity.js";

test("init_discord_activity skips startup outside Discord", {concurrency: false}, async () => {
  let created = false;
  let fetched = false;
  let logger = {
    log() {},
    warn() {},
  };
  let global_scope = {};

  let auth = await init_discord_activity({
    config: {discord_client_id: "client-id"},
    search: "",
    create_discord_sdk() {
      created = true;
    },
    fetch_impl: async () => {
      fetched = true;
    },
    logger,
    global_scope,
  });

  assert.equal(auth, undefined);
  assert.equal(created, false);
  assert.equal(fetched, false);
  assert.equal(global_scope.discordSdk, undefined);
  assert.equal(global_scope.discordAuth, undefined);
});

test("init_discord_activity warns when the client id is missing", {concurrency: false}, async () => {
  let warnings = [];
  let logger = {
    log() {},
    warn(...args) {
      warnings.push(args.join(" "));
    },
  };

  let auth = await init_discord_activity({
    config: {},
    search: "?frame_id=123",
    create_discord_sdk() {
      throw new Error("SDK should not be created without a client id.");
    },
    fetch_impl: async () => {
      throw new Error("Fetch should not be called without a client id.");
    },
    logger,
    global_scope: {},
  });

  assert.equal(auth, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /discord_client_id/);
});

test("init_discord_activity authenticates through the local token endpoint", {concurrency: false}, async () => {
  let authorized = false;
  let authenticated = false;
  let ready_called = false;
  let logs = [];
  let logger = {
    log(...args) {
      logs.push(args.join(" "));
    },
    warn() {
      throw new Error("No warning expected during a successful login.");
    },
  };
  let fake_sdk = {
    ready: async () => {
      ready_called = true;
    },
    commands: {
      authorize: async (options) => {
        authorized = true;
        assert.equal(options.client_id, "client-id");
        assert.equal(options.response_type, "code");
        assert.equal(options.prompt, "none");
        assert.deepEqual(options.scope, ["identify"]);
        return {code: "discord-code"};
      },
      authenticate: async ({access_token}) => {
        authenticated = true;
        assert.equal(access_token, "discord-access-token");
        return {
          user: {
            id: "1",
            username: "penguin",
            global_name: "Penguin",
            avatar: "avatar-hash",
          },
        };
      },
    },
  };
  let global_scope = {};

  let auth = await init_discord_activity({
    config: {discord_client_id: "client-id"},
    search: "?frame_id=456",
    create_discord_sdk(client_id) {
      assert.equal(client_id, "client-id");
      return fake_sdk;
    },
    fetch_impl: async (url, init) => {
      assert.equal(url, "/api/token");
      assert.equal(init.method, "POST");
      assert.equal(init.headers["Content-Type"], "application/json");
      assert.deepEqual(JSON.parse(init.body), {code: "discord-code"});
      return Response.json({access_token: "discord-access-token"});
    },
    logger,
    global_scope,
  });

  assert.equal(ready_called, true);
  assert.equal(authorized, true);
  assert.equal(authenticated, true);
  assert.equal(global_scope.discordSdk, fake_sdk);
  assert.deepEqual(global_scope.discordAuth.user, {
    id: "1",
    username: "penguin",
    global_name: "Penguin",
    avatar: "avatar-hash",
  });
  assert.equal(auth, global_scope.discordAuth);
  assert.match(logs[0], /Discord login succeeded/);
});

test("init_discord_activity logs warnings when authentication fails", {concurrency: false}, async () => {
  let warnings = [];
  let logger = {
    log() {},
    warn(...args) {
      warnings.push(args[0]);
    },
  };

  let auth = await init_discord_activity({
    config: {discord_client_id: "client-id"},
    search: "?frame_id=789",
    create_discord_sdk() {
      return {
        ready: async () => {},
        commands: {
          authorize: async () => {
            throw new Error("authorize failed");
          },
        },
      };
    },
    fetch_impl: async () => Response.json({access_token: "unused"}),
    logger,
    global_scope: {},
  });

  assert.equal(auth, undefined);
  assert.deepEqual(warnings, ["Discord Activity login failed."]);
});