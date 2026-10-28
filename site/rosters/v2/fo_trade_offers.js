/* Front Office → Trades → Offers (#1338; Keith's rulings 4, 5 and 6, 2026-10-28): the pending-offer inbox and every War Room
   lifecycle action — send (two-team direct, staged, three-team), accept (server preview first, cap acknowledgment), counter,
   decline, revoke, staged and three-team management, Retry, clear outcomes and a re-read after a trade.

   OFF. This module does nothing — no tab, no markup, no request — unless the page config
   window.UPS_FO_TRADE_LIFECYCLE_CONFIG carries FO_TRADE_BUILDER_SEND === true. No production page defines it, so the
   Front Office makes only today's reads and the builder's Send offer stays disabled exactly as #1419 built it. Turning
   it on is a separate, explicit go from Keith (gates G4/G9 in the hand-off), never a side effect of this change.

   Every request is built by site/shared/trade_offer_lifecycle.js from the War Room's own code (byte-identical bodies,
   plus an idempotency key on each create), sent through the config's `transport(req)` when one is given (the phone
   preview's SIMULATED answers; tests) or fetch(credentials "omit") otherwise. Reads go only through the worker's
   authenticated, caller-scoped routes (#1391), never the offer-mirror files in the repo (K7).

   Public: UPS_FO_TRADE_OFFERS = { enabled(), render(el, chipsHtml), sendDraft(draft, note) -> Promise<outcome>,
   openLink(hash), _state } — sendDraft is what the builder's Send offer calls when the flag is on.
   Deep link into one pending offer: #fo=trades&offer=<mfl|staged|3way>:<id> (the Front Office's own hash scheme). The
   offer is always re-read from the server, never from a client copy. The Trade War Room link stays on every view. */
