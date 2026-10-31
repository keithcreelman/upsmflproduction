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
   openLink(hash), counter() -> { tradeId, from } | null, cancelCounter(), _state } — sendDraft is what the builder's Send offer
   calls when the flag is on; counter()/cancelCounter() drive the builder's "Cancel counter".
   Offers has four boxed sections (Received, Sent, Staged, Three-team), each with a heading, a count and a status on every offer,
   and one set of action words (see actionsFor).
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
    already_accepted: "good", declined: "good", revoked: "good", cancelled: "good", accepted_staged: "good", rechecked: "info", acknowledged: "info", refreshed: "info",
    counter_cancelled: "info" };
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
      case "cancelled": return "Revoked. Everyone in the trade is told it’s off.";
      case "counter_cancelled": return "Counter cancelled. Nothing was sent or declined; Trade " + r.tradeId + " is still open.";
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
    var tone = TONE[r.state] || "warn";
    var act = "";
    if (r.state === "unconfirmed" && r.lastBody) act = ' <button type="button" class="btn small" data-to-act="retry">Retry</button>';
    if (r.state === "both_open") act = ' <button type="button" class="btn small" data-to-act="decline-original">Decline the original offer</button>';
    if (r.state === "counter_unverified") act = ' <button type="button" class="btn small" data-to-act="check-counter">Check again</button>';
    return '<div class="fo-banner ' + tone + ' fo-to-result" role="status" data-state="' + esc(r.state) + '">' + esc(outcomeText(r)) + (r.actingFid && r.actingFid !== FO.viewerFid() ? " Acting for " + esc(teamName(r.actingFid)) + "." : "") + act + "</div>";
  }

  // ONE vocabulary for every kind of offer (Keith, 2026-10-29): a received offer → Accept, Decline, Review, Counter (each only
  // where that kind of offer has it); a sent offer → Revoke, Review. The words never change between kinds. Accept always opens
  // the server's review and a separate Confirm accept; Decline and Revoke always ask first. A label never skips a check.
  //   kind: "mfl" (a direct offer pending in MFL) | "staged" (held by the trade server) | "three" (three-team)
  //   side: "received" | "sent" | "other" (the commissioner's view of a trade that isn't the acting team's)
  //   Staged: no counter (the War Room has none). Three-team: only its starter may call it off (Revoke); partners answer from the
  //   Discord DM the trade server sent them (there is no accept route on the site, the same as the War Room).
  var WORDS = { accept: "Accept", decline: "Decline", review: "Review", counter: "Counter", revoke: "Revoke" };
  function actionsFor(kind, side, p) {
    p = p || {};
    if (kind === "mfl") return side === "received" ? ["accept", "decline", "review", "counter"] : side === "sent" ? ["revoke", "review"] : ["review"];
    if (kind === "staged") {
      if (side === "received") return (p.can_accept ? ["accept"] : []).concat(p.can_cancel ? ["decline"] : [], ["review"]);
      return (side === "sent" && p.can_cancel ? ["revoke"] : []).concat(["review"]);
    }
    if (kind === "three") return (side === "sent" && p.can_cancel ? ["revoke"] : []).concat(["review"]);
    return ["review"];
  }
  function sideOf(kind, item) {
    var me = pad4(actingFid());
    if (kind === "mfl") return pad4(item.to_franchise_id) === me ? "received" : pad4(item.from_franchise_id) === me ? "sent" : "other";
    if (kind === "staged") return pad4(item.to_fid) === me ? "received" : pad4(item.from_fid) === me ? "sent" : "other";
    var role = item.viewer && item.viewer.role, first = (item.participants || [])[0];
    return role === "initiator" || (!role && first && pad4(first.fid) === me) ? "sent" : role === "partner" ? "received" : "other";
  }
  function idOf(kind, item) { return kind === "mfl" ? String(st.wr.getOfferTradeId(item)) : String(item.id || ""); }
  var STAGED_TONE = { pending_response: "wait", awaiting_review: "warn", awaiting_commissioner: "warn", executing: "busy", completed: "ok", failed: "bad", cancelled: "off" };
  // The status chip each row carries: whose move it is, in the server's own words where it has them.
  function statusOf(kind, side, item) {
    if (kind === "mfl") {
      if (st.counterOf && String(st.wr.getOfferTradeId(st.counterOf)) === idOf("mfl", item)) return { text: "Countering", tone: "busy" };
      return side === "received" ? { text: "Waiting for you", tone: "wait" } : { text: "Waiting for " + teamName(item.to_franchise_id), tone: "wait" };
    }
    var sv = item.state_view || {}, T = root.UPS_TRADE_3WAY;
    var text = sv.label || item.status || "Status unknown";
    return { text: text, tone: kind === "staged" ? (STAGED_TONE[sv.code] || "off") : (T && T.tone ? T.tone(item) : "off") };
  }
  function roleOf(kind, side, item) {
    if (kind === "mfl") return side === "received" ? "From " + teamName(item.from_franchise_id) : "To " + teamName(item.to_franchise_id);
    if (kind === "staged") return side === "received" ? "From " + (item.from_name || teamName(item.from_fid)) : side === "sent" ? "To " + (item.to_name || teamName(item.to_fid)) : "Commissioner view";
    var others = (item.participants || []).filter(function (p) { return pad4(p.fid) !== pad4(actingFid()); }).map(function (p) { return p.name || teamName(p.fid); });
    return (side === "sent" ? "You started this" : side === "received" ? "You’re a partner" : "Commissioner view") + (others.length ? " · with " + others.join(" and ") : "");
  }
  // What moves, from the acting team's side: "You get" / "You give" for a two-team offer; one line per route for three teams.
  function whatHtml(kind, side, item) {
    var me = pad4(actingFid()), line = function (k, v) { return '<div class="fo-to-line"><span class="fo-to-k">' + esc(k) + "</span> " + esc(v) + "</div>"; };
    if (kind === "mfl") {
      var from = pad4(item.from_franchise_id), to = pad4(item.to_franchise_id), give = describe(item.will_give_up, from), get = describe(item.will_receive, to);
      if (side === "received") return line("You get", give) + line("You give", get);
      if (side === "sent") return line("You give", give) + line("You get", get);
      return line(teamName(from) + " gives", give) + line(teamName(to) + " gives", get);
    }
    if (kind === "staged") {
      var mv = item.movements || [];
      if (!mv.length) return line("Trade", item.summary || item.title || "Staged trade " + item.id);
      return mv.map(function (m) {
        var f = pad4(m.from), t = pad4(m.to), what = describe((m.asset_tokens || []).join(","), f);
        return line(f === me ? "You give" : t === me ? "You get" : teamName(f) + " → " + teamName(t), what);
      }).join("");
    }
    var rows = (item.movements || []).map(function (m) {
      var f = m.from || {}, t = m.to || {};
      return line(pad4(f.fid) === me ? "You give " + (t.name || "") : pad4(t.fid) === me ? "You get from " + (f.name || "") : (f.name || "") + " → " + (t.name || ""), (m.assets || []).map(function (a) { return a.label; }).join(", ") || "nothing");
    });
    return rows.length ? rows.join("") : line("Trade", item.title || item.summary || "3-way trade " + item.id);
  }
  function buttons(kind, id, list) {
    return list.map(function (a) {
      var cls = a === "accept" ? "btn small" : "btn small secondary";
      return '<button type="button" class="' + cls + '" data-to-act="' + a + '" data-kind="' + kind + '" data-id="' + esc(id) + '">' + WORDS[a] + "</button>";
    }).join(" ");
  }
  function row(kind, item) {
    var side = sideOf(kind, item), id = idOf(kind, item), s = statusOf(kind, side, item), p = item.permissions || {};
    var focus = st.focus && st.focus.kind === (kind === "three" ? "3way" : kind) && String(st.focus.id) === id ? " fo-to-focus" : "";
    var hint = kind === "three" && side === "received" && !item.terminal ? '<p class="small fo-muted fo-to-hint">Accept or decline it from the Discord DM the trade server sent you.</p>' : "";
    return '<li class="fo-to-row' + focus + '" data-kind="' + kind + '" data-id="' + esc(id) + '" data-side="' + side + '">' +
      '<div class="fo-to-rowhead"><span class="fo-to-pill tone-' + esc(s.tone) + '" data-status>' + esc(s.text) + '</span> <span class="fo-to-role">' + esc(roleOf(kind, side, item)) + "</span>" +
      (kind === "mfl" ? ' <span class="small fo-muted">Trade ' + esc(id) + "</span>" : "") + "</div>" +
      '<div class="fo-to-what">' + whatHtml(kind, side, item) + "</div>" + hint +
      '<div class="fo-to-actions">' + buttons(kind, id, actionsFor(kind, side, p)) + "</div></li>";
  }
  // Each list is its own boxed section: a heading, a count, one line on what it holds, then its offers (or why it's empty).
  var SECTIONS = {
    received: { title: "Received", blurb: "Offers other teams sent you in MFL.", empty: "No pending offers to you." },
    sent: { title: "Sent", blurb: "Your offers waiting in MFL.", empty: "No pending offers from you." },
    staged: { title: "Staged", blurb: "Two-team trades the trade server holds for review. Not in MFL yet.", empty: "No staged two-team trades." },
    three: { title: "Three-team", blurb: "Trades among three teams.", empty: "No active three-team trades." }
  };
  function section(key, kind, list, items, rowKind) {
    var S = SECTIONS[key], n = list === "ok" ? items.length : list === "empty" ? 0 : null;
    var body = list === "ok" ? '<ul class="fo-to-list">' + items.map(function (it) { return row(rowKind, it); }).join("") + "</ul>"
      : list === "empty" ? '<p class="small fo-muted fo-to-empty">' + esc(S.empty) + "</p>"
      : list === "signed_out" ? H.banner("Sign in to MFL to see your offers.", "warn")
      : list === "refused" ? H.banner(lc().words(st.inbox && st.inbox.code), "warn")
      : H.banner("Couldn’t load this list. Try again in a moment.", "warn");
    return '<section class="fo-to-sec fo-to-sec-' + key + '" data-section="' + key + '" aria-labelledby="fo-to-h-' + key + '"><header class="fo-to-sechead"><h3 id="fo-to-h-' + key + '">' + esc(S.title) +
      ' <span class="fo-to-count" data-count="' + (n == null ? "" : n) + '">' + (n == null ? "not loaded" : n === 1 ? "1 offer" : n + " offers") + "</span></h3>" +
      '<p class="small fo-muted">' + esc(S.blurb) + "</p></header>" + body + "</section>";
  }
  function counterBanner() {
    if (!st.counterOf) return "";
    var id = st.wr.getOfferTradeId(st.counterOf);
    return '<div class="fo-banner info fo-to-countering" role="status"><b>Countering Trade ' + esc(id) + "</b> from " + esc(teamName(st.counterOf.from_franchise_id)) +
      ". Build it in the Trade builder, then Send counter: your counter goes first, and the original is declined only after your counter reaches MFL." +
      ' <span class="fo-to-actions"><button type="button" class="btn small" data-to-act="counter-open">Open the Trade builder</button> <button type="button" class="btn small secondary" data-to-act="cancel-counter">Cancel counter</button></span></div>';
  }
  function html() {
    var head = '<div class="fo-card-head"><h2>Offers</h2><span class="small fo-muted">' + (st.readAt ? "Updated " + esc(H.clock(st.readAt)) : "") + ' <button type="button" class="btn small secondary" data-to-act="reload">Reload</button></span></div>';
    if (st.wrState === "loading" || st.wrState === "idle") return '<div class="fo-card fo-to">' + simLabel() + head + '<div class="fo-table-loading">Reading your offers…</div></div>';
    if (st.wrState === "signed_out") return '<div class="fo-card fo-to">' + simLabel() + head + H.banner("Sign in to MFL, then open the Front Office from MFL again. Nothing was read or sent.", "warn") + warRoomLine() + "</div>";
    if (!st.wr) return '<div class="fo-card fo-to">' + simLabel() + head + H.banner("Couldn’t read the trade server’s rosters, so offers are off. Nothing was sent. Reload to retry.", "warn") + warRoomLine() + "</div>";
    var ib = st.inbox || { kind: "error", sent: [], received: [] }, sg = st.staged || {}, th = st.three || {};
    return '<div class="fo-card fo-to">' + simLabel() + head + actingLine() + resultHtml() + counterBanner() +
      section("received", "mfl", ib.kind, ib.received || [], "mfl") +
      section("sent", "mfl", ib.kind, ib.sent || [], "mfl") +
      section("staged", "staged", sg.kind || "error", sg.trades || [], "staged") +
      section("three", "three", th.kind || "error", th.trades || [], "three") +
      warRoomLine() + "</div>";
  }
  var host = null, chips = "";
  function render(el, chipsHtml) {
    if (!enabled()) { if (el) el.innerHTML = (chipsHtml || "") + H.banner("Offers in the Front Office are not available yet. Use the Trade War Room.", "info") + warRoomLine(); return; }
    host = el; chips = chipsHtml || "";
    wire(el);
    el.innerHTML = chips + html();
    scrollToFocus();
    if (st.wrState === "idle") refresh();
  }
  function rerender() { if (host && host.isConnected !== false && host.querySelector && host.querySelector(".fo-to")) { host.innerHTML = chips + html(); scrollToFocus(); } }
  // A deep link or a cancelled counter brings its offer into view once (never on every re-render).
  function scrollToFocus() {
    if (!st.focus || st.focus.shown || !host || !host.querySelector) return;
    var n = host.querySelector(".fo-to-focus");
    if (n) { st.focus.shown = true; if (n.scrollIntoView) n.scrollIntoView({ block: "center" }); }
  }

  // ── Actions ──
  function findMfl(id) { var ib = st.inbox || {}; return lc().findOffer((ib.received || []).concat(ib.sent || []), id); }
  function findIn(list, id) { return ((list || {}).trades || []).filter(function (x) { return String(x.id) === String(id); })[0] || null; }
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
  function dlgButtons(list) {
    return '<p class="fo-to-dlg-actions">' + list.map(function (b) { return '<button type="button" class="btn' + (b[2] ? " " + b[2] : "") + '" data-to-dlg="' + b[0] + '"' + (b[3] ? " disabled" : "") + ">" + esc(b[1]) + "</button>"; }).join(" ") + "</p>";
  }
  var CLOSE = ["close", "Close", "secondary"], KEEP = ["close", "Keep offer", "secondary"];
  // Accept (direct offer): the server's acceptance check first; Confirm accept only when it allows the trade.
  function openAccept(offer) {
    var c = client(), f = actingFid(), T = root.UPS_TRADE_3WAY;
    return c.acceptPreview(offer, f).then(function (p) {
      if (p.state !== "preview") return finish(p);
      var review = p.review || { kind: "unavailable", canAccept: false, message: "We couldn’t check this trade right now." };
      st.review = { kind: "mfl", step: "accept", offer: offer, review: review };
      var body = (T && T.renderAcceptReview ? T.renderAcceptReview(review, { viewerFid: f }) : esc(review.message || "")) +
        dlgButtons([["confirm-accept", "Confirm accept", "", !review.canAccept]].concat(review.capAck && review.capAck.needs_ack ? [["ack", "Acknowledge my cap overage", "secondary"]] : [], [CLOSE])) + simLabel();
      H.openDialog("Accept Trade " + st.wr.getOfferTradeId(offer) + "?", body, { variant: "team" });
    });
  }
  // Review (direct offer): what moves and whose move it is, with the same action words as the row. Nothing is sent from here.
  function openReviewMfl(offer) {
    var side = sideOf("mfl", offer), id = idOf("mfl", offer), s = statusOf("mfl", side, offer);
    st.review = { kind: "mfl", step: "review", offer: offer };
    var acts = actionsFor("mfl", side).filter(function (a) { return a !== "review"; });
    var body = '<div class="fo-to-dlg"><p><span class="fo-to-pill tone-' + esc(s.tone) + '">' + esc(s.text) + "</span> " + esc(roleOf("mfl", side, offer)) + "</p>" + whatHtml("mfl", side, offer) +
      (offer.comments ? '<p class="fo-to-dlgnote"><b>Note:</b> ' + esc(offer.comments) + "</p>" : "") + "</div>" +
      dlgButtons(acts.map(function (a) { return [a, WORDS[a], a === "accept" ? "" : "secondary"]; }).concat([CLOSE])) + simLabel();
    H.openDialog("Trade " + id, body, { variant: "team" });
  }
  function openDecline(offer) {
    st.review = { kind: "mfl", step: "decline", offer: offer };
    H.openDialog("Decline Trade " + st.wr.getOfferTradeId(offer) + "?", '<label class="fo-to-note">Note to ' + esc(teamName(offer.from_franchise_id)) + ' (optional, up to ' + lc().DECLINE_NOTE_LIMIT + ' characters)<textarea data-to-decline-note maxlength="' + lc().DECLINE_NOTE_LIMIT + '" rows="3"></textarea></label>' +
      dlgButtons([["confirm-decline", "Confirm decline", "danger"], KEEP]) + simLabel(), { variant: "team" });
  }
  // Revoke and staged Decline: one plain question, then the server. Kind decides the request; the words are the same.
  function openConfirm(kind, step, id, item) {
    st.review = { kind: kind, step: step, id: id, item: item };
    var who = kind === "mfl" ? teamName(item.to_franchise_id) + " will no longer be able to accept it."
      : kind === "staged" ? (step === "decline" ? (item.from_name || teamName(item.from_fid)) : (item.to_name || teamName(item.to_fid))) + " will be told it’s off. This can’t be undone."
      : "Both partners will be told it’s off. This can’t be undone.";
    var what = kind === "mfl" ? "Trade " + id : kind === "staged" ? "this staged trade" : "this three-team trade";
    H.openDialog((step === "revoke" ? "Revoke " : "Decline ") + what + "?", '<p>' + esc(who) + "</p>" +
      dlgButtons([[step === "revoke" ? "confirm-revoke" : "confirm-decline", step === "revoke" ? "Confirm revoke" : "Confirm decline", "danger"], KEEP]) + simLabel(), { variant: "team" });
  }
  // Staged and three-team: re-read the one trade from the server (never a client copy), then show it. Accept on a staged trade
  // shows the server's cap and roster check first and needs Confirm accept; a failed read offers nothing to confirm.
  function readOne(kind, id) {
    var url = kind === "staged" ? routes().staged(actingFid(), "&id=" + encodeURIComponent(id)) : routes().threeWay(actingFid(), "&id=" + encodeURIComponent(id));
    return transport({ method: "GET", url: url }).then(function (res) {
      var T = root.UPS_TRADE_3WAY;
      if (kind === "three") { var out = T ? T.interpretLoad(res) : { kind: "error" }; return out.kind === "ok" ? out.trade : null; }
      return res && !res.networkError && res.ok && res.body && res.body.ok !== false && res.body.trade ? res.body.trade : null;
    }, function () { return null; });
  }
  function stagedDetailHtml(tr) {
    var T = root.UPS_TRADE_3WAY, side = sideOf("staged", tr), s = statusOf("staged", side, tr), sv = tr.state_view || {};
    return '<div class="fo-to-dlg"><p><span class="fo-to-pill tone-' + esc(s.tone) + '">' + esc(s.text) + "</span> " + esc(roleOf("staged", side, tr)) + "</p>" +
      '<p class="small">Held by the trade server; never sent to MFL unless it clears every check.</p>' + (sv.message ? '<p class="small">' + esc(sv.message) + "</p>" : "") +
      whatHtml("staged", side, tr) +
      (tr.compliance && T && T.renderCompliance ? T.renderCompliance(tr.compliance, { gate: sv.code === "pending_response" || sv.code === "awaiting_review", viewerFid: pad4(actingFid()) }) : "") +
      (tr.cap_ack && !tr.cap_ack.satisfied ? '<p class="small fo-muted">A cap overage acknowledgment for a staged trade is made in the Trade War Room.</p>' : "") +
      (tr.notes ? '<p class="fo-to-dlgnote"><b>Note:</b> ' + esc(tr.notes) + "</p>" : "") + "</div>";
  }
  function openStaged(id, step) {
    return readOne("staged", id).then(function (tr) {
      if (!tr) { st.review = null; H.openDialog(step === "accept" ? "Accept staged trade?" : "Staged trade", H.banner("Couldn’t load this staged trade, so nothing can be accepted from here. Nothing was sent. Try again in a moment.", "warn") + dlgButtons([CLOSE]) + simLabel(), { variant: "team" }); return; }
      var side = sideOf("staged", tr), p = tr.permissions || {};
      st.review = { kind: "staged", step: step, id: id, item: tr };
      var btns = step === "accept"
        ? [["confirm-accept", "Confirm accept", "", !p.can_accept], CLOSE]
        : actionsFor("staged", side, p).filter(function (a) { return a !== "review"; }).map(function (a) { return [a, WORDS[a], a === "accept" ? "" : "secondary"]; })
            .concat(p.can_recheck ? [["recheck", "Re-check now", "secondary"]] : [], [CLOSE]);
      H.openDialog(step === "accept" ? "Accept staged trade?" : "Staged trade", stagedDetailHtml(tr) + dlgButtons(btns) + simLabel(), { variant: "team" });
    });
  }
  // A three-team trade's detail with the shared renderer (each side, what executed, the cap hold and its acknowledgment and
  // Re-check, which the renderer shows only when the server allows them). Its own Cancel button is replaced by Revoke below.
  function openThree(id) {
    var T = root.UPS_TRADE_3WAY;
    return readOne("three", id).then(function (tr) {
      if (T && T.ensureStyles && typeof document !== "undefined") T.ensureStyles(document);
      if (!tr) { st.review = null; H.openDialog("Three-team trade", H.banner("Couldn’t load this trade. Try again in a moment.", "warn") + dlgButtons([CLOSE]) + simLabel(), { variant: "team" }); return; }
      var side = sideOf("three", tr), p = tr.permissions || {};
      st.review = { kind: "three", step: "review", id: id, item: tr };
      var shown = Object.assign({}, tr, { permissions: Object.assign({}, p, { can_cancel: false, cancel_block_reason: "" }) });
      var acts = actionsFor("three", side, p).filter(function (a) { return a !== "review"; });
      H.openDialog("Three-team trade", (T && T.renderDetail ? T.renderDetail(shown, { viewerFid: pad4(actingFid()) }) : "") +
        (side === "received" && !tr.terminal ? '<p class="small fo-muted">Accept or decline it from the Discord DM the trade server sent you.</p>' : "") +
        dlgButtons(acts.map(function (a) { return [a, WORDS[a], "secondary"]; }).concat([CLOSE])) + simLabel(), { variant: "team" });
    });
  }
  function startCounter(offer) {
    var TB = root.UPS_FO_TRADE_BUILDER, f = actingFid(), from = pad4(offer.from_franchise_id);
    var toks = function (csv) { return String(csv || "").split(",").map(function (s) { return s.trim(); }).filter(function (s) { return s && s.toUpperCase().indexOf("BB_") !== 0; }).map(function (s) { return /^\d+$/.test(s) ? "P_" + s : s; }); };
    var bb = function (csv) { var k = 0; String(csv || "").split(",").forEach(function (s) { s = s.trim().toUpperCase(); if (s.indexOf("BB_") === 0) k += Math.round(Number(s.slice(3)) / 1000); }); return k; };
    if (!TB || typeof TB.openDraft !== "function") { st.result = { state: "refused", code: "not_ready", message: "The Trade builder isn’t loaded. Reload to retry." }; rerender(); return; }
    // The original, turned around: what they offered comes to me, what they asked for goes back. The owner edits it before sending.
    // Set first, so the builder paints the counter (Send counter, Cancel counter) as it loads; undone if the load fails.
    var was = st.counterOf; st.counterOf = offer;
    var r = TB.openDraft({ source: counterSource(offer), movements: [
      { from: from, to: f, tokens: toks(offer.will_give_up), cap_k: bb(offer.will_give_up) },
      { from: f, to: from, tokens: toks(offer.will_receive), cap_k: bb(offer.will_receive) }] });
    if (r && r.ok) { st.result = null; rerender(); } else { st.counterOf = was; st.result = { state: "refused", code: "not_ready", message: "Couldn’t load the counter into the Trade builder." }; rerender(); }
  }
  function counterSource(offer) { return "Counter to Trade " + st.wr.getOfferTradeId(offer); }
  // Cancel counter: nothing is sent and nothing is declined. The counter draft is cleared from the builder (only if it is still
  // that counter), and the owner is returned to the original offer, which stays open.
  function cancelCounter() {
    var o = st.counterOf; if (!o) return false;
    var id = String(st.wr.getOfferTradeId(o)), TB = root.UPS_FO_TRADE_BUILDER, T = root.UPS_FO_TRADES;
    st.counterOf = null; st.focus = { kind: "mfl", id: id }; st.result = { state: "counter_cancelled", tradeId: id };
    if (TB && typeof TB.clearDraft === "function") TB.clearDraft("Draft from " + counterSource(o) + " (not sent)");
    if (T && T._setMode) { T._setMode("offers"); if (T._rerender) T._rerender(); }
    rerender();
    return true;
  }
  function counterInfo() { return st.counterOf && st.wr ? { tradeId: String(st.wr.getOfferTradeId(st.counterOf)), from: teamName(st.counterOf.from_franchise_id) } : null; }
  function item(kind, id) { return kind === "mfl" ? findMfl(id) : kind === "staged" ? findIn(st.staged, id) : findIn(st.three, id); }
  // Row and Review-dialog actions share these words: accept | decline | review | counter | revoke.
  function start(name, kind, id) {
    var o = item(kind, id); if (!o) return;
    if (name === "review") return kind === "mfl" ? openReviewMfl(o) : kind === "staged" ? openStaged(id, "review") : openThree(id);
    if (name === "accept") return kind === "mfl" ? openAccept(o) : kind === "staged" ? openStaged(id, "accept") : undefined;
    if (name === "decline") return kind === "mfl" ? openDecline(o) : kind === "staged" ? openConfirm("staged", "decline", id, o) : undefined;
    if (name === "revoke") return openConfirm(kind, "revoke", id, o);
    if (name === "counter" && kind === "mfl") return startCounter(o);
  }
  function act(name, id, kind) {
    var c = client(), f = actingFid();
    if (name === "reload") { st.result = null; return refresh(); }
    if (name === "retry") { if (!st.last) return; st.busy = "retry"; return c.retry(st.last, f, sendCtx()).then(finish); }
    if (name === "decline-original" && st.result && st.counterOf) return c.declineOriginal(st.counterOf, { tradeId: st.result.counterTradeId, lastBody: st.result.lastBody }, f).then(function (r) { if (r.state === "countered") st.counterOf = null; return finish(r); });
    if (name === "check-counter" && st.result && st.counterOf) return c.confirmThenDecline(st.counterOf, { tradeId: st.result.counterTradeId, lastBody: st.result.lastBody }, f).then(function (r) { if (r.state === "countered") st.counterOf = null; return finish(r); });
    if (name === "cancel-counter") { cancelCounter(); return; }
    if (name === "counter-open") { var T = root.UPS_FO_TRADES; if (T && T._setMode) { T._setMode("builder"); if (T._rerender) T._rerender(); } return; }
    if (WORDS[name]) return start(name, kind || "mfl", id);
  }
  function dialogAction(target) {
    var b = target && target.closest ? target.closest("[data-to-dlg]") : null;
    var t3 = !b && target && target.closest ? target.closest("[data-t3w-act]") : null;
    var rv = st.review; if (!rv || (!b && !t3)) return;
    var c = client(), f = actingFid(), k = b ? b.getAttribute("data-to-dlg") : "t3w:" + t3.getAttribute("data-t3w-act");
    if (k === "close") { H.closeAbout(); return; }
    if (WORDS[k]) { H.closeAbout(); return start(k, rv.kind, rv.kind === "mfl" ? String(st.wr.getOfferTradeId(rv.offer)) : rv.id); }
    var go = function (p) { H.closeAbout(); st.busy = k; return p.then(finish); };
    if (rv.kind === "mfl") {
      if (k === "ack") return c.ackCap(rv.offer, f).then(function () { return openAccept(rv.offer); });
      if (k === "confirm-accept" && rv.step === "accept") return go(c.accept(rv.offer, f, rv.review));
      if (k === "confirm-decline") { var ta = document.querySelector("[data-to-decline-note]"), note = ta ? ta.value : ""; return go(c.decline(rv.offer, f, note)); }
      if (k === "confirm-revoke") return go(c.revoke(rv.item || rv.offer, f));
    }
    if (rv.kind === "staged") {
      if (k === "confirm-accept" && rv.step === "accept") return go(c.stagedAction("accept", rv.id, f));
      if (k === "confirm-decline") return go(c.stagedAction("decline", rv.id, f));
      if (k === "confirm-revoke") return go(c.stagedAction("cancel", rv.id, f));
      if (k === "recheck") return go(c.stagedAction("recheck", rv.id, f));
    }
    if (rv.kind === "three") {
      if (k === "confirm-revoke") return go(c.threeWayAction("cancel", rv.id, f));
      if (k === "t3w:recheck") return go(c.threeWayAction("recheck", rv.id, f));
      if (k === "t3w:ack-cap") return go(c.threeWayAction("ack-cap", rv.id, f));
    }
  }
  function wire(el) {
    if (!el || el.__toWired) return;
    el.__toWired = true;
    el.addEventListener("click", function (e) {
      var t = e.target && e.target.closest ? e.target.closest("[data-to-act]") : null;
      if (t && el.querySelector(".fo-to") && el.querySelector(".fo-to").contains(t)) act(t.getAttribute("data-to-act"), t.getAttribute("data-id"), t.getAttribute("data-kind"));
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

  // flagOn(): the config's write flag alone (known at first paint); enabled(): the flag AND its code has arrived.
  root.UPS_FO_TRADE_OFFERS = { enabled: enabled, flagOn: function () { return flagOn(); }, render: render, sendDraft: sendDraft, openLink: openLink, counter: counterInfo, cancelCounter: cancelCounter,
    _state: st, _act: act, _dialogAction: dialogAction, _outcomeText: outcomeText, _actionsFor: actionsFor, _words: WORDS,
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
