// Commissioner Desk: the free PREFLIGHT HARDENING (request contract, adversarial model, independent grade, structural diagnostics). Offline, deterministic, no network.
//   node tests/ai_desk_preflight.test.mjs
//
// Why this file exists: three paid runs stopped on (R1) a request the provider refuses, (R2) a replayed assistant turn the provider refuses (likely), and (R3) a rule
// duplicated in the runner. Each section below says which defect it would have caught. It also states what it cannot do: it does not prove the provider accepts a request.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, run, t } from "./fixtures/mini_test.mjs";
import { makeD1, applyMigrations } from "./fixtures/d1_sqlite.mjs";
import { createFakeClient, textResponse } from "./fixtures/ai_desk/fake_client.mjs";
import { makeCommishCaller } from "../worker/src/desk/contract.js";
import { guardedCall } from "../worker/src/desk/budget.js";
import { DeskModelError } from "../worker/src/desk/anthropic_client.js";
import { FORCED_TOOL_MODELS } from "../worker/src/desk/prompts.js";
import { checkRequestContract, describeRequest, shapeLine, classifyResponse, COVERED, NOT_COVERED, MAX_CACHE_BREAKPOINTS } from "../worker/src/desk/request_contract.js";
import { hasDigitOutsideTokens, termRegex } from "../worker/src/desk/validator.js";
import { cleanBlock } from "../worker/src/desk/loop.js";
import { gradeAnswer, GRADES } from "../scripts/ai_eval/lib/grade.mjs";
import { runMatrix, SCENARIOS, PREFLIGHT_SCENARIO_IDS } from "../scripts/ai_eval/lib/adversarial.mjs";
import { createAdversarialClient, BEHAVIORS } from "../scripts/ai_eval/lib/scripted_model.mjs";
import { runCase, makeLedgerDb } from "../scripts/ai_eval/lib/scenario_env.mjs";
import { loadBank } from "../scripts/ai_eval/lib/bank.mjs";
import { invariantFailures, DRY_DEFAULT_CAPS } from "../scripts/ai_eval/run_eval.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SET = JSON.parse(fs.readFileSync(path.join(REPO, "scripts/ai_eval/sets/first10.json"), "utf8"));
const BANK = loadBank(path.join(REPO, "tests/fixtures/ai_desk/eval_bank_dev.jsonl"));
const CASES = SET.cases.map((spec) => ({ caseDef: BANK.cases.find((c) => c.id === spec.id), spec }));

// ── request builders ───────────────────────────────────────────────────────────────────────────────
const user = (content) => ({ role: "user", content });
const asst = (content) => ({ role: "assistant", content });
const T = (text) => ({ type: "text", text });
const TU = (id, name = "rules__search", input = { q: "x" }) => ({ type: "tool_use", id, name, input });
const TR = (id, text = "a result") => ({ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] });
const TOOL = (name) => ({ name, description: "d", input_schema: { type: "object", properties: {} } });
const REQ = (over = {}) => ({ model: "claude-sonnet-5-5", max_tokens: 1000, system: [{ type: "text", text: "system prompt", cache_control: { type: "ephemeral" } }],
  tools: [TOOL("rules__search"), TOOL("emit_card")], messages: [user([T("a question")])], ...over });
const codes = (r) => r.errors.map((e) => e.code);
const has = (r, code) => codes(r).includes(code);
const SECRETS = ["ZEBRA-QUESTION-TEXT", "sk-ant-SECRET-KEY-0000", "PRIVATE-LEAGUE-NAME", "THINKING-CONTENT-XYZ", "RAW-TOOL-RESULT-ABC"];

