#!/usr/bin/env node
// Standings recording (#1503): writes apps/mobile2027/src/recorded_standings.js from COMMITTED FILES ONLY. It makes no request of any kind.
//
//   node apps/mobile2027/scripts/record_standings.mjs            write the file
//   node apps/mobile2027/scripts/record_standings.mjs --check    fail if the committed file is not this script's exact output
//
// What it adds to the preview's recording (window.UPS2027_RECORDED, from recorded_data.js, which it does NOT change):
//   routes["/api/standings?year=2026"]     the Worker's season standings, GENERATED OFFLINE: the Worker's own pure seedCurrentSeason
//                                           (worker/src/standings_truth.js + seeding.js) run on the weekly results through THROUGH_WEEK. The live
//                                           route reads D1; this is not a live answer and says so (generated: "offline").
//   routes[league fantasy schedule]         MFL's TYPE=schedule export, from the daily snapshot SNAPSHOT (data/mfl-snapshots/<date>/schedule.json)
//   static.forecast                         the season forecast run after THROUGH_WEEK (site/wire/data/season_sim_<y>_live_wkNN.json), ids and odds only.
//                                           Not a Worker route: the live preview has no source for it, so Playoff % reads "—" in live mode.
//   static.positions                        the FROZEN, VERSIONED position list (tests/fixtures/mobile2027/standings_positions_2026_wk10_v1.json)
//                                           used for contributions, with its SHA-256. Historical contributions use it, never "today's" position.
// The weekly lineups and scores (Weeks 1..THROUGH_WEEK) are NOT copied: the screens read the ones already in recorded_data.js (recorded 2026-11-22),
// which equal the snapshot's for every franchise-week (checked here; the script refuses if they differ).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const REPO = path.resolve(ROOT, "..", "..");
const OUT = path.join(ROOT, "src", "recorded_standings.js");

export const SEASON = "2026";
export const THROUGH_WEEK = 10;
export const SNAPSHOT = "2026-11-17";
// the Week 10 forecast replayed under the corrected playoff ladders (#1526, Keith 2026-11-25); the published Week 10 file used the old ones
export const FORECAST = "tests/fixtures/mobile2027/season_sim_2026_wk10_replay.json";
export const POSITIONS = "tests/fixtures/mobile2027/standings_positions_2026_wk10_v1.json";
const rd = (p) => JSON.parse(fs.readFileSync(path.join(REPO, p), "utf8"));
const arr = (x) => (Array.isArray(x) ? x : x ? [x] : []);

