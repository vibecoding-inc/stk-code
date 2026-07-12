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
      let pairs = [
        {key: "print", level: "log"},
        {key: "printErr", level: "error"},
      ];
      for (let {key, level} of pairs) {
        let previous =
          typeof module[key] === "function" ? module[key].bind(module) : null;
        restore_module.push({key, original: module[key]});
        module[key] = (text) => {
          record({level, source: "engine", message: typeof text === "string" ? text : safe_stringify(text)});
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

  return {
    session,
    record,
    flush,
    enrich,
    dispose,
  };
}
