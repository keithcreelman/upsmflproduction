// /api/standings says WHY each current-season team is seeded where it is (seed_reason), from the worker's own ladder —
// All-Play % → Overall → season Points For → head-to-head (canon §F.1, Keith 2026-10-08) — so no page re-derives it
// (Keith 2026-10-09, Phase II port decision 1). Seasons with recorded final standings make no ladder claim (decision 2).
//   node tests/standings_seed_reason.test.mjs
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet } from "./fixtures/worker_harness.mjs";
import fs from "node:fs";
import { SCHEMA, loadSeason, recorded2026 } from "./fixtures/standings_d1.mjs";
import { seedLadder, seedLadderSteps, SEED_STEPS } from "../worker/src/seeding.js";

const restore = quiet();
const mfl = makeMfl();
mfl.install();

// 8 teams, 4 divisions of 2. Division winners (by Overall within the division): 0001, 0003, 0005, 0007.
//   bye pool:   0001 vs 0003 — tied All-Play .700, 0001 ahead on Overall (.800 v .700)
//   seeds 3-6:  0004 v 0002 — tied All-Play, Overall AND Points For; 0004 beat 0002 → head-to-head
//               0002 v 0007 — All-Play .650 v .550
//               0007 v 0005 — tied All-Play and Overall; Points For 950 v 900
//   outside:    0006, 0008 — behind the last wild card (0002) on All-Play
const TEAMS = [
  ["0001", "A", 0.700, 0.800, 1000], ["0002", "A", 0.650, 0.500, 1100],
  ["0003", "B", 0.700, 0.700, 1200], ["0004", "B", 0.650, 0.500, 1100],
  ["0005", "C", 0.550, 0.600, 900],  ["0006", "C", 0.400, 0.400, 800],
  ["0007", "D", 0.550, 0.600, 950],  ["0008", "D", 0.400, 0.400, 800],
];
function makeSeason({ recorded = false, failGames = false } = {}) {
  const env = makeWorkerEnv({});
  const db = env.UPS_MFL_DB.raw;
  db.exec(SCHEMA);
  db.prepare("INSERT INTO src_league_season_meta (season, league_id, mfl_server) VALUES (2026, '74598', 'www48')").run();
  for (const [fid, div, ap, ov, pf] of TEAMS) {
    db.prepare("INSERT INTO src_franchises (season, franchise_id, team_name, division) VALUES (2026, ?, ?, ?)").run(fid, "Team " + fid, div);
    db.prepare("INSERT INTO src_standings (season, franchise_id, h2h_w, h2h_l, h2h_t, h2h_pct, allplay_pct, pf) VALUES (2026, ?, 1, 1, 0, ?, ?, ?)").run(fid, ov, ap, pf);
    if (recorded) db.prepare("INSERT INTO src_final_standings (season, franchise_id, final_finish) VALUES (2026, ?, 1)").run(fid);
  }
  const g = db.prepare("INSERT INTO src_schedule (season, week, franchise_id, opponent_franchise_id, team_score, opponent_score, is_divisional, is_playoff) VALUES (2026, 1, ?, ?, ?, ?, 0, 0)");
  g.run("0004", "0002", 120, 100); g.run("0002", "0004", 100, 120);
  if (failGames) {
    const prep = env.UPS_MFL_DB.prepare.bind(env.UPS_MFL_DB);
    env.UPS_MFL_DB.prepare = (sql) => { if (sql.includes("WHERE season = ? AND COALESCE(is_playoff, 0) = 0")) throw new Error("D1_ERROR: simulated games failure"); return prep(sql); };
  }
  return env;
}
const standings = async (env) => { const r = await callWorker(env, "GET", "/api/standings?year=2026"); t.equal(r.status, 200, r.text.slice(0, 200)); return r.json; };
const byFid = (j) => Object.fromEntries(j.rows.map((r) => [r.franchise_id, r]));
const brief = (r) => [r.playoff_seed, r.seed_reason.pool, r.seed_reason.step, r.seed_reason.position, r.seed_reason.rival_franchise_id];

test("seedLadderSteps: the comparator is identical to seedLadder, and names the step that decided each pair", () => {
  const rows = TEAMS.map(([fid, , ap, ov, pf]) => ({ franchise_id: fid, franchise_name: "Team " + fid, allplay_pct: ap, h2h_pct: ov, pf_total: pf }));
  const games = [{ franchise_id: "0004", opponent_franchise_id: "0002", team_score: 120, opponent_score: 100 }, { franchise_id: "0002", opponent_franchise_id: "0004", team_score: 100, opponent_score: 120 }];
  const L = seedLadderSteps(rows, games), old = seedLadder(rows, games);
  for (const a of rows) for (const b of rows) t.equal(Math.sign(L.cmp(a, b)), Math.sign(old(a, b)));
  const R = Object.fromEntries(rows.map((r) => [r.franchise_id, r]));
  t.equal(L.decidingStep(R["0001"], R["0003"]), "overall");
  t.equal(L.decidingStep(R["0004"], R["0002"]), "head_to_head");
  t.equal(L.decidingStep(R["0007"], R["0005"]), "points_for");
  t.equal(L.decidingStep(R["0002"], R["0007"]), "all_play");
  t.equal(L.decidingStep(R["0001"], R["0001"]), null);
  t.equal(L.decidingStep({ ...R["0006"], franchise_name: "A" }, { ...R["0008"], franchise_name: "B" }), "name", "the fallback is named as such");
  t.deepEqual(SEED_STEPS, ["all_play", "overall", "points_for", "head_to_head", "name", "franchise_id"]);
});

