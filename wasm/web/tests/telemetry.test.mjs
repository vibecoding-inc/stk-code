import assert from "node:assert/strict";
import test from "node:test";

import { init_telemetry, collect_environment_diagnostics, recommend_quality } from "../telemetry.js";

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

  // Uncaught errors flush immediately so startup/fatal crashes aren't lost.
  assert.equal(sent.length, 2);
  let first = JSON.parse(await sent[0].text());
  let second = JSON.parse(await sent[1].text());
  assert.equal(first.entries.length, 1);
  assert.equal(first.entries[0].source, "error");
  assert.equal(first.entries[0].level, "error");
  assert.match(first.entries[0].message, /kaboom/);
  assert.equal(second.entries.length, 1);
  assert.match(second.entries[0].message, /rejected/);
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

test("wrap_module skips Emscripten ASSERTIONS getter traps without invoking them", {concurrency: false}, () => {
  let {scope} = make_scope();
  let timer = make_timer();
  let getter_called = false;
  let module = {};
  for (let key of ["print", "printErr"]) {
    Object.defineProperty(module, key, {
      configurable: true,
      get() {
        getter_called = true;
        throw new Error(`'${key}' was not exported. add it to EXPORTED_RUNTIME_METHODS`);
      },
    });
  }

  let telemetry = init_telemetry({
    module,
    console_impl: {log() {}, info() {}, warn() {}, error() {}},
    global_scope: scope,
    send_beacon: () => true,
    generate_id: () => "s",
    set_interval: timer.set_interval,
    clear_interval: timer.clear_interval,
  });

  assert.equal(getter_called, false);
  telemetry.dispose();
  assert.equal(getter_called, false);
});

test("Module.onAbort records an error and flushes immediately", {concurrency: false}, async () => {
  let {scope} = make_scope();
  let timer = make_timer();
  let sent = [];
  let prev_abort_arg = null;
  let module = {
    onAbort: (what) => {
      prev_abort_arg = what;
    },
  };

  let telemetry = init_telemetry({
    module,
    console_impl: {log() {}, info() {}, warn() {}, error() {}},
    global_scope: scope,
    send_beacon: (url, blob) => {
      sent.push(blob);
      return true;
    },
    now: () => 500,
    generate_id: () => "s",
    set_interval: timer.set_interval,
    clear_interval: timer.clear_interval,
  });

  module.onAbort("wasm-instantiate failed");
  assert.equal(prev_abort_arg, "wasm-instantiate failed");
  assert.equal(sent.length, 1);
  let payload = JSON.parse(await sent[0].text());
  assert.equal(payload.entries.length, 1);
  assert.deepEqual(payload.entries[0], {
    ts: 500,
    level: "error",
    source: "error",
    message: "Emscripten abort: wasm-instantiate failed",
  });

  telemetry.dispose();
});

test("drains pre-init __stkEarlyTelemetry queue and flushes urgent entries immediately", {concurrency: false}, async () => {
  let {scope} = make_scope();
  let timer = make_timer();
  let sent = [];
  scope.__stkEarlyTelemetry = [
    {ts: 10, level: "log", source: "engine", message: "early stdout", urgent: false},
    {ts: 20, level: "error", source: "error", message: "Emscripten abort: boom", urgent: true},
  ];

  let telemetry = init_telemetry({
    module: {__stkTelemetryHooked: true, print() {}},
    console_impl: {log() {}, info() {}, warn() {}, error() {}},
    global_scope: scope,
    send_beacon: (url, blob) => {
      sent.push(blob);
      return true;
    },
    generate_id: () => "s",
    set_interval: timer.set_interval,
    clear_interval: timer.clear_interval,
  });

  assert.equal(scope.__stkEarlyTelemetry.length, 0);
  assert.equal(sent.length, 1);
  let payload = JSON.parse(await sent[0].text());
  assert.equal(payload.entries.length, 2);
  assert.equal(payload.entries[0].message, "early stdout");
  assert.equal(payload.entries[1].message, "Emscripten abort: boom");

  telemetry.dispose();
});

