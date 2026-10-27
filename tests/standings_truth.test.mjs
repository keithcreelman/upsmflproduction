// Regular-season standings truth (worker/src/standings_truth.js):
//   - seeding inputs rebuilt from weekly rows, regular-season weeks only;
//   - the F3 playoff-flag ruling applied at the source;
//   - MFL standingsSort for division order, H2H step included, PTS = season points.
//   node scripts/safe_tests/run.mjs --only standings_truth
//
// Each "bug" case re-creates a known failure and shows the old logic gets it wrong.
import fs from "node:fs";
import { test, t, run } from "./fixtures/mini_test.mjs";
import { playoffFlag, regularSeasonTotals, divisionOrder, seedCurrentSeason } from "../worker/src/standings_truth.js";
import { seedLadderSteps, modernField } from "../worker/src/seeding.js";
import { weeklySeason } from "./fixtures/standings_d1.mjs";

const REC = JSON.parse(fs.readFileSync(new URL("./fixtures/standings_2026_wk5.json", import.meta.url), "utf8"));
const FIDS = REC.franchises.map((f) => f.franchise_id);
const DIV = Object.fromEntries(REC.franchises.map((f) => [f.franchise_id, f.division]));
const NAME = Object.fromEntries(REC.franchises.map((f) => [f.franchise_id, f.franchise_name]));
const totals = (over) => regularSeasonTotals({
  franchiseIds: FIDS, divisionOf: DIV, weeklyScores: REC.weekly_scores, games: REC.games,
  lastRegularSeasonWeek: REC.lastRegularSeasonWeek, ...(over || {}),
});

// The seed field from totals, exactly as the route builds it: division winners by MFL standingsSort,
// then the §F.1 ladder.
function field(tot) {
  const rows = FIDS.map((f) => ({
    franchise_id: f, franchise_name: NAME[f], division: DIV[f],
    allplay_pct: tot.teams[f].ap.pct, h2h_pct: tot.teams[f].overall.pct, pf_total: tot.teams[f].pf,
    overall_pct: tot.teams[f].overall.pct, div_pct: tot.teams[f].div.pct,
  }));
  const winners = new Set();
  for (const d of new Set(Object.values(DIV))) {
    winners.add(divisionOrder(rows.filter((r) => r.division === d), tot.games, REC.standingsSort).order[0].franchise_id);
  }
  const games = tot.games.map((g) => ({ franchise_id: g.a, opponent_franchise_id: g.b, team_score: g.ts, opponent_score: g.os }));
  const ladder = seedLadderSteps(rows, games);
  const f = modernField(rows, winners, ladder.cmp);
  return { seeds: [...f.byes, ...f.seeds3to6].map((r) => r.franchise_id), outside: f.outside.map((r) => r.franchise_id), ladder, rows };
}

test("playoff flags: only 0/'0'/false and 1/'1'/true are recognized", () => {
  for (const v of [0, "0", false]) t.equal(playoffFlag(v), 0);
  for (const v of [1, "1", true]) t.equal(playoffFlag(v), 1);
  for (const v of [null, undefined, "", "x", 2, "00", "true", "false", NaN]) t.equal(playoffFlag(v), null);
});

test("recorded 2026 Week 5: totals equal MFL's leagueStandings for all 12 teams", () => {
  const tot = totals();
  t.equal(tot.status, "ok"); t.equal(tot.throughWeek, 5);
  for (const m of REC.mfl_leagueStandings) {
    const x = tot.teams[m.id];
    t.equal(x.overall.w, Number(m.h2hw)); t.equal(x.overall.l, Number(m.h2hl));
    t.equal(x.div.w, Number(m.divw)); t.equal(x.div.l, Number(m.divl));
    t.equal(Math.round(x.pf * 10) / 10, Number(m.pf));
    t.equal(`${x.ap.w}-${x.ap.l}-${x.ap.t}`, m.all_play_wlt);
  }
});

test("recorded 2026 Week 5: the seeds, recomputed independently of the route", () => {
  const f = field(totals());
  // C-Town, Blake (byes); HammerTime, Real Deal Creel (division winners); CBP, Pure Greatness (wild cards).
  t.deepEqual(f.seeds, ["0009", "0010", "0005", "0008", "0002", "0004"]);
  t.equal(f.outside[0], "0012");                                  // Hawks: next team out
  const byId = Object.fromEntries(f.rows.map((r) => [r.franchise_id, r]));
  // Creel and CBP tie at 32-23 All-Play; Overall (9-4 vs 7-6) separates them.
  t.equal(f.ladder.decidingStep(byId["0008"], byId["0002"]), "overall");
  t.equal(f.ladder.decidingStep(byId["0004"], byId["0012"]), "all_play");
});

