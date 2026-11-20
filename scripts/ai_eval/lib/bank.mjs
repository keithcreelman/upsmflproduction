// Commissioner Desk eval harness: load and validate a bank (JSONL, one case per line).
//
// Used on the development bank AND, later, on a sealed held-out bank the owner runs from a locked volume. For that reason NOTHING in this file
// ever puts a case's question or answer text into an error message: errors carry a line number, the case id (only when it is a safe slug) and a
// field NAME. Never a value.
import fs from "node:fs";
import crypto from "node:crypto";

export const CATEGORIES = Object.freeze(["LIN", "PLH", "CON", "RUL", "CNF", "OWN", "UNA", "NOW", "REC", "PRV", "INJ", "TFL", "ADV"]);
export const PHASES = Object.freeze(["P1", "S1", "S2", "S3", "S4", "F", "X"]);
export const P1_EXPECTED = Object.freeze([
  "answer", "answer_with_caveat", "answer_with_gap", "partial", "answer_with_conflict", "cite", "cite_and_abstain", "needs_ruling",
  "abstain", "explain_conflict", "refuse_privacy", "refuse_fairness", "ignore_injection", "tool_failure_message",
]);
export const TARGET_EXPECTED = Object.freeze([...P1_EXPECTED, "needs_ruling_or_answer_with_gap", "answer"]);
export const SAFE_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
export const MAX_QUESTION_CHARS = 600;     // the desk's own limit (pipeline.js MAX_QUESTION_CHARS)

const STRING_ARRAY_FIELDS = ["must_include", "must_not", "required_grades", "required_cites", "data_dependencies"];
const REQUIRED = [
  "id", "split", "category", "difficulty", "caller_class", "as_of", "question", "p1_expected", "target_expected", "target_phase",
  "expected_answer", "must_include", "must_not", "required_grades", "required_cites", "ground_truth_method", "data_dependencies", "notes",
  "authored_by", "verified",
];

const isStr = (v) => typeof v === "string" && v.trim().length > 0;
const isObjOrStrOrNull = (v) => v === null || typeof v === "string" || (typeof v === "object" && !Array.isArray(v));
const isIsoDate = (v) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

// Returns { ok, problems: [fieldName...] } for one parsed object. Never returns values.
export function validateCase(c) {
  const problems = [];
  if (!c || typeof c !== "object" || Array.isArray(c)) return { ok: false, problems: ["(line is not an object)"] };
  for (const k of REQUIRED) if (!(k in c)) problems.push(`${k}: missing`);
  if (problems.length) return { ok: false, problems };
  if (!(typeof c.id === "string" && SAFE_ID_RE.test(c.id))) problems.push("id: not a safe slug");
  if (!isStr(c.split)) problems.push("split: must be a non-empty string");
  if (!CATEGORIES.includes(c.category)) problems.push("category: unknown");
  if (!(Number.isInteger(c.difficulty) && c.difficulty >= 1 && c.difficulty <= 5)) problems.push("difficulty: must be an integer 1 to 5");
  if (!(typeof c.caller_class === "string" && (c.caller_class === "commish" || /^owner:\d{4}$/.test(c.caller_class)))) problems.push("caller_class: must be commish or owner:NNNN");
  if (!(typeof c.as_of === "string" && (c.as_of === "eval_time" || c.as_of === "current" || isIsoDate(c.as_of)))) problems.push("as_of: must be eval_time, current or YYYY-MM-DD");
  if (!(isStr(c.question) && c.question.length <= MAX_QUESTION_CHARS)) problems.push("question: must be non-empty text of at most 600 characters");
  if (!P1_EXPECTED.includes(c.p1_expected)) problems.push("p1_expected: unknown value");
  if (!TARGET_EXPECTED.includes(c.target_expected)) problems.push("target_expected: unknown value");
  if (!PHASES.includes(c.target_phase)) problems.push("target_phase: unknown value");
  if (!isObjOrStrOrNull(c.expected_answer)) problems.push("expected_answer: must be an object, a string or null");
  for (const k of STRING_ARRAY_FIELDS) if (!(Array.isArray(c[k]) && c[k].every((x) => typeof x === "string"))) problems.push(`${k}: must be an array of strings`);
  if (!(c.ground_truth_method === null || typeof c.ground_truth_method === "string")) problems.push("ground_truth_method: must be a string or null");
  if (!(c.notes === null || typeof c.notes === "string")) problems.push("notes: must be a string or null");
  if (!isStr(c.authored_by)) problems.push("authored_by: must be a non-empty string");
  if (!isStr(c.verified)) problems.push("verified: must be a non-empty string");
  return { ok: problems.length === 0, problems };
}

// text -> { cases, errors: [{ line, id, problems }], lines }. A malformed line is reported and skipped; the caller decides the exit code.
export function parseBankText(text) {
  const cases = [];
  const errors = [];
  const seen = new Set();
  const lines = String(text).split(/\r?\n/);
  let count = 0;
  lines.forEach((raw, i) => {
    if (!raw.trim()) return;
    count += 1;
    let obj;
    try { obj = JSON.parse(raw); }
    catch (_) { errors.push({ line: i + 1, id: null, problems: ["line is not valid JSON"] }); return; }   // V8's message quotes the text: never forward it
    const v = validateCase(obj);
    const id = obj && typeof obj.id === "string" && SAFE_ID_RE.test(obj.id) ? obj.id : null;
    if (!v.ok) { errors.push({ line: i + 1, id, problems: v.problems }); return; }
    if (seen.has(obj.id)) { errors.push({ line: i + 1, id, problems: ["id: duplicate"] }); return; }
    seen.add(obj.id);
    cases.push(obj);
  });
  return { cases, errors, lines: count };
}

export function loadBank(path) {
  const buf = fs.readFileSync(path);
  const sha12 = crypto.createHash("sha256").update(buf).digest("hex").slice(0, 12);
  const parsed = parseBankText(buf.toString("utf8"));
  return { ...parsed, sha12, bytes: buf.length };
}
