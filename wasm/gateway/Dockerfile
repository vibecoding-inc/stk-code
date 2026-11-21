# syntax=docker/dockerfile:1.7

# ---------------------------------------------------------------------------
# Stage 1: Build headless SuperTuxKart server (-DSERVER_ONLY=ON)
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS stk-server-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        cmake \
        ninja-build \
        pkg-config \
        libcurl4-openssl-dev \
        libssl-dev \
        libsqlite3-dev \
        zlib1g-dev \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY CMakeLists.txt sources.cmake ./
COPY cmake ./cmake
COPY src ./src
COPY lib ./lib

RUN mkdir -p /src/data \
    && cmake -B /build -G Ninja \
        -DCMAKE_BUILD_TYPE=Release \
        -DSERVER_ONLY=ON \
        -DCHECK_ASSETS=OFF \
        -DBUILD_RECORDER=OFF \
        -DNO_SHADERC=ON \
    && cmake --build /build --target supertuxkart -j"$(nproc)" \
    && strip /build/bin/supertuxkart

# ---------------------------------------------------------------------------
# Stage 2: Prepare minimal server data (repo data/ + stripped stk-assets)
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS stk-assets-prep

ARG STK_ASSETS_URL=https://svn.code.sf.net/p/supertuxkart/code/stk-assets

RUN apt-get update && apt-get install -y --no-install-recommends \
        subversion \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /assets
COPY data ./data

# Fetch karts, tracks, and shared library physics/metadata from stk-assets
# and strip client-only textures/audio to keep the server image compact.
RUN mkdir -p ./data/karts ./data/tracks ./data/library \
    && svn export --force --non-interactive "${STK_ASSETS_URL}/karts" ./data/karts \
    && svn export --force --non-interactive "${STK_ASSETS_URL}/tracks" ./data/tracks \
    && svn export --force --non-interactive "${STK_ASSETS_URL}/library" ./data/library \
    && find ./data/karts ./data/tracks ./data/library -type f \
        \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' \
           -o -iname '*.ogg' -o -iname '*.wav' -o -iname '*.opus' \
           -o -iname '*.ttf' -o -iname '*.otf' -o -iname '*.xcf' \) \
        -delete \
    && rm -rf ./data/music ./data/sfx

# ---------------------------------------------------------------------------
# Stage 3: Build Rust WebSocket-to-UDP Gateway & Room Orchestrator
# ---------------------------------------------------------------------------
FROM rust:1-bookworm AS rust-builder

WORKDIR /gateway
COPY wasm/gateway/Cargo.toml wasm/gateway/Cargo.lock ./
COPY wasm/gateway/src ./src

RUN cargo build --release --locked \
    && strip target/release/stk-gateway

# ---------------------------------------------------------------------------
# Stage 4: Minimal Runtime Image (Gateway + Headless STK Server)
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
        tini \
        ca-certificates \
        libcurl4 \
        libssl3 \
        libsqlite3-0 \
        zlib1g \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 10001 -s /usr/sbin/nologin stk

COPY --from=stk-server-builder /build/bin/supertuxkart /usr/local/bin/supertuxkart
COPY --from=rust-builder /gateway/target/release/stk-gateway /usr/local/bin/stk-gateway
COPY --from=stk-assets-prep /assets/data /usr/share/supertuxkart/data

ENV GATEWAY_LISTEN_ADDR=0.0.0.0:8080 \
    STK_SERVER_BIN=/usr/local/bin/supertuxkart \
    STK_DATA_DIR=/usr/share/supertuxkart/data \
    SUPERTUXKART_DATADIR=/usr/share/supertuxkart/data \
    PORT_RANGE_START=30000 \
    PORT_RANGE_END=30016 \
    MAX_PLAYERS_PER_ROOM=16 \
    ROOM_IDLE_TIMEOUT_SECS=120 \
    RUST_LOG=stk_gateway=info

USER stk
WORKDIR /home/stk

EXPOSE 8080

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/stk-gateway"]
