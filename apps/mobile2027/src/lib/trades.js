/* UPS 2027 Trades. TEST TARGET ONLY. Keith 2026-11-26: "go trades v1"; "not concise enough … no three ways"; then "One list + Propose", review and
   counter, cap space never stops a send, whose pick it is, each team's cap space, a tidier 3-team card.
   League › Trades is ONE list of pending trades (two-team, including ones made on MFL, and three-team) with a Propose button. Tapping a trade opens
   its Review (each side, each team's cap space now and after, Accept / Counter / Decline or Cancel). The builder (Propose or Counter) is its own
   screen; a team's players and picks open in a sheet, so no screen grows with a roster.
   The baseline is the classic phone app (site/m/views/trade.js): the same worker routes, bodies and gates. The cap verdict, the loaded-contract
   limit, the accept gate and a 3-team trade's state are the worker's answers. This file only draws and builds; it has no network code. */
(function (root, factory) {
  var req = typeof require === "function";
  var api = factory(req ? require("./format.js") : root.UPS2027.format, req ? require("./adjust.js") : root.UPS2027.adjust, req ? require("./tradeimpact.js") : root.UPS2027.tradeimpact);
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.UPS2027 = root.UPS2027 || {}; root.UPS2027.trades = api; }
})(typeof self !== "undefined" ? self : this, function (F, A, IMP) {
  "use strict";
  var esc = F.esc;
  function pad4(x) { var s = String(x == null ? "" : x).trim(); return s ? ("0000" + s).slice(-4) : ""; }
  function int(x) { var n = parseInt(x, 10); return isFinite(n) ? n : 0; }
  // $12K, $1.5K, $500, −$3K
  function k$(n) { var v = Number(n) || 0, neg = v < 0; v = Math.abs(v); var s = v < 1000 ? "$" + Math.round(v) : "$" + String(Math.round(v / 100) / 10).replace(/\.0$/, "") + "K"; return (neg ? "−" : "") + s; }

  function fresh() {
    return { view: "list", mode: 2, offers: { state: "idle" }, three: { state: "idle" }, lock: { state: "idle" }, inv: {}, d: blankDraft(), d3: blankDraft3(), counter: null,
      chk: { state: "idle", sig: "" }, rv: null, rv3: null, dec: null, can: null, can3: null, ack: null, pk: null, tp: null, note: false, busy: false };
  }
  function blankDraft() { return { to: "", give: {}, get: {}, capGive: 0, capGet: 0, note: "" }; }
  function blankDraft3() { return { b: "", c: "", give: {}, cap: {}, note: "" }; }   // give[fid][token] = destination fid; cap[fid][dest] = $K

  function teamOf(S, fid) { return S.model && S.model.teams.filter(function (x) { return x.id === pad4(fid); })[0] || null; }
  function teamName(S, fid) { var t = teamOf(S, fid); return t ? t.name : "Team " + pad4(fid); }
  // A team's cap space now: the league cap minus the team's cap charge (the Contracts screen's own figure, lib/adjust.js). null when either isn't known.
  function capRoom(S, fid) {
    var t = teamOf(S, fid), m = S.model;
    if (!t || !t.cap || !m || m.capLimit == null || !A || !A.capBreakdown) return null;
    var b = A.capBreakdown(t, t.cap); return b && b.capCharge != null ? m.capLimit - b.capCharge : null;
  }
  function roomText(S, fid) { var r = capRoom(S, fid); return r == null ? "" : r < 0 ? "Over by " + k$(-r) : k$(r) + " room"; }
  function tokens(s) { return String(s || "").split(/\s*,\s*/).map(function (x) { return x.trim().toUpperCase(); }).filter(function (x) { return x && !/^BB_0*(\.0+)?$/.test(x); }); }

  // One MFL trade token, short. A pick always names the team it originally belonged to.
  function tokenLabel(S, tok) {
    var t = String(tok || "").toUpperCase(), m;
    if (/^P_\d+$/.test(t)) t = t.slice(2);
    if (/^\d+$/.test(t)) {
      var p = S.model && S.model.byId[t];
      return p ? p.name + " " + p.pos + (p.salary != null ? " " + k$(p.salary) : "") : "Player " + t;
    }
    if ((m = /^FP_(\d{4})_(\d{4})_(\d+)$/.exec(t))) return m[2] + " R" + int(m[3]) + " (" + teamName(S, m[1]) + ")";
    if ((m = /^DP_(\d+)_(\d+)$/.exec(t))) return "Pick " + (int(m[1]) + 1) + "." + ("0" + (int(m[2]) + 1)).slice(-2);   // MFL's DP_ is zero-indexed
    if ((m = /^BB_(\d+(?:\.\d+)?)$/.exec(t))) return k$(Number(m[1])) + " cap";
    return t;
  }
  // A player's name opens the app's player profile (the same "card" action the roster uses), without changing the selected team.
  function plink(pid, name) { return '<button class="plk" data-act="card" data-pid="' + esc(pid) + '" data-x="1">' + esc(name) + "</button>"; }
  function line(S, toks) { return toks.length ? toks.map(function (t) { return esc(tokenLabel(S, t)); }).join(" · ") : '<span class="mu">Nothing</span>'; }
  // The review's detail row for one token: a player's salary and years left, a pick's original team, cap money.
  function detailRow(S, tok) {
    var t = String(tok || "").toUpperCase(); if (/^P_\d+$/.test(t)) t = t.slice(2);
    var p = /^\d+$/.test(t) && S.model ? S.model.byId[t] : null;
    if (p) return '<div class="trd"><span class="in">' + plink(p.id, p.name) + " " + esc(p.pos) + '</span><span class="mu">' + esc((p.salary != null ? k$(p.salary) : "") + (p.years ? " · " + p.years + (p.years === 1 ? " yr" : " yrs") : "")) + "</span></div>";
    return '<div class="trd"><span class="in">' + esc(tokenLabel(S, tok)) + "</span></div>";
  }

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

  // ---- the list ----
  function offerSides(S, o, me) {
    var inc = pad4(o.to_franchise_id) === me, other = inc ? o.from_franchise_id : o.to_franchise_id;
    var give = tokens(inc ? o.will_receive : o.will_give_up), get = tokens(inc ? o.will_give_up : o.will_receive);
    return { inc: inc, other: pad4(other), give: give, get: get, tid: String(o.trade_id || o.proposal_id || "").replace(/\D/g, "") };
  }
  function when(iso) { var s = iso ? F.etStamp(iso) : ""; return s ? '<small class="mu">' + esc(s) + "</small>" : ""; }
  function offerCard(S, o, me) {
    var x = offerSides(S, o, me);
    return '<button class="card tro trtap" data-act="trreview" data-v="' + esc(x.tid) + '"><span class="trh"><b>' + esc((x.inc ? "From " : "To ") + teamName(S, x.other)) + "</b>" + when(o.created_at) + "</span>" +
      '<span class="trln"><span class="trk2">Get</span><span>' + line(S, x.get) + '</span></span><span class="trln"><span class="trk2">Give</span><span>' + line(S, x.give) + '</span></span><span class="trgo">Review ›</span></button>';
  }
  function threeOthers(S, tr, me) { return (tr.participants || []).filter(function (p) { return pad4(p.fid) !== me; }).map(function (p) { return p.name || teamName(S, p.fid); }); }
  function threeCard(S, tr, me) {
    var sv = tr.state_view || {};
    return '<button class="card tro trtap" data-act="tr3review" data-v="' + esc(tr.id) + '"><span class="trh"><b class="trnm">Ménage · ' + esc(threeOthers(S, tr, me).join(" & ")) + "</b></span>" +
      '<span class="trst' + (sv.terminal ? "" : " wn") + '">' + esc(sv.label || tr.status || "") + '</span><span class="trgo">Review ›</span></button>';
  }
  function listBody(S, me, G) {
    var O = S.tr.offers, T3 = S.tr.three;
    var h = '<div class="trtop"><span class="ex' + (G.ok ? "" : " wn") + '">' + esc(G.text || "") + '</span><button class="link" data-act="trload">Refresh</button></div>' +
      '<button class="btn pri blk trprop" data-act="trpropose">Propose trade</button>';
    if (O.state === "loading" || O.state === "idle") return h + '<div class="ex pad">Loading trades…</div>';
    if (O.state !== "ok") return h + '<div class="card warnc"><div class="ex">' + esc(O.why || "Couldn’t read your trades.") + '</div><button class="btn blk" data-act="trload">Try again</button></div>';
    var inc = O.inc || [], out = O.out || [], three = T3.state === "ok" ? T3.list || [] : [];
    if (inc.length) h += '<div class="sec2">To you · ' + inc.length + "</div>" + inc.map(function (o) { return offerCard(S, o, me); }).join("");
    if (three.length) h += '<div class="sec2">Ménage · ' + three.length + "</div>" + three.map(function (t) { return threeCard(S, t, me); }).join("");
    if (out.length) h += '<div class="sec2">You sent · ' + out.length + "</div>" + out.map(function (o) { return offerCard(S, o, me); }).join("");
    if (T3.state === "error") h += '<div class="ex wn pad">Ménage trades couldn’t be read.</div>';
    if (!inc.length && !out.length && !three.length) h += '<div class="ex pad">No pending trades.</div>';
    return h;
  }

  // ---- cap space: one row per team, now (and after, once the worker has checked the trade) ----
  function capTable(S, fids, c) {
    var after = {}, loaded = {}, lc = c && c.loaded_contracts;
    ((c && c.cap && c.cap.rows) || []).forEach(function (r) { after[pad4(r.franchise_id)] = r; });
    ((lc && lc.rows) || []).forEach(function (r) { loaded[pad4(r.franchise_id)] = r; });
    var h = '<div class="card"><h2>Cap space</h2>' + fids.map(function (f) {
      var now = capRoom(S, f), a = after[f], l = loaded[f], chips = "";
      if (a) chips += '<span class="chip ' + (int(a.over_by) > 0 ? "cr" : "ok") + '">' + (int(a.over_by) > 0 ? "Over " + k$(a.over_by) : k$(a.room_after)) + " after</span>";
      if (l) chips += '<span class="chip ' + (int(l.loaded_after) > int(lc.max || 5) ? "cr" : "ok") + '">' + esc(l.loaded_after) + "/" + esc(lc.max || 5) + " loaded</span>";
      return '<div class="trr trcr"><span class="trnm">' + esc(teamName(S, f)) + '</span><span class="trcs"><span class="mu">' + esc(now == null ? "—" : (now < 0 ? "Over " + k$(-now) : k$(now)) + " now") + "</span>" + chips + "</span></div>";
    }).join("");
    if (c && c.cap && c.cap.status === "unavailable") h += '<div class="ex wn">After the trade: couldn’t be checked.</div>';
    return h + "</div>";
  }
  function loadedWarn(S, c) {
    var lc = c && c.loaded_contracts; if (!lc || lc.status === "ok") return "";
    var over = (lc.rows || []).filter(function (r) { return int(r.loaded_after) > int(lc.max || 5); }).map(function (r) { return teamName(S, r.franchise_id) + " " + r.loaded_after + "/" + (lc.max || 5); });
    return '<div class="ex wn">' + (lc.status === "unavailable" ? "Loaded contracts couldn’t be checked." : "Over 5 loaded contracts: " + esc(over.join(", ")) + ".") + "</div>";
  }

  // ---- builder pieces ----
  function pickToken(fp) { return "FP_" + pad4(fp.original_fid) + "_" + String(fp.year) + "_" + String(fp.round); }
  function pickBlocked(fp) {
    if (fp.forfeited === true) return String(fp.forfeit_label || "Forfeited");
    if (int(fp.round) === 6) return "Round 6 can’t be traded";
    return "";
  }
  function invOf(S, fid) { return S.tr.inv[pad4(fid)] || { state: "idle" }; }
  function playerOf(inv, tok) { return ((inv && inv.players) || []).filter(function (p) { return "P_" + p.player_id === tok; })[0] || null; }
  function pickOf(inv, tok) { return ((inv && inv.future_picks) || []).filter(function (fp) { return pickToken(fp) === tok; })[0] || null; }
  function assetText(S, inv, tok) {
    var p = playerOf(inv, tok); if (p) return p.display + " " + p.position + " " + k$(p.salary) + (p.taxi ? " · Taxi" : "");
    var fp = pickOf(inv, tok); if (fp) return fp.year + " R" + fp.round + " (" + (fp.original_team_name || teamName(S, fp.original_fid)) + ")";
    return tokenLabel(S, tok);
  }
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

  // ---- two teams: the classic builder's body (POST /api/trades/proposals, or the counter_offer of a COUNTER) plus the check's movements ----
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
    function mflTokens(list, net) { var t = list.map(function (a) { return a.type === "PLAYER" ? String(a.player_id) : a.pick_key; }); if (net > 0) t.push("BB_" + net * 1000); return t.sort(); }
    return { body: body, movements: movements, give: give, get: get, capGive: capGive, capGet: capGet, ready: !!(to && give.length && get.length),
      sig: JSON.stringify([2, to, give.map(assetToken).sort(), get.map(assetToken).sort(), capGive, capGet]),
      expect: { giveUp: mflTokens(give, capGive - capGet), receive: mflTokens(get, capGet - capGive) } };
  }
  function findSent(offers, to, expect) {
    var same = function (a, b) { return a.length === b.length && a.every(function (x, i) { return x === b[i]; }); };
    return (offers || []).filter(function (o) { return pad4(o.to_franchise_id) === pad4(to) && same(tokens(o.will_give_up).sort(), expect.giveUp) && same(tokens(o.will_receive).sort(), expect.receive); })[0] || null;
  }
  // A counter starts from the offer as it stands: what I'd give, what I'd get, and the cap money each side carries (BB_ dollars → $K).
  function counterDraft(S, o, me) {
    var x = offerSides(S, o, me), d = blankDraft(); d.to = x.other;
    var put = function (toks, ids, k) { toks.forEach(function (t) { var m = /^BB_(\d+(?:\.\d+)?)$/.exec(t); if (m) d[k] = Math.round(Number(m[1]) / 1000); else ids[/^\d+$/.test(t) ? "P_" + t : t] = true; }); };
    put(x.give, d.give, "capGive"); put(x.get, d.get, "capGet");
    return d;
  }

  // ---- three teams: the classic 3-way builder (POST /api/trades/3way) ----
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
        movements.push({ from: giver, to: dest, asset_tokens: toks.slice(), cap_k: cap, summary: toks.map(function (t) { return assetText(S, inv, t); }).join(", ") });
      });
    });
    var body = { league_id: S.tr.league, season: S.tr.season, initiator: { fid: me, name: teamName(S, me) }, team_b: { fid: pad4(d.b), name: teamName(S, d.b) }, team_c: { fid: pad4(d.c), name: teamName(S, d.c) },
      movements: movements, extension_requests: [], notes: String(d.note || "").slice(0, 2000) };
    var check = movements.map(function (m) { return { from: m.from, to: m.to, asset_tokens: m.asset_tokens, cap_k: m.cap_k }; });
    return { body: body, movements: check, ready: ready && count > 0, sig: JSON.stringify([3, T, check]), three: true };
  }

  // Send needs a fresh check of THIS trade and the trade window open. Cap space never stops a send (an over-the-cap two-team offer is acknowledged at
  // Send, as the classic app does). A two-team offer over 5 loaded contracts is refused (Keith's ruling, 2026-10-01: a hard stop at create); a
  // 3-team trade is not stopped at send (the classic app's 3-way: the loaded-contract gate runs before it can execute).
  function canSend(S, B, G) {
    var k = S.tr.chk, lc = k.c && k.c.loaded_contracts;
    if (!(G.ok && B.ready && k.state === "ok" && k.sig === B.sig && !S.tr.busy)) return false;
    return B.three ? true : !lc || lc.status === "ok";
  }

  function capRow(label, val, max, act, giver, dest) {
    if (!max) return "";
    var a = ' data-fid="' + esc(giver || "") + '" data-to="' + esc(dest || "") + '"';
    var box = '<span class="trcapbox">$<input class="trcapin" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="4" value="' + val + '" data-cap="' + act + '"' + a + ' aria-label="' + esc(label) + ', in thousands">K</span>';
    return '<div class="trcap"><span class="in">' + esc(label) + " " + box + ' <small class="mu">max ' + k$(max * 1000) + '</small></span><button class="btn sm" data-act="' + act + '" data-v="-1"' + a + ' aria-label="Less"' + (val <= 0 ? " disabled" : "") + '>−</button><button class="btn sm" data-act="' + act + '" data-v="1"' + a + ' aria-label="More"' + (val >= max ? " disabled" : "") + ">+</button></div>";
  }
  function picked(S, fid, toks, extra) {
    var inv = invOf(S, fid);
    if (inv.state === "loading" || inv.state === "idle") return '<div class="ex">Loading…</div>';
    if (inv.state === "error") return '<div class="ex wn">' + esc(inv.why || "Couldn’t read this team.") + ' <button class="link" data-act="trinv">Try again</button></div>';
    return toks.map(function (t) {
      var ip = playerOf(inv, t), txt = ip ? plink(ip.player_id, (S.model && S.model.byId[String(ip.player_id)] || {}).name || ip.display) + " " + esc(ip.position + " " + k$(ip.salary) + (ip.taxi ? " · Taxi" : "")) : esc(assetText(S, inv, t));
      return '<div class="trsel"><span class="in">' + txt + "</span>" + (extra ? extra(t) : "") + '<button class="btn sm" data-act="trrm" data-v="' + esc(t) + '" data-fid="' + esc(fid) + '" aria-label="Remove">✕</button></div>';
    }).join("");
  }
  function addBtn(fid) { return '<button class="btn sm trad" data-act="trpick" data-fid="' + esc(fid) + '">+ Add</button>'; }
  function noteBox(S, id, val, open) {
    if (open) return '<textarea id="' + id + '" class="pfq trn" maxlength="2000" rows="2" placeholder="' + esc(open) + '">' + esc(val || "") + "</textarea>";
    return S.tr.note ? '<textarea id="' + id + '" class="pfq trn" maxlength="2000" rows="2" placeholder="Note (optional)">' + esc(val || "") + "</textarea>" : '<button class="link" data-act="trnote">+ Note</button>';
  }
  function sideHead(S, title, fid) { var r = roomText(S, fid); return "<h2>" + esc(title) + (r ? ' <span class="trroom">' + esc(r) + "</span>" : "") + "</h2>"; }
  function sendBlock(S, B, G, fids, label) {
    var k = S.tr.chk, fresh = k.sig === B.sig, checked = B.ready && fresh && k.state === "ok";
    var h = capTable(S, fids, checked ? k.c : null);
    if (!B.ready) h += '<div class="ex pad">' + (B.three ? "Pick both teams and at least one player or pick." : "Pick at least one player or pick on each side.") + "</div>";
    else if (fresh && k.state === "loading") h += '<div class="ex pad">Checking…</div>';
    else if (fresh && k.state === "error") h += '<div class="ex wn pad">' + esc(k.why || "Couldn’t check this trade.") + "</div>";
    if (checked) h += loadedWarn(S, k.c) + (B.three && k.c && k.c.loaded_contracts && k.c.loaded_contracts.status === "blocked" ? '<div class="ex">It can be sent; it can’t run until that’s fixed.</div>' : "");
    if (G.text && !G.ok) h += '<div class="ex wn">' + esc(G.text) + "</div>";
    h += checked ? '<button class="btn pri blk" data-act="trsend"' + (canSend(S, B, G) ? "" : " disabled") + ">" + (S.tr.busy ? "Sending…" : esc(label)) + "</button>"
      : '<button class="btn pri blk" data-act="trcheck"' + (B.ready && k.state !== "loading" ? "" : " disabled") + ">Check trade</button>";
    return h;
  }
  function teamBtn(S, slot, fid, placeholder, fixed) {
    var r = fid ? roomText(S, fid) : "";
    var label = '<b>' + esc(fid ? teamName(S, fid) : placeholder) + "</b>" + (r ? "<small>" + esc(r) + "</small>" : "");
    return fixed ? '<span class="trtm">' + label + "</span>" : '<button class="btn trtm" data-act="trteams" data-v="' + slot + '">' + label + "</button>";
  }
  function build2Body(S, me, G) {
    var d = S.tr.d, to = pad4(d.to), ctr = !!S.tr.counter;
    var h = '<div class="card trwith">' + teamBtn(S, "me", me, "", true) + '<span class="mu">⇄</span>' + teamBtn(S, "to", to, "Pick a team", ctr) + "</div>";
    if (!to) return h;
    var B = build(S, me), mine = invOf(S, me), theirs = invOf(S, to);
    h += '<div class="card">' + sideHead(S, "You give", "") + picked(S, me, Object.keys(d.give)) + addBtn(me) + capRow("Cap money", B.capGive, maxCapK(mine, d.give), "trcapg") + "</div>";
    h += '<div class="card">' + sideHead(S, "You get", "") + picked(S, to, Object.keys(d.get)) + addBtn(to) + capRow("Cap money", B.capGet, maxCapK(theirs, d.get), "trcapt") + "</div>";
    h += '<div class="trnote">' + noteBox(S, "trnote", d.note, ctr ? "Note to " + teamName(S, to) + " (optional)" : "") + "</div>";
    return h + sendBlock(S, B, G, [me, to], ctr ? "Send counter" : "Send offer");
  }
  function build3Body(S, me, G) {
    var d = S.tr.d3, T = ring(S, me);
    var h = '<div class="card trwith">' + teamBtn(S, "b", d.b, "Team 2") + teamBtn(S, "c", d.c, "Team 3") + "</div>";
    if (!d.b || !d.c) return h;
    var B = build3(S, me);
    T.forEach(function (giver) {
      var map = d.give[giver] || {}, inv = invOf(S, giver), others = T.filter(function (x) { return x !== giver; });
      var dest = function (tok) { var to = pad4(map[tok]); return '<button class="btn sm trdst" data-act="trdest" data-v="' + esc(tok) + '" data-fid="' + esc(giver) + '">→ ' + esc(to === me ? "You" : teamName(S, to)) + "</button>"; };
      h += '<div class="card"><h2>' + esc(giver === me ? "You send" : teamName(S, giver) + " sends") + "</h2>" + picked(S, giver, Object.keys(map), dest) + addBtn(giver) +
        others.map(function (o) { return capRow("Cap to " + (o === me ? "you" : teamName(S, o)), Math.min(int((d.cap[giver] || {})[o]), maxCapK(inv, map, o)), maxCapK(inv, map, o), "trcap3", giver, o); }).join("") + "</div>";
    });
    h += '<div class="trnote">' + noteBox(S, "trnote3", d.note) + "</div>";
    return h + sendBlock(S, B, G, T, "Send to both teams");
  }
  function buildBody(S, me, G) {
    var chips = S.tr.counter ? "" : '<div class="chs trmode" role="group" aria-label="Teams">' + [[2, "2 teams"], [3, "Ménage"]].map(function (o) {
      return '<button class="ch" data-act="trmode" data-v="' + o[0] + '" aria-pressed="' + (S.tr.mode === o[0]) + '">' + o[1] + "</button>";
    }).join("") + "</div>";
    return chips + (S.tr.mode === 3 && !S.tr.counter ? build3Body(S, me, G) : build2Body(S, me, G));
  }

  // ---- lineup impact (lib/tradeimpact.js): the players moving, from the trade as listed; null until the projections are read ----
  function pid(t) { var s = String(t || "").toUpperCase().replace(/^P_/, ""); return /^\d+$/.test(s) ? s : ""; }
  function movesOf2(S, me, o) { var x = offerSides(S, o, me), out = []; x.get.forEach(function (t) { if (pid(t)) out.push({ pid: pid(t), from: x.other, to: me }); }); x.give.forEach(function (t) { if (pid(t)) out.push({ pid: pid(t), from: me, to: x.other }); }); return { fids: [me, x.other], moves: out }; }
  function movesOf3(tr) {
    var out = [];
    (tr.movements || []).forEach(function (m) { (m.assets || []).forEach(function (a) { var p = a.kind === "player" ? pid(a.player_id || a.token || a.id) : ""; if (p) out.push({ pid: p, from: pad4(m.from && m.from.fid), to: pad4(m.to && m.to.fid) }); }); });
    return { fids: (tr.participants || []).map(function (p) { return pad4(p.fid); }), moves: out };
  }
  function impactOf(S, mv) { var P = S.tr.pts; return P && P.state === "ok" && IMP ? IMP.compute(S, mv.fids, mv.moves, P) : null; }
  function impactCard(S, me, mv) { if (!IMP) return ""; var P = S.tr.pts; if (P && P.state === "error") return '<div class="card"><h2>Lineup impact</h2><div class="ex wn">Projections couldn’t be read. <button class="link" data-act="trpts">Try again</button></div></div>'; return IMP.summary(S, impactOf(S, mv), me); }
  function currentMoves(S, me) {
    if (S.tr.impFrom === "review3") { var tr = S.tr.rv3 && S.tr.rv3.trade; return tr ? movesOf3(tr) : null; }
    var o = S.tr.rv && S.tr.rv.offer; return o ? movesOf2(S, me, o) : null;
  }
  function impactBody(S, me) { var mv = currentMoves(S, me); if (!mv) return '<div class="ex pad">That trade is no longer listed.</div>'; return IMP.detail(S, impactOf(S, mv), me, S.tr.impTeam || me, function (f) { return f === me ? "You" : teamName(S, f); }); }

  // ---- reviews ----
  function review2Body(S, me, G) {
    var rv = S.tr.rv || {}, o = rv.offer, d = rv.data; if (!o) return '<div class="ex pad">That trade is no longer listed.</div>';
    var x = offerSides(S, o, me);
    var h = '<div class="trtitle"><b>' + esc((x.inc ? "From " : "To ") + teamName(S, x.other)) + "</b>" + when(o.created_at) + "</div>";
    h += '<div class="card"><h2>You get</h2>' + (x.get.map(function (t) { return detailRow(S, t); }).join("") || '<div class="ex">Nothing</div>') + "</div>";
    h += '<div class="card"><h2>You give</h2>' + (x.give.map(function (t) { return detailRow(S, t); }).join("") || '<div class="ex">Nothing</div>') + "</div>";
    if (o.message) h += '<div class="ex pad trmsg">“' + esc(String(o.message).slice(0, 600)) + "”</div>";
    h += impactCard(S, me, movesOf2(S, me, o));
    h += capTable(S, [me, x.other], rv.state === "ok" && d ? d.c : null);
    if (rv.state === "loading") h += '<div class="ex pad">Checking the trade…</div>';
    else if (rv.state === "error") h += '<div class="ex wn pad">' + esc(rv.why || "Couldn’t check this trade.") + ' <button class="link" data-act="trretry">Try again</button></div>';
    if (!x.inc) return h + '<button class="btn blk" data-act="trcancel" data-v="' + esc(x.tid) + '">Cancel offer</button>';
    if (d) {
      h += loadedWarn(S, d.c);
      var mine = d.capAck && (d.capAck.per_franchise || []).filter(function (f) { return pad4(f.franchise_id) === me && f.status !== "acknowledged"; })[0];
      if (mine) h += '<button class="btn blk" data-act="trackcap"' + (rv.ackBusy ? " disabled" : "") + ">" + (rv.ackBusy ? "Acknowledging…" : "Acknowledge " + esc(k$(mine.amount_over)) + " over the cap") + "</button>";
      if (rv.ackMsg) h += '<div class="ex">' + esc(rv.ackMsg) + "</div>";
      if (G.ok && !d.canAccept && d.message) h += '<div class="ex wn">' + esc(d.message) + "</div>";
    }
    if (!G.ok) h += '<div class="ex wn">' + esc(G.text) + "</div>";
    return h + '<div class="trb3"><button class="btn pri" data-act="traccept"' + (d && d.canAccept && G.ok && !S.tr.busy ? "" : " disabled") + '>Accept</button><button class="btn" data-act="trcounter" data-v="' + esc(x.tid) + '"' + (G.ok ? "" : " disabled") + '>Counter</button><button class="btn" data-act="trdecline" data-v="' + esc(x.tid) + '">Decline</button></div>';
  }
  // A 3-team asset as owners read it: a pick names its original team.
  function threeAsset(S, a) {
    if (a.kind === "pick" && a.pick) return a.pick.year + " R" + a.pick.round + (a.pick.slot ? "." + ("0" + a.pick.slot).slice(-2) : "") + " (" + teamName(S, a.pick.original_fid) + ")";
    if (a.kind === "cap") return k$(int(a.cap_k) * 1000) + " cap";
    var t = String(a.token || "").toUpperCase(); if (/^FP_/.test(t)) return tokenLabel(S, t);
    return String(a.label || t);
  }
  function review3Body(S, me, G) {
    var tr = S.tr.rv3 && S.tr.rv3.trade; if (!tr) return '<div class="ex pad">That trade is no longer listed.</div>';
    var sv = tr.state_view || {}, perm = tr.permissions || {}, fids = (tr.participants || []).map(function (p) { return pad4(p.fid); });
    var h = '<div class="trtitle"><b>Ménage · ' + esc(threeOthers(S, tr, me).join(" & ")) + '</b></div><div class="trst' + (sv.terminal ? "" : " wn") + ' pad">' + esc(sv.label || tr.status || "") + "</div>";
    fids.forEach(function (to) {
      var moves = (tr.movements || []).filter(function (m) { return pad4(m.to && m.to.fid) === to; });
      if (!moves.length) return;
      h += '<div class="card"><h2>' + esc(to === me ? "You get" : teamName(S, to) + " gets") + "</h2>" + moves.map(function (m) {
        var fr = pad4(m.from && m.from.fid);
        return (m.assets || []).map(function (a) { var ap = a.kind === "player" ? pid(a.player_id || a.token || a.id) : "", apl = ap && S.model && S.model.byId[ap]; return '<div class="trd"><span class="in">' + (apl ? plink(ap, apl.name) + " " + esc(apl.pos) : esc(threeAsset(S, a))) + '</span><span class="mu">from ' + esc(fr === me ? "you" : teamName(S, fr)) + "</span></div>"; }).join("");
      }).join("") + "</div>";
    });
    h += impactCard(S, me, movesOf3(tr));
    h += capTable(S, fids, tr.compliance || null) + loadedWarn(S, tr.compliance);
    var mine = (tr.participants || []).filter(function (p) { return pad4(p.fid) === me; })[0];
    var answer = tr.status === "collecting" && mine && mine.slot !== "initiator" && mine.state === "pending";   // Keith 2026-11-26 "A": partners answer here
    var btns = (answer ? '<button class="btn pri" data-act="tr3accept" data-v="' + esc(tr.id) + '">Accept</button><button class="btn" data-act="tr3decline" data-v="' + esc(tr.id) + '">Decline</button>' : "") +
      (perm.can_cancel ? '<button class="btn" data-act="tr3cancel" data-v="' + esc(tr.id) + '">Cancel trade</button>' : "") +
      (perm.can_recheck ? '<button class="btn pri" data-act="tr3recheck" data-v="' + esc(tr.id) + '">Re-check</button>' : "");
    return h + (btns ? '<div class="trb3">' + btns + "</div>" : "");
  }

  function screen(S, H) {
    var me = S.me && S.me.signedIn ? S.me.fid : "", v = S.tr.view;
    var back = v === "impact" ? '<div class="trback"><button class="link" data-act="trimpback">‹ Review</button><span class="trbt">Lineup impact</span></div>' :
      v !== "list" ? '<div class="trback"><button class="link" data-act="trback">‹ Trades</button><span class="trbt">' + esc(v === "build" ? (S.tr.counter ? "Counter offer" : "Propose trade") : "Review") + "</span></div>" : "";
    var body;
    if (!S.model) body = '<div class="ex pad">Loading the league…</div>';
    else if (!me) body = '<div class="card warnc"><div class="ex">' + esc(S.me && S.me.state === "loading" ? "Checking your sign-in…" : "Sign in with your own team to trade.") + "</div></div>";
    else { var G = gate(S); body = v === "impact" ? impactBody(S, me) : v === "build" ? buildBody(S, me, G) : v === "review" ? review2Body(S, me, G) : v === "review3" ? review3Body(S, me, G) : listBody(S, me, G); }
    return H.scroller(H.header("Trades", ""), back + body);
  }

  // ---- sheets ----
  function sheetHead(title, close) {
    return '<div class="layer"><div class="scrim" data-act="trclose"></div><div class="sheet" role="dialog" aria-modal="true" aria-label="' + esc(title) + '" tabindex="-1"><div class="grab"></div><div class="top"><h3>' + esc(title) + '</h3><button class="btn" data-act="trclose">' + esc(close || "Close") + "</button></div>";
  }
  function selectedMap(S, me, fid) {
    if (S.tr.mode === 3 && !S.tr.counter) return S.tr.d3.give[fid] || {};
    return fid === me ? S.tr.d.give : S.tr.d.get;
  }
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
      return '<button class="so trso' + (why ? " off" : "") + '" data-act="trtoggle" data-v="' + esc(k) + '" aria-pressed="' + on + '"' + (why ? " disabled" : "") + '><span class="in"><b>' + esc(assetText(S, inv, k)) + "</b>" + (why ? "<small>" + esc(why) + "</small>" : "") + '</span><span class="trk" aria-hidden="true">' + (why ? "" : on ? "✓" : "+") + "</span></button>";
    }).join("");
    return h + "</div></div>";
  }
  function teamSheet(S, me) {
    var slot = S.tr.tp, taken = slot === "b" ? [me, S.tr.d3.c] : slot === "c" ? [me, S.tr.d3.b] : [me];
    return sheetHead("Pick a team") + S.model.teams.filter(function (t) { return taken.indexOf(t.id) < 0; }).map(function (t) {
      var r = roomText(S, t.id);
      return '<button class="so trso" data-act="trteampick" data-v="' + esc(t.id) + '"><span class="in"><b>' + esc(t.name) + "</b>" + (r ? "<small>" + esc(r) + "</small>" : "") + "</span></button>";
    }).join("") + "</div></div>";
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
    if (S.sheet === "trdecline") return declineSheet(S);
    if (S.sheet === "trcancel") return confirmSheet("Cancel this offer?", "", "trcancelgo", "Cancel offer");
    if (S.sheet === "tr3cancel") return confirmSheet("Cancel this ménage?", "", "tr3cancelgo", "Cancel trade");
    if (S.sheet === "tr3accept") return confirmSheet("Accept this ménage?", "", "tr3acceptgo", "Accept");
    if (S.sheet === "tr3decline") return confirmSheet("Decline this ménage?", "It’s off for all three teams.", "tr3declinego", "Decline");
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
          cap === "blocked" && !capOk ? "Over the salary cap: acknowledge it first." : cap === "unavailable" ? "The salary cap couldn’t be checked." : "" } };
    }
    return { state: "error", why: why(r, "Couldn’t check this trade.") };
  }

  return { fresh: fresh, blankDraft: blankDraft, blankDraft3: blankDraft3, tokens: tokens, tokenLabel: tokenLabel, k$: k$, capRoom: capRoom, gate: gate, offerSides: offerSides,
    pickToken: pickToken, pickBlocked: pickBlocked, maxCapK: maxCapK, build: build, build3: build3, counterDraft: counterDraft, ring: ring, ringNext: ringNext, findSent: findSent,
    canSend: canSend, movesOf2: movesOf2, movesOf3: movesOf3, screen: screen, layer: layer, why: why, review: review, threeAsset: threeAsset };
});
