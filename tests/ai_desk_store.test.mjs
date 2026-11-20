// Commissioner Desk: the store (the only SQL the desk runs) against real SQLite with the real migrations 0180 + 0181.
//   node tests/ai_desk_store.test.mjs
import { test, run, t } from "./fixtures/mini_test.mjs";
import { makeD1, applyMigrations } from "./fixtures/d1_sqlite.mjs";
import { makeCommishCaller, DeskAuthError } from "../worker/src/desk/contract.js";
import { createStore, StoreError, SQL, TABLES, MAX_LIST, MAX_NOTE_CHARS, PURGE_BATCH } from "../worker/src/desk/store.js";

const MIGRATIONS = ["0180_ai_call_log.sql", "0181_ai_desk_questions.sql"];
const NOW = Date.UTC(2026, 10, 19, 15, 0, 0);
const DAY = 86400;
const caller = makeCommishCaller("8");
const freshDb = () => { const d = makeD1(); applyMigrations(d, MIGRATIONS); return d; };
const q = (over = {}) => ({ question: "How much cap does franchise 0001 have?", asOf: "current", state: "answer", card: { lead_md: "x {{f.c1.cap}}" }, costUsd: 0.012, durationMs: 1500, toolCalls: 2, canonSha: "194f8df", nowMs: NOW, ...over });
const entry = (over = {}) => ({ feature: "commish_desk", runId: "r1", questionId: "q1", step: "loop", model: "claude-sonnet-5-5", mode: "fake", promptHash: "sha256:aa", canonSha: "194f8df", tools: "rules.search", nowMs: NOW, ...over });
const caps = (n) => ({ question: n, run: n, month: n, total: n });
const monthStart = Date.UTC(2026, 10, 1) / 1000;

const ALL_METHODS = {
  saveQuestion: (s, c) => s.saveQuestion(c, q()),
  listQuestions: (s, c) => s.listQuestions(c, {}),
  getQuestion: (s, c) => s.getQuestion(c, "x"),
  reportProblem: (s, c) => s.reportProblem(c, "x", "note"),
  purgeOlderThan: (s, c) => s.purgeOlderThan(c, 90),
  readLedgerSums: (s, c) => s.readLedgerSums(c, { mode: "fake", monthStart }),
  reserveCall: (s, c) => s.reserveCall(c, { entry: entry(), est: 0.1, caps: caps(1), monthStart }),
  finalizeCall: (s, c) => s.finalizeCall(c, 1, { costUsd: 0 }),
  annotateCall: (s, c) => s.annotateCall(c, 1, { validatorResult: "pass" }),
  logBlocked: (s, c) => s.logBlocked(c, entry(), "x"),
};

test("every method refuses a caller that is not the proven commissioner, before touching the database", async () => {
  const d = freshDb(); const s = createStore(d);
  const forged = { class: "commish", proven: true, scope: "desk", franchiseId: "0001", ceiling: "P2" };
  const before = d.log.length;
  t.deepEqual(Object.keys(ALL_METHODS).sort(), Object.keys(s).sort(), "every store method is covered by this test");
  for (const [name, fn] of Object.entries(ALL_METHODS)) {
    for (const bad of [undefined, null, {}, forged, Object.freeze({ ...forged, class: "owner" })]) {
      let err = null;
      try { await fn(s, bad); } catch (e) { err = e; }
      t.ok(err instanceof DeskAuthError, `${name} must throw DeskAuthError`);
    }
  }
  t.equal(d.log.length, before, "no SQL ran");
});

test("saveQuestion / getQuestion round trip; asked_by is the proven caller, never an argument", async () => {
  const d = freshDb(); const s = createStore(d);
  const { id } = await s.saveQuestion(caller, q({ asked_by: "9999" }));
  t.ok(id && id.length >= 8);
  const row = await s.getQuestion(caller, id);
  t.equal(row.asked_by, "0008");
  t.equal(row.question, "How much cap does franchise 0001 have?");
  t.deepEqual(row.card, { lead_md: "x {{f.c1.cap}}" });
  t.equal(row.created_at, NOW / 1000); t.equal(row.state, "answer"); t.equal(row.tool_calls, 2); t.equal(row.cost_usd, 0.012);
  t.equal(row.report_note, null);
  t.equal("card_json" in row, false);
  t.equal(await s.getQuestion(caller, "nope"), null);
});

