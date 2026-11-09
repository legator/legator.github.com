"use strict";
// Original code and art, written from scratch.

// ---------- save data ----------
// Everything the game keeps lives in one versioned object under "mtd-save". Older builds used one key per
// setting (mtd-sound, mtd-civ, ...); those are moved in once and then removed. Bump SAVE_VERSION and add a
// step to MIGRATE when the shape of a stored value changes.
const SAVE_KEY = "mtd-save", SAVE_VERSION = 2;
const MIGRATE = {
  // 1 -> 2: the per-stat upgrade build. Saved layouts written before it only store a total level; applyLayout reads both.
  1: d => d
};
const Store = (() => {
  let data = {}, ok = true;
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) {
      const j = JSON.parse(raw);
      data = j && j.data || {};
      for (let v = (j && j.version) || 1; v < SAVE_VERSION; v++) if (MIGRATE[v]) data = MIGRATE[v](data);
    } else {   // first run of this build: adopt the old one-key-per-setting saves
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith("mtd-") && k !== SAVE_KEY) data[k] = localStorage.getItem(k); }
    }
  } catch (e) { ok = false; }
  const flush = () => {
    if (!ok) return;
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({ version: SAVE_VERSION, data }));
      for (const k of Object.keys(data)) if (localStorage.getItem(k) !== null) localStorage.removeItem(k);   // old keys are now inside the save
    } catch (e) { /* storage full or blocked: the game keeps running with what is in memory */ }
  };
  flush();
  return {
    getItem: k => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); flush(); },
    removeItem: k => { delete data[k]; flush(); },
    exportCode: () => {
      const bytes = new TextEncoder().encode(JSON.stringify(data));
      let bin = "";
      const chunk = 8192;
      for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      return "MTDSAVE" + SAVE_VERSION + ":" + btoa(bin);
    },
    importCode(code) {
      const m = /^MTDSAVE(\d+):(.+)$/.exec(String(code).trim());
      if (!m) return false;
      let d;
      try {
        const bin = atob(m[2]);
        const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
        d = JSON.parse(new TextDecoder().decode(bytes));
      } catch (e) {
        try { d = JSON.parse(decodeURIComponent(escape(atob(m[2])))); } catch (err) { return false; }
      }
      if (!d || typeof d !== "object") return false;
      for (let v = +m[1]; v < SAVE_VERSION; v++) if (MIGRATE[v]) d = MIGRATE[v](d);
      data = d; flush(); return true;
    },
    available: () => ok
  };
})();
const CS = 40, COLS = 13, ROWS = 13;          // square 13 x 13 grid
const TWO_IN_GOLD = 1.5;
let MAX_WAVES = 63,   // 7 blocks of 9 waves: the 7th boss comes on the last wave
    AUTO_WAIT = 25, START_LIVES = 20, START_GOLD = 100;
const MAX_LEVEL = 5;                          // buy (level 1) + 4 upgrades
const UPGRADE_WEIGHT = [1, 1, 1, 2];          // upgrade 1..4: the 4th one is worth double
const UNIT = { dmg: 0.08, rng: 0.25, rel: 0.08 }; // one level = +8% damage, +0.25 range, or 8% faster reload (the 4th level of a stat counts double)
const COMP_COLOR = { dmg: "#ff7a6b", rng: "#62b6ff", rel: "#6ee7a0" };
const COMP_NAME = { dmg: "Damage", rng: "Range", rel: "Reload" };
const MODES = { first: "Leading", closest: "Closest", far: "Furthest", weak: "Lowest HP" };
const MODE_HINT = { first: "the creep closest to the exit", closest: "the creep closest to the tower", far: "the creep furthest from the tower", weak: "the creep with the lowest health" };
const SINGLE_TARGET = ["pellet", "frost", "splash", "sniper", "gatling", "chain", "poison", "plague", "flak", "mortar", "net", "skyhook", "exec", "hex", "beam", "silo"];
const ONLY = { all: "All types", normal: "Normal", fast: "Fast", squad: "Group", flyer: "Air", tough: "Tough", decoy: "Decoy", spawner: "Spawner", splitling: "Splitling", boss: "Bosses" };
const TARGETERS = ["pellet", "frost", "splash", "sniper", "gatling", "chain", "poison", "plague", "flak", "mortar", "net", "aura", "burst", "lance", "tesla", "skyhook", "exec", "hex", "beam", "silo", "gravity", "lure"];   // everything that attacks or affects creeps
const creepGroup = c => (CREEPS[c.type].boss ? "boss" : c.type);
const CLASSIC_BONUS = [0.05, 0.05, 0.05, 0.20]; // Normal mode: power added by upgrade 1..4, plus 0.3 range each
let extended = true;
let rules = "standard";
let levelType = "campaign";   // campaign | endless | bossrush | puzzle1 | puzzle2   // standard | nosell (towers cannot be removed) | fixed (a fixed gold budget for the whole map, no income, no selling)
const FIXED_BASE = { easy: 3000, middle: 3200, hard: 4800, extreme: 12000 };   // gold budget on map 1; other maps scale with creep health and entrances
function fixedBudget(idx, d) {
  const ents = MAPS[idx].flows.length;
  return Math.round(FIXED_BASE[d] * (MAP_HP[idx] / MAP_HP[0]) * (ents > 1 ? 1.6 : 1) / 50) * 50;
}
let gameSpeed = 1;                             // 1, 2 or 3 simulation steps per frame
let spawners = 1;                              // creeps sent per entrance for each creep in a wave
const spawnGold = n => (n + 1) / (2 * n);      // gold per kill: 1, .75, .67, .625 for 1..4 spawners                           // false = Normal mode
let buildOnly = "all";                         // creep type the next tower you place will hit
let buildMode = "first";                       // targeting for the next tower you place
const UPGRADE_TIME  = [3, 5, 8, 12];          // seconds a tower is offline after upgrade 1..4
const CORNER_TIME = 0.5, CORNER_SLOW = 0.4;   // a sharp turn slows ground creeps briefly
const DIRS  = [[1,0],[-1,0],[0,1],[0,-1]];
const DIRS8 = DIRS.concat([[1,1],[1,-1],[-1,1],[-1,-1]]);
// Per level: creep health (mult), tower damage (dmg) and fire rate (rel), starting gold (gold) and gold per kill / wave bonus (reward). Tuned with a strong full-game bot.
const DIFFICULTY = {
  easy:    { name: "Easy",    mult: 1,    gold: 1,    reward: 1,    dmg: 1,    rel: 1 },
  middle:  { name: "Middle",  mult: 1.65, gold: 1.10, reward: 1.10, dmg: 1.05, rel: 1.05 },
  hard:    { name: "Hard",    mult: 2.65, gold: 1.25, reward: 1.50, dmg: 1.06, rel: 1.06 },
  extreme: { name: "Extreme", mult: 3.6,  gold: 1.50, reward: 2.00, dmg: 1.12, rel: 1.12 }
};
let difficulty = "easy";

// ---------- towers ----------
// air / ground: which creep kinds the tower can hit.
const TOWERS = {
  pellet:  { name: "Pellet",  icon: "P", cost: 10, range: 2.5, cd: 0.6, dmg: 8,  color: "#2f855a", air: true,  ground: true,  desc: "Cheap, fast single-target tower. Good early; hits ground and air." },
  frost:   { name: "Frost",   icon: "F", cost: 20, range: 2.2, cd: 1.2, dmg: 4,  color: "#3182ce", air: true,  ground: true,  slow: 0.5, desc: "Small damage plus a 2 s slow on the target. Helps other towers hit longer; hits ground and air." },
  splash:  { name: "Splash",  icon: "B", cost: 30, range: 2.8, cd: 1.5, dmg: 12, color: "#c05621", air: false, ground: true,  radius: 1, desc: "Area damage around its target. Strong against groups of ground creeps; cannot hit flyers." },
  sniper:  { name: "Sniper",  icon: "R", cost: 40, range: 3.0, cd: 2.5, dmg: 70, color: "#285e61", air: true,  ground: true,  desc: "Heavy single hits with a slow reload and a range of 3. Best along long straight routes; hits ground and air." },
  gatling: { name: "Gatling", icon: "G", cost: 25, range: 2.3, cd: 0.15, dmg: 3,  color: "#b7791f", air: true,  ground: true,  desc: "Very fast fire with low damage per shot. Good against fast creeps; hits ground and air." },
  flak:    { name: "Flak",    icon: "A", cost: 25, range: 3.0, cd: 0.8, dmg: 14, color: "#e53e3e", air: true,  ground: false, desc: "Anti-air only. Needed for flying creeps, which ignore the maze; useless against ground creeps." },
  aura:    { name: "Aura",    icon: "U", cost: 35, range: 2.0, cd: 0.5, dmg: 0,  color: "#4fd1c5", air: true,  ground: true,  slow: 0.6, desc: "Slows every creep in range, ground and air, with almost no damage. Pair it with damage towers along the route." },
  burst:   { name: "Burst",   icon: "W", cost: 40, range: 1.6, cd: 2.0, dmg: 18, color: "#dd6b20", air: true,  ground: true,  desc: "Hits every creep in a small ring, ground and air. Strong when creeps bunch up near it." },
  beacon:  { name: "Beacon",  icon: "L", cost: 30, range: 1.8, cd: 0, dmg: 0,  color: "#d53f8c", air: true,  ground: true,  buff: 0.2, desc: "Does not attack. Adds damage to every tower within range. Several beacons stack, up to 60%." },
  lance:   { name: "Lance",   icon: "J", cost: 80, range: 2.5, cd: 1.5, dmg: 30, color: "#9b2c2c", air: true,  ground: true,  desc: "Fires only along its own row and column, up to 2 cells each way, and hits every creep on those lines. Does 66% damage to every creep type. Expensive; put it where the route runs straight past it." },
  plague:  { name: "Plague",  icon: "V", cost: 40, range: 2.6, cd: 1.4, dmg: 4.5, duration: 6, color: "#a3e635", air: true,  ground: true,  desc: "Infects a creep with a disease that drains health every second for 6 s. A creep that is already infected cannot be infected again, so the tower picks a healthy one; once the infection wears off the creep can catch it once more. Strong against creeps that live long, like tough ones." },
  tesla:   { name: "Tesla",   icon: "E", cost: 40, range: 2.6, cd: 1.2, dmg: 9,  color: "#4299e1", air: true,  ground: true,  arcs: 6, desc: "Electric arcs strike up to 6 creeps in range at once. Good against groups and fast creeps; hits ground and air." },
  exec:    { name: "Executioner", icon: "X", cost: 70, range: 2.6, cd: 3.0, dmg: 12, color: "#9b1c1c", air: true, ground: true, desc: "Each hit takes a percentage of the target's CURRENT health, so it shreds bosses and tough creeps and does almost nothing to small ones. Slow reload." },
  hex:     { name: "Hex",     icon: "H", cost: 35, range: 2.6, cd: 1.0, dmg: 0,  color: "#a855f7", air: true,  ground: true,  buff: 0.25, desc: "Does not damage. Marks a creep for 4 s: every tower deals 25% more damage to it. Does not re-mark a creep that is already marked." },
  wall:    { name: "Wall",    icon: "Z", cost: 5,  range: 0,   cd: 0,   dmg: 0,  color: "#64748b", air: true,  ground: true,  desc: "A cheap block with no attack. Use it to shape the maze without spending on real towers. Selling returns the full price; it cannot be upgraded." },
  mine:    { name: "Mine Layer", icon: "Y", cost: 40, range: 2.2, cd: 5.0, dmg: 45, color: "#b45309", air: false, ground: true, radius: 1.1, desc: "Lays mines on the route within its range (3 at a time, more per upgrade). A ground creep that steps on one sets it off for area damage." },
  beam:    { name: "Beam",    icon: "Bm", cost: 70, range: 2.8, cd: 0.1, dmg: 1.2, color: "#f43f5e", air: true, ground: true, desc: "A laser that ramps up: damage grows up to 6x the longer it stays on the same target, and resets when the target dies. Great against bosses, weak against swarms." }
};
const TOWER_KEYS = Object.keys(TOWERS);

// One icon per tower, drawn in a 24x24 box. "f" is filled, "s" is stroked.
// The same shapes are used on the map, in the buttons and in the tower list.
const ICONS = {
  pellet:  { f: "M6 12a6 6 0 1 0 12 0a6 6 0 1 0 -12 0" },
  frost:   { s: "M12 2v20M3.6 7l16.8 10M3.6 17L20.4 7" },
  splash:  { f: "M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0",
             s: "M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" },
  sniper:  { s: "M7 12a5 5 0 1 0 10 0a5 5 0 1 0 -10 0M12 2v5M12 17v5M2 12h5M17 12h5" },
  gatling: { f: "M3 8h12v2.5H3zM3 13h12v2.5H3zM15 6h6v10h-6z" },
  chain:   { f: "M13 2L5 14h6l-1 8 8-12h-6z" },
  poison:  { f: "M12 3C12 3 6 10 6 14.5a6 6 0 0 0 12 0C18 10 12 3 12 3z" },
  plague:  { f: "M12 7.5a4.5 4.5 0 1 0 0 9a4.5 4.5 0 1 0 0-9zM12 1.2a1.6 1.6 0 1 0 0 3.2a1.6 1.6 0 1 0 0-3.2zM12 19.6a1.6 1.6 0 1 0 0 3.2a1.6 1.6 0 1 0 0-3.2zM1.2 12a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0zM19.6 12a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0z", s: "M12 4.4V7.5M12 16.5v3.1M4.4 12h3.1M16.5 12h3.1" },
  flak:    { f: "M12 2l5.5 10h-11z M4 16h16v2.5H4z" },
  mortar:  { f: "M5 13l8-8 3 3-8 8z M3 17h13v4H3z" },
  net:     { s: "M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18" },
  aura:    { s: "M12 9a3 3 0 1 0 0.01 0M12 5a7 7 0 1 0 0.01 0M12 1a11 11 0 1 0 0.01 0" },
  burst:   { f: "M12 2l2.5 6.5L21 9l-5 4.5L17.5 21 12 17.5 6.5 21 8 13.5 3 9l6.5-.5z" },
  beacon:  { f: "M10 2h4v3h-4z M7.5 5h9l-1.2 4h-6.6z M10 9h4v11h-4z" },
  dynamo:  { f: "M9.5 12a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0",
             s: "M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8" },
  tesla:   { s: "M2 12l3-4 3 8 3-8 3 8 3-8 3 4 2-0" },
  lance:   { f: "M10.5 2h3v8.5H22v3h-8.5V22h-3v-8.5H2v-3h8.5z" },
  exec:    { s: "M4 4l16 16M20 4L4 20M12 8a4 4 0 1 0 0.01 0" },
  hex:     { s: "M12 2l8.7 5v10L12 22l-8.7-5V7zM12 8l3.5 2v4L12 16l-3.5-2v-4z" },
  wall:    { f: "M3 5h18v4H3zM3 10h8v4H3zM12 10h9v4h-9zM3 15h18v4H3z" },
  skyhook: { s: "M12 21V7M7 12l5-5 5 5M6 3h12" },
  mine:    { f: "M6 14a6 6 0 1 0 12 0a6 6 0 1 0 -12 0", s: "M12 3v3M4 9l2.5 1.5M20 9l-2.5 1.5" },
  gravity: { s: "M12 3v16M6 14l6 6 6-6M5 3h14" },
  beam:    { f: "M2 11h20v2H2z", s: "M5 7l-3 5 3 5M19 7l3 5-3 5" },
  bank:    { s: "M12 3a9 9 0 1 0 0.01 0M12 7v10M9.5 9.5h4a1.8 1.8 0 0 1 0 3.5h-3a1.8 1.8 0 0 0 0 3.5h4" },
  silo:    { f: "M9 2h6l1 12H8zM5 16h14v6H5z" },
  lure:    { s: "M3 12c4-7 14-7 18 0c-4 7-14 7-18 0M12 9.5a2.5 2.5 0 1 0 0.01 0" }
};
const ICON_PATHS = {};
for (const k of Object.keys(ICONS)) {
  ICON_PATHS[k] = { f: ICONS[k].f ? new Path2D(ICONS[k].f) : null, s: ICONS[k].s ? new Path2D(ICONS[k].s) : null };
}

