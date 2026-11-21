// WORKER ADMIN AUTH, PHASE 1 — an independent UPS_ADMIN_KEY, accepted ALONGSIDE the existing credentials (additive, header-only).
//   node tests/admin_key_phase1.test.mjs
//
// Offline and synthetic: the REAL worker (worker/src/index.js `default.fetch`) is driven under Node with an in-memory SQLite D1 and a
// network edge that throws on any host it does not know. Every credential in this file is an obviously synthetic string.
//
// For each credential-checking site the worker has today, a table-driven regression proves:
//   1. every credential/source accepted before this change is still accepted, and nothing else is (wrong key, key in the wrong
//      source, unset secret, empty key, an MFL key at a COMMISH-only site)  -> the policy of each site is unchanged
//   2. UPS_ADMIN_KEY is accepted by header (Authorization: Bearer, X-UPS-ADMIN-KEY) at EVERY site, refused from the URL query,
//      refused when unset / short / wrong, and independent of every other secret
//   3. a request authorized by a LEGACY credential logs one `[admin-auth] via=<type> site=<site>` line; UPS_ADMIN_KEY and denials log
//      nothing; no credential value ever appears in any log output
// plus unit tests of worker/src/admin_secrets.js and a structural scan that fails when a new credential comparison appears in
// worker/src outside that module (and the explicit allowlist of OUTGOING uses of the worker's own secrets).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker } from "./fixtures/fcfs_worker_harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEAGUE = "74598";
const QS = `L=${LEAGUE}&YEAR=2026`;

// ── synthetic credentials ───────────────────────────────────────────────────────
const COMMISH = "SYNTHETIC-commish-key-00000000";
const TEST_SYNC = "SYNTHETIC-testsync-key-0000000";
const MFLK = "SYNTHETIC-mfl-apikey-000000000";
const UPS = "SYNTHETIC-admin-key-000000000000";
const SHORT = "SYNTHETIC-short-123";                // 19 chars: under the 24-char floor
const WRONG = "SYNTHETIC-wrong-key-0000000000";
const SECRETS = { commish_key: COMMISH, test_sync_key: TEST_SYNC, mfl_apikey: MFLK };
const ALL_VALUES = [COMMISH, TEST_SYNC, MFLK, UPS, SHORT, WRONG];
const SESSION_COMMISH = "SYNTHETIC-session-commish";
const SESSION_OWNER = "SYNTHETIC-session-owner";

const baseEnv = (over) => makeWorkerEnv({ COMMISH_API_KEY: COMMISH, TEST_SYNC_API_KEY: TEST_SYNC, MFL_APIKEY: MFLK, UPS_ADMIN_KEY: UPS, ...(over || {}) });
const envWithout = (...names) => { const e = baseEnv(); for (const n of names) delete e[n]; return e; };

// ── the network edge: unknown hosts throw; MFL myleagues answers for two synthetic sessions ─────────────────────
const mfl = makeMfl();
mfl.install();
const stubbedFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const u = new URL(String(input));
  if (u.hostname === "api.myfantasyleague.com" && u.searchParams.get("TYPE") === "myleagues") {
    const cookie = String((init && init.headers && (init.headers.Cookie || init.headers.cookie)) || "");
    const fid = cookie.includes(SESSION_COMMISH) ? "0008" : cookie.includes(SESSION_OWNER) ? "0005" : "";
    const body = fid ? { myleagues: { league: [{ league_id: LEAGUE, franchise_id: fid }] } } : { myleagues: { league: [] } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }
  return stubbedFetch(input, init);
};

