// UPS playoff ladders (worker/src/seeding.js) -- canon §F.1.2-§F.1.4, Keith's rulings 2026-11-25 (PR #1526):
//   wild cards  All-Play % -> season Points For -> head-to-head (then Power Rank, coin flip: not applied here)
//   seeds 3-6   All-Play % -> season Points For (later steps pending a ruling)
//   seeds 1-2   the two division winners with the best All-Play % (a tie among them: pending a ruling)
// No overall-record step anywhere. The old comparator (OLD_CANON, the 2026-05-15 canon text: All-Play % -> Overall
// -> Points For -> H2H, as worker/src/seeding.js applied it before this change) is kept below as logic so every
// historical case shows what it got wrong.
//   node scripts/safe_tests/run.mjs --only ups_seeding_ladder
//
// History: tests/fixtures/playoff_ladder_history.json (MFL's public exports for 2017, 2020 and 2021: weekly team
// scores, games, the season standings and MFL's own bracket seeds). Week 10 of 2026:
// tests/fixtures/standings_2026_wk10_ladder.json (the daily MFL snapshot the #1526 recording uses). No network, no D1.
import fs from "node:fs";
import { test, t, run } from "./fixtures/mini_test.mjs";
import { playoffLadders, playoffField, modernField, legacyStandingsTiebreak, LADDERS } from "../worker/src/seeding.js";
import { regularSeasonTotals, divisionOrder, seedCurrentSeason } from "../worker/src/standings_truth.js";

const desc = (a, b) => Number(b || 0) - Number(a || 0);
// The comparator this change replaces (all three pools used it).
const OLD_CANON = (a, b) => desc(a.allplay_pct, b.allplay_pct) || desc(a.overall_pct, b.overall_pct) || desc(a.pf_total, b.pf_total) ||
  String(a.franchise_name).localeCompare(String(b.franchise_name));
const oldField = (rows, dw) => modernField(rows, dw, OLD_CANON);
const team = (id, name, ap, ovr, pf) => ({ franchise_id: id, franchise_name: name, allplay_pct: ap, overall_pct: ovr, h2h_pct: ovr, pf_total: pf });
const game = (a, b, as, bs) => [
  { franchise_id: a, opponent_franchise_id: b, team_score: as, opponent_score: bs },
  { franchise_id: b, opponent_franchise_id: a, team_score: bs, opponent_score: as }];
const ids = (rows) => rows.map((r) => r.franchise_id);
const fieldOf = (rows, dwIds, games = []) => playoffField(rows, new Set(dwIds), playoffLadders(rows, games));
const seedsOf = (f) => [...f.byes, ...f.seeds3to6].map((r) => r.franchise_id);

// ── 1. the ladders, one rule at a time ──────────────────────────────────────────────────────────────────────────
test("the ladders as approved: no overall-record step in any pool", () => {
  t.deepEqual(LADDERS.wild_card.steps, ["all_play", "points_for", "head_to_head"]);
  t.deepEqual(LADDERS.seeds3to6.steps, ["all_play", "points_for"]);
  t.deepEqual(LADDERS.bye.steps, ["all_play"]);
  for (const k of Object.keys(LADDERS)) t.ok(!LADDERS[k].steps.includes("overall"), k);
});

test("wild card: level on All-Play -> season Points For decides; the better overall record does not", () => {
  // A: better record, fewer points. B: worse record, more points. Two division winners + 3 non-winners for 2 places.
  const rows = [team("0001", "DW1", 0.9, 0.9, 1000), team("0002", "DW2", 0.8, 0.8, 990),
    team("0003", "A", 0.5, 0.7, 880.0), team("0004", "B", 0.5, 0.3, 880.1), team("0005", "C", 0.6, 0.5, 850)];
  const f = fieldOf(rows, ["0001", "0002"]);
  t.deepEqual(ids(f.wildCards), ["0005", "0004"], "C on All-Play, then B on 0.1 Points For");
  t.deepEqual(ids(f.outside), ["0003"]);
  t.equal(playoffLadders(rows, []).wild_card.decidingStep(rows[3], rows[2]), "points_for");
  t.deepEqual(ids(oldField(rows, new Set(["0001", "0002"])).wildCards), ["0005", "0003"], "the old ladder took A on overall record");
  t.deepEqual(f.unresolved, []);
});

