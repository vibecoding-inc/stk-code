import fs from "node:fs";
import path from "node:path";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import { fetchAvatarDataUri } from "./avatars.mjs";

const RANK_THEMES = {
  1: {
    label: "1ST",
    ring: "#F7C948",
    badgeBg: "#F5B800",
    badgeText: "#161B28",
    timeColor: "#FFE27A",
  },
  2: {
    label: "2ND",
    ring: "#D6DEE8",
    badgeBg: "#CBD5E1",
    badgeText: "#161B28",
    timeColor: "#E2E8F0",
  },
  3: {
    label: "3RD",
    ring: "#E09152",
    badgeBg: "#D27D3A",
    badgeText: "#161B28",
    timeColor: "#F6BE8F",
  },
};

export function formatTimeMs(ms) {
  const n = Math.max(0, Math.round(Number(ms) || 0));
  const minutes = Math.floor(n / 60000);
  const seconds = Math.floor((n % 60000) / 1000);
  const millis = n % 1000;
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

export function formatKartLabel(kartId) {
  return String(kartId || "")
    .trim()
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function truncateText(text, maxChars) {
  const str = String(text || "").trim();
  const chars = Array.from(str);
  if (chars.length <= maxChars) return str;
  return chars.slice(0, Math.max(1, maxChars - 1)).join("") + "…";
}

function h(type, props, ...children) {
  const flat = children.flat().filter((c) => c !== null && c !== undefined && c !== false);
  return {
    type,
    props: {
      ...(props || {}),
      children: flat.length === 0 ? undefined : flat.length === 1 ? flat[0] : flat,
    },
  };
}

export function loadFonts(fontDirs) {
  const candidates = [
    { file: "SigmarOne.otf", name: "STKDisplay", weight: 700, style: "normal" },
    { file: "DejaVuSans-Bold.ttf", name: "STKSans", weight: 700, style: "normal" },
    { file: "Cantarell-Regular.otf", name: "STKSans", weight: 400, style: "normal" },
    { file: "DejaVuSans.ttf", name: "STKSans", weight: 400, style: "normal" },
    { file: "wqy-microhei.ttf", name: "STKCJK", weight: 400, style: "normal" },
    { file: "wqy-microhei.ttf", name: "STKCJK", weight: 700, style: "normal" },
  ];

  const loaded = [];
  const seen = new Set();
  const dataCache = new Map();
  for (const cand of candidates) {
    const key = `${cand.name}:${cand.weight}`;
    if (seen.has(key)) continue;
    for (const dir of fontDirs) {
      if (!dir) continue;
      const full = path.join(dir, cand.file);
      if (fs.existsSync(full)) {
        if (!dataCache.has(full)) {
          dataCache.set(full, fs.readFileSync(full));
        }
        loaded.push({
          name: cand.name,
          data: dataCache.get(full),
          weight: cand.weight,
          style: cand.style,
        });
        seen.add(key);
        break;
      }
    }
  }

  // Ensure STKSans has at least a 700 weight entry (reuse regular if bold wasn't found)
  const hasSansBold = loaded.some((f) => f.name === "STKSans" && f.weight === 700);
  const sansRegular = loaded.find((f) => f.name === "STKSans" && f.weight === 400);
  if (!hasSansBold && sansRegular) {
    loaded.push({ ...sansRegular, weight: 700 });
  }
  const hasDisplay = loaded.some((f) => f.name === "STKDisplay");
  if (!hasDisplay && loaded.length > 0) {
    loaded.push({ ...loaded[0], name: "STKDisplay", weight: 700 });
  }
  return loaded;
}

function findTrackImage(tracksDir, trackId) {
  if (!tracksDir || !trackId) return null;
  const safe = String(trackId).replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safe) return null;
  for (const ext of [".jpg", ".jpeg", ".png", ".webp"]) {
    const p = path.join(tracksDir, `${safe}${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function buildBackgroundLayer(width, height, trackImagePath) {
  // Subtle dark gradient vignette SVG so the 3D podium and title always pop cleanly
  const vignetteSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <defs>
        <linearGradient id="bgGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#0b1224" stop-opacity="${trackImagePath ? "0.52" : "1"}"/>
          <stop offset="55%" stop-color="#111b33" stop-opacity="${trackImagePath ? "0.34" : "1"}"/>
          <stop offset="100%" stop-color="#070b16" stop-opacity="${trackImagePath ? "0.78" : "1"}"/>
        </linearGradient>
        <radialGradient id="spot" cx="50%" cy="35%" r="58%">
          <stop offset="0%" stop-color="#3b82f6" stop-opacity="${trackImagePath ? "0.14" : "0.24"}"/>
          <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="${width}" height="${height}" fill="url(#bgGrad)"/>
      <rect width="${width}" height="${height}" fill="url(#spot)"/>
    </svg>`
  );

  if (trackImagePath) {
    return sharp(trackImagePath)
      .resize(width, height, { fit: "cover", position: "centre" })
      .blur(8)
      .modulate({ brightness: 0.72, saturation: 1.12 })
      .composite([{ input: vignetteSvg, top: 0, left: 0 }])
      .png()
      .toBuffer();
  }

  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 11, g: 18, b: 36, alpha: 1 },
    },
  })
    .composite([{ input: vignetteSvg, top: 0, left: 0 }])
    .png()
    .toBuffer();
}

