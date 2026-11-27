// Commissioner Desk: ZERO-SPEND proof that the LIVE path is wired the way the contract says.
//   node tests/ai_desk_live_wiring.test.mjs
//
// It drives the real handler route (index.js -> handler.js -> budget gate -> the real Anthropic client) on real SQLite with the switch ON, a
// desk key, positive caps and a DIFFERENT shared key in the environment. The ONLY thing faked is the network edge: globalThis.fetch is replaced
// by an interceptor that serves a scripted api.anthropic.com response and THROWS on anything else, so no real network call is possible and no
// key here is real ("test-key-not-real"). It proves: the request goes to https://api.anthropic.com/v1/messages with the DESK key in x-api-key;
// the shared key is never sent anywhere; the ledger row is reserved before the call and finalized after; the per-question cap blocks a second
// call before it reaches the network; a model reply that states a number no tool produced is rejected and the user sees a code-built card; and a
// scripted router -> loop -> composer sequence on a question about the rules returns a card built from tool facts only.
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, bindSelf, callWorker, ADMIN_KEY, quiet } from "./fixtures/worker_harness.mjs";
import { applyMigrations } from "./fixtures/d1_sqlite.mjs";
import { buildKnowledge, searchRules } from "../worker/src/desk/knowledge.js";
import RULES_DATA from "../worker/src/desk/data/rules_data.js";
import { MODELS } from "../worker/src/desk/prompts.js";

const restoreConsole = quiet();
const realFetch = globalThis.fetch;
const DESK_KEY = "test-key-not-real";
const SHARED_KEY = "shared-key-must-never-leave-0000";
const ANTHROPIC = "https://api.anthropic.com/v1/messages";
const Q = `L=74598&YEAR=2026&APIKEY=${ADMIN_KEY}`;
const DESK_MIGRATIONS = ["0180_ai_call_log.sql", "0181_ai_desk_questions.sql"];
const CAPS = { DESK_BUDGET_PER_QUESTION_USD: "0.50", DESK_BUDGET_PER_RUN_USD: "5", DESK_BUDGET_MONTHLY_USD: "5", DESK_BUDGET_TOTAL_USD: "5" };

// A real anchor and canon version from the bundled rules index (the same index the handler builds).
const knowledge = buildKnowledge({ rulesJson: RULES_DATA, canonText: null, leagueId: "74598", currentSeason: 2026, calendar: {} });
// The top hit for the query. The validator accepts anchors up to 160 characters, so even the long real anchor of this hit can be cited; and a cite must
// name a rule retrieved in the same run (UNRETRIEVED_ANCHOR), so the scripted tool call below asks for the same eight hits.
const HIT = searchRules(knowledge, "taxi squad", { limit: 8 }).hits[0];
const SHA7 = knowledge.rules.canon_sha.slice(0, 7);

// ── The network edge ─────────────────────────────────────────────────────────────────────────────────────────────
let useSeq = 0;
const usage = (i = 1000, o = 200) => ({ input_tokens: i, output_tokens: o });
const toolUse = (name, input) => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: `toolu_${++useSeq}`, name, input }] });
const endTurn = () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "Enough evidence." }] });
const routeReply = (o = {}) => toolUse("route_question", { intent: "rule_lookup", domains: ["rules"], needs_as_of: null, out_of_scope: false, reason: "a rules question", ...o });
const cardReply = (card) => toolUse("emit_card", card);

