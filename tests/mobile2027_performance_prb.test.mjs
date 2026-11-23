// UPS 2027 beta (PR B): Team › Performance: the cutoff week, season production first, ranks beside figures, per-game completion and the live handoff.
//   node tests/mobile2027_performance_prb.test.mjs
// Real recorded public data: Weeks 1 to 10 of every player's score, the positions, the team-history fields, and the NFL schedules of Weeks 10 and 11 (the
// Thursday of Week 11: 1 of 13 games final, the Worker saying latestFinalWeek 11 and lastCompleteWeek 10).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "apps", "mobile2027", "src");
const require = createRequire(import.meta.url);
const M = require(path.join(SRC, "lib/model.js")), D = require(path.join(SRC, "lib/data.js")), V = require(path.join(SRC, "lib/views.js")), X = require(path.join(SRC, "lib/complete.js"));
const FX = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/public_reads.json"), "utf8"));
const FX3 = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/r3_reads.json"), "utf8"));
const FX4 = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/r4_reads.json"), "utf8"));
const CAL = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/calendar_2026.json"), "utf8"));
const TV = require(path.join(SRC, "lib/tabviews.js"));
const CFG = { workerBase: "https://upsmflproduction.keith-creelman.workers.dev", leagueId: "74598", season: "2026" };
const text = (html) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const clone = (x) => JSON.parse(JSON.stringify(x));
const body = (html) => html.split('id="screen"')[1].split("<nav")[0];
const LM = () => Object.assign({}, clone(FX3.lineup_matchups_w11), clone(FX4.hist));
// the recorded team history as the Worker would have sent it through Week T (every segment and first week clipped to T; v4 fx3)
const histAt = (T) => { const h = clone(FX4.hist); h.teamHistoryThrough = T; Object.keys(h.teamHistory).forEach((id) => { const e = h.teamHistory[id]; e.seg = e.seg.filter((s) => s[1] <= T).map((s) => [s[0], s[1], Math.min(s[2], T)]); if (!e.seg.length) delete h.teamHistory[id]; }); Object.keys(h.teamHistoryFirst).forEach((id) => { if (h.teamHistoryFirst[id] > T) delete h.teamHistoryFirst[id]; }); return h; };

// The shared player-list read keeps a row only when it has a name (it also names players on Team › Contracts); the recorded positions file has none, and the real export always does.
const named = (p) => (p.name ? p : Object.assign({ name: "Player, " + p.id }, p));
async function intel(over) {
  over = over || {};
  const lm = over.lm || LM();
  const fake = async (url) => {
    const u = new URL(url), ty = u.searchParams.get("TYPE"), w = u.searchParams.get("W");
    if (u.pathname === "/api/lineup-matchups") return ok(Object.assign({}, lm, { week: Number(w) }));
    if (ty === "playerScores") return ok({ playerScores: { playerScore: (over.scores || FX4.scores)[w] || (w === "11" ? [{ id: "1", score: "0" }] : []) } });
    if (ty === "players") return over.noPlayers ? { ok: false, status: 502, text: async () => "x" } : ok({ players: { player: (over.players || FX4.players).map(named) } });
    if (ty === "nflByeWeeks") return over.failCal ? { ok: false, status: 502, text: async () => "x" } : ok(CAL.byes);
    if (ty === "nflSchedule" && w === "ALL") return over.failCal ? { ok: false, status: 502, text: async () => "x" } : ok(over.calFull || CAL.full);
    if (ty === "nflSchedule") { if (over.failSched === w) return { ok: false, status: 502, text: async () => "x" }; return ok(w === "10" ? (over.schedule10 || FX4.schedule10) : w === "11" ? (over.schedule11 || FX4.schedule11) : { nflSchedule: { matchup: [] } }); }
    return ok({});
  };
  const ok = (b) => ({ ok: true, status: 200, text: async () => JSON.stringify(b) });
  const L = D.createLoader(CFG, fake), rec = (r) => ({ state: r.state, data: r.data, error: r.error, at: Date.now() });
  const out = { status: null, mu: { 11: rec(await L.loadMatchups(11)) }, wk: {}, scores: {}, sched: {}, players: rec(await L.loadPlayers()) };
  for (const w of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) out.scores[w] = rec(await L.loadScores(w));
  for (const w of [10, 11]) out.sched[w] = rec(await L.loadSchedule(w, X.parseSchedule));
  if (L.loadCalendar) out.cal = rec(await L.loadCalendar(X.parseCalendar));
  Object.keys(out.scores).forEach((k) => { out.scores[k].at += 1000; });   // the scores are read after the schedules, as the app does
  return out;
}
const state = (over) => ({ model: M.build(FX.roster_workbench, FX.league, FX.weekly_results, 11, 2026), load: { core: "ok", coreNotes: [] }, penalty: { state: "idle" }, ns: { state: "idle" }, teamId: "0010", tab: "team", sub: "performance", view: "lineup",
  open: {}, flags: {}, profile: null, sheet: null, skin: "system", vib: "1", build: "test", requestLog: [], gdef: "needs", wk: null, live: null, pf: { f: "all", s: "pos", open: {}, res: {} },
  requestSummary: { requests: 0, ok: 0, failed: 0, refused: 0, nonGet: 0 }, ...(over || {}) });
const perf = async (over, so) => body(V.app(state({ intel: await intel(over), ...(so || {}) })));
// R6: one card per player, from his name button to the next card
const row = (html, id) => (html.split('data-act="card" data-pid="' + id + '"')[1] || "").split('<div class="rw pfc">')[0];
const card = (html, id) => row(html, id).split('<div class="det')[0];   // the card without its opened Breakdown
const ID = { purdy: "15698", shaheed: "16080" };
// buttons nested inside buttons (a button cannot sit inside a button)
const nested = (html) => { let d = 0, bad = 0; for (const m of html.matchAll(/<(\/?)button\b/g)) { if (m[1]) d--; else { if (d > 0) bad++; d++; } } return bad; };

test("the cutoff is Week 10: Week 11 is a Thursday with 1 of 13 games final, so it is in no figure, whatever latestFinalWeek says", async () => {
  const lm = LM(); t.equal(lm.season.latestFinalWeek, 11); t.equal(lm.season.lastCompleteWeek, 10);
  const html = await perf(); t.match(text(html), /Through Week 10/); t.doesNotMatch(text(html), /Through Week 11/);
  t.equal((text(html).match(/Through Week \d+/g) || []).length, 1, "said once"); t.doesNotMatch(text(html), /Comparison through Week/);
});

test("R6 main card: Tot. Pts. and Actual PPG, each with its own compact positional rank, the scored-game count once (recorded Week 10)", async () => {
  const html = await perf(), p = text(card(html, ID.purdy)), s = text(card(html, ID.shaheed));
  t.match(p, /Tot\. Pts\.\s+270\.0\s+QB3\b/); t.match(p, /Actual PPG\s+30\.0\s+QB2(?!–)/); t.match(p, /9 scored games/); t.equal((p.match(/scored game/g) || []).length, 1, "the count once");
  t.match(s, /Tot\. Pts\.\s+66\.7\s+WR66\b/); t.match(s, /Actual PPG\s+8\.3\s+WR63–66/); t.match(s, /8 scored games/);
  t.doesNotMatch(p + s, /\d+ of \d+|of 73|of 240|is exact|rank is exact/, "no pool on the card");
  const open = text(row(await perf({}, { pf: { s: "pos", open: { [ID.shaheed]: true, [ID.purdy]: true }, res: {} } }), ID.shaheed));
  // R7 (decision 4): the Breakdown reads like the card ("WR66", "WR63–66"); the group size appears only in a RANGE's reasoning, never as "of N"
  t.match(open, /Actual PPG rank WR63–66 A range: 3 players who could rank ahead of him can’t be placed yet[^.]*\. WR group: 169–209 players\./); t.doesNotMatch(open, /Tot\. Pts\. rank/, "R8: an exact Tot. Pts. rank is on the card only, never repeated in the Breakdown");
  t.doesNotMatch(open, /[A-Z]{1,2} ?\d+(–\d+)? of \d+|of 240/, "no 'of N' pool anywhere in the Breakdown's rank lines");
  t.doesNotMatch(open, /is exact|are placed|is placed|are settled|Best 63|worst 66|worst case|a bound|unsettled|unplaced|without a position group/i, "no explanation of how a rank is bounded on a row");
});

