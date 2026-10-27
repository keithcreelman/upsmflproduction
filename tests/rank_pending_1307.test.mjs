// Season ranks pending the clean recount are held back from /api/player-bundle (#1307).
//   node tests/rank_pending_1307.test.mjs
//
// Batch 1A restores 2025's missing playoff-week scores. For 1,059 more 2025
// player-seasons the weekly total then equals src_pointssummary's own basis,
// and every live player screen (desktop profile, FO v2, Roster Workbench,
// Rookie Hub, Team Operations, mobile sheet) prints pos_rank / pos_ppg_rank.
// The 253 Pts and 448 PPG ranks that differ from a clean recount must not look
// verified: the bundle returns them as null with rank_pending, and every
// screen shows "—" (never a number, never 0). Points, PPG, every other row,
// field and season are untouched.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const m = await import(pathToFileURL(path.join(ROOT, "worker/src/rank_pending.js")).href);
const NOTE = "Rank pending historical reconciliation";

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
const sliceLine = (src, sig) => { const at = src.indexOf(sig); assert.ok(at >= 0, sig); return src.slice(at, src.indexOf("\n", at)); };

assert.deepEqual(m.rankPendingCounts(), { 2025: { pos_rank: 253, pos_ppg_rank: 448 } });

// ── The worker transform ──
// Jalen Royals 2025 (WR; stored 211 / 225, clean recount 208 / 224): both held.
const royals = m.applyRankPending("17086", { season: 2025, pos_group: "WR", pos_rank: 211, pos_ppg_rank: 225, season_points: 1.8, avg_ppg: 0.3, games_played: 6 });
assert.equal(royals.pos_rank, null);
assert.equal(royals.pos_ppg_rank, null);
assert.deepEqual(royals.rank_pending, { fields: ["pos_rank", "pos_ppg_rank"], reason: m.RANK_PENDING_REASON });
assert.ok(m.RANK_PENDING_REASON.startsWith(NOTE));
assert.equal(royals.season_points, 1.8);  // scores are never touched
assert.equal(royals.avg_ppg, 0.3);
assert.equal(royals.games_played, 6);
// Jaleel McLaughlin 2025 (RB; Pts stored 94, clean 93; PPG 86 = clean): only Pts held.
assert.deepEqual(m.applyRankPending("16390", { season: 2025, pos_rank: 94, pos_ppg_rank: 86 }).rank_pending.fields, ["pos_rank"]);
// Barrett Carter 2025 (LB; Pts 40 = clean; PPG stored 54, clean 55): only PPG held.
assert.deepEqual(m.applyRankPending("17124", { season: 2025, pos_rank: 40, pos_ppg_rank: 54 }).rank_pending.fields, ["pos_ppg_rank"]);
// Dak Prescott 2025 (QB 4 / 5 = the clean recount): unchanged, same object.
const dak = { season: 2025, pos_rank: 4, pos_ppg_rank: 5 };
assert.equal(m.applyRankPending("12620", dak), dak);
// Another season is never touched, even for a listed id.
const other = { season: 2024, pos_rank: 88, pos_ppg_rank: 80 };
assert.equal(m.applyRankPending("16390", other), other);
// A rank that is already null is not reported as held.
assert.equal(m.applyRankPending("17086", { season: 2025, pos_rank: null, pos_ppg_rank: null }).rank_pending, undefined);
// Numeric ids and string seasons behave the same.
assert.equal(m.applyRankPending(17086, { season: "2025", pos_rank: 211, pos_ppg_rank: 225 }).pos_rank, null);

// The bundle applies it on its D1 path, the only path that carries ranks.
const idx = read("worker/src/index.js");
assert.ok(idx.includes('import { applyRankPending } from "./rank_pending.js";'));
assert.ok(idx.includes("bundle.career_summary = career.map((row) => applyRankPending(pid, row));"));

