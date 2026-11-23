// UPS 2027 beta, R6: the Breakdown (season stats, weekly game log, game detail) and the /api/player-weekly-box read.
//   node tests/mobile2027_r6_breakdown.test.mjs
//
// Offline. Real captured PUBLIC answers: /api/player-weekly-box for eleven players (captured 2026-11-22/23 by the verification pass; trimmed to the fields the
// Breakdown reads) plus one kicker converted from the R1 advanced-stats capture, MFL's recorded whole-season schedule (kickoffs, home flags, scores), and the
// recorded weekly MFL scores of the whole league (r4_reads.json). The sourced example is Jaxon Smith-Njigba (16185) through Week 10 (research v1 section 3).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "apps", "mobile2027", "src");
const require = createRequire(import.meta.url);
const D = require(path.join(SRC, "lib/data.js")), X = require(path.join(SRC, "lib/complete.js")), BL = require(path.join(SRC, "lib/boxlog.js"));
const TV = require(path.join(SRC, "lib/tabviews.js")), BD = require(path.join(SRC, "lib/breakdown.js")), M = require(path.join(SRC, "lib/model.js")), K = require(path.join(SRC, "lib/ranks.js")), F = require(path.join(SRC, "lib/format.js"));
const FXB = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/r6_box.json"), "utf8"));
const FX = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/public_reads.json"), "utf8"));
const FX3 = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/r3_reads.json"), "utf8"));
const FX4 = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/r4_reads.json"), "utf8"));
const CAL = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/calendar_2026.json"), "utf8"));
const WORKER = "https://upsmflproduction.keith-creelman.workers.dev";
const CFG = { workerBase: WORKER, leagueId: "74598", season: "2026" };
const text = (html) => html.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const clone = (x) => JSON.parse(JSON.stringify(x));
const ok = (b) => ({ ok: true, status: 200, text: async () => JSON.stringify(b) });
const named = (p) => (p.name ? p : Object.assign({ name: "Player, " + p.id }, p));
// team history cut at Week T (the same helper as the Performance tests): a history one week behind the all-final week
const histAt = (T) => { const h = clone(FX4.hist); h.teamHistoryThrough = T; Object.keys(h.teamHistory).forEach((id) => { const e = h.teamHistory[id]; e.seg = e.seg.filter((s) => s[1] <= T).map((s) => [s[0], s[1], Math.min(s[2], T)]); if (!e.seg.length) delete h.teamHistory[id]; }); Object.keys(h.teamHistoryFirst).forEach((id) => { if (h.teamHistoryFirst[id] > T) delete h.teamHistoryFirst[id]; }); return h; };
const POS = Object.fromEntries(FX4.players.map((p) => [p.id, p]));
const P = (id, pos, club) => ({ id, pos: pos || POS[id].position, nflTeam: club || POS[id].team });

// The reads exactly as the loader keeps them: the matchup read (cutoff, team history), Weeks 1 to 11 of scores, the players list, the calendar (the recorded
// whole-season schedule WITH kickoffs and home flags), and the game-stats read of each player asked for.
async function intel(ids, over) {
  over = over || {};
  const calls = [];
  const fake = async (url) => {
    const u = new URL(url), ty = u.searchParams.get("TYPE"), w = u.searchParams.get("W"); calls.push(u.pathname + "?" + u.searchParams.toString());
    if (u.pathname === "/api/lineup-matchups") return ok(Object.assign({}, clone(FX3.lineup_matchups_w11), over.hist || clone(FX4.hist), { week: Number(w) }));
    if (u.pathname === "/api/player-weekly-box") { const a = FXB.box[u.searchParams.get("mfl_id")]; return a ? ok(a) : { ok: false, status: 404, text: async () => "" }; }
    if (ty === "playerScores") return ok({ playerScores: { playerScore: (over.scores || FX4.scores)[w] || (w === "11" ? [{ id: "17149", score: "2.0" }] : []) } });
    if (ty === "players") return ok({ players: { player: FX4.players.map(named) } });
    if (ty === "nflByeWeeks") return ok(CAL.byes);
    if (ty === "nflSchedule" && w === "ALL") return ok(FXB.schedule);
    if (ty === "nflSchedule") return ok(w === "10" ? FX4.schedule10 : w === "11" ? FX4.schedule11 : { nflSchedule: { matchup: [] } });
    return ok({});
  };
  const L = D.createLoader(CFG, fake), rec = (r) => ({ state: r.state, data: r.data, error: r.error, at: Date.now() });
  const out = { status: null, mu: { 11: rec(await L.loadMatchups(11)) }, wk: {}, scores: {}, sched: {}, players: rec(await L.loadPlayers()), box: {} };
  for (let w = 1; w <= 11; w++) out.scores[w] = rec(await L.loadScores(w));
  for (const w of [10, 11]) out.sched[w] = rec(await L.loadSchedule(w, X.parseSchedule));
  out.cal = rec(await L.loadCalendar(X.parseCalendar));
  Object.keys(out.scores).forEach((k) => { out.scores[k].at += 1000; });
  for (const id of ids || []) { const r = await L.loadWeeklyBox(id); const pb = BL.parseBox(r.data, id, 2026); out.box[id] = pb.state === "ok" ? { state: "ok", data: pb, at: Date.parse("2026-11-23T00:03:00Z") } : { state: "error", error: pb.why }; }
  return { intel: out, calls, L };
}
const state = (I, over) => ({ model: M.build(FX.roster_workbench, FX.league, FX.weekly_results, 11, 2026), load: { core: "ok", coreNotes: [] }, penalty: { state: "idle" }, teamId: "0010", tab: "team", sub: "performance",
  view: "lineup", open: {}, flags: {}, profile: null, sheet: null, skin: "system", vib: "1", build: "test", requestLog: [], wk: null, live: null, pf: { s: "pos", open: {}, res: {} }, intel: I, ...(over || {}) });