test("collect_environment_diagnostics reports Discord iframe, COI, WebGL2, and storage", {concurrency: false}, async () => {
  let context_lost = false;
  let fake_gl = {
    VERSION: 0x1f02,
    MAX_TEXTURE_SIZE: 0x0d33,
    VENDOR: 0x1f00,
    RENDERER: 0x1f01,
    getParameter(p) {
      if (p === 0x1f02) return "WebGL 2.0";
      if (p === 0x0d33) return 8192;
      if (p === 0x9245) return "TestVendor";
      if (p === 0x9246) return "TestGPU";
      return null;
    },
    getExtension(name) {
      if (name === "WEBGL_debug_renderer_info") {
        return {UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246};
      }
      if (name === "WEBGL_lose_context") {
        return {loseContext() { context_lost = true; }};
      }
      return null;
    },
  };

  let fake_scope = {
    location: {search: "?frame_id=abc&instance_id=xyz"},
    self: {},
    top: {},
    crossOriginIsolated: true,
    SharedArrayBuffer: function SharedArrayBuffer() {},
    Atomics: {},
    WebAssembly: {},
    indexedDB: {},
    innerWidth: 1280,
    innerHeight: 720,
    devicePixelRatio: 2,
    navigator: {
      hardwareConcurrency: 8,
      deviceMemory: 16,
      platform: "Linux x86_64",
      language: "en-US",
      storage: {
        async estimate() {
          return {quota: 500 * 1024 * 1024, usage: 120 * 1024 * 1024};
        },
      },
    },
    document: {
      createElement(tag) {
        assert.equal(tag, "canvas");
        return {
          getContext(type) {
            return type === "webgl2" ? fake_gl : null;
          },
        };
      },
    },
  };

  let diag = await collect_environment_diagnostics({global_scope: fake_scope});
  assert.equal(diag.is_discord_activity, true);
  assert.equal(diag.in_iframe, true);
  assert.equal(diag.cross_origin_isolated, true);
  assert.equal(diag.shared_array_buffer, true);
  assert.equal(diag.hardware_concurrency, 8);
  assert.equal(diag.device_memory_gb, 16);
  assert.equal(diag.viewport, "1280x720");
  assert.equal(diag.webgl2, true);
  assert.equal(diag.webgl_vendor, "TestVendor");
  assert.equal(diag.webgl_renderer, "TestGPU");
  assert.equal(diag.webgl_max_texture_size, 8192);
  assert.equal(diag.storage_quota_mb, 500);
  assert.equal(diag.storage_usage_mb, 120);
  assert.equal(context_lost, true);
});

test("collect_environment_diagnostics fails open on restricted environments", {concurrency: false}, async () => {
  let diag = await collect_environment_diagnostics({global_scope: {}});
  assert.equal(diag.is_discord_activity, false);
  assert.equal(diag.cross_origin_isolated, false);
  assert.equal(diag.shared_array_buffer, false);
  assert.equal(diag.webgl2, false);
  assert.equal(diag.storage_quota_mb, null);
});

test("recommend_quality selects high, mid, or low based on device capabilities", {concurrency: false}, () => {
  // Strong desktop (like Discord desktop on Linux/Windows/macOS) -> high
  assert.equal(recommend_quality({
    is_mobile: false,
    webgl2: true,
    webgl_renderer: "ANGLE (Intel, Mesa Intel(R) Graphics (MTL), OpenGL ES 3.2)",
    webgl_max_texture_size: 16384,
    hardware_concurrency: 22,
    device_memory_gb: 32,
    storage_quota_mb: 622741,
  }), "high");

  // Desktop without navigator.deviceMemory (e.g. Firefox/Safari) -> high on >=8 cores, mid on 4 cores
  assert.equal(recommend_quality({
    is_mobile: false,
    webgl2: true,
    webgl_renderer: "Apple GPU",
    webgl_max_texture_size: 16384,
    hardware_concurrency: 8,
    device_memory_gb: null,
    storage_quota_mb: 5000,
  }), "high");
  assert.equal(recommend_quality({
    is_mobile: false,
    webgl2: true,
    webgl_renderer: "Intel UHD",
    webgl_max_texture_size: 8192,
    hardware_concurrency: 4,
    device_memory_gb: null,
    storage_quota_mb: 5000,
  }), "mid");

  // Mobile, software renderer, low RAM, tight storage, or empty diag -> low
  assert.equal(recommend_quality({
    is_mobile: true,
    webgl2: true,
    webgl_max_texture_size: 8192,
    hardware_concurrency: 8,
    device_memory_gb: 8,
  }), "low");
  assert.equal(recommend_quality({
    is_mobile: false,
    webgl2: true,
    webgl_renderer: "Google SwiftShader",
    webgl_max_texture_size: 8192,
    hardware_concurrency: 16,
    device_memory_gb: 32,
  }), "low");
  assert.equal(recommend_quality({
    is_mobile: false,
    webgl2: true,
    hardware_concurrency: 8,
    device_memory_gb: 4,
    webgl_max_texture_size: 8192,
  }), "low");
  assert.equal(recommend_quality({
    is_mobile: false,
    webgl2: true,
    hardware_concurrency: 8,
    device_memory_gb: 16,
    webgl_max_texture_size: 8192,
    storage_quota_mb: 400,
  }), "low");
  assert.equal(recommend_quality(null), "low");
});

test("collect_environment_diagnostics reads Discord platform query param", {concurrency: false}, async () => {
  let mobile_diag = await collect_environment_diagnostics({
    global_scope: {
      location: {search: "?frame_id=123&platform=mobile"},
      navigator: {userAgent: "Mozilla/5.0 (X11; Linux x86_64)"},
    },
  });
  assert.equal(mobile_diag.is_discord_activity, true);
  assert.equal(mobile_diag.discord_platform, "mobile");
  assert.equal(mobile_diag.is_mobile, true);

  let desktop_diag = await collect_environment_diagnostics({
    global_scope: {
      location: {search: "?frame_id=123&platform=desktop"},
      navigator: {userAgent: "Mozilla/5.0 (Linux; Android 14)"},
    },
  });
  assert.equal(desktop_diag.is_discord_activity, true);
  assert.equal(desktop_diag.discord_platform, "desktop");
  assert.equal(desktop_diag.is_mobile, false);
});
