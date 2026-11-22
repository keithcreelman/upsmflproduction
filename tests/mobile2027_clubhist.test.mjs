// UPS 2027 beta: club-history evidence for the Performance screen (apps/mobile2027/src/lib/clubhist.js).
//   node tests/mobile2027_clubhist.test.mjs
//
// Offline and pure. The rules are the owner-approved implementation scope (U1, U2, F1 to F4, the evidence table, the conflict /
// missing / crosswalk table). Sections:
//   1  evidence-model rows, one test each, from tiny hand-made inputs
//   2  freshness (F1 to F4), crosswalk / malformed / absent hist, conflicts and missing
//   3  U1 (a newer week changes no figure) and U2 (no invented "of N"; identity and opportunity are separate facts)
//   4  today's club is never a historical week (static checks, mutation checks, a seeded fuzz of invariants)
//   5  GOLDEN MASTER on the real 2026 data through Week 10 (485 rostered scoring-position players) against the Python reference
//   6  named cases (Allen, Hooker, Buckner, Simmons, Harrison Jr., Brissett, Bates, Cousins, Downs, Ferguson, Bigsby, Flacco)
//   7  speed
// The golden fixture is derived from public MFL league 74598 and nflverse files by the form_audit reference script; Python is
// never called from this test.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const SRC = path.join(HERE, "..", "apps", "mobile2027", "src", "lib", "clubhist.js");
const C = require(SRC);
const GOLD = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", "mobile2027_clubhist", "golden_2026_wk10.json"), "utf8"));

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log("  ok   " + name); }
  catch (e) { failed++; console.log("  FAIL " + name + "\n       " + String((e && e.message) || e).split("\n").join("\n       ")); }
}
const near = (a, b, eps = 1e-9) => assert.ok(a !== null && b !== null && Math.abs(a - b) <= eps, a + " is not within " + eps + " of " + b);

// ---------------------------------------------------------------------------------------------------------------------------
// hand-made inputs: one player "p1", ten weeks of scores 10.1 .. 11.0 (week w scores 10 + w/10) unless a test says otherwise
const BYE = { AAA: 3, BBB: 9, CCC: 5, DDD: 9 };
const sc = (skip = [], upto = 10) => { const o = {}; for (let w = 1; w <= upto; w++) if (!skip.includes(w)) o[w] = Math.round((10 + w / 10) * 10) / 10; return o; };
const mkHist = (through, th = {}, missing = [], conflict = [], first = {}) => ({ teamHistoryState: "ok", teamHistoryReason: null, teamHistoryThrough: through, teamHistory: th, teamHistoryMissing: missing, teamHistoryConflict: conflict, teamHistoryFirst: first });

// o: { L, through, th (p1's entry), missing, conflict, first (p1's teamHistoryFirst week), newerFinal, notInSeason (weeks whose score the season total lacks), hist (explicit override, null = absent), club, byeOf, sc, loaded, season (override), ids }
function run(o = {}) {
  const L = o.L ?? 10, through = o.through ?? L, scores = o.sc ?? sc([], L);
  const hist = o.hist !== undefined ? o.hist : mkHist(through, o.th ? { p1: o.th } : {}, o.missing ? ["p1"] : [], o.conflict ? ["p1"] : [], o.first ? { p1: o.first } : {});
  const loaded = o.loaded ?? [L - 3, L - 2, L - 1, L].filter((w) => w >= 1);
  const sw = {}; loaded.forEach((w) => { sw[w] = {}; if (scores[w] !== undefined) sw[w].p1 = scores[w]; });
  let total = 0, games = 0; for (const w in scores) if (Number(w) <= L && !(o.notInSeason || []).includes(Number(w))) { total += scores[w]; games++; }
  const input = { through: hist && typeof hist.teamHistoryThrough === "number" ? hist.teamHistoryThrough : null, latestFinal: L, hist, clubs: { p1: o.club ?? "" }, byeOf: o.byeOf ?? BYE,
    season: o.season !== undefined ? o.season : (games ? { p1: { total: Math.round(total * 1e6) / 1e6, games } } : {}), scores: sw, ids: ["p1"] };
  if (o.newerFinal) input.newerFinal = o.newerFinal;
  const out = C.evaluate(input);
  return { out, row: out.rows.p1, input };
}
const cov = (row, w) => row.coverage.find((c) => c.fromWeek <= w && w <= c.toWeek);
const cell = (row, w) => row.strip.find((c) => c.week === w);

// ===========================================================================================================================
console.log("1  evidence model");
check("confirmed: a segment covers the week -> club known, that club's game or bye", () => {
  const { row } = run({ th: { seg: [["AAA", 1, 5], ["BBB", 6, 10]] }, club: "BBB", sc: sc([3, 9]) });
  assert.equal(row.coverage.length, 1); assert.deepEqual([row.coverage[0].fromWeek, row.coverage[0].toWeek, row.coverage[0].identity, row.coverage[0].opportunity, row.coverage[0].grade], [1, 10, "known", "known", "confirmed"]);
  assert.equal(cell(row, 9).kind, "bye"); assert.equal(row.teamGames.of, 8); assert.equal(row.teamGames.text, "8 of 8 team games");
  assert.deepEqual(row.window.weeks, [7, 8, 10]);                              // week 9 is BBB's bye: skipped
  assert.equal(row.cmp.state, "shown"); near(row.recent, (10.7 + 10.8 + 11) / 3); near(row.earlier, (10.1 + 10.2 + 10.4 + 10.5 + 10.6) / 5);
});
check("a recorded score alone never establishes a club or a game (week with a score, no record before the first)", () => {
  const { row } = run({ th: { seg: [["BBB", 4, 10]] }, club: "BBB", sc: sc([9]) });        // scores exist in weeks 1-3
  assert.equal(cov(row, 1).identity, "unknown_before_first_record"); assert.equal(cov(row, 1).opportunity, "unknown"); assert.equal(row.teamGames.of, null);
});
check("bracketed: no row, same club on both sides -> that club's game or bye", () => {
  const { row } = run({ th: { seg: [["AAA", 1, 7], ["AAA", 9, 10]] }, club: "AAA", byeOf: { AAA: 8 }, sc: sc([8]) });
  assert.equal(cov(row, 8).grade, "bracketed"); assert.equal(cov(row, 8).identity, "known"); assert.equal(cell(row, 8).kind, "bye");
  assert.equal(row.teamGames.of, 9);
});
check("candidates, both clubs had a game: the game is established, the club is not (no BYE label, identity one_of_two_clubs)", () => {
  const { row } = run({ th: { seg: [["AAA", 1, 3], ["BBB", 5, 10]] }, club: "BBB", byeOf: { AAA: 7, BBB: 8 }, sc: sc([8]) });
  assert.deepEqual([cov(row, 4).identity, cov(row, 4).opportunity, cov(row, 4).grade], ["one_of_two_clubs", "known", "candidates"]);
  assert.equal(row.teamGames.of, 9);                                            // week 4 counts as a game; week 8 is BBB's confirmed bye
});
check("candidates, the clubs disagree: opportunity unclear, no 'of N'", () => {
  const { row } = run({ th: { seg: [["AAA", 1, 3], ["BBB", 5, 10]] }, club: "BBB", byeOf: { AAA: 4, BBB: 8 }, sc: sc([8]) });
  assert.equal(cov(row, 4).opportunity, "unknown"); assert.equal(row.teamGames.of, null); assert.match(row.teamGames.text, /^9 scored games$/);
});
check("candidates, both clubs on a bye: the bye is established but excluded from counts and drawn as a dash (kind none), never BYE", () => {
  const { row } = run({ th: { seg: [["AAA", 1, 7], ["BBB", 9, 10]] }, club: "BBB", byeOf: { AAA: 8, BBB: 8 }, sc: sc([8]) });
  assert.deepEqual([cov(row, 8).identity, cov(row, 8).opportunity], ["one_of_two_clubs", "known"]);
  assert.equal(cell(row, 8).kind, "none"); assert.equal(cell(row, 8).byeByCandidates, true);
  assert.equal(row.teamGames.of, 9); assert.deepEqual(row.window.weeks, [7, 9, 10]);
  assert.equal(C.logFor(run({ th: { seg: [["AAA", 1, 7], ["BBB", 9, 10]] }, club: "BBB", byeOf: { AAA: 8, BBB: 8 }, sc: sc([8]) }).input, "p1").find((c) => c.week === 8).byeKnown, false);
});
check("continuation: after the last row, MFL's club = the last club, no cur -> that club", () => {
  const { row } = run({ th: { seg: [["AAA", 1, 5], ["BBB", 6, 8]] }, club: "BBB", sc: sc([3, 9]) });
  assert.deepEqual([cov(row, 9).grade, cov(row, 9).identity, cov(row, 10).grade], ["continuation", "known", "continuation"]);
  assert.equal(cell(row, 9).kind, "bye"); assert.equal(row.teamGames.of, 8);
});
check("continuation needs MFL's club = the last club: otherwise candidates (last club or MFL's club)", () => {
  const { row } = run({ th: { seg: [["AAA", 1, 5], ["BBB", 6, 8]] }, club: "CCC", sc: sc([3, 9]) });
  assert.equal(cov(row, 9).grade, "candidates"); assert.equal(cov(row, 9).identity, "one_of_two_clubs");
  assert.equal(cell(row, 9).kind, "none");                                       // BBB bye / CCC game: not established, no BYE label
  assert.equal(row.cmp.reason, "club_game_unclear");                              // the look-back reaches week 9 (and never skips it)
});
check("continuation: a Worker `cur` (MFL's club differs from the last record) means candidates, even if the roster club equals the last club", () => {
  const { row } = run({ th: { seg: [["AAA", 1, 5], ["BBB", 6, 8]], cur: "CCC" }, club: "BBB" });
  assert.equal(cov(row, 9).identity, "one_of_two_clubs"); assert.equal(cov(row, 10).identity, "one_of_two_clubs");
});
check("after the last row with no MFL club (free agent): club not confirmed, game unknown (conservative)", () => {
  const { row } = run({ th: { seg: [["AAA", 1, 5], ["BBB", 6, 8]] }, club: "FA", sc: sc([3]) });
  assert.deepEqual([cov(row, 9).identity, cov(row, 9).opportunity], ["no_evidence", "unknown"]); assert.equal(row.cmp.reason, "club_game_unclear");
});
check("before the first row: identity and opportunity unknown (not assigned backward), scores still count as scored games", () => {
  const { row } = run({ th: { seg: [["BBB", 4, 10]] }, club: "BBB", sc: sc([9]) });
  assert.deepEqual([cov(row, 3).fromWeek, cov(row, 3).toWeek, cov(row, 3).identity, cov(row, 3).opportunity], [1, 3, "unknown_before_first_record", "unknown"]);
  assert.equal(row.scoredGames, 9); assert.equal(row.teamGames.of, null); assert.equal(row.teamGames.text, "9 scored games");
});
check("no change seen: MFL's club through the cutoff, game or bye from that club's schedule", () => {
  const { row } = run({ club: "BBB", sc: sc([9]) });
  assert.equal(row.cls, "nochange"); assert.deepEqual([row.coverage.length, row.coverage[0].grade, row.coverage[0].identity, row.coverage[0].opportunity], [1, "nochange", "known", "known"]);
  assert.equal(cell(row, 9).kind, "bye"); assert.equal(row.teamGames.of, 9);
});
check("no change seen needs a current club and MFL scores: no club (or FA), or no scores, gives no evidence", () => {
  ["", "FA", undefined].forEach((c) => { const { row } = run({ club: c }); assert.equal(row.cls, "none"); assert.equal(row.coverage[0].identity, "no_evidence"); assert.equal(row.teamGames.of, null); assert.equal(row.cmp.reason, "team_history_unavailable"); });
  const noScores = run({ club: "BBB", sc: {}, season: {} }).row; assert.equal(noScores.cls, "none"); assert.equal(noScores.seasonAvg, null);
  assert.equal(noScores.scoredGames, null); assert.equal(noScores.teamGames.text, "Scored games unavailable");      // absent from the season read: unavailable, never 0 (MAT-5)
  const failed = run({ club: "BBB", sc: {}, season: null }).row; assert.equal(failed.scoredGames, null); assert.equal(failed.seasonAvg, null);   // no season read at all: unavailable, not zero
});
check("a week above the cutoff is unknown and unused (U1): coverage stops at the cutoff", () => {
  const { row, out } = run({ L: 10, through: 9, club: "BBB", th: { seg: [["AAA", 1, 5], ["BBB", 6, 9]] } });
  assert.equal(out.cutoff, 9); assert.equal(row.coverage[row.coverage.length - 1].toWeek, 9); assert.equal(cell(row, 10).kind, "newer");
});
check("teamHistoryFirst: a no-change player's weeks before his first weekly row are unknown identity AND opportunity; of is null (U2)", () => {
  const { row } = run({ club: "BBB", first: 4, sc: sc([9]) });
  assert.deepEqual([row.coverage[0].fromWeek, row.coverage[0].toWeek, row.coverage[0].grade, row.coverage[0].identity, row.coverage[0].opportunity], [1, 3, "before_first", "unknown_before_first_record", "unknown"]);
  assert.deepEqual([row.coverage[1].fromWeek, row.coverage[1].grade, row.coverage[1].identity], [4, "nochange", "known"]);
  assert.equal(row.teamGames.of, null); assert.equal(row.teamGames.text, "9 scored games"); assert.equal(cell(row, 9).kind, "bye");
  assert.equal(row.cmp.state, "shown");                                                        // the look-back (Weeks 7, 8, 10) never reaches Week 3
  const blocked = run({ club: "BBB", first: 9, sc: sc([9]) }).row; assert.deepEqual([blocked.cmp.reason, blocked.cmp.week], ["club_game_unclear", 8]);
  assert.equal(run({ club: "BBB", first: 1, sc: sc([9]) }).row.teamGames.of, 9);                // a first row in Week 1 changes nothing
});
check("missing: no identity at all, scores and season figures still shown; today's club not used", () => {
  const { row } = run({ missing: true, club: "BBB", sc: sc([9]) });
  assert.equal(row.cls, "missing"); assert.equal(row.coverage[0].identity, "no_evidence"); assert.equal(cell(row, 9).kind, "none"); assert.equal(row.teamGames.of, null);
  assert.equal(row.cmp.reason, "team_history_unavailable"); assert.equal(row.window, null);
  assert.equal(row.scoredGames, 9); near(row.seasonAvg, row.seasonAvg); assert.equal(row.range.n, 3); assert.equal(cell(row, 10).score, 11);
});
check("missing with fewer than 2 recent scores says 'Not enough recent scores' (true under any club), not 'Team history unavailable'", () => {
  const s = sc([8, 9, 10]); const { row } = run({ missing: true, club: "BBB", sc: s });
  assert.equal(row.cmp.reason, "recent_scores_lt_2");
});
check("conflict (Worker list): identity unknown for ALL weeks, comparison withheld 'Records conflict', count only", () => {
  const { row } = run({ conflict: true, club: "BBB", sc: sc([9]) });
  assert.equal(row.cls, "conflict"); assert.ok(row.coverage.every((c) => c.identity === "conflict" && c.opportunity === "unknown"));
  assert.equal(row.cmp.reason, "records_conflict"); assert.equal(row.cmp.text, "Records conflict"); assert.equal(row.teamGames.of, null);
  assert.ok(row.strip.every((c) => c.kind !== "bye"));
});
check("a recorded score in a week the determined club had a bye is a conflict (shown once, nothing hidden)", () => {
  const { row } = run({ club: "BBB", sc: sc() });                                // BBB's bye is week 9 and week 9 has a score
  assert.equal(row.cls, "conflict"); assert.equal(row.cmp.reason, "records_conflict"); assert.equal(cell(row, 9).kind, "score"); assert.equal(row.scoredGames, 10);
});
check("more scored games than team games is a conflict (an unloaded week cannot hide it)", () => {
  const { row } = run({ club: "BBB", sc: sc(), loaded: [10] });
  assert.equal(row.cls, "conflict");
});

