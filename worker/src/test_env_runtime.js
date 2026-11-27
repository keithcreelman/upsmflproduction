// UPS test deployment runtime (#1475). Loaded ONLY by entry_test_env.js (wrangler.test.toml), and run only
// when UPS_ENV is exactly "test". The production entry (entry.js) never imports this file.
//
// Per request, in order (any failure refuses the request before the worker code runs):
//   1. configuration      testConfig(): test league only, no production credential names present
//   2. bindings           only D1 (each proven to be the test database by its marker row) and the
//                         static asset binding; no R2, KV, queues, Durable Objects or service bindings
//   3. outbound guard     the global fetch is wrapped: every hop of every call (redirects included) is
//                         decided again; MFL only for the test league and MFL writes only inside a
//                         ledgered request; no Discord except the test webhook; no other writes
//   4. cache namespace    caches.default keys moved under this deployment's own prefix
//   5. inbound league     a request naming league 74598 anywhere, or any other league, is refused;
//                         the worker sees L pinned to the test league
//   6. credentials        write requests: the forwarded owner session and the test commissioner
//                         session must belong to the test league and NOT to league 74598 (MFL myleagues)
//   7. write ledger       write requests need an Idempotency-Key. Each request runs in its OWN context
//                         (AsyncLocalStorage), so every outbound call, including ones made later from
//                         ctx.waitUntil, is attributed to exactly one request. The ledger is final only
//                         after that request's background work has finished. An operation (and each MFL
//                         write) whose outcome is unknown stays locked, under any key, until resolved.
import { AsyncLocalStorage } from "node:async_hooks";
import * as G from "./ups_env_guard.js";
import { mflCookieHeader } from "./mfl_cookie.js";