// Every tower has its own silhouette: n = corners (0 = circle), rot = degrees, inner = star depth (1 = plain polygon).
const SHAPES = {
  pellet: { n: 0 }, frost: { n: 6 }, splash: { n: 8 }, sniper: { n: 4, rot: 45 }, gatling: { n: 4 },
  chain: { n: 3 }, poison: { n: 5 }, plague: { n: 5, rot: 36 }, flak: { n: 3, rot: 180 }, mortar: { n: 7 }, net: { n: 4, rot: 45, inner: 0.75 },
  aura: { n: 10, inner: 0.88 }, burst: { n: 8, inner: 0.5 }, beacon: { n: 5, inner: 0.5 }, dynamo: { n: 8, inner: 0.75 },
  lance: { n: 4, inner: 0.55 }, tesla: { n: 6, inner: 0.5 },
  exec: { n: 5, inner: 0.45, rot: 18 }, hex: { n: 6, inner: 0.7, rot: 30 }, wall: { n: 4, rot: 45, inner: 1 }, skyhook: { n: 3, inner: 0.6 }, mine: { n: 6, inner: 0.5, rot: 15 },
  gravity: { n: 12, inner: 0.8 }, beam: { n: 4, inner: 0.4 }, bank: { n: 8, inner: 0.9, rot: 22 }, silo: { n: 6 }, lure: { n: 9, inner: 0.7 }
};
function shapePts(k, r) {   // points around (0,0) for radius r
  const sh = SHAPES[k] || { n: 0 }, pts = [];
  if (!sh.n) { for (let i = 0; i < 24; i++) { const a = i / 24 * Math.PI * 2; pts.push([Math.cos(a) * r, Math.sin(a) * r]); } return pts; }
  const inner = sh.inner || 1, m = inner < 1 ? sh.n * 2 : sh.n, off = -Math.PI / 2 + (sh.rot || 0) * Math.PI / 180;
  const rad = sh.n === 3 ? r * 1.12 : sh.n === 4 && !sh.inner ? r * 1.1 : r;   // triangles and squares look small otherwise
  for (let i = 0; i < m; i++) {
    const a = off + i / m * Math.PI * 2, rr = inner < 1 && i % 2 ? rad * inner : rad;
    pts.push([Math.cos(a) * rr, Math.sin(a) * rr]);
  }
  return pts;
}
function shapePath(k, cx, cy, r) {
  ctx.beginPath();
  shapePts(k, r).forEach(([x, y], i) => (i ? ctx.lineTo(cx + x, cy + y) : ctx.moveTo(cx + x, cy + y)));
  ctx.closePath();
}
function shapeSvg(k, size, color) {   // the same silhouette for the tower buttons
  const pts = shapePts(k, 10.5).map(([x, y]) => (12 + x).toFixed(1) + "," + (12 + y).toFixed(1)).join(" ");
  return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" style="position:absolute;inset:0">' +
    '<polygon points="' + pts + '" fill="' + color + '" stroke="#e6f1fa" stroke-width="1.4" stroke-linejoin="round"/></svg>';
}
function iconSvg(k, size) {
  const i = ICONS[k];
  return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" style="vertical-align:-3px">' +
    (i.f ? '<path d="' + i.f + '" fill="currentColor"/>' : '') +
    (i.s ? '<path d="' + i.s + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' : '') +
    '</svg>';
}
function drawIcon(k, cx, cy, size) {
  const p = ICON_PATHS[k], sc = size / 24;
  ctx.save();
  ctx.translate(cx - size / 2, cy - size / 2);
  ctx.scale(sc, sc);
  ctx.fillStyle = "#fff"; ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.lineCap = "round";
  if (p.f) ctx.fill(p.f);
  if (p.s) ctx.stroke(p.s);
  ctx.restore();
}

// Damage each tower does to each creep type (1 = full damage). Every tower has its own profile.
// Columns: normal, fast, tough, flyer (air), squad, spawner, splitling, decoy, boss.
const DEFAULT_VS = 0.5;   // fallback for a creep type missing from a row
const VS_TYPES = ["normal", "fast", "tough", "flyer", "squad", "spawner", "splitling", "decoy", "boss"];
const VS_ROWS = {
  pellet:  [1.00, 0.66, 0.25, 0.50, 0.75, 0.66, 0.75, 0.66, 0.25],
  frost:   [0.75, 1.00, 0.50, 0.66, 0.66, 0.50, 0.75, 0.75, 0.33],
  splash:  [0.75, 0.33, 0.50, 0.25, 1.00, 0.75, 1.00, 0.50, 0.33],
  sniper:  [0.33, 0.25, 1.00, 0.66, 0.25, 0.50, 0.25, 0.50, 1.00],
  gatling: [0.66, 1.00, 0.33, 0.75, 0.50, 0.50, 0.66, 0.75, 0.40],
  plague:  [0.75, 0.50, 1.00, 0.66, 0.50, 0.75, 0.33, 0.66, 0.50],
  flak:    [0.25, 0.25, 0.25, 1.00, 0.25, 0.25, 0.25, 0.25, 0.50],
  burst:   [0.50, 0.25, 0.33, 0.66, 0.75, 1.00, 1.00, 0.33, 0.25],
  tesla:   [0.66, 1.00, 0.25, 0.66, 0.75, 0.50, 1.00, 0.75, 0.50],
  lance:   [0.66, 0.66, 0.66, 0.66, 0.66, 0.66, 0.66, 0.66, 0.66],
  exec:    [0.25, 0.25, 0.50, 0.25, 0.15, 0.40, 0.15, 0.40, 1.00],
  mine:    [0.75, 0.50, 0.66, 0.25, 1.00, 0.75, 1.00, 0.33, 0.50],
  beam:    [0.50, 0.66, 0.75, 0.75, 0.33, 0.50, 0.33, 0.66, 1.00]
};
const VS = {
  aura:   { fast: 1 },
  beacon: {},
  hex: { boss: 1 }, wall: {}
};
for (const [tower, row] of Object.entries(VS_ROWS)) {
  VS[tower] = {};
  VS_TYPES.forEach((type, i) => { VS[tower][type] = row[i]; });
}
function effOf(towerType, creepType) {
  const row = VS[towerType] || {};
  const d = CREEPS[creepType];
  if (d && d.base) {   // a boss takes the average of its type's damage and the generic boss damage
    const a = row[d.base] !== undefined ? row[d.base] : DEFAULT_VS;
    const b = row.boss !== undefined ? row.boss : DEFAULT_VS;
    return Math.round((a + b) / 2 * 100) / 100;
  }
  return row[creepType] !== undefined ? row[creepType] : DEFAULT_VS;
}
function eff(t, c) { return effOf(t.type, c.type); }
function bestOf(towerType) {
  return Object.keys(VS[towerType] || {}).filter(k => VS[towerType][k] >= 1).map(k => (k === "boss" ? "bosses" : CREEP_INFO[k].name)).join(", ");
}

// Stats from the tower's upgrades. Each upgrade goes into damage (power for support towers), range or reload.
const newMod = () => ({ dmg: 0, rng: 0, rel: 0 });
// Extended mode: damage, range and reload each have their own 4 upgrade levels and their own price ladder.
const STAT_KEYS = ["dmg", "rng", "rel"], MAX_STAT = 4;
const newLv = () => ({ dmg: 0, rng: 0, rel: 0 });
const lvOf = t => t.lv || (t.lv = newLv());
const statsOf = t => STAT_KEYS.filter(c => canUpgrade(t, c));
const statMaxed = (t, c) => lvOf(t)[c] >= MAX_STAT;
const fullyMaxed = t => (extended ? statsOf(t).every(c => statMaxed(t, c)) : (t.level || 0) >= MAX_LEVEL);
const minesCap = t => 2 + Math.min(t.level, MAX_LEVEL);
function towerStats(t, mod) {
  const def = TOWERS[t.type], m = mod || t.mod || newMod(), bonus = m.dmg, lv = DIFFICULTY[difficulty] || DIFFICULTY.easy, cb = CB();
  return {
    bonus,
    dmg: def.dmg * (1 + bonus) * lv.dmg * (1 + cb.dmg),   // each level scales tower damage and reload speed as well as creep health
    range: def.range + m.rng + (def.range > 0 ? cb.range : 0),
    cd: def.cd / ((1 + m.rel) * lv.rel * (1 + cb.rel)),
    slow: def.slow ? Math.max(0.1, def.slow * (1 - bonus)) : 1,
    stun: 1.0 * (1 + bonus),
    radius: def.radius ? def.radius + m.rng : 0,
    chain: def.chain || 0,
    arcs: def.arcs || 0,
    speed: def.speed ? def.speed * (1 + bonus) : 0,
    buff: def.buff ? def.buff * (1 + bonus) : 0,
    pull: def.pull ? def.pull * (1 + bonus) : 0
  };
}
const canUpgrade = (t, comp) => comp !== "rel" || TOWERS[t.type].cd > 0;   // beacons and dynamos have no reload
function modAfter(t, comp) {   // the tower's upgrade totals if the next upgrade went into comp
  const m = Object.assign({}, t.mod), w = UPGRADE_WEIGHT[lvOf(t)[comp]] || 0;
  m[comp] += UNIT[comp] * w;
  return m;
}
// Upgrades 1-3 cost 1x, 2x and 4x the tower price. Upgrade 4 costs 16x, but never more than 160 + 4x the price,
// so expensive towers stay reachable (a 10g Pellet: 10, 20, 40, 160; an 80g Lance: 80, 160, 320, 480).
const UPGRADE_MULT = [1, 2, 4];
function upgradePlan(type) {
  const price = TOWERS[type].cost;
  return UPGRADE_MULT.map(m => price * m).concat(Math.min(16 * price, 160 + 4 * price));
}
// Extended: one shared price for all three stats. It follows the most-upgraded stat on the tower (10, 20, 40, 160 for a Pellet),
// so upgrading damage to level 2 makes the next range or reload upgrade cost the same as the next damage upgrade.
const sharedStep = t => Math.min(MAX_STAT - 1, Math.max(0, ...STAT_KEYS.map(c => lvOf(t)[c])));
function upgradeCost(t, comp) { return upgradePlan(t.type)[extended ? sharedStep(t) : t.level - 1]; }

// ---------- creeps ----------
const CREEPS = {
  normal:    { hp: 30,  speed: 2.0, reward: 1,  color: "#e53e3e", r: 0.30 },
  fast:      { hp: 18,  speed: 4.5, reward: 1,  color: "#d69e2e", r: 0.25 },
  tough:     { hp: 42,  speed: 1.3, reward: 3,  color: "#6b46c1", r: 0.36 },
  flyer:     { hp: 16,  speed: 1.8, reward: 2,  color: "#63b3ed", r: 0.27, flying: true },
  squad:     { hp: 15,  speed: 2.0, reward: 1,  color: "#f6ad55", r: 0.24 },
  spawner:   { hp: 40,  speed: 1.8, reward: 2,  color: "#38b2ac", r: 0.34 },
  splitling: { hp: 9,   speed: 2.2, reward: 1,  color: "#81e6d9", r: 0.22, diag: true },
  decoy:     { hp: 30,  speed: 2.0, reward: 2,  color: "#b83280", r: 0.28, diag: true },
  // Bosses: each one is a tougher version of a creep type and keeps that type's behaviour.
  bossNormal:  { hp: 300, speed: 1.5, reward: 30, color: "#c53030", r: 0.46, boss: true, base: "normal" },
  bossFast:    { hp: 160, speed: 4.2, reward: 30, color: "#b7791f", r: 0.40, boss: true, base: "fast" },
  bossGroup:   { hp: 220, speed: 1.8, reward: 34, color: "#dd6b20", r: 0.44, boss: true, base: "squad" },
  bossTough:   { hp: 520, speed: 1.0, reward: 45, color: "#553c9a", r: 0.50, boss: true, base: "tough" },
  bossAir:     { hp: 200, speed: 1.0, reward: 38, color: "#2b6cb0", r: 0.44, boss: true, base: "flyer", flying: true },
  bossDecoy:   { hp: 260, speed: 1.8, reward: 38, color: "#97266d", r: 0.44, boss: true, base: "decoy", diag: true },
  bossSpawner: { hp: 240, speed: 1.6, reward: 38, color: "#2c7a7b", r: 0.48, boss: true, base: "spawner" }
};
const CREEP_INFO = {
  normal:    { name: "Normal",    desc: "Plain walker. Takes the shortest route, using diagonal steps where they save distance. Any ground tower can hit it." },
  fast:      { name: "Fast",      desc: "Moves at high speed with low health. Slows and Nets help most." },
  squad:     { name: "Squad",     desc: "Comes in a tight group of 4 with short gaps. Splash, Mine Layer and Burst work well." },
  flyer:     { name: "Air",       desc: "Ignores the maze and flies straight to its exit. Only towers that hit air can stop it." },
  tough:     { name: "Tough",     desc: "Heavy health and slow. Sniper and Plague work well against it." },
  decoy:     { name: "Decoy",     desc: "Cuts corners: squeezes diagonally between two towers or walls that touch at a corner, where other creeps must go around." },
  spawner:   { name: "Spawner",   desc: "When killed, bursts into 4 splitlings that spread out to the four diagonal sides of where it died." },
  splitling: { name: "Splitling", desc: "Small child of a Spawner. Newborns move slowly for about a second, then run. Small enough to squeeze through diagonal gaps between towers or walls that touch at a corner, like a Decoy. Quick to kill, but it counts toward the wave." },
  bossNormal:  { name: "Normal boss",  desc: "A big, sturdy walker. Comes alone on wave 9. Pays a lot of gold, more on later waves." },
  bossFast:    { name: "Fast boss",    desc: "Runs at high speed with a lot of health. Comes alone on wave 18." },
  bossGroup:   { name: "Group boss",   desc: "A sturdy leader with a lot of health. Comes alone on wave 27." },
  bossAir:     { name: "Air boss",     desc: "Flies straight to its exit, ignoring the maze, but slowly (it has little time under fire, so it is slow and a bit softer than the other bosses). Frost and Aura slow it too. Comes alone on wave 36." },
  bossTough:   { name: "Tough boss",   desc: "Slow with huge health and the biggest reward. Comes alone on wave 45." },
  bossDecoy:   { name: "Decoy boss",   desc: "Squeezes through diagonal gaps between towers. Comes alone on wave 54." },
  bossSpawner: { name: "Spawner boss", desc: "When killed, splits into 4 spawners, which split again. Comes alone on the last wave, wave 63." }
};

// ---------- maps ----------
// '#' wall, 'I' entrance, 'O' exit, '.' open. Edge middles on the 13 x 13 grid.
const LEFT = [0, 6], TOP = [6, 0], RIGHT = [12, 6], BOTTOM = [6, 12];
function withWalls(rows, blocks) {   // blocks are [x, y, w, h] rectangles of '#'
  const g = rows.map(r => r.split(""));
  for (const [x, y, w, h] of blocks) for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (g[j][i] === ".") g[j][i] = "#";
  return g.map(r => r.join(""));
}
function withTiles(rows, spec) {   // spec: { char: [[x, y, w, h], ...] } for rectangles, or { P: [[x, y]] } for single cells
  const g = rows.map(r => r.split(""));
  for (const [ch, rects] of Object.entries(spec)) for (const [x, y, w, h] of rects) for (let j = y; j < y + (h || 1); j++) for (let i = x; i < x + (w || 1); i++) if (g[j][i] === "." ) g[j][i] = ch;
  return g.map(r => r.join(""));
}
function emptyRows(ins, outs) {
  const rows = Array.from({ length: ROWS }, () => Array(COLS).fill("."));
  ins.forEach(([x, y]) => rows[y][x] = "I");
  outs.forEach(([x, y]) => rows[y][x] = "O");
  return rows.map(r => r.join(""));
}
const MAPS = [
  { name: "1 in / 1 out",
    desc: "One entrance in the middle of the left edge and one exit in the middle of the right edge. A single straight-through route; the simplest map. Open field, no walls yet.",
    flows: [ { from: LEFT, to: [RIGHT] } ],
    rows: emptyRows([LEFT], [RIGHT]) },
  { name: "1 in / 2 out",
    desc: "One entrance in the middle of the left edge. Each creep heads for whichever exit (right-middle or bottom-middle) is the shorter way at that moment, so walls and towers can change which one it takes. Open field, no walls yet.",
    flows: [ { from: LEFT, to: [RIGHT, BOTTOM] } ],
    rows: emptyRows([LEFT], [RIGHT, BOTTOM]) },
  { name: "2 in / 1 out",
    desc: "Two entrances: middle of the left edge and middle of the top edge. Both routes lead to the single exit in the middle of the right edge, so the routes merge near the exit. Open field, no walls yet.",
    flows: [ { from: LEFT, to: [RIGHT] }, { from: TOP, to: [RIGHT] } ],
    rows: emptyRows([LEFT, TOP], [RIGHT]) },
  { name: "2 in / 2 out",
    desc: "Left entrance goes to the right exit; top entrance goes to the bottom exit. The two routes cross in the middle, so a tower there covers both. Open field, no walls yet.",
    flows: [ { from: LEFT, to: [RIGHT] }, { from: TOP, to: [BOTTOM] } ],
    rows: emptyRows([LEFT, TOP], [RIGHT, BOTTOM]) },
  { name: "Pillars",
    desc: "One entrance left, one exit right. A solid block in the middle and four pillars force creeps to bend around them, so towers between the pillars reach several turns at once.",
    flows: [ { from: LEFT, to: [RIGHT] } ],
    rows: withWalls(emptyRows([LEFT], [RIGHT]), [[5,5,3,3],[2,2,2,2],[2,9,2,2],[9,2,2,2],[9,9,2,2]]) },
  { name: "Switchback",
    desc: "One entrance left, one exit right, but two long walls make the creeps zigzag: down around the first wall, up around the second, then down to the exit. A long route, so a compact cluster at the turns pays off.",
    flows: [ { from: LEFT, to: [RIGHT] } ],
    rows: withWalls(emptyRows([LEFT], [RIGHT]), [[4,0,1,10],[8,3,1,10]]) },
  { name: "Fortress",
    desc: "Two entrances (left and top) lead to one exit on the right. A central block and two side walls keep the routes apart until the last stretch, so you must defend both lanes.",
    flows: [ { from: LEFT, to: [RIGHT] }, { from: TOP, to: [RIGHT] } ],
    rows: withWalls(emptyRows([LEFT, TOP], [RIGHT]), [[5,5,3,3],[2,2,1,3],[9,8,3,1],[9,2,2,1]]) },
  { name: "Wormhole",
    desc: "One entrance left, one exit right. A solid wall splits the board; the only quick way across is the portal pair (purple swirls). Creeps always hop through, so the exit side is your kill zone. Mud (brown) around the far portal slows them, and hatched cells cannot be built on.",
    flows: [ { from: LEFT, to: [RIGHT] } ],
    rows: withTiles(withWalls(emptyRows([LEFT], [RIGHT]), [[6,1,1,11]]), { P: [[5,6]], Q: [[7,6]], x: [[4,5,1,3],[5,5,1,1],[5,7,1,1],[7,5,1,1],[7,7,1,1]], m: [[7,4,3,5]] }) },
  { name: "Gauntlet",
    desc: "One entrance left, one exit right. A wall splits the board with a swinging gate in the middle (open 8 s, shut 8 s). When it is shut, creeps take the long road around the bottom (fast tiles). A cracked wall breaks open at wave 18 and adds a second shortcut. Mud slows creeps in front of the gate.",
    flows: [ { from: LEFT, to: [RIGHT] } ],
    breakAt: 18, gateEvery: 8,
    rows: withTiles(withWalls(emptyRows([LEFT], [RIGHT]), [[6,0,1,3],[6,4,1,2],[6,7,1,5]]), { g: [[6,6]], B: [[6,3]], m: [[4,5,2,3]], r: [[1,12,11,1]] }) }
];

// Creep health per map. Two-entrance maps send twice the creeps, so their multiplier is lower than the old 1 + 0.3 x map number:
// measured as creep health per gold earned, this keeps each map a little harder than the one before it.
MAPS.push({ name: "Custom (editor)", desc: "A map you drew in the Editor tab. Draw it, press Play, or paste a share code.", flows: [ { from: LEFT, to: [RIGHT] } ], rows: emptyRows([LEFT], [RIGHT]) });
const CUSTOM_IDX = MAPS.length - 1;
const MAP_HP = [1.0, 1.0, 1.15, 1.25, 1.05, 1.1, 1.2, 1.15, 1.2, 1.15];   // map 2 eased from 1.1: two exits split your defence
function parseMap(def, idx) {
  const walls = new Set(), exits = [], tiles = new Map(), nobuild = new Set(), breakables = [], gates = [], pcells = {};
  def.rows.forEach((row, y) => {
    for (let x = 0; x < COLS; x++) {
      const ch = row[x], k = key(x, y);
      if (ch === "#") walls.add(k);
      else if (ch === "O") exits.push({ x, y });
      else if (ch === "m" || ch === "r") tiles.set(k, ch);   // mud slows creeps and costs more to walk; road speeds them up
      else if (ch === "x") nobuild.add(k);   // creeps may walk here, but nothing can be built
      else if (ch === "B") { walls.add(k); breakables.push(k); }   // a wall that opens after wave def.breakAt
      else if (ch === "g") { gates.push(k); nobuild.add(k); }   // a gate: open for a while, then closed for a while
      else if ("PQST".includes(ch)) { pcells[ch] = { x, y }; nobuild.add(k); }
    }
  });
  const portals = new Map();   // a portal cell leads to its partner
  for (const [a, b] of [["P", "Q"], ["S", "T"]]) if (pcells[a] && pcells[b]) { portals.set(key(pcells[a].x, pcells[a].y), pcells[b]); portals.set(key(pcells[b].x, pcells[b].y), pcells[a]); }
  const exitIdx = p => exits.findIndex(e => e.x === p[0] && e.y === p[1]);
  const ents = def.flows.map(f => ({ x: f.from[0], y: f.from[1], exits: f.to.map(exitIdx) }));
  return { idx, name: def.name, desc: def.desc, walls, ents, exits, hpMult: MAP_HP[idx], tiles, nobuild, breakables, gates, portals, breakAt: def.breakAt || 0, gateEvery: def.gateEvery || 0 };
}

// ---------- runtime setup ----------
let S = null, route = new Set(), lastT = 0, uiAcc = 0, paused = false;

// ---------- seeded randomness ----------
// Gameplay randomness (wave mixes, modifiers, elites, mine spots) comes from the run's seed, so the same seed,
// map and settings give the same run. Visual effects keep Math.random: they never change the outcome.
function mulberry32(a) {
  return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function hashSeed(...parts) { let h = 2166136261 >>> 0; for (const ch of parts.join("|")) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; }
const waveRng = (n, salt) => mulberry32(hashSeed(S.seed, n, salt));   // one stream per wave, so preview timing never changes a wave
const simRng = () => S.rng();                                          // the simulation's own stream, advanced only by fixed steps
const newSeed = () => Math.floor(Math.random() * 1e9).toString(36).toUpperCase();
const dailySeed = () => { const d = new Date(); return "D" + d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, "0") + String(d.getUTCDate()).padStart(2, "0"); };
let seedMode = "random", seedCustom = "";   // random | daily | custom
try { const v = Store.getItem("mtd-seedmode"); if (v === "daily" || v === "custom") seedMode = v; seedCustom = Store.getItem("mtd-seedcustom") || ""; } catch (e) { /* ignore */ }
const $ = id => document.getElementById(id);
const canvas = $("c"), ctx = canvas.getContext("2d");
const BW = COLS * CS, BH = ROWS * CS;   // board size in drawing units
let DPR = 1;
let vignetteGrad = null;
function getVignette() {
  if (!vignetteGrad) {
    vignetteGrad = ctx.createRadialGradient(BW / 2, BH / 2, BW * 0.35, BW / 2, BH / 2, BW * 0.78);
    vignetteGrad.addColorStop(0, "rgba(0,0,0,0)");
    vignetteGrad.addColorStop(1, "rgba(0,8,20,0.38)");
  }
  return vignetteGrad;
}
function fitCanvas() {   // back the canvas with real device pixels, so the board is sharp on phones and retina screens
  const d = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  if (d === DPR && canvas.width === Math.round(BW * d)) return;
  DPR = d; canvas.width = Math.round(BW * d); canvas.height = Math.round(BH * d);
}
fitCanvas(); window.addEventListener("resize", fitCanvas);

// ---------- sound ----------
// All sounds are synthesized with the Web Audio API, so there are no audio files.
// Each tower type has its own hit sound, creeps have a kill sound, and bosses have a bigger one.
const Sound = (() => {
  let ac = null, master = null, noiseBuf = null, enabled = true;
  const last = {};
  try { enabled = Store.getItem("mtd-sound") !== "off"; } catch (e) { /* storage can be blocked */ }

  function ready() {
    if (!enabled) return null;
    if (!ac) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ac = new AC();
      master = ac.createGain(); master.gain.value = 0.3; master.connect(ac.destination);
      noiseBuf = ac.createBuffer(1, Math.floor(ac.sampleRate * 0.4), ac.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ac.state === "suspended") ac.resume();
    return ac;
  }
  // A short pitched sound that slides from f0 to f1.
  function tone(o) {
    const a = ready(); if (!a) return;
    const t0 = a.currentTime + (o.delay || 0), dur = o.dur;
    const osc = a.createOscillator(), g = a.createGain();
    osc.type = o.type || "sine";
    osc.frequency.setValueAtTime(o.f0, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1 || o.f0), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(o.vol, t0 + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(master);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
  }
  // A burst of filtered noise: cracks, booms and puffs.
  function noise(o) {
    const a = ready(); if (!a) return;
    const t0 = a.currentTime + (o.delay || 0), dur = o.dur;
    const src = a.createBufferSource(), filt = a.createBiquadFilter(), g = a.createGain();
    src.buffer = noiseBuf;
    filt.type = "lowpass"; filt.frequency.value = o.f || 1500;
    g.gain.setValueAtTime(o.vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filt); filt.connect(g); g.connect(master);
    src.start(t0); src.stop(t0 + dur + 0.02);
  }

  const HIT = {
    pellet:  () => tone({ type: "square", f0: 620, f1: 380, dur: 0.05, vol: 0.10 }),
    frost:   () => { tone({ f0: 1200, f1: 1700, dur: 0.12, vol: 0.12 }); tone({ f0: 1800, f1: 2300, dur: 0.10, vol: 0.06, delay: 0.04 }); },
    splash:  () => { tone({ f0: 200, f1: 70, dur: 0.18, vol: 0.22 }); noise({ dur: 0.12, vol: 0.12, f: 900 }); },
    sniper:  () => { noise({ dur: 0.07, vol: 0.22, f: 2500 }); tone({ f0: 260, f1: 60, dur: 0.25, vol: 0.25 }); },
    gatling: () => tone({ type: "square", f0: 300, f1: 220, dur: 0.025, vol: 0.06 }),
    chain:   () => tone({ type: "sawtooth", f0: 1400, f1: 300, dur: 0.11, vol: 0.10 }),
    poison:  () => tone({ type: "triangle", f0: 340, f1: 210, dur: 0.13, vol: 0.12 }),
    plague:  () => { tone({ type: "sine", f0: 180, f1: 520, dur: 0.22, vol: 0.10 }); tone({ type: "triangle", f0: 90, f1: 70, dur: 0.3, vol: 0.10, delay: 0.05 }); },
    flak:    () => { noise({ dur: 0.09, vol: 0.16, f: 1500 }); tone({ type: "sawtooth", f0: 600, f1: 250, dur: 0.09, vol: 0.08 }); },
    mortar:  () => { tone({ f0: 130, f1: 40, dur: 0.35, vol: 0.30 }); noise({ dur: 0.25, vol: 0.20, f: 500 }); },
    burst:   () => { noise({ dur: 0.14, vol: 0.18, f: 1200 }); tone({ type: "triangle", f0: 320, f1: 90, dur: 0.18, vol: 0.16 }); },
    lance:   () => tone({ type: "square", f0: 1000, f1: 420, dur: 0.13, vol: 0.09 }),
    exec:    () => { noise({ dur: 0.1, vol: 0.2, f: 700 }); tone({ type: "sawtooth", f0: 160, f1: 50, dur: 0.3, vol: 0.2 }); },
    skyhook: () => { noise({ dur: 0.06, vol: 0.18, f: 3000 }); tone({ f0: 700, f1: 200, dur: 0.2, vol: 0.18 }); },
    mine:    () => { tone({ f0: 110, f1: 35, dur: 0.3, vol: 0.28 }); noise({ dur: 0.22, vol: 0.22, f: 600 }); },
    beam:    () => tone({ type: "sine", f0: 900, f1: 1100, dur: 0.06, vol: 0.05 }),
    silo:    () => { tone({ f0: 90, f1: 30, dur: 0.5, vol: 0.32 }); noise({ dur: 0.35, vol: 0.22, f: 400 }); },
    tesla:   () => { tone({ type: "sawtooth", f0: 1700, f1: 400, dur: 0.07, vol: 0.08 }); tone({ type: "square", f0: 900, f1: 500, dur: 0.05, vol: 0.05, delay: 0.03 }); }
  };
  // Minimum time between two plays of the same sound, so a volley or a damage-over-time tick is one sound, not a buzz.
  const GAP = { beam: 120, mine: 90, gatling: 45, poison: 220, plague: 650, frost: 90, chain: 90, tesla: 90, lance: 90, kill: 35, boss: 400 };

  function once(name, fn) {
    if (!enabled) return;
    const now = performance.now();
    if (now - (last[name] || 0) < (GAP[name] || 70)) return;
    last[name] = now;
    fn();
  }
  return {
    hit(tower) { if (HIT[tower]) once(tower, HIT[tower]); },
    kill(boss) {
      if (boss) {
        once("boss", () => {
          tone({ f0: 110, f1: 35, dur: 0.6, vol: 0.35 }); noise({ dur: 0.5, vol: 0.28, f: 700 });
          [440, 554, 659, 880].forEach((f, i) => tone({ type: "triangle", f0: f, f1: f * 1.02, dur: 0.25, vol: 0.12, delay: 0.12 + i * 0.09 }));
        });
      } else {
        once("kill", () => { tone({ f0: 820, f1: 220, dur: 0.09, vol: 0.14 }); tone({ type: "triangle", f0: 1300, f1: 700, dur: 0.07, vol: 0.07, delay: 0.04 }); });
      }
    },
    unlock() { ready(); },   // browsers only start audio after a click or key press
    enabled() { return enabled; },
    setEnabled(v) {
      enabled = v;
      try { Store.setItem("mtd-sound", v ? "on" : "off"); } catch (e) { /* ignore */ }
      if (v) ready();
    }
  };
})();


const key = (x, y) => x + "," + y;
const inBounds = (x, y) => x >= 0 && y >= 0 && x < COLS && y < ROWS;
const isWall = (x, y) => S.map.walls.has(key(x, y));
const isEntry = (x, y) => S.map.ents.some(e => e.x === x && e.y === y);
const isExit = (x, y) => S.map.exits.some(e => e.x === x && e.y === y);
const canHit = (def, c) => (c.flying ? def.air : def.ground);

// Distance from every open cell to one exit (Dijkstra): a straight step costs 1, a diagonal step costs sqrt(2).
// Strict mode (all ground creeps): a diagonal step needs both side cells open, so nobody cuts through a tower corner.
// Loose mode (decoys): diagonal steps may squeeze between two towers or walls that touch at a corner.
const M_STRICT = { dirs: DIRS8, strict: true };
const M_LOOSE  = { dirs: DIRS8, strict: false };
const stepCost = (dx, dy) => (dx !== 0 && dy !== 0 ? Math.SQRT2 : 1);
const TILE_COST = { m: 1.8, r: 0.7 }, TILE_SPEED = { m: 0.5, r: 1.5 };
const tileAt = (x, y) => S.map.tiles.get(key(x, y));
const tcost = (x, y) => TILE_COST[tileAt(x, y)] || 1;
const openCell = (x, y) => inBounds(x, y) && !isWall(x, y) && !S.towers.has(key(x, y));
function stepOk(x, y, dx, dy, mode) {
  return dx === 0 || dy === 0 || !mode.strict || (openCell(x + dx, y) && openCell(x, y + dy));
}

function computeFieldFrom(exit, mode) {
  const d = Array.from({ length: ROWS }, () => Array(COLS).fill(Infinity));
  d[exit.y][exit.x] = 0;
  const heap = [[0, exit.x, exit.y]];
  const push = it => {
    heap.push(it);
    let i = heap.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const [dist, x, y] = pop();
    if (dist > d[y][x]) continue;
    for (const [dx, dy] of mode.dirs) {
      const nx = x + dx, ny = y + dy;
      if (!openCell(nx, ny) || !stepOk(x, y, dx, dy, mode)) continue;
      const nd = dist + stepCost(dx, dy) * tcost(x, y);   // the creep walking from (nx, ny) into (x, y) pays for entering (x, y)
      if (nd < d[ny][nx] - 1e-9) { d[ny][nx] = nd; push([nd, nx, ny]); }
    }
    const pp = S.map.portals.get(key(x, y));   // a creep standing on the partner portal can hop here for 1
    if (pp && !isWall(pp.x, pp.y) && !S.towers.has(key(pp.x, pp.y)) && dist + 1 < d[pp.y][pp.x] - 1e-9) { d[pp.y][pp.x] = dist + 1; push([dist + 1, pp.x, pp.y]); }
  }
  return d;
}
function computeFields(mode) { return S.map.exits.map(e => computeFieldFrom(e, mode)); }

// Which cells can still reach each exit: a plain flood fill, much cheaper than full distances.
// Ground creeps need both side cells open for a diagonal step, so 4-way connectivity is the same reachability.
function reachSets() {
  return S.map.exits.map(ex => {
    const seen = new Uint8Array(COLS * ROWS), stack = [ex.x, ex.y];
    seen[ex.y * COLS + ex.x] = 1;
    while (stack.length) {
      const y = stack.pop(), x = stack.pop();
      for (const [dx, dy] of DIRS) {
        const nx = x + dx, ny = y + dy;
        if (openCell(nx, ny) && !seen[ny * COLS + nx]) { seen[ny * COLS + nx] = 1; stack.push(nx, ny); }
      }
      const pp = S.map.portals.get(key(x, y));
      if (pp && openCell(pp.x, pp.y) && !seen[pp.y * COLS + pp.x]) { seen[pp.y * COLS + pp.x] = 1; stack.push(pp.x, pp.y); }
    }
    return seen;
  });
}

// Recompute every route after the towers change.
function refreshFields() {
  S.fields = computeFields(M_STRICT);
  S.fields8 = computeFields(M_LOOSE);
  updateRoute();
}

// Next cell on the cheapest route: the neighbor with the lowest (its distance + the step to reach it).
function bestNeighbor(f, x, y, mode) {
  let best = null, bs = f[y][x] + 1e-9;
  for (const [dx, dy] of mode.dirs) {
    const nx = x + dx, ny = y + dy;
    if (!inBounds(nx, ny) || f[ny][nx] === Infinity || !stepOk(x, y, dx, dy, mode)) continue;
    const sc = f[ny][nx] + stepCost(dx, dy) * tcost(nx, ny);
    if (sc < bs) { bs = sc; best = { x: nx, y: ny }; }
  }
  const pp = S.map.portals.get(key(x, y));
  if (pp && inBounds(pp.x, pp.y) && f[pp.y][pp.x] + 1 < bs) best = { x: pp.x, y: pp.y, tp: true };
  return best;
}

// Ground route drawn on the map: the walk of every flow from its entrance to its exit.
function updateRoute() {
  route = new Set();
  S.routePaths = [];
  for (const e of S.map.ents) {
    // creeps head for the exit with the shortest way from here, so that is the only route shown
    const best = e.exits.reduce((a, j) => (S.fields[j][e.y][e.x] < S.fields[a][e.y][e.x] ? j : a), e.exits[0]);
    for (const j of [best]) {
      const f = S.fields[j];
      let c = { x: e.x, y: e.y };
      route.add(key(c.x, c.y));
      let pts = [[c.x + 0.5, c.y + 0.5]], cum = [0];
      const flush = () => { if (pts.length > 1) S.routePaths.push({ pts, cum, len: cum[cum.length - 1] }); };
      for (let guard = 0; guard < COLS * ROWS && !isExit(c.x, c.y); guard++) {
        const n = bestNeighbor(f, c.x, c.y, M_STRICT);
        if (!n) break;
        if (n.tp) { flush(); c = n; route.add(key(c.x, c.y)); pts = [[c.x + 0.5, c.y + 0.5]]; cum = [0]; continue; }   // a portal hop starts a new dotted segment
        cum.push(cum[cum.length - 1] + Math.hypot(n.x - c.x, n.y - c.y));
        c = n; route.add(key(c.x, c.y)); pts.push([c.x + 0.5, c.y + 0.5]);
      }
      flush();
    }
  }
}

// ---------- creeps ----------
let SELL_RATE = 0.75;   // selling returns 75% of the price plus upgrades
let HP_START = 0.6, HP_GROWTH = 0.2;   // creeps start at 60% health and gain 20% of that per wave
const statKey = type => (CREEPS[type].boss ? "boss" : type);
function typeStat(type) {   // per creep type: how many appeared, died, leaked, and which towers killed them
  const k = statKey(type);
  return S.byType[k] || (S.byType[k] = { total: 0, killed: 0, leaked: 0, by: {} });
}
function buildCreep(type, x, y, cx, cy, exitIdx, allowed, w) {
  const d = CREEPS[type];
  const hp = Math.max(1, Math.round(d.hp * HP_START * S.map.hpMult * DIFFICULTY[difficulty].mult * (1 + HP_GROWTH * (w.n - 1)) * (w.hpMul || 1) * (1 + ERA_HP * (w.ahead || 0))));
  typeStat(type).total++;
  let ex = exitIdx;
  if (d.flying) {   // flyers take the closest allowed exit in a straight line
    let bd = Infinity;
    for (const j of allowed) {
      const e = S.map.exits[j];
      const dd = Math.hypot(e.x + 0.5 - x, e.y + 0.5 - y);
      if (dd < bd) { bd = dd; ex = j; }
    }
  }
  const exit = S.map.exits[ex];
  return {
    type, hp, maxHp: hp, speed: d.speed * (w.mod === "rush" ? 1.5 : 1), armored: w.mod === "armored", regen: w.mod === "regen" ? 0.03 : 0, ab: BOSS_ABILITY[type] ? BOSS_ABILITY[type][0] : null, lastHit: -9, reward: d.boss ? Math.round(d.reward * (1 + w.n / 10)) : d.reward, color: d.color, r: d.r,   // bosses pay more on later waves
   
    flying: !!d.flying, diag: !!d.diag, x, y, cx, cy, exitIdx: ex, allowed, next: null, dir: null,
    cornerT: 0, slowT: 0, slowMul: 1, poison: null, plague: null, hex: null, trail: [], lured: false, dead: false, w, counted: false,
    target: { x: exit.x + 0.5, y: exit.y + 0.5 }
  };
}

const ERA_BOSS = [null, ["rally"], ["smoke"], ["rally", "smoke"]];
const ERA_BOSS_TEXT = { rally: "Rally: at half health it heals creeps around it by 25%", smoke: "Smoke: at half health it hides for 2.5 s from towers that aim (area damage still hits)" };
function makeCreep(item) {
  const ent = S.map.ents[item.ent];
  const c = buildCreep(item.type, ent.x + 0.5, ent.y + 0.5, ent.x, ent.y, ent.exits[0], ent.exits, item.w);
  if (CREEPS[item.type].boss && eraOn() && ERA_BOSS[S.era]) c.eraAb = ERA_BOSS[S.era];
  if (item.elite) { c.hp *= 8; c.maxHp *= 8; c.reward *= 6; c.r *= 1.35; c.elite = true; }   // an elite: 8x health, 6x gold, bigger
  return c;
}

// Shortest route: among the exits this creep may use, follow the one with the fewest steps from where it stands.
// It switches only when another exit is strictly shorter, so it does not flip back and forth.
function pickField(c) {
  const arr = c.diag ? S.fields8 : S.fields;
  let best = null, bd = Infinity;
  for (const j of c.allowed) {
    const d = arr[j][c.cy][c.cx];
    if (d < bd) { bd = d; best = j; }
  }
  if (c.allowed.includes(c.exitIdx) && arr[c.exitIdx][c.cy][c.cx] <= bd + 1e-9) best = c.exitIdx;
  if (best === null) return arr[c.exitIdx];
  c.exitIdx = best;
  return arr[best];
}

// Returns "exit" when the creep reaches its exit.
function stepCreep(c, dt) {
  const slow = (c.slowT > 0 ? c.slowMul : 1) * (c.cornerT > 0 ? CORNER_SLOW : 1);
  c.slowT = Math.max(0, c.slowT - dt);
  c.cornerT = Math.max(0, c.cornerT - dt);
  let dist = c.speed * slow * dt;
  dist *= c.hasteMul || 1;
  if (!c.flying) dist *= TILE_SPEED[tileAt(Math.floor(c.x), Math.floor(c.y))] || 1;   // mud slows, road speeds up
  if (c.flying) {
    const dx = c.target.x - c.x, dy = c.target.y - c.y, d = Math.hypot(dx, dy);
    if (d <= dist) return "exit";
    c.x += dx / d * dist; c.y += dy / d * dist;
    return null;
  }
  while (dist > 0) {
    if (!c.next) {
      const f = pickField(c);
      const n = bestNeighbor(f, c.cx, c.cy, c.diag ? M_LOOSE : M_STRICT);
      if (!n) return null;
      if (n.tp) {   // a portal: hop to the partner
        FX.ring(c.x, c.y, 0.1, 0.7, "#c084fc", 0.35);
        c.x = n.x + 0.5; c.y = n.y + 0.5; c.cx = n.x; c.cy = n.y; c.dir = null; c.trail.length = 0;
        FX.ring(c.x, c.y, 0.1, 0.7, "#c084fc", 0.35);
        continue;
      }
      c.next = n;
      const nd = [n.x - c.cx, n.y - c.cy];
      if (c.dir) {   // a turn of 90 degrees or more is a sharp turn; a gentle 45 degree bend is not
        const cos = (nd[0] * c.dir[0] + nd[1] * c.dir[1]) / (Math.hypot(nd[0], nd[1]) * Math.hypot(c.dir[0], c.dir[1]));
        if (cos < 0.1) c.cornerT = CORNER_TIME;
      }
      c.dir = nd;
    }
    const tx = c.next.x + 0.5, ty = c.next.y + 0.5;
    const dx = tx - c.x, dy = ty - c.y, d = Math.hypot(dx, dy);
    if (d <= dist) {
      c.x = tx; c.y = ty; dist -= d;
      c.trail.push([c.cx, c.cy]); if (c.trail.length > 10) c.trail.shift();
      c.cx = c.next.x; c.cy = c.next.y; c.next = null;
      if (isExit(c.cx, c.cy)) return "exit";
    } else {
      c.x += dx / d * dist; c.y += dy / d * dist; dist = 0;
    }
  }
  return null;
}

// Spatial grid: living creeps bucketed by cell, rebuilt once per step, so a tower only looks at creeps near it.
function buildGrid() {
  const g = S.grid || (S.grid = Array.from({ length: COLS * ROWS }, () => []));
  for (const b of g) b.length = 0;
  for (const c of S.creeps) {
    if (c.dead) continue;
    const gx = Math.min(COLS - 1, Math.max(0, Math.floor(c.x))), gy = Math.min(ROWS - 1, Math.max(0, Math.floor(c.y)));
    g[gy * COLS + gx].push(c);
  }
}
function near(x, y, r) {   // living creeps within r cells of (x, y)
  const out = [], g = S.grid;
  const x0 = Math.max(0, Math.floor(x - r)), x1 = Math.min(COLS - 1, Math.floor(x + r));
  const y0 = Math.max(0, Math.floor(y - r)), y1 = Math.min(ROWS - 1, Math.floor(y + r));
  for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) for (const c of g[gy * COLS + gx]) if (!c.dead && Math.hypot(c.x - x, c.y - y) <= r) out.push(c);
  return out;
}
function nearBox(x, y, r) {   // living creeps in the square of half-size r (for line attacks)
  const out = [], g = S.grid;
  const x0 = Math.max(0, Math.floor(x - r)), x1 = Math.min(COLS - 1, Math.floor(x + r));
  const y0 = Math.max(0, Math.floor(y - r)), y1 = Math.min(ROWS - 1, Math.floor(y + r));
  for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) for (const c of g[gy * COLS + gx]) if (!c.dead) out.push(c);
  return out;
}

function retire(c) { if (!c.counted) { c.counted = true; c.w.done++; } }

