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
const CFG = { workerBase: "https://upsmflproduction.keith-creelman.workers.dev", leagueId: "74598", season: "2026" };
const text = (html) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const clone = (x) => JSON.parse(JSON.stringify(x));
const body = (html) => html.split('id="screen"')[1].split("<nav")[0];
const LM = () => Object.assign({}, clone(FX3.lineup_matchups_w11), clone(FX4.hist));

async function intel(over) {
  over = over || {};
  const lm = over.lm || LM();
  const fake = async (url) => {
    const u = new URL(url), ty = u.searchParams.get("TYPE"), w = u.searchParams.get("W");
    if (u.pathname === "/api/lineup-matchups") return ok(Object.assign({}, lm, { week: Number(w) }));
    if (ty === "playerScores") return ok({ playerScores: { playerScore: (over.scores || FX4.scores)[w] || (w === "11" ? [{ id: "1", score: "0" }] : []) } });
    if (ty === "players") return over.noPlayers ? { ok: false, status: 502, text: async () => "x" } : ok({ players: { player: FX4.players } });
    if (ty === "nflSchedule") { if (over.failSched === w) return { ok: false, status: 502, text: async () => "x" }; return ok(w === "10" ? (over.schedule10 || FX4.schedule10) : w === "11" ? (over.schedule11 || FX4.schedule11) : { nflSchedule: { matchup: [] } }); }
    return ok({});
  };
  const ok = (b) => ({ ok: true, status: 200, text: async () => JSON.stringify(b) });
  const L = D.createLoader(CFG, fake), rec = (r) => ({ state: r.state, data: r.data, error: r.error, at: Date.now() });
  const out = { status: null, mu: { 11: rec(await L.loadMatchups(11)) }, wk: {}, scores: {}, sched: {}, players: rec(await L.loadPlayers()) };
  for (const w of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) out.scores[w] = rec(await L.loadScores(w));
  for (const w of [10, 11]) out.sched[w] = rec(await L.loadSchedule(w, X.parseSchedule));
  return out;
}
const state = (over) => ({ model: M.build(FX.roster_workbench, FX.league, FX.weekly_results, 11, 2026), load: { core: "ok", coreNotes: [] }, penalty: { state: "idle" }, ns: { state: "idle" }, teamId: "0010", tab: "team", sub: "performance", view: "lineup",
  open: {}, flags: {}, profile: null, sheet: null, skin: "system", vib: "1", build: "test", requestLog: [], gdef: "needs", wk: null, live: null, pf: { f: "all", s: "pos", open: {}, res: {} },
  requestSummary: { requests: 0, ok: 0, failed: 0, refused: 0, nonGet: 0 }, ...(over || {}) });
const perf = async (over, so) => body(V.app(state({ intel: await intel(over), ...(so || {}) })));
const row = (html, id) => (html.split('data-act="pfx" data-v="' + id + '"')[1] || "").split('<div class="rw">')[0];
const ID = { purdy: "15698", shaheed: "16080" };

test("the cutoff is Week 10: Week 11 is a Thursday with 1 of 13 games final, so it is in no figure, whatever latestFinalWeek says", async () => {
  const lm = LM(); t.equal(lm.season.latestFinalWeek, 11); t.equal(lm.season.lastCompleteWeek, 10);
  const html = await perf(); t.match(text(html), /Season through Week 10 · completed games/); t.doesNotMatch(text(html), /Season through Week 11/);
  t.match(text(html), /Comparison through Week 10/);
});

