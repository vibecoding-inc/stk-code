import assert from "node:assert/strict";
import test from "node:test";

import { init_telemetry } from "../telemetry.js";

function make_console() {
  let calls = [];
  let console_impl = {};
  for (let level of ["log", "info", "warn", "error"]) {
    console_impl[level] = (...args) => {
      calls.push({level, args});
    };
  }
  return {console_impl, calls};
}

function make_scope() {
  let listeners = {};
  let scope = {
    onerror: null,
    document: {visibilityState: "visible"},
    addEventListener(event, handler) {
      (listeners[event] = listeners[event] || []).push(handler);
    },
    removeEventListener(event, handler) {
      if (!listeners[event]) return;
      listeners[event] = listeners[event].filter((h) => h !== handler);
    },
  };
  let dispatch = (event, payload) => {
    for (let handler of listeners[event] || []) handler(payload);
  };
  return {scope, listeners, dispatch};
}

function make_timer() {
  let callbacks = [];
  return {
    set_interval(cb) {
      callbacks.push(cb);
      return callbacks.length;
    },
    clear_interval() {},
    tick() {
      for (let cb of callbacks) cb();
    },
  };
}

test("console wrapping still prints and records entries", {concurrency: false}, async () => {
  let {console_impl, calls} = make_console();
  let {scope} = make_scope();
  let sent = [];
  let timer = make_timer();

  let telemetry = init_telemetry({
    console_impl,
    global_scope: scope,
    send_beacon: (url, blob) => {
      sent.push({url, blob});
      return true;
    },
    now: () => 1000,
    generate_id: () => "session-1",
    set_interval: timer.set_interval,
    clear_interval: timer.clear_interval,
  });

  console_impl.log("hello", "world");
  console_impl.warn("careful");
  console_impl.error("boom");
  console_impl.info("fyi");

  // Original console behaviour preserved.
  assert.deepEqual(calls, [
    {level: "log", args: ["hello", "world"]},
    {level: "warn", args: ["careful"]},
    {level: "error", args: ["boom"]},
    {level: "info", args: ["fyi"]},
  ]);

  telemetry.flush();
  assert.equal(sent.length, 1);
  let payload = JSON.parse(await sent[0].blob.text());
  assert.equal(payload.session, "session-1");
  assert.equal(payload.entries.length, 4);
  assert.deepEqual(payload.entries[0], {ts: 1000, level: "log", source: "console", message: "hello world"});
  assert.equal(payload.entries[1].level, "warn");
  assert.equal(payload.entries[2].level, "error");
  assert.equal(payload.entries[3].source, "console");

  telemetry.dispose();
});

test("Module print/printErr are captured as engine entries and originals preserved", {concurrency: false}, async () => {
  let {scope} = make_scope();
  let printed = [];
  let module = {
    print: (text) => printed.push(["out", text]),
    printErr: (text) => printed.push(["err", text]),
  };
  let sent = [];
  let timer = make_timer();

  let telemetry = init_telemetry({
    module,
    console_impl: {log() {}, info() {}, warn() {}, error() {}},
    global_scope: scope,
    send_beacon: (url, blob) => {
      sent.push(blob);
      return true;
    },
    now: () => 42,
    generate_id: () => "s",
    set_interval: timer.set_interval,
    clear_interval: timer.clear_interval,
  });

  module.print("engine stdout");
  module.printErr("engine stderr");

  assert.deepEqual(printed, [
    ["out", "engine stdout"],
    ["err", "engine stderr"],
  ]);

  telemetry.flush();
  let payload = JSON.parse(await sent[0].text());
  assert.equal(payload.entries.length, 2);
  assert.deepEqual(payload.entries[0], {ts: 42, level: "log", source: "engine", message: "engine stdout"});
  assert.deepEqual(payload.entries[1], {ts: 42, level: "error", source: "engine", message: "engine stderr"});

  telemetry.dispose();
  // Originals restored after dispose.
  assert.equal(typeof module.print, "function");
  module.print("after dispose");
  assert.deepEqual(printed[printed.length - 1], ["out", "after dispose"]);
});

test("periodic timer flush posts one batch and clears the buffer", {concurrency: false}, async () => {
  let {console_impl} = make_console();
  let {scope} = make_scope();
  let sent = [];
  let timer = make_timer();

  let telemetry = init_telemetry({
    console_impl,
    global_scope: scope,
    send_beacon: (url, blob) => {
      sent.push(blob);
      return true;
    },
    now: () => 1,
    generate_id: () => "s",
    set_interval: timer.set_interval,
    clear_interval: timer.clear_interval,
  });

  console_impl.log("one");
  console_impl.log("two");

  timer.tick();
  assert.equal(sent.length, 1);
  let payload = JSON.parse(await sent[0].text());
  assert.equal(payload.entries.length, 2);

  // Buffer cleared: a second tick with nothing new sends nothing.
  timer.tick();
  assert.equal(sent.length, 1);

  telemetry.dispose();
});

test("pagehide and visibilitychange(hidden) trigger a final flush via sendBeacon", {concurrency: false}, async () => {
  let {console_impl} = make_console();
  let {scope, dispatch} = make_scope();
  let sent = [];
  let timer = make_timer();

  let telemetry = init_telemetry({
    console_impl,
    global_scope: scope,
    send_beacon: (url, blob) => {
      sent.push({url, blob});
      return true;
    },
    generate_id: () => "s",
    set_interval: timer.set_interval,
    clear_interval: timer.clear_interval,
  });

  console_impl.log("before pagehide");
  dispatch("pagehide");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "/api/telemetry");

  // visibilitychange while visible should not flush.
  console_impl.log("still visible");
  scope.document.visibilityState = "visible";
  dispatch("visibilitychange");
  assert.equal(sent.length, 1);

  // visibilitychange while hidden flushes.
  scope.document.visibilityState = "hidden";
  dispatch("visibilitychange");
  assert.equal(sent.length, 2);

  telemetry.dispose();
});