test("ranks and pools are never exact when unsettled players could change them; a settled exact rank is the plain 'QB2'", async () => {
  const html = await perf(), p = text(card(html, ID.purdy));
  t.match(p, /Actual PPG\s+30\.0\s+QB2(?!–)/, "exact rank"); t.match(text(card(html, ID.shaheed)), /WR63–66/, "a range when unsettled players could rank ahead");
  t.doesNotMatch(text(html), /\d+\+/, "no 'N+' pool text: a supported range or nothing");
});

test("partial week: history through Week 11 does not move the cutoff past the last all-final week", async () => {
  const lm = LM(); lm.teamHistoryThrough = 11;
  const a = await perf({ lm }), b = await perf();
  t.match(text(a), /Through Week 10/);
  t.equal(text(row(a, ID.purdy)), text(row(b, ID.purdy)), "the same figures and ranks as with history through Week 10");
  const worse = LM(); worse.teamHistoryThrough = 13; t.match(text(await perf({ lm: worse })), /Team history unavailable/, "more than one week past the last all-final week is not believed");
});

test("evidence missing: no schedule means no cutoff and no season figure; a failed read says so with Retry and a disabled Report bug; nothing is guessed", async () => {
  for (const failSched of ["10"]) {
    const I = await intel({ failSched }); I.sched[10] = { state: "error", error: "x" };
    const html = body(V.app(state({ intel: I }))), tx = text(html);
    t.match(tx, /Couldn’t load this/); t.match(html, /data-act="retryperf"/); t.match(html, /<button class="btn" disabled aria-disabled="true">Report bug<\/button>/);
    t.doesNotMatch(tx, /Tot\. Pts\.|Through Week|QB\d|WR\d/);
  }
  const noLast = LM(); delete noLast.season.lastCompleteWeek; t.match(text(await perf({ lm: noLast })), /Couldn’t load this/, "no lastCompleteWeek in the answer: the cutoff cannot be established");
  const none = LM(); none.season.lastCompleteWeek = 0; t.match(text(await perf({ lm: none })), /No week has been completed yet/);
  const I2 = await intel(); I2.sched = {}; t.match(text(body(V.app(state({ intel: I2 })))), /Checking which games are final/, "schedule not read yet: loading, not a figure");
});

test("a week the Worker calls complete but the schedule does not: the cutoff steps back, never forward", async () => {
  const lm = LM(); lm.season.lastCompleteWeek = 11; // the Worker (wrongly) says Week 11 is complete; the schedule says 1 of 13 games is final
  const html = await perf({ lm }); t.match(text(html), /Through Week 10/);
});

test("team history unavailable or conflicting: season figures and the Tot. Pts. rank stay; the PPG rank is '—', and the reason is said once at the top, not on the row", async () => {
  const lm = LM(); lm.teamHistoryState = "unavailable"; lm.teamHistoryReason = "no_history"; lm.teamHistoryThrough = null; delete lm.teamHistory; delete lm.teamHistoryFirst;
  const html = await perf({ lm }), p = text(card(html, ID.purdy));
  t.match(p, /Tot\. Pts\.\s+270\.0\s+QB3\b/); t.match(p, /Actual PPG\s+30\.0\s+—/, "the per-game figure does not depend on team history; its rank is unsupported"); t.doesNotMatch(p, /Team history/); t.doesNotMatch(p, /QB2/);
  t.equal((text(html).match(/Team history unavailable/g) || []).length, 1, "a real reason (the Worker says none is recorded) is named once, at the top"); t.match(text(html), /Team history unavailable: none is recorded\./);
});

test("the players read failed: season totals still show; ranks are '—', never invented", async () => {
  const html = await perf({ noPlayers: true }), p = text(card(html, ID.purdy));
  t.match(p, /Tot\. Pts\.\s+270\.0\s+—/); t.doesNotMatch(p, /QB\d/); t.match(text(html), /Through Week 10/);
});

test("live handoff in the lineup week: scheduled (no chip), Live, Final · updating (week not complete), conflicting evidence (no Final claim)", async () => {
  const club = (id) => { const S0 = state(); return S0.model.byId[id].nflTeam.toUpperCase(); };
  const make = (secs, a, b) => { const s = clone(FX4.schedule11); s.nflSchedule.matchup.forEach((m) => { if (m.team.some((x) => x.id.toUpperCase() === club(ID.purdy))) { m.gameSecondsRemaining = secs; m.team[0].score = a; m.team[1].score = b; } }); return s; };
  const scores = clone(FX4.scores); scores["11"] = [{ id: "1", score: "0" }, { id: ID.purdy, score: "28.44" }];
  const chip = async (schedule11, lm) => text(row(await perf({ schedule11, scores, lm }), ID.purdy));
  t.doesNotMatch(await chip(make("3600", "", "")), /Live|Final/);
  t.match(await chip(make("1800", "7", "3")), /Live · 28\.4/);
  const lmFinal = LM(); Object.keys(lmFinal.matchups).forEach((c) => { if (c.toUpperCase() === club(ID.purdy)) lmFinal.matchups[c].status = "final"; });
  const fin = await chip(make("0", "24", "17"), lmFinal); t.match(fin, /Final · updating 28\.4/); t.doesNotMatch(fin, /not yet in season totals/);
  const conflict = await chip(make("0", "24", "17"), LM()); // the schedule says final; the Worker's status for his club does not
  t.doesNotMatch(conflict, /Final/); t.match(conflict, /Live · 28\.4/, "no 'Final' claim without agreeing evidence: the display stays Live");
  t.match(await chip(make("1800", "7", "3")), /Tot\. Pts\.\s+270\.0/, "the live score is in no season figure");
});

test("delayed handoff: every game of the lineup week is final but the season figures have not advanced; after the quiet period the chip says so, with Retry; the regular display includes the week when it catches up", async () => {
  const done = clone(FX4.schedule11); done.nflSchedule.matchup.forEach((m) => { m.gameSecondsRemaining = "0"; m.team[0].score = "21"; m.team[1].score = "14"; });
  const scores = clone(FX4.scores); scores["11"] = [{ id: "1", score: "0" }, { id: ID.purdy, score: "28.44" }];
  const allFinal = LM(); Object.keys(allFinal.matchups).forEach((c) => { allFinal.matchups[c].status = "final"; });
  const early = text(row(await perf({ schedule11: done, scores, lm: allFinal }, { live: { allFinalAt: Date.now() }, nowMs: Date.now() + 60 * 1000 }), ID.purdy));
  t.match(early, /Final · updating 28\.4/);
  const late = row(await perf({ schedule11: done, scores, lm: allFinal }, { live: { allFinalAt: Date.now() }, nowMs: Date.now() + 31 * 60 * 1000 }), ID.purdy);
  t.match(text(late), /Final · not yet in season totals/); t.match(late, /data-act="retryperf"/);
  const caught = LM(); Object.keys(caught.matchups).forEach((c) => { caught.matchups[c].status = "final"; }); caught.season.lastCompleteWeek = 11;
  // R6: the scores have caught up but the team history still runs through Week 10, so everything stays at Week 10 (one shared week)
  const held = await perf({ schedule11: done, scores, lm: caught }); t.match(text(held), /Through Week 10/); t.doesNotMatch(text(held), /Through Week 11/); t.match(text(card(held, ID.purdy)), /Tot\. Pts\.\s+270\.0/);
  caught.teamHistoryThrough = 11;   // the history catches up
  const html = await perf({ schedule11: done, scores, lm: caught }); t.match(text(html), /Through Week 11/); t.doesNotMatch(text(row(html, ID.purdy)), /Final · /, "the temporary display is gone in the same render");
  t.match(text(card(html, ID.purdy)), /Tot\. Pts\.\s+298\.4/);
});