// boxlog inputs straight from the fixture (no state), for the pure tests
const SCHED_DAYS = (() => { const out = {}; FXB.schedule.fullNflSchedule.nflSchedule.forEach((e) => { out[e.week] = e.matchup.map((m) => ({ kickoff: m.kickoff, secs: m.gameSecondsRemaining, teams: m.team.map((x) => ({ id: x.id, isHome: x.isHome, score: x.score })) })); }); return out; })();
const BYE = Object.fromEntries(CAL.byes.nflByeWeeks.team.map((x) => [x.id, Number(x.bye_week)]));
function pure(id, over) {
  const p = POS[id] || { position: { 13832: "PK", 14985: "PN", 17149: "DE" }[id], team: { 13832: "NYJ", 14985: "PHI", 17149: "IND" }[id] };
  const scores = {}, st = {};
  for (let w = 1; w <= 11; w++) { st[w] = "ok"; const r = (FX4.scores[w] || []).find((x) => x.id === id); if (r) scores[w] = Number(r.score); }
  const inp = Object.assign({ pos: p.position, season: 2026, cutoff: 10, lineupWeek: 11, currentClub: p.team, box: BL.parseBox(FXB.box[id], id, 2026), scores, scoreState: st, games: BL.gameIndex(SCHED_DAYS, 2026), byeOf: BYE, weekRank: null }, over || {});
  const rows = BL.rows(inp);
  return { inp, rows, R: BL.rollup(inp, rows), wk: (w) => rows.find((r) => r.week === w) };
}
const item = (R, label) => { for (const s of R.sections) for (const i of s.items) if (i.label === label) return i; return null; };
const val = (R, label) => { const i = item(R, label); return i ? i.value : undefined; };

// ───────────────────────── the read ─────────────────────────
test("the route is allowed with exactly season, mfl_id and L; anything else is refused before the network", () => {
  const L = D.createLoader(CFG, async () => ok({}));
  t.equal(L.urls.box("16185"), WORKER + "/api/player-weekly-box?season=2026&mfl_id=16185&L=74598");
  t.ok(D.check(L.urls.box("16185"), WORKER).ok);
  const rule = D.RULES.filter((r) => r.path === "/api/player-weekly-box");
  t.equal(rule.length, 1, "exactly one rule"); t.deepEqual(rule[0].query, ["season", "mfl_id", "L"]);
  [[WORKER + "/api/player-weekly-box?season=2026&mfl_id=1&L=74598&W=3", "W"], [WORKER + "/api/player-weekly-box?season=2026&mfl_id=1&L=74598&token=x", "token"],
    [WORKER + "/api/player-weekly-box?season=2026&mfl_user_id=1", "a session id"], [WORKER + "/api/player-weekly-box/x?season=2026&mfl_id=1&L=74598", "path not exact"],
    ["https://example.com/api/player-weekly-box?season=2026&mfl_id=1&L=74598", "other host"]].forEach(([u, why]) => t.equal(D.check(u, WORKER).ok, false, "refused: " + why));
});

test("one bare GET per player and season, reused across views, tabs and reopening; a failure is not kept past a minute; recorded mode asks only the recording", async () => {
  const calls = []; let now = 1_800_000_000_000, fail = 1; const real = Date.now; Date.now = () => now;
  try {
    const L = D.createLoader(CFG, async (url, opts) => { calls.push({ url, opts }); if (fail-- > 0) return { ok: false, status: 503, text: async () => "" }; return ok(FXB.box[new URL(url).searchParams.get("mfl_id")]); });
    const e1 = await L.loadWeeklyBox("16185"); t.equal(e1.state, "error"); await L.loadWeeklyBox("16185"); t.equal(calls.length, 1, "a failure is served from memory inside the minute");
    const r1 = await L.loadWeeklyBox("16185", true); t.equal(r1.state, "ok"); t.equal(calls.length, 2, "Try again asks once more");
    for (let i = 0; i < 5; i++) await L.loadWeeklyBox("16185"); t.equal(calls.length, 2, "views, tabs and reopening reuse the answer");
    await L.loadWeeklyBox("14782"); t.equal(calls.length, 3, "another player is his own read");
    now += 59 * 60 * 1000; await L.loadWeeklyBox("16185"); t.equal(calls.length, 3, "kept for an hour");
    calls.forEach((c) => { t.equal(c.opts.method, "GET"); t.equal(c.opts.credentials, "omit"); t.equal(c.opts.headers, undefined); t.equal(c.opts.body, undefined); });
    const bad = await L.loadWeeklyBox("16185&L=1"); t.equal(bad.state, "error"); t.equal(calls.length, 3, "an id that is not a plain MFL id is refused before the network");
    // R7 (recorded preview with game stats): in recorded mode the read goes to the recorded answer function (the page's only request function then,
    // which never touches the network); a player who was not recorded gets its 404-like miss, which the loader reports as "absent", once
    const recCalls = []; const R = D.createLoader(Object.assign({}, CFG, { data: "recorded" }), async (u) => { recCalls.push(u); return { ok: false, status: 404, text: async () => "" }; });
    const a = await R.loadWeeklyBox("16185"); t.equal(a.state, "absent"); t.equal(recCalls.length, 1, "recorded mode: one read of the recording"); await R.loadWeeklyBox("16185"); t.equal(recCalls.length, 1, "absent is kept, not asked again");
  } finally { Date.now = real; }
});

