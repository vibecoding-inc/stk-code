// Client-side telemetry collector for the WebAssembly web build.
//
// This module mirrors the dependency-injected style of discord-activity.js so
// it can be unit tested with fake console/sendBeacon/Module/timers. It captures
// engine stdout/stderr, JS console output, and uncaught errors, buffers them,
// and ships batched entries to the same-origin /api/telemetry Worker route.
//
// Everything here is fail-open: any internal error is swallowed so telemetry
// can never break game startup.

let CONSOLE_LEVELS = ["log", "info", "warn", "error"];
let KNOWN_LEVELS = ["log", "info", "warn", "error"];
let KNOWN_SOURCES = ["engine", "console", "error"];

function safe_stringify(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) {
    return value.stack || `${value.name}: ${value.message}`;
  }
  try {
    return JSON.stringify(value);
  }
  catch {
    try {
      return String(value);
    }
    catch {
      return "[unserializable]";
    }
  }
}

function format_args(args) {
  try {
    return args.map(safe_stringify).join(" ");
  }
  catch {
    return "";
  }
}

export function init_telemetry({
  module,
  console_impl,
  send_beacon,
  fetch_impl,
  get_metadata,
  now,
  flush_interval_ms,
  global_scope,
  generate_id,
  set_interval,
  clear_interval,
  endpoint,
  max_entries,
} = {}) {
  let scope = global_scope || (typeof globalThis !== "undefined" ? globalThis : {});
  let console_target = console_impl || scope.console || {};
  let timestamp = typeof now === "function" ? now : () => Date.now();
  let interval_ms = typeof flush_interval_ms === "number" ? flush_interval_ms : 5000;
  let buffer_cap = typeof max_entries === "number" ? max_entries : 100;
  let target_url = endpoint || "/api/telemetry";

  let start_timer =
    typeof set_interval === "function"
      ? set_interval
      : typeof scope.setInterval === "function"
        ? scope.setInterval.bind(scope)
        : typeof setInterval === "function"
          ? setInterval
          : null;
  let stop_timer =
    typeof clear_interval === "function"
      ? clear_interval
      : typeof scope.clearInterval === "function"
        ? scope.clearInterval.bind(scope)
        : typeof clearInterval === "function"
          ? clearInterval
          : null;

  let make_id =
    typeof generate_id === "function"
      ? generate_id
      : () => {
          try {
            if (scope.crypto && typeof scope.crypto.randomUUID === "function") {
              return scope.crypto.randomUUID();
            }
          }
          catch {}
          return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        };

  let beacon =
    typeof send_beacon === "function"
      ? send_beacon
      : scope.navigator && typeof scope.navigator.sendBeacon === "function"
        ? scope.navigator.sendBeacon.bind(scope.navigator)
        : null;
  let fetcher =
    typeof fetch_impl === "function"
      ? fetch_impl
      : typeof scope.fetch === "function"
        ? scope.fetch.bind(scope)
        : null;

  let session = make_id();
  let buffer = [];
  let enriched = {};
  let disposed = false;

  let restore_console = [];
  let restore_module = [];
  let listeners = [];
  let previous_onerror = null;
  let onerror_installed = false;
  let timer_id = null;

  function coerce_level(level) {
    return KNOWN_LEVELS.includes(level) ? level : "log";
  }

  function coerce_source(source) {
    return KNOWN_SOURCES.includes(source) ? source : "console";
  }

  function record(entry) {
    try {
      if (disposed || !entry) return;
      buffer.push({
        ts: typeof entry.ts === "number" ? entry.ts : timestamp(),
        level: coerce_level(entry.level),
        source: coerce_source(entry.source),
        message: typeof entry.message === "string" ? entry.message : safe_stringify(entry.message),
      });
      if (buffer.length >= buffer_cap) {
        flush();
      }
    }
    catch {}
  }

  function build_meta() {
    let dynamic = {};
    try {
      if (typeof get_metadata === "function") {
        let value = get_metadata();
        if (value && typeof value === "object") dynamic = value;
      }
    }
    catch {}
    return {...dynamic, ...enriched};
  }

  function flush() {
    try {
      if (buffer.length === 0) return;
      let entries = buffer;
      buffer = [];

      let payload = {
        session,
        meta: build_meta(),
        entries,
      };
      let body = JSON.stringify(payload);

      let sent = false;
      if (beacon) {
        try {
          let blob = typeof Blob !== "undefined"
            ? new Blob([body], {type: "application/json"})
            : body;
          sent = beacon(target_url, blob) === true;
        }
        catch {
          sent = false;
        }
      }

      if (!sent && fetcher) {
        try {
          let result = fetcher(target_url, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body,
            keepalive: true,
          });
          // Swallow async rejections so a failed send never surfaces.
          if (result && typeof result.catch === "function") {
            result.catch(() => {});
          }
        }
        catch {}
      }
    }
    catch {}
  }

  function enrich(metadata) {
    try {
      if (metadata && typeof metadata === "object") {
        Object.assign(enriched, metadata);
      }
    }
    catch {}
  }

  function wrap_console() {
    try {
      for (let level of CONSOLE_LEVELS) {
        let original =
          typeof console_target[level] === "function"
            ? console_target[level].bind(console_target)
            : null;
        restore_console.push({level, original: console_target[level]});
        console_target[level] = (...args) => {
          record({level, source: "console", message: format_args(args)});
          if (original) {
            try {
              original(...args);
            }
            catch {}
          }
        };
      }
    }
    catch {}
  }

  function wrap_module() {
    try {
      if (!module || typeof module !== "object") return;
      // index.html pre-wires Module.print/printErr/onAbort before
      // supertuxkart.js loads so Emscripten binds out/err directly and never
      // installs ASSERTIONS getter traps; don't double-wrap in that case.
      if (module.__stkTelemetryHooked) return;
      let pairs = [
        {key: "print", level: "log", source: "engine", urgent: false},
        {key: "printErr", level: "error", source: "engine", urgent: false},
        {key: "onAbort", level: "error", source: "error", urgent: true},
      ];
      for (let {key, level, source, urgent} of pairs) {
        // Never invoke an accessor getter on Module: with -sASSERTIONS=1,
        // Emscripten installs getter traps on unexported runtime methods
        // (including print/printErr) that call abort() when read.
        let desc = Object.getOwnPropertyDescriptor(module, key);
        if (desc && (typeof desc.get === "function" || typeof desc.set === "function")) {
          continue;
        }
        let previous =
          typeof module[key] === "function" ? module[key].bind(module) : null;
        restore_module.push({key, original: module[key]});
        module[key] = (text) => {
          let rendered = typeof text === "string" ? text : safe_stringify(text);
          let message = key === "onAbort" ? `Emscripten abort: ${rendered}` : rendered;
          record({level, source, message});
          if (urgent) {
            flush();
          }
          if (previous) {
            try {
              previous(text);
            }
            catch {}
          }
        };
      }
    }
    catch {}
  }

  function drain_early_queue() {
    try {
      let queue = scope.__stkEarlyTelemetry;
      if (!Array.isArray(queue) || queue.length === 0) return;
      let entries = queue.splice(0, queue.length);
      let should_flush = false;
      for (let entry of entries) {
        if (!entry || typeof entry !== "object") continue;
        record(entry);
        if (entry.urgent) should_flush = true;
      }
      if (should_flush) {
        flush();
      }
    }
    catch {}
  }

  function add_listener(event, handler) {
    try {
      if (typeof scope.addEventListener === "function") {
        scope.addEventListener(event, handler);
        listeners.push({event, handler});
      }
    }
    catch {}
  }

  function install_error_handlers() {
    try {
      previous_onerror = scope.onerror || null;
      scope.onerror = (message, source, lineno, colno, error) => {
        record({
          level: "error",
          source: "error",
          message: error ? safe_stringify(error) : safe_stringify(message),
        });
        flush();
        if (typeof previous_onerror === "function") {
          try {
            return previous_onerror(message, source, lineno, colno, error);
          }
          catch {}
        }
        return false;
      };
      onerror_installed = true;
    }
    catch {}

    add_listener("unhandledrejection", (event) => {
      let reason = event && "reason" in event ? event.reason : event;
      record({level: "error", source: "error", message: safe_stringify(reason)});
      flush();
    });
  }

  function install_unload_handlers() {
    add_listener("pagehide", () => {
      flush();
    });
    add_listener("visibilitychange", () => {
      try {
        let doc = scope.document;
        if (!doc || doc.visibilityState === "hidden") {
          flush();
        }
      }
      catch {
        flush();
      }
    });
  }

  function start_flush_timer() {
    try {
      if (start_timer && interval_ms > 0) {
        timer_id = start_timer(() => {
          flush();
        }, interval_ms);
      }
    }
    catch {}
  }

  function dispose() {
    try {
      if (disposed) return;
      flush();
      disposed = true;

      if (timer_id !== null && stop_timer) {
        try {
          stop_timer(timer_id);
        }
        catch {}
        timer_id = null;
      }

      for (let {level, original} of restore_console) {
        try {
          console_target[level] = original;
        }
        catch {}
      }
      restore_console = [];

      for (let {key, original} of restore_module) {
        try {
          module[key] = original;
        }
        catch {}
      }
      restore_module = [];

      for (let {event, handler} of listeners) {
        try {
          if (typeof scope.removeEventListener === "function") {
            scope.removeEventListener(event, handler);
          }
        }
        catch {}
      }
      listeners = [];

      if (onerror_installed) {
        try {
          scope.onerror = previous_onerror;
        }
        catch {}
        onerror_installed = false;
      }
    }
    catch {}
  }

  wrap_console();
  wrap_module();
  install_error_handlers();
  install_unload_handlers();
  start_flush_timer();
  drain_early_queue();

  return {
    session,
    record,
    flush,
    enrich,
    dispose,
  };
}

