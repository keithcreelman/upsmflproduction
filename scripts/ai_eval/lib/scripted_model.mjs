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
// Token usage in a scripted response is an ESTIMATE (UTF-8 bytes / 3.5), so fake costs are a rough guide, not a price quote.
import { findSpelledQuantities } from "../../../worker/src/desk/validator.js";
import { createFakeClient } from "../../../tests/fixtures/ai_desk/fake_client.mjs";

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
const ROUTES = {
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
  const r = ROUTES[caseId];
  const q = questionOf(request);
  const ys = yearsIn(q).filter((y) => y !== 2026);
  const isRange = /\b(since|from|between|through|until)\b|\b(19|20)\d{2}\s*(to|-)\s*(19|20)\d{2}\b/i.test(q);   // a range is several seasons, not one date
  return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_scripted_router", name: "route_question", input: { intent: r.intent, domains: r.domains, needs_as_of: ys.length === 1 && !isRange ? `${ys[0]}-07-01` : null, out_of_scope: false, reason: "a read-only league records question" } }] };
}

// ── Loop (which tools to call, with which arguments) ───────────────────────────────────────────────
export const LAST_FINISHED_SEASON = 2025;      // the season before the scenario clock (2026-11-20): the last one with final standings
let useSeq = 0;
const use = (name, input) => ({ type: "tool_use", id: `toolu_scripted_${++useSeq}`, name, input });
const loopReply = (uses) => (uses.length ? { stop_reason: "tool_use", content: [{ type: "text", text: "Checking the records." }, ...uses] } : { stop_reason: "end_turn", content: [{ type: "text", text: "Enough evidence." }] });

const LOOPS = {
  "DEV-RUL-02": (q, asOf) => [use("rules__search", { query: contentWords(q).join(" "), as_of: asOf || "current", limit: 8 })],
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
  // "When did Superflex start?" The year cannot be typed (no digits in prose), so the answer is the cited rule, whose own text the server shows beside the cite.
  "DEV-RUL-02": (ev, q) => {
    const rule = bestRule(ev, q); const sha = factSuffix(ev, "canon_sha");
    if (!rule || !sha) return declineCard("the rules search returned no rule on this");
    return { state: "answer", lead_md: `Canon covers this in the cited rule, at canon version {{f.${sha.id}}}. The rule text shown beside the cite gives the season it began and what changed.`,
      facts_used: [sha.id], cites: [{ anchor: rule.anchor, canon_sha: sha7(rule.canon_sha), claim: claimFor(q) }], follow_ups: ["Show the full rule text"] };
  },
  // The composer now sees the glossary entry. It defines the label as a status token, so the answer is no, with the extension rule cited. A glossary term may be
  // written exactly as spelled (it has a digit in it); the definition sentence is reused only if it carries no digit and no spelled quantity.
  "DEV-RUL-10": (ev, q) => {
    const rule = bestRule(ev, q);
    const g = ev.glossary.find((x) => x.kind === "status_token") || ev.glossary[0];
    if (!rule) return declineCard("the rules search returned no rule on this");
    if (!g) return { state: "cite_and_abstain", lead_md: "Canon's extension rule is cited below. Whether the label counts as a contract type depends on canon's wording, so the desk points to the rule instead of ruling on it.",
      cites: [{ anchor: rule.anchor, canon_sha: sha7(rule.canon_sha), claim: claimFor(q) }], follow_ups: ["Ask for a ruling on the wording"] };
    const kind = g.kind.replace(/_/g, " ");
    const first = String(g.definition).split(/\.\s/)[0].replace(/\.$/, "");
    const quote = !/\d/.test(first) && !findSpelledQuantities(first).length ? ` The glossary defines it this way: ${first.charAt(0).toLowerCase()}${first.slice(1)}.` : "";
    return { state: "answer", lead_md: `No. The glossary lists ${g.term} as a ${kind}, a label a contract carries, not a separate kind of contract.${quote} The cited extension rule gives the detail.`,
      cites: [{ anchor: rule.anchor, canon_sha: sha7(rule.canon_sha) || sha7(g.canon_sha), claim: claimFor(q) }], follow_ups: ["Show the full extension rule"] };
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
const stepOf = (request) => (request.tool_choice && request.tool_choice.name === "route_question" ? "router" : request.tool_choice && request.tool_choice.name === "emit_card" ? "composer" : "loop");
const bytes = (v) => new TextEncoder().encode(JSON.stringify(v)).length;
export function estimateUsage(request, content) {
  return { input_tokens: Math.ceil(bytes({ system: request.system, messages: request.messages, tools: request.tools }) / 3.5), output_tokens: Math.max(20, Math.ceil(bytes(content) / 3.5)) };
}

export function scriptedResponse(caseId, request) {
  if (!SCRIPTED_CASE_IDS.includes(caseId)) throw new Error(`no scripted model for case ${String(caseId).slice(0, 40)}`);
  const step = stepOf(request);
  const r = step === "router" ? routerReply(caseId, request) : step === "composer" ? composerStep(caseId, request) : loopStep(caseId, request);
  return { ...r, usage: estimateUsage(request, r.content) };
}

// A fake-mode client (the budget gate keeps its spend in the "fake" lane). Every request is recorded in `calls`.
export function createScriptedClient(caseId) {
  if (!SCRIPTED_CASE_IDS.includes(caseId)) throw new Error(`no scripted model for case ${String(caseId).slice(0, 40)}`);
  const client = createFakeClient((request) => scriptedResponse(caseId, request));
  client.scripted = true;
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