export async function build() {
  const league = rd(`data/mfl-snapshots/${SNAPSHOT}/league.json`).league;
  const sched = rd(`data/mfl-snapshots/${SNAPSHOT}/schedule.json`);
  const wrAll = arr(rd(`data/mfl-snapshots/${SNAPSHOT}/weeklyResults.json`).allWeeklyResults.weeklyResults);
  const LAST_REG = Number(league.lastRegularSeasonWeek);
  const DIV = {}, DIVNAME = {};
  arr(league.divisions.division).forEach((d) => { DIVNAME[d.id] = d.name; });
  const franchises = arr(league.franchises.franchise).map((f) => { DIV[f.id] = f.division; return { franchise_id: f.id, franchise_name: f.name, division: f.division }; });

  // the recording the preview already has: its weekly results must equal the snapshot's (else the two parts would disagree)
  const recText = fs.readFileSync(path.join(ROOT, "src", "recorded_data.js"), "utf8");
  const win = {}; new Function("window", recText)(win);
  const R = win.UPS2027_RECORDED.routes;
  const weeklyScores = [], games = [];
  for (let wk = 1; wk <= THROUGH_WEEK; wk++) {
    const snapW = wrAll.find((x) => Number(x.week) === wk);
    const recW = R[`/api/mfl-export?JSON=1&L=74598&TYPE=weeklyResults&W=${wk}&YEAR=${SEASON}`];
    if (!snapW || !recW) throw new Error(`week ${wk} missing from the snapshot or the recording`);
    const key = (W) => { const m = {}; for (const mm of arr(W.matchup)) for (const f of arr(mm.franchise)) m[f.id] = f.score + "|" + arr(f.player).filter((p) => p.status === "starter").map((p) => p.id + ":" + (p.score == null ? "" : p.score)).sort().join(","); return JSON.stringify(m); };
    if (key(snapW) !== key(recW.weeklyResults)) throw new Error(`week ${wk}: the recording's weekly results differ from the snapshot's`);
    const po = wk > LAST_REG ? 1 : 0, seen = {};
    for (const m of arr(snapW.matchup)) {
      const [a, b] = arr(m.franchise);
      for (const [x, y] of [[a, b], [b, a]]) games.push({ week: wk, franchise_id: x.id, opponent_franchise_id: y.id, team_score: Number(x.score), opponent_score: Number(y.score), is_playoff: po, div: DIV[x.id] === DIV[y.id] ? 1 : 0 });
      for (const f of [a, b]) if (!seen[f.id]) { seen[f.id] = 1; weeklyScores.push({ week: wk, franchise_id: f.id, team_score: Number(f.score), is_playoff: po }); }
    }
  }

  const truth = await import(pathToFileURL(path.join(REPO, "worker/src/standings_truth.js")));
  const seeding = await import(pathToFileURL(path.join(REPO, "worker/src/seeding.js")));
  const cur = truth.seedCurrentSeason({ franchises, weeklyScores, games, lastRegularSeasonWeek: LAST_REG, standingsSort: league.standingsSort,
    ladder: { playoffLadders: seeding.playoffLadders, playoffField: seeding.playoffField } });
  if (cur.status !== "ok") throw new Error("seedCurrentSeason: " + cur.status + " " + JSON.stringify(cur.problems));
  // shaped like the live route (worker/src/index.js GET /api/standings): rows in the Worker's order, then weekly and weeklyScores
  const rows = cur.order.map((fid) => { const f = franchises.find((x) => x.franchise_id === fid); const t = { ...cur.teams[fid] }; delete t.order_index;
    return { franchise_id: fid, franchise_name: f.franchise_name, division: f.division, division_name: DIVNAME[f.division], ...t }; });
  const standings = {
    ok: true, year: Number(SEASON), generated: "offline", generated_note: "Generated offline from committed files by the Worker's own seedCurrentSeason; not a live Worker answer.",
    standings_sort: league.standingsSort, standings_basis: "regular_season_ladder",
    regular_season: { status: cur.status, through_week: cur.throughWeek, last_regular_season_week: LAST_REG, complete: cur.complete, next_out: cur.next_out || null, problems: cur.problems, problem_count: cur.problem_count, unresolved: cur.unresolved || [], seed_by_week: cur.seed_by_week || null },
    rows,
    weekly: games.map((g) => ({ w: g.week, fid: g.franchise_id, opp: g.opponent_franchise_id, ts: g.team_score, os: g.opponent_score, div: g.div, po: g.is_playoff })),
    weeklyScores: weeklyScores.map((r) => ({ w: r.week, fid: r.franchise_id, ts: r.team_score, po: r.is_playoff })),
  };
  // the fantasy schedule: only the fields the screens read (week, matchup franchise ids)
  const schedule = { schedule: { weeklySchedule: arr(sched.schedule.weeklySchedule).map((w) => ({ week: String(w.week), matchup: arr(w.matchup).map((m) => ({ franchise: arr(m.franchise).map((f) => ({ id: String(f.id) })) })) })) } };
  // the forecast: ids, the three odds and when it was run; nothing else
  const sim = rd(FORECAST);
  // MAT-2: keeps what the reconciliation needs (the team ids, each team's All-Play W-L-T and its score in the forecast's last week), the odds, and
  // the run's identity; nothing else
  const forecast = { source: FORECAST, season: Number(sim.season), throughWeek: sim.throughWeek, generatedAtUtc: sim.generatedAtUtc, runs: Number(sim.runs) || null,
    model: { seedingRule: (sim.model && sim.model.seedingRule) || null, pendingTies: (sim.model && sim.model.pendingTies) || null,
      pendingTieSeasons: sim.model && sim.model.pendingTieSeasons != null ? sim.model.pendingTieSeasons : null, pendingTieHandling: (sim.model && sim.model.pendingTieHandling) || null }, replayOf: sim.replayOf || null,
    teams: sim.teams.map((t) => ({ franchiseId: String(t.franchiseId), weekScore: t.weekScore, currentApWins: t.currentApWins, currentApLosses: t.currentApLosses, currentApTies: t.currentApTies,
      playoffs: t.currentPlayoffOdds, bye: t.currentByeOdds, division: t.currentDivisionOdds })) };
  const posText = fs.readFileSync(path.join(REPO, POSITIONS), "utf8"), pos = JSON.parse(posText);
  // a 16-character prefix of the fixture's SHA-256 (the build's secret scan refuses long hex runs); the test proves this file is the generator's exact output
  const positions = { version: pos.version, file: POSITIONS, sha256_16: crypto.createHash("sha256").update(posText).digest("hex").slice(0, 16), rule: pos.rule, positions: pos.positions };
  const part = { label: "standings", source: "generated offline from committed files (MFL snapshot " + SNAPSHOT + ", the Week " + THROUGH_WEEK + " forecast, the frozen position list); no live read", routes: 2, from: null, to: null, snapshot: SNAPSHOT, throughWeek: THROUGH_WEEK };
  const body = { routes: { ["/api/standings?year=" + SEASON]: standings, ["/api/mfl-export?JSON=1&L=74598&TYPE=schedule&YEAR=" + SEASON]: schedule }, part, forecast, positions };
  const json = JSON.stringify(body);
  return "/* Standings recording (#1503), GENERATED by apps/mobile2027/scripts/record_standings.mjs from committed files. Do not edit by hand.\n" +
    "   Adds two routes and two static items to the preview's recording (recorded_data.js is not changed). No live read made it. */\n" +
    "(function (w) {\n  \"use strict\";\n  var R = w.UPS2027_RECORDED; if (!R || !R.routes) return;\n  var S = " + json + ";\n" +
    "  Object.keys(S.routes).forEach(function (k) { R.routes[k] = S.routes[k]; });\n" +
    "  R.meta = R.meta || {}; R.meta.parts = (R.meta.parts || []).concat([S.part]);\n" +
    "  R.static = { forecast: S.forecast, positions: S.positions };\n})(window);\n";
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const text = await build();
  if (process.argv.includes("--check")) {
    const now = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
    if (now !== text) { console.error("recorded_standings.js is not the generator's exact output; run node apps/mobile2027/scripts/record_standings.mjs"); process.exit(1); }
    console.log("recorded_standings.js matches the generator");
  } else {
    fs.writeFileSync(OUT, text);
    console.log("Wrote " + path.relative(process.cwd(), OUT) + " (" + Buffer.byteLength(text) + " bytes)");
  }
}
