// GET /api/player-projections?season=YYYY&week=W&ids=a,b,c  (r6 draft, read-only)
//
// The captured MFL projection for each listed player and week, from ups_player_projections
// (migration 0123), written by pipelines/etl/scripts/ingest_projections.py (cron Wed 12:00, Thu 20:00,
// Fri 12:00, Sun 11:00/13:00/15:00 UTC). Since 2026-10-27 that writer skips a player once his club's
// game has kicked off, so `projected_score` / `updated_at` is his last capture before kickoff; rows
// for Weeks 1-7 were written before that rule and are mostly post-kickoff (research v4 §4).
//
// This route does NOT decide "pregame": it returns the capture times, and the caller compares
// `updated_at` (and, failing that, `first_captured_at` with `first_projected`) with the kickoff of
// the game the player actually played (his stat-row club, joined to the schedule). A capture at or
// after kickoff is never a pregame number. A player with no row is null, never 0.
//
// Cost: one primary-key search (season, week, player_id) per listed id, so rows read <= ids
// (at most MAX_IDS). Edge-cached 5 minutes by the shared stat cache (path + sorted query).

export const MAX_IDS = 80;

export function parseIds(raw) {
  const seen = new Set(), out = [];
  for (const part of String(raw || "").split(",")) {
    const id = part.replace(/\D/g, "");
    if (!id || id.length > 8 || seen.has(id)) continue;
    seen.add(id); out.push(id);
  }
  return out;
}

const iso = (unix) => (unix == null || !Number.isFinite(Number(unix)) ? null : new Date(Number(unix) * 1000).toISOString());

export async function readProjections(db, season, week, ids) {
  if (!ids.length) return {};
  const sql = "SELECT player_id, projected_score, first_projected, first_captured_at, updated_at, capture_count " +
    "FROM ups_player_projections WHERE season = ? AND week = ? AND player_id IN (" + ids.map(() => "?").join(",") + ")";
  const rows = ((await db.prepare(sql).bind(season, week, ...ids).all()) || {}).results || [];
  const out = {};
  for (const id of ids) out[id] = null;
  for (const r of rows) {
    out[String(r.player_id)] = {
      projected_score: r.projected_score == null ? null : Number(r.projected_score),
      captured_at: iso(r.updated_at),                 // the latest capture (frozen at his kickoff since 2026-10-27)
      first_projected: r.first_projected == null ? null : Number(r.first_projected),
      first_captured_at: iso(r.first_captured_at),
      capture_count: r.capture_count == null ? null : Number(r.capture_count),
    };
  }
  return out;
}
