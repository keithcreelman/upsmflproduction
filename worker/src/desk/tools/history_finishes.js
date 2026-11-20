// Commissioner Desk tool 12: history.finishes.
//
// Who finished where, season by season: champions, Toilet Bowl (Hawk Tuah Bowl) champions and every final place.
// It reads /api/historical-finishes (src_final_standings) and, only when the title-game score is asked for,
// /api/hall-of-champions. It NEVER reads /api/eras: that route counts final_finish 12 as the Toilet Bowl winner, which is wrong.
//
// THE FINISH LABEL MAP (code, tested; DESK_CONTRACT.md "Finish label map")
//   final_finish 1..6  = championship bracket places (1 champion, 2 runner-up, 3 third ...)
//   final_finish 7     = Toilet Bowl (Hawk Tuah Bowl) CHAMPION. Never "seventh place".
//   final_finish 8..12 = the rest of the Toilet bracket.
// Every finish leaves this tool with a `label`; a bare number never does.
//
// SEASON CAVEATS (coverage knowledge, applied in code)
//   2010: disputed (loser-advances bracket), no Toilet Bowl title was awarded.
//   2011-2014: the Toilet Bowl game was played in Week 15.
//   2015: the stored final standings are defective (two franchises at 6, none at 10). This tool detects any season whose
//         places are not exactly 1..12 and refuses to label the places from the first anomaly downward.
//   regular_season_finish is the playoff seed by all-play percent, not the final finish.
//
// Results are by FRANCHISE, not by owner: there is no owner registry yet, so a title count is a franchise count.
//
// The three Phase 1 history tools share this file's small helpers (labels, season resolution, fact and gap builders).

import { defineTool } from "../registry.js";
import { safeTeamName, cleanName } from "./shared_text.js";

export const LEAGUE_SIZE = 12;

const ORDINAL = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh", "twelfth"];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export const FINISH_LABELS = Object.freeze({
  1: "Champion",
  2: "Runner-up",
  3: "Third place",
  4: "Fourth place",
  5: "Fifth place",
  6: "Sixth place (championship bracket)",
  7: "Toilet Bowl (Hawk Tuah Bowl) champion",
  8: "Toilet bracket, eighth overall",
  9: "Toilet bracket, ninth overall",
  10: "Toilet bracket, tenth overall",
  11: "Toilet bracket, eleventh overall",
  12: "Toilet bracket, twelfth overall (last place)",
});

// Season notes from the coverage knowledge. Data-driven checks (analyzeSeasonFinishes) decide what is defective;
// these notes only describe what is already known about a season.
export const SEASON_NOTES = Object.freeze({
  2010: { status: "disputed", note: "The 2010 bracket is disputed (the loser advanced) and no Toilet Bowl title was awarded. Treat every 2010 finish as disputed." },
  2011: { toilet_week: 15, unverified_places: [8, 11], note: "The Toilet Bowl was played in Week 15. The league archive records a correction between two stored places (eighth and eleventh) that the stored finishes may not include; treat those two places as unverified." },
  2012: { toilet_week: 15, note: "The Toilet Bowl was played in Week 15." },
  2013: { toilet_week: 15, note: "The Toilet Bowl was played in Week 15." },
  2014: { toilet_week: 15, note: "The Toilet Bowl was played in Week 15." },
  2023: { unverified_places: [9, 10], note: "The league archive records a correction between two stored places (ninth and tenth) that the stored finishes may not include; treat those two places as unverified." },
});

