// Commissioner Desk tool 8: cap.adjustments
// The salary adjustments (drop penalties, traded salary, misc) booked against a season's cap, from GET /api/salary-adjustments/ledger.
// Sign convention (cap_math.js): a POSITIVE adjustment is a CHARGE that raises a team's cap used; a negative one is a credit.
//
// Completeness is labeled by season, and the label travels in the data and in the coverage gaps:
//   2026 and later  complete   (MFL's posted rows + the D1 drop ledger)
//   2017 to 2025    partial    (most drop rows are review_required; traded cap is recorded from 2020 only)
//   2016 and before no record  (the registry answers unsupported_as_of; this tool is never called)
// The route's commissioner-facing "review" block (unsettled and partially settled traded salary) is NOT exposed: it is a settlement
// work list, not a record of what was booked, and it is not on this tool's output allowlist.
import { defineTool } from "../registry.js";
import { cleanName, safePlayerName, safeToken, safeText } from "./shared_text.js";

const ROUTE = "/api/salary-adjustments/ledger";
const SIGN = "positive = a charge that raises the team's cap used, negative = a credit";
const FIRST_SEASON = 2017;
const COMPLETE_FROM = 2026;
const MAX_ROWS = 60;            // rows returned (and facts emitted); the totals always cover every row
const MAX_ROW_FACTS = 40;

const pad4 = (v) => String(v == null ? "" : v).replace(/\D/g, "").padStart(4, "0").slice(-4);
const int = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : null; };
const digits = (v) => String(v == null ? "" : v).replace(/\D/g, "").slice(0, 8);

// Every route-derived free-text value passes the shared screen (shared_text.js) before it reaches data, a fact value or a fact label.
// The row's own description (a commissioner-typed sentence) and a misc row's reason are NOT passed on at all: the row type, kind and
// amount carry what a question needs, and a typed sentence is the riskiest text in the league.
const ROW_TYPES = new Set(["trade", "drop", "misc"]);
const rowType = (v) => { const x = safeToken(v); return ROW_TYPES.has(x) ? x : "adjustment"; };
const teamName = (name, fid) => cleanName(name) || `Team (${fid})`;

function trimRow(r) {
  const d = r.drop && typeof r.drop === "object" ? r.drop : null;
  const tr = r.trade && typeof r.trade === "object" ? r.trade : null;
  const m = r.misc && typeof r.misc === "object" ? r.misc : null;
  const fid = pad4(r.franchise_id);
  return {
    id: safeToken(r.id), franchise_id: fid, franchise_name: teamName(r.franchise_name, fid), type: rowType(r.type), amount: int(r.amount),
    assessed_iso: safeToken(r.assessed_iso), source: safeToken(r.source), in_mfl: !!r.in_mfl,
    drop: d ? {
      player_id: digits(d.player_id), player_name: safePlayerName(d.player_name, digits(d.player_id)), contract_status: safeToken(d.contract_status), contract_info: safeText(d.contract_info, 190),
      original_years: int(d.original_years), years_remaining: int(d.years_remaining), tcv: int(d.tcv), gtd: int(d.gtd), earned: int(d.earned),
      penalty_basis: safeToken(d.penalty_basis), ledger_amount: int(d.ledger_amount), penalty_exempt: !!d.penalty_exempt, details_source: d.details_source == null ? null : (safeToken(d.details_source) || null),
    } : null,
    trade: tr ? { matched: !!tr.matched, counterparty_fid: pad4(tr.counterparty_fid), counterparty_name: teamName(tr.counterparty_name, pad4(tr.counterparty_fid)), traded_at_iso: safeToken(tr.traded_at_iso), three_way: !!tr.three_way } : null,
    misc: m ? { kind: safeToken(m.kind) } : null,
  };
}

// The route's source flags: booleans pass, anything textual is screened.
function cleanSources(src) {
  const out = {};
  for (const [k, v] of Object.entries(src && typeof src === "object" ? src : {})) {
    const key = safeToken(k, 40);
    if (key) out[key] = typeof v === "boolean" ? v : safeToken(v);
  }
  return out;
}

