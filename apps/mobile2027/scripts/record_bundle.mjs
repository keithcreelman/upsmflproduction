#!/usr/bin/env node
// Makes src/recorded_data.js, the recorded snapshot the Preview shows in recorded-data mode, from a one-time recording.
//
//   node apps/mobile2027/scripts/record_bundle.mjs --raw <dir of <key>.json files> --manifest <manifest.json> [--out <file>]
//
// This script only READS two local things (the raw answers and their manifest) and WRITES one file. It makes no network request and is
// not part of the shipped page (it is not on the build allowlist). Taking a recording means reading the public routes of the UPS Worker
// once: that is a live read, and a person does it only with Keith's approval (see the README, "Recorded-data preview").
//
// What goes in the bundle is limited twice:
//   1. a per-route ALLOWLIST of the fields the app reads (below; derived from lib/model.js, data.js, roster.js, contract.js, adjust.js,
//      clubhist.js, complete.js, tabviews.js, views.js and the pinned injury resolver). Every other field the Worker sent is dropped, and the
//      structure of what is kept is unchanged, so the app reads the bundle exactly as it reads a live answer;
//   2. a SANITIZATION CHECK over every key and every string that is kept: an e-mail address, a credential-like word (apikey, api_key,
//      token, cookie, session, password, "Bearer "), or a phone-number-like pattern fails the run and nothing is written.
// The recorded data is public league data; the point is that nothing private, and nothing the app does not use, is shipped.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
export const DEFAULT_OUT = path.join(ROOT, "src", "recorded_data.js");
// The one canonicalization of a route, shared with the page (lib/recorded.js): the bundle is keyed by it and looked up by it.
const require = createRequire(import.meta.url);
export const canonical = require("../src/lib/recorded.js").canonical;

// ── the allowlist ───────────────────────────────────────────────────────────────────────────────────────────────────
// A spec says what to keep: `true` keeps the value as sent; an object keeps only the named keys (each with its own spec); a one-element array
// applies its spec to every element (MFL sends a single element as a bare object, so a non-array is treated as one element); { $each: spec }
// applies a spec to every value of an id-keyed map. A key the Worker did not send is simply absent.
const EACH = (spec) => ({ $each: spec });
const KEEP = (names) => { const o = {}; names.forEach((n) => { o[n] = true; }); return o; };
// lib/complete.js parseSchedule reads seconds remaining and each club's id and score; R7: lib/data.js gameDays (the game log's date, kickoff and home flag, and the
// projection's kickoff check) also reads the game's kickoff and each club's home flag
const TEAM_GAME = { gameSecondsRemaining: true, kickoff: true, team: [{ id: true, isHome: true, score: true }] };

// R7: lib/boxlog.js parseBox reads these stat fields (BOX_NUM, RZ_NUM, SNAP_NUM there; a test checks the lists still match) and each row's clubs and position
export const BOX_NUM = ["pass_att", "pass_cmp", "pass_yds", "pass_tds", "pass_ints", "pass_sacks", "pass_sack_yds", "pass_long", "passing_air_yards",
  "rush_att", "rush_yds", "rush_tds", "rush_long", "rush_fumbles_lost", "targets", "receptions", "rec_yds", "rec_tds", "rec_long", "rec_fumbles_lost", "receiving_air_yards",
  "def_tackles_solo", "def_tackles_ast", "def_tackles_total", "def_tfl", "def_qb_hits", "def_sacks", "def_sack_yds", "def_ff", "def_fr", "def_ints", "def_pass_def", "def_tds", "def_pressures",
  "fg_att", "fg_made", "fg_long", "fg_att_0_39", "fg_made_0_39", "fg_att_40_49", "fg_made_40_49", "fg_att_50_59", "fg_made_50_59", "fg_att_60plus", "fg_made_60plus", "xp_att", "xp_made",
  "punts", "punt_yds", "punt_inside20"];
