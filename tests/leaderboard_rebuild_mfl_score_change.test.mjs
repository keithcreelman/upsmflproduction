// A change to MFL weekly scores must trigger a leaderboard rebuild, even when
// nflverse's week / row count / team coverage are identical.
//   node tests/leaderboard_rebuild_mfl_score_change.test.mjs
//
// THE INCIDENT (2026-10-01). src_weekly was restored from a clobbered 1,073
// rows to MFL's full 3,632 (and Fred Warner's Wk 3 Elias correction, 14.0 ->
// 13.5, landed with it). nflverse sat still at week 3 / 3,376 rows / 32 teams,
// so POST /admin/leaderboard-precompute/build skipped all five aliases as
// "no_change", the workflow went green, and the board kept serving 241 wrong
// MFL totals of 481. A Tuesday stat-correction sync has exactly this shape.
//
// This drives the REAL route (worker/src/index.js default.fetch) under Node
// with D1 = node:sqlite built from the REAL migration files. The only thing
// faked is env.SELF — the builder's self-fetch of the live leaderboard query —
// and the fake computes each player's mfl_points from the D1 src_weekly rows
// at call time, the way the live query sums them, so the stored board really
// does follow the scores.
//
// Defect-sensitive: on the pre-fix route, step 3 (the correction) is skipped
// and Warner's stored total stays 32.5.
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, callWorker, ADMIN_KEY, quiet } from "./fixtures/fcfs_worker_harness.mjs";

const MIG = (f) => fs.readFileSync("worker/migrations/" + f, "utf8");
const ALIASES = ["qb", "skill", "idp", "kicker", "punter"];
// One real player per alias (MFL 74598, 2026 Wks 1-3, captured 2026-10-01).
const PLAYER = { qb: "10313", skill: "12263", idp: "13743", kicker: "14717", punter: "16529" };