// A Spawner splits into 4 splitlings where it dies. They count toward the wave.
const SPLIT_SIDES = [[-1, -1], [1, -1], [-1, 1], [1, 1]];   // up-left, up-right, down-left, down-right
const SPLIT_SPREAD = 0.18;   // how far (in cells) a newborn starts from the spot where the parent died
function splitCreep(c, child) {
  c.w.total += 4;
  FX.ring(c.x, c.y, 0.1, 0.9, CREEPS[child].color, 0.35);
  for (const [sx, sy] of SPLIT_SIDES) {
    const n = buildCreep(child, c.x + sx * SPLIT_SPREAD, c.y + sy * SPLIT_SPREAD, c.cx, c.cy, c.exitIdx, c.allowed, c.w);
    n.slowT = 1.2; n.slowMul = 0.35;   // newborn: slowed for 1.2 s, so a spawner killed near the exit does not leak its children at once
    S.creeps.push(n);
  }
}

function kill(c, by) {
  if (c.dead) return;
  if (by) S.kills[by] = (S.kills[by] || 0) + 1;   // which tower type got the kill
  if (curTower) curTower.kills = (curTower.kills || 0) + 1;
  { const ts = typeStat(c.type); ts.killed++; ts.by[by || "?"] = (ts.by[by || "?"] || 0) + 1; }
  { const hx = Math.floor(c.x), hy = Math.floor(c.y); if (inBounds(hx, hy)) S.heat[hy * COLS + hx]++; }   // where creeps die, for the end-of-game heat map
  if (c.type === "spawner") splitCreep(c, "splitling");
  else if (c.type === "bossSpawner") splitCreep(c, "spawner");
  c.dead = true;
  const isBoss = !!CREEPS[c.type].boss;
  Sound.kill(isBoss);
  FX.burst(c, isBoss);
  const pay = c.reward * S.goldMult * spawnGold(spawners) * (1 + ERA_GOLD * (c.w.ahead || 0)) * (1 + CB().killGold);
  if (S.goldMult > 0) FX.text(c.x, c.y - 0.3, "+" + Math.max(1, Math.round(pay)), "#f6c445");
  if (isBoss) S.shake = 0.5;
  S.gold += pay;
  retire(c);
}
let curTower = null;   // the tower whose shot is being resolved right now, for its own kill and damage count
function hurt(c, amt, by) {
  if (c.dead) return;
  if (c.hex) amt *= 1 + c.hex.amp;   // marked by Hex
  if (c.armored && by && TOWERS[by] && TOWERS[by].dmg < 10) amt *= 0.5;   // Armored wave: weak shots do half
  if (c.ab === "plating" && c.hp > c.maxHp * 0.5) amt *= 0.7;   // boss plating
  c.lastHit = S.time;
  if (by) S.dmgBy[by] = (S.dmgBy[by] || 0) + Math.min(amt, Math.max(0, c.hp));   // damage dealt, without overkill
  if (curTower) curTower.dealt = (curTower.dealt || 0) + Math.min(amt, Math.max(0, c.hp));
  c.hp -= amt;
  if (by) {
    Sound.hit(by);   // every tower type has its own hit sound
    c.flashT = 0.08;
    if (by !== "poison" && by !== "plague") FX.spark(c.x, c.y, TOWERS[by] ? TOWERS[by].color : "#ffffff", by === "gatling" ? 1 : 3);
  }
  if (c.hp <= 0) kill(c, by);
}

function creepOnCell(x, y) {
  return S.creeps.some(c => !c.dead && !c.flying && ((c.cx === x && c.cy === y) || (c.next && c.next.x === x && c.next.y === y)));
}

// ---------- towers ----------
function canPlace(x, y) {
  if (!inBounds(x, y) || isWall(x, y) || isEntry(x, y) || isExit(x, y) || S.map.nobuild.has(key(x, y))) return false;
  if (S.towers.has(key(x, y)) || creepOnCell(x, y)) return false;
  S.towers.set(key(x, y), { tentative: true });
  const r = reachSets();
  S.towers.delete(key(x, y));
  for (const e of S.map.ents) for (const j of e.exits) if (!r[j][e.y * COLS + e.x]) return false;
  return S.creeps.every(c => c.flying || c.allowed.some(j => r[j][c.cy * COLS + c.cx]));
}

function placeTower(x, y) {
  const def = TOWERS[S.selected];
  if (towerLocked(S.selected)) return setMsg(def.name + " is locked: " + lockText(S.selected) + ".");
  if (S.gold < def.cost) return setMsg("Not enough gold for " + def.name + ".");
  if (!canPlace(x, y)) return setMsg("You can't block the path there.");
  S.towers.set(key(x, y), { type: S.selected, x, y, cd: 0, level: 1, invested: def.cost, busy: 0, mod: newMod(), lv: newLv(), picks: [], mode: extended && SINGLE_TARGET.includes(S.selected) ? buildMode : "first", only: extended && TARGETERS.includes(S.selected) ? buildOnly : "all" });
  S.gold -= def.cost; S.spentBy[S.selected] = (S.spentBy[S.selected] || 0) + def.cost;
  refreshFields();
  setMsg(def.name + " tower placed.");
  refreshUI();
}

const sellOff = () => rules !== "standard";
const sellValue = t => Math.floor(t.invested * (t.type === "wall" ? 1 : Math.min(0.95, SELL_RATE + CB().sell)));
function sellTower(x, y) {
  if (sellOff()) return setMsg(rules === "fixed" ? "Fixed gold: towers cannot be sold." : "Build only: towers cannot be sold.");
  const k = key(x, y), t = S.towers.get(k);
  if (!t || !t.type) return;
  S.gold += sellValue(t);
  S.towers.delete(k);
  if (S.inspect === k) S.inspect = null;
  refreshFields();
  setMsg("Tower sold.");
  refreshUI();
}

function upgradeTower(k, comp) {
  const t = S.towers.get(k);
  if (!t || !t.type) return;
  if (t.type === "wall") return setMsg("Walls cannot be upgraded.");
  if (extended ? (!UNIT[comp] || !canUpgrade(t, comp)) : comp !== "std") return;
  if (t.busy > 0) return setMsg("Still upgrading.");
  if (extended ? statMaxed(t, comp) : t.level >= MAX_LEVEL) return setMsg(extended ? COMP_NAME[comp] + " is already at its top level." : "Already at max level.");
  const c = upgradeCost(t, comp);
  if (S.gold < c) return setMsg("Not enough gold to upgrade.");
  const stepIdx = extended ? lvOf(t)[comp] : t.level - 1;   // which level of this stat it is (0..3); sets the offline time
  if (extended) { t.mod = modAfter(t, comp); lvOf(t)[comp]++; }
  else { t.mod = Object.assign({}, t.mod, { dmg: t.mod.dmg + CLASSIC_BONUS[t.level - 1], rng: t.mod.rng + 0.3 }); }
  t.picks.push(comp);
  S.gold -= c; t.level++; t.invested += c; S.spentBy[t.type] = (S.spentBy[t.type] || 0) + c;
  t.busy = UPGRADE_TIME[stepIdx];      // the tower is offline while it upgrades
  setMsg(TOWERS[t.type].name + ": " + (extended ? COMP_NAME[comp].toLowerCase() : "power") + " upgraded. Offline for " + t.busy + " s.");
  refreshUI();
}

function shot(x1, y1, x2, y2, color, kind) {
  if (!lastShot) lastShot = { x: x2, y: y2 };
  if (kind === "chain" || kind === "tesla") FX.bolt(x1, y1, x2, y2, color);
  else if (kind === "lance") FX.beam(x1, y1, x2, y2, color, 5, 0.22);
  else if (kind === "sniper") FX.beam(x1, y1, x2, y2, "#e6f1fa", 2, 0.25);
  else FX.tracer(x1, y1, x2, y2, color, kind === "gatling" ? 0.06 : 0.1);
}

// Total damage bonus a tower receives from beacons in range (capped at 60%).
function buffFor(t) {
  const cx = t.x + 0.5, cy = t.y + 0.5;
  let sum = 0;
  for (const b of S.towers.values()) {
    if (!b.type || b.type !== "beacon" || b === t || b.busy > 0) continue;
    const bs = towerStats(b);
    if (Math.hypot(b.x + 0.5 - cx, b.y + 0.5 - cy) <= bs.range) sum += bs.buff;
  }
  return Math.min(0.6, sum);
}

// Reload speed bonus from dynamos in range (capped at 50%).
function speedFor(t) {
  const cx = t.x + 0.5, cy = t.y + 0.5;
  let sum = 0;
  for (const d of S.towers.values()) {
    if (!d.type || d.type !== "dynamo" || d === t || d.busy > 0) continue;
    const ds = towerStats(d);
    if (Math.hypot(d.x + 0.5 - cx, d.y + 0.5 - cy) <= ds.range) sum += ds.speed;
  }
  return Math.min(0.5, sum);
}

function towerFire(t, dt) {
  if (t.busy > 0) { t.busy -= dt; return; }   // offline while upgrading
  if (t.type === "beacon" || t.type === "dynamo" || t.type === "wall" || t.type === "bank") return;   // supports only, never attack
  const def = TOWERS[t.type], st = towerStats(t);
  const ok = c => !t.only || t.only === "all" || creepGroup(c) === t.only;   // this tower only hits the creep type it was set to
  st.dmg *= 1 + buffFor(t);
  t.cd -= dt * (1 + speedFor(t));
  if (t.cd > 0) return;
  const tx = t.x + 0.5, ty = t.y + 0.5;

  if (t.type === "mine") {   // lays mines on route cells in range; update() sets them off
    t.mines = t.mines || [];
    if (t.mines.length >= minesCap(t)) { t.cd = 0.5; return; }
    const cands = [];
    for (const k of route) {
      const [x, y] = k.split(",").map(Number);
      if (isEntry(x, y) || isExit(x, y)) continue;
      const px = x + 0.5, py = y + 0.5;
      if (Math.hypot(px - tx, py - ty) > st.range || t.mines.some(m => m.x === px && m.y === py)) continue;
      cands.push([px, py]);
    }
    t.cd = cands.length ? st.cd : 1;
    if (!cands.length) return;
    const [px, py] = cands[Math.floor(simRng() * cands.length)];
    t.mines.push({ x: px, y: py }); FX.spark(px, py, def.color, 3);
    return;
  }

  if (t.type === "gravity") {   // drag ground creeps back along the cells they just walked
    const inR = near(tx, ty, st.range).filter(c => !c.dead && !c.flying && !CREEPS[c.type].boss && (c.pulled || 0) < 2 && ok(c) && c.trail.length >= 2 && Math.hypot(c.x - tx, c.y - ty) <= st.range);
    if (!inR.length) return;
    t.cd = st.cd;
    FX.ring(tx, ty, 0.2, st.range, def.color, 0.4);
    const cells = Math.max(1, Math.floor(st.pull + 1e-6));
    for (const c of inR) {
      const n = cells; c.pulled = (c.pulled || 0) + 1;
      let pt = null;
      for (let i = 0; i < n && c.trail.length; i++) pt = c.trail.pop();
      if (pt) { c.cx = pt[0]; c.cy = pt[1]; c.x = pt[0] + 0.5; c.y = pt[1] + 0.5; c.next = null; c.dir = null; FX.spark(c.x, c.y, def.color, 3); }
    }
    return;
  }

  if (t.type === "lure") {   // distracts each creep once
    const inR = near(tx, ty, st.range).filter(c => !c.flying && !c.lured && ok(c));
    if (!inR.length) return;
    t.cd = st.cd;
    FX.ring(tx, ty, 0.2, st.range, def.color, 0.4);
    for (const c of inR) {
      c.lured = true;
      c.slowT = Math.max(c.slowT, st.stun * (CREEPS[c.type].boss ? 0.6 : 1.2)); c.slowMul = 0;
    }
    return;
  }

  if (t.type === "aura" || t.type === "burst") {
    const inRange = near(tx, ty, st.range).filter(c => canHit(def, c) && ok(c));
    if (!inRange.length) return;
    t.cd = st.cd;
    FX.ring(tx, ty, 0.2, st.range, def.color, t.type === "aura" ? 0.5 : 0.28);
    for (const c of inRange) {
      if (t.type === "aura") { c.slowT = Math.max(c.slowT, 0.6); c.slowMul = st.slow; }
      else { shot(tx, ty, c.x, c.y, def.color, t.type); hurt(c, st.dmg * eff(t, c), t.type); }
    }
    return;
  }

  if (t.type === "lance") {
    const onLine = nearBox(tx, ty, st.range + 0.5).filter(c => !c.dead && canHit(def, c) && ok(c) && (
      (Math.abs(c.x - tx) <= 0.5 && Math.abs(c.y - ty) <= st.range) ||
      (Math.abs(c.y - ty) <= 0.5 && Math.abs(c.x - tx) <= st.range)));
    if (!onLine.length) return;
    t.cd = st.cd;
    for (const c of onLine) { shot(tx, ty, c.x, c.y, def.color, t.type); hurt(c, st.dmg * eff(t, c), t.type); }
    return;
  }

  if (t.type === "tesla") {
    const inRange = near(tx, ty, st.range).filter(c => canHit(def, c) && ok(c) && !(c.cloakT > 0));
    if (!inRange.length) return;
    t.cd = st.cd;
    inRange.sort((a, b) => Math.hypot(a.x - tx, a.y - ty) - Math.hypot(b.x - tx, b.y - ty));
    for (const c of inRange.slice(0, st.arcs)) { shot(tx, ty, c.x, c.y, def.color, t.type); hurt(c, st.dmg * eff(t, c), t.type); }
    return;
  }

  let target = null, best = Infinity;
  for (const c of near(tx, ty, st.range)) {
    if (c.dead || c.cloakT > 0 || !(canHit(def, c) && ok(c))) continue;
    if (t.type === "plague" && c.plague) continue;   // already infected: a creep can only be infected once
    if (t.type === "hex" && c.hex) continue;   // already marked
    if (Math.hypot(c.x - tx, c.y - ty) > st.range) continue;
    const d = Math.hypot(c.x - tx, c.y - ty);
    let score;
    if (t.mode === "closest") score = d;
    else if (t.mode === "far") score = -d;
    else if (t.mode === "weak") score = c.hp;
    else score = c.flying ? Math.hypot(c.x - c.target.x, c.y - c.target.y) : (c.prog !== undefined ? c.prog : pickField(c)[c.cy][c.cx]);   // leading: nearest the exit (distance cached once per step)
    if (score < best) { best = score; target = c; }
  }
  if (!target) return;
  t.cd = st.cd;
  shot(tx, ty, target.x, target.y, def.color, t.type);

  if (t.type === "splash" || t.type === "mortar" || t.type === "silo") {
    FX.ring(target.x, target.y, 0.1, st.radius, def.color, 0.28);
    FX.spark(target.x, target.y, def.color, 6);
    for (const c of near(target.x, target.y, st.radius)) {
      if (!c.dead && !c.flying && ok(c)) hurt(c, st.dmg * eff(t, c), t.type);
    }
    return;
  }
  if (t.type === "chain") {
    let last = target, amt = st.dmg;
    const hit = new Set([target]);
    hurt(target, amt * eff(t, target), t.type);
    for (let j = 0; j < st.chain; j++) {
      let nxt = null, nd = 2.5;
      for (const c of near(last.x, last.y, 2.5)) {
        if (c.dead || hit.has(c) || !(canHit(def, c) && ok(c))) continue;
        const d = Math.hypot(c.x - last.x, c.y - last.y);
        if (d < nd) { nd = d; nxt = c; }
      }
      if (!nxt) break;
      amt *= 0.8;
      shot(last.x, last.y, nxt.x, nxt.y, def.color, "chain");
      hurt(nxt, amt * eff(t, nxt), t.type);
      hit.add(nxt); last = nxt;
    }
    return;
  }
  if (t.type === "hex") {
    target.hex = { t: 4, amp: st.buff };
    FX.ring(target.x, target.y, 0.1, 0.7, def.color, 0.4); FX.spark(target.x, target.y, def.color, 6);
    return;
  }
  if (t.type === "exec") {
    hurt(target, Math.max(1, target.hp * st.dmg / 100 * eff(t, target)), "exec");
    FX.ring(target.x, target.y, 0.1, 0.6, def.color, 0.3);
    return;
  }
  if (t.type === "beam") {
    if (t.lock !== target) { t.lock = target; t.ramp = 0; } else t.ramp = Math.min(5, (t.ramp || 0) + 0.1);
    hurt(target, st.dmg * (1 + t.ramp) * eff(t, target), "beam");
    return;
  }
  if (t.type === "net") {
    target.slowT = Math.max(target.slowT, st.stun); target.slowMul = 0;
    return;
  }
  if (t.type === "plague") {
    target.plague = { dps: st.dmg * eff(t, target), t: def.duration, spore: 0, src: t };   // drains health for def.duration seconds, then it can be infected again
    FX.ring(target.x, target.y, 0.1, 0.8, def.color, 0.4); FX.spark(target.x, target.y, def.color, 8);
    Sound.hit("plague");
    return;
  }
  if (t.type === "poison") {
    const dps = st.dmg * eff(t, target);
    target.poison = { dps: Math.max(dps, target.poison ? target.poison.dps : 0), t: 3, src: t };
    return;
  }
  hurt(target, st.dmg * eff(t, target), t.type);
  if (t.type === "frost" && !target.dead) { target.slowT = 2; target.slowMul = st.slow; }
}

// ---------- waves ----------
// Launching never waits for the previous wave: new creeps join the queue while old ones are still moving.
// Creep types and the wave at which each one first appears.
const typeName = t => TYPE_LABEL[t] || (CREEP_INFO[t] ? CREEP_INFO[t].name : t);
const TYPE_LABEL = { normal: "Normal", fast: "Fast", squad: "Group", tough: "Tough", flyer: "Air", decoy: "Decoy", spawner: "Spawner" };
// Waves come in blocks of 9: eight regular waves, then a boss wave.
//   Block 1: one creep type per wave (INTRO order), the 8th wave mixes all types.
//   Block 2: eight waves that each mix two types. Block 3: three types. And so on, up to all types.
// The boss waves bring one boss per creep type, in BOSS_ORDER, and nothing else. 7 bosses x 9 waves = 63 waves.
const INTRO = ["normal", "fast", "squad", "flyer", "tough", "decoy", "spawner"];
const BLOCK = 9;
const BOSS_ORDER = ["bossNormal", "bossFast", "bossGroup", "bossAir", "bossTough", "bossDecoy", "bossSpawner"];

function shuffled(arr, rnd) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// What wave n is made of: { kind: "single" | "mix" | "all" | "boss", types: [...], boss: type or null }
function waveInfo(n) {   // decided once per wave, so the preview matches what really comes
  const cache = S.waveInfoCache;
  return cache[n] || (cache[n] = makeWaveInfo(n));
}
const PUZZLES = {
  puzzle1: { name: "Puzzle: Air raid", map: 0, gold: 160, waves: 20, towers: [["splash", 4, 4], ["splash", 6, 4], ["splash", 8, 4], ["splash", 4, 8], ["splash", 6, 8], ["splash", 8, 8], ["burst", 6, 5], ["burst", 6, 7]],
    text: "Your ground defence is strong, but Splash cannot hit air. 160 gold, 20 waves. Fix it." },
  puzzle2: { name: "Puzzle: Wrong place", map: 4, gold: 220, waves: 24, towers: [["pellet", 0, 0], ["pellet", 12, 0], ["pellet", 0, 12], ["pellet", 12, 12], ["sniper", 1, 1], ["sniper", 11, 1], ["sniper", 1, 11], ["sniper", 11, 11], ["splash", 2, 6], ["frost", 12, 5]],
    text: "These towers are all in the wrong places. Sell and rebuild with 220 gold. 24 waves." }
};
function makeWaveInfo(n) {
  if (levelType === "bossrush") return { kind: "boss", types: [], boss: BOSS_ORDER[(n - 1) % BOSS_ORDER.length] };
  if (S.custom) {   // developer mode: the wave is exactly what the script says
    const list = S.custom[n - 1] || [];
    return { kind: "custom", types: [...new Set(list.map(e => e.type))], boss: null, custom: list };
  }
  const block = Math.floor((n - 1) / BLOCK), pos = (n - 1) % BLOCK;
  if (pos === BLOCK - 1) return { kind: "boss", types: [], boss: BOSS_ORDER[block % BOSS_ORDER.length] };
  const rnd = waveRng(n, "info");
  let r;
  if (block === 0) {
    r = pos < INTRO.length ? { kind: "single", types: [INTRO[pos]], boss: null } : { kind: "all", types: INTRO.slice(), boss: null };
  } else {
    const count = Math.min(block + 1, INTRO.length);
    r = { kind: count >= INTRO.length ? "all" : "mix", types: shuffled(INTRO, rnd).slice(0, count), boss: null };
  }
  if (n >= 10) {   // from wave 10: some waves carry a modifier, and the 4th and 7th wave of a block bring an elite
    if (rnd() < 0.3) r.mod = ["armored", "regen", "swarm", "rush"][Math.floor(rnd() * 4)];
    if (pos === 3 || pos === 6) r.elite = r.types[Math.floor(rnd() * r.types.length)];
  }
  return r;
}
// Wave modifiers, elite creeps and boss abilities
const MODS = {
  armored: { name: "Armored", desc: "weak shots (under 10 damage) do half damage" },
  regen:   { name: "Regenerating", desc: "heals 3% of its health per second if not hit for 1 s" },
  swarm:   { name: "Swarm", desc: "twice as many creeps with half the health" },
  rush:    { name: "Rush", desc: "creeps move 50% faster" }
};
const BOSS_ABILITY = {
  bossNormal: ["enrage", "Enrage: below 30% health it runs 60% faster."],
  bossFast:   ["enrage", "Enrage: below 30% health it runs 60% faster."],
  bossGroup:  ["brood", "Brood: at 50% health it calls 4 group creeps."],
  bossTough:  ["plating", "Plating: takes 30% less damage while above 50% health."],
  bossDecoy:  ["plating", "Plating: takes 30% less damage while above 50% health."]
};
// The wave a boss comes on, for the guides.
const bossWave = type => (BOSS_ORDER.indexOf(type) + 1) * BLOCK;

// Launching a wave early pays gold for every second of the countdown you skip. The rate rises with the wave number.
const EARLY_BASE = 0.4, EARLY_GROW = 0.04;
const earlyRate = n => (EARLY_BASE + EARLY_GROW * n) * S.goldMult * (1 + CB().early);
function earlyBonus() {
  if (!S || S.over || S.levelDone || paused || S.launched >= MAX_WAVES || S.autoT === null || S.autoT <= 0) return 0;
  return Math.round(S.autoT * earlyRate(S.launched + 1));
}
function launchEarly() {
  const bonus = earlyBonus(), before = S.launched;
  launchWave();
  if (S && S.launched > before && bonus > 0) {
    S.gold += bonus; S.earlyTotal += bonus;
    FX.text(COLS / 2, 1.2, "+" + bonus + " early launch", "#7ee787");
    setMsg("Wave " + S.launched + " launched early: +" + bonus + " gold.");
  }
}
function launchWave() {
  if (!S || S.over || S.levelDone || paused || S.launched >= MAX_WAVES) return;
  S.launched++;
  const n = S.launched;
  if (eraOn() && S.era < natEra(n)) { S.era = natEra(n); eraBanner(S.era, false); }   // the next era arrives on schedule
  if (S.map.breakAt && n === S.map.breakAt && S.map.breakables.length) { for (const k of S.map.breakables) S.map.walls.delete(k); S.map.breakables = []; refreshFields(); setMsg("A wall has broken open: the route changes!"); }
  const info = waveInfo(n);
  const target = (6 + Math.round(n * 1.4)) * (info.mod === "swarm" ? 2 : 1);   // creeps per wave
  const w = { n, total: 0, done: 0, paid: false, mod: info.mod || null, hpMul: info.mod === "swarm" ? 0.5 : 1, ahead: eraOn() ? Math.max(0, S.era - natEra(n)) : 0 };
  S.waves.push(w);
  const ents = S.map.ents.length;
  let made = 0;   // creeps per entrance so far; with two entrances every entrance gets the same creeps
  const add = type => {
    for (let i = 0; i < spawners; i++) S.queue.push({ type, w, ents: S.map.ents.map((_, k) => k) });
    made++; w.total += ents * spawners;
  };
  if (info.custom) {
    for (const e of info.custom) for (let i = 0; i < e.n; i++) add(e.type);
  } else if (info.boss) {   // a boss wave is one boss and nothing else
    add(info.boss);
  } else {
    const rnd = waveRng(n, "mix");
    while (made < target) {
      const type = info.types[Math.floor(rnd() * info.types.length)];
      if (type === "squad") { for (let i = 0; i < 4; i++) add("squad"); }
      else if (type === "spawner") { add(type); made += 4; }   // a spawner brings 4 splitlings later, so it counts as 5 creeps of the wave
      else add(type);
    }
  }
  if (info.elite) { S.queue.push({ type: info.elite, w, ents: S.map.ents.map((_, k) => k), elite: true }); w.total += ents; }   // one elite creep joins the wave
  S.autoT = AUTO_WAIT;   // each wave gives AUTO_WAIT seconds; then the next one starts on its own
  { const ts = info.custom ? info.types : info.boss ? [info.boss] : info.types.slice(); if (ts.includes("spawner")) ts.push("splitling"); noteNewTypes(ts); }
  const label = info.custom ? (info.custom.map(e => e.n + " " + typeName(e.type)).join(", ") || "empty") : info.boss ? CREEP_INFO[info.boss].name : (info.kind === "all" ? "all types" : info.types.map(t => TYPE_LABEL[t]).join(" + "));
  setMsg("Wave " + n + " (" + label + (info.mod ? ", " + MODS[info.mod].name.toUpperCase() : "") + (info.elite ? ", +ELITE" : "") + ") launched" + (S.creeps.length ? " while the previous creeps are still on the map." : "."));
  refreshUI();
}

// ---------- loop ----------
function update(dt) {
  if (!S || S.over || S.levelDone || paused) return;

  if (S.autoT !== null && S.launched < MAX_WAVES) {
    S.autoT -= dt;
    if (S.autoT <= 0) launchWave();
  }

  if (S.map.gates.length) {   // gates swing open and shut, so the route changes while they move
    S.gateT = (S.gateT === undefined ? S.map.gateEvery : S.gateT) - dt;
    if (S.gateT <= 0) {
      S.gateT = S.map.gateEvery; S.gateShut = !S.gateShut;
      for (const k of S.map.gates) S.gateShut ? S.map.walls.add(k) : S.map.walls.delete(k);
      refreshFields();
    }
  }

  if (S.queue.length) {
    S.spawnT -= dt;
    if (S.spawnT <= 0) {
      const item = S.queue.shift();
      for (const e of item.ents) S.creeps.push(makeCreep({ type: item.type, ent: e, w: item.w, elite: item.elite }));   // one per entrance, at the same moment
      S.spawnT = (item.type === "squad" ? 0.15 : Math.max(0.3, 0.8 - 0.02 * S.launched)) / spawners;   // more spawners: a faster stream
    }
  }

  for (const c of S.creeps) {
    if (c.dead) continue;
    if (c.plague) {
      curTower = c.plague.src || null; hurt(c, c.plague.dps * dt, "plague"); curTower = null;
      c.plague.spore -= dt;
      if (c.plague.spore <= 0 && !c.dead) { c.plague.spore = 0.5; FX.spark(c.x, c.y, "#a3e635", 1); }
      c.plague.t -= dt;
      if (c.plague.t <= 0) c.plague = null;   // recovered: it can be infected again
      if (c.dead) continue;
    }
    if (c.regen && c.hp < c.maxHp && S.time - c.lastHit > 1) c.hp = Math.min(c.maxHp, c.hp + c.regen * c.maxHp * dt);
    if (c.ab === "enrage") c.hasteMul = c.hp < c.maxHp * 0.3 ? 1.6 : 1;
    if (c.cloakT > 0) c.cloakT = Math.max(0, c.cloakT - dt);
    if (c.eraAb && !c.eraDone && c.hp < c.maxHp * 0.5) {   // era bosses: Medieval rallies, Industrial smokes, Modern does both
      c.eraDone = true;
      if (c.eraAb.includes("rally")) { FX.ring(c.x, c.y, 0.2, 2.2, "#f6c445", 0.6); for (const o of S.creeps) if (o !== c && !o.dead && Math.hypot(o.x - c.x, o.y - c.y) <= 2.2) o.hp = Math.min(o.maxHp, o.hp + o.maxHp * 0.25); }
      if (c.eraAb.includes("smoke")) { c.cloakT = 2.5; FX.ring(c.x, c.y, 0.2, 1.2, "#94a3b8", 0.8); }
    }
    if (c.ab === "brood" && !c.broodDone && c.hp < c.maxHp * 0.5) {
      c.broodDone = true; c.w.total += 4; FX.ring(c.x, c.y, 0.2, 1.4, "#fb7185", 0.5);
      for (let i = 0; i < 4; i++) { const n = buildCreep("squad", c.x, c.y, c.cx, c.cy, c.exitIdx, c.allowed, c.w); n.slowT = 1.0; n.slowMul = 0.4; S.creeps.push(n); }
    }
    if (c.hex) { c.hex.t -= dt; if (c.hex.t <= 0) c.hex = null; }
    if (c.poison && c.poison.t > 0) {
      curTower = c.poison.src || null; hurt(c, c.poison.dps * dt, "poison"); curTower = null;
      c.poison.t -= dt;
      if (c.dead) continue;
    }
    if (stepCreep(c, dt) === "exit") {
      c.dead = true; retire(c);
      S.lives -= 1; S.leaked++; c.w.leaked = (c.w.leaked || 0) + 1; S.flash = 0.35; typeStat(c.type).leaked++;
      { const ex = c.flying ? { x: Math.floor(c.target.x), y: Math.floor(c.target.y) } : { x: c.cx, y: c.cy };   // show where it got out
        FX.ring(ex.x + 0.5, ex.y + 0.5, 0.2, 1.6, "#ff5a46", 0.7); FX.text(Math.min(COLS - 1.4, Math.max(1.4, ex.x + 0.5)), Math.max(0.6, ex.y - 0.1), "-1 " + typeName(c.type), "#ff8a7a", 1.2);
        S.leakLog.push({ type: c.type, wave: c.w.n, wave0: S.launched });
        if (S.time - (S.leakMsgT || -9) > 2 && S.lives > 0) { S.leakMsgT = S.time; setMsg("Leak: a " + typeName(c.type) + " creep got through. " + (ADVICE[statKey(c.type)] || "")); } }
      if (S.lives <= 0) {
        S.lives = 0; S.over = true; S.autoT = null;
        let best = "";
        if (levelType === "endless") { try { const k2 = "mtd-endless", all = JSON.parse(Store.getItem(k2) || "{}"), kk = S.map.idx + "|" + difficulty, prev = all[kk] || 0; if (S.launched > prev) { all[kk] = S.launched; Store.setItem(k2, JSON.stringify(all)); best = " New best!"; } else best = " Best: wave " + prev + "."; } catch (e) { /* ignore */ } }
        best += civAward();
        setMsg("Game over on wave " + S.launched + "." + best + " Press Restart map to try again.");
      }
    }
  }

  for (const c of S.creeps) if (!c.dead && !c.flying) c.prog = pickField(c)[c.cy][c.cx];   // distance to the exit, once per step
  buildGrid();
  for (const t of S.towers.values()) {
    if (!t.type) continue;
    const cd0 = t.cd;
    lastShot = null;
    curTower = t;
    towerFire(t, dt);
    curTower = null;
    if (t.cd > cd0 + 1e-9) {   // the tower just fired
      t.flash = 0.14;
      if (lastShot) t.aim = Math.atan2(lastShot.y - (t.y + 0.5), lastShot.x - (t.x + 0.5));
    }
    if (t.flash > 0) t.flash = Math.max(0, t.flash - dt);
  }

  for (const t of S.towers.values()) {   // mines: a ground creep stepping on one sets it off
    if (t.type !== "mine" || !t.mines || !t.mines.length || t.busy > 0) continue;
    const st = towerStats(t); st.dmg *= 1 + buffFor(t);
    curTower = t;
    t.mines = t.mines.filter(m => {
      if (!near(m.x, m.y, 0.45).some(c => !c.flying)) return true;
      FX.ring(m.x, m.y, 0.1, st.radius, TOWERS.mine.color, 0.35); FX.spark(m.x, m.y, TOWERS.mine.color, 10); Sound.hit("mine");
      for (const c of near(m.x, m.y, st.radius)) if (!c.dead && !c.flying) hurt(c, st.dmg * eff(t, c), "mine");
      return false;
    });
    curTower = null;
  }
  { let j = 0; const a = S.creeps; for (let i = 0; i < a.length; i++) if (!a[i].dead) a[j++] = a[i]; a.length = j; }   // drop the dead in place
  for (const w of S.waves) {
    if (!w.paid && w.done >= w.total) {
      w.paid = true;
      const bonus = Math.round((5 + w.n) * S.goldMult * (1 + CB().waveBonus));
      if (!w.leaked) S.perfect = (S.perfect || 0) + 1;
      if (waveInfo(w.n).boss) S.bossesDown = (S.bossesDown || 0) + 1;
      S.gold += bonus;
      let bank = 0;
      for (const t of S.towers.values()) if (t.type === "bank" && !(t.busy > 0)) bank += Math.round(TOWERS.bank.income * (1 + t.mod.dmg) * S.goldMult);
      S.gold += bank;
      if (S.goldMult > 0) setMsg("Wave " + w.n + " cleared! +" + bonus + " gold" + (bank ? " (+" + bank + " from banks)" : "") + ".");
    }
  }


  if (!S.over && S.launched === MAX_WAVES && S.queue.length === 0 && S.creeps.length === 0) {
    S.levelDone = true; S.autoT = null;
    const got = recordClear() + civAward();
    setMsg((S.map.idx < CUSTOM_IDX - 1 ? "Map cleared! Press Next map." : "All maps cleared. Well played!") + got);
    applyLocks();
  }
}