test("parseBox keeps only this player's answer: another id, another season, no verified match or a repeated week is refused; missing stays missing", () => {
  const a = FXB.box["16185"], p = BL.parseBox(a, "16185", 2026);
  t.equal(p.state, "ok"); t.equal(p.through, 10); t.equal(p.idSource, "player_id_map:verified"); t.equal(Object.keys(p.weeks).length, 10);
  t.equal(p.weeks[10].box.team, "SEA"); t.equal(p.weeks[10].box.opp, "LVR", "nflverse LV is MFL LVR (fpa_engine.js NFLV_TO_MFL)"); t.equal(p.weeks[10].box.rec_long, null, "longest is not in the 2026 rows: null, never 0");
  t.equal(BL.parseBox(a, "14782", 2026).state, "error", "an answer for another player is never used");
  t.equal(BL.parseBox(a, "16185", 2025).state, "error");
  t.equal(BL.parseBox(Object.assign(clone(a), { id_source: "" }), "16185", 2026).state, "error");
  const dup = clone(a); dup.weeks.push(clone(dup.weeks[0])); t.equal(BL.parseBox(dup, "16185", 2026).state, "error");
  t.equal(BL.parseBox({ ok: false }, "16185", 2026).state, "error");
  t.equal(BL.parseBox(FXB.box["16162"], "16162", 2026).weeks[6], undefined, "Gibbs has no Week 6 row (DET bye): absent, never a zero row");
  t.deepEqual(BL.NFLV_TO_MFL, { GB: "GBP", KC: "KCC", NE: "NEP", NO: "NOS", SF: "SFO", TB: "TBB", LV: "LVR", JAX: "JAC", LA: "LAR" }, "the worker's map, copied");
  const fpa = fs.readFileSync(path.join(HERE, "..", "worker", "src", "fpa_engine.js"), "utf8");
  t.match(fpa, /NFLV_TO_MFL = \{ GB: "GBP", KC: "KCC", NE: "NEP", NO: "NOS", SF: "SFO", TB: "TBB", LV: "LVR", JAX: "JAC", LA: "LAR" \}/, "and still the same as the source");
});

// ───────────────────────── the sourced example ─────────────────────────
test("Jaxon Smith-Njigba through Week 10 reproduces research v1 section 3: season stats, every weekly row, dates, opponents and results", () => {
  const { R, rows, wk } = pure("16185");
  const want = { Targets: "109", Receptions: "79", "Receiving yards": "1,207", "Receiving TD": "10", "Catch rate": "72.5%", "Yards per reception": "15.3", "Yards per target": "11.1", "Air yards": "1,130", "Air yards per target": "10.4",
    Carries: "3", "Rushing yards": "29", "Rushing TD": "0", Snaps: "542", "Snap share": "83.3%", "Red-zone targets": "13", "Targets inside the 10": "7", "Targets inside the 5": "2", "Red-zone receptions": "6", "Red-zone receiving TD": "5", "End-zone targets (any distance)": "8",
    "Total TD (rushing + receiving)": "10" };
  Object.entries(want).forEach(([k, v]) => t.equal(val(R, k), v, k));
  t.equal(val(R, "Routes"), null, "routes are not available for 2026: Not available, never 0"); t.equal(val(R, "Longest"), undefined, "longest is not offered when the rows have none");
  t.equal(R.to, 10); t.equal(R.games, 10);
  // v1 3c: Tgt Rec Yds TD Air Snaps/team i20 EZ, Weeks 1-10
  const v1 = [[11, 8, 122, 1, 76, 45, 50, 3, 1], [11, 9, 155, 3, 121, 47, 70, 3, 2], [14, 10, 128, 2, 151, 58, 67, 3, 3], [6, 5, 76, 0, 66, 53, 60, 1, 0], [8, 5, 102, 1, 99, 53, 63, 1, 0],
    [16, 12, 134, 0, 183, 78, 85, 0, 1], [12, 9, 150, 1, 117, 53, 69, 1, 1], [11, 6, 118, 1, 124, 61, 63, 1, 0], [10, 7, 51, 0, 61, 51, 67, 0, 0], [10, 8, 171, 1, 132, 43, 57, 0, 0]];
  v1.forEach((x, i) => { const r = wk(i + 1); t.deepEqual([r.box.targets, r.box.receptions, r.box.rec_yds, r.box.rec_tds, r.box.receiving_air_yards, r.snaps.off, r.snaps.team_off, r.rz.targets_i20, r.rz.targets_ez], x, "Week " + (i + 1)); });
  const ids = rows.filter((r) => r.week <= 10).map((r) => "W" + r.week + " " + BL.shortDate(r.game.kickoff) + " " + (r.game.home ? "vs " : "@ ") + F.commonCode(r.game.opp) + " " + r.game.score + "-" + r.game.oppScore);
  t.deepEqual(ids, ["W1 Wed 9/9 vs NE 13-10", "W2 Sun 9/20 @ ARI 31-7", "W3 Sun 9/27 @ WAS 31-33", "W4 Sun 10/4 vs LAC 30-23", "W5 Sun 10/11 vs SF 29-32", "W6 Thu 10/15 @ DEN 14-17", "W7 Sun 10/25 vs KC 20-3", "W8 Mon 11/2 vs CHI 17-34", "W9 Sun 11/8 vs ARI 17-3", "W10 Sun 11/15 @ LV 21-13"]);
  const pts = rows.filter((r) => r.week <= 10).map((r) => r.pts); t.deepEqual(pts, [29.2, 48.1, 39.4, 13.2, 26.6, 29.0, 35.9, 27.0, 12.5, 36.3]);
  t.equal(Math.round(pts.reduce((a, b) => a + b, 0) * 10) / 10, 297.2, "Tot. Pts. 297.2, the main card's figure");
  t.equal(wk(11).bye, true, "Week 11 is SEA's bye (his current club, the lineup week)"); t.equal(wk(11).newer, true);
});

