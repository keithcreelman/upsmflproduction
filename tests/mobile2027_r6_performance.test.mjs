// UPS 2027 R6 (Keith 2026-11-23): Team › Performance main screen, the shared season cutoff W*, the one-week-behind fix, the xFP / projection gates.
//   node tests/mobile2027_r6_performance.test.mjs
// Real recorded public data (Weeks 1 to 10, team history through Week 10) plus small constructed fixtures (the v4 cutoff fixture: a player who scored
// every week, a bye player, a 9-of-10 player).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "apps", "mobile2027", "src");
const require = createRequire(import.meta.url);
const M = require(path.join(SRC, "lib/model.js")), D = require(path.join(SRC, "lib/data.js")), V = require(path.join(SRC, "lib/views.js")), X = require(path.join(SRC, "lib/complete.js"));
const K = require(path.join(SRC, "lib/ranks.js")), CH = require(path.join(SRC, "lib/clubhist.js")), TV = require(path.join(SRC, "lib/tabviews.js"));
const FX = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/public_reads.json"), "utf8"));
const FX3 = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/r3_reads.json"), "utf8"));
const FX4 = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/r4_reads.json"), "utf8"));
const CAL = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/calendar_2026.json"), "utf8"));
const PROJ = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/projection_capture_sample.json"), "utf8"));
const CFG = { workerBase: "https://upsmflproduction.keith-creelman.workers.dev", leagueId: "74598", season: "2026" };
const text = (html) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const clone = (x) => JSON.parse(JSON.stringify(x));
const body = (html) => html.split('id="screen"')[1].split("<nav")[0];
const histAt = (T) => { const h = clone(FX4.hist); h.teamHistoryThrough = T; Object.keys(h.teamHistory).forEach((id) => { const e = h.teamHistory[id]; e.seg = e.seg.filter((s) => s[1] <= T).map((s) => [s[0], s[1], Math.min(s[2], T)]); if (!e.seg.length) delete h.teamHistory[id]; }); Object.keys(h.teamHistoryFirst).forEach((id) => { if (h.teamHistoryFirst[id] > T) delete h.teamHistoryFirst[id]; }); return h; };
const LM = (T) => Object.assign({}, clone(FX3.lineup_matchups_w11), T ? histAt(T) : clone(FX4.hist));
const noHist = () => { const o = LM(); ["teamHistoryState", "teamHistoryReason", "teamHistoryThrough", "teamHistory", "teamHistoryMissing", "teamHistoryConflict", "teamHistoryFirst"].forEach((k) => delete o[k]); return o; };
const named = (p) => (p.name ? p : Object.assign({ name: "Player, " + p.id }, p));
async function intel(over) {
  over = over || {};
  const lm = over.lm || LM();
  const ok = (b) => ({ ok: true, status: 200, text: async () => JSON.stringify(b) });
  const fake = async (url) => {
    const u = new URL(url), ty = u.searchParams.get("TYPE"), w = u.searchParams.get("W");
    if (u.pathname === "/api/lineup-matchups") return ok(Object.assign({}, lm, { week: Number(w) }));
    if (ty === "playerScores") return ok({ playerScores: { playerScore: (over.scores || FX4.scores)[w] || (w === "11" ? [{ id: "1", score: "0" }] : []) } });
    if (ty === "players") return ok({ players: { player: (over.players || FX4.players).map(named) } });
    if (ty === "nflByeWeeks") return ok(CAL.byes);
    if (ty === "nflSchedule" && w === "ALL") return ok(CAL.full);
    if (ty === "nflSchedule") return ok(w === "10" ? FX4.schedule10 : w === "11" ? FX4.schedule11 : { nflSchedule: { matchup: [] } });
    return ok({});
  };
  const L = D.createLoader(CFG, fake), rec = (r) => ({ state: r.state, data: r.data, error: r.error, at: Date.now() });
  const out = { status: null, mu: { 11: rec(await L.loadMatchups(11)) }, wk: {}, scores: {}, sched: {}, players: rec(await L.loadPlayers()) };
  for (const w of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) out.scores[w] = rec(await L.loadScores(w));
  for (const w of [10, 11]) out.sched[w] = rec(await L.loadSchedule(w, X.parseSchedule));
  out.cal = rec(await L.loadCalendar(X.parseCalendar));
  Object.keys(out.scores).forEach((k) => { out.scores[k].at += 1000; });
  return out;
}
const state = (over) => ({ model: M.build(FX.roster_workbench, FX.league, FX.weekly_results, 11, 2026), load: { core: "ok", coreNotes: [] }, penalty: { state: "idle" }, ns: { state: "idle" }, teamId: "0010", tab: "team", sub: "performance", view: "lineup",
  open: {}, flags: {}, profile: null, sheet: null, skin: "system", vib: "1", build: "test", requestLog: [], gdef: "needs", wk: null, live: null, pf: { s: "pos", open: {}, res: {} },
  requestSummary: { requests: 0, ok: 0, failed: 0, refused: 0, nonGet: 0 }, ...(over || {}) });
const card = (html, id) => (html.split('data-act="card" data-pid="' + id + '"')[1] || "").split('<div class="rw pfc">')[0].split('<div class="det')[0];
const actives = (S) => S.model.teams.find((x) => x.id === "0010").players.filter((p) => p.status === "active");
const ID = { purdy: "15698", shaheed: "16080" };

