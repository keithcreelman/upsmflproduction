// Commissioner Desk tool 7: cap.penalty_quote
// What it costs to cut a player under the CURRENT rules, as priced by the Worker's own charged calculator
// (GET /api/cap-penalty/preview -> _computeDropPenalty). The desk does not change that calculator; it adapts it and REFUSES
// where the calculator cannot be trusted. Two guards (docs/ai_desk/DESK_CONTRACT.md, G1 and G2) decide that, in code, before any number leaves:
//
//   G1  The calculator falls back to AAV x years played when contractInfo has no per-year salaries (tokens like Y1-5K) for the contract
//       years already completed. Archive example: "CL 3| TCV 12K| AAV 3K", 1 year left: posted $1K, the fallback gives $3K. When the player
//       has completed years and those year-by-year salaries are not on record, this tool refuses (incomplete_contract_data). It does the
//       same when CL or TCV is missing (the calculator would then substitute the salary for TCV).
//   G2  For a TAG contract the calculator is cap-free while TODAY is before Aug 1 of the season; canon (6.C2 / C8) says before the FA Auction
//       STARTS. A what-if with a past drop date is also judged by today's date. The tool answers only when the route's view and canon agree
//       (today and the drop date both before the auction start, or both on or after Aug 1) and the route's own basis confirms it. Every other
//       case, and an auction start that cannot be resolved, is refused (tag_cutoff_unreliable).
//
// A refused result carries no facts, no data and no number: the route's figure is never returned when a guard fires.
// A quote that IS returned is grade C (derived by the worker's charged calculator) and is labeled a current-rule quote.
import { defineTool } from "../registry.js";
import { safeToken } from "./shared_text.js";

const R_PREVIEW = "/api/cap-penalty/preview";
const R_WORKBENCH = "/roster-workbench";
const R_EVENTS = "/api/league-events";
const SOURCE = "/api/cap-penalty/preview (the worker's charged calculator)";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Cap-free because of the player's STATUS alone (a taxi-eligible cut, a tag cut before the auction): the penalty reads no contract
// token, so G1 does not apply. Every other basis, exempt or not, depends on CL / TCV / years parsed from contractInfo, so G1 applies
// (an exemption reached by substituting the salary for a missing TCV is a guess too).
const STATUS_ONLY_BASES = new Set(["taxi_exempt", "taxi_callup_exempt", "taxi_eligible_exempt", "tag_pre_auction_exempt"]);
const UNPRICED_BASES = new Set(["week_authority_unresolved", "contract_unstamped_needs_review", "no_pre_drop_contract"]);

const s = (v) => String(v == null ? "" : v).trim();
const isoDay = (d) => d.toISOString().slice(0, 10);
const validDate = (v) => DATE_RE.test(v) && !Number.isNaN(Date.parse(v + "T00:00:00Z")) && isoDay(new Date(v + "T00:00:00Z")) === v;

// Mirrors the calculator's own parser (worker/src/index.js _parseContractData). Read-only: used to CHECK, never to price.
function readTokens(info) {
  const ci = s(info);
  const cl = ci.match(/CL\s*(\d+)/i);
  const tcv = ci.match(/TCV\s*(\d+(?:\.\d+)?)\s*K/i);
  const years = {};
  const re = /Y(\d+)\s*[-:]\s*(\d+(?:\.\d+)?)\s*K?/gi;
  let m;
  while ((m = re.exec(ci)) !== null) years[Number(m[1])] = Math.round(Number(m[2]) * 1000);
  return { hasCl: !!cl, hasTcv: !!tcv, years };
}

function refuse(code, reason, gap, provenance) {
  return { status: "refused", data: null, facts: [], coverage: { supported: false, gaps: [gap] }, provenance: provenance || {}, refusal: { code, reason } };
}

