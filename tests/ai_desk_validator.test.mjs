// Commissioner Desk: validator tests. Offline and deterministic. Run: node tests/ai_desk_validator.test.mjs
import { test, run, t } from "./fixtures/mini_test.mjs";
import { validateCard, findSpelledQuantities, errorCodes, buildFactIndex, canonShaMatches, LIMITS, CODES } from "../worker/src/desk/validator.js";

const SHA = "194f8df4109cefab2ef7133a0c59d73d7d588954";
const RULES = { canon_sha: SHA, anchors: ["s1-c4", "s2-t6-1"] };

function fact(callId, key, value, unit, grade = "A") { return { id: `${callId}.${key}`, label: key, value, unit, as_of: "current", source: "stub", grade }; }
function env(callId, tool, status, o = {}) {
  return { tool, call_id: callId, status, data: null, facts: o.facts || [], coverage: { supported: status === "ok", gaps: o.gaps || [] }, provenance: {}, data_class: o.dataClass || "P0", freshness: null, refusal: o.refusal || null, error: o.error || null };
}
const OK1 = env("c1", "cap.position", "ok", { facts: [fact("c1", "cap_available", 12000, "usd"), fact("c1", "franchise", "0003", "id"), fact("c1", "rank", 4, "rank")] });
const ctxFor = (envelopes, o = {}) => ({ envelopes, knowledge: { rules: RULES }, ceiling: "P2", asOf: "current", today: "2026-11-19", ...o });
const GOOD = () => ({ state: "answer", lead_md: "Franchise {{f.c1.franchise}} has {{f.c1.cap_available}} of cap space.", facts_used: ["c1.cap_available", "c1.franchise"] });
const codes = (card, ctx) => errorCodes(validateCard(card, ctx).errors);

test("good cards are accepted and cleaned", () => {
  const v = validateCard(GOOD(), ctxFor([OK1]));
  t.ok(v.ok, JSON.stringify(v.errors));
  t.deepEqual(v.cleaned.facts_used, ["c1.cap_available", "c1.franchise"]);
  t.equal(v.cleaned.state, "answer");
  t.deepEqual(v.cleaned.gaps, []);
  // a token used in prose but not declared is added; a declared fact that exists is kept
  const w = validateCard({ ...GOOD(), facts_used: ["c1.rank"] }, ctxFor([OK1]));
  t.ok(w.ok);
  t.deepEqual(w.cleaned.facts_used, ["c1.cap_available", "c1.franchise", "c1.rank"]);
});

test("a full good card: table with tokens, cites, gaps, conflicts, follow-ups", () => {
  const gapEnv = env("c2", "history.finishes", "ok", { gaps: [{ what: "no record", why: "partial_coverage", source_needed: "archive" }], facts: [fact("c2", "finish", 7, "rank")] });
  const card = {
    state: "answer_with_gap", lead_md: "Franchise {{f.c1.franchise}} finished {{f.c2.finish}}, with a gap.",
    blocks: [{ type: "table", title: "Cap by franchise", columns: ["Franchise", "Cap space"], rows: [["{{f.c1.franchise}}", "{{f.c1.cap_available}}"], ["Total", "{{f.c1.rank}}"]], fact_ids: ["c1.franchise", "c1.cap_available"], tool_call_ids: ["c1", "c2"] }],
    facts_used: ["c1.rank"], cites: [{ anchor: "s1-c4", canon_sha: "194f8df", claim: "The cap rule applies." }],
    gaps: [{ what: "Part of the archive is missing.", why: "partial_coverage", source_needed: "The league archive." }],
    conflicts: [{ fact_a: "c1.cap_available", fact_b: "c2.finish", note: "These disagree." }],
    ruling_question: "Should the commissioner rule on this?", follow_ups: ["Show the rule", "Compare franchises"],
  };
  const v = validateCard(card, ctxFor([OK1, gapEnv]));
  t.ok(v.ok, JSON.stringify(v.errors));
  t.equal(v.cleaned.blocks[0].rows[0][0], "{{f.c1.franchise}}");
  t.ok(canonShaMatches("194f8df", SHA));
  t.ok(!canonShaMatches("194f8de", SHA));
  t.ok(!canonShaMatches("194f", SHA));
});

