// Commissioner Desk tool 9: extension.price
// What a 1-year (Ext1) or 2-year (Ext2) extension costs under the CURRENT rules (canon section 6 / C4: Schedule 1 +$10K / +$20K for QB RB WR TE,
// Schedule 2 +$3K / +$5K for DL LB DB PK PN; forward-looking TCV; GTD 75%). The price comes from worker/src/extension_pricing.js, the
// one canonical pricing module every Worker surface already uses (pure, no I/O); this tool only feeds it the player's contract and reports its
// answer. It does not change or re-implement the module.
//
// Two input modes:
//   player_id          the contract is read from the Worker's /roster-workbench (NO_CACHE=1), the same contract the Front Office shows;
//   position + years_remaining + salary + contract_info    a pure what-if on a contract the caller states (labeled as such).
//
// Refusals pass through unchanged: the module refuses an expired contract (an expired rookie's salary is a wiped field), a contract with
// more than one year left, a loaded (FL / BL) extension, an unknown position, and missing inputs. A refusal is never turned into a number.
// This tool also refuses when the AAV would have to be derived as TCV / length because the contract has no AAV token (AAV is never TCV / length).
//
// Rounding: canon gives NO rounding rule for extensions. The module rounds each amount to the nearest $1K, halves up. When the contract's
// AAV token or salary is not a whole $1K (for example AAV 16.5K) the number is returned WITH a caveat gap saying the rounding is not stated in canon.
import { defineTool } from "../registry.js";
import { priceExtension, parseContractInfo, PRICING_VERSION } from "../../extension_pricing.js";

const R_WORKBENCH = "/roster-workbench";
const SOURCE = `extension_pricing.js ${PRICING_VERSION}`;

const MISSING_INPUT = new Set(["pricing_position_unavailable", "pricing_contract_unreadable", "pricing_salary_unreadable", "pricing_aav_unavailable"]);
const s = (v) => String(v == null ? "" : v).trim();

function refuse(code, reason, gap, provenance) {
  return { status: "refused", data: null, facts: [], coverage: { supported: false, gaps: [gap] }, provenance: provenance || {}, refusal: { code, reason } };
}

function findPlayer(body, playerId) {
  for (const t of Array.isArray(body && body.teams) ? body.teams : []) {
    for (const p of Array.isArray(t && t.players) ? t.players : []) if (String(p.id) === String(playerId)) return p;
  }
  return null;
}

