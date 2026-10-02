// Players market (WW bidding) — actual points must be MFL's own league scoring.
//   node tests/mobile_players_mfl_scoring.test.mjs
//   PLAYERS_JS=<path to another players.js> node tests/mobile_players_mfl_scoring.test.mjs
//
// THE BUG (Keith 2026-10-01: "YTD Points do not appear to match the points
// players actually scored in our MFL league"). The market's YTD came from
// /api/advanced-stats-leaderboard mfl_points = SUM(D1 src_weekly.score). On
// 2026-09-29 the standings sync deleted the 2026 season of src_weekly and
// rewrote only ACTIVE-roster rows, so on the live board 241 of 481 players were
// wrong: every free agent read 0.0 and anyone added mid-season showed only his
// weeks on a UPS roster. See pipelines/etl/scripts/
// test_sync_live_season_src_weekly_ownership.py for the refresh-path half.
//
// EVERY number below is checked against MFL's own W=YTD and W=AVG exports
// (fixture mfl_ytd / mfl_avg), which are independent of the W=ALL payload the
// app now reads — so this test cannot pass by agreeing with itself.
//
// Defect-sensitive: the row parser accepts BOTH the old markup ("YTD 0.0",
// "PPG 0.0") and the new one, and the harness serves the old code path exactly
// what production served it (the captured leaderboard rows), so pointing
// PLAYERS_JS at the pre-fix players.js fails on Golden / McLaughlin / Waller /
// Warner. Fixture: tests/fixtures/mobile_players_mfl_scoring_2026_wk3.json
// (real read-only captures, 2026-10-01, before Week 4 kickoff).
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.isAbsolute(p) ? p : path.join(ROOT, p), "utf8");
const FX = JSON.parse(read("tests/fixtures/mobile_players_mfl_scoring_2026_wk3.json"));
const PLAYERS_JS = process.env.PLAYERS_JS || "site/m/views/players.js";
const APP = read("site/m/app.js");

// Pull one top-level function out of a source file by brace matching, so the
// harness runs the SHIPPED implementation rather than a copy.
function sliceFn(src, sig) {
  const at = src.indexOf(sig);
  if (at < 0) throw new Error("not found: " + sig);
  let i = src.indexOf("{", at), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error("unbalanced: " + sig);
}
const UTIL_SRC = ["function safeStr(", "function safeInt(", "function pad4(", "function escapeHtml(",
  "function fmtUsd(", "function asArray("].map((s) => sliceFn(APP, s)).join("\n");

function deepClone(x) { return JSON.parse(JSON.stringify(x)); }

function harness(opts = {}) {
  const fx = opts.fx || FX;
  const ctx = vm.createContext({ console, setTimeout, clearTimeout });
  ctx.window = ctx;
  vm.runInContext(UTIL_SRC + "\nthis.__util = { safeStr, safeInt, pad4, escapeHtml, fmtUsd, asArray };", ctx);
  vm.runInContext(read("site/m/season_scoring.js"), ctx);
  // app.js's own leaderboard bucketing + getSeasonScoring, verbatim.
  vm.runInContext(sliceFn(APP, "function buildLeaderboardMap(") + "\nthis.__buildLeaderboardMap = buildLeaderboardMap;", ctx);
  const state = {
    ctx: { year: "2026", leagueId: "74598" },
    players: { players: { player: fx.players } },
    viewerFranchiseId: "", franchises: [],
    playerScoresAll: opts.seasonPayload === undefined ? fx.playerScoresAll : opts.seasonPayload,
    lineupWeekResolution: opts.lineupWeek === undefined ? fx.lineup_week : opts.lineupWeek,
    lineupWeek: 4,
  };
  ctx.state = state;
  vm.runInContext("var safeInt = this.__util.safeInt;\n" + sliceFn(APP, "function getSeasonScoring(") +
    "\nthis.__getSeasonScoring = getSeasonScoring;", ctx);
  const lbMap = ctx.__buildLeaderboardMap(Object.values(fx.leaderboard));
  const ytdMap = {};
  for (const [pid, v] of Object.entries(fx.mfl_ytd)) ytdMap[pid] = Number(v);
  const byId = Object.fromEntries(fx.players.map((p) => [p.id, p]));
  const latestYear = opts.latestYear || 2026;
  const DATA = {
    getAllRosteredPids: () => new Set(Object.keys(fx.rosters)),
    // What production served the pre-fix code path (and still serves the
    // offseason "prior season" basis).
    getAdvancedStatsMap: (y) => (y && Number(y) !== 2026) ? (opts.priorMap || {}) : lbMap,
    getAdvancedStatsLatestYear: () => latestYear,
    getYtdScoresMap: () => ytdMap,
    getSeasonScoring: () => ctx.__getSeasonScoring(),
    playerById: (pid) => byId[String(pid)] || null,
    computeCap: () => null, rosterCapMax: () => 30, getRosterFor: () => [], dropPenaltyFor: () => null,
  };
  const els = {};
  const el = (id) => els[id] || (els[id] = { id, value: "", listeners: {},
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    fire(type) { (this.listeners[type] || []).forEach((fn) => fn.call(this, { target: this })); } });
  ctx.document = {
    getElementById: (id) => (id === "ups-m-players-filter" || id === "ups-m-players-sort") ? el(id) : null,
    addEventListener() {}, activeElement: null, body: { style: {} },
  };
  let renderFn = null;
  const mount = { innerHTML: "", querySelectorAll: () => [], querySelector: () => null };
  ctx.UPS_MOBILE = {
    util: ctx.__util, data: DATA, state,
    ui: { showToast() {} },
    route: { registerView: (n, fn) => { if (n === "players") renderFn = fn; }, renderRoute: () => renderFn(mount, []), navigate() {} },
  };
  vm.runInContext(read(PLAYERS_JS), ctx);
  if (!renderFn) throw new Error("players view did not register");
  renderFn(mount, []);
  // Every test browses ALL players (rostered + free agents), through the real
  // filter control.
  const f = els["ups-m-players-filter"];
  f.value = "all"; f.fire("change");
  return { html: () => mount.innerHTML, els, ctx, state };
}