test("the profile game log runs through the cutoff, never the Worker's latestFinalWeek", async () => {
  const I = await intel(), S = state({ intel: I, sub: "contracts", profile: { pid: ID.purdy, tab: "perf", all: true }, bd: { v: {}, g: {}, t: { [ID.purdy]: "log" } } });
  // R6: the log is the Breakdown: the settled weeks run 10 to 1; a newer Week 11 may show, marked newer and outside the season line
  const html = V.app(S), log = (html.split('<table class="bdt">')[1] || "").split("</table>")[0];
  const rows = [...log.matchAll(/<tr( class="[^"]*")?><th class="pin">(?:<button data-act="bdg" data-v|<span class="pinx" data-week)="(\d+)"/g)].map((m) => [+m[2], /newer/.test(m[1] || "")]);
  t.deepEqual(rows.filter((r) => !r[1]).map((r) => r[0]), [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]); t.ok(rows.filter((r) => r[1]).every((r) => r[0] > 10), "only a week after the cutoff is newer");
  t.match(text(html), /Through Week 10 ·/); t.doesNotMatch(text(html), /Through Week 11/);
});

// ---- fixes from the independent code review of 62bc56bd
const K = require(path.join(SRC, "lib/ranks.js"));
const okAns = (b) => ({ ok: true, status: 200, text: async () => JSON.stringify(b) });

test("PR B review: Retry is never drawn inside the row's own button (a button cannot sit inside a button)", async () => {
  const done = clone(FX4.schedule11); done.nflSchedule.matchup.forEach((m) => { m.gameSecondsRemaining = "0"; m.team[0].score = "21"; m.team[1].score = "14"; });
  const scores = clone(FX4.scores); scores["11"] = [{ id: "1", score: "0" }, { id: ID.purdy, score: "28.44" }];
  const allFinal = LM(); Object.keys(allFinal.matchups).forEach((c) => { allFinal.matchups[c].status = "final"; });
  const html = await perf({ schedule11: done, scores, lm: allFinal }, { live: { allFinalAt: Date.now() }, nowMs: Date.now() + 31 * 60 * 1000 });
  const r = row(html, ID.purdy);
  t.equal(nested(html), 0, "no button inside a button anywhere on the screen"); t.match(text(r), /Final · not yet in season totals/);
  t.match(r, /data-act="retryperf"/, "Retry is still there, in the card");
});

test("PR B review: a schedule answer for another week, or with a missing team, is an error, never a read left loading", async () => {
  t.equal(X.parseSchedule({ nflSchedule: { week: "10", matchup: [] } }, 11), null, "an answer for Week 10 is not Week 11's schedule");
  t.ok(Array.isArray(X.parseSchedule({ nflSchedule: { week: "11", matchup: [] } }, 11)));
  t.ok(Array.isArray(X.parseSchedule({ nflSchedule: { matchup: [] } }, 11)), "no week field: nothing to contradict");
  t.equal(X.parseSchedule({ nflSchedule: { matchup: [{ team: [null, { id: "A" }] }] } }), null, "a null team does not throw");
  t.equal(X.parseSchedule({ nflSchedule: { matchup: [{ team: [{ id: "A" }, "x"] }] } }), null);
  const L1 = D.createLoader(CFG, async () => okAns({ nflSchedule: { week: "10", matchup: [] } })); t.equal((await L1.loadSchedule(11, X.parseSchedule)).state, "error");
  const L2 = D.createLoader(CFG, async () => okAns({ nflSchedule: { matchup: [] } })); t.equal((await L2.loadSchedule(12, () => { throw new Error("boom"); })).state, "error", "a parser that throws is an error, not a promise that never settles");
});

test("PR B review: a club with no Worker status is not a final game", async () => {
  const games = X.parseSchedule(Object.assign({}, { nflSchedule: { matchup: clone(FX4.schedule11.nflSchedule.matchup).map((m) => Object.assign(m, { gameSecondsRemaining: "0" })) } }));
  games.forEach((g) => { g.final = true; });
  const all = {}; games.forEach((g) => { all[g.clubs[0]] = "final"; all[g.clubs[1]] = "final"; });
  t.equal(X.weekComplete(games, all), true, "every club has a final status");
  const missing = Object.assign({}, all); delete missing[games[0].clubs[0]];
  t.equal(X.weekComplete(games, missing), false, "one club has no status: no agreement, no final");
  t.equal(X.weekComplete(games, null), true, "a past week is judged by the schedule alone");
  const club = (id) => state().model.byId[id].nflTeam.toUpperCase();
  const s11 = clone(FX4.schedule11); s11.nflSchedule.matchup.forEach((m) => { if (m.team.some((x) => x.id.toUpperCase() === club(ID.purdy))) { m.gameSecondsRemaining = "0"; m.team[0].score = "24"; m.team[1].score = "17"; } });
  const scores = clone(FX4.scores); scores["11"] = [{ id: "1", score: "0" }, { id: ID.purdy, score: "28.44" }];
  const lm = LM(); Object.keys(lm.matchups).forEach((c) => { if (c.toUpperCase() === club(ID.purdy)) delete lm.matchups[c]; });
  t.doesNotMatch(text(row(await perf({ schedule11: s11, scores, lm }), ID.purdy)), /Final/, "no 'Final' chip without the Worker's status for his club");
});

test("PR B review (revised): ranks are compact text only: a range is the whole indication that a rank is uncertain, and no sentence about how it is bounded is built anywhere", () => {
  // revised: this test used to check the long 'Best 2, worst 3 ... 2 QBs are placed' sentences, which now live (shortened) in Help
  const g = (id) => ({ a: "QB", b: "QB" }[id] || ""), sf = K.seasonFrom({ 1: { a: 10, b: 20, z: 50 } }, 1, g), r = K.totalRank(sf.entries, "a", sf.unplaced);
  t.equal(K.rankText(r), "QB 2–3 of 2–3", "an unplaced scorer above him makes it a range"); t.equal(r.exact, false);
  const ex = K.totalRank(K.seasonFrom({ 1: { a: 10, b: 20 } }, 1, g).entries, "b", []); t.equal(K.rankText(ex), "QB 1 of 2"); t.equal(ex.exact, true);
  const pg = K.perGameRank([{ id: "me", group: "WR", total: 1000, n: 5, status: "eligible" }, { id: "up", group: "WR", total: 1300, n: 5, status: "unsettled" }], "me");
  t.equal(K.rankText(pg), "WR 1–2 of 1–2"); t.equal(pg.exact, false); t.equal(K.rankDetail, undefined);
});

test("PR B review: the rank memo follows a refreshed score read (same weeks, newer data)", async () => {
  const I = await intel(), S1 = state({ intel: I });
  t.match(text(row(body(V.app(S1)), ID.purdy)), /Tot\. Pts\.\s+270\.0/);
  const w10 = I.scores[10], scores10 = Object.assign({}, w10.data.scores); scores10[ID.purdy] = scores10[ID.purdy] + 10;
  I.scores[10] = Object.assign({}, w10, { data: Object.assign({}, w10.data, { scores: scores10 }), at: w10.at + 1 });
  t.match(text(row(body(V.app(S1)), ID.purdy)), /Tot\. Pts\.\s+280\.0/, "the refreshed Week 10 score is in the totals, not the memo's old answer");
});

// ---- unplaceable competitors, unreadable scores, truncated schedules
const CHm = require(path.join(SRC, "lib/clubhist.js"));
const E = (id, group, total, n, status, usable) => ({ id, group, total, n, status, usable });

test("per-game rank: competitors with no known position widen the bounds like the season rank; each counts once; no position is assigned; the rest is untouched", () => {
  const base = [E("me", "QB", 3000, 10, "eligible"), E("a", "QB", 4000, 10, "eligible"), E("u1", "QB", 1000, 10, "unsettled")];
  const r0 = K.perGameRank(base, "me"); t.deepEqual([r0.best, r0.worst, r0.poolLo, r0.poolHi, r0.exact], [2, 2, 2, 3, true]); t.equal(r0.unplacedN, 0);
  const hi = K.perGameRank(base, "me", [{ id: "z", total: 5000, n: 10, usable: true }]); t.deepEqual([hi.best, hi.worst, hi.poolLo, hi.poolHi, hi.exact, hi.unplacedN], [2, 3, 2, 4, false, 1], "could be ahead and could be in the pool");
  const lo = K.perGameRank(base, "me", [{ id: "z", total: 100, n: 10, usable: true }]); t.deepEqual([lo.best, lo.worst, lo.poolHi, lo.exact], [2, 2, 4, true], "below him: only the pool's upper bound grows");
  const bad = K.perGameRank(base, "me", [{ id: "z", total: 0, n: 0, usable: false }]); t.deepEqual([bad.worst, bad.poolHi], [3, 4], "an unreadable score has no figure: he could be ahead");
  t.deepEqual([K.perGameRank(base, "me", [{ id: "z", total: 0, n: 0, usable: true }]).poolHi], [3], "a readable figure with no scores is not a competitor");
  const dup = K.perGameRank(base, "me", [{ id: "z", total: 5000, n: 10, usable: true }, { id: "z", total: 5000, n: 10, usable: true }, { id: "a", total: 9000, n: 10, usable: true }, { id: "u1", total: 9000, n: 10, usable: true }, { id: "me", total: 9999, n: 10, usable: true }]);
  t.deepEqual([dup.worst, dup.poolHi, dup.unplacedN], [3, 4, 1], "the same id twice, and ids already in the pool, are never counted again");
  const grp = K.perGameRank(base, "me", [{ id: "q", group: "RB", total: 9999, n: 5, usable: true }, { id: "r", group: "QB", total: 9999, n: 5, usable: true }]);
  t.deepEqual([grp.worst, grp.poolHi, grp.unplacedN], [3, 4, 1], "a competitor whose position is known counts only in his own group; none is given a position"); t.equal(grp.group, "QB");
  t.equal(hi.unknownPosN, 1, "one player with no known position is in the bounds (counted once)");
});

const withScores = (add) => { const sc = clone(FX4.scores); Object.keys(sc).forEach((w) => { if (Number(w) <= 10) sc[w] = sc[w].concat([add(Number(w))]); }); return sc; };
test("on screen: an unplaceable scorer (not in the players read) widens the per-game and season ranks wherever he could matter, once; a low one only grows the pool", async () => {
  const open = { pf: { s: "pos", open: { [ID.purdy]: true, [ID.shaheed]: true }, res: {} } };
  const hi = await perf({ scores: withScores(() => ({ id: "99999", score: "40" })) }, open), p = text(card(hi, ID.purdy)), s = text(card(hi, ID.shaheed));
  t.match(p, /Tot\. Pts\.\s+270\.0\s+QB3–4/); t.match(p, /Actual PPG\s+30\.0\s+QB2–3/);
  t.match(text(row(hi, ID.purdy)), /Tot\. Pts\. rank QB3–4 A range: 1 player [^.]*\. QB group: 73–74 players\./); t.match(text(row(hi, ID.purdy)), /Actual PPG rank QB2–3 A range: 1 player [^.]*\. QB group: 35–55 players\./, "one unplaceable scorer adds one to the group, not ten (Breakdown reasoning)");
  t.match(s, /Tot\. Pts\.\s+66\.7\s+WR66–67/); t.match(s, /Actual PPG\s+8\.3\s+WR63–67/, "he could be a WR too");
  const loH = await perf({ scores: withScores(() => ({ id: "99999", score: "1" })) }, open), lo = text(card(loH, ID.purdy));
  t.match(lo, /Tot\. Pts\.\s+270\.0\s+QB3(?!–)/); t.match(lo, /Actual PPG\s+30\.0\s+QB2(?!–)/); t.doesNotMatch(text(row(loH, ID.purdy)), /Actual PPG rank|A range/, "below him: the rank stays exact, so the Breakdown repeats nothing (R8)"); t.doesNotMatch(text(row(loH, ID.purdy)), / of 35/);
  t.match(text(card(await perf(), ID.purdy)), /Actual PPG\s+30\.0\s+QB2(?!–)/, "with no such scorer nothing changes");
});

test("unreadable scores: kept as text by the loader, shown as unverified (figures and ranks withheld, a note, a '?' cell), never silently dropped; other positions are unaffected", async () => {
  const L = D.createLoader(CFG, async () => okAns({ playerScores: { playerScore: [{ id: "1", score: "N/A" }, { id: "2", score: "" }, { id: "3", score: "7.5" }, { id: "4", score: "-" }] } })), r = await L.loadScores(3);
  t.equal(r.data.scores["1"], "N/A"); t.equal(r.data.scores["2"], undefined, "a blank is no score"); t.equal(r.data.scores["3"], 7.5); t.equal(r.data.scores["4"], "-");
  const sc = clone(FX4.scores); sc["3"] = sc["3"].map((x) => (x.id === ID.purdy ? { id: x.id, score: "N/A" } : x));
  const html = await perf({ scores: sc }), p = text(card(html, ID.purdy));
  t.match(p, /Tot\. Pts\.\s+—\s+—/); t.match(p, /Actual PPG\s+—\s+—/); t.match(p, /1 score could not be read, so his season figures are not shown\./); t.doesNotMatch(p, /QB\d/, "no season or per-game rank");
  t.match(text(card(html, ID.shaheed)), /WR66\b/, "his position is known: another position's rank is not widened by him");
  const I = await intel({ scores: sc }), S2 = state({ intel: I, sub: "contracts", profile: { pid: ID.purdy, tab: "perf", all: true }, bd: { v: {}, g: {}, t: { [ID.purdy]: "log" } } });
  t.match((V.app(S2).split('data-act="bdg" data-v="3"')[1] || "").split("</tr>")[0], /<td class="n"><span class="mu" title="This score could not be read">\?<\/span><\/td>/, "the game log says the score could not be read, not a dash");
});

const coverOf = (w) => { const S0 = state(), byeP = [], clubs = {}; S0.model.teams.forEach((tm) => tm.players.forEach((p) => { const c = String(p.nflTeam || "").trim().toUpperCase(); if (c && c !== "FA") clubs[c] = 1; byeP.push({ club: p.nflTeam, bye: p.bye }); })); return { clubs: Object.keys(clubs), byeOf: CHm.clubByeMap(byeP), week: w }; };
test("schedule coverage: every known club plays or is on its bye; a truncated, repeated or contradictory schedule is not a complete week", () => {
  const g10 = X.parseSchedule(FX4.schedule10, 10), c10 = coverOf(10);
  t.equal(c10.clubs.length, 32); t.equal(X.coverage(g10, c10).state, "ok", "the recorded Week 10 accounts for all 32 clubs (28 play, 4 are on their bye)"); t.equal(X.weekComplete(g10, null, c10), true);
  const cut = g10.slice(1), cv = X.coverage(cut, c10);
  t.equal(cv.state, "truncated"); t.deepEqual(cv.truncated.slice().sort(), g10[0].clubs.slice().sort(), "the two clubs of the missing game"); t.equal(X.weekComplete(cut, null, c10), false);
  t.equal(X.coverage(g10.concat([g10[0]]), c10).state, "inconsistent", "a club twice");
  const playing = Object.assign({}, c10.byeOf); playing[g10[0].clubs[0]] = 10; t.equal(X.coverage(g10, Object.assign({}, c10, { byeOf: playing })).state, "inconsistent", "a club playing in its own bye week");
  const missing = c10.clubs.filter((c) => !g10.some((g) => g.clubs.indexOf(c) >= 0))[0], nobye = Object.assign({}, c10.byeOf); delete nobye[missing];
  t.equal(X.coverage(g10, Object.assign({}, c10, { byeOf: nobye })).state, "unverified", "a missing club with no known bye cannot be told from a bye");
  t.equal(X.coverage(g10, null).state, "ok", "no club list: nothing can be asserted");
  // the cutoff: a truncated lastCompleteWeek is not complete; only the last two weeks are ever asked for
  t.deepEqual(X.cutoffWeek(10, { 10: g10 }, null, 11, c10), { state: "ok", week: 10 }, "Week 9 is never asked for when Week 10 is complete");
  const u = X.cutoffWeek(10, { 10: cut }, null, 11, c10); t.deepEqual([u.state, u.need], ["unavailable", 9]);
  const c = X.cutoffWeek(10, { 10: cut, 9: [] }, null, 11, c10); t.deepEqual([c.state, c.why, c.week], ["conflict", "schedule_truncated", 10], "both checked weeks fail: nothing is drawn, and the reason is the missing games");
});

// ---- round 4: the authoritative calendar, every week verified, position reliability, unreadable-score details, stale live scores
const calFull = (edit) => { const c = clone(CAL.full); if (edit) edit(c.fullNflSchedule.nflSchedule); return c; };
const wkOf = (l, w) => l.find((e) => String(e.week) === String(w));

test("calendar: MFL's own list of all 32 clubs and the whole season's schedule: every regular-season week accounts for every club; Weeks 1 to 10 are verified complete", () => {
  const cal = X.parseCalendar(CAL.byes, CAL.full);
  t.equal(cal.clubs.length, 32); t.equal(Object.keys(cal.byeOf).length, 32);
  for (let w = 1; w <= 18; w++) t.equal(X.coverage(cal.weeks[w], { clubs: cal.clubs, byeOf: cal.byeOf, week: w }).state, "ok", "Week " + w + " plays or byes all 32 clubs");
  t.deepEqual(X.verifyWeeks(cal, 10), [], "Weeks 1 to 10 are complete"); t.deepEqual(X.verifyWeeks(cal, 11).map((p) => [p.week, p.state]), [[11, "not_final"]], "Week 11 is under way");
  t.equal(X.parseCalendar({ nflByeWeeks: { team: [] } }, CAL.full), null); t.equal(X.parseCalendar(CAL.byes, { fullNflSchedule: {} }), null); t.equal(X.parseCalendar(null, null), null);
  const dupBye = clone(CAL.byes); dupBye.nflByeWeeks.team.push(dupBye.nflByeWeeks.team[0]); t.equal(X.parseCalendar(dupBye, CAL.full), null, "a club listed twice is not a club list");
});

test("older incomplete games: an unfinished game, a truncated week, an unreadable week and a failed calendar each put a warning under 'Through Week 10' and say why; a clean calendar says nothing more", async () => {
  const warn = /not final|not confirmed complete|could not be read|unverified|does not account/;
  const clean = await perf(); t.doesNotMatch(text(clean), warn); t.match(clean, /<div class="card pfh"><b>Through Week 10<\/b>/, "no warning style");
  const nfH = await perf({ calFull: calFull((l) => { wkOf(l, 5).matchup[0].gameSecondsRemaining = "900"; }) }), nf = text(nfH);
  t.match(nf, /Through Week 10/); t.match(nfH, /class="card pfh warnc"/); t.match(nf, /Week 5 has a game that is not final \(\w+ and \w+\)\. Figures include what MFL has recorded and may change when it is played/);
  const cancelled = text(await perf({ calFull: calFull((l) => { const g = wkOf(l, 7).matchup[1]; g.gameSecondsRemaining = "3600"; g.team.forEach((x) => { x.score = ""; }); }) })); t.match(cancelled, /Week 7 has a game that is not final/, "a postponed or cancelled game is not final");
  const tr = text(await perf({ calFull: calFull((l) => { wkOf(l, 3).matchup.shift(); }) })); t.match(tr, /Week 3's NFL schedule does not account for every club/);
  const gone = text(await perf({ calFull: calFull((l) => { wkOf(l, 4).matchup = []; }) })); t.match(gone, /Week 4's NFL schedule could not be read/);
  const many = text(await perf({ calFull: calFull((l) => { [2, 3, 4, 5, 6].forEach((w) => { wkOf(l, w).matchup[0].gameSecondsRemaining = "60"; }); }) })); t.match(many, /Week 2 has a game/); t.match(many, /Week 4 has a game/); t.match(many, /2 more weeks are not confirmed complete/);
  const f = text(await perf({ failCal: true })); t.match(f, /Game completion unverified/); t.match(f, /could not be read, so weeks 1 to 9 were not checked against them/);
  const I = await intel(); delete I.cal; t.match(text(body(V.app(state({ intel: I })))), /Game completion unverified/, "no calendar read: not claimed verified");
  const I2 = await intel(); I2.cal = { state: "loading" }; const h2 = text(body(V.app(state({ intel: I2 })))); t.match(h2, /Checking which games are final/, "while the calendar is read nothing is drawn");
});

test("authoritative coverage: a missing game between two clubs that no roster has is detected; the roster-derived list could not see it", () => {
  const cal = X.parseCalendar(CAL.byes, CAL.full), clubs = cal.clubs.concat(["ZZA", "ZZB"]), byeOf = Object.assign({}, cal.byeOf, { ZZA: 18, ZZB: 18 });
  const cv = X.coverage(cal.weeks[10], { clubs, byeOf, week: 10 }); t.equal(cv.state, "truncated"); t.deepEqual(cv.truncated.slice().sort(), ["ZZA", "ZZB"]);
  t.equal(X.weekComplete(cal.weeks[10], null, { clubs, byeOf, week: 10 }), false);
  t.equal(X.coverage(cal.weeks[10], coverOf(10)).state, "ok", "the roster-derived list says ok: the gap the authoritative list closes");
  const S0 = state({ intel: { cal: { state: "ok", data: cal } } }), c = TV.coverFor(S0, 10); t.equal(c.authoritative, true); t.equal(c.clubs.length, 32);
  t.equal(TV.coverFor(state({ intel: {} }), 10).authoritative, false, "without the calendar the weaker roster-derived list is used, and the claim is withheld");
});

test("lineup week: a club the Worker lists that is in no scheduled game means a game is missing, so the week is not complete", async () => {
  const g11 = X.parseSchedule(FX4.schedule11, 11); g11.forEach((g) => { g.final = true; g.secondsRemaining = 0; g.scored = true; });
  const st = {}; g11.forEach((g) => { st[g.clubs[0]] = "final"; st[g.clubs[1]] = "final"; });
  t.equal(X.weekComplete(g11, st), true);
  t.equal(X.weekComplete(g11.slice(1), st), false, "the Worker lists the clubs of a game that the schedule does not have");
});

test("a week's scores read before the schedule that shows it final are not used for a completed-games figure until they are read again", async () => {
  const done = clone(FX4.schedule11); done.nflSchedule.matchup.forEach((m) => { m.gameSecondsRemaining = "0"; m.team[0].score = "21"; m.team[1].score = "14"; });
  const scores = clone(FX4.scores); scores["11"] = [{ id: "1", score: "0" }, { id: ID.purdy, score: "28.44" }];
  const caught = LM(); Object.keys(caught.matchups).forEach((c) => { caught.matchups[c].status = "final"; }); caught.season.lastCompleteWeek = 11; caught.teamHistoryThrough = 11;
  const I = await intel({ schedule11: done, scores, lm: caught }), S1 = state({ intel: I });
  t.match(text(row(body(V.app(S1)), ID.purdy)), /Tot\. Pts\.\s+298\.4/, "read after the schedule: used");
  t.equal(TV.staleScores(S1, 11), false);
  I.scores[11] = Object.assign({}, I.scores[11], { at: I.sched[11].at - 5 }); t.equal(TV.staleScores(S1, 11), true);
  const stale = text(row(body(V.app(S1)), ID.purdy)); t.match(stale, /Tot\. Pts\.\s+—/, "read before it: no figure is drawn from it"); t.doesNotMatch(stale, /298\.4/);
  I.scores[11] = Object.assign({}, I.scores[11], { at: I.sched[11].at + 5 }); t.match(text(row(body(V.app(S1)), ID.purdy)), /Tot\. Pts\.\s+298\.4/);
});

test("position reliability: a scorer whose players-read position disagrees with his roster position is unplaced: no rank for him, wider ranks for every group, and a reason on his row", async () => {
  const pl = FX4.players.map((p) => (p.id === ID.purdy ? Object.assign({}, p, { position: "WR" }) : p));
  const html = await perf({ players: pl }), p = text(card(html, ID.purdy)), s = text(card(html, ID.shaheed));
  t.match(p, /Tot\. Pts\.\s+270\.0\s+—/); t.match(p, /Actual PPG\s+30\.0\s+—/); t.doesNotMatch(p, /QB\d|WR\d/);
  t.match(html, /aria-label="Tot\. Pts\. rank not available"/, "the dash is labeled for assistive technology");
  t.match(s, /Tot\. Pts\.\s+66\.7\s+WR66–67/, "he could be in any group, so every group widens"); t.match(s, /Actual PPG\s+8\.3\s+WR63–67/);
  t.match(text(card(await perf(), ID.purdy)), /Tot\. Pts\.\s+270\.0\s+QB3\b/, "with agreeing positions nothing changes");
  const I = await intel(), S1 = state({ intel: I }), RD = TV.rankData(S1, TV.perfInput(S1, S1.model.byId ? Object.keys(S1.model.byId) : []));
  const conflicts = []; S1.model.teams.forEach((tm) => tm.players.forEach((q) => { if (RD.sf.totals[q.id] && !RD.groupOf(q.id)) conflicts.push(q.id); })); t.deepEqual(conflicts, [], "on the recorded data every rostered scorer's position agrees between the two sources");
});

test("unreadable scores: one definition (anything but a plain decimal with at most two places), flagged in a newer week too, Range withheld, and the note does not depend on the rank reads", async () => {
  const L = D.createLoader(CFG, async () => okAns({ playerScores: { playerScore: [{ id: "a", score: "12.345" }, { id: "b", score: true }, { id: "c", score: "0x10" }, { id: "d", score: "1e3" }, { id: "e", score: [] }, { id: "f", score: "7.50" }, { id: "g", score: 7.5 }, { id: "h", score: "-0.5" }, { id: "i", score: "" }, { id: "j", score: null }, { id: "k", score: 3 }, { id: "k", score: "N/A" }, { id: "k", score: 4 }] } })), r = await L.loadScores(3);
  ["a", "b", "c", "d", "e"].forEach((k) => t.equal(typeof r.data.scores[k], "string", k + " is kept as text, never a number")); t.equal(r.data.scores.f, 7.5); t.equal(r.data.scores.g, 7.5); t.equal(r.data.scores.h, -0.5);
  t.equal(r.data.scores.i, undefined, "blank: no score"); t.equal(r.data.scores.j, undefined, "null: no score"); t.equal(r.data.scores.k, "N/A", "an id listed twice stays unreadable if either row is");
  const sc = clone(FX4.scores); sc["3"] = sc["3"].map((x) => (x.id === ID.purdy ? { id: x.id, score: "12.345" } : x));
  const html = await perf({ scores: sc }), p = row(html, ID.purdy), tx = text(p);
  t.match(tx, /Tot\. Pts\.\s+—\s+—/); t.match(tx, /1 score could not be read, so his season figures are not shown/);
  const scR = clone(FX4.scores); scR["10"] = scR["10"].map((x) => (x.id === ID.purdy ? { id: x.id, score: "N/A" } : x));
  const open = text(row(await perf({ scores: scR }, { pf: { s: "pos", open: { [ID.purdy]: true }, res: {} } }), ID.purdy)); t.match(open, /Actual PPG\s+—\s+—/); t.doesNotMatch(open, /QB \d+ of/, "no rank in the opened Breakdown either");
  // the note and the dashes come from the score reads themselves, so they show even when the players read failed
  const noPl = text(row(await perf({ scores: sc, noPlayers: true }), ID.purdy)); t.match(noPl, /Tot\. Pts\.\s+—\s+—/); t.match(noPl, /1 score could not be read, so his season figures are not shown/);
  // R6: with history one week behind (W* = 9), an unreadable Week 10 score is outside the settled summary: Weeks 1 to 9 figures stand; Week 10 is the game log's (r6g)
  const lm = Object.assign(LM(), histAt(9)); const sc10 = clone(FX4.scores); sc10["10"] = sc10["10"].map((x) => (x.id === ID.purdy ? { id: x.id, score: "N/A" } : x));
  const h9 = await perf({ lm, scores: sc10 }); t.match(text(h9), /Through Week 9/); t.match(text(card(h9, ID.purdy)), /Tot\. Pts\.\s+\d+\.\d/); t.doesNotMatch(text(card(h9, ID.purdy)), /could not be read/);
});

test("failed calendar read: available totals stay, the screen says 'Game completion unverified' with no completed-games claim, and an unreadable score still withholds that player's figures", async () => {
  const sc = clone(FX4.scores); sc["3"] = sc["3"].map((x) => (x.id === ID.purdy ? { id: x.id, score: "12.345" } : x));
  const html = await perf({ failCal: true, scores: sc }), tx = text(html);
  t.match(tx, /Game completion unverified/); t.match(tx, /Through Week 10/);
  t.match(text(row(html, ID.purdy)), /Tot\. Pts\.\s+—\s+—/, "the unreadable score withholds his figures"); t.match(text(row(html, ID.shaheed)), /Tot\. Pts\.\s+66\.7/, "another player's available totals stay");
});

test("season and weekly pool bounds count only competitors who could be in the group: an unreadable RB widens RB ranks, not QB ranks", () => {
  const g = (id) => ({ a: "QB", b: "QB", r: "RB", z: "" }[id] || "");
  const s = K.seasonFrom({ 1: { a: 10, b: 20, r: "N/A", z: 50 } }, 1, g), ra = K.totalRank(s.entries, "a", s.unplaced);
  t.deepEqual([ra.best, ra.worst, ra.poolLo, ra.poolHi], [2, 3, 2, 3], "the RB is in no QB bound; only z (no position) is");
  const rr = K.totalRank([{ id: "r2", group: "RB", value: 100 }], "r2", s.unplaced); t.deepEqual([rr.best, rr.worst, rr.poolLo, rr.poolHi], [1, 3, 1, 3], "for an RB: the unreadable RB and z");
  const pg = K.perGameRank([E("me", "QB", 3000, 10, "eligible")], "me", [{ id: "x", group: "RB", usable: false }, { id: "y", group: "", total: 9000, n: 3, usable: true }]); t.deepEqual([pg.worst, pg.poolHi, pg.unknownPosN], [2, 2, 1]);
  t.equal(pg.unknownPosN, 1);
  const known = K.perGameRank([E("me", "QB", 3000, 10, "eligible")], "me", [{ id: "q", group: "QB", usable: false }]); t.equal(known.unknownPosN, 0, "a known position is not counted as unknown"); t.equal(known.unplacedN, 1);
});

// ---- review finding (PR B ba84145e): text the loader keeps as unreadable must stay unreadable in every total, comparison and rank
test("one definition of a readable score: whatever the loader keeps as text is never turned back into a number by the rank code", async () => {
  const raw = ["1e3", "1E3", "0x10", "0X1f", "0b11", "0o7", "1_0", "Infinity", "-Infinity", "NaN", "+5", ".5", "5.", "1,000", "12.345", "N/A", "abc", "١٢", " 1e3 ", true, false, {}, [], [5], ["5"], { a: 1 }];
  const L = D.createLoader(CFG, async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ playerScores: { playerScore: raw.map((v, i) => ({ id: "p" + i, score: v })) } }) })), r = await L.loadScores(3);
  raw.forEach((v, i) => { const kept = r.data.scores["p" + i]; if (typeof kept === "string") t.equal(K.toCents(kept), null, JSON.stringify(v) + " was kept as unreadable text, so it has no value in cents"); });
  ["p0", "p1", "p2", "p3", "p4"].forEach((k) => t.equal(typeof r.data.scores[k], "string", k + " stays text in the loader"));
  // the schedule parser uses the same definition: a game whose seconds or scores are hexadecimal or exponent text is not final
  const g = (secs, a, b) => X.parseSchedule({ nflSchedule: { matchup: [{ gameSecondsRemaining: secs, team: [{ id: "AAA", score: a }, { id: "BBB", score: b }] }] } }, null)[0];
  t.equal(g("0", "21", "14").final, true, "plain text is read"); t.equal(g("0x0", "21", "14").final, false, "hexadecimal seconds are not 0"); t.equal(g("0e0", "21", "14").final, false); t.equal(g("0", "0x15", "14").final, false, "hexadecimal score is not a score"); t.equal(g("0", "1e1", "14").scored, false); t.equal(g(0, 21, 14).final, true);
  t.equal(K.toCents("1e3"), null); t.equal(K.toCents("0x10"), null); t.equal(K.toCents([5]), null); t.equal(K.toCents({}), null); t.equal(K.toCents(true), null); t.equal(K.toCents(" 12 "), 1200); t.equal(K.toCents("7.50"), 750); t.equal(K.toCents("-0.5"), -50); t.equal(K.toCents(7.5), 750); t.equal(K.toCents("12.345"), null); t.equal(K.toCents(""), null); t.equal(K.toCents(null), null);
});

