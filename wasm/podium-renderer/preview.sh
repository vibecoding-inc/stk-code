#!/bin/bash
# Build and run the Dockerized Node podium compositor in local preview mode.
# Writes sample PNGs into wasm/podium-renderer/preview-output/ for visual inspection.
#
# Usage:
#   wasm/podium-renderer/preview.sh
#
set -euo pipefail

PODIUM_DIR="$(realpath "$(dirname "$0")")"
WASM_DIR="$(realpath "$PODIUM_DIR/..")"
REPO_ROOT="$(realpath "$WASM_DIR/..")"

ASSETS_DIR="${ASSETS_DIR:-$PODIUM_DIR/generated-assets}"
TRACKS_DIR="${TRACKS_DIR:-$WASM_DIR/web/game/presence/tracks}"
OUT_DIR="${PREVIEW_OUT_DIR:-$PODIUM_DIR/preview-output}"
IMAGE_TAG="${PODIUM_IMAGE_TAG:-stk-podium-renderer:local}"

if [ ! -f "$ASSETS_DIR/podium.png" ] || [ ! -f "$ASSETS_DIR/layout.json" ]; then
  echo "==> generated-assets/podium.png not found; rendering 3D podium first..."
  "$PODIUM_DIR/assets-gen/generate.sh" --only-podium --samples 48
fi

mkdir -p "$OUT_DIR"

echo "==> Building podium-renderer Docker image ($IMAGE_TAG)..."
docker build -f "$PODIUM_DIR/Dockerfile" -t "$IMAGE_TAG" "$REPO_ROOT"

MOUNTS=(
  -v "$ASSETS_DIR:/app/assets:ro"
  -v "$OUT_DIR:/out"
)
if [ -d "$TRACKS_DIR" ]; then
  MOUNTS+=(-v "$TRACKS_DIR:/app/tracks:ro")
fi

echo "==> Running unit tests inside container..."
docker run --rm "$IMAGE_TAG" node --test tests/*.test.mjs

echo "==> Generating preview PNGs..."
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -e PREVIEW_OUT_DIR=/out \
  "${MOUNTS[@]}" \
  "$IMAGE_TAG" \
  node src/preview.mjs

echo "==> Preview PNGs ready in: $OUT_DIR"
