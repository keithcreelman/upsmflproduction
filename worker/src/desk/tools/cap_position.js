// Commissioner Desk tool 6: cap.position
// A franchise's cap position for the CURRENT season: committed salary, salary adjustments, cap used, cap available (and, only on request,
// the canon max-bid reserve). Read from the Worker's own /roster-workbench route, which applies worker/src/cap_math.js:
//   cap hit = $0 for a taxi player, $0 for a KNOWN-expired contract (years remaining <= 0), 50% of salary for injured reserve,
//             otherwise the salary MFL holds; a contract MFL has said NOTHING about still counts its salary.
//   cap used = sum of cap hits + sum of salary adjustments. A POSITIVE salary adjustment is a CHARGE (it raises cap used); a negative one is a credit.
// The numbers are never recomputed by hand: the route's totals are re-derived with cap_math.js over the route's own player rows and the tool
// REFUSES if the two disagree, or if the route reports any unresolved input (blank salary, unreadable adjustment).
import { defineTool } from "../registry.js";
import { safeTeamName, safePlayerName, safeToken, cleanName } from "./shared_text.js";
import { currentCapHit } from "../../cap_math.js";

const ROUTE = "/roster-workbench";
const SOURCE = "MFL via /roster-workbench (cap_math.js)";
const SIGN = "positive = a charge that raises cap used, negative = a credit";
const MIN_ROSTER = 27;                 // canon section 6.F / B1: the roster minimum the max-bid reserve is measured against
const RESERVE_PER_SLOT = 1000;

const pad4 = (v) => String(v == null ? "" : v).replace(/\D/g, "").padStart(4, "0").slice(-4);
const int = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : null; };

// Route text (team and player names) reaches facts and data only through the shared screen (shared_text.js).
const teamLabel = (name, id) => safeTeamName(name, id);

function refuse(code, reason, gap, provenance) {
  return {
    status: "refused", data: null, facts: [],
    coverage: { supported: false, gaps: [gap] },
    provenance: provenance || {}, refusal: { code, reason },
  };
}

