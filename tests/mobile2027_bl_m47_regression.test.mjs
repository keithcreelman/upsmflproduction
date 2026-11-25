// UPS 2027 beta (PR B), BL-M47 regression: the cutoff week is the last week in which EVERY game is final, never a week with one final game.
//   node tests/mobile2027_bl_m47_regression.test.mjs
//
// The identified old revision is 88946ba0 (the tip of PR #1499, before PR B). Its Performance screen took its last week from the Worker's
// `latestFinalWeek` ("at least one final game") and held it back only by the team history's coverage week. When the history advanced into a partial
// week it therefore read "Comparison through Week 11" on a Week 11 with 1 of 13 games final.
//
// The SAME recorded scenario (the Thursday of Week 11: latestFinalWeek 11, lastCompleteWeek 10, 1 of 13 games final) is rendered by
//   - the old revision, extracted with `git show` into a temporary folder (the checkout's files are never touched), and
//   - the code under test,
// once with team history through Week 10 and once through Week 11. One check, `holds()`, is applied to both: the old revision FAILS it for history
// through Week 11 and the code under test PASSES it for both. If the old revision is not in this checkout (a shallow clone), the old half runs
// against the outputs recorded from a real run of 88946ba0 and says so; it never fails for that reason.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const require = createRequire(import.meta.url);
const OLD_REV = "88946ba0";
const TF = path.join(HERE, "fixtures/mobile2027");
const FX = JSON.parse(fs.readFileSync(path.join(TF, "public_reads.json"), "utf8")), FX3 = JSON.parse(fs.readFileSync(path.join(TF, "r3_reads.json"), "utf8")), FX4 = JSON.parse(fs.readFileSync(path.join(TF, "r4_reads.json"), "utf8"));
const CAL = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/calendar_2026.json"), "utf8"));
const CFG = { workerBase: "https://upsmflproduction.keith-creelman.workers.dev", leagueId: "74598", season: "2026" };
const clone = (x) => JSON.parse(JSON.stringify(x));
const text = (html) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const body = (html) => html.split('id="screen"')[1].split("<nav")[0];
const ok = (b) => ({ ok: true, status: 200, text: async () => JSON.stringify(b) });
const rec = (r) => ({ state: r.state, data: r.data, error: r.error, at: Date.now() });
const baseState = (M, intel, extra) => Object.assign({ model: M.build(FX.roster_workbench, FX.league, FX.weekly_results, 11, 2026), load: { core: "ok", coreNotes: [] }, penalty: { state: "idle" }, ns: { state: "idle" }, teamId: "0010", tab: "team", sub: "performance", view: "lineup",
  open: {}, flags: {}, profile: null, sheet: null, skin: "system", vib: "1", build: "test", requestLog: [], gdef: "needs", wk: null, live: null, pf: { f: "all", s: "pos", open: {}, res: {} },
  requestSummary: { requests: 0, ok: 0, failed: 0, refused: 0, nonGet: 0 }, intel: intel }, extra || {});

