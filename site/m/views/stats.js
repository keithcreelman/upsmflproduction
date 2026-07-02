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
    i20:   { l: "I20",   g: function (r) { return nn(r.punt_inside20); } },
    sospts:{ l: "SoSΔ",  g: function (r) { var s = sosRec(r); return (s && s.sos != null && s.raw != null) ? Math.round((s.sos - s.raw) * 10) / 10 : null; }, f: "delta" },
    cfloor:{ l: "Floor", g: function (r) { var c = consRec(r); return c && c.floor != null ? c.floor : null; }, f: "dec1" },
    cceil: { l: "Ceil",  g: function (r) { var c = consRec(r); return c && c.ceil != null ? c.ceil : null; }, f: "dec1" },
    ccons: { l: "Consist", g: function (r) { var c = consRec(r); return c && c.consistency != null ? c.consistency : null; } },
    cboom: { l: "Boom%", g: function (r) { var c = consRec(r); return c && c.boom_pct != null ? c.boom_pct : null; } },
    cbust: { l: "Bust%", g: function (r) { var c = consRec(r); return c && c.bust_pct != null ? c.bust_pct : null; } },
    eepa:  { l: "EPA",   g: function (r) { var x = epaRecM(r); return x && x.epa != null ? x.epa : null; }, f: "epa" },
    ecpoe: { l: "CPOE",  g: function (r) { return epaCpoe(r); }, f: "delta" },
    esucc: { l: "Succ%", g: function (r) { var x = epaRecM(r); return x && x.succ != null ? x.succ : null; }, f: "pct100" },
    evol:  { l: "EPA n", g: function (r) { var x = epaRawM(r); return x ? (x.plays != null ? x.plays : x.tgt) : null; } },
    // Market (MFL) — MFL-wide market signals by mfl_pid (/api/mfl-market; mirrors desktop).
    mown:  { l: "Own%",  g: function (r) { var m = mktRec(r); return m && m.own != null ? m.own : null; }, f: "pct100" },
    mstart:{ l: "Start%",g: function (r) { var m = mktRec(r); return m && m.start != null ? m.start : null; }, f: "pct100" },
    madd:  { l: "Add%",  g: function (r) { var m = mktRec(r); return m && m.add != null ? m.add : null; }, f: "pct100" },
    mdrop: { l: "Cut%",  g: function (r) { var m = mktRec(r); return m && m.drop != null ? m.drop : null; }, f: "pct100" },
    mrank: { l: "XpertRk", g: function (r) { var m = mktRec(r); return m && m.rank != null ? m.rank : null; } },
    // Routes + NGS (2016+) — /api/player-routes + /api/player-ngs (mirrors desktop).
    rtn:   { l: "Routes", g: function (r) { var x = rtRec(r); return x && x.routes ? x.routes : null; } },
    rtpct: { l: "Route%", g: function (r) { var x = rtRec(r); return x && x.route_pct != null ? x.route_pct : null; }, f: "pct100" },
    tprr:  { l: "TPRR",  g: function (r) { var x = rtRec(r); return x && x.tprr != null ? x.tprr : null; }, f: "dec2" },
    yprr:  { l: "YPRR",  g: function (r) { var x = rtRec(r); return x && x.yprr != null ? x.yprr : null; }, f: "dec2" },
    nsep:  { l: "Sep",   g: function (r) { var x = ngsRecMob(r); return x && x.rec ? x.rec.sep : null; }, f: "dec2" },
    nryoe: { l: "RYOE/A", g: function (r) { var x = ngsRecMob(r); return x && x.rush ? x.rush.ryoe_pa : null; }, f: "delta" },
    ntt:   { l: "TmToThrw", g: function (r) { var x = ngsRecMob(r); return x && x.pass ? x.pass.tt : null; }, f: "dec2" },
    nagg:  { l: "AGG%",  g: function (r) { var x = ngsRecMob(r); return x && x.pass ? x.pass.agg : null; }, f: "pct100" }
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
  // SoS set — every position (raw Pts · SoS delta · PPG). (ADP + Team Pace moved
  // to their own Stats sub-tabs.)
  TABS.forEach(function (t) { t.sets.push({ l: "SoS", cols: ["pts", "sospts", "ppg"] }); });
  // Boom/Bust set — every position (consistency + boom% + bust%).
  TABS.forEach(function (t) { t.sets.push({ l: "Boom/Bust", cols: ["ccons", "cboom", "cbust"] }); });
  // Efficiency (EPA) set — skill positions only; QB gets CPOE (nflfastR).
  TABS.forEach(function (t) {
    if (t.id === "QB") t.sets.push({ l: "EPA", cols: ["eepa", "ecpoe", "esucc", "evol"] });
    else if (t.id === "RB" || t.id === "WR" || t.id === "TE") t.sets.push({ l: "EPA", cols: ["eepa", "esucc", "evol"] });
  });
  // Market (MFL) set — every position (MFL-wide own/start/add/cut % + expert rank).
  TABS.forEach(function (t) { t.sets.push({ l: "Market", cols: ["mown", "mstart", "madd", "mdrop", "mrank"] }); });
  // Routes/NGS sets (2016+) — WR/TE/RB get routes; RB adds RYOE; QB gets NGS passing.
  TABS.forEach(function (t) {
    if (t.id === "WR" || t.id === "TE") t.sets.push({ l: "Routes", cols: ["rtn", "rtpct", "tprr", "yprr", "nsep"] });
    else if (t.id === "RB") t.sets.push({ l: "Routes", cols: ["rtn", "tprr", "yprr", "nryoe"] });
    else if (t.id === "QB") t.sets.push({ l: "NGS", cols: ["ntt", "nagg", "ppg"] });
  });

  // scope: "all" | "ros" (rostered) | "fa" (free agents) — Keith 2026-06-20.
  // inner: "players" (the leaderboard) | "fpa" (Fantasy Points Against).
  var view = { tab: "QB", q: "", scope: "all", set: 0, debounce: null, inner: "players" };
  var cache = {};   // alias|season → ranked raw rows
  var season = 0;

  // SoS-adjusted MFL points keyed by gsis_id — side-loaded per season (MFL Total
  // wks 1-17, matching the leaderboard's default), read by the "SoS" set.
  var sosMap = null, sosSeason = 0;
  function loadSos(yr) {
    if (sosMap && sosSeason === yr) return Promise.resolve(sosMap);
    sosSeason = yr;
    return fetch(API.workerUrl("/api/sos-adjusted-points?seasons=" + encodeURIComponent(yr) + "&week_min=1&week_max=17"),
        { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { sosMap = (j && j.by_gsis) || {}; return sosMap; })
      .catch(function () { sosMap = {}; return sosMap; });
  }
  function sosRec(r) { return (sosMap && sosMap[String(r.gsis_id)]) || null; }
  // Consistency / boom-bust by gsis_id — side-loaded per season, read by the "Boom/Bust" set.
  var consMap = null, consSeason = 0;
  function loadCons(yr) {
    if (consMap && consSeason === yr) return Promise.resolve(consMap);
    consSeason = yr;
    return fetch(API.workerUrl("/api/player-consistency?seasons=" + encodeURIComponent(yr) + "&week_min=1&week_max=17"),
        { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { consMap = (j && j.by_gsis) || {}; return consMap; })
      .catch(function () { consMap = {}; return consMap; });
  }
  function consRec(r) { return (consMap && consMap[String(r.gsis_id)]) || null; }

  // EPA / efficiency (nflfastR), single-season for mobile. Rate stats gated to a
  // qualified sample (the raw "EPA n" stays visible) so scrubs don't top a sort.
  var epaMap = null, epaSeason = 0;
  function loadEpa(yr) {
    if (epaMap && epaSeason === yr) return Promise.resolve(epaMap);
    epaSeason = yr;
    return fetch(API.workerUrl("/api/player-epa?seasons=" + encodeURIComponent(yr)), { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { epaMap = (j && j.by_gsis) || {}; return epaMap; })
      .catch(function () { epaMap = {}; return epaMap; });
  }
  function epaRawM(r) { var e = epaMap && epaMap[String(r.gsis_id)]; if (!e) return null; var pg = String(r.pos_group || r.position || "").toUpperCase(); if (pg === "QB") return e.pass; if (pg === "RB") return e.rush; return e.rec; }
  function epaRecM(r) { var x = epaRawM(r); if (!x) return null; var pg = String(r.pos_group || r.position || "").toUpperCase(); var n = (x.plays != null ? x.plays : x.tgt) || 0; var min = pg === "QB" ? 50 : (pg === "RB" ? 25 : 20); return n >= min ? x : null; }
  function epaCpoe(r) { var e = epaMap && epaMap[String(r.gsis_id)]; return (e && e.pass && e.pass.plays >= 50 && e.pass.cpoe != null) ? e.pass.cpoe : null; }

  // MFL-wide market signals by MFL player id — season-independent current
  // snapshot (own/start/add/cut % + expert rank), read by the "Market" set.
  var mktMap = null;
  function loadMarket() {
    if (mktMap) return Promise.resolve(mktMap);
    return fetch(API.workerUrl("/api/mfl-market?YEAR=" + new Date().getUTCFullYear()), { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { mktMap = (j && j.by_mfl) || {}; return mktMap; })
      .catch(function () { mktMap = {}; return mktMap; });
  }
  function mktRec(r) { return (mktMap && mktMap[String(r.mfl_pid)]) || null; }

  // Routes + NGS by gsis_id — per season (2016+), read by the "Routes"/"NGS" sets.
  var rtMap = null, rtSeason = 0, ngsMap = null, ngsSeason = 0;
  function loadRoutes(yr) {
    if (rtMap && rtSeason === yr) return Promise.resolve(rtMap);
    rtSeason = yr;
    return fetch(API.workerUrl("/api/player-routes?seasons=" + encodeURIComponent(yr)), { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { rtMap = (j && j.by_gsis) || {}; return rtMap; })
      .catch(function () { rtMap = {}; return rtMap; });
  }
  function loadNgs(yr) {
    if (ngsMap && ngsSeason === yr) return Promise.resolve(ngsMap);
    ngsSeason = yr;
    return fetch(API.workerUrl("/api/player-ngs?seasons=" + encodeURIComponent(yr)), { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { ngsMap = (j && j.by_gsis) || {}; return ngsMap; })
      .catch(function () { ngsMap = {}; return ngsMap; });
  }
  function rtRec(r) { return (rtMap && rtMap[String(r.gsis_id)]) || null; }
  function ngsRecMob(r) { return (ngsMap && ngsMap[String(r.gsis_id)]) || null; }

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
  // Player's CURRENT NFL team. Prefer the worker's current_team (from
  // src_players, so desktop + mobile match), then the boot-loaded player DB,
  // then the season-stamped leaderboard team as a last resort.
  function curTeam(r) {
    if (r.current_team) return U.safeStr(r.current_team);
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
    if (c.f === "trend") { if (v === 0) return "0"; return '<span class="ups-m-tr ' + (v > 0 ? "up" : "dn") + '">' + (v > 0 ? "▲" : "▼") + Math.abs(v) + "</span>"; }
    if (c.f === "delta") { if (v === 0) return "0"; return '<span class="ups-m-tr ' + (v > 0 ? "up" : "dn") + '">' + (v > 0 ? "+" : "") + v.toFixed(1) + "</span>"; }
    if (c.f === "epa") { return '<span class="ups-m-tr ' + (v > 0 ? "up" : (v < 0 ? "dn" : "")) + '">' + (v > 0 ? "+" : "") + v.toFixed(3) + "</span>"; }
    if (c.f === "pct100") return Math.round(v) + "%";
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

  // ── Fantasy Points Against (inner view of the Stats sub-tab) ──
  // RAW points a defense allows to a position (per game) + opponent-ADJUSTED
  // rating, from /api/fantasy-points-against. One fetch per (year, week-range)
  // covers all 9 groups; position chips filter client-side.
  var POS_FPA = [["QB", "QB"], ["RB", "RB"], ["WR", "WR"], ["TE", "TE"], ["DL", "DL"], ["LB", "LB"], ["DB", "DB"], ["PK", "K"], ["PN", "P"]];
  var fpa = { year: 0, pos: "RB", wkMin: 1, wkMax: 18, sort: "rank", dir: 1, cache: {}, years: null, _fb: false, detailTeam: null, detailWeek: null, detailCache: {} };
  function fpaYear() { return String(fpa.year || curSeason()); }
  function fpaKey() { return fpaYear() + ":" + fpa.wkMin + "-" + fpa.wkMax; }
  function fpaPosLbl() { return (POS_FPA.filter(function (p) { return p[0] === fpa.pos; })[0] || ["", ""])[1] || fpa.pos; }
  function fpaDetailKey() { return fpaKey() + "|" + fpa.pos + "|" + fpa.detailTeam; }
  function loadFpaDetail() {
    var dk = fpaDetailKey();
    if (fpa.detailCache[dk]) return Promise.resolve(fpa.detailCache[dk]);
    return fetch(API.workerUrl("/api/fpa-detail?YEAR=" + encodeURIComponent(fpaYear()) + "&team=" + encodeURIComponent(fpa.detailTeam) + "&pos=" + encodeURIComponent(fpa.pos) + "&week_min=" + fpa.wkMin + "&week_max=" + fpa.wkMax), { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.json(); })
      .then(function (d) { fpa.detailCache[dk] = (d && d.ok) ? d : { weeks: [] }; return fpa.detailCache[dk]; })
      .catch(function () { fpa.detailCache[dk] = { weeks: [], err: 1 }; return fpa.detailCache[dk]; });
  }

  function loadFpaYears() {
    if (fpa.years) return Promise.resolve(fpa.years);
    return fetch(API.workerUrl("/api/league-years"), { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var ys = [];
        ((d && d.years) || []).forEach(function (y) { if (y && y.season && parseInt(y.season, 10) >= 2017) ys.push(String(y.season)); });
        ys.sort().reverse();
        if (!ys.length) { for (var y = new Date().getUTCFullYear(); y >= 2017; y--) ys.push(String(y)); }
        fpa.years = ys; return ys;
      })
      .catch(function () { var z = []; for (var y = new Date().getUTCFullYear(); y >= 2017; y--) z.push(String(y)); fpa.years = z; return z; });
  }
  function loadFpa() {
    var k = fpaKey();
    if (fpa.cache[k]) return Promise.resolve(fpa.cache[k]);
    return fetch(API.workerUrl("/api/fantasy-points-against?YEAR=" + encodeURIComponent(fpaYear()) + "&week_min=" + fpa.wkMin + "&week_max=" + fpa.wkMax), { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.json(); })
      .then(function (d) { fpa.cache[k] = (d && d.ok) ? d : { teams: {}, weeksUsed: [] }; return fpa.cache[k]; })
      .catch(function () { fpa.cache[k] = { teams: {}, weeksUsed: [], err: 1 }; return fpa.cache[k]; });
  }
  function fpaRkCls(rank, of) { if (rank == null) return "mid"; if (rank <= 10) return "easy"; if (rank > of - 10) return "tough"; return "mid"; }

  function innerSwitch() {
    function b(key, label) { return '<button class="ups-m-stseg' + (view.inner === key ? " on" : "") + '" data-inner="' + key + '">' + label + "</button>"; }
    return '<div class="ups-m-stseg-bar six">' + b("players", "Players") + b("fpa", "Pts Agst") + b("adp", "ADP") + b("vegas", "Vegas") + b("pace", "Pace") + b("sched", "Sched") + "</div>";
  }
  // ── Vegas board (Stats → Vegas inner tab) — implied team points + O/U ──
  var vg = { year: 0, week: 0, data: null, weeks: [], _fb: false };
  function vgYear() { return String(vg.year || new Date().getUTCFullYear()); }   // upcoming season's lines (matches desktop)
  function loadVegas() {
    return fetch(API.workerUrl("/api/vegas?YEAR=" + encodeURIComponent(vgYear()) + (vg.week ? "&W=" + vg.week : "")), { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if ((!d || !(d.teams || []).length) && !vg._fb) {   // no lines yet → prior season once
          vg._fb = true; vg.year = String((parseInt(vgYear(), 10) || 0) - 1); vg.week = 0; return loadVegas();
        }
        vg.data = d || {}; vg.weeks = (d && d.weeksWithLines) || []; vg.week = (d && d.week) || vg.week; return vg.data;
      })
      .catch(function () { vg.data = { teams: [], games: [] }; return vg.data; });
  }
  function vegasToolbar() {
    var wkOpts = (vg.weeks || []).map(function (w) { return '<option value="' + w + '"' + (w === vg.week ? " selected" : "") + ">Week " + w + "</option>"; }).join("") || '<option value="0">—</option>';
    return '<div class="ups-m-players-toolbar">' +
      '<div class="ups-m-auc-sec-head">Vegas <span class="ct">implied team points · O/U · ' + vgYear() + "</span></div>" +
      '<div class="ups-m-st-filters"><select class="ups-m-players-filter" id="ups-m-vg-week">' + wkOpts + "</select></div></div>";
  }
  function vegasHtml() {
    if (!vg.data) return '<div class="ups-m-loading">Loading…</div>';
    var teams = vg.data.teams || [];
    if (!teams.length) return '<div class="ups-m-stub"><div>No lines posted for this week yet.</div></div>';
    var head = '<div class="ups-m-adp-row head"><span class="rk">#</span><span class="pl">Team</span><span class="v">Impl</span><span class="v">O/U</span></div>';
    var body = teams.map(function (t, i) {
      var sub = (t.home ? "vs " : "@ ") + (t.opp || "—") + (t.spread != null ? " · " + (t.spread > 0 ? "+" : "") + t.spread : "");
      var icls = t.implied == null ? "" : (t.implied >= 26 ? "up" : (t.implied <= 18 ? "dn" : ""));
      return '<div class="ups-m-adp-row">' +
        '<span class="rk">' + (i + 1) + "</span>" +
        '<span class="pl"><span class="nm">' + U.escapeHtml(t.team) + '</span><span class="sub">' + U.escapeHtml(sub) + "</span></span>" +
        '<span class="v"><span class="ups-m-tr ' + icls + '">' + (t.implied != null ? t.implied : "—") + "</span></span>" +
        '<span class="v">' + (t.total != null ? t.total : "—") + "</span>" +
      "</div>";
    }).join("");
    return '<div class="ups-m-fpa-table">' + head + body + "</div>";
  }
  function bindVegas(mount) {
    var w = document.getElementById("ups-m-vg-week");
    if (w) { w.value = String(vg.week); w.addEventListener("change", function () { vg.week = parseInt(this.value, 10) || 0; loadVegas().then(function () { if (view.inner === "vegas") paint(mount); }); }); }
  }
  // ── ADP board (Stats → ADP inner tab) — multi-source ranks + tiers, Superflex ──
  var adpb = { pos: "ALL", data: null, srcSel: { fc: true, ktc: true, dp: true }, roster: "sf", rdPct: 0.35, generatedAt: null, team: "__ALL__", sort: "ovr" };
  function adpRelTime(iso) { if (!iso) return ""; var t = Date.parse(iso); if (isNaN(t)) return ""; var s = Math.max(0, (Date.now() - t) / 1000); if (s < 90) return "just now"; if (s < 5400) return Math.round(s / 60) + "m ago"; if (s < 172800) return Math.round(s / 3600) + "h ago"; return Math.round(s / 86400) + "d ago"; }
  var ADPB_SRC = [["fc", "FC"], ["ktc", "KTC"], ["dp", "DP"]];
  function adpbKeys() { return { d: "dsf", r: "rsf" }; }   // baked Superflex (UPS league)
  // Per-position tiers via local-cliff detection (matches desktop adpAssignTiers).
  function adpbTiers(arr) {
    var n = arr.length; if (!n) return;
    var vals = arr.map(function (r) { return r._bv != null ? r._bv : (r.idpVal || 0); });
    arr[0]._tier = 1; if (n < 2) return;
    var gaps = []; for (var i = 1; i < n; i++) gaps.push(vals[i - 1] - vals[i]);
    var W = 4, K = 2.5, MINREL = 0.04;
    function med(a) { if (!a.length) return 0; var s = a.slice().sort(function (x, y) { return x - y; }); var m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
    var tier = 1;
    for (var j = 1; j < n; j++) {
      var g = vals[j - 1] - vals[j];
      var lo = Math.max(0, (j - 1) - W), hi = Math.min(gaps.length, (j - 1) + W + 1);
      var local = []; for (var t = lo; t < hi; t++) if (gaps[t] > 0) local.push(gaps[t]);
      var m2 = med(local), rel = vals[j - 1] > 0 ? g / vals[j - 1] : 0;
      if (m2 > 0 && g > m2 * K && rel > MINREL) tier++;
      arr[j]._tier = tier;
    }
  }
  // Dynasty-only sources (DP) drop to null at the redraft extreme (show "—").
  function adpbSrcBlend(row, src) {
    var blk = row[src]; if (!blk) return null;
    var k = adpbKeys(), dyn = blk[k.d], rd = blk[k.r];
    if (dyn == null && rd == null) return null;
    if (adpb.rdPct >= 0.999) return (rd != null && rd > 0) ? rd : null;
    if (adpb.rdPct <= 0.001) return (dyn != null && dyn > 0) ? dyn : null;
    if (rd == null) return dyn; if (dyn == null) return rd;
    return Math.round((1 - adpb.rdPct) * dyn + adpb.rdPct * rd);
  }
  // Per-dimension consensus: mean dynasty + mean redraft separately, then blend.
  function adpbBlend(row) {
    if (row.isIdp) return row.idpVal != null ? row.idpVal : null;
    var k = adpbKeys(), dynVals = [], rdVals = [];
    ADPB_SRC.forEach(function (p) {
      if (!adpb.srcSel[p[0]]) return;
      var blk = row[p[0]]; if (!blk) return;
      if (blk[k.d] != null && blk[k.d] > 0) dynVals.push(blk[k.d]);
      if (blk[k.r] != null && blk[k.r] > 0) rdVals.push(blk[k.r]);
    });
    if (!dynVals.length && !rdVals.length) return null;
    var dynC = dynVals.length ? dynVals.reduce(function (a, b) { return a + b; }, 0) / dynVals.length : null;
    var rdC = rdVals.length ? rdVals.reduce(function (a, b) { return a + b; }, 0) / rdVals.length : null;
    if (rdC == null) return Math.round(dynC);
    if (dynC == null) return Math.round(rdC);
    return Math.round((1 - adpb.rdPct) * dynC + adpb.rdPct * rdC);
  }
  function loadAdpBoard() {
    if (adpb.data) return Promise.resolve(adpb.data);
    return fetch(API.workerUrl("/api/adp-board"), { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.json(); })
      .then(function (d) { adpb.data = (d && d.board) || []; adpb.generatedAt = (d && d.generated_at) || null; return adpb.data; })
      .catch(function () { adpb.data = []; return adpb.data; });
  }
  // UPS ownership (for the ADP Team/FA filter): mfl_id → franchise + franchise list.
  var adpbOwn = null;
  function loadAdpbOwn() {
    if (adpbOwn) return Promise.resolve(adpbOwn);
    return fetch(API.workerUrl("/api/mfl-league-state"), { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var p2f = {}, f2n = {};
        Object.keys((j && j.pid_to_fid) || {}).forEach(function (pid) { p2f[pid] = String(j.pid_to_fid[pid]); });
        ((j && j.franchises) || []).forEach(function (f) { f2n[String(f.id)] = f.name; });
        adpbOwn = { p2f: p2f, f2n: f2n };
        return adpbOwn;
      })
      .catch(function () { adpbOwn = { p2f: {}, f2n: {} }; return adpbOwn; });
  }
  function adpBoardToolbar() {
    var poss = [["ALL", "All"], ["QB", "QB"], ["RB", "RB"], ["WR", "WR"], ["TE", "TE"], ["DL", "DL"], ["LB", "LB"], ["DB", "DB"]];
    var chips = poss.map(function (p) { return '<button class="ups-m-pos-chip' + (adpb.pos === p[0] ? " on" : "") + '" data-adppos="' + p[0] + '">' + p[1] + "</button>"; }).join("");
    var srcTogs = ADPB_SRC.map(function (p) { return '<label class="ups-m-adp-srctog"><input type="checkbox" data-adpsrc="' + p[0] + '"' + (adpb.srcSel[p[0]] ? " checked" : "") + '/>' + p[1] + "</label>"; }).join("");
    var rdP = Math.round(adpb.rdPct * 100);
    var skew = rdP === 0 ? "all Dynasty" : rdP === 100 ? "all Redraft" : (rdP + "% redraft");
    var teamOpts = '<option value="__ALL__">All teams</option><option value="__ROSTERED__">All Rostered</option><option value="FA">Free Agents</option>';
    if (adpbOwn && adpbOwn.f2n) {
      Object.keys(adpbOwn.f2n).sort(function (a, b) { return (adpbOwn.f2n[a] || "").localeCompare(adpbOwn.f2n[b] || ""); })
        .forEach(function (fid) { teamOpts += '<option value="' + fid + '"' + (adpb.team === fid ? " selected" : "") + ">" + U.escapeHtml(adpbOwn.f2n[fid]) + "</option>"; });
    }
    return '<div class="ups-m-players-toolbar">' +
      '<div class="ups-m-auc-sec-head">ADP <span class="ct">Superflex · ' + skew + ' · ranks + tiers' + (adpb.generatedAt ? ' · fetched ' + adpRelTime(adpb.generatedAt) : '') + '</span></div>' +
      '<div class="ups-m-pos-chips">' + chips + "</div>" +
      '<div class="ups-m-pos-chips" style="margin-top:6px">' +
        '<button class="ups-m-pos-chip' + (adpb.sort === "ovr" ? " on" : "") + '" data-adpsort="ovr">Overall</button>' +
        '<button class="ups-m-pos-chip' + (adpb.sort === "pos" ? " on" : "") + '" data-adpsort="pos">Positional</button>' +
      "</div>" +
      '<div class="ups-m-st-filters"><select class="ups-m-players-filter" id="ups-m-adp-team">' + teamOpts + "</select></div>" +
      '<div class="ups-m-adp-ctl"><span class="ups-m-adp-skew">Dynasty</span>' +
        '<input type="range" class="ups-m-adp-slider" min="0" max="100" step="5" value="' + rdP + '"/>' +
        '<span class="ups-m-adp-skew">Redraft</span></div>' +
      '<div class="ups-m-adp-srcs">' + srcTogs + "</div>" +
      "</div>";
  }
  function adpBoardHtml() {
    if (!adpb.data) return '<div class="ups-m-loading">Loading…</div>';
    var isIdp = (adpb.pos === "DL" || adpb.pos === "LB" || adpb.pos === "DB");
    var universe = adpb.data.filter(function (r) { return isIdp ? r.isIdp : !r.isIdp; });
    universe.forEach(function (r) { r._bv = adpbBlend(r); });
    if (!isIdp) {
      ADPB_SRC.forEach(function (p) {
        universe.forEach(function (r) { r["_rk_" + p[0]] = null; });
        universe.map(function (r) { return { r: r, v: adpbSrcBlend(r, p[0]) }; }).filter(function (x) { return x.v != null && x.v > 0; }).sort(function (a, b) { return b.v - a.v; }).forEach(function (x, i) { x.r["_rk_" + p[0]] = i + 1; });
      });
      universe.forEach(function (r) { r._rk_slp = null; });
      universe.filter(function (r) { return r.sleeperRank != null; }).sort(function (a, b) { return a.sleeperRank - b.sleeperRank; }).forEach(function (r, i) { r._rk_slp = i + 1; });
      universe.forEach(function (r) { r._rk_ffc = null; });
      universe.filter(function (r) { return r.ffcAdp != null; }).sort(function (a, b) { return a.ffcAdp - b.ffcAdp; }).forEach(function (r, i) { r._rk_ffc = i + 1; });
    }
    universe.slice().sort(function (a, b) { return (b._bv || 0) - (a._bv || 0); }).forEach(function (r, i) { r._ovr = i + 1; });
    var byPos = {}; universe.forEach(function (r) { (byPos[r.pos] = byPos[r.pos] || []).push(r); });
    Object.keys(byPos).forEach(function (pos) { var arr = byPos[pos].sort(function (a, b) { return (b._bv || 0) - (a._bv || 0); }); arr.forEach(function (r, i) { r._posRank = i + 1; }); adpbTiers(arr); });
    var rows = universe.slice();
    if (!isIdp && adpb.pos !== "ALL") rows = rows.filter(function (r) { return r.pos === adpb.pos; });
    if (adpb.team && adpb.team !== "__ALL__" && adpbOwn) {
      rows = rows.filter(function (r) {
        var fid = adpbOwn.p2f[String(r.pid)] || null;
        if (adpb.team === "__ROSTERED__") return fid != null;
        if (adpb.team === "FA") return fid == null;
        return fid === adpb.team;
      });
    }
    var sortKey = adpb.sort === "pos" ? "_posRank" : "_ovr";
    rows.sort(function (a, b) { return (a[sortKey] || 9999) - (b[sortKey] || 9999); });
    if (!rows.length) return '<div class="ups-m-stub"><div>No players.</div></div>';
    function tpill(t) { if (t == null) return "—"; var c = t <= 1 ? "t1" : t <= 2 ? "t2" : t <= 3 ? "t3" : "tn"; return '<span class="ups-m-tierp ' + c + '">T' + t + "</span>"; }
    var head = '<div class="ups-m-adp-row head"><span class="rk">#</span><span class="pl">Player</span><span class="v">Pos</span><span class="v">Tier</span></div>';
    var body = rows.slice(0, 300).map(function (r) {
      var sub;
      if (r.isIdp) {
        sub = (r.team || "—") + (r.fpEcr != null ? " · ECR #" + r.fpEcr : "");
      } else {
        var src = [];
        if (r._rk_fc != null) src.push("FC" + r._rk_fc);
        if (r._rk_ktc != null) src.push("KTC" + r._rk_ktc);
        if (r._rk_dp != null) src.push("DP" + r._rk_dp);
        if (r._rk_slp != null) src.push("Slp" + r._rk_slp);
        if (r._rk_ffc != null) src.push("FFC" + r._rk_ffc);
        sub = (r.team || "—") + (src.length ? " · " + src.join(" ") : "");
      }
      return '<div class="ups-m-adp-row">' +
        '<span class="rk">' + (r._ovr != null ? r._ovr : "—") + "</span>" +
        '<span class="pl"><span class="nm">' + U.escapeHtml(r.name) + '</span><span class="sub">' + U.escapeHtml(sub) + "</span></span>" +
        '<span class="v">' + U.escapeHtml(r.pos + (r._posRank != null ? r._posRank : "")) + "</span>" +
        '<span class="v">' + tpill(r._tier) + "</span>" +
      "</div>";
    }).join("");
    return '<div class="ups-m-fpa-table">' + head + body + "</div>";
  }
  function bindAdpBoard(mount) {
    var chips = mount.querySelectorAll(".ups-m-pos-chip[data-adppos]");
    for (var i = 0; i < chips.length; i++) chips[i].addEventListener("click", function () { adpb.pos = this.getAttribute("data-adppos"); M.route.renderRoute(); });
    var togs = mount.querySelectorAll("[data-adpsrc]");
    for (var k = 0; k < togs.length; k++) togs[k].addEventListener("change", function () { adpb.srcSel[this.getAttribute("data-adpsrc")] = this.checked; M.route.renderRoute(); });
    var sl = mount.querySelector(".ups-m-adp-slider");
    if (sl) sl.addEventListener("change", function () { adpb.rdPct = (parseInt(this.value, 10) || 0) / 100; M.route.renderRoute(); });
    var tsel = document.getElementById("ups-m-adp-team");
    if (tsel) { tsel.value = adpb.team; tsel.addEventListener("change", function () { adpb.team = this.value; M.route.renderRoute(); }); }
    var sc = mount.querySelectorAll(".ups-m-pos-chip[data-adpsort]");
    for (var s = 0; s < sc.length; s++) sc[s].addEventListener("click", function () { adpb.sort = this.getAttribute("data-adpsort"); M.route.renderRoute(); });
  }
  function fpaToolbar() {
    var yrs = fpa.years || [fpaYear()];
    var yrSel = '<select class="ups-m-players-filter" id="ups-m-fpa-year" aria-label="Season">' +
      yrs.map(function (y) { return '<option value="' + y + '"' + (y === fpaYear() ? " selected" : "") + ">" + y + "</option>"; }).join("") + "</select>";
    function wkSel(id, sel) { var o = ""; for (var w = 1; w <= 18; w++) o += '<option value="' + w + '"' + (w === sel ? " selected" : "") + ">" + w + "</option>"; return '<select class="ups-m-players-filter" id="' + id + '">' + o + "</select>"; }
    var chips = POS_FPA.map(function (p) { return '<button class="ups-m-pos-chip' + (fpa.pos === p[0] ? " on" : "") + '" data-fpapos="' + p[0] + '">' + p[1] + "</button>"; }).join("");
    return '<div class="ups-m-players-toolbar">' +
      '<div class="ups-m-auc-sec-head">Fantasy Points Against <span class="ct">pts allowed by position</span></div>' +
      '<div class="ups-m-st-filters">' + yrSel + '<span class="ups-m-fpa-wk">Wk ' + wkSel("ups-m-fpa-wmin", fpa.wkMin) + "–" + wkSel("ups-m-fpa-wmax", fpa.wkMax) + "</span></div>" +
      '<div class="ups-m-pos-chips">' + chips + "</div>" +
    "</div>";
  }
  function fpaListHtml() {
    var data = fpa.cache[fpaKey()];
    if (!data) return '<div class="ups-m-loading">Loading…</div>';
    var teams = data.teams || {}, rows = [];
    Object.keys(teams).forEach(function (tm) { var c = teams[tm] && teams[tm][fpa.pos]; if (c) rows.push({ tm: tm, raw: c.raw || {}, adj: c.adj || {} }); });
    rows.sort(function (a, b) { var va = a.adj.rank == null ? 999 : a.adj.rank, vb = b.adj.rank == null ? 999 : b.adj.rank; return va - vb; });
    var of = rows.length;
    var posLabel = (POS_FPA.filter(function (p) { return p[0] === fpa.pos; })[0] || ["", ""])[1] || fpa.pos;
    var wu = (data.weeksUsed || []).length;
    var sub = fpaYear() + " · wks " + fpa.wkMin + "–" + fpa.wkMax + (wu ? " (" + wu + ")" : "") + " · #1 = most generous · tap a team for the breakdown" + (data.err ? " · (load error)" : "");
    if (!rows.length) return '<div class="ups-m-fpa-sub">' + U.escapeHtml(sub) + "</div>" +
      '<div class="ups-m-stub"><div>No data for this position / range.</div></div>';
    var head = '<div class="ups-m-fpa-row head"><span class="rk">#</span><span class="tm">Team</span><span class="v">Alw</span><span class="v">Norm</span><span class="v">Δ%</span></div>';
    var body = rows.map(function (r) {
      var pct = r.adj.ratio != null ? Math.round((r.adj.ratio - 1) * 100) : null;
      var vcls = pct == null ? "" : (pct > 0 ? "up" : (pct < 0 ? "dn" : ""));
      return '<div class="ups-m-fpa-row tap" data-fpateam="' + U.escapeHtml(r.tm) + '">' +
        '<span class="rk"><span class="ups-m-fpa-rk ' + fpaRkCls(r.adj.rank, of) + '">' + (r.adj.rank != null ? r.adj.rank : "—") + "</span></span>" +
        '<span class="tm">' + U.escapeHtml(r.tm) + "</span>" +
        '<span class="v">' + (r.raw.perGame != null ? r.raw.perGame : "—") + "</span>" +
        '<span class="v">' + (r.raw.oppNorm != null ? r.raw.oppNorm : "—") + "</span>" +
        '<span class="v"><span class="ups-m-tr ' + vcls + '">' + (pct != null ? ((pct >= 0 ? "+" : "") + pct + "%") : "—") + "</span></span>" +
      "</div>";
    }).join("");
    return '<div class="ups-m-fpa-sub">' + U.escapeHtml(sub) + '</div><div class="ups-m-fpa-table">' + head + body + "</div>";
  }
  function fpaDetailHtml() {
    var dd = fpa.detailCache[fpaDetailKey()];
    var hdr = fpa.detailTeam + " · " + fpaPosLbl();
    var teamBack = '<div class="ups-m-fpa-sub"><a href="#" class="ups-m-fpa-back">&larr; All teams</a> · ';
    if (!dd) return teamBack + U.escapeHtml(hdr) + "</div>" + '<div class="ups-m-loading">Loading…</div>';
    var weeks = dd.weeks || [];
    function pctsp(p) { return p == null ? "" : '<span class="ups-m-tr ' + (p > 0 ? "up" : (p < 0 ? "dn" : "")) + '">' + (p >= 0 ? "+" : "") + p + "%</span>"; }

    if (fpa.detailWeek == null) {
      // LEVEL 1 — weekly totals + game-script (did the opponent run the implied volume?); tap a week for players.
      var paceNote = (dd.dPace && dd.dPace.expDeltaPct != null) ? (" · D allows " + (dd.dPace.expDeltaPct >= 0 ? "+" : "") + dd.dPace.expDeltaPct + "% plays") : "";
      var sub = teamBack + U.escapeHtml(hdr + (dd.total != null ? " · " + dd.total + " total" : "") + paceNote) + " · tap a week</div>";
      if (!weeks.length) return sub + '<div class="ups-m-stub"><div>No games in range.</div></div>';
      var wrows = weeks.map(function (w) {
        var s = w.script || {};
        var oppSub = s.opp ? ("vs " + s.opp + (s.playsWk != null ? " · " + s.playsWk + "p " + pctsp(s.actualDeltaPct) : "")) : ((w.players ? w.players.length : 0) + " players");
        var sg = s.scriptGap;
        var sgHtml = (sg != null) ? '<span class="ups-m-tr ' + (sg > 0 ? "up" : (sg < 0 ? "dn" : "")) + '">' + (sg >= 0 ? "+" : "") + sg + "</span>" : "";
        return '<div class="ups-m-fpa-wkrow" data-fpawk="' + w.wk + '">' +
          '<span class="wk"><span class="b">Wk ' + w.wk + '</span><span class="s">' + oppSub + "</span></span>" +
          '<span class="tot"><span class="b">' + (w.total != null ? w.total : "—") + '</span><span class="s">' + (sg != null ? "script " + sgHtml : "") + "</span></span>" +
          '<span class="ch">&rsaquo;</span>' +
        "</div>";
      }).join("");
      return sub + '<div class="ups-m-fpa-table">' + wrows + "</div>";
    }

    // LEVEL 2 — the players who faced them in the chosen week (+ snaps vs norm).
    var wk = null; for (var i = 0; i < weeks.length; i++) if (weeks[i].wk === fpa.detailWeek) wk = weeks[i];
    var players = wk ? (wk.players || []) : [];
    var ws = wk && wk.script;
    var wkBack = '<div class="ups-m-fpa-sub"><a href="#" class="ups-m-fpa-wkback">&larr; ' + U.escapeHtml(fpa.detailTeam) + ' weeks</a> · ' +
      U.escapeHtml("Wk " + fpa.detailWeek + (wk && wk.total != null ? " · " + wk.total + " allowed" : "") + (ws && ws.opp ? " · vs " + ws.opp : "")) + "</div>";
    if (!players.length) return wkBack + '<div class="ups-m-stub"><div>No players.</div></div>';
    var rows = players.map(function (g) {
      var v = g.variancePct, vcls = v == null ? "" : (v > 0 ? "up" : (v < 0 ? "dn" : ""));
      var snapSub = (g.snaps != null) ? (" · " + g.snaps + "snp " + pctsp(g.snapDeltaPct)) : "";
      return '<div class="ups-m-fpa-drow nowk">' +
        '<span class="pl"><span class="nm">' + U.escapeHtml(flip(g.name)) + '</span><span class="sub">norm ' + (g.avgVsOthers != null ? g.avgVsOthers : "—") + snapSub + "</span></span>" +
        '<span class="fp">' + (g.pts != null ? g.pts : "—") + "</span>" +
        '<span class="dv"><span class="ups-m-tr ' + vcls + '">' + (v != null ? ((v >= 0 ? "+" : "") + v + "%") : "—") + "</span></span>" +
      "</div>";
    }).join("");
    return wkBack + '<div class="ups-m-fpa-table">' + rows + "</div>";
  }
  function bindInner(mount) {
    var segs = mount.querySelectorAll(".ups-m-stseg[data-inner]");
    for (var i = 0; i < segs.length; i++) segs[i].addEventListener("click", function () { view.inner = this.getAttribute("data-inner"); M.route.renderRoute(); });
  }
  function bindFpa(mount) {
    var y = document.getElementById("ups-m-fpa-year");
    if (y) { y.value = fpaYear(); y.addEventListener("change", function () { fpa.year = this.value; fpa._fb = true; fpa.detailTeam = null; fpa.detailWeek = null; M.route.renderRoute(); }); }
    var wmin = document.getElementById("ups-m-fpa-wmin");
    if (wmin) { wmin.value = String(fpa.wkMin); wmin.addEventListener("change", function () { fpa.wkMin = parseInt(this.value, 10) || 1; if (fpa.wkMax < fpa.wkMin) fpa.wkMax = fpa.wkMin; fpa.detailTeam = null; fpa.detailWeek = null; M.route.renderRoute(); }); }
    var wmax = document.getElementById("ups-m-fpa-wmax");
    if (wmax) { wmax.value = String(fpa.wkMax); wmax.addEventListener("change", function () { fpa.wkMax = parseInt(this.value, 10) || 18; if (fpa.wkMax < fpa.wkMin) fpa.wkMin = fpa.wkMax; fpa.detailTeam = null; fpa.detailWeek = null; M.route.renderRoute(); }); }
    var chips = mount.querySelectorAll(".ups-m-pos-chip[data-fpapos]");
    for (var i = 0; i < chips.length; i++) chips[i].addEventListener("click", function () { fpa.pos = this.getAttribute("data-fpapos"); fpa.detailTeam = null; fpa.detailWeek = null; M.route.renderRoute(); });
    var teamRows = mount.querySelectorAll(".ups-m-fpa-row.tap[data-fpateam]");
    for (var t = 0; t < teamRows.length; t++) teamRows[t].addEventListener("click", function () { fpa.detailTeam = this.getAttribute("data-fpateam"); fpa.detailWeek = null; M.route.renderRoute(); });
    var back = mount.querySelector(".ups-m-fpa-back");
    if (back) back.addEventListener("click", function (e) { e.preventDefault(); fpa.detailTeam = null; fpa.detailWeek = null; M.route.renderRoute(); });
    // two-level drill: tap a week → its players; tap "weeks" → back to the weekly totals
    var wkRows = mount.querySelectorAll(".ups-m-fpa-wkrow[data-fpawk]");
    for (var w = 0; w < wkRows.length; w++) wkRows[w].addEventListener("click", function () { fpa.detailWeek = parseInt(this.getAttribute("data-fpawk"), 10); M.route.renderRoute(); });
    var wkBack = mount.querySelector(".ups-m-fpa-wkback");
    if (wkBack) wkBack.addEventListener("click", function (e) { e.preventDefault(); fpa.detailWeek = null; M.route.renderRoute(); });
  }

  // Team Pace (Stats → Pace inner tab) — moved out of Player Stats.
  var mpace = { season: 0, data: null, seasons: [] };
  function loadPace() {
    return fetch(API.workerUrl("/api/team-pace" + (mpace.season ? "?season=" + encodeURIComponent(mpace.season) : "")), { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.json(); })
      .then(function (d) { mpace.data = d || {}; mpace.seasons = (d && d.seasons) || []; mpace.season = (d && d.season) || mpace.season; return mpace.data; })
      .catch(function () { mpace.data = { teams: [] }; return mpace.data; });
  }
  function paceToolbar() {
    var yopts = (mpace.seasons || []).map(function (y) { return '<option value="' + y + '"' + (String(y) === String(mpace.season) ? " selected" : "") + ">" + y + "</option>"; }).join("") || '<option value="0">—</option>';
    return '<div class="ups-m-players-toolbar"><div class="ups-m-auc-sec-head">Team Pace <span class="ct">plays/game · REG · faster = more snaps</span></div>' +
      '<div class="ups-m-st-filters"><select class="ups-m-players-filter" id="ups-m-pace-year">' + yopts + "</select></div></div>";
  }
  function paceHtml() {
    if (!mpace.data) return '<div class="ups-m-loading">Loading…</div>';
    var teams = (mpace.data.teams || []), avg = mpace.data.leagueAvg || {};
    if (!teams.length) return '<div class="ups-m-stub"><div>No pace data.</div></div>';
    function cls(v, base) { if (v == null || base == null) return ""; if (v >= base * 1.03) return "up"; if (v <= base * 0.97) return "dn"; return ""; }
    var head = '<div class="ups-m-adp-row head"><span class="rk">#</span><span class="pl">Team</span><span class="v">Pace</span><span class="v">PcSoS</span></div>';
    var body = teams.map(function (t, i) {
      return '<div class="ups-m-adp-row">' +
        '<span class="rk">' + (i + 1) + "</span>" +
        '<span class="pl"><span class="nm">' + U.escapeHtml(t.team) + '</span><span class="sub">def faced ' + (t.def_plays_pg != null ? t.def_plays_pg : "—") + " · " + (t.games != null ? t.games : "—") + "g</span></span>" +
        '<span class="v"><span class="ups-m-tr ' + cls(t.off_plays_pg, avg.off) + '">' + (t.off_plays_pg != null ? t.off_plays_pg : "—") + "</span></span>" +
        '<span class="v">' + (t.pace_sos != null ? t.pace_sos : "—") + "</span>" +
      "</div>";
    }).join("");
    return '<div class="ups-m-fpa-table">' + head + body + "</div>";
  }
  function bindPace(mount) {
    var y = document.getElementById("ups-m-pace-year");
    if (y) y.addEventListener("change", function () { mpace.season = this.value; mpace.data = null; M.route.renderRoute(); });
  }

  // ── Schedule (fantasy Strength-of-Schedule heatmap) inner tab ──
  // /api/fantasy-sos: per NFL team × week, the opponent defense's adjusted
  // generosity to the chosen position (>1 = easy, <1 = tough). Compact
  // horizontally-scrollable heatmap; offseason projects from prior-season ratings.
  var msched = { year: 0, pos: "RB", view: "season", data: null };
  function schedYear() { return String(msched.year || curSeason()); }
  function schedYears() { var c = parseInt(curSeason(), 10) || new Date().getUTCFullYear(); var a = []; for (var y = c; y >= 2020; y--) a.push(y); return a; }
  function loadSched() {
    return fetch(API.workerUrl("/api/fantasy-sos?season=" + encodeURIComponent(schedYear()) + "&pos=" + encodeURIComponent(msched.pos)), { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.json(); })
      .then(function (d) { msched.data = (d && d.ok) ? d : { teams: [] }; return msched.data; })
      .catch(function () { msched.data = { teams: [] }; return msched.data; });
  }
  function schedColor(ratio) {
    if (ratio == null) return "background:var(--bg-elev);color:var(--fg-muted)";
    var t = Math.max(0, Math.min(1, (ratio - 0.8) / 0.4));
    return "background:hsl(" + Math.round(t * 120) + ",55%,34%);color:#fff";
  }
  function schedToolbar() {
    var yopts = schedYears().map(function (y) { return '<option value="' + y + '"' + (String(y) === schedYear() ? " selected" : "") + ">" + y + "</option>"; }).join("");
    var chips = POS_FPA.map(function (p) { return '<button class="ups-m-pos-chip' + (msched.pos === p[0] ? " on" : "") + '" data-spos="' + p[0] + '">' + p[1] + "</button>"; }).join("");
    var vchips = [["season", "Full"], ["playoffs", "Playoffs"]].map(function (p) { return '<button class="ups-m-pos-chip' + (msched.view === p[0] ? " on" : "") + '" data-sview="' + p[0] + '">' + p[1] + "</button>"; }).join("");
    return '<div class="ups-m-players-toolbar">' +
      '<div class="ups-m-auc-sec-head">Strength of Schedule <span class="ct">green = easy matchup · red = tough</span></div>' +
      '<div class="ups-m-st-filters"><select class="ups-m-players-filter" id="ups-m-sched-year">' + yopts + "</select>" +
      '<span class="ups-m-pos-chips inline">' + vchips + "</span></div>" +
      '<div class="ups-m-pos-chips">' + chips + "</div></div>";
  }
  function schedHtml() {
    if (!msched.data) return '<div class="ups-m-loading">Loading…</div>';
    var teams = (msched.data.teams || []).slice();
    if (!teams.length) return '<div class="ups-m-stub"><div>No schedule data.</div></div>';
    var agg = msched.view === "playoffs" ? "playoffAvg" : "seasonAvg";
    teams.sort(function (a, b) { return (b[agg] || 0) - (a[agg] || 0); });
    var wks = []; for (var w = 1; w <= 18; w++) wks.push(w);
    var note = (msched.data.projected ? "projected — " + msched.data.ratingSeason + " defense ratings · " : "") + (msched.view === "playoffs" ? "sorted easiest-first by playoff (Wk 15–17) avg" : "sorted easiest-first by season avg");
    var head = '<div class="ups-m-sched-row head"><span class="tm">' + U.escapeHtml(String(msched.data.season || schedYear())) + "</span>" +
      wks.map(function (wk) { return '<span class="cell' + ((wk >= 15 && wk <= 17) ? " po" : "") + '">' + wk + "</span>"; }).join("") + '<span class="ag">Avg</span></div>';
    var body = teams.map(function (t, i) {
      var byW = {}; (t.weeks || []).forEach(function (x) { byW[x.wk] = x; });
      return '<div class="ups-m-sched-row"><span class="tm">' + (i + 1) + " " + U.escapeHtml(t.team) + "</span>" +
        wks.map(function (wk) { var c = byW[wk]; if (!c || c.opp == null) return '<span class="cell bye">—</span>'; return '<span class="cell" style="' + schedColor(c.ratio) + '" title="vs ' + U.escapeHtml(c.opp) + " · " + (c.ratio != null ? c.ratio : "—") + '">' + U.escapeHtml(c.opp) + "</span>"; }).join("") +
        '<span class="ag" style="' + schedColor(t[agg]) + '">' + (t[agg] != null ? t[agg] : "—") + "</span></div>";
    }).join("");
    return '<div class="ups-m-sched-note">' + U.escapeHtml(note) + '</div><div class="ups-m-sched-wrap">' + head + body + "</div>";
  }
  function bindSched(mount) {
    var y = document.getElementById("ups-m-sched-year");
    if (y) y.addEventListener("change", function () { msched.year = this.value; msched.data = null; M.route.renderRoute(); });
    var ps = mount.querySelectorAll("[data-spos]");
    for (var i = 0; i < ps.length; i++) ps[i].addEventListener("click", function () { msched.pos = this.getAttribute("data-spos"); msched.data = null; M.route.renderRoute(); });
    var vs = mount.querySelectorAll("[data-sview]");
    for (var j = 0; j < vs.length; j++) vs[j].addEventListener("click", function () { msched.view = this.getAttribute("data-sview"); paint(mount); });
  }

  function paint(mount) {
    if (view.inner === "pace") {
      mount.innerHTML = subTabs("stats") + innerSwitch() + paceToolbar() + paceHtml();
      bindInner(mount); bindPace(mount);
      return;
    }
    if (view.inner === "fpa") {
      var bodyHtml = fpa.detailTeam ? fpaDetailHtml() : fpaListHtml();
      mount.innerHTML = subTabs("stats") + innerSwitch() + fpaToolbar() + bodyHtml;
      bindInner(mount); bindFpa(mount);
      return;
    }
    if (view.inner === "adp") {
      mount.innerHTML = subTabs("stats") + innerSwitch() + adpBoardToolbar() + adpBoardHtml();
      bindInner(mount); bindAdpBoard(mount);
      return;
    }
    if (view.inner === "vegas") {
      mount.innerHTML = subTabs("stats") + innerSwitch() + vegasToolbar() + vegasHtml();
      bindInner(mount); bindVegas(mount);
      return;
    }
    if (view.inner === "sched") {
      mount.innerHTML = subTabs("stats") + innerSwitch() + schedToolbar() + schedHtml();
      bindInner(mount); bindSched(mount);
      return;
    }
    mount.innerHTML = subTabs("stats") + innerSwitch() + toolbar() + renderList(curTab());
    bindInner(mount); bind(mount);
  }

  function render(mount) {
    if (view.inner === "pace") {
      if (mpace.data) { paint(mount); return; }
      mount.innerHTML = subTabs("stats") + innerSwitch() + '<div class="ups-m-loading">Loading pace…</div>';
      bindInner(mount);
      loadPace().then(function () { if (view.inner === "pace") paint(mount); });
      return;
    }
    if (view.inner === "fpa") {
      if (fpa.detailTeam) {
        if (fpa.detailCache[fpaDetailKey()]) { paint(mount); return; }
        mount.innerHTML = subTabs("stats") + innerSwitch() + fpaToolbar() +
          '<div class="ups-m-fpa-sub"><a href="#" class="ups-m-fpa-back">&larr; All teams</a></div><div class="ups-m-loading">Loading breakdown…</div>';
        bindInner(mount); bindFpa(mount);
        loadFpaDetail().then(function () { if (view.inner === "fpa" && fpa.detailTeam) paint(mount); });
        return;
      }
      if (fpa.years && fpa.cache[fpaKey()]) { paint(mount); return; }
      mount.innerHTML = subTabs("stats") + innerSwitch() + fpaToolbar() + '<div class="ups-m-loading">Loading points against…</div>';
      bindInner(mount); bindFpa(mount);
      Promise.all([loadFpaYears(), loadFpa()]).then(function (res) {
        var data = res[1];
        // Offseason / empty current year → fall back to the prior season once.
        if (data && !Object.keys(data.teams || {}).length && fpaYear() === String(curSeason()) && !fpa._fb) {
          fpa._fb = true; fpa.year = String((parseInt(curSeason(), 10) || 0) - 1); render(mount); return;
        }
        if (view.inner === "fpa") paint(mount);
      });
      return;
    }
    if (view.inner === "adp") {
      if (adpb.data && adpbOwn) { paint(mount); return; }
      mount.innerHTML = subTabs("stats") + innerSwitch() + adpBoardToolbar() + '<div class="ups-m-loading">Loading ADP…</div>';
      bindInner(mount); bindAdpBoard(mount);
      Promise.all([loadAdpBoard(), loadAdpbOwn()]).then(function () { if (view.inner === "adp") paint(mount); });
      return;
    }
    if (view.inner === "vegas") {
      if (vg.data) { paint(mount); return; }
      mount.innerHTML = subTabs("stats") + innerSwitch() + '<div class="ups-m-loading">Loading Vegas lines…</div>';
      bindInner(mount);
      loadVegas().then(function () { if (view.inner === "vegas") paint(mount); });
      return;
    }
    if (view.inner === "sched") {
      if (msched.data) { paint(mount); return; }
      mount.innerHTML = subTabs("stats") + innerSwitch() + schedToolbar() + '<div class="ups-m-loading">Loading schedule…</div>';
      bindInner(mount); bindSched(mount);
      loadSched().then(function () { if (view.inner === "sched") paint(mount); });
      return;
    }
    var tab = curTab();
    // SoS-adjusted points load in the background (per season); re-paint when ready
    // so the "SoS" column set fills in.
    loadSos(curSeason()).then(function () { if (view.inner === "players" && view.tab === tab.id) paint(mount); });
    loadCons(curSeason()).then(function () { if (view.inner === "players" && view.tab === tab.id) paint(mount); });
    loadEpa(curSeason()).then(function () { if (view.inner === "players" && view.tab === tab.id) paint(mount); });
    loadMarket().then(function () { if (view.inner === "players" && view.tab === tab.id) paint(mount); });
    loadRoutes(curSeason()).then(function () { if (view.inner === "players" && view.tab === tab.id) paint(mount); });
    loadNgs(curSeason()).then(function () { if (view.inner === "players" && view.tab === tab.id) paint(mount); });
    if (cache[tab.alias + "|" + curSeason()]) { paint(mount); return; }
    mount.innerHTML = subTabs("stats") + innerSwitch() + toolbar() + '<div class="ups-m-loading">Loading stats…</div>';
    bindInner(mount); bindToolbar(mount);
    load(tab.alias, curSeason()).then(function () { if (view.tab === tab.id && view.inner === "players") paint(mount); });
  }

  M.statsView = { render: render };
  M.route.registerView("stats", render);
})();
