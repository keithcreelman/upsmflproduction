// UPS 2027 R11 (Keith, revised closeout 2026-11-23): team history is not a global PPG-rank requirement; the selected week's projection on each lineup row;
// Team tab order; "PPG" wording; the Contracts filters (Roster status, Salary structure: All | Flat | Loaded).
//   node tests/mobile2027_r11_closeout.test.mjs
// Offline and read-only: the REAL rank code runs over the committed recording (apps/mobile2027/src/recorded_data.js) through the recorded fetch; nothing is requested.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "apps", "mobile2027", "src");
const require = createRequire(import.meta.url);
const M = require(path.join(SRC, "lib/model.js")), D = require(path.join(SRC, "lib/data.js")), X = require(path.join(SRC, "lib/complete.js")), RC = require(path.join(SRC, "lib/recorded.js"));
const TV = require(path.join(SRC, "lib/tabviews.js")), V = require(path.join(SRC, "lib/views.js")), CH = require(path.join(SRC, "lib/clubhist.js")), K = require(path.join(SRC, "lib/ranks.js"));
const ld = (f) => { const c = vm.createContext({}); c.window = c; vm.runInContext(fs.readFileSync(path.join(SRC, f), "utf8"), c); return JSON.parse(JSON.stringify(c.UPS2027_RECORDED || c.UPS2027_CONFIG)); };
const BUNDLE = ld("recorded_data.js"), CFG = ld("config.js");
const text = (html) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const body = (html) => html.split('id="screen"')[1].split("<nav")[0];

// A fresh recorded state: the loader answers only from the bundle (RC.createFetch), so nothing leaves the process.
async function fresh(over) {
  const L = D.createLoader(CFG, RC.createFetch(BUNDLE)), rec = (r) => ({ state: r.state, data: r.data, error: r.error, at: Date.now() });
  const core = await L.loadCore();
  const model = M.build(core.roster.data, core.league.state === "ok" ? core.league.data : null, core.weekly.state === "ok" ? core.weekly.data : null, core.week, 2026);
  const S = { model, load: { core: "ok", coreNotes: [] }, penalty: { state: "idle" }, ns: { state: "idle" }, teamId: model.teams[0].id, tab: "team", sub: "performance", view: "lineup", open: {}, flags: {}, profile: null, sheet: null,
    skin: "system", vib: "1", build: "test", requestLog: [], gdef: "needs", wk: null, live: null, pf: { s: "pos", open: {}, res: {}, q: "", pos: "all", xt: false, xpos: "all", note: null },
    ct: { f: "all", l: "all", s: "exp", y: 0, d: 1, open: {}, hist: {}, bd: false, cat: {}, ns: false }, requestSummary: { requests: 0, ok: 0, failed: 0, refused: 0, nonGet: 0 }, sample: { on: false },
    intel: { status: null, mu: {}, wk: {}, scores: {}, sched: {}, players: null, cal: null, proj: {}, reread: {} } };
  S.intel.mu[core.week] = rec(await L.loadMatchups(core.week));
  for (let w = 1; w <= 11; w++) S.intel.scores[w] = rec(await L.loadScores(w));
  for (const w of [10, 11]) S.intel.sched[w] = rec(await L.loadSchedule(w, X.parseSchedule));
  S.intel.cal = rec(await L.loadCalendar(X.parseCalendar));
  S.intel.players = rec(await L.loadPlayers());
  Object.keys(S.intel.scores).forEach((k) => { S.intel.scores[k].at += 1000; });
  const ids = [...new Set(S.model.teams[0].players.map((p) => String(p.id)))];
  const pj = await L.projections(2026, core.week, ids);
  S.intel.proj[core.week] = pj.state === "ok" ? { state: "ok", data: { ok: true, season: pj.data.season, week: pj.data.week, provider: pj.data.provider, projections: pj.data.projections }, at: Date.now() } : { state: pj.state };
  Object.assign(S, over || {});
  return { S, L, core, week: core.week };
}
const ranksOf = (S) => { const ids = []; S.model.teams.forEach((tm) => tm.players.forEach((p) => ids.push(p.id))); const ctx = TV.perfCtx(S, ids); return { ctx, ids, rd: ctx.rank }; };
const bust = (S) => { Object.keys(S.intel.scores).forEach((k) => { S.intel.scores[k].at += 7; }); };   // the rank memo keys on when each week was read

