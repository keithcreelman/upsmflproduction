// beta_routes.js — the beta session lifecycle routes (issue #1475, Stage 1).
//
//   POST /api/beta/status    original app: { mfl_user_id } → { enabled, invited }                 (booleans only)
//   POST /api/beta/handoff   original app: { mfl_user_id } → { code }  (single use, 60 s; the MFL session is stored encrypted, never returned)
//   POST /api/beta/session   beta page:    { code, environment }  → { session_id }  (shown ONCE; only its hash is stored)
//   POST /api/beta/signout   beta page (Bearer session id) or original app ({ mfl_user_id }): ends sessions and wipes the stored MFL session
//   POST /admin/beta/invites           commissioner/admin only (the /admin front door runs first): invite or un-invite a franchise
//   POST /admin/beta/purge-sessions    commissioner/admin only: wipe every stored MFL session
//
// Nothing here ever returns the MFL session or echoes a credential. Every response is `Cache-Control: no-store`. Every failure is a stable code.
import { BETA_MASTER, betaRefusalResponse } from "./beta_gate.js";
import {
  environmentForLeague, looksLikeHandoffCode, looksLikeSessionId, newHandoffCode, newRowId, newSessionId, padFid, parseKeyring, sealMflSession, sha256Hex,
} from "./beta_session.js";

function safeStr(v) { return String(v == null ? "" : v).trim(); }
const json = (status, body, cors) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "Cache-Control": "no-store", ...(cors || {}) } });
const refusal = (code, status, message, cors) => json(status, { ok: false, code, error: message, message }, cors);

async function readBody(request) {
  try { const j = await request.json(); return j && typeof j === "object" ? j : {}; } catch (_) { return {}; }
}

/** Prove an MFL session with the worker's existing proof (MFL's league lookup). Returns { fid } or { res } (a refusal to send). */
async function proveOwner(a, token) {
  if (!token) return { res: refusal("session_required", 401, "Open the beta from the original app.", a.corsHeaders) };
  let det;
  try { det = await a.detectFranchise(token, a.season); } catch (e) { det = { error: String((e && e.message) || e) }; }
  if (!det || !det.franchise_id) {
    const err = safeStr(det && det.error);
    if (/not a member/i.test(err)) return { res: refusal("not_invited", 403, "That MFL login isn't in this league.", a.corsHeaders) };
    if (/HTTP 4\d\d/.test(err)) return { res: refusal("session_expired", 401, "Your MFL sign-in expired. Re-open this from MFL.", a.corsHeaders) };
    return { res: refusal("identity_unavailable", 503, "Couldn't verify your MFL sign-in right now. Try again in a moment.", a.corsHeaders) };
  }
  return { fid: padFid(det.franchise_id) };
}

/**
 * @param a { request, url, env, corsHeaders, now, store, getFlags, detectFranchise(token, season), leagueId, season }
 * @returns Response, or null when the path is not a lifecycle route.
 */