test("the sourced example drawn: the Breakdown, every view, the pinned game identity, the weekly rank and the Week 10 detail", async () => {
  const { intel: I } = await intel(["16185"]), p = P("16185");
  const S = state(I), html0 = BD.panel(S, p), tx0 = text(html0);
  t.match(tx0, /Through Week 10 · 297\.2 pts · 10 scored games/);
  t.match(tx0, /Season stats · Weeks 1–10/); t.match(tx0, /Targets 109 —/); t.match(tx0, /Snap share 83\.3% —/); t.match(tx0, /End-zone targets \(any distance\) 8 —/); t.match(tx0, /Routes Not available —/);
  t.match(tx0, /10 games with a stat line\./);
  // the rendered weekly-rank example: a Rank column in the Fantasy view, exact only, from the same weekly score read (independent check below)
  const groupOf = (id) => { const x = POS[id]; const g = x && F.posGroup(x.position); return { QB: 1, RB: 1, WR: 1, TE: 1, PK: 1, PN: 1, DL: 1, LB: 1, DB: 1 }[g] ? (g === "PK" ? "K" : g === "PN" ? "P" : g) : ""; };
  const m10 = {}; FX4.scores["10"].forEach((r) => (m10[r.id] = Number(r.score))); const wf = K.weekFrom(m10, groupOf), r10 = K.totalRank(wf.entries, "16185", wf.unplaced);
  t.ok(r10 && r10.exact, "his Week 10 rank is exact"); const rk = "WR" + r10.best;
  t.match(html0, new RegExp('<b>W10</b> <span class="nw">@ LV</span><small>Sun 11/15</small></button></th><td class="n"><b>36\\.3</b></td><td class="n">' + rk + "</td><td>W 21–13</td>"));
  t.match(html0, /<b>W1<\/b> <span class="nw">vs NE<\/span><small>Wed 9\/9<\/small>/);
  t.match(html0, /<th class="n" title="Rank among players at his position that week \(exact only\)">Rank<\/th>/);
  // each view keeps the game identity pinned; the views are the offense set
  t.deepEqual([...html0.matchAll(/data-act="bdv" data-v="(\w+)"/g)].map((m) => m[1]), ["fan", "st", "use", "rz"]);
  for (const v of ["st", "use", "rz"]) {
    const h = BD.panel(state(I, { bd: { v: { 16185: v }, g: {} } }), p);
    t.match(h, /<th class="pin">Game<\/th>/, v + ": pinned column"); t.match(h, /<b>W10<\/b> <span class="nw">@ LV<\/span><small>Sun 11\/15<\/small>/, v + ": week, opponent and date pinned");
    t.equal((h.match(/data-act="bdg"/g) || []).length, 11, v + ": Weeks 1 to 10 and the newer Week 11");
  }
  const st = BD.panel(state(I, { bd: { v: { 16185: "st" }, g: {} } }), p);
  t.match(st, /<th class="n" title="Targets">Tgt<\/th><th class="n" title="Receptions">Rec<\/th><th class="n" title="Receiving yards">Yds<\/th><th class="n" title="Receiving TD">TD<\/th>/);
  t.match(st, /Sun 11\/15<\/small><\/button><\/th><td class="n">10<\/td><td class="n">8<\/td><td class="n">171<\/td><td class="n">1<\/td>/);
  const rz = BD.panel(state(I, { bd: { v: { 16185: "rz" }, g: {} } }), p);
  t.match(rz, /Wed 9\/9<\/small><\/button><\/th><td class="n">3<\/td><td class="n">2<\/td><td class="n">0<\/td><td class="n">0<\/td><td class="n">0<\/td><td class="n">1<\/td>/, "Week 1: 3 red-zone targets, 2 inside the 10, 0 inside the 5, 1 end-zone target (a separate column)");
  // Week 10 opened
  const det = text(BD.panel(state(I, { bd: { v: {}, g: { 16185: 10 } } }), p).split('<tr class="bdd">')[1].split("</tr>")[0]);
  ["Season and week 2026 · NFL Week 10 (MFL Week 10)", "Kickoff Sun Nov 15, 2026, 4:05 PM ET", "Team that week SEA", "Opponent LV", "Site Away", "Game Final · W 21–13", "Participation Played", "MFL points 36.3 · " + rk + " that week",
    "Targets 10", "Receptions 8", "Receiving yards 171", "Receiving TD 1", "Carries 0", "Snaps 43", "Share of team snaps 75%", "Air yards 132", "Red-zone targets 0", "End-zone targets (any distance) 0", "Game stats through Week 10"].forEach((s) => t.ok(det.includes(s), "detail: " + s));
  // no expected-points or projection value anywhere
  [html0, st, rz].forEach((h) => t.doesNotMatch(text(h), /xFP|expected|projection|Proj\.|Over Expectations/i));
});