export const RZ_NUM = ["rush_att_i20", "rush_att_i10", "rush_att_i5", "rush_tds_i20", "targets_i20", "targets_i10", "targets_i5", "targets_ez", "rec_i20", "rec_tds_i20", "pass_att_i20", "pass_cmp_i20", "pass_tds_i20", "pass_att_ez"];
export const SNAP_NUM = ["off", "def", "st", "team_off", "team_def"];
// R7: the league-wide season sums kept from the draft /api/position-season-stats answer: the counts the Breakdown's season rollup shows (and so can rank), with the
// denominators its rates and shares use (team targets, carries, receptions and receiving air yards; team snaps). Dropped: the first-down and with-assist/target
// extension sums, times pressured, completions and yards allowed, the made-FG distance sum and the punt net/touchback/inside-5..15 sums (none is shown), and each
// player's gsis id (the app names a player by his MFL id).
export const PSS_FIELDS = ["pass_att", "pass_cmp", "pass_yds", "pass_tds", "pass_ints", "pass_sacks", "pass_sack_yds", "passing_air_yards",
  "rush_att", "rush_yds", "rush_tds", "rush_fumbles_lost", "targets", "receptions", "rec_yds", "rec_tds", "rec_fumbles_lost", "receiving_air_yards",
  "def_tackles_solo", "def_tackles_ast", "def_tackles_total", "def_tfl", "def_qb_hits", "def_sacks", "def_sack_yds", "def_ff", "def_fr", "def_ints", "def_pass_def", "def_tds", "def_pressures",
  "fg_att", "fg_made", "fg_att_0_39", "fg_made_0_39", "fg_att_40_49", "fg_made_40_49", "fg_att_50_59", "fg_made_50_59", "fg_att_60plus", "fg_made_60plus", "xp_att", "xp_made",
  "punts", "punt_yds", "punt_inside20"].concat(RZ_NUM, ["team_targets", "team_rush_att", "team_receptions", "team_rec_air_yards", "off_snaps", "def_snaps", "st_snaps", "team_off_snaps", "team_def_snaps"]);

