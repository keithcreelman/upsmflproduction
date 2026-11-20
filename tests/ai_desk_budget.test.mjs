// Commissioner Desk: the budget gate, the price table, the real client's wiring (stub fetch only) and the static guarantees.
//   node tests/ai_desk_budget.test.mjs
// Offline and deterministic: real SQLite (node:sqlite) with the real migrations 0180 + 0181, a fake model client, a stub fetch. No network, no money.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, run, t } from "./fixtures/mini_test.mjs";
import { makeD1, applyMigrations } from "./fixtures/d1_sqlite.mjs";
import { createFakeClient, textResponse, serializeBatches } from "./fixtures/ai_desk/fake_client.mjs";
import { makeCommishCaller, DeskAuthError } from "../worker/src/desk/contract.js";
import { PRICES, PRICES_AS_OF, PRICES_VERIFIED, INPUT_OVERHEAD_TOKENS, costUsd, estimateWorstCaseUsd, estimateInputTokensFromBytes, utf8Bytes, validateUsage, isPricedModel, DeskPriceError } from "../worker/src/desk/prices.js";
import { getLimits, liveCallsAllowed, guardedCall, MAX_TOKENS_CEILING, MAX_REQUEST_BYTES } from "../worker/src/desk/budget.js";
import { createStore, SQL, periodOf } from "../worker/src/desk/store.js";
import { createAnthropicClient, createLiveClientFromEnv, desiredKeyName, DeskModelError, ANTHROPIC_URL, buildBody } from "../worker/src/desk/anthropic_client.js";

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
const estFor = (r) => estimateWorstCaseUsd({ model: r.model, inputTokensEstimate: estimateInputTokensFromBytes(utf8Bytes(JSON.stringify(buildBody(r)))), maxOutputTokens: r.max_tokens });
const BIG = { DESK_BUDGET_PER_QUESTION_USD: "5", DESK_BUDGET_PER_RUN_USD: "10", DESK_BUDGET_MONTHLY_USD: "20", DESK_BUDGET_TOTAL_USD: "50" };
const call = (o) => guardedCall({ caller, nowMs: NOW, deskEnabled: true, meta: { step: "loop", questionId: "q1", runId: "r1" }, request: req(), ...o });
// Usage that costs about `frac` of the sonnet estimate for req(): output tokens priced at $10 per million.
const usageCosting = (usd) => ({ input_tokens: 0, output_tokens: Math.round((usd / 10) * 1e6) });
// Seed a ledger row AND keep ai_budget_totals consistent with it (the gate reads the totals, not the ledger, for total and month).
const seed = (d, o) => {
  const mode = o.mode ?? "fake", at = o.createdAt ?? NOW_S - 60, est = o.est ?? 0, cost = o.cost ?? null;
  d.raw.prepare(`INSERT INTO ai_call_log (created_at, feature, run_id, question_id, step, model, mode, est_cost_usd, cost_usd) VALUES (?, 'commish_desk', ?, ?, 'loop', 'claude-sonnet-5-5', ?, ?, ?)`)
    .run(at, o.runId ?? null, o.questionId ?? null, mode, est, cost);
  const period = periodOf(at * 1000);
  for (const per of ["total", period]) {
    d.raw.prepare("INSERT OR IGNORE INTO ai_budget_totals (mode, period) VALUES (?, ?)").run(mode, per);
    d.raw.prepare(`UPDATE ai_budget_totals SET ${cost == null ? "reserved_usd = reserved_usd + ?" : "spent_usd = spent_usd + ?"} WHERE mode = ? AND period = ?`).run(cost == null ? est : cost, mode, per);
  }
};
const usageCostSonnet = (usd) => Math.round((usd / 10) * 1e6) * 10 / 1e6;
const totals = (d, mode = "fake") => Object.fromEntries(d.raw.prepare("SELECT period, reserved_usd, spent_usd FROM ai_budget_totals WHERE mode = ? ORDER BY period").all(mode).map((r) => [r.period, { reserved: r.reserved_usd, spent: r.spent_usd }]));

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
  approx(costUsd("claude-sonnet-5-5", { input_tokens: 0, output_tokens: 0 }), 0, "a valid zero usage is zero");
});

