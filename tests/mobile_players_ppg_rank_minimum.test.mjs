// Players market — a PPG RANK needs a minimum of MFL scored weeks.
//   node tests/mobile_players_ppg_rank_minimum.test.mjs
//   PLAYERS_JS=<another players.js> SEASON_SCORING_JS=<another season_scoring.js> (same idea)
//
// Keith 2026-10-02: Case Keenum read "#3 QB" off a single 31.5-point start and
// Brock Bowers "#1 TE" off one game. The rule he chose:
//   - Season: ranked only with MFL wks >= half the FINAL weeks, rounded up.
//     MFL's posted 0.0 weeks count (as in its own AVG); a week still being
//     played counts toward a player's MFL wks but not toward the bar.
//   - Last 2/4/6 wks: half the window (1 / 2 / 3).
//   - Below it: no "#N" badge, the real PPG stays, and the rank slot reads
//     "unranked · 1 MFL wk". Sort: PPG lists every ranked player first.
//
// Real data: tests/fixtures/mobile_players_ppg_rank_2026_wk4.json (read-only
// MFL capture 2026-10-02 14:54Z, all 1,371 scored players, Wks 1–3 final +
// Week 4 Thursday). Byes and the window cases use small synthetic seasons,
// rendered through the REAL players.js / season_scoring.js / app.js code.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.isAbsolute(p) ? p : path.join(ROOT, p), "utf8");
const PLAYERS_JS = process.env.PLAYERS_JS || "site/m/views/players.js";
const SEASON_SCORING_JS = process.env.SEASON_SCORING_JS || "site/m/season_scoring.js";
const APP = read("site/m/app.js");
const RAW = JSON.parse(read("tests/fixtures/mobile_players_ppg_rank_2026_wk4.json"));

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

// { weeks: {wk: {pid: score}}, players: {pid: [name, pos, team]}, rosters, lineup_week } → MFL shapes.
function expand(fx) {
  return {
    playerScoresAll: { playerScoresAllWeeks: { year: "2026", playerScores: Object.entries(fx.weeks).map(([w, m]) =>
      ({ week: String(w), playerScore: Object.entries(m).map(([id, score]) => ({ id, week: String(w), score: String(score) })) })) } },
    players: Object.entries(fx.players).map(([id, [name, position, team]]) => ({ id, name, position, team })),
    rosters: fx.rosters || {},
    lineup_week: fx.lineup_week,
    fetchedAt: fx.fetched_at_utc ? Date.parse(fx.fetched_at_utc) : 0,
  };
}
const REAL = expand(RAW);
const pidOf = (name) => Object.keys(RAW.players).find((id) => RAW.players[id][0] === name);

