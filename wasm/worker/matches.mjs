// Multiplayer match scoreboards & server-side replay storage (Cloudflare Workers + D1 + R2).
//
// Gateway ingest routes (authenticated via `Authorization: Bearer <GATEWAY_API_SECRET>`):
//   POST /api/matches                     -> persist match metadata + scoreboard rows in D1
//   PUT  /api/matches/:match_id/replay    -> store (auto-gzipped) .replay in R2 & link to match
//
// Client read routes (authenticated via Discord Activity session JWT, ready for future viewer):
//   GET  /api/matches                     -> list recent matches visible in caller's scope
//   GET  /api/matches/:match_id           -> single match metadata + scoreboard
//   GET  /api/matches/:match_id/replay    -> stream raw gzipped .replay bytes from R2

import { authenticate_session, upsert_user, ensure_scope_member } from "./time-trials.mjs";

const MAX_REPLAY_RAW_BYTES = 16 * 1024 * 1024; // 16 MiB uncompressed ASCII ceiling
const MAX_REPLAY_GZIP_BYTES = 2 * 1024 * 1024; // 2 MiB gzipped ceiling (up to 16 karts)
const MAX_RESULTS_PER_MATCH = 32;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;

function json_response(body, status = 200, extra_headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...extra_headers,
    },
  });
}

function extract_bearer(request) {
  let header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Bearer ")) return null;
  let token = header.slice("Bearer ".length).trim();
  return token || null;
}

function constant_time_equal(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  let a_bytes = new TextEncoder().encode(a);
  let b_bytes = new TextEncoder().encode(b);
  if (a_bytes.length !== b_bytes.length) return false;
  let diff = 0;
  for (let i = 0; i < a_bytes.length; i++) {
    diff |= a_bytes[i] ^ b_bytes[i];
  }
  return diff === 0;
}

function authenticate_gateway(request, env) {
  if (!env || !env.GATEWAY_API_SECRET) {
    return {error: json_response({error: "GATEWAY_API_SECRET is not configured."}, 503)};
  }
  let token = extract_bearer(request);
  if (!token || !constant_time_equal(token, env.GATEWAY_API_SECRET)) {
    return {error: json_response({error: "Unauthorized gateway token."}, 401)};
  }
  return {ok: true};
}

function is_gzip_bytes(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export async function ensure_gzipped_bytes(input_bytes) {
  let bytes = input_bytes instanceof Uint8Array ? input_bytes : new Uint8Array(input_bytes);
  if (is_gzip_bytes(bytes)) {
    return bytes;
  }
  let stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  }).pipeThrough(new CompressionStream("gzip"));
  let compressed = await new Response(stream).arrayBuffer();
  return new Uint8Array(compressed);
}

function clean_optional_str(value, max_len = 128) {
  if (typeof value !== "string") return null;
  let trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max_len);
}

function parse_int_in_range(value, min, max, fallback = null) {
  let num = Number(value);
  if (!Number.isInteger(num) || num < min || num > max) return fallback;
  return num;
}

