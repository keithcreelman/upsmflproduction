// UPS 2027 beta (PR B): game-level completion, the cutoff week, and the Live -> Final · updating -> regular handoff.
//   node tests/mobile2027_complete.test.mjs
// Recorded: the Thursday of Week 11 (1 of 13 games final). The Worker answer then said latestFinalWeek 11 and lastCompleteWeek 10; only the latter may be used.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const X = require(path.join(HERE, "..", "apps", "mobile2027", "src", "lib", "complete.js"));
const FX = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/complete_wk11.json"), "utf8"));
const w10 = X.parseSchedule(FX.schedule10), w11 = X.parseSchedule(FX.schedule11);
const st11 = Object.fromEntries(Object.entries(FX.status11).map(([c, s]) => [c.toUpperCase(), s]));
const game = (secs, a, b) => ({ clubs: ["AAA", "BBB"], secondsRemaining: secs, scored: a !== "" && b !== "", final: secs === 0 && a !== "" && b !== "" });

test("the recorded Thursday: Week 10 is complete; Week 11 has 1 of 13 games final; latestFinalWeek (11) is not completion", () => {
  t.equal(w10.length, 14); t.ok(w10.every((g) => g.final)); t.equal(w11.length, 13); t.equal(w11.filter((g) => g.final).length, 1);
  t.deepEqual(w11.find((g) => g.final).clubs.slice().sort(), ["HOU", "IND"]);
  t.equal(FX.season.latestFinalWeek, 11); t.equal(FX.season.lastCompleteWeek, 10);
  t.ok(X.weekComplete(w10, null)); t.equal(X.weekComplete(w11, st11), false);
  t.equal(Object.values(FX.status11).filter((s) => s === "final").length, 2, "the Worker status agrees: two clubs, one game");
});

test("a game is final only when the schedule and the Worker status agree; anything missing or conflicting is unknown", () => {
  const hou = X.gameOf(w11, "HOU"), kc = w11.find((g) => !g.final);
  t.equal(X.gameState(hou, "final"), "final"); t.equal(X.gameState(hou, null), "final", "a past week has no per-team status: the schedule alone, plus the week check");
  t.equal(X.gameState(hou, "scheduled"), "unknown", "the schedule says final, the status does not"); t.equal(X.gameState(kc, "final"), "unknown", "the status says final, the schedule does not");
  t.equal(X.gameState(kc, "scheduled"), "scheduled"); t.equal(X.gameState(null, "final"), "unknown"); t.equal(X.gameState({ secondsRemaining: null }, "final"), "unknown");
  t.equal(X.gameState(game(0, "", ""), "final"), "unknown", "0 seconds but no scores is not established"); t.equal(X.gameState(game(1800, "7", "3"), "scheduled"), "live");
  t.equal(X.gameState(game(1800, "7", "3"), null), "live"); t.equal(X.gameState(game(3600, "", ""), null), "scheduled"); t.equal(X.gameState(game(2400, "", ""), null), "live");
  t.equal(X.gameState(game(1800, "7", "3"), "weird"), "live", "an unrecognized status on an unfinished game does not claim final");
  t.equal(X.gameOf(w11, "hou").clubs.indexOf("HOU") >= 0, true); t.equal(X.gameOf(w11, "ZZZ"), null);
});

test("schedule parsing: a malformed answer is null (no completion claim), a single matchup is accepted", () => {
  t.equal(X.parseSchedule(null), null); t.equal(X.parseSchedule({}), null); t.equal(X.parseSchedule({ nflSchedule: { matchup: [{ team: [{ id: "A" }] }] } }), null);
  const one = X.parseSchedule({ nflSchedule: { matchup: { gameSecondsRemaining: "0", team: [{ id: "a", score: "10" }, { id: "b", score: "7" }] } } }); t.equal(one.length, 1); t.ok(one[0].final);
  t.equal(X.weekComplete([], null), false); t.equal(X.weekComplete(null, null), false);
  const blank = X.parseSchedule({ nflSchedule: { matchup: [{ gameSecondsRemaining: "0", team: [{ id: "a", score: "" }, { id: "b", score: "7" }] }] } }); t.equal(blank[0].final, false);
});

