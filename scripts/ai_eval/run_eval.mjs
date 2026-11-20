// Commissioner Desk: the paid test runner.
//
// WHAT THESE GATES ARE, HONESTLY. They defend against ACCIDENT and against misuse by an automation (an agent, a script, a CI job): a typo, a stale plan,
// a repeated run, a forgotten cap, a process that is not a person at a terminal. They do NOT defend against a person who controls Keith's shell and files:
// such a person can edit the ledger, the journals and this code. The authoritative limits are (1) the spend limit set on the provider's side (the Anthropic
// Console workspace) and (2) the human typing the confirmation at a real terminal. The local caps meter ESTIMATED charges from an UNVERIFIED price table.
//
//   node scripts/ai_eval/run_eval.mjs --set scripts/ai_eval/sets/first10.json --mode plan --run-id R1
//   node scripts/ai_eval/run_eval.mjs --set scripts/ai_eval/sets/first10.json --mode dry  --run-id R1
//   node scripts/ai_eval/run_eval.mjs --set scripts/ai_eval/sets/first10.json --mode live --run-id R1 --max-usd 1.00 --approve "R1:1.00:10" \
//        --prices-confirmed <today> --provider-limit-confirmed 2.00 [--first-live-run] [--accept-known-issues]
//   node scripts/ai_eval/run_eval.mjs --ledger-summary
//   Also: --bank <jsonl> --ids a,b,c (cases from a bank), --out <dir>, --ledger <file> (plan and dry only), --no-provider-limit-estimate-only.
//
// Modes
//   plan  Prints the cases, models, max_tokens per step, the worst-case and typical cost (the budget gate's own arithmetic over the real
//         serialized requests) and the caps a run would need. Writes <out>/plan.json. Constructs NO Anthropic client and touches no network.
//   dry   Runs every case through the SAME pipeline, budget gate and ledger with the SCRIPTED model (ledger mode "fake"), scores it with
//         score.mjs, writes results.json and summary.md. globalThis.fetch is a thrower. Zero network. NOT a model result.
//   live  The paid path. Every gate below must pass BEFORE any client is created; a failed gate prints why and exits 2:
//           1 DESK_LIVE_MODEL_ENABLED=1            2 ANTHROPIC_API_KEY_DESK present (the shared ANTHROPIC_API_KEY is never read)
//           3 the four caps set above zero, per-question cap >= the plan's need (and the largest single call), per-run cap >= the plan's need
//           4 a plan file for this run id and set whose costs equal a fresh recomputation (the file is a receipt; its costs are never trusted)
//           5 --approve "<run-id>:<max-usd>:<n-cases>" matching this run exactly; the approved amount is a HARD cap on what this run reserves and spends
//           6 --prices-confirmed <today>: exactly today's local date (or the UTC date when different)
//           7 a dry run of the same set passes first (done here, before any client)
//           8 a person at a real terminal (TTY on stdin AND stdout) types the run id and the approved cap, e.g. "R1 $1.00". There is no way around this:
//             a process without a TTY can never run live.
//           9 no held-out bank, path or id (any mode)     10 while live, globalThis.fetch allows ONLY POST https://api.anthropic.com/v1/messages
//          11 stop rules: hard abort after the first model error or any invariant failure in the first 3 cases; smoke stop if the mean cost
//             per answered question exceeds $0.08 after 5 cases; stop if a journal line cannot be written.
//          12 history: live uses the real home directory only (HOME and UPS_AI_EVAL_HOME are ignored; tests use a canary key to get a temp home); the ledger
//             and BOTH copies of the spend journal must agree; the very first live run needs --first-live-run (refused once history exists); a run id that has
//             any live row, journal line or live results is refused; a set with known issues needs --accept-known-issues.
//          13 a provider-side spend limit: --provider-limit-confirmed <USD> (you set it in the Console; at least --max-usd and at most 3 x --max-usd), or
//             --no-provider-limit-estimate-only (a loud warning; the approved amount may not exceed $2.00).
//         While PRICES_VERIFIED is false, every live call's recorded usage (and so its cost) carries a 1.25 safety margin.
//
// Exit codes: 0 done, 1 failed, 2 refused by a gate (nothing was sent), 3 stopped early by a stop rule, 64 bad usage.
// The key is read once from ANTHROPIC_API_KEY_DESK, handed only to the Anthropic client, never printed, logged or written (all output is redacted).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const NATIVE_FETCH = globalThis.fetch;          // captured before anything can replace it
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const SMOKE_MEAN_USD = 0.08;
export const SMOKE_AFTER_CASES = 5;
export const EARLY_CASES = 3;
export const PLAN_MARGIN = 1.25;                // typical cost = the scripted run's token cost x this margin (a rough guide, not a quote)
export const DRY_DEFAULT_CAPS = Object.freeze({ DESK_BUDGET_PER_QUESTION_USD: "5", DESK_BUDGET_PER_RUN_USD: "50", DESK_BUDGET_MONTHLY_USD: "50", DESK_BUDGET_TOTAL_USD: "500" });
const CAP_VARS = ["DESK_BUDGET_PER_QUESTION_USD", "DESK_BUDGET_PER_RUN_USD", "DESK_BUDGET_MONTHLY_USD", "DESK_BUDGET_TOTAL_USD"];
const RUN_ID_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const CODE_STATES = ["tool_failure", "budget_exceeded", "stale_data", "out_of_scope"];
const HELD_OUT = /held[-_ ]?out|sealed|(^|[\\/])ho([\\/]|$)/i;
export const clients = { constructed: 0 };      // live Anthropic clients created in this process (plan and dry must leave it at 0)

// ── output (everything printed passes through the redactor) ───────────────────────────────────────────
let REDACT = [];
const redact = (s) => { let t = String(s); for (const k of REDACT) if (k) t = t.split(k).join("[REDACTED]"); return t.replace(/sk-ant-[A-Za-z0-9_-]{6,}/g, "[REDACTED]"); };
const say = (s = "") => console.log(redact(s));
const warn = (s = "") => console.error(redact(s));
const money = (n) => `$${(Number(n) || 0).toFixed(4)}`;
const money6 = (n) => `$${(Number(n) || 0).toFixed(6)}`;
const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
// The only dates a price confirmation may carry: today's LOCAL calendar date, or today's UTC date when that differs. Never a day either side of them.
export function acceptableToday(now = new Date()) {
  const p2 = (n) => String(n).padStart(2, "0");
  return { local: `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`, utc: now.toISOString().slice(0, 10) };
}

class Refusal extends Error { constructor(gate, message) { super(message); this.gate = gate; } }
class Usage extends Error {}

// ── arguments ─────────────────────────────────────────────────────────────────────────────────────────
const VALUE_FLAGS = ["--set", "--bank", "--ids", "--mode", "--run-id", "--out", "--ledger", "--max-usd", "--approve", "--prices-confirmed", "--provider-limit-confirmed"];
const BOOL_FLAGS = ["--ledger-summary", "--accept-known-issues", "--first-live-run", "--no-provider-limit-estimate-only"];
export const TEST_KEY = "TEST-CANARY-KEY-NOT-REAL";   // the one literal key that lets tests redirect the live home; a real key never equals it
export const PRICE_MARGIN_UNVERIFIED = 1.25;
export const ESTIMATE_ONLY_MAX_USD = 2.0;
export function parseArgs(argv) {
  const a = { flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (BOOL_FLAGS.includes(f)) a.flags[f] = true;
    else if (VALUE_FLAGS.includes(f)) { if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) throw new Usage(`${f} needs a value`); a.flags[f] = argv[++i]; }
    else throw new Usage(`unknown argument: ${String(f).slice(0, 40)}`);
  }
  return a;
}

// ── held-out guard (gate 9; runs first, in every mode, before any file is read) ────────────────────────
function guardHeldOut(args, idsMaybe = []) {
  for (const f of ["--set", "--bank"]) {
    const v = args.flags[f];
    if (v && (HELD_OUT.test(v) || HELD_OUT.test(path.resolve(v)))) throw new Refusal(9, `${f} points at held-out or sealed material; this runner takes development banks only`);
  }
  const ids = [...(args.flags["--ids"] ? args.flags["--ids"].split(",") : []), ...idsMaybe];
  if (ids.some((x) => /^HO-/i.test(String(x).trim()))) throw new Refusal(9, "a held-out case id (HO-...) was named; this runner takes development cases only");
}

