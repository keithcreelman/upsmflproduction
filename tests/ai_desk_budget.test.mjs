// Commissioner Desk: the budget gate, the price table, the real client's wiring (stub fetch only) and the static guarantees.
//   node tests/ai_desk_budget.test.mjs
// Offline and deterministic: real SQLite (node:sqlite) with the real migrations 0180 + 0181, a fake model client, a stub fetch. No network, no money.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, run, t } from "./fixtures/mini_test.mjs";
import { makeD1, applyMigrations } from "./fixtures/d1_sqlite.mjs";
import { createFakeClient, textResponse } from "./fixtures/ai_desk/fake_client.mjs";
import { makeCommishCaller, DeskAuthError } from "../worker/src/desk/contract.js";
import { PRICES, PRICES_AS_OF, PRICES_VERIFIED, costUsd, estimateWorstCaseUsd, estimateTokens, isPricedModel, DeskPriceError } from "../worker/src/desk/prices.js";
import { getLimits, liveCallsAllowed, guardedCall, MAX_TOKENS_CEILING, MAX_REQUEST_CHARS } from "../worker/src/desk/budget.js";
import { createStore, SQL, LEDGER_WINDOW_START } from "../worker/src/desk/store.js";
import { createAnthropicClient, createLiveClientFromEnv, desiredKeyName, DeskModelError, ANTHROPIC_URL } from "../worker/src/desk/anthropic_client.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESK_DIR = path.resolve(HERE, "..", "worker", "src", "desk");
const MIGRATIONS = ["0180_ai_call_log.sql", "0181_ai_desk_questions.sql"];
const NOW = Date.UTC(2026, 10, 19, 15, 0, 0);          // 2026-11-19 15:00 UTC
const NOW_S = NOW / 1000;
const caller = makeCommishCaller("0008");

const approx = (a, b, msg) => t.ok(Math.abs(a - b) < 1e-12, `${msg || ""} expected ${b}, got ${a}`);
const freshDb = () => { const d = makeD1(); applyMigrations(d, MIGRATIONS); return d; };
const rows = (d, where = "1=1", args = []) => d.raw.prepare(`SELECT * FROM ai_call_log WHERE ${where} ORDER BY id`).all(...args);
const req = (over = {}) => ({ model: "claude-sonnet-5-5", max_tokens: 1000, system: "be brief", messages: [{ role: "user", content: "hello" }], ...over });
const estFor = (r) => estimateWorstCaseUsd({ model: r.model, inputTokensEstimate: estimateTokens(JSON.stringify(r).length), maxOutputTokens: r.max_tokens });
const BIG = { DESK_BUDGET_PER_QUESTION_USD: "5", DESK_BUDGET_PER_RUN_USD: "10", DESK_BUDGET_MONTHLY_USD: "20", DESK_BUDGET_TOTAL_USD: "50" };
const call = (o) => guardedCall({ caller, nowMs: NOW, deskEnabled: true, meta: { step: "loop", questionId: "q1", runId: "r1" }, request: req(), ...o });
// Usage that costs about `frac` of the sonnet estimate for req(): output tokens priced at $10 per million.
const usageCosting = (usd) => ({ input_tokens: 0, output_tokens: Math.round((usd / 10) * 1e6) });
const seed = (d, o) => d.raw.prepare(`INSERT INTO ai_call_log (created_at, feature, run_id, question_id, step, model, mode, est_cost_usd, cost_usd) VALUES (?, 'commish_desk', ?, ?, 'loop', 'claude-sonnet-5-5', ?, ?, ?)`)
  .run(o.createdAt ?? NOW_S - 60, o.runId ?? null, o.questionId ?? null, o.mode ?? "fake", o.est ?? 0, o.cost ?? null);

// ── prices ─────────────────────────────────────────────────────────────────────────────────────
test("price table: as-of date, unverified flag, the three models", () => {
  t.equal(PRICES_AS_OF, "2026-11-03");
  t.equal(PRICES_VERIFIED, false);
  t.deepEqual(Object.keys(PRICES).sort(), ["claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"]);
  t.equal(isPricedModel("claude-sonnet-5-5"), true);
  t.equal(isPricedModel("claude-sonnet-4-5"), false);
  t.equal(isPricedModel("toString"), false);   // no prototype keys
});

test("cost arithmetic, hand-computed, per model (1M of each token kind)", () => {
  const u = { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6 };
  approx(costUsd("claude-haiku-5-5", u), 0.10 + 0.50 + 0.10 + 0.125, "haiku");
  approx(costUsd("claude-sonnet-5-5", u), 2 + 10 + 0.10 + 2.5, "sonnet");          // cache write = 1.25 x input
  approx(costUsd("claude-opus-5-5", u), 4 + 20 + 4 + 5, "opus");
  approx(costUsd("claude-sonnet-5-5", { input_tokens: 1000, output_tokens: 500 }), 0.002 + 0.005, "small sonnet");
  approx(costUsd("claude-haiku-5-5", { input_tokens: 2000, output_tokens: 1000 }), 0.0002 + 0.0005, "small haiku");
  approx(costUsd("claude-opus-5-5", { input_tokens: 1000, output_tokens: 1000 }), 0.004 + 0.02, "small opus");
  approx(costUsd("claude-sonnet-5-5", {}), 0, "empty usage object");
  approx(costUsd("claude-sonnet-5-5", { input_tokens: -5, output_tokens: "x" }), 0, "junk counts are zero, never NaN");
});

