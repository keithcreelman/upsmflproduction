/* UPS 2027 Trades (Keith 2026-11-26 "go trades v1"; v2 the same day: "not concise enough … lots of scrolling … no three ways"). TEST TARGET ONLY.
   League › Trades: pending offers (two-team, including ones made on MFL, and three-team) and a builder for both. The baseline is the classic phone
   app (site/m/views/trade.js): the same worker routes, bodies and gates. Compact by design: an offer is two short lines, the builder lists only
   what is picked, and a team's players and picks open in a sheet (the page itself does not grow with a roster).
   This file only draws and builds; it has no network code. app.js runs the requests through lib/submit.js.
   The cap verdict, the loaded-contract limit, the accept gate and a 3-team trade's state are the worker's answers, shown as given. */
(function (root, factory) {
  var req = typeof require === "function";
  var api = factory(req ? require("./format.js") : root.UPS2027.format);
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.UPS2027 = root.UPS2027 || {}; root.UPS2027.trades = api; }
})(typeof self !== "undefined" ? self : this, function (F) {
  "use strict";
  var esc = F.esc, money = F.money;
  function pad4(x) { var s = String(x == null ? "" : x).trim(); return s ? ("0000" + s).slice(-4) : ""; }
  function int(x) { var n = parseInt(x, 10); return isFinite(n) ? n : 0; }
  // $12K, $1.5K, $500
  function k$(n) { var v = Number(n) || 0; if (Math.abs(v) < 1000) return "$" + Math.round(v); var x = Math.round(v / 100) / 10; return "$" + String(x).replace(/\.0$/, "") + "K"; }

  function fresh() {
    return { sub: "offers", mode: 2, offers: { state: "idle" }, three: { state: "idle" }, lock: { state: "idle" }, inv: {}, d: blankDraft(), d3: blankDraft3(),
      chk: { state: "idle", sig: "" }, rv: null, dec: null, can: null, can3: null, ack: null, pk: null, tp: null, note: false, busy: false };
  }
  function blankDraft() { return { to: "", give: {}, get: {}, capGive: 0, capGet: 0, note: "" }; }
  function blankDraft3() { return { b: "", c: "", give: {}, cap: {}, note: "" }; }   // give[fid][token] = destination fid; cap[fid][dest] = $K

  function teamName(S, fid) {
    var t = S.model && S.model.teams.filter(function (x) { return x.id === pad4(fid); })[0];
    return t ? t.name : "Team " + pad4(fid);
  }
  function tokens(s) { return String(s || "").split(/\s*,\s*/).map(function (x) { return x.trim().toUpperCase(); }).filter(Boolean); }

  // One MFL trade token, short. side = the team giving it (a pick that came from another team says whose).
  function tokenLabel(S, tok, side) {
    var t = String(tok || "").toUpperCase(), m;
    if (/^P_\d+$/.test(t)) t = t.slice(2);
    if (/^\d+$/.test(t)) {
      var p = S.model && S.model.byId[t];
      return p ? p.name + " " + p.pos + (p.salary != null ? " " + k$(p.salary) : "") : "Player " + t;
    }
    if ((m = /^FP_(\d{4})_(\d{4})_(\d+)$/.exec(t))) return m[2] + " R" + int(m[3]) + (m[1] !== pad4(side) ? " (" + teamName(S, m[1]) + ")" : "");
    if ((m = /^DP_(\d+)_(\d+)$/.exec(t))) return "Pick " + (int(m[1]) + 1) + "." + ("0" + (int(m[2]) + 1)).slice(-2);   // MFL's DP_ is zero-indexed
    if ((m = /^BB_(\d+(?:\.\d+)?)$/.exec(t))) return k$(Number(m[1])) + " cap";
    return t;
  }
  function line(S, toks, side) { return toks.length ? toks.map(function (t) { return esc(tokenLabel(S, t, side)); }).join(" · ") : '<span class="mu">Nothing</span>'; }

  // ---- the lock: MFL's own "No Trades Allowed" calendar event. Fails closed: a lock that can't be read stops Send and Accept.
  function gate(S, now) {
    var L = S.tr && S.tr.lock;
    if (!L || L.state === "loading" || L.state === "idle") return { ok: false, text: "Checking the trade deadline…" };
    if (L.state !== "ok" || !L.data) return { ok: false, text: "Trade deadline couldn’t be checked." };
    var d = L.data, t = (now || Date.now()) / 1000;
    if (d.state === "none") return { ok: true, text: "" };
    if (d.state === "upcoming" && d.start_unix && t < d.start_unix) return { ok: true, text: d.label ? "Trades lock " + d.label + "." : "" };
    if (d.state === "upcoming" || d.state === "closed") return { ok: false, text: "Trades are locked." };
    return { ok: false, text: "Trade deadline couldn’t be checked." };
  }

  // ---- offers ----
  function offerSides(S, o, me) {
    var inc = pad4(o.to_franchise_id) === me, other = inc ? o.from_franchise_id : o.to_franchise_id;
    var give = tokens(inc ? o.will_receive : o.will_give_up), get = tokens(inc ? o.will_give_up : o.will_receive);
    return { inc: inc, other: pad4(other), give: give, get: get, tid: String(o.trade_id || o.proposal_id || "").replace(/\D/g, "") };
  }
  function when(iso) { var s = iso ? F.etStamp(iso) : ""; return s ? '<small class="mu">' + esc(s) + "</small>" : ""; }
  function offerCard(S, o, me, G) {
    var x = offerSides(S, o, me);
    var btns = !x.tid ? "" : x.inc
      ? '<div class="trb"><button class="btn sm pri" data-act="trreview" data-v="' + esc(x.tid) + '"' + (G.ok ? "" : " disabled") + '>Accept</button><button class="btn sm" data-act="trdecline" data-v="' + esc(x.tid) + '">Decline</button></div>'
      : '<div class="trb"><button class="btn sm" data-act="trcancel" data-v="' + esc(x.tid) + '">Cancel</button></div>';
    return '<div class="card tro"><div class="trh"><b>' + esc((x.inc ? "From " : "To ") + teamName(S, x.other)) + "</b>" + when(o.created_at) + "</div>" +
      '<div class="trln"><span class="trk2">Get</span><span>' + line(S, x.get, x.other) + '</span></div><div class="trln"><span class="trk2">Give</span><span>' + line(S, x.give, me) + "</span></div>" +
      (o.message ? '<div class="ex trm">“' + esc(String(o.message).slice(0, 140)) + "”</div>" : "") + btns + "</div>";
  }
  // A 3-team trade, as the worker describes it (canonical object: participants, movements with asset labels, state_view, permissions).
  function threeCard(S, tr, me) {
    var others = (tr.participants || []).filter(function (p) { return pad4(p.fid) !== me; }).map(function (p) { return p.name || teamName(S, p.fid); });
    var sv = tr.state_view || {}, perm = tr.permissions || {};
    var moves = (tr.movements || []).map(function (m) {
      var to = m.to || {}, fr = m.from || {};
      return '<div class="trln"><span class="trk2">' + esc(pad4(to.fid) === me ? "You get" : (to.name || teamName(S, to.fid)) + " gets") + "</span><span>" +
        esc((m.assets || []).map(function (a) { return a.label; }).join(" · ")) + ' <span class="mu">from ' + esc(pad4(fr.fid) === me ? "you" : fr.name || teamName(S, fr.fid)) + "</span></span></div>";
    }).join("");
    var btns = (perm.can_cancel ? '<button class="btn sm" data-act="tr3cancel" data-v="' + esc(tr.id) + '">Cancel</button>' : "") +
      (perm.can_recheck ? '<button class="btn sm pri" data-act="tr3recheck" data-v="' + esc(tr.id) + '">Re-check</button>' : "");
    return '<div class="card tro"><div class="trh"><b>3-team · ' + esc(others.join(" & ")) + '</b><span class="chip' + (sv.terminal ? "" : " wn") + '">' + esc(sv.label || tr.status || "") + "</span></div>" +
      moves + (btns ? '<div class="trb">' + btns + "</div>" : "") + "</div>";
  }
  function offersBody(S, me, G) {
    var O = S.tr.offers, T3 = S.tr.three;
    var top = '<div class="trtop"><span class="ex' + (G.ok ? "" : " wn") + '">' + esc(G.text || "") + '</span><button class="link" data-act="trload">Refresh</button></div>';
    if (O.state === "loading" || O.state === "idle") return top + '<div class="ex pad">Loading offers…</div>';
    if (O.state !== "ok") return top + '<div class="card warnc"><div class="ex">' + esc(O.why || "Couldn’t read your offers.") + '</div><button class="btn blk" data-act="trload">Try again</button></div>';
    var inc = O.inc || [], out = O.out || [], three = T3.state === "ok" ? T3.list || [] : [];
    var h = top;
    if (inc.length) h += '<div class="sec2">To you · ' + inc.length + "</div>" + inc.map(function (o) { return offerCard(S, o, me, G); }).join("");
    if (out.length) h += '<div class="sec2">Yours · ' + out.length + "</div>" + out.map(function (o) { return offerCard(S, o, me, G); }).join("");
    if (three.length) h += '<div class="sec2">3-team · ' + three.length + "</div>" + three.map(function (t) { return threeCard(S, t, me); }).join("");
    if (T3.state === "error") h += '<div class="ex wn pad">3-team trades couldn’t be read.</div>';
    if (!inc.length && !out.length && !three.length) h += '<div class="ex pad">No pending offers.</div>';
    return h;
  }

  // ---- builder pieces shared by both modes ----
  function pickToken(fp) { return "FP_" + pad4(fp.original_fid) + "_" + String(fp.year) + "_" + String(fp.round); }
  function pickBlocked(fp) {
    if (fp.forfeited === true) return String(fp.forfeit_label || "Forfeited");
    if (int(fp.round) === 6) return "Round 6 can’t be traded";
    return "";
  }
  function invOf(S, fid) { return S.tr.inv[pad4(fid)] || { state: "idle" }; }
  function playerOf(inv, tok) { return ((inv && inv.players) || []).filter(function (p) { return "P_" + p.player_id === tok; })[0] || null; }
  function pickOf(inv, tok) { return ((inv && inv.future_picks) || []).filter(function (fp) { return pickToken(fp) === tok; })[0] || null; }
  function assetText(inv, tok, fid) {
    var p = playerOf(inv, tok); if (p) return p.display + " " + p.position + " " + k$(p.salary) + (p.taxi ? " · Taxi" : "");
    var fp = pickOf(inv, tok); if (fp) return fp.year + " R" + fp.round + (pad4(fp.original_fid) !== pad4(fid) && fp.original_team_name ? " (" + fp.original_team_name + ")" : "");
    return tok;
  }
  // Cap money a side may add: at most half the salary of the non-taxi players it sends (to that team), in whole $1K (the classic app's maxCapKFor).
  function maxCapK(inv, ids, dest) {
    var sum = 0;
    ((inv && inv.players) || []).forEach(function (p) { var v = ids["P_" + p.player_id]; if (v && (dest == null || v === dest) && !p.taxi) sum += int(p.salary); });
    return Math.floor(sum / 2000);
  }
  function selectedAssets(inv, ids) {
    var out = [];
    ((inv && inv.players) || []).forEach(function (p) {
      if (!ids["P_" + p.player_id]) return;
      out.push({ asset_id: "P_" + p.player_id, type: "PLAYER", player_id: String(p.player_id), player_name: p.display || null, description: null,
        position: p.position || null, nfl_team: p.nfl_team || null, salary: int(p.salary), years: p.contract_year == null ? null : p.contract_year,
        contract_type: p.contract_status || null, contract_info: p.contract_info || null, contract_length: p.contract_length == null ? null : p.contract_length,
        already_extended_by_this_franchise: !!p.already_extended_by_this_franchise, taxi: !!p.taxi, pick_key: null, pick_season: null, pick_round: null, pick_slot: null });
    });
    ((inv && inv.future_picks) || []).forEach(function (fp) {
      var tok = pickToken(fp);
      if (!ids[tok] || pickBlocked(fp)) return;
      out.push({ asset_id: tok, type: "PICK", player_id: null, player_name: null, description: fp.display || (fp.year + " R" + fp.round), position: null, nfl_team: null,
        salary: 0, years: null, contract_type: null, contract_info: null, taxi: false, pick_key: tok, pick_season: int(fp.year), pick_round: int(fp.round), pick_slot: null });
    });
    return out;
  }
  function assetToken(a) { return a.type === "PLAYER" ? "P_" + a.player_id : a.pick_key; }

  // ---- two teams: the classic builder's body (POST /api/trades/proposals) plus the check's movements ----
  function build(S, me) {
    var d = S.tr.d, to = pad4(d.to), mine = invOf(S, me), theirs = invOf(S, to);
    var give = selectedAssets(mine, d.give), get = selectedAssets(theirs, d.get);
    var capGive = Math.min(int(d.capGive), maxCapK(mine, d.give)), capGet = Math.min(int(d.capGet), maxCapK(theirs, d.get));
    function nonTaxi(list) { return list.reduce(function (n, a) { return n + (a.type === "PLAYER" && !a.taxi ? int(a.salary) : 0); }, 0); }
    var payload = { schema_version: 1, generated_at: new Date().toISOString(), source: "ups-2027-test-trade-builder", league_id: S.tr.league, season: S.tr.season,
      teams: [
        { role: "left", franchise_id: me, franchise_name: teamName(S, me), selected_assets: give, traded_salary_adjustment_dollars: capGive * 1000, traded_salary_adjustment_k: capGive, traded_salary_adjustment_max_k: 999, selected_non_taxi_salary_dollars: nonTaxi(give) },
        { role: "right", franchise_id: to, franchise_name: teamName(S, to), selected_assets: get, traded_salary_adjustment_dollars: capGet * 1000, traded_salary_adjustment_k: capGet, traded_salary_adjustment_max_k: 999, selected_non_taxi_salary_dollars: nonTaxi(get) }
      ], extension_requests: [], filters: { search: "" }, ui: { left_team_id: me, right_team_id: to } };
    var movements = [];
    if (give.length || capGive > 0) movements.push({ from: me, to: to, asset_tokens: give.map(assetToken), cap_k: capGive });
    if (get.length || capGet > 0) movements.push({ from: to, to: me, asset_tokens: get.map(assetToken), cap_k: capGet });
    var body = { league_id: S.tr.league, season: S.tr.season, from_franchise_id: me, to_franchise_id: to, from_franchise_name: teamName(S, me), to_franchise_name: teamName(S, to),
      message: String(d.note || "").slice(0, 2000), payload: payload };
    // What MFL should then list for this offer (the read-back): each side's tokens, cap money as the BB_ dollars of each side's net.
    function mflTokens(list, net) { var t = list.map(function (a) { return a.type === "PLAYER" ? String(a.player_id) : a.pick_key; }); if (net > 0) t.push("BB_" + net * 1000); return t.sort(); }
    return { body: body, movements: movements, give: give, get: get, capGive: capGive, capGet: capGet, ready: !!(to && give.length && get.length),
      sig: JSON.stringify([2, to, give.map(assetToken).sort(), get.map(assetToken).sort(), capGive, capGet]),
      expect: { giveUp: mflTokens(give, capGive - capGet), receive: mflTokens(get, capGet - capGive) } };
  }
  function findSent(offers, to, expect) {
    var same = function (a, b) { return a.length === b.length && a.every(function (x, i) { return x === b[i]; }); };
    return (offers || []).filter(function (o) { return pad4(o.to_franchise_id) === pad4(to) && same(tokens(o.will_give_up).sort(), expect.giveUp) && same(tokens(o.will_receive).sort(), expect.receive); })[0] || null;
  }

  // ---- three teams: the classic 3-way builder (POST /api/trades/3way). Any team sends any asset to either of the other two (default: the next team
  // in the ring You → B → C → You); cap money per movement, held to half the non-taxi salary that movement carries.
  function ring(S, me) { var d = S.tr.d3; return [me, pad4(d.b), pad4(d.c)]; }
  function ringNext(S, me, giver) { var t = ring(S, me), i = t.indexOf(pad4(giver)); return i < 0 ? t[0] : t[(i + 1) % 3]; }
  function build3(S, me) {
    var d = S.tr.d3, T = ring(S, me), movements = [], count = 0;
    var ready = !!(d.b && d.c && d.b !== d.c);
    T.forEach(function (giver) {
      if (!giver) return;
      var map = d.give[giver] || {}, inv = invOf(S, giver), byDest = {};
      Object.keys(map).forEach(function (tok) {
        var dest = pad4(map[tok]); if (!dest || dest === giver || T.indexOf(dest) < 0) return;
        var fp = pickOf(inv, tok); if (fp && pickBlocked(fp)) return;
        (byDest[dest] = byDest[dest] || []).push(tok); count++;
      });
      T.forEach(function (dest) {
        if (!dest || dest === giver) return;
        var toks = byDest[dest] || [], cap = Math.min(int((d.cap[giver] || {})[dest]), maxCapK(inv, map, dest));
        if (!toks.length && cap <= 0) return;
        movements.push({ from: giver, to: dest, asset_tokens: toks.slice(), cap_k: cap, summary: toks.map(function (t) { return assetText(inv, t, giver); }).join(", ") });
      });
    });
    var body = { league_id: S.tr.league, season: S.tr.season, initiator: { fid: me, name: teamName(S, me) }, team_b: { fid: pad4(d.b), name: teamName(S, d.b) }, team_c: { fid: pad4(d.c), name: teamName(S, d.c) },
      movements: movements, extension_requests: [], notes: String(d.note || "").slice(0, 2000) };
    var check = movements.map(function (m) { return { from: m.from, to: m.to, asset_tokens: m.asset_tokens, cap_k: m.cap_k }; });
    return { body: body, movements: check, ready: ready && count > 0, sig: JSON.stringify([3, T, check]) };
  }

  function canSendWith(S, B, G) {
    var k = S.tr.chk, lc = k.c && k.c.loaded_contracts;
    return !!(G.ok && B.ready && k.state === "ok" && k.sig === B.sig && k.c && k.c.cap && k.c.cap.status !== "unavailable" && (!lc || lc.status === "ok") && !S.tr.busy);
  }
  // Send needs a check of THIS offer with the loaded-contract limit met (fail closed); an over-the-cap two-team offer is acknowledged at Send (classic flow).
  function canSend(S, B, G) { return canSendWith(S, B, G); }

  // The worker's check: one row per team (cap room or overage, loaded contracts), plus a roster heads-up when there is one.
  function checkLines(c) {
    if (!c || !c.cap) return '<div class="ex wn">The salary cap couldn’t be checked.</div>';
    var rows = {}, order = [], lc = c.loaded_contracts, ro = c.roster;
    function row(r) { var k = r.franchise_id || r.franchise_name; if (!rows[k]) { rows[k] = { name: r.franchise_name || r.franchise_id, chips: [] }; order.push(k); } return rows[k]; }
    (c.cap.rows || []).forEach(function (r) { var over = int(r.over_by) > 0; row(r).chips.push('<span class="chip ' + (over ? "cr" : "ok") + '">' + (over ? "Over " + k$(r.over_by) : k$(r.room_after) + " room") + "</span>"); });
    if (lc) (lc.rows || []).forEach(function (r) { var over = int(r.loaded_after) > int(lc.max || 5); row(r).chips.push('<span class="chip ' + (over ? "cr" : "ok") + '">' + esc(r.loaded_after) + "/" + esc(lc.max || 5) + " loaded</span>"); });
    if (ro && ro.status === "warn") (ro.rows || []).filter(function (r) { return r.status !== "within"; }).forEach(function (r) { row(r).chips.push('<span class="chip wn">' + esc(r.active_after) + " active</span>"); });
    var h = order.map(function (k) { return '<div class="trr"><span>' + esc(rows[k].name) + '</span><span class="trcs">' + rows[k].chips.join("") + "</span></div>"; }).join("");
    if (!h) h = '<div class="ex' + (c.cap.status === "ok" ? "" : " wn") + '">' + (c.cap.status === "ok" ? "Under the cap." : c.cap.status === "blocked" ? "Over the cap." : "Couldn’t be checked.") + "</div>";
    if (lc && !(lc.rows || []).length && lc.status !== "ok") h += '<div class="ex wn">' + (lc.status === "blocked" ? "Over the loaded-contract limit." : "Loaded contracts couldn’t be checked.") + "</div>";
    return h;
  }

  function capRow(label, val, max, act, giver, dest) {
    if (!max) return "";
    var a = ' data-fid="' + esc(giver || "") + '" data-to="' + esc(dest || "") + '"';
    return '<div class="trcap"><span class="in">' + esc(label) + " <b>" + k$(val * 1000) + '</b> <small class="mu">max ' + k$(max * 1000) + '</small></span><button class="btn sm" data-act="' + act + '" data-v="-1"' + a + ' aria-label="Less"' + (val <= 0 ? " disabled" : "") + '>−</button><button class="btn sm" data-act="' + act + '" data-v="1"' + a + ' aria-label="More"' + (val >= max ? " disabled" : "") + ">+</button></div>";
  }
  function picked(S, fid, toks, removeAct, extra) {
    var inv = invOf(S, fid);
    if (inv.state === "loading" || inv.state === "idle") return '<div class="ex">Loading…</div>';
    if (inv.state === "error") return '<div class="ex wn">' + esc(inv.why || "Couldn’t read this team.") + ' <button class="link" data-act="trinv">Try again</button></div>';
    return toks.map(function (t) {
      return '<div class="trsel"><span class="in">' + esc(assetText(inv, t, fid)) + "</span>" + (extra ? extra(t) : "") + '<button class="btn sm" data-act="' + removeAct + '" data-v="' + esc(t) + '" data-fid="' + esc(fid) + '" aria-label="Remove">✕</button></div>';
    }).join("");
  }
  function addBtn(fid, label) { return '<button class="btn sm trad" data-act="trpick" data-fid="' + esc(fid) + '">+ ' + esc(label || "Add") + "</button>"; }
  function noteBox(S, id, val) {
    return S.tr.note ? '<textarea id="' + id + '" class="pfq trn" maxlength="2000" rows="2" placeholder="Note (optional)">' + esc(val || "") + "</textarea>" : '<button class="link" data-act="trnote">+ Note</button>';
  }
  function sendBlock(S, B, G, sendLabel) {
    var k = S.tr.chk, fresh = k.sig === B.sig, h = '<div class="card">';
    if (!B.ready) h += '<div class="ex">' + (S.tr.mode === 3 ? "Pick both teams and at least one player or pick." : "Pick at least one player or pick on each side.") + "</div>";
    else if (fresh && k.state === "loading") h += '<div class="ex">Checking…</div>';
    else if (fresh && k.state === "error") h += '<div class="ex wn">' + esc(k.why || "Couldn’t check this trade.") + "</div>";
    else if (fresh && k.state === "ok") h += checkLines(k.c);
    if (G.text && !G.ok) h += '<div class="ex wn">' + esc(G.text) + "</div>";
    var checked = B.ready && fresh && k.state === "ok";
    h += checked ? '<button class="btn pri blk" data-act="trsend"' + (canSendWith(S, B, G) ? "" : " disabled") + ">" + (S.tr.busy ? "Sending…" : esc(sendLabel)) + "</button>"
      : '<button class="btn pri blk" data-act="trcheck"' + (B.ready && k.state !== "loading" ? "" : " disabled") + ">Check trade</button>";
    return h + "</div>";
  }
  function teamBtn(S, slot, fid, placeholder) {
    return '<button class="btn sm trtm" data-act="trteams" data-v="' + slot + '">' + esc(fid ? teamName(S, fid) : placeholder) + " ▾</button>";
  }

  function new2(S, me, G) {
    var d = S.tr.d, to = pad4(d.to);
    var h = '<div class="card trwith"><span class="lbl">With</span>' + teamBtn(S, "to", to, "Pick a team") + "</div>";
    if (!to) return h;
    var B = build(S, me), mine = invOf(S, me), theirs = invOf(S, to);
    h += '<div class="card"><h2>You give</h2>' + picked(S, me, Object.keys(d.give), "trrm") + addBtn(me) + capRow("Cap money", B.capGive, maxCapK(mine, d.give), "trcapg") + "</div>";
    h += '<div class="card"><h2>You get</h2>' + picked(S, to, Object.keys(d.get), "trrm") + addBtn(to) + capRow("Cap money", B.capGet, maxCapK(theirs, d.get), "trcapt") + "</div>";
    h += '<div class="trnote">' + noteBox(S, "trnote", d.note) + "</div>";
    return h + sendBlock(S, B, G, "Send offer");
  }
  function new3(S, me, G) {
    var d = S.tr.d3, T = ring(S, me);
    var h = '<div class="card trwith"><span class="lbl">With</span>' + teamBtn(S, "b", d.b, "Team 2") + teamBtn(S, "c", d.c, "Team 3") + "</div>";
    if (!d.b || !d.c) return h;
    var B = build3(S, me);
    T.forEach(function (giver) {
      var map = d.give[giver] || {}, inv = invOf(S, giver), others = T.filter(function (x) { return x !== giver; });
      var dest = function (tok) { var to = pad4(map[tok]); return '<button class="btn sm trdst" data-act="trdest" data-v="' + esc(tok) + '" data-fid="' + esc(giver) + '">→ ' + esc(to === me ? "You" : teamName(S, to)) + "</button>"; };
      h += '<div class="card"><h2>' + esc(giver === me ? "You send" : teamName(S, giver) + " sends") + "</h2>" + picked(S, giver, Object.keys(map), "trrm", dest) + addBtn(giver) +
        others.map(function (o) { return capRow("Cap to " + (o === me ? "you" : teamName(S, o)), Math.min(int((d.cap[giver] || {})[o]), maxCapK(inv, map, o)), maxCapK(inv, map, o), "trcap3", giver, o); }).join("") + "</div>";
    });
    h += '<div class="trnote">' + noteBox(S, "trnote3", d.note) + "</div>";
    return h + sendBlock(S, B, G, "Send to both teams");
  }
  function newBody(S, me, G) {
    var chips = '<div class="chs trmode" role="group" aria-label="Teams">' + [[2, "2 teams"], [3, "3 teams"]].map(function (o) {
      return '<button class="ch" data-act="trmode" data-v="' + o[0] + '" aria-pressed="' + (S.tr.mode === o[0]) + '">' + o[1] + "</button>";
    }).join("") + "</div>";
    return chips + (S.tr.mode === 3 ? new3(S, me, G) : new2(S, me, G));
  }

  function screen(S, H) {
    var me = S.me && S.me.signedIn ? S.me.fid : "";
    var tabs = '<div class="tabs stk" role="tablist">' + [["offers", "Offers"], ["new", "New offer"]].map(function (o) {
      return '<button role="tab" data-act="trsub" data-v="' + o[0] + '" aria-selected="' + (S.tr.sub === o[0]) + '">' + esc(o[1]) + "</button>";
    }).join("") + "</div>";
    var body;
    if (!S.model) body = '<div class="ex pad">Loading the league…</div>';
    else if (!me) body = '<div class="card warnc"><div class="ex">' + esc(S.me && S.me.state === "loading" ? "Checking your sign-in…" : "Sign in with your own team to trade.") + "</div></div>";
    else { var G = gate(S); body = S.tr.sub === "new" ? newBody(S, me, G) : offersBody(S, me, G); }
    return H.scroller(H.header("Trades", ""), tabs + body);
  }

  // ---- sheets ----
  function sheetHead(title, close) {
    return '<div class="layer"><div class="scrim" data-act="trclose"></div><div class="sheet" role="dialog" aria-modal="true" aria-label="' + esc(title) + '" tabindex="-1"><div class="grab"></div><div class="top"><h3>' + esc(title) + '</h3><button class="btn" data-act="trclose">' + esc(close || "Close") + "</button></div>";
  }
  // A team's players and picks: tap to add or remove. The list lives in the sheet, so the page stays short.
  function pickSheet(S, me) {
    var pk = S.tr.pk || {}, fid = pad4(pk.fid), inv = invOf(S, fid), sel = selectedMap(S, me, fid);
    var h = sheetHead(fid === me ? "Your players & picks" : teamName(S, fid), "Done");
    if (inv.state !== "ok") return h + '<div class="ex">' + (inv.state === "error" ? esc(inv.why || "Couldn’t read this team.") : "Loading…") + "</div></div></div>";
    h += (inv.players || []).map(function (p) {
      var k = "P_" + p.player_id, on = !!sel[k];
      return '<button class="so trso" data-act="trtoggle" data-v="' + esc(k) + '" aria-pressed="' + on + '"><span class="in"><b>' + esc(p.display) + "</b><small>" + esc(p.position + " · " + k$(p.salary) + (p.taxi ? " · Taxi" : "")) + '</small></span><span class="trk" aria-hidden="true">' + (on ? "✓" : "+") + "</span></button>";
    }).join("");
    h += (inv.future_picks || []).map(function (fp) {
      var k = pickToken(fp), why = pickBlocked(fp), on = !why && !!sel[k];
      return '<button class="so trso' + (why ? " off" : "") + '" data-act="trtoggle" data-v="' + esc(k) + '" aria-pressed="' + on + '"' + (why ? " disabled" : "") + '><span class="in"><b>' + esc(assetText(inv, k, fid)) + "</b>" + (why ? "<small>" + esc(why) + "</small>" : "") + '</span><span class="trk" aria-hidden="true">' + (why ? "" : on ? "✓" : "+") + "</span></button>";
    }).join("");
    return h + "</div></div>";
  }
  function selectedMap(S, me, fid) {
    if (S.tr.mode === 3) return S.tr.d3.give[fid] || {};
    return fid === me ? S.tr.d.give : S.tr.d.get;
  }
  function teamSheet(S, me) {
    var slot = S.tr.tp, taken = slot === "b" ? [me, S.tr.d3.c] : slot === "c" ? [me, S.tr.d3.b] : [me];
    var h = sheetHead("Pick a team");
    return h + S.model.teams.filter(function (t) { return taken.indexOf(t.id) < 0; }).map(function (t) {
      return '<button class="so trso" data-act="trteampick" data-v="' + esc(t.id) + '"><span class="in"><b>' + esc(t.name) + "</b></span></button>";
    }).join("") + "</div></div>";
  }
  function reviewSheet(S, me) {
    var rv = S.tr.rv || {}, G = gate(S), x = rv.offer ? offerSides(S, rv.offer, me) : null, d = rv.data;
    var h = sheetHead("Accept this trade?");
    if (x) h += '<div class="trln"><span class="trk2">Get</span><span>' + line(S, x.get, x.other) + '</span></div><div class="trln"><span class="trk2">Give</span><span>' + line(S, x.give, me) + "</span></div>";
    if (rv.state === "loading") return h + '<div class="ex">Checking the salary cap…</div></div></div>';
    if (rv.state !== "ok" || !d) return h + '<div class="ex wn">' + esc(rv.why || "Couldn’t check this trade.") + '</div><button class="btn blk" data-act="trretry">Try again</button></div></div>';
    h += checkLines(d.c);
    var mine = d.capAck && (d.capAck.per_franchise || []).filter(function (f) { return pad4(f.franchise_id) === me && f.status !== "acknowledged"; })[0];
    if (mine) h += '<button class="btn blk" data-act="trackcap"' + (rv.ackBusy ? " disabled" : "") + ">" + (rv.ackBusy ? "Acknowledging…" : "Acknowledge " + esc(k$(mine.amount_over)) + " over the cap") + "</button>";
    if (rv.ackMsg) h += '<div class="ex">' + esc(rv.ackMsg) + "</div>";
    if (!G.ok) h += '<div class="ex wn">' + esc(G.text) + "</div>";
    else if (!d.canAccept && d.message) h += '<div class="ex wn">' + esc(d.message) + "</div>";
    return h + '<button class="btn pri blk" data-act="traccept"' + (d.canAccept && G.ok && !S.tr.busy ? "" : " disabled") + ">Accept trade</button></div></div>";
  }
  function declineSheet(S) {
    return sheetHead("Decline offer") + '<textarea id="trdeclnote" class="pfq trn" maxlength="2000" rows="2" placeholder="Note (optional)">' + esc((S.tr.dec && S.tr.dec.note) || "") + "</textarea>" +
      '<button class="btn pri blk" data-act="trdeclinego"' + (S.tr.busy ? " disabled" : "") + ">Decline offer</button></div></div>";
  }
  function confirmSheet(title, text, go, goLabel) {
    return '<div class="layer ctrl"><div class="scrim"></div><div class="rm wn" role="alertdialog" aria-modal="true" aria-labelledby="trc-t" tabindex="-1"><h2 id="trc-t">' + esc(title) + "</h2>" + (text ? "<p>" + esc(text) + "</p>" : "") +
      '<button class="rmok" data-act="' + go + '">' + esc(goLabel) + '</button><button class="btn blk" data-act="trclose">Back</button></div></div>';
  }
  function layer(S) {
    var me = S.me && S.me.signedIn ? S.me.fid : "";
    if (!S.tr || !me) return "";
    if (S.sheet === "trpick" && S.tr.pk) return pickSheet(S, me);
    if (S.sheet === "trteams" && S.tr.tp) return teamSheet(S, me);
    if (S.sheet === "trreview") return reviewSheet(S, me);
    if (S.sheet === "trdecline") return declineSheet(S);
    if (S.sheet === "trcancel") return confirmSheet("Cancel this offer?", "", "trcancelgo", "Cancel offer");
    if (S.sheet === "tr3cancel") return confirmSheet("Cancel this 3-team trade?", "", "tr3cancelgo", "Cancel trade");
    if (S.sheet === "trackSend" && S.tr.ack) return confirmSheet("Over the salary cap", "You’d be " + k$(S.tr.ack.amount_over) + " over. MFL still allows it.", "trsendack", "Acknowledge and send");
    return "";
  }

  // ---- reading the worker's answers ----
  function why(r, fallback) {
    var b = (r && r.body) || {};
    var m = b.message || b.error || b.reason || "";
    if (typeof m !== "string") m = "";
    if (!m && r && r.status === 401) m = "Sign in again from MFL.";
    return m || fallback || ("HTTP " + ((r && r.status) || "?"));
  }
  // The accept review (action preview), as the classic app reads it (interpretPreview): cap ok, or an overage every affected team acknowledged; and the
  // loaded-contract limit executable.
  function review(r) {
    var b = (r && r.body) || {};
    if (r && r.ok && b.ok !== false && b.compliance && b.compliance.cap) {
      var cap = b.compliance.cap.status, ack = b.cap_ack || null;
      var capOk = cap === "ok" || (cap === "blocked" && !!ack && !!ack.satisfied);
      var lcOk = !b.compliance.loaded_contracts || b.compliance.loaded_contracts.executable === true;
      return { state: "ok", data: { c: b.compliance, capAck: ack, canAccept: capOk && lcOk,
        message: !lcOk ? (b.compliance.loaded_contracts.status === "blocked" ? "Over the loaded-contract limit." : "Loaded contracts couldn’t be confirmed.") :
          cap === "blocked" && !capOk ? "Over the salary cap." : cap === "unavailable" ? "The salary cap couldn’t be checked." : "" } };
    }
    return { state: "error", why: why(r, "Couldn’t check this trade.") };
  }

  return { fresh: fresh, blankDraft: blankDraft, blankDraft3: blankDraft3, tokens: tokens, tokenLabel: tokenLabel, k$: k$, gate: gate, offerSides: offerSides, pickToken: pickToken, pickBlocked: pickBlocked,
    maxCapK: maxCapK, build: build, build3: build3, ring: ring, ringNext: ringNext, findSent: findSent, canSend: canSend, screen: screen, layer: layer, why: why, review: review, checkLines: checkLines };
});