test("exponent and hexadecimal score text end to end: the player's totals, per-game figure and ranks are withheld everywhere, and his competitors' rank bounds widen (he could be ahead)", async () => {
  const mine = []; for (let w = 1; w <= 10; w++) { const x = FX4.scores[String(w)].find((y) => y.id === ID.purdy); if (x) mine.push({ w, v: Number(x.score) }); }
  const sum = mine.reduce((a, b) => a + b.v, 0), w3 = mine.find((x) => x.w === 3).v;
  for (const bad of ["1e3", "0x10"]) {
    const sc = clone(FX4.scores); sc["3"] = sc["3"].map((x) => (x.id === ID.purdy ? { id: x.id, score: bad } : x));
    const html = await perf({ scores: sc }, { pf: { f: "all", s: "pos", open: { [ID.purdy]: true }, res: {} } }), tx = text(html), p = text(row(html, ID.purdy));
    const total = sum - w3 + (bad === "1e3" ? 1000 : 16), perGame = total / mine.length;
    [total, perGame].forEach((n) => { const a = n.toFixed(1), b = n.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }); t.ok(!p.includes(a) && !p.includes(b), bad + ": the value " + a + " is not shown in his row"); if (bad === "1e3") t.ok(!tx.includes(a) && !tx.includes(b), bad + ": the value " + a + " appears nowhere on the screen"); });
    t.match(p, /Tot\. Pts\.\s+—\s+—/, bad + ": season points withheld"); t.match(p, /Actual PPG\s+—\s+—/, bad + ": per-game withheld"); t.match(p, /1 score could not be read/);
    // R6 integration: the opened Breakdown now holds the weekly game log, whose exact weekly rank of a week with a readable score is a different fact and stays
    t.doesNotMatch(text(row(html, ID.purdy).split('<div class="bdx"')[0]), /QB ?\d+(–\d+)?/, bad + ": no season or per-game rank for him");
    t.doesNotMatch(text(row(html, ID.purdy)), /QB ?\d+ of|QB ?\d+–\d+/, bad + ": no season or per-game rank (with a pool or a range) anywhere in his card or Breakdown");
  }
  // his competitors: he is an unplaced competitor who could be ahead of every QB (not a definite 1,227-point season, and not ignored)
  const sc = clone(FX4.scores); sc["3"] = sc["3"].map((x) => (x.id === ID.purdy ? { id: x.id, score: "1e3" } : x));
  const I = await intel({ scores: sc }), S1 = state({ intel: I }), RD = TV.rankData(S1, TV.perfInput(S1, Object.keys(S1.model.byId || {})));
  t.equal(RD.sf.invalid[ID.purdy], true, "invalid in the season model"); t.ok(RD.sf.unplaced.some((u) => u.id === ID.purdy && u.value === null), "an unplaced competitor with no usable value"); t.equal(RD.sf.entries.some((e) => e.id === ID.purdy), false, "never a placed entry");
  t.ok(RD.bad[ID.purdy] >= 1, "counted as unreadable");
  const qbs = RD.sf.entries.filter((e) => e.group === "QB").sort((a, b) => b.value - a.value), top = qbs[0], second = qbs[1];
  const without = RD.sf.unplaced.filter((u) => u.id !== ID.purdy);
  const rt = K.totalRank(RD.sf.entries, top.id, RD.sf.unplaced), clean = K.totalRank(RD.sf.entries, top.id, without);
  t.equal(rt.worst, clean.worst + 1, "the top other QB's worst case includes the unreadable QB, once"); t.equal(rt.best, clean.best, "his best case is untouched"); t.equal(rt.exact, false, "so his rank is a range, never exact");
  t.equal(rt.poolHi, clean.poolHi + 1, "the pool's upper bound counts him once");
  const r2 = K.totalRank(RD.sf.entries, second.id, RD.sf.unplaced); t.ok(r2.worst > r2.best, "a lower QB's rank widens too");
  const el = qbs.find((e) => RD.elig[e.id] && RD.elig[e.id].status === "eligible"); t.ok(el, "an eligible QB exists");
  const pg = K.perGameRank(RD.entries, el.id, RD.unplacedGame), pgNo = K.perGameRank(RD.entries.filter((e) => e.id !== ID.purdy), el.id, RD.unplacedGame.filter((u) => u.id !== ID.purdy));
  t.equal(pg.worst, pgNo.worst + 1, "per-game: he is counted once toward the worst case"); t.equal(pg.poolHi, pgNo.poolHi + 1, "and once toward the pool, though he is in both the entries and the unplaced list");
  const wr = RD.sf.entries.filter((e) => e.group === "WR")[0], rw = K.totalRank(RD.sf.entries, wr.id, RD.sf.unplaced), rwClean = K.totalRank(RD.sf.entries, wr.id, without);
  t.deepEqual([rw.best, rw.worst, rw.poolHi], [rwClean.best, rwClean.worst, rwClean.poolHi], "other position groups are not affected");
});

