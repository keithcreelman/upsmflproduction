// Identity, absent-vs-zero and the two new read routes (2026-10-10 Players audit).
//   node tests/players_data_paths.test.mjs
//
//   * a 2026 rookie has no player_id_crosswalk row (it was last built before
//     the draft): the verified player_id_map (0170) must supply his MFL id,
//     MFL position, contract join and snap counts on the leaderboard, and his
//     weekly box score on /api/player-weekly-box;
//   * a name-only `fuzzy_auto` crosswalk row never resolves a player;
//   * a PFR stat with no PFR record is NULL ("—"), never 0;
//   * /api/player-starter-rates grades only final, synced weeks.
// Real route, node:sqlite, production schema + migrations 0169 and 0170.
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, callWorker, quiet } from "./fixtures/fcfs_worker_harness.mjs";

const SCHEMA = fs.readFileSync("tests/fixtures/leaderboard_schema_pre0169.sql", "utf8");
const MIG = ["0169_redzone_v2_epa_through_week.sql", "0170_player_id_map.sql"].map((f) => fs.readFileSync("worker/migrations/" + f, "utf8"));

function setup() {
  const env = makeWorkerEnv();
  const db = env.UPS_MFL_DB.raw;
  db.exec(SCHEMA); MIG.forEach((m) => db.exec(m));
  const wk = db.prepare(`INSERT INTO nfl_player_weekly (season, week, gsis_id, position, pos_group, team, def_tackles_solo, def_tackles_ast,
                           def_pressures, def_completions_allowed, def_yards_allowed, targets, receptions, rec_yds)
                         VALUES (2026, ?, ?, ?, ?, 'AAA', ?, ?, ?, ?, ?, ?, ?, ?)`);
  const map = db.prepare("INSERT INTO player_id_map (mfl_id, gsis_id, pfr_id, status, accepted) VALUES (?, ?, ?, ?, ?)");
  const xw = db.prepare("INSERT INTO player_id_crosswalk (mfl_player_id, gsis_id, pfr_id, confidence) VALUES (?, ?, ?, ?)");
  const sn = db.prepare("INSERT INTO nfl_player_snaps (season, week, pfr_id, team, off_snaps, def_snaps, st_snaps) VALUES (2026, ?, ?, 'AAA', ?, ?, ?)");
  const sp = db.prepare("INSERT INTO src_players (season, player_id, nfl_team, position) VALUES (2026, ?, 'AAA', ?)");
  // ROOK: a 2026 rookie LB — only in the verified map. Two PFR-recorded weeks.
  map.run("17600", "00-ROOK", "RookRo00", "verified", 1); sp.run("17600", "LB");
  wk.run(1, "00-ROOK", "LB", "LB", 5, 2, 3, 2, 20, 0, 0, 0); sn.run(1, "RookRo00", 0, 55, 10);
  wk.run(2, "00-ROOK", "LB", "LB", 6, 1, 1, 0, null, 0, 0, 0); sn.run(2, "RookRo00", 0, 60, 8);
  db.prepare("INSERT INTO nfl_player_weekly_ext (season, week, gsis_id, def_targets) VALUES (2026, 1, '00-ROOK', 3), (2026, 2, '00-ROOK', 2)").run();
  // NOPFR: a veteran DB PFR never recorded — every PFR column NULL.
  xw.run(14000, "00-NOPFR", "NopfNo00", "exact"); sp.run("14000", "CB");
  wk.run(1, "00-NOPFR", "CB", "DB", 4, 0, null, null, null, 0, 0, 0);
  // FUZZ: a crosswalk row matched by NAME only (it claims someone else's gsis) and no map row.
  xw.run(17487, "00-WRONG", "WronWr00", "fuzzy_auto");
  wk.run(1, "00-WRONG", "RB", "RB", 0, 0, null, null, null, 2, 1, 9);
  return { env, db };
}
const get = async (env, p) => { const r = quiet(); try { return await callWorker(env, "GET", p); } finally { r(); } };

test("a rookie with no crosswalk row: MFL id, MFL position and snaps come from the verified map; Snap% counts only his games", async () => {
  const { env, db } = setup();
  // his team's defensive snaps: a 100% defender in Wk 1 (60), a 95% one in Wk 2 (60/0.95 ≈ 63); Wk 3 he sat (no defensive snaps)
  const sn = db.prepare("INSERT INTO nfl_player_snaps (season, week, pfr_id, team, off_snaps, def_snaps, def_snap_pct, st_snaps) VALUES (2026, ?, ?, 'AAA', 0, ?, ?, 0)");
  sn.run(1, "FullFu00", 60, 1.0); sn.run(2, "FullFu00", 60, 0.95); sn.run(3, "FullFu00", 58, 1.0);
  db.prepare("INSERT INTO nfl_player_snaps (season, week, pfr_id, team, off_snaps, def_snaps, def_snap_pct, st_snaps) VALUES (2026, 3, 'RookRo00', 'AAA', 0, 0, 0, 12)").run();
  const r = await get(env, "/api/advanced-stats-leaderboard?season=2026&pos=idp&YEAR=2026&L=74598&min_games=1&limit=200&NO_PRECOMPUTE=1&NO_CACHE=1");
  const rook = r.json.rows.find((x) => x.gsis_id === "00-ROOK");
  t.deepEqual([String(rook.mfl_pid), rook.mfl_position, rook.def_snaps_total], ["17600", "LB", 115]);
  t.equal(rook.def_snaps_team, 60 + 63, "team defensive snaps in the two games he played on defense; Wk 3 (special teams only) is out");
});

