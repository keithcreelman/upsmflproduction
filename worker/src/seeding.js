// UPS playoff seeding: the tiebreak ladder and the modern 4+2 field.
//
// docs/league_context_v1.md §F.1 / §F.2: seeds rank by ALL-PLAY %, then OVERALL
// record, then POINTS FOR, then HEAD-TO-HEAD (Keith 2026-10-08: "Our Phase I
// rule is All-Play % → Overall → PF → H2H"). The full standings page uses the
// same ladder. Division WINNERS are picked separately, by MFL's year-specific
// standingsSort (§F.2 -- do not conflate the two).
//
// WHY THIS MODULE (2026-10-08). The two endpoints had drifted apart and neither
// followed the ladder end to end: /api/standings broke all-play ties on a
// per-game PF AVERAGE before Overall, and /api/playoff-bracket ranked division
// winners, seeds 3-6 and the non-playoff teams on all-play then PF, skipping
// Overall. With Week 4 of 2026 that showed Brian Cutting (4-6) above Eric
// Mannila (6-4) at 22-22. Both endpoints now take their order from here.
//
// Rows: { franchise_id, franchise_name, allplay_pct, h2h_pct, pf_total }.
//   h2h_pct  -- src_standings' OVERALL regular-season record; the column's "h2h"
//               prefix predates §F.1's Overall/H2H split.
//   pf_total -- season Points For (src_standings.pf), NOT /api/standings' per-game
//               average `pf`.
// Games: regular-season, played src_schedule rows { franchise_id,
//   opponent_franchise_id, team_score, opponent_score }. Each game appears once
//   from each side, so a team's own rows give its record against an opponent.

const pad4 = (v) => String(v == null ? "" : v).padStart(4, "0");
// Compare on fixed precision so float noise never decides a seed: percentages
// to 1e-6, points to the tenth MFL reports.
const pctKey = (v) => Math.round(Number(v || 0) * 1e6);
const pfKey = (v) => Math.round(Number(v || 0) * 10);

// The ladder's steps, in order, by name. A response says which one separated two teams (seed_reason), so no page ever
// re-derives the ladder to explain a seed (Keith 2026-10-09: "Current-season seeds get an authoritative worker seed
// reason"). "name" and "franchise_id" are the deterministic fallback, not a league rule.
export const SEED_STEPS = ["all_play", "overall", "points_for", "head_to_head", "name", "franchise_id"];

// { cmp, decidingStep }: cmp orders two rows by the ladder; decidingStep(a, b) names the FIRST step that separates them
// (one of SEED_STEPS), or null when nothing does. Both read the same steps, so an explanation can never disagree with
// the order it explains.
export function seedLadderSteps(rows, games) {
  const tieKey = (r) => pctKey(r.allplay_pct) + "|" + pctKey(r.h2h_pct) + "|" + pfKey(r.pf_total);

  // Pairwise head-to-head results, from each team's own schedule rows.
  const vs = new Map();
  for (const g of games || []) {
    const ts = Number(g.team_score), os = Number(g.opponent_score);
    if (!(ts > 0) || !(os > 0)) continue;               // unplayed
    const k = pad4(g.franchise_id) + "|" + pad4(g.opponent_franchise_id);
    const rec = vs.get(k) || { w: 0, l: 0, t: 0 };
    if (ts > os) rec.w++; else if (ts < os) rec.l++; else rec.t++;
    vs.set(k, rec);
  }

  // Step 4 only ever runs inside a group tied on all three earlier steps, so it
  // is resolved per group: each team's record against the OTHER teams of its
  // group (a 3-way tie is ranked on games among those three, which pairwise
  // comparison alone could leave circular). No games among them -> even (.500).
  const groups = new Map();
  for (const r of rows || []) {
    const k = tieKey(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(pad4(r.franchise_id));
  }
  const h2hPct = new Map();
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    for (const a of ids) {
      let w = 0, l = 0, t = 0;
      for (const b of ids) {
        if (a === b) continue;
        const rec = vs.get(a + "|" + b);
        if (rec) { w += rec.w; l += rec.l; t += rec.t; }
      }
      const n = w + l + t;
      h2hPct.set(a, n ? (w + 0.5 * t) / n : 0.5);
    }
  }
  const h2h = (r) => (h2hPct.has(pad4(r.franchise_id)) ? h2hPct.get(pad4(r.franchise_id)) : 0.5);

  const steps = [
    (a, b) => pctKey(b.allplay_pct) - pctKey(a.allplay_pct),   // 1. All-Play %
    (a, b) => pctKey(b.h2h_pct) - pctKey(a.h2h_pct),           // 2. Overall record
    (a, b) => pfKey(b.pf_total) - pfKey(a.pf_total),           // 3. Points For (season)
    (a, b) => h2h(b) - h2h(a),                                 // 4. head-to-head within the tie
    (a, b) => String(a.franchise_name || "").localeCompare(String(b.franchise_name || "")),
    (a, b) => pad4(a.franchise_id).localeCompare(pad4(b.franchise_id)),
  ];
  const cmp = (a, b) => {
    for (const step of steps) { const d = step(a, b); if (d) return d; }
    return 0;
  };
  const decidingStep = (a, b) => {
    for (let i = 0; i < steps.length; i++) if (steps[i](a, b)) return SEED_STEPS[i];
    return null;
  };
  return { cmp, decidingStep };
}

export function seedLadder(rows, games) {
  return seedLadderSteps(rows, games).cmp;
}

// The order /api/standings used before 2026-10-08 (AP%, per-game PF average,
// Overall, name), kept ONLY for seasons with recorded final standings: Keith
// 2026-10-08, "Keep any proposed changes to historical seed records separate
// from this Week 4 release." Applying the ladder to 2010-2025 would move 2013's
// seeds 3/4 and 2022's seeds 1/2; that is a separate proposal.
export function legacyStandingsTiebreak(a, b) {
  const desc = (x, y) => Number(y || 0) - Number(x || 0);
  return desc(a.allplay_pct, b.allplay_pct) || desc(a.pf, b.pf) || desc(a.h2h_pct, b.h2h_pct) ||
    String(a.franchise_name || "").localeCompare(String(b.franchise_name || ""));
}

// The modern field (4 division winners + 2 wild cards; §F.1): seeds 1-2 are the
// two best division winners; seeds 3-6 are the other division winners and the
// two best non-winners, interleaved; everyone else is outside the field. Every
// list is ordered by the ladder.
export function modernField(rows, divisionWinnerIds, cmp) {
  const isDW = (r) => divisionWinnerIds.has(String(r.franchise_id));
  const winners = rows.filter(isDW).slice().sort(cmp);
  const pool = rows.filter((r) => !isDW(r)).slice().sort(cmp);
  const wildCards = pool.slice(0, 2);
  return {
    byes: winners.slice(0, 2),
    seeds3to6: winners.slice(2).concat(wildCards).sort(cmp),
    wildCards,
    outside: pool.slice(2),
  };
}