// The real players view over `data`, with clickable period / position buttons
// and real filter / sort / search controls (same fake DOM as the controls test).
function harness(data) {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout });
  ctx.window = ctx;
  vm.runInContext(UTIL_SRC + "\nthis.__util = { safeStr, safeInt, pad4, escapeHtml, fmtUsd, asArray };", ctx);
  vm.runInContext(read(SEASON_SCORING_JS), ctx);
  const state = {
    ctx: { year: "2026", leagueId: "74598" }, players: { players: { player: data.players } },
    viewerFranchiseId: "", franchises: [],
    playerScoresAll: data.playerScoresAll, lineupWeekResolution: data.lineup_week,
    playerScoresAllAt: data.fetchedAt || 0, lineupWeek: 4,
  };
  ctx.state = state;
  vm.runInContext("var safeInt = this.__util.safeInt;\n" + sliceFn(APP, "function getSeasonScoring(") +
    "\nthis.__getSeasonScoring = getSeasonScoring;", ctx);
  const byId = Object.fromEntries(data.players.map((p) => [p.id, p]));
  const rostered = new Set(Object.keys(data.rosters));
  ctx.UPS_MOBILE = {
    util: ctx.__util, state,
    data: {
      getAllRosteredPids: () => rostered, getSeasonScoring: () => ctx.__getSeasonScoring(),
      getAdvancedStatsMap: () => ({}), getAdvancedStatsLatestYear: () => 2026, getYtdScoresMap: () => ({}),
      playerById: (pid) => byId[String(pid)] || null,
      computeCap: () => null, rosterCapMax: () => 30, getRosterFor: () => [], dropPenaltyFor: () => null,
    },
    hotCold: { get: () => ({ hot: {}, cold: {} }), isLoading: () => false, fetch: () => Promise.resolve() },
    ui: { showToast() {} },
    route: { registerView: (n, fn) => { if (n === "players") ctx.__render = fn; }, renderRoute: () => ctx.__render(mount, []), navigate() {} },
  };
  const els = {};
  const control = (id) => els[id] || (els[id] = { id, value: "", listeners: {}, focus() {}, setSelectionRange() {},
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    fire(type) { (this.listeners[type] || []).forEach((fn) => fn.call(this, { target: this })); } });
  let buttons = {};
  const mount = {
    innerHTML: "", querySelector: () => null,
    querySelectorAll(sel) {
      const attr = /data-win/.test(sel) ? "data-win" : (/ups-m-pos-chip/.test(sel) ? "data-pos" : null);
      if (!attr) return [];
      const out = [];
      for (const m of mount.innerHTML.matchAll(new RegExp('<button class="[^"]*"[^>]*' + attr + '="([^"]+)"', "g"))) {
        out.push({ listeners: [], getAttribute: (a) => (a === attr ? m[1] : null),
          addEventListener(type, fn) { if (type === "click") this.listeners.push(fn); } });
      }
      buttons[attr] = out;
      return out;
    },
  };
  ctx.document = {
    getElementById: (id) => (["ups-m-players-filter", "ups-m-players-sort", "ups-m-players-search"].includes(id) ? control(id) : null),
    addEventListener() {}, activeElement: null, body: { style: {} },
  };
  vm.runInContext(read(PLAYERS_JS), ctx);
  ctx.__render(mount, []);
  const select = (id, value) => { const c = control(id); c.value = value; c.fire("change"); };
  const click = (attr, v) => {
    const el = (buttons[attr] || []).find((b) => b.getAttribute(attr) === String(v));
    if (!el) throw new Error(`no ${attr}=${v} button is rendered`);
    el.listeners.forEach((fn) => fn.call(el, { stopPropagation() {} }));
  };
  select("ups-m-players-filter", "all");                   // rostered + free agents
  const html = () => mount.innerHTML;
  // Each rendered row: pid, shown PPG, MFL wks, rank (or unranked), in list order.
  const rows = () => html().split('<div class="ups-m-fa-row').slice(1).map((chunk, order) => {
    const pid = (/data-pid="(\d+)"/.exec(chunk) || [])[1];
    const ppg = /(-?[\d.]+) PPG(?: · (\d+) MFL wks?)?</.exec(chunk);
    const unr = /unranked · (\d+) MFL wks?/.exec(chunk);
    const rk = /<span class="ups-m-fa-stat">#(\d+) (\w+)<\/span>/.exec(chunk);
    return { pid, order, ppg: ppg ? Number(ppg[1]) : null,
      games: ppg && ppg[2] ? Number(ppg[2]) : (unr ? Number(unr[1]) : null),
      unranked: !!unr, rank: rk ? Number(rk[1]) : null, group: rk ? rk[2] : null, chunk };
  });
  const row = (pid) => rows().find((r) => r.pid === String(pid));
  return { ctx, html, rows, row, select, click, ss: () => ctx.__getSeasonScoring() };
}

// A synthetic season: final weeks 1..F, live week F+1 (scores in `live`).
function season(F, players, liveWeek = true) {
  const weeks = {};
  for (let w = 1; w <= F + (liveWeek ? 1 : 0); w++) weeks[w] = {};
  const meta = {};
  for (const [id, name, pos, wk] of players) {
    meta[id] = [name, pos, "TST"];
    for (const [w, sc] of Object.entries(wk)) weeks[w][id] = sc;
  }
  // Week-filler so every week has posted scores even if no test player played.
  meta["90000"] = ["Filler, Weekly", "QB", "TST"];
  for (const w of Object.keys(weeks)) weeks[w]["90000"] = "1.0";
  return expand({ weeks, players: meta, rosters: {}, lineup_week: { ok: true, week: F + 1, source: "live_scoring" } });
}

