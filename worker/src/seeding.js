// UPS playoff seeding: the wild-card, seeds 3-6 and bye ladders, and the modern 4+2 field.
//
// docs/league_context_v1.md §F.1 (audited against the original league sources 2026-11-24; Keith's rulings
// 2026-11-25, PR #1526). Four separate rules, never one ladder for all of them:
//   - Division winners: MFL's season-specific standingsSort (standings_truth.js divisionOrder). Not here.
//   - Wild cards (§F.1.2): regular-season All-Play %, then regular-season Points For, then head-to-head.
//     The written rule continues with Power Rank, then a coin flip; this site has neither, so a tie that gets
//     that far is reported as unresolved, never decided here.
//   - Seeds 3-6 (§F.1.3): All-Play %, then Points For. Later steps are pending Keith's ruling: unresolved.
//   - Seeds 1-2 and byes (§F.1.4, 2014-2025 practice): the two division winners with the highest All-Play %.
//     A tie among them (for a bye, or for the order of seeds 1 and 2) is pending Keith's ruling: unresolved.
//   - The Hawk Tuah side (H1-H6, outside the field): NOT covered by §F.1 and not part of this correction; it keeps its
//     earlier order (hawkTuahLadder below) until Keith rules on it.
// There is no overall-record step in any of the playoff ladders. The 2026-05-15 canon text had one, by analogy to the waiver
// tiebreak; it has no league source and the 2017, 2020 and 2021 MFL brackets contradict it (canon §F.1.2-3).
//
// Rows: { franchise_id, franchise_name, allplay_pct, pf_total, overall_pct } -- REGULAR-SEASON values only
//   (overall_pct, the overall record, is read only by the Hawk Tuah order). The current
//   season's come from standings_truth.js regularSeasonTotals (weekly rows, regular-season weeks only), never
//   from a stored season total that may include playoff weeks.
// Games: regular-season, played rows { franchise_id, opponent_franchise_id, team_score, opponent_score }, each
//   game once from each side.

const pad4 = (v) => String(v == null ? "" : v).padStart(4, "0");
// Compare on fixed precision so float noise never decides a seed: percentages
// to 1e-6, points to the tenth MFL reports.
const pctKey = (v) => Math.round(Number(v || 0) * 1e6);
const pfKey = (v) => Math.round(Number(v || 0) * 10);

// Every value a seed_reason.step can take. "unresolved" = every approved step of that pool's ladder is level; the
// order shown is a display fallback (name, then franchise id), not a league rule, and the field reports the tie.
export const SEED_STEPS = ["all_play", "points_for", "head_to_head", "unresolved"];

// What comes after the approved steps (field.unresolved[].why):
//   pending_ruling        -- no league rule yet (seeds 3-6 after Points For; division winners tied on All-Play)
//   power_rank_coin_flip  -- the written wild-card rule continues with Power Rank, then a coin flip
//   head_to_head_3plus    -- three or more teams reached head-to-head; how that step counts is not established
export const LADDERS = {
  wild_card: { steps: ["all_play", "points_for", "head_to_head"], after: "power_rank_coin_flip" },
  seeds3to6: { steps: ["all_play", "points_for"], after: "pending_ruling" },
  bye: { steps: ["all_play"], after: "pending_ruling" },
};