function setup({ withFingerprintColumn }) {
  const env = makeWorkerEnv();
  const db = env.UPS_MFL_DB.raw;
  for (const f of ["0002_mfl_source_tables.sql", "0006_advanced_stats_schema.sql", "0140_leaderboard_precompute.sql",
                   "0143_leaderboard_precompute_current_season.sql", "0161_leaderboard_precompute_week_coverage.sql"]) {
    db.exec(MIG(f));
  }
  if (withFingerprintColumn) db.exec(MIG("0165_leaderboard_precompute_mfl_scores_fingerprint.sql"));
  // nflverse coverage: week 3, all 32 teams scheduled and reported. It never
  // changes in this test — that is the point.
  const teams = Array.from({ length: 32 }, (_, i) => "T" + String(i).padStart(2, "0"));
  const pw = db.prepare("INSERT INTO nfl_player_weekly (season, week, gsis_id, team, pos_group) VALUES (2026, ?, ?, ?, 'LB')");
  const vg = db.prepare("INSERT INTO nfl_team_vegas_weekly (season, week, team) VALUES (2026, ?, ?)");
  for (let w = 1; w <= 3; w++) teams.forEach((tm, i) => { pw.run(w, "00-" + w + "-" + i, tm); vg.run(w, tm); });
  const sw = db.prepare("INSERT INTO src_weekly (season, week, player_id, score, status) VALUES (2026, ?, ?, ?, ?)");
  for (const [w, pid, score] of [
    [1, "13743", 11.5], [2, "13743", 7.0], [3, "13743", 14.0],          // Warner — pre-correction Wk 3
    [1, "12263", 6.2], [2, "12263", 20.4], [3, "12263", 13.2],
    [3, "10313", -2.0], [1, "14717", 11.5], [2, "14717", 17.6], [3, "14717", 13.0],
    [1, "16529", 14.0], [2, "16529", 14.0], [3, "16529", 14.0],
  ]) sw.run(w, pid, score, "fa");
  const selfCalls = [];
  env.SELF = {
    fetch: async (u) => {
      const url = new URL(String(u));
      const alias = url.searchParams.get("pos");
      selfCalls.push(alias);
      t.equal(url.searchParams.get("NO_PRECOMPUTE"), "1", "the builder must bypass the stored board");
      const pid = PLAYER[alias];
      const agg = db.prepare("SELECT ROUND(SUM(score), 1) AS pts, COUNT(score) AS g FROM src_weekly WHERE season = 2026 AND player_id = ?").get(pid);
      const rows = [{ gsis_id: "00-" + pid, mfl_pid: pid, games: agg.g, punts: alias === "punter" ? 12 : 0,
                      mfl_points: agg.pts, mfl_ppg: agg.g ? agg.pts / agg.g : null }];
      return new Response(JSON.stringify({ rows }), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  const build = async () => {
    const restore = quiet();
    try {
      return await callWorker(env, "POST", `/admin/leaderboard-precompute/build?APIKEY=${ADMIN_KEY}&L=74598&YEAR=2026&season=2026`,
        { body: { season: 2026, only_pos: "all" } });
    } finally { restore(); }
  };
  const stored = (alias) => {
    const r = db.prepare("SELECT row_json FROM nfl_leaderboard_precompute WHERE season = 2026 AND pos_alias = ?").get(alias);
    return r ? JSON.parse(r.row_json) : null;
  };
  return { env, db, build, stored, selfCalls };
}

test("a scoring correction rebuilds every alias even though nflverse coverage is unchanged", async () => {
  const h = setup({ withFingerprintColumn: true });
  const first = await h.build();
  t.equal(first.status, 200, "first build ok");
  t.equal(first.json.rebuilt, 5, "first build stores all five boards");
  t.equal(h.stored("idp").mfl_points, 32.5, "Warner before the correction: 11.5 + 7.0 + 14.0");

  const second = await h.build();
  t.equal(second.json.rebuilt, 0, "nothing changed -> nothing rebuilt (idempotency kept)");
  t.equal(second.json.skipped_unchanged, 5);

  // The real 2026-10-01 Elias correction. Same rows, same week, same nflverse.
  h.db.prepare("UPDATE src_weekly SET score = 13.5 WHERE season = 2026 AND week = 3 AND player_id = '13743'").run();
  const third = await h.build();
  t.equal(third.json.skipped_unchanged, 0, "the correction must NOT be skipped as no_change");
  t.equal(third.json.rebuilt, 5, "all five aliases rebuilt");
  t.equal(h.stored("idp").mfl_points, 32.0, "Warner's stored total follows MFL (32.0)");

  const fourth = await h.build();
  t.equal(fourth.json.rebuilt, 0, "and it settles again once rebuilt");
});

test("the build reports the fingerprint it stored, and it moves with the scores", async () => {
  const h = setup({ withFingerprintColumn: true });
  const first = await h.build();
  t.ok(first.json.built.every((b) => b.mfl_fingerprint_stored === true), "fingerprint stored for every alias");
  t.match(String(first.json.mfl_scores_fingerprint), /^v1:/);
  const fp = h.db.prepare("SELECT DISTINCT mfl_scores_fingerprint AS f FROM nfl_leaderboard_precompute_meta WHERE season = 2026").all();
  t.equal(fp.length, 1, "one fingerprint across the five meta rows");
  t.equal(fp[0].f, first.json.mfl_scores_fingerprint, "and it is the one the response reported");
  h.db.prepare("UPDATE src_weekly SET score = 13.5 WHERE season = 2026 AND week = 3 AND player_id = '13743'").run();
  const again = await h.build();
  t.notEqual(again.json.mfl_scores_fingerprint, first.json.mfl_scores_fingerprint, "fingerprint moved");
});

test("the 2026-10-01 restore shape (free-agent rows added back) rebuilds too", async () => {
  const h = setup({ withFingerprintColumn: true });
  await h.build();
  h.db.prepare("INSERT INTO src_weekly (season, week, player_id, score, status) VALUES (2026, 2, '10313', 0.0, 'fa')").run();
  const r = await h.build();
  t.equal(r.json.rebuilt, 5);
  t.equal(h.stored("qb").games, 2, "Dalton's added 0.0 week is in the stored board");
});

test("migration 0165 not applied yet: every build still succeeds and simply never skips", async () => {
  const h = setup({ withFingerprintColumn: false });
  const a = await h.build();
  t.equal(a.status, 200);
  t.equal(a.json.rebuilt, 5, "boards stored — the missing column never blocks a build");
  t.ok(a.json.built.every((b) => b.mfl_fingerprint_stored === false), "and says the fingerprint was not stored");
  const b = await h.build();
  t.equal(b.json.rebuilt, 5, "no fingerprint to compare -> rebuild (fail closed), not skip");
});

test("a failed fingerprint read never permits a skip", async () => {
  const h = setup({ withFingerprintColumn: true });
  await h.build();
  h.db.exec("ALTER TABLE src_weekly RENAME TO src_weekly_gone");   // the fingerprint SELECT now errors
  const r = await h.build();
  t.equal(r.json.mfl_scores_fingerprint, null, "fingerprint unknown");
  t.equal(r.json.skipped_unchanged, 0, "unknown is not 'unchanged'");
});

await run("leaderboard_rebuild_mfl_score_change");
