// Red-zone counts and team shares on the leaderboard (migration 0169).
//   node tests/leaderboard_redzone_shares.test.mjs
//
// THE BUGS (2026-10-10 audit, 2026 Wks 1-4, checked play by play):
//   * a share's denominator summed the team's red-zone plays only in weeks the
//     player had a BOX-SCORE row, so a game he played without recording a stat
//     dropped out and the share came out too high (Jahdae Walker 33.3% of his
//     team's red-zone targets; the true share is 4.3%);
//   * the team play mix was the team's whole window joined on MAX(w.team), so a
//     traded player got one team's season;
//   * a passer's inside-20 completions were not stored at all, and "attempts"
//     counted sacks.
// Drives the REAL route under node:sqlite with production's schema
// (tests/fixtures/leaderboard_schema_pre0169.sql) plus the real 0169 migration.
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, callWorker, quiet } from "./fixtures/fcfs_worker_harness.mjs";

const SCHEMA = fs.readFileSync("tests/fixtures/leaderboard_schema_pre0169.sql", "utf8");
const M0169 = fs.readFileSync("worker/migrations/0169_redzone_v2_epa_through_week.sql", "utf8");
const M0170 = fs.readFileSync("worker/migrations/0170_player_id_map.sql", "utf8");

function setup({ migrate = true } = {}) {
  const env = makeWorkerEnv();
  const db = env.UPS_MFL_DB.raw;
  db.exec(SCHEMA);
  if (migrate) db.exec(M0169);
  db.exec(M0170);
  const wk = db.prepare(`INSERT INTO nfl_player_weekly (season, week, gsis_id, position, pos_group, team, targets, receptions, rush_att, pass_att)
                         VALUES (2026, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const sn = db.prepare("INSERT INTO nfl_player_snaps (season, week, pfr_id, team, off_snaps, def_snaps, st_snaps) VALUES (2026, ?, ?, ?, ?, 0, ?)");
  const xw = db.prepare("INSERT INTO player_id_crosswalk (mfl_player_id, gsis_id, pfr_id, confidence) VALUES (?, ?, ?, 'exact')");
  const rz = (cols) => {
    const k = Object.keys(cols);
    db.prepare(`INSERT INTO nfl_player_redzone (season, ${k.join(", ")}) VALUES (2026, ${k.map(() => "?").join(", ")})`).run(...Object.values(cols));
  };
  const tw = migrate
    ? db.prepare("INSERT INTO nfl_team_weekly (season, week, team, rz_targets, rz_rec, ez_targets, rz_carries, i5_carries, rz_pass_att, rz_sacks, rz_scrambles) VALUES (2026, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    : null;
  // Team AAA plays 10 inside-20 targets and 8 inside-20 carries (1 a scramble) every week; BBB 20 and 4 (no scrambles).
  if (tw) for (let w = 1; w <= 3; w++) { tw.run(w, "AAA", 10, 6, 4, 8, 3, 9, 1, 1); tw.run(w, "BBB", 20, 12, 8, 4, 2, 18, 2, 0); }

  // WR "X" (AAA): Wk 1 a box row with 2 red-zone targets; Wk 2 offensive snaps but no stat (no box row);
  // Wk 3 special-teams snaps only plus a box row (a kick return) — NOT an offensive game.
  xw.run(30001, "00-X", "XxxxXx00");
  wk.run(1, "00-X", "WR", "WR", "AAA", 3, 2, 0, 0); sn.run(1, "XxxxXx00", "AAA", 40, 2);
  sn.run(2, "XxxxXx00", "AAA", 35, 1);
  wk.run(3, "00-X", "WR", "WR", "AAA", 0, 0, 0, 0); sn.run(3, "XxxxXx00", "AAA", 0, 12);
  rz({ week: 1, gsis_id: "00-X", targets_i20: 2, rec_i20: 1, targets_ez: 1, rush_att_i20: 0, rush_att_i5: 0, pass_att_i20: 0, pass_cmp_i20: 0, sacks_i20: 0 });

  // WR "Y": traded — AAA in Wk 1, BBB in Wk 2 (offensive snaps both weeks).
  xw.run(30002, "00-Y", "YyyyYy00");
  wk.run(1, "00-Y", "WR", "WR", "AAA", 4, 3, 0, 0); sn.run(1, "YyyyYy00", "AAA", 50, 0);
  wk.run(2, "00-Y", "WR", "WR", "BBB", 5, 4, 0, 0); sn.run(2, "YyyyYy00", "BBB", 45, 0);
  rz({ week: 1, gsis_id: "00-Y", targets_i20: 1, rec_i20: 1, targets_ez: 0, rush_att_i20: 0, rush_att_i5: 0, pass_att_i20: 0, pass_cmp_i20: 0, sacks_i20: 0 });
  rz({ week: 2, gsis_id: "00-Y", targets_i20: 3, rec_i20: 2, targets_ez: 2, rush_att_i20: 0, rush_att_i5: 0, pass_att_i20: 0, pass_cmp_i20: 0, sacks_i20: 0 });

  // RB "Z": no pfr mapping anywhere — his box-score weeks (1, 2) are his games.
  wk.run(1, "00-Z", "RB", "RB", "AAA", 1, 1, 10, 0); wk.run(2, "00-Z", "RB", "RB", "AAA", 0, 0, 12, 0);
  rz({ week: 1, gsis_id: "00-Z", targets_i20: 0, rec_i20: 0, targets_ez: 0, rush_att_i20: 4, rush_att_i5: 2, pass_att_i20: 0, pass_cmp_i20: 0, sacks_i20: 0 });
  rz({ week: 2, gsis_id: "00-Z", targets_i20: 0, rec_i20: 0, targets_ez: 0, rush_att_i20: 2, rush_att_i5: 1, pass_att_i20: 0, pass_cmp_i20: 0, sacks_i20: 0 });
  return { env, db, rz, wk, xw, sn };
}
async function board(env, pos) {
  const restore = quiet();
  try {
    const r = await callWorker(env, "GET", `/api/advanced-stats-leaderboard?season=2026&pos=${pos}&YEAR=2026&L=74598&min_games=1&limit=200&NO_PRECOMPUTE=1&NO_CACHE=1`);
    t.equal(r.status, 200, JSON.stringify(r.json).slice(0, 300));
    return Object.fromEntries((r.json.rows || []).map((x) => [x.gsis_id, x]));
  } finally { restore(); }
}

test("a share's denominator is the team's red-zone plays in the games he took an OFFENSIVE snap", async () => {
  const { env } = setup();
  const x = (await board(env, "skill"))["00-X"];
  // Wk 1 (box row) + Wk 2 (snaps, no box row) = 20 team targets; Wk 3 was special teams only.
  t.equal(x.team_targets_i20, 20, "Wk 1 + Wk 2; not Wk 3 (special-teams snaps only)");
  t.equal(x.rz_target_share, 2 / 20, "2 of 20 = 10% — the old box-week-only rule read 2 of 10 = 20%");
  t.equal(x.ez_target_share, 1 / 8);
  t.equal(x.target_share != null && x.target_share > 0, true, "Tgt% uses the same games");
});

test("a traded player is measured against each team in the weeks he played for it", async () => {
  const { env } = setup();
  const y = (await board(env, "skill"))["00-Y"];
  t.equal(y.team_targets_i20, 10 + 20, "AAA Wk 1 + BBB Wk 2");
  t.equal(y.rz_target_share, 4 / 30);
  t.equal(y.team_rz_plays, (9 + 1 + 8) + (18 + 2 + 4), "the team play mix follows him too, not MAX(team)");
  t.equal(y.team_rz_dropbacks, (9 + 1 + 1) + (18 + 2 + 0), "dropbacks = attempts + sacks + scrambles");
});

test("no snap mapping: the box-score weeks are his games (never a blank share)", async () => {
  const { env } = setup();
  const z = (await board(env, "skill"))["00-Z"];
  t.equal(z.team_rush_att_i20, 16, "AAA Wks 1-2");
  t.equal(z.rz_rush_share, 6 / 16);
  t.equal(z.gl_rush_share, 3 / 6);
});

test("QB inside-20: attempts, completions, TDs and sacks are separate; the pass rate is the TEAM's in his games; an old-ETL row's completions are unknown, not 0", async () => {
  const { env, wk, rz, xw, sn } = setup();
  xw.run(30010, "00-Q", "QqqqQq00");
  for (const w of [1, 2]) { wk.run(w, "00-Q", "QB", "QB", "AAA", 0, 0, 2, 30); sn.run(w, "QqqqQq00", "AAA", 60, 0); }
  rz({ week: 1, gsis_id: "00-Q", pass_att_i20: 5, pass_cmp_i20: 4, pass_tds_i20: 2, sacks_i20: 1, rush_att_i20: 1, rush_att_i5: 0, targets_i20: 0, rec_i20: 0, targets_ez: 0 });
  rz({ week: 2, gsis_id: "00-Q", pass_att_i20: 4, pass_cmp_i20: 3, pass_tds_i20: 1, sacks_i20: 0, rush_att_i20: 0, rush_att_i5: 0, targets_i20: 0, rec_i20: 0, targets_ez: 0 });
  const q = (await board(env, "qb"))["00-Q"];
  t.deepEqual([q.pass_att_i20, q.pass_cmp_i20, q.pass_tds_i20, q.sacks_i20, q.rush_att_i20, q.rz_v2], [9, 7, 3, 1, 1, 1]);
  t.deepEqual([q.team_rz_dropbacks, q.team_rz_plays], [2 * (9 + 1 + 1), 2 * (9 + 1 + 8)], "every AAA inside-20 play in his 2 games, whoever was at QB");
  t.equal(q.team_rz_pass_rate, 22 / 36);
  t.equal("rz_qb_plays" in q, false, "no 'with him at QB' count");
  // a week still holding a pre-0169 row (sacks_i20 NULL): completions/sacks are UNKNOWN for the season
  xw.run(30011, "00-R", "RrrrRr00");
  wk.run(1, "00-R", "QB", "QB", "BBB", 0, 0, 0, 25); sn.run(1, "RrrrRr00", "BBB", 55, 0);
  rz({ week: 1, gsis_id: "00-R", pass_att_i20: 6, pass_tds_i20: 1, rush_att_i20: 0, rush_att_i5: 0, targets_i20: 0, rec_i20: 0, targets_ez: 0 });
  const r = (await board(env, "qb"))["00-R"];
  t.deepEqual([r.pass_att_i20, r.pass_cmp_i20, r.sacks_i20, r.rz_v2], [6, null, null, 0], "NULL, never 0");
});

test("a season whose play-by-play wasn't re-run since 0169 has no team totals: shares are null, not a guess", async () => {
  const { env, db } = setup();
  db.exec("UPDATE nfl_team_weekly SET rz_targets = NULL, rz_rec = NULL, ez_targets = NULL, rz_carries = NULL, i5_carries = NULL, rz_pass_att = NULL, rz_sacks = NULL, rz_scrambles = NULL");
  const x = (await board(env, "skill"))["00-X"];
  t.deepEqual([x.team_targets_i20, x.rz_target_share, x.team_rz_plays, x.team_rz_pass_rate], [null, null, null, null]);
  t.equal(x.targets_i20, 2, "his own count is still there");
});

test("one of his games without team totals (e.g. a season not re-run since 0169 in a multi-season window): the share is null, never over his other games", async () => {
  const { env, db } = setup();
  db.exec("UPDATE nfl_team_weekly SET rz_targets = NULL, rz_rec = NULL, ez_targets = NULL, rz_carries = NULL, i5_carries = NULL, rz_pass_att = NULL, rz_sacks = NULL, rz_scrambles = NULL WHERE week = 2 AND team = 'BBB'");
  const sk = await board(env, "skill");
  const y = sk["00-Y"];   // AAA Wk 1 (totals present) + BBB Wk 2 (missing)
  t.deepEqual([y.team_targets_i20, y.rz_target_share, y.team_rz_plays, y.team_rz_pass_rate], [null, null, null, null], "a plain SUM would have used Wk 1's team totals for both weeks of his targets");
  t.equal(sk["00-X"].team_targets_i20, 10 + 10, "a player whose games all have totals is unaffected");
});

await run("leaderboard_redzone_shares");
