# AGENTS.md — SuperTuxKart WASM / Discord Activity Fork

This repository is a fork of **SuperTuxKart** (branch `wasm`, originally based on upstream [PR #5106](https://github.com/supertuxkart/stk-code/pull/5106) by `ading2210`) **dedicated exclusively to running SuperTuxKart as a Discord Activity** (WASM browser client hosted on Cloudflare Workers + headless `-DSERVER_ONLY=ON` gameserver behind the Rust gateway).

- **Scope & Freedom to Modify:** This fork will **never** be compiled as a standard desktop client and does **not** need upstream/desktop backwards compatibility. Only the **WASM client** and **headless gameserver** matter — we are free to modify STK's C++ code, GUI `.stkgui` screens, and network protocols directly to deliver the best Discord Activity experience.

---

## Development & CI Preferences

- **Defer full validation to CI:** GitHub Actions (`.github/workflows/wasm.yml`) runs all JS/Worker unit tests (`node --test wasm/web/tests/*.test.mjs`), builds/caches the WASM binary and asset bundles, and deploys to Cloudflare Workers on pushes to `wasm`.
- **Targeted local tests are fine:** When changing JS/Worker logic, running the specific relevant test file locally (e.g. `node --test wasm/web/tests/telemetry.test.mjs`) before committing is encouraged, then commit and push so CI validates the full suite and deploys.
- **Native `.stkgui` UI strictly preferred over HTML/CSS overlays:** Build in-game UI natively in SuperTuxKart's `.stkgui` screens/dialogs rather than HTML/CSS hacks on top of the canvas, which look out of place. The current HTML landing page (`wasm/web/index.html`) is temporary. `.stkgui` files are split into a lightweight overlay (`data_gui.tar.gz`) and are not affected by long asset-packing CI times.
- **Keep `-sASSERTIONS=1` enabled for now:** We actively debug using the deployed production build; do not strip Emscripten assertions until the Discord Activity port is stable.
- **Fast web-only CI path:** Changes confined to `wasm/web/**`, `wasm/worker/**`, or docs hit both `wasm-bin-*` and `wasm-assets-*` caches, skip Docker completely, and deploy in ~1 minute. Avoid pushing while a cold C++/asset build is running because `concurrency: cancel-in-progress: true` cancels the run and skips `Post Cache` saves.
- **Keep credits intact:** Always preserve attribution/links to **SuperTuxKart** and **ading2210** (original WASM port & PR #5106) in the launcher UI.

---

## Critical Technical Constraints (Do Not Regress)

1. **Single-threaded WASM only (NO `-pthread` / NO `SharedArrayBuffer`):**
   - Discord's Activity iframe (`discordsays.com`) is **not** cross-origin isolated (`crossOriginIsolated: false`, `SharedArrayBuffer: false`), even when our origin sends COOP/COEP headers.
   - Do **not** re-introduce `-pthread`, `-sPTHREAD_POOL_SIZE*`, `-sPROXY_TO_PTHREAD`, or `supertuxkart.worker.js`.
   - `CMakeLists.txt` and `wasm/build_deps.sh` (including OpenSSL `no-threads`) must stay single-threaded.
   - Single-player background threads are disabled/inlined under `__EMSCRIPTEN__` in:
     - `src/graphics/sp/sp_texture_manager.cpp` (inline texture loading)
     - `src/audio/sfx_manager.cpp` (no audio thread on Emscripten)
     - `src/addons/news_manager.cpp` (no news download thread on Emscripten)
     - `src/online/request_manager.cpp` (no HTTP request thread on Emscripten)

2. **Main-thread GLES2 / WebGL2 rendering:**
   - STK renders via Irrlicht → SDL2 → Emscripten EGL/WebGL2 on the browser main thread.
   - `USE_GLES2=1` must remain forced on in `CMakeLists.txt`; the generic `UNIX` block is explicitly guarded to exclude `EMSCRIPTEN` (since Emscripten sets `UNIX=1`).

3. **Emscripten `Module` hooks must be defined BEFORE `supertuxkart.js` loads:**
   - With `-sASSERTIONS=1`, Emscripten defines poisoned getter traps on unexported `Module` properties (`print`, `printErr`) that immediately call `abort()` if read.
   - `wasm/web/index.html` pre-defines `Module.print`, `Module.printErr`, `Module.onAbort`, and an early `window` error listener *before* `<script src="/game/supertuxkart.js">` loads.
   - `wasm/web/telemetry.js` must always check `Object.getOwnPropertyDescriptor()` and never invoke accessor getters on `Module`.

4. **Strict Discord CSP (no external CDNs / safe external links):**
   - All frontend JS dependencies (`pako`, `js-untar`, `@discord/embedded-app-sdk`) are vendored under `wasm/web/vendor/`.
   - All dynamic endpoints (`/api/token`, `/api/telemetry`) must remain same-origin on the Cloudflare Worker.
   - External links in `wasm/web/index.html` are routed through `discordSdk.commands.openExternalLink()` when running inside Discord.

5. **Asset packing requires `bsdextrautils` (`hexdump`):**
   - `android/generate_assets.sh` converts opaque `.png` textures to `.jpg` and patches `.spm`/`.b3d` binary meshes in-place using `hexdump`. Never remove `bsdextrautils` from `wasm/docker/Dockerfile`, or models will render white/untextured.
   - Note: `sed: couldn't open file asm/web/game/...` during `Generate files list` in `android/generate_assets.sh` only affects Android's `files.txt` (which is excluded from the WASM tarballs) and is harmless.

6. **Cloudflare Workers Static Assets 25 MiB per-file limit:**
   - Asset tarballs are split into 20 MB chunks. Keep an eye on `supertuxkart.wasm` (~15 MiB) so it stays under 25 MiB.

---

## Telemetry & Observability (High Priority During Development)

Rich, fail-open telemetry is essential for debugging Discord Activity sessions that cannot be easily inspected locally:

- **Client collector (`wasm/web/telemetry.js`, wired in `index.html` + `script.js`):**
  - Captures early window errors, `Module.print`/`printErr`/`onAbort`, `console.*`, `window.onerror`, `unhandledrejection`, `webglcontextcreationerror`, `webglcontextlost`/`restored`, and a 20 s startup watchdog if `globalThis.ready` stalls.
  - Emits an immediate `[env]` diagnostic snapshot on load (Discord iframe detection, `crossOriginIsolated`, `SharedArrayBuffer`, CPU/RAM/viewport/DPR, offscreen WebGL2/renderer probe, storage quota, `is_mobile`, `recommended_quality`) and `[lifecycle]` timing events across startup, asset download/cache/unpack, and engine launch.
  - Fatal errors and aborts flush **immediately** via `navigator.sendBeacon` (fallback `fetch(..., {keepalive: true})`). Everything is fail-open and must never break game startup.
- **Ingest route (`wasm/worker/telemetry.mjs` at `POST /api/telemetry`):**
  - Validates/clamps batches and writes to Cloudflare **Analytics Engine** (`stk_wasm_telemetry`, binding `TELEMETRY`) and **Workers Logs** (`observability.enabled: true`).
  - Tail live sessions from `wasm/`: `npx wrangler tail`.

---

## Repository Map (WASM / Discord Activity Parts)

- `wasm/web/index.html` — Pre-load `Module` telemetry hooks + SuperTuxKart-styled responsive launcher UI (large clickable Low/Medium/High quality buttons, animated progress bar, credits).
- `wasm/web/script.js` — Runtime bootstrap, IndexedDB asset caching (auto-versioned via `/game/data_version.txt`), IDBFS `/home` persistence, smart quality pre-selection (`recommend_quality()`), Discord OAuth init, and lifecycle telemetry.
- `wasm/web/telemetry.js` — Client telemetry collector, `collect_environment_diagnostics()`, and `recommend_quality()`.
- `wasm/web/discord-activity.js` — Discord Embedded App SDK OAuth2 flow (`frame_id` detection → `authorize` → `POST /api/token` → `authenticate`).
- `wasm/web/tests/*.test.mjs` — Node built-in test runner (`node --test`) unit tests for Discord auth, token handler, telemetry collector, and telemetry ingest handler.
- `wasm/worker/index.mjs`, `token.mjs`, `telemetry.mjs` — Cloudflare Worker entry point and API routes.
- `wasm/wrangler.jsonc` — Cloudflare Workers config (Static Assets `./web`, Analytics Engine, Observability).
- `wasm/docker/Dockerfile`, `pipeline.sh`, `build.sh` — Reproducible build-time-only Emscripten `3.1.64` + asset-packing container used locally and in CI.
- `.github/workflows/wasm.yml` — CI/CD workflow (tests, multi-layer caching, conditional Docker build, Cloudflare Workers deploy).

---

## Secrets (Configured Out-of-Band, Never Commit)

- **GitHub Actions secrets:** `CLOUDFLARE_API_TOKEN` (*Edit Cloudflare Workers*), `CLOUDFLARE_ACCOUNT_ID`.
- **Cloudflare Worker secrets (`wrangler secret put` in `wasm/`):** `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`.

---

## Current Status & Next Milestones

- **Working:** Single-threaded WASM build (no `SharedArrayBuffer`), standalone browser playback, fixed `.spm`/`.b3d` model textures (`hexdump`), Discord OAuth2 login, telemetry pipeline, STK-styled launcher with device-aware quality pre-selection, fast cached CI/CD.
- **Next milestones:**
  1. End-to-end playtest inside Discord Activities (desktop, web, mobile) and verify canvas sizing/resize behavior from Discord's initial small iframe viewport.
  2. Pass authenticated Discord username (`discordAuth.user`) into SuperTuxKart's player profile in IDBFS before `run()`.
  3. Reduce startup download size & peak memory usage (`INITIAL_MEMORY=768MB` + tarball decompression/extraction).
  4. Design and implement Discord Activity multiplayer (WebSocket proxy + STK server room mapped to Discord's Activity `instance_id`).