// capture console output (the worker logs; the regression asserts what it logs)
const realConsole = { log: console.log, warn: console.warn, error: console.error, info: console.info };
let captured = [];
const capture = () => {
  captured = [];
  const sink = (...a) => { captured.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
  console.warn = sink; console.error = sink; console.info = sink;
  console.log = (...a) => { sink(...a); };
};
const uncapture = () => { Object.assign(console, realConsole); };
const authLines = () => captured.filter((l) => l.startsWith("[admin-auth]"));

// ── credential delivery ─────────────────────────────────────────────────────────
const SOURCES = ["query:APIKEY", "query:key", "header:X-COMMISH-APIKEY", "header:X-MFL-APIKEY", "header:X-Internal-Auth", "bearer", "header:X-UPS-ADMIN-KEY"];
function deliver(source, value) {
  const out = { query: "", headers: {} };
  if (source === "bearer") out.headers.Authorization = `Bearer ${value}`;
  else if (source.startsWith("header:")) out.headers[source.slice(7)] = value;
  else out.query = `&${source.slice(6)}=${encodeURIComponent(value)}`;
  return out;
}

// ── the sites, as they exist today ─────────────────────────────────────────────
// `call(env, cred)` drives one real route; `denied(res)` says whether THAT site's credential check refused the call
// (anything else means the credential was accepted and the handler ran, whatever the handler then did).
const FRONT_DOOR_DENIAL = (r) => (r.status === 401 || r.status === 403) && r.json && /^(Authentication required\.|Not permitted\.)$/.test(r.json.error || "");
const ALL6 = SOURCES.filter((s) => s !== "header:X-UPS-ADMIN-KEY");
const call = (method, p, body) => (env, cred) => callWorker(env, method, `${p}${p.includes("?") ? "&" : "?"}${QS}${cred.query}`, { headers: cred.headers, ...(body !== undefined ? { body } : {}) });

const SITES = [
  {
    id: "admin_authority", routes: ["GET /bug-reports"], session: true,
    legacy: { commish_key: ALL6, test_sync_key: ALL6, mfl_apikey: ALL6 },
    calls: [call("GET", "/bug-reports")],
    denied: FRONT_DOOR_DENIAL,
  },
  {
    id: "trade_caller", routes: ["GET /api/trades/outbox", "GET /api/trades/2way/queue", "GET /api/trades/3way"], session: "owner",   // an OWNER session is a legitimate (non-admin) caller here, so it is not part of the commissioner-session check below
    legacy: { commish_key: ["query:APIKEY"] },
    calls: [call("GET", "/api/trades/outbox"), call("GET", "/api/trades/2way/queue"), call("GET", "/api/trades/3way")],
    denied: (r) => r.status === 401 || r.status === 403,
  },
  {
    id: "push_mfl_calendar_commit", routes: ["POST /admin/auction/push-mfl-calendar?commit=1"], session: true,
    legacy: { commish_key: ["query:APIKEY"], test_sync_key: ["query:APIKEY"] },
    calls: [call("POST", "/admin/auction/push-mfl-calendar?commit=1", {})],
    denied: (r) => FRONT_DOOR_DENIAL(r) || (r.status === 403 && /commit is commish-only/.test((r.json && r.json.error) || "")),
  },
  {
    id: "three_way_cancel", routes: ["POST /admin/3way/cancel"], session: false,
    legacy: { commish_key: ["query:APIKEY"] },
    calls: [call("POST", "/admin/3way/cancel", { id: "synthetic", reason: "synthetic" })],
    denied: (r) => FRONT_DOOR_DENIAL(r) || (r.status === 403 && /needs the commissioner API key/.test((r.json && r.json.error) || "")),
  },
  {
    id: "trade_execution_admin", routes: ["GET /admin/release-info"], session: false,
    legacy: { commish_key: ["query:APIKEY", "header:X-COMMISH-APIKEY"] },
    calls: [call("GET", "/admin/release-info")],
    denied: (r) => FRONT_DOOR_DENIAL(r) || (r.status === 403 && /needs the commissioner API key/.test((r.json && r.json.error) || "")),
  },
  {
    id: "three_way_compliance", routes: ["POST /admin/3way/compliance"], session: false,
    legacy: { commish_key: ["query:APIKEY"] },
    calls: [call("POST", "/admin/3way/compliance", {})],
    denied: (r) => FRONT_DOOR_DENIAL(r) || (r.status === 403 && /Need COMMISH_API_KEY/.test((r.json && r.json.error) || "")),
  },
  {
    id: "leaderboard_precompute_build", routes: ["POST /admin/leaderboard-precompute/build"], session: false,
    legacy: { commish_key: ["query:APIKEY", "bearer"] },
    calls: [call("POST", "/admin/leaderboard-precompute/build", {})],
    denied: (r) => FRONT_DOOR_DENIAL(r) || (r.status === 403 && /Valid COMMISH_API_KEY is required to build/.test((r.json && r.json.error) || "")),
  },
  {
    id: "hall_admin", routes: ["POST /admin/hall/proposals"], session: false,
    legacy: { commish_key: ["header:X-Internal-Auth"] },
    calls: [(env, cred) => callWorker(env, "POST", `/admin/hall/proposals?${QS}${cred.query}`, { headers: cred.headers, body: "not json" })],
    denied: (r) => r.status === 403,
  },
];

const attempt = async (site, env, source, value) => {
  const verdicts = [];
  for (const c of site.calls) { const r = await c(env, deliver(source, value)); verdicts.push(!site.denied(r)); }
  return verdicts;      // one entry per route: true = the credential check let the call through
};
const allTrue = (v) => v.every((x) => x === true);
const allFalse = (v) => v.every((x) => x === false);

// ═══════════════════════════ 1. today's policy is unchanged ═══════════════════════════
for (const site of SITES) {
  test(`${site.id}: every credential/source accepted today is still accepted; every other secret/source pair is still refused`, async () => {
    for (const via of Object.keys(SECRETS)) {
      for (const source of SOURCES) {
        const accepted = (site.legacy[via] || []).includes(source);
        const v = await attempt(site, baseEnv(), source, SECRETS[via]);
        if (accepted) t.ok(allTrue(v), `${site.id}: ${via} via ${source} must be accepted (${v})`);
        else t.ok(allFalse(v), `${site.id}: ${via} via ${source} must be refused (${v})`);
      }
    }
  });
  test(`${site.id}: a wrong key, an empty key, no credential and an unset secret are all refused`, async () => {
    for (const source of SOURCES) t.ok(allFalse(await attempt(site, baseEnv(), source, WRONG)), `${site.id}: wrong key via ${source}`);
    for (const source of SOURCES) t.ok(allFalse(await attempt(site, baseEnv(), source, "")), `${site.id}: empty key via ${source}`);
    const none = []; for (const c of site.calls) none.push(!site.denied(await c(baseEnv(), { query: "", headers: {} })));
    t.ok(allFalse(none), `${site.id}: no credential at all`);
    // a legacy secret that is not configured never matches, even when the caller sends that exact (now meaningless) value or an empty one
    for (const via of Object.keys(site.legacy)) {
      const envName = { commish_key: "COMMISH_API_KEY", test_sync_key: "TEST_SYNC_API_KEY", mfl_apikey: "MFL_APIKEY" }[via];
      for (const source of site.legacy[via]) {
        const env = envWithout(envName, "UPS_ADMIN_KEY");
        t.ok(allFalse(await attempt(site, env, source, SECRETS[via])), `${site.id}: ${envName} unset, ${source} must be refused`);
        t.ok(allFalse(await attempt(site, env, source, "")), `${site.id}: ${envName} unset, empty ${source} must be refused`);
      }
    }
  });
}

test("trade_execution_admin: a wrong query key still wins over a right header key (today's `query || header` precedence)", async () => {
  const site = SITES.find((s) => s.id === "trade_execution_admin");
  const r = await callWorker(baseEnv(), "GET", `/admin/release-info?${QS}&APIKEY=${WRONG}`, { headers: { "X-COMMISH-APIKEY": COMMISH } });
  t.ok(site.denied(r), "the route reads the query first and ignores the header when the query key is present");
});

test("sessions: a proven commissioner MFL session is still accepted where one exists today, and an owner session is not", async () => {
  for (const site of SITES.filter((s) => s.session === true)) {
    for (const call of site.calls.slice(0, 1)) {
      const okRes = await call(baseEnv(), { query: `&MFL_USER_ID=${SESSION_COMMISH}`, headers: {} });
      t.ok(!site.denied(okRes), `${site.id}: commissioner session accepted (${okRes.status})`);
      const ownerRes = await call(baseEnv(), { query: `&MFL_USER_ID=${SESSION_OWNER}`, headers: {} });
      t.ok(site.denied(ownerRes), `${site.id}: owner session refused (${ownerRes.status})`);
    }
  }
});

// ═══════════════════════════ 2. UPS_ADMIN_KEY: header only, additive, independent ═══════════════════════════
const UPS_HEADER_SOURCES = ["bearer", "header:X-UPS-ADMIN-KEY"];
for (const site of SITES) {
  test(`${site.id}: UPS_ADMIN_KEY is accepted by header (Bearer, X-UPS-ADMIN-KEY) and refused from the URL query`, async () => {
    for (const source of UPS_HEADER_SOURCES) t.ok(allTrue(await attempt(site, baseEnv(), source, UPS)), `${site.id}: UPS_ADMIN_KEY via ${source}`);
    for (const source of ["query:APIKEY", "query:key", "query:UPS_ADMIN_KEY", "query:X-UPS-ADMIN-KEY"]) t.ok(allFalse(await attempt(site, baseEnv(), source, UPS)), `${site.id}: UPS_ADMIN_KEY must never be accepted from ${source}`);
    // the other admin headers never carry it
    for (const source of ["header:X-COMMISH-APIKEY", "header:X-MFL-APIKEY", "header:X-Internal-Auth"]) t.ok(allFalse(await attempt(site, baseEnv(), source, UPS)), `${site.id}: UPS_ADMIN_KEY is not a ${source} credential`);
  });
  test(`${site.id}: UPS_ADMIN_KEY is ignored when unset, empty, short or wrong; a wrong header never opens anything`, async () => {
    for (const source of UPS_HEADER_SOURCES) {
      t.ok(allFalse(await attempt(site, envWithout("UPS_ADMIN_KEY"), source, UPS)), `${site.id}: unset secret, ${source}`);
      t.ok(allFalse(await attempt(site, baseEnv({ UPS_ADMIN_KEY: "" }), source, UPS)), `${site.id}: empty secret, ${source}`);
      t.ok(allFalse(await attempt(site, baseEnv({ UPS_ADMIN_KEY: "   " }), source, "")), `${site.id}: blank secret + blank header, ${source}`);
      t.ok(allFalse(await attempt(site, baseEnv({ UPS_ADMIN_KEY: SHORT }), source, SHORT)), `${site.id}: a short secret (${SHORT.length} chars) is ignored even when presented exactly, ${source}`);
      t.ok(allFalse(await attempt(site, baseEnv(), source, WRONG)), `${site.id}: wrong value, ${source}`);
      t.ok(allFalse(await attempt(site, baseEnv(), source, UPS + "x")), `${site.id}: near miss, ${source}`);
    }
  });
  test(`${site.id}: UPS_ADMIN_KEY works with every legacy secret unset (it is independent), and changes nothing for legacy callers`, async () => {
    const bare = envWithout("COMMISH_API_KEY", "TEST_SYNC_API_KEY", "MFL_APIKEY");
    for (const source of UPS_HEADER_SOURCES) t.ok(allTrue(await attempt(site, bare, source, UPS)), `${site.id}: UPS only, ${source}`);
    // legacy secrets neither gain nor lose anything when UPS_ADMIN_KEY is configured
    for (const via of Object.keys(SECRETS)) for (const source of SOURCES) {
      const accepted = (site.legacy[via] || []).includes(source);
      const v = await attempt(site, baseEnv(), source, SECRETS[via]);
      t.ok(accepted ? allTrue(v) : allFalse(v), `${site.id}: ${via} via ${source} unchanged with UPS_ADMIN_KEY set`);
    }
  });
}

test("trade_caller: allowAdminKey=false callers (membership / contract proofs) never accept UPS_ADMIN_KEY either (wiring: resolveTradeCaller honors it)", async () => {
  const { resolveTradeCaller } = await import("../worker/src/trade_authz.js");
  const req = new Request("https://worker.test/x", { headers: { Authorization: `Bearer ${UPS}` } });
  const deps = { detectFranchise: async () => ({ error: "HTTP 401" }), commishFids: () => ["0008"] };
  const url = new URL(`https://worker.test/x?L=${LEAGUE}&YEAR=2026`);
  const on = await resolveTradeCaller({ request: req, url, env: { UPS_ADMIN_KEY: UPS }, deps, defaultLeagueId: LEAGUE, defaultSeason: "2026" });
  t.equal(on.ok, true); t.equal(on.caller.kind, "admin");
  const off = await resolveTradeCaller({ request: req, url, env: { UPS_ADMIN_KEY: UPS }, deps, defaultLeagueId: LEAGUE, defaultSeason: "2026", allowAdminKey: false });
  t.equal(off.ok, false);
});

// ═══════════════════════════ 3. what is logged ═══════════════════════════
test("logging: a legacy credential logs exactly one `[admin-auth] via=<type> site=<site>` line per check; UPS_ADMIN_KEY and denials log none; no value ever appears in any output", async () => {
  const cases = [
    { site: "three_way_cancel", source: "query:APIKEY", via: "commish_key", call: SITES.find((s) => s.id === "three_way_cancel").calls[0], sites: ["admin_authority", "three_way_cancel"] },
    { site: "push_mfl_calendar_commit", source: "query:APIKEY", via: "test_sync_key", call: SITES.find((s) => s.id === "push_mfl_calendar_commit").calls[0], sites: ["admin_authority", "push_mfl_calendar_commit"], value: TEST_SYNC },
    { site: "admin_authority", source: "bearer", via: "mfl_apikey", call: SITES[0].calls[0], sites: ["admin_authority"], value: MFLK },
    { site: "hall_admin", source: "header:X-Internal-Auth", via: "commish_key", call: SITES.find((s) => s.id === "hall_admin").calls[0], sites: ["hall_admin"] },
    { site: "leaderboard_precompute_build", source: "bearer", via: "commish_key", call: SITES.find((s) => s.id === "leaderboard_precompute_build").calls[0], sites: ["admin_authority", "leaderboard_precompute_build"] },
  ];
  for (const c of cases) {
    capture();
    try { await c.call(baseEnv(), deliver(c.source, c.value || COMMISH)); } finally { uncapture(); }
    const lines = authLines();
    t.equal(lines.length, c.sites.length, `${c.site}: expected ${c.sites.length} line(s), got ${JSON.stringify(lines)}`);
    for (const s of c.sites) t.ok(lines.includes(`[admin-auth] via=${c.via} site=${s}`), `${c.site}: missing line for ${s}: ${JSON.stringify(lines)}`);
    for (const l of captured) for (const v of ALL_VALUES) t.ok(!l.includes(v), `${c.site}: a credential value leaked into a log line`);
  }
  for (const site of SITES) {
    for (const source of UPS_HEADER_SOURCES) {
      capture();
      try { await attempt(site, baseEnv(), source, UPS); } finally { uncapture(); }
      t.equal(authLines().length, 0, `${site.id}: UPS_ADMIN_KEY via ${source} must log no [admin-auth] line`);
      for (const l of captured) for (const v of ALL_VALUES) t.ok(!l.includes(v), `${site.id}: a credential value leaked into a log line`);
    }
    capture();
    try { await attempt(site, baseEnv(), "bearer", WRONG); await attempt(site, baseEnv(), "query:APIKEY", WRONG); } finally { uncapture(); }
    t.equal(authLines().length, 0, `${site.id}: a denial must log no [admin-auth] line`);
    for (const l of captured) for (const v of ALL_VALUES) t.ok(!l.includes(v), `${site.id}: a credential value leaked into a log line (denial)`);
  }
});

// ═══════════════════════════ 4. CORS ═══════════════════════════
test("CORS: a preflight for the new header is answered; the allow-list names X-UPS-ADMIN-KEY", async () => {
  const r = await callWorker(baseEnv(), "OPTIONS", "/admin/release-info", { headers: { Origin: "https://example.test", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "x-ups-admin-key" } });
  t.equal(r.status, 200);
  const allow = String(r.headers.get("access-control-allow-headers") || "").toLowerCase();
  t.ok(allow.includes("content-type"), "Content-Type is still allowed");
  t.ok(allow.includes("x-ups-admin-key"), `X-UPS-ADMIN-KEY must be allowed for browser callers (got "${allow}")`);
});

// ═══════════════════════════ 5. denial bodies are byte-for-byte what they were ═══════════════════════════
test("denials: every site's refusal keeps its status, code and wording", async () => {
  const j = (r) => JSON.stringify(r.json);
  let r = await callWorker(baseEnv(), "POST", `/admin/3way/cancel?${QS}&APIKEY=${MFLK}`, { body: {} });
  t.equal(r.status, 403); t.equal(j(r), JSON.stringify({ ok: false, code: "forbidden", error: "That needs the commissioner API key.", message: "That needs the commissioner API key." }));
  r = await callWorker(baseEnv(), "POST", `/admin/3way/compliance?${QS}&APIKEY=${MFLK}`, { body: {} });
  t.equal(r.status, 403); t.equal(j(r), JSON.stringify({ ok: false, error: "Need COMMISH_API_KEY." }));
  r = await callWorker(baseEnv(), "POST", `/admin/leaderboard-precompute/build?${QS}&APIKEY=${MFLK}`, { body: {} });
  t.equal(r.status, 403); t.equal(j(r), JSON.stringify({ ok: false, error: "Valid COMMISH_API_KEY is required to build the precompute." }));
  r = await callWorker(baseEnv(), "POST", `/admin/auction/push-mfl-calendar?${QS}&commit=1&APIKEY=${MFLK}`, { body: {} });
  t.equal(r.status, 403); t.equal(j(r), JSON.stringify({ ok: false, error: "commit is commish-only — sign in to MFL as the commissioner (or pass the commish API key)." }));
  r = await callWorker(baseEnv(), "GET", `/admin/release-info?${QS}&APIKEY=${MFLK}`);
  t.equal(r.status, 403); t.equal(j(r), JSON.stringify({ ok: false, code: "forbidden", error: "That needs the commissioner API key.", message: "That needs the commissioner API key." }));
  // (above, the MFL key passes the front door and is refused by the route's own check; a wrong key never gets past the front door:)
  r = await callWorker(baseEnv(), "POST", `/admin/3way/cancel?${QS}&APIKEY=${WRONG}`, { body: {} });
  t.equal(r.status, 403); t.equal(j(r), JSON.stringify({ ok: false, code: "forbidden", error: "Not permitted." }));
  // the front door: nothing presented = 401, something presented and wrong = 403 (a wrong UPS_ADMIN_KEY counts as "presented" only when one is configured)
  r = await callWorker(baseEnv(), "GET", `/bug-reports?${QS}`);
  t.equal(r.status, 401); t.equal(j(r), JSON.stringify({ ok: false, code: "unauthenticated", error: "Authentication required." }));
  r = await callWorker(baseEnv(), "GET", `/bug-reports?${QS}&APIKEY=${WRONG}`);
  t.equal(r.status, 403); t.equal(j(r), JSON.stringify({ ok: false, code: "forbidden", error: "Not permitted." }));
  r = await callWorker(baseEnv(), "GET", `/bug-reports?${QS}`, { headers: { "X-UPS-ADMIN-KEY": WRONG } });
  t.equal(r.status, 403, "a wrong key in the new header is a presented credential when UPS_ADMIN_KEY is configured");
  r = await callWorker(envWithout("UPS_ADMIN_KEY"), "GET", `/bug-reports?${QS}`, { headers: { "X-UPS-ADMIN-KEY": WRONG } });
  t.equal(r.status, 401, "with UPS_ADMIN_KEY unset the new header is not even looked at: exactly today's answer");
  // hall: its two distinct reasons
  r = await callWorker(envWithout("COMMISH_API_KEY", "UPS_ADMIN_KEY"), "POST", `/admin/hall/proposals`, { headers: { "X-Internal-Auth": WRONG }, body: "x" });
  t.equal(r.status, 403); t.equal(j(r), JSON.stringify({ ok: false, error: "Missing COMMISH_API_KEY worker secret" }));
  r = await callWorker(baseEnv(), "POST", `/admin/hall/proposals`, { headers: { "X-Internal-Auth": WRONG }, body: "x" });
  t.equal(r.status, 403); t.equal(j(r), JSON.stringify({ ok: false, error: "Valid COMMISH_API_KEY required" }));
  // trade routes: an invalid ?APIKEY= with no session is 403; no credentials is 401 (a UPS header that does not match changes neither)
  r = await callWorker(baseEnv(), "GET", `/api/trades/outbox?${QS}&APIKEY=${WRONG}`);
  t.equal(r.status, 403); t.equal(r.json.error, "That administrative key isn't valid.");
  r = await callWorker(baseEnv(), "GET", `/api/trades/outbox?${QS}`, { headers: { "X-UPS-ADMIN-KEY": WRONG } });
  t.equal(r.status, 401);
});

// ═══════════════════════════ 6. the policy module itself ═══════════════════════════
const AS = await import("../worker/src/admin_secrets.js");
const AA = await import("../worker/src/admin_authority.js");
const TA = await import("../worker/src/trade_authz.js");
await import("../worker/src/hall.js");
await import("../worker/src/trade_2way_http.js");
await import("../worker/src/trade_3way_http.js");
const envOf = (over) => ({ COMMISH_API_KEY: COMMISH, TEST_SYNC_API_KEY: TEST_SYNC, MFL_APIKEY: MFLK, UPS_ADMIN_KEY: UPS, ...(over || {}) });
const reqOf = (headers) => new Request("https://worker.test/x", { headers: headers || {} });
const urlOf = (qs) => new URL("https://worker.test/x?" + (qs || ""));
const silent = (fn) => { capture(); try { return fn(); } finally { uncapture(); } };
const silentA = async (fn) => { capture(); try { return await fn(); } finally { uncapture(); } };

test("policy table: exactly the eight credential-checking sites, each exercised above, with today's sources and session paths", () => {
  const expected = SITES.map((s) => s.id).sort();
  t.deepEqual(Object.keys(AS.ADMIN_SECRET_SITES).sort(), expected);
  for (const s of SITES) {
    const p = AS.ADMIN_SECRET_SITES[s.id];
    const flat = {}; for (const e of p.legacy) flat[e.via] = e.sources.slice();
    t.deepEqual(Object.keys(flat).sort(), Object.keys(s.legacy).sort(), `${s.id}: legacy secret types`);
    for (const via of Object.keys(s.legacy)) t.deepEqual(flat[via].slice().sort(), s.legacy[via].slice().sort(), `${s.id}/${via}: sources`);
    t.equal(p.sessionPath, !!s.session, `${s.id}: commissioner-session path`);
    t.ok(Array.isArray(p.routes) && p.routes.length >= 1, `${s.id}: routes documented`);
  }
  t.ok(Object.isFrozen(AS.ADMIN_SECRET_SITES), "the table is frozen");
});

test("matchAdminSecret: via is exact for every site, secret type and source; UPS_ADMIN_KEY wins and logs nothing", () => {
  for (const site of SITES) {
    for (const via of Object.keys(SECRETS)) for (const source of SOURCES) {
      const d = deliver(source, SECRETS[via]);
      const m = silent(() => AS.matchAdminSecret({ request: reqOf(d.headers), url: urlOf(d.query.slice(1)), env: envOf({ UPS_ADMIN_KEY: "" }), site: site.id }));
      const accepted = (site.legacy[via] || []).includes(source);
      t.equal(m.ok, accepted, `${site.id}: ${via} via ${source}`);
      t.equal(m.via, accepted ? via : "", `${site.id}: via for ${via}/${source}`);
    }
    for (const source of UPS_HEADER_SOURCES) {
      const d = deliver(source, UPS);
      capture();
      let m; try { m = AS.matchAdminSecret({ request: reqOf(d.headers), url: urlOf(""), env: envOf(), site: site.id }); } finally { uncapture(); }
      t.deepEqual({ ok: m.ok, via: m.via }, { ok: true, via: "ups_admin_key" });
      t.equal(captured.length, 0, "UPS_ADMIN_KEY logs nothing");
    }
  }
});

test("matchAdminSecret: legacy match logs exactly `[admin-auth] via=<type> site=<site>` once per request, never a value; log:false and denials are silent", () => {
  const d = deliver("query:APIKEY", COMMISH);
  const req = reqOf({});
  capture();
  try {
    AS.matchAdminSecret({ request: req, url: urlOf(d.query.slice(1)), env: envOf(), site: "three_way_cancel" });
    AS.matchAdminSecret({ request: req, url: urlOf(d.query.slice(1)), env: envOf(), site: "three_way_cancel" });   // same request again: de-duplicated
  } finally { uncapture(); }
  t.deepEqual(captured, ["[admin-auth] via=commish_key site=three_way_cancel"]);
  capture();
  try {
    AS.matchAdminSecret({ request: reqOf({}), url: urlOf(d.query.slice(1)), env: envOf(), site: "three_way_cancel", log: false });
    AS.matchAdminSecret({ request: reqOf({}), url: urlOf("APIKEY=" + WRONG), env: envOf(), site: "three_way_cancel" });
  } finally { uncapture(); }
  t.deepEqual(captured, []);
});

test("upsAdminSecret: unset / blank / 23 chars are ignored, 24 chars accepted, trimmed, and a copy of any legacy secret is ignored", () => {
  t.equal(AS.MIN_ADMIN_KEY_LENGTH, 24);
  const k24 = "SYNTHETIC-24-chars-key-0"; const k23 = k24.slice(0, 23);
  t.equal(k24.length, 24); t.equal(k23.length, 23);
  t.equal(AS.upsAdminSecret({}), ""); t.equal(AS.upsAdminSecret({ UPS_ADMIN_KEY: undefined }), ""); t.equal(AS.upsAdminSecret({ UPS_ADMIN_KEY: null }), "");
  t.equal(AS.upsAdminSecret({ UPS_ADMIN_KEY: "" }), ""); t.equal(AS.upsAdminSecret({ UPS_ADMIN_KEY: "     " }), "");
  t.equal(AS.upsAdminSecret({ UPS_ADMIN_KEY: k23 }), "");
  t.equal(AS.upsAdminSecret({ UPS_ADMIN_KEY: k24 }), k24);
  t.equal(AS.upsAdminSecret({ UPS_ADMIN_KEY: `  ${k24}  ` }), k24, "trimmed, like every other secret");
  t.equal(AS.upsAdminSecret({ UPS_ADMIN_KEY: `${k23}   ` }), "", "padding does not make a short key long");
  for (const [name, value] of [["COMMISH_API_KEY", COMMISH], ["TEST_SYNC_API_KEY", TEST_SYNC], ["MFL_APIKEY", MFLK]]) {
    t.equal(AS.upsAdminSecret({ UPS_ADMIN_KEY: value, [name]: value }), "", `a UPS_ADMIN_KEY equal to ${name} is not independent: ignored`);
  }
  // …and so a header carrying that shared value is judged only as the legacy credential it is, at each site's own policy
  const shared = { UPS_ADMIN_KEY: MFLK, MFL_APIKEY: MFLK };
  const m = AS.matchAdminSecret({ request: reqOf({ "X-UPS-ADMIN-KEY": MFLK }), url: urlOf(""), env: shared, site: "three_way_cancel", log: false });
  t.equal(m.ok, false);
});

test("adminKeyFromHeaders: X-UPS-ADMIN-KEY, then Authorization: Bearer; never the URL; an empty or non-Bearer header is nothing", () => {
  t.equal(AS.adminKeyFromHeaders(reqOf({ "X-UPS-ADMIN-KEY": ` ${UPS} ` })), UPS);
  t.equal(AS.adminKeyFromHeaders(reqOf({ Authorization: `Bearer ${UPS}` })), UPS);
  t.equal(AS.adminKeyFromHeaders(reqOf({ Authorization: `bearer   ${UPS}  ` })), UPS, "scheme is case-insensitive");
  t.equal(AS.adminKeyFromHeaders(reqOf({ "X-UPS-ADMIN-KEY": UPS, Authorization: "Bearer other" })), UPS, "the dedicated header comes first");
  t.equal(AS.adminKeyFromHeaders(reqOf({ Authorization: `Basic ${UPS}` })), "");
  t.equal(AS.adminKeyFromHeaders(reqOf({ "X-UPS-ADMIN-KEY": "   " })), "");
  t.equal(AS.adminKeyFromHeaders(new Request(`https://worker.test/x?APIKEY=${UPS}&key=${UPS}&UPS_ADMIN_KEY=${UPS}`)), "", "the URL is never a source");
  t.deepEqual(AS.adminKeyCandidates(reqOf({ "X-UPS-ADMIN-KEY": "a", Authorization: "Bearer b" })), ["a", "b"]);
  // a Bearer header that is NOT the UPS key must not shadow a right X-UPS-ADMIN-KEY, and vice versa
  const both = silent(() => AS.matchAdminSecret({ request: reqOf({ Authorization: "Bearer something-else", "X-UPS-ADMIN-KEY": UPS }), url: urlOf(""), env: envOf(), site: "hall_admin" }));
  t.equal(both.ok, true); t.equal(both.via, "ups_admin_key");
  const both2 = silent(() => AS.matchAdminSecret({ request: reqOf({ Authorization: `Bearer ${UPS}`, "X-UPS-ADMIN-KEY": "something-else" }), url: urlOf(""), env: envOf(), site: "hall_admin" }));
  t.equal(both2.ok, true);
});

test("matchAdminSecret: an unknown site fails closed; no Request in hand still honors the URL sources; safeEqual is constant-time-shaped and total", () => {
  t.equal(AS.matchAdminSecret({ request: reqOf({ "X-UPS-ADMIN-KEY": UPS }), url: urlOf(""), env: envOf(), site: "not_a_site" }).ok, false);
  t.equal(AS.matchAdminSecret({ request: reqOf({ "X-UPS-ADMIN-KEY": UPS }), url: urlOf(""), env: envOf(), site: "" }).ok, false);
  const noReq = silent(() => AS.matchAdminSecret({ url: urlOf("APIKEY=" + COMMISH), env: envOf(), site: "trade_caller" }));
  t.equal(noReq.ok, true); t.equal(noReq.via, "commish_key");
  t.equal(AS.matchAdminSecret({ url: urlOf("APIKEY=" + WRONG), env: envOf(), site: "trade_caller", log: false }).ok, false);
  t.equal(AS.matchAdminSecret({ env: envOf(), site: "trade_caller", log: false }).ok, false, "nothing at all");
  t.equal(AS.safeEqual("a", "a"), true); t.equal(AS.safeEqual("a", "b"), false); t.equal(AS.safeEqual("a", "ab"), false); t.equal(AS.safeEqual("", ""), true);
  t.equal(AS.safeEqual(12, "12"), true, "coerces like the original");
  t.equal(TA.safeEqual, AS.safeEqual, "trade_authz re-exports the same function the rest of the worker imports");
});

test("modules: every export the rest of the worker imports still exists (the no-undef / TDZ guard, offline)", () => {
  for (const n of ["adminAuthority", "adminDenial", "presentedKeys", "bearerKey", "commishFranchiseIds"]) t.equal(typeof AA[n], "function", `admin_authority.${n}`);
  for (const n of ["resolveTradeCaller", "isAdminCaller", "callerFailureBody", "safeEqual", "padFid", "isValidLeagueId", "isValidSeason"]) t.equal(typeof TA[n], "function", `trade_authz.${n}`);
  for (const n of ["matchAdminSecret", "adminKeyFromHeaders", "adminKeyCandidates", "upsAdminSecret", "bearerKey", "safeEqual"]) t.equal(typeof AS[n], "function", `admin_secrets.${n}`);
  // the worker's entry module imports matchAdminSecret at module scope (never a late const): it must be a top-of-file import
  const idx = fs.readFileSync(path.join(ROOT, "worker/src/index.js"), "utf8");
  const line = idx.split("\n").findIndex((l) => /^import \{ matchAdminSecret \} from "\.\/admin_secrets\.js";/.test(l));
  t.ok(line >= 0 && line < 200, `index.js imports matchAdminSecret at the top of the module (line ${line + 1})`);
  t.doesNotMatch(idx, /\bbearerKey\s*\(/, "index.js no longer calls bearerKey (it is not imported there any more)");
});

test("adminAuthority (unit): key => via key; the 401/403 split and the commissioner-session path are untouched", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ myleagues: { league: [{ league_id: LEAGUE, franchise_id: "0008" }] } }), { status: 200 });
  const call = (headers, qs, env) => AA.adminAuthority({ request: reqOf(headers), url: urlOf(qs), env: env || envOf(), leagueId: LEAGUE, year: "2026", fetchImpl });
  t.deepEqual(await silentA(() => call({ "X-UPS-ADMIN-KEY": UPS }, "")), { ok: true, via: "key" });
  t.deepEqual(await silentA(() => call({ Authorization: `Bearer ${UPS}` }, "")), { ok: true, via: "key" });
  t.deepEqual(await silentA(() => call({}, "APIKEY=" + MFLK)), { ok: true, via: "key" });
  t.deepEqual(await call({}, ""), { ok: false, http: 401, code: "unauthenticated" });
  t.deepEqual(await call({}, "APIKEY=" + UPS), { ok: false, http: 403, code: "forbidden" }, "UPS_ADMIN_KEY in the URL is just a wrong key");
  t.deepEqual(await call({ Authorization: "Bearer nope" }, ""), { ok: false, http: 403, code: "forbidden" });
  t.deepEqual(await call({}, "MFL_USER_ID=SYNTHETIC-session"), { ok: true, via: "session" }, "the session path is unchanged");
  t.deepEqual(await call({ "X-UPS-ADMIN-KEY": WRONG }, "MFL_USER_ID=SYNTHETIC-session"), { ok: true, via: "session" }, "a wrong UPS header does not block a proven session");
});

