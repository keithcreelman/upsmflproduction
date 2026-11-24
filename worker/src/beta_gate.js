// beta_gate.js — the "beta gate": every mobile-beta request passes here BEFORE any route runs (issue #1475, Stage 1).
//
// A request is a BETA request if it carries the marker header `X-UPS-Client: beta/<build>` OR a beta session id (`Authorization: Bearer ups_bs_…`).
// Two independent classifiers, each a client claim that can only NARROW what is allowed: the gate never grants anything because a request
// claims to be (or not to be) the beta. Authority comes only from the server-side session row, the invitation and the flags.
//
// A request with NEITHER the marker nor a beta credential is the original app (or any other caller) and is left exactly as it is today:
// `kind: "original"`, no D1 read, no change. That is what makes "disabling the beta cannot affect the original app" checkable.
//
// For a beta request the gate decides, in order, and every refusal happens BEFORE any MFL call or D1 write and FAILS CLOSED:
//   1. /admin/* (any spelling) → beta_route_not_allowed        2. a raw MFL session / API key in the query, a Cookie or the body → ambiguous_credentials
//   3. no session id: public reads (GET) pass as anonymous; anything else → session_required      4. malformed session id → session_invalid
//   5. flags unreadable → beta_unavailable; master off → beta_paused     6. no live session row → session_invalid / session_expired
//   7. the league must be the session's league, in an environment the worker knows      8. the franchise must still be invited → not_invited
//   9. route allowlist (GET to an unlisted route passes WITHOUT the session; anything else → beta_route_not_allowed); the flow switch → flow_off
//  10. a franchise named in the query or body must be the session's franchise      11. open the stored MFL session (a wrong or missing key → refuse)
// Only then is the MFL session handed to the route (`kind: "inject"`), and only for allowlisted routes.
import { classifyAdminRequest } from "./admin_front_door.js";
import { looksLikeSessionId, sha256Hex, openMflSession, environmentForLeague, padFid } from "./beta_session.js";

export const BETA_MASTER = "BETA_ENABLED";
export const MAX_BODY_SCAN = 256 * 1024;

// Owner-scoped routes the beta may use, and the flow switch each belongs to. EXACT paths only: a variant (trailing slash, case, alias such
// as /trade-offers) is not listed, so it never receives a session. Deliberately absent: /api/settings (original-app bootstrap), /api/pick
// (caller proof not settled), /api/bug-reports (not on main yet), /api/lineup-matchups and /api/trades/compliance-preview (reader unconfirmed),
// trade outbox/reconcile/refresh (automation), and everything under /admin/.
export const BETA_ROUTES = [
  { re: /^\/api\/me$/, methods: ["GET"], flow: null },
  { re: /^\/api\/lineup$/, methods: ["GET"], flow: "BETA_FLOW_LINEUP" },
  { re: /^\/api\/submit-lineup$/, methods: ["POST"], flow: "BETA_FLOW_LINEUP" },
  { re: /^\/api\/submit-trade-bait$/, methods: ["POST"], flow: "BETA_FLOW_TRADES" },
  { re: /^\/api\/trades\/proposals$/, methods: ["GET", "POST"], flow: "BETA_FLOW_TRADES" },
  { re: /^\/api\/trades\/proposals\/action$/, methods: ["POST"], flow: "BETA_FLOW_TRADES" },
  { re: /^\/api\/trades\/(2way|3way)(\/[a-z0-9-]+)*$/, methods: ["GET", "POST"], flow: "BETA_FLOW_TRADES" },
  { re: /^\/api\/waivers\/(state|availability|pending)$/, methods: ["GET"], flow: "BETA_FLOW_WAIVERS" },
  { re: /^\/api\/waivers\/(bbid-plan|fcfs)$/, methods: ["POST"], flow: "BETA_FLOW_WAIVERS" },
  { re: /^\/api\/auction\/(bid|nominate)$/, methods: ["POST"], flow: "BETA_FLOW_AUCTION" },
  { re: /^\/roster-workbench\/action$/, methods: ["POST"], flow: "BETA_FLOW_ROSTER" },
  { re: /^\/(commish-contract-update|offer-mym|offer-restructure)$/, methods: ["POST"], flow: "BETA_FLOW_CONTRACTS" },
];
export function matchBetaRoute(method, path) {
  const m = String(method || "").toUpperCase();
  for (const r of BETA_ROUTES) if (r.methods.includes(m) && r.re.test(path)) return r;
  return null;
}
// /api/beta/* is the session lifecycle. A beta page may only redeem a code and sign out; handoff and status belong to the original app.
const BETA_LIFECYCLE_FROM_BETA = new Set(["/api/beta/session", "/api/beta/signout"]);

