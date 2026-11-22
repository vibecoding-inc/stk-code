# Build context: repository root (same convention as wasm/gateway/Dockerfile).
# Example:
#   docker build -f wasm/podium-renderer/Dockerfile -t stk-podium-renderer:local .
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PORT=3000 \
    ASSETS_DIR=/app/assets \
    TRACKS_DIR=/app/tracks \
    FONT_DIRS=/app/fonts:/usr/share/fonts/truetype/dejavu

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY wasm/podium-renderer/package.json ./
RUN npm install --omit=dev

COPY wasm/podium-renderer/src ./src
COPY wasm/podium-renderer/tests ./tests

# Bundle SuperTuxKart's display, UI, and CJK fallback fonts directly from data/ttf/
RUN mkdir -p /app/fonts /app/assets /app/tracks
COPY data/ttf/SigmarOne.otf data/ttf/Cantarell-Regular.otf data/ttf/wqy-microhei.ttf /app/fonts/

# Optional pre-rendered 3D podium/kart assets & track screenshots (mounted in
# local dev/preview or populated before `docker build` in CI).
COPY wasm/podium-renderer/generated-assets/ /app/assets/

USER node
EXPOSE 3000

CMD ["node", "src/server.mjs"]