test("wild card: level on All-Play and Points For -> head-to-head between the two", () => {
  const rows = [team("0001", "DW", 0.9, 0.9, 1000), team("0002", "X", 0.6, 0.6, 900), team("0003", "E", 0.5, 0.5, 880), team("0004", "F", 0.5, 0.5, 880)];
  const f = fieldOf(rows, ["0001"], [...game("0004", "0003", 201, 200)]);
  t.deepEqual(ids(f.wildCards), ["0002", "0004"], "F beat E head to head (name order would say E)");
  t.deepEqual(f.unresolved, []);
});

test("wild card: level through head-to-head -> unresolved (Power Rank, then coin flip, are not applied)", () => {
  const rows = [team("0001", "DW", 0.9, 0.9, 1000), team("0002", "X", 0.6, 0.6, 900), team("0003", "E", 0.5, 0.5, 880), team("0004", "F", 0.5, 0.5, 880)];
  const f = fieldOf(rows, ["0001"], [...game("0004", "0003", 201, 200), ...game("0003", "0004", 201, 200)]);
  t.equal(f.unresolved.length, 1);
  // one division winner (seed 1), so X is seed 3 and whichever of E/F holds the wild card is seed 4
  t.deepEqual(f.unresolved[0], { pool: "wild_card", franchise_ids: ["0003", "0004"], seeds: [4], why: "power_rank_coin_flip" });
});

test("wild card: three teams level on All-Play and Points For -> head-to-head among three has no settled method", () => {
  const rows = [team("0001", "DW", 0.9, 0.9, 1000), team("0002", "X", 0.6, 0.6, 900),
    team("0003", "H", 0.5, 0.5, 800), team("0004", "I", 0.5, 0.5, 800), team("0005", "J", 0.5, 0.5, 800)];
  const f = fieldOf(rows, ["0001"], [...game("0003", "0004", 10, 9), ...game("0003", "0005", 10, 9)]);
  t.equal(f.unresolved[0].pool, "wild_card");
  t.equal(f.unresolved[0].why, "head_to_head_3plus");
  t.deepEqual(f.unresolved[0].franchise_ids.sort(), ["0003", "0004", "0005"]);
});

test("seeds 3-6: level on All-Play -> Points For; level on both -> unresolved even if head-to-head would separate them", () => {
  const dw = ["0001", "0002", "0003", "0004"];
  const rows = [team("0001", "D1", 0.9, 0.9, 1000), team("0002", "D2", 0.85, 0.8, 990), team("0003", "D3", 0.6, 0.4, 900),
    team("0004", "D4", 0.5, 0.5, 850), team("0005", "W1", 0.6, 0.8, 899.9), team("0006", "W2", 0.55, 0.5, 800), team("0007", "O", 0.4, 0.4, 700)];
  const f = fieldOf(rows, dw);
  t.deepEqual(ids(f.seeds3to6), ["0003", "0005", "0006", "0004"], "D3 over W1 on 0.1 Points For, not W1's better record");
  t.deepEqual(f.unresolved, []);
  const tied = rows.map((r) => (r.franchise_id === "0005" ? { ...r, pf_total: 900 } : r));
  const g = fieldOf(tied, dw, [...game("0005", "0003", 150, 100)]);
  t.deepEqual(g.unresolved, [{ pool: "seeds3to6", franchise_ids: ["0003", "0005"], seeds: [3, 4], why: "pending_ruling" }]);
});

test("byes: the two division winners with the best All-Play; a wild card with a better All-Play never gets one", () => {
  const dw = ["0001", "0002", "0003", "0004"];
  const rows = [team("0001", "D1", 0.70, 0.9, 1000), team("0002", "D2", 0.66, 0.6, 990), team("0003", "D3", 0.65, 0.95, 980),
    team("0004", "D4", 0.45, 0.5, 850), team("0005", "WC", 0.73, 0.7, 1100), team("0006", "W2", 0.5, 0.5, 800)];
  const f = fieldOf(rows, dw);
  t.deepEqual(ids(f.byes), ["0001", "0002"], "D3's better record does not take the bye (2015 shape)");
  t.deepEqual(ids(f.seeds3to6), ["0005", "0003", "0006", "0004"], "the wild card is seed 3 (2016 shape)");
});

