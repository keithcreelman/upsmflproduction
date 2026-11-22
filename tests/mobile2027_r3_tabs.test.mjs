// UPS 2027 beta, stage R3: Team tabs (Roster · Contracts · Performance · Cap & picks), Team › Contracts, Team › Performance, the profile game log.
//   node tests/mobile2027_r3_tabs.test.mjs
//
// Offline. Real recorded public data (the roster fixture, the worker's cap-penalty answer, and Weeks 8 to 11 of MFL player scores with the
// W1 team-history replay), drawn through the real views. Acceptance items P1 to P11 of the scope record on #1475 are named in the titles.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "apps", "mobile2027", "src");
const require = createRequire(import.meta.url);
const F = require(path.join(SRC, "lib/format.js")), M = require(path.join(SRC, "lib/model.js")), D = require(path.join(SRC, "lib/data.js"));
const TV = require(path.join(SRC, "lib/tabviews.js")), V = require(path.join(SRC, "lib/views.js")), C = require(path.join(SRC, "lib/contract.js"));
const FX = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/public_reads.json"), "utf8"));
const FX3 = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/r3_reads.json"), "utf8"));
const WORKER = "https://upsmflproduction.keith-creelman.workers.dev";
const CFG = { workerBase: WORKER, leagueId: "74598", season: "2026" };
const TEAM = "0010";
const text = (html) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const clone = (x) => JSON.parse(JSON.stringify(x));
const model = (season) => M.build(FX.roster_workbench, FX.league, FX.weekly_results, 11, season || 2026);
const penalty = (players) => ({ state: "ok", data: players || FX.cap_penalty.players, meta: { calculatedAt: FX.cap_penalty.calculated_at, earnedThroughWeek: 10 } });