test("season production first: points, per scored game, scored games, with both ranks beside their figures (recorded Week 10)", async () => {
  const html = await perf(), p = text(row(html, ID.purdy)), s = text(row(html, ID.shaheed));
  t.match(p, /Season points\s+270\.0\s+QB 3 of 73/); t.match(p, /Per scored game\s+30\.0\s+QB 2 of 35–54/); t.match(p, /Scored games\s+9/);
  t.match(s, /Season points\s+66\.7\s+WR 66 of 240/); t.match(s, /Per scored game\s+8\.3\s+WR 63–66 of 169–209/); t.match(s, /Scored games\s+8/);
  const open = text(row(await perf({}, { pf: { f: "all", s: "pos", open: { [ID.shaheed]: true, [ID.purdy]: true }, res: {} } }), ID.shaheed));
  t.match(open, /Per-game rank WR 63–66 of 169–209\. Best 63, worst 66/); t.match(open, /The worst case is a bound, not a result/); t.match(open, /Season points rank WR 66 of 240\. 66 is exact/);
});

test("ranks and pools are never exact when unsettled players could change them; a settled exact rank shows an exact number with a pool range", async () => {
  const html = await perf(), p = text(row(html, ID.purdy));
  t.match(p, /QB 2 of 35–54/, "exact rank, uncertain pool"); t.match(text(row(html, ID.shaheed)), /WR 63–66 of 169–209/, "a range when unsettled players could rank ahead");
  t.doesNotMatch(text(html), /\d+\+/, "no 'N+' pool text: a supported range or nothing");
});

test("partial week: history through Week 11 does not move the cutoff past the last all-final week", async () => {
  const lm = LM(); lm.teamHistoryThrough = 11;
  const a = await perf({ lm }), b = await perf();
  t.match(text(a), /Comparison through Week 10/); t.match(text(a), /Season through Week 10 · completed games/);
  t.equal(text(row(a, ID.purdy)), text(row(b, ID.purdy)), "the same figures and ranks as with history through Week 10");
  const worse = LM(); worse.teamHistoryThrough = 13; t.match(text(await perf({ lm: worse })), /Team history unavailable/, "more than one week past the last all-final week is not believed");
});

test("evidence missing: no schedule means no cutoff and no season figure; a failed read says so with Retry and a disabled Report bug; nothing is guessed", async () => {
  for (const failSched of ["10"]) {
    const I = await intel({ failSched }); I.sched[10] = { state: "error", error: "x" };
    const html = body(V.app(state({ intel: I }))), tx = text(html);
    t.match(tx, /Couldn’t load this/); t.match(html, /data-act="retryperf"/); t.match(html, /<button class="btn" disabled aria-disabled="true">Report bug<\/button>/);
    t.doesNotMatch(tx, /Season points|Season through Week|QB \d|WR \d/);
  }
  const noLast = LM(); delete noLast.season.lastCompleteWeek; t.match(text(await perf({ lm: noLast })), /Couldn’t load this/, "no lastCompleteWeek in the answer: the cutoff cannot be established");
  const none = LM(); none.season.lastCompleteWeek = 0; t.match(text(await perf({ lm: none })), /No week has been completed yet/);
  const I2 = await intel(); I2.sched = {}; t.match(text(body(V.app(state({ intel: I2 })))), /Checking which games are final/, "schedule not read yet: loading, not a figure");
});

test("a week the Worker calls complete but the schedule does not: the cutoff steps back, never forward", async () => {
  const lm = LM(); lm.season.lastCompleteWeek = 11; // the Worker (wrongly) says Week 11 is complete; the schedule says 1 of 13 games is final
  const html = await perf({ lm }); t.match(text(html), /Season through Week 10 · completed games/);
});

test("team history unavailable or conflicting: season figures and season ranks stay; only the per-game rank is withheld, with its reason", async () => {
  const lm = LM(); lm.teamHistoryState = "unavailable"; lm.teamHistoryReason = "no_history"; lm.teamHistoryThrough = null; delete lm.teamHistory; delete lm.teamHistoryFirst;
  const html = await perf({ lm }), p = text(row(html, ID.purdy));
  t.match(p, /Season points\s+270\.0\s+QB 3 of 73/); t.match(p, /Team history unavailable/); t.doesNotMatch(p, /QB 2 of/);
});