// The FA Auction start for this season, from knowledge.calendar (preferred) or the league-events calendar. null = cannot be resolved.
async function resolveAuctionStart({ knowledge, season, routeGet }) {
  const cal = knowledge && knowledge.calendar && typeof knowledge.calendar === "object" ? knowledge.calendar : null;
  const given = cal ? s(cal.faAuctionStart).slice(0, 10) : "";
  if (given) {
    if (validDate(given) && given.startsWith(String(season) + "-")) return { date: given, source: "knowledge.calendar.faAuctionStart" };
    return null;   // present but malformed or from another season: never trusted
  }
  try {
    const res = await routeGet(R_EVENTS, { L: knowledge.leagueId, season: String(season), from: "all", limit: "50" });
    const events = res.ok && res.json && Array.isArray(res.json.events) ? res.json.events : [];
    const ev = events.find((e) => e && e.event === "ups_fa_auction_start");
    const d = ev ? s(ev.date).slice(0, 10) : "";
    // A typed placeholder is not a date canon can rely on.
    if (ev && validDate(d) && d.startsWith(String(season) + "-") && !/placeholder|tbd|to be confirmed/i.test(s(ev.description)) && ev.date_source !== "unresolved") {
      return { date: d, source: `${R_EVENTS} ups_fa_auction_start (${safeToken(ev.date_source) || "stored"})` };
    }
  } catch (_) { /* unresolved */ }
  return null;
}

function findPlayer(body, playerId) {
  for (const t of Array.isArray(body && body.teams) ? body.teams : []) {
    for (const p of Array.isArray(t && t.players) ? t.players : []) if (String(p.id) === String(playerId)) return p;
  }
  return null;
}

