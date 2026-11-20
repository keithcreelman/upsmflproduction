// Commissioner Desk: the paid test runner (scripts/ai_eval/run_eval.mjs), proven with NO paid call and NO network.
//   node tests/ai_desk_paid_runner.test.mjs
//
// Every run is a child process: process.execPath, a scrubbed environment (no PATH, no real key, HOME is a temp dir), and a preload that REPLACES
// globalThis.fetch. The preload serves a scripted reply to POST https://api.anthropic.com/v1/messages only when a test turns FAKE_ANTHROPIC on,
// logs everything it sees, and throws for any other request. Keys in these tests are canary strings; none is real.
// Proven: every live gate refuses on its own with exit 2 and ZERO network attempts; plan constructs no client; dry runs all ten cases in the
// ledger's fake lane with no live row; the budget caps block in dry; held-out paths and ids are refused; --ledger-summary works; no key appears
// in any output or file; live mode with every gate satisfied (and the interceptor) sends only to api.anthropic.com/v1/messages with the desk key,
// reserves in the ledger before each call, never sends the shared key, and stops on the smoke rule or after a model error.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ups-desk-runner-"));
const SET_REL = "scripts/ai_eval/sets/first10.json";
const BANK = path.join(ROOT, "tests/fixtures/ai_desk/eval_bank_dev.jsonl");
const DESK_KEY = "TEST-CANARY-KEY-NOT-REAL";             // the one literal key that lets a test redirect the live home; never a real key
const SHARED_KEY = "sk-ant-shared-CANARY-1111111111111111";
const p2 = (n) => String(n).padStart(2, "0");
const LOCAL_TODAY = (() => { const d = new Date(); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; })();
const UTC_TODAY = new Date().toISOString().slice(0, 10);
const TODAY = LOCAL_TODAY;
const shiftDay = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const ANTHROPIC = "https://api.anthropic.com/v1/messages";
let seq = 0;
const uniq = (name) => path.join(TMP, `${name}-${++seq}`);

// In-process live runs need the fake Anthropic fetch to be in place BEFORE the runner module is imported (it captures fetch at load).
let currentFake = null;
globalThis.fetch = async (input, init) => { if (currentFake) return currentFake(input, init); throw new Error("offline test: no network"); };
const mod = await import("../scripts/ai_eval/run_eval.mjs");

// ── the interceptor preload ───────────────────────────────────────────────────────────────────────
const PRELOAD = path.join(TMP, "intercept.mjs");
fs.writeFileSync(PRELOAD, `
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
const LOG = process.env.FAKE_LOG;
const log = (o) => { if (LOG) fs.appendFileSync(LOG, JSON.stringify(o) + "\\n"); };
const ANTHROPIC = ${JSON.stringify(ANTHROPIC)};
let n = 0, scripted = null, bank = null;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input && input.url ? input.url : String(input);
  const method = String((init && init.method) || "GET").toUpperCase();
  if (process.env.FAKE_ANTHROPIC !== "1" || method !== "POST" || url !== ANTHROPIC) { log({ kind: "blocked", method, url }); throw new Error("offline: network is blocked"); }
  n += 1;
  if (!scripted) { scripted = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, "scripts/ai_eval/lib/scripted_model.mjs")).href)}); bank = fs.readFileSync(${JSON.stringify(BANK)}, "utf8").split("\\n").filter(Boolean).map(JSON.parse); }
  const headers = Object.fromEntries(Object.entries((init && init.headers) || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const body = JSON.parse(init.body);
  let pending = null;
  if (process.env.LEDGER && fs.existsSync(process.env.LEDGER)) { const db = new DatabaseSync(process.env.LEDGER, { readOnly: true }); pending = db.prepare("SELECT COUNT(*) AS n FROM ai_call_log WHERE mode = 'live' AND cost_usd IS NULL").get().n; db.close(); }
  log({ kind: "anthropic", n, method, url, x_api_key: headers["x-api-key"], version: headers["anthropic-version"], model: body.model, pending_live_rows: pending, has_shared: init.body.includes(process.env.SHARED_KEY || "\\u0000"), has_desk: init.body.includes(process.env.ANTHROPIC_API_KEY_DESK || "\\u0000") });
  if (Number(process.env.FAKE_FAIL_AT) === n) return new Response(JSON.stringify({ error: { type: "api_error", message: "boom" } }), { status: 500, headers: { "content-type": "application/json" } });
  const text = JSON.stringify(body.messages);
  const c = bank.find((x) => text.includes(JSON.stringify(x.question).slice(1, -1)));
  const r = scripted.scriptedResponse(c.id, body);
  const k = Number(process.env.FAKE_USAGE_SCALE || 1);
  const usage = { input_tokens: Math.round(r.usage.input_tokens * k), output_tokens: Math.round(r.usage.output_tokens * k) };
  if (process.env.FAKE_BAD_CARD === "1" && r.content[0] && r.content[0].name === "emit_card") r.content[0].input.lead_md += " It holds 9 players.";
  return new Response(JSON.stringify({ id: "msg_" + n, type: "message", role: "assistant", model: body.model, stop_reason: r.stop_reason, content: r.content, usage }), { status: 200, headers: { "content-type": "application/json" } });
};
`);

// ── spawning the runner ───────────────────────────────────────────────────────────────────────────
function runner(args, { env = {}, fakeAnthropic = false, ledger = null } = {}) {
  const log = uniq("net") + ".log";
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", PRELOAD, "scripts/ai_eval/run_eval.mjs", ...args], {
      cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
      env: Object.fromEntries(Object.entries({ NODE_NO_WARNINGS: "1", HOME: TMP, TMPDIR: os.tmpdir(), FAKE_LOG: log, SHARED_KEY, ...(fakeAnthropic ? { FAKE_ANTHROPIC: "1" } : {}), ...(ledger ? { LEDGER: ledger } : {}),
        ...(ledger && path.basename(ledger) === "ledger.sqlite" ? { UPS_AI_EVAL_HOME: path.dirname(ledger), UPS_AI_EVAL_UNDER_TEST: "1", ANTHROPIC_API_KEY_DESK: DESK_KEY } : {}), ...env }).filter(([, v]) => v !== undefined)),
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => {
      const entries = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
      resolve({ code, out, err, net: entries, blocked: entries.filter((e) => e.kind === "blocked"), anthropic: entries.filter((e) => e.kind === "anthropic") });
    });
  });
}
async function pool(tasks, size = 4) { const out = []; let i = 0; await Promise.all(Array.from({ length: size }, async () => { while (i < tasks.length) { const k = i++; out[k] = await tasks[k](); } })); return out; }
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const allText = (dir) => { let s = ""; for (const f of fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }) : []) { const p = path.join(dir, String(f)); if (fs.statSync(p).isFile()) s += fs.readFileSync(p, "utf8"); } return s; };
const clean = (r) => { t.ok(!(r.out + r.err).includes(DESK_KEY) && !(r.out + r.err).includes(SHARED_KEY), "no key in stdout or stderr"); };

// ── the baseline: a plan on file, and a fully satisfied live command line ─────────────────────────────
const BASE_OUT = uniq("plan");
const PLAN = {};
async function ensurePlan() {
  if (PLAN.plan) return PLAN.plan;
  const r = await runner(["--set", SET_REL, "--mode", "plan", "--run-id", "R1", "--out", BASE_OUT]);
  PLAN.r = r; PLAN.plan = readJson(path.join(BASE_OUT, "plan.json"));
  return PLAN.plan;
}
function liveEnv(over = {}) {
  return { DESK_LIVE_MODEL_ENABLED: "1", ANTHROPIC_API_KEY_DESK: DESK_KEY, ANTHROPIC_API_KEY: SHARED_KEY, DESK_BUDGET_PER_QUESTION_USD: "1", DESK_BUDGET_PER_RUN_USD: "1.5", DESK_BUDGET_MONTHLY_USD: "5", DESK_BUDGET_TOTAL_USD: "5", ...over };
}
// A command line that satisfies every gate; a test changes exactly one thing. `out` gets a copy of the plan.
function liveCmd(o = {}) {
  const home = o.ledger ? path.dirname(o.ledger) : uniq("home");
  const out = o.out || (o.outUnderHome ? path.join(home, "runs", o.runId || "R1") : uniq("live-out"));
  if (!o.noPlanCopy) { fs.mkdirSync(out, { recursive: true }); fs.copyFileSync(path.join(BASE_OUT, "plan.json"), path.join(out, "plan.json")); }
  const maxUsd = o.maxUsd || "2.00";
  fs.mkdirSync(home, { recursive: true });
  const args = ["--set", o.set || SET_REL, "--mode", "live", "--run-id", o.runId || "R1", "--out", out, "--max-usd", maxUsd];
  if (o.liveLedgerFlag) args.push("--ledger", o.liveLedgerFlag);
  if (!o.noApprove) args.push("--approve", o.approve || `R1:${maxUsd}:10`);
  if (!o.noPrices) args.push("--prices-confirmed", o.prices || TODAY);
  if (!o.noProvider) { if (o.estimateOnly) args.push("--no-provider-limit-estimate-only"); else args.push("--provider-limit-confirmed", o.providerLimit || "3.00"); }
  if (o.bothProvider) args.push("--no-provider-limit-estimate-only");
  if (!o.noFirst) args.push("--first-live-run");
  if (o.acceptKnown) args.push("--accept-known-issues");
  if (o.tamper) { const pf = path.join(out, "plan.json"); const p = readJson(pf); o.tamper(p); fs.writeFileSync(pf, JSON.stringify(p)); }
  return { args, out, home, ledger: path.join(home, "ledger.sqlite"), journal: path.join(home, "spend_journal.jsonl") };
}
const liveCapsEnv = (plan) => liveEnv({ DESK_BUDGET_PER_QUESTION_USD: String(Math.max(1, plan.recommended_caps.per_question_usd)), DESK_BUDGET_PER_RUN_USD: "1.5" });