// Row parser — accepts the pre-fix markup AND the new one (see header).
function rows(html) {
  const out = {};
  const parts = html.split('<div class="ups-m-fa-row');
  parts.shift();
  parts.forEach((chunk, order) => {
    const pid = (/data-pid="(\d+)"/.exec(chunk) || [])[1];
    if (!pid) return;
    const pts = /<b>(-?[\d.]+)<\/b> (?:YTD )?pts(?! ·\s*\d{4} season)/.exec(chunk) || /<span>YTD (-?[\d.]+)<\/span>/.exec(chunk);
    const ppg = /(-?[\d.]+) PPG · (\d+) (?:G|MFL wks?)\b/.exec(chunk) || /<span>PPG (-?[\d.]+)<\/span>/.exec(chunk);
    out[pid] = {
      order,
      pts: pts ? Number(pts[1]) : null,
      ppg: ppg ? Number(ppg[1]) : null,
      games: ppg && ppg[2] != null ? Number(ppg[2]) : (/>0 (?:G|MFL wks)</.test(chunk) ? 0 : null),
      unavailable: /pts unavailable/.test(chunk),
      chunk,
    };
  });
  return out;
}
const name = (pid) => (FX.players.find((p) => p.id === pid) || {}).name || pid;

test("every player's displayed YTD equals MFL's own W=YTD total (real data, all positions, rostered + FA)", () => {
  const r = rows(harness().html());
  let checked = 0;
  for (const [pid, ytd] of Object.entries(FX.mfl_ytd)) {
    t.ok(r[pid], `${name(pid)} (${pid}) is listed`);
    t.equal(r[pid].pts, Math.round(Number(ytd) * 10) / 10, `${name(pid)} (${pid}) YTD — MFL says ${ytd}`);
    checked++;
  }
  t.ok(checked >= 35, `checked ${checked} players`);
});

test("PPG equals MFL's own W=AVG (YTD ÷ weeks MFL scored), with the game count shown", () => {
  const r = rows(harness().html());
  for (const [pid, avg] of Object.entries(FX.mfl_avg)) {
    t.ok(r[pid] && r[pid].ppg != null, `${name(pid)} shows a PPG`);
    t.ok(Math.abs(r[pid].ppg - Number(avg)) <= 0.051, `${name(pid)} PPG ${r[pid].ppg} vs MFL AVG ${avg}`);
    const wk = FX.playerScoresAll.playerScoresAllWeeks.playerScores
      .filter((b) => Number(b.week) <= 3 && b.playerScore.some((s) => s.id === pid && s.score !== "")).length;
    t.equal(r[pid].games, wk, `${name(pid)} games = weeks MFL scored him (${wk})`);
  }
});