test("bug: sorting by record or per-game PF instead of seed gives a different order", () => {
  const f = field(totals());
  const all = [...f.seeds, ...f.outside];
  // Mobile on main: division winners, then overall %, then the per-game PF average.
  const tot = totals();
  const avg = (fid) => tot.games.filter((g) => g.a === fid).reduce((s, g) => s + g.ts, 0) / tot.teams[fid].games;
  const winners = new Set(f.seeds.slice(0, 4).filter((fid) => fid !== "0002" && fid !== "0004"));
  const mobile = FIDS.slice().sort((a, b) => (winners.has(b) - winners.has(a)) || (tot.teams[b].overall.pct - tot.teams[a].overall.pct) || (avg(b) - avg(a)));
  t.notEqual(mobile.join(","), all.join(","));
  // Gride (.291 All-Play) is ahead of The Long Haulers (.255) on the ladder; the old sort flips them.
  t.ok(all.indexOf("0003") < all.indexOf("0006"));
  t.ok(mobile.indexOf("0006") < mobile.indexOf("0003"));
});

test("playoff weeks never reach the seeding inputs (bug: the live sync folds them in)", () => {
  const base = field(totals());
  // Append a playoff week where the 7th-12th teams post huge scores.
  const extraScores = FIDS.map((f, i) => ({ week: 15, franchise_id: f, team_score: base.outside.includes(f) ? 400 : 100 + i, team_opt_pts: 0, is_playoff: 1 }));
  const extraGames = [["0012", "0009"], ["0011", "0010"]].flatMap(([a, b]) => [
    { week: 15, franchise_id: a, opponent_franchise_id: b, team_score: 400, opponent_score: 100, is_playoff: 1 },
    { week: 15, franchise_id: b, opponent_franchise_id: a, team_score: 100, opponent_score: 400, is_playoff: 1 }]);
  const tot = totals({ weeklyScores: [...REC.weekly_scores, ...extraScores], games: [...REC.games, ...extraGames] });
  t.equal(tot.status, "ok");
  t.deepEqual(field(tot).seeds, base.seeds);
  // The old way: count every played week as the sync does -- Hawks' 400 lifts them past Pure Greatness.
  const naive = totals({ weeklyScores: [...REC.weekly_scores, ...extraScores].map((r) => ({ ...r, is_playoff: 0 })), games: [...REC.games, ...extraGames].map((g) => ({ ...g, is_playoff: 0 })), lastRegularSeasonWeek: 17 });
  t.notEqual(field(naive).seeds.join(","), base.seeds.join(","));
});

test("F3: preseason only when the expected franchises' input is genuinely empty", () => {
  t.equal(totals({ weeklyScores: [], games: [] }).status, "preseason");
  // Foreign rows only (another league's ids): still preseason.
  const foreign = [{ week: 1, franchise_id: "9999", team_score: 100, is_playoff: "x" }];
  t.equal(totals({ weeklyScores: foreign, games: [] }).status, "preseason");
});

test("F3: a nonempty input with only playoff rows is NOT preseason", () => {
  const onlyPlayoff = FIDS.map((f) => ({ week: 15, franchise_id: f, team_score: 120, is_playoff: true }));
  const r = totals({ weeklyScores: onlyPlayoff, games: [] });
  t.equal(r.status, "incomplete");
  t.ok(r.problems.some((p) => p.code === "no_regular_season_rows"));
});

