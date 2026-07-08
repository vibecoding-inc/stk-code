# Reproducible build environment for the SuperTuxKart WebAssembly port.
#
# It is based on the official, pinned Emscripten SDK image (emcc/em++/emcmake/
# emmake/embuilder are already installed and activated at $EMSDK), and adds the
# autotools and image/audio tools required to cross-compile the dependencies and
# to pack the game assets.
#
# The version is pinned on purpose so local and CI builds are identical. Bump it
# deliberately when you want to move to a newer Emscripten.
ARG EMSDK_VERSION=3.1.64
FROM emscripten/emsdk:${EMSDK_VERSION}

# - autoconf/automake/libtool/pkg-config: needed by the dependency build
#   (ogg/vorbis/curl/harfbuzz autogen.sh / autoreconf).
# - ragel: harfbuzz generates its OpenType shaper state machines
#   (hb-ot-shaper-*-machine.hh) from .rl sources with ragel; the git checkout
#   does not ship the pre-generated headers, so the build fails without it.
# - imagemagick/vorbis-tools/pngquant/advancecomp/libjpeg-progs/optipng/gawk:
#   used by the asset packing pipeline (android/generate_assets.sh +
#   data/optimize_data.sh).
# - subversion: used to fetch the external stk-assets repository.
RUN apt-get update && apt-get install -y --no-install-recommends \
        autoconf \
        automake \
        libtool \
        pkg-config \
        ragel \
        imagemagick \
        vorbis-tools \
        pngquant \
        advancecomp \
        libjpeg-progs \
        optipng \
        gawk \
        subversion \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