export default defineTool({
  id: "cap.penalty_quote",
  version: "1.0.0",
  description:
    "Quote what it costs to CUT one rostered player under the CURRENT rules, using the worker's charged drop-penalty calculator (a current-rule quote, not a historical one). " +
    "Optional what-if inputs: drop_date (YYYY-MM-DD in this season), acquisition_week, salary, contractStatus, contractInfo, contractYear. " +
    "It REFUSES instead of quoting when the player's year-by-year salaries are not on record for the completed contract years, or when a tag contract is cut near the FA Auction " +
    "(the calculator's tag cutoff can disagree with canon). It cannot price a past season's rules, and it does not say which season's cap the charge lands on.",
  phase: "P1",
  dataClass: "P0",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      player_id: { type: "string", pattern: "^\\d{3,6}$", maxLength: 6, description: "MFL player id of a currently rostered player." },
      drop_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", maxLength: 10, description: "What-if cut date, YYYY-MM-DD, inside the current season. Omit for today." },
      acquisition_week: { type: "integer", minimum: 1, maximum: 17, description: "What-if NFL week the contract began (waiver pickups)." },
      salary: { type: "integer", minimum: 0, maximum: 400000, description: "What-if current-year salary in dollars." },
      contractStatus: { type: "string", pattern: "^[A-Za-z0-9 _.-]{1,40}$", maxLength: 40, description: "What-if contract status, e.g. Veteran, Vet-WW, Tag." },
      contractInfo: { type: "string", pattern: "^[A-Za-z0-9 |,.:\\-]{1,190}$", maxLength: 190, description: "What-if contractInfo text, e.g. 'CL 3| TCV 90K| AAV 30K| Y1-30K, Y2-30K, Y3-30K'." },
      contractYear: { type: "integer", minimum: 0, maximum: 6, description: "What-if years REMAINING (MFL contractYear)." },
    },
    required: ["player_id"],
  },
  asOf: { supports: "current" },
  allowlist: {
    routes: [
      { path: R_PREVIEW, params: ["L", "YEAR", "player_id", "drop_date", "acquisition_week", "salary", "contractStatus", "contractInfo", "contractYear"] },
      { path: R_WORKBENCH, params: ["L", "YEAR", "NO_CACHE"] },
      { path: R_EVENTS, params: ["L", "season", "from", "limit"] },
    ],
    modules: [], tables: [],
  },
  output: {
    allow: [
      "player_id", "franchise_id", "season", "drop_date", "what_if", "penalty", "guaranteed", "earned", "prior_earned", "current_year_earned",
      "tcv", "contract_length", "years_remaining", "years_played", "acquisition_week", "eligible_weeks", "current_year_salary", "completed_weeks",
      "basis", "exempt", "earned_rule", "week_authority_source", "acquisition_week_source", "notes",
      "guards.g1", "guards.g2.applies", "guards.g2.auction_start", "guards.g2.auction_start_source", "guards.g2.route_view", "guards.g2.canon_view",
    ],
  },

  async run({ args, now, routeGet, knowledge }) {
    if (!knowledge || !knowledge.leagueId || !knowledge.currentSeason) {
      return { status: "error", error: { code: "missing_knowledge", message: "knowledge.leagueId and knowledge.currentSeason are required" } };
    }
    const season = Number(knowledge.currentSeason);
    const today = isoDay(now instanceof Date ? now : new Date());
    const dropArg = args.drop_date == null ? null : String(args.drop_date);
    const whatIf = ["drop_date", "acquisition_week", "salary", "contractStatus", "contractInfo", "contractYear"].some((k) => args[k] !== undefined);
    const prov = { route: R_PREVIEW, season: String(season), player_id: String(args.player_id), what_if: whatIf, rules: "current" };

    if (dropArg !== null && (!validDate(dropArg) || Number(dropArg.slice(0, 4)) !== season)) {
      return refuse("unverified_calculation", "the drop date is not a valid date inside the season being priced",
        { what: "drop_date outside the current season", why: "unsupported_as_of", source_needed: "a drop date within the current season" }, prov);
    }

    // 1. The charged calculator. Season and league are always explicit (the route would otherwise default to a hard-coded 2026).
    const params = { L: knowledge.leagueId, YEAR: String(season), player_id: String(args.player_id) };
    if (dropArg !== null) params.drop_date = dropArg;
    for (const k of ["acquisition_week", "salary", "contractStatus", "contractInfo", "contractYear"]) if (args[k] !== undefined) params[k] = String(args[k]);
    const pre = await routeGet(R_PREVIEW, params);
    if (pre.status === 404) {
      return { status: "no_record", coverage: { supported: true, gaps: [{ what: "that player is not on any roster right now", why: "NO_RECORD", source_needed: "a currently rostered player id" }] }, provenance: prov };
    }
    const r = pre.json;
    if (!pre.ok || !r || r.ok !== true) {
      return { status: "error", error: { code: "route_failed", message: `/api/cap-penalty/preview answered ${pre.status}` } };
    }

    // 2. The calculator itself could not price it (held for review, unstamped, week authority unresolved): never a number.
    if (r.needs_review === true || UNPRICED_BASES.has(s(r.basis)) || !Number.isFinite(Number(r.penalty))) {
      return refuse("unverified_calculation", "the charged calculator held this cut for review instead of pricing it (unreadable week authority, unstamped contract or acquisition week); a held row is not a $0",
        { what: "the drop penalty is not priced yet", why: "unverified_calculation", source_needed: "MFL scoring and transactions readable, and a stamped contract for the player" }, { ...prov, basis: safeToken(r.basis) });
    }

    // The basis reaches a fact and the data: it must be a plain token (guarantee_minus_earned, tag_pre_auction_exempt, ...), never route prose.
    const basis = safeToken(r.basis);
    if (!basis) {
      return refuse("unverified_calculation", "the calculator's pricing basis is not a plain token, so the quote is not used",
        { what: "a readable pricing basis", why: "unverified_calculation", source_needed: "a calculator answer with a plain basis token" }, prov);
    }

    // 3. The player's own contract text and status: what-if overrides win (the route used them); otherwise the roster workbench.
    let info = args.contractInfo !== undefined ? s(args.contractInfo) : null;
    let status = args.contractStatus !== undefined ? s(args.contractStatus) : null;
    if (info === null || status === null) {
      const wb = await routeGet(R_WORKBENCH, { L: knowledge.leagueId, YEAR: String(season), NO_CACHE: "1" });
      const p = wb.ok && wb.json && wb.json.ok === true ? findPlayer(wb.json, args.player_id) : null;
      if (!p) {
        return refuse("incomplete_contract_data", "the player's contract text could not be read from the roster workbench, so the quote cannot be checked against the contract",
          { what: "the player's contractInfo and status", why: "NO_RECORD", source_needed: "the player's row in /roster-workbench" }, { ...prov, guard: "G1" });
      }
      if (info === null) info = s(p.special) === "-" ? "" : s(p.special);
      if (status === null) status = s(p.type) === "-" ? "" : s(p.type);
    }

    // 4. G1: no guessed earned salary.
    const exempt = r.exempt === true;
    const g1 = { checked: !STATUS_ONLY_BASES.has(s(r.basis)), year_tokens_verified: false };
    if (g1.checked) {
      const tk = readTokens(info);
      const played = Math.max(0, Number(r.years_played) || 0);
      const why = (reason) => refuse("incomplete_contract_data", reason,
        { what: "the contract's year-by-year salaries (Y1-nK tokens) for the completed years, with CL and TCV", why: "NO_RECORD", source_needed: "a contractInfo with CL, TCV and a salary token for every completed contract year" }, { ...prov, guard: "G1" });
      if (!info) return why("the player's contractInfo is blank, so earned salary would be guessed");
      if (!tk.hasCl || !tk.hasTcv) return why("the contractInfo has no CL or no TCV token, so the calculator would substitute the salary for the contract value");
      if (played > 0) {
        let sum = 0;
        for (let i = 1; i <= played; i += 1) {
          if (tk.years[i] == null) return why("the contractInfo has no year-by-year salary for every completed contract year, so earned salary would be an AAV-times-years guess");
          sum += tk.years[i];
        }
        // (the $1,000-a-year class reports earned as not applicable, null: nothing to compare, but the tokens above are still required)
        if (r.prior_earned != null && Math.round(Number(r.prior_earned)) !== sum) {
          return refuse("unverified_calculation", "the calculator's earned-to-date does not match the contract's own year-by-year salaries, so neither is quoted",
            { what: "earned salary could not be verified against the contract's year-by-year salaries", why: "unverified_calculation", source_needed: "the calculator and the contract text agreeing" }, { ...prov, guard: "G1" });
        }
        g1.year_tokens_verified = true;
      }
    }

    // 5. G2: a tag cut judged by Aug 1 / today instead of the FA Auction start.
    const g2 = { applies: /tag/i.test(status) };
    if (g2.applies) {
      const aug1 = `${season}-08-01`;
      const start = await resolveAuctionStart({ knowledge, season, routeGet });
      const refuseTag = (reason, gap) => refuse("tag_cutoff_unreliable", reason, gap, { ...prov, guard: "G2" });
      if (!start) {
        return refuseTag("a tag cut is priced against the FA Auction start, and that date could not be resolved",
          { what: "the FA Auction start date for this season", why: "NO_RECORD", source_needed: "the FA Auction start date in the league calendar" });
      }
      if (start.date > aug1) {
        return refuseTag("the FA Auction start resolved to a date after the calculator's own cutoff, so the two cannot be reconciled",
          { what: "a consistent FA Auction start date", why: "unverified_calculation", source_needed: "the league calendar's FA Auction start" });
      }
      const drop = dropArg || today;
      const bothBefore = today < start.date && drop < start.date;
      const bothAfter = today >= aug1 && drop >= aug1;
      if (!bothBefore && !bothAfter) {
        return refuseTag("for a tag contract the calculator judges the cut by today's date against Aug 1, while canon uses the FA Auction start; on these dates they can disagree",
          { what: "a tag-cut quote for this drop date", why: "unverified_calculation", source_needed: "the charged calculator aligned to canon (tag cutoff = FA Auction start)" });
      }
      const routeExempt = s(r.basis) === "tag_pre_auction_exempt";
      if ((bothBefore && !routeExempt) || (bothAfter && routeExempt)) {
        return refuseTag("the calculator's own tag treatment does not match the expected one for these dates, so it is not quoted",
          { what: "a tag-cut quote the calculator and canon agree on", why: "unverified_calculation", source_needed: "the charged calculator aligned to canon (tag cutoff = FA Auction start)" });
      }
      Object.assign(g2, { auction_start: start.date, auction_start_source: start.source, route_view: routeExempt ? "cap-free" : "standard formula", canon_view: bothBefore ? "cap-free" : "standard formula" });
    }

    // 6. A quote. Every number is the calculator's; nothing is recomputed here.
    const asOf = dropArg || "current";
    const label = (what) => `${what} (current-rule quote${whatIf ? ", what-if inputs" : ""}; the worker's charged calculator)`;
    const f = (key, lab, value, unit) => ({ key, label: lab, value, unit, as_of: asOf, source: SOURCE, grade: "C" });
    const facts = [f("penalty", label("Drop penalty if cut"), Number(r.penalty), "usd")];
    if (Number.isFinite(Number(r.guaranteed)) && r.guaranteed != null) facts.push(f("guaranteed", label("Guaranteed amount (75% of TCV)"), Number(r.guaranteed), "usd"));
    if (r.earned != null && Number.isFinite(Number(r.earned))) facts.push(f("earned", label("Salary earned to the drop date"), Number(r.earned), "usd"));
    if (Number(r.tcv) > 0) facts.push(f("tcv", label("Total contract value used"), Number(r.tcv), "usd"));
    if (Number.isFinite(Number(r.years_remaining))) facts.push(f("years_remaining", label("Contract years remaining"), Number(r.years_remaining), "years"));
    if (Number.isFinite(Number(r.earned_through_week)) && r.earned_through_week != null) facts.push(f("completed_weeks", label("Completed payable NFL weeks counted"), Number(r.earned_through_week), "count"));
    if (r.acquisition_week) facts.push(f("acquisition_week", label("Acquisition week used for the earning window"), Number(r.acquisition_week), "week"));
    facts.push(f("basis", label("Pricing basis"), basis, "text"));

    return {
      status: "ok",
      data: {
        player_id: String(args.player_id), franchise_id: s(r.franchise_id).replace(/\D/g, "").slice(0, 4), season, drop_date: dropArg || today, what_if: whatIf,
        penalty: Number(r.penalty), guaranteed: r.guaranteed == null ? null : Number(r.guaranteed), earned: r.earned == null ? null : Number(r.earned),
        prior_earned: r.prior_earned == null ? null : Number(r.prior_earned), current_year_earned: r.current_year_earned == null ? null : Number(r.current_year_earned),
        tcv: Number(r.tcv) || null, contract_length: r.cl == null ? null : Number(r.cl), years_remaining: Number(r.years_remaining), years_played: Number(r.years_played),
        acquisition_week: r.acquisition_week == null ? null : Number(r.acquisition_week), eligible_weeks: r.eligible_weeks == null ? null : Number(r.eligible_weeks),
        current_year_salary: r.current_year_salary == null ? null : Number(r.current_year_salary),
        completed_weeks: r.earned_through_week == null ? null : Number(r.earned_through_week),
        basis, exempt, earned_rule: safeToken(r.earned_rule) || null,
        week_authority_source: safeToken(r.week_authority_source), acquisition_week_source: safeToken(r.acquisition_week_source),
        notes: ["Current rules only. Which season's cap the charge lands on (canon 3.C buckets) is not part of this quote."],
        guards: { g1, g2 },
      },
      facts,
      coverage: { supported: true, gaps: [] },
      provenance: { ...prov, basis, calculated_at: safeToken(r.calculated_at), guards: { g1: g1.checked ? (g1.year_tokens_verified ? "passed (year-by-year salaries verified)" : "passed (no completed years)") : "not needed (cap-free by status alone)", g2: g2.applies ? "passed (route and canon agree)" : "not a tag contract" } },
      freshness: { calculated_at: safeToken(r.calculated_at) },
    };
  },
});