// ── loading the cases ────────────────────────────────────────────────────────────────────────────────
function loadCases(args) {
  const { loadBank } = args._libs.bank;
  let set = null, bankPath, ids;
  const defaultSetPath = path.join(HERE, "sets", "first10.json");
  if (args.flags["--set"]) {
    const sp = path.resolve(args.flags["--set"]);
    set = JSON.parse(fs.readFileSync(sp, "utf8"));
    bankPath = path.resolve(REPO, set.bank);
    if (HELD_OUT.test(bankPath) || HELD_OUT.test(set.bank)) throw new Refusal(9, "the set names a held-out or sealed bank");
    ids = set.cases.map((c) => c.id);
    args._setBytes = fs.readFileSync(sp);
    args._setId = set.set_id || path.basename(sp);
  } else if (args.flags["--bank"] && args.flags["--ids"]) {
    bankPath = path.resolve(args.flags["--bank"]);
    ids = args.flags["--ids"].split(",").map((x) => x.trim()).filter(Boolean);
    set = JSON.parse(fs.readFileSync(defaultSetPath, "utf8"));     // scenario specs live in the first-run set
    args._setBytes = Buffer.from(JSON.stringify({ bank: path.basename(bankPath), ids }));
    args._setId = `ids:${ids.length}`;
  } else throw new Usage("give --set <file>, or --bank <jsonl> with --ids a,b,c");
  guardHeldOut(args, ids);
  const bank = loadBank(bankPath);
  if (bank.errors.length) throw new Usage(`the bank has ${bank.errors.length} malformed line(s)`);
  const cases = ids.map((id) => {
    const caseDef = bank.cases.find((c) => c.id === id);
    const spec = set.cases.find((c) => c.id === id);
    if (!caseDef) throw new Usage(`not in the bank: ${String(id).slice(0, 40)}`);
    if (!spec) throw new Usage(`no scenario is defined for ${String(id).slice(0, 40)}; add it to the set first`);
    if (/^HO-/i.test(caseDef.id) || /held[-_ ]?out/i.test(String(caseDef.split || ""))) throw new Refusal(9, "a held-out case was selected");
    return { caseDef, spec };
  });
  const setSha = sha256(Buffer.concat([args._setBytes, fs.readFileSync(bankPath)]));
  return { set, cases, setSha, bankPath };
}

// ── ledger and output locations ──────────────────────────────────────────────────────────────────────
// Everything the runner keeps lives in ONE folder: ~/.ups_ai_eval. UPS_AI_EVAL_HOME may move it, but only to a folder under the OS temp folder (tests do);
// anywhere else it is ignored with a warning, so a stray variable can never point live spending at a fresh ledger.
function realpathNearest(p) {
  let cur = path.resolve(p); const rest = [];
  for (;;) { try { return path.join(fs.realpathSync(cur), ...rest.reverse()); } catch (_) { const up = path.dirname(cur); if (up === cur) return path.resolve(p); rest.push(path.basename(cur)); cur = up; } }
}
export function evalHome(env = process.env) {
  const o = env.UPS_AI_EVAL_HOME;
  if (typeof o === "string" && o.trim()) {
    const real = realpathNearest(o), tmp = realpathNearest(os.tmpdir());
    if (real !== tmp && real.startsWith(tmp + path.sep)) return path.resolve(o);
    warn("UPS_AI_EVAL_HOME is ignored: it may only name a folder under the OS temp folder.");
  }
  return path.join(os.homedir(), ".ups_ai_eval");
}
// LIVE uses the real home directory (os.userInfo().homedir): HOME and UPS_AI_EVAL_HOME are ignored, so no environment variable can start live
// spending from a fresh, empty history. Tests need a temp home; they get one ONLY with the literal canary key AND UPS_AI_EVAL_UNDER_TEST=1.
// The second copy of the journal lives outside ~/.ups_ai_eval (macOS: ~/Library/Application Support/UPS AI Eval, elsewhere ~/.local/share/ups-ai-eval).
export function liveHome(env = process.env) {
  if (env.ANTHROPIC_API_KEY_DESK === TEST_KEY && env.UPS_AI_EVAL_UNDER_TEST === "1") {
    const o = env.UPS_AI_EVAL_HOME;
    if (typeof o !== "string" || !o.trim()) throw new Refusal(12, "test mode needs UPS_AI_EVAL_HOME.");
    const real = realpathNearest(o), tmp = realpathNearest(os.tmpdir());
    if (!(real !== tmp && real.startsWith(tmp + path.sep))) throw new Refusal(12, "test mode: UPS_AI_EVAL_HOME must be a folder under the OS temp folder.");
    return { home: path.resolve(o), second: path.join(path.resolve(o), "second_copy"), test: true };
  }
  const h = os.userInfo().homedir;
  return { home: path.join(h, ".ups_ai_eval"), second: process.platform === "darwin" ? path.join(h, "Library", "Application Support", "UPS AI Eval") : path.join(h, ".local", "share", "ups-ai-eval"), test: false };
}
const defaultLedger = (home) => path.join(home, "ledger.sqlite");
const journalPath = (home) => path.join(home, "spend_journal.jsonl");
const defaultOut = (home, runId) => path.join(home, "runs", runId);
const isSymlink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch (_) { return false; } };
const mkdirp = (d) => fs.mkdirSync(d, { recursive: true, mode: 0o700 });

// ── the cap settings (the same reading the budget gate uses) ──────────────────────────────────────────
function capsFrom(env) {
  const num = (v) => { const s = String(v == null ? "" : v).trim(); return /^\d+(\.\d+)?$/.test(s) && Number(s) > 0 ? Number(s) : 0; };
  return { perQuestion: num(env.DESK_BUDGET_PER_QUESTION_USD), perRun: num(env.DESK_BUDGET_PER_RUN_USD), monthly: num(env.DESK_BUDGET_MONTHLY_USD), total: num(env.DESK_BUDGET_TOTAL_USD) };
}
function dryCapsFrom(env) {
  const c = capsFrom(env);
  const allSet = c.perQuestion > 0 && c.perRun > 0 && c.monthly > 0 && c.total > 0;
  return allSet ? Object.fromEntries(CAP_VARS.map((k) => [k, String(env[k])])) : { ...DRY_DEFAULT_CAPS };
}

// ── PLAN ──────────────────────────────────────────────────────────────────────────────────────────────
// Runs every case once with the scripted model against an in-memory ledger (so nothing persists) and reads the budget gate's own numbers
// (est_cost_usd = the worst-case reservation computed from the REAL serialized request) for each call.
async function buildPlan({ cases, runId, setSha, setId }) {
  const { runCase, makeLedgerDb } = await import("./lib/scenario_env.mjs");
  const { createScriptedClient, SCRIPTED_CASE_IDS } = await import("./lib/scripted_model.mjs");
  const { LOOP_LIMITS } = await import("../../worker/src/desk/loop.js");
  const { estimateWorstCaseUsd, priceFor, PRICES, PRICES_AS_OF, PRICES_VERIFIED, PRICE_TABLE_VERSION } = await import("../../worker/src/desk/prices.js");
  const db = makeLedgerDb();
  const out = { run_id: runId, set_id: setId, set_sha256: setSha, n_cases: cases.length, case_ids: cases.map((c) => c.caseDef.id), created_at: new Date().toISOString(), basis: "SCRIPTED run: real requests, real tools, the budget gate's own arithmetic; typical cost = scripted token cost x margin", margin: PLAN_MARGIN, cases: [], totals: null, required_caps: null, steps: {}, prices: { as_of: PRICES_AS_OF, version: PRICE_TABLE_VERSION, verified: PRICES_VERIFIED, usd_per_million_tokens: JSON.parse(JSON.stringify(PRICES)) }, known_issues: [], clients_constructed: 0 };
  let seq = [];                                            // every call of the whole run, in order: { est, typical }
  try {
    for (const { caseDef, spec } of cases) {
      if (!SCRIPTED_CASE_IDS.includes(caseDef.id)) throw new Usage(`no scripted path exists to plan ${caseDef.id}`);
      const r = await runCase({ caseDef, spec, client: createScriptedClient(caseDef.id), gateEnv: { ...DRY_DEFAULT_CAPS }, db, runId: `plan-${runId}`, clock: "real" });
      const steps = r.ledger.map((x, i) => ({ step: x.step, model: x.model, max_tokens: (r.gate[i] || {}).max_tokens || null, reserve_usd: x.est_cost_usd, typical_usd: (x.cost_usd || 0) * PLAN_MARGIN }));
      let before = 0, qNeed = 0;
      for (const s of steps) { qNeed = Math.max(qNeed, before + s.reserve_usd); before += s.typical_usd; }
      // The protocol bound: the expected path, plus every allowed loop round still unused (each later request carrying two more maximum-size
      // tool results) and one composer retry. Never expected; it shows what the code's own limits allow before the caps step in.
      const loopSteps = steps.filter((s) => s.step === "loop"), last = loopSteps[loopSteps.length - 1], comp = steps.find((s) => s.step === "composer");
      let extra = 0;
      if (last) {
        const p = priceFor(last.model);
        const lastTokens = (last.reserve_usd * 1e6 - last.max_tokens * p.output) / p.input;
        for (let j = 1; j <= Math.max(0, LOOP_LIMITS.rounds + 1 - loopSteps.length); j++) extra += estimateWorstCaseUsd({ model: last.model, inputTokensEstimate: lastTokens + j * 2 * 12500, maxOutputTokens: last.max_tokens });
      }
      if (comp) extra += comp.reserve_usd + estimateWorstCaseUsd({ model: comp.model, inputTokensEstimate: 3000 / 3.5, maxOutputTokens: 0 });
      const worst = steps.reduce((a, s) => a + s.reserve_usd, 0);
      out.cases.push({ id: caseDef.id, category: caseDef.category, calls: steps.length, steps, worst_expected_path_usd: worst, typical_usd: steps.reduce((a, s) => a + s.typical_usd, 0), largest_call_reserve_usd: Math.max(...steps.map((s) => s.reserve_usd)), protocol_bound_usd: worst + extra, question_cap_needed_usd: qNeed, scripted_state: r.card.state });
      for (const s of steps) seq.push({ est: s.reserve_usd, typical: s.typical_usd });
      if (spec.known_issue) out.known_issues.push({ id: caseDef.id, note: spec.known_issue });
      for (const s of steps) { const k = s.step === "retry" ? "composer" : s.step; if (!out.steps[k]) out.steps[k] = { model: s.model, max_tokens: s.max_tokens }; }
    }
  } finally { db.close(); }
  let running = 0, runNeed = 0;
  for (const c of seq) { runNeed = Math.max(runNeed, running + c.est); running += c.typical; }
  const sum = (k) => out.cases.reduce((a, c) => a + c[k], 0);
  out.totals = { worst_expected_path_usd: sum("worst_expected_path_usd"), typical_usd: sum("typical_usd"), protocol_bound_usd: sum("protocol_bound_usd"), largest_single_reserve_usd: Math.max(...out.cases.map((c) => c.largest_call_reserve_usd)) };
  const qNeed = Math.max(...out.cases.map((c) => c.question_cap_needed_usd));
  const up = (n) => Math.ceil(n * 100) / 100;
  out.required_caps = { per_question_min_usd: Math.max(qNeed, out.totals.largest_single_reserve_usd), per_run_min_usd: Math.max(runNeed, out.totals.typical_usd), monthly_min_usd: Math.max(runNeed, out.totals.typical_usd), total_min_usd: Math.max(runNeed, out.totals.typical_usd) };
  out.recommended_caps = { per_question_usd: up(out.required_caps.per_question_min_usd * 1.5), per_run_usd: up(out.required_caps.per_run_min_usd * 1.5), monthly_usd: up(out.required_caps.monthly_min_usd * 2), total_usd: up(out.required_caps.total_min_usd * 2) };
  out.clients_constructed = clients.constructed;
  return out;
}