// ============ Keith's Performance decisions (revision of PR B): no filters, compact ranks, one history notice, stacked weekly cells, name = profile ============
const CSS = fs.readFileSync(path.join(SRC, "styles.css"), "utf8");
const actives = () => state().model.teams.find((x) => x.id === "0010").players.filter((p) => p.status === "active");
const noHistLM = () => { const o = LM(); ["teamHistoryState", "teamHistoryReason", "teamHistoryThrough", "teamHistory", "teamHistoryMissing", "teamHistoryConflict", "teamHistoryFirst"].forEach((k) => delete o[k]); return o; };
const allOpen = () => ({ pf: { s: "pos", open: Object.fromEntries(actives().map((p) => [p.id, true])), res: {} } });
const count = (s, re) => (s.match(re) || []).length;
const NOTICE = /PPG ranks aren’t available yet\./g;

test("revised: no All / Starters / Bench filter; every player of the team is listed, grouped by position, each with his own starter indicator", async () => {
  const html = await perf({}, { pf: { f: "starters", s: "pos", open: {}, res: {} } });   // a leftover filter value changes nothing: the control and its handler are gone
  t.doesNotMatch(html, /data-act="pff"/); t.doesNotMatch(html, />Starters</); t.doesNotMatch(html, />All</); t.doesNotMatch(html, /class="lbl">Show</);
  t.equal(count(html, /data-act="pfx"/g), actives().length, "every active player is listed, starter or not");
  t.equal(count(html, /<div class="rw pfc">/g), actives().length, "one card each");
  t.match(text(html), /Starting/); t.match(text(html), /Bench/, "the starter indicator is per player");
  t.match(html, /class="gh2"><span>QB · /); t.match(html, /class="gh2"><span>WR · /);
  t.doesNotMatch(fs.readFileSync(path.join(SRC, "app.js"), "utf8"), /"pff"/, "the handler is gone with the control");
});

