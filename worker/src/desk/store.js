// Commissioner Desk: the ONLY module that runs SQL for the desk.
//
// Tables: ai_call_log (cost ledger, migration 0180) and ai_desk_questions (private question history, migration 0181). Nothing else.
// This file creates no tables: they come from the migrations. If they are missing, every method throws StoreError("not_ready")
// and the budget gate treats that as "ledger unreadable": it fails closed and never calls the model.
//
// Every public method starts with assertCommishCaller(caller) (throws DeskAuthError). Every statement uses bound parameters.
// The desk never touches league tables: a tool is never handed a database handle, and the handler/gate reach D1 only through this file.
//
// D1 cost (docs/D1_QUERY_RULES.md). Expected rows_read per statement, with the real indexes from 0180/0181:
//   reserveCall / readLedgerSums : one pass over ai_call_log rows with created_at >= LEDGER_WINDOW_START, via idx_ai_call_log_created
//                                  (SEARCH ... USING INDEX; `mode` is not indexed so the pass reads every desk row in the window,
//                                  all modes). A desk question writes about 3 to 6 rows, so a year of heavy use is a few thousand rows
//                                  read per call, well inside the Free plan's 5M/day even at hundreds of calls a day. The window floor
//                                  can be raised to the start of the current year when a year's rows grow past ~50k.
//   reserveCall also writes 1 row (+2 index entries); finalizeCall / failCall / annotateCall update 1 row by primary key.
//   listQuestions                : <= 50 rows via idx_ai_desk_questions_created (reverse index walk, no sort).
//   getQuestion / reportProblem  : 1 row by primary key.
//   purgeOlderThan               : <= PURGE_BATCH rows per call via idx_ai_desk_questions_created.
// Blocked attempts write one small row each (mode "blocked", cost 0).

import { assertCommishCaller, CARD_STATES } from "./contract.js";

export class StoreError extends Error {
  // code: not_ready | ledger_unreadable | bad_input
  constructor(code, message) { super(message || code); this.name = "StoreError"; this.code = code; }
}

export const TABLES = Object.freeze(["ai_call_log", "ai_desk_questions"]);

// Rows older than this cannot exist (the ledger table is created in 2026), so the total-spend scan starts here: an indexed range, not a table scan.
export const LEDGER_WINDOW_START = Date.UTC(2026, 0, 1) / 1000;
export const MAX_LIST = 50;
export const MAX_NOTE_CHARS = 2000;
export const MAX_QUESTION_CHARS = 2000;
export const MAX_CARD_JSON_CHARS = 200000;
export const PURGE_BATCH = 500;

// ── Every statement the desk may run ─────────────────────────────────────────────────────────────
// The inner SELECT is shared by the atomic reservation and the plain read. Cost of a row = its real cost once finalized, else its
// reservation (worst-case estimate) while in flight, so concurrent calls cannot overshoot.
const SUMS_CTE = `WITH s AS (
  SELECT COALESCE(SUM(c), 0) AS total,
         COALESCE(SUM(CASE WHEN created_at >= ? THEN c END), 0) AS month,
         COALESCE(SUM(CASE WHEN run_id = ? THEN c END), 0) AS run,
         COALESCE(SUM(CASE WHEN question_id = ? THEN c END), 0) AS question,
         COUNT(*) AS n
  FROM (SELECT created_at, run_id, question_id,
               CASE WHEN cost_usd IS NULL THEN est_cost_usd ELSE cost_usd END AS c
        FROM ai_call_log WHERE created_at >= ? AND mode = ?)
)`;