test("typed digit rejected in every prose field", () => {
  const ctx = ctxFor([OK1]);
  t.deepEqual(codes({ ...GOOD(), lead_md: "Franchise {{f.c1.franchise}} has about 12K of cap space." }, ctx), [CODES.DIGIT_IN_PROSE]);
  t.ok(codes({ ...GOOD(), blocks: [{ type: "table", title: "Top 5", rows: [] }] }, ctx).includes(CODES.DIGIT_IN_PROSE));
  t.ok(codes({ ...GOOD(), blocks: [{ type: "table", rows: [["12"]] }] }, ctx).includes(CODES.DIGIT_IN_PROSE));
  t.ok(codes({ ...GOOD(), blocks: [{ type: "table", columns: ["Week 1"] }] }, ctx).includes(CODES.DIGIT_IN_PROSE));
  t.ok(codes({ ...GOOD(), follow_ups: ["Show 2025"] }, ctxFor([OK1])).includes(CODES.DIGIT_IN_PROSE));
  t.ok(codes({ ...GOOD(), ruling_question: "Is $5 right?" }, ctx).includes(CODES.DIGIT_IN_PROSE));
  t.ok(codes({ ...GOOD(), state: "answer_with_gap", gaps: [{ what: "missing since 2015", why: "NO_RECORD" }] }, ctx).includes(CODES.DIGIT_IN_PROSE));
  t.ok(codes({ ...GOOD(), lead_md: "Franchise {{f.c1.franchise}} has \uff11\uff12 of space." }, ctx).includes(CODES.DIGIT_IN_PROSE), "fullwidth digits");
  t.ok(codes({ ...GOOD(), lead_md: "Franchise {{f.c1.franchise}} has \u00bd of space." }, ctx).includes(CODES.DIGIT_IN_PROSE), "vulgar fraction");
  // tokens glued to digits do not hide them
  t.ok(codes({ ...GOOD(), lead_md: "{{f.c1.cap_available}}0 left" }, ctx).includes(CODES.DIGIT_IN_PROSE));
});

test("spelled quantities rejected; documented idioms accepted", () => {
  const bad = ["twenty-one players", "a dozen picks", "half of the cap", "twice the price", "thrice", "ten teams", "three hundred", "a thousand", "the first round pick", "second overall", "the fourth trade", "one trade", "one-time fee", "zero left", "eleven", "dozens of", "tens of", "million", "Twenty One"];
  for (const s of bad) t.ok(findSpelledQuantities(s).length > 0, `should reject: ${s}`);
  const good = ["one of the franchises", "no one knows", "No one", "someone", "everyone agrees", "anyone can", "any one of them", "this one", "that one", "which one", "each one", "another one", "the one who traded", "one another", "the first trade in the chain", "he went first", "a second look", "third party", "one's own", "The 49ers lost", "none of them"];
  for (const s of good) {
    const lead = s.includes("49ers") ? s : s;
    const hits = findSpelledQuantities(lead);
    t.equal(hits.length, 0, `should accept: ${s} (got ${hits})`);
  }
  // through the validator: SPELLED_QUANTITY code, and the 49ers exception passes the digit check
  const ctx = ctxFor([OK1]);
  t.deepEqual(codes({ ...GOOD(), lead_md: "Franchise {{f.c1.franchise}} has twenty left." }, ctx), [CODES.SPELLED_QUANTITY]);
  t.ok(validateCard({ ...GOOD(), lead_md: "Franchise {{f.c1.franchise}} follows the 49ers." }, ctx).ok);
  t.ok(validateCard({ ...GOOD(), lead_md: "One of the franchises, {{f.c1.franchise}}, has {{f.c1.cap_available}}." }, ctx).ok);
});

