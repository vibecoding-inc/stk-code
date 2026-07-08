#!/bin/bash

set -e
set -x

BUILD_TYPE="${1:-'Release'}"

CORE_COUNT="$(nproc --all)"
BASE_DIR="$(realpath "$(dirname "$0")")"
SRC_DIR="$(dirname "$BASE_DIR")"
WEB_DIR="$BASE_DIR/web"
BUILD_DIR="$SRC_DIR/cmake_build/$BUILD_TYPE"
EMSDK_DIR="$BASE_DIR/emsdk"

mkdir -p $BUILD_DIR
cd $BUILD_DIR

source "$EMSDK_DIR/emsdk_env.sh"
embuilder build sdl2 sdl2_ttf sdl2_image sdl2_image_jpg sdl2_image_png
# CHECK_ASSETS is disabled because the web build ships its assets separately
# (packed by pack_assets.sh), so the sibling stk-assets/ checkout the upstream
# check expects is not required here.
emcmake cmake "$SRC_DIR" -DNO_SHADERC=on -DCHECK_ASSETS=off -DCMAKE_BUILD_TYPE=$BUILD_TYPE
make -j$CORE_COUNT

echo "copying wasm files"
mkdir -p "$WEB_DIR/game"
cp ./bin/* "$WEB_DIR/game/"

echo "applying patches"
python3 "$BASE_DIR/patch_js.py" "$BASE_DIR/fragments" "$WEB_DIR/game/supertuxkart.js"
