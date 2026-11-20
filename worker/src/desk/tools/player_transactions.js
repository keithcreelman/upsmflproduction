// Commissioner Desk tool 13: player.transactions.
//
// A player's dated moves (rookie draft, auction win, adds, drops, trades, tags, extensions) or a short profile
// (who holds him, the trades on record). Reads /api/player-transactions (view "transactions") and /api/player-bundle (view "profile").
// The player is identified by his MFL player id (digits); this tool does not search by name.
//
// Coverage gaps are attached to EVERY result, because they apply to every player:
//   GAP-09  WAIVER-type moves for 2010-2017 are not in the records.
//   GAP-15  multi-player drops (cut-down days) can be missing or merged.
//   picks   a draft pick that moved in a trade appears only as an untraced token. This tool never says what a pick was
//           "traded for", and the route does not return picks at all.
//   floor   /api/player-transactions reads the MFL transaction ledger only from 2019 on; earlier adds, drops and trades are not in it.
//
// Contract terms are NOT returned: the route's per-event contract strings are reconstructed (some are even-split guesses) and
// historical contract questions belong to the contract.timeline tool, which is not a Phase 1 tool.
//
// The season is always sent (YEAR). /api/player-transactions caps its scan at YEAR and /api/player-bundle reads the MFL season named by YEAR.
// /api/player-bundle answers 503 for a call that names no season and cannot resolve the active one: a named season never hits that path.

import { defineTool } from "../registry.js";
import {
  pad4, leagueIdOf, currentSeasonOf, resolveSeason, seasonOfAsOf, teamText, gap, fact, yearFact, fail, routeFail, noRecord, dedupeGaps,
} from "./history_finishes.js";

const TX_ROUTE = "/api/player-transactions";
const BUNDLE_ROUTE = "/api/player-bundle";
const MAX_EVENT_FACTS = 40;
const EVENT_KINDS_KEPT = new Set(["draft", "auction", "add", "drop", "trade", "dispersal", "tag", "extension"]);

// Gaps that apply to every player. Each says what is missing and what would close it.
export const STANDING_GAPS = () => [
  gap("GAP-09: WAIVER-type moves for 2010 through 2017 are not in the records, so an add or a claim from those years can be missing.", "partial_coverage", "MFL transaction history for 2010-2017 (GAP-09)"),
  gap("GAP-15: multi-player drops (several players cut at once) can be missing or merged, so a drop can be absent.", "partial_coverage", "per-player rows for multi-player drops (GAP-15)"),
  gap("Draft picks that moved in trades appear only as untraced tokens. This tool does not say what a pick was traded for or what it became.", "partial_coverage", "trade and pick lineage (slice S1)"),
  gap("The transaction ledger is read from the 2019 season on; an add, drop or trade before 2019 is not in this result.", "partial_coverage", "MFL transaction records before 2019"),
];

const num = (v) => { const n = Number(v); return v === null || v === undefined || v === "" || !Number.isFinite(n) ? null : n; };
const str = (v) => (v === null || v === undefined ? null : String(v));

function eventSummary(e) {
  const to = e.franchise_name || e.franchise_id ? teamText(e.franchise_name, e.franchise_id) : null;
  const from = e.from_franchise_id ? teamText(e.from_franchise_name, e.from_franchise_id) : null;
  const bits = [e.label || e.kind];
  if (e.kind === "trade" || e.kind === "dispersal") bits.push(from ? `from ${from} to ${to || "another franchise"}` : (to ? `to ${to}` : ""));
  else if (to) bits.push(`by ${to}`);
  if (e.detail) bits.push(`(${e.detail})`);
  return bits.filter(Boolean).join(" ");
}

function eventGrade(e) {
  if (e.kind === "extension") return e.date_approx ? "D" : "B";
  if (e.kind === "tag") return "B";
  return "A";
}

const isIsoDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

function profileOf(json) {
  const pp = (json.profile && json.profile.playerProfile) || {};
  const pl = pp.player && typeof pp.player === "object" ? pp.player : pp;
  const name = str(pl.name || pp.name);
  const position = str(pl.position || pp.position);
  const team = str(pl.team || pp.team);
  return name || position || team ? { name, position, team } : null;
}

