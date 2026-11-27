// Commissioner Desk: one question, start to finish, as a readable transcript.
//
//   node scripts/ai_eval/demo_flow.mjs --case DEV-REC-02       (any of the ten first-run cases)
//   node scripts/ai_eval/demo_flow.mjs --list
//   node scripts/ai_eval/demo_flow.mjs --case DEV-REC-02 --json   (the structured run, for tests)
//
// It runs the REAL pipeline (router, tool loop, composer, validator, server card), the REAL tools over the offline scenario fixtures
// (scripts/ai_eval/lib/scenario_env.mjs), and the REAL budget gate and ledger in fake mode, with the SCRIPTED model standing in for the language
// model. No network, no key, no cost. The scripted model proves tools, facts and validation, not model quality.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCase, makeLedgerDb, visibleLines, SCENARIO_NOW_ISO, PLANTED_NOTE } from "./lib/scenario_env.mjs";
import { createScriptedClient, SCRIPTED_LABEL, SCRIPTED_CASE_IDS } from "./lib/scripted_model.mjs";
import { loadBank } from "./lib/bank.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
export const DEFAULT_SET = path.join(HERE, "sets", "first10.json");
export const DEMO_CAPS = Object.freeze({ DESK_BUDGET_PER_QUESTION_USD: "5", DESK_BUDGET_PER_RUN_USD: "50", DESK_BUDGET_MONTHLY_USD: "50", DESK_BUDGET_TOTAL_USD: "500" });

export function loadSet(file = DEFAULT_SET) {
  const set = JSON.parse(fs.readFileSync(file, "utf8"));
  const bank = loadBank(path.resolve(REPO, set.bank));
  return { set, bank };
}

// ── text helpers ────────────────────────────────────────────────────────────────────────────────────
const money = (n) => `$${(Number(n) || 0).toFixed(6)}`;
const cut = (s, n) => { const t = String(s == null ? "" : s).replace(/\s+/g, " "); return t.length > n ? `${t.slice(0, n - 1)}~` : t; };
const pad = (s, n) => String(s).padEnd(n);
function table(headers, rows) {
  const w = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => `  ${r.map((c, i) => pad(c, w[i])).join("  ")}`.trimEnd();
  return [line(headers), line(w.map((n) => "-".repeat(n))), ...rows.map(line)].join("\n");
}
const rule = (title) => `\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}`;

function dateHow(trace) {
  const t = trace.temporal || {};
  const rg = t.range;
  const found = rg ? (rg.last_n ? `a range: the last ${rg.last_n} ${rg.unit}` : `a range: from ${rg.from}${rg.to ? ` to ${rg.to}` : " to now"}`) : [...(t.dates || []), ...(t.years || [])].join(", ");
  switch (trace.as_of_source) {
    case "user": return "the caller gave the date";
    case "text": return `the question names one date or year (${found}); code pins every tool call to it`;
    case "text+router": return `the question names one year (${found}); the router added the exact day inside that year; code pins every tool call to it`;
    case "text_comparison": return `the question names several dates or years (${found}); there is no single date, so "current" is refused for every tool call`;
    case "router": return `the question text has no date or year the code recognizes; the router's date was used (${trace.as_of})`;
    default: return "the question names no date, so the answer is about the current state";
  }
}