test("rankMinimum: half the FINAL weeks, rounded up (never below 1); Last N = half the window", () => {
  const SS = harness(season(3, [])).ctx.UPS_MOBILE_SEASON_SCORING;
  const want = { 0: 1, 1: 1, 2: 1, 3: 2, 4: 2, 5: 3, 6: 3, 7: 4, 8: 4, 10: 5, 16: 8, 17: 9, 18: 9 };
  for (const [F, min] of Object.entries(want)) {
    const blocks = [];
    for (let w = 1; w <= Number(F) + 1; w++) blocks.push({ week: String(w), playerScore: [{ id: "1", score: "5.0" }] });
    const ss = SS.build({ playerScoresAllWeeks: { playerScores: blocks } }, { completedWeek: Number(F) });
    t.equal(ss.rankMinimum(0), min, `${F} final weeks (+1 live) → ${min}+ MFL wks`);
  }
  const ss = SS.build({ playerScoresAllWeeks: { playerScores: [1, 2, 3, 4, 5, 6, 7, 8].map((w) =>
    ({ week: String(w), playerScore: [{ id: "1", score: "5.0" }] })) } }, { completedWeek: 7 });
  t.equal(ss.rankMinimum(2), 1, "Last 2 → 1");
  t.equal(ss.rankMinimum(4), 2, "Last 4 → 2");
  t.equal(ss.rankMinimum(6), 3, "Last 6 → 3");
  // No week confirmed final: every posted week is the base — stricter, never looser.
  const five = SS.build({ playerScoresAllWeeks: { playerScores: [1, 2, 3, 4, 5].map((w) =>
    ({ week: String(w), playerScore: [{ id: "1", score: "5.0" }] })) } }, { completedWeek: null });
  t.equal(five.rankMinimum(0), 3, "5 posted weeks, finality unknown → 3 (the true rule could only be 2 or 3)");
});

test("real Week 4: one-week players keep their real PPG but read 'unranked · 1 MFL wk' — Keenum, Bowers, Collins", () => {
  const h = harness(REAL);
  t.equal(h.ss().rankMinimum(0), 2, "3 final weeks → 2+ MFL wks");
  for (const [name, pos, ppg] of [["Keenum, Case", "QB", 31.5], ["Bowers, Brock", "TE", 36.0], ["Collins, Nico", "WR", 22.0]]) {
    h.click("data-pos", pos);
    const r = h.row(pidOf(name));
    t.ok(r, `${name} is listed`);
    t.equal(r.ppg, ppg, `${name}: real PPG ${ppg} still shown`);
    t.ok(r.unranked, `${name}: unranked`);
    t.equal(r.games, 1, `${name}: · 1 MFL wk`);
    t.equal(r.rank, null, `${name}: no #N badge`);
    t.match(r.chunk, /unranked · 1 MFL wk</, `${name}: the exact label`);
  }
});

