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
#   BUILD_TYPE       CMake build type, defaults to Release.
#   STK_ASSETS_DIR   If set, the game assets in this directory are packed too.
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

# 4. Optionally pack the game assets into the low/mid/high bundles.
if [ -n "${STK_ASSETS_DIR:-}" ]; then
    "$WASM_DIR/pack_assets.sh" "$STK_ASSETS_DIR"
fi