// script: { router: [reply...], loop: [...], composer: [...] }; a reply is { stop_reason, content, usage? }.
function makeNetwork(env, script) {
  const q = script;                       // consumed in place, so unsentCalls(script) says what the model was never asked
  for (const k of ["router", "loop", "composer"]) q[k] = q[k] || [];
  const net = { calls: [], refused: [], snapshots: [] };
  const ledger = () => env.UPS_MFL_DB.raw.prepare("SELECT id, mode, step, est_cost_usd, cost_usd, input_tokens, output_tokens, error_code FROM ai_call_log ORDER BY id").all();
  net.ledger = ledger;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input && input.url ? input.url : String(input);
    if (url !== ANTHROPIC) { net.refused.push(String(url).slice(0, 80)); throw new Error(`offline test: unexpected network call to ${String(url).slice(0, 60)}`); }
    const headers = Object.fromEntries(Object.entries(init && init.headers ? init.headers : {}).map(([k, v]) => [k.toLowerCase(), v]));
    const body = JSON.parse(init.body);
    const tn = Array.isArray(body.tools) ? body.tools.map((x) => x && x.name) : [];
    const step = tn.length === 1 && tn[0] === "route_question" ? "router" : tn.length === 1 && tn[0] === "emit_card" ? "composer" : "loop";
    net.snapshots.push(ledger());          // the ledger as it stood AT the moment the request left the Worker
    net.calls.push({ url, method: init.method, headers, body, rawBody: init.body, step });
    const reply = q[step].shift();
    if (!reply) throw new Error(`offline test: no scripted reply left for step ${step}`);
    const json = { id: `msg_${net.calls.length}`, type: "message", role: "assistant", model: body.model, stop_reason: reply.stop_reason, content: reply.content, usage: reply.usage || usage() };
    return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
  };
  return net;
}
const unsentCalls = (script) => Object.values(script).reduce((n, a) => n + a.length, 0);

function freshEnv(over = {}) {
  const env = makeWorkerEnv({ DESK_ENABLED: "1", DESK_LIVE_MODEL_ENABLED: "1", ANTHROPIC_API_KEY_DESK: DESK_KEY, ANTHROPIC_API_KEY: SHARED_KEY, ...CAPS, ...over });
  applyMigrations(env.UPS_MFL_DB, DESK_MIGRATIONS);
  bindSelf(env);
  return env;
}
const ask = (env, question) => callWorker(env, "POST", `/admin/commish-desk/ask?${Q}`, { body: { question, as_of: "current" } });
const everythingSent = (net) => JSON.stringify(net.calls.map((c) => ({ url: c.url, method: c.method, headers: c.headers, body: c.rawBody }))) + JSON.stringify(net.refused);

const HAPPY = () => ({
  router: [routeReply()],
  // limit 8 returns the same eight hits HIT came from; a cite must name a rule retrieved in this run (validator UNRETRIEVED_ANCHOR)
  loop: [toolUse("rules__search", { query: "taxi squad", as_of: "current", limit: 8 }), endTurn()],
  composer: [cardReply({
    state: "answer",
    lead_md: "Canon version {{f.c1.canon_sha}} has a rule on this, matched by {{f.c1.match_count}} entries.",
    facts_used: ["c1.canon_sha", "c1.match_count"],
    cites: [{ anchor: HIT.anchor, canon_sha: SHA7, claim: "the rule on the taxi squad" }],
  })],
});

test("PRECONDITION: the scripted question has a real anchor in the bundled rules index", () => {
  t.ok(HIT && typeof HIT.anchor === "string" && knowledge.rules.byAnchor[HIT.anchor], "rules.search finds a taxi squad rule");
  t.match(SHA7, /^[0-9a-f]{7}$/);
  t.notEqual(DESK_KEY, SHARED_KEY);
});

test("LIVE PATH: the request goes to api.anthropic.com/v1/messages with the DESK key; the shared key never leaves the Worker", async () => {
  const env = freshEnv();
  const script = HAPPY();
  const net = makeNetwork(env, script);
  const r = await ask(env, "What does canon say about the taxi squad?");
  t.equal(r.status, 200, r.text.slice(0, 300));
  t.equal(net.calls.length, 4, "router, loop, loop, composer");
  t.deepEqual(net.calls.map((c) => c.step), ["router", "loop", "loop", "composer"]);
  t.deepEqual(net.refused, [], "no other host was contacted");
  for (const c of net.calls) {
    t.equal(c.url, ANTHROPIC); t.equal(c.method, "POST");
    t.equal(c.headers["x-api-key"], DESK_KEY, "the desk key, not the shared key");
    t.equal(c.headers["anthropic-version"], "2023-06-01");
    t.ok(!Object.values(c.headers).some((v) => String(v).includes(SHARED_KEY)));
    t.deepEqual(Object.keys(c.body).filter((k) => !["model", "max_tokens", "system", "messages", "tools", "tool_choice", "temperature"].includes(k)), [], "only the whitelisted request fields are sent");
    t.ok(Object.values(MODELS).includes(c.body.model), `priced model ${c.body.model}`);
  }
  t.deepEqual(net.calls.map((c) => c.body.model), [MODELS.router, MODELS.loop, MODELS.loop, MODELS.composer]);
  t.ok(!everythingSent(net).includes(SHARED_KEY), "the shared key appears nowhere in any URL, header or body sent");
  t.ok(!everythingSent(net).includes(ADMIN_KEY), "the admin key appears nowhere in any request sent");
  t.ok(!r.text.includes(DESK_KEY) && !r.text.includes(SHARED_KEY), "no key in the response to the page");
  t.equal(unsentCalls(script), 0, "every scripted reply was consumed");
});

