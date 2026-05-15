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

  function renderStatsBlock(profile) {
    // playerProfile.seasons.season is an array of season summaries with
    // games + total fantasy points + ppg.
    if (!profile) return '<div class="ups-m-sheet-empty">No season stats available.</div>';
    var pp = profile.playerProfile || {};
    var seasons = U.asArray(pp.seasons && pp.seasons.season);
    if (!seasons.length) return '<div class="ups-m-sheet-empty">No season stats available.</div>';
    // Take the most recent N seasons, sort descending by year.
    seasons = seasons.slice().sort(function (a, b) {
      return Number(b.year || b.season || 0) - Number(a.year || a.season || 0);
    }).slice(0, 6);
    var rows = seasons.map(function (s) {
      var yr = U.safeStr(s.year || s.season);
      var gm = Number(s.games || s.gamesPlayed || 0);
      var pts = Number(s.fantasyPoints || s.points || s.total || 0);
      var ppg = gm > 0 ? (pts / gm) : 0;
      return '<tr>' +
        '<td>' + U.escapeHtml(yr) + '</td>' +
        '<td>' + (gm || 0) + '</td>' +
        '<td>' + (Math.round(pts * 10) / 10).toFixed(1) + '</td>' +
        '<td>' + (Math.round(ppg * 10) / 10).toFixed(1) + '</td>' +
        '</tr>';
    }).join("");
    return '' +
      '<table class="ups-m-stat-table">' +
        '<thead><tr><th>Year</th><th>G</th><th>Pts</th><th>PPG</th></tr></thead>' +
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
    var html = '';
    if (opts.editingOtb) {
      // Inline note editor — replaces the action grid until Save/Cancel.
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
      html +=
        '<div class="ups-m-sheet-actions">' +
          '<button class="btn-act otb' + (onBlock ? ' on' : '') + '" data-act="otb">' +
            (onBlock ? '✓ On the Block' : 'Add to Block') +
          '</button>' +
          '<button class="btn-act drop" data-act="drop">Drop' + penaltyLabel + '</button>' +
          '<button class="btn-act ext disabled" data-act="extend" disabled>Extend (use desktop)</button>' +
          '<button class="btn-act tag disabled" data-act="tag" disabled>Tag (use desktop)</button>' +
        '</div>';
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

  function handleDrop(pid, name, rosterRow, btn) {
    var penalty = DATA.dropPenaltyFor(rosterRow, window.UPS_MOBILE.state.ctx.year);
    var penaltyLine = "";
    if (penalty && typeof penalty.amount === "number") {
      penaltyLine = penalty.amount > 0
        ? "\nEstimated cap penalty: " + U.fmtUsd(penalty.amount)
        : "\nNo dead-cap penalty.";
    } else {
      penaltyLine = "\nCap penalty: unknown (pre-2019 or unparseable contract).";
    }
    if (!window.confirm("Drop " + name + "?" + penaltyLine + "\n\nThis writes to MFL and cannot be undone from the app.")) return;
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

    head.innerHTML =
      '<div class="name">' + (U.escapeHtml(name) || ('Player ' + U.escapeHtml(pid))) + '</div>' +
      '<div class="sub">' + U.escapeHtml(pos) + (team ? ' · ' + U.escapeHtml(team) : '') + '</div>';

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
    foot.innerHTML = renderActionsFooter(pid, rosterRow, ownsPlayer);
    wireFooterActions();

    loadBundle(pid).then(function (bundle) {
      var slot = document.getElementById("ups-m-sheet-stats");
      if (!slot) return;
      slot.innerHTML = renderStatsBlock(bundle && bundle.profile);
    });
  }

  window.UPS_MOBILE.sheet = {
    open: open,
    close: close
  };
})();