// ---------- visual effects ----------
// Particles, rings, bolts, tracers and floating text. Times are in game seconds, positions in cells.
let lastShot = null;   // where the tower that is firing right now aimed its first shot
const FX = {
  add(o) { if (S && S.fx.length < 450) S.fx.push(o); },
  spark(x, y, color, n) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = 1.2 + Math.random() * 2.8, life = 0.22 + Math.random() * 0.2;
      FX.add({ type: "p", x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life, max: life, size: 1.5 + Math.random() * 1.8, color: i === 0 ? "#ffffff" : color });
    }
  },
  ring(x, y, r0, r1, color, life) { FX.add({ type: "ring", x, y, r0, r1, color, life, max: life }); },
  text(x, y, txt, color, life, size) { FX.add({ type: "text", x, y, txt, color, size, life: life || 0.8, max: life || 0.8 }); },
  beam(x1, y1, x2, y2, color, w, life) { FX.add({ type: "beam", x1, y1, x2, y2, color, w, life, max: life }); },
  tracer(x1, y1, x2, y2, color, life) { FX.add({ type: "tracer", x1, y1, x2, y2, color, life, max: life }); },
  bolt(x1, y1, x2, y2, color) {   // a jagged lightning line
    const pts = [[x1, y1]], n = 6, len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const nx = -(y2 - y1) / len, ny = (x2 - x1) / len;
    for (let i = 1; i < n; i++) {
      const k = i / n, j = (Math.random() - 0.5) * 0.35;
      pts.push([x1 + (x2 - x1) * k + nx * j, y1 + (y2 - y1) * k + ny * j]);
    }
    pts.push([x2, y2]);
    FX.add({ type: "bolt", pts, color, life: 0.16, max: 0.16 });
  },
  burst(c, big) {   // a creep dies
    FX.spark(c.x, c.y, c.color, big ? 40 : 11);
    FX.ring(c.x, c.y, 0.1, big ? 2.2 : 0.7, c.color, big ? 0.6 : 0.3);
    if (big) FX.ring(c.x, c.y, 0.05, 1.3, "#f6e05e", 0.45);
  }
};

function updateFx(dt) {
  if (!S) return;
  S.time += dt;
  S.shake = Math.max(0, S.shake - dt);
  S.flash = Math.max(0, S.flash - dt);
  for (const f of S.fx) {
    f.life -= dt;
    if (f.type === "p") { f.x += f.vx * dt; f.y += f.vy * dt; f.vx *= 0.92; f.vy *= 0.92; }
  }
  S.fx = S.fx.filter(f => f.life > 0);
  for (const c of S.creeps) if (c.flashT > 0) c.flashT = Math.max(0, c.flashT - dt);
}

function drawFx() {
  ctx.globalCompositeOperation = "lighter";   // glowing look on the dark blueprint
  for (const f of S.fx) {
    const a = Math.max(0, f.life / f.max);
    if (f.type === "p") {
      ctx.globalAlpha = a; ctx.fillStyle = f.color;
      ctx.beginPath(); ctx.arc(f.x * CS, f.y * CS, f.size * (0.4 + a * 0.6), 0, Math.PI * 2); ctx.fill();
    } else if (f.type === "ring") {
      const r = (f.r0 + (f.r1 - f.r0) * (1 - a)) * CS;
      ctx.globalAlpha = a * 0.85; ctx.strokeStyle = f.color; ctx.lineWidth = 1.5 + 3 * a;
      ctx.beginPath(); ctx.arc(f.x * CS, f.y * CS, r, 0, Math.PI * 2); ctx.stroke();
    } else if (f.type === "bolt") {
      ctx.globalAlpha = a; ctx.lineJoin = "round";
      for (const [w, col] of [[4, f.color], [1.5, "#ffffff"]]) {
        ctx.strokeStyle = col; ctx.lineWidth = w; ctx.beginPath();
        f.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * CS, y * CS) : ctx.moveTo(x * CS, y * CS)));
        ctx.stroke();
      }
    } else if (f.type === "beam") {
      ctx.globalAlpha = a; ctx.lineCap = "round";
      ctx.strokeStyle = f.color; ctx.lineWidth = f.w + 3;
      ctx.beginPath(); ctx.moveTo(f.x1 * CS, f.y1 * CS); ctx.lineTo(f.x2 * CS, f.y2 * CS); ctx.stroke();
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = f.w * 0.5;
      ctx.beginPath(); ctx.moveTo(f.x1 * CS, f.y1 * CS); ctx.lineTo(f.x2 * CS, f.y2 * CS); ctx.stroke();
      ctx.lineCap = "butt";
    } else if (f.type === "tracer") {
      const p = 1 - a, hx = f.x1 + (f.x2 - f.x1) * p, hy = f.y1 + (f.y2 - f.y1) * p;
      const tp = Math.max(0, p - 0.35), tx = f.x1 + (f.x2 - f.x1) * tp, ty = f.y1 + (f.y2 - f.y1) * tp;
      ctx.globalAlpha = 0.9; ctx.strokeStyle = f.color; ctx.lineWidth = 3; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(tx * CS, ty * CS); ctx.lineTo(hx * CS, hy * CS); ctx.stroke(); ctx.lineCap = "butt";
      ctx.fillStyle = "#ffffff"; ctx.beginPath(); ctx.arc(hx * CS, hy * CS, 2.2, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.globalCompositeOperation = "source-over";
  ctx.font = "700 14px " + FONT; ctx.textAlign = "center";
  for (const f of S.fx) {
    if (f.type !== "text") continue;
    ctx.font = "700 " + (f.size || 14) + "px " + FONT;
    const a = Math.max(0, f.life / f.max);
    ctx.globalAlpha = Math.min(1, a * 1.6);
    ctx.lineWidth = 3; ctx.strokeStyle = "rgba(8,22,38,0.8)"; ctx.strokeText(f.txt, f.x * CS, (f.y - (1 - a) * 0.8) * CS);
    ctx.fillStyle = f.color; ctx.fillText(f.txt, f.x * CS, (f.y - (1 - a) * 0.8) * CS);
  }
  ctx.globalAlpha = 1; ctx.lineWidth = 1;
}

// Dots that travel along the route show which way creeps will walk.
function drawFlow() {
  const speed = 1.4, gap = 1.1;
  ctx.fillStyle = "rgba(230,241,250,0.5)";
  for (const path of S.routePaths) {
    for (let d = (S.time * speed) % gap; d < path.len; d += gap) {
      let i = 1; while (i < path.cum.length - 1 && path.cum[i] < d) i++;
      const seg = path.cum[i] - path.cum[i - 1] || 1, k = Math.min(1, Math.max(0, (d - path.cum[i - 1]) / seg));
      const x = path.pts[i - 1][0] + (path.pts[i][0] - path.pts[i - 1][0]) * k;
      const y = path.pts[i - 1][1] + (path.pts[i][1] - path.pts[i - 1][1]) * k;
      ctx.beginPath(); ctx.arc(x * CS, y * CS, 2.2, 0, Math.PI * 2); ctx.fill();
    }
  }
}

// ---------- render ----------
// The board is drawn as a blueprint sheet: chalk lines on cyanotype blue.
const FONT = '"Barlow Condensed", system-ui, sans-serif';
const BP = { sheet: "#113555", route: "#1c4d7a", wall: "#2d5580", chalk: "#e6f1fa", ink: "#0b2540" };

function render() {
  const W = BW, H = BH;
  fitCanvas();
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  if (S.shake > 0) { const m = S.shake * 9; ctx.translate((Math.random() - 0.5) * m, (Math.random() - 0.5) * m); }   // boss kills shake the board
  renderBoard();
  ctx.restore();
  if (S.flash > 0) { ctx.strokeStyle = "rgba(255,90,70," + (S.flash / 0.35 * 0.7).toFixed(2) + ")"; ctx.lineWidth = 14; ctx.strokeRect(0, 0, W, H); ctx.lineWidth = 1; }   // a creep got through
}

function renderBoard() {
  const W = BW, H = BH;

  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    const px = x * CS, py = y * CS;
    if (isWall(x, y)) {
      ctx.fillStyle = BP.wall; ctx.fillRect(px, py, CS, CS);
      ctx.fillStyle = "rgba(255,255,255,0.10)"; ctx.fillRect(px, py, CS, 3); ctx.fillRect(px, py, 3, CS);   // lit top-left edges
      ctx.fillStyle = "rgba(0,10,25,0.28)"; ctx.fillRect(px, py + CS - 3, CS, 3); ctx.fillRect(px + CS - 3, py, 3, CS);
      ctx.strokeStyle = "rgba(230,241,250,0.35)"; ctx.lineWidth = 1;
      ctx.strokeRect(px + 4.5, py + 4.5, CS - 9, CS - 9);
      ctx.beginPath(); ctx.moveTo(px + 4.5, py + 4.5); ctx.lineTo(px + CS - 4.5, py + CS - 4.5);
      ctx.moveTo(px + CS - 4.5, py + 4.5); ctx.lineTo(px + 4.5, py + CS - 4.5); ctx.stroke();
      continue;
    }
    ctx.fillStyle = route.has(key(x, y)) ? BP.route : BP.sheet;
    ctx.fillRect(px, py, CS, CS);
    const tl = S.map.tiles.get(key(x, y));
    if (tl) {   // mud: brown with dots; road: light with dashes
      ctx.fillStyle = tl === "m" ? "rgba(150,100,50,0.55)" : "rgba(220,235,250,0.22)"; ctx.fillRect(px, py, CS, CS);
      ctx.fillStyle = tl === "m" ? "rgba(60,35,15,0.7)" : "rgba(230,241,250,0.7)";
      if (tl === "m") for (const [u, v] of [[0.25, 0.3], [0.65, 0.4], [0.4, 0.7], [0.75, 0.75]]) { ctx.beginPath(); ctx.arc(px + u * CS, py + v * CS, 2.2, 0, Math.PI * 2); ctx.fill(); }
      else for (let i = 0; i < 3; i++) ctx.fillRect(px + 4 + i * (CS / 3), py + CS / 2 - 1, CS / 5, 2);
    }
    if (S.map.nobuild.has(key(x, y))) { ctx.strokeStyle = "rgba(230,241,250,0.28)"; ctx.lineWidth = 1; ctx.beginPath(); for (let i = -CS; i < CS; i += 8) { ctx.moveTo(px + Math.max(0, i), py + Math.max(0, -i)); ctx.lineTo(px + Math.min(CS, i + CS), py + Math.min(CS, CS - i)); } ctx.stroke(); }   // hatching: nothing can be built here
  }
  for (const [k, pp] of S.map.portals) {   // portals: a swirl in the pair's colour
    const [x, y] = k.split(",").map(Number), cx = x * CS + CS / 2, cy = y * CS + CS / 2, t = S.time * 2;
    ctx.strokeStyle = "#c084fc"; ctx.lineWidth = 2.5;
    for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc(cx, cy, CS * (0.14 + 0.11 * i), t + i, t + i + 4.2); ctx.stroke(); }
    ctx.lineWidth = 1;
  }
  for (const k of S.map.breakables) {   // breakable walls look cracked
    const [x, y] = k.split(",").map(Number), px = x * CS, py = y * CS;
    ctx.strokeStyle = "#f6c445"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(px + CS * 0.3, py + 4); ctx.lineTo(px + CS * 0.45, py + CS * 0.45); ctx.lineTo(px + CS * 0.35, py + CS * 0.6); ctx.lineTo(px + CS * 0.6, py + CS - 4); ctx.stroke(); ctx.lineWidth = 1;
  }
  for (const k of S.map.gates) {   // gates: striped bar, red when shut
    const [x, y] = k.split(",").map(Number), px = x * CS, py = y * CS;
    ctx.fillStyle = S.gateShut ? "rgba(255,110,90,0.8)" : "rgba(60,207,154,0.35)"; ctx.fillRect(px + 4, py + CS / 2 - 4, CS - 8, 8);
    if (!S.gateShut) { ctx.strokeStyle = "rgba(60,207,154,0.9)"; ctx.strokeRect(px + 4, py + CS / 2 - 4, CS - 8, 8); }
  }
  ctx.strokeStyle = "rgba(190,220,255,0.14)"; ctx.lineWidth = 1;
  for (let x = 0; x <= COLS; x++) { ctx.beginPath(); ctx.moveTo(x * CS + 0.5, 0); ctx.lineTo(x * CS + 0.5, H); ctx.stroke(); }
  for (let y = 0; y <= ROWS; y++) { ctx.beginPath(); ctx.moveTo(0, y * CS + 0.5); ctx.lineTo(W, y * CS + 0.5); ctx.stroke(); }

  ctx.fillStyle = getVignette(); ctx.fillRect(0, 0, W, H);   // soft vignette focuses the eye on the middle
  ctx.strokeStyle = "rgba(124,196,255,0.22)"; ctx.lineWidth = 1;   // major grid every 4 cells, like drafting paper
  for (let i = 4; i < COLS; i += 4) { ctx.beginPath(); ctx.moveTo(i * CS + 0.5, 0); ctx.lineTo(i * CS + 0.5, H); ctx.stroke(); }
  for (let i = 4; i < ROWS; i += 4) { ctx.beginPath(); ctx.moveTo(0, i * CS + 0.5); ctx.lineTo(W, i * CS + 0.5); ctx.stroke(); }

  drawFlow();

  ctx.font = "700 14px " + FONT; ctx.textAlign = "center";
  for (const e of S.map.ents) {
    ctx.fillStyle = "#3ccf9a"; ctx.fillRect(e.x * CS, e.y * CS, CS, CS);
    ctx.fillStyle = "#06261b"; ctx.fillText("IN", e.x * CS + CS / 2, e.y * CS + CS / 2 + 5);
  }
  for (const e of S.map.exits) {
    ctx.fillStyle = "#ff7a6b"; ctx.fillRect(e.x * CS, e.y * CS, CS, CS);
    ctx.fillStyle = "#3a0d07"; ctx.fillText("OUT", e.x * CS + CS / 2, e.y * CS + CS / 2 + 5);
  }

  if (S.hover && !S.over && !S.towers.has(key(S.hover.x, S.hover.y)) && !isWall(S.hover.x, S.hover.y)) {
    const { x, y } = S.hover, def = TOWERS[S.selected];
    const ok = canPlace(x, y) && S.gold >= def.cost;
    ctx.fillStyle = ok ? "rgba(160,210,255,0.2)" : "rgba(255,122,107,0.32)";
    reachPath(S.selected, x * CS + CS / 2, y * CS + CS / 2, def.range); ctx.fill();
    ctx.globalAlpha = 0.6;
    drawTower({ type: S.selected, x, y, level: 0, busy: 0 });
    ctx.globalAlpha = 1;
  }

  const insp = S.inspect && S.towers.get(S.inspect);
  if (insp && insp.type) {
    ctx.strokeStyle = "rgba(159,210,255,0.95)"; ctx.setLineDash([6, 4]); ctx.lineWidth = 2;
    reachPath(insp.type, insp.x * CS + CS / 2, insp.y * CS + CS / 2, towerStats(insp).range);
    ctx.stroke(); ctx.setLineDash([]); ctx.lineWidth = 1;
  }

  for (const t of S.towers.values()) if (t.type) drawTower(t);
  for (const t of S.towers.values()) if (t.type === "mine" && t.mines) for (const m of t.mines) {   // laid mines
    ctx.fillStyle = "#b45309"; ctx.strokeStyle = BP.chalk; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(m.x * CS, m.y * CS, CS * 0.13, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.lineWidth = 1;
  }
  for (const c of S.creeps) {   // modifier rings: armored grey, regenerating green, rush amber, elite gold
    const col = c.elite ? "#f6c445" : c.armored ? "#94a3b8" : c.regen ? "#4ade80" : (c.speed > CREEPS[c.type].speed * 1.4 ? "#fbbf24" : null);
    if (col) { ctx.strokeStyle = col; ctx.lineWidth = c.elite ? 3 : 2; ctx.beginPath(); ctx.arc(c.x * CS, c.y * CS, c.r * CS + 2, 0, Math.PI * 2); ctx.stroke(); ctx.lineWidth = 1; }
  }
  for (const c of S.creeps) if (c.cloakT > 0) { ctx.fillStyle = "rgba(148,163,184,0.55)"; ctx.beginPath(); ctx.arc(c.x * CS, c.y * CS, c.r * CS + 6, 0, Math.PI * 2); ctx.fill(); }   // smoke cloud
  for (const c of S.creeps) if (c.hex) { ctx.strokeStyle = "#a855f7"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(c.x * CS, c.y * CS, c.r * CS + 4, 0, Math.PI * 2); ctx.stroke(); ctx.lineWidth = 1; }   // Hex mark

  for (const c of S.creeps) {
    const px = c.x * CS, py = c.y * CS, r = c.r * CS;
    ctx.fillStyle = "rgba(0,0,0,0.28)";   // shadow: flyers hover higher above theirs
    ctx.beginPath(); ctx.ellipse(px + (c.flying ? 4 : 1), py + (c.flying ? 9 : r * 0.55), r * 0.9, r * 0.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = c.color;
    ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.32)";   // highlight
    ctx.beginPath(); ctx.arc(px - r * 0.3, py - r * 0.3, r * 0.38, 0, Math.PI * 2); ctx.fill();
    if (c.flashT > 0) { ctx.fillStyle = "rgba(255,255,255," + (c.flashT / 0.08 * 0.75).toFixed(2) + ")"; ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill(); }
    ctx.strokeStyle = c.flying ? "#fff" : "rgba(230,241,250,0.85)"; ctx.lineWidth = c.flying ? 2 : 1.5; ctx.stroke(); ctx.lineWidth = 1;
    if (c.diag && c.type !== "splitling") { ctx.strokeStyle = "#fbb6ce"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(px, py, r + 2, 0, Math.PI * 2); ctx.stroke(); ctx.lineWidth = 1; }
    if (c.slowT > 0) { ctx.strokeStyle = "#63b3ed"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.stroke(); ctx.lineWidth = 1; }
    if (c.plague) {   // infected: a green tint and a dashed ring that spins
      ctx.fillStyle = "rgba(163,230,53,0.38)"; ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = Math.min(1, c.plague.t / 1.5 + 0.25); ctx.strokeStyle = "#a3e635"; ctx.lineWidth = 2; ctx.setLineDash([3, 3]); ctx.lineDashOffset = -S.time * 12;
      ctx.beginPath(); ctx.arc(px, py, r + 3, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); ctx.lineWidth = 1; ctx.globalAlpha = 1;
    }
    if (c.poison && c.poison.t > 0) { ctx.strokeStyle = "#b7c93c"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(px, py, r + 2, 0, Math.PI * 2); ctx.stroke(); ctx.lineWidth = 1; }
    if (c === S.selCreep) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(px, py, r + 5, 0, Math.PI * 2); ctx.stroke(); ctx.lineWidth = 1; }
    const isBoss = !!CREEPS[c.type].boss;
    if (isBoss) { ctx.strokeStyle = "#f6e05e"; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(px, py, r + 3, 0, Math.PI * 2); ctx.stroke(); ctx.lineWidth = 1; }
    const bw = CS * (isBoss ? 0.95 : 0.6);
    ctx.fillStyle = BP.ink; ctx.fillRect(px - bw / 2 - 1, py - r - 8, bw + 2, 6);
    ctx.fillStyle = "#4fd18f"; ctx.fillRect(px - bw / 2, py - r - 7, bw * Math.max(0, c.hp / c.maxHp), 4);
  }

  drawFx();

  if (S.launched === 0 && !S.over) {
    ctx.fillStyle = "rgba(230,241,250,0.85)"; ctx.font = "600 22px " + FONT; ctx.textAlign = "center";
    ctx.fillText("Place towers, then launch wave 1", W / 2, H / 2 - 40);
  }
  if ((S.over || S.levelDone) && S.showHeat) drawHeat(W, H);
  else if (S.over || S.levelDone) {
    ctx.fillStyle = "rgba(8,22,38,0.7)"; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = BP.chalk; ctx.font = "700 40px " + FONT; ctx.textAlign = "center";
    ctx.fillText(S.over ? "Game over" : "Map cleared", W / 2, H / 2);
  } else if (paused) {
    ctx.fillStyle = "rgba(8,22,38,0.62)"; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = BP.chalk; ctx.font = "700 44px " + FONT; ctx.textAlign = "center";
    ctx.fillText("Paused", W / 2, H / 2);
    ctx.font = "500 18px " + FONT; ctx.fillStyle = "rgba(230,241,250,0.8)";
    ctx.fillText("Press P or Resume to continue", W / 2, H / 2 + 30);
  }
}

// End-of-game heat map: how many creeps died in each cell (blue = few, yellow, red = most).
function drawHeat(W, H) {
  ctx.fillStyle = "rgba(8,22,38,0.45)"; ctx.fillRect(0, 0, W, H);
  let max = 0, hot = null;
  for (let i = 0; i < S.heat.length; i++) if (S.heat[i] > max) { max = S.heat[i]; hot = i; }
  const col = t => {   // 0..1 -> blue, green, yellow, red
    const st = [[0, 60, 130, 255], [0.35, 70, 220, 160], [0.65, 250, 220, 60], [1, 255, 70, 50]];
    for (let i = 1; i < st.length; i++) if (t <= st[i][0]) { const a = st[i - 1], b = st[i], u = (t - a[0]) / (b[0] - a[0]); return [a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u].map(Math.round); }
    return [255, 70, 50];
  };
  ctx.textAlign = "center"; ctx.font = "600 11px " + FONT;
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    const v = S.heat[y * COLS + x]; if (!v) continue;
    const t = Math.sqrt(v / max), [r, g, b] = col(t);
    ctx.fillStyle = "rgba(" + r + "," + g + "," + b + "," + (0.35 + 0.45 * t).toFixed(2) + ")";
    ctx.fillRect(x * CS, y * CS, CS, CS);
    if (v >= max * 0.2) { ctx.fillStyle = "#fff"; ctx.fillText(String(v), x * CS + CS / 2, y * CS + CS / 2 + 4); }
  }
  ctx.fillStyle = BP.chalk; ctx.font = "700 26px " + FONT; ctx.textAlign = "center";
  ctx.fillText((S.over ? "Game over" : "Map cleared") + " - where creeps died", W / 2, 30);
  ctx.font = "500 14px " + FONT; ctx.fillStyle = "rgba(230,241,250,0.9)";
  const total = S.heat.reduce((a, b) => a + b, 0);
  ctx.fillText(total + " kills" + (hot !== null ? ", most in one cell: " + max + " at column " + (hot % COLS + 1) + ", row " + (Math.floor(hot / COLS) + 1) : "") + "   (H hides this)", W / 2, H - 12);
}

// Outline of a tower's attack area: a circle, or a plus shape for the Lance.
function reachPath(type, cx, cy, range) {
  ctx.beginPath();
  if (type !== "lance") { ctx.arc(cx, cy, range * CS, 0, Math.PI * 2); return; }
  const r = range * CS, h = CS / 2;
  const pts = [[-h, -r], [h, -r], [h, -h], [r, -h], [r, h], [h, h], [h, r], [-h, r], [-h, h], [-r, h], [-r, -h], [-h, -h]];
  pts.forEach(([dx, dy], i) => (i ? ctx.lineTo(cx + dx, cy + dy) : ctx.moveTo(cx + dx, cy + dy)));
  ctx.closePath();
}

function drawTower(t) {
  const def = TOWERS[t.type];
  const cx = t.x * CS + CS / 2, cy = t.y * CS + CS / 2;
  const fl = Math.max(0, t.flash || 0) / 0.14;   // 1 right after a shot, fading to 0
  if (t.aim !== undefined && def.cd > 0) {   // barrel that turns toward the last target and kicks back when firing
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(t.aim);
    ctx.fillStyle = BP.chalk;
    ctx.fillRect(CS * 0.2, -2.5, CS * 0.36 - fl * 3, 5);
    ctx.restore();
  }
  ctx.fillStyle = BP.ink; ctx.lineJoin = "round";
  shapePath(t.type, cx, cy, CS * 0.46); ctx.fill();
  const full = fullyMaxed(t);
  ctx.strokeStyle = full ? "#f6e05e" : BP.chalk;   // a fully upgraded tower gets a gold ring
  ctx.lineWidth = full ? 2.5 : 1.5; ctx.stroke(); ctx.lineWidth = 1;
  ctx.fillStyle = def.color;
  shapePath(t.type, cx, cy, CS * 0.34 * (1 + 0.1 * fl)); ctx.fill();
  if (fl > 0) {   // muzzle flash
    ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = fl * 0.55; ctx.fillStyle = def.color;
    shapePath(t.type, cx, cy, CS * (0.46 + 0.14 * fl)); ctx.fill();
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
  }
  drawIcon(t.type, cx, cy, CS * 0.56);
  if (t.only && t.only !== "all") {   // a colored dot shows which creep type this tower is set to hit
    ctx.fillStyle = t.only === "boss" ? "#c53030" : CREEPS[t.only].color;
    ctx.strokeStyle = BP.chalk; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cx + CS * 0.33, cy - CS * 0.33, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.lineWidth = 1;
  }
  ctx.fillStyle = BP.chalk;
  if (extended) {   // three groups of up to 4 dots: red damage, blue range, green reload
    const groups = statsOf(t); let gx = cx - (groups.length * 10 - 3) / 2;
    for (const c of groups) {
      ctx.fillStyle = COMP_COLOR[c];
      for (let i = 0; i < lvOf(t)[c]; i++) { ctx.beginPath(); ctx.arc(gx + i * 2.4 + 1, cy + CS * 0.38, 1.1, 0, Math.PI * 2); ctx.fill(); }
      gx += 10;
    }
  } else {
    ctx.fillStyle = BP.chalk;
    for (let i = 0; i < (t.level || 0); i++) { ctx.beginPath(); ctx.arc(cx - 8 + i * 4, cy + CS * 0.36, 1.8, 0, Math.PI * 2); ctx.fill(); }
  }
  if (t.busy > 0) {   // offline while upgrading
    ctx.fillStyle = "rgba(8,22,38,0.7)";
    shapePath(t.type, cx, cy, CS * 0.46); ctx.fill();
    ctx.fillStyle = BP.chalk; ctx.font = "700 14px " + FONT; ctx.textAlign = "center";
    ctx.fillText(Math.ceil(t.busy) + "s", cx, cy + 5);
  }
}

// ---------- UI ----------
function setMsg(t) { $("msg").textContent = t; }
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const stat = (label, value) => "<div><dt>" + label + "</dt><dd>" + value + "</dd></div>";