test("LEDGER: each call is reserved in ai_call_log BEFORE the request leaves, and finalized with real usage AFTER", async () => {
  const env = freshEnv();
  const net = makeNetwork(env, HAPPY());
  const r = await ask(env, "What does canon say about the taxi squad?");
  t.equal(r.status, 200);
  net.snapshots.forEach((rows, i) => {
    t.equal(rows.length, i + 1, `call ${i + 1}: the ledger already holds ${i + 1} row(s) when the request leaves`);
    const mine = rows[rows.length - 1];
    t.equal(mine.mode, "live"); t.equal(mine.step, net.calls[i].step);
    t.ok(mine.est_cost_usd > 0, "a worst-case estimate is reserved first");
    t.equal(mine.cost_usd, null, "not yet finalized while the request is in flight");
    if (i > 0) t.ok(rows[i - 1].cost_usd !== null, "the previous call was finalized before the next one started");
  });
  const rows = net.ledger();
  t.equal(rows.length, 4);
  for (const row of rows) { t.equal(row.mode, "live"); t.ok(row.cost_usd > 0 && row.cost_usd < row.est_cost_usd, "finalized at the real, smaller cost"); t.equal(row.input_tokens, 1000); t.equal(row.output_tokens, 200); t.equal(row.error_code, null); }
  const sum = rows.reduce((a, b) => a + b.cost_usd, 0);
  t.ok(Math.abs(sum - r.json.card.footer.cost_usd) < 1e-6, "the card's footer cost is the ledger's sum");
  t.equal(r.json.card.footer.model_calls, 4);
  t.equal(env.UPS_MFL_DB.raw.prepare("SELECT COUNT(*) n FROM ai_desk_questions").get().n, 1);
});

test("HAPPY PATH: router, loop and composer on a rules question return an answer card built from tool facts only", async () => {
  const env = freshEnv();
  const net = makeNetwork(env, HAPPY());
  const r = await ask(env, "What does canon say about the taxi squad?");
  const c = r.json.card;
  t.equal(r.json.ok, true);
  t.equal(c.state, "answer");
  t.deepEqual(Object.keys(c.facts).sort(), ["c1.canon_sha", "c1.match_count"]);
  t.equal(c.facts["c1.canon_sha"].value, knowledge.rules.canon_sha, "the canon version is the tool's, not the model's");
  t.equal(c.facts["c1.canon_sha"].tool, "rules.search"); t.equal(c.facts["c1.canon_sha"].grade, "B");
  t.equal(c.facts["c1.match_count"].tool, "rules.search"); t.equal(c.facts["c1.match_count"].unit, "count");
  t.ok(!/\d/.test(c.lead_md.replace(/\{\{f\.c\d+\.[a-z_]+\}\}/g, "")), "the model's prose carries no digit of its own");
  t.deepEqual(c.cites.map((x) => [x.anchor, x.canon_sha]), [[HIT.anchor, SHA7]]);
  // the cite carries the rule's own title and excerpt, attached by code from the retrieved tool data (never from the model's reply)
  t.equal(c.cites[0].rule.title, knowledge.rules.byAnchor[HIT.anchor].title);
  t.ok(c.cites[0].rule.excerpt.length > 0 && c.cites[0].rule.excerpt !== "the rule on the taxi squad");
  t.equal(c.header.ai_generated, true); t.equal(c.header.phase, "P1"); t.equal(c.header.canon_sha, SHA7);
  t.deepEqual(c.footer.tools.map((x) => [x.id, x.status]), [["rules.search", "ok"]]);
  // the loop's tool call carried as_of and nothing but the declared arguments
  const loopResult = net.calls[2].body.messages.at(-1).content[0];
  t.equal(loopResult.type, "tool_result"); t.match(loopResult.content[0].text, /<<<UPS_DATA tool_result tool="rules\.search"/);
  // the composer saw fact ids and displays, never raw tool JSON
  t.match(net.calls[3].body.messages[0].content[0].text, /id=c1\.canon_sha \| Canon version/);
  const hist = await callWorker(env, "GET", `/admin/commish-desk/question?${Q}&id=${r.json.request_id}`);
  t.equal(hist.json.item.card.state, "answer", "the saved question reopens with the same card");
});