// ───────────────────────── coverage, by position ─────────────────────────
test("QB (Love): passing rollup from sums, sacks taken and yards lost, red zone apart from end-zone attempts; fumbles lost say they exclude sack fumbles", () => {
  const { R } = pure("14782");
  const want = { "Completions/attempts": "232/368", "Completion rate": "63.0%", "Passing yards": "2,838", "Yards per attempt": "7.71", "Passing TD": "20", Interceptions: "7", "Air yards": "3,467", "Air yards per attempt": "9.42",
    "Sacks taken": "25", "Sack yards lost": "160", Carries: "13", "Rushing yards": "23", "Rushing TD": "2", "Fumbles lost (not on sacks)": "0",
    "Red-zone attempts": "52", "Red-zone completions": "32", "Red-zone passing TD": "13", "End-zone attempts (any distance)": "33" };
  Object.entries(want).forEach(([k, v]) => t.equal(val(R, k), v, k));
  t.equal(val(R, "Team PROE"), null, "Team PROE is not computed: Not available (the hook), never an illustrative value");
  t.deepEqual(BL.columns("QB", "st").map((c) => c.h), ["C/A", "Yds", "TD", "INT", "Sk", "Car", "RuYd", "RuTD", "FL"]);
  t.deepEqual(BL.viewsFor("QB").map((v) => v[1]), ["Fantasy", "Stats", "Usage", "Red zone"]);
});

test("RB (Gibbs): the Week 6 bye is a bye (his club's, between two DET rows), not a missing game; rushing, receiving and total TD do not double count", () => {
  const { R, wk } = pure("16162");
  t.equal(wk(6).bye, true); t.equal(wk(6).part, "Bye"); t.equal(wk(6).clubHow, "between"); t.equal(wk(6).pts, null); t.equal(wk(6).ptsKind, "none");
  t.equal(val(R, "Carries"), "199"); t.equal(val(R, "Rushing yards"), "1,000"); t.equal(val(R, "Rushing TD"), "11"); t.equal(val(R, "Receiving TD"), "2");
  t.equal(val(R, "Total TD (rushing + receiving)"), "13", "11 + 2; the 9 red-zone rushing TD are part of the 11, never added");
  t.equal(val(R, "Red-zone carries"), "47"); t.equal(val(R, "Carries inside the 10"), "22"); t.equal(val(R, "Carries inside the 5"), "16"); t.equal(val(R, "Red-zone rushing TD"), "9");
  t.equal(val(R, "Fumbles lost"), "2"); t.equal(R.games, 9);
  t.equal(wk(10).game.neutral, true, "DET vs NE in Munich: neutral site"); t.equal(wk(10).game.home, true, "MFL's designated home is kept internally");
});

test("TE (Bowers): Weeks 1-2 have no row and no club evidence before his first record: no opponent, no BYE, no zero, not 'did not play'", () => {
  const { R, wk } = pure("16641");
  [1, 2].forEach((w) => { const r = wk(w); t.equal(r.club, ""); t.equal(r.game, null); t.equal(r.bye, false); t.equal(r.part, "Club not established"); t.equal(r.pts, null); });
  t.equal(val(R, "Targets"), "71"); t.equal(val(R, "Receptions"), "50"); t.equal(val(R, "Receiving yards"), "676"); t.equal(val(R, "Receiving TD"), "6"); t.equal(R.games, 8);
  t.equal(val(R, "Snap share"), "77.5%", "403 of 520 team snaps in his 8 games (missed games are not 0%)");
});