export async function handleBetaRoute(a) {
  const path = a.url.pathname;
  if (!path.startsWith("/api/beta/")) return null;
  if (a.request.method !== "POST") return refusal("beta_route_not_allowed", 405, "POST only.", a.corsHeaders);
  const cors = a.corsHeaders;

  // ── sign-out works even while the beta is paused: ending a session is always allowed ──
  if (path === "/api/beta/signout") {
    const auth = /^bearer\s+(\S+)$/i.exec(safeStr(a.request.headers.get("authorization")));
    try {
      if (auth && looksLikeSessionId(auth[1])) { await a.store.signout(await sha256Hex(auth[1]), a.now); return json(200, { ok: true }, cors); }
      const body = await readBody(a.request);
      if (safeStr(body.mfl_user_id)) {
        const env = environmentForLeague(a.env, a.leagueId);
        if (!env) return refusal("league_not_allowed", 403, "That league isn't available in this beta.", cors);
        const who = await proveOwner(a, safeStr(body.mfl_user_id));
        if (who.res) return who.res;
        await a.store.revokeFranchise(who.fid, a.leagueId, env, "signout_original_app", a.now);
        return json(200, { ok: true }, cors);
      }
    } catch (_) { return refusal("beta_unavailable", 503, "Couldn't end the session just now. Try again.", cors); }
    return json(200, { ok: true }, cors);          // an unknown or missing credential: the same answer, so there is no oracle
  }

  // ── everything else needs the master switch on, read from D1 each time and failing closed ──
  let flags;
  try { flags = await a.getFlags([BETA_MASTER]); } catch (_) { flags = null; }
  if (!flags || !flags.ok) return betaRefusalResponse({ code: "beta_unavailable", status: 503, message: "The beta couldn't check its settings just now. Try again, or use the original app." }, cors);
  if (!flags.flags[BETA_MASTER]) {
    if (path === "/api/beta/status") return json(200, { ok: true, enabled: false, invited: false }, cors);     // no MFL call, no table read
    return betaRefusalResponse({ code: "beta_paused", status: 503, message: "The beta is paused. Use the original app." }, cors);
  }

  if (path === "/api/beta/session") {
    const body = await readBody(a.request);
    const code = safeStr(body.code), environment = safeStr(body.environment);
    const invalid = () => refusal("code_invalid", 400, "That sign-in link has expired or was already used. Tap Beta in the original app again.", cors);
    if (!looksLikeHandoffCode(code) || !["test", "live"].includes(environment)) return invalid();
    const sid = newSessionId();                       // generated BEFORE the guarded statement; discarded if the statement changes no row
    try {
      const r = await a.store.redeem({ codeHash: await sha256Hex(code), environment, sidHash: await sha256Hex(sid), now: a.now });
      if (!r.redeemed) return invalid();             // used, expired, unknown, wrong environment, or un-invited: all the same answer
      return json(200, { ok: true, session_id: sid, expires_at: r.expiresAt, environment }, cors);
    } catch (_) { return refusal("beta_unavailable", 503, "Couldn't finish signing in. Tap Beta in the original app again.", cors); }
  }

  if (path === "/api/beta/status" || path === "/api/beta/handoff") {
    const body = await readBody(a.request);
    const environment = environmentForLeague(a.env, a.leagueId);
    if (!environment) return refusal("league_not_allowed", 403, "That league isn't available in this beta.", cors);
    const token = safeStr(body.mfl_user_id);
    const who = await proveOwner(a, token);
    if (who.res) return who.res;

    if (path === "/api/beta/status") {
      try { return json(200, { ok: true, enabled: true, invited: await a.store.isInvited(who.fid, a.leagueId, environment) }, cors); }
      catch (_) { return refusal("beta_unavailable", 503, "Couldn't check the beta just now.", cors); }
    }

    // handoff: no key → nothing is created (fail closed)
    const keyring = parseKeyring(a.env);
    if (!keyring) return betaRefusalResponse({ code: "key_unavailable", status: 503, message: "The beta can't open your session right now. Use the original app." }, cors);
    try {
      const rowId = newRowId(), code = newHandoffCode();
      const sealed = await sealMflSession(keyring, { rowId, franchiseId: who.fid, leagueId: a.leagueId, environment }, token);
      const r = await a.store.createHandoff({ rowId, franchiseId: who.fid, leagueId: a.leagueId, environment, codeHash: await sha256Hex(code), mflEnc: sealed.mflEnc, keyId: sealed.keyId, now: a.now });
      if (!r.inserted) return refusal("not_invited", 403, "This beta is by invitation.", cors);
      try { await a.store.sweep(a.now); } catch (_) { /* deletion maintenance only; never blocks a handoff */ }
      return json(200, { ok: true, code, expires_in: 60, environment }, cors);
    } catch (_) { return refusal("beta_unavailable", 503, "Couldn't start the beta just now. Try again.", cors); }
  }

  return refusal("beta_route_not_allowed", 404, "Not found.", cors);
}

/** Commissioner/admin routes. The /admin front door has already required a real credential; the beta gate refuses beta requests before here. */
export async function handleBetaAdminRoute(a) {
  const path = a.url.pathname;
  if (path !== "/admin/beta/invites" && path !== "/admin/beta/purge-sessions") return null;
  const cors = a.corsHeaders;
  if (a.request.method !== "POST") return refusal("beta_route_not_allowed", 405, "POST only.", cors);
  const body = await readBody(a.request);
  try {
    if (path === "/admin/beta/purge-sessions") return json(200, { ok: true, purged: await a.store.purgeAll(a.now) }, cors);
    const fid = padFid(body.franchise_id), league = safeStr(body.league_id || a.leagueId), environment = environmentForLeague(a.env, league);
    if (!fid || !environment) return refusal("bad_request", 400, "franchise_id and a known league_id are required.", cors);
    if (safeStr(body.action) === "uninvite") return json(200, { ok: true, ...(await a.store.uninvite(fid, league, environment, a.now)) }, cors);
    if (safeStr(body.action) === "invite") { await a.store.invite(fid, league, environment, safeStr(body.note).slice(0, 80), a.now); return json(200, { ok: true }, cors); }
    return refusal("bad_request", 400, "action must be invite or uninvite.", cors);
  } catch (_) { return refusal("beta_unavailable", 503, "Couldn't change the beta just now.", cors); }
}