test("unknown model and missing usage are errors, never a guess", () => {
  t.throws(() => costUsd("gpt-whatever", { input_tokens: 1 }), (e) => e instanceof DeskPriceError && e.code === "unknown_model");
  t.throws(() => costUsd("claude-sonnet-5-5", null), (e) => e instanceof DeskPriceError && e.code === "bad_usage");
  for (const bad of [{}, { input_tokens: 5 }, { output_tokens: 5 }, { input_tokens: -1, output_tokens: 1 }, { input_tokens: 1, output_tokens: -1 }, { input_tokens: NaN, output_tokens: 1 },
    { input_tokens: 1, output_tokens: Infinity }, { input_tokens: 1.5, output_tokens: 1 }, { input_tokens: "10", output_tokens: 1 }, { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: -2 },
    { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0.5 }, { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: "x" }, [1, 2], "usage"]) {
    t.throws(() => costUsd("claude-sonnet-5-5", bad), (e) => e instanceof DeskPriceError && e.code === "bad_usage", JSON.stringify(bad));
    t.equal(validateUsage(bad).ok, false);
  }
  t.equal(validateUsage({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: null }).ok, true, "absent or null cache counts are fine");
  t.throws(() => estimateWorstCaseUsd({ model: "nope", inputTokensEstimate: 1, maxOutputTokens: 1 }), (e) => e.code === "unknown_model");
});

test("worst case: every input token at the input rate, every allowed output token at the output rate", () => {
  approx(estimateWorstCaseUsd({ model: "claude-haiku-5-5", inputTokensEstimate: 1000, maxOutputTokens: 1000 }), 0.0001 + 0.0005, "haiku");
  approx(estimateWorstCaseUsd({ model: "claude-sonnet-5-5", inputTokensEstimate: 3000, maxOutputTokens: 4000 }), 0.006 + 0.04, "sonnet");
  approx(estimateWorstCaseUsd({ model: "claude-opus-5-5", inputTokensEstimate: 10000, maxOutputTokens: 2000 }), 0.04 + 0.04, "opus");
  // with prompt caching in the request the dearer cache-write rate is used (still an upper bound)
  approx(estimateWorstCaseUsd({ model: "claude-sonnet-5-5", inputTokensEstimate: 1e6, maxOutputTokens: 0, usesCache: true }), 2.5, "cache write rate");
});

test("input-token estimate is a hard bound: UTF-8 bytes of the body plus a fixed overhead", () => {
  t.equal(INPUT_OVERHEAD_TOKENS, 1000);
  t.equal(estimateInputTokensFromBytes(0), 1000);
  t.equal(estimateInputTokensFromBytes(48000), 49000);
  t.equal(utf8Bytes("abc"), 3); t.equal(utf8Bytes("\u00e9"), 2); t.equal(utf8Bytes("\u4e2d"), 3); t.equal(utf8Bytes("\u{1F600}"), 4);
  // token-dense inputs: whatever the tokenizer does, tokens <= bytes, and the estimate is >= bytes (+ overhead)
  const dense = {
    cjk: "\u4e2d\u6587\u6d4b\u8bd5\u6587\u672c".repeat(2000), base64: Buffer.from(Array.from({ length: 6000 }, (_, i) => (i * 7919) % 256)).toString("base64"),
    digits: "8675309142".repeat(2500), emoji: "\u{1F600}\u{1F680}\u{1F9E0}".repeat(1500), mixed: "a1\u00fc\u4e2d\u{1F600}=+/".repeat(2000), json: JSON.stringify(Array.from({ length: 3000 }, (_, i) => ({ k: i, v: [i, -i] }))),
  };
  for (const [name, text] of Object.entries(dense)) {
    const r = req({ messages: [{ role: "user", content: text }] });
    const bytes = utf8Bytes(JSON.stringify(buildBody(r)));
    const estTok = estimateInputTokensFromBytes(bytes);
    t.ok(estTok >= bytes, `${name}: estimate ${estTok} >= bytes ${bytes}`);
    t.ok(estTok >= bytes + INPUT_OVERHEAD_TOKENS);
    t.ok(estTok >= text.length, `${name}: also >= characters`);
    t.ok(estFor(r) >= (bytes * 2) / 1e6, `${name}: dollars cover every byte as a token`);
  }
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
    [req({ messages: [{ role: "user", content: "x".repeat(MAX_REQUEST_BYTES) }] }), "bad_request"],
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
  // the totals table missing (an old 0180 without ai_budget_totals): fail closed, ledger itself intact
  const nt = freshDb(); nt.raw.exec("DROP TABLE ai_budget_totals");
  const rn = await call({ env: BIG, db: nt, client: c });
  t.deepEqual([rn.reason, rn.detail], ["ledger_unreadable", "not_ready"]); t.equal(c.calls.length, 0);
  // writes failing (reservation cannot be recorded, so no call)
  const w = freshDb(); w.opts.beforeRun = (sql) => { if (/INSERT INTO ai_call_log/i.test(sql)) throw new Error("D1_ERROR: simulated write failure"); };
  const r3 = await call({ env: BIG, db: w, client: c });
  t.equal(r3.reason, "ledger_unreadable"); t.equal(c.calls.length, 0);
  t.deepEqual(totals(w).total, undefined, "the failed batch rolled back, including the totals rows");
  // no db at all
  const r4 = await call({ env: BIG, db: undefined, client: c });
  t.equal(r4.reason, "ledger_unreadable"); t.equal(c.calls.length, 0);
});