function supportStats(t, st) {   // numbers for the newer towers
  const def = TOWERS[t.type], out = [];
  if (def.dmg > 0) out.push(stat("This run", (t.kills || 0) + " kills, " + Math.round(t.dealt || 0) + " damage"));
  if (t.type === "hex") out.push(stat("Marks", "+" + Math.round(st.buff * 100) + "% damage taken, 4 s"));
  if (t.type === "gravity") out.push(stat("Pull back", Math.floor(st.pull + 1e-6) + " cells"));
  if (t.type === "lure") out.push(stat("Distraction", (st.stun * 1.2).toFixed(1) + " s, once per creep"));
  if (t.type === "bank") out.push(stat("Income", Math.round(def.income * (1 + st.bonus) * S.goldMult) + " gold per wave"));
  if (t.type === "mine") out.push(stat("Blast radius", st.radius.toFixed(1)), stat("Mines out", (t.mines ? t.mines.length : 0) + " of " + minesCap(t)));
  if (t.type === "beam") out.push(stat("Ramp", "up to 6x on one target"));
  if (t.type === "silo") out.push(stat("Blast radius", st.radius.toFixed(1)));
  return out;
}
const compValue = (t, comp, st) => {
  const def = TOWERS[t.type];
  if (comp === "rng") return t.type === "lance" ? (st.range - 0.5).toFixed(1) + " cells" : st.range.toFixed(1);
  if (comp === "rel") return st.cd.toFixed(2) + " s";
  if (t.type === "exec") return st.dmg.toFixed(1) + "% hp";
  if (def.dmg > 0) return st.dmg.toFixed(1);
  if (t.type === "hex") return "+" + Math.round(st.buff * 100) + "% dmg taken";
  if (t.type === "gravity") return Math.floor(st.pull + 1e-6) + " cells";
  if (t.type === "lure") return (st.stun * 1.2).toFixed(1) + " s";
  if (t.type === "bank") return "+" + Math.round(def.income * (1 + st.bonus) * S.goldMult) + "g/wave";
  if (t.type === "net") return st.stun.toFixed(1) + " s hold";
  if (t.type === "aura") return Math.round((1 - st.slow) * 100) + "% slow";
  if (t.type === "beacon") return "+" + Math.round(st.buff * 100) + "% dmg";
  return "+" + Math.round(st.speed * 100) + "% reload";   // dynamo
};
const segHtml = (cur, locked, attr) => "<div class='seg'>" + Object.entries(MODES).map(([k, n]) =>
  "<button " + attr + "='" + k + "' aria-pressed='" + (k === cur) + "'" + (locked ? " disabled" : "") + " title='Targets " + MODE_HINT[k] + "'>" + n + "</button>").join("") + "</div>";
const onlyHtml = (cur, locked, attr) => "<div class='seg'>" + Object.entries(ONLY).map(([k, n]) =>
  "<button " + attr + "='" + k + "' aria-pressed='" + (k === cur) + "'" + (locked ? " disabled" : "") + ">" + n + "</button>").join("") + "</div>";
let panelKey = "";
function renderPanel() {
  const t = S.inspect && S.towers.get(S.inspect);
  const p = $("panel");
  if (!t || !t.type) { p.hidden = true; return; }
  const def = TOWERS[t.type], st = towerStats(t);
  p.hidden = false;
  $("panelTitle").innerHTML = iconSvg(t.type, 20) + " " + esc(def.name) + " <span style='margin-left:auto;color:var(--mute);font-weight:500'>" + (extended ? "upgrades " + (t.level - 1) + " of " + (MAX_STAT * statsOf(t).length) : "level " + t.level + " of " + MAX_LEVEL) + "</span>";
  const maxed = fullyMaxed(t), cost = !extended && !maxed ? upgradeCost(t) : 0, canBuy = !maxed && t.busy <= 0 && (extended || S.gold >= cost);
  const comps = statsOf(t);
  const rows = comps.map(c => {
    const label = c === "dmg" && def.dmg <= 0 ? "Power" : (c === "dmg" && t.type === "plague" ? "Drain/s" : COMP_NAME[c]);
    const done = statMaxed(t, c), cc = done ? 0 : upgradeCost(t, c), lvl = lvOf(t)[c];
    const pips = "<span class='pips'>" + [0, 1, 2, 3].map(i => "<i style='background:" + (i < lvl ? COMP_COLOR[c] : "var(--line)") + "'></i>").join("") + "</span>";
    const next = done ? "" : " <em>&rarr; " + compValue(t, c, towerStats(t, modAfter(t, c))) + "</em>";
    const ok = !done && t.busy <= 0 && S.gold >= cc;
    return "<div class='uprow'><span class='lab' style='color:" + COMP_COLOR[c] + "'>" + label + "</span><span class='val'>" + compValue(t, c, st) + next + pips + "</span>" +
      "<button data-up='" + c + "'" + (ok ? "" : " disabled") + " title='" + (done ? "Top level" : "Level " + (lvl + 1) + " of " + MAX_STAT + ", offline " + UPGRADE_TIME[lvl] + " s") + "'>" + (done ? "Max" : "+ " + cc + "g") + "</button></div>";
  }).join("");
  if (!extended) {   // Normal mode: one upgrade button, plain stats
    const ex = [];
    if (t.type === "exec") ex.push(stat("Hit", st.dmg.toFixed(1) + "% of current health"));
    else if (def.dmg > 0) ex.push(stat("Damage", st.dmg.toFixed(1)));
    ex.push(...supportStats(t, st));
    ex.push(t.type === "lance" ? stat("Reach", (st.range - 0.5).toFixed(1) + " cells in line") : stat("Range", st.range.toFixed(1)));
    if (def.cd > 0) ex.push(stat("Reload", st.cd.toFixed(2) + " s"));
    if (t.type === "frost") ex.push(stat("Slow", Math.round((1 - st.slow) * 100) + "%"));
    if (t.type === "splash" || t.type === "mortar") ex.push(stat("Blast radius", st.radius.toFixed(1)));
    if (t.type === "chain") ex.push(stat("Jumps", st.chain));
    if (t.type === "tesla") ex.push(stat("Arcs", st.arcs));
    if (t.type === "net") ex.push(stat("Hold", st.stun.toFixed(1) + " s"));
    if (t.type === "aura") ex.push(stat("Slow", Math.round((1 - st.slow) * 100) + "%"));
    if (t.type === "beacon") ex.push(stat("Damage to towers", "+" + Math.round(st.buff * 100) + "%"));
    if (t.type === "dynamo") ex.push(stat("Reload speed", "+" + Math.round(st.speed * 100) + "%"));
    ex.push(stat("Upgrade power", "+" + Math.round(st.bonus * 100) + "%"));
    if (t.busy > 0) ex.push(stat("Offline", t.busy.toFixed(1) + " s"));
    const btn = t.busy > 0 ? "Upgrading..." : maxed ? "Max level" : "Upgrade (" + cost + "g, " + UPGRADE_TIME[t.level - 1] + " s offline)";
    const nh = "<div class='actions' style='margin-top:10px'><button data-up='std'" + (canBuy ? "" : " disabled") + ">" + btn + "</button></div>";
    const key2 = nh + "|" + ex.join("");
    if (key2 !== panelKey) { panelKey = key2; $("upRows").innerHTML = nh; $("modeRow").innerHTML = ""; $("panelInfo").innerHTML = ex.join(""); }
    $("sellBtn").textContent = sellOff() ? "Cannot sell" : "Sell (+" + sellValue(t) + "g)"; $("sellBtn").disabled = sellOff();
    return;
  }
  const info = t.busy > 0 ? "Upgrading, offline for " + t.busy.toFixed(1) + " s" : (maxed ? "Every stat is at its top level." : "Each stat has its own 4 levels. All three share one price, set by the most-upgraded stat. The 4th level of a stat counts double. Offline 3, 5, 8 and 12 s for levels 1 to 4.");
  let mode = "";
  if (SINGLE_TARGET.includes(t.type)) {
    const locked = t.level > 1;
    mode = "<div class='modelab'>Target: " + MODES[t.mode] + (locked ? " (locked after the first upgrade)" : " (can be changed until the first upgrade)") + "</div>" + segHtml(t.mode, locked, "data-mode");
  }
  if (TARGETERS.includes(t.type)) {
    const locked = t.level > 1;
    mode += "<div class='modelab'>Hits: " + ONLY[t.only || "all"] + (locked ? " (locked after the first upgrade)" : " (can be changed until the first upgrade)") + "</div>" + onlyHtml(t.only || "all", locked, "data-only");
  }
  const extra = [];
  if (t.type === "frost") extra.push(stat("Slow", Math.round((1 - st.slow) * 100) + "%"));
  if (t.type === "splash" || t.type === "mortar") extra.push(stat("Blast radius", st.radius.toFixed(1)));
  if (t.type === "chain") extra.push(stat("Jumps", st.chain));
  if (t.type === "tesla") extra.push(stat("Arcs", st.arcs));
  extra.push(...supportStats(t, st));
  const html = rows + "|" + info + "|" + mode + "|" + extra.join("");
  if (html !== panelKey) {   // only rebuild when something changed, so buttons keep working while you click them
    panelKey = html;
    $("upRows").innerHTML = rows + "<div class='uptext'>" + info + "</div>";
    $("modeRow").innerHTML = mode;
    $("panelInfo").innerHTML = extra.join("");
  }
  $("sellBtn").textContent = sellOff() ? "Cannot sell" : "Sell (+" + sellValue(t) + "g)"; $("sellBtn").disabled = sellOff();
}

function renderCreepPanel() {
  const p = $("creepPanel"), cr = S.selCreep;
  if (!cr || cr.dead) { S.selCreep = null; p.hidden = true; return; }
  const sp = cr.speed * (cr.slowT > 0 ? cr.slowMul : 1) * (cr.cornerT > 0 ? CORNER_SLOW : 1);
  const flags = [];
  if (cr.flying) flags.push("flies");
  if (cr.diag) flags.push("squeezes through diagonal gaps");
  if (cr.eraAb) flags.push(cr.eraAb.map(a => ERA_BOSS_TEXT[a].split(":")[0]).join(" + ") + " (era boss)");
  if (cr.cloakT > 0) flags.push("hidden in smoke");
  if (cr.elite) flags.push("ELITE: 8x health");
  if (cr.armored) flags.push("armored: weak shots do half");
  if (cr.regen) flags.push("regenerates");
  if (cr.ab) flags.push(BOSS_ABILITY[cr.type][1]);
  p.hidden = false;
  p.innerHTML = "<h3>" + esc(CREEP_INFO[cr.type].name) + "</h3><dl class='stats'>" +
    stat("Health", Math.ceil(cr.hp) + " / " + cr.maxHp) +
    stat("Speed", sp.toFixed(1) + " cells/s") +
    stat("Base speed", cr.speed.toFixed(1)) +
    stat("Reward", cr.reward + " gold") +
    stat("From wave", cr.w.n) + "</dl>" +
    (flags.length ? "<div class='caption'>" + flags.join(", ") + "</div>" : "");
}

// End-of-map statistics: how many creeps each tower type killed.
let statsKey = "";
function renderStats() {
  const box = $("stats");
  const hint = $("statsHint");
  if (!(S.over || S.levelDone)) { box.hidden = true; hint.hidden = false; statsKey = ""; return; }
  hint.hidden = true;
  const killed = Object.values(S.kills).reduce((a, b) => a + b, 0), total = killed + S.leaked;
  const key = S.map.idx + ":" + JSON.stringify(S.kills) + JSON.stringify(S.dmgBy) + ":" + S.leaked + ":" + (S.over ? "over" : "done");
  box.hidden = false;
  if (key === statsKey) return;
  if (!statsKey) showTab("stats");   // the map just ended: show the statistics
  statsKey = key;
  const rows = Object.entries(S.kills).sort((a, b) => b[1] - a[1]).map(([k, n]) => {
    const pct = killed ? Math.round(n / killed * 100) : 0;
    return "<div class='srow'>" + iconSvg(k, 20) + "<span>" + esc(TOWERS[k].name) + "</span><div class='bar'><i style='width:" + pct + "%'></i></div><span class='val'>" + pct + "% (" + n + ")</span></div>";
  }).join("");
  const rate = Object.keys(S.spentBy).filter(k => TOWERS[k] && TOWERS[k].dmg > 0).map(k => ({ k, dmg: S.dmgBy[k] || 0, kills: S.kills[k] || 0, spent: S.spentBy[k], per: (S.dmgBy[k] || 0) / S.spentBy[k] * 100 }));
  let rating = "";
  if (rate.length) {
    const sorted = rate.map(r => r.per).sort((a, b) => a - b), med = sorted[Math.floor(sorted.length / 2)];
    const fmt = n => n >= 10000 ? Math.round(n / 1000) + "k" : String(Math.round(n));
    rate.sort((a, b) => b.per - a.per);
    rating = "<h3 style='margin-top:16px'>Tower rating</h3><p class='caption'>Damage per 100 gold spent (price plus upgrades). Low values are slots you could swap for something stronger.</p><table class='rate'><tr><th>Tower</th><th>Damage</th><th>Kills</th><th>Gold</th><th>Dmg/100g</th></tr>" +
      rate.map(r => "<tr><td>" + esc(TOWERS[r.k].name) + "</td><td>" + fmt(r.dmg) + "</td><td>" + r.kills + "</td><td>" + r.spent + "</td><td class='" + (r.spent >= 100 && r.per < med * 0.4 ? "part" : (r.per >= med * 1.5 ? "full" : "")) + "'>" + fmt(r.per) + (r.spent >= 100 && r.per < med * 0.4 ? " weak" : "") + "</td></tr>").join("") + "</table>";
  }
  const names = { boss: "Bosses", splitling: "Splitlings", squad: "Group", flyer: "Air" };
  const order = ["normal", "fast", "squad", "flyer", "tough", "decoy", "spawner", "splitling", "boss"];
  const tname = t => esc(TOWERS[t] ? TOWERS[t].name : "Unknown");
  const types = order.filter(k => S.byType[k]).map(k => {
    const ts = S.byType[k], label = names[k] || TYPE_LABEL[k] || k;
    const parts = Object.entries(ts.by).sort((a, b) => b[1] - a[1]);
    const bar = parts.map(([t, n]) => "<i title='" + tname(t) + ": " + n + "' style='width:" + (n / Math.max(1, ts.killed) * 100) + "%;background:" + (TOWERS[t] ? TOWERS[t].color : "#888") + "'></i>").join("");
    const leg = parts.map(([t, n]) => tname(t) + " " + Math.round(n / ts.killed * 100) + "%").join(" · ");
    const dot = k === "boss" ? "#c53030" : (CREEPS[k] ? CREEPS[k].color : "#888");
    return "<div class='trow'><div class='head'><span><i style='display:inline-block;width:11px;height:11px;border-radius:50%;background:" + dot + ";margin-right:6px'></i>" + label + "</span><span>" +
      ts.killed + " of " + ts.total + " killed" + (ts.leaked ? ", " + ts.leaked + " leaked" : "") + "</span></div>" +
      (ts.killed ? "<div class='parts'>" + bar + "</div><div class='legend'>" + leg + "</div>" : "<div class='legend'>No kills</div>") + "</div>";
  }).join("");
  box.innerHTML = "<h3>" + (S.over ? "Game over: statistics" : "Map cleared: statistics") + "</h3>" +
    "<p class='caption'>Killed " + killed + " of " + total + " creeps, " + S.leaked + " got through. Share of kills by tower type:</p>" +
    (rows || "<p class='caption'>No tower killed a creep.</p>") + rating +
    (types ? "<h3 style='margin-top:16px'>By creep type</h3><p class='caption'>Which towers killed each creep type (bar colors match the towers):</p>" + types : "");
}

let detailKey = "";
function renderDetail() {
  const dk = S.selected + "|" + buildMode + "|" + buildOnly + "|" + extended;
  if (detailKey === dk) return;
  detailKey = dk;
  const def = TOWERS[S.selected], best = bestOf(S.selected);
  const where = def.air && def.ground ? "Hits ground and air" : (def.air ? "Hits air only" : "Hits ground only");
  $("towerDetail").innerHTML = "<h3>" + iconSvg(S.selected, 20) + " " + esc(def.name) + "<span>" + def.cost + "g</span></h3>" +
    "<p>" + esc(def.desc) + "</p><p class='meta'>" + where + "." + (best ? " Strongest against: " + esc(best) + "." : "") + "</p>" +
    "<p class='meta'>Upgrades cost " + upgradePlan(S.selected).join(", ") + " gold." + (extended ? " Damage, range and reload each have 4 levels and share these prices." : "") + "</p>" +
    (extended && SINGLE_TARGET.includes(S.selected) ? "<div class='modelab'>Target when placed: " + MODES[buildMode] + " (" + MODE_HINT[buildMode] + ")</div>" + segHtml(buildMode, false, "data-mode") : "") +
    (extended && TARGETERS.includes(S.selected) ? "<div class='modelab'>Hits when placed: " + ONLY[buildOnly] + "</div>" + onlyHtml(buildOnly, false, "data-only") : "");
}

function setPaused(v) {
  if (!S || S.over || S.levelDone) return;
  paused = v;
  S.hover = null;
  refreshUI();
}
function togglePause() { setPaused(!paused); }

function showTab(name) {
  for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-selected", b.dataset.tab === name ? "true" : "false");
  for (const el of document.querySelectorAll(".pane")) el.hidden = el.dataset.pane !== name;
  currentTab = name;
}
let currentTab = "sel", selKey = "";
for (const b of document.querySelectorAll(".tabs button")) b.addEventListener("click", () => showTab(b.dataset.tab));

// ---------- coaching: advice, first-run tips, new enemy cards, end-of-run screen ----------
const ADVICE = {
  normal: "Add steady single-target damage along the route (Pellet, Gatling) and make the maze longer.",
  fast: "Slow them early: Frost or Aura near the start of the maze, then damage behind it.",
  squad: "Groups come packed together: use area damage (Splash, Burst, Tesla).",
  flyer: "Air creeps fly straight over the maze: build Flak, Pellet or Sniper near the exit. Splash cannot hit air.",
  tough: "Tough creeps need big hits: Sniper, Plague, and upgrades into damage.",
  decoy: "Decoys slip between towers that touch only at a corner. Close corner gaps or put damage beside them.",
  spawner: "Kill Spawners early in the maze, so their 4 splitlings have a long way to go. Splitlings also slip through corner gaps.",
  splitling: "Splitlings are weak but many and slip through corner gaps: area damage (Splash, Burst) behind your single-target towers.",
  boss: "Bosses need focused damage: Sniper, Hex, Executioner, Beam. For the Air boss, Flak."
};
const TUT = [
  { text: "<b>Build a maze.</b> Tap an empty cell to build the selected tower. Creeps walk around towers, so your towers are the walls of their route.", done: () => S.towers.size >= 1 },
  { text: "<b>Make the route long.</b> Build a few more towers so creeps walk past them for longer, then press <b>Launch wave</b> (or Space).", done: () => S.launched >= 1 },
  { text: "<b>Upgrade.</b> Kills pay gold. Tap a tower to upgrade its damage, range or reload. Each stat has 4 levels.", done: () => [...S.towers.values()].some(t => t.level > 1) },
  { text: "<b>Earn more.</b> Launching the next wave before the timer ends pays bonus gold. New eras bring stronger towers: wait for them, or pay to advance.", done: () => S.launched >= 4 },
  { text: "<b>Grow your civilization.</b> Every run earns Science, Production and Culture. Spend them in the <b>Civilization</b> tab on technologies that stay with you.", done: () => S.over || S.levelDone }
];
let tutStep = 0;
try { const v = Store.getItem("mtd-tut"); tutStep = v === "done" ? TUT.length : (parseInt(v, 10) || 0); } catch (e) { /* ignore */ }
let tipKey = "";
function renderTip() {
  const box = $("tip");
  while (tutStep < TUT.length && S && TUT[tutStep].done()) { tutStep++; Store.setItem("mtd-tut", tutStep >= TUT.length ? "done" : tutStep); }
  const show = S && tutStep < TUT.length && !inDev() && !PUZZLES[levelType];
  const k = show ? String(tutStep) : "";
  if (k === tipKey) return; tipKey = k;
  box.hidden = !show;
  if (!show) return;
  box.innerHTML = "<span class='tx'>" + TUT[tutStep].text + " <small style='color:var(--mute)'>Tip " + (tutStep + 1) + " of " + TUT.length + "</small></span><button id='tipNext'>Got it</button><button id='tipSkip'>Skip tips</button>";
}
document.addEventListener("click", e => {
  if (e.target.id === "tipNext") { tutStep++; Store.setItem("mtd-tut", tutStep >= TUT.length ? "done" : tutStep); tipKey = "x"; renderTip(); }
  else if (e.target.id === "tipSkip") { tutStep = TUT.length; Store.setItem("mtd-tut", "done"); tipKey = "x"; renderTip(); }
});

// New enemy cards: the first time a creep type ever appears, a short card explains it and how to beat it.
let SEEN = {};
try { SEEN = JSON.parse(Store.getItem("mtd-seen") || "{}") || {}; } catch (e) { SEEN = {}; }
const toastQ = []; let toastT = null;
function noteNewTypes(types) {
  if (inDev()) return;
  for (const t of types) {
    if (!t || SEEN[t] || !CREEP_INFO[t]) continue;
    SEEN[t] = 1; toastQ.push(t);
  }
  Store.setItem("mtd-seen", JSON.stringify(SEEN));
  if (!toastT) nextToast();
}
function nextToast() {
  const box = $("toast"), t = toastQ.shift();
  if (!t) { box.hidden = true; toastT = null; return; }
  box.innerHTML = "<button id='toastX' aria-label='Close'>\u00d7</button><b><i style='display:inline-block;width:12px;height:12px;border-radius:50%;margin-right:6px;background:" + CREEPS[t].color + "'></i>New enemy: " + esc(CREEP_INFO[t].name) + "</b>" + esc(CREEP_INFO[t].desc) + "<span class='k'>" + esc(ADVICE[statKey(t)] || "") + "</span>";
  box.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(nextToast, 9000);
}
document.addEventListener("click", e => { if (e.target.id === "toastX") { clearTimeout(toastT); nextToast(); } });

// Best result per seed, map and difficulty, so a seed can be replayed against your own record.
function recordSeed() {
  if (S.custom || inDev() || PUZZLES[levelType]) return null;
  let all = {};
  try { all = JSON.parse(Store.getItem("mtd-seeds") || "{}") || {}; } catch (e) { all = {}; }
  const k = S.seed + "|" + S.map.idx + "|" + difficulty + "|" + levelType, prev = all[k] || null;
  const cur = { wave: S.launched, cleared: !!S.levelDone, lives: S.lives, at: Date.now() };
  const better = !prev || (cur.cleared && !prev.cleared) || (cur.cleared === prev.cleared && (cur.wave > prev.wave || (cur.wave === prev.wave && cur.lives > prev.lives)));
  if (better) all[k] = cur;
  const keys = Object.keys(all); if (keys.length > 60) keys.sort((a, b) => all[a].at - all[b].at).slice(0, keys.length - 60).forEach(x => delete all[x]);
  Store.setItem("mtd-seeds", JSON.stringify(all));
  return { prev, better };
}
function diagnose() {
  const out = [], n = {};
  for (const l of S.leakLog) { const k = statKey(l.type); n[k] = (n[k] || 0) + 1; }
  const top = Object.entries(n).sort((a, b) => b[1] - a[1]).slice(0, 3);
  for (const [k, c] of top) out.push("<b>" + c + " " + (k === "boss" ? "boss" : esc(typeName(k))) + (c > 1 ? " leaks" : " leak") + ".</b> " + esc(ADVICE[k] || ""));
  if (S.over && S.launched <= 9) out.push("<b>Lost early.</b> Spend the starting gold on 6 to 8 cheap towers before wave 1 and shape a long, winding route.");
  if (S.over && S.gold >= 150) out.push("<b>" + Math.floor(S.gold) + " gold was never spent.</b> Gold in the bank does not shoot: build or upgrade as soon as you can.");
  const lw = {}; for (const l of S.leakLog) lw[l.wave] = (lw[l.wave] || 0) + 1;
  const worst = Object.entries(lw).sort((a, b) => b[1] - a[1])[0];
  if (worst && worst[1] >= 3) { const info = waveInfo(+worst[0]); out.push("<b>Wave " + worst[0] + " broke through</b> (" + worst[1] + " leaks" + (info.mod ? ", " + MODS[info.mod].name : "") + (info.boss ? ", boss wave" : "") + ")."); }
  return out;
}
function renderEnd() {
  if (!S || S.endShown || !(S.over || S.levelDone)) return;
  S.endShown = true;
  const rec = recordSeed();
  const won = S.levelDone, kills = Object.values(S.kills).reduce((a, b) => a + b, 0);
  $("endTitle").textContent = won ? "Map cleared" : "Game over";
  let h = "<div class='big'><div><b>" + S.launched + (MAX_WAVES < 9999 ? "/" + MAX_WAVES : "") + "</b><span>waves</span></div><div><b>" + S.lives + "</b><span>lives left</span></div><div><b>" + kills + "</b><span>kills</span></div><div><b>" + S.leaked + "</b><span>leaked</span></div></div>";
  h += "<div class='caption'>Seed <b>" + esc(S.seed) + "</b> on " + esc(S.map.name) + ", " + DIFFICULTY[difficulty].name + "." +
    (rec ? (rec.prev ? (rec.better ? " New best on this seed (was wave " + rec.prev.wave + (rec.prev.cleared ? ", cleared" : "") + ")." : " Your best on this seed: wave " + rec.prev.wave + (rec.prev.cleared ? ", cleared" : "") + ".") : " First run on this seed.") : "") + "</div>";
  if (S.civAwarded && CIV.last) h += "<h3>Civilization</h3><div>+" + CIV.last.sci + " Science, +" + CIV.last.prod + " Production, +" + CIV.last.cul + " Culture.</div>" + nextTechHtml();
  const d = diagnose();
  if (d.length) h += "<h3>" + (won ? "What to tighten" : "Why the run ended") + "</h3><ul>" + d.map(x => "<li>" + x + "</li>").join("") + "</ul>";
  else if (won) h += "<h3>Flawless</h3><div>Nothing got through. Try a harder difficulty or the next map.</div>";
  const best = [...S.towers.values()].filter(t => t.type && TOWERS[t.type].dmg > 0).sort((a, b) => (b.dealt || 0) - (a.dealt || 0))[0];
  if (best && best.dealt) h += "<h3>Best tower</h3><div>" + esc(TOWERS[best.type].name) + " at column " + (best.x + 1) + ", row " + (best.y + 1) + ": " + (best.kills || 0) + " kills, " + Math.round(best.dealt) + " damage.</div>";
  $("endBody").innerHTML = h;
  $("endNext").hidden = !(won && S.map.idx < CUSTOM_IDX - 1 && !PUZZLES[levelType]);
  $("endReplay").hidden = !!(S.custom || PUZZLES[levelType]);
  $("runEnd").hidden = false;
}
function buildEnd() {
  const hide = () => { $("runEnd").hidden = true; };
  $("endClose").addEventListener("click", hide);
  $("runEnd").addEventListener("click", e => { if (e.target === $("runEnd")) hide(); });
  $("endStats").addEventListener("click", () => { hide(); showTab("stats"); });
  $("endCiv").addEventListener("click", () => { hide(); showTab("civ"); });
  $("endRestart").addEventListener("click", () => { hide(); loadMap(S.map.idx); });
  $("endNext").addEventListener("click", () => { hide(); $("nextMapBtn").click(); });
  $("endReplay").addEventListener("click", () => { hide(); const sm = seedMode, sc = seedCustom; seedMode = "custom"; seedCustom = S.seed; loadMap(S.map.idx); seedMode = sm; seedCustom = sc; setMsg("Replaying seed " + S.seed + "."); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("runEnd").hidden) { e.stopPropagation(); hide(); } }, true);
  $("panelClose").addEventListener("click", () => { if (S) { S.inspect = null; refreshUI(); } });
}

function refreshUI() {
  if (!S) return;
  renderTip(); renderEnd();
  // picking a tower to build, or inspecting a tower or creep, brings the Selected tab forward
  $("towerDetail").hidden = !!(S.inspect || S.selCreep);   // inspecting something replaces the build card
  const sk = S.selected + "|" + S.inspect + "|" + (S.selCreep ? S.selCreep.id || "c" : "");
  if (sk !== selKey) { selKey = sk; if (currentTab !== "sel" && !(S.over || S.levelDone)) showTab("sel"); }
  renderPanel();
  renderCreepPanel();
  if (currentTab === "dmg") renderShots();
  renderDetail();
  renderStats();
  $("map").textContent = S.map.name + ".";
  $("mapDesc").textContent = S.map.desc + (S.map.ents.length > 1 ? " Two entrances: each one sends the same creeps at the same time (so a boss wave has two bosses). You get double lives and +50% gold from kills, wave bonuses and starting gold." : "");
  $("gold").textContent = Math.floor(S.gold);
  $("lives").textContent = S.lives;
  $("wave").textContent = S.launched + "/" + (MAX_WAVES >= 9999 ? "\u221e" : MAX_WAVES);
  let timer = "";
  if (paused) timer = "paused";
  else if (S.launched >= MAX_WAVES) timer = "all waves sent";
  else if (S.autoT !== null && !S.over && !S.levelDone) timer = "next wave in " + Math.max(0, Math.ceil(S.autoT)) + " s";
  $("timer").textContent = timer;
  if (S.launched >= MAX_WAVES || S.over || S.levelDone) $("next").innerHTML = "";
  else {
    const n = S.launched + 1, info = waveInfo(n);
    const dot = t => "<i class='dot' style='background:" + CREEPS[t].color + "'></i>";
    const what = info.custom ? (info.custom.map(e => dot(e.type) + e.n + "x " + esc(typeName(e.type))).join(" ") || "empty wave")
      : info.boss ? dot(info.boss) + "<b>BOSS</b> " + esc(CREEP_INFO[info.boss].name)
      : info.kind === "all" ? "all types"
      : info.types.map(t => dot(t) + esc(TYPE_LABEL[t])).join(" + ");
    const tags = (info.mod ? " <b>" + MODS[info.mod].name.toUpperCase() + "</b>" : "") + (info.elite ? " <b>+ELITE " + dot(info.elite) + "</b>" : "");
    const later = [n + 1, n + 2].filter(m => m <= MAX_WAVES).map(m => { const i2 = waveInfo(m); return m + ": " + (i2.boss ? "<b>BOSS</b>" : (i2.custom ? "" : (i2.kind === "all" ? "all" : (i2.types || []).map(t => dot(t)).join(""))) + (i2.mod ? " " + MODS[i2.mod].name.toLowerCase() : "") + (i2.elite ? " +elite" : "")); }).join(" &middot; ");
    $("next").innerHTML = "Next, wave " + n + ": " + what + tags + (later ? " <span style='opacity:.65'>&nbsp;then " + later + "</span>" : "");
    $("next").className = "next" + (info.boss ? " boss" : "");
  }
  const ended = S.over || S.levelDone;
  $("launchBtn").disabled = ended || paused || S.launched >= MAX_WAVES;
  const eb = earlyBonus();
  $("launchBtn").textContent = "Launch wave " + (S.launched + 1) + (eb > 0 ? " (+" + eb + ")" : "");
  $("launchBtn").title = "Launch the next wave now (Space). Skipping the countdown pays " + (S && !ended ? Math.round(earlyRate(S.launched + 1) * 10) / 10 : 0) + " gold per second left.";
  $("launchBtn").style.display = ended ? "none" : ""; $("pauseBtn").style.display = ended ? "none" : ""; $("heatBtn").style.display = ended ? "" : "none";
  $("heatBtn").textContent = S.showHeat ? "Hide heat map" : "Heat map";
  const pb = $("pauseBtn"), label = paused ? "Resume" : "Pause";
  pb.disabled = ended;
  pb.setAttribute("aria-pressed", paused ? "true" : "false");
  if (pb.dataset.s !== label) {
    pb.dataset.s = label;
    const icon = paused
      ? '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M7 4l13 8-13 8z" fill="currentColor"/></svg>'
      : '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 4h4v16H6zM14 4h4v16h-4z" fill="currentColor"/></svg>';
    pb.innerHTML = icon + " " + label;
  }
  $("nextMapBtn").style.display = S.levelDone && S.map.idx < CUSTOM_IDX - 1 && levelType === "campaign" ? "" : "none";
  $("mapSel").value = String(S.map.idx);
  for (const b of document.querySelectorAll("#towerButtons button")) {
    const k = b.dataset.type;
    b.classList.toggle("sel", k === S.selected);
    b.classList.toggle("poor", S.gold < TOWERS[k].cost);
    b.setAttribute("aria-pressed", k === S.selected ? "true" : "false");
  }
  applyLocks();
  renderEraBar();
  renderCiv();
  renderCfgSummary();
}