test("unknown fact, malformed token, bad fact-id shape", () => {
  const ctx = ctxFor([OK1]);
  t.deepEqual(codes({ ...GOOD(), lead_md: "{{f.c1.not_a_fact}} is wrong." }, ctx), [CODES.UNKNOWN_FACT]);
  t.deepEqual(codes({ ...GOOD(), lead_md: "{{f.c9.cap_available}} is wrong." }, ctx), [CODES.UNKNOWN_FACT]);
  t.ok(codes({ ...GOOD(), lead_md: "{{ f.c1.cap_available }} x" }, ctx).includes(CODES.MALFORMED_TOKEN));
  t.ok(codes({ ...GOOD(), lead_md: "{{f.cap_available}} x" }, ctx).includes(CODES.MALFORMED_TOKEN));
  t.ok(codes({ ...GOOD(), facts_used: ["f.c1.cap_available"] }, ctx).includes(CODES.UNKNOWN_FACT));
  t.ok(codes({ ...GOOD(), facts_used: ["c1.nope"] }, ctx).includes(CODES.UNKNOWN_FACT));
  t.ok(codes({ ...GOOD(), blocks: [{ type: "table", fact_ids: ["c1.nope"] }] }, ctx).includes(CODES.UNKNOWN_FACT));
  t.ok(codes({ ...GOOD(), blocks: [{ type: "table", tool_call_ids: ["c7"] }] }, ctx).includes(CODES.UNKNOWN_TOOL_CALL));
  t.ok(codes({ ...GOOD(), follow_ups: ["See {{f.c1.rank}}"] }, ctx).includes(CODES.TOKEN_NOT_ALLOWED_HERE));
  // a fact from a call that is not in this run
  t.ok(codes({ ...GOOD(), conflicts: [{ fact_a: "c1.cap_available", fact_b: "c4.x" }], state: "answer_with_conflict" }, ctx).includes(CODES.UNKNOWN_FACT));
});

test("fake anchor and wrong canon_sha", () => {
  const ctx = ctxFor([OK1]);
  t.deepEqual(codes({ ...GOOD(), cites: [{ anchor: "s9-z9", canon_sha: "194f8df", claim: "x" }] }, ctx), [CODES.FAKE_ANCHOR]);
  t.deepEqual(codes({ ...GOOD(), cites: [{ anchor: "s1-c4", canon_sha: "deadbee", claim: "x" }] }, ctx), [CODES.WRONG_CANON_SHA]);
  t.ok(validateCard({ ...GOOD(), cites: [{ anchor: "s1-c4", canon_sha: SHA, claim: "x" }] }, ctx).ok, "full sha accepted");
  t.ok(codes({ ...GOOD(), cites: [{ anchor: "s1-c4", canon_sha: "194f8df4109cefab2ef7133a0c59d73d7d588955", claim: "x" }] }, ctx).includes(CODES.WRONG_CANON_SHA));
  t.ok(codes({ ...GOOD(), cites: [{ anchor: "../x", canon_sha: "194f8df", claim: "x" }] }, ctx).includes(CODES.FAKE_ANCHOR));
  // no index at all fails closed
  t.ok(codes({ ...GOOD(), cites: [{ anchor: "s1-c4", canon_sha: "194f8df", claim: "x" }] }, { ...ctx, knowledge: {} }).includes(CODES.NO_CANON_INDEX));
  // the CI-built rules.json shape works too
  const real = { canon_sha: SHA, sections: [{ id: "s1", groups: [{ id: "s1-c", rules: [{ anchor: "s1-c4" }] }] }] };
  t.ok(validateCard({ ...GOOD(), cites: [{ anchor: "s1-c4", canon_sha: "194f8df", claim: "x" }] }, { ...ctx, knowledge: { rules: real } }).ok);
  t.ok(codes({ ...GOOD(), cites: [{ anchor: "s1-c5", canon_sha: "194f8df", claim: "x" }] }, { ...ctx, knowledge: { rules: real } }).includes(CODES.FAKE_ANCHOR));
});