function printPlan(plan, { heading = "PLAN (no spend, no network, no Anthropic client)" } = {}) {
  say(`Run ${plan.run_id}: ${heading}`);
  say(`Set ${plan.set_id}: ${plan.n_cases} cases. ${plan.basis}.`);
  say(`Price table ${plan.prices.version} (as of ${plan.prices.as_of}); verified against an account: ${plan.prices.verified ? "yes" : "NO (you confirm it at the live step)"}`);
  for (const [m, p] of Object.entries(plan.prices.usd_per_million_tokens || {})) say(`  ${pad(m, 20)}input $${p.input} and output $${p.output} per million tokens`);
  say("");
  say("Models and limits per step:");
  say(`  ${pad("step", 10)}${pad("model", 20)}max_tokens`);
  for (const [k, v] of Object.entries(plan.steps)) say(`  ${pad(k, 10)}${pad(v.model, 20)}${v.max_tokens}${k === "loop" ? "   (up to 7 calls per question)" : k === "composer" ? "   (plus 1 retry if the validator rejects the card)" : ""}`);
  say("");
  say("Cost per question, USD:");
  say(`  ${pad("case", 12)}${rpad("calls", 6)}${rpad("typical", 10)}${rpad("worst, path", 13)}${rpad("largest call", 14)}${rpad("protocol bound", 16)}`);
  for (const c of plan.cases) say(`  ${pad(c.id, 12)}${rpad(c.calls, 6)}${rpad(money(c.typical_usd), 10)}${rpad(money(c.worst_expected_path_usd), 13)}${rpad(money(c.largest_call_reserve_usd), 14)}${rpad(money(c.protocol_bound_usd), 16)}`);
  const t = plan.totals;
  say(`  ${pad("TOTAL", 12)}${rpad(plan.cases.reduce((a, c) => a + c.calls, 0), 6)}${rpad(money(t.typical_usd), 10)}${rpad(money(t.worst_expected_path_usd), 13)}${rpad(money(t.largest_single_reserve_usd), 14)}${rpad(money(t.protocol_bound_usd), 16)}`);
  say("  typical        what the run should cost (scripted token counts + a 25 percent margin; a real model varies)");
  say("  worst, path    the most the expected path can cost: the sum of the gate's worst-case reservations");
  say("  largest call   the biggest single reservation (the per-question cap must be at least this)");
  say("  protocol bound if the model used every allowed loop round and a retry (never expected)");
  say("");
  say("Caps that would be needed (the gate fails closed below these):");
  say(`  DESK_BUDGET_PER_QUESTION_USD at least ${money(plan.required_caps.per_question_min_usd)}   (recommended ${plan.recommended_caps.per_question_usd.toFixed(2)})`);
  say(`  DESK_BUDGET_PER_RUN_USD      at least ${money(plan.required_caps.per_run_min_usd)}   (recommended ${plan.recommended_caps.per_run_usd.toFixed(2)})`);
  say(`  DESK_BUDGET_MONTHLY_USD      at least ${money(plan.required_caps.monthly_min_usd)}   (recommended ${plan.recommended_caps.monthly_usd.toFixed(2)})`);
  say(`  DESK_BUDGET_TOTAL_USD        at least ${money(plan.required_caps.total_min_usd)}   (recommended ${plan.recommended_caps.total_usd.toFixed(2)})`);
  say(`Total worst case on the expected path: ${money(t.worst_expected_path_usd)}; protocol bound: ${money(t.protocol_bound_usd)}. The per-run cap is the hard ceiling either way.`);
  for (const k of plan.known_issues) say(`KNOWN ISSUE ${k.id}: ${k.note}`);
  say(`Anthropic clients constructed: ${plan.clients_constructed}`);
}

