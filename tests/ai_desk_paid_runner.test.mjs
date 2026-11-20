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
const DESK_KEY = "sk-ant-desk-CANARY-0000000000000000";
const SHARED_KEY = "sk-ant-shared-CANARY-1111111111111111";
const TODAY = new Date().toISOString().slice(0, 10);
const ANTHROPIC = "https://api.anthropic.com/v1/messages";
let seq = 0;
const uniq = (name) => path.join(TMP, `${name}-${++seq}`);

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
      env: { NODE_NO_WARNINGS: "1", HOME: TMP, FAKE_LOG: log, SHARED_KEY, ...(fakeAnthropic ? { FAKE_ANTHROPIC: "1" } : {}), ...(ledger ? { LEDGER: ledger } : {}), ...env },
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
  const out = o.out || uniq("live-out");
  if (!o.noPlanCopy) { fs.mkdirSync(out, { recursive: true }); fs.copyFileSync(path.join(BASE_OUT, "plan.json"), path.join(out, "plan.json")); }
  const maxUsd = o.maxUsd || "2.00";
  const args = ["--set", o.set || SET_REL, "--mode", "live", "--run-id", o.runId || "R1", "--out", out, "--ledger", o.ledger || uniq("ledger") + ".sqlite", "--max-usd", maxUsd];
  if (!o.noApprove) args.push("--approve", o.approve || `R1:${maxUsd}:10`);
  if (!o.noPrices) args.push("--prices-confirmed", o.prices || TODAY);
  if (!o.noYes) args.push("--yes-i-am-not-interactive");
  if (o.acceptKnown) args.push("--accept-known-issues");
  return { args, out, ledger: args[args.indexOf("--ledger") + 1] };
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
  ["gate 4: the most the run could cost is above --max-usd", () => ({ cmd: { maxUsd: "1.00", approve: "R1:1.00:10" } }), 4, /could cost .* above --max-usd/],
  ["gate 5: no approval string", () => ({ cmd: { noApprove: true } }), 5, /--approve/],
  ["gate 5: the approval names another run", () => ({ cmd: { approve: "R2:2.00:10" } }), 5, /different run id/],
  ["gate 5: the approval has the wrong case count", () => ({ cmd: { approve: "R1:2.00:9" } }), 5, /says 9 cases/],
  ["gate 5: --max-usd differs from the approved amount", () => ({ cmd: { approve: "R1:1.90:10" } }), 5, /--max-usd is missing or does not equal/],
  ["gate 5: a malformed approval", () => ({ cmd: { approve: "yes please" } }), 5, /--approve/],
  ["gate 6: prices were not confirmed", () => ({ cmd: { noPrices: true } }), 6, /--prices-confirmed/],
  ["gate 6: the price confirmation is from another day", () => ({ cmd: { prices: "2020-01-01" } }), 6, /not today/],
  ["gate 8: not interactive and no --yes-i-am-not-interactive", () => ({ cmd: { noYes: true } }), 8, /not an interactive terminal/],
];