function loadMap(idx) {
  if (S) civAward(true);   // leaving a run early still pays what it earned
  paused = false;
  showTab("sel");
  const prevSel = S ? S.selected : "pellet";
  const cw = customWaves();
  const puz = PUZZLES[levelType];
  if (puz) idx = puz.map;
  MAX_WAVES = cw ? cw.length : (puz ? puz.waves : levelType === "endless" ? 9999 : levelType === "bossrush" ? 28 : 63);
  S = {
    map: parseMap(MAPS[idx], idx), gold: 0, goldMult: 1, lives: (START_LIVES + (!inDev() && !PUZZLES[levelType] && !cw ? CIVSUM.lives : 0)) * MAPS[idx].flows.length,   // two entrances send twice the creeps, so you get twice the lives
   
    launched: 0, waves: [], queue: [], spawnT: 0, creeps: [], towers: new Map(), fx: [], time: 0, shake: 0, flash: 0, routePaths: [],
    kills: {}, dmgBy: {}, spentBy: {}, leaked: 0, byType: {}, waveInfoCache: {}, custom: customWaves(),
    fields: null, fields8: null, autoT: null, over: false, levelDone: false, inspect: null,
    selected: prevSel, hover: null, selCreep: null, heat: new Array(COLS * ROWS).fill(0), showHeat: true, earlyTotal: 0,
    seed: seedMode === "daily" ? dailySeed() : seedMode === "custom" && seedCustom ? seedCustom : newSeed(), rng: null,
    leakLog: [], endShown: false
  };
  S.rng = mulberry32(hashSeed(S.seed, "sim"));
  S.goldMult = (S.map.ents.length > 1 ? TWO_IN_GOLD : 1) * DIFFICULTY[difficulty].reward;   // two entrances pay more; harder levels pay more per kill
  S.gold = Math.round(START_GOLD * DIFFICULTY[difficulty].gold * S.goldMult * (1 + CB().startGold));
  S.eraStart = eraOn() ? Math.min(3, CB().startEra) : 3; S.era = S.eraStart;   // technologies can start a run in a later era
  if (levelType === "bossrush") S.gold *= 4;   // a bigger purse for a bosses-only run
  if (rules === "fixed") { S.goldMult = 0; S.gold = fixedBudget(idx, difficulty); }
  if (puz) { S.gold = puz.gold; S.puzzle = puz; }   // kills, wave bonuses and early launches pay nothing
  refreshFields();
  if (puz) { for (const [t, x, y] of puz.towers) { if (TOWERS[t] && !S.map.walls.has(key(x, y)) && !isEntry(x, y) && !isExit(x, y)) S.towers.set(key(x, y), { type: t, x, y, cd: 0, level: 1, invested: TOWERS[t].cost, busy: 0, mod: newMod(), lv: newLv(), picks: [], mode: "first", only: "all" }); } refreshFields(); }
  setMsg("Map " + (idx + 1) + ": " + S.map.name + ". Place towers, then launch wave 1. Each wave gives " + AUTO_WAIT + " s before the next one starts. " + MAX_WAVES + " waves in total." + (puz ? " " + puz.text : (levelType === "endless" ? " ENDLESS: waves never stop; survive as long as you can." : (levelType === "bossrush" ? " BOSS RUSH: only bosses, 4x starting gold." : ""))) + (rules === "fixed" ? " FIXED GOLD: this " + S.gold + " gold is all you get for the whole map; kills pay nothing and towers cannot be sold." : (rules === "nosell" ? " BUILD ONLY: towers cannot be sold." : "")));
  refreshUI();
}


// ---------- civilization: eras inside a run, technologies between runs ----------
const ERAS = [
  { name: "Ancient",    short: "I",   color: "#d9a05b" },
  { name: "Medieval",   short: "II",  color: "#7aa2d6" },
  { name: "Industrial", short: "III", color: "#e2b43a" },
  { name: "Modern",     short: "IV",  color: "#62e0c4" }
];
const ERA_WAVES = [1, 19, 37, 55];     // the wave at which each era begins by itself, free
const ERA_COST = [0, 120, 320, 700];   // gold to advance into each era early (scaled by difficulty and entrances)
const ERA_HP = 0.15, ERA_GOLD = 0.20;  // per era you are ahead of schedule: creep health up, kill gold up
const TOWER_ERA = { pellet: 0, frost: 0, splash: 0, flak: 0, wall: 0,
                    sniper: 1, aura: 1, burst: 1, beacon: 1, mine: 1,
                    gatling: 2, tesla: 2, plague: 2, hex: 2, lance: 2,
                    exec: 3, beam: 3 };
let eraMode = true;
try { if (Store.getItem("mtd-era") === "off") eraMode = false; } catch (e) { /* storage can be blocked */ }
function eraOn() { return eraMode && !!S && !inDev() && !S.puzzle && !S.custom && levelType !== "bossrush"; }
function natEra(n) { let e = 0; for (let i = 0; i < ERA_WAVES.length; i++) if (n >= ERA_WAVES[i]) e = i; return Math.max(S.eraStart || 0, e); }
function eraCost(i) { return Math.round(ERA_COST[i] * DIFFICULTY[difficulty].gold * (S.map.ents.length > 1 ? TWO_IN_GOLD : 1) / 10) * 10; }
const eraLocked = k => eraOn() && (TOWER_ERA[k] || 0) > S.era;
function eraBanner(e, early) {
  FX.text(COLS / 2, ROWS / 2 - 1, "ERA: " + ERAS[e].name.toUpperCase(), ERAS[e].color, 2.4, 30);
  FX.ring(COLS / 2, ROWS / 2, 0.5, 7, ERAS[e].color, 0.9);
  const unl = TOWER_KEYS.filter(k => (TOWER_ERA[k] || 0) === e).map(k => TOWERS[k].name).join(", ");
  setMsg((early ? "You advanced to" : "A new era begins:") + " the " + ERAS[e].name + " era. New towers: " + unl + ".");
}
function advanceEra() {
  if (!eraOn() || S.over || S.levelDone || S.era >= 3) return;
  const nx = S.era + 1, cost = eraCost(nx);
  if (S.gold < cost) return setMsg("Not enough gold to advance to the " + ERAS[nx].name + " era (" + cost + "g).");
  S.gold -= cost; S.era = nx;
  eraBanner(nx, true);
  refreshUI();
}
let eraKey = "";
function renderEraBar() {
  const box = $("eraBar");
  if (!box) return;
  if (!eraOn()) { if (!box.hidden) { box.hidden = true; eraKey = ""; } return; }
  box.hidden = false;
  const nx = S.era + 1, ended = S.over || S.levelDone, cost = nx <= 3 ? eraCost(nx) : 0;
  const can = nx <= 3 && !ended && S.gold >= cost;
  const ahead = Math.max(0, S.era - natEra(S.launched + 1));
  const key = [S.era, can, cost, S.launched, ahead, ended].join();
  if (key === eraKey) return; eraKey = key;
  const chips = ERAS.map((e, i) => "<span class='chip" + (i < S.era ? " done" : "") + (i === S.era ? " cur" : "") + "' style='" + (i === S.era ? "background:" + e.color + ";border-color:" + e.color : "") + "'>" + e.short + " " + e.name + "</span>").join("");
  const nat = nx <= 3 ? Math.max(ERA_WAVES[nx], 1) : 0;
  const txt = nx > 3 ? "<b>Final era.</b> All era towers are open."
    : "Next: <b>" + ERAS[nx].name + "</b> (" + TOWER_KEYS.filter(k => (TOWER_ERA[k] || 0) === nx).map(k => TOWERS[k].name).join(", ") + "). Free at wave " + nat + ", or pay now."
      + (ahead ? " <b>Ahead of schedule:</b> creeps +" + Math.round(ERA_HP * ahead * 100) + "% health, kills +" + Math.round(ERA_GOLD * ahead * 100) + "% gold." : "");
  box.innerHTML = "<div class='chips'>" + chips + "</div><div class='et'>" + txt + "</div>" +
    (nx <= 3 ? "<button id='eraBtn'" + (can ? "" : " disabled") + ">Advance (" + cost + "g)</button>" : "");
  const b = $("eraBtn"); if (b) b.addEventListener("click", advanceEra);
}

const BRANCH = {
  sci:  { name: "Science",    color: "#62b6ff", blurb: "earned from waves reached and bosses beaten" },
  prod: { name: "Production", color: "#f0b73a", blurb: "earned from kills" },
  cul:  { name: "Culture",    color: "#d58bff", blurb: "earned from waves where nothing leaked, and map clears" }
};
const TECHS = [
  { id: "archery",  br: "sci", era: 0, name: "Archery",      cost: 10,  req: null,       fx: { dmg: 0.06 },   desc: "+6% damage for every tower." },
  { id: "math",     br: "sci", era: 0, name: "Mathematics",  cost: 25,  req: "archery",  fx: { range: 0.15 }, desc: "+0.15 range for every tower." },
  { id: "metal",    br: "sci", era: 1, name: "Metallurgy",   cost: 45,  req: "math",     unlock: ["aura", "beacon", "wall"], desc: "Unlocks Aura, Beacon and Wall." },
  { id: "machine",  br: "sci", era: 1, name: "Machinery",    cost: 70,  req: "metal",    fx: { rel: 0.08 },   desc: "Every tower reloads 8% faster." },
  { id: "chem",     br: "sci", era: 2, name: "Chemistry",    cost: 100, req: "machine",  unlock: ["plague", "hex", "mine"], desc: "Unlocks Plague, Hex and Mine Layer." },
  { id: "elec",     br: "sci", era: 2, name: "Electricity",  cost: 140, req: "chem",     unlock: ["tesla", "lance"], desc: "Unlocks Tesla and Lance." },
  { id: "computer", br: "sci", era: 3, name: "Computers",    cost: 200, req: "elec",     unlock: ["exec", "beam"], fx: { dmg: 0.06 }, desc: "Unlocks Executioner and Beam, and +6% damage." },

  { id: "pottery",  br: "prod", era: 0, name: "Pottery",     cost: 10,  req: null,       fx: { startGold: 0.10 }, desc: "+10% starting gold." },
  { id: "currency", br: "prod", era: 0, name: "Currency",    cost: 25,  req: "pottery",  fx: { killGold: 0.10 },  desc: "+10% gold from kills." },
  { id: "banking",  br: "prod", era: 1, name: "Banking",     cost: 45,  req: "currency", fx: { sell: 0.05, waveBonus: 0.25 }, desc: "Selling returns +5% more; +25% wave-clear bonus." },
  { id: "industry", br: "prod", era: 2, name: "Industry",    cost: 80,  req: "banking",  fx: { startGold: 0.15, killGold: 0.10 }, desc: "+15% starting gold and +10% gold from kills." },
  { id: "market",   br: "prod", era: 3, name: "Free Market", cost: 140, req: "industry", fx: { killGold: 0.10, early: 0.5 }, desc: "+10% gold from kills; early launch pays 50% more." },

  { id: "feudal",    br: "cul", era: 1, name: "Feudalism",    cost: 30, req: "tradition", group: "gov", fx: { lives: 4, waveBonus: 0.15 }, desc: "Government, pick one: +4 lives and +15% wave-clear bonus." },
  { id: "conscript", br: "cul", era: 1, name: "Conscription", cost: 30, req: "tradition", group: "gov", fx: { dmg: 0.08 }, desc: "Government, pick one: +8% damage for every tower." },
  { id: "mercant",   br: "prod", era: 2, name: "Mercantilism", cost: 60, req: "banking", group: "eco", fx: { killGold: 0.15 }, desc: "Economy, pick one: +15% gold from kills." },
  { id: "fortify",   br: "prod", era: 2, name: "Fortification", cost: 60, req: "banking", group: "eco", fx: { range: 0.2, rel: 0.05 }, desc: "Economy, pick one: +0.2 range and 5% faster reload for every tower." },
  { id: "tradition", br: "cul", era: 0, name: "Tradition",   cost: 8,   req: null,        fx: { lives: 2 }, desc: "+2 lives." },
  { id: "monarchy",  br: "cul", era: 0, name: "Monarchy",    cost: 20,  req: "tradition", fx: { lives: 3 }, desc: "+3 lives." },
  { id: "renaiss",   br: "cul", era: 1, name: "Renaissance", cost: 45,  req: "monarchy",  fx: { startEra: 1 }, desc: "Every run starts in the Medieval era." },
  { id: "revol",     br: "cul", era: 2, name: "Industrial Revolution", cost: 90, req: "renaiss", fx: { startEra: 2, lives: 3 }, desc: "Every run starts in the Industrial era, +3 lives." },
  { id: "globe",     br: "cul", era: 3, name: "Globalization", cost: 150, req: "revol",    fx: { lives: 5, dmg: 0.04 }, desc: "+5 lives and +4% damage." }
];
const CIV_KEY = "mtd-civ";
const CIV = { res: { sci: 0, prod: 0, cul: 0 }, techs: {}, runs: 0, last: null };
try {
  const j = JSON.parse(Store.getItem(CIV_KEY) || "null");
  if (j && typeof j === "object") { if (j.res) Object.assign(CIV.res, j.res); if (j.techs) CIV.techs = j.techs; CIV.runs = j.runs | 0; CIV.last = j.last || null; }
} catch (e) { /* ignore */ }
function saveCiv() { try { Store.setItem(CIV_KEY, JSON.stringify(CIV)); } catch (e) { /* ignore */ } }
const CIVZERO = { dmg: 0, range: 0, rel: 0, startGold: 0, killGold: 0, lives: 0, sell: 0, waveBonus: 0, early: 0, startEra: 0 };
let CIVSUM = CIVZERO;
function recalcCiv() {
  const s = Object.assign({}, CIVZERO);
  for (const t of TECHS) if (CIV.techs[t.id]) for (const [k, v] of Object.entries(t.fx || {})) s[k] = k === "startEra" ? Math.max(s[k], v) : s[k] + v;
  CIVSUM = s;
}
recalcCiv();
const civActive = () => !inDev() && !(S && (S.puzzle || S.custom));   // technologies do not apply in Developer mode, puzzles or custom wave scripts
const CB = () => (civActive() ? CIVSUM : CIVZERO);
const civUnlocked = k => TECHS.some(t => CIV.techs[t.id] && t.unlock && t.unlock.includes(k));
const techFor = k => TECHS.find(t => t.unlock && t.unlock.includes(k));
const rival = t => t.group && TECHS.find(x => x.group === t.group && x.id !== t.id && CIV.techs[x.id]);
function techState(t) {
  if (CIV.techs[t.id]) return "owned";
  if (rival(t)) return "excluded";
  if (t.req && !CIV.techs[t.req]) return "needs";
  return CIV.res[t.br] >= t.cost ? "ready" : "poor";
}
function research(id) {
  const t = TECHS.find(x => x.id === id);
  if (!t || techState(t) !== "ready") return;
  CIV.res[t.br] -= t.cost; CIV.techs[id] = 1;
  saveCiv(); recalcCiv(); lkKey = ""; civKey = ""; panelKey = ""; detailKey = "";
  setMsg("Researched " + t.name + ": " + t.desc);
  refreshUI();
}
const civAwardable = () => !!S && !inDev() && !S.custom && !S.puzzle && levelType !== "bossrush";
// What a run earns. Harder difficulties pay more. Called once when a run ends, or when a run of 3+ waves is abandoned.
function civAward(silent) {
  if (!S || S.civAwarded || !civAwardable() || S.launched < (silent ? 3 : 1)) return "";
  S.civAwarded = true;
  const m = { easy: 1, middle: 1.25, hard: 1.5, extreme: 2 }[difficulty] || 1;
  const kills = Object.values(S.kills).reduce((a, b) => a + b, 0);
  const g = {
    sci: Math.round((S.launched + 5 * (S.bossesDown || 0)) * m),
    prod: Math.round(kills / 25 * m),
    cul: Math.round(((S.perfect || 0) + (S.levelDone ? 10 : 0)) * m)
  };
  for (const k of Object.keys(g)) CIV.res[k] += g[k];
  CIV.runs++; CIV.last = g; saveCiv(); civKey = "";
  return silent ? "" : " Civilization: +" + g.sci + " Science, +" + g.prod + " Production, +" + g.cul + " Culture.";
}
let civKey = "", civReset = false;
function nextTech() {   // the cheapest technology you can research now, or else the closest one
  const open = TECHS.filter(t => techState(t) === "ready").sort((a, b) => a.cost - b.cost);
  if (open.length) return { t: open[0], ready: true };
  const poor = TECHS.filter(t => techState(t) === "poor").sort((a, b) => (a.cost - CIV.res[a.br]) - (b.cost - CIV.res[b.br]));
  return poor.length ? { t: poor[0], ready: false, need: poor[0].cost - CIV.res[poor[0].br] } : null;
}
function nextTechHtml() {
  const n = nextTech(); if (!n) return "";
  return "<div class='caption'>" + (n.ready ? "<b>Ready to research:</b> " + esc(n.t.name) + " (" + n.t.cost + " " + BRANCH[n.t.br].name + ")." : "<b>Next goal:</b> " + esc(n.t.name) + ", " + n.need + " more " + BRANCH[n.t.br].name + ".") + "</div>";
}
function renderCiv() {
  const box = $("civ");
  if (!box) return;
  const key = JSON.stringify(CIV) + civReset + inDev();
  if (key === civKey) return; civKey = key;
  const R = CIV.res;
  let h = "<p class='caption' style='margin-top:0'>Every run earns Science, Production and Culture (more on harder difficulties). Spend them on technologies that stay with you between runs. Technologies marked <b>pick one</b> exclude each other: choose your government and your economy. In the Medieval era and later, bosses gain era abilities (Rally, then Smoke)." + (inDev() ? " <b>Technologies are switched off in Developer mode.</b>" : "") + "</p>" +
    "<div class='res'>" + Object.keys(BRANCH).map(k => "<div><b style='color:" + BRANCH[k].color + "'>" + R[k] + "</b><span>" + BRANCH[k].name + "</span></div>").join("") + "</div>" +
    (CIV.last ? "<div class='caption'>Last run: +" + CIV.last.sci + " Science, +" + CIV.last.prod + " Production, +" + CIV.last.cul + " Culture. Runs so far: " + CIV.runs + ".</div>" : "<div class='caption'>No runs yet. Launch a wave and finish or leave a run to earn resources.</div>");
  for (const br of Object.keys(BRANCH)) {
    h += (br === Object.keys(BRANCH)[0] ? nextTechHtml() : "") + "<h4 style='color:" + BRANCH[br].color + "'>" + BRANCH[br].name + " <span class='caption' style='font-weight:400'>" + BRANCH[br].blurb + "</span></h4>";
    for (const t of TECHS.filter(x => x.br === br)) {
      const st = techState(t), pre = t.req ? TECHS.find(x => x.id === t.req).name : "";
      const label = st === "owned" ? "Researched" : st === "excluded" ? "You chose " + rival(t).name : st === "needs" ? "Needs " + pre : "Research (" + t.cost + ")";
      h += "<div class='tech" + (st === "owned" ? " owned" : "") + "'><div><span class='tn'>" + esc(t.name) + "</span><span class='te'>" + ERAS[t.era].name + "</span></div>" +
        "<button data-tech='" + t.id + "'" + (st === "ready" ? "" : " disabled") + ">" + esc(label) + "</button><div class='td'>" + esc(t.desc) + (st === "poor" ? " Costs " + t.cost + " " + BRANCH[br].name + "." : "") + "</div></div>";
    }
  }
  h += "<div class='acts'><button id='civResetBtn'>" + (civReset ? "Click again to erase technologies" : "Reset civilization") + "</button></div>";
  box.innerHTML = h;
  for (const b of box.querySelectorAll("[data-tech]")) b.addEventListener("click", () => research(b.dataset.tech));
  $("civResetBtn").addEventListener("click", () => {
    if (!civReset) { civReset = true; civKey = ""; renderCiv(); return; }
    CIV.res = { sci: 0, prod: 0, cul: 0 }; CIV.techs = {}; CIV.runs = 0; CIV.last = null; civReset = false;
    saveCiv(); recalcCiv(); lkKey = ""; civKey = ""; panelKey = ""; detailKey = ""; refreshUI();
  });
}
function buildEraSelect() {
  const sel = $("eraSel");
  sel.value = eraMode ? "on" : "off";
  sel.addEventListener("change", () => {
    eraMode = sel.value === "on";
    try { Store.setItem("mtd-era", eraMode ? "on" : "off"); } catch (e) { /* ignore */ }
    eraKey = ""; lkKey = "";
    loadMap(S.map.idx);   // a new era setting starts the map again
  });
}

// ---------- progress and unlocks ----------
// Clearing a map (all 63 waves) on a difficulty is recorded on this device. Clears unlock harder levels, later maps and more towers.
// Developer mode ignores every lock, and Unlock everything in the Unlocks tab opens it all.
const PROG_KEY = "mtd-progress";
const PROG = { clears: {}, all: false };
try { const j = JSON.parse(Store.getItem(PROG_KEY) || "{}"); if (j.clears) PROG.clears = j.clears; PROG.all = !!j.all; } catch (e) { /* storage can be blocked */ }
function saveProg() { try { Store.setItem(PROG_KEY, JSON.stringify(PROG)); } catch (e) { /* ignore */ } }
const DIFF_ORDER = ["easy", "middle", "hard", "extreme"];
const clearList = () => Object.keys(PROG.clears).map(k => { const [m, d] = k.split("|"); return { map: +m, diff: d, rank: DIFF_ORDER.indexOf(d) }; });
const clearedAt = rank => clearList().some(c => c.rank >= rank);   // any map cleared on this difficulty or a harder one
const TOWER_UNLOCK = {   // anything not listed is open from the start: Pellet, Frost, Splash, Sniper, Gatling, Flak, Burst
  aura: { clears: 1 }, beacon: { clears: 2 }, wall: { clears: 2 }, hex: { clears: 3 },
  plague: { diff: "middle" }, tesla: { diff: "middle" },
  mine: { diff: "hard" }, lance: { diff: "hard" }, exec: { diff: "hard" },
  beam: { diff: "extreme" }
};
const inDev = () => { try { return !!devOn; } catch (e) { return false; } };   // devOn is declared further down
const locksOff = () => PROG.all || inDev();
function reqMet(r) { return r.clears ? clearList().length >= r.clears : clearedAt(DIFF_ORDER.indexOf(r.diff)); }
function reqText(r) { return r.clears ? "clear " + r.clears + " map" + (r.clears > 1 ? "s" : "") + " in total, on any difficulty (" + Math.min(clearList().length, r.clears) + "/" + r.clears + ")" : "clear any map on " + DIFFICULTY[r.diff].name + (r.diff === "extreme" ? "" : " or harder"); }
const techLocked = k => !!TOWER_UNLOCK[k] && !reqMet(TOWER_UNLOCK[k]) && !civUnlocked(k);
function towerLocked(k) { return (!locksOff() && techLocked(k)) || eraLocked(k); }
function lockText(k) {   // why a tower is locked, in words
  const parts = [];
  if (!locksOff() && techLocked(k)) { const tf = techFor(k); parts.push(reqText(TOWER_UNLOCK[k]) + (tf ? ", or research " + tf.name + " in the Civilization tab" : "")); }
  if (eraLocked(k)) parts.push("reach the " + ERAS[TOWER_ERA[k] || 0].name + " era (Era bar)");
  return parts.join("; and ");
}
function lockShort(k) { return !locksOff() && techLocked(k) ? "locked" : "Era " + ERAS[TOWER_ERA[k] || 0].short; }
function mapLocked(i) { return !locksOff() && i > 0 && i !== CUSTOM_IDX && !PROG.clears[(i - 1) + "|easy"] && !clearList().some(c => c.map === i - 1); }
const DIFF_REQ = { middle: 0, hard: 1, extreme: 2 };   // needs a clear on the previous difficulty or harder
function diffLocked(d) { return !locksOff() && d in DIFF_REQ && !clearedAt(DIFF_REQ[d]); }
function lockSummary() { const o = []; for (const k of TOWER_KEYS) if (towerLocked(k)) o.push(k); return o; }
function recordClear() {   // called once when a map is cleared
  if (!S || S.custom || inDev() || levelType !== "campaign" || S.map.idx === CUSTOM_IDX) return "";
  const before = new Set(lockSummary()), bd = DIFF_ORDER.filter(diffLocked), bm = MAPS.map((m, i) => mapLocked(i));
  PROG.clears[S.map.idx + "|" + difficulty + (rules !== "standard" ? "|" + rules : "")] = 1; saveProg();
  const gained = [];
  for (const k of before) if (!towerLocked(k)) gained.push(TOWERS[k].name);
  for (const d of bd) if (!diffLocked(d)) gained.push(DIFFICULTY[d].name + " difficulty");
  MAPS.forEach((m, i) => { if (bm[i] && !mapLocked(i)) gained.push("map " + m.name); });
  return gained.length ? " Unlocked: " + gained.join(", ") + "." : "";
}
let unlKey = "", resetArmed = false;
function renderUnlocks() {
  const box = $("unlocks");
  if (!box) return;
  const key = JSON.stringify(PROG) + locksOff() + resetArmed;
  if (key === unlKey) return; unlKey = key;
  const row = (ok, name, req) => "<div class='row'><span class='" + (ok ? "ok" : "no") + "'>" + (ok ? "open" : "locked") + "</span><b>" + esc(name) + "</b>" + (ok ? "" : "<span class='no'>" + esc(req) + "</span>") + "</div>";
  let h = "<p class='caption' style='margin-top:0'>Clear a map (all waves) to unlock harder levels, later maps and more towers. Progress is saved on this device." + (locksOff() ? " Locks are off right now (Developer mode or Unlock everything)." : "") + "</p>";
  h += "<h4>Difficulties</h4>" + DIFF_ORDER.map(d => row(!diffLocked(d), DIFFICULTY[d].name, "clear any map on " + DIFFICULTY[DIFF_ORDER[DIFF_ORDER.indexOf(d) - 1] || "easy"].name + " or harder")).join("");
  h += "<h4>Maps</h4>" + MAPS.map((m, i) => row(!mapLocked(i), (i + 1) + ". " + m.name, "clear map " + i + " on any difficulty")).join("");
  h += "<h4>Towers</h4>" + TOWER_KEYS.map(k => row(!towerLocked(k), TOWERS[k].name, towerLocked(k) ? lockText(k) : "")).join("");
  const cl = clearList().sort((a, b) => a.map - b.map || a.rank - b.rank);
  h += "<h4>Your clears (" + cl.length + ")</h4><div class='caption'>" + (cl.length ? cl.map(c => esc(MAPS[c.map] ? MAPS[c.map].name : "map " + c.map) + " on " + esc(DIFFICULTY[c.diff] ? DIFFICULTY[c.diff].name : c.diff)).join(" · ") : "None yet.") + "</div>";
  h += "<div class='acts'><button id='unlAll'>" + (PROG.all ? "Lock again" : "Unlock everything") + "</button><button id='unlReset'>" + (resetArmed ? "Click again to erase progress" : "Reset progress") + "</button></div>";
  box.innerHTML = h;
  $("unlAll").addEventListener("click", () => { PROG.all = !PROG.all; saveProg(); resetArmed = false; applyLocks(); });
  $("unlReset").addEventListener("click", () => {
    if (!resetArmed) { resetArmed = true; renderUnlocks(); return; }
    PROG.clears = {}; PROG.all = false; resetArmed = false; saveProg(); applyLocks();
    if (S && (mapLocked(S.map.idx) || diffLocked(difficulty))) { difficulty = "easy"; $("diffSel").value = "easy"; loadMap(0); }
  });
}
let lkKey = "";
function applyLocks() {   // dim locked towers, grey out locked maps and difficulties
  if (!$("mapSel").options.length || !$("diffSel").options.length) return;
  const nk = lockSummary().join() + "|" + MAPS.map((m, i) => +mapLocked(i)).join("") + DIFF_ORDER.map(d => +diffLocked(d)).join("") + locksOff();
  if (nk === lkKey) { renderUnlocks(); return; }
  lkKey = nk;
  for (const b of document.querySelectorAll("#towerButtons button")) {
    const k = b.dataset.type, lk = towerLocked(k);
    b.classList.toggle("locked", lk);
    const co = b.querySelector(".co"); if (co) co.textContent = lk ? lockShort(k) : TOWERS[k].cost + "g";
    b.title = lk ? TOWERS[k].name + " is locked: " + lockText(k) + "." : TOWERS[k].name + ": " + TOWERS[k].desc;
  }
  Array.from($("mapSel").options).forEach((o, i) => { const lk = mapLocked(i); o.disabled = lk; o.textContent = (lk ? "[locked] " : "") + (i + 1) + ". " + MAPS[i].name; });
  Array.from($("diffSel").options).forEach(o => { const lk = diffLocked(o.value); o.disabled = lk; o.textContent = (lk ? "[locked] " : "") + DIFFICULTY[o.value].name; });
  renderUnlocks();
}