const REFUSALS = {
  beta_paused:            [503, "The beta is paused. Use the original app."],
  flow_off:               [503, "That part of the beta is switched off. Use the original app."],
  beta_unavailable:       [503, "The beta couldn't check its settings just now. Try again, or use the original app."],
  key_unavailable:        [503, "The beta can't open your session right now. Use the original app."],
  not_invited:            [403, "This beta is by invitation."],
  session_required:       [401, "Open the beta from the original app."],
  session_invalid:        [401, "Your beta session isn't valid. Open the beta again from the original app."],
  session_expired:        [401, "Your beta session expired. Open the beta again from the original app."],
  ambiguous_credentials:  [400, "A beta request can't carry an MFL session or key."],
  beta_route_not_allowed: [403, "The beta can't do that. Use the original app."],
  league_not_allowed:     [403, "That league isn't available in this beta."],
  franchise_mismatch:     [403, "You can only act as your own team."],
};
const refuse = (code) => ({ kind: "refuse", code, status: REFUSALS[code][0], message: REFUSALS[code][1] });
export function betaRefusalResponse(r, corsHeaders) {
  return new Response(JSON.stringify({ ok: false, code: r.code, error: r.message, message: r.message }), {
    status: r.status,
    headers: { "content-type": "application/json", "Cache-Control": "no-store", ...(corsHeaders || {}) },
  });
}

function safeStr(v) { return String(v == null ? "" : v).trim(); }

/** Pure classification of a request's claims. Nothing here is proof of anything. */
export function classifyBeta(request, url) {
  const marker = safeStr(request.headers.get("x-ups-client"));
  const auth = safeStr(request.headers.get("authorization"));
  const bearer = /^bearer\s+(\S+)$/i.exec(auth);
  const token = bearer ? bearer[1] : "";
  const betaShapedToken = /^ups_b[sh]_/i.test(token);           // anything that tries to be a beta credential is judged as one
  const markerIsBeta = /^beta\b/i.test(marker);
  const cookie = request.headers.get("cookie") || "";
  const q = url.searchParams;
  const rawSession = {
    query: ["MFL_USER_ID", "mfl_user_id", "APIKEY", "apikey", "COMMISH_API_KEY"].some((k) => q.has(k)),
    cookie: /(?:^|;\s*)MFL_USER_ID\s*=/i.test(cookie),
  };
  return { isBeta: markerIsBeta || betaShapedToken, markerIsBeta, token, betaShapedToken, rawSession };
}

const FRANCHISE_FIELDS = ["franchise_id", "FRANCHISE_ID", "franchiseId", "fid", "from_franchise_id", "fromFranchiseId", "acting_franchise_id", "requested_by"];
const RAW_BODY_FIELDS = ["mfl_user_id", "MFL_USER_ID", "APIKEY", "apikey", "commish_api_key", "COMMISH_API_KEY"];

async function readJsonBody(request) {
  const ct = request.headers.get("content-type") || "";
  if (!/json/i.test(ct)) return null;
  const len = Number(request.headers.get("content-length") || 0);
  if (len > MAX_BODY_SCAN) return { tooLarge: true };
  try {
    const text = await request.clone().text();
    if (text.length > MAX_BODY_SCAN) return { tooLarge: true };
    const j = JSON.parse(text);
    return j && typeof j === "object" ? j : null;
  } catch (_) { return null; }
}

/**
 * @param a.request, a.env, a.now (ms)
 * @param a.deps  { getFlags(names) → { ok, flags }, store, keyring }
 * @returns { kind: "original" } | { kind: "route" } | { kind: "pass" } | { kind: "inject", ctx } | { kind: "refuse", code, status, message }
 */