test("unknown model and missing usage are errors, never a guess", () => {
  t.throws(() => costUsd("gpt-whatever", { input_tokens: 1 }), (e) => e instanceof DeskPriceError && e.code === "unknown_model");
  t.throws(() => costUsd("claude-sonnet-5-5", null), (e) => e instanceof DeskPriceError && e.code === "bad_usage");
  t.throws(() => estimateWorstCaseUsd({ model: "nope", inputTokensEstimate: 1, maxOutputTokens: 1 }), (e) => e.code === "unknown_model");
});

test("worst case: every input token at the input rate, every allowed output token at the output rate; chars/3 rounded up", () => {
  t.equal(estimateTokens(9), 3);
  t.equal(estimateTokens(10), 4);
  t.equal(estimateTokens(0), 0);
  approx(estimateWorstCaseUsd({ model: "claude-haiku-5-5", inputTokensEstimate: 1000, maxOutputTokens: 1000 }), 0.0001 + 0.0005, "haiku");
  approx(estimateWorstCaseUsd({ model: "claude-sonnet-5-5", inputTokensEstimate: 3000, maxOutputTokens: 4000 }), 0.006 + 0.04, "sonnet");
  approx(estimateWorstCaseUsd({ model: "claude-opus-5-5", inputTokensEstimate: 10000, maxOutputTokens: 2000 }), 0.04 + 0.04, "opus");
  // with prompt caching in the request the dearer cache-write rate is used (still an upper bound)
  approx(estimateWorstCaseUsd({ model: "claude-sonnet-5-5", inputTokensEstimate: 1e6, maxOutputTokens: 0, usesCache: true }), 2.5, "cache write rate");
});

// ── limits and switch ──────────────────────────────────────────────────────────────────────────
test("getLimits: default is 0 everywhere; junk is 0; good numbers parse", () => {
  const zero = { perQuestionUsd: 0, perRunUsd: 0, monthlyUsd: 0, totalUsd: 0 };
  t.deepEqual(getLimits({}), zero);
  t.deepEqual(getLimits(undefined), zero);
  t.deepEqual(getLimits({ DESK_BUDGET_PER_QUESTION_USD: "", DESK_BUDGET_PER_RUN_USD: "abc", DESK_BUDGET_MONTHLY_USD: "-3", DESK_BUDGET_TOTAL_USD: "NaN" }), zero);
  t.deepEqual(getLimits({ DESK_BUDGET_PER_QUESTION_USD: "Infinity", DESK_BUDGET_PER_RUN_USD: "0x10", DESK_BUDGET_MONTHLY_USD: "1e3", DESK_BUDGET_TOTAL_USD: null }), zero);
  t.deepEqual(getLimits({ DESK_BUDGET_PER_QUESTION_USD: "0.25", DESK_BUDGET_PER_RUN_USD: " 2 ", DESK_BUDGET_MONTHLY_USD: "20", DESK_BUDGET_TOTAL_USD: 50 }),
    { perQuestionUsd: 0.25, perRunUsd: 2, monthlyUsd: 20, totalUsd: 50 });
});

test("liveCallsAllowed needs the switch AND the desk key AND the desk flag", () => {
  const ok = { DESK_LIVE_MODEL_ENABLED: "1", ANTHROPIC_API_KEY_DESK: "k" };
  t.deepEqual(liveCallsAllowed(ok, true), { allowed: true, reasons: [] });
  t.deepEqual(liveCallsAllowed({}, false).reasons, ["live_calls_disabled", "no_key", "desk_disabled"]);
  t.deepEqual(liveCallsAllowed({ ...ok, DESK_LIVE_MODEL_ENABLED: "0" }, true).reasons, ["live_calls_disabled"]);
  t.deepEqual(liveCallsAllowed({ ...ok, DESK_LIVE_MODEL_ENABLED: "true" }, true).reasons, ["live_calls_disabled"]);
  t.deepEqual(liveCallsAllowed({ ...ok, ANTHROPIC_API_KEY_DESK: "   " }, true).reasons, ["no_key"]);
  t.deepEqual(liveCallsAllowed({ ...ok, ANTHROPIC_API_KEY_DESK: undefined }, true).reasons, ["no_key"]);
  t.deepEqual(liveCallsAllowed(ok, false).reasons, ["desk_disabled"]);
  t.deepEqual(liveCallsAllowed(ok, "1").reasons, ["desk_disabled"]);   // only the boolean true counts
  t.deepEqual(liveCallsAllowed({ DESK_LIVE_MODEL_ENABLED: "1", ANTHROPIC_API_KEY: "shared-key" }, true).reasons, ["no_key"]);   // the shared key does not count
});