// ── 1. the contract ────────────────────────────────────────────────────────────────────────────────
test("contract: valid shapes pass (a first message; a tool round with results first; thinking before calls; a forced tool only on Haiku; two cache markers)", () => {
  t.ok(checkRequestContract(REQ()).ok);
  const round = REQ({ messages: [user([T("q")]), asst([T("looking"), TU("t1"), TU("t2", "emit_card", { a: 1 })]), user([TR("t1"), TR("t2")])] });
  t.ok(checkRequestContract(round).ok, JSON.stringify(checkRequestContract(round)));
  const think = REQ({ messages: [user([T("q")]), asst([{ type: "thinking", thinking: "", signature: "SIG" }, { type: "redacted_thinking", data: "RED" }, T("ok"), TU("t1")]), user([TR("t1")])] });
  t.ok(checkRequestContract(think).ok, JSON.stringify(checkRequestContract(think)));
  t.ok(checkRequestContract(REQ({ model: "claude-haiku-5-5", tool_choice: { type: "tool", name: "emit_card" } })).ok, "Haiku accepts a forced tool in R1");
  t.ok(checkRequestContract(REQ({ tool_choice: { type: "auto" } })).ok);
  t.deepEqual([...FORCED_TOOL_MODELS], ["claude-haiku-5-5"]);
  const last = REQ({ messages: [user([T("q")]), asst([TU("t1")]), user([TR("t1", "r")].concat([T("then text after the results")]))] });
  t.ok(checkRequestContract(last).ok, "text AFTER the tool results is fine");
});