function validate_match_payload(body) {
  if (!body || typeof body !== "object") {
    return {error: "Request body must be a JSON object."};
  }

  let instance_id = clean_optional_str(body.instance_id, 128);
  if (!instance_id) {
    return {error: "Missing or invalid instance_id."};
  }

  let track = clean_optional_str(body.track, 64);
  if (!track || !/^[A-Za-z0-9_-]+$/.test(track)) {
    return {error: "Missing or invalid track."};
  }

  let mode = clean_optional_str(body.mode, 64) || "normal";
  let difficulty = parse_int_in_range(body.difficulty, 0, 3, 1);
  let laps = parse_int_in_range(body.laps, 0, 99, 0);
  let reverse = body.reverse ? 1 : 0;

  let scope_type = clean_optional_str(body.scope_type, 16);
  if (scope_type && scope_type !== "guild" && scope_type !== "dm") {
    scope_type = null;
  }
  let scope_id = scope_type ? clean_optional_str(body.scope_id, 64) : null;
  if (!scope_id) scope_type = null;
  let channel_id = clean_optional_str(body.channel_id, 64);

  let played_at = Number(body.played_at);
  if (!Number.isFinite(played_at) || played_at <= 0) {
    played_at = Date.now();
  } else {
    played_at = Math.floor(played_at);
  }

  if (!Array.isArray(body.results) || body.results.length === 0) {
    return {error: "results must be a non-empty array."};
  }
  if (body.results.length > MAX_RESULTS_PER_MATCH) {
    return {error: `results cannot exceed ${MAX_RESULTS_PER_MATCH} entries.`};
  }

  let results = [];
  for (let i = 0; i < body.results.length; i++) {
    let r = body.results[i];
    if (!r || typeof r !== "object") {
      return {error: `results[${i}] must be an object.`};
    }
    let kart_index = parse_int_in_range(r.kart_index, 0, MAX_RESULTS_PER_MATCH - 1, i);
    let display_name = clean_optional_str(r.display_name, 64) || "Player";
    let kart = clean_optional_str(r.kart, 64) || "tux";
    let kart_color = Number.isFinite(Number(r.kart_color)) ? Number(r.kart_color) : 0.0;
    let rank = parse_int_in_range(r.rank, 1, MAX_RESULTS_PER_MATCH, i + 1);
    let dnf = r.dnf ? 1 : 0;
    let is_ai = r.is_ai ? 1 : 0;
    let discord_user_id = is_ai ? null : clean_optional_str(r.discord_user_id, 64);
    let username = is_ai ? null : clean_optional_str(r.username, 64);

    let finish_time_ms = null;
    if (!dnf && r.finish_time_ms !== null && r.finish_time_ms !== undefined) {
      let t = Math.round(Number(r.finish_time_ms));
      if (Number.isFinite(t) && t > 0 && t < 3_600_000) {
        finish_time_ms = t;
      }
    }

    results.push({
      kart_index,
      discord_user_id,
      username,
      display_name,
      kart,
      kart_color,
      rank,
      finish_time_ms,
      dnf,
      is_ai,
    });
  }

  return {
    match: {
      instance_id,
      scope_type,
      scope_id,
      channel_id,
      track,
      mode,
      difficulty,
      laps,
      reverse,
      played_at,
      results,
    },
  };
}

async function handleCreateMatch({request, env}) {
  let auth = authenticate_gateway(request, env);
  if (auth.error) return auth.error;

  if (!env.TIME_TRIALS_DB) {
    return json_response({error: "D1 database is not configured."}, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json_response({error: "Invalid JSON body."}, 400);
  }

  let parsed = validate_match_payload(body);
  if (parsed.error) {
    return json_response({error: parsed.error}, 400);
  }

  let m = parsed.match;
  let match_id = crypto.randomUUID().replace(/-/g, "");
  let now = Date.now();

  await env.TIME_TRIALS_DB
    .prepare(
      `INSERT INTO matches
       (match_id, instance_id, scope_type, scope_id, channel_id,
        track, mode, difficulty, laps, reverse, played_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      match_id,
      m.instance_id,
      m.scope_type,
      m.scope_id,
      m.channel_id,
      m.track,
      m.mode,
      m.difficulty,
      m.laps,
      m.reverse,
      m.played_at
    )
    .run();

  for (let r of m.results) {
    await env.TIME_TRIALS_DB
      .prepare(
        `INSERT INTO match_results
         (match_id, kart_index, discord_user_id, display_name,
          kart, kart_color, rank, finish_time_ms, dnf, is_ai)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        match_id,
        r.kart_index,
        r.discord_user_id,
        r.display_name,
        r.kart,
        r.kart_color,
        r.rank,
        r.finish_time_ms,
        r.dnf,
        r.is_ai
      )
      .run();

    if (r.discord_user_id) {
      await upsert_user(
        env.TIME_TRIALS_DB,
        {
          user_id: r.discord_user_id,
          username: r.username || r.display_name,
          display_name: r.display_name,
        },
        now
      );
      if (m.scope_type && m.scope_id) {
        await ensure_scope_member(
          env.TIME_TRIALS_DB,
          {
            scope_type: m.scope_type,
            scope_id: m.scope_id,
            user_id: r.discord_user_id,
          },
          now
        );
      }
    }
  }

  return json_response(
    {
      match_id,
      played_at: m.played_at,
      result_count: m.results.length,
    },
    201
  );
}