test("IDP (Reese LB, Williams DB, Watt DE): solo, assists and MFL's scored tackles kept apart; pressures with their coverage; a snap row without a stat line is played", () => {
  const re = pure("17556");
  t.equal(val(re.R, "Solo tackles"), "52"); t.equal(val(re.R, "Assists"), "28"); t.equal(val(re.R, "Tackles as MFL scores them"), "53");
  const w1 = re.wk(1).box; t.equal(BL.withAssist(w1), 1); t.equal(BL.scoredTackles(w1), 5, "Week 1: TK 5 = 4 solo + 1 with an assist (v2), so 5 x 1 + TFL 1 + QB hit 0.5 = MFL 6.5"); t.equal(re.wk(1).pts, 6.5);
  t.equal(re.wk(8).bye, true, "NYG's Week 8 bye");
  t.deepEqual(BL.viewsFor("LB").map((v) => v[1]), ["Fantasy", "Stats", "Usage", "Pass rush"]);
  t.deepEqual(BL.columns("LB", "st").map((c) => c.h), ["Solo", "Ast", "TFL", "Sk", "INT", "PD", "FF", "FR", "TD"]);
  t.deepEqual(BL.columns("CB", "pr").map((c) => c.h), ["Sk", "Sk yds", "QB hits", "Press.", "TFL"]);
  const ew = pure("16719"), p = item(ew.R, "Pressures");
  t.deepEqual([p.value, p.n, p.of], ["9", 9, 10], "pressures: Week 1 has no PFR record, so 9 of 10 games, never a complete figure");
  const w2 = ew.wk(2).box; t.deepEqual([BL.scoredTackles(w2), w2.def_tackles_ast], [7, 3], "Williams Week 2: TK 7, AS 3 (v2: 7 x 1.3 + 3 x 0.8 + ... = 16.5)"); t.equal(ew.wk(2).pts, 16.5);
  const wa = pure("13214");
  t.equal(wa.wk(5).part, "Played, no stat line", "51 defensive snaps and no box row"); t.equal(wa.wk(5).pts, 0, "MFL's 0.0 is a recorded score"); t.equal(wa.wk(5).box, null);
  t.equal(wa.wk(9).bye, true); t.equal(wa.R.games, 8, "8 games with a stat line, 9 played");
});

test("K (Sanders): made/attempted by distance from sums; 0/0 from 60+ is a real zero; the missed-kick distance gap is said", async () => {
  const { R } = pure("13832");
  t.equal(val(R, "Field goals made/attempted"), "25/28"); t.equal(val(R, "Field goal rate"), "89.3%"); t.equal(val(R, "0 to 39 yards"), "14/14"); t.equal(val(R, "40 to 49 yards"), "7/8"); t.equal(val(R, "50 to 59 yards"), "4/6");
  t.equal(val(R, "60 yards or more"), "0/0"); t.equal(val(R, "Extra points made/attempted"), "13/14");
  t.deepEqual(BL.viewsFor("PK").map((v) => v[1]), ["Fantasy", "Kicking"]); t.deepEqual(BL.columns("PK", "kick").map((c) => c.h), ["FG", "0-39", "40-49", "50-59", "60+", "XP"]);
  const { intel: I } = await intel(["13832"]); const h = text(BD.panel(state(I), P("13832", "PK", "NYJ")));
  t.match(h, /Missed-kick distances are not in the stats feed\./); t.doesNotMatch(h, /Red zone|Usage|Targets/);
});

test("P (Mann): Punts, Gross average, Inside 20 and Inside 20% only; blocked punts in the detail; no net, touchbacks, longest or inside-20 bands", async () => {
  const { R, wk } = pure("14985");
  t.equal(val(R, "Punts"), "49"); t.equal(val(R, "Gross average"), "47.5"); t.equal(val(R, "Inside 20"), "22"); t.equal(val(R, "Inside 20 rate"), "44.9%", "22 / 49 from the season sums");
  t.deepEqual(R.sections.map((s) => s.items.map((i) => i.label)), [["Punts", "Gross average", "Inside 20", "Inside 20 rate"]]);
  t.deepEqual(BL.columns("PN", "punt").map((c) => c.h), ["Punts", "Gross", "In 20", "In 20%"]);
  t.deepEqual(BL.punterBands(), { state: "not_reconciled" }, "the bands are a hook only, never drawn");
  t.equal(wk(10).bye, true, "PHI's Week 10 bye: his latest club, which is also his current club");
  const { intel: I } = await intel(["14985"]), p = P("14985", "PN", "PHI");
  const all = BD.panel(state(I), p) + BD.panel(state(I, { bd: { v: { 14985: "punt" }, g: { 14985: 1 } } }), p);
  t.doesNotMatch(text(all), /\bNet\b|net average|Touchback|Longest|Inside 5|Inside 10/i);
  t.match(text(all), /Blocked punts Not available/);
});

