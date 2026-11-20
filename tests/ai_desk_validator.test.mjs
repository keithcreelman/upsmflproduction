// Commissioner Desk: validator tests. Offline and deterministic. Run: node tests/ai_desk_validator.test.mjs
import { test, run, t } from "./fixtures/mini_test.mjs";
import { validateCard, findSpelledQuantities, errorCodes, buildFactIndex, canonShaMatches, collectToolGaps, LIMITS, CODES } from "../worker/src/desk/validator.js";

const SHA = "194f8df4109cefab2ef7133a0c59d73d7d588954";
const RULES = { canon_sha: SHA, anchors: ["s1-c4", "s2-t6-1"] };

function fact(callId, key, value, unit, grade = "A") { return { id: `${callId}.${key}`, label: key, value, unit, as_of: "current", source: "stub", grade }; }
function env(callId, tool, status, o = {}) {
  return { tool, call_id: callId, status, data: null, facts: o.facts || [], coverage: { supported: status === "ok", gaps: o.gaps || [] }, provenance: {}, data_class: o.dataClass || "P0", freshness: null, refusal: o.refusal || null, error: o.error || null };
}
const OK1 = env("c1", "cap.position", "ok", { facts: [fact("c1", "cap_available", 12000, "usd"), fact("c1", "franchise", "0003", "id"), fact("c1", "rank", 4, "rank")] });
const ctxFor = (envelopes, o = {}) => ({ envelopes, knowledge: { rules: RULES }, retrievedAnchors: ["s1-c4", "s2-t6-1"], ceiling: "P2", asOf: "current", today: "2026-11-19", ...o });
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

test("a valid anchor that was never retrieved this run is rejected (retrieval binding)", () => {
  const cite = [{ anchor: "s2-t6-1", canon_sha: "194f8df", claim: "A rule." }];
  const ok = validateCard({ ...GOOD(), cites: cite }, ctxFor([OK1]));
  t.ok(ok.ok, JSON.stringify(ok.errors));
  // real anchor, in the index, but not returned by rules.search / rules.get this run
  t.deepEqual(codes({ ...GOOD(), cites: cite }, ctxFor([OK1], { retrievedAnchors: ["s1-c4"] })), [CODES.UNRETRIEVED_ANCHOR]);
  t.deepEqual(codes({ ...GOOD(), cites: cite }, ctxFor([OK1], { retrievedAnchors: undefined })), [CODES.UNRETRIEVED_ANCHOR], "absent means none retrieved");
  t.deepEqual(codes({ ...GOOD(), cites: cite }, ctxFor([OK1], { retrievedAnchors: [] })), [CODES.UNRETRIEVED_ANCHOR]);
  // Set, Map and object forms all work
  t.ok(validateCard({ ...GOOD(), cites: cite }, ctxFor([OK1], { retrievedAnchors: new Set(["s2-t6-1"]) })).ok);
  t.ok(validateCard({ ...GOOD(), cites: cite }, ctxFor([OK1], { retrievedAnchors: new Map([["s2-t6-1", {}]]) })).ok);
  t.ok(validateCard({ ...GOOD(), cites: cite }, ctxFor([OK1], { retrievedAnchors: { "s2-t6-1": 1 } })).ok);
  // a fake anchor is reported as fake, not as unretrieved
  t.deepEqual(codes({ ...GOOD(), cites: [{ anchor: "s9-z9", canon_sha: "194f8df" }] }, ctxFor([OK1], { retrievedAnchors: [] })), [CODES.FAKE_ANCHOR]);
});

test("a fact whose as_of is current never answers a past-date question", () => {
  const cur = env("c1", "cap.position", "ok", { facts: [{ ...fact("c1", "cap_available", 12000, "usd"), as_of: "current" }] });
  const past = env("c1", "cap.position", "ok", { facts: [{ ...fact("c1", "cap_available", 12000, "usd"), as_of: "2023-10-01" }] });
  const card = { state: "answer", lead_md: "Space was {{f.c1.cap_available}}." };
  t.deepEqual(codes(card, ctxFor([cur], { asOf: "2023-10-01" })), [CODES.CURRENT_FACT_FOR_PAST_DATE]);
  t.ok(validateCard(card, ctxFor([past], { asOf: "2023-10-01" })).ok);
  t.ok(validateCard(card, ctxFor([cur], { asOf: "current" })).ok, "a current question may use current facts");
  t.ok(codes({ state: "answer_with_caveat", lead_md: "Space was {{f.c1.cap_available}}." }, ctxFor([cur], { asOf: "2023-10-01" })).includes(CODES.CURRENT_FACT_FOR_PAST_DATE));
  // a multi-date comparison (ctx.forbidCurrent): the effective as_of stays "current", but a fact dated current is still rejected
  t.deepEqual(codes(card, ctxFor([cur], { asOf: "current", forbidCurrent: true })), [CODES.CURRENT_FACT_FOR_PAST_DATE]);
  t.ok(validateCard(card, ctxFor([past], { asOf: "current", forbidCurrent: true })).ok);
  // the loop's own refusal of a current call (as_of_required) is noise, not missing data
  const refused = env("c2", "cap.position", "error", { error: { code: "as_of_required" } });
  t.ok(validateCard(card, ctxFor([past, refused], { asOf: "current", forbidCurrent: true })).ok);
});