// ── caller ─────────────────────────────────────────────────────────────────────────────────────
test("a non-commissioner caller throws before anything else happens", async () => {
  const d = freshDb(), c = createFakeClient([textResponse("x")]);
  const forged = { class: "commish", proven: true, scope: "desk", franchiseId: "0001", ceiling: "P2" };   // right shape, not built by makeCommishCaller (not frozen)
  for (const bad of [undefined, null, {}, forged, { ...forged, class: "owner" }, Object.freeze({ ...forged, proven: false })]) {
    let threw = null;
    try { await guardedCall({ env: BIG, db: d, caller: bad, client: c, request: req(), meta: {}, deskEnabled: true }); } catch (e) { threw = e; }
    t.ok(threw instanceof DeskAuthError, "must throw DeskAuthError");
  }
  t.equal(c.calls.length, 0);
  t.equal(rows(d).length, 0, "no ledger row either");
});

// ── the gate ───────────────────────────────────────────────────────────────────────────────────
test("default config blocks every call: no model request, one blocked row, cost 0", async () => {
  const d = freshDb(), c = createFakeClient([textResponse("x")]);
  const r = await call({ env: {}, db: d, client: c });
  t.deepEqual([r.ok, r.blocked, r.reason], [false, true, "budget_per_question"]);
  t.equal(c.calls.length, 0);
  const l = rows(d);
  t.equal(l.length, 1);
  t.equal(l[0].mode, "blocked"); t.equal(l[0].cost_usd, 0); t.equal(l[0].est_cost_usd, 0); t.equal(l[0].error_code, "budget_per_question");
});

test("each cap at 0 blocks on its own, in the documented order", async () => {
  for (const [zero, reason] of [["DESK_BUDGET_PER_QUESTION_USD", "budget_per_question"], ["DESK_BUDGET_PER_RUN_USD", "budget_per_run"], ["DESK_BUDGET_MONTHLY_USD", "budget_monthly"], ["DESK_BUDGET_TOTAL_USD", "budget_total"]]) {
    const d = freshDb(), c = createFakeClient([textResponse("x")]);
    const r = await call({ env: { ...BIG, [zero]: "0" }, db: d, client: c });
    t.equal(r.reason, reason); t.equal(c.calls.length, 0);
  }
});

test("a single call that cannot fit under a cap on its own is refused", async () => {
  const d = freshDb(), c = createFakeClient([textResponse("x")]);
  const r = await call({ env: { ...BIG, DESK_BUDGET_PER_QUESTION_USD: "0.001" }, db: d, client: c });   // sonnet, 1000 output tokens = $0.01 worst case
  t.equal(r.reason, "budget_per_question"); t.equal(c.calls.length, 0);
});

test("fake client: success writes the reservation first, then the real cost; ledger holds ids and hash, never text", async () => {
  const d = freshDb();
  const seen = [];
  const c = createFakeClient((request) => { seen.push(rows(d)); return textResponse("the answer is forty-two", { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 400 }); });
  const secret = "ZEBRA-PRIVATE-QUESTION-TEXT";
  const request = req({ messages: [{ role: "user", content: secret }] });
  const r = await call({ env: BIG, db: d, client: c, request, meta: { step: "router", questionId: "q9", runId: "run9", promptHash: "sha256:abc123", canonSha: "194f8df", tools: ["rules.search", "cap.position"] } });
  t.equal(r.ok, true); t.equal(r.mode, "fake");
  // during the call: one in-flight row, cost NULL, reservation > 0
  t.equal(seen[0].length, 1); t.equal(seen[0][0].cost_usd, null); t.ok(seen[0][0].est_cost_usd > 0); t.equal(seen[0][0].mode, "fake");
  approx(seen[0][0].est_cost_usd, estFor(request), "reservation = worst-case estimate");
  // after: finalized with real usage
  const [row] = rows(d);
  const want = (1000 * 2 + 500 * 10 + 2000 * 0.10 + 400 * 2.5) / 1e6;
  approx(row.cost_usd, want, "final cost from usage"); approx(r.costUsd, want);
  t.equal(row.input_tokens, 1000); t.equal(row.output_tokens, 500); t.equal(row.cache_read_tokens, 2000); t.equal(row.cache_write_tokens, 400);
  t.ok(row.latency_ms >= 0); t.equal(row.error_code, null);
  t.equal(row.prompt_hash, "sha256:abc123"); t.equal(row.canon_sha, "194f8df"); t.equal(row.tools, "rules.search,cap.position");
  t.equal(row.run_id, "run9"); t.equal(row.question_id, "q9"); t.equal(row.step, "router");
  t.equal(JSON.stringify(rows(d)).includes(secret), false, "question text must never reach the ledger");
  t.equal(JSON.stringify(rows(d)).includes("forty-two"), false, "answer text must never reach the ledger");
  t.equal(c.calls.length, 1);
  t.deepEqual(c.calls[0].messages, request.messages, "the fake saw exactly the request");
});

test("meta is validated: text in promptHash/ids is refused, not stored", async () => {
  const d = freshDb(), c = createFakeClient([textResponse("x")]);
  for (const meta of [{ promptHash: "Who owns the cap space? please" }, { runId: "has space" }, { questionId: "x".repeat(65) }, { step: "Router!" }, { tools: "a b" }]) {
    const r = await call({ env: BIG, db: d, client: c, meta });
    t.deepEqual([r.ok, r.reason], [false, "bad_request"]);
  }
  t.equal(c.calls.length, 0);
});