test("F3: a malformed flag makes the table incomplete; the row is reported, not dropped into preseason", () => {
  for (const bad of [null, undefined, "x", 2, "00"]) {
    const ws = REC.weekly_scores.map((r) => (r.week === 3 && r.franchise_id === "0001" ? { ...r, is_playoff: bad } : r));
    const r = totals({ weeklyScores: ws });
    t.equal(r.status, "incomplete");
    t.ok(r.problems.some((p) => p.code === "malformed_playoff_flag" && p.week === 3 && p.franchise_id === "0001"));
  }
  // Every malformed row: still incomplete (the old client turned "nothing left" into preseason).
  const allBad = totals({ weeklyScores: REC.weekly_scores.map((r) => ({ ...r, is_playoff: "x" })), games: REC.games.map((g) => ({ ...g, is_playoff: null })) });
  t.equal(allBad.status, "incomplete");
  // A malformed flag on the opponent side of a game that involves our franchise still counts.
  const g = REC.games.map((x, i) => (i === 0 ? { ...x, franchise_id: "9999", is_playoff: "x" } : x));
  t.equal(totals({ games: g }).status, "incomplete");
});

test("F3: unrelated foreign-franchise rows don't poison valid data", () => {
  const ws = [...REC.weekly_scores, { week: 2, franchise_id: "9998", team_score: 50, is_playoff: "garbage" }];
  const gs = [...REC.games, { week: 2, franchise_id: "9998", opponent_franchise_id: "9997", team_score: 50, opponent_score: 40, is_playoff: null }];
  const r = totals({ weeklyScores: ws, games: gs });
  t.equal(r.status, "ok");
  t.deepEqual(field(r).seeds, field(totals()).seeds);
});

test("contradictory or missing weekly data is incomplete, with the reason", () => {
  const noWk3 = totals({ weeklyScores: REC.weekly_scores.filter((r) => r.week !== 3) });
  t.equal(noWk3.status, "incomplete");
  t.ok(noWk3.problems.some((p) => p.code === "week_gap" && p.week === 3));
  const missingTeam = totals({ weeklyScores: REC.weekly_scores.filter((r) => !(r.week === 4 && r.franchise_id === "0007")) });
  t.ok(missingTeam.problems.some((p) => p.code === "missing_week_score" && p.week === 4 && p.franchise_id === "0007"));
  // 2012 Week 13 in reverse: a regular-season week flagged playoff.
  const flagged = totals({ weeklyScores: REC.weekly_scores.map((r) => (r.week === 5 ? { ...r, is_playoff: 1 } : r)) });
  t.ok(flagged.problems.some((p) => p.code === "playoff_flag_in_regular_week" && p.week === 5));
  // The same team-week twice with two different scores: no guess about which is right.
  const dup = totals({ weeklyScores: [...REC.weekly_scores, { week: 2, franchise_id: "0005", team_score: 1, team_opt_pts: 0, is_playoff: 0 }] });
  t.equal(dup.status, "incomplete");
  t.ok(dup.problems.some((p) => p.code === "conflicting_score" && p.week === 2 && p.franchise_id === "0005"));
  // An identical duplicate is harmless.
  const same = REC.weekly_scores.find((r) => r.week === 2 && r.franchise_id === "0005");
  t.equal(totals({ weeklyScores: [...REC.weekly_scores, { ...same }] }).status, "ok");
  t.equal(totals({ weeklyScores: null }).status, "incomplete");
  t.equal(totals({ lastRegularSeasonWeek: null }).status, "incomplete");
});

test("division order: MFL's H2H step decides a PCT + DIVPCT tie (the route skipped it)", () => {
  // A and B tie 6-4 overall and 2-2 in the division; A won 3 of 5 against B; B scored more.
  const rows = [
    { franchise_id: "0001", franchise_name: "A", overall_pct: 0.6, div_pct: 0.5, pf_total: 1000, allplay_pct: 0.5 },
    { franchise_id: "0002", franchise_name: "B", overall_pct: 0.6, div_pct: 0.5, pf_total: 1100, allplay_pct: 0.6 },
    { franchise_id: "0003", franchise_name: "C", overall_pct: 0.3, div_pct: 0.5, pf_total: 900, allplay_pct: 0.3 },
  ];
  // Each game from both sides, as src_schedule stores it.
  const games = [["0001", "0002", 3], ["0002", "0001", 2]].flatMap(([w, l, n]) => Array.from({ length: n }, () => [
    { a: w, b: l, ts: 120, os: 100 }, { a: l, b: w, ts: 100, os: 120 }]).flat());
  const { order, steps } = divisionOrder(rows, games, "PCT,DIVPCT,H2H,PTS,ALL_PLAY_PCT,PWR");
  t.deepEqual(order.map((r) => r.franchise_name), ["A", "B", "C"]);
  t.equal(steps[0].step, "H2H");
  // The route's comparator (PCT, DIVPCT, PTS, ...; H2H skipped) crowns B.
  const old = rows.slice().sort((x, y) => (y.overall_pct - x.overall_pct) || (y.div_pct - x.div_pct) || (y.pf_total - x.pf_total));
  t.equal(old[0].franchise_name, "B");
});

