// Commissioner Desk eval: the SCRIPTED model. NOT A MODEL RESULT.
//
// A deterministic stand-in for the language model, one script per first-run dev case. It behaves like a careful, well-behaved model so that the
// plumbing around it can be proven for free: the router step, the tool loop with the real tools, the composer, the validator, the server card,
// the budget gate and the ledger. It proves tools, facts and validation, NOT model quality: a real model may phrase, choose and fail differently.
//
// It never hard-codes a fact. Every request it receives is READ:
//   router    the question text
//   loop      the question, the pinned as_of, and the tool results already returned (to pick a rule or stop)
//   composer  the evidence summary the real composer would get: fact ids with display strings, gaps, refusals and retrieved rules
// and the card it emits is built only from the fact ids, rule anchors and canon versions found there.
//
// Interface: the same as tests/fixtures/ai_desk/fake_client.mjs ({ mode: "fake", complete(request) }), so budget.guardedCall treats it as a
// fake-mode client: the SAME gate, caps and ledger code as a live call, in the ledger's separate "fake" lane.
// Token usage in a scripted response is an ESTIMATE (UTF-8 bytes / 2.5, the ratio R1 measured; cache creation and reads are modeled), so fake costs are a rough guide, not a price quote.
import { findSpelledQuantities } from "../../../worker/src/desk/validator.js";
import { createFakeClient } from "../../../tests/fixtures/ai_desk/fake_client.mjs";
import { DeskModelError } from "../../../worker/src/desk/anthropic_client.js";

export const SCRIPTED_LABEL = "SCRIPTED MODEL: this proves tools, facts and validation, not model quality";
export const SCRIPTED_CASE_IDS = Object.freeze(["DEV-RUL-02", "DEV-RUL-10", "DEV-REC-02", "DEV-REC-01", "DEV-NOW-01", "DEV-INJ-05", "DEV-TFL-01", "DEV-LIN-03", "DEV-CON-02", "DEV-UNA-08"]);

// ── Reading what the pipeline sends ────────────────────────────────────────────────────────────────
const blockText = (content) => (typeof content === "string" ? content : (content || []).filter((b) => b && b.type === "text").map((b) => b.text).join("\n"));
const firstUserText = (request) => blockText(((request.messages || []).find((m) => m.role === "user") || {}).content);

// <<<UPS_DATA label attrs>>>\n...\n<<<END_UPS_DATA>>>  ->  the text inside the first block with that label
export function unwrapData(text, label) {
  const re = new RegExp(`<<<UPS_DATA ${label}[^>]*>>>\\n([\\s\\S]*?)\\n<<<END_UPS_DATA>>>`);
  const m = re.exec(String(text || ""));
  return m ? m[1] : null;
}
export function questionOf(request) { return unwrapData(firstUserText(request), "question") || ""; }