test("per-question cap: the 2nd step is blocked once the 1st consumed it", async () => {
  const d = freshDb(), r0 = req(), est = estFor(r0);
  const env = { ...BIG, DESK_BUDGET_PER_QUESTION_USD: String(est * 1.3) };
  const c = createFakeClient([textResponse("1", usageCosting(est * 0.9)), textResponse("2")]);
  const a = await call({ env, db: d, client: c, meta: { questionId: "qa", runId: "r1" } });
  t.equal(a.ok, true);
  const b = await call({ env, db: d, client: c, meta: { questionId: "qa", runId: "r1" } });
  t.deepEqual([b.ok, b.reason], [false, "budget_per_question"]);
  const other = await call({ env, db: d, client: c, meta: { questionId: "qb", runId: "r1" } });   // a different question has its own allowance
  t.equal(other.ok, true);
  t.equal(c.calls.length, 2);
});

test("per-run cap spans questions in the same run only", async () => {
  const d = freshDb(), est = estFor(req());
  const env = { ...BIG, DESK_BUDGET_PER_RUN_USD: String(est * 1.3) };
  const c = createFakeClient([textResponse("1", usageCosting(est * 0.9)), textResponse("2"), textResponse("3")]);
  t.equal((await call({ env, db: d, client: c, meta: { questionId: "q1", runId: "runA" } })).ok, true);
  const b = await call({ env, db: d, client: c, meta: { questionId: "q2", runId: "runA" } });
  t.deepEqual([b.ok, b.reason], [false, "budget_per_run"]);
  t.equal((await call({ env, db: d, client: c, meta: { questionId: "q3", runId: "runB" } })).ok, true);
});

test("monthly cap counts this UTC month only; total cap counts everything", async () => {
  const est = estFor(req());
  // last month's spend is outside the monthly window but inside the total
  const d1 = freshDb();
  seed(d1, { createdAt: Date.UTC(2026, 9, 31, 23, 59, 59) / 1000, cost: est * 5 });
  const envM = { ...BIG, DESK_BUDGET_MONTHLY_USD: String(est * 2), DESK_BUDGET_TOTAL_USD: "50" };
  t.equal((await call({ env: envM, db: d1, client: createFakeClient([textResponse("x")]) })).ok, true, "October spend does not block November");
  const d2 = freshDb();
  seed(d2, { createdAt: NOW_S - 3600, cost: est * 5 });                // this month
  const r2 = await call({ env: envM, db: d2, client: createFakeClient([textResponse("x")]) });
  t.equal(r2.reason, "budget_monthly");
  const d3 = freshDb();
  seed(d3, { createdAt: Date.UTC(2026, 9, 31) / 1000, cost: est * 5 });
  const r3 = await call({ env: { ...BIG, DESK_BUDGET_TOTAL_USD: String(est * 5.5) }, db: d3, client: createFakeClient([textResponse("x")]) });
  t.equal(r3.reason, "budget_total", "old spend still counts toward the total cap");
});

test("in-flight reservations (cost NULL) count at their estimate; failed calls (cost 0) count nothing", async () => {
  const est = estFor(req());
  const d = freshDb();
  seed(d, { questionId: "qz", runId: "rz", est: est * 0.9, cost: null });   // an unfinished reservation
  const env = { ...BIG, DESK_BUDGET_PER_QUESTION_USD: String(est * 1.5) };
  const r = await call({ env, db: d, client: createFakeClient([textResponse("x")]), meta: { questionId: "qz", runId: "rz" } });
  t.equal(r.reason, "budget_per_question");
  const d2 = freshDb();
  seed(d2, { questionId: "qz", runId: "rz", est: est * 0.9, cost: 0 });     // finalized as failed
  t.equal((await call({ env, db: d2, client: createFakeClient([textResponse("x")]), meta: { questionId: "qz", runId: "rz" } })).ok, true);
});

test("fake and live spend are separate lanes under the same limits", async () => {
  const est = estFor(req());
  const d = freshDb();
  seed(d, { mode: "live", questionId: "q1", runId: "r1", cost: est * 100 });          // huge LIVE spend
  const env = { ...BIG, DESK_BUDGET_TOTAL_USD: String(est * 2) };
  t.equal((await call({ env, db: d, client: createFakeClient([textResponse("x")]) })).ok, true, "live rows do not count against a fake call");
  const d2 = freshDb();
  seed(d2, { mode: "fake", questionId: "q1", runId: "r1", cost: est * 100 });          // huge FAKE spend
  const liveEnv = { ...env, DESK_LIVE_MODEL_ENABLED: "1", ANTHROPIC_API_KEY_DESK: "k" };
  let liveCalls = 0;
  const liveClient = { mode: "live", async complete() { liveCalls++; return textResponse("x"); } };
  t.equal((await call({ env: liveEnv, db: d2, client: liveClient })).ok, true, "fake rows do not count against a live call");
  t.equal(liveCalls, 1);
  // and the limits are identical: a live call is also stopped by the live lane's own total
  const d3 = freshDb();
  seed(d3, { mode: "live", cost: est * 100 });
  const r3 = await call({ env: liveEnv, db: d3, client: liveClient });
  t.equal(r3.reason, "budget_total"); t.equal(liveCalls, 1);
});

