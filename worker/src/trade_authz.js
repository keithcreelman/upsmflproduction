// trade_authz.js — ONE authenticated-caller model for every owner-facing trade route
// (two-team and three-team). Pure: identity lookups are injected, so the same code is
// exercised by tests against the real handlers.
//
// Two SEPARATE authorities, never merged into a fallback chain:
//
//   owner  — an MFL session (MFL_USER_ID) proven against MFL `myleagues`. The proven
//            franchise is the ONLY identity; a franchise id in a body/query is an
//            "acting as" REQUEST, honoured solely when the proven session is the
//            commissioner (MFL itself lets a commissioner session pass FRANCHISE_ID).
//   admin  — the worker's COMMISH_API_KEY (APIKEY), for automation and explicit
//            administrative routes. It carries no franchise of its own.
//
// There is deliberately NO path from "no credentials" to the worker's commissioner
// cookie: an ordinary owner request that lacks proof is refused (401), never quietly
// upgraded (Keith 2026-05-28: "trades are always owner-to-owner; the commissioner
// cookie is never an acceptable substitute for an owner's session").

function safeStr(v) { return String(v == null ? "" : v).trim(); }
export function padFid(v) { const s = safeStr(v).replace(/\D/g, ""); return s ? s.padStart(4, "0").slice(-4) : ""; }

export const isValidLeagueId = (v) => /^\d{3,8}$/.test(safeStr(v));
export const isValidSeason = (v) => /^\d{4}$/.test(safeStr(v));

export function safeEqual(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

const fail = (http, code, message) => ({ ok: false, http, code, message });

/**
 * @param a.url            URL of the request
 * @param a.body           parsed JSON body (or null)
 * @param a.env            worker env (COMMISH_API_KEY)
 * @param a.deps           { detectFranchise(token) -> {franchise_id}|{error}, commishFids() -> [fid] }
 * @param a.defaultLeagueId / a.defaultSeason   used when the request names none
 * @param a.declaredFid    a franchise id the request CLAIMS to act for (body/query). Never proof.
 * @param a.queryToken     MFL_USER_ID query param (the token every client forwards)
 * @param a.cookieToken    MFL_USER_ID from a Cookie header (only used when a.allowCookieToken)
 * @param a.allowAdminKey  default true
 * @returns { ok:true, caller } | { ok:false, http, code, message }
 *   caller = { kind:'owner'|'admin', via:'session'|'apikey', sessionFid, fid, isCommish,
 *              actingAs, token, leagueId, season }
 */
export async function resolveTradeCaller(a) {
  const url = a.url, body = a.body && typeof a.body === "object" ? a.body : null;
  const leagueId = safeStr(url.searchParams.get("L")) || safeStr(a.defaultLeagueId);
  if (!isValidLeagueId(leagueId)) return fail(400, "bad_request", "That request named an invalid league.");
  const bodyLeague = safeStr(body && body.league_id);
  if (bodyLeague && bodyLeague !== leagueId) return fail(400, "league_mismatch", "That request named two different leagues.");
  const season = safeStr(url.searchParams.get("YEAR") || url.searchParams.get("season") || (body && body.season)) || safeStr(a.defaultSeason);
  if (!isValidSeason(season)) return fail(400, "bad_request", "That request named an invalid season.");
  const declared = padFid(a.declaredFid);

  // ── explicit administrative authority ─────────────────────────────────────
  // The owner token is read FIRST because a supplied APIKEY that fails to
  // match COMMISH_API_KEY is not, by itself, ever an error -- the MFL embed
  // forwards its OWN page APIKEY on every request alongside the owner's real
  // MFL_USER_ID, and that unrelated key must never be treated as a bad admin
  // attempt when a proven owner session is sitting right next to it
  // (2026-09-28: this exact collision produced a false "That administrative
  // key isn't valid." for every owner using the Trade War Room from inside
  // MFL). An APIKEY only ever means something when it EXACTLY matches
  // COMMISH_API_KEY; otherwise it is simply not present as far as authority
  // is concerned, and the request falls through to normal owner verification
  // below.
  const apiKey = safeStr(url.searchParams.get("APIKEY"));
  const token = safeStr(a.queryToken) || (a.allowCookieToken ? safeStr(a.cookieToken) : "");
  if (apiKey && a.allowAdminKey !== false) {
    const expected = safeStr(a.env && a.env.COMMISH_API_KEY);
    if (expected && safeEqual(apiKey, expected)) {
      // explicit, valid worker authority always wins, even alongside an owner session
      return { ok: true, caller: { kind: "admin", via: "apikey", sessionFid: "", fid: declared, isCommish: true, actingAs: !!declared, token: "", leagueId, season } };
    }
    // Invalid/foreign key: only an error when there is no owner session to
    // fall back to. With one, ignore the key entirely and authenticate the
    // owner normally (never upgraded to admin, never silently accepted as
    // an admin attempt).
    if (!token) return fail(403, "forbidden", "That administrative key isn't valid.");
  }

  // ── owner authority: a PROVEN MFL session ─────────────────────────────────
  if (!token) return fail(401, "unauthenticated", "Sign in to MFL to do that.");
  let det;
  try { det = await a.deps.detectFranchise(token, leagueId); } catch (e) { det = { error: String((e && e.message) || e) }; }
  if (!det || !det.franchise_id) {
    const err = safeStr(det && det.error);
    if (/not a member/i.test(err)) return fail(403, "forbidden", "That MFL login isn't in this league.");
    if (/HTTP 4\d\d/.test(err)) return fail(401, "session_expired", "Your MFL sign-in expired. Re-open this from MFL and try again.");
    return fail(503, "identity_unavailable", "Couldn't verify your MFL sign-in right now. Try again in a moment.");
  }
  const sessionFid = padFid(det.franchise_id);
  const isCommish = (a.deps.commishFids() || []).map(padFid).includes(sessionFid);
  if (declared && declared !== sessionFid && !isCommish) return fail(403, "forbidden", "You can only act as your own team.");
  const fid = declared || sessionFid;
  return { ok: true, caller: { kind: "owner", via: "session", sessionFid, fid, isCommish, actingAs: fid !== sessionFid, token, leagueId, season } };
}

// An explicit administrative route (outbox replay, reconcile…) accepts EITHER the admin
// key OR a proven commissioner session — and nothing else.
export function isAdminCaller(caller) {
  return !!caller && (caller.kind === "admin" || (caller.kind === "owner" && caller.isCommish));
}

export const callerFailureBody = (r) => ({ ok: false, code: r.code, error: r.message, message: r.message });
