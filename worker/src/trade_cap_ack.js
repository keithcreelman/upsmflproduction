// trade_cap_ack.js — the salary-cap OVERAGE ACKNOWLEDGMENT store (Keith's ruling, 2026-09-28,
// implemented separately from PR #1135): "a proven post-trade salary-cap overage should be
// displayed and explicitly acknowledged, but should not itself block the trade." This module
// owns exactly that -- and NOTHING else. It does not compute cap numbers (trade_cap_authority.js
// still does, unchanged) and it does not touch the loaded-contract hard block or the lineup
// advisory, which remain fully independent of everything in this file.
//
// THE RULE:
//   - A franchise with a proven cap overage (evaluateTradeCompliance()'s cap.status === "blocked")
//     may still trade, but its OWN owner must explicitly acknowledge the specific dollar amount
//     before the trade can accept/execute.
//   - The affected owner acknowledges at THEIR OWN point of agency: the initiator at offer
//     creation (their own overage), each receiving owner at accept (their own overage), each
//     3-way participant separately (their own overage, via the web "acknowledge" action once a
//     block is discovered -- see worker/src/trade_3way.js's capGate()).
//   - An acknowledgment is tied to a SIGNATURE of exactly what was acknowledged (the trade, the
//     franchise, and the projected dollar figures). Whenever those figures are recomputed and
//     the signature no longer matches, the OLD acknowledgment no longer counts -- a fresh one is
//     required. This is what makes "recalculate at accept/execution" and "require a new
//     acknowledgment if the amount changes" the SAME mechanism: staleness is just a signature
//     mismatch.
//   - A CLIENT-SUPPLIED claim of "acknowledged" is NEVER trusted by itself. Every enforcement
//     point either (a) recomputes the violation and a matching signature in the SAME request as
//     the action it gates (offer creation, 2-way accept's own-side check), so there is nothing to
//     forge -- the server's own fresh computation IS the check -- or (b) looks up a PERSISTED row
//     this module wrote from a call that itself required proven caller identity (2-way's
//     initiator-at-creation record, and every 3-way acknowledgment). A request body field that
//     merely CLAIMS an acknowledgment happened is read nowhere in this module or its callers.
//   - An unreadable cap calculation (`cap.status === "unavailable"`) is never treated as
//     acknowledged, satisfied, or safe to skip -- callers must keep failing closed on
//     "unavailable" exactly as they already do; this module only ever answers questions about a
//     PROVEN ("blocked") overage.
//
// The table is created on demand (CREATE TABLE IF NOT EXISTS, the same convention
// worker/src/trade_execution.js's ledger and the outbox use) and also shipped as a migration, so
// the worker does not depend on migration ordering.

// The SAME normalization worker/src/extension_pricing.js's own pricing/compare logic uses for
// "what does this extension request actually claim" -- field-name variants (option_key vs
// optionKey, new_TCV vs new_tcv, etc.) and a preview-string-only request fingerprint identically
// to their equivalent explicit-field form. Reused here (not re-derived) so the acknowledgment
// key can never silently disagree with what the pricing code itself considers "the terms".
import { storedTerms } from "./extension_pricing.js";

export const CAP_ACK_DDL = `CREATE TABLE IF NOT EXISTS ups_trade_cap_acknowledgments (
  league_id             TEXT NOT NULL,
  season                TEXT NOT NULL,
  trade_key             TEXT NOT NULL,
  trade_kind            TEXT NOT NULL,
  franchise_id          TEXT NOT NULL,
  acknowledged_by_fid   TEXT NOT NULL,
  signature             TEXT NOT NULL,
  amount_over_dollars   INTEGER NOT NULL,
  used_after_dollars    INTEGER,
  cap_dollars           INTEGER,
  acknowledged_at_utc   TEXT NOT NULL,
  PRIMARY KEY (league_id, season, trade_key, franchise_id)
)`;

const s = (v) => String(v == null ? "" : v).trim();
const nowIso = () => new Date().toISOString();
const keyOf = (k) => [s(k.leagueId), s(k.season), s(k.tradeKey)];