test("the four documented mismatches are fixed (free agent, taxi, mid-season add, stat correction)", () => {
  const r = rows(harness().html());
  t.equal(r["14717"].pts, 42.1, "Chase McLaughlin (FA) — leaderboard said 0.0");
  t.equal(r["17075"].pts, 50.7, "Matthew Golden (taxi) — leaderboard said 0.0");
  t.equal(r["12263"].pts, 39.8, "Darren Waller (added before Wk 3) — leaderboard said 13.2 (Wk 3 only)");
  t.equal(r["13743"].pts, 32.0, "Fred Warner — leaderboard said 32.5 (pre-correction Wk 3 = 14.0, MFL now 13.5)");
  t.equal(r["17167"].ppg, 8.0, "Jonas Sanker PPG — leaderboard said 13.0 off ONE rostered week");
});

test("zero and negative scores are real: negative YTD shown and sorted below zero, not hidden as 0", () => {
  const r = rows(harness().html());
  t.equal(r["10313"].pts, -2.0, "Andy Dalton -2.0 (MFL YTD -2)");
  t.equal(r["10313"].games, 1, "...in 1 game");
  // Default sort is PPG: a -2.0 average must sit below a real 0.0 average.
  const zero = Object.entries(r).find(([, x]) => x.ppg === 0 && x.games > 0);
  t.ok(zero, "fixture has a 0.0-PPG player with games");
  t.ok(r["10313"].order > zero[1].order, "-2.0 PPG sorts below 0.0 PPG");
});

test("a week still being played is NOT counted, and the basis line says so", () => {
  const fx = deepClone(FX);
  const wk4 = fx.playerScoresAll.playerScoresAllWeeks.playerScores.find((b) => b.week === "4");
  wk4.playerScore = [{ id: "17075", week: "4", score: "12.0", isAvailable: "0" }];   // TNF in progress
  const h = harness({ fx });
  const r = rows(h.html());
  t.equal(r["17075"].pts, 50.7, "Golden stays at the Wk 1–3 total");
  t.match(h.html(), /completed weeks only \(Wks 1–3, final\)/, "basis names the weeks and says final");
  t.match(h.html(), /Wk 4 in progress, not counted/, "basis says Wk 4 is excluded");
});

test("an unresolvable completed week hides points instead of including provisional scores", () => {
  const fx = deepClone(FX);
  fx.playerScoresAll.playerScoresAllWeeks.playerScores.find((b) => b.week === "4").playerScore =
    [{ id: "17075", week: "4", score: "12.0", isAvailable: "0" }];
  const h = harness({ fx, lineupWeek: null });
  t.equal(rows(h.html())["17075"].pts, null, "does not include Week 4's provisional points");
  t.ok(rows(h.html())["17075"].unavailable, "row says unavailable");
  t.match(h.html(), /confirm the last completed week/, "basis explains the missing authority");
  t.doesNotMatch(h.html(), /62\.7/, "provisional total never appears");
});

test("offseason with a readable, empty MFL scoring export shows the prior season by year", () => {
  const prior = { "14717": { mfl_points: 152.8, mfl_ppg: 9.55, games: 16, pos: "PK", posRank: 13 } };
  const empty = { playerScoresAllWeeks: { year: "2026", playerScores: [] } };
  // Even if nflverse has preseason rows for 2026, the market must select
  // 2025 explicitly; latestYearWithData is not proof of MFL scoring.
  const h = harness({ seasonPayload: empty, lineupWeek: null, latestYear: 2026, priorMap: prior });
  t.equal(h.ctx.__getSeasonScoring().reason, "no_scores_posted");
  t.ok(rows(h.html())["14717"], "McLaughlin remains listed");
  t.match(h.html(), /<b>152\.8<\/b> pts · 2025 season/, "row uses the prior year, never YTD");
  t.match(h.html(), /No 2026 scores posted yet — points are 2025 season totals/, "basis explains the offseason source");
  t.doesNotMatch(h.html(), /YTD pts/, "no current-season label on prior-season points");
});

test("a posted zero or malformed current-season score still fails closed without a completed week", () => {
  const SS = harness().ctx.UPS_MOBILE_SEASON_SCORING;
  for (const score of ["0.0", "-2.0", "not-a-number"]) {
    const out = SS.build({ playerScoresAllWeeks: { playerScores: [
      { week: "1", playerScore: [{ id: "14717", score }] },
    ] } }, { completedWeek: null });
    t.equal(out.known, false, `${score} cannot become an offseason fallback`);
    t.equal(out.reason, "week_unresolved");
  }
  const blank = SS.build({ playerScoresAllWeeks: { playerScores: [
    { week: "1", playerScore: [{ id: "14717", score: "" }] },
  ] } }, { completedWeek: null });
  t.equal(blank.known, true, "a blank score is not a posted score");
  t.equal(blank.throughWeek, 0);
  t.equal(SS.build({ error: "upstream failed", playerScoresAllWeeks: {} }, { completedWeek: null }).known,
    false, "an error envelope is never mistaken for an empty season");
});