async function handleUploadMatchReplay({request, env, match_id}) {
  let auth = authenticate_gateway(request, env);
  if (auth.error) return auth.error;

  if (!env.TIME_TRIALS_DB || !env.REPLAYS) {
    return json_response({error: "D1 or R2 storage is not configured."}, 503);
  }

  let existing = await env.TIME_TRIALS_DB
    .prepare("SELECT match_id, track, replay_r2_key FROM matches WHERE match_id = ?")
    .bind(match_id)
    .first();
  if (!existing) {
    return json_response({error: "Match not found."}, 404);
  }

  let raw_buf;
  try {
    raw_buf = await request.arrayBuffer();
  } catch {
    return json_response({error: "Failed to read replay body."}, 400);
  }

  let raw_bytes = new Uint8Array(raw_buf);
  if (raw_bytes.length === 0 || raw_bytes.length > MAX_REPLAY_RAW_BYTES) {
    return json_response(
      {error: `Replay payload must be 1..${MAX_REPLAY_RAW_BYTES} bytes.`},
      400
    );
  }

  let gzip_bytes = await ensure_gzipped_bytes(raw_bytes);
  if (gzip_bytes.length === 0 || gzip_bytes.length > MAX_REPLAY_GZIP_BYTES) {
    return json_response(
      {error: `Compressed replay exceeds ${MAX_REPLAY_GZIP_BYTES} bytes.`},
      413
    );
  }

  let replay_version = parse_int_in_range(
    request.headers.get("X-Replay-Version"),
    1,
    100,
    4
  );

  let r2_key = `mp/${existing.track}/${match_id}.replay.gz`;
  await env.REPLAYS.put(r2_key, gzip_bytes, {
    httpMetadata: {
      contentType: "application/octet-stream",
      contentEncoding: "gzip",
    },
  });

  await env.TIME_TRIALS_DB
    .prepare(
      `UPDATE matches
       SET replay_r2_key = ?, replay_version = ?, replay_bytes = ?
       WHERE match_id = ?`
    )
    .bind(r2_key, replay_version, gzip_bytes.length, match_id)
    .run();

  return json_response({
    match_id,
    replay_r2_key: r2_key,
    replay_bytes: gzip_bytes.length,
    replay_version,
  });
}

async function load_results_for_match(db, match_id) {
  let rows = await db
    .prepare(
      `SELECT kart_index, discord_user_id, display_name, kart, kart_color,
              rank, finish_time_ms, dnf, is_ai
       FROM match_results
       WHERE match_id = ?
       ORDER BY rank ASC, kart_index ASC`
    )
    .bind(match_id)
    .all();

  return (rows.results || []).map((r) => ({
    kart_index: r.kart_index,
    discord_user_id: r.discord_user_id || null,
    display_name: r.display_name,
    kart: r.kart,
    kart_color: r.kart_color,
    rank: r.rank,
    finish_time_ms: r.finish_time_ms,
    dnf: Boolean(r.dnf),
    is_ai: Boolean(r.is_ai),
  }));
}

function format_match_row(row, results) {
  return {
    match_id: row.match_id,
    instance_id: row.instance_id,
    scope_type: row.scope_type || null,
    scope_id: row.scope_id || null,
    channel_id: row.channel_id || null,
    track: row.track,
    mode: row.mode,
    difficulty: row.difficulty,
    laps: row.laps,
    reverse: Boolean(row.reverse),
    played_at: row.played_at,
    has_replay: Boolean(row.replay_r2_key),
    replay_version: row.replay_version || null,
    replay_bytes: row.replay_bytes || null,
    replay_url: row.replay_r2_key
      ? `/api/matches/${encodeURIComponent(row.match_id)}/replay`
      : null,
    results,
  };
}

async function can_access_match(db, match_row, claims) {
  if (
    match_row.scope_type &&
    match_row.scope_id &&
    match_row.scope_type === claims.scope_type &&
    match_row.scope_id === claims.scope_id
  ) {
    return true;
  }
  let participant = await db
    .prepare(
      `SELECT 1 AS ok FROM match_results
       WHERE match_id = ? AND discord_user_id = ?
       LIMIT 1`
    )
    .bind(match_row.match_id, claims.sub)
    .first();
  return Boolean(participant);
}

