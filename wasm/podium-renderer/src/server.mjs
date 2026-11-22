import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PodiumCompositor } from "./compositor.mjs";
import { createLogger } from "./logger.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const MAX_CONCURRENCY = Math.max(1, Number(process.env.MAX_CONCURRENCY || 2));
const MAX_BODY_BYTES = 32 * 1024;
const RENDER_SECRET = String(process.env.PODIUM_RENDER_SECRET || "").trim();

const ASSETS_DIR = process.env.ASSETS_DIR || path.join(ROOT_DIR, "generated-assets");
const TRACKS_DIR = process.env.TRACKS_DIR || path.join(ROOT_DIR, "tracks");
const FONT_DIRS = (
  process.env.FONT_DIRS ||
  [
    path.join(ROOT_DIR, "fonts"),
    path.resolve(ROOT_DIR, "../../data/ttf"),
    "/usr/share/fonts/truetype/dejavu",
  ].join(":")
).split(":");

const serverLog = createLogger("podium_renderer::server");
const httpLog = createLogger("podium_renderer::http");

function checkAuth(req) {
  if (!RENDER_SECRET) return true;
  const auth = String(req.headers.authorization || "");
  if (!auth.startsWith("Bearer ")) return false;
  const token = auth.slice("Bearer ".length);
  const a = Buffer.from(token);
  const b = Buffer.from(RENDER_SECRET);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Payload too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch {
        reject(Object.assign(new Error("Invalid JSON body"), { statusCode: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function createSemaphore(max) {
  let active = 0;
  const queue = [];
  return {
    async run(fn) {
      const queuedAt = Date.now();
      if (active >= max) {
        await new Promise((resolve) => queue.push(resolve));
      }
      const queueMs = Date.now() - queuedAt;
      active++;
      try {
        const result = await fn();
        return { result, queueMs };
      } finally {
        active--;
        if (queue.length > 0) queue.shift()();
      }
    },
  };
}

function countTrackImages(dir) {
  if (!dir || !fs.existsSync(dir)) return 0;
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).length;
}

export function createPodiumServer(compositor) {
  const sem = createSemaphore(MAX_CONCURRENCY);
  let nextReqId = 1;

  return http.createServer(async (req, res) => {
    const reqId = nextReqId++;
    const started = Date.now();
    const method = req.method || "GET";
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const remote = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "unknown";

    if (method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          karts: (compositor.layout.karts || []).length,
        })
      );
      httpLog.debug("handled health check", {
        req_id: reqId,
        method,
        path: url.pathname,
        status: 200,
        remote,
        duration_ms: Date.now() - started,
      });
      return;
    }

    if (method === "POST" && url.pathname === "/render") {
      if (!checkAuth(req)) {
        httpLog.warn("rejected request", {
          req_id: reqId,
          method,
          path: url.pathname,
          status: 401,
          reason: "unauthorized",
          remote,
          duration_ms: Date.now() - started,
        });
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        const status = err.statusCode || 400;
        httpLog.warn("rejected request", {
          req_id: reqId,
          method,
          path: url.pathname,
          status,
          reason: err.message,
          remote,
          duration_ms: Date.now() - started,
        });
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }

      if (!body || typeof body !== "object" || !Array.isArray(body.entries)) {
        httpLog.warn("rejected request", {
          req_id: reqId,
          method,
          path: url.pathname,
          status: 400,
          reason: "missing entries array",
          remote,
          duration_ms: Date.now() - started,
        });
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Body must contain an entries array" }));
        return;
      }

      const top3 = body.entries.slice(0, 3);
      try {
        const renderStart = Date.now();
        const { result: png, queueMs } = await sem.run(() =>
          compositor.render({
            track: body.track,
            track_name: body.track_name,
            difficulty: body.difficulty,
            laps: body.laps,
            reverse: Boolean(body.reverse),
            entries: top3,
          })
        );
        const renderMs = Date.now() - renderStart - queueMs;
        const durationMs = Date.now() - started;

        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": String(png.length),
          "Cache-Control": "no-store",
          "X-Render-Time-Ms": String(durationMs),
        });
        res.end(png);

        httpLog.info("rendered podium", {
          req_id: reqId,
          method,
          path: url.pathname,
          status: 200,
          track: body.track || "unknown",
          players: top3.length,
          karts: top3.map((e) => e.kart || "?").join(","),
          bytes: png.length,
          queue_ms: queueMs,
          render_ms: Math.max(0, renderMs),
          duration_ms: durationMs,
        });
      } catch (err) {
        httpLog.error("podium render failed", {
          req_id: reqId,
          method,
          path: url.pathname,
          status: 500,
          track: body.track || "unknown",
          players: top3.length,
          error: err,
          duration_ms: Date.now() - started,
        });
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Render failed" }));
      }
      return;
    }

    httpLog.warn("route not found", {
      req_id: reqId,
      method,
      path: url.pathname,
      status: 404,
      remote,
      duration_ms: Date.now() - started,
    });
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!RENDER_SECRET) {
    serverLog.warn("PODIUM_RENDER_SECRET is not set — Bearer auth is DISABLED");
  }
  const compositor = new PodiumCompositor({
    assetsDir: ASSETS_DIR,
    tracksDir: TRACKS_DIR,
    fontDirs: FONT_DIRS,
  });
  const server = createPodiumServer(compositor);
  server.listen(PORT, HOST, () => {
    serverLog.info("podium-renderer listening", {
      addr: `${HOST}:${PORT}`,
      assets: ASSETS_DIR,
      karts: (compositor.layout.karts || []).length,
      tracks: countTrackImages(TRACKS_DIR),
      fonts: compositor.fonts.length,
      max_concurrency: MAX_CONCURRENCY,
      auth_enabled: Boolean(RENDER_SECRET),
    });
  });

  const shutdown = (signal) => {
    serverLog.info("shutting down podium-renderer", { signal });
    server.close(() => {
      serverLog.info("podium-renderer stopped cleanly");
      process.exit(0);
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
