// Commissioner Desk eval: the ADVERSARIAL MATRIX. Every question in a set is run through the real pipeline (router, tool loop with the real tools, composer, validator,
// server card, budget gate and its request-contract check, the ledger) against a scripted model that misbehaves in the ways R1 to R3 and the provider did or could, and
// against sources that fail or answer garbage. No network, no key, no paid call: the scripted client is a function, and global fetch is replaced for the whole run and
// counted. Each result is graded independently of the fixture oracle (lib/grade.mjs).
//
// What a row proves (and what it cannot): see docs/ai_desk/PREFLIGHT_CONTRACT.md. A passing matrix means the engine handles these shapes safely; it does not mean the
// provider accepts the real requests or that a real model will behave like any of these.
import { createAdversarialClient, BEHAVIORS } from "./scripted_model.mjs";
import { runCase, makeLedgerDb } from "./scenario_env.mjs";
import { gradeAnswer } from "./grade.mjs";
import { plantedNumbers } from "../score.mjs";

// kind: baseline | same (final card and grade equal the baseline; extra = the extra model calls it costs) | parallel (nine calls in one turn: valid sequence, then the baseline or a validation_failed card) | failsafe (a code-built tool_failure with this reason code)
//       | sources (a source fails or answers garbage: nothing may be asserted over a failed tool)
export const SCENARIOS = Object.freeze([
  { id: "baseline", behavior: null, kind: "baseline" },
  { id: "thinking", behavior: "thinking", kind: "same", extra: 0 },
  { id: "thinking_summarized", behavior: "thinking_summarized", kind: "same", extra: 0 },
  { id: "redacted_thinking", behavior: "redacted_thinking", kind: "same", extra: 0 },
  { id: "mixed_text", behavior: "mixed_text", kind: "same", extra: 0 },
  { id: "parallel9", behavior: "parallel9", kind: "parallel", extra: 0 },
  { id: "text_only_composer_once", behavior: "text_only_composer_once", kind: "same", extra: 1 },
  { id: "truncated_composer_once", behavior: "truncated_composer_once", kind: "same", extra: 1 },
  { id: "bad_tool_seq", behavior: "bad_tool_seq", kind: "same", extra: 0 },
  { id: "glossary_case", behavior: "glossary_case", kind: "same", extra: 0 },
  { id: "unicode_digit_once", behavior: "unicode_digit_once", kind: "same", extra: 1 },
  { id: "unicode_digit_claim_once", behavior: "unicode_digit_claim_once", kind: "same", extra: 1 },
  { id: "text_only_composer_always", behavior: "text_only_composer_always", kind: "failsafe", reason: "validation_failed" },
  { id: "unicode_digit_always", behavior: "unicode_digit_always", kind: "failsafe", reason: "validation_failed" },
  { id: "truncated_loop", behavior: "truncated_loop", kind: "failsafe", reason: "tool_limit:max_tokens" },
  { id: "refusal_loop", behavior: "refusal_loop", kind: "failsafe", reason: "tool_limit:refusal" },
  { id: "bad_response_loop", behavior: "bad_response_loop", kind: "failsafe", reason: "model_unavailable:loop" },
  { id: "http400_loop2", behavior: "http400_loop2", kind: "failsafe", reason: "model_unavailable:loop", diagnostics: true },
  { id: "source_http500", behavior: null, fault: { route: "*", mode: "http500" }, kind: "sources" },
  { id: "source_unreachable", behavior: null, fault: { route: "*", mode: "unreachable" }, kind: "sources" },
  { id: "source_empty_body", behavior: null, fault: { route: "*", mode: "empty_body" }, kind: "sources" },
  { id: "source_not_json", behavior: null, fault: { route: "*", mode: "not_json" }, kind: "sources" },
  { id: "source_null_json", behavior: null, fault: { route: "*", mode: "null_json" }, kind: "sources" },
  { id: "source_wrong_shape", behavior: null, fault: { route: "*", mode: "wrong_shape" }, kind: "sources" },
]);
// The scenarios the live preflight (gate 7b) runs: every failure family once, quick to run. The full list is the free `--mode adversarial`.
export const PREFLIGHT_SCENARIO_IDS = Object.freeze(["baseline", "thinking", "redacted_thinking", "parallel9", "mixed_text", "text_only_composer_once", "text_only_composer_always", "truncated_loop",
  "truncated_composer_once", "bad_tool_seq", "glossary_case", "unicode_digit_once", "http400_loop2", "source_http500", "source_empty_body", "source_not_json"]);