test("team changes: Cousins (LV Weeks 1-9, MIN Week 10) and Hooker (TEN, then BUF) take each week's club from his own row, never from his current club", () => {
  const c = pure("10700");
  for (let w = 1; w <= 9; w++) t.equal(c.wk(w).club, "LVR", "Cousins Week " + w);
  t.equal(c.wk(10).club, "MIN"); t.equal(c.wk(10).game.opp, "GBP"); t.equal(c.wk(10).game.home, false);
  t.equal(c.wk(6).bye, false, "MIN's bye is Week 6, but he played for LV that week"); t.equal(c.wk(6).game.opp, "BUF");
  t.equal(c.wk(11).club, "MIN"); t.equal(c.wk(11).clubHow, "current"); t.equal(c.wk(11).game.neutral, true, "Week 11 in Mexico City");
  const h = pure("14182");
  for (const w of [1, 2, 3, 4, 6, 7, 8]) t.equal(h.wk(w).club, "TEN");
  t.equal(h.wk(10).club, "BUF");
  t.equal(h.wk(5).club, "TEN"); t.equal(h.wk(5).clubHow, "between"); t.equal(h.wk(5).part, "No snaps recorded", "TEN played; no snap row although he has them all season");
  t.equal(h.wk(9).club, "", "between TEN (bye Week 9) and BUF: club not established"); t.equal(h.wk(9).bye, false); t.equal(h.wk(9).game, null); t.equal(h.wk(9).part, "Club not established");
});

test("neutral sites: the 2026 list equals nflverse games.csv (location Neutral), in MFL codes", () => {
  const mine = Object.keys(BL.NEUTRAL).sort();
  const theirs = FXB.neutral.map((g) => { const a = BL.toMfl(g.away), b = BL.toMfl(g.home), p = [a, b].sort(); return "2026:" + g.week + ":" + p[0] + "-" + p[1]; }).sort();
  t.deepEqual(mine, theirs); t.equal(mine.length, 9);
});

test("newer weeks: a score after the cutoff is shown with its status, outside the season figures", async () => {
  const sc11 = {}; for (let w = 1; w <= 10; w++) { const r = FX4.scores[w].find((x) => x.id === "17149"); if (r) sc11[w] = Number(r.score); } sc11[11] = 2.0;   // the recorded Week 11 (Thursday) score
  const tu = pure("17149", { scores: sc11 });
  t.equal(tu.wk(11).newer, true); t.equal(tu.wk(11).pts, 2.0); t.equal(tu.wk(11).part, "Stats not in yet"); t.equal(tu.wk(11).rank, "");
  t.equal(tu.R.to, 10, "the rollup stops at the cutoff");
  const { intel: I } = await intel(["17149"]); const h = BD.panel(state(I), P("17149", "DE", "IND"));
  t.match(h, /<tr class="newer"><th class="pin"><button data-act="bdg" data-v="11"/); t.match(text(h), /L 3–26 · not in season figures/);
});

test("the cutoff: the Breakdown runs on Team › Performance's shared week W* (tabviews.seasonCutoff); history one week behind moves the rollup and the log together, and the newer all-final week stays in the log with its status", async () => {
  const p = P("16185");
  const { intel: I } = await intel(["16185"]);
  const c = TV.seasonCutoff(state(I)); t.equal(c.state, "ok"); t.equal(c.week, 10, "complete history: W* = the all-final week");
  t.match(text(BD.panel(state(I), p)), /Through Week 10/);
  // R6 integration: the real shared cutoff with team history through Week 9 (scores final through Week 10)
  const { intel: I9 } = await intel(["16185"], { hist: histAt(9) });
  const c9 = TV.seasonCutoff(state(I9)); t.equal(c9.week, 9); t.equal(c9.allFinal, 10); t.equal(c9.reason, "history_behind");
  const raw = BD.panel(state(I9), p), h = text(raw);
  t.match(h, /Through Week 9 · 260\.9 pts · 9 scored games/); t.match(h, /Season stats · Weeks 1–9/); t.match(h, /Targets 99 —/);
  t.match(h, /W 21–13 · not in season figures/, "Week 10 (all final) is in the log as newer");
  t.match(raw, /<tr class="newer"><th class="pin"><button data-act="bdg" data-v="10"/);
  const fig = TV.perfFigures(state(I9), "16185"); t.equal(fig.n, 9, "the main card counts the same 9 games"); t.ok(Math.abs(fig.total - 260.9) < 1e-9, "and the same points");
  // an unreadable score in the newer week: its row says so; the settled figures stand
  const sc = clone(FX4.scores); sc["10"] = sc["10"].map((x) => (x.id === "16185" ? { id: x.id, score: "N/A" } : x));
  const { intel: Ib } = await intel(["16185"], { hist: histAt(9), scores: sc }), hb = BD.panel(state(Ib), p);
  t.match((hb.split('data-act="bdg" data-v="10"')[1] || "").split("</tr>")[0], /title="This score could not be read">\?</, "Week 10 reads as unreadable in the log, not a dash");
  t.match(text(hb), /Through Week 9 · 260\.9 pts · 9 scored games/); t.doesNotMatch(text(hb), /could not be read, so his season figures are not shown/);
  const real = TV.seasonCutoff;
  TV.seasonCutoff = () => ({ state: "loading", week: null });
  try { t.match(BD.panel(state(I), p), /Loading the breakdown/); } finally { TV.seasonCutoff = real; }
});