test("the players read failed: season totals still show; ranks are absent, never invented", async () => {
  const html = await perf({ noPlayers: true }), p = text(row(html, ID.purdy));
  t.match(p, /Season points\s+270\.0/); t.doesNotMatch(p, /QB 3 of|QB 2 of/); t.match(text(html), /Season through Week 10/);
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
  const figures = (h) => text(h.split("</div>").slice(0, 3).join("")).replace(/Live[^A-Za-z]*\d*\.?\d*/, "");
  t.ok(figures(await chip(make("1800", "7", "3"))).includes("270.0"), "the live score is in no season figure");
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
  const html = await perf({ schedule11: done, scores, lm: caught }); t.match(text(html), /Season through Week 11 · completed games/); t.doesNotMatch(text(row(html, ID.purdy)), /Final · /, "the temporary display is gone in the same render");
});

test("the profile game log runs through the cutoff, never the Worker's latestFinalWeek", async () => {
  const I = await intel(), S = state({ intel: I, sub: "contracts", profile: { pid: ID.purdy, tab: "perf", all: true } });
  const html = V.app(S), weeks = [...(html.split('<div class="card tbl">')[1] || "").split("</table>")[0].matchAll(/<tr><td>(\d+)<\/td>/g)].map((m) => +m[1]);
  t.deepEqual(weeks, [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]); t.match(text(html), /Showing Weeks 1 to 10/);
});

// ---- fixes from the independent code review of 62bc56bd
const K = require(path.join(SRC, "lib/ranks.js"));
const okAns = (b) => ({ ok: true, status: 200, text: async () => JSON.stringify(b) });

