// trade_3way_http.js — owner-facing HTTP surface for 3-way trades.
//
//   GET  /api/trades/3way?id=<uuid>                       canonical detail (any status; participants + commissioner view)
//   GET  /api/trades/3way[?franchise_id=][&include=all]   the viewer's outbox (canonical objects)
//   POST /api/trades/3way                                 create (initiator must be the proven viewer)
//   POST /api/trades/3way/cancel                          { id }  cancel (initiator only — see trade_3way_model.decideCancel)
//   POST /api/trades/3way/recheck                         { id }  re-check a trade that both partners accepted but the salary cap is holding
//   POST /api/trades/3way/ack-cap                          { id }  acknowledge the CALLER's own currently-projected cap overage on this trade (never writes to MFL, never itself re-checks)
//   POST /api/trades/3way/select-drops                      { id, player_ids:[...] }  select (and confirm) the CALLER's own conditional loaded-contract drops on this trade (never writes to MFL, never drops a player, never itself re-checks)
//
// Identity comes from trade_authz.js (the SAME caller model the two-team routes use): a proven
// MFL session, or the admin key. A franchise id in a body/query is only an "acting as"
// REQUEST honoured for a proven commissioner. The league is the request's `L` (else the
// worker's configured league) and MUST agree with any league_id in the body; every trade is
// scoped to that (league, season).

import { create3WayTrade, get3WayTrade, list3WayForFranchise, cancel3WayTrade, recheck3WayExecution, ack3WayCapOverage, select3WayLoadedContractDrops, movementsForCompliance, conditionalDropStoreFor } from "./trade_3way.js";
import { loadedContractsPermitsWrite } from "./trade_cap_authority.js";
import { padFid } from "./trade_3way_model.js";
import { resolveTradeCaller, callerFailureBody } from "./trade_authz.js";

function safeStr(v) { return String(v == null ? "" : v).trim(); }

const CREATE_MESSAGES = {
  "3way_disabled": "3-way trades aren't turned on right now.",
  no_db: "Trades are temporarily unavailable. Try again in a moment.",
  missing_fields: "A 3-way needs a league, a season and three teams.",
  teams_must_be_distinct: "A 3-way needs three different teams.",
  no_movements: "Pick at least one asset to move.",
  bad_movement: "Every asset has to go between two of the three teams.",
  no_assets: "Pick at least one player or pick to move.",
  not_in_allowlist: "3-way trades aren't open to all of those teams yet.",
};

export function legacyAliases(trade) {
  // Aliases for clients cached before the canonical shape shipped (the mobile service
  // worker is cache-first). Safe to drop once every client has reloaded.
  const [a, b, c] = trade.participants;
  return {
    ...trade,
    role: trade.viewer ? (trade.viewer.role === "initiator" ? "initiator" : "partner") : "partner",
    initiator_name: a ? a.name : "", team_b_name: b ? b.name : "", team_c_name: c ? c.name : "",
    team_b_state: b ? b.state : "", team_c_state: c ? c.state : "",
    waiting_on: (trade.state_view.waiting_on || []).map((fid) => (trade.participants.find((p) => p.fid === fid) || {}).name || fid),
    can_cancel: !!trade.permissions.can_cancel,
    created_at_utc: trade.timestamps.created_at_utc,
    movements: trade.movements.map((m) => ({ ...m, from_name: m.from.name, to_name: m.to.name })),
  };
}

// The route family this module owns — exact matches only (the global L-guard exempts exactly these).
export const THREE_WAY_ROUTES = ["/api/trades/3way", "/api/trades/3way/cancel", "/api/trades/3way/recheck", "/api/trades/3way/ack-cap", "/api/trades/3way/select-drops"];

