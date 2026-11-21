export function get_discord_username(discord_auth) {
  let raw = discord_auth && discord_auth.user && discord_auth.user.username;
  if (typeof raw !== "string") return null;
  let trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Encodes strings using the same &#xHEX; scheme as SuperTuxKart's
// StringUtils::xmlEncode / StringUtils::xmlDecode.
export function xml_encode_stk(value) {
  let out = "";
  for (let ch of String(value)) {
    let cp = ch.codePointAt(0);
    if (
      cp < 0x20 ||
      cp >= 0x80 ||
      ch === "&" ||
      ch === "<" ||
      ch === ">" ||
      ch === "\"" ||
      ch === "'" ||
      ch === " "
    ) {
      out += `&#x${cp.toString(16).toUpperCase()};`;
    }
    else {
      out += ch;
    }
  }
  return out;
}

export function build_players_xml(username) {
  let encoded = xml_encode_stk(username);
  return [
    '<?xml version="1.0"?>',
    '<players version="1" >',
    `    <current player="${encoded}"/>`,
    `    <player name="${encoded}" guest="false" use-frequency="1"`,
    '            icon-filename=""',
    '            unique-id="1" saved-session="false"',
    '            saved-user="0" saved-token=""',
    '            last-online-name="" last-was-online="false"',
    '            remember-password="false"',
    '            default-kart-color="0">',
    '    </player>',
    '</players>',
    '',
  ].join("\n");
}

export function build_config_xml() {
  return [
    '<?xml version="1.0"?>',
    '<stkconfig version="8" >',
    '    <enable_internet value="1" />',
    '    <always_show_login_screen value="false" />',
    '    <unlock_everything value="2" />',
    '</stkconfig>',
    '',
  ].join("\n");
}

export function resolve_stk_config_dir(env) {
  let savedir = env && typeof env.SUPERTUXKART_SAVEDIR === "string"
    ? env.SUPERTUXKART_SAVEDIR.trim()
    : "";
  if (savedir) {
    return `${savedir.replace(/\/+$/, "")}/config-0.10`;
  }
  let xdg = env && typeof env.XDG_CONFIG_HOME === "string"
    ? env.XDG_CONFIG_HOME.trim()
    : "";
  if (xdg) {
    return `${xdg.replace(/\/+$/, "")}/supertuxkart/config-0.10`;
  }
  let home = env && typeof env.HOME === "string" && env.HOME.trim()
    ? env.HOME.trim().replace(/\/+$/, "")
    : "/home/web_user";
  return `${home}/.config/supertuxkart/config-0.10`;
}

function mkdir_p(fs, dir_path) {
  let parts = dir_path.split("/").filter(Boolean);
  let current = "";
  for (let part of parts) {
    current += "/" + part;
    try {
      fs.mkdir(current);
    }
    catch {}
  }
}

export function provision_discord_profile({fs, discord_auth, env} = {}) {
  let username = get_discord_username(discord_auth);
  if (!username) {
    return {applied: false, username: null, config_dir: null};
  }

  let config_dir = resolve_stk_config_dir(env);
  mkdir_p(fs, config_dir);
  fs.writeFile(`${config_dir}/players.xml`, build_players_xml(username));
  fs.writeFile(`${config_dir}/config.xml`, build_config_xml());

  return {applied: true, username, config_dir};
}
