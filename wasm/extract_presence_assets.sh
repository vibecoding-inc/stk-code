#!/bin/bash
# Extract track screenshots and kart icons from wasm/web/game/data_low.tar.gz.*
# into wasm/web/game/presence/ + manifest.json so Discord Rich Presence can
# display track thumbnails (large_image) and kart icons (small_image) directly
# from Cloudflare Workers static assets without busting the packed-assets cache.

set -euo pipefail

BASE_DIR="$(realpath "$(dirname "$0")")"
GAME_DIR="$BASE_DIR/web/game"
OUT_DIR="$GAME_DIR/presence"

shopt -s nullglob
CHUNKS=()
for f in "$GAME_DIR"/data_low.tar.gz.[0-9]*; do
  CHUNKS+=("$f")
done
shopt -u nullglob

if [ "${#CHUNKS[@]}" -eq 0 ]; then
  echo "extract_presence_assets: no data_low.tar.gz.* chunks found in $GAME_DIR; skipping."
  exit 0
fi

python3 - "$OUT_DIR" "${CHUNKS[@]}" <<'PY'
import io
import json
import os
import posixpath
import shutil
import sys
import tarfile
import xml.etree.ElementTree as ET

out_dir = sys.argv[1]
chunks = sorted(sys.argv[2:])

buf = io.BytesIO()
for chunk_path in chunks:
    with open(chunk_path, "rb") as fh:
        shutil.copyfileobj(fh, buf)
buf.seek(0)

# Pass 1: index XML descriptors and candidate image members inside tracks/ & karts/.
track_xmls = {}
kart_xmls = {}
images_by_path = {}
images_by_dir_stem = {}

with tarfile.open(fileobj=buf, mode="r:gz") as tf:
    members = tf.getmembers()
    for m in members:
        if not m.isfile():
            continue
        norm = posixpath.normpath(m.name).lstrip("./")
        parts = norm.split("/")
        if len(parts) < 3:
            continue
        root, ident, rest = parts[0], parts[1], "/".join(parts[2:])
        if root not in ("tracks", "karts"):
            continue
        if root == "tracks" and rest == "track.xml":
            f = tf.extractfile(m)
            if f:
                track_xmls[ident] = f.read()
        elif root == "karts" and rest == "kart.xml":
            f = tf.extractfile(m)
            if f:
                kart_xmls[ident] = f.read()
        elif norm.lower().endswith((".jpg", ".jpeg", ".png")):
            images_by_path[norm.lower()] = m
            dirname = posixpath.dirname(norm).lower()
            stem = posixpath.splitext(posixpath.basename(norm))[0].lower()
            # Prefer .jpg for tracks and .png for karts if both exist; store first and overwrite smartly.
            key = (dirname, stem)
            if key not in images_by_dir_stem:
                images_by_dir_stem[key] = m

    def resolve_image(root_dir, ident, rel_file):
        if not rel_file:
            return None
        candidate = posixpath.normpath(posixpath.join(root_dir, ident, rel_file)).lower()
        if candidate in images_by_path:
            return images_by_path[candidate]
        dirname = posixpath.dirname(candidate)
        stem = posixpath.splitext(posixpath.basename(candidate))[0]
        return images_by_dir_stem.get((dirname, stem))

    if os.path.exists(out_dir):
        shutil.rmtree(out_dir)
    os.makedirs(os.path.join(out_dir, "tracks"), exist_ok=True)
    os.makedirs(os.path.join(out_dir, "karts"), exist_ok=True)

    manifest = {"tracks": {}, "karts": {}}

    for ident, xml_bytes in sorted(track_xmls.items()):
        try:
            root = ET.fromstring(xml_bytes)
        except ET.ParseError:
            continue
        if root.attrib.get("internal", "").lower() in ("y", "yes", "true", "1"):
            continue
        screenshot = root.attrib.get("screenshot", "").strip()
        member = resolve_image("tracks", ident, screenshot)
        if not member:
            continue
        ext = posixpath.splitext(member.name)[1].lower() or ".jpg"
        rel_out = f"tracks/{ident}{ext}"
        f = tf.extractfile(member)
        if f:
            with open(os.path.join(out_dir, rel_out), "wb") as out_f:
                shutil.copyfileobj(f, out_f)
            manifest["tracks"][ident] = rel_out

    for ident, xml_bytes in sorted(kart_xmls.items()):
        try:
            root = ET.fromstring(xml_bytes)
        except ET.ParseError:
            continue
        icon_file = root.attrib.get("icon-file", "").strip()
        member = resolve_image("karts", ident, icon_file)
        if not member:
            continue
        ext = posixpath.splitext(member.name)[1].lower() or ".png"
        rel_out = f"karts/{ident}{ext}"
        f = tf.extractfile(member)
        if f:
            with open(os.path.join(out_dir, rel_out), "wb") as out_f:
                shutil.copyfileobj(f, out_f)
            manifest["karts"][ident] = rel_out

    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as mf:
        json.dump(manifest, mf, separators=(",", ":"), sort_keys=True)

    print(
        f"extract_presence_assets: extracted {len(manifest['tracks'])} track(s) "
        f"and {len(manifest['karts'])} kart(s) into {out_dir}"
    )
PY
