// Commissioner Desk: the ONLY module that runs SQL for the desk.
//
// Tables: ai_call_log (cost ledger), ai_budget_totals (its maintained total/monthly aggregate), both migration 0180, and ai_desk_questions
// (private question history, migration 0181). Nothing else. This file creates no tables: they come from the migrations. If they are
// missing, every method throws StoreError("not_ready") and the budget gate treats that as "ledger unreadable": it fails closed and never
// calls the model.
//
// Every public method starts with assertCommishCaller(caller) (throws DeskAuthError). Every statement uses bound parameters.
// The desk never touches league tables: a tool is never handed a database handle, and the handler/gate reach D1 only through this file.
//
// D1 cost (docs/D1_QUERY_RULES.md). Expected rows_read per call, with the real indexes from 0180/0181, independent of ledger size:
//   reserve (ONE atomic batch): 2 INSERT OR IGNORE on ai_budget_totals (primary key; a row is written only the first time a period is seen);
//        the guarded ai_call_log INSERT reads 2 totals rows by primary key (mode, period), the rows of THIS run via idx_ai_call_log_run and the
//        rows of THIS question via idx_ai_call_log_question (a handful: one question is 3 to 6 calls), and writes 1 ledger row (+4 index
//        entries); the totals bump touches 2 rows. About 10 rows read and 3 rows written per call.
//   finalize (ONE atomic batch): 1 ledger row by primary key and 2 totals rows by primary key, plus three one-row lookups in the totals UPDATE.
//   The ledger is never scanned for the total or monthly caps, so 5,000 or 5 million ledger rows read the same few rows.
//   A run id shared by many questions (an eval run) reads that run's rows for the per-run cap: bounded by the run's own cap, but not tiny.
//   listQuestions: <= 50 rows via idx_ai_desk_questions_created (reverse index walk, no sort).
//   getQuestion / reportProblem: 1 row by primary key. purgeOlderThan: <= PURGE_BATCH rows per call via idx_ai_desk_questions_created.
// ai_call_log is never purged here (only ai_desk_questions is): the totals make that safe, since no cap reads old ledger rows.
// Blocked attempts write one small row each (mode "blocked", cost 0) and touch no totals.

import { assertCommishCaller, CARD_STATES } from "./contract.js";

export class StoreError extends Error {
  // code: not_ready | ledger_unreadable | bad_input
  constructor(code, message) { super(message || code); this.name = "StoreError"; this.code = code; }
}

export const TABLES = Object.freeze(["ai_call_log", "ai_budget_totals", "ai_desk_questions"]);

export const MAX_LIST = 50;
export const MAX_NOTE_CHARS = 2000;
export const MAX_QUESTION_CHARS = 2000;
export const MAX_CARD_JSON_CHARS = 200000;
export const PURGE_BATCH = 500;
const UNKNOWN_TOTAL = 1e18;   // a missing totals row reads as "already over every cap": fail closed

// ── Every statement the desk may run ─────────────────────────────────────────────────────────────
// Cost of a ledger row = its real cost once finalized, else its reservation (worst-case estimate) while in flight.
const LEDGER_COST = "CASE WHEN cost_usd IS NULL THEN est_cost_usd ELSE cost_usd END";
const TOTALS_ROW = "(SELECT reserved_usd + spent_usd FROM ai_budget_totals WHERE mode = ? AND period = ?)";
const SCOPE_SUM = (col) => `(SELECT COALESCE(SUM(${LEDGER_COST}), 0) FROM ai_call_log WHERE ${col} = ? AND mode = ?)`;