// ── plan ──────────────────────────────────────────────────────────────────────────────────────────
test("plan: prints the cases, models, max_tokens and the cost table; constructs no Anthropic client; zero network; no ledger is created", async () => {
  const plan = await ensurePlan();
  const r = PLAN.r;
  t.equal(r.code, 0, r.err.slice(0, 300)); clean(r);
  for (const id of ["DEV-RUL-02", "DEV-RUL-10", "DEV-REC-02", "DEV-REC-01", "DEV-NOW-01", "DEV-INJ-05", "DEV-TFL-01", "DEV-LIN-03", "DEV-CON-02", "DEV-UNA-08"]) t.ok(r.out.includes(id), id);
  t.match(r.out, /router\s+claude-haiku-5-5\s+300/); t.match(r.out, /loop\s+claude-sonnet-5-5\s+1500/); t.match(r.out, /composer\s+claude-sonnet-5-5\s+2500/);
  t.match(r.out, /case\s+calls\s+typical\s+worst, path\s+largest call\s+protocol bound/);
  t.match(r.out, /TOTAL\s+40\s+\$\d+\.\d{4}/);
  t.match(r.out, /DESK_BUDGET_PER_QUESTION_USD at least \$/); t.match(r.out, /DESK_BUDGET_PER_RUN_USD\s+at least \$/);
  t.match(r.out, /Anthropic clients constructed: 0/);
  t.doesNotMatch(r.out, /KNOWN ISSUE/, "the set has no known issue any more");
  t.deepEqual(r.net, [], "no network attempt of any kind");
  t.equal(plan.n_cases, 10); t.equal(plan.clients_constructed, 0); t.equal(plan.prices.verified, false);
  t.ok(plan.totals.typical_usd > 0.1 && plan.totals.typical_usd < 1, "typical cost is a few dimes");
  t.ok(plan.totals.worst_expected_path_usd > plan.totals.typical_usd, "worst case is above typical");
  t.ok(plan.required_caps.per_question_min_usd >= plan.totals.largest_single_reserve_usd, "the per-question need covers the largest single call");
  t.ok(plan.required_caps.per_run_min_usd >= plan.totals.typical_usd, "the per-run need covers the expected cost");
  t.equal(plan.cases.length, 10); t.ok(plan.cases.every((c) => c.steps.length === 4 && c.steps.every((s) => s.reserve_usd > 0 && s.max_tokens > 0)));
  // plan never writes the shared ledger
  const led = uniq("ledger-plan") + ".sqlite";
  const r2 = await runner(["--set", SET_REL, "--mode", "plan", "--run-id", "R2", "--out", uniq("plan2"), "--ledger", led]);
  t.equal(r2.code, 0); t.ok(!fs.existsSync(led), "plan does not create or write a ledger");
});

// ── every live gate refuses on its own ─────────────────────────────────────────────────────────────
const GATES = [
  ["gate 1: the live switch is off", () => ({ env: { DESK_LIVE_MODEL_ENABLED: "0" } }), 1, /DESK_LIVE_MODEL_ENABLED/],
  ["gate 1: the live switch is unset", () => ({ env: { DESK_LIVE_MODEL_ENABLED: undefined } }), 1, /DESK_LIVE_MODEL_ENABLED/],
  ["gate 2: no desk key, even with the shared key present", () => ({ env: { ANTHROPIC_API_KEY_DESK: undefined } }), 2, /ANTHROPIC_API_KEY_DESK/],
  ["gate 2: a blank desk key", () => ({ env: { ANTHROPIC_API_KEY_DESK: "   " } }), 2, /ANTHROPIC_API_KEY_DESK/],
  ["gate 3: a cap is zero", () => ({ env: { DESK_BUDGET_TOTAL_USD: "0" } }), 3, /DESK_BUDGET_TOTAL_USD/],
  ["gate 3: a cap is missing", () => ({ env: { DESK_BUDGET_MONTHLY_USD: undefined } }), 3, /DESK_BUDGET_MONTHLY_USD/],
  ["gate 3: a cap is not a number", () => ({ env: { DESK_BUDGET_PER_RUN_USD: "lots" } }), 3, /DESK_BUDGET_PER_RUN_USD/],
  ["gate 3: the per-question cap is below the plan's need (the largest single call)", () => ({ env: { DESK_BUDGET_PER_QUESTION_USD: "0.05" } }), 3, /PER_QUESTION_USD 0\.05 is below/],
  ["gate 3: the per-run cap is below the plan's expected cost", () => ({ env: { DESK_BUDGET_PER_RUN_USD: "0.3" } }), 3, /PER_RUN_USD 0\.3 is below/],
  ["gate 3: the monthly cap is below the per-run cap", () => ({ env: { DESK_BUDGET_MONTHLY_USD: "1" } }), 3, /MONTHLY_USD is below the per-run cap/],
  ["gate 4: no plan was produced for this run id", () => ({ cmd: { noPlanCopy: true } }), 4, /no plan found/],
  ["gate 4: the plan is for a different run id", () => ({ cmd: { runId: "R9", approve: "R9:2.00:10" } }), 4, /different run id/],
  ["gate 4: the plan is for a different set", () => ({ cmd: { set: "COPY_WITH_EDIT" } }), 4, /different set or bank/],
  ["gate 4: the expected cost is above --max-usd", () => ({ cmd: { maxUsd: "0.10", approve: "R1:0.10:10" } }), 4, /expected cost .* above --max-usd/],
  ["gate 3: --max-usd is below what the plan needs (the approval is the hard per-run cap)", () => ({ cmd: { maxUsd: "0.40", approve: "R1:0.40:10" } }), 3, /--max-usd \$0\.4000 is below the/],
  ["gate 4: a doctored plan file (low protocol bound and expected cost) does not match the recomputation", () => ({ cmd: { tamper: (p) => { p.totals.protocol_bound_usd = 0.01; p.totals.typical_usd = 0.01; } } }), 4, /do not match a fresh recomputation/],
  ["gate 4: a doctored plan file (lowered required caps) does not match the recomputation", () => ({ cmd: { tamper: (p) => { p.required_caps.per_run_min_usd = 0.01; p.required_caps.per_question_min_usd = 0.01; } } }), 4, /do not match a fresh recomputation/],
  ["gate 4: a doctored plan file (one case's reservations) does not match the recomputation", () => ({ cmd: { tamper: (p) => { p.cases[0].steps[1].reserve_usd = 0.0001; } } }), 4, /do not match a fresh recomputation/],
  ["gate 6: yesterday is refused", () => ({ cmd: { prices: shiftDay(UTC_TODAY < LOCAL_TODAY ? UTC_TODAY : LOCAL_TODAY, -1) } }), 6, /is not today\. Expected /],
  ["gate 6: tomorrow is refused", () => ({ cmd: { prices: shiftDay(UTC_TODAY > LOCAL_TODAY ? UTC_TODAY : LOCAL_TODAY, 1) } }), 6, /is not today\. Expected /],
  ["gate 12: --ledger names another file in live mode", () => ({ cmd: { liveLedgerFlag: path.join(TMP, "elsewhere.sqlite") } }), 12, /--ledger is not allowed in live mode/],
  ["gate 5: no approval string", () => ({ cmd: { noApprove: true } }), 5, /--approve/],
  ["gate 5: the approval names another run", () => ({ cmd: { approve: "R2:2.00:10" } }), 5, /different run id/],
  ["gate 5: the approval has the wrong case count", () => ({ cmd: { approve: "R1:2.00:9" } }), 5, /says 9 cases/],
  ["gate 5: --max-usd differs from the approved amount", () => ({ cmd: { approve: "R1:1.90:10" } }), 5, /--max-usd is missing or does not equal/],
  ["gate 5: a malformed approval", () => ({ cmd: { approve: "yes please" } }), 5, /--approve/],
  ["gate 6: prices were not confirmed", () => ({ cmd: { noPrices: true } }), 6, /--prices-confirmed/],
  ["gate 6: the price confirmation is from another day", () => ({ cmd: { prices: "2020-01-01" } }), 6, /not today/],
  ["gate 6: the refusal says which date it expected", () => ({ cmd: { prices: "2020-01-01" } }), 6, new RegExp(`Expected ${LOCAL_TODAY}`)],
  ["gate 8: every other gate satisfied, but this process has no terminal (an automation)", () => ({}), 8, /real terminal/],
  ["gate 13: no provider-side limit and no estimate-only flag", () => ({ cmd: { noProvider: true } }), 13, /provider-side spend limit is required/],
  ["gate 13: both the provider limit and the estimate-only flag", () => ({ cmd: { bothProvider: true } }), 13, /not both/],
  ["gate 13: the provider limit is below --max-usd", () => ({ cmd: { providerLimit: "1.50" } }), 13, /is below --max-usd/],
  ["gate 13: the provider limit is more than 2 times --max-usd", () => ({ cmd: { providerLimit: "4.50" } }), 13, /more than 2 times --max-usd/],
  ["gate 13: the provider limit is exactly 3 times --max-usd (no longer allowed)", () => ({ cmd: { providerLimit: "6.00" } }), 13, /more than 2 times --max-usd/],
  ["gate 13: the provider limit is not a number", () => ({ cmd: { providerLimit: "lots" } }), 13, /dollar amount above zero/],
  ["gate 13: estimate-only with an approval above $1.00", () => ({ cmd: { estimateOnly: true, maxUsd: "1.50", approve: "R1:1.50:10" } }), 13, /may not exceed \$1\.0000/],
  ["gate 13: estimate-only with the old $2.00 ceiling", () => ({ cmd: { estimateOnly: true, maxUsd: "2.00", approve: "R1:2.00:10" } }), 13, /may not exceed \$1\.0000/],
  ["gate 12: the very first live run without --first-live-run", () => ({ cmd: { noFirst: true } }), 12, /pass --first-live-run/],
];