async function handleListMatches({request, env}) {
  let auth = await authenticate_session(request, env);
  if (auth.error) return auth.error;
  let {claims} = auth;

  if (!env.TIME_TRIALS_DB) {
    return json_response({error: "D1 database is not configured."}, 503);
  }

  let url = new URL(request.url);
  let limit = parse_int_in_range(
    url.searchParams.get("limit"),
    1,
    MAX_LIST_LIMIT,
    DEFAULT_LIST_LIMIT
  );

  let rows = await env.TIME_TRIALS_DB
    .prepare(
      `SELECT match_id, instance_id, scope_type, scope_id, channel_id,
              track, mode, difficulty, laps, reverse, played_at,
              replay_r2_key, replay_version, replay_bytes
       FROM matches
       WHERE scope_type = ? AND scope_id = ?
       ORDER BY played_at DESC
       LIMIT ?`
    )
    .bind(claims.scope_type, claims.scope_id, limit)
    .all();

  let matches = [];
  for (let row of rows.results || []) {
    let results = await load_results_for_match(env.TIME_TRIALS_DB, row.match_id);
    matches.push(format_match_row(row, results));
  }

  return json_response({matches});
}

async function handleGetMatch({request, env, match_id}) {
  let auth = await authenticate_session(request, env);
  if (auth.error) return auth.error;
  let {claims} = auth;

  if (!env.TIME_TRIALS_DB) {
    return json_response({error: "D1 database is not configured."}, 503);
  }

  let row = await env.TIME_TRIALS_DB
    .prepare(
      `SELECT match_id, instance_id, scope_type, scope_id, channel_id,
              track, mode, difficulty, laps, reverse, played_at,
              replay_r2_key, replay_version, replay_bytes
       FROM matches
       WHERE match_id = ?`
    )
    .bind(match_id)
    .first();
  if (!row) {
    return json_response({error: "Match not found."}, 404);
  }

  if (!(await can_access_match(env.TIME_TRIALS_DB, row, claims))) {
    return json_response({error: "Match is not accessible in this scope."}, 403);
  }

  let results = await load_results_for_match(env.TIME_TRIALS_DB, row.match_id);
  return json_response({match: format_match_row(row, results)});
}

async function handleGetMatchReplay({request, env, match_id}) {
  let auth = await authenticate_session(request, env);
  if (auth.error) return auth.error;
  let {claims} = auth;

  if (!env.TIME_TRIALS_DB || !env.REPLAYS) {
    return json_response({error: "D1 or R2 storage is not configured."}, 503);
  }

  let row = await env.TIME_TRIALS_DB
    .prepare(
      `SELECT match_id, scope_type, scope_id, replay_r2_key
       FROM matches
       WHERE match_id = ?`
    )
    .bind(match_id)
    .first();
  if (!row || !row.replay_r2_key) {
    return json_response({error: "Replay not found."}, 404);
  }

  if (!(await can_access_match(env.TIME_TRIALS_DB, row, claims))) {
    return json_response({error: "Replay is not accessible in this scope."}, 403);
  }

  let obj = await env.REPLAYS.get(row.replay_r2_key);
  if (!obj) {
    return json_response({error: "Replay object missing from storage."}, 404);
  }

  return new Response(obj.body, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "private, max-age=3600",
    },
  });
}

export async function handleMatches({request, env}) {
  let url = new URL(request.url);
  let path = url.pathname;

  if (path === "/api/matches" || path === "/api/matches/") {
    if (request.method === "POST") {
      return handleCreateMatch({request, env});
    }
    if (request.method === "GET") {
      return handleListMatches({request, env});
    }
    return new Response("Method Not Allowed", {status: 405});
  }

  let replay_match = path.match(/^\/api\/matches\/([A-Za-z0-9_-]+)\/replay$/);
  if (replay_match) {
    if (request.method === "PUT") {
      return handleUploadMatchReplay({request, env, match_id: replay_match[1]});
    }
    if (request.method === "GET") {
      return handleGetMatchReplay({request, env, match_id: replay_match[1]});
    }
    return new Response("Method Not Allowed", {status: 405});
  }

  let detail_match = path.match(/^\/api\/matches\/([A-Za-z0-9_-]+)$/);
  if (detail_match) {
    if (request.method === "GET") {
      return handleGetMatch({request, env, match_id: detail_match[1]});
    }
    return new Response("Method Not Allowed", {status: 405});
  }

  return json_response({error: "Not Found"}, 404);
}