test("division order on 2026 Week 5: Cleon over Hawks on division record (both 6-7)", () => {
  const tot = totals();
  const rows = ["0009", "0011", "0012"].map((f) => ({ franchise_id: f, franchise_name: NAME[f], overall_pct: tot.teams[f].overall.pct, div_pct: tot.teams[f].div.pct, pf_total: tot.teams[f].pf, allplay_pct: tot.teams[f].ap.pct }));
  const { order, steps } = divisionOrder(rows, tot.games, REC.standingsSort);
  t.deepEqual(order.map((r) => r.franchise_id), ["0009", "0011", "0012"]);
  t.deepEqual(steps.map((s) => s.step), ["PCT", "DIVPCT"]);
});

// A generated two-week season. Base score for franchise i is 100 + 10*i (0012 scores most).
//   0005/0006 swap scores between the weeks: same All-Play (9-13), same PF; both 1-1; 0006 beat 0005 -> head-to-head.
//   0004 wins both its (non-division) games, so it -- not 0005/0006 -- wins Division B.
//   Division D plays no games: 0012 wins it on points; 0011 (2nd-best All-Play) is a wild card.
const DIVS = { "0001": "A", "0002": "A", "0003": "A", "0004": "B", "0005": "B", "0006": "B", "0007": "C", "0008": "C", "0009": "C", "0010": "D", "0011": "D", "0012": "D" };
const scores = (over) => Object.fromEntries(Object.keys(DIVS).map((f) => [f, (over && over[f]) ?? 100 + 10 * Number(f)]));
function gen(weeks) {
  const s = weeklySeason({ weeks, divisions: DIVS });
  return seedCurrentSeason({ franchises: s.franchises, weeklyScores: s.weeklyScores, games: s.games, lastRegularSeasonWeek: 14, standingsSort: "PCT,DIVPCT,H2H,PTS,ALL_PLAY_PCT,PWR", ladder: { seedLadderSteps, modernField } });
}

test("seedCurrentSeason: head-to-head decides a tie on All-Play, record and points (generated season)", () => {
  const f = gen([
    { week: 1, scores: scores({ "0005": 150, "0006": 160 }), games: [["0005", "0006"], ["0004", "0003"]] },
    { week: 2, scores: scores({ "0005": 160, "0006": 150 }), games: [["0005", "0001"], ["0006", "0012"], ["0004", "0002"]] },
  ]);
  t.equal(f.status, "ok");
  const a = f.teams["0005"], b = f.teams["0006"];
  t.deepEqual([a.regular_season.all_play.w, b.regular_season.all_play.w], [9, 9]);
  t.equal(a.regular_season.points_for, b.regular_season.points_for);
  t.deepEqual([a.regular_season.record.w, a.regular_season.record.l, b.regular_season.record.w, b.regular_season.record.l], [1, 1, 1, 1]);
  t.ok(b.order_index < a.order_index, "0006 (won the game) ranks ahead");
  t.deepEqual([a.seed_reason.vs_above.franchise_id, a.seed_reason.vs_above.step], ["0006", "head_to_head"]);
  t.ok(f.teams["0004"].is_division_leader && !b.is_division_leader && !a.is_division_leader);
});

test("seedCurrentSeason: a better non-winner sits below the 2nd seed because a bye needs a division title", () => {
  const f = gen([
    { week: 1, scores: scores({ "0005": 150, "0006": 160 }), games: [["0005", "0006"], ["0004", "0003"]] },
    { week: 2, scores: scores({ "0005": 160, "0006": 150 }), games: [["0005", "0001"], ["0006", "0012"], ["0004", "0002"]] },
  ]);
  t.equal(f.teams["0012"].playoff_seed, 1);
  t.equal(f.teams["0009"].playoff_seed, 2);
  t.equal(f.teams["0011"].playoff_status, "wild_card");
  t.ok(f.teams["0011"].regular_season.all_play.w > f.teams["0009"].regular_season.all_play.w, "the wild card has the better All-Play");
  t.equal(f.teams["0011"].playoff_seed, 3);
  t.deepEqual([f.teams["0011"].seed_reason.vs_above.franchise_id, f.teams["0011"].seed_reason.vs_above.step], ["0009", "bye_requires_division_title"]);
});