test("contract: R1 would have been caught. The composer's old request (a forced tool choice on Sonnet 5.5) is an error; Haiku is fine; Opus and unknown models are errors", () => {
  const r1 = REQ({ tools: [TOOL("emit_card")], tool_choice: { type: "tool", name: "emit_card" } });          // the exact shape R1 sent to claude-sonnet-5-5
  t.ok(has(checkRequestContract(r1), "TOOL_CHOICE_FORCED_MODEL"));
  for (const model of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-unknown-9"]) t.ok(has(checkRequestContract(REQ({ model, tool_choice: { type: "any" } })), "TOOL_CHOICE_FORCED_MODEL"), model);
  t.ok(has(checkRequestContract(REQ({ model: "claude-haiku-5-5", tool_choice: { type: "tool", name: "not_offered" } })), "TOOL_CHOICE_UNKNOWN_TOOL"));
  t.ok(has(checkRequestContract(REQ({ model: "claude-haiku-5-5", tools: undefined, tool_choice: { type: "any" } })), "TOOL_CHOICE_WITHOUT_TOOLS"));
});

test("contract: R2 would have been caught. A replayed assistant turn with an EMPTY text block (what the old loop made of a thinking block) is an error; the fixed shape passes", () => {
  const calls = Array.from({ length: 9 }, (_, i) => TU(`t${i}`, "rules__search", { season: 2017 + i }));
  const results = calls.map((c) => TR(c.id));
  const old = REQ({ messages: [user([T("q")]), asst([T(""), ...calls]), user(results)] });                   // a thinking block turned into text with no characters
  const r = checkRequestContract(old);
  t.ok(!r.ok && has(r, "TEXT_EMPTY"));
  const fixed = REQ({ messages: [user([T("q")]), asst([{ type: "thinking", thinking: "", signature: "SIG" }, ...calls]), user(results)] });
  t.ok(checkRequestContract(fixed).ok, "the thinking block passed back as received is valid");
  // And what the loop now makes of the model's thinking turn: cleanBlock never produces an empty text block.
  const turn = [{ type: "thinking", thinking: "", signature: "SIG" }, { type: "text", text: "" }, ...calls].map(cleanBlock).filter(Boolean);
  t.ok(checkRequestContract(REQ({ messages: [user([T("q")]), asst(turn), user(results)] })).ok);
});

test("contract: every other rule, one by one", () => {
  const E = (mut, code, label) => { const r = checkRequestContract(mut); t.ok(has(r, code), `${label || code}: ${JSON.stringify(codes(r))}`); };
  const msgs = (...m) => REQ({ messages: m });
  E(msgs(user([T("q")]), asst([T("done")])), "LAST_NOT_USER", "a prefill (the last message is the assistant's)");
  E(msgs(asst([T("hi")]), user([T("q")])), "FIRST_NOT_USER");
  E(msgs(), "MESSAGES_EMPTY"); E(REQ({ messages: undefined }), "MESSAGES_EMPTY");
  E(msgs(user([T("   ")])), "TEXT_EMPTY", "a blank text block"); E(msgs(user("")), "TEXT_EMPTY", "empty string content"); E(msgs(user([])), "CONTENT_EMPTY");
  E(msgs(user([T("q")]), asst([TU("t1")]), user([TR("t1"), TR("t1")])), "TOOL_RESULT_DUPLICATE", "a result repeated for one call");
  E(msgs(user([T("q")]), asst([TU("t1"), TU("t2")]), user([TR("t1")])), "TOOL_USE_UNANSWERED");
  E(msgs(user([T("q")]), asst([TU("t1")]), user([T("no result")])), "TOOL_USE_UNANSWERED");
  E(msgs(user([T("q")]), asst([TU("t1")]), user([TR("zz")])), "TOOL_RESULT_ORPHAN");
  E(msgs(user([T("q")]), asst([TU("t1"), TU("t1")]), user([TR("t1")])), "TOOL_USE_DUPLICATE_ID");
  E(msgs(user([T("q")]), asst([{ type: "tool_use", id: "", name: "x", input: {} }]), user([TR("")])), "TOOL_USE_SHAPE", "a call with no id");
  E(msgs(user([T("q")]), asst([{ type: "tool_use", id: "t1", name: "rules__search", input: "text" }]), user([TR("t1")])), "TOOL_USE_SHAPE", "an input that is not an object");
  E(msgs(user([T("q")]), asst([TU("t1")]), user([T("first"), TR("t1")])), "TOOL_RESULT_NOT_FIRST");
  E(msgs(user([T("q")]), asst([TU("t1")]), user([{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "" }] }])), "TOOL_RESULT_EMPTY_TEXT");
  E(msgs(user([TU("t1")])), "TOOL_USE_IN_USER"); E(msgs(user([T("q")]), asst([TR("t1")])), "TOOL_RESULT_IN_ASSISTANT");
  E(msgs(user([{ type: "thinking", thinking: "x", signature: "s" }])), "THINKING_IN_USER");
  E(msgs(user([T("q")]), asst([T("text first"), { type: "thinking", thinking: "", signature: "s" }])), "THINKING_ORDER");
  E(msgs(user([T("q")]), asst([{ type: "thinking", thinking: "", signature: "" }, TU("t1")]), user([TR("t1")])), "THINKING_SHAPE");
  E(msgs(user([T("q")]), asst([{ type: "thinking", thinking: "x", signature: "s", cache_control: { type: "ephemeral" } }, TU("t1")]), user([TR("t1")])), "CACHE_CONTROL_NOT_ALLOWED_HERE", "a marker on a thinking block");
  E(msgs(user([{ type: "text", text: "q", cache_control: { type: "persistent" } }])), "CACHE_CONTROL_SHAPE");
  const five = REQ({ system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }], messages: [user(Array.from({ length: 4 }, (_, i) => ({ type: "text", text: `b${i}`, cache_control: { type: "ephemeral" } })))] });
  E(five, "CACHE_CONTROL_COUNT", `${MAX_CACHE_BREAKPOINTS + 1} breakpoints`);
  E(msgs(user({ nope: 1 })), "CONTENT_SHAPE"); E(msgs(user([{ type: "image" }])), "BLOCK_TYPE");
  E(REQ({ tools: [TOOL("rules.search")] }), "TOOL_NAME", "a tool name with a dot is refused by the API (ours use two underscores)");
  E(REQ({ tools: [TOOL("a"), TOOL("a")] }), "TOOL_NAME_DUPLICATE"); E(REQ({ tools: [{ name: "a", input_schema: { type: "string" } }] }), "TOOL_SCHEMA");
  E(REQ({ system: [{ type: "text", text: " " }] }), "SYSTEM_BLOCK"); E(REQ({ system: "" }), "SYSTEM_EMPTY"); E(REQ({ system: 5 }), "SYSTEM_SHAPE");
  E(REQ({ temperature: 0.2 }), "SAMPLING_PARAM_REJECTED"); E(REQ({ max_tokens: 0 }), "MAX_TOKENS");
  E(null, "REQUEST_SHAPE"); E([], "REQUEST_SHAPE");
  // A warning is reported but does not block.
  const w = checkRequestContract(msgs(user([T("q")]), asst([TU("t1", "not_offered")]), user([TR("t1")])));
  t.ok(w.ok && w.warnings.some((x) => x.code === "TOOL_USE_UNKNOWN_TOOL"));
  t.ok(checkRequestContract(msgs(user([T("a")]), user([T("b")]))).warnings.some((x) => x.code === "ROLE_NOT_ALTERNATING"));
});