const FALLBACK_AVATAR_COLORS = [
  "#5865F2",
  "#EB459E",
  "#3BA55D",
  "#FAA61A",
  "#00A8FC",
  "#9B59B6",
];

function buildAvatarCircle(entry, avatarSize, borderPx, ringColor) {
  const uri = entry.avatar_data_uri;
  // Real raster Discord avatars render via <img>; SVG/missing avatars render natively in Satori
  // so the monogram uses our bundled fonts cleanly.
  if (uri && !uri.startsWith("data:image/svg+xml")) {
    return h("img", {
      src: uri,
      width: avatarSize,
      height: avatarSize,
      style: {
        width: `${avatarSize}px`,
        height: `${avatarSize}px`,
        borderRadius: "9999px",
        border: `${borderPx}px solid ${ringColor}`,
        objectFit: "cover",
      },
    });
  }

  const clean = String(entry.display_name || "P").trim();
  const initial = (Array.from(clean)[0] || "P").toUpperCase();
  const seed = String(entry.user_id || clean);
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  const bg = FALLBACK_AVATAR_COLORS[hash % FALLBACK_AVATAR_COLORS.length];

  return h(
    "div",
    {
      style: {
        width: `${avatarSize}px`,
        height: `${avatarSize}px`,
        borderRadius: "9999px",
        border: `${borderPx}px solid ${ringColor}`,
        background: bg,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "STKSans, STKCJK",
        fontWeight: 700,
        fontSize: `${Math.round(avatarSize * 0.44)}px`,
        color: "#FFFFFF",
      },
    },
    initial
  );
}