export default defineTool({
  id: "cap.position",
  version: "1.0.0",
  description:
    "A franchise's salary-cap position for the CURRENT season: committed salary, salary adjustments (positive = a charge, negative = a credit), cap used and cap available. " +
    "Taxi players count $0, injured-reserve players 50%, known-expired contracts $0. Set include_max_bid=true for the canon max-bid reserve " +
    "(cap available minus $1K per roster slot short of 27; position minimums are NOT included). " +
    "Current season only: it cannot say what a cap position was on a past date. It refuses rather than guess when MFL has a blank salary or an unreadable adjustment.",
  phase: "P1",
  dataClass: "P0",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      franchise_id: { type: "string", pattern: "^\\d{1,4}$", maxLength: 4, description: "Franchise id, e.g. 0008 or 8." },
      include_max_bid: { type: "boolean", description: "Also return the canon max-bid reserve (roster-minimum reserve only)." },
    },
    required: ["franchise_id"],
  },
  asOf: { supports: "current" },
  allowlist: { routes: [{ path: ROUTE, params: ["L", "YEAR", "NO_CACHE"] }], modules: ["cap_math.js"], tables: [] },
  output: {
    allow: [
      "season", "franchise_id", "franchise_name", "sign_convention",
      "salary_cap", "committed_salary", "salary_adjustments", "adjustment_breakdown.cut_players", "adjustment_breakdown.traded_salary", "adjustment_breakdown.other",
      "cap_used", "cap_available", "roster_count", "taxi_count", "ir_count", "max_bid", "max_bid_basis",
      "players[].id", "players[].name", "players[].status", "players[].salary", "players[].years", "players[].contract_unknown", "players[].cap_hit",
    ],
  },
  freshness: { maxAgeHours: 1 },

  async run({ args, routeGet, knowledge }) {
    if (!knowledge || !knowledge.leagueId || !knowledge.currentSeason) {
      return { status: "error", error: { code: "missing_knowledge", message: "knowledge.leagueId and knowledge.currentSeason are required" } };
    }
    const season = String(knowledge.currentSeason);
    const fid = pad4(args.franchise_id);
    const prov = { route: ROUTE, season, no_cache: true, module: "cap_math.js" };

    const res = await routeGet(ROUTE, { L: knowledge.leagueId, YEAR: season, NO_CACHE: "1" });
    const body = res.json;
    if (!res.ok || !body || body.ok !== true || !Array.isArray(body.teams)) {
      return { status: "error", error: { code: "route_failed", message: `/roster-workbench answered ${res.status}` } };
    }
    const team = body.teams.find((t) => pad4(t && t.franchise_id) === fid);
    if (!team) {
      return { status: "no_record", coverage: { supported: true, gaps: [{ what: `franchise ${fid} is not in the league's franchise list for ${season}`, why: "NO_RECORD", source_needed: "a valid franchise id" }] }, provenance: prov };
    }
    const sum = team.summary || {};
    const cap = int(body.salary_cap_dollars);
    const committed = int(sum.cap_total_dollars);
    const adj = int(sum.salary_adjustment_total_dollars);
    const unresolved = Array.isArray(sum.cap_unresolved) ? sum.cap_unresolved : [];

    // Fail closed on anything the route itself could not resolve (the trade gate does the same).
    if (unresolved.length) {
      return refuse("unverified_calculation", "the roster workbench reports unresolved cap inputs (a blank salary or an unreadable salary adjustment), so cap used cannot be stated",
        { what: "cap used cannot be computed from MFL data as it stands", why: "unverified_calculation", source_needed: "every rostered salary and every salary adjustment readable in MFL" }, prov);
    }
    if (committed == null || adj == null || cap == null || !(cap > 0)) {
      return refuse("unverified_calculation", "the roster workbench did not return the salary cap, committed salary or adjustment total",
        { what: "salary cap, committed salary or adjustment total missing from the route", why: "unverified_calculation", source_needed: "a readable /roster-workbench response" }, prov);
    }

    // Per-player cap hit with the SAME cap_math rule; the sum must equal the route's own total.
    const players = (Array.isArray(team.players) ? team.players : []).map((p) => {
      const hit = currentCapHit({ salary: int(p.salary), years: Math.max(0, int(p.years) || 0), taxi: !!p.is_taxi, ir: !!p.is_ir, unknown: !!p.contract_unknown });
      return { id: String(p.id), name: safePlayerName(p.name, String(p.id)), status: safeToken(p.status), salary: int(p.salary), years: int(p.years), contract_unknown: !!p.contract_unknown, is_taxi: !!p.is_taxi, is_ir: !!p.is_ir, cap_hit: hit };
    });
    const recomputed = players.reduce((a, p) => a + p.cap_hit, 0);
    if (recomputed !== committed) {
      return refuse("unverified_calculation", "the route's committed-salary total and cap_math.js disagree over the same player rows, so neither is quoted",
        { what: "committed salary could not be verified against cap_math.js", why: "unverified_calculation", source_needed: "route and cap_math.js agreeing on the roster" }, prov);
    }

    const used = committed + adj;
    const available = cap - used;
    const taxi = players.filter((p) => p.is_taxi).length;
    const ir = players.filter((p) => p.is_ir).length;
    const rosterCount = players.length - taxi;      // the auction's own roster count: everything except taxi (IR counts)
    const asOf = "current";
    const f = (key, label, value, unit, grade) => ({ key, label, value, unit, as_of: asOf, source: SOURCE, grade });
    const teamId = pad4(team.franchise_id);
    const facts = [
      f("franchise_id", "Franchise id this cap position belongs to", teamId, "id", "A"),
      f("team_name", "Team name as the roster workbench returns it", teamLabel(team.franchise_name, teamId), "text", "A"),
      f("salary_cap", "Salary cap amount (MFL league setting)", cap, "usd", "A"),
      f("committed_salary", "Committed salary: sum of current cap hits (taxi $0, IR 50%, expired $0; an unknown contract counts its salary)", committed, "usd", "C"),
      f("salary_adjustments", `Salary adjustments total (${SIGN})`, adj, "usd", "C"),
      f("cap_used", `Cap used = committed salary + salary adjustments (${SIGN})`, used, "usd", "C"),
      f("cap_available", "Cap available = salary cap - cap used (negative means over the cap)", available, "usd", "C"),
      f("roster_count", "Players on the roster excluding the taxi squad (IR counts)", rosterCount, "count", "C"),
    ];
    for (const p of players) {
      if (p.is_ir) facts.push(f(`p${p.id}_cap_hit`, `${p.name || p.id} (injured reserve): cap hit = 50% of salary`, p.cap_hit, "usd", "C"));
      if (p.is_taxi) facts.push(f(`p${p.id}_cap_hit`, `${p.name || p.id} (taxi squad): cap hit is $0`, p.cap_hit, "usd", "C"));
    }

    const gaps = [];
    let maxBid = null;
    if (args.include_max_bid === true) {
      const slotsShort = Math.max(0, MIN_ROSTER - rosterCount);
      maxBid = available - RESERVE_PER_SLOT * slotsShort;
      facts.push(f("max_bid", "Max bid = cap available - $1K per roster slot short of 27 (canon 6.F; position minimums NOT included)", maxBid, "usd", "C"));
      gaps.push({ what: "max bid reserves $1K per slot short of the 27-player minimum only; it ignores slots owed to position minimums, which can lower it", why: "partial_coverage", source_needed: "the auction lineup-needs calculation (not exposed as a route)" });
    }

    return {
      status: "ok",
      data: {
        season: Number(season), franchise_id: pad4(team.franchise_id), franchise_name: cleanName(team.franchise_name) || "", sign_convention: SIGN,
        salary_cap: cap, committed_salary: committed, salary_adjustments: adj,
        adjustment_breakdown: {
          cut_players: int(sum.salary_adjustment_breakdown_dollars && sum.salary_adjustment_breakdown_dollars.cut_players_dollars),
          traded_salary: int(sum.salary_adjustment_breakdown_dollars && sum.salary_adjustment_breakdown_dollars.traded_salary_dollars),
          other: int(sum.salary_adjustment_breakdown_dollars && sum.salary_adjustment_breakdown_dollars.other_dollars),
        },
        cap_used: used, cap_available: available, roster_count: rosterCount, taxi_count: taxi, ir_count: ir,
        ...(maxBid != null ? { max_bid: maxBid, max_bid_basis: "cap available minus $1K per slot short of 27; position minimums not included" } : {}),
        players: players.map(({ is_taxi, is_ir, ...rest }) => rest),
      },
      facts,
      coverage: { supported: true, gaps },
      provenance: { ...prov, contract_note: "contract values are not recomputed; salaries and years come from the route" },
      freshness: { generated_at: String(body.generated_at || ""), cache: "bypassed" },
    };
  },
});
