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
// the same shape. The board now also stores computeMflScoresFingerprint(); a rebuild
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

// An EXACT content fingerprint of the MFL weekly scores the stored board can
// see: every src_weekly row for the season in the board's own `week <= 17`
// window (a playoff-week change cannot alter it), as week + player + the exact
// stored score (blank for NULL), sorted, then SHA-256.
//
// v1 (the first draft of this fix) summed scores — plain and player/week
// weighted. Sums are not a fingerprint: any set of corrections whose deltas
// cancel in both sums collides (Keith 2026-10-02), e.g. a +0.5/-0.5 pair on
// two rows with the same weight, or three corrections sized a·(b-c), b·(c-a),
// c·(a-b). A hash over the full content has no such blind spot, and a changed
// row count, an added or removed week, a NULL <-> 0.0 flip and a moved score
// all change it too.
//
// Read one week at a time (one indexed seek each on (season, week), ~3.6K rows),
// so no single D1 response carries the whole season. Rows read equal the old
// aggregate's; the extra cost is the transfer, a few hundred KB per build.
// Returns null — "unknown", which never permits a skip — on ANY read error.
export const MFL_SCORES_WEEKS_SQL =
  "SELECT DISTINCT week FROM src_weekly WHERE season = ? AND week <= 17 ORDER BY week";
export const MFL_SCORES_ROWS_SQL =
  "SELECT player_id, score FROM src_weekly WHERE season = ? AND week = ? ORDER BY player_id";

// "w<TAB>player<TAB>score\n" per row, rows sorted by (week, player id as text)
// in JS as well, so the result never depends on the order D1 returned them in.
// String(score) is JavaScript's shortest exact representation of the stored
// double, so 13.5 and 13.50000001 differ and 13.5 always reads the same.
export function canonicalScoreLines(rowsByWeek) {
  const lines = [];
  const weeks = Object.keys(rowsByWeek).map(Number).sort((a, b) => a - b);
  for (const w of weeks) {
    const rows = (rowsByWeek[w] || []).map((r) => ({
      pid: String(r.player_id == null ? "" : r.player_id),
      score: r.score === null || r.score === undefined ? "" : String(Number(r.score)),
    }));
    rows.sort((a, b) => (a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : 0));
    for (const r of rows) lines.push(w + "\t" + r.pid + "\t" + r.score + "\n");
  }
  return lines;
}

export async function fingerprintFromScoreLines(lines) {
  const bytes = new TextEncoder().encode(lines.join(""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return "v2:" + lines.length + ":" + hex;
}

// db: a D1 binding (prepare(sql).bind(...).all()). null on any failure.
export async function computeMflScoresFingerprint(db, season) {
  try {
    const wk = await db.prepare(MFL_SCORES_WEEKS_SQL).bind(season).all();
    const weeks = ((wk && wk.results) || []).map((r) => Number(r.week)).filter((n) => Number.isFinite(n));
    const rowsByWeek = {};
    for (const w of weeks) {
      const res = await db.prepare(MFL_SCORES_ROWS_SQL).bind(season, w).all();
      if (!res || !Array.isArray(res.results)) return null;
      rowsByWeek[w] = res.results;
    }
    return await fingerprintFromScoreLines(canonicalScoreLines(rowsByWeek));
  } catch (_) {
    return null;
  }
}