test("fact above the caller ceiling is rejected", () => {
  const p2 = env("c1", "cap.position", "ok", { dataClass: "P2", facts: [fact("c1", "cap_available", 12000, "usd")] });
  t.ok(validateCard({ ...GOOD(), lead_md: "Space is {{f.c1.cap_available}}.", facts_used: [] }, ctxFor([p2], { ceiling: "P2" })).ok);
  t.deepEqual(codes({ ...GOOD(), lead_md: "Space is {{f.c1.cap_available}}.", facts_used: [] }, ctxFor([p2], { ceiling: "P0" })), [CODES.OVER_CLASS_FACT]);
  t.deepEqual(codes({ ...GOOD(), lead_md: "Space is {{f.c1.cap_available}}.", facts_used: [] }, ctxFor([p2], { ceiling: "P1" })), [CODES.OVER_CLASS_FACT]);
  // P3 is never allowed, even for a P2 caller
  const p3 = env("c1", "x.y", "ok", { dataClass: "P3", facts: [fact("c1", "cap_available", 1, "usd")] });
  t.ok(codes({ ...GOOD(), lead_md: "Space is {{f.c1.cap_available}}.", facts_used: [] }, ctxFor([p3])).includes(CODES.OVER_CLASS_FACT));
  // a fact with no class on a hand-built map fails closed
  const m = new Map([["c1.cap_available", { id: "c1.cap_available", value: 1, unit: "usd" }]]);
  t.ok(codes({ ...GOOD(), lead_md: "Space is {{f.c1.cap_available}}.", facts_used: [] }, { ...ctxFor([OK1]), facts: m }).includes(CODES.OVER_CLASS_FACT));
  // ctx.facts as a plain object works
  const o = Object.fromEntries(buildFactIndex([OK1]));
  t.ok(validateCard(GOOD(), { ...ctxFor([OK1]), facts: o }).ok);
});

test("tool gaps force a non-answer state and a gaps list that covers them", () => {
  const g = env("c2", "calendar.events", "ok", { gaps: [{ what: "dates conflict", why: "conflict_in_canon", source_needed: "a ruling" }, { what: "late", why: "stale", source_needed: "a refresh" }] });
  const ctx = ctxFor([OK1, g]);
  const asAnswer = codes(GOOD(), ctx);
  t.ok(asAnswer.includes(CODES.STATE_NOT_ALLOWED) && asAnswer.includes(CODES.MISSING_GAP), asAnswer.join());
  t.deepEqual(codes({ ...GOOD(), state: "answer_with_gap" }, ctx).sort(), [CODES.MISSING_GAP, CODES.STATE_NEEDS_FIELD].sort());
  // covers only one reason: still missing the other
  const half = { ...GOOD(), state: "answer_with_gap", gaps: [{ what: "dates conflict", why: "conflict_in_canon", source_needed: "a ruling" }] };
  t.deepEqual(codes(half, ctx), [CODES.MISSING_GAP]);
  const full = { ...half, gaps: [...half.gaps, { what: "data is late", why: "stale", source_needed: "a refresh" }] };
  t.ok(validateCard(full, ctx).ok);
  // answer_with_caveat is not "answer"; allowed once the gaps are listed
  t.ok(validateCard({ ...full, state: "answer_with_caveat" }, ctx).ok);
  // no tool gaps: a plain answer may not list gaps
  t.deepEqual(codes({ ...GOOD(), gaps: [{ what: "x", why: "NO_RECORD" }] }, ctxFor([OK1])), [CODES.GAPS_ON_PLAIN_ANSWER]);
  // answer_with_gap / partial need gaps even with clean tools
  t.deepEqual(codes({ ...GOOD(), state: "partial" }, ctxFor([OK1])), [CODES.STATE_NEEDS_FIELD]);
});