// ---------------- compact rank text ----------------
test("compact rank: exact 'QB2', bounded 'QB2–4' (never the best alone), unsupported '—'; ties share the rank", () => {
  t.equal(K.compactRank({ group: "QB", best: 2, worst: 2, poolLo: 35, poolHi: 54, exact: true }), "QB2");
  t.equal(K.compactRank({ group: "QB", best: 2, worst: 4, poolLo: 35, poolHi: 54, exact: false }), "QB2–4");
  t.equal(K.compactRank(null), "—"); t.equal(K.compactRank({ group: "", best: 1, worst: 1, exact: true }), "—"); t.equal(K.compactRank({ group: "QB", best: 3, worst: 2, exact: false }), "—", "an impossible bound is unsupported");
  const g = () => "QB", sf = K.seasonFrom({ 1: { a: 30, b: 20, c: 20, d: 20, e: 10 } }, 1, g);
  t.deepEqual(["a", "b", "c", "d", "e"].map((id) => K.compactRank(K.totalRank(sf.entries, id, sf.unplaced))), ["QB1", "QB2", "QB2", "QB2", "QB5"], "three tied players all read QB2; the next is QB5");
  const pg = (id) => K.compactRank(K.perGameRank([{ id: "x", group: "WR", total: 1000, n: 5, status: "eligible" }, { id: "y", group: "WR", total: 2000, n: 10, status: "eligible" }, { id: "z", group: "WR", total: 900, n: 5, status: "eligible" }], id));
  t.deepEqual([pg("x"), pg("y"), pg("z")], ["WR1", "WR1", "WR3"], "an exact per-game tie (10.0 and 10.0) shares the rank");
});

// ---------------- the shared cutoff W* ----------------
test("seasonCutoff (R7 decision 2): complete history -> L; behind by ANY number of weeks -> the history's week; unavailable as a whole -> L (PPG rank '—' for all)", () => {
  const h = (T) => histAt(T);
  t.deepEqual(CH.seasonCutoff(10, h(10)), { week: 10, allFinal: 10, reason: "complete", historyThrough: 10, gap: 0 });
  t.deepEqual(CH.seasonCutoff(10, h(9)), { week: 9, allFinal: 10, reason: "history_behind", historyThrough: 9, gap: 1 });
  const p = clone(FX4.hist); p.teamHistoryThrough = 11; t.deepEqual(CH.seasonCutoff(10, p), { week: 10, allFinal: 10, reason: "complete", historyThrough: 11, gap: 0 }, "a partial week ahead never moves W* past L");
  t.equal(CH.seasonCutoff(10, null).week, 10); t.equal(CH.seasonCutoff(10, null).reason, "history_unavailable"); t.equal(CH.seasonCutoff(10, null).history, "absent");
  t.equal(CH.seasonCutoff(10, { teamHistoryState: "unavailable", teamHistoryReason: "no_history" }).history, "no_history");
  t.deepEqual(CH.seasonCutoff(10, h(8)), { week: 8, allFinal: 10, reason: "history_behind", historyThrough: 8, gap: 2 }, "two weeks behind: every figure waits at Week 8 (the R6 'keep figures, withhold the PPG rank' branch is gone)");
  t.deepEqual(CH.seasonCutoff(10, h(5)), { week: 5, allFinal: 10, reason: "history_behind", historyThrough: 5, gap: 5 });
  t.equal(CH.seasonCutoff(0, h(1)).week, null); t.equal(CH.seasonCutoff(null, null).week, null);
  t.doesNotMatch(fs.readFileSync(path.join(SRC, "lib/clubhist.js"), "utf8").split("function seasonCutoff")[1], /history_stale/, "no stale branch left in seasonCutoff");
});

test("R7: history two weeks behind: Tot. Pts., Actual PPG, scored games and BOTH ranks all run through Week 8; one header line says so; Weeks 9 and 10 are newer rows in the Breakdown", async () => {
  const S8 = state({ intel: await intel({ lm: LM(8) }) }), h8 = body(V.app(S8)), tx = text(h8);
  t.equal((tx.match(/Through Week \d+/g) || []).join("|"), "Through Week 8");
  t.equal((tx.match(/Team history is 2 weeks behind, so every figure waits at Week 8\./g) || []).length, 1, "one concise line");
  t.deepEqual(TV.seasonCutoff(S8), { state: "ok", week: 8, allFinal: 10, reason: "history_behind", historyThrough: 8, gap: 2 });
  const sum = (to) => { let s = 0, n = 0; for (let w = 1; w <= to; w++) { const x = FX4.scores[String(w)].find((y) => y.id === ID.purdy); if (x) { s += Number(x.score); n++; } } return { s, n }; };
  const a8 = sum(8), c = text(card(h8, ID.purdy));
  t.match(c, new RegExp("Tot\\. Pts\\.\\s+" + a8.s.toFixed(1).replace(".", "\\.") + "\\s+QB\\d")); t.match(c, new RegExp(a8.n + " scored games"));
  t.match(c, /Actual PPG\s+\d+\.\d\s+QB\d/, "the PPG rank is supported at Week 8, not withheld");
  const f = TV.perfFigures(S8, ID.purdy), ctx = TV.perfCtx(S8, [ID.purdy]);
  t.equal(f.n, a8.n); t.equal(ctx.rank.cutoff, 8, "both ranks on Week 8"); t.equal(ctx.input.latestFinal, 8); t.equal(ctx.input.allFinal, 10);
  t.equal(ctx.rank.weekRank(9, ID.purdy), "", "no weekly rank inside the settled summary past W*");
  // the Breakdown: the same Week 8 summary; Weeks 9 and 10 are drawn as newer rows outside it
  S8.pf = { s: "pos", open: { [ID.purdy]: true }, res: {} }; S8.bd = { v: {}, g: {}, t: { [ID.purdy]: "log" } };   // R8: the Game log tab
  const bd = body(V.app(S8)).split('data-act="card" data-pid="' + ID.purdy + '"')[1].split('<div class="rw pfc">')[0];
  t.match(bd, /<tr class="newer[^"]*"><th class="pin"><button data-act="bdg" data-v="10"/); t.match(bd, /<tr class="newer[^"]*"><th class="pin"><button data-act="bdg" data-v="9"/);
  t.doesNotMatch(bd, /<tr class="newer[^"]*"><th class="pin"><button data-act="bdg" data-v="8"/, "Week 8 is settled");
  // one week behind is the expected lag: no line
  const t9 = text(body(V.app(state({ intel: await intel({ lm: LM(9) }) }))));
  t.doesNotMatch(t9, /weeks behind/);
});

