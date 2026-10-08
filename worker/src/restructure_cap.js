// §Restructure cap — 3 per team per season (canon line 40, "Restructure limit = 3").
//
// HISTORY. Keith suspended this on 2026-07-31 ("allow the team to do as they
// please") along with the offseason-only window, so nothing enforced it on any
// surface. On 2026-08-23 CBP restructured Nico Collins a THIRD time — taking Y1
// from 19K back to 30K, exactly undoing their own 2026-07-29 restructure — which
// put them at 4 for the season. Keith reinstated the cap (commit 2aa64d20,
// #959) and the window (commit 7a102fc6, #960) as two commits four minutes
// apart, same day — see checkRestructureWindow below, which IS enforced.
// (This paragraph used to end "the window stays suspended; only the count is
// enforced here" — true for the few minutes between #959 and #960 landing in
// this same file, stale ever since. Verified live 2026-09-28: both active.)
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

import { loadContractDeadline, deadlineState } from "./contract_deadline.js";

export const RESTRUCTURE_MAX_PER_SEASON = 3;

// ── The WINDOW: offseason until the September contract deadline ────────────
// Canon states it twice (lines 471 and 933): "Window: OFFSEASON UNTIL CONTRACT
// DEADLINE. Mid-season restructures are BANNED. The window opens at season's
// end (or roll-forward) and closes at the September contract deadline."
//
// Suspended alongside the 3-per-season cap on 2026-07-31; reinstated with it on
// 2026-08-23.
//
// The deadline comes from the ONE resolver every consumer uses (contract_deadline.js, 2026-10-08): the league calendar,
// else the approved pinned value, else the league_events DATE at day precision — never an invented time. The window is
// open through the deadline second (2026: 23:59:59 ET, as before); on a date-only deadline DAY it is "unknown" and refuses.
//
// FAILS CLOSED. A deadline we cannot read is not an open window.
export async function checkRestructureWindow(env, opts = {}) {
  const season = String(opts.season || "");
  const nowUnix = Number.isFinite(opts.nowUnix) ? opts.nowUnix : Math.floor(Date.now() / 1000);
  if (!season) {
    return { open: false, reason: "window_indeterminate",
             detail: "Could not identify the season for the restructure window." };
  }
  const res = await loadContractDeadline(env, season);
  const state = deadlineState(res, nowUnix);
  const deadline = res.exact ? res.deadline_unix : null;
  if (state === "unknown") {
    return { open: false, reason: "window_unreadable",
             detail: res.source === "error" ? `The ${season} contract deadline couldn't be read (${res.error}) — refusing rather than assuming the window is open.`
               : res.source === "league_events_day" ? `Only the date of the ${season} contract deadline (${res.day}) is on file, not its time — refusing on that day rather than guessing.`
               : `No contract deadline on file for ${season} — refusing rather than assuming the window is open.`,
             deadline_unix: deadline };
  }
  if (state === "before") return { open: true, reason: "offseason", deadline_unix: deadline };
  return { open: false, reason: "window_closed",
           detail: "Restructures are offseason-only and closed at the September contract deadline.",
           deadline_unix: deadline };
}

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
