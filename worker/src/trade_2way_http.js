// trade_2way_http.js — owner-facing HTTP surface for STAGED 2-way ("two-team") trades.
//
//   GET  /api/trades/2way?id=<uuid>                       canonical detail (any status; participants + commissioner view)
//   GET  /api/trades/2way[?franchise_id=][&include=all]   the viewer's inbox/outbox (canonical objects)
//   POST /api/trades/2way                                 create (sender must be the proven viewer) — STAGES in D1, never proposes to MFL
//   POST /api/trades/2way/accept                           { id }  the recipient accepts — records consent, then re-checks BOTH sides before releasing to execution
//   POST /api/trades/2way/cancel                            { id }  either party (or the commissioner) cancels
//   POST /api/trades/2way/recheck                           { id }  re-check a trade both sides accepted but a gate is holding
//   POST /api/trades/2way/select-drops                      { id, player_ids:[...] }  select (and confirm) the CALLER's own conditional loaded-contract drops on this trade (never writes to MFL, never drops a player, never itself unblocks execution)
//   GET  /api/trades/2way/queue                             COMMISSIONER-only, read-only review queue: every active/failed staged trade league-wide, with fresh compliance, cap-ack state, ledger state and age. No execute/drop action exists on this route or anywhere behind it (Keith's ruling, 2026-09-29: "hold and inspect... do not add a drop or trade execution button yet").
//
// This is entirely ADDITIVE and, on its own, changes NOTHING about existing behavior:
// worker/src/index.js's existing /trade-offers (direct-to-MFL) route is completely
// untouched by this file. Nothing calls these routes unless a client is explicitly pointed
// at them, and creation itself refuses unless TRADE_2WAY_STAGING_ENABLED="1" (default off).
//
// Identity: the SAME trade_authz.js caller model the 3-way and existing 2-way routes use — a
// proven MFL session, or the admin key. A franchise id in a body/query is only an "acting as"
// REQUEST honoured for a proven commissioner.

import {
  createStaged2WayTrade, get2WayTrade, list2WayForFranchise, cancel2WayTrade,
  accept2WayTrade, recheck2WayExecution, select2WayLoadedContractDrops, listCommish2WayQueue,
} from "./trade_2way.js";
import { padFid } from "./trade_3way_model.js";
import { resolveTradeCaller, callerFailureBody, isAdminCaller } from "./trade_authz.js";

function safeStr(v) { return String(v == null ? "" : v).trim(); }

const CREATE_MESSAGES = {
  "2way_staging_disabled": "Staged 2-way trades aren't turned on right now.",
  no_db: "Trades are temporarily unavailable. Try again in a moment.",
  missing_fields: "A trade needs a league, a season and two teams.",
  teams_must_be_distinct: "A trade needs two different teams.",
  no_movements: "Pick at least one asset to move.",
  bad_movement: "Every asset has to go between the two teams.",
  no_assets: "Pick at least one player or pick to move.",
  not_in_allowlist: "Staged 2-way trades aren't open to all of those teams yet.",
};

// The route family this module owns — exact matches only (the global L-guard exempts exactly these).
export const TWO_WAY_STAGED_ROUTES = ["/api/trades/2way", "/api/trades/2way/accept", "/api/trades/2way/cancel", "/api/trades/2way/recheck", "/api/trades/2way/select-drops", "/api/trades/2way/queue"];

