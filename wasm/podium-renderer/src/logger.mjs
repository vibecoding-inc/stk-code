/**
 * Lightweight tracing_subscriber-style structured logger for podium-renderer.
 * Format:
 *   2026-11-22T16:50:00.123Z  INFO podium_renderer::http: rendered podium req_id=1 status=200 duration_ms=98
 */

const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const LEVEL_LABELS = {
  debug: "DEBUG",
  info: " INFO",
  warn: " WARN",
  error: "ERROR",
};

function resolveMinLevel() {
  const raw = String(process.env.LOG_LEVEL || "info").trim().toLowerCase();
  return LEVELS[raw] ?? LEVELS.info;
}

function formatValue(val) {
  if (val === null || val === undefined) return "null";
  if (val instanceof Error) return JSON.stringify(val.message || String(val));
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  const str = String(val);
  if (str === "" || /[\s"=]/.test(str)) return JSON.stringify(str);
  return str;
}

function formatFields(fields) {
  if (!fields || typeof fields !== "object") return "";
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    parts.push(`${k}=${formatValue(v)}`);
  }
  return parts.length > 0 ? " " + parts.join(" ") : "";
}

export function createLogger(target) {
  function emit(level, message, fields) {
    if (LEVELS[level] < resolveMinLevel()) return;
    const line = `${new Date().toISOString()} ${LEVEL_LABELS[level]} ${target}: ${message}${formatFields(fields)}`;
    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}
