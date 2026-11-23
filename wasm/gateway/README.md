# SuperTuxKart Discord Activity Multiplayer Gateway

Single-container Rust WebSocket-to-UDP gateway and on-demand headless `supertuxkart --server-only` room orchestrator.

## How It Works

1. The browser WASM client opens `wss://<origin>/api/lan` and sends a JSON auth frame:
   ```json
   { "access_token": "<discord_oauth_access_token>", "instance_id": "<discord_instance_id>" }
   ```
2. The gateway verifies:
   - `GET /users/@me` (`Bearer <access_token>`) → authoritative Discord `user.id`
   - `GET /applications/<app_id>/activity-instances/<instance_id>` (`Bot <bot_token>`) → confirms the Activity instance is active and `users` contains `user.id`
3. The gateway looks up or spawns a headless `supertuxkart --server-only` process for `instance_id` (bounded by `PORT_RANGE_START..PORT_RANGE_END`), binds a per-client ephemeral UDP socket, and forwards raw binary ENet datagrams between the WebSocket and the room's UDP port.
4. When a room empties, it is reaped after `ROOM_IDLE_TIMEOUT_SECS`.

## Running with Docker + Cloudflare Tunnel

```bash
docker run -d --name stk-gateway --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -e DISCORD_APPLICATION_ID="YOUR_APP_ID" \
  -e DISCORD_BOT_TOKEN="YOUR_BOT_TOKEN" \
  ghcr.io/<owner>/<repo>-gateway:latest
```

Then expose `http://127.0.0.1:8080` through `cloudflared` and add a Discord Activity URL Mapping for `/api/lan` pointing to your tunnel hostname.

## Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `DISCORD_APPLICATION_ID` | *(required)* | Discord Application / Client ID |
| `DISCORD_BOT_TOKEN` | *(required)* | Discord Bot Token (for `/activity-instances/` verification; bot does not need to be in any guild) |
| `ALLOWED_GUILD_IDS` | *(unset)* | Optional comma-separated guild ID allowlist |
| `GATEWAY_LISTEN_ADDR` | `0.0.0.0:8080` | HTTP/WebSocket bind address |
| `PORT_RANGE_START` / `PORT_RANGE_END` | `30000` / `30016` | Local UDP port pool (also caps max concurrent rooms) |
| `MAX_PLAYERS_PER_ROOM` | `16` | Max concurrent clients per room |
| `ROOM_IDLE_TIMEOUT_SECS` | `120` | Seconds before an empty room process is terminated |
| `MATCH_UPLOAD_URL` | *(unset)* | Optional Cloudflare Worker origin (deployed at `https://supertuxkart-wasm.profiluefter.workers.dev`) to persist multiplayer scoreboards & replays |
| `GATEWAY_API_SECRET` | *(unset)* | Shared bearer token (`openssl rand -hex 32`) matching the Worker's `GATEWAY_API_SECRET` secret |
| `DEV_INSECURE_AUTH` | `false` | Set `1` for local non-Discord testing only |
