// UPS playoff-seeding ladder (worker/src/seeding.js) -- canon §F.1/§F.2:
// All-Play % -> Overall -> Points For -> head-to-head.
//   node tests/ups_seeding_ladder.test.mjs
//
// The OLD comparators below are copied verbatim (as logic) from worker/src/index.js
// before this fix (main 5f3a9b3d), so each case shows what changed:
//   OLD_STANDINGS -- /api/standings seedTiebreak: AP%, per-game PF average, Overall.
//   OLD_BRACKET   -- /api/playoff-bracket division winners, seeds 3-6, seeds 7-12:
//                    AP%, PF, name (no Overall at all).
import fs from "fs";
import assert from "assert";
import { seedLadder, modernField, legacyStandingsTiebreak } from "../worker/src/seeding.js";

let fails = 0;
const check = (name, fn) => {
  try { fn(); console.log("  ok   " + name); }
  catch (e) { fails++; console.log("  FAIL " + name + "\n         " + e.message); }
};
const desc = (a, b) => Number(b || 0) - Number(a || 0);
const txt = (a, b) => String(a || "").localeCompare(String(b || ""));
const OLD_STANDINGS = (a, b) => desc(a.allplay_pct, b.allplay_pct) || desc(a.pf, b.pf) ||
  desc(a.h2h_pct, b.h2h_pct) || txt(a.franchise_name, b.franchise_name);
const OLD_BRACKET = (a, b) => desc(a.allplay_pct, b.allplay_pct) || desc(a.pf_total, b.pf_total) ||
  txt(a.franchise_name, b.franchise_name);
const names = (rows) => rows.map((r) => r.franchise_name);
const team = (id, name, ap, ovr, pfTotal, pfAvg) =>
  ({ franchise_id: id, franchise_name: name, allplay_pct: ap, h2h_pct: ovr, pf_total: pfTotal, pf: pfAvg });
const game = (a, b, as, bs) => [
  { franchise_id: a, opponent_franchise_id: b, team_score: as, opponent_score: bs },
  { franchise_id: b, opponent_franchise_id: a, team_score: bs, opponent_score: as }];

console.log("1. Overall decides before Points For");
{
  // Same all-play; A has the better overall record, B scored more.
  const A = team("0001", "A (6-4, 870.0)", 0.5, 0.6, 870.0, 217.5);
  const B = team("0002", "B (4-6, 890.0)", 0.5, 0.4, 890.0, 222.5);
  const cmp = seedLadder([A, B], []);
  check("new ladder: A (better Overall) ranks first", () =>
    assert.deepStrictEqual(names([B, A].sort(cmp)), [A.franchise_name, B.franchise_name]));
  check("old /api/standings put B first (PF before Overall)", () =>
    assert.deepStrictEqual(names([A, B].sort(OLD_STANDINGS)), [B.franchise_name, A.franchise_name]));
  check("old /api/playoff-bracket put B first (no Overall)", () =>
    assert.deepStrictEqual(names([A, B].sort(OLD_BRACKET)), [B.franchise_name, A.franchise_name]));
}

console.log("2. Points For decides when All-Play and Overall tie; season total, not the per-game average");
{
  // Season PF says C; a per-game average over schedule rows would say D.
  const C = team("0003", "C", 0.7727, 0.8, 1016.8, 240.0);
  const D = team("0004", "D", 0.7727, 0.8, 996.5, 250.0);
  const cmp = seedLadder([C, D], []);
  check("season PF decides: C first", () => assert.deepStrictEqual(names([D, C].sort(cmp)), ["C", "D"]));
  check("old /api/standings would have used the per-game average: D first", () =>
    assert.deepStrictEqual(names([C, D].sort(OLD_STANDINGS)), ["D", "C"]));
}