test("no team history in the recording: the PPG rank is NOT blank for everyone; one cutoff (last all-final week); the fallback and the unresolved cases are counted", async () => {
  const { S } = await fresh(), { ctx, ids, rd } = ranksOf(S);
  t.equal(ctx.read, "ok"); t.equal(rd.state, "ok");
  t.equal(ctx.cutoff.week, 10); t.equal(rd.cutoff, 10, "every figure runs through the last all-final week");
  t.equal(rd.fb.mode, "none");
  // pinned from the committed recording (read-only run, 2026-11-23): 1,634 scorers; 1,603 judged on the current club's schedule; 31 unresolved on their own
  t.equal(rd.fb.scorers, 1634); t.equal(rd.fb.fallback, 1603); t.equal(rd.fb.unresolved, 31);
  t.deepEqual(rd.fb.reasons, { no_club: 18, bye_score: 13 });
  let ranked = 0, own = 0;
  ids.forEach((id) => { const f = TV.statFigures(S, id, rd, false); if (f.total == null) return; if (f.gameRank !== "—") ranked++; else own++; });
  t.ok(ranked >= 390, "PPG ranks are shown (" + ranked + " of the rostered players with scores)");
  const h = body(V.app(S));
  t.doesNotMatch(text(h), /Team history|PPG ranks are not shown|aren.t available yet/i, "no history notice in the header or cards");
  t.match(text(h), /Through Week 10/);
  t.ok((text(h).match(/PPG -?[\d.]+ [A-Z]+\d+/g) || []).length >= 20, "PPG figures carry a rank on the cards");
  // the basis is labeled provisional inside a Breakdown, not on the card
  const eligible = ids.find((id) => rd.elig[id] && rd.elig[id].provisional && TV.statFigures(S, id, rd, false).gameRank !== "—");
  t.ok(eligible, "a provisional player exists"); t.ok(TV.statFigures(S, eligible, rd, false).detail.some((d) => d[0] === "PPG rank basis" && d[1] === "Provisional"));
});

test("zero and negative scores still count as scored games (PPG rank denominator); an unresolved player is handled alone", async () => {
  const { S } = await fresh(), A = ranksOf(S);
  // a rostered, ranked player with a week that has no score: add a 0.0 and a negative score and see n and the total move exactly
  const id = A.ids.find((x) => { const f = TV.statFigures(S, x, A.rd, false); return f.total != null && A.rd.elig[x] && A.rd.elig[x].provisional && f.n <= 8; });
  t.ok(id, "a player with at least two unscored weeks");
  const f0 = TV.statFigures(S, id, A.rd, false), free = [];
  for (let w = 1; w <= 10; w++) if (!Object.prototype.hasOwnProperty.call(S.intel.scores[w].data.scores, id)) free.push(w);
  t.ok(free.length >= 2);
  S.intel.scores[free[0]].data.scores[id] = "0.00"; S.intel.scores[free[1]].data.scores[id] = "-3.50"; bust(S);
  const B = ranksOf(S), f1 = TV.statFigures(S, id, B.rd, false);
  t.equal(f1.n, f0.n + 2, "both count as scored games"); t.equal(Math.round(f1.total * 100), Math.round(f0.total * 100) - 350, "0.0 adds nothing, -3.5 subtracts exactly");
  // an unresolved player (a score in his current club's bye week) neither ranks nor changes anyone else's rank to a range
  const un = B.ids.find((x) => B.rd.elig[x] && B.rd.elig[x].local === "bye_score");
  t.ok(un, "an unresolved bye-week scorer exists in the recording");
  const fu = TV.statFigures(S, un, B.rd, false);
  t.equal(fu.gameRank, "—"); t.ok(fu.total != null && fu.ppg != null, "his points and PPG stay visible"); t.match(fu.gameWhy, /bye week/);
  const exactOthers = B.ids.filter((x) => x !== un && B.rd.elig[x] && B.rd.elig[x].status === "eligible").every((x) => { const pg = K.perGameRank(B.rd.entries, x, B.rd.unplacedGame); return !pg || pg.worst >= pg.best; });
  t.ok(exactOthers);
  const peers = B.rd.entries.filter((e) => e.status === "local"); t.ok(peers.length >= 1, "unresolved players are entered as 'local' (matching no branch of the rank)");
});

