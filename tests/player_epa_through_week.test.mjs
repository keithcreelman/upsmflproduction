// /api/player-epa says which weeks its EPA covers (migration 0169).
//   node tests/player_epa_through_week.test.mjs
// nfl_player_epa had no week column, so the app could only say "2026 to date";
// on a Monday after the 05:00 UTC refresh EPA can include games the box score
// doesn't yet. The ETL now stamps through_week and the route returns it.
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, callWorker, quiet } from "./fixtures/fcfs_worker_harness.mjs";
const SCHEMA = fs.readFileSync("tests/fixtures/leaderboard_schema_pre0169.sql", "utf8");
const M0169 = fs.readFileSync("worker/migrations/0169_redzone_v2_epa_through_week.sql", "utf8");
const get = async (env) => { const r = quiet(); try { return await callWorker(env, "GET", "/api/player-epa?seasons=2026"); } finally { r(); } };
const ins = (db, tw) => db.prepare(`INSERT INTO nfl_player_epa (season, gsis_id, pass_plays, pass_epa_sum, pass_succ_sum${tw === undefined ? "" : ", through_week"})
                                   VALUES (2026, '00-Q', 100, 12.5, 48${tw === undefined ? "" : ", " + tw})`).run();
test("through_week comes back per season", async () => {
  const env = makeWorkerEnv(); const db = env.UPS_MFL_DB.raw; db.exec(SCHEMA); db.exec(M0169); ins(db, 4);
  const r = await get(env);
  t.deepEqual([r.status, r.json.through_week], [200, { 2026: 4 }]);
  t.deepEqual(r.json.by_gsis["00-Q"].pass, { plays: 100, epa: 0.125, cpoe: null, succ: 48 }, "the rates are unchanged");
});
test("before 0169 (no column) the route still answers, with no week claim", async () => {
  const env = makeWorkerEnv(); const db = env.UPS_MFL_DB.raw; db.exec(SCHEMA); ins(db);
  const r = await get(env);
  t.deepEqual([r.status, r.json.through_week, r.json.count], [200, {}, 1]);
});
await run("player_epa_through_week");