export async function handle3WayHttp(a) {
  const { request, url, path, env, ctx, deps, corsHeaders } = a;
  const isBase = path === "/api/trades/3way";
  const isCancel = path === "/api/trades/3way/cancel";
  const isRecheck = path === "/api/trades/3way/recheck";
  const isAckCap = path === "/api/trades/3way/ack-cap";
  const isSelectDrops = path === "/api/trades/3way/select-drops";
  if (!isBase && !isCancel && !isRecheck && !isAckCap && !isSelectDrops) return null;
  const method = request.method;
  if (!((isBase && (method === "GET" || method === "POST")) || ((isCancel || isRecheck || isAckCap || isSelectDrops) && method === "POST"))) return null;

  const out = (status, payload) => new Response(JSON.stringify(payload), {
    status, headers: { "content-type": "application/json", ...(corsHeaders || {}) },
  });
  const fail = (http, code, message, extra) => out(http, { ok: false, code, error: message, message, ...(extra || {}) });

  let body = null;
  if (method === "POST") {
    try { body = await request.json(); } catch (_) { return fail(400, "bad_request", "That request wasn't valid JSON."); }
    if (!body || typeof body !== "object") return fail(400, "bad_request", "That request wasn't valid JSON.");
  }

  // ── identity (fail closed) ─────────────────────────────────────────────────
  // A franchise id in the request is only a CLAIM of who to act as. For cancel the legacy
  // body `franchise_id` is treated exactly like `acting_franchise_id`.
  const declared = padFid(url.searchParams.get("acting_franchise_id") || (body && (body.acting_franchise_id || (isCancel ? body.franchise_id : ""))) || "");
  const r = await resolveTradeCaller({
    url, body, env, deps, declaredFid: declared,
    defaultLeagueId: a.defaultLeagueId, defaultSeason: a.defaultSeason,
    queryToken: a.browserMflUserId, cookieToken: a.cookieMflUserId, allowCookieToken: true,
  });
  if (!r.ok) return out(r.http, callerFailureBody(r));
  const c = r.caller;
  const viewer = { fid: c.fid, sessionFid: c.sessionFid, isCommish: c.isCommish, via: c.via === "apikey" ? "apikey" : "session", leagueId: c.leagueId, season: c.season };
  const leagueId = c.leagueId, season = c.season;
  const enrichDeps = { franchiseNames: deps.franchiseNames, playersByIds: deps.playersByIds };

  // ── GET ────────────────────────────────────────────────────────────────────
  if (isBase && method === "GET") {
    const id = safeStr(url.searchParams.get("id"));
    if (id) {
      // (the single-trade detail also carries the live cap/roster picture; lists don't — one lookup per trade is enough)
      const g = await get3WayTrade(env, id, viewer, { ...enrichDeps, compliance: deps.compliance });
      if (!g.ok) return fail(g.http, g.code, g.message);
      return out(200, { ok: true, trade: legacyAliases(g.trade) });
    }
    const fid = padFid(url.searchParams.get("franchise_id") || "") || viewer.fid;
    if (!fid) return fail(400, "bad_request", "Missing franchise.");
    if (fid !== viewer.fid && !viewer.isCommish) return fail(403, "forbidden", "You can only see your own team's trades.");
    const all = ["all", "1", "true"].includes(safeStr(url.searchParams.get("include")).toLowerCase());
    const l = await list3WayForFranchise(env, leagueId, fid, { viewer: { ...viewer, fid }, season, includeTerminal: all, deps: enrichDeps });
    if (!l.ok) return fail(l.http, l.code, l.message);
    const trades = l.trades.map(legacyAliases);
    return out(200, { ok: true, three_way: trades, trades });
  }

  // ── POST recheck ───────────────────────────────────────────────────────────
  // Recomputes the salary cap from scratch for a trade both partners already accepted. Never records consent, never changes what was accepted.
  if (isRecheck) {
    const x = await recheck3WayExecution(env, ctx, body.id, viewer);
    if (x.ok) return out(200, { ok: true, code: x.code, message: x.message, id: safeStr(body.id) });
    return fail(x.http || 409, x.code || "recheck_failed", x.message || "Couldn't re-check.", x.compliance ? { compliance: x.compliance } : undefined);
  }

  // ── POST ack-cap ───────────────────────────────────────────────────────────
  // Explicit acknowledgment of the CALLER's own currently-projected cap overage (Keith's
  // ruling, 2026-09-28, separate PR: "a proven post-trade salary-cap overage should be
  // displayed and explicitly acknowledged, but should not itself block the trade"). Never
  // writes to MFL, never itself flips the trade out of collecting/blocked_cap -- follow with
  // recheck once acknowledged. `viewer.fid` is the caller's own proven identity, never a body
  // claim, so this can only acknowledge for the caller's own franchise.
  if (isAckCap) {
    const x = await ack3WayCapOverage(env, body.id, viewer);
    if (x.ok) return out(200, { ok: true, code: x.code, message: x.message, id: safeStr(body.id), cap_ack: x.cap_ack || null });
    return fail(x.http || 409, x.code || "ack_failed", x.message || "Couldn't record that acknowledgment.", x.compliance ? { compliance: x.compliance } : undefined);
  }

  // ── POST select-drops ──────────────────────────────────────────────────────
  // Select (and, by submitting, confirm) the CALLER's own conditional loaded-contract drops
  // (Keith's ruling, 2026-09-29: "for a three-way trade, handle each affected franchise
  // separately"). Never writes to MFL, drops no player, never itself flips the trade out of
  // collecting/blocked_cap -- follow with recheck once every affected franchise has selected.
  // `viewer.fid` is the caller's own proven identity, never a body claim, so this can only
  // select for the caller's own franchise.
  if (isSelectDrops) {
    const x = await select3WayLoadedContractDrops(env, body.id, viewer, body.player_ids);
    if (x.ok) return out(200, { ok: true, code: x.code, message: x.message, id: safeStr(body.id), drop_requirement: x.drop_requirement || null, compliance: x.compliance || null });
    return fail(x.http || 409, x.code || "select_failed", x.message || "Couldn't record that selection.", x.compliance ? { compliance: x.compliance } : undefined);
  }

  // ── POST cancel ────────────────────────────────────────────────────────────
  if (isCancel) {
    const x = await cancel3WayTrade(env, ctx, body.id, viewer, enrichDeps);
    if (x.trade) x.trade = legacyAliases(x.trade);
    if (x.ok) return out(200, { ok: true, code: x.code, already: !!x.already, id: x.trade ? x.trade.id : safeStr(body.id), trade: x.trade });
    return fail(x.http, x.code, x.message, x.trade ? { trade: x.trade } : undefined);
  }

  // ── POST create ────────────────────────────────────────────────────────────
  const initiatorFid = padFid(body.initiator && body.initiator.fid);
  if (initiatorFid !== viewer.fid) return fail(403, "forbidden", "You can only start a 3-way as your own team.");
  // STORED-OFFER CREATION uses the canonical extension price: a 3-way that promises an extension the worker cannot price, or prices differently
  // from what the request carries, is refused before anything is stored (the answer carries the canonical terms so it can be rebuilt).
  if (Array.isArray(body.extension_requests) && body.extension_requests.length && typeof deps.validateExtensions === "function") {
    const v = await deps.validateExtensions({ leagueId, season, extensionRequests: body.extension_requests });
    if (!v.ok) return out(v.http || 409, { ok: false, code: v.code, error: v.message, message: v.message, skipped: v.skipped });
  }
  // LOADED-CONTRACT CONDITIONAL DROPS (Keith's ruling, 2026-09-29 -- the same gap and the same
  // fix as the 2-way creation path in index.js: building/reviewing an offer as the initiator
  // never showed this at all, since PR #1135's check only ever ran at accept-time compliance).
  // Checked here, before create3WayTrade, for the INITIATOR's own requirement only -- exactly
  // the 2-way division of responsibility: each OTHER participant's own requirement is THEIR own
  // concern, surfaced when they view/accept the trade (capGate() hard-blocks execution either
  // way, so a participant with an unsatisfied requirement can never be silently skipped -- this
  // is only about giving the BUILDER a server round-trip to warn the initiator before Send
  // 3-Way, mirroring the 2-way creation gate). `body.loaded_contract_drops` (optional array of
  // player ids) is the initiator's proposed selection for their OWN franchise; validated fresh
  // against live data in THIS SAME request. An unresolvable calculation does NOT gate creation
  // (same reasoning as cap/2-way: an unrelated data problem must not block proposing a trade) --
  // the fail-closed guarantee still lives at capGate()/execution, unchanged. A `deps` without a
  // `compliance` function (a lighter test double, or any future caller that only needs the
  // identity/routing surface) skips this block entirely rather than throwing -- the same
  // "no compliance -> don't gate" treatment as an unavailable calculation, matching
  // get3WayTrade's own deps.compliance guard.
  let pendingDropPersist = null;
  if ((Array.isArray(body.movements) || Array.isArray(body.legs)) && typeof deps.compliance === "function") {
    const createDropSelections = Array.isArray(body.loaded_contract_drops) ? body.loaded_contract_drops.map(safeStr).filter(Boolean) : [];
    const createDropMovements = movementsForCompliance(Array.isArray(body.movements) ? body.movements : body.legs);
    const createDropCompliance = await deps.compliance({
      leagueId, season, movements: createDropMovements,
      extensionRequests: Array.isArray(body.extension_requests) ? body.extension_requests : [],
      conditionalDrops: { [initiatorFid]: createDropSelections },
    });
    if (createDropCompliance.loaded_contracts && createDropCompliance.loaded_contracts.status !== "unavailable") {
      const myDropReq = (createDropCompliance.loaded_contracts.drop_requirements || []).find((d) => safeStr(d.franchise_id) === initiatorFid);
      if (myDropReq && !myDropReq.satisfied) {
        return fail(409, "loaded_contract_drops_required",
          `${myDropReq.franchise_name} would move from ${myDropReq.loaded_before} to ${myDropReq.projected} loaded contracts. The maximum is 5, so ${myDropReq.required_drops} conditional drop${myDropReq.required_drops === 1 ? "" : "s"} of your own loaded-contract player${myDropReq.required_drops === 1 ? "" : "s"} ${myDropReq.required_drops === 1 ? "is" : "are"} required before this 3-way can be sent.`,
          { compliance: createDropCompliance, loaded_contract_drops_needed: { franchise_id: initiatorFid, loaded_before: myDropReq.loaded_before, projected: myDropReq.projected, required_drops: myDropReq.required_drops, selected: myDropReq.selected, valid_count: myDropReq.valid_count } });
      }
      // Creation itself is safe to allow through even when SATISFIED -- unlike 2-way, a 3-way
      // trade is 100% held server-side (D1 only, never proposed to MFL) until BOTH partners
      // accept AND capGate() passes, and capGate() ALREADY refuses EXECUTE for "needs_drops"
      // (loadedContractsPermitsWrite(), Keith's ruling 2026-09-29) -- so there is nothing here
      // for a native-MFL accept to bypass. Still, the initiator deserves an honest heads-up
      // rather than silence, since this 3-way can never actually execute until an executor
      // exists, no matter how everyone accepts.
      if (myDropReq && myDropReq.satisfied && !loadedContractsPermitsWrite(createDropCompliance.loaded_contracts.status)) {
        console.warn(`[3way] create: ${initiatorFid}'s selection satisfies its own requirement, but conditional-drop execution isn't built yet -- this 3-way will be created and can be accepted, but capGate() will hold it at execution.`);
      }
    }
    pendingDropPersist = (createDropCompliance.loaded_contracts && createDropCompliance.loaded_contracts.status !== "unavailable" && createDropSelections.length) ? createDropSelections : null;
  }
  const created = await create3WayTrade(env, ctx, {
    leagueId, season,
    initiator: body.initiator, teamB: body.team_b, teamC: body.team_c,
    movements: body.movements, legs: body.legs, notes: body.notes, extension_requests: body.extension_requests,
  });
  // A 3-way trade gets its stable `id` only once create3WayTrade inserts the row -- the
  // conditional-drop store keys on that id (worker/src/trade_3way.js's conditionalDropKey),
  // unlike 2-way's pre-computed payload-hash key, so the initiator's validated selection (above)
  // can only be persisted AFTER creation succeeds. Best-effort: create3WayTrade already committed
  // the row and DMed the partners by this point (the same "don't undo a real create over a
  // secondary write" precedent as its own DM-failure handling below it), so a persist failure
  // here doesn't refuse the trade -- it just means the initiator's pick didn't save and they'll
  // see the requirement again (via /select-drops) the next time the trade is viewed or rechecked.
  if (created.ok && pendingDropPersist) {
    try {
      await conditionalDropStoreFor(env).setForFranchise(
        { leagueId, season, tradeKey: created.id, tradeKind: "three_way" },
        { franchiseId: initiatorFid, playerIds: pendingDropPersist, selectedByFid: initiatorFid }
      );
    } catch (e) {
      console.error(`[3way] ${created.id}: couldn't persist the initiator's conditional-drop selection at creation (recoverable via /select-drops): ${e?.message || e}`);
    }
  }
  if (created.ok) return out(201, { ok: true, id: created.id });
  const known = CREATE_MESSAGES[created.error];
  // create3WayTrade's catch-all returns the raw exception text — never show that to an owner.
  const message = created.code === "TRADE_CAP_MONEY_50PCT" ? safeStr(created.error) : (known || "Couldn't create the 3-way trade.");
  // Only KNOWN machine codes are surfaced; an unexpected failure's raw text stays in the logs.
  const errKey = safeStr(created.error);
  const code = safeStr(created.code) || (CREATE_MESSAGES[errKey] ? errKey : "create_failed");
  return fail(400, code, message);
}
