// Boom / Bust / Startable against the UPS starter pool (worker/src/starter_rates.js).
//   node tests/starter_rates.test.mjs
// Oracle: tests/fixtures/starter_rates_cases.json — the 2026-10-10 reference
// model (Python), cross-checked by a second implementation: unit cases, a
// synthetic league with ties / small pools / no-shows / a played-zero starter,
// and 23 real players' 2026 Wks 1-4 weeks with the real starter pools.
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { quantile, thresholdsFor, label, classify, rate, computeStarterRates, tenths } from "../worker/src/starter_rates.js";

const C = JSON.parse(fs.readFileSync("tests/fixtures/starter_rates_cases.json", "utf8"));
const near = (a, b) => (a == null && b == null) || Math.abs(a - b) < 1e-9;

test("linear (R-7) quantiles on tenths", () => {
  for (const q of C.quantile_cases) {
    for (const p of ["p25", "p50", "p75"]) t.ok(near(quantile(q.sorted_tenths, { p25: 0.25, p50: 0.5, p75: 0.75 }[p]), q[p]), JSON.stringify(q.sorted_tenths) + " " + p);
  }
});

test("labels: reaches = ≥, at or below = ≤, and a median week is never a Bust", () => {
  for (const c of C.label_cases) {
    const L = label(c.score_tenths, c);
    t.deepEqual([L.boom, L.bust, L.startable], [c.boom, c.bust, c.startable], JSON.stringify(c));
  }
});

test("played / no-snap / bye / no-game", () => {
  const ctx = C.classify_context;
  for (const c of C.classify_cases) t.deepEqual(classify(c.input, ctx.teams_with_game, ctx.bye_week), [c.class, c.why], JSON.stringify(c.input));
});

test("rates round half up and need 3 qualifying weeks", () => {
  for (const c of C.rate_cases) t.equal(rate(c.n, c.q), c.pct, `${c.n}/${c.q}`);
});

const pick = (p) => ({ qualifying_weeks: p.q, startable_n: p.startable_n, boom_n: p.boom_n, bust_n: p.bust_n,
  startable_pct: p.startable_pct, boom_pct: p.boom_pct, bust_pct: p.bust_pct, no_snap_n: p.no_snap_n, bye_n: p.bye_n,
  no_game_n: p.no_game_n, started_n: p.started_n, started_played_n: p.started_played_n, started_no_show_n: p.started_no_show_n,
  played_zero_n: p.played_zero_n, played_unscored_n: p.played_unscored_n, pool_too_small_n: p.pool_too_small_n,
  week_labels: p.wk.map((w) => w[2]) });
const strip = (e) => { const o = { ...e }; delete o.weeks_label; delete o.ppg; return o; };

test("synthetic league (oracle, played zeros kept in the pool): thresholds, no-shows, every player", () => {
  const e = C.end_to_end;
  const out = computeStarterRates(e.rows, { final_weeks: e.final_weeks, teams_with_game: e.teams_with_game, bye_week: e.bye_week }, { zeros: "pool" });
  for (const [k, v] of Object.entries(e.expected_thresholds)) {
    const [w, g] = k.split("|"), got = out.thresholds[w][g];
    t.deepEqual([got.n, got.p25 == null ? null : got.p25 * 10, got.p50 == null ? null : got.p50 * 10, got.p75 == null ? null : got.p75 * 10],
      [v.n, v.p25, v.p50, v.p75], k);
  }
  t.deepEqual(out.started_no_shows.map((x) => [x.mfl_id, x.week, x.class]), e.expected_no_shows.map((x) => [x.mfl_id, x.week, x.class]));
  t.deepEqual(out.started_played_zero.map((x) => [x.mfl_id, x.week]), e.expected_played_zero.map((x) => [x.mfl_id, x.week]));
  for (const [pid, exp] of Object.entries(e.expected_players)) t.deepEqual(pick(out.players[pid]), strip(exp), pid);
  t.equal(out.weeks_label, "Wks 1–4");
});

test("Keith's default: a started 0.0 is kept OUT of the thresholds and listed separately (not hidden from his own record)", () => {
  const e = C.end_to_end;
  const out = computeStarterRates(e.rows, { final_weeks: e.final_weeks, teams_with_game: e.teams_with_game, bye_week: e.bye_week });
  t.equal(out.zeros, "exclude");
  t.equal(out.thresholds["1"].WR.n, e.expected_thresholds["1|WR"].n - 1, "Wk 1 pool loses the played zero");
  t.deepEqual(out.started_played_zero.map((x) => x.mfl_id), ["ZERO"], "listed separately");
  t.equal(out.thresholds["1"].WR.p50, null, "this synthetic Wk 1 drops to 5 played starters: below the 6-starter minimum, no thresholds");
  t.equal(out.players.ZERO.wk[0][2], "pool_too_small", "…so his Wk 1 isn't graded at all rather than graded against a distorted pool");
  t.equal(out.thresholds["2"].WR.p50, C.end_to_end.expected_thresholds["2|WR"].p50 / 10, "weeks without a played zero are unchanged");
});

test("real 2026 Wks 1-4: every starter pool's thresholds, and 23 players' weeks", () => {
  const r = C.real_2026;
  for (const [k, pool] of Object.entries(r.pools_tenths)) {
    const got = thresholdsFor(pool), exp = r.thresholds_tenths[k];
    t.deepEqual([got.n, got.p25, got.p50, got.p75], [exp.n, exp.p25, exp.p50, exp.p75], k);
  }
  // Each player measured against the REAL pools (rows of the rest of the league are not needed: the thresholds are fixed).
  for (const [pid, p] of Object.entries(r.players)) {
    const labels = p.rows.map((row) => {
      const [c] = classify(row, r.teams_with_game, r.bye_week);
      if (c !== "played") return c + (row.started ? "_started" : "");
      const score = row.mfl_score == null ? (row.rostered ? 0 : null) : row.mfl_score;
      if (score == null) return "played_unscored";
      const th = r.thresholds_tenths[row.week + "|" + row.group];
      if (th.p50 == null) return "pool_too_small";
      const L = label(tenths(score), th);
      return L.boom ? "boom" : L.bust ? "bust" : L.startable ? "startable" : "below_median";
    });
    t.deepEqual(labels, p.expected.week_labels, p.name);
  }
});

await run("starter_rates");