/**
 * A canonical, order-independent fingerprint of WHICH ASSETS are actually moving in a two-way
 * trade (players, picks, and cap money -- cap money is already folded into these same tokens as
 * BB_<dollars>, see worker/src/trade_accept_integrity.js#tokensByFranchise). NOT the outbox's own
 * payload_hash: that hash is computed from a narrower canonical form (index.js's
 * buildTradeIntentBundleFromPayload -- league/season/franchises/action_type/extension+salary-
 * adjustment XML) that does NOT vary with the traded players/picks themselves when a trade
 * carries no extension component -- two DIFFERENT swaps between the same two franchises would
 * otherwise collide on the identical payload_hash, letting a signature from one satisfy the
 * other. Built from the SAME per-franchise token map trade_cap_authority.js's `movements` are
 * built from, so it's naturally available, unchanged, at both offer creation and every later
 * accept/preview of the SAME offer.
 */
export function capAckAssetKey(tokensByFranchise) {
  const tokens = [];
  for (const fid of Object.keys(tokensByFranchise || {})) {
    for (const tok of tokensByFranchise[fid] || []) tokens.push(`${s(fid)}:${s(tok)}`);
  }
  tokens.sort();
  return tokens.join(",");
}

/**
 * A canonical, order-independent fingerprint of the EXTENSION terms requested in a trade --
 * player, both franchises, and the full authoritative terms (storedTerms(), above), so a request
 * expressed via option_key, via explicit new_TCV/new_aav_future/... fields, or via only a preview
 * string fingerprints identically to any equivalent form of the SAME terms. Two offers moving the
 * SAME assets for the SAME projected dollar figures, but with DIFFERENT extension terms attached
 * to a traded player, must never collide on the same trade_key -- their cap figures can coincide
 * (an extension's current-year salary can be identical across different lengths/pricings) even
 * though the offer being agreed to is genuinely different.
 */
export function capAckExtensionKey(extensionRequests) {
  const rows = Array.isArray(extensionRequests) ? extensionRequests : [];
  const parts = rows.map((r) => {
    const t = storedTerms(r || {});
    return [
      s(r && r.player_id), s(r && r.from_franchise_id), s(r && r.to_franchise_id),
      s(t.term), s(t.loaded), s(t.status_years), s(t.contract_length), s(t.salary_year1),
      JSON.stringify(t.salary_by_year || null), s(t.aav_current), s(t.aav_future), s(t.tcv),
    ].join(":");
  });
  parts.sort();
  return parts.join(";");
}

/**
 * The COMPLETE authoritative-terms fingerprint for a two-way offer's trade_key: the moving
 * assets (capAckAssetKey) AND the extension terms requested (capAckExtensionKey), together.
 * This -- not capAckAssetKey alone -- is what every 2-way cap-acknowledgment call site should
 * use, so an acknowledgment is bound to the SPECIFIC offer as agreed, not merely to which players
 * moved.
 */
export function capAckTermsKey({ tokensByFranchise, extensionRequests }) {
  return `${capAckAssetKey(tokensByFranchise)}||EXT:${capAckExtensionKey(extensionRequests)}`;
}

/**
 * The deterministic fingerprint of "this is exactly what is being acknowledged": which trade
 * (its complete authoritative terms -- see capAckTermsKey), which franchise, and the two dollar
 * figures that fully determine the overage (the projected post-trade total and the amount over).
 * The dollar figures are the SAME violation-row fields trade_cap_authority.js already returns
 * (`franchise_id`, `amount_over`, `projected_used`) -- nothing here is re-derived independently,
 * so this can never drift out of step with the actual cap calculation. Any change to the trade's
 * terms OR either dollar figure changes the signature, which is exactly what makes a stale
 * acknowledgment stop matching.
 */
export function capAckSignature({ tradeKey, franchiseId, amountOver, usedAfter }) {
  return `${s(tradeKey)}|${s(franchiseId)}|${Math.round(Number(amountOver) || 0)}|${Math.round(Number(usedAfter) || 0)}`;
}

/**
 * PURE. Given the CURRENT cap violations (trade_cap_authority.js's `cap.violations`, i.e. only
 * the franchises actually over the cap right now) and the currently-STORED acknowledgment rows
 * for this trade (by franchise_id), decide which violated franchises are covered and which still
 * need a fresh acknowledgment. A franchise with NO violation right now needs nothing, regardless
 * of what may be stored for it (an old acknowledgment for a violation that's gone is simply
 * irrelevant, never consulted). No D1, no fetch -- easy to test exhaustively.
 * @param violations  array of { franchise_id, amount_over, projected_used, ... } (cap.violations)
 * @param tradeKey    the SAME trade_key the stored rows were written against
 * @param acks        { [franchise_id]: { signature, acknowledged_by_fid, acknowledged_at_utc, ... } | undefined }
 * @returns { satisfied: boolean, perFranchise: [{ franchise_id, franchise_name, amount_over, status: "acknowledged"|"missing"|"stale", acknowledged_by_fid, acknowledged_at_utc }] }
 */