// Gather browser, iframe/Discord, threading, WebGL, and storage diagnostics
// using a temporary detached canvas (so the game's #canvas is never touched).
// Always fail-open: returns whatever subset of fields could be read.
export async function collect_environment_diagnostics({global_scope} = {}) {
  let scope = global_scope || (typeof globalThis !== "undefined" ? globalThis : {});
  let nav = scope.navigator || {};
  let loc = scope.location || {};
  let doc = scope.document || null;

  let is_discord_activity = false;
  try {
    is_discord_activity = new URLSearchParams(loc.search || "").has("frame_id");
  }
  catch {}

  let in_iframe = false;
  try {
    in_iframe = Boolean(scope.self && scope.top && scope.self !== scope.top);
  }
  catch {
    // Cross-origin access to window.top throws -> definitely inside an iframe.
    in_iframe = true;
  }

  let is_mobile = false;
  try {
    if (nav.userAgentData && typeof nav.userAgentData.mobile === "boolean") {
      is_mobile = nav.userAgentData.mobile;
    }
    else if (typeof nav.userAgent === "string") {
      is_mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent);
    }
  }
  catch {}

  let diag = {
    is_discord_activity,
    in_iframe,
    is_mobile,
    cross_origin_isolated: scope.crossOriginIsolated === true,
    shared_array_buffer: typeof scope.SharedArrayBuffer !== "undefined",
    atomics: typeof scope.Atomics !== "undefined",
    webassembly: typeof scope.WebAssembly !== "undefined",
    indexed_db: typeof scope.indexedDB !== "undefined",
    hardware_concurrency: typeof nav.hardwareConcurrency === "number" ? nav.hardwareConcurrency : null,
    device_memory_gb: typeof nav.deviceMemory === "number" ? nav.deviceMemory : null,
    platform: typeof nav.platform === "string" ? nav.platform : null,
    language: typeof nav.language === "string" ? nav.language : null,
    viewport:
      typeof scope.innerWidth === "number" && typeof scope.innerHeight === "number"
        ? `${scope.innerWidth}x${scope.innerHeight}`
        : null,
    dpr: typeof scope.devicePixelRatio === "number" ? scope.devicePixelRatio : null,
    webgl2: false,
    webgl1: false,
    webgl_vendor: null,
    webgl_renderer: null,
    webgl_version: null,
    webgl_max_texture_size: null,
    storage_quota_mb: null,
    storage_usage_mb: null,
  };

  try {
    if (doc && typeof doc.createElement === "function") {
      let probe = doc.createElement("canvas");
      let gl = probe && typeof probe.getContext === "function" ? probe.getContext("webgl2") : null;
      if (gl) {
        diag.webgl2 = true;
      }
      else if (probe && typeof probe.getContext === "function") {
        gl = probe.getContext("webgl");
        if (gl) diag.webgl1 = true;
      }
      if (gl) {
        try {
          diag.webgl_version = gl.getParameter(gl.VERSION) || null;
          diag.webgl_max_texture_size = gl.getParameter(gl.MAX_TEXTURE_SIZE) || null;
          let dbg = typeof gl.getExtension === "function" ? gl.getExtension("WEBGL_debug_renderer_info") : null;
          if (dbg) {
            diag.webgl_vendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || null;
            diag.webgl_renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || null;
          }
          else {
            diag.webgl_vendor = gl.getParameter(gl.VENDOR) || null;
            diag.webgl_renderer = gl.getParameter(gl.RENDERER) || null;
          }
        }
        catch {}
        try {
          let lose = typeof gl.getExtension === "function" ? gl.getExtension("WEBGL_lose_context") : null;
          if (lose && typeof lose.loseContext === "function") lose.loseContext();
        }
        catch {}
      }
    }
  }
  catch {}

  try {
    if (nav.storage && typeof nav.storage.estimate === "function") {
      let est = await nav.storage.estimate();
      if (est && typeof est.quota === "number") {
        diag.storage_quota_mb = Math.round(est.quota / (1024 * 1024));
      }
      if (est && typeof est.usage === "number") {
        diag.storage_usage_mb = Math.round(est.usage / (1024 * 1024));
      }
    }
  }
  catch {}

  return diag;
}

