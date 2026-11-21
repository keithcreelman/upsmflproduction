// Local D1 measurement for the two routes stage R2 adds. No production query: the tables are rebuilt from the repository's own migrations
// (real column names, primary keys and indexes) and filled with SYNTHETIC rows at production-like sizes, in a local Miniflare D1, whose
// `meta.rows_read` is D1's own counter. What it measures is the plan and the row counts, not real data.
//   node d1_rows_read.mjs ['{"weeks":10,"perWeek":950,"ff":12500}']
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
// Miniflare ships inside a globally installed wrangler: npm install -g wrangler
const GLOBAL = path.join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "wrangler", "node_modules", "miniflare", "dist", "src", "index.js");
const { Miniflare } = await import(pathToFileURL(GLOBAL).href);

const persist = fs.mkdtempSync(path.join(os.tmpdir(), "d1m-"));
const script = `
export default {
  async fetch(req, env) {
    const j = await req.json();
    if (j.batch) { const r = await env.DB.batch(j.batch.map((b) => env.DB.prepare(b.sql).bind(...(b.params || [])))); return Response.json({ ok: true, n: r.length }); }
    const r = await env.DB.prepare(j.sql).bind(...(j.params || [])).all();
    return Response.json({ n: (r.results || []).length, meta: r.meta, results: j.keep ? r.results : undefined });
  }
};`;
const mf = new Miniflare({ modules: true, script, d1Databases: { DB: "measure" }, d1Persist: persist });
const run = async (sql, params, keep) => (await mf.dispatchFetch("http://x/", { method: "POST", body: JSON.stringify({ sql, params, keep }) })).json();
const batch = async (list) => (await mf.dispatchFetch("http://x/", { method: "POST", body: JSON.stringify({ batch: list }) })).json();

// ---- schema: copied from the migrations (the weekly table keeps only the columns these queries touch; width does not change rows_read) ----
const DDL = [
  `CREATE TABLE player_id_map (mfl_id TEXT PRIMARY KEY, gsis_id TEXT, pfr_id TEXT, espn_id TEXT, mfl_position TEXT, status TEXT NOT NULL, accepted INTEGER NOT NULL DEFAULT 0, routes TEXT, checks TEXT, note TEXT, built_at TEXT)`,
  `CREATE INDEX idx_player_id_map_gsis ON player_id_map (gsis_id)`, `CREATE INDEX idx_player_id_map_pfr ON player_id_map (pfr_id)`,
  `CREATE TABLE ff_player_ids (mfl_id TEXT PRIMARY KEY, gsis_id TEXT, sleeper_id TEXT, ktc_id TEXT, fantasypros_id TEXT, pfr_id TEXT, espn_id TEXT, name TEXT, merge_name TEXT, position TEXT, team TEXT, birthdate TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX idx_ff_player_ids_gsis ON ff_player_ids(gsis_id)`, `CREATE INDEX idx_ff_player_ids_sleeper ON ff_player_ids(sleeper_id)`, `CREATE INDEX idx_ff_player_ids_ktc ON ff_player_ids(ktc_id)`,
  `CREATE TABLE nfl_team_pace (season INTEGER NOT NULL, team TEXT NOT NULL, games INTEGER, off_plays_pg REAL, def_plays_pg REAL, pace_sos REAL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (season, team))`,
  `CREATE TABLE nfl_player_weekly (season INTEGER NOT NULL, week INTEGER NOT NULL, gsis_id TEXT NOT NULL, team TEXT, pos_group TEXT, rush_att INTEGER, pass_att INTEGER, pass_sacks INTEGER, PRIMARY KEY (season, week, gsis_id))`,
  `CREATE INDEX idx_nflweekly_player ON nfl_player_weekly (gsis_id, season)`, `CREATE INDEX idx_nflweekly_seasonpos ON nfl_player_weekly (season, pos_group)`,
];
for (const sql of DDL) await run(sql);