test("every live gate refuses on its own: exit 2, the gate named, ZERO network attempts, no client, no results, no live ledger row", async () => {
  const plan = await ensurePlan();
  const setCopy = path.join(TMP, "set_copy.json");
  const s = readJson(path.join(ROOT, SET_REL)); s.purpose += " (edited)"; fs.writeFileSync(setCopy, JSON.stringify(s));
  const jobs = GATES.map(([name, mk, gate, re]) => async () => {
    const m = mk();
    const cmd = liveCmd({ ...(m.cmd || {}), set: m.cmd && m.cmd.set === "COPY_WITH_EDIT" ? setCopy : undefined });
    const env = { ...liveCapsEnv(plan), ...(m.env || {}) };
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
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
  t.equal(r2.code, 0, r2.out.slice(-400) + r2.err.slice(0, 300)); t.equal(r2.anthropic.length, 40);
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

// ── live, with the interceptor ──────────────────────────────────────────────────────────────────────
test("LIVE with every gate satisfied (interceptor): ONLY POST api.anthropic.com/v1/messages, the desk key, reserved in the ledger before each call, the shared key never sent", async () => {
  const plan = await ensurePlan();
  const cmd = liveCmd({});
  const env = liveCapsEnv(plan);
  const r = await runner(cmd.args, { env, fakeAnthropic: true, ledger: cmd.ledger });
  t.equal(r.code, 0, r.out.slice(-800) + r.err.slice(0, 400));
  t.match(r.out, /Gate 7: the dry run of this set passed\./);
  t.match(r.out, /Run R1: LIVE, 10 of 10 cases/);
  t.equal(r.blocked.length, 0, "the interceptor saw nothing but the one allowed call");
  t.equal(r.anthropic.length, 40, "ten questions, four calls each");
  for (const e of r.anthropic) {
    t.equal(e.url, ANTHROPIC); t.equal(e.method, "POST"); t.equal(e.x_api_key, DESK_KEY, "the desk key"); t.equal(e.version, "2023-06-01");
    t.equal(e.has_shared, false, "the shared key is not in any request body"); t.equal(e.has_desk, false, "the key is only in the header");
    t.ok(e.pending_live_rows >= 1, `call ${e.n}: a live reservation (cost still open) was already in the ledger when the request left`);
    t.ok(["claude-haiku-5-5", "claude-sonnet-5-5"].includes(e.model));
  }
  t.ok(r.anthropic.every((e) => e.x_api_key !== SHARED_KEY));
  const res = readJson(path.join(cmd.out, "results.json"));
  t.equal(res.mode, "live"); t.equal(res.scripted, false); t.equal(res.n_cases_run, 10); t.equal(res.stopped, null); t.equal(res.anthropic_calls, 40); t.equal(res.network_attempts, 0);
  t.equal(res.prices.verified_by_user_on, TODAY);
  const perQ = Number(env.DESK_BUDGET_PER_QUESTION_USD);
  for (const c of res.cases) { t.ok(c.cost_usd <= perQ + 1e-9, `${c.id}: spend ${c.cost_usd} is within the per-question cap`); t.ok(c.final_card && c.tool_calls && c.facts && c.validator && c.score, c.id); t.ok(c.ledger.every((x) => x.mode === "live" && x.cost_usd != null)); }
  const dry = readJson(path.join(cmd.out, "dry", "results.json"));
  t.deepEqual(res.cases.map((c) => c.state), dry.cases.map((c) => c.state), "the live path produced the same cards as the dry path for the same scripted answers");
  const db = new DatabaseSync(cmd.ledger, { readOnly: true });
  t.equal(db.prepare("SELECT COUNT(*) n FROM ai_call_log WHERE mode = 'live'").get().n, 40);
  t.equal(db.prepare("SELECT COUNT(*) n FROM ai_call_log WHERE mode = 'live' AND cost_usd IS NULL").get().n, 0, "every reservation finalized");
  const liveSum = db.prepare("SELECT SUM(cost_usd) s FROM ai_call_log WHERE mode = 'live'").get().s;
  t.ok(Math.abs(liveSum - res.totals.cost_usd) < 1e-9);
  t.equal(db.prepare("SELECT spent_usd FROM ai_budget_totals WHERE mode = 'live' AND period = 'total'").get().spent_usd > 0, true);
  db.close();
  clean(r);
  const files = allText(cmd.out);
  t.ok(!files.includes(DESK_KEY) && !files.includes(SHARED_KEY), "neither key is in any file the run wrote");
  // spending is visible, and a second live run under the same run id is refused (the ledger remembers)
  const s = await runner(["--ledger-summary", "--ledger", cmd.ledger]);
  t.match(s.out, /live\s+total\s+\$0\.\d+/); t.match(s.out, /R1\s+live\s+40/); clean(s);
  const again = liveCmd({ ledger: cmd.ledger });
  const r2 = await runner(again.args, { env, fakeAnthropic: true, ledger: cmd.ledger });
  t.equal(r2.code, 2); t.match(r2.err, /already has live rows/); t.equal(r2.anthropic.length, 0, "the second attempt sent nothing");
});

test("LIVE smoke stop: if the mean cost per answered question is above $0.08 after 5 cases, the run stops and reports (exit 3)", async () => {
  const plan = await ensurePlan();
  const cmd = liveCmd({});
  const r = await runner(cmd.args, { env: { ...liveCapsEnv(plan), FAKE_USAGE_SCALE: "6" }, fakeAnthropic: true, ledger: cmd.ledger });
  t.equal(r.code, 3, r.out.slice(-500) + r.err.slice(0, 300));
  t.match(r.out, /STOPPED: smoke stop: the mean cost per answered question is \$0\.\d+, above \$0\.0800, after 5 cases/);
  const res = readJson(path.join(cmd.out, "results.json"));
  t.equal(res.n_cases_run, 5); t.match(res.stopped.reason, /^smoke stop/); t.equal(res.anthropic_calls, 20, "no call after the stop");
  t.equal(r.anthropic.length, 20); t.ok(r.anthropic.every((e) => e.url === ANTHROPIC && e.x_api_key === DESK_KEY)); t.equal(r.blocked.length, 0);
  t.ok(res.totals.mean_cost_usd > 0.08);
  clean(r);
});

test("LIVE hard abort: a model error stops the run at once (exit 3); the failed call keeps its reservation as its cost, never zero", async () => {
  const plan = await ensurePlan();
  const cmd = liveCmd({});
  const r = await runner(cmd.args, { env: { ...liveCapsEnv(plan), FAKE_FAIL_AT: "3" }, fakeAnthropic: true, ledger: cmd.ledger });
  t.equal(r.code, 3, r.out.slice(-500) + r.err.slice(0, 300));
  t.match(r.out, /STOPPED: hard abort: a model call failed in DEV-RUL-02/);
  const res = readJson(path.join(cmd.out, "results.json"));
  t.equal(res.n_cases_run, 1); t.equal(r.anthropic.length, 3, "nothing after the failed call");
  const db = new DatabaseSync(cmd.ledger, { readOnly: true });
  const failed = db.prepare("SELECT cost_usd, est_cost_usd, error_code FROM ai_call_log WHERE mode = 'live' AND error_code IS NOT NULL").get();
  t.ok(failed && failed.cost_usd > 0 && failed.cost_usd === failed.est_cost_usd && failed.error_code === "http_error", "a 5xx may have been processed: charged at the reservation");
  db.close(); clean(r);
});

test("LIVE hard abort: a card the validator rejects twice in the first three cases stops the run", async () => {
  const plan = await ensurePlan();
  const cmd = liveCmd({});
  const r = await runner(cmd.args, { env: { ...liveCapsEnv(plan), FAKE_BAD_CARD: "1" }, fakeAnthropic: true, ledger: cmd.ledger });
  t.equal(r.code, 3, r.out.slice(-400)); t.match(r.out, /STOPPED: hard abort: the validator rejected the card twice in DEV-RUL-02, one of the first 3 cases/);
  const res = readJson(path.join(cmd.out, "results.json"));
  t.equal(res.n_cases_run, 1); t.equal(res.cases[0].state, "tool_failure"); t.deepEqual(res.cases[0].final_card.facts, {}, "the user would see a code-built card, not the typed number");
  t.ok(!JSON.stringify(res.cases[0].final_card).includes("9 players"));
  clean(r);
});

// ── pieces, in process ──────────────────────────────────────────────────────────────────────────────
const mod = await import("../scripts/ai_eval/run_eval.mjs");

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

test("the interactive confirmation needs the run id typed exactly", async () => {
  for (const [typed, ok] of [["R1\n", true], ["  R1  \n", true], ["r1\n", false], ["yes\n", false], ["\n", false]]) {
    const input = new PassThrough(), output = new PassThrough();
    const p = mod.confirmInteractive("R1", { input, output });
    input.write(typed);
    t.equal(await p, ok, JSON.stringify(typed));
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