function buildTowerButtons() {
  const box = $("towerButtons");
  TOWER_KEYS.forEach((k, i) => {
    const def = TOWERS[k];
    const b = document.createElement("button");
    b.className = "tile";
    b.dataset.type = k;
    b.title = def.name + ": " + def.desc;
    b.innerHTML = (i < 10 ? "<i class='kb'>" + (i === 9 ? 0 : i + 1) + "</i>" : "") +
      "<span class='disc'>" + shapeSvg(k, 40, def.color) + "<span style='position:relative;display:grid'>" + iconSvg(k, 20) + "</span></span>" +
      "<span class='nm'>" + def.name + "</span><span class='co'>" + def.cost + "g</span>";
    b.addEventListener("click", () => { if (towerLocked(k)) { setMsg(TOWERS[k].name + " is locked: " + lockText(k) + "."); showTab(eraLocked(k) && !techLocked(k) ? "sel" : "unlocks"); return; } S.selected = k; S.inspect = null; refreshUI(); });
    box.appendChild(b);
  });
}

function buildTowerList() {
  const box = $("towerList");
  for (const k of TOWER_KEYS) {
    const def = TOWERS[k];
    const row = document.createElement("div");
    row.style.margin = "4px 0";
    const where = def.air && def.ground ? "ground and air" : (def.air ? "air only" : "ground only");
    const best = bestOf(k);
    row.innerHTML = iconSvg(k, 18) + " ";
    row.append(document.createTextNode(def.name + " (" + def.cost + "g, " + where + "): " + def.desc + (best ? " Best vs: " + best + "." : "") + " Upgrades cost " + upgradePlan(k).join(", ") + "g."));
    box.appendChild(row);
  }
}

// Table: which creep kinds each tower can hit.
const SHORT_NAME = { splitling: "Split", spawner: "Spawn", bossNormal: "Normal", bossFast: "Fast", bossSquad: "Group", bossGroup: "Group", bossFlyer: "Air", bossAir: "Air", bossTough: "Tough", bossDecoy: "Decoy", bossSpawner: "Spawn" };
function buildMatrix() {
  const box = $("matrix");
  const intro = document.createElement("b");
  intro.textContent = "Damage each tower does to each creep type, as a share of its full damage. Green is its best matchup, orange is weak.";
  box.appendChild(intro);
  const kinds = Object.keys(CREEP_INFO);
  box.appendChild(matrixTable(kinds.filter(k => !CREEPS[k].boss)));
  const note = document.createElement("div");
  note.style.margin = "12px 0 0";
  note.textContent = "Bosses take the average of their creep type's damage and each tower's boss damage:";
  box.appendChild(note);
  box.appendChild(matrixTable(kinds.filter(k => CREEPS[k].boss)));
}

