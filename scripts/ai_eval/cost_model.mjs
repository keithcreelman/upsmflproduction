// Commissioner Desk: a cost model for the first-10 set, built from what the first live run (R1) actually billed.
// Offline only: no network, no key, no ledger writes. Usage: node scripts/ai_eval/cost_model.mjs [--write docs/ai_desk/COST_MODEL.md]
//
// OBSERVED in R1 (question DEV-RUL-02, ledger rows 161-164; the recorded tokens carried the runner's 1.25 margin, so they are divided by 1.25 here):
//   loop round 1: 9,022 in / 187 out   round 2: 11,872 in / 140 out   round 3: 13,397 in / 333 out   router: 1,470 in / 217 out
// NOT observed: the composer call (it failed with HTTP 4xx before R1 could bill it). Its size below is an ASSUMPTION and R2 will measure it.
// Prices: the table in worker/src/desk/prices.js (Sonnet 5.5 in 2 / out 10 / cache read 0.10 / cache write 2.5; Haiku 5.5 in 0.10 / out 0.50), per million tokens.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toolSpecsForModel, toolIdFromModelName } from "../../worker/src/desk/registry.js";
import "../../worker/src/desk/tools/index.js";
import { selectToolIds } from "../../worker/src/desk/tool_select.js";
import { getPrompt } from "../../worker/src/desk/prompts.js";
import { PRICES } from "../../worker/src/desk/prices.js";
import { SCRIPTED_ROUTES } from "./lib/scripted_model.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MARGIN = 1.25;
const BYTES_PER_TOKEN = 2.5;           // R1: about 18.0 KB of loop request billed 7,218 tokens
const R1 = {
  loop_in: [9022, 11872, 13397].map((n) => Math.round(n / MARGIN)),
  loop_out: [187, 140, 333].map((n) => Math.round(n / MARGIN)),
  router_in: Math.round(1470 / MARGIN), router_out: Math.round(217 / MARGIN),
};
const ASSUMED_COMPOSER = { in: 4200, out: 450 };       // not observed
const S = PRICES["claude-sonnet-5-5"], H = PRICES["claude-haiku-5-5"];
const usd = (n) => `$${n.toFixed(4)}`;
const M = 1e6;

const specs = toolSpecsForModel();
const bytesOf = (v) => new TextEncoder().encode(JSON.stringify(v)).length;
const toolBytes = Object.fromEntries(specs.map((s) => [toolIdFromModelName(s.name), bytesOf(s)]));
const allIds = Object.keys(toolBytes);
const systemTokens = Math.ceil(bytesOf(getPrompt("loop").text) / BYTES_PER_TOKEN);
const firstMsgTokens = R1.loop_in[0] - Math.ceil(allIds.reduce((a, id) => a + toolBytes[id], 0) / BYTES_PER_TOKEN) - systemTokens;   // what is left of round 1 in R1
const growth = [R1.loop_in[1] - R1.loop_in[0], R1.loop_in[2] - R1.loop_in[1]];                                                  // tokens each round adds (R1)

// One question's loop cost. tools = the definitions' token count. mode: "plain" | "cold" (first use of the prefix) | "warm" (prefix already cached).
function loopCost(toolTokens, mode) {
  const prefix = toolTokens + systemTokens;
  const inputs = [prefix + firstMsgTokens, prefix + firstMsgTokens + growth[0], prefix + firstMsgTokens + growth[0] + growth[1]];
  let inCost = 0;
  const out = R1.loop_out.reduce((a, n) => a + n, 0) * S.output / M;
  if (mode === "plain") inCost = inputs.reduce((a, n) => a + n, 0) * S.input / M;
  else {
    // round 1 writes (cold) or reads the system+tools prefix and writes the first message (warm); each later round reads everything before and writes its increment
    const r1 = mode === "cold" ? inputs[0] * S.cacheWrite : prefix * S.cacheRead + firstMsgTokens * S.cacheWrite;
    const r2 = inputs[0] * S.cacheRead + growth[0] * S.cacheWrite;
    const r3 = inputs[1] * S.cacheRead + growth[1] * S.cacheWrite;
    inCost = (r1 + r2 + r3) / M;
  }
  return { inputs, cost: inCost + out };
}
const routerCost = (R1.router_in * H.input + R1.router_out * H.output) / M;
const composerCost = (ASSUMED_COMPOSER.in * S.input + ASSUMED_COMPOSER.out * S.output) / M;