test("live client mode is blocked without the switch, the desk key or the desk flag; the client is never contacted", async () => {
  let contacted = 0;
  const live = { mode: "live", async complete() { contacted++; return textResponse("x"); } };
  const full = { ...BIG, DESK_LIVE_MODEL_ENABLED: "1", ANTHROPIC_API_KEY_DESK: "test-key" };
  for (const [env, deskEnabled, reason] of [
    [{ ...BIG, ANTHROPIC_API_KEY_DESK: "test-key" }, true, "live_calls_disabled"],
    [{ ...full, DESK_LIVE_MODEL_ENABLED: "0" }, true, "live_calls_disabled"],
    [{ ...BIG, DESK_LIVE_MODEL_ENABLED: "1" }, true, "no_key"],
    [{ ...BIG, DESK_LIVE_MODEL_ENABLED: "1", ANTHROPIC_API_KEY: "shared-key" }, true, "no_key"],
    [full, false, "desk_disabled"],
    [full, undefined, "desk_disabled"],
  ]) {
    const d = freshDb();
    const r = await call({ env, db: d, client: live, deskEnabled });
    t.deepEqual([r.ok, r.reason], [false, reason]);
  }
  t.equal(contacted, 0);
  const d = freshDb();
  t.equal((await call({ env: full, db: d, client: live })).ok, true, "all three present: allowed");
  t.equal(contacted, 1);
  t.equal(rows(d)[0].mode, "live");
});

test("fake mode needs neither the switch nor a key (that is the point), but still needs a budget", async () => {
  const d = freshDb();
  t.equal((await call({ env: BIG, db: d, client: createFakeClient([textResponse("x")]), deskEnabled: false })).ok, true);
});

test("a missing or malformed client is blocked", async () => {
  const d = freshDb();
  for (const client of [null, undefined, {}, { mode: "mystery", complete() {} }, { mode: "live" }]) {
    const r = await call({ env: BIG, db: d, client });
    t.deepEqual([r.ok, r.reason], [false, "no_client"]);
  }
});

test("bad requests are blocked and never reach the model", async () => {
  const d = freshDb(), c = createFakeClient(() => textResponse("x"));
  const cases = [
    [req({ model: "gpt-5" }), "unknown_model"], [req({ model: undefined }), "unknown_model"],
    [req({ max_tokens: undefined }), "bad_request"], [req({ max_tokens: MAX_TOKENS_CEILING + 1 }), "bad_request"], [req({ max_tokens: 0 }), "bad_request"], [req({ max_tokens: 1.5 }), "bad_request"],
    [req({ messages: [] }), "bad_request"], [req({ messages: "hi" }), "bad_request"], [req({ messages: [{ role: "system", content: "x" }] }), "bad_request"],
    [req({ messages: [{ role: "user", content: "x".repeat(MAX_REQUEST_CHARS) }] }), "bad_request"],
    [req({ tools: "none" }), "bad_request"], [null, "bad_request"], ["hello", "bad_request"],
  ];
  for (const [request, reason] of cases) {
    const r = await call({ env: BIG, db: d, client: c, request });
    t.deepEqual([r.ok, r.reason], [false, reason], JSON.stringify(request).slice(0, 60));
  }
  t.equal(c.calls.length, 0);
  t.equal(MAX_TOKENS_CEILING, 4000);
  t.equal((await call({ env: BIG, db: d, client: c, request: req({ max_tokens: 4000 }) })).ok, true, "the ceiling itself is allowed");
});

test("an unknown model is blocked as unknown_model and logged as a blocked row", async () => {
  const d = freshDb(), c = createFakeClient([textResponse("x")]);
  const r = await call({ env: BIG, db: d, client: c, request: req({ model: "claude-mystery-9" }) });
  t.deepEqual([r.ok, r.reason], [false, "unknown_model"]);
  t.equal(c.calls.length, 0);
  t.equal(rows(d)[0].mode, "blocked");
});

test("ledger unreadable fails closed: dropped table, never-migrated database, failing writes", async () => {
  // dropped table
  const d = freshDb(); d.raw.exec("DROP TABLE ai_call_log");
  const c = createFakeClient([textResponse("x")]);
  const r = await call({ env: BIG, db: d, client: c });
  t.deepEqual([r.ok, r.blocked, r.reason], [false, true, "ledger_unreadable"]);
  t.equal(r.detail, "not_ready");
  t.equal(c.calls.length, 0);
  // migrations never applied
  const bare = makeD1();
  const r2 = await call({ env: BIG, db: bare, client: c });
  t.equal(r2.reason, "ledger_unreadable"); t.equal(c.calls.length, 0);
  // writes failing (reservation cannot be recorded, so no call)
  const w = freshDb(); w.opts.beforeRun = (sql) => { if (/INSERT INTO/i.test(sql)) throw new Error("D1_ERROR: simulated write failure"); };   // (the fixture's failWrites only matches statements that START with INSERT; ours starts with WITH)
  const r3 = await call({ env: BIG, db: w, client: c });
  t.equal(r3.reason, "ledger_unreadable"); t.equal(c.calls.length, 0);
  // no db at all
  const r4 = await call({ env: BIG, db: undefined, client: c });
  t.equal(r4.reason, "ledger_unreadable"); t.equal(c.calls.length, 0);
});

