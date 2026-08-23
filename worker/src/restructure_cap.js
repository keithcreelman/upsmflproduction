// §Restructure cap — 3 per team per season (canon line 40, "Restructure limit = 3").
//
// HISTORY. Keith suspended this on 2026-07-31 ("allow the team to do as they
// please") along with the offseason-only window, so nothing enforced it on any
// surface. On 2026-08-23 CBP restructured Nico Collins a THIRD time — taking Y1
// from 19K back to 30K, exactly undoing their own 2026-07-29 restructure — which
// put them at 4 for the season. Keith reinstated the cap. The window stays
// suspended; only the count is enforced here.
//
// COUNTING RULE (Keith 2026-08-23): per TEAM, per SEASON. Not per player — a
// team spending all three on one player is a legal, if odd, use of its budget.
//
// A VOIDED row does not count. When a restructure is reversed the contract goes
// back to its prior state, so charging the team for it would be charging them
// for something that no longer exists. `voided_at_utc` is set by the reversal.
//
// DRY RUNS never count and are never blocked — the point of a dry run is to see
// what would happen, and a guard that refuses to simulate hides the answer the
// owner asked for. The verdict rides in the response instead.

export const RESTRUCTURE_MAX_PER_SEASON = 3;

export async function checkRestructureCap(env, opts = {}) {
  const season = String(opts.season || "");
  const fid = String(opts.fid || "");
  const isCommishOverride = !!opts.isCommishOverride;
  const max = RESTRUCTURE_MAX_PER_SEASON;

  if (!season || !fid) {
    // Missing identity is not "zero used" — see below.
    return { allowed: false, reason: "cap_indeterminate",
             detail: "Could not identify the franchise or season for the restructure cap.",
             cap: { used: null, max } };
  }

  let used = null;
  try {
    const row = await env.UPS_MFL_DB.prepare(
      `SELECT COUNT(*) AS n FROM ups_restructure_submissions
        WHERE season = ? AND franchise_id = ?
          AND COALESCE(dry_run, 0) = 0
          AND voided_at_utc IS NULL`
    ).bind(season, fid).first();
    used = Number(row && row.n);
    if (!Number.isFinite(used)) used = null;
  } catch (_) {
    used = null;
  }

  // FAIL CLOSED. A count we could not read is NOT zero. Reading it as zero is
  // the exact shape of every cap/contract failure this league has had: an
  // unreadable input treated as an empty one. The MYM guard beside this one
  // fails OPEN on a query error, which is inconsistent with that rule and worth
  // revisiting — it is not copied here on purpose.
  //
  // The trade is deliberate: an unreadable count blocks a legal restructure
  // (visible, annoying, instantly fixable) rather than silently allowing an
  // illegal one (invisible until someone audits the ledger).
  if (used === null) {
    return { allowed: false, reason: "cap_unreadable",
             detail: "Could not read this season's restructure count — refusing rather than assuming zero.",
             cap: { used: null, max } };
  }

  if (used < max) {
    return { allowed: true, reason: "under_cap", cap: { used, max } };
  }

  if (isCommishOverride) {
    return { allowed: true, overridden: true, reason: "cap_reached",
             detail: `Franchise has used ${used} of ${max} restructures this season.`,
             cap: { used, max } };
  }

  return { allowed: false, reason: "cap_reached",
           detail: `This team has used all ${max} restructures for ${season}.`,
           cap: { used, max } };
}