test("history one week behind: the cutoff stays the last all-final week; a player with a known club change is unresolved ON HIS OWN (his known clubs are not replaced), the rest use the fallback", async () => {
  const { S } = await fresh(), A = ranksOf(S);
  const changer = A.ids.find((x) => A.rd.elig[x] && A.rd.elig[x].provisional && TV.statFigures(S, x, A.rd, false).gameRank !== "—");
  const mu = S.intel.mu[Object.keys(S.intel.mu)[0]].data;
  mu.hist = { teamHistoryState: "ok", teamHistoryReason: null, teamHistoryThrough: 9, teamHistoryFirst: {}, teamHistoryMissing: [], teamHistoryConflict: [], teamHistory: { [changer]: { seg: [["AAA", 1, 4], ["BBB", 5, 9]] } } };
  bust(S);
  const B = ranksOf(S);
  t.equal(B.ctx.cutoff.week, 10, "history behind holds nothing back"); t.equal(B.rd.cutoff, 10); t.equal(B.rd.fb.mode, "lag"); t.equal(B.rd.fb.through, 9);
  t.equal(B.rd.elig[changer].local, "lag_changed"); t.match(B.rd.elig[changer].why, /Week 9/);
  const f = TV.statFigures(S, changer, B.rd, false); t.equal(f.gameRank, "—"); t.ok(f.total != null && f.ppg != null, "points and PPG stay");
  const other = B.ids.find((x) => x !== changer && B.rd.elig[x] && B.rd.elig[x].provisional && TV.statFigures(S, x, B.rd, false).gameRank !== "—");
  t.ok(other, "everyone else still has a PPG rank"); t.ok(B.rd.fb.fallback > 1000, "the no-change players use the fallback (" + B.rd.fb.fallback + ")");
  t.doesNotMatch(text(body(V.app(S))), /Team history is \d+ weeks? behind|PPG ranks are not shown/);
});

test("complete history: a known club changer keeps his HISTORICAL clubs (never his current one); not provisional", async () => {
  const { S } = await fresh(), A = ranksOf(S);
  const byeOf = A.ctx.input.byeOf, gm = (c, lo, hi) => (byeOf[c] >= lo && byeOf[c] <= hi ? 1 : 0);
  // a ranked player and a former club whose 1-6 calendar differs from his current club's fallback AND does not contradict any of his recorded scores
  let id = null, cur = null, other = null, fallbackGames = null;
  for (const x of A.ids) {
    const p = S.model.byId[x], f = TV.statFigures(S, x, A.rd, false);
    if (!(p && p.nflTeam && f.total != null && A.rd.elig[x] && A.rd.elig[x].provisional && f.n >= 2)) continue;
    const c0 = String(p.nflTeam).toUpperCase(), fb = 10 - gm(c0, 1, 10), scored = (w) => Object.prototype.hasOwnProperty.call(S.intel.scores[w].data.scores, x);
    const o = Object.keys(byeOf).find((c) => c !== c0 && 10 - gm(c, 1, 6) - gm(c0, 7, 10) !== fb && !(gm(c, 1, 6) && scored(byeOf[c])) && !(gm(c0, 7, 10) && scored(byeOf[c0])) && f.n <= 10 - gm(c, 1, 6) - gm(c0, 7, 10));
    if (o) { id = x; cur = c0; other = o; fallbackGames = fb; break; }
  }
  t.ok(other, "a player and a former club whose calendar makes the history differ from the fallback");
  const mu = S.intel.mu[Object.keys(S.intel.mu)[0]].data;
  mu.hist = { teamHistoryState: "ok", teamHistoryReason: null, teamHistoryThrough: 10, teamHistoryFirst: {}, teamHistoryMissing: [], teamHistoryConflict: [], teamHistory: { [id]: { seg: [[other, 1, 6], [cur, 7, 10]] } } };
  bust(S);
  const B = ranksOf(S), e = B.rd.elig[id], row = B.rd.ev.rows[id];
  t.equal(B.rd.fb.mode, "full"); t.ok(!e.provisional && !e.local, "judged on his history, not the fallback");
  const expected = 10 - gm(other, 1, 6) - gm(cur, 7, 10);
  t.ok(expected !== fallbackGames, "the historical count differs from the current-club fallback (" + expected + " vs " + fallbackGames + ")");
  t.equal(row.elig.games, expected, "weeks 1-6 use " + other + "'s calendar, weeks 7-10 use " + cur + "'s (not his current club all season)");
  t.equal(B.ctx.cutoff.week, 10);
});