function buildPlaqueElement(rank, slot, entry) {
  const { x, y, width, height } = slot.plaque;
  const theme = RANK_THEMES[rank];

  if (!entry) {
    return h(
      "div",
      {
        style: {
          position: "absolute",
          left: `${x}px`,
          top: `${y}px`,
          width: `${width}px`,
          height: `${height}px`,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "6px",
        },
      },
      h(
        "div",
        {
          style: {
            fontFamily: "STKDisplay",
            fontSize: rank === 1 ? "42px" : "32px",
            color: "rgba(255, 255, 255, 0.14)",
            letterSpacing: "2px",
          },
        },
        theme.label
      ),
      h(
        "div",
        {
          style: {
            fontFamily: "STKSans",
            fontSize: "15px",
            fontWeight: 700,
            color: "rgba(255, 255, 255, 0.28)",
          },
        },
        "OPEN SPOT"
      )
    );
  }

  const displayName = truncateText(entry.display_name || "Player", rank === 1 ? 18 : 16);
  const timeText = formatTimeMs(entry.time_ms);
  const kartText = formatKartLabel(entry.kart);

  // Compact horizontal layout for 3rd place (height ~138px) so nothing ever clips.
  if (rank === 3 || height < 155) {
    const avatarSize = 62;
    return h(
      "div",
      {
        style: {
          position: "absolute",
          left: `${x}px`,
          top: `${y}px`,
          width: `${width}px`,
          height: `${height}px`,
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          padding: "8px 12px",
          gap: "12px",
        },
      },
      h(
        "div",
        {
          style: {
            position: "relative",
            display: "flex",
            width: `${avatarSize}px`,
            height: `${avatarSize}px`,
            flexShrink: 0,
          },
        },
        buildAvatarCircle(entry, avatarSize, 3, theme.ring),
        h(
          "div",
          {
            style: {
              position: "absolute",
              right: "-6px",
              bottom: "-4px",
              background: theme.badgeBg,
              color: theme.badgeText,
              fontFamily: "STKSans",
              fontWeight: 700,
              fontSize: "12px",
              padding: "2px 6px",
              borderRadius: "9999px",
              display: "flex",
            },
          },
          "#3"
        )
      ),
      h(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-start",
            justifyContent: "center",
            flexGrow: 1,
            minWidth: 0,
            gap: "3px",
          },
        },
        h(
          "div",
          {
            style: {
              fontFamily: "STKSans, STKCJK",
              fontWeight: 700,
              fontSize: "20px",
              color: "#FFFFFF",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              maxWidth: `${width - avatarSize - 38}px`,
            },
          },
          displayName
        ),
        h(
          "div",
          {
            style: {
              fontFamily: "STKSans",
              fontWeight: 700,
              fontSize: "21px",
              color: theme.timeColor,
            },
          },
          timeText
        ),
        kartText
          ? h(
              "div",
              {
                style: {
                  fontFamily: "STKSans",
                  fontWeight: 400,
                  fontSize: "13px",
                  color: "rgba(226, 232, 240, 0.72)",
                },
              },
              kartText
            )
          : null
      )
    );
  }

  // Vertical hero layout for 1st (tall) and 2nd (medium) pedestals.
  const isFirst = rank === 1;
  const avatarSize = isFirst ? 92 : 70;
  const nameSize = isFirst ? 25 : 21;
  const timeSize = isFirst ? 26 : 21;

  return h(
    "div",
    {
      style: {
        position: "absolute",
        left: `${x}px`,
        top: `${y}px`,
        width: `${width}px`,
        height: `${height}px`,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: isFirst ? "10px 14px" : "6px 12px",
        gap: isFirst ? "8px" : "5px",
      },
    },
    h(
      "div",
      {
        style: {
          position: "relative",
          display: "flex",
          width: `${avatarSize}px`,
          height: `${avatarSize}px`,
        },
      },
      buildAvatarCircle(entry, avatarSize, isFirst ? 4 : 3, theme.ring),
      h(
        "div",
        {
          style: {
            position: "absolute",
            right: "-6px",
            bottom: "-4px",
            background: theme.badgeBg,
            color: theme.badgeText,
            fontFamily: "STKSans",
            fontWeight: 700,
            fontSize: isFirst ? "14px" : "12px",
            padding: isFirst ? "2px 8px" : "2px 6px",
            borderRadius: "9999px",
            display: "flex",
          },
        },
        `#${rank}`
      )
    ),
    h(
      "div",
      {
        style: {
          fontFamily: "STKSans, STKCJK",
          fontWeight: 700,
          fontSize: `${nameSize}px`,
          color: "#FFFFFF",
          textAlign: "center",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          maxWidth: `${width - 24}px`,
        },
      },
      displayName
    ),
    h(
      "div",
      {
        style: {
          fontFamily: "STKSans",
          fontWeight: 700,
          fontSize: `${timeSize}px`,
          color: theme.timeColor,
        },
      },
      timeText
    ),
    isFirst && kartText
      ? h(
          "div",
          {
            style: {
              fontFamily: "STKSans",
              fontWeight: 400,
              fontSize: "14px",
              color: "rgba(226, 232, 240, 0.74)",
            },
          },
          kartText
        )
      : null
  );
}

