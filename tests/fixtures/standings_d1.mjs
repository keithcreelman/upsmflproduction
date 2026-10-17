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

// A season built from weekly scores, the way the live sync writes it: one score per franchise per week
// (src_franchise_weekly_score), each game from both sides (src_schedule, result from the scores), and
// src_standings totals summed over EVERY week given (playoff weeks included, as the sync does).
//   weeks: [{ week, po, scores: { fid: score }, games: [[a, b], ...] }]
//   divisions: { fid: division }
export function weeklySeason({ weeks, divisions, lastRegularSeasonWeek = 14, season = 2026 }) {
  const pad = (v) => String(v).padStart(4, "0");
  const fids = Object.keys(divisions).map(pad);
  const franchises = fids.map((f) => ({ franchise_id: f, franchise_name: "Team " + f, division: divisions[f] ?? divisions[Number(f)] }));
  const weeklyScores = [], games = [];
  for (const wk of weeks) {
    for (const [f, s] of Object.entries(wk.scores)) weeklyScores.push({ season, week: wk.week, franchise_id: pad(f), team_score: s, team_opt_pts: s + 10, is_playoff: wk.po ?? 0 });
    for (const [a, b] of wk.games || []) {
      const as = wk.scores[a], bs = wk.scores[b];
      const div = franchises.find((x) => x.franchise_id === pad(a)).division === franchises.find((x) => x.franchise_id === pad(b)).division ? 1 : 0;
      for (const [x, y, xs, ys] of [[a, b, as, bs], [b, a, bs, as]]) {
        games.push({ season, week: wk.week, franchise_id: pad(x), opponent_franchise_id: pad(y), team_score: xs, opponent_score: ys, result: xs > ys ? "W" : xs < ys ? "L" : "T", is_divisional: div, is_playoff: wk.po ?? 0 });
      }
    }
  }
  return { season, lastRegularSeasonWeek, franchises, weeklyScores, games };
}

// Load a season (weeklySeason's shape, or the recorded tests/fixtures/standings_2026_wk5.json) into the
// worker harness D1, with src_standings totals the way the live sync computes them (all weeks).
export function loadSeason(env, s) {
  const db = env.UPS_MFL_DB.raw;
  db.exec(SCHEMA);
  const season = s.season;
  const lastReg = s.lastRegularSeasonWeek;
  db.prepare("INSERT INTO src_league_season_meta (season, league_id, mfl_server, last_regular_season_week, playoff_weeks) VALUES (?, '74598', 'www48', ?, 3)").run(season, lastReg);
  const fr = s.franchises;
  const ws = s.weeklyScores || s.weekly_scores;
  for (const f of fr) db.prepare("INSERT INTO src_franchises (season, franchise_id, team_name, division) VALUES (?, ?, ?, ?)").run(season, f.franchise_id, f.franchise_name, f.division);
  for (const r of ws) db.prepare("INSERT INTO src_franchise_weekly_score (season, week, franchise_id, team_score, team_opt_pts, is_playoff) VALUES (?, ?, ?, ?, ?, ?)").run(season, r.week, r.franchise_id, r.team_score, r.team_opt_pts ?? 0, r.is_playoff);
  for (const g of s.games) db.prepare("INSERT INTO src_schedule (season, week, franchise_id, opponent_franchise_id, team_score, opponent_score, result, is_divisional, is_playoff) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(season, g.week, g.franchise_id, g.opponent_franchise_id, g.team_score, g.opponent_score, g.result || null, g.is_divisional ?? 0, g.is_playoff);
  // src_standings as the sync writes it: every week it was given, playoff weeks included.
  for (const f of fr) {
    const mine = ws.filter((r) => r.franchise_id === f.franchise_id);
    let w = 0, l = 0, t = 0, dw = 0, dl = 0, apw = 0, apl = 0, apt = 0, pf = 0;
    for (const r of mine) {
      pf += Number(r.team_score);
      for (const o of ws) if (o.week === r.week && o.franchise_id !== f.franchise_id) { if (r.team_score > o.team_score) apw++; else if (r.team_score < o.team_score) apl++; else apt++; }
    }
    for (const g of s.games.filter((x) => x.franchise_id === f.franchise_id)) {
      const k = g.team_score > g.opponent_score ? "w" : g.team_score < g.opponent_score ? "l" : "t";
      if (k === "w") w++; else if (k === "l") l++; else t++;
      if (g.is_divisional) { if (k === "w") dw++; else if (k === "l") dl++; }
    }
    const pct = (a, b, c) => (a + b + c ? (a + 0.5 * c) / (a + b + c) : 0);
    db.prepare("INSERT INTO src_standings (season, franchise_id, h2h_w, h2h_l, h2h_t, h2h_pct, div_w, div_l, div_pct, allplay_w, allplay_l, allplay_t, allplay_pct, pf) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(season, f.franchise_id, w, l, t, pct(w, l, t), dw, dl, pct(dw, dl, 0), apw, apl, apt, pct(apw, apl, apt), Math.round(pf * 100) / 100);
  }
  return env;
}

// The recorded 2026-after-Week-5 season (tests/fixtures/standings_2026_wk5.json) in loadSeason's shape.
export function recorded2026(rec) {
  return { season: rec.season, lastRegularSeasonWeek: rec.lastRegularSeasonWeek, franchises: rec.franchises, weeklyScores: rec.weekly_scores, games: rec.games, standingsSort: rec.standingsSort, divisions: rec.divisions };
}
