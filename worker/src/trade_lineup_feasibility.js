// trade_lineup_feasibility.js — ADVISORY post-trade lineup-legality warning for the Trade
// War Room. Answers "could this franchise still field one complete legal 18-man lineup
// after the proposed trade" via a real maximum-bipartite-matching assignment of players to
// slots (never blocks a trade -- see evaluateLineupFeasibility's return contract).
//
// Distinct from:
//   - worker/src/trade_cap_authority.js's `roster` block -- that is a bare ACTIVE-COUNT
//     advisory (total roster size vs 27 min / league max), no per-position awareness at all.
//   - worker/src/lineup_compliance.js -- STARTER-STATUS compliance (missing starter / bye /
//     Out / Doubtful-and-didn't-play) for an ALREADY-SUBMITTED weekly lineup, evaluated at a
//     kickoff anchor. Answers "did the owner start an illegal/injured player this week", not
//     "does this roster have enough players at each position to structurally fill 18 slots
//     at all". Current-week bye/injury/Out/Doubtful availability is intentionally OUT OF
//     SCOPE here -- the task that specified this module calls it a SEPARATE courtesy warning
//     that must never be conflated with structural feasibility, and it is not built in this
//     pass (documented limitation, not a silent gap).
//   - worker/src/index.js `computeLineupNeeds()`/`auctionEligibility()` (~24545-25675) -- the
//     nearest existing server-side analogue (position-group deficit math for a single
//     hypothetical FA-Auction add), scoped to the auction roster-size window (27-35), not
//     reusable as-is for a multi-asset trade's arbitrary send/receive set.
//
// Pure functions only -- no fetch, no DOM, no D1. The caller (trade_cap_authority.js)
// assembles each participating franchise's POST-TRADE roster snapshot and calls
// evaluateLineupFeasibility() with it.

const s = (v) => String(v == null ? "" : v).trim();

// The complete 18-slot legal lineup, per the league's structure. Order does not affect
// correctness (maximum bipartite matching finds the true maximum regardless of slot
// order) -- it only affects which of several EQUALLY VALID assignments is chosen when a
// player could fill more than one open slot; the reported "missing" counts are grouped by
// slot LABEL (not by specific slot instance), so that choice never changes what's reported.
export const LINEUP_SLOTS = Object.freeze([
  { key: "QB1", label: "Quarterback", eligible: ["QB"] },
  { key: "RB1", label: "Running Back", eligible: ["RB"] },
  { key: "RB2", label: "Running Back", eligible: ["RB"] },
  { key: "WR1", label: "Wide Receiver", eligible: ["WR"] },
  { key: "WR2", label: "Wide Receiver", eligible: ["WR"] },
  { key: "TE1", label: "Tight End", eligible: ["TE"] },
  { key: "FLEX1", label: "Flex", eligible: ["RB", "WR", "TE"] },
  { key: "FLEX2", label: "Flex", eligible: ["RB", "WR", "TE"] },
  { key: "SFLEX1", label: "SuperFlex", eligible: ["QB", "RB", "WR", "TE"] },
  { key: "PK1", label: "Kicker", eligible: ["PK"] },
  { key: "PN1", label: "Punter", eligible: ["PN"] },
  { key: "DL1", label: "Defensive Line", eligible: ["DL"] },
  { key: "DL2", label: "Defensive Line", eligible: ["DL"] },
  { key: "LB1", label: "Linebacker", eligible: ["LB"] },
  { key: "LB2", label: "Linebacker", eligible: ["LB"] },
  { key: "DB1", label: "Defensive Back", eligible: ["DB"] },
  { key: "DB2", label: "Defensive Back", eligible: ["DB"] },
  { key: "DFLEX1", label: "Defensive Flex", eligible: ["DL", "LB", "DB"] },
]);
export const REQUIRED_LINEUP_SIZE = LINEUP_SLOTS.length; // 18

// Raw MFL position -> canonical slot-eligibility group. Superset-safe (NT folded into DL,
// matching site/m/front_office_lineup.js's posGroup(); FS/SS folded into DB alongside S).
const POS_GROUP_MAP = Object.freeze({
  QB: "QB", RB: "RB", WR: "WR", TE: "TE", PK: "PK", PN: "PN",
  DE: "DL", DT: "DL", NT: "DL", DL: "DL",
  LB: "LB", OLB: "LB", ILB: "LB", MLB: "LB",
  CB: "DB", S: "DB", FS: "DB", SS: "DB", DB: "DB",
});
export function posGroup(rawPosition) {
  return POS_GROUP_MAP[s(rawPosition).toUpperCase()] || "";
}

/**
 * Maximum bipartite matching (Kuhn's algorithm / augmenting paths) between lineup slots
 * and eligible players. Guaranteed to find a TRUE maximum-cardinality matching -- not a
 * greedy approximation -- which is why an assignment-count comparison alone ("2 RBs and 2
 * WRs" style counting) is insufficient here: with overlapping Flex/SuperFlex/DL/DB/D-Flex
 * eligibility, only a real matching algorithm proves whether every fixed AND flexible slot
 * can be simultaneously filled without double-booking a player.
 *
 * @param slots    LINEUP_SLOTS-shaped array
 * @param players  [{ id, group }] -- already position-grouped, already excluding
 *                 taxi/IR/expired/unrecognized-position players (the caller's job)
 * @returns { matchSlot: number[] }  matchSlot[slotIndex] = playerIndex, or -1 if unfilled
 */
