#!/bin/bash
#
# Fetch (or update) the external stk-assets repository. It contains the karts,
# tracks and textures that pack_assets.sh turns into the low/mid/high web asset
# bundles. The game's own data/ directory (shipped in this repo) is not enough
# on its own.
#
# Usage:
#   wasm/get_assets.sh [TARGET_DIR]
#
#   TARGET_DIR   Where to check the assets out (default: wasm/stk-assets,
#                which is gitignored).
#
set -euo pipefail

BASE_DIR="$(realpath "$(dirname "$0")")"   # wasm
TARGET_DIR="${1:-$BASE_DIR/stk-assets}"
ASSETS_URL="${STK_ASSETS_URL:-https://svn.code.sf.net/p/supertuxkart/code/stk-assets}"

if [ -d "$TARGET_DIR/.svn" ]; then
    echo "==> Updating stk-assets in $TARGET_DIR"
    svn update --non-interactive "$TARGET_DIR"
else
    echo "==> Checking out stk-assets into $TARGET_DIR"
    svn checkout --non-interactive "$ASSETS_URL" "$TARGET_DIR"
fi

echo "==> stk-assets ready in: $TARGET_DIR"
