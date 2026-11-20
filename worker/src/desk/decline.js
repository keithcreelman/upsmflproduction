// Commissioner Desk: the deterministic "no record" decline (Phase 1 closeout, R4 DEV-UNA-08).
//
// When the only evidence a run gathered is a coverage.check answer saying the desk has NO record for the season the run is about, there is nothing for a model to
// compose: every word of the answer is already known (what is missing, why, and which League Record slice would close it). The model's attempts at such cards
// failed in R4 for reasons unrelated to quality (a fact token on an abstain card, a pronoun the number rule rejected) and cost a composer call and a retry each.
// This module decides, in code, whether a run qualifies; the pipeline then builds the card with composer.noRecordCard. No model text can reach it.
//
// A run qualifies only when ALL of these hold (each one closes a way for a wrong decline to hide an answerable question):
//  1. the run is not a multi-date comparison;
//  2. every real (non-noise) tool result is a coverage.check answer for ONE named domain (never "all");
//  3. each of them says level "none" with reason NO_RECORD or unsupported_as_of (never "stale", never "partial");
//  4. each checked the season the CODE derived for this run (the model chooses the coverage call's season; a wrong choice must not produce a decline),
//     and the season is the one in effect: the as_of year, or the current season when the run is "current";
//  5. at least one gap names the source that would close it;
//  6c. (R18 review) the question has the SHAPE of a plain question about that domain: a short template per domain (below), not a blacklist of connectives. A blacklist can always
//     miss a second clause ("as well as", a second sentence, a slash); a template cannot match one. A question that fits no template goes to the composer, which is exactly what
//     every decline did before this closeout.
//  6b. (R17 review) the question is ONE clause: no comma, semicolon, colon, conjunction or second question mark, and at most 20 words. The keyword net cannot see a clause it has
//     no word for ("which team lifted the trophy"), so a multi-part question can never be shown to be fully covered by a no-record answer; it goes to the composer.
//  6. (R15 review) the domain the model checked is one the QUESTION TEXT is about: the words of the question, read in code (tool_select.keywordDomains), must fit the
//     checked domain. A model that checked the wrong domain (rules by date for a question about the champion) must not turn an answerable question into a decline.
// Anything else goes to the composer exactly as before. The authorization, input and budget gates ran before this point and are unchanged.
import { collectToolGaps } from "./validator.js";
import { keywordDomains } from "./tool_select.js";

const DECLINE_REASONS = new Set(["NO_RECORD", "unsupported_as_of"]);

// Which question-text domains (tool_select.KEYWORD_DOMAINS) each coverage domain may serve. A year or a "when" word alone puts a question into the GENERIC domains, which
// say nothing about WHAT was asked, so they never bind and never object. SPECIFIC question domains (cap, contracts, trades, picks, roster, players) must each be served by
// one of the domains the run checked, and every checked domain must be served by at least one domain the question names. A coverage domain that is not listed here (rules by
// date, forum history, anything new) never produces a code-built decline: the composer handles it as before.
// Only calendar and freshness words are context rather than a clause. A bare year or date is removed from the question before its words are read (it names WHEN, not WHAT), but a
// history or standings WORD ("champion", "won", "title", "since") is a clause the desk can answer, so a checked domain must serve it (R16 review: "who was the 2013 champion, and
// who was the owner of that team?" checked only against owner history must not be declined whole).
const GENERIC = new Set(["calendar", "data_freshness"]);
export const MAX_DECLINE_WORDS = 20;
// Anything that can join a second clause or a second request: punctuation, a newline, a slash, an ampersand, a connective or a "what about". Checked first, on the whole question.
const MULTI_CLAUSE_RE = /[,;:]|[\/&\n\r]|\b(?:and|or|also|then|but|plus|while|because|with|without|within|versus|vs|including|except|as\s+well|along|what\s+about|how\s+about|else|too|both|each|every|all)\b|\?[^?]*\?|[.!?]\s*\S/i;
export function isSingleClause(question) {
  const q = String(question || "").trim();
  if (!q || MULTI_CLAUSE_RE.test(q)) return false;
  return q.split(/\s+/).filter(Boolean).length <= MAX_DECLINE_WORDS;
}
// One plain template per coverage domain: a FULLY ENUMERATED sentence shape, not "starts like a title question". Free text is allowed in exactly one place, a person's name
// (one to four capitalized words), so nothing else can ride along ("Who won the 2026 UPS title when is kickoff?" fits no template: R19 review). Applied after the trailing
// punctuation is removed. A question that fits none goes to the composer.
const YEAR = "(?:19|20)\\d{2}";
const NAME = "[A-Z][\\p{L}'\u2019.\\-]*(?: [A-Z][\\p{L}'\u2019.\\-]*){0,3}";
const TITLE_WORD = "(?:title|championship|champion|champions)";
export const DOMAIN_TEMPLATES = Object.freeze({
  // "Who won the 2009 UPS title" / "Who was the champion in 2013" / "Which franchise won the 2013 championship"
  finishes: [
    new RegExp(`^(?:Who|Which (?:franchise|team)) (?:won|was) the (?:${YEAR} )?(?:UPS )?(?:league )?${TITLE_WORD}(?: (?:in|for|of) (?:the )?${YEAR}(?: season)?)?$`, "iu"),
  ],
  // "Trace the 2013 pick that became Markus Wheaton"
  pick_lineage: [
    new RegExp(`^(?:Trace|Follow) the (?:${YEAR} )?(?:[Rr]ound \\d )?pick that (?:became|turned into) ${NAME}$`, "u"),
  ],
  // "What was Davante Adams's salary in Week 1 of 2013"
  contract_timeline: [
    new RegExp(`^What (?:was|is) ${NAME}['\u2019]s (?:salary|contract) (?:in|during|for) (?:[Ww]eek \\d{1,2} of )?(?:the )?${YEAR}(?: season)?$`, "u"),
  ],
});
export function fitsTemplate(domain, question) {
  const list = DOMAIN_TEMPLATES[domain];
  if (!list) return false;
  const q = String(question || "").trim().replace(/[.?!]+$/, "");
  return list.some((re) => re.test(q));
}
const stripYears = (q) => String(q).replace(/\b(?:19|20)\d{2}(?:-\d{2}-\d{2})?\b/g, " ");
export const DOMAIN_BINDING = Object.freeze({
  finishes: Object.freeze({ any: ["history", "standings"], specific: ["history", "standings"] }),
  pick_lineage: Object.freeze({ any: ["picks", "trades"], specific: ["picks", "trades"] }),
  draft_order: Object.freeze({ any: ["picks", "trades"], specific: ["picks", "trades"] }),
  contract_timeline: Object.freeze({ any: ["contracts", "cap"], specific: ["contracts", "cap"] }),
  roster_current: Object.freeze({ any: ["roster", "players", "contracts", "cap"], specific: ["roster", "players", "contracts", "cap"] }),
  player_transactions: Object.freeze({ any: ["players", "roster", "trades"], specific: ["players", "roster", "trades"] }),
  owner_history: Object.freeze({ any: ["roster", "players"], specific: ["roster", "players"] }),
});
const MAX_NOTE = 200;