// ── Invariants, results, scoring ──────────────────────────────────────────────────────────────────────
const TOKEN_RE = /\{\{f\.c\d{1,3}\.[a-z][a-z0-9_]{0,63}\}\}/g;
function modelProse(card) {
  const o = [card.lead_md, card.ruling_question];
  for (const b of card.blocks || []) { o.push(b.title); for (const c of b.columns || []) o.push(c); for (const r of b.rows || []) for (const c of r) o.push(c); }
  for (const c of card.cites || []) o.push(c.claim);
  for (const f of card.follow_ups || []) o.push(f);
  for (const c of card.conflicts || []) o.push(c.note);
  return o.filter((x) => typeof x === "string");
}
export function invariantFailures(r, perQuestionCapUsd) {
  const fails = [];
  const card = r.card;
  if (!card || typeof card.state !== "string") return ["no card"];
  // League terms a glossary.lookup returned in this run may be written as spelled even with a digit in them ("Vet-Ext1"): the validator allows it, so this does too.
  const terms = [];
  for (const e of r.envelopes || []) if (e && e.tool === "glossary.lookup" && e.status === "ok" && e.data && Array.isArray(e.data.entries)) for (const g of e.data.entries) terms.push(g.term, ...(g.aliases || []));
  const termRe = terms.filter((x) => typeof x === "string" && x.length >= 2).length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${terms.filter((x) => typeof x === "string" && x.length >= 2).sort((x, y) => y.length - x.length).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\p{L}\\p{N}])`, "gu") : null;
  const typed = (s) => /\d/.test(s.replace(TOKEN_RE, " ").replace(termRe || /$^/, " "));
  if (!CODE_STATES.includes(card.state) && modelProse(card).some(typed)) fails.push("a digit in model prose outside a fact token");
  for (const id of card.facts_used || []) if (!(card.facts && card.facts[id])) fails.push(`fact ${id} is used but not on the card`);
  const spent = r.ledger.reduce((a, x) => a + (x.cost_usd == null ? x.est_cost_usd : x.cost_usd), 0);
  if (perQuestionCapUsd != null && spent > perQuestionCapUsd + 1e-9) fails.push(`spend ${money6(spent)} is above the per-question cap ${money6(perQuestionCapUsd)}`);
  if (Math.abs(spent - (card.footer ? card.footer.cost_usd : 0)) > 1e-6) fails.push("the card's cost does not match the ledger");
  return fails;
}

function caseRecord(r, { spec, caseDef }, score, extra = {}) {
  const spent = r.ledger.reduce((a, x) => a + (x.cost_usd == null ? x.est_cost_usd : x.cost_usd), 0);
  return {
    id: caseDef.id, category: caseDef.category, question: caseDef.question, scenario: spec.scenario, known_issue: spec.known_issue || null, scorer_note: spec.scorer_note || null,
    state: r.card.state, outcome: r.trace.outcome, as_of: r.trace.as_of, as_of_source: r.trace.as_of_source, final_card: r.card,
    tool_calls: r.toolCalls.map((c) => ({ call_id: c.call_id, tool: c.tool, args_sent: c.args, args_run: c.args_run || c.args, status: (r.envelopes.find((e) => e.call_id === c.call_id) || {}).status || null })),
    facts: r.envelopes.flatMap((e) => (e.facts || []).map((f) => ({ ...f, tool: e.tool, call_id: e.call_id }))),
    gaps: r.envelopes.flatMap((e) => ((e.coverage && e.coverage.gaps) || []).map((g) => ({ ...g, call_id: e.call_id }))),
    route_calls: r.routes.map((x) => ({ path: x.path, status: x.status, fault: x.fault })),
    validator: r.validator.map((v) => ({ attempt: v.attempt, ok: v.ok, matches_pipeline: v.matches_pipeline, failed_rules: v.rules.filter((x) => !x.pass).map((x) => x.id), errors: v.errors.map((e) => ({ code: e.code, path: e.path })), model_card: v.card })),
    oracle: r.oracle, oracle_check: r.oracleCheck, score: score || null,
    cost_usd: spent, reserved_usd: r.ledger.reduce((a, x) => a + x.est_cost_usd, 0), latency_ms: r.ms, model_calls: r.modelCalls, ledger: r.ledger, gate: r.gate,
    ...extra,
  };
}

async function scoreRecords(runs, knowledge) {
  const scoreMod = await import("./score.mjs");
  const { glossaryTerms } = await import("../../worker/src/desk/composer.js");   // league terms a glossary.lookup returned this run (digits allowed as spelled)
  const v = await scoreMod.verifyHash({ scorerPath: path.join(HERE, "score.mjs"), thresholdsPath: path.join(HERE, "thresholds.mjs"), hashPath: path.join(HERE, "SCORER_SHA256") });
  if (!v.ok) return { error: "the scorer hash does not match SCORER_SHA256; scoring was skipped" };
  const result = scoreMod.scoreRun({ pairs: runs.map(({ r, caseDef }) => ({ case: caseDef, card: r.card, latency_ms: r.ms, cost_usd: r.card.footer.cost_usd, allowed_terms: glossaryTerms(r.envelopes) })), ctx: { rules: knowledge.rules } });
  return result;
}

function renderSummary(res) {
  const L = [];
  L.push(`# Commissioner Desk eval: run ${res.run_id} (${res.mode})`);
  L.push("");
  L.push(res.scripted ? "**SCRIPTED MODEL: this proves tools, facts and validation, not model quality. No AI was used and nothing was spent.**" : "**LIVE MODEL run.**");
  L.push("");
  L.push(`Set ${res.set_id}, ${res.n_cases_run} of ${res.n_cases_planned} cases run. ${res.stopped ? `STOPPED: ${res.stopped.reason}` : "Completed."}`);
  L.push(`Total cost ${money6(res.totals.cost_usd)} (reserved before calls ${money6(res.totals.reserved_usd)}); mean per question ${money6(res.totals.mean_cost_usd)}; network attempts outside the allowed call: ${res.network_attempts}.`);
  L.push("");
  L.push("| case | state | oracle | score | cost | latency ms | notes |");
  L.push("|---|---|---|---|---|---|---|");
  for (const c of res.cases) {
    const sc = c.score ? (c.score.pass ? "pass" : `FAIL: ${c.score.reasons.join(", ")}`) : "n/a";
    const orc = c.oracle_check.pass === true ? "pass" : c.oracle_check.pass === false ? "MISMATCH" : "n/a";
    L.push(`| ${c.id} | ${c.state} | ${orc} | ${sc} | ${money6(c.cost_usd)} | ${c.latency_ms} | ${c.known_issue ? "KNOWN ISSUE" : ""}${c.invariant_failures && c.invariant_failures.length ? ` INVARIANT: ${c.invariant_failures.join("; ")}` : ""} |`);
  }
  if (res.score && res.score.metrics) {
    L.push("");
    L.push("Scorer metrics (small denominators; a single failure can block):");
    for (const m of res.score.metrics) L.push(`- ${m.ok === true ? "ok" : m.ok === false ? "FAIL" : "n/a"} ${m.id}${m.failures == null ? (m.observed == null ? "" : `: ${m.observed}`) : `: ${m.failures} of ${m.n} (allowed ${m.allowed_failures})`}`);
    L.push(res.score.blocked ? "Scorer verdict: BLOCKED (read the failing metrics above)." : "Scorer verdict: thresholds met on the measured metrics.");
  } else if (res.score && res.score.error) L.push(`\nScoring: ${res.score.error}`);
  const mism = res.cases.filter((c) => c.oracle_check.pass === false);
  if (mism.length) { L.push(""); for (const c of mism) L.push(`- ORACLE MISMATCH ${c.id}: ${c.oracle_check.detail}${c.known_issue ? ` (known issue: ${c.known_issue})` : ""}`); }
  const notes = res.cases.filter((c) => c.scorer_note && c.score && !c.score.pass);
  if (notes.length) { L.push(""); for (const c of notes) L.push(`- Scorer note ${c.id}: ${c.scorer_note}`); }
  return L.join("\n") + "\n";
}

function writeOutputs(outDir, res) {
  mkdirp(outDir);
  fs.writeFileSync(path.join(outDir, "results.json"), redact(JSON.stringify(res, null, 2)) + "\n", { mode: 0o600 });
  fs.writeFileSync(path.join(outDir, "summary.md"), redact(renderSummary(res)), { mode: 0o600 });
}

// ── DRY ───────────────────────────────────────────────────────────────────────────────────────────────
async function runDry({ cases, runId, setSha, setId, ledgerFile, env, outDir, label = "dry" }) {
  const { runCase, makeLedgerDb, makeKnowledge } = await import("./lib/scenario_env.mjs");
  const { createScriptedClient, SCRIPTED_CASE_IDS } = await import("./lib/scripted_model.mjs");
  const caps = dryCapsFrom(env);
  mkdirp(path.dirname(ledgerFile));
  const db = makeLedgerDb(ledgerFile);
  const knowledge = await makeKnowledge();
  let attempts = 0;
  const saved = globalThis.fetch;
  globalThis.fetch = () => { attempts += 1; throw new Error("network is blocked in dry mode"); };
  const runs = [], records = [];
  let failure = null;
  try {
    for (const c of cases) {
      if (!SCRIPTED_CASE_IDS.includes(c.caseDef.id)) throw new Usage(`no scripted path exists for ${c.caseDef.id}`);
      const r = await runCase({ caseDef: c.caseDef, spec: c.spec, client: createScriptedClient(c.caseDef.id), gateEnv: { ...caps }, db, runId, clock: "real" });
      runs.push({ r, caseDef: c.caseDef, spec: c.spec });
    }
  } finally { globalThis.fetch = saved; db.close(); }
  const score = await scoreRecords(runs, knowledge);
  for (const { r, caseDef, spec } of runs) {
    const sc = score.per_case ? score.per_case.find((x) => x.id === caseDef.id) : null;
    const inv = invariantFailures(r, Number(caps.DESK_BUDGET_PER_QUESTION_USD));
    records.push(caseRecord(r, { spec, caseDef }, sc, { invariant_failures: inv }));
  }
  // The dry run PASSES when the plumbing held: no unexpected code-built failure card, no invariant failure, no network attempt, a fake-lane ledger
  // row for every call and no live row. A fixture oracle that disagrees fails it too, unless the set marks that case as a known issue.
  const problems = [];
  for (const rec of records) {
    if (CODE_STATES.includes(rec.state)) problems.push(`${rec.id}: the pipeline ended in ${rec.state} (${rec.outcome})`);
    if (rec.invariant_failures.length) problems.push(`${rec.id}: ${rec.invariant_failures.join("; ")}`);
    if (rec.oracle_check.pass === false && !rec.known_issue) problems.push(`${rec.id}: oracle mismatch (${rec.oracle_check.detail})`);
    if (rec.ledger.some((x) => x.mode === "live")) problems.push(`${rec.id}: a live ledger row in a dry run`);
    if (rec.gate.some((g) => !g.ok)) problems.push(`${rec.id}: the budget gate blocked a call (${rec.gate.filter((g) => !g.ok).map((g) => g.reason).join(", ")})`);
  }
  if (attempts) problems.push(`${attempts} network attempt(s) in dry mode`);
  const res = {
    run_id: runId, mode: label, scripted: true, label: "SCRIPTED MODEL: this proves tools, facts and validation, not model quality", set_id: setId, set_sha256: setSha,
    started_at: new Date().toISOString(), finished_at: new Date().toISOString(), n_cases_planned: cases.length, n_cases_run: records.length, stopped: null,
    caps: { ...caps }, network_attempts: attempts, passed: problems.length === 0, problems, cases: records,
    totals: { cost_usd: records.reduce((a, c) => a + c.cost_usd, 0), reserved_usd: records.reduce((a, c) => a + c.reserved_usd, 0), mean_cost_usd: records.length ? records.reduce((a, c) => a + c.cost_usd, 0) / records.length : 0 },
    score: score.per_case ? { blocked: score.blocked, metrics: score.metrics, zero_tolerance: score.zero_tolerance, needs_human_review: score.needs_human_review } : score,
  };
  if (outDir) writeOutputs(outDir, res);
  return res;
}