// ── Season analysis ─────────────────────────────────────────────────────────────────────────────
// A season's places must be exactly 1..12, each once. `firstAnomaly` is the best place that is duplicated, missing or invalid:
// every place from there downward is untrustworthy, so it is not labeled.
export function analyzeSeasonFinishes(rows) {
  const counts = new Map();
  for (const r of rows || []) {
    const n = plainInt(r && r.final_finish);
    if (n === null) continue;
    counts.set(n, (counts.get(n) || 0) + 1);
  }
  const anomalies = [];
  for (let p = 1; p <= LEAGUE_SIZE; p++) if ((counts.get(p) || 0) !== 1) anomalies.push(p);
  for (const k of counts.keys()) if ((k < 1 || k > LEAGUE_SIZE) && !anomalies.includes(k)) anomalies.push(k);
  anomalies.sort((a, b) => a - b);
  const defective = anomalies.length > 0;
  const dup = [...counts.entries()].filter(([, c]) => c > 1).map(([p]) => p).sort((a, b) => a - b);
  const missing = [];
  for (let p = 1; p <= LEAGUE_SIZE; p++) if (!counts.has(p)) missing.push(p);
  return { rows: (rows || []).length, defective, anomalies, firstAnomaly: defective ? anomalies[0] : null, duplicated: dup, missing };
}

// -> { label, kind, verified, season_status }
//   kind: championship_bracket | toilet_bowl_champion | toilet_bracket | disputed | unlabeled
export function labelFinish(season, finish, analysis) {
  const s = Number(season);
  const pf = plainInt(finish);
  const f = pf === null ? NaN : pf;
  const status = s === 2010 ? "disputed" : (analysis && analysis.defective ? "defective" : "ok");
  if (!Number.isInteger(f) || f < 1 || f > LEAGUE_SIZE) {
    return { label: "Not labeled: no valid final place is recorded", kind: "unlabeled", verified: false, season_status: status };
  }
  if (analysis && analysis.defective && f >= analysis.firstAnomaly) {
    return { label: `Not labeled: the ${s} final standings are defective (two franchises share a place or a place is missing)`, kind: "unlabeled", verified: false, season_status: "defective" };
  }
  if (s === 2010) {
    const label = f >= 7
      ? `${cap(ORDINAL[f])} overall (2010 bracket disputed${f === 7 ? "; no Toilet Bowl title was awarded" : ""})`
      : `${FINISH_LABELS[f]} (2010 bracket disputed)`;
    return { label, kind: "disputed", verified: false, season_status: "disputed" };
  }
  const note = SEASON_NOTES[s];
  const verified = !(note && Array.isArray(note.unverified_places) && note.unverified_places.includes(f));
  const kind = f <= 6 ? "championship_bracket" : f === 7 ? "toilet_bowl_champion" : "toilet_bracket";
  return { label: FINISH_LABELS[f], kind, verified, season_status: status };
}

export function seasonNoteTexts(season, analysis) {
  const out = [];
  const n = SEASON_NOTES[Number(season)];
  if (n) out.push(`${season}: ${n.note}`);
  if (analysis && analysis.defective) {
    const bits = [];
    if (analysis.duplicated.length) bits.push(`place ${analysis.duplicated.join(", ")} recorded more than once`);
    if (analysis.missing.length) bits.push(`place ${analysis.missing.join(", ")} missing`);
    out.push(`${season}: the stored final standings are defective (${bits.join("; ") || "places are not one through twelve"}). Places from ${analysis.firstAnomaly} down are not labeled.`);
  }
  return out;
}

// ── Shared helpers for the three history tools ──────────────────────────────────────────────────
// STRICT validators for route values. A hostile string that merely CONTAINS numerals is not an id, a year or a week:
// anything that is not exactly the plain shape returns null, and the caller drops the row or fact and says so in a gap.
const asText = (v) => (typeof v === "string" ? v : (typeof v === "number" && Number.isFinite(v) ? String(v) : ""));
export const plainNum = (v) => {                                    // plain decimal only: no hex, exponent, spaces, Infinity
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  return typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : null;
};
export const plainInt = (v) => { const n = plainNum(v); return Number.isInteger(n) ? n : null; };
export const pad4 = (v) => { const s = asText(v); return /^\d{1,4}$/.test(s) ? s.padStart(4, "0") : null; };      // a franchise id: 1 to 4 numerals
export const yearOf = (v) => { const s = asText(v); return /^\d{4}$/.test(s) && Number(s) >= 2000 && Number(s) <= 2099 ? Number(s) : null; };
export const weekOf = (v) => { const s = asText(v); return /^\d{1,2}$/.test(s) && Number(s) >= 1 && Number(s) <= 30 ? Number(s) : null; };
export const seasonOfAsOf = (asOf) => Number(String(asOf).slice(0, 4));
export const leagueIdOf = (knowledge) => { const s = asText(knowledge && knowledge.leagueId); return /^\d{1,8}$/.test(s) ? s : null; };
export const currentSeasonOf = (knowledge) => yearOf(knowledge && knowledge.currentSeason);

