// trade_taxi_destination.js — does a player coming off the OTHER team's taxi squad have a VALID taxi
// destination on the team receiving him, right now? Pure: every fact is passed in, so the rule is tested
// exactly as it runs. The network loader lives in index.js (loadTaxiDestinationFacts).
//
// Why it exists (Keith 2026-10-07): "Do not block a War Room trade solely because an incoming,
// taxi-eligible player temporarily appears on the receiver's active roster, provided that player has a
// valid taxi destination and the projected active count after that move is at most 30."
// MFL itself always lands a traded player on the ACTIVE roster (7 of 7 in 2026), so the War Room may
// only CREDIT the later taxi move when every condition below holds. The cap and the displayed
// counts never credit it (that is #1187: actual liability until MFL confirms the move).
//
// Conditions (canon §B2, the same tests the Roster Workbench and the weekly call-up count use):
//   1. UPS Rookie Draft pick, round 2 or later
//   2. inside his first 3 LEAGUE years (season - draft year < 3)
//   3. still on his Rookie-Draft contract
//   4. fewer than 4 counted call-ups — summed across EVERY franchise he has been on
//   5. did not finish a prior season on an active roster (that made him permanent)
//   6. his NFL game has not started this week (MFL refuses roster moves on locked players)
// (Open taxi space on the receiver is checked by the caller, which knows the post-trade taxi count.)
//
// FAILS CLOSED: an unreadable source means NOT credited, with the reason — never a guess. A player who
// is not credited simply counts as active, which is what MFL will show anyway.

const s = (v) => String(v == null ? "" : v).trim();

export const TAXI_CALLUP_LIMIT = 3;          // canon §B2: the 4th activation makes the promotion permanent
export const TAXI_LEAGUE_YEARS = 3;          // canon §B2: first 3 LEAGUE years

const TEXT = {
  draft_unreadable: "we couldn't read the UPS Rookie Draft results to confirm his taxi eligibility",
  not_drafted: "he has no UPS Rookie Draft record (only Round 2+ picks are taxi-eligible)",
  round_1: "he was a Round 1 pick (Round 1 rookies stay on the active roster)",
  graduated: "his 3 league years of taxi eligibility are over",
  contract_not_rookie: "he is no longer on his rookie contract",
  callups_unreadable: "we couldn't read his taxi call-up history",
  permanently_promoted: "he has used all 3 taxi call-ups, so his promotion is permanent",
  prior_season_unreadable: "we couldn't read last season's rosters to confirm he wasn't promoted",
  finished_season_active: "he finished a prior season on an active roster, so his promotion is permanent",
  schedule_unreadable: "we couldn't read this week's NFL schedule to confirm his game hasn't started",
  game_started: "his game has already started this week, so MFL won't move him until the week is over",
};
export const taxiReasonText = (reason) => TEXT[reason] || "his taxi eligibility couldn't be confirmed";

/**
 * @param a.season            league season (number or string)
 * @param a.arrivals          [{ player_id, contract_status, nfl_team }]
 * @param a.draftPicks        { pid -> { round, year } } for the UPS Rookie Draft, or null = unreadable
 * @param a.callupCounts      { pid -> counted call-ups across all franchises }, or null = unreadable
 * @param a.priorSeasonActive Set of pids that finished a prior season active, or null = unreadable
 * @param a.kickoffByTeam     { NFL team -> kickoff unix } for this week, or null = unreadable
 * @param a.nowUnix
 * @returns { pid -> { eligible: boolean, reason: "", text: "" } }
 */
export function evaluateTaxiDestinations(a) {
  const season = parseInt(a && a.season, 10);
  const out = {};
  for (const arr of (a && a.arrivals) || []) {
    const pid = s(arr && arr.player_id).replace(/\D/g, "");
    if (!pid) continue;
    const no = (reason) => { out[pid] = { eligible: false, reason, text: taxiReasonText(reason) }; };
    if (!a.draftPicks) { no("draft_unreadable"); continue; }
    const pick = a.draftPicks[pid];
    if (!pick) { no("not_drafted"); continue; }
    if ((parseInt(pick.round, 10) || 0) < 2) { no("round_1"); continue; }
    const yr = parseInt(pick.year, 10);
    if (!(season >= yr) || season - yr >= TAXI_LEAGUE_YEARS) { no("graduated"); continue; }
    if (!/^rookie-draft$/i.test(s(arr.contract_status))) { no("contract_not_rookie"); continue; }
    if (!a.callupCounts) { no("callups_unreadable"); continue; }
    if ((Number(a.callupCounts[pid]) || 0) > TAXI_CALLUP_LIMIT) { no("permanently_promoted"); continue; }
    if (!a.priorSeasonActive) { no("prior_season_unreadable"); continue; }
    if (a.priorSeasonActive.has(pid)) { no("finished_season_active"); continue; }
    if (!a.kickoffByTeam) { no("schedule_unreadable"); continue; }
    const team = s(arr.nfl_team).toUpperCase();
    const ko = team ? Number(a.kickoffByTeam[team]) || 0 : 0;          // no game this week (bye / free agent) = open
    if (ko && Number(a.nowUnix) >= ko) { no("game_started"); continue; }
    out[pid] = { eligible: true, reason: "", text: "" };
  }
  return out;
}
