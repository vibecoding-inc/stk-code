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
   The image is built on first use and cached; `wasm/prefix` and `wasm/build`
   hold the cached dependencies so subsequent runs are fast.
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
Pages. Configure these repository secrets to enable deployment:

- `CLOUDFLARE_API_TOKEN` — token with the *Cloudflare Pages: Edit* permission.
- `CLOUDFLARE_ACCOUNT_ID` — your Cloudflare account id.

Optionally set the `CLOUDFLARE_PAGES_PROJECT` repository variable to override the
Pages project name (default: `supertuxkart-wasm`). Without the secrets the
workflow still builds and uploads the artifact but skips the deploy.

> Note: Cloudflare Pages rejects individual files larger than 25 MiB. The asset
> bundles are split into 20 MB chunks, but keep an eye on `supertuxkart.wasm`; if
> it grows past the limit it must be served from R2 or split instead.

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
- /wasm/web - Web server root directory
- /wasm/emsdk - Emscripten SDK
- /wasm/fragments - Patches for emscripten's generated JS