/* UPS 2027 Trades v1 (Keith 2026-11-26 "go trades v1"). TEST TARGET ONLY: build.mjs adds this file to the Test target alone.
   League › Trades: the owner's pending offers (incoming and outgoing, including ones made directly on MFL) with Accept, Decline and Cancel, and a
   two-team offer builder (players, future picks, cap money). The baseline is the classic phone app (site/m/views/trade.js): the same worker routes,
   the same request bodies, the same gates (the worker's cap, roster and loaded-contract check; its cap acknowledgment; MFL's trade lock).
   This file only draws and builds; it has no network code. app.js runs the requests through lib/submit.js.
   Nothing here decides a league rule the worker owns: the cap verdict, the loaded-contract limit and the accept gate are the worker's answers. */
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

  function fresh() {
    return { sub: "offers", offers: { state: "idle" }, lock: { state: "idle" }, inv: {}, d: blankDraft(), chk: { state: "idle", sig: "" },
      rv: null, dec: null, can: null, ack: null, busy: false };
  }
  function blankDraft() { return { to: "", give: {}, get: {}, capGive: 0, capGet: 0, note: "" }; }

  function teamName(S, fid) {
    var t = S.model && S.model.teams.filter(function (x) { return x.id === pad4(fid); })[0];
    return t ? t.name : "Team " + pad4(fid);
  }
  function tokens(s) { return String(s || "").split(/\s*,\s*/).map(function (x) { return x.trim().toUpperCase(); }).filter(Boolean); }

  // One MFL trade token as owners read it. side = the team giving it (a pick that came from another team says so).
  function tokenLabel(S, tok, side) {
    var t = String(tok || "").toUpperCase(), m;
    if (/^\d+$/.test(t)) {
      var p = S.model && S.model.byId[t];
      return p ? p.name + " · " + p.pos + (p.salary != null ? " · " + money(p.salary) : "") : "Player " + t;
    }
    if ((m = /^FP_(\d{4})_(\d{4})_(\d+)$/.exec(t))) return m[2] + " Round " + int(m[3]) + (m[1] !== pad4(side) ? " (" + teamName(S, m[1]) + ")" : "");
    if ((m = /^DP_(\d+)_(\d+)$/.exec(t))) return "Pick " + (int(m[1]) + 1) + "." + ("0" + (int(m[2]) + 1)).slice(-2);   // MFL's DP_ is zero-indexed
    if ((m = /^BB_(\d+(?:\.\d+)?)$/.exec(t))) return money(Number(m[1])) + " cap money";
    return t;
  }

  // ---- the lock: MFL's own "No Trades Allowed" calendar event (the worker reads it). Fails closed: a lock that can't be read stops Send and Accept.
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
  function list(S, toks, side) {
    if (!toks.length) return '<li class="mu">Nothing</li>';
    return toks.map(function (t) { return "<li>" + esc(tokenLabel(S, t, side)) + "</li>"; }).join("");
  }
  function offerCard(S, o, me, G) {
    var x = offerSides(S, o, me);
    var when = o.created_at ? F.etStamp(o.created_at) : "";
    var head = (x.inc ? "From " : "To ") + teamName(S, x.other);
    var btns = !x.tid ? "" : x.inc
      ? '<div class="trb"><button class="btn pri" data-act="trreview" data-v="' + esc(x.tid) + '"' + (G.ok ? "" : " disabled") + '>Accept</button><button class="btn" data-act="trdecline" data-v="' + esc(x.tid) + '">Decline</button></div>'
      : '<div class="trb"><button class="btn" data-act="trcancel" data-v="' + esc(x.tid) + '">Cancel offer</button></div>';
    return '<div class="card tro"><div class="trh"><b>' + esc(head) + "</b>" + (when ? '<small class="mu">' + esc(when) + "</small>" : "") + "</div>" +
      '<div class="trc"><div><div class="lbl">You get</div><ul class="trl">' + list(S, x.get, x.other) + '</ul></div><div><div class="lbl">You give</div><ul class="trl">' + list(S, x.give, me) + "</ul></div></div>" +
      (o.message ? '<div class="ex trm">“' + esc(String(o.message).slice(0, 400)) + "”</div>" : "") + btns + "</div>";
  }
  function offersBody(S, me, G) {
    var O = S.tr.offers;
    if (O.state === "loading" || O.state === "idle") return '<div class="card"><div class="ex">Loading offers…</div></div>';
    if (O.state !== "ok") return '<div class="card warnc"><h2>Offers</h2><div class="ex">' + esc(O.why || "Couldn’t read your offers.") + '</div><button class="btn blk" data-act="trload">Try again</button></div>';
    var inc = O.inc || [], out = O.out || [];
    var h = '<div class="sec2">Offers to you · ' + inc.length + "</div>" + (inc.length ? inc.map(function (o) { return offerCard(S, o, me, G); }).join("") : '<div class="card"><div class="ex">None.</div></div>');
    h += '<div class="sec2">Your offers · ' + out.length + "</div>" + (out.length ? out.map(function (o) { return offerCard(S, o, me, G); }).join("") : '<div class="card"><div class="ex">None.</div></div>');
    return h + '<button class="btn blk" data-act="trload">Refresh</button>';
  }

  // ---- the builder ----
  function pickToken(fp) { return "FP_" + pad4(fp.original_fid) + "_" + String(fp.year) + "_" + String(fp.round); }
  function pickBlocked(fp) {
    if (fp.forfeited === true) return String(fp.forfeit_label || "Forfeited");
    if (int(fp.round) === 6) return "Round 6 can’t be traded";
    return "";
  }
  function invOf(S, fid) { return S.tr.inv[pad4(fid)] || { state: "idle" }; }
  // Cap money a side may add: at most half the salary of the non-taxi players it sends, in whole $1K (the classic app's maxCapKFor).
  function maxCapK(inv, ids) {
    var sum = 0;
    ((inv && inv.players) || []).forEach(function (p) { if (ids["P_" + p.player_id] && !p.taxi) sum += int(p.salary); });
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
  // The offer as the classic builder sends it (POST /api/trades/proposals), plus the check's movements. Cap money is held to each side's maximum.
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
    // What MFL should then list for this offer (the read-back): the sender's tokens and the other team's, cap money as the BB_ dollars of each side's net.
    function mflTokens(list, net) { var t = list.map(function (a) { return a.type === "PLAYER" ? String(a.player_id) : a.pick_key; }); if (net > 0) t.push("BB_" + net * 1000); return t.sort(); }
    return { body: body, movements: movements, give: give, get: get, capGive: capGive, capGet: capGet, ready: !!(to && give.length && get.length),
      sig: JSON.stringify([to, give.map(assetToken).sort(), get.map(assetToken).sort(), capGive, capGet]),
      expect: { giveUp: mflTokens(give, capGive - capGet), receive: mflTokens(get, capGet - capGive) } };
  }
  // Does MFL's pending list now hold this offer? (the create's read-back)
  function findSent(offers, to, expect) {
    var same = function (a, b) { return a.length === b.length && a.every(function (x, i) { return x === b[i]; }); };
    return (offers || []).filter(function (o) { return pad4(o.to_franchise_id) === pad4(to) && same(tokens(o.will_give_up).sort(), expect.giveUp) && same(tokens(o.will_receive).sort(), expect.receive); })[0] || null;
  }

  function assetRows(S, inv, ids, act) {
    if (inv.state === "loading" || inv.state === "idle") return '<div class="ex">Loading…</div>';
    if (inv.state !== "ok") return '<div class="ex wn">' + esc(inv.why || "Couldn’t read this team.") + '</div><button class="btn blk" data-act="trinv">Try again</button>';
    var h = (inv.players || []).map(function (p) {
      var k = "P_" + p.player_id, on = !!ids[k], tag = p.taxi ? " · Taxi" : /IR|INJURED/.test(String(p.roster_status || "")) ? " · IR" : "";
      return '<button class="so" data-act="' + act + '" data-v="' + esc(k) + '" aria-pressed="' + on + '"><span class="in"><b>' + esc(p.display) + "</b><small>" + esc(p.position + (p.nfl_team ? " " + p.nfl_team : "") + " · " + money(p.salary) + tag) + '</small></span><span class="trk" aria-hidden="true">' + (on ? "✓" : "+") + "</span></button>";
    }).join("");
    h += (inv.future_picks || []).map(function (fp) {
      var k = pickToken(fp), why = pickBlocked(fp), on = !why && !!ids[k];
      var from = pad4(fp.original_fid) !== pad4(inv.fid) && fp.original_team_name ? " (" + fp.original_team_name + ")" : "";
      return '<button class="so' + (why ? " off" : "") + '" data-act="' + act + '" data-v="' + esc(k) + '" aria-pressed="' + on + '"' + (why ? " disabled" : "") + '><span class="in"><b>' + esc(fp.year + " Round " + fp.round + from) + "</b>" + (why ? "<small>" + esc(why) + "</small>" : "") + '</span><span class="trk" aria-hidden="true">' + (why ? "" : on ? "✓" : "+") + "</span></button>";
    }).join("");
    return h || '<div class="ex">No players or picks.</div>';
  }
  function capRow(label, val, max, act, inv, ids) {
    var sent = ((inv && inv.players) || []).some(function (p) { return ids["P_" + p.player_id] && !p.taxi; });
    if (!max) return '<div class="ex">' + esc(label) + ": " + (sent ? "none (half the salary sent is under $1,000)." : "add a non-taxi player first.") + "</div>";
    return '<div class="trcap"><span class="in">' + esc(label) + " <b>" + money(val * 1000) + "</b><small>Max " + money(max * 1000) + '</small></span><button class="btn" data-act="' + act + '" data-v="-1" aria-label="Less"' + (val <= 0 ? " disabled" : "") + '>−</button><button class="btn" data-act="' + act + '" data-v="1" aria-label="More"' + (val >= max ? " disabled" : "") + ">+</button></div>";
  }

  // The worker's check, in a few lines. c = compliance { cap, roster, loaded_contracts }.
  function checkLines(c) {
    if (!c || !c.cap) return '<div class="ex wn">The salary cap couldn’t be checked.</div>';
    var h = "", cap = c.cap, lc = c.loaded_contracts, ro = c.roster;
    h += '<div class="lbl">Salary cap</div>' + ((cap.rows || []).length ? (cap.rows || []).map(function (r) {
      var over = int(r.over_by) > 0;
      return '<div class="trr"><span>' + esc(r.franchise_name || r.franchise_id) + '</span><span class="chip ' + (over ? "cr" : "ok") + '">' + (over ? "Over by " + money(r.over_by) : money(r.room_after) + " room") + "</span></div>";
    }).join("") : '<div class="ex' + (cap.status === "ok" ? "" : " wn") + '">' + (cap.status === "ok" ? "Under the cap." : cap.status === "blocked" ? "Over the cap." : "Couldn’t be checked.") + "</div>");
    if (lc) h += '<div class="lbl">Loaded contracts</div>' + ((lc.rows || []).length ? (lc.rows || []).map(function (r) {
      var over = int(r.loaded_after) > int(lc.max || 5);
      return '<div class="trr"><span>' + esc(r.franchise_name || r.franchise_id) + '</span><span class="chip ' + (over ? "cr" : "ok") + '">' + esc(r.loaded_after) + " of " + esc(lc.max || 5) + "</span></div>";
    }).join("") : '<div class="ex' + (lc.status === "ok" ? "" : " wn") + '">' + (lc.status === "ok" ? "Within the limit." : lc.status === "blocked" ? "Over the limit." : "Couldn’t be checked.") + "</div>");
    if (ro && ro.status === "warn") h += '<div class="lbl">Roster</div>' + (ro.rows || []).filter(function (r) { return r.status !== "within"; }).map(function (r) {
      return '<div class="trr"><span>' + esc(r.franchise_name || r.franchise_id) + '</span><span class="chip wn">' + esc(r.active_after) + " active</span></div>";
    }).join("");
    return h;
  }
  // Send is allowed only after a check of THIS offer that came back with the loaded-contract limit met (fail closed); an over-the-cap offer is
  // then acknowledged at Send, as the classic app does (the worker asks for it).
  function canSend(S, B, G) {
    var k = S.tr.chk, lc = k.c && k.c.loaded_contracts;
    return !!(G.ok && B.ready && k.state === "ok" && k.sig === B.sig && k.c && k.c.cap && k.c.cap.status !== "unavailable" && (!lc || lc.status === "ok") && !S.tr.busy);
  }
  function newBody(S, me, G) {
    var d = S.tr.d, to = pad4(d.to);
    if (!to) return '<div class="card"><h2>Trade with</h2>' + S.model.teams.filter(function (t) { return t.id !== me; }).map(function (t) {
      return '<button class="so" data-act="trto" data-v="' + esc(t.id) + '"><span class="in"><b>' + esc(t.name) + "</b></span></button>";
    }).join("") + "</div>";
    var B = build(S, me), mine = invOf(S, me), theirs = invOf(S, to), k = S.tr.chk;
    var h = '<div class="card trh2"><span class="in">With <b>' + esc(teamName(S, to)) + '</b></span><button class="btn" data-act="trto" data-v="">Change</button></div>';
    h += '<div class="card"><h2>You give · ' + B.give.length + "</h2>" + assetRows(S, Object.assign({ fid: me }, mine), d.give, "trgive") + capRow("Cap money you give", B.capGive, maxCapK(mine, d.give), "trcapg", mine, d.give) + "</div>";
    h += '<div class="card"><h2>You get · ' + B.get.length + "</h2>" + assetRows(S, Object.assign({ fid: to }, theirs), d.get, "trget") + capRow("Cap money you get", B.capGet, maxCapK(theirs, d.get), "trcapt", theirs, d.get) + "</div>";
    h += '<div class="card"><label class="lbl" for="trnote">Note (optional)</label><textarea id="trnote" class="pfq trn" maxlength="2000" rows="2">' + esc(d.note || "") + "</textarea></div>";
    var fresh = k.sig === B.sig;
    h += '<div class="card"><h2>Check</h2>' + (!B.ready ? '<div class="ex">Pick at least one player or pick on each side.</div>' :
      !fresh || k.state === "idle" ? '<button class="btn blk" data-act="trcheck">Check trade</button>' :
      k.state === "loading" ? '<div class="ex">Checking…</div>' :
      k.state !== "ok" ? '<div class="ex wn">' + esc(k.why || "Couldn’t check this trade.") + '</div><button class="btn blk" data-act="trcheck">Try again</button>' : checkLines(k.c));
    if (G.text) h += '<div class="ex' + (G.ok ? "" : " wn") + ' mt4">' + esc(G.text) + "</div>";
    h += '<button class="btn pri blk" data-act="trsend"' + (canSend(S, B, G) ? "" : " disabled") + ">" + (S.tr.busy ? "Sending…" : "Send offer") + "</button></div>";
    return h;
  }

  function screen(S, H) {
    var me = S.me && S.me.signedIn ? S.me.fid : "";
    var tabs = '<div class="tabs stk" role="tablist">' + [["offers", "Offers"], ["new", "New offer"]].map(function (o) {
      return '<button role="tab" data-act="trsub" data-v="' + o[0] + '" aria-selected="' + (S.tr.sub === o[0]) + '">' + esc(o[1]) + "</button>";
    }).join("") + "</div>";
    var body;
    if (!S.model) body = '<div class="card"><div class="ex">Loading the league…</div></div>';
    else if (!me) body = '<div class="card warnc"><h2>Trades</h2><div class="ex">' + esc(S.me && S.me.state === "loading" ? "Checking your sign-in…" : "Sign in with your own team to trade.") + "</div></div>";
    else { var G = gate(S); body = S.tr.sub === "new" ? newBody(S, me, G) : (G.text ? '<div class="ex pad' + (G.ok ? "" : " wn") + '">' + esc(G.text) + "</div>" : "") + offersBody(S, me, G); }
    return H.scroller(H.header("Trades", ""), tabs + body);
  }

  // ---- sheets: the accept review, decline, cancel, the cap acknowledgment at Send ----
  function reviewSheet(S, me) {
    var rv = S.tr.rv || {}, G = gate(S), x = rv.offer ? offerSides(S, rv.offer, me) : null, d = rv.data;
    var h = '<div class="layer"><div class="scrim" data-act="trclose"></div><div class="sheet" role="dialog" aria-modal="true" aria-label="Accept this trade?" tabindex="-1"><div class="grab"></div><div class="top"><h3>Accept this trade?</h3><button class="btn" data-act="trclose">Close</button></div>';
    if (x) h += '<div class="trc"><div><div class="lbl">You get</div><ul class="trl">' + list(S, x.get, x.other) + '</ul></div><div><div class="lbl">You give</div><ul class="trl">' + list(S, x.give, me) + "</ul></div></div>";
    if (rv.state === "loading") return h + '<div class="ex">Checking the salary cap…</div></div></div>';
    if (rv.state !== "ok" || !d) return h + '<div class="ex wn">' + esc(rv.why || "Couldn’t check this trade.") + '</div><button class="btn blk" data-act="trretry">Try again</button></div></div>';
    h += checkLines(d.c);
    var mine = d.capAck && (d.capAck.per_franchise || []).filter(function (f) { return pad4(f.franchise_id) === me && f.status !== "acknowledged"; })[0];
    if (mine) h += '<div class="ex wn">You’d be ' + esc(money(mine.amount_over)) + " over the cap.</div>" + '<button class="btn blk" data-act="trackcap"' + (rv.ackBusy ? " disabled" : "") + ">" + (rv.ackBusy ? "Acknowledging…" : "Acknowledge " + esc(money(mine.amount_over)) + " over") + "</button>";
    if (rv.ackMsg) h += '<div class="ex">' + esc(rv.ackMsg) + "</div>";
    if (!G.ok) h += '<div class="ex wn">' + esc(G.text) + "</div>";
    else if (!d.canAccept && d.message) h += '<div class="ex wn">' + esc(d.message) + "</div>";
    return h + '<button class="btn pri blk" data-act="traccept"' + (d.canAccept && G.ok && !S.tr.busy ? "" : " disabled") + ">Accept trade</button></div></div>";
  }
  function declineSheet(S) {
    return '<div class="layer"><div class="scrim" data-act="trclose"></div><div class="sheet" role="dialog" aria-modal="true" aria-label="Decline offer" tabindex="-1"><div class="grab"></div><div class="top"><h3>Decline offer</h3><button class="btn" data-act="trclose">Close</button></div>' +
      '<label class="lbl" for="trdeclnote">Note (optional)</label><textarea id="trdeclnote" class="pfq trn" maxlength="2000" rows="2">' + esc((S.tr.dec && S.tr.dec.note) || "") + "</textarea>" +
      '<button class="btn pri blk" data-act="trdeclinego"' + (S.tr.busy ? " disabled" : "") + ">Decline offer</button></div></div>";
  }
  function confirmSheet(title, text, go, goLabel) {
    return '<div class="layer ctrl"><div class="scrim"></div><div class="rm wn" role="alertdialog" aria-modal="true" aria-labelledby="trc-t" tabindex="-1"><h2 id="trc-t">' + esc(title) + "</h2><p>" + esc(text) + "</p>" +
      '<button class="rmok" data-act="' + go + '">' + esc(goLabel) + '</button><button class="btn blk" data-act="trclose">Back</button></div></div>';
  }
  function layer(S) {
    var me = S.me && S.me.signedIn ? S.me.fid : "";
    if (!S.tr || !me) return "";
    if (S.sheet === "trreview") return reviewSheet(S, me);
    if (S.sheet === "trdecline") return declineSheet(S);
    if (S.sheet === "trcancel") return confirmSheet("Cancel this offer?", "It comes off MFL.", "trcancelgo", "Cancel offer");
    if (S.sheet === "trackSend" && S.tr.ack) return confirmSheet("Over the salary cap", "You’d be " + money(S.tr.ack.amount_over) + " over. MFL still allows it.", "trsendack", "Acknowledge and send");
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
  // The accept review (action preview): may it be accepted? The worker decides: cap ok, or an overage every affected team acknowledged; and the
  // loaded-contract limit executable. Mirrors the classic app's interpretPreview.
  function review(r) {
    var b = (r && r.body) || {};
    if (r && r.ok && b.ok !== false && b.compliance && b.compliance.cap) {
      var cap = b.compliance.cap.status, ack = b.cap_ack || null;
      var capOk = cap === "ok" || (cap === "blocked" && !!ack && !!ack.satisfied);
      var lcOk = !b.compliance.loaded_contracts || b.compliance.loaded_contracts.executable === true;
      return { state: "ok", data: { c: b.compliance, capAck: ack, canAccept: capOk && lcOk,
        message: !lcOk ? (b.compliance.loaded_contracts.status === "blocked" ? "Over the loaded-contract limit." : "Loaded contracts couldn’t be confirmed.") : cap === "blocked" && !capOk ? "Over the salary cap." : cap === "unavailable" ? "The salary cap couldn’t be checked." : "" } };
    }
    return { state: "error", why: why(r, "Couldn’t check this trade.") };
  }

  return { fresh: fresh, blankDraft: blankDraft, tokens: tokens, tokenLabel: tokenLabel, gate: gate, offerSides: offerSides, pickToken: pickToken, pickBlocked: pickBlocked,
    maxCapK: maxCapK, build: build, findSent: findSent, canSend: canSend, screen: screen, layer: layer, why: why, review: review, checkLines: checkLines };
});