test("MFL scoring unavailable → points hidden, NOT the leaderboard number", () => {
  const h = harness({ seasonPayload: null });
  const r = rows(h.html());
  t.ok(r["14717"].unavailable, "row says pts unavailable");
  t.equal(r["14717"].pts, null, "no number printed");
  t.match(h.html(), /points are hidden rather than guessed/, "basis line explains");
});

test("player sheet hides stale current-season bundle points when scoring authority fails", () => {
  const c = vm.createContext({});
  c.window = c;
  vm.runInContext(UTIL_SRC + "\nthis.U = { safeStr, safeInt, pad4, escapeHtml, fmtUsd, asArray };", c);
  const sheet = read("site/m/player_sheet.js");
  vm.runInContext(["function renderStatsBlock(", "function statRowHtml(", "function liveSeasonRow("].map((s) => sliceFn(sheet, s)).join("\n") +
    "\nthis.renderStatsBlock = renderStatsBlock;", c);
  const staleBundle = { career_summary: [
    { season: 2026, games_played: 3, season_points: 0, avg_ppg: 0 },
    { season: 2025, games_played: 16, season_points: 152.8, avg_ppg: 9.55 },
  ] };
  const scoring = { known: false, reason: "week_unresolved", throughWeek: 0 };
  c.UPS_MOBILE = { state: { ctx: { year: 2026 }, _sheetPid: "14717" }, data: {
    getAdvancedStatsLatestYear: () => 2026,
    getSeasonScoring: () => scoring,
    getAdvancedStatsFor: () => null,
  } };
  const html = c.renderStatsBlock(staleBundle);
  t.doesNotMatch(html, /<td>2026<\/td>/, "no current-season row sourced from stale D1");
  t.match(html, /2026: points unavailable/, "sheet explains why current points are absent");
  t.match(html, /<td>2025<\/td>/, "prior season remains available");
  scoring.known = true;
  const noWeek = c.renderStatsBlock(staleBundle);
  t.doesNotMatch(noWeek, /<td>2026<\/td>/, "no current-season row before a week completes");
  t.match(noWeek, /no completed week yet/, "preseason reason is distinct");
});

test("no completed week yet → last season's totals, labelled with the year (never 'YTD')", () => {
  const prior = { "14717": { mfl_points: 152.8, mfl_ppg: 9.55, games: 16, pos: "PK", posRank: 13 } };
  const h = harness({ lineupWeek: { ok: true, week: 1, source: "live_scoring" }, latestYear: 2025, priorMap: prior });
  t.match(h.html(), /<b>152\.8<\/b> pts · 2025 season/, "labelled 2025");
  t.doesNotMatch(h.html(), /YTD pts/, "no row claims YTD");
  t.match(h.html(), /points are 2025 season totals/, "basis says so");
});

test("L2 window = the last two COMPLETED weeks from the same MFL data", () => {
  const h = harness();
  const ss = h.ctx.__getSeasonScoring();
  const l2 = ss.windowFor(2)["12263"];
  const wk = (w) => Number(FX.playerScoresAll.playerScoresAllWeeks.playerScores.find((b) => b.week === String(w))
    .playerScore.find((s) => s.id === "12263").score);
  t.equal(l2.pts, Math.round((wk(2) + wk(3)) * 10) / 10, "Waller L2 = Wk2 + Wk3");
  t.equal(l2.games, 2);
});

test("season_scoring: duplicate rows are not double-counted; blanks are not zeros", () => {
  const SS = harness().ctx.UPS_MOBILE_SEASON_SCORING;
  const out = SS.build({ playerScoresAllWeeks: { playerScores: [
    { week: "1", playerScore: [{ id: "1", score: "10.0" }, { id: "1", score: "10.0" }, { id: "2", score: "" }] },
    { week: "2", playerScore: [{ id: "1", score: "0.0" }] },
  ] } }, { completedWeek: 2 });
  t.equal(out.byPid["1"].pts, 10, "dup ignored");
  t.equal(out.byPid["1"].games, 2, "0.0 week is a game");
  t.equal(out.duplicateRows, 1);
  t.equal(out.byPid["2"], undefined, "blank score is no row, not 0");
});