test("real Week 4: the ranks close up — Shough #3 QB, McBride #1 TE; 143 of 1,371 unranked, from MFL's own rows", () => {
  const h = harness(REAL);
  h.click("data-pos", "QB");
  t.equal(h.row(pidOf("Allen, Josh")).rank, 1, "Allen #1 QB");
  t.equal(h.row(pidOf("Purdy, Brock")).rank, 2, "Purdy #2 QB");
  t.equal(h.row(pidOf("Shough, Tyler")).rank, 3, "Shough #3 QB (was #4 behind Keenum)");
  h.click("data-pos", "TE");
  t.equal(h.row(pidOf("McBride, Trey")).rank, 1, "McBride #1 TE (was #2 behind Bowers)");
  // Independent count from the raw MFL rows: fantasy-position players with < 2 posted weeks.
  const FANTASY = new Set(["QB", "RB", "WR", "TE", "PK", "PN", "DE", "DT", "LB", "CB", "S"]);
  const rowsBy = {};
  for (const m of Object.values(RAW.weeks)) for (const id of Object.keys(m)) rowsBy[id] = (rowsBy[id] || 0) + 1;
  const expected = Object.keys(rowsBy).filter((id) => FANTASY.has(RAW.players[id][1]) && rowsBy[id] < 2);
  t.equal(expected.length, 143, "143 players have one posted MFL week");
  const ss = h.ss(), SS = h.ctx.UPS_MOBILE_SEASON_SCORING;
  const ranked = SS.rankMap(ss.byPid, (id) => (FANTASY.has(RAW.players[id] && RAW.players[id][1]) ? RAW.players[id][1] : ""), ss.rankMinimum(0));
  t.equal(expected.filter((id) => ranked[id]).length, 0, "none of them holds a rank");
  t.equal(Object.keys(ranked).length, Object.keys(rowsBy).filter((id) => FANTASY.has(RAW.players[id][1])).length - 143,
    "everyone else does");
});

test("Sort: PPG — every ranked player first, then the unranked by PPG; Total pts is untouched", () => {
  const h = harness(REAL);
  h.click("data-pos", "QB");
  const list = h.rows().filter((r) => r.ppg != null);
  const firstUnranked = list.findIndex((r) => r.unranked);
  t.ok(firstUnranked > 0, "the list starts with ranked QBs");
  t.ok(list.slice(firstUnranked).every((r) => r.unranked), "nothing ranked after the first unranked QB");
  const ranked = list.slice(0, firstUnranked).map((r) => r.ppg), unranked = list.slice(firstUnranked).map((r) => r.ppg);
  t.deepEqual(ranked, [...ranked].sort((a, b) => b - a), "ranked block in PPG order");
  t.deepEqual(unranked, [...unranked].sort((a, b) => b - a), "unranked block in PPG order");
  t.equal(list[firstUnranked].pid, pidOf("Keenum, Case"), "Keenum (31.5) leads the unranked block");
  t.ok(list.slice(0, firstUnranked).some((r) => r.ppg < 31.5), "…below ranked QBs with a lower PPG");
  h.select("ups-m-players-sort", "pts");
  const pts = h.rows().map((r) => r.pid);
  t.ok(pts.indexOf(pidOf("Keenum, Case")) > pts.indexOf(pidOf("Allen, Josh")), "Total pts still sorts by points");
});

test("live week: it counts toward a player's MFL wks, never toward the bar", () => {
  // Week 5 Thursday: 4 final weeks → 2+ (NOT half of 5 = 3).
  const d = season(4, [
    ["101", "Steady, Four", "RB", { 1: "10.0", 2: "10.0", 3: "10.0", 4: "10.0" }],
    ["102", "Thursday, Second", "RB", { 2: "12.0", 5: "12.0" }],          // 1 final + Thursday = 2
    ["103", "Thursday, Only", "RB", { 5: "25.0" }],                        // Thursday only = 1
  ]);
  const h = harness(d);
  t.equal(h.ss().rankMinimum(0), 2, "4 final weeks + a live week → 2, not 3");
  h.click("data-pos", "RB");
  t.ok(h.row("102").rank > 0, "1 final week + Thursday = 2 MFL wks → ranked");
  t.ok(h.row("103").unranked && h.row("103").games === 1, "Thursday only → unranked · 1 MFL wk");
  t.equal(h.row("103").ppg, 25.0, "…with his real 25.0 PPG");
  // Real data: Lew Nichols (1 final week + Thursday's 2.0).
  const r = harness(REAL);
  r.click("data-pos", "RB");
  const nichols = r.row(pidOf("Nichols, Lew"));
  t.ok(nichols && nichols.rank > 0 && nichols.games === 2, "Lew Nichols: Wk 1 + Wk 4 Thursday = 2 MFL wks → ranked");
});

