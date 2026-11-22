FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ARG BLENDER_VERSION=4.2.9

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        xz-utils \
        libgl1 \
        libgomp1 \
        libsm6 \
        libx11-6 \
        libxfixes3 \
        libxi6 \
        libxkbcommon0 \
        libxrender1 \
        libxxf86vm1 \
    && curl -fsSL "https://download.blender.org/release/Blender4.2/blender-${BLENDER_VERSION}-linux-x64.tar.xz" \
        -o /tmp/blender.tar.xz \
    && mkdir -p /opt/blender \
    && tar -xJf /tmp/blender.tar.xz --strip-components=1 -C /opt/blender \
    && rm -f /tmp/blender.tar.xz \
    && ln -s /opt/blender/blender /usr/local/bin/blender \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY spm_importer.py render_podium_assets.py /app/

ENTRYPOINT ["blender", "--background", "--python", "/app/render_podium_assets.py", "--"]
