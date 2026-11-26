/* UPS 2027 R13 F3 (Keith, 2026-11-26: "Now F3"): the app's ONE write, submitting this week's lineup. TEST TARGET ONLY.
   build.mjs adds this file only to the Test target (league 25625 through the UPS TEST worker); the Preview build never contains it, and the
   build gives it its own scan (scanSubmit): one POST, to /api/submit-lineup, with an Idempotency-Key, credentials omitted, through one
   network line. Everything else the app reads still goes through lib/data.js (GET only).

   Sign-in: the MFL session id the UPS TEST site already keeps on this device (the classic test app stores it after the 25625 home-page
   link); a link that brings it here is taken once and removed from the address bar. It is sent only to the TEST worker.
   After MFL accepts, MFL's own weekly results for the week are read again (past the worker's short cache) and compared starter by starter. */
(function (root) {
  "use strict";
  var KEY = "ups_mfl_user_id", SESSION = "MFL_USER_ID";
  var captured = "";
  (function capture() {
    try {
      var u = new URL(root.location.href), t = u.searchParams.get(SESSION);
      if (!t) return;
      captured = t;
      try { root.localStorage.setItem(KEY, t); } catch (e) { /* private window: this visit only */ }
      u.searchParams.delete(SESSION);
      root.history.replaceState(null, "", u.pathname + u.search + u.hash);
    } catch (e) { /* the address is left alone */ }
  })();
  function token() { try { return root.localStorage.getItem(KEY) || captured; } catch (e) { return captured; } }
  function signOut() { captured = ""; try { root.localStorage.removeItem(KEY); } catch (e) { /* nothing stored */ } }
  function pad4(x) { var s = String(x == null ? "" : x).trim(); return s ? ("0000" + s).slice(-4) : ""; }
  function arr(x) { return x == null ? [] : Array.isArray(x) ? x : [x]; }

  function address(cfg, path, params) {
    var u = new URL(String(cfg.workerBase).replace(/\/+$/, "") + path);
    u.searchParams.set("L", String(cfg.leagueId));
    Object.keys(params || {}).forEach(function (k) { if (params[k] != null && params[k] !== "") u.searchParams.set(k, String(params[k])); });
    return u.toString();
  }
  // the module's one network line
  function send(url, opts) { return root.fetch(url, opts); }
  function readJson(r) { return r.text().then(function (t) { var j = null; try { j = JSON.parse(t); } catch (e) { j = null; } return { status: r.status, ok: r.ok, body: j, ledger: r.headers.get("x-ups-ledger-state") || "" }; }); }
  function getJson(url) { return send(url, { method: "GET", mode: "cors", credentials: "omit", cache: "no-store", redirect: "error" }).then(readJson); }

  // Whose team this sign-in is: MFL's answer through the worker. No sign-in, or no team in this league, is "signed out".
  function whoami(cfg) {
    var t = token();
    if (!t) return Promise.resolve({ signedIn: false, why: "Not signed in" });
    var p = {}; p[SESSION] = t;
    return getJson(address(cfg, "/api/me", p)).then(function (r) {
      var fid = pad4(r.body && r.body.franchise_id);
      if (!r.ok || !r.body || !r.body.configured || !fid || fid === "0000") return { signedIn: false, why: "This sign-in has no team in league " + cfg.leagueId };
      return { signedIn: true, fid: fid, name: String(r.body.franchise_name || "") };
    }, function () { return { signedIn: false, why: "Couldn’t check the sign-in" }; });
  }

  // MFL's weekly results for one team: the starters MFL holds now (null when the answer has no entry for the team).
  function mflStarters(cfg, week, fid) {
    var p = { TYPE: "weeklyResults", YEAR: cfg.season, W: week, JSON: 1 }; p._ = Date.now();   // past the worker's short cache
    return getJson(address(cfg, "/api/mfl-export", p)).then(function (r) {
      if (!r.ok || !r.body || !r.body.weeklyResults) throw new Error("MFL’s lineup for week " + week + " couldn’t be read back");
      var found = null, W = r.body.weeklyResults;
      arr(W.matchup).forEach(function (m) { arr(m.franchise).forEach(function (f) { if (!found && pad4(f.id) === fid) found = f; }); });
      arr(W.franchise).forEach(function (f) { if (!found && pad4(f.id) === fid) found = f; });
      if (!found) return null;
      var st = found.starters ? String(found.starters).split(",").filter(Boolean) : arr(found.player).filter(function (x) { return x.status === "starter"; }).map(function (x) { return String(x.id); });
      return st;
    });
  }

  function newKey() {
    var c = root.crypto;
    if (c && typeof c.randomUUID === "function") return "m27-" + c.randomUUID();
    var b = new Uint8Array(16); c.getRandomValues(b);
    return "m27-" + Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join("");
  }

  // The write. Resolves to { state, title, text, key, week, starters } where state is "confirmed", "different", "unconfirmed" or "refused".
  function lineup(cfg, fid, week, starters) {
    var t = token();
    if (!t) return Promise.resolve({ state: "refused", title: "Lineup NOT submitted", text: "Your lineup on MFL is unchanged.", reason: "Not signed in" });
    var key = newKey(), p = {}; p[SESSION] = t;
    var body = JSON.stringify({ franchiseId: fid, week: String(week), starters: starters.map(String) });
    return send(address(cfg, "/api/submit-lineup", p), {
      method: "POST", mode: "cors", credentials: "omit", cache: "no-store", redirect: "error",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: body,
    }).then(readJson).then(function (r) {
      var b = r.body || {};
      if (!r.ok || !b.ok) {
        var why = b.error || (b.mfl_response && b.mfl_response.error && (b.mfl_response.error.$t || b.mfl_response.error)) || ("HTTP " + r.status);
        return { state: "refused", title: "Lineup NOT submitted", text: "Your lineup on MFL is unchanged.", reason: String(why), key: key };
      }
      var wk = String(b.week_used || week);
      return mflStarters(cfg, wk, fid).then(function (onMfl) {
        if (!onMfl) return { state: "unconfirmed", title: "Submitted, not confirmed", text: "MFL accepted it, but its results for week " + wk + " don’t list this team yet.", key: key, week: wk, starters: null };
        var want = {}, miss = [], extra = [];
        starters.forEach(function (x) { want[String(x)] = 1; });
        starters.forEach(function (x) { if (onMfl.indexOf(String(x)) < 0) miss.push(String(x)); });
        onMfl.forEach(function (x) { if (!want[x]) extra.push(x); });
        if (!miss.length && !extra.length) return { state: "confirmed", title: "Lineup submitted", text: "MFL shows the same " + onMfl.length + " starter" + (onMfl.length === 1 ? "" : "s") + " for week " + wk + ".", key: key, week: wk, starters: onMfl };
        return { state: "different", title: "Submitted, but MFL shows a different lineup", text: miss.length + " missing on MFL, " + extra.length + " extra on MFL. MFL’s lineup is shown.", key: key, week: wk, starters: onMfl };
      }, function (e) { return { state: "unconfirmed", title: "Submitted, not confirmed", text: "MFL accepted it; reading it back failed (" + (e && e.message || e) + ").", key: key, week: wk, starters: null }; });
    }, function (e) {
      return { state: "unconfirmed", title: "No answer", text: "The test worker didn’t answer (" + (e && e.message || e) + "). Check MFL before submitting again.", key: key };
    });
  }

  root.UPS2027 = root.UPS2027 || {};
  root.UPS2027.submit = { token: token, signOut: signOut, whoami: whoami, lineup: lineup, mflStarters: mflStarters };
})(window);