// A route date or time, parsed and RE-EMITTED by this tool; the route's own string is never copied.
// Accepts: an ISO day (2019-05-02), a date-time with a space or T (2022-09-30 10:00:00), a ten-numeral epoch in seconds (MFL), a four-numeral year.
// -> { iso: "YYYY-MM-DD" | "YYYY", year, precision: "day" | "year" } or null.
export function parseWhen(v) {
  const s = asText(v).trim();
  const day = (y, m, d, hh = 0, mm = 0, ss = 0) => {
    if (y < 2000 || y > 2099 || hh > 23 || mm > 59 || ss > 59) return null;
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return { iso: dt.toISOString().slice(0, 10), year: y, precision: "day" };
  };
  let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) return day(+m[1], +m[2], +m[3]);
  if ((m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?Z?$/.exec(s))) return day(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0));
  if (/^\d{10}$/.test(s)) { const dt = new Date(Number(s) * 1000); return day(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()); }
  if (/^\d{4}$/.test(s)) { const y = yearOf(s); return y ? { iso: String(y), year: y, precision: "year" } : null; }
  return null;
}
// Route text never reaches a fact raw: a team name passes the shared screen or becomes "Team (0008)".
export const teamText = (name, fid) => safeTeamName(name, fid);
export { cleanName };

export function gap(what, why, source_needed) { return { what, why, source_needed }; }
export const OWNER_GAP = () => gap(
  "These results are by franchise, not by owner. A franchise can change owners, so a count here is not a person's career total.",
  "partial_coverage", "owner registry (slice S3, needs Keith's rulings)");

export const MAX_GAPS = 20;      // the registry rejects more than this
export function dedupeGaps(gaps) {
  const seen = new Set();
  const out = gaps.filter((g) => { const k = `${g.why}|${g.what}`; if (seen.has(k)) return false; seen.add(k); return true; });
  if (out.length <= MAX_GAPS) return out;
  const rest = out.slice(MAX_GAPS - 1);
  return [...out.slice(0, MAX_GAPS - 1), gap(`${rest.length} more coverage notes were folded into this one: ${rest.map((g) => g.what).join(" | ").slice(0, 300)}`, "partial_coverage", "see the other gaps")];
}

// The season as a fact: prose may not contain digits, so a year can only reach a card through this token.
export function yearFact(season, source, grade, asOf) {
  return fact(`s${Number(season)}_year`, "Season", Number(season), "season", source, grade, asOf);
}

export function fact(key, label, value, unit, source, grade, asOf) {
  return { key, label, value, unit, as_of: asOf, source, grade };
}

export function fail(code, message) {
  return { status: "error", data: null, facts: [], coverage: { supported: false, gaps: [] }, error: { code, message } };
}
export function routeFail(path, r) {
  const status = r && Number.isInteger(r.status) ? r.status : 0;
  return fail(`route_${status || "failed"}`, `${path} did not return usable data (HTTP ${status || "none"})`);
}
export function noRecord(gaps, data, provenance) {
  return { status: "no_record", data: data || null, facts: [], coverage: { supported: false, gaps }, provenance: provenance || {} };
}

// Which season does this call mean, and is the date honest? as_of "current" with no season means the current season.
// A date means the season of its calendar year; an explicit season that disagrees with the date is an argument error.
export function resolveSeason({ asOf, argSeason, currentSeason }) {
  const cs = Number(currentSeason) || null;
  const as = argSeason == null ? null : Number(argSeason);
  if (asOf === "current") {
    const season = as != null ? as : cs;
    if (season == null) return { ok: false, code: "season_unknown", message: "the current season is not known, so no season can be chosen; pass `season`" };
    return { ok: true, season, dateAsOf: false, future: !!(cs && season > cs) };
  }
  const y = seasonOfAsOf(asOf);
  if (as != null && as !== y) return { ok: false, code: "season_as_of_mismatch", message: `season ${as} does not match as_of ${asOf}` };
  return { ok: true, season: y, dateAsOf: true, future: !!(cs && y > cs) };
}