test("byes: two division winners level on All-Play for seed 2 -> unresolved, whatever their Points For", () => {
  const dw = ["0001", "0002", "0003", "0004"];
  const rows = [team("0001", "D1", 0.70, 0.9, 1000), team("0002", "D2", 0.65, 0.6, 990), team("0003", "D3", 0.65, 0.7, 900),
    team("0004", "D4", 0.45, 0.5, 850), team("0005", "W1", 0.6, 0.6, 900), team("0006", "W2", 0.5, 0.5, 800)];
  const f = fieldOf(rows, dw);
  t.deepEqual(f.unresolved, [{ pool: "bye", franchise_ids: ["0002", "0003"], seeds: [2, 3, 4, 5, 6], why: "pending_ruling" }]);
});

test("byes: the top two division winners level on All-Play -> the order of seeds 1 and 2 is unresolved", () => {
  const rows = [team("0001", "D1", 0.70, 0.6, 1000), team("0002", "D2", 0.70, 0.9, 900), team("0003", "D3", 0.6, 0.5, 900), team("0004", "W", 0.5, 0.5, 800)];
  const f = fieldOf(rows, ["0001", "0002", "0003"]);
  t.deepEqual(f.unresolved, [{ pool: "seed_1_2_order", franchise_ids: ["0001", "0002"], seeds: [1, 2], why: "pending_ruling" }]);
});

// ── 2. history: the corrected ladders reproduce MFL's own brackets ────────────────────────────────────────────────
const H = JSON.parse(fs.readFileSync(new URL("./fixtures/playoff_ladder_history.json", import.meta.url), "utf8"));
function season(y) {
  const S = H.seasons[y], fids = S.franchises.map((f) => f.id);
  const weeklyScores = [], games = [];
  for (const [w, sc] of Object.entries(S.weekly_scores)) for (const [fid, ts] of Object.entries(sc)) weeklyScores.push({ week: Number(w), franchise_id: fid, team_score: ts, is_playoff: 0 });
  for (const [w, a, b, as, bs] of S.games) {
    games.push({ week: w, franchise_id: a, opponent_franchise_id: b, team_score: as, opponent_score: bs, is_playoff: 0 });
    games.push({ week: w, franchise_id: b, opponent_franchise_id: a, team_score: bs, opponent_score: as, is_playoff: 0 });
  }
  const divisionOf = Object.fromEntries(S.franchises.map((f) => [f.id, f.division]));
  const tot = regularSeasonTotals({ franchiseIds: fids, divisionOf, weeklyScores, games, lastRegularSeasonWeek: S.last_regular_season_week });
  const name = Object.fromEntries(S.franchises.map((f) => [f.id, f.name]));
  // records: from the games where MFL has them (2020, 2021); 2017's weeklyResults carry no matchups, so its records are MFL's season standings
  const rec = (f) => (S.games.length ? tot.teams[f].overall : (([w, l, tt]) => ({ w, l, t: tt, pct: (w + tt / 2) / (w + l + tt) }))(S.mfl_standings[f].h2h));
  const drec = (f) => (S.games.length ? tot.teams[f].div : (([w, l, tt]) => ({ pct: w + l + tt ? (w + tt / 2) / (w + l + tt) : 0 }))(S.mfl_standings[f].div));
  const rows = fids.map((f) => ({ franchise_id: f, franchise_name: name[f], division: divisionOf[f], allplay_pct: tot.teams[f].ap.pct,
    pf_total: tot.teams[f].pf, overall_pct: rec(f).pct, h2h_pct: rec(f).pct, div_pct: drec(f).pct, ap: tot.teams[f].ap, rec: rec(f) }));
  const ladderGames = tot.games.map((g) => ({ franchise_id: g.a, opponent_franchise_id: g.b, team_score: g.ts, opponent_score: g.os }));
  const dw = new Set();
  for (const d of new Set(Object.values(divisionOf))) dw.add(divisionOrder(rows.filter((r) => r.division === d), tot.games, S.standings_sort).order[0].franchise_id);
  const bracket = Object.entries(S.mfl_bracket_seeds).sort((a, b) => a[0] - b[0]).map(([, f]) => f);
  return { S, tot, rows, dw, ladderGames, bracket, by: Object.fromEntries(rows.map((r) => [name[r.franchise_id], r])) };
}

