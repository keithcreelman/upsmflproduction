// Players market (WW bidding) — actual points must be MFL's own league scoring.
//   node tests/mobile_players_mfl_scoring.test.mjs
//   PLAYERS_JS=<path to another players.js> node tests/mobile_players_mfl_scoring.test.mjs
//   SEASON_SCORING_JS=<another season_scoring.js> APP_JS=<another app.js> (same idea)
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
//
// THE SECOND BUG (Keith 2026-10-02): the fix above counted COMPLETED weeks
// only, so the Friday after Week 4's Thursday game every PIT/CLE player showed
// his Wk 1–3 total while MFL's own YTD already had Thursday in it (Andre Szmyt
// 27.7 vs MFL 40.7; 63 of the 76 totals and 72 PPGs wrong). "Season" is now
// MFL's YTD with the live week in it; only Last-N windows are final-only.
// Fixture: mobile_players_mfl_scoring_2026_wk4_tnf.json (real read-only
// captures, 2026-10-02 13:38Z). Pointing SEASON_SCORING_JS / PLAYERS_JS /
// APP_JS at the 51ca483d copies fails the Week 4 tests on those players.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.isAbsolute(p) ? p : path.join(ROOT, p), "utf8");
const FX = JSON.parse(read("tests/fixtures/mobile_players_mfl_scoring_2026_wk3.json"));
const FX4 = JSON.parse(read("tests/fixtures/mobile_players_mfl_scoring_2026_wk4_tnf.json"));
const PLAYERS_JS = process.env.PLAYERS_JS || "site/m/views/players.js";
const SEASON_SCORING_JS = process.env.SEASON_SCORING_JS || "site/m/season_scoring.js";
const APP = read(process.env.APP_JS || "site/m/app.js");
// When MFL's scores were read in the Week 4 capture — the "MFL as of" time.
const FX4_READ_AT = Date.parse(FX4.fetched_at_utc);

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
  vm.runInContext(read(SEASON_SCORING_JS), ctx);
  // app.js's own leaderboard bucketing + getSeasonScoring, verbatim.
  vm.runInContext(sliceFn(APP, "function buildLeaderboardMap(") + "\nthis.__buildLeaderboardMap = buildLeaderboardMap;", ctx);
  const state = {
    ctx: { year: "2026", leagueId: "74598" },
    players: { players: { player: fx.players } },
    viewerFranchiseId: "", franchises: [],
    playerScoresAll: opts.seasonPayload === undefined ? fx.playerScoresAll : opts.seasonPayload,
    lineupWeekResolution: opts.lineupWeek === undefined ? fx.lineup_week : opts.lineupWeek,
    playerScoresAllAt: fx.fetched_at_utc ? Date.parse(fx.fetched_at_utc) : 0,
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
    // PPG chip: "14.0 PPG · 3 MFL wks" (ranked) or "31.5 PPG" + "unranked · 1 MFL wk"
    // (below the rank minimum, 2026-10-02), or the pre-fix "PPG 0.0".
    const ppg = /(-?[\d.]+) PPG(?: · (\d+) (?:G|MFL wks?)\b)?/.exec(chunk) || /<span>PPG (-?[\d.]+)<\/span>/.exec(chunk);
    const unr = /unranked · (\d+) MFL wks?/.exec(chunk);
    const rk = /<span class="ups-m-fa-stat">#(\d+) (\w+)<\/span>/.exec(chunk);
    out[pid] = {
      order,
      pts: pts ? Number(pts[1]) : null,
      ppg: ppg ? Number(ppg[1]) : null,
      games: ppg && ppg[2] != null ? Number(ppg[2]) : (unr ? Number(unr[1]) : (/>0 (?:G|MFL wks)</.test(chunk) ? 0 : null)),
      unranked: !!unr,
      rank: rk ? Number(rk[1]) : null,
      rankGroup: rk ? rk[2] : null,
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

// Expected values for the Week 4 capture come from MFL's own W=YTD / W=AVG,
// never from W=ALL (the app's input), so these can't pass by self-agreement.
const posted = (fx, pid, maxWeek = 99) => fx.playerScoresAll.playerScoresAllWeeks.playerScores
  .filter((b) => Number(b.week) <= maxWeek && b.playerScore.some((s) => s.id === pid && s.score !== "")).length;
const wkScore = (fx, pid, w) => {
  const b = fx.playerScoresAll.playerScoresAllWeeks.playerScores.find((x) => x.week === String(w));
  const r = b && b.playerScore.find((s) => s.id === pid);
  return r && r.score !== "" ? Number(r.score) : null;
};
const nm4 = (pid) => (FX4.players.find((p) => p.id === pid) || {}).name || pid;

test("live week: every player's Season = MFL's W=YTD and PPG = W=AVG, Week 4 Thursday included (real 2026-10-02 capture)", () => {
  const r = rows(harness({ fx: FX4 }).html());
  let checked = 0, wk4 = 0, oldRuleWrong = 0;
  for (const [pid, ytd] of Object.entries(FX4.mfl_ytd)) {
    t.ok(r[pid], `${nm4(pid)} (${pid}) is listed`);
    t.equal(r[pid].pts, Math.round(Number(ytd) * 10) / 10, `${nm4(pid)} Season — MFL YTD says ${ytd}`);
    const avg = Number(FX4.mfl_avg[pid]);
    const g = posted(FX4, pid);
    t.equal(r[pid].games, g, `${nm4(pid)} MFL wks = every week MFL posted him (${g})`);
    if (g > 0) t.ok(Math.abs(r[pid].ppg - avg) <= 0.051, `${nm4(pid)} PPG ${r[pid].ppg} vs MFL AVG ${avg}`);
    if (FX4.week4_player_ids.includes(pid)) {
      wk4++;
      const wk13 = [1, 2, 3].reduce((acc, w) => acc + (wkScore(FX4, pid, w) || 0), 0);
      if (Math.round(wk13 * 10) !== Math.round(Number(ytd) * 10) || posted(FX4, pid, 3) !== g) oldRuleWrong++;
    }
    checked++;
  }
  t.equal(wk4, 76, "all 76 players with a Week 4 score are checked");
  t.equal(oldRuleWrong, 76, "every one of them reads differently on a Wks 1–3 basis (YTD and/or MFL wks)");
  t.ok(checked >= 110, `checked ${checked} players`);
});

test("named before/after on the live week — and players who haven't played Week 4 are unchanged", () => {
  const r = rows(harness({ fx: FX4 }).html());
  const cases = [
    // pid, who, MFL YTD, PPG shown, MFL wks        // before (Wks 1–3 only)
    ["16419", "Andre Szmyt (FA PK, CLE)", 40.7, 10.2, 4],          // 27.7 · 9.2 · 3
    ["13848", "Cam Johnston (FA PN, PIT)", 44.0, 11.0, 4],         // 29.0 · 9.7 · 3
    ["16216", "Darnell Washington (FA TE, PIT)", 32.2, 8.1, 4],    // 18.8 · 6.3 · 3
    ["13707", "Denzel Ward (FA CB, CLE)", 29.1, 7.3, 4],           // 18.4 · 6.1 · 3
    ["13288", "Rayshawn Jenkins (FA S, PIT) — 0.0 on Thursday", 17.8, 4.5, 4],   // 17.8 · 5.9 · 3
    ["14717", "Chase McLaughlin (FA PK, TBB) — no Week 4 game yet", 42.1, 14.0, 3],
    ["17075", "Matthew Golden (GBP) — no Week 4 game yet", 50.7, 16.9, 3],
  ];
  for (const [pid, who, pts, ppg, g] of cases) {
    t.equal(r[pid].pts, pts, `${who}: ${pts} pts`);
    t.equal(r[pid].ppg, ppg, `${who}: ${ppg} PPG`);
    t.equal(r[pid].games, g, `${who}: ${g} MFL wks`);
    t.equal(r[pid].pts, Math.round(Number(FX4.mfl_ytd[pid]) * 10) / 10, `${who}: = MFL W=YTD ${FX4.mfl_ytd[pid]}`);
  }
});

test("live week: the basis line says Week 4 is in progress, Last 2 is final-only, and when MFL was read", () => {
  const h = harness({ fx: FX4 });
  const html = h.html();
  t.match(html, /Season = MFL&#39;s YTD, league scoring, Wks 1–4 — Wk 4 in progress: games already played count/, "names the live week");
  t.match(html, /Last 2 wks = final weeks only/, "the finalized-week feature is labelled as such");
  const asOf = new Date(FX4_READ_AT).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  t.ok(html.includes("MFL as of " + asOf), `freshness: MFL as of ${asOf}`);
  t.doesNotMatch(html, /not counted/, "nothing posted is left out of Season");
  const ss = h.ctx.__getSeasonScoring();
  t.deepEqual([...ss.seasonWeeks], [1, 2, 3, 4]);
  t.deepEqual([...ss.finalWeeks], [1, 2, 3]);
  t.deepEqual([...ss.liveWeeks], [4]);
  t.equal(ss.fetchedAt, FX4_READ_AT);
});

test("Last 2 wks = the last two FINAL weeks — a live week never leaks into it", () => {
  const ss = harness({ fx: FX4 }).ctx.__getSeasonScoring();
  for (const pid of ["16419", "13848", "7836", "12263"]) {
    const l2 = ss.windowFor(2)[pid];
    const want = Math.round(((wkScore(FX4, pid, 2) || 0) + (wkScore(FX4, pid, 3) || 0)) * 10) / 10;
    t.equal(l2 ? l2.pts : 0, want, `${nm4(pid)}: Last 2 = Wk 2 + Wk 3 = ${want}`);
    t.ok(!(l2 && l2.weeks[4] != null), `${nm4(pid)}: no Week 4 in Last 2`);
  }
});

test("week check fails: Season is still MFL's YTD; Last-N windows are hidden, not guessed", () => {
  const h = harness({ fx: FX4, lineupWeek: null });
  const r = rows(h.html());
  t.equal(r["16419"].pts, 40.7, "Szmyt still matches MFL's YTD — it doesn't depend on which weeks are final");
  t.ok(!r["16419"].unavailable);
  t.match(h.html(), /couldn&#39;t confirm which weeks are final, so last-weeks totals are hidden/, "says why the windows are gone");
  t.doesNotMatch(h.html(), /data-win="2"/, "no Last 2 button");
  t.match(h.html(), /<span class="nm">Season<\/span><span class="wk">Wks 1–4<\/span>/, "Season button: the weeks, and no finality claim");
  t.doesNotMatch(h.html(), /class="st"/, "no live / final status anywhere");
  const ss = h.ctx.__getSeasonScoring();
  t.equal(ss.finalKnown, false);
  t.equal(Object.keys(ss.windowFor(2)).length, 0, "windowFor(2) is empty, not the season");
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

test("posted zero / negative scores are the season; unreadable ones fail closed, never the offseason fallback", () => {
  const SS = harness().ctx.UPS_MOBILE_SEASON_SCORING;
  for (const score of ["0.0", "-2.0"]) {
    const out = SS.build({ playerScoresAllWeeks: { playerScores: [
      { week: "1", playerScore: [{ id: "14717", score }] },
    ] } }, { completedWeek: null });
    t.equal(out.known, true, `${score} is a real MFL score`);
    t.equal(out.byPid["14717"].pts, Number(score));
    t.equal(out.byPid["14717"].games, 1);
    t.equal(out.finalKnown, false, "but no week is called final without the check");
  }
  const bad = SS.build({ playerScoresAllWeeks: { playerScores: [
    { week: "1", playerScore: [{ id: "14717", score: "not-a-number" }] },
  ] } }, { completedWeek: 0 });
  t.equal(bad.known, false, "posted-but-unreadable cannot become an offseason fallback");
  t.equal(bad.reason, "unreadable_scores");
  const blank = SS.build({ playerScoresAllWeeks: { playerScores: [
    { week: "1", playerScore: [{ id: "14717", score: "" }] },
  ] } }, { completedWeek: null });
  t.equal(blank.known, true, "a blank score is not a posted score");
  t.equal(blank.seasonWeeks.length, 0);
  t.equal(blank.reason, "no_scores_posted");
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

function sheetHarness(scoring) {
  const c = vm.createContext({});
  c.window = c;
  vm.runInContext(UTIL_SRC + "\nthis.U = { safeStr, safeInt, pad4, escapeHtml, fmtUsd, asArray };", c);
  vm.runInContext(read(SEASON_SCORING_JS), c);
  const sheet = read("site/m/player_sheet.js");
  vm.runInContext(["function renderStatsBlock(", "function statRowHtml(", "function liveSeasonRow("].map((s) => sliceFn(sheet, s)).join("\n") +
    "\nthis.renderStatsBlock = renderStatsBlock;", c);
  const byId = Object.fromEntries(FX4.players.map((p) => [p.id, p]));
  c.UPS_MOBILE = { state: { ctx: { year: 2026 }, _sheetPid: "16419" }, data: {
    getAdvancedStatsLatestYear: () => 2026,
    getSeasonScoring: () => scoring,
    getAdvancedStatsFor: () => null,
    playerById: (id) => byId[String(id)] || null,
  } };
  return c;
}

test("player sheet: the current-season row is MFL's YTD with the live week, or absent with a reason", () => {
  const staleBundle = { career_summary: [
    { season: 2026, games_played: 3, season_points: 0, avg_ppg: 0 },
    { season: 2025, games_played: 16, season_points: 152.8, avg_ppg: 9.55 },
  ] };
  const failed = { known: false, reason: "mfl_error", seasonWeeks: [], finalWeeks: [], liveWeeks: [], byPid: {} };
  const html = sheetHarness(failed).renderStatsBlock(staleBundle);
  t.doesNotMatch(html, /<td>2026<\/td>/, "no current-season row sourced from stale D1");
  t.match(html, /2026: points unavailable/, "sheet explains why current points are absent");
  t.match(html, /<td>2025<\/td>/, "prior season remains available");
  const none = { known: true, reason: "no_scores_posted", seasonWeeks: [], finalWeeks: [], liveWeeks: [], byPid: {} };
  const pre = sheetHarness(none).renderStatsBlock(staleBundle);
  t.doesNotMatch(pre, /<td>2026<\/td>/, "no current-season row before MFL posts a score");
  t.match(pre, /no scores posted yet/, "preseason reason is distinct");
  // Live week: the row the bid was priced on, Thursday included.
  const c = sheetHarness(null);
  const ss = c.UPS_MOBILE_SEASON_SCORING.build(FX4.playerScoresAll, { completedWeek: 3 });
  ss.season = 2026;
  c.UPS_MOBILE.data.getSeasonScoring = () => ss;
  const live = c.renderStatsBlock(staleBundle);
  t.match(live, /<td>2026<\/td><td>4<\/td><td>40\.7<\/td><td>10\.2<\/td>/, "Szmyt 2026: 4 MFL wks, 40.7, 10.2 PPG (MFL YTD / AVG)");
  t.match(live, /2026: MFL&#39;s YTD, league scoring, Wks 1–4 — Wk 4 in progress, games already played count/, "labelled");
});

test("Week 1 Thursday: the season has started — MFL's few posted scores, not last season's totals", () => {
  const prior = { "14717": { mfl_points: 152.8, mfl_ppg: 9.55, games: 16, pos: "PK", posRank: 13 } };
  const wk1 = { playerScoresAllWeeks: { year: "2026", playerScores: [
    { week: "1", playerScore: [{ id: "14717", week: "1", score: "11.0", isAvailable: "0" }] },
  ] } };
  const h = harness({ seasonPayload: wk1, lineupWeek: { ok: true, week: 1, source: "live_scoring" }, latestYear: 2025, priorMap: prior });
  const r = rows(h.html());
  t.equal(r["14717"].pts, 11.0, "McLaughlin's Thursday score is the season so far (= MFL's YTD)");
  t.equal(r["17075"].pts, 0, "a player who hasn't played yet: 0 so far, not last season");
  t.doesNotMatch(h.html(), /2025 season/, "no prior-season numbers once MFL has posted a 2026 score");
  t.match(h.html(), /Wk 1 in progress: games already played count/, "and it says Week 1 is in progress");
  t.doesNotMatch(h.html(), /data-win="2"/, "no final weeks yet → no Last 2");
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

// ── Freshness: app.js re-reads MFL's scores once they are 5+ minutes old ──
// The shipped refreshSeasonScoringIfStale + getSeasonScoring, with the network
// and the clock stubbed. MFL's YTD moves during games; a screen left open must
// not keep the morning's totals, and a FAILED re-read must not wipe them.
function refreshHarness({ at, scores, week }) {
  const c = vm.createContext({ JSON, Promise });
  c.window = c;
  vm.runInContext(read(SEASON_SCORING_JS), c);
  const clock = { t: FX4_READ_AT + 10 * 60 * 1000 };
  const calls = [];
  c.Date = { now: () => clock.t };
  c.state = { loaded: true, ctx: { year: "2026", leagueId: "74598" },
    playerScoresAll: FX4.playerScoresAll, playerScoresAllAt: at, lineupWeekResolution: FX4.lineup_week };
  c.mflExportUrl = (type, extra) => "mfl:" + type + ":" + extra.W;
  c.workerUrl = (p) => "worker:" + p;
  c.fetchJson = (u) => { calls.push(u); return Promise.resolve(typeof scores === "function" ? scores() : scores); };
  c.fetch = (u) => { calls.push(u); const w = typeof week === "function" ? week() : week;
    return Promise.resolve(w ? { ok: true, json: () => Promise.resolve(w) } : { ok: false }); };
  vm.runInContext("var safeInt = function (v, d) { var n = parseInt(v, 10); return isFinite(n) ? n : d; };\n" +
    "var seasonScoringRefresh = null, seasonScoringTriedAt = 0;\n" +
    sliceFn(APP, "function getSeasonScoring(") + "\n" + sliceFn(APP, "function refreshSeasonScoringIfStale(") +
    "\nthis.get = getSeasonScoring; this.refresh = refreshSeasonScoringIfStale;", c);
  return { c, clock, calls };
}
// Sunday: McLaughlin's TBB game is scored (+9.0) — MFL's YTD moved.
function withSundayScore() {
  const fx = deepClone(FX4.playerScoresAll);
  fx.playerScoresAllWeeks.playerScores.find((b) => b.week === "4").playerScore.push({ id: "14717", week: "4", score: "9.0", isAvailable: "0" });
  return fx;
}
const FIVE_MIN = 5 * 60 * 1000;

test("freshness: under 5 minutes old → no re-read at all", async () => {
  const h = refreshHarness({ at: FX4_READ_AT, scores: withSundayScore(), week: FX4.lineup_week });
  h.clock.t = FX4_READ_AT + 4 * 60 * 1000;
  t.equal(await h.c.refresh(FIVE_MIN), false);
  t.equal(h.calls.length, 0, "nothing fetched");
});

test("freshness: stale → re-read; MFL's new YTD and the new 'as of' time replace the old ones", async () => {
  const h = refreshHarness({ at: FX4_READ_AT, scores: withSundayScore(), week: FX4.lineup_week });
  t.equal(h.c.get().byPid["14717"].pts, 42.1, "before: 42.1");
  const [a, b] = [h.c.refresh(FIVE_MIN), h.c.refresh(FIVE_MIN)];
  t.equal(a, b, "two callers share one in-flight read");
  t.equal(await a, true, "changed → the caller re-renders");
  t.equal(h.calls.length, 2, "one W=ALL read + one week check");
  t.equal(h.c.get().byPid["14717"].pts, 51.1, "after: 42.1 + Sunday's 9.0");
  t.equal(h.c.get().byPid["14717"].games, 4);
  t.equal(h.c.get().fetchedAt, h.clock.t, "'MFL as of' moves to the new read");
  // Unchanged on the next stale read → no re-render asked for.
  h.clock.t += 6 * 60 * 1000;
  t.equal(await h.c.refresh(FIVE_MIN), false, "same numbers → false");
});

test("freshness: a failed or error re-read keeps the numbers AND their older 'as of' time", async () => {
  for (const [label, scores] of [["network failure", null], ["MFL error envelope", { error: { $t: "busy" } }], ["no payload", {}]]) {
    const h = refreshHarness({ at: FX4_READ_AT, scores, week: FX4.lineup_week });
    const before = h.c.get();
    t.equal(await h.c.refresh(FIVE_MIN), false, `${label}: nothing to re-render`);
    t.equal(h.c.state.playerScoresAll, FX4.playerScoresAll, `${label}: scores kept`);
    t.equal(h.c.state.playerScoresAllAt, FX4_READ_AT, `${label}: 'as of' NOT re-stamped as fresh`);
    t.equal(h.c.get(), before, `${label}: same scoring object`);
    t.equal(h.c.get().byPid["16419"].pts, 40.7, `${label}: Szmyt still 40.7`);
    // And it does not hammer a dead MFL on every render.
    t.equal(await h.c.refresh(FIVE_MIN), false);
    t.equal(h.calls.length, 2, `${label}: no second attempt inside a minute`);
    h.clock.t += 61 * 1000;
    await h.c.refresh(FIVE_MIN);
    t.equal(h.calls.length, 4, `${label}: retried after a minute`);
  }
});

test("freshness: new scores with a failed week check → no week is called final (Last-N hidden)", async () => {
  const h = refreshHarness({ at: FX4_READ_AT, scores: withSundayScore(), week: null });
  t.equal(await h.c.refresh(FIVE_MIN), true);
  const ss = h.c.get();
  t.equal(ss.byPid["14717"].pts, 51.1, "Season = MFL's new YTD regardless");
  t.equal(ss.finalKnown, false, "the old 'Wks 1–3 final' is not carried onto scores read later");
  t.equal(Object.keys(ss.windowFor(2)).length, 0);
});

await run("mobile players MFL scoring");

// Also lets a read-only browser layout check render these exact shipped rows.
export { harness };
