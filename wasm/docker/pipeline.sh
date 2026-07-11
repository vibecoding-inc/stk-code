#!/bin/bash
#
# Full WebAssembly build pipeline, meant to run INSIDE the Emscripten Docker
# container (see wasm/docker/Dockerfile). It is used by both the local wrapper
# (wasm/docker/build.sh) and the GitHub Actions workflow, so local and CI builds
# run the exact same steps.
#
# Expectations:
#   - The repository is mounted and this script is started from anywhere inside
#     it; paths are resolved relative to the script location.
#   - $EMSDK points at a preinstalled, activated Emscripten SDK (the case for the
#     emscripten/emsdk base image).
#
# Environment variables:
#   BUILD_TYPE            CMake build type, defaults to Release.
#   STK_ASSETS_DIR        If set, the game assets in this directory are packed too.
#   SKIP_PACK_IF_PRESENT  If set and the packed asset bundles already exist
#                         (e.g. restored from a CI cache), skip the expensive
#                         asset packing step.
#
set -euo pipefail
set -x

BASE_DIR="$(realpath "$(dirname "$0")")"   # wasm/docker
WASM_DIR="$(dirname "$BASE_DIR")"          # wasm
SRC_DIR="$(dirname "$WASM_DIR")"           # repository root
cd "$SRC_DIR"

BUILD_TYPE="${BUILD_TYPE:-Release}"

# The Emscripten toolchain runs a lot of tools that want a writable HOME; the
# container HOME may be unset or read-only when running as an arbitrary uid.
export HOME="${HOME_DIR:-/tmp/stk-build-home}"
mkdir -p "$HOME"

# Relocate the compiler caches into the (mounted, cacheable) repository so that
# both local and CI builds reuse them across runs. These directories are what
# make repeated builds fast:
#   - CCACHE_DIR  object-file cache for SuperTuxKart's C/C++ sources.
#   - EM_CACHE    Emscripten's compiled system libraries and ports (SDL2, ...),
#                 which are otherwise rebuilt from scratch on every fresh run.
export CCACHE_DIR="${CCACHE_DIR:-$WASM_DIR/.ccache}"
export CCACHE_MAXSIZE="${CCACHE_MAXSIZE:-2G}"
export EM_CACHE="${EM_CACHE:-$WASM_DIR/.emcache}"
mkdir -p "$CCACHE_DIR" "$EM_CACHE"

# Expose the preinstalled SDK where the existing build scripts and CMakeLists.txt
# expect it (wasm/emsdk). This keeps the toolchain scripts identical between the
# native "run get_emsdk.sh" flow and the container flow.
if [ -n "${EMSDK:-}" ]; then
    ln -sfn "$EMSDK" "$WASM_DIR/emsdk"
fi

# 1. Cross-compile the third-party dependencies (cached in wasm/prefix).
"$WASM_DIR/build_deps.sh"

# 2. Build SuperTuxKart itself and patch the generated JavaScript.
"$WASM_DIR/build.sh" "$BUILD_TYPE"

# 3. Provide a runtime config if none exists (config.json is gitignored).
if [ ! -f "$WASM_DIR/web/config.json" ]; then
    cp "$WASM_DIR/web/config_example.json" "$WASM_DIR/web/config.json"
fi

# 4. Optionally pack the game assets into the low/mid/high bundles. Packing is
#    slow (it re-encodes every texture/audio file at three quality levels), so
#    it is skipped when the bundles are already present and SKIP_PACK_IF_PRESENT
#    is set - in CI the bundles are restored from a cache keyed on the assets
#    revision, so this only re-runs when the assets or the packing scripts change.
GAME_DIR="$WASM_DIR/web/game"
if [ -n "${STK_ASSETS_DIR:-}" ]; then
    if [ -n "${SKIP_PACK_IF_PRESENT:-}" ] \
        && [ -f "$GAME_DIR/data_low.tar.gz.manifest" ] \
        && [ -f "$GAME_DIR/data_mid.tar.gz.manifest" ] \
        && [ -f "$GAME_DIR/data_high.tar.gz.manifest" ] \
        && [ -f "$GAME_DIR/data_version.txt" ]; then
        echo "Packed asset bundles already present; skipping asset packing."
    else
        "$WASM_DIR/pack_assets.sh" "$STK_ASSETS_DIR"
    fi
fi