for (const y of ["2017", "2020", "2021"]) {
  test(y + ": regular-season inputs only (weeks 1-" + H.seasons[y].last_regular_season_week + "), every team every week", () => {
    const s = season(y);
    t.equal(s.tot.status, "ok", JSON.stringify(s.tot.problems.slice(0, 3)));
    t.equal(s.tot.throughWeek, s.S.last_regular_season_week);
    for (const r of s.rows) t.equal(r.ap.w + r.ap.l + r.ap.t, 11 * s.S.last_regular_season_week, "12 teams: 11 All-Play results a week");
  });
  test(y + ": the corrected ladders give MFL's bracket seeds 1-6 exactly", () => {
    const s = season(y);
    const f = playoffField(s.rows, s.dw, playoffLadders(s.rows, s.ladderGames));
    t.deepEqual(seedsOf(f), s.bracket);
    t.deepEqual(f.unresolved, []);
  });
}

test("2017: three-way All-Play tie for two wild cards (78-65) goes on Points For: White Power, Ulterior Warrior in; Gride out", () => {
  const s = season("2017");
  for (const n of ["White Power", "Ulterior Warrior", "Gride"]) t.equal(`${s.by[n].ap.w}-${s.by[n].ap.l}-${s.by[n].ap.t}`, "78-65-0", n);
  t.deepEqual([s.by["White Power"].pf_total, s.by["Ulterior Warrior"].pf_total, s.by["Gride"].pf_total].map((x) => Math.round(x * 10) / 10), [2121.3, 2098.5, 2083.1]);
  t.deepEqual(["White Power", "Ulterior Warrior", "Gride"].map((n) => `${s.by[n].rec.w}-${s.by[n].rec.l}`), ["14-12", "12-14", "13-13"]);
  const f = playoffField(s.rows, s.dw, playoffLadders(s.rows, s.ladderGames));
  t.deepEqual(f.wildCards.map((r) => r.franchise_name), ["White Power", "Ulterior Warrior"]);
  t.equal(f.outside[0].franchise_name, "Gride");
  const old = oldField(s.rows, s.dw);
  t.deepEqual(old.wildCards.map((r) => r.franchise_name), ["White Power", "Gride"], "the overall-record step would have put Gride in");
});

test("2020: #BLM (2675.7 PF, 17-9) seed 3 over C-Town Chivalry (2637.0, 22-4), both 91-52 All-Play", () => {
  const s = season("2020");
  t.equal(`${s.by["#BLM"].ap.w}-${s.by["#BLM"].ap.l}`, "91-52"); t.equal(`${s.by["C-Town Chivalry"].ap.w}-${s.by["C-Town Chivalry"].ap.l}`, "91-52");
  const f = playoffField(s.rows, s.dw, playoffLadders(s.rows, s.ladderGames));
  t.deepEqual(f.seeds3to6.slice(0, 2).map((r) => r.franchise_name), ["#BLM", "C-Town Chivalry"]);
  t.deepEqual(ids(f.byes), s.bracket.slice(0, 2), "byes unchanged");
  t.deepEqual(oldField(s.rows, s.dw).seeds3to6.slice(0, 2).map((r) => r.franchise_name), ["C-Town Chivalry", "#BLM"], "the old ladder swapped 3 and 4");
});

test("2021: Ulterior Warrior (3010.3 PF, 23-14) seed 3 over The Bash Bros (2931.7, 25-12), both 97-57 All-Play", () => {
  const s = season("2021");
  t.equal(`${s.by["Ulterior Warrior"].ap.w}-${s.by["Ulterior Warrior"].ap.l}`, "97-57"); t.equal(`${s.by["The Bash Bros"].ap.w}-${s.by["The Bash Bros"].ap.l}`, "97-57");
  const f = playoffField(s.rows, s.dw, playoffLadders(s.rows, s.ladderGames));
  t.deepEqual(f.seeds3to6.slice(0, 2).map((r) => r.franchise_name), ["Ulterior Warrior", "The Bash Bros"]);
  t.deepEqual(oldField(s.rows, s.dw).seeds3to6.slice(0, 2).map((r) => r.franchise_name), ["The Bash Bros", "Ulterior Warrior"], "the old ladder swapped 3 and 4");
});

