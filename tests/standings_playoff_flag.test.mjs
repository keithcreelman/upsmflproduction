// /api/standings never guesses a playoff flag (Keith 2026-10-09: "If it converts malformed input to regular season before
// F3 sees it, F3 is not effective end to end"). The standings race module fails closed on an unrecognized `po`, so the
// worker must send one through as null instead of collapsing it to 0, and must send a failed weekly query as null + an
// error instead of an empty array (an empty array reads as "nothing played yet").
//   node tests/standings_playoff_flag.test.mjs
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet } from "./fixtures/worker_harness.mjs";

const restore = quiet();
const mfl = makeMfl();
mfl.install();

// Production schemas (sqlite_master, ups-mfl-db, 2026-10-09).
const SCHEMA = `
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

const FIDS = ["0001", "0002", "0003", "0004"];
// flags[week] = is_playoff written for that week's games (both sides of 0001-0002 and 0003-0004).
function makeEnv(flags) {
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
const standings = async (env) => {
  const r = await callWorker(env, "GET", "/api/standings?year=2026");
  t.equal(r.status, 200, r.text.slice(0, 200));
  return r.json;
};
const poByWeek = (arr) => { const o = {}; for (const x of arr) (o[x.w] = o[x.w] || new Set()).add(x.po === null ? "null" : x.po); return Object.fromEntries(Object.entries(o).map(([w, s]) => [w, [...s]])); };

test("explicit flags pass through exactly: 0 -> po 0, 1 -> po 1 (the live 2026 shape is unchanged)", async () => {
  const j = await standings(makeEnv({ 1: 0, 2: 0, 15: 1 }));
  t.deepEqual(poByWeek(j.weekly), { 1: [0], 2: [0], 15: [1] });
  t.deepEqual(poByWeek(j.weeklyScores), { 1: [0], 2: [0], 15: [1] });
  t.ok(j.weekly.every((x) => typeof x.po === "number") && j.weeklyScores.every((x) => typeof x.po === "number"), "valid flags stay numbers");
  t.equal(j.weekly_errors, undefined, "no error key when both queries succeed");
});

test("an unrecognized flag is sent as null, never collapsed to 0 (regular season)", async () => {
  // NULL is possible only in src_schedule (nullable); a stray value is possible in both tables (INTEGER affinity keeps "x" as text).
  const j = await standings(makeEnv({ 1: 0, 2: null, 3: 2, 4: "x", 5: 1 }));
  t.deepEqual(poByWeek(j.weekly), { 1: [0], 2: ["null"], 3: ["null"], 4: ["null"], 5: [1] });
  t.deepEqual(poByWeek(j.weeklyScores), { 1: [0], 3: ["null"], 4: ["null"], 5: [1] });
  t.equal(j.weekly.filter((x) => x.po === 0).length, 4, "only week 1's four rows are regular season — weeks 2-4 are NOT");
});

test("a failed weekly query is null + an error, not an empty array; the rest of the response still loads", async () => {
  for (const [needle, key, other] of [["FROM src_schedule WHERE season = ? AND COALESCE(team_score, 0) > 0 ORDER BY week", "weekly", "weeklyScores"],
                                      ["FROM src_franchise_weekly_score WHERE season = ?", "weeklyScores", "weekly"]]) {
    const env = makeEnv({ 1: 0, 2: 0 });
    const prep = env.UPS_MFL_DB.prepare.bind(env.UPS_MFL_DB);
    env.UPS_MFL_DB.prepare = (sql) => { if (sql.includes(needle)) throw new Error("D1_ERROR: simulated " + key + " failure"); return prep(sql); };
    const j = await standings(env);
    t.equal(j[key], null, key + " must be null, not []");
    t.match(j.weekly_errors[key], /simulated/);
    t.ok(Array.isArray(j[other]) && j[other].length > 0, other + " is unaffected");
    t.equal(j.rows.length, 4, "rows still load");
  }
});

test("a genuinely empty season is still an empty array (no error)", async () => {
  const j = await standings(makeEnv({}));
  t.deepEqual(j.weekly, []); t.deepEqual(j.weeklyScores, []);
  t.equal(j.weekly_errors, undefined);
});

await run("standings_playoff_flag");
mfl.restore();
restore();
