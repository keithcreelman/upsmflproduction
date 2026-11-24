// UPS test deployment runtime (#1475). Runs ONLY when UPS_ENV is exactly "test" (entry.js).
// Production never loads any of this into its request path.
//
// Per request, in order (any failure refuses the request before the worker code runs):
//   1. configuration      testConfig(): test league only, no production credential names present
//   2. bindings           only D1 (each proven to be the test database by its marker row) and the
//                         static asset binding; no R2, KV, queues, Durable Objects or service bindings
//   3. outbound guard     the global fetch is wrapped: MFL only for the test league, no Discord
//                         except the configured test webhook, no GitHub/AI/other writes, no workers.dev
//   4. cache namespace    caches.default keys moved under this deployment's own prefix
//   5. inbound league     a request naming league 74598 anywhere, or any other league, is refused;
//                         the worker sees L pinned to the test league
//   6. credentials        write requests: the forwarded owner session and the test commissioner
//                         session must belong to the test league and NOT to league 74598 (MFL myleagues)
//   7. write ledger       write requests need an Idempotency-Key; intent is recorded before the worker
//                         runs, the outcome after; a repeat replays, an unknown outcome blocks retries
import * as G from "./ups_env_guard.js";
import { mflCookieHeader } from "./mfl_cookie.js";

const LEDGER_DDL = [
  `CREATE TABLE IF NOT EXISTS ups_test_write_ledger (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     idempotency_key TEXT NOT NULL UNIQUE,
     env TEXT NOT NULL DEFAULT 'test' CHECK (env = 'test'),
     league_id TEXT NOT NULL,
     method TEXT NOT NULL,
     path TEXT NOT NULL,
     query_redacted TEXT,
     request_sha256 TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('pending','responded','uncertain','failed','resolved_applied','resolved_not_applied')),
     http_status INTEGER,
     response_sha256 TEXT,
     response_body TEXT,
     response_content_type TEXT,
     egress_json TEXT,
     started_at TEXT NOT NULL,
     finished_at TEXT,
     resolution_note TEXT,
     resolved_at TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS ups_test_egress_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     env TEXT NOT NULL DEFAULT 'test' CHECK (env = 'test'),
     ts TEXT NOT NULL,
     idempotency_key TEXT,
     method TEXT,
     url_redacted TEXT,
     host TEXT,
     decision TEXT,
     kind TEXT,
     reason TEXT,
     status INTEGER,
     error TEXT
   )`,
];

const RESPONSE_BODY_CAP = 64 * 1024;
const MARKER_TTL_MS = 5 * 60 * 1000;
const CREDENTIAL_TTL_MS = 10 * 60 * 1000;
const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;

const state = {
  cfg: null,
  egress: [],                 // recent outbound decisions (redacted), newest last
  inflight: new Set(),        // idempotency keys of ledgered requests now running in this isolate
  markerOkUntil: 0,
  ledgerReady: false,
  credentials: new Map(),     // sha256(value) -> { until, verdict }
};

// Tests only: forget isolate state and unwrap fetch.
export function __resetTestRuntime() {
  const f = globalThis.fetch;
  if (f && f.__upsTestGuard) globalThis.fetch = f.__upsInner;
  state.cfg = null; state.egress = []; state.inflight = new Set(); state.markerOkUntil = 0; state.ledgerReady = false; state.credentials = new Map();
}
export function __egressEvents() { return state.egress.slice(); }

const nowIso = () => new Date().toISOString();

async function sha256hex(text) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text))));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  const x = String(a || ""), y = String(b || "");
  if (!x || !y || x.length !== y.length) return false;
  let r = 0;
  for (let i = 0; i < x.length; i++) r |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return r === 0;
}

function json(status, obj, cfg, extraHeaders) {
  const h = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" });
  h.set("x-ups-env", "test");
  if (cfg && cfg.league) h.set("x-ups-league", cfg.league);
  for (const [k, v] of Object.entries(extraHeaders || {})) h.set(k, v);
  return new Response(JSON.stringify(obj), { status, headers: h });
}

function stamp(res, cfg, extra) {
  if (!res || res.status === 101) return res;
  const out = new Response(res.body, res);
  out.headers.set("x-ups-env", "test");
  out.headers.set("x-ups-league", cfg.league);
  for (const [k, v] of Object.entries(extra || {})) out.headers.set(k, v);
  return out;
}