test("saveQuestion validates: empty question, unknown state, oversize card; long question is cut", async () => {
  const s = createStore(freshDb());
  for (const bad of [q({ question: "  " }), q({ question: 5 }), q({ state: "made_up" }), q({ state: undefined }), q({ card: { x: "y".repeat(200001) } }), null]) {
    let err = null; try { await s.saveQuestion(caller, bad); } catch (e) { err = e; }
    t.ok(err instanceof StoreError && err.code === "bad_input");
  }
  const { id } = await s.saveQuestion(caller, q({ question: "z".repeat(5000), card: null }));
  t.equal((await s.getQuestion(caller, id)).question.length, 2000);
});

test("listQuestions: newest first, limit clamped to 1..50, no card bodies", async () => {
  const d = freshDb(); const s = createStore(d);
  for (let i = 0; i < 60; i++) await s.saveQuestion(caller, q({ id: `id${String(i).padStart(2, "0")}`, nowMs: NOW + i * 1000, question: `q${i}` }));
  const a = await s.listQuestions(caller, { limit: 500 });
  t.equal(a.length, MAX_LIST); t.equal(MAX_LIST, 50);
  t.equal(a[0].question, "q59"); t.equal(a[49].question, "q10");
  t.equal("card_json" in a[0], false);
  t.equal((await s.listQuestions(caller, { limit: 0 })).length, 1);
  t.equal((await s.listQuestions(caller, { limit: -4 })).length, 1);
  t.equal((await s.listQuestions(caller, { limit: "abc" })).length, 20);
  t.equal((await s.listQuestions(caller)).length, 20);
  const plan = d.raw.prepare(`EXPLAIN QUERY PLAN ${SQL.listQuestions}`).all(50).map((p) => p.detail).join(" | ");
  t.doesNotMatch(plan, /USE TEMP B-TREE/, "no sort of the whole table: " + plan);
});

test("reportProblem: stores the note, rejects empty, over 2000 chars and unknown ids", async () => {
  const s = createStore(freshDb());
  const { id } = await s.saveQuestion(caller, q());
  t.deepEqual(await s.reportProblem(caller, id, "The cap number looks wrong", { nowMs: NOW + 5000 }), { ok: true });
  const row = await s.getQuestion(caller, id);
  t.equal(row.report_note, "The cap number looks wrong"); t.equal(row.reported_at, NOW / 1000 + 5);
  t.deepEqual(await s.reportProblem(caller, id, "   "), { ok: false, reason: "empty_note" });
  t.deepEqual(await s.reportProblem(caller, id, "n".repeat(MAX_NOTE_CHARS + 1)), { ok: false, reason: "note_too_long" });
  t.deepEqual(await s.reportProblem(caller, id, "n".repeat(MAX_NOTE_CHARS)), { ok: true });
  t.deepEqual(await s.reportProblem(caller, "missing", "x"), { ok: false, reason: "not_found" });
  t.equal(MAX_NOTE_CHARS, 2000);
});