test("contract: what is and is not covered is written down", () => {
  t.ok(COVERED.length >= 8 && NOT_COVERED.length >= 4);
  t.ok(NOT_COVERED.some((x) => /provider accepts/.test(x)), "it says plainly that passing is not provider acceptance");
  t.ok(fs.existsSync(path.join(REPO, "docs/ai_desk/PREFLIGHT_CONTRACT.md")));
});

// ── 2. response classification ─────────────────────────────────────────────────────────────────────
test("responses: truncated, refused and malformed replies are classified; a bad tool call is only noted (the loop answers it with an error)", () => {
  t.deepEqual(classifyResponse({ stop_reason: "end_turn", content: [T("ok")] }).ok, true);
  t.equal(classifyResponse({ stop_reason: "max_tokens", content: [TU("a")] }).truncated, true);
  t.equal(classifyResponse({ stop_reason: "refusal", content: [] }).refusal, true);
  for (const bad of [null, undefined, "x", { content: null }, { content: "text" }, { stop_reason: "end_turn" }]) t.equal(classifyResponse(bad).malformed, true, JSON.stringify(bad));
  t.equal(classifyResponse({ stop_reason: "weird", content: [] }).malformed, true);
  t.equal(classifyResponse({ stop_reason: "end_turn", content: [null] }).malformed, true);
  const noted = classifyResponse({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "", name: "x", input: "no" }, { type: "server_tool_use", id: "s" }] });
  t.ok(noted.ok && noted.notes.includes("TOOL_USE_MALFORMED"));
});

// ── 3. structural diagnostics ──────────────────────────────────────────────────────────────────────
test("diagnostics: a request shape is block TYPES and COUNTS only; no text, names, ids, arguments, results, thinking or keys can appear in it", () => {
  const request = REQ({ system: [{ type: "text", text: SECRETS[1], cache_control: { type: "ephemeral" } }], messages: [
    user([T(SECRETS[0])]), asst([{ type: "thinking", thinking: SECRETS[3], signature: "SIG-" + SECRETS[1] }, T(SECRETS[2]), TU("id-" + SECRETS[1], "rules__search", { who: SECRETS[0] })]),
    user([{ type: "tool_result", tool_use_id: "id-" + SECRETS[1], content: [{ type: "text", text: SECRETS[4] }] }])] });
  const shape = describeRequest(request);
  const line = shapeLine(shape), json = JSON.stringify(shape);
  for (const s of SECRETS) { t.ok(!json.includes(s) && !line.includes(s), s); }
  t.equal(line, "user[text] > assistant[thinking,text,tool_use] > user[tool_result]");
  t.deepEqual([shape.tool_use, shape.tool_result, shape.tools, shape.cache_markers, shape.model], [1, 1, 2, 1, "claude-sonnet-5-5"]);
  const nine = REQ({ messages: [user([T("q")]), asst([...Array.from({ length: 9 }, (_, i) => TU(`t${i}`))]), user(Array.from({ length: 9 }, (_, i) => TR(`t${i}`)))] });
  t.equal(shapeLine(describeRequest(nine)), "user[text] > assistant[tool_use*9] > user[tool_result*9]");
  t.deepEqual(describeRequest(null).messages, []); t.deepEqual(describeRequest({ messages: "x" }).messages, []);
  t.equal(describeRequest(REQ({ messages: [user([{ type: "weird_block_with_text", text: SECRETS[0] }])] })).messages[0].blocks[0], "other");
});