function buildOverlayTree({ width, height, trackName, subtitle, layout, entriesByRank }) {
  return h(
    "div",
    {
      style: {
        position: "relative",
        width: `${width}px`,
        height: `${height}px`,
        display: "flex",
      },
    },
    // Top header badge
    h(
      "div",
      {
        style: {
          position: "absolute",
          top: "20px",
          left: "28px",
          display: "flex",
          flexDirection: "column",
          background: "rgba(10, 15, 30, 0.68)",
          border: "1px solid rgba(255, 255, 255, 0.14)",
          borderRadius: "14px",
          padding: "10px 18px",
          gap: "2px",
        },
      },
      h(
        "div",
        {
          style: {
            fontFamily: "STKDisplay",
            fontSize: "24px",
            color: "#FFFFFF",
            letterSpacing: "0.5px",
          },
        },
        truncateText(trackName || "Time Trial", 28)
      ),
      subtitle
        ? h(
            "div",
            {
              style: {
                fontFamily: "STKSans",
                fontWeight: 700,
                fontSize: "13px",
                color: "rgba(203, 213, 225, 0.88)",
                letterSpacing: "0.4px",
              },
            },
            subtitle
          )
        : null
    ),
    // 1st, 2nd, 3rd plaques
    ...[1, 2, 3].map((rank) => {
      const slot = layout.slots[String(rank)];
      if (!slot) return null;
      return buildPlaqueElement(rank, slot, entriesByRank[rank] || null);
    })
  );
}

export class PodiumCompositor {
  constructor({ assetsDir, tracksDir, fontDirs, fetchImpl = fetch }) {
    this.assetsDir = assetsDir;
    this.tracksDir = tracksDir;
    this.fetchImpl = fetchImpl;

    const layoutPath = path.join(assetsDir, "layout.json");
    if (!fs.existsSync(layoutPath)) {
      throw new Error(`Missing layout.json in ${assetsDir}`);
    }
    this.layout = JSON.parse(fs.readFileSync(layoutPath, "utf-8"));
    this.podiumPath = path.join(assetsDir, "podium.png");
    if (!fs.existsSync(this.podiumPath)) {
      throw new Error(`Missing podium.png in ${assetsDir}`);
    }
    this.podiumBuffer = fs.readFileSync(this.podiumPath);
    this.fonts = loadFonts(fontDirs);
    if (this.fonts.length === 0) {
      throw new Error(`No fonts found in: ${fontDirs.join(", ")}`);
    }
    this.bgCache = new Map();
  }

  async _getBackground(trackId) {
    const { width, height } = this.layout.canvas;
    const trackPath = findTrackImage(this.tracksDir, trackId);
    const cacheKey = trackPath || "__default__";
    if (this.bgCache.has(cacheKey)) {
      return this.bgCache.get(cacheKey);
    }
    const buf = await buildBackgroundLayer(width, height, trackPath);
    if (this.bgCache.size > 40) {
      const firstKey = this.bgCache.keys().next().value;
      this.bgCache.delete(firstKey);
    }
    this.bgCache.set(cacheKey, buf);
    return buf;
  }

  _resolveKartSprite(kartId, rank) {
    const safe = String(kartId || "").replace(/[^a-zA-Z0-9_-]/g, "");
    if (!safe) return null;
    const exact = path.join(this.assetsDir, "karts", `${safe}_${rank}.png`);
    if (fs.existsSync(exact)) return exact;
    // Fallback to tux if an unknown/addon kart was used
    const fallback = path.join(this.assetsDir, "karts", `tux_${rank}.png`);
    if (fs.existsSync(fallback)) return fallback;
    return null;
  }