test("R7: the recorded case (no team history at all): Tot. Pts., Actual PPG, scored games and the Tot. Pts. rank through the last all-final week (10); the PPG rank '—' for everyone, said once", async () => {
  const Sn = state({ intel: await intel({ lm: noHist() }) }), hn = body(V.app(Sn)), c = text(card(hn, ID.purdy));
  t.deepEqual([TV.seasonCutoff(Sn).week, TV.seasonCutoff(Sn).reason], [10, "history_unavailable"]);
  t.match(c, /Tot\. Pts\.\s+270\.0\s+QB3\b/, "Tot. Pts. and its rank need no history"); t.match(c, /Actual PPG\s+30\.0\s+—/); t.match(c, /9 scored games/);
  t.equal((text(hn).match(/PPG ranks aren’t available yet\./g) || []).length, 1);
  actives(Sn).forEach((p) => t.match(text(card(hn, p.id)), /Actual PPG\s+(\d+\.\d|—)\s+—/, p.name + ": PPG rank —"));
});

test("screen: 'Through Week N' once; with history one week behind every figure and both ranks wait at Week 9; caught up, Week 10; no history, Week 10 with PPG ranks '—'", async () => {
  const S9 = state({ intel: await intel({ lm: LM(9) }) }), h9 = body(V.app(S9)), S10 = state({ intel: await intel() }), h10 = body(V.app(S10)), Sn = state({ intel: await intel({ lm: noHist() }) }), hn = body(V.app(Sn));
  t.equal((text(h9).match(/Through Week \d+/g) || []).join("|"), "Through Week 9"); t.equal((text(h10).match(/Through Week \d+/g) || []).join("|"), "Through Week 10"); t.equal((text(hn).match(/Through Week \d+/g) || []).join("|"), "Through Week 10");
  t.deepEqual(TV.seasonCutoff(S9), { state: "ok", week: 9, allFinal: 10, reason: "history_behind", historyThrough: 9, gap: 1 }, "the Breakdown reads the same week");
  t.equal(TV.seasonCutoff(S10).week, 10); t.equal(TV.seasonCutoff(Sn).reason, "history_unavailable");
  // Purdy's Weeks 1..9 total, from the recorded file (independent of the code under test)
  const sum = (to) => { let s = 0, n = 0; for (let w = 1; w <= to; w++) { const x = FX4.scores[String(w)].find((y) => y.id === ID.purdy); if (x) { s += Number(x.score); n++; } } return { s, n }; };
  const a9 = sum(9), a10 = sum(10);
  t.match(text(card(h9, ID.purdy)), new RegExp("Tot\\. Pts\\.\\s+" + a9.s.toFixed(1).replace(".", "\\.") + "\\s+QB\\d")); t.match(text(card(h9, ID.purdy)), new RegExp(a9.n + " scored games"));
  t.match(text(card(h10, ID.purdy)), new RegExp("Tot\\. Pts\\.\\s+" + a10.s.toFixed(1).replace(".", "\\.") + "\\s+QB3\\b"));
  t.match(text(card(h9, ID.purdy)), /Actual PPG\s+\d+\.\d\s+QB\d/, "the PPG rank is supported at Week 9 (no false conflict)");
  t.match(text(card(hn, ID.purdy)), /Actual PPG\s+30\.0\s+—/); t.match(text(hn), /PPG ranks aren’t available yet\./);
  const f9 = TV.perfFigures(S9, ID.purdy), f10 = TV.perfFigures(S10, ID.purdy); t.equal(f9.n, a9.n); t.equal(f10.n, a10.n);
});

