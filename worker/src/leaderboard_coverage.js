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
// { covWeek, covRows, teamsReported }.
export function shouldSkipRebuild(existingMeta, current) {
  if (!existingMeta) return false;
  const num = (v, fallback) => {
    if (v === null || v === undefined) return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  return num(existingMeta.data_max_week, -1) === current.covWeek &&
         num(existingMeta.data_row_count, -1) === current.covRows &&
         num(existingMeta.teams_reported, null) === current.teamsReported;
}
