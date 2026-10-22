// Each NFL team's offensive / defensive snaps per game for one season, for the player game log
// (/api/player-weekly-box). A team's snaps are read off its most-used player that game
// (max snaps / max share; exact when someone played 100%), the same SQL the route used to run per
// player. The per-player version joined every player's snap rows for each week the player played:
// ~13k D1 rows per game-log view, for an answer that is the same for everyone on the team. This
// builds the whole season once (~17k rows) and keeps it at the edge.
//
// Freshness: the cache key carries etl_runs.last_run_utc for 'nflverse_snaps', which the
// nflverse-stats-refresh workflow stamps after every snap-count run (ok, not_published or error),
// so a refresh is picked up on the next view. max-age is the backstop for a writer that doesn't
// stamp (scripts/load_local_to_d1.py): at most an hour.
//
// Failure: returns null whenever it can't stand behind a cached answer (no stamp, no edge cache,
// a failed read), and the route checks coversPlayer() before using a table at all. Either way the
// route then runs the per-player join exactly as before, so the data never changes; only the cost does.

export const TEAM_SNAPS_TTL_S = 3600;
const QUERY_VERSION = "1";   // bump when TEAM_SNAPS_SQL changes, so no old answer is served

const TEAM_SNAPS_SQL =
  "SELECT week, team, " +
  "CAST(ROUND(MAX(off_snaps) * 1.0 / NULLIF(MAX(CASE WHEN off_snaps > 0 THEN off_snap_pct END), 0)) AS INTEGER) AS team_off, " +
  "CAST(ROUND(MAX(def_snaps) * 1.0 / NULLIF(MAX(CASE WHEN def_snaps > 0 THEN def_snap_pct END), 0)) AS INTEGER) AS team_def " +
  "FROM nfl_player_snaps WHERE season = ? GROUP BY week, team";

// A season table answers for a player only when it is an object holding a well-formed entry for
// every (week, team) of his snap rows. An empty {}, one built mid-refresh that lacks his game, or
// any odd value fails, and the route runs the per-player join, so a short or malformed cache entry
// can never blank his team snaps (Codex #1380 MAT-1).
export function coversPlayer(map, snapRows) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return false;
  const ok = (v) => v === null || (typeof v === "number" && Number.isFinite(v));
  return (snapRows || []).every((r) => {
    if (r.team == null) return true;   // the join never matched a team-less row either
    const e = map[r.week + "|" + r.team];
    return !!e && typeof e === "object" && ok(e.team_off) && ok(e.team_def);
  });
}

// { "week|team": { team_off, team_def } } for the season, or null (caller reads per player).
export async function seasonTeamSnaps(db, season, ctx, cache) {
  if (!cache) return null;
  let stamp = null;
  try {
    const row = await db.prepare("SELECT last_run_utc FROM etl_runs WHERE source = 'nflverse_snaps'").first();
    stamp = row && row.last_run_utc ? String(row.last_run_utc) : null;
  } catch (_) { /* pre-0084 database: no stamp */ }
  if (!stamp) return null;
  const key = new Request("https://upsmfl-stats.local/team-snaps-season?" + new URLSearchParams({
    season: String(season), v: stamp, q: QUERY_VERSION }).toString(), { method: "GET" });
  try {
    const hit = await cache.match(key);
    if (hit) return await hit.json();
  } catch (_) {
    return null;   // the edge cache is misbehaving: don't pay for a season table it may not keep
  }
  let rows;
  try {
    rows = (await db.prepare(TEAM_SNAPS_SQL).bind(season).all()).results || [];
  } catch (_) {
    return null;
  }
  const map = {};
  // The per-player join matched on team, and NULL never equals NULL: skip team-less rows too.
  for (const r of rows) if (r.team != null) map[r.week + "|" + r.team] = { team_off: r.team_off, team_def: r.team_def };
  try {
    const put = cache.put(key, new Response(JSON.stringify(map), {
      headers: { "content-type": "application/json", "Cache-Control": `public, max-age=${TEAM_SNAPS_TTL_S}` } }));
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(put.catch(() => {})); else await put;
  } catch (_) { /* answered anyway; the next view tries to store it again */ }
  return map;
}
