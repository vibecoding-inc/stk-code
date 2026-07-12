# SuperTuxKart WASM Port

Currently this port is still incomplete.

Working features:
- The game launches
- OpenGL ES 2 graphics (GLES 3 doesn't work)
- Audio
- Persistent user data
- Caching data and asset files in IndexedDB

TODO:
- Fix GLES 3 (maybe someone with more experience in webgl could help here)
- Lazy load assets during gameplay
- Networking

Caveats:
- The performance isn't great, probably because the legacy renderer is still being used
- Some options, like anything related to online multiplayer, may hang the game

### Threading / rendering

`main()` and the whole GL/game loop run on the **browser main thread**. This is
not optional: STK renders through Irrlicht → SDL2, whose Emscripten backend
creates its WebGL context via EGL, and Emscripten's EGL always creates that
context on the browser main thread (`eglCreateContext` is proxied there and uses
`Module['canvas']`); the context cannot be made current on any other pthread.
Running the game on a pthread with `-sPROXY_TO_PTHREAD` therefore made SDL2 fail
to obtain a context and the renderer aborted with `Couldn't initialise irrlicht
device`. Neither `-sOFFSCREENCANVAS_SUPPORT` (canvas transfer, see
emscripten-core/emscripten#20547) nor `-sOFFSCREEN_FRAMEBUFFER` (ignored by
EGL/SDL2) works around this, so both were removed.

STK's start-up used to spawn the SP texture-loader worker pool and then
busy-wait on it (`checkForGLCommand`); on the web a Worker cannot start while the
main browser thread is stuck inside Wasm, which deadlocked start-up. Two things
address this:

- Texture loading no longer uses worker threads on the web — `SPTextureManager`
  runs each load inline on the main thread (`SPTextureManager::addThreadedFunction`).
- STK's remaining `std::thread` users get a pre-created pthread pool
  (`-sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency
  -sPTHREAD_POOL_SIZE_STRICT=0`) so they can start without the main thread having
  to yield first.

This still relies on the COOP/COEP cross-origin-isolation headers in
`wasm/web/_headers` (needed for `SharedArrayBuffer`).

The web build **must** use the GLES2 renderer (`USE_GLES2`). Browsers only expose
GL through WebGL, and SDL2's Emscripten backend passes
`EGL_CONTEXT_CLIENT_VERSION` to `eglCreateContext` **only** when an OpenGL ES
profile is requested; anything else makes Emscripten's EGL default to GLES1 and
reject the context with `EGL_BAD_CONFIG` (`Could not initialize display!`). The
`EMSCRIPTEN` block in the top-level `CMakeLists.txt` forces `USE_GLES2` on, and
the generic `UNIX` block that would otherwise `option(USE_GLES2 ... OFF)` is
guarded to skip Emscripten (see the comment there for the CMP0077 detail).

## Building with Docker (recommended)

This is the reproducible path used both locally and in CI. It only requires
Docker on the host — the Emscripten SDK and all the asset tools live inside a
pinned image (`wasm/docker/Dockerfile`, based on `emscripten/emsdk`).

1. (Optional) Fetch the external art assets. This is only needed if you want the
   packed game data bundles; it checks out the `stk-assets` repository into
   `wasm/stk-assets` (gitignored):
   ```
   wasm/get_assets.sh
   ```
2. Build everything in the container. Without the second argument it builds just
   the wasm binary; pass the assets checkout to also pack the data bundles:
   ```
   wasm/docker/build.sh Release wasm/stk-assets
   ```
   The image is built on first use and cached. Several directories persist
   between runs so subsequent builds are fast: `wasm/prefix`/`wasm/build` hold
   the cross-compiled dependencies, `wasm/.ccache` caches the compiled C/C++
   object files (via ccache), and `wasm/.emcache` caches Emscripten's system
   libraries and ports. Change only a few source files and the rebuild only
   recompiles those files.
3. Serve the result locally:
   ```
   (cd wasm/web && python3 ../run_server.py)
   ```

You can pin a different Emscripten version with the `EMSDK_VERSION` build arg
(see `wasm/docker/Dockerfile`), e.g. `EMSDK_VERSION=3.1.64 wasm/docker/build.sh`.

## Continuous integration

`.github/workflows/wasm.yml` builds the same container, cross-compiles the
dependencies, builds the wasm binary, packs the assets, uploads the `wasm/web`
directory as an artifact and (on pushes to `wasm`) deploys it to Cloudflare
Workers with `wrangler deploy` (see `wasm/wrangler.jsonc`). Configure these
repository secrets to enable deployment:

- `CLOUDFLARE_API_TOKEN` — token with the *Edit Cloudflare Workers* permission.
- `CLOUDFLARE_ACCOUNT_ID` — your Cloudflare account id.

Without the secrets the workflow still builds and uploads the artifact but skips
the deploy.

### Deployment (Cloudflare Workers)

The web build is deployed as a Cloudflare Worker with static assets, configured
in `wasm/wrangler.jsonc`:

- The built web root (`wasm/web`) is served as static assets; the `_headers`
  file there still applies the COOP/COEP cross-origin-isolation headers (Workers
  Static Assets parses `_headers`, it is not served as a file).
- `wasm/worker/index.mjs` is the Worker entry point. Static requests are served
  directly; only the single dynamic route `POST /api/token` (the Discord OAuth2
  code→token exchange, formerly a Pages Function) runs in the Worker.
- It is published on its own `workers.dev` subdomain (`workers_dev: true`,
  Worker name `supertuxkart-wasm`), i.e.
  `https://supertuxkart-wasm.<your-subdomain>.workers.dev`.

To deploy manually (Wrangler v4):

```
cd wasm && npx wrangler deploy
```

The Discord OAuth secrets used by `/api/token` are Worker secrets (not committed):

```
cd wasm
npx wrangler secret put DISCORD_CLIENT_ID
npx wrangler secret put DISCORD_CLIENT_SECRET
```

### Caching

The first run is slow (~1.5 h) because everything is built from scratch; later
runs reuse several `actions/cache` entries and are much faster:

- **Dependencies** (`wasm/prefix`) — keyed on `build_deps.sh` + the Dockerfile,
  so the cross-compiled libraries are rebuilt only when those change.
- **Compiler caches** (`wasm/.ccache` + `wasm/.emcache`) — updated every run;
  ccache makes recompiling STK only touch the sources that actually changed.
- **Packed assets** (`wasm/web/game/data_{low,mid,high}.tar.gz.*` and
  `data_version.txt`) — keyed on the `stk-assets` svn revision and the packing
  scripts. On a hit the (slow) asset re-encoding is skipped entirely
  (`SKIP_PACK_IF_PRESENT`); it only re-runs when the art or the packing scripts
  change.
- **stk-assets checkout** (`wasm/stk-assets`) — kept warm so it is only
  `svn update`d, never re-downloaded in full.

So a typical code-only change rebuilds in a fraction of the initial time: no
dependency rebuild, an incremental ccache-assisted compile, and no asset
repacking.

### Asset cache versioning and validation

The browser caches the extracted data bundle in IndexedDB. To decide when that
cache is stale, `wasm/web/script.js` fetches `/game/data_version.txt` and wipes
the cache whenever the token changes. `wasm/pack_assets.sh` regenerates that file
on every pack, deriving the token from the SHA-256 of the packed bundles, so any
change to the assets automatically invalidates every browser's cache — there is
no constant to bump by hand. (If the file is ever absent, e.g. an older deploy,
the front-end falls back to the previous hard-coded `data_version`.)

`pack_assets.sh` also runs an **advisory** validation over the packed tree before
compressing it: for every model (`.spm`/`.b3d`) it checks that each referenced
texture is present in the bundle. It surfaces the class of bug that shows up as
**white / untextured item boxes** — e.g. a texture a model needs is missing
entirely from the packed data. It is intentionally lenient in two ways:

- It matches by **name stem**, not by exact extension. `android/generate_assets.sh`
  (`CONVERT_TO_JPG`) converts most opaque `.png` textures to `.jpg` to shrink the
  download and only rewrites the reference embedded in a model when the texture
  lives in that model's own directory. Shared textures are therefore routinely
  referenced as `foo.png` by a model while the packed file is `foo.jpg` — a
  normal, working situation — so a reference to `foo.png` is treated as satisfied
  when either `foo.png` or `foo.jpg` exists.
- It only **warns**; it never aborts the pack. An exact-extension, build-failing
  version of this check flagged hundreds of healthy models and blocked every
  deploy, which caused far more harm than the bug it was meant to catch. Missing
  textures are logged so they can be reviewed, but the (space-saving) JPG
  conversion and the deploy are never blocked by this heuristic scan of binary
  meshes.

> Note: Cloudflare Workers Static Assets reject individual files larger than
> 25 MiB. The asset bundles are split into 20 MB chunks, but keep an eye on
> `supertuxkart.wasm`; if it grows past the limit it must be served from R2 or
> split instead.

## Building manually (native toolchain)
1. First, get a copy of the emsdk (it might help to have emscripten already installed with `sudo apt install emscripten`):
```
wasm/get_emsdk.sh
```
2. Compile all the dependencies:
```
wasm/build_deps.sh
```
3. Compile STK:
```
wasm/build.sh
```
4. Compress and bundle the game data and assets:
```
sudo apt install imagemagick vorbis-tools pngquant advancecomp libjpeg-progs optipng
wasm/pack_assets.sh ../stk-assets
```
5. Host a web server:
```
(cd wasm/web && python3 ../run_server.py)
```

## Project Structure:
- /wasm/docker - Pinned Docker build environment and build wrapper
- /wasm/build - Files for building the dependencies
- /wasm/prefix - Headers and library files
- /wasm/stk-assets - Checkout of the external art assets (gitignored)
- /wasm/web - Web server root directory (deployed as Workers static assets)
- /wasm/worker - Cloudflare Worker entry point and the /api/token handler
- /wasm/wrangler.jsonc - Cloudflare Workers deploy configuration
- /wasm/emsdk - Emscripten SDK
- /wasm/fragments - Patches for emscripten's generated JS

## Discord Activity

- The browser dependencies used by `wasm/web/script.js` are vendored under `wasm/web/vendor`, so the web build no longer depends on third-party CDNs.
- Set `discord_client_id` in `wasm/web/config.json` to enable Discord Activity OAuth for the embedded build. The committed `wasm/web/config_example.json` (copied to `config.json` by the build when none exists) already carries the project's public client id.
- Configure `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET` as Cloudflare Worker secrets (`wrangler secret put ...`) so the `/api/token` Worker route can exchange the Discord authorization code server-side.
- The Discord Activity flow is single-player only for now; networking remains TODO.
- `SharedArrayBuffer` / cross-origin isolation is still being tried via the existing `wasm/web/_headers` COOP/COEP settings.

## Telemetry

Every browser session (including Discord Activity sessions) forwards its log
output to Cloudflare so runs that can't be reproduced locally can still be
inspected afterwards. This is always on and fail-open — any telemetry error is
swallowed and never affects game start-up.

- **Client collector** (`wasm/web/telemetry.js`, wired up in `wasm/web/script.js`)
  wraps Emscripten's `Module.print`/`printErr`, the JS `console.log/info/warn/error`
  methods and uncaught errors (`window.onerror`, `unhandledrejection`, the
  `webglcontextcreationerror` canvas event). It still prints to the real console
  for local debugging, buffers `{ts, level, source, message}` entries, and flushes
  every ~5 s (and on `pagehide`/`visibilitychange`) via `navigator.sendBeacon`
  (falling back to `fetch(..., {keepalive: true})`). Each batch is tagged with a
  generated session id plus build/data version, texture quality, Discord user id
  (when authenticated), user agent and best-effort memory/load timings.
- **Ingest route** `POST /api/telemetry` (`wasm/worker/telemetry.mjs`) is
  same-origin, so it passes Discord's proxied CSP the same way `/api/token` does.
  It validates and clamps each batch (caps entry count, truncates every message
  to ~2 KB, coerces `level`/`source` to known values), then fans out to two
  Cloudflare-native sinks.
- **Analytics Engine** dataset `stk_wasm_telemetry` (binding `TELEMETRY` in
  `wasm/wrangler.jsonc`) stores one data point per log entry for queryable
  ~90-day history: `index1 = session`; `blob1..8 = level, source, message,
  discord_user_id, build_version, quality, user_agent, original_ts_iso`;
  `double1 = 1` (count) plus `memory_mb` and `load_ms`.
- **Workers Logs** receive a compact structured line per entry (keyed by level),
  persisted because `observability.enabled` is `true`.

### Querying historical sessions

Analytics Engine can't be queried from inside a Worker; query it out-of-band via
the [SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/)
with a Cloudflare API token, e.g.:

```bash
curl "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/analytics_engine/sql" \
  -H "Authorization: Bearer <API_TOKEN>" \
  -d "SELECT timestamp, blob1 AS level, blob3 AS message
      FROM stk_wasm_telemetry
      WHERE index1 = '<session>' AND timestamp >= NOW() - INTERVAL '1' DAY
      ORDER BY timestamp"
```

### Tailing live logs

During a play-test, tail the echoed lines live from `wasm/`:

```bash
npx wrangler tail
```