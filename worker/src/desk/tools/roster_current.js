// Commissioner Desk tool 5: roster.current
// A franchise's current roster and contracts, read from the Worker's own /roster-workbench route.
//
// Hard rules for this adapter (docs/ai_desk/DESK_CONTRACT.md, tool 5):
//   - it ALWAYS sends NO_CACHE=1 (the route then neither reads nor writes the shared edge cache), and L + YEAR explicitly;
//   - it never sends the route's optional caller-supplied override parameters (such as EXT_URL), and the allowlist below does not list them; it always sends NO_CACHE=1 so a desk read never uses or fills the shared edge cache;
//   - contractInfo is passed through exactly as the route serves it (`special`): no token is re-derived here. AAV is never TCV / length,
//     and MFL's contractYear is YEARS REMAINING;
//   - output is projected to an explicit allowlist: nothing else the route returns (owner e-mails, upstream URLs, raw adjustment rows,
//     extension previews, taxi internals) can leave this tool.
import { defineTool } from "../registry.js";
import { safeTeamName, safePlayerName, safeToken, safeText, cleanName } from "./shared_text.js";

const ROUTE = "/roster-workbench";
const SOURCE = "MFL via /roster-workbench";

// Route values are validated by SHAPE before use; an id-like or number-like string that is not exactly that is dropped, never copied.
const pad4 = (v) => { const x = String(v == null ? "" : v).trim(); return /^\d{1,4}$/.test(x) ? x.padStart(4, "0") : null; };      // franchise id
const pidOf = (v) => { const x = String(v == null ? "" : v).trim(); return /^\d{1,8}$/.test(x) ? x : null; };                       // player id
const num = (v) => ((typeof v === "number" || (typeof v === "string" && /^-?\d{1,12}(\.\d+)?$/.test(v.trim()))) && Number.isFinite(Number(v)) ? Number(v) : null);
// A timestamp is parsed and RE-EMITTED by this tool; the route's own string is never copied.
const isoOf = (v) => {
  const x = String(v == null ? "" : v).trim();
  if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})?$/.test(x)) return null;
  const ms = Date.parse(x);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

// Route text (team and player names, contract strings) reaches facts and data only through the shared screen (shared_text.js).
const teamLabel = (name, id) => safeTeamName(name, id);

function missing(knowledge) {
  if (!knowledge || !knowledge.leagueId) return "knowledge.leagueId";
  if (!knowledge.currentSeason) return "knowledge.currentSeason";
  return null;
}