test("2017: MFL's stored season All-Play is NOT the regular-season figure (it runs through the playoff weeks)", () => {
  const s = season("2017");
  let differs = 0;
  for (const r of s.rows) {
    const [w, l, tt] = String(s.S.mfl_standings[r.franchise_id].mfl_season_all_play).split("-").map(Number);
    t.ok(w + l + tt > 11 * s.S.last_regular_season_week, r.franchise_name + ": " + (w + l + tt) + " season results");
    if (`${w}-${l}-${tt}` !== `${r.ap.w}-${r.ap.l}-${r.ap.t}`) differs++;
  }
  t.equal(differs, 12);
});

// ── 3. 2026 Week 10 (the #1526 recording): Hawks and CBP, both 57-53 All-Play ─────────────────────────────────────
const W10 = JSON.parse(fs.readFileSync(new URL("./fixtures/standings_2026_wk10_ladder.json", import.meta.url), "utf8"));
function week10() {
  const weeklyScores = [], games = [];
  for (const [w, sc] of Object.entries(W10.weekly_scores)) for (const [fid, ts] of Object.entries(sc)) weeklyScores.push({ week: Number(w), franchise_id: fid, team_score: ts, is_playoff: 0 });
  for (const [w, a, b, as, bs] of W10.games) {
    games.push({ week: w, franchise_id: a, opponent_franchise_id: b, team_score: as, opponent_score: bs, is_playoff: 0 });
    games.push({ week: w, franchise_id: b, opponent_franchise_id: a, team_score: bs, opponent_score: as, is_playoff: 0 });
  }
  const franchises = W10.franchises.map((f) => ({ franchise_id: f.id, franchise_name: f.name, division: f.division }));
  return seedCurrentSeason({ franchises, weeklyScores, games, lastRegularSeasonWeek: W10.last_regular_season_week, standingsSort: W10.standings_sort,
    ladder: { playoffLadders, playoffField } });
}
test("2026 Week 10: Hawks and CBP level on All-Play (57-53): Points For decides the last wild card, not Hawks' better record", () => {
  const cur = week10();
  t.equal(cur.status, "ok"); t.equal(cur.throughWeek, 10);
  const id = Object.fromEntries(W10.franchises.map((f) => [f.name, f.id]));
  const H_ = cur.teams[id["Hawks"]], C_ = cur.teams[id["CBP"]];
  t.equal(`${H_.regular_season.all_play.w}-${H_.regular_season.all_play.l}`, "57-53");
  t.equal(`${C_.regular_season.all_play.w}-${C_.regular_season.all_play.l}`, "57-53");
  t.equal(`${H_.regular_season.record.w}-${H_.regular_season.record.l}`, "15-12");
  t.equal(`${C_.regular_season.record.w}-${C_.regular_season.record.l}`, "13-14");
  t.ok(C_.regular_season.points_for > H_.regular_season.points_for, "CBP scored more: " + C_.regular_season.points_for + " vs " + H_.regular_season.points_for);
  t.equal(C_.playoff_seed, 6); t.equal(C_.playoff_status, "wild_card");
  t.equal(H_.playoff_seed, null);
  t.equal(H_.seed_reason.pool, "outside"); t.equal(H_.seed_reason.step, "points_for"); t.equal(H_.seed_reason.rival_franchise_id, id["CBP"]);
  t.deepEqual(cur.unresolved, []);
  t.equal(H_.seed_unresolved, false);
});

// ── 4. recorded seasons keep their recorded order ───────────────────────────────────────────────────────────────
test("legacyStandingsTiebreak (recorded seasons only) is unchanged: AP %, per-game PF average, Overall, name", () => {
  const a = { allplay_pct: 0.5, pf: 220, h2h_pct: 0.4, franchise_name: "A" }, b = { allplay_pct: 0.5, pf: 210, h2h_pct: 0.9, franchise_name: "B" };
  t.ok(legacyStandingsTiebreak(a, b) < 0);
  const c = { ...b, pf: 220 };
  t.ok(legacyStandingsTiebreak(a, c) > 0);
});

await run("ups_seeding_ladder");