export function renderTranscript(r, { spec } = {}) {
  const L = [];
  const card = r.card, trace = r.trace;
  L.push("UPS Commissioner Desk: one question, start to finish");
  L.push(`MODE: ${r.scripted ? "SCRIPTED model (no AI, no network, no cost)" : "live model"}; real pipeline, real tools, real budget gate, ledger lane "${(r.ledger[0] && r.ledger[0].mode) || "fake"}"`);

  // 1
  L.push(rule("1. THE QUESTION AND THE DATE"));
  L.push(`Case:       ${r.caseId}${spec ? ` (scenario: ${spec.scenario}${spec.fault ? `, fault: ${spec.fault.route} ${spec.fault.mode}` : ""})` : ""}`);
  L.push(`Question:   ${r.question}`);
  L.push(`Clock:      ${SCENARIO_NOW_ISO} (the scenario's fixed "today")`);
  L.push(`Date scope: ${trace.as_of === "multiple" ? "several dates (a comparison)" : trace.as_of}`);
  L.push(`How:        ${dateHow(trace)}`);
  if (trace.router_as_of_ignored) L.push("            (the router's own date was ignored: the text decides)");

  // 2
  L.push(rule("2. ROUTER STEP (one cheap call that sorts the question; it never answers)"));
  const rt = r.transcript.find((s) => s.step === "router" && s.response);
  const rb = rt && (rt.response.content || []).find((b) => b.type === "tool_use");
  if (trace.route && trace.route.by === "code") L.push(`Handled in code, no model call: ${trace.route.intent}`);
  else if (rb) {
    L.push(`Model:      ${rt.model}`);
    L.push(`Intent:     ${rb.input.intent}`);
    L.push(`Domains:    ${(rb.input.domains || []).join(", ")}`);
    L.push(`Date hint:  ${rb.input.needs_as_of || "none"}${trace.router_as_of_ignored ? " (not used)" : ""}`);
    L.push(`Out of scope: ${rb.input.out_of_scope ? "yes" : "no"}`);
  }

  // 3
  L.push(rule("3. TOOL CALLS (the model asks; code authorizes and runs)"));
  L.push("(read from what the pipeline itself ran: its loop messages, its audit log and its trace. No tool is run a second time to make this page.)");
  const routesByCall = {};
  let ri = 0;
  for (const a of r.audit) { routesByCall[a.call_id] = r.routes.slice(ri, ri + (a.routes || []).length); ri += (a.routes || []).length; }
  if (!r.toolCalls.length) L.push("(no tool was called)");
  r.toolCalls.forEach((c) => {
    const env = r.envelopes.find((e) => e.call_id === c.call_id) || {};
    const ov = c.override;
    const ran = c.args_run || c.args;
    L.push(`Call ${c.call_id}: ${c.tool}`);
    L.push(`  arguments sent by the model: ${JSON.stringify(c.args)}`);
    L.push(`  arguments the desk ran:      ${JSON.stringify(ran)}`);
    L.push(`  as_of used:                  ${ran && ran.as_of}${ov ? `  (code replaced the model's ${ov.sent === null ? "missing value" : `"${ov.sent}"`})` : ""}`);
    const rts = routesByCall[c.call_id] || [];
    if (!rts.length) L.push("  routes called:               none (this tool reads bundled knowledge, not a route)");
    for (const x of rts) L.push(`  route called:                GET ${x.path}?${new URLSearchParams(x.params).toString()} -> ${x.status ? `HTTP ${x.status}` : "no answer"}${x.fault ? `  [INJECTED FAULT: ${x.fault}]` : ""}`);
    L.push(`  result status:               ${env.status || "n/a"}${env.error ? ` (${env.error.code}: ${cut(env.error.message, 70)})` : ""}${env.refusal ? ` (${env.refusal.code})` : ""}`);
  });

  // 4
  L.push(rule("4. WHAT CAME BACK: FACTS, GAPS, REFUSALS (every number the model may use is here)"));
  L.push("(the tool results the pipeline handed the model, as it built them; a fact's source is shown only for facts the final card uses)");
  const facts = r.envelopes.flatMap((e) => e.facts || []);
  if (facts.length) {
    const shown = facts.slice(0, 40);
    L.push(table(["id", "label", "value", "unit", "grade", "source", "as_of"], shown.map((f) => [f.id, cut(f.label, 46), cut(f.value, 34), f.unit, f.grade, f.source ? cut(f.source, 30) : "-", f.as_of])));
    if (facts.length > shown.length) L.push(`  ... and ${facts.length - shown.length} more facts`);
  } else L.push("Facts: none");
  const gaps = r.envelopes.flatMap((e) => ((e.coverage && e.coverage.gaps) || []).map((g) => ({ ...g, call: e.call_id })));
  L.push(gaps.length ? "Gaps (the desk copies each onto the card by code):" : "Gaps: none");
  for (const g of gaps) L.push(`  - ${g.call} ${g.why}: ${cut(g.what, 90)}${g.source_needed ? ` [source needed: ${cut(g.source_needed, 60)}]` : ""}`);
  const bad = r.envelopes.filter((e) => e.status !== "ok");
  L.push(bad.length ? "Refusals and failures (a decline, never a guess):" : "Refusals and failures: none");
  for (const e of bad) L.push(`  - ${e.call_id} ${e.tool}: ${e.status}${e.refusal ? ` / ${e.refusal.code}: ${cut(e.refusal.reason, 80)}` : ""}${e.error ? ` / ${e.error.code}: ${cut(e.error.message, 80)}` : ""}`);
  const planted = r.envelopes.filter((e) => JSON.stringify(e.data || null).includes(PLANTED_NOTE)).map((e) => e.call_id);
  const inQuestion = r.question.includes(PLANTED_NOTE);
  const teamFact = r.envelopes.flatMap((e) => e.facts || []).find((f) => /\.team_name$/.test(f.id));
  if (inQuestion || planted.length) L.push(`Planted claim "${PLANTED_NOTE}": in the question: ${inQuestion ? "yes" : "no"}; inside tool data: ${planted.length ? `YES (${planted.join(", ")})` : "no (route text is screened, so a planted team name is dropped"}${teamFact ? `; the team fact reads "${teamFact.display}"` : ""}${planted.length ? "" : ")"}. Injection scanner: ${trace.injection && trace.injection.suspicious ? "flagged" : "nothing flagged"}. The model is told the question is data about what to look up, and no fact carries the claim.`);
  else L.push(`Injection scanner: ${trace.injection && trace.injection.suspicious ? `flagged ${trace.injection.sources.join(", ")}` : "nothing flagged"}`);
  const rules = r.envelopes.filter((e) => e.status === "ok" && /^rules\./.test(e.tool)).flatMap((e) => (e.data && (e.data.hits || (e.data.anchor ? [e.data] : []))) || []);
  if (rules.length) { L.push("Rules retrieved:"); for (const h of rules.slice(0, 8)) L.push(`  - ${h.anchor}  ${cut(h.title, 70)}`); }

  // 5
  L.push(rule("5. THE MODEL'S CARD, exactly as it wrote it (numbers only as {{f.*}} tokens)"));
  if (!r.validator.length) L.push("(the composer was not reached; the desk built the card itself)");
  for (const v of r.validator) { L.push(`Attempt ${v.attempt}:`); L.push(JSON.stringify(v.card, null, 2).split("\n").map((x) => `  ${x}`).join("\n")); }

  // 6
  L.push(rule("6. THE VALIDATOR (code checks the card before anyone sees it)"));
  if (!r.validator.length) L.push("(nothing to validate)");
  for (const v of r.validator) {
    L.push(`Attempt ${v.attempt}: ${v.ok ? "PASS" : "FAIL"}`);
    for (const x of v.rules) L.push(`  ${x.pass ? "PASS" : "FAIL"}  ${x.id}  ${x.label}${x.pass ? "" : `  [${x.failed_codes.join(", ")}]`}`);
    for (const e of v.errors) L.push(`  problem: ${e.code} at ${e.path || "card"}: ${cut(e.message, 90)}`);
  }
  L.push(`Outcome: ${trace.outcome}${card.reason_code && card.reason_code !== card.state ? ` (reason: ${card.reason_code})` : ""}`);

  // 7
  L.push(rule("7. THE FINAL CARD (built by the server; tokens replaced; this is what the page shows)"));
  L.push(`State:   ${card.state}`);
  L.push(`Header:  ai_generated=${card.header.ai_generated}  as_of=${card.header.as_of}  canon=${card.header.canon_sha}  phase=${card.header.phase}`);
  L.push("--- text on the page ---");
  for (const line of visibleLines(card)) L.push(`  ${line}`);
  L.push("--- end of page text ---");
  const used = Object.entries(card.facts || {});
  L.push(used.length ? "Facts on the card (display, grade, what it is, source):" : "Facts on the card: none");
  for (const [id, f] of used.slice(0, 40)) L.push(`  ${id}  ${cut(f.display, 38)}  grade ${f.grade}  | ${cut(f.label, 44)} | ${cut(f.source, 36)}`);
  if (used.length > 40) L.push(`  ... and ${used.length - 40} more`);
  for (const c of card.cites || []) L.push(`Cite: ${c.anchor} at canon ${c.canon_sha}${c.rule ? ` (${cut(c.rule.title, 60)})` : ""}`);
  L.push(`Footer:  tools ${(card.footer.tools || []).map((t) => `${t.id}:${t.status}`).join(", ") || "none"}; model calls ${card.footer.model_calls}; cost ${money(card.footer.cost_usd)}`);
  if ((card.notes || []).length) L.push(`Notes:   ${card.notes.join("; ")}`);

  // 8
  L.push(rule("8. COST LEDGER AND BUDGET GATE"));
  L.push(table(["#", "step", "model", "mode", "in tokens", "out tokens", "reserved before", "charged after"], r.ledger.map((x, i) => [i + 1, x.step, x.model, x.mode, x.input_tokens, x.output_tokens, money(x.est_cost_usd), x.cost_usd == null ? "(open)" : money(x.cost_usd)])));
  const est = r.ledger.reduce((a, x) => a + (x.est_cost_usd || 0), 0), act = r.ledger.reduce((a, x) => a + (x.cost_usd || 0), 0);
  L.push(`  total: reserved ${money(est)}, charged ${money(act)}${r.scripted ? "  (token counts are ESTIMATES from the scripted model)" : ""}`);
  const blocked = r.gate.filter((g) => !g.ok);
  L.push(`Budget gate: ${blocked.length ? `BLOCKED ${blocked.length} call(s): ${blocked.map((g) => g.reason).join(", ")}` : `all ${r.gate.length} calls allowed; each was reserved in the ledger BEFORE the call`}`);
  L.push(`Mode: ${r.ledger[0] ? r.ledger[0].mode : "fake"} (a separate ledger lane from live spend; same limits, same code)`);
  if (r.oracle) L.push(`\nOracle check (fixture, pure code): ${r.oracleCheck.pass === true ? "PASS" : r.oracleCheck.pass === false ? "MISMATCH" : "n/a"}: ${r.oracleCheck.detail}`);

  // 9
  L.push(`\n${SCRIPTED_LABEL}`);
  return L.join("\n");
}

// Runs one case end to end with the scripted model and the real gate. Returns the structured run.
export async function demoCase(caseId, { file = DEFAULT_SET, caps = DEMO_CAPS } = {}) {
  const { set, bank } = loadSet(file);
  const spec = set.cases.find((c) => c.id === caseId);
  if (!spec) throw new Error(`not in the set: ${String(caseId).slice(0, 40)}`);
  const caseDef = bank.cases.find((c) => c.id === caseId);
  if (!caseDef) throw new Error(`not in the bank: ${String(caseId).slice(0, 40)}`);
  const db = makeLedgerDb();
  try {
    const r = await runCase({ caseDef, spec, client: createScriptedClient(caseId), gateEnv: { ...caps }, db, runId: "DEMO", clock: "fixed", keepRequests: true });
    return { run: r, spec };
  } finally { db.close(); }
}

async function main(argv) {
  const get = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
  if (argv.includes("--list")) {
    const { set } = loadSet();
    for (const c of set.cases) console.log(`${c.id}  ${c.scenario}`);
    return 0;
  }
  const id = get("--case");
  if (!id || !SCRIPTED_CASE_IDS.includes(id)) { console.error(`usage: node scripts/ai_eval/demo_flow.mjs --case <${SCRIPTED_CASE_IDS.join("|")}> [--json] | --list`); return 64; }
  const { run, spec } = await demoCase(id);
  if (argv.includes("--json")) {
    const { transcript, envelopes, ...rest } = run;
    console.log(JSON.stringify({ ...rest, facts: envelopes.flatMap((e) => e.facts || []), visible: visibleLines(run.card) }, null, 2));
  } else console.log(renderTranscript(run, { spec }));
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(`demo failed: ${e && e.message ? e.message : e}`); process.exitCode = 1; });
}