function record(ev) {
  state.egress.push(ev);
  if (state.egress.length > 500) state.egress.splice(0, state.egress.length - 500);
}

// ── 3. outbound guard ───────────────────────────────────────────────────────────────────────────
export function ensureEgressGuard(cfg) {
  state.cfg = cfg;
  const cur = globalThis.fetch;
  if (cur && cur.__upsTestGuard) return true;
  const inner = cur;
  const guarded = async function upsTestGuardedFetch(input, init) {
    const url = typeof input === "string" ? input : (input instanceof URL ? input.toString() : String((input && input.url) || input));
    const method = String((init && init.method) || (input && typeof input === "object" && input.method) || "GET").toUpperCase();
    const bodyText = await G.bodyTextOf(input, init);
    const d = G.egressDecision({ url, method, bodyText }, state.cfg || cfg);
    const ev = { ts: Date.now(), method, url: G.redactUrl(url), host: d.host || "", decision: d.allow ? "allow" : "refuse", kind: d.kind || "", reason: d.reason || "", requests: [...state.inflight] };
    record(ev);
    if (!d.allow) {
      console.log(`[ups-env=test] outbound REFUSED ${method} ${ev.url} (${d.reason})`);
      return new Response(JSON.stringify({ ok: false, error: "ups_test_egress_refused", reason: d.reason }), { status: 403, headers: { "content-type": "application/json", "x-ups-egress": "refused" } });
    }
    try {
      const r = await inner(input, init);
      ev.status = r && r.status;
      if (d.kind === "mfl_write" && r && r.status >= 500) ev.uncertain = true;   // MFL may have applied it
      return r;
    } catch (e) {
      ev.error = String((e && e.message) || e).slice(0, 200);
      if (d.kind === "mfl_write") ev.uncertain = true;                           // lost answer: outcome unknown
      throw e;
    }
  };
  guarded.__upsTestGuard = true;
  guarded.__upsInner = inner;
  globalThis.fetch = guarded;
  return globalThis.fetch === guarded;
}

// ── 4. cache namespace ──────────────────────────────────────────────────────────────────────────
export function ensureCacheNamespace(prefix) {
  if (typeof caches === "undefined" || !caches || !caches.default) return { ok: true, active: false, note: "no cache API in this runtime" };
  const c = caches.default;
  if (c.__upsNs === prefix) return { ok: true, active: true };
  if (c.__upsNs) return { ok: false, active: true, note: "cache already namespaced for another deployment" };
  try {
    const m = c.match.bind(c), p = c.put.bind(c), d = c.delete.bind(c);
    c.match = (k, o) => m(G.namespacedCacheKey(k, prefix), o);
    c.put = (k, r) => p(G.namespacedCacheKey(k, prefix), r);
    c.delete = (k, o) => d(G.namespacedCacheKey(k, prefix), o);
    c.__upsNs = prefix;
  } catch (_) { /* reported below */ }
  return { ok: c.__upsNs === prefix, active: true };
}

// ── 2. test database marker ─────────────────────────────────────────────────────────────────────
async function verifyMarkers(env, inv, cfg, force) {
  if (!force && state.markerOkUntil > Date.now()) return { ok: true, cached: true };
  const per = {};
  for (const name of inv.d1) {
    let rows;
    try { rows = (await env[name].prepare(G.MARKER_SQL).all()).results; } catch (_) { per[name] = "marker_unreadable"; return { ok: false, binding: name, reason: "marker_unreadable", per }; }
    const v = G.markerVerdict(rows, cfg.league);
    per[name] = v.ok ? "ok" : v.reason;
    if (!v.ok) return { ok: false, binding: name, reason: v.reason, per };
  }
  state.markerOkUntil = Date.now() + MARKER_TTL_MS;
  return { ok: true, per };
}

// ── 6. credentials ──────────────────────────────────────────────────────────────────────────────
async function checkCredential(raw, cfg) {
  const header = mflCookieHeader(raw);
  if (!header) return { ok: false, reason: "credential_missing" };
  const key = await sha256hex(header);
  const hit = state.credentials.get(key);
  if (hit && hit.until > Date.now()) return hit.verdict;
  let leagues = null;
  try {
    const r = await globalThis.fetch(`https://api.myfantasyleague.com/${cfg.season}/export?TYPE=myleagues&JSON=1`,
      { headers: { Cookie: header, "User-Agent": "ups-test-env-guard" } });
    if (r && r.ok) leagues = G.leaguesFromMyleagues(await r.json());
  } catch (_) { leagues = null; }
  const verdict = G.credentialVerdict(leagues, cfg);
  if (verdict.ok || verdict.reason !== "credential_unverified") state.credentials.set(key, { until: Date.now() + CREDENTIAL_TTL_MS, verdict });
  return verdict;
}

