import assert from "node:assert/strict";
import test from "node:test";

import {
  format_ordinal,
  build_presence_activity,
  create_discord_presence,
} from "../discord-presence.js";

test("format_ordinal formats standard English ordinals", () => {
  assert.equal(format_ordinal(1), "1st");
  assert.equal(format_ordinal(2), "2nd");
  assert.equal(format_ordinal(3), "3rd");
  assert.equal(format_ordinal(4), "4th");
  assert.equal(format_ordinal(11), "11th");
  assert.equal(format_ordinal(12), "12th");
  assert.equal(format_ordinal(13), "13th");
  assert.equal(format_ordinal(21), "21st");
  assert.equal(format_ordinal(0), "");
});

test("build_presence_activity builds concise race presence with track & kart assets", () => {
  let manifest = {
    tracks: {hacienda: "tracks/hacienda.jpg"},
    karts: {tux: "karts/tux.png"},
  };
  let activity = build_presence_activity(
    {
      phase: "race",
      track_ident: "hacienda",
      track_name: "Hacienda",
      kart_ident: "tux",
      kart_name: "Tux",
      rank: 2,
      total_karts: 8,
      in_multiplayer: true,
      human_players: 3,
      max_players: 8,
    },
    {
      manifest,
      public_origin: "https://stk.example.workers.dev",
      instance_id: "inst-123",
      start_timestamp_sec: 1700000000,
    }
  );

  assert.deepEqual(activity, {
    type: 0,
    details: "Hacienda",
    state: "2nd of 8",
    timestamps: {start: 1700000000},
    assets: {
      large_image: "https://stk.example.workers.dev/game/presence/tracks/hacienda.jpg",
      large_text: "Hacienda",
      small_image: "https://stk.example.workers.dev/game/presence/karts/tux.png",
      small_text: "Tux",
    },
    party: {
      id: "inst-123",
      size: [3, 8],
    },
  });
});

test("build_presence_activity omits party in singleplayer and uses concise Time Trial state", () => {
  let activity = build_presence_activity(
    {
      phase: "race",
      track_ident: "sandtrack",
      track_name: "Shifting Sands",
      kart_ident: "wilber",
      kart_name: "Wilber",
      is_time_trial: true,
      rank: 1,
      total_karts: 1,
      in_multiplayer: false,
      human_players: 1,
      max_players: 0,
    },
    {
      manifest: {tracks: {}, karts: {}},
      public_origin: "https://stk.example.workers.dev",
      instance_id: "inst-123",
      start_timestamp_sec: 1700000100,
    }
  );

  assert.equal(activity.details, "Shifting Sands");
  assert.equal(activity.state, "Time Trial");
  assert.equal(activity.party, undefined);
  assert.equal(activity.assets.large_image, "https://stk.example.workers.dev/supertuxkart_64.png");
  assert.equal(activity.assets.small_image, undefined);
});

test("build_presence_activity handles lobby, spectating, and results cleanly", () => {
  let lobby = build_presence_activity(
    {
      phase: "lobby",
      in_multiplayer: true,
      human_players: 2,
      max_players: 8,
    },
    {instance_id: "inst-1"}
  );
  assert.equal(lobby.details, "In Lobby");
  assert.equal(lobby.state, "Waiting to race");
  assert.deepEqual(lobby.party, {id: "inst-1", size: [2, 8]});

  let lobby_unknown_max = build_presence_activity(
    {
      phase: "lobby",
      in_multiplayer: true,
      human_players: 1,
      max_players: 0,
    },
    {instance_id: "inst-1"}
  );
  assert.equal(lobby_unknown_max.party, undefined);

  let spectating = build_presence_activity(
    {
      phase: "spectating",
      track_ident: "hacienda",
      track_name: "Hacienda",
      kart_ident: "tux",
      in_multiplayer: true,
      human_players: 4,
      max_players: 8,
    },
    {
      manifest: {tracks: {hacienda: "tracks/hacienda.jpg"}, karts: {tux: "karts/tux.png"}},
      public_origin: "https://stk.example.workers.dev",
      instance_id: "inst-1",
    }
  );
  assert.equal(spectating.details, "Hacienda");
  assert.equal(spectating.state, "Spectating");
  assert.equal(spectating.assets.small_image, undefined);

  let results = build_presence_activity(
    {
      phase: "results",
      track_name: "Hacienda",
      rank: 1,
      total_karts: 8,
    },
    {}
  );
  assert.equal(results.details, "Hacienda");
  assert.equal(results.state, "Finished 1st of 8");
});