// ---------------- the one-week-behind defect (v4 fx1 setup) ----------------
function fx1(through, Lpassed) {
  const L = 10, byeOf = { DAL: 14, BUF: 7, CHI: 5 };
  const P = [{ id: "A_all10", pos: "QB", club: "DAL" }, { id: "B_bye", pos: "QB", club: "BUF" }, { id: "C_9of10", pos: "QB", club: "DAL" }, { id: "D_miss10", pos: "QB", club: "DAL" }, { id: "E_bye5", pos: "QB", club: "CHI" }];
  const weeks = {}; for (let w = 1; w <= L; w++) { const m = {}; m.A_all10 = 20 + w; if (w !== 7) m.B_bye = 18 + w; if (w !== 3) m.C_9of10 = 15 + w; if (w !== 10) m.D_miss10 = 10 + w; if (w !== 5) m.E_bye5 = 12 + w; weeks[w] = m; }
  const byId = {}; P.forEach((p) => (byId[p.id] = { pos: p.pos, club: p.club }));
  const scores = {}; Object.keys(weeks).forEach((w) => (scores[w] = { state: "ok", at: 1, data: { week: +w, scores: weeks[w] } }));
  const S = { model: { byId: {}, teams: [], week: 11 }, intel: { players: { state: "ok", data: { byId } }, scores } };
  const ids = P.map((p) => p.id), first = {}; ids.forEach((id) => (first[id] = 1));
  const hist = { teamHistoryState: "ok", teamHistoryReason: null, teamHistoryThrough: through, teamHistory: {}, teamHistoryFirst: first, teamHistoryMissing: [], teamHistoryConflict: [] };
  const ctx = { mu: { tag: "fx1-" + through + "-" + Lpassed + "-" + Math.random() }, failed: false, loading: false, input: { through, latestFinal: Lpassed, hist, clubs: {}, byeOf, season: {}, scores: weeks, ids, newerFinal: { complete: true, clubs: {} } } };
  return { S, RD: TV.rankData(S, ctx), ids };
}
test("one-week-behind fix: history through 9 with the all-final week 10 passed in (the old mismatched input) no longer reads 'Team history conflict'; n, S and U share Week 9", () => {
  const lag = fx1(9, 10), cur = fx1(10, 10), lag9 = fx1(9, 9);
  t.equal(lag.RD.cutoff, 9, "rankData re-derives W* = 9"); t.equal(cur.RD.cutoff, 10);
  lag.ids.forEach((id) => { t.doesNotMatch(lag.RD.elig[id].why || "", /conflict/i, id + ": no false conflict"); t.equal(lag.RD.elig[id].status, "eligible", id); });
  t.deepEqual(lag.ids.map((id) => lag.RD.sf.totals[id].n), [9, 8, 8, 9, 8], "n counted through Week 9: all-weeks 9, bye 8, 9-of-10 (missing W3) 8, missing W10 9, bye-5 8");
  t.deepEqual(lag.ids.map((id) => lag.RD.ev.rows[id].elig.games), [9, 8, 9, 9, 8], "S through Week 9 (byes are not team games)");
  t.deepEqual(lag.ids.map((id) => K.compactRank(K.perGameRank(lag.RD.entries, id, lag.RD.unplacedGame))), lag9.ids.map((id) => K.compactRank(K.perGameRank(lag9.RD.entries, id, lag9.RD.unplacedGame))), "identical to passing W* directly");
  lag.ids.forEach((id) => { const r = K.perGameRank(lag.RD.entries, id, lag.RD.unplacedGame); t.equal(r.exact, true, id + " exact"); t.equal(r.poolHi, 5); });
  cur.ids.forEach((id) => { t.equal(cur.RD.elig[id].status, "eligible"); t.equal(K.perGameRank(cur.RD.entries, id, cur.RD.unplacedGame).exact, true); });
  t.deepEqual(cur.ids.map((id) => cur.RD.sf.totals[id].n), [10, 9, 9, 9, 9], "complete history: Weeks 1..10");
  t.equal(lag.RD.weekRank(10, "A_all10"), "", "Week 10 is outside the settled summary");
});

test("Reading A is unchanged: scores in at least half (rounded up) of the supported team games; unknown weeks widen only the upper bound", () => {
  t.deepEqual(K.eligibility(5, 10, 10, "ok"), { status: "eligible", need: 5, why: "" });
  t.deepEqual(K.eligibility(4, 10, 10, "ok"), { status: "below", need: 5, why: "Needs 5 of 10 team games" });
  t.deepEqual(K.eligibility(5, 9, 9, "ok").need, 5); t.equal(K.eligibility(4, 9, 9, "ok").status, "below");
  t.equal(K.eligibility(5, 8, 10, "ok").status, "eligible", "enough under every possible count"); t.equal(K.eligibility(3, 8, 10, "ok").status, "below"); t.equal(K.eligibility(4, 8, 10, "ok").status, "unsettled");
  t.equal(K.eligibility(0, 8, 8, "ok").status, "none"); t.equal(K.eligibility(11, 10, 10, "ok").why, "Team history conflict", "a real conflict is still a conflict");
});

// (On the full recorded snapshot, 486 rostered ids, the same comparison measured 179 rostered PPG ranks with the old code at through 9, 401 now, 400 with complete
// history: see the R6 notes. This fixture's roster is the older test roster.)
test("recorded scores, history one week behind: the screen shows as many PPG ranks at Week 9 as with complete history at Week 10, and no conflict from the lag", async () => {
  const run = async (lm) => { const I = await intel({ lm }), S = state({ intel: I }), ids = []; S.model.teams.forEach((tm) => tm.players.forEach((p) => ids.push(p.id))); const ctx = TV.perfCtx(S, ids); let shown = 0, conflict = 0; ids.forEach((id) => { const f = TV.statFigures(S, id, ctx.rank, false); if (f.gameRank !== "—") shown++; if (/conflict/i.test(f.gameWhy)) conflict++; }); return { shown, conflict, W: ctx.input.latestFinal, all: Object.values(ctx.rank.elig).filter((e) => e.status === "eligible").length }; };
  const lag = await run(LM(9)), cur = await run(LM());
  t.equal(lag.W, 9); t.equal(cur.W, 10);
  t.equal(lag.shown, 117, "rostered PPG ranks at W* = 9"); t.equal(cur.shown, 117, "rostered PPG ranks with complete history");
  t.equal(lag.conflict, 0); t.equal(cur.conflict, 0, "no conflict on a rostered row from the lag"); t.equal(lag.all, 1238, "eligible scorers league-wide at Week 9"); t.equal(cur.all, 1237);
});

