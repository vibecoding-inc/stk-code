// Same-origin telemetry ingest for the SuperTuxKart WebAssembly web build.
//
// The browser collector (wasm/web/telemetry.js) batches engine stdout/stderr,
// JS console output and uncaught errors, then ships them here via
// navigator.sendBeacon (or fetch with keepalive) as POST /api/telemetry. This
// handler validates/clamps the batch and fans it out to two Cloudflare-native
// sinks:
//   - Analytics Engine (env.TELEMETRY) for queryable ~90-day history.
//   - Workers Logs (console.*) for live `wrangler tail`.
//
// Everything is defensive: a noisy or malformed client must never take the
// Worker down, and writes are fire-and-forget so ingest stays fast.

// Analytics Engine allows up to 20 blobs, 16 KB per blob and 1 index per data
// point. We stay well under those limits: a handful of low-cardinality blobs
// plus a single truncated message, indexed by the session id.
const MAX_ENTRIES_PER_BATCH = 100;
const MAX_MESSAGE_BYTES = 2048;
const MAX_META_FIELD_LENGTH = 256;

const KNOWN_LEVELS = ["log", "info", "warn", "error"];
const KNOWN_SOURCES = ["engine", "console", "error"];

function coerce_level(level) {
  return KNOWN_LEVELS.includes(level) ? level : "log";
}

function coerce_source(source) {
  return KNOWN_SOURCES.includes(source) ? source : "console";
}

// Truncate a string to at most max_bytes of UTF-8, appending an ellipsis marker
// when clamped. Analytics Engine rejects blobs over 16 KB, so this keeps every
// message comfortably small regardless of what the client sends.
function truncate(value, max_bytes) {
  let text = typeof value === "string" ? value : String(value ?? "");
  // Fast path: ASCII-ish strings shorter than the cap can't exceed it.
  if (text.length <= max_bytes) return text;
  const encoder = new TextEncoder();
  let bytes = encoder.encode(text);
  if (bytes.length <= max_bytes) return text;
  const marker = "...[truncated]";
  let slice = bytes.slice(0, Math.max(0, max_bytes - marker.length));
  let decoded = new TextDecoder().decode(slice);
  // Drop a possibly broken trailing character from the decode.
  return decoded + marker;
}

function clamp_meta_field(value) {
  if (value === null || value === undefined) return "";
  let text = typeof value === "string" ? value : String(value);
  return text.length > MAX_META_FIELD_LENGTH
    ? text.slice(0, MAX_META_FIELD_LENGTH)
    : text;
}

function to_iso(ts) {
  let n = typeof ts === "number" ? ts : Number(ts);
  if (!Number.isFinite(n)) return "";
  try {
    return new Date(n).toISOString();
  }
  catch {
    return "";
  }
}

function finite_or(value, fallback) {
  let n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// Parse the request body as JSON, tolerating sendBeacon deliveries that arrive
// as text/plain as well as regular application/json posts.
async function parse_body(request) {
  let text;
  try {
    text = await request.text();
  }
  catch {
    return {ok: false};
  }
  if (!text) return {ok: false};
  try {
    return {ok: true, value: JSON.parse(text)};
  }
  catch {
    return {ok: false};
  }
}

export async function handleTelemetry({request, env, ctx}) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {status: 405});
  }

  let parsed = await parse_body(request);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
    return new Response("Invalid JSON body.", {status: 400});
  }

  let payload = parsed.value;
  let session = clamp_meta_field(payload.session) || "unknown";
  let meta = payload.meta && typeof payload.meta === "object" ? payload.meta : {};

  let build_version = clamp_meta_field(meta.build_version);
  let quality = clamp_meta_field(meta.quality);
  let discord_user_id = clamp_meta_field(meta.discord_user_id);
  let user_agent = clamp_meta_field(meta.user_agent);
  let memory_mb = finite_or(meta.memory_mb, 0);
  let load_ms = finite_or(meta.load_ms, 0);

  let raw_entries = Array.isArray(payload.entries) ? payload.entries : [];
  let entries = raw_entries.slice(0, MAX_ENTRIES_PER_BATCH);

  let telemetry = env && env.TELEMETRY;
  let can_write = telemetry && typeof telemetry.writeDataPoint === "function";

  for (let entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    let level = coerce_level(entry.level);
    let source = coerce_source(entry.source);
    let message = truncate(entry.message, MAX_MESSAGE_BYTES);
    let original_ts = to_iso(entry.ts);

    if (can_write) {
      try {
        // Fire-and-forget: no await, so a slow/failed write never blocks ingest.
        telemetry.writeDataPoint({
          indexes: [session],
          blobs: [
            level,
            source,
            message,
            discord_user_id,
            build_version,
            quality,
            user_agent,
            original_ts,
          ],
          doubles: [1, memory_mb, load_ms],
        });
      }
      catch {
        // Swallow: telemetry must never surface an error to the client.
      }
    }

    // Echo a compact structured line to Workers Logs, keyed by level so
    // `wrangler tail` can filter. Kept small to avoid log bloat.
    let line = {
      msg: "telemetry",
      session,
      source,
      level,
      build_version,
      quality,
      discord_user_id,
      message,
    };
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }

  return new Response(null, {status: 204});
}