test("create_discord_presence deduplicates, throttles non-forced updates, and flushes trailing", async () => {
  let sent = [];
  let now = 1000000;
  let scheduled = [];

  let presence = create_discord_presence({
    get_discord_sdk: () => ({
      instanceId: "inst-9",
      commands: {
        setActivity: async ({activity}) => {
          sent.push(activity);
        },
      },
    }),
    get_discord_auth: () => ({user: {id: "u1"}}),
    get_public_origin: () => "https://stk.example.workers.dev",
    now_ms: () => now,
    min_interval_ms: 8000,
    set_timeout: (fn, delay) => {
      let id = scheduled.length + 1;
      scheduled.push({id, fn, delay, cleared: false});
      return id;
    },
    clear_timeout: (id) => {
      let item = scheduled.find((s) => s.id === id);
      if (item) item.cleared = true;
    },
    logger: {warn() {}},
  });

  // First update sends immediately.
  assert.equal(await presence.update({phase: "race", track_ident: "hacienda", track_name: "Hacienda", rank: 3, total_karts: 8}), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].state, "3rd of 8");

  // Duplicate update does not send.
  now += 10000;
  assert.equal(await presence.update({phase: "race", track_ident: "hacienda", track_name: "Hacienda", rank: 3, total_karts: 8}), false);
  assert.equal(sent.length, 1);

  // Rank change after interval sends immediately.
  assert.equal(await presence.update({phase: "race", track_ident: "hacienda", track_name: "Hacienda", rank: 2, total_karts: 8}), true);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].state, "2nd of 8");

  // Rapid rank change within 8s is throttled and schedules a trailing flush.
  now += 2000;
  assert.equal(await presence.update({phase: "race", track_ident: "hacienda", track_name: "Hacienda", rank: 1, total_karts: 8}), false);
  assert.equal(sent.length, 2);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 6000);

  // Firing the scheduled flush sends the latest state.
  now += 6000;
  scheduled[0].fn();
  await Promise.resolve();
  assert.equal(sent.length, 3);
  assert.equal(sent[2].state, "1st of 8");

  // Forced update (e.g. race finished) bypasses throttle immediately.
  now += 1000;
  assert.equal(
    await presence.update({phase: "results", track_ident: "hacienda", track_name: "Hacienda", rank: 1, total_karts: 8}, {force: true}),
    true
  );
  assert.equal(sent.length, 4);
  assert.equal(sent[3].state, "Finished 1st of 8");

  presence.dispose();
});

test("create_discord_presence no-ops safely outside Discord and refreshes after manifest load", async () => {
  let sent = [];
  let authed = false;

  let presence = create_discord_presence({
    get_discord_sdk: () => (authed ? {
      instanceId: "inst-2",
      commands: {
        setActivity: async ({activity}) => { sent.push(activity); },
      },
    } : null),
    get_discord_auth: () => (authed ? {user: {id: "u1"}} : null),
    get_public_origin: () => "https://stk.example.workers.dev",
    fetch_impl: async () => Response.json({
      tracks: {hacienda: "tracks/hacienda.jpg"},
      karts: {tux: "karts/tux.png"},
    }),
    logger: {warn() {}},
  });

  // Outside Discord: safe no-op.
  assert.equal(await presence.update({phase: "menu"}), false);
  assert.equal(sent.length, 0);

  // Once authed, sends with fallback icon first, then refreshes when manifest resolves.
  authed = true;
  assert.equal(await presence.update({
    phase: "race",
    track_ident: "hacienda",
    track_name: "Hacienda",
    kart_ident: "tux",
    kart_name: "Tux",
    rank: 1,
    total_karts: 4,
  }, {force: true}), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].assets.large_image, "https://stk.example.workers.dev/supertuxkart_64.png");

  await presence.loadManifest();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].assets.large_image, "https://stk.example.workers.dev/game/presence/tracks/hacienda.jpg");
  assert.equal(sent[1].assets.small_image, "https://stk.example.workers.dev/game/presence/karts/tux.png");
});
