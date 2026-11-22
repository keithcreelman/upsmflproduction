/* UPS 2027 Preview 0: the ONLY code that talks to the network.

   Read-only by construction:
   - every request is a plain GET with credentials omitted and no custom headers;
   - the address must be the UPS worker, one of six allowed paths, and only the query names listed below;
   - an MFL export may only be of a TYPE on the allowlist (no transactions, trade bait or other owner text);
   - a session id, API key or cookie can never be sent: no such query name is allowed and nothing here reads one.
   Anything else is refused before the network is touched, and the refusal is recorded in the request log shown
   on the About screen. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.UPS2027 = root.UPS2027 || {}; root.UPS2027.data = api; }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var RULES = [
    { path: "/roster-workbench", query: ["L", "YEAR"] },
    // R3: playerScores (every player's recorded score for one week; public MFL scoring, no owner text) feeds Team › Performance
    { path: "/api/mfl-export", query: ["TYPE", "L", "YEAR", "JSON", "W"], types: ["league", "weeklyResults", "playerScores", "players", "nflSchedule"] },
    { path: "/api/current-lineup-week", query: ["L", "YEAR"] },
    { path: "/api/cap-penalty/preview", query: ["L", "YEAR"] },
    // stage R2 (Team › Roster): injury status for every player, and this week's NFL games (opponent, home or away, kickoff)
    { path: "/api/player-status", query: ["season", "L"] },
    { path: "/api/lineup-matchups", query: ["YEAR", "W"] },
    // PR A: next season's recorded drop penalties and missed-nomination fines (the UPS ledger, not yet on MFL); asked for only when the next-season row is opened
    { path: "/api/cap-adjustments/next-season", query: ["L", "YEAR"] }
  ];
  var SECRET_NAME = /mfl_user_id|apikey|api_key|key|token|session|cookie|password|auth/i;

  // { ok:true, rule } or { ok:false, reason }. `rules` is only passed by tests, to prove each layer refuses on its own:
  // the credential-name layer must refuse even if the query-name allowlist were widened by mistake.
  function check(url, workerBase, rules) {
    rules = rules || RULES;
    var u;
    try { u = new URL(url); } catch (e) { return { ok: false, reason: "not a web address" }; }
    var base;
    try { base = new URL(workerBase); } catch (e) { return { ok: false, reason: "no worker address configured" }; }
    if (u.protocol !== "https:" || u.origin !== base.origin) return { ok: false, reason: "not the UPS worker" };
    if (u.username || u.password || u.hash) return { ok: false, reason: "address carries credentials or a fragment" };
    var rule = null;
    for (var i = 0; i < rules.length; i++) if (rules[i].path === u.pathname) rule = rules[i];
    if (!rule) return { ok: false, reason: "path not allowed: " + u.pathname };
    var type = null;
    var names = [];
    u.searchParams.forEach(function (v, k) { names.push(k); if (k === "TYPE") type = v; });
    for (var j = 0; j < names.length; j++) {
      if (SECRET_NAME.test(names[j])) return { ok: false, reason: "credential-like query name: " + names[j] };
      if (rule.query.indexOf(names[j]) < 0) return { ok: false, reason: "query name not allowed: " + names[j] };
    }
    if (rule.types && rule.types.indexOf(type) < 0) return { ok: false, reason: "export type not allowed: " + type };
    return { ok: true, rule: rule };
  }

  function createLoader(cfg, fetchImpl) {
    var log = [];
    function q(o) { return Object.keys(o).map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(o[k]); }).join("&"); }
    var base = String(cfg.workerBase).replace(/\/+$/, "");
    var L = cfg.leagueId, Y = cfg.season;
    var urls = {
      roster: base + "/roster-workbench?" + q({ L: L, YEAR: Y }),
      league: base + "/api/mfl-export?" + q({ TYPE: "league", L: L, YEAR: Y, JSON: 1 }),
      week: base + "/api/current-lineup-week?" + q({ L: L, YEAR: Y }),
      weekly: function (w) { return base + "/api/mfl-export?" + q({ TYPE: "weeklyResults", L: L, YEAR: Y, JSON: 1, W: w }); },
      scores: function (w) { return base + "/api/mfl-export?" + q({ TYPE: "playerScores", L: L, YEAR: Y, JSON: 1, W: w }); },
      penalty: base + "/api/cap-penalty/preview?" + q({ L: L, YEAR: Y }),
      status: base + "/api/player-status?" + q({ season: Y, L: L }),
      matchups: function (w) { return base + "/api/lineup-matchups?" + q({ YEAR: Y, W: w }); },
      nextSeason: base + "/api/cap-adjustments/next-season?" + q({ L: L, YEAR: Y }),
      players: base + "/api/mfl-export?" + q({ TYPE: "players", L: L, YEAR: Y, JSON: 1 }),
      schedule: function (w) { return base + "/api/mfl-export?" + q({ TYPE: "nflSchedule", L: L, YEAR: Y, JSON: 1, W: w }); }
    };

    function get(url, label) {
      var entry = { label: label, method: "GET", at: Date.now(), path: "", type: "", status: null, bytes: null, ms: null, refused: "" };
      log.push(entry);
      var chk = check(url, base);
      try { var pu = new URL(url); entry.path = pu.pathname; entry.type = pu.searchParams.get("TYPE") || ""; } catch (e) { entry.path = String(url).slice(0, 60); }
      if (!chk.ok) { entry.refused = chk.reason; return Promise.reject(new Error("Request refused: " + chk.reason)); }
      var t0 = Date.now();
      var ctl = typeof AbortController === "function" ? new AbortController() : null;
      var timer = ctl ? setTimeout(function () { ctl.abort(); }, 25000) : null;
      return fetchImpl(url, { method: "GET", credentials: "omit", mode: "cors", cache: "no-store", redirect: "error", signal: ctl ? ctl.signal : undefined })
        .then(function (r) {
          entry.status = r.status;
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.text();
        })
        .then(function (text) {
          entry.bytes = text.length; entry.ms = Date.now() - t0;
          return JSON.parse(text);
        })
        .then(function (j) { if (timer) clearTimeout(timer); return j; }, function (e) {
          if (timer) clearTimeout(timer);
          entry.ms = Date.now() - t0;
          if (e && e.name === "AbortError") throw new Error("Timed out");
          throw e;
        });
    }

    function settle(p) {
      return p.then(function (data) { return { state: "ok", data: data }; }, function (e) { return { state: "error", data: null, error: String(e && e.message || e) }; });
    }

    // The roster read is the one the screens cannot do without. League limits, the lineup week and the submitted
    // lineup improve the screen; if any of them fails, the roster still shows and says what is missing.
    // Each added read is kept in memory by its exact address and reused (switching views, weeks or teams never asks again).
    // It is asked again only on an explicit reload, or when its freshness limit has passed and the screen is used again.
    var memo = {};
    var LIMIT = { status: 4 * 60 * 1000 + 30 * 1000, matchups: 5 * 60 * 1000, weekly: 60 * 60 * 1000, scores: 10 * 60 * 1000 };
    function cached(key, limit, run, force) {
      var m = memo[key], now = Date.now();
      if (!force && m) {
        if (m.state === "loading") return m.promise;
        if (m.state === "ok" && now - m.at <= limit) return m.promise;
        if (m.state === "error" && now - m.at <= 60 * 1000) return m.promise;
      }
      var rec = { state: "loading", at: now, promise: null };
      rec.promise = run().then(function (r) { rec.state = r.state; rec.at = Date.now(); return r; });
      memo[key] = rec;
      return rec.promise;
    }
    // A failed read is not kept past a mode change or a Try again.
    function clearErrors() { Object.keys(memo).forEach(function (k) { if (memo[k].state === "error" || memo[k].state === "loading") delete memo[k]; }); }
    function clearAll() { memo = {}; }

    // MFL's injury read has an expected-return text on every row. Its meaning is not verified (Keith, 2026-11-20: show Unavailable), so
    // it is dropped HERE, before anything else can hold it: nothing in the page can display what is never kept.
    function stripReturn(j) {
      var out = {}; Object.keys(j).forEach(function (k) { if (k !== "players") out[k] = j[k]; });
      out.players = {};
      Object.keys(j.players).forEach(function (id) {
        var e = j.players[id] || {}, c = {};
        Object.keys(e).forEach(function (k) {
          var v = e[k];
          if ((k === "mfl" || k === "roster") && v && typeof v === "object") {
            var w = {}; Object.keys(v).forEach(function (f) { if (f !== "exp_return" && f !== "return_date") w[f] = v[f]; });
            v = w;
          }
          c[k] = v;
        });
        out.players[id] = c;
      });
      return out;
    }
    function loadStatus(force) {
      return cached("status", LIMIT.status, function () {
        return settle(get(urls.status, "injury status")).then(function (r) {
          if (r.state !== "ok") return r;
          var j = r.data;
          if (!j || j.ok !== true || !j.players || typeof j.players !== "object") return { state: "error", data: null, error: "Unexpected answer" };
          return { state: "ok", data: stripReturn(j), at: Date.now() };
        });
      }, force);
    }
    // Only what the screens use is kept from the matchup read: each team's game that week, and each player's points per final game.
    function loadMatchups(week, force) {
      return cached("mu:" + week, LIMIT.matchups, function () {
        return settle(get(urls.matchups(week), "NFL games, week " + week)).then(function (r) {
          if (r.state !== "ok") return r;
          var j = r.data;
          if (!j || j.ok === false || !j.matchups || typeof j.matchups !== "object") return { state: "error", data: null, error: "Unexpected answer" };
          var games = {}, avg = {}, season = {};
          Object.keys(j.matchups).forEach(function (t) { var g = j.matchups[t] || {}; games[t] = { opp: String(g.opp || ""), isHome: g.isHome === true, kickoff: Number(g.kickoff) || 0, status: String(g.status || "") }; });
          Object.keys(j.playerWindow || {}).forEach(function (id) { var w = j.playerWindow[id] || {}; if (isFinite(Number(w.avg)) && w.avg != null) avg[id] = { avg: Number(w.avg), games: Number(w.games) || 0 }; if (w.total != null && isFinite(Number(w.total)) && w.games != null && isFinite(Number(w.games))) season[id] = { total: Number(w.total), games: Number(w.games) }; });
          var latest = j.season && isFinite(Number(j.season.latestFinalWeek)) ? Number(j.season.latestFinalWeek) : null;
          // PR B: `lastCompleteWeek` (every game final) is the Worker's own second opinion on completion; `latestFinalWeek` (at least one final game) is NOT completion
          var lastComplete = j.season && j.season.lastCompleteWeek != null && isFinite(Number(j.season.lastCompleteWeek)) ? Number(j.season.lastCompleteWeek) : null;
          var horizon = {};
          Object.keys(j.horizon || {}).forEach(function (t) { var a = j.horizon[t]; if (Array.isArray(a)) horizon[t] = a.map(function (g) { return { wk: Number(g && g.wk), opp: String(g && g.opp || ""), isHome: !!(g && g.isHome) }; }); });
          return { state: "ok", data: { week: Number(j.week) || Number(week), games: games, avg: avg, season: season, latestFinal: latest, lastComplete: lastComplete, horizon: horizon, horizonWeeks: Array.isArray(j.horizonWeeks) ? j.horizonWeeks.map(Number) : [], hist: pickHist(j), asOf: String(j.as_of || "") }, at: Date.now() };
        });
      }, force);
    }
    // W1 (team history): the six fields are copied as the worker sent them, or null when the worker sent none of them (W1 not live).
    // Nothing here trusts them: lib/clubhist.js validates the shape and treats anything malformed as unavailable.
    var HIST_KEYS = ["teamHistoryState", "teamHistoryReason", "teamHistoryThrough", "teamHistory", "teamHistoryMissing", "teamHistoryConflict", "teamHistoryFirst"];
    function pickHist(j) {
      var any = false, o = {};
      HIST_KEYS.forEach(function (k) { if (Object.prototype.hasOwnProperty.call(j, k)) { any = true; o[k] = j[k]; } });
      return any ? o : null;
    }
    // One week of every player's recorded score: { id: number } for the players MFL has a score for. A score of 0 is a recorded score.
    // An answer with no score rows at all is an error, never "no one scored": nothing is claimed from a read that came back empty.
    function loadScores(week, force) {
      return cached("ps:" + week, LIMIT.scores, function () {
        return settle(get(urls.scores(week), "player scores, week " + week)).then(function (r) {
          if (r.state !== "ok") return r;
          var ps = r.data && r.data.playerScores, rows = ps && ps.playerScore;
          rows = Array.isArray(rows) ? rows : rows ? [rows] : [];
          if (!ps || !rows.length) return { state: "error", data: null, error: "Unexpected answer" };
          var map = {};
          rows.forEach(function (e) {
            if (!e || e.id == null) return;
            var sc = e.score;
            if (sc == null || (typeof sc === "string" && sc.trim() === "") || typeof sc === "boolean") return;
            var n = Number(sc);
            map[String(e.id)] = isFinite(n) ? n : String(sc).trim();   // a non-numeric score is kept as text so it shows as unverified, never silently dropped
          });
          return { state: "ok", data: { week: Number(week), scores: map }, at: Date.now() };
        });
      }, force);
    }
    function loadWeekly(week, force) {
      return cached("wk:" + week, LIMIT.weekly, function () {
        return settle(get(urls.weekly(week), "lineups and scores, week " + week)).then(function (r) {
          if (r.state === "ok" && !(r.data && r.data.weeklyResults)) return { state: "error", data: null, error: "Unexpected answer" };
          return r;
        });
      }, force);
    }

    function loadCore() {
      clearAll(); // an explicit (re)load starts from nothing
      var rw = settle(get(urls.roster, "roster and contracts"));
      var league = settle(get(urls.league, "league limits"));
      var weekRead = settle(get(urls.week, "current lineup week"));
      return Promise.all([rw, league, weekRead]).then(function (r) {
        var wk = r[2].state === "ok" && r[2].data && r[2].data.ok !== false ? parseInt(r[2].data.week, 10) : NaN;
        var week = isFinite(wk) ? wk : null;
        var weeklyP = week ? loadWeekly(week, true) : Promise.resolve({ state: "error", data: null, error: "Lineup week unknown" });
        return weeklyP.then(function (weekly) { return { roster: r[0], league: r[1], week: week, weekRead: r[2], weekly: weekly }; });
      });
    }

    // PR A: next season's ledger of recorded cut charges and fines. Kept in memory by its exact address and reused (the answer is never stored
    // on the phone); asked again only on Try again. The caller parses it right away and keeps only the allowlisted fields.
    function loadNextSeason(force) {
      return cached("ns", 10 * 60 * 1000, function () {
        return settle(get(urls.nextSeason, "next-season adjustments")).then(function (r) {
          if (r.state !== "ok") return r;
          if (!r.data || typeof r.data !== "object") return { state: "error", data: null, error: "Unexpected answer" };
          return { state: "ok", data: r.data, at: Date.now() };
        });
      }, force);
    }

    // PR B: every player's position and current NFL club (public MFL players export). Only { id: { pos, club } } is kept; names and every other field are dropped
    // here. Asked for once and reused; it feeds the position pools of the ranks.
    function loadPlayers(force) {
      return cached("players", 6 * 60 * 60 * 1000, function () {
        return settle(get(urls.players, "players and positions")).then(function (r) {
          if (r.state !== "ok") return r;
          var rows = r.data && r.data.players && r.data.players.player;
          rows = Array.isArray(rows) ? rows : rows ? [rows] : [];
          if (!rows.length) return { state: "error", data: null, error: "Unexpected answer" };
          var map = {};
          rows.forEach(function (p) { if (p && p.id != null && /^\d+$/.test(String(p.id))) map[String(p.id)] = { pos: String(p.position || ""), club: String(p.team || "") }; });
          return { state: "ok", data: { byId: map }, at: Date.now() };
        });
      }, force);
    }
    // PR B: one week of the NFL schedule, parsed to games right away (two clubs, seconds remaining, whether both have a score).
    function loadSchedule(week, parse, force) {
      return cached("sched:" + week, 2 * 60 * 1000, function () {
        return settle(get(urls.schedule(week), "NFL schedule, week " + week)).then(function (r) {
          if (r.state !== "ok") return r;
          var games = null; try { games = parse(r.data, week); } catch (e) { games = null; }   // an answer that cannot be parsed (or is for another week) is an error, never a read left loading
          if (!games) return { state: "error", data: null, error: "Unexpected answer" };
          return { state: "ok", data: { week: Number(week), games: games }, at: Date.now() };
        });
      }, force);
    }

    function loadPenalty() {
      return settle(get(urls.penalty, "contract calculations")).then(function (r) {
        if (r.state !== "ok") return r;
        var j = r.data;
        if (!j || j.ok !== true || !j.players || typeof j.players !== "object") return { state: "error", data: null, error: "Unexpected answer" };
        return { state: "ok", data: j.players, meta: { calculatedAt: String(j.calculated_at || ""), earnedThroughWeek: j.earned_through_week == null ? null : Number(j.earned_through_week), season: String(j.season || "") } };
      });
    }

    function summary() {
      var by = { requests: log.length, ok: 0, failed: 0, refused: 0, nonGet: 0 };
      log.forEach(function (e) {
        if (e.method !== "GET") by.nonGet++;
        if (e.refused) by.refused++;
        else if (e.status && e.status >= 200 && e.status < 300) by.ok++;
        else by.failed++;
      });
      return by;
    }

    return { urls: urls, log: log, get: get, loadCore: loadCore, loadPenalty: loadPenalty, loadNextSeason: loadNextSeason, loadPlayers: loadPlayers, loadSchedule: loadSchedule, loadStatus: loadStatus, loadMatchups: loadMatchups, loadScores: loadScores, loadWeekly: loadWeekly, clearErrors: clearErrors, summary: summary };
  }

  return { RULES: RULES, check: check, createLoader: createLoader };
});
