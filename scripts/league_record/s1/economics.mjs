// League Record S1 pilot: fantasy production and salary for a franchise's possession periods. Calculated values, graded no higher than their inputs.
//
// Points come from MFL's per-week scoring record with its own per-week franchise attribution (player_weeklyscoringresults), cross-checked against the plain weekly score table
// (playerscores_weekly). A week counts as VERIFIED for a franchise only when the possession chain (trade, draft and add/drop events) and MFL's weekly record name the SAME franchise;
// any other week is listed as DISPUTED and is left out of the verified total. Weeks after the league's last week are copies of the last week in this archive and are excluded
// (docs: the June 2026 archive repeats the final week; league weeks end at 16 through 2020 and 17 from 2021).
// Salary comes from MFL's per-week roster record (rosters_weekly), season by season, exactly as recorded (salary, years remaining, status and the contract text).
import { dayNumber, addDays, etParts } from "./sources.mjs";
import { holderAt } from "./lineage.mjs";

export const lastLeagueWeek = (season) => (Number(season) >= 2021 ? 17 : 16);

// The NFL kickoff Thursday of each season. The archive records 2024 to 2026; earlier seasons use the calendar rule (the Thursday after Labor Day, the first Monday of
// September), which equals the recorded date in all three recorded seasons (checked by the tests). The source of each date is kept.
export function calendarKickoff(season) {
  const sep1 = Date.UTC(Number(season), 8, 1);
  const dow = new Date(sep1).getUTCDay();                       // 0 Sunday .. 6 Saturday
  const firstMonday = 1 + ((8 - dow) % 7 || 7) % 7;
  const monday = dow === 1 ? 1 : firstMonday;
  return new Date(Date.UTC(Number(season), 8, monday + 3)).toISOString().slice(0, 10);
}
export const kickoffSource = new Map();
export function kickoffDates(archive) {
  const m = new Map(archive.all("select nfl_season s, date d from leagueevents where event = 'nfl_kickoff'").map((r) => [Number(r.s), r.d]));
  for (const s of m.keys()) kickoffSource.set(s, "leagueevents");
  for (let y = 2010; y <= 2026; y++) if (!m.has(y)) { m.set(y, calendarKickoff(y)); kickoffSource.set(y, "calendar_rule"); }
  return m;
}
// The league week a date falls in: Thursday to Wednesday windows from the NFL kickoff. 0 before the kickoff. dayOffset 0..6 within the window (0 is Thursday).
export function weekOfDate(kickoffs, isoDate) {
  const season = Number(isoDate.slice(0, 4));
  const k = kickoffs.get(season) || kickoffs.get(season - 1);
  if (!k) return { week: null, dayOffset: null };
  const diff = dayNumber(isoDate) - dayNumber(k);
  if (diff < 0) return { week: 0, dayOffset: null };
  return { week: Math.floor(diff / 7) + 1, dayOffset: diff % 7 };
}
const weekStartTs = (kickoffs, season, week) => Math.floor(Date.parse(`${addDays(kickoffs.get(season), (week - 1) * 7)}T17:00:00Z`) / 1000);   // Thursday noon Eastern (17:00 UTC)

export function parseYearValues(info) {
  const out = []; const re = /\bY(\d)-(\d+(?:\.\d+)?)K?/g; let m;
  while ((m = re.exec(String(info || "")))) out.push({ year_index: Number(m[1]), value: Number(m[2]) });
  return out;
}

// Per-season weekly records of one player.
export function playerSeasonRecords(archive, playerId, season) {
  const pts = archive.all("select week, score, status, roster_status, roster_franchise_id f, is_reg, salary, contract_status, years_remaining from player_weeklyscoringresults where player_id = ? and season = ? order by week", String(playerId), Number(season));
  const plain = new Map(archive.all("select week, score from playerscores_weekly where player_id = ? and season = ?", String(playerId), Number(season)).map((r) => [Number(r.week), r.score]));
  const roster = archive.all("select week, franchise_id f, status, salary, contract_year, contract_status, contract_info from rosters_weekly where player_id = ? and season = ? order by week", String(playerId), Number(season));
  return { pts, plain, roster };
}

const r1 = (n) => Math.round(n * 10) / 10;