// ── 7. write ledger ─────────────────────────────────────────────────────────────────────────────
function ledgerDb(env, inv) { return env.UPS_MFL_DB && inv.d1.includes("UPS_MFL_DB") ? env.UPS_MFL_DB : env[inv.d1[0]]; }

async function ensureLedger(db) {
  if (state.ledgerReady) return;
  for (const ddl of LEDGER_DDL) await db.prepare(ddl).run();
  state.ledgerReady = true;
}

async function writeEgressRows(db, key, events) {
  const rows = events.filter((e) => key ? (e.requests || []).includes(key) : e.decision === "refuse");
  if (!rows.length) return;
  const stmts = rows.slice(0, 50).map((e) => db.prepare(
    "INSERT INTO ups_test_egress_log (env, ts, idempotency_key, method, url_redacted, host, decision, kind, reason, status, error) VALUES ('test', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(new Date(e.ts).toISOString(), key || null, e.method, e.url, e.host, e.decision, e.kind, e.reason, e.status == null ? null : e.status, e.error || null));
  await db.batch(stmts);
}

async function runLedgered({ request, pinnedUrl, bodyBuf, bodyText, env, ctx, app, cfg, inv, autoKey }) {
  const db = ledgerDb(env, inv);
  const u = new URL(pinnedUrl);
  let key = String(request.headers.get("Idempotency-Key") || "").trim();
  if (!key) {
    if (!autoKey) return json(428, { ok: false, error: "idempotency_key_required", detail: "write requests to the test deployment need an Idempotency-Key header (8-128 of A-Z a-z 0-9 . _ : -)" }, cfg);
    key = `auto-${crypto.randomUUID()}`;
  }
  if (!KEY_RE.test(key)) return json(400, { ok: false, error: "idempotency_key_invalid" }, cfg);
  const reqHash = await sha256hex(`${request.method}\n${u.pathname}\n${u.search}\n${bodyText}`);
  try { await ensureLedger(db); } catch (_) { return json(503, { ok: false, error: "ledger_unavailable" }, cfg); }

  const prior = await db.prepare("SELECT * FROM ups_test_write_ledger WHERE idempotency_key = ?").bind(key).first().catch(() => undefined);
  if (prior === undefined) return json(503, { ok: false, error: "ledger_unavailable" }, cfg);
  if (prior) {
    if (prior.request_sha256 !== reqHash) return json(422, { ok: false, error: "idempotency_key_reused_with_different_request", idempotency_key: key }, cfg);
    if (prior.state === "responded") {
      return new Response(prior.response_body || "", { status: prior.http_status || 200, headers: {
        "content-type": prior.response_content_type || "application/json", "cache-control": "no-store", "access-control-allow-origin": "*",
        "x-ups-env": "test", "x-ups-league": cfg.league, "x-ups-idempotent-replay": "1", "x-ups-ledger-state": prior.state } });
    }
    const why = {
      pending: "a request with this key is still running or never finished; its outcome is unknown",
      uncertain: "the previous attempt's MFL answer was lost or failed; MFL may have applied it",
      failed: "the previous attempt failed before any MFL write; send a new Idempotency-Key to try again",
      resolved_applied: "the previous attempt was confirmed applied in MFL; nothing to retry",
      resolved_not_applied: "the previous attempt was confirmed NOT applied in MFL; send a new Idempotency-Key to try again",
    }[prior.state] || "unknown ledger state";
    return json(409, { ok: false, error: "prior_attempt_not_retryable", ledger_state: prior.state, detail: why,
      next_step: (prior.state === "pending" || prior.state === "uncertain") ? `read league ${cfg.league}'s MFL transactions and rosters, then POST /__test-env/ledger/resolve` : undefined,
      idempotency_key: key }, cfg);
  }
  try {
    await db.prepare(`INSERT INTO ups_test_write_ledger (idempotency_key, env, league_id, method, path, query_redacted, request_sha256, state, started_at)
                      VALUES (?, 'test', ?, ?, ?, ?, ?, 'pending', ?)`)
      .bind(key, cfg.league, request.method, u.pathname, G.redactUrl(pinnedUrl).replace(/^[^?]*/, ""), reqHash, nowIso()).run();
  } catch (_) {
    return json(409, { ok: false, error: "prior_attempt_not_retryable", ledger_state: "pending", detail: "another request with this key started first", idempotency_key: key }, cfg);
  }

  state.inflight.add(key);
  let res = null, threw = null;
  try {
    const req = new Request(pinnedUrl, { method: request.method, headers: request.headers, body: bodyBuf && bodyBuf.byteLength ? bodyBuf : undefined, redirect: "manual" });
    res = await app.fetch(req, G.deriveTestEnv(env, cfg), ctx);
  } catch (e) { threw = e; }
  state.inflight.delete(key);

  const events = state.egress.filter((e) => (e.requests || []).includes(key));
  const mflWrites = events.filter((e) => e.kind === "mfl_write");
  const uncertain = events.some((e) => e.uncertain) || (!!threw && mflWrites.length > 0);
  let bodyOut = "", ctype = "";
  if (res) { ctype = res.headers.get("content-type") || ""; try { bodyOut = await res.clone().text(); } catch (_) { bodyOut = ""; } }
  const finalState = uncertain ? "uncertain" : (threw ? "failed" : "responded");
  const egressSummary = events.map((e) => ({ method: e.method, url: e.url, decision: e.decision, kind: e.kind, reason: e.reason, status: e.status, error: e.error, uncertain: !!e.uncertain }));
  let recorded = true;
  try {
    await db.prepare(`UPDATE ups_test_write_ledger SET state = ?, http_status = ?, response_sha256 = ?, response_body = ?, response_content_type = ?, egress_json = ?, finished_at = ?
                      WHERE idempotency_key = ?`)
      .bind(finalState, res ? res.status : null, await sha256hex(bodyOut), bodyOut.length <= RESPONSE_BODY_CAP ? bodyOut : null, ctype, JSON.stringify(egressSummary).slice(0, RESPONSE_BODY_CAP), nowIso(), key).run();
    await writeEgressRows(db, key, events);
  } catch (_) { recorded = false; }
  const extra = { "x-ups-idempotency-key": key, "x-ups-ledger-state": finalState, ...(recorded ? {} : { "x-ups-ledger": "unrecorded" }) };
  if (!res) return json(uncertain ? 502 : 500, { ok: false, error: uncertain ? "outcome_unknown_check_mfl" : "worker_error", ledger_state: finalState, idempotency_key: key }, cfg, extra);
  return stamp(new Response(bodyOut, res), cfg, extra);
}

// ── internal routes ─────────────────────────────────────────────────────────────────────────────
function adminOk(request, env) {
  return timingSafeEqual(request.headers.get("x-ups-test-admin-key"), env.TEST_ADMIN_API_KEY);
}

async function ownerContacts(cfg) {
  const header = mflCookieHeader(state.envCommish || "");
  if (!header) return { ok: false, reason: "no commissioner session" };
  try {
    const r = await globalThis.fetch(`https://www48.myfantasyleague.com/${cfg.season}/export?TYPE=league&L=${cfg.league}&JSON=1`, { headers: { Cookie: header, "User-Agent": "ups-test-env-guard" } });
    if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
    const j = await r.json();
    let fr = j && j.league && j.league.franchises && j.league.franchises.franchise;
    if (!fr) return { ok: false, reason: "no franchises in league export" };
    if (!Array.isArray(fr)) fr = [fr];
    const out = [];
    for (const f of fr) {
      const email = String((f && f.email) || "").trim().toLowerCase();
      // Never the address itself: whether one is on file, how many, and a short fingerprint Keith can compare.
      const list = email ? email.split(/[,;\s]+/).filter(Boolean) : [];
      out.push({ franchise_id: f.id, email_on_file: list.length > 0, email_count: list.length, email_sha256_8: await Promise.all(list.map(async (e) => (await sha256hex(e)).slice(0, 8))) });
    }
    return { ok: true, franchises: out };
  } catch (e) { return { ok: false, reason: String((e && e.message) || e).slice(0, 120) }; }
}

async function internalRoute(path, request, env, cfg, inv) {
  if (path === "/__test-env/status") {
    const marker = await verifyMarkers(env, inv, cfg, false);
    return json(200, {
      ok: true, env: "test", league: cfg.league, write_leagues: cfg.writeLeagues, guard_version: G.GUARD_VERSION,
      release_sha: String(env.UPS_RELEASE_SHA || ""), bindings: inv.bindings, database_marker: marker.ok ? "ok" : marker.reason,
      egress_guard: !!(globalThis.fetch && globalThis.fetch.__upsTestGuard), cache_namespace: (typeof caches !== "undefined" && caches && caches.default && caches.default.__upsNs) || "no cache API",
      discord: cfg.testWebhookUrl ? "test webhook only" : "refused (no test webhook configured)",
      forbidden_credentials_present: [],   // testConfig refused the request otherwise
    }, cfg);
  }
  if (!adminOk(request, env)) return json(403, { ok: false, error: "test_admin_key_required" }, cfg);
  if (path === "/__test-env/verify") {
    const marker = await verifyMarkers(env, inv, cfg, true);
    const commish = await checkCredential(env.MFLTEST_COMMISHCOOKIE, cfg);
    const probes = [];
    for (const [label, url, init] of [
      ["discord bot API", "https://discord.com/api/v10/channels/1059111651846131833/messages", { method: "POST", body: "{}" }],
      ["production league read", `https://api.myfantasyleague.com/${cfg.season}/export?TYPE=rosters&L=${G.PRODUCTION_LEAGUE_ID}&JSON=1`, {}],
      ["production league import", `https://www48.myfantasyleague.com/${cfg.season}/import?TYPE=fcfsWaiver&JSON=1`, { method: "POST", body: `L=${G.PRODUCTION_LEAGUE_ID}&ADD=1` }],
      ["GitHub dispatch", "https://api.github.com/repos/keithcreelman/upsmflproduction/dispatches", { method: "POST", body: "{}" }],
      ["production worker", "https://upsmflproduction.keith-creelman.workers.dev/api/health", {}],
    ]) {
      const r = await globalThis.fetch(url, init);
      probes.push({ probe: label, refused: r.headers.get("x-ups-egress") === "refused", status: r.status });
    }
    const contacts = new URL(request.url).searchParams.get("owner_contacts") === "1" ? await (async () => { state.envCommish = env.MFLTEST_COMMISHCOOKIE; const c = await ownerContacts(cfg); state.envCommish = ""; return c; })() : undefined;
    return json(200, {
      ok: marker.ok && commish.ok && probes.every((p) => p.refused),
      league: cfg.league, database_marker: marker, commissioner_session: commish, egress_probes: probes,
      bindings: inv.bindings, cache_namespace: (typeof caches !== "undefined" && caches && caches.default && caches.default.__upsNs) || "no cache API",
      ...(contacts ? { owner_contacts: contacts } : {}),
    }, cfg);
  }
  if (path === "/__test-env/ledger" && request.method === "GET") {
    const db = ledgerDb(env, inv); await ensureLedger(db);
    const key = new URL(request.url).searchParams.get("key") || "";
    const row = await db.prepare("SELECT * FROM ups_test_write_ledger WHERE idempotency_key = ?").bind(key).first();
    return json(row ? 200 : 404, { ok: !!row, row: row || null }, cfg);
  }
  if (path === "/__test-env/ledger/resolve" && request.method === "POST") {
    let b = {}; try { b = await request.json(); } catch (_) { b = {}; }
    const outcome = b.outcome === "applied" ? "resolved_applied" : (b.outcome === "not_applied" ? "resolved_not_applied" : "");
    const evidence = String(b.evidence || "").trim();
    if (!outcome || !KEY_RE.test(String(b.idempotency_key || "")) || evidence.length < 10) return json(400, { ok: false, error: "need idempotency_key, outcome (applied|not_applied) and evidence (what was read from MFL)" }, cfg);
    const db = ledgerDb(env, inv); await ensureLedger(db);
    const r = await db.prepare("UPDATE ups_test_write_ledger SET state = ?, resolution_note = ?, resolved_at = ? WHERE idempotency_key = ? AND state IN ('pending','uncertain')")
      .bind(outcome, evidence.slice(0, 2000), nowIso(), b.idempotency_key).run();
    const changed = Number((r && r.meta && r.meta.changes) || 0);
    return json(changed ? 200 : 409, { ok: !!changed, state: changed ? outcome : undefined, error: changed ? undefined : "not_pending_or_uncertain" }, cfg);
  }
  return json(404, { ok: false, error: "unknown_test_env_route" }, cfg);
}

// ── the request path ────────────────────────────────────────────────────────────────────────────
export async function handleTestFetch(request, env, ctx, app) {
  const cfg = G.testConfig(env);
  if (!cfg.ok) {
    console.log(`[ups-env=test] REFUSED: misconfigured (${cfg.errors.join("; ")})`);
    return json(503, { ok: false, error: "test_env_misconfigured", problems: cfg.errors }, null);
  }
  const inv = G.inspectBindings(env);
  if (!inv.ok) return json(503, { ok: false, error: "test_env_bindings_refused", problems: inv.problems }, cfg);
  if (!ensureEgressGuard(cfg)) return json(503, { ok: false, error: "egress_guard_not_installed" }, cfg);
  const ns = ensureCacheNamespace(`ups-test-${cfg.league}`);
  if (!ns.ok) return json(503, { ok: false, error: "cache_namespace_not_installed", detail: ns.note || "" }, cfg);
  const marker = await verifyMarkers(env, inv, cfg, false);
  if (!marker.ok) return json(503, { ok: false, error: "test_database_unverified", binding: marker.binding, reason: marker.reason }, cfg);

  const url = new URL(request.url);
  if (request.method === "OPTIONS") return app.fetch(request, G.deriveTestEnv(env, cfg), ctx).then((r) => stamp(r, cfg));
  if (url.pathname.startsWith("/__test-env/")) return internalRoute(url.pathname, request, env, cfg, inv);
  if (url.pathname.startsWith("/discord/")) return json(403, { ok: false, error: "discord_interactions_disabled_in_test" }, cfg);

  const write = G.isWriteMethod(request.method);
  let bodyBuf = null, bodyText = "";
  if (write) {
    try { bodyBuf = await request.clone().arrayBuffer(); bodyText = new TextDecoder().decode(bodyBuf); } catch (_) { return json(400, { ok: false, error: "unreadable_body" }, cfg); }
  }
  const dec = G.inboundDecision({ url: request.url, method: request.method, bodyText, contentType: request.headers.get("content-type") }, cfg);
  if (!dec.ok) {
    console.log(`[ups-env=test league=${cfg.league}] ${request.method} ${url.pathname} REFUSED ${dec.error}`);
    return json(dec.status, { ok: false, error: dec.error, detail: dec.detail, claims: dec.claims }, cfg);
  }

  const ledgered = write || url.pathname.startsWith("/admin/");
  if (ledgered) {
    for (const cred of G.viewerCredentials(request, request.url, bodyText)) {
      const v = await checkCredential(cred, cfg);
      if (!v.ok) return json(403, { ok: false, error: v.reason, detail: "the forwarded MFL session must be a test-league account that is not a member of the production league" }, cfg);
    }
    const commish = await checkCredential(env.MFLTEST_COMMISHCOOKIE, cfg);
    if (!commish.ok) return json(503, { ok: false, error: `commissioner_${commish.reason}`, detail: "MFLTEST_COMMISHCOOKIE must be the dedicated test account's session" }, cfg);
    const res = await runLedgered({ request, pinnedUrl: dec.url, bodyBuf, bodyText, env, ctx, app, cfg, inv, autoKey: !write });
    console.log(`[ups-env=test league=${cfg.league}] ${request.method} ${url.pathname} -> ${res.status} ledger=${res.headers.get("x-ups-ledger-state") || "-"}`);
    return res;
  }

  const req = new Request(dec.url, { method: request.method, headers: request.headers, redirect: "manual" });
  const before = state.egress.length;
  const res = await app.fetch(req, G.deriveTestEnv(env, cfg), ctx);
  const refusedNow = state.egress.slice(before).filter((e) => e.decision === "refuse");
  if (refusedNow.length && ctx && typeof ctx.waitUntil === "function") {
    const db = ledgerDb(env, inv);
    ctx.waitUntil(ensureLedger(db).then(() => writeEgressRows(db, null, refusedNow)).catch(() => {}));
  }
  console.log(`[ups-env=test league=${cfg.league}] ${request.method} ${url.pathname} -> ${res.status}`);
  return stamp(res, cfg);
}

export async function handleTestScheduled(event, env) {
  // A test deployment has no cron triggers; if one is ever added by mistake, nothing runs.
  console.log(`[ups-env=test league=${String((env && env.LEAGUE_ID) || "")}] scheduled run REFUSED: test deployments run no jobs`);
}
