// Per-week team coverage for the current-season leaderboard precompute —
// PROVISIONAL vs FINALIZED (2026-09-28).
//
// Extracted as its own small, importable module for the same reason
// worker/src/extension_eligibility.js and worker/src/restructure_cap.js are:
// this logic is a real business rule (not incidental plumbing), and the
// surrounding route in worker/src/index.js is thousands of lines with no
// module-level exports of its own — bare source-text assertions would be the
// only way to test it there. Here it can be imported and run directly.
//
// THE RULE Keith gave (2026-09-28): "wait for all 32 teams" governs calling a
// week FINALIZED, never whether to load/show it at all. So:
//   - a week is COMPLETE once every team the schedule expected has reported
//     (teams_reported >= teams_expected, teams_expected > 0 — never a
//     hardcoded 32, so bye weeks resolve correctly).
//   - a week is FINALIZED (safe to tell an owner "this is done") only when
//     it is ALSO complete per the real-world schedule/live-scoring clock
//     (authoritative_week has reached it) — completeness alone is not
//     enough if the two disagree on WHICH week that even is.
//   - built_for_week (what the precompute has data for) can be AHEAD of
//     finalized_through_week — that gap IS "provisional."
//
// FAIL CLOSED throughout: an unresolvable input is never read as "complete"
// or "finalized" — it comes back null, and null must never be treated as 0
// (0 of 0 is not 100%) or as "matches, so skip the rebuild."

// Is the LATEST built week complete? null = unknown (a read failed, or the
// schedule table has no rows yet for this week) — never coerced to false NOR
// true.
export function computeWeekComplete(teamsReported, teamsExpected) {
  if (teamsReported == null || teamsExpected == null || teamsExpected <= 0) return null;
  return teamsReported >= teamsExpected;
}

// The one week number safe to call FINALIZED. Returns null when it cannot be
// determined (builtWeek or authoritativeWeek unresolved) rather than guessing.
//   builtWeek         — data_max_week: latest week the precompute has ANY data for.
//   weekComplete      — computeWeekComplete()'s result for builtWeek specifically.
//   authoritativeWeek — resolveAuthoritativeCompletedWeek()'s result (schedule/live-scoring).
export function computeFinalizedThroughWeek({ builtWeek, weekComplete, authoritativeWeek }) {
  if (builtWeek == null || authoritativeWeek == null) return null;
  if (weekComplete === true && authoritativeWeek >= builtWeek) return builtWeek;
  // builtWeek isn't (yet) both source-complete and schedule-over — the last
  // week we can vouch for is the one before it, capped by whatever the
  // schedule/live-scoring clock itself has reached (never claim a week the
  // authoritative clock hasn't gotten to either).
  return Math.max(0, Math.min(builtWeek - 1, authoritativeWeek));
}

// IDEMPOTENCY for the rebuild route: has anything this alias's stored board
// depends on actually changed since it was last built? Same week, same total
// row count, same per-team coverage for that week -> nothing to do. Keeps the
// rebuild safe to fire on a tight schedule (Sunday night, Monday morning,
// after Monday's game, plus the existing Tue/Wed correction passes) without
// re-scanning/re-writing an unchanged board every time one of those fires and
// upstream simply hasn't moved yet.
//
// existingMeta: the CURRENT stored meta row (or null/undefined if never
// built) — { data_max_week, data_row_count, teams_reported }, D1's raw shape
// (nullable columns, values may arrive as null/undefined/number).
// current: the FRESHLY computed values for this build attempt —
// { covWeek, covRows, teamsReported, mflFingerprint }.
//
// MFL SCORES ARE AN INPUT TOO (2026-10-01). The board's mfl_points / mfl_ppg
// are SUM(src_weekly.score), but this check used to look only at
// nfl_player_weekly. On 2026-10-01 src_weekly was restored from a clobbered
// 1,073 rows to MFL's full 3,632 (and a Wk 3 Elias correction landed with it)
// while nflverse coverage stayed at week 3 / 3,376 rows / 32 teams — so the
// rebuild skipped all five aliases as "no_change", reported green, and kept
// serving 241 wrong totals of 481. A Tuesday stat-correction sync has exactly
// the same shape. The board now also stores mflScoresFingerprint(); a rebuild
// is skipped only when BOTH the stored and the current fingerprint are known
// and equal. Either one unknown (column not migrated yet, a read that failed,
// a row from before this check) means rebuild — never "assume unchanged".
export function shouldSkipRebuild(existingMeta, current) {
  if (!existingMeta) return false;
  const num = (v, fallback) => {
    if (v === null || v === undefined) return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const storedFp = typeof existingMeta.mfl_scores_fingerprint === "string" ? existingMeta.mfl_scores_fingerprint : "";
  const currentFp = current && typeof current.mflFingerprint === "string" ? current.mflFingerprint : "";
  if (!storedFp || !currentFp || storedFp !== currentFp) return false;
  return num(existingMeta.data_max_week, -1) === current.covWeek &&
         num(existingMeta.data_row_count, -1) === current.covRows &&
         num(existingMeta.teams_reported, null) === current.teamsReported;
}

// One D1 read that changes whenever any MFL weekly score the board can see
// changes — the 0..17 window the stored board covers (same `week <= 17` as the
// board itself; a playoff-week change cannot alter it). Integers only, so the
// value is exact and stable across runs:
//   rows / scored        — a row added, removed, or blanked
//   max_week             — a week added
//   pts10                — any score moved (a 14.0 → 13.5 correction is -5)
//   weighted             — the same, weighted by player and week, so two
//                          corrections that cancel in the plain sum (one
//                          player +0.5, another -0.5) still change the value
// Reads the season's src_weekly rows once (idx_src_weekly_season), ~3.6K rows
// per week — cheap next to the rebuild it guards.
export const MFL_SCORES_FINGERPRINT_SQL =
  `SELECT COUNT(*) AS rows_n,
          SUM(CASE WHEN score IS NOT NULL THEN 1 ELSE 0 END) AS scored_n,
          MAX(week) AS max_week,
          SUM(CAST(ROUND(COALESCE(score, 0) * 10) AS INTEGER)) AS pts10,
          SUM(CAST(ROUND(COALESCE(score, 0) * 10) AS INTEGER)
              * ((CAST(player_id AS INTEGER) % 9973) + 1) * (week + 1)) AS weighted
     FROM src_weekly
    WHERE season = ? AND week <= 17`;

// The stored/compared string, or null when the read failed or came back in a
// shape we can't vouch for (null is "unknown", which never permits a skip).
export function mflScoresFingerprint(row) {
  if (!row) return null;
  const parts = [row.rows_n, row.scored_n, row.max_week, row.pts10, row.weighted].map((v) =>
    v === null || v === undefined ? 0 : Number(v));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return "v1:" + parts.join(":");
}