// ---------------- identity / multi-team ambiguity stays local ----------------
test("an ambiguous week changes only that player's eligibility bounds; other players' eligibility is untouched and their ranks move only within his group, only if he could be ahead", () => {
  const L = 5, byeOf = { AAA: 9, BBB: 9, CCC: 3 }, mk = (amb) => {
    const byId = { amb: { pos: "WR", club: "AAA" }, w1: { pos: "WR", club: "AAA" }, w2: { pos: "WR", club: "AAA" }, q1: { pos: "QB", club: "AAA" } };
    const o = { w1: 10, w2: 8, q1: 20 }, weeks = { 1: Object.assign({ amb: 30 }, o), 2: Object.assign({ amb: 30 }, o), 3: Object.assign({}, o), 4: Object.assign({}, o), 5: Object.assign({}, o) };
    const scores = {}; Object.keys(weeks).forEach((w) => (scores[w] = { state: "ok", at: 1, data: { week: +w, scores: weeks[w] } }));
    // amb: with AAA in Weeks 1-2, then MFL says CCC (bye Week 3): Week 3 is unknown (AAA played, CCC had its bye) -> S = 4, U = 5, 2 scores: unsettled.
    // settled: AAA all five weeks -> S = 5, needs 3: below.
    const th = amb ? { amb: { seg: [["AAA", 1, 2]], cur: "CCC" } } : { amb: { seg: [["AAA", 1, 5]], cur: null } };
    const hist = { teamHistoryState: "ok", teamHistoryReason: null, teamHistoryThrough: L, teamHistory: th, teamHistoryFirst: { w1: 1, w2: 1, q1: 1 }, teamHistoryMissing: [], teamHistoryConflict: [] };
    if (amb) byId.amb.club = "CCC";
    const S = { model: { byId: {}, teams: [], week: 5 }, intel: { players: { state: "ok", data: { byId } }, scores } };
    return { S, RD: TV.rankData(S, { mu: { k: Math.random() }, failed: false, loading: false, input: { through: L, latestFinal: L, hist, clubs: {}, byeOf, season: {}, scores: weeks, ids: Object.keys(byId), newerFinal: { complete: true, clubs: {} } } }) };
  };
  const a = mk(true), b = mk(false);
  t.ok(a.RD.ev.rows.amb.elig.unknownWeeks.length >= 1, "his ambiguous week is unknown"); t.equal(b.RD.ev.rows.amb.elig.unknownWeeks.length, 0);
  ["w1", "w2", "q1"].forEach((id) => t.deepEqual(a.RD.elig[id], b.RD.elig[id], id + ": eligibility untouched by his ambiguity"));
  t.equal(K.compactRank(K.perGameRank(a.RD.entries, "q1", a.RD.unplacedGame)), "QB1", "another group: untouched");
  t.equal(a.RD.elig.amb.status, "unsettled", "2 scores in 4 or 5 possible games: his own eligibility is not settled (his PPG rank is '—')"); t.equal(b.RD.elig.amb.status, "below");
  t.equal(K.compactRank(K.perGameRank(a.RD.entries, "amb", a.RD.unplacedGame)), "—");
  t.equal(K.compactRank(K.perGameRank(b.RD.entries, "w1", b.RD.unplacedGame)), "WR1", "settled: he is below the minimum and out of the pool");
  t.equal(K.compactRank(K.perGameRank(a.RD.entries, "w1", a.RD.unplacedGame)), "WR1–2", "ambiguous: he could qualify with a higher PPG, so a WR's rank widens by one, never more");
  t.equal(K.compactRank(K.totalRank(a.RD.seasonEntries, "w1", a.RD.sf.unplaced)), K.compactRank(K.totalRank(b.RD.seasonEntries, "w1", b.RD.sf.unplaced)), "the Tot. Pts. rank never depends on history");
  t.equal(a.RD.sf.totals.amb.total, 6000, "his recorded history stays whole (no score is dropped)");
});