test("a non-ok status forces a non-answer state with gaps", () => {
  const nr = env("c2", "rules.search", "no_record");
  const ctx = ctxFor([OK1, nr]);
  const c = codes(GOOD(), ctx);
  t.ok(c.includes(CODES.STATE_NOT_ALLOWED) && c.includes(CODES.MISSING_GAP));
  t.ok(validateCard({ ...GOOD(), state: "partial", gaps: [{ what: "no rule found", why: "NO_RECORD", source_needed: "canon text" }] }, ctx).ok);
  // the model's own malformed attempts (unknown tool, bad arguments) are noise, not missing data
  const noise = [env("c2", "x.nope", "forbidden", { error: { code: "unknown_tool" } }), env("c3", "cap.position", "error", { error: { code: "bad_arguments" } })];
  t.ok(validateCard(GOOD(), ctxFor([OK1, ...noise])).ok);
  // a real tool error is not noise
  t.ok(codes(GOOD(), ctxFor([OK1, env("c2", "cap.position", "error", { error: { code: "tool_exception" } })])).includes(CODES.STATE_NOT_ALLOWED));
});

test("answer after unsupported_as_of on a past date is rejected", () => {
  const u = env("c2", "cap.position", "unsupported_as_of", { gaps: [{ what: "current only", why: "unsupported_as_of", source_needed: "a dated record" }] });
  const ctx = ctxFor([OK1, u], { asOf: "2024-01-01" });
  const c = codes(GOOD(), ctx);
  t.ok(c.includes(CODES.AS_OF_UNSUPPORTED_ANSWER), c.join());
  const ok = { ...GOOD(), state: "answer_with_gap", gaps: [{ what: "that date cannot be checked", why: "unsupported_as_of", source_needed: "a dated record" }] };
  t.ok(validateCard(ok, ctx).ok);
  // a future or current as_of does not trigger the past-date rule on its own (rule 5 still does)
  t.ok(!codes(GOOD(), ctxFor([OK1, u], { asOf: "current" })).includes(CODES.AS_OF_UNSUPPORTED_ANSWER));
});

test("a fact from a refused, no-record or error tool cannot back an answer", () => {
  for (const status of ["refused", "no_record", "error"]) {
    const bad = env("c2", "cap.penalty_quote", status, { refusal: status === "refused" ? { code: "incomplete_contract_data", reason: "x" } : null });
    const card = { state: "partial", lead_md: "The quote is {{f.c2.penalty}}.", facts_used: ["c2.penalty"], gaps: [{ what: "no quote", why: "NO_RECORD", source_needed: "contract data" }] };
    t.ok(codes(card, ctxFor([OK1, bad])).includes(CODES.FACT_FROM_REFUSED_TOOL), status);
  }
  // even if a facts map smuggles a fact onto a non-ok envelope, it is refused
  const sneaky = { ...env("c2", "cap.penalty_quote", "refused"), facts: [fact("c2", "penalty", 5000, "usd")] };
  t.ok(codes({ state: "partial", lead_md: "It is {{f.c2.penalty}}.", gaps: [{ what: "x", why: "NO_RECORD" }] }, ctxFor([OK1, sneaky])).includes(CODES.FACT_FROM_REFUSED_TOOL));
});

test("states that carry no facts have none", () => {
  const ctx = ctxFor([OK1, env("c2", "rules.search", "no_record")]);
  for (const state of ["abstain", "refuse_privacy", "refuse_fairness", "out_of_scope"]) {
    t.deepEqual(codes({ state, lead_md: "Franchise {{f.c1.franchise}} cannot be said.", facts_used: ["c1.franchise"], gaps: [{ what: "x", why: "NO_RECORD" }] }, ctx), [CODES.FACTS_IN_NO_FACT_STATE], state);
  }
  t.deepEqual(codes({ state: "abstain", lead_md: "Nothing on record.", facts_used: ["c1.rank"], gaps: [{ what: "x", why: "NO_RECORD" }] }, ctx), [CODES.FACTS_IN_NO_FACT_STATE]);
  t.ok(validateCard({ state: "abstain", lead_md: "Nothing on record can settle this.", gaps: [{ what: "no record", why: "NO_RECORD", source_needed: "archive" }] }, ctx).ok);
  t.deepEqual(codes({ state: "cite_and_abstain", lead_md: "The rule is cited; the facts cannot be settled." }, ctx).sort(), [CODES.MISSING_GAP, CODES.STATE_NEEDS_FIELD].sort());
  t.ok(validateCard({ state: "cite_and_abstain", lead_md: "The rule is cited; the facts cannot be settled.", cites: [{ anchor: "s1-c4", canon_sha: "194f8df", claim: "x" }], gaps: [{ what: "no record", why: "NO_RECORD" }] }, ctx).ok);
});

