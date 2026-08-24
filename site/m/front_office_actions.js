/* site/m/front_office_actions.js
 *
 * VERBATIM MIRROR of the contract-action eligibility predicates in the
 * desktop Front Office (site/rosters/roster_workbench.js, with MYAC
 * sourced from site/rosters/v2/front_office.js — the current contract-logic
 * source of truth). Mobile uses this to:
 *   • compute which contract actions are available for a player
 *     (extension / MYAC / rookie option / tag / restructure / untag)
 *   • check tag eligibility from site/ccc/tag_tracking.json the same way
 *     Front Office does (per-player row + per-team-side conflict check)
 *
 * Mobile runs every contract action IN-APP via the verbatim Front Office
 * submit mirrors (front_office_extend_submit.js, front_office_tag_submit.js,
 * front_office_restructure_submit.js, front_office_myac_submit.js), which
 * POST to the same worker routes the desktop uses. The old MFL Contract
 * Command Center deep-link (MODULE=MESSAGE2) is retired (Keith 2026-05-15).
 *
 * DO NOT EDIT logic. If desktop changes, copy the updated function
 * bodies here verbatim.
 *
 * ONE DELIBERATE DIVERGENCE (2026-08-08): the pre-season acquisition ladder.
 * Canon ~379/~1211/~1214 gives an FA-auction win or a PRE-SEASON WAIVER pickup
 * three sequential windows — MYAC through the September contract deadline, MYM
 * through NFL Week 3 kickoff, Extension through Week 5 kickoff — and desktop
 * implements none of it: it has no WW→MYAC path at all, and its extension
 * eligibility is not window-bounded. Mobile shows the same players the Discord
 * waiver post does, with the same dates, so it could not wait for desktop. See
 * the ladder block below; port it back when desktop is next touched.
 *
 * Source-of-truth lines (roster_workbench.js):
 *   safeStr (201) · safeInt (226) · pad4 (315)
 *   TAG_OFFENSE_POS (84) · normalizeTagSideValue (265) · getTagSideFromPos (272)
 *   rookieLikeContractStatus (553) · rosterContractEligibility (558)
 *   parseRookieOptionToken (578) · rookieOptionStateForPlayer (600)
 *   rookieOptionActionEligible (615)
 *   isStaleTagFromPriorSeason (7128) · activeTaggedPlayerForTeamSide (7145)
 *   conflictingTaggedPlayerForRow (7158)
 * MYAC eligibility (v2/front_office.js):
 *   rosterContractEligibility (1262) · isPastContractDeadlineFO (1297)
 */
