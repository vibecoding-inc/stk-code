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

# Advisory check for the class of bug that shows up as white / untextured item
# boxes in the browser: a model (.spm/.b3d) that references a texture which is
# not present in the packed bundle at all.
#
# IMPORTANT: this must match textures by *stem* (name without extension), not by
# exact file name. The asset pipeline (android/generate_assets.sh) converts most
# opaque .png textures to .jpg to shrink the download and deletes the .png, but
# it only rewrites the reference embedded in a model when the texture happens to
# live in that model's own directory. Shared textures (e.g. under data/textures)
# are therefore routinely referenced as "foo.png" by a model while the packed
# file is "foo.jpg" — a completely normal, working situation. Matching on the
# exact extension flagged hundreds of these healthy models and aborted the pack.
#
# So: a reference to "foo.png" is considered satisfied if either "foo.png" or
# "foo.jpg" exists. Only a stem that is missing under *both* extensions is worth
# reporting, and even then we only warn (never abort) — the pipeline is allowed
# to legitimately drop textures a model no longer needs, and blocking a deploy on
# a heuristic string scan of binary meshes caused more harm than the bug it was
# meant to catch.
validate_textures() {
  local data_root="$1"
  echo "Validating model texture references in $data_root"

  # Keep this loop out of the (very verbose) xtrace output; scanning every mesh
  # under `set -x` produced a ~500k-line CI log.
  local had_xtrace=0
  case "$-" in *x*) had_xtrace=1; set +x;; esac

  local present_stems
  present_stems="$(mktemp)"
  find "$data_root" -type f \( -iname "*.png" -o -iname "*.jpg" \) \
    -printf '%f\n' | sed 's/\.[^.]*$//' | sort -u > "$present_stems"

  local missing=0
  local model ref refs stem
  while IFS= read -r model; do
    refs="$(grep -aoiE '[A-Za-z0-9_.-]+\.(png|jpg)' "$model" || true)"
    for ref in $refs; do
      stem="$(basename "$ref")"
      stem="${stem%.*}"
      if ! grep -qxiF "$stem" "$present_stems"; then
        echo "  WARNING: missing texture: $(basename "$model") references" \
             "'$ref' but no matching .png/.jpg is in the bundle"
        missing=$((missing + 1))
      fi
    done
  done < <(find "$data_root" -type f \( -iname "*.spm" -o -iname "*.b3d" \))

  rm -f "$present_stems"

  if [ "$missing" -ne 0 ]; then
    echo "WARNING: $missing model texture reference(s) resolved to no packed" \
         "file (see above). This *may* render as white / untextured meshes;" \
         "review those assets if they look wrong in game." >&2
  else
    echo "  All model texture references resolved."
  fi

  if [ "$had_xtrace" -eq 1 ]; then set -x; fi
  return 0
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