export default defineTool({
  id: "roster.current",
  version: "1.0.0",
  description:
    "A franchise's CURRENT roster with each player's contract exactly as MFL and the Front Office serve it (salary, years remaining, status, contractInfo text). " +
    "Answers 'who is on franchise X and on what contract'. Current state only: it cannot say who was on a roster on a past date. " +
    "Contract text is shown as recorded; this tool never recomputes AAV, TCV or any contract value.",
  phase: "P1",
  dataClass: "P0",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      franchise_id: { type: "string", pattern: "^\\d{1,4}$", maxLength: 4, description: "Franchise id, e.g. 0008 or 8." },
    },
    required: ["franchise_id"],
  },
  asOf: { supports: "current" },
  // EXT_URL is deliberately absent: the registry rejects any parameter that is not listed here.
  allowlist: { routes: [{ path: ROUTE, params: ["L", "YEAR", "NO_CACHE"] }], modules: [], tables: [] },
  output: {
    allow: [
      "season", "franchise_id", "franchise_name", "franchise_abbrev", "generated_at", "source",
      "players[].id", "players[].name", "players[].position", "players[].nfl_team", "players[].salary", "players[].years",
      "players[].type", "players[].special", "players[].status", "players[].is_taxi", "players[].is_ir",
      "players[].contract_unknown", "players[].salary_unresolved", "players[].taxi_eligible", "players[].taxi_callups_used",
      "counts.players", "counts.active", "counts.taxi", "counts.ir", "counts.contract_unknown",
    ],
  },
  freshness: { maxAgeHours: 1 },

  async run({ args, now, routeGet, knowledge }) {
    const gone = missing(knowledge);
    if (gone) return { status: "error", error: { code: "missing_knowledge", message: `${gone} was not supplied` } };
    const season = String(knowledge.currentSeason);
    const fid = pad4(args.franchise_id);

    const res = await routeGet(ROUTE, { L: knowledge.leagueId, YEAR: season, NO_CACHE: "1" });
    const body = res.json;
    if (!res.ok || !body || body.ok !== true || !Array.isArray(body.teams)) {
      return { status: "error", error: { code: "route_failed", message: `/roster-workbench answered ${res.status}` } };
    }
    const team = body.teams.find((t) => pad4(t && t.franchise_id) === fid);
    if (!team) {
      return {
        status: "no_record",
        coverage: { supported: true, gaps: [{ what: `franchise ${fid} is not in the league's franchise list for ${season}`, why: "NO_RECORD", source_needed: "a valid franchise id" }] },
        provenance: { route: ROUTE, season, no_cache: true },
      };
    }

    if (num(body.season) !== Number(season)) {
      return { status: "error", error: { code: "route_failed", message: "the roster workbench answered for a different season than asked" } };
    }
    const rawPlayers = Array.isArray(team.players) ? team.players : [];
    const validRows = rawPlayers.filter((p) => p && typeof p === "object" && pidOf(p.id) !== null);
    const droppedRows = rawPlayers.length - validRows.length;
    const players = validRows.map((p) => ({
      id: pidOf(p.id),
      name: safePlayerName(p.name, pidOf(p.id)),
      position: safeToken(p.position),
      nfl_team: safeToken(p.nfl_team),
      salary: num(p.salary),
      years: num(p.years),
      type: safeToken(p.type),
      special: safeText(p.special, 160),                          // contractInfo: served as is when it passes the screen, withheld otherwise
      special_withheld: !!(p.special && p.special !== "-" && !safeText(p.special, 160)),
      status: safeToken(p.status),
      is_taxi: !!p.is_taxi,
      is_ir: !!p.is_ir,
      contract_unknown: !!p.contract_unknown,
      salary_unresolved: !!p.salary_unresolved,
      taxi_eligible: !!p.taxi_eligible,
      taxi_callups_used: num(p.taxi_callups_used) || 0,
    }));
    const taxi = players.filter((p) => p.is_taxi).length;
    const ir = players.filter((p) => p.is_ir).length;
    const unknown = players.filter((p) => p.contract_unknown).length;
    const counts = { players: players.length, active: players.length - taxi, taxi, ir, contract_unknown: unknown };

    const asOf = "current";
    const teamId = pad4(team.franchise_id);
    const facts = [
      { key: "franchise_id", label: "Franchise id this roster belongs to", value: teamId, unit: "id", as_of: asOf, source: SOURCE, grade: "A" },
      { key: "team_name", label: "Team name as the roster workbench returns it", value: teamLabel(team.franchise_name, teamId), unit: "text", as_of: asOf, source: SOURCE, grade: "A" },
      { key: "player_count", label: "Players on the roster (active, IR and taxi)", value: counts.players, unit: "count", as_of: asOf, source: SOURCE, grade: "A" },
      { key: "active_count", label: "Players on the roster excluding the taxi squad (IR counts)", value: counts.active, unit: "count", as_of: asOf, source: SOURCE, grade: "A" },
      { key: "taxi_count", label: "Players on the taxi squad", value: counts.taxi, unit: "count", as_of: asOf, source: SOURCE, grade: "A" },
      { key: "ir_count", label: "Players on injured reserve", value: counts.ir, unit: "count", as_of: asOf, source: SOURCE, grade: "A" },
    ];
    for (const p of players) {
      const who = p.name || p.id;
      if (!p.salary_unresolved && p.salary != null) {
        facts.push({ key: `p${p.id}_salary`, label: `${who}: current-year salary`, value: p.salary, unit: "usd", as_of: asOf, source: SOURCE, grade: "A" });
      }
      if (p.years != null && !p.contract_unknown) {
        facts.push({ key: `p${p.id}_years_remaining`, label: `${who}: contract years REMAINING (MFL contractYear)`, value: p.years, unit: "years", as_of: asOf, source: SOURCE, grade: "A" });
      }
      if (p.special && p.special !== "-") {
        facts.push({ key: `p${p.id}_contract`, label: `${who}: contractInfo as served by the roster workbench`, value: p.special, unit: "text", as_of: asOf, source: SOURCE, grade: "A" });
      }
    }

    const gaps = [];
    if (droppedRows) {
      gaps.push({ what: `${droppedRows} roster row(s) had an unreadable player id and are left out`, why: "partial_coverage", source_needed: "a well-formed roster response from MFL" });
    }
    if (unknown) {
      gaps.push({ what: "some players have no contract stamped in MFL (status, length and info all blank); their contracts are unknown, not zero", why: "partial_coverage", source_needed: "a stamped contract in MFL for those players" });
    }
    const withheld = players.filter((p) => p.special_withheld).length;
    if (withheld) {
      gaps.push({ what: `${withheld} player contractInfo string(s) failed the text safety screen and are withheld`, why: "partial_coverage", source_needed: "a plain contractInfo string in MFL for those players" });
    }
    const unresolved = players.filter((p) => p.salary_unresolved && !p.is_taxi).length;
    if (unresolved) {
      gaps.push({ what: "some players have a blank salary in MFL (blank is not $0)", why: "partial_coverage", source_needed: "a salary recorded in MFL for those players" });
    }

    const generatedAt = isoOf(body.generated_at);
    const generatedMs = generatedAt ? Date.parse(generatedAt) : NaN;
    const nowMs = now instanceof Date ? now.getTime() : Date.now();
    if (!generatedAt) gaps.push({ what: "the roster workbench gave no readable generation time, so the age of this roster is unknown", why: "partial_coverage", source_needed: "a timestamped roster response" });
    return {
      status: "ok",
      data: {
        season: Number(season), franchise_id: teamId, franchise_name: cleanName(team.franchise_name) || "",
        franchise_abbrev: cleanName(team.franchise_abbrev) || "", generated_at: generatedAt, source: SOURCE,
        players, counts,
      },
      facts,
      coverage: { supported: true, gaps },
      provenance: {
        route: ROUTE, season, no_cache: true, ext_url_sent: false,
        contract_info_source: "roster-workbench `special` (the Front Office's display-normalized contractInfo; tokens not re-derived by the desk)",
      },
      freshness: { generated_at: generatedAt, age_seconds: Number.isFinite(generatedMs) ? Math.max(0, Math.round((nowMs - generatedMs) / 1000)) : null, cache: "bypassed" },
    };
  },
});
