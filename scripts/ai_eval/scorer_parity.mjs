// Commissioner Desk eval: a PARITY CHECK between the production validator and the FROZEN scorer on "a number typed into prose". Free, offline, read-only.
//   node scripts/ai_eval/scorer_parity.mjs
//
// The scorer (score.mjs, hash in SCORER_SHA256) is frozen so a result cannot be re-graded after it is seen, and it keeps its own copy of the glossary-term matcher and its own
// ASCII-only digit test. The validator is the production rule. They can disagree. This script does NOT change the scorer: it feeds the same strings to both, prints the
// disagreements, and says what a person must adjudicate. A disagreement where the VALIDATOR ACCEPTED a card and the scorer flags `wrong_number` is a false alarm to be
// overruled by a human reading the card (the R3 pattern). A disagreement where the validator REJECTS and the scorer passes cannot reach a card (the validator runs first) but is
// reported so nobody trusts the scorer alone for it.
import { scoreCase } from "./score.mjs";
import { termRegex, hasDigitOutsideTokens } from "../../worker/src/desk/validator.js";

// A minimal bank-shaped case: an answerable question with no required numbers, so only the typed-digit check can differ.
const CASE = { id: "PARITY-1", category: "RUL", caller_class: "commish", p1_expected: "cite", must_include: [], must_not: [], required_cites: [], expected_answer: {} };
const cardWith = (lead) => ({ state: "answer", lead_md: lead, facts: {}, facts_used: [], cites: [], gaps: [], blocks: [], conflicts: [], follow_ups: [], tool_gaps: [], refusals: [], notes: [], header: {}, footer: {} });

export const SAMPLES = Object.freeze([
  "Yes. The rule names Ext1 as a contract type.", "EXT1 is written in capitals.", "ext1 is lower case.", "Vet-Ext1 is the status token.", "Ext2 was never looked up.",
  "The 49ers and the 76ers are proper nouns.", "A digit like ١ is not ASCII.", "Fullwidth ３ too.", "A fraction ½.", "Plain 7 typed.", "Room is {{f.c1.cap_available}}.", "No digits at all.",
]);

// terms: what glossary.lookup returned this run (the validator's allowedTerms); the scorer gets the same list through ctx.allowedTerms.
export function compare(terms) {
  const re = termRegex(terms);
  const rows = [];
  for (const lead of SAMPLES) {
    const validatorSaysTyped = hasDigitOutsideTokens(lead, re);
    const res = scoreCase(CASE, cardWith(lead), { allowedTerms: terms, rules: { byAnchor: {}, canon_sha: "0000000" } }, {});
    const scorerSaysTyped = res.flags.wrong_number === true && Array.isArray(res.reasons) && res.reasons.includes("no_typed_digits");
    rows.push({ lead, validatorSaysTyped, scorerSaysTyped, agree: validatorSaysTyped === scorerSaysTyped,
      adjudicate: validatorSaysTyped === scorerSaysTyped ? null : scorerSaysTyped ? "scorer flags a number the validator accepted: a person must read the card and overrule a false alarm" : "scorer passes a digit the validator rejects: the validator already stopped it before a card existed" });
  }
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const terms of [["Vet-Ext1", "ext1", "rookie-ext1", "ext 1"], []]) {
    console.log(`\nglossary terms returned this run: ${JSON.stringify(terms)}`);
    for (const r of compare(terms)) console.log(`${r.agree ? "same " : "DIFF "} validator typed=${String(r.validatorSaysTyped).padEnd(5)} scorer typed=${String(r.scorerSaysTyped).padEnd(5)} | ${JSON.stringify(r.lead)}${r.adjudicate ? `\n       -> ${r.adjudicate}` : ""}`);
  }
  console.log("\nThe scorer is unchanged. Adjudicate every DIFF in a real run by reading the card.");
}
