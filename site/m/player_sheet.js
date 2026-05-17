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
      if (stats) {
        games = Number(stats.games || 0);
        pts = Number(stats.mfl_points || 0);
        ppg = Number(stats.mfl_ppg || 0);
        ppgRank = Number(stats.posRank || 0);
      } else {
        // Fallback: career_summary (pts only) + playerProfile.seasons (games).
        games = Number(s.games || s.gamesPlayed || c.games_played || 0) || 0;
        pts = Number(c.season_points != null ? c.season_points
                    : (s.fantasyPoints || s.points || s.total || 0)) || 0;
        ppg = games > 0 ? (pts / games) : 0;
        ppgRank = Number(c.pos_ppg_rank || s.pos_ppg_rank || 0) || 0;
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
    return fetch(API.workerUrl("/api/player-bundle?pid=" + encodeURIComponent(pid)), { mode: "cors", credentials: "omit" })
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

  function renderActionsFooter(pid, rosterRow, ownsPlayer, opts) {
    opts = opts || {};
    if (!ownsPlayer) {
      return '<button class="btn" id="ups-m-sheet-foot-close">Close</button>';
    }
    var s = window.UPS_MOBILE.state;
    var otbIds = DATA.getMyTradeBaitIds();
    var onBlock = otbIds.has(String(pid));
    var existingNote = DATA.getMyTradeBaitNoteFor(pid);
    var penalty = DATA.dropPenaltyFor(rosterRow, s.ctx.year);
    var penaltyLabel = "";
    if (penalty && typeof penalty.amount === "number") {
      penaltyLabel = penalty.amount > 0
        ? ' <span class="pn">(' + U.fmtUsd(penalty.amount) + ' penalty)</span>'
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

      // Contract-action grid: Extension / Rookie Option / Restructure /
      // Tag — eligibility comes from the FO mirror. Each button opens the
      // desktop Contract Command Center pre-targeted at this player + action.
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
          html += '<button class="btn-act ' + a.css + '" data-act="ccc" data-ccc-action="' +
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
    var unloadCleanup = foot.querySelector('[data-act="unload-cleanup"]');
    if (unloadCleanup) unloadCleanup.addEventListener("click", function () {
      handleUnloadCleanup(unloadCleanup);
    });
    var cccButtons = foot.querySelectorAll('[data-act="ccc"]');
    for (var ci = 0; ci < cccButtons.length; ci++) {
      cccButtons[ci].addEventListener("click", function () {
        handleCccAction(this.getAttribute("data-ccc-action"));
      });
    }
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
    fetch(url, {
      method: "POST",
      credentials: "include",
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

  // All contract actions run in-app via the verbatim Front Office mirrors.
  // CCC (MODULE=MESSAGE2) is retired (Keith 2026-05-15 — see memory
  // feedback_roster_workbench_is_truth_not_ccc). No deep-link fallback.
  function handleCccAction(action) {
    if (action === "tag") return handleTagSubmit();
    if (action === "untag") return handleUntagSubmit();
    if (action === "extension") return handleExtensionPick();
    if (action === "restructure") return handleRestructurePick();
    window.UPS_MOBILE.ui.showToast("Action not yet available on mobile.", "err");
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
      commishOverride: false
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
      y2: years === 2 ? (baseline.tcv - baseline.y1) : baseline.y2
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
        y1: restructureState.y1, y2: restructureState.y2
      });
      if (calc.ok) confirmAndSubmitRestructure(calc);
    });
    updateRestructurePreview();
  }

  function updateRestructurePreview() {
    var FOR = window.UPS_FRONT_OFFICE_RSTR;
    var s = restructureState;
    var calc = FOR.restructureCalc({ years: s.years, tcv: s.tcv, y1: s.y1, y2: s.y2 });
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
      commishOverride: false
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

    var btn = document.querySelector('[data-act="tag"]') || document.querySelector('[data-ccc-action="tag"]');
    setBusy(btn, true, "Tagging…");
    FOT.submitTag({
      workerBase: window.UPS_MOBILE.api.workerBase(),
      leagueId: s.ctx.leagueId,
      year: s.ctx.year,
      row: row,
      dryRun: false,
      commishOverride: false
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
    var btn = document.querySelector('[data-ccc-action="untag"]');
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
      commishOverride: false
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

    body.innerHTML =
      rowContractBlock(rosterRow) +
      '<div class="ups-m-sheet-block">' +
        '<h4>Season Stats</h4>' +
        '<div id="ups-m-sheet-stats"><div class="ups-m-sheet-loading">Loading…</div></div>' +
      '</div>';

    footerState.pid = pid;
    footerState.name = name || ("Player " + pid);
    footerState.rosterRow = rosterRow;
    footerState.editingOtb = false;
    // Used by renderStatsBlock to look up leaderboard stats for THIS player.
    window.UPS_MOBILE.state._sheetPid = pid;
    foot.innerHTML = renderActionsFooter(pid, rosterRow, ownsPlayer);
    wireFooterActions();

    loadBundle(pid).then(function (bundle) {
      var slot = document.getElementById("ups-m-sheet-stats");
      if (!slot) return;
      slot.innerHTML = renderStatsBlock(bundle);
    });
  }

  window.UPS_MOBILE.sheet = {
    open: open,
    close: close,
    // Called from app.js reloadData() so contract changes mid-session
    // (extension/restructure/drop) don't serve stale /api/player-bundle
    // responses on the next open.
    clearCache: function () { bundleCache = {}; }
  };
})();