// { wild_card, seeds3to6, bye }: each { cmp, strict, decidingStep, why }.
//   cmp(a, b)          -- orders two rows by that pool's ladder (display fallback after it: name, franchise id)
//   strict(a, b)       -- the approved steps only: 0 when they leave the pair level (a stable sort keeps the input order)
//   decidingStep(a, b) -- the first approved step that separates them, or "unresolved"
//   why(a, b)          -- for an unresolved pair, what the next step would be (see LADDERS)
export function playoffLadders(rows, games, divisionWinnerIds) {
  // Fail closed: the wild-card pool (who can be level with whom) depends on who won the divisions.
  if (!(divisionWinnerIds instanceof Set)) throw new Error("playoffLadders: divisionWinnerIds (a Set) is required");
  const dw = new Set([...divisionWinnerIds].map(pad4));
  // Pairwise results, from each team's own schedule rows.
  const vs = new Map();
  for (const g of games || []) {
    const ts = Number(g.team_score), os = Number(g.opponent_score);
    if (!(ts > 0) || !(os > 0)) continue;               // unplayed
    const k = pad4(g.franchise_id) + "|" + pad4(g.opponent_franchise_id);
    const rec = vs.get(k) || { w: 0, l: 0, t: 0 };
    if (ts > os) rec.w++; else if (ts < os) rec.l++; else rec.t++;
    vs.set(k, rec);
  }
  // Head-to-head (wild cards only) runs inside a group of WILD-CARD-ELIGIBLE teams (not division winners) level on
  // All-Play % AND Points For. A division winner is never part of that contest, so its numbers can neither make a
  // two-team tie look like three nor decide it. Two teams: their games against each other. Three or more: not
  // established, so it decides nothing (h2h3 marks the group). Any other pair: head-to-head is level (0).
  const groups = new Map();
  for (const r of rows || []) {
    if (dw.has(pad4(r.franchise_id))) continue;
    const k = pctKey(r.allplay_pct) + "|" + pfKey(r.pf_total);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(pad4(r.franchise_id));
  }
  const pairPct = new Map(), h2h3 = new Set();
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    if (ids.length > 2) { ids.forEach((f) => h2h3.add(f)); continue; }
    const [a, b] = ids;
    for (const [x, y] of [[a, b], [b, a]]) {
      const rec = vs.get(x + "|" + y);
      const n = rec ? rec.w + rec.l + rec.t : 0;
      pairPct.set(x + "|" + y, n ? (rec.w + 0.5 * rec.t) / n : 0.5);
    }
  }
  const h2hStep = (a, b) => {
    const k = pad4(a.franchise_id) + "|" + pad4(b.franchise_id);
    if (!pairPct.has(k)) return 0;
    return pairPct.get(pad4(b.franchise_id) + "|" + pad4(a.franchise_id)) - pairPct.get(k);
  };
  const STEP = {
    all_play: (a, b) => pctKey(b.allplay_pct) - pctKey(a.allplay_pct),
    points_for: (a, b) => pfKey(b.pf_total) - pfKey(a.pf_total),
    head_to_head: h2hStep,
  };
  const fallback = (a, b) => String(a.franchise_name || "").localeCompare(String(b.franchise_name || "")) ||
    pad4(a.franchise_id).localeCompare(pad4(b.franchise_id));
  const make = (name) => {
    const { steps, after } = LADDERS[name];
    const decidingStep = (a, b) => { for (const s of steps) if (STEP[s](a, b)) return s; return "unresolved"; };
    const strict = (a, b) => { for (const s of steps) { const d = STEP[s](a, b); if (d) return d; } return 0; };
    const cmp = (a, b) => strict(a, b) || fallback(a, b);
    const why = (a, b) => (decidingStep(a, b) !== "unresolved" ? null
      : name === "wild_card" && (h2h3.has(pad4(a.franchise_id)) || h2h3.has(pad4(b.franchise_id))) ? "head_to_head_3plus" : after);
    return { cmp, strict, decidingStep, why };
  };
  return {
    wild_card: make("wild_card"), seeds3to6: make("seeds3to6"), bye: make("bye"),
    divisionWinnerIds: dw,
    hawkTuah: (sideRows) => hawkTuahLadder(sideRows, vs),
  };
}