test("byes: a bye is just a week without a row — one bye passes, a bye plus missed games doesn't", () => {
  // 8 final weeks (→ 4+), live Week 9.
  const d = season(8, [
    ["201", "Regular, Bye", "RB", { 1: "8", 2: "8", 3: "8", 4: "8", 5: "8", 6: "8", 8: "8" }],     // bye 7 → 7 wks
    ["202", "Missed, ByePlus", "RB", { 1: "15", 2: "15", 8: "15" }],                              // bye 7 + 3–6 out → 3
    ["203", "Live, Tipped", "RB", { 1: "9", 2: "9", 8: "9", 9: "9" }],                            // same + Thursday → 4
  ]);
  const h = harness(d);
  t.equal(h.ss().rankMinimum(0), 4, "8 final weeks → 4+");
  h.click("data-pos", "RB");
  t.ok(h.row("201").rank > 0, "a bye week alone doesn't cost a rank (7 MFL wks)");
  const missed = h.row("202");
  t.ok(missed.unranked && missed.games === 3, "bye + four missed → unranked · 3 MFL wks");
  t.equal(missed.ppg, 15.0, "…still showing his real 15.0 PPG");
  t.match(missed.chunk, /unranked · 3 MFL wks</);
  t.ok(h.row("203").rank > 0, "the same line plus Thursday's game → 4 MFL wks → ranked");
});

test("0.0 weeks are MFL wks: they count toward the minimum and pull the PPG down", () => {
  const d = season(3, [
    ["301", "Zero, Triple", "RB", { 1: "0.0", 2: "0.0", 3: "0.0" }],       // 3 wks, 0.0 PPG
    ["302", "Zero, Partly", "RB", { 1: "10.0", 2: "0.0" }],                // 2 wks, 5.0 PPG
    ["303", "One, Big", "RB", { 3: "20.0" }],                              // 1 wk, 20.0 PPG
    ["304", "Two, Good", "RB", { 2: "12.0", 3: "12.0" }],                  // 2 wks, 12.0 PPG
  ], false);                                                               // Tuesday: nothing live
  const h = harness(d);
  t.equal(h.ss().rankMinimum(0), 2, "3 final weeks → 2+");
  h.click("data-pos", "RB");
  t.deepEqual([h.row("304").rank, h.row("302").rank, h.row("301").rank], [1, 2, 3], "ranked 12.0, 5.0, 0.0 — the 0.0 weeks qualify him");
  t.equal(h.row("302").ppg, 5.0, "a 0.0 week halves Partly's PPG, exactly as MFL's AVG");
  t.ok(h.row("303").unranked, "the one-week 20.0 is unranked");
  const order = h.rows().filter((r) => ["301", "302", "303", "304"].includes(r.pid)).map((r) => r.pid);
  t.deepEqual(order, ["304", "302", "301", "303"], "Sort: PPG — even a ranked 0.0 sits above the unranked 20.0");
});