test("a concurrent burst cannot overshoot: reservations are checked and written in one statement", async () => {
  const d = serializeBatches(freshDb()), est = estFor(req());   // D1 runs one batch at a time; the sqlite fixture's batch can interleave across awaits, so serialize it
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
  const tot = totals(d).total; approx(tot.reserved, 0); approx(tot.spent, 3 * usageCostSonnet(est * 0.5), "totals match the three finalized calls");
});

test("the totals table is maintained with the ledger: reserve raises reserved, finalize moves it to spent, a refused reserve changes nothing", async () => {
  const d = freshDb(), est = estFor(req()), ym = periodOf(NOW);
  const during = [];
  const c = createFakeClient(() => { during.push(totals(d)); return textResponse("x", usageCosting(est * 0.5)); });
  const spent = usageCostSonnet(est * 0.5);
  t.equal((await call({ env: BIG, db: d, client: c })).ok, true);
  approx(during[0].total.reserved, est, "in flight: reserved at the estimate"); approx(during[0].total.spent, 0);
  approx(during[0][ym].reserved, est);
  t.deepEqual(Object.keys(totals(d)).sort(), [ym, "total"].sort(), "only the total row and this month");
  approx(totals(d).total.reserved, 0, "released at finalize"); approx(totals(d).total.spent, spent, "spent = real cost");
  approx(totals(d)[ym].spent, spent);
  // a refused reservation (cap) changes no totals
  const before = JSON.stringify(totals(d));
  const r = await call({ env: { ...BIG, DESK_BUDGET_TOTAL_USD: String(spent + est * 0.5) }, db: d, client: c });
  t.equal(r.reason, "budget_total");
  t.equal(JSON.stringify(totals(d)), before, "refused: no increment");
  t.equal(rows(d, "mode = 'fake'").length, 1);
  // lanes: a live call touches only live totals
  const live = { mode: "live", async complete() { return textResponse("x", usageCosting(est * 0.25)); } };
  const liveEnv = { ...BIG, DESK_LIVE_MODEL_ENABLED: "1", ANTHROPIC_API_KEY_DESK: "k" };
  t.equal((await call({ env: liveEnv, db: d, client: live })).ok, true);
  approx(totals(d, "live").total.spent, usageCostSonnet(est * 0.25)); approx(totals(d).total.spent, spent, "fake lane untouched");
  // finalize is once-only: a second finalize does not double-count
  const store = createStore(d);
  const id = rows(d, "mode = 'fake'")[0].id;
  t.equal(await store.finalizeCall(caller, id, { costUsd: 99 }), false);
  approx(totals(d).total.spent, spent, "a repeated finalize changes no totals");
});

test("an unfinalized reservation older than this month keeps counting in its own month and in total", async () => {
  const d = freshDb(), est = estFor(req());
  seed(d, { createdAt: Date.UTC(2026, 9, 30) / 1000, est, cost: null });
  const t0 = totals(d);
  approx(t0.total.reserved, est); approx(t0["2026-10"].reserved, est);
  const env = { ...BIG, DESK_BUDGET_TOTAL_USD: String(est * 1.5), DESK_BUDGET_MONTHLY_USD: String(est * 1.5) };
  const r = await call({ env, db: d, client: createFakeClient([textResponse("x")]) });
  t.equal(r.reason, "budget_total", "old in-flight reservation counts toward the total, not this month");
});

