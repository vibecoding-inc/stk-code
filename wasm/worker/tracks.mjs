// Standard SuperTuxKart race tracks (excluding arenas, soccer fields, and cutscenes)
// used for Discord /timetrial slash command autocomplete and validation.

export const STANDARD_TRACKS = [
  {id: "abyss", name: "Abyss"},
  {id: "black_forest", name: "Black Forest"},
  {id: "candela_city", name: "Candela City"},
  {id: "cocoa_temple", name: "Cocoa Temple"},
  {id: "cornfield_crossing", name: "Cornfield Crossing"},
  {id: "fortmagma", name: "Fort Magma"},
  {id: "gran_paradiso_island", name: "Gran Paradiso Island"},
  {id: "green_valley", name: "Green Valley"},
  {id: "hacienda", name: "Hacienda"},
  {id: "lighthouse", name: "Around the Lighthouse"},
  {id: "mines", name: "Old Mine"},
  {id: "minigolf", name: "Minigolf"},
  {id: "olivermath", name: "Oliver's Math Class"},
  {id: "ravenbridge_mansion", name: "Ravenbridge Mansion"},
  {id: "sandtrack", name: "Shifting Sands"},
  {id: "scotland", name: "Northern Resort"},
  {id: "snowmountain", name: "Northern Peak"},
  {id: "snowtuxpeak", name: "Snowtux Peak"},
  {id: "stk_enterprise", name: "STK Enterprise"},
  {id: "volcano_island", name: "Volcano Island"},
  {id: "xr591", name: "XR591"},
  {id: "zengarden", name: "Zen Garden"},
];

export const TRACK_BY_ID = new Map(STANDARD_TRACKS.map((t) => [t.id, t]));

export const DIFFICULTY_NAMES = [
  "Novice",
  "Intermediate",
  "Expert",
  "SuperTux",
];

export const KART_NAMES = {
  adiumy: "Adiumy",
  amanda: "Amanda",
  beastie: "Beastie",
  emule: "eMule",
  gavroche: "Gavroche",
  gnu: "Gnu",
  hexley: "Hexley",
  kiki: "Kiki",
  konqi: "Konqi",
  nolok: "Nolok",
  pepper: "Pepper",
  pidgin: "Pidgin",
  puffy: "Puffy",
  sara_the_racer: "Sara the Racer",
  sara_the_wizard: "Sara the Wizard",
  suzanne: "Suzanne",
  tux: "Tux",
  wilber: "Wilber",
  xue: "Xue",
};

export function format_kart_name(kart_id) {
  let raw = String(kart_id || "").trim();
  if (!raw) return "Unknown Kart";
  let lower = raw.toLowerCase();
  if (KART_NAMES[lower]) return KART_NAMES[lower];
  return raw
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export const DEFAULT_LAPS = 1;
export const MIN_LAPS = 1;
export const MAX_LAPS = 20;
export const DEFAULT_DIFFICULTY = 2; // Expert

export function get_track(track_id) {
  if (typeof track_id !== "string") return null;
  return TRACK_BY_ID.get(track_id.trim().toLowerCase()) || null;
}

export function get_difficulty_name(difficulty) {
  return DIFFICULTY_NAMES[difficulty] || "Expert";
}

/**
 * Filters tracks for Discord autocomplete (returns up to 25 choices).
 */
export function autocomplete_tracks(query = "") {
  let q = String(query || "").trim().toLowerCase();
  let matches = STANDARD_TRACKS.filter((t) => {
    if (!q) return true;
    return t.id.toLowerCase().includes(q) || t.name.toLowerCase().includes(q);
  });
  matches.sort((a, b) => {
    if (!q) return a.name.localeCompare(b.name);
    let a_starts = a.name.toLowerCase().startsWith(q) || a.id.toLowerCase().startsWith(q);
    let b_starts = b.name.toLowerCase().startsWith(q) || b.id.toLowerCase().startsWith(q);
    if (a_starts !== b_starts) return a_starts ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return matches.slice(0, 25).map((t) => ({name: t.name, value: t.id}));
}

/**
 * Formats milliseconds as M:SS.mmm (e.g. 84231 -> "1:24.231").
 */
export function format_time_ms(time_ms) {
  let ms = Math.max(0, Math.round(Number(time_ms) || 0));
  let minutes = Math.floor(ms / 60000);
  let seconds = Math.floor((ms % 60000) / 1000);
  let millis = ms % 1000;
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}
