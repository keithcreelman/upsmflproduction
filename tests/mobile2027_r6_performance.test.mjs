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
test("seasonCutoff: complete history -> L; one week behind -> L-1; unavailable -> L (PPG rank '—' for all); two or more behind -> L, history treated as stale", () => {
  const h = (T) => histAt(T);
  t.deepEqual(CH.seasonCutoff(10, h(10)), { week: 10, allFinal: 10, reason: "complete", historyThrough: 10 });
  t.deepEqual(CH.seasonCutoff(10, h(9)), { week: 9, allFinal: 10, reason: "history_behind", historyThrough: 9 });
  const p = clone(FX4.hist); p.teamHistoryThrough = 11; t.deepEqual(CH.seasonCutoff(10, p), { week: 10, allFinal: 10, reason: "complete", historyThrough: 11 }, "a partial week ahead never moves W* past L");
  t.equal(CH.seasonCutoff(10, null).week, 10); t.equal(CH.seasonCutoff(10, null).reason, "history_unavailable"); t.equal(CH.seasonCutoff(10, null).history, "absent");
  t.equal(CH.seasonCutoff(10, { teamHistoryState: "unavailable", teamHistoryReason: "no_history" }).history, "no_history");
  t.deepEqual(CH.seasonCutoff(10, h(8)), { week: 10, allFinal: 10, reason: "history_stale", historyThrough: 8 });
  t.equal(CH.seasonCutoff(0, h(1)).week, null); t.equal(CH.seasonCutoff(null, null).week, null);
});

test("screen: 'Through Week N' once; with history one week behind every figure and both ranks wait at Week 9; caught up, Week 10; no history, Week 10 with PPG ranks '—'", async () => {
  const S9 = state({ intel: await intel({ lm: LM(9) }) }), h9 = body(V.app(S9)), S10 = state({ intel: await intel() }), h10 = body(V.app(S10)), Sn = state({ intel: await intel({ lm: noHist() }) }), hn = body(V.app(Sn));
  t.equal((text(h9).match(/Through Week \d+/g) || []).join("|"), "Through Week 9"); t.equal((text(h10).match(/Through Week \d+/g) || []).join("|"), "Through Week 10"); t.equal((text(hn).match(/Through Week \d+/g) || []).join("|"), "Through Week 10");
  t.deepEqual(TV.seasonCutoff(S9), { state: "ok", week: 9, allFinal: 10, reason: "history_behind", historyThrough: 9 }, "the Breakdown reads the same week");
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
  const dataSrc = fs.readFileSync(path.join(SRC, "lib/data.js"), "utf8"); t.doesNotMatch(dataSrc, /projectedScores|projection|xfp/i, "no projection or model read on the allowlist");
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
test("projection slot: 'Week 11 Proj.' (the lineup week), smaller and after the main figures, 'Not Available' (no projection read is authorized)", async () => {
  const S = state({ intel: await intel() }), html = body(V.app(S)), c = card(html, ID.purdy);
  t.match(c, /<span class="pfp">Week 11 Proj\. <b class="na">Not Available<\/b><\/span>/);
  t.ok(c.indexOf("Week 11 Proj.") > c.indexOf("Over Expectations") && c.indexOf("Over Expectations") > c.indexOf("Actual PPG") && c.indexOf("Actual PPG") > c.indexOf("Tot. Pts."), "hierarchy: Tot. Pts., Actual PPG; then xFP PPG, Over Expectations; then the projection");
  t.deepEqual(TV.projectionSlot(S, S.model.byId[ID.purdy]), { label: "Week 11 Proj.", value: null, text: "Not Available" });
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
