/* contract_windows.js — UPS league §B3/§C4/§C5 WINDOW source of truth (client-side).

   Same posture as site/shared/cap_math.js: one calculation that used to live
   as multiple drifting copies. Front Office (front_office.js), Roster
   Workbench (roster_workbench.js) and mobile (front_office_actions.js) each
   kept their own restructureEligible/extensionEligible logic — none of the
   three checked a deadline at all for restructure, and mobile/Roster
   Workbench skipped the §C4 deadline check entirely for a "plain held
   veteran" (a final-year contract with no fresh acquisition/ladder path).
   That is how Dallas Goedert (traded to his current team 2025-11-27, final
   year of a Veteran deal, September 2026 deadline long passed) still showed
   as extension-eligible on mobile on 2026-09-28.

   NOT reimplemented here: the pre-season WW/FCFS/fresh-auction LADDER
   (MYAC -> MYM -> Extension). That boundary is resolved server-side
   (worker/src/league_events_ladder.js contractLadderStage) and read verbatim
   by both browsers already — see tests/ladder_single_implementation.test.mjs.
   This module covers everything else: the §B3 IR designation predicate, the
   §C5 restructure window, and the §C4 "off-ladder" extension deadline matrix
   (held veteran -> September deadline; rookie contract -> May deadline;
   in-season WW/FCFS pickup -> days 15-28; in-season trade acquisition -> 4
   weeks).

   FAILS CLOSED throughout: an unresolvable deadline is never "open" and an
   unrecognized/missing NFL designation is never "eligible".

   Loaded via window.UPS_CONTRACT_WINDOWS, ahead of front_office.js,
   roster_workbench.js and front_office_actions.js.
*/
(function (global) {
  "use strict";

  function safeStr(v) { return v == null ? "" : String(v).trim(); }
  function safeInt(v, fallback) {
    var n = parseInt(v, 10);
    return isFinite(n) ? n : (fallback == null ? 0 : fallback);
  }

  // ── §B3 IR designation eligibility ──────────────────────────────────────
  // Byte-identical to worker/src/index.js's `deactivate_ir` §B3 gate. Prefix
  // tests, not equality and not a broad substring match — "Out" / "Doubtful"
  // / "Questionable" / "Retired" must never match. "RETIRED" deliberately
  // survives the "IR" prefix test ("RETIRED".indexOf("IR") === 3, not 0) —
  // canon D2's cap-free-cut governs retirees, not §B3's 50% IR relief.
  function irDesignationEligible(desig) {
    var s = safeStr(desig).toUpperCase();
    return s.indexOf("IR") === 0        // IR, IR-PUP, IR-NFI, IR-R
        || s.indexOf("SUSPEND") === 0   // Suspended
        || s.indexOf("HOLDOUT") === 0   // canon T2.1
        || s.indexOf("COVID") >= 0;     // legacy §B3
  }

  // The September contract deadline as an INSTANT: 23:59:59 ET on the
  // deadline day. Same parser as worker/src/league_events_ladder.js
  // contractDeadlineUnixFromIso, so a client check can never disagree with
  // the worker about which second the day ends. Returns null on anything
  // unparseable — never a guessed instant.
  //
  // Used ONLY for §C5 restructure below. The worker's §C4 EXTENSION gate
  // (resolveContractDeadlineUtc / getContractDeadlineUtc in worker/src/index.js)
  // uses a DIFFERENT default cutoff — 21:00 ET, not 23:59:59 — and can be
  // pushed later still by a commish-editable calendar override this client
  // cannot read. These two worker gates already disagree with each other by
  // ~3 hours on the deadline day itself; this module does not paper over
  // that, it mirrors each one separately. See extensionVeteranDeadlineUnixMs.
  function contractDeadlineUnixMs(deadlineYmd) {
    var day = safeStr(deadlineYmd).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
    var ms = new Date(day + "T23:59:59-04:00").getTime();
    return isFinite(ms) ? ms : null;
  }

  // The §C4 extension deadline as an INSTANT: 21:00 ET on the deadline day —
  // the worker's getContractDeadlineUtc default ("21:00" when no commish
  // override is configured). desktop front_office.js's own
  // contractDeadlineDateFO already computed exactly this; callers that
  // already have their own correctly-timed Date (front_office.js) should
  // pass ctx.contractDeadlineDate instead of ctx.contractDeadlineYmd so nothing
  // here overrides it. Callers with no prior helper (Roster Workbench,
  // mobile) get this default, which matches the worker's un-configured
  // baseline (a commish override this client cannot read could push it
  // later — that gap pre-dates this module and isn't new).
  function extensionVeteranDeadlineUnixMs(deadlineYmd) {
    var day = safeStr(deadlineYmd).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
    var ms = new Date(day + "T21:00:00-04:00").getTime();
    return isFinite(ms) ? ms : null;
  }

  // ── §C5 Restructure window ──────────────────────────────────────────────
  // Mirrors worker/src/restructure_cap.js checkRestructureWindow exactly:
  // open through end-of-day on the deadline, closed after, and FAILS CLOSED
  // (not open) when the deadline can't be read — a client action must never
  // be offered when the worker cannot even tell whether it will accept it.
  function restructureWindowOpen(nowMs, deadlineYmd) {
    var now = typeof nowMs === "number" ? nowMs : Date.now();
    var deadlineMs = contractDeadlineUnixMs(deadlineYmd);
    if (deadlineMs == null) {
      return {
        open: false, reason: "window_unreadable",
        detail: "Restructure eligibility unavailable.",
        deadline_ms: null
      };
    }
    if (now <= deadlineMs) {
      return { open: true, reason: "offseason", deadline_ms: deadlineMs };
    }
    return {
      open: false, reason: "window_closed",
      detail: "Restructuring closed after the September contract deadline.",
      deadline_ms: deadlineMs
    };
  }

  // ── §C4 Extension window — the OFF-LADDER matrix ────────────────────────
  // Ported verbatim from desktop front_office.js's extensionDeadlineForPlayer
  // (its non-ladder branches only — ladder players never reach this
  // function; see each caller). `player` fields read: years, type
  // (contractStatus), special (contractInfo), acquisitionTypeLabel,
  // acquisitionDate — the shape every surface's rosterContractEligibility
  // already receives.
  //
  // ctx:
  //   season               (number|string, required)
  //   contractDeadlineYmd  the season's ups_contract_deadline ISO day —
  //     used for the veteran branch ONLY when contractDeadlineDate (below)
  //     isn't supplied; parsed at 21:00 ET (extensionVeteranDeadlineUnixMs),
  //     matching the worker's un-configured getContractDeadlineUtc baseline.
  //   contractDeadlineDate (Date, optional) — a caller-precomputed deadline
  //     instant for the veteran branch, e.g. desktop front_office.js's own
  //     contractDeadlineDateFO(). Takes priority over contractDeadlineYmd so
  //     a caller that already has a correctly-timed value (possibly layering
  //     a commish override this module cannot read) is never overridden.
  //   isRookieLikeStatus(statusLc) -> bool   (caller's own classifier)
  //   tagDeadlineDate(year) -> Date|null     (caller's own May-deadline calc;
  //     not reimplemented here because desktop/Roster Workbench/mobile each
  //     already compute Memorial-Day-minus-4 correctly and re-deriving a
  //     fourth copy here would recreate the exact drift this module exists
  //     to remove)
  //   nowMs                (number, optional — for tests)
  function standardExtensionWindow(player, ctx) {
    ctx = ctx || {};
    var DAY = 86400000;
    var season = safeInt(ctx.season, 0) || new Date().getUTCFullYear();
    var cy = Math.max(0, safeInt(player && player.years, 0));
    var statusLc = safeStr(player && player.type).toLowerCase();
    var infoLc = safeStr(player && player.special).toLowerCase();
    var isRookieLike = typeof ctx.isRookieLikeStatus === "function"
      ? !!ctx.isRookieLikeStatus(statusLc)
      : /rookie/.test(statusLc);
    var expiredRookie = infoLc.indexOf("expired rookie") !== -1 ||
                        (isRookieLike && cy <= 0) || !!(player && player.isExpiredRookie);
    var isRookieContract = isRookieLike || expiredRookie;

    var acqLabel = safeStr(player && player.acquisitionTypeLabel).toLowerCase();
    var acqYr = safeStr(player && player.acquisitionDate).slice(0, 4);
    var acquiredThisSeason = acqYr === String(season);
    var acqDate = null;
    try {
      if (player && player.acquisitionDate) {
        var d = new Date(safeStr(player.acquisitionDate).slice(0, 10) + "T12:00:00-04:00");
        if (!isNaN(d.getTime())) acqDate = d;
      }
    } catch (_) { acqDate = null; }

    var isWW = acquiredThisSeason && acqDate &&
      /\b(ww|fcfs|blind|waiver|free agent)\b/.test(acqLabel) && acqLabel.indexOf("auction") === -1;
    var isTradeAcq = acquiredThisSeason && acqDate && acqLabel.indexOf("trade") !== -1;

    var date = null, start = null, basis = "", resolved = true;
    if (isWW) {
      start = new Date(acqDate.getTime() + 15 * DAY);  // days 1-14 = MYM
      date  = new Date(acqDate.getTime() + 28 * DAY);  // days 15-28 = extension
      basis = "WW/FCFS pickup — days 15-28";
    } else if (isTradeAcq) {
      date  = new Date(acqDate.getTime() + 28 * DAY);  // 4 weeks from acquisition
      basis = "Trade-acquired — 4 weeks";
    } else if (isRookieContract) {
      var deadlineYear = season + cy;
      date = typeof ctx.tagDeadlineDate === "function" ? ctx.tagDeadlineDate(deadlineYear) : null;
      basis = "Rookie — May " + deadlineYear + " (rookie-extension deadline)";
      resolved = !!date;
    } else if (ctx.contractDeadlineDate instanceof Date && !isNaN(ctx.contractDeadlineDate.getTime())) {
      date = ctx.contractDeadlineDate;
      basis = "Veteran — September contract deadline";
    } else {
      var deadlineMs = extensionVeteranDeadlineUnixMs(ctx.contractDeadlineYmd);
      date = deadlineMs == null ? null : new Date(deadlineMs);
      basis = "Veteran — September contract deadline";
      resolved = !!date;
    }

    var now = typeof ctx.nowMs === "number" ? ctx.nowMs : Date.now();
    var days_until = date ? Math.ceil((date.getTime() - now) / DAY) : null;
    var in_window = resolved && !!date && now <= date.getTime() && (!start || now >= start.getTime());
    return { date: date, start: start, basis: basis, days_until: days_until,
             in_window: in_window, resolved: resolved };
  }

  global.UPS_CONTRACT_WINDOWS = {
    irDesignationEligible: irDesignationEligible,
    contractDeadlineUnixMs: contractDeadlineUnixMs,
    extensionVeteranDeadlineUnixMs: extensionVeteranDeadlineUnixMs,
    restructureWindowOpen: restructureWindowOpen,
    standardExtensionWindow: standardExtensionWindow
  };
})(typeof window !== "undefined" ? window : this);