test("every live gate refuses on its own: exit 2, the gate named, ZERO network attempts, no client, no results, no live ledger row", async () => {
  const plan = await ensurePlan();
  const setCopy = path.join(TMP, "set_copy.json");
  const s = readJson(path.join(ROOT, SET_REL)); s.purpose += " (edited)"; fs.writeFileSync(setCopy, JSON.stringify(s));
  const jobs = GATES.map(([name, mk, gate, re]) => async () => {
    const m = mk();
    const cmd = liveCmd({ ...(m.cmd || {}), set: m.cmd && m.cmd.set === "COPY_WITH_EDIT" ? setCopy : undefined });
    const env = { ...liveCapsEnv(plan), ...(m.env || {}) };
    const r = await runner(cmd.args, { env, fakeAnthropic: true, ledger: cmd.ledger });
    return { name, gate, re, r, cmd };
  });
  for (const { name, gate, re, r, cmd } of await pool(jobs, 5)) {
    t.equal(r.code, 2, `${name}: exit code (${r.err.slice(0, 200)})`);
    t.match(r.err, new RegExp(`REFUSED \\(gate ${gate}\\)`), name);
    t.match(r.err, re, name);
    t.match(r.err, /Nothing was sent\. No client was created\./, name);
    t.deepEqual(r.net, [], `${name}: ZERO network attempts (not even a blocked one)`);
    t.ok(!fs.existsSync(path.join(cmd.out, "results.json")), `${name}: no results file`);
    if (fs.existsSync(cmd.ledger)) { const db = new DatabaseSync(cmd.ledger, { readOnly: true }); t.equal(db.prepare("SELECT COUNT(*) n FROM ai_call_log WHERE mode = 'live'").get().n, 0, `${name}: no live ledger row`); db.close(); }
    clean(r);
  }
});

test("known issues: a set that marks a case as a known issue is refused live unless --accept-known-issues is passed on purpose", async () => {
  const s = readJson(path.join(ROOT, SET_REL));
  s.cases.find((c) => c.id === "DEV-REC-01").known_issue = "an example defect";
  const f = path.join(TMP, "set_known_issue.json"); fs.writeFileSync(f, JSON.stringify(s));
  const out = uniq("ki");
  const p = await runner(["--set", f, "--mode", "plan", "--run-id", "R1", "--out", out]);
  t.equal(p.code, 0); t.match(p.out, /KNOWN ISSUE DEV-REC-01: an example defect/);
  const plan = await ensurePlan();
  const refused = liveCmd({ set: f, out, noPlanCopy: true });
  const r = await runner(refused.args, { env: liveCapsEnv(plan), fakeAnthropic: true, ledger: refused.ledger });
  t.equal(r.code, 2); t.match(r.err, /REFUSED \(gate 12\)/); t.match(r.err, /known issues \(DEV-REC-01\)/); t.deepEqual(r.net, []);
  const ok = liveCmd({ set: f, out, noPlanCopy: true, acceptKnown: true });
  const r2 = await runner(ok.args, { env: liveCapsEnv(plan), fakeAnthropic: true, ledger: ok.ledger });
  t.equal(r2.code, 2); t.match(r2.err, /REFUSED \(gate 8\)/, "with the flag the known-issue gate passes; the run then stops at the terminal gate (no TTY here)"); t.equal(r2.net.length, 0);
});

test("gate 7: a live run needs a dry run of the SAME set to pass first; a set whose dry run fails is refused before any client exists", async () => {
  const s = readJson(path.join(ROOT, SET_REL));
  s.cases.find((c) => c.id === "DEV-NOW-01").oracle = "cap_room_0001";              // the scripted answer is for 0003, so the fixture oracle disagrees
  const bad = path.join(TMP, "set_bad_oracle.json"); fs.writeFileSync(bad, JSON.stringify(s));
  const out = uniq("g7");
  const p = await runner(["--set", bad, "--mode", "plan", "--run-id", "R1", "--out", out]);
  t.equal(p.code, 0, p.err.slice(0, 200));
  const cmd = liveCmd({ set: bad, out, noPlanCopy: true });
  const r = await runner(cmd.args, { env: liveCapsEnv(await ensurePlan()), fakeAnthropic: true, ledger: cmd.ledger });
  t.equal(r.code, 2, r.err.slice(0, 300));
  t.match(r.err, /REFUSED \(gate 7\)/); t.match(r.err, /dry run problem: DEV-NOW-01: oracle mismatch/);
  t.deepEqual(r.net, [], "no network attempt");
  t.ok(!fs.existsSync(path.join(out, "results.json")) || readJson(path.join(out, "results.json")).mode !== "live");
  clean(r);
});

test("gate 9: a held-out or sealed bank path, or an HO- id, is refused in EVERY mode before any file is read", async () => {
  const cases = [
    ["--set", "/Volumes/locked/heldout/set.json"], ["--set", "/x/SEALED/set.json"], ["--bank", "/x/held-out/bank.jsonl", "--ids", "DEV-RUL-02"], ["--bank", "/x/held_out/bank.jsonl", "--ids", "DEV-RUL-02"],
    ["--bank", "/x/ho/bank.jsonl", "--ids", "DEV-RUL-02"], ["--bank", BANK, "--ids", "HO-001"], ["--bank", BANK, "--ids", "DEV-RUL-02,ho-17"],
  ];
  const jobs = [];
  for (const mode of ["plan", "dry", "live"]) for (const c of cases) jobs.push(async () => ({ mode, c, r: await runner([...c, "--mode", mode, "--run-id", "H1", "--out", uniq("g9"), "--ledger", uniq("l9") + ".sqlite"], { env: liveEnv(), fakeAnthropic: true }) }));
  for (const { mode, c, r } of await pool(jobs, 6)) {
    t.equal(r.code, 2, `${mode} ${c.join(" ")}: ${r.err.slice(0, 160)}`);
    t.match(r.err, /REFUSED \(gate 9\)/);
    t.deepEqual(r.net, []); clean(r);
  }
});