test("an answer needs an ok tool result in this run", () => {
  t.deepEqual(codes({ state: "answer", lead_md: "It is fine." }, ctxFor([])), [CODES.NO_OK_TOOL]);
  t.ok(validateCard({ state: "abstain", lead_md: "Cannot say without a record.", gaps: [] }, ctxFor([])).ok);
  t.ok(validateCard({ state: "out_of_scope", lead_md: "The desk only reads league records." }, ctxFor([])).ok);
});

test("the model may not choose code-owned states", () => {
  const ctx = ctxFor([OK1]);
  for (const state of ["tool_failure", "stale_data", "budget_exceeded", "ignore_injection"]) {
    t.deepEqual(codes({ state, lead_md: "Nothing to show." }, ctx), [CODES.STATE_NOT_ALLOWED], state);
  }
  t.deepEqual(codes({ state: "yes", lead_md: "Nothing to show." }, ctx), [CODES.STATE_NOT_ALLOWED]);
  t.ok(codes({ lead_md: "x" }, ctx).includes(CODES.MISSING_FIELD));
});

test("unknown extra keys are rejected at every level", () => {
  const ctx = ctxFor([OK1]);
  t.deepEqual(codes({ ...GOOD(), notes: ["x"] }, ctx), [CODES.UNKNOWN_KEY]);
  t.deepEqual(codes({ ...GOOD(), facts: {} }, ctx), [CODES.UNKNOWN_KEY]);
  t.deepEqual(codes({ ...GOOD(), header: {} }, ctx), [CODES.UNKNOWN_KEY]);
  t.ok(codes({ ...GOOD(), blocks: [{ type: "table", html: "<b>x</b>" }] }, ctx).includes(CODES.UNKNOWN_KEY));
  t.ok(codes({ ...GOOD(), cites: [{ anchor: "s1-c4", canon_sha: "194f8df", claim: "x", url: "y" }] }, ctx).includes(CODES.UNKNOWN_KEY));
  t.ok(codes({ ...GOOD(), gaps: [{ what: "x", why: "NO_RECORD", extra: 1 }], state: "answer_with_gap" }, ctx).includes(CODES.UNKNOWN_KEY));
  t.ok(codes({ ...GOOD(), conflicts: [{ fact_a: "c1.rank", fact_b: "c1.franchise", note: "x", z: 1 }], state: "answer_with_conflict" }, ctx).includes(CODES.UNKNOWN_KEY));
  t.ok(codes("a string", ctx).includes(CODES.BAD_SHAPE));
  t.ok(codes(null, ctx).includes(CODES.BAD_SHAPE));
  t.ok(codes([], ctx).includes(CODES.BAD_SHAPE));
});