export const SPECS = {
  // lib/model.js build(), roster.js, views.js, tabviews.js, adjust.js parseTeamRows (text of an adjustment row is read to classify it, then dropped by the app)
  roster: {
    ok: true, generated_at: true, salary_cap_dollars: true,
    teams: [{
      franchise_id: true, franchise_name: true, franchise_abbrev: true, icon_url: true,
      players: [{
        id: true, name: true, position: true, nfl_team: true, points: true, bye: true, salary: true, salary_unresolved: true, years: true, aav: true, type: true, special: true,
        acquisition_text: true, status: true, espn_id: true, order: true, taxi_callups_used: true, taxi_callups_max: true, taxi_eligible: true, taxi_status: { text: true },
      }],
      summary: { cap_total_dollars: true, salary_adjustment_total_dollars: true, cap_unresolved: true, salary_adjustment_raw_rows: [{ franchise_id: true, amount: true, explanation: true }] },
    }],
  },
  // lib/model.js limitsFrom()
  league: { league: { rosterSize: true, injuredReserve: true, taxiSquad: true, starters: { count: true } } },
  // lib/data.js loadCore()
  week: { ok: true, week: true },
  // lib/data.js loadPenalty(), lib/contract.js, tabviews.js, views.js
  penalty: {
    ok: true, season: true, calculated_at: true, earned_through_week: true,
    players: EACH({ penalty: true, guaranteed: true, earned: true, prior_earned: true, current_year_earned: true, acquisition_week: true, eligible_weeks: true, basis: true, exempt_reason: true, earned_rule: true, needs_review: true, review_reason: true }),
  },
  // the pinned injury resolver (shared/injury_status.pure.js) and lib/data.js loadStatus(); the expected-return fields are dropped by the loader and are not kept here either
  status: {
    ok: true,
    report_feed: { ok: true, current: true, week: true, reason: true, teams_mfl: true },
    roster_feed: { ok: true }, mfl_feed: { ok: true, reason: true },
    mapped_mfl_ids: true,
    players: EACH({ mfl: { status: true, details: true }, report: { status: true, injury: true, practice: true }, prior: { week: true, status: true, injury: true }, roster: { chip: true, label: true, detail: true } }),
  },
  // lib/data.js loadMatchups(): games, points per final game, season weeks, the next three weeks, and the team-history fields clubhist.js validates (absent when the Worker sends none)
  matchups: {
    ok: true, week: true, as_of: true, season: { lastCompleteWeek: true, latestFinalWeek: true },
    matchups: EACH({ opp: true, isHome: true, kickoff: true, status: true }),
    playerWindow: EACH({ total: true, games: true, avg: true }),
    horizon: EACH([{ wk: true, opp: true, isHome: true }]), horizonWeeks: true,
    teamHistoryState: true, teamHistoryReason: true, teamHistoryThrough: true, teamHistory: true, teamHistoryMissing: true, teamHistoryConflict: true, teamHistoryFirst: true,
  },
  // lib/adjust.js parseNextSeason(): the player's name text in a row is never read (the app names a player by his id)
  nextSeason: {
    ok: true, error: true,
    rows: [{ franchise_id: true, amount: true, applies_to_season: true, in_mfl: true, kind: true, player_id: true, dropped_at_iso: true }],
    by_fid: EACH({ total: true }),
    held_unpriced: [{ franchise_id: true }], needs_review: [{ franchise_id: true }],
  },
  // lib/data.js loadPlayers()
  players: { players: { player: [{ id: true, name: true, position: true, team: true }] } },
  // lib/complete.js parseCalendar()
  byes: { nflByeWeeks: { team: [{ id: true, bye_week: true }] } },
  scheduleAll: { fullNflSchedule: { nflSchedule: [{ week: true, matchup: [TEAM_GAME] }] } },
  schedule: { nflSchedule: { week: true, matchup: [TEAM_GAME] } },
  // lib/model.js startersByFranchise(), lib/roster.js weeklyIndex()
  weekly: { weeklyResults: { week: true, matchup: [{ franchise: [{ id: true, score: true, player: [{ id: true, score: true, status: true }] }] }] } },
  // lib/data.js loadScores()
  scores: { playerScores: { playerScore: [{ id: true, score: true }] } },
  // R7: lib/data.js loadWeeklyBox() and lib/boxlog.js parseBox(): one player's season of nflverse box, red-zone and snap rows (deployed Worker route)
  box: {
    ok: true, season: true, mfl_id: true, gsis_id: true, pfr_id: true, id_source: true, box_through_week: true,
    weeks: [{ week: true, box: KEEP(BOX_NUM.concat(["team", "opponent", "position"])), redzone: KEEP(RZ_NUM), snaps: KEEP(SNAP_NUM.concat(["team"])) }],
  },
  // R7: lib/data.js positionSeasonStats(): one position group's league-wide season sums (draft #1515 route; fields trimmed to PSS_FIELDS)
  positionStats: {
    ok: true, season: true, through: true, group: true, data_max_week: true, unmapped_box_players: true, ambiguous_ids: true, fields: { $filter: PSS_FIELDS },
    players: [{ mfl_id: true, games: true, snap_games: true, s: KEEP(PSS_FIELDS), cov: KEEP(PSS_FIELDS) }],
  },
  // R7: lib/data.js projections(): the captured MFL projection per player and week, with its capture times (draft #1515 route; nothing dropped)
  projections: {
    ok: true, season: true, week: true, provider: true,
    projections: EACH({ projected_score: true, captured_at: true, first_projected: true, first_captured_at: true, capture_count: true }),
  },
};

