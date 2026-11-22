#!/bin/bash
# Build and run the headless Blender podium asset generator in Docker.
#
# Usage:
#   # Fast local test (podium + 3 karts):
#   wasm/podium-renderer/assets-gen/generate.sh --karts tux,nolok,hexley --samples 16
#
#   # Full render (podium + all karts, used in CI):
#   wasm/podium-renderer/assets-gen/generate.sh
#
set -euo pipefail

SCRIPT_DIR="$(realpath "$(dirname "$0")")"
PODIUM_DIR="$(realpath "$SCRIPT_DIR/..")"
WASM_DIR="$(realpath "$PODIUM_DIR/..")"
REPO_ROOT="$(realpath "$WASM_DIR/..")"

STK_ASSETS_DIR="${STK_ASSETS_DIR:-$WASM_DIR/stk-assets}"
OUT_DIR="${OUT_DIR:-$PODIUM_DIR/generated-assets}"
IMAGE_TAG="${BLENDER_IMAGE_TAG:-stk-podium-assets-gen:local}"

if [ ! -d "$STK_ASSETS_DIR/karts" ] && [[ "$*" != *"--only-podium"* ]]; then
  echo "ERROR: stk-assets not found at $STK_ASSETS_DIR/karts" >&2
  echo "Run: wasm/get_assets.sh   (or pass --only-podium to test just the podium)" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

echo "==> Building Blender asset generator image ($IMAGE_TAG)..."
docker build -t "$IMAGE_TAG" "$SCRIPT_DIR"

DOCKER_MOUNTS=(
  -v "$OUT_DIR:/out"
  -v "$REPO_ROOT/data:/stk-data:ro"
)
EXTRA_ARGS=(--stk-data /stk-data --out-dir /out)

if [ -d "$STK_ASSETS_DIR" ]; then
  DOCKER_MOUNTS+=(-v "$STK_ASSETS_DIR:/assets:ro")
  EXTRA_ARGS+=(--stk-assets /assets)
fi

echo "==> Running Blender asset render..."
docker run --rm \
  --user "$(id -u):$(id -g)" \
  "${DOCKER_MOUNTS[@]}" \
  "$IMAGE_TAG" \
  "${EXTRA_ARGS[@]}" \
  "$@"

echo "==> Generated assets in: $OUT_DIR"
