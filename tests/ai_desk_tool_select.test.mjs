// Commissioner Desk: which tool definitions the loop model is shown (worker/src/desk/tool_select.js), and the modeled prompt cache.
// Offline and deterministic. The point: showing fewer definitions is a COST measure and must never hide a tool a question needs.
//   node tests/ai_desk_tool_select.test.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, run, t } from "./fixtures/mini_test.mjs";
import { PHASE1_TOOL_IDS } from "../worker/src/desk/tools/index.js";
import { toolSpecsForModel, toolIdFromModelName } from "../worker/src/desk/registry.js";
import { DOMAINS } from "../worker/src/desk/router.js";
import { CORE_TOOL_IDS, DOMAIN_TOOL_IDS, KEYWORD_DOMAINS, keywordDomains, selectToolIds } from "../worker/src/desk/tool_select.js";
import { SCRIPTED_ROUTES, createCacheModel, estimateUsage, BYTES_PER_TOKEN, MIN_CACHEABLE_TOKENS } from "../scripts/ai_eval/lib/scripted_model.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALL = PHASE1_TOOL_IDS.slice();
const FIRST10 = JSON.parse(fs.readFileSync(path.join(REPO, "scripts/ai_eval/sets/first10.json"), "utf8")).cases;
const BANK = fs.readFileSync(path.join(REPO, "tests/fixtures/ai_desk/eval_bank_dev.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const QUESTION = Object.fromEntries(BANK.map((b) => [b.id, b.question]));

test("every registered tool is placed: core, a domain list, or (if nobody mapped it) always offered; every mapped id exists", () => {
  const mapped = new Set(CORE_TOOL_IDS);
  for (const list of Object.values(DOMAIN_TOOL_IDS)) for (const id of list) mapped.add(id);
  for (const id of ALL) t.ok(mapped.has(id), `${id} is in the core or a domain list (adding a tool forces this decision)`);
  for (const id of mapped) t.ok(ALL.includes(id), `${id} is a registered Phase 1 tool (no typo)`);
  for (const d of Object.keys(DOMAIN_TOOL_IDS)) t.ok(DOMAINS.includes(d), `${d} is a router domain`);
  for (const d of DOMAINS) t.ok(d === "other" || d in DOMAIN_TOOL_IDS, `router domain ${d} is mapped`);
  for (const [, doms] of KEYWORD_DOMAINS) for (const d of doms) t.ok(d in DOMAIN_TOOL_IDS, `keyword domain ${d} is mapped`);
  t.deepEqual(CORE_TOOL_IDS, ["rules.search", "rules.get", "glossary.lookup", "coverage.check"]);
});

test("selection: core always; a domain adds its neighbors; no route, no domains, other or only unknown domains offer EVERYTHING", () => {
  const sel = (route, question = "x") => selectToolIds({ route, question, allIds: ALL });
  for (const d of Object.keys(DOMAIN_TOOL_IDS)) {
    const r = sel({ domains: [d] });
    t.equal(r.reason, "domains");
    for (const id of CORE_TOOL_IDS) t.ok(r.ids.includes(id), `${d}: core ${id}`);
    for (const id of DOMAIN_TOOL_IDS[d]) t.ok(r.ids.includes(id), `${d}: ${id}`);
    t.deepEqual(r.ids, ALL.filter((id) => r.ids.includes(id)), "registry order is kept");
  }
  t.ok(sel({ domains: ["rules"] }).offered < ALL.length, "a rules question gets fewer than all");
  for (const [route, why] of [[null, "all:no_route"], [{ domains: [] }, "all:no_domains"], [{ domains: ["other"] }, "all:other"], [{ domains: ["rules", "other"] }, "all:other"], [{ domains: ["bogus"] }, "all:unknown_domains"], [{}, "all:no_domains"]]) {
    const r = sel(route);
    t.equal(r.reason, why); t.deepEqual(r.ids, ALL, `${why}: every tool`); t.equal(r.offered, r.total);
  }
  // A tool nobody mapped is always offered, so a future tool cannot silently vanish from the model's view.
  const withNew = selectToolIds({ route: { domains: ["calendar"] }, question: "x", allIds: [...ALL, "future.tool"] });
  t.ok(withNew.ids.includes("future.tool"));
  // Garbage input does not throw.
  for (const q of [undefined, null, 5, {}, "x".repeat(10000)]) t.ok(Array.isArray(selectToolIds({ route: { domains: ["cap"] }, question: q, allIds: ALL }).ids));
  t.deepEqual(selectToolIds({ route: { domains: "cap" }, question: "x", allIds: ALL }).reason, "all:no_domains");
});

test("keyword net: the QUESTION's own words add domains (it only adds; the router cannot remove them)", () => {
  t.ok(keywordDomains("How much cap room does 0003 have?").includes("cap"));
  t.ok(keywordDomains("Who won the title in 2017?").includes("history"));
  t.ok(keywordDomains("Trace 0005's 2021 5th.").includes("picks"));
  t.ok(keywordDomains("Mark Ingram moved three times on 2021-11-25.").includes("players"));
  t.ok(keywordDomains("When is the tag deadline?").includes("calendar"));
  t.deepEqual(keywordDomains(""), []);
  const wrongRouter = selectToolIds({ route: { domains: ["rules"] }, question: "How much cap room does 0003 have?", allIds: ALL });
  t.ok(wrongRouter.ids.includes("cap.position"), "a router that said 'rules' still leaves the cap tools on offer");
  t.ok(wrongRouter.keyword_domains.includes("cap"));
});

test("THE ACCURACY GUARANTEE on the first-10 set: whatever single domain the router answers, every tool the case needs is offered", () => {
  for (const c of FIRST10) {
    const q = QUESTION[c.id];
    t.ok(q, `${c.id} has a question`);
    const expected = c.expected_tools || [];
    for (const d of [...DOMAINS, null]) {
      const r = selectToolIds({ route: d === null ? null : { domains: [d] }, question: q, allIds: ALL });
      for (const id of expected) t.ok(r.ids.includes(id), `${c.id} needs ${id}; router said ${d}`);
    }
    // And with the scripted router's own domains, plus pairs of wrong domains.
    const own = selectToolIds({ route: { domains: SCRIPTED_ROUTES[c.id].domains }, question: q, allIds: ALL });
    for (const id of expected) t.ok(own.ids.includes(id), `${c.id}: ${id} with the scripted route`);
  }
});

test("coverage of the 105-question dev bank: every question trips at least one keyword domain, and a wrong router still offers a useful set", () => {
  const empty = BANK.filter((b) => keywordDomains(b.question).length === 0).map((b) => b.id);
  t.deepEqual(empty, [], `questions the keyword net cannot place: ${empty.join(", ")}`);
  let min = 99, max = 0, sum = 0;
  for (const b of BANK) {
    const r = selectToolIds({ route: { domains: ["rules"] }, question: b.question, allIds: ALL });
    for (const id of CORE_TOOL_IDS) t.ok(r.ids.includes(id));
    min = Math.min(min, r.offered); max = Math.max(max, r.offered); sum += r.offered;
  }
  t.ok(min >= CORE_TOOL_IDS.length && max <= ALL.length);
  t.ok(sum / BANK.length < ALL.length, "narrowing still removes something on average");
});

test("the definitions the loop sends match the registry's own tool names (selection works on ids, the model sees double-underscore names)", () => {
  const specs = toolSpecsForModel();
  t.equal(specs.length, ALL.length);
  const ids = specs.map((s) => toolIdFromModelName(s.name));
  t.deepEqual(ids.slice().sort(), ALL.slice().sort());
});

// ── The modeled prompt cache (used by dry runs and the cost model) ──────────────────────────────
const bigTools = [{ name: "a__b", description: "x".repeat(3000), input_schema: { type: "object", properties: {} } }];
const req = (extra = {}, msgText = "q") => ({ tools: bigTools, system: [{ type: "text", text: "SYS", cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: [{ type: "text", text: msgText, cache_control: { type: "ephemeral" } }] }], ...extra });

test("modeled cache: a request without markers is plain input; the first marked request creates, the next with the same prefix reads", () => {
  const plain = estimateUsage({ ...req(), system: "SYS", messages: [{ role: "user", content: [{ type: "text", text: "q" }] }] }, [], createCacheModel());
  t.ok(!("cache_read_input_tokens" in plain) && plain.input_tokens > 0);
  const cache = createCacheModel();
  const u1 = estimateUsage(req(), [{ type: "text", text: "ok" }], cache);
  t.ok(u1.cache_creation_input_tokens > 0 && u1.cache_read_input_tokens === 0 && u1.input_tokens === 0, JSON.stringify(u1));
  const total1 = u1.input_tokens + u1.cache_creation_input_tokens + u1.cache_read_input_tokens;
  const u2 = estimateUsage(req({}, "q"), [{ type: "text", text: "ok" }], cache);
  t.ok(u2.cache_read_input_tokens === u1.cache_creation_input_tokens && u2.cache_creation_input_tokens === 0, "same prefix: all read");
  // A longer conversation reads the earlier prefix and writes only the increment.
  const r3 = req(); r3.messages = [...r3.messages.map((m) => ({ ...m, content: m.content.map(({ cache_control, ...b }) => b) })), { role: "assistant", content: [{ type: "text", text: "more words here" }] }, { role: "user", content: [{ type: "text", text: "and more", cache_control: { type: "ephemeral" } }] }];
  const u3 = estimateUsage(r3, [], cache);
  t.ok(u3.cache_read_input_tokens >= u1.cache_creation_input_tokens && u3.cache_creation_input_tokens > 0 && u3.cache_creation_input_tokens < total1, JSON.stringify(u3));
  // Different tools = different prefix = a fresh write (the cache never serves a changed definition).
  const u4 = estimateUsage(req({ tools: [{ ...bigTools[0], description: "y".repeat(3000) }] }), [], cache);
  t.equal(u4.cache_read_input_tokens, 0); t.ok(u4.cache_creation_input_tokens > 0);
  // Under the minimum prefix: no caching, no error.
  const small = estimateUsage({ tools: [], system: [{ type: "text", text: "S", cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: [{ type: "text", text: "q", cache_control: { type: "ephemeral" } }] }] }, [], createCacheModel());
  t.ok(!("cache_creation_input_tokens" in small) && small.input_tokens < MIN_CACHEABLE_TOKENS);
  t.equal(BYTES_PER_TOKEN, 2.5);
});

await run("ai_desk_tool_select");
