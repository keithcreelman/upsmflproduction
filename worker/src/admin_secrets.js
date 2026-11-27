// admin_secrets.js — the ONE place that decides which worker secret may authorize which admin call.
//
// Phase 1 of the admin-authentication change (docs/UPS_ADMIN_KEY_MIGRATION.md): an independent secret, UPS_ADMIN_KEY, is accepted
// ALONGSIDE the credentials each site already accepts. Nothing else changes.
//
//   UPS_ADMIN_KEY  — a worker secret that is NOT an MFL credential. Accepted only from a HEADER (`Authorization: Bearer <key>` or
//                    `X-UPS-ADMIN-KEY`), never from the URL (a URL lands in logs, history and job output). Unset, empty or shorter than
//                    MIN_ADMIN_KEY_LENGTH characters => ignored completely, and the site behaves exactly as it did before.
//   legacy secrets — COMMISH_API_KEY, TEST_SYNC_API_KEY, MFL_APIKEY keep EXACTLY the sources and policy each site has today. The table
//                    below is that policy, written down once; a site never widens or narrows because of this module.
//
// Pure: no network, no storage. The only side effect is one console.log line when a LEGACY credential authorizes a request
// (`[admin-auth] via=<type> site=<site>` — type and site only, never a value, never the URL) so a later phase can see, from the logs,
// whether anything still depends on a legacy credential. UPS_ADMIN_KEY logs nothing. A denial logs nothing.
//
// Commissioner-SESSION logic (an MFL_USER_ID proven against MFL) is not here and is not touched; callers keep it as it is.

const s = (v) => String(v == null ? "" : v).trim();

/** Constant-time string comparison (length is the only thing it can leak). The ONE comparison every admin secret goes through;
 *  trade_authz.js re-exports it under the name the rest of the worker already imports. */