test("purgeOlderThan: deletes only old questions, at most one bounded batch per call, uses the created_at index", async () => {
  const d = freshDb(); const s = createStore(d);
  const ins = d.raw.prepare("INSERT INTO ai_desk_questions (id, created_at, asked_by, question, state) VALUES (?, ?, '0008', 'q', 'answer')");
  for (let i = 0; i < 600; i++) ins.run(`old${i}`, NOW / 1000 - 100 * DAY - i, );
  for (let i = 0; i < 5; i++) ins.run(`new${i}`, NOW / 1000 - 10 * DAY - i);
  ins.run("edge", NOW / 1000 - 90 * DAY + 60);   // 89.99 days old: kept
  d.raw.prepare("INSERT INTO ai_call_log (created_at, feature, step, model, mode) VALUES (?, 'commish_desk', 'loop', 'm', 'fake')").run(NOW / 1000 - 400 * DAY);
  const r1 = await s.purgeOlderThan(caller, 90, { nowMs: NOW });
  t.deepEqual(r1, { deleted: PURGE_BATCH, more: true });
  const r2 = await s.purgeOlderThan(caller, 90, { nowMs: NOW });
  t.deepEqual(r2, { deleted: 100, more: false });
  t.equal(d.raw.prepare("SELECT COUNT(*) AS n FROM ai_desk_questions").get().n, 6);
  t.equal(d.raw.prepare("SELECT COUNT(*) AS n FROM ai_call_log").get().n, 1, "the cost ledger is never purged");
  t.deepEqual(await s.purgeOlderThan(caller, undefined, { nowMs: NOW }), { deleted: 0, more: false });   // default is 90 days: nothing that old remains
  for (const bad of [0, -1, NaN, "x"]) { let e = null; try { await s.purgeOlderThan(caller, bad); } catch (x) { e = x; } t.ok(e instanceof StoreError && e.code === "bad_input"); }
  const plan = d.raw.prepare(`EXPLAIN QUERY PLAN ${SQL.purge}`).all(1).map((p) => p.detail).join(" | ");
  t.match(plan, /idx_ai_desk_questions_created/, plan);
});

test("reserveCall is atomic and only reserves while every cap holds; finalize works once", async () => {
  const d = freshDb(); const s = createStore(d);
  const a = await s.reserveCall(caller, { entry: entry(), est: 0.6, caps: caps(1), monthStart });
  t.equal(a.reserved, true); t.ok(a.id > 0);
  const b = await s.reserveCall(caller, { entry: entry({ step: "composer" }), est: 0.6, caps: caps(1), monthStart });
  t.equal(b.reserved, false, "0.6 reserved + 0.6 would pass 1.0");
  t.equal(d.raw.prepare("SELECT COUNT(*) AS n FROM ai_call_log").get().n, 1);
  const sums = await s.readLedgerSums(caller, { mode: "fake", runId: "r1", questionId: "q1", monthStart });
  t.deepEqual([sums.total, sums.month, sums.run, sums.question, sums.rows], [0.6, 0.6, 0.6, 0.6, 1]);
  t.equal((await s.readLedgerSums(caller, { mode: "live", runId: "r1", questionId: "q1", monthStart })).total, 0, "other lane");
  t.equal(await s.finalizeCall(caller, a.id, { inputTokens: 10, outputTokens: 5, costUsd: 0.1, latencyMs: 12 }), true);
  t.equal(await s.finalizeCall(caller, a.id, { costUsd: 99 }), false, "a finalized row is never rewritten");
  t.equal(d.raw.prepare("SELECT cost_usd FROM ai_call_log WHERE id = ?").get(a.id).cost_usd, 0.1);
  const c = await s.reserveCall(caller, { entry: entry({ step: "composer" }), est: 0.6, caps: caps(1), monthStart });
  t.equal(c.reserved, true, "after finalizing at 0.1 there is room again");
  // each cap is enforced on its own
  for (const which of ["question", "run", "month", "total"]) {
    const dd = freshDb(), ss = createStore(dd);
    const cp = { question: 9, run: 9, month: 9, total: 9, [which]: 0.05 };
    t.equal((await ss.reserveCall(caller, { entry: entry(), est: 0.1, caps: cp, monthStart })).reserved, false, which);
  }
});

