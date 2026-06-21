/* My Team → Lineup view — slot-based lineup builder.

   18 starters (UPS 2026): 11 offense + 7 defense, presented as fixed + flex
   slots. Each slot is an eligibility-filtered dropdown; picking a player
   removes them from every other dropdown, so you can't double-start anyone.
   The header tracks fill progress live (dynamic as completed). Submission is
   the flat list of the 18 chosen player IDs — MFL auto-slots by position.

   Slot model + validation live in site/m/front_office_lineup.js. */
(function () {
  "use strict";
  if (!window.UPS_MOBILE || !window.UPS_FRONT_OFFICE_LINEUP) return;
  var M = window.UPS_MOBILE;
  var U = M.util;
  var DATA = M.data;
  var API = M.api;
  var FO = window.UPS_FRONT_OFFICE_LINEUP;
  var SLOTS = FO.LINEUP_SLOTS;
  var TOTAL = FO.TOTAL_STARTERS;

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
      var cy = parseInt(r.contractYear, 10);
      var row = {
        id: r.id, name: name, pos: pos, team: team, salary: r.salary,
        group: FO.posGroup(pos),
        isTaxi: /taxi/i.test(r.status || ""),
        isIr: /ir|injured/i.test(r.status || ""),
        isExpired: cy === 0
      };
      row.eligible = FO.lineupEligibleRow(row);
      return row;
    });
  }

  function rowsById(rows) {
    var m = {};
    rows.forEach(function (r) { m[r.id] = r; });
    return m;
  }

  // Draft = { slotId: pid }. Seed once (greedy valid lineup) so the owner
  // starts from a complete 18 they can tweak; persisted on M.state so
  // switching sub-tabs doesn't lose work.
  function ensureDraft(rows) {
    var d = M.state.lineupSlots;
    if (d && typeof d === "object" && !Array.isArray(d)) return d;
    M.state.lineupSlots = FO.autoFillSlots(rows);
    return M.state.lineupSlots;
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
      tab("ir", "IR", "ir") +
      tab("contracts", "Contracts", "contracts") +
      '</div>';
  }

  function renderMessage() {
    var msg = M.state.lineupMessage;
    if (!msg) return "";
    return '<div class="ups-m-lineup-msg ' + U.escapeHtml(msg.kind || "info") + '">' +
      U.escapeHtml(msg.text || "") + '</div>';
  }

  function renderHeader(v) {
    var fillClass = v.ok ? "ok" : (v.filled > TOTAL ? "over" : "under");
    var pct = Math.min(100, Math.round((v.filled / TOTAL) * 100));
    var summary = v.ok
      ? '<strong>' + TOTAL + ' / ' + TOTAL + '</strong> starters · ready to submit'
      : '<strong>' + v.filled + ' / ' + TOTAL + '</strong> starters set';
    var offCls = v.bySide.O === FO.OFFENSE_STARTERS ? "ok" : "under";
    var defCls = v.bySide.D === FO.DEFENSE_STARTERS ? "ok" : "under";
    var chips =
      '<span class="ups-m-lineup-chip ' + offCls + '">Off ' + v.bySide.O + '/' + FO.OFFENSE_STARTERS + '</span>' +
      '<span class="ups-m-lineup-chip ' + defCls + '">Def ' + v.bySide.D + '/' + FO.DEFENSE_STARTERS + '</span>';
    var errorList = "";
    if (v.errors.length) {
      errorList = '<ul class="ups-m-lineup-errors">' +
        v.errors.map(function (e) { return '<li>' + U.escapeHtml(e) + '</li>'; }).join("") +
        '</ul>';
    }
    return '' +
      '<div class="ups-m-lineup-status-card">' +
        '<div class="ups-m-lineup-status-line">' + summary +
          '<span class="ups-m-lineup-chips">' + chips + '</span>' +
        '</div>' +
        '<div class="ups-m-lineup-bar"><div class="ups-m-lineup-bar-fill ' + fillClass + '" style="width:' + pct + '%"></div></div>' +
        errorList +
        '<div class="ups-m-lineup-tools">' +
          '<button type="button" class="ups-m-lineup-tool" id="ups-m-lu-autofill">Auto-fill</button>' +
          '<button type="button" class="ups-m-lineup-tool" id="ups-m-lu-clear">Clear all</button>' +
        '</div>' +
      '</div>';
  }

  // Build the option text for a candidate inside a dropdown.
  function optText(r) {
    var bits = [r.name];
    var meta = [];
    if (r.pos) meta.push(r.pos);
    if (r.team) meta.push(r.team);
    var line = r.name + (meta.length ? "  ·  " + meta.join(" ") : "");
    if (r.salary) line += "  ·  " + U.fmtUsd(r.salary);
    return line;
  }

  // One slot = a label tag + a <select> of eligible, not-yet-used players.
  function renderSlot(slot, rows, draft, used) {
    var current = draft[slot.id] || "";
    // Candidates: eligible, group accepted, and either unused elsewhere or
    // the player already in THIS slot (so the select can show them).
    var cands = rows.filter(function (r) {
      if (!r.eligible) return false;
      if (!FO.slotAccepts(slot, r.group)) return false;
      return !used[r.id] || r.id === current;
    });
    cands.sort(function (a, b) { return (b.salary || 0) - (a.salary || 0); });

    var filled = !!current;
    var opts = '<option value="">— Empty —</option>';
    cands.forEach(function (r) {
      opts += '<option value="' + U.escapeHtml(r.id) + '"' +
        (r.id === current ? " selected" : "") + '>' +
        U.escapeHtml(optText(r)) + '</option>';
    });

    var labelCls = slot.flex ? "pos flex" : "pos";
    var note = slot.note ? '<span class="elig">' + U.escapeHtml(slot.note) + '</span>' : "";
    var selCls = "ups-m-slot-sel" + (filled ? "" : " empty");
    var emptyHint = cands.length ? "" : ' data-none="1"';

    return '<div class="ups-m-slot' + (filled ? " filled" : "") + '" data-slot="' + slot.id + '"' + emptyHint + '>' +
      '<div class="ups-m-slot-tag">' +
        '<span class="' + labelCls + '">' + U.escapeHtml(slot.label) + '</span>' + note +
      '</div>' +
      '<select class="' + selCls + '" data-slot="' + U.escapeHtml(slot.id) + '">' + opts + '</select>' +
    '</div>';
  }

  function renderSection(side, title, count, rows, draft, used) {
    var html = '<div class="ups-m-lineup-section-head"><span>' + title + '</span><span class="n">' + count + '</span></div>';
    SLOTS.filter(function (s) { return s.side === side; }).forEach(function (s) {
      html += renderSlot(s, rows, draft, used);
    });
    return html;
  }

  function renderFooter(v, submitting) {
    var label, ready = false, disabled = false;
    if (submitting) { label = "Submitting…"; disabled = true; }
    else if (v.problems > 0) { label = "Fix lineup errors"; disabled = true; }
    else if (v.complete) { label = "Submit Lineup to MFL"; ready = true; }
    else if (v.filled > 0) { label = "Save Lineup (" + v.filled + "/" + TOTAL + ")"; }
    else { label = "Pick your starters"; disabled = true; }
    return '<div class="ups-m-lineup-footer">' +
      '<button class="ups-m-lineup-submit' + (ready ? " ready" : "") +
              (submitting ? " busy" : "") + '" id="ups-m-lineup-submit"' +
              (disabled ? " disabled" : "") + '>' +
        U.escapeHtml(label) +
      '</button>' +
    '</div>';
  }

  function bind(mount, rows) {
    var draft = M.state.lineupSlots;
    var selects = mount.querySelectorAll(".ups-m-slot-sel");
    for (var i = 0; i < selects.length; i++) {
      selects[i].addEventListener("change", function (e) {
        var slotId = e.target.getAttribute("data-slot");
        var pid = e.target.value;
        if (pid) draft[slotId] = pid; else delete draft[slotId];
        renderRoute();
      });
    }
    var af = document.getElementById("ups-m-lu-autofill");
    if (af) af.addEventListener("click", function () {
      M.state.lineupSlots = FO.autoFillSlots(rows);
      M.state.lineupMessage = null;
      renderRoute();
    });
    var clr = document.getElementById("ups-m-lu-clear");
    if (clr) clr.addEventListener("click", function () {
      M.state.lineupSlots = {};
      M.state.lineupMessage = null;
      renderRoute();
    });
    var submit = document.getElementById("ups-m-lineup-submit");
    if (submit) submit.addEventListener("click", function () { handleSubmit(); });
  }

  function handleSubmit() {
    if (M.state.lineupSubmitting) return;
    var fid = M.state.viewerFranchiseId;
    if (!fid) return;
    var draft = M.state.lineupSlots || {};
    // Flat list of chosen player IDs, in slot order, de-duped defensively.
    var seen = {}, starters = [];
    SLOTS.forEach(function (s) {
      var pid = draft[s.id];
      if (pid && !seen[pid]) { seen[pid] = 1; starters.push(pid); }
    });
    if (!starters.length) return;  // nothing to save; button is gated on problems===0
    M.state.lineupSubmitting = true;
    M.state.lineupMessage = { kind: "info", text: "Submitting lineup to MFL…" };
    renderRoute();
    // Forward the viewer's MFL_USER_ID — /api/submit-lineup REQUIRES it to
    // authenticate the write to MFL and verifies it matches this franchise
    // (worker returns 401/403 otherwise). Cross-origin from github.io we
    // can't send the MFL cookie, so it goes as a query param — same pattern
    // as the roster-workbench actions + trade builder.
    var luUrl = API.workerUrl("/api/submit-lineup");
    var luStored = API.getStoredMflUserId && API.getStoredMflUserId();
    if (luStored) luUrl += "?MFL_USER_ID=" + encodeURIComponent(luStored);
    fetch(luUrl, {
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
    var byId = rowsById(rows);
    var v = FO.validateSlots(draft, byId);
    var submitting = !!M.state.lineupSubmitting;

    // Players already used (so each dropdown can exclude them).
    var used = {};
    SLOTS.forEach(function (s) { if (draft[s.id]) used[draft[s.id]] = 1; });

    var html = subTabs("lineup");
    html += renderMessage();
    html += renderHeader(v);
    html += renderSection("O", "Offense", FO.OFFENSE_STARTERS, rows, draft, used);
    html += renderSection("D", "Defense", FO.DEFENSE_STARTERS, rows, draft, used);
    html += renderFooter(v, submitting);
    mount.innerHTML = html;
    bind(mount, rows);
  }

  M.lineupView = { render: render };
})();
