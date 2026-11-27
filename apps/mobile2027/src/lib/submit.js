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

  // The ONE write request (both writes use it): a POST of a JSON body to one of the two write routes, with a new Idempotency-Key each time.
  // Trades v1 (Keith 2026-11-26 "go trades v1"): the classic app's three trade POSTs. The compliance check and the accept review are POSTs that
  // change nothing on MFL; the test worker ledgers every POST, so each carries its own key too.
  var WRITES = ["/api/submit-lineup", "/roster-workbench/action", "/api/trades/proposals", "/api/trades/proposals/action", "/api/trades/compliance-preview",
    "/api/trades/3way", "/api/trades/3way/cancel", "/api/trades/3way/recheck"];   // Trades v2 (Keith 2026-11-26): the classic app's 3-team routes
  function post(cfg, route, bodyObj, key, params) {
    var t = token();
    if (WRITES.indexOf(route) < 0 || !t) return Promise.reject(new Error(!t ? "Not signed in" : "Unknown write"));
    var p = Object.assign({}, params || {}); p[SESSION] = t;
    return send(address(cfg, route, p), {
      method: "POST", mode: "cors", credentials: "omit", cache: "no-store", redirect: "error",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(bodyObj),
    }).then(readJson);
  }

  // The lineup write. Resolves to { state, title, text, key, week, starters } where state is "confirmed", "different", "unconfirmed" or "refused".
  function lineup(cfg, fid, week, starters) {
    var t = token();
    if (!t) return Promise.resolve({ state: "refused", title: "Lineup NOT submitted", text: "Your lineup on MFL is unchanged.", reason: "Not signed in" });
    var key = newKey();
    return post(cfg, "/api/submit-lineup", { franchiseId: fid, week: String(week), starters: starters.map(String) }, key).then(function (r) {
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
        if (!miss.length && !extra.length) return { state: "confirmed", title: "Lineup submitted", text: "Confirmed on MFL · week " + wk + ".", key: key, week: wk, starters: onMfl };
        return { state: "different", title: "MFL shows a different lineup", text: "MFL’s lineup is shown.", key: key, week: wk, starters: onMfl };
      }, function (e) { return { state: "unconfirmed", title: "Submitted, not confirmed", text: "MFL accepted it; reading it back failed (" + (e && e.message || e) + ").", key: key, week: wk, starters: null }; });
    }, function (e) {
      return { state: "unconfirmed", title: "No answer", text: "The test worker didn’t answer (" + (e && e.message || e) + "). Check MFL before submitting again.", key: key };
    });
  }

  // F8 (Keith 2026-11-26): a roster move on the owner's own player, through the classic app's route (/roster-workbench/action, owner session).
  // The worker checks the league rules it owns (IR eligibility from MFL's injury designations; the full taxi gate, failing closed), sends MFL's import
  // with the owner's own cookie, and reads the roster back (verification). Only these four moves exist here.
  var MOVES = { deactivate_ir: { ok: "Moved to IR", no: "Not moved to IR" }, activate_ir: { ok: "Activated from IR", no: "Not activated" },
    demote_taxi: { ok: "Moved to the taxi squad", no: "Not moved to taxi" }, promote_taxi: { ok: "Promoted from taxi", no: "Not promoted" },
    drop_player: { ok: "Player dropped", no: "Not dropped" } };   // Drop (Keith 2026-11-26)
  function rosterMove(cfg, fid, pid, action) {
    var M = MOVES[action];
    if (!M) return Promise.resolve({ state: "refused", noTitle: "Not moved", text: "Nothing changed on MFL.", reason: "Unknown move" });
    if (!token()) return Promise.resolve({ state: "refused", noTitle: M.no, text: "Nothing changed on MFL.", reason: "Not signed in" });
    var key = newKey();
    return post(cfg, "/roster-workbench/action", { action: action, league_id: String(cfg.leagueId), season: String(cfg.season), franchise_id: fid, player_id: String(pid) }, key).then(function (r) {
      var b = r.body || {}, base = { key: key, okTitle: M.ok, noTitle: M.no, action: action };
      if (r.ok && b.ok && b.verification && b.verification.ok) return Object.assign(base, { state: "confirmed", text: "Confirmed on MFL." });   // Keith 2026-11-26: short; not the worker's message
      if (r.ok && (b.error_code === "MFL_WRITE_UNCONFIRMED" || (b.ok && !(b.verification && b.verification.ok)))) return Object.assign(base, { state: "unconfirmed", title: "Sent, not confirmed", text: "Couldn’t read your roster back." });
      return Object.assign(base, { state: "refused", text: "Nothing changed on MFL.", reason: String(b.error || b.message || b.code || b.error_code || ("HTTP " + r.status)) });
    }, function (e) { return { state: "unconfirmed", title: "No answer", text: "The test worker didn’t answer (" + (e && e.message || e) + "). Check MFL before trying again.", key: key, okTitle: M.ok, noTitle: M.no }; });
  }

  // ---- Trades v1 (Keith 2026-11-26): the classic app's routes (site/m/views/trade.js), two-team offers only ----
  function signed(p) { var o = p || {}; o[SESSION] = token(); return o; }
  function keyed(r, key) { r.key = key; return r; }
  // Offers this team sent or received: MFL's live pending trades through the worker (it needs the owner's own sign-in).
  function tradeOffers(cfg, fid) {
    if (!token()) return Promise.resolve({ ok: false, status: 401, body: null });
    return getJson(address(cfg, "/api/trades/proposals", signed({ YEAR: cfg.season, franchise_id: fid, _: Date.now() })));
  }
  // One team's players and future picks (the trade builder's lists).
  function tradeAssets(cfg, fid) { return getJson(address(cfg, "/api/franchise-assets", { YEAR: cfg.season, fid: fid })); }
  // When MFL stops accepting trades (MFL's own calendar, read by the worker).
  function tradeLock(cfg) { return getJson(address(cfg, "/api/league-events", { season: cfg.season })); }
  // MFL's roster for one team now (past the worker's short cache): the accept's read-back.
  function rosterIds(cfg, fid) {
    var p = { TYPE: "rosters", YEAR: cfg.season, FRANCHISE: fid, JSON: 1 }; p._ = Date.now();
    return getJson(address(cfg, "/api/mfl-export", p)).then(function (r) {
      if (!r.ok || !r.body || !r.body.rosters) throw new Error("MFL’s roster couldn’t be read back");
      var ids = [];
      arr(r.body.rosters.franchise).forEach(function (f) { if (pad4(f.id) === fid) arr(f.player).forEach(function (x) { ids.push(String(x.id)); }); });
      return ids;
    });
  }
  // The worker's cap, roster and loaded-contract check for a trade (changes nothing).
  function tradeCheck(cfg, fid, movements) {
    var key = newKey();
    return post(cfg, "/api/trades/compliance-preview", { league_id: String(cfg.leagueId), season: String(cfg.season), from_franchise_id: fid, movements: movements }, key).then(function (r) { return keyed(r, key); });
  }
  // accept | reject | revoke on MFL, or the read-only accept review (preview) and the cap acknowledgment (ack_cap).
  var VERBS = ["accept", "reject", "revoke", "preview", "ack_cap"];
  function tradeAction(cfg, fid, verb, tradeId, message) {
    if (VERBS.indexOf(verb) < 0) return Promise.reject(new Error("Unknown trade action"));
    var key = newKey();
    return post(cfg, "/api/trades/proposals/action", { action: verb, trade_id: String(tradeId), league_id: String(cfg.leagueId), franchise_id: fid, acting_franchise_id: fid, year: String(cfg.season), message: String(message || "").slice(0, 2000) }, key).then(function (r) { return keyed(r, key); });
  }
  // A new two-team offer (the classic builder's body). capAck: the signature of an overage the sender acknowledged.
  function tradeCreate(cfg, body, capAck) {
    var key = newKey(), b = Object.assign({}, body);
    if (capAck) b.cap_ack = { signature: String(capAck) };
    return post(cfg, "/api/trades/proposals", b, key).then(function (r) { return keyed(r, key); });
  }

  // ---- 3-team trades (the classic app's /api/trades/3way routes) ----
  function threeParams(cfg, fid, extra) { return signed(Object.assign({ YEAR: cfg.season, acting_franchise_id: fid }, extra || {})); }
  function threeList(cfg, fid) {
    if (!token()) return Promise.resolve({ ok: false, status: 401, body: null });
    return getJson(address(cfg, "/api/trades/3way", threeParams(cfg, fid, { franchise_id: fid, _: Date.now() })));
  }
  function threePost(cfg, fid, route, bodyObj) {
    var key = newKey();
    if (!token()) return Promise.resolve({ ok: false, status: 401, body: { error: "Not signed in" }, key: key });
    return post(cfg, route, bodyObj, key, { YEAR: cfg.season, acting_franchise_id: fid }).then(function (r) { return keyed(r, key); });
  }
  function threeCreate(cfg, fid, body) { return threePost(cfg, fid, "/api/trades/3way", body); }
  function threeCancel(cfg, fid, id) { return threePost(cfg, fid, "/api/trades/3way/cancel", { id: String(id), acting_franchise_id: fid }); }
  function threeRecheck(cfg, fid, id) { return threePost(cfg, fid, "/api/trades/3way/recheck", { id: String(id), acting_franchise_id: fid }); }

  root.UPS2027 = root.UPS2027 || {};
  root.UPS2027.submit = { token: token, signOut: signOut, whoami: whoami, lineup: lineup, rosterMove: rosterMove, mflStarters: mflStarters,
    trades: { offers: tradeOffers, assets: tradeAssets, lock: tradeLock, rosterIds: rosterIds, check: tradeCheck, action: tradeAction, create: tradeCreate,
      threeList: threeList, threeCreate: threeCreate, threeCancel: threeCancel, threeRecheck: threeRecheck } };
})(window);
