// Discord OAuth2 authorization-code -> access-token exchange, performed
// server-side inside the Worker so the client secret never reaches the browser.
//
// This used to be a Cloudflare Pages Function (wasm/web/functions/api/token.js);
// after migrating to Cloudflare Workers it is a plain handler invoked from the
// Worker entry point (worker/index.mjs) for POST /api/token.
//
// Configure these as Worker secrets/vars (e.g. `wrangler secret put ...` or in
// the Cloudflare dashboard) - they must NOT be committed:
//   DISCORD_CLIENT_ID      the Discord application (client) id.
//   DISCORD_CLIENT_SECRET  the Discord application client secret.

function json_response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {"Content-Type": "application/json"},
  });
}

export async function handleTokenExchange({request, env}) {
  let payload;
  try {
    payload = await request.json();
  }
  catch {
    return json_response({error: "Invalid JSON body."}, 400);
  }

  if (!payload.code) {
    return json_response({error: "Missing authorization code."}, 400);
  }
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) {
    return json_response({error: "Discord OAuth environment variables are not configured."}, 500);
  }

  let body = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    client_secret: env.DISCORD_CLIENT_SECRET,
    grant_type: "authorization_code",
    code: payload.code,
  });

  let response = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: {"Content-Type": "application/x-www-form-urlencoded"},
    body,
  });

  let result;
  try {
    result = await response.json();
  }
  catch {
    return json_response({error: "Discord returned an invalid response."}, 502);
  }

  if (!response.ok || !result.access_token) {
    return json_response({
      error: result.error_description || result.error || "Discord token exchange failed.",
    }, response.status || 502);
  }

  return json_response({access_token: result.access_token});
}
