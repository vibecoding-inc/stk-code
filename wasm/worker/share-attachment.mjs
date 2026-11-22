// Proxy for uploading a PNG scoreboard screenshot to Discord's ephemeral
// application attachment endpoint so the Activity iframe stays strictly
// same-origin under Discord's CSP and never needs to know DISCORD_CLIENT_ID
// on the server-side upload path.
//
// Discord API: POST /api/applications/{application_id}/attachment
//   Authorization: Bearer <user_access_token>
//   Content-Type: multipart/form-data (field "file")
// Returns: { attachment: { url: "https://cdn.discordapp.com/..." } }

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024; // 8 MiB

function json_response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {"Content-Type": "application/json"},
  });
}

export async function handleShareAttachment({request, env}) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {status: 405});
  }

  let auth_header = request.headers.get("Authorization") || "";
  if (!auth_header.startsWith("Bearer ") || auth_header.length <= "Bearer ".length) {
    return json_response({error: "Missing Bearer authorization token."}, 401);
  }
  let access_token = auth_header.slice("Bearer ".length).trim();
  if (!access_token) {
    return json_response({error: "Missing Bearer authorization token."}, 401);
  }

  if (!env.DISCORD_CLIENT_ID) {
    return json_response({error: "Discord client ID is not configured."}, 500);
  }

  let incoming_form;
  try {
    incoming_form = await request.formData();
  }
  catch {
    return json_response({error: "Invalid multipart form data."}, 400);
  }

  let file = incoming_form.get("file");
  if (!file || typeof file === "string" || typeof file.arrayBuffer !== "function") {
    return json_response({error: "Missing file upload."}, 400);
  }
  if (file.size <= 0) {
    return json_response({error: "Uploaded file is empty."}, 400);
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return json_response({error: "Uploaded file exceeds size limit."}, 413);
  }

  let outgoing_form = new FormData();
  let mime_type = file.type || "image/png";
  let file_name = file.name || "scoreboard.png";
  let blob = new Blob([await file.arrayBuffer()], {type: mime_type});
  outgoing_form.append("file", blob, file_name);

  let discord_url = `https://discord.com/api/applications/${encodeURIComponent(env.DISCORD_CLIENT_ID)}/attachment`;
  let response = await fetch(discord_url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${access_token}`,
    },
    body: outgoing_form,
  });

  let result;
  try {
    result = await response.json();
  }
  catch {
    return json_response({error: "Discord returned an invalid response."}, 502);
  }

  let media_url = result && result.attachment && result.attachment.url;
  if (!response.ok || !media_url) {
    return json_response({
      error: (result && (result.message || result.error)) || "Discord attachment upload failed.",
    }, response.status || 502);
  }

  return json_response({url: media_url});
}