// The current season is seeded from its REGULAR-SEASON WEEKLY rows (worker/src/standings_truth.js, 2026-10-17), so the
// route tests use the recorded 2026 season after Week 5 (tests/fixtures/standings_2026_wk5.json). The head-to-head and
// points-for steps are covered on generated seasons in tests/standings_truth.test.mjs.
const REC = JSON.parse(fs.readFileSync(new URL("./fixtures/standings_2026_wk5.json", import.meta.url), "utf8"));
mfl.st.league = { standingsSort: REC.standingsSort };
function recordedEnv({ failGames = false } = {}) {
  const env = loadSeason(makeWorkerEnv({}), recorded2026(REC));
  if (failGames) {
    const prep = env.UPS_MFL_DB.prepare.bind(env.UPS_MFL_DB);
    env.UPS_MFL_DB.prepare = (sql) => { if (/FROM src_schedule WHERE season = \? AND COALESCE\(team_score, 0\) > 0/.test(sql)) throw new Error("D1_ERROR: simulated games failure"); return prep(sql); };
  }
  return env;
}

test("current season: every row carries the step that seeded it, through the real /api/standings route", async () => {
  const j = await standings(recordedEnv());
  t.equal(j.standings_basis, "regular_season_ladder");
  t.equal(j.regular_season.status, "ok"); t.equal(j.regular_season.through_week, 5); t.equal(j.regular_season.next_out, "0012");
  const R = byFid(j);
  t.deepEqual(j.rows.map((r) => r.franchise_id), ["0009", "0010", "0005", "0008", "0002", "0004", "0012", "0011", "0001", "0003", "0006", "0007"]);
  t.deepEqual(brief(R["0009"]), [1, "bye", "all_play", "ahead", "0010"]);
  t.deepEqual(brief(R["0010"]), [2, "bye", "all_play", "behind", "0009"]);
  t.deepEqual(brief(R["0008"]), [4, "seeds3to6", "overall", "ahead", "0002"], "Creel over CBP: both 32-23 All-Play, 9-4 vs 7-6");
  t.deepEqual(brief(R["0004"]), [6, "seeds3to6", "all_play", "behind", "0002"]);
  t.deepEqual(brief(R["0012"]), [null, "outside", "all_play", "behind", "0004"], "outside: behind the last wild card");
  t.deepEqual([R["0002"].seed_reason.vs_above.franchise_id, R["0002"].seed_reason.vs_above.step], ["0008", "overall"]);
  t.ok(j.rows.every((r) => r.seed_reason.basis === "ladder"));
  t.equal(R["0012"].ap_back, 2);
  t.equal(R["0002"].seed_reason.rival_seed, 6);
  // The bracket reads the same computation.
  const b = await callWorker(recordedEnv(), "GET", "/api/playoff-bracket?year=2026");
  t.equal(b.json.seeding_status, "regular_season_ladder");
  t.deepEqual(b.json.seeds.map((s) => s.franchise_id), j.rows.map((r) => r.franchise_id));
});

test("the regular-season games can't be read: no seeds at all, and the response says why", async () => {
  const j = await standings(recordedEnv({ failGames: true }));
  t.equal(j.standings_basis, "unavailable");
  t.equal(j.regular_season.status, "incomplete");
  t.ok(j.regular_season.problems.some((p) => p.code === "weekly_unreadable"));
  t.ok(j.rows.every((r) => r.playoff_seed === null && r.playoff_status === "unavailable" && r.is_division_leader === false));
  t.equal(j.weekly, null); t.ok(j.weekly_errors && j.weekly_errors.weekly);
  const b = await callWorker(recordedEnv({ failGames: true }), "GET", "/api/playoff-bracket?year=2026");
  t.equal(b.json.seeding_status, "unavailable");
  t.deepEqual(b.json.seeds, []);
});

test("a season with RECORDED final standings: basis 'recorded_final_standings', no ladder step claimed", async () => {
  const j = await standings(makeSeason({ recorded: true }));
  t.ok(j.rows.length === 8);
  t.ok(j.rows.every((r) => r.seed_reason && r.seed_reason.basis === "recorded_final_standings" && !("step" in r.seed_reason)));
});

await run("standings_seed_reason");
mfl.restore();
restore();