test("Last 2 / 4 / 6 wks: the minimum is half the window — 1, 2, 3", () => {
  // 7 final weeks (L2 = Wks 6–7, L4 = Wks 4–7, L6 = Wks 2–7 all offered), live Week 8.
  const d = season(7, [
    ["401", "Window, Once", "RB", { 1: "5", 7: "30" }],                      // L2 1 · L4 1 · L6 1
    ["402", "Window, Thrice", "RB", { 1: "6", 4: "6", 6: "6", 7: "6" }],      // L4 3 · L6 3
    ["403", "Window, Early", "RB", { 1: "9", 2: "9", 3: "9", 4: "9", 5: "9" }], // L2 0 · L4 2 · L6 4
    ["404", "Window, Twice", "RB", { 2: "7", 6: "7" }],                       // L6 2
  ]);
  const h = harness(d);
  h.click("data-pos", "RB");
  h.click("data-win", 2);
  t.ok(h.row("401").rank > 0, "Last 2: one game (min 1) → ranked");
  t.equal(h.row("403").games, null, "Last 2: no game in the window → no PPG at all (not 'unranked')");
  t.match(h.html(), /PPG rank needs 1\+ MFL wk in the last 2/, "basis states the Last 2 minimum");
  h.click("data-win", 4);
  t.ok(h.row("401").unranked && h.row("401").games === 1, "Last 4: one game (min 2) → unranked · 1 MFL wk");
  t.equal(h.row("401").ppg, 30.0, "…with his real 30.0 window PPG");
  t.ok(h.row("403").rank > 0, "Last 4: two games → ranked");
  t.match(h.html(), /PPG rank needs 2\+ MFL wks in the last 4/);
  h.click("data-win", 6);
  t.ok(h.row("404").unranked && h.row("404").games === 2, "Last 6: two games (min 3) → unranked · 2 MFL wks");
  t.ok(h.row("402").rank > 0, "Last 6: three games → ranked");
  t.match(h.html(), /PPG rank needs 3\+ MFL wks in the last 6/);
  h.click("data-win", 0);
  t.match(h.html(), /PPG rank needs 4\+ MFL wks \(half the 7 final weeks, rounded up\)/, "Season: 4+");
  t.ok(h.row("402").rank > 0 && h.row("403").rank > 0, "Season: 4 and 5 MFL wks → ranked");
  t.ok(h.row("401").unranked && h.row("404").unranked, "Season: 2 MFL wks → unranked");
});

test("player card: the current-season PPG Rk follows the same rule", () => {
  const c = vm.createContext({});
  c.window = c;
  vm.runInContext(UTIL_SRC + "\nthis.U = { safeStr, safeInt, pad4, escapeHtml, fmtUsd, asArray };", c);
  vm.runInContext(read(SEASON_SCORING_JS), c);
  const sheet = read("site/m/player_sheet.js");
  vm.runInContext(["function renderStatsBlock(", "function statRowHtml(", "function liveSeasonRow("].map((s) => sliceFn(sheet, s)).join("\n") +
    "\nthis.renderStatsBlock = renderStatsBlock;", c);
  const fol = read("site/m/front_office_lineup.js");
  vm.runInContext(fol.slice(fol.indexOf("function safeStr("), fol.indexOf("// The 18 starting slots")) +
    "\nthis.UPS_FRONT_OFFICE_LINEUP = { posGroup: posGroup };", c);
  const byId = Object.fromEntries(REAL.players.map((p) => [p.id, p]));
  const SS = c.UPS_MOBILE_SEASON_SCORING;
  const card = (pid) => {
    const ss = SS.build(REAL.playerScoresAll, { completedWeek: SS.completedWeekFrom(REAL.lineup_week) });
    ss.season = 2026;
    c.UPS_MOBILE = { state: { ctx: { year: 2026 }, _sheetPid: pid }, data: {
      getAdvancedStatsLatestYear: () => 2026, getSeasonScoring: () => ss, getAdvancedStatsFor: () => null,
      playerById: (id) => byId[String(id)] || null } };
    return c.renderStatsBlock({ career_summary: [] });
  };
  const keenum = card(pidOf("Keenum, Case"));
  t.match(keenum, /<td>2026<\/td><td>1<\/td><td>31\.5<\/td><td>31\.5<\/td><td>unranked<\/td>/, "Keenum 2026: 1 MFL wk, 31.5, 31.5 PPG, unranked");
  t.match(keenum, /PPG rank needs 2\+ MFL wks/, "the card says why");
  t.match(card(pidOf("Allen, Josh")), /<td>2026<\/td><td>3<\/td><td>110\.4<\/td><td>36\.8<\/td><td>1<\/td>/, "Allen 2026: #1");
  t.match(card(pidOf("Shough, Tyler")), /<td>2026<\/td><td>3<\/td><td>[\d.]+<\/td><td>[\d.]+<\/td><td>3<\/td>/, "Shough 2026: #3");
});

await run("mobile_players_ppg_rank_minimum");