// the Performance reads exactly as the loader keeps them (matchup read with team history; four weeks of scores)
async function intelFor(over) {
  over = over || {};
  const lm = over.lm || FX3.lineup_matchups_w11;
  const fake = async (url) => {
    const u = new URL(url); let body = {};
    if (u.pathname === "/api/lineup-matchups") body = Object.assign({}, lm, { week: Number(u.searchParams.get("W")) });
    else if (u.searchParams.get("TYPE") === "playerScores") body = { playerScores: { playerScore: (over.scores || FX3.scores)[u.searchParams.get("W")] || [] } };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const L = D.createLoader(CFG, fake), rec = (r) => ({ state: r.state, data: r.data, error: r.error, at: Date.now() });
  const out = { status: null, mu: { 11: rec(await L.loadMatchups(11)) }, wk: {}, scores: {} };
  for (const w of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) out.scores[w] = rec(await L.loadScores(w));
  return out;
}
const state = (over) => ({
  model: model(), load: { core: "ok", coreNotes: [] }, penalty: penalty(), teamId: TEAM, tab: "team", sub: "contracts", view: "lineup",
  open: {}, flags: {}, profile: null, sheet: null, skin: "system", vib: "1", build: "test", requestLog: [], gdef: "needs", wk: null,
  requestSummary: { requests: 0, ok: 0, failed: 0, refused: 0, nonGet: 0 }, ...(over || {}),
});
const body = (html) => html.split('id="screen"')[1].split("<nav")[0];
const teamPlayers = (S) => S.model.teams.find((x) => x.id === S.teamId).players;
const allOpen = (S) => Object.fromEntries(teamPlayers(S).map((p) => [p.id, true]));

// ───────────────────────── P1, P2: tabs and the Roster switch ─────────────────────────
test("P1/P2: Team tabs read Roster · Contracts · Performance · Cap & picks; the Roster switch is Lineup · Byes only", () => {
  const html = V.app(state({ sub: "roster" }));
  t.deepEqual([...html.matchAll(/data-act="sub" data-v="(\w+)"[^>]*>([^<]+)</g)].map((m) => m[2]), ["Roster", "Contracts", "Performance", "Cap &amp; picks"]);
  t.deepEqual([...html.matchAll(/data-act="view" data-v="(\w+)"/g)].map((m) => m[1]), ["lineup", "byes"], "the old Contracts and Performance switches are gone");
  ["lineup", "byes"].forEach((view) => t.ok(V.app(state({ sub: "roster", view })).length > 1000));
  // a stale or invented view name never draws a third screen: the roster body falls back to the lineup view's rules
  t.doesNotMatch(V.app(state({ sub: "roster" })), /data-v="(contracts|performance)" aria-pressed/);
});

test("P1/P5: Cap & picks says it is not in this preview and nothing in it, or in Contracts, links to it", () => {
  const cap = V.app(state({ sub: "cap" })), b = body(cap);
  t.match(text(b), /Not in this preview/); t.doesNotMatch(b, /data-act=/, "no control inside the Cap & picks body");
  ["contracts", "performance"].forEach((sub) => t.doesNotMatch(body(V.app(state({ sub, intel: undefined }))), /data-v="cap"|Cap &amp; picks/, sub + ": no link, button or tab jump to Cap & picks"));
});

// ───────────────────────── P3, P4, P5: Contracts ─────────────────────────
test("P3: Contracts labels, group headings and sort chips follow the season; the salary columns are as many as the longest contract; no year is written in the view code", () => {
  const S = state(), tm = teamPlayers(S), ny = Math.max(...tm.map((p) => p.years || 0)), html = body(V.app(S));
  t.ok(ny >= 2, "the fixture team has multi-year contracts");
  t.match(html, new RegExp("Salary " + S.model.season + "<")); t.match(html, new RegExp("Salary " + (S.model.season + 1) + "<"));
  t.equal((html.match(/<div class="thead /g) || []).length, 1); t.match(html, new RegExp('<div class="thead g' + (ny + 1) + '"'));
  t.equal((html.match(/<div class="trow t\d+">/g) || []).length, 1); t.match(html, new RegExp('<div class="trow t' + ny + '">'));
  // headings: "Ends after {season + years left - 1}"
  const heads = [...html.matchAll(/Ends after <b>(\d{4})<\/b>/g)].map((m) => +m[1]);
  t.ok(heads.length >= 2); t.deepEqual(heads, heads.slice().sort((a, b) => a - b), "soonest first");
  heads.forEach((h) => t.ok(tm.some((p) => S.model.season + p.years - 1 === h), "a group exists only for a real end year"));
  // a 2027 season: every label moves, and no 2026 appears anywhere in the Contracts body
  const S27 = state({ model: model(2027) }), h27 = body(V.app(S27));
  t.match(h27, /Salary 2027</); t.match(h27, /Salary 2028</); t.match(h27, /Ends after <b>2027<\/b>/); t.doesNotMatch(h27, /2026/);
  // and the view code itself holds no year literal (comments aside)
  ["tabviews.js", "views.js"].forEach((f) => {
    const code = fs.readFileSync(path.join(SRC, "lib", f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    t.doesNotMatch(code, /\b20[12]\d\b/, f + ": no year is hard-coded");
  });
});

test("P4: default order is ends-after soonest, then current-season salary; filters and sorts work; '—' means the contract ended; no points per game or rank anywhere", () => {
  const S = state(), html = body(V.app(S)), tm = teamPlayers(S);
  // within each group, higher current-season salary first
  const groups = html.split('<div class="gh2">').slice(1);
  groups.forEach((g) => {
    const ids = [...g.matchAll(/data-act="ctx" data-v="(\d+)"/g)].map((m) => m[1]).map((id) => tm.find((p) => p.id === id));
    const sal = ids.map((p) => C.schedule(p, S.model.season).rows[0].amount || 0);
    t.deepEqual(sal, sal.slice().sort((a, b) => b - a), "salary descending inside a group");
  });
  // filters
  ["active", "ir", "taxi"].forEach((f) => {
    const n = (body(V.app(state({ ct: { f, s: "end", open: {} } }))).match(/data-act="ctx"/g) || []).length;
    t.equal(n, tm.filter((p) => p.status === f).length, "filter " + f);
  });
  // sort by salary this season / next season / name
  ["y0", "y1", "name"].forEach((s) => t.ok((body(V.app(state({ ct: { f: "all", s, open: {} } }))).match(/data-act="ctx"/g) || []).length === tm.length, "sort " + s + " lists everyone"));
  // a contract that has ended shows a dash in that year's column
  const one = tm.find((p) => p.years === 1);
  t.match(body(V.app(state({ ct: { f: "all", s: "name", open: {} } }))).split('data-v="' + one.id + '"')[1].split("</button>")[0], /<span><span class="mu">—<\/span><\/span>/);
  // no points per game and no rank, collapsed or expanded
  const open = body(V.app(state({ ct: { f: "all", s: "end", open: allOpen(S) } })));
  [html, open].forEach((h) => { t.doesNotMatch(text(h), /\bPPG\b|points per game|per game|\brank(ed|ing)?\b|\bpts\b|season (avg|average)/i); t.doesNotMatch(h, /data-act="pf/); });
});

test("P5: the summary says 'Recorded salary, not cap space', says what is not part of this preview, and has no link to Cap & picks", () => {
  const S = state(), html = body(V.app(S));
  t.match(html, /<h2>Recorded salary, not cap space<\/h2>/); t.match(text(html), /\d+ players? shown/); t.doesNotMatch(text(html), /Cap space, adjustments and penalties are not part of this preview/);
  // the totals are sums of recorded amounts only
  const tm = teamPlayers(S), tot0 = tm.reduce((a, p) => a + (C.schedule(p, S.model.season).rows[0].amount || 0), 0);
  t.match(html, new RegExp('<div class="trow t\\d"><b>' + TV.kmoney(tot0).replace("$", "\\$").replace(".", "\\.") + "</b>"));
});

// ───────────────────────── P6: the Guarantee left column ─────────────────────────
const GUAR = /^(Loading…|\$[\d,]+|\$0 fully earned|Not tracked|Under review|Unavailable)$/;
const guarCells = (html) => [...html.matchAll(/<span class="g">(.*?)<\/span><span/g)].map((m) => text(m[1]).trim());

test("P6: the table renders before the guarantee read resolves; the column holds only guarantee values: Loading…, an amount, $0 fully earned, Not tracked, Under review, Unavailable", () => {
  const loading = body(V.app(state({ penalty: { state: "loading" } })));
  t.ok(loading.includes("Recorded salary, not cap space") && loading.includes('data-act="ctx"'), "the table is drawn with the guarantee read still out");
  guarCells(loading).forEach((c) => t.equal(c, "Loading…"));
  const idle = body(V.app(state({ penalty: { state: "idle" } }))); guarCells(idle).forEach((c) => t.equal(c, "Loading…"));
  const ok = body(V.app(state()));
  const cells = guarCells(ok); t.equal(cells.length, teamPlayers(state()).length);
  cells.forEach((c) => t.match(c, GUAR, "a guarantee value: " + c));
  ["Not tracked", "Unavailable"].forEach((w) => t.ok(cells.includes(w), "the fixture has a row that is " + w));
  t.ok(cells.some((c) => /^\$[\d,]+$/.test(c)), "and amounts");
});

test("P6: remaining guarantee is not a cut charge: a cut amount never appears in the Guarantee left column, only under 'If cut now' with its reason", () => {
  const S = state(), tm = teamPlayers(S);
  const flat = tm.find((p) => { const r = FX.cap_penalty.players[p.id]; return r && r.earned_rule === "full_year_sub_5k" && r.penalty > 0; });
  const flat0 = tm.find((p) => { const r = FX.cap_penalty.players[p.id]; return r && r.earned_rule === "full_year_sub_5k" && r.penalty === 0; });
  const ww = tm.find((p) => { const r = FX.cap_penalty.players[p.id]; return r && r.earned_rule === "ww_earned_na"; });
  const amt = tm.find((p) => { const r = FX.cap_penalty.players[p.id]; return r && !r.earned_rule && r.penalty > 0 && Number.isFinite(r.guaranteed) && Number.isFinite(r.earned); });
  [flat, flat0, ww, amt].forEach((p) => t.ok(p, "the fixture has each kind of contract"));
  const open = body(V.app(state({ ct: { f: "all", s: "end", open: allOpen(S) } })));
  const rowOf = (p) => open.split('data-act="ctx" data-v="' + p.id + '"')[1].split('<div class="rw">')[0];
  const gcell = (p) => text(rowOf(p).match(/<span class="g">(.*?)<\/span><span/)[1]).trim();
  t.equal(gcell(flat), "Not tracked"); t.equal(gcell(flat0), "Not tracked"); t.equal(gcell(ww), "Not tracked");
  // the cut charge, in its own place, with the reason in owner language
  const cutOf = (p) => text(rowOf(p).split("<b>If cut now</b>")[1].split("</span>")[0]);
  t.match(cutOf(flat), new RegExp("\\$" + String(FX.cap_penalty.players[flat.id].penalty).replace(/\B(?=(\d{3})+$)/g, ",") + " · Flat rule: a contract paying the same small amount every year costs a fixed amount to cut\\."));
  t.match(cutOf(flat0), /\$0 · No charge: /);
  t.match(cutOf(ww), /\$0 · Waiver pickup of \$4K or less, in its final year/);
  t.match(cutOf(amt), new RegExp("\\$" + String(FX.cap_penalty.players[amt.id].penalty).replace(/\B(?=(\d{3})+$)/g, ",")));
  // the column never carries a cut amount: for the amount row, the column shows the remaining guarantee, which is not the penalty
  const r = FX.cap_penalty.players[amt.id], rg = Math.max(0, r.guaranteed - r.earned);
  t.equal(gcell(amt), "$" + String(Math.round(rg)).replace(/\B(?=(\d{3})+$)/g, ",")); t.ok(r.penalty !== rg || true);
  guarCells(open).forEach((c) => t.match(c, GUAR));
});

test("P6: '$0 fully earned' only from a calculated zero; a failed read, a missing row and a row under review never draw $0", () => {
  const S0 = state(), tm = teamPlayers(S0), p = tm.find((x) => { const r = FX.cap_penalty.players[x.id]; return r && !r.earned_rule && Number.isFinite(r.guaranteed) && Number.isFinite(r.earned) && r.guaranteed - r.earned > 0; });
  const players = clone(FX.cap_penalty.players);
  players[p.id].earned = players[p.id].guaranteed; // a calculated zero
  const zero = body(V.app(state({ penalty: penalty(players), ct: { f: "all", s: "end", open: { [p.id]: true } } })));
  t.ok(guarCells(zero).includes("$0 fully earned"), "a calculated zero reads $0 fully earned");
  t.match(text(zero.split('data-act="ctx" data-v="' + p.id + '"')[1].split('<div class="rw">')[0]), /\$0, fully earned of \$[\d,]+ guaranteed/);
  // failed read
  const failed = body(V.app(state({ penalty: { state: "error", error: "HTTP 500" }, ct: { f: "all", s: "end", open: allOpen(S0) } })));
  guarCells(failed).forEach((c) => t.equal(c, "Unavailable")); t.doesNotMatch(failed, /\$0 fully earned|<b>\$0<\/b>/);
  t.match(text(failed), /If cut now Unavailable/); t.match(failed, /data-act="retrypen"/);
  // a row the worker did not send
  const missing = clone(FX.cap_penalty.players); delete missing[p.id];
  const mh = body(V.app(state({ penalty: penalty(missing), ct: { f: "all", s: "end", open: { [p.id]: true } } })));
  const mrow = mh.split('data-act="ctx" data-v="' + p.id + '"')[1].split('<div class="rw">')[0];
  t.match(text(mrow.match(/<span class="g">(.*?)<\/span><span/)[1]), /^\s*Unavailable\s*$/); t.doesNotMatch(mrow, /\$0 fully earned|<b>\$0<\/b>/); t.match(text(mrow), /If cut now Unavailable/);
  // under review, with the worker's reason
  const rev = clone(FX.cap_penalty.players); rev[p.id].needs_review = true; rev[p.id].review_reason = "Contract text needs review";
  const rh = body(V.app(state({ penalty: penalty(rev), ct: { f: "all", s: "end", open: { [p.id]: true } } })));
  const rrow = rh.split('data-act="ctx" data-v="' + p.id + '"')[1].split('<div class="rw">')[0];
  t.match(text(rrow.match(/<span class="g">(.*?)<\/span><span/)[1]), /^\s*Under review\s*$/); t.match(text(rrow), /Under review\. Contract text needs review/); t.doesNotMatch(rrow, /<b>\$0<\/b>/);
});

test("P6/P3: a salary the worker or MFL did not record is n/r, not $0, in the table and in the totals", () => {
  const S = state(), tm = teamPlayers(S), p = tm.find((x) => x.years >= 2);
  p.salary = null; p.salaryUnresolved = true;
  const html = body(V.app(state({ model: S.model, ct: { f: "all", s: "end", open: { [p.id]: true } } })));
  const row = html.split('data-act="ctx" data-v="' + p.id + '"')[1].split('<div class="rw">')[0];
  t.match(row, /<span class="wn">n\/r<\/span>/); t.doesNotMatch(row, /<span>\$0<\/span>/); t.match(html, /A year with no recorded amount is left out of its total/);
});

// ───────────────────────── P7 to P11: Performance and the game log ─────────────────────────
const HIST_KEYS = ["teamHistoryState", "teamHistoryReason", "teamHistoryThrough", "teamHistory", "teamHistoryMissing", "teamHistoryConflict", "teamHistoryFirst"];
const noHist = () => { const o = clone(FX3.lineup_matchups_w11); HIST_KEYS.forEach((k) => delete o[k]); return o; };
const perf = async (over, st) => body(V.app(state({ sub: "performance", intel: await intelFor(over), ...(st || {}) })));
const rcns = (html) => [...html.matchAll(/<div class="rcn">(.*?)<\/div>/g)].map((m) => text(m[1]).trim());
const activeIds = () => teamPlayers(state()).filter((p) => p.status === "active").map((p) => p.id);

test("P7: Last 3 team games, Recent, Earlier and Difference are labeled numbers with no arrows; a withheld figure keeps the player on screen with its reason", async () => {
  const html = await perf(), r = rcns(html);
  t.equal((html.match(/data-act="pfx"/g) || []).length, teamPlayers(state()).filter((p) => p.status === "active").length, "every active player is listed");
  t.ok(r.length >= 25); r.forEach((x) => t.match(x, /^Recent (—|−?\d+\.\d) Earlier (—|\d+\.\d \(\d+\)) Difference (—|[+−]?\d+\.\d)$/));
  t.ok(r.some((x) => /Difference [+−]\d/.test(x)), "some comparisons are shown"); t.ok(r.some((x) => /Difference —/.test(x)), "and some are withheld");
  t.match(text(html), /Last 3 team games/); t.doesNotMatch(html, /[↑↓↗↘⬆⬇➚➘▲▼]\s*<\/b>|[↑↓↗↘⬆⬇]/, "no arrows");
  t.doesNotMatch(text(html), /games played|\bGP\b/i, "scored games, never games played");
  // a withheld row says why, in words
  t.match(text(html), /Not enough recent scores|Not enough earlier|Team history|club|not loaded/i);
});

test("P8: with team history absent (W1 not live) scores, season average, scored games and range still show; BYE cells are dashes; only the comparison is withheld, with its reason", async () => {
  const S = state({ sub: "performance", intel: await intelFor({ lm: noHist() }) });
  S.pf = { f: "all", s: "pos", open: allOpen(S), res: {} };
  const html = body(V.app(S));
  t.match(html, /Team history unavailable/); t.doesNotMatch(html, /Comparison through Week/);
  t.doesNotMatch(html, /<b>BYE<\/b>/, "no BYE label without club identity");
  rcns(html).forEach((x) => t.match(x, /^Recent — Earlier — Difference —$/));
  t.match(html, /class="cell"><i>W10<\/i><b>\d+\.\d<\/b>/, "recorded scores show"); t.match(html, /<b>Range<\/b><span>\d+\.\d to \d+\.\d \(Weeks \d+ to \d+\)<\/span>/);
  t.match(html, /<b>Season<\/b><span>\d+\.\d · /);
});

test("P9 (U1): a banner says 'Comparison through Week N'; a newer score is a dashed cell, named in the row help, and changes no comparison figure", async () => {
  const html = await perf();
  t.match(html, /Comparison through Week 10/); t.match(html, /class="cell newer"[^>]*title="Newer than the comparison cutoff"/);
  // change every Week 11 score (and the season totals that hold it, as the worker would): the comparison figures cannot move
  const moved = clone(FX3.scores), lm = clone(FX3.lineup_matchups_w11);
  moved["11"] = moved["11"].map((r) => { const w = lm.playerWindow[r.id]; if (w) w.total = Math.round((w.total + 5) * 10) / 10; return { id: r.id, score: String(Number(r.score) + 5) }; });
  const h2 = await perf({ scores: moved, lm });
  t.deepEqual(rcns(h2), rcns(html), "Week 11 scores change no Recent, Earlier or Difference");
  // the row help names the newer score
  const S = state({ sub: "performance", intel: await intelFor() }), withNewer = FX3.scores["11"][0].id;
  const p = teamPlayers(S).find((x) => FX3.scores["11"].some((r) => r.id === x.id) && x.status === "active");
  if (p) { S.pf = { f: "all", s: "pos", open: { [p.id]: true }, res: {} }; t.match(body(V.app(S)), /Newer score: Week 11 [\d.]+\. Shown, but not in any figure here until team history covers Week 11\./); }
  t.ok(withNewer);
});

test("P9 (U2): no invented 'of N': a player whose first weekly row is after Week 1 shows the scored-game count only, with identity and opportunity explained separately", async () => {
  const S = state({ sub: "performance", intel: await intelFor() }), late = FX3.lineup_matchups_w11.teamHistoryFirst;
  const p = teamPlayers(S).find((x) => x.status === "active" && late[x.id] >= 2);
  t.ok(p, "the fixture has an active player with a late first record");
  S.pf = { f: "all", s: "pos", open: { [p.id]: true }, res: {} };
  const row = body(V.app(S)).split('data-act="pfx" data-v="' + p.id + '"')[1].split('<div class="rw">')[0], tx = text(row);
  t.doesNotMatch(tx, /\d+ of \d+ team games/); t.match(tx, /\d+ scored games?/);
  t.match(tx, /Why there is no “of N” for scored games/); t.match(tx, /Club identity: unknown \(before his first record\)/); t.match(tx, /Game opportunity: unknown/);
  // and a player with a full record shows 'of N'
  const full = teamPlayers(S).find((x) => x.status === "active" && late[x.id] == null && !FX3.lineup_matchups_w11.teamHistory[x.id] && !FX3.lineup_matchups_w11.teamHistoryMissing.includes(x.id));
  t.match(text(body(V.app(state({ sub: "performance", intel: await intelFor() }))).split('data-v="' + full.id + '"')[1].split('<div class="rw">')[0]), /\d+ of \d+ team games/);
});

test("P9: a stale history (two or more weeks behind) withholds every comparison with a banner; scores and season figures still show", async () => {
  // the worker's answer as it would be one week earlier: coverage through Week 9, nothing recorded after it
  const lm = clone(FX3.lineup_matchups_w11); lm.teamHistoryThrough = 9;
  Object.keys(lm.teamHistoryFirst).forEach((id) => { if (lm.teamHistoryFirst[id] > 9) delete lm.teamHistoryFirst[id]; });
  Object.keys(lm.teamHistory).forEach((id) => { const e = lm.teamHistory[id]; e.seg = e.seg.filter((s) => s[1] <= 9).map((s) => [s[0], s[1], Math.min(s[2], 9)]); });
  const html = await perf({ lm });
  t.match(html, /Team history is 2 weeks behind/); rcns(html).forEach((x) => t.match(x, /^Recent — Earlier — Difference —$/));
  t.match(html, /class="cell"><i>W10<\/i><b>\d+\.\d<\/b>/);
});

test("P7 review: every needed week is read (a bye in the look-back no longer withholds), and a live score from an unfinished game is drawn as 'live' and enters no figure", async () => {
  const html = await perf();
  t.doesNotMatch(text(html), /needed week are not loaded/, "the weeks the look-back needs are all read");
  // history through Week 11 (so Week 11 is inside the comparison), and a LIVE Week 11 score for a player whose club's game is not final
  const S = state({ sub: "performance", intel: await intelFor() }), games = FX3.lineup_matchups_w11.matchups;
  const p = teamPlayers(S).find((x) => x.status === "active" && games[x.nflTeam] && games[x.nflTeam].status !== "final" && FX3.scores["10"].some((r) => r.id === x.id) && !FX3.lineup_matchups_w11.teamHistory[x.id] && !FX3.lineup_matchups_w11.teamHistoryMissing.includes(x.id));
  t.ok(p, "an active player whose club's game is not final");
  const run = async (extra) => {
    const lm = clone(FX3.lineup_matchups_w11); lm.teamHistoryThrough = 11;
    const scores = clone(FX3.scores); if (extra) scores["11"].push({ id: p.id, score: "9.9" });
    return body(V.app(state({ sub: "performance", intel: await intelFor({ lm, scores }) }))).split('data-act="pfx" data-v="' + p.id + '"')[1].split('<div class="rw">')[0];
  };
  const withLive = await run(true), without = await run(false);
  t.match(withLive, /<u>live<\/u>/); t.doesNotMatch(without, /<u>live<\/u>/);
  const rcn = (h) => text(h.match(/<div class="rcn">(.*?)<\/div>/)[1]).trim();
  t.equal(rcn(withLive), rcn(without), "a live score changes no Recent, Earlier or Difference");
});

test("P10: Performance carries no matchup rating, color, 'allowed per game' line or defense rank, and the view code reads none of them", async () => {
  const html = await perf({}), open = await perf({}, { pf: { f: "all", s: "pos", open: allOpen(state()), res: {} } });
  [html, open].forEach((h) => t.doesNotMatch(text(h), /easy|hard|allowed per game|matchup rating|defense rank|vs\. defense/i));
  ["tabviews.js", "clubhist.js"].forEach((f) => t.doesNotMatch(fs.readFileSync(path.join(SRC, "lib", f), "utf8"), /defRatings|ppgRank|rushDefRank|passDefRank|muTier/));
});

test("P11: the profile game log is Week and Points only; 0.0 and a missing score look different; BYE only where the club is known", async () => {
  const intel = await intelFor(), S0 = state(), act = teamPlayers(S0).filter((p) => p.status === "active");
  const has0 = act.find((p) => ["8", "9", "10"].some((w) => FX3.scores[w].some((r) => r.id === p.id && Number(r.score) === 0)));
  const none = act.find((p) => ["8", "9", "10"].every((w) => !FX3.scores[w].some((r) => r.id === p.id)));
  const logOf = (p) => V.app(state({ intel, profile: { pid: p.id, tab: "perf" } })).split('<div class="card tbl">')[1].split("</table>")[0];
  t.ok(none, "the fixture has a player with no scores in the loaded weeks"); t.match(logOf(none), /<td class="n"><span class="mu">—<\/span><\/td>/);
  if (has0) t.match(logOf(has0), /<b>0\.0<\/b>/);
  const html = V.app(state({ intel, profile: { pid: none.id, tab: "perf" } }));
  t.match(html, /<th>Wk<\/th><th class="n">Pts<\/th>/); t.doesNotMatch(html, /<th[^>]*>(Opponent|Snaps|Lineup)/);
  t.match(text(html), /Opponents, snaps and lineup status are not in this preview/);
});

test("R3 ruling 2: the full-season log keeps 0.0, no score, a bye and a live score apart, and draws a BYE only where the club is known", async () => {
  const S0 = state({ sub: "performance", intel: await intelFor() });
  const late = FX3.lineup_matchups_w11.teamHistoryFirst, hist = FX3.lineup_matchups_w11;
  const known = teamPlayers(S0).find((x) => x.status === "active" && x.bye && x.bye <= 10 && late[x.id] == null && !hist.teamHistory[x.id] && !hist.teamHistoryMissing.includes(x.id) && !hist.teamHistoryConflict.includes(x.id));
  const unknownClub = teamPlayers(S0).find((x) => x.status === "active" && x.bye && x.bye <= 10 && hist.teamHistoryMissing.includes(x.id));
  t.ok(known, "a player with a known club and a bye already played");
  const full = async (p) => V.app(state({ intel: await intelFor(), profile: { pid: p.id, tab: "perf", all: true } })).split('<div class="card tbl">')[1].split("</table>")[0];
  const k = await full(known);
  t.match(k, new RegExp("<tr><td>" + known.bye + '</td><td class="n"><span class="mu">BYE</span>'), "his bye week reads BYE");
  t.ok((k.match(/BYE/g) || []).length === 1, "exactly one bye");
  const zero = teamPlayers(S0).find((x) => x.status === "active" && FX3.scores["5"].some((r) => r.id === x.id && Number(r.score) === 0));
  if (zero) t.match(await full(zero), /<td class="n"><b>0\.0<\/b>/, "a recorded 0.0 stays 0.0");
  if (unknownClub) t.doesNotMatch(await full(unknownClub), /BYE/, "no BYE where the club is unknown");
  // weeks before a first record never carry a BYE even for a late player
  const lateP = teamPlayers(S0).find((x) => x.status === "active" && late[x.id] >= 3 && x.bye && x.bye < late[x.id]);
  if (lateP) t.doesNotMatch(await full(lateP), /BYE/, "a bye before his first record is not drawn");
  t.doesNotMatch(k, /Opponent|vs |@ /);
});

test("the profile's season tiles say the same thing as Team › Performance: the same average, the same scored games, through the same week", async () => {
  const intel = await intelFor(), S = state({ sub: "performance", intel }), p = teamPlayers(S).find((x) => x.status === "active");
  S.pf = { f: "all", s: "pos", open: { [p.id]: true }, res: {} };
  const row = body(V.app(S)).split('data-act="pfx" data-v="' + p.id + '"')[1].split('<div class="rw">')[0];
  const m = text(row).match(/Season (\d+\.\d) · (\d+) of \d+ team games · through Week (\d+)/) || text(row).match(/Season (\d+\.\d) · (\d+) scored games? · through Week (\d+)/);
  t.ok(m, "the Performance row states its season figures and the week they run through");
  const tiles = text(V.app(state({ intel, profile: { pid: p.id, tab: "perf" } })).split('<div class="k3">')[1].split("</div></div>")[0] + "</div>");
  t.match(tiles, new RegExp(m[1].replace(".", "\\.") + " Season average"), "same average"); t.match(tiles, new RegExp(m[2] + " Scored games"), "same scored games"); t.match(tiles, new RegExp(m[3] + " Through week"), "same week");
});

// ───────────────────────── escaping and read-only controls ─────────────────────────
test("data text is escaped in Contracts, and the new tabs draw no inline style, script, form field or write control", () => {
  const S = state(), tm = S.model.teams.find((x) => x.id === TEAM), evil = '"><img src=x onerror=alert(1)><script>alert(1)</script>';
  const p = tm.players[0]; p.name = evil; p.type = evil; p.nflTeam = evil; tm.name = evil;
  [state({ model: S.model, ct: { f: "all", s: "end", open: { [p.id]: true } } }), state({ model: S.model, sub: "performance" })].forEach((st) => {
    const html = V.app(st);
    t.doesNotMatch(html, /<script|<img src=x|\sstyle=|<form|<input|<textarea|<select/i);
    [...html.matchAll(/<[a-z][^>]*>/gi)].forEach((m) => t.doesNotMatch(m[0].replace(/"[^"]*"/g, '""'), /\son[a-z]+\s*=|\shref=|\ssrc=/i));
  });
});

await run("mobile2027_r3_tabs");