// ===========================================================================================================================
console.log("2  freshness, crosswalk, malformed, absent");
check("F3: gap 0 and gap 1 are allowed; banner 'Comparison through Week N'", () => {
  const a = run({ L: 10, through: 10, club: "BBB", sc: sc([9]) }).out, b = run({ L: 10, through: 9, club: "BBB", th: { seg: [["AAA", 1, 5], ["BBB", 6, 9]] }, sc: sc([9]) }).out;
  assert.deepEqual([a.state, a.gap, a.cutoff, a.banner], ["ok", 0, 10, { text: "Comparison through Week 10", kind: "through" }]);
  assert.deepEqual([b.state, b.gap, b.cutoff, b.banner.text], ["ok", 1, 9, "Comparison through Week 9"]);
});
check("F3: gap >= 2 withholds every comparison ('Team history is g weeks behind'); scores, season average, scored games and range still show", () => {
  const { out, row } = run({ L: 12, through: 10, club: "BBB", sc: sc([], 12) });
  assert.deepEqual([out.state, out.reason, out.gap, out.banner.kind, out.banner.text], ["unavailable", "stale", 2, "stale", "Team history is 2 weeks behind"]);
  assert.equal(row.cmp.reason, "team_history_stale"); assert.equal(row.cmp.state, "withheld"); assert.equal(row.recent, null); assert.equal(row.window, null);
  assert.equal(row.scoredGames, 12); near(row.seasonAvg, sc([], 12) && Object.values(sc([], 12)).reduce((a, b) => a + b, 0) / 12);
  assert.ok(row.strip.every((c) => c.kind === "score")); assert.equal(row.range.n, 4); assert.equal(row.teamGames.of, null); assert.deepEqual(row.coverage, []);
});
check("F3: stale gap 3 and the byeOf of today's club still draw no BYE", () => {
  const { row } = run({ L: 13, through: 10, club: "BBB", sc: sc([9], 13), byeOf: { BBB: 11 } });
  assert.ok(row.strip.every((c) => c.kind !== "bye"));
});
check("F1: a 'no change seen' player is covered only to the cutoff, never later", () => {
  const { row } = run({ L: 11, through: 10, club: "BBB", sc: sc([9], 11), byeOf: { BBB: 11 } });
  assert.equal(row.coverage[row.coverage.length - 1].toWeek, 10); assert.equal(cell(row, 11).kind, "newer");     // week 11 is BBB's bye but newer: no BYE label
});
check("F4: evaluate is a pure function of its input (no clock): same input, same output, input unchanged", () => {
  const { input } = run({ club: "BBB", sc: sc([9]) }); const s = JSON.stringify(input);
  assert.deepEqual(C.evaluate(input), C.evaluate(input)); assert.equal(JSON.stringify(input), s);
});
["crosswalk_failed", "crosswalk_suspect", "context_failed", "past_season", "no_history"].forEach((reason) => {
  check("Worker unavailable (" + reason + "): every club-dependent figure withheld, one banner with the reason, scores still shown", () => {
    const hist = { teamHistoryState: "unavailable", teamHistoryReason: reason, teamHistoryThrough: null, teamHistory: {}, teamHistoryMissing: [], teamHistoryConflict: [] };
    const { out, row } = run({ hist, club: "BBB", sc: sc([9]) });
    assert.deepEqual([out.state, out.reason, out.cutoff, out.banner.kind, out.banner.text, out.banner.reason], ["unavailable", reason, null, "unavailable", "Team history unavailable", reason]);
    assert.equal(row.cmp.reason, "team_history_unavailable"); assert.equal(row.teamGames.of, null); assert.equal(row.window, null); assert.equal(cell(row, 9).kind, "none");
    assert.equal(row.scoredGames, 9); assert.equal(row.range.n, 3);
  });
});
check("absent hist (W1 not live) is unavailable with reason absent; nothing guessed from today's club", () => {
  [null, undefined].forEach((hist) => {
    const r0 = run({ hist: null, club: "BBB", sc: sc([9]) }); if (hist === undefined) delete r0.input.hist;
    const out = C.evaluate(r0.input), row = out.rows.p1;
    assert.deepEqual([out.state, out.reason, out.banner.reason], ["unavailable", "absent", "absent"]);
    assert.equal(cell(row, 9).kind, "none"); assert.equal(row.teamGames.of, null); assert.equal(row.cmp.reason, "team_history_unavailable");
    assert.equal(row.scoredGames, 9); assert.ok(row.seasonAvg > 10); assert.equal(row.strip.filter((c) => c.kind === "score").length, 3); assert.equal(row.range.lo, 10.7);
  });
});
const malformed = {
  "teamHistory is an array": (h) => { h.teamHistory = []; }, "teamHistory missing": (h) => { delete h.teamHistory; },
  "seg is not an array": (h) => { h.teamHistory = { p1: { seg: "AAA" } }; }, "seg is empty": (h) => { h.teamHistory = { p1: { seg: [] } }; },
  "segment is not [club, from, to]": (h) => { h.teamHistory = { p1: { seg: [["AAA", 1]] } }; }, "club is not a string": (h) => { h.teamHistory = { p1: { seg: [[7, 1, 2]] } }; },
  "week is not an integer": (h) => { h.teamHistory = { p1: { seg: [["AAA", 1.5, 2]] } }; }, "from > to": (h) => { h.teamHistory = { p1: { seg: [["AAA", 5, 3]] } }; },
  "week 0": (h) => { h.teamHistory = { p1: { seg: [["AAA", 0, 3]] } }; }, "to beyond through": (h) => { h.teamHistory = { p1: { seg: [["AAA", 1, 11]] } }; },
  "overlapping segments": (h) => { h.teamHistory = { p1: { seg: [["AAA", 1, 5], ["BBB", 5, 8]] } }; }, "segments out of order": (h) => { h.teamHistory = { p1: { seg: [["AAA", 6, 8], ["BBB", 1, 5]] } }; },
  "cur is not a string": (h) => { h.teamHistory = { p1: { seg: [["AAA", 1, 5]], cur: 7 } }; },
  "missing list is not an array": (h) => { h.teamHistoryMissing = "p1"; }, "conflict list has a number": (h) => { h.teamHistoryConflict = [7]; },
  "through is 0": (h) => { h.teamHistoryThrough = 0; }, "through is a string": (h) => { h.teamHistoryThrough = "10"; }, "through is null while ok": (h) => { h.teamHistoryThrough = null; },
  "through more than one week beyond the latest final week": (h) => { h.teamHistoryThrough = 13; }, "state is unknown": (h) => { h.teamHistoryState = "maybe"; },
  "teamHistoryFirst absent": (h) => { delete h.teamHistoryFirst; }, "teamHistoryFirst null": (h) => { h.teamHistoryFirst = null; }, "teamHistoryFirst is an array": (h) => { h.teamHistoryFirst = [3]; },
  "teamHistoryFirst week 0": (h) => { h.teamHistoryFirst = { p1: 0 }; }, "teamHistoryFirst beyond through": (h) => { h.teamHistoryFirst = { p1: 11 }; },
  "teamHistoryFirst not an integer": (h) => { h.teamHistoryFirst = { p1: 2.5 }; }, "teamHistoryFirst string week": (h) => { h.teamHistoryFirst = { p1: "3" }; },
  "ok with a reason": (h) => { h.teamHistoryReason = "context_failed"; }, "unavailable with no reason": (h) => { h.teamHistoryState = "unavailable"; h.teamHistoryReason = null; },
  "unavailable with an unknown reason": (h) => { h.teamHistoryState = "unavailable"; h.teamHistoryReason = "weather"; }
};
Object.keys(malformed).forEach((name) => check("malformed hist (" + name + ") is unavailable 'malformed'; scores and season figures still render; nothing from today's club", () => {
  const hist = mkHist(10); malformed[name](hist);
  const { out, row } = run({ hist, club: "BBB", sc: sc([9]) });
  assert.deepEqual([out.state, out.reason], ["unavailable", "malformed"]);
  assert.equal(cell(row, 9).kind, "none"); assert.equal(row.teamGames.of, null); assert.equal(row.cmp.state, "withheld"); assert.equal(row.window, null);
  assert.equal(row.scoredGames, 9); assert.equal(row.range.n, 3);
}));
check("hist is not an object / input.through disagrees with the hist: malformed", () => {
  assert.equal(run({ hist: "ok", club: "BBB" }).out.reason, "malformed"); assert.equal(run({ hist: [], club: "BBB" }).out.reason, "malformed");
  const r = run({ club: "BBB" }); const input = Object.assign({}, r.input, { through: 9 }); assert.equal(C.evaluate(input).reason, "malformed");
});
check("an invalid latestFinal returns unavailable malformed without throwing", () => {
  [undefined, 0, 2.5, "10"].forEach((L) => { const o = C.evaluate({ latestFinal: L, hist: mkHist(5), ids: ["p1"] }); assert.deepEqual([o.state, o.reason, o.rows], ["unavailable", "malformed", {}]); });
});