test("error accounting: only a definite 4xx refusal is free; everything else keeps the reservation as its cost", async () => {
  const est = estFor(req());
  const leak = "sk-ant-SECRET-body-text";
  const free = [400, 401, 403, 404, 413, 422];
  const charged = [new DeskModelError("http_error", { status: 408 }), new DeskModelError("http_error", { status: 409 }), new DeskModelError("http_error", { status: 429 }),
    new DeskModelError("http_error", { status: 500 }), new DeskModelError("http_error", { status: 502 }), new DeskModelError("http_error", { status: 503 }), new DeskModelError("http_error", { status: 529 }),
    new DeskModelError("http_error", { status: 0 }), new DeskModelError("http_error"), new DeskModelError("timeout"), new DeskModelError("network"), new DeskModelError("bad_response", { status: 200 }),
    new Error(`provider said ${leak}`)];
  for (const status of free) {
    const d = freshDb();
    const r = await call({ env: BIG, db: d, client: createFakeClient([new DeskModelError("http_error", { status, providerType: "invalid_request_error" })]) });
    t.deepEqual([r.ok, r.reason, r.detail], [false, "model_error", "http_error"], `http ${status}`);
    const [row] = rows(d);
    t.equal(row.cost_usd, 0, `http ${status} is free`); t.equal(row.error_code, "http_error");
    t.deepEqual(totals(d).total, { reserved: 0, spent: 0 });
  }
  for (const err of charged) {
    const d = freshDb();
    const c = createFakeClient([err]);
    const r = await call({ env: BIG, db: d, client: c });
    t.equal(r.reason, "model_error", String(err && err.code || err));
    t.equal(JSON.stringify(r).includes(leak), false, "provider text is never echoed");
    const [row] = rows(d);
    approx(row.cost_usd, est, `${err && err.code || "unknown"} ${err && err.status || ""} keeps the reservation`);
    t.equal(JSON.stringify(row).includes(leak), false);
    const tot = totals(d).total; approx(tot.spent, est); approx(tot.reserved, 0);
  }
  // a refused-for-free call really does leave its allowance intact for the next one
  const d = freshDb();
  const env = { ...BIG, DESK_BUDGET_PER_QUESTION_USD: String(est * 1.5) };
  const c = createFakeClient([new DeskModelError("http_error", { status: 400 }), textResponse("ok", usageCosting(est * 0.9)), textResponse("no")]);
  t.equal((await call({ env, db: d, client: c })).reason, "model_error");
  t.equal((await call({ env, db: d, client: c })).ok, true, "the 400 cost nothing, so the allowance was intact");
  t.equal((await call({ env, db: d, client: c })).reason, "budget_per_question", "after a paid call the question allowance is spent");
});

test("a response with malformed or missing usage is returned, charged the reservation, and flagged usage_unverified", async () => {
  const est = estFor(req());
  const badUsages = [undefined, null, {}, { output_tokens: 5 }, { input_tokens: 5 }, { input_tokens: -1, output_tokens: 5 }, { input_tokens: NaN, output_tokens: 5 }, { input_tokens: 1.5, output_tokens: 5 },
    { input_tokens: "7", output_tokens: 5 }, { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: -3 }];
  for (const usage of badUsages) {
    const d = freshDb();
    const c = { mode: "fake", async complete() { return { content: [{ type: "text", text: "paid answer" }], stop_reason: "end_turn", usage, model: "claude-sonnet-5-5" }; } };
    const r = await call({ env: BIG, db: d, client: c });
    t.equal(r.ok, true, JSON.stringify(usage)); t.equal(r.ledgerWarning, "usage_unverified"); t.equal(r.response.content[0].text, "paid answer");
    approx(r.costUsd, est, "charged the reservation, never 0");
    const [row] = rows(d);
    approx(row.cost_usd, est); t.equal(row.error_code, "usage_unverified"); t.equal(row.input_tokens, null, "untrusted token counts are not stored");
    approx(totals(d).total.spent, est);
  }
  // the real client: a 2xx with bad usage throws a typed bad_usage error carrying the answer (not enumerable); the gate turns it into the same outcome
  const stub = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ model: "claude-sonnet-5-5", content: [{ type: "text", text: "paid answer" }], stop_reason: "end_turn", usage: { input_tokens: 5 } }) });
  const live = createAnthropicClient({ apiKey: "k", fetch: stub });
  let err = null; try { await live.complete(req()); } catch (e) { err = e; }
  t.ok(err instanceof DeskModelError); t.equal(err.code, "bad_usage"); t.equal(err.status, 200);
  t.equal(JSON.stringify(err).includes("paid answer"), false, "the attached answer never serializes");
  t.equal(err.response.content[0].text, "paid answer");
  const d = freshDb();
  const liveEnv = { ...BIG, DESK_LIVE_MODEL_ENABLED: "1", ANTHROPIC_API_KEY_DESK: "k" };
  const r = await call({ env: liveEnv, db: d, client: live });
  t.equal(r.ok, true); t.equal(r.ledgerWarning, "usage_unverified"); approx(r.costUsd, est);
  t.equal(rows(d)[0].mode, "live"); approx(rows(d)[0].cost_usd, est);
});

