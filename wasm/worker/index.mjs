// Cloudflare Worker entry point for the SuperTuxKart WebAssembly web build.
//
// This replaces the previous Cloudflare Pages deployment. The static web root
// (wasm/web) is served through the ASSETS binding - the _headers file there
// still applies the COOP/COEP cross-origin-isolation headers required by the
// threaded (SharedArrayBuffer) build. The only dynamic route is the Discord
// OAuth2 token exchange, previously a Pages Function at
// functions/api/token.js and now handled here.
//
// With the default asset routing (run_worker_first = false), requests that map
// to a static file are served directly and never reach this Worker; only
// non-asset requests such as /api/token are handled below.

import { handleTokenExchange } from "./token.mjs";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/token") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", {status: 405});
      }
      return handleTokenExchange({request, env});
    }

    // Fall back to the static assets for anything else.
    return env.ASSETS.fetch(request);
  },
};
