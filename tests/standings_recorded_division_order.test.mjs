// Division leaders for a RECORDED season (worker/src/standings_truth.js storedDivisionOrder), shared by
// /api/standings and /api/playoff-bracket:
//   - PTS is the stored season Points For, never the average of the game rows;
//   - H2H is the regular-season record among the tied teams (playoff rows never count);
//   - a season without game pairings treats H2H as a tie and moves on.
//   node scripts/safe_tests/run.mjs --only standings_recorded_division_order
//
// Fixture: D1 replicas read 2026-10-22 plus MFL's league export (divisions, standingsSort). "2010_after" has #1329
// decision 5 C6+C9 applied offline; the fix and that data correction land together.
import fs from "node:fs";
import { test, t, run } from "./fixtures/mini_test.mjs";
import { storedDivisionOrder } from "../worker/src/standings_truth.js";

const FX = JSON.parse(fs.readFileSync(new URL("./fixtures/standings_recorded_division_order.json", import.meta.url), "utf8"));
const S = FX.seasons;
const leaders = (m) => [...m].filter(([, v]) => v.is_division_leader).map(([fid]) => fid).sort();

// What /api/standings did before this fix: standingsSort tokens compared field by field, H2H skipped, PTS = the
// per-game average of the src_schedule rows.
function oldLeaders(season) {
  const tokens = String(season.standingsSort).split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);
  const field = { PCT: "h2h_pct", DIVPCT: "div_pct", PTS: "pf_avg_game_rows", ALL_PLAY_PCT: "allplay_pct", PWR: "pwr" };
  const out = [];
  for (const d of new Set(season.rows.map((r) => r.division))) {
    const g = season.rows.filter((r) => r.division === d).sort((a, b) => {
      for (const tk of tokens) { const f = field[tk]; if (!f) continue; const x = Number(b[f] || 0) - Number(a[f] || 0); if (x) return x; }
      return 0;
    });
    out.push(g[0].franchise_id);
  }
  return out.sort();
}

test("2010 after C6+C9: LaChapelle (0001) and Roussin (0008) lead; 0001 over 0012 on season Points For", () => {
  const m = storedDivisionOrder(S["2010_after"].rows, S["2010_after"].games, S["2010_after"].standingsSort);
  t.deepEqual(leaders(m), ["0001", "0008"]);
  t.equal(m.get("0001").step_vs_below, "PTS");
  t.equal(m.get("0012").division_rank, 2);
});

test("bug: the old per-game average (2010 game rows are playoff games only) put 0012 atop Division 00", () => {
  const r = Object.fromEntries(S["2010_after"].rows.map((x) => [x.franchise_id, x]));
  t.equal(r["0001"].h2h_pct, r["0012"].h2h_pct);                    // tied at 9-7
  t.ok(r["0001"].pf_total > r["0012"].pf_total);                    // more season points
  t.ok(r["0001"].pf_avg_game_rows < r["0012"].pf_avg_game_rows);    // fewer per playoff game
  t.deepEqual(oldLeaders(S["2010_after"]), ["0008", "0012"]);
});

test("2010 before the data correction: the fix alone does not change the leaders (C9 records are needed)", () => {
  const m = storedDivisionOrder(S["2010_before"].rows, S["2010_before"].games, S["2010_before"].standingsSort);
  t.deepEqual(leaders(m), oldLeaders(S["2010_before"]));
});

test("2012 Division 00: Blake (0010) wins the H2H step 3-1 over 0011, which has more Points For", () => {
  const s = S["2012"];
  const m = storedDivisionOrder(s.rows, s.games, s.standingsSort);
  t.ok(m.get("0010").is_division_leader);
  t.equal(m.get("0010").step_vs_below, "H2H");
  const r = Object.fromEntries(s.rows.map((x) => [x.franchise_id, x]));
  t.ok(r["0011"].pf_total > r["0010"].pf_total);
});

test("bug: season Points For without the H2H step would have crowned 0011 in 2012", () => {
  const s = S["2012"];
  const noH2H = s.standingsSort.split(",").filter((x) => x.trim().toUpperCase() !== "H2H").join(",");
  t.ok(storedDivisionOrder(s.rows, s.games, noH2H).get("0011").is_division_leader);
});

test("no game pairings: H2H is a tie and the next step decides", () => {
  const s = S["2012"];
  const m = storedDivisionOrder(s.rows, [], s.standingsSort);
  t.ok(m.get("0011").is_division_leader);
  t.equal(m.get("0011").step_vs_below, "PTS");
});

test("H2H counts regular-season games only; playoff and unrecognized flags never count", () => {
  const s = S["2012"];
  const extra = [];
  for (const flag of [1, "1", null, "x", 2]) {
    for (let k = 0; k < 4; k++) {
      extra.push({ week: 14, franchise_id: "0011", opponent_franchise_id: "0010", team_score: 200, opponent_score: 100, is_playoff: flag });
      extra.push({ week: 14, franchise_id: "0010", opponent_franchise_id: "0011", team_score: 100, opponent_score: 200, is_playoff: flag });
    }
  }
  t.ok(storedDivisionOrder(s.rows, s.games.concat(extra), s.standingsSort).get("0010").is_division_leader);
});

test("PWR: a stored power rating decides a tie that reaches it; without one the name fallback does", () => {
  const base = { h2h_pct: 0.5, div_pct: 0.5, pf_total: 1000, allplay_pct: 0.5, division: "00" };
  const rows = [
    { ...base, franchise_id: "0001", franchise_name: "Alpha", pwr: 80 },
    { ...base, franchise_id: "0002", franchise_name: "Bravo", pwr: 90 },
  ];
  const m = storedDivisionOrder(rows, [], "PCT,DIVPCT,H2H,PTS,ALL_PLAY_PCT,PWR");
  t.ok(m.get("0002").is_division_leader);
  t.equal(m.get("0002").step_vs_below, "PWR");
  const n = storedDivisionOrder(rows.map((r) => ({ ...r, pwr: null })), [], "PCT,DIVPCT,H2H,PTS,ALL_PLAY_PCT,PWR");
  t.ok(n.get("0001").is_division_leader);
  t.equal(n.get("0001").step_vs_below, "name_after_pwr_unavailable");
});

test("rows without a division are left out; ids are padded", () => {
  const m = storedDivisionOrder([
    { franchise_id: 1, franchise_name: "A", division: "00", h2h_pct: 0.6, div_pct: 0, pf_total: 1, allplay_pct: 0 },
    { franchise_id: "0002", franchise_name: "B", division: null, h2h_pct: 0.9, div_pct: 0, pf_total: 1, allplay_pct: 0 },
  ], [], "PCT");
  t.deepEqual([...m.keys()], ["0001"]);
});

await run("standings_recorded_division_order");