  async _cropSpriteToCanvas(spritePath, left, top, canvasW, canvasH) {
    const meta = await sharp(spritePath).metadata();
    const sw = meta.width || 0;
    const sh = meta.height || 0;
    if (sw <= 0 || sh <= 0) return null;

    const cropLeft = Math.max(0, -left);
    const cropTop = Math.max(0, -top);
    const destLeft = Math.max(0, left);
    const destTop = Math.max(0, top);
    const visibleW = Math.min(sw - cropLeft, canvasW - destLeft);
    const visibleH = Math.min(sh - cropTop, canvasH - destTop);
    if (visibleW <= 0 || visibleH <= 0) return null;

    let input = spritePath;
    if (cropLeft > 0 || cropTop > 0 || visibleW < sw || visibleH < sh) {
      input = await sharp(spritePath)
        .extract({ left: cropLeft, top: cropTop, width: visibleW, height: visibleH })
        .png()
        .toBuffer();
    }
    return { input, left: destLeft, top: destTop };
  }

  async render({ track, track_name, difficulty, laps, reverse, entries = [] }) {
    const { width, height } = this.layout.canvas;

    // Normalize entries by rank 1..3
    const entriesByRank = {};
    const top3 = entries.slice(0, 3);
    const resolvedAvatars = await Promise.all(
      top3.map((e) =>
        e.avatar_data_uri
          ? Promise.resolve(e.avatar_data_uri)
          : fetchAvatarDataUri(e, { fetchImpl: this.fetchImpl })
      )
    );
    top3.forEach((e, idx) => {
      const rank = e.rank >= 1 && e.rank <= 3 ? e.rank : idx + 1;
      entriesByRank[rank] = { ...e, rank, avatar_data_uri: resolvedAvatars[idx] };
    });

    const bgBuffer = await this._getBackground(track);
    const compositeLayers = [{ input: this.podiumBuffer, left: 0, top: 0 }];

    // Draw karts in back-to-front order (2nd & 3rd first, then 1st on top)
    for (const rank of [2, 3, 1]) {
      const entry = entriesByRank[rank];
      if (!entry) continue;
      const slot = this.layout.slots[String(rank)];
      if (!slot) continue;
      const spritePath = this._resolveKartSprite(entry.kart, rank);
      if (!spritePath) continue;

      const sw = slot.kart_sprite_size.width;
      const sh = slot.kart_sprite_size.height;
      const groundY =
        typeof slot.kart_ground_y === "number" ? slot.kart_ground_y : Math.round(sh * 0.78);
      const left = Math.round(slot.kart_anchor.x - sw / 2);
      const top = Math.round(slot.kart_anchor.y - groundY);

      const layer = await this._cropSpriteToCanvas(spritePath, left, top, width, height);
      if (layer) compositeLayers.push(layer);
    }

    const subtitleParts = [];
    if (laps) subtitleParts.push(`${laps} ${Number(laps) === 1 ? "Lap" : "Laps"}`);
    if (difficulty) subtitleParts.push(String(difficulty));
    if (reverse) subtitleParts.push("Reverse");
    const subtitle = subtitleParts.join("  •  ");

    const tree = buildOverlayTree({
      width,
      height,
      trackName: track_name || formatKartLabel(track) || "Time Trial",
      subtitle,
      layout: this.layout,
      entriesByRank,
    });

    const svg = await satori(tree, {
      width,
      height,
      fonts: this.fonts,
    });

    const resvg = new Resvg(svg, {
      fitTo: { mode: "width", value: width },
    });
    const overlayPng = resvg.render().asPng();
    compositeLayers.push({ input: overlayPng, left: 0, top: 0 });

    return sharp(bgBuffer)
      .composite(compositeLayers)
      .png({ compressionLevel: 8 })
      .toBuffer();
  }
}