test("a concurrent burst cannot overshoot: reservations are checked and written in one statement", async () => {
  const d = freshDb(), est = estFor(req());
  const env = { ...BIG, DESK_BUDGET_TOTAL_USD: String(est * 3.5), DESK_BUDGET_MONTHLY_USD: "50", DESK_BUDGET_PER_RUN_USD: "50", DESK_BUDGET_PER_QUESTION_USD: "50" };
  const c = createFakeClient(async () => { await new Promise((r) => setTimeout(r, 5)); return textResponse("x", usageCosting(est * 0.5)); });   // slow, so all reservations overlap
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => call({ env, db: d, client: c, meta: { questionId: `burst${i}`, runId: "burst" } })));
  const okN = results.filter((r) => r.ok).length;
  t.equal(okN, 3, "exactly floor(3.5) calls fit");
  t.equal(c.calls.length, 3);
  t.ok(results.filter((r) => !r.ok).every((r) => r.reason === "budget_total"));
  const l = rows(d, "mode = 'fake'");
  t.equal(l.length, 3);
  t.ok(l.reduce((s, r) => s + (r.cost_usd ?? r.est_cost_usd), 0) <= est * 3.5 + 1e-9, "never over the cap");
  t.equal(rows(d, "mode = 'blocked'").length, 9);
});

test("model error: typed, no provider body, cost 0, blocked model_error", async () => {
  const d = freshDb();
  const leak = "sk-ant-SECRET-body-text";
  const c = createFakeClient([new Error(`provider said ${leak}`), new DeskModelError("http_error", { status: 429, providerType: "rate_limit_error" })]);
  const a = await call({ env: BIG, db: d, client: c });
  t.deepEqual([a.ok, a.reason, a.detail], [false, "model_error", "client_error"]);
  t.equal(JSON.stringify(a).includes(leak), false);
  const b = await call({ env: BIG, db: d, client: c });
  t.deepEqual([b.reason, b.detail], ["model_error", "http_error"]);
  const l = rows(d);
  t.equal(l.length, 2);
  t.deepEqual(l.map((r) => [r.cost_usd, r.error_code]), [[0, "client_error"], [0, "http_error"]]);
  t.equal(JSON.stringify(l).includes(leak), false);
});

test("a timeout keeps the worst-case reservation as its cost (it may have been billed)", async () => {
  const d = freshDb(), est = estFor(req());
  const c = createFakeClient([new DeskModelError("timeout")]);
  const r = await call({ env: BIG, db: d, client: c });
  t.equal(r.reason, "model_error");
  const [row] = rows(d);
  approx(row.cost_usd, est); t.equal(row.error_code, "timeout");
});

test("a response with no usage is charged the worst case; a failed finalize keeps the paid answer and the reservation", async () => {
  const est = estFor(req());
  const d = freshDb();
  const r = await call({ env: BIG, db: d, client: createFakeClient([{ content: [{ type: "text", text: "x" }] }]) });
  t.equal(r.ok, true);
  const nousage = createFakeClient([{ content: [], usage: null }]);
  const r1 = await call({ env: BIG, db: d, client: { mode: "fake", async complete(q) { const o = await nousage.complete(q); o.usage = undefined; return o; } } });
  t.equal(r1.ok, true); approx(r1.costUsd, est); t.equal(rows(d)[1].error_code, "usage_missing");
  const d2 = freshDb();
  const c2 = createFakeClient([textResponse("paid answer", usageCosting(est * 0.1))]);
  d2.opts.beforeRun = (sql) => { if (/^\s*UPDATE/i.test(sql)) throw new Error("D1_ERROR: simulated"); };
  const r2 = await call({ env: BIG, db: d2, client: c2 });
  t.equal(r2.ok, true); t.equal(r2.ledgerWarning, "finalize_failed");
  const [row] = rows(d2);
  t.equal(row.cost_usd, null, "reservation stays unfinalized");
  approx(row.est_cost_usd, est);
});

