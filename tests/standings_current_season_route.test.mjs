// The current season through the REAL /api/standings and /api/playoff-bracket routes (worker harness, node:sqlite D1),
// on the recorded 2026 season after Week 5 (tests/fixtures/standings_2026_wk5.json).
//   node scripts/safe_tests/run.mjs --only standings_current_season_route
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet } from "./fixtures/worker_harness.mjs";
import { SCHEMA, loadSeason, recorded2026 } from "./fixtures/standings_d1.mjs";

const restore = quiet();
const mfl = makeMfl();
mfl.install();
const REC = JSON.parse(fs.readFileSync(new URL("./fixtures/standings_2026_wk5.json", import.meta.url), "utf8"));
mfl.st.league = { standingsSort: REC.standingsSort };
const SEEDS = ["0009", "0010", "0005", "0008", "0002", "0004"];

const get = async (env, path) => { const r = await callWorker(env, "GET", path); t.equal(r.status, 200, r.text.slice(0, 200)); return r.json; };
const season = (over) => { const s = recorded2026(REC); return { ...s, ...(over ? over(s) : {}) }; };
const env = (s) => loadSeason(makeWorkerEnv({}), s);

test("recorded Week 5: both routes give the verified seeds, from one computation", async () => {
  const e = env(season());
  const st = await get(e, "/api/standings?year=2026"), br = await get(e, "/api/playoff-bracket?year=2026");
  t.deepEqual(st.rows.slice(0, 6).map((r) => r.franchise_id), SEEDS);
  t.deepEqual(br.seeds.slice(0, 6).map((s) => s.franchise_id), SEEDS);
  t.deepEqual(st.rows.map((r) => r.playoff_status).slice(0, 7), ["bye", "bye", "division_winner", "division_winner", "wild_card", "wild_card", "non_playoff"]);
  t.deepEqual(br.seeds.map((s) => s.path).slice(0, 6), ["DIV", "DIV", "DIV", "DIV", "WC", "WC"]);
  const leaders = st.rows.filter((r) => r.is_division_leader).map((r) => r.franchise_id).sort();
  t.deepEqual(leaders, ["0005", "0008", "0009", "0010"]);
  const creel = st.rows.find((r) => r.franchise_id === "0008");
  t.deepEqual([creel.regular_season.all_play.w, creel.regular_season.record.w, creel.regular_season.record.l, creel.regular_season.points_for], [32, 9, 4, 1145.8]);
  t.equal(creel.regular_season.pf_per_week, 229.16);
});

test("bug: playoff weeks folded into src_standings (as the live sync does) don't move a single seed", async () => {
  // Week 15 playoff scores where the outside teams score 400 -- src_standings totals now include them.
  const s = season((x) => {
    const outside = new Set(["0012", "0011", "0001", "0003", "0006", "0007"]);
    const ws = x.franchises.map((f) => ({ week: 15, franchise_id: f.franchise_id, team_score: outside.has(f.franchise_id) ? 400 : 100, team_opt_pts: 0, is_playoff: 1 }));
    const g = [["0012", "0009"], ["0011", "0010"]].flatMap(([a, b]) => [
      { week: 15, franchise_id: a, opponent_franchise_id: b, team_score: 400, opponent_score: 100, result: "W", is_playoff: 1 },
      { week: 15, franchise_id: b, opponent_franchise_id: a, team_score: 100, opponent_score: 400, result: "L", is_playoff: 1 }]);
    return { weeklyScores: [...x.weeklyScores, ...ws], games: [...x.games, ...g] };
  });
  const e = env(s);
  const hawks = e.UPS_MFL_DB.raw.prepare("SELECT allplay_pct, pf FROM src_standings WHERE franchise_id = '0012'").get();
  t.ok(hawks.pf > 1400, "src_standings now includes the playoff week");
  const st = await get(e, "/api/standings?year=2026"), br = await get(e, "/api/playoff-bracket?year=2026");
  t.deepEqual(st.rows.slice(0, 6).map((r) => r.franchise_id), SEEDS);
  t.deepEqual(br.seeds.slice(0, 6).map((x) => x.franchise_id), SEEDS);
  t.equal(st.rows.find((r) => r.franchise_id === "0012").regular_season.points_for, 1041);
});

test("F3 at the source: a malformed playoff flag means no seeds on either route, and the reason", async () => {
  for (const bad of [null, "x", 2]) {
    const s = season((x) => ({ games: x.games.map((g, i) => (i === 7 ? { ...g, is_playoff: bad } : g)) }));
    const e = env(s);
    const st = await get(e, "/api/standings?year=2026"), br = await get(e, "/api/playoff-bracket?year=2026");
    t.equal(st.standings_basis, "unavailable");
    t.ok(st.regular_season.problems.some((p) => p.code === "malformed_playoff_flag"));
    t.ok(st.rows.every((r) => r.playoff_seed === null && !r.is_division_leader));
    t.equal(br.seeding_status, "unavailable"); t.deepEqual(br.seeds, []);
  }
});

test("preseason: nobody is a division leader and nobody is seeded", async () => {
  const e = makeWorkerEnv({});
  const db = e.UPS_MFL_DB.raw;
  db.exec(SCHEMA);
  db.prepare("INSERT INTO src_league_season_meta (season, league_id, mfl_server, last_regular_season_week) VALUES (2026, '74598', 'www48', 14)").run();
  for (const f of REC.franchises) db.prepare("INSERT INTO src_franchises (season, franchise_id, team_name, division, owner_name) VALUES (2025, ?, ?, ?, 'x')").run(f.franchise_id, f.franchise_name, f.division);
  mfl.st.league = { standingsSort: REC.standingsSort, divisions: { division: REC.divisions } };
  const st = await get(e, "/api/standings?year=2026");
  mfl.st.league = { standingsSort: REC.standingsSort };
  t.equal(st.preseason, true); t.equal(st.standings_basis, "preseason");
  t.ok(st.rows.length > 0);
  t.ok(st.rows.every((r) => r.is_division_leader === false && r.playoff_seed === null));
});

test("season_complete comes from the season's own final week (a 16-week season ends in Week 16)", async () => {
  const s = season((x) => ({
    lastRegularSeasonWeek: 5,
    games: [...x.games, { week: 8, franchise_id: "0009", opponent_franchise_id: "0010", team_score: 200, opponent_score: 150, result: "W", is_playoff: 1 },
      { week: 8, franchise_id: "0010", opponent_franchise_id: "0009", team_score: 150, opponent_score: 200, result: "L", is_playoff: 1 }],
  }));
  const st = await get(env(s), "/api/standings?year=2026");
  t.equal(st.season_complete, true, "last regular week 5 + 3 playoff weeks = Week 8");
  t.equal(st.regular_season.complete, true);
  const st2 = await get(env(season()), "/api/standings?year=2026");
  t.equal(st2.season_complete, false); t.equal(st2.regular_season.complete, false);
});

await run("standings_current_season_route");
mfl.restore();
restore();
