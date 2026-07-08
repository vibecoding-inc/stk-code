export async function init_discord_activity({
  config,
  search,
  create_discord_sdk,
  fetch_impl,
  logger,
  global_scope,
}) {
  try {
    if (!new URLSearchParams(search).has("frame_id")) {
      return;
    }
    if (!config.discord_client_id) {
      logger.warn("Discord Activity login skipped: discord_client_id is not configured.");
      return;
    }

    let discord_sdk = create_discord_sdk(config.discord_client_id);
    await discord_sdk.ready();

    let {code} = await discord_sdk.commands.authorize({
      client_id: config.discord_client_id,
      response_type: "code",
      state: "",
      prompt: "none",
      scope: ["identify"],
    });

    let response = await fetch_impl("/api/token", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({code}),
    });
    let result = await response.json();
    if (!response.ok || !result.access_token) {
      throw new Error(result.error || "Discord token exchange failed.");
    }

    let auth = await discord_sdk.commands.authenticate({access_token: result.access_token});
    global_scope.discordSdk = discord_sdk;
    global_scope.discordAuth = auth;
    logger.log(`Discord login succeeded for ${auth.user.username}.`);
    return auth;
  }
  catch (err) {
    logger.warn("Discord Activity login failed.", err);
  }
}