// The Hawk Tuah side (H1-H6): the six teams outside the field, in the order they had before the 2026-11-25
// correction: All-Play %, then the overall regular-season record, then Points For, then the games among the teams
// still level, then name and franchise id. Canon §F.1 covers the playoff field only; no league source for the
// consolation order was audited, so it is kept as it was until Keith rules on it (ChatGPT review of #1529, item 3).
// The one difference: head-to-head groups are formed among these six only, never with a team in the field.
export const HAWK_TUAH_STEPS = ["all_play", "overall", "points_for", "head_to_head", "name", "franchise_id"];
function hawkTuahLadder(sideRows, vs) {
  const ovrKey = (r) => pctKey(r.overall_pct != null ? r.overall_pct : r.h2h_pct);
  const tieKey = (r) => pctKey(r.allplay_pct) + "|" + ovrKey(r) + "|" + pfKey(r.pf_total);
  const groups = new Map();
  for (const r of sideRows || []) {
    const k = tieKey(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(pad4(r.franchise_id));
  }
  // Each team's record against the OTHER teams of its group; no games among them -> even (.500).
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
    (a, b) => pctKey(b.allplay_pct) - pctKey(a.allplay_pct),
    (a, b) => ovrKey(b) - ovrKey(a),
    (a, b) => pfKey(b.pf_total) - pfKey(a.pf_total),
    (a, b) => h2h(b) - h2h(a),
    (a, b) => String(a.franchise_name || "").localeCompare(String(b.franchise_name || "")),
    (a, b) => pad4(a.franchise_id).localeCompare(pad4(b.franchise_id)),
  ];
  const cmp = (a, b) => { for (const st of steps) { const d = st(a, b); if (d) return d; } return 0; };
  const decidingStep = (a, b) => { for (let i = 0; i < steps.length; i++) if (steps[i](a, b)) return HAWK_TUAH_STEPS[i]; return null; };
  return { cmp, decidingStep };
}

