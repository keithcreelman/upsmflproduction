/* My Team → Tagging view.
 *
 * Mirrors the Roster Workbench Tagging tab: show the viewer's active tag
 * slots (offense / defense) and the list of tag-eligible players for the
 * viewer franchise (from site/ccc/tag_tracking.json). Eligibility +
 * conflict gates come from window.UPS_FRONT_OFFICE_ACTIONS.tagActionForPlayer,
 * the verbatim mirror already in place.
 *
 * Rules (per Keith — mirror Roster Workbench):
 *   - 1 offense tag (QB/RB/WR/TE) + 1 defense/ST tag per team per year.
 *   - Tag → player moves to roster as TAG; that positional side becomes
 *     ineligible for another tag.
 *   - Can untag until the deadline.
 *   - Tag salary + formula come from the tag_tracking.json row.
 */
(function () {
  "use strict";
  if (!window.UPS_MOBILE) return;
  var M = window.UPS_MOBILE;
  var U = M.util;

  function nameFor(player) {
    var raw = U.safeStr(player && player.name);
    if (!raw) return "";
    if (raw.indexOf(",") >= 0) {
      var parts = raw.split(",");
      return ((parts[1] || "").trim() + " " + (parts[0] || "").trim()).trim();
    }
    return raw;
  }
  function subTabs(active) {
    function tab(href, label, key) {
      return '<a class="ups-m-subtab' + (key === active ? ' active' : '') +
             '" href="#myteam/' + href + '">' + label + '</a>';
    }
    return '<div class="ups-m-subtabs">' +
      tab("roster", "Roster", "roster") +
      tab("lineup", "Lineup", "lineup") +
      tab("taxi", "Taxi", "taxi") +
      tab("contracts", "Contracts", "contracts") +
      '</div>';
  }

  function buildEligibleRows(fid) {
    var tracking = (M.state && M.state.tagTracking) || [];
    return tracking.filter(function (r) {
      if (!r) return false;
      if (U.pad4(r.franchise_id) !== U.pad4(fid)) return false;
      // is_tag_eligible flag (numeric 1 from tag_tracking.json)
      if (r.is_tag_eligible != null && Number(r.is_tag_eligible) !== 1) return false;
      return true;
    });
  }

  function teamRosterRowsWithPos(fid) {
    var roster = M.data.getRosterFor(fid) || [];
    return roster.map(function (r) {
      var p = M.data.playerById(r.id);
      return { id: r.id, contractStatus: r.contractStatus, position: (p && p.position) || "" };
    });
  }

  // Active tag per side (offense / defense). Returns
  //   { OFFENSE: <rosterRow|null>, DEFENSE: <rosterRow|null> }
  function activeTagSlots(fid) {
    var FOA = window.UPS_FRONT_OFFICE_ACTIONS;
    if (!FOA) return { OFFENSE: null, DEFENSE: null };
    var rows = teamRosterRowsWithPos(fid);
    var tracking = M.state.tagTracking || [];
    var curYear = M.state.ctx && M.state.ctx.year;
    var off = FOA.activeTaggedPlayerForTeam(rows, "OFFENSE", M.state.tagSubmissions || [], fid, tracking, curYear);
    var def = FOA.activeTaggedPlayerForTeam(rows, "DEFENSE", M.state.tagSubmissions || [], fid, tracking, curYear);
    return { OFFENSE: off || null, DEFENSE: def || null };
  }

  function fmtSalaryRange(row) {
    var FOT = window.UPS_FRONT_OFFICE_TAG;
    if (!FOT) return "—";
    var sal = FOT.effectiveTagSalaryForRow(row);
    return U.fmtUsd(sal);
  }
  function fmtFormula(row) {
    var FOT = window.UPS_FRONT_OFFICE_TAG;
    if (!FOT) return "";
    return U.safeStr(FOT.effectiveTagFormulaForRow(row));
  }

  function renderSlotsCard(slots) {
    function slotRow(side, label, active) {
      var name = "Open";
      if (active) {
        // The roster scan returns just { id, contractStatus, position }.
        // Look up the actual player name from state.players.
        var pid = active.id || active.player_id || "";
        var p = pid ? M.data.playerById(pid) : null;
        name = nameFor(p) || U.safeStr(active.player_name) || ("Player " + pid);
      }
      var cls = active ? "filled" : "open";
      return '<div class="ups-m-tag-slot ' + cls + '">' +
        '<div class="lbl">' + label + '</div>' +
        '<div class="val">' + U.escapeHtml(name) + '</div>' +
      '</div>';
    }
    return '<div class="ups-m-card">' +
      '<div class="ups-m-card-title">Your Tag Slots</div>' +
      '<div class="ups-m-tag-slots">' +
        slotRow("OFFENSE", "Offense", slots.OFFENSE) +
        slotRow("DEFENSE", "Defense", slots.DEFENSE) +
      '</div>' +
      '<div class="ups-m-tag-help">' +
        '1 offense (QB/RB/WR/TE) + 1 defense (everyone else) per year. Untag any time before the tag deadline.' +
      '</div>' +
    '</div>';
  }

  function renderEligibleList(eligible, slots, fid) {
    if (!eligible.length) {
      return '<div class="ups-m-stub"><div>No tag-eligible players for your franchise.</div></div>';
    }
    var FOA = window.UPS_FRONT_OFFICE_ACTIONS;
    var rosterRowsWithPos = teamRosterRowsWithPos(fid);
    var tagTracking = M.state.tagTracking || [];
    var tagSubmissions = M.state.tagSubmissions || [];

    // Sort: active tags first, then by salary descending
    var sorted = eligible.slice().sort(function (a, b) {
      var sa = Number(a.tag_salary || 0);
      var sb = Number(b.tag_salary || 0);
      return sb - sa;
    });

    var html = '<div class="ups-m-pos-group">Eligible · ' + sorted.length + '</div>';
    sorted.forEach(function (row) {
      // Get current action state via the same predicate the player sheet uses.
      var rosterRow = { id: row.player_id, contractStatus: row.contract_status };
      var action = FOA.tagActionForPlayer({
        rosterRow: rosterRow,
        fid: fid,
        rosterRowsWithPos: rosterRowsWithPos,
        tagTracking: tagTracking,
        tagSubmissions: tagSubmissions,
        currentSeason: M.state.ctx && M.state.ctx.year
      });
      var side = U.escapeHtml(U.safeStr(row.tag_side || row.side));
      var displaySide = /OFFENSE|^OFF$/i.test(side) ? "Offense" :
                       /DEFENSE|^DEF$|IDP|IDP_K/i.test(side) ? "Defense" : side;
      var posBadge = U.safeStr(row.position).toUpperCase() || "?";
      var name = U.escapeHtml(row.player_name || ("Player " + row.player_id));
      var salaryStr = U.escapeHtml(fmtSalaryRange(row));
      var formula = U.escapeHtml(fmtFormula(row));

      var btnHtml;
      if (action.kind === "untag") {
        btnHtml = '<button class="ups-m-tag-btn untag" data-pid="' + U.escapeHtml(row.player_id) + '" data-act="untag">Untag</button>';
      } else if (action.kind === "tag") {
        btnHtml = '<button class="ups-m-tag-btn tag" data-pid="' + U.escapeHtml(row.player_id) + '" data-act="tag">Tag · ' + salaryStr + '</button>';
      } else if (action.kind === "locked") {
        btnHtml = '<button class="ups-m-tag-btn locked" disabled>Slot used</button>';
      } else {
        btnHtml = '<button class="ups-m-tag-btn disabled" disabled>—</button>';
      }

      html += '<div class="ups-m-tag-row" data-pid="' + U.escapeHtml(row.player_id) + '">' +
        '<div class="pos">' + posBadge + '</div>' +
        '<div class="body">' +
          '<div class="name">' + name + '</div>' +
          '<div class="sub">' +
            '<span class="badge side ' + (displaySide.toLowerCase()) + '">' + displaySide + '</span>' +
            (row.tag_tier ? '<span class="badge">Tier ' + Number(row.tag_tier) + '</span>' : '') +
            '<span>' + salaryStr + '</span>' +
          '</div>' +
          (formula ? '<div class="formula">' + formula + '</div>' : '') +
        '</div>' +
        '<div class="right">' + btnHtml + '</div>' +
      '</div>';
    });
    return html;
  }

  // Mirrors the in-app Tag submit flow from player_sheet.js — same
  // UPS_FRONT_OFFICE_TAG entry points. Centralized here so the Tagging
  // view can call it directly without going through the player sheet.
  function handleTagAction(pid, act) {
    var FOA = window.UPS_FRONT_OFFICE_ACTIONS;
    var FOT = window.UPS_FRONT_OFFICE_TAG;
    if (!FOA || !FOT) return;
    var s = M.state;
    var rosterRow = (M.data.getRosterFor(s.viewerFranchiseId) || []).filter(function (r) { return r.id === pid; })[0] ||
                    { id: pid, contractStatus: "" };
    var rosterRowsWithPos = teamRosterRowsWithPos(s.viewerFranchiseId);
    var action = FOA.tagActionForPlayer({
      rosterRow: rosterRow,
      fid: s.viewerFranchiseId,
      rosterRowsWithPos: rosterRowsWithPos,
      tagTracking: s.tagTracking || [],
      tagSubmissions: s.tagSubmissions || [],
      currentSeason: s.ctx && s.ctx.year
    });

    if (act === "tag" && action.kind === "tag" && action.row) {
      var row = action.row;
      var salary = FOT.effectiveTagSalaryForRow(row);
      var formula = FOT.effectiveTagFormulaForRow(row);
      var msg = "Tag " + (row.player_name) + " for " + U.fmtUsd(salary) + "?\n\n" +
                "Side: " + U.safeStr(row.tag_side || row.side) + "\n" +
                (row.tag_tier ? "Tier: " + row.tag_tier + "\n" : "") +
                (formula ? "Formula: " + formula + "\n" : "") +
                "\nThis writes to MFL and locks the " +
                (/OFFENSE|^OFF$/i.test(row.tag_side || row.side) ? "offense" : "defense") +
                " tag slot until you untag.";
      if (!window.confirm(msg)) return;
      M.ui.showToast("Tagging…", "info");
      FOT.submitTag({
        workerBase: M.api.workerBase(),
        leagueId: s.ctx.leagueId,
        year: s.ctx.year,
        row: row,
        dryRun: false,
        commishOverride: false
      }).then(function (resp) {
        if (resp.ok) {
          // Optimistic push so the slot updates before tag_submissions.json
          // regenerates (otherwise the UI would still say "Open").
          if (M.data.pushOptimisticTagSubmission) {
            M.data.pushOptimisticTagSubmission({
              season: String(s.ctx.year),
              franchise_id: U.pad4(s.viewerFranchiseId),
              franchise_name: (s.viewerFranchise && s.viewerFranchise.name) || "",
              player_id: U.safeStr(row.player_id),
              player_name: U.safeStr(row.player_name),
              pos: U.safeStr(row.position),
              side: U.safeStr(row.tag_side || row.side).toUpperCase(),
              tag_side: U.safeStr(row.tag_side || row.side).toUpperCase(),
              tag_salary: salary,
              submitted_at_utc: new Date().toISOString(),
              submission_kind: "tag"
            });
          }
          M.ui.showToast(row.player_name + " tagged ✓", "ok");
          return M.actions.reloadData().then(function () { M.route.renderRoute(); });
        }
        M.ui.showToast("Tag failed: " + (resp.error || "unknown"), "err");
      }).catch(function (err) {
        M.ui.showToast("Tag failed: " + (err && err.message || err), "err");
      });
    } else if (act === "untag" && action.kind === "untag" && action.row) {
      var urow = action.row;
      // FOT.submitUntag does the two-step: revert contract +
      // unload_player. Matches desktop submitUntagPlayer.
      if (!window.confirm("Untag " + urow.player_name + "?\n\n" +
          "Restore: " + U.safeStr(urow.contract_status) + " at " + U.fmtUsd(urow.salary) + "\n" +
          "Then remove from roster.")) return;
      var player = M.data.playerById(pid);
      M.ui.showToast("Untagging…", "info");
      FOT.submitUntag({
        workerBase: M.api.workerBase(),
        leagueId: s.ctx.leagueId,
        year: s.ctx.year,
        fid: s.viewerFranchiseId,
        pid: pid,
        playerName: U.safeStr((player && player.name) || urow.player_name),
        franchiseName: s.viewerFranchise && s.viewerFranchise.name || "",
        position: U.safeStr((player && player.position) || urow.position),
        row: urow,
        dryRun: false,
        commishOverride: false
      }).then(function (resp) {
        if (!resp.ok) {
          M.ui.showToast("Untag failed: " + (resp.error || "unknown"), "err");
          return;
        }
        // Optimistic: push an "untag" submission so the per-side scanner
        // sees it ahead of MFL/JSON catching up. trackedTaggedPlayer
        // returns null when the latest entry for a pid is kind=untag.
        if (M.data.pushOptimisticTagSubmission) {
          M.data.pushOptimisticTagSubmission({
            season: String(s.ctx.year),
            franchise_id: U.pad4(s.viewerFranchiseId),
            franchise_name: s.viewerFranchise && s.viewerFranchise.name || "",
            player_id: U.safeStr(pid),
            player_name: U.safeStr((player && player.name) || urow.player_name),
            pos: U.safeStr((player && player.position) || urow.position),
            side: U.safeStr(urow.tag_side || urow.side).toUpperCase(),
            tag_side: U.safeStr(urow.tag_side || urow.side).toUpperCase(),
            submitted_at_utc: new Date().toISOString(),
            submission_kind: "untag"
          });
        }
        if (resp.unloadFailed) {
          M.ui.showToast(urow.player_name + " untagged — manual drop needed (unload failed)", "err");
        } else {
          M.ui.showToast(urow.player_name + " untagged ✓", "ok");
        }
        return M.actions.reloadData().then(function () { M.route.renderRoute(); });
      }).catch(function (err) {
        M.ui.showToast("Untag failed: " + (err && err.message || err), "err");
      });
    }
  }

  function bind(mount) {
    var rows = mount.querySelectorAll(".ups-m-tag-row");
    for (var i = 0; i < rows.length; i++) {
      rows[i].addEventListener("click", function (e) {
        // Only open the player sheet if we didn't click an action button.
        if (e.target.closest("button.ups-m-tag-btn")) return;
        var pid = this.getAttribute("data-pid");
        if (pid && M.sheet) M.sheet.open(pid);
      });
    }
    var btns = mount.querySelectorAll(".ups-m-tag-btn[data-act]");
    for (var j = 0; j < btns.length; j++) {
      btns[j].addEventListener("click", function (e) {
        e.stopPropagation();
        var pid = this.getAttribute("data-pid");
        var act = this.getAttribute("data-act");
        if (pid && act) handleTagAction(pid, act);
      });
    }
  }

  // render(mount, opts) — opts.embed=true skips the My Team sub-nav so the
  // Contracts hub can mount the tagging content under its own subtabs + action
  // chips (Keith 2026-06-07: Tagging folded into Contracts › Tag).
  function render(mount, opts) {
    var embed = !!(opts && opts.embed);
    var head = embed ? "" : subTabs("contracts");
    var fid = M.state.viewerFranchiseId;
    if (!fid) {
      mount.innerHTML = head +
        '<div class="ups-m-stub"><div>Sign in to your franchise to manage tags.</div></div>';
      return;
    }
    var slots = activeTagSlots(fid);
    var eligible = buildEligibleRows(fid);
    mount.innerHTML = head +
      renderSlotsCard(slots) +
      renderEligibleList(eligible, slots, fid);
    bind(mount);
  }

  M.taggingView = { render: render };
})();