// Which spec a canonical route uses (null for a route the app does not ask for: the run fails on it).
export function kindOfRoute(route) {
  const u = new URL("http://x" + route);
  const p = u.pathname, type = u.searchParams.get("TYPE"), w = u.searchParams.get("W");
  if (p === "/roster-workbench") return "roster";
  if (p === "/api/current-lineup-week") return "week";
  if (p === "/api/cap-penalty/preview") return "penalty";
  if (p === "/api/player-status") return "status";
  if (p === "/api/lineup-matchups") return "matchups";
  if (p === "/api/cap-adjustments/next-season") return "nextSeason";
  if (p === "/api/player-weekly-box") return "box";
  if (p === "/api/position-season-stats") return "positionStats";
  if (p === "/api/player-projections") return "projections";
  if (p === "/api/mfl-export") {
    if (type === "league") return "league";
    if (type === "players") return "players";
    if (type === "nflByeWeeks") return "byes";
    if (type === "nflSchedule") return w === "ALL" ? "scheduleAll" : "schedule";
    if (type === "weeklyResults") return "weekly";
    if (type === "playerScores") return "scores";
  }
  return null;
}

function pick(value, spec) {
  if (spec === true) return value;
  if (spec && !Array.isArray(spec) && Object.prototype.hasOwnProperty.call(spec, "$filter")) return Array.isArray(value) ? value.filter((x) => spec.$filter.includes(x)) : value;   // a list of names: only the kept ones
  if (Array.isArray(spec)) {
    const one = (x) => pick(x, spec[0]);
    return Array.isArray(value) ? value.map(one) : value && typeof value === "object" ? one(value) : value;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;   // a scalar where an object was expected: kept as sent (it is data the app reads as-is)
  if (Object.prototype.hasOwnProperty.call(spec, "$each")) {
    const out = {};
    for (const k of Object.keys(value)) out[k] = pick(value[k], spec.$each);
    return out;
  }
  const out = {};
  for (const k of Object.keys(spec)) if (Object.prototype.hasOwnProperty.call(value, k)) out[k] = pick(value[k], spec[k]);
  return out;
}
// R7: the stat fields a position actually uses (lib/boxlog.js columns, rollup and detail draw only the views of the player's own position; every other field
// is read as missing and never shown). The box answers are trimmed by the player's MFL position (from MFL's player list in the same recording; an id whose
// position is not known keeps every field); the position-season answers by their own group.
const PASS = ["pass_att", "pass_cmp", "pass_yds", "pass_tds", "pass_ints", "pass_sacks", "pass_sack_yds", "pass_long", "passing_air_yards"];
const RUSH = ["rush_att", "rush_yds", "rush_tds", "rush_long", "rush_fumbles_lost"];
const REC = ["targets", "receptions", "rec_yds", "rec_tds", "rec_long", "rec_fumbles_lost", "receiving_air_yards"];
const DEF = ["def_tackles_solo", "def_tackles_ast", "def_tackles_total", "def_tfl", "def_qb_hits", "def_sacks", "def_sack_yds", "def_ff", "def_fr", "def_ints", "def_pass_def", "def_tds", "def_pressures"];
const KICK = ["fg_att", "fg_made", "fg_long", "fg_att_0_39", "fg_made_0_39", "fg_att_40_49", "fg_made_40_49", "fg_att_50_59", "fg_made_50_59", "fg_att_60plus", "fg_made_60plus", "xp_att", "xp_made"];
const PUNT = ["punts", "punt_yds", "punt_inside20"];
const RZ_QB = ["pass_att_i20", "pass_cmp_i20", "pass_tds_i20", "pass_att_ez", "rush_att_i20", "rush_tds_i20"];
const RZ_SKILL = ["rush_att_i20", "rush_att_i10", "rush_att_i5", "rush_tds_i20", "targets_i20", "targets_i10", "targets_i5", "targets_ez", "rec_i20", "rec_tds_i20"];
export const GROUP_FIELDS = {
  QB: { box: PASS.concat(RUSH, REC), rz: RZ_QB, season: PASS.concat(RUSH, ["rec_fumbles_lost"], RZ_QB, ["off_snaps", "team_off_snaps"]) },
  SKILL: { box: RUSH.concat(REC), rz: RZ_SKILL, season: RUSH.concat(REC, ["team_targets", "team_rush_att", "team_receptions", "team_rec_air_yards"], RZ_SKILL, ["off_snaps", "team_off_snaps"]) },
  IDP: { box: DEF, rz: [], season: DEF.concat(["def_snaps", "team_def_snaps", "st_snaps"]) },
  PK: { box: KICK, rz: [], season: KICK },
  PN: { box: PUNT, rz: [], season: PUNT },
};
export function groupFor(pos) {
  const p = String(pos || "").toUpperCase();
  if (p === "QB") return "QB";
  if (p === "RB" || p === "WR" || p === "TE") return "SKILL";
  if (["DE", "DT", "DL", "LB", "CB", "S", "DB"].includes(p)) return "IDP";
  if (p === "PK" || p === "K") return "PK";
  if (p === "PN" || p === "P") return "PN";
  return null;
}
const only = (o, names) => { if (!o || typeof o !== "object" || Array.isArray(o)) return o; const out = {}; for (const k of Object.keys(o)) if (names.includes(k)) out[k] = o[k]; return out; };
const POST = {
  box(clean, ctx) {
    const g = GROUP_FIELDS[groupFor(ctx && ctx.positions ? ctx.positions[String(clean && clean.mfl_id)] : null)];
    if (!g || !clean || !Array.isArray(clean.weeks)) return clean;
    clean.weeks = clean.weeks.map((w) => {
      if (!w || typeof w !== "object") return w;
      const o = {};
      for (const k of Object.keys(w)) o[k] = k === "box" ? only(w.box, g.box.concat(["team", "opponent", "position"])) : k === "redzone" ? only(w.redzone, g.rz) : w[k];
      return o;
    });
    return clean;
  },
  positionStats(clean) {
    const g = GROUP_FIELDS[groupFor(clean && clean.group)];
    if (!g || !clean) return clean;
    if (Array.isArray(clean.fields)) clean.fields = clean.fields.filter((f) => g.season.includes(f));
    if (Array.isArray(clean.players)) clean.players = clean.players.map((p) => {
      if (!p || typeof p !== "object") return p;
      const o = {};
      for (const k of Object.keys(p)) { if (k === "s" || k === "cov") { const v = only(p[k], g.season); if (k === "cov" && v && !Object.keys(v).length) continue; o[k] = v; } else o[k] = p[k]; }
      return o;
    });
    return clean;
  },
};
// The sanitized answer for a canonical route (throws for a route the app does not ask for). ctx.positions: { mfl id: MFL position } for the box answers.
export function sanitizeRoute(route, json, ctx) {
  const kind = kindOfRoute(route);
  if (!kind) throw new Error("no allowlist for route: " + route);
  const clean = pick(json, SPECS[kind]);
  return POST[kind] ? POST[kind](clean, ctx) : clean;
}
// { id: position } from an MFL player-list answer (raw or sanitized)
export function positionsOf(playersJson) {
  const rows = playersJson && playersJson.players ? playersJson.players.player : null, out = {};
  (Array.isArray(rows) ? rows : rows ? [rows] : []).forEach((e) => { if (e && e.id != null) out[String(e.id)] = String(e.position == null ? "" : e.position); });
  return out;
}

// ── the sanitization check ──────────────────────────────────────────────────────────────────────────────────────────
export const FORBIDDEN = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, "an e-mail address"],
  [/api[_-]?key/i, "an API key name"],
  [/token/i, "the word token"],
  [/cookie/i, "the word cookie"],
  [/session/i, "the word session"],
  [/password/i, "the word password"],
  [/Bearer /, "a bearer credential"],
  [/(?:\+?\d{1,2}[ .-])?\(?\b\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/, "a phone-number-like pattern"],
];
// Every violation in a value: [{ where, what, sample }]. Both the keys and the strings are checked.
export function violations(value, where = "") {
  const out = [];
  const hit = (s, at) => { for (const [re, what] of FORBIDDEN) if (re.test(s)) out.push({ where: at, what, sample: s.length > 60 ? s.slice(0, 57) + "..." : s }); };
  (function walk(v, at) {
    if (typeof v === "string") hit(v, at);
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, at + "[" + i + "]"));
    else if (v && typeof v === "object") for (const k of Object.keys(v)) { hit(k, at + "." + k + " (key)"); walk(v[k], at + "." + k); }
  })(value, where);
  return out;
}