// ---------------- xFP / Over Expectations: hard gate ----------------
test("xFP gate: no source file reads a modeled value; xFP PPG and Over Expectations render exactly 'Not Available' on every card, whatever the state carries; exports carry no value", async () => {
  const files = ["app.js", ...fs.readdirSync(path.join(SRC, "lib")).map((f) => "lib/" + f)].filter((f) => f.endsWith(".js"));
  files.forEach((f) => { const src = fs.readFileSync(path.join(SRC, f), "utf8"); const hits = (src.match(/xfp/gi) || []).length, labels = (src.match(/xFP PPG/g) || []).length; t.equal(hits, labels, f + ": every 'xfp' is the label 'xFP PPG' (no identifier, field, route or file)"); t.doesNotMatch(src, /expected_?points|overExpect[a-z]*\s*[:=]\s*(?!null\b)[^\s]|xfp_20|wire\/data/i, f + ": no model field or file"); });
  // R7 (Keith, 2026-11-23, decision 5: integrate the stored-projection read): the one projection read allowed is the stored, kickoff-frozen
  // /api/player-projections; MFL's live projectedScores export and every model (xFP) read stay off the allowlist
  const dataSrc = fs.readFileSync(path.join(SRC, "lib/data.js"), "utf8"); t.doesNotMatch(dataSrc, /projectedScores|xfp/i, "no live projection or model read on the allowlist");
  t.deepEqual(D.RULES.map((r) => r.path).filter((p) => /proj|xfp|expect|model/i.test(p)), ["/api/player-projections"], "the stored-projection route is the only projection path");
  const I = await intel(); I.xfp = { state: "ok", data: { [ID.purdy]: 987.65 } }; I.model = { [ID.purdy]: { xfp: 987.65, overExpectations: 876.54 } };
  const S = state({ intel: I, xfp: { [ID.purdy]: 987.65 } }); S.model.byId[ID.purdy].xfp = 987.65; S.model.byId[ID.purdy].xfpPpg = 987.65; S.model.byId[ID.purdy].overExpectations = 876.54; S.model.byId[ID.purdy].projected = 765.43;
  S.pf = { s: "pos", open: Object.fromEntries(actives(S).map((p) => [p.id, true])), res: {} };
  const html = body(V.app(S));
  t.doesNotMatch(html, /987|876|765/, "no injected model value reaches the screen, opened Breakdowns included");
  actives(S).forEach((p) => { const c = card(html, p.id); t.match(c, /<span>xFP PPG<\/span><b><span class="na">Not Available<\/span><\/b>/, p.name); t.match(c, /<span>Over Expectations<\/span><b><span class="na">Not Available<\/span><\/b>/, p.name); });
  t.deepEqual(TV.modelSlots(), { ppg: null, overExpectations: null, text: "Not Available" });
  const f = TV.perfFigures(S, ID.purdy); t.equal(f.model.ppg, null); t.equal(f.model.overExpectations, null); t.doesNotMatch(JSON.stringify(f), /987|876|765/, "the export the Breakdown reads carries none either");
  const help = text(TV.screenHelp(S)); t.match(help, /xFP PPG and Over Expectations Not Available until/);
});

// ---------------- projection: week label now, selection rule tested, no read ----------------
test("projection slot: 'Week 11 Proj.' (the lineup week), smaller and after the main figures, 'Not Available' with no projection read in the state", async () => {
  const S = state({ intel: await intel() }), html = body(V.app(S)), c = card(html, ID.purdy);
  t.match(c, /<span class="pfp">Week 11 Proj\. <b class="na">Not Available<\/b><\/span>/);
  t.ok(c.indexOf("Week 11 Proj.") > c.indexOf("Over Expectations") && c.indexOf("Over Expectations") > c.indexOf("Actual PPG") && c.indexOf("Actual PPG") > c.indexOf("Tot. Pts."), "hierarchy: Tot. Pts., Actual PPG; then xFP PPG, Over Expectations; then the projection");
  const g = TV.projectionSlot(S, S.model.byId[ID.purdy]); t.deepEqual([g.label, g.value, g.text, g.why], ["Week 11 Proj.", null, "Not Available", "no_read"]);
});