test("lineup rows show the selected week's projection, 'Proj. —' when none; IR and taxi rows show none; no extra route", async () => {
  const { S } = await fresh({ sub: "roster", view: "lineup" });
  S.intel.cal = null;   // the Lineup view does not read the whole-season calendar: the kickoff comes from the matchups read it already has
  const h = body(V.app(S)), tx = text(h);
  // R13 F7 (Keith 2026-11-26): the Starting lineup header now carries the lineup's projected total (" · Proj. 142.6"); count the rows only
  const rowsTx = tx.replace(/Starting lineup · \d+\/\d+ · Proj\. \d+\.\d( \(\d+ without\))?/g, "");
  const withVal = [...rowsTx.matchAll(/Proj\. (\d+\.\d)/g)].length, noVal = [...rowsTx.matchAll(/Proj\. —/g)].length;
  t.ok(withVal >= 10, "projections shown on lineup rows (" + withVal + ")"); t.ok(noVal >= 0);
  const active = S.model.teams[0].players.filter((p) => p.status === "active").length;
  t.ok(withVal + noVal <= active, "only active players carry the line (" + (withVal + noVal) + " of " + active + ")");
  const p0 = S.model.teams[0].players.find((p) => p.status === "active"), slot = TV.projectionSlot(S, p0);
  if (slot.value != null) t.match(tx, new RegExp("Proj\\. " + slot.text.replace(".", "\\.")));
  S.view = "byes"; t.doesNotMatch(text(body(V.app(S))), /Proj\./, "Byes rows carry none");
  const app = fs.readFileSync(path.join(SRC, "app.js"), "utf8");
  t.match(app, /S\.tab === "team" && S\.sub === "roster" && S\.view === "lineup"/, "the lineup view asks the existing projections read");
});

test("Team tab order, PPG wording, Contracts filters", async () => {
  const { S } = await fresh({ sub: "roster" });
  const tabs = [...V.app(S).matchAll(/role="tab" data-act="sub" data-v="(\w+)"/g)].map((m) => m[1]);
  t.deepEqual(tabs, ["roster", "performance", "contracts", "cap"]);
  const perf = text(body(V.app(Object.assign(S, { sub: "performance" }))));
  t.doesNotMatch(perf, /Actual PPG/); t.match(perf, /\bPPG\b/);
  t.match(body(V.app(S)), /data-act="pfs" data-v="ppg" aria-pressed="false">PPG</);
  const ct = body(V.app(Object.assign(S, { sub: "contracts" })));
  t.match(ct, /<div class="lbl">Roster status<\/div>/); t.match(ct, /<div class="lbl">Salary structure<\/div>/); t.doesNotMatch(ct, /<div class="lbl">(Show|Loading)<\/div>/);
  t.deepEqual([...ct.matchAll(/data-act="ctl" data-v="(\w+)" aria-pressed="\w+">([^<]+)</g)].map((m) => m[2]), ["All", "Flat", "Loaded"]);
  const names = (html) => [...html.matchAll(/class="nmt">([^<]+)</g)].map((m) => m[1]);
  const all = names(ct), flat = names(body(V.app(Object.assign(S, { ct: Object.assign({}, S.ct, { l: "flat" }) })))), ldd = names(body(V.app(Object.assign(S, { ct: Object.assign({}, S.ct, { l: "ld" }) }))));
  t.ok(flat.length >= 1 && ldd.length >= 1, "both groups exist in the recording (Flat " + flat.length + ", Loaded " + ldd.length + ")");
  t.equal(flat.length + ldd.length <= all.length, true); t.ok(!flat.some((n) => ldd.includes(n)), "no player in both");
  t.match(text(body(V.app(Object.assign(S, { ct: Object.assign({}, S.ct, { l: "all", open: {} }) })))), /Loading classification|If cut now/, "detailed wording stays inside Details");
});

test("Help explains the fallback once; Known issues no longer says every PPG rank is —", async () => {
  const tv = fs.readFileSync(path.join(SRC, "lib/tabviews.js"), "utf8"), vw = fs.readFileSync(path.join(SRC, "lib/views.js"), "utf8");
  t.equal((tv.match(/PPG rank without team history/g) || []).length, 1);
  t.doesNotMatch(vw, /Points-per-game rank shows — for everyone/);
  t.match(vw, /counts each player against his current NFL club/);
  t.equal(CH.seasonCutoff(10, null).week, 10);
  t.equal(CH.seasonCutoff(10, { teamHistoryState: "ok", teamHistoryReason: null, teamHistoryThrough: 7, teamHistory: {}, teamHistoryFirst: {}, teamHistoryMissing: [], teamHistoryConflict: [] }).week, 10, "even two or more weeks behind");
});

run("mobile2027_r11_closeout");