test("PER-QUESTION CAP: after the first call spends the question's allowance, the second call is blocked BEFORE it reaches the network", async () => {
  const env = freshEnv();
  // the router call's usage is scripted to cost 0.49 on the 0.50 per-question cap (haiku input 0.10 per million tokens)
  const script = { router: [{ ...routeReply(), usage: usage(4900000, 0) }], loop: [endTurn()], composer: [] };
  const net = makeNetwork(env, script);
  const r = await ask(env, "What does canon say about the taxi squad?");
  t.equal(r.status, 200);
  t.equal(net.calls.length, 1, "only the router call left the Worker");
  t.equal(r.json.card.state, "budget_exceeded");
  t.equal(r.json.card.reason_code, "budget_per_question");
  t.ok(!/\d/.test(r.json.card.lead_md), "a code-built card has no typed number");
  t.deepEqual(r.json.card.facts, {});
  const rows = net.ledger();
  t.equal(rows.filter((x) => x.mode === "live").length, 1);
  t.ok(Math.abs(rows.find((x) => x.mode === "live").cost_usd - 0.49) < 1e-6);
  const blocked = rows.filter((x) => x.mode === "blocked");
  t.equal(blocked.length, 1); t.equal(blocked[0].error_code, "budget_per_question"); t.equal(blocked[0].cost_usd, 0);
  t.equal(unsentCalls(script), 1, "the loop reply was never requested");
  // a NEW question starts with a fresh per-question allowance
  const net2 = makeNetwork(env, HAPPY());
  const r2 = await ask(env, "What does canon say about the taxi squad?");
  t.equal(r2.json.card.state, "answer"); t.equal(net2.calls.length, 4);
});

test("NUMBER GUARD: a model reply that states a number no tool produced is rejected; the user sees a code-built card, not the model's text", async () => {
  const env = freshEnv();
  const typed = cardReply({ state: "answer", lead_md: "The taxi squad holds 9 players.", facts_used: [], cites: [{ anchor: HIT.anchor, canon_sha: SHA7, claim: "the rule on the taxi squad" }] });
  const faked = cardReply({ state: "answer", lead_md: "The taxi squad holds {{f.c1.taxi_size}} players.", facts_used: ["c1.taxi_size"] });
  const script = { router: [routeReply()], loop: [toolUse("rules__search", { query: "taxi squad", as_of: "current" }), endTurn()], composer: [typed, faked] };
  const net = makeNetwork(env, script);
  const r = await ask(env, "How many players can a taxi squad hold?");
  t.equal(r.status, 200);
  const c = r.json.card;
  t.equal(c.state, "tool_failure", "two rejected cards end in a code-built failure");
  t.deepEqual(c.facts, {}); t.deepEqual(c.cites, []);
  t.ok(!r.text.includes("9 players") && !r.text.includes("taxi_size"), "the model's text is nowhere in the response");
  t.match(c.lead_md, /Could not verify this right now/);
  t.deepEqual(net.calls.map((x) => x.step), ["router", "loop", "loop", "composer", "composer"], "one composer call and exactly one retry");
  t.match(net.calls[4].body.messages[0].content[0].text, /DIGIT_IN_PROSE/, "the retry told the model what was wrong, by code");
  t.equal(c.reason_code, "validation_failed");
  t.equal(unsentCalls(script), 0);
  const saved = env.UPS_MFL_DB.raw.prepare("SELECT card_json FROM ai_desk_questions").get().card_json;
  t.ok(!saved.includes("9 players"), "the stored card is the code-built one");
});