test("R6 sort: By position, Tot. Pts., Actual PPG, always the same three; a stored sort from the old screen maps to its new form", async () => {
  const sorts = (html) => [...html.matchAll(/data-act="pfs" data-v="(\w+)" aria-pressed="(\w+)"/g)].map((m) => [m[1], m[2]]);
  t.deepEqual(sorts(await perf()), [["pos", "true"], ["tot", "false"], ["ppg", "false"]]);
  t.deepEqual(sorts(await perf({ lm: noHistLM() })), [["pos", "true"], ["tot", "false"], ["ppg", "false"]], "the same with no team history (no sort needs it)");
  t.deepEqual(sorts(await perf({}, { pf: { s: "diff", open: {}, res: {} } })).map((x) => x[1]), ["true", "false", "false"], "the old Difference falls back to By position");
  t.deepEqual(sorts(await perf({}, { pf: { s: "avg", open: {}, res: {} } })).map((x) => x[1]), ["false", "false", "true"], "the old Season average is Actual PPG");
  const byPpg = await perf({}, { pf: { s: "ppg", open: {}, res: {} } }); t.equal(count(byPpg, /data-act="pfx"/g), actives().length); t.match(text(byPpg), /Actual PPG, highest first/);
  const ppgs = [...byPpg.matchAll(/<span>Actual PPG<\/span><b>([^<]*)<\/b>/g)].map((m) => (m[1] === "—" ? -1e9 : Number(m[1])));
  t.deepEqual(ppgs, ppgs.slice().sort((a, b) => b - a), "highest first");
  const byTot = await perf({}, { pf: { s: "tot", open: {}, res: {} } }), tots = [...byTot.matchAll(/<span>Tot\. Pts\.<\/span><b>([^<]*)<\/b>/g)].map((m) => (m[1] === "—" ? -1e9 : Number(m[1])));
  t.deepEqual(tots, tots.slice().sort((a, b) => b - a)); t.match(text(byTot), /Tot\. Pts\., highest first/);
});

