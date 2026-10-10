// The /api/standings D1 tables (production schemas, sqlite_master, ups-mfl-db, 2026-10-09) and a small 4-team season for
// the real worker route. Shared by tests/standings_playoff_flag.test.mjs and the client tests that feed its response to
// the real standings page code.
import { makeWorkerEnv } from "./worker_harness.mjs";

// Production schemas (sqlite_master, ups-mfl-db, 2026-10-09).
export const SCHEMA = `
CREATE TABLE src_franchises (season INTEGER NOT NULL, franchise_id TEXT NOT NULL, owner_name TEXT, team_name TEXT, division TEXT, logo TEXT, PRIMARY KEY (season, franchise_id));
CREATE TABLE src_standings (season INTEGER NOT NULL, franchise_id TEXT NOT NULL, franchise_name TEXT, owner_name TEXT, division TEXT,
  div_w INTEGER, div_l INTEGER, div_pct REAL, h2h_w INTEGER, h2h_l INTEGER, h2h_t INTEGER, h2h_pct REAL,
  allplay_w INTEGER, allplay_l INTEGER, allplay_t INTEGER, allplay_pct REAL, pf REAL, pp REAL, pwr REAL, eff REAL, salary TEXT,
  allplay_regseason_w INTEGER, allplay_regseason_l INTEGER, allplay_regseason_t INTEGER, allplay_playoff_w INTEGER, allplay_playoff_l INTEGER, allplay_playoff_t INTEGER,
  allplay_full_w INTEGER, allplay_full_l INTEGER, allplay_full_t INTEGER, allplay_historical_w INTEGER, allplay_historical_l INTEGER, allplay_historical_t INTEGER,
  PRIMARY KEY (season, franchise_id));
CREATE TABLE src_league_season_meta (season INTEGER PRIMARY KEY, league_id TEXT, mfl_server TEXT, last_regular_season_week INTEGER, total_weeks INTEGER, reg_weeks INTEGER, playoff_weeks INTEGER, notes TEXT);
CREATE TABLE src_final_standings (season INTEGER NOT NULL, franchise_id TEXT NOT NULL, final_finish INTEGER, regular_season_finish INTEGER, division TEXT, PRIMARY KEY (season, franchise_id));
CREATE TABLE src_schedule (season INTEGER NOT NULL, week INTEGER NOT NULL, franchise_id TEXT NOT NULL, opponent_franchise_id TEXT NOT NULL,
  franchise_name TEXT, opponent_franchise_name TEXT, franchise_owner TEXT, opponent_owner TEXT, is_home INTEGER, result TEXT,
  team_score REAL, opponent_score REAL, is_divisional INTEGER, is_playoff INTEGER, PRIMARY KEY (season, week, franchise_id, opponent_franchise_id));
CREATE TABLE src_franchise_weekly_score (season INTEGER NOT NULL, week INTEGER NOT NULL, franchise_id TEXT NOT NULL, team_score REAL, team_opt_pts REAL,
  is_playoff INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (season, week, franchise_id));`;

export const FIDS = ["0001", "0002", "0003", "0004"];
// flags[week] = is_playoff written for that week's games (both sides of 0001-0002 and 0003-0004).
export function makeEnv(flags) {
  const env = makeWorkerEnv({});
  const db = env.UPS_MFL_DB.raw;
  db.exec(SCHEMA);
  db.prepare("INSERT INTO src_league_season_meta (season, league_id, mfl_server) VALUES (2026, '74598', 'www48')").run();
  for (const f of FIDS) {
    db.prepare("INSERT INTO src_franchises (season, franchise_id, team_name, division) VALUES (2026, ?, ?, '01')").run(f, "Team " + f);
    db.prepare("INSERT INTO src_standings (season, franchise_id, h2h_w, h2h_l, h2h_t, h2h_pct, allplay_pct, pf) VALUES (2026, ?, 1, 1, 0, 0.5, 0.5, 400)").run(f);
  }
  const sched = db.prepare("INSERT INTO src_schedule (season, week, franchise_id, opponent_franchise_id, team_score, opponent_score, is_divisional, is_playoff) VALUES (2026, ?, ?, ?, ?, ?, 1, ?)");
  const score = db.prepare("INSERT INTO src_franchise_weekly_score (season, week, franchise_id, team_score, team_opt_pts, is_playoff) VALUES (2026, ?, ?, ?, ?, ?)");
  for (const [wk, flag] of Object.entries(flags)) {
    const w = Number(wk);
    for (const [a, b, as, bs] of [["0001", "0002", 110 + w, 100], ["0003", "0004", 90, 95 + w]]) {
      sched.run(w, a, b, as, bs, flag); sched.run(w, b, a, bs, as, flag);
      if (flag !== null) { score.run(w, a, as, as + 10, flag); score.run(w, b, bs, bs + 10, flag); }   // NOT NULL column: no NULL row possible
    }
  }
  return env;
}

