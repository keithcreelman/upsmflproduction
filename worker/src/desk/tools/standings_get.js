// Commissioner Desk tool 11: standings.get.
//
// Season standings (records, points, division and playoff seeds) and the playoff bracket with labeled final finishes, by FRANCHISE.
// Reads /api/standings and /api/playoff-bracket. Both routes DEFAULT TO THE CALENDAR YEAR when no year is sent, which is wrong
// across the season boundary, so this tool resolves the season itself and ALWAYS sends `year`.
//
// What it will not do:
//   - return owner names or emails (the routes return owner names; this tool allowlists them away: franchise ids, team names,
//     records and points only). Results are by franchise, not by owner, until the owner registry exists.
//   - answer a mid-season date as if it were history. A date inside a COMPLETE season means that season's final results;
//     a date inside the season in progress is answered with the latest data and labeled current.
//   - read /api/eras.
//
// Final finishes come back labeled by the finish label map in history_finishes.js (7 = Toilet Bowl champion, never "seventh").

import { defineTool } from "../registry.js";
import {
  analyzeSeasonFinishes, labelFinish, seasonNoteTexts, pad4, leagueIdOf, currentSeasonOf, resolveSeason, teamText,
  gap, fact, fail, routeFail, noRecord, dedupeGaps, DATE_MAPPED_GAP, OWNER_GAP,
} from "./history_finishes.js";

const STANDINGS_ROUTE = "/api/standings";
const BRACKET_ROUTE = "/api/playoff-bracket";
const MAX_GAMES = 40;

const num = (v) => { const n = Number(v); return v === null || v === undefined || v === "" || !Number.isFinite(n) ? null : n; };
const recordText = (w, l, t) => (num(w) == null || num(l) == null ? null : `${num(w)}-${num(l)}${num(t) ? `-${num(t)}` : ""}`);

function standingsRows(json) {
  const takeoverFids = new Set((Array.isArray(json.takeovers) ? json.takeovers : []).map((x) => pad4(x && x.fid)));
  return (Array.isArray(json.rows) ? json.rows : []).map((r) => {
    const fid = pad4(r.franchise_id);
    return {
      franchise_id: fid,
      franchise_name: r.franchise_name ? String(r.franchise_name) : null,
      division_name: r.division_name ? String(r.division_name) : null,
      conference_name: r.conference_name ? String(r.conference_name) : null,
      record: recordText(r.h2h_w, r.h2h_l, r.h2h_t),
      h2h_w: num(r.h2h_w), h2h_l: num(r.h2h_l), h2h_t: num(r.h2h_t), h2h_pct: num(r.h2h_pct),
      div_w: num(r.div_w), div_l: num(r.div_l), div_pct: num(r.div_pct),
      all_play_record: recordText(r.allplay_w, r.allplay_l, r.allplay_t),
      all_play_pct: num(r.allplay_pct),
      points_for_total: num(r.pf_total),
      points_for_per_game: num(r.pf),
      points_against_per_game: num(r.pa),
      is_division_leader: r.is_division_leader === true,
      division_rank: num(r.division_rank),
      playoff_seed: num(r.playoff_seed),
      playoff_status: r.playoff_status ? String(r.playoff_status) : null,
      ownership_changed_in_season: !!(r.takeover || takeoverFids.has(fid)),
    };
  });
}

// One entry per game: both sides of a game appear in the route's rows, so keep the winner's orientation.
function playoffGames(matchups) {
  const seen = new Map();
  for (const m of Array.isArray(matchups) ? matchups : []) {
    const a = pad4(m.franchise_id), b = pad4(m.opponent_franchise_id);
    const week = num(m.week);
    if (!a || !b || week == null) continue;
    const key = `${week}|${[a, b].sort().join("|")}`;
    const ts = num(m.team_score), os = num(m.opponent_score);
    const aWon = ts != null && os != null && ts > os;
    const tie = ts != null && os != null && ts === os;
    if (seen.has(key) && !aWon) continue;
    if (seen.has(key) && tie) continue;
    seen.set(key, { week, winner_franchise_id: a, loser_franchise_id: b, winner_score: ts, loser_score: os, tied: tie });
  }
  return [...seen.values()].sort((x, y) => x.week - y.week || x.winner_franchise_id.localeCompare(y.winner_franchise_id));
}