const tool = defineTool({
  id: "player.transactions",
  version: "1.0.0",
  description:
    "One player's dated moves, by MFL player id (not by name): rookie draft, auction win, adds, drops, trades, tags and extensions, oldest first " +
    "(view 'transactions', the default), or a short profile (view 'profile': who holds him in a season and the trades on record). " +
    "Known holes, attached to every result: waiver-type moves 2010 to 2017 are missing (GAP-09), multi-player drops can be missing (GAP-15), " +
    "and the ledger is read from 2019 on. Draft picks that moved in trades are untraced: the tool never says what a pick was traded for. " +
    "It does not return contract terms; the desk cannot answer a historical contract question from this tool. Pass `season` to narrow a long history. " +
    "For a date, it returns the moves dated on or before it.",
  phase: "P1",
  dataClass: "P0",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      pid: { type: "string", pattern: "^\\d{3,6}$", maxLength: 6, description: "MFL player id, digits only (for example from roster.current)" },
      view: { type: "string", enum: ["transactions", "profile"], description: "transactions (default) or profile" },
      season: { type: "integer", minimum: 2010, maximum: 2099, description: "transactions: only this season's moves; profile: the season whose roster is read. Omit for the current season (profile) or the whole history (transactions)." },
    },
    required: ["pid"],
  },
  asOf: {
    supports: "any",
    check: (asOf, ctx) => {
      if (asOf === "current") return null;
      const y = seasonOfAsOf(asOf);
      if (ctx && ctx.currentSeason && y > Number(ctx.currentSeason)) return { what: "that date is in the future", source_needed: "none (future date)" };
      if (y < 2010) return { what: "the league has no player records before 2010", source_needed: "none" };
      return null;
    },
  },
  allowlist: {
    routes: [
      { path: TX_ROUTE, params: ["pid", "L", "YEAR"] },
      { path: BUNDLE_ROUTE, params: ["pid", "L", "YEAR"] },
    ],
    modules: [],
    tables: [],
  },
  output: {
    allow: [
      "view", "player_id", "season", "as_of_basis", "event_count",
      "events[].seq", "events[].season", "events[].date", "events[].date_approx", "events[].kind", "events[].label", "events[].detail",
      "events[].franchise_id", "events[].franchise_name", "events[].from_franchise_id", "events[].from_franchise_name",
      "profile.name", "profile.position", "profile.team",
      "roster_in_season.season", "roster_in_season.franchise_id", "roster_in_season.team_name", "roster_in_season.status",
      "roster_in_season.is_free_agent", "roster_in_season.is_not_rostered",
      "trade_history[].season", "trade_history[].franchise_id", "trade_history[].franchise_name", "trade_history[].asset_role",
      "trade_history[].datetime_et",
      "last_add.season", "last_add.franchise_id", "last_add.franchise_name", "last_add.method", "last_add.datetime_et",
      "notes",
    ],
  },
  async run({ args, asOf, routeGet, knowledge }) {
    const L = leagueIdOf(knowledge);
    if (!L) return fail("no_league_id", "the league id is not configured for the desk");
    const cs = currentSeasonOf(knowledge);
    const view = args.view || "transactions";
    const pid = String(args.pid).replace(/\D/g, "");
    const argSeason = args.season != null ? Number(args.season) : null;
    const dateAsOf = asOf !== "current";

    const rs = resolveSeason({ asOf, argSeason, currentSeason: cs });
    if (!rs.ok) return fail(rs.code, rs.message);
    const year = rs.season;
    if (rs.future) return noRecord([gap(`${year} has not been played yet`, "NO_RECORD", "none (future season)"), ...STANDING_GAPS()]);

    const gaps = STANDING_GAPS();
    const notes = [
      "Players are identified by MFL player id; this tool does not match names.",
      "Contract terms are not returned by this tool.",
    ];
    const factAsOf = asOf;

    // ── profile ──
    if (view === "profile") {
      const r = await routeGet(BUNDLE_ROUTE, { pid, L, YEAR: year });
      if (!r.ok || !r.json || r.json.error) return routeFail(BUNDLE_ROUTE, r);
      const b = r.json;
      const profile = profileOf(b);
      const roster = b.current_roster && typeof b.current_roster === "object" ? {
        season: num(b.current_roster.season) || year,
        franchise_id: pad4(b.current_roster.franchise_id),
        team_name: str(b.current_roster.team_name),
        status: str(b.current_roster.status),
      } : (b.is_free_agent === true ? { season: year, is_free_agent: true } : (b.is_not_rostered === true ? { season: year, is_not_rostered: true } : null));
      const trades = (Array.isArray(b.trade_history) ? b.trade_history : []).slice(0, 30).map((t) => ({
        season: num(t.season), franchise_id: pad4(t.franchise_id), franchise_name: str(t.franchise_name),
        asset_role: str(t.asset_role), datetime_et: str(t.datetime_et),
      }));
      const la = b.last_add && typeof b.last_add === "object" && Object.keys(b.last_add).length ? {
        season: num(b.last_add.season), franchise_id: pad4(b.last_add.franchise_id), franchise_name: str(b.last_add.franchise_name),
        method: str(b.last_add.method), datetime_et: str(b.last_add.datetime_et),
      } : null;
      if (!profile && !roster && !trades.length) {
        return noRecord([gap(`No profile data was returned for player ${pid} in ${year}`, "NO_RECORD", "MFL player profile and D1 player rows"), ...gaps]);
      }
      if (dateAsOf) gaps.push(gap(`Who holds the player on ${asOf} is not stored; the roster shown is the ${year} season's latest state.`, "unsupported_as_of", "a dated roster snapshot (2026 daily snapshots only)"));
      if (trades.length >= 30) gaps.push(gap("Only the 30 most recent trade rows are returned; older trades can be missing.", "partial_coverage", "the full trade table"));
      notes.push(`The roster shown is the ${year} season's MFL roster state, not today's unless ${year} is the current season.`);

      const facts = [];
      const src = "MFL playerProfile and rosters via /api/player-bundle";
      facts.push(yearFact(year, src, "A", factAsOf));
      if (profile && profile.name) facts.push(fact("name", "Player name", profile.name, "text", src, "A", factAsOf));
      if (profile && profile.position) facts.push(fact("position", "Position", profile.position, "text", src, "A", factAsOf));
      if (profile && profile.team) facts.push(fact("nfl_team", "NFL team", profile.team, "text", src, "A", factAsOf));
      if (roster) {
        const holder = roster.franchise_id ? teamText(roster.team_name, roster.franchise_id) : (roster.is_free_agent ? "free agent" : "not on any roster");
        facts.push(fact("holder", `Who holds the player in ${year}`, holder, "text", src, "A", factAsOf));
        if (roster.status) facts.push(fact("roster_status", "Roster status", roster.status, "text", src, "A", factAsOf));
      }
      trades.slice(0, 10).forEach((t, i) => {
        const n = i + 1;
        const when = t.datetime_et ? String(t.datetime_et).slice(0, 10) : String(t.season || "");
        facts.push(fact(`trade${n}_summary`, `Trade row ${n} (most recent first)`, `${when}: ${teamText(t.franchise_name, t.franchise_id)}${t.asset_role ? `, ${String(t.asset_role).toLowerCase()}` : ""}`, "text", "src_trades via /api/player-bundle", "A", factAsOf));
      });
      if (trades.length) facts.push(fact("trades_listed", "Trade rows listed (most recent first)", trades.length, "count", "src_trades via /api/player-bundle", "A", factAsOf));

      return {
        status: "ok",
        data: { view, player_id: pid, season: year, as_of_basis: dateAsOf ? "latest state of the season (date not honored)" : "state in the season", profile, roster_in_season: roster, trade_history: trades, last_add: la, notes },
        facts,
        coverage: { supported: true, gaps: dedupeGaps(gaps) },
        provenance: { source: "MFL export and D1 src_trades via /api/player-bundle", inputs: { pid, season: year, view }, year_sent: year },
        freshness: { basis: "live MFL roster for the season named" },
      };
    }

    // ── transactions ──
    const r = await routeGet(TX_ROUTE, { pid, L, YEAR: year });
    if (!r.ok || !r.json || r.json.ok === false) return routeFail(TX_ROUTE, r);
    const raw = Array.isArray(r.json.events) ? r.json.events : [];

    let events = raw.filter((e) => e && EVENT_KINDS_KEPT.has(String(e.kind))).map((e) => ({
      seq: num(e.seq), season: num(e.season), date: str(e.date) || "", date_approx: e.date_approx === true,
      kind: String(e.kind), label: str(e.label), detail: str(e.detail) || "",
      franchise_id: pad4(e.franchise_id) || null, franchise_name: str(e.franchise_name),
      from_franchise_id: pad4(e.from_franchise_id) || null, from_franchise_name: str(e.from_franchise_name),
    }));

    // A season filter narrows to that season's moves.
    if (argSeason != null) events = events.filter((e) => e.season === argSeason);

    // A date keeps the moves dated on or before it. A move known only to its YEAR cannot be placed against a date in the same year.
    let sameYearUnplaced = 0;
    if (dateAsOf) {
      const y = seasonOfAsOf(asOf);
      events = events.filter((e) => {
        if (isIsoDate(e.date)) return e.date <= asOf;
        const ey = num(String(e.date).slice(0, 4)) || e.season;
        if (ey == null) { sameYearUnplaced += 1; return false; }
        if (ey < y) return true;
        if (ey === y) { sameYearUnplaced += 1; return false; }
        return false;
      });
      if (sameYearUnplaced) gaps.push(gap(`${sameYearUnplaced} move(s) are dated only to their year, so they cannot be placed before or after ${asOf} and are left out.`, "partial_coverage", "exact dates for approximately dated moves"));
      notes.push(`Only moves dated on or before ${asOf} are listed.`);
    }
    if (events.some((e) => e.kind === "extension" && e.date_approx)) gaps.push(gap("Some extensions are dated only to their season; the extension itself is derived by following the contract year-over-year.", "partial_coverage", "an extension date from the extension master"));

    if (!events.length) {
      return noRecord([
        gap(`No move for player ${pid} is on record${argSeason != null ? ` in ${argSeason}` : ""}${dateAsOf ? ` on or before ${asOf}` : ""}. That does not mean none happened: see the known holes below.`, "NO_RECORD", "the full transaction history"),
        ...gaps,
      ], { view, player_id: pid, season: year, event_count: 0, events: [], notes });
    }

    const facts = [];
    const shown = events.slice(0, MAX_EVENT_FACTS);
    if (events.length > shown.length) gaps.push(gap(`Only the first ${shown.length} of ${events.length} moves are itemized as facts; pass a season to narrow the list.`, "partial_coverage", "none (narrow with a season)"));
    const src = "MFL transactions, src_draft_picks, ups_tag_master and ups_extension_master via /api/player-transactions";
    // Year facts: one per distinct season among the itemized moves, plus the range actually covered by this result.
    const seasonsShown = [...new Set(shown.map((e) => e.season).filter((x) => x != null))].sort((a, b) => a - b);
    for (const yr of seasonsShown) facts.push(yearFact(yr, src, "C", factAsOf));
    if (seasonsShown.length) {
      facts.push(fact("first_season", "First season with a move in this result", seasonsShown[0], "season", src, "C", factAsOf));
      facts.push(fact("last_season", "Last season with a move in this result", seasonsShown[seasonsShown.length - 1], "season", src, "C", factAsOf));
    }
    for (const e of shown) {
      const k = `e${e.seq != null ? e.seq : shown.indexOf(e) + 1}`;
      const g = eventGrade(e);
      if (isIsoDate(e.date)) facts.push(fact(`${k}_date`, `Move ${e.seq} date`, e.date, "date", src, g, factAsOf));
      else if (e.date) facts.push(fact(`${k}_date`, `Move ${e.seq} date (season only)`, e.date, "text", src, g, factAsOf));
      facts.push(fact(`${k}_summary`, `Move ${e.seq}: ${e.label || e.kind}`, eventSummary(e), "text", src, g, factAsOf));
    }
    facts.push(fact("event_count", "Moves on record in this result", events.length, "count", src, "C", factAsOf));

    return {
      status: "ok",
      data: { view, player_id: pid, season: argSeason != null ? argSeason : year, as_of_basis: dateAsOf ? `moves dated on or before ${asOf}` : "all moves on record", event_count: events.length, events, notes },
      facts,
      coverage: { supported: true, gaps: dedupeGaps(gaps) },
      provenance: { source: "MFL transactions ledger (2019 on) plus D1 draft, tag and extension tables", inputs: { pid, season: argSeason, view }, year_sent: year },
      freshness: { basis: "live MFL ledger up to the season named" },
    };
  },
});

export default tool;