// ---- synthetic rows, deterministic ----
let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const TEAMS = ["ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN", "DET", "GBP", "HOU", "IND", "JAC", "KCC", "LAC", "LAR", "LVR", "MIA", "MIN", "NEP", "NOS", "NYG", "NYJ", "PHI", "PIT", "SEA", "SFO", "TBB", "TEN", "WAS"];
const SIZES = JSON.parse(process.argv[2] || "{}");
const N_MAP = SIZES.idMap || 2295, N_ACCEPTED = SIZES.accepted || 2274, N_FF = SIZES.ff || 12500, PER_WEEK = SIZES.perWeek || 950, WEEKS = SIZES.weeks || 10;
const gsis = (i) => "00-" + String(30000 + i).padStart(7, "0");
const chunk = async (stmts) => { for (let i = 0; i < stmts.length; i += 80) await batch(stmts.slice(i, i + 80)); };
let st = [];
for (let i = 0; i < N_FF; i++) st.push({ sql: "INSERT INTO ff_player_ids (mfl_id, gsis_id, pfr_id, name) VALUES (?,?,?,?)", params: [String(10000 + i), i % 10 === 0 ? "NA" : gsis(i), "P" + i, "N" + i] });
await chunk(st); st = [];
for (let i = 0; i < N_MAP; i++) st.push({ sql: "INSERT INTO player_id_map (mfl_id, gsis_id, pfr_id, status, accepted) VALUES (?,?,?,?,?)", params: [String(10000 + i), gsis(i), "P" + i, "verified", i < N_ACCEPTED ? 1 : 0] });
await chunk(st); st = [];
// the weekly table: three seasons, so the season filter has something to NOT read (2024 and 2025 full, 2026 through WEEKS)
const seasons = [[2024, 18], [2025, 18], [2026, WEEKS]];
for (const [yr, wks] of seasons) for (let w = 1; w <= wks; w++) for (let k = 0; k < PER_WEEK; k++) {
  const i = Math.floor(rnd() * N_FF); const g = gsis(i);
  st.push({ sql: "INSERT OR IGNORE INTO nfl_player_weekly (season, week, gsis_id, team, pos_group, rush_att, pass_att, pass_sacks) VALUES (?,?,?,?,?,?,?,?)", params: [yr, w, g, TEAMS[i % 32], ["QB", "RB", "WR", "TE", "DL", "LB", "DB"][i % 7], Math.floor(rnd() * 20), Math.floor(rnd() * 30), Math.floor(rnd() * 3)] });
}
await chunk(st); st = [];
for (const [yr] of seasons) for (const t of TEAMS) st.push({ sql: "INSERT INTO nfl_team_pace (season, team, games, off_plays_pg, def_plays_pg) VALUES (?,?,?,?,?)", params: [yr, t, 10, 62.1, 61.4] });
await chunk(st);
const count = async (t) => (await run(`SELECT COUNT(*) AS c FROM ${t}`, [], true)).results[0].c;
const sizes = { player_id_map: await count("player_id_map"), ff_player_ids: await count("ff_player_ids"), nfl_player_weekly_all: await count("nfl_player_weekly"), nfl_player_weekly_2026: (await run("SELECT COUNT(*) AS c FROM nfl_player_weekly WHERE season = 2026", [], true)).results[0].c, nfl_team_pace: await count("nfl_team_pace") };

// ---- the queries, exactly as the worker runs them ----
const Q = {
  playerStatus: ["SELECT mfl_id, gsis_id, accepted FROM player_id_map", []],
  ctxTeams: ["WITH pw AS (  SELECT f.mfl_id AS m, w.week AS wk, w.team AS t    FROM nfl_player_weekly w JOIN ff_player_ids f ON f.gsis_id = w.gsis_id   WHERE w.season = ?1 AND w.week BETWEEN 1 AND 18 AND w.team IS NOT NULL AND w.team <> ''     AND f.mfl_id IS NOT NULL AND f.gsis_id NOT IN ('', 'NA')), agg AS (SELECT m, MIN(t) AS t, MIN(wk) AS lo, MAX(wk) AS hi, COUNT(DISTINCT t) AS n FROM pw GROUP BY m) SELECT m, t, lo, hi, NULL AS wk FROM agg WHERE n = 1 UNION ALL SELECT pw.m, pw.t, NULL, NULL, pw.wk FROM pw JOIN agg ON agg.m = pw.m WHERE agg.n > 1", [2026]],
  ctxPlays: ["SELECT week, team, SUM(COALESCE(rush_att,0)+COALESCE(pass_att,0)+COALESCE(pass_sacks,0)) AS plays FROM nfl_player_weekly WHERE season = ?1 AND week BETWEEN 1 AND 18 GROUP BY week, team", [2026]],
  ctxPace: ["SELECT team, off_plays_pg, def_plays_pg FROM nfl_team_pace WHERE season = ?1", [2026]],
};
const out = { sizes, queries: {} };
for (const [k, [sql, params]] of Object.entries(Q)) {
  const r = await run(sql, params, false);
  const plan = (await run("EXPLAIN QUERY PLAN " + sql, params, true)).results.map((x) => x.detail);
  out.queries[k] = { rows_returned: r.n, rows_read: r.meta.rows_read, plan };
}
out.totals = { playerStatusPerUncachedCall: out.queries.playerStatus.rows_read, matchupsSeasonContextPerColdLoad: out.queries.ctxTeams.rows_read + out.queries.ctxPlays.rows_read + out.queries.ctxPace.rows_read };
console.log(JSON.stringify(out, null, 1));
await mf.dispose(); fs.rmSync(persist, { recursive: true, force: true });