function matrixTable(kinds) {
  const table = document.createElement("table");
  const head = document.createElement("tr");
  const th0 = document.createElement("th"); th0.textContent = "Tower"; th0.style.textAlign = "left";
  head.appendChild(th0);
  for (const k of kinds) {
    const th = document.createElement("th"); th.textContent = SHORT_NAME[k] || CREEP_INFO[k].name; th.title = CREEP_INFO[k].name;
    head.appendChild(th);
  }
  table.appendChild(head);
  for (const tk of TOWER_KEYS) {
    const def = TOWERS[tk];
    const tr = document.createElement("tr");
    const td0 = document.createElement("td"); td0.textContent = def.name;
    tr.appendChild(td0);
    for (const k of kinds) {
      const hit = canHit(def, { flying: !!CREEPS[k].flying });
      const td = document.createElement("td");
      const mult = effOf(tk, k);
      td.textContent = !hit ? "✗" : (def.dmg > 0 ? Math.round(mult * 100) + "%" : "✓");
      td.style.textAlign = "center";
      td.className = !hit ? "no" : (mult >= 1 ? "full" : (mult >= 0.66 ? "mid" : "part"));
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  return table;
}

let shotsWave = 0;   // 0 = follow the next wave
function shotsHp(type, n) {
  return Math.max(1, Math.round(CREEPS[type].hp * HP_START * S.map.hpMult * DIFFICULTY[difficulty].mult * (1 + HP_GROWTH * (n - 1))));
}
function renderShots() {
  const box = $("shots");
  if (!box || !S) return;
  const next = Math.min(MAX_WAVES, S.launched + 1), n = shotsWave || next;
  const key = n + "|" + difficulty + "|" + S.map.hpMult + "|" + (shotsWave ? 1 : 0);
  if (box.dataset.key === key && box.querySelector("table")) return;
  box.dataset.key = key;
  box.textContent = "";
  const head = document.createElement("div");
  head.style.cssText = "margin:16px 0 4px";
  const b = document.createElement("b");
  b.textContent = "Shots to kill one creep (level-1 tower, no upgrades) at wave ";
  const inp = document.createElement("input");
  inp.type = "number"; inp.min = 1; inp.max = MAX_WAVES; inp.value = n; inp.style.cssText = "width:56px";
  inp.addEventListener("change", () => { shotsWave = Math.max(1, Math.min(MAX_WAVES, +inp.value || 1)); box.dataset.key = ""; renderShots(); });
  const nx = document.createElement("button");
  nx.textContent = "follow next wave"; nx.style.marginLeft = "8px";
  nx.addEventListener("click", () => { shotsWave = 0; box.dataset.key = ""; renderShots(); });
  head.append(b, inp, nx);
  box.appendChild(head);
  const allKinds = Object.keys(CREEP_INFO);
  const mk = kinds => {
    const table = document.createElement("table");
    const tr0 = document.createElement("tr");
    const h0 = document.createElement("th"); h0.textContent = "Tower"; h0.style.textAlign = "left"; tr0.appendChild(h0);
    for (const k of kinds) { const th = document.createElement("th"); th.textContent = SHORT_NAME[k] || CREEP_INFO[k].name; th.title = CREEP_INFO[k].name; tr0.appendChild(th); }
    table.appendChild(tr0);
    const hr = document.createElement("tr");
    const hl = document.createElement("td"); hl.textContent = "Health"; hl.style.fontWeight = "600"; hr.appendChild(hl);
    for (const k of kinds) { const td = document.createElement("td"); td.textContent = shotsHp(k, n); td.style.textAlign = "center"; hr.appendChild(td); }
    table.appendChild(hr);
    for (const tk of TOWER_KEYS) {
      const def = TOWERS[tk];
      if (!(def.dmg > 0) || tk === "exec" || tk === "beam") continue;
      const st = towerStats({ type: tk }, newMod());
      const mulT = tk === "plague" ? def.duration : 1;
      const tr = document.createElement("tr");
      const td0 = document.createElement("td"); td0.textContent = def.name + (mulT > 1 ? " *" : ""); tr.appendChild(td0);
      for (const k of kinds) {
        const td = document.createElement("td"); td.style.textAlign = "center";
        if (!canHit(def, { flying: !!CREEPS[k].flying })) { td.textContent = "✗"; td.className = "no"; }
        else {
          const per = st.dmg * effOf(tk, k) * mulT;
          const shots = per > 0 ? Math.ceil(shotsHp(k, n) / per) : Infinity;
          td.textContent = isFinite(shots) ? shots : "∞";
          td.className = shots <= 3 ? "full" : (shots <= 10 ? "mid" : "part");
        }
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    return table;
  };
  box.appendChild(mk(allKinds.filter(k => !CREEPS[k].boss)));
  const bn = document.createElement("div"); bn.style.cssText = "margin:10px 0 0;font-size:12px"; bn.textContent = "Bosses:"; box.appendChild(bn);
  box.appendChild(mk(allKinds.filter(k => CREEPS[k].boss)));
  const note = document.createElement("div");
  note.style.cssText = "margin-top:6px;font-size:12px";
  note.textContent = "Follows difficulty and map. * Plague counts the whole damage-over-time (its infection time) as one shot. Splash and Mine Layer count the direct hit; Executioner (percent of current health) and Beam (ramps up) are not listed; towers also gain damage from upgrades and beacons.";
  box.appendChild(note);
}

for (const [k, v] of Object.entries(BOSS_ABILITY)) CREEP_INFO[k].desc += " " + v[1];
function buildCreepList() {
  const box = $("creepList");
  const mh = document.createElement("div");
  mh.style.margin = "0 0 8px";
  mh.innerHTML = "<b>Wave modifiers</b> (from wave 10, about 1 wave in 3; shown in the preview above the board): " + Object.values(MODS).map(m => "<b>" + m.name + "</b>: " + m.desc).join("; ") + ". <b>Elite</b> creeps (waves 4 and 7 of each block, from wave 10): one creep with 8x health and 6x gold, ringed in gold.";
  box.appendChild(mh);
  for (const k of Object.keys(CREEP_INFO)) {
    const row = document.createElement("div");
    row.style.margin = "4px 0";
    row.textContent = CREEP_INFO[k].name + ": " + CREEP_INFO[k].desc;
    box.appendChild(row);
  }
  const note = document.createElement("div");
  note.style.margin = "8px 0 0";
  note.textContent = "Corners: when a ground creep turns 90 degrees or more it slows for half a second. Gentle diagonal bends do not slow it.";
  box.appendChild(note);
}

function buildMapSelect() {
  const sel = $("mapSel");
  MAPS.forEach((m, i) => {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = (i + 1) + ". " + m.name;
    sel.appendChild(o);
  });
  sel.addEventListener("change", () => { const i = parseInt(sel.value, 10); if (mapLocked(i)) { setMsg("Map " + (i + 1) + " is locked: clear map " + i + " first."); sel.value = String(S.map.idx); return; }
    if (PUZZLES[levelType]) { levelType = "campaign"; $("typeSel").value = "campaign"; }
    loadMap(i); });
}

function buildModeSelect() {
  const sel = $("modeSel");
  let saved = "extended";
  try { saved = Store.getItem("mtd-mode") || "extended"; } catch (e) { /* storage can be blocked */ }
  const setMode = v => {
    extended = v !== "normal";
    sel.value = v;
    setDevMode(v === "dev");
    applyDev();
    rebuildGuides();
  };
  setMode(saved);
  sel.addEventListener("change", () => {
    try { Store.setItem("mtd-mode", sel.value); } catch (e) { /* ignore */ }
    setMode(sel.value);
    loadMap(S.map.idx);   // a new mode starts the map again
  });
}

// ---------- map editor and layout codes ----------
const ED_CHARS = { "#": ["Wall", "#2f5782"], ".": ["Open", "#123a61"], m: ["Mud", "#96642f"], r: ["Road", "#9fb7cf"], x: ["No build", "#0b2540"], P: ["Portal A", "#c084fc"], Q: ["Portal B", "#a855f7"], I: ["Entrance", "#3ccf9a"], O: ["Exit", "#ff7a6b"] };
let edRows = null, edBrush = "#", edMsg = "";
function edDefault() { return emptyRows([LEFT], [RIGHT]).map(r => r.split("")); }
function mapCode() { return "MTD1:" + btoa(edRows.map(r => r.join("")).join("")); }
function parseMapCode(code) {
  const m = /^MTD1:([A-Za-z0-9+\/=]+)$/.exec(code.trim());
  if (!m) return null;
  let raw; try { raw = atob(m[1]); } catch (e) { return null; }
  if (raw.length !== COLS * ROWS || /[^#.mrxPQIOBg]/.test(raw.replace(/[ST]/g, ""))) return null;
  return Array.from({ length: ROWS }, (_, y) => raw.slice(y * COLS, (y + 1) * COLS).split(""));
}
function edToDef() {
  const ins = [], outs = [];
  edRows.forEach((r, y) => r.forEach((ch, x) => { if (ch === "I") ins.push([x, y]); if (ch === "O") outs.push([x, y]); }));
  if (!ins.length || !outs.length) return { error: "Place at least one entrance (I) and one exit (O)." };
  if (ins.length > 2 || outs.length > 2) return { error: "Use at most 2 entrances and 2 exits." };
  return { name: "Custom (editor)", desc: "Your own map.", flows: ins.map(i => ({ from: i, to: outs })), rows: edRows.map(r => r.join("")) };
}
function renderEditor() {
  const box = $("editor");
  if (!box) return;
  if (!edRows) edRows = edDefault();
  let h = "<p class='caption' style='margin-top:0'>Paint a map, then press Play. Creeps from every entrance head for the nearest exit. Share the code to give the map to someone else.</p><div class='pal'>" +
    Object.entries(ED_CHARS).map(([ch, [n, col]]) => "<button data-brush='" + ch + "' aria-pressed='" + (ch === edBrush) + "'><i style='display:inline-block;width:10px;height:10px;background:" + col + ";margin-right:4px'></i>" + n + "</button>").join("") + "</div><div class='edgrid' id='edgrid'>";
  edRows.forEach((r, y) => r.forEach((ch, x) => { const [n, col] = ED_CHARS[ch] || ED_CHARS["."]; h += "<div class='edc' data-x='" + x + "' data-y='" + y + "' style='background:" + col + "'>" + (ch === "I" ? "IN" : ch === "O" ? "OUT" : ch === "P" ? "A" : ch === "Q" ? "B" : ch === "x" ? "\u00d7" : "") + "</div>"; }));
  h += "</div><div class='acts'><button id='edPlay'>Play this map</button><button id='edCode'>Show code</button><button id='edLoad'>Load code</button><button id='edReset'>Reset</button></div><textarea id='edText' placeholder='share code: press Show code, or paste one here and press Load code'></textarea><div class='caption' id='edMsg'>" + esc(edMsg) + "</div>" +
    "<h4>Tower layouts</h4><p class='caption' style='margin:0'>Save the towers on the current map as a code or in this browser, and load them back on any map (places what you can afford, in order).</p><div class='acts'><button id='lySave'>Save layout code</button><button id='lyLoad'>Load layout code</button><select id='lySlot'><option value='1'>Slot 1</option><option value='2'>Slot 2</option><option value='3'>Slot 3</option></select><button id='lySlotSave'>Save to slot</button><button id='lySlotLoad'>Load from slot</button></div><textarea id='lyText' placeholder='layout code'></textarea>";
  box.innerHTML = h;
  for (const b of box.querySelectorAll("[data-brush]")) b.addEventListener("click", () => { edBrush = b.dataset.brush; for (const o of box.querySelectorAll("[data-brush]")) o.setAttribute("aria-pressed", o.dataset.brush === edBrush); });
  const paint = e => {
    const t = document.elementFromPoint(e.clientX, e.clientY);
    if (!t || !t.classList.contains("edc")) return;
    const x = +t.dataset.x, y = +t.dataset.y;
    if (edRows[y][x] === edBrush) return;
    if ((edBrush === "P" || edBrush === "Q")) for (const r of edRows) for (let i = 0; i < r.length; i++) if (r[i] === edBrush) r[i] = ".";   // one cell per portal end
    edRows[y][x] = edBrush;
    const [n, col] = ED_CHARS[edBrush]; t.style.background = col; t.textContent = edBrush === "I" ? "IN" : edBrush === "O" ? "OUT" : edBrush === "P" ? "A" : edBrush === "Q" ? "B" : edBrush === "x" ? "\u00d7" : "";
    if (edBrush === "P" || edBrush === "Q") renderEditor();
  };
  let down = false; const g = $("edgrid");
  g.addEventListener("pointerdown", e => { down = true; paint(e); });
  g.addEventListener("pointermove", e => { if (down) paint(e); });
  window.addEventListener("pointerup", () => { down = false; });
  const say = m => { edMsg = m; $("edMsg").textContent = m; };
  $("edCode").addEventListener("click", () => { $("edText").value = mapCode(); say("Copy this code to share the map."); });
  $("edLoad").addEventListener("click", () => { const r = parseMapCode($("edText").value); if (!r) return say("That is not a valid map code."); edRows = r; renderEditor(); edMsg = "Map loaded. Press Play."; $("edMsg").textContent = edMsg; });
  $("edReset").addEventListener("click", () => { edRows = edDefault(); edMsg = ""; renderEditor(); });
  $("edPlay").addEventListener("click", () => {
    const def = edToDef();
    if (def.error) return say(def.error);
    MAPS[CUSTOM_IDX] = def;
    levelType = "campaign"; $("typeSel").value = "campaign";
    loadMap(CUSTOM_IDX);
    const f = computeFields(M_STRICT);
    if (S.map.ents.some(e => e.exits.some(j => f[j][e.y][e.x] === Infinity))) { loadMap(0); return say("There is no route from an entrance to an exit. Open a path and try again."); }
    $("mapSel").value = String(CUSTOM_IDX);
    $("mapSel").options[CUSTOM_IDX].textContent = (CUSTOM_IDX + 1) + ". " + def.name;
    showTab("sel"); say("Playing your map.");
  });
  const layout = () => { const arr = []; for (const t of S.towers.values()) if (t.type) arr.push([t.type, t.x, t.y, t.level, lvOf(t)]); return "TDL1:" + btoa(JSON.stringify(arr)); };
  const applyLayout = code => {
    let arr; try { const m = /^TDL1:(.+)$/.exec(code.trim()); arr = JSON.parse(atob(m[1])); } catch (e) { return say("That is not a valid layout code."); }
    if (!Array.isArray(arr)) return say("That is not a valid layout code.");
    let placed = 0, skipped = 0;
    arr.sort((a, b) => (TOWERS[a[0]] ? TOWERS[a[0]].cost : 0) - (TOWERS[b[0]] ? TOWERS[b[0]].cost : 0) || a[3] - b[3]);
    for (const [type, x, y, lv, lvs] of arr) {
      if (!TOWERS[type] || towerLocked(type) || !inBounds(x, y) || S.towers.has(key(x, y)) || !canPlace(x, y) || S.gold < TOWERS[type].cost) { skipped++; continue; }
      S.selected = type; placeTower(x, y); placed++;
      const t = S.towers.get(key(x, y));
      if (t && extended) {   // saved per-stat levels (older codes only know the total, so those go into damage)
        const want = lvs && typeof lvs === "object" ? lvs : { dmg: Math.max(0, (lv || 1) - 1), rng: 0, rel: 0 };
        for (const c of STAT_KEYS) for (let i = 0; i < Math.min(MAX_STAT, want[c] | 0); i++) { t.busy = 0; if (!statMaxed(t, c) && canUpgrade(t, c) && S.gold >= upgradeCost(t, c)) upgradeTower(key(x, y), c); else break; }
      } else for (let i = 1; t && i < (lv || 1); i++) { t.busy = 0; if (S.gold >= upgradeCost(t)) upgradeTower(key(x, y), "std"); else break; }
      if (t) t.busy = 0;
    }
    refreshUI(); say("Layout loaded: " + placed + " towers placed" + (skipped ? ", " + skipped + " skipped (gold, locked, or no room)" : "") + ".");
  };
  $("lySave").addEventListener("click", () => { $("lyText").value = layout(); say("Layout code created (" + S.towers.size + " towers)."); });
  $("lyLoad").addEventListener("click", () => applyLayout($("lyText").value));
  $("lySlotSave").addEventListener("click", () => { try { Store.setItem("mtd-layout-" + $("lySlot").value, layout()); say("Saved to slot " + $("lySlot").value + "."); } catch (e) { say("Could not save in this browser."); } });
  $("lySlotLoad").addEventListener("click", () => { let c = null; try { c = Store.getItem("mtd-layout-" + $("lySlot").value); } catch (e) { /* ignore */ } if (!c) return say("That slot is empty."); applyLayout(c); });
}
function buildEditor() { renderEditor(); }
function buildTypeSelect() {
  const sel = $("typeSel");
  sel.addEventListener("change", () => { levelType = sel.value; loadMap(PUZZLES[levelType] ? PUZZLES[levelType].map : S.map.idx); });
}
function buildRulesSelect() {
  const sel = $("rulesSel");
  try { const v = Store.getItem("mtd-rules"); if (v === "nosell" || v === "fixed") rules = v; } catch (e) { /* ignore */ }
  sel.value = rules;
  sel.addEventListener("change", () => {
    rules = sel.value;
    try { Store.setItem("mtd-rules", rules); } catch (e) { /* ignore */ }
    loadMap(S.map.idx);
  });
}

function buildDiffSelect() {
  const sel = $("diffSel");
  for (const [k, d] of Object.entries(DIFFICULTY)) {
    const o = document.createElement("option");
    o.value = k; o.textContent = d.name;
    sel.appendChild(o);
  }
  sel.value = difficulty;
  sel.title = "Middle: creeps +65% health, towers +5% damage and fire rate, +10% gold. Hard: +165% health, towers +6%, +25% start gold, +50% kill gold. Extreme: +260% health, towers +12%, +50% start gold, 2x kill gold.";
  sel.addEventListener("change", () => {
    if (diffLocked(sel.value)) { setMsg(DIFFICULTY[sel.value].name + " is locked: clear any map on " + DIFFICULTY[DIFF_ORDER[DIFF_ORDER.indexOf(sel.value) - 1]].name + " or harder first."); sel.value = difficulty; return; }
    difficulty = sel.value;
    loadMap(S.map.idx);   // a new difficulty starts the map again
  });
}

function cellFromEvent(e) {
  const r = canvas.getBoundingClientRect();
  const fx = (e.clientX - r.left) * (BW / r.width) / CS;
  const fy = (e.clientY - r.top) * (BH / r.height) / CS;
  const x = Math.floor(fx), y = Math.floor(fy);
  if (!inBounds(x, y)) return null;
  return { x, y, fx, fy };
}

// The creep under the pointer, if any.
function creepAt(c) {
  let best = null, bd = Infinity;
  for (const cr of S.creeps) {
    if (cr.dead) continue;
    const d = Math.hypot(cr.x - c.fx, cr.y - c.fy);
    if (d <= cr.r + 0.25 && d < bd) { bd = d; best = cr; }
  }
  return best;
}

function selectOrPlace(c) {
  const cr = creepAt(c);
  if (cr) { S.selCreep = cr; S.inspect = null; refreshUI(); return; }
  S.selCreep = null;
  const k = key(c.x, c.y);
  if (S.towers.has(k)) {
    S.inspect = S.towers.get(k).type ? k : null;
    refreshUI();
    return;
  }
  S.inspect = null;
  placeTower(c.x, c.y);
}

canvas.addEventListener("mousemove", e => { if (S) S.hover = cellFromEvent(e); });
canvas.addEventListener("mouseleave", () => { if (S) S.hover = null; });
canvas.addEventListener("click", e => {
  if (!S || S.over || S.levelDone) return;
  const c = cellFromEvent(e); if (c) selectOrPlace(c);
});
canvas.addEventListener("contextmenu", e => {
  e.preventDefault();
  const c = cellFromEvent(e); if (c) sellTower(c.x, c.y);
});

// touch: a tap on an empty cell previews the tower and its range; tapping the same cell again places it.
// Tapping a tower or a creep inspects it; a long press (about 0.5 s) sells.
let pressTimer = null, longPressed = false, pending = null, touchMoved = false;
canvas.addEventListener("touchstart", e => {
  const c = cellFromEvent(e.touches[0]);
  longPressed = false; touchMoved = false;
  pressTimer = setTimeout(() => { longPressed = true; if (c) { sellTower(c.x, c.y); pending = null; if (S) S.hover = null; } }, 500);
}, { passive: true });
canvas.addEventListener("touchmove", () => { touchMoved = true; clearTimeout(pressTimer); }, { passive: true });
canvas.addEventListener("touchend", e => {
  clearTimeout(pressTimer);
  e.preventDefault();   // no extra mouse click after a tap
  if (longPressed || touchMoved || !S || S.over || S.levelDone) return;
  const c = cellFromEvent(e.changedTouches[0]);
  if (!c) return;
  const k = key(c.x, c.y);
  const empty = !creepAt(c) && !S.towers.has(k) && !isWall(c.x, c.y);
  if (empty && !(pending && pending.x === c.x && pending.y === c.y)) {   // first tap: preview
    pending = { x: c.x, y: c.y }; S.hover = pending; S.selCreep = null; S.inspect = null;
    setMsg("Tap again to place " + TOWERS[S.selected].name + ", or tap elsewhere to cancel."); refreshUI();
    return;
  }
  pending = null; S.hover = null;
  const nT = S.towers.size;
  selectOrPlace(c);
  try { if (S.towers.size !== nT && navigator.vibrate) navigator.vibrate(12); } catch (e) {}   // a small buzz when a tower is placed
}, { passive: false });
// picking another tower or tapping a button cancels a pending preview
document.addEventListener("click", e => { if (pending && !e.target.closest("canvas")) { pending = null; if (S) S.hover = null; } });

document.addEventListener("keydown", e => {
  if (!S) return;
  const n = e.key === "0" ? 10 : parseInt(e.key, 10);
  if (n >= 1 && n <= Math.min(10, TOWER_KEYS.length)) { if (towerLocked(TOWER_KEYS[n - 1])) return setMsg(TOWERS[TOWER_KEYS[n - 1]].name + " is locked: " + lockText(TOWER_KEYS[n - 1]) + "."); S.selected = TOWER_KEYS[n - 1]; S.inspect = null; refreshUI(); }
  if (S.inspect) { const k = extended ? { u: "dmg", i: "rng", o: "rel" }[e.key.toLowerCase()] : (e.key.toLowerCase() === "u" ? "std" : null); if (k) upgradeTower(S.inspect, k); }
  if (e.key === "Escape") { S.inspect = null; refreshUI(); }
  if (e.key === "p" || e.key === "P") togglePause();
  if (e.key === " ") { e.preventDefault(); launchEarly(); }
  if ((e.key === "h" || e.key === "H") && S && (S.over || S.levelDone)) { S.showHeat = !S.showHeat; }
});
$("launchBtn").addEventListener("click", launchEarly);
$("heatBtn").addEventListener("click", () => { if (S) S.showHeat = !S.showHeat; });
$("pauseBtn").addEventListener("click", togglePause);
function setSpeed(v) {
  gameSpeed = v;
  $("speedBtn").textContent = "Speed " + v + "x";
  $("speedBtn").setAttribute("aria-pressed", v > 1 ? "true" : "false");
}
$("speedBtn").addEventListener("click", () => setSpeed(gameSpeed % 3 + 1));
document.addEventListener("keydown", e => { if (e.key === "f" || e.key === "F") setSpeed(gameSpeed % 3 + 1); });
(function () {
  const sel = $("spawnSel");
  try { const v = parseInt(Store.getItem("mtd-spawn"), 10); if (v >= 1 && v <= 4) spawners = v; } catch (e) { /* ignore */ }
  sel.value = String(spawners);
  sel.addEventListener("change", () => {
    spawners = parseInt(sel.value, 10);
    try { Store.setItem("mtd-spawn", String(spawners)); } catch (e) { /* ignore */ }
    loadMap(S.map.idx);   // a new spawner count starts the map again
  });
})();
function refreshSoundBtn() {
  $("soundBtn").textContent = Sound.enabled() ? "Sound on" : "Sound off";
  $("soundBtn").setAttribute("aria-pressed", Sound.enabled() ? "true" : "false");
}
$("soundBtn").addEventListener("click", () => { Sound.setEnabled(!Sound.enabled()); refreshSoundBtn(); });
document.addEventListener("pointerdown", () => Sound.unlock());
document.addEventListener("keydown", () => Sound.unlock());
refreshSoundBtn();
$("restartBtn").addEventListener("click", () => loadMap(S.map.idx));
$("nextMapBtn").addEventListener("click", () => loadMap(Math.min(CUSTOM_IDX - 1, S.map.idx + 1)));
document.addEventListener("click", e => {
  const up = e.target.closest("[data-up]");
  if (up && S.inspect) { upgradeTower(S.inspect, up.dataset.up); return; }
  const on = e.target.closest("[data-only]");
  if (on) {
    const t = S.inspect && S.towers.get(S.inspect);
    if (on.closest("#modeRow")) { if (t && t.level === 1) { t.only = on.dataset.only; panelKey = ""; refreshUI(); } }
    else if (on.closest("#towerDetail")) { buildOnly = on.dataset.only; detailKey = ""; refreshUI(); }
    return;
  }
  const md = e.target.closest("[data-mode]");
  if (!md) return;
  const t = S.inspect && S.towers.get(S.inspect);
  if (md.closest("#modeRow")) {
    if (t && t.level === 1) { t.mode = md.dataset.mode; panelKey = ""; refreshUI(); }
  } else if (md.closest("#towerDetail")) { buildMode = md.dataset.mode; detailKey = ""; refreshUI(); }
});
$("sellBtn").addEventListener("click", () => {
  if (!S.inspect) return;
  const [x, y] = S.inspect.split(",").map(Number);
  sellTower(x, y);
});

// ---------- developer mode ----------
// Edit tower, creep and damage numbers, game settings and a wave script, then press Run to restart the map with them.
let devOn = false;
const DEF = {   // untouched copies, so edits can always be undone
  towers: JSON.parse(JSON.stringify(TOWERS)),
  creeps: JSON.parse(JSON.stringify(CREEPS)),
  vs: JSON.parse(JSON.stringify(VS)),
  game: { startGold: START_GOLD, lives: START_LIVES, hpStart: HP_START, hpGrowth: HP_GROWTH, autoWait: AUTO_WAIT, sellRate: SELL_RATE }
};
const emptyDev = () => ({ towers: {}, creeps: {}, vs: {}, game: {}, waves: "", useWaves: false });
let DEV = emptyDev();
try { const j = JSON.parse(Store.getItem("mtd-dev") || "null"); if (j && typeof j === "object") DEV = Object.assign(emptyDev(), j); } catch (e) { /* ignore */ }
const saveDev = () => { try { Store.setItem("mtd-dev", JSON.stringify(DEV)); } catch (e) { /* ignore */ } };
const TOWER_FIELDS = [["cost", "Price"], ["dmg", "Damage"], ["range", "Range"], ["cd", "Reload (s)"], ["radius", "Blast radius"], ["slow", "Slow factor"], ["buff", "Damage buff"], ["speed", "Reload buff"], ["chain", "Chain jumps"], ["arcs", "Arcs"], ["duration", "Infection (s)"]];
const CREEP_FIELDS = [["hp", "Health"], ["speed", "Speed (cells/s)"], ["reward", "Gold reward"], ["r", "Size"]];

function applyDev() {   // put the defaults back, then lay the edits over them (only in Developer mode)
  for (const k of Object.keys(DEF.towers)) Object.assign(TOWERS[k], DEF.towers[k]);
  for (const k of Object.keys(DEF.creeps)) Object.assign(CREEPS[k], DEF.creeps[k]);
  for (const k of Object.keys(DEF.vs)) Object.assign(VS[k], DEF.vs[k]);
  let g = DEF.game;
  if (devOn) {
    for (const [k, o] of Object.entries(DEV.towers)) if (TOWERS[k]) Object.assign(TOWERS[k], o);
    for (const [k, o] of Object.entries(DEV.creeps)) if (CREEPS[k]) Object.assign(CREEPS[k], o);
    for (const [k, o] of Object.entries(DEV.vs)) if (VS[k]) Object.assign(VS[k], o);
    g = Object.assign({}, DEF.game, DEV.game);
  }
  START_GOLD = g.startGold; START_LIVES = g.lives; HP_START = g.hpStart; HP_GROWTH = g.hpGrowth; AUTO_WAIT = g.autoWait; SELL_RATE = g.sellRate;
}

// Wave script: one line per wave, like "normal:8, fast:4". Returns { waves } or { error }.
function parseWaves(text) {
  const waves = [];
  const lines = String(text || "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/#.*/, "").trim();
    if (!line) continue;
    const list = [];
    for (const part of line.split(",")) {
      const m = part.trim().match(/^([a-zA-Z]+)\s*[:x* ]?\s*(\d+)$/);
      if (!m) return { error: "Line " + (i + 1) + ": cannot read \"" + part.trim() + "\". Use type:count, for example normal:8" };
      let type = m[1];
      const alias = { group: "squad", air: "flyer" };
      type = alias[type.toLowerCase()] || Object.keys(CREEPS).find(k => k.toLowerCase() === type.toLowerCase());
      if (!type) return { error: "Line " + (i + 1) + ": unknown creep type \"" + m[1] + "\"" };
      list.push({ type, n: Math.min(500, parseInt(m[2], 10)) });
    }
    waves.push(list);
  }
  if (!waves.length) return { error: "The script has no waves." };
  return { waves };
}
function customWaves() {
  if (!devOn || !DEV.useWaves) return null;
  const r = parseWaves(DEV.waves);
  return r.waves || null;
}

function rebuildGuides() {   // the tower buttons and guides show numbers, so they follow edits
  for (const id of ["towerButtons", "towerList", "matrix", "creepList"]) $(id).innerHTML = "";
  buildTowerButtons(); buildTowerList(); buildMatrix(); buildCreepList();
  panelKey = ""; detailKey = ""; $("shots").dataset.key = ""; lkKey = ""; if (S) applyLocks();
}
function runDev() {
  saveDev();
  applyDev();
  rebuildGuides();
  loadMap(S.map.idx);
  const cw = customWaves();
  setMsg("Developer run started" + (cw ? " with a custom script of " + cw.length + " waves." : " (built-in waves with your tower, creep and game edits)."));
}

let devSub = "towers", devTower = TOWER_KEYS[0], devCreep = "normal";
const numOr = (v, d) => (v === "" || isNaN(parseFloat(v)) ? d : parseFloat(v));
function devField(group, key, field, label, def) {   // one number box; blue when it differs from the default
  const cur = (DEV[group][key] || {})[field];
  const val = cur === undefined ? def : cur;
  return "<label>" + label + "<input type='number' step='any' data-g='" + group + "' data-k='" + key + "' data-f='" + field + "' data-def='" + def + "' value='" + val + "'" + (val !== def ? " class='chg'" : "") + "></label>";
}
function renderDev() {
  const box = $("devPane");
  const subs = [["towers", "Towers"], ["creeps", "Creeps"], ["vs", "Damage %"], ["waves", "Waves"], ["game", "Game"]];
  let body = "";
  if (devSub === "towers") {
    const d = DEF.towers[devTower];
    body = "<label class='modelab'>Tower <select data-pick='tower'>" + TOWER_KEYS.map(k => "<option value='" + k + "'" + (k === devTower ? " selected" : "") + ">" + DEF.towers[k].name + "</option>").join("") + "</select></label><div class='devgrid'>" +
      TOWER_FIELDS.filter(([f]) => d[f] !== undefined).map(([f, l]) => devField("towers", devTower, f, l, d[f])).join("") +
      ["air", "ground"].map(f => { const cur = (DEV.towers[devTower] || {})[f]; const v = cur === undefined ? d[f] : cur;
        return "<label class='chk'><input type='checkbox' data-g='towers' data-k='" + devTower + "' data-f='" + f + "' data-def='" + d[f] + "'" + (v ? " checked" : "") + ">Hits " + f + "</label>"; }).join("") + "</div>" +
      "<p class='devmsg'>Upgrade prices follow the tower price (1x, 2x, 4x and up to 16x). Beacon and Hex only use range, price and their buff.</p>";
  } else if (devSub === "creeps") {
    const d = DEF.creeps[devCreep];
    body = "<label class='modelab'>Creep <select data-pick='creep'>" + Object.keys(DEF.creeps).map(k => "<option value='" + k + "'" + (k === devCreep ? " selected" : "") + ">" + typeName(k) + "</option>").join("") + "</select></label><div class='devgrid'>" +
      CREEP_FIELDS.map(([f, l]) => devField("creeps", devCreep, f, l, d[f])).join("") + "</div>" +
      "<p class='devmsg'>Health is the base value: it is multiplied by the map, difficulty and wave growth (Game tab).</p>";
  } else if (devSub === "vs") {
    const towers = TOWER_KEYS.filter(k => DEF.towers[k].dmg > 0);
    body = "<table class='vs'><tr><th>Tower</th>" + VS_TYPES.map(t => "<th>" + (t === "boss" ? "Boss" : typeName(t)) + "</th>").join("") + "</tr>" +
      towers.map(k => "<tr><td>" + DEF.towers[k].name + "</td>" + VS_TYPES.map(t => {
        const def = Math.round((DEF.vs[k][t] !== undefined ? DEF.vs[k][t] : DEFAULT_VS) * 100);
        const cur = (DEV.vs[k] || {})[t]; const v = cur === undefined ? def : Math.round(cur * 100);
        return "<td><input type='number' data-vs='" + k + "' data-t='" + t + "' data-def='" + def + "' value='" + v + "'" + (v !== def ? " class='chg'" : "") + "></td>";
      }).join("") + "</tr>").join("") + "</table><p class='devmsg'>Percent of full damage a tower does to each creep type. Bosses use the average of their type and the Boss column.</p>";
  } else if (devSub === "waves") {
    const r = parseWaves(DEV.waves);
    body = "<label class='devgrid chk' style='display:flex;margin-top:8px'><input type='checkbox' id='devUse'" + (DEV.useWaves ? " checked" : "") + "> Use this script instead of the built-in waves</label>" +
      "<div class='devbar' style='margin-top:6px'><button id='devFill'>Fill with the built-in schedule</button><button id='devClear'>Clear</button></div>" +
      "<textarea class='dev' id='devWaves' spellcheck='false' placeholder='One line per wave, for example:\nnormal:10\nfast:6, normal:6\nbossFast:1\n# types: normal fast squad flyer tough decoy spawner splitling and the bosses'>" + esc(DEV.waves) + "</textarea>" +
      "<div class='devmsg" + (r.error ? " err" : "") + "' id='devWavesMsg'>" + (r.error || (r.waves.length + " waves, " + r.waves.reduce((a, w) => a + w.reduce((b, e) => b + e.n, 0), 0) + " creeps. Wave numbers follow the line order.")) + "</div>";
  } else {
    const g = DEF.game, cur = DEV.game;
    const f = (k, l, scale) => { const def = g[k] * scale, v = cur[k] === undefined ? def : cur[k] * scale;
      return "<label>" + l + "<input type='number' step='any' data-game='" + k + "' data-scale='" + scale + "' data-def='" + def + "' value='" + +v.toFixed(3) + "'" + (Math.abs(v - def) > 1e-9 ? " class='chg'" : "") + "></label>"; };
    body = "<div class='devgrid'>" + f("startGold", "Start gold", 1) + f("lives", "Lives", 1) + f("hpStart", "Creep health at wave 1 (%)", 100) + f("hpGrowth", "Health growth per wave (%)", 100) + f("autoWait", "Seconds between waves", 1) + f("sellRate", "Sell refund (%)", 100) + "</div>" +
      "<p class='devmsg'>Difficulty and map multipliers still apply on top of these.</p>";
  }
  box.innerHTML = "<div class='devbar'><button id='devRun' class='primary'>Run</button><button id='devReset'>Reset all</button><button id='devExport'>Export</button><button id='devImport'>Import</button></div>" +
    "<div class='seg' style='margin-top:0'>" + subs.map(([k, n]) => "<button data-devsub='" + k + "' aria-pressed='" + (k === devSub) + "'>" + n + "</button>").join("") + "</div>" + body +
    "<textarea class='dev' id='devJson' hidden spellcheck='false' style='min-height:120px'></textarea>";
}

function devChanged(el) {   // an edit in the Dev pane
  const d = el.dataset;
  const setIn = (group, key, field, val, def) => {
    const o = DEV[group][key] || (DEV[group][key] = {});
    if (val === def) { delete o[field]; if (!Object.keys(o).length) delete DEV[group][key]; } else o[field] = val;
  };
  if (d.vs) setIn("vs", d.vs, d.t, numOr(el.value, +d.def) / 100, +d.def / 100);
  else if (d.game !== undefined) { const sc = +d.scale; const v = numOr(el.value, +d.def); if (Math.abs(v - +d.def) < 1e-9) delete DEV.game[d.game]; else DEV.game[d.game] = v / sc; }
  else if (d.g) {
    if (el.type === "checkbox") setIn(d.g, d.k, d.f, el.checked, d.def === "true");
    else setIn(d.g, d.k, d.f, numOr(el.value, +d.def), +d.def);
  }
  el.classList.toggle("chg", el.type !== "checkbox" && String(el.value) !== String(d.def));
  saveDev();
}
function defaultWaveText() {   // the built-in schedule written out as a script, to edit from
  const saved = S.custom, cache = S.waveInfoCache; S.custom = null; S.waveInfoCache = {};
  const lines = [];
  for (let n = 1; n <= 63; n++) {
    const info = waveInfo(n);
    if (info.boss) { lines.push(info.boss + ":1"); continue; }
    const target = 6 + Math.round(n * 1.4), per = Math.ceil(target / info.types.length);
    lines.push(info.types.map(t => t + ":" + per).join(", "));
  }
  S.custom = saved; S.waveInfoCache = cache;
  return lines.join("\n");
}
function setDevMode(on) {
  devOn = on;
  const tab = document.querySelector("[data-tab=dev]");
  tab.hidden = !on;
  if (on) renderDev(); else if (currentTab === "dev") showTab("sel");
}

$("devPane").addEventListener("input", e => {
  const el = e.target;
  if (el.id === "devWaves") {
    DEV.waves = el.value; saveDev();
    const r = parseWaves(DEV.waves), m = $("devWavesMsg");
    m.className = "devmsg" + (r.error ? " err" : "");
    m.textContent = r.error || (r.waves.length + " waves, " + r.waves.reduce((a, w) => a + w.reduce((b, x) => b + x.n, 0), 0) + " creeps. Wave numbers follow the line order.");
    return;
  }
  if (el.dataset.pick) return;
  if (el.id === "devUse") { DEV.useWaves = el.checked; saveDev(); return; }
  if (el.dataset.vs || el.dataset.game !== undefined || el.dataset.g) devChanged(el);
});
$("devPane").addEventListener("change", e => {
  const el = e.target;
  if (el.dataset.pick === "tower") { devTower = el.value; renderDev(); }
  else if (el.dataset.pick === "creep") { devCreep = el.value; renderDev(); }
});
$("devPane").addEventListener("click", e => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.devsub) { devSub = b.dataset.devsub; renderDev(); return; }
  if (b.id === "devRun") runDev();
  else if (b.id === "devReset") { DEV = emptyDev(); saveDev(); applyDev(); rebuildGuides(); renderDev(); loadMap(S.map.idx); setMsg("Developer edits cleared; defaults restored."); }
  else if (b.id === "devExport") { const t = $("devJson"); t.hidden = false; t.value = JSON.stringify(DEV, null, 1); t.select(); }
  else if (b.id === "devImport") {
    const t = $("devJson");
    if (t.hidden) { t.hidden = false; t.value = ""; t.placeholder = "Paste exported JSON here, then press Import again."; return; }
    try { const j = JSON.parse(t.value); DEV = Object.assign(emptyDev(), j); saveDev(); renderDev(); setMsg("Imported. Press Run to use it."); }
    catch (err) { setMsg("That is not valid JSON."); }
  }
  else if (b.id === "devFill") { DEV.waves = defaultWaveText(); DEV.useWaves = true; saveDev(); renderDev(); }
  else if (b.id === "devClear") { DEV.waves = ""; saveDev(); renderDev(); }
});


// ---------- settings dialog ----------
// The old selects stay in the page (hidden) and keep the current values; this dialog edits a pending copy
// and applies everything at once, so changing several options restarts the map only once.
const SET_TYPES = [
  ["campaign", "Campaign", "63 waves on one map. Clearing a map unlocks harder levels, later maps and towers."],
  ["endless", "Endless", "Waves never stop. Survive as long as you can; your best wave is saved."],
  ["bossrush", "Boss rush", "28 bosses and nothing else, with 4x starting gold."],
  ["puzzle1", "Puzzle: Air raid", "A strong ground defence that cannot hit air. 160 gold, 20 waves: fix it."],
  ["puzzle2", "Puzzle: Wrong place", "Towers stand in the wrong places. Rebuild with 220 gold, 24 waves."]
];
const SET_RULES = [
  ["standard", "Standard", "The normal game."],
  ["nosell", "Build only", "Towers cannot be sold, so every placement counts."],
  ["fixed", "Fixed gold", "One budget for the whole map: no income at all and no selling."]
];
const SET_MODES = [
  ["extended", "Extended", "Damage, range and reload each have 4 upgrade levels at one shared price, plus targeting and creep filters."],
  ["normal", "Normal", "One Upgrade button; every tower hits every creep type."],
  ["dev", "Developer", "Edit every number and write your own waves. Locks, eras and Civilization rewards are off."]
];
const DIFF_NOTES = { easy: "The baseline.", middle: "A step up.", hard: "For a developed defence.", extreme: "Needs a near-perfect build." };
const DIFF_REWARD = { easy: 1, middle: 1.25, hard: 1.5, extreme: 2 };
let PEND = null, setWasPaused = false, advOpen = false;
const pct = v => (v >= 1 ? "+" : "") + Math.round((v - 1) * 100) + "%";
const typeLabel = t => (SET_TYPES.find(x => x[0] === t) || [0, t])[1];
const modeVal = () => ($("modeSel") ? $("modeSel").value : "extended");
function realDiffLocked(d, devPend) { return !devPend && !PROG.all && d in DIFF_REQ && !clearedAt(DIFF_REQ[d]); }
function realMapLocked(i, devPend) { return !devPend && !PROG.all && i > 0 && i !== CUSTOM_IDX && !PROG.clears[(i - 1) + "|easy"] && !clearList().some(c => c.map === i - 1); }
function renderCfgSummary() {
  const el = $("cfgSum");
  if (!el || !S) return;
  const parts = [PUZZLES[levelType] ? PUZZLES[levelType].name : "Map " + (S.map.idx + 1), DIFFICULTY[difficulty].name];
  if (!PUZZLES[levelType] && levelType !== "campaign") parts.push(typeLabel(levelType));
  if (rules !== "standard") parts.push(SET_RULES.find(r => r[0] === rules)[1]);
  if (!eraMode) parts.push("No eras");
  if (spawners > 1) parts.push(spawners + " spawners");
  if (modeVal() !== "extended") parts.push(SET_MODES.find(m => m[0] === modeVal())[1]);
  if (seedMode === "daily") parts.push("Daily seed"); else if (seedMode === "custom") parts.push("Seed " + S.seed);
  const t = parts.join(" · ");
  if (el.textContent !== t) el.textContent = t;
}
function drawThumb(cv, def) {
  const c = cv.getContext("2d"), N = COLS, px = 5;
  cv.width = N * px; cv.height = ROWS * px;
  const col = { "#": "#2d5580", B: "#2d5580", ".": "#123a61", m: "#96642f", r: "#6f8fae", I: "#3ccf9a", O: "#ff7a6b", P: "#c084fc", Q: "#c084fc", S: "#c084fc", T: "#c084fc", g: "#f6c445", x: "#0b2540" };
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < N; x++) { c.fillStyle = col[def.rows[y][x]] || "#123a61"; c.fillRect(x * px, y * px, px, px); }
}
function openSettings() {
  if (!S) return;
  PEND = { map: PUZZLES[levelType] ? +$("mapSel").value : S.map.idx, diff: difficulty, type: levelType, rules, era: eraMode ? "on" : "off", spawn: spawners, mode: modeVal(), seed: seedMode, seedText: seedCustom, saveDraft: "", saveMsg: "" };
  setWasPaused = paused;
  if (!paused) setPaused(true);
  $("settings").hidden = false;
  renderSettings();
  const first = $("setBody").querySelector("button:not(:disabled)"); if (first) first.focus();
}
function closeSettings(restore) {
  if ($("settings").hidden) return;
  $("settings").hidden = true;
  if (restore !== false && !setWasPaused && paused) setPaused(false);
  $("cfgBtn").focus();
}
function renderSettings() {
  const P = PEND, dev = P.mode === "dev", puz = !!PUZZLES[P.type];
  const sec = (title, desc, body) => "<section class='ssec'><h3>" + title + "</h3>" + (desc ? "<p class='sd'>" + desc + "</p>" : "") + body + "</section>";
  const opt = (grp, val, name, desc, sel, extra, dis) => "<button class='opt' data-set='" + grp + ":" + val + "' aria-pressed='" + sel + "'" + (dis ? " disabled" : "") + "><span class='on'>" + esc(name) + "</span>" + (extra || "") + (desc ? "<span class='od'>" + esc(desc) + "</span>" : "") + "</button>";
  let h = "";
  // difficulty
  h += sec("Difficulty", "Changes creep health, your towers' power and how much gold you earn. Harder levels also pay more Civilization resources.",
    "<div class='opts c4'>" + DIFF_ORDER.map((k, n) => {
      const d = DIFFICULTY[k], lk = realDiffLocked(k, dev);
      const meter = "<span class='meter' aria-hidden='true'>" + [0, 1, 2, 3].map(i => "<i class='" + (i <= n ? "f" : "") + "'></i>").join("") + "</span>";
      const stats = "<span class='ds'>Creep health <b>x" + d.mult + "</b><br>" + (d.dmg > 1 ? "Your towers <b>" + pct(d.dmg) + "</b> damage and fire rate" : "Your towers <b>no bonus</b>") + "<br>Start gold <b>x" + d.gold + "</b>, kills <b>x" + d.reward + "</b><br>Civilization rewards <b>x" + DIFF_REWARD[k] + "</b></span>";
      const lock = lk ? "<span class='lk'>Locked: clear any map on " + DIFFICULTY[DIFF_ORDER[n - 1]].name + " or harder</span>" : "";
      return opt("diff", k, d.name, DIFF_NOTES[k], P.diff === k, meter + stats + lock, lk);
    }).join("") + "</div>");
  // game type
  h += sec("Game type", "", "<div class='opts c3'>" + SET_TYPES.map(t => opt("type", t[0], t[1], t[2], P.type === t[0])).join("") + "</div>");
  // map
  if (puz) h += sec("Map", "", "<p class='mapinfo' style='margin:0'>" + esc(PUZZLES[P.type].name) + " uses its own map.</p>");
  else {
    h += sec("Map", "Each map changes where creeps enter and leave. Later maps are harder and unlock by clearing the one before.",
      "<div class='maps'>" + MAPS.map((m, i) => {
        const lk = realMapLocked(i, dev);
        return "<button class='opt mapcard' data-set='map:" + i + "' aria-pressed='" + (P.map === i) + "'" + (lk ? " disabled" : "") + "><canvas data-thumb='" + i + "' width='65' height='65'></canvas><span class='on'>" + (i === CUSTOM_IDX ? "Custom" : esc(m.name)) + "</span>" + (lk ? "<span class='lk'>Locked</span>" : "") + "</button>";
      }).join("") + "</div><div class='mapinfo'><b>" + esc(MAPS[P.map].name) + ".</b> " + esc(MAPS[P.map].desc) + "</div>");
  }
  // advanced: rules, eras, spawners, mode, seed, save data
  const nonDefault = P.rules !== "standard" || P.era !== "on" || P.spawn !== 1 || P.mode !== "extended" || P.seed !== "random";
  h += "<details class='adv'" + (advOpen || nonDefault ? " open" : "") + "><summary>Advanced options<small>" + (nonDefault ? "some options changed" : "rules, eras, spawners, mode, seed, save data") + "</small></summary>" +
    "<div class='acts' style='margin:0 0 4px'><button id='setRecommended'>Use recommended options</button></div>";
  h += sec("Rules", "", "<div class='opts c3'>" + SET_RULES.map(r => opt("rules", r[0], r[1], r[2], P.rules === r[0])).join("") + "</div>");
  h += sec("Eras", "Start with the first towers and move up through four eras, for gold or free on schedule.",
    "<div class='opts c2'>" + opt("era", "on", "On", "Ancient to Modern. Advancing ahead of schedule makes creeps tougher but kills pay more.", P.era === "on") + opt("era", "off", "Off", "The classic game: every unlocked tower is available from the start.", P.era === "off") + "</div>");
  h += sec("Spawners", "How many creeps each entrance sends for every creep in the wave.",
    "<div class='opts c4'>" + [1, 2, 3, 4].map(n => opt("spawn", n, n + (n === 1 ? " spawner" : " spawners"), n === 1 ? "The standard stream." : "More creeps, faster stream. Kills pay " + Math.round(spawnGold(n) * 100) + "% gold.", P.spawn === n)).join("") + "</div>");
  h += sec("Mode", "", "<div class='opts c3'>" + SET_MODES.map(m => opt("mode", m[0], m[1], m[2], P.mode === m[0])).join("") + "</div>");
  h += sec("Seed", "The seed decides wave mixes, modifiers and elites. The same seed with the same map and settings plays the same waves, so you can replay a run or race a friend on it.",
    "<div class='opts c3'>" + opt("seed", "random", "Random", "A new seed every run.", P.seed === "random") + opt("seed", "daily", "Daily", "Today's seed (" + dailySeed() + "): the same for everyone today.", P.seed === "daily") + opt("seed", "custom", "Custom", "Type a seed, or use one from a run you liked.", P.seed === "custom") + "</div>" +
    (P.seed === "custom" ? "<div class='seedrow'><label>Seed <input id='seedInput' maxlength='16' value='" + esc(P.seedText || (S ? S.seed : "")) + "'></label><span class='sd'>Current run: " + esc(S.seed) + "</span></div>" : ""));
  const saveDraft = P && P.saveDraft !== undefined ? P.saveDraft : "";
  const saveMsg = (P && P.saveMsg) || (Store.available() ? "" : "This browser blocks storage: progress lasts only until the page closes.");
  h += sec("Save data", "Your progress, Civilization, settings and layout slots are kept in this browser. Copy the code to back it up or move it to another device.",
    "<div class='acts'><button id='saveExport'>Show save code</button><button id='saveCopy'>Copy</button><button id='saveImport'>Load save code</button></div><textarea id='saveText' placeholder='save code' spellcheck='false' style='width:100%;min-height:60px;margin-top:6px'>" + esc(saveDraft) + "</textarea><div class='sd' id='saveMsg'>" + esc(saveMsg) + "</div>");
  h += "</details>";
  $("setBody").innerHTML = h;
  for (const cv of $("setBody").querySelectorAll("canvas[data-thumb]")) drawThumb(cv, MAPS[+cv.dataset.thumb]);
  $("setCur").textContent = "Now playing: " + $("cfgSum").textContent;
  // footer
  const bad = (!puz && realMapLocked(P.map, dev)) || realDiffLocked(P.diff, dev);
  $("setNote").className = "grow" + (bad ? " warn" : "");
  $("setNote").textContent = bad ? "That choice is locked at the moment. Pick another map or difficulty." : (S.launched > 0 && !S.over && !S.levelDone ? "Starting restarts the map and drops the run in progress." : "Starting loads the map with these settings.");
  $("setApply").disabled = bad;
  $("setSound").textContent = Sound.enabled() ? "Sound on" : "Sound off";
  $("setNext").hidden = $("nextMapBtn").style.display === "none";
}
function applySettings() {
  const p = PEND; if (!p) return;
  const dev = p.mode === "dev", puz = !!PUZZLES[p.type];
  if (realDiffLocked(p.diff, dev) || (!puz && realMapLocked(p.map, dev))) return;
  difficulty = p.diff; $("diffSel").value = p.diff;
  levelType = p.type; $("typeSel").value = p.type;
  rules = p.rules; $("rulesSel").value = p.rules; try { Store.setItem("mtd-rules", rules); } catch (e) { /* ignore */ }
  spawners = p.spawn; $("spawnSel").value = String(p.spawn); try { Store.setItem("mtd-spawn", String(p.spawn)); } catch (e) { /* ignore */ }
  eraMode = p.era === "on"; $("eraSel").value = p.era; try { Store.setItem("mtd-era", p.era); } catch (e) { /* ignore */ } eraKey = ""; lkKey = "";
  seedMode = p.seed; seedCustom = (p.seedText || "").trim().toUpperCase().slice(0, 16);
  if (seedMode === "custom" && !seedCustom) seedMode = "random";
  Store.setItem("mtd-seedmode", seedMode); Store.setItem("mtd-seedcustom", seedCustom);
  extended = p.mode !== "normal"; $("modeSel").value = p.mode; try { Store.setItem("mtd-mode", p.mode); } catch (e) { /* ignore */ }
  setDevMode(dev); applyDev(); rebuildGuides();
  const idx = puz ? PUZZLES[p.type].map : p.map;
  $("settings").hidden = true;
  loadMap(idx);
  $("cfgBtn").focus();
}
function buildSettings() {
  $("cfgBtn").addEventListener("click", openSettings);
  $("setClose").addEventListener("click", () => closeSettings());
  $("setApply").addEventListener("click", applySettings);
  $("settings").addEventListener("click", e => { if (e.target === $("settings")) closeSettings(); });
  $("setSound").addEventListener("click", () => { $("soundBtn").click(); renderSettings(); });
  $("setRestart").addEventListener("click", () => { $("settings").hidden = true; loadMap(S.map.idx); $("cfgBtn").focus(); });
  $("setNext").addEventListener("click", () => { $("settings").hidden = true; $("nextMapBtn").click(); });
  $("setBody").addEventListener("toggle", e => { if (e.target.classList && e.target.classList.contains("adv")) advOpen = e.target.open; }, true);
  $("setBody").addEventListener("input", e => {
    if (e.target.id === "seedInput" && PEND) PEND.seedText = e.target.value;
    if (e.target.id === "saveText" && PEND) PEND.saveDraft = e.target.value;
  });
  $("setBody").addEventListener("click", e => {
    const say = m => { if (PEND) PEND.saveMsg = m; const el = $("saveMsg"); if (el) el.textContent = m; };
    if (e.target.id === "setRecommended") { Object.assign(PEND, { rules: "standard", era: "on", spawn: 1, mode: "extended", seed: "random" }); advOpen = true; renderSettings(); return; }
    if (e.target.id === "saveExport") { const code = Store.exportCode(); if (PEND) PEND.saveDraft = code; $("saveText").value = code; say("This code holds all your save data."); return; }
    if (e.target.id === "saveCopy") { const v = $("saveText").value || Store.exportCode(); if (PEND) PEND.saveDraft = v; $("saveText").value = v; try { navigator.clipboard.writeText(v).then(() => say("Copied to clipboard."), () => say("Select the code and copy it.")); } catch (err) { say("Select the code and copy it."); } return; }
    if (e.target.id === "saveImport") {
      const val = ($("saveText") && $("saveText").value) || (PEND && PEND.saveDraft) || "";
      if (!Store.importCode(val)) return say("That is not a valid save code.");
      say("Save loaded. Reloading the game...");
      setTimeout(() => location.reload(), 600);
      return;
    }
    const b = e.target.closest("[data-set]"); if (!b || b.disabled || !PEND) return;
    const [grp, val] = b.dataset.set.split(":");
    PEND[grp] = (grp === "map" || grp === "spawn") ? +val : val;
    if (grp === "mode" || grp === "type") {   // a choice that is no longer allowed falls back to something that is
      const dev = PEND.mode === "dev";
      if (realDiffLocked(PEND.diff, dev)) PEND.diff = "easy";
      if (!PUZZLES[PEND.type] && realMapLocked(PEND.map, dev)) PEND.map = 0;
    }
    renderSettings();
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("settings").hidden) { e.stopPropagation(); closeSettings(); } }, true);
}

// Fixed time step: the simulation always advances in 1/60 s steps, whatever the frame rate, so a phone and a
// desktop play the same game. Faster speeds run more steps; a long stall (tab in the background) is dropped, not replayed.
const STEP = 1 / 60, MAX_STEPS = 24;
let simAcc = 0;
function loop(now) {
  const dt = Math.min(0.1, (now - lastT) / 1000 || 0);
  lastT = now;
  simAcc = Math.min(simAcc + dt * gameSpeed, STEP * MAX_STEPS);
  while (simAcc >= STEP) {
    simAcc -= STEP;
    update(STEP);
    if (!paused) updateFx(STEP);
  }
  render();
  uiAcc += dt;
  if (uiAcc > 0.2 && !document.hidden) { uiAcc = 0; refreshUI(); }
  requestAnimationFrame(loop);
}

buildTowerButtons();
buildTowerList();
buildMatrix();
buildCreepList();
buildMapSelect();
buildModeSelect();
buildDiffSelect();
buildRulesSelect();
buildEraSelect();
buildSettings();
buildEnd();
buildTypeSelect();
buildEditor();
{ const hd = document.querySelector("header.top");
  const small = () => matchMedia("(max-aspect-ratio: 11/10), (max-width: 599px), (max-height: 520px)").matches;
  const sync = () => hd.classList.toggle("closed", small());
  sync(); window.addEventListener("resize", sync); }
loadMap(0);
requestAnimationFrame(t => { lastT = t; loop(t); });