const SHAPE_VOCAB = /^[a-z_*0-9,\[\]> ]*$/;          // what a content-free shape line may contain: block type names, counts, brackets, role names
const ASSERTING = ["answer", "answer_with_caveat", "answer_with_gap", "partial", "answer_with_conflict"];

// cases: [{ caseDef, spec }]  (as the runner loads them; caseDef is the bank line, so it carries p1_expected); invariantFailures: the runner's own function (passed in so this
// module stays free of the runner); caps: gate env; onRow(row) optional progress callback. Returns { rows, failures, network_attempts, cases, scenarios }.
export async function runMatrix({ cases, invariantFailures, caps, scenarios = SCENARIOS, onRow = null, runId = "ADV" } = {}) {
  const db = makeLedgerDb(null);                     // its own in-memory ledger: it never touches the real one
  let attempts = 0;
  const saved = globalThis.fetch;
  globalThis.fetch = () => { attempts += 1; throw new Error("network is blocked in the adversarial matrix"); };
  const rows = [];
  try {
    for (const c of cases) {
      const q = c.caseDef.question;
      const p1 = c.caseDef.p1_expected || "answer";
      const planted = [...plantedNumbers(q)];
      let base = null;
      for (const sc of scenarios) {
        const spec = { ...c.spec, ...(sc.fault ? { fault: sc.fault } : {}) };
        const client = createAdversarialClient(c.caseDef.id, sc.behavior);
        let r = null, thrown = null;
        try { r = await runCase({ caseDef: c.caseDef, spec, client, gateEnv: { ...caps }, db, runId: `${runId}-${sc.id}`, clock: "real" }); }
        catch (e) { thrown = e; }
        const row = { case: c.caseDef.id, scenario: sc.id, kind: sc.kind, ok: false, why: [], state: null, reason: null, oracle_pass: null, grade: null, grade_why: [], calls: null, gate_blocks: [], diagnostics: null };
        if (thrown || !r) { row.why.push(`threw: ${thrown && thrown.name ? thrown.name : "error"}`); rows.push(row); if (onRow) onRow(row); continue; }
        const card = r.card;
        const inv = invariantFailures(r, Number(caps.DESK_BUDGET_PER_QUESTION_USD));
        const routeFailed = (r.routes || []).some((x) => x.fault);
        const sourcesDown = sc.kind === "sources" && (r.routes || []).length > 0 && routeFailed;
        const g = gradeAnswer({ p1, card, question: q, invariants: inv, sourcesDown, injectionNumbers: planted });
        row.state = card.state; row.reason = card.reason_code || null; row.oracle_pass = r.oracleCheck ? r.oracleCheck.pass : null; row.grade = g.grade; row.grade_why = g.why; row.calls = r.modelCalls;
        row.gate_blocks = (r.gate || []).filter((x) => !x.ok).map((x) => ({ step: x.step, reason: x.reason, detail: x.detail || null }));
        const contractBlocked = row.gate_blocks.some((x) => x.reason === "request_contract");
        if (contractBlocked) row.why.push("the request contract refused a request the pipeline built");
        if (inv.length) row.why.push(`invariant: ${inv[0]}`);
        const fromModel = !["tool_failure", "budget_exceeded", "stale_data"].includes(card.state);

        if (sc.kind === "baseline") {
          base = { state: card.state, grade: g.grade, calls: r.modelCalls, lead: card.lead_md };
          if (row.gate_blocks.length) row.why.push("a baseline call was blocked");
        } else if (sc.kind === "same") {
          if (!base) row.why.push("no baseline");
          else {
            if (card.state !== base.state) row.why.push(`state ${card.state}, baseline ${base.state}`);
            if (g.grade !== base.grade) row.why.push(`grade ${g.grade}, baseline ${base.grade}`);
            if (r.modelCalls !== base.calls + sc.extra) row.why.push(`${r.modelCalls} model calls, expected ${base.calls + sc.extra}`);
          }
          if (row.gate_blocks.length) row.why.push("a call was blocked");
        } else if (sc.kind === "parallel") {
          // Nine parallel tool calls in ONE turn must produce a valid request sequence (every call answered): no contract refusal and no loop failure. The scripted composer
          // then writes a table of every fact it sees, which can exceed the validator's size limits: that is allowed to end in the code-built validation_failed card, never in anything else.
          if ((r.toolCalls || []).length < 9) row.why.push(`only ${(r.toolCalls || []).length} tool calls ran`);
          if (row.gate_blocks.length) row.why.push("a call was blocked");
          const same = base && card.state === base.state && g.grade === base.grade;
          const safe = card.state === "tool_failure" && card.reason_code === "validation_failed";
          if (!same && !safe) row.why.push(`neither the baseline state nor a validation_failed card: ${card.state} / ${card.reason_code}`);
        } else if (sc.kind === "failsafe") {
          if (card.state !== "tool_failure" || card.reason_code !== sc.reason) row.why.push(`expected a tool_failure card with reason ${sc.reason}, got ${card.state} / ${card.reason_code}`);
          const wantGrade = p1 === "tool_failure_message" ? "Correct" : "Technical failure";       // the outage question's declared right answer IS an honest failure card
          if (g.grade !== wantGrade) row.why.push(`grade ${g.grade}, expected ${wantGrade}`);
          if (Object.keys(card.facts || {}).length || (card.facts_used || []).length) row.why.push("a failure card carries facts");
          if (card.lead_md !== "Could not verify this right now. No answer is shown and no numbers are filled in.") row.why.push("the failure card's text is not the code-built text");
          if (sc.diagnostics) {
            const f = (r.gate || []).find((x) => !x.ok && x.reason === "model_error");
            const shapeLine = f && f.shape ? JSON.stringify(f.shape) : "";
            row.diagnostics = f ? { status: f.status, provider_type: f.provider_type, provider_path: f.provider_path, shape: f.shape } : null;
            if (!f || f.status !== 400 || f.provider_type !== "invalid_request_error" || f.provider_path !== "messages.1.content.0.text") row.why.push("the failed call's status, error type and field path were not recorded");
            if (!f || !f.shape || !Array.isArray(f.shape.messages) || !f.shape.messages.length) row.why.push("no request shape was recorded");
            if (f && f.shape) {
              const vocab = shapeLine.toLowerCase().replace(/tool_use|tool_result|redacted_thinking|thinking|assistant|user|text|other|claude-[a-z0-9-]+|auto|none|tool|any|model|max_tokens|tool_choice|tools|system_blocks|cache_markers|messages|role|blocks/g, " ");
              const words = String(q).toLowerCase().split(/\W+/).filter((w) => w.length > 3);
              if (words.some((w) => vocab.includes(w))) row.why.push("the shape mentions the question's words");
              const flat = f.shape.messages.map((m) => `${m.role} ${m.blocks.join(" ")}`).join(" ");
              if (!SHAPE_VOCAB.test(flat.toLowerCase())) row.why.push("the shape holds more than block types and counts");
            }
          }
        } else if (sc.kind === "sources") {
          // Nothing may be asserted over a failed tool: every fact on the card must come from a tool that returned ok, and the card must not be a model answer that rests on an empty result.
          const envByCall = Object.fromEntries((r.envelopes || []).map((e) => [e.call_id, e]));
          for (const [id, f] of Object.entries(card.facts || {})) { const e = envByCall[f.call_id]; if (!e || e.status !== "ok") row.why.push(`fact ${id} comes from a tool that did not return ok`); }
          if (fromModel && ASSERTING.includes(card.state) && sourcesDown && (card.facts_used || []).length && !Object.keys(card.facts || {}).length) row.why.push("facts used but none on the card");
          if (!sourcesDown) { if (base && card.state !== base.state) row.why.push(`no route was used, but the state is ${card.state}, baseline ${base.state}`); }
          else if (g.grade === "Incorrect") row.why.push(`graded Incorrect: ${g.why.join("; ")}`);
        }
        row.ok = row.why.length === 0;
        rows.push(row); if (onRow) onRow(row);
      }
    }
  } finally { globalThis.fetch = saved; db.close(); }
  const failures = rows.filter((x) => !x.ok);
  return { rows, failures, network_attempts: attempts, cases: cases.length, scenarios: scenarios.length };
}

export const BEHAVIOR_NOTES = BEHAVIORS;
