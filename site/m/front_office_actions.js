/* site/m/front_office_actions.js
 *
 * VERBATIM MIRROR of the contract-action eligibility + deep-link plumbing
 * in site/rosters/roster_workbench.js. Mobile uses this to:
 *   • compute which contract actions are available for a player
 *     (extension / rookie option / tag / restructure / untag)
 *   • build the same MFL Contract Command Center (CCC) deep-link URL
 *     that the desktop "open this action" buttons use
 *
 * Mobile does NOT reimplement the option pickers, payload builders, or
 * submit handlers — those live on desktop and run there when the user
 * lands on the CCC via the deep-link. Mobile is purely a launcher.
 *
 * DO NOT EDIT logic. If desktop changes, copy the updated function
 * bodies here verbatim. Source-of-truth lines (roster_workbench.js):
 *   safeStr (201) · safeInt (226) · pad4 (315)
 *   rookieLikeContractStatus (553) · rosterContractEligibility (558)
 *   parseRookieOptionToken (578) · rookieOptionStateForPlayer (600)
 *   rookieOptionActionEligible (615)
 *   buildLeagueModuleUrl (7206) · buildLeagueModuleHashUrl (7224)
 *   buildContractCenterActionUrl (7265)
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

    return {
      extensionEligible: !rookieOptionActionEligible(player) && (years === 1 || expiredRookie) && status.indexOf("tag") === -1 && !noFurtherExt,
      rookieOptionEligible: !!(rookieOption && rookieOption.eligible && !rookieOption.exercised),
      restructureEligible: years >= 2 && years <= 3 && salary > 1000 && !rookieLikeContractStatus(status)
    };
  }

  // ── END verbatim mirror ──────────────────────────────────────────────

  // ── Deep-link URL builder ────────────────────────────────────────────
  // Desktop builds this URL via buildContractCenterActionUrl (7265). On
  // mobile we can't read state.ctx, so signature takes year/leagueId/etc.
  // as explicit args. The resulting URL string is byte-identical to what
  // desktop produces for the same player + action — verified by inspecting
  // buildLeagueModuleUrl (7206) and buildLeagueModuleHashUrl (7224).
  //
  //   buildLeagueModuleUrl produces:
  //     {origin}/{year}/home/{leagueId}?MODULE={moduleValue}
  //   buildLeagueModuleHashUrl then adds:
  //     #{cccAction=...&cccPlayer=...&cccFranchise=...&cccSeason=...&cccYears=N}
  function buildContractCenterActionUrl(args) {
    args = args || {};
    var action = safeStr(args.action).toLowerCase();
    var pid = safeStr(args.pid);
    var fid = pad4(args.fid);
    var year = safeStr(args.year);
    var leagueId = safeStr(args.leagueId);
    var years = args.years; // for "extension"
    // Desktop sends MFL home origin: window.location.origin from the user's
    // MFL session. Off-MFL (github.io / local dev) we hard-code the league
    // shard host so the deep-link still works.
    var mflOrigin = args.mflOrigin || "https://www48.myfantasyleague.com";
    var base = mflOrigin + "/" + encodeURIComponent(year) +
               "/home/" + encodeURIComponent(leagueId);
    var qs = "MODULE=MESSAGE2";
    var hashParams = {
      cccAction: action,
      cccPlayer: pid,
      cccFranchise: fid,
      cccSeason: year
    };
    if (action === "extension") {
      hashParams.cccYears = Math.max(1, Math.min(2, safeInt(years, 1) || 1));
    }
    var hash = [];
    Object.keys(hashParams).forEach(function (k) {
      var v = hashParams[k];
      if (v == null || v === "") return;
      hash.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(v)));
    });
    return base + "?" + qs + "#" + hash.join("&");
  }

  // Convenience: build a rosterRow-flavored "player" object compatible
  // with the eligibility helpers above. Mobile state stores roster rows
  // with MFL field names (contractYear → years, contractInfo → special,
  // contractStatus → type).
  function eligibilityForRosterRow(rosterRow) {
    if (!rosterRow) {
      return { extensionEligible: false, rookieOptionEligible: false, restructureEligible: false };
    }
    var adapted = {
      id: rosterRow.id,
      years: rosterRow.contractYear,
      salary: rosterRow.salary,
      special: rosterRow.contractInfo,
      type: rosterRow.contractStatus
    };
    return rosterContractEligibility(adapted);
  }

  window.UPS_FRONT_OFFICE_ACTIONS = {
    rookieLikeContractStatus: rookieLikeContractStatus,
    parseRookieOptionToken: parseRookieOptionToken,
    rookieOptionStateForPlayer: rookieOptionStateForPlayer,
    rookieOptionActionEligible: rookieOptionActionEligible,
    rosterContractEligibility: rosterContractEligibility,
    eligibilityForRosterRow: eligibilityForRosterRow,
    buildContractCenterActionUrl: buildContractCenterActionUrl
  };
})();
