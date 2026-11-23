/* UPS 2027 Preview 0: the ONLY code that talks to the network.

   Read-only by construction:
   - every request is a plain GET with credentials omitted and no custom headers;
   - the address must be the UPS worker, one of the allowed paths (RULES), and only the query names listed below;
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
    // PR A: players (MFL's complete player list: id, name, position, club; public data) names the player on a cap adjustment by id, whether or not he is on a roster, and gives the position pools of the ranks (PR B)
    { path: "/api/mfl-export", query: ["TYPE", "L", "YEAR", "JSON", "W"], types: ["league", "weeklyResults", "playerScores", "players", "nflSchedule", "nflByeWeeks"] },
    { path: "/api/current-lineup-week", query: ["L", "YEAR"] },
    { path: "/api/cap-penalty/preview", query: ["L", "YEAR"] },
    // stage R2 (Team › Roster): injury status for every player, and this week's NFL games (opponent, home or away, kickoff)
    { path: "/api/player-status", query: ["season", "L"] },
    { path: "/api/lineup-matchups", query: ["YEAR", "W"] },
    // PR A: next season's recorded drop penalties and missed-nomination fines (the UPS ledger, not yet on MFL); asked for only when the next-season row is opened
    { path: "/api/cap-adjustments/next-season", query: ["L", "YEAR"] },
    // R6: one player's NFL game stats for one season (public nflverse box score, red zone and snaps, matched to the MFL id by the Worker); asked for once per player
    // when his Breakdown is shown, kept in memory and reused across views, tabs and reopening the profile
    { path: "/api/player-weekly-box", query: ["season", "mfl_id", "L"] },
    // R7 (Keith, 2026-11-23): two reads of the DRAFT Worker #1515, not deployed. Live, they answer 404 today, which the loader reports as "not available"
    // (asked once per freshness window, never retried in a loop). The captured MFL projection per player for one week, with its capture times:
    { path: "/api/player-projections", query: ["season", "week", "ids"] },
    // and one position group's league-wide season sums through a week (the pool for season stat ranks):
    { path: "/api/position-season-stats", query: ["season", "through", "group"] }
  ];
  var SECRET_NAME = /mfl_user_id|apikey|api_key|key|token|session|cookie|password|auth/i;
  // R7: the draft routes' own limits (worker/src/player_projections.js MAX_IDS; worker/src/position_season_stats.js POSITION_GROUPS)
  var PROJECTION_IDS = 80;
  var POSITION_GROUPS = ["QB", "RB", "WR", "TE", "PK", "PN", "DL", "LB", "DB"];
  // [ids] unique and ascending, or null when any id is not a plain MFL id (nothing is asked for then)
  function normIds(ids) {
    var raw = Array.isArray(ids) ? ids : String(ids == null ? "" : ids).split(","), seen = {}, out = [];
    for (var i = 0; i < raw.length; i++) {
      var id = String(raw[i] == null ? "" : raw[i]).trim();
      if (!id && !Array.isArray(ids)) continue;
      if (!/^\d{1,7}$/.test(id)) return null;
      if (!seen[id]) { seen[id] = 1; out.push(id); }
    }
    return out.sort(function (a, b) { return Number(a) - Number(b); });
  }
  function numOrNull(v) { return typeof v === "number" && isFinite(v) ? v : null; }
  function strOrNull(v) { return typeof v === "string" && v ? v : null; }

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
      players: base + "/api/mfl-export?" + q({ TYPE: "players", L: L, YEAR: Y, JSON: 1 }),
      penalty: base + "/api/cap-penalty/preview?" + q({ L: L, YEAR: Y }),
      status: base + "/api/player-status?" + q({ season: Y, L: L }),
      matchups: function (w) { return base + "/api/lineup-matchups?" + q({ YEAR: Y, W: w }); },
      nextSeason: base + "/api/cap-adjustments/next-season?" + q({ L: L, YEAR: Y }),
      schedule: function (w) { return base + "/api/mfl-export?" + q({ TYPE: "nflSchedule", L: L, YEAR: Y, JSON: 1, W: w }); },
      byes: base + "/api/mfl-export?" + q({ TYPE: "nflByeWeeks", L: L, YEAR: Y, JSON: 1 }),
      fullSchedule: base + "/api/mfl-export?" + q({ TYPE: "nflSchedule", L: L, YEAR: Y, JSON: 1, W: "ALL" }),
      box: function (id) { return base + "/api/player-weekly-box?" + q({ season: Y, mfl_id: id, L: L }); },
      // ids: a comma-separated list, already unique, ascending and at most PROJECTION_IDS long (projections() makes it)
      projections: function (season, week, ids) { return base + "/api/player-projections?" + q({ season: season, week: week, ids: ids }); },
      positionStats: function (season, through, group) { return base + "/api/position-season-stats?" + q({ season: season, through: through, group: group }); }
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
    var LIMIT = { status: 4 * 60 * 1000 + 30 * 1000, matchups: 5 * 60 * 1000, weekly: 60 * 60 * 1000, scores: 10 * 60 * 1000, players: 6 * 60 * 60 * 1000, box: 60 * 60 * 1000, projections: 5 * 60 * 1000, positionStats: 60 * 60 * 1000 };
    function cached(key, limit, run, force) {
      var m = memo[key], now = Date.now();
      if (!force && m) {
        if (m.state === "loading") return m.promise;
        // R7: "absent" (not deployed, or not recorded) is kept like an answer: it is asked again only after the freshness limit, never in a loop
        if ((m.state === "ok" || m.state === "absent") && now - m.at <= limit) return m.promise;
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
            var sc = e.score, pid = String(e.id);
            if (sc == null || (typeof sc === "string" && sc.trim() === "")) return;   // nothing recorded
            var n = typeof sc === "number" ? sc : typeof sc === "string" && /^-?\d+(?:\.\d+)?$/.test(sc.trim()) ? Number(sc.trim()) : NaN;
            // a recorded value that is not a plain decimal with at most two places (text, a boolean, an object, hex, an exponent, 12.345) is kept as text: unreadable,
            // never turned into a number and never silently dropped; an id listed twice stays unreadable if either row is
            var unreadable = !isFinite(n) || Math.abs(n * 100 - Math.round(n * 100)) > 1e-6;
            if (unreadable) map[pid] = typeof sc === "string" ? sc.trim() : "unreadable"; else if (typeof map[pid] !== "string") map[pid] = n;
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

    // PR A: MFL's complete player list, kept in memory for six hours. Only { pos, club, name } per player id is kept (the name is MFL's "Last, First"
    // string); it names a player on a cap adjustment (PR A) and gives the position and club that feed the position pools of the ranks (PR B). One read, shared.
    // An answer with no players is an error, never "no players": nothing is named or ranked from a read that came back empty.
    function loadPlayers(force) {
      return cached("players", LIMIT.players, function () {
        return settle(get(urls.players, "player list")).then(function (r) {
          if (r.state !== "ok") return r;
          var pl = r.data && r.data.players, rows = pl && pl.player;
          rows = Array.isArray(rows) ? rows : rows ? [rows] : [];
          if (!rows.length) return { state: "error", data: null, error: "Unexpected answer" };
          var byId = {};
          rows.forEach(function (e) {
            if (!e || e.id == null) return;
            var id = String(e.id).trim(), name = typeof e.name === "string" ? e.name.trim() : "";
            if (id && name) byId[id] = { pos: String(e.position == null ? "" : e.position).trim(), club: String(e.team == null ? "" : e.team).trim(), name: name };
          });
          if (!Object.keys(byId).length) return { state: "error", data: null, error: "Unexpected answer" };
          return { state: "ok", data: { byId: byId }, at: Date.now() };
        });
      }, force);
    }
    // PR B: one week of the NFL schedule, parsed to games right away (two clubs, seconds remaining, whether both have a score).
    // MFL's own list of every NFL club with its bye week, and the whole season's schedule (one read, parsed at once and reduced to what the preview uses). Used to
    // confirm that every week's schedule accounts for every club and that older weeks are complete. Asked once and kept for 10 minutes.
    function loadCalendar(parse, force) {
      return cached("cal", 10 * 60 * 1000, function () {
        return Promise.all([settle(get(urls.byes, "NFL bye weeks")), settle(get(urls.fullSchedule, "NFL schedule, all weeks"))]).then(function (rs) {
          if (rs[0].state !== "ok") return rs[0];
          if (rs[1].state !== "ok") return rs[1];
          var cal = null; try { cal = parse(rs[0].data, rs[1].data); } catch (e) { cal = null; }
          if (!cal) return { state: "error", data: null, error: "Unexpected answer" };
          cal.days = gameDays(rs[1].data);   // R6: each game's kickoff, home flag and score, for the game log (kept apart from what completion uses)
          return { state: "ok", data: cal, at: Date.now() };
        });
      }, force);
    }
    // R6: from the whole-season schedule, only what a game log shows: per week, each game's kickoff (Unix seconds), seconds remaining, and per club its id,
    // home flag and score, exactly as MFL sent them (lib/boxlog.js reads them; a missing field stays missing).
    function gameDays(j) {
      var out = {}, fs = j && j.fullNflSchedule, list = fs ? fs.nflSchedule : null;
      list = Array.isArray(list) ? list : list ? [list] : [];
      list.forEach(function (e) {
        if (!e || e.week == null) return;
        var ms = Array.isArray(e.matchup) ? e.matchup : e.matchup ? [e.matchup] : [];
        out[String(e.week).trim()] = ms.map(function (m) {
          var tm = m && Array.isArray(m.team) ? m.team : [];
          return { kickoff: m && m.kickoff != null ? String(m.kickoff) : null, secs: m && m.gameSecondsRemaining != null ? String(m.gameSecondsRemaining) : null,
            teams: tm.map(function (t) { return { id: String(t && t.id || ""), isHome: t && t.isHome != null ? String(t.isHome) : null, score: t && t.score != null ? String(t.score) : null }; }) };
        });
      });
      return out;
    }
    // R7: a read settled with its HTTP status kept (get() pushes its log entry before it returns, so the last entry is this read's).
    function settleStatus(url, label) {
      var p = get(url, label), entry = log[log.length - 1];
      return settle(p).then(function (r) { r.status = entry ? entry.status : null; return r; });
    }
    // "not available": a draft route that is not deployed answers 404; in recorded mode a route that is not in the recording answers 404 too (and is
    // counted as a miss by lib/recorded.js). Either way the screen says Not available; it is not an error and it is not asked again in a loop.
    function absentIf404(r) { return r.state === "error" && r.status === 404 ? { state: "absent", data: null, error: "Not available" } : r; }
    // R6: one player's NFL game stats for the season. R7: in recorded-data mode the read goes to the recording like every other read (no network): a player
    // whose game stats were recorded gets them; any other player's read is a counted miss and comes back "absent". An id that is not a plain MFL id is refused
    // before any request.
    function loadWeeklyBox(id, force) {
      var pid = String(id == null ? "" : id).trim();
      if (!/^\d{1,7}$/.test(pid)) return Promise.resolve({ state: "error", data: null, error: "Unexpected player id" });
      return cached("box:" + pid, LIMIT.box, function () {
        return settleStatus(urls.box(pid), "game stats, player " + pid).then(function (r) {
          if (cfg.data === "recorded") r = absentIf404(r);
          if (r.state !== "ok") return r;
          var j = r.data;
          if (!j || j.ok !== true || !Array.isArray(j.weeks)) return { state: "error", data: null, error: "Unexpected answer" };
          return { state: "ok", data: j, at: Date.now() };
        });
      }, force);
    }

    // R7: the captured MFL projections of some players for one week (draft #1515 /api/player-projections). `ids`: an array or a comma-separated text of MFL ids.
    // The ids are made unique and ascending and asked in groups of at most PROJECTION_IDS (the route's own limit), each group once per freshness window.
    // -> { state: "ok", data: { season, week, provider, projections: { id: { projected_score, captured_at, first_projected, first_captured_at, capture_count } | null } } },
    //    { state: "absent" } (the route is not deployed, or not in the recording), or { state: "error" }. A player with no stored row is null, never 0.
    // This read does not decide "pregame": the caller compares captured_at (or first_captured_at) with the kickoff of the game he played (lib/data.js gameDays).
    function projections(season, week, ids, force) {
      var s = String(season == null ? "" : season).trim(), w = Number(week);
      if (!/^\d{4}$/.test(s) || !(Math.floor(w) === w && w >= 1 && w <= 22)) return Promise.resolve({ state: "error", data: null, error: "Unexpected season or week" });
      var list = normIds(ids);
      if (!list) return Promise.resolve({ state: "error", data: null, error: "Unexpected player id" });
      if (!list.length) return Promise.resolve({ state: "ok", data: { season: Number(s), week: w, provider: "", projections: {} } });
      var groups = [];
      for (var i = 0; i < list.length; i += PROJECTION_IDS) groups.push(list.slice(i, i + PROJECTION_IDS));
      return Promise.all(groups.map(function (g) {
        var url = urls.projections(s, w, g.join(","));
        return cached("proj:" + url, LIMIT.projections, function () {
          return settleStatus(url, "projections, week " + w).then(function (r) {
            r = absentIf404(r);
            if (r.state !== "ok") return r;
            var j = r.data;
            if (!j || j.ok !== true || Number(j.season) !== Number(s) || Number(j.week) !== w || !j.projections || typeof j.projections !== "object" || Array.isArray(j.projections)) return { state: "error", data: null, error: "Unexpected answer" };
            var out = {};
            for (var k = 0; k < g.length; k++) {
              var e = Object.prototype.hasOwnProperty.call(j.projections, g[k]) ? j.projections[g[k]] : undefined;
              if (e === undefined) return { state: "error", data: null, error: "Unexpected answer" };   // every asked id is answered (null when there is no row)
              if (e !== null && (typeof e !== "object" || Array.isArray(e))) return { state: "error", data: null, error: "Unexpected answer" };
              out[g[k]] = e === null ? null : { projected_score: numOrNull(e.projected_score), captured_at: strOrNull(e.captured_at), first_projected: numOrNull(e.first_projected), first_captured_at: strOrNull(e.first_captured_at), capture_count: numOrNull(e.capture_count) };
            }
            return { state: "ok", data: { provider: String(j.provider || ""), projections: out }, at: Date.now() };
          });
        }, force);
      })).then(function (rs) {
        for (var a = 0; a < rs.length; a++) if (rs[a].state === "error") return { state: "error", data: null, error: rs[a].error };
        for (var b = 0; b < rs.length; b++) if (rs[b].state !== "ok") return { state: "absent", data: null, error: "Not available" };
        var merged = {}, provider = "";
        rs.forEach(function (r) { provider = provider || r.data.provider; Object.keys(r.data.projections).forEach(function (id) { merged[id] = r.data.projections[id]; }); });
        return { state: "ok", data: { season: Number(s), week: w, provider: provider, projections: merged } };
      });
    }
    // R7: one position group's league-wide season sums through a week (draft #1515 /api/position-season-stats): the answer as sent (players[] with mfl_id,
    // games, snap_games, s: sums, cov: coverage when a field is missing in some weeks), or { state: "absent" } / { state: "error" }. Ranks are the caller's.
    function positionSeasonStats(season, through, group, force) {
      var s = String(season == null ? "" : season).trim(), t = Number(through), g = String(group == null ? "" : group).trim().toUpperCase();
      if (!/^\d{4}$/.test(s) || !(Math.floor(t) === t && t >= 1 && t <= 18) || POSITION_GROUPS.indexOf(g) < 0) return Promise.resolve({ state: "error", data: null, error: "Unexpected season, week or group" });
      var url = urls.positionStats(s, t, g);
      return cached("pss:" + url, LIMIT.positionStats, function () {
        return settleStatus(url, "season totals, " + g + " through week " + t).then(function (r) {
          r = absentIf404(r);
          if (r.state !== "ok") return r;
          var j = r.data;
          if (!j || j.ok !== true || Number(j.season) !== Number(s) || Number(j.through) !== t || j.group !== g || !Array.isArray(j.players)) return { state: "error", data: null, error: "Unexpected answer" };
          return { state: "ok", data: j, at: Date.now() };
        });
      }, force);
    }

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

    return { urls: urls, log: log, get: get, loadCore: loadCore, loadPenalty: loadPenalty, loadNextSeason: loadNextSeason, loadPlayers: loadPlayers, loadCalendar: loadCalendar, loadSchedule: loadSchedule, loadStatus: loadStatus, loadMatchups: loadMatchups, loadScores: loadScores, loadWeekly: loadWeekly, loadWeeklyBox: loadWeeklyBox, projections: projections, positionSeasonStats: positionSeasonStats, clearErrors: clearErrors, summary: summary };
  }

  return { RULES: RULES, check: check, createLoader: createLoader, PROJECTION_IDS: PROJECTION_IDS, POSITION_GROUPS: POSITION_GROUPS, normIds: normIds };
});