test("R6 wording: compact ranks only on the card; no pool, no methodology, no comparison block, no footer explanations; Help carries the definitions", async () => {
  const html = await perf({}, allOpen()), tx = text(html);
  actives().forEach((p) => { const c = text(card(html, p.id)); t.doesNotMatch(c, /[A-Z]{1,2} ?\d+(–\d+)? of \d+/, p.name + ": no pool on the card"); });
  t.doesNotMatch(text(row(html, ID.purdy)), /Tot\. Pts\. rank|Actual PPG rank/, "R8: exact ranks are on the card only; the Breakdown does not repeat them");
  t.doesNotMatch(text(row(html, ID.purdy)), /QB ?\d+ of \d+/);
  t.doesNotMatch(tx, /is exact|are placed|is placed|are settled|Best \d+, worst|worst case|a bound, not|unsettled|unplaced|eligib|without a position group/i);
  t.doesNotMatch(tx, /Season points|Per scored game|Season average|Last 3 team games|Recent|Earlier|Difference|Ranges can narrow|Final games only|Comparison through|completed games/, "superseded wording is gone");
  t.equal(count(html, /class="rcn"|class="cmpl"|class="cells4"|class="stat3"/g), 0, "no comparison block, weekly strip or old stat grid on the main card");
  t.doesNotMatch(tx, /team (Actual )?PPG|Team PPG|PPG \(team\)/i, "no team-level Actual PPG summary (player PPGs are never summed)");
  const help = text(TV.screenHelp(state()));
  t.match(help, /Tot\. Pts\./); t.match(help, /Actual PPG/); t.match(help, /scored games/); t.match(help, /QB2–4/); t.match(help, /Through Week/); t.match(help, /Not Available/);
  t.doesNotMatch(help, /worker|endpoint|backend|server|\bAPI\b|PR #/i, "no backend mechanics in Help");
});

test("R6: team history not available is ONE notice at the top; every PPG rank is '—'; nothing else changes", async () => {
  const html = await perf({ lm: noHistLM() }, allOpen()), tx = text(html), top = html.split('data-act="card"')[0];
  t.equal(count(tx, NOTICE), 1, "one notice"); t.ok(text(top).match(NOTICE), "and it is at the top, before the first player");
  t.match(top, /<div class="card pfh"><b>Through Week 10<\/b>/, "Through Week N, once, in the same card");
  t.equal(count(html, /Through Week/g), 1); t.equal(count(html, /Comparison through Week/g), 0);
  actives().forEach((p) => { const c = text(card(html, p.id)); t.doesNotMatch(c, /history|Recent|Earlier/i, p.name); t.match(c, /Actual PPG\s+(\S+)\s+—/, p.name + ": PPG rank unsupported"); });
  const notice = tx.match(/PPG ranks aren’t available yet\./)[0]; t.doesNotMatch(notice, /missing|wrong|incorrect|error|problem|could not|failed|data/i, "it never says or implies that player data is missing or wrong");
  const p = text(card(html, ID.purdy));
  t.match(p, /Tot\. Pts\.\s+270\.0\s+QB3\b/); t.match(p, /Actual PPG\s+30\.0\s+—/); t.match(p, /9 scored games/);
  const f = text(await perf({ lm: noHistLM(), failCal: true })); t.match(f, /Game completion unverified/); t.equal(count(f, NOTICE), 1);
  t.equal(count(text(await perf()), NOTICE), 0, "history available: no notice");
  const mal = LM(); mal.teamHistoryThrough = 13; const mh = text(await perf({ lm: mal }, allOpen()));
  t.equal(count(mh, /Team history unavailable/g), 1, "one line naming the reason"); t.match(mh, /Team history unavailable: the answer was not in the expected form\./); t.equal(count(mh, NOTICE), 0);
});

// an independent computation of the weekly position rank, from the recorded files only (nothing from the code under test)
const GRP = { QB: "QB", RB: "RB", WR: "WR", TE: "TE", PK: "K", PN: "P", DE: "DL", DT: "DL", DL: "DL", LB: "LB", CB: "DB", S: "DB", DB: "DB" };
function weeklyRankOf(scoresByWeek, players, rosterPos, week, id, over) {
  const pos = Object.fromEntries((over || players).map((p) => [p.id, p.position])), groupOf = (x) => { const g = GRP[pos[x]]; if (!g) return ""; const rp = rosterPos[x]; return rp && GRP[rp] !== g ? "" : g; };
  const cents = (s) => (/^-?\d+(\.\d+)?$/.test(String(s).trim()) && Math.abs(Number(s) * 100 - Math.round(Number(s) * 100)) < 1e-6 ? Math.round(Number(s) * 100) : null);
  const rows = scoresByWeek[week] || [], mine = rows.find((r) => r.id === id), g = groupOf(id), me = mine ? cents(mine.score) : null;
  if (!mine || me == null || !g) return "";
  let better = 0, uncertain = 0;
  rows.forEach((r) => { if (r.id === id) return; const c = cents(r.score), gg = groupOf(r.id); if (c == null || !gg) { if (c == null || c > me) uncertain++; } else if (gg === g && c > me) better++; });
  return uncertain ? "" : g + (better + 1);   // R7: "QB4", no space, no pool
}
const rdOf = async (over) => { const I = await intel(over), S1 = state({ intel: I }); return TV.rankData(S1, TV.perfInput(S1, Object.keys(S1.model.byId))); };

test("weekly position rank (kept for the game log): equals an independent computation on the recorded weeks and is given only when exact", async () => {
  const RD = await rdOf(), rosterPos = Object.fromEntries(Object.values(state().model.byId).map((p) => [p.id, p.pos]));
  let compared = 0, ranked = 0;
  actives().forEach((p) => { for (let w = 1; w <= 10; w++) { const want = weeklyRankOf(FX4.scores, FX4.players, rosterPos, w, p.id); compared++; if (want) ranked++; t.equal(RD.weekRank(w, p.id), want, p.name + " W" + w); } });
  t.ok(compared >= 150 && ranked >= 100, "enough real weeks were compared (" + compared + ", " + ranked + " ranked)");
  t.equal(RD.weekRank(10, ID.purdy), "QB4"); t.equal(RD.weekRank(11, ID.purdy), "", "never past W*");
  const big = clone(FX4.scores); Object.keys(big).forEach((w) => { if (Number(w) <= 10) big[w] = big[w].concat([{ id: "99999", score: "199.5" }]); });
  const RB = await rdOf({ scores: big }); actives().forEach((p) => { for (let w = 1; w <= 10; w++) t.equal(RB.weekRank(w, p.id), "", "an unplaceable scorer above everyone: nothing is exact"); });
});

test("R6: the name opens the profile; a separate quiet 'Breakdown' text control (44 px) opens the breakdown in place; no button inside a button", async () => {
  const closed = await perf({}, { pf: { s: "pos", open: {}, res: {} } }), opened = await perf({}, { pf: { s: "pos", open: { [ID.purdy]: true }, res: {} } }), nm = state().model.byId[ID.purdy].name;
  const nmb = new RegExp('<button class="nmb" data-act="card" data-pid="' + ID.purdy + '" aria-label="Open ' + nm + ' profile"><span class="l1">' + nm + " ");
  const tog = (open) => new RegExp('<button class="link pfb" data-act="pfx" data-v="' + ID.purdy + '" aria-expanded="' + open + '" aria-label="' + (open ? "Hide" : "Show") + " breakdown for " + nm + '">Breakdown ' + (open ? "▾" : "▸") + "</button>");
  t.match(closed, nmb); t.match(closed, tog(false)); t.match(opened, tog(true)); t.match(opened, nmb);
  t.ok(closed.search(nmb) < closed.search(tog(false)), "the name button comes first");
  t.equal(nested(opened), 0, "no button inside a button"); t.doesNotMatch(text(row(opened, ID.purdy).split('<div class="det')[1] || ""), /Open .* profile|’s profile/, "no redundant profile link inside the Breakdown");
  t.match(row(opened, ID.purdy), /<div class="det pfbd">/, "the Breakdown opens inside the card"); t.doesNotMatch(row(closed, ID.purdy), /class="det/);
  t.doesNotMatch(closed, /class="btn[^"]*"[^>]*data-act="pfx"/, "not a large button");
  t.match(CSS, /\.nmb\{[^}]*min-height:44px/); t.match(CSS, /\.pfb\{[^}]*min-height:44px/);
  t.equal(count(closed, /<button class="nmb"/g), actives().length); t.equal(count(closed, /<a /g), 0);
});

run("mobile2027_performance_prb");
