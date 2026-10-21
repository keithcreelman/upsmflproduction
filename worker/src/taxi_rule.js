// UPS taxi eligibility — the ONE rule (canon §A1 Round 1 / Rounds 2–6, §B2, T2.4, §G14).
//
//   - The UPS Rookie Draft round and year decide it, never MFL's NFL draft fields.
//   - Round 1 is never eligible; Round 2 or later is eligible during the first 3 LEAGUE years.
//   - Activations 1–3 are temporary call-ups, counted across the whole window; after each of them the
//     player may be demoted back to taxi.
//   - The 4th activation is a permanent promotion and ends eligibility for good. So does an explicit
//     MYAC / extension / restructure (it replaces the entry contract), and ending a prior season on an
//     active or IR roster (Keith 2026-05-19 / 2026-09-17; see _taxiPermanentPromotion in index.js).
//   - A cut / release ends the original eligibility; re-acquiring the player does not restore it
//     (Keith 2026-08-03). MFL keeps a traded player's contract status, but a drop wipes it and a
//     re-acquisition writes a fresh one, so "still exactly Rookie-Draft" means "never released".
//
// Pure: no fetch, no D1. /roster-workbench, the demote_taxi write guard and the clients read this verdict.
// site/shared/taxi_rule.js is its browser twin; tests/taxi_rule.test.mjs checks that they agree.

export const TAXI_CALLUPS_MAX = 3;

// Permanent promotion. true / false, or null when an input is unknown (never a guessed "no").
export function taxiPermanent({ used, marked, priorActive } = {}) {
  if ((Number(used) || 0) >= 4 || Number(marked) === 1 || priorActive === true) return true;
  if (used == null || priorActive == null) return null;
  return false;
}

// i = { upsRound, upsYear, season, contractStatus, permanent (true | false | null = unknown), isTaxi, isIr,
//       used, pending, draftKnown (false = the draft record couldn't be read),
//       contractKnown (false = the roster's contract status couldn't be read),
//       windowIndexOnly (true = the caller's draft index holds only the last 3 drafts, so a player missing from it
//       may be an older pick: "no UPS Rookie Draft pick in the last 3 league years", never "not a pick") }
// → { eligible: true | false | null, reason, text, reasons, callups_used, callups_pending, callups_left,
//     permanent, can_demote, next_callup, next_callup_permanent }
export function taxiEligibility(i = {}) {
  const season = parseInt(i.season, 10) || 0;
  const round = parseInt(i.upsRound, 10) || 0;
  const year = parseInt(i.upsYear, 10) || 0;
  const used = Math.max(0, parseInt(i.used, 10) || 0);
  const pending = Math.max(0, parseInt(i.pending, 10) || 0);
  const status = String(i.contractStatus == null ? "" : i.contractStatus).trim();
  const permanent = i.permanent === true ? true : i.permanent === false ? false : null;
  const out = {
    eligible: false, reason: "", text: "", reasons: [],
    callups_used: used, callups_pending: pending, callups_left: Math.max(0, TAXI_CALLUPS_MAX - used),
    permanent, can_demote: false,
    // The activation a promote from taxi would be; the 4th is permanent.
    next_callup: used + pending + 1, next_callup_permanent: used + pending + 1 > TAXI_CALLUPS_MAX,
  };
  const unknown = (reason, text) => Object.assign(out, { eligible: null, reason, text: "Unknown · " + text, can_demote: false });
  if (i.draftKnown === false) return unknown("draft_unreadable", "the UPS Rookie Draft record couldn't be read");
  if (!round || !year) {
    out.reasons.push(i.windowIndexOnly
      ? { reason: "no_recent_pick", text: "no UPS Rookie Draft pick in the last 3 league years" }
      : { reason: "not_ups_pick", text: "not a UPS Rookie Draft pick" });
  } else {
    if (round === 1) out.reasons.push({ reason: "round_1", text: "Round 1 pick" });
    if (season && season - year >= 3) out.reasons.push({ reason: "window_ended", text: "taxi window ended (" + year + " draft)" });
    // A contract other than the original Rookie-Draft one means "released" only INSIDE the window, for a Round 2+
    // pick: outside it the rookie deal simply ran out (an expired contract, never a cut).
    if (!out.reasons.length) {
      if (i.contractKnown === false) return unknown("contract_unreadable", "the roster's contract couldn't be read");
      if (!/^rookie-draft$/i.test(status)) {
        out.reasons.push({ reason: "released", text: "released since the draft (re-acquiring doesn't restore it)" });
      }
    }
  }
  if (permanent === true) out.reasons.push({ reason: "permanently_promoted", text: "permanently promoted" });
  if (out.reasons.length) {
    return Object.assign(out, { eligible: false, reason: out.reasons[0].reason, text: "Not eligible · " + out.reasons[0].text });
  }
  if (permanent === null) return unknown("callups_unreadable", "the call-up history couldn't be read");
  return Object.assign(out, {
    eligible: true, reason: "eligible",
    text: "Eligible · " + out.callups_left + " of " + TAXI_CALLUPS_MAX + " call-ups left",
    can_demote: !i.isTaxi && !i.isIr,
  });
}

// The CUT's verdict (Keith 2026-10-21, canon T5.2 / §D2: a cut is cap-free when the player is still taxi-eligible
// immediately before it, wherever he sits). cut = the worker's _taxiCutContextMap inputs as of the cut
// ({ season, upsRound, upsYear, draftKnown, used, pending, permanent, liveWeek }). liveWeek = his own game has kicked
// off in the week under way with 3 activations used: that is his 4th activation ONLY if he was not on the taxi squad at
// the cut (a taxi-squad week is never an activation). Only the original rookie-draft contract ("Rookie" is its pre-2026
// spelling) can qualify — a release wipes it, a re-acquisition or an explicit MYAC / extension / restructure replaces it.
// → true | false | null (unknown → the cut is held, never a guessed $0 or charge).
export function taxiCutVerdict(cut, contractStatus, isTaxi) {
  if (!/^rookie(-draft)?$/i.test(String(contractStatus == null ? "" : contractStatus).trim())) return false;
  if (!cut || typeof cut !== "object") return null;
  let permanent = cut.permanent;
  if (!isTaxi && permanent === false && cut.liveWeek === true) permanent = true;
  if (!isTaxi && permanent === false && cut.liveWeek === null) permanent = null;
  return taxiEligibility({ ...cut, permanent, contractStatus: "Rookie-Draft", isTaxi: !!isTaxi }).eligible;
}