// Pick a sensible default texture quality ("low" | "mid" | "high") from the
// environment diagnostics gathered at startup. Never auto-starts the game;
// simply pre-selects the best matching quality button for the device.
export function recommend_quality(diag) {
  if (!diag || typeof diag !== "object") return "low";

  // Mobile devices, missing WebGL2, or software renderers stay on "low".
  if (diag.is_mobile) return "low";
  if (!diag.webgl2) return "low";

  let renderer = typeof diag.webgl_renderer === "string" ? diag.webgl_renderer : "";
  if (/swiftshader|llvmpipe|software|microsoft basic render|lavapipe/i.test(renderer)) {
    return "low";
  }

  let cores = typeof diag.hardware_concurrency === "number" ? diag.hardware_concurrency : null;
  let mem = typeof diag.device_memory_gb === "number" ? diag.device_memory_gb : null;
  let max_tex = typeof diag.webgl_max_texture_size === "number" ? diag.webgl_max_texture_size : null;
  let quota = typeof diag.storage_quota_mb === "number" ? diag.storage_quota_mb : null;

  if (mem !== null && mem <= 4) return "low";
  if (cores !== null && cores <= 2) return "low";
  if (max_tex !== null && max_tex < 4096) return "low";
  if (quota !== null && quota < 600) return "low";

  // Good desktop/laptop: >= 8 GB RAM (or >= 8 cores when deviceMemory is hidden)
  // with hardware WebGL2, >= 8192 max texture size, and >= 1 GB storage quota.
  let strong_memory_or_cpu =
    (mem !== null && mem >= 8 && (cores === null || cores >= 4)) ||
    (mem === null && cores !== null && cores >= 8);
  let strong_gpu = max_tex === null || max_tex >= 8192;
  let ample_storage = quota === null || quota >= 1024;

  if (strong_memory_or_cpu && strong_gpu && ample_storage) {
    return "high";
  }

  // Mid-range desktop / laptop.
  if (cores !== null && cores >= 4) {
    return "mid";
  }

  return "low";
}
