/* Front Office trade-offer lifecycle (#1338; Keith's rulings 4, 5 and 6, 2026-10-28). Pure: request builders, the send /
   accept / counter / Retry state machines, the commissioner acting rule, note limits, inbox states and owner wording.
   It never calls fetch itself: every request goes through the `send(req)` the caller hands in, so a test or the phone
   preview can answer with mocked or SIMULATED responses.

   OFF BY DEFAULT. Nothing here runs unless the page config carries FO_TRADE_BUILDER_SEND === true (exactly true). No
   production config defines it. With it off, client() returns a client whose every flow refuses before building a
   request, and the Front Office pages make no request beyond today's reads. This is not approval to enable any write.

   PARITY (ruling 4): every request is the War Room's own. Bodies come from the War Room's code itself
   (site/shared/war_room_requests.js, GENERATED from site/trades/trade_workbench.js), loaded with the same
   /trade-workbench answer; the few lines that assemble a body inside a War Room click handler are copied here and
   checked against the real War Room in tests/fo_trade_lifecycle_parity.test.mjs. The only difference: every CREATE
   (two-team, staged two-team, three-team, counter) carries an `idempotency_key` (#1396), added as the LAST field.
   Labels inside the War Room's bodies ("source": "trade-workbench-ui", "cancelled from the Trade War Room") are kept
   as they are, because byte parity is the rule; changing them is a separate, deliberate follow-up.

   SAFETY RULES BUILT IN
   - No automatic retry. One owner action = one create request. The only second request is the cap-acknowledgment
     resend, sent once, after the owner confirms the exact figure, with the same idempotency key.
   - Retry (ruling 5) first reads the caller's sent offers; an offer that already arrived is never sent again, and when
     that read is unavailable Retry REFUSES.
   - Counter (ruling 4): the new offer is created first; the original is declined only after the caller's sent-offer list
     shows the counter. A failed counter leaves the original open. If the decline fails, both offers exist and the result
     says so, with one recovery action (decline the original). The worker's COUNTER action (it rejects first) is never used.
   - Commissioner acting for another team (ruling 5): only a commissioner, only when /trade-workbench reports commissioner
     lockout "N" (off); anything else, including unknown, refuses. The acting team is part of every result.
   - A missing MFL session refuses before any request ("Sign in to MFL…" + the War Room link).
   - Loaded-contract limit: a hard stop, never a picker; staged offers never carry `loaded_contract_drops` (R8 is open).
*/
(function (root) {
  "use strict";
  var FLAG = "FO_TRADE_BUILDER_SEND";
  // Ruling 6 (2026-10-28): the owner's own note. The War Room adds its pre-trade-extension summary lines to two-team notes
  // on top of this (composeTradeMessage); its three-team body carries no summary (the extension terms ride in
  // extension_requests), so neither does ours. Open item: MFL may keep only ~598 characters of a trade's COMMENTS (10-13 note).
  var NOTE_LIMITS = { direct: 2000, staged: 500, three_team: 500 };
  var DECLINE_NOTE_LIMIT = 2000;
  var COUNTER_DECLINE_NOTE = "Countered with a new offer.";

  function str(v) { return v == null ? "" : String(v).trim(); }
  function pad4(v) { var d = str(v).replace(/\D/g, ""); return d ? ("0000" + d).slice(-4) : ""; }
  function enabled(cfg) { return !!(cfg && cfg[FLAG] === true); }
  function WRQ() {
    if (root.UPS_WAR_ROOM_REQUESTS) return root.UPS_WAR_ROOM_REQUESTS;
    if (typeof require === "function") { try { return require("./war_room_requests.js"); } catch (e) { /* not in node */ } }
    return null;
  }

  // ── Idempotency key (#1396: 8–128 of [A-Za-z0-9_-], first alnum). A v4 UUID from the page's crypto. ──
  function newKey(randomBytes) {
    var b = randomBytes ? randomBytes(16) : (root.crypto && root.crypto.getRandomValues ? root.crypto.getRandomValues(new Uint8Array(16)) : null);
    if (!b || b.length < 16) return "";                 // no randomness → no key → the caller refuses to send
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20, 32);
  }
  function withKey(body, key) { var out = {}; Object.keys(body).forEach(function (k) { out[k] = body[k]; }); out.idempotency_key = key; return out; }

  // ── Routes: the War Room's worker paths. `sessionUrl(u)` adds the viewer's MFL session (the Front Office's own helper);
  // the admin key is never forwarded (#1395 commit 3). No MFL_USER_ID → no session → nothing is sent. ──
  function routes(o) {
    var base = str(o.apiBase).replace(/\/$/, ""), q = "?L=" + encodeURIComponent(str(o.leagueId)) + "&YEAR=" + encodeURIComponent(str(o.season));
    function u(path, extra) {
      var raw = (o.sessionUrl || function (x) { return x; })(base + path + q + (extra || ""));
      return String(raw).replace(/([?&])APIKEY=[^&#]*(&?)/g, function (m, a, b) { return b ? a : ""; }).replace(/[?&]$/, "");
    }
    var acting = function (fid) { return "&acting_franchise_id=" + encodeURIComponent(pad4(fid)); };
    return {
      offers: function (fid) { return u("/trade-offers", "&FRANCHISE_ID=" + pad4(fid) + acting(fid) + "&status=PENDING&include_payload=1&limit=300"); },
      create: function () { return u("/trade-offers"); },
      action: function () { return u("/trade-offers/action"); },
      staged: function (fid, extra) { return u("/api/trades/2way", acting(fid) + (extra || "")); },
      stagedAct: function (fid, verb) { return u("/api/trades/2way/" + verb, acting(fid)); },
      threeWay: function (fid, extra) { return u("/api/trades/3way", (fid ? acting(fid) : "") + (extra || "")); },
      threeWayAct: function (fid, verb) { return u("/api/trades/3way/" + verb, acting(fid)); },
      preview: function () { return u("/api/trades/compliance-preview"); },
      refresh: function () { return u("/refresh/after-trade"); },
      workbench: function () { return u("/trade-workbench"); }
    };
  }
  function hasSession(url) { return /[?&]MFL_USER_ID=[^&#]+/.test(String(url || "")); }

  // ── The War Room model: its own code, loaded with the /trade-workbench answer the Front Office read. ──
  function warRoom(o) {
    var W = WRQ();
    if (!W || !o || !o.raw || !Array.isArray(o.raw.teams)) return null;
    var wr = W.create({ href: o.href, rules: o.rules || root.UPS_TRADE_RULES || null, leagueContext: o.leagueContext });
    wr.state.data = wr.normalizeData(o.raw);
    wr.applyAcquisitionLookupToTradeData(wr.state.data, o.acquisitionRows || []);
    return wr;
  }
  function tokenOf(a) {
    if (!a) return "";
    if (String(a.type).toUpperCase() === "PLAYER") return "P_" + str(a.player_id).replace(/\D/g, "");
    if (String(a.type).toUpperCase() === "PICK") return str(a.pick_key);
    return "";
  }
  function assetByToken(wr, fid, token) {
    var t = wr.getTeamById(pad4(fid));
    return ((t && t.assets) || []).filter(function (a) { return tokenOf(a) === token; })[0] || null;
  }

  // ── Acting franchise (ruling 5). me = { sessionFid, isCommish }, lockout = /trade-workbench meta.commissioner_lockout. ──
  function acting(me, targetFid, lockout) {
    var self = pad4(me && me.sessionFid), target = pad4(targetFid) || self;
    if (!self) return { ok: false, code: "unauthenticated", fid: "" };
    if (target === self) return { ok: true, fid: self, actingFor: false };
    if (!(me && me.isCommish)) return { ok: false, code: "not_commissioner", fid: target };
    if (str(lockout).toUpperCase() !== "N") return { ok: false, code: "lockout_on_or_unknown", fid: target };
    return { ok: true, fid: target, actingFor: true };
  }

  // ── Notes ──
  function noteLimit(kind) { return NOTE_LIMITS[kind] || 500; }
  function noteProblem(kind, note) { var n = String(note == null ? "" : note); return n.length > noteLimit(kind) ? { code: "note_too_long", limit: noteLimit(kind), length: n.length } : null; }

  // ── Two-team: the Front Office draft → the War Room's selections → its payload and its exact create body. ──
  // Refuses (never adjusts) when the War Room would send something different from what the owner built: an asset the
  // War Room's data doesn't hold or won't trade, an extension it doesn't offer, or cap money above ITS limit (R2 basis).
  function twoTeam(wr, draft, actingFid, note, opts) {
    opts = opts || {};
    var S = wr.state, me = pad4(actingFid), other = (draft.teams || []).map(pad4).filter(function (f) { return f !== me; });
    var problems = [];
    if (other.length !== 1) return { ok: false, problems: [{ code: "not_two_team" }] };
    var them = other[0];
    if (!wr.getTeamById(me) || !wr.getTeamById(them)) return { ok: false, problems: [{ code: "team_not_in_war_room" }] };
    S.activeFranchiseId = me; S.leftTeamId = me; S.rightTeamId = them;
    S.selections = {}; S.extensions = {}; S.tradeSalaryK = {};
    wr.ensureSelectionMaps(me); wr.ensureSelectionMaps(them);
    (draft.items || []).forEach(function (i) {
      var from = pad4(i.from), to = pad4(i.to), a = assetByToken(wr, from, i.token);
      if (!((from === me && to === them) || (from === them && to === me))) { problems.push({ code: "bad_direction", token: i.token }); return; }
      if (!a) { problems.push({ code: "asset_not_in_war_room", token: i.token, from: from }); return; }
      S.selections[from][a.asset_id] = true;
      var ek = (draft.ext || {})[from + "|" + i.token];
      if (ek) {
        var has = (a.extension_options || []).some(function (o) { return str(o.option_key) === str(ek); });
        if (!has) { problems.push({ code: "extension_not_offered", token: i.token }); return; }
        S.extensions[from][a.asset_id] = { enabled: true, option_key: ek };
      }
    });
    [[me, them], [them, me]].forEach(function (p) {
      var k = Math.floor(Number((draft.capK || {})[p[0] + ">" + p[1]]) || 0);
      if (k <= 0) return;
      var max = wr.getTradeSalaryMaxK(p[0]);
      if (k > max) problems.push({ code: "cap_money_over_war_room_max", from: p[0], asked_k: k, max_k: max });
      S.tradeSalaryK[p[0]] = String(k);
    });
    if (problems.length) return { ok: false, problems: problems };
    var payload = wr.buildTradePayload();
    if (opts.generatedAt) payload.generated_at = opts.generatedAt;   // the clock is an input (tests pin it)
    var sent = payload.teams[0].selected_assets.length + payload.teams[1].selected_assets.length;
    if (sent !== (draft.items || []).length) return { ok: false, problems: [{ code: "asset_not_tradeable" }] };
    if (!payload.validation || payload.validation.status !== "ready") return { ok: false, problems: [{ code: "not_ready", issues: (payload.validation || {}).issues || [] }] };
    var np = noteProblem("direct", note); if (np) return { ok: false, problems: [np] };
    // ---- copied from trade_workbench.js submitOfferToQueue (the body it posts to /trade-offers) ----
    var leftTeam = wr.getTeamById(S.leftTeamId), rightTeam = wr.getTeamById(S.rightTeamId), activeFranchiseId = wr.getActiveFranchiseId();
    var userMessage = wr.safeStr(note).slice(0, 2000);
    var extensionLines = wr.buildExtensionSummaryLines(payload);
    var finalMessage = wr.composeTradeMessage(userMessage, extensionLines);
    payload.comment = finalMessage;
    var body = {
      league_id: wr.safeStr(S.data.meta.league_id),
      season: S.data.meta.season || null,
      from_franchise_id: wr.safeStr(activeFranchiseId || S.leftTeamId),
      to_franchise_id: wr.safeStr(S.rightTeamId),
      from_franchise_name: leftTeam.franchise_name,
      to_franchise_name: rightTeam.franchise_name,
      message: finalMessage,
      comment: finalMessage,
      payload: payload,
      source: "trade-workbench-ui",
      direct_mfl: true,
      submit_mode: "mfl"
    };
    return { ok: true, body: body, payload: payload, message: finalMessage, extensionLines: extensionLines };
  }
  // ---- copied from trade_workbench.js submitViaStagingFallback (the staged body after a 409 staging_required) ----
  // `loaded_contract_drops` is the War Room's popup answer; the Front Office has no picker, so it is never set (R8 open).
  function stagedFromDirect(wr, directBody) {
    var payload = directBody.payload || {};
    var movements = wr.tw2sMovementsFromPayload(payload);
    return {
      from: { fid: directBody.from_franchise_id, name: directBody.from_franchise_name },
      to: { fid: pad4(directBody.to_franchise_id), name: directBody.to_franchise_name },
      movements: movements, extension_requests: payload.extension_requests || [],
      loaded_contract_drops: undefined, notes: directBody.message || directBody.comment || ""
    };
  }

  // ── Three-team: the draft → the War Room's three-team state (tw3) → its movements and its exact create body. ──
  function threeTeam(wr, draft, actingFid, note) {
    var me = pad4(actingFid), fids = (draft.teams || []).map(pad4);
    if (fids.length !== 3 || fids.indexOf(me) === -1) return { ok: false, problems: [{ code: "not_three_team" }] };
    var others = fids.filter(function (f) { return f !== me; });
    var tw3 = { aFid: me, bFid: others[0], cFid: others[1], give: {}, cap: {}, ext: {}, notes: String(note == null ? "" : note) };
    var problems = [];
    fids.forEach(function (f) { tw3.give[f] = {}; tw3.cap[f] = {}; tw3.ext[f] = {}; if (!wr.getTeamById(f)) problems.push({ code: "team_not_in_war_room", fid: f }); });
    if (problems.length) return { ok: false, problems: problems };
    (draft.items || []).forEach(function (i) {
      var from = pad4(i.from), a = assetByToken(wr, from, i.token);
      if (!a) { problems.push({ code: "asset_not_in_war_room", token: i.token, from: from }); return; }
      tw3.give[from][a.asset_id] = pad4(i.to);
      var ek = (draft.ext || {})[from + "|" + i.token];
      if (ek) tw3.ext[from][a.asset_id] = { enabled: true, option_key: ek };
    });
    wr.setTw3(tw3);
    Object.keys(draft.capK || {}).forEach(function (k) {
      var p = k.split(">"), ask = Math.floor(Number(draft.capK[k]) || 0);
      if (ask <= 0) return;
      var max = wr.tw3MovementMaxCapK(p[0], p[1]);
      if (ask > max) problems.push({ code: "cap_money_over_war_room_max", from: p[0], to: p[1], asked_k: ask, max_k: max });
      tw3.cap[pad4(p[0])][pad4(p[1])] = ask;
    });
    var np = noteProblem("three_team", note); if (np) problems.push(np);
    if (problems.length) return { ok: false, problems: problems };
    var mv = wr.tw3Movements(), ext = wr.tw3BuildExtensionRequests();
    var sent = mv.reduce(function (n, m) { return n + m.asset_tokens.length; }, 0);
    if (sent !== (draft.items || []).length) return { ok: false, problems: [{ code: "asset_not_tradeable" }] };
    var extAsked = Object.keys(draft.ext || {}).length;
    if (ext.length !== extAsked) return { ok: false, problems: [{ code: "extension_not_offered" }] };
    // ---- copied from trade_workbench.js tw3Submit (bodyObj) ----
    var ctx = wr.getLeagueContext();
    var body = {
      league_id: ctx.leagueId, season: ctx.season,
      initiator: { fid: wr.pad4(tw3.aFid), name: wr.tw3NameOf(tw3.aFid) },
      team_b: { fid: wr.pad4(tw3.bFid), name: wr.tw3NameOf(tw3.bFid) },
      team_c: { fid: wr.pad4(tw3.cFid), name: wr.tw3NameOf(tw3.cFid) },
      movements: mv.map(function (m) { return { from: m.from, to: m.to, asset_tokens: m.asset_tokens, cap_k: wr.safeInt(m.cap_k, 0), summary: m.summary }; }),
      extension_requests: ext,
      notes: tw3.notes || ""
    };
    return { ok: true, body: body, previewMovements: body.movements.map(function (m) { return { from: m.from, to: m.to, asset_tokens: m.asset_tokens, cap_k: m.cap_k }; }) };
  }

  // ── Offer actions (accept / decline / revoke + the accept preview and cap acknowledgment). ──
  // ---- copied from trade_workbench.js performOfferAction (body) and reviewBeforeAccept (PREVIEW / ACK_CAP bodies) ----
  function offerActionBody(wr, action, offer, actingFid, message, opts) {
    var S = wr.state, A = String(action).toUpperCase();
    S.activeFranchiseId = pad4(actingFid);
    var leagueId = str(S.data && S.data.meta ? S.data.meta.league_id : ""), season = str(S.data && S.data.meta ? S.data.meta.season : "");
    var tradeId = wr.getOfferTradeId(offer), fid = wr.getActiveFranchiseId();
    if (!leagueId || !season || !fid || !tradeId) return null;
    if (A === "PREVIEW") return { league_id: leagueId, season: season, trade_id: tradeId, action: "PREVIEW", acting_franchise_id: fid, offer_id: str(offer.id) };
    if (A === "ACK_CAP") return { league_id: leagueId, season: season, trade_id: tradeId, action: "ACK_CAP", acting_franchise_id: fid, offer_id: str(offer.id) };
    var actionPayload = wr.getOfferPayloadForWorkbench(offer, { keepOriginalOrientation: true }) || null;
    if (actionPayload && opts && opts.generatedAt) actionPayload.generated_at = opts.generatedAt;   // the clock is an input (tests pin it)
    var raw = str(offer.raw_comment || offer.comments || offer.comment || offer.message || offer.notes);
    var meta = offer && offer.twb_meta ? offer.twb_meta : null;
    if (!meta && raw) meta = wr.parseTradeMetaFromComment(raw);
    var explicit = [];
    if (A === "ACCEPT") {
      if (actionPayload && Array.isArray(actionPayload.extension_requests) && actionPayload.extension_requests.length) explicit = JSON.parse(JSON.stringify(actionPayload.extension_requests));
      else if (meta && Array.isArray(meta.ext) && meta.ext.length) explicit = JSON.parse(JSON.stringify(meta.ext));
    }
    return {
      league_id: leagueId, season: season, offer_id: str(offer.id), proposal_id: str(offer.proposal_id || offer.trade_id || offer.id),
      trade_id: tradeId, action: A,
      message: A === "REJECT" ? str(message).slice(0, DECLINE_NOTE_LIMIT) : "",
      acting_franchise_id: fid, payload: actionPayload,
      offer_comment: raw,
      offer_comments: str(offer.comments || offer.comment || offer.raw_comment || offer.message || offer.notes),
      offer_notes: str(offer.notes || offer.comment || offer.comments || offer.raw_comment || offer.message),
      offer_raw_comment: raw,
      offer_message: str(offer.message || offer.comment || offer.comments || offer.raw_comment || offer.notes),
      offer_twb_meta: meta, offer_extension_requests: explicit,
      offer_from_franchise_id: str(offer.from_franchise_id), offer_to_franchise_id: str(offer.to_franchise_id),
      offer_will_give_up: str(offer.will_give_up), offer_will_receive: str(offer.will_receive),
      direct_mfl: true
    };
  }
  // ---- copied from trade_workbench.js triggerAfterTradeRefresh (body) ----
  function afterTradeRefreshBody(wr, tradeId, actingFid) {
    var meta = (wr.state.data && wr.state.data.meta) || {};
    wr.state.activeFranchiseId = pad4(actingFid);
    return { league_id: str(meta.league_id), season: str(meta.season), trade_id: str(tradeId), acting_franchise_id: wr.getActiveFranchiseId(), dispatch_refresh_mym_json: true, reconcile_extensions: true };
  }
  // Staged two-team and three-team management: the War Room's bodies (doCancel2WayStaged / doAccept2WayStaged /
  // doRecheck2WayStaged; doCancel3Way / doRecheck3Way / doAckCap3Way). A staged "decline" is the War Room's cancel.
  function stagedActionBody(verb, id) {
    if (verb === "cancel" || verb === "decline") return { id: id, reason: "cancelled from the Trade War Room" };
    if (verb === "accept" || verb === "recheck") return { id: id };
    return null;   // select-drops is never sent from the Front Office (R8 open; Keith's 2026-10-01 hard-stop ruling)
  }
  function threeWayActionBody(verb, id, actingFid) {
    if (["cancel", "recheck", "ack-cap"].indexOf(verb) === -1) return null;
    var body = { id: id }; if (pad4(actingFid)) body.acting_franchise_id = pad4(actingFid); return body;
  }

  // ── Responses ──
  function parsed(res) {
    if (!res || res.networkError) return { network: true, status: 0, body: null };
    return { network: false, status: res.status, ok: !!res.ok && !(res.body && res.body.ok === false), body: res.body || null };
  }
  function code(p) { return str(p.body && (p.body.code || p.body.error_type)); }

  // Owner wording for every refusal a create/action can return (one table; the War Room's own text where it has one).
  var WORDS = {
    unauthenticated: "Sign in to MFL, then open the Front Office from MFL again.",
    session_expired: "Your MFL sign-in expired. Re-open this from MFL and try again.",
    identity_unavailable: "Couldn't verify your MFL sign-in right now. Nothing was sent. Try again in a moment.",
    forbidden: "MFL says your sign-in can't do that for this team.",
    not_commissioner: "Only the commissioner can act for another team.",
    lockout_on_or_unknown: "Acting for another team is off: commissioner lockout is on (or couldn't be read).",
    flag_off: "Sending from the Front Office is not available yet.",
    no_key: "This browser couldn't make a safe send key, so nothing was sent.",
    loaded_contract_limit_exceeded: "This trade would leave a team over the loaded-contract limit. Revise the offer, or make a separate roster move first.",
    cap_overage_ack_required: "This offer puts you over the salary cap. Confirm the amount to send it.",
    cap_ack_changed: "The over-the-cap amount changed while you were confirming. Nothing more was sent; review the trade and send again.",
    staging_required: "This offer goes through staged review.",
    request_in_progress: "This offer is still being sent. Wait a moment, then check your sent offers.",
    request_outcome_unknown: "We couldn't tell whether this offer was sent. Check your sent offers before trying again.",
    idempotency_key_reused: "This send key was already used for a different trade. Nothing was sent.",
    idempotency_unavailable: "Couldn't confirm it's safe to send right now. Nothing was sent. Try again in a moment.",
    invalid_idempotency_key: "The send key was not accepted. Nothing was sent.",
    trade_proposal_import_failed: "MFL refused the offer.",
    franchise_has_unresolved_drop_sequence: "One of these teams has another deal still being untangled by the commissioner.",
    offer_not_pending: "That offer isn't pending anymore (it may have been accepted, declined, cancelled or expired).",
    execution_unconfirmed: "We couldn't confirm whether MFL processed that accept, and it has NOT been sent again. Ask the commissioner to check it.",
    execution_in_progress: "That accept is still being processed. It has NOT been sent again.",
    unavailable: "Couldn't reach the trade server. Nothing was confirmed. Try again in a moment.",
    network: "The connection dropped before the server answered. The offer may or may not have been sent.",
    loaded_contract_drops_removed: "Conditional drops are no longer part of trades.",
    note_too_long: "The note is too long for this kind of offer.",
    not_ready: "This trade isn't ready to send.",
    asset_not_in_war_room: "An asset in this trade isn't in the trade server's current rosters. Reload and try again.",
    asset_not_tradeable: "An asset in this trade can't be traded under the War Room's rules.",
    extension_not_offered: "That pre-trade extension isn't offered for this player right now.",
    cap_money_over_war_room_max: "The cap money is above what the trade server allows for these players.",
    team_not_in_war_room: "A team in this trade isn't in the trade server's data. Reload and try again.",
    retry_check_unavailable: "Couldn't check whether your offer already reached MFL, so it was NOT sent again. Check your sent offers, then try again.",
    counter_unverified: "Your counter may have been sent, but we couldn't see it in your sent offers. The original offer is still open."
  };
  function words(c, fallback) { return WORDS[c] || str(fallback) || "Something went wrong. Nothing more was sent."; }

  // One create attempt's answer → a lifecycle state. Never "sent" unless the server said so.
  function classifyCreate(res, kind) {
    var p = parsed(res), c = code(p), b = p.body || {};
    if (p.network) return { state: "unconfirmed", code: "network", canRetry: true };
    if (p.ok) {
      if (kind === "three_team") return { state: "sent_three_team", id: str(b.id || (b.trade && b.trade.id)), replay: !!b.idempotent_replay };
      if (kind === "staged") return { state: "staged", id: str(b.id), replay: !!b.idempotent_replay };
      return { state: "sent", tradeId: str((b.mfl || {}).trade_id), replay: !!b.idempotent_replay };
    }
    if (p.status === 409 && c === "loaded_contract_limit_exceeded") return { state: "blocked_loaded", code: c, teams: b.teams || [], message: str(b.message || b.error) };
    if (p.status === 409 && c === "cap_overage_ack_required" && b.cap_ack_needed) return { state: "needs_cap_ack", code: c, need: b.cap_ack_needed, message: str(b.error || b.message) };
    if (p.status === 409 && c === "staging_required") return { state: "staging_required", code: c };
    if (p.status === 409 && c === "request_in_progress") return { state: "in_progress", code: c };
    if (p.status === 409 && c === "request_outcome_unknown") return { state: "unconfirmed", code: c, canRetry: true };
    if (p.status === 401) return { state: "signed_out", code: c || "unauthenticated" };
    if (p.status === 403) return { state: "forbidden", code: c || "forbidden", message: str(b.error || b.message) };
    if (p.status === 502 && (c === "trade_proposal_import_failed" || /mfl/i.test(str(b.error)))) return { state: "mfl_rejected", code: "trade_proposal_import_failed", message: str(b.reason || b.error) };
    if (p.status >= 500 && !c) return { state: "unconfirmed", code: "unavailable", canRetry: true };
    return { state: "refused", code: c || ("http_" + p.status), message: str(b.message || b.error) };
  }

  // Accept answer → the War Room's distinct outcomes (performOfferAction): never plain success for a partial or unknown.
  function classifyAccept(res) {
    var p = parsed(res), c = code(p), b = p.body || {};
    if (p.network) return { state: "accept_unconfirmed", code: "network" };
    if (p.ok) {
      if (b.needs_review || b.execution_state === "executed_needs_review") return { state: "executed_needs_review", tradeId: str(b.trade_id), message: str(b.message) };
      if (b.already && b.executed) return { state: "already_accepted", tradeId: str(b.trade_id) };
      return { state: "executed", tradeId: str(b.trade_id), result: b };
    }
    if (c === "execution_unconfirmed" || c === "execution_in_progress") return { state: "accept_unconfirmed", code: c, message: str(b.message || b.error) };
    if (c === "offer_not_pending") return { state: "not_pending", code: c };
    if (p.status === 401) return { state: "signed_out", code: c || "unauthenticated" };
    if (p.status === 403) return { state: "forbidden", code: c || "forbidden", message: str(b.error || b.message) };
    if (p.status === 502) return { state: "mfl_rejected", code: "trade_proposal_import_failed", message: str(b.reason || b.error) };
    return { state: "refused", code: c || ("http_" + p.status), message: str(b.message || b.error) };
  }
  function classifySimple(res, okState) {
    var p = parsed(res), c = code(p), b = p.body || {};
    if (p.network) return { state: "unconfirmed", code: "network" };
    if (p.ok) return { state: okState, body: b };
    if (c === "offer_not_pending") return { state: "not_pending", code: c };
    if (p.status === 401) return { state: "signed_out", code: c || "unauthenticated" };
    if (p.status === 403) return { state: "forbidden", code: c || "forbidden", message: str(b.error || b.message) };
    return { state: "refused", code: c || ("http_" + p.status), message: str(b.message || b.error) };
  }

  // ── Inbox: the War Room's own states (refreshBannerOffers): signed out ≠ failed ≠ empty. ──
  function inbox(wr, res) {
    var p = parsed(res);
    if (!p.network && p.ok && p.body && Array.isArray(p.body.outgoing) && Array.isArray(p.body.incoming)) {
      var sent = wr.normalizeOffersForBanner(p.body.outgoing), got = wr.normalizeOffersForBanner(p.body.incoming);
      return { kind: sent.length || got.length ? "ok" : "empty", sent: sent, received: got, scopedToProven: !!p.body.scoped_to_proven, franchiseId: str(p.body.franchise_id) };
    }
    var err = new Error(p.network ? "Failed to fetch" : ((p.body && (p.body.error || p.body.reason)) || "Couldn't load your trades"));
    err.status = p.status; err.data = p.body;
    if (!p.network && p.ok) err = new Error("Couldn't load your trades");   // a body without both lists is a bad answer, not an empty inbox
    return { kind: wr.offerFeedErrorIsSignedOut(err) ? "signed_out" : "error", message: wr.summarizeOfferFeedError(err), sent: [], received: [] };
  }
  function findOffer(list, id) { return (list || []).filter(function (o) { return str(o.id) === str(id) || str(o.trade_id) === str(id) || str(o.proposal_id) === str(id); })[0] || null; }

  // ── Deep links (the Front Office's own hash scheme, #fo=<section>): #fo=trades&offer=<kind>:<id> ──
  function offerLink(kind, id) { return "#fo=trades&offer=" + encodeURIComponent(kind + ":" + id); }
  function parseOfferLink(hash) {
    var m = /(?:^#|&)offer=([^&]+)/.exec(String(hash || ""));
    if (!m) return null;
    var v = decodeURIComponent(m[1]), k = v.split(":")[0], id = v.slice(k.length + 1);
    if (["mfl", "staged", "3way"].indexOf(k) === -1 || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
    return { kind: k, id: id };
  }

  // ── The client: the flows, each one owner action. env = { cfg, send, routes, me, lockout, warRoom } ──
  function client(env) {
    var on = enabled(env && env.cfg);
    function refuse(c, extra) { var o = { state: "refused", code: c, message: words(c) }; Object.keys(extra || {}).forEach(function (k) { o[k] = extra[k]; }); return Promise.resolve(o); }
    function gate(actingFid, url) {
      if (!on) return "flag_off";
      if (!hasSession(url)) return "unauthenticated";
      var a = acting(env.me, actingFid, env.lockout);
      if (!a.ok) return a.code;
      return "";
    }
    function post(url, body) { return env.send({ method: "POST", url: url, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
    function get(url) { return env.send({ method: "GET", url: url }); }
    function done(o, actingFid) { o.actingFid = pad4(actingFid); o.message = o.message || words(o.code); return o; }

    // Create with gates: one POST; a confirmed cap acknowledgment resends ONCE with the signature (same key).
    // A staging_required answer switches to the War Room's staged route (direct two-team only).
    function createWithGates(kind, url, body, ctx) {
      return post(url, body).then(function (res) {
        var r = classifyCreate(res, kind);
        if (r.state === "needs_cap_ack") {
          var confirm = ctx.confirmCapAck || function () { return Promise.resolve(false); };
          return Promise.resolve(confirm(r.need)).then(function (yes) {
            if (!yes) return { state: "not_sent", code: "cap_ack_declined", message: "Not sent." };
            var again = {}; Object.keys(body).forEach(function (k) { if (k !== "idempotency_key") again[k] = body[k]; });
            again.cap_ack = { signature: r.need.signature }; again.idempotency_key = body.idempotency_key;
            return post(url, again).then(function (res2) {
              var r2 = classifyCreate(res2, kind);
              if (r2.state === "needs_cap_ack") return { state: "not_sent", code: "cap_ack_changed" };   // no second loop
              if (r2.state === "staging_required" && kind === "direct") return staged(again, ctx);
              r2.lastBody = again; return r2;
            });
          });
        }
        if (r.state === "staging_required" && kind === "direct") return staged(body, ctx);
        r.lastBody = body; return r;
      });
    }
    // ---- the War Room's staging fallback: its pre-send compliance preview, then POST /api/trades/2way ----
    function staged(directBody, ctx) {
      var sb = stagedFromDirect(env.warRoom, directBody);
      if (!sb.movements.length) return Promise.resolve({ state: "refused", code: "not_ready" });
      if (String(sb.notes).length > NOTE_LIMITS.staged) return Promise.resolve({ state: "needs_shorter_note", code: "note_too_long", limit: NOTE_LIMITS.staged, length: String(sb.notes).length });
      var pv = { league_id: directBody.league_id, season: directBody.season, from_franchise_id: pad4(directBody.from_franchise_id), movements: sb.movements, extension_requests: directBody.payload.extension_requests || [] };
      return post(env.routes.preview(), pv).then(function (res) {
        var p = parsed(res), lc = p.ok && p.body && p.body.compliance && p.body.compliance.loaded_contracts;
        if (lc && lc.status === "blocked") return { state: "blocked_loaded", code: "loaded_contract_limit_exceeded", teams: lc.teams || [] };
        var keyed = withKey(sb, directBody.idempotency_key);
        return post(env.routes.staged(directBody.from_franchise_id), keyed).then(function (res2) { var r = classifyCreate(res2, "staged"); r.lastBody = keyed; r.stagedFrom = directBody; return r; });
      });
    }

    function sendTwoTeam(draft, actingFid, note, ctx) {
      ctx = ctx || {};
      var url = env.routes.create(), g = gate(actingFid, url);
      if (g) return refuse(g, { actingFid: pad4(actingFid) });
      var built = twoTeam(env.warRoom, draft, actingFid, note, ctx);
      if (!built.ok) return refuse(built.problems[0].code, { problems: built.problems, actingFid: pad4(actingFid) });
      var key = (ctx.newKey || newKey)(ctx.randomBytes);
      if (!key) return refuse("no_key");
      return createWithGates("direct", url, withKey(built.body, key), ctx).then(function (r) { return done(r, actingFid); });
    }
    function sendThreeTeam(draft, actingFid, note, ctx) {
      ctx = ctx || {};
      var url = env.routes.threeWay(""), g = gate(actingFid, url);
      if (g) return refuse(g, { actingFid: pad4(actingFid) });
      if (pad4(actingFid) !== pad4(env.me && env.me.sessionFid) && !(env.me && env.me.isCommish)) return refuse("not_commissioner");
      var built = threeTeam(env.warRoom, draft, actingFid, note);
      if (!built.ok) return refuse(built.problems[0].code, { problems: built.problems, actingFid: pad4(actingFid) });
      var key = (ctx.newKey || newKey)(ctx.randomBytes);
      if (!key) return refuse("no_key");
      var body = withKey(built.body, key);
      // The War Room's pre-send check (tw2sRunPreSendPreview): the initiator over the loaded-contract limit is a hard stop;
      // a PARTNER over it is shown and the owner may still send (the War Room's "Send anyway"; checked again at that partner's accept).
      var pv = { league_id: body.league_id, season: body.season, from_franchise_id: pad4(actingFid), movements: built.previewMovements, extension_requests: body.extension_requests };
      return post(env.routes.preview(), pv).then(function (res) {
        var p = parsed(res), lc = p.ok && p.body && p.body.compliance && p.body.compliance.loaded_contracts;
        var teams = lc && lc.status === "blocked" ? (lc.teams || []) : [];
        var mine = teams.some(function (t) { return pad4(t.franchise_id) === pad4(actingFid); });
        if (mine) return { state: "blocked_loaded", code: "loaded_contract_limit_exceeded", teams: teams };
        var go = teams.length ? Promise.resolve((ctx.confirmPartnerOverLoaded || function () { return false; })(teams)) : Promise.resolve(true);
        return go.then(function (yes) {
          if (!yes) return { state: "not_sent", code: "partner_over_loaded_declined", message: "Not sent." };
          return createWithGates("three_team", url, body, ctx);
        });
      }).then(function (r) { return done(r, actingFid); });
    }

    // Retry (ruling 5): look for the first attempt in the caller's sent offers BEFORE resending (same key, same body).
    function retry(last, actingFid, ctx) {
      ctx = ctx || {};
      var body = last && last.lastBody;
      if (!body) return refuse("retry_check_unavailable");
      var g = gate(actingFid, env.routes.create());
      if (g) return refuse(g);
      var kind = last.stagedFrom ? "staged" : body.initiator ? "three_team" : "direct";
      var look = kind === "three_team" ? get(env.routes.threeWay(actingFid, "&franchise_id=" + pad4(actingFid))) : kind === "staged" ? get(env.routes.staged(actingFid, "&franchise_id=" + pad4(actingFid))) : get(env.routes.offers(actingFid));
      return look.then(function (res) {
        var p = parsed(res), found = null;
        if (kind === "direct") {
          var ib = inbox(env.warRoom, res), fp = env.warRoom.retryOfferFingerprintFromBody(body);
          if ((ib.kind !== "ok" && ib.kind !== "empty") || !fp || fp.from !== pad4(actingFid)) return { state: "refused", code: "retry_check_unavailable" };
          found = ib.sent.filter(function (o) { return env.warRoom.retryOfferMatches(o, fp); })[0] || null;
          if (found) return { state: "already_sent", tradeId: env.warRoom.getOfferTradeId(found) };
          return createWithGates("direct", env.routes.create(), body, ctx);
        }
        var list = p.ok && p.body && (p.body.trades || p.body.three_way || p.body.list);
        if (!Array.isArray(list)) return { state: "refused", code: "retry_check_unavailable" };
        found = list.filter(function (t) { return str(t.idempotency_key) === str(body.idempotency_key) || sameMovements(t, body); })[0] || null;
        if (found) return { state: kind === "staged" ? "already_staged" : "already_sent_three_team", id: str(found.id) };
        return kind === "staged" ? post(env.routes.staged(actingFid), body).then(function (r2) { var c = classifyCreate(r2, "staged"); c.lastBody = body; c.stagedFrom = last.stagedFrom; return c; })
          : createWithGates("three_team", env.routes.threeWay(""), body, ctx);
      }, function () { return { state: "refused", code: "retry_check_unavailable" }; }).then(function (r) { return done(r, actingFid); });
    }
    function sameMovements(trade, body) {
      var sig = function (ms) { return (ms || []).map(function (m) { return pad4(m.from) + ">" + pad4(m.to) + ":" + (m.asset_tokens || m.tokens || []).slice().sort().join(",") + ":" + (Math.floor(Number(m.cap_k) || 0)); }).sort().join("|"); };
      var mine = sig(body.movements), theirs = sig(trade.movements);
      return !!mine && mine === theirs;
    }

    // Counter (ruling 4): propose the counter first, see it in the sent list, then decline the original. Never decline first.
    function counter(original, draft, actingFid, note, ctx) {
      ctx = ctx || {};
      var g = gate(actingFid, env.routes.create());
      if (g) return refuse(g);
      if (pad4(original && original.to_franchise_id) !== pad4(actingFid)) return refuse("forbidden");
      var partner = pad4(original.from_franchise_id), teams = (draft.teams || []).map(pad4);
      if (teams.length !== 2 || teams.indexOf(partner) === -1) return refuse("not_ready", { problems: [{ code: "counter_must_go_back_to_sender" }] });
      var origId = env.warRoom.getOfferTradeId(original);
      return sendTwoTeam(draft, actingFid, note, ctx).then(function (r) {
        if (r.state !== "sent") { r.counter = "not_sent"; r.originalOpen = true; r.originalTradeId = origId; return r; }
        return confirmThenDecline(original, r, actingFid);
      });
    }
    function confirmThenDecline(original, sentResult, actingFid) {
      var origId = env.warRoom.getOfferTradeId(original);
      return get(env.routes.offers(actingFid)).then(function (res) {
        var ib = inbox(env.warRoom, res), fp = env.warRoom.retryOfferFingerprintFromBody(sentResult.lastBody);
        var seen = (ib.kind === "ok") && ib.sent.some(function (o) { return (sentResult.tradeId && env.warRoom.getOfferTradeId(o) === sentResult.tradeId) || (fp && env.warRoom.retryOfferMatches(o, fp)); });
        if (!seen) return done({ state: "counter_unverified", code: "counter_unverified", counterTradeId: sentResult.tradeId, originalTradeId: origId, originalOpen: true, recovery: "check_again", lastBody: sentResult.lastBody }, actingFid);
        return declineOriginal(original, sentResult, actingFid);
      }, function () { return done({ state: "counter_unverified", code: "counter_unverified", counterTradeId: sentResult.tradeId, originalTradeId: origId, originalOpen: true, recovery: "check_again", lastBody: sentResult.lastBody }, actingFid); });
    }
    function declineOriginal(original, sentResult, actingFid) {
      var origId = env.warRoom.getOfferTradeId(original);
      var body = offerActionBody(env.warRoom, "REJECT", original, actingFid, COUNTER_DECLINE_NOTE);
      if (!body) return Promise.resolve(done({ state: "both_open", code: "refused", counterTradeId: sentResult.tradeId, originalTradeId: origId, recovery: "decline_original", lastBody: sentResult.lastBody }, actingFid));
      return post(env.routes.action(), body).then(function (res) {
        var r = classifySimple(res, "declined");
        if (r.state === "declined" || r.state === "not_pending") return done({ state: "countered", counterTradeId: sentResult.tradeId, originalTradeId: origId, originalAlreadyClosed: r.state === "not_pending", message: "Counter sent" + (sentResult.tradeId ? " (Trade ID " + sentResult.tradeId + ")" : "") + ". The original offer was declined." }, actingFid);
        return done({ state: "both_open", code: r.code, counterTradeId: sentResult.tradeId, originalTradeId: origId, recovery: "decline_original", lastBody: sentResult.lastBody,
          message: "Your counter was sent" + (sentResult.tradeId ? " (Trade ID " + sentResult.tradeId + ")" : "") + ", but the original offer is still open: declining it didn't go through." }, actingFid);
      });
    }

    // Accept: the War Room's preview first (read-only), the owner's own cap acknowledgment if needed, then the accept.
    function acceptPreview(offer, actingFid) {
      var g = gate(actingFid, env.routes.action()); if (g) return refuse(g);
      if (pad4(offer && offer.to_franchise_id) !== pad4(actingFid)) return refuse("forbidden");
      var body = offerActionBody(env.warRoom, "PREVIEW", offer, actingFid);
      if (!body) return refuse("not_ready");
      return post(env.routes.action(), body).then(function (res) { var T = root.UPS_TRADE_3WAY; return { state: "preview", review: T ? T.interpretPreview(res) : null, raw: res, actingFid: pad4(actingFid) }; });
    }
    function ackCap(offer, actingFid) {
      var g = gate(actingFid, env.routes.action()); if (g) return refuse(g);
      var body = offerActionBody(env.warRoom, "ACK_CAP", offer, actingFid);
      if (!body) return refuse("not_ready");
      return post(env.routes.action(), body).then(function (res) { var T = root.UPS_TRADE_3WAY; return { state: "ack", result: T ? T.interpretAckCap(res) : null, actingFid: pad4(actingFid) }; });
    }
    function accept(offer, actingFid, review) {
      var g = gate(actingFid, env.routes.action()); if (g) return refuse(g);
      if (!review || !review.canAccept) return refuse("not_ready", { problems: [{ code: "preview_not_clear" }] });   // no accept without a clear server preview
      var body = offerActionBody(env.warRoom, "ACCEPT", offer, actingFid);
      if (!body) return refuse("not_ready");
      // The War Room refuses an accept whose offer payload isn't structurally ready (performOfferAction).
      if (body.payload && typeof body.payload === "object" && env.warRoom.buildValidationSummary(body.payload).status !== "ready") return refuse("not_ready", { problems: [{ code: "offer_payload_not_ready" }] });
      return post(env.routes.action(), body).then(function (res) {
        var r = classifyAccept(res);
        if (r.result) r.summary = env.warRoom.summarizePostAcceptResult(r.result);
        return done(r, actingFid);
      });
    }
    function decline(offer, actingFid, note) {
      var g = gate(actingFid, env.routes.action()); if (g) return refuse(g);
      if (pad4(offer && offer.to_franchise_id) !== pad4(actingFid)) return refuse("forbidden");
      if (String(note || "").length > DECLINE_NOTE_LIMIT) return refuse("note_too_long", { limit: DECLINE_NOTE_LIMIT });
      var body = offerActionBody(env.warRoom, "REJECT", offer, actingFid, note);
      if (!body) return refuse("not_ready");
      return post(env.routes.action(), body).then(function (res) { return done(classifySimple(res, "declined"), actingFid); });
    }
    function revoke(offer, actingFid) {
      var g = gate(actingFid, env.routes.action()); if (g) return refuse(g);
      if (pad4(offer && offer.from_franchise_id) !== pad4(actingFid)) return refuse("forbidden");   // only the sender may revoke
      var body = offerActionBody(env.warRoom, "REVOKE", offer, actingFid);
      if (!body) return refuse("not_ready");
      return post(env.routes.action(), body).then(function (res) { return done(classifySimple(res, "revoked"), actingFid); });
    }
    function stagedAction(verb, id, actingFid) {
      var g = gate(actingFid, env.routes.stagedAct(actingFid, verb)); if (g) return refuse(g);
      var body = stagedActionBody(verb, id); if (!body) return refuse("loaded_contract_drops_removed");
      var path = verb === "decline" ? "cancel" : verb;
      return post(env.routes.stagedAct(actingFid, path), body).then(function (res) { return done(classifySimple(res, verb === "decline" ? "declined" : verb === "cancel" ? "cancelled" : verb === "accept" ? "accepted_staged" : "rechecked"), actingFid); });
    }
    function threeWayAction(verb, id, actingFid) {
      var g = gate(actingFid, env.routes.threeWayAct(actingFid, verb)); if (g) return refuse(g);
      var body = threeWayActionBody(verb, id, actingFid); if (!body) return refuse("loaded_contract_drops_removed");
      return post(env.routes.threeWayAct(actingFid, verb), body).then(function (res) {
        var T = root.UPS_TRADE_3WAY, out = T ? (verb === "cancel" ? T.interpretCancel(res) : verb === "recheck" ? T.interpretRecheck(res) : T.interpretAckCap(res)) : null;
        var ok = verb === "cancel" ? !!(out && out.applied) : !!(out && out.ok);
        return done({ state: ok ? (verb === "cancel" ? "cancelled" : verb === "recheck" ? "rechecked" : "acknowledged") : "refused", code: ok ? "" : str(out && (out.code || out.kind)), result: out, message: str(out && out.message) }, actingFid);
      });
    }
    // After any outcome that moved players: the War Room's after-trade refresh, then the page re-reads (caller).
    function afterTrade(tradeId, actingFid) {
      if (!on) return refuse("flag_off");
      return post(env.routes.refresh(), afterTradeRefreshBody(env.warRoom, tradeId, actingFid)).then(function (res) { return { state: parsed(res).ok ? "refreshed" : "refresh_failed" }; });
    }
    // Reads (inbox, staged and three-team lists) — only when the flag is on, like everything else here.
    function readInbox(actingFid) {
      if (!on) return Promise.resolve({ kind: "off", sent: [], received: [] });
      var url = env.routes.offers(actingFid);
      if (!hasSession(url)) return Promise.resolve({ kind: "signed_out", message: "Sign in to view trades", sent: [], received: [] });
      var a = acting(env.me, actingFid, env.lockout);
      if (!a.ok) return Promise.resolve({ kind: "refused", code: a.code, message: words(a.code), sent: [], received: [] });
      return get(url).then(function (res) { return inbox(env.warRoom, res); }, function () { return inbox(env.warRoom, { networkError: true }); });
    }
    function readList(which, actingFid) {
      if (!on) return Promise.resolve({ kind: "off", trades: [] });
      var url = which === "staged" ? env.routes.staged(actingFid, "&franchise_id=" + pad4(actingFid)) : env.routes.threeWay(actingFid, "&franchise_id=" + pad4(actingFid));
      if (!hasSession(url)) return Promise.resolve({ kind: "signed_out", trades: [] });
      return get(url).then(function (res) {
        var p = parsed(res), list = p.ok && p.body && (p.body.trades || p.body.three_way || p.body.list);
        return Array.isArray(list) ? { kind: list.length ? "ok" : "empty", trades: list } : { kind: p.status === 401 || p.status === 403 ? "signed_out" : "error", trades: [] };
      }, function () { return { kind: "error", trades: [] }; });
    }

    return { enabled: on, sendTwoTeam: sendTwoTeam, sendThreeTeam: sendThreeTeam, retry: retry, counter: counter, declineOriginal: declineOriginal, confirmThenDecline: confirmThenDecline,
      acceptPreview: acceptPreview, ackCap: ackCap, accept: accept, decline: decline, revoke: revoke, stagedAction: stagedAction, threeWayAction: threeWayAction,
      afterTrade: afterTrade, readInbox: readInbox, readList: readList };
  }

  var api = { FLAG: FLAG, NOTE_LIMITS: NOTE_LIMITS, DECLINE_NOTE_LIMIT: DECLINE_NOTE_LIMIT, COUNTER_DECLINE_NOTE: COUNTER_DECLINE_NOTE, enabled: enabled, newKey: newKey, withKey: withKey,
    routes: routes, hasSession: hasSession, warRoom: warRoom, acting: acting, noteLimit: noteLimit, noteProblem: noteProblem,
    twoTeam: twoTeam, stagedFromDirect: stagedFromDirect, threeTeam: threeTeam, offerActionBody: offerActionBody, afterTradeRefreshBody: afterTradeRefreshBody,
    stagedActionBody: stagedActionBody, threeWayActionBody: threeWayActionBody, classifyCreate: classifyCreate, classifyAccept: classifyAccept,
    inbox: inbox, findOffer: findOffer, offerLink: offerLink, parseOfferLink: parseOfferLink, words: words, WORDS: WORDS, client: client };
  root.UPS_TRADE_OFFER_LIFECYCLE = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : this);