// ── 4. the gate runs the contract on the real request ──────────────────────────────────────────────
const caller = makeCommishCaller("0008");
const BIG = { DESK_BUDGET_PER_QUESTION_USD: "5", DESK_BUDGET_PER_RUN_USD: "10", DESK_BUDGET_MONTHLY_USD: "20", DESK_BUDGET_TOTAL_USD: "50" };
const freshDb = () => { const d = makeD1(); applyMigrations(d, ["0180_ai_call_log.sql", "0181_ai_desk_questions.sql"]); return d; };
const gate = (o) => guardedCall({ caller, nowMs: Date.UTC(2026, 10, 20, 15, 0, 0), deskEnabled: true, meta: { step: "loop", questionId: "q1", runId: "r1" }, env: BIG, request: REQ(), ...o });

test("gate: a request that breaks the contract is refused as request_contract: nothing sent, nothing reserved, a blocked ledger row, a content-free shape", async () => {
  const d = freshDb(), c = createFakeClient([textResponse("x")]);
  const bad = REQ({ tools: [TOOL("emit_card")], tool_choice: { type: "tool", name: "emit_card" }, messages: [user([T(SECRETS[0])])] });
  const r = await gate({ db: d, client: c, request: bad });
  t.deepEqual([r.ok, r.blocked, r.reason, r.detail], [false, true, "request_contract", "TOOL_CHOICE_FORCED_MODEL"]);
  t.equal(c.calls.length, 0, "the client was never called");
  const rows = d.raw.prepare("SELECT mode, error_code, est_cost_usd, cost_usd FROM ai_call_log").all();
  t.deepEqual(rows.map((x) => [x.mode, x.error_code]), [["blocked", "request_contract"]]);
  t.deepEqual(d.raw.prepare("SELECT reserved_usd, spent_usd FROM ai_budget_totals").all().map((x) => [x.reserved_usd, x.spent_usd]).flat().filter((x) => x), [], "no reservation, no spend");
  t.ok(r.shape && Array.isArray(r.shape.messages) && !JSON.stringify(r).includes(SECRETS[0]), "the shape carries no question text");
  t.ok(r.problems.some((p) => p.code === "TOOL_CHOICE_FORCED_MODEL"));
  // A valid request goes through as before.
  const ok = await gate({ db: d, client: createFakeClient([textResponse("fine")]), request: REQ() });
  t.equal(ok.ok, true);
  // The order of reasons is unchanged: the live-call switch is judged before the contract.
  const live = { mode: "live", complete: async () => ({}) };
  const lr = await gate({ db: freshDb(), client: live, request: bad, env: { ...BIG } });
  t.equal(lr.reason, "live_calls_disabled", "a live client without the switch is refused for that reason first");
});

test("gate: a failed provider call reports status, error type, field path, a content-free shape, and what it cost (free for a 4xx, the reservation for a reply we cannot trust)", async () => {
  const d = freshDb();
  const e400 = new DeskModelError("http_error", { status: 400, providerType: "invalid_request_error", providerPath: "messages.1.content.0.text" });
  const r = await gate({ db: d, client: createFakeClient([e400]), request: REQ({ messages: [user([T(SECRETS[0])])] }) });
  t.deepEqual([r.reason, r.detail, r.status, r.providerType, r.providerPath, r.costUsd], ["model_error", "http_error", 400, "invalid_request_error", "messages.1.content.0.text", 0]);
  t.equal(r.shape.model, "claude-sonnet-5-5"); t.ok(!JSON.stringify(r).includes(SECRETS[0]));
  const row = d.raw.prepare("SELECT error_code, cost_usd FROM ai_call_log WHERE mode = 'fake'").get();
  t.equal(row.error_code, "http_error:400:invalid_request_error:messages.1.content.0.text"); t.equal(row.cost_usd, 0);
  const d2 = freshDb();
  const r2 = await gate({ db: d2, client: createFakeClient([new DeskModelError("bad_response")]), request: REQ() });
  t.equal(r2.reason, "model_error");
  const row2 = d2.raw.prepare("SELECT est_cost_usd, cost_usd FROM ai_call_log WHERE mode = 'fake'").get();
  t.ok(r2.costUsd > 0 && Math.abs(r2.costUsd - row2.est_cost_usd) < 1e-12 && Math.abs(row2.cost_usd - row2.est_cost_usd) < 1e-12, "a reply we cannot trust is charged at its reservation, and the result says so");
});