test("completedWeekFrom mirrors the worker's deriveCompletedWeekFromLineupResolution", () => {
  const SS = harness().ctx.UPS_MOBILE_SEASON_SCORING;
  const wctx = vm.createContext({});
  vm.runInContext(sliceFn(read("worker/src/index.js"), "function deriveCompletedWeekFromLineupResolution(") +
    "\nthis.f = deriveCompletedWeekFromLineupResolution;", wctx);
  const cases = [null, { week: 4, source: "live_scoring" }, { week: 5, source: "live_scoring_week_complete" },
    { week: 1, source: "live_scoring" }, { week: 0, source: "live_scoring" }, { week: 4, source: "projected_scores_fallback" },
    { week: 0, source: "unresolved" }, { week: "x", source: "live_scoring" }];
  for (const c of cases) t.equal(SS.completedWeekFrom(c), wctx.f(c), JSON.stringify(c));
});

test("bid amounts snap by the WORKER's rule (>= minimum AND a multiple of the increment)", () => {
  const src = read(PLAYERS_JS);
  if (src.indexOf("function legalBid(") < 0) throw new Error("players.js has no legalBid() — still snapping min + k·step");
  const bctx = vm.createContext({});
  vm.runInContext("var U = { safeInt: function (v, d) { var n = parseInt(v, 10); return isFinite(n) ? n : d; } };\n" +
    sliceFn(src, "function legalBid(") + "\n" + sliceFn(src, "function parseBidK(") + "\nthis.legalBid = legalBid; this.parseBidK = parseBidK;", bctx);
  // The worker's two checks, read from the shipped handler so a change there breaks this test.
  const W = read("worker/src/index.js");
  t.match(W, /if \(wvMinKnown && bid < wvMinKnown\)/, "worker still rejects below minimum");
  t.match(W, /if \(wvIncKnown && bid % wvIncKnown !== 0\)/, "worker still rejects non-multiples");
  const workerOk = (bid, lim) => !(bid < lim.min) && bid % lim.step === 0 && bid > 0;
  for (const lim of [{ min: 1000, step: 1000 }, { min: 1500, step: 1000 }, { min: 500, step: 250 }]) {
    for (const typed of [0, 1, 499, 1000, 1499, 2500, 12400, 12500, 33333]) {
      const b = bctx.legalBid(typed, lim);
      t.ok(workerOk(b, lim), `legalBid(${typed}, ${JSON.stringify(lim)}) = ${b} passes the worker`);
    }
  }
  // The pre-fix formula (confirmBid, origin/main) for the record:
  const old = (amt, lim) => lim.min + Math.round((Math.max(lim.min, amt) - lim.min) / lim.step) * lim.step;
  t.ok(!workerOk(old(2500, { min: 1500, step: 1000 }), { min: 1500, step: 1000 }), "old formula staged 2500 — BID_NOT_MULTIPLE");
  t.equal(bctx.parseBidK("12"), 12000, "'12' = $12K");
  t.equal(bctx.parseBidK("12.5"), 12500);
  t.equal(bctx.parseBidK("$12,000"), 12000, "whole dollars typed anyway are read as dollars, not $12M");
  t.equal(bctx.parseBidK("300"), 300000, "'300' = $300K");
  t.equal(bctx.parseBidK(""), null);
  t.equal(bctx.parseBidK("-12"), null, "a negative sign is never stripped into a positive $12K bid");
  t.equal(bctx.parseBidK("12oops"), null, "trailing text is not silently stripped");
  t.equal(bctx.parseBidK("12,3"), null, "malformed commas are rejected");
});

test("empty or malformed bid amount cannot stage a prior amount", () => {
  const src = read(PLAYERS_JS);
  const c = vm.createContext({});
  vm.runInContext("var U = { safeInt: function (v, d) { var n = parseInt(v, 10); return isFinite(n) ? n : d; } };\n" +
    sliceFn(src, "function legalBid(") + "\n" + sliceFn(src, "function parseBidK(") + "\n" +
    sliceFn(src, "function confirmBid(") + "\n" +
    "var bidView = { amount: 12000 }; var waiverLimits = function () { return { min: 1000, step: 1000 }; };" +
    "var dropRequired = function () { return null; };" +
    "var box = { value: '', focus: function () { this.focused = true; } };" +
    "var document = { getElementById: function () { return box; } };" +
    "var M = { ui: { showToast: function (s) { this.message = s; } } };" +
    "var clonePlan = function () { throw new Error('invalid bid got as far as staging'); };" +
    "this.tryBid = function (v) { box.value = v; box.focused = false; M.ui.message = ''; confirmBid(); return { message: M.ui.message, focused: box.focused }; };", c);
  for (const value of ["", "-12", "12oops"]) {
    const out = c.tryBid(value);
    t.match(out.message, /Enter a valid bid amount/, `${JSON.stringify(value)} is refused`);
    t.ok(out.focused, "focus stays on the amount box");
  }
});

await run("mobile players MFL scoring");

// Also lets a read-only browser layout check render these exact shipped rows.
export { harness };