const LEDGER_DDL = [
  `CREATE TABLE IF NOT EXISTS ups_test_write_ledger (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     idempotency_key TEXT NOT NULL UNIQUE,
     operation_sha256 TEXT NOT NULL,
     env TEXT NOT NULL DEFAULT 'test' CHECK (env = 'test'),
     league_id TEXT NOT NULL,
     method TEXT NOT NULL,
     path TEXT NOT NULL,
     query_redacted TEXT,
     request_sha256 TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('pending','background','responded','uncertain','failed','resolved_applied','resolved_not_applied')),
     http_status INTEGER,
     response_sha256 TEXT,
     response_body TEXT,
     response_content_type TEXT,
     egress_json TEXT,
     background_tasks INTEGER,
     background_timed_out INTEGER,
     started_at TEXT NOT NULL,
     responded_at TEXT,
     finished_at TEXT,
     resolution_note TEXT,
     resolved_at TEXT
   )`,
  // One row per operation whose outcome is not yet known. The PRIMARY KEY is the atomic lock: a second
  // send of the same operation, under any idempotency key, can't insert it and is refused.
  `CREATE TABLE IF NOT EXISTS ups_test_open_operations (
     operation_sha256 TEXT PRIMARY KEY,
     idempotency_key TEXT NOT NULL,
     env TEXT NOT NULL DEFAULT 'test' CHECK (env = 'test'),
     opened_at TEXT NOT NULL
   )`,
  // The same lock one level down, per MFL write as MFL would see it, so a different route or body
  // that produces the same MFL write is refused too.
  `CREATE TABLE IF NOT EXISTS ups_test_open_mfl_writes (
     write_sha256 TEXT PRIMARY KEY,
     idempotency_key TEXT NOT NULL,
     env TEXT NOT NULL DEFAULT 'test' CHECK (env = 'test'),
     url_redacted TEXT,
     opened_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS ups_test_egress_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     env TEXT NOT NULL DEFAULT 'test' CHECK (env = 'test'),
     ts TEXT NOT NULL,
     idempotency_key TEXT,
     request_id TEXT,
     phase TEXT,
     hop INTEGER,
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
let BACKGROUND_TIMEOUT_MS = 20 * 1000;   // below the platform's waitUntil limit; past it the outcome is "uncertain"

const als = new AsyncLocalStorage();

const state = {
  cfg: null,
  recent: [],                 // last outbound decisions in this isolate (redacted), for status/debugging only
  markerOkUntil: 0,
  ledgerReady: false,
  credentials: new Map(),     // sha256(value) -> { until, verdict }
};

// Tests only.
export function __resetTestRuntime() {
  const f = globalThis.fetch;
  if (f && f.__upsTestGuard) globalThis.fetch = f.__upsInner;
  state.cfg = null; state.recent = []; state.markerOkUntil = 0; state.ledgerReady = false; state.credentials = new Map();
  BACKGROUND_TIMEOUT_MS = 20 * 1000;
}
export function __setBackgroundTimeoutMs(ms) { BACKGROUND_TIMEOUT_MS = ms; }

const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function refusedResponse(reason) {
  return new Response(JSON.stringify({ ok: false, error: "ups_test_egress_refused", reason }), { status: 403, headers: { "content-type": "application/json", "x-ups-egress": "refused" } });
}

// ── request context ─────────────────────────────────────────────────────────────────────────────
function newContext(kind, cfg, db, key) {
  return { id: crypto.randomUUID(), kind, cfg, db, key: key || null, events: [], background: [], finalized: false, phase: "response", openWrites: [], writeAttempts: {} };
}

// The ctx the worker code sees: every waitUntil promise is tracked for its request.
function trackingCtx(ctx, rc) {
  return {
    waitUntil(p) { const pp = Promise.resolve(p); rc.background.push(pp); if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(pp.catch(() => {})); },
    passThroughOnException() { if (ctx && typeof ctx.passThroughOnException === "function") ctx.passThroughOnException(); },
    props: ctx && ctx.props,
  };
}

// Wait for a request's background work, including work that background work itself schedules.
async function settleBackground(rc) {
  const deadline = Date.now() + BACKGROUND_TIMEOUT_MS;
  let seen = 0;
  rc.phase = "background";
  while (seen < rc.background.length) {
    const batch = rc.background.slice(seen);
    seen = rc.background.length;
    const left = deadline - Date.now();
    const done = await Promise.race([Promise.allSettled(batch).then(() => true), sleep(Math.max(0, left)).then(() => false)]);
    if (!done) { rc.timedOut = true; break; }
  }
  rc.finalized = true;   // from here on this request's context may make no outbound call
}

function record(rc, ev) {
  if (rc) rc.events.push(ev);
  state.recent.push(ev);
  if (state.recent.length > 200) state.recent.splice(0, state.recent.length - 200);
}

// ── 3. outbound guard ───────────────────────────────────────────────────────────────────────────
async function normalizeFetch(input, init) {
  const isReq = typeof Request !== "undefined" && input instanceof Request;
  const url = typeof input === "string" ? input : (input instanceof URL ? input.toString() : String((input && input.url) || input));
  const method = String((init && init.method) || (isReq ? input.method : "GET")).toUpperCase();
  const headers = new Headers(isReq ? input.headers : undefined);
  if (init && init.headers) for (const [k, v] of new Headers(init.headers)) headers.set(k, v);
  const bodyText = await G.bodyTextOf(input, init);
  let body;
  if (init && Object.prototype.hasOwnProperty.call(init, "body") && init.body != null) body = init.body;
  else if (isReq && input.body) body = bodyText;
  const redirect = String((init && init.redirect) || (isReq ? input.redirect : "") || "follow");
  return { url, method, headers, body, bodyText, redirect, signal: init && init.signal };
}

export function ensureEgressGuard(cfg) {
  state.cfg = cfg;
  const cur = globalThis.fetch;
  if (cur && cur.__upsTestGuard) return true;
  const inner = cur;
  const guarded = async function upsTestGuardedFetch(input, init) {
    const rc = als.getStore() || null;
    const n = await normalizeFetch(input, init);
    let { url, method, headers, body, bodyText } = n;
    let writeOpened = false, writeSha = null;
    for (let hop = 0; hop <= G.MAX_REDIRECT_HOPS; hop++) {
      const d = G.egressDecision({ url, method, bodyText: body === undefined ? "" : bodyText }, state.cfg || cfg);
      const ev = { ts: Date.now(), request_id: rc ? rc.id : null, phase: rc ? rc.phase : "none", hop, method, url: G.redactUrl(url), host: d.host || "", decision: d.allow ? "allow" : "refuse", kind: d.kind || "", reason: d.reason || "" };
      const refuse = (reason) => { ev.decision = "refuse"; ev.reason = reason; record(rc, ev); console.log(`[ups-env=test] outbound REFUSED ${method} ${ev.url} (${reason})`); return refusedResponse(reason); };
      if (!d.allow) return refuse(d.reason);
      if (rc && rc.finalized) {
        // Work that outlived its request's ledger (a timed-out waitUntil) may not call out. The refusal is
        // logged directly, since that request's ledger row is already final.
        const resp = refuse("request_context_finalized");
        if (rc.db) await writeEgressRows(rc.db, rc.key, [{ ...ev, phase: "after_finalize" }]).catch(() => {});
        return resp;
      }
      if (d.kind === "mfl_write") {
        if (!rc || rc.kind !== "ledgered") return refuse("mfl_write_outside_ledgered_request");
        if (!writeOpened) {
          // One open-write lock per MFL write; a second identical write while this one is unresolved is refused.
          const sha = await sha256hex(G.mflWriteIdentity({ url, bodyText }));
          ev.write = sha; writeSha = sha;
          const mine = rc.writeAttempts[sha];
          if (mine === "uncertain") return refuse("mfl_write_retry_after_uncertain");
          // Review round 3: the same MFL write may be sent at most once per request, whatever the first answer was. Worker
          // retries (e.g. trade post-processing re-sending a salaryAdj/salaries import as GET after a verification miss)
          // would otherwise re-apply an APPENDING import after a known success. Redirect hops of one call don't reach here.
          if (mine) return refuse("mfl_write_duplicate_in_request");
          try {
            await rc.db.prepare("INSERT INTO ups_test_open_mfl_writes (write_sha256, idempotency_key, env, url_redacted, opened_at) VALUES (?, ?, 'test', ?, ?)").bind(sha, rc.key, ev.url, nowIso()).run();
          } catch (_) {
            const holder = await rc.db.prepare("SELECT idempotency_key FROM ups_test_open_mfl_writes WHERE write_sha256 = ?").bind(sha).first().catch(() => null);
            return refuse(holder ? `mfl_write_unresolved:${holder.idempotency_key}` : "mfl_write_lock_unavailable");
          }
          rc.openWrites.push(sha); rc.writeAttempts[sha] = "sent";
          writeOpened = true;
        }
      }
      if (writeSha) ev.write = writeSha;
      record(rc, ev);
      let r;
      try {
        r = await inner(url, { method, headers, body: body === undefined ? undefined : body, redirect: "manual", signal: n.signal });
      } catch (e) {
        ev.error = String((e && e.message) || e).slice(0, 200);
        if (d.kind === "mfl_write") { ev.uncertain = true; if (ev.write) rc.writeAttempts[ev.write] = "uncertain"; }   // lost answer: MFL may have applied it
        throw e;
      }
      ev.status = r && r.status;
      const loc = r && r.status >= 300 && r.status < 400 && r.headers && r.headers.get ? r.headers.get("location") : null;
      if (!loc) {
        if (d.kind === "mfl_write" && r && r.status >= 500) { ev.uncertain = true; if (ev.write) rc.writeAttempts[ev.write] = "uncertain"; }
        return r;
      }
      if (n.redirect === "manual") return r;   // the caller sees the 3xx; its next fetch is checked again
      if (n.redirect === "error") throw new TypeError(`redirect refused (redirect: "error") from ${ev.url}`);
      const nx = G.redirectHop({ url, method, status: r.status, location: loc, headers });
      if (nx.error) return refuse(nx.error);
      if (nx.keepBody && body !== undefined && bodyText == null) return refuse("redirect_body_not_replayable");
      url = nx.url; method = nx.method; headers = nx.headers;
      if (!nx.keepBody) { body = undefined; bodyText = ""; }
    }
    return (() => { const ev = { ts: Date.now(), request_id: rc ? rc.id : null, method, url: G.redactUrl(url), decision: "refuse", reason: "too_many_redirects" }; record(rc, ev); return refusedResponse("too_many_redirects"); })();
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
  if (!events.length) return;
  for (let i = 0; i < events.length; i += 50) {
    await db.batch(events.slice(i, i + 50).map((e) => db.prepare(
      "INSERT INTO ups_test_egress_log (env, ts, idempotency_key, request_id, phase, hop, method, url_redacted, host, decision, kind, reason, status, error) VALUES ('test', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(new Date(e.ts).toISOString(), key || null, e.request_id || null, e.phase || null, e.hop == null ? null : e.hop, e.method, e.url, e.host || "", e.decision, e.kind || "", e.reason || "", e.status == null ? null : e.status, e.error || null)));
  }
}

const OPEN_STATES = new Set(["pending", "background", "uncertain"]);

async function finalizeLedger(db, rc, res, bodyOut, ctype, threw) {
  const events = rc.events;
  const mflWrites = events.filter((e) => e.kind === "mfl_write" && e.decision === "allow");
  const uncertain = events.some((e) => e.uncertain) || (!!threw && mflWrites.length > 0) || (!!rc.timedOut);
  const finalState = uncertain ? "uncertain" : (threw ? "failed" : "responded");
  const egressSummary = events.map((e) => ({ phase: e.phase, hop: e.hop, method: e.method, url: e.url, decision: e.decision, kind: e.kind, reason: e.reason, status: e.status, error: e.error, uncertain: !!e.uncertain }));
  await db.prepare(`UPDATE ups_test_write_ledger SET state = ?, http_status = ?, response_sha256 = ?, response_body = ?, response_content_type = ?, egress_json = ?,
                    background_tasks = ?, background_timed_out = ?, finished_at = ? WHERE idempotency_key = ?`)
    .bind(finalState, res ? res.status : null, await sha256hex(bodyOut), bodyOut.length <= RESPONSE_BODY_CAP ? bodyOut : null, ctype,
      JSON.stringify(egressSummary).slice(0, RESPONSE_BODY_CAP), rc.background.length, rc.timedOut ? 1 : 0, nowIso(), rc.key).run();
  await writeEgressRows(db, rc.key, events);
  if (!uncertain) {
    // A known outcome releases the operation and its MFL writes; an unknown one keeps both locked.
    const stmts = [db.prepare("DELETE FROM ups_test_open_operations WHERE idempotency_key = ?").bind(rc.key)];
    for (const sha of rc.openWrites) stmts.push(db.prepare("DELETE FROM ups_test_open_mfl_writes WHERE write_sha256 = ? AND idempotency_key = ?").bind(sha, rc.key));
    await db.batch(stmts);
  }
  return finalState;
}

async function runLedgered({ request, pinnedUrl, bodyBuf, bodyText, env, ctx, app, cfg, inv, autoKey, credentialHashes }) {
  const db = ledgerDb(env, inv);
  const u = new URL(pinnedUrl);
  let key = String(request.headers.get("Idempotency-Key") || "").trim();
  if (!key) {
    if (!autoKey) return json(428, { ok: false, error: "idempotency_key_required", detail: "write requests to the test deployment need an Idempotency-Key header (8-128 of A-Z a-z 0-9 . _ : -)" }, cfg);
    key = `auto-${crypto.randomUUID()}`;
  }
  if (!KEY_RE.test(key)) return json(400, { ok: false, error: "idempotency_key_invalid" }, cfg);
  const reqHash = await sha256hex(`${request.method}\n${u.pathname}\n${u.search}\n${bodyText}`);
  const opHash = await sha256hex(G.operationIdentity({ method: request.method, url: pinnedUrl, bodyText, credentialHashes }));
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
      background: "the request answered but its background work has not finished; its outcome is not final",
      uncertain: "the previous attempt's MFL answer was lost or failed; MFL may have applied it",
      failed: "the previous attempt failed before any MFL write; send a new Idempotency-Key to try again",
      resolved_applied: "the previous attempt was confirmed applied in MFL; nothing to retry",
      resolved_not_applied: "the previous attempt was confirmed NOT applied in MFL; send a new Idempotency-Key to try again",
    }[prior.state] || "unknown ledger state";
    return json(409, { ok: false, error: "prior_attempt_not_retryable", ledger_state: prior.state, detail: why,
      next_step: OPEN_STATES.has(prior.state) ? `read league ${cfg.league}'s MFL transactions and rosters, then POST /__test-env/ledger/resolve` : undefined,
      idempotency_key: key }, cfg);
  }
  // Atomic: the ledger row and the operation lock are written together, or neither is.
  try {
    await db.batch([
      db.prepare(`INSERT INTO ups_test_write_ledger (idempotency_key, operation_sha256, env, league_id, method, path, query_redacted, request_sha256, state, started_at)
                  VALUES (?, ?, 'test', ?, ?, ?, ?, ?, 'pending', ?)`)
        .bind(key, opHash, cfg.league, request.method, u.pathname, G.redactUrl(pinnedUrl).replace(/^[^?]*/, ""), reqHash, nowIso()),
      db.prepare("INSERT INTO ups_test_open_operations (operation_sha256, idempotency_key, env, opened_at) VALUES (?, ?, 'test', ?)").bind(opHash, key, nowIso()),
    ]);
  } catch (_) {
    const holder = await db.prepare("SELECT idempotency_key FROM ups_test_open_operations WHERE operation_sha256 = ?").bind(opHash).first().catch(() => null);
    if (holder && holder.idempotency_key !== key) {
      return json(409, { ok: false, error: "operation_unresolved", detail: "the same operation is already running or its outcome is unknown; it stays locked under every key until it is resolved",
        held_by: holder.idempotency_key, next_step: `read league ${cfg.league}'s MFL transactions and rosters, then POST /__test-env/ledger/resolve for ${holder.idempotency_key}` }, cfg);
    }
    return json(409, { ok: false, error: "prior_attempt_not_retryable", ledger_state: "pending", detail: "another request with this key started first", idempotency_key: key }, cfg);
  }

  const rc = newContext("ledgered", cfg, db, key);
  let res = null, threw = null;
  try {
    const req = new Request(pinnedUrl, { method: request.method, headers: request.headers, body: bodyBuf && bodyBuf.byteLength ? bodyBuf : undefined, redirect: "manual" });
    res = await als.run(rc, () => app.fetch(req, G.deriveTestEnv(env, cfg), trackingCtx(ctx, rc)));
  } catch (e) { threw = e; }
  let bodyOut = "", ctype = "";
  if (res) { ctype = res.headers.get("content-type") || ""; try { bodyOut = await res.clone().text(); } catch (_) { bodyOut = ""; } }

  const respond = (finalState, recorded) => {
    const extra = { "x-ups-idempotency-key": key, "x-ups-ledger-state": finalState, ...(recorded ? {} : { "x-ups-ledger": "unrecorded" }) };
    if (!res) return json(finalState === "uncertain" ? 502 : 500, { ok: false, error: finalState === "uncertain" ? "outcome_unknown_check_mfl" : "worker_error", ledger_state: finalState, idempotency_key: key }, cfg, extra);
    return stamp(new Response(bodyOut, res), cfg, extra);
  };

  if (!rc.background.length) {
    rc.finalized = true;
    let finalState = "uncertain", recorded = true;
    try { finalState = await finalizeLedger(db, rc, res, bodyOut, ctype, threw); } catch (_) { recorded = false; }
    return respond(finalState, recorded);
  }
  // Background work outstanding: answer now, record the answer, and finish the ledger only after every
  // waitUntil promise of THIS request has settled (or timed out, which leaves the outcome uncertain).
  let recorded = true;
  try {
    await db.prepare("UPDATE ups_test_write_ledger SET state = 'background', http_status = ?, response_body = ?, response_content_type = ?, responded_at = ? WHERE idempotency_key = ?")
      .bind(res ? res.status : null, bodyOut.length <= RESPONSE_BODY_CAP ? bodyOut : null, ctype, nowIso(), key).run();
  } catch (_) { recorded = false; }
  const finishing = settleBackground(rc).then(() => finalizeLedger(db, rc, res, bodyOut, ctype, threw)).catch((e) => console.log(`[ups-env=test] ledger finalize FAILED for ${key}: ${String((e && e.message) || e)}`));
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(finishing);
  return respond("background", recorded);
}