function isNoise(env) {
  const code = env && env.error && env.error.code;
  return (env.status === "forbidden" && code === "unknown_tool") || (env.status === "error" && (code === "bad_arguments" || code === "as_of_required"));
}

// The season the run is about, from code: the year of the run's binding as_of, or the current season for "current".
export function runSeason(effAsOf, currentSeason) {
  if (effAsOf === "current") return Number.isInteger(currentSeason) ? currentSeason : null;
  const y = Number(String(effAsOf || "").slice(0, 4));
  return Number.isInteger(y) && y > 1000 ? y : null;
}

// -> null (compose as usual) | { gaps, toolGaps, note, domains }
export function findNoRecordDecline(envelopes, { effAsOf, currentSeason, forbidCurrent = false, question } = {}) {
  if (forbidCurrent) return null;
  if (typeof question !== "string" || !question.trim()) return null;      // the binding below needs the question's own words
  if (!isSingleClause(question)) return null;
  const season = runSeason(effAsOf, currentSeason);
  if (season == null) return null;
  const real = (envelopes || []).filter((e) => e && !isNoise(e));
  if (!real.length) return null;
  const notes = [];
  for (const e of real) {
    const d = e.data;
    if (e.tool !== "coverage.check" || e.status !== "ok" || !d || typeof d !== "object") return null;
    if (typeof d.domain !== "string" || !d.domain || d.domain === "all") return null;
    if (d.level !== "none" || !DECLINE_REASONS.has(d.reason)) return null;
    if (d.season !== season) return null;
    if (!Object.prototype.hasOwnProperty.call(DOMAIN_BINDING, d.domain)) return null;
    if (typeof d.note === "string" && d.note.trim() && d.note.length <= MAX_NOTE && !/[<>{}\[\]]|https?:/i.test(d.note) && !notes.includes(d.note.trim())) notes.push(d.note.trim());
  }
  // (R20 review) The year the QUESTION names must be the season that was checked. The run's season can come from the caller's as_of instead, so a 2013 question asked with a
  // 2026 as_of and a 2026 coverage check must not be declined: the 2013 record exists. A question that names no year must be about the run's season.
  const yearsNamed = [...String(question).matchAll(/(?<![\d-])((?:19|20)\d{2})(?![\d-])/g)].map((m) => Number(m[1]));
  if (yearsNamed.some((y) => y !== season)) return null;
  // The binding to the question's words.
  const asked = keywordDomains(stripYears(question));
  const specificAsked = asked.filter((x) => !GENERIC.has(x));
  const domains = real.map((e) => e.data.domain);
  for (const dom of domains) if (!fitsTemplate(dom, question)) return null;
  for (const dom of domains) if (!DOMAIN_BINDING[dom].any.some((x) => asked.includes(x))) return null;
  const served = new Set(domains.flatMap((dom) => DOMAIN_BINDING[dom].specific));
  if (specificAsked.some((x) => !served.has(x))) return null;
  const toolGaps = collectToolGaps(real);
  if (!toolGaps.length || !toolGaps.some((g) => g.source_needed)) return null;
  return {
    gaps: toolGaps.map(({ what, why, source_needed }) => ({ what, why, source_needed })),
    toolGaps,
    note: notes[0] || "",
    domains: real.map((e) => e.data.domain),
  };
}