console.log("3. Head-to-head decides only when All-Play, Overall and PF all tie");
{
  const E = team("0005", "E", 0.6, 0.6, 900.0, 225), F = team("0006", "F", 0.6, 0.6, 900.0, 225);
  const cmpF = seedLadder([E, F], [...game("0006", "0005", 201, 200)]);
  check("F beat E head to head -> F first (name order would say E)", () =>
    assert.deepStrictEqual(names([E, F].sort(cmpF)), ["F", "E"]));
  const cmpNone = seedLadder([E, F], []);
  check("no head-to-head games -> deterministic name order", () =>
    assert.deepStrictEqual(names([F, E].sort(cmpNone)), ["E", "F"]));
  const G = team("0007", "G", 0.6, 0.6, 900.1, 225);
  const cmpPf = seedLadder([E, F, G], [...game("0006", "0007", 250, 100)]);
  check("a 0.1 PF edge beats head-to-head: G above F although F beat G (E-F, no game, by name)", () =>
    assert.deepStrictEqual(names([F, E, G].sort(cmpPf)), ["G", "E", "F"]));
  // Three-way tie: H beat I, I beat J, J beat H, and H also beat J once more.
  const H = team("0008", "H", 0.5, 0.5, 800, 0), I = team("0009", "I", 0.5, 0.5, 800, 0), J = team("0010", "J", 0.5, 0.5, 800, 0);
  const g3 = [...game("0008", "0009", 10, 9), ...game("0009", "0010", 10, 9), ...game("0010", "0008", 10, 9),
              ...game("0008", "0010", 10, 9)];
  const cmp3 = seedLadder([H, I, J], g3);
  check("three-way tie ranks on games among the three (H 2-1, I 1-1, J 1-2)", () =>
    assert.deepStrictEqual(names([J, I, H].sort(cmp3)), ["H", "I", "J"]));
}

console.log("4. 2026 after Week 4 (D1 snapshot, Elias-final)");
const fx = JSON.parse(fs.readFileSync("tests/fixtures/standings_2026_wk4_seeding.json", "utf8"));
const rows = fx.rows.map((r) => ({ ...r }));
const owner = Object.fromEntries(rows.map((r) => [r.franchise_name, r.owner_name]));
const owners = (rs) => rs.map((r) => owner[r.franchise_name]);
const cmp = seedLadder(rows, fx.games);
const dw = new Set(rows.filter((r) => r.is_division_leader).map((r) => String(r.franchise_id)));
const field = modernField(rows, dw, cmp);
const order = [...field.byes, ...field.seeds3to6, ...field.outside];
check("Cutting/Mannila/Keith at 22-22: Mannila and Keith (6-4) ahead of Cutting (4-6)", () => {
  const trio = rows.filter((r) => ["Brian Cutting", "Eric Mannila", "Keith Creelman"].includes(r.owner_name)).sort(cmp);
  assert.deepStrictEqual(owners(trio), ["Eric Mannila", "Keith Creelman", "Brian Cutting"]);
});
check("old /api/standings order of the same three: Cutting first (PF avg)", () => {
  const trio = rows.filter((r) => ["Brian Cutting", "Eric Mannila", "Keith Creelman"].includes(r.owner_name)).sort(OLD_STANDINGS);
  assert.deepStrictEqual(owners(trio), ["Brian Cutting", "Keith Creelman", "Eric Mannila"]);
});
check("Bear Dunn over Eric Martel: All-Play and Overall tie, PF 1016.8 to 996.5", () =>
  assert.deepStrictEqual(owners(field.byes), ["Bear Dunn", "Eric Martel"]));
check("seeds 3-6 unchanged: Blake, Whitman (WC), Klingenberg (WC), Keith", () =>
  assert.deepStrictEqual(owners(field.seeds3to6), ["Shawn Blake", "Derrick Whitman", "Chris Klingenberg", "Keith Creelman"]));
check("full 12-team order", () => assert.deepStrictEqual(owners(order), [
  "Bear Dunn", "Eric Martel", "Shawn Blake", "Derrick Whitman", "Chris Klingenberg", "Keith Creelman",
  "Eric Mannila", "Brian Cutting", "Matt Gerardi", "Ryan Bousquet", "Josh Martel", "Brian Cross"]));
check("fixture sanity: 12 teams, 4 division leaders, 60 games seen from both sides", () => {
  assert.strictEqual(rows.length, 12); assert.strictEqual(dw.size, 4); assert.strictEqual(fx.games.length, 120);
});

console.log("5. seasons with recorded final standings keep their previous order");
check("legacyStandingsTiebreak is the pre-fix /api/standings comparator (2026 rows sort identically)", () =>
  assert.deepStrictEqual(owners(rows.slice().sort(legacyStandingsTiebreak)), owners(rows.slice().sort(OLD_STANDINGS))));
check("and it still puts Cutting over Mannila, i.e. it is only for recorded seasons", () => {
  const trio = rows.filter((r) => ["Brian Cutting", "Eric Mannila"].includes(r.owner_name)).sort(legacyStandingsTiebreak);
  assert.deepStrictEqual(owners(trio), ["Brian Cutting", "Eric Mannila"]);
});

console.log("\n" + (fails ? fails + " FAILURE(S)" : "ALL PASS"));
process.exit(fails ? 1 : 0);