// The first-10 cases, with the router domains the scripted router uses (a real router may differ; tool_select adds a keyword net on top).
const set = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/ai_eval/sets/first10.json"), "utf8"));
const bank = fs.readFileSync(path.join(ROOT, "tests/fixtures/ai_desk/eval_bank_dev.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const qOf = Object.fromEntries(bank.map((b) => [b.id, b.question]));
const fullToolTokens = Math.ceil(allIds.reduce((a, id) => a + toolBytes[id], 0) / BYTES_PER_TOKEN);

const rows = set.cases.map((c) => {
  const sel = selectToolIds({ route: { domains: SCRIPTED_ROUTES[c.id].domains }, question: qOf[c.id] || "", allIds });
  const tt = Math.ceil(sel.ids.reduce((a, id) => a + toolBytes[id], 0) / BYTES_PER_TOKEN);
  const fixed = routerCost + composerCost;
  return {
    id: c.id, offered: `${sel.offered}/${sel.total}`, toolTokens: tt,
    old: loopCost(fullToolTokens, "plain").cost + fixed,
    narrowed: loopCost(tt, "plain").cost + fixed,
    fullCached: loopCost(fullToolTokens, "cold").cost + fixed,
    cold: loopCost(tt, "cold").cost + fixed,
    warm: loopCost(tt, "warm").cost + fixed,
  };
});
const sum = (k) => rows.reduce((a, r) => a + r[k], 0);

const lines = [];
const P = (s = "") => lines.push(s);
P("# First-10 cost model (from R1's billed tokens)");
P();
P("Generated by `node scripts/ai_eval/cost_model.mjs`. Offline arithmetic only. MODELED, not measured, until R2.");
P();
P("## What R1 billed (margin removed)");
P(`- Loop request, round 1: ${R1.loop_in[0].toLocaleString()} input tokens = the 14 tool definitions (${fullToolTokens.toLocaleString()}), the loop prompt (${systemTokens}), and the question plus request framing (${firstMsgTokens}, the unmeasured remainder). About ${BYTES_PER_TOKEN} bytes per token.`);
P(`- Rounds 2 and 3 added ${growth[0].toLocaleString()} and ${growth[1].toLocaleString()} tokens (tool results and the model's calls). Outputs: ${R1.loop_out.join(", ")}.`);
P(`- The old shape cost ${usd(loopCost(fullToolTokens, "plain").cost)} for the three loop rounds alone (the plan expected ${usd(0.0358)} for the whole question).`);
P("- The composer was never billed in R1; it is assumed at " + `${ASSUMED_COMPOSER.in.toLocaleString()} in / ${ASSUMED_COMPOSER.out} out (${usd(composerCost)}). R2 will measure it.`);
P();
P("## Tokens in the loop request, per question (round 1)");
P("| case | tools offered | tool-definition tokens | old (all 14) | saved |");
P("|---|---|---:|---:|---:|");
for (const r of rows) P(`| ${r.id} | ${r.offered} | ${r.toolTokens.toLocaleString()} | ${fullToolTokens.toLocaleString()} | ${Math.round((100 * (fullToolTokens - r.toolTokens)) / fullToolTokens)}% |`);
P();
P("## Modeled cost per question and for ten (loop shaped like R1's three rounds; router and composer added)");
P("| case | old | narrowed only | all tools + cache | narrowed + cache (cold) | narrowed + cache (warm) |");
P("|---|---:|---:|---:|---:|---:|");
for (const r of rows) P(`| ${r.id} | ${usd(r.old)} | ${usd(r.narrowed)} | ${usd(r.fullCached)} | ${usd(r.cold)} | ${usd(r.warm)} |`);
P(`| **ten questions, raw** | **${usd(sum("old"))}** | **${usd(sum("narrowed"))}** | **${usd(sum("fullCached"))}** | **${usd(sum("cold"))}** | **${usd(sum("warm"))}** |`);
P(`| ten, with the runner's ${MARGIN}x margin (what the ledger records) | ${usd(sum("old") * MARGIN)} | ${usd(sum("narrowed") * MARGIN)} | ${usd(sum("fullCached") * MARGIN)} | ${usd(sum("cold") * MARGIN)} | ${usd(sum("warm") * MARGIN)} |`);
P(`| mean per question, with margin | ${usd((sum("old") * MARGIN) / 10)} | ${usd((sum("narrowed") * MARGIN) / 10)} | ${usd((sum("fullCached") * MARGIN) / 10)} | ${usd((sum("cold") * MARGIN) / 10)} | ${usd((sum("warm") * MARGIN) / 10)} |`);
P();
P("- **cold**: every question writes its own cache entry (the pessimistic case; the 5-minute entry is only reused by a later question with the same offered tools).");
P("- **warm**: the system-plus-tools prefix was already cached by an earlier question in the run.");
P("- The runner's stop rule is a mean above $0.08 per answered question after five cases.");
P();
P("## What this model cannot tell you");
P("- Real cache behavior: whether the entry is created and read as modeled (usage will show `cache_creation_input_tokens` and `cache_read_input_tokens`). If a prefix were under Anthropic's minimum it would simply not cache and cost the 'narrowed only' column.");
P("- The composer's real token use, the number of loop rounds a real model takes for each question, and retries. R1 saw three rounds on one rules question.");
const text = lines.join("\n") + "\n";
const w = process.argv.indexOf("--write");
if (w > 0 && process.argv[w + 1]) { fs.writeFileSync(path.resolve(ROOT, process.argv[w + 1]), text); console.log(`wrote ${process.argv[w + 1]}`); }
console.log(text);