export default defineTool({
  id: "extension.price",
  version: "1.0.0",
  description:
    "Price a 1-year (Ext1) or 2-year (Ext2) extension under the CURRENT rules with the league's canonical extension pricing module: new AAV, new total contract value (TCV) and guarantee. " +
    "Give player_id to price a rostered player from his current contract, or give position, years_remaining, salary and contract_info for a what-if. " +
    "Only a final-year contract (one year left) can be priced; it refuses expired contracts, contracts with more than a year left, loaded (FL/BL) extensions and unknown positions rather than guess. " +
    "Canon states no rounding rule for extensions: when the contract's AAV or salary is not a whole $1K the answer carries a rounding caveat. Current rules only.",
  phase: "P1",
  dataClass: "P0",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      years: { type: "integer", minimum: 1, maximum: 2, description: "Extension length: 1 (Ext1) or 2 (Ext2)." },
      player_id: { type: "string", pattern: "^\\d{3,6}$", maxLength: 6, description: "MFL player id of a rostered player (reads his current contract)." },
      position: { type: "string", pattern: "^[A-Za-z]{1,4}$", maxLength: 4, description: "What-if: position (QB RB WR TE DL LB DB PK PN)." },
      years_remaining: { type: "integer", minimum: 0, maximum: 6, description: "What-if: contract years REMAINING (MFL contractYear)." },
      salary: { type: "integer", minimum: 0, maximum: 400000, description: "What-if: current-year salary in dollars." },
      contract_info: { type: "string", pattern: "^[A-Za-z0-9 |,.:\\-]{1,190}$", maxLength: 190, description: "What-if: contractInfo text, e.g. 'CL 1| TCV 17K| AAV 17K'." },
      loaded: { type: "string", enum: ["NONE", "FL", "BL"], description: "Loaded treatment. Only NONE can be priced." },
    },
    required: ["years"],
  },
  asOf: { supports: "current" },
  allowlist: { routes: [{ path: R_WORKBENCH, params: ["L", "YEAR", "NO_CACHE"] }], modules: ["extension_pricing.js"], tables: [] },
  output: {
    allow: [
      "mode", "player_id", "player_name", "position_group", "schedule", "escalator", "extension_years", "contract_length", "status",
      "salary_year1", "aav_current", "aav_source", "aav_future", "tcv", "gtd", "salary_by_year", "contract_info", "pricing_version", "inputs.position", "inputs.years_remaining", "inputs.salary", "inputs.contract_info",
    ],
  },

  async run({ args, routeGet, knowledge }) {
    const years = args.years;
    const prov = { module: "extension_pricing.js", pricing_version: PRICING_VERSION };
    const loaded = args.loaded || "NONE";
    const hasStated = [args.position, args.years_remaining, args.salary, args.contract_info].every((v) => v !== undefined);
    const anyStated = [args.position, args.years_remaining, args.salary, args.contract_info].some((v) => v !== undefined);
    let mode, name = null, input;

    if (args.player_id !== undefined) {
      if (anyStated) return refuse("unverified_calculation", "give either a player_id or a full what-if contract, not both", { what: "a single, unambiguous contract to price", why: "unverified_calculation", source_needed: "player_id alone, or position + years_remaining + salary + contract_info" }, prov);
      if (!knowledge || !knowledge.leagueId || !knowledge.currentSeason) return { status: "error", error: { code: "missing_knowledge", message: "knowledge.leagueId and knowledge.currentSeason are required" } };
      const wb = await routeGet(R_WORKBENCH, { L: knowledge.leagueId, YEAR: String(knowledge.currentSeason), NO_CACHE: "1" });
      if (!wb.ok || !wb.json || wb.json.ok !== true) return { status: "error", error: { code: "route_failed", message: `/roster-workbench answered ${wb.status}` } };
      const p = findPlayer(wb.json, args.player_id);
      if (!p) {
        return { status: "no_record", coverage: { supported: true, gaps: [{ what: "that player is not on any roster right now", why: "NO_RECORD", source_needed: "a currently rostered player id" }] }, provenance: { ...prov, route: R_WORKBENCH } };
      }
      mode = "player";
      name = s(p.name);
      input = { position: s(p.position), yearsRemaining: p.years, salary: p.salary, contractInfo: s(p.special) === "-" ? "" : s(p.special) };
      Object.assign(prov, { route: R_WORKBENCH, season: String(knowledge.currentSeason), contract_source: "roster-workbench (display-normalized contractInfo; the same contract the Front Office shows)" });
    } else if (hasStated) {
      mode = "what_if";
      input = { position: s(args.position), yearsRemaining: args.years_remaining, salary: args.salary, contractInfo: s(args.contract_info) };
      Object.assign(prov, { contract_source: "stated by the caller (not read from MFL)" });
    } else {
      return refuse("incomplete_contract_data", "name a player_id, or state position, years_remaining, salary and contract_info for a what-if",
        { what: "the contract to price", why: "NO_RECORD", source_needed: "player_id, or a complete what-if contract" }, prov);
    }

    const priced = priceExtension({ ...input, term: `${years}YR`, loaded });
    if (!priced.ok) {
      const code = MISSING_INPUT.has(priced.reason) ? "incomplete_contract_data" : "unverified_calculation";
      return refuse(code, `${priced.detail || priced.reason} (module reason: ${priced.reason})`,
        { what: "an extension price for this player", why: MISSING_INPUT.has(priced.reason) ? "NO_RECORD" : "unverified_calculation", source_needed: priced.reason === "expired_contract_not_priced" ? "the draft-slot salary schedule (not wired)" : "an extension-eligible final-year contract with a position, salary and AAV token" },
        { ...prov, module_reason: priced.reason });
    }
    const c = priced.terms;
    if (c.aav_source === "tcv_over_cl") {
      return refuse("incomplete_contract_data", "the contract has no AAV token, and AAV is never derived as TCV divided by length",
        { what: "the contract's AAV token", why: "NO_RECORD", source_needed: "a contractInfo with an AAV token" }, { ...prov, module_reason: "aav_derived_from_tcv_over_cl" });
    }

    // Rounding caveat: a fractional $K in what the module rounds.
    const tiers = parseContractInfo(input.contractInfo).aav_tiers;
    const rawSalary = Number(String(input.salary == null ? "" : input.salary).replace(/[^\d.]/g, ""));
    const fractional = (Number.isFinite(rawSalary) && rawSalary % 1000 !== 0) || (tiers.length > 0 && tiers[0] % 1000 !== 0);
    const gaps = fractional
      ? [{ what: "canon states no rounding rule for extensions; the pricing module rounds each amount to the nearest $1K, halves up, and this contract's AAV or salary is not a whole $1K", why: "unverified_calculation", source_needed: "a canon rounding rule for extension prices" }]
      : [];

    const asOf = "current";
    const lab = (what) => `${what} (${mode === "what_if" ? "what-if contract stated by the caller; " : ""}Ext${years} under current rules)`;
    const f = (key, label, value, unit) => ({ key, label: lab(label), value, unit, as_of: asOf, source: SOURCE, grade: "C" });
    const facts = [
      f("aav_current", "Current AAV the escalator is added to", c.aav_current, "usd"),
      f("aav_future", "New AAV for the extension years", c.aav_future, "usd"),
      f("escalator", "Escalator added to the AAV", c.escalator, "usd"),
      f("salary_year1", "Current-year salary, unchanged", c.salary_year1, "usd"),
      f("tcv", "New total contract value (forward-looking)", c.tcv, "usd"),
      f("gtd", "New guarantee (75% of the new TCV)", c.gtd, "usd"),
      f("contract_length", "New contract length", c.contract_length, "years"),
      f("contract_info", "New contractInfo text", c.contract_info, "text"),
      f("pricing_version", "Pricing module version", PRICING_VERSION, "text"),
    ];

    return {
      status: "ok",
      data: {
        mode, player_id: args.player_id === undefined ? null : String(args.player_id), player_name: name,
        position_group: c.position_group, schedule: c.schedule, escalator: c.escalator, extension_years: c.extension_years, contract_length: c.contract_length, status: c.status,
        salary_year1: c.salary_year1, aav_current: c.aav_current, aav_source: c.aav_source, aav_future: c.aav_future, tcv: c.tcv, gtd: c.gtd, salary_by_year: c.salary_by_year,
        contract_info: c.contract_info, pricing_version: PRICING_VERSION,
        inputs: { position: input.position, years_remaining: Number(input.yearsRemaining), salary: Number(input.salary), contract_info: input.contractInfo },
      },
      facts,
      coverage: { supported: true, gaps },
      provenance: { ...prov, rounding: "nearest $1K, halves up (module behavior; canon gives no rule)" },
      freshness: null,
    };
  },
});