test("real client validates usage: required counts, optional cache counts", async () => {
  const mk = (usage) => createAnthropicClient({ apiKey: "k", fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ content: [], stop_reason: "end_turn", usage }) }) });
  for (const usage of [undefined, {}, { input_tokens: 1 }, { output_tokens: 1 }, { input_tokens: -1, output_tokens: 1 }, { input_tokens: 1.5, output_tokens: 1 }, { input_tokens: "1", output_tokens: 1 },
    { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: -1 }, { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 2.5 }]) {
    let e = null; try { await mk(usage).complete(req()); } catch (x) { e = x; }
    t.ok(e instanceof DeskModelError && e.code === "bad_usage", JSON.stringify(usage));
  }
  const ok = await mk({ input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: null, service_tier: "standard" }).complete(req());
  t.equal(ok.usage.input_tokens, 5);
});

test("a failed finalize keeps the paid answer and leaves the reservation counting (the batch rolled back)", async () => {
  const est = estFor(req());
  const d2 = freshDb();
  const c2 = createFakeClient([textResponse("paid answer", usageCosting(est * 0.1))]);
  d2.opts.beforeRun = (sql) => { if (/^\s*UPDATE ai_call_log SET input_tokens/i.test(sql)) throw new Error("D1_ERROR: simulated"); };
  const r2 = await call({ env: BIG, db: d2, client: c2 });
  t.equal(r2.ok, true); t.equal(r2.ledgerWarning, "finalize_failed");
  const [row] = rows(d2);
  t.equal(row.cost_usd, null, "reservation stays unfinalized");
  approx(row.est_cost_usd, est);
  approx(totals(d2).total.reserved, est); approx(totals(d2).total.spent, 0);
});