// Points and salary for one player over a stretch of seasons, split by franchise and by verified or disputed weeks.
export function playerEconomics({ archive, ledger, chain, playerId, seasons }) {
  const kickoffs = kickoffDates(archive);
  const out = { player_id: String(playerId), seasons: [], notes: [] };
  const transferTs = chain.events.map((e) => e.ts);
  for (const season of seasons) {
    const { pts, plain, roster } = playerSeasonRecords(archive, playerId, season);
    const cutoff = lastLeagueWeek(season);
    const kept = pts.filter((r) => Number(r.week) >= 1 && Number(r.week) <= cutoff);
    const dropped = pts.filter((r) => Number(r.week) > cutoff);
    const rosterByWeek = new Map(); const dupWeeks = [];
    for (const r of roster) { if (rosterByWeek.has(Number(r.week))) dupWeeks.push(Number(r.week)); else rosterByWeek.set(Number(r.week), r); }
    const weeks = [];
    for (const r of kept) {
      const w = Number(r.week);
      const startTs = kickoffs.has(season) ? weekStartTs(kickoffs, season, w) : null;
      const firstTs = chain.events.length ? chain.events[0].ts : null;
      const beforeChain = startTs != null && firstTs != null && startTs < firstTs;
      const eventHolder = startTs && !beforeChain ? holderAt(chain, startTs) : null;
      const windowEnd = startTs ? startTs + 7 * 86400 : null;
      // a possession change inside Thursday through Monday of the week is a transition week; Tuesday and Wednesday changes belong to the next week
      const transition = startTs ? transferTs.some((t) => t > startTs && t < startTs + 5 * 86400) : false;
      const plainScore = plain.has(w) ? plain.get(w) : null;
      // The franchise MFL's weekly record names for the week: the scoring table's own franchise column, or (when that column holds a placeholder, as it does for 2012 to 2019: 'FA') the
      // weekly roster record's franchise. With neither there is no weekly record of the franchise and the week can never be verified.
      const scoringF = r.f && /^\d{4}$/.test(String(r.f)) ? String(r.f) : null;
      const rosterF = rosterByWeek.has(w) ? rosterByWeek.get(w).f : null;
      const srcF = scoringF || rosterF || null;
      weeks.push({
        week: w, score: Number(r.score), is_reg: Number(r.is_reg) === 1, started: r.status === "starter", status: r.status, source_franchise: srcF || "no_franchise", franchise_source: scoringF ? "player_weeklyscoringresults" : rosterF ? "rosters_weekly" : "none",
        event_franchise: eventHolder, roster_franchise: rosterByWeek.has(w) ? rosterByWeek.get(w).f : null, transition_week: transition,
        // verified: the chain and MFL's weekly record name the same franchise. asserted: before the first record of the chain, where only the sender named by that first record
        // supports the weekly record. outside_window: before the first record and the weekly record names someone else (a period this trace does not cover). disputed: the chain
        // and the weekly record name different franchises inside the traced window.
        category: !srcF ? "no_franchise" : beforeChain ? (chain.holders.length && chain.holders[0].franchise === srcF ? "asserted" : "outside_window") : (transition ? "transition" : eventHolder === srcF ? "verified" : "disputed"),
        verified: !!srcF && !beforeChain && !!eventHolder && eventHolder === srcF && !transition,
        plain_score: plainScore, plain_score_agrees: plainScore == null ? null : Math.abs(Number(plainScore) - Number(r.score)) < 0.051,
        window_end_ts: windowEnd,
      });
    }
    const byFranchise = new Map();
    for (const w of weeks) { const f = w.source_franchise; if (!byFranchise.has(f)) byFranchise.set(f, []); byFranchise.get(f).push(w); }
    const franchises = [];
    for (const [f, ws] of byFranchise) {
      const sum = (xs) => r1(xs.reduce((a, x) => a + x.score, 0));
      const ver = ws.filter((x) => x.verified), dis = ws.filter((x) => x.category === "disputed" || x.category === "transition"), asr = ws.filter((x) => x.category === "asserted"), outw = ws.filter((x) => x.category === "outside_window");
      franchises.push({
        franchise: f, weeks: ws.length, points_all_weeks: sum(ws), points_asserted_before_first_record: sum(asr), weeks_asserted: asr.length, points_outside_traced_window: sum(outw), weeks_outside_traced_window: outw.length, weeks_without_franchise: ws.filter((x) => x.category === "no_franchise").length, weeks_franchise_from_roster_record: ws.filter((x) => x.franchise_source === "rosters_weekly").length, points_verified: sum(ver), weeks_verified: ver.length, points_started_verified: sum(ver.filter((x) => x.started)), weeks_started_verified: ver.filter((x) => x.started).length,
        points_regular_season_verified: sum(ver.filter((x) => x.is_reg)), points_playoffs_verified: sum(ver.filter((x) => !x.is_reg)),
        disputed_weeks: dis.map((x) => ({ week: x.week, category: x.category, source_franchise: x.source_franchise, event_franchise: x.event_franchise, transition_week: x.transition_week })),
        week_numbers: ws.map((x) => x.week),
        plain_score_mismatches: ws.filter((x) => x.plain_score_agrees === false).map((x) => ({ week: x.week, weekly_record: x.score, plain_table: x.plain_score })),
      });
    }
    // salary and contract exactly as the weekly roster record shows them, one entry per run of identical values
    const contract = [];
    let prev = null;
    for (const r of roster.filter((x, i, a) => a.findIndex((y) => y.week === x.week) === i)) {
      const key = `${r.f}|${r.salary}|${r.contract_year}|${r.contract_status}|${r.contract_info}`;
      if (prev && prev.key === key) { prev.to_week = Number(r.week); continue; }
      prev = { key, franchise: r.f, from_week: Number(r.week), to_week: Number(r.week), salary: Number(r.salary), years_remaining: r.contract_year == null ? null : Number(r.contract_year), contract_status: r.contract_status, contract_info: r.contract_info, year_values_k: parseYearValues(r.contract_info) };
      contract.push(prev);
    }
    for (const c of contract) delete c.key;
    out.seasons.push({
      season, last_league_week: cutoff, weeks_with_scoring_row: kept.map((r) => Number(r.week)), excluded_copy_weeks: dropped.map((r) => Number(r.week)), roster_duplicate_weeks: [...new Set(dupWeeks)],
      by_franchise: franchises, contract_by_roster_weeks: contract, has_records: pts.length > 0 || roster.length > 0,
    });
  }
  return out;
}

export { etParts };