// R7 (decision 5): the stored-projection read, as D.projections(season, week, ids) answers it (the #1515 route shape, claude/perf-data-backend
// worker/src/player_projections.js). STUB: the answers below are constructed around the recorded Week 11 kickoffs; nothing is read from the network.
// calendar_2026.json carries no kickoffs; MFL's recorded whole-season schedule WITH kickoffs is in r6_box.json (the Breakdown's fixture).
const FXB = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/r6_box.json"), "utf8"));
const DAYS = (() => { const out = {}; FXB.schedule.fullNflSchedule.nflSchedule.forEach((e) => { out[e.week] = e.matchup.map((m) => ({ kickoff: m.kickoff, secs: m.gameSecondsRemaining, teams: m.team.map((x) => ({ id: x.id, isHome: x.isHome, score: x.score })) })); }); return out; })();
const withKickoffs = (I) => { I.cal = Object.assign({}, I.cal, { data: Object.assign({}, I.cal.data, { days: DAYS }) }); return I; };
const projAnswer = (rows, over) => Object.assign({ ok: true, season: 2026, week: 11, provider: "MFL projectedScores (captured)", projections: rows }, over || {});
const isoAt = (sec) => new Date(sec * 1000).toISOString();
test("R7 projection: the latest capture strictly before HIS kickoff, frozen at kickoff; the first capture is used when the latest is after kickoff; otherwise Not Available", async () => {
  const I = withKickoffs(await intel()), S = state({ intel: I }), p = S.model.byId[ID.purdy], k = TV.kickoffOf(S, 11, p.nflTeam);
  t.equal(TV.kickoffOf(state({ intel: await intel() }), 11, p.nflTeam).ko, null, "a schedule without kickoffs gives none (never a guess)");
  t.ok(k.ko > 1.7e9, "his Week 11 kickoff comes from the recorded season schedule (" + k.ko + ")");
  const row = (latestOff, firstOff, v1, v2) => ({ projected_score: v1, captured_at: isoAt(k.ko + latestOff), first_projected: v2, first_captured_at: isoAt(k.ko + firstOff), capture_count: 4 });
  const slot = (ans, st) => { S.intel.proj = { 11: { state: st || "ok", data: ans, at: 1 } }; return TV.projectionSlot(S, p); };
  let g = slot(projAnswer({ [ID.purdy]: row(-3600, -86400, 21.4, 19.9) }));
  t.deepEqual([g.label, g.value, g.text, g.provider], ["Week 11 Proj.", 21.4, "21.4", "MFL"], "the latest pregame capture"); t.equal(g.capturedAt, (k.ko - 3600) * 1000);
  g = slot(projAnswer({ [ID.purdy]: row(600, -86400, 25.0, 19.9) })); t.equal(g.value, 19.9, "latest capture after kickoff: the earlier pregame capture stands (frozen at kickoff)");
  g = slot(projAnswer({ [ID.purdy]: row(0, 60, 25.0, 19.9) })); t.deepEqual([g.value, g.text, g.why], [null, "Not Available", "after_kickoff"], "a capture AT kickoff is not before it");
  g = slot(projAnswer({ [ID.purdy]: row(-60, -120, 0, 0) })); t.deepEqual([g.value, g.text], [0, "0.0"], "a real 0 is a projection");
  g = slot(projAnswer({ [ID.purdy]: row(-60, -120, null, null) })); t.equal(g.text, "Not Available", "a null value is never 0");
  t.equal(slot(projAnswer({ [ID.purdy]: null })).why, "no_row", "no row: Not Available");
  t.equal(slot(projAnswer({})).why, "no_row");
  t.equal(slot(projAnswer({ [ID.purdy]: row(-3600, -86400, 21.4, 19.9) }, { week: 10 })).why, "other_week", "an answer for another week is refused");
  t.equal(slot(projAnswer({ [ID.purdy]: row(-3600, -86400, 21.4, 19.9) }, { season: 2025 })).why, "other_week");
  t.equal(slot(projAnswer({ [ID.purdy]: row(-3600, -86400, 21.4, 19.9) }, { ok: false })).why, "failed");
  t.equal(slot(null, "error").why, "failed"); t.equal(slot(null, "loading").why, "loading"); t.equal(slot(null, "absent").why, "absent", "the recorded preview has no projection answer");
  // his club unknown or on a bye: no kickoff, no projection
  const moved = Object.assign({}, p, { nflTeam: "FA" }); S.intel.proj = { 11: { state: "ok", data: projAnswer({ [ID.purdy]: row(-3600, -86400, 21.4, 19.9) }), at: 1 } };
  t.equal(TV.projectionSlot(S, moved).why, "no_kickoff");
  const byeClub = Object.keys(S.intel.cal.data.byeOf).find((c) => S.intel.cal.data.byeOf[c] === 11);
  if (byeClub) t.equal(TV.projectionSlot(S, Object.assign({}, p, { nflTeam: byeClub })).why, "bye");
  t.deepEqual(TV.projectionRequest(S), { season: 2026, week: 11, ids: S.model.teams.find((x) => x.id === "0010").players.map((q) => String(q.id)) }, "what app.js asks D.projections for: the lineup week and this team's ids");
  t.ok(TV.projectionRequest(S).ids.length <= 80, "within the route's 80-id limit");
});

test("R8 projection on screen: only the card line 'Week 11 Proj. 21.4' (secondary); the Breakdown does not repeat it or explain the capture; the pregame evidence stays in the slot; Not Available otherwise", async () => {
  const I = withKickoffs(await intel()), S = state({ intel: I }), p = S.model.byId[ID.purdy], k = TV.kickoffOf(S, 11, p.nflTeam);
  S.intel.proj = { 11: { state: "ok", at: 1, data: projAnswer({ [ID.purdy]: { projected_score: 21.4, captured_at: isoAt(k.ko - 3600), first_projected: 19.9, first_captured_at: isoAt(k.ko - 86400), capture_count: 4 }, [ID.shaheed]: null }) } };
  let html = body(V.app(S));
  t.match(card(html, ID.purdy), /<span class="pfp">Week 11 Proj\. <b>21\.4<\/b><\/span>/); t.match(card(html, ID.shaheed), /<span class="pfp">Week 11 Proj\. <b class="na">Not Available<\/b><\/span>/);
  t.doesNotMatch(card(html, ID.purdy), /MFL|captured/i, "provider and capture time are not on the card");
  S.pf = { s: "pos", open: { [ID.purdy]: true, [ID.shaheed]: true }, res: {} }; html = body(V.app(S));
  const rowOf = (id) => text(html.split('data-act="card" data-pid="' + id + '"')[1].split('<div class="rw pfc">')[0]);
  t.equal((rowOf(ID.purdy).match(/Proj\./g) || []).length, 1, "the projection once, on the card"); t.doesNotMatch(rowOf(ID.purdy), /captured|kickoff|Frozen|MFL projection/i, "no capture or freeze explanation on screen");
  const g = TV.projectionSlot(S, p); t.equal(g.capturedAt, Date.parse(isoAt(k.ko - 3600)), "the capture time is kept internally"); t.equal(g.kickoff, k.ko * 1000, "and the kickoff it was checked against");
  t.doesNotMatch(rowOf(ID.shaheed), /His club has a bye/); t.equal(TV.projectionSlot(S, S.model.byId[ID.shaheed]).why, "bye", "Shaheed's club is on its Week 11 bye: the reason is the bye, not a missing row");
  t.equal(TV.projectionReason(TV.projectionSlot(S, S.model.byId[ID.shaheed])), "His club has a bye"); t.equal(TV.projectionReason(g), "");
  t.match(text(TV.screenHelp(S)), /Projection Provider: MFL\./, "the provider stays in Help"); t.doesNotMatch(text(TV.screenHelp(S)), /Breakdown shows when it was captured/);
  t.equal(TV.projectionSlot(S, Object.assign({}, p, { id: "99999" })).why, "no_row", "a player with a game and no captured row");
});