export function maxBipartiteMatch(slots, players) {
  const matchPlayer = new Array(players.length).fill(-1); // playerIndex -> slotIndex
  const matchSlot = new Array(slots.length).fill(-1); // slotIndex -> playerIndex

  function tryAssign(slotIndex, visited) {
    const eligible = slots[slotIndex].eligible;
    for (let pi = 0; pi < players.length; pi++) {
      if (visited[pi] || !eligible.includes(players[pi].group)) continue;
      visited[pi] = true;
      if (matchPlayer[pi] === -1 || tryAssign(matchPlayer[pi], visited)) {
        matchPlayer[pi] = slotIndex;
        matchSlot[slotIndex] = pi;
        return true;
      }
    }
    return false;
  }

  for (let si = 0; si < slots.length; si++) {
    tryAssign(si, new Array(players.length).fill(false));
  }
  return { matchSlot };
}

/**
 * @param roster  [{ id, group, excluded }] -- one row per rostered player. `group` is the
 *                ALREADY-canonicalized slot-eligibility group (the caller runs posGroup()
 *                on the player's raw MFL position first -- an unrecognized/blank position
 *                canonicalizes to "" and is simply unusable for any slot, not an error).
 *                `excluded` (true for taxi/IR/expired-contract players, per the caller)
 *                removes the player from the pool entirely before matching -- "not
 *                startable" means literally unavailable as a candidate, not deprioritized.
 * @returns { filled, total, missing: [{slot,count}], complete }
 */
export function evaluateLineupForRoster(roster) {
  const pool = (Array.isArray(roster) ? roster : [])
    .filter((r) => r && !r.excluded && r.group)
    .map((r) => ({ id: s(r.id), group: String(r.group).toUpperCase() }));
  const { matchSlot } = maxBipartiteMatch(LINEUP_SLOTS, pool);
  const missingCounts = {};
  let filled = 0;
  matchSlot.forEach((playerIdx, slotIdx) => {
    if (playerIdx === -1) {
      const label = LINEUP_SLOTS[slotIdx].label;
      missingCounts[label] = (missingCounts[label] || 0) + 1;
    } else {
      filled += 1;
    }
  });
  const missing = Object.entries(missingCounts).map(([slot, count]) => ({ slot, count }));
  return { filled, total: REQUIRED_LINEUP_SIZE, missing, complete: missing.length === 0 };
}

function formatMissing(missing) {
  return missing.map((m) => `${m.count} ${m.slot}${m.count > 1 ? "s" : ""}`).join(" and ");
}

/**
 * @param franchises  { [fid]: { name, roster: [{id, group, excluded}] | null } }
 *                    roster:null means position/taxi/IR authority was unavailable for this
 *                    franchise -- reported honestly as "unavailable", never as compliant.
 * @param expectedFids  the full participant list -- every one must appear in `franchises`.
 * @returns the `lineup` sibling block for the shared compliance object: { status, advisory,
 *          rows, warnings, message } -- same status vocabulary as the existing `roster`
 *          block ("ok" | "warn" | "unavailable"), and ALWAYS advisory: true. This function
 *          never returns a "blocked" status -- it is structurally incapable of blocking a
 *          trade; callers must not add a block branch keyed on this result.
 */
export function evaluateLineupFeasibility({ franchises, expectedFids }) {
  const fids = Array.isArray(expectedFids) ? expectedFids : [];
  const rows = [];
  const warnings = [];
  let anyUnavailable = false;
  for (const fid of fids) {
    const fr = franchises && franchises[fid];
    if (!fr || fr.roster == null) {
      anyUnavailable = true;
      rows.push({ franchise_id: fid, franchise_name: (fr && fr.name) || fid, status: "unavailable", filled: null, total: REQUIRED_LINEUP_SIZE, missing: [] });
      continue;
    }
    const result = evaluateLineupForRoster(fr.roster);
    const rowStatus = result.complete ? "ok" : "warn";
    const row = { franchise_id: fid, franchise_name: fr.name || fid, status: rowStatus, filled: result.filled, total: result.total, missing: result.missing };
    rows.push(row);
    if (!result.complete) {
      warnings.push({ ...row, message: `${row.franchise_name} could not STRUCTURALLY field a complete legal lineup after this trade (not enough rostered players at the required positions -- this does not account for this week's byes, injuries, Out/Doubtful designations, or kickoff locks). Missing: ${formatMissing(result.missing)}. This does not block the trade, but the roster must be corrected under the league's lineup-compliance rules.` });
    }
  }
  const status = anyUnavailable ? "unavailable" : (warnings.length ? "warn" : "ok");
  const message = anyUnavailable
    ? "Lineup feasibility couldn't be checked for every team (position/roster data unavailable) -- not evaluated, not assumed compliant."
    : (warnings.length ? warnings.map((w) => w.message).join(" ") : "Every team stays structurally able to field a complete legal lineup after this trade (positions only -- this week's byes, injuries, Out/Doubtful designations, and kickoff locks are a separate check, not part of this).");
  return { status, advisory: true, rows, warnings, message };
}
