/* UPS taxi eligibility, browser twin of worker/src/taxi_rule.js — the ONE rule (canon §A1, §B2, T2.4, §G14).
   Same body, byte for byte (tests/taxi_rule.test.mjs). Attaches window.UPS_TAXI_RULE. Clients that have the
   worker's /roster-workbench row read its taxi_status instead; the phone (which reads MFL rosters directly)
   computes the same verdict here from the UPS draft index, the contract status and /api/taxi-callups (its
   tracked_permanent and legacy_2025 flags). */
(function (root) {
  "use strict";
  // ---- body: generated from worker/src/taxi_rule.js (keep in step; the test fails otherwise) ----
  const TAXI_CALLUPS_MAX = 3;
  // The one untracked season (legacy rule) and the first season whose recorded call-ups count (tracked rule).
  const TAXI_LEGACY_SEASON = 2025;
  const TAXI_TRACKED_FROM_SEASON = 2026;

  // Permanent promotion: the 4th tracked activation (used = call-ups recorded from TAXI_TRACKED_FROM_SEASON on), a
  // recorded row marked became_permanent, or the 2025 legacy rule. true / false, or null when an input is unknown
  // (never a guessed "no").
  function taxiPermanent({ used, marked, legacy2025 } = {}) {
    if ((Number(used) || 0) >= TAXI_CALLUPS_MAX + 1 || Number(marked) === 1 || legacy2025 === true) return true;
    if (used == null || legacy2025 == null) return null;
    return false;
  }

  // i = { upsRound, upsYear, season, contractStatus, isTaxi, isIr, used, pending,
  //       permanent (the TRACKED rule: 4th activation or a marked row — true | false | null = unknown),
  //       legacy2025 (the 2025 legacy rule: on an active roster or IR in some week of 2025 — true | false | null = unknown;
  //       omitted = unknown from 2026 on, not applied before it),
  //       draftKnown (false = the draft record couldn't be read),
  //       contractKnown (false = the roster's contract status couldn't be read),
  //       windowIndexOnly (true = the caller's draft index holds only the last 3 drafts, so a player missing from it
  //       may be an older pick: "no UPS Rookie Draft pick in the last 3 league years", never "not a pick") }
  // → { eligible: true | false | null, reason, text, detail, reasons, callups_used, callups_pending, callups_left,
  //     permanent, legacy_2025, can_demote, next_callup, next_callup_permanent }
  // text is the owner-facing line (Keith 2026-10-21): "Not eligible · <reason>" or "Eligibility could not be confirmed";
  // detail says more where there is more to say (the draft year, what couldn't be read).
  function taxiEligibility(i = {}) {
    const season = parseInt(i.season, 10) || 0;
    const round = parseInt(i.upsRound, 10) || 0;
    const year = parseInt(i.upsYear, 10) || 0;
    const used = Math.max(0, parseInt(i.used, 10) || 0);
    const pending = Math.max(0, parseInt(i.pending, 10) || 0);
    const status = String(i.contractStatus == null ? "" : i.contractStatus).trim();
    const permanent = i.permanent === true ? true : i.permanent === false ? false : null;
    // Omitted is "not applied" only for a season before the tracked rule; from 2026 on it is unknown (fails closed).
    const legacy = i.legacy2025 === true ? true : i.legacy2025 === false ? false
      : i.legacy2025 === undefined && season && season < TAXI_TRACKED_FROM_SEASON ? false : null;
    const out = {
      eligible: false, reason: "", text: "", detail: "", reasons: [],
      callups_used: used, callups_pending: pending, callups_left: Math.max(0, TAXI_CALLUPS_MAX - used),
      permanent: legacy === true ? true : permanent, legacy_2025: legacy, can_demote: false,
      // The activation a promote from taxi would be; the 4th is permanent.
      next_callup: used + pending + 1, next_callup_permanent: used + pending + 1 > TAXI_CALLUPS_MAX,
    };
    const unknown = (reason, detail) =>
      Object.assign(out, { eligible: null, reason, text: "Eligibility could not be confirmed", detail, can_demote: false });
    if (i.draftKnown === false) return unknown("draft_unreadable", "the UPS Rookie Draft record couldn't be read");
    if (!round || !year) {
      out.reasons.push(i.windowIndexOnly
        ? { reason: "no_recent_pick", text: "no UPS Rookie Draft pick in the last 3 league years" }
        : { reason: "not_ups_pick", text: "not a UPS Rookie Draft pick" });
    } else {
      if (round === 1) out.reasons.push({ reason: "round_1", text: "Round 1 selection", detail: year + " UPS Rookie Draft, Round 1" });
      if (season && season - year >= 3) out.reasons.push({ reason: "window_ended", text: "taxi window ended", detail: year + " UPS Rookie Draft; 3 league years have passed" });
      // A contract other than the original Rookie-Draft one means "released" only INSIDE the window, for a Round 2+
      // pick: outside it the rookie deal simply ran out (an expired contract, never a cut).
      if (!out.reasons.length) {
        if (i.contractKnown === false) return unknown("contract_unreadable", "the roster's contract couldn't be read");
        if (!/^rookie-draft$/i.test(status)) {
          out.reasons.push({ reason: "released", text: "released", detail: "released since the draft; re-acquiring him doesn't restore it" });
        }
      }
    }
    if (legacy === true) out.reasons.push({ reason: "legacy_2025", text: "active during 2025 (legacy promotion)", detail: "on an active roster or IR during 2025, before call-ups were tracked" });
    if (permanent === true) out.reasons.push({ reason: "permanently_promoted", text: "permanently promoted after three temporary call-ups", detail: "promoted again after all three temporary call-ups were used" });
    if (out.reasons.length) {
      const first = out.reasons[0];
      return Object.assign(out, { eligible: false, reason: first.reason, text: "Not eligible · " + first.text, detail: first.detail || "" });
    }
    if (legacy === null) return unknown("legacy_unreadable", "the 2025 roster record couldn't be read");
    if (permanent === null) return unknown("callups_unreadable", "the call-up history couldn't be read");
    return Object.assign(out, {
      eligible: true, reason: "eligible",
      text: "Eligible · " + out.callups_left + " of " + TAXI_CALLUPS_MAX + " call-ups left",
      can_demote: !i.isTaxi && !i.isIr,
    });
  }

  // The CUT's verdict (Keith 2026-10-21, canon T5.2 / §D2: a cut is cap-free when the player is still taxi-eligible
  // immediately before it, wherever he sits). cut = the worker's _taxiCutContextMap inputs as of the cut
  // ({ season, upsRound, upsYear, draftKnown, used, pending, permanent, legacy2025, liveWeek }). liveWeek = his own game has kicked
  // off in the week under way with 3 activations used: that is his 4th activation ONLY if he was not on the taxi squad at
  // the cut (a taxi-squad week is never an activation). Only the original rookie-draft contract ("Rookie" is its pre-2026
  // spelling) can qualify — a release wipes it, a re-acquisition or an explicit MYAC / extension / restructure replaces it.
  // → true | false | null (unknown → the cut is held, never a guessed $0 or charge).
  function taxiCutVerdict(cut, contractStatus, isTaxi) {
    if (!/^rookie(-draft)?$/i.test(String(contractStatus == null ? "" : contractStatus).trim())) return false;
    if (!cut || typeof cut !== "object") return null;
    let permanent = cut.permanent;
    if (!isTaxi && permanent === false && cut.liveWeek === true) permanent = true;
    if (!isTaxi && permanent === false && cut.liveWeek === null) permanent = null;
    return taxiEligibility({ ...cut, permanent, contractStatus: "Rookie-Draft", isTaxi: !!isTaxi }).eligible;
  }
  // ---- end body ----
  var api = { TAXI_CALLUPS_MAX: TAXI_CALLUPS_MAX, TAXI_LEGACY_SEASON: TAXI_LEGACY_SEASON, TAXI_TRACKED_FROM_SEASON: TAXI_TRACKED_FROM_SEASON, taxiPermanent: taxiPermanent, taxiEligibility: taxiEligibility, taxiCutVerdict: taxiCutVerdict };
  root.UPS_TAXI_RULE = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : this);