// ── The spend journal ─────────────────────────────────────────────────────────────────────────────────
// Append-only, one line per live call, written right after the ledger finalizes that call: run id, call index, what was reserved, the final cost, the time.
// No text of any kind. It is the second record that live preflight cross-checks against the ledger, so a deleted or swapped ledger cannot hide earlier spending.
export function readJournal(file) {
  if (!fs.existsSync(file)) return { exists: false, count: 0, total: 0, runs: new Set() };
  let count = 0, total = 0; const runs = new Set();
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch (_) { throw new Refusal(12, "the spend journal has a line that cannot be read; it will not be trusted. Look at " + file); }
    const v = j.final_cost_usd == null ? j.reserved_usd : j.final_cost_usd;
    if (!Number.isFinite(Number(v))) throw new Refusal(12, "the spend journal has a line with no cost; it will not be trusted.");
    count += 1; total += Number(v); runs.add(String(j.run_id));
  }
  return { exists: true, count, total, runs };
}
// Two copies are written with every line (the second outside ~/.ups_ai_eval). A write that fails on EITHER copy stops the run.
export function makeJournal(files, runId) {
  const list = Array.isArray(files) ? files : [files];
  for (const file of list) { mkdirp(path.dirname(file)); fs.closeSync(fs.openSync(file, "a", 0o600)); }   // both must be writable before the first paid call
  const j = { failed: false, index: 0, files: list };
  j.before = () => (j.failed ? "journal_unwritable" : null);       // once a line could not be written, no further call is made
  j.after = ({ row, questionId }) => {
    j.index += 1;
    const line = JSON.stringify({ v: 1, run_id: runId, call_index: j.index, question_id: questionId, step: row.step, model: row.model, reserved_usd: row.est_cost_usd, final_cost_usd: row.cost_usd, ts: new Date().toISOString() }) + "\n";
    for (const file of list) { try { fs.appendFileSync(file, line, { mode: 0o600 }); } catch (_) { j.failed = true; } }
  };
  return j;
}

// Ledger against both journals. Refuses on any disagreement, on one record missing or empty while another shows spending, on a first run without
// --first-live-run (and the flag once history exists), and on any reuse of a run id.
function liveResultsIn(home) {
  const found = [];
  const runsDir = path.join(home, "runs");
  let names = []; try { names = fs.readdirSync(runsDir); } catch (_) { names = []; }
  for (const n of names) {
    const rf = path.join(runsDir, n, "results.json");
    if (!fs.existsSync(rf)) continue;
    let mode = null; try { mode = JSON.parse(fs.readFileSync(rf, "utf8")).mode; } catch (_) { mode = "unreadable"; }
    if (mode === "live" || mode === "unreadable") found.push(n);
  }
  return found;
}
function liveHistoryCheck({ ledgerFile, journalFiles, runId, home, outDir, firstLiveRun }) {
  const jrs = journalFiles.map((f) => ({ file: f, ...readJournal(f) }));
  let live = { n: 0, total: 0, month: 0, byRun: 0, totalsRow: 0 };
  if (fs.existsSync(ledgerFile)) {
    const db = new DatabaseSync(ledgerFile, { readOnly: true });
    try {
      let rows, tot, mon, byRun;
      try {
        rows = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN cost_usd IS NULL THEN est_cost_usd ELSE cost_usd END), 0) AS s FROM ai_call_log WHERE mode = 'live'").get();
        tot = db.prepare("SELECT COALESCE(reserved_usd + spent_usd, 0) AS s FROM ai_budget_totals WHERE mode = 'live' AND period = 'total'").get();
        mon = db.prepare("SELECT COALESCE(reserved_usd + spent_usd, 0) AS s FROM ai_budget_totals WHERE mode = 'live' AND period = ?").get(new Date().toISOString().slice(0, 7));
        byRun = db.prepare("SELECT COUNT(*) AS n FROM ai_call_log WHERE run_id = ? AND mode = 'live'").get(runId);
      } catch (_) { rows = { n: 0, s: 0 }; tot = null; mon = null; byRun = { n: 0 }; }   // no tables yet: no spending
      live = { n: rows.n, total: rows.s, month: mon ? mon.s : 0, byRun: byRun.n, totalsRow: tot ? tot.s : 0 };
    } finally { db.close(); }
  }
  const sources = [{ name: "the ledger", n: live.n, total: live.total, where: ledgerFile }, ...jrs.map((j, i) => ({ name: i === 0 ? "the spend journal" : "the second copy of the spend journal", n: j.count, total: j.total, where: j.file }))];
  const withSpend = sources.filter((x) => x.n > 0), without = sources.filter((x) => x.n === 0);
  if (withSpend.length && without.length) throw new Refusal(12, `${without.map((x) => x.name).join(" and ")} show no live spending (missing, empty or replaced) while ${withSpend.map((x) => `${x.name} shows ${x.n} live call(s) / ${money6(x.total)}`).join(" and ")}. Live runs stop until that is explained: restore ${without.map((x) => x.where).join(" and ")}.`);
  const first = sources[0];
  if (sources.some((x) => x.n !== first.n || Math.abs(x.total - first.total) > 1e-6)) throw new Refusal(12, `the ledger and the spend journals disagree: ${sources.map((x) => `${x.name} ${x.n} call(s) / ${money6(x.total)}`).join("; ")}. Live runs stop until that is explained (look at ${sources.map((x) => x.where).join(", ")}).`);
  if (Math.abs(live.totalsRow - live.total) > 1e-6) throw new Refusal(12, `the ledger's maintained live total (${money6(live.totalsRow)}) does not equal its rows (${money6(live.total)}); it was edited or is damaged.`);
  const results = liveResultsIn(home);
  if (results.length && !withSpend.length) throw new Refusal(12, `the runs folder holds live results (${results.join(", ")}) but the ledger and both journals show no live spending; they were removed or replaced. Live runs stop until that is explained.`);
  const history = withSpend.length > 0 || results.length > 0;
  if (!history && !firstLiveRun) throw new Refusal(12, "no earlier live spending is recorded anywhere (ledger, both journals, runs folder). If this really is your first live run, pass --first-live-run. If you have run live before, the records are gone: stop and look.");
  if (history && firstLiveRun) throw new Refusal(12, "--first-live-run is only for the very first live run, and earlier live spending exists. Run again without it.");
  if (live.byRun > 0) throw new Refusal(12, `run id ${runId} already has live rows in the ledger; use a new run id.`);
  if (jrs.some((j) => j.runs.has(runId))) throw new Refusal(12, `run id ${runId} already appears in the spend journal; use a new run id.`);
  for (const dir of new Set([defaultOut(home, runId), outDir])) {
    const rf = path.join(dir, "results.json");
    if (!fs.existsSync(rf)) continue;
    let mode = null; try { mode = JSON.parse(fs.readFileSync(rf, "utf8")).mode; } catch (_) { mode = "unreadable"; }
    if (mode === "live" || mode === "unreadable") throw new Refusal(12, `${dir} already holds live results for run id ${runId}; use a new run id.`);
  }
  return { liveTotal: live.total, liveMonth: live.month, journalCount: first.n };
}

// ── LIVE gates ────────────────────────────────────────────────────────────────────────────────────────
// Each check throws Refusal(gate, message). Nothing here creates a client or touches the network.
// `plan` is ALWAYS the fresh recomputation (see verifyPlanFile): no cost figure is ever read from plan.json.
function earlyLiveGates({ env }) {
  if (env.DESK_LIVE_MODEL_ENABLED !== "1") throw new Refusal(1, "DESK_LIVE_MODEL_ENABLED is not 1. Set it in your own terminal for this run only.");
  const key = env.ANTHROPIC_API_KEY_DESK;
  if (typeof key !== "string" || !key.trim()) throw new Refusal(2, "ANTHROPIC_API_KEY_DESK is not set (the shared ANTHROPIC_API_KEY is never read).");
  const caps = capsFrom(env);
  for (const [k, v] of [["DESK_BUDGET_PER_QUESTION_USD", caps.perQuestion], ["DESK_BUDGET_PER_RUN_USD", caps.perRun], ["DESK_BUDGET_MONTHLY_USD", caps.monthly], ["DESK_BUDGET_TOTAL_USD", caps.total]]) {
    if (!(v > 0)) throw new Refusal(3, `${k} must be set above zero.`);
  }
  return { key: key.trim(), caps };
}