(function () {
  "use strict";

  // ── BEGIN verbatim mirror from roster_workbench.js ───────────────────

  function safeStr(v) {
    return v == null ? "" : String(v).trim();
  }
  function safeInt(v, fallback) {
    var n = parseInt(v, 10);
    if (!isFinite(n)) return fallback == null ? 0 : fallback;
    return n;
  }
  function pad4(v) {
    var digits = safeStr(v).replace(/\D/g, "");
    if (!digits) return "";
    return ("0000" + digits).slice(-4);
  }

  function rookieLikeContractStatus(value) {
    var status = safeStr(value).toLowerCase();
    return status === "r" || status.indexOf("r-") === 0 || status.indexOf("rookie") !== -1;
  }

  // ── Tag side mapping — verbatim from roster_workbench.js:84-89 + 265-276 ──
  var TAG_OFFENSE_POS = { QB: 1, RB: 1, WR: 1, TE: 1 };

  function normalizeTagSideValue(side) {
    var raw = safeStr(side).toUpperCase();
    if (raw === "OFFENSE" || raw === "OFF") return "OFFENSE";
    if (raw === "DEFENSE" || raw === "DEF" || raw === "IDP" || raw === "IDP_K") return "DEFENSE";
    return "";
  }

  function getTagSideFromPos(pos) {
    var key = safeStr(pos).toUpperCase();
    if (!key) return "";
    return TAG_OFFENSE_POS[key] ? "OFFENSE" : "DEFENSE";
  }

  function parseRookieOptionToken(contractInfo) {
    var text = safeStr(contractInfo);
    var match = text.match(/(?:^|\|)\s*ROPT\s+([^|]+)/i);
    if (!match) return null;
    var blob = safeStr(match[1]);
    function parseK(label) {
      var m = blob.match(new RegExp("\\b" + label + "=([0-9]+(?:\\.[0-9]+)?)K\\b", "i"));
      return m ? Math.round(parseFloat(m[1]) * 1000) : 0;
    }
    var statusMatch = blob.match(/\bstatus=([a-z-]+)/i);
    var classMatch = blob.match(/\bclass=(\d{4})\b/i);
    var deadlineMatch = blob.match(/\bdeadline=(\d{4})\b/i);
    return {
      eligible: true,
      exercised: safeStr(statusMatch && statusMatch[1]).toLowerCase() === "exercised",
      classSeason: safeInt(classMatch && classMatch[1]),
      deadlineSeason: safeInt(deadlineMatch && deadlineMatch[1]),
      baseSalary: parseK("base"),
      optionYearSalary: parseK("option")
    };
  }

  function rookieOptionStateForPlayer(player) {
    if (!player) return null;
    if (player.rookieOptionEligible || player.rookie_option_eligible || player.rookieOptionExercised || player.rookie_option_exercised) {
      return {
        eligible: !!(player.rookieOptionEligible || player.rookie_option_eligible),
        exercised: !!(player.rookieOptionExercised || player.rookie_option_exercised),
        classSeason: safeInt(player.rookieOptionClassSeason || player.rookie_option_class_season),
        deadlineSeason: safeInt(player.rookieOptionDeadlineSeason || player.rookie_option_deadline_season),
        baseSalary: safeInt(player.rookieOptionBaseSalary || player.rookie_option_base_salary || player.salary),
        optionYearSalary: safeInt(player.rookieOptionYearSalary || player.rookie_option_year_salary || player.rookie_option_half_raise_salary)
      };
    }
    return parseRookieOptionToken(player.special || player.contract_info || "");
  }

  function rookieOptionActionEligible(player) {
    var option = rookieOptionStateForPlayer(player);
    if (!option || !option.eligible || option.exercised) return false;
    return safeInt(player && player.years, 0) === 1;
  }

  // Current season from mobile context (desktop's module-global SEASON).
  function currentSeasonFO() {
    var s = window.UPS_MOBILE && window.UPS_MOBILE.state;
    return safeStr(s && s.ctx && s.ctx.year);
  }

  // Verbatim mirror of v2/front_office.js isPastContractDeadlineFO (1297),
  // kept for desktop parity and still exported.
  //
  // NOT used to gate MYAC any more. It fails OPEN — an unreadable deadline
  // reads as "still inside the window" — which contradicted the copy printed
  // beside the button (the Contracts list correctly said the window could not
  // be confirmed while the button was offered anyway). MYAC now goes through
  // contractLadderStageFO, which refuses on an unresolvable boundary.
  function isPastContractDeadlineFO() {
    var s = window.UPS_MOBILE && window.UPS_MOBILE.state;
    var d = s && s.contractDeadline;
    if (!d) return false;
    try { return new Date() > new Date(d + "T23:59:59-04:00"); } catch (_) { return false; }
  }

  // Contract LENGTH ("CL n") off contractInfo. Mirror of v2/front_office.js
  // parseContractLengthValue (:300) — mobile had no CL parser at all, and the
  // MYAC gate below needs one to tell a fresh 1-year auction win (CL 1) from
  // the final year of an already-converted multi-year deal (CL 2 / CL 3).
  function parseContractLengthValueFO(contractInfo) {
    var info = safeStr(contractInfo);
    if (!info) return 0;
    var match = info.match(/(?:^|\|)\s*CL\s*:?\s*(\d+)/i);
    return match && safeStr(match[1]) ? Math.max(0, safeInt(match[1], 0)) : 0;
  }

  // Auction month rule (Keith 2026-07-26) — mirror of v2/front_office.js
  // currentEtMonthFO / inAuctionMyacMonthWindowFO. "july or august + auction =
  // FAA; before july + auction = ERA" (canon §C1: ERA late May, FAA late July /
  // early August). Serves as the MYAC window's LOWER bound: the ladder only
  // bounds MYAC from ABOVE (the September deadline), so in the Jan-Mar gap
  // before MFL's league rollover "now is before the deadline" is trivially true
  // and a stale un-converted Vet-FAA would otherwise be re-offered MYAC.
  function currentEtMonthFO() {
    try {
      return safeInt(new Date().toLocaleString("en-US", { timeZone: "America/New_York", month: "numeric" }), 0);
    } catch (_) { return new Date().getMonth() + 1; }
  }
  function inAuctionMyacMonthWindowFO(kind) {
    var m = currentEtMonthFO();
    return kind === "era" ? m >= 5 : m >= 7;
  }

  // ── Pre-season acquisition ladder (canon ~379 / ~1211 / ~1214) ───────
  // A player acquired via FA Auction OR PRE-SEASON WAIVERS walks ONE
  // sequential ladder, each rung offered only inside its own window:
  //   Multi-Year Contract (MYAC)  now               → September contract deadline
  //   Mid-Year Multi (MYM)        contract deadline → NFL Week 3 kickoff
  //   Extension                   Week 3 kickoff    → NFL Week 5 kickoff
  //   (after Week 5)              nothing
  // This is the SAME ladder the Discord waiver post prints for these players
  // (worker/src/lib/waiver_run_post.js buildEligibilityLines) — the two
  // surfaces must never disagree about a player's window.
  //
  // The IN-SEASON WW/FCFS rule (canon ~391: MYM days 1-14, Extension days
  // 15-28) is a DIFFERENT rule and is untouched below. The split between them
  // is NFL Week 1's kickoff, not "acquired this season".
  //
  // Boundary sources (app.js fetchContractCalendar → state.contractLadder):
  //   • the September contract deadline is a LEAGUE decision and comes from the
  //     commish-owned calendar (`ups_contract_deadline`) as an ISO day.
  //   • Weeks 1 / 3 / 5 are NFL KICKOFF INSTANTS read from MFL's own
  //     nflSchedule — the very same worker helper the Discord waiver post uses
  //     to print these players' windows, so the two surfaces cannot drift.
  //     They used to come from hand-entered `preseason_*` calendar rows, which
  //     did drift: 2026's rows put Week 5 on Oct 7 (real first kickoff Oct 8)
  //     and Week 1 on Sep 10 (Week 1 opens WEDNESDAY Sep 9).
  //
  // A kickoff is an instant, not a day, so it is compared as one — the window
  // closes when the ball is kicked, not at midnight. NOTHING here invents a
  // boundary: an unresolvable one yields stage "unresolved", which offers no
  // action and prints no date.

  // End of an ISO calendar day, Eastern. A date-only deadline row means "that
  // day", so the window closes when the day does — the same reading
  // isPastContractDeadlineFO already uses for the contract deadline. Returns
  // null (never a guess) when the value isn't a readable ISO date.
  function endOfEtDayMs(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(safeStr(iso));
    if (!m) return null;
    var t = Date.parse(m[0] + "T23:59:59-04:00");
    return isFinite(t) ? t : null;
  }
  function finiteMsOrNull(v) {
    var n = typeof v === "number" ? v : parseInt(v, 10);
    return isFinite(n) && n > 0 ? n : null;
  }
  function contractLadderDatesFO() {
    var s = window.UPS_MOBILE && window.UPS_MOBILE.state;
    var L = (s && s.contractLadder) || {};
    return {
      contractDeadline: safeStr(L.contractDeadline) || safeStr(s && s.contractDeadline),
      // ISO twins are DISPLAY ONLY — the ET calendar day each kickoff falls on.
      seasonStart: safeStr(L.seasonStart),
      mymWindowEnd: safeStr(L.mymWindowEnd),
      extensionWindowEnd: safeStr(L.extensionWindowEnd),
      // The instants every comparison below actually uses.
      seasonStartMs: finiteMsOrNull(L.seasonStartMs),
      mymWindowEndMs: finiteMsOrNull(L.mymWindowEndMs),
      extensionWindowEndMs: finiteMsOrNull(L.extensionWindowEndMs)
    };
  }

  // Which rung is open RIGHT NOW. Shape:
  //   { stage: "myac"|"mym"|"extension"|"closed"|"unresolved",
  //     date: ISO|"", endMs: number|null }
  // `date`/`endMs` are the END of the open window (blank/null when
  // unresolved or closed).
  function contractLadderStageFO() {
    // The rung is RESOLVED SERVER-SIDE (worker/src/league_events_ladder.js
    // contractLadderStage, stamped on /api/league-events) and read here. It is
    // no longer recomputed on the client.
    //
    // Why: desktop front_office.js carried a second implementation of this same
    // boundary, described in its own header as a port of this one. Two copies of
    // a rule drift; that is exactly what dropped `Ext:` from nine contracts on
    // 2026-08-22, where one of three writers never received a fix. One answer,
    // server-side, is the fix for the class.
    //
    // Before the switch the two were verified to agree exactly — same stage,
    // same end instant, same boundary semantics (`<=` on the contract deadline,
    // `<` on each kickoff).
    //
    // Return shape is UNCHANGED ({stage, date, endMs}) because player_sheet.js
    // and views/contracts.js read it. `date` still comes from the ISO twins in
    // state — display only, never a comparison.
    //
    // FAIL-CLOSED: an absent or unresolved stamp is "unresolved", never a rung.
    var s = window.UPS_MOBILE && window.UPS_MOBILE.state;
    var srv = (s && s.contractLadder && s.contractLadder.server) || null;
    var stage = safeStr(srv && srv.stage).toLowerCase();
    var d = contractLadderDatesFO();
    var UNRESOLVED = { stage: "unresolved", date: "", endMs: null };
    if (!stage || stage === "unresolved") return UNRESOLVED;
    var endMs = finiteMsOrNull(srv && srv.end_unix ? srv.end_unix * 1000 : null);
    if (stage === "myac") return { stage: "myac", date: d.contractDeadline, endMs: endMs };
    if (stage === "mym") return { stage: "mym", date: d.mymWindowEnd, endMs: endMs };
    if (stage === "extension") return { stage: "extension", date: d.extensionWindowEnd, endMs: endMs };
    if (stage === "closed") return { stage: "closed", date: "", endMs: null };
    return UNRESOLVED;
  }


  // ── The ONE contract-length gate every ladder entry point uses ───────
  // A fresh acquisition's DEFAULT contract is one year — "CL 1". CL 2+ means an
  // already-converted multi-year deal (a MYAC/MYM that was taken, possibly years
  // ago), and its final year is a normal §C4 veteran situation, NOT a fresh
  // default that can be MYAC'd again.
  //
  // This existed on the FAA arm and on the WW classifier but NOT on the ERA arm,
  // which was a bare `status.indexOf("-era")` test. `years === 1` hid the hole
  // while today's multi-year ERA deals all still have 2-3 years left, but the
  // moment one reaches its final year (cy 1, CL 3 — e.g. 0009/16752, 0010/16080,
  // 0011/15761 on the live 2026 rosters) it would have been handed a MYAC it is
  // not entitled to. All four entry points now share this single check.
  //
  // An ABSENT / unreadable CL fails CLOSED — the ladder is not opened on an
  // input we could not read (repo rule: an unreadable input is never "empty").
  // Every ERA / FAA / WW row on the live 2026 rosters carries a CL token, so
  // this refuses only genuinely malformed contractInfo.
  function isFreshOneYearDefaultFO(player) {
    return parseContractLengthValueFO(player && player.special) === 1;
  }

  // Is THIS player on the pre-season waiver rung of the ladder?
  // Returns "yes" | "no" | "unknown".
  //
  // Classified off the CONTRACT STATUS MFL actually holds ("Vet-WW",
  // "Vet-WW-BL", "Rookie-WW") plus the acquisition date, NOT off the
  // acquisition LABEL: player_acquisition_lookup_<year>.json is a static
  // commish-maintained asset (the 2026 file was generated in March) and does
  // not contain anyone claimed this summer, so a label test silently demoted
  // Benson / Johnson / Luvu to the plain-veteran branch — the reported bug.
  function preseasonWwClassFO(player) {
    var status = safeStr(player && player.type).toLowerCase();
    if (!/\bww\b/.test(status)) return "no";
    if (status.indexOf("tag") !== -1) return "no";
    if (safeInt(player && player.years, 0) !== 1) return "no";
    // Shared with the three auction arms — see isFreshOneYearDefaultFO.
    if (!isFreshOneYearDefaultFO(player)) return "no";
    if (rookieOptionActionEligible(player)) return "no";
    // A WW contract that changed hands by TRADE was not acquired on waivers by
    // its current owner — §C4's trade clock applies, not this ladder.
    if (safeStr(player && player.acquisitionTypeLabel).toLowerCase().indexOf("trade") !== -1) return "no";

    // The pre-season / in-season line is NFL Week 1's FIRST kickoff — the real
    // instant from MFL's schedule, which in 2026 is Wednesday Sep 9, 8:20pm ET,
    // a day earlier than the calendar row this used to read.
    var startMs = contractLadderDatesFO().seasonStartMs;
    var acqMs = acquisitionDateMsFO(player);
    if (acqMs != null) {
      if (startMs == null) return "unknown";          // can't place the pickup
      return acqMs < startMs ? "yes" : "no";          // "no" = in-season path
    }
    // No acquisition date (the usual case for a claim the static lookup
    // predates). Before Week 1 there is nothing to resolve — a WW contract on
    // the roster today cannot have been acquired in a week that hasn't
    // started. On or after Week 1 we genuinely don't know which rule applies.
    if (startMs == null) return "unknown";
    return Date.now() < startMs ? "yes" : "unknown";
  }

  // Acquisition instant, used ONLY for the pre-season / in-season line. Now
  // that the Week 1 boundary is a kickoff rather than a calendar day, the exact
  // time is what decides a claim made ON kickoff day, and MFL's transaction log
  // carries a real unix timestamp (kept by app.js fetchWaiverAcquisitionIndex).
  // Falls back to noon ET of the acquisition day when only a date is known
  // (the static lookup's shape).
  function acquisitionDateMsFO(player) {
    try {
      var unix = safeInt(player && player.acquisitionUnix, 0);
      if (unix > 0) return unix * 1000;
      return acquisitionDayMsFO(player);
    } catch (e) { return null; }
  }
  // Noon ET of the acquisition DAY. The §C3/§C4 in-season clocks count whole
  // days since the pickup, so they stay anchored to the day — deliberately not
  // switched to the exact instant, which would make "Day N of 14" depend on
  // what time of the morning MFL happened to process the run.
  function acquisitionDayMsFO(player) {
    try {
      var raw = safeStr(player && player.acquisitionDate).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
      var d = new Date(raw + "T12:00:00-04:00");
      return isNaN(d.getTime()) ? null : d.getTime();
    } catch (e) { return null; }
  }

  function rosterContractEligibility(player) {
    var years = Math.max(0, safeInt(player && player.years, 0));
    var salary = safeInt(player && player.salary, 0);
    var status = safeStr(player && player.type).toLowerCase();
    var info = safeStr(player && player.special).toLowerCase();
    var rookieOption = rookieOptionStateForPlayer(player);
    var noFurtherExt =
      info.indexOf("no further extensions") !== -1 ||
      info.indexOf("not eligible for tag or extension") !== -1;
    var expiredRookie =
      info.indexOf("expired rookie") !== -1 ||
      (rookieLikeContractStatus(status) && years <= 0);

    // ── MYAC (Multi-Year Auction Contract, §C2) — verbatim mirror of
    // v2/front_office.js rosterContractEligibility (1271-1287). A 1-year
    // DEFAULT from a fresh acquisition can be set to 2 or 3 years until the
    // September contract deadline. Two entry paths (§C1): (1) ERA win →
    // Vet-ERA (matched by the "-era" token on contractStatus); (2) FA Auction
    // → 1-yr Veteran THIS season (matched by the acquisition label + date,
    // which separate a fresh FA-auction Veteran from a HELD final-year
    // Veteran — the latter gets a normal Extension, not MYAC). Acquisition
    // fields are attached by eligibilityForRosterRow / extensionAvailableFor
    // from the lookup loaded in app.js; absent → fresh-auction branch is
    // simply false (ERA branch still works).
    var acqLabel = safeStr(player && player.acquisitionTypeLabel).toLowerCase();
    var acqYr = safeStr(player && player.acquisitionDate).slice(0, 4);
    // All three arms below carry the SAME contract-length gate
    // (isFreshOneYearDefaultFO) — the ERA arm used to carry none at all, which
    // would have handed a MYAC to a multi-year ERA deal the moment it reached
    // its final year. See that helper.
    var oneYearDefault = isFreshOneYearDefaultFO(player);
    var hasEraStatus = status.indexOf("-era") !== -1;
    var isEra = hasEraStatus && oneYearDefault;
    var isFreshAuction = !hasEraStatus && /auction|faa/.test(acqLabel) && oneYearDefault &&
                         acqLabel.indexOf("expired") === -1 && acqLabel.indexOf("rookie") === -1 &&
                         acqYr === currentSeasonFO() && !rookieLikeContractStatus(status) && status.indexOf("tag") === -1;
    // FAA off contractStatus, exactly like ERA above — verbatim mirror of
    // v2/front_office.js. acquisitionTypeLabel comes from the commish-maintained
    // static player_acquisition_lookup_<yr>.json, which cannot contain a player
    // won minutes ago, so the acqLabel path left every fresh FA-Auction winner
    // with Extension as their only option.
    // NOTE: this used to read `!rookieLikeContractStatus(status)`, which excluded
    // ANY status containing "rookie" — including **Rookie-FAA**, a rookie WON IN
    // THE FA AUCTION. Canon line 394 puts every auction win (FA or Expired
    // Rookie) at "1, 2, or 3 years", so those players are entitled to a
    // multi-year auction contract and were being offered Extension as their only
    // option (8 players across 5 teams on 2026-08-23; reported by an owner about
    // Cyrus Allen). The status vocabulary fix that started writing "Rookie-FAA"
    // instead of "Vet-FAA" is what walked them into this clause.
    //
    // The clause's real intent is "don't offer MYAC to someone whose path is the
    // ROOKIE OPTION" — so test that directly. A drafted rookie carries
    // Rookie-Draft and never matches `-faa` anyway.
    var isFreshFaaStatus = status.indexOf("-faa") !== -1 && oneYearDefault &&
                           !rookieOptionActionEligible(player) && status.indexOf("tag") === -1 &&
                           inAuctionMyacMonthWindowFO("faa");
    // ── The pre-season acquisition ladder (canon ~379) ────────────────
    // Two rosters of players walk it: fresh auction wins (the three branches
    // above) and PRE-SEASON WAIVER pickups (Vet-WW / Rookie-WW). Canon and the
    // Discord waiver post treat them identically, so one classifier serves
    // both, and each rung is offered ONLY inside its own window.
    //
    // wwClass "unknown" = a WW contract we cannot place on either ladder (no
    // acquisition date and Week 1 already kicked off). That player gets NO
    // contract action: an unresolvable window is not an open one.
    var wwClass = preseasonWwClassFO(player);
    var auctionLadderEntry = (isEra || isFreshAuction || isFreshFaaStatus) && years === 1;
    var ladder = wwClass === "unknown"
      ? { stage: "unresolved", date: "", endMs: null }
      : ((wwClass === "yes" || auctionLadderEntry) ? contractLadderStageFO() : null);

    // MYAC — ONE rule for both ladder populations, gated on a RESOLVED window.
    //
    // The auction arm used to keep desktop's fail-OPEN unknown-deadline
    // behaviour (isPastContractDeadlineFO returns false when the deadline can't
    // be read). That put it at odds with the copy sitting right next to it: with
    // an unreadable calendar the ladder reports "unresolved" and the Contracts
    // list prints "window can't be confirmed" — while a MYAC button was offered
    // anyway. An action whose window cannot be established must not be offered,
    // so both arms now require ladder.stage === "myac".
    var myacEligible = (auctionLadderEntry || wwClass === "yes") &&
                       !!ladder && ladder.stage === "myac";

    // ── MYM (Mid-Year Multi, §C3) — verbatim mirror of v2/front_office.js
    // rosterContractEligibility (1441-1456). An IN-SEASON WW/FCFS/waiver pickup
    // converts to a FLAT 2- or 3-year deal within 14 days of acquisition.
    // Mutually exclusive with MYAC (auction wins) AND the §C4 extension window
    // (WW days 15-28 = extension, days 1-14 = MYM). The worker re-validates the
    // 14-day window + the 4-per-season cap on submit; this is best-effort.
    // `wwClass === "no"` keeps a PRE-SEASON claim off this path: the 14/28-day
    // clocks are the in-season rule, and a pre-season pickup runs the ladder
    // instead. It also withholds the day-based path from a WW pickup we could
    // not place at all ("unknown").
    var isInSeasonPickup = /\b(ww|fcfs|blind|waiver|free agent)\b/.test(acqLabel) &&
                           acqLabel.indexOf("auction") === -1 && acqYr === currentSeasonFO() &&
                           wwClass === "no";
    // Day-anchored on purpose — see acquisitionDayMsFO.
    var acqDateMs = acquisitionDayMsFO(player);
    var mymDays = acqDateMs != null ? Math.floor((Date.now() - acqDateMs) / 86400000) : null;
    var mymEligible = (isInSeasonPickup && mymDays != null && mymDays >= 0 && mymDays <= 14 &&
                       years <= 1 && status.indexOf("tag") === -1 && !myacEligible &&
                       !rookieOptionActionEligible(player)) ||
                      // Ladder rung 2 — contract deadline → NFL Week 3 kickoff.
                      (!!ladder && ladder.stage === "mym" && !myacEligible &&
                       status.indexOf("tag") === -1 && !rookieOptionActionEligible(player));

    // Extension is suppressed when MYAC OR MYM applies — desktop parity (Keith:
    // nobody extends when they can MYAC; MYM is the days-1-14 path). v2:1286/1455.
    var extensionEligible = !rookieOptionActionEligible(player) && (years === 1 || expiredRookie) &&
                            status.indexOf("tag") === -1 && !noFurtherExt &&
                            !myacEligible && !mymEligible;
    // On the ladder, Extension is rung 3 — Week 3 kickoff → Week 5 kickoff —
    // and nothing after that. Off the ladder (held veterans, rookies, trades,
    // in-season WW days 15-28) the existing rule stands untouched.
    if (ladder) extensionEligible = extensionEligible && ladder.stage === "extension";

    return {
      myacEligible: myacEligible,
      mymEligible: mymEligible,
      // ONLY meaningful for the day-based IN-SEASON rule. A ladder player's
      // window is a calendar boundary, not a clock started by their pickup, so
      // they carry NO day-count — a surface that reads this can no longer tell
      // a ladder player "Day 3 of 14", which is what the player sheet was
      // doing: quoting them a rule that does not apply to their contract.
      mymDaysSinceAcq: ladder ? null : mymDays,
      // The rung this player is on, for the surfaces that print the window.
      // "" when they aren't on the pre-season ladder at all.
      ladderStage: ladder ? ladder.stage : "",
      ladderWindowEnd: ladder ? ladder.date : "",
      ladderWindowEndMs: ladder ? ladder.endMs : null,
      preseasonWaiverPickup: wwClass === "yes",
      extensionEligible: extensionEligible,
      rookieOptionEligible: !!(rookieOption && rookieOption.eligible && !rookieOption.exercised),
      restructureEligible: years >= 2 && years <= 3 && salary > 1000 && !rookieLikeContractStatus(status)
    };
  }

  // ── Extension blocking (RULE-EXT-003) ───────────────────────────────
  // Verbatim mirror of roster_workbench.js:1168-1288. The "Ext:" segment
  // in contractInfo lists UPS FRANCHISES (Long Haulers, HammerTime 🔨 ⏰,
  // Gride, etc.) that previously extended the player. A franchise cannot
  // extend the same player twice; different franchises CAN each extend.
  // Mobile's omission of these helpers was leaking the rule — a player
  // already extended by the current owner was showing as eligible.
  //
  // CRITICAL: normalizeIdentityToken MUST preserve non-ASCII codepoints
  // because HammerTime's official abbrev IS the literal emoji "🔨 ⏰".
  // Stripping non-ASCII collapses it to "" and silently disables the
  // block (CJ Stroud regression filed 2026-04-22 fixed by this preservation).

  function parseExtensionHistoryTokens(contractInfo) {
    var info = safeStr(contractInfo);
    if (!info) return [];
    var match = info.match(/(?:^|\|)\s*Ext:\s*([^|]+)/i);
    if (!match || !safeStr(match[1])) return [];
    return safeStr(match[1])
      .split(/[,/;&]|\band\b/i)
      .map(function (token) { return safeStr(token); })
      .filter(Boolean);
  }

  function normalizeIdentityToken(token) {
    var s = safeStr(token).toLowerCase();
    var out = "";
    for (var i = 0; i < s.length; i += 1) {
      var c = s.charCodeAt(i);
      if (c <= 0x7F) {
        // ASCII: keep only letters (lowercased) and digits.
        if ((c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x7A)) {
          out += s.charAt(i);
        }
        // else: ASCII whitespace / punctuation → drop
      } else {
        // Non-ASCII (emojis in supplementary plane → surrogate pairs;
        // accented letters; CJK; etc.): preserve verbatim so emoji
        // abbrevs like "🔨 ⏰" survive normalization intact.
        out += s.charAt(i);
      }
    }
    return out;
  }

  function teamIdentityTokenMap(team) {
    var map = Object.create(null);

    function add(raw) {
      var text = safeStr(raw);
      if (!text) return;
      var normalized = normalizeIdentityToken(text);
      if (normalized) map[normalized] = true;
      var parts = text.split(/[\s/,&().-]+/);
      for (var i = 0; i < parts.length; i += 1) {
        var token = normalizeIdentityToken(parts[i]);
        if (!token) continue;
        map[token] = true;
        if (token.length >= 5 && /ers$/.test(token)) {
          map[token.slice(0, -3)] = true;
        }
        if (token.length >= 5 && /s$/.test(token)) {
          map[token.slice(0, -1)] = true;
        }
      }
    }

    add(team && team.name);
    add(team && team.abbrev);
    return map;
  }

  function lastExtensionIdentityToken(contractInfo) {
    var tokens = parseExtensionHistoryTokens(contractInfo);
    if (!tokens.length) return "";
    return normalizeIdentityToken(tokens[tokens.length - 1]);
  }

  function identityTokenMatchesTeam(token, team) {
    var normalized = normalizeIdentityToken(token);
    if (!normalized) return false;
    var identity = teamIdentityTokenMap(team);
    if (identity[normalized]) return true;
    var keys = Object.keys(identity);
    for (var i = 0; i < keys.length; i += 1) {
      var key = keys[i];
      if (!key) continue;
      if (normalized.length >= 4 && key.indexOf(normalized) === 0) return true;
      if (key.length >= 4 && normalized.indexOf(key) === 0) return true;
    }
    return false;
  }

  // Mobile equivalent of findTeamById(player.fid). Reads from
  // window.UPS_MOBILE.data.findFranchiseById which queries state.franchises.
  function findTeamForPlayer(player) {
    if (!player) return null;
    var fid = player.fid;
    if (!fid) return null;
    var lookup = window.UPS_MOBILE && window.UPS_MOBILE.data && window.UPS_MOBILE.data.findFranchiseById;
    if (!lookup) return null;
    return lookup(fid);
  }

  function extensionBlockedByCurrentOwner(player) {
    if (!player) return false;
    var team = findTeamForPlayer(player);
    if (!team) return false;
    var playerToken = lastExtensionIdentityToken(player.special || player.contract_info || "");
    if (identityTokenMatchesTeam(playerToken, team)) return true;
    return false;
  }

  function extensionBlockedByHistory(player) {
    // RULE-EXT-003 (2026-04-18): a player can be extended by multiple
    // DIFFERENT UPS franchises. Only the SAME franchise is blocked from
    // extending twice. extensionBlockedByCurrentOwner handles that case.
    // Always returns false; the gate is entirely in BlockedByCurrentOwner.
    return false;
  }

  function extensionBlockedReason(player) {
    if (!extensionBlockedByCurrentOwner(player)) return "";
    var team = findTeamForPlayer(player);
    return safeStr(team && team.name || "This franchise") + " has already extended this player. A player can't be extended twice by the same team.";
  }

  // ── Tag eligibility (matches Front Office) ──────────────────────────
  // Front Office gates Tag/Untag on TWO signals:
  //   1. There's a row in tag_tracking.json for this player (the league
  //      tag plan says they qualify).
  //   2. No OTHER player on the same team has an active tag on the same
  //      side (offense/defense slot not already used).
  // Untag is shown when the player IS the active tagged player.
  //
  // Inputs come from app.js state — never reach into roster_workbench
  // internals. The tag tracking + submissions JSON is fetched in app.js.

  function trackedTaggedPlayerForFranchiseSide(tagSubmissions, fid, side, currentSeason) {
    // Mirror of trackedTaggedPlayerForFranchiseSide: scan submissions for
    // a tag submitted by this franchise on this side that hasn't been
    // untagged. We don't have the full state graph mobile-side; treat any
    // submission with action="tag" and the matching side/fid/season as
    // active unless explicitly superseded by a later "untag" for the same
    // player.
    //
    // CRITICAL: filter by season. tag_submissions.json is append-only
    // across years — without the season check, last year's tags surface
    // as currently active. (Audit 2026-05-16: Lamar Jackson was tagged
    // 2025 by Real Deal Creel and was incorrectly showing as a 2026 tag
    // even though he's not on any 2026 roster.)
    if (!Array.isArray(tagSubmissions) || !fid) return null;
    var normalizedSide = normalizeTagSideValue(side);
    var seasonStr = currentSeason ? String(currentSeason) : "";
    var byPid = {};
    tagSubmissions.forEach(function (row) {
      if (!row) return;
      if (pad4(row.franchise_id) !== pad4(fid)) return;
      // Season filter — only honor submissions matching the current
      // season. Treat missing season as "current" for backward compat
      // with any rows that haven't been re-stamped with explicit season.
      if (seasonStr) {
        var rowSeason = String(row.season || row.year || "");
        if (rowSeason && rowSeason !== seasonStr) return;
      }
      var rowSide = normalizeTagSideValue(row.tag_side || row.side);
      if (rowSide && normalizedSide && rowSide !== normalizedSide) return;
      var pid = String(row.player_id || "").replace(/\D/g, "");
      if (!pid) return;
      var ts = row.submitted_at_utc || row.timestamp || "";
      var kind = String(row.submission_kind || row.kind || "tag").toLowerCase();
      if (!byPid[pid] || ts > byPid[pid].ts) byPid[pid] = { ts: ts, kind: kind, row: row };
    });
    var pids = Object.keys(byPid);
    for (var i = 0; i < pids.length; i++) {
      if (byPid[pids[i]].kind === "tag") return byPid[pids[i]].row;
    }
    return null;
  }

  // Stale-tag filter ported from roster_workbench.js:7132. A roster row
  // with type=TAG is "stale" if tag_tracking has a row for this player
  // with tag_prev_season=1 — meaning the tag is left over from a prior
  // season and shouldn't count as occupying the current-season slot.
  // Without this filter, mobile reported false-positive slot conflicts
  // (Locked button) for the same player desktop showed as taggable.
  function isStaleTagFromPriorSeason(rosterRow, tagTracking) {
    if (!rosterRow) return false;
    var pid = safeStr(rosterRow.id || rosterRow.player_id).replace(/\D/g, "");
    if (!pid) return false;
    var rows = Array.isArray(tagTracking) ? tagTracking : [];
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i] || {};
      if (safeStr(row.player_id).replace(/\D/g, "") !== pid) continue;
      if (safeInt(row.tag_prev_season, 0)) return true;
    }
    return false;
  }

  function activeTaggedPlayerForTeam(rosterRows, side, tagSubmissions, fid, tagTracking, currentSeason) {
    // Roster-first: a player on this team with type="TAG" and matching side
    // is the active tag, UNLESS isStaleTagFromPriorSeason flags it as a
    // leftover from a prior season (in which case the slot is open).
    // Fallback: scan tag submissions for an unaccompanied "tag" record
    // — gated by currentSeason so prior-year tags don't surface.
    var normalizedSide = normalizeTagSideValue(side) || "OFFENSE";
    var list = Array.isArray(rosterRows) ? rosterRows : [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!p) continue;
      if (safeStr(p.contractStatus).toUpperCase() !== "TAG") continue;
      var pos = safeStr(p.position || p.positionGroup).toUpperCase();
      if ((getTagSideFromPos(pos) || "OFFENSE") !== normalizedSide) continue;
      if (isStaleTagFromPriorSeason(p, tagTracking)) continue;
      return p;
    }
    return trackedTaggedPlayerForFranchiseSide(tagSubmissions, fid, normalizedSide, currentSeason);
  }

  // League-wide tag holder for a player THIS SEASON — NO franchise filter.
  // §C8 (canon line 911 item 12): once a player is tagged by ANY franchise,
  // they're locked for EVERYONE — no other team can tag them. Mobile previously
  // only scanned the viewer's own tags, so a player tagged by a DIFFERENT team
  // (e.g. Travis Etienne) wrongly showed as taggable. Folds to the latest
  // tag/untag event per pid; returns the holder row only if the latest is a tag
  // (a later untag releases the lock). Mirrors desktop's per-player lock intent.
  function tagHolderAnywhere(tagSubmissions, pid, currentSeason) {
    if (!Array.isArray(tagSubmissions) || !pid) return null;
    var want = String(pid).replace(/\D/g, "");
    var seasonStr = currentSeason ? String(currentSeason) : "";
    var latest = null;
    tagSubmissions.forEach(function (row) {
      if (!row) return;
      if (String(row.player_id || "").replace(/\D/g, "") !== want) return;
      if (seasonStr) {
        var rowSeason = String(row.season || row.year || "");
        if (rowSeason && rowSeason !== seasonStr) return;
      }
      var ts = row.submitted_at_utc || row.timestamp || "";
      var kind = String(row.submission_kind || row.kind || "tag").toLowerCase();
      if (!latest || ts > latest.ts) latest = { ts: ts, kind: kind, row: row };
    });
    return (latest && latest.kind === "tag") ? latest.row : null;
  }

  // Given the viewer's roster + tag tracking data, decide what tag action
  // to show for `rosterRow` (the player being inspected in the mobile
  // player sheet). Returns one of:
  //   { kind: "none",  reason: "not_in_tag_plan"  }
  //   { kind: "tag",   row: <tag_tracking_row>    }   ← show "Tag" button
  //   { kind: "untag", row: <tag_tracking_row>    }   ← show "Untag" button
  //   { kind: "locked", conflictingPlayer: <p>    }   ← show greyed-out "Locked"
  function tagActionForPlayer(args) {
    args = args || {};
    var rosterRow = args.rosterRow;
    var fid = args.fid;
    var rosterRowsWithPos = args.rosterRowsWithPos || [];  // [{id, position, contractStatus}, ...]
    var tagTracking = args.tagTracking || [];
    var tagSubmissions = args.tagSubmissions || [];
    var currentSeason = args.currentSeason || "";
    if (!rosterRow || !fid) return { kind: "none", reason: "no_player_or_team" };

    var pid = String(rosterRow.id).replace(/\D/g, "");

    // §C8 LEAGUE-WIDE LOCK — if ANY franchise has an active tag on this player
    // this season, they're locked for everyone (desktop parity). Only the
    // tagging franchise itself falls through (to get its Untag); every other
    // viewer sees "locked". This runs BEFORE the plan-row lookup so a player
    // tagged by another team locks even if he isn't in the viewer's tag plan.
    var anyHolder = tagHolderAnywhere(tagSubmissions, pid, currentSeason);
    if (anyHolder && pad4(anyHolder.franchise_id) !== pad4(fid)) {
      return { kind: "locked", reason: "tagged_by_other_franchise", holder: anyHolder, conflictingPlayer: rosterRow };
    }

    // Step 1 — find this player's row in the league tag plan.
    var planRow = null;
    for (var i = 0; i < tagTracking.length; i++) {
      var t = tagTracking[i];
      if (!t) continue;
      if (String(t.player_id || "").replace(/\D/g, "") !== pid) continue;
      if (pad4(t.franchise_id) !== pad4(fid)) continue;
      planRow = t;
      break;
    }
    if (!planRow) {
      // Player not in tag plan = not eligible.
      return { kind: "none", reason: "not_in_tag_plan" };
    }

    // Step 2 — is THIS player the team's currently-active tag on this side?
    // tag_tracking.json uses "tag_side" (e.g. "IDP_K", "OFFENSE"); fall
    // back to position-derived side for safety.
    var side = normalizeTagSideValue(planRow.tag_side || planRow.side) ||
               getTagSideFromPos(planRow.position);
    var active = activeTaggedPlayerForTeam(rosterRowsWithPos, side, tagSubmissions, fid, tagTracking, currentSeason);
    var activePid = active ? String(active.id || active.player_id || "").replace(/\D/g, "") : "";

    if (activePid && activePid === pid) return { kind: "untag", row: planRow };
    if (activePid && activePid !== pid) {
      return { kind: "locked", conflictingPlayer: active, row: planRow };
    }
    return { kind: "tag", row: planRow };
  }

  // ── END verbatim mirror ──────────────────────────────────────────────

  // Adapt a mobile rosterRow to the desktop "player" shape the eligibility
  // predicates expect. Mobile state stores roster rows with MFL field names
  // (contractYear → years, contractInfo → special, contractStatus → type).
  // Also attaches the acquisition label/date the MYAC §C2 branch needs,
  // resolved from the lookup loaded in app.js (data.acquisitionForPlayer).
  // Both eligibilityForRosterRow and extensionAvailableFor use this so they
  // agree on myacEligible (the footer reconciles the two — player_sheet.js).
  function adaptRosterRowForEligibility(rosterRow, fid) {
    var resolvedFid = fid || rosterRow.fid || rosterRow.franchise_id || "";
    var acq = null;
    var data = window.UPS_MOBILE && window.UPS_MOBILE.data;
    if (data && data.acquisitionForPlayer) acq = data.acquisitionForPlayer(resolvedFid, rosterRow.id);
    return {
      id: rosterRow.id,
      years: rosterRow.contractYear,
      salary: rosterRow.salary,
      special: rosterRow.contractInfo,
      type: rosterRow.contractStatus,
      fid: resolvedFid,
      acquisitionTypeLabel: acq ? acq.label : "",
      acquisitionDate: acq ? acq.date : "",
      // Present only on rows resolved from MFL's live transaction log. The
      // pre-season / in-season line is a kickoff INSTANT, so an exact
      // acquisition time settles a claim made on kickoff day; the static
      // lookup only knows the day and falls back to noon ET.
      acquisitionUnix: acq ? acq.unix : 0
    };
  }

  function eligibilityForRosterRow(rosterRow, fid) {
    if (!rosterRow) {
      return { myacEligible: false, extensionEligible: false, rookieOptionEligible: false, restructureEligible: false };
    }
    return rosterContractEligibility(adaptRosterRowForEligibility(rosterRow, fid));
  }

  // The ladder window a roster row is CURRENTLY in — for the surfaces that
  // print dates (contracts.js). Derived from the same call the action buttons
  // gate on, so the date shown and the button offered can never disagree.
  //   stage: "" (not on the ladder) | "myac" | "mym" | "extension" |
  //          "closed" | "unresolved"
  //   endDate: ISO yyyy-mm-dd the open window runs through, "" when there
  //            isn't one to publish. Never a guess.
  function contractWindowForRosterRow(rosterRow, fid) {
    var blank = { onLadder: false, stage: "", endDate: "", endMs: null, preseasonWaiverPickup: false };
    if (!rosterRow) return blank;
    var e = rosterContractEligibility(adaptRosterRowForEligibility(rosterRow, fid));
    if (!e.ladderStage) return blank;
    return {
      onLadder: true,
      stage: e.ladderStage,
      endDate: safeStr(e.ladderWindowEnd),
      // The exact instant the window shuts (a kickoff for MYM/Extension). The
      // ISO day above is for printing; countdowns should use this.
      endMs: e.ladderWindowEndMs,
      preseasonWaiverPickup: !!e.preseasonWaiverPickup
    };
  }

  // The SINGLE gate every caller should use to decide whether to show an
  // extension affordance for a player. Runs the base eligibility check
  // AND the RULE-EXT-003 block check. Returns:
  //   { ok: bool, reason: string }
  // - ok=true when eligible AND not blocked
  // - reason populated when ok=false to allow UI to show the explanation
  //   (e.g. "HammerTime 🔨 ⏰ has already extended this player.")
  // Was-tagged-this-season check. Per league_context §C8.2:
  //   "Once tagged, player CANNOT be extended OR MYM'd by ANY team
  //    in the year tagged. Exception: if cut BEFORE FA Auction starts,
  //    tag is nullified and normal rules resume."
  //
  // A reverted-but-not-cut player still counts as TAGGED for this rule.
  // The check scans state.tagSubmissions for any "tag" action this
  // season matching the player_id. If found, extension is blocked.
  //
  // (The "if cut before auction" exception requires the player to no
  // longer be on the franchise's roster — we deliberately don't try to
  // detect that here because if a player WAS cut they aren't being
  // rendered as an extension candidate anyway.)
  function wasTaggedThisSeason(playerId, currentSeason) {
    var s = window.UPS_MOBILE && window.UPS_MOBILE.state;
    var subs = (s && s.tagSubmissions) || [];
    if (!Array.isArray(subs)) return false;
    var pid = String(playerId || "").replace(/\D/g, "");
    var seasonStr = currentSeason != null ? String(currentSeason) : "";
    for (var i = 0; i < subs.length; i++) {
      var row = subs[i] || {};
      if (String(row.player_id || "").replace(/\D/g, "") !== pid) continue;
      if (seasonStr) {
        var rowSeason = String(row.season || row.year || "");
        if (rowSeason && rowSeason !== seasonStr) continue;
      }
      var kind = String(row.submission_kind || row.kind || "tag").toLowerCase();
      if (kind === "tag") return true;
    }
    return false;
  }

  function extensionAvailableFor(rosterRow, fid) {
    if (!rosterRow) return { ok: false, reason: "" };
    var adapted = adaptRosterRowForEligibility(rosterRow, fid);
    var base = rosterContractEligibility(adapted);
    // extensionEligible is already false when MYAC applies (§C2 suppresses
    // Extend), so a MYAC-eligible player correctly returns ok:false here.
    if (!base.extensionEligible) return { ok: false, reason: "" };
    // §C8.2 — a player TAGGED this season (even one who was untagged
    // back to their prior contract) cannot be extended this season.
    var s = window.UPS_MOBILE && window.UPS_MOBILE.state;
    var curSeason = s && s.ctx && s.ctx.year;
    if (wasTaggedThisSeason(rosterRow.id, curSeason)) {
      return { ok: false, reason: "Tagged this season — extension blocked (§C8.2)." };
    }
    if (extensionBlockedByCurrentOwner(adapted)) {
      return { ok: false, reason: extensionBlockedReason(adapted) };
    }
    if (extensionBlockedByHistory(adapted)) {
      return { ok: false, reason: "Extension blocked by history." };
    }
    return { ok: true, reason: "" };
  }

  window.UPS_FRONT_OFFICE_ACTIONS = {
    rookieLikeContractStatus: rookieLikeContractStatus,
    parseRookieOptionToken: parseRookieOptionToken,
    rookieOptionStateForPlayer: rookieOptionStateForPlayer,
    rookieOptionActionEligible: rookieOptionActionEligible,
    rosterContractEligibility: rosterContractEligibility,
    eligibilityForRosterRow: eligibilityForRosterRow,
    contractWindowForRosterRow: contractWindowForRosterRow,
    contractLadderStage: contractLadderStageFO,
    contractLadderDates: contractLadderDatesFO,
    isPastContractDeadlineFO: isPastContractDeadlineFO,
    extensionAvailableFor: extensionAvailableFor,
    extensionBlockedByCurrentOwner: extensionBlockedByCurrentOwner,
    extensionBlockedByHistory: extensionBlockedByHistory,
    extensionBlockedReason: extensionBlockedReason,
    parseExtensionHistoryTokens: parseExtensionHistoryTokens,
    normalizeIdentityToken: normalizeIdentityToken,
    teamIdentityTokenMap: teamIdentityTokenMap,
    lastExtensionIdentityToken: lastExtensionIdentityToken,
    identityTokenMatchesTeam: identityTokenMatchesTeam,
    normalizeTagSideValue: normalizeTagSideValue,
    getTagSideFromPos: getTagSideFromPos,
    tagActionForPlayer: tagActionForPlayer,
    activeTaggedPlayerForTeam: activeTaggedPlayerForTeam,
    trackedTaggedPlayerForFranchiseSide: trackedTaggedPlayerForFranchiseSide
  };
})();