// ── internal routes ─────────────────────────────────────────────────────────────────────────────
function adminOk(request, env) {
  return timingSafeEqual(request.headers.get("x-ups-test-admin-key"), env.TEST_ADMIN_API_KEY);
}

async function ownerContacts(cfg, commishRaw) {
  const header = mflCookieHeader(commishRaw || "");
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
  const nsName = () => (typeof caches !== "undefined" && caches && caches.default && caches.default.__upsNs) || "no cache API";
  if (path === "/__test-env/status") {
    const marker = await verifyMarkers(env, inv, cfg, false);
    return json(200, {
      ok: true, env: "test", league: cfg.league, write_leagues: cfg.writeLeagues, guard_version: G.GUARD_VERSION,
      release_sha: String(env.UPS_RELEASE_SHA || ""), bindings: inv.bindings, database_marker: marker.ok ? "ok" : marker.reason,
      egress_guard: !!(globalThis.fetch && globalThis.fetch.__upsTestGuard), cache_namespace: nsName(),
      discord: cfg.testWebhookUrl ? "test webhook only" : "refused (no test webhook configured)",
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
      ["test league import outside a ledgered request", `https://www48.myfantasyleague.com/${cfg.season}/import?TYPE=fcfsWaiver&L=${cfg.league}&JSON=1`, { method: "POST", body: "ADD=1" }],
      ["GitHub dispatch", "https://api.github.com/repos/keithcreelman/upsmflproduction/dispatches", { method: "POST", body: "{}" }],
      ["production worker", "https://upsmflproduction.keith-creelman.workers.dev/api/health", {}],
    ]) {
      const r = await globalThis.fetch(url, init);
      probes.push({ probe: label, refused: r.headers.get("x-ups-egress") === "refused", status: r.status });
    }
    const contacts = new URL(request.url).searchParams.get("owner_contacts") === "1" ? await ownerContacts(cfg, env.MFLTEST_COMMISHCOOKIE) : undefined;
    return json(200, {
      ok: marker.ok && commish.ok && probes.every((p) => p.refused),
      league: cfg.league, database_marker: marker, commissioner_session: commish, egress_probes: probes,
      bindings: inv.bindings, cache_namespace: nsName(), ...(contacts ? { owner_contacts: contacts } : {}),
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
    const key = String(b.idempotency_key || "");
    if (!outcome || !KEY_RE.test(key) || evidence.length < 10) return json(400, { ok: false, error: "need idempotency_key, outcome (applied|not_applied) and evidence (what was read from MFL)" }, cfg);
    const db = ledgerDb(env, inv); await ensureLedger(db);
    // Only an unknown outcome is resolved, and only once the request's background work has finished
    // ('background' rows are still running). The row and both locks change together.
    const row = await db.prepare("SELECT state FROM ups_test_write_ledger WHERE idempotency_key = ?").bind(key).first();
    if (!row || !(row.state === "pending" || row.state === "uncertain")) return json(409, { ok: false, error: "not_pending_or_uncertain", state: row ? row.state : null }, cfg);
    await db.batch([
      db.prepare("UPDATE ups_test_write_ledger SET state = ?, resolution_note = ?, resolved_at = ? WHERE idempotency_key = ? AND state IN ('pending','uncertain')").bind(outcome, evidence.slice(0, 2000), nowIso(), key),
      db.prepare("DELETE FROM ups_test_open_operations WHERE idempotency_key = ?").bind(key),
      db.prepare("DELETE FROM ups_test_open_mfl_writes WHERE idempotency_key = ?").bind(key),
    ]);
    return json(200, { ok: true, state: outcome }, cfg);
  }
  return json(404, { ok: false, error: "unknown_test_env_route" }, cfg);
}

// The browser sends a custom header (the test site's Idempotency-Key) only if the CORS preflight allows it, and the
// worker's own preflight allows Content-Type alone. A test deployment answers preflights itself: Idempotency-Key is
// allowed only for the test website's exact origin(s) in TEST_SITE_ORIGINS. A preflight carries no body and no
// credentials, reaches no worker code and makes no outbound call. Found by Keith's first phone test, 2026-11-26.
export function testSiteOrigins(env) {
  return String((env && env.TEST_SITE_ORIGINS) || "").split(",").map((x) => x.trim()).filter((x) => /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(x));
}
function preflight(request, env, cfg) {
  const origin = String(request.headers.get("Origin") || "");
  const keyed = testSiteOrigins(env).includes(origin);
  return new Response(null, { status: 204, headers: {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": keyed ? "Content-Type, Idempotency-Key" : "Content-Type",
    "access-control-max-age": "600",
    "vary": "Origin",
    "x-ups-env": "test",
    "x-ups-league": cfg.league,
  } });
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
  if (request.method === "OPTIONS") return preflight(request, env, cfg);
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
    const creds = G.viewerCredentials(request, request.url, bodyText);
    const credentialHashes = [];
    for (const cred of creds) {
      const v = await checkCredential(cred, cfg);
      if (!v.ok) return json(403, { ok: false, error: v.reason, detail: "the forwarded MFL session must be a test-league account that is not a member of the production league" }, cfg);
      credentialHashes.push(await sha256hex(mflCookieHeader(cred)));
    }
    const commish = await checkCredential(env.MFLTEST_COMMISHCOOKIE, cfg);
    if (!commish.ok) return json(503, { ok: false, error: `commissioner_${commish.reason}`, detail: "MFLTEST_COMMISHCOOKIE must be the dedicated test account's session" }, cfg);
    const res = await runLedgered({ request, pinnedUrl: dec.url, bodyBuf, bodyText, env, ctx, app, cfg, inv, autoKey: !write, credentialHashes });
    console.log(`[ups-env=test league=${cfg.league}] ${request.method} ${url.pathname} -> ${res.status} ledger=${res.headers.get("x-ups-ledger-state") || "-"}`);
    return res;
  }

  // Reads run in their own context too: their outbound calls are attributed to them, an MFL write
  // from a read is refused, and their refusals are logged once their background work has finished.
  const db = ledgerDb(env, inv);
  const rc = newContext("read", cfg, db, null);
  const req = new Request(dec.url, { method: request.method, headers: request.headers, redirect: "manual" });
  const res = await als.run(rc, () => app.fetch(req, G.deriveTestEnv(env, cfg), trackingCtx(ctx, rc)));
  const logRefusals = async () => {
    if (rc.background.length) await settleBackground(rc); else rc.finalized = true;
    const refused = rc.events.filter((e) => e.decision === "refuse");
    if (refused.length) { await ensureLedger(db); await writeEgressRows(db, null, refused); }
  };
  const p = logRefusals().catch(() => {});
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p); else await p;
  console.log(`[ups-env=test league=${cfg.league}] ${request.method} ${url.pathname} -> ${res.status}`);
  return stamp(res, cfg);
}

export async function handleTestScheduled(event, env) {
  // A test deployment has no cron triggers; if one is ever added by mistake, nothing runs.
  console.log(`[ups-env=test league=${String((env && env.LEAGUE_ID) || "")}] scheduled run REFUSED: test deployments run no jobs`);
}