test("resolveTradeCaller (unit): UPS_ADMIN_KEY header = admin caller; ?APIKEY= and the owner-session fall-through behave as before", async () => {
  const deps = { detectFranchise: async (token) => (token === "SYNTHETIC-owner" ? { franchise_id: "0005" } : { error: "HTTP 401" }), commishFids: () => ["0008"] };
  const go = (qs, headers, extra) => TA.resolveTradeCaller({ request: reqOf(headers), url: urlOf(`L=${LEAGUE}&YEAR=2026&${qs}`), env: envOf(), deps, defaultLeagueId: LEAGUE, defaultSeason: "2026", ...(extra || {}) });
  let r = await silentA(() => go("", { "X-UPS-ADMIN-KEY": UPS })); t.equal(r.ok, true); t.equal(r.caller.kind, "admin"); t.equal(r.caller.via, "apikey");
  r = await go("", { Authorization: `Bearer ${UPS}` }, { declaredFid: "0003" }); t.equal(r.caller.kind, "admin"); t.equal(r.caller.fid, "0003"); t.equal(r.caller.actingAs, true);
  r = await silentA(() => go("APIKEY=" + COMMISH, {})); t.equal(r.caller.kind, "admin");
  r = await go("APIKEY=" + UPS, {}); t.equal(r.ok, false); t.equal(r.http, 403, "the UPS key in the URL is a bad key");
  r = await go("APIKEY=" + MFLK, {}); t.equal(r.http, 403, "the MFL key was never a trade admin key");
  r = await go("APIKEY=" + WRONG + "&MFL_USER_ID=x", {}, { queryToken: "SYNTHETIC-owner" }); t.equal(r.ok, true); t.equal(r.caller.kind, "owner", "a foreign key beside an owner session is ignored, never an error");
  r = await go("", { "X-UPS-ADMIN-KEY": WRONG }); t.equal(r.http, 401);
  r = await go("", {}, { env: { COMMISH_API_KEY: COMMISH } }); t.equal(r.http, 401);
  r = await go("", { "X-UPS-ADMIN-KEY": UPS }, { env: { COMMISH_API_KEY: COMMISH } }); t.equal(r.http, 401, "UPS_ADMIN_KEY unset: header ignored");
  r = await silentA(() => TA.resolveTradeCaller({ url: urlOf(`L=${LEAGUE}&YEAR=2026&APIKEY=${COMMISH}`), env: envOf(), deps, defaultLeagueId: LEAGUE, defaultSeason: "2026" }));
  t.equal(r.caller.kind, "admin", "callers that pass no request (older code, tests) keep the query path");
});