test("a 5,000-row ledger still reads only a handful of rows per call (totals by primary key; run and question by index)", async () => {
  const d = freshDb();
  d.raw.exec("BEGIN");
  for (let i = 0; i < 5000; i++) seed(d, { createdAt: NOW_S - 86400 * 40 - i, runId: `run${i % 500}`, questionId: `qq${i % 1000}`, mode: i % 2 ? "fake" : "live", cost: 0.01 });
  d.raw.exec("COMMIT");
  t.equal(d.raw.prepare("SELECT COUNT(*) AS n FROM ai_call_log").get().n, 5000);
  const mode = "fake", period = periodOf(NOW);
  // 1) every statement of the reserve/finalize/read path searches by index: no SCAN of ai_call_log, none of ai_budget_totals
  const est = 0.01, caps = [9, 9, 9, 9];
  const reserveArgs = [NOW_S, "commish_desk", "run1", "qq1", "loop", "m", mode, null, null, null, est, mode, "total", est, 9, mode, period, est, 9, "run1", mode, est, 9, "qq1", mode, est, 9];
  const plans = {
    reserve: [SQL.reserve, reserveArgs], reserveTotals: [SQL.reserveTotals, [est, mode, period]], readSums: [SQL.readSums, [mode, "total", mode, period, "run1", mode, "qq1", mode]],
    finalize: [SQL.finalize, [1, 1, 0, 0, 0.1, 5, null, 1]], finalizeTotals: [SQL.finalizeTotals, [1, 0.1, 1, 1]], ensureTotals: [SQL.ensureTotals, [mode, "total"]],
  };
  for (const [name, [sql, args]] of Object.entries(plans)) {
    const plan = d.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((p) => p.detail);
    t.equal(plan.filter((x) => /^SCAN (ai_call_log|ai_budget_totals)(?! USING)/.test(x)).length, 0, `${name}: no table scan: ${plan.join(" | ")}`);
  }
  const rp = d.raw.prepare(`EXPLAIN QUERY PLAN ${SQL.reserve}`).all(...reserveArgs).map((p) => p.detail).join(" | ");
  t.match(rp, /SEARCH ai_call_log USING INDEX idx_ai_call_log_run \(run_id=\?\)/, rp);
  t.match(rp, /SEARCH ai_call_log USING INDEX idx_ai_call_log_question \(question_id=\?\)/, rp);
  t.match(rp, /SEARCH ai_budget_totals USING (COVERING )?INDEX sqlite_autoindex_ai_budget_totals_1 \(mode=\? AND period=\?\)/, rp);
  // 2) rows those index searches visit: the run's and the question's own rows (10 and 5 here), plus 2 totals rows. Not 5,000.
  const runRows = d.raw.prepare("SELECT COUNT(*) AS n FROM ai_call_log WHERE run_id = 'run1'").get().n;
  const qRows = d.raw.prepare("SELECT COUNT(*) AS n FROM ai_call_log WHERE question_id = 'qq1'").get().n;
  t.equal(runRows, 10); t.equal(qRows, 5);
  t.ok(runRows + qRows + 2 <= 20, "about 17 rows read for a 5,000-row ledger");
  // 3) the total and monthly caps come from the totals rows, not the ledger: they are the only thing that decides
  const env = { ...BIG, DESK_BUDGET_TOTAL_USD: "1", DESK_BUDGET_MONTHLY_USD: "1" };
  const c = createFakeClient([textResponse("x")]);
  t.ok(d.raw.prepare("SELECT SUM(cost_usd) AS s FROM ai_call_log WHERE mode = 'fake'").get().s > 20, "the ledger itself holds far more than the cap");
  d.raw.prepare("UPDATE ai_budget_totals SET spent_usd = 0").run();   // ...but only the totals rows are consulted
  t.equal((await call({ env, db: d, client: c })).ok, true, "5,000 ledger rows are invisible to the total cap when the totals row is small");
  d.raw.prepare("UPDATE ai_budget_totals SET spent_usd = 5 WHERE mode = 'fake' AND period = 'total'").run();
  t.equal((await call({ env, db: d, client: c, meta: { questionId: "other", runId: "other" } })).reason, "budget_total", "and the totals row alone can close it");
  d.raw.prepare("UPDATE ai_budget_totals SET spent_usd = 0 WHERE mode = 'fake' AND period = 'total'").run();
  d.raw.prepare("UPDATE ai_budget_totals SET spent_usd = 5 WHERE mode = 'fake' AND period = ?").run(period);
  t.equal((await call({ env, db: d, client: c, meta: { questionId: "other2", runId: "other2" } })).reason, "budget_monthly");
  // 4) a missing totals row is treated as full, never as empty
  d.raw.prepare("DELETE FROM ai_budget_totals WHERE mode = 'fake'").run();
  const store = createStore(d);
  const sums = await store.readLedgerSums(caller, { mode: "fake", runId: "run1", questionId: "qq1", nowMs: NOW });
  approx(sums.total, 0);
});

test("ai_call_log is never purged by the desk's purge (the totals make that safe)", async () => {
  const d = freshDb(), store = createStore(d);
  seed(d, { createdAt: NOW_S - 400 * 86400, cost: 0.5 });
  await store.purgeOlderThan(caller, 1, { nowMs: NOW });
  t.equal(d.raw.prepare("SELECT COUNT(*) AS n FROM ai_call_log").get().n, 1);
  approx(totals(d).total.spent, 0.5);
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
  const allowed = new Set(["ai_call_log", "ai_budget_totals", "ai_desk_questions"]);
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