// comparison withheld reasons, one test each
check("cmp: recent_scores_lt_2 (the last four loaded weeks hold fewer than 2 scores, under any club)", () => {
  const { row } = run({ club: "BBB", sc: sc([7, 8, 10]) }); assert.equal(row.cmp.reason, "recent_scores_lt_2"); assert.equal(row.cmp.text, "Not enough recent scores (needs 2)");
});
check("cmp: earlier_scores_lt_4 (fewer than 6 scored games in all, or fewer than 4 earlier)", () => {
  const a = run({ club: "BBB", sc: { 7: 5, 8: 6, 10: 7, 4: 3, 2: 4 } }).row;       // 5 scored games
  assert.equal(a.cmp.reason, "earlier_scores_lt_4");
  const b = run({ club: "BBB", sc: { 7: 5, 8: 6, 10: 7, 4: 3, 2: 4, 1: 1 } }).row; // 6 scored games, window 10,8,7: earlier = 3 (weeks 1,2,4); wait: week 9 is a bye
  assert.equal(b.cmp.reason, "earlier_scores_lt_4");
});
check("cmp: club_game_unclear names the week the look-back reached", () => {
  const { row } = run({ th: { seg: [["BBB", 9, 10]] }, club: "BBB", sc: sc([9]) });
  assert.equal(row.cmp.reason, "club_game_unclear"); assert.equal(row.cmp.week, 8);
});
check("cmp: score_week_not_loaded (window reaches a week the phone did not load); never guessed", () => {
  const { row } = run({ club: "BBB", sc: sc([9]), loaded: [8, 9, 10] });            // bye in week 9: window 10, 8, 7 and week 7 is not loaded
  assert.equal(row.cmp.reason, "score_week_not_loaded"); assert.equal(cell(row, 7).kind, "unloaded"); assert.equal(row.recent, null);
  assert.deepEqual(row.window.weeks, [7, 8, 10]); assert.equal(row.window.scoredCount, null);
});
check("cmp: season_unavailable when the season totals lack the player", () => {
  const { row } = run({ th: { seg: [["AAA", 1, 5], ["BBB", 6, 10]] }, club: "BBB", season: {}, sc: sc([3, 9]) });
  assert.equal(row.cmp.reason, "season_unavailable"); assert.equal(row.seasonAvg, null); assert.equal(row.scoredGames, null);
  assert.deepEqual([row.earlier, row.difference], [null, null]); assert.ok(row.recent > 10 && row.recentN >= 2); assert.equal(row.range.n, 3); assert.deepEqual(row.strip.map((c) => c.kind), ["score", "score", "bye", "score"]);
});
check("A (MAT-5): an id absent from `season` (object or null) has seasonAvg and scoredGames null; Recent, range and strip still work; Earlier withheld 'season_unavailable'", () => {
  [{}, { other: { total: 5, games: 1 } }, null].forEach((season) => {
    const ch = run({ th: { seg: [["AAA", 1, 5], ["BBB", 6, 10]] }, club: "BBB", sc: sc([3, 9]), season }).row;
    const nc = run({ club: "BBB", sc: sc([9]), season }).row;
    [ch, nc].forEach((r) => {
      assert.deepEqual([r.seasonAvg, r.scoredGames, r.seasonThrough], [null, null, null]); assert.equal(r.cmp.reason, "season_unavailable"); assert.equal(r.cmp.state, "withheld");
      assert.deepEqual([r.earlier, r.difference], [null, null]); assert.ok(r.recent > 10); assert.equal(r.range.n, 3); assert.equal(r.teamGames.text, "Scored games unavailable");
    });
    assert.equal(nc.cls, "nochange");                                                          // loaded scores show he has MFL scores
  });
  const none = run({ club: "BBB", sc: {}, season: {} }).row; assert.equal(none.cls, "none"); assert.equal(none.scoredGames, null);
});
check("an unloaded week is kind 'unloaded' (not 'none'), 0.0 is a score, a loaded week with no score is 'none'", () => {
  const { row } = run({ club: "BBB", sc: { ...sc([9]), 10: 0 }, loaded: [8, 9, 10] });
  assert.deepEqual(row.strip.map((c) => [c.week, c.kind, c.score]), [[7, "unloaded", null], [8, "score", 10.8], [9, "bye", null], [10, "score", 0]]);
  assert.equal(row.range.lo, 0);
});

