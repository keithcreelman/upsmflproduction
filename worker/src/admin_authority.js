// admin_authority.js — who may call an /admin/* route at all.
//
// WHY THIS EXISTS (production, 2026-09-25): many admin routes decided "is the caller an admin?" with `getLeagueAdminState()` — but that
// function reads the WORKER'S OWN stored commissioner cookie, so it answers "is the worker a commissioner?" (always yes) for EVERY caller.
// Anonymous requests could reach routes that post league Discord alerts, read contract/config metadata, etc. The fix is a single
// front-door check on every exact, non-public admin route, BEFORE the handler runs: the caller must present
//   • one of the worker's own secrets (COMMISH_API_KEY, TEST_SYNC_API_KEY, MFL_APIKEY) as APIKEY / key / X-COMMISH-APIKEY / X-MFL-APIKEY /
//     X-Internal-Auth — the credential forms the existing routes and workflows already use — compared in constant time, OR
//   • an MFL session (MFL_USER_ID) that MFL itself proves belongs to a commissioner franchise of this league.
// Nothing else — and in particular never the worker's cookie, a franchise id in a body, or the absence of a credential. Each route may
// still apply a stricter rule of its own after this door.
//
// Pure apart from the injected `fetchImpl` (MFL `myleagues` lookup).
import { safeEqual } from "./trade_authz.js";

const s = (v) => String(v == null ? "" : v).trim();
const pad4 = (v) => { const d = s(v).replace(/\D/g, ""); return d ? d.padStart(4, "0").slice(-4) : ""; };

export function commishFranchiseIds(env) {
  return s(env && env.COMMISH_FRANCHISE_IDS || "0008,0000").split(/[,\s]+/).map(pad4).filter(Boolean);
}

/** Every place a credential may arrive — nothing here is trusted until compared. */
export function presentedKeys(request, url) {
  const q = (k) => s(url.searchParams.get(k));
  const h = (k) => s(request.headers.get(k));
  return [q("APIKEY"), q("key"), h("X-COMMISH-APIKEY"), h("X-MFL-APIKEY"), h("X-Internal-Auth")].filter(Boolean);
}

async function commishSession({ token, leagueId, year, env, fetchImpl }) {
  const raw = token.includes("=") ? token.split("=").pop() : token;
  let res;
  try {
    res = await fetchImpl(`https://api.myfantasyleague.com/${encodeURIComponent(year)}/export?TYPE=myleagues&JSON=1`,
      { headers: { Cookie: `MFL_USER_ID=${encodeURIComponent(raw)}`, "User-Agent": "upsmflproduction-worker" } });
  } catch (_) { return { ok: false, http: 503, code: "identity_unavailable" }; }
  if (!res.ok) return res.status >= 400 && res.status < 500 ? { ok: false, http: 401, code: "session_expired" } : { ok: false, http: 503, code: "identity_unavailable" };
  let data; try { data = await res.json(); } catch (_) { return { ok: false, http: 503, code: "identity_unavailable" }; }
  let leagues = (data && data.leagues && data.leagues.league) || (data && data.myleagues && data.myleagues.league) || [];
  if (!Array.isArray(leagues)) leagues = [leagues];
  const mine = leagues.find((lg) => lg && s(lg.league_id) === s(leagueId));
  if (!mine) return { ok: false, http: 403, code: "forbidden" };
  return commishFranchiseIds(env).includes(pad4(mine.franchise_id)) ? { ok: true, via: "session" } : { ok: false, http: 403, code: "forbidden" };
}

/**
 * @returns {{ok:true, via:'key'|'session'} | {ok:false, http:401|403|503, code:string}}
 */
export async function adminAuthority({ request, url, env, leagueId, year, fetchImpl }) {
  const secrets = [env && env.COMMISH_API_KEY, env && env.TEST_SYNC_API_KEY, env && env.MFL_APIKEY].map(s).filter(Boolean);
  const keys = presentedKeys(request, url);
  for (const k of keys) for (const sec of secrets) if (safeEqual(k, sec)) return { ok: true, via: "key" };
  const token = s(url.searchParams.get("MFL_USER_ID"));
  if (token) {
    const r = await commishSession({ token, leagueId: leagueId || "74598", year: year || String(new Date().getUTCFullYear()), env, fetchImpl });
    return r;                                            // ok, or 401 / 403 / 503 from MFL's own answer
  }
  return keys.length ? { ok: false, http: 403, code: "forbidden" } : { ok: false, http: 401, code: "unauthenticated" };
}

/** The uniform refusal: no route name, no state, no hint about what would have worked. */
export const adminDenial = (r) => ({
  ok: false, code: r.code,
  error: r.http === 503 ? "Couldn't verify that right now." : r.http === 401 ? "Authentication required." : "Not permitted.",
});
