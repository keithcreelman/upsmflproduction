// Commissioner Desk: a plain-text demonstration that the budget gate fails closed.
//   node scripts/ai_eval/budget_demo.mjs
// Offline and safe anywhere: a fake model client, an in-memory SQLite database with migrations 0180 + 0181 applied, no network, no secrets,
// no production. It exits non-zero if any claim below fails.
import { makeD1, applyMigrations } from "../../tests/fixtures/d1_sqlite.mjs";
import { createFakeClient, textResponse } from "../../tests/fixtures/ai_desk/fake_client.mjs";
import { makeCommishCaller } from "../../worker/src/desk/contract.js";
import { guardedCall } from "../../worker/src/desk/budget.js";
import { estimateWorstCaseUsd, estimateTokens } from "../../worker/src/desk/prices.js";

const NOW = Date.UTC(2026, 10, 19, 15, 0, 0);
const caller = makeCommishCaller("0008");
const SECRET = "SECRET-QUESTION-TEXT-ABOUT-FRANCHISE-0001";
const request = { model: "claude-sonnet-5-5", max_tokens: 1000, system: "be brief", messages: [{ role: "user", content: SECRET }] };
const est = estimateWorstCaseUsd({ model: request.model, inputTokensEstimate: estimateTokens(JSON.stringify(request).length), maxOutputTokens: request.max_tokens });
const usageCosting = (usd) => ({ input_tokens: 0, output_tokens: Math.round((usd / 10) * 1e6) });
const BIG = { DESK_BUDGET_PER_QUESTION_USD: "5", DESK_BUDGET_PER_RUN_USD: "10", DESK_BUDGET_MONTHLY_USD: "20", DESK_BUDGET_TOTAL_USD: "50" };
const usd = (n) => `$${n.toFixed(6)}`;

let failed = 0, n = 0;
const claim = (text, ok) => { n++; if (!ok) failed++; console.log(`  [${ok ? "PASS" : "FAIL"}] ${text}`); };
const section = (s) => console.log(`\n== ${s}`);
const freshDb = () => { const d = makeD1(); applyMigrations(d, ["0180_ai_call_log.sql", "0181_ai_desk_questions.sql"]); return d; };
const rows = (d, where = "1=1") => d.raw.prepare(`SELECT * FROM ai_call_log WHERE ${where} ORDER BY id`).all();
const go = (o) => guardedCall({ caller, nowMs: NOW, deskEnabled: true, request, meta: { step: "loop", questionId: "q1", runId: "r1" }, ...o });
const show = (label, r) => console.log(`    ${label}: ${r.ok ? `ok cost ${usd(r.costUsd)}` : `BLOCKED ${r.reason}`}`);

console.log("Commissioner Desk budget gate demo (offline; fake client; in-memory SQLite)");
console.log(`Worst-case estimate for the demo request on claude-sonnet-5-5: ${usd(est)} (prices are cached, unverified)`);

section("1. Default configuration: every cap is 0, so every call is blocked");
{ const d = freshDb(), c = createFakeClient([textResponse("x")]);
  const r = await go({ env: {}, db: d, client: c }); show("default env", r);
  claim("blocked with budget_per_question", r.blocked === true && r.reason === "budget_per_question");
  claim("the model was never sent a request", c.calls.length === 0);
  claim("the ledger shows one blocked row at cost 0", rows(d).length === 1 && rows(d)[0].mode === "blocked" && rows(d)[0].cost_usd === 0); }

section("2. Live calls need the switch, the desk key and the desk flag");
{ let contacted = 0; const live = { mode: "live", async complete() { contacted++; return textResponse("x"); } };
  const d = freshDb();
  const a = await go({ env: { ...BIG, ANTHROPIC_API_KEY_DESK: "demo" }, db: d, client: live }); show("key but no switch", a);
  const b = await go({ env: { ...BIG, DESK_LIVE_MODEL_ENABLED: "1" }, db: d, client: live }); show("switch but no key", b);
  const e = await go({ env: { ...BIG, DESK_LIVE_MODEL_ENABLED: "1", ANTHROPIC_API_KEY_DESK: "demo" }, db: d, client: live, deskEnabled: false }); show("switch and key, desk flag off", e);
  claim("no switch -> live_calls_disabled", a.reason === "live_calls_disabled");
  claim("no key -> no_key", b.reason === "no_key");
  claim("desk flag off -> desk_disabled", e.reason === "desk_disabled");
  claim("the live client was never contacted", contacted === 0); }

section("3. Per-question cap: the second step is blocked once the first consumed it");
{ const d = freshDb(), env = { ...BIG, DESK_BUDGET_PER_QUESTION_USD: String(est * 1.3) };
  const c = createFakeClient([textResponse("1", usageCosting(est * 0.9)), textResponse("2")]);
  const a = await go({ env, db: d, client: c }); show("step 1", a);
  const b = await go({ env, db: d, client: c }); show("step 2 (same question)", b);
  const o = await go({ env, db: d, client: c, meta: { step: "loop", questionId: "q2", runId: "r1" } }); show("step 1 of another question", o);
  claim("step 1 ok, step 2 blocked budget_per_question", a.ok && b.reason === "budget_per_question");
  claim("another question still has its own allowance", o.ok);
  claim("the model saw exactly 2 requests", c.calls.length === 2); }

