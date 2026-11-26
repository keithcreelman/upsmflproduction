// MFL 2.0 Release 1: every call the app makes. Reads use routes the current phone app already uses (site/m); the ONE
// write is the lineup submit (POST /api/submit-lineup), with an Idempotency-Key the test worker's ledger requires.
// Every request names the league explicitly (L=) and omits credentials (the worker answers ACAO: *).
(function () {
  "use strict";
  var CFG = window.UPS2_CONFIG || {};
  var BASE = String(CFG.worker || "");
  var L = String(CFG.league || "");
  var TOKEN_KEY = "ups_mfl_user_id";   // same key and same site as the current app, so one sign-in serves both

  // Sign-in: the MFL page link forwards MFL_USER_ID once; keep it on this device and take it out of the address bar.
  (function captureToken() {
    try {
      var u = new URL(window.location.href);
      var t = u.searchParams.get("MFL_USER_ID") || u.searchParams.get("mfl_user_id");
      if (t) {
        try { window.localStorage.setItem(TOKEN_KEY, t); } catch (e) { /* private mode: this visit only */ window.__ups2Token = t; }
        u.searchParams.delete("MFL_USER_ID"); u.searchParams.delete("mfl_user_id");
        window.history.replaceState(null, "", u.pathname + (u.search || "") + u.hash);
      }
    } catch (e) { /* leave the URL alone */ }
  })();
  function token() { try { return window.localStorage.getItem(TOKEN_KEY) || window.__ups2Token || ""; } catch (e) { return window.__ups2Token || ""; } }
  function signOut() { try { window.localStorage.removeItem(TOKEN_KEY); } catch (e) {} window.__ups2Token = ""; }

  function url(path, params) {
    var u = new URL(BASE + path);
    u.searchParams.set("L", L);
    Object.keys(params || {}).forEach(function (k) { if (params[k] != null && params[k] !== "") u.searchParams.set(k, String(params[k])); });
    return u.toString();
  }
  function getJson(path, params) {
    return fetch(url(path, params), { mode: "cors", credentials: "omit" }).then(function (r) {
      return r.text().then(function (t) {
        var j = null; try { j = JSON.parse(t); } catch (e) { j = null; }
        if (!r.ok) { var err = new Error((j && (j.error || j.message)) || ("HTTP " + r.status)); err.status = r.status; err.body = j; throw err; }
        if (j == null) throw new Error("unreadable answer from the worker");
        return j;
      });
    });
  }
  function arr(x) { return x == null ? [] : Array.isArray(x) ? x : [x]; }
  function pad4(x) { var s = String(x == null ? "" : x).trim(); return s ? ("0000" + s).slice(-4) : ""; }

  var season = null;
  function activeSeason() {
    if (season) return Promise.resolve(season);
    return getJson("/api/active-season").then(function (j) {
      var s = String((j && j.season) || "");
      if (!/^\d{4}$/.test(s)) throw new Error("the active season couldn't be resolved");   // never guess from the calendar
      season = s; return s;
    });
  }
  function mflExport(type, extra, fresh) {
    return activeSeason().then(function (y) {
      var p = Object.assign({ TYPE: type, YEAR: y, JSON: 1 }, extra || {});
      if (fresh) p._ = Date.now();   // skip the worker's short cache right after a save
      return getJson("/api/mfl-export", p);
    });
  }
  function me() {
    var t = token();
    if (!t) return Promise.resolve({ signedIn: false });
    return getJson("/api/me", { MFL_USER_ID: t }).then(function (j) {
      var fid = pad4(j && j.franchise_id);
      if (!j || !j.configured || !fid || fid === "0000") return { signedIn: false, reason: "MFL didn't match this sign-in to a team in league " + L };
      return { signedIn: true, fid: fid, name: j.franchise_name || "", commish: !!j.is_commish };
    }).catch(function (e) { return { signedIn: false, reason: e.message }; });
  }
  function capPreview() { return activeSeason().then(function (y) { return getJson("/api/cap-penalty/preview", { YEAR: y }); }); }
  function lineupWeek() { return getJson("/api/current-lineup-week").then(function (j) { var w = parseInt(j && j.week, 10); if (!(w > 0)) throw new Error("the current week couldn't be resolved"); return w; }); }
  function savedLineup(week) { return getJson("/api/lineup", { W: week, MFL_USER_ID: token() }); }

  // MFL's own answer for who starts this week (liveScoring), used to check a save independently of the worker's records.
  function mflStarters(week, fid) {
    return mflExport("liveScoring", { W: week }, true).then(function (j) {
      var found = null;
      arr(j && j.liveScoring && j.liveScoring.matchup).forEach(function (m) {
        arr(m.franchise).forEach(function (f) {
          if (pad4(f.id) !== fid || found) return;
          found = arr(f.players && f.players.player).filter(function (p) { return p.status === "starter"; }).map(function (p) { return String(p.id); });
        });
      });
      arr(j && j.liveScoring && j.liveScoring.franchise).forEach(function (f) {   // bye-week shape
        if (pad4(f.id) !== fid || found) return;
        found = arr(f.players && f.players.player).filter(function (p) { return p.status === "starter"; }).map(function (p) { return String(p.id); });
      });
      return found;   // null = MFL's answer didn't include this team
    });
  }

  function newKey() {
    var c = window.crypto;
    if (c && typeof c.randomUUID === "function") return "m2-" + c.randomUUID();
    var b = new Uint8Array(16); c.getRandomValues(b);
    return "m2-" + Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join("");
  }
  // The only write in Release 1.
  function submitLineup(fid, week, starters) {
    var key = newKey();
    return fetch(url("/api/submit-lineup", { MFL_USER_ID: token() }), {
      method: "POST", mode: "cors", credentials: "omit",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify({ franchiseId: fid, week: String(week), starters: starters }),
    }).then(function (r) {
      return r.text().then(function (t) {
        var j = null; try { j = JSON.parse(t); } catch (e) { j = null; }
        return { httpOk: r.ok, status: r.status, body: j, key: key, ledger: r.headers.get("x-ups-ledger-state") };
      });
    });
  }

  window.UPS2_API = { L: L, token: token, signOut: signOut, activeSeason: activeSeason, mflExport: mflExport, me: me,
    capPreview: capPreview, lineupWeek: lineupWeek, savedLineup: savedLineup, mflStarters: mflStarters,
    submitLineup: submitLineup, arr: arr, pad4: pad4 };
})();
