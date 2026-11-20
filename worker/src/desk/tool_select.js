// Commissioner Desk: which tool DEFINITIONS the tool-loop model is shown for one question. This is a COST measure only, never a security one.
//
// What it is NOT: authorization. Every tool call still goes through registry.runTool, which checks the caller, the schema, the route allowlist and
// the data class, whatever was offered. A tool that is not offered simply cannot be requested by the model; offering fewer definitions cuts the
// input tokens of every loop round (the first live run, R1, measured the 14 definitions at about 6,400 of the 7,200 input tokens of round one).
//
// Why it cannot quietly cost accuracy (each is tested in tests/ai_desk_tool_select.test.mjs):
//   1. A small CORE is offered for every question: rules.search, rules.get, glossary.lookup, coverage.check (how a gap or a rule is found).
//   2. Each router domain maps to a deliberately GENEROUS set of neighbors (a cap question also gets roster, calendar and freshness).
//   3. A keyword net reads the QUESTION TEXT in code and ADDS the domains it recognises. The router can only ever add tools through it, so a
//      router that names the wrong domain still leaves the right tools on offer when the question uses the obvious words.
//   4. No route, no domains, "other", or only domains this file does not know: ALL tools are offered (the cost of the old behavior, never less).
//   5. A registered tool that appears in no list here is ALWAYS offered, so adding a tool cannot silently remove it from the model's view.
//   6. The choice is recorded on the trace (domains, keyword domains, which tools, how many of how many), so a miss is visible afterward.

export const CORE_TOOL_IDS = Object.freeze(["rules.search", "rules.get", "glossary.lookup", "coverage.check"]);

// Router domain -> the tools worth showing beside the core. Generous on purpose: wrongly offering a tool costs a few hundred tokens; wrongly
// withholding one costs a wrong or missing answer.
export const DOMAIN_TOOL_IDS = Object.freeze({
  rules: Object.freeze(["calendar.events"]),
  glossary: Object.freeze([]),
  cap: Object.freeze(["cap.position", "cap.penalty_quote", "cap.adjustments", "extension.price", "roster.current", "calendar.events", "data.freshness"]),
  contracts: Object.freeze(["roster.current", "extension.price", "cap.penalty_quote", "cap.position", "cap.adjustments", "calendar.events", "player.transactions"]),
  roster: Object.freeze(["roster.current", "cap.position", "cap.penalty_quote", "extension.price", "player.transactions", "data.freshness"]),
  trades: Object.freeze(["player.transactions", "cap.adjustments", "roster.current", "cap.position", "calendar.events"]),
  picks: Object.freeze(["player.transactions", "calendar.events", "history.finishes", "standings.get", "roster.current"]),
  standings: Object.freeze(["standings.get", "history.finishes", "calendar.events", "data.freshness"]),
  history: Object.freeze(["history.finishes", "standings.get", "player.transactions", "calendar.events"]),
  calendar: Object.freeze(["calendar.events", "data.freshness"]),
  players: Object.freeze(["player.transactions", "roster.current", "extension.price", "cap.penalty_quote", "history.finishes"]),
  data_freshness: Object.freeze(["data.freshness", "standings.get", "roster.current", "cap.position"]),
});

// Words in the question that name a domain. They only ADD tools. Deliberately broad.
export const KEYWORD_DOMAINS = Object.freeze([
  [/\b(cap|salar\w*|penalt\w*|dead\s*money|adjust\w*|room|space|tag\w*|franchise\s+tag|extension\w*|extend\w*|ext\d|restructur\w*|contract\w*|aav|tcv|guarantee\w*|gtd|released?|cut|drop\w*|waive\w*|sign\w*|logged|evidenced|derived)\b/i, ["cap", "contracts"]],
  [/\b(champion\w*|titles?|won|wins?|winner\w*|finish\w*|runner[- ]?up|toilet|standing\w*|place|ranked?|seed\w*|playoff\w*|record\w*|season\w*|since|history|points?|scor\w*|compar\w*|highest|lowest|most|best|worst|era)\b|\b(19|20)\d{2}\b/i, ["history", "standings"]],
  [/\b(trad\w+|picks?|draft\w*|rounds?|lineage|traded|\d{1,2}(st|nd|rd|th)|trace\w*|back)\b/i, ["trades", "picks"]],
  [/\b(roster\w*|taxi|ir|injur\w*|starter\w*|lineup\w*|player\w*|waiver\w*|free\s+agen\w*|faa|bids?|mov(e|ed|es|ing)|transaction\w*|added|acquired|happened|owner\w*|controlled|team\s+name)\b/i, ["roster", "players"]],
  [/\b(deadline\w*|when|dates?|calendar|week\s*\d*|kickoff|schedule\w*|opens?|closes?|start\w*)\b/i, ["calendar"]],
  [/\b(fresh\w*|stale|updated|last\s+sync\w*|up\s+to\s+date)\b/i, ["data_freshness"]],
]);

export function keywordDomains(question) {
  const q = String(question == null ? "" : question).slice(0, 2000);
  const out = new Set();
  for (const [re, doms] of KEYWORD_DOMAINS) if (re.test(q)) for (const d of doms) out.add(d);
  return [...out];
}

// allIds: every registered tool id, in registry order. Returns { ids (registry order), reason, domains, keyword_domains, offered, total }.
export function selectToolIds({ route, question, allIds }) {
  const all = Array.isArray(allIds) ? [...allIds] : [];
  const mapped = new Set(CORE_TOOL_IDS);
  for (const list of Object.values(DOMAIN_TOOL_IDS)) for (const id of list) mapped.add(id);
  const result = (reason, set, domains, kw) => {
    const ids = all.filter((id) => set === null || set.has(id));
    return { ids, reason, domains, keyword_domains: kw, offered: ids.length, total: all.length };
  };
  const routed = route && Array.isArray(route.domains) ? route.domains.filter((d) => typeof d === "string") : [];
  const known = routed.filter((d) => Object.prototype.hasOwnProperty.call(DOMAIN_TOOL_IDS, d));
  const kw = keywordDomains(question);
  if (!route) return result("all:no_route", null, routed, kw);
  if (!routed.length) return result("all:no_domains", null, routed, kw);
  if (routed.includes("other")) return result("all:other", null, routed, kw);
  if (!known.length) return result("all:unknown_domains", null, routed, kw);
  const set = new Set(CORE_TOOL_IDS);
  for (const d of [...known, ...kw]) for (const id of DOMAIN_TOOL_IDS[d] || []) set.add(id);
  for (const id of all) if (!mapped.has(id)) set.add(id);      // a tool nobody mapped is always shown
  return result("domains", set, known, kw);
}
