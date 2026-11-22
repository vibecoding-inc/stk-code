// Cloudflare Worker entry point for the SuperTuxKart WebAssembly web build.
//
// With the default asset routing (run_worker_first = false), requests that map
// to a static file are served directly and never reach this Worker; only
// dynamic /api/* routes are handled below.

import { handleTokenExchange } from "./token.mjs";
import { handleTelemetry } from "./telemetry.mjs";
import { handleShareAttachment } from "./share-attachment.mjs";
import { handleInteractions } from "./interactions.mjs";
import { handleTimeTrials } from "./time-trials.mjs";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/token") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", {status: 405});
      }
      return handleTokenExchange({request, env});
    }

    if (url.pathname === "/api/interactions") {
      return handleInteractions({request, env, ctx});
    }

    if (url.pathname.startsWith("/api/timetrials/")) {
      return handleTimeTrials({request, env, ctx});
    }

    if (url.pathname === "/api/share-attachment") {
      return handleShareAttachment({request, env});
    }

    if (url.pathname === "/api/telemetry") {
      return handleTelemetry({request, env, ctx});
    }

    // Fall back to the static assets for anything else.
    return env.ASSETS.fetch(request);
  },
};