// ===========================================================================================================================
console.log("3  U1 (nothing newer than the cutoff is counted) and U2 (no invented 'of N')");
// U1 scenario: L = 10, history through 9, so Week 10 is a newer week. AAA's bye (Week 3) is skipped; the window is Weeks 7-9.
const U1TH = { seg: [["AAA", 1, 5], ["BBB", 6, 9]] }, U1BYE = { AAA: 3, BBB: 15 };
const u1 = (o) => run({ L: 10, through: 9, th: U1TH, club: "BBB", byeOf: U1BYE, ...o });
const figs = (r) => ({ w: r.window, recent: r.recent, earlier: r.earlier, d: r.difference, rn: r.recentN, en: r.earlierN, cmp: r.cmp, range: r.range, avg: r.seasonAvg, g: r.scoredGames, tg: r.teamGames, cov: r.coverage, th: r.seasonThrough });
const NONE = u1({ sc: sc([3, 10]) });                                                  // no recorded Week 10 score: nothing to separate
check("U1: a week above the cutoff changes NO figure; it shows as a 'newer' cell with its score", () => {
  const nf = { complete: true };
  const a = u1({ sc: sc([3]), newerFinal: nf }), b = u1({ sc: { ...sc([3]), 10: 99 }, newerFinal: nf }), c = u1({ sc: { ...sc([3]), 10: 0 }, newerFinal: nf });
  assert.equal(NONE.row.cmp.state, "shown"); assert.equal(NONE.row.seasonThrough, 9);
  [a, b, c].forEach((x) => assert.deepEqual(figs(x.row), figs(NONE.row)));
  assert.deepEqual(cell(a.row, 10), { week: 10, kind: "newer", score: 11, loaded: true }); assert.equal(cell(b.row, 10).score, 99); assert.equal(cell(c.row, 10).score, 0);
  assert.equal(cell(NONE.row, 10).kind, "newer"); assert.equal(cell(NONE.row, 10).score, null);
  assert.equal(a.row.scoredGames, 8); assert.equal(a.row.seasonThrough, 9);                // through the cutoff: Weeks 1-9 minus the bye
  assert.ok(b.row.range.hi < 99);                                                           // the newer score is not in the range
});
check("U1: counting the newer week would change the answer (the test has teeth)", () => {
  const r = u1({ sc: { ...sc([3]), 10: 99 }, newerFinal: { complete: true } }).row;
  const counted = run({ L: 10, through: 10, th: { seg: [["AAA", 1, 5], ["BBB", 6, 10]] }, club: "BBB", sc: { ...sc([3]), 10: 99 }, byeOf: U1BYE }).row;
  assert.notEqual(r.recent, null); assert.notEqual(r.recent, counted.recent); assert.notEqual(r.seasonAvg, counted.seasonAvg);
});
check("newerFinal: complete true -> the recorded newer score is in the season total and is taken back out", () => {
  const r = u1({ sc: sc([3]), newerFinal: { complete: true } }).row;
  assert.deepEqual(figs(r), figs(NONE.row)); assert.equal(r.cmp.state, "shown");
  assert.deepEqual(figs(u1({ sc: sc([3]), newerFinal: { complete: true, clubs: { BBB: false } } }).row), figs(NONE.row));      // complete wins
});
check("newerFinal: that club's game is final (complete false, clubs[club] true) -> taken back out", () => {
  const r = u1({ sc: sc([3]), newerFinal: { complete: false, clubs: { BBB: true } } }).row;
  assert.deepEqual(figs(r), figs(NONE.row)); assert.equal(r.cmp.state, "shown");
});
check("newerFinal: that club's game is not final (clubs[club] false) -> the live score is NOT in the total and is not subtracted", () => {
  const r = u1({ sc: sc([3]), notInSeason: [10], newerFinal: { complete: false, clubs: { BBB: false } } }).row;
  assert.deepEqual(figs(r), figs(NONE.row)); assert.equal(r.cmp.state, "shown"); assert.equal(r.scoredGames, 8); assert.equal(cell(r, 10).kind, "newer"); assert.equal(cell(r, 10).score, 11);
  // subtracting it anyway would give a different (wrong) Earlier: the branch matters
  const wrong = u1({ sc: sc([3]), notInSeason: [10], newerFinal: { complete: true } }).row; assert.notEqual(wrong.earlier, r.earlier);
});
check("newerFinal: inclusion cannot be established -> Earlier and Difference withheld 'newer_score_unseparable'; season figures as the Worker gave them (seasonThrough = latestFinal)", () => {
  const cases = { "newerFinal absent": undefined, "club missing from the map": { complete: false, clubs: { AAA: true } }, "map absent": { complete: false }, "value not a boolean": { complete: false, clubs: { BBB: "yes" } }, "complete not true": { complete: "true", clubs: {} } };
  Object.keys(cases).forEach((name) => {
    const r = u1({ sc: sc([3]), newerFinal: cases[name] }).row;
    assert.equal(r.cmp.state, "withheld", name); assert.equal(r.cmp.reason, "newer_score_unseparable", name);
    assert.equal(r.cmp.text, "A newer score is recorded and it is not clear whether the season total includes it");
    assert.deepEqual([r.earlier, r.difference, r.earlierN], [null, null, null]); near(r.recent, NONE.row.recent); assert.equal(r.recentN, 3);
    assert.equal(r.scoredGames, 9); assert.equal(r.seasonThrough, 10); near(r.seasonAvg, sc([3]) && Object.values(sc([3])).reduce((x, y) => x + y, 0) / 9);
    assert.equal(cell(r, 10).kind, "newer");
  });
  const noClub = run({ L: 10, through: 9, th: U1TH, club: "", byeOf: U1BYE, sc: sc([3]), newerFinal: { complete: false, clubs: { BBB: true } } }).row;       // no current club
  assert.equal(noClub.cmp.reason, "newer_score_unseparable");
});
check("newerFinal: a player with NO recorded newer score needs no subtraction, whatever newerFinal says", () => {
  [undefined, { complete: false, clubs: {} }, { complete: true }].forEach((nf) => { const r = u1({ sc: sc([3, 10]), newerFinal: nf }).row; assert.deepEqual(figs(r), figs(NONE.row)); assert.equal(r.cmp.state, "shown"); });
});
check("newerFinal: a newer week that is not loaded cannot be separated: season figures as given, comparison withheld 'score_week_not_loaded'", () => {
  const r = u1({ sc: sc([3]), loaded: [6, 7, 8, 9], newerFinal: { complete: true } }).row;
  assert.equal(r.scoredGames, 9); assert.equal(r.seasonThrough, 10); assert.equal(r.cmp.reason, "score_week_not_loaded"); assert.equal(cell(r, 10).kind, "newer"); assert.equal(cell(r, 10).loaded, false);
});
// B: live scores in the latest final week L, at gap 0 (L is inside the comparison) -- scenario: history through 10, window Weeks 8-10
const LIVE_TH = { seg: [["AAA", 1, 5], ["BBB", 6, 10]] }, LIVE_BYE = { AAA: 3, BBB: 15 };
const lv = (o) => run({ L: 10, through: 10, th: LIVE_TH, club: "BBB", byeOf: LIVE_BYE, sc: sc([3]), ...o });
const G0 = lv({}).row;                                                                    // no newerFinal: everything counts
const live = (o) => lv({ notInSeason: [10], newerFinal: { complete: false, clubs: { BBB: false } }, ...o }).row;
check("B gap 0: complete true, or newerFinal absent, or that club's game final: the Week L score counts as before", () => {
  assert.equal(G0.cmp.state, "shown"); assert.deepEqual(G0.window.weeks, [8, 9, 10]); assert.equal(G0.recentN, 3); assert.equal(cell(G0, 10).kind, "score");
  [{ complete: true }, { complete: true, clubs: { BBB: false } }, { complete: false, clubs: { BBB: true } }].forEach((nf) => assert.deepEqual(figs(lv({ newerFinal: nf }).row), figs(G0)));
  assert.equal(G0.scoredGames, 9); assert.equal(G0.teamGames.text, "9 of 9 team games");
});
check("B gap 0: that club's game is NOT final -> live: skipped for the window like a bye (not a gap); strip 'live' with the score carried; counted in no figure", () => {
  const r = live();
  assert.deepEqual(cell(r, 10), { week: 10, kind: "live", score: 11, loaded: true });
  assert.equal(r.cmp.state, "shown"); assert.deepEqual(r.window.weeks, [7, 8, 9]);                 // the window continues to the previous completed game
  assert.equal(r.window.scoredCount, 3); assert.equal(r.recentN, 3);
  near(r.recent, (10.7 + 10.8 + 10.9) / 3); near(r.earlier, (10.1 + 10.2 + 10.4 + 10.5 + 10.6) / 5); assert.equal(r.earlierN, 5);
  assert.equal(r.range.hi, 10.9); assert.equal(r.range.n, 3); assert.equal(r.scoredGames, 8); assert.equal(r.seasonThrough, 10); assert.equal(r.mixedBase, false);
  assert.equal(r.teamGames.text, "8 of 8 team games");                                              // the live game is not a completed team game
  assert.notEqual(G0.recent, r.recent);                                                             // the branch matters
  // the rule is per player: a player whose club is final is untouched
  assert.deepEqual(figs(lv({ newerFinal: { complete: false, clubs: { BBB: true, AAA: false } } }).row), figs(G0));
});
check("B gap 0: a live game with NO recorded score is skipped the same way (the window is the three games before it)", () => {
  const r = live({ sc: sc([3, 10]), notInSeason: [] });
  assert.deepEqual(r.window.weeks, [7, 8, 9]); assert.equal(cell(r, 10).kind, "none"); assert.equal(r.teamGames.text, "8 of 8 team games"); assert.equal(r.cmp.state, "shown");
});
check("window: a COMPLETED team game with no score stays a gap (keeps its slot; never reaches farther back for a third score)", () => {
  const gap10 = lv({ sc: sc([3, 10]) }).row;                                                       // Week 10 final, no score
  assert.deepEqual(gap10.window.weeks, [8, 9, 10]); assert.equal(gap10.recentN, 2); assert.equal(gap10.window.scoredCount, 2); near(gap10.recent, (10.8 + 10.9) / 2); assert.equal(gap10.cmp.state, "shown");
  const finalNoScore = lv({ sc: sc([3, 10]), newerFinal: { complete: false, clubs: { BBB: true } } }).row; assert.deepEqual(figs(finalNoScore), figs(gap10));
  const gap9 = lv({ sc: sc([3, 9]) }).row; assert.deepEqual(gap9.window.weeks, [8, 9, 10]); assert.equal(gap9.recentN, 2);
  const two = lv({ sc: sc([3, 9, 10]) }).row; assert.equal(two.cmp.reason, "recent_scores_lt_2"); assert.deepEqual(two.window.weeks, [8, 9, 10]);      // only Week 8 scored: not enough, and no reach-back
  // live skipped is NOT a gap: the window moves back, so one completed no-score game in it still leaves 2 scores
  const liveGap = live({ sc: sc([3, 9]), notInSeason: [10] }); assert.deepEqual(liveGap.window.weeks, [7, 8, 9]); assert.equal(liveGap.recentN, 2); assert.equal(liveGap.cmp.state, "shown");
});
check("B gap 0: inclusion cannot be established -> 'newer_score_unseparable' with a recorded score (Recent too); 'club_game_unclear' (Week L) without one", () => {
  [{ complete: false, clubs: { AAA: false } }, { complete: false }, { complete: false, clubs: { BBB: "no" } }].forEach((nf) => {
    const r = lv({ newerFinal: nf }).row;
    assert.equal(r.cmp.reason, "newer_score_unseparable"); assert.deepEqual([r.recent, r.earlier, r.difference], [null, null, null]);
    assert.equal(cell(r, 10).kind, "score");                                                    // not known to be live, so not drawn as live
    const none = lv({ sc: sc([3, 10]), newerFinal: nf }).row; assert.equal(none.cmp.reason, "club_game_unclear"); assert.equal(none.cmp.week, 10); assert.equal(none.teamGames.of, null);
  });
  const noClub = run({ L: 10, through: 10, th: LIVE_TH, club: "", byeOf: LIVE_BYE, sc: sc([3]), newerFinal: { complete: false, clubs: { BBB: true } } }).row; assert.equal(noClub.cmp.reason, "newer_score_unseparable");
  // a bye at Week L needs no settlement: no game, nothing live
  const byeL = run({ L: 10, through: 10, th: LIVE_TH, club: "BBB", byeOf: { AAA: 3, BBB: 10 }, sc: sc([3, 10]), newerFinal: { complete: false, clubs: {} } }).row; assert.equal(byeL.cmp.state, "shown");
});
check("B gap 1: the newer Week L score stays a 'newer' cell and never enters a figure, whatever its game state", () => {
  const without = u1({ sc: sc([3, 10]) }).row;
  [{ complete: false, clubs: { BBB: false } }, { complete: false, clubs: { BBB: true } }, { complete: true }].forEach((nf) => {
    const r = u1({ sc: sc([3]), notInSeason: nf.clubs && nf.clubs.BBB === false ? [10] : [], newerFinal: nf }).row;
    assert.deepEqual(figs(r), figs(without)); assert.equal(cell(r, 10).kind, "newer"); assert.equal(cell(r, 10).score, 11);
  });
  assert.equal(u1({ sc: sc([3]), newerFinal: { complete: false, clubs: {} } }).row.cmp.reason, "newer_score_unseparable");
});
check("B gap 1: the window at the cutoff is unaffected by Week L's game state; a completed no-score game at the cutoff stays a gap", () => {
  const a = u1({ sc: sc([3]), newerFinal: { complete: false, clubs: { BBB: false } }, notInSeason: [10] }).row, b = u1({ sc: sc([3, 10]) }).row;
  assert.deepEqual(a.window.weeks, [7, 8, 9]); assert.deepEqual(b.window.weeks, [7, 8, 9]);
  const g = u1({ sc: sc([3, 9, 10]) }).row; assert.deepEqual(g.window.weeks, [7, 8, 9]); assert.equal(g.recentN, 2); assert.equal(g.cmp.state, "shown");
  const unknownNoScore = u1({ sc: sc([3, 10]), newerFinal: { complete: false, clubs: {} } }).row; assert.equal(unknownNoScore.cmp.state, "shown");   // the newer week is not in the window
});
check("B: with no usable history the live score is still not counted (range) and is drawn 'live'; the comparison is withheld anyway", () => {
  const r = run({ hist: null, club: "BBB", byeOf: LIVE_BYE, sc: sc([3]), notInSeason: [10], newerFinal: { complete: false, clubs: { BBB: false } } }).row;
  assert.equal(cell(r, 10).kind, "live"); assert.equal(r.range.hi, 10.9); assert.equal(r.scoredGames, 8); assert.equal(r.cmp.reason, "team_history_unavailable");
  assert.equal(C.logFor(run({ hist: null, club: "BBB", byeOf: LIVE_BYE, sc: sc([3]), newerFinal: { complete: false, clubs: { BBB: false } } }).input, "p1")[3].kind, "live");
});
// C (MAT-3): never "10 of 9 team games"; the text says which week the count is through
check("C: an unsettled newer score -> teamGames.of null, text '<n> scored games through Week <seasonThrough>', mixedBase true", () => {
  const r = u1({ sc: sc([3]) }).row;                                                          // newerFinal absent: unsettled
  assert.equal(r.cmp.reason, "newer_score_unseparable"); assert.equal(r.mixedBase, true); assert.equal(r.seasonThrough, 10);
  assert.deepEqual([r.teamGames.known, r.teamGames.of, r.teamGames.text], [9, null, "9 scored games through Week 10"]);
  assert.ok(!/ of /.test(r.teamGames.text));
  const unloaded = u1({ sc: sc([3]), loaded: [6, 7, 8, 9], newerFinal: { complete: true } }).row; assert.deepEqual([unloaded.mixedBase, unloaded.teamGames.of, unloaded.teamGames.text], [true, null, "9 scored games through Week 10"]);
  const l0 = lv({ newerFinal: { complete: false } }).row; assert.deepEqual([l0.mixedBase, l0.teamGames.of, l0.teamGames.text], [true, null, "9 scored games through Week 10"]);   // gap 0, unsettled live score
  assert.equal(run({ L: 10, through: 9, th: U1TH, club: "BBB", byeOf: U1BYE, sc: { 1: 5, 2: 6, 10: 7 }, newerFinal: undefined }).row.teamGames.text, "3 scored games through Week 10");
  assert.equal(run({ L: 10, through: 9, th: U1TH, club: "BBB", byeOf: U1BYE, sc: { 10: 7 } }).row.teamGames.text, "1 scored game through Week 10");
});
check("C: a settled newer score is not a mixed base: through the cutoff, 'of N' as usual; mixedBase false everywhere else", () => {
  const r = u1({ sc: sc([3]), newerFinal: { complete: true } }).row;
  assert.deepEqual([r.mixedBase, r.teamGames.known, r.teamGames.of, r.teamGames.text], [false, 8, 8, "8 of 8 team games"]);
  assert.equal(G0.mixedBase, false); assert.equal(run({ hist: null, club: "BBB" }).row.mixedBase, false);
});
check("C: a stale history says which week the season figures are through", () => {
  const { row } = run({ L: 12, through: 10, club: "BBB", sc: sc([], 12) });
  assert.deepEqual([row.teamGames.of, row.teamGames.text, row.mixedBase, row.seasonThrough], [null, "12 scored games through Week 12", false, 12]);
});
check("U2: unknown game opportunity -> teamGames.of is null and the text has no 'of N'", () => {
  [run({ th: { seg: [["BBB", 4, 10]] }, club: "BBB", sc: sc([9]) }).row, run({ missing: true, club: "BBB" }).row, run({ hist: null, club: "BBB" }).row, run({ conflict: true, club: "BBB" }).row,
   run({ club: "ZZZ", sc: sc([9]) }).row].forEach((r) => { assert.equal(r.teamGames.of, null); assert.ok(!/ of /.test(r.teamGames.text), r.teamGames.text); assert.match(r.teamGames.text, /scored games?$/); });
  assert.equal(run({ hist: null, club: "BBB", sc: { 1: 5 } }).row.teamGames.text, "1 scored game");
});
check("U2: 'of N' is shown only when every week up to the cutoff is established", () => {
  assert.equal(run({ club: "BBB", sc: sc([9]) }).row.teamGames.text, "9 of 9 team games");
  const r = run({ th: { seg: [["AAA", 1, 5], ["BBB", 7, 10]] }, club: "BBB", byeOf: { AAA: 6, BBB: 6 }, sc: sc([6]) }).row;                 // week 6: candidates both on a bye -> established
  assert.equal(r.teamGames.of, 9);
  const u = run({ th: { seg: [["AAA", 1, 5], ["BBB", 7, 10]] }, club: "BBB", byeOf: { AAA: 6, BBB: 8 }, sc: sc([8]) }).row;                // week 6: AAA bye / BBB game -> unclear
  assert.equal(u.teamGames.of, null);
});
check("U2 reason 1: identity unknown before a first record (opportunity unknown too)", () => {
  const c = cov(run({ th: { seg: [["BBB", 4, 10]] }, club: "BBB", sc: sc([9]) }).row, 2); assert.deepEqual([c.identity, c.opportunity], ["unknown_before_first_record", "unknown"]); assert.match(c.note, /Before his first weekly record/);
});
check("U2 reason 2: one of two clubs after a move; identity unknown but opportunity may be known (all had a game / all on a bye)", () => {
  const game = cov(run({ th: { seg: [["AAA", 1, 3], ["BBB", 5, 10]] }, club: "BBB", byeOf: { AAA: 7, BBB: 8 }, sc: sc([8]) }).row, 4), diff = cov(run({ th: { seg: [["AAA", 1, 3], ["BBB", 5, 10]] }, club: "BBB", byeOf: { AAA: 4, BBB: 8 }, sc: sc([8]) }).row, 4);
  assert.deepEqual([game.identity, game.opportunity], ["one_of_two_clubs", "known"]); assert.deepEqual([diff.identity, diff.opportunity], ["one_of_two_clubs", "unknown"]);
  assert.match(game.note, /AAA or BBB/); assert.match(game.note, /all with a game/); assert.match(diff.note, /games differ/);
});
check("U2 reason 3: no evidence (missing, or no club) is its own identity reason", () => {
  assert.equal(run({ missing: true, club: "BBB" }).row.coverage[0].identity, "no_evidence"); assert.equal(run({ club: "" }).row.coverage[0].identity, "no_evidence");
});
check("U2 reason 4: conflict is its own identity reason", () => { assert.equal(run({ conflict: true, club: "BBB" }).row.coverage[0].identity, "conflict"); });
check("U2 separates identity from opportunity: a known club that is not in byeOf has known identity, unknown opportunity", () => {
  const { row } = run({ club: "ZZZ", sc: sc([9]) });
  assert.deepEqual([row.coverage[0].identity, row.coverage[0].opportunity], ["known", "unknown"]); assert.equal(row.teamGames.of, null); assert.ok(row.strip.every((c) => c.kind !== "bye"));
});
check("coverage groups consecutive weeks with the same reason, in order, covering weeks 1..cutoff exactly once", () => {
  const { row } = run({ th: { seg: [["BBB", 4, 6], ["BBB", 8, 8], ["CCC", 9, 9]] }, club: "CCC", byeOf: { BBB: 7, CCC: 7 }, sc: sc([7]) });
  let next = 1; row.coverage.forEach((c) => { assert.equal(c.fromWeek, next); next = c.toWeek + 1; }); assert.equal(next, 11);
  assert.deepEqual(row.coverage.map((c) => [c.fromWeek, c.toWeek, c.grade]), [[1, 3, "before_first"], [4, 6, "confirmed"], [7, 7, "bracketed"], [8, 9, "confirmed"], [10, 10, "continuation"]]);
});