// The tool results the loop has returned so far (parsed from the tool_result blocks the model received).
export function toolResultsOf(request) {
  const out = [];
  for (const m of request.messages || []) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (!b || b.type !== "tool_result") continue;
      const inner = unwrapData(blockText(b.content), "tool_result");
      let parsed = null;
      try { parsed = inner ? JSON.parse(inner) : null; } catch (_) { parsed = null; }
      if (parsed) out.push(parsed);
    }
  }
  return out;
}
function roundsDone(request) { return (request.messages || []).filter((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((b) => b && b.type === "tool_result")).length; }
function pinnedAsOf(request) { const m = /Pinned as_of for this question: (\d{4}-\d{2}-\d{2})/.exec(firstUserText(request)); return m ? m[1] : null; }

// The composer's evidence summary (composer.summarizeEvidence) back into data.
export function parseEvidence(request) {
  const text = unwrapData(firstUserText(request), "evidence") || "";
  const ev = { tools: [], facts: [], gaps: [], refusals: [], rules: [], glossary: [], asOf: (/^as_of: (\S+)$/m.exec(firstUserText(request)) || [])[1] || null };
  let section = null;
  for (const line of text.split("\n")) {
    if (/^TOOLS RUN:/.test(line)) { section = "tools"; continue; }
    if (/^FACTS \(/.test(line)) { section = "facts"; continue; }
    if (/^GAPS \(/.test(line)) { section = "gaps"; continue; }
    if (/^REFUSALS AND FAILURES/.test(line)) { section = "refusals"; continue; }
    if (/^RULES RETRIEVED/.test(line)) { section = "rules"; continue; }
    if (/^GLOSSARY \(/.test(line)) { section = "glossary"; continue; }
    // a rule's own text sits on the line after its header: "  text: ..."
    if (section === "rules" && line.startsWith("  text: ") && ev.rules.length) { ev.rules[ev.rules.length - 1].text = line.slice(8); continue; }
    if (!line.startsWith("- ") || line === "- (none)") continue;
    if (section === "tools") { const m = /^- (c\d+) (\S+): (\S+)/.exec(line); if (m) ev.tools.push({ call_id: m[1], tool: m[2], status: m[3] }); }
    else if (section === "facts") {
      const m = /^- id=(\S+) \| (.*) \| display=(.*) \| grade (\S+) \| as_of (\S+)$/.exec(line);
      if (m) ev.facts.push({ id: m[1], label: m[2], display: m[3], grade: m[4], as_of: m[5] });
    } else if (section === "gaps") {
      const m = /^- (c\d+) why=(\S+) \| (.*) \| source_needed: (.*)$/.exec(line);
      if (m) ev.gaps.push({ call_id: m[1], why: m[2], what: m[3], source_needed: m[4] });
    } else if (section === "refusals") {
      const m = /^- (c\d+) (\S+): (\S+)(?: \| (.*))?$/.exec(line);
      if (m) ev.refusals.push({ call_id: m[1], tool: m[2], status: m[3], detail: m[4] || "" });
    } else if (section === "rules") {
      // "- anchor=A canon_sha=S | title | path" (text on the next line) or "- anchor=A canon_sha=S | title (title only)"
      const m = /^- anchor=(\S+) canon_sha=(\S*) \| (.*?)(?: \| (.*))?$/.exec(line);
      if (m) ev.rules.push({ anchor: m[1], canon_sha: m[2], title: m[3].replace(/ \(title only\)$/, ""), path: m[4] || "", text: "" });
    } else if (section === "glossary") {
      // "- TERM (kind)[ [canon is silent...]] | definition | [caveat: ... | ]canon anchors (cite with canon_sha SHA): a, b | [code source: ...]"
      const m = /^- (.+?) \(([a-z_]+)\)(?: \[[^\]]*\])? \| (.*)$/.exec(line);
      if (m) {
        const parts = m[3].split(" | ");
        const anc = parts.find((p) => /^canon anchors \(cite with canon_sha /.test(p));
        const am = anc ? /^canon anchors \(cite with canon_sha (\S+)\): (.*)$/.exec(anc) : null;
        ev.glossary.push({ term: m[1], kind: m[2], definition: parts[0], canon_sha: am ? am[1] : "", anchors: am ? am[2].split(", ") : [] });
      }
    }
  }
  return ev;
}

const STOP = new Set(["when", "did", "does", "do", "in", "the", "is", "a", "an", "of", "to", "what", "which", "who", "ups", "how", "start", "started", "since", "from", "and", "with", "are", "was", "have", "has", "right", "now", "much"]);
const contentWords = (q) => (String(q).toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => !STOP.has(w) && !/^\d{4}$/.test(w));
const yearsIn = (q) => [...String(q).matchAll(/(?<!\d)((?:19|20)\d{2})(?!\d)/g)].map((m) => Number(m[1]));
const franchiseIn = (q) => (/(?<!\d)(\d{4})(?!\d)/.exec(String(q)) || [])[1] || null;
const factSuffix = (ev, suffix) => ev.facts.find((f) => f.id.endsWith(`.${suffix}`));

// ── Router (a cheap classifier: the question, a short label, domains, an optional past date) ────────
export const SCRIPTED_ROUTES = {
  "DEV-RUL-02": { intent: "rule_lookup", domains: ["rules", "history"] },
  "DEV-RUL-10": { intent: "rule_lookup", domains: ["rules", "glossary"] },
  "DEV-REC-02": { intent: "champions_list", domains: ["history", "standings"] },
  "DEV-REC-01": { intent: "title_count", domains: ["history"] },
  "DEV-NOW-01": { intent: "cap_lookup", domains: ["cap"] },
  "DEV-INJ-05": { intent: "cap_lookup", domains: ["cap"] },
  "DEV-TFL-01": { intent: "standings_lookup", domains: ["standings"] },
  "DEV-LIN-03": { intent: "pick_lineage", domains: ["picks", "trades", "history"] },
  "DEV-CON-02": { intent: "contract_history", domains: ["contracts", "roster", "history"] },
  "DEV-UNA-08": { intent: "title_lookup", domains: ["history"] },
};
function routerReply(caseId, request) {
  const r = SCRIPTED_ROUTES[caseId];
  const q = questionOf(request);
  const ys = yearsIn(q).filter((y) => y !== 2026);
  const isRange = /\b(since|from|between|through|until)\b|\b(19|20)\d{2}\s*(to|-)\s*(19|20)\d{2}\b/i.test(q);   // a range is several seasons, not one date
  return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_scripted_router", name: "route_question", input: { intent: r.intent, domains: r.domains, needs_as_of: ys.length === 1 && !isRange ? `${ys[0]}-07-01` : null, out_of_scope: false, reason: "a read-only league records question" } }] };
}

// ── Loop (which tools to call, with which arguments) ───────────────────────────────────────────────
export const LAST_FINISHED_SEASON = 2025;      // the season before the scenario clock (2026-11-20): the last one with final standings
let useSeq = 0;
const use = (name, input) => ({ type: "tool_use", id: `toolu_scripted_${String(++useSeq).padStart(6, "0")}`, name, input });
const loopReply = (uses) => (uses.length ? { stop_reason: "tool_use", content: [{ type: "text", text: "Checking the records." }, ...uses] } : { stop_reason: "end_turn", content: [{ type: "text", text: "Enough evidence." }] });

const LOOPS = {
  // The scripted model reads the dated canon entry directly (it knows the anchor the way a model would after rules.search): rules.get returns the heading year as a fact.
  "DEV-RUL-02": (q, asOf) => [use("rules__search", { query: contentWords(q).join(" "), as_of: asOf || "current", limit: 8 }), use("rules__get", { anchor: "s4-2022-superflex-transition-concurrent-with-rest-of-league-rul", as_of: asOf || "current" })],
  "DEV-RUL-10": (q, asOf) => [use("rules__search", { query: contentWords(q).join(" "), as_of: asOf || "current", limit: 8 }), use("glossary__lookup", { term: contentWords(q)[0], as_of: asOf || "current" })],
  // "from 2017 to 2025" compares dates, so the pipeline refuses as_of current: pass the last season's date. One call returns every season through it.
  "DEV-REC-02": (q, asOf) => [use("history__finishes", { view: "champions", as_of: asOf || `${Math.max(...yearsIn(q))}-12-31` })],
  // "since 2011" is a range, so the pipeline refuses as_of current and asks for dated calls. A careful model asks for the last finished season;
  // history.finishes (seasons from 2011 on) returns every season through it and counts the titles in code.
  "DEV-REC-01": (q, asOf) => [use("history__finishes", { view: "champions", as_of: asOf || `${LAST_FINISHED_SEASON}-12-31` })],
  "DEV-NOW-01": (q, asOf) => [use("cap__position", { franchise_id: franchiseIn(q), as_of: asOf || "current" })],
  "DEV-INJ-05": (q, asOf) => [use("cap__position", { franchise_id: franchiseIn(q.replace(/\$[\d,]+K?/g, " ")), as_of: asOf || "current" })],
  "DEV-TFL-01": (q, asOf) => [use("standings__get", { franchise: franchiseIn(q), as_of: asOf || "current" })],
  "DEV-LIN-03": (q, asOf) => [use("coverage__check", { domain: "pick_lineage", season: yearsIn(q)[0], as_of: asOf || "current" })],
  "DEV-CON-02": (q, asOf) => [use("coverage__check", { domain: "contract_timeline", season: yearsIn(q)[0], as_of: asOf || "current" })],
  "DEV-UNA-08": (q, asOf) => [use("coverage__check", { domain: "finishes", season: yearsIn(q)[0], as_of: asOf || "current" })],
};
function loopStep(caseId, request) {
  if (roundsDone(request) > 0) return loopReply([]);              // one round of tools is enough for every scripted case
  return loopReply(LOOPS[caseId](questionOf(request), pinnedAsOf(request)));
}

// ── Composer (the card, built only from what the evidence says) ──────────────────────────────────────
const sha7 = (s) => String(s || "").slice(0, 7);
const noDigits = (s) => String(s).replace(/[0-9]/g, "");
function bestRule(ev, q) {
  const terms = contentWords(q);
  const score = (r) => terms.filter((t) => `${r.title} ${r.text}`.toLowerCase().includes(t)).length * 2 + terms.filter((t) => r.title.toLowerCase().includes(t)).length * 3;
  return [...ev.rules].sort((a, b) => score(b) - score(a))[0] || null;
}
function claimFor(q) { return `the rule on ${contentWords(q).filter((w) => !/\d/.test(w)).slice(0, 3).join(" ")}`; }

const COMPOSERS = {
  // "When did Superflex start?" The year is a fact token (rules.get returns the year in the rule's own heading), printed beside the cite to that same rule. The exact
  // effective date is a listed gap (rules by date, slice S4), so the state is answer_with_gap.
  "DEV-RUL-02": (ev, q) => {
    const rule = bestRule(ev, q); const year = factSuffix(ev, "rule_year");
    if (!rule) return declineCard("the rules search returned no rule on this");
    if (!year) return { state: "answer", lead_md: "Canon covers this in the cited rule. The rule text shown beside the cite gives the season it began and what changed.",
      cites: [{ anchor: rule.anchor, canon_sha: sha7(rule.canon_sha), claim: claimFor(q) }], follow_ups: ["Show the full rule text"] };
    return { state: "answer_with_gap", lead_md: `Canon dates the Superflex transition in its entry for {{f.${year.id}}}, the year named in the rule's own heading. The cited rule says the Superflex era begins there. The exact date it took effect is not on record.`,
      facts_used: [year.id], cites: [{ anchor: rule.anchor, canon_sha: sha7(rule.canon_sha), claim: claimFor(q) }], follow_ups: ["Show the full rule text"] };
  },
  // Keith's ruling (2026-11-20): Extension is the contract family; Ext1 is its one-year designation AND a contract_type value in canon (C4, T3.3); Vet-Ext1 is the related status token.
  // The answer carries all three distinctions, with the extension rule cited (and the transaction-catalog entry when it was retrieved). A glossary term may be written as spelled.
  "DEV-RUL-10": (ev, q) => {
    const rule = ev.rules.find((r) => r.anchor === "s1-c4") || bestRule(ev, q);
    const g = ev.glossary.find((x) => x.kind === "status_token") || ev.glossary[0];
    if (!rule) return declineCard("the rules search returned no rule on this");
    const cites = [{ anchor: rule.anchor, canon_sha: sha7(rule.canon_sha), claim: "the extension rule names its designations as contract types" }];
    const t33 = ev.rules.find((r) => r.anchor === "s2-t3-3");
    if (t33) cites.push({ anchor: t33.anchor, canon_sha: sha7(t33.canon_sha), claim: "the transaction catalog uses the same designations" });
    if (!g) return { state: "cite_and_abstain", lead_md: "Canon's extension rule is cited below. Whether a label counts as a contract type depends on canon's wording, so the desk points to the rule instead of ruling on it.", cites, follow_ups: ["Ask for a ruling on the wording"] };
    return { state: "answer", lead_md: `Extension is the contract family. Ext1 is the designation for extending a contract by a year, and canon's extension rule, cited below, uses it as a contract type value. The related status token is ${g.term}, the label a contract carries once it has been extended.`,
      cites, follow_ups: ["Show the full extension rule"] };
  },
  "DEV-REC-02": (ev, q) => {
    const ys = yearsIn(q); const lo = Math.min(...ys), hi = Math.max(...ys);
    const rows = [];
    for (const f of ev.facts) {
      const m = /^(\d{4}) final finish of franchise (\d{4})$/.exec(f.label);
      if (!m || Number(m[1]) < lo || Number(m[1]) > hi || f.display !== "Champion") continue;
      const team = ev.facts.find((x) => x.label === `${m[1]} team for franchise ${m[2]}`);
      const year = ev.facts.find((x) => x.id.endsWith(`.s${m[1]}_year`));
      if (team && year) rows.push({ season: Number(m[1]), year: year.id, team: team.id, finish: f.id });
    }
    rows.sort((a, b) => a.season - b.season);
    if (!rows.length) return declineCard("no champion rows came back for those seasons");
    return {
      state: "answer_with_gap",
      lead_md: "These are the champions for the seasons asked about, earliest season first. They are franchises, not owners, so a count here is not a person's career record.",
      blocks: [{ type: "table", title: "Champions by season", columns: ["Season", "Champion franchise", "Final finish"], rows: rows.map((r) => [`{{f.${r.year}}}`, `{{f.${r.team}}}`, `{{f.${r.finish}}}`]), fact_ids: rows.flatMap((r) => [r.year, r.team, r.finish]) }],
      facts_used: rows.flatMap((r) => [r.year, r.team, r.finish]),
      follow_ups: ["Show the Toilet Bowl champions"],
    };
  },
  // The leader's seasons come from the facts themselves: a champion row per season (its label names the franchise) and a year fact per season.
  "DEV-REC-01": (ev, q) => {
    const since = Math.min(...yearsIn(q));
    const titles = ev.facts.filter((f) => /^c\d+\.titles_f\d{4}$/.test(f.id)).map((f) => ({ f, n: Number(f.display) })).sort((a, b) => b.n - a.n);
    if (!titles.length) return declineCard("no title counts came back");
    const top = titles[0];
    const fid = /f(\d{4})$/.exec(top.f.id)[1];
    const team = ev.facts.find((x) => x.label.endsWith(` team for franchise ${fid}`));
    const seasons = ev.facts.map((x) => { const m = /^(\d{4}) final finish of franchise (\d{4})$/.exec(x.label); return m && m[2] === fid && x.display === "Champion" && Number(m[1]) >= since ? Number(m[1]) : null; })
      .filter((y) => y != null).sort((a, b) => a - b).map((y) => ev.facts.find((x) => x.id.endsWith(`.s${y}_year`))).filter(Boolean);
    const sinceYear = ev.facts.find((x) => x.id.endsWith(`.s${since}_year`));
    if (!team || !seasons.length || !sinceYear) return declineCard("the franchise and its seasons could not be named from the facts");
    const toks = seasons.map((y) => `{{f.${y.id}}}`);
    const list = toks.length === 1 ? toks[0] : `${toks.slice(0, -1).join(", ")} and ${toks[toks.length - 1]}`;
    return {
      state: "answer_with_gap",
      lead_md: `Since {{f.${sinceYear.id}}}, the franchise with the most championships is {{f.${team.id}}}, with {{f.${top.f.id}}}, won in the seasons ${list}. Results are by franchise, not by owner.`,
      facts_used: [sinceYear.id, team.id, top.f.id, ...seasons.map((y) => y.id)],
      follow_ups: ["Show the Toilet Bowl champions"],
    };
  },
  "DEV-NOW-01": (ev) => capCard(ev),
  "DEV-INJ-05": (ev) => capCard(ev, "The note quoted in the question is not a source, so it is ignored; the figure comes from the cap tool only."),
  "DEV-TFL-01": (ev) => {
    const failed = ev.refusals.filter((r) => r.status === "error" || r.status === "refused");
    if (!failed.length) return declineCard("the standings source returned nothing usable");
    return { state: "abstain", lead_md: "The standings source did not answer, so this place could not be verified. No substitute is given and nothing is filled in from memory.",
      gaps: [{ what: `The source behind ${failed[0].tool} did not return data, so the current place cannot be checked`, why: "partial_coverage", source_needed: "a working standings source" }], follow_ups: ["Try the question again later"] };
  },
  // Coverage declines: the desk copies the tool's own gap (what is missing, why, the source needed) onto the card, so the prose only declines.
  "DEV-LIN-03": (ev) => coverageDecline(ev, "No record the desk holds can trace this pick, so it gives no chain of owners and does not guess a pick slot."),
  "DEV-CON-02": (ev) => coverageDecline(ev, "The desk has no record of that contract on that date, so it gives no team, salary or contract string."),
  "DEV-UNA-08": (ev) => coverageDecline(ev, "The desk has no record for that season, so it cannot say who won and does not guess."),
};
function capCard(ev, extra) {
  const avail = factSuffix(ev, "cap_available"), used = factSuffix(ev, "cap_used"), cap = factSuffix(ev, "salary_cap");
  if (!avail || !used || !cap) return declineCard("the cap tool returned no cap position");
  const team = factSuffix(ev, "team_name");                   // the tool now returns the team as a fact, so the card can say whose cap room it is
  const lead = team ? `{{f.${team.id}}} has {{f.${avail.id}}} of cap room right now` : `Cap room right now is {{f.${avail.id}}}`;
  return { state: "answer", lead_md: `${lead}: the salary cap of {{f.${cap.id}}} less cap used of {{f.${used.id}}}.${extra ? ` ${extra}` : ""}`,
    facts_used: [avail.id, used.id, cap.id, ...(team ? [team.id] : [])], follow_ups: ["Show the adjustments behind cap used"] };
}
function coverageDecline(ev, lead) {
  if (!ev.gaps.length) return declineCard("the coverage check reported no gap to name");
  return { state: "abstain", lead_md: `${lead} The gap listed on the card names the missing source.`, follow_ups: ["Ask what the desk can answer about this season"] };
}
function declineCard(why) {
  return { state: "abstain", lead_md: `The desk cannot answer this from what came back. ${noDigits(why)}.`, gaps: [{ what: noDigits(why), why: "NO_RECORD", source_needed: "a source the desk can read" }] };
}
function composerStep(caseId, request) {
  const ev = parseEvidence(request);
  const card = COMPOSERS[caseId](ev, questionOf(request));
  return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_scripted_card", name: "emit_card", input: card }] };
}

// ── The client ──────────────────────────────────────────────────────────────────────────────────────
// The step is told by the tools offered (a forced tool_choice is not sent to every model): one tool named route_question or emit_card, else the loop.
const toolNames = (request) => (Array.isArray(request.tools) ? request.tools.map((x) => x && x.name) : []);
const stepOf = (request) => { const n = toolNames(request); return n.length === 1 && n[0] === "route_question" ? "router" : n.length === 1 && n[0] === "emit_card" ? "composer" : "loop"; };
const bytes = (v) => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v)).length;

// ── Modeled token usage (an ESTIMATE, never a price quote) ──────────────────────────────────────────
// 2.5 bytes per token: measured in the first live run (R1), where a loop request of about 18.0 KB (14 tool definitions, the prompt and the question)
// was billed 7,218 input tokens (9,022 recorded with the 25 percent margin). The earlier 3.5 understated every scripted cost by about 40 percent.
export const BYTES_PER_TOKEN = 2.5;
export const MIN_CACHEABLE_TOKENS = 512;        // Sonnet 5.5 / Haiku 5.5, per Anthropic's published minimum (verify against the current docs)
const tokensOf = (n) => Math.ceil(n / BYTES_PER_TOKEN);
const hasMarker = (v) => JSON.stringify(v == null ? null : v).includes('"cache_control"');
const strip = (v) => JSON.parse(JSON.stringify(v == null ? null : v, (k, x) => (k === "cache_control" ? undefined : x)));

// A modeled prompt cache, one per scripted client: the cache covers tools, then system, then messages, and a hit needs an identical prefix.
// Entries are written at each marked breakpoint (system block, newest message); a later request reads the longest stored prefix it starts with,
// is charged cache creation only for the part beyond what it read, and the rest of its input is plain input tokens.
export function createCacheModel() { return { entries: [] }; }
export function estimateUsage(request, content, cache = null) {
  const tools = JSON.stringify(strip(request.tools)), system = JSON.stringify(strip(request.system));
  const msgs = (strip(request.messages) || []).map((m) => JSON.stringify(m));
  const full = tools + system + msgs.join("");
  const total = tokensOf(bytes(full));
  const usage = { input_tokens: total, output_tokens: Math.max(20, Math.ceil(bytes(content) / BYTES_PER_TOKEN)) };
  if (!cache || !hasMarker(request)) return usage;
  const prefixes = [];
  if (hasMarker(request.system)) prefixes.push(tools + system);
  if (Array.isArray(request.messages) && request.messages.length && hasMarker(request.messages[request.messages.length - 1])) prefixes.push(full);
  const usable = prefixes.filter((p) => tokensOf(bytes(p)) >= MIN_CACHEABLE_TOKENS);
  if (!usable.length) return usage;
  const last = usable[usable.length - 1];
  let read = 0;
  for (const e of cache.entries) if (full.startsWith(e.text) && e.tokens > read) read = e.tokens;
  const lastTokens = tokensOf(bytes(last));
  for (const p of usable) if (!cache.entries.some((e) => e.text === p)) cache.entries.push({ text: p, tokens: tokensOf(bytes(p)) });
  return { ...usage, input_tokens: Math.max(0, total - lastTokens), cache_read_input_tokens: Math.min(read, lastTokens), cache_creation_input_tokens: Math.max(0, lastTokens - read) };
}

export function scriptedResponse(caseId, request, cache = null) {
  if (!SCRIPTED_CASE_IDS.includes(caseId)) throw new Error(`no scripted model for case ${String(caseId).slice(0, 40)}`);
  const step = stepOf(request);
  const r = step === "router" ? routerReply(caseId, request) : step === "composer" ? composerStep(caseId, request) : loopStep(caseId, request);
  return { ...r, usage: estimateUsage(request, r.content, cache) };
}

// A fake-mode client (the budget gate keeps its spend in the "fake" lane). Every request is recorded in `calls`.
export function createScriptedClient(caseId) {
  if (!SCRIPTED_CASE_IDS.includes(caseId)) throw new Error(`no scripted model for case ${String(caseId).slice(0, 40)}`);
  const cache = createCacheModel();
  const client = createFakeClient((request) => scriptedResponse(caseId, request, cache));
  client.scripted = true;
  return client;
}

// ── The ADVERSARIAL scripted model ───────────────────────────────────────────────────────────────────
// The scripted model above behaves like a careful, well-behaved model, which is exactly why it could not find what the paid runs R1 to R3 found. This wrapper takes the
// same scripted answer and makes it misbehave in the ways a real model (or the provider) did or could: thinking blocks, many parallel tool calls, mixed text,
// a prose reply instead of a card, a reply cut off by max_tokens, a refusal, an invalid tool sequence, odd capitalization of a league term, a non-ASCII digit, a provider
// error. It never touches the network and never invents a fact: a behavior only reshapes or damages the scripted response.
//
// behavior: one of BEHAVIORS. Each applies to a step (router, loop, composer) and, where it says "once", only to the first call of that step (the composer's retry is
// its second call, so "once" lets the retry succeed and "always" does not).
export const BEHAVIORS = Object.freeze({
  thinking: { step: ["router", "loop", "composer"], note: "a thinking block (empty text, a signature) before every reply" },
  thinking_summarized: { step: ["loop", "composer"], note: "a thinking block with text and a signature" },
  redacted_thinking: { step: ["loop", "composer"], note: "a redacted_thinking block and a thinking block before every reply" },
  mixed_text: { step: ["loop"], note: "text before, between and after the tool calls, and an empty text block" },
  parallel9: { step: ["loop"], note: "nine parallel tool calls in one turn (the planned calls, repeated with new ids)" },
  text_only_composer_once: { step: ["composer"], note: "the first composer reply is prose with no emit_card call" },
  text_only_composer_always: { step: ["composer"], note: "every composer reply is prose with no emit_card call" },
  truncated_loop: { step: ["loop"], note: "the first loop reply is cut off by max_tokens while holding tool calls" },
  truncated_composer_once: { step: ["composer"], note: "the first composer card is cut off by max_tokens" },
  refusal_loop: { step: ["loop"], note: "the first loop reply is a refusal with no content" },
  bad_tool_seq: { step: ["loop"], note: "an unknown tool, a string input, a call with no id and a repeated id are added to the first loop turn" },
  glossary_case: { step: ["composer"], note: "a league term written in other capitalizations (Ext1, EXT1, ext1)" },
  unicode_digit_once: { step: ["composer"], note: "the first card has an Arabic-Indic digit in its lead" },
  unicode_digit_always: { step: ["composer"], note: "every card has an Arabic-Indic digit in its lead" },
  unicode_digit_claim_once: { step: ["composer"], note: "the first card has a fullwidth digit in a citation claim" },
  http400_loop2: { step: ["loop"], note: "the provider answers the second loop request with HTTP 400 invalid_request_error" },
  bad_response_loop: { step: ["loop"], note: "the first loop call fails with a malformed provider reply" },
});

function applyBehavior(behavior, step, n, base) {
  const r = { ...base, content: Array.isArray(base.content) ? base.content.map((b) => ({ ...b })) : [] };
  const sigs = (k) => `SIGNATURE-${step}-${n}-${k}`;
  switch (behavior) {
    case "thinking": r.content = [{ type: "thinking", thinking: "", signature: sigs(1) }, ...r.content]; return r;
    case "thinking_summarized": r.content = [{ type: "thinking", thinking: "The question needs the records; check them first.", signature: sigs(1) }, ...r.content]; return r;
    case "redacted_thinking": r.content = [{ type: "redacted_thinking", data: `REDACTED-${step}-${n}` }, { type: "thinking", thinking: "", signature: sigs(2) }, ...r.content]; return r;
    case "mixed_text": {
      if (step !== "loop") return r;
      const out = [{ type: "text", text: "" }];
      for (const b of r.content) { out.push(b); if (b.type === "tool_use") out.push({ type: "text", text: "Next." }); }
      r.content = out;
      return r;
    }
    case "parallel9": {
      if (step !== "loop") return r;
      const uses = r.content.filter((b) => b.type === "tool_use");
      if (!uses.length) return r;
      let k = 0;
      const extra = [];
      while (uses.length + extra.length < 9) { const src = uses[k % uses.length]; extra.push({ ...src, id: `toolu_par_${n}_${k}`, input: { ...src.input } }); k += 1; }
      r.content = [...r.content, ...extra];
      return r;
    }
    case "text_only_composer_once": if (step === "composer" && n === 1) return { ...base, stop_reason: "end_turn", content: [{ type: "text", text: "The answer is below in plain prose, not as a card." }] }; return r;
    case "text_only_composer_always": if (step === "composer") return { ...base, stop_reason: "end_turn", content: [{ type: "text", text: "Here it is in prose, with no card: twelve thousand dollars." }] }; return r;
    case "truncated_loop": if (step === "loop" && n === 1 && r.content.some((b) => b.type === "tool_use")) return { ...r, stop_reason: "max_tokens" }; return r;
    case "truncated_composer_once": if (step === "composer" && n === 1) return { ...r, stop_reason: "max_tokens" }; return r;
    case "refusal_loop": if (step === "loop" && n === 1) return { ...base, stop_reason: "refusal", content: [] }; return r;
    case "bad_tool_seq": {
      if (step !== "loop" || n !== 1) return r;
      const first = r.content.find((b) => b.type === "tool_use");
      r.content = [...r.content,
        { type: "tool_use", id: "toolu_bad_unknown", name: "not__a_registered_tool", input: {} },
        { type: "tool_use", id: "toolu_bad_input", name: first ? first.name : "rules__search", input: "this is a string, not an object" },
        { type: "tool_use", id: "", name: first ? first.name : "rules__search", input: {} },
        ...(first ? [{ ...first, input: { ...first.input } }] : [])];            // the same id again
      return r;
    }
    case "glossary_case": {
      if (step !== "composer") return r;
      const tu = r.content.find((b) => b.type === "tool_use" && b.name === "emit_card");
      if (!tu || typeof tu.input.lead_md !== "string" || !/ext1/i.test(tu.input.lead_md)) return r;
      tu.input = { ...tu.input, lead_md: tu.input.lead_md.replace(/Vet-Ext1/g, "VET-EXT1").replace(/(?<![-\w])Ext1/g, "ext1") + " Written as Ext1 and EXT1 too." };
      return r;
    }
    case "unicode_digit_once": case "unicode_digit_always": {
      if (step !== "composer" || (behavior === "unicode_digit_once" && n !== 1)) return r;
      const tu = r.content.find((b) => b.type === "tool_use" && b.name === "emit_card");
      if (tu) tu.input = { ...tu.input, lead_md: `${tu.input.lead_md} ١` };
      return r;
    }
    case "unicode_digit_claim_once": {
      if (step !== "composer" || n !== 1) return r;
      const tu = r.content.find((b) => b.type === "tool_use" && b.name === "emit_card");
      if (tu) tu.input = Array.isArray(tu.input.cites) && tu.input.cites.length
        ? { ...tu.input, cites: tu.input.cites.map((c, i) => (i === 0 ? { ...c, claim: `${c.claim} ３` } : c)) }
        : { ...tu.input, follow_ups: [...(tu.input.follow_ups || []), "Ask again about ３ seasons?"] };
      return r;
    }
    case "http400_loop2": if (step === "loop" && n === 2) return new DeskModelError("http_error", { status: 400, providerType: "invalid_request_error", providerPath: "messages.1.content.0.text" }); return r;
    case "bad_response_loop": if (step === "loop" && n === 1) return new DeskModelError("bad_response"); return r;
    default: return r;
  }
}

// behavior: a key of BEHAVIORS, or null for the plain scripted model. Same interface as createScriptedClient.
export function createAdversarialClient(caseId, behavior = null) {
  if (!SCRIPTED_CASE_IDS.includes(caseId)) throw new Error(`no scripted model for case ${String(caseId).slice(0, 40)}`);
  if (behavior !== null && !Object.prototype.hasOwnProperty.call(BEHAVIORS, behavior)) throw new Error(`unknown behavior ${String(behavior).slice(0, 40)}`);
  const cache = createCacheModel();
  const counts = { router: 0, loop: 0, composer: 0 };
  const client = createFakeClient((request) => {
    const step = stepOf(request);
    counts[step] += 1;
    const base = scriptedResponse(caseId, request, cache);
    return behavior ? applyBehavior(behavior, step, counts[step], base) : base;
  });
  client.scripted = true; client.adversarial = behavior;
  return client;
}

// Wrap any client (scripted or live) and keep what the model returned, step by step, for transcripts and results files.
// keepRequests: also keep each request (the demo needs them; a paid run does not store prompts).
export function recordClient(inner, { keepRequests = false } = {}) {
  const transcript = [];
  const client = {
    mode: inner.mode, scripted: !!inner.scripted, transcript,
    async complete(request) {
      const step = stepOf(request);
      const t0 = Date.now();
      try {
        const response = await inner.complete(request);
        transcript.push({ step, model: request.model, response: structuredClone(response), ms: Date.now() - t0, ...(keepRequests ? { request: structuredClone(request) } : {}) });
        return response;
      } catch (e) {
        transcript.push({ step, model: request.model, error: String((e && e.code) || (e && e.name) || "error"), ms: Date.now() - t0 });
        throw e;
      }
    },
  };
  return client;
}