test("oversize fields are rejected", () => {
  const ctx = ctxFor([OK1]);
  t.ok(codes({ ...GOOD(), lead_md: "x".repeat(LIMITS.lead_md + 1) }, ctx).includes(CODES.OVERSIZE));
  t.ok(codes({ ...GOOD(), blocks: Array.from({ length: LIMITS.blocks + 1 }, () => ({ type: "table" })) }, ctx).includes(CODES.OVERSIZE));
  t.ok(codes({ ...GOOD(), blocks: [{ type: "table", title: "x".repeat(LIMITS.block_title + 1) }] }, ctx).includes(CODES.OVERSIZE));
  t.ok(codes({ ...GOOD(), blocks: [{ type: "table", rows: Array.from({ length: LIMITS.rows + 1 }, () => ["a"]) }] }, ctx).includes(CODES.OVERSIZE));
  t.ok(codes({ ...GOOD(), blocks: [{ type: "table", rows: [["x".repeat(LIMITS.cell + 1)]] }] }, ctx).includes(CODES.OVERSIZE));
  t.ok(codes({ ...GOOD(), blocks: [{ type: "table", rows: [Array.from({ length: LIMITS.cells + 1 }, () => "a")] }] }, ctx).includes(CODES.OVERSIZE));
  t.ok(codes({ ...GOOD(), follow_ups: Array.from({ length: LIMITS.follow_ups + 1 }, () => "Ask") }, ctx).includes(CODES.OVERSIZE));
  t.ok(codes({ ...GOOD(), follow_ups: ["x".repeat(LIMITS.follow_up + 1)] }, ctx).includes(CODES.OVERSIZE));
  t.ok(codes({ ...GOOD(), ruling_question: "x".repeat(LIMITS.ruling_question + 1) }, ctx).includes(CODES.OVERSIZE));
  t.ok(codes({ ...GOOD(), cites: Array.from({ length: LIMITS.cites + 1 }, () => ({ anchor: "s1-c4", canon_sha: "194f8df" })) }, ctx).includes(CODES.OVERSIZE));
  t.ok(codes({ ...GOOD(), facts_used: Array.from({ length: LIMITS.facts_used + 1 }, () => "c1.rank") }, ctx).includes(CODES.OVERSIZE));
  t.ok(codes({ ...GOOD(), gaps: Array.from({ length: LIMITS.gaps + 1 }, () => ({ what: "x", why: "NO_RECORD" })), state: "answer_with_gap" }, ctx).includes(CODES.OVERSIZE));
});

test("table rows carry facts by token, never typed values", () => {
  const ctx = ctxFor([OK1]);
  t.ok(validateCard({ ...GOOD(), blocks: [{ type: "table", columns: ["Franchise", "Space"], rows: [["{{f.c1.franchise}}", "{{f.c1.cap_available}}"]] }] }, ctx).ok);
  t.ok(codes({ ...GOOD(), blocks: [{ type: "table", rows: [[12000]] }] }, ctx).includes(CODES.ROW_CELL));
  t.ok(codes({ ...GOOD(), blocks: [{ type: "table", rows: [[null]] }] }, ctx).includes(CODES.ROW_CELL));
  t.ok(codes({ ...GOOD(), blocks: [{ type: "table", rows: [{ a: 1 }] }] }, ctx).includes(CODES.ROW_CELL));
  t.ok(codes({ ...GOOD(), blocks: [{ type: "table", rows: [["$12K"]] }] }, ctx).includes(CODES.DIGIT_IN_PROSE));
  t.ok(codes({ ...GOOD(), blocks: [{ type: "table", rows: [["{{f.c1.nope}}"]] }] }, ctx).includes(CODES.UNKNOWN_FACT));
  t.ok(codes({ ...GOOD(), blocks: [{ type: "grid" }] }, ctx).includes(CODES.BAD_SHAPE));
});

test("markup, links and invisible characters are rejected", () => {
  const ctx = ctxFor([OK1]);
  for (const lead of ["See <b>this</b> for {{f.c1.rank}}", "Go to https://evil.example/x", "A [link](javascript:alert) here", "Hidden\u200btext here", "Ctl\u0007char here"]) {
    t.ok(codes({ ...GOOD(), lead_md: lead }, ctx).includes(CODES.UNSAFE_MARKUP), lead);
  }
});

test("a gap reason must be in GAP_REASONS and what/source_needed are prose-checked", () => {
  const ctx = ctxFor([OK1]);
  t.ok(codes({ ...GOOD(), state: "answer_with_gap", gaps: [{ what: "x", why: "because" }] }, ctx).includes(CODES.BAD_SHAPE));
  t.ok(codes({ ...GOOD(), state: "answer_with_gap", gaps: [{ what: "x", why: "NO_RECORD", source_needed: "the 2015 file" }] }, ctx).includes(CODES.DIGIT_IN_PROSE));
});

await run("ai_desk_validator");