// The plan file is only a receipt. Its fingerprint must match, and every cost field in it must equal a fresh recomputation from the set (same code as plan mode).
const costView = (p) => JSON.stringify({ totals: p.totals, required_caps: p.required_caps, recommended_caps: p.recommended_caps, steps: p.steps, prices: p.prices, cases: (p.cases || []).map((c) => ({ ...c })) }, (k, v) => (typeof v === "number" ? Math.round(v * 1e9) / 1e9 : v));
export function verifyPlanFile({ file, fresh, runId, setSha, nCases }) {
  let plan = null; try { plan = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { plan = null; }
  if (!plan) throw new Refusal(4, `no plan found for run ${runId}. Run --mode plan with the same --run-id, --set and --out first.`);
  if (plan.run_id !== runId) throw new Refusal(4, "the plan on file is for a different run id.");
  if (plan.set_sha256 !== setSha) throw new Refusal(4, "the plan on file is for a different set or bank (its fingerprint does not match). Run plan again.");
  if (plan.n_cases !== nCases) throw new Refusal(4, "the plan on file has a different number of cases.");
  if (costView(plan) !== costView(fresh)) throw new Refusal(4, "the costs in the plan file do not match a fresh recomputation from the set. The file was edited or is stale; live runs use only the recomputed plan. Run --mode plan again.");
}

function liveGates({ args, env, runId, plan, ledgerFile, journalFiles, home, outDir, cases, now = new Date() }) {
  const flags = args.flags;
  const { key, caps } = earlyLiveGates({ env });
  // 3: the caps against what the (recomputed) plan says is needed
  const rc = plan.required_caps;
  if (caps.perQuestion + 1e-12 < rc.per_question_min_usd) throw new Refusal(3, `DESK_BUDGET_PER_QUESTION_USD ${caps.perQuestion} is below the ${money(rc.per_question_min_usd)} the plan needs (the largest single call is ${money(plan.totals.largest_single_reserve_usd)}); recommended ${plan.recommended_caps.per_question_usd.toFixed(2)}.`);
  if (caps.perRun + 1e-12 < rc.per_run_min_usd) throw new Refusal(3, `DESK_BUDGET_PER_RUN_USD ${caps.perRun} is below the ${money(rc.per_run_min_usd)} the plan needs (expected cost ${money(plan.totals.typical_usd)}); recommended ${plan.recommended_caps.per_run_usd.toFixed(2)}.`);
  if (caps.monthly + 1e-12 < caps.perRun) throw new Refusal(3, "DESK_BUDGET_MONTHLY_USD is below the per-run cap.");
  if (caps.total + 1e-12 < caps.perRun) throw new Refusal(3, "DESK_BUDGET_TOTAL_USD is below the per-run cap.");
  // 5: the approval string
  const approve = flags["--approve"];
  const m = approve ? /^([A-Za-z0-9_.-]{1,40}):(\d+(?:\.\d+)?):(\d{1,3})$/.exec(approve) : null;
  if (!m) throw new Refusal(5, `--approve "<run-id>:<max-usd>:<n-cases>" is required (for example "${runId}:1.50:${cases.length}").`);
  if (m[1] !== runId) throw new Refusal(5, "the approval names a different run id.");
  if (Number(m[3]) !== cases.length) throw new Refusal(5, `the approval says ${m[3]} cases; this run has ${cases.length}.`);
  const maxUsd = Number(m[2]);
  if (!(maxUsd > 0)) throw new Refusal(5, "the approved maximum must be above zero.");
  if (flags["--max-usd"] == null || Number(flags["--max-usd"]) !== maxUsd) throw new Refusal(5, "--max-usd is missing or does not equal the amount in --approve.");
  // 4 (continued): the approval against the recomputed plan. The approval is also a HARD cap (see the effective caps below).
  if (plan.totals.typical_usd > maxUsd) throw new Refusal(4, `the plan's expected cost ${money(plan.totals.typical_usd)} is above --max-usd ${money(maxUsd)}.`);
  if (maxUsd + 1e-12 < rc.per_run_min_usd) throw new Refusal(3, `--max-usd ${money(maxUsd)} is below the ${money(rc.per_run_min_usd)} the plan needs for the last question to be allowed; the approved amount is the hard per-run cap.`);
  // 13: a provider-side spend limit, or an explicit estimate-only run with a lower ceiling
  const pl = flags["--provider-limit-confirmed"], estOnly = !!flags["--no-provider-limit-estimate-only"];
  if (pl != null && estOnly) throw new Refusal(13, "give --provider-limit-confirmed <USD> OR --no-provider-limit-estimate-only, not both.");
  if (pl == null && !estOnly) throw new Refusal(13, "a provider-side spend limit is required. In the Anthropic Console set a spend limit on the workspace, then pass --provider-limit-confirmed <USD> (at least --max-usd, at most 3 times it). Without one, pass --no-provider-limit-estimate-only (a loud warning, and the approved amount may not exceed $2.00).");
  let providerLimit = null;
  if (pl != null) {
    providerLimit = /^\d+(\.\d+)?$/.test(String(pl)) ? Number(pl) : NaN;
    if (!(providerLimit > 0)) throw new Refusal(13, "--provider-limit-confirmed must be a dollar amount above zero.");
    if (providerLimit + 1e-12 < maxUsd) throw new Refusal(13, `--provider-limit-confirmed ${money(providerLimit)} is below --max-usd ${money(maxUsd)}: the provider would stop the run before the approved amount.`);
    if (providerLimit > 3 * maxUsd + 1e-12) throw new Refusal(13, `--provider-limit-confirmed ${money(providerLimit)} is more than 3 times --max-usd ${money(maxUsd)}: a limit that high does not protect this run. Lower the Console limit or raise the approval.`);
  } else if (maxUsd > ESTIMATE_ONLY_MAX_USD + 1e-12) throw new Refusal(13, `without a provider-side limit the approved amount may not exceed ${money(ESTIMATE_ONLY_MAX_USD)} (--max-usd is ${money(maxUsd)}).`);
  // 6: prices: an exact match to today's local date (or the UTC date when that differs), never a day either side
  const pc = flags["--prices-confirmed"];
  if (!pc || !/^\d{4}-\d{2}-\d{2}$/.test(pc)) throw new Refusal(6, "--prices-confirmed <YYYY-MM-DD> is required: check the price table against your Anthropic account, then pass today's date.");
  const td = acceptableToday(now);
  if (pc !== td.local && pc !== td.utc) throw new Refusal(6, `--prices-confirmed ${pc} is not today. Expected ${td.local} (today's local date)${td.utc !== td.local ? ` or ${td.utc} (today's UTC date)` : ""}; no other day is accepted.`);
  // known issues in the set must be accepted on purpose
  const issues = cases.filter((c) => c.spec.known_issue).map((c) => c.caseDef.id);
  if (issues.length && !flags["--accept-known-issues"]) throw new Refusal(12, `the set has known issues (${issues.join(", ")}); a paid run on them is likely wasted. Fix them, or pass --accept-known-issues to spend on them anyway.`);
  // the ledger and the journal: they must agree, the run id must be new, and the total and monthly caps must have room
  const prior = liveHistoryCheck({ ledgerFile, journalFiles, runId, home, outDir, firstLiveRun: !!flags["--first-live-run"] });
  if (caps.total - prior.liveTotal + 1e-12 < rc.per_run_min_usd) throw new Refusal(3, `the total cap has only ${money(caps.total - prior.liveTotal)} left after ${money(prior.liveTotal)} of earlier live spending; this run needs ${money(rc.per_run_min_usd)}.`);
  if (caps.monthly - prior.liveMonth + 1e-12 < rc.per_run_min_usd) throw new Refusal(3, `the monthly cap has only ${money(caps.monthly - prior.liveMonth)} left this month; this run needs ${money(rc.per_run_min_usd)}.`);
  // The caps the budget gate actually enforces: the approved amount is a hard ceiling on what THIS run reserves and spends.
  const effective = { perQuestion: caps.perQuestion, perRun: Math.min(caps.perRun, maxUsd), monthly: Math.min(caps.monthly, prior.liveMonth + maxUsd), total: Math.min(caps.total, prior.liveTotal + maxUsd) };
  return { key, caps, effective, maxUsd, prior, providerLimit, estimateOnly: estOnly };
}

// The last gate, and the one that matters most: a PERSON at a real terminal. Both streams must be TTYs (an automation has none) and the person must type the
// run id and the approved cap exactly, e.g. "R1 $1.00". The streams are injectable so tests can drive it; the command line always passes process.stdin/stdout.
// (A process that fakes a pseudo-terminal and types the phrase is a person-level bypass, not an accident; the provider-side limit is what stops that.)
export const confirmPhrase = (runId, maxUsd) => `${runId} $${Number(maxUsd).toFixed(2)}`;
export async function liveConfirmation({ runId, maxUsd, input, output, plan = null, estimateOnly = false }) {
  if (!input || !input.isTTY || !output || !output.isTTY) throw new Refusal(8, "live runs need a person at a real terminal (stdin and stdout must be a TTY). A script, an agent or a CI job can never run live; open a terminal and run it yourself.");
  if (plan) printPlan(plan, { heading: "ABOUT TO SPEND REAL MONEY" });
  if (estimateOnly) say("WARNING: no provider-side spend limit. The local caps meter ESTIMATED charges from an UNVERIFIED price table, so a real account rate above the table could cost more than the approved amount.");
  const phrase = confirmPhrase(runId, maxUsd);
  const rl = readline.createInterface({ input, output });
  const answer = await new Promise((resolve) => rl.question(`Type exactly "${phrase}" to start the paid run, anything else cancels: `, resolve));
  rl.close();
  if (String(answer).trim() !== phrase) throw new Refusal(8, `"${phrase}" was not typed; cancelled.`);
  return true;
}

// The only network door while live: POST https://api.anthropic.com/v1/messages. Anything else throws and is counted.
export function makeGuardedFetch(realFetch, counters) {
  return async function guardedFetch(input, init) {
    const url = typeof input === "string" ? input : input && input.url ? input.url : String(input);
    const method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
    if (method === "POST" && url === ANTHROPIC_MESSAGES_URL) { counters.allowed += 1; return realFetch(input, init); }
    counters.blocked += 1;
    throw new Error("blocked: while live, only POST https://api.anthropic.com/v1/messages is allowed");
  };
}

// ── LIVE ──────────────────────────────────────────────────────────────────────────────────────────────
// The price table is unverified: until a human has checked it (PRICES_VERIFIED), every usage count a live call returns is raised 25 percent before the gate prices
// and records it, so recorded tokens and costs carry a safety margin through the same pricing path (budget.js and prices.js are untouched).
export function withPriceMargin(inner, factor) {
  if (!(factor > 1)) return inner;
  return {
    mode: inner.mode,
    async complete(request) {
      const res = await inner.complete(request);
      if (!res || !res.usage || typeof res.usage !== "object") return res;
      const u = { ...res.usage };
      for (const k of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) if (Number.isFinite(u[k])) u[k] = Math.ceil(u[k] * factor);
      return { ...res, usage: u };
    },
  };
}
async function runLive({ cases, runId, setSha, setId, ledgerFile, journalFiles, env, outDir, key, caps, effective, providerLimit, estimateOnly }) {
  const { runCase, makeLedgerDb, makeKnowledge } = await import("./lib/scenario_env.mjs");
  const { createLiveClientFromEnv } = await import("../../worker/src/desk/anthropic_client.js");
  const counters = { allowed: 0, blocked: 0 };
  const guarded = makeGuardedFetch(NATIVE_FETCH, counters);
  const saved = globalThis.fetch;
  globalThis.fetch = guarded;                                     // gate 10: from here on, only the one Anthropic call can leave
  // The gate is given the EFFECTIVE caps: the env caps, each lowered to what the approval allows this run to add (per question unchanged).
  const gateEnv = { DESK_LIVE_MODEL_ENABLED: "1", ANTHROPIC_API_KEY_DESK: key, DESK_BUDGET_PER_QUESTION_USD: String(effective.perQuestion), DESK_BUDGET_PER_RUN_USD: String(effective.perRun), DESK_BUDGET_MONTHLY_USD: String(effective.monthly), DESK_BUDGET_TOTAL_USD: String(effective.total) };
  mkdirp(path.dirname(ledgerFile));
  const journal = makeJournal(journalFiles, runId);
  const { PRICES_VERIFIED } = await import("../../worker/src/desk/prices.js");
  const margin = PRICES_VERIFIED ? 1 : PRICE_MARGIN_UNVERIFIED;
  const db = makeLedgerDb(ledgerFile);
  const knowledge = await makeKnowledge();
  const runs = [], records = [];
  let stopped = null;
  const startedAt = new Date().toISOString();
  try {
    const base = createLiveClientFromEnv({ ANTHROPIC_API_KEY_DESK: key }, guarded);   // the only place a client is made; it gets the desk key only
    clients.constructed += 1;
    if (!base) throw new Refusal(2, "the desk key could not be used to build a client");
    const client = withPriceMargin(base, margin);
    const perQ = effective.perQuestion;
    let spent = 0, answered = 0;
    for (let i = 0; i < cases.length; i++) {
      const { caseDef, spec } = cases[i];
      const r = await runCase({ caseDef, spec, client, gateEnv, db, runId, clock: "real", ledgerHook: journal });
      const inv = invariantFailures(r, perQ);
      const modelError = r.gate.some((g) => g.reason === "model_error");
      const cost = r.ledger.reduce((a, x) => a + (x.cost_usd == null ? x.est_cost_usd : x.cost_usd), 0);
      spent += cost;
      if (!CODE_STATES.includes(r.card.state)) answered += 1;
      runs.push({ r, caseDef, spec });
      records.push({ r, caseDef, spec, inv, modelError, cost });
      const n = i + 1;
      if (journal.failed) { stopped = { reason: "hard abort: the spend journal could not be written, so no further call was made", after_cases: i + 1 }; break; }
      if (modelError) { stopped = { reason: `hard abort: a model call failed in ${caseDef.id}`, after_cases: n }; break; }
      if (n <= EARLY_CASES && (inv.length || r.trace.outcome === "tool_failure:validation")) { stopped = { reason: `hard abort: ${inv.length ? `invariant failure (${inv.join("; ")})` : "the validator rejected the card twice"} in ${caseDef.id}, one of the first ${EARLY_CASES} cases`, after_cases: n }; break; }
      if (inv.some((x) => /per-question cap/.test(x))) { stopped = { reason: `hard abort: ${inv.join("; ")}`, after_cases: n }; break; }
      if (n >= SMOKE_AFTER_CASES && n < cases.length) {
        const mean = answered > 0 ? spent / answered : Infinity;
        if (mean > SMOKE_MEAN_USD) { stopped = { reason: `smoke stop: the mean cost per answered question is ${money6(mean)}, above ${money(SMOKE_MEAN_USD)}, after ${n} cases`, after_cases: n }; break; }
      }
    }
  } finally { globalThis.fetch = saved; db.close(); }
  const score = await scoreRecords(runs, knowledge);
  const recs = records.map(({ r, caseDef, spec, inv }) => caseRecord(r, { spec, caseDef }, score.per_case ? score.per_case.find((x) => x.id === caseDef.id) : null, { invariant_failures: inv }));
  const total = recs.reduce((a, c) => a + c.cost_usd, 0);
  const res = {
    run_id: runId, mode: "live", scripted: false, label: "LIVE MODEL", set_id: setId, set_sha256: setSha, started_at: startedAt, finished_at: new Date().toISOString(),
    n_cases_planned: cases.length, n_cases_run: recs.length, stopped, caps: { per_question_usd: caps.perQuestion, per_run_usd: caps.perRun, monthly_usd: caps.monthly, total_usd: caps.total }, effective_caps: { per_question_usd: effective.perQuestion, per_run_usd: effective.perRun, monthly_usd: effective.monthly, total_usd: effective.total }, journal_lines_written: journal.index, price_margin: margin, provider_limit_usd: providerLimit, estimate_only: !!estimateOnly,
    network_attempts: counters.blocked, anthropic_calls: counters.allowed, prices: { verified_by_user_on: null },
    cases: recs, totals: { cost_usd: total, reserved_usd: recs.reduce((a, c) => a + c.reserved_usd, 0), mean_cost_usd: recs.length ? total / recs.length : 0 },
    score: score.per_case ? { blocked: score.blocked, metrics: score.metrics, zero_tolerance: score.zero_tolerance, needs_human_review: score.needs_human_review } : score,
  };
  if (outDir) writeOutputs(outDir, res);
  return res;
}

// ── --ledger-summary ──────────────────────────────────────────────────────────────────────────────────
export function ledgerSummary(file, journals = []) {
  if (!fs.existsSync(file)) { say(`No ledger yet at ${file}. Nothing has been spent.`); return 0; }
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    say(`Ledger: ${file}`);
    let totals = [];
    try { totals = db.prepare("SELECT mode, period, reserved_usd, spent_usd FROM ai_budget_totals ORDER BY mode, period").all(); } catch (_) { say("The ledger has no tables yet. Nothing has been spent."); return 0; }
    say("");
    say("Spend so far by mode (maintained totals; live is real money, fake is the scripted lane):");
    say(`  ${pad("mode", 7)}${pad("period", 10)}${rpad("spent", 12)}${rpad("in flight", 12)}`);
    for (const t of totals) say(`  ${pad(t.mode, 7)}${pad(t.period, 10)}${rpad(money6(t.spent_usd), 12)}${rpad(money6(t.reserved_usd), 12)}`);
    const runs = db.prepare("SELECT run_id, mode, COUNT(*) AS calls, SUM(CASE WHEN cost_usd IS NULL THEN est_cost_usd ELSE cost_usd END) AS usd, MIN(created_at) AS first_at FROM ai_call_log WHERE mode IN ('live','fake') GROUP BY run_id, mode ORDER BY first_at").all();
    say("");
    say("By run:");
    say(`  ${pad("run", 24)}${pad("mode", 7)}${rpad("calls", 7)}${rpad("cost", 12)}  started (UTC)`);
    for (const x of runs) say(`  ${pad(x.run_id || "(none)", 24)}${pad(x.mode, 7)}${rpad(x.calls, 7)}${rpad(money6(x.usd), 12)}  ${new Date(x.first_at * 1000).toISOString().slice(0, 16).replace("T", " ")}`);
    const blocked = db.prepare("SELECT COUNT(*) AS n FROM ai_call_log WHERE mode = 'blocked'").get();
    say("");
    say(`Calls the gate blocked (never sent): ${blocked.n}`);
    journals.forEach((journal, i) => { try { const jr = readJournal(journal); say(`${i === 0 ? "Spend journal" : "Second journal copy"}: ${jr.count} live call(s), ${money6(jr.total)} (it must equal the ledger).`); } catch (e) { say(`Spend journal: ${e.message}`); } });
  } finally { db.close(); }
  return 0;
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────────────
export async function main(argv, env = process.env, io = { stdin: process.stdin, stdout: process.stdout }) {
  let args;
  try { args = parseArgs(argv); } catch (e) { warn(`usage error: ${e.message}`); return 64; }
  const flags = args.flags;
  if (typeof env.ANTHROPIC_API_KEY_DESK === "string" && env.ANTHROPIC_API_KEY_DESK.trim()) REDACT = [env.ANTHROPIC_API_KEY_DESK.trim()];
  let home = evalHome(env);
  let journalFiles = [journalPath(home)];
  try {
    if (flags["--ledger-summary"]) { const L = liveHome(env); return ledgerSummary(path.resolve(flags["--ledger"] || defaultLedger(L.home)), [journalPath(L.home), path.join(L.second, "spend_journal.jsonl")]); }
    const mode = flags["--mode"];
    if (!["plan", "dry", "live"].includes(mode)) throw new Usage("--mode plan|dry|live is required");
    const runId = flags["--run-id"];
    if (!runId || !RUN_ID_RE.test(runId)) throw new Usage("--run-id is required (letters, digits, . _ -; up to 40 characters)");
    guardHeldOut(args);                                           // gate 9, before any file is read
    // Live spending has exactly one ledger: <home>/ledger.sqlite. A different --ledger would start the running totals and the run-id checks from zero.
    let ledgerFile = path.resolve(flags["--ledger"] || defaultLedger(home));
    if (mode === "live") {
      const L = liveHome(env);                                    // the real home; HOME and UPS_AI_EVAL_HOME play no part (see liveHome)
      home = L.home;
      journalFiles = [journalPath(home), path.join(L.second, "spend_journal.jsonl")];
      const real = defaultLedger(home);
      if (flags["--ledger"] && path.resolve(flags["--ledger"]) !== path.resolve(real)) throw new Refusal(12, `--ledger is not allowed in live mode: live spending always uses ${real}, so earlier spending cannot be hidden by a new ledger file.`);
      for (const p of [home, real, ...journalFiles, L.second]) if (isSymlink(p)) throw new Refusal(12, `${p} is a symbolic link; live mode refuses it.`);
      ledgerFile = real;
    }
    args._libs = { bank: await import("./lib/bank.mjs") };
    const { cases, setSha } = loadCases(args);
    args._setSha = setSha;
    const setId = args._setId;
    const outDir = path.resolve(flags["--out"] || defaultOut(home, runId));
    const planFile = path.join(outDir, "plan.json");

    if (mode === "plan") {
      const plan = await buildPlan({ cases, runId, setSha, setId });
      mkdirp(outDir);
      fs.writeFileSync(planFile, JSON.stringify(plan, null, 2) + "\n", { mode: 0o600 });
      printPlan(plan);
      say(`\nPlan saved: ${planFile}`);
      return 0;
    }

    if (mode === "dry") {
      const res = await runDry({ cases, runId, setSha, setId, ledgerFile, env, outDir });
      say(`Run ${runId}: DRY (SCRIPTED model: this proves tools, facts and validation, not model quality)`);
      for (const c of res.cases) say(`  ${pad(c.id, 12)}${pad(c.state, 18)}oracle ${pad(c.oracle_check.pass === true ? "pass" : c.oracle_check.pass === false ? "MISMATCH" : "n/a", 9)}score ${pad(c.score ? (c.score.pass ? "pass" : "fail") : "n/a", 5)}${money6(c.cost_usd)}${c.known_issue ? "  KNOWN ISSUE" : ""}`);
      say(`Total ${money6(res.totals.cost_usd)} in the fake ledger lane; network attempts ${res.network_attempts}.`);
      for (const p of res.problems) say(`PROBLEM: ${p}`);
      say(res.passed ? "DRY RUN PASSED" : "DRY RUN FAILED");
      say(`Results: ${path.join(outDir, "results.json")}  Summary: ${path.join(outDir, "summary.md")}`);
      return res.passed ? 0 : 1;
    }

    // live
    earlyLiveGates({ env });                                      // gates 1 to 3 (caps above zero) before any work
    if (!fs.existsSync(planFile)) throw new Refusal(4, `no plan found for run ${runId}. Run --mode plan with the same --run-id, --set and --out first.`);
    // Live NEVER reads a cost from plan.json: the plan is recomputed from the set here (the code plan mode uses) and the file must match it.
    const plan = await buildPlan({ cases, runId, setSha, setId });
    verifyPlanFile({ file: planFile, fresh: plan, runId, setSha, nCases: cases.length });
    const g = liveGates({ args, env, runId, plan, ledgerFile, journalFiles, home, outDir, cases });
    if (g.estimateOnly) say("WARNING: --no-provider-limit-estimate-only. There is NO provider-side spend limit behind this run. The local gate caps ESTIMATED charges from an UNVERIFIED price table (with a 1.25 safety margin); it is not a hard limit on your account.");
    else say(`Provider-side spend limit confirmed by you: ${money(g.providerLimit)} (this is the authoritative ceiling; the local gate is a second line).`);
    say(`Run ${runId}: all pre-flight checks passed. Worst case on the expected path ${money(plan.totals.worst_expected_path_usd)}; expected ${money(plan.totals.typical_usd)}; most it can spend is ${money(g.maxUsd)}: the approval is a hard cap (effective per-run cap ${money(g.effective.perRun)}).`);
    // 7: a dry run of the same set, inside this run id, before any client exists
    const dry = await runDry({ cases, runId, setSha, setId, ledgerFile, env: { ...DRY_DEFAULT_CAPS }, outDir: path.join(outDir, "dry"), label: "dry-before-live" });
    if (!dry.passed) { for (const p of dry.problems) warn(`dry run problem: ${p}`); throw new Refusal(7, "the dry run of this set did not pass, so nothing was sent."); }
    say("Gate 7: the dry run of this set passed.");
    // 8: confirmation
    await liveConfirmation({ runId, maxUsd: g.maxUsd, input: io.stdin, output: io.stdout, plan, estimateOnly: g.estimateOnly });
    const res = await runLive({ cases, runId, setSha, setId, ledgerFile, journalFiles, env, outDir, key: g.key, caps: g.caps, effective: g.effective, providerLimit: g.providerLimit, estimateOnly: g.estimateOnly });
    res.prices = { verified_by_user_on: flags["--prices-confirmed"] };
    writeOutputs(outDir, res);
    say(`Run ${runId}: LIVE, ${res.n_cases_run} of ${res.n_cases_planned} cases, cost ${money6(res.totals.cost_usd)}, mean ${money6(res.totals.mean_cost_usd)}.`);
    for (const c of res.cases) say(`  ${pad(c.id, 12)}${pad(c.state, 18)}oracle ${pad(c.oracle_check.pass === true ? "pass" : c.oracle_check.pass === false ? "MISMATCH" : "n/a", 9)}score ${pad(c.score ? (c.score.pass ? "pass" : "fail") : "n/a", 5)}${money6(c.cost_usd)}`);
    if (res.stopped) { say(`STOPPED: ${res.stopped.reason}`); say(`Results: ${path.join(outDir, "results.json")}`); return 3; }
    say(`Results: ${path.join(outDir, "results.json")}  Summary: ${path.join(outDir, "summary.md")}`);
    return 0;
  } catch (e) {
    if (e instanceof Refusal) { warn(`REFUSED (gate ${e.gate}): ${e.message}`); warn("Nothing was sent. No client was created."); return 2; }
    if (e instanceof Usage) { warn(`usage error: ${e.message}`); return 64; }
    warn(`run failed: ${e && e.message ? e.message : e}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
}