// The modern field (4 division winners + 2 wild cards; §F.1.2-§F.1.4):
//   byes       -- the two division winners with the highest All-Play % (seeds 1-2)
//   wildCards  -- the two best non-winners by the wild-card ladder
//   seeds3to6  -- the other two division winners and the two wild cards, by the seeds 3-6 ladder
//   wildCardRace -- everyone else, by the wild-card ladder (the order of the race for the last wild card)
//   outside    -- the same teams as the Hawk Tuah side, H1-H6, in its own order (hawkTuahLadder)
//   hawkTuah   -- { cmp, decidingStep } of that order
//   unresolved -- every tie the approved steps leave open AND that changes a seed or who qualifies:
//                 [{ pool: "bye" | "seed_1_2_order" | "wild_card" | "seeds3to6", franchise_ids, seeds, why }]
//                 seeds = the seed numbers whose holder depends on it. The lists still carry a display order.
export function playoffField(rows, divisionWinnerIds, L) {
  const isDW = (r) => divisionWinnerIds.has(String(r.franchise_id));
  // The ladders must have been built for THESE division winners (their wild-card head-to-head groups depend on it).
  const want = [...divisionWinnerIds].map(pad4).sort().join(",");
  if (!L || !(L.divisionWinnerIds instanceof Set) || [...L.divisionWinnerIds].sort().join(",") !== want) {
    throw new Error("playoffField: ladders were built for different division winners");
  }
  const winners = rows.filter(isDW).slice().sort(L.bye.cmp);
  const pool = rows.filter((r) => !isDW(r)).slice().sort(L.wild_card.cmp);
  const wildCards = pool.slice(0, 2);
  const byes = winners.slice(0, 2);
  // Stable on the approved steps only: a pair they leave level keeps the order it came in (the division winners in bye
  // order, then the wild cards in wild-card order), so the last wild card in the list is the one the wild-card race
  // put there. That order is a display order, and the tie is reported below.
  const seeds3to6 = winners.slice(2).concat(wildCards).sort(L.seeds3to6.strict);
  const seedOf = new Map();
  byes.forEach((r, i) => seedOf.set(pad4(r.franchise_id), i + 1));
  seeds3to6.forEach((r, i) => seedOf.set(pad4(r.franchise_id), i + 3));
  const ids = (list) => list.map((r) => pad4(r.franchise_id));
  const tiedWith = (list, i, lad) => list.filter((r) => lad.decidingStep(r, list[i]) === "unresolved");
  const unresolved = [];
  // A bye: the 2nd and 3rd division winners level on All-Play. Which one drops to seeds 3-6 also moves the seeds
  // there, so every seed from the first tied place down to 6 depends on it.
  if (winners.length > 2 && L.bye.decidingStep(winners[1], winners[2]) === "unresolved") {
    const g = tiedWith(winners, 1, L.bye);
    const first = Math.min(...g.map((r) => winners.indexOf(r))) + 1;
    unresolved.push({ pool: "bye", franchise_ids: ids(g), seeds: [1, 2, 3, 4, 5, 6].filter((s) => s >= first), why: L.bye.why(winners[1], winners[2]) });
  } else if (winners.length > 1 && L.bye.decidingStep(winners[0], winners[1]) === "unresolved") {
    unresolved.push({ pool: "seed_1_2_order", franchise_ids: ids(winners.slice(0, 2)), seeds: [1, 2], why: L.bye.why(winners[0], winners[1]) });
  }
  // The second wild card: the 2nd and 3rd non-winners level through every step the site can apply.
  if (pool.length > 2 && L.wild_card.decidingStep(pool[1], pool[2]) === "unresolved") {
    const g = tiedWith(pool, 1, L.wild_card);
    const seeds = g.map((r) => seedOf.get(pad4(r.franchise_id))).filter((s) => s != null);
    unresolved.push({ pool: "wild_card", franchise_ids: ids(g), seeds: [...new Set(seeds)].sort((a, b) => a - b), why: L.wild_card.why(pool[1], pool[2]) });
  }
  // The order of seeds 3-6.
  for (let i = 0; i + 1 < seeds3to6.length; i++) {
    if (L.seeds3to6.decidingStep(seeds3to6[i], seeds3to6[i + 1]) !== "unresolved") continue;
    const g = [seeds3to6[i], seeds3to6[i + 1]];
    unresolved.push({ pool: "seeds3to6", franchise_ids: ids(g), seeds: [i + 3, i + 4], why: L.seeds3to6.why(g[0], g[1]) });
  }
  // Outside the field: wildCardRace keeps the wild-card ladder's order (who is next in line for the last wild card);
  // outside is the Hawk Tuah side, H1-H6, in its own unchanged order (hawkTuahLadder).
  const wildCardRace = pool.slice(2);
  const hawk = L.hawkTuah(wildCardRace);
  const outside = wildCardRace.slice().sort(hawk.cmp);
  return { byes, seeds3to6, wildCards, outside, wildCardRace, hawkTuah: hawk, unresolved };
}

// The order /api/standings used before 2026-10-08 (AP%, per-game PF average,
// Overall, name), kept ONLY for seasons with recorded final standings: Keith
// 2026-10-08, "Keep any proposed changes to historical seed records separate
// from this Week 4 release." Recorded seasons are not re-seeded by any ladder;
// the season's MFL bracket is the record of its seeds (canon §F.1.6).
export function legacyStandingsTiebreak(a, b) {
  const desc = (x, y) => Number(y || 0) - Number(x || 0);
  return desc(a.allplay_pct, b.allplay_pct) || desc(a.pf, b.pf) || desc(a.h2h_pct, b.h2h_pct) ||
    String(a.franchise_name || "").localeCompare(String(b.franchise_name || ""));
}

// Recorded seasons only (2010-2025, with legacyStandingsTiebreak): the same 4+2 shape with ONE comparator, as
// /api/standings has always shown them. Unchanged so no historical display moves; a past seed is read from
// MFL's bracket (canon §F.1.6), never recomputed. The current season uses playoffField.
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