export const SQL = Object.freeze({
  ensureTotals: `INSERT OR IGNORE INTO ai_budget_totals (mode, period) VALUES (?, ?)`,
  // Guarded reservation: the row is inserted only if every cap still holds. It runs in the same batch as the totals update below, and a D1
  // batch is one transaction, so two concurrent calls cannot both pass. A missing totals row counts as over the cap.
  reserve: `INSERT INTO ai_call_log (created_at, feature, run_id, question_id, step, model, mode, prompt_hash, canon_sha, tools, est_cost_usd)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
WHERE COALESCE(${TOTALS_ROW}, ${UNKNOWN_TOTAL}) + ? <= ?
  AND COALESCE(${TOTALS_ROW}, ${UNKNOWN_TOTAL}) + ? <= ?
  AND ${SCOPE_SUM("run_id")} + ? <= ?
  AND ${SCOPE_SUM("question_id")} + ? <= ?`,
  // changes() is the guarded INSERT's row count: a refused reservation increments nothing.
  reserveTotals: `UPDATE ai_budget_totals SET reserved_usd = reserved_usd + ? WHERE mode = ? AND period IN ('total', ?) AND changes() > 0`,
  // Read only to name which cap refused (the refusal itself was already decided atomically).
  readSums: `SELECT ${TOTALS_ROW} AS total, ${TOTALS_ROW} AS month, ${SCOPE_SUM("run_id")} AS run, ${SCOPE_SUM("question_id")} AS question`,
  finalize: `UPDATE ai_call_log SET input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?, cost_usd = ?, latency_ms = ?, error_code = ? WHERE id = ? AND cost_usd IS NULL`,
  // Runs right after finalize in the same batch: release the row's reservation and add what it cost. Skipped (changes() = 0) if the row was already final.
  finalizeTotals: `UPDATE ai_budget_totals SET
  reserved_usd = MAX(0, reserved_usd - COALESCE((SELECT est_cost_usd FROM ai_call_log WHERE id = ?), 0)),
  spent_usd = spent_usd + ?
WHERE mode = (SELECT mode FROM ai_call_log WHERE id = ?)
  AND period IN ('total', (SELECT strftime('%Y-%m', created_at, 'unixepoch') FROM ai_call_log WHERE id = ?))
  AND changes() > 0`,
  annotate: `UPDATE ai_call_log SET validator_result = ?, state = ? WHERE id = ?`,
  logBlocked: `INSERT INTO ai_call_log (created_at, feature, run_id, question_id, step, model, mode, prompt_hash, canon_sha, tools, est_cost_usd, cost_usd, error_code) VALUES (?, ?, ?, ?, ?, ?, 'blocked', ?, ?, ?, 0, 0, ?)`,
  insertQuestion: `INSERT INTO ai_desk_questions (id, created_at, asked_by, question, as_of, state, card_json, cost_usd, duration_ms, tool_calls, canon_sha) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  listQuestions: `SELECT id, created_at, asked_by, question, as_of, state, cost_usd, duration_ms, tool_calls, canon_sha, reported_at FROM ai_desk_questions ORDER BY created_at DESC LIMIT ?`,
  getQuestion: `SELECT id, created_at, asked_by, question, as_of, state, card_json, cost_usd, duration_ms, tool_calls, canon_sha, report_note, reported_at FROM ai_desk_questions WHERE id = ?`,
  reportProblem: `UPDATE ai_desk_questions SET report_note = ?, reported_at = ? WHERE id = ?`,
  purge: `DELETE FROM ai_desk_questions WHERE id IN (SELECT id FROM ai_desk_questions WHERE created_at < ? LIMIT ${PURGE_BATCH})`,
});

// 'YYYY-MM' in UTC: the same string SQLite's strftime('%Y-%m', created_at, 'unixepoch') gives for that instant.
export function periodOf(nowMs) { return new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString().slice(0, 7); }

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const intOrNull = (v) => { const n = Number(v); return v == null || !Number.isFinite(n) ? null : Math.max(0, Math.round(n)); };
const str = (v, max) => (v == null ? null : String(v).slice(0, max));
const idOrNull = (v) => (v == null ? null : String(v));
const nowSec = (ms) => Math.floor((Number.isFinite(ms) ? ms : Date.now()) / 1000);

function wrap(e) {
  if (e instanceof StoreError) return e;
  const msg = String((e && e.message) || e || "");
  if (/no such (table|column)/i.test(msg)) return new StoreError("not_ready", "desk tables missing (migrations 0180/0181 not applied)");
  return new StoreError("ledger_unreadable", "desk ledger could not be read or written");
}

export function createStore(db) {
  if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function") throw new StoreError("not_ready", "no database handle");

  async function run(sql, args) { try { return await db.prepare(sql).bind(...args).run(); } catch (e) { throw wrap(e); } }
  async function first(sql, args) { try { return await db.prepare(sql).bind(...args).first(); } catch (e) { throw wrap(e); } }
  async function all(sql, args) { try { const r = await db.prepare(sql).bind(...args).all(); return (r && r.results) || []; } catch (e) { throw wrap(e); } }
  async function batch(stmts) { try { return await db.batch(stmts); } catch (e) { throw wrap(e); } }
  const stmt = (sql, args) => db.prepare(sql).bind(...args);

  return {
    // ── ledger primitives (used by budget.guardedCall) ────────────────────────────────────────────
    // Reserved + spent USD for ONE mode ("live" or "fake"; never mixed). total and month come from ai_budget_totals (2 primary-key rows);
    // run and question from the ledger by their indexes. A missing totals row reads as 0 here (the reserve itself treats it as full).
    async readLedgerSums(caller, o) {
      assertCommishCaller(caller);
      const r = await first(SQL.readSums, [o.mode, "total", o.mode, periodOf(o.nowMs), idOrNull(o.runId), o.mode, idOrNull(o.questionId), o.mode]);
      if (!r) throw new StoreError("ledger_unreadable", "empty ledger read");
      return { total: num(r.total), month: num(r.month), run: num(r.run), question: num(r.question) };
    },

    // Atomic reserve (one D1 batch). o: { entry, est, caps:{question,run,month,total} }.
    // Returns { reserved:true, id } or { reserved:false } (a cap would be exceeded). Throws StoreError if the ledger or totals are unusable.
    async reserveCall(caller, o) {
      assertCommishCaller(caller);
      const e = o.entry, est = num(o.est), c = o.caps, EPS = 1e-9, period = periodOf(e.nowMs);
      const runId = idOrNull(e.runId), questionId = idOrNull(e.questionId);
      const res = await batch([
        stmt(SQL.ensureTotals, [e.mode, "total"]),
        stmt(SQL.ensureTotals, [e.mode, period]),
        stmt(SQL.reserve, [
          nowSec(e.nowMs), str(e.feature, 40) || "commish_desk", str(runId, 64), str(questionId, 64), str(e.step, 20) || "unknown", str(e.model, 80) || "unknown", e.mode,
          str(e.promptHash, 128), str(e.canonSha, 64), str(e.tools, 400), est,
          e.mode, "total", est, num(c.total) + EPS,
          e.mode, period, est, num(c.month) + EPS,
          str(runId, 64), e.mode, est, num(c.run) + EPS,
          str(questionId, 64), e.mode, est, num(c.question) + EPS,
        ]),
        stmt(SQL.reserveTotals, [est, e.mode, period]),
      ]);
      const r = res && res[2];
      if (!r || !r.meta) throw new StoreError("ledger_unreadable", "reserve result missing");
      if (num(r.meta.changes) < 1) return { reserved: false };
      return { reserved: true, id: num(r.meta.last_row_id) };
    },

    // Finalize a reservation once (one D1 batch: the ledger row AND the totals). costUsd is what the call is charged: the real cost, the
    // reservation itself when the real cost cannot be known, or 0 only when the provider definitely refused before processing.
    // Returns true if the row changed.
    async finalizeCall(caller, id, f) {
      assertCommishCaller(caller);
      const cost = Math.max(0, num(f.costUsd)), rid = Number(id);
      const res = await batch([
        stmt(SQL.finalize, [intOrNull(f.inputTokens), intOrNull(f.outputTokens), intOrNull(f.cacheReadTokens), intOrNull(f.cacheWriteTokens), cost, intOrNull(f.latencyMs), str(f.errorCode, 120), rid]),
        stmt(SQL.finalizeTotals, [rid, cost, rid, rid]),
      ]);
      return !!(res && res[0] && res[0].meta && num(res[0].meta.changes) > 0);
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