const tool = defineTool({
  id: "standings.get",
  version: "1.0.0",
  description:
    "A season's standings (overall and all-play record, points for and against, division rank, playoff seed) and, with view 'playoffs' or 'both', " +
    "the playoff bracket: seeds, playoff games and the labeled final finish of every franchise (the champion, the Toilet Bowl champion, and so on). " +
    "By franchise, not by owner. Season-grained from 2011 (2010 is returned as disputed when asked by season, not by date). " +
    "A date inside a finished season returns that season's final results; a date inside the season in progress returns the latest standings labeled current. " +
    "It cannot give a standing on an exact past date, and it does not name owners.",
  phase: "P1",
  dataClass: "P0",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      season: { type: "integer", minimum: 2010, maximum: 2099, description: "The season (a four-digit year). Omit for the current season." },
      franchise: { type: "string", pattern: "^\\d{4}$", maxLength: 4, description: "Four-digit franchise id to focus on, for example 0005" },
      view: { type: "string", enum: ["standings", "playoffs", "both"], description: "standings (default), playoffs (bracket, games, labeled finishes) or both" },
    },
    required: [],
  },
  asOf: { supports: "season", from: 2011 },
  allowlist: {
    routes: [
      { path: STANDINGS_ROUTE, params: ["year", "L"] },
      { path: BRACKET_ROUTE, params: ["year", "L"] },
    ],
    modules: [],
    tables: [],
  },
  output: {
    allow: [
      "season", "basis", "as_of_basis", "season_complete", "through_week", "last_regular_season_week",
      "standings[].franchise_id", "standings[].franchise_name", "standings[].division_name", "standings[].conference_name",
      "standings[].record", "standings[].h2h_w", "standings[].h2h_l", "standings[].h2h_t", "standings[].h2h_pct",
      "standings[].div_w", "standings[].div_l", "standings[].div_pct", "standings[].all_play_record", "standings[].all_play_pct",
      "standings[].points_for_total", "standings[].points_for_per_game", "standings[].points_against_per_game",
      "standings[].is_division_leader", "standings[].division_rank", "standings[].playoff_seed", "standings[].playoff_status",
      "standings[].ownership_changed_in_season",
      "playoffs.seeding_status", "playoffs.playoff_weeks",
      "playoffs.seeds[].franchise_id", "playoffs.seeds[].franchise_name", "playoffs.seeds[].seed", "playoffs.seeds[].path",
      "playoffs.seeds[].bye", "playoffs.seeds[].is_division_leader", "playoffs.seeds[].final_finish", "playoffs.seeds[].label",
      "playoffs.seeds[].label_kind", "playoffs.seeds[].regular_season_finish", "playoffs.seeds[].place_verified",
      "playoffs.games[].week", "playoffs.games[].winner_franchise_id", "playoffs.games[].loser_franchise_id",
      "playoffs.games[].winner_score", "playoffs.games[].loser_score", "playoffs.games[].tied",
      "season_notes", "notes",
    ],
  },
  async run({ args, asOf, routeGet, knowledge }) {
    const L = leagueIdOf(knowledge);
    if (!L) return fail("no_league_id", "the league id is not configured for the desk");
    const cs = currentSeasonOf(knowledge);
    const view = args.view || "standings";
    const franchise = args.franchise ? pad4(args.franchise) : null;

    const rs = resolveSeason({ asOf, argSeason: args.season, currentSeason: cs });
    if (!rs.ok) return fail(rs.code, rs.message);
    const season = rs.season;
    if (rs.future) return noRecord([gap(`${season} has not been played yet`, "NO_RECORD", "none (future season)")]);
    if (season < 2010) return noRecord([gap("No standings exist before 2010", "NO_RECORD", "an archive for that season")]);

    // The season is ALWAYS sent. The routes' own default is the calendar year.
    let st = null, br = null;
    if (view === "standings" || view === "both") {
      const r = await routeGet(STANDINGS_ROUTE, { year: season, L });
      if (!r.ok || !r.json || r.json.ok === false) return routeFail(STANDINGS_ROUTE, r);
      st = r.json;
    }
    if (view === "playoffs" || view === "both") {
      const r = await routeGet(BRACKET_ROUTE, { year: season, L });
      if (!r.ok || !r.json || r.json.ok === false) return routeFail(BRACKET_ROUTE, r);
      br = r.json;
    }

    const gaps = [];
    const notes = [];
    const seasonNotes = [];

    if (st && (st.preseason === true || !Array.isArray(st.rows) || st.rows.length === 0)) {
      return noRecord([gap(`No games have been played in ${season} yet, so there are no standings`, "NO_RECORD", `${season} standings (after Week 1)`)]);
    }
    if (st && st.standings_basis === "unavailable") {
      return noRecord([gap(`The ${season} standings could not be seeded from the weekly rows (the route reports a problem)`, "stale", "the weekly score rows for the season")], null);
    }
    if (!st && br && (!Array.isArray(br.seeds) || br.seeds.length === 0)) {
      return noRecord([gap(`No playoff bracket data is stored for ${season}`, "NO_RECORD", `${season} standings and schedule rows`)]);
    }

    // Is the season finished? Recorded final standings, a final-week playoff game, or a past season.
    const recorded = (st && st.standings_basis === "recorded_final_standings") || (br && br.seeding_status === "recorded_final_standings");
    const routeComplete = !!((st && st.season_complete) || (br && br.season_complete));
    const complete = recorded || routeComplete || !!(cs && season < cs);

    let asOfBasis, factAsOf = asOf;
    if (complete) {
      asOfBasis = "final_season_results";
      if (rs.dateAsOf) gaps.push(DATE_MAPPED_GAP(asOf, season));
    } else {
      asOfBasis = "current_in_progress";
      factAsOf = "current";
      if (rs.dateAsOf) {
        gaps.push(gap(`The ${season} season is still in progress, so the standings on ${asOf} are not stored. These are the latest standings, labeled current.`, "unsupported_as_of", "a dated record of standings (not stored)"));
      }
      notes.push(`The ${season} season is in progress; this is the latest data, not a final result.`);
    }

    if (season === 2010) gaps.push(gap("The 2010 season is disputed (GAP-03, GAP-17): a loser advanced and no Toilet Bowl title was awarded", "conflict_in_canon", "a ruling on the 2010 bracket"));

    const standings = st ? standingsRows(st) : null;
    const seasonCompleteFinalWeek = !!complete;
    const rsInfo = st && st.regular_season ? st.regular_season : null;

    // Playoffs.
    let playoffs = null;
    let finishAnalysis = null;
    if (br) {
      const seeds = (Array.isArray(br.seeds) ? br.seeds : []);
      const withFinish = seeds.filter((x) => x.final_finish !== null && x.final_finish !== undefined);
      finishAnalysis = withFinish.length ? analyzeSeasonFinishes(seeds) : null;
      const outSeeds = seeds.map((x) => {
        const hasFinish = x.final_finish !== null && x.final_finish !== undefined && x.final_finish !== "";
        const lab = hasFinish ? labelFinish(season, x.final_finish, finishAnalysis) : null;
        return {
          franchise_id: pad4(x.franchise_id),
          franchise_name: x.franchise_name ? String(x.franchise_name) : null,
          seed: num(x.seed), path: x.path ? String(x.path) : null, bye: x.bye === true, is_division_leader: x.is_division_leader === true,
          final_finish: hasFinish ? num(x.final_finish) : null,
          label: lab ? lab.label : (complete ? "No final finish is recorded for this franchise" : "No final finish yet (the season is in progress)"),
          label_kind: lab ? lab.kind : "none",
          regular_season_finish: num(x.regular_season_finish),
          place_verified: lab ? lab.verified : false,
        };
      });
      outSeeds.sort((a, b) => (a.seed == null ? 99 : a.seed) - (b.seed == null ? 99 : b.seed) || a.franchise_id.localeCompare(b.franchise_id));
      playoffs = {
        seeding_status: br.seeding_status ? String(br.seeding_status) : null,
        playoff_weeks: Array.isArray(br.playoff_weeks) ? br.playoff_weeks.map(Number).filter(Number.isFinite) : [],
        seeds: outSeeds,
        games: playoffGames(br.matchups),
      };
      if (br.seeding_status === "unavailable") gaps.push(gap(`The ${season} bracket seeds are unavailable (the weekly rows cannot be trusted yet)`, "stale", "the weekly score rows for the season"));
      if (finishAnalysis) {
        seasonNotes.push(...seasonNoteTexts(season, finishAnalysis));
        if (finishAnalysis.defective) gaps.push(gap(`The ${season} stored final standings are defective; places from ${finishAnalysis.firstAnomaly} down are not labeled`, "partial_coverage", "corrected final standings from the league archive"));
      } else {
        seasonNotes.push(...seasonNoteTexts(season, null));
      }
      for (const sd of outSeeds) {
        if (sd.label_kind !== "none" && sd.place_verified === false && season !== 2010 && !(finishAnalysis && finishAnalysis.defective && sd.label_kind === "unlabeled")) {
          gaps.push(gap(`The ${season} stored place for franchise ${sd.franchise_id} may differ from the games (archive correction noted); treat it as unverified`, "partial_coverage", "the archive's corrected final standings"));
        }
      }
      if (!complete) gaps.push(gap(`The ${season} playoffs are not finished, so final places are not recorded`, "partial_coverage", `${season} final standings (after the season ends)`));
    } else {
      seasonNotes.push(...seasonNoteTexts(season, null));
    }

    // Facts.
    const facts = [];
    const src = "src_standings via /api/standings";
    const bsrc = "src_final_standings and src_schedule via /api/playoff-bracket";
    facts.push(fact("season", "Season", season, "season", src, "A", factAsOf));
    facts.push(fact("data_basis", "What these results are", complete ? "final season results" : "latest standings; the season is in progress", "text", src, "C", factAsOf));
    if (rsInfo && rsInfo.through_week != null && !complete) facts.push(fact("through_week", "Latest week in the data", num(rsInfo.through_week), "week", src, "A", factAsOf));
    if (standings) {
      const pick = franchise ? standings.filter((r) => r.franchise_id === franchise) : standings;
      if (franchise && !pick.length) gaps.push(gap(`Franchise ${franchise} has no standings row for ${season}`, "NO_RECORD", `${season} standings`));
      const grade = complete ? "A" : "C";
      for (const r of pick) {
        const k = `f${r.franchise_id}`;
        facts.push(fact(`${k}_team`, `Team for franchise ${r.franchise_id} in ${season}`, teamText(r.franchise_name, r.franchise_id), "text", src, "A", factAsOf));
        if (r.record) facts.push(fact(`${k}_record`, `Overall head-to-head record, franchise ${r.franchise_id}`, r.record, "text", src, grade, factAsOf));
        if (r.points_for_total != null) facts.push(fact(`${k}_points_for`, `Points for (season total), franchise ${r.franchise_id}`, r.points_for_total, "count", src, grade, factAsOf));
        if (r.playoff_seed != null) facts.push(fact(`${k}_playoff_seed`, `Playoff seed, franchise ${r.franchise_id}`, r.playoff_seed, "rank", src, grade, factAsOf));
        if (franchise) {
          if (r.all_play_record) facts.push(fact(`${k}_all_play_record`, `All-play record, franchise ${r.franchise_id}`, r.all_play_record, "text", src, grade, factAsOf));
          if (r.points_for_per_game != null) facts.push(fact(`${k}_points_for_per_game`, `Points for per game, franchise ${r.franchise_id}`, r.points_for_per_game, "count", src, grade, factAsOf));
          if (r.points_against_per_game != null) facts.push(fact(`${k}_points_against_per_game`, `Points against per game, franchise ${r.franchise_id}`, r.points_against_per_game, "count", src, grade, factAsOf));
          if (r.division_rank != null) facts.push(fact(`${k}_division_rank`, `Division rank, franchise ${r.franchise_id}`, r.division_rank, "rank", src, grade, factAsOf));
        }
      }
    }
    if (playoffs) {
      const pickSeeds = franchise ? playoffs.seeds.filter((s) => s.franchise_id === franchise) : playoffs.seeds;
      if (franchise && !pickSeeds.length) gaps.push(gap(`Franchise ${franchise} is not in the ${season} bracket data`, "NO_RECORD", `${season} standings`));
      const nameOf = new Map(playoffs.seeds.map((s) => [s.franchise_id, s.franchise_name]));
      for (const s of pickSeeds) {
        const k = `f${s.franchise_id}`;
        if (!standings) facts.push(fact(`${k}_team`, `Team for franchise ${s.franchise_id} in ${season}`, teamText(s.franchise_name, s.franchise_id), "text", bsrc, "A", factAsOf));
        if (s.seed != null) facts.push(fact(`${k}_bracket_seed`, `Bracket seed, franchise ${s.franchise_id}`, s.seed, "rank", bsrc, "C", factAsOf));
        if (s.label_kind !== "none" && s.label_kind !== "unlabeled") {
          const g = season !== 2010 && s.place_verified && s.label_kind !== "disputed" ? "C" : "D";
          facts.push(fact(`${k}_finish`, `Final finish, franchise ${s.franchise_id}`, s.label, "text", bsrc, g, factAsOf));
        }
      }
      if (!franchise && complete) {
        const champ = playoffs.seeds.find((s) => s.final_finish === 1 && s.label_kind === "championship_bracket");
        const toilet = playoffs.seeds.find((s) => s.final_finish === 7 && s.label_kind === "toilet_bowl_champion");
        if (champ) facts.push(fact("champion", `${season} champion`, teamText(champ.franchise_name, champ.franchise_id), "text", bsrc, "C", factAsOf));
        if (toilet) facts.push(fact("toilet_bowl_champion", `${season} Toilet Bowl (Hawk Tuah Bowl) champion`, teamText(toilet.franchise_name, toilet.franchise_id), "text", bsrc, "C", factAsOf));
      }
      const games = franchise ? playoffs.games.filter((g) => g.winner_franchise_id === franchise || g.loser_franchise_id === franchise) : playoffs.games;
      if (games.length > MAX_GAMES) gaps.push(gap(`Only the first ${MAX_GAMES} of ${games.length} playoff games are itemized as facts`, "partial_coverage", "none (narrow with a franchise)"));
      for (const g of games.slice(0, MAX_GAMES)) {
        if (g.winner_score == null || g.loser_score == null) continue;
        const w = teamText(nameOf.get(g.winner_franchise_id), g.winner_franchise_id), l = teamText(nameOf.get(g.loser_franchise_id), g.loser_franchise_id);
        const text = g.tied ? `${w} and ${l} tied ${g.winner_score} to ${g.loser_score} in week ${g.week}` : `${w} beat ${l}, ${g.winner_score} to ${g.loser_score}, in week ${g.week}`;
        facts.push(fact(`w${g.week}_${g.winner_franchise_id}_${g.loser_franchise_id}`, `Playoff game, week ${g.week}`, text, "text", bsrc, "A", factAsOf));
      }
    }

    notes.push("Results are by franchise, not by owner: the owner registry does not exist yet.");
    notes.push("The overall record is the stored season total of every head-to-head result; UPS plays several opponents a week, so it exceeds the number of weeks.");
    notes.push("Points for (season total) and per-game averages are stored values; per-game averages cover played matchups only.");
    if (br) notes.push("regular_season_finish is the playoff seed by all-play percent, not the final finish.");
    if (st && st.has_conferences) notes.push(`${season} was a conference-era season.`);
    // Owner-vs-franchise caveat for the cross-franchise comparison a standings table invites.
    if (!franchise) gaps.push(OWNER_GAP());

    const data = {
      season, basis: st ? String(st.standings_basis || "") : (br ? String(br.seeding_status || "") : ""),
      as_of_basis: asOfBasis, season_complete: seasonCompleteFinalWeek,
      through_week: rsInfo && rsInfo.through_week != null ? num(rsInfo.through_week) : null,
      last_regular_season_week: st && st.meta && st.meta.last_regular_season_week != null ? num(st.meta.last_regular_season_week) : null,
      ...(standings ? { standings } : {}),
      ...(playoffs ? { playoffs } : {}),
      season_notes: seasonNotes,
      notes,
    };
    return {
      status: "ok", data, facts,
      coverage: { supported: true, gaps: dedupeGaps(gaps) },
      provenance: { source: "src_standings, src_schedule, src_final_standings", inputs: { season, franchise, view }, year_sent: season, never_read: "/api/eras" },
      freshness: { basis: asOfBasis, season, through_week: rsInfo && rsInfo.through_week != null ? num(rsInfo.through_week) : null },
    };
  },
});

export default tool;