test("enrich merges metadata and session id stays stable across batches", {concurrency: false}, async () => {
  let {console_impl} = make_console();
  let {scope} = make_scope();
  let sent = [];
  let timer = make_timer();

  let telemetry = init_telemetry({
    console_impl,
    global_scope: scope,
    send_beacon: (url, blob) => {
      sent.push(blob);
      return true;
    },
    get_metadata: () => ({user_agent: "test-agent", memory_mb: 512}),
    generate_id: () => "stable-session",
    set_interval: timer.set_interval,
    clear_interval: timer.clear_interval,
  });

  telemetry.enrich({build_version: "v1", quality: "high"});
  console_impl.log("first");
  telemetry.flush();

  telemetry.enrich({discord_user_id: "123"});
  console_impl.log("second");
  telemetry.flush();

  assert.equal(sent.length, 2);
  let first = JSON.parse(await sent[0].text());
  let second = JSON.parse(await sent[1].text());

  assert.equal(first.session, "stable-session");
  assert.equal(second.session, "stable-session");
  assert.deepEqual(first.meta, {
    user_agent: "test-agent",
    memory_mb: 512,
    build_version: "v1",
    quality: "high",
  });
  assert.deepEqual(second.meta, {
    user_agent: "test-agent",
    memory_mb: 512,
    build_version: "v1",
    quality: "high",
    discord_user_id: "123",
  });

  telemetry.dispose();
});

test("uncaught errors are captured through onerror and unhandledrejection", {concurrency: false}, async () => {
  let {console_impl} = make_console();
  let {scope, dispatch} = make_scope();
  let previous_onerror_called = false;
  scope.onerror = () => {
    previous_onerror_called = true;
  };
  let sent = [];
  let timer = make_timer();

  let telemetry = init_telemetry({
    console_impl,
    global_scope: scope,
    send_beacon: (url, blob) => {
      sent.push(blob);
      return true;
    },
    now: () => 7,
    generate_id: () => "s",
    set_interval: timer.set_interval,
    clear_interval: timer.clear_interval,
  });

  scope.onerror("msg", "file.js", 1, 2, new Error("kaboom"));
  dispatch("unhandledrejection", {reason: new Error("rejected")});

  telemetry.flush();
  let payload = JSON.parse(await sent[0].text());
  assert.equal(payload.entries.length, 2);
  assert.equal(payload.entries[0].source, "error");
  assert.equal(payload.entries[0].level, "error");
  assert.match(payload.entries[0].message, /kaboom/);
  assert.match(payload.entries[1].message, /rejected/);
  assert.equal(previous_onerror_called, true);

  telemetry.dispose();
});

test("falls back to fetch keepalive when sendBeacon is missing or returns false", {concurrency: false}, async () => {
  let {console_impl} = make_console();
  let {scope} = make_scope();
  let fetches = [];
  let timer = make_timer();

  let telemetry = init_telemetry({
    console_impl,
    global_scope: scope,
    send_beacon: () => false,
    fetch_impl: async (url, init) => {
      fetches.push({url, init});
      return {ok: true};
    },
    generate_id: () => "s",
    set_interval: timer.set_interval,
    clear_interval: timer.clear_interval,
  });

  console_impl.log("fallback");
  telemetry.flush();

  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].url, "/api/telemetry");
  assert.equal(fetches[0].init.method, "POST");
  assert.equal(fetches[0].init.keepalive, true);
  let payload = JSON.parse(fetches[0].init.body);
  assert.equal(payload.entries[0].message, "fallback");

  telemetry.dispose();
});

test("record flushes automatically when the buffer cap is reached", {concurrency: false}, async () => {
  let {console_impl} = make_console();
  let {scope} = make_scope();
  let sent = [];
  let timer = make_timer();

  let telemetry = init_telemetry({
    console_impl,
    global_scope: scope,
    send_beacon: (url, blob) => {
      sent.push(blob);
      return true;
    },
    max_entries: 3,
    generate_id: () => "s",
    set_interval: timer.set_interval,
    clear_interval: timer.clear_interval,
  });

  console_impl.log("a");
  console_impl.log("b");
  assert.equal(sent.length, 0);
  console_impl.log("c");
  assert.equal(sent.length, 1);
  let payload = JSON.parse(await sent[0].text());
  assert.equal(payload.entries.length, 3);

  telemetry.dispose();
});

test("telemetry never throws when the transport fails", {concurrency: false}, async () => {
  let {console_impl} = make_console();
  let {scope, dispatch} = make_scope();
  let timer = make_timer();

  let telemetry = init_telemetry({
    console_impl,
    global_scope: scope,
    send_beacon: () => {
      throw new Error("beacon exploded");
    },
    fetch_impl: () => {
      throw new Error("fetch exploded");
    },
    generate_id: () => "s",
    set_interval: timer.set_interval,
    clear_interval: timer.clear_interval,
  });

  // None of these should throw despite the exploding transports.
  assert.doesNotThrow(() => {
    console_impl.log("boom");
    telemetry.flush();
    timer.tick();
    dispatch("pagehide");
    telemetry.record({level: "warn", source: "error", message: "manual"});
    telemetry.dispose();
  });
});