export const SQL = Object.freeze({
  readSums: `${SUMS_CTE} SELECT total, month, run, question, n FROM s`,
  // Atomic check-and-reserve: the row is inserted only if every cap still holds, in ONE statement, so two concurrent calls cannot both pass.
  reserve: `${SUMS_CTE}
INSERT INTO ai_call_log (created_at, feature, run_id, question_id, step, model, mode, prompt_hash, canon_sha, tools, est_cost_usd)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM s
WHERE s.question + ? <= ? AND s.run + ? <= ? AND s.month + ? <= ? AND s.total + ? <= ?`,
  finalize: `UPDATE ai_call_log SET input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?, cost_usd = ?, latency_ms = ?, error_code = ? WHERE id = ? AND cost_usd IS NULL`,
  annotate: `UPDATE ai_call_log SET validator_result = ?, state = ? WHERE id = ?`,
  logBlocked: `INSERT INTO ai_call_log (created_at, feature, run_id, question_id, step, model, mode, prompt_hash, canon_sha, tools, est_cost_usd, cost_usd, error_code) VALUES (?, ?, ?, ?, ?, ?, 'blocked', ?, ?, ?, 0, 0, ?)`,
  insertQuestion: `INSERT INTO ai_desk_questions (id, created_at, asked_by, question, as_of, state, card_json, cost_usd, duration_ms, tool_calls, canon_sha) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  listQuestions: `SELECT id, created_at, asked_by, question, as_of, state, cost_usd, duration_ms, tool_calls, canon_sha, reported_at FROM ai_desk_questions ORDER BY created_at DESC LIMIT ?`,
  getQuestion: `SELECT id, created_at, asked_by, question, as_of, state, card_json, cost_usd, duration_ms, tool_calls, canon_sha, report_note, reported_at FROM ai_desk_questions WHERE id = ?`,
  reportProblem: `UPDATE ai_desk_questions SET report_note = ?, reported_at = ? WHERE id = ?`,
  purge: `DELETE FROM ai_desk_questions WHERE id IN (SELECT id FROM ai_desk_questions WHERE created_at < ? LIMIT ${PURGE_BATCH})`,
});

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const intOrNull = (v) => { const n = Number(v); return v == null || !Number.isFinite(n) ? null : Math.max(0, Math.round(n)); };
const str = (v, max) => (v == null ? null : String(v).slice(0, max));
const nowSec = (ms) => Math.floor((Number.isFinite(ms) ? ms : Date.now()) / 1000);

function wrap(e) {
  if (e instanceof StoreError) return e;
  const msg = String((e && e.message) || e || "");
  if (/no such (table|column)/i.test(msg)) return new StoreError("not_ready", "desk tables missing (migrations 0180/0181 not applied)");
  return new StoreError("ledger_unreadable", "desk ledger could not be read or written");
}

export function createStore(db) {
  if (!db || typeof db.prepare !== "function") throw new StoreError("not_ready", "no database handle");

  async function run(sql, args) { try { return await db.prepare(sql).bind(...args).run(); } catch (e) { throw wrap(e); } }
  async function first(sql, args) { try { return await db.prepare(sql).bind(...args).first(); } catch (e) { throw wrap(e); } }
  async function all(sql, args) { try { const r = await db.prepare(sql).bind(...args).all(); return (r && r.results) || []; } catch (e) { throw wrap(e); } }

  const sumsArgs = (o) => [o.monthStart, o.runId == null ? null : String(o.runId), o.questionId == null ? null : String(o.questionId), o.windowStart == null ? LEDGER_WINDOW_START : o.windowStart, o.mode];

  return {
    // ── ledger primitives (used by budget.guardedCall) ────────────────────────────────────────────
    // Sums of reserved + spent USD for rows of ONE mode ("live" or "fake"). Never mixes lanes.
    async readLedgerSums(caller, o) {
      assertCommishCaller(caller);
      const r = await first(SQL.readSums, sumsArgs(o));
      if (!r) throw new StoreError("ledger_unreadable", "empty ledger read");
      return { total: num(r.total), month: num(r.month), run: num(r.run), question: num(r.question), rows: num(r.n) };
    },

    // Atomic reserve. o: { entry, est, caps:{question,run,month,total}, monthStart, windowStart? }.
    // Returns { reserved:true, id } or { reserved:false } (a cap would be exceeded). Throws StoreError if the ledger is unusable.
    async reserveCall(caller, o) {
      assertCommishCaller(caller);
      const e = o.entry, est = num(o.est), c = o.caps, EPS = 1e-9;
      const args = [
        ...sumsArgs({ monthStart: o.monthStart, runId: e.runId, questionId: e.questionId, windowStart: o.windowStart, mode: e.mode }),
        nowSec(e.nowMs), str(e.feature, 40) || "commish_desk", str(e.runId, 64), str(e.questionId, 64), str(e.step, 20) || "unknown", str(e.model, 80) || "unknown", e.mode,
        str(e.promptHash, 128), str(e.canonSha, 64), str(e.tools, 400), est,
        est, num(c.question) + EPS, est, num(c.run) + EPS, est, num(c.month) + EPS, est, num(c.total) + EPS,
      ];
      const r = await run(SQL.reserve, args);
      const changes = r && r.meta ? num(r.meta.changes) : 0;
      if (changes < 1) return { reserved: false };
      return { reserved: true, id: num(r.meta.last_row_id) };
    },

    // Finalize a reservation once. cost 0 + errorCode records a failed call. Returns true if a row changed.
    async finalizeCall(caller, id, f) {
      assertCommishCaller(caller);
      const r = await run(SQL.finalize, [intOrNull(f.inputTokens), intOrNull(f.outputTokens), intOrNull(f.cacheReadTokens), intOrNull(f.cacheWriteTokens),
        Math.max(0, num(f.costUsd)), intOrNull(f.latencyMs), str(f.errorCode, 60), Number(id)]);
      return !!(r && r.meta && num(r.meta.changes) > 0);
    },

    // Later steps (validator, composer) record the outcome on the call's row. Only known card states are accepted.
    async annotateCall(caller, id, { validatorResult = null, state = null } = {}) {
      assertCommishCaller(caller);
      if (validatorResult != null && !["pass", "retry", "fail"].includes(validatorResult)) throw new StoreError("bad_input", "validator_result");
      if (state != null && !CARD_STATES.includes(state)) throw new StoreError("bad_input", "state");
      const r = await run(SQL.annotate, [validatorResult, state, Number(id)]);
      return !!(r && r.meta && num(r.meta.changes) > 0);
    },

    // A refused attempt. Contains no prompt text: only the ids, hashes and the reason code.
    async logBlocked(caller, e, reason) {
      assertCommishCaller(caller);
      await run(SQL.logBlocked, [nowSec(e.nowMs), str(e.feature, 40) || "commish_desk", str(e.runId, 64), str(e.questionId, 64), str(e.step, 20) || "unknown",
        str(e.model, 80) || "unknown", str(e.promptHash, 128), str(e.canonSha, 64), str(e.tools, 400), str(reason, 60) || "blocked"]);
    },

    // ── question history ──────────────────────────────────────────────────────────────────────────
    async saveQuestion(caller, q) {
      assertCommishCaller(caller);
      if (!q || typeof q.question !== "string" || !q.question.trim()) throw new StoreError("bad_input", "question");
      if (!q.state || !CARD_STATES.includes(q.state)) throw new StoreError("bad_input", "state");
      const id = q.id ? String(q.id).slice(0, 64) : (globalThis.crypto && globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID() : `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`);
      let cardJson = null;
      if (q.card != null) {
        cardJson = JSON.stringify(q.card);
        if (cardJson.length > MAX_CARD_JSON_CHARS) throw new StoreError("bad_input", "card too large");
      }
      await run(SQL.insertQuestion, [id, nowSec(q.nowMs), caller.franchiseId, q.question.slice(0, MAX_QUESTION_CHARS), str(q.asOf, 20), q.state, cardJson,
        Math.max(0, num(q.costUsd)), intOrNull(q.durationMs), intOrNull(q.toolCalls) || 0, str(q.canonSha, 64)]);
      return { id };
    },

    // Newest first, never more than 50, no card bodies (open one with getQuestion).
    async listQuestions(caller, { limit = 20 } = {}) {
      assertCommishCaller(caller);
      const n = Math.min(MAX_LIST, Math.max(1, Math.floor(num(limit, 20))));
      return all(SQL.listQuestions, [n]);
    },

    async getQuestion(caller, id) {
      assertCommishCaller(caller);
      const r = await first(SQL.getQuestion, [String(id == null ? "" : id).slice(0, 64)]);
      if (!r) return null;
      let card = null;
      try { card = r.card_json ? JSON.parse(r.card_json) : null; } catch (_) { card = null; }
      const { card_json, ...rest } = r;
      return { ...rest, card };
    },

    async reportProblem(caller, id, note, { nowMs } = {}) {
      assertCommishCaller(caller);
      const text = String(note == null ? "" : note).trim();
      if (!text) return { ok: false, reason: "empty_note" };
      if (text.length > MAX_NOTE_CHARS) return { ok: false, reason: "note_too_long" };
      const r = await run(SQL.reportProblem, [text, nowSec(nowMs), String(id == null ? "" : id).slice(0, 64)]);
      return num(r && r.meta && r.meta.changes) > 0 ? { ok: true } : { ok: false, reason: "not_found" };
    },

    // Bounded: deletes at most PURGE_BATCH rows per call (call again while `more` is true). Only ai_desk_questions; the cost ledger is kept.
    async purgeOlderThan(caller, days = 90, { nowMs } = {}) {
      assertCommishCaller(caller);
      const d = Number(days);
      if (!Number.isFinite(d) || d < 1) throw new StoreError("bad_input", "days");
      const cutoff = nowSec(nowMs) - Math.floor(d) * 86400;
      const r = await run(SQL.purge, [cutoff]);
      const deleted = num(r && r.meta && r.meta.changes);
      return { deleted, more: deleted >= PURGE_BATCH };
    },
  };
}
