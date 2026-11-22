import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PodiumCompositor } from "./compositor.mjs";

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
      if (active >= max) {
        await new Promise((resolve) => queue.push(resolve));
      }
      active++;
      try {
        return await fn();
      } finally {
        active--;
        if (queue.length > 0) queue.shift()();
      }
    },
  };
}

export function createPodiumServer(compositor) {
  const sem = createSemaphore(MAX_CONCURRENCY);

  return http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          karts: (compositor.layout.karts || []).length,
        })
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/render") {
      if (!checkAuth(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        res.writeHead(err.statusCode || 400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }

      if (!body || typeof body !== "object" || !Array.isArray(body.entries)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Body must contain an entries array" }));
        return;
      }

      const started = Date.now();
      try {
        const png = await sem.run(() =>
          compositor.render({
            track: body.track,
            track_name: body.track_name,
            difficulty: body.difficulty,
            laps: body.laps,
            reverse: Boolean(body.reverse),
            entries: body.entries.slice(0, 3),
          })
        );
        const elapsed = Date.now() - started;
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": String(png.length),
          "Cache-Control": "no-store",
          "X-Render-Time-Ms": String(elapsed),
        });
        res.end(png);
      } catch (err) {
        console.error("Podium render failed:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Render failed" }));
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const compositor = new PodiumCompositor({
    assetsDir: ASSETS_DIR,
    tracksDir: TRACKS_DIR,
    fontDirs: FONT_DIRS,
  });
  const server = createPodiumServer(compositor);
  server.listen(PORT, HOST, () => {
    console.log(
      `[podium-renderer] listening on http://${HOST}:${PORT} (assets=${ASSETS_DIR}, karts=${(compositor.layout.karts || []).length}, max_concurrency=${MAX_CONCURRENCY})`
    );
  });
}