export default defineTool({
  id: "cap.adjustments",
  version: "1.0.0",
  description:
    "Salary adjustments booked against a season's cap (drop penalties, traded salary, misc), for one franchise or the whole league. " +
    "Sign: positive = a charge that raises cap used, negative = a credit. as_of picks the season: 'current' is this season; a past date picks that season. " +
    "Completeness: 2026 and later is complete; 2017 to 2025 is PARTIAL (most drop rows are review_required, traded cap is recorded from 2020 only); 2016 and earlier has no record. " +
    "It cannot reconstruct the ledger as of a past date inside the current season, and it does not return the commissioner's settlement work list.",
  phase: "P1",
  dataClass: "P0",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      franchise_id: { type: "string", pattern: "^\\d{1,4}$", maxLength: 4, description: "Optional franchise id. Omit for the whole league." },
    },
    required: [],
  },
  asOf: {
    supports: "season", from: FIRST_SEASON,
    // A past date inside the current season would need the ledger as it stood that day, which is not stored.
    check(asOf, ctx) {
      if (asOf === "current") return null;
      const season = Number(String(asOf).slice(0, 4));
      if (ctx && ctx.currentSeason && season >= Number(ctx.currentSeason)) {
        return { what: "the ledger cannot be reconstructed as it stood on a past date inside the current season", source_needed: "a dated snapshot of the salary-adjustment ledger" };
      }
      return null;
    },
  },
  allowlist: { routes: [{ path: ROUTE, params: ["L", "YEAR"] }], modules: [], tables: [] },
  output: {
    allow: [
      "season", "completeness", "sign_convention", "franchise_id", "franchise_name", "this_season", "next_season", "rows[]", "rows_returned", "rows_total", "rows_truncated",
    ],
  },

  async run({ args, asOf, routeGet, knowledge }) {
    if (!knowledge || !knowledge.leagueId || !knowledge.currentSeason) {
      return { status: "error", error: { code: "missing_knowledge", message: "knowledge.leagueId and knowledge.currentSeason are required" } };
    }
    const current = Number(knowledge.currentSeason);
    const season = asOf === "current" ? current : Number(String(asOf).slice(0, 4));
    const fid = args.franchise_id ? pad4(args.franchise_id) : null;
    const prov = { route: ROUTE, season: String(season) };

    const res = await routeGet(ROUTE, { L: knowledge.leagueId, YEAR: String(season) });
    const body = res.json;
    if (!res.ok || !body || body.ok !== true || !Array.isArray(body.years)) {
      return { status: "error", error: { code: "route_failed", message: `ledger route answered ${res.status}` } };
    }
    const y0 = body.years.find((y) => Number(y && y.season) === season);
    const y1 = body.years.find((y) => Number(y && y.season) === season + 1);
    if (!y0 || y0.ok !== true) {
      return { status: "error", error: { code: "ledger_unreadable", message: "MFL's salary adjustments for the season could not be read" } };
    }
    if (fid && !(Array.isArray(body.franchises) && body.franchises.some((f) => pad4(f && f.franchise_id) === fid))) {
      return { status: "no_record", coverage: { supported: true, gaps: [{ what: `franchise ${fid} is not in the league's franchise list for ${season}`, why: "NO_RECORD", source_needed: "a valid franchise id" }] }, provenance: prov };
    }

    const complete = season >= COMPLETE_FROM && body.sources && body.sources.d1_drop_events === true;
    const completeness = complete ? "complete" : "partial";
    const gaps = [];
    if (season < COMPLETE_FROM) {
      gaps.push({ what: `the ${season} ledger is partial: most drop rows for 2017 to 2025 are review_required, and traded cap is recorded from 2020 only`, why: "partial_coverage", source_needed: "reviewed drop-penalty records and a traded-cap record for that season" });
    } else if (!complete) {
      gaps.push({ what: "the D1 drop ledger could not be read, so drop-penalty details are missing", why: "partial_coverage", source_needed: "the D1 drop ledger (ups_drop_events)" });
    }
    if (asOf !== "current" && season < current) {
      gaps.push({ what: `this is the ${season} season ledger as recorded now, not the ledger as it stood on ${asOf}`, why: "partial_coverage", source_needed: "a dated snapshot of the ledger" });
    }

    const by0 = fid ? (y0.by_fid && y0.by_fid[fid]) || { total: 0, trade: 0, drop: 0, misc: 0, count: 0 } : { total: y0.total, trade: y0.by_type && y0.by_type.trade, drop: y0.by_type && y0.by_type.drop, misc: y0.by_type && y0.by_type.misc, count: Array.isArray(y0.rows) ? y0.rows.length : 0 };
    const showNext = !!y1 && season === current;       // next season's booked rows are a current-season question only
    let by1 = null;
    if (showNext) {
      if (y1.ok === true) by1 = fid ? (y1.by_fid && y1.by_fid[fid]) || { total: 0, count: 0 } : { total: y1.total, count: Array.isArray(y1.rows) ? y1.rows.length : 0 };
      else gaps.push({ what: "next season's booked adjustments could not be bucketed because the FA Auction start was unresolved", why: "partial_coverage", source_needed: "the FA Auction start date" });
    }

    const pick = (rows) => (Array.isArray(rows) ? rows : []).filter((r) => !fid || pad4(r.franchise_id) === fid);
    const allRows = pick(y0.rows);
    const rows = allRows.slice(0, MAX_ROWS).map(trimRow);
    const truncated = allRows.length > rows.length;
    if (truncated) gaps.push({ what: `only the first ${MAX_ROWS} of ${allRows.length} rows are listed (totals cover every row)`, why: "partial_coverage", source_needed: "a narrower query (one franchise)" });

    const asFact = String(asOf);
    const src = `${ROUTE} (${season})`;
    const f = (key, label, value, unit, grade) => ({ key, label, value, unit, as_of: asFact, source: src, grade });
    const scope = fid ? `franchise ${fid}` : "the league";
    const facts = [
      f("season", `Season of this ledger (${completeness})`, season, "season", "A"),
      f("season_total", `Salary adjustments posted on MFL for ${season}, ${scope} (${SIGN})`, int(by0.total) || 0, "usd", "C"),
      f("trade_total", `Traded-salary adjustments, ${scope} (${SIGN})`, int(by0.trade) || 0, "usd", "C"),
      f("drop_total", `Drop-penalty adjustments, ${scope} (${SIGN})`, int(by0.drop) || 0, "usd", "C"),
      f("misc_total", `Misc adjustments, ${scope} (${SIGN})`, int(by0.misc) || 0, "usd", "C"),
      f("row_count", `Adjustment rows, ${scope}`, allRows.length, "count", "C"),
    ];
    if (by1) {
      facts.push(f("next_season_total", `Adjustments already booked for ${season + 1}, ${scope}; they post to MFL at the rollover (${SIGN})`, int(by1.total) || 0, "usd", "C"));
      facts.push(f("next_season_count", `Rows booked for ${season + 1}, ${scope}`, int(by1.count) || 0, "count", "C"));
    }
    rows.slice(0, MAX_ROW_FACTS).forEach((r, i) => {
      if (r.amount != null) facts.push(f(`r${i + 1}_amount`, `Row ${i + 1} (${r.type || "adjustment"}, franchise ${r.franchise_id}, ${r.assessed_iso.slice(0, 10) || "undated"}): amount (${SIGN})`, r.amount, "usd", r.in_mfl ? "A" : "C"));
    });

    return {
      status: "ok",
      data: {
        season, completeness, sign_convention: SIGN, franchise_id: fid, franchise_name: fid ? teamName((body.franchises.find((x) => pad4(x.franchise_id) === fid) || {}).franchise_name, fid) : null,
        this_season: { total: int(by0.total) || 0, trade: int(by0.trade) || 0, drop: int(by0.drop) || 0, misc: int(by0.misc) || 0, count: allRows.length },
        next_season: by1 ? { season: season + 1, total: int(by1.total) || 0, count: int(by1.count) || 0 } : null,
        rows, rows_returned: rows.length, rows_total: allRows.length, rows_truncated: truncated,
      },
      facts,
      coverage: { supported: true, gaps },
      provenance: { ...prov, completeness, sources: cleanSources(body.sources), review_block: "not exposed", row_classification: "type (trade, drop, misc) is the ledger route's own text classification of each row's description" },
      freshness: null,
    };
  },
});