// A date in as_of is mapped to its season. Say so wherever a date was used.
export const DATE_MAPPED_GAP = (asOf, season) => gap(
  `as_of ${asOf} was mapped to the ${season} season by calendar year. The tool returns season results, not a standing on that exact date.`,
  "partial_coverage", "a dated record of standings (not stored)");

// ── The tool ────────────────────────────────────────────────────────────────────────────────────
const FINISH_ROUTE = "/api/historical-finishes";
const HOC_ROUTE = "/api/hall-of-champions";
const MAX_FACT_ROWS = 40;

function decorate(season, x, analysis) {
  const lab = labelFinish(season, x.final_finish, analysis);
  return {
    season,
    franchise_id: x.franchise_id,
    franchise_name: cleanName(x.franchise_name),
    final_finish: plainInt(x.final_finish),
    label: lab.label,
    label_kind: lab.kind,
    regular_season_finish: plainInt(x.regular_season_finish),
    place_verified: lab.verified,
    season_status: lab.season_status,
  };
}

const tool = defineTool({
  id: "history.finishes",
  version: "1.0.0",
  description:
    "Final league finishes by season, by franchise (not by owner): the champion, runner-up and every place from 1 to 12, " +
    "the Toilet Bowl (Hawk Tuah Bowl) champion, and title counts. Every finish comes back with a plain-language label; " +
    "place 7 is the Toilet Bowl champion, never 'seventh best'. Use view 'champions' or 'toilet_bowl' for the title lists, " +
    "or view 'finishes' with a season, franchise or place. Season-grained: it answers for whole seasons (2011 on; 2010 is returned as disputed " +
    "when asked by season), not for a date inside one. It cannot say which owner held a franchise. 2015 places below fifth are refused because " +
    "the stored 2015 standings are defective. Set include_title_game only when the championship score is asked for.",
  phase: "P1",
  dataClass: "P0",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      view: { type: "string", enum: ["finishes", "champions", "toilet_bowl"], description: "finishes (default; needs season, franchise or finish), champions (every season's champion), toilet_bowl (every Toilet Bowl champion)" },
      season: { type: "integer", minimum: 2010, maximum: 2099, description: "One season, for example 2024" },
      franchise: { type: "string", pattern: "^\\d{4}$", maxLength: 4, description: "Four-digit franchise id, for example 0005" },
      finish: { type: "integer", minimum: 1, maximum: 12, description: "A final place to look up, 1 to 12 (7 means Toilet Bowl champion)" },
      include_title_game: { type: "boolean", description: "champions view only: add the championship game score (reads more data; use only when asked)" },
    },
    required: [],
  },
  asOf: { supports: "season", from: 2011 },
  allowlist: {
    routes: [
      { path: FINISH_ROUTE, params: ["L"] },
      { path: HOC_ROUTE, params: ["L"] },
    ],
    modules: [],
    tables: [],
  },
  output: {
    allow: [
      "view", "scope.season", "scope.franchise", "scope.finish", "scope.as_of_basis", "scope.seasons_in_scope",
      "finishes[].season", "finishes[].franchise_id", "finishes[].franchise_name", "finishes[].final_finish", "finishes[].label",
      "finishes[].label_kind", "finishes[].regular_season_finish", "finishes[].place_verified", "finishes[].season_status",
      "titles[].franchise_id", "titles[].franchise_name", "titles[].champion_titles", "titles[].champion_seasons",
      "titles[].toilet_bowl_titles", "titles[].toilet_bowl_seasons",
      "title_games[].season", "title_games[].week", "title_games[].franchise_id", "title_games[].opponent_franchise_id",
      "title_games[].opponent_franchise_name", "title_games[].champion_score", "title_games[].opponent_score",
      "excluded_seasons[].season", "excluded_seasons[].reason",
      "season_notes", "notes",
    ],
  },
  async run({ args, asOf, routeGet, knowledge }) {
    const L = leagueIdOf(knowledge);
    if (!L) return fail("no_league_id", "the league id is not configured for the desk");
    const cs = currentSeasonOf(knowledge);
    const view = args.view || "finishes";
    const dateAsOf = asOf !== "current";
    const asOfYear = dateAsOf ? seasonOfAsOf(asOf) : null;
    const argSeason = args.season != null ? Number(args.season) : null;
    const franchise = args.franchise ? pad4(args.franchise) : null;
    const finishArg = args.finish != null ? Number(args.finish) : null;

    if (dateAsOf && argSeason != null && argSeason !== asOfYear) return fail("season_as_of_mismatch", `season ${argSeason} does not match as_of ${asOf}`);
    if (view === "finishes" && argSeason == null && !franchise && finishArg == null) {
      return fail("needs_filter", "view 'finishes' needs a season, a franchise or a finish; use view 'champions' or 'toilet_bowl' for the title lists");
    }
    if (argSeason != null && cs && argSeason > cs) {
      return noRecord([gap(`${argSeason} has not been played yet`, "NO_RECORD", "none (future season)")]);
    }

    const r = await routeGet(FINISH_ROUTE, { L });
    if (!r.ok || !r.json || r.json.ok === false) return routeFail(FINISH_ROUTE, r);
    const all = Array.isArray(r.json.rows) ? r.json.rows : [];
    if (!all.length) {
      return noRecord([gap("No final standings are stored in the database", "NO_RECORD", "src_final_standings (migration 0033 and its loader)")]);
    }

    // Route values are validated strictly: a row whose season or franchise id is not exactly a year or 1-4 numerals is left out.
    const bySeason = new Map();
    let rejected = 0;
    for (const x of all) {
      const s = yearOf(x && x.season), fid = pad4(x && x.franchise_id);
      if (s === null || fid === null) { rejected += 1; continue; }
      if (!bySeason.has(s)) bySeason.set(s, []);
      bySeason.get(s).push({ ...x, franchise_id: fid });
    }
    if (!bySeason.size) return noRecord([gap("No readable final standings rows were returned", "NO_RECORD", "src_final_standings")]);
    const analysis = new Map();
    for (const [s, rows] of bySeason) analysis.set(s, analyzeSeasonFinishes(rows));

    const cutoff = dateAsOf ? asOfYear : Infinity;
    const scopeSeasons = [...bySeason.keys()].filter((s) => s <= cutoff && (argSeason == null || s === argSeason)).sort((a, b) => a - b);

    const gaps = [];
    const notes = [];
    if (rejected) gaps.push(gap(`${rejected} route row(s) had an unreadable season or franchise id and were left out`, "partial_coverage", "a clean src_final_standings row for each"));
    if (dateAsOf) gaps.push(DATE_MAPPED_GAP(asOf, asOfYear));
    if (cs && (argSeason === cs || asOfYear === cs) && !bySeason.has(cs)) {
      gaps.push(gap(`The ${cs} season is still in progress; its final places are recorded after the playoffs, so none are shown for it`, "partial_coverage", `${cs} final standings (after the season ends)`));
    }
    if (!scopeSeasons.length) {
      return noRecord([...gaps, gap(`No final standings are stored for the requested season${argSeason != null ? ` (${argSeason})` : "s"}`, "NO_RECORD", "src_final_standings")]);
    }

    // Select rows.
    const excludedBySeason = new Map();
    const exclude = (season, reason) => { if (!excludedBySeason.has(season)) excludedBySeason.set(season, reason); };
    let sel = [];
    for (const s of scopeSeasons) {
      const an = analysis.get(s);
      for (const x of bySeason.get(s)) {
        const d = decorate(s, x, an);
        if (franchise && d.franchise_id !== franchise) continue;
        if (view === "champions" && d.final_finish !== 1) continue;
        if (view === "toilet_bowl") {
          if (d.final_finish !== 7) continue;
          if (d.label_kind !== "toilet_bowl_champion") {
            exclude(s, s === 2010 ? "2010 had no Toilet Bowl title (disputed bracket)" : `the ${s} final standings are defective, so the Toilet Bowl champion cannot be named`);
            continue;
          }
        }
        if (view === "finishes" && finishArg != null && d.final_finish !== finishArg) continue;
        sel.push(d);
      }
    }
    sel.sort((a, b) => a.season - b.season || (a.final_finish == null ? 99 : a.final_finish) - (b.final_finish == null ? 99 : b.final_finish));

    if (!sel.length) {
      const excluded = [...excludedBySeason].map(([season, reason]) => ({ season, reason }));
      if (excluded.length) {
        return {
          status: "refused", data: null, facts: [], coverage: { supported: false, gaps: [...gaps, ...excluded.map((e) => gap(e.reason, "partial_coverage", "corrected final standings from the league archive"))] },
          refusal: { code: "unverified_calculation", reason: excluded.map((e) => `${e.season}: ${e.reason}`).join("; ") },
        };
      }
      return noRecord([...gaps, gap("No stored finish matches that request", "NO_RECORD", "src_final_standings")]);
    }
    if (sel.every((d) => d.label_kind === "unlabeled")) {
      const seasons = [...new Set(sel.map((d) => d.season))];
      return {
        status: "refused", data: null, facts: [], coverage: { supported: false, gaps: [...gaps, ...seasons.map((s) => gap(`The ${s} final standings are defective, so these places are not labeled`, "partial_coverage", "corrected final standings from the league archive"))] },
        refusal: { code: "unverified_calculation", reason: `the stored ${seasons.join(", ")} final standings are defective for the requested places` },
      };
    }

    // Season notes and gaps for the seasons that appear in the answer.
    const shownSeasons = [...new Set(sel.map((d) => d.season))];
    const seasonNotes = [];
    for (const s of shownSeasons) seasonNotes.push(...seasonNoteTexts(s, analysis.get(s)));
    for (const s of shownSeasons) {
      const an = analysis.get(s);
      if (s === 2010) gaps.push(gap("The 2010 bracket is disputed (GAP-03, GAP-17); no Toilet Bowl title was awarded that year", "conflict_in_canon", "a ruling on the 2010 bracket"));
      if (an && an.defective) gaps.push(gap(`The ${s} stored final standings are defective; places from ${an.firstAnomaly} down are not labeled`, "partial_coverage", "corrected final standings from the league archive"));
    }
    const unverified = sel.filter((d) => d.place_verified === false && d.season_status === "ok");
    for (const d of unverified) gaps.push(gap(`The ${d.season} stored place for franchise ${d.franchise_id} may differ from the games (archive correction noted); treat it as unverified`, "partial_coverage", "the archive's corrected final standings"));
    sel.forEach((d) => { if (d.season_status === "ok" && d.place_verified === false) d.season_status = "unverified_place"; });

    // Title counts across the scope (all seasons in scope; only when the question is not about one season).
    let titles = null;
    const excludedFromCounts = [];
    if (argSeason == null) {
      const byFr = new Map();
      for (const s of scopeSeasons) {
        const an = analysis.get(s);
        if (s === 2010) { excludedFromCounts.push({ season: 2010, reason: "disputed bracket: not counted as a title or a Toilet Bowl title" }); continue; }
        if (an && an.defective && an.firstAnomaly <= 7) excludedFromCounts.push({ season: s, reason: `final standings defective from place ${an.firstAnomaly}: ${an.firstAnomaly <= 1 ? "no championship or Toilet Bowl title" : "no Toilet Bowl title"} is counted for it` });
        for (const x of bySeason.get(s)) {
          const d = decorate(s, x, an);
          if (franchise && d.franchise_id !== franchise) continue;
          const e = byFr.get(d.franchise_id) || { franchise_id: d.franchise_id, franchise_name: d.franchise_name, champion_titles: 0, champion_seasons: [], toilet_bowl_titles: 0, toilet_bowl_seasons: [] };
          if (d.franchise_name) e.franchise_name = d.franchise_name;
          if (d.final_finish === 1 && d.label_kind === "championship_bracket") { e.champion_titles += 1; e.champion_seasons.push(s); }
          if (d.final_finish === 7 && d.label_kind === "toilet_bowl_champion") { e.toilet_bowl_titles += 1; e.toilet_bowl_seasons.push(s); }
          byFr.set(d.franchise_id, e);
        }
      }
      titles = [...byFr.values()].filter((e) => view === "champions" ? e.champion_titles > 0 : view === "toilet_bowl" ? e.toilet_bowl_titles > 0 : true)
        .sort((a, b) => (view === "toilet_bowl" ? b.toilet_bowl_titles - a.toilet_bowl_titles : b.champion_titles - a.champion_titles) || a.franchise_id.localeCompare(b.franchise_id));
      for (const e of excludedFromCounts) exclude(e.season, e.reason);
      for (const e of excludedFromCounts) gaps.push(gap(`${e.season}: ${e.reason}`, e.season === 2010 ? "conflict_in_canon" : "partial_coverage", e.season === 2010 ? "a ruling on the 2010 bracket" : "corrected final standings from the league archive"));
    }
    const excluded = [...excludedBySeason].map(([season, reason]) => ({ season, reason }));
    const crossSeason = argSeason == null && (titles !== null || scopeSeasons.length > 1);
    if (crossSeason || shownSeasons.length > 1) gaps.push(OWNER_GAP());

    // Title game (champions view only, on request).
    let titleGames = null;
    if (view === "champions" && args.include_title_game === true) {
      const h = await routeGet(HOC_ROUTE, { L });
      if (!h.ok || !h.json || h.json.ok === false) return routeFail(HOC_ROUTE, h);
      const champs = Array.isArray(h.json.champions) ? h.json.champions : [];
      titleGames = [];
      const noGame = [], badGame = [];                       // seasons, summarized into ONE gap each (the registry allows 20 gaps)
      for (const d of sel) {
        if (d.final_finish !== 1 || d.label_kind !== "championship_bracket") continue;
        const c = champs.find((x) => yearOf(x && x.season) === d.season);
        if (!c) { noGame.push(d.season); continue; }
        const cf = pad4(c.franchise_id);
        if (cf !== d.franchise_id) {
          gaps.push(gap(`The ${d.season} champion in the title-game record (${cf ? `franchise ${cf}` : "an unreadable franchise id"}) differs from the final standings (franchise ${d.franchise_id}); the game score is not shown`, "conflict_in_canon", "a ruling on which record governs"));
          continue;
        }
        const g = c.final_game;
        if (!g) { noGame.push(d.season); continue; }
        const oid = pad4(g.opponent_franchise_id), wk = weekOf(g.week), cs1 = plainNum(g.champion_score), os1 = plainNum(g.opponent_score);
        if (oid === null || wk === null || cs1 === null || os1 === null) { badGame.push(d.season); continue; }
        titleGames.push({
          season: d.season, week: wk, franchise_id: d.franchise_id,
          opponent_franchise_id: oid, opponent_franchise_name: cleanName(g.opponent_franchise_name),
          champion_score: cs1, opponent_score: os1,
        });
      }
      if (noGame.length) gaps.push(gap(`No championship game record for ${noGame.join(", ")}`, "NO_RECORD", "src_schedule playoff rows"));
      if (badGame.length) gaps.push(gap(`The title-game record for ${badGame.join(", ")} has an unreadable id, week or score, so the game is not shown`, "partial_coverage", "a clean championship game row"));
    }

    // Facts (code-made; the model may state only these).
    const facts = [];
    const src = "src_final_standings via /api/historical-finishes";
    const factRows = sel.slice(0, MAX_FACT_ROWS);
    if (sel.length > MAX_FACT_ROWS) gaps.push(gap(`Only the first ${MAX_FACT_ROWS} of ${sel.length} matching rows are itemized as facts; narrow the request with a season or franchise`, "partial_coverage", "none (narrow the question)"));
    // One year fact per season shown (shared by every row of that season), so a card can print the year through a token.
    const yearSet = new Set(factRows.map((d) => d.season));
    for (const e of titles || []) {
      if (view !== "toilet_bowl") e.champion_seasons.forEach((y) => yearSet.add(y));
      if (view !== "champions") e.toilet_bowl_seasons.forEach((y) => yearSet.add(y));
    }
    for (const yr of [...yearSet].sort((a, b) => a - b)) facts.push(yearFact(yr, src, "C", asOf));
    for (const d of factRows) {
      const pfx = `s${d.season}_f${d.franchise_id}`;
      facts.push(fact(`${pfx}_team`, `${d.season} team for franchise ${d.franchise_id}`, teamText(d.franchise_name, d.franchise_id), "text", src, "A", asOf));
      if (d.label_kind !== "unlabeled") {
        const grade = d.season_status === "ok" && d.place_verified ? "C" : "D";
        facts.push(fact(`${pfx}_finish`, `${d.season} final finish of franchise ${d.franchise_id}`, d.label, "text", src, grade, asOf));
      }
    }
    if (titles) {
      for (const e of titles.slice(0, 30)) {
        if (view !== "toilet_bowl") facts.push(fact(`titles_f${e.franchise_id}`, `Championships won by franchise ${e.franchise_id}`, e.champion_titles, "count", `${src} (counted in code)`, "C", asOf));
        if (view !== "champions") facts.push(fact(`toilet_titles_f${e.franchise_id}`, `Toilet Bowl titles won by franchise ${e.franchise_id}`, e.toilet_bowl_titles, "count", `${src} (counted in code)`, "C", asOf));
      }
      const counted = scopeSeasons.filter((s) => s !== 2010).length;
      facts.push(fact("seasons_counted", "Seasons included in the title counts", counted, "count", `${src} (counted in code)`, "C", asOf));
    }
    if (titleGames) {
      for (const g of titleGames) {
        const champ = sel.find((d) => d.season === g.season && d.final_finish === 1);
        if (g.champion_score == null || g.opponent_score == null) continue;
        facts.push(fact(`s${g.season}_title_game`, `${g.season} championship game`,
          `${teamText(champ && champ.franchise_name, g.franchise_id)} ${g.champion_score} to ${g.opponent_score} over ${teamText(g.opponent_franchise_name, g.opponent_franchise_id)} in week ${g.week}`,
          "text", `${HOC_ROUTE} (src_schedule)`, "A", asOf));
      }
    }

    // The registry rejects more than MAX_FACTS (200). Worst case here is about 175; if it is ever exceeded, drop the title-count tail and say so.
    if (facts.length > 190) {
      const keep = facts.filter((f) => !/\.(titles|toilet_titles)_f\d{4}$/.test(f.id));
      gaps.push(gap(`Title counts per franchise were dropped from the facts (too many facts); ${facts.length - keep.length} count facts omitted. The counts are in data.titles.`, "partial_coverage", "none (narrow with a franchise)"));
      facts.length = 0; facts.push(...keep);
    }
    notes.push("Results are by franchise id; the team name shown is the one stored for that season.");
    notes.push("regular_season_finish is the playoff seed by all-play percent, not the final finish.");
    if (dateAsOf) notes.push(`as_of ${asOf} was mapped to its season by calendar year.`);

    const data = {
      view,
      scope: {
        season: argSeason, franchise, finish: finishArg,
        as_of_basis: dateAsOf ? `final results of seasons through ${asOfYear}` : "final results on record",
        seasons_in_scope: scopeSeasons,
      },
      finishes: sel,
      ...(titles ? { titles } : {}),
      ...(titleGames ? { title_games: titleGames } : {}),
      ...(excluded.length ? { excluded_seasons: excluded } : {}),
      season_notes: seasonNotes,
      notes,
    };
    return {
      status: "ok", data, facts,
      coverage: { supported: true, gaps: dedupeGaps(gaps) },
      provenance: { source: "src_final_standings", label_map: "finish-label-map-v1", inputs: { view, season: argSeason, franchise, finish: finishArg }, never_read: "/api/eras" },
      freshness: { basis: "recorded final standings (stored; refreshed when a season ends)" },
    };
  },
});

export default tool;