test("the cutoff is the last week whose games are ALL final; the Thursday case does not advance it; missing or conflicting evidence is not guessed", () => {
  const s = { 10: w10, 11: w11 };
  t.deepEqual(X.cutoffWeek(10, s, st11, 11), { state: "ok", week: 10 });
  t.deepEqual(X.cutoffWeek(11, s, st11, 11), { state: "ok", week: 10 }, "even if lastCompleteWeek were wrongly 11, an incomplete schedule steps back to Week 10");
  t.deepEqual(X.cutoffWeek(10, { 10: null }, null, 11), { state: "unavailable", need: 10 }, "a failed schedule read: no cutoff, no guess");
  t.deepEqual(X.cutoffWeek(10, {}, null, 11), { state: "unavailable", need: 10 });
  t.deepEqual(X.cutoffWeek(0, s, null, 1), { state: "none" }); t.deepEqual(X.cutoffWeek(null, s, null, 1), { state: "none" });
  t.deepEqual(X.cutoffWeek(11, { 11: w11, 10: w11 }, st11, 11), { state: "conflict" }, "neither week is complete");
  t.deepEqual(X.cutoffWeek(11, { 11: w11 }, st11, 11), { state: "unavailable", need: 10 });
  const done = w11.map((g) => ({ ...g, secondsRemaining: 0, scored: true, final: true })), allFinal = Object.fromEntries(Object.keys(st11).map((c) => [c, "final"]));
  t.deepEqual(X.cutoffWeek(11, { 11: done }, allFinal, 11), { state: "ok", week: 11 }, "the week completes: the cutoff advances");
  const oneOff = { ...allFinal, HOU: "scheduled" }; t.equal(X.cutoffWeek(11, { 11: done, 10: w10 }, oneOff, 11).week, 10, "one club's status disagrees: Week 11 is not complete");
});

test("handoff: Live, Final · updating, included, delayed, failed, conflicting evidence", () => {
  const base = { cutoff: 10, week: 11, weekAllFinal: false, read: { state: "ok", at: 1000 }, score: 28.44, tries: {} };
  t.deepEqual(X.handoff({ ...base, game: "live", score: 9.4 }), { state: "live", chip: "Live · 9.4" });
  t.deepEqual(X.handoff({ ...base, game: "live", score: null }), { state: "live", chip: "Live" });
  t.deepEqual(X.handoff({ ...base, game: "final" }), { state: "final_updating", chip: "Final · updating 28.4" }, "a Thursday game stays 'Final · updating' while the rest of the week plays");
  t.deepEqual(X.handoff({ ...base, game: "final", weekAllFinal: true, tries: { startedAt: 0, now: 5 * 60 * 1000 } }), { state: "final_updating", chip: "Final · updating 28.4" });
  const late = X.handoff({ ...base, game: "final", weekAllFinal: true, tries: { startedAt: 0, now: X.QUIET_MS } }); t.equal(late.state, "final_pending"); t.equal(late.chip, "Final · not yet in season totals"); t.equal(late.retry, true);
  const bad = X.handoff({ ...base, game: "final", weekAllFinal: true, read: { state: "error" } }); t.equal(bad.state, "final_failed"); t.equal(bad.retry, true);
  t.deepEqual(X.handoff({ ...base, game: "final", read: { state: "error" } }).state, "final_updating", "a failed read changes nothing until every game of the week is final");
  t.deepEqual(X.handoff({ ...base, cutoff: 11, game: "final" }), { state: "included", chip: "" }, "the regular display includes the week: the temporary display is removed in the same render");
  t.deepEqual(X.handoff({ ...base, cutoff: 11, game: "live" }), { state: "included", chip: "" });
  t.deepEqual(X.handoff({ ...base, game: "unknown", score: 12.04 }), { state: "unsure", chip: "Live · 12.0" }, "no 'Final' claim without agreeing evidence"); t.deepEqual(X.handoff({ ...base, game: "unknown", score: null }), { state: "unsure", chip: "" });
  t.equal(X.handoff({ ...base, game: "scheduled" }).chip, ""); t.equal(X.handoff({ ...base, game: "final", game2: 1 }).chip.indexOf("Final") === 0, true);
  ["Live", "Final · updating"].forEach((w) => t.ok(X.handoff({ ...base, game: w === "Live" ? "live" : "final" }).chip.indexOf(w) === 0));
});

test("stale or out-of-order answers are not used: an answer read before the game was first seen final, or from an earlier load, is ignored", () => {
  t.equal(X.answerFresh({ gen: 3, currentGen: 3, readAt: 2000, firstSeenFinalAt: 1500 }), true);
  t.equal(X.answerFresh({ gen: 3, currentGen: 3, readAt: 1000, firstSeenFinalAt: 1500 }), false, "read before the game was seen final");
  t.equal(X.answerFresh({ gen: 2, currentGen: 3, readAt: 2000, firstSeenFinalAt: 1500 }), false, "from an earlier load");
  t.equal(X.answerFresh(null), false); t.equal(X.answerFresh({ gen: 1, currentGen: 1, readAt: "x", firstSeenFinalAt: 1 }), false); t.equal(X.answerFresh({ gen: 1, currentGen: 1, readAt: 5, firstSeenFinalAt: null }), false);
});

run("mobile2027_complete");