test("a league term the glossary returned this run may be written as spelled, digits and all", () => {
  const ctx = (terms) => ctxFor([OK1], { allowedTerms: terms });
  const card = (lead) => ({ ...GOOD(), lead_md: lead });
  t.ok(validateCard(card("Ext1 is a contract status for {{f.c1.franchise}}."), ctx(["Ext1"])).ok);
  t.ok(validateCard(card("Both Ext1 and Vet-Ext2 are statuses ({{f.c1.rank}})."), ctx(["Ext1", "Vet-Ext2"])).ok);
  t.ok(validateCard(card("A FL/BL suffix applies, as in Vet-FAA-BL2 ({{f.c1.rank}})."), ctx(["Vet-FAA-BL2", "FL/BL"])).ok);
  // not returned by the tool: rejected; a digit outside the term: rejected; a longer word that contains the term: rejected
  t.deepEqual(codes(card("Ext2 is a contract status for {{f.c1.franchise}}."), ctx(["Ext1"])), [CODES.DIGIT_IN_PROSE]);
  t.deepEqual(codes(card("Ext1 adds 1 year for {{f.c1.franchise}}."), ctx(["Ext1"])), [CODES.DIGIT_IN_PROSE]);
  t.deepEqual(codes(card("Ext10 is a status for {{f.c1.franchise}}."), ctx(["Ext1"])), [CODES.DIGIT_IN_PROSE]);
  t.deepEqual(codes(card("Ext1 is a status for {{f.c1.franchise}}."), ctx([])), [CODES.DIGIT_IN_PROSE]);
  // a term cannot hide a spelled quantity next to it, and digit-only or oversized terms are ignored
  t.ok(codes(card("Ext1 twice for {{f.c1.franchise}}."), ctx(["Ext1"])).includes(CODES.SPELLED_QUANTITY));
  t.ok(codes(card("It is 2025 for {{f.c1.franchise}}."), ctx(["2025", "x".repeat(60) + "1"])).includes(CODES.DIGIT_IN_PROSE));
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

test("tool gaps force a non-answer state; code adds them to the card", () => {
  const g = env("c2", "calendar.events", "ok", { gaps: [{ what: "dates conflict", why: "conflict_in_canon", source_needed: "a ruling" }, { what: "late", why: "stale", source_needed: "a refresh" }] });
  const ctx = ctxFor([OK1, g]);
  t.deepEqual(codes(GOOD(), ctx), [CODES.STATE_NOT_ALLOWED]);
  // the model need not list tool gaps: code supplies them, so a gap state with no model gaps is valid
  t.ok(validateCard({ ...GOOD(), state: "answer_with_gap" }, ctx).ok);
  t.ok(validateCard({ ...GOOD(), state: "partial" }, ctx).ok);
  t.ok(validateCard({ ...GOOD(), state: "answer_with_caveat" }, ctx).ok);
  // no tool gaps: a plain answer may not list gaps
  t.deepEqual(codes({ ...GOOD(), gaps: [{ what: "x", why: "NO_RECORD" }] }, ctxFor([OK1])), [CODES.GAPS_ON_PLAIN_ANSWER]);
  // answer_with_gap / partial need gaps even with clean tools
  t.deepEqual(codes({ ...GOOD(), state: "partial" }, ctxFor([OK1])), [CODES.STATE_NEEDS_FIELD]);
});

test("gap text with digits: an exact copy of a tool gap is code-sourced and allowed; any other model gap keeps the no-digits rule", () => {
  const tg = { what: "Domain not covered before League Record slice S1", why: "partial_coverage", source_needed: "League Record slice S1" };
  const g = env("c2", "coverage.check", "ok", { gaps: [tg] });
  const ctx = ctxFor([OK1, g]);
  // copied verbatim (digits and all): accepted, and dropped from the model's own list (code carries the tool's entry)
  const v = validateCard({ ...GOOD(), state: "answer_with_gap", gaps: [tg] }, ctx);
  t.ok(v.ok, JSON.stringify(v.errors));
  t.deepEqual(v.cleaned.gaps, []);
  t.deepEqual(collectToolGaps([OK1, g]).map(({ what, why, source_needed }) => ({ what, why, source_needed })), [tg]);
  // whitespace around a verbatim copy does not matter; a changed word or a missing source_needed is not an exact copy
  t.ok(validateCard({ ...GOOD(), state: "answer_with_gap", gaps: [{ ...tg, what: `  ${tg.what} ` }] }, ctx).ok);
  t.ok(codes({ ...GOOD(), state: "answer_with_gap", gaps: [{ ...tg, what: "Domain not covered before League Record slice S2" }] }, ctx).includes(CODES.DIGIT_IN_PROSE));
  t.ok(codes({ ...GOOD(), state: "answer_with_gap", gaps: [{ what: tg.what, why: tg.why }] }, ctx).includes(CODES.DIGIT_IN_PROSE));
  t.ok(codes({ ...GOOD(), state: "answer_with_gap", gaps: [{ ...tg, why: "stale" }] }, ctx).includes(CODES.DIGIT_IN_PROSE));
  // a model gap of its own stays held to the rule, and is kept next to the tool gap
  t.ok(codes({ ...GOOD(), state: "answer_with_gap", gaps: [{ what: "missing since 2015", why: "NO_RECORD" }] }, ctx).includes(CODES.DIGIT_IN_PROSE));
  const own = validateCard({ ...GOOD(), state: "answer_with_gap", gaps: [tg, { what: "an older season is missing", why: "NO_RECORD", source_needed: "the archive" }] }, ctx);
  t.ok(own.ok);
  t.deepEqual(own.cleaned.gaps.map((x) => x.why), ["NO_RECORD"]);
  // a tool gap from a noise envelope (the model's own bad call) is not a real gap
  const noise = env("c3", "x.nope", "forbidden", { error: { code: "unknown_tool" }, gaps: [tg] });
  t.deepEqual(collectToolGaps([noise]), []);
  // a non-ok tool with no gap of its own still needs the model to say what is missing
  t.ok(codes({ ...GOOD(), state: "partial" }, ctxFor([OK1, env("c3", "x.y", "error", { error: { code: "tool_exception" } })])).includes(CODES.MISSING_GAP));
});

test("every real anchor is well formed and can be cited when retrieved", async () => {
  const fs = await import("node:fs");
  const { buildKnowledge } = await import("../worker/src/desk/knowledge.js");
  const rulesJson = JSON.parse(fs.readFileSync(new URL("../site/m/data/rules.json", import.meta.url), "utf8"));
  const K = buildKnowledge({ rulesJson, leagueId: "74598", currentSeason: 2026 });
  const all = K.rules.anchors;
  t.ok(all.length >= 100, `real index has ${all.length} anchors`);
  const longest = Math.max(...all.map((a) => a.length));
  t.ok(longest > 60, "the real index has anchors longer than the old 60-character limit");
  t.ok(LIMITS.anchor >= longest + 30 && LIMITS.anchor <= 160, `limit ${LIMITS.anchor} covers the longest (${longest}) with headroom`);
  const ctx = { envelopes: [OK1], knowledge: { rules: K.rules }, retrievedAnchors: all, ceiling: "P2", asOf: "current", today: "2026-11-19" };
  let bad = 0;
  for (const a of all) {
    const v = validateCard({ ...GOOD(), cites: [{ anchor: a, canon_sha: K.rules.canon_sha.slice(0, 7), claim: "A rule." }] }, ctx);
    if (!v.ok) { bad += 1; if (bad < 4) console.log("rejected", a, JSON.stringify(v.errors)); }
  }
  t.equal(bad, 0, "every real anchor can be cited when retrieved");
  // the same anchors are UNRETRIEVED when the run did not return them, never FAKE
  const long = all.find((a) => a.length === longest);
  t.deepEqual(codes({ ...GOOD(), cites: [{ anchor: long, canon_sha: "194f8df" }] }, { ...ctx, retrievedAnchors: [] }), [CODES.UNRETRIEVED_ANCHOR]);
  // an over-long or malformed anchor is still rejected
  t.deepEqual(codes({ ...GOOD(), cites: [{ anchor: "a".repeat(161), canon_sha: "194f8df" }] }, ctx), [CODES.FAKE_ANCHOR]);
  t.deepEqual(codes({ ...GOOD(), cites: [{ anchor: "a b", canon_sha: "194f8df" }] }, ctx), [CODES.FAKE_ANCHOR]);
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
  const dated = env("c1", "history.finishes", "ok", { facts: ["cap_available", "franchise"].map((k) => ({ ...fact("c1", k, 1, "id"), as_of: "2024-01-01" })) });
  t.ok(validateCard(ok, ctxFor([dated, u], { asOf: "2024-01-01" })).ok);
  t.ok(codes(ok, ctx).includes(CODES.CURRENT_FACT_FOR_PAST_DATE), "today's facts cannot answer a past date");
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