export async function handle2WayStagedHttp(a) {
  const { request, url, path, env, ctx, deps, corsHeaders } = a;

  // ── COMMISSIONER QUEUE (read-only) — its own identity rule, checked first and separately: ──
  // isAdminCaller (the admin key OR a PROVEN commissioner session), never the owner-scoped
  // "acting as" rule the rest of this file uses. No id, no franchise scoping — league-wide.
  if (path === "/api/trades/2way/queue" && request.method === "GET") {
    const out = (status, payload) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", ...(corsHeaders || {}) } });
    const r = await resolveTradeCaller({
      url, body: null, env, deps,
      defaultLeagueId: a.defaultLeagueId, defaultSeason: a.defaultSeason,
      queryToken: a.browserMflUserId, cookieToken: a.cookieMflUserId, allowCookieToken: true,
    });
    if (!r.ok) return out(r.http, callerFailureBody(r));
    if (!isAdminCaller(r.caller)) return out(403, { ok: false, code: "forbidden", error: "Commissioner only.", message: "Commissioner only." });
    const includeAll = ["all", "1", "true"].includes(safeStr(url.searchParams.get("includeAll")).toLowerCase());
    const q = await listCommish2WayQueue(env, r.caller.leagueId, r.caller.season, { includeAll, deps: { franchiseNames: deps.franchiseNames, playersByIds: deps.playersByIds } });
    if (!q.ok) return out(q.http || 503, { ok: false, code: q.code || "unavailable", error: q.message || "Couldn't load the queue.", message: q.message || "Couldn't load the queue." });
    return out(200, { ok: true, league_id: q.league_id, season: q.season, trades: q.trades });
  }

  const isBase = path === "/api/trades/2way";
  const isAccept = path === "/api/trades/2way/accept";
  const isCancel = path === "/api/trades/2way/cancel";
  const isRecheck = path === "/api/trades/2way/recheck";
  const isSelectDrops = path === "/api/trades/2way/select-drops";
  if (!isBase && !isAccept && !isCancel && !isRecheck && !isSelectDrops) return null;
  const method = request.method;
  if (!((isBase && (method === "GET" || method === "POST")) || ((isAccept || isCancel || isRecheck || isSelectDrops) && method === "POST"))) return null;

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
  const declared = padFid(url.searchParams.get("acting_franchise_id") || (body && (body.acting_franchise_id || body.franchise_id)) || "");
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
      const g = await get2WayTrade(env, id, viewer, enrichDeps);
      if (!g.ok) return fail(g.http, g.code, g.message);
      return out(200, { ok: true, trade: g.trade });
    }
    const fid = padFid(url.searchParams.get("franchise_id") || "") || viewer.fid;
    if (!fid) return fail(400, "bad_request", "Missing franchise.");
    if (fid !== viewer.fid && !viewer.isCommish) return fail(403, "forbidden", "You can only see your own team's trades.");
    const all = ["all", "1", "true"].includes(safeStr(url.searchParams.get("include")).toLowerCase());
    const l = await list2WayForFranchise(env, leagueId, fid, { season, includeAll: all, deps: enrichDeps });
    if (!l.ok) return fail(l.http, l.code, l.message);
    return out(200, { ok: true, trades: l.trades });
  }

  // ── POST accept ────────────────────────────────────────────────────────────
  // Only the recipient (viewer.fid === the trade's to_fid, proven server-side, never a body
  // claim) can accept. Records consent unconditionally, then re-checks BOTH sides' loaded-
  // contract/cap/lineup compliance before ever releasing this trade toward execution — this
  // is the "recheck at each acceptance" step (docs/LOADED_CONTRACT_DROP_EXECUTION_DESIGN.md
  // §8.2 step 4), reusing the exact same compliance calculation the create-time gate and the
  // execute-time gate both use, never a separate or looser check.
  if (isAccept) {
    const x = await accept2WayTrade(env, ctx, body.id, viewer, body);
    if (x.ok) return out(200, { ok: true, accepted: !!x.accepted, executing: !!x.executing, held: !!x.held, kind: x.kind, message: x.message, compliance: x.compliance || null, id: safeStr(body.id) });
    return fail(x.http || 409, x.code || "accept_failed", x.message || "Couldn't accept this trade.", x.compliance ? { compliance: x.compliance } : undefined);
  }

  // ── POST recheck ───────────────────────────────────────────────────────────
  if (isRecheck) {
    const x = await recheck2WayExecution(env, ctx, body.id, viewer);
    if (x.ok) return out(200, { ok: true, rechecking: !!x.rechecking, id: safeStr(body.id) });
    return fail(x.http || 409, x.code || "recheck_failed", x.message || "Couldn't re-check.", x.compliance ? { compliance: x.compliance } : undefined);
  }

  // ── POST select-drops ──────────────────────────────────────────────────────
  if (isSelectDrops) {
    const x = await select2WayLoadedContractDrops(env, body.id, viewer, body.player_ids);
    if (x.ok) return out(200, { ok: true, code: x.code, message: x.message, id: safeStr(body.id), drop_requirement: x.drop_requirement || null, compliance: x.compliance || null, executable: !!x.executable });
    return fail(x.http || 409, x.code || "select_failed", x.message || "Couldn't record that selection.", x.compliance ? { compliance: x.compliance } : undefined);
  }

  // ── POST cancel ────────────────────────────────────────────────────────────
  if (isCancel) {
    const x = await cancel2WayTrade(env, ctx, body.id, viewer, body.reason);
    if (x.ok) return out(200, { ok: true, id: safeStr(body.id) });
    return fail(x.http || 409, x.code || "cancel_failed", x.message || "Couldn't cancel this trade.");
  }

  // ── POST create ────────────────────────────────────────────────────────────
  // STAGES in D1 only — see createStaged2WayTrade's own header for the guarantee that no
  // fetch() to myfantasyleague.com happens anywhere in its call graph.
  const fromFid = padFid(body.from && body.from.fid);
  if (fromFid !== viewer.fid) return fail(403, "forbidden", "You can only start a trade as your own team.");
  if (Array.isArray(body.extension_requests) && body.extension_requests.length && typeof deps.validateExtensions === "function") {
    const v = await deps.validateExtensions({ leagueId, season, extensionRequests: body.extension_requests });
    if (!v.ok) return out(v.http || 409, { ok: false, code: v.code, error: v.message, message: v.message, skipped: v.skipped });
  }
  const created = await createStaged2WayTrade(env, ctx, {
    leagueId, season,
    from: body.from, to: body.to,
    movements: body.movements, notes: body.notes, extension_requests: body.extension_requests,
    loaded_contract_drops: body.loaded_contract_drops,
  });
  if (created.ok) return out(201, { ok: true, id: created.id, staged: true });
  const known = CREATE_MESSAGES[created.error];
  const message = created.code === "TRADE_CAP_MONEY_50PCT" ? safeStr(created.error) : (known || "Couldn't create this trade.");
  const errKey = safeStr(created.error);
  const code = safeStr(created.code) || (CREATE_MESSAGES[errKey] ? errKey : "create_failed");
  return fail(400, code, message);
}