// A current season that exercises every step of the seeding ladder (worker/src/seeding.js) through /api/standings.
// 8 teams, 4 divisions of 2. Division winners (by Overall within the division): 0001, 0003, 0005, 0007.
//   bye pool:   0001 vs 0003 — tied All-Play .700, 0001 ahead on Overall (.800 v .700)
//   seeds 3-6:  0004 v 0002 — tied All-Play, Overall AND Points For; 0004 beat 0002 → head-to-head
//               0002 v 0007 — All-Play .650 v .550
//               0007 v 0005 — tied All-Play and Overall; Points For 950 v 900
//   outside:    0006, 0008 — behind the last wild card (0002) on All-Play
export const LADDER_TEAMS = [
  ["0001", "A", 0.700, 0.800, 1000], ["0002", "A", 0.650, 0.500, 1100],
  ["0003", "B", 0.700, 0.700, 1200], ["0004", "B", 0.650, 0.500, 1100],
  ["0005", "C", 0.550, 0.600, 900],  ["0006", "C", 0.400, 0.400, 800],
  ["0007", "D", 0.550, 0.600, 950],  ["0008", "D", 0.400, 0.400, 800],
];
// Week 1: every team plays once (0004 beat 0002 — the head-to-head that splits their tie) and posts a score.
// failGames / failWeekly / failScores make that /api/standings query throw (D1 error), as #1201's tests do.
// po: the is_playoff value written for week 1 (default 0); null or a stray value models a malformed flag in D1.
export function makeLadderSeason({ recorded = false, failGames = false, failWeekly = false, failScores = false, po = 0 } = {}) {
  const env = makeWorkerEnv({});
  const db = env.UPS_MFL_DB.raw;
  db.exec(SCHEMA);
  db.prepare("INSERT INTO src_league_season_meta (season, league_id, mfl_server) VALUES (2026, '74598', 'www48')").run();
  for (const [fid, div, ap, ov, pf] of LADDER_TEAMS) {
    db.prepare("INSERT INTO src_franchises (season, franchise_id, team_name, division) VALUES (2026, ?, ?, ?)").run(fid, "Team " + fid, div);
    db.prepare("INSERT INTO src_standings (season, franchise_id, h2h_w, h2h_l, h2h_t, h2h_pct, allplay_pct, pf) VALUES (2026, ?, 1, 1, 0, ?, ?, ?)").run(fid, ov, ap, pf);
    if (recorded) db.prepare("INSERT INTO src_final_standings (season, franchise_id, final_finish) VALUES (2026, ?, 1)").run(fid);
  }
  const g = db.prepare("INSERT INTO src_schedule (season, week, franchise_id, opponent_franchise_id, team_score, opponent_score, is_divisional, is_playoff) VALUES (2026, 1, ?, ?, ?, ?, 0, ?)");
  const sc = db.prepare("INSERT INTO src_franchise_weekly_score (season, week, franchise_id, team_score, team_opt_pts, is_playoff) VALUES (2026, 1, ?, ?, ?, ?)");
  for (const [a, b, as, bs] of [["0004", "0002", 120, 100], ["0001", "0003", 130, 125], ["0005", "0007", 110, 115], ["0006", "0008", 95, 90]]) {
    g.run(a, b, as, bs, po); g.run(b, a, bs, as, po);
    const spo = po === null ? 0 : po;   // NOT NULL column: a NULL flag can only exist in src_schedule
    sc.run(a, as, as + 10, spo); sc.run(b, bs, bs + 10, spo);
  }
  const needles = [];
  if (failGames) needles.push("WHERE season = ? AND COALESCE(is_playoff, 0) = 0");
  if (failWeekly) needles.push("FROM src_schedule WHERE season = ? AND COALESCE(team_score, 0) > 0 ORDER BY week");
  if (failScores) needles.push("FROM src_franchise_weekly_score WHERE season = ?");
  if (needles.length) {
    const prep = env.UPS_MFL_DB.prepare.bind(env.UPS_MFL_DB);
    env.UPS_MFL_DB.prepare = (sql) => { if (needles.some((n) => sql.includes(n))) throw new Error("D1_ERROR: simulated failure"); return prep(sql); };
  }
  return env;
}