test("PFR: no record is NULL ('—'), not 0; a recorded 0 completions makes 0 yards certain", async () => {
  const { env } = setup();
  const r = await get(env, "/api/advanced-stats-leaderboard?season=2026&pos=idp&YEAR=2026&L=74598&min_games=1&limit=200&NO_PRECOMPUTE=1&NO_CACHE=1");
  const by = Object.fromEntries(r.json.rows.map((x) => [x.gsis_id, x]));
  t.deepEqual([by["00-NOPFR"].def_pressures, by["00-NOPFR"].def_completions_allowed, by["00-NOPFR"].def_yards_allowed, by["00-NOPFR"].def_pfr_wks],
    [null, null, null, 0], "never charted by PFR: every PFR column is null");
  t.deepEqual([by["00-ROOK"].def_pressures, by["00-ROOK"].def_completions_allowed, by["00-ROOK"].def_yards_allowed, by["00-ROOK"].def_pfr_wks],
    [4, 2, 20, 2], "Wk 2 had 0 completions allowed and no yards field: 0 yards, not NULL");
  t.deepEqual([by["00-ROOK"].def_targets, by["00-NOPFR"].def_targets], [5, null], "targets in coverage from the _ext table; none recorded = NULL");
  t.equal(by["00-NOPFR"].def_tackles_total, 4, "box-score stats are unaffected");
});

test("/api/player-weekly-box: map first, nulls kept, and a name-only crosswalk row resolves NOBODY", async () => {
  const { env } = setup();
  const rook = await get(env, "/api/player-weekly-box?season=2026&mfl_id=17600&L=74598");
  t.deepEqual([rook.json.gsis_id, rook.json.pfr_id, rook.json.id_source, rook.json.box_through_week], ["00-ROOK", "RookRo00", "player_id_map:verified", 2]);
  t.deepEqual(rook.json.weeks.map((w) => [w.week, w.box.def_pressures, w.box.def_yards_allowed, w.snaps.def]), [[1, 3, 20, 55], [2, 1, null, 60]],
    "stored values as they are: an absent field stays null on the weekly row");
  const fz = await get(env, "/api/player-weekly-box?season=2026&mfl_id=17487&L=74598");
  t.deepEqual([fz.json.gsis_id, fz.json.id_source, fz.json.weeks.length], [null, "none", 0], "the fuzzy row is ignored: an empty log, not someone else's games");
});

test("/api/player-starter-rates: final, synced weeks only — later weeks are pending, never graded", async () => {
  const { env, db } = setup();
  const sw = db.prepare("INSERT INTO src_weekly (season, week, player_id, pos_group, status, score, is_reg, roster_franchise_id) VALUES (2026, ?, ?, 'LB', ?, ?, 1, ?)");
  // six LB starters a week for Wks 1-2 (the minimum pool), ROOK on the bench scoring above the median in Wk 1
  for (const w of [1, 2]) for (let i = 0; i < 6; i++) {
    const pid = String(18000 + i);
    sw.run(w, pid, "starter", 4 + i * 2, "000" + (i % 2 + 1));   // two franchises, three starters each
    db.prepare("INSERT INTO player_id_map (mfl_id, gsis_id, pfr_id, status, accepted) VALUES (?, ?, ?, 'verified', 1) ON CONFLICT DO NOTHING").run(pid, "00-S" + i, "Strt" + i);
    db.prepare("INSERT INTO nfl_player_snaps (season, week, pfr_id, team, off_snaps, def_snaps, st_snaps) VALUES (2026, ?, ?, 'AAA', 0, 50, 0)").run(w, "Strt" + i);
  }
  sw.run(1, "17600", "nonstarter", 12, "0001"); sw.run(2, "17600", "nonstarter", 3, "0001");
  // Wk 3: only one franchise's lineup has synced -> pending, never graded
  sw.run(3, "18000", "starter", 9, "0001");
  db.prepare("INSERT INTO nfl_player_snaps (season, week, pfr_id, team, off_snaps, def_snaps, st_snaps) VALUES (2026, 3, 'Strt0', 'AAA', 0, 50, 0)").run();
  const r = await get(env, "/api/player-starter-rates?season=2026&L=74598&group=LB");
  t.equal(r.status, 200, JSON.stringify(r.json).slice(0, 300));
  // The harness's MFL answers live scoring; whatever week it calls complete, only weeks
  // whose starters AND snap counts have synced (1-2 here) are graded — the rest are pending.
  t.ok(["mfl_live_scoring", "synced_data_only"].includes(r.json.week_authority), r.json.week_authority);
  t.deepEqual(r.json.final_weeks, [1, 2], "Wk 3 has one of two franchises' lineups: pending, not graded");
  t.ok(r.json.pending_weeks.includes(3));
  t.deepEqual(r.json.pending_weeks, Array.from({ length: Math.max(0, r.json.completed_week - 2) }, (_, i) => i + 3), "later weeks pending, not graded");
  const p = r.json.players["17600"];
  t.deepEqual([p.q, p.startable_n, p.boom_n, p.bust_n, p.startable_pct], [2, 1, 1, 1, null], "a bench player is graded against the starters; % needs 3 weeks");
  t.equal(r.json.thresholds["1"].LB.n, 6);
});

await run("players_data_paths");