test("ledger read: one indexed range scan (EXPLAIN QUERY PLAN) and a bounded window", async () => {
  const d = freshDb();
  // 50 rows before the window floor, 20 live + 5 fake inside it
  for (let i = 0; i < 50; i++) seed(d, { createdAt: LEDGER_WINDOW_START - 1000 - i, mode: "live", cost: 1 });
  for (let i = 0; i < 20; i++) seed(d, { createdAt: LEDGER_WINDOW_START + 1000 + i, mode: "live", cost: 0.5 });
  for (let i = 0; i < 5; i++) seed(d, { createdAt: LEDGER_WINDOW_START + 2000 + i, mode: "fake", cost: 0.5 });
  const store = createStore(d);
  const s = await store.readLedgerSums(caller, { mode: "live", runId: null, questionId: null, monthStart: LEDGER_WINDOW_START });
  t.equal(s.rows, 20, "only in-window rows of the requested mode are summed");
  approx(s.total, 10, "total");
  approx(s.run, 0, "no run id: nothing matches"); approx(s.question, 0, "no question id: nothing matches");
  const args = [LEDGER_WINDOW_START, null, null, LEDGER_WINDOW_START, "live"];
  for (const sql of [SQL.readSums]) {
    const plan = d.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((p) => p.detail).join(" | ");
    t.match(plan, /USING (COVERING )?INDEX idx_ai_call_log_created/, plan);
    t.doesNotMatch(plan, /SCAN ai_call_log(?! USING)/, "no full table scan");
  }
  const reservePlan = d.raw.prepare(`EXPLAIN QUERY PLAN ${SQL.reserve}`).all(...args, NOW_S, "commish_desk", null, null, "loop", "m", "fake", null, null, null, 0.1, 1, 9, 1, 9, 1, 9, 1, 9).map((p) => p.detail).join(" | ");
  t.match(reservePlan, /INDEX idx_ai_call_log_created/, reservePlan);
});

// ── real client (stub fetch only) ───────────────────────────────────────────────────────────────
test("real client: URL, headers, whitelisted body, normalized result; the key never leaves the header", async () => {
  const sent = [];
  const stub = async (url, init) => { sent.push({ url, init }); return { ok: true, status: 200, text: async () => JSON.stringify({ id: "x", model: "claude-sonnet-5-5", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 2 }, extra: "dropped" }) }; };
  const client = createAnthropicClient({ apiKey: "  desk-key-123  ", fetch: stub });
  t.equal(client.mode, "live");
  const out = await client.complete({ ...req(), sneaky: "not sent", metadata: { user_id: "nope" } });
  t.deepEqual(Object.keys(out).sort(), ["content", "model", "stop_reason", "usage"]);
  t.equal(sent.length, 1);
  t.equal(sent[0].url, ANTHROPIC_URL);
  t.equal(sent[0].init.method, "POST");
  t.equal(sent[0].init.headers["x-api-key"], "desk-key-123");
  t.equal(sent[0].init.headers["anthropic-version"], "2023-06-01");
  t.equal(sent[0].init.headers["content-type"], "application/json");
  const body = JSON.parse(sent[0].init.body);
  t.deepEqual(Object.keys(body).sort(), ["max_tokens", "messages", "model", "system"]);
  t.equal(sent[0].init.body.includes("desk-key-123"), false);
  t.ok(sent[0].init.signal, "has an abort signal");
});

test("real client: non-2xx throws a typed error with no key and no body; exactly one attempt (no retry)", async () => {
  let n = 0;
  const stub = async () => { n++; return { ok: false, status: 429, text: async () => JSON.stringify({ error: { type: "rate_limit_error", message: "echo desk-key-123 and the prompt PRIVATE" } }) }; };
  const client = createAnthropicClient({ apiKey: "desk-key-123", fetch: stub });
  let err = null;
  try { await client.complete(req()); } catch (e) { err = e; }
  t.ok(err instanceof DeskModelError);
  t.equal(err.code, "http_error"); t.equal(err.status, 429); t.equal(err.providerType, "rate_limit_error");
  t.equal(/desk-key-123|PRIVATE/.test(err.message + JSON.stringify(err)), false);
  t.equal(n, 1);
  const stub500 = async () => { n++; return { ok: false, status: 500, text: async () => "<html>boom desk-key-123</html>" }; };
  let e2 = null; try { await createAnthropicClient({ apiKey: "desk-key-123", fetch: stub500 }).complete(req()); } catch (e) { e2 = e; }
  t.equal(e2.code, "http_error"); t.equal(e2.providerType, null); t.equal(n, 2);
});