// ===========================================================================================================================
console.log("4  today's club is never a historical week");
const src = fs.readFileSync(SRC, "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
check("static: ES5 only, no network/DOM/clock in clubhist.js, and MFL's club is read from `clubs` in exactly one place", () => {
  assert.ok(!/=>/.test(code), "arrow function"); assert.ok(!/`/.test(code), "template string"); assert.ok(!/\b(let|const|class)\s/.test(code), "let/const/class");
  assert.ok(!/\b(fetch|XMLHttpRequest|document|localStorage|Promise|async|await)\b/.test(code) && !/\bwindow\.|new Date|Date\./.test(code), "forbidden global");
  assert.equal((code.match(/(?<![.\w])clubs\[/g) || []).length, 1);          // (ne.clubs[...] is the caller's newerFinal map, not the roster club)
  assert.ok(src.split("\n").length < 500, "under 500 lines");
});
check("static: the current club (`cur`) reaches a week only through gradeOf (continuation or candidates) and the nochange grade", () => {
  const bad = code.split("\n").filter((l) => /\bcur\b/.test(l)).filter((l) => !/(function gradeOf|function weekInfo|nochange|e\.cur|hasCur|\bcur &&|cur ===|cur \? |cl\.indexOf\(cur\)|cl\.push\(cur\)|club\(clubs\[id\]\)|newerIncluded|weekInfo\(c, x, e, cur|gradeOf\(w, e, cur\)|cur: |var cur)/.test(l));
  assert.deepEqual(bad, []);
});
// a tiny independent invariant checker used by the mutation and fuzz tests
const KNOWN_GRADES = ["confirmed", "bracketed", "continuation", "nochange"];
function invariants(input, out) {
  const bad = [];
  for (const id of input.ids) {
    const r = out.rows[id]; if (!r) { bad.push(id + ": no row"); continue; }
    const e = out.state === "ok" && input.hist.teamHistory[id], inList = out.state === "ok" && (input.hist.teamHistoryMissing.includes(id) || input.hist.teamHistoryConflict.includes(id));
    if (out.state !== "ok" && (r.coverage.length || r.teamGames.of !== null || r.window || r.strip.some((c) => c.kind === "bye" || c.kind === "newer"))) bad.push(id + ": identity used while unavailable");
    if (out.state === "ok" && !inList && !e) {                                  // no change seen
      if (r.cls === "nochange" ? !input.clubs[id] || input.clubs[id] === "FA" : r.coverage.some((c) => KNOWN_GRADES.includes(c.grade))) bad.push(id + ": nochange without a club");
    }
    if (r.cls === "missing" || r.cls === "conflict" || r.cls === "none") if (r.teamGames.of !== null || r.window || r.strip.some((c) => c.kind === "bye") || r.coverage.some((c) => c.identity === "known")) bad.push(id + ": identity for " + r.cls);
    r.coverage.forEach((c) => {
      if (c.identity === "known" && !KNOWN_GRADES.includes(c.grade)) bad.push(id + ": known identity from grade " + c.grade);
      if (c.grade === "confirmed") for (let w = c.fromWeek; w <= c.toWeek; w++) if (!(e && e.seg.some((s) => s[1] <= w && w <= s[2]))) bad.push(id + ": confirmed outside a segment");
      if (c.grade === "continuation") { const last = e.seg[e.seg.length - 1], mine = input.clubs[id] || ""; if (!(c.fromWeek > last[2] && (e.cur ? e.cur === last[0] && (!mine || mine === "FA" || mine === last[0]) : mine === last[0]))) bad.push(id + ": continuation without last club = MFL club"); }
      if (c.grade === "nochange" && !(c.toWeek <= out.cutoff)) bad.push(id + ": nochange past the cutoff");
      if (c.grade === "candidates" && c.identity !== "one_of_two_clubs") bad.push(id + ": candidates with identity");
      if (c.grade === "before_first" && (c.identity === "known" || c.opportunity !== "unknown")) bad.push(id + ": before first record resolved");
    });
    r.strip.forEach((c) => {
      if (c.kind === "bye") { const cv = r.coverage.find((x) => x.fromWeek <= c.week && c.week <= x.toWeek); if (!cv || cv.identity !== "known" || cv.opportunity !== "known") bad.push(id + ": BYE without known identity at week " + c.week); if (c.score !== null) bad.push("bye with a score"); }
      if (c.kind === "newer" && !(out.state === "ok" && c.week > out.cutoff)) bad.push(id + ": newer at or below the cutoff");
    });
    if (r.cls === "nochange" && input.hist.teamHistoryFirst[id] && r.coverage.some((c) => c.grade === "nochange" && c.fromWeek < input.hist.teamHistoryFirst[id])) bad.push(id + ": no-change weeks before his first row");
    if (out.state === "ok" && r.cmp.state === "shown") for (let w = out.cutoff + 1; w <= out.latestFinal; w++) {       // a shown comparison never rests on an unsettled newer score
      const sv = input.scores[w] && input.scores[w][id], ne = input.newerFinal, cc = input.clubs[id];
      if (typeof sv === "number" && !(ne && (ne.complete === true || (cc && typeof ne.clubs[cc] === "boolean")))) bad.push(id + ": shown with an unsettled newer score");
    }
    if (r.mixedBase && (r.teamGames.of !== null || r.cmp.state === "shown" || (r.teamGames.known !== null && (/ of /.test(r.teamGames.text) || !/through Week \d+$/.test(r.teamGames.text))))) bad.push(id + ": mixed base misreported");
    if (r.teamGames.known !== null && out.cutoff !== null && r.seasonThrough !== null && r.seasonThrough !== out.cutoff && !/through Week/.test(r.teamGames.text)) bad.push(id + ": season through another week, text silent");
    if (out.state === "ok" && out.cutoff >= out.latestFinal && r.cmp.state === "shown" && input.newerFinal && input.newerFinal.complete === false) {      // a live score at L is settled or absent
      const sv = input.scores[out.latestFinal] && input.scores[out.latestFinal][id], cc = input.clubs[id];
      if (typeof sv === "number" && !(cc && typeof input.newerFinal.clubs[cc] === "boolean")) bad.push(id + ": shown with an unsettled latest-week score");
    }
    r.strip.forEach((c) => { if (c.kind === "live" && c.week !== out.latestFinal) bad.push(id + ": live cell outside week L"); });
    if (r.cmp.state === "shown" && !(r.window && r.window.weeks.length && r.recentN >= 2 && r.earlierN >= 4)) bad.push(id + ": shown without its minimums");
  }
  return bad;
}
check("mutation: when history is absent, malformed, stale, missing or conflicting, the roster club changes NOTHING in the row", () => {
  const cases = [
    { hist: null }, { hist: { ...mkHist(10), teamHistory: [] } }, { L: 12, through: 10 }, { missing: true }, { conflict: true },
    { hist: { teamHistoryState: "unavailable", teamHistoryReason: "crosswalk_suspect", teamHistoryThrough: null, teamHistory: {}, teamHistoryMissing: [], teamHistoryConflict: [] } }];
  cases.forEach((o, i) => {
    const sets = ["AAA", "BBB", "CCC", "ZZZ", "", "FA"].map((club) => run({ ...o, club, sc: o.L ? sc([9], 12) : sc([9]) }).row);
    sets.forEach((r) => assert.deepEqual(r, sets[0], "case " + i + ": the row depends on today's club"));
    assert.ok(sets[0].strip.every((c) => c.kind !== "bye"));
  });
});
check("mutation: for a player with a segment history, weeks up to his last record do not depend on today's club", () => {
  const th = { seg: [["AAA", 1, 3], ["BBB", 5, 7]] };
  const covs = ["AAA", "BBB", "CCC", "ZZZ", "", "FA"].map((club) => run({ th, club, byeOf: { AAA: 4, BBB: 9, CCC: 5, ZZZ: 6 }, sc: sc([9]) }).row.coverage.filter((c) => c.toWeek <= 7));
  covs.forEach((c) => assert.deepEqual(c, covs[0]));
});
check("mutation: a current club that differs from the last record is never the identity of a later week", () => {
  const rows = ["CCC", "AAA", "ZZZ"].map((club) => run({ th: { seg: [["AAA", 1, 5], ["BBB", 6, 8]] }, club, byeOf: { AAA: 3, BBB: 9, CCC: 9, ZZZ: 9 } }).row);
  rows.forEach((r) => { assert.ok(r.coverage.filter((c) => c.fromWeek >= 9).every((c) => c.identity !== "known")); assert.ok(r.strip.every((c) => c.kind !== "bye")); });
});
// seeded fuzz
function rng(seed) { return () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
check("fuzz (2000 random leagues of 30 players): no row ever breaks an evidence invariant, and nothing throws", () => {
  const rnd = rng(20261121), pick = (a) => a[Math.floor(rnd() * a.length)];
  const CL = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"];
  let problems = [], rowsSeen = 0;
  for (let it = 0; it < 2000; it++) {
    const L = 6 + Math.floor(rnd() * 9), through = Math.max(1, L - pick([0, 0, 0, 1, 2, 3])); const th = {}, missing = [], conflict = [], first = {}, clubs = {}, season = {}, ids = [], scores = {};
    const newerFinal = pick([undefined, { complete: true }, { complete: false, clubs: { AAA: true, BBB: false, CCC: true } }, { complete: false, clubs: {} }]);
    const byeOf = {}; CL.forEach((c) => { if (rnd() < 0.85) byeOf[c] = 1 + Math.floor(rnd() * 14); });
    const loaded = []; for (let w = Math.max(1, L - 3); w <= L; w++) if (rnd() < 0.9) { loaded.push(w); scores[w] = {}; }
    for (let p = 0; p < 30; p++) {
      const id = "p" + p; ids.push(id); clubs[id] = pick(CL.concat(["", "FA"]));
      let total = 0, games = 0; for (let w = 1; w <= L; w++) if (rnd() < 0.8) { const v = Math.round(rnd() * 300) / 10 - 2; total += v; games++; if (scores[w]) scores[w][id] = v; }
      if (games && rnd() < 0.95) season[id] = { total: Math.round(total * 1e6) / 1e6, games };
      const k = rnd();
      if (through > 1 && rnd() < 0.3) first[id] = 2 + Math.floor(rnd() * (through - 1));
      if (k < 0.1) missing.push(id); else if (k < 0.15) conflict.push(id);
      else if (k < 0.5) { const seg = []; let w = 1 + Math.floor(rnd() * 3); while (w <= through && seg.length < 4) { const to = Math.min(through, w + Math.floor(rnd() * 5)); seg.push([pick(CL), w, to]); w = to + 1 + Math.floor(rnd() * 2); } if (seg.length) th[id] = rnd() < 0.3 ? { seg, cur: pick(CL) } : { seg }; }
    }
    const hist = mkHist(through, th, missing, conflict, first), input = { through, latestFinal: L, hist, clubs, byeOf, season, scores, ids, newerFinal }, out = C.evaluate(input);
    rowsSeen += ids.length; problems = problems.concat(invariants(input, out));
    if (problems.length) break;
  }
  assert.deepEqual(problems.slice(0, 5), []); assert.equal(rowsSeen, 60000);
});

// ===========================================================================================================================
console.log("helpers");
check("clubByeMap: one bye per club; disagreeing or invalid byes omit the club; FA and blank clubs are skipped; numeric strings accepted", () => {
  const m = C.clubByeMap([{ club: "KCC", bye: "5" }, { club: "KCC", bye: 5 }, { club: "DAL", bye: "14" }, { club: "DAL", bye: "13" }, { club: "ARI", bye: "" }, { club: "ARI", bye: "14" },
    { club: "BUF", bye: 19 }, { club: "NYJ", bye: 13.5 }, { club: "FA", bye: "" }, { club: "", bye: 3 }, { club: "PHI", bye: 10 }]);
  assert.deepEqual(m, { KCC: 5, PHI: 10 });
  assert.deepEqual(C.clubByeMap(null), {});
});
check("roundHalfUp1: one decimal, halves up, mirrored for negatives, never -0", () => {
  const cases = [[0.05, 0.1], [0.15, 0.2], [0.25, 0.3], [0.45, 0.5], [1.005, 1], [6.35, 6.4], [10.04, 10], [-0.05, -0.1], [-0.04, 0], [-1.25, -1.3], [0, 0], [12.34, 12.3]];
  cases.forEach(([x, y]) => assert.equal(C.roundHalfUp1(x), y, x + " -> " + y));
  assert.ok(Object.is(C.roundHalfUp1(-0.04), 0)); assert.equal(C.roundHalfUp1(NaN), null); assert.equal(C.roundHalfUp1(null), null);
});
check("logFor: the strip weeks with byeKnown and recorded; 0.0 recorded, missing not; never an opponent", () => {
  const { input } = run({ club: "BBB", sc: { ...sc([9]), 8: 0 } });
  const log = C.logFor(input, "p1");
  assert.deepEqual(log, [{ week: 7, kind: "score", score: 10.7, byeKnown: false, recorded: true }, { week: 8, kind: "score", score: 0, byeKnown: false, recorded: true },
    { week: 9, kind: "bye", score: null, byeKnown: true, recorded: false }, { week: 10, kind: "score", score: 11, byeKnown: false, recorded: true }]);
  log.forEach((c) => assert.ok(!("opponent" in c) && !("opp" in c)));
  assert.deepEqual(C.logFor(Object.assign({}, input, { hist: null }), "p1")[2], { week: 9, kind: "none", score: null, byeKnown: false, recorded: false });
  assert.deepEqual(C.logFor(input, "nobody"), C.logFor(input, "nobody")); assert.equal(C.logFor(input, "p1").length, 4);
});

// ===========================================================================================================================
console.log("5  golden master: real 2026 data through Week 10");
const PL = GOLD.players, IDS = Object.keys(PL);
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const SEASON10 = {}, LOADED = { 7: {}, 8: {}, 9: {}, 10: {} }, CLUBS = {};
IDS.forEach((id) => {
  let t = 0, g = 0; CLUBS[id] = PL[id].club;
  for (const w in PL[id].scores) { t += PL[id].scores[w]; g++; if (LOADED[w]) LOADED[w][id] = PL[id].scores[w]; }
  if (g) SEASON10[id] = { total: r6(t), games: g };
});
const BYEOF = C.clubByeMap(GOLD.rosterClubBye.map(([club, bye]) => ({ club, bye })));
const GBASE = { through: 10, latestFinal: 10, hist: GOLD.hist, clubs: CLUBS, byeOf: BYEOF, season: SEASON10, scores: LOADED, ids: IDS };
const AM = C.evaluate(GBASE);
// "baseline" = today's club for every week, with NO conflict detection. The phone never does this (it would flag Allen, Bates, Cousins, Downs
// and others as conflicts: a score in the week of today's club's bye), so the baseline is a small independent JS port of the reference's
// `baseline`/`finish` (not the module), used to prove the harness against the Python baseline and to state the 5 documented differences.
const BASE = { rows: {} };
IDS.forEach((id) => {
  const p = PL[id], b = BYEOF[p.club]; if (!p.club || p.club === "FA") return;                      // the reference treats "FA" as a club with no games
  const sc = p.scores, games = []; for (let w = 1; w <= 10; w++) if (w !== b) games.push(w);
  const win = []; for (let w = 10; w >= 1 && win.length < 3; w--) if (w !== b) win.push(w); win.reverse();
  const inw = win.filter((w) => w in sc).map((w) => sc[w]), earlier = Object.keys(sc).map(Number).filter((w) => w < win[0]).map((w) => sc[w]), n = Object.keys(sc).length;
  const last4 = [7, 8, 9, 10].filter((w) => w in sc).length, mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  let reason = "shown";
  if (n < 2 || last4 < 2) reason = "recent_scores_lt_2"; else if (n < 6) reason = "earlier_scores_lt_4"; else if (inw.length < 2) reason = "recent_scores_lt_2"; else if (earlier.length < 4) reason = "earlier_scores_lt_4";
  const shown = reason === "shown";
  BASE.rows[id] = { cmp: { state: shown ? "shown" : "withheld", reason }, window: { weeks: win }, recent: shown ? mean(inw) : null, earlier: shown ? mean(earlier) : null, difference: shown ? mean(inw) - mean(earlier) : null,
    recentN: inw.length, earlierN: earlier.length, scoredGames: n, teamGames: { known: n, of: games.length, text: n + " of " + games.length + " team games" } };
});
const FIRST = GOLD.hist.teamHistoryFirst;                                                       // W1's teamHistoryFirst: first weekly-row week of no-change players

const refCat = (c) => c === "shown" ? "shown" : c.startsWith("insufficient: fewer than 2") ? "recent_scores_lt_2" : c.startsWith("insufficient: fewer than 4") ? "earlier_scores_lt_4"
  : c.includes("unavailable") ? "team_history_unavailable" : c.includes("unclear") ? "club_game_unclear" : "records_conflict";
// Python's round() works on the binary double, so an exact .x5 tie can land on either side; half-up (the league's convention) is what the phone uses
const isTie = (x) => Math.abs(x * 10 - Math.floor(x * 10) - 0.5) < 1e-6;
const sameRounded = (raw, ref) => { const mine = C.roundHalfUp1(raw); return Math.abs(mine - ref) < 1e-9 || (isTie(raw) && Math.abs(Math.abs(mine - ref) - 0.1) < 1e-9); };
const sameWeeks = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const FA2 = IDS.filter((id) => !PL[id].club || PL[id].club === "FA");

check("fixture sanity: 485 rostered scoring-position players, 444 no change seen / 10 changed / 8 missing / 23 with no scores", () => {
  assert.equal(IDS.length, 485); const n = {}; IDS.forEach((id) => { n[AM.rows[id].cls] = (n[AM.rows[id].cls] || 0) + 1; });
  assert.deepEqual(n, { nochange: 444, changed: 10, missing: 8, none: 23 });
  assert.equal(GOLD.hist.teamHistoryThrough, 10); assert.equal(AM.state, "ok"); assert.equal(AM.banner.text, "Comparison through Week 10");
});
check("byeOf derived from the roster read equals the bye weeks derived from the 18 weekly nflSchedule reads, for all 32 clubs", () => {
  const sched = GOLD.byeSched, clubsS = Object.keys(sched).filter((c) => c !== "FA");         // MFL's nflSchedule also lists a placeholder "FA" team with no games
  assert.equal(clubsS.length, 32); assert.deepEqual(Object.keys(BYEOF).sort(), clubsS.sort());
  clubsS.forEach((c) => { assert.equal(sched[c].length, 1, c + " has one bye"); assert.equal(BYEOF[c], sched[c][0], c); });
});
check("season totals: the 4 loaded weeks + season totals reproduce the full-season scores; live lineup-matchups playerWindow runs through Week 11 (22 players differ through Week 10, 0 through Week 11)", () => {
  let diff10 = 0, diff11 = 0, without = 0;
  IDS.forEach((id) => {
    const p = PL[id], live = p.live; let t = 0, g = 0; for (const w in p.scores) { t += p.scores[w]; g++; }
    if (!live) { without++; assert.equal(g, 0, p.name + " has scores but no live window"); return; }
    if (live.games !== g || Math.abs(live.total - t) > 0.051) diff10++;
    const t11 = t + (p.w11 ?? 0), g11 = g + (p.w11 === null || p.w11 === undefined ? 0 : 1);
    if (live.games !== g11 || Math.abs(live.total - t11) > 0.051) diff11++;
  });
  assert.deepEqual([without, diff10, diff11], [23, 22, 0]);
});
check("(a) season average and scored games identical to the reference for all 485 (baseline and amended)", () => {
  IDS.forEach((id) => {
    const r = AM.rows[id], ref = PL[id].amend;
    assert.equal(r.scoredGames, SEASON10[id] ? ref.G : null, PL[id].name); assert.equal(PL[id].base.G, ref.G);          // 23 players have no season entry: unavailable (null), not 0 assert.equal(PL[id].base.season, ref.season);       // season figures are club-independent
    if (ref.season === null) assert.equal(r.seasonAvg, null, PL[id].name); else assert.ok(sameRounded(r.seasonAvg, ref.season), PL[id].name + " " + r.seasonAvg + " vs " + ref.season);
    const t = SEASON10[id]; if (t) near(AM.rows[id].seasonAvg, t.total / t.games);
  });
});
check("(a) BASELINE (today's club for every week; the test's own port, see BASE): state, window, numbers and team-game count identical to the Python baseline for 483 players (two free agents excepted)", () => {
  assert.deepEqual(FA2.map((id) => PL[id].name).sort(), ["Hill, Tyreek", "Rice, Brenden"]);
  let n = 0;
  IDS.forEach((id) => {
    if (FA2.includes(id)) return;                                             // the reference treats "FA" as a club with no games; the phone has no club for a free agent (no identity)
    const r = BASE.rows[id], ref = PL[id].base, raw = PL[id].rawBase; n++;
    assert.equal(r.cmp.reason, refCat(ref.cmp), PL[id].name + " " + ref.cmp);
    if (r.cmp.state === "shown") {
      assert.ok(sameWeeks(r.window.weeks, ref.window), PL[id].name); near(r.recent, raw.recent); near(r.earlier, raw.earlier); assert.equal(r.recentN, ref.rn); assert.equal(r.earlierN, ref.en);
      assert.ok(sameRounded(r.recent, ref.recent) && sameRounded(r.earlier, ref.earlier) && sameRounded(r.difference, ref.delta), PL[id].name);
    }
    assert.equal(r.teamGames.of, ref.T, PL[id].name); assert.equal(r.scoredGames, ref.G);
  });
  assert.equal(n, 483);
});
const AM_SHOWN = IDS.filter((id) => AM.rows[id].cmp.state === "shown");
check("(b) AMENDED rules: comparison state, window and numbers identical to the amended reference for all 485 (window and 'newer' weeks inside the loaded weeks 7-10)", () => {
  IDS.forEach((id) => {
    const r = AM.rows[id], ref = PL[id].amend, raw = PL[id].rawAmend;
    assert.equal(r.cmp.reason, refCat(ref.cmp), PL[id].name + " " + ref.cmp);
    if (r.cmp.state === "shown") {
      assert.ok(sameWeeks(r.window.weeks, ref.window), PL[id].name); assert.equal(r.recentN, ref.rn); assert.equal(r.earlierN, ref.en);
      near(r.recent, raw.recent); near(r.earlier, raw.earlier); near(r.difference, raw.recent - raw.earlier);
      assert.ok(sameRounded(r.recent, ref.recent) && sameRounded(r.earlier, ref.earlier) && sameRounded(r.difference, ref.delta), PL[id].name);
    } else assert.equal(r.recent, null);
    if (r.cmp.reason === "club_game_unclear") assert.equal(r.cmp.week, Number(ref.cmp.match(/Wk (\d+)/)[1]));
  });
  assert.ok(AM_SHOWN.length > 300);
});
check("(b) no player is withheld for 'score_week_not_loaded' or 'season_unavailable': Weeks 7-10 plus the season totals are enough at gap 0", () => {
  assert.deepEqual(IDS.filter((id) => ["score_week_not_loaded", "season_unavailable"].includes(AM.rows[id].cmp.reason)), []);
});
check("(c) baseline vs amended: exactly 5 players change their displayed comparison (Allen, Hooker, Buckner, Elliott, Klare); the other 480 are identical", () => {
  const shown = (r) => [r.cmp.state, r.cmp.reason, r.recent === null ? null : C.roundHalfUp1(r.recent), r.earlier === null ? null : C.roundHalfUp1(r.earlier), r.difference === null ? null : C.roundHalfUp1(r.difference)].join("|");
  const diff = IDS.filter((id) => !FA2.includes(id) && shown(BASE.rows[id]) !== shown(AM.rows[id])).map((id) => PL[id].name).sort();
  assert.deepEqual(diff, ["Allen, Keenan", "Buckner, DeForest", "Elliott, Keyshaun", "Hooker, Amani", "Klare, Max"]);
});
const byName = (n) => IDS.find((id) => PL[id].name === n);
const fig = (r) => r.cmp.state === "shown" ? [r.window.weeks, C.roundHalfUp1(r.recent), C.roundHalfUp1(r.earlier), C.roundHalfUp1(r.difference)] : r.cmp.reason;
check("(c) the 5 differing players: exact baseline and amended outputs from the scope", () => {
  const a = byName("Allen, Keenan"), h = byName("Hooker, Amani"), b = byName("Buckner, DeForest");
  assert.deepEqual(fig(BASE.rows[a]), [[7, 9, 10], 9.1, 11.4, -2.2]); assert.deepEqual(fig(AM.rows[a]), [[8, 9, 10], 11.5, 10.7, 0.8]);
  assert.equal(AM.rows[a].scoredGames, 9); assert.equal(AM.rows[a].teamGames.text, "9 of 10 team games"); assert.equal(BASE.rows[a].teamGames.text, "9 of 9 team games");     // SFO's Week 8 bye was an IND game
  assert.deepEqual(fig(BASE.rows[h]).slice(1), [16.2, 10.9, 5.3]);
  assert.equal(AM.rows[h].cmp.reason, "club_game_unclear"); assert.equal(AM.rows[h].cmp.week, 9); assert.equal(AM.rows[h].teamGames.of, null); assert.equal(AM.rows[h].teamGames.text, "8 scored games");
  assert.deepEqual([BASE.rows[b].recent, BASE.rows[b].earlier, BASE.rows[b].difference].map(C.roundHalfUp1), [3.2, 8.8, -5.6]);
  assert.equal(AM.rows[b].cmp.reason, "club_game_unclear"); assert.equal(AM.rows[b].cmp.week, 8); assert.equal(AM.rows[b].teamGames.of, null); assert.equal(AM.rows[b].teamGames.text, "9 scored games");
  ["Elliott, Keyshaun", "Klare, Max"].forEach((n) => {
    const id = byName(n), bs = BASE.rows[id], am = AM.rows[id];
    assert.deepEqual([bs.cmp.state, bs.recent, bs.earlier, bs.difference], ["shown", 0, 0, 0]);               // "0.0 vs 0.0 shown from recorded zero-stat weeks"
    assert.equal(am.cmp.reason, "team_history_unavailable"); assert.equal(am.cmp.text, "Team history unavailable"); assert.equal(am.cls, "missing");
    assert.ok(am.scoredGames > 0 && am.range.hi === 0);                                                           // scores and averages still shown
  });
});
check("team-game counts: with teamHistoryFirst, 'of N' equals the reference's team-game count for all 485 and is null exactly where the reference says 'unclear' (the 69 first-row players included)", () => {
  assert.equal(IDS.filter((id) => FIRST[id]).length, 69); assert.ok(Object.keys(FIRST).length > 400);         // 503 in the replay, 69 on UPS rosters
  IDS.forEach((id) => {
    const T = PL[id].amend.T, r = AM.rows[id];
    assert.equal(r.teamGames.of, typeof T === "number" ? T : null, PL[id].name + " " + T);
    if (typeof T === "string") assert.match(r.teamGames.text, SEASON10[id] ? /^-?\d+ scored games?$/ : /^Scored games unavailable$/);
  });
  IDS.filter((id) => FIRST[id]).forEach((id) => { assert.equal(AM.rows[id].cls, "nochange"); assert.equal(AM.rows[id].teamGames.of, null); assert.equal(AM.rows[id].coverage[0].identity, "unknown_before_first_record"); });
});
check("without teamHistoryFirst the whole hist is malformed (the phone ships only with the W1 that sends it)", () => {
  const h = { ...GOLD.hist }; delete h.teamHistoryFirst; const o = C.evaluate({ ...GBASE, hist: h });
  assert.deepEqual([o.state, o.reason], ["unavailable", "malformed"]); assert.ok(IDS.every((id) => o.rows[id].cmp.reason !== "shown" && o.rows[id].teamGames.of === null));
});
check("team-game count text: 'known' is the scored-game count and 'of' the team games; Bates, Cousins, Downs change 9 -> 10 on club evidence", () => {
  [["Bates, Jessie", 9, 10], ["Cousins, Kirk", 10, 10], ["Downs, Josh", 10, 10]].forEach(([n, known, of]) => {
    const id = byName(n); assert.deepEqual([AM.rows[id].teamGames.known, AM.rows[id].teamGames.of, AM.rows[id].teamGames.text], [known, of, known + " of " + of + " team games"], n);
  });
  assert.equal(BASE.rows[byName("Bates, Jessie")].teamGames.of, 9); assert.equal(BASE.rows[byName("Cousins, Kirk")].teamGames.of, 9); assert.equal(BASE.rows[byName("Downs, Josh")].teamGames.of, 9);
  ["Giddens, DJ", "Richardson, Anthony", "Charbonnet, Zach"].forEach((n) => { const id = byName(n); assert.ok(FIRST[id] > 1, n); assert.equal(AM.rows[id].teamGames.of, null, n); assert.match(AM.rows[id].teamGames.text, /scored games?$/); });
});
check("controls that changed clubs but are unaffected (Simmons, Harrison Jr., Brissett) match in every comparison field; Simmons and Harrison draw BYE where the club is known", () => {
  ["Simmons, Jeffery", "Harrison Jr., Marvin", "Brissett, Jacoby"].forEach((n) => { const id = byName(n); assert.equal(JSON.stringify(fig(BASE.rows[id])), JSON.stringify(fig(AM.rows[id])), n); assert.equal(AM.rows[id].cmp.state, "shown"); });
  assert.deepEqual(fig(AM.rows[byName("Simmons, Jeffery")]), [[7, 8, 9], 10.7, 11.7, -1]);
  assert.equal(AM.rows[byName("Simmons, Jeffery")].strip.find((c) => c.week === 10).kind, "bye");            // CHI's Week 10 bye, continuation grade
  assert.deepEqual(fig(AM.rows[byName("Harrison Jr., Marvin")]).slice(1), [6, 5.7, 0.3]); assert.deepEqual(AM.rows[byName("Harrison Jr., Marvin")].window.weeks, [7, 9, 10]);
  assert.equal(cov(AM.rows[byName("Harrison Jr., Marvin")], 5).identity, "one_of_two_clubs"); assert.equal(cov(AM.rows[byName("Harrison Jr., Marvin")], 8).identity, "known");
});
check("Flacco: the Week 1 zero is a scored game and resolves no club or team-game opportunity (real data and a hand-made regression)", () => {
  const id = byName("Flacco, Joe"), r = AM.rows[id];
  assert.deepEqual(PL[id].scores, { 1: 0, 7: 0, 10: 0 }); assert.equal(r.cls, "missing");
  assert.equal(r.scoredGames, 3); assert.equal(r.teamGames.of, null); assert.equal(r.teamGames.text, "3 scored games");
  assert.deepEqual([r.coverage[0].fromWeek, r.coverage[0].identity, r.coverage[0].opportunity], [1, "no_evidence", "unknown"]);
  assert.equal(r.cmp.reason, "earlier_scores_lt_4"); assert.equal(r.range.lo, 0);
  // hand-made: a recorded 0.0 in Week 1, his first weekly record is Week 3
  const h = run({ th: { seg: [["BBB", 3, 10]] }, club: "BBB", sc: { ...sc([9]), 1: 0 } }).row;
  assert.equal(h.scoredGames, 9); assert.equal(cov(h, 1).identity, "unknown_before_first_record"); assert.equal(cov(h, 1).opportunity, "unknown"); assert.equal(h.teamGames.of, null);
  assert.equal(h.teamGames.text, "9 scored games");
});
check("Ferguson and Bigsby: 0.0 and a missing score are different things in the log; BYE only for a known club", () => {
  const jf = C.logFor({ ...GBASE, ids: [byName("Ferguson, Jake")] }, byName("Ferguson, Jake")), tb = C.logFor({ ...GBASE }, byName("Bigsby, Tank")), tf = C.logFor({ ...GBASE }, byName("Ferguson, Terrance"));
  assert.deepEqual(jf.map((c) => [c.week, c.kind, c.score, c.recorded]), [[7, "score", 0, true], [8, "score", 0, true], [9, "score", 11.5, true], [10, "none", null, false]]);   // two real zeros, then no score
  assert.deepEqual(tb.map((c) => [c.week, c.kind, c.score, c.byeKnown]), [[7, "none", null, false], [8, "none", null, false], [9, "none", null, false], [10, "bye", null, true]]);   // PHI's Week 10 bye
  assert.deepEqual(tf.map((c) => c.kind), ["none", "none", "none", "none"]);
  const noHist = C.logFor({ ...GBASE, hist: null }, byName("Bigsby, Tank")); assert.ok(noHist.every((c) => c.kind === "none" && !c.byeKnown));         // without W1 the BYE label disappears
});
check("range: the low and high of the recorded scores in the loaded weeks", () => {
  const r = AM.rows[byName("Cousins, Kirk")].range; assert.deepEqual([r.lo, r.hi, r.fromWeek, r.toWeek, r.n], [13, 36.3, 7, 10, 4]);
});

// ===========================================================================================================================
console.log("6b full-season game log");
const FULL = {}; for (let w = 1; w <= 10; w++) { FULL[w] = {}; IDS.forEach((id) => { if (PL[id].scores[w] !== undefined) FULL[w][id] = PL[id].scores[w]; }); }
const LOGIN = { ...GBASE, scores: FULL };
const brief = (log) => log.map((c) => [c.week, c.kind, c.score, c.byeKnown]);
check("weeksNeeded: the strip weeks and the full-season log weeks", () => {
  assert.deepEqual(C.weeksNeeded({ latestFinal: 10 }), { strip: [7, 8, 9, 10], log: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }); assert.deepEqual(C.weeksNeeded({ latestFinal: 2 }), { strip: [1, 2], log: [1, 2] });
  assert.deepEqual(C.weeksNeeded({}), { strip: [], log: [] });
});
check("logFor default (no opts) is still the strip weeks; opts select any range", () => {
  const id = byName("Ferguson, Jake"); assert.deepEqual(C.logFor(LOGIN, id).map((c) => c.week), [7, 8, 9, 10]); assert.deepEqual(C.logFor(LOGIN, id, {}).map((c) => c.week), [7, 8, 9, 10]);
  assert.deepEqual(C.logFor(LOGIN, id, { fromWeek: 3, toWeek: 5 }).map((c) => c.week), [3, 4, 5]); assert.deepEqual(C.logFor(LOGIN, id, { fromWeek: 5, toWeek: 3 }), []);
  assert.deepEqual(C.logFor(LOGIN, id, { fromWeek: 1 }).map((c) => c.week), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});
check("full 1..L log, Ferguson (Jake, TE): real zeros are scores, the missing Week 10 is 'none'", () => {
  const log = C.logFor(LOGIN, byName("Ferguson, Jake"), { fromWeek: 1, toWeek: 10 });
  assert.deepEqual(brief(log), [[1, "score", 3.6, false], [2, "score", 22.9, false], [3, "score", 11, false], [4, "score", 5.8, false], [5, "score", 6.6, false], [6, "score", 5.3, false],
    [7, "score", 0, false], [8, "score", 0, false], [9, "score", 11.5, false], [10, "none", null, false]]);
  assert.deepEqual(log.filter((c) => c.week >= 7).map((c) => c.recorded), [true, true, true, false]);
});
check("full 1..L log, Bigsby (Tank, RB): scores, then missing weeks 'none', then PHI's Week 10 BYE with known identity", () => {
  const log = C.logFor(LOGIN, byName("Bigsby, Tank"), { fromWeek: 1, toWeek: 10 });
  assert.deepEqual(brief(log), [[1, "score", 1.6, false], [2, "score", 12.8, false], [3, "score", -0.7, false], [4, "score", 6.1, false], [5, "none", null, false], [6, "none", null, false],
    [7, "none", null, false], [8, "none", null, false], [9, "none", null, false], [10, "bye", null, true]]);
});
check("full 1..L log, Simmons (Jeffery, DT) and Harrison Jr.: BYE weeks only where the club is known (continuation / bracketed); a gap between two clubs is 'none'", () => {
  const sim = C.logFor(LOGIN, byName("Simmons, Jeffery"), { fromWeek: 1, toWeek: 10 });
  assert.deepEqual(sim.map((c) => c.kind), ["score", "score", "score", "score", "score", "score", "score", "score", "score", "bye"]); assert.equal(sim[9].byeKnown, true);
  const har = C.logFor(LOGIN, byName("Harrison Jr., Marvin"), { fromWeek: 1, toWeek: 10 });
  assert.deepEqual(har.map((c) => c.kind), ["score", "score", "score", "score", "none", "score", "score", "bye", "score", "none"]);              // Week 5: one of two clubs, no BYE; Week 8: bracketed HOU bye
  assert.deepEqual([har[4].byeKnown, har[7].byeKnown, har[7].score], [false, true, null]);
  har.forEach((c) => assert.ok(!("opponent" in c) && !("opp" in c)));
});
check("full log: a week absent from input.scores is 'unloaded', never 'none'; a loaded week with no score is 'none'", () => {
  const partial = { ...LOGIN, scores: { 7: FULL[7], 8: FULL[8], 9: FULL[9], 10: FULL[10] } };
  const jake = C.logFor(partial, byName("Ferguson, Jake"), { fromWeek: 1, toWeek: 10 });
  assert.deepEqual(jake.map((c) => c.kind), ["unloaded", "unloaded", "unloaded", "unloaded", "unloaded", "unloaded", "score", "score", "score", "none"]);
  assert.ok(jake.slice(0, 6).every((c) => c.score === null && c.recorded === false && c.byeKnown === false));
  const bigsby = C.logFor(partial, byName("Bigsby, Tank"), { fromWeek: 1, toWeek: 10 }); assert.equal(bigsby[0].kind, "unloaded"); assert.equal(bigsby[8].kind, "none"); assert.equal(bigsby[9].kind, "bye");
  const nothing = C.logFor({ ...LOGIN, scores: {} }, byName("Ferguson, Jake"), { fromWeek: 1, toWeek: 10 }); assert.ok(nothing.every((c) => c.kind === "unloaded"));
});
check("full log: a live Week L score is kind 'live' with the score carried; final or unsettled is a plain score; no live without newerFinal.complete === false", () => {
  const id = byName("Ferguson, Jake"), w10 = { ...FULL, 10: { ...FULL[10], [id]: 4.2 } };
  const mk = (nf) => C.logFor({ ...LOGIN, scores: w10, newerFinal: nf }, id, { fromWeek: 8, toWeek: 10 })[2];
  assert.deepEqual(mk({ complete: false, clubs: { DAL: false } }), { week: 10, kind: "live", score: 4.2, byeKnown: false, recorded: true });
  [undefined, { complete: true }, { complete: false, clubs: { DAL: true } }, { complete: false, clubs: {} }].forEach((nf) => assert.equal(mk(nf).kind, "score"));
  assert.equal(C.logFor({ ...LOGIN, scores: w10, newerFinal: { complete: false, clubs: { DAL: false } } }, id, { fromWeek: 1, toWeek: 9 }).filter((c) => c.kind === "live").length, 0);
});
check("full log: weeks above the cutoff are 'newer' (score carried); nothing above the cutoff is a BYE; unavailable history gives no BYE anywhere", () => {
  const { input } = u1({ sc: { ...sc([3]), 10: 7.7 }, newerFinal: { complete: true }, loaded: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
  const log = C.logFor(input, "p1", { fromWeek: 1, toWeek: 10 });
  assert.deepEqual(log.slice(0, 3).map((c) => c.kind), ["score", "score", "bye"]); assert.deepEqual(log[9], { week: 10, kind: "newer", score: 7.7, byeKnown: false, recorded: true });
  const bye15 = u1({ sc: sc([3]), byeOf: { AAA: 3, BBB: 10 }, newerFinal: { complete: true } }).input; assert.equal(C.logFor(bye15, "p1", { fromWeek: 10, toWeek: 10 })[0].kind, "newer");
  assert.ok(C.logFor({ ...input, hist: null }, "p1", { fromWeek: 1, toWeek: 10 }).every((c) => c.kind !== "bye" && c.kind !== "newer"));
  assert.equal(C.logFor({ ...input, loaded: undefined, scores: { 1: { p1: 5 } } }, "p1", { fromWeek: 9, toWeek: 10 }).every((c) => c.kind === "unloaded"), true);      // absent newer weeks: unloaded
});

console.log("7  speed");
check("evaluate for 485 players takes well under 200 ms in node", () => {
  C.evaluate(GBASE); const t0 = process.hrtime.bigint(); for (let i = 0; i < 5; i++) C.evaluate(GBASE); const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 5;
  assert.ok(ms < 200, ms + " ms"); console.log("       (" + ms.toFixed(1) + " ms per evaluate)");
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
