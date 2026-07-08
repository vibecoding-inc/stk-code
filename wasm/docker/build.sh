#!/bin/bash
#
# Build the SuperTuxKart WebAssembly port locally, inside a pinned Docker
# container, so nothing has to be installed on the host except Docker.
#
# Usage:
#   wasm/docker/build.sh [BUILD_TYPE] [STK_ASSETS_DIR]
#
#   BUILD_TYPE       CMake build type (default: Release).
#   STK_ASSETS_DIR   Optional path to a checkout of the stk-assets repository.
#                    When given, the game asset bundles are packed too. Use
#                    wasm/get_assets.sh to obtain such a checkout.
#
# Environment variables:
#   STK_WASM_IMAGE   Docker image tag to build/use (default: stk-wasm-build:local).
#   EMSDK_VERSION    Emscripten version to base the image on (see Dockerfile).
#
# The resulting web root is written to wasm/web/.
#
set -euo pipefail

BASE_DIR="$(realpath "$(dirname "$0")")"   # wasm/docker
WASM_DIR="$(dirname "$BASE_DIR")"          # wasm
SRC_DIR="$(dirname "$WASM_DIR")"           # repository root

BUILD_TYPE="${1:-Release}"
STK_ASSETS_DIR="${2:-}"
IMAGE="${STK_WASM_IMAGE:-stk-wasm-build:local}"

echo "==> Building Docker image: $IMAGE"
docker build \
    ${EMSDK_VERSION:+--build-arg EMSDK_VERSION="$EMSDK_VERSION"} \
    -t "$IMAGE" \
    -f "$BASE_DIR/Dockerfile" \
    "$BASE_DIR"

run_args=(
    --rm
    --user "$(id -u):$(id -g)"
    -v "$SRC_DIR":/src
    -w /src
    -e BUILD_TYPE="$BUILD_TYPE"
)

if [ -n "$STK_ASSETS_DIR" ]; then
    STK_ASSETS_DIR="$(realpath "$STK_ASSETS_DIR")"
    run_args+=(-v "$STK_ASSETS_DIR":/assets:ro -e STK_ASSETS_DIR=/assets)
fi

echo "==> Running build pipeline in container"
docker run "${run_args[@]}" "$IMAGE" wasm/docker/pipeline.sh

echo "==> Done. The web root is ready in: $WASM_DIR/web"