// The old revision's screen (PR #1499's reads: the matchup read and weekly scores only).
async function renderOld(libDir, histThrough) {
  const M = require(path.join(libDir, "model.js")), D = require(path.join(libDir, "data.js")), V = require(path.join(libDir, "views.js"));
  const lm = clone(FX3.lineup_matchups_w11); lm.teamHistoryThrough = histThrough;
  const fake = async (url) => { const u = new URL(url); let b = {};
    if (u.pathname === "/api/lineup-matchups") b = Object.assign({}, lm, { week: Number(u.searchParams.get("W")) });
    else if (u.searchParams.get("TYPE") === "playerScores") b = { playerScores: { playerScore: FX3.scores[u.searchParams.get("W")] || [] } };
    return ok(b); };
  const L = D.createLoader(CFG, fake), intel = { status: null, mu: { 11: rec(await L.loadMatchups(11)) }, wk: {}, scores: {} };
  for (const w of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) intel.scores[w] = rec(await L.loadScores(w));
  return { season: lm.season, html: body(V.app(baseState(M, intel))) };
}
// The code under test: the same scenario with every read PR B makes (schedules of Weeks 10 and 11, the players, Weeks 1 to 11 of scores).
async function renderNew(histThrough) {
  const SRC = path.join(ROOT, "apps", "mobile2027", "src", "lib");
  const M = require(path.join(SRC, "model.js")), D = require(path.join(SRC, "data.js")), V = require(path.join(SRC, "views.js")), X = require(path.join(SRC, "complete.js"));
  const lm = Object.assign({}, clone(FX3.lineup_matchups_w11), clone(FX4.hist)); lm.teamHistoryThrough = histThrough;
  const fake = async (url) => { const u = new URL(url), ty = u.searchParams.get("TYPE"), w = u.searchParams.get("W");
    if (u.pathname === "/api/lineup-matchups") return ok(Object.assign({}, lm, { week: Number(w) }));
    if (ty === "playerScores") return ok({ playerScores: { playerScore: FX4.scores[w] || (w === "11" ? [{ id: "1", score: "0" }] : []) } });
    if (ty === "players") return ok({ players: { player: FX4.players } });
    if (ty === "nflByeWeeks") return ok(CAL.byes);
    if (ty === "nflSchedule" && w === "ALL") return ok(CAL.full);
    if (ty === "nflSchedule") return ok(w === "10" ? FX4.schedule10 : w === "11" ? FX4.schedule11 : { nflSchedule: { matchup: [] } });
    return ok({}); };
  const L = D.createLoader(CFG, fake), intel = { status: null, mu: { 11: rec(await L.loadMatchups(11)) }, wk: {}, scores: {}, sched: {}, players: rec(await L.loadPlayers()) };
  for (const w of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) intel.scores[w] = rec(await L.loadScores(w));
  for (const w of [10, 11]) intel.sched[w] = rec(await L.loadSchedule(w, X.parseSchedule));
  if (L.loadCalendar) intel.cal = rec(await L.loadCalendar(X.parseCalendar));
  Object.keys(intel.scores).forEach((k) => { intel.scores[k].at += 1000; });   // the scores are read after the schedules, as the app does
  return { season: lm.season, html: body(V.app(baseState(M, intel))) };
}
const summary = (r) => { const tx = text(r.html); return { latestFinalWeek: r.season.latestFinalWeek, lastCompleteWeek: r.season.lastCompleteWeek, banner: (tx.match(/Comparison through Week \d+|Through Week \d+/) || [null])[0], weeks: [...new Set([...tx.matchAll(/[Tt]hrough Week (\d+)/g)].map((m) => m[1]))] }; };
// The one check: every figure and the banner run through Week 10, the last week in which every game is final (1 of 13 games of Week 11 are).
// R6: the banner is the header's single "Through Week N" (the old revision's banner was "Comparison through Week N"; the comparison left the main card).
const holds = (s) => s.lastCompleteWeek === 10 && (s.banner === "Comparison through Week 10" || s.banner === "Through Week 10") && s.weeks.length === 1 && s.weeks[0] === "10";

// The old revision, extracted from this checkout's history into a temporary folder; null when it is not there (shallow clone).
function extractOld() {
  const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  try {
    git("cat-file", "-e", OLD_REV + "^{commit}");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ups-bl-m47-old-")), rel = "apps/mobile2027/src/lib";
    git("ls-tree", "--name-only", OLD_REV, rel + "/").split("\n").filter((f) => /\.js$/.test(f)).forEach((f) => fs.writeFileSync(path.join(dir, path.basename(f)), git("show", OLD_REV + ":" + f)));
    return dir;
  } catch (_) { return null; }
}
// Recorded from a real run of 88946ba0 against this scenario (2026-11-22).
const RECORDED_OLD = { 10: { latestFinalWeek: 11, lastCompleteWeek: 10, banner: "Comparison through Week 10", weeks: ["10"] }, 11: { latestFinalWeek: 11, lastCompleteWeek: 10, banner: "Comparison through Week 11", weeks: ["11"] } };

test("the code under test: with 1 of 13 Week 11 games final, history through Week 10 or through Week 11 gives the same screen, through Week 10", async () => {
  const a = await renderNew(10), b = await renderNew(11), sa = summary(a), sb = summary(b);
  t.equal(sa.latestFinalWeek, 11, "the Worker says Week 11 has a final game"); t.equal(sa.lastCompleteWeek, 10);
  t.ok(holds(sa), "history through 10: " + JSON.stringify(sa)); t.ok(holds(sb), "history through 11 (a partial week): " + JSON.stringify(sb));
  t.match(text(b.html), /Through Week 10/); t.doesNotMatch(text(b.html), /[Tt]hrough Week 11/);
});

test("the old revision 88946ba0 FAILS the same check: history through Week 11 on a partial Week 11 reads 'Comparison through Week 11'", async () => {
  const dir = extractOld();
  const out = {};
  if (dir) { try { out[10] = summary(await renderOld(dir, 10)); out[11] = summary(await renderOld(dir, 11)); } finally { fs.rmSync(dir, { recursive: true, force: true }); } }
  else { out[10] = RECORDED_OLD[10]; out[11] = RECORDED_OLD[11]; console.log("  note: " + OLD_REV + " is not in this checkout; the old half used the outputs recorded from a real run of that revision"); }
  t.ok(holds(out[10]), "with history through Week 10 the old revision was right: " + JSON.stringify(out[10]));
  t.equal(holds(out[11]), false, "with history through Week 11 the old revision fails the check: " + JSON.stringify(out[11]));
  t.equal(out[11].banner, "Comparison through Week 11", "the defect: a Week 11 with 1 of 13 games final is called the comparison week");
  t.deepEqual(out[11].weeks, ["11"], "and every figure on the screen is through Week 11");
  t.deepEqual(out[11], RECORDED_OLD[11], "the live run (or the recording) matches what was recorded when the defect was first reproduced");
});

run("mobile2027_bl_m47_regression");
