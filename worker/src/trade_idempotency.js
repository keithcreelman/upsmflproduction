// trade_idempotency.js — idempotency keys for creating trade offers (P0 S6, server side).
//
// PROBLEM: a double tap, or a retry after a timeout, re-ran POST /api/trades/proposals (= /trade-offers) or POST /api/trades/3way and
// could create a second MFL offer / a second 3-way row, with a second set of DMs.
//
// CONTRACT (only for a client that sends `idempotency_key` in the body; a request without one behaves exactly as before):
//   • The key is taken with a conditional INSERT immediately before the irreversible write (the MFL tradeProposal on a two-team offer,
//     the ups_3way_trades INSERT on a three-team create) — NOT at the top of the handler. Every refusal the client is expected to resolve
//     and resend with the SAME key (cap acknowledgment, staging_required, loaded-contract, validation, ...) happens before that point, so
//     it is never cached and never replayed.
//   • Same key again, same contents:
//       finished (done / failed)            → the ORIGINAL status + body, plus `idempotent_replay: true`; nothing is re-sent.
//       still running (< IDEM_STALE_MS)     → 409 request_in_progress.
//       running too long (crash / lost)     → 409 request_outcome_unknown — never re-sent; the owner checks their sent offers.
//   • Same key, different contents          → 409 idempotency_key_reused.
//   • Key present but the table can't be read/written → 503 idempotency_unavailable; nothing is sent (fail closed: without the record we
//     can't promise the second tap won't duplicate).
//   • A row is `in_progress` from the moment the key is taken until the handler records the outcome. If the worker dies in between, the
//     row stays `in_progress` and, once stale, answers request_outcome_unknown — the uncertain case is never resolved by sending again.
//
// D1 cost per keyed send: one INSERT (table row + primary-key index + created_at index) and one UPDATE by primary key (no indexed column
// changes). Reads are primary-key lookups. The hourly purge is a range DELETE on the created_at index.
//
// The table is created on demand (CREATE TABLE IF NOT EXISTS, exactly the DDL below) and also shipped as migration 0174, so deploy order
// can't matter — the same convention as the execution ledger (trade_execution.js / 0160).

import { capAckExtensionKey } from "./trade_cap_ack.js";
import { tokenSet } from "./trade_accept_integrity.js";

export const IDEM_SCOPE = Object.freeze({ TWO_WAY_PROPOSE: "two_way_propose", THREE_WAY_CREATE: "three_way_create" });
export const IDEM_STATE = Object.freeze({ IN_PROGRESS: "in_progress", DONE: "done", FAILED: "failed" });
/** A first attempt still `in_progress` after this long is treated as unknown (crashed / response lost), never as still running. */
export const IDEM_STALE_MS = 2 * 60 * 1000;
/** Rows older than this are purged by the hourly cron. */
export const IDEM_RETENTION_DAYS = 14;
/** A stored response larger than this is reduced to its outcome fields (D1 rows top out at 2 MB; replays only need the outcome). */
const MAX_RESPONSE_CHARS = 256 * 1024;

export const IDEM_DDL = `CREATE TABLE IF NOT EXISTS ups_trade_idempotency (
  league_id       TEXT NOT NULL,
  season          TEXT NOT NULL,
  scope           TEXT NOT NULL,
  actor_fid       TEXT NOT NULL,
  idem_key        TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  state           TEXT NOT NULL,
  status_code     INTEGER,
  response_json   TEXT,
  created_at_utc  TEXT NOT NULL,
  updated_at_utc  TEXT NOT NULL,
  PRIMARY KEY (league_id, season, scope, actor_fid, idem_key)
)`;
export const IDEM_INDEX_DDL = "CREATE INDEX IF NOT EXISTS idx_ups_trade_idempotency_created ON ups_trade_idempotency (created_at_utc)";

const s = (v) => String(v == null ? "" : v).trim();
const nowIso = () => new Date().toISOString();
const changes = (r) => Number(r && r.meta && r.meta.changes != null ? r.meta.changes : r && r.changes != null ? r.changes : 0);
const pad4 = (v) => { const d = s(v).replace(/\D/g, ""); return d ? d.padStart(4, "0").slice(-4) : ""; };