// ═══════════════════════════ 7. structure: no new credential comparison outside the module ═══════════════════════════
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".js") ? [path.join(d, e.name)] : []));
const SRC = path.join(ROOT, "worker/src");
const codeLines = (f) => fs.readFileSync(f, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
const countBy = (re) => { const out = {}; for (const f of walk(SRC)) { const n = codeLines(f).filter((l) => re.test(l)).length; if (n) out[path.relative(SRC, f)] = n; } return out; };

// OUTGOING uses of the worker's own secrets (it presents them to MFL, or calls its own routes with them) and the legacy,
// not-yet-migrated incoming checks in index.js. A count may go DOWN freely (lower the number); it may never go UP, and a file not listed here
// may not mention these secrets at all. A new route that needs an admin credential must add a site to admin_secrets.js instead.
//   hall.js                    the message for a refused admin call (the comparison itself is in admin_secrets.js)
//   lineup_forfeit_reversal.js outgoing: MFL import key
//   trade_2way.js, trade_3way.js, trade_dm.js   outgoing: MFL import key / the worker's own self-calls
//   index.js                   outgoing MFL / self-call uses + the legacy in-route checks that are NOT yet migrated (see docs/UPS_ADMIN_KEY_MIGRATION.md §2b)
const SECRET_MENTION_BASELINE = { "admin_secrets.js": 3, "hall.js": 3, "index.js": 162, "lineup_forfeit_reversal.js": 1, "trade_2way.js": 6, "trade_3way.js": 8, "trade_dm.js": 1 };
const CRED_HEADER_BASELINE = { "admin_authority.js": 1, "admin_secrets.js": 8, "index.js": 17 };
const SESSION_BY_API_KEY_BASELINE = { "index.js": 65 };

test("structure: safeEqual( is called only inside admin_secrets.js", () => {
  t.deepEqual(Object.keys(countBy(/\bsafeEqual\s*\(/)), ["admin_secrets.js"]);
});
test("structure: no new reads of COMMISH_API_KEY / TEST_SYNC_API_KEY / MFL_APIKEY outside the allowlist (counts may only go down)", () => {
  const now = countBy(/\b(COMMISH_API_KEY|TEST_SYNC_API_KEY|MFL_APIKEY)\b/);
  for (const [f, n] of Object.entries(now)) {
    t.ok(Object.prototype.hasOwnProperty.call(SECRET_MENTION_BASELINE, f), `worker/src/${f} mentions an admin secret but is not on the allowlist — add a site to admin_secrets.js (or, if it is an OUTGOING use, add the file here with the reason)`);
    t.ok(n <= (SECRET_MENTION_BASELINE[f] || 0), `worker/src/${f}: ${n} mentions of an admin secret, baseline ${SECRET_MENTION_BASELINE[f]} — a new credential check belongs in admin_secrets.js`);
  }
});
test("structure: no new credential-header reads or `sessionByApiKey` gates (counts may only go down)", () => {
  const h = countBy(/X-Internal-Auth|X-COMMISH-APIKEY|X-MFL-APIKEY|X-UPS-ADMIN-KEY|bearerKey\s*\(|get\(\s*["']authorization["']\s*\)/i);
  for (const [f, n] of Object.entries(h)) t.ok(n <= (CRED_HEADER_BASELINE[f] || 0), `worker/src/${f}: ${n} credential-header reads, baseline ${CRED_HEADER_BASELINE[f] || 0}`);
  const s = countBy(/\bsessionByApiKey\b/);
  for (const [f, n] of Object.entries(s)) t.ok(n <= (SESSION_BY_API_KEY_BASELINE[f] || 0), `worker/src/${f}: ${n} sessionByApiKey uses, baseline ${SESSION_BY_API_KEY_BASELINE[f] || 0}`);
});
test("structure: every `site:` handed to matchAdminSecret exists in the table, and every table site is used by the worker", () => {
  const used = new Set();
  for (const f of walk(SRC)) {
    if (path.basename(f) === "admin_secrets.js") continue;
    const text = fs.readFileSync(f, "utf8");
    for (const m of text.matchAll(/matchAdminSecret\(\{[^}]*?site:\s*"([a-z0-9_]+)"/g)) used.add(m[1]);
  }
  for (const id of used) t.ok(AS.ADMIN_SECRET_SITES[id], `matchAdminSecret is called with an unknown site "${id}"`);
  for (const id of Object.keys(AS.ADMIN_SECRET_SITES)) t.ok(used.has(id), `site "${id}" is in the policy table but no worker code uses it`);
});
test("structure: this file and the policy module contain no credential-shaped value", () => {
  const me = fs.readFileSync(path.join(ROOT, "tests/admin_key_phase1.test.mjs"), "utf8");
  const stripped = me.replace(/SYNTHETIC-[A-Za-z0-9-]+/g, "");
  t.doesNotMatch(stripped, /APIKEY=[A-Za-z0-9_-]{20,}/);
  t.doesNotMatch(stripped, /[A-Za-z0-9+/_-]{40,}/);
  const mod = fs.readFileSync(path.join(SRC, "admin_secrets.js"), "utf8");
  t.doesNotMatch(mod, /[A-Za-z0-9+/_-]{40,}/, "no long token-like literal in the policy module");
});

await run("admin_key_phase1");