test("PR B review: Retry is never drawn inside the row's own button (a button cannot sit inside a button)", async () => {
  const done = clone(FX4.schedule11); done.nflSchedule.matchup.forEach((m) => { m.gameSecondsRemaining = "0"; m.team[0].score = "21"; m.team[1].score = "14"; });
  const scores = clone(FX4.scores); scores["11"] = [{ id: "1", score: "0" }, { id: ID.purdy, score: "28.44" }];
  const allFinal = LM(); Object.keys(allFinal.matchups).forEach((c) => { allFinal.matchups[c].status = "final"; });
  const html = await perf({ schedule11: done, scores, lm: allFinal }, { live: { allFinalAt: Date.now() }, nowMs: Date.now() + 31 * 60 * 1000 });
  const afterMarker = html.split('data-act="pfx" data-v="' + ID.purdy + '"')[1], rowButton = afterMarker.split("</button>")[0];
  t.doesNotMatch(rowButton, /<button/, "no button inside the row's button"); t.match(text(rowButton), /Final · not yet in season totals/);
  t.match(afterMarker.split('<div class="rw">')[0], /data-act="retryperf"/, "Retry is still there, next to the row");
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

test("PR B review: the season-points rank never talks about eligibility; the per-game rank still does", () => {
  const g = (id) => ({ a: "QB", b: "QB" }[id] || ""), sf = K.seasonFrom({ 1: { a: 10, b: 20, z: 50 } }, 1, g), r = K.totalRank(sf.entries, "a", sf.unplaced);
  const d = K.rankDetail(r, "season"); t.doesNotMatch(d, /eligib|unsettled|settled/i); t.match(d, /Best 2, worst 3/); t.match(d, /1 placed QB is ahead/); t.match(d, /without a position group or with an unreadable score/); t.match(d, /The worst case is a bound, not a result/);
  const ex = K.rankDetail(K.totalRank(K.seasonFrom({ 1: { a: 10, b: 20 } }, 1, g).entries, "b", []), "season"); t.equal(ex, "1 is exact. 2 QBs are placed.");
  const pg = K.perGameRank([{ id: "me", group: "WR", total: 1000, n: 5, status: "eligible" }, { id: "up", group: "WR", total: 1300, n: 5, status: "unsettled" }], "me");
  t.match(K.rankDetail(pg), /with unsettled eligibility could also be/); t.match(K.rankDetail(pg), /1 settled WR is|0 settled WRs are/);
});

test("PR B review: the rank memo follows a refreshed score read (same weeks, newer data)", async () => {
  const I = await intel(), S1 = state({ intel: I });
  t.match(text(row(body(V.app(S1)), ID.purdy)), /Season points\s+270\.0/);
  const w10 = I.scores[10], scores10 = Object.assign({}, w10.data.scores); scores10[ID.purdy] = scores10[ID.purdy] + 10;
  I.scores[10] = Object.assign({}, w10, { data: Object.assign({}, w10.data, { scores: scores10 }), at: w10.at + 1 });
  t.match(text(row(body(V.app(S1)), ID.purdy)), /Season points\s+280\.0/, "the refreshed Week 10 score is in the totals, not the memo's old answer");
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
  t.match(K.rankDetail(hi), /1 player with no known position is included in the bounds\./);
});

const withScores = (add) => { const sc = clone(FX4.scores); Object.keys(sc).forEach((w) => { if (Number(w) <= 10) sc[w] = sc[w].concat([add(Number(w))]); }); return sc; };
test("on screen: an unplaceable scorer (not in the players read) widens the per-game and season ranks wherever he could matter, once; a low one only grows the pool", async () => {
  const hi = await perf({ scores: withScores(() => ({ id: "99999", score: "40" })) }), p = text(row(hi, ID.purdy)), s = text(row(hi, ID.shaheed));
  t.match(p, /Season points\s+270\.0\s+QB 3–4 of 73–74/); t.match(p, /Per scored game\s+30\.0\s+QB 2–3 of 35–55/, "one unplaceable scorer adds one to the pool, not ten");
  t.match(s, /Season points\s+66\.7\s+WR 66–67 of 240–241/); t.match(s, /Per scored game\s+8\.3\s+WR 63–67 of 169–210/, "he could be a WR too");
  const lo = text(row(await perf({ scores: withScores(() => ({ id: "99999", score: "1" })) }), ID.purdy));
  t.match(lo, /Season points\s+270\.0\s+QB 3 of 73–74/); t.match(lo, /Per scored game\s+30\.0\s+QB 2 of 35–55/);
  t.match(text(row(await perf(), ID.purdy)), /QB 2 of 35–54/, "with no such scorer nothing changes");
});

test("unreadable scores: kept as text by the loader, shown as unverified (figures and ranks withheld, a note, a '?' cell), never silently dropped; other positions are unaffected", async () => {
  const L = D.createLoader(CFG, async () => okAns({ playerScores: { playerScore: [{ id: "1", score: "N/A" }, { id: "2", score: "" }, { id: "3", score: "7.5" }, { id: "4", score: "-" }] } })), r = await L.loadScores(3);
  t.equal(r.data.scores["1"], "N/A"); t.equal(r.data.scores["2"], undefined, "a blank is no score"); t.equal(r.data.scores["3"], 7.5); t.equal(r.data.scores["4"], "-");
  const sc = clone(FX4.scores); sc["3"] = sc["3"].map((x) => (x.id === ID.purdy ? { id: x.id, score: "N/A" } : x));
  const html = await perf({ scores: sc }), p = text(row(html, ID.purdy));
  t.match(p, /Season points\s+—\s+Unverified/); t.match(p, /Per scored game\s+—\s+Unverified/); t.match(p, /1 score could not be read, so his season figures and ranks are not shown\./); t.doesNotMatch(p, /QB \d/);
  t.match(text(row(html, ID.shaheed)), /WR 66 of 240/, "his position is known: another position's rank is not widened by him");
  const I = await intel({ scores: sc }), S2 = state({ intel: I, sub: "contracts", profile: { pid: ID.purdy, tab: "perf", all: true } });
  t.match(V.app(S2).split('<div class="card tbl">')[1].split("</table>")[0], /<td>3<\/td><td class="n"><span class="mu">unreadable<\/span>/, "the game log says unreadable, not a dash");
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

run("mobile2027_performance_prb");
