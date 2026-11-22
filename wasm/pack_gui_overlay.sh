#!/bin/bash
#
# Pack the lightweight GUI XML overlay (data/gui/screens + data/gui/dialogs)
# into wasm/web/game/data_gui.tar.gz (~26 KB).
#
# This runs independently of wasm/pack_assets.sh so .stkgui edits never
# invalidate the heavy stk-assets cache in CI or bust players' IndexedDB caches.

set -euo pipefail

BASE_DIR="$(realpath "$(dirname "$0")")"
SRC_DIR="$(dirname "$BASE_DIR")"
OUT_DIR="$BASE_DIR/web/game"
OUT_PATH="$OUT_DIR/data_gui.tar.gz"

mkdir -p "$OUT_DIR"
# Pack with leading "./" so entries match pack_assets.sh's layout
# (./gui/screens/..., ./gui/dialogs/...) when untarred over /data.
tar -cf - -C "$SRC_DIR/data" ./gui/screens ./gui/dialogs | gzip -9 - > "$OUT_PATH"
echo "Packed GUI overlay ($(du -h "$OUT_PATH" | cut -f1)) to $OUT_PATH"
