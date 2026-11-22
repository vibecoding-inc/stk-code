#!/usr/bin/env node
// Registers Discord application slash commands for SuperTuxKart WASM Time Trials.
//
// Usage:
//   DISCORD_CLIENT_ID=... DISCORD_BOT_TOKEN=... node wasm/scripts/register-commands.mjs
//
// Optional for instant guild-scoped dev testing (instead of global propagation):
//   DISCORD_GUILD_ID=... DISCORD_CLIENT_ID=... DISCORD_BOT_TOKEN=... node wasm/scripts/register-commands.mjs

export const COMMANDS = [
  {
    name: "timetrial",
    description: "Create a SuperTuxKart Time Trial challenge with ghost leaderboards",
    type: 1, // CHAT_INPUT
    integration_types: [0, 1], // GUILD_INSTALL, USER_INSTALL
    contexts: [0, 1, 2], // GUILD, BOT_DM, PRIVATE_CHANNEL
    options: [
      {
        name: "track",
        description: "Track to race on",
        type: 3, // STRING
        required: true,
        autocomplete: true,
      },
      {
        name: "laps",
        description: "Number of laps (default: 2)",
        type: 4, // INTEGER
        required: false,
        min_value: 1,
        max_value: 20,
      },
      {
        name: "difficulty",
        description: "Difficulty / speed class (default: Expert)",
        type: 4, // INTEGER
        required: false,
        choices: [
          {name: "Novice", value: 0},
          {name: "Intermediate", value: 1},
          {name: "Expert", value: 2},
          {name: "SuperTux", value: 3},
        ],
      },
      {
        name: "reverse",
        description: "Drive the track in reverse (default: false)",
        type: 5, // BOOLEAN
        required: false,
      },
    ],
  },
];

export async function register_commands({
  client_id = process.env.DISCORD_CLIENT_ID,
  bot_token = process.env.DISCORD_BOT_TOKEN,
  guild_id = process.env.DISCORD_GUILD_ID,
  fetch_impl = fetch,
} = {}) {
  if (!client_id || !bot_token) {
    throw new Error("DISCORD_CLIENT_ID and DISCORD_BOT_TOKEN must be set.");
  }

  let url = guild_id
    ? `https://discord.com/api/v10/applications/${encodeURIComponent(client_id)}/guilds/${encodeURIComponent(guild_id)}/commands`
    : `https://discord.com/api/v10/applications/${encodeURIComponent(client_id)}/commands`;

  let body = [...COMMANDS];

  // Discord rejects bulk PUT on global commands with code 50240 if the app's
  // PRIMARY_ENTRY_POINT command (type 4, used to launch Activities) is omitted.
  // Fetch existing global commands first and preserve any type 4 entry point.
  if (!guild_id) {
    let existing_resp = await fetch_impl(url, {
      method: "GET",
      headers: {
        Authorization: `Bot ${bot_token}`,
      },
    });
    if (!existing_resp.ok) {
      let text = await existing_resp.text();
      throw new Error(`Failed to fetch existing Discord commands (${existing_resp.status}): ${text}`);
    }
    let existing = await existing_resp.json();
    if (Array.isArray(existing)) {
      for (let cmd of existing) {
        if (cmd && cmd.type === 4) {
          let preserved = {
            name: cmd.name,
            description: cmd.description || "",
            type: 4,
          };
          if (cmd.handler !== undefined) preserved.handler = cmd.handler;
          if (cmd.integration_types !== undefined) preserved.integration_types = cmd.integration_types;
          if (cmd.contexts !== undefined) preserved.contexts = cmd.contexts;
          if (cmd.name_localizations !== undefined) preserved.name_localizations = cmd.name_localizations;
          if (cmd.description_localizations !== undefined) preserved.description_localizations = cmd.description_localizations;
          body.push(preserved);
        }
      }
    }
  }

  let resp = await fetch_impl(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bot ${bot_token}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    let text = await resp.text();
    throw new Error(`Discord command registration failed (${resp.status}): ${text}`);
  }

  return resp.json();
}

// Execute when run directly from CLI / CI.
if (import.meta.url === `file://${process.argv[1]}`) {
  register_commands()
    .then((registered) => {
      let scope = process.env.DISCORD_GUILD_ID
        ? `guild ${process.env.DISCORD_GUILD_ID}`
        : "global";
      console.log(`Registered ${registered.length} Discord command(s) (${scope}):`, registered.map((c) => `/${c.name}`).join(", "));
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
