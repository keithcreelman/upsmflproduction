/* site/m/front_office_actions.js
 *
 * VERBATIM MIRROR of the contract-action eligibility + deep-link plumbing
 * in site/rosters/roster_workbench.js. Mobile uses this to:
 *   • compute which contract actions are available for a player
 *     (extension / rookie option / tag / restructure / untag)
 *   • build the same MFL Contract Command Center (CCC) deep-link URL
 *     that the desktop "open this action" buttons use
 *   • check tag eligibility from site/ccc/tag_tracking.json the same way
 *     Front Office does (per-player row + per-team-side conflict check)
 *
 * Mobile does NOT reimplement the option pickers, payload builders, or
 * submit handlers — those live on desktop and run there when the user
 * lands on the CCC via the deep-link. Mobile is purely a launcher.
 *
 * DO NOT EDIT logic. If desktop changes, copy the updated function
 * bodies here verbatim. Source-of-truth lines (roster_workbench.js):
 *   safeStr (201) · safeInt (226) · pad4 (315)
 *   TAG_OFFENSE_POS (84) · normalizeTagSideValue (265) · getTagSideFromPos (272)
 *   rookieLikeContractStatus (553) · rosterContractEligibility (558)
 *   parseRookieOptionToken (578) · rookieOptionStateForPlayer (600)
 *   rookieOptionActionEligible (615)
 *   isStaleTagFromPriorSeason (7128) · activeTaggedPlayerForTeamSide (7145)
 *   conflictingTaggedPlayerForRow (7158)
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

  function trackedTaggedPlayerForFranchiseSide(tagSubmissions, fid, side) {
    // Mirror of trackedTaggedPlayerForFranchiseSide: scan submissions for
    // a tag submitted by this franchise on this side that hasn't been
    // untagged. We don't have the full state graph mobile-side; treat any
    // submission with action="tag" and the matching side/fid as active
    // unless explicitly superseded by a later "untag" for the same player.
    if (!Array.isArray(tagSubmissions) || !fid) return null;
    var normalizedSide = normalizeTagSideValue(side);
    var byPid = {};
    tagSubmissions.forEach(function (row) {
      if (!row) return;
      if (pad4(row.franchise_id) !== pad4(fid)) return;
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

  function activeTaggedPlayerForTeam(rosterRows, side, tagSubmissions, fid) {
    // Roster-first: a player on this team with type="TAG" and matching side
    // is the active tag (unless stale from a prior season — Front Office
    // checks via isStaleTagFromPriorSeason which needs more state; mobile
    // falls back to "if it's on roster as TAG, treat as active").
    var normalizedSide = normalizeTagSideValue(side) || "OFFENSE";
    var list = Array.isArray(rosterRows) ? rosterRows : [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!p) continue;
      if (safeStr(p.contractStatus).toUpperCase() !== "TAG") continue;
      var pos = safeStr(p.position || p.positionGroup).toUpperCase();
      if ((getTagSideFromPos(pos) || "OFFENSE") !== normalizedSide) continue;
      return p;
    }
    return trackedTaggedPlayerForFranchiseSide(tagSubmissions, fid, normalizedSide);
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
    if (!rosterRow || !fid) return { kind: "none", reason: "no_player_or_team" };

    var pid = String(rosterRow.id).replace(/\D/g, "");

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
    var side = normalizeTagSideValue(planRow.side) || getTagSideFromPos(planRow.position);
    var active = activeTaggedPlayerForTeam(rosterRowsWithPos, side, tagSubmissions, fid);
    var activePid = active ? String(active.id || active.player_id || "").replace(/\D/g, "") : "";

    if (activePid && activePid === pid) return { kind: "untag", row: planRow };
    if (activePid && activePid !== pid) {
      return { kind: "locked", conflictingPlayer: active, row: planRow };
    }
    return { kind: "tag", row: planRow };
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
    buildContractCenterActionUrl: buildContractCenterActionUrl,
    normalizeTagSideValue: normalizeTagSideValue,
    getTagSideFromPos: getTagSideFromPos,
    tagActionForPlayer: tagActionForPlayer,
    activeTaggedPlayerForTeam: activeTaggedPlayerForTeam,
    trackedTaggedPlayerForFranchiseSide: trackedTaggedPlayerForFranchiseSide
  };
})();