test("real client: malformed 2xx, network failure and timeout are typed errors", async () => {
  const mk = (stub, o = {}) => createAnthropicClient({ apiKey: "k", fetch: stub, ...o });
  let e1 = null; try { await mk(async () => ({ ok: true, status: 200, text: async () => "not json" })).complete(req()); } catch (e) { e1 = e; }
  t.equal(e1.code, "bad_response");
  let e2 = null; try { await mk(async () => { throw new TypeError("fetch failed: desk-key"); }).complete(req()); } catch (e) { e2 = e; }
  t.equal(e2.code, "network"); t.equal(e2.message.includes("desk-key"), false);
  const hang = (url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  let e3 = null; try { await mk(hang, { timeoutMs: 20 }).complete(req()); } catch (e) { e3 = e; }
  t.equal(e3.code, "timeout");
});

test("real client refuses to construct without a key; createLiveClientFromEnv returns null", () => {
  for (const k of [undefined, "", "   ", null, 5]) t.throws(() => createAnthropicClient({ apiKey: k, fetch: async () => {} }), (e) => e instanceof DeskModelError && e.code === "no_key");
  t.equal(createLiveClientFromEnv({}, async () => {}), null);
  t.equal(createLiveClientFromEnv(undefined), null);
  t.equal(createLiveClientFromEnv({ ANTHROPIC_API_KEY_DESK: "  " }), null);
  t.equal(createLiveClientFromEnv({ ANTHROPIC_API_KEY: "the-shared-key" }), null, "the shared key is not a desk key");
  t.equal(createLiveClientFromEnv({ ANTHROPIC_API_KEY_DESK: "k" }, async () => {}).mode, "live");
});

test("the live client reads only the desk key from env, never the shared key", () => {
  t.equal(desiredKeyName, "ANTHROPIC_API_KEY_DESK");
  const touched = [];
  const spy = new Proxy({ ANTHROPIC_API_KEY: "shared", ANTHROPIC_API_KEY_DESK: "desk" }, { get(target, k) { touched.push(String(k)); return target[k]; }, has(target, k) { touched.push(String(k)); return k in target; } });
  createLiveClientFromEnv(spy, async () => {});
  liveCallsAllowed(spy, true);
  t.deepEqual([...new Set(touched)].sort(), ["ANTHROPIC_API_KEY_DESK", "DESK_LIVE_MODEL_ENABLED"]);
  t.equal(touched.includes("ANTHROPIC_API_KEY"), false);
});

test("nothing runs a request at import time", async () => {
  const real = globalThis.fetch; let calls = 0;
  globalThis.fetch = () => { calls++; throw new Error("no network at import"); };
  try {
    await import("../worker/src/desk/anthropic_client.js?fresh=1");
    await import("../worker/src/desk/budget.js?fresh=1");
    await import("../worker/src/desk/store.js?fresh=1");
  } finally { globalThis.fetch = real; }
  t.equal(calls, 0);
});

test("fake client: records every request, supports function scripts, throws when the script runs out", async () => {
  const c = createFakeClient([textResponse("a"), textResponse("b")]);
  t.equal(c.mode, "fake");
  const q = { model: "claude-haiku-5-5", max_tokens: 5, messages: [{ role: "user", content: "hi" }] };
  const a = await c.complete(q); q.messages[0].content = "mutated";
  t.equal(a.content[0].text, "a");
  t.equal(c.calls[0].messages[0].content, "hi", "recorded a clone");
  await c.complete(q);
  let err = null; try { await c.complete(q); } catch (e) { err = e; }
  t.match(err.message, /script exhausted/);
  t.equal(c.calls.length, 3);
  const f = createFakeClient((request, i) => ({ content: [{ type: "tool_use", id: `t${i}`, name: "rules__search", input: { q: "x" } }], stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } }));
  const r = await f.complete(q);
  t.equal(r.content[0].type, "tool_use"); t.equal(r.stop_reason, "tool_use");
});

// ── static scans ───────────────────────────────────────────────────────────────────────────────
const desk = (f) => fs.readFileSync(path.join(DESK_DIR, f), "utf8");
function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".js") ? [path.join(dir, e.name)] : [])); }

test("static: the gate's own files name no table but ai_call_log / ai_desk_questions and never create one", () => {
  const allowed = new Set(["ai_call_log", "ai_desk_questions", "s"]);   // "s" is the CTE alias in the ledger query
  for (const f of ["budget.js", "store.js", "anthropic_client.js", "prices.js"]) {
    const src = desk(f);
    t.doesNotMatch(src, /create\s+table/i, `${f} must not create tables`);
    t.doesNotMatch(src, /\b(ALTER|DROP)\s+TABLE\b/i, `${f}`);
    for (const m of src.matchAll(/\b(FROM|JOIN|INTO|UPDATE|TABLE)\s+([A-Za-z_][A-Za-z0-9_]*)/g)) t.ok(allowed.has(m[2]), `${f} names table "${m[2]}"`);
  }
  for (const [k, sql] of Object.entries(SQL)) {
    t.doesNotMatch(sql, /create\s+table/i, k);
    for (const m of sql.matchAll(/\b(FROM|JOIN|INTO|UPDATE)\s+([A-Za-z_][A-Za-z0-9_]*)/g)) t.ok(allowed.has(m[2]), `${k} names "${m[2]}"`);
  }
});

test("static: no desk file imports feature flags, the shared AI explainer, the Hall or any discord module", () => {
  const bad = /feature_flags|anthropic_explain|(^|\/)hall[._/]|discord/i;
  const files = walk(DESK_DIR);
  t.ok(files.length >= 5);
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g)) t.doesNotMatch(m[1], bad, `${path.relative(DESK_DIR, f)} imports ${m[1]}`);
  }
});

test("static: no desk file mentions the shared key name (only the _DESK one)", () => {
  for (const f of walk(DESK_DIR)) {
    const src = fs.readFileSync(f, "utf8");
    t.doesNotMatch(src, /ANTHROPIC_API_KEY(?!_DESK)/, path.relative(DESK_DIR, f));
  }
});

test("static: the real client file sends only to api.anthropic.com and has no top-level call", () => {
  const src = desk("anthropic_client.js");
  t.equal([...src.matchAll(/https?:\/\/[^"'\s)]+/g)].map((m) => m[0]).join(","), "https://api.anthropic.com/v1/messages");
  t.doesNotMatch(src, /^(await\s|fetch\(|doFetch\()/m);
  t.doesNotMatch(src, /for\s*\(.*retry|attempt/i, "no retry loop");
});

run("ai_desk_budget");