test("KEY ISOLATION: the shared key alone never starts a call; the switch alone never starts one; neither does a desk key with zero caps", async () => {
  const cases = [
    ["shared key only (no desk key)", { ANTHROPIC_API_KEY_DESK: undefined }],
    ["desk key, switch OFF", { DESK_LIVE_MODEL_ENABLED: "0" }],
    ["desk key, switch ON, zero caps", { DESK_BUDGET_PER_QUESTION_USD: "0", DESK_BUDGET_PER_RUN_USD: "0", DESK_BUDGET_MONTHLY_USD: "0", DESK_BUDGET_TOTAL_USD: "0" }],
    ["desk key, switch ON, caps blank", { DESK_BUDGET_PER_QUESTION_USD: "", DESK_BUDGET_PER_RUN_USD: "", DESK_BUDGET_MONTHLY_USD: "", DESK_BUDGET_TOTAL_USD: "" }],
  ];
  for (const [label, over] of cases) {
    const env = freshEnv(over);
    const noDeskKey = "ANTHROPIC_API_KEY_DESK" in over && over.ANTHROPIC_API_KEY_DESK === undefined;
    if (noDeskKey) delete env.ANTHROPIC_API_KEY_DESK;
    t.equal(env.ANTHROPIC_API_KEY, SHARED_KEY, "control: the shared key is present in every case");
    const net = makeNetwork(env, HAPPY());
    const r = await ask(env, "What does canon say about the taxi squad?");
    t.equal(r.status, 200, label);
    t.equal(net.calls.length, 0, `${label}: a request left the Worker`);
    t.deepEqual(net.refused, [], label);
    // a missing desk key is "model unavailable" (tool_failure); every other block is a budget block
    t.equal(r.json.card.state, noDeskKey ? "tool_failure" : "budget_exceeded", label);
    t.deepEqual(r.json.card.facts, {}, label);
    t.equal(env.UPS_MFL_DB.raw.prepare("SELECT COUNT(*) n FROM ai_call_log WHERE mode='live'").get().n, 0, `${label}: a live ledger row exists`);
  }
});

test("FAIL CLOSED: a provider error keeps the reservation as its cost (a 429 may have been processed) and surfaces as a plain card; the key is never echoed", async () => {
  const env = freshEnv();
  const net = makeNetwork(env, { router: [], loop: [], composer: [] });
  const base = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input) !== ANTHROPIC) return base(input, init);
    net.calls.push({ url: String(input), headers: init.headers, rawBody: init.body, step: "router" });
    return new Response(JSON.stringify({ error: { type: "rate_limit_error", message: `slow down ${DESK_KEY}` } }), { status: 429, headers: { "content-type": "application/json" } });
  };
  const r = await ask(env, "What does canon say about the taxi squad?");
  t.equal(r.status, 200);
  t.equal(net.calls.length, 1, "no retry: a retry is a second paid call");
  t.ok(["tool_failure", "budget_exceeded"].includes(r.json.card.state));
  t.ok(!r.text.includes(DESK_KEY) && !r.text.includes("slow down"), "the provider's body and the key are never echoed");
  const rows = env.UPS_MFL_DB.raw.prepare("SELECT cost_usd, error_code FROM ai_call_log WHERE mode='live'").all();
  t.equal(rows.length, 1); t.ok(rows[0].cost_usd > 0, "a 429 may have been processed: the reservation is kept as the cost, never zero"); t.match(rows[0].error_code, /^http_error:429(:[a-z_]+)?$/);
});

await run("ai_desk_live_wiring");
globalThis.fetch = realFetch;
restoreConsole();
