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
 * bodies here verbatim. Source-of-truth lines (roster_workbench.js):
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

  // §C2 MYAC window closes at the September contract deadline. Verbatim
  // mirror of v2/front_office.js isPastContractDeadlineFO (1297): an unknown
  // deadline → within window (show MYAC) so a load failure never blocks the
  // option. state.contractDeadline is loaded in app.js (fetchContractDeadline).
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
  // early August). Serves as the MYAC window's LOWER bound, because
  // isPastContractDeadlineFO fails OPEN and would otherwise re-offer MYAC on a
  // stale un-converted Vet-FAA in the Jan-Mar gap before MFL's league rollover.
  function currentEtMonthFO() {
    try {
      return safeInt(new Date().toLocaleString("en-US", { timeZone: "America/New_York", month: "numeric" }), 0);
    } catch (_) { return new Date().getMonth() + 1; }
  }
  function inAuctionMyacMonthWindowFO(kind) {
    var m = currentEtMonthFO();
    return kind === "era" ? m >= 5 : m >= 7;
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
    var isEra = status.indexOf("-era") !== -1;
    var isFreshAuction = !isEra && /auction|faa/.test(acqLabel) &&
                         acqLabel.indexOf("expired") === -1 && acqLabel.indexOf("rookie") === -1 &&
                         acqYr === currentSeasonFO() && !rookieLikeContractStatus(status) && status.indexOf("tag") === -1;
    // FAA off contractStatus, exactly like ERA above — verbatim mirror of
    // v2/front_office.js. acquisitionTypeLabel comes from the commish-maintained
    // static player_acquisition_lookup_<yr>.json, which cannot contain a player
    // won minutes ago, so the acqLabel path left every fresh FA-Auction winner
    // with Extension as their only option. CL===1 = still on the 1-year default
    // (canon §C2); fails CLOSED on an unreadable CL.
    var isFreshFaaStatus = status.indexOf("-faa") !== -1 &&
                           parseContractLengthValueFO(player && player.special) === 1 &&
                           !rookieLikeContractStatus(status) && status.indexOf("tag") === -1 &&
                           inAuctionMyacMonthWindowFO("faa");
    var myacEligible = (isEra || isFreshAuction || isFreshFaaStatus) &&
                       years === 1 && !isPastContractDeadlineFO();

    // ── MYM (Mid-Year Multi, §C3) — verbatim mirror of v2/front_office.js
    // rosterContractEligibility (1441-1456). An IN-SEASON WW/FCFS/waiver pickup
    // converts to a FLAT 2- or 3-year deal within 14 days of acquisition.
    // Mutually exclusive with MYAC (auction wins) AND the §C4 extension window
    // (WW days 15-28 = extension, days 1-14 = MYM). The worker re-validates the
    // 14-day window + the 4-per-season cap on submit; this is best-effort.
    var isInSeasonPickup = /\b(ww|fcfs|blind|waiver|free agent)\b/.test(acqLabel) &&
                           acqLabel.indexOf("auction") === -1 && acqYr === currentSeasonFO();
    var acqDateMs = (function () {
      try {
        var d = new Date(safeStr(player && player.acquisitionDate).slice(0, 10) + "T12:00:00-04:00");
        return isNaN(d.getTime()) ? null : d.getTime();
      } catch (e) { return null; }
    })();
    var mymDays = acqDateMs != null ? Math.floor((Date.now() - acqDateMs) / 86400000) : null;
    var mymEligible = isInSeasonPickup && mymDays != null && mymDays >= 0 && mymDays <= 14 &&
                      years <= 1 && status.indexOf("tag") === -1 && !myacEligible &&
                      !rookieOptionActionEligible(player);

    return {
      myacEligible: myacEligible,
      mymEligible: mymEligible,
      mymDaysSinceAcq: mymDays,
      // Extension is suppressed when MYAC OR MYM applies — desktop parity (Keith:
      // nobody extends when they can MYAC; MYM is the days-1-14 path). v2:1286/1455.
      extensionEligible: !rookieOptionActionEligible(player) && (years === 1 || expiredRookie) && status.indexOf("tag") === -1 && !noFurtherExt && !myacEligible && !mymEligible,
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
      acquisitionDate: acq ? acq.date : ""
    };
  }

  function eligibilityForRosterRow(rosterRow, fid) {
    if (!rosterRow) {
      return { myacEligible: false, extensionEligible: false, rookieOptionEligible: false, restructureEligible: false };
    }
    return rosterContractEligibility(adaptRosterRowForEligibility(rosterRow, fid));
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
