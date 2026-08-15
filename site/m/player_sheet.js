/* Mobile player sheet — slim bottom-sheet view of a player.
   Independent of site/shared/player_profile_master.js (per plan: do not
   touch the regular site). Loads /api/player-bundle for season stats. */
(function () {
  "use strict";
  if (!window.UPS_MOBILE) return;

  var U = window.UPS_MOBILE.util;
  var API = window.UPS_MOBILE.api;
  var DATA = window.UPS_MOBILE.data;
  var ACT = window.UPS_MOBILE.actions;

  var bundleCache = {};
  var newsCache = {};          // pid → rendered-ready items[] from /api/player-news (see loadPlayerNews)
  var activeTab = "actions";   // player sheet tab: actions | stats | news | bio
  var currentBundle = null;    // /api/player-bundle result for the open player

  // "2026-10-08" → "Oct 8, 2026". Same shape the Contracts list prints, so a
  // window date reads identically wherever the owner meets it. Parsed as a
  // plain y/m/d — never through Date's timezone handling, which would shift an
  // ISO day back one in every US timezone.
  var SHEET_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function prettyIsoDay(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(U.safeStr(iso));
    if (!m) return U.safeStr(iso);
    var mo = parseInt(m[2], 10);
    if (!(mo >= 1 && mo <= 12)) return U.safeStr(iso);
    return SHEET_MONTHS[mo - 1] + " " + parseInt(m[3], 10) + ", " + m[1];
  }

  function ensureMount() {
    var mount = document.getElementById("ups-m-sheet-mount");
    if (!mount) return null;
    if (!mount.firstChild) {
      mount.innerHTML =
        '<div class="ups-m-sheet-overlay" id="ups-m-sheet-overlay">' +
        '  <div class="ups-m-sheet" id="ups-m-sheet" role="dialog" aria-modal="true" aria-label="Player details">' +
        '    <button class="ups-m-sheet-close" id="ups-m-sheet-close" aria-label="Close">×</button>' +
        '    <div class="ups-m-sheet-grip"></div>' +
        '    <div class="ups-m-sheet-head" id="ups-m-sheet-head"></div>' +
        '    <div class="ups-m-sheet-tabs" id="ups-m-sheet-tabs" role="tablist"></div>' +
        '    <div class="ups-m-sheet-body" id="ups-m-sheet-body"></div>' +
        '    <div class="ups-m-sheet-foot" id="ups-m-sheet-foot"></div>' +
        '  </div>' +
        '</div>';
      var overlay = document.getElementById("ups-m-sheet-overlay");
      overlay.addEventListener("click", function (e) {
        if (e.target === overlay) close();
      });
      document.getElementById("ups-m-sheet-close").addEventListener("click", close);
      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && overlay.classList.contains("open")) close();
      });
      // Tab switching (Actions / Stats / Bio). Delegated so it survives the
      // per-open re-render of the tab labels.
      var tabsNav = document.getElementById("ups-m-sheet-tabs");
      if (tabsNav) tabsNav.addEventListener("click", function (e) {
        var btn = e.target && e.target.closest ? e.target.closest(".ups-m-sheet-tab") : null;
        if (btn && btn.getAttribute("data-tab")) setTab(btn.getAttribute("data-tab"));
      });
    }
    return mount;
  }

  function close() {
    var overlay = document.getElementById("ups-m-sheet-overlay");
    if (overlay) overlay.classList.remove("open");
    document.body.style.overflow = "";
  }

  function fmtPlayerName(raw) {
    // MFL stores names as "Lastname, Firstname [Suffix]".
    var s = U.safeStr(raw);
    if (!s) return "";
    if (s.indexOf(",") >= 0) {
      var parts = s.split(",");
      var last = (parts[0] || "").trim();
      var rest = (parts[1] || "").trim();
      return rest ? rest + " " + last : last;
    }
    return s;
  }

  function rowContractBlock(rosterRow) {
    if (!rosterRow) return '';
    var salary = U.fmtUsd(rosterRow.salary);
    var cy = U.safeStr(rosterRow.contractYear);
    var status = U.safeStr(rosterRow.contractStatus);
    var info = U.safeStr(rosterRow.contractInfo);
    var live = U.safeStr(rosterRow.status);
    var yrsRem = (cy && Number(cy) > 0) ? cy + " yr" + (cy === "1" ? "" : "s") + " left" :
                 (cy === "0" ? "Expired" : "—");
    return '' +
      '<div class="ups-m-sheet-block">' +
        '<h4>Contract</h4>' +
        '<div class="ups-m-sheet-kv">' +
          '<div class="lbl">Salary</div><div class="val">' + U.escapeHtml(salary) + '</div>' +
          '<div class="lbl">Years left</div><div class="val">' + U.escapeHtml(yrsRem) + '</div>' +
          (status ? '<div class="lbl">Type</div><div class="val">' + U.escapeHtml(status) + '</div>' : '') +
          (live ? '<div class="lbl">Status</div><div class="val">' + U.escapeHtml(live) + '</div>' : '') +
          (info ? '<div class="lbl">Notes</div><div class="val">' + U.escapeHtml(info) + '</div>' : '') +
        '</div>' +
      '</div>';
  }

  function findRosterRowAcrossLeague(pid) {
    // Search every franchise's roster for this pid. Returns { row, fid } or null.
    var s = window.UPS_MOBILE.state;
    if (!s.rosters || !s.rosters.rosters) return null;
    var fr = U.asArray(s.rosters.rosters.franchise);
    for (var i = 0; i < fr.length; i++) {
      var players = U.asArray(fr[i].player);
      for (var j = 0; j < players.length; j++) {
        if (String(players[j].id) === String(pid)) {
          return {
            fid: U.pad4(fr[i].id),
            row: {
              id: String(players[j].id),
              status: U.safeStr(players[j].status),
              salary: Number(players[j].salary || 0),
              contractYear: U.safeStr(players[j].contractYear),
              contractStatus: U.safeStr(players[j].contractStatus),
              contractInfo: U.safeStr(players[j].contractInfo)
            }
          };
        }
      }
    }
    return null;
  }

  function renderStatsBlock(bundle) {
    // Always show 3 rows: current season + last 2. Fill missing data with
    // zeros (Keith 2026-05-15). Columns: Games Played, Points, PPG, PPG Rank.
    //
    // Sources from /api/player-bundle:
    //   bundle.career_summary  → [{ season, season_points }, ...]   (worker-built)
    //   bundle.profile.playerProfile.seasons.season → [{ year, games, fantasyPoints, ... }]  (MFL)
    //
    // PPG Rank is not yet exposed in the bundle, so we render 0 for now.
    // Wire real ranks later via the advanced-stats-leaderboard endpoint.
    var ctx = window.UPS_MOBILE.state.ctx;
    var curYear = Number(ctx.year) || (new Date().getUTCFullYear());
    // Seed the year window from the latest year with REAL data, not the
    // calendar year. In the NFL offseason ctx.year flips to N before any
    // games have been played, and showing a "2026" row before any 2026
    // games exist duplicates 2025 data into it. latestYearWithData (set
    // by app.js fetchAdvancedStatsLeaderboard) points at the most recent
    // year whose leaderboard returned rows.
    var getLatest = window.UPS_MOBILE.data.getAdvancedStatsLatestYear;
    var anchor = (getLatest && getLatest()) || curYear;
    var years = [anchor, anchor - 1, anchor - 2];
    ctx.curYearForLeaderboard = anchor;

    var careerByYear = {};
    if (bundle && Array.isArray(bundle.career_summary)) {
      bundle.career_summary.forEach(function (r) {
        if (!r) return;
        careerByYear[Number(r.season)] = r;
      });
    }
    var seasonsByYear = {};
    if (bundle && bundle.profile) {
      var pp = bundle.profile.playerProfile || {};
      U.asArray(pp.seasons && pp.seasons.season).forEach(function (s) {
        if (!s) return;
        seasonsByYear[Number(s.year || s.season)] = s;
      });
    }

    // Per-year leaderboard stats from Advanced Stats Workbench (real PPG +
    // positional rank). Each of the 3 displayed years gets its own
    // leaderboard map; we preload all three at app boot.
    var pid = (window.UPS_MOBILE.state && window.UPS_MOBILE.state._sheetPid) || "";
    var getStats = window.UPS_MOBILE.data.getAdvancedStatsFor;
    var rows = years.map(function (y) {
      var c = careerByYear[y] || {};
      var s = seasonsByYear[y] || {};
      var stats = getStats ? getStats(pid, y) : null;
      var games, pts, ppg, ppgRank;
      // Prefer career_summary — the SAME source the desktop master profile
      // uses (site/shared/player_profile_master.js). It carries games_played,
      // season_points, avg_ppg AND pos_ppg_rank and is internally consistent,
      // so the table matches desktop. Fall back to the Advanced-Stats
      // leaderboard (league-wide, may omit a player in a given year), then to
      // MFL playerProfile.seasons.
      if (c && (c.season_points != null || c.games_played != null)) {
        games = Number(c.games_played || 0);
        pts = Number(c.season_points || 0);
        ppg = Number(c.avg_ppg != null ? c.avg_ppg : (games > 0 ? pts / games : 0));
        ppgRank = Number(c.pos_ppg_rank || 0);
      } else if (stats) {
        games = Number(stats.games || 0);
        pts = Number(stats.mfl_points || 0);
        ppg = Number(stats.mfl_ppg || 0);
        ppgRank = Number(stats.posRank || 0);
      } else {
        games = Number(s.games || s.gamesPlayed || 0) || 0;
        pts = Number(s.fantasyPoints || s.points || s.total || 0) || 0;
        ppg = games > 0 ? (pts / games) : 0;
        ppgRank = Number(s.pos_ppg_rank || 0) || 0;
      }
      return '<tr>' +
        '<td>' + y + '</td>' +
        '<td>' + games + '</td>' +
        '<td>' + (Math.round(pts * 10) / 10).toFixed(1) + '</td>' +
        '<td>' + (Math.round(ppg * 10) / 10).toFixed(1) + '</td>' +
        '<td>' + (ppgRank > 0 ? ppgRank : 0) + '</td>' +
      '</tr>';
    }).join("");

    return '' +
      '<table class="ups-m-stat-table">' +
        '<thead><tr><th>Year</th><th>G</th><th>Pts</th><th>PPG</th><th>PPG Rk</th></tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>';
  }

  function loadBundle(pid) {
    if (bundleCache[pid]) return Promise.resolve(bundleCache[pid]);
    // /api/player-bundle REQUIRES &L= (else it 400s "Missing L param" and the
    // career_summary fallback for the Season Stats table is empty — players
    // missing from the leaderboard, e.g. Michael Mayer in 2024/25, then show
    // 0 pts). Pass L+YEAR exactly like the desktop master profile
    // (site/shared/player_profile_master.js fetchBundle).
    var ctx = window.UPS_MOBILE.state.ctx;
    var url = API.workerUrl("/api/player-bundle?pid=" + encodeURIComponent(pid) +
      "&L=" + encodeURIComponent(ctx.leagueId) + "&YEAR=" + encodeURIComponent(ctx.year));
    return fetch(url, { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (b) { if (b) bundleCache[pid] = b; return b; })
      .catch(function () { return null; });
  }

  function isOwnRoster(pid) {
    var s = window.UPS_MOBILE.state;
    if (!s.viewerFranchiseId || !s.rosters || !s.rosters.rosters) return false;
    var fr = U.asArray(s.rosters.rosters.franchise);
    for (var i = 0; i < fr.length; i++) {
      if (U.pad4(fr[i].id) !== s.viewerFranchiseId) continue;
      var players = U.asArray(fr[i].player);
      for (var j = 0; j < players.length; j++) {
        if (String(players[j].id) === String(pid)) return true;
      }
    }
    return false;
  }

  // Acquisition block for an UNROSTERED player — the sheet's answer to
  // "can I get this guy right now?". Resolved by M.waiverUI.cta
  // (views/players.js) off GET /api/waivers/state — the mode is the SERVER's
  // `window.mode`, never re-derived here (contract v2 §4):
  //   blind-bid window → a Bid button   ·   FCFS window → an Add button
  //   blackout / not-open / unknown → context text, NO button.
  // docs/ups_v2/.../add_action_rule.md is explicit that a disabled Add is
  // worse than no Add, so we never render one.
  //
  // Contract v2 §5: when the server reports write_enabled:false there is no
  // button at all — the sheet shows the context line plus a link to MFL's own
  // add/drop page. A CTA whose only possible outcome is a 503 is not a CTA.
  function renderAcquisitionBlock(pid) {
    var WUI = window.UPS_MOBILE.waiverUI;
    if (!WUI) return "";
    var cta = WUI.cta(pid, { longLabel: true });
    var info = WUI.modeInfo();
    var staged = WUI.stagedRoundsFor(pid);
    var parts = [];
    if (staged.length) {
      parts.push('<div class="ups-m-acq-note staged">Claimed in ' +
        (staged.length > 1 ? "groups " : "group ") + U.escapeHtml(staged.join(", ")) +
        ' · <button class="lnk" data-act="waiver-claims">Review claims</button></div>');
    }
    if (info.detail) {
      parts.push('<div class="ups-m-acq-note">' + U.escapeHtml(info.detail) + '</div>');
    }
    if (cta.html) {
      parts.push('<div class="ups-m-sheet-actions">' + cta.html + '</div>');
    } else if (cta.readOnly && info.nativeLink &&
               (info.mode === "bbid" || info.mode === "fcfs")) {
      parts.push('<div class="ups-m-sheet-actions">' +
        '<a class="ups-m-acq-native" href="' + U.escapeHtml(info.nativeLink) +
        '" target="_blank" rel="noopener">Add/drop on MFL</a></div>');
    }
    if (!parts.length) return "";
    return '<div class="ups-m-sheet-acq">' + parts.join("") + '</div>';
  }

  function renderActionsFooter(pid, rosterRow, ownsPlayer, opts) {
    opts = opts || {};
    if (!ownsPlayer) {
      // No rosterRow at all = free agent → offer the live acquisition path.
      // A rosterRow owned by someone ELSE = trade territory, which lives in
      // the Market row / Trades view, so that case still just gets Close.
      var acq = rosterRow ? "" : renderAcquisitionBlock(pid);
      return acq + '<button class="btn" id="ups-m-sheet-foot-close">Close</button>';
    }
    var s = window.UPS_MOBILE.state;
    var otbIds = DATA.getMyTradeBaitIds();
    var onBlock = otbIds.has(String(pid));
    var existingNote = DATA.getMyTradeBaitNoteFor(pid);
    // Penalty comes from the worker's /api/cap-penalty/preview batch (the same
    // _computeDropPenalty the cron uses to post the real charge). When that
    // hasn't landed, dropPenaltyFor falls back to local math — say "est." so
    // the number is never mistaken for the authoritative charge.
    var penalty = DATA.dropPenaltyFor(rosterRow, s.ctx.year);
    var penaltyLabel = "";
    if (penalty && typeof penalty.amount === "number") {
      var estTag = penalty.authoritative ? "" : "est. ";
      penaltyLabel = penalty.amount > 0
        ? ' <span class="pn">(' + estTag + U.fmtUsd(penalty.amount) + ' penalty)</span>'
        : ' <span class="pn ok">(no penalty)</span>';
    } else {
      penaltyLabel = ' <span class="pn">(penalty TBD)</span>';
    }
    // Eligibility from the verbatim Front Office mirror (same predicates the
    // desktop Roster Workbench uses). Tag check now consults the league
    // tag plan (site/ccc/tag_tracking.json) + per-team-side conflict scan
    // — matches Front Office exactly.
    var FOA = window.UPS_FRONT_OFFICE_ACTIONS;
    var viewerFid = window.UPS_MOBILE.state.viewerFranchiseId;
    // extensionAvailableFor combines the base eligibility check with the
    // RULE-EXT-003 block (SAME UPS franchise cannot extend twice). Catches
    // tagged players (status indexOf("tag") !== -1 → Trevor Lawrence) AND
    // already-extended-by-current-owner players (CJ Stroud on HammerTime
    // with "Ext: 🔨 ⏰" in contractInfo).
    var elig = FOA ? FOA.eligibilityForRosterRow(rosterRow, viewerFid) :
               { extensionEligible: false, rookieOptionEligible: false, restructureEligible: false };
    var extAvail = FOA && FOA.extensionAvailableFor
      ? FOA.extensionAvailableFor(rosterRow, viewerFid)
      : { ok: elig.extensionEligible, reason: "" };
    elig.extensionEligible = !!extAvail.ok;
    elig.extensionBlockedReason = extAvail.reason;
    var tagAction = { kind: "none" };
    if (FOA) {
      // Build a roster-row list with position attached (player.position
      // comes from state.players, not rosters export). That's what the
      // FO tag scan needs to match offense/defense slots.
      var s2 = window.UPS_MOBILE.state;
      var teamRows = window.UPS_MOBILE.data.getRosterFor(footerState.pid ? s2.viewerFranchiseId : s2.viewerFranchiseId);
      // Above line just gets the viewer franchise's roster — same fid
      // as the sheet (we only show contract actions on own roster players).
      var teamRowsWithPos = (teamRows || []).map(function (r) {
        var p = window.UPS_MOBILE.data.playerById(r.id);
        return { id: r.id, contractStatus: r.contractStatus, position: (p && p.position) || "" };
      });
      tagAction = FOA.tagActionForPlayer({
        rosterRow: rosterRow,
        fid: s2.viewerFranchiseId,
        rosterRowsWithPos: teamRowsWithPos,
        tagTracking: s2.tagTracking || [],
        tagSubmissions: s2.tagSubmissions || [],
        currentSeason: s2.ctx && s2.ctx.year
      });
    }
    var tagEligible = (tagAction.kind === "tag" || tagAction.kind === "untag");
    var html = '';
    if (opts.editingOtb) {
      var headerText = onBlock ? "Update Block note" : "Add to On the Block";
      var initialNote = (typeof opts.noteDraft === "string") ? opts.noteDraft : existingNote;
      html +=
        '<div class="ups-m-otb-edit">' +
          '<div class="ups-m-otb-edit-title">' + U.escapeHtml(headerText) + '</div>' +
          '<textarea id="ups-m-otb-note" class="ups-m-otb-note" rows="3" maxlength="240" ' +
            'placeholder="Optional note — what you want, condition, contender preference, etc.">' +
            U.escapeHtml(initialNote) +
          '</textarea>' +
          '<div class="ups-m-otb-edit-actions">' +
            (onBlock ? '<button class="btn-act drop" data-act="otb-remove">Remove from Block</button>' : '') +
            '<button class="btn-act" data-act="otb-cancel">Cancel</button>' +
            '<button class="btn-act otb on" data-act="otb-save">' + (onBlock ? "Update" : "Add to Block") + '</button>' +
          '</div>' +
        '</div>';
    } else {
      html += '<div class="ups-m-sheet-actions">' +
        '<button class="btn-act otb' + (onBlock ? ' on' : '') + '" data-act="otb">' +
          (onBlock ? '✓ On the Block' : 'Add to Block') +
        '</button>' +
        '<button class="btn-act drop" data-act="drop">Drop' + penaltyLabel + '</button>' +
      '</div>';

      // Promote / Demote from Taxi (canon §B2 + Q10/Q18). Surfaces only
      // when applicable: Promote for players currently on taxi; Demote
      // for non-taxi non-IR players on a Rookie contract who haven't
      // been permanently promoted yet. The worker enforces all real
      // rules (R1-rookie block per Q12, became_permanent=1 block per Q10
      // follow-up); this UI is the entry point for the action.
      var rrStatus = U.safeStr(rosterRow && rosterRow.status).toUpperCase();
      var rrIsTaxi = rrStatus.indexOf("TAXI") !== -1;
      // MFL's roster status vocabulary is ROSTER / TAXI_SQUAD / INJURED_RESERVE
      // (MFL_IMPORT_EXPORT_DETAILED.md ~677). This line used to read
      // `rrStatus.indexOf("IR") !== -1`, and "INJURED_RESERVE" does not contain
      // the substring "IR" — the I is followed by an N. So the check was always
      // false and "Activate from IR" has never once rendered on mobile; the
      // button existed but was unreachable. Match the canonical normalizer in
      // site/rosters/roster_workbench.js normalizeStatus() (~822), which accepts
      // both the long form and a bare "IR", and the IR view's own
      // /ir|injured|reserve/i filter — three surfaces, one meaning.
      var rrIsIr = rrStatus === "IR" || rrStatus.indexOf("INJURED") !== -1 || rrStatus.indexOf("RESERVE") !== -1;
      // Demote-eligibility — use the canonical isTaxiEligibleFor helper
      // (canon §A1 R2-5 + §B2 3yr window). Replaces the rough
      // /rookie/i contractStatus check which would show Demote for R1
      // rookies (worker would reject per Q12, but cleaner to hide it).
      var canDemote = !rrIsTaxi && !rrIsIr && (DATA.isTaxiEligibleFor ? DATA.isTaxiEligibleFor(pid, rosterRow && rosterRow.contractStatus) : false);
      if (rrIsTaxi) {
        html += '<div class="ups-m-sheet-actions">' +
          '<button class="btn-act ext" data-act="promote-taxi">Promote from Taxi</button>' +
        '</div>';
      } else if (canDemote) {
        html += '<div class="ups-m-sheet-actions">' +
          '<button class="btn-act rstr" data-act="demote-taxi">Demote to Taxi</button>' +
        '</div>';
      }

      // IR, both directions (canon §B3 — IR gives 50% cap relief + takes the
      // player off the active roster max). "Activate from IR" for players
      // currently on IR (worker activate_ir → MFL TYPE=ir ACTIVATE); "Place on
      // IR" for an active player holding an IR-eligible NFL designation
      // (worker deactivate_ir → MFL TYPE=ir DEACTIVATE). The option-DOWN half
      // was deferred for a while because MFL's `ir` import field for placing
      // wasn't confirmed; it is now (MFL_IMPORT_EXPORT_DETAILED.md ~623).
      //
      // Eligibility is DATA.irEligibilityFor — the one §B3 predicate — and its
      // `known` flag decides what this footer is allowed to claim:
      //   known && eligible  → offer it, plain confirm
      //   known && !eligible → no button; our gate agrees with the worker's
      //   !known             → offer it, but the confirm says outright that we
      //                        could NOT verify eligibility. That is not
      //                        fail-open: nothing is granted here, the request
      //                        goes to the worker, which does its own §B3 read
      //                        and refuses on its own unknown
      //                        (IR_ELIGIBILITY_UNKNOWN). Hiding the button
      //                        instead would silently strip a legitimate move
      //                        because OUR fetch failed — a different lie.
      // "Does IR even apply?" is a SEPARATE question from "is he eligible?",
      // and conflating them would mean inventing an eligibility answer for
      // players the question was never asked about. A taxi player is off the
      // active roster already, so IR buys him nothing; a player already on IR
      // takes the Activate branch instead. DATA.irEligibilityFor being absent
      // lands here too — that can only happen under version skew (a cached old
      // app.js against this file), and hiding the button beats offering a write
      // whose consequences this build cannot describe. irElig stays null in all
      // three cases rather than pretending to a `known: true` we never checked.
      var irApplies = !rrIsIr && !rrIsTaxi && !!DATA.irEligibilityFor;
      var irElig = irApplies ? DATA.irEligibilityFor(pid) : null;
      if (rrIsIr) {
        html += '<div class="ups-m-sheet-actions">' +
          '<button class="btn-act ext" data-act="activate-ir">Activate from IR</button>' +
        '</div>';
      } else if (irElig && (irElig.eligible || !irElig.known)) {
        html += '<div class="ups-m-sheet-actions">' +
          '<button class="btn-act rstr" data-act="deactivate-ir">Place on IR' +
            (irElig.designation ? ' · ' + U.escapeHtml(irElig.designation) : '') +
          '</button>' +
        '</div>';
        if (!irElig.known) {
          html += '<div class="ups-m-ir-note">MFL\'s injury report didn\'t load, so §B3 eligibility is <b>unverified</b> here. The server checks it before writing.</div>';
        }
      }

      // §C2 MYAC — when a fresh 1-yr auction default (Vet-ERA win or a
      // this-season FA-auction Veteran) can be set to a 2-/3-year contract at
      // the SAME salary (TCV = bid × years, NO escalator). Shown INSTEAD of
      // Extend pre-deadline — the FO eligibility mirror already suppresses
      // extensionEligible when myacEligible (desktop parity: nobody extends
      // when they can MYAC). Flat submits directly; Loaded opens a Y1 free-key
      // form. Mirrors v2/front_office.js renderActions MYAC block (2955).
      // A player on the pre-season ladder gets THEIR window's end date, which is
      // the same boundary the Contracts list and the Discord waiver post print
      // for them. Everyone else keeps the league-wide September deadline.
      // ladderWindowEnd is "" when the boundary could not be resolved — and in
      // that case eligibility has already withheld the action, so this only ever
      // decorates a window we actually established.
      var ladderOrDeadlineNote = function (label) {
        var iso = U.safeStr(elig.ladderWindowEnd);
        if (elig.ladderStage) {
          return iso ? ' ' + label + ' ' + U.escapeHtml(prettyIsoDay(iso)) + '.' : '';
        }
        return s.contractDeadline ? ' ' + label + ' ' + U.escapeHtml(s.contractDeadline) + '.' : '';
      };
      if (elig.myacEligible) {
        var dlNote = ladderOrDeadlineNote('Window closes');
        html += '<div class="ups-m-myac-head">Multi-Year Contract (MYAC) · §C2' +
          '<span class="ups-m-myac-sub">Set this 1-yr deal to 2 or 3 years at the same salary — no raise. ' +
          '<strong>Loaded</strong> free-keys Y1 (FL/BL).' + dlNote + '</span></div>';
        html += '<div class="ups-m-sheet-actions">' +
          '<button class="btn-act myac" data-act="contract" data-contract-action="myac" data-myac-total="2">2-Year</button>' +
          '<button class="btn-act myac" data-act="contract" data-contract-action="myac-loaded" data-myac-total="2">2-Yr Loaded…</button>' +
        '</div>' +
        '<div class="ups-m-sheet-actions">' +
          '<button class="btn-act myac" data-act="contract" data-contract-action="myac" data-myac-total="3">3-Year</button>' +
          '<button class="btn-act myac" data-act="contract" data-contract-action="myac-loaded" data-myac-total="3">3-Yr Loaded…</button>' +
        '</div>';
      }

      // §C3 MYM — an IN-SEASON WW/FCFS/waiver pickup can lock into a FLAT 2- or
      // 3-year deal at the same base salary within 14 days of acquisition (no
      // raise, cannot be loaded; max 4/team/season). Math + payload live in
      // front_office_mym_submit.js (UPS_M_FO_MYM); worker route /offer-mym.
      // MYM reaches this sheet by TWO different rules and they are not
      // interchangeable, so the copy must not be either:
      //   • rung 2 of the pre-season ladder — a window that runs to NFL Week 3's
      //     kickoff, with nothing to do with when the player was picked up;
      //   • the §C3 IN-SEASON clock — days 1-14 from the acquisition date.
      // The sheet used to print the day-based wording for both, because
      // eligibility handed it a day-count either way. It now takes the branch
      // from ladderStage — the SAME field the eligibility gate itself used —
      // and mymDaysSinceAcq is null for ladder players, so the two cannot part
      // company.
      if (elig.mymEligible) {
        var mymBlurb, mymNote;
        if (elig.ladderStage === "mym") {
          mymBlurb = 'Lock this pre-season pickup into a flat 2- or 3-year deal at the same salary — no raise, can\'t be loaded. Max 4 per team a season.';
          mymNote = ladderOrDeadlineNote('Window closes at NFL Week 3 kickoff,');
        } else {
          mymBlurb = 'Lock this in-season pickup into a flat 2- or 3-year deal at the same salary — no raise, can\'t be loaded. Max 4 per team a season.';
          mymNote = (elig.mymDaysSinceAcq != null) ? ' Day ' + elig.mymDaysSinceAcq + ' of 14.' : '';
        }
        html += '<div class="ups-m-myac-head">Mid-Year Multi (MYM) · §C3' +
          '<span class="ups-m-myac-sub">' + mymBlurb + mymNote + '</span></div>';
        html += '<div class="ups-m-sheet-actions">' +
          '<button class="btn-act mym" data-act="contract" data-contract-action="mym" data-mym-total="2">2-Year</button>' +
          '<button class="btn-act mym" data-act="contract" data-contract-action="mym" data-mym-total="3">3-Year</button>' +
        '</div>';
      }

      // Contract-action grid: Extension / Restructure / Tag — eligibility comes
      // from the FO mirror. Each button runs the action in-app via the verbatim
      // Front Office submit mirrors (no deep-links).
      var tagLabel = tagAction.kind === "untag" ? "Untag" : "Tag";
      var tagAct = tagAction.kind === "untag" ? "untag" : "tag";
      // Rookie Option intentionally not exposed on mobile yet (Keith
      // 2026-05-15 — skip for now). When ready, mirror submitRookieOptionUpdate
      // from roster_workbench.js:10912 the same way Tag/Extend were ported.
      var contractActions = [
        { key: "extension", label: "Extend", eligible: elig.extensionEligible, css: "ext" },
        { key: "restructure", label: "Restructure", eligible: elig.restructureEligible, css: "rstr" },
        { key: tagAct, label: tagLabel, eligible: tagEligible, css: "tag" }
      ];
      var anyEligible = contractActions.some(function (a) { return a.eligible; });
      if (anyEligible) {
        html += '<div class="ups-m-sheet-actions">';
        contractActions.forEach(function (a) {
          if (!a.eligible) return;
          html += '<button class="btn-act ' + a.css + '" data-act="contract" data-contract-action="' +
            U.escapeHtml(a.key) + '">' + U.escapeHtml(a.label) + '</button>';
        });
        html += '</div>';
      }

      // Partial-untag recovery: a player who was TAGGED this season but
      // whose contractStatus is no longer "TAG" got partway through an
      // untag — the contract revert succeeded but the unload step didn't
      // fire. The data state is "still on roster with prior contract."
      // Expose a one-tap cleanup that just calls unload_player (no
      // additional contract update, no cap penalty). This is the Malik
      // Willis case from 2026-05-16.
      var subs = (window.UPS_MOBILE.state.tagSubmissions) || [];
      var curYear = window.UPS_MOBILE.state.ctx && window.UPS_MOBILE.state.ctx.year;
      var pidDigits = String(rosterRow.id || "").replace(/\D/g, "");
      var hadTagThisSeason = false;
      for (var ti = 0; ti < subs.length; ti++) {
        var sub = subs[ti] || {};
        if (String(sub.player_id || "").replace(/\D/g, "") !== pidDigits) continue;
        if (curYear && String(sub.season || sub.year || "") && String(sub.season || sub.year) !== String(curYear)) continue;
        var k = String(sub.submission_kind || sub.kind || "tag").toLowerCase();
        if (k === "tag") { hadTagThisSeason = true; break; }
      }
      var currentlyTagged = U.safeStr(rosterRow.contractStatus).toUpperCase() === "TAG";
      if (hadTagThisSeason && !currentlyTagged) {
        html += '<div class="ups-m-sheet-actions">' +
          '<button class="btn-act drop" data-act="unload-cleanup" ' +
            'title="Was tagged this season but unload step didn\'t complete. Tap to remove from active roster (no penalty).">' +
            '⚠ Complete untag (cleanup)' +
          '</button>' +
        '</div>';
      }

      if (onBlock && existingNote) {
        html += '<div class="ups-m-otb-note-display"><span class="lbl">Note:</span> ' + U.escapeHtml(existingNote) + '</div>';
      }
    }
    html += '<button class="btn" id="ups-m-sheet-foot-close">Close</button>';
    return html;
  }

  // Cached per-sheet state. Cleared each time `open` is called.
  var footerState = { pid: null, name: "", rosterRow: null, editingOtb: false };

  function rerenderFooter() {
    var foot = document.getElementById("ups-m-sheet-foot");
    if (!foot || !footerState.pid) return;
    var ownsPlayer = isOwnRoster(footerState.pid);
    foot.innerHTML = renderActionsFooter(footerState.pid, footerState.rosterRow, ownsPlayer, {
      editingOtb: footerState.editingOtb
    });
    wireFooterActions();
  }

  // ERA forced retention (league_context_v1.md §A3): a player won in the
  // CURRENT cycle's Expired Rookie Auction cannot be cut until the FA Auction
  // CLOSES ("you bid, you hold through auction"). The worker is the authority
  // — it blocks the real drop — so we hide the Drop button up front and the
  // owner never taps into that error. The check is a DRY-RUN drop: the
  // worker's ERA gate runs before the dry-run short-circuit, so it returns the
  // block precisely (current-cycle winners only, auto-lifts when the auction
  // closes) without touching MFL. Fired only for "-era" contracts; fail-open
  // (leave Drop) on any error since the worker still enforces it.
  function gateEraRetentionDrop(foot, dropBtn) {
    if (!dropBtn || !foot) return;
    var status = U.safeStr(footerState.rosterRow && footerState.rosterRow.contractStatus).toLowerCase();
    if (status.indexOf("-era") === -1) return;
    var s = window.UPS_MOBILE.state;
    var pidAtFire = U.safeStr(footerState.pid);
    fetch(window.UPS_MOBILE.api.workerBase() + "/roster-workbench/action", {
      method: "POST", mode: "cors", credentials: "omit",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "drop_player", dry_run: 1,
        league_id: s.ctx.leagueId, season: s.ctx.year,
        franchise_id: U.pad4(s.viewerFranchiseId),
        player_id: pidAtFire
      })
    }).then(function (r) { return r.json(); }).then(function (b) {
      var blocked = b && (b.code === "ERA_FORCED_RETENTION" || (b.gate && b.gate.blocked === true));
      if (!blocked) return;
      if (U.safeStr(footerState.pid) !== pidAtFire) return;   // sheet moved on
      var live = foot.querySelector('[data-act="drop"]');
      if (live && live.parentNode) live.parentNode.removeChild(live);
      if (!foot.querySelector(".ups-m-era-lock")) {
        var actions = foot.querySelector(".ups-m-sheet-actions");
        var note = document.createElement("div");
        note.className = "ups-m-era-lock";
        note.textContent = "🔒 Won in the " + s.ctx.year + " Expired Rookie Auction — can’t be cut until the FA Auction closes (forced retention, §A3).";
        if (actions && actions.parentNode) actions.parentNode.insertBefore(note, actions.nextSibling);
        else foot.appendChild(note);
      }
    }).catch(function () { /* fail-open — worker still enforces the block */ });
  }

  function wireFooterActions() {
    var foot = document.getElementById("ups-m-sheet-foot");
    if (!foot) return;
    var close = document.getElementById("ups-m-sheet-foot-close");
    if (close) close.addEventListener("click", window.UPS_MOBILE.sheet.close);
    var otb = foot.querySelector('[data-act="otb"]');
    var drop = foot.querySelector('[data-act="drop"]');
    var save = foot.querySelector('[data-act="otb-save"]');
    var cancel = foot.querySelector('[data-act="otb-cancel"]');
    var remove = foot.querySelector('[data-act="otb-remove"]');
    if (otb) otb.addEventListener("click", function () {
      footerState.editingOtb = true;
      rerenderFooter();
      var ta = document.getElementById("ups-m-otb-note");
      if (ta) { ta.focus(); }
    });
    if (cancel) cancel.addEventListener("click", function () {
      footerState.editingOtb = false;
      rerenderFooter();
    });
    if (save) save.addEventListener("click", function () { handleOTBSave(save); });
    if (remove) remove.addEventListener("click", function () { handleOTBRemove(remove); });
    if (drop) drop.addEventListener("click", function () { handleDrop(footerState.pid, footerState.name, footerState.rosterRow, drop); });
    gateEraRetentionDrop(foot, drop);
    // Waiver acquisition (unrostered players). The flows live in
    // views/players.js (M.waiverUI) so the Market tab and this sheet can
    // never disagree about what window we're in. Close the sheet first —
    // the bid/drop/claims overlays stack above it and it would just be a
    // dead layer underneath.
    var waiverBtns = foot.querySelectorAll('[data-act="waiver-bid"],[data-act="waiver-add"],[data-act="waiver-claims"]');
    for (var wi = 0; wi < waiverBtns.length; wi++) {
      waiverBtns[wi].addEventListener("click", function () {
        var WUI = window.UPS_MOBILE.waiverUI;
        if (!WUI) return;
        var act = this.getAttribute("data-act");
        var wpid = this.getAttribute("data-pid") || footerState.pid;
        window.UPS_MOBILE.sheet.close();
        if (act === "waiver-bid") WUI.openBid(wpid);
        else if (act === "waiver-add") WUI.startFcfs(wpid);
        else WUI.openClaims();
      });
    }
    var unloadCleanup = foot.querySelector('[data-act="unload-cleanup"]');
    if (unloadCleanup) unloadCleanup.addEventListener("click", function () {
      handleUnloadCleanup(unloadCleanup);
    });
    var promoteTaxi = foot.querySelector('[data-act="promote-taxi"]');
    if (promoteTaxi) promoteTaxi.addEventListener("click", function () {
      handleTaxiRosterMove("promote_taxi", promoteTaxi);
    });
    var demoteTaxi = foot.querySelector('[data-act="demote-taxi"]');
    if (demoteTaxi) demoteTaxi.addEventListener("click", function () {
      handleTaxiRosterMove("demote_taxi", demoteTaxi);
    });
    var activateIr = foot.querySelector('[data-act="activate-ir"]');
    if (activateIr) activateIr.addEventListener("click", function () {
      handleIrMove("activate_ir", activateIr);
    });
    var deactivateIr = foot.querySelector('[data-act="deactivate-ir"]');
    if (deactivateIr) deactivateIr.addEventListener("click", function () {
      handleIrMove("deactivate_ir", deactivateIr);
    });
    var contractButtons = foot.querySelectorAll('[data-act="contract"]');
    for (var ci = 0; ci < contractButtons.length; ci++) {
      contractButtons[ci].addEventListener("click", function () {
        handleContractAction(this.getAttribute("data-contract-action"), this);
      });
    }
  }

  // Taxi promote / demote — mobile mirror of desktop Roster Workbench's
  // taxi roster moves. Posts to /roster-workbench/action with action=
  // "promote_taxi" or "demote_taxi". Worker enforces all the real rules
  // (R1-rookie block per Q12, became_permanent block per Q10 follow-up,
  // verification-honored failure per Q19). UI shows the worker's error
  // message directly so off-season blocks + permanent-promotion blocks
  // are visible to the owner.
  function handleTaxiRosterMove(action, btn) {
    var s = window.UPS_MOBILE.state;
    var name = footerState.name || "this player";
    var verb = action === "promote_taxi" ? "promote from taxi" : "demote to taxi";
    var verbCap = action === "promote_taxi" ? "Promote" : "Demote";
    // Canon §B2 context so owners see the rule before clicking.
    var pid = footerState.pid;
    var callup = (DATA.taxiCallupsFor && DATA.taxiCallupsFor(pid)) || null;
    var used = callup ? U.safeInt(callup.used, 0) : 0;
    var pending = callup ? U.safeInt(callup.pending, 0) : 0;
    var max = callup ? (U.safeInt(callup.max, 3) || 3) : 3;
    var totalSpent = used + pending;
    var ctx = "";
    if (action === "promote_taxi") {
      var aboutToBeNth = totalSpent + 1;
      var usedLine =
        "\n\nCall-ups used: " + used + " of " + max +
        (pending > 0 ? " (+" + pending + " pending)" : "") + ".";
      if (aboutToBeNth >= max + 1) {
        ctx =
          usedLine +
          "\n⚠ This will be call-up #" + aboutToBeNth + " of a " + max + "-call-up budget." +
          "\nCanon §B2: 4th call-up = PERMANENT PROMOTION." +
          "\nPlayer will no longer be cap-free cut after this NFL week locks.";
      } else {
        ctx =
          usedLine +
          "\nEach NFL week the player is active on your roster burns 1 call-up." +
          "\nDemoting before the next NFL week locks DOES NOT count.";
      }
    } else {
      ctx =
        "\n\nDemoting before the next NFL week locks does NOT burn a call-up. " +
        "Pending call-ups awaiting confirmation will be cleared on the next weeklyresults sweep.";
    }
    if (!window.confirm(verbCap + " " + name + "?" + ctx)) return;
    setBusy(btn, true, verbCap + "ing…");
    // Forward viewer's MFL_USER_ID via query param — required for
    // owner-restricted writes (taxi_squad). Without this the worker
    // can only use env.MFL_COOKIE (commish) which silently no-ops.
    var url = window.UPS_MOBILE.api.workerBase() + "/roster-workbench/action";
    var getStored = window.UPS_MOBILE.api.getStoredMflUserId;
    var stored = getStored ? getStored() : "";
    if (stored) url += "?MFL_USER_ID=" + encodeURIComponent(stored);
    fetch(url, {
      method: "POST",
      credentials: "omit",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: action,
        league_id: s.ctx.leagueId,
        season: s.ctx.year,
        franchise_id: U.pad4(s.viewerFranchiseId),
        player_id: U.safeStr(footerState.pid)
      })
    }).then(function (r) {
      return r.json().then(function (b) { return { ok: r.ok, status: r.status, body: b }; });
    }).then(function (resp) {
      setBusy(btn, false);
      if (resp.ok && resp.body && resp.body.ok) {
        var msg = U.safeStr(resp.body.message) || (verbCap + " complete");
        window.UPS_MOBILE.ui.showToast(msg, "ok");
        return window.UPS_MOBILE.actions.reloadData().then(function () {
          window.UPS_MOBILE.route.renderRoute();
          close();
        });
      }
      // Q19: worker returns 502 + verification.ok=false when MFL didn't
      // actually apply the action (off-season gate, permanent-promotion
      // block, etc.). Surface the error message directly.
      var err = (resp.body && (resp.body.error || resp.body.message)) || ("HTTP " + resp.status);
      window.UPS_MOBILE.ui.showToast(verbCap + " failed: " + err, "err");
    }).catch(function (err) {
      setBusy(btn, false);
      window.UPS_MOBILE.ui.showToast(verbCap + " failed: " + (err && err.message || err), "err");
    });
  }

  // IR, BOTH directions — mobile mirror of desktop's activate-ir / place-on-IR.
  // Posts /roster-workbench/action with action="activate_ir" (worker → MFL
  // TYPE=ir ACTIVATE) or "deactivate_ir" (→ TYPE=ir DEACTIVATE). Same
  // MFL_USER_ID forwarding as the taxi moves — see the note on that call.
  //
  // Canon §B3 / T2.1. Placing on IR is a CAP action, not a cosmetic one: the
  // player's hit drops to 50% (MFL includeIRWithSalary=50) and he stops
  // counting against the active-roster max. So the confirm below states both
  // consequences and the fact that it is reversible, rather than asking "are
  // you sure?" about a number the owner can't see.
  //
  // Eligibility is enforced SERVER-SIDE (the worker re-reads MFL's injury
  // report and refuses on its own unknown). This function's job on failure is
  // simply to repeat what the server said — see the typed-error handling below.
  function handleIrMove(action, btn) {
    var s = window.UPS_MOBILE.state;
    var name = footerState.name || "this player";
    var placing = action === "deactivate_ir";
    var verbCap = placing ? "Place on IR" : "Activate";
    var confirmMsg;
    if (placing) {
      // Designation is context, not permission — if our injuries read failed
      // irElig.known is false and renderActionsFooter has already said so on
      // screen. Repeat it here, because the confirm is the last thing between
      // the owner and a write, and "we couldn't verify" belongs at that moment.
      var elig = DATA.irEligibilityFor ? DATA.irEligibilityFor(footerState.pid) : { known: false, eligible: false, designation: "" };
      confirmMsg = "Place " + name + " on Injured Reserve?" +
        (elig.known && elig.designation ? "\n\nNFL designation: " + elig.designation : "") +
        "\n\nCanon §B3:" +
        "\n• Cap hit drops to 50% while he's on IR." +
        "\n• He stops counting against your active-roster max." +
        "\n• Reversible — activate him again any time (15 IR slots)." +
        (elig.known ? "" : "\n\n⚠ MFL's injury report didn't load, so eligibility could NOT be checked here. The server checks it before writing and will refuse if he doesn't qualify.");
    } else {
      confirmMsg = "Activate " + name + " from IR?\n\nThis returns them to your active roster — full cap hit and they count against the active-roster max again.";
    }
    if (!window.confirm(confirmMsg)) return;
    setBusy(btn, true, placing ? "Placing…" : "Activating…");
    var url = window.UPS_MOBILE.api.workerBase() + "/roster-workbench/action";
    var getStored = window.UPS_MOBILE.api.getStoredMflUserId;
    var stored = getStored ? getStored() : "";
    if (stored) url += "?MFL_USER_ID=" + encodeURIComponent(stored);
    fetch(url, {
      method: "POST",
      credentials: "omit",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: action,
        league_id: s.ctx.leagueId,
        season: s.ctx.year,
        franchise_id: U.pad4(s.viewerFranchiseId),
        player_id: U.safeStr(footerState.pid)
      })
    }).then(function (r) {
      return r.json().then(function (b) { return { ok: r.ok, status: r.status, body: b }; });
    }).then(function (resp) {
      setBusy(btn, false);
      if (resp.ok && resp.body && resp.body.ok) {
        window.UPS_MOBILE.ui.showToast(
          U.safeStr(resp.body.message) || (placing ? "Placed on IR" : "Activated from IR"), "ok");
        return window.UPS_MOBILE.actions.reloadData().then(function () {
          window.UPS_MOBILE.route.renderRoute();
          close();
        });
      }
      // The §B3 refusals carry a written-out reason naming the actual NFL
      // designation (400 IR_NOT_ELIGIBLE) or saying the injury report couldn't
      // be read at all (502 IR_ELIGIBILITY_UNKNOWN). Both are surfaced VERBATIM
      // — flattening them into "Place on IR failed" would throw away the only
      // information that tells the owner whether to pick a different player or
      // to just try again in a minute. A toast is short-lived, so these two get
      // an alert as well; they are the difference between "you can't" and "we
      // don't know yet".
      var code = U.safeStr(resp.body && resp.body.code);
      var err = (resp.body && (resp.body.error || resp.body.message)) || ("HTTP " + resp.status);
      window.UPS_MOBILE.ui.showToast(verbCap + " failed: " + err, "err");
      if (code === "IR_NOT_ELIGIBLE" || code === "IR_ELIGIBILITY_UNKNOWN") {
        window.alert(
          (code === "IR_NOT_ELIGIBLE" ? "Not IR-eligible (canon §B3)" : "IR eligibility couldn't be verified") +
          "\n\n" + err + "\n\nNothing was written to MFL.");
      }
    }).catch(function (err) {
      setBusy(btn, false);
      window.UPS_MOBILE.ui.showToast(verbCap + " failed: " + (err && err.message || err), "err");
    });
  }

  // Recovery for the partial-untag case. Calls /roster-workbench/action
  // with unload_player only — no contract update (the contract was
  // already reverted by the original untag) and no cap penalty (this is
  // cleanup of a previously incomplete action).
  function handleUnloadCleanup(btn) {
    var s = window.UPS_MOBILE.state;
    var name = footerState.name || "this player";
    if (!window.confirm("Complete the untag for " + name + "?\n\n" +
      "This removes them from your active roster. No cap penalty — the contract was already reverted by the earlier untag.")) return;
    setBusy(btn, true, "Unloading…");
    var url = window.UPS_MOBILE.api.workerBase() + "/roster-workbench/action";
    var getStored = window.UPS_MOBILE.api.getStoredMflUserId;
    var stored = getStored ? getStored() : "";
    if (stored) url += "?MFL_USER_ID=" + encodeURIComponent(stored);
    fetch(url, {
      method: "POST",
      credentials: "omit",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "unload_player",
        league_id: s.ctx.leagueId,
        season: s.ctx.year,
        franchise_id: U.pad4(s.viewerFranchiseId),
        player_id: U.safeStr(footerState.pid)
      })
    }).then(function (r) {
      return r.json().then(function (b) { return { ok: r.ok, status: r.status, body: b }; });
    }).then(function (resp) {
      setBusy(btn, false);
      if (resp.ok) {
        window.UPS_MOBILE.ui.showToast(name + " removed ✓", "ok");
        return window.UPS_MOBILE.actions.reloadData().then(function () {
          window.UPS_MOBILE.route.renderRoute();
          close();
        });
      }
      var err = (resp.body && (resp.body.error || resp.body.message)) || ("HTTP " + resp.status);
      window.UPS_MOBILE.ui.showToast("Cleanup failed: " + err, "err");
    }).catch(function (err) {
      setBusy(btn, false);
      window.UPS_MOBILE.ui.showToast("Cleanup failed: " + (err && err.message || err), "err");
    });
  }

  // All contract actions run in-app via the verbatim Front Office mirrors
  // (site/rosters/v2/front_office.js — the source of truth). The old MFL
  // Contract Command Center deep-link (MODULE=MESSAGE2) is retired
  // (Keith 2026-05-15 — see memory feedback_roster_workbench_is_truth_not_ccc).
  // No deep-link fallback.
  function handleContractAction(action, btn) {
    if (action === "tag") return handleTagSubmit();
    if (action === "untag") return handleUntagSubmit();
    if (action === "extension") return handleExtensionPick();
    if (action === "restructure") return handleRestructurePick();
    if (action === "myac") return handleMyacPick(btn);
    if (action === "myac-loaded") return handleMyacLoadedPick(btn);
    if (action === "mym") return handleMymPick(btn);
    window.UPS_MOBILE.ui.showToast("Action not yet available on mobile.", "err");
  }

  // §C3 MYM — flat 2-/3-year deal at the current base salary. Math + payload in
  // front_office_mym_submit.js (UPS_M_FO_MYM); mirrors handleMyacPick.
  function handleMymPick(btn) {
    var MM = window.UPS_M_FO_MYM;
    if (!MM) return;
    var totalYears = U.safeInt(btn && btn.getAttribute("data-mym-total"), 2) || 2;
    var rosterRow = footerState.rosterRow;
    var player = window.UPS_MOBILE.data.playerById(footerState.pid);
    var perYear = U.safeInt(rosterRow && rosterRow.salary, 0);
    var err = MM.validateMym(perYear, totalYears);
    if (err) { window.UPS_MOBILE.ui.showToast(err, "err"); return; }
    var acqLabel = U.safeStr(player && player.acquisitionTypeLabel);
    var subType = MM.mymSubType(rosterRow && rosterRow.contractStatus, acqLabel);
    var contract = MM.buildMymContract(perYear, totalYears, subType);
    confirmAndSubmitMym(contract, player, acqLabel);
  }

  function confirmAndSubmitMym(contract, player, acqLabel) {
    var lines = ["Submit " + contract.totalYears + "-year MYM for " + footerState.name + "?", "",
      "Sub-type: " + contract.subType,
      "Per year: " + U.fmtUsd(contract.perYear) + " (flat — cannot be loaded)",
      "TCV: " + U.fmtUsd(contract.tcv) + " · GTD: " + U.fmtUsd(contract.gtd)];
    var msg = lines.join("\n") + "\n\nThis writes to MFL and cannot be undone from the app.";
    if (!window.confirm(msg)) return;
    window.UPS_MOBILE.ui.showToast("Submitting MYM…", "ok");
    var MM = window.UPS_M_FO_MYM;
    var s = window.UPS_MOBILE.state;
    return MM.submitMym({
      workerBase: window.UPS_MOBILE.api.workerBase(),
      leagueId: s.ctx.leagueId,
      year: s.ctx.year,
      pid: footerState.pid,
      playerName: U.safeStr(player && player.name) || footerState.name,
      fid: s.viewerFranchiseId,
      franchiseName: (s.viewerFranchise && s.viewerFranchise.name) || "",
      position: U.safeStr(player && player.position),
      contract: contract,
      rosterRow: footerState.rosterRow,
      acquisitionDate: U.safeStr(player && player.acquisitionDate),
      acquisitionType: U.safeStr(acqLabel),
      dryRun: false,
      commishOverride: window.UPS_MOBILE.isCommishOverride()
    }).then(function (resp) {
      if (resp.ok) {
        window.UPS_MOBILE.ui.showToast(contract.totalYears + "-yr MYM submitted ✓ (" + contract.subType + ")", "ok");
        return window.UPS_MOBILE.actions.reloadData().then(function () {
          window.UPS_MOBILE.route.renderRoute();
          close();
        });
      }
      window.UPS_MOBILE.ui.showToast("MYM failed: " + (resp.error || "unknown"), "err");
    }).catch(function (e) {
      window.UPS_MOBILE.ui.showToast("MYM failed: " + (e && e.message ? e.message : e), "err");
    });
  }

  // In-app Extend — fetch precomputed options, show picker, submit.
  function handleExtensionPick() {
    var FOX = window.UPS_FRONT_OFFICE_EXT;
    if (!FOX) return;
    var s = window.UPS_MOBILE.state;
    var rosterRow = footerState.rosterRow;
    var pid = footerState.pid;

    showExtensionLoadingSheet();
    FOX.loadOptionsForPlayer({
      year: s.ctx.year,
      pid: pid,
      fid: s.viewerFranchiseId,
      rosterRow: rosterRow
    }).then(function (options) {
      renderExtensionOptionsSheet(options);
    }).catch(function (err) {
      showExtensionErrorSheet("Failed to load options: " + (err && err.message || err));
    });
  }

  function ensureExtMount() {
    var existing = document.getElementById("ups-m-ext-overlay");
    if (existing) existing.remove();
    var html =
      '<div class="ups-m-drop-overlay" id="ups-m-ext-overlay">' +
        '<div class="ups-m-drop-sheet">' +
          '<div class="ups-m-drop-head">' +
            '<button class="ups-m-drop-close" id="ups-m-ext-close" aria-label="Close">×</button>' +
            '<div class="grip"></div>' +
            '<div class="title">Extend ' + U.escapeHtml(footerState.name) + '</div>' +
            '<div class="sub" id="ups-m-ext-sub">Loading available options…</div>' +
          '</div>' +
          '<div class="ups-m-drop-body" id="ups-m-ext-body"></div>' +
        '</div>' +
      '</div>';
    var mount = document.getElementById("ups-m-app");
    if (!mount) return null;
    mount.insertAdjacentHTML("beforeend", html);
    document.body.style.overflow = "hidden";
    var overlay = document.getElementById("ups-m-ext-overlay");
    overlay.addEventListener("click", function (e) { if (e.target === overlay) closeExtSheet(); });
    document.getElementById("ups-m-ext-close").addEventListener("click", closeExtSheet);
    return overlay;
  }
  function closeExtSheet() {
    var ov = document.getElementById("ups-m-ext-overlay");
    if (ov) ov.remove();
    document.body.style.overflow = "";
  }
  function showExtensionLoadingSheet() {
    ensureExtMount();
    var body = document.getElementById("ups-m-ext-body");
    if (body) body.innerHTML = '<div class="ups-m-sheet-loading">Loading…</div>';
  }
  function showExtensionErrorSheet(msg) {
    ensureExtMount();
    var body = document.getElementById("ups-m-ext-body");
    if (body) body.innerHTML = '<div class="ups-m-sheet-empty">' + U.escapeHtml(msg) + '</div>';
  }
  function renderExtensionOptionsSheet(options) {
    ensureExtMount();
    var sub = document.getElementById("ups-m-ext-sub");
    var body = document.getElementById("ups-m-ext-body");
    if (!body) return;
    if (!options || !options.length) {
      if (sub) sub.textContent = "No extension previews available for this player.";
      body.innerHTML = '<div class="ups-m-sheet-empty">No extension options available for this player.</div>';
      return;
    }
    if (sub) sub.textContent = "Pick the option to submit. Writes to MFL on confirm.";
    var FOX = window.UPS_FRONT_OFFICE_EXT;
    var html = options.map(function (opt) {
      // Right-column Y1/TCV is intentionally omitted — the summary line
      // ("Future AAV / TCV") + the contract_info breakdown below already
      // carry the same numbers. Keith 2026-05-15: don't repeat ourselves.
      return '<button class="ups-m-drop-row" data-option-key="' + U.escapeHtml(opt.optionKey) + '">' +
        '<div class="body">' +
          '<div class="name">' + U.escapeHtml(FOX.extensionActionLabel(opt)) + '</div>' +
          '<div class="sub">' + U.escapeHtml(FOX.extensionOptionSummary(opt)) + '</div>' +
          '<div class="sub" style="margin-top:4px;font-family:monospace;font-size:10px;opacity:0.7">' +
            U.escapeHtml((opt.contractInfo || "").slice(0, 120)) + '</div>' +
        '</div>' +
      '</button>';
    }).join("");
    body.innerHTML = html;
    var rows = body.querySelectorAll(".ups-m-drop-row");
    for (var i = 0; i < rows.length; i++) {
      rows[i].addEventListener("click", function () {
        var key = this.getAttribute("data-option-key");
        var picked = options.filter(function (o) { return o.optionKey === key; })[0];
        if (picked) confirmAndSubmitExtension(picked);
      });
    }
    // +2Y Loaded (FL/BL) — desktop parity. Surfaces when a flat 2-year option
    // exists (its futureAav drives the loaded math). Consumes a §C2 loaded slot.
    var twoYr = options.filter(function (o) { return U.safeInt(o.yearsToAdd, 0) === 2; })[0];
    if (twoYr && U.safeInt(twoYr.futureAav, 0) >= 1000 && window.UPS_FRONT_OFFICE_EXT.buildLoadedExtensionOption) {
      body.insertAdjacentHTML("beforeend",
        '<button class="ups-m-drop-row" id="ups-m-ext-loaded-btn" style="border-top:1px dashed var(--line);margin-top:6px">' +
          '<div class="body"><div class="name" style="color:var(--accent)">Extend +2Y — Loaded (FL/BL)…</div>' +
          '<div class="sub">Y1 stays at the current salary; set Y2 and Y3 auto-fills. Front- or back-load the two new years.</div></div>' +
        '</button>');
      var lb = document.getElementById("ups-m-ext-loaded-btn");
      if (lb) lb.addEventListener("click", function () { handleExtensionLoadedPick(twoYr); });
    }
  }

  // ── 2-year Loaded extension form (mirrors the MYAC-loaded sheet) ──────────
  var extLoadedState = { constraints: null, y2: 0 };
  function handleExtensionLoadedPick(twoYrOption) {
    var FOX = window.UPS_FRONT_OFFICE_EXT;
    var MY = window.UPS_M_FO_MYAC;
    if (!FOX) return;
    var futureAav = U.safeInt(twoYrOption && twoYrOption.futureAav, 0);
    if (futureAav < 1000) { window.UPS_MOBILE.ui.showToast("No 2-year preview available for a loaded extension.", "err"); return; }
    // §C2 5-loaded cap — a loaded extension also consumes a loaded slot.
    if (MY) {
      var myRoster = window.UPS_MOBILE.data.getRosterFor(window.UPS_MOBILE.state.viewerFranchiseId) || [];
      if (MY.loadedContractCount(myRoster) >= MY.LOADED_MAX) {
        window.UPS_MOBILE.ui.showToast("At the " + MY.LOADED_MAX + "-loaded cap — trade or cut a loaded player first.", "err");
        return;
      }
    }
    var constraints = FOX.loadedExtensionConstraints(footerState.rosterRow, futureAav);
    extLoadedState = { constraints: constraints, y2: constraints.futureAav };
    renderExtensionLoadedSheet();
  }
  function renderExtensionLoadedSheet() {
    ensureExtMount();
    var sub = document.getElementById("ups-m-ext-sub");
    if (sub) sub.textContent = "+2Y Loaded — Y1 locked, set Y2, Y3 auto-fills.";
    var body = document.getElementById("ups-m-ext-body");
    if (!body) return;
    var c = extLoadedState.constraints;
    body.innerHTML = '' +
      '<div class="ups-m-rstr-summary">' +
        '<div class="row"><span class="lbl">Y1 (locked):</span> <span class="val">' + U.fmtUsd(c.currentSalary) + '</span></div>' +
        '<div class="row"><span class="lbl">Y2 + Y3 total:</span> <span class="val">' + U.fmtUsd(c.extensionTotal) + '</span> <span class="lbl">(' + U.fmtUsd(c.futureAav) + ' AAV × 2)</span></div>' +
        '<div class="row"><span class="lbl">Each year ≥</span> <span class="val">' + U.fmtUsd(c.minExtYear) + ' (20%)</span></div>' +
      '</div>' +
      '<div class="ups-m-rstr-field">' +
        '<label>Year 2 salary (min ' + U.fmtUsd(c.minExtYear) + ', 1K increments)</label>' +
        '<input type="number" step="1000" min="' + c.minExtYear + '" value="' + extLoadedState.y2 + '" id="ups-m-extl-y2" inputmode="numeric" />' +
      '</div>' +
      '<div class="ups-m-rstr-derived">' +
        '<div class="row"><span class="lbl">Year 3 (auto):</span> <span class="val" id="ups-m-extl-y3">—</span></div>' +
        '<div class="row"><span class="lbl">Status:</span> <span class="val" id="ups-m-extl-status">—</span></div>' +
        '<div class="row"><span class="lbl">TCV · GTD:</span> <span class="val" id="ups-m-extl-tcv">—</span></div>' +
      '</div>' +
      '<div id="ups-m-extl-msg"></div>' +
      '<button class="btn-act ext" id="ups-m-extl-submit" style="width:100%;margin-top:12px">Submit Loaded Extension</button>';
    var y2Inp = document.getElementById("ups-m-extl-y2");
    if (y2Inp) y2Inp.addEventListener("input", function (e) { extLoadedState.y2 = parseInt(e.target.value, 10) || 0; updateExtensionLoadedPreview(); });
    var submit = document.getElementById("ups-m-extl-submit");
    if (submit) submit.addEventListener("click", function () {
      var FOX2 = window.UPS_FRONT_OFFICE_EXT;
      var cc = extLoadedState.constraints;
      var y2 = Math.round((parseInt(extLoadedState.y2, 10) || 0) / 1000) * 1000;
      var y3 = cc.extensionTotal - y2;
      var err = FOX2.validateLoadedExtensionYears(y2, y3, cc.minExtYear);
      if (err) { window.UPS_MOBILE.ui.showToast(err, "err"); return; }
      confirmAndSubmitExtensionLoaded(FOX2.buildLoadedExtensionOption(cc, y2));
    });
    updateExtensionLoadedPreview();
  }
  function updateExtensionLoadedPreview() {
    var FOX = window.UPS_FRONT_OFFICE_EXT;
    var c = extLoadedState.constraints;
    var y2 = Math.round((parseInt(extLoadedState.y2, 10) || 0) / 1000) * 1000;
    var y3 = c.extensionTotal - y2;
    var opt = FOX.buildLoadedExtensionOption(c, y2);
    function setText(id, t) { var el = document.getElementById(id); if (el) el.textContent = t; }
    setText("ups-m-extl-y3", U.fmtUsd(y3));
    setText("ups-m-extl-status", opt.status);
    setText("ups-m-extl-tcv", U.fmtUsd(opt.tcv) + " · " + U.fmtUsd(opt.gtd));
    var err = FOX.validateLoadedExtensionYears(y2, y3, c.minExtYear);
    var msg = document.getElementById("ups-m-extl-msg");
    if (msg) msg.innerHTML = err ? '<div class="ups-m-rstr-err">' + U.escapeHtml(err) + '</div>' : '<div class="ups-m-rstr-ok">Ready to submit.</div>';
    var submit = document.getElementById("ups-m-extl-submit");
    if (submit) submit.disabled = !!err;
  }
  function confirmAndSubmitExtensionLoaded(option) {
    var s = window.UPS_MOBILE.state;
    var newSal = Number(option.salaryToSend) || 0;
    var curSal = Number(footerState.rosterRow && footerState.rosterRow.salary) || 0;
    var capLine = capPreviewLine(newSal - curSal);
    var lines = ["Submit +2Y loaded extension for " + footerState.name + "?", "",
      "Status: " + option.status,
      "Y1: " + U.fmtUsd(option.yrs[0]) + " (locked)",
      "Y2: " + U.fmtUsd(option.yrs[1]),
      "Y3: " + U.fmtUsd(option.yrs[2]),
      "TCV: " + U.fmtUsd(option.tcv) + " · GTD: " + U.fmtUsd(option.gtd)];
    if (!window.confirm(lines.join("\n") + capLine + "\n\nThis writes to MFL and cannot be undone from the app.")) return;
    var body = document.getElementById("ups-m-ext-body");
    if (body) body.innerHTML = '<div class="ups-m-sheet-loading">Submitting…</div>';
    var player = window.UPS_MOBILE.data.playerById(footerState.pid);
    window.UPS_FRONT_OFFICE_EXT.submitExtension({
      workerBase: window.UPS_MOBILE.api.workerBase(),
      leagueId: s.ctx.leagueId, year: s.ctx.year,
      pid: footerState.pid,
      playerName: U.safeStr(player && player.name) || footerState.name,
      fid: s.viewerFranchiseId,
      franchiseName: (s.viewerFranchise && s.viewerFranchise.name) || "",
      position: U.safeStr(player && player.position),
      option: option, rosterRow: footerState.rosterRow, dryRun: false, commishOverride: window.UPS_MOBILE.isCommishOverride()
    }).then(function (resp) {
      if (resp.ok) {
        window.UPS_MOBILE.ui.showToast(option.status + " extension submitted ✓", "ok");
        closeExtSheet();
        return window.UPS_MOBILE.actions.reloadData().then(function () { window.UPS_MOBILE.route.renderRoute(); close(); });
      }
      var slot = document.getElementById("ups-m-ext-body");
      if (slot) slot.innerHTML = '<div class="ups-m-sheet-empty" style="color:var(--danger)">Loaded extension failed: ' + U.escapeHtml(resp.error || "unknown") + '</div>';
    }).catch(function (err) {
      var slot = document.getElementById("ups-m-ext-body");
      if (slot) slot.innerHTML = '<div class="ups-m-sheet-empty" style="color:var(--danger)">Loaded extension failed: ' + U.escapeHtml(err && err.message || String(err)) + '</div>';
    });
  }
  function confirmAndSubmitExtension(option) {
    var FOX = window.UPS_FRONT_OFFICE_EXT;
    var s = window.UPS_MOBILE.state;
    var rosterRow = footerState.rosterRow;
    // U6 — cap impact preview. Extension changes the current-year salary
    // to option.salaryToSend; the delta vs the existing rosterRow.salary
    // is what shifts the cap.
    var newSal = Number(option && option.salaryToSend) || 0;
    var curSal = Number(rosterRow && rosterRow.salary) || 0;
    var capLine = capPreviewLine(newSal - curSal);
    var msg = "Submit extension for " + footerState.name + "?\n\n" +
              FOX.extensionActionLabel(option) + "\n" +
              FOX.extensionOptionSummary(option) +
              capLine +
              "\n\nThis writes to MFL and cannot be undone from the app.";
    if (!window.confirm(msg)) return;

    var body = document.getElementById("ups-m-ext-body");
    if (body) body.innerHTML = '<div class="ups-m-sheet-loading">Submitting…</div>';

    var player = window.UPS_MOBILE.data.playerById(footerState.pid);
    FOX.submitExtension({
      workerBase: window.UPS_MOBILE.api.workerBase(),
      leagueId: s.ctx.leagueId,
      year: s.ctx.year,
      pid: footerState.pid,
      playerName: U.safeStr(player && player.name) || footerState.name,
      fid: s.viewerFranchiseId,
      franchiseName: s.viewerFranchise && s.viewerFranchise.name || "",
      position: U.safeStr(player && player.position),
      option: option,
      rosterRow: rosterRow,
      dryRun: false,
      commishOverride: window.UPS_MOBILE.isCommishOverride()
    }).then(function (resp) {
      if (resp.ok) {
        window.UPS_MOBILE.ui.showToast("Extension submitted ✓", "ok");
        closeExtSheet();
        return window.UPS_MOBILE.actions.reloadData().then(function () {
          window.UPS_MOBILE.route.renderRoute();
          close();
        });
      }
      var slot = document.getElementById("ups-m-ext-body");
      if (slot) slot.innerHTML = '<div class="ups-m-sheet-empty" style="color:var(--danger)">Extension failed: ' +
        U.escapeHtml(resp.error || "unknown error") + '</div>';
    }).catch(function (err) {
      var slot = document.getElementById("ups-m-ext-body");
      if (slot) slot.innerHTML = '<div class="ups-m-sheet-empty" style="color:var(--danger)">Extension failed: ' +
        U.escapeHtml(err && err.message || String(err)) + '</div>';
    });
  }

  // In-app Restructure — editor sheet with Y1 input + auto-derived
  // Y2 (2yr) or Y2 input + auto-derived Y3 (3yr). Validation matches
  // restructureCalc() (verbatim from roster_workbench.js).
  var restructureState = { years: 2, tcv: 0, y1: 0, y2: 0 };

  function handleRestructurePick() {
    var FOR = window.UPS_FRONT_OFFICE_RSTR;
    if (!FOR) return;
    var rosterRow = footerState.rosterRow;
    var adapted = FOR.adaptRosterRow(rosterRow);
    var cy = U.safeInt(rosterRow && rosterRow.contractYear, 0);
    var years = cy >= 3 ? 3 : 2;
    var baseline = FOR.restructureBaselineForPlayer(adapted, years);
    restructureState = {
      years: years,
      tcv: baseline.tcv,
      y1: baseline.y1,
      y2: years === 2 ? (baseline.tcv - baseline.y1) : baseline.y2,
      // Prior-contract context so restructureCalc can PRESERVE the AAV token
      // verbatim and derive the -FL/-BL suffix from the money-movement direction.
      special: U.safeStr(adapted && adapted.special),
      priorStatus: U.safeStr(rosterRow && rosterRow.contractStatus),
      priorSalary: U.safeInt(rosterRow && rosterRow.salary, 0)
    };
    renderRestructureSheet();
  }

  function ensureRstrMount() {
    var existing = document.getElementById("ups-m-rstr-overlay");
    if (existing) existing.remove();
    var html =
      '<div class="ups-m-drop-overlay" id="ups-m-rstr-overlay">' +
        '<div class="ups-m-drop-sheet">' +
          '<div class="ups-m-drop-head">' +
            '<button class="ups-m-drop-close" id="ups-m-rstr-close" aria-label="Close">×</button>' +
            '<div class="grip"></div>' +
            '<div class="title">Restructure ' + U.escapeHtml(footerState.name) + '</div>' +
            '<div class="sub">TCV is preserved. Move money between years to flatten or front/back-load.</div>' +
          '</div>' +
          '<div class="ups-m-drop-body" id="ups-m-rstr-body" style="padding:14px 16px"></div>' +
        '</div>' +
      '</div>';
    var mount = document.getElementById("ups-m-app");
    if (!mount) return null;
    mount.insertAdjacentHTML("beforeend", html);
    document.body.style.overflow = "hidden";
    var overlay = document.getElementById("ups-m-rstr-overlay");
    overlay.addEventListener("click", function (e) { if (e.target === overlay) closeRstrSheet(); });
    document.getElementById("ups-m-rstr-close").addEventListener("click", closeRstrSheet);
    return overlay;
  }
  function closeRstrSheet() {
    var ov = document.getElementById("ups-m-rstr-overlay");
    if (ov) ov.remove();
    document.body.style.overflow = "";
  }
  // Restructure renderer — builds the sheet ONCE, then per-keystroke
  // calls updateRestructurePreview() to refresh derived spans / error
  // line / submit button state IN PLACE. Keeps focus on the input.
  function renderRestructureSheet() {
    ensureRstrMount();
    var body = document.getElementById("ups-m-rstr-body");
    if (!body) return;
    var s = restructureState;
    var minY1 = Math.ceil((s.tcv * 0.2) / 1000) * 1000;
    body.innerHTML = '' +
      '<div class="ups-m-rstr-summary">' +
        '<div class="row"><span class="lbl">TCV (fixed):</span> <span class="val">' + U.fmtUsd(s.tcv) + '</span></div>' +
        '<div class="row"><span class="lbl">Years:</span> <span class="val">' + s.years + '</span></div>' +
      '</div>' +
      '<div class="ups-m-rstr-field">' +
        '<label>Year 1 salary (min ' + U.fmtUsd(minY1) + ', 1K increments)</label>' +
        '<input type="number" step="1000" min="' + minY1 + '" max="' + (s.tcv - (s.years - 1) * 1000) + '" ' +
          'value="' + s.y1 + '" id="ups-m-rstr-y1" inputmode="numeric" />' +
      '</div>' +
      (s.years === 3 ? '<div class="ups-m-rstr-field">' +
        '<label>Year 2 salary (1K increments)</label>' +
        '<input type="number" step="1000" min="1000" value="' + s.y2 + '" id="ups-m-rstr-y2" inputmode="numeric" />' +
      '</div>' : '') +
      '<div class="ups-m-rstr-derived">' +
        (s.years === 2
          ? '<div class="row"><span class="lbl">Year 2 (auto):</span> <span class="val" id="ups-m-rstr-y2auto">—</span></div>'
          : '<div class="row"><span class="lbl">Year 3 (auto):</span> <span class="val" id="ups-m-rstr-y3auto">—</span></div>') +
        '<div class="row"><span class="lbl">AAV:</span> <span class="val" id="ups-m-rstr-aav">—</span></div>' +
        '<div class="row"><span class="lbl">GTD:</span> <span class="val" id="ups-m-rstr-gtd">—</span></div>' +
      '</div>' +
      '<div id="ups-m-rstr-status"></div>' +
      '<button class="btn-act otb on" id="ups-m-rstr-submit" style="width:100%;margin-top:12px">' +
        'Submit Restructure' +
      '</button>';

    var y1Inp = document.getElementById("ups-m-rstr-y1");
    if (y1Inp) y1Inp.addEventListener("input", function (e) {
      restructureState.y1 = parseInt(e.target.value, 10) || 0;
      updateRestructurePreview();
    });
    var y2Inp = document.getElementById("ups-m-rstr-y2");
    if (y2Inp) y2Inp.addEventListener("input", function (e) {
      restructureState.y2 = parseInt(e.target.value, 10) || 0;
      updateRestructurePreview();
    });
    var submit = document.getElementById("ups-m-rstr-submit");
    if (submit) submit.addEventListener("click", function () {
      var FOR = window.UPS_FRONT_OFFICE_RSTR;
      var calc = FOR.restructureCalc({
        years: restructureState.years, tcv: restructureState.tcv,
        y1: restructureState.y1, y2: restructureState.y2,
        priorContractInfo: restructureState.special,
        priorContractStatus: restructureState.priorStatus,
        priorSalary: restructureState.priorSalary
      });
      if (calc.ok) confirmAndSubmitRestructure(calc);
    });
    updateRestructurePreview();
  }

  function updateRestructurePreview() {
    var FOR = window.UPS_FRONT_OFFICE_RSTR;
    var s = restructureState;
    var calc = FOR.restructureCalc({
      years: s.years, tcv: s.tcv, y1: s.y1, y2: s.y2,
      priorContractInfo: s.special,
      priorContractStatus: s.priorStatus,
      priorSalary: s.priorSalary
    });
    function setText(id, txt) { var el = document.getElementById(id); if (el) el.textContent = txt; }
    if (s.years === 2) setText("ups-m-rstr-y2auto", U.fmtUsd(s.tcv - s.y1));
    else setText("ups-m-rstr-y3auto", U.fmtUsd(s.tcv - s.y1 - s.y2));
    setText("ups-m-rstr-aav", U.fmtUsd(calc.aav));
    setText("ups-m-rstr-gtd", calc.ok ? U.fmtUsd(calc.gtd) : "—");
    var status = document.getElementById("ups-m-rstr-status");
    if (status) {
      status.innerHTML = calc.ok
        ? '<div class="ups-m-rstr-ok">Ready to submit.</div>'
        : '<div class="ups-m-rstr-err">' + window.UPS_MOBILE.util.escapeHtml(calc.error || "") + '</div>';
    }
    var submit = document.getElementById("ups-m-rstr-submit");
    if (submit) submit.disabled = !calc.ok;
  }

  function confirmAndSubmitRestructure(calc) {
    // U6 — cap impact preview. Restructure swaps the current-year salary
    // for calc.y1; the delta vs the existing rosterRow.salary is the cap shift.
    var curSal = Number(footerState.rosterRow && footerState.rosterRow.salary) || 0;
    var capLine = capPreviewLine(Number(calc.y1) - curSal);
    var msg = "Submit restructure for " + footerState.name + "?\n\n" +
              "Years: " + calc.years + "\n" +
              "Year 1: " + U.fmtUsd(calc.y1) + "\n" +
              "Year 2: " + U.fmtUsd(calc.y2) + "\n" +
              (calc.years >= 3 ? "Year 3: " + U.fmtUsd(calc.y3) + "\n" : "") +
              "TCV: " + U.fmtUsd(calc.tcv) + "\n" +
              "AAV: " + U.fmtUsd(calc.aav) + "\n" +
              "GTD: " + U.fmtUsd(calc.gtd) +
              capLine;
    if (!window.confirm(msg)) return;
    var body = document.getElementById("ups-m-rstr-body");
    if (body) body.innerHTML = '<div class="ups-m-sheet-loading">Submitting…</div>';

    var FOR = window.UPS_FRONT_OFFICE_RSTR;
    var s = window.UPS_MOBILE.state;
    var rosterRow = footerState.rosterRow;
    var player = window.UPS_MOBILE.data.playerById(footerState.pid);
    FOR.submitRestructure({
      workerBase: window.UPS_MOBILE.api.workerBase(),
      leagueId: s.ctx.leagueId,
      year: s.ctx.year,
      pid: footerState.pid,
      playerName: U.safeStr(player && player.name) || footerState.name,
      fid: s.viewerFranchiseId,
      franchiseName: s.viewerFranchise && s.viewerFranchise.name || "",
      position: U.safeStr(player && player.position),
      priorContractStatus: U.safeStr(rosterRow && rosterRow.contractStatus),
      calc: calc,
      commishOverride: window.UPS_MOBILE.isCommishOverride()
    }).then(function (resp) {
      if (resp.ok) {
        window.UPS_MOBILE.ui.showToast("Restructure submitted ✓", "ok");
        closeRstrSheet();
        return window.UPS_MOBILE.actions.reloadData().then(function () {
          window.UPS_MOBILE.route.renderRoute();
          close();
        });
      }
      var slot = document.getElementById("ups-m-rstr-body");
      if (slot) slot.innerHTML = '<div class="ups-m-rstr-err">Restructure failed: ' + U.escapeHtml(resp.error || "unknown error") + '</div>';
    }).catch(function (err) {
      var slot = document.getElementById("ups-m-rstr-body");
      if (slot) slot.innerHTML = '<div class="ups-m-rstr-err">Restructure failed: ' + U.escapeHtml(err && err.message || String(err)) + '</div>';
    });
  }

  // ── In-app MYAC (§C2) ──────────────────────────────────────────────
  // Math + payload live in front_office_myac_submit.js (UPS_M_FO_MYAC),
  // a verbatim mirror of v2/front_office.js. Flat submits after a confirm
  // (no form needed — TCV = bid × years). Loaded opens a Y1 free-key form
  // sheet that parallels Restructure: Y1 (and Y2 for 3-yr) are owner-keyed,
  // the last year auto-computes, TCV stays fixed.
  var myacLoadedState = { totalYears: 2, statusBase: "Vet-FAA", constraints: null, loadedN: 0, y1: 0, y2: 0 };

  function handleMyacPick(btn) {
    var MY = window.UPS_M_FO_MYAC;
    if (!MY) return;
    var totalYears = U.safeInt(btn && btn.getAttribute("data-myac-total"), 2) || 2;
    var rosterRow = footerState.rosterRow;
    var flat = MY.flatMyacYears(rosterRow, totalYears);
    if (flat.error) { window.UPS_MOBILE.ui.showToast(flat.error, "err"); return; }
    var contract = MY.buildMyacContract(totalYears, flat.yrs, MY.myacStatusBase(rosterRow));
    confirmAndSubmitMyac(contract);
  }

  function confirmAndSubmitMyac(contract) {
    // U6 — cap impact preview. MYAC sets the current-year salary to Y1;
    // the delta vs the existing rosterRow.salary is the cap shift.
    var newSal = Number(contract.yrs[0]) || 0;
    var curSal = Number(footerState.rosterRow && footerState.rosterRow.salary) || 0;
    var capLine = capPreviewLine(newSal - curSal);
    var lines = ["Submit " + contract.totalYears + "-year MYAC for " + footerState.name + "?", "",
      "Status: " + contract.status];
    for (var i = 0; i < contract.yrs.length; i++) lines.push("Y" + (i + 1) + ": " + U.fmtUsd(contract.yrs[i]));
    lines.push("TCV: " + U.fmtUsd(contract.tcv) + " · GTD: " + U.fmtUsd(contract.gtd));
    var msg = lines.join("\n") + capLine + "\n\nThis writes to MFL and cannot be undone from the app.";
    if (!window.confirm(msg)) return;
    window.UPS_MOBILE.ui.showToast("Submitting MYAC…", "ok");
    submitMyacContract(contract);
  }

  function submitMyacContract(contract) {
    var MY = window.UPS_M_FO_MYAC;
    var s = window.UPS_MOBILE.state;
    var rosterRow = footerState.rosterRow;
    var player = window.UPS_MOBILE.data.playerById(footerState.pid);
    return MY.submitMyac({
      workerBase: window.UPS_MOBILE.api.workerBase(),
      leagueId: s.ctx.leagueId,
      year: s.ctx.year,
      pid: footerState.pid,
      playerName: U.safeStr(player && player.name) || footerState.name,
      fid: s.viewerFranchiseId,
      franchiseName: s.viewerFranchise && s.viewerFranchise.name || "",
      position: U.safeStr(player && player.position),
      contract: contract,
      rosterRow: rosterRow,
      dryRun: false,
      commishOverride: window.UPS_MOBILE.isCommishOverride()
    }).then(function (resp) {
      if (resp.ok) {
        window.UPS_MOBILE.ui.showToast(contract.totalYears + "-yr MYAC submitted ✓ (" + contract.status + ")", "ok");
        closeMyacSheet();
        return window.UPS_MOBILE.actions.reloadData().then(function () {
          window.UPS_MOBILE.route.renderRoute();
          close();
        });
      }
      var slot = document.getElementById("ups-m-myac-body");
      if (slot) slot.innerHTML = '<div class="ups-m-rstr-err">MYAC failed: ' + U.escapeHtml(resp.error || "unknown error") + '</div>';
      else window.UPS_MOBILE.ui.showToast("MYAC failed: " + (resp.error || "unknown error"), "err");
    }).catch(function (err) {
      var slot = document.getElementById("ups-m-myac-body");
      if (slot) slot.innerHTML = '<div class="ups-m-rstr-err">MYAC failed: ' + U.escapeHtml(err && err.message || String(err)) + '</div>';
      else window.UPS_MOBILE.ui.showToast("MYAC failed: " + (err && err.message || String(err)), "err");
    });
  }

  function ensureMyacMount() {
    var existing = document.getElementById("ups-m-myac-overlay");
    if (existing) existing.remove();
    var html =
      '<div class="ups-m-drop-overlay" id="ups-m-myac-overlay">' +
        '<div class="ups-m-drop-sheet">' +
          '<div class="ups-m-drop-head">' +
            '<button class="ups-m-drop-close" id="ups-m-myac-close" aria-label="Close">×</button>' +
            '<div class="grip"></div>' +
            '<div class="title">MYAC — ' + U.escapeHtml(footerState.name) + '</div>' +
            '<div class="sub">Loaded: free-key Y1 in whole $1,000s. Last year auto-computes. TCV is fixed (bid × years).</div>' +
          '</div>' +
          '<div class="ups-m-drop-body" id="ups-m-myac-body" style="padding:14px 16px"></div>' +
        '</div>' +
      '</div>';
    var mount = document.getElementById("ups-m-app");
    if (!mount) return null;
    mount.insertAdjacentHTML("beforeend", html);
    document.body.style.overflow = "hidden";
    var overlay = document.getElementById("ups-m-myac-overlay");
    overlay.addEventListener("click", function (e) { if (e.target === overlay) closeMyacSheet(); });
    document.getElementById("ups-m-myac-close").addEventListener("click", closeMyacSheet);
    return overlay;
  }
  function closeMyacSheet() {
    var ov = document.getElementById("ups-m-myac-overlay");
    if (ov) ov.remove();
    document.body.style.overflow = "";
  }

  function handleMyacLoadedPick(btn) {
    var MY = window.UPS_M_FO_MYAC;
    if (!MY) return;
    var totalYears = U.safeInt(btn && btn.getAttribute("data-myac-total"), 3) || 3;
    var rosterRow = footerState.rosterRow;
    var bid = U.safeInt(rosterRow && rosterRow.salary, 0);
    if (bid < 1000) { window.UPS_MOBILE.ui.showToast("MYAC needs a base salary ≥ $1,000.", "err"); return; }
    // §C2 loaded-contract cap (5 per roster) — block before opening the form.
    var myRoster = window.UPS_MOBILE.data.getRosterFor(window.UPS_MOBILE.state.viewerFranchiseId) || [];
    var loadedN = MY.loadedContractCount(myRoster);
    if (loadedN >= MY.LOADED_MAX) {
      window.UPS_MOBILE.ui.showToast("At the " + MY.LOADED_MAX + "-loaded cap — trade or cut a loaded player, or use a flat MYAC.", "err");
      return;
    }
    var constraints = MY.loadedMyacConstraints(rosterRow, totalYears);
    myacLoadedState = {
      totalYears: totalYears,
      statusBase: MY.myacStatusBase(rosterRow),
      constraints: constraints,
      loadedN: loadedN,
      y1: constraints.aav,
      y2: constraints.aav
    };
    renderMyacLoadedSheet();
  }

  function renderMyacLoadedSheet() {
    ensureMyacMount();
    var body = document.getElementById("ups-m-myac-body");
    if (!body) return;
    var st = myacLoadedState;
    var c = st.constraints;
    var rows3 = st.totalYears === 3;
    body.innerHTML = '' +
      '<div class="ups-m-rstr-summary">' +
        '<div class="row"><span class="lbl">TCV (fixed):</span> <span class="val">' + U.fmtUsd(c.tcv) + '</span> <span class="lbl">(' + U.fmtUsd(c.aav) + ' × ' + st.totalYears + ')</span></div>' +
        '<div class="row"><span class="lbl">Records as:</span> <span class="val">' + U.escapeHtml(st.statusBase) + '</span></div>' +
        '<div class="row"><span class="lbl">Loaded used:</span> <span class="val">' + st.loadedN + ' / ' + window.UPS_M_FO_MYAC.LOADED_MAX + '</span></div>' +
      '</div>' +
      '<div class="ups-m-rstr-field">' +
        '<label>Year 1 salary (min ' + U.fmtUsd(c.minY1) + ', 1K increments)</label>' +
        '<input type="number" step="1000" min="' + c.minY1 + '" value="' + st.y1 + '" id="ups-m-myac-y1" inputmode="numeric" />' +
      '</div>' +
      (rows3 ? '<div class="ups-m-rstr-field">' +
        '<label>Year 2 salary (1K increments)</label>' +
        '<input type="number" step="1000" min="1000" value="' + st.y2 + '" id="ups-m-myac-y2" inputmode="numeric" />' +
      '</div>' : '') +
      '<div class="ups-m-rstr-derived">' +
        '<div class="row"><span class="lbl">Year ' + st.totalYears + ' (auto):</span> <span class="val" id="ups-m-myac-last">—</span></div>' +
        '<div class="row"><span class="lbl">AAV:</span> <span class="val">' + U.fmtUsd(c.aav) + '</span></div>' +
        '<div class="row"><span class="lbl">Shape:</span> <span class="val" id="ups-m-myac-shape">—</span></div>' +
      '</div>' +
      '<div id="ups-m-myac-status"></div>' +
      '<button class="btn-act otb on" id="ups-m-myac-submit" style="width:100%;margin-top:12px">Submit ' + U.escapeHtml(st.statusBase) + ' MYAC</button>';

    var y1Inp = document.getElementById("ups-m-myac-y1");
    if (y1Inp) y1Inp.addEventListener("input", function (e) {
      myacLoadedState.y1 = parseInt(e.target.value, 10) || 0;
      updateMyacLoadedPreview();
    });
    var y2Inp = document.getElementById("ups-m-myac-y2");
    if (y2Inp) y2Inp.addEventListener("input", function (e) {
      myacLoadedState.y2 = parseInt(e.target.value, 10) || 0;
      updateMyacLoadedPreview();
    });
    var submit = document.getElementById("ups-m-myac-submit");
    if (submit) submit.addEventListener("click", function () {
      var MY = window.UPS_M_FO_MYAC;
      var yrs = MY.loadedMyacYears(myacLoadedState.constraints, myacLoadedState.y1, rows3 ? myacLoadedState.y2 : 0);
      var err = MY.validateLoadedYears(yrs, myacLoadedState.constraints.minY1);
      if (err) { window.UPS_MOBILE.ui.showToast(err, "err"); return; }
      // Re-check the loaded cap at submit (another tab may have added one).
      var myRoster = window.UPS_MOBILE.data.getRosterFor(window.UPS_MOBILE.state.viewerFranchiseId) || [];
      if (MY.loadedContractCount(myRoster) >= MY.LOADED_MAX) {
        window.UPS_MOBILE.ui.showToast("At the " + MY.LOADED_MAX + "-loaded cap — can't add another.", "err");
        return;
      }
      var contract = MY.buildMyacContract(myacLoadedState.totalYears, yrs, myacLoadedState.statusBase);
      confirmAndSubmitMyacLoaded(contract);
    });
    updateMyacLoadedPreview();
  }

  function updateMyacLoadedPreview() {
    var MY = window.UPS_M_FO_MYAC;
    var st = myacLoadedState;
    var rows3 = st.totalYears === 3;
    var yrs = MY.loadedMyacYears(st.constraints, st.y1, rows3 ? st.y2 : 0);
    function setText(id, txt) { var el = document.getElementById(id); if (el) el.textContent = txt; }
    setText("ups-m-myac-last", U.fmtUsd(yrs[yrs.length - 1]));
    var err = MY.validateLoadedYears(yrs, st.constraints.minY1);
    // FL/BL shape preview — derived the same way buildMyacContract does.
    var aav = st.constraints.aav;
    var shape = yrs.every(function (v) { return v === yrs[0]; })
      ? "Flat" : (yrs[0] > aav ? "Front-loaded (FL)" : "Back-loaded (BL)");
    setText("ups-m-myac-shape", shape);
    var status = document.getElementById("ups-m-myac-status");
    if (status) status.innerHTML = err
      ? '<div class="ups-m-rstr-err">' + U.escapeHtml(err) + '</div>'
      : '<div class="ups-m-rstr-ok">Ready to submit.</div>';
    var submit = document.getElementById("ups-m-myac-submit");
    if (submit) submit.disabled = !!err;
  }

  function confirmAndSubmitMyacLoaded(contract) {
    var newSal = Number(contract.yrs[0]) || 0;
    var curSal = Number(footerState.rosterRow && footerState.rosterRow.salary) || 0;
    var capLine = capPreviewLine(newSal - curSal);
    var lines = ["Submit " + contract.totalYears + "-year loaded MYAC for " + footerState.name + "?", "",
      "Status: " + contract.status];
    for (var i = 0; i < contract.yrs.length; i++) lines.push("Y" + (i + 1) + ": " + U.fmtUsd(contract.yrs[i]));
    lines.push("TCV: " + U.fmtUsd(contract.tcv) + " · GTD: " + U.fmtUsd(contract.gtd));
    var msg = lines.join("\n") + capLine + "\n\nThis writes to MFL and cannot be undone from the app.";
    if (!window.confirm(msg)) return;
    var body = document.getElementById("ups-m-myac-body");
    if (body) body.innerHTML = '<div class="ups-m-sheet-loading">Submitting…</div>';
    submitMyacContract(contract);
  }

  // In-app Tag submit. Pipeline lives in front_office_tag_submit.js
  // (verbatim mirror of roster_workbench.js submitTagPlanSelection).
  function handleTagSubmit() {
    var FOA = window.UPS_FRONT_OFFICE_ACTIONS;
    var FOT = window.UPS_FRONT_OFFICE_TAG;
    if (!FOA || !FOT) return;
    var s = window.UPS_MOBILE.state;
    // Re-run tagActionForPlayer to get the matched plan row.
    var teamRows = (window.UPS_MOBILE.data.getRosterFor(s.viewerFranchiseId) || []).map(function (r) {
      var p = window.UPS_MOBILE.data.playerById(r.id);
      return { id: r.id, contractStatus: r.contractStatus, position: (p && p.position) || "" };
    });
    var action = FOA.tagActionForPlayer({
      rosterRow: footerState.rosterRow,
      fid: s.viewerFranchiseId,
      rosterRowsWithPos: teamRows,
      tagTracking: s.tagTracking || [],
      tagSubmissions: s.tagSubmissions || [],
      currentSeason: s.ctx && s.ctx.year
    });
    if (action.kind !== "tag" || !action.row) {
      window.UPS_MOBILE.ui.showToast("This player isn't in the tag plan.", "err");
      return;
    }
    var row = action.row;
    var salary = FOT.effectiveTagSalaryForRow(row);
    var formula = FOT.effectiveTagFormulaForRow(row);
    var msg = "Tag " + (row.player_name || footerState.name) + " for " + U.fmtUsd(salary) + "?\n\n" +
              "Side: " + U.safeStr(row.tag_side || row.side) + "\n" +
              (row.tag_tier ? "Tier: " + row.tag_tier + "\n" : "") +
              (formula ? "Formula: " + formula + "\n" : "") +
              "\nThis writes to MFL and logs to UPS tag history.";
    if (!window.confirm(msg)) return;

    var btn = document.querySelector('[data-act="tag"]') || document.querySelector('[data-contract-action="tag"]');
    setBusy(btn, true, "Tagging…");
    FOT.submitTag({
      workerBase: window.UPS_MOBILE.api.workerBase(),
      leagueId: s.ctx.leagueId,
      year: s.ctx.year,
      row: row,
      dryRun: false,
      commishOverride: window.UPS_MOBILE.isCommishOverride()
    }).then(function (resp) {
      setBusy(btn, false);
      if (resp.ok) {
        // Optimistic — tag_submissions.json regenerates on a schedule
        // so the slot would otherwise show "Open" until the next ETL.
        if (DATA.pushOptimisticTagSubmission) {
          DATA.pushOptimisticTagSubmission({
            season: String(s.ctx.year),
            franchise_id: U.pad4(s.viewerFranchiseId),
            franchise_name: s.viewerFranchise && s.viewerFranchise.name || "",
            player_id: U.safeStr(row.player_id || footerState.pid),
            player_name: U.safeStr(row.player_name || footerState.name),
            pos: U.safeStr(row.position),
            side: U.safeStr(row.tag_side || row.side).toUpperCase(),
            tag_side: U.safeStr(row.tag_side || row.side).toUpperCase(),
            tag_salary: FOT.effectiveTagSalaryForRow(row),
            submitted_at_utc: new Date().toISOString(),
            submission_kind: "tag"
          });
        }
        window.UPS_MOBILE.ui.showToast((row.player_name || footerState.name) + " tagged ✓", "ok");
        return window.UPS_MOBILE.actions.reloadData().then(function () {
          window.UPS_MOBILE.route.renderRoute();
          close();
        });
      }
      window.UPS_MOBILE.ui.showToast("Tag failed: " + (resp.error || "unknown error"), "err");
    }).catch(function (err) {
      setBusy(btn, false);
      window.UPS_MOBILE.ui.showToast("Tag failed: " + (err && err.message || err), "err");
    });
  }

  function handleUntagSubmit() {
    var FOA = window.UPS_FRONT_OFFICE_ACTIONS;
    var FOT = window.UPS_FRONT_OFFICE_TAG;
    if (!FOA || !FOT) return;
    var s = window.UPS_MOBILE.state;
    var teamRows = (window.UPS_MOBILE.data.getRosterFor(s.viewerFranchiseId) || []).map(function (r) {
      var p = window.UPS_MOBILE.data.playerById(r.id);
      return { id: r.id, contractStatus: r.contractStatus, position: (p && p.position) || "" };
    });
    var action = FOA.tagActionForPlayer({
      rosterRow: footerState.rosterRow,
      fid: s.viewerFranchiseId,
      rosterRowsWithPos: teamRows,
      tagTracking: s.tagTracking || [],
      tagSubmissions: s.tagSubmissions || [],
      currentSeason: s.ctx && s.ctx.year
    });
    if (action.kind !== "untag" || !action.row) {
      window.UPS_MOBILE.ui.showToast("This player isn't currently tagged.", "err");
      return;
    }
    var row = action.row;
    var playerLabel = row.player_name || footerState.name;
    // Untag = revert contract + unload from active (matches desktop
    // submitUntagPlayer roster_workbench.js:11307). The unload step is
    // baked into FOT.submitUntag so callers get both in one call.
    if (!window.confirm("Untag " + playerLabel + "?\n\n" +
        "Restore: " + U.safeStr(row.contract_status) + " at " + U.fmtUsd(row.salary) + "\n" +
        "Then remove from roster.")) return;

    var player = window.UPS_MOBILE.data.playerById(footerState.pid);
    var btn = document.querySelector('[data-contract-action="untag"]');
    setBusy(btn, true, "Untagging…");
    FOT.submitUntag({
      workerBase: window.UPS_MOBILE.api.workerBase(),
      leagueId: s.ctx.leagueId,
      year: s.ctx.year,
      fid: s.viewerFranchiseId,
      pid: footerState.pid,
      playerName: U.safeStr(player && player.name) || footerState.name,
      franchiseName: s.viewerFranchise && s.viewerFranchise.name || "",
      position: U.safeStr(player && player.position),
      row: row,
      dryRun: false,
      commishOverride: window.UPS_MOBILE.isCommishOverride()
    }).then(function (resp) {
      setBusy(btn, false);
      if (!resp.ok) {
        window.UPS_MOBILE.ui.showToast("Untag failed: " + (resp.error || "unknown error"), "err");
        return;
      }
      // Optimistic untag — the slot frees up immediately rather than
      // waiting on the ETL JSON regen.
      if (DATA.pushOptimisticTagSubmission) {
        DATA.pushOptimisticTagSubmission({
          season: String(s.ctx.year),
          franchise_id: U.pad4(s.viewerFranchiseId),
          franchise_name: s.viewerFranchise && s.viewerFranchise.name || "",
          player_id: U.safeStr(footerState.pid),
          player_name: playerLabel,
          pos: U.safeStr(player && player.position),
          side: U.safeStr(row.tag_side || row.side).toUpperCase(),
          tag_side: U.safeStr(row.tag_side || row.side).toUpperCase(),
          submitted_at_utc: new Date().toISOString(),
          submission_kind: "untag"
        });
      }
      if (resp.unloadFailed) {
        window.UPS_MOBILE.ui.showToast(playerLabel + " untagged — manual drop needed (unload failed)", "err");
      } else {
        window.UPS_MOBILE.ui.showToast(playerLabel + " untagged ✓", "ok");
      }
      return window.UPS_MOBILE.actions.reloadData().then(function () {
        window.UPS_MOBILE.route.renderRoute();
        close();
      });
    }).catch(function (err) {
      setBusy(btn, false);
      window.UPS_MOBILE.ui.showToast("Untag failed: " + (err && err.message || err), "err");
    });
  }

  function setBusy(btn, busy, busyText) {
    if (!btn) return;
    if (busy) {
      btn.setAttribute("data-original", btn.textContent || "");
      btn.textContent = busyText || "Working…";
      btn.disabled = true;
      btn.classList.add("busy");
    } else {
      var orig = btn.getAttribute("data-original");
      if (orig != null) btn.textContent = orig;
      btn.removeAttribute("data-original");
      btn.disabled = false;
      btn.classList.remove("busy");
    }
  }

  function handleOTBSave(btn) {
    var ta = document.getElementById("ups-m-otb-note");
    var note = ta ? String(ta.value || "").trim() : "";
    setBusy(btn, true, "Saving…");
    ACT.submitOTBToggle(footerState.pid, footerState.name, { action: "add", note: note }).then(function (res) {
      return ACT.reloadData().then(function () {
        setBusy(btn, false);
        footerState.editingOtb = false;
        window.UPS_MOBILE.ui.showToast("Added to On the Block ✓", "ok");
        // Refresh roster row reference (cy/salary unchanged but harmless).
        footerState.rosterRow = (findRosterRowAcrossLeague(footerState.pid) || {}).row;
        rerenderFooter();
        window.UPS_MOBILE.route.renderRoute();
      });
    }).catch(function (err) {
      setBusy(btn, false);
      window.UPS_MOBILE.ui.showToast("Failed: " + (err && err.message || err), "err");
    });
  }

  function handleOTBRemove(btn) {
    if (!window.confirm("Remove " + footerState.name + " from On the Block?")) return;
    setBusy(btn, true, "Removing…");
    ACT.submitOTBToggle(footerState.pid, footerState.name, { action: "remove" }).then(function (res) {
      return ACT.reloadData().then(function () {
        setBusy(btn, false);
        footerState.editingOtb = false;
        window.UPS_MOBILE.ui.showToast("Removed from On the Block ✓", "ok");
        footerState.rosterRow = (findRosterRowAcrossLeague(footerState.pid) || {}).row;
        rerenderFooter();
        window.UPS_MOBILE.route.renderRoute();
      });
    }).catch(function (err) {
      setBusy(btn, false);
      window.UPS_MOBILE.ui.showToast("Failed: " + (err && err.message || err), "err");
    });
  }

  // U6 helper — given a current-year cap-charge delta, append a
  // post-action cap state preview to the confirm body so the user
  // sees the consequence before tapping submit. Uses computeCap so the
  // numbers match the Contracts cap card exactly.
  //
  // Labels:
  //   "This-year cap change" = how this action shifts the current cap line
  //                            (Drop: penalty − current salary;
  //                             Extension/Restructure: new Y1 − current Y1)
  //   "Cap after this action" = total committed after the change
  //   "Room left"             = $300K − cap after  (negative = over cap)
  //   "%"                     = cap after / $300K cap ceiling
  //
  // Uses fmtUsdPrecise so a $1.5K penalty shows as "$1.5K" not "$2K".
  function capPreviewLine(deltaUsd) {
    var s = window.UPS_MOBILE.state;
    if (!s.viewerFranchiseId || !DATA.computeCap) return "";
    var cap = DATA.computeCap(s.viewerFranchiseId);
    if (!cap || !cap.capAmount) return "";
    var newTotal = (cap.capTotal || 0) + (deltaUsd || 0);
    var newRoom = (cap.capAmount || 0) - newTotal;
    var newPct = Math.round((newTotal / cap.capAmount) * 100);
    var sign = (deltaUsd > 0) ? "+" : (deltaUsd < 0 ? "−" : "");
    var absDelta = Math.abs(deltaUsd || 0);
    return "\n\nThis-year cap change: " + sign + U.fmtUsdPrecise(absDelta) +
      "\nCap after this action: " + U.fmtUsdPrecise(newTotal) +
      "\nRoom left: " + U.fmtUsdPrecise(newRoom) + " (" + newPct + "% of $300K cap)";
  }

  function handleDrop(pid, name, rosterRow, btn) {
    var penalty = DATA.dropPenaltyFor(rosterRow, window.UPS_MOBILE.state.ctx.year);
    var penaltyLine = "";
    if (penalty && typeof penalty.amount === "number") {
      penaltyLine = penalty.amount > 0
        ? "\nEstimated cap penalty: " + U.fmtUsdPrecise(penalty.amount)
        : "\nNo dead-cap penalty.";
    } else {
      penaltyLine = "\nCap penalty: unknown (pre-2019 or unparseable contract).";
    }
    // U6 — cap impact preview: show user the post-drop cap state before
    // they commit. Drop removes the live salary and replaces it with the
    // dead-cap penalty, so the net delta is (penalty - currentSalary).
    //
    // EXCEPT for EXPIRED players (cy=0): they were already coming off
    // the cap at season end. Dropping an expiring player frees nothing
    // new — cap delta is $0. Keith MobileNotesV1: "-1 cap charge doesn't
    // make sense for a player that's expiring. He should count for $0
    // this year since he's expiring."
    var penaltyAmt = (penalty && typeof penalty.amount === "number") ? penalty.amount : 0;
    var curSalary = Number(rosterRow && rosterRow.salary) || 0;
    var cyRem = U.safeInt(rosterRow && rosterRow.contractYear, -1);
    var capDelta = cyRem === 0 ? 0 : (penaltyAmt - curSalary);
    var capLine = capPreviewLine(capDelta);
    if (!window.confirm("Drop " + name + "?" + penaltyLine + capLine + "\n\nThis writes to MFL and cannot be undone from the app.")) return;
    setBusy(btn, true, "Dropping…");
    ACT.submitDrop(pid, name).then(function (resp) {
      return ACT.reloadData().then(function () {
        setBusy(btn, false);
        window.UPS_MOBILE.ui.showToast((resp && resp.message) || (name + " dropped ✓"), "ok");
        close();
        window.UPS_MOBILE.route.renderRoute();
      });
    }).catch(function (err) {
      setBusy(btn, false);
      window.UPS_MOBILE.ui.showToast("Drop failed: " + (err && err.message || err), "err");
    });
  }

  // ── Tabs (Actions / Stats / News / Bio) — mirrors the desktop FO slide-over
  // and Team Ops' player profile modal, which carries the same NEWS tab.
  function renderTabNav() {
    var tabs = [["actions", "Actions"], ["stats", "Stats"], ["news", "News"], ["bio", "Bio"]];
    return tabs.map(function (t) {
      return '<button class="ups-m-sheet-tab' + (t[0] === activeTab ? " active" : "") +
        '" role="tab" data-tab="' + t[0] + '">' + t[1] + '</button>';
    }).join("");
  }
  function setTab(tab) {
    activeTab = tab;
    var nav = document.getElementById("ups-m-sheet-tabs");
    if (nav) {
      var btns = nav.querySelectorAll(".ups-m-sheet-tab");
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle("active", btns[i].getAttribute("data-tab") === tab);
      }
    }
    // Actions live in the sticky foot — show it only on the Actions tab.
    var foot = document.getElementById("ups-m-sheet-foot");
    if (foot) foot.style.display = (tab === "actions") ? "" : "none";
    renderTabBody();
  }
  function renderTabBody() {
    var body = document.getElementById("ups-m-sheet-body");
    if (!body) return;
    if (activeTab === "stats") {
      body.innerHTML = '<div class="ups-m-sheet-block"><h4>Season Stats</h4>' +
        '<div id="ups-m-sheet-stats">' +
          (currentBundle ? renderStatsBlock(currentBundle) : '<div class="ups-m-sheet-loading">Loading…</div>') +
        '</div></div>';
    } else if (activeTab === "news") {
      body.innerHTML = '<div class="ups-m-sheet-block"><h4>Player News</h4>' +
        '<div id="' + newsContainerId(footerState.pid) + '">' +
          '<div class="ups-m-sheet-loading">Loading news…</div>' +
        '</div></div>';
      loadPlayerNews(footerState.pid);
    } else if (activeTab === "bio") {
      body.innerHTML = renderBioBlock(footerState.pid, currentBundle);
    } else {
      // Actions tab — contract context; the action buttons sit in the foot.
      body.innerHTML = rowContractBlock(footerState.rosterRow) ||
        '<div class="ups-m-sheet-block"><div class="ups-m-sheet-empty">Free agent — no contract on file.</div></div>';
    }
  }
  // ── Player News ───────────────────────────────────────────────────────────
  // Same worker endpoint the desktop uses — /api/player-news, the multi-source
  // aggregator (Sleeper structured status/depth notes + ESPN team articles
  // fuzzy-matched on last name). Mirrors _topsLoadProfileNews in
  // site/team_operations/team_operations.js (~3412), including the response
  // shape { items_by_pid: { "<pid>": [ {type,source,timestamp,headline,body,url} ] } }.
  // MFL's own playerProfile.news field is deprecated and returns empty for
  // everyone — that was the v1.7.36 mistake; do not reach for it.
  //
  // ⚠️ THE FEED IS HTML-ENTITY ENCODED. ESPN/Sleeper prose arrives carrying
  // "&#8217;", "&#39;", "&quot;". escapeHtml() re-encodes the ampersand first,
  // so "Falcons&#8217;" would paint those literal characters on screen. Every
  // string below therefore goes decodeEntities → escapeHtml, in that order and
  // never one without the other: decode ONCE so it reads as prose, then escape
  // so a literal <script> in the feed lands as &lt;script&gt;. Both helpers
  // live in app.js (ported verbatim from the desktop) — read their comments
  // before touching this.
  function newsContainerId(pid) { return "ups-m-sheet-news-" + U.safeStr(pid).replace(/\W/g, ""); }

  function loadPlayerNews(pid) {
    pid = U.safeStr(pid);
    if (!pid) return;
    if (newsCache[pid]) { paintPlayerNews(pid, newsCache[pid], ""); return; }
    var s = window.UPS_MOBILE.state;
    var url = API.workerBase() + "/api/player-news" +
      "?L=" + encodeURIComponent(s.ctx.leagueId) +
      "&YEAR=" + encodeURIComponent(s.ctx.year) +
      "&pids=" + encodeURIComponent(pid);
    // credentials:"omit" — the worker answers cross-origin with ACAO `*`, which
    // the browser refuses to honour on a credentialed request. Every mobile →
    // worker fetch in this app carries it; see feedback_mobile_cors_credentials_omit.
    fetch(url, { mode: "cors", credentials: "omit", cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        // No items_by_pid node at all = we did not get an answer we understand.
        // That is an ERROR state, not "no news" — the two look identical on
        // screen otherwise, and only one of them is worth retrying.
        if (!data || !data.items_by_pid) throw new Error("unexpected response");
        var items = data.items_by_pid[pid] || [];
        if (!Array.isArray(items)) items = [];
        newsCache[pid] = items;
        paintPlayerNews(pid, items, "");
      })
      .catch(function (err) {
        // Never cached — a failure must be retryable by reopening the tab.
        paintPlayerNews(pid, null, U.safeStr(err && err.message) || "fetch failed");
      });
  }

  // items === null means "couldn't read" and MUST render as such. An empty
  // array means the aggregator answered and genuinely has nothing. Rendering
  // both as a blank panel is the same lie the IR bucket used to tell.
  function paintPlayerNews(pid, items, errMsg) {
    var el = document.getElementById(newsContainerId(pid));
    if (!el) return;   // sheet closed, or moved to another player mid-flight
    if (items === null) {
      el.innerHTML = '<div class="ups-m-sheet-empty">Couldn\'t load news' +
        (errMsg ? ' (' + U.escapeHtml(errMsg) + ')' : '') +
        '.<br>Reopen this tab to retry.</div>';
      return;
    }
    if (!items.length) {
      el.innerHTML = '<div class="ups-m-sheet-empty">No recent news, injury notes, or depth-chart info for this player.</div>';
      return;
    }
    el.innerHTML = '<ul class="ups-m-news-list">' + items.map(newsItemHtml).join("") + '</ul>';
  }

  function newsItemHtml(n) {
    var when = "";
    var ts = Number(n && n.timestamp);
    // Timestamps are Unix SECONDS. Guard the parse rather than printing
    // "Invalid Date" or a 1970 stamp when a source omits it.
    if (isFinite(ts) && ts > 0) {
      var d = new Date(ts * 1000);
      if (!isNaN(d.getTime())) when = d.toLocaleDateString();
    }
    var type = U.safeStr(n && n.type);
    var typeClass = type === "status" ? " is-status" : (type === "depth" ? " is-depth" : "");
    var typeBadge = type === "status" ? '<span class="ups-m-news-badge is-status">INJURY</span>'
                  : type === "depth" ? '<span class="ups-m-news-badge is-depth">DEPTH</span>'
                  : '';
    var src = U.safeStr(n && n.source);
    // decode ONCE, before the trim, then escape at the sink — see the block
    // comment above loadPlayerNews.
    var headline = U.decodeEntities(n && n.headline);
    var body = U.decodeEntities(n && n.body);
    // safeHttpUrl, not escapeHtml alone: escaping encodes & < > " ' but does
    // NOT neutralise a `javascript:` scheme, and this feed is third-party and
    // partly user-submitted (the aggregator includes reddit). A non-http(s)
    // url renders no link at all rather than a clickable script. Matches the
    // desktop XSS fix in team_operations.js.
    var safeUrl = U.safeHttpUrl(n && n.url);
    var linkHtml = safeUrl
      ? '<a class="ups-m-news-link" href="' + U.escapeHtml(safeUrl) + '" target="_blank" rel="noopener noreferrer">Read full →</a>'
      : '';
    var meta = typeBadge + U.escapeHtml(when) + (src ? (when ? ' · ' : '') + U.escapeHtml(src) : '');
    return '<li class="ups-m-news-item' + typeClass + '">' +
      (meta ? '<div class="ups-m-news-meta">' + meta + '</div>' : '') +
      (headline ? '<div class="ups-m-news-head">' + U.escapeHtml(headline) + '</div>' : '') +
      (body ? '<div class="ups-m-news-body">' + U.escapeHtml(body.slice(0, 800)) + '</div>' : '') +
      linkHtml +
      '</li>';
  }

  function computeAge(bdate) {
    bdate = U.safeStr(bdate);
    if (!bdate) return 0;
    var d = null, m = bdate.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    else if (/^\d{9,10}$/.test(bdate)) d = new Date(parseInt(bdate, 10) * 1000); // MFL birthdates are Unix SECONDS; a 9-digit ts (born before 2001-09) is still seconds — the old `length===10?1000:1` made pre-2001 birthdays land in 1970 → age 56 (e.g. Rashee Rice). Keith 2026-06-28.
    else { var m2 = bdate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (m2) d = new Date(Date.UTC(+m2[3], +m2[1] - 1, +m2[2])); }
    if (!d || isNaN(d.getTime())) return 0;
    var now = new Date();
    var age = now.getUTCFullYear() - d.getUTCFullYear();
    var mo = now.getUTCMonth() - d.getUTCMonth();
    if (mo < 0 || (mo === 0 && now.getUTCDate() < d.getUTCDate())) age -= 1;
    return (age > 0 && age < 70) ? age : 0;
  }
  function renderBioBlock(pid, bundle) {
    var player = DATA.playerById(pid) || {};
    var pp = (bundle && bundle.profile && bundle.profile.playerProfile) || {};
    function pick() { for (var i = 0; i < arguments.length; i++) { var v = U.safeStr(arguments[i]); if (v) return v; } return ""; }
    var age = computeAge(pick(player.birthdate, player.dob, pp.birthdate));
    var wt = pick(player.weight, pp.weight);
    var dY = pick(player.draft_year, pp.draft_year);
    var dR = pick(player.draft_round, pp.draft_round);
    var dP = pick(player.draft_pick, pp.draft_pick);
    var dT = pick(player.draft_team, pp.draft_team);
    var drafted = dY ? (dY + (dR ? " · R" + dR + (dP ? "." + dP : "") : "") + (dT ? " · " + dT : "")) : "";
    var rows = [
      ["Position", pick(player.position, pp.position)],
      ["NFL Team", pick(player.team, pp.team)],
      ["Age", age ? (age + " yrs") : ""],
      ["Height", pick(player.height, pp.height)],
      ["Weight", wt ? (wt + " lb") : ""],
      ["College", pick(player.college, pp.college)],
      ["Drafted (NFL)", drafted]
    ].filter(function (r) { return r[1]; });
    if (!rows.length) {
      return '<div class="ups-m-sheet-block"><div class="ups-m-sheet-empty">Bio details unavailable for this player.</div></div>';
    }
    var kv = rows.map(function (r) {
      return '<div class="lbl">' + U.escapeHtml(r[0]) + '</div><div class="val">' + U.escapeHtml(r[1]) + '</div>';
    }).join("");
    return '<div class="ups-m-sheet-block"><h4>Bio</h4><div class="ups-m-sheet-kv">' + kv + '</div></div>';
  }

  function open(pid, opts) {
    opts = opts || {};
    ensureMount();
    var overlay = document.getElementById("ups-m-sheet-overlay");
    var head = document.getElementById("ups-m-sheet-head");
    var body = document.getElementById("ups-m-sheet-body");
    var foot = document.getElementById("ups-m-sheet-foot");
    if (!overlay || !head || !body || !foot) return;

    overlay.classList.add("open");
    document.body.style.overflow = "hidden";

    var player = DATA.playerById(pid);
    var name = fmtPlayerName(player && player.name);
    var pos = U.safeStr(player && player.position);
    var team = U.safeStr(player && player.team);
    var espnId = U.safeStr(player && (player.espn_id || player.espnId)).replace(/\D/g, "");
    var photoPid = U.safeStr(pid).replace(/\D/g, "");

    // Photo fallback chain — ESPN high-res (350×254 PNG) → MFL thumb
    // (110×110, pixelated) → placeholder. Mirrors the desktop modal
    // chain in site/rosters/roster_workbench.js.
    var photoChain = [];
    if (espnId) photoChain.push("https://a.espncdn.com/i/headshots/nfl/players/full/" + espnId + ".png");
    if (photoPid) photoChain.push("https://www48.myfantasyleague.com/player_photos_2014/" + photoPid + "_thumb.jpg");
    var photoUrl = photoChain[0] || "";
    var photoOnError = photoChain.length > 1
      ? "(function(img,urls){var i=0;img.onerror=function(){i++;if(i<urls.length){img.src=urls[i];}else{img.replaceWith(Object.assign(document.createElement('div'),{className:'ups-m-sheet-photo-placeholder'}));}};})(this," + JSON.stringify(photoChain).replace(/"/g, "&quot;") + ")"
      : "this.replaceWith(Object.assign(document.createElement('div'),{className:'ups-m-sheet-photo-placeholder'}))";
    var photoHtml = photoUrl
      ? '<img class="ups-m-sheet-photo" src="' + U.escapeHtml(photoUrl) + '" alt="' + U.escapeHtml(name || pid) + '" onerror="' + photoOnError + '">'
      : '<div class="ups-m-sheet-photo-placeholder"></div>';

    head.innerHTML =
      '<div class="ups-m-sheet-head-row">' +
        photoHtml +
        '<div class="ups-m-sheet-head-text">' +
          '<div class="name">' + (U.escapeHtml(name) || ('Player ' + U.escapeHtml(pid))) + '</div>' +
          '<div class="sub">' + U.escapeHtml(pos) + (team ? ' · ' + U.escapeHtml(team) : '') + '</div>' +
        '</div>' +
      '</div>';

    var rosterRow = opts.rosterRow || (findRosterRowAcrossLeague(pid) || {}).row || null;
    var ownsPlayer = isOwnRoster(pid);

    footerState.pid = pid;
    footerState.name = name || ("Player " + pid);
    footerState.rosterRow = rosterRow;
    footerState.editingOtb = false;
    // Used by renderStatsBlock to look up leaderboard stats for THIS player.
    window.UPS_MOBILE.state._sheetPid = pid;

    // Tabs default to Actions; the action buttons render into the sticky foot
    // (shown only on the Actions tab). Stats/Bio lazy-render from the bundle.
    currentBundle = null;
    activeTab = "actions";
    var tabsNav = document.getElementById("ups-m-sheet-tabs");
    if (tabsNav) tabsNav.innerHTML = renderTabNav();

    foot.innerHTML = renderActionsFooter(pid, rosterRow, ownsPlayer);
    wireFooterActions();
    foot.style.display = "";   // Actions tab is active on open

    renderTabBody();

    loadBundle(pid).then(function (bundle) {
      currentBundle = bundle;
      if (activeTab === "stats" || activeTab === "bio") renderTabBody();
    });
  }

  window.UPS_MOBILE.sheet = {
    open: open,
    close: close,
    // Called from app.js reloadData() so contract changes mid-session
    // (extension/restructure/drop) don't serve stale /api/player-bundle
    // responses on the next open. News rides along: a refresh is exactly when
    // an owner expects the injury note that prompted it to have landed.
    clearCache: function () { bundleCache = {}; newsCache = {}; }
  };
})();
