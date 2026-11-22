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
    global_scope.discordSdk = discord_sdk;

    if (
      discord_sdk.commands &&
      typeof discord_sdk.commands.encourageHardwareAcceleration === "function"
    ) {
      try {
        let result = await discord_sdk.commands.encourageHardwareAcceleration();
        let enabled = Boolean(result && result.enabled);
        global_scope.discordHardwareAccelerationEnabled = enabled;
        logger.log(
          `Discord Hardware Acceleration is ${enabled ? "enabled" : "disabled"}.`
        );
      }
      catch (err) {
        logger.warn("Discord encourageHardwareAcceleration failed.", err);
      }
    }

    let {code} = await discord_sdk.commands.authorize({
      client_id: config.discord_client_id,
      response_type: "code",
      state: "",
      prompt: "none",
      scope: ["identify", "guilds.members.read", "rpc.activities.write"],
    });

    let token_payload = {code};
    if (discord_sdk.instanceId) {
      token_payload.instance_id = discord_sdk.instanceId;
    }
    let response = await fetch_impl("/api/token", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(token_payload),
    });
    let result = await response.json();
    if (!response.ok || !result.access_token) {
      throw new Error(result.error || "Discord token exchange failed.");
    }

    let auth = await discord_sdk.commands.authenticate({access_token: result.access_token});
    global_scope.discordSdk = discord_sdk;
    global_scope.discordAuth = auth;
    global_scope.discordAccessToken = result.access_token;
    global_scope.discordSessionToken = result.session_token || null;
    global_scope.discordGuildMember = result.guild_member || null;
    global_scope.stkPendingTimeTrial = result.pending_time_trial || null;
    global_scope.stkPublicOrigin = result.public_origin || null;
    logger.log(`Discord login succeeded for ${auth.user.username}.`);
    return auth;
  }
  catch (err) {
    logger.warn("Discord Activity login failed.", err);
  }
}

export function detect_mobile_touch({
  search = typeof window !== "undefined" && window.location ? window.location.search : "",
  global_scope = globalThis,
  navigator_obj = typeof navigator !== "undefined" ? navigator : null,
} = {}) {
  // 1. Authoritative Discord Activity SDK platform ("mobile" vs "desktop").
  let sdk_platform = global_scope && global_scope.discordSdk && global_scope.discordSdk.platform;
  if (typeof sdk_platform === "string" && sdk_platform.length > 0) {
    return sdk_platform.toLowerCase() === "mobile";
  }

  // 2. Authoritative Discord Activity URL query param (?platform=mobile|desktop).
  try {
    let params = new URLSearchParams(search || "");
    let query_platform = params.get("platform");
    if (query_platform) {
      return query_platform.toLowerCase() === "mobile";
    }
    if (params.has("frame_id")) {
      return false;
    }
  }
  catch {}

  // 3. Standalone browser fallback (outside Discord): mobile UA only so desktop
  //    touchscreen laptops are not misclassified as mobile.
  try {
    if (navigator_obj) {
      if (navigator_obj.userAgentData && typeof navigator_obj.userAgentData.mobile === "boolean") {
        return navigator_obj.userAgentData.mobile;
      }
      if (typeof navigator_obj.userAgent === "string") {
        return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator_obj.userAgent);
      }
    }
  }
  catch {}

  return false;
}

export function can_open_invite_dialog(global_scope = globalThis) {
  let sdk = global_scope && global_scope.discordSdk;
  return Boolean(
    sdk &&
    sdk.guildId &&
    sdk.commands &&
    typeof sdk.commands.openInviteDialog === "function"
  );
}

export async function open_discord_invite_dialog({
  global_scope = globalThis,
  logger = console,
} = {}) {
  if (!can_open_invite_dialog(global_scope)) {
    return false;
  }
  try {
    await global_scope.discordSdk.commands.openInviteDialog();
    return true;
  }
  catch (err) {
    logger.warn("Discord openInviteDialog failed.", err);
    return false;
  }
}