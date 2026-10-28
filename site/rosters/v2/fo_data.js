/* Front Office data — one read per source per visit, loaded the first time a
   view needs it (#1338). Every source here is MFL's own export through the
   worker's /api/mfl-export proxy (60 s edge cache, 0 D1 rows) or a worker
   route that already serves the phone. No per-player or per-team loops.

   Each key resolves to an entry { key, state: "ok"|"error", data, at (ms of
   the read), url } and is kept for the visit; refresh(key) re-reads it.
   Plain script; attaches window.UPS_FO_DATA. configure() is called once by
   front_office.js with the worker base, league and season it already uses.
*/
(function (root) {
  "use strict";

  var cfg = { apiBase: "", leagueId: "", season: "", sessionQuery: function (u) { return u; } };
  var entries = {}, pending = {}, listeners = {};

  function str(v) { return v == null ? "" : String(v).trim(); }
  function q(params) {
    var parts = [];
    Object.keys(params).forEach(function (k) {
      if (params[k] == null || params[k] === "") return;
      parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(params[k]));
    });
    return parts.join("&");
  }
  function mflExport(type, extra) {
    return cfg.apiBase + "/api/mfl-export?" + q(Object.assign({ TYPE: type, L: cfg.leagueId, YEAR: cfg.season, JSON: 1 }, extra || {}));
  }
  function worker(path, extra, withSession) {
    var u = cfg.apiBase + path + "?" + q(Object.assign({ L: cfg.leagueId, YEAR: cfg.season }, extra || {}));
    return withSession ? cfg.sessionQuery(u) : u;
  }
  function getJson(url) {
    return fetch(url, { credentials: "omit", cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }
  // An MFL error envelope is a failed read, never "no rows".
  function mflOk(j) { return !!j && typeof j === "object" && !j.error; }

  var SOURCES = {
    // MFL's own league-scored points, every week (site/m/season_scoring.js reads it) + which weeks are final.
    scores: function () {
      return Promise.all([
        getJson(mflExport("playerScores", { W: "ALL" })),
        getJson(cfg.apiBase + "/api/current-lineup-week?" + q({ L: cfg.leagueId, YEAR: cfg.season })).catch(function () { return null; })
      ]).then(function (res) {
        var SS = root.UPS_MOBILE_SEASON_SCORING;
        if (!SS) throw new Error("season scoring module missing");
        var wk = res[1] && res[1].ok !== false ? res[1] : null;
        var built = SS.build(res[0], { completedWeek: SS.completedWeekFrom(wk), season: parseInt(cfg.season, 10) || 0 });
        built.season = parseInt(cfg.season, 10) || 0;
        built.fetchedAt = Date.now();
        built.lineupWeek = wk && wk.week ? parseInt(wk.week, 10) : null;
        built.lineupSource = wk && wk.source ? wk.source : null;
        return built;
      });
    },
    // Every MFL player (names, positions, NFL teams). DETAILS only where age is needed (Market).
    players: function () { return getJson(mflExport("players")).then(function (j) { if (!mflOk(j)) throw new Error("MFL players unreadable"); return j; }); },
    playersDetail: function () { return getJson(mflExport("players", { DETAILS: 1 })).then(function (j) { if (!mflOk(j)) throw new Error("MFL players unreadable"); return j; }); },
    byes: function () { return getJson(mflExport("nflByeWeeks")).then(function (j) { if (!mflOk(j)) throw new Error("MFL byes unreadable"); return j; }); },
    tradeBait: function () { return getJson(mflExport("tradeBait", { INCLUDE_DRAFT_PICKS: 1 })).then(function (j) { if (!mflOk(j)) throw new Error("MFL trade bait unreadable"); return j; }); },
    picks: function () { return getJson(mflExport("futureDraftPicks")).then(function (j) { if (!mflOk(j)) throw new Error("MFL draft picks unreadable"); return j; }); },
    // MFL's league settings: the starter ranges the lineup slots come from (trade_fit deriveSlots).
    league: function () {
      return getJson(mflExport("league")).then(function (j) {
        if (!mflOk(j) || !j.league || !j.league.starters) throw new Error("MFL league settings unreadable");
        return j;
      });
    },
    // Every franchise's submitted lineup, every week so far (one read; starter_mix.js keeps completed weeks only).
    weeklyResults: function () {
      return getJson(mflExport("weeklyResults", { W: "YTD" })).then(function (j) {
        if (!mflOk(j) || !(j.allWeeklyResults || j.weeklyResults)) throw new Error("MFL weekly results unreadable");
        return j;
      });
    },
    transactions: function () { return getJson(mflExport("transactions")).then(function (j) { if (!mflOk(j)) throw new Error("MFL transactions unreadable"); return j; }); },
    waiverAvailability: function () { return getJson(worker("/api/waivers/availability")); },
    waiverState: function () { return getJson(worker("/api/waivers/state", null, true)); },
    // MFL's held claims are the viewer's own: needs the viewer's MFL session (known:false otherwise, never "no claims").
    waiverPending: function () { return getJson(worker("/api/waivers/pending", null, true)); },
    // MFL's league calendar (its "No Trades Allowed" events are when MFL actually stops trades). MFL serves it
    // only to a signed-in league member, so it rides the viewer's session like the claims read.
    mflCalendar: function () {
      return getJson(cfg.sessionQuery(mflExport("calendar"))).then(function (j) {
        if (!mflOk(j)) throw new Error("MFL calendar needs an MFL sign-in");
        return j;
      });
    }
  };
  // Week-keyed MFL reads: projections and the NFL schedule (opponent, kickoff) for one week.
  function weekSource(type) {
    return function (week) {
      return getJson(mflExport(type, { W: week })).then(function (j) { if (!mflOk(j)) throw new Error("MFL " + type + " unreadable"); return j; });
    };
  }
  // One franchise's picks with forfeit flags (lineup penalties, #1229) — read for the VIEWER's team only, once.
  SOURCES.franchiseAssets = function (fid) { return getJson(cfg.apiBase + "/api/franchise-assets?" + q({ fid: fid, L: cfg.leagueId, YEAR: cfg.season })); };
  SOURCES.projections = weekSource("projectedScores");
  SOURCES.nflSchedule = weekSource("nflSchedule");
  // ONE answer for the whole Schedule view: every NFL team's league-week schedule plus what each opponent has allowed at each position so far
  // (the Pts Agst engine, same answer Stats → Sched reads). Never one request per player or per week; no position parameter (all nine are in it).
  // The season is the active MFL season this page was configured with. The browser's HTTP cache may serve it (no no-store).
  SOURCES.sos = function () {
    return fetch(cfg.apiBase + "/api/fantasy-sos?season=" + encodeURIComponent(cfg.season) + "&v=2", { credentials: "omit" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (j) {
      if (!j || j.ok !== true || !j.schedule || !j.season) throw new Error("schedule unreadable");
      return j;
    });
  };

  function emit(key) {
    (listeners[key] || []).concat(listeners["*"] || []).forEach(function (fn) { try { fn(entries[key], key); } catch (e) {} });
  }

  function load(key, arg) {
    var id = arg != null ? key + ":" + arg : key;
    if (entries[id]) return Promise.resolve(entries[id]);
    if (pending[id]) return pending[id];
    var src = SOURCES[key];
    if (!src) return Promise.resolve({ key: id, state: "error", data: null, at: Date.now(), error: "unknown source" });
    pending[id] = Promise.resolve().then(function () { return src(arg); }).then(function (data) {
      entries[id] = { key: id, state: "ok", data: data, at: Date.now() };
    }, function (e) {
      entries[id] = { key: id, state: "error", data: null, at: Date.now(), error: str(e && e.message || e) };
    }).then(function () { delete pending[id]; emit(id); return entries[id]; });
    return pending[id];
  }
  function get(key, arg) { return entries[arg != null ? key + ":" + arg : key] || null; }
  function refresh(key, arg) { delete entries[arg != null ? key + ":" + arg : key]; return load(key, arg); }
  function on(key, fn) { (listeners[key] = listeners[key] || []).push(fn); }

  // The injury read uses the shared resolver's own loader (5-minute freshness, #1311).
  var injuryLoader = null;
  function injury(onChange) {
    var IS = root.UPSInjuryStatus;
    if (!IS) return { state: "error", data: null, at: 0 };
    if (!injuryLoader) {
      injuryLoader = IS.createLoader(function (season) {
        return cfg.apiBase + "/api/player-status?" + q({ season: season, L: cfg.leagueId });
      });
    }
    injuryLoader.load(cfg.season, onChange);
    return injuryLoader.read();
  }

  function configure(c) {
    cfg.apiBase = str(c.apiBase).replace(/\/$/, "");
    cfg.leagueId = str(c.leagueId);
    cfg.season = str(c.season);
    if (typeof c.sessionQuery === "function") cfg.sessionQuery = c.sessionQuery;
  }

  // Test seam: swap the sources (offline tests feed recorded payloads).
  function _setSources(map) { Object.keys(map).forEach(function (k) { SOURCES[k] = map[k]; }); entries = {}; pending = {}; }

  root.UPS_FO_DATA = { configure: configure, load: load, get: get, refresh: refresh, on: on, injury: injury,
    config: function () { return Object.assign({}, cfg); }, _setSources: _setSources, mflExportUrl: mflExport };
})(typeof window !== "undefined" ? window : this);