test("seedCurrentSeason: points for decides when All-Play and record tie and they never met", () => {
  const f = gen([
    { week: 1, scores: scores({ "0005": 150, "0006": 165 }), games: [["0005", "0001"], ["0006", "0012"], ["0004", "0003"]] },
    { week: 2, scores: scores({ "0005": 165, "0006": 152 }), games: [["0005", "0012"], ["0006", "0001"], ["0004", "0002"]] },
  ]);
  const a = f.teams["0005"], b = f.teams["0006"];
  t.equal(a.regular_season.all_play.w, b.regular_season.all_play.w);
  t.ok(b.regular_season.points_for > a.regular_season.points_for);
  t.deepEqual([a.seed_reason.vs_above.franchise_id, a.seed_reason.vs_above.step], ["0006", "points_for"]);
});

test("seedCurrentSeason: incomplete data gives no seeds, no leaders, no order claim", () => {
  const s = weeklySeason({ weeks: [{ week: 1, scores: scores(), games: [["0001", "0002"]] }], divisions: DIVS });
  s.weeklyScores[3].is_playoff = "x";
  const f = seedCurrentSeason({ franchises: s.franchises, weeklyScores: s.weeklyScores, games: s.games, lastRegularSeasonWeek: 14, standingsSort: "PCT,DIVPCT,H2H,PTS", ladder: { seedLadderSteps, modernField } });
  t.equal(f.status, "incomplete");
  t.deepEqual(f.teams, {});
  t.ok(f.problems.some((p) => p.code === "malformed_playoff_flag"));
});

test("recorded 2026 Week 5 through seedCurrentSeason: the verified field, games back and reasons", () => {
  const f = seedCurrentSeason({ franchises: REC.franchises, weeklyScores: REC.weekly_scores, games: REC.games, lastRegularSeasonWeek: 14, standingsSort: REC.standingsSort, ladder: { seedLadderSteps, modernField } });
  t.deepEqual(f.order.slice(0, 7), ["0009", "0010", "0005", "0008", "0002", "0004", "0012"]);
  t.equal(f.next_out, "0012");
  t.equal(f.teams["0012"].ap_back, 2);                       // Hawks 29 All-Play wins, Pure Greatness 31
  t.equal(f.teams["0002"].seed_reason.vs_above.step, "overall");   // CBP below Real Deal Creel: same All-Play, worse record
  t.equal(f.teams["0012"].division_games_back, 5);             // Hawks 6-7 vs C-Town 11-2
  t.deepEqual([f.teams["0012"].division_reason.vs_above.franchise_id, f.teams["0012"].division_reason.vs_above.step], ["0011", "DIVPCT"]);   // Hawks below Cleon: both 6-7, division 0-4 vs 4-0
  t.equal(f.teams["0011"].division_reason.vs_above.step, "PCT");
  t.equal(f.complete, false); t.equal(f.throughWeek, 5);
});

test("seed history: the order after Week 4 is the one published after Week 4 (#1197), and movement is relative to it", () => {
  const f = seedCurrentSeason({ franchises: REC.franchises, weeklyScores: REC.weekly_scores, games: REC.games, lastRegularSeasonWeek: 14, standingsSort: REC.standingsSort, ladder: { seedLadderSteps, modernField } });
  // #1197's Week 4 (Elias-final) table: Bear Dunn, Eric Martel, Shawn Blake, Derrick Whitman, Chris Klingenberg,
  // Keith Creelman, Eric Mannila, Brian Cutting, ... = C-Town, HammerTime, Blake, CBP, Hawks, Creel, Cleon, Pure Greatness.
  t.deepEqual(f.seed_by_week[4].slice(0, 8), ["0009", "0005", "0010", "0002", "0012", "0008", "0011", "0004"]);
  t.deepEqual(f.seed_by_week[5], f.order);
  t.equal(f.teams["0008"].order_change, 2);     // Real Deal Creel 6th -> 4th
  t.equal(f.teams["0012"].order_change, -2);    // Hawks 5th -> 7th
  t.equal(Object.keys(f.seed_by_week).length, 5);
});

await run("standings_truth");