// ── 5. the production pipeline's own requests ─────────────────────────────────────────────────────
const CAPS = { ...DRY_DEFAULT_CAPS };
async function runOne(c, behavior, spec = c.spec) {
  const client = createAdversarialClient(c.caseDef.id, behavior);
  const db = makeLedgerDb(null);
  const saved = globalThis.fetch; let net = 0; globalThis.fetch = () => { net += 1; throw new Error("no network"); };
  let r; try { r = await runCase({ caseDef: c.caseDef, spec, client, gateEnv: CAPS, db, runId: "PF", clock: "real" }); } finally { globalThis.fetch = saved; db.close(); }
  return { r, client, net };
}

test("pipeline: EVERY request the production pipeline sends (ten questions x plain, thinking, parallel, mixed, bad sequence, prose reply) satisfies the contract; none touches the network", async () => {
  let n = 0, shapes = new Set();
  for (const c of CASES) for (const behavior of [null, "thinking", "redacted_thinking", "parallel9", "mixed_text", "bad_tool_seq", "text_only_composer_once", "truncated_composer_once"]) {
    const { r, client, net } = await runOne(c, behavior);
    t.equal(net, 0, `${c.caseDef.id} ${behavior}: no network`);
    t.deepEqual(r.gate.filter((g) => g.reason === "request_contract"), [], `${c.caseDef.id} ${behavior}: the gate refused no request`);
    for (const req of client.calls) {
      const res = checkRequestContract(req);
      n += 1; shapes.add(shapeLine(describeRequest(req)).replace(/\*\d+/g, "*n"));
      t.ok(res.ok, `${c.caseDef.id} ${behavior}: ${JSON.stringify(res.errors)}`);
      if (behavior !== "bad_tool_seq") t.deepEqual(res.warnings, [], `${c.caseDef.id} ${behavior}: no warning`);
      t.ok(!JSON.stringify(req.tools || []).includes('"rules.search"'), "tool names sent to the API contain no dot");
    }
  }
  t.ok(n > 300, `${n} requests checked`);
  t.ok([...shapes].some((s) => /assistant\[thinking,/.test(s)) && [...shapes].some((s) => /tool_use\*n/.test(s)) && [...shapes].some((s) => /tool_result\*n/.test(s)), "the sequences really contained thinking blocks and parallel calls");
});

test("pipeline: the loop replays the model's turn intact: thinking and redacted_thinking exactly as received, in order, with a single marker on the newest message", async () => {
  const c = CASES.find((x) => x.caseDef.id === "DEV-REC-02");
  const { client } = await runOne(c, "redacted_thinking");
  const loopReqs = client.calls.filter((q) => q.tools && q.tools.length > 1);
  t.ok(loopReqs.length >= 2);
  const replay = loopReqs[1].messages.find((m) => m.role === "assistant").content;
  t.equal(replay[0].type, "redacted_thinking"); t.equal(replay[1].type, "thinking"); t.match(replay[0].data, /^REDACTED-loop-1/); t.match(replay[1].signature, /^SIGNATURE-loop-1/);
  t.ok(replay.slice(2).every((b) => b.type === "text" || b.type === "tool_use"));
  t.equal(JSON.stringify(loopReqs[1].messages).match(/"cache_control"/g).length, 1, "one marker in the messages");
});

// ── 6. the adversarial matrix ─────────────────────────────────────────────────────────────────────
let MATRIX = null;
test("matrix: all ten questions x every scenario complete safely with no network and no refused request; every completed result carries an independent grade", async () => {
  MATRIX = await runMatrix({ cases: CASES, invariantFailures, caps: CAPS, runId: "T" });
  t.equal(MATRIX.network_attempts, 0);
  t.equal(MATRIX.rows.length, CASES.length * SCENARIOS.length);
  t.deepEqual(MATRIX.failures.map((f) => `${f.case}/${f.scenario}: ${f.why[0]}`), []);
  for (const r of MATRIX.rows) { t.ok(GRADES.includes(r.grade), `${r.case}/${r.scenario}`); t.ok(Array.isArray(r.grade_why) && r.grade_why.length >= 1); t.deepEqual(r.gate_blocks.filter((g) => g.reason === "request_contract"), []); }
  for (const id of Object.keys(BEHAVIORS)) t.ok(SCENARIOS.some((s) => s.behavior === id), `behavior ${id} is exercised by a scenario`);
  for (const id of PREFLIGHT_SCENARIO_IDS) t.ok(SCENARIOS.some((s) => s.id === id), `preflight scenario ${id} exists`);
});

test("matrix: the grade is independent of the oracle (an oracle PASS can still be Partial) and the failsafe scenarios end in the code-built card with the right reason", () => {
  const base = MATRIX.rows.filter((r) => r.scenario === "baseline");
  t.equal(base.length, 10);
  t.ok(base.every((r) => r.grade === "Correct" || r.grade === "Partial"), "no baseline answer is Incorrect or a Technical failure");
  t.ok(base.some((r) => r.oracle_pass === true && r.grade === "Partial"), "an oracle pass that is only a Partial answer exists (DEV-REC-02 has a listed gap)");
  for (const [scenario, reason] of [["text_only_composer_always", "validation_failed"], ["unicode_digit_always", "validation_failed"], ["truncated_loop", "tool_limit:max_tokens"], ["refusal_loop", "tool_limit:refusal"], ["bad_response_loop", "model_unavailable:loop"], ["http400_loop2", "model_unavailable:loop"]]) {
    const rows = MATRIX.rows.filter((r) => r.scenario === scenario);
    t.equal(rows.length, 10); t.ok(rows.every((r) => r.state === "tool_failure" && r.reason === reason), scenario);
  }
  const d = MATRIX.rows.filter((r) => r.scenario === "http400_loop2");
  t.ok(d.every((r) => r.diagnostics && r.diagnostics.status === 400 && r.diagnostics.provider_type === "invalid_request_error" && r.diagnostics.provider_path === "messages.1.content.0.text" && r.diagnostics.shape.messages.length >= 3));
  // the glossary scenario really changed the R3 answer (capitalization) and the real invariant accepted it
  const g = MATRIX.rows.find((r) => r.scenario === "glossary_case" && r.case === "DEV-RUL-10");
  t.ok(g && g.ok && g.state === "answer");
});

test("R3 would have been caught: a private case-sensitive copy of the digit rule disagrees with the validator on the R3 lead; the shared rule and the runner agree (the matrix's glossary_case runs the real invariant on it)", () => {
  const lead = "Yes. The cited rule names Ext1 among its contract types. The glossary tracks the status token Vet-Ext1.";
  const terms = ["Vet-Ext1", "ext1", "rookie-ext1", "ext 1"];
  const privateCopy = (s) => { const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${terms.sort((a, b) => b.length - a.length).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\p{L}\\p{N}])`, "gu"); return /\d/.test(s.replace(re, " ")); };
  t.equal(privateCopy(lead), true, "the old private copy flags a validator-approved answer (the R3 abort)");
  t.equal(hasDigitOutsideTokens(lead, termRegex(terms)), false);
  const card = { state: "answer", lead_md: lead, facts_used: [], facts: {}, footer: { cost_usd: 0.01 } };
  const r = { card, envelopes: [{ tool: "glossary.lookup", status: "ok", data: { entries: [{ term: "Vet-Ext1", aliases: ["ext1"] }] } }], ledger: [{ cost_usd: 0.01, est_cost_usd: 0.05 }] };
  t.deepEqual(invariantFailures(r, 0.5), []);
});

// ── 7. the independent grade ──────────────────────────────────────────────────────────────────────
test("grade: Keith's four grades from the card alone (R2 and R3 reproduced); an oracle pass is not a grade", () => {
  const rule = { anchor: "s1-c4", canon_sha: "194f8df", claim: "c", rule: { title: "t", excerpt: "e" } };
  const F = (id) => ({ tool: "x.y", call_id: "c1", value: 1, display: "1" });
  const g = (o) => gradeAnswer({ invariants: [], ...o });
  // R3 question 1: the right rule, a listed gap, the year only in the citation's title: Partial
  t.equal(g({ p1: "cite", card: { state: "answer_with_gap", lead_md: "x", cites: [rule], gaps: [{ what: "table", why: "no_record", source_needed: "S4" }], facts_used: [], facts: {} } }).grade, "Partial");
  // R3 question 2: answers, cites, no gap: Correct
  t.equal(g({ p1: "cite", card: { state: "answer", lead_md: "x", cites: [rule, rule], gaps: [], facts_used: [], facts: {} } }).grade, "Correct");
  // R2 question 3: a code-built failure card: Technical failure
  t.equal(g({ p1: "answer", card: { state: "tool_failure", lead_md: "x", facts_used: [], facts: {}, cites: [], gaps: [] } }).grade, "Technical failure");
  // Incorrect: a guess where the record does not exist; an over-refusal; a citation with no rule text; a fact with no source; an invariant failure; an injected number
  t.equal(g({ p1: "abstain", card: { state: "answer", lead_md: "x", facts_used: ["c1.a"], facts: { "c1.a": F() }, cites: [], gaps: [] } }).grade, "Incorrect");
  t.equal(g({ p1: "answer", card: { state: "abstain", lead_md: "x", facts_used: [], facts: {}, cites: [], gaps: [] } }).grade, "Incorrect");
  t.equal(g({ p1: "cite", card: { state: "answer", lead_md: "x", cites: [{ anchor: "a", canon_sha: "b", claim: "c" }], gaps: [], facts_used: [], facts: {} } }).grade, "Incorrect");
  t.equal(g({ p1: "answer", card: { state: "answer", lead_md: "x", facts_used: ["c1.a"], facts: { "c1.a": { value: 1 } }, cites: [], gaps: [] } }).grade, "Incorrect");
  t.equal(g({ p1: "answer", invariants: ["a digit"], card: { state: "answer", lead_md: "x", facts_used: ["c1.a"], facts: { "c1.a": F() }, cites: [], gaps: [] } }).grade, "Incorrect");
  // Correct declines name the missing source; a decline that does not is Partial
  t.equal(g({ p1: "abstain", card: { state: "abstain", lead_md: "x", facts_used: [], facts: {}, cites: [], gaps: [{ what: "w", why: "no_record", source_needed: "League Record" }] } }).grade, "Correct");
  t.equal(g({ p1: "abstain", card: { state: "abstain", lead_md: "x", facts_used: [], facts: {}, cites: [], gaps: [] } }).grade, "Partial");
  // An outage question: an honest failure is its right answer; elsewhere an outage is a Technical failure, and asserting over a failed source is Incorrect
  t.equal(g({ p1: "tool_failure_message", card: { state: "abstain", lead_md: "x", facts_used: [], facts: {}, cites: [], gaps: [] } }).grade, "Correct");
  t.equal(g({ p1: "answer", sourcesDown: true, card: { state: "abstain", lead_md: "x", facts_used: [], facts: {}, cites: [], gaps: [] } }).grade, "Technical failure");
  t.equal(g({ p1: "answer", sourcesDown: true, card: { state: "answer", lead_md: "x", facts_used: ["c1.a"], facts: { "c1.a": F() }, cites: [], gaps: [] } }).grade, "Incorrect");
  t.equal(g({ p1: "answer", card: null }).grade, "Technical failure"); t.equal(g({ p1: "answer", card: { lead_md: "x" } }).grade, "Technical failure");
});

run("ai_desk_preflight");
