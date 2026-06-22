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

  // Projected points for the current scoring week. Source: MFL projectedScores
  // (keyless) via the worker /api/mfl-export proxy. Lazy-loaded + cached on
  // M.state; re-renders once it arrives. MFL is "fine for now" per Keith — a
  // better projection source can swap in behind projFor() later.
  function projMap() { return (M.state.lineupProj && M.state.lineupProj.map) || {}; }
  function projFor(pid) { var v = projMap()[String(pid)]; return v == null ? null : v; }
  function fmtProj(v) { return v == null ? "—" : (Math.round(v * 10) / 10).toFixed(1); }
  function projLoaded() { return !!(M.state.lineupProj && M.state.lineupProj.loaded && Object.keys(projMap()).length); }
  // Optimal-lineup score: projection (no-projection sorts last).
  function projScore(r) { var p = projFor(r.id); return p == null ? -1 : p; }
  // League-wide positional rank by projection (cached): { pid: { rank, group } }.
  function posRankMap() {
    if (M.state.lineupProjRank) return M.state.lineupProjRank;
    var pm = projMap(), byGroup = {};
    Object.keys(pm).forEach(function (pid) {
      var pl = DATA.playerById(pid); var g = FO.posGroup(pl && pl.position);
      if (g === "OTH") return;
      (byGroup[g] = byGroup[g] || []).push({ pid: pid, proj: pm[pid] });
    });
    var map = {};
    Object.keys(byGroup).forEach(function (g) {
      byGroup[g].sort(function (a, b) { return b.proj - a.proj; });
      byGroup[g].forEach(function (x, i) { map[x.pid] = { rank: i + 1, group: g }; });
    });
    M.state.lineupProjRank = map;
    return map;
  }
  function posRankFor(pid) { return posRankMap()[String(pid)] || null; }
  function loadProjections() {
    if (M.state.lineupProj) return;   // already loaded or in-flight
    M.state.lineupProj = { loaded: false, map: {} };
    fetch(API.mflExportUrl("projectedScores"), { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var map = {}, ps = j && j.projectedScores && j.projectedScores.playerScore;
        (Array.isArray(ps) ? ps : (ps ? [ps] : [])).forEach(function (p) {
          if (p && p.id) { var n = parseFloat(p.score); if (!isNaN(n)) map[String(p.id)] = n; }
        });
        M.state.lineupProj = { loaded: true, map: map };
        M.state.lineupWeek = parseInt((j && j.projectedScores && j.projectedScores.week) || 0, 10) || 0;
        M.state.lineupProjRank = null;  // rebuild ranks against fresh projections
        // Upgrade an un-edited salary seed to the Optimal (projection) lineup.
        if (M.state.lineupSeed === "salary") { M.state.lineupSlots = null; M.state.lineupSeed = null; }
        renderRoute();
      })
      .catch(function () { M.state.lineupProj = { loaded: true, map: {} }; renderRoute(); });
  }

  // ── Matchup intel — opponent · home/away · kickoff · spread + opponent-adjusted
  // defense-vs-position rank, recent-form window, and schedule horizon, from worker
  // /api/lineup-matchups. Tap-to-expand: one clean line per starter, full intel on tap.
  function muWindow() { return M.state.lineupMuWindow || 0; }   // 0 = season-to-date, else last-N weeks
  function muLabel(k) { var s = muData(0); return k ? ("last " + k) : ((s && s.priorSeason) ? "last season" : "season"); }
  // Which window buttons are meaningful: a window only differs from "season"
  // once enough current-season weeks exist (else L3/L5 == season → confusing
  // dead toggle, per Keith). 0 weeks ⇒ prior-season fallback ⇒ none.
  function availWindows() {
    var s = muData(0), wa = s ? (s.weeksAvailable || 0) : 0, out = [["0", "Season"]];
    if (wa > 3) out.push(["3", "L3"]);
    if (wa > 5) out.push(["5", "L5"]);
    return out;
  }
  // Per-window cache so the detail can show recent-vs-season without re-fetching.
  function loadMatchups() {
    var qp; try { qp = new URLSearchParams(location.search); } catch (e) { qp = { get: function () { return null; } }; }
    var myr = qp.get("mYEAR") || M.state.ctx.year;
    var mwk = qp.get("mW") || M.state.lineupWeek || "";
    if (!M.state.lineupMuCache) M.state.lineupMuCache = {};
    if (!mwk) { if (!M.state.lineupMuCache["0"]) M.state.lineupMuCache["0"] = { empty: true }; return; }   // offseason
    [muWindow(), 0].forEach(function (key) {
      var k = String(key);
      if (M.state.lineupMuCache[k] || M.state._muLoading === ("k" + k)) return;
      M.state._muLoading = "k" + k;
      fetch(API.workerUrl("/api/lineup-matchups?YEAR=" + encodeURIComponent(myr) + "&W=" + encodeURIComponent(mwk) + (key ? "&last=" + key : "")), { mode: "cors", credentials: "omit" })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          M.state.lineupMuCache[k] = { matchups: (d && d.matchups) || {}, defRatings: (d && d.defRatings) || {},
            playerWindow: (d && d.playerWindow) || {}, horizon: (d && d.horizon) || {}, weather: (d && d.weather) || {},
            weeksAvailable: (d && d.weeksAvailable) || 0, priorSeason: !!(d && d.priorSeason) };
          M.state._muLoading = null; renderRoute();
        }).catch(function () { M.state.lineupMuCache[k] = { empty: true }; M.state._muLoading = null; });
    });
  }
  function muData(key) { return (M.state.lineupMuCache || {})[String(key)] || null; }
  function fmtKick(unix) {
    if (!unix) return "";
    try {
      var d = new Date(unix * 1000), days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      var h = d.getHours(), m = d.getMinutes(), ap = h >= 12 ? "p" : "a", h12 = h % 12 || 12;
      return days[d.getDay()] + " " + h12 + (m ? ":" + (m < 10 ? "0" + m : m) : "") + ap;
    } catch (e) { return ""; }
  }
  function rankCls(r) { return r == null ? "" : (r <= 10 ? "good" : (r >= 23 ? "tough" : "")); }
  function matchupFor(pid) {
    var pl = DATA.playerById(pid); if (!pl) return null;
    var team = U.safeStr(pl.team).toUpperCase(), grp = FO.posGroup(pl.position);
    var act = muData(muWindow()), seas = muData(0);
    if (!act || !act.matchups) return null;
    var m = act.matchups[team]; if (!m) return null;
    var dr = (act.defRatings || {})[m.opp], rk = dr && dr[grp] ? dr[grp] : null;
    var hz = ((act.horizon || {})[team] || []).slice(0, 3).map(function (h) {
      var hd = (act.defRatings || {})[h.opp]; return { opp: h.opp, isHome: h.isHome, rank: hd && hd[grp] ? hd[grp].rank : null };
    });
    return { opp: m.opp, isHome: m.isHome, kickoff: m.kickoff, spread: m.spread, grp: grp,
      rank: rk ? rk.rank : null, of: rk ? rk.of : null, ratio: rk ? rk.ratio : null,
      form: (act.playerWindow || {})[String(pid)] || null,
      seasonForm: (seas && seas.playerWindow) ? seas.playerWindow[String(pid)] : null, horizon: hz,
      weather: (act.weather || {})[team] || null };
  }
  // "54°F · wind 12 · P.Cloudy" — or "Dome (climate controlled)".
  function wxText(w) {
    if (!w) return "";
    if (w.dome) return "Dome (climate controlled)";
    var bits = [];
    if (w.tempF != null) bits.push(w.tempF + "°F");
    if (w.windMph != null) bits.push("wind " + w.windMph + " mph");
    if (w.summary) bits.push(w.summary);
    if (w.precip && w.precip >= 0.05) bits.push(w.precip + '" precip');
    return bits.join(" · ");
  }
  // Compact, tappable matchup line + an on-demand detail card (Keith 2026-06-21:
  // declutter — one clean line per starter, full intel on tap).
  function slotMatchupHtml(pid) {
    var mu = matchupFor(pid); if (!mu) return "";
    var loc = (mu.isHome ? "vs " : "@ ") + mu.opp, when = fmtKick(mu.kickoff);
    var chip = mu.rank != null ? '<span class="ups-m-mu-rank ' + rankCls(mu.rank) + '">' + U.escapeHtml(mu.opp) + ' #' + mu.rank + ' to ' + mu.grp + '</span>' : "";
    var open = M.state.lineupMuExpand === pid;
    // Compact line carries location + kickoff + the def chip; the detail no
    // longer repeats opp/kickoff (Keith: "@ JAC" was showing twice) — it just
    // leads with the betting line when one exists.
    var compact = '<div class="ups-m-slot-mu" data-mu-pid="' + U.escapeHtml(pid) + '">' + U.escapeHtml(loc) + (when ? " · " + U.escapeHtml(when) : "") + (chip ? " · " + chip : "") + '<span class="ups-m-mu-exp">' + (open ? "▾" : "▸") + '</span></div>';
    if (!open) return compact;
    var hasLine = (mu.spread != null && mu.spread !== 0);
    var rows = [];
    if (hasLine) rows.push('<div class="r ups-m-mu-line">Line <b>' + U.escapeHtml((mu.spread > 0 ? "+" : "") + mu.spread) + '</b></div>');
    var wx = wxText(mu.weather);
    if (wx) rows.push('<div class="r ups-m-mu-wx">' + U.escapeHtml(wx) + '</div>');
    if (mu.rank != null) { var pct = Math.round((mu.ratio - 1) * 100); rows.push('<div class="r">Defense <b class="ups-m-mu-rank ' + rankCls(mu.rank) + '">#' + mu.rank + '/' + mu.of + ' to ' + mu.grp + '</b> · allows ' + (pct >= 0 ? "+" : "") + pct + '% vs expected (' + muLabel(muWindow()) + ')</div>'); }
    if (mu.form && mu.form.games) {
      var f = 'Form <b>' + fmtProj(mu.form.avg) + '</b> avg (' + muLabel(muWindow()) + ', ' + mu.form.games + 'g)';
      if (muWindow() && mu.seasonForm && mu.seasonForm.games) f += ' · season ' + fmtProj(mu.seasonForm.avg);
      rows.push('<div class="r">' + f + '</div>');
    }
    var hz = (mu.horizon || []).filter(function (h) { return h.opp; });
    if (hz.length) rows.push('<div class="r">Next: ' + hz.map(function (h) { return '<span class="ups-m-hz ' + rankCls(h.rank) + '">' + (h.isHome ? "" : "@") + U.escapeHtml(h.opp) + (h.rank != null ? " #" + h.rank : "") + '</span>'; }).join("  ") + '</div>');
    return compact + '<div class="ups-m-mu-detail">' + rows.join("") + '</div>';
  }

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
    // Optimal (by projection) once projections are in; salary is the pre-load
    // fallback (re-seeded optimally when projections arrive — see loadProjections).
    var optimal = projLoaded();
    M.state.lineupSlots = FO.autoFillSlots(rows, optimal ? projScore : null);
    M.state.lineupSeed = optimal ? "proj" : "salary";
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

  function renderHeader(v, projTotal) {
    var fillClass = v.ok ? "ok" : (v.filled > TOTAL ? "over" : "under");
    var pct = Math.min(100, Math.round((v.filled / TOTAL) * 100));
    var summary = v.ok
      ? '<strong>' + TOTAL + ' / ' + TOTAL + '</strong> starters · ready to submit'
      : '<strong>' + v.filled + ' / ' + TOTAL + '</strong> starters set';
    var offCls = v.bySide.O === FO.OFFENSE_STARTERS ? "ok" : "under";
    var defCls = v.bySide.D === FO.DEFENSE_STARTERS ? "ok" : "under";
    var projChip = (projTotal != null)
      ? '<span class="ups-m-lineup-chip proj" title="Projected points (MFL, current week)">' + fmtProj(projTotal) + ' Proj Pts</span>'
      : '';
    var chips = projChip +
      '<span class="ups-m-lineup-chip ' + offCls + '">Off ' + v.bySide.O + '/' + FO.OFFENSE_STARTERS + '</span>' +
      '<span class="ups-m-lineup-chip ' + defCls + '">Def ' + v.bySide.D + '/' + FO.DEFENSE_STARTERS + '</span>';
    var errorList = "";
    if (v.errors.length) {
      errorList = '<ul class="ups-m-lineup-errors">' +
        v.errors.map(function (e) { return '<li>' + U.escapeHtml(e) + '</li>'; }).join("") +
        '</ul>';
    }
    // Window toggle — only render buttons that produce data distinct from
    // "season" (Keith: hide the dead L3/L5 toggle until this year's weeks
    // exist). Clamp the selection if it became unavailable.
    var wins = availWindows();
    if (!wins.some(function (o) { return String(muWindow()) === o[0]; })) M.state.lineupMuWindow = 0;
    var winHtml = wins.length > 1
      ? '<span class="ups-m-mu-window" title="Window for the matchup defense rank + recent form">' +
          wins.map(function (o) { return '<button type="button" class="ups-m-win-btn' + (String(muWindow()) === o[0] ? " on" : "") + '" data-win="' + o[0] + '">' + o[1] + '</button>'; }).join("") +
        '</span>'
      : '';
    return '' +
      '<div class="ups-m-lineup-status-card">' +
        '<div class="ups-m-lineup-status-line">' + summary +
          '<span class="ups-m-lineup-chips">' + chips + '</span>' +
        '</div>' +
        '<div class="ups-m-lineup-bar"><div class="ups-m-lineup-bar-fill ' + fillClass + '" style="width:' + pct + '%"></div></div>' +
        errorList +
        '<div class="ups-m-lineup-tools">' +
          '<button type="button" class="ups-m-lineup-tool" id="ups-m-lu-autofill" title="Fill the highest-projected eligible player into every slot">⚡ Optimal</button>' +
          '<button type="button" class="ups-m-lineup-tool" id="ups-m-lu-clear">Clear all</button>' +
          winHtml +
        '</div>' +
      '</div>';
  }

  // Build the option text for a candidate inside a dropdown. Salary is
  // irrelevant for a starting lineup — show the projection + positional
  // projection rank instead (Keith 2026-06-21).
  function optText(r) {
    // Player · Team · proj · POS#rank — the rank already carries the position,
    // so the standalone position token is dropped (Keith 2026-06-21).
    var line = r.name + (r.team ? "  ·  " + r.team : "");
    var p = projFor(r.id);
    if (p != null) {
      line += "  ·  " + fmtProj(p) + " pts";
      var rk = posRankFor(r.id);
      if (rk) line += "  ·  " + rk.group + " #" + rk.rank;
    }
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
    // Highest projected first (players with no projection sort last), tie → salary.
    cands.sort(function (a, b) {
      var va = projFor(a.id), vb = projFor(b.id);
      va = va == null ? -1 : va; vb = vb == null ? -1 : vb;
      if (vb !== va) return vb - va;
      return (b.salary || 0) - (a.salary || 0);
    });

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
    var cur = current ? projFor(current) : null;
    var projCell = '<div class="ups-m-slot-proj' + (cur != null ? "" : " none") + '" title="Projected points">' + U.escapeHtml(fmtProj(cur)) + '</div>';

    return '<div class="ups-m-slot' + (filled ? " filled" : "") + '" data-slot="' + slot.id + '"' + emptyHint + '>' +
      '<div class="ups-m-slot-tag">' +
        '<span class="' + labelCls + '">' + U.escapeHtml(slot.label) + '</span>' + note +
      '</div>' +
      '<select class="' + selCls + '" data-slot="' + U.escapeHtml(slot.id) + '">' + opts + '</select>' +
      projCell +
    '</div>' + (current ? slotMatchupHtml(current) : "");
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
        M.state.lineupSeed = "user";
        renderRoute();
      });
    }
    var af = document.getElementById("ups-m-lu-autofill");
    if (af) af.addEventListener("click", function () {
      M.state.lineupSlots = FO.autoFillSlots(rows, projLoaded() ? projScore : null);
      M.state.lineupSeed = projLoaded() ? "proj" : "user";
      M.state.lineupMessage = null;
      renderRoute();
    });
    var clr = document.getElementById("ups-m-lu-clear");
    if (clr) clr.addEventListener("click", function () {
      M.state.lineupSlots = {};
      M.state.lineupSeed = "user";
      M.state.lineupMessage = null;
      renderRoute();
    });
    var submit = document.getElementById("ups-m-lineup-submit");
    if (submit) submit.addEventListener("click", function () { handleSubmit(); });
    var benchT = document.getElementById("ups-m-bench-toggle");
    if (benchT) benchT.addEventListener("click", function () { M.state.lineupShowBench = !M.state.lineupShowBench; renderRoute(); });
    var winBtns = mount.querySelectorAll(".ups-m-win-btn");
    for (var w = 0; w < winBtns.length; w++) {
      winBtns[w].addEventListener("click", (function (el) {
        return function () { M.state.lineupMuWindow = parseInt(el.getAttribute("data-win"), 10) || 0; renderRoute(); };
      })(winBtns[w]));
    }
    var muLines = mount.querySelectorAll(".ups-m-slot-mu[data-mu-pid]");
    for (var mi = 0; mi < muLines.length; mi++) {
      muLines[mi].addEventListener("click", (function (el) {
        return function () { var p = el.getAttribute("data-mu-pid"); M.state.lineupMuExpand = (M.state.lineupMuExpand === p) ? null : p; renderRoute(); };
      })(muLines[mi]));
    }
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

  // Bench (toggle) — every other active-roster player by position + projection,
  // with the same matchup intel, so you can see everyone laid out.
  var BENCH_ORDER = { QB: 0, RB: 1, WR: 2, TE: 3, PK: 4, PN: 5, DL: 6, LB: 7, DB: 8, OTH: 9 };
  function renderBench(rows, used) {
    var bench = rows.filter(function (r) { return !used[r.id]; }).sort(function (a, b) {
      var ga = BENCH_ORDER[a.group] == null ? 9 : BENCH_ORDER[a.group], gb = BENCH_ORDER[b.group] == null ? 9 : BENCH_ORDER[b.group];
      if (ga !== gb) return ga - gb;
      var pa = projFor(a.id), pb = projFor(b.id); pa = pa == null ? -1 : pa; pb = pb == null ? -1 : pb;
      return pb - pa;
    });
    var show = !!M.state.lineupShowBench;
    var head = '<div class="ups-m-bench-head"><button type="button" class="ups-m-bench-toggle" id="ups-m-bench-toggle">' + (show ? "▾" : "▸") + ' Bench &amp; matchups (' + bench.length + ')</button></div>';
    if (!show) return head;
    var body = bench.length ? bench.map(function (r) {
      return '<div class="ups-m-bench-row"><div class="ups-m-bench-id"><span class="nm">' + U.escapeHtml(r.name) + '</span>' +
        '<span class="meta">' + U.escapeHtml(r.pos || "—") + ' · ' + U.escapeHtml(r.team || "—") + '</span></div>' +
        '<div class="ups-m-bench-proj">' + U.escapeHtml(fmtProj(projFor(r.id))) + '</div></div>' + slotMatchupHtml(r.id);
    }).join("") : '<div class="ups-m-bench-empty">No bench players.</div>';
    return head + '<div class="ups-m-bench">' + body + '</div>';
  }
  function render(mount) {
    var rows = buildRows();
    if (!rows.length) {
      mount.innerHTML = subTabs("lineup") +
        '<div class="ups-m-stub"><div>No roster found.</div></div>';
      return;
    }
    loadProjections();   // lazy fetch; re-renders when projections arrive
    loadMatchups();      // lazy: opponent/kickoff/spread + adjusted def rank
    var draft = ensureDraft(rows);
    var byId = rowsById(rows);
    var v = FO.validateSlots(draft, byId);
    var submitting = !!M.state.lineupSubmitting;

    // Players already used (so each dropdown can exclude them).
    var used = {};
    SLOTS.forEach(function (s) { if (draft[s.id]) used[draft[s.id]] = 1; });

    // Sum projected points across filled slots (null until any projection loads).
    var projTotal = null;
    SLOTS.forEach(function (s) {
      var p = draft[s.id] ? projFor(draft[s.id]) : null;
      if (p != null) projTotal = (projTotal || 0) + p;
    });

    var html = subTabs("lineup");
    html += renderMessage();
    html += renderHeader(v, projTotal);
    html += renderSection("O", "Offense", FO.OFFENSE_STARTERS, rows, draft, used);
    html += renderSection("D", "Defense", FO.DEFENSE_STARTERS, rows, draft, used);
    html += renderBench(rows, used);
    html += renderFooter(v, submitting);
    mount.innerHTML = html;
    bind(mount, rows);
  }

  M.lineupView = { render: render };
})();
