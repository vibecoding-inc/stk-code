FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        blender \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY spm_importer.py render_podium_assets.py /app/

ENTRYPOINT ["blender", "--background", "--python", "/app/render_podium_assets.py", "--"]
