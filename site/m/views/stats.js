/* Player Stats (#league/stats) — mobile advanced-stats leaderboard.
   A focused port of the desktop Stats Workbench: position tabs + a curated set
   of per-position columns + search, tap a player → the shared player sheet.
   Read-only (Phase 1; column toggles / filters / heat-map are desktop-only).

   Data: /api/advanced-stats-leaderboard (raw rows), fetched per pos-alias +
   season and cached. Rank is computed within the IDP/offense GROUP (DL/LB/DB/…)
   by MFL PPG — the same basis as the desktop "Pos Rk" column and the player
   sheet's PPG-Rk, so all three agree. Positions display in MFL's vocabulary
   (OLB/ILB/MLB → LB, FS/SS → S) per Keith 2026-06-20. */
(function () {
  "use strict";
  if (!window.UPS_MOBILE) return;
  var M = window.UPS_MOBILE;
  var U = M.util, API = M.api;

  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function nn(v) { return (v == null || v === "" || isNaN(Number(v))) ? null : Number(v); }

  // nflverse position → MFL's set (DT|DE|LB|CB|S). "we simply use LB."
  function mflPos(raw) {
    var p = String(raw || "").toUpperCase();
    if (p === "ILB" || p === "MLB" || p === "OLB" || p === "LB") return "LB";
    if (p === "FS" || p === "SS" || p === "S") return "S";
    if (p === "NT") return "DT";
    return p;
  }

  // Curated columns. g(r) → value | null; f: dec1 | pct (else integer).
  var C = {
    ppg:   { l: "PPG",   g: function (r) { return nn(r.mfl_ppg); }, f: "dec1" },
    pts:   { l: "Pts",   g: function (r) { return nn(r.mfl_points); }, f: "dec1" },
    payd:  { l: "PaYd",  g: function (r) { return nn(r.pass_yds); } },
    patd:  { l: "PaTD",  g: function (r) { return nn(r.pass_tds); } },
    patt:  { l: "Att",   g: function (r) { return nn(r.pass_att); } },
    cmppct:{ l: "Cmp%",  g: function (r) { return r.pass_att ? num(r.pass_cmp) / num(r.pass_att) : null; }, f: "pct" },
    pint:  { l: "Int",   g: function (r) { return nn(r.pass_ints); } },
    qbsk:  { l: "Sk",    g: function (r) { return nn(r.pass_sacks); } },
    ya:    { l: "Y/A",   g: function (r) { return r.pass_att ? num(r.pass_yds) / num(r.pass_att) : null; }, f: "dec1" },
    ruatt: { l: "Att",   g: function (r) { return nn(r.rush_att); } },
    ruyd:  { l: "RuYd",  g: function (r) { return nn(r.rush_yds); } },
    rutd:  { l: "RuTD",  g: function (r) { return nn(r.rush_tds); } },
    rya:   { l: "Y/A",   g: function (r) { return r.rush_att ? num(r.rush_yds) / num(r.rush_att) : null; }, f: "dec1" },
    tgt:   { l: "Tgt",   g: function (r) { return nn(r.targets); } },
    rec:   { l: "Rec",   g: function (r) { return nn(r.receptions); } },
    recyd: { l: "RecYd", g: function (r) { return nn(r.rec_yds); } },
    rectd: { l: "RecTD", g: function (r) { return nn(r.rec_tds); } },
    ypr:   { l: "Y/R",   g: function (r) { return r.receptions ? num(r.rec_yds) / num(r.receptions) : null; }, f: "dec1" },
    catchpct: { l: "Catch%", g: function (r) { return r.targets ? num(r.receptions) / num(r.targets) : null; }, f: "pct" },
    tgtsh: { l: "Tgt%",  g: function (r) { return nn(r.target_share); }, f: "pct" },
    tkl:   { l: "Tkl",   g: function (r) { return nn(r.def_tackles_total); } },  // solo
    ast:   { l: "Ast",   g: function (r) { return nn(r.def_tackles_ast); } },
    sk:    { l: "Sk",    g: function (r) { return nn(r.def_sacks); }, f: "dec1" },
    tfl:   { l: "TFL",   g: function (r) { return nn(r.def_tfl); } },
    pd:    { l: "PD",    g: function (r) { return nn(r.def_pass_def); } },
    intd:  { l: "INT",   g: function (r) { return nn(r.def_ints); } },
    ff:    { l: "FF",    g: function (r) { return nn(r.def_ff); } },
    press: { l: "Press", g: function (r) { return nn(r.def_pressures); } },
    deftd: { l: "DefTD", g: function (r) { return nn(r.def_tds); } },
    fgm:   { l: "FGM",   g: function (r) { return nn(r.fg_made); } },
    fgpct: { l: "FG%",   g: function (r) { return r.fg_att ? num(r.fg_made) / num(r.fg_att) : null; }, f: "pct" },
    xpm:   { l: "XPM",   g: function (r) { return nn(r.xp_made); } },
    punts: { l: "Punts", g: function (r) { return nn(r.punts); } },
    navg:  { l: "NetAvg",g: function (r) { return nn(r.punt_net_avg); }, f: "dec1" },
    i20:   { l: "I20",   g: function (r) { return nn(r.punt_inside20); } }
  };

  // Each tab: alias (worker pos param), group (pos_group values to keep), and
  // one-or-more named column SETS. The first set is the default; a dropdown
  // switches between them so the owner can pull up other advanced stats without
  // crowding the (phone-width) table. PN shares the punter alias's PK group.
  var TABS = [
    { id: "QB", alias: "qb",     group: ["QB"], sets: [
      { l: "Passing",   cols: ["payd", "patd", "pint", "ya", "ppg"] },
      { l: "Volume",    cols: ["patt", "cmppct", "qbsk", "payd", "ppg"] },
      { l: "Rushing",   cols: ["ruatt", "ruyd", "rutd", "rya", "ppg"] } ] },
    { id: "RB", alias: "skill",  group: ["RB"], sets: [
      { l: "Rushing",   cols: ["ruatt", "ruyd", "rutd", "rya", "ppg"] },
      { l: "Receiving", cols: ["tgt", "rec", "recyd", "rectd", "ppg"] } ] },
    { id: "WR", alias: "skill",  group: ["WR"], sets: [
      { l: "Receiving", cols: ["rec", "recyd", "rectd", "tgtsh", "ppg"] },
      { l: "Efficiency",cols: ["tgt", "catchpct", "ypr", "recyd", "ppg"] } ] },
    { id: "TE", alias: "skill",  group: ["TE"], sets: [
      { l: "Receiving", cols: ["rec", "recyd", "rectd", "tgtsh", "ppg"] },
      { l: "Efficiency",cols: ["tgt", "catchpct", "ypr", "recyd", "ppg"] } ] },
    { id: "DL", alias: "idp",    group: ["DL"], sets: [
      { l: "Tackles",   cols: ["tkl", "ast", "tfl", "ppg"] },
      { l: "Pass rush", cols: ["sk", "press", "tfl", "ppg"] } ] },
    { id: "LB", alias: "idp",    group: ["LB"], sets: [
      { l: "Tackles",   cols: ["tkl", "ast", "tfl", "ppg"] },
      { l: "Pass rush", cols: ["sk", "press", "intd", "ppg"] },
      { l: "Coverage",  cols: ["pd", "intd", "deftd", "ppg"] } ] },
    { id: "DB", alias: "idp",    group: ["DB"], sets: [
      { l: "Coverage",  cols: ["tkl", "intd", "pd", "ppg"] },
      { l: "Tackles",   cols: ["tkl", "ast", "tfl", "ppg"] } ] },
    { id: "PK", alias: "kicker", group: ["PK"], sets: [
      { l: "Kicking",   cols: ["fgm", "fgpct", "xpm", "ppg"] } ] },
    { id: "PN", alias: "punter", group: ["PK", "PN"], sets: [
      { l: "Punting",   cols: ["punts", "navg", "i20", "ppg"] } ] }
  ];

  // scope: "all" | "ros" (rostered) | "fa" (free agents) — Keith 2026-06-20.
  var view = { tab: "QB", q: "", scope: "all", set: 0, debounce: null };
  var cache = {};   // alias|season → ranked raw rows
  var season = 0;

  function curSeason() {
    if (season) return season;
    var ly = (M.data.getAdvancedStatsLatestYear && M.data.getAdvancedStatsLatestYear()) || 0;
    season = ly || (new Date().getUTCFullYear() - 1);
    return season;
  }
  function curTab() {
    for (var i = 0; i < TABS.length; i++) if (TABS[i].id === view.tab) return TABS[i];
    return TABS[0];
  }
  function curSet() {
    var t = curTab();
    return t.sets[view.set] || t.sets[0];
  }
  // Player's CURRENT NFL team (the leaderboard `team` is season-stamped). Fall
  // back to the season team if the player isn't in the boot-loaded DB.
  function curTeam(r) {
    var p = M.data.playerById ? M.data.playerById(r.mfl_pid) : null;
    return U.safeStr((p && p.team) || r.team || "");
  }

  // Rank within pos_group by MFL PPG (mirrors app.js buildLeaderboardMap).
  function rankByGroup(rows) {
    var b = {};
    rows.forEach(function (r) {
      var p = String(r.pos_group || r.position || "").toUpperCase();
      (b[p] = b[p] || []).push(r);
    });
    Object.keys(b).forEach(function (p) {
      b[p].slice().sort(function (x, y) { return num(y.mfl_ppg) - num(x.mfl_ppg); })
        .forEach(function (r, i) { r.__rk = i + 1; });
    });
    return rows;
  }

  function load(alias, yr) {
    var key = alias + "|" + yr;
    if (cache[key]) return Promise.resolve(cache[key]);
    var url = API.workerUrl("/api/advanced-stats-leaderboard?season=" + encodeURIComponent(yr) +
      "&pos=" + encodeURIComponent(alias) + "&min_games=1");
    return fetch(url, { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : { rows: [] }; })
      .then(function (j) { var rows = rankByGroup((j && j.rows) || []); cache[key] = rows; return rows; })
      .catch(function () { cache[key] = []; return []; });
  }

  // League sub-tab bar (same pattern as league.js/auction.js, with Stats).
  function subTabs(active) {
    function tab(href, label, key) {
      return '<a class="ups-m-subtab' + (key === active ? " active" : "") +
        '" href="#league/' + href + '">' + label + "</a>";
    }
    return '<div class="ups-m-subtabs">' +
      tab("standings", "Standings", "standings") +
      tab("rosters", "Rosters", "rosters") +
      tab("trade", "Trade", "trade") +
      tab("otb", "On the Block", "otb") +
      tab("draft", "Draft", "draft") +
      tab("auction", "Auction", "auction") +
      tab("stats", "Stats", "stats") +
      "</div>";
  }

  function fmt(v, c) {
    if (v == null) return "—";
    if (c.f === "pct") return Math.round(v * 100) + "%";
    if (c.f === "dec1") return v.toFixed(1);
    return String(Math.round(v));
  }
  function flip(raw) {
    raw = U.safeStr(raw);
    if (raw.indexOf(",") >= 0) { var p = raw.split(","); return ((p[1] || "").trim() + " " + (p[0] || "").trim()).trim(); }
    return raw;
  }

  function rowsFor(tab) {
    var all = cache[tab.alias + "|" + curSeason()] || [];
    var q = view.q.trim().toLowerCase();
    return all.filter(function (r) {
      if (tab.group.indexOf(String(r.pos_group || "").toUpperCase()) === -1) return false;
      // FA vs rostered scope (the leaderboard row carries mfl_franchise_id).
      if (view.scope === "ros" && !r.mfl_franchise_id) return false;
      if (view.scope === "fa" && r.mfl_franchise_id) return false;
      if (q) {
        var hay = (String(r.player_name || "") + " " + curTeam(r) + " " + mflPos(r.position) +
                   " " + String(r.mfl_franchise_name || "")).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    }).sort(function (a, b) { return num(b.mfl_ppg) - num(a.mfl_ppg); });
  }

  function renderList(tab) {
    var rows = rowsFor(tab);
    if (!rows.length) return '<div class="ups-m-stub"><div>No ' + tab.id + " " +
      (view.scope === "fa" ? "free agents" : view.scope === "ros" ? "rostered players" : "data") +
      " for " + curSeason() + ".</div></div>";
    var cols = curSet().cols.map(function (k) { return C[k]; });
    var capped = rows.slice(0, 150);
    var head = '<div class="ups-m-st-row head" style="--n:' + cols.length + '">' +
      '<span class="rk">#</span><span class="nm">Player</span>' +
      cols.map(function (c) { return '<span class="v">' + U.escapeHtml(c.l) + "</span>"; }).join("") + "</div>";
    var body = capped.map(function (r) {
      var ownTag = r.mfl_franchise_id
        ? '<span class="own"> · ' + U.escapeHtml(String(r.mfl_franchise_name || "Rostered")) + "</span>"
        : '<span class="own fa"> · FA</span>';
      return '<div class="ups-m-st-row" data-pid="' + U.escapeHtml(String(r.mfl_pid || "")) + '" style="--n:' + cols.length + '">' +
        '<span class="rk">' + (r.__rk || "") + "</span>" +
        '<span class="nm"><span class="pos ' + String(r.pos_group || "").toLowerCase() + '">' + U.escapeHtml(mflPos(r.position)) + "</span>" +
          '<span class="t"><span class="pn">' + U.escapeHtml(flip(r.player_name)) + "</span>" +
          '<span class="tm">' + U.escapeHtml(curTeam(r)) + ownTag + "</span></span></span>" +
        cols.map(function (c) { return '<span class="v">' + fmt(c.g(r), c) + "</span>"; }).join("") +
      "</div>";
    }).join("");
    var more = rows.length > capped.length
      ? '<div class="ups-m-fa-more">Top ' + capped.length + " of " + rows.length + " — search to narrow.</div>" : "";
    return '<div class="ups-m-st-scroll"><div class="ups-m-st-table">' + head + body + "</div></div>" + more;
  }

  function toolbar() {
    var chips = TABS.map(function (t) {
      return '<button class="ups-m-pos-chip' + (view.tab === t.id ? " on" : "") + '" data-tab="' + t.id + '">' + t.id + "</button>";
    }).join("");
    var scopeSel = '<select class="ups-m-players-filter" id="ups-m-st-scope" aria-label="Filter by roster status">' +
      '<option value="all"' + (view.scope === "all" ? " selected" : "") + ">All players</option>" +
      '<option value="ros"' + (view.scope === "ros" ? " selected" : "") + ">Rostered</option>" +
      '<option value="fa"'  + (view.scope === "fa"  ? " selected" : "") + ">Free agents</option>" +
    "</select>";
    // Column-set dropdown — only when the position offers more than one set.
    var sets = curTab().sets;
    var setSel = sets.length > 1
      ? '<select class="ups-m-players-filter" id="ups-m-st-set" aria-label="Stat columns">' +
          sets.map(function (s, i) { return '<option value="' + i + '"' + (view.set === i ? " selected" : "") + ">" + U.escapeHtml(s.l) + "</option>"; }).join("") +
        "</select>"
      : "";
    return '<div class="ups-m-players-toolbar">' +
      '<div class="ups-m-auc-sec-head">Player Stats <span class="ct">' + curSeason() + " · advanced (nflverse)</span></div>" +
      '<input type="search" class="ups-m-players-search" id="ups-m-st-search" placeholder="Search name, team, owner…" autocomplete="off" autocorrect="off" value="' + U.escapeHtml(view.q) + '" />' +
      '<div class="ups-m-st-filters">' + scopeSel + setSel + "</div>" +
      '<div class="ups-m-pos-chips">' + chips + "</div>" +
    "</div>";
  }

  function bindToolbar(mount) {
    var s = document.getElementById("ups-m-st-search");
    if (s) s.addEventListener("input", function (e) {
      var val = e.target.value;
      clearTimeout(view.debounce);
      view.debounce = setTimeout(function () {
        view.q = val;
        M.route.renderRoute();
        var s2 = document.getElementById("ups-m-st-search");
        if (s2) { s2.focus(); try { s2.setSelectionRange(val.length, val.length); } catch (e2) {} }
      }, 220);
    });
    var chips = mount.querySelectorAll(".ups-m-pos-chip");
    for (var i = 0; i < chips.length; i++) chips[i].addEventListener("click", function () {
      view.tab = this.getAttribute("data-tab");
      view.q = "";
      view.set = 0;   // each position defaults to its first column set
      M.route.renderRoute();
    });
    var scope = document.getElementById("ups-m-st-scope");
    if (scope) scope.addEventListener("change", function () { view.scope = this.value; M.route.renderRoute(); });
    var setSel = document.getElementById("ups-m-st-set");
    if (setSel) setSel.addEventListener("change", function () { view.set = parseInt(this.value, 10) || 0; M.route.renderRoute(); });
  }

  function bind(mount) {
    bindToolbar(mount);
    var rows = mount.querySelectorAll(".ups-m-st-row[data-pid]");
    for (var k = 0; k < rows.length; k++) rows[k].addEventListener("click", function () {
      var pid = this.getAttribute("data-pid");
      if (pid && M.sheet) M.sheet.open(pid);
    });
  }

  function paint(mount) {
    mount.innerHTML = subTabs("stats") + toolbar() + renderList(curTab());
    bind(mount);
  }

  function render(mount) {
    var tab = curTab();
    if (cache[tab.alias + "|" + curSeason()]) { paint(mount); return; }
    mount.innerHTML = subTabs("stats") + toolbar() + '<div class="ups-m-loading">Loading stats…</div>';
    bindToolbar(mount);
    load(tab.alias, curSeason()).then(function () { if (view.tab === tab.id) paint(mount); });
  }

  M.statsView = { render: render };
  M.route.registerView("stats", render);
})();