test("R6 integration: the main card's Breakdown control opens this Breakdown in place (same detail flow), without the summary the card already shows", async () => {
  const { intel: I } = await intel(["16185"]);
  const tm = state(I).model.teams.find((x) => x.players.some((q) => q.id === "16185"));
  const S1 = state(I, { teamId: tm.id, pf: { s: "pos", open: { 16185: true }, res: {} } });
  const html = TV.performanceBody(S1), seg = (html.split('data-act="card" data-pid="16185"')[1] || "").split('<div class="rw pfc">')[0], tx = text(seg);
  t.match(seg, /<div class="det pfbd">/); t.match(seg, /data-bdpid="16185"/, "app.js asks for his game-stats read from this marker");
  t.match(tx, /Season stats · Weeks 1–10/); t.match(tx, /Game log/); t.equal((seg.match(/data-act="bdv" data-v="\w+" data-pid="16185"/g) || []).length, 4, "the four weekly views");
  t.doesNotMatch(seg, /class="bdsum"/, "no summary line"); t.doesNotMatch(tx, /Through Week|scored games? ·|pts · /, "no repeated cutoff, points or game count");
  t.equal((tx.match(/scored games/g) || []).length, 1, "the game count once, on the card");
  t.equal((tx.match(/Tot\. Pts\.\s+[\d,]+\.\d/g) || []).length, 1, "Tot. Pts. once, on the card");
  t.doesNotMatch(tx, /xFP PPG\s+(?!Not Available)\S|Over Expectations\s+(?!Not Available)\S/, "model slots stay Not Available");
  const closed = TV.performanceBody(state(I, { teamId: tm.id })), segc = (closed.split('data-act="card" data-pid="16185"')[1] || "").split('<div class="rw pfc">')[0];
  t.doesNotMatch(segc, /data-bdpid|class="det/, "closed: no Breakdown and no read marker");
});

test("missing is not zero: no stat line, an unread week, an unreadable score and a failed read each say so", async () => {
  const { intel: I } = await intel(["16641", "16185"]);
  const bo = BD.panel(state(I), P("16641"));
  t.match(bo, /<b>W1<\/b> <span class="nw">—<\/span><small><\/small><\/button><\/th><td class="n"><span class="mu">—<\/span><\/td><td class="n mu">—<\/td><td>—<small>Club not established<\/small><\/td>/);
  const S2 = state(clone(I)); S2.intel.scores[4] = { state: "error", error: "HTTP 503" };
  const h2 = BD.panel(S2, P("16185")); t.match(text(h2), /1 week of scores could not be read and show n\/a\. Try again/); t.match(h2, /data-act="retrylog"/); t.match(text(h2), /season points not shown/);
  const sc = clone(FX4.scores); sc["3"] = sc["3"].map((x) => (x.id === "16185" ? { id: x.id, score: "N/A" } : x));
  const { intel: I3 } = await intel(["16185"], { scores: sc }); const h3 = BD.panel(state(I3), P("16185"));
  t.match(text(h3), /1 score could not be read, so his season figures are not shown\./); t.match(h3, /<span class="mu" title="This score could not be read">\?<\/span>/);
  const S4 = state(clone(I)); S4.intel.box["16185"] = { state: "error", error: "HTTP 503" };
  const h4 = BD.panel(S4, P("16185")); t.match(text(h4), /Game stats didn’t load \(HTTP 503\)\. Try again/); t.match(h4, /data-act="retrybox" data-pid="16185"/); t.doesNotMatch(h4, /data-act="bdv"/, "only the fantasy view without the stats");
});

test("recorded preview: no game-stats answer in the recording, so the Breakdown shows the fantasy history and one line", async () => {
  const { intel: I } = await intel([]); const S = state(I, { recorded: { at: "x", label: "x" } }); S.intel.box["16185"] = { state: "absent" };
  const h = BD.panel(S, P("16185")), tx = text(h);
  t.match(tx, /Game stats aren’t in this recording; the log shows fantasy points only\./); t.equal((tx.match(/aren’t in this recording/g) || []).length, 1, "said once");
  t.doesNotMatch(h, /data-act="bdv"/); t.doesNotMatch(tx, /Season stats/); t.match(h, /<td class="n"><b>36\.3<\/b><\/td>/);
});

test("the Breakdown draws no inline style, script, form field or write control, and every control is a known one", async () => {
  const { intel: I } = await intel(["16185", "14782", "17556", "13832", "14985"]);
  for (const [id, pos, club] of [["16185"], ["14782"], ["17556"], ["13832", "PK", "NYJ"], ["14985", "PN", "PHI"]]) {
    const views = BL.viewsFor(pos || POS[id].position).map((v) => v[0]);
    for (const v of views) {
      const h = BD.panel(state(I, { bd: { v: { [id]: v }, g: { [id]: 3 } } }), P(id, pos, club));
      t.doesNotMatch(h, /<script|\sstyle=|<form|<input|<textarea|<select|\son[a-z]+\s*=|\shref=|\ssrc=/i);
      [...h.matchAll(/data-act="([a-z]+)"/g)].forEach((m) => t.ok(["bdv", "bdg", "retrybox", "retrylog", "retryperf"].includes(m[1]), "control " + m[1]));
    }
  }
});

await run("mobile2027_r6_breakdown");