(function (root) {
  "use strict";
  var FO, DATA, H, LC;
  function cfg() { return root.UPS_FO_TRADE_LIFECYCLE_CONFIG || {}; }
  function lc() { return root.UPS_TRADE_OFFER_LIFECYCLE || null; }
  function enabled() { var L = lc(); return !!(L && L.enabled(cfg()) && root.UPS_WAR_ROOM_REQUESTS); }
  function esc(v) { return H ? H.esc(v) : String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function pad4(v) { var d = String(v == null ? "" : v).replace(/\D/g, ""); return d ? ("0000" + d).slice(-4) : ""; }

  var st = { wr: null, wrState: "idle", lockout: "", acting: "", inbox: null, staged: null, three: null, busy: "", result: null, last: null,
    counterOf: null, focus: null, readAt: 0, sim: false };

  // ── Transport + routes ──
  function parse(t) { try { return t ? JSON.parse(t) : null; } catch (e) { return null; } }
  function transport(req) {
    var c = cfg();
    if (typeof c.transport === "function") return Promise.resolve().then(function () { return c.transport(req); });
    return fetch(req.url, { method: req.method, headers: req.headers, body: req.body, credentials: "omit", cache: "no-store" })
      .then(function (r) { return r.text().then(function (t) { return { status: r.status, ok: r.ok, body: parse(t) }; }); }, function () { return { networkError: true }; });
  }
  function sessionUrl(u) {
    var c = cfg(), d = DATA.config();
    // The preview's simulated session is honored ONLY with its own simulated transport: nothing real is ever sent with it.
    if (c.simulated === true && typeof c.transport === "function" && c.simulatedSession) return u + "&MFL_USER_ID=" + encodeURIComponent(c.simulatedSession);
    return d.sessionQuery(u);
  }
  function routes() { var d = DATA.config(); return lc().routes({ apiBase: d.apiBase, leagueId: d.leagueId, season: d.season, sessionUrl: sessionUrl }); }
  function me() { return { sessionFid: FO.viewerFid(), isCommish: !!FO.isAdmin() }; }
  function actingFid() { return st.acting || FO.viewerFid(); }
  function client() { return lc().client({ cfg: cfg(), send: transport, warRoom: st.wr, routes: routes(), me: me(), lockout: st.lockout }); }
  function teamName(fid) { return H && H.teamName ? H.teamName(pad4(fid)) : pad4(fid); }

  // The War Room's own data (the same /trade-workbench answer and acquisition lookup it reads) → its request code.
  function loadWarRoom(force) {
    if (!force && (st.wrState === "loading" || st.wrState === "ok")) return Promise.resolve(st.wr);
    st.wrState = "loading";
    var d = DATA.config(), lookup = "../player_acquisition_lookup_" + encodeURIComponent(d.season) + ".json";
    return Promise.all([transport({ method: "GET", url: routes().workbench() }),
      fetch(lookup, { cache: "no-store" }).then(function (r) { return r.ok ? r.json() : []; }, function () { return []; }).then(function (j) { return Array.isArray(j) ? j : (j && Array.isArray(j.rows) ? j.rows : []); }, function () { return []; })])
      .then(function (out) {
        var res = out[0], raw = res && !res.networkError && res.ok ? res.body : null;
        st.wr = raw ? lc().warRoom({ raw: raw, acquisitionRows: out[1], href: "https://front-office.local/?L=" + encodeURIComponent(d.leagueId) + "&YEAR=" + encodeURIComponent(d.season), rules: root.UPS_TRADE_RULES }) : null;
        st.lockout = raw && raw.meta ? String(raw.meta.commissioner_lockout || "") : "";
        st.wrState = st.wr ? "ok" : (res && (res.status === 401 || res.status === 403) ? "signed_out" : "error");
        return st.wr;
      });
  }
  function readAll() {
    var c = client(), f = actingFid();
    return Promise.all([c.readInbox(f), c.readList("staged", f), c.readList("three", f)]).then(function (o) {
      st.inbox = o[0]; st.staged = o[1]; st.three = o[2]; st.readAt = Date.now();
    });
  }
  function refresh() {
    return loadWarRoom(false).then(function () { if (st.wr) return readAll(); }).then(rerender, rerender);
  }

  // ── Words ──
  function describe(csv, fid) {
    var team = st.wr && st.wr.getTeamById(pad4(fid)), assets = (team && team.assets) || [];
    return String(csv || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean).map(function (tok) {
      var up = tok.toUpperCase();
      if (up.indexOf("BB_") === 0) return "$" + Math.round(Number(up.slice(3)) / 1000) + "K cap money";
      var pid = up.replace(/^P_/, "");
      var a = assets.filter(function (x) { return String(x.player_id) === pid || String(x.pick_key).toUpperCase() === up; })[0];
      return a ? (a.player_name || a.pick_display || a.description || tok) : tok;
    }).join(", ") || "nothing";
  }
  var TONE = { sent: "good", staged: "good", sent_three_team: "good", already_sent: "good", already_staged: "good", already_sent_three_team: "good", countered: "good", executed: "good",
    already_accepted: "good", declined: "good", revoked: "good", cancelled: "good", accepted_staged: "good", rechecked: "info", acknowledged: "info", refreshed: "info" };
  function outcomeText(r) {
    var id = r.tradeId ? " (Trade ID " + r.tradeId + ")" : "";
    switch (r.state) {
      case "sent": return "Offer sent to MFL" + id + "." + (r.replay ? " (It had already been sent; nothing was sent twice.)" : "");
      case "staged": return "Staged, awaiting review. Held by the trade server; not sent to MFL yet.";
      case "sent_three_team": return "3-way sent. Both partners get a DM to accept or decline.";
      case "already_sent": return "Already reached MFL" + id + ". It was not sent again.";
      case "already_staged": return "Already staged. It was not sent again.";
      case "already_sent_three_team": return "That 3-way was already created. It was not sent again.";
      case "countered": return r.message || "Counter sent. The original offer was declined.";
      case "both_open": return r.message || "Your counter was sent, but the original offer is still open.";
      case "counter_unverified": return lc().words("counter_unverified");
      case "executed": return "Trade executed in MFL" + id + "." + (r.summary && r.summary.text ? " " + r.summary.text + "." : "");
      case "executed_needs_review": return r.message || "Your trade WAS executed in MFL. Its contract/extension step didn't finish and needs commissioner review (nothing for you to do).";
      case "already_accepted": return "This trade was already executed in MFL.";
      case "accept_unconfirmed": return lc().words(r.code === "execution_in_progress" ? "execution_in_progress" : "execution_unconfirmed");
      case "declined": return "Offer declined in MFL.";
      case "revoked": return "Offer revoked in MFL.";
      case "cancelled": return "Cancelled.";
      case "accepted_staged": return "Accepted.";
      case "unconfirmed": return lc().words(r.code) + " Use Retry: it checks your sent offers first and never sends twice.";
      case "mfl_rejected": return "MFL refused this" + (r.message ? ": " + r.message : ".");
      case "needs_shorter_note": return "This offer goes through staged review, which keeps notes up to " + r.limit + " characters. Shorten your note to " + r.limit + " or fewer (yours is " + r.length + ").";
      case "blocked_loaded": return lc().words("loaded_contract_limit_exceeded") + teamsLine(r.teams);
      default: return r.message || lc().words(r.code);
    }
  }
  function teamsLine(teams) { return (teams || []).length ? " " + teams.map(function (t) { return (t.franchise_name || teamName(t.franchise_id)) + ": " + t.projected + " of " + t.max; }).join("; ") + "." : ""; }

  // ── Render ──
  function simLabel() { return cfg().simulated === true ? '<div class="fo-banner warn fo-to-sim" role="note"><b>SIMULATED</b> — preview only. Every answer here is canned; no request reaches MFL or the trade server.</div>' : ""; }
  function warRoomLine() { var u = FO && FO.warRoomUrl ? FO.warRoomUrl({}) : ""; return u ? '<p class="fo-basis"><a class="fo-go" href="' + esc(u) + '">Trade War Room ↗</a> stays available for every step.</p>' : ""; }
  function actingLine() {
    var a = actingFid(), self = FO.viewerFid(), canAct = FO.isAdmin() && String(st.lockout).toUpperCase() === "N";
    var pick = canAct ? '<label class="fo-to-acting-pick">Act for <select data-to-acting>' + FO.teams().map(function (t) { return '<option value="' + esc(t.fid) + '"' + (t.fid === a ? " selected" : "") + ">" + esc(t.name) + "</option>"; }).join("") + "</select></label>" : "";
    var why = FO.isAdmin() && !canAct ? '<span class="small fo-muted">Acting for another team is off: commissioner lockout is on (or couldn’t be read).</span>' : "";
    return '<div class="fo-to-acting" data-acting="' + esc(a) + '"><span>Acting as <b>' + esc(teamName(a)) + "</b>" + (a !== self ? " (commissioner acting for this team)" : "") + "</span> " + pick + why + "</div>";
  }
  function resultHtml() {
    var r = st.result; if (!r) return "";
    var tone = TONE[r.state] || (r.state === "both_open" || r.state === "counter_unverified" || r.state === "unconfirmed" || r.state === "accept_unconfirmed" || r.state === "executed_needs_review" ? "warn" : "warn");
    var act = "";
    if (r.state === "unconfirmed" && r.lastBody) act = ' <button type="button" class="btn small" data-to-act="retry">Retry</button>';
    if (r.state === "both_open") act = ' <button type="button" class="btn small" data-to-act="decline-original">Decline the original offer</button>';
    if (r.state === "counter_unverified") act = ' <button type="button" class="btn small" data-to-act="check-counter">Check again</button>';
    return '<div class="fo-banner ' + tone + ' fo-to-result" role="status" data-state="' + esc(r.state) + '">' + esc(outcomeText(r)) + (r.actingFid && r.actingFid !== FO.viewerFid() ? " Acting for " + esc(teamName(r.actingFid)) + "." : "") + act + "</div>";
  }
  function offerRow(o, bucket) {
    var id = st.wr.getOfferTradeId(o), from = pad4(o.from_franchise_id), to = pad4(o.to_franchise_id);
    var focus = st.focus && st.focus.kind === "mfl" && st.focus.id === id ? " fo-to-focus" : "";
    var btns = bucket === "received"
      ? '<button type="button" class="btn small" data-to-act="review" data-id="' + esc(id) + '">Review &amp; accept</button> <button type="button" class="btn small secondary" data-to-act="counter" data-id="' + esc(id) + '">Counter</button> <button type="button" class="btn small secondary" data-to-act="decline" data-id="' + esc(id) + '">Decline</button>'
      : '<button type="button" class="btn small secondary" data-to-act="revoke" data-id="' + esc(id) + '">Revoke</button>';
    return '<li class="fo-to-row' + focus + '" data-offer="' + esc(id) + '"><div class="fo-to-what"><b>' + esc(teamName(from)) + "</b> gives " + esc(describe(o.will_give_up, from)) +
      "; <b>" + esc(teamName(to)) + "</b> gives " + esc(describe(o.will_receive, to)) + ' <span class="small fo-muted">Trade ' + esc(id) + '</span></div><div class="fo-to-actions">' + btns + "</div></li>";
  }
  function listHtml(title, kind, rows, render, emptyText) {
    var count = kind === "ok" ? rows.length : kind === "empty" ? 0 : "–";
    var body = kind === "ok" ? '<ul class="fo-to-list">' + rows.map(render).join("") + "</ul>"
      : kind === "empty" ? '<p class="small fo-muted">' + esc(emptyText) + "</p>"
      : kind === "signed_out" ? H.banner("Sign in to MFL to see your offers.", "warn")
      : kind === "refused" ? H.banner(lc().words(st.inbox && st.inbox.code), "warn")
      : H.banner("Couldn’t load this list. Try again in a moment.", "warn");
    return '<section class="fo-to-sec"><h3>' + esc(title) + ' <span class="fo-to-count">' + esc(count) + "</span></h3>" + body + "</section>";
  }
  function stagedRow(tr) {
    var p = tr.permissions || {}, id = String(tr.id || "");
    var b = (p.can_accept ? '<button type="button" class="btn small" data-to-act="staged-accept" data-id="' + esc(id) + '">Accept</button> ' : "") +
      (p.can_cancel ? '<button type="button" class="btn small secondary" data-to-act="staged-cancel" data-id="' + esc(id) + '">' + (p.can_accept ? "Decline" : "Cancel") + "</button> " : "") +
      '<button type="button" class="btn small secondary" data-to-act="staged-recheck" data-id="' + esc(id) + '">Re-check</button>';
    return '<li class="fo-to-row" data-staged="' + esc(id) + '"><div class="fo-to-what">' + esc((tr.summary || tr.title || "Staged trade " + id)) + ' <span class="small fo-muted">' + esc((tr.state_view && tr.state_view.label) || tr.status || "") + '</span></div><div class="fo-to-actions">' + b + "</div></li>";
  }
  function threeRow(tr) {
    var p = tr.permissions || {}, id = String(tr.id || "");
    var b = '<button type="button" class="btn small secondary" data-to-act="3way-open" data-id="' + esc(id) + '">Details</button> ' +
      (p.can_cancel ? '<button type="button" class="btn small secondary" data-to-act="3way-cancel" data-id="' + esc(id) + '">Cancel</button> ' : "") +
      '<button type="button" class="btn small secondary" data-to-act="3way-recheck" data-id="' + esc(id) + '">Re-check</button> <button type="button" class="btn small secondary" data-to-act="3way-ack" data-id="' + esc(id) + '">Acknowledge my cap overage</button>';
    return '<li class="fo-to-row" data-three="' + esc(id) + '"><div class="fo-to-what">' + esc(tr.title || tr.summary || "3-way trade " + id) + ' <span class="small fo-muted">' + esc((tr.state_view && tr.state_view.label) || tr.status || "") + '</span></div><div class="fo-to-actions">' + b + "</div></li>";
  }
  function html() {
    var head = '<div class="fo-card-head"><h2>Offers</h2><span class="small fo-muted">' + (st.readAt ? "Updated " + esc(H.clock(st.readAt)) : "") + ' <button type="button" class="btn small secondary" data-to-act="reload">Reload</button></span></div>';
    if (st.wrState === "loading" || st.wrState === "idle") return '<div class="fo-card fo-to">' + simLabel() + head + '<div class="fo-table-loading">Reading your offers…</div></div>';
    if (st.wrState === "signed_out") return '<div class="fo-card fo-to">' + simLabel() + head + H.banner("Sign in to MFL, then open the Front Office from MFL again. Nothing was read or sent.", "warn") + warRoomLine() + "</div>";
    if (!st.wr) return '<div class="fo-card fo-to">' + simLabel() + head + H.banner("Couldn’t read the trade server’s rosters, so offers are off. Nothing was sent. Reload to retry.", "warn") + warRoomLine() + "</div>";
    var ib = st.inbox || { kind: "error", sent: [], received: [] };
    return '<div class="fo-card fo-to">' + simLabel() + head + actingLine() + resultHtml() +
      (st.counterOf ? '<div class="fo-banner info fo-to-countering">Countering Trade ' + esc(st.wr.getOfferTradeId(st.counterOf)) + ' in the Trade builder. Send offer there sends the counter first; the original is declined only after the counter shows in your sent offers. <button type="button" class="btn small secondary" data-to-act="counter-cancel">Stop countering</button></div>' : "") +
      listHtml("Received", ib.kind, ib.received, function (o) { return offerRow(o, "received"); }, "No pending offers to you.") +
      listHtml("Sent", ib.kind, ib.sent, function (o) { return offerRow(o, "sent"); }, "No pending offers from you.") +
      listHtml("Staged", (st.staged || {}).kind || "error", (st.staged || {}).trades || [], stagedRow, "No staged two-team trades.") +
      listHtml("Three-team", (st.three || {}).kind || "error", (st.three || {}).trades || [], threeRow, "No active 3-way trades.") +
      warRoomLine() + "</div>";
  }
  var host = null, chips = "";
  function render(el, chipsHtml) {
    if (!enabled()) { if (el) el.innerHTML = (chipsHtml || "") + H.banner("Offers in the Front Office are not available yet. Use the Trade War Room.", "info") + warRoomLine(); return; }
    host = el; chips = chipsHtml || "";
    wire(el);
    el.innerHTML = chips + html();
    if (st.wrState === "idle") refresh();
  }
  function rerender() { if (host && host.isConnected !== false && host.querySelector && host.querySelector(".fo-to")) host.innerHTML = chips + html(); }

  // ── Actions ──
  function findMfl(id) { var ib = st.inbox || {}; return lc().findOffer((ib.received || []).concat(ib.sent || []), id); }
  function finish(r) {
    st.busy = ""; st.result = r; if (r && r.lastBody) st.last = r;
    var moved = r && ["executed", "executed_needs_review", "already_accepted"].indexOf(r.state) !== -1;
    var done = moved ? client().afterTrade(r.tradeId, actingFid()).then(function () { return reloadAfterTrade(); }) : Promise.resolve();
    return done.then(function () { return readAll(); }).then(function () { rerender(); return r; }, function () { rerender(); return r; });
  }
  // After anything that moved players: the War Room's after-trade refresh, then ONE batch of re-reads (rosters, cap, picks,
  // the trade server's rosters, pending offers); no per-player request.
  function reloadAfterTrade() {
    var jobs = [loadWarRoom(true)];
    if (FO && typeof FO.reloadAfterTrade === "function") jobs.push(FO.reloadAfterTrade());
    if (DATA && DATA.refresh) { jobs.push(DATA.refresh("picks")); if (FO.viewerFid()) jobs.push(DATA.refresh("franchiseAssets", FO.viewerFid())); }
    return Promise.all(jobs.map(function (p) { return Promise.resolve(p).catch(function () { return null; }); }));
  }
  function confirmCapAck(need) {
    var T = root.UPS_TRADE_3WAY, m = T && T.money ? T.money : function (n) { return "$" + Math.round(Number(n) || 0).toLocaleString("en-US"); };
    var q = "Over the salary cap: " + m(need.amount_over) + " over the " + m(need.cap_dollars) + " cap" + (need.projected_used != null ? " (projected " + m(need.projected_used) + ")" : "") + ". Acknowledge and send?";
    var ask = cfg().confirm || root.confirm;
    return Promise.resolve(typeof ask === "function" ? !!ask(q) : false);
  }
  function confirmPartnerOverLoaded(teams) {
    var ask = cfg().confirm || root.confirm;
    return Promise.resolve(typeof ask === "function" ? !!ask("A partner would be over the loaded-contract limit:" + teamsLine(teams) + " They must fix it before they can accept. Send anyway?") : false);
  }
  var sendCtx = function () { return { confirmCapAck: confirmCapAck, confirmPartnerOverLoaded: confirmPartnerOverLoaded }; };
  // What the builder's Send offer calls (flag on). A counter in progress sends the counter sequence instead.
  function sendDraft(draft, note) {
    if (!enabled()) return Promise.resolve({ state: "refused", code: "flag_off", message: lc() ? lc().words("flag_off") : "" });
    if (st.busy) return Promise.resolve({ state: "refused", code: "request_in_progress", message: lc().words("request_in_progress") });
    st.busy = "send";
    return loadWarRoom(false).then(function () {
      if (!st.wr) return { state: "refused", code: "team_not_in_war_room" };
      var c = client(), f = actingFid(), n = (draft.teams || []).length;
      if (st.counterOf) return c.counter(st.counterOf, draft, f, note, sendCtx()).then(function (r) { if (r.state === "countered") st.counterOf = null; return r; });
      return n === 3 ? c.sendThreeTeam(draft, f, note, sendCtx()) : c.sendTwoTeam(draft, f, note, sendCtx());
    }).then(finish, function () { return finish({ state: "unconfirmed", code: "network" }); });
  }
  function openReview(offer) {
    var c = client(), f = actingFid(), T = root.UPS_TRADE_3WAY;
    return c.acceptPreview(offer, f).then(function (p) {
      if (p.state !== "preview") return finish(p);
      var review = p.review || { kind: "unavailable", canAccept: false, message: "We couldn’t check this trade right now." };
      st.review = { offer: offer, review: review };
      var body = (T && T.renderAcceptReview ? T.renderAcceptReview(review, { viewerFid: f }) : esc(review.message || "")) +
        '<p class="fo-to-dlg-actions"><button type="button" class="btn" data-to-dlg="accept"' + (review.canAccept ? "" : " disabled") + ">Accept trade</button> " +
        (review.capAck && review.capAck.needs_ack ? '<button type="button" class="btn secondary" data-to-dlg="ack">Acknowledge my cap overage</button> ' : "") +
        '<button type="button" class="btn secondary" data-to-dlg="close">Not now</button></p>' + simLabel();
      H.openDialog("Accept Trade " + st.wr.getOfferTradeId(offer) + "?", body, { variant: "team" });
    });
  }
  function openDecline(offer) {
    st.review = { offer: offer, decline: true };
    H.openDialog("Decline Trade " + st.wr.getOfferTradeId(offer) + "?", '<label class="fo-to-note">Note to ' + esc(teamName(offer.from_franchise_id)) + ' (optional, up to ' + lc().DECLINE_NOTE_LIMIT + ' characters)<textarea data-to-decline-note maxlength="' + lc().DECLINE_NOTE_LIMIT + '" rows="3"></textarea></label>' +
      '<p class="fo-to-dlg-actions"><button type="button" class="btn danger" data-to-dlg="decline">Decline offer</button> <button type="button" class="btn secondary" data-to-dlg="close">Keep it</button></p>' + simLabel(), { variant: "team" });
  }
  function startCounter(offer) {
    var TB = root.UPS_FO_TRADE_BUILDER, f = actingFid(), from = pad4(offer.from_franchise_id);
    var toks = function (csv) { return String(csv || "").split(",").map(function (s) { return s.trim(); }).filter(function (s) { return s && s.toUpperCase().indexOf("BB_") !== 0; }).map(function (s) { return /^\d+$/.test(s) ? "P_" + s : s; }); };
    var bb = function (csv) { var k = 0; String(csv || "").split(",").forEach(function (s) { s = s.trim().toUpperCase(); if (s.indexOf("BB_") === 0) k += Math.round(Number(s.slice(3)) / 1000); }); return k; };
    if (!TB || typeof TB.openDraft !== "function") { st.result = { state: "refused", code: "not_ready", message: "The Trade builder isn’t loaded. Reload to retry." }; rerender(); return; }
    // The original, turned around: what they offered comes to me, what they asked for goes back. The owner edits it before sending.
    var r = TB.openDraft({ source: "Counter to Trade " + st.wr.getOfferTradeId(offer), movements: [
      { from: from, to: f, tokens: toks(offer.will_give_up), cap_k: bb(offer.will_give_up) },
      { from: f, to: from, tokens: toks(offer.will_receive), cap_k: bb(offer.will_receive) }] });
    if (r && r.ok) { st.counterOf = offer; st.result = null; rerender(); } else { st.result = { state: "refused", code: "not_ready", message: "Couldn’t load the counter into the Trade builder." }; rerender(); }
  }
  function act(name, id) {
    var c = client(), f = actingFid(), o;
    if (name === "reload") { st.result = null; return refresh(); }
    if (name === "retry") { if (!st.last) return; st.busy = "retry"; return c.retry(st.last, f, sendCtx()).then(finish); }
    if (name === "decline-original" && st.result && st.counterOf) return c.declineOriginal(st.counterOf, { tradeId: st.result.counterTradeId, lastBody: st.result.lastBody }, f).then(function (r) { if (r.state === "countered") st.counterOf = null; return finish(r); });
    if (name === "check-counter" && st.result && st.counterOf) return c.confirmThenDecline(st.counterOf, { tradeId: st.result.counterTradeId, lastBody: st.result.lastBody }, f).then(function (r) { if (r.state === "countered") st.counterOf = null; return finish(r); });
    if (name === "counter-cancel") { st.counterOf = null; rerender(); return; }
    if (name === "review") { o = findMfl(id); if (o) return openReview(o); }
    if (name === "decline") { o = findMfl(id); if (o) return openDecline(o); }
    if (name === "counter") { o = findMfl(id); if (o) return startCounter(o); }
    if (name === "revoke") { o = findMfl(id); var ask = cfg().confirm || root.confirm; if (o && typeof ask === "function" && ask("Revoke Trade " + id + "? " + teamName(o.to_franchise_id) + " will no longer be able to accept it.")) return c.revoke(o, f).then(finish); return; }
    if (name === "staged-accept") return c.stagedAction("accept", id, f).then(finish);
    if (name === "staged-cancel") return c.stagedAction("cancel", id, f).then(finish);
    if (name === "staged-recheck") return c.stagedAction("recheck", id, f).then(finish);
    if (name === "3way-cancel") return c.threeWayAction("cancel", id, f).then(finish);
    if (name === "3way-recheck") return c.threeWayAction("recheck", id, f).then(finish);
    if (name === "3way-ack") return c.threeWayAction("ack-cap", id, f).then(finish);
    if (name === "3way-open") return openThree(id);
  }
  // A 3-way trade's detail, re-read from the server, with the shared renderer (which shows each leg and what executed).
  function openThree(id) {
    var T = root.UPS_TRADE_3WAY;
    return transport({ method: "GET", url: routes().threeWay(actingFid(), "&id=" + encodeURIComponent(id)) }).then(function (res) {
      var out = T ? T.interpretLoad(res) : { kind: "error" };
      H.openDialog("3-way trade", (out.kind === "ok" && T.renderDetail ? T.renderDetail(out.trade, { viewerFid: actingFid() }) : H.banner("Couldn’t load this trade. Try again in a moment.", "warn")) + simLabel(), { variant: "team" });
    });
  }
  function dialogAction(target) {
    var b = target && target.closest ? target.closest("[data-to-dlg]") : null;
    if (!b || !st.review) return;
    var k = b.getAttribute("data-to-dlg"), o = st.review.offer, c = client(), f = actingFid();
    if (k === "close") { H.closeAbout(); return; }
    if (k === "ack") return c.ackCap(o, f).then(function () { return openReview(o); });
    if (k === "accept") { var rv = st.review.review; H.closeAbout(); st.busy = "accept"; return c.accept(o, f, rv).then(finish); }
    if (k === "decline") { var ta = document.querySelector("[data-to-decline-note]"), note = ta ? ta.value : ""; H.closeAbout(); return c.decline(o, f, note).then(finish); }
  }
  function wire(el) {
    if (!el || el.__toWired) return;
    el.__toWired = true;
    el.addEventListener("click", function (e) {
      var t = e.target && e.target.closest ? e.target.closest("[data-to-act]") : null;
      if (t && el.querySelector(".fo-to") && el.querySelector(".fo-to").contains(t)) act(t.getAttribute("data-to-act"), t.getAttribute("data-id"));
    });
    el.addEventListener("change", function (e) {
      var t = e.target;
      if (t && t.hasAttribute && t.hasAttribute("data-to-acting")) {
        var a = lc().acting(me(), t.value, st.lockout);
        st.acting = a.ok ? a.fid : ""; st.result = a.ok ? null : { state: "refused", code: a.code };
        readAll().then(rerender, rerender);
      }
    });
    var dlg = document.getElementById("fo-about-body");
    if (dlg && !dlg.__toWired) { dlg.__toWired = true; dlg.addEventListener("click", function (e) { dialogAction(e.target); }); }
  }
  // #fo=trades&offer=<kind>:<id> → the Offers view with that offer highlighted (lists re-read from the server first).
  function openLink(hash) {
    var L = lc(), link = L && L.parseOfferLink(hash);
    if (!link || !enabled()) return false;
    st.focus = link;
    var T = root.UPS_FO_TRADES;
    if (T && T._setMode) T._setMode("offers");
    if (FO && FO.show) FO.show("trades");
    refresh().then(function () {
      if (link.kind === "3way") return openThree(link.id);
      if (link.kind === "mfl" && !findMfl(link.id)) { st.result = { state: "not_pending", code: "offer_not_pending" }; rerender(); }
    });
    return true;
  }

  root.UPS_FO_TRADE_OFFERS = { enabled: enabled, render: render, sendDraft: sendDraft, openLink: openLink, _state: st, _act: act, _dialogAction: dialogAction, _outcomeText: outcomeText,
    _reset: function () { st.wr = null; st.wrState = "idle"; st.inbox = st.staged = st.three = st.result = st.last = st.counterOf = st.focus = null; st.acting = ""; st.busy = ""; } };
  // The lifecycle code (the War Room's generated request code, the state machines, the shared 3-way renderer; ~230 KB) is
  // fetched ONLY when the flag is on. Flag off: none of it is downloaded, and this file does nothing else.
  var SELF = typeof document !== "undefined" && document.currentScript ? String(document.currentScript.src || "") : "";
  var DEPS = ["trade_3way_view.js", "war_room_requests.js", "trade_offer_lifecycle.js"];
  function flagOn() { return cfg().FO_TRADE_BUILDER_SEND === true; }
  function loadDeps() {
    var stamp = (/[?&]v=([\w.-]+)/.exec(SELF) || [])[1] || "", dir = SELF.replace(/[?#].*$/, "").replace(/[^\/]*$/, "");
    var base = dir ? dir.replace(/rosters\/v2\/$/, "shared/") : "../../shared/";
    return DEPS.reduce(function (chain, f) {
      return chain.then(function () {
        if (f === "trade_3way_view.js" && root.UPS_TRADE_3WAY) return;
        if (f === "war_room_requests.js" && root.UPS_WAR_ROOM_REQUESTS) return;
        if (f === "trade_offer_lifecycle.js" && root.UPS_TRADE_OFFER_LIFECYCLE) return;
        return new Promise(function (resolve) {
          var tag = document.createElement("script");
          tag.src = base + f + (stamp ? "?v=" + stamp : ""); tag.async = false;
          tag.onload = resolve; tag.onerror = resolve;          // a failed load leaves enabled() false: nothing is offered
          (document.head || document.documentElement).appendChild(tag);
        });
      });
    }, Promise.resolve());
  }
  if (typeof document !== "undefined") {
    document.addEventListener("fo:ready", function () {
      FO = root.UPS_FO; DATA = root.UPS_FO_DATA; H = root.UPS_FO_HUB;
      if (!flagOn()) return;                        // OFF: no download, no listener, no request
      loadDeps().then(function () {
        LC = lc();
        if (!enabled()) return;
        var a = document.querySelector(".fo-section.active");
        if (a && a.getAttribute("data-section") === "trades" && root.UPS_FO_TRADES && root.UPS_FO_TRADES._rerender) root.UPS_FO_TRADES._rerender();
        if (window.location) openLink(window.location.hash);
        window.addEventListener("hashchange", function () { openLink(window.location.hash); });
      });
    });
  }
})(typeof window !== "undefined" ? window : this);
