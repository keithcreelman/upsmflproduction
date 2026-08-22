// §B1 QB caps — the annual contract-deadline check.
//
// Two rules, both measured ONCE a year on the September contract deadline, and
// until now neither had any code (canon, verified 2026-08-16: "No code enforces
// either QB cap"). Keith 2026-08-17: build the check.
//
//   5-QB ACTIVE MAXIMUM   at most 5 QBs on the active roster.
//   4-STARTING-QB CAP     at most 4 NFL STARTING QBs across active + taxi.
//
// THIS REPORTS. IT DOES NOT ENFORCE — deliberately, for two reasons that both
// come from canon rather than caution:
//
//   1. The consequence is real cuts. Canon: "the league cuts the most recently
//      acquired starting QBs in reverse-acquisition order... as standard cuts
//      with normal penalties charged to the following season's cap." Automating
//      a cut that creates dead money, off a scraped judgement, is not a thing
//      to do quietly at 9am on a Sunday.
//   2. Starter status is not mechanically knowable. Canon defines it as the
//      FantasyPros No. 1 QB on that player's NFL team AND says "unresolved camp
//      battles are commissioner-determined". FantasyPros' depth-chart page is
//      client-rendered — verified 2026-08-17, the served HTML contains zero
//      "QB" — so there is no honest scrape behind it either.
//
// So the starter set is an INPUT, never a guess. Supply it and the 4-cap is
// checked; omit it and that half reports `starters_unknown` while the 5-QB
// half — which needs nothing but the roster — still reports precisely.
//
// That split is the point of Principle 3: the deterministic rule becomes
// enforceable today, and the judgement rule becomes VISIBLE, which is the most
// a rule of that shape can honestly be.

import { playerIndex, leagueRosters } from "./lineup_wiring.js";

const _s = (v) => String(v == null ? "" : v).trim();
const _fid = (v) => { const d = _s(v).replace(/\D/g, ""); return d ? d.padStart(4, "0") : ""; };

export const MAX_ACTIVE_QBS = 5;      // §B1 active-roster maximum
export const MAX_STARTING_QBS = 4;    // §B1 starter cap (raised from 3, 2026-07-21)

const TAXI = new Set(["TAXI_SQUAD", "TAXI"]);
const IR = new Set(["INJURED_RESERVE", "IR"]);

// Split one franchise's QBs by roster location.
// Canon is specific about which cap counts what: the 5-max is ACTIVE ROSTER
// only, while the 4-starter cap is "across active roster + taxi combined".
// Conflating them would be the whole bug.
export function splitQbs(roster, players) {
  const active = [], taxi = [], ir = [];
  for (const r of (roster || [])) {
    const p = players && players[r.id];
    if (!p || p.position !== "QB") continue;
    const st = _s(r.status).toUpperCase();
    if (TAXI.has(st)) taxi.push(r.id);
    else if (IR.has(st)) ir.push(r.id);
    else active.push(r.id);
  }
  return { active, taxi, ir };
}

// One franchise's verdict.
//
// `isStartingQb` is a predicate over player_id. Omit it and the starter cap
// reports as unknown rather than resolving to zero — an unsupplied input is not
// evidence of compliance, and reporting "0 starters, all clear" off missing
// data is exactly the fail-open this file exists to avoid.
export function checkFranchiseQbs(roster, players, isStartingQb) {
  const { active, taxi, ir } = splitQbs(roster, players);
  const nameOf = (id) => (players[id] && players[id].name) || id;

  const overActive = active.length > MAX_ACTIVE_QBS;
  const out = {
    active_qbs: active.length, active_qb_ids: active,
    taxi_qbs: taxi.length, ir_qbs: ir.length,
    over_active_max: overActive,
    active_excess: overActive ? active.length - MAX_ACTIVE_QBS : 0,
    active_detail: overActive
      ? `${active.length} QBs on the active roster — ${active.length - MAX_ACTIVE_QBS} over the ${MAX_ACTIVE_QBS} maximum (§B1).`
      : "",
  };

  if (typeof isStartingQb !== "function") {
    return { ...out, starters_known: false, starting_qbs: null, over_starter_cap: null,
             starter_detail: "Starter status not supplied — FantasyPros No. 1 QB per NFL team, commissioner-determined for unresolved camp battles (§B1)." };
  }
  // The starter cap spans active + taxi (§B1), unlike the 5-max above.
  const starters = [...active, ...taxi].filter((id) => isStartingQb(id));
  const over = starters.length > MAX_STARTING_QBS;
  return {
    ...out,
    starters_known: true,
    starting_qbs: starters.length,
    starting_qb_ids: starters,
    starting_qb_names: starters.map(nameOf),
    over_starter_cap: over,
    starter_excess: over ? starters.length - MAX_STARTING_QBS : 0,
    starter_detail: over
      ? `${starters.length} NFL starting QBs across active + taxi — ${starters.length - MAX_STARTING_QBS} over the ${MAX_STARTING_QBS} cap (§B1). Canon: the league cuts the most recently acquired starting QBs in reverse-acquisition order, as standard cuts with penalties charged to next season's cap.`
      : "",
  };
}

// Acquisition order, most recent first — the order canon says cuts run in.
// Offered as INFORMATION for the commissioner, not as an instruction: a player
// with no add event (auction, draft, trade) has no timestamp here and sorts
// last, which is a gap a human should see rather than a machine act on.
export async function acquisitionOrder(env, { season, leagueId, playerIds }) {
  const db = env && env.UPS_MFL_DB;
  if (!db || !(playerIds || []).length) return [];
  const marks = playerIds.map(() => "?").join(",");
  try {
    const { results } = await db.prepare(
      `SELECT player_id, MAX(acquired_at_unix) AS at
         FROM ups_add_events
        WHERE season = ? AND league_id = ? AND player_id IN (${marks})
        GROUP BY player_id`
    ).bind(String(season), String(leagueId), ...playerIds).all();
    const at = {};
    for (const r of (results || [])) at[_s(r.player_id)] = Number(r.at) || 0;
    return playerIds.slice().sort((a, b) => (at[b] || 0) - (at[a] || 0))
      .map((id) => ({ player_id: id, acquired_at_unix: at[id] || null }));
  } catch (_) { return []; }
}

// League-wide report.
export async function checkQbCaps(env, { season, leagueId, startingQbIds }) {
  const [players, rosters] = await Promise.all([
    playerIndex(season, leagueId),
    leagueRosters(season, leagueId, env && env.MFL_COOKIE),
  ]);
  // Fail closed: a report built on an unreadable roster would name innocent
  // franchises, and this one ends in forced cuts.
  if (!players || !rosters) return { ok: false, error: "inputs_unreadable" };

  const starterSet = Array.isArray(startingQbIds) ? new Set(startingQbIds.map(_s)) : null;
  const isStartingQb = starterSet ? ((id) => starterSet.has(_s(id))) : undefined;

  const franchises = [];
  for (const fid of Object.keys(rosters).sort()) {
    const v = checkFranchiseQbs(rosters[fid], players, isStartingQb);
    if (v.over_starter_cap) {
      v.cut_order = await acquisitionOrder(env, { season, leagueId, playerIds: v.starting_qb_ids });
    }
    franchises.push({ franchise_id: fid, ...v });
  }
  return {
    ok: true, season, league_id: leagueId,
    starters_supplied: !!starterSet,
    over_active_max: franchises.filter((f) => f.over_active_max).map((f) => f.franchise_id),
    over_starter_cap: franchises.filter((f) => f.over_starter_cap).map((f) => f.franchise_id),
    franchises,
  };
}