// ── dry ───────────────────────────────────────────────────────────────────────────────────────────
test("dry: all ten cases through the same pipeline, gate and ledger; every ledger row is the fake lane; outputs go to the temp dir; zero network", async () => {
  const out = uniq("dry-out"), led = uniq("dry-ledger") + ".sqlite";
  const r = await runner(["--set", SET_REL, "--mode", "dry", "--run-id", "D1", "--out", out, "--ledger", led], { env: { ANTHROPIC_API_KEY_DESK: DESK_KEY, ANTHROPIC_API_KEY: SHARED_KEY } });
  t.equal(r.code, 0, r.out.slice(-600) + r.err.slice(0, 300));
  t.match(r.out, /DRY RUN PASSED/); t.match(r.out, /SCRIPTED model: this proves tools, facts and validation, not model quality/);
  t.deepEqual(r.net, [], "no network attempt"); clean(r);
  const res = readJson(path.join(out, "results.json"));
  t.equal(res.mode, "dry"); t.equal(res.scripted, true); t.match(res.label, /not model quality/);
  t.equal(res.n_cases_run, 10); t.equal(res.network_attempts, 0); t.equal(res.passed, true); t.deepEqual(res.problems, []);
  for (const c of res.cases) {
    t.ok(c.question && c.state && c.final_card && Array.isArray(c.tool_calls) && Array.isArray(c.facts) && Array.isArray(c.validator) && c.oracle_check && c.score && Number.isFinite(c.cost_usd) && Number.isFinite(c.latency_ms), `${c.id}: every result field is present`);
    t.equal(c.ledger.length, 4, `${c.id}: four ledger rows`); t.ok(c.ledger.every((x) => x.mode === "fake" && x.cost_usd > 0 && x.cost_usd < x.est_cost_usd), `${c.id}: fake rows, charged below the reservation`);
  }
  t.ok(res.cases.every((c) => c.oracle_check.pass === true), "every fixture oracle passes");
  t.deepEqual(res.cases.filter((c) => !c.score.pass).map((c) => c.id), [], "no scorer failure on any case (glossary terms are passed to the scorer as allowed_terms)");
  t.equal(res.score.blocked, false, "the scorer's verdict is not blocked");
  t.ok(res.cases.every((c) => c.validator.every((v) => v.matches_pipeline === true)));
  t.ok(fs.existsSync(path.join(out, "summary.md")));
  t.match(fs.readFileSync(path.join(out, "summary.md"), "utf8"), /SCRIPTED MODEL/);
  const db = new DatabaseSync(led, { readOnly: true });
  t.equal(db.prepare("SELECT COUNT(*) n FROM ai_call_log WHERE mode = 'fake'").get().n, 40);
  t.equal(db.prepare("SELECT COUNT(*) n FROM ai_call_log WHERE step = 'loop' AND mode = 'fake' AND tools LIKE '%history.finishes%'").get().n, 20, "the ledger's tools column is filled for loop calls (meta.tools)");
  t.equal(db.prepare("SELECT COUNT(*) n FROM ai_call_log WHERE mode = 'live'").get().n, 0, "no live row");
  t.equal(db.prepare("SELECT COUNT(*) n FROM ai_call_log WHERE cost_usd IS NULL").get().n, 0, "every reservation was finalized");
  const sumRows = db.prepare("SELECT SUM(cost_usd) s FROM ai_call_log WHERE mode = 'fake'").get().s;
  const tot = db.prepare("SELECT spent_usd FROM ai_budget_totals WHERE mode = 'fake' AND period = 'total'").get().spent_usd;
  t.ok(Math.abs(sumRows - tot) < 1e-9 && Math.abs(sumRows - res.totals.cost_usd) < 1e-9, "the maintained total equals the rows equals the results");
  db.close();
  t.ok(!allText(out).includes(DESK_KEY) && !allText(out).includes(SHARED_KEY), "no key in any output file");
  // --ledger-summary reads the same file
  const s = await runner(["--ledger-summary", "--ledger", led]);
  t.equal(s.code, 0); t.match(s.out, /fake\s+total\s+\$0\.\d+/); t.match(s.out, /D1\s+fake\s+40/); t.match(s.out, /Calls the gate blocked \(never sent\): 0/); clean(s);
  t.ok(!/\slive\s+total/.test(s.out), "no live spending shown");
  const none = await runner(["--ledger-summary", "--ledger", uniq("nope") + ".sqlite"]);
  t.equal(none.code, 0); t.match(none.out, /No ledger yet/);
});