// Career rows as the bundle serves them after the transform.
const career = (pid, rows) => rows.map((r) => m.applyRankPending(pid, r));
const ROYALS = career("17086", [{ season: 2025, pos_group: "WR", games_played: 6, season_points: 1.8, avg_ppg: 0.3, pos_rank: 211, pos_ppg_rank: 225 }]);
const MCL = career("16390", [
  { season: 2025, pos_group: "RB", games_played: 7, season_points: 26.1, avg_ppg: 3.73, pos_rank: 94, pos_ppg_rank: 86 },
  { season: 2024, pos_group: "RB", games_played: 16, season_points: 120.4, avg_ppg: 7.53, pos_rank: 51, pos_ppg_rank: 62 },
]);
const DAK = career("12620", [
  { season: 2025, pos_group: "QB", games_played: 16, season_points: 409.3, avg_ppg: 25.58, pos_rank: 4, pos_ppg_rank: 5 },
  { season: 2024, pos_group: "QB", games_played: 8, season_points: 151.2, avg_ppg: 18.9, pos_rank: 33, pos_ppg_rank: 20 },
]);
const tds = (html) => [...html.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)].map((x) => ({ attr: x[1], text: x[2].replace(/<[^>]+>/g, "") }));

// ── Desktop player profile (both career tables) ──
{
  const src = read("site/shared/player_profile_master.js");
  const c = vm.createContext({});
  vm.runInContext([sliceFn(src, "function escapeHtml("), sliceLine(src, "var RANK_PENDING_NOTE"), sliceLine(src, "var RANK_PENDING_LABEL"),
    sliceFn(src, "function rankPendingAttr("), sliceFn(src, "function rankPendingNoteHtml("),
    sliceFn(src, "function buildScoringStatsHtml("), sliceFn(src, "function buildCompactScoringTableHtml(")].join("\n") +
    "\nthis.full = function (career) { return buildScoringStatsHtml({ career_summary: career }, {}, 'x', 'x'); };" +
    "\nthis.compact = buildCompactScoringTableHtml;", c);
  for (const [name, render, ptsCol, ppgCol] of [["full", (k) => c.full(k), 4, 6], ["compact", (k) => c.compact(k, {}), 3, 5]]) {
    const r = tds(render(ROYALS));
    assert.equal(r[ptsCol].text, "—", name + ": held Pts Rk is a dash");
    assert.equal(r[ppgCol].text, "—", name + ": held PPG Rk is a dash");
    assert.match(r[ptsCol].attr, new RegExp('title="' + NOTE + '"'));
    assert.match(render(ROYALS), new RegExp("2025 Pts Rk, PPG Rk: " + NOTE));
    assert.equal(r[ptsCol - 1].text, "2", name + ": points still shown");
    const mc = tds(render(MCL));
    assert.equal(mc[ptsCol].text, "—", name + ": McLaughlin 2025 Pts Rk held");
    assert.equal(mc[ppgCol].text, "#86", name + ": his PPG Rk is not held");
    assert.equal(mc[ppgCol].attr.includes("title"), false);
    const d = tds(render(DAK)).map((x) => x.text);
    assert.ok(d.includes("#4") && d.includes("#5") && d.includes("#33") && d.includes("#20"), name + ": Dak 2025 and 2024 ranks unchanged");
    assert.doesNotMatch(render(DAK), new RegExp(NOTE), name + ": no note when nothing is held");
  }
}

// ── Front Office v2 player panel (Stats sub-tab): the panel's season rows (fo_player_modal.js, #1353) ──
{
  const c = vm.createContext({});
  c.window = c;
  for (const f of ["site/m/season_scoring.js", "site/shared/player_facts.js", "site/shared/taxi_rule.js", "site/rosters/v2/fo_player_modal.js"]) vm.runInContext(read(f), c);
  const M = c.UPS_FO_MODAL;
  const withBasis = (rows) => rows.map((r) => ({ ...r, rank_basis_points: r.season_points, rank_basis_games: r.games_played }));
  const plain = (x) => JSON.parse(JSON.stringify(x));
  const roy = plain(M.seasonRows(withBasis(ROYALS), null, 2026))[0];
  assert.deepEqual([roy.ptsRank, roy.ppgRank], [null, null], "held ranks are never a number");
  assert.match(roy.notes.join(" "), new RegExp("2025 Pts Rk, PPG Rk: " + NOTE), "the note names the held ranks");
  assert.equal(roy.pts, 1.8, "points still shown");
  assert.equal(roy.games, 6);
  const mcl = plain(M.seasonRows(withBasis(MCL), null, 2026)).find((r) => r.season === 2025);
  assert.equal(mcl.ptsRank, null, "McLaughlin 2025 Pts Rk held");
  // 7 MFL weeks is under the panel's own half-season rule for a PPG rank, so that cell is "—" for that reason; the hold names Pts Rk only.
  assert.doesNotMatch(mcl.notes.join(" "), /PPG Rk: Rank pending/, "his PPG Rk is not named as held");
  assert.match(mcl.notes.join(" "), new RegExp("2025 Pts Rk: " + NOTE));
  const dak = plain(M.seasonRows(withBasis(DAK), null, 2026)).find((r) => r.season === 2025);
  assert.deepEqual([dak.ptsRank, dak.ppgRank], [4, 5], "Dak 2025 ranks unchanged");
  assert.doesNotMatch(dak.notes.join(" "), new RegExp(NOTE), "no note when nothing is held");
}