export function evaluateCapAcknowledgment({ violations, tradeKey, acks }) {
  const acksByFid = acks || {};
  const perFranchise = (violations || []).map((v) => {
    const fid = s(v.franchise_id);
    const wantSig = capAckSignature({ tradeKey, franchiseId: fid, amountOver: v.amount_over, usedAfter: v.projected_used });
    const row = acksByFid[fid];
    const status = !row ? "missing" : s(row.signature) === wantSig ? "acknowledged" : "stale";
    return {
      franchise_id: fid,
      franchise_name: v.franchise_name || fid,
      amount_over: v.amount_over,
      status,
      acknowledged_by_fid: row ? row.acknowledged_by_fid : null,
      acknowledged_at_utc: row ? row.acknowledged_at_utc : null,
    };
  });
  return { satisfied: perFranchise.every((f) => f.status === "acknowledged"), perFranchise };
}

/** All acknowledgment-store operations for one D1 database. */
export function makeCapAckStore(db) {
  let ensured = false;
  const ensure = async () => { if (!ensured) { await db.prepare(CAP_ACK_DDL).run(); ensured = true; } };

  /** Every stored row for one trade, keyed by franchise_id (only what's actually stored --
   * callers compare against the CURRENT violations themselves via evaluateCapAcknowledgment). */
  const readAllForTrade = async (k) => {
    await ensure();
    const { results } = await db.prepare(
      "SELECT * FROM ups_trade_cap_acknowledgments WHERE league_id=? AND season=? AND trade_key=?"
    ).bind(...keyOf(k)).all();
    const out = {};
    for (const r of results || []) out[s(r.franchise_id)] = hydrate(r);
    return out;
  };

  const read = async (k, franchiseId) => {
    await ensure();
    const row = await db.prepare(
      "SELECT * FROM ups_trade_cap_acknowledgments WHERE league_id=? AND season=? AND trade_key=? AND franchise_id=?"
    ).bind(...keyOf(k), s(franchiseId)).first();
    return row ? hydrate(row) : null;
  };

  /** Record (upsert) ONE franchise's acknowledgment. Always overwrites whatever was stored
   * before -- there is only ever the MOST RECENT acknowledgment for a franchise+trade, which is
   * exactly the "a fresh acknowledgment replaces a stale one" behavior this module exists for. */
  const record = async (k, { franchiseId, acknowledgedByFid, signature, amountOverDollars, usedAfterDollars, capDollars, tradeKind }) => {
    await ensure();
    const at = nowIso();
    await db.prepare(
      `INSERT INTO ups_trade_cap_acknowledgments
         (league_id, season, trade_key, trade_kind, franchise_id, acknowledged_by_fid, signature, amount_over_dollars, used_after_dollars, cap_dollars, acknowledged_at_utc)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(league_id, season, trade_key, franchise_id) DO UPDATE SET
         trade_kind=excluded.trade_kind, acknowledged_by_fid=excluded.acknowledged_by_fid, signature=excluded.signature,
         amount_over_dollars=excluded.amount_over_dollars, used_after_dollars=excluded.used_after_dollars,
         cap_dollars=excluded.cap_dollars, acknowledged_at_utc=excluded.acknowledged_at_utc`
    ).bind(...keyOf(k), s(tradeKind) || "two_way", s(franchiseId), s(acknowledgedByFid), s(signature),
      Math.round(Number(amountOverDollars) || 0), Number.isFinite(Number(usedAfterDollars)) ? Math.round(Number(usedAfterDollars)) : null,
      Number.isFinite(Number(capDollars)) ? Math.round(Number(capDollars)) : null, at).run();
    return { acknowledged_at_utc: at };
  };

  return { ensure, read, readAllForTrade, record };
}

function hydrate(row) {
  return {
    league_id: row.league_id, season: row.season, trade_key: row.trade_key, trade_kind: row.trade_kind,
    franchise_id: row.franchise_id, acknowledged_by_fid: row.acknowledged_by_fid, signature: row.signature,
    amount_over_dollars: row.amount_over_dollars, used_after_dollars: row.used_after_dollars, cap_dollars: row.cap_dollars,
    acknowledged_at_utc: row.acknowledged_at_utc,
  };
}
