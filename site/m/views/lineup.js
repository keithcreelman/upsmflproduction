/* My Team → Lineup view.
   Lineup rules (LINEUP_GROUPS, eligibility, validate) come from the
   verbatim mirror at site/m/front_office_lineup.js — same source-of-
   truth that team_operations.js uses. Don't redefine groups here; if
   the league adds/changes a position group, update the mirror file. */
(function () {
  "use strict";
  if (!window.UPS_MOBILE || !window.UPS_FRONT_OFFICE_LINEUP) return;
  var M = window.UPS_MOBILE;
  var U = M.util;
  var DATA = M.data;
  var API = M.api;
  var FO_LINEUP = window.UPS_FRONT_OFFICE_LINEUP;

  // Visible-in-mobile lineup groups: drop the "Other" catch-all so the UI
  // doesn't render an empty trailing section. The catch-all stays in the
  // mirror so validation still counts mis-positioned players as ineligible.
  var LINEUP_GROUPS = FO_LINEUP.LINEUP_GROUPS.filter(function (g) {
    return g.positions && g.positions.length;
  });
  var TOTAL_STARTERS = FO_LINEUP.TOTAL_STARTERS;

  function nameFor(player) {
    var raw = U.safeStr(player && player.name);
    if (!raw) return "";
    if (raw.indexOf(",") >= 0) {
      var parts = raw.split(",");
      var last = (parts[0] || "").trim();
      var rest = (parts[1] || "").trim();
      return rest ? rest + " " + last : last;
    }
    return raw;
  }
  function buildRows() {
    var fid = M.state.viewerFranchiseId;
    if (!fid) return [];
    var roster = DATA.getRosterFor(fid);
    return roster.map(function (r) {
      var player = DATA.playerById(r.id);
      var pos = U.safeStr(player && player.position).toUpperCase();
      var team = U.safeStr(player && player.team);
      var name = nameFor(player) || ("Player " + r.id);
      // Position → group via the verbatim Front Office mirror.
      var group = FO_LINEUP.lineupGroupForPos(pos);
      var cy = parseInt(r.contractYear, 10);
      var isTaxi = /taxi/i.test(r.status || "");
      var isIr = /ir|injured/i.test(r.status || "");
      var isExpired = cy === 0;
      var row = {
        id: r.id, name: name, pos: pos, team: team, salary: r.salary,
        group: group, isTaxi: isTaxi, isIr: isIr, isExpired: isExpired
      };
      // Eligibility goes through the verbatim mirror too — same predicate
      // team_operations.js uses for the checkbox enable/disable state.
      row.eligible = FO_LINEUP.lineupEligibleRow(row);
      return row;
    });
  }

  // Lineup draft persisted on M.state so toggling between sub-tabs doesn't
  // lose work. Seed once with top-by-salary up to each group's min.
  function ensureDraft(rows) {
    if (M.state.lineupDraft && M.state.lineupDraft instanceof Set) return M.state.lineupDraft;
    var byGroup = {};
    LINEUP_GROUPS.forEach(function (g) { byGroup[g.key] = []; });
    rows.forEach(function (r) {
      if (r.eligible) byGroup[r.group.key].push(r);
    });
    Object.keys(byGroup).forEach(function (k) {
      byGroup[k].sort(function (a, b) { return b.salary - a.salary; });
    });
    var draft = new Set();
    LINEUP_GROUPS.forEach(function (g) {
      (byGroup[g.key] || []).slice(0, g.min).forEach(function (r) { draft.add(r.id); });
    });
    M.state.lineupDraft = draft;
    return draft;
  }

  function validate(rows, draft) {
    var rowsByPid = {};
    rows.forEach(function (r) { rowsByPid[r.id] = r; });
    // Delegate to the verbatim Front Office mirror.
    return FO_LINEUP.lineupValidate(draft, rowsByPid);
  }

  function subTabs(active) {
    function tab(href, label, key) {
      return '<a class="ups-m-subtab' + (key === active ? ' active' : '') +
             '" href="#myteam/' + href + '">' + label + '</a>';
    }
    return '<div class="ups-m-subtabs">' +
      tab("contracts", "Contracts", "contracts") +
      tab("lineup", "Lineup", "lineup") +
      tab("tagging", "Tagging", "tagging") +
      '</div>';
  }

  function statusBadges(r) {
    var out = [];
    if (r.isExpired) out.push('<span class="badge exp">Expired</span>');
    if (r.isTaxi) out.push('<span class="badge tx">Taxi</span>');
    if (r.isIr) out.push('<span class="badge ir">IR</span>');
    return out.join(" ");
  }

  function renderHeader(validation) {
    var ok = validation.ok;
    var fillClass = ok ? "ok" : (validation.total > TOTAL_STARTERS ? "over" : "under");
    var pct = Math.min(100, Math.round((validation.total / TOTAL_STARTERS) * 100));
    var summary = ok
      ? '<strong>' + TOTAL_STARTERS + ' / ' + TOTAL_STARTERS + '</strong> starters · ready to submit'
      : '<strong>' + validation.total + ' / ' + TOTAL_STARTERS + '</strong> starters';
    var errorList = "";
    if (validation.errors.length) {
      errorList = '<ul class="ups-m-lineup-errors">' +
        validation.errors.map(function (e) { return '<li>' + U.escapeHtml(e) + '</li>'; }).join("") +
        '</ul>';
    }
    return '' +
      '<div class="ups-m-lineup-status-card">' +
        '<div class="ups-m-lineup-status-line">' + summary + '</div>' +
        '<div class="ups-m-lineup-bar"><div class="ups-m-lineup-bar-fill ' + fillClass + '" style="width:' + pct + '%"></div></div>' +
        errorList +
      '</div>';
  }

  function renderGroup(group, rows, draft) {
    var groupRows = rows.filter(function (r) { return r.group && r.group.key === group.key; });
    groupRows.sort(function (a, b) {
      // Eligible first, then by salary desc
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
      return b.salary - a.salary;
    });
    var picked = groupRows.filter(function (r) { return draft.has(r.id); }).length;
    var rangeLabel = group.min === group.max
      ? String(group.min)
      : group.min + "-" + group.max;
    var groupClass = picked < group.min ? "under"
                   : picked > group.max ? "over" : "ok";
    var html = '<div class="ups-m-lineup-group">';
    html += '<div class="ups-m-lineup-group-head ' + groupClass + '">' +
      '<span class="label">' + U.escapeHtml(group.label) + '</span>' +
      '<span class="count">' + picked + ' / ' + rangeLabel + '</span>' +
    '</div>';
    if (!groupRows.length) {
      html += '<div class="ups-m-lineup-row empty">No ' + U.escapeHtml(group.label) + ' on roster</div>';
    } else {
      groupRows.forEach(function (r) {
        var checked = draft.has(r.id);
        var disabledCls = r.eligible ? "" : " disabled";
        html += '<label class="ups-m-lineup-row' + (checked ? " on" : "") + disabledCls + '" data-pid="' + U.escapeHtml(r.id) + '">' +
          '<input type="checkbox" class="ups-m-lineup-cb" ' +
            (checked ? "checked " : "") + (r.eligible ? "" : "disabled ") + '/>' +
          '<div class="body">' +
            '<div class="name">' + U.escapeHtml(r.name) + '</div>' +
            '<div class="sub">' +
              (r.team ? '<span>' + U.escapeHtml(r.team) + '</span>' : '') +
              statusBadges(r) +
            '</div>' +
          '</div>' +
          '<div class="salary">' + U.fmtUsd(r.salary) + '</div>' +
        '</label>';
      });
    }
    html += '</div>';
    return html;
  }

  function renderFooter(validation, submitting) {
    var canSubmit = !submitting;  // Allow incomplete saves per team_operations.js:937-938
    var label = submitting ? "Submitting…" :
                validation.ok ? "Submit Lineup" :
                "Save Lineup (" + validation.total + "/" + TOTAL_STARTERS + ")";
    return '<div class="ups-m-lineup-footer">' +
      '<button class="ups-m-lineup-submit' + (validation.ok ? " ready" : "") +
              (submitting ? " busy" : "") + '" id="ups-m-lineup-submit"' +
              (canSubmit ? "" : " disabled") + '>' +
        U.escapeHtml(label) +
      '</button>' +
    '</div>';
  }

  function renderMessage() {
    var msg = M.state.lineupMessage;
    if (!msg) return "";
    return '<div class="ups-m-lineup-msg ' + U.escapeHtml(msg.kind || "info") + '">' +
      U.escapeHtml(msg.text || "") + '</div>';
  }

  function bind(mount, rows, draft) {
    var checkboxes = mount.querySelectorAll(".ups-m-lineup-cb");
    for (var i = 0; i < checkboxes.length; i++) {
      checkboxes[i].addEventListener("change", function (e) {
        var label = e.target.closest("[data-pid]");
        if (!label) return;
        var pid = label.getAttribute("data-pid");
        if (e.target.checked) draft.add(pid); else draft.delete(pid);
        renderRoute();
      });
    }
    var submit = document.getElementById("ups-m-lineup-submit");
    if (submit) submit.addEventListener("click", function () { handleSubmit(rows); });
  }

  function handleSubmit(rows) {
    if (M.state.lineupSubmitting) return;
    var fid = M.state.viewerFranchiseId;
    if (!fid) return;
    var draft = M.state.lineupDraft;
    var starters = draft ? Array.from(draft) : [];
    M.state.lineupSubmitting = true;
    M.state.lineupMessage = { kind: "info", text: "Submitting lineup to MFL…" };
    renderRoute();
    fetch(API.workerUrl("/api/submit-lineup"), {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ franchiseId: fid, starters: starters })
    }).then(function (r) {
      return r.json().then(function (j) { return { status: r.status, body: j }; });
    }).then(function (resp) {
      if (resp.body && resp.body.ok) {
        M.state.lineupMessage = { kind: "ok", text: "Lineup saved to MFL ✓" };
      } else {
        var err = (resp.body && resp.body.error)
                 || (resp.body && resp.body.mfl_response && resp.body.mfl_response.error && resp.body.mfl_response.error.$t)
                 || (resp.body && resp.body.mfl_response && resp.body.mfl_response.error)
                 || ("HTTP " + resp.status);
        M.state.lineupMessage = { kind: "err", text: String(err) };
      }
    }).catch(function (e) {
      M.state.lineupMessage = { kind: "err", text: "Submit failed: " + (e && e.message || e) };
    }).then(function () {
      M.state.lineupSubmitting = false;
      renderRoute();
    });
  }

  function renderRoute() { M.route.renderRoute(); }

  function render(mount) {
    var rows = buildRows();
    if (!rows.length) {
      mount.innerHTML = subTabs("lineup") +
        '<div class="ups-m-stub"><div>No roster found.</div></div>';
      return;
    }
    var draft = ensureDraft(rows);
    var validation = validate(rows, draft);
    var submitting = !!M.state.lineupSubmitting;
    var html = subTabs("lineup");
    html += renderMessage();
    html += renderHeader(validation);
    LINEUP_GROUPS.forEach(function (g) {
      html += renderGroup(g, rows, draft);
    });
    html += renderFooter(validation, submitting);
    mount.innerHTML = html;
    bind(mount, rows, draft);
  }

  M.lineupView = { render: render };
})();
