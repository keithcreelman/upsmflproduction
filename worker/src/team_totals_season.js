// Each NFL team's box-score totals per game for one season, for share denominators in the player
// game log (/api/player-weekly-box): target share, carry share, catch share, air-yards share and
// pass-attempt context. A team's total is the sum of its players' nflverse rows that week (the same
// sum /api/advanced-stats-player-weekly runs per request over whole seasons). The answer is the same
// for everyone on the team, so it is built once per season (~one row per player-week of the season,
// about 10.6k rows through Week 10 of 2026) and kept at the edge, like ./team_snaps_season.js.
//
// Sums keep "missing is not zero": SUM() skips NULLs and is NULL only when every player row is NULL.
// rec_air_missing counts the team's rows with targets but no receiving air yards, so a caller can tell
// a complete air-yards total from a partial one instead of trusting a short sum. Dropbacks are not
// stored (scrambles have no column), so only pass attempts and sacks are given.
//
// Freshness: the key carries etl_runs.last_run_utc for 'nflverse_weekly' (box scores) and
// 'pfr_advstats' (which back-fills receiving_air_yards), stamped by nflverse-stats-refresh after
// every run. max-age is the backstop for an unstamped writer.
//
// Failure: null whenever it can't stand behind a cached answer (no nflverse_weekly stamp, no edge
// cache, a failed read). The route then checks coversTeams() and otherwise runs the per-player join
// (TEAM_TOTALS_JOIN_SQL), so the answer never changes; only the cost does.

export const TEAM_TOTALS_TTL_S = 3600;
const QUERY_VERSION = "1";   // bump when TEAM_TOTALS_SQL / TEAM_TOTALS_FIELDS change

export const TEAM_TOTALS_FIELDS = ["targets", "receptions", "rush_att", "pass_att", "pass_sacks",
  "rec_air_yards", "rec_air_missing", "pass_air_yards"];

const SUMS =
  "SUM(t.targets) AS targets, SUM(t.receptions) AS receptions, SUM(t.rush_att) AS rush_att, " +
  "SUM(t.pass_att) AS pass_att, SUM(t.pass_sacks) AS pass_sacks, SUM(t.receiving_air_yards) AS rec_air_yards, " +
  "SUM(CASE WHEN t.targets > 0 AND t.receiving_air_yards IS NULL THEN 1 ELSE 0 END) AS rec_air_missing, " +
  "SUM(t.passing_air_yards) AS pass_air_yards";

// One read of the season (primary key (season, week, gsis_id), so a season-range search, no other table).
export const TEAM_TOTALS_SQL =
  "SELECT t.week, t.team, " + SUMS + " FROM nfl_player_weekly t WHERE t.season = ? AND t.team IS NOT NULL GROUP BY t.team, t.week";

// The per-player form: only his (week, team) pairs, each read through the (season, week) key prefix
// (about one week of league rows per game he played). Used only when no season table can be trusted.
// CROSS JOIN fixes the loop order (SQLite never reorders it): with a plain JOIN and no sqlite_stat1
// the planner drives from t by (season) and reads the whole season instead (EXPLAIN in the tests).
export const TEAM_TOTALS_JOIN_SQL =
  "SELECT t.week, t.team, " + SUMS + " FROM " +
  "(SELECT week, team FROM nfl_player_weekly WHERE season = ? AND gsis_id = ? AND team IS NOT NULL) p " +
  "CROSS JOIN nfl_player_weekly t ON t.season = ? AND t.week = p.week AND t.team = p.team GROUP BY t.team, t.week";

const entryOf = (r) => { const e = {}; for (const f of TEAM_TOTALS_FIELDS) e[f] = r[f] == null ? null : Number(r[f]); return e; };

export function totalsMap(rows) {
  const map = {};
  for (const r of rows || []) if (r.team != null) map[r.week + "|" + r.team] = entryOf(r);
  return map;
}

// A season table answers for a player only when it holds a well-formed entry for every (week, team)
// of his box rows (numbers or null in every field). Anything else: the route runs the per-player join.
export function coversTeams(map, boxRows) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return false;
  const ok = (v) => v === null || (typeof v === "number" && Number.isFinite(v));
  return (boxRows || []).every((r) => {
    if (r.team == null) return true;
    const e = map[r.week + "|" + r.team];
    return !!e && typeof e === "object" && TEAM_TOTALS_FIELDS.every((f) => f in e && ok(e[f]));
  });
}

async function stampsOf(db) {
  try {
    const rows = (await db.prepare(
      "SELECT source, last_run_utc FROM etl_runs WHERE source IN ('nflverse_weekly', 'pfr_advstats')").all()).results || [];
    const by = {};
    for (const r of rows) if (r && r.last_run_utc) by[r.source] = String(r.last_run_utc);
    return by.nflverse_weekly ? by : null;
  } catch (_) {
    return null;   // pre-0084 database: no stamp
  }
}

// { "week|team": { targets, receptions, ... } } for the season, or null (caller reads per player).
export async function seasonTeamTotals(db, season, ctx, cache) {
  if (!cache) return null;
  const st = await stampsOf(db);
  if (!st) return null;
  const key = new Request("https://upsmfl-stats.local/team-totals-season?" + new URLSearchParams({
    season: String(season), w: st.nflverse_weekly, p: st.pfr_advstats || "none", q: QUERY_VERSION }).toString(), { method: "GET" });
  try {
    const hit = await cache.match(key);
    if (hit) return await hit.json();
  } catch (_) {
    return null;
  }
  let rows;
  try {
    rows = (await db.prepare(TEAM_TOTALS_SQL).bind(season).all()).results || [];
  } catch (_) {
    return null;
  }
  const map = totalsMap(rows);
  try {
    const put = cache.put(key, new Response(JSON.stringify(map), {
      headers: { "content-type": "application/json", "Cache-Control": `public, max-age=${TEAM_TOTALS_TTL_S}` } }));
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(put.catch(() => {})); else await put;
  } catch (_) { /* answered anyway */ }
  return map;
}