export async function betaGate(a) {
  const request = a.request, env = a.env, now = a.now, deps = a.deps;
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const path = url.pathname;
  const c = classifyBeta(request, url);

  // Not a beta request: the original app and every other caller are untouched. No flag read, no D1.
  if (!c.isBeta) return { kind: "original" };

  // 1. never the admin namespace, in any spelling
  if (classifyAdminRequest(path, method) !== "not_admin") return refuse("beta_route_not_allowed");
  // 2. a beta request never carries a raw MFL session or key
  if (c.rawSession.query || c.rawSession.cookie) return refuse("ambiguous_credentials");

  // The session lifecycle: a beta page may redeem a code or sign out; the route handler does its own checks. Handoff/status are original-app only.
  if (path.startsWith("/api/beta/")) {
    if (!BETA_LIFECYCLE_FROM_BETA.has(path)) return refuse("beta_route_not_allowed");
    // A beta sign-out is authenticated by its own session id (or by nothing: it is idempotent). It never carries a raw MFL session, so a
    // beta-classified sign-out that does is a MIXED request and is refused here, before the handler. (Round-1 MAT-1: the handler used to
    // fall back to proving that raw body session and revoking the whole franchise.) The handler ALSO refuses that branch for any
    // beta-classified request, so neither layer alone can be bypassed.
    if (path === "/api/beta/signout" && method === "POST") {
      const body = await readJsonBody(request);
      if (body && body.tooLarge) return refuse("beta_route_not_allowed");
      if (body) for (const k of RAW_BODY_FIELDS) if (body[k] != null && String(body[k]) !== "") return refuse("ambiguous_credentials");
    }
    return { kind: "route" };
  }

  const route = matchBetaRoute(method, path);

  // 3. no session id
  if (!c.token) {
    if (method === "GET" || method === "HEAD") return { kind: "pass" };        // public reads: the same data an anonymous original-app request gets
    return refuse("session_required");
  }
  // 4. a credential that is not a well-formed beta session id (including a handoff code used as a session id)
  if (!looksLikeSessionId(c.token)) return refuse("session_invalid");

  // 5. kill switches: one flag read; unreadable = refuse
  const names = route && route.flow ? [BETA_MASTER, route.flow] : [BETA_MASTER];
  let f;
  try { f = await deps.getFlags(names); } catch (_) { return refuse("beta_unavailable"); }
  if (!f || !f.ok) return refuse("beta_unavailable");
  if (!f.flags[BETA_MASTER]) return refuse("beta_paused");

  // 6. the session row (one indexed lookup + one invitation lookup). Enforcement is HERE, on every request; cleanup is not involved.
  let row;
  try { row = await deps.store.lookup(await sha256Hex(c.token)); } catch (_) { return refuse("beta_unavailable"); }
  if (!row || row.revoked_at != null) return refuse("session_invalid");
  if (Number(row.live_until) <= now) return refuse("session_expired");

  // 7. the league must be the session's, and an environment this worker knows
  const requestLeague = safeStr(url.searchParams.get("L")) || "74598";
  const envName = environmentForLeague(env, requestLeague);
  if (!envName || requestLeague !== String(row.league_id) || envName !== row.environment) return refuse("league_not_allowed");

  // 8. still invited (checked on every request, so un-inviting takes effect at once)
  if (!Number(row.invited)) return refuse("not_invited");

  // 9. route allowlist and flow switch. An unlisted GET passes as an anonymous request: the session is NOT handed over.
  if (!route) return (method === "GET" || method === "HEAD") ? { kind: "pass" } : refuse("beta_route_not_allowed");
  if (route.flow && !f.flags[route.flow]) return refuse("flow_off");

  // 10. any franchise named in the query or body must be the session's franchise (the existing per-route checks still run after this)
  const sessionFid = padFid(row.franchise_id);
  for (const k of FRANCHISE_FIELDS) { const v = url.searchParams.get(k); if (v && padFid(v) !== sessionFid) return refuse("franchise_mismatch"); }
  if (method === "POST") {
    const body = await readJsonBody(request);
    if (body && body.tooLarge) return refuse("beta_route_not_allowed");
    if (body) {
      for (const k of RAW_BODY_FIELDS) if (body[k] != null && String(body[k]) !== "") return refuse("ambiguous_credentials");
      for (const k of FRANCHISE_FIELDS) { const v = body[k]; if (v != null && String(v) !== "" && padFid(v) !== sessionFid) return refuse("franchise_mismatch"); }
    }
  }

  // 11. open the stored MFL session. A missing or wrong key, or a tampered or moved ciphertext, refuses; it never falls back to anything.
  let mflSession;
  try { mflSession = await openMflSession(typeof deps.keyring === "function" ? deps.keyring() : deps.keyring, row); }
  catch (e) { return refuse(String(e && e.message) === "key_unavailable" ? "key_unavailable" : "session_invalid"); }
  if (!mflSession) return refuse("session_invalid");

  return { kind: "inject", ctx: { mflSession, franchiseId: sessionFid, leagueId: String(row.league_id), environment: row.environment, rowId: row.row_id, flow: route.flow } };
}