// ── the bundle ──────────────────────────────────────────────────────────────────────────────────────────────────────
// -> { meta, routes, summary: [{ key, route, kind, before, after }] }. Throws on anything unexpected (a missing file, a route that is not allowlisted,
// a sanitization violation); nothing is written by this function.
export function buildBundle(rawDir, manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!manifest || !Array.isArray(manifest.items) || !manifest.items.length) throw new Error("the manifest has no items");
  const routes = {}, summary = [], problems = [], parts = {}, order = [];
  let earliest = null, roster = null;
  // R7: the box answers are trimmed by each player's MFL position, taken from MFL's player list in the same recording
  const playersItem = manifest.items.find((it) => it && typeof it.path === "string" && kindOfRoute(canonical(it.path)) === "players");
  const ctx = { positions: playersItem ? positionsOf(JSON.parse(fs.readFileSync(path.join(rawDir, playersItem.key + ".json"), "utf8"))) : null };
  if (!ctx.positions && manifest.items.some((it) => it && typeof it.path === "string" && kindOfRoute(canonical(it.path)) === "box")) throw new Error("the recording has game stats but no MFL player list to name each player's position");
  for (const it of manifest.items) {
    if (!it.key || typeof it.path !== "string" || !it.path.startsWith("/")) throw new Error("a manifest item needs a key and a path starting with /: " + JSON.stringify(it));
    if (it.status !== 200) throw new Error("manifest item " + it.key + " did not answer 200 (" + it.status + ")");
    // R7: an item is a GET of a deployed public route ("worker-get", the default), or a draft route's answer assembled by that draft's own code from its SQL run
    // read-only ("draft-sql"), which must name its source and the draft's full commit
    const origin = it.origin == null ? "worker-get" : it.origin;
    if (origin !== "worker-get" && origin !== "draft-sql") throw new Error("manifest item " + it.key + " has an unknown origin: " + it.origin);
    if (origin === "draft-sql" && !(typeof it.source === "string" && /draft #\d+ SQL run read-only/.test(it.source) && /^[0-9a-f]{40}$/.test(String(it.draft_sha || "")))) throw new Error("manifest item " + it.key + " is a draft-route answer without its source and full draft commit");
    const route = canonical(it.path);
    if (Object.prototype.hasOwnProperty.call(routes, route)) throw new Error("two manifest items share the route " + route);
    const rawText = fs.readFileSync(path.join(rawDir, it.key + ".json"), "utf8");
    const raw = JSON.parse(rawText);
    const kind = kindOfRoute(route);
    if (!kind) throw new Error("manifest item " + it.key + " is a route the app does not ask for: " + route);
    const clean = sanitizeRoute(route, raw, ctx);
    for (const v of violations(clean, it.key)) problems.push(it.key + " " + v.where + ": " + v.what + " (" + JSON.stringify(v.sample) + ")");
    routes[route] = clean;
    summary.push({ key: it.key, route, kind, before: Buffer.byteLength(rawText), after: Buffer.byteLength(JSON.stringify(clean)) });
    const t = Date.parse(it.retrieved_at);
    if (!isFinite(t)) throw new Error("manifest item " + it.key + " has no readable retrieved_at");
    if (earliest === null || t < earliest) earliest = t;
    const part = PART_OF[kind] || PART_OF.base, pk = part.label;
    if (!parts[pk]) { parts[pk] = { label: pk, source: origin === "draft-sql" ? it.source.replace(/ on .*$/, "") : part.source, routes: 0, from: t, to: t }; order.push(pk); }
    parts[pk].routes++; parts[pk].from = Math.min(parts[pk].from, t); parts[pk].to = Math.max(parts[pk].to, t);
    if (kind === "roster") roster = new URL("http://x" + route).searchParams;
  }
  if (problems.length) throw new Error("the sanitization check refused the recording:\n  " + problems.join("\n  "));
  if (!roster) throw new Error("the recording has no roster read, so the league and season cannot be named");
  const recordedAt = new Date(earliest).toISOString().replace(/\.\d{3}Z$/, "Z");
  const meta = {
    recordedAt,
    source: "public read-only routes of the UPS Worker",
    league: String(roster.get("L") || ""),
    season: String(roster.get("YEAR") || ""),
    note: "A recorded snapshot of public league data, not a live read; its figures stay as they were at the time above until the snapshot is replaced.",
    routeCount: Object.keys(routes).length,
    // R7: each part of the recording with its own capture times (UTC) and source; the first part is the base recording the time above names
    parts: order.map((k) => ({ label: parts[k].label, source: parts[k].source, routes: parts[k].routes, from: iso(parts[k].from), to: iso(parts[k].to) })),
  };
  return { meta, routes, summary };
}
const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
// Which part of the recording a route kind belongs to (the label is what Help and About can name; the source of a draft-route part comes from its manifest items).
export const PART_OF = {
  base: { label: "league data", source: "public read-only routes of the UPS Worker" },
  box: { label: "game stats", source: "the deployed UPS Worker's public /api/player-weekly-box route" },
  positionStats: { label: "position season totals", source: "" },
  projections: { label: "projections", source: "" },
};

// The script text: ES5, no template literals, strings double-quoted by JSON.stringify. U+2028 and U+2029 are written as escapes (older engines read them as line ends).
export function render(bundle) {
  const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
  const j = (v) => JSON.stringify(v).split(LS).join("\\u2028").split(PS).join("\\u2029");
  const lines = Object.keys(bundle.routes).map((r) => j(r) + ":" + j(bundle.routes[r]));
  return "/* UPS 2027 Preview: a recorded snapshot of the public reads the screens ask for. GENERATED by apps/mobile2027/scripts/record_bundle.mjs from a one-time recording\n" +
    "   (README, \"Recorded-data preview\"); do not edit by hand. It holds only the fields the app reads. Public league data; no credential, session or private text. */\n" +
    "window.UPS2027_RECORDED = {\n\"meta\":" + j(bundle.meta) + ",\n\"routes\":{\n" + lines.join(",\n") + "\n}\n};\n";
}

function argOf(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const raw = argOf("--raw"), manifest = argOf("--manifest"), out = path.resolve(argOf("--out") || DEFAULT_OUT);
  if (!raw || !manifest) { console.error("Usage: record_bundle.mjs --raw <dir> --manifest <file> [--out <file>]  (the two inputs are required; there are no defaults)"); process.exit(2); }
  try {
    const b = buildBundle(path.resolve(raw), path.resolve(manifest));
    const text = render(b);
    fs.writeFileSync(out, text);
    const kb = (n) => (n / 1024).toFixed(1).padStart(8) + " KB";
    console.log("route".padEnd(34) + "kind".padEnd(12) + "before".padStart(11) + "after".padStart(11));
    let tb = 0, ta = 0;
    for (const s of b.summary) { tb += s.before; ta += s.after; console.log(s.key.padEnd(34) + s.kind.padEnd(12) + kb(s.before).padStart(11) + kb(s.after).padStart(11)); }
    console.log("TOTAL".padEnd(46) + kb(tb).padStart(11) + kb(ta).padStart(11));
    console.log("Sanitization check: passed (no e-mail address, credential-like word or phone-like pattern in any key or string).");
    console.log(`Wrote ${b.meta.routeCount} routes, recorded ${b.meta.recordedAt}: ${path.relative(process.cwd(), out)} (${Buffer.byteLength(text)} bytes)`);
  } catch (e) { console.error("Refused: " + e.message); process.exit(1); }
}