test("annotateCall accepts only known validator results and card states", async () => {
  const d = freshDb(); const s = createStore(d);
  const { id } = await s.reserveCall(caller, { entry: entry(), est: 0.1, caps: caps(1), monthStart });
  t.equal(await s.annotateCall(caller, id, { validatorResult: "retry", state: "answer_with_gap" }), true);
  const row = d.raw.prepare("SELECT validator_result, state FROM ai_call_log WHERE id = ?").get(id);
  t.deepEqual({ ...row }, { validator_result: "retry", state: "answer_with_gap" });
  for (const bad of [{ validatorResult: "maybe" }, { state: "invented" }]) { let e = null; try { await s.annotateCall(caller, id, bad); } catch (x) { e = x; } t.ok(e instanceof StoreError && e.code === "bad_input"); }
});

test("logBlocked writes a zero-cost row with only ids, hash and reason", async () => {
  const d = freshDb(); const s = createStore(d);
  await s.logBlocked(caller, entry(), "budget_total");
  const [r] = d.raw.prepare("SELECT * FROM ai_call_log").all();
  t.deepEqual([r.mode, r.est_cost_usd, r.cost_usd, r.error_code, r.prompt_hash], ["blocked", 0, 0, "budget_total", "sha256:aa"]);
});

test("tables missing: every method reports not_ready (the gate then fails closed)", async () => {
  const s = createStore(makeD1());   // no migrations applied
  for (const [name, fn] of Object.entries(ALL_METHODS)) {
    let err = null; try { await fn(s, caller); } catch (e) { err = e; }
    t.ok(err instanceof StoreError && err.code === "not_ready", `${name}: ${err && err.code}`);
  }
  let e2 = null; try { createStore(null); } catch (e) { e2 = e; }
  t.equal(e2.code, "not_ready");
});

test("a database error is reported as ledger_unreadable, with no SQL or driver text", async () => {
  const d = freshDb(); const s = createStore(d);
  d.opts.beforeRun = () => { throw new Error("SQLITE_BUSY: secret internal detail with ai_call_log"); };
  let err = null; try { await s.readLedgerSums(caller, { mode: "fake", monthStart }); } catch (e) { err = e; }
  t.ok(err instanceof StoreError); t.equal(err.code, "ledger_unreadable"); t.equal(/secret|SQLITE/.test(err.message), false);
});

test("every executed statement uses bound parameters and touches only the two desk tables", async () => {
  const d = freshDb(); const s = createStore(d);
  const { id } = await s.saveQuestion(caller, q({ question: "x'; DROP TABLE ai_call_log; --" }));
  await s.getQuestion(caller, id); await s.listQuestions(caller, { limit: 3 }); await s.reportProblem(caller, id, "n'; DELETE FROM ai_desk_questions; --");
  const r = await s.reserveCall(caller, { entry: entry({ runId: "r';--" }), est: 0.1, caps: caps(1), monthStart });
  await s.readLedgerSums(caller, { mode: "fake", runId: "r1", questionId: "q1", monthStart });
  await s.finalizeCall(caller, r.id, { costUsd: 0.01 }); await s.annotateCall(caller, r.id, { state: "answer" }); await s.logBlocked(caller, entry(), "x"); await s.purgeOlderThan(caller, 90, { nowMs: NOW });
  t.ok(d.log.length >= 10);
  t.equal(d.raw.prepare("SELECT COUNT(*) AS n FROM ai_desk_questions").get().n, 1, "injection text was stored as data");
  t.ok(d.raw.prepare("SELECT name FROM sqlite_master WHERE name = 'ai_call_log'").get(), "table still exists");
  for (const { sql, args } of d.log) {
    t.equal((sql.match(/\?/g) || []).length, args.length, `placeholders match args: ${sql.slice(0, 50)}`);
    t.doesNotMatch(sql, /create\s+table|alter\s+table|drop\s+table/i);
    for (const m of sql.matchAll(/\b(FROM|JOIN|INTO|UPDATE)\s+([A-Za-z_][A-Za-z0-9_]*)/g)) t.ok([...TABLES, "s"].includes(m[2]), `table ${m[2]}`);
  }
  t.deepEqual([...TABLES], ["ai_call_log", "ai_desk_questions"]);
});

run("ai_desk_store");
