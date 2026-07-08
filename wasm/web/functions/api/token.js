// Configure DISCORD_CLIENT_ID as a Cloudflare Pages environment variable and
// DISCORD_CLIENT_SECRET as a Cloudflare Pages secret for this token exchange.

function json_response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {"Content-Type": "application/json"},
  });
}

export async function onRequestPost({request, env}) {
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