# VPS Deployment (`docker-compose.yaml`)

This directory holds the Docker Compose stack deployed on the VPS that runs:

1. **`stk-gateway`** — WebSocket-to-ENet multiplayer gateway & headless SuperTuxKart gameservers.
2. **`podium-renderer`** — Internal-only Node.js service that composites Top-3 Time Trial podium PNGs from pre-rendered 3D kart & podium assets.
3. **`cloudflared`** — Cloudflare Tunnel daemon exposing `stk-gateway` and privately bridging `podium-renderer:3000` to Cloudflare Workers via **Workers VPC**.

## Setup

1. Copy `.env.example` to `.env` and fill in `CLOUDFLARE_TUNNEL_TOKEN` and `PODIUM_RENDER_SECRET`.
2. Start / update the stack:
   ```bash
   docker compose pull
   docker compose up -d
   ```

## Connecting `podium-renderer` via Cloudflare Workers VPC

1. In the Cloudflare Dashboard, open **Workers & Pages → Workers VPC → Create VPC Service** (or use `wrangler vpc service create`):
   - **Tunnel:** Select the tunnel backed by the `cloudflared` container above.
   - **Host / IP:** `podium-renderer` (Docker Compose service hostname)
   - **HTTP Port:** `3000`
2. Copy the generated **Service ID** UUID into `wasm/wrangler.jsonc` under `vpc_services` (binding name `PODIUM_RENDERER`).
3. Set the matching bearer secret on the Worker:
   ```bash
   cd wasm
   npx wrangler secret put PODIUM_RENDER_SECRET
   ```
