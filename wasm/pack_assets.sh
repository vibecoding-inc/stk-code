#!/bin/bash

set -e
set -x

BASE_DIR="$(realpath "$(dirname "$0")")"
SRC_DIR="$(dirname "$BASE_DIR")"
WEB_DIR="$BASE_DIR/web"
ASSETS_DIR="$(realpath "$1")"
ASSETS_SCRIPT="$SRC_DIR/android/generate_assets.sh"

LOW_QUALITY_DIR="$WEB_DIR/game/data_low"
MEDIUM_QUALITY_DIR="$WEB_DIR/game/data_mid"
HIGH_QUALITY_DIR="$WEB_DIR/game/data_high"

# The front-end (wasm/web/script.js) reads this token and wipes its cached
# IndexedDB copy of the assets whenever it changes, so a redeploy of new bundles
# is picked up automatically without anyone having to bump a constant by hand.
VERSION_FILE="$WEB_DIR/game/data_version.txt"
# Collects the per-bundle content hashes; the final version is their digest.
VERSION_PARTS="$(mktemp)"
trap 'rm -f "$VERSION_PARTS"' EXIT

create_manifest() {
  local path="$1"
  local file_name="$(basename "$path")"
  local data_dir="$(dirname "$path")"
  local size="$(du -b "$path" | cut -f1)"
  local chunks="$(find "$data_dir" -name "$file_name.*" | sort)"

  echo "$size"
  for chunk in $chunks; do
    local chunk_name="$(basename "$chunk")"
    local ending="$(echo "$chunk_name" | rev | cut -d'.' -f1 | rev)"
    if [ "$ending" = "manifest" ]; then
      continue
    fi
    echo "$chunk_name"
  done
}

pack_dir() {
  local source_dir="$1"
  local out_path="$2"
  tar -cf - -C "$source_dir" . | gzip -9 - > "$out_path"
  # Record the bundle's content hash so data_version.txt changes iff the packed
  # data changes (see VERSION_FILE below).
  sha256sum "$out_path" | cut -d' ' -f1 >> "$VERSION_PARTS"
  split -b 20m --numeric-suffixes "$out_path" "$out_path."
  create_manifest "$out_path" > "$out_path.manifest"
  rm "$out_path"
}

# Guard against the exact failure that shows up as white / untextured item boxes
# in the browser: a model (.spm/.b3d) that references a texture which is not in
# the packed bundle (e.g. a .png that was converted to .jpg but whose reference
# was not updated). STK resolves model textures by file name, so we check that
# every texture a model references exists somewhere in the tree.
validate_textures() {
  local data_root="$1"
  echo "Validating model texture references in $data_root"

  local present_list
  present_list="$(mktemp)"
  find "$data_root" -type f \( -iname "*.png" -o -iname "*.jpg" \) \
    -printf '%f\n' | sort -u > "$present_list"

  local missing=0
  local model ref refs
  while IFS= read -r model; do
    refs="$(grep -aoiE '[A-Za-z0-9_.-]+\.(png|jpg)' "$model" || true)"
    for ref in $refs; do
      ref="$(basename "$ref")"
      if ! grep -qxiF "$ref" "$present_list"; then
        echo "  MISSING TEXTURE: $(basename "$model") references '$ref' "\
             "but no such file exists in the bundle"
        missing=1
      fi
    done
  done < <(find "$data_root" -type f \( -iname "*.spm" -o -iname "*.b3d" \))

  rm -f "$present_list"

  if [ "$missing" -ne 0 ]; then
    echo "ERROR: packed data has dangling model texture references (see above)." >&2
    echo "These render as white / untextured meshes in game; refusing to pack." >&2
    exit 1
  fi

  echo "  All model texture references resolved."
}

generate_dir() {
  local data_dir="$1"
  local output_path="$2"
  local texture_size="$3"
  ASSETS_PATHS="$ASSETS_DIR" OUTPUT_PATH="$data_dir" TEXTURE_SIZE="$texture_size" $ASSETS_SCRIPT
  (cd $data_dir/data && ./optimize_data.sh)
  validate_textures "$data_dir/data"
  pack_dir "$data_dir/data" "$output_path"
}

if [ ! "$ASSETS_DIR" ]; then
  echo "assets not found"
  exit 1
fi

generate_dir "$LOW_QUALITY_DIR" "$WEB_DIR/game/data_low.tar.gz" 256
generate_dir "$MEDIUM_QUALITY_DIR" "$WEB_DIR/game/data_mid.tar.gz" 512
generate_dir "$HIGH_QUALITY_DIR" "$WEB_DIR/game/data_high.tar.gz" 1024

# Derive the asset-cache version from the packed bundle hashes and publish it
# next to them, so the browser refetches automatically on any change.
sha256sum "$VERSION_PARTS" | cut -c1-16 > "$VERSION_FILE"
echo "Wrote asset version $(cat "$VERSION_FILE") to $VERSION_FILE"