export function safeEqual(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export const MIN_ADMIN_KEY_LENGTH = 24;

/** Which Worker env binding backs each credential type (the `via` value a match reports). */
export const SECRET_ENV = Object.freeze({
  ups_admin_key: "UPS_ADMIN_KEY",
  commish_key: "COMMISH_API_KEY",
  test_sync_key: "TEST_SYNC_API_KEY",
  mfl_apikey: "MFL_APIKEY",
});
export const LEGACY_TYPES = Object.freeze(["commish_key", "test_sync_key", "mfl_apikey"]);

// Source notation: "query:NAME" (a URL parameter), "header:NAME", "bearer" (Authorization: Bearer <key>).
const FRONT_DOOR_SOURCES = Object.freeze(["query:APIKEY", "query:key", "header:X-COMMISH-APIKEY", "header:X-MFL-APIKEY", "header:X-Internal-Auth", "bearer"]);

/**
 * The policy per site: which legacy secret is accepted from which source TODAY.
 *   sessionPath  — whether the site ALSO accepts a commissioner MFL session (the lockout risk of a later phase is a site with `false`)
 *   pick:"first" — compare only the first non-empty value among the sources (the site reads `query || header`)
 * Every site accepts UPS_ADMIN_KEY from the two header forms in addition to what is listed here.
 */
export const ADMIN_SECRET_SITES = Object.freeze({
  admin_authority: {
    routes: ["every exact /admin/* route classified `admin` (the front door)", "GET /bug-reports"],
    sessionPath: true,
    legacy: [
      { via: "commish_key", sources: FRONT_DOOR_SOURCES },
      { via: "test_sync_key", sources: FRONT_DOOR_SOURCES },
      { via: "mfl_apikey", sources: FRONT_DOOR_SOURCES },
    ],
  },
  trade_caller: {
    routes: ["resolveTradeCaller: /api/trades/2way*, /api/trades/3way*, /api/trades/outbox, and the index.js trade routes"],
    sessionPath: true,
    legacy: [{ via: "commish_key", sources: ["query:APIKEY"] }],
  },
  push_mfl_calendar_commit: {
    routes: ["POST /admin/auction/push-mfl-calendar?commit=1"],
    sessionPath: true,
    legacy: [
      { via: "commish_key", sources: ["query:APIKEY"] },
      { via: "test_sync_key", sources: ["query:APIKEY"] },
    ],
  },
  three_way_cancel: {
    routes: ["POST /admin/3way/cancel"],
    sessionPath: false,
    legacy: [{ via: "commish_key", sources: ["query:APIKEY"] }],
  },
  trade_execution_admin: {
    routes: ["/admin/trade/execution", "/admin/trade/postprocess-retry", "/admin/trade/reconcile-execution", "/admin/trade/extension-review", "GET /admin/release-info"],
    sessionPath: false,
    legacy: [{ via: "commish_key", sources: ["query:APIKEY", "header:X-COMMISH-APIKEY"], pick: "first" }],
  },
  three_way_compliance: {
    routes: ["POST /admin/3way/compliance"],
    sessionPath: false,
    legacy: [{ via: "commish_key", sources: ["query:APIKEY"] }],
  },
  leaderboard_precompute_build: {
    routes: ["POST /admin/leaderboard-precompute/build"],
    sessionPath: false,
    legacy: [{ via: "commish_key", sources: ["query:APIKEY", "bearer"] }],
  },
  hall_admin: {
    routes: ["/admin/hall/* (checkAdmin in hall.js; handled before the front door)"],
    sessionPath: false,
    legacy: [{ via: "commish_key", sources: ["header:X-Internal-Auth"] }],
  },
});

/** `Authorization: Bearer <key>` -> the key ("" when absent or not a Bearer header). */
export function bearerKey(request) {
  const a = s(request && request.headers && request.headers.get("authorization"));
  return /^bearer\s+/i.test(a) ? a.replace(/^bearer\s+/i, "").trim() : "";
}

/** Every header form that may carry UPS_ADMIN_KEY, in order: X-UPS-ADMIN-KEY, then Authorization: Bearer. Empty values are dropped. */
export function adminKeyCandidates(request) {
  const h = s(request && request.headers && request.headers.get("X-UPS-ADMIN-KEY"));
  return [h, bearerKey(request)].filter(Boolean);
}
/** The UPS_ADMIN_KEY value a request presents in a header ("" when none). Never reads the URL. */
export function adminKeyFromHeaders(request) {
  return adminKeyCandidates(request)[0] || "";
}

/**
 * The configured UPS_ADMIN_KEY, or "" when it must be ignored: unset, blank, shorter than MIN_ADMIN_KEY_LENGTH, or EQUAL to any
 * legacy secret (a copy of an existing credential is not an independent one, and would leave the old exposure in place).
 */
export function upsAdminSecret(env) {
  const key = s(env && env.UPS_ADMIN_KEY);
  if (key.length < MIN_ADMIN_KEY_LENGTH) return "";
  for (const type of LEGACY_TYPES) {
    const legacy = s(env && env[SECRET_ENV[type]]);
    if (legacy && safeEqual(key, legacy)) return "";
  }
  return key;
}

const u2 = (url, name) => (url ? url.searchParams.get(name) : null);   // the raw (untrimmed) query value

function valuesFor(entry, request, url) {
  const get = (src) => {
    if (src === "bearer") return bearerKey(request);
    if (src.startsWith("header:")) return s(request.headers.get(src.slice(7)));
    if (src.startsWith("query:")) return url ? s(url.searchParams.get(src.slice(6))) : "";
    return "";
  };
  if (entry.pick === "first") {
    // The site reads `query || header` and trims AFTER choosing: a whitespace-only query value is truthy, so it is chosen and then
    // trims to nothing (refused) even beside a valid header. Choose on the RAW value to keep exactly that.
    const raw = (src) => {
      if (src.startsWith("query:")) return u2(url, src.slice(6));
      if (src.startsWith("header:")) return request.headers.get(src.slice(7));
      return "";
    };
    return [s(entry.sources.map(raw).find(Boolean))];
  }
  return entry.sources.map(get);
}

const logged = new WeakMap();   // request -> Set of "via|site" already logged (a handler may re-check the same request)
function logLegacy(request, via, site) {
  try {
    const mark = `${via}|${site}`;
    let seen = logged.get(request);
    if (!seen) { seen = new Set(); logged.set(request, seen); }
    if (seen.has(mark)) return;
    seen.add(mark);
  } catch (_) { /* a non-object request: log without de-duplication */ }
  console.log(`[admin-auth] via=${via} site=${site}`);
}

/**
 * Does this request carry a secret this site accepts?
 * @param {{request:Request, url?:URL, env:object, site:string, log?:boolean}} a
 * @returns {{ok:boolean, via:''|'ups_admin_key'|'commish_key'|'test_sync_key'|'mfl_apikey', upsPresented:boolean}}
 *   upsPresented — a UPS_ADMIN_KEY header was sent AND a usable UPS_ADMIN_KEY is configured (lets a caller keep its
 *   "credential presented but wrong" => 403 vs "none presented" => 401 distinction; always false when the key is unset).
 */
export function matchAdminSecret({ request, url, env, site, log = true }) {
  const none = { ok: false, via: "", upsPresented: false };
  const policy = ADMIN_SECRET_SITES[site];
  if (!policy) return none;                                       // an unknown site fails closed
  // A caller with no Request in hand (a unit-level call that only has the URL) still gets the query-parameter sources; it simply has no headers.
  if (!request || !request.headers) request = { headers: { get: () => null } };
  let u = url;
  if (!u) { try { u = new URL(request.url); } catch (_) { u = null; } }

  const ups = upsAdminSecret(env);
  const cands = ups ? adminKeyCandidates(request) : [];
  for (const c of cands) if (safeEqual(c, ups)) return { ok: true, via: "ups_admin_key", upsPresented: true };

  for (const entry of policy.legacy) {
    const secret = s(env && env[SECRET_ENV[entry.via]]);
    if (!secret) continue;
    for (const v of valuesFor(entry, request, u)) {
      if (v && safeEqual(v, secret)) {
        if (log) logLegacy(request, entry.via, site);
        return { ok: true, via: entry.via, upsPresented: cands.length > 0 };
      }
    }
  }
  return { ok: false, via: "", upsPresented: cands.length > 0 };
}
