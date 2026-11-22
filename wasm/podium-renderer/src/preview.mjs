/**
 * Generates sample podium PNGs locally into preview-output/ so you can visually
 * inspect spacing, avatars, fonts, truncation, and kart alignment before deploying.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeFallbackAvatarDataUri } from "./avatars.mjs";
import { PodiumCompositor } from "./compositor.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

const ASSETS_DIR = process.env.ASSETS_DIR || path.join(ROOT_DIR, "generated-assets");
const TRACKS_DIR = process.env.TRACKS_DIR || path.join(ROOT_DIR, "tracks");
const OUT_DIR = process.env.PREVIEW_OUT_DIR || path.join(ROOT_DIR, "preview-output");
const FONT_DIRS = (
  process.env.FONT_DIRS ||
  [
    path.join(ROOT_DIR, "fonts"),
    path.resolve(ROOT_DIR, "../../data/ttf"),
    "/usr/share/fonts/truetype/dejavu",
  ].join(":")
).split(":");

fs.mkdirSync(OUT_DIR, { recursive: true });

const compositor = new PodiumCompositor({
  assetsDir: ASSETS_DIR,
  tracksDir: TRACKS_DIR,
  fontDirs: FONT_DIRS,
});

const CASES = [
  {
    file: "preview_full_3p.png",
    payload: {
      track: "hacienda",
      track_name: "Hacienda",
      laps: 3,
      difficulty: "SuperTux",
      reverse: false,
      entries: [
        {
          rank: 1,
          user_id: "1001",
          display_name: "SpeedyTux",
          kart: "tux",
          time_ms: 82415,
          avatar_data_uri: makeFallbackAvatarDataUri("SpeedyTux", "1001"),
        },
        {
          rank: 2,
          user_id: "1002",
          display_name: "NolokDrift",
          kart: "nolok",
          time_ms: 83902,
          avatar_data_uri: makeFallbackAvatarDataUri("NolokDrift", "1002"),
        },
        {
          rank: 3,
          user_id: "1003",
          display_name: "HexleyPro",
          kart: "hexley",
          time_ms: 85119,
          avatar_data_uri: makeFallbackAvatarDataUri("HexleyPro", "1003"),
        },
      ],
    },
  },
  {
    file: "preview_stress_names.png",
    payload: {
      track: "cocoa_temple",
      track_name: "Cocoa Temple",
      laps: 3,
      difficulty: "Expert",
      reverse: true,
      entries: [
        {
          rank: 1,
          user_id: "2001",
          display_name: "VeryLongGuildNicknameThatMustTruncateCleanly",
          kart: "gnu",
          time_ms: 124999,
          avatar_data_uri: makeFallbackAvatarDataUri("V", "2001"),
        },
        {
          rank: 2,
          user_id: "2002",
          display_name: "東京ドリフト王",
          kart: "sara_the_racer",
          time_ms: 126450,
          avatar_data_uri: makeFallbackAvatarDataUri("東", "2002"),
        },
        {
          rank: 3,
          user_id: "2003",
          display_name: "SuperLongThirdPlaceName99",
          kart: "adiumy",
          time_ms: 129008,
          avatar_data_uri: makeFallbackAvatarDataUri("S", "2003"),
        },
      ],
    },
  },
  {
    file: "preview_1p.png",
    payload: {
      track: "olivermath",
      track_name: "Oliver's Math Class",
      laps: 3,
      difficulty: "Intermediate",
      reverse: false,
      entries: [
        {
          rank: 1,
          user_id: "3001",
          display_name: "SoloRecord",
          kart: "tux",
          time_ms: 61042,
          avatar_data_uri: makeFallbackAvatarDataUri("SoloRecord", "3001"),
        },
      ],
    },
  },
];

for (const c of CASES) {
  const t0 = Date.now();
  const png = await compositor.render(c.payload);
  const outPath = path.join(OUT_DIR, c.file);
  fs.writeFileSync(outPath, png);
  console.log(`Wrote ${outPath} (${(png.length / 1024).toFixed(1)} KB, ${Date.now() - t0} ms)`);
}
