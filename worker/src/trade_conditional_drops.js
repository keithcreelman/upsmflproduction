// trade_conditional_drops.js — the LOADED-CONTRACT conditional-drop SELECTION store (Keith's
// ruling, 2026-09-29, correcting a real gap: HammerTime's roster was already over the 5-loaded-
// contract limit and building/reviewing a trade as the SENDER showed no warning at all -- the
// loaded-contract check (PR #1135) was wired only into the RECIPIENT's accept/preview path).
//
// THE RULE:
//   - A franchise projected over the 5-loaded-contract limit (worker/src/trade_cap_authority.js's
//     `loaded_contracts.status !== "ok"`) may still trade, but only once its OWN owner has
//     selected enough of ITS OWN loaded-contract players to drop, conditional on the trade going
//     through. required_drops = max(0, projected − 5); NEVER equated with the number of loaded
//     players received (a team can owe drops on a trade that receives zero loaded contracts, if
//     it was already over before the trade, or owes fewer drops than it receives if it also sends
//     some away).
//   - Selection validity is checked FRESH, every time, directly against live data
//     (evaluateTradeCompliance's own conditionalDrops evaluation: on-roster, genuinely loaded, not
//     also being sent) -- there is no signature/staleness concept here the way
//     worker/src/trade_cap_ack.js needs one for cap dollar figures. A selection is simply valid or
//     invalid right now; this module only persists WHICH player ids were selected, never a verdict.
//   - The affected owner selects (and, by submitting, confirms) at their own point of agency: the
//     initiator for their own requirement at offer creation, each receiving owner for their own at
//     accept, each 3-way participant separately via a dedicated action -- mirroring
//     trade_cap_ack.js's three enforcement points exactly.
//   - A CLIENT-SUPPLIED claim of "confirmed" is never trusted by itself: every write requires
//     proven caller identity (viewer.fid / the session's own franchise), never a body-supplied
//     claim, and every read of "is this trade's loaded-contract requirement satisfied" recomputes
//     from THIS store's persisted rows plus a FRESH live-roster classification, never from a
//     client-echoed verdict.
//   - A player sent in the trade can never also be selected as a conditional drop -- enforced by
//     evaluateTradeCompliance's own validation (also_being_sent), not duplicated here.
//   - This module does NOT execute a drop or a trade. It only records what an owner selected.
//     Whether/how those selections are ever turned into a real MFL drop + a real MFL trade is a
//     SEPARATE, NOT-YET-BUILT execution path (see docs/ for the traced design) -- selecting and
//     confirming drops here changes nothing in MFL by itself.
//
// The table is created on demand (CREATE TABLE IF NOT EXISTS, the same convention
// worker/src/trade_cap_ack.js, trade_execution.js's ledger and the outbox use) and also shipped as
// a migration, so the worker does not depend on migration ordering.

export const CONDITIONAL_DROPS_DDL = `CREATE TABLE IF NOT EXISTS ups_trade_conditional_drops (
  league_id             TEXT NOT NULL,
  season                TEXT NOT NULL,
  trade_key             TEXT NOT NULL,
  trade_kind            TEXT NOT NULL,
  franchise_id          TEXT NOT NULL,
  player_id             TEXT NOT NULL,
  selected_by_fid       TEXT NOT NULL,
  selected_at_utc       TEXT NOT NULL,
  PRIMARY KEY (league_id, season, trade_key, franchise_id, player_id)
)`;

const s = (v) => String(v == null ? "" : v).trim();
const nowIso = () => new Date().toISOString();
const keyOf = (k) => [s(k.leagueId), s(k.season), s(k.tradeKey)];

/** All conditional-drop-selection operations for one D1 database. */
export function makeConditionalDropStore(db) {
  let ensured = false;
  const ensure = async () => { if (!ensured) { await db.prepare(CONDITIONAL_DROPS_DDL).run(); ensured = true; } };

  /** Every selected player id for every franchise in this trade: { franchise_id -> [player_id, ...] }.
   * Callers pass this straight into evaluateTradeCompliance's `conditionalDrops` -- validity is
   * re-derived fresh from live data there, never trusted from what's merely stored here. */
  const readAllForTrade = async (k) => {
    await ensure();
    const { results } = await db.prepare(
      "SELECT franchise_id, player_id FROM ups_trade_conditional_drops WHERE league_id=? AND season=? AND trade_key=? ORDER BY franchise_id, player_id"
    ).bind(...keyOf(k)).all();
    const out = {};
    for (const r of results || []) {
      const fid = s(r.franchise_id);
      (out[fid] || (out[fid] = [])).push(s(r.player_id));
    }
    return out;
  };

  /** One franchise's own selected player ids only. */
  const readForFranchise = async (k, franchiseId) => {
    const all = await readAllForTrade(k);
    return all[s(franchiseId)] || [];
  };

  /** REPLACE one franchise's whole selection set (an owner freely revises their pick until it's
   * used; submitting IS the confirmation -- there is no separate unconfirmed/draft state here).
   * `playerIds` may be an empty array (clears the selection, e.g. the requirement dropped to 0
   * after the trade's own assets changed). Always requires the PROVEN caller to be the franchise
   * whose selection this is -- callers enforce that before calling this. */
  const setForFranchise = async (k, { franchiseId, playerIds, selectedByFid }) => {
    await ensure();
    const fid = s(franchiseId);
    const ids = [...new Set((Array.isArray(playerIds) ? playerIds : []).map(s).filter(Boolean))];
    const at = nowIso();
    const stmts = [db.prepare(
      "DELETE FROM ups_trade_conditional_drops WHERE league_id=? AND season=? AND trade_key=? AND franchise_id=?"
    ).bind(...keyOf(k), fid)];
    for (const pid of ids) {
      stmts.push(db.prepare(
        `INSERT INTO ups_trade_conditional_drops (league_id, season, trade_key, trade_kind, franchise_id, player_id, selected_by_fid, selected_at_utc)
         VALUES (?,?,?,?,?,?,?,?)`
      ).bind(...keyOf(k), s(k.tradeKind) || "two_way", fid, pid, s(selectedByFid), at));
    }
    if (db.batch) await db.batch(stmts); else for (const st of stmts) await st.run();
    return { selected_at_utc: at, player_ids: ids };
  };

  return { ensure, readAllForTrade, readForFranchise, setForFranchise };
}