section("4. Per-run cap spans questions in one run");
{ const d = freshDb(), env = { ...BIG, DESK_BUDGET_PER_RUN_USD: String(est * 1.3) };
  const c = createFakeClient([textResponse("1", usageCosting(est * 0.9)), textResponse("2")]);
  const a = await go({ env, db: d, client: c, meta: { step: "loop", questionId: "qa", runId: "runA" } }); show("run A, question 1", a);
  const b = await go({ env, db: d, client: c, meta: { step: "loop", questionId: "qb", runId: "runA" } }); show("run A, question 2", b);
  claim("second question in the same run blocked budget_per_run", a.ok && b.reason === "budget_per_run"); }

section("5. Monthly and total caps");
{ const d = freshDb(); d.raw.prepare("INSERT INTO ai_call_log (created_at, feature, step, model, mode, est_cost_usd, cost_usd) VALUES (?, 'commish_desk', 'loop', 'm', 'fake', 0, ?)").run(NOW / 1000 - 3600, est * 5);
  const m = await go({ env: { ...BIG, DESK_BUDGET_MONTHLY_USD: String(est * 2) }, db: d, client: createFakeClient([textResponse("x")]) }); show("this month already spent", m);
  const tt = await go({ env: { ...BIG, DESK_BUDGET_TOTAL_USD: String(est * 5.5) }, db: d, client: createFakeClient([textResponse("x")]) }); show("total nearly used", tt);
  claim("monthly cap blocks: budget_monthly", m.reason === "budget_monthly");
  claim("total cap blocks: budget_total", tt.reason === "budget_total"); }

section("6. Ledger unreadable: fail closed");
{ const d = freshDb(); d.raw.exec("DROP TABLE ai_call_log"); const c = createFakeClient([textResponse("x")]);
  const r = await go({ env: BIG, db: d, client: c }); show("ai_call_log dropped", r);
  claim("blocked ledger_unreadable", r.reason === "ledger_unreadable");
  claim("the model was never sent a request", c.calls.length === 0); }

section("7. A concurrent burst cannot overshoot (12 overlapping calls, room for 3)");
{ const d = freshDb(), env = { ...BIG, DESK_BUDGET_TOTAL_USD: String(est * 3.5) };
  const c = createFakeClient(async () => { await new Promise((r) => setTimeout(r, 5)); return textResponse("x", usageCosting(est * 0.5)); });
  const res = await Promise.all(Array.from({ length: 12 }, (_, i) => go({ env, db: d, client: c, meta: { step: "loop", questionId: `b${i}`, runId: "burst" } })));
  const okN = res.filter((r) => r.ok).length, led = rows(d, "mode = 'fake'");
  const committed = led.reduce((s, r) => s + (r.cost_usd ?? r.est_cost_usd), 0);
  console.log(`    ${okN} calls allowed, ${12 - okN} blocked, committed ${usd(committed)} of cap ${usd(est * 3.5)}`);
  claim("exactly 3 calls reached the model", okN === 3 && c.calls.length === 3);
  claim("committed spend never exceeded the cap", committed <= est * 3.5 + 1e-9); }

section("8. The ledger: reservation first, then the real cost; blocked calls send nothing");
{ const d = freshDb(); const during = [];
  const c = createFakeClient(() => { during.push(rows(d)[0]); return textResponse("an answer", { input_tokens: 1000, output_tokens: 500 }); });
  const r = await go({ env: BIG, db: d, client: c, meta: { step: "router", questionId: "q8", runId: "r8", promptHash: "sha256:demo" } });
  const after = rows(d)[0];
  console.log(`    during the call: cost_usd=${during[0].cost_usd}, est_cost_usd=${usd(during[0].est_cost_usd)}`);
  console.log(`    after the call:  cost_usd=${usd(after.cost_usd)}, est_cost_usd=${usd(after.est_cost_usd)}, tokens in/out=${after.input_tokens}/${after.output_tokens}`);
  claim("in flight the row held a reservation (cost NULL, estimate > 0)", during[0].cost_usd === null && during[0].est_cost_usd > 0);
  claim("afterwards it holds the real cost from usage ($0.002 + $0.005)", r.ok && Math.abs(after.cost_usd - 0.007) < 1e-12);
  const blockedClient = createFakeClient([textResponse("x")]);
  const bad = await go({ env: BIG, db: d, client: blockedClient, request: { ...request, max_tokens: 99999 } });
  claim("an over-ceiling request is blocked and sends nothing to the model", bad.reason === "bad_request" && blockedClient.calls.length === 0); }

section("9. No question or answer text in the ledger");
{ const d = freshDb(); const c = createFakeClient([textResponse("ANSWER-TEXT-SHOULD-NOT-BE-LOGGED")]);
  await go({ env: BIG, db: d, client: c, meta: { step: "loop", questionId: "q9", runId: "r9", promptHash: "sha256:abc" } });
  await go({ env: {}, db: d, client: c });
  const dump = JSON.stringify(rows(d));
  claim("the question text is not in any ledger column", !dump.includes(SECRET) && !dump.includes("FRANCHISE-0001"));
  claim("the answer text is not in any ledger column", !dump.includes("ANSWER-TEXT-SHOULD-NOT-BE-LOGGED"));
  claim("the model itself did receive the question (the fake recorded it)", JSON.stringify(c.calls[0]).includes(SECRET)); }

console.log(`\n${n - failed}/${n} claims hold${failed ? `, ${failed} FAILED` : ""}.`);
process.exit(failed ? 1 : 0);
