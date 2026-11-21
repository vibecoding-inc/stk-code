import assert from "node:assert/strict";
import test from "node:test";

import {
  build_config_xml,
  build_players_xml,
  get_discord_username,
  provision_discord_profile,
  resolve_stk_config_dir,
  xml_encode_stk,
} from "../discord-profile.js";

test("get_discord_username uses username and ignores display name (global_name)", () => {
  let username = get_discord_username({
    user: {
      id: "123",
      username: "tux_racer.99",
      global_name: "Tux The Racer! 🐧",
    },
  });
  assert.equal(username, "tux_racer.99");

  assert.equal(get_discord_username({user: {global_name: "Display Only"}}), null);
  assert.equal(get_discord_username({user: {username: "   "}}), null);
  assert.equal(get_discord_username(null), null);
  assert.equal(get_discord_username(undefined), null);
});

test("xml_encode_stk leaves standard Discord username characters intact and encodes specials", () => {
  assert.equal(xml_encode_stk("tux_racer.99"), "tux_racer.99");
  assert.equal(xml_encode_stk('a&b<"c"> '), "a&#x26;b&#x3C;&#x22;c&#x22;&#x3E;&#x20;");
  assert.equal(xml_encode_stk("ü"), "&#xFC;");
});

test("build_players_xml sets current player and profile to the Discord username", () => {
  let xml = build_players_xml("tux_racer.99");
  assert.match(xml, /<players version="1" >/);
  assert.match(xml, /<current player="tux_racer\.99"\/>/);
  assert.match(xml, /<player name="tux_racer\.99" guest="false" use-frequency="1"/);
  assert.match(xml, /unique-id="1"/);
  assert.match(xml, /<\/players>/);
});

test("build_config_xml enables internet permission, skips login screen prompt, and unlocks everything", () => {
  let xml = build_config_xml();
  assert.match(xml, /<stkconfig version="8" >/);
  assert.match(xml, /<enable_internet value="1" \/>/);
  assert.match(xml, /<always_show_login_screen value="false" \/>/);
  assert.match(xml, /<unlock_everything value="2" \/>/);
});

test("resolve_stk_config_dir matches FileManager::checkAndCreateConfigDir precedence", () => {
  assert.equal(resolve_stk_config_dir(undefined), "/home/web_user/.config/supertuxkart/config-0.10");
  assert.equal(resolve_stk_config_dir({HOME: "/home/custom/"}), "/home/custom/.config/supertuxkart/config-0.10");
  assert.equal(
    resolve_stk_config_dir({HOME: "/home/custom", XDG_CONFIG_HOME: "/xdg/cfg"}),
    "/xdg/cfg/supertuxkart/config-0.10",
  );
  assert.equal(
    resolve_stk_config_dir({
      HOME: "/home/custom",
      XDG_CONFIG_HOME: "/xdg/cfg",
      SUPERTUXKART_SAVEDIR: "/save/dir/",
    }),
    "/save/dir/config-0.10",
  );
});

test("provision_discord_profile creates config directories and writes players.xml and config.xml", () => {
  let dirs = new Set(["/home", "/home/web_user"]);
  let files = new Map();
  let fake_fs = {
    mkdir(path) {
      if (dirs.has(path)) {
        throw new Error("EEXIST");
      }
      dirs.add(path);
    },
    writeFile(path, content) {
      files.set(path, content);
    },
  };

  let result = provision_discord_profile({
    fs: fake_fs,
    discord_auth: {
      user: {
        id: "42",
        username: "karter_1",
        global_name: "Should Not Be Used",
      },
    },
  });

  assert.deepEqual(result, {
    applied: true,
    username: "karter_1",
    config_dir: "/home/web_user/.config/supertuxkart/config-0.10",
  });
  assert.ok(dirs.has("/home/web_user/.config/supertuxkart/config-0.10"));

  let players_xml = files.get("/home/web_user/.config/supertuxkart/config-0.10/players.xml");
  assert.ok(players_xml);
  assert.match(players_xml, /<current player="karter_1"\/>/);
  assert.doesNotMatch(players_xml, /Should Not Be Used/);

  let config_xml = files.get("/home/web_user/.config/supertuxkart/config-0.10/config.xml");
  assert.ok(config_xml);
  assert.match(config_xml, /<enable_internet value="1" \/>/);
});

test("provision_discord_profile is a no-op when Discord auth is absent", () => {
  let touched = false;
  let fake_fs = {
    mkdir() {
      touched = true;
    },
    writeFile() {
      touched = true;
    },
  };

  let result = provision_discord_profile({
    fs: fake_fs,
    discord_auth: undefined,
  });

  assert.deepEqual(result, {
    applied: false,
    username: null,
    config_dir: null,
  });
  assert.equal(touched, false);
});