test("R7 weekly Rank column (Fantasy log): exact only ('QB4', no space, no pool), '—' otherwise, settled weeks only", async () => {
  const S = state({ intel: await intel() }); S.pf = { s: "pos", open: { [ID.purdy]: true, [ID.shaheed]: true }, res: {} }; S.bd = { v: {}, g: {}, t: { [ID.purdy]: "log", [ID.shaheed]: "log" } };
  const html = body(V.app(S));
  [ID.purdy, ID.shaheed].forEach((id) => {
    const seg = html.split('data-act="card" data-pid="' + id + '"')[1].split('<div class="rw pfc">')[0], tb = seg.split('<table class="bdt">')[1].split("</table>")[0];
    t.match(tb, /<th class="n" title="[^"]*">Rank<\/th>/);
    const rows = [...tb.matchAll(/<tr class="([^"]*)"><th class="pin">.*?data-v="(\d+)".*?<\/th>(.*?)<\/tr>/g)];
    t.ok(rows.length >= 9, id + ": a row per week");
    rows.forEach((m) => { const cells = [...m[3].matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((x) => text(x[1]).trim()); const rk = cells[1];
      t.match(rk, /^([A-Z]{1,2}\d+|—)$/, id + " W" + m[2] + ": '" + rk + "'"); t.doesNotMatch(rk, / of |–/);
      if (Number(m[2]) > 10) t.equal(rk, "—", "Week " + m[2] + " is not a completed week"); });
  });
  const ctx = TV.perfCtx(S, [ID.purdy]); t.equal(ctx.rank.weekRank(10, ID.purdy), "QB4");
});

test("projection rule on the recorded evidence: the latest capture strictly before HIS kickoff; a post-kickoff capture is never pregame (Week 5: 382 pregame / 641 after; Week 8: 980 / 3)", () => {
  t.deepEqual(PROJ.weeks["5"].counts, { pregame: 382, after_kickoff: 641, club_unknown: 12 }); t.deepEqual(PROJ.weeks["8"].counts, { pregame: 980, after_kickoff: 3, club_unknown: 12 });
  let pre = 0, post = 0;
  ["5", "8"].forEach((w) => PROJ.weeks[w].captures.forEach((c) => {
    const ko = PROJ.weeks[w].kickoff[c.club], r = X.pregameProjection([c], ko), before = Date.parse(c.captured_at) < ko * 1000;
    if (before) { pre++; t.deepEqual(r, { state: "ok", value: c.projected_score, capturedAt: Date.parse(c.captured_at) }, "W" + w + " " + c.player_id); } else { post++; t.deepEqual(r, { state: "none", why: "after_kickoff" }, "W" + w + " " + c.player_id + " captured after kickoff"); }
  }));
  t.ok(pre >= 6 && post >= 6, "both kinds checked (" + pre + " pregame, " + post + " after)");
  const ko = 1800000000, iso = (s) => new Date((ko + s) * 1000).toISOString().replace(/\.000Z$/, "Z");
  const caps = [{ projected_score: 10.1, captured_at: iso(-7200) }, { projected_score: 12.4, captured_at: iso(-60) }, { projected_score: 15.0, captured_at: iso(0) }, { projected_score: 18.0, captured_at: iso(3600) }];
  t.equal(X.pregameProjection(caps, ko).value, 12.4, "the latest before kickoff; at kickoff is not before");
  t.deepEqual(X.pregameProjection(caps.slice(2), ko), { state: "none", why: "after_kickoff" }); t.deepEqual(X.pregameProjection([], ko), { state: "none", why: "no_capture" }); t.deepEqual(X.pregameProjection(caps, null), { state: "none", why: "no_kickoff" });
  t.equal(X.pregameProjection([{ projected_score: "n/a", captured_at: iso(-10) }, { projected_score: 0, captured_at: iso(-20) }], ko).value, 0, "an unreadable value is skipped; a real 0 is a projection");
  t.deepEqual(X.pregameProjection([{ projected_score: 5, captured_at: "yesterday" }], ko), { state: "none", why: "no_capture" }, "an unreadable time is never assumed pregame");
});

// ---------------- removals ----------------
test("wording removals: no pool or 'rank is exact' on the card, no All/Starters/Bench, no team-level Actual PPG, no comparison block, no footer explanations", async () => {
  const S = state({ intel: await intel() }), html = body(V.app(S)), tx = text(html);
  t.doesNotMatch(tx, /of 73|of 240|\d+ of \d+–\d+|rank is exact|is exact|pool/i);
  t.doesNotMatch(html, /data-act="pff"|>Starters<|>All</);
  t.doesNotMatch(tx, /team (actual )?ppg|average per game for the team/i);
  t.doesNotMatch(tx, /Last 3 team games|Recent|Earlier|Difference|Final games only|Ranges can narrow|Season points|Per scored game|completed games/);
  t.equal((tx.match(/Through Week/g) || []).length, 1);
});

run("mobile2027_r6_performance");
