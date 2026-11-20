/* UPS 2027 Preview 0: the ONLY code that talks to the network.

   Read-only by construction:
   - every request is a plain GET with credentials omitted and no custom headers;
   - the address must be the UPS worker, one of four allowed paths, and only the query names listed below;
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
    { path: "/api/mfl-export", query: ["TYPE", "L", "YEAR", "JSON", "W"], types: ["league", "weeklyResults"] },
    { path: "/api/current-lineup-week", query: ["L", "YEAR"] },
    { path: "/api/cap-penalty/preview", query: ["L", "YEAR"] }
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
      penalty: base + "/api/cap-penalty/preview?" + q({ L: L, YEAR: Y })
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
    function loadCore() {
      var rw = settle(get(urls.roster, "roster and contracts"));
      var league = settle(get(urls.league, "league limits"));
      var weekRead = settle(get(urls.week, "current lineup week"));
      return Promise.all([rw, league, weekRead]).then(function (r) {
        var wk = r[2].state === "ok" && r[2].data && r[2].data.ok !== false ? parseInt(r[2].data.week, 10) : NaN;
        var week = isFinite(wk) ? wk : null;
        var weeklyP = week ? settle(get(urls.weekly(week), "submitted lineups, week " + week)) : Promise.resolve({ state: "error", data: null, error: "Lineup week unknown" });
        return weeklyP.then(function (weekly) { return { roster: r[0], league: r[1], week: week, weekRead: r[2], weekly: weekly }; });
      });
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

    return { urls: urls, log: log, get: get, loadCore: loadCore, loadPenalty: loadPenalty, summary: summary };
  }

  return { RULES: RULES, check: check, createLoader: createLoader };
});
