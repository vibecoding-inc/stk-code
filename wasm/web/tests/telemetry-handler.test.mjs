import assert from "node:assert/strict";
import test from "node:test";

import { handleTelemetry } from "../../worker/telemetry.mjs";

// Collect console output so we can assert on the echoed Workers Logs lines
// without polluting the test runner output.
function capture_console() {
  let calls = {log: [], warn: [], error: []};
  let original = {log: console.log, warn: console.warn, error: console.error};
  console.log = (...args) => calls.log.push(args);
  console.warn = (...args) => calls.warn.push(args);
  console.error = (...args) => calls.error.push(args);
  return {
    calls,
    restore() {
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
    },
  };
}

function make_env() {
  let writes = [];
  return {
    writes,
    env: {
      TELEMETRY: {
        writeDataPoint(point) {
          writes.push(point);
        },
      },
    },
  };
}

function telemetry_request(body, {method = "POST", text = false} = {}) {
  let payload = typeof body === "string" ? body : JSON.stringify(body);
  let headers = text
    ? {"Content-Type": "text/plain;charset=UTF-8"}
    : {"Content-Type": "application/json"};
  return new Request("https://example.com/api/telemetry", {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : payload,
  });
}

test("handleTelemetry writes one data point per entry and returns 204", {concurrency: false}, async () => {
  let {env, writes} = make_env();
  let cap = capture_console();
  try {
    let request = telemetry_request({
      session: "sess-123",
      meta: {
        build_version: "data-v42",
        quality: "high",
        discord_user_id: "user-9",
        user_agent: "TestAgent/1.0",
        memory_mb: 512,
        load_ms: 1234,
      },
      entries: [
        {ts: 1712345678901, level: "log", source: "engine", message: "hello"},
        {ts: 1712345678902, level: "error", source: "error", message: "boom"},
      ],
    });

    let response = await handleTelemetry({request, env, ctx: {}});

    assert.equal(response.status, 204);
    assert.equal(writes.length, 2);

    let first = writes[0];
    assert.deepEqual(first.indexes, ["sess-123"]);
    assert.deepEqual(first.blobs, [
      "log",
      "engine",
      "hello",
      "user-9",
      "data-v42",
      "high",
      "TestAgent/1.0",
      new Date(1712345678901).toISOString(),
    ]);
    assert.deepEqual(first.doubles, [1, 512, 1234]);

    // Level keys the console channel used for the Workers Logs echo.
    assert.equal(cap.calls.log.length, 1);
    assert.equal(cap.calls.error.length, 1);
    assert.equal(cap.calls.log[0][0].session, "sess-123");
    assert.equal(cap.calls.error[0][0].level, "error");
  }
  finally {
    cap.restore();
  }
});

test("handleTelemetry rejects non-POST with 405", {concurrency: false}, async () => {
  let {env} = make_env();
  let request = telemetry_request({session: "s", entries: []}, {method: "GET"});
  let response = await handleTelemetry({request, env, ctx: {}});
  assert.equal(response.status, 405);
});

test("handleTelemetry rejects invalid JSON with 400", {concurrency: false}, async () => {
  let {env, writes} = make_env();
  let request = telemetry_request("this-is-not-json{", {text: true});
  let response = await handleTelemetry({request, env, ctx: {}});
  assert.equal(response.status, 400);
  assert.equal(writes.length, 0);
});

test("handleTelemetry rejects an empty body with 400", {concurrency: false}, async () => {
  let {env} = make_env();
  let request = telemetry_request("", {text: true});
  let response = await handleTelemetry({request, env, ctx: {}});
  assert.equal(response.status, 400);
});

test("handleTelemetry accepts sendBeacon text/plain bodies", {concurrency: false}, async () => {
  let {env, writes} = make_env();
  let cap = capture_console();
  try {
    let request = telemetry_request(
      {session: "beacon-sess", meta: {}, entries: [{ts: 1, level: "info", source: "console", message: "beacon"}]},
      {text: true},
    );
    let response = await handleTelemetry({request, env, ctx: {}});
    assert.equal(response.status, 204);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].blobs[2], "beacon");
  }
  finally {
    cap.restore();
  }
});

test("handleTelemetry truncates oversized messages", {concurrency: false}, async () => {
  let {env, writes} = make_env();
  let cap = capture_console();
  try {
    let huge = "x".repeat(10000);
    let request = telemetry_request({
      session: "s",
      meta: {},
      entries: [{ts: 1, level: "log", source: "engine", message: huge}],
    });
    let response = await handleTelemetry({request, env, ctx: {}});
    assert.equal(response.status, 204);
    let message = writes[0].blobs[2];
    assert.ok(message.length < huge.length);
    assert.ok(new TextEncoder().encode(message).length <= 2048);
    assert.ok(message.endsWith("...[truncated]"));
  }
  finally {
    cap.restore();
  }
});

test("handleTelemetry clamps the batch to the max entry count", {concurrency: false}, async () => {
  let {env, writes} = make_env();
  let cap = capture_console();
  try {
    let entries = [];
    for (let i = 0; i < 250; i++) {
      entries.push({ts: i, level: "log", source: "console", message: `m${i}`});
    }
    let request = telemetry_request({session: "s", meta: {}, entries});
    let response = await handleTelemetry({request, env, ctx: {}});
    assert.equal(response.status, 204);
    assert.equal(writes.length, 100);
  }
  finally {
    cap.restore();
  }
});

test("handleTelemetry coerces unknown level and source values", {concurrency: false}, async () => {
  let {env, writes} = make_env();
  let cap = capture_console();
  try {
    let request = telemetry_request({
      session: "s",
      meta: {},
      entries: [{ts: 1, level: "trace", source: "network", message: "m"}],
    });
    let response = await handleTelemetry({request, env, ctx: {}});
    assert.equal(response.status, 204);
    assert.equal(writes[0].blobs[0], "log");
    assert.equal(writes[0].blobs[1], "console");
  }
  finally {
    cap.restore();
  }
});

test("handleTelemetry works when the TELEMETRY binding is absent", {concurrency: false}, async () => {
  let cap = capture_console();
  try {
    let request = telemetry_request({
      session: "s",
      meta: {},
      entries: [{ts: 1, level: "warn", source: "console", message: "no binding"}],
    });
    // env without TELEMETRY (local dev / run_server.py scenario).
    let response = await handleTelemetry({request, env: {}, ctx: {}});
    assert.equal(response.status, 204);
    // The echo still happens, keyed by level.
    assert.equal(cap.calls.warn.length, 1);
  }
  finally {
    cap.restore();
  }
});

test("handleTelemetry handles a missing entries array gracefully", {concurrency: false}, async () => {
  let {env, writes} = make_env();
  let cap = capture_console();
  try {
    let request = telemetry_request({session: "s", meta: {}});
    let response = await handleTelemetry({request, env, ctx: {}});
    assert.equal(response.status, 204);
    assert.equal(writes.length, 0);
  }
  finally {
    cap.restore();
  }
});