test("dry: the per-question cap blocks (budget_exceeded cards, blocked ledger rows, nothing spent) and the dry run FAILS", async () => {
  const out = uniq("dry-q"), led = uniq("dry-q-ledger") + ".sqlite";
  const r = await runner(["--set", SET_REL, "--mode", "dry", "--run-id", "Q1", "--out", out, "--ledger", led], { env: { DESK_BUDGET_PER_QUESTION_USD: "0.0001", DESK_BUDGET_PER_RUN_USD: "50", DESK_BUDGET_MONTHLY_USD: "50", DESK_BUDGET_TOTAL_USD: "500" } });
  t.equal(r.code, 1, r.out.slice(-300)); t.match(r.out, /DRY RUN FAILED/); t.match(r.out, /the budget gate blocked a call \(budget_per_question/);
  const res = readJson(path.join(out, "results.json"));
  t.equal(res.passed, false);
  t.ok(res.cases.every((c) => c.state === "budget_exceeded" && c.final_card.reason_code === "budget_per_question" && c.facts.length === 0 && c.cost_usd === 0), "every card is the code-built budget card with no facts and no cost");
  const db = new DatabaseSync(led, { readOnly: true });
  t.equal(db.prepare("SELECT COUNT(*) n FROM ai_call_log WHERE mode = 'blocked'").get().n, 10, "one blocked row per question");
  t.equal(db.prepare("SELECT COUNT(*) n FROM ai_call_log WHERE mode = 'fake'").get().n, 0, "nothing reserved or spent");
  db.close(); t.deepEqual(r.net, []);
});

test("dry: the total cap blocks too (a tiny total stops every call before it is reserved)", async () => {
  const out = uniq("dry-t"), led = uniq("dry-t-ledger") + ".sqlite";
  const r = await runner(["--set", SET_REL, "--mode", "dry", "--run-id", "T1", "--out", out, "--ledger", led], { env: { DESK_BUDGET_PER_QUESTION_USD: "5", DESK_BUDGET_PER_RUN_USD: "50", DESK_BUDGET_MONTHLY_USD: "50", DESK_BUDGET_TOTAL_USD: "0.03" } });
  t.equal(r.code, 1); t.match(r.out, /DRY RUN FAILED/);
  const res = readJson(path.join(out, "results.json"));
  t.ok(res.cases.some((c) => c.state === "budget_exceeded" && c.final_card.reason_code === "budget_total"), "a card names the total cap");
  const db = new DatabaseSync(led, { readOnly: true });
  const spent = db.prepare("SELECT COALESCE(SUM(cost_usd), 0) s FROM ai_call_log WHERE mode = 'fake'").get().s;
  t.ok(spent <= 0.03 + 1e-9, `fake spend ${spent} never exceeds the total cap`);
  t.ok(db.prepare("SELECT COUNT(*) n FROM ai_call_log WHERE mode = 'blocked' AND error_code = 'budget_total'").get().n > 0);
  db.close();
});

// ── live, in process (a live run needs a TTY, so these drive main() directly with fake terminal streams and an intercepted fetch) ─────────────────
function makeFake(opts = {}) {
  const log = { entries: [], usage: [] };
  let n = 0, scripted = null, bank = null;
  const fake = async (input, init) => {
    const url = typeof input === "string" ? input : input && input.url ? input.url : String(input);
    const method = String((init && init.method) || "GET").toUpperCase();
    if (method !== "POST" || url !== ANTHROPIC) { log.entries.push({ kind: "blocked", method, url }); throw new Error("offline: network is blocked"); }
    n += 1;
    if (!scripted) { scripted = await import("../scripts/ai_eval/lib/scripted_model.mjs"); bank = fs.readFileSync(BANK, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
    const headers = Object.fromEntries(Object.entries((init && init.headers) || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const body = JSON.parse(init.body);
    let pending = null;
    if (opts.ledger && fs.existsSync(opts.ledger)) { const db = new DatabaseSync(opts.ledger, { readOnly: true }); pending = db.prepare("SELECT COUNT(*) AS n FROM ai_call_log WHERE mode = 'live' AND cost_usd IS NULL").get().n; db.close(); }
    log.entries.push({ kind: "anthropic", n, method, url, x_api_key: headers["x-api-key"], version: headers["anthropic-version"], model: body.model, pending_live_rows: pending, has_shared: init.body.includes(SHARED_KEY), has_desk: init.body.includes(DESK_KEY) });
    if (opts.failAt === n) return new Response(JSON.stringify({ error: { type: "api_error", message: "boom" } }), { status: 500, headers: { "content-type": "application/json" } });
    const text = JSON.stringify(body.messages);
    const c = bank.find((x) => text.includes(JSON.stringify(x.question).slice(1, -1)));
    const r = scripted.scriptedResponse(c.id, body);
    const k = opts.usageScale || 1;
    const usage = { input_tokens: Math.round(r.usage.input_tokens * k), output_tokens: Math.round(r.usage.output_tokens * k) };
    log.usage.push({ model: body.model, usage });
    if (opts.badCard && r.content[0] && r.content[0].name === "emit_card") r.content[0].input.lead_md += " It holds 9 players.";
    return new Response(JSON.stringify({ id: `msg_${n}`, type: "message", role: "assistant", model: body.model, stop_reason: r.stop_reason, content: r.content, usage }), { status: 200, headers: { "content-type": "application/json" } });
  };
  fake.log = log;
  return fake;
}
const homeEnv = (home) => ({ UPS_AI_EVAL_UNDER_TEST: "1", UPS_AI_EVAL_HOME: home });
const phraseFor = (runId, maxUsd) => mod.confirmPhrase(runId, Number(maxUsd));
// One in-process live attempt. `typed` is what the person types at the prompt (default: the exact phrase); tty=false models an automation.
async function liveRun(cmd, { env, fake = null, typed, tty = true, runId = "R1" } = {}) {
  currentFake = fake;
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = tty; output.isTTY = tty; output.resume();
  const maxUsd = cmd.args[cmd.args.indexOf("--max-usd") + 1];
  input.write(`${typed === undefined ? phraseFor(runId, maxUsd) : typed}\n`);
  const outL = [], errL = [];
  const keep = { log: console.log, error: console.error };
  console.log = (...a) => outL.push(a.join(" ")); console.error = (...a) => errL.push(a.join(" "));
  let code;
  try { code = await mod.main(cmd.args, { ...env, ...homeEnv(cmd.home) }, { stdin: input, stdout: output }); }
  finally { console.log = keep.log; console.error = keep.error; currentFake = null; }
  const entries = fake ? fake.log.entries : [];
  return { code, out: outL.join("\n"), err: errL.join("\n"), net: entries, blocked: entries.filter((e) => e.kind === "blocked"), anthropic: entries.filter((e) => e.kind === "anthropic") };
}
const secondJournal = (cmd) => path.join(cmd.home, "second_copy", "spend_journal.jsonl");

test("LIVE with every gate satisfied (interceptor, fake terminal): ONLY POST api.anthropic.com/v1/messages, the desk key, reserved before each call, both journals, the 1.25 margin", async () => {
  const plan = await ensurePlan();
  const cmd = liveCmd({});
  const env = liveCapsEnv(plan);
  const fake = makeFake({ ledger: cmd.ledger });
  const r = await liveRun(cmd, { env, fake });
  t.equal(r.code, 0, r.out.slice(-800) + r.err.slice(0, 400));
  t.match(r.out, /Gate 7: the dry run of this set passed\./);
  t.match(r.out, /Provider-side spend limit confirmed by you: \$3\.0000/);
  t.match(r.out, /Run R1: LIVE, 10 of 10 cases/);
  t.equal(r.blocked.length, 0, "the interceptor saw nothing but the one allowed call");
  t.equal(r.anthropic.length, 40, "ten questions, four calls each");
  for (const e of r.anthropic) {
    t.equal(e.url, ANTHROPIC); t.equal(e.method, "POST"); t.equal(e.x_api_key, DESK_KEY, "the desk key"); t.equal(e.version, "2023-06-01");
    t.equal(e.has_shared, false, "the shared key is not in any request body"); t.equal(e.has_desk, false, "the key is only in the header");
    t.ok(e.pending_live_rows >= 1, `call ${e.n}: a live reservation (cost still open) was already in the ledger when the request left`);
    t.ok(["claude-haiku-5-5", "claude-sonnet-5-5"].includes(e.model));
  }
  const res = readJson(path.join(cmd.out, "results.json"));
  t.equal(res.mode, "live"); t.equal(res.scripted, false); t.equal(res.n_cases_run, 10); t.equal(res.stopped, null); t.equal(res.anthropic_calls, 40); t.equal(res.network_attempts, 0);
  t.equal(res.status, "COMPLETE"); t.equal(res.approved_max_usd, 2); t.equal(res.prices.verified_by_user_on, TODAY); t.equal(res.price_margin, 1.25); t.equal(res.provider_limit_usd, 3); t.equal(res.estimate_only, false);
  const perQ = Number(env.DESK_BUDGET_PER_QUESTION_USD);
  for (const c of res.cases) { t.ok(c.cost_usd <= perQ + 1e-9, `${c.id}: spend within the per-question cap`); t.ok(c.final_card && c.tool_calls && c.facts && c.validator && c.score, c.id); t.ok(c.ledger.every((x) => x.mode === "live" && x.cost_usd != null)); }
  const dry = readJson(path.join(cmd.out, "dry", "results.json"));
  t.deepEqual(res.cases.map((c) => c.state), dry.cases.map((c) => c.state), "the live path produced the same cards as the dry path for the same scripted answers");
  // the safety margin: every usage count is raised 25 percent before it is priced and recorded, through the gate's own pricing path
  const { costUsd } = await import("../worker/src/desk/prices.js");
  const expected = fake.log.usage.reduce((a, u) => a + costUsd(u.model, { input_tokens: Math.ceil(u.usage.input_tokens * 1.25), output_tokens: Math.ceil(u.usage.output_tokens * 1.25) }), 0);
  const unscaled = fake.log.usage.reduce((a, u) => a + costUsd(u.model, u.usage), 0);
  const db = new DatabaseSync(cmd.ledger, { readOnly: true });
  t.equal(db.prepare("SELECT COUNT(*) n FROM ai_call_log WHERE mode = 'live'").get().n, 40);
  t.equal(db.prepare("SELECT COUNT(*) n FROM ai_call_log WHERE mode = 'live' AND cost_usd IS NULL").get().n, 0, "every reservation finalized");
  const liveSum = db.prepare("SELECT SUM(cost_usd) s FROM ai_call_log WHERE mode = 'live'").get().s;
  t.ok(Math.abs(liveSum - res.totals.cost_usd) < 1e-9);
  t.ok(Math.abs(liveSum - expected) < 1e-9, `the ledger holds the margin-adjusted cost (${liveSum} vs ${expected})`);
  t.ok(liveSum / unscaled > 1.24 && liveSum / unscaled < 1.26, `about 1.25 times the table's own cost (${(liveSum / unscaled).toFixed(4)})`);
  db.close();
  clean(r);
  const files = allText(cmd.out);
  t.ok(!files.includes(DESK_KEY) && !files.includes(SHARED_KEY), "neither key is in any file the run wrote");
  // both copies of the journal: one line per live call, no text, identical, and equal to the ledger
  const raw1 = fs.readFileSync(cmd.journal, "utf8"), raw2 = fs.readFileSync(secondJournal(cmd), "utf8");
  t.equal(raw1, raw2, "the second copy is written with every line");
  const lines = raw1.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  t.equal(lines.length, 40);
  t.deepEqual(Object.keys(lines[0]).sort(), ["call_index", "final_cost_usd", "model", "question_id", "reserved_usd", "run_id", "step", "ts", "v"], "ids, numbers and a timestamp only: no text");
  t.ok(lines.every((l, i) => l.run_id === "R1" && l.call_index === i + 1 && l.final_cost_usd > 0 && l.final_cost_usd < l.reserved_usd));
  t.ok(Math.abs(lines.reduce((a, l) => a + l.final_cost_usd, 0) - res.totals.cost_usd) < 1e-9, "the journal total equals the run's cost");
  t.ok(!raw1.includes(DESK_KEY));
  // spending is visible; a second live run under the same run id is refused (the ledger remembers); the first-run flag is refused once history exists
  const s = await runner(["--ledger-summary", "--ledger", cmd.ledger], { ledger: cmd.ledger });
  t.match(s.out, /live\s+total\s+\$0\.\d+/); t.match(s.out, /R1\s+live\s+40/); t.match(s.out, /Spend journal: 40 live call\(s\)/); t.match(s.out, /Second journal copy: 40 live call\(s\)/); clean(s);
  const again = liveCmd({ ledger: cmd.ledger, noFirst: true });
  const r2 = await liveRun(again, { env, fake: makeFake({ ledger: cmd.ledger }) });
  t.equal(r2.code, 2); t.match(r2.err, /already has live rows/); t.equal(r2.anthropic.length, 0, "the second attempt sent nothing");
});

test("LIVE needs a person at a real terminal: no TTY is refused (exit 2) after the dry run, a wrong phrase cancels, and nothing is sent either way", async () => {
  const plan = await ensurePlan();
  const env = liveCapsEnv(plan);
  for (const [label, o] of [["no TTY (an automation)", { tty: false }], ["only the run id typed", { typed: "R1" }], ["the wrong cap typed", { typed: "R1 $9.00" }], ["nothing typed", { typed: "" }]]) {
    const cmd = liveCmd({});
    const fake = makeFake({ ledger: cmd.ledger });
    const r = await liveRun(cmd, { env, fake, ...o });
    t.equal(r.code, 2, `${label}: ${r.err.slice(0, 200)}`);
    t.match(r.err, /REFUSED \(gate 8\)/, label);
    t.match(r.err, o.tty === false ? /real terminal/ : /was not typed; cancelled/, label);
    t.equal(r.anthropic.length, 0, `${label}: nothing was sent`); t.deepEqual(r.net, []);
    t.ok(!fs.existsSync(path.join(cmd.out, "results.json")), `${label}: no live results`);
    if (fs.existsSync(cmd.journal)) t.equal(fs.readFileSync(cmd.journal, "utf8"), "", `${label}: no journal line`);
    clean(r);
  }
  const gone = await runner(["--set", SET_REL, "--mode", "live", "--run-id", "R1", "--max-usd", "1.00", "--yes-i-am-not-interactive"]);
  t.equal(gone.code, 64); t.match(gone.err, /unknown argument: --yes-i-am-not-interactive/, "the non-interactive bypass flag no longer exists");
});

// A real run once, then every way of hiding or repeating spending. Each needs a plan for the NEW run id (a plan for R2 is built, free).
async function planFor(runId) { const out = uniq(`plan-${runId}`); const p = await runner(["--set", SET_REL, "--mode", "plan", "--run-id", runId, "--out", out]); t.equal(p.code, 0); return out; }
test("LIVE history: the ledger and BOTH journals must agree; a replaced, deleted or edited record, a symlink, the first-run flag and any run id reuse are refused", async () => {
  const plan = await ensurePlan();
  const env = liveCapsEnv(plan);
  const first = liveCmd({ outUnderHome: true });
  const r1 = await liveRun(first, { env, fake: makeFake({ ledger: first.ledger }) });
  t.equal(r1.code, 0, r1.out.slice(-300) + r1.err.slice(0, 300));
  const j2 = secondJournal(first);
  const out2 = await planFor("R2"), out3 = await planFor("R3");
  const next = (runId, planOut, extra = []) => ({ args: ["--set", SET_REL, "--mode", "live", "--run-id", runId, "--out", planOut, "--max-usd", "2.00", "--approve", `${runId}:2.00:10`, "--prices-confirmed", TODAY, "--provider-limit-confirmed", "3.00", ...extra], home: first.home, out: planOut });
  const go = async (runId, planOut, extra = [], fake = makeFake({ ledger: first.ledger })) => ({ ...(await liveRun(next(runId, planOut, extra), { env, fake, runId })), fake });
  const snap = (f) => fs.readFileSync(f);
  const L = snap(first.ledger), J1 = snap(first.journal), J2 = snap(j2);
  const restore = () => { fs.rmSync(first.ledger, { force: true }); fs.writeFileSync(first.ledger, L); fs.rmSync(first.journal, { force: true }); fs.writeFileSync(first.journal, J1); fs.rmSync(j2, { force: true }); fs.writeFileSync(j2, J2); };
  const refused = (r, re, label) => { t.equal(r.code, 2, `${label}: ${r.err.slice(0, 160)}`); t.match(r.err, /REFUSED \(gate 12\)/, label); t.match(r.err, re, label); t.equal(r.anthropic.length, 0, `${label}: nothing sent`); };

  // 1. --ledger is not allowed in live mode
  refused(await go("R2", out2, ["--ledger", path.join(TMP, "fresh.sqlite")]), /--ledger is not allowed in live mode/, "fresh --ledger");
  // 2. the ledger missing, empty or replaced while a journal shows spending
  fs.rmSync(first.ledger);
  refused(await go("R2", out2), /the ledger show no live spending[^\n]*the spend journal shows 40 live call\(s\)/, "ledger deleted");
  fs.writeFileSync(first.ledger, "");
  refused(await go("R2", out2), /the ledger show no live spending/, "ledger empty");
  restore();
  // 3. either journal copy, or both, missing or short while the others show spending
  fs.rmSync(first.journal);
  refused(await go("R2", out2), /the spend journal show no live spending[^\n]*the ledger shows 40/, "journal deleted");
  restore(); fs.rmSync(j2);
  refused(await go("R2", out2), /the second copy of the spend journal show no live spending/, "second copy deleted");
  restore(); fs.rmSync(first.journal); fs.rmSync(j2);
  refused(await go("R2", out2), /the spend journal and the second copy of the spend journal show no live spending/, "both journals deleted");
  restore(); fs.writeFileSync(j2, J2.toString("utf8").split("\n").slice(0, 30).join("\n") + "\n");
  refused(await go("R2", out2), /disagree/, "second copy short");
  restore(); fs.writeFileSync(first.journal, J1.toString("utf8").split("\n").slice(0, 30).join("\n") + "\n");
  refused(await go("R2", out2), /disagree/, "first copy short");
  restore();
  // 4. a ledger edited down, and a maintained total zeroed
  const db = new DatabaseSync(first.ledger); db.exec("UPDATE ai_call_log SET cost_usd = cost_usd / 2 WHERE id = (SELECT MIN(id) FROM ai_call_log WHERE mode = 'live')"); db.close();
  refused(await go("R2", out2), /disagree/, "ledger edited");
  restore();
  const db2 = new DatabaseSync(first.ledger); db2.exec("UPDATE ai_budget_totals SET spent_usd = 0 WHERE mode = 'live'"); db2.close();
  refused(await go("R2", out2), /maintained live total/, "totals zeroed");
  restore();
  // 5. symbolic links in place of the ledger or the second journal
  const real = path.join(TMP, "real-ledger.sqlite"); fs.writeFileSync(real, L); fs.rmSync(first.ledger); fs.symlinkSync(real, first.ledger);
  refused(await go("R2", out2), /is a symbolic link; live mode refuses it/, "ledger symlink");
  fs.rmSync(first.ledger); restore();
  const realJ = path.join(TMP, "real-journal.jsonl"); fs.writeFileSync(realJ, J2); fs.rmSync(j2); fs.symlinkSync(realJ, j2);
  refused(await go("R2", out2), /is a symbolic link; live mode refuses it/, "second journal symlink");
  fs.rmSync(j2); restore();
  // 6. the first-run flag is refused once history exists
  refused(await go("R2", out2, ["--first-live-run"]), /--first-live-run is only for the very first live run/, "first-live-run with history");
  // 7. run id reuse: the ledger remembers; then with every record gone only the live results in the run's folder remember
  refused(await runner2(first, "R1", first.out), /already has live rows/, "same run id");
  fs.rmSync(first.ledger); fs.rmSync(first.journal); fs.rmSync(j2);
  refused(await go("R2", out2), /runs folder holds live results \(R1\)[^\n]*show no live spending/, "all three records gone");
  restore();
  // 8. everything restored: a NEW run id is accepted (no flag), and both journals grow by exactly its calls
  const ok = await go("R3", out3);
  t.equal(ok.code, 0, ok.out.slice(-300) + ok.err.slice(0, 300)); t.equal(ok.anthropic.length, 40);
  for (const f of [first.journal, j2]) t.equal(fs.readFileSync(f, "utf8").split("\n").filter(Boolean).length, 80, "both copies grew");
  const dbEnd = new DatabaseSync(first.ledger, { readOnly: true });
  t.equal(dbEnd.prepare("SELECT COUNT(*) n FROM ai_call_log WHERE mode = 'live'").get().n, 80, "cumulative spending is kept in the one ledger");
  dbEnd.close();
  async function runner2(base, runId, planOut) { return { ...(await liveRun({ args: ["--set", SET_REL, "--mode", "live", "--run-id", runId, "--out", planOut, "--max-usd", "2.00", "--approve", `${runId}:2.00:10`, "--prices-confirmed", TODAY, "--provider-limit-confirmed", "3.00"], home: base.home, out: planOut }, { env, fake: makeFake({ ledger: base.ledger }), runId })) }; }
});

test("LIVE hard cap: the approved --max-usd limits what the run can reserve and spend, even when the env caps are higher (estimate-only run)", async () => {
  const plan = await ensurePlan();
  const cmd = liveCmd({ maxUsd: "0.50", approve: "R1:0.50:10", estimateOnly: true });
  const env = { ...liveCapsEnv(plan), DESK_BUDGET_PER_RUN_USD: "1.50", DESK_BUDGET_MONTHLY_USD: "5", DESK_BUDGET_TOTAL_USD: "5" };
  const r = await liveRun(cmd, { env, fake: makeFake({ ledger: cmd.ledger, usageScale: 3 }) });
  t.ok([0, 3].includes(r.code), r.out.slice(-400) + r.err.slice(0, 300));
  t.match(r.out, /WARNING: --no-provider-limit-estimate-only\. There is NO provider-side spend limit/);
  t.match(r.out, /WARNING: no provider-side spend limit\. The local caps meter ESTIMATED charges/, "the warning is repeated at the confirmation");
  const db = new DatabaseSync(cmd.ledger, { readOnly: true });
  const sum = db.prepare("SELECT COALESCE(SUM(CASE WHEN cost_usd IS NULL THEN est_cost_usd ELSE cost_usd END), 0) s FROM ai_call_log WHERE mode = 'live'").get().s;
  t.ok(sum <= 0.50 + 1e-9, `reserved plus spent ${sum} never passes the approved $0.50 (env per-run cap was $1.50)`);
  t.ok(sum > 0.30, `the run did spend (${sum}) and was stopped by the approval, not by running out of questions`);
  const blocked = db.prepare("SELECT error_code FROM ai_call_log WHERE mode = 'blocked'").all().map((x) => x.error_code);
  t.ok(blocked.some((c) => /^budget_(per_run|total|monthly)$/.test(c)), `the gate blocked a call at the approved amount (${blocked.join(",")})`);
  db.close();
  const res = readJson(path.join(cmd.out, "results.json"));
  t.equal(res.effective_caps.per_run_usd, 0.5); t.equal(res.caps.per_run_usd, 1.5); t.ok(res.effective_caps.total_usd <= 0.5 + 1e-9);
  t.equal(res.estimate_only, true); t.equal(res.provider_limit_usd, null);
  t.ok(res.cases.some((c) => c.state === "budget_exceeded"), "a card is the code-built budget card");
  const lines = fs.readFileSync(cmd.journal, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  t.ok(Math.abs(lines.reduce((a, l) => a + (l.final_cost_usd == null ? l.reserved_usd : l.final_cost_usd), 0) - sum) < 1e-6, "the journal matches the ledger");
  clean(r);
});

test("LIVE smoke stop: if the mean cost per answered question is above $0.08 after 5 cases, the run stops and reports (exit 3)", async () => {
  const plan = await ensurePlan();
  const cmd = liveCmd({});
  const r = await liveRun(cmd, { env: liveCapsEnv(plan), fake: makeFake({ ledger: cmd.ledger, usageScale: 6 }) });
  t.equal(r.code, 3, r.out.slice(-500) + r.err.slice(0, 300));
  t.match(r.out, /STOPPED: smoke stop: the mean cost per answered question is \$0\.\d+, above \$0\.0800, after 5 cases/);
  const res = readJson(path.join(cmd.out, "results.json"));
  t.equal(res.n_cases_run, 5); t.match(res.stopped.reason, /^smoke stop/); t.equal(res.anthropic_calls, 20, "no call after the stop");
  t.equal(r.anthropic.length, 20); t.ok(r.anthropic.every((e) => e.url === ANTHROPIC && e.x_api_key === DESK_KEY)); t.equal(r.blocked.length, 0);
  t.ok(res.totals.mean_cost_usd > 0.08);
  clean(r);
});

test("LIVE hard abort: a model error stops the run at once (exit 3); the failed call keeps its reservation as its cost, never zero, and is journaled", async () => {
  const plan = await ensurePlan();
  const cmd = liveCmd({});
  const r = await liveRun(cmd, { env: liveCapsEnv(plan), fake: makeFake({ ledger: cmd.ledger, failAt: 3 }) });
  t.equal(r.code, 3, r.out.slice(-500) + r.err.slice(0, 300));
  t.match(r.out, /STOPPED: hard abort: a model call failed in DEV-RUL-02/);
  const res = readJson(path.join(cmd.out, "results.json"));
  t.equal(res.n_cases_run, 1); t.equal(r.anthropic.length, 3, "nothing after the failed call");
  const db = new DatabaseSync(cmd.ledger, { readOnly: true });
  const failed = db.prepare("SELECT cost_usd, est_cost_usd, error_code FROM ai_call_log WHERE mode = 'live' AND error_code IS NOT NULL").get();
  t.ok(failed && failed.cost_usd > 0 && failed.cost_usd === failed.est_cost_usd && failed.error_code === "http_error", "a 5xx may have been processed: charged at the reservation");
  db.close();
  t.equal(fs.readFileSync(cmd.journal, "utf8").split("\n").filter(Boolean).length, 3, "all three calls, including the failed one, are in the journal");
  clean(r);
});

test("LIVE hard abort: a card the validator rejects twice in the first three cases stops the run", async () => {
  const plan = await ensurePlan();
  const cmd = liveCmd({});
  const r = await liveRun(cmd, { env: liveCapsEnv(plan), fake: makeFake({ ledger: cmd.ledger, badCard: true }) });
  t.equal(r.code, 3, r.out.slice(-400)); t.match(r.out, /STOPPED: hard abort: the validator rejected the card twice in DEV-RUL-02, one of the first 3 cases/);
  const res = readJson(path.join(cmd.out, "results.json"));
  t.equal(res.n_cases_run, 1); t.equal(res.cases[0].state, "tool_failure"); t.deepEqual(res.cases[0].final_card.facts, {}, "the user would see a code-built card, not the typed number");
  t.ok(!JSON.stringify(res.cases[0].final_card).includes("9 players"));
  clean(r);
});

test("LIVE aborts the moment ACTUAL spend passes the approved amount: a fake client whose returned usage costs more than its reservation (exit 4, ABORTED_OVER_CAP, no further call)", async () => {
  const plan = await ensurePlan();
  const cmd = liveCmd({ maxUsd: "0.50", approve: "R1:0.50:10", providerLimit: "0.80" });
  const env = { ...liveCapsEnv(plan), DESK_BUDGET_PER_RUN_USD: "1.50", DESK_BUDGET_MONTHLY_USD: "5", DESK_BUDGET_TOTAL_USD: "5" };
  const r = await liveRun(cmd, { env, fake: makeFake({ ledger: cmd.ledger, usageScale: 20 }) });
  t.equal(r.code, 4, r.out.slice(-500) + r.err.slice(0, 300));
  t.match(r.out, /ABORTED_OVER_CAP: actual spend \$0\.\d+ is over the approved \$0\.500000; no further call was made/);
  t.equal(r.anthropic.length, 3, "router, loop, loop: the composer call and everything after it were never made");
  const res = readJson(path.join(cmd.out, "results.json"));
  t.equal(res.status, "ABORTED_OVER_CAP"); t.equal(res.stopped.aborted_over_cap, true); t.equal(res.n_cases_run, 1); t.equal(res.approved_max_usd, 0.5);
  t.match(fs.readFileSync(path.join(cmd.out, "summary.md"), "utf8"), /Status: ABORTED_OVER_CAP/);
  const db = new DatabaseSync(cmd.ledger, { readOnly: true });
  const rows = db.prepare("SELECT est_cost_usd, cost_usd FROM ai_call_log WHERE mode = 'live' ORDER BY id").all();
  t.equal(rows.length, 3);
  t.ok(rows.some((x) => x.cost_usd > x.est_cost_usd), "a call's ACTUAL cost was above its reservation: the check uses the returned usage, not the reservation");
  const spent = rows.reduce((a, x) => a + x.cost_usd, 0);
  t.ok(spent > 0.5, `actual spend ${spent} passed the approved $0.50`);
  t.equal(db.prepare("SELECT COUNT(*) n FROM ai_call_log WHERE mode = 'live' AND cost_usd IS NULL").get().n, 0);
  db.close();
  t.equal(fs.readFileSync(cmd.journal, "utf8").split("\n").filter(Boolean).length, 3, "every call that was made is in the journal");
  clean(r);
});

test("injected terminal streams, home and fetch seams are IGNORED unless the test gate is open: a real-looking key with fake TTY streams is refused (gate 8) up front", async () => {
  const realish = "sk-ant-api03-REAL-LOOKING-KEY-0000000000";
  const plan = await ensurePlan();
  const input = new PassThrough(), output = new PassThrough(); input.isTTY = true; output.isTTY = true; output.resume();
  input.write("R1 $1.00\n");
  const cmd = liveCmd({ maxUsd: "1.00", approve: "R1:1.00:10", providerLimit: "2.00" });
  const saved = { i: process.stdin.isTTY, o: process.stdout.isTTY };
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true }); Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });   // a developer may run this from a terminal
  const errL = [], keep = { log: console.log, error: console.error };
  console.log = () => {}; console.error = (...a) => errL.push(a.join(" "));
  let codes = [];
  try {
    for (const over of [{ ANTHROPIC_API_KEY_DESK: realish }, { ANTHROPIC_API_KEY_DESK: realish, UPS_AI_EVAL_UNDER_TEST: "1" }, { ANTHROPIC_API_KEY_DESK: DESK_KEY }]) {   // real key, real key + flag, canary without the flag
      codes.push(await mod.main(cmd.args, { ...liveCapsEnv(plan), ...over, ...homeEnv(cmd.home), UPS_AI_EVAL_UNDER_TEST: over.UPS_AI_EVAL_UNDER_TEST }, { stdin: input, stdout: output }));
    }
  } finally {
    console.log = keep.log; console.error = keep.error;
    for (const [k, v] of [["isTTY", saved.i]]) { if (v === undefined) delete process.stdin[k]; else Object.defineProperty(process.stdin, k, { value: v, configurable: true }); }
    if (saved.o === undefined) delete process.stdout.isTTY; else Object.defineProperty(process.stdout, "isTTY", { value: saved.o, configurable: true });
  }
  t.deepEqual(codes, [2, 2, 2]);
  t.equal(errL.filter((l) => /REFUSED \(gate 8\)/.test(l) && /terminal streams supplied by a caller are ignored/.test(l)).length, 3, "each attempt: refused up front because the injected TTY streams were ignored");
  t.ok(!errL.join("\n").includes(realish), "the key is not printed");
  t.ok(!fs.existsSync(cmd.ledger) && !fs.existsSync(path.join(cmd.out, "results.json")), "nothing was written");
  // the pieces
  const real = { stdin: process.stdin, stdout: process.stdout };
  const fake = { stdin: input, stdout: output };
  t.equal(mod.resolveIo({ ANTHROPIC_API_KEY_DESK: realish, UPS_AI_EVAL_UNDER_TEST: "1" }, fake).stdin, real.stdin, "real key: injected streams ignored");
  t.equal(mod.resolveIo({ ANTHROPIC_API_KEY_DESK: DESK_KEY }, fake).stdout, real.stdout, "canary without the test flag: ignored");
  t.equal(mod.resolveIo({ ANTHROPIC_API_KEY_DESK: DESK_KEY, UPS_AI_EVAL_UNDER_TEST: "1" }, fake).stdin, input, "the full test gate: honored");
  t.equal(mod.isTestGate({ ANTHROPIC_API_KEY_DESK: DESK_KEY, UPS_AI_EVAL_UNDER_TEST: "1" }), true); t.equal(mod.isTestGate({ ANTHROPIC_API_KEY_DESK: realish, UPS_AI_EVAL_UNDER_TEST: "1" }), false); t.equal(mod.isTestGate(null), false);
  // the fetch seam: outside the test gate live needs Node's own fetch (a replaced fetch is refused), which a child process without any preload has
  t.equal(mod.looksLikeNodeFetch(async () => new Response("{}")), false); t.equal(mod.looksLikeNodeFetch(null), false);
  const child = await new Promise((resolve) => { let out = ""; const c = spawn(process.execPath, ["--input-type=module", "-e", `import("${pathToFileURL(path.join(ROOT, "scripts/ai_eval/run_eval.mjs")).href}").then((m) => console.log(m.looksLikeNodeFetch(globalThis.fetch)))`], { cwd: ROOT, env: { NODE_NO_WARNINGS: "1", HOME: TMP }, stdio: ["ignore", "pipe", "ignore"] }); c.stdout.on("data", (d) => { out += d; }); c.on("close", () => resolve(out.trim())); });
  t.equal(child, "true", "Node's own fetch is recognized");
});

test("the spend journal: both copies are written together, and a write that fails on either one stops further calls", () => {
  const a = path.join(TMP, "jf", "a.jsonl"), b = path.join(TMP, "jf2", "b.jsonl");
  const j = mod.makeJournal([a, b], "RJ");
  j.after({ row: { step: "router", model: "m", est_cost_usd: 0.5, cost_usd: 0.1 }, questionId: "RJ:Q" });
  t.equal(fs.readFileSync(a, "utf8"), fs.readFileSync(b, "utf8")); t.equal(j.before(), null); t.equal(j.index, 1);
  fs.rmSync(b); fs.mkdirSync(b);                                                    // the second copy can no longer be appended to
  j.after({ row: { step: "loop", model: "m", est_cost_usd: 0.5, cost_usd: 0.2 }, questionId: "RJ:Q" });
  t.equal(j.failed, true); t.equal(j.before(), "journal_unwritable", "no further call is allowed");
  t.equal(mod.readJournal(a).count, 2, "the copy that still worked has the line");
});

test("live uses the REAL home: HOME and UPS_AI_EVAL_HOME are ignored; only the canary key plus UPS_AI_EVAL_UNDER_TEST=1 gets a temp home, and only under the OS temp folder", () => {
  const realHome = os.userInfo().homedir;
  const realDir = path.join(realHome, ".ups_ai_eval");
  const fakeHome = path.join(TMP, "somewhere");
  for (const env of [
    { HOME: fakeHome }, { UPS_AI_EVAL_HOME: fakeHome }, { HOME: fakeHome, UPS_AI_EVAL_HOME: fakeHome, ANTHROPIC_API_KEY_DESK: "sk-ant-real-looking-key" },
    { UPS_AI_EVAL_HOME: fakeHome, UPS_AI_EVAL_UNDER_TEST: "1", ANTHROPIC_API_KEY_DESK: "sk-ant-real-looking-key" },       // the flag alone is not enough
    { UPS_AI_EVAL_HOME: fakeHome, ANTHROPIC_API_KEY_DESK: mod.TEST_KEY },                                               // the canary alone is not enough
  ]) {
    const L = mod.liveHome(env);
    t.equal(L.home, realDir, JSON.stringify(Object.keys(env))); t.equal(L.test, false);
    t.ok(L.second.startsWith(realHome) && !L.second.startsWith(realDir), "the second journal lives outside ~/.ups_ai_eval");
    t.equal(L.second, process.platform === "darwin" ? path.join(realHome, "Library", "Application Support", "UPS AI Eval") : path.join(realHome, ".local", "share", "ups-ai-eval"));
  }
  const T = mod.liveHome({ UPS_AI_EVAL_HOME: fakeHome, UPS_AI_EVAL_UNDER_TEST: "1", ANTHROPIC_API_KEY_DESK: mod.TEST_KEY });
  t.equal(T.home, fakeHome); t.equal(T.test, true); t.equal(T.second, path.join(fakeHome, "second_copy"));
  t.equal(mod.TEST_KEY, "TEST-CANARY-KEY-NOT-REAL");
  for (const bad of ["/etc/ups", path.join(realHome, "elsewhere"), os.tmpdir(), "/"]) t.throws(() => mod.liveHome({ UPS_AI_EVAL_HOME: bad, UPS_AI_EVAL_UNDER_TEST: "1", ANTHROPIC_API_KEY_DESK: mod.TEST_KEY }), /under the OS temp folder/, `${bad} is refused in test mode, never silently replaced by the real home`);
});

test("plan and dry may use UPS_AI_EVAL_HOME, but only for a folder under the OS temp folder; anywhere else it is ignored", () => {
  t.equal(mod.evalHome({ UPS_AI_EVAL_HOME: path.join(TMP, "somewhere") }), path.join(TMP, "somewhere"));
  const real = mod.evalHome({});
  t.equal(real, path.join(os.homedir(), ".ups_ai_eval"));
  // The account's real home (not $HOME, which the safe suite points inside the OS temp folder, where a path would be legitimately accepted).
  for (const bad of ["/etc/ups", path.join(os.userInfo().homedir, "elsewhere"), os.tmpdir(), "/", path.join(TMP, "..", "..", "..", "x")]) t.equal(mod.evalHome({ UPS_AI_EVAL_HOME: bad }), real, `${bad} is ignored`);
  const d = mod.acceptableToday(new Date(2026, 10, 20, 23, 30));            // local 2026-11-20 evening
  t.equal(d.local, "2026-11-20");
  t.ok(d.utc === "2026-11-20" || d.utc === "2026-11-21");
});

// ── pieces, in process ──────────────────────────────────────────────────────────────────────────────
test("the fetch guard allows exactly one request shape and counts everything else", async () => {
  const seen = [];
  const counters = { allowed: 0, blocked: 0 };
  const guarded = mod.makeGuardedFetch(async (u, i) => { seen.push([String(u), i && i.method]); return new Response("{}"); }, counters);
  await guarded(ANTHROPIC, { method: "POST", body: "{}" });
  for (const [u, m] of [[ANTHROPIC, "GET"], ["https://api.anthropic.com/v1/complete", "POST"], ["https://api.anthropic.com/v1/messages?x=1", "POST"], ["https://evil.example/v1/messages", "POST"], ["http://api.anthropic.com/v1/messages", "POST"], ["https://www48.myfantasyleague.com/2026/export", "GET"], ["https://discord.com/api/x", "POST"]]) {
    let threw = false; try { await guarded(u, { method: m }); } catch (_) { threw = true; }
    t.ok(threw, `${m} ${u} is refused`);
  }
  t.equal(counters.allowed, 1); t.equal(counters.blocked, 7); t.deepEqual(seen, [[ANTHROPIC, "POST"]], "only the allowed call reached the real fetch");
});

test("the typed confirmation: both streams must be TTYs, and the exact run id and approved cap must be typed (driven with fake streams)", async () => {
  const mk = (isTTY, text) => { const input = new PassThrough(), output = new PassThrough(); input.isTTY = isTTY; output.isTTY = isTTY; output.resume(); input.write(text); return { input, output }; };
  t.equal(mod.confirmPhrase("R1", 1), "R1 $1.00"); t.equal(mod.confirmPhrase("R7", 0.5), "R7 $0.50");
  t.equal(await mod.liveConfirmation({ runId: "R1", maxUsd: 1, ...mk(true, "R1 $1.00\n") }), true);
  t.equal(await mod.liveConfirmation({ runId: "R1", maxUsd: 1, ...mk(true, "  R1 $1.00  \n") }), true);
  for (const typed of ["R1\n", "r1 $1.00\n", "R1 $2.00\n", "R1 1.00\n", "yes\n", "\n"]) {
    let msg = null; try { await mod.liveConfirmation({ runId: "R1", maxUsd: 1, ...mk(true, typed) }); } catch (e) { msg = e.message; }
    t.match(msg, /was not typed; cancelled/, JSON.stringify(typed));
  }
  for (const [label, streams] of [["isTTY merely truthy (1), not true", { ...mk(true, "R1 $1.00\n"), input: Object.assign(new PassThrough(), { isTTY: 1 }) }], ["no TTY on either", mk(false, "R1 $1.00\n")], ["TTY in, none out", { ...mk(true, "R1 $1.00\n"), output: Object.assign(new PassThrough(), { isTTY: false }) }], ["no streams", { input: null, output: null }]]) {
    let msg = null; try { await mod.liveConfirmation({ runId: "R1", maxUsd: 1, ...streams }); } catch (e) { msg = e.message; }
    t.match(msg, /real terminal/, label);
  }
});

test("invariants: a typed digit, a fact missing from the card and an over-cap question are all caught", () => {
  const good = { card: { state: "answer", lead_md: "Room is {{f.c1.x}}.", facts_used: ["c1.x"], facts: { "c1.x": {} }, footer: { cost_usd: 0.01 } }, ledger: [{ cost_usd: 0.01, est_cost_usd: 0.05 }] };
  t.deepEqual(mod.invariantFailures(good, 0.5), []);
  t.equal(mod.invariantFailures({ ...good, card: { ...good.card, lead_md: "Room is 9." } }, 0.5).length, 1);
  t.equal(mod.invariantFailures({ ...good, card: { ...good.card, facts: {} } }, 0.5).length, 1);
  t.ok(mod.invariantFailures(good, 0.005).some((x) => /per-question cap/.test(x)));
  const gl = { ...good, card: { ...good.card, lead_md: "No. The glossary lists Vet-Ext1 as a status token." }, envelopes: [{ tool: "glossary.lookup", status: "ok", data: { entries: [{ term: "Vet-Ext1", aliases: ["ext1"] }] } }] };
  t.deepEqual(mod.invariantFailures(gl, 0.5), [], "a glossary term returned this run may be written as spelled");
  t.equal(mod.invariantFailures({ ...gl, envelopes: [] }, 0.5).length, 1, "without the glossary lookup the same text is a typed digit");
  t.deepEqual(mod.invariantFailures({ ...good, card: { state: "tool_failure", lead_md: "Could not verify 12.", facts_used: [], facts: {}, footer: { cost_usd: 0.01 } } }, 0.5), [], "a code-built card is not model prose");
});

test("argument parsing: unknown flags and missing values are usage errors (exit 64), and --mode is required", async () => {
  t.throws(() => mod.parseArgs(["--nope"]));
  t.throws(() => mod.parseArgs(["--mode"]));
  const r = await runner(["--set", SET_REL, "--run-id", "R1"]);
  t.equal(r.code, 64); t.match(r.err, /--mode plan\|dry\|live is required/);
  const r2 = await runner(["--mode", "plan", "--run-id", "bad id!", "--set", SET_REL]);
  t.equal(r2.code, 64);
});

await run("ai_desk_paid_runner");
fs.rmSync(TMP, { recursive: true, force: true });