const MSG = Object.freeze({
  in_progress: "This offer is already being sent. Check your sent offers in a moment.",
  outcome_unknown: "We couldn't confirm whether your earlier attempt went through. Check your sent offers before trying again.",
  key_reused: "This doesn't match the offer you just sent. Start the offer again to send something different.",
  unavailable: "Couldn't safely send this right now, so nothing was sent. Try again in a moment.",
  bad_key: "That request had an invalid idempotency key.",
});
const reply = (status, code, message) => ({ status, body: { ok: false, code, error_type: code, error: message, message } });

/**
 * The optional client key. Absent / empty → { key: "" } (today's behavior). Present but malformed → { error } (a 400 the handler returns
 * before doing anything). A UUID is expected; any 8–128 chars of [A-Za-z0-9_-] is accepted.
 */
export function readIdempotencyKey(body) {
  const raw = body && Object.prototype.hasOwnProperty.call(body, "idempotency_key") ? body.idempotency_key : null;
  if (raw == null || raw === "") return { key: "" };
  const k = typeof raw === "string" ? raw.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(k)) return { key: "", error: reply(400, "invalid_idempotency_key", MSG.bad_key) };
  return { key: k };
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Fingerprint of a two-team offer: both franchises, each side's sorted MFL tokens (cap money is already a BB_ token), each side's
 * cap-money figure as sent, and the extension terms. Never the message text, the cap acknowledgment or the expiry — resending the same
 * offer after acknowledging the cap must hash identically.
 * @param tokensByFranchise  { fid: [tokens] } (trade_accept_integrity.js#tokensByFranchise)
 * @param capKByFranchise    { fid: traded_salary_adjustment_k }
 */
export function twoWayRequestHash({ from, to, tokensByFranchise, capKByFranchise, extensionRequests }) {
  const tb = tokensByFranchise || {}, ck = capKByFranchise || {};
  const sides = Object.keys(tb).map((k) => [pad4(k), tokenSet(tb[k] || []), Number(ck[pad4(k)]) || 0])
    .filter((x) => x[0]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha256Hex(JSON.stringify({ v: 1, scope: IDEM_SCOPE.TWO_WAY_PROPOSE, from: pad4(from), to: pad4(to), sides, ext: capAckExtensionKey(extensionRequests) }));
}

/** Fingerprint of a three-team create: the three franchises, every movement (from, to, sorted tokens, cap money), the extension terms. */
export function threeWayRequestHash({ initiator, teamB, teamC, movements, extensionRequests }) {
  const mv = (Array.isArray(movements) ? movements : []).filter(Boolean)
    .map((m) => [pad4(m.from), pad4(m.to), tokenSet(Array.isArray(m.asset_tokens) ? m.asset_tokens : []), Math.max(0, Math.trunc(Number(m.cap_k) || 0))])
    .map((x) => JSON.stringify(x)).sort();
  return sha256Hex(JSON.stringify({ v: 1, scope: IDEM_SCOPE.THREE_WAY_CREATE, a: pad4(initiator), b: pad4(teamB), c: pad4(teamC), mv, ext: capAckExtensionKey(extensionRequests) }));
}

// The DDL runs once per isolate per database (not once per request).
const ensured = new WeakMap();
async function ensure(db) {
  if (ensured.get(db)) return;
  await db.prepare(IDEM_DDL).run();
  await db.prepare(IDEM_INDEX_DDL).run();
  ensured.set(db, true);
}

const keyOf = (k) => [s(k.leagueId), s(k.season), s(k.scope), pad4(k.actorFid) || s(k.actorFid), s(k.key)];
const PK_WHERE = "league_id=? AND season=? AND scope=? AND actor_fid=? AND idem_key=?";

function storableBody(body) {
  let text = "";
  try { text = JSON.stringify(body == null ? null : body); } catch (_) { text = ""; }
  if (text && text.length <= MAX_RESPONSE_CHARS) return text;
  const b = body && typeof body === "object" ? body : {};
  const slim = { ok: !!b.ok, code: b.code || b.error_type || "", error: b.error || "", message: b.message || "", id: b.id || "", mode: b.mode || "",
    mfl: b.mfl && typeof b.mfl === "object" ? { trade_id: b.mfl.trade_id || "" } : undefined, response_truncated: true };
  return JSON.stringify(slim);
}

/** Idempotency-record operations on one D1 database. */
export function makeIdempotencyStore(db) {
  /** The row for a key, or null. Throws on a D1 failure. */
  const read = async (k) => {
    await ensure(db);
    return await db.prepare(`SELECT * FROM ups_trade_idempotency WHERE ${PK_WHERE}`).bind(...keyOf(k)).first();
  };

  /**
   * Take the key, or explain why not. Call ONLY immediately before the irreversible write.
   * @returns { acquired: true } | { acquired: false, reply: { status, body } }  — on !acquired the handler returns `reply` and sends nothing.
   */
  const begin = async (k, requestHash) => {
    try {
      if (!db) throw new Error("no D1 binding");
      await ensure(db);
      const at = nowIso();
      const ins = await db.prepare(
        `INSERT INTO ups_trade_idempotency (league_id, season, scope, actor_fid, idem_key, request_hash, state, created_at_utc, updated_at_utc)
         VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(league_id, season, scope, actor_fid, idem_key) DO NOTHING`
      ).bind(...keyOf(k), s(requestHash), IDEM_STATE.IN_PROGRESS, at, at).run();
      if (changes(ins) === 1) return { acquired: true };
      const row = await read(k);
      if (!row) throw new Error("idempotency row vanished after a conflict");
      return { acquired: false, reply: replyForExisting(row, requestHash) };
    } catch (e) {
      console.error(`[trade-idempotency] begin failed (${s(k && k.scope)}) — nothing sent: ${e?.message || e}`);
      return { acquired: false, reply: reply(503, "idempotency_unavailable", MSG.unavailable) };
    }
  };

  /**
   * Record the outcome of a request that took the key. Compare-and-set on `in_progress`. Never throws: the caller's response stands
   * whatever happens here (a failed write leaves the row in_progress, which later answers request_outcome_unknown — never a re-send).
   */
  const finish = async (k, { state, statusCode, body }) => {
    try {
      const r = await db.prepare(
        `UPDATE ups_trade_idempotency SET state=?, status_code=?, response_json=?, updated_at_utc=? WHERE ${PK_WHERE} AND state=?`
      ).bind(state === IDEM_STATE.DONE ? IDEM_STATE.DONE : IDEM_STATE.FAILED, Number(statusCode) || 0, storableBody(body), nowIso(), ...keyOf(k), IDEM_STATE.IN_PROGRESS).run();
      return changes(r) === 1;
    } catch (e) {
      console.error(`[trade-idempotency] finish failed (${s(k && k.scope)}); the key stays in_progress: ${e?.message || e}`);
      return false;
    }
  };

  return { read, begin, finish };
}

/** What a second request with an existing key gets. Exported for tests. */
export function replyForExisting(row, requestHash, nowMs) {
  if (s(row.request_hash) !== s(requestHash)) return reply(409, "idempotency_key_reused", MSG.key_reused);
  if (row.state === IDEM_STATE.DONE || row.state === IDEM_STATE.FAILED) {
    let body = null;
    try { body = JSON.parse(row.response_json); } catch (_) { body = null; }
    const status = Number(row.status_code) || 0;
    if (body && typeof body === "object" && status >= 200 && status < 600) return { status, body: { ...body, idempotent_replay: true } };
    return reply(409, "request_outcome_unknown", MSG.outcome_unknown);   // a finished row we can't read back: never re-send
  }
  const age = (nowMs == null ? Date.now() : nowMs) - Date.parse(s(row.updated_at_utc));
  if (Number.isFinite(age) && age >= 0 && age < IDEM_STALE_MS) return reply(409, "request_in_progress", MSG.in_progress);
  return reply(409, "request_outcome_unknown", MSG.outcome_unknown);
}

/**
 * Hourly purge: delete rows created more than IDEM_RETENTION_DAYS ago. A range DELETE on the created_at index (rows read ≈ rows deleted).
 * A database where the table was never created has nothing to purge (no DDL is run here).
 */
export async function purgeTradeIdempotency(db, nowMs) {
  if (!db) return { ok: false, deleted: 0, error: "no_db" };
  const cutoff = new Date((nowMs == null ? Date.now() : nowMs) - IDEM_RETENTION_DAYS * 86400000).toISOString();
  try {
    const r = await db.prepare("DELETE FROM ups_trade_idempotency WHERE created_at_utc < ?").bind(cutoff).run();
    return { ok: true, deleted: changes(r), cutoff };
  } catch (e) {
    if (/no such table:\s*ups_trade_idempotency\b/i.test(s(e?.message))) return { ok: true, deleted: 0, cutoff };
    return { ok: false, deleted: 0, cutoff, error: s(e?.message || e) };
  }
}