// ── Mobile player sheet: "—", never 0 ──
{
  const app = read("site/m/app.js");
  const sheet = read("site/m/player_sheet.js");
  const c = vm.createContext({});
  c.window = c;
  vm.runInContext(sliceFn(app, "function safeStr(") + "\n" + sliceFn(app, "function escapeHtml(") + "\nthis.U = { escapeHtml: escapeHtml, safeStr: safeStr };", c);
  vm.runInContext(read("site/m/season_scoring.js"), c);   // the sheet's shared half-up formatter (#1359)
  vm.runInContext(["function renderStatsBlock(", "function statRowHtml(", "function liveSeasonRow("].map((s) => sliceFn(sheet, s)).join("\n") +
    "\nthis.renderStatsBlock = renderStatsBlock;", c);
  const sheetFor = (pid, rows) => {
    c.UPS_MOBILE = { state: { ctx: { year: 2026 }, _sheetPid: pid }, data: {
      getAdvancedStatsLatestYear: () => 2026, getSeasonScoring: () => null, getAdvancedStatsFor: () => null } };
    const html = c.renderStatsBlock({ career_summary: rows });
    const out = {};
    for (const tr of html.match(/<tr>[\s\S]*?<\/tr>/g).slice(1)) {
      const cells = tds(tr).map((x) => x.text);
      out[cells[0]] = cells;
    }
    return { html, rows: out };
  };
  const ro = sheetFor("17086", ROYALS);
  assert.equal(ro.rows["2025"][4], "—", "held PPG Rk is a dash on the phone");
  assert.notEqual(ro.rows["2025"][4], "0");
  assert.deepEqual(ro.rows["2025"].slice(1, 4), ["6", "1.8", "0.3"], "MFL Wks, Pts and PPG still shown");
  assert.match(ro.html, new RegExp("2025 PPG Rk: " + NOTE));
  const carter = sheetFor("17124", career("17124", [{ season: 2025, games_played: 16, season_points: 87.5, avg_ppg: 5.47, pos_rank: 40, pos_ppg_rank: 54 }]));
  assert.equal(carter.rows["2025"][4], "—");
  const mc = sheetFor("16390", MCL);
  assert.equal(mc.rows["2025"][4], "86", "McLaughlin's PPG Rk is not held (the phone has no Pts Rk column)");
  assert.equal(mc.rows["2024"][4], "62", "an earlier season is unchanged");
  assert.doesNotMatch(mc.html, new RegExp(NOTE));
  const dk = sheetFor("12620", DAK);
  assert.equal(dk.rows["2025"][4], "5");
  assert.equal(dk.rows["2024"][4], "20");
}

// ── The other live consumers: a held (null) rank renders "—", never a number ──
for (const [file, sig, call] of [
  ["site/rosters/roster_workbench.js", "function fmtRank(", "fmtRank"],
  ["site/rookies/rookie_draft_hub.js", "const fmtRank = (r) =>", "fmtRank"],
]) {
  const c = vm.createContext({});
  vm.runInContext(sliceLine(read(file), sig), c);
  assert.equal(vm.runInContext(call + "(null)", c), "—", file);
  assert.equal(vm.runInContext(call + "(7)", c), "#7", file);
}
{
  // Team Operations prints Pts Rk only, inline.
  const src = read("site/team_operations/team_operations.js");
  const expr = "(s.pos_rank != null ? '#' + escapeHtml(safeStr(s.pos_rank)) : '—')";
  assert.ok(src.includes(expr));
  const c = vm.createContext({ escapeHtml: String, safeStr: String });
  assert.equal(vm.runInContext("var s = { pos_rank: null }; " + expr, c), "—");
}
// Each of those reads the rank straight off the career row it was given.
assert.ok(read("site/rosters/roster_workbench.js").includes("fmtRank(c.pos_ppg_rank)"));
assert.ok(read("site/rookies/rookie_draft_hub.js").includes("${fmtRank(c.pos_ppg_rank)}"));

console.log("rank_pending_1307: all checks passed");
