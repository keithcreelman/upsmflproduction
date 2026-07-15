// trade_sentinel.js — pure logic + D1 state machine + Discord composition for
// the trade-offer sentinel. The MFL I/O tick lives in index.js
// (POST /admin/trade-sentinel/tick) because it needs the request-scoped
// parsers and the canon-compliant commish-cookie import path; everything
// testable lives here (bare-node, like trade_dm_cadence.js).
//
// WHAT THE SENTINEL IS (Keith 2026-07-15):
//   1. Every pending MFL offer — in-app AND created natively on MFL's site —
//      gets an effective 14-day life: a silent revoke+re-propose at ~day 6.5
//      (no new Day-1 blast; the nudge clock never notices) unless MFL honors
//      a long EXPIRES outright. Max 14 days, one re-offer ever.
//   2. An offer whose assets moved in ANOTHER executed trade dies everywhere:
//      revoked on MFL, nudges stopped, DM buttons killed, one death DM to the
//      recipient naming the asset and where it went. Symmetric — either side
//      losing an asset kills it.
//
// SAFETY MODEL: TRADE_SENTINEL_ENABLED = watch/mirror only. Every MFL write
// is additionally gated on TRADE_SENTINEL_ACT_ENABLED + the allowlist; with
// ACT off the tick records {would:...} entries in act_log instead. All state
// transitions are optimistic-locked (UPDATE ... WHERE lifecycle='pending');
// meta.changes===0 means another path won the race — yield silently.
// Discord deps are imported DYNAMICALLY inside the functions that need them:
// the static chain (discord_round → anthropic_explain → league_context_v1.md)
// only resolves under wrangler's bundler, and this module's pure functions
// must stay importable in bare node for unit tests (trade_dm_cadence pattern).

const safeStr = (v) => String(v == null ? "" : v).trim();
const safeInt = (v, fb = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : fb; };
const digits = (v) => safeStr(v).replace(/\D/g, "");
const padFid = (v) => digits(v).padStart(4, "0");
export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

export const REOFFER_AT_HOURS = 156;   // ~day 6.5 — before MFL's 7d default expiry
export const MAX_LIFE_HOURS = 336;     // 14 days, Keith's hard max
export const MFL_WRITE_CAP_PER_TICK = 4; // burst-throttle guard (~8 commish ops/burst observed)

// ── Token parsing (pure) ────────────────────────────────────────────────
// MFL trade token CSV: bare player ids, FP_<origFid>_<yr>_<rd>, DP_<rd0>_<slot0>,
// BB_<amt>. BB_ (cap money) is deliberately NOT an invalidator — balances
// fluctuate legitimately with every transaction.
export function parseTradeTokenList(csv) {
  return safeStr(csv).split(",").map((t) => safeStr(t)).filter(Boolean);
}
export function tokenKind(token) {
  const t = safeStr(token).toUpperCase();
  if (/^\d+$/.test(t)) return "player";
  if (t.startsWith("FP_")) return "pick";
  if (t.startsWith("DP_")) return "pick";
  if (t.startsWith("BB_")) return "cap_money";
  return "unknown";
}

// ── Invalidation decision (pure) ────────────────────────────────────────
// ownedPlayers: Map<fid, Set<pid>>; ownedPicks: Map<fid, Set<TOKEN-uppercase>>.
// Returns [] when clean, else violation objects. Symmetric by construction:
// the offerer must still own will_give_up, the recipient will_receive.
// "unknown" tokens are IGNORED (advisory-open — never invent a refusal from
// a token we can't classify).
export function findOwnershipViolations(watchRow, ownedPlayers, ownedPicks) {
  const out = [];
  const sides = [
    { side: "will_give_up", ownerFid: padFid(watchRow.from_franchise_id) },
    { side: "will_receive", ownerFid: padFid(watchRow.to_franchise_id) },
  ];
  for (const { side, ownerFid } of sides) {
    for (const token of parseTradeTokenList(watchRow[side])) {
      const kind = tokenKind(token);
      if (kind === "cap_money" || kind === "unknown") continue;
      const owned = kind === "player"
        ? ownedPlayers.get(ownerFid)?.has(digits(token))
        : ownedPicks.get(ownerFid)?.has(safeStr(token).toUpperCase());
      if (!owned) out.push({ token, kind, side, owner_fid: ownerFid });
    }
  }
  return out;
}

// Is this watch row due for its one re-offer? (pure)
export function reofferDue(watchRow, nowMs) {
  if (safeStr(watchRow.lifecycle) !== "pending") return false;
  if (safeStr(watchRow.reoffered_trade_id)) return false; // already re-offered
  if (safeStr(watchRow.reoffer_of)) return false;         // IS a re-offer — never again
  const anchorMs = Date.parse(watchRow.anchor_utc);
  if (!Number.isFinite(anchorMs)) return false;
  const h = (nowMs - anchorMs) / 3600000;
  return h >= REOFFER_AT_HOURS && h < 168; // the window before MFL's own 7d expiry
}
export function pastMaxLife(watchRow, nowMs) {
  const anchorMs = Date.parse(watchRow.anchor_utc);
  return Number.isFinite(anchorMs) && nowMs - anchorMs >= MAX_LIFE_HOURS * 3600000;
}

// ── D1 helpers ──────────────────────────────────────────────────────────
export async function appendActLog(env, tradeId, entry) {
  try {
    const row = await env.UPS_MFL_DB.prepare(
      `SELECT act_log FROM ups_trade_offer_watch WHERE trade_id = ?`
    ).bind(safeStr(tradeId)).first();
    let log = [];
    try { log = JSON.parse(row?.act_log || "[]"); } catch (_) { log = []; }
    log.push({ ...entry, at: nowIso() });
    await env.UPS_MFL_DB.prepare(
      `UPDATE ups_trade_offer_watch SET act_log = ?, updated_at_utc = ? WHERE trade_id = ?`
    ).bind(JSON.stringify(log.slice(-30)), nowIso(), safeStr(tradeId)).run();
  } catch (e) {
    console.log(`[sentinel] act_log append failed: ${e?.message || e}`);
  }
}

// ── The Discord kill (invalidation aftermath) ───────────────────────────
// Ends the DM row, voids every DM we can reach, and sends ONE death notice to
// the recipient (Keith: offerer gets nothing — they caused it). Quiet hours ⇒
// the notice defers to the hourly sweep via death_dm_pending. All Discord
// work is best-effort: the MFL revoke (done by the caller) is the integrity
// backstop; a failed edit costs cosmetics, not correctness.
export async function killDmSide(env, tradeId, { assetDesc, destTeamName, quietNow }) {
  const { openDmChannel, editMessage } = await import("./discord_round.js");
  const { dmAll } = await import("./trade_dm.js");
  const db = env.UPS_MFL_DB;
  const row = await db.prepare(`SELECT * FROM trade_offer_dm WHERE trade_id = ?`).bind(safeStr(tradeId)).first();
  if (!row) return { dm_row: false };
  await db.prepare(
    `UPDATE trade_offer_dm SET state='ended', resolved_reason='asset_moved', updated_at_utc=? WHERE trade_id=?`
  ).bind(nowIso(), safeStr(tradeId)).run();

  const voidLine = `❌ **VOID — this offer is no longer valid.** ${safeStr(assetDesc) || "An asset in it"} was traded${destTeamName ? ` to **${destTeamName}**` : " elsewhere"} before the offer was answered.`;

  // Edit every recorded DM: strip the buttons, say why. dm_message_ids is the
  // post-sentinel record; legacy rows fall back to bot_message_id + the first
  // recipient account's DM channel.
  const refs = [];
  for (const pair of safeStr(row.dm_message_ids).split(",").map((x) => safeStr(x)).filter(Boolean)) {
    const idx = pair.indexOf(":");
    if (idx > 0) refs.push({ chan: pair.slice(0, idx), msg: pair.slice(idx + 1) });
  }
  if (!refs.length && safeStr(row.bot_message_id)) {
    const firstUid = safeStr(row.recipient_discord_user_id).split(",")[0];
    const chan = firstUid ? await openDmChannel(env, digits(firstUid)) : "";
    if (chan) refs.push({ chan, msg: safeStr(row.bot_message_id) });
  }
  let edited = 0;
  for (const r of refs) {
    try {
      const er = await editMessage(env, r.chan, r.msg, { content: voidLine, components: [] });
      if (er.ok) edited++;
    } catch (e) {
      console.log(`[sentinel] DM edit failed ${r.chan}:${r.msg}: ${e?.message || e}`);
    }
  }

  // The death notice — recipient only.
  let noticed = false;
  const notice = `❌ **The trade offer from ${safeStr(row.from_franchise_name) || "the other team"} is void** — ${safeStr(assetDesc) || "an asset in it"} was traded${destTeamName ? ` to **${destTeamName}**` : " elsewhere"}. No action needed; the offer has been withdrawn and you won't get further reminders about it.`;
  if (quietNow) {
    await db.prepare(`UPDATE trade_offer_dm SET death_dm_pending=1, updated_at_utc=? WHERE trade_id=?`)
      .bind(nowIso(), safeStr(tradeId)).run();
  } else {
    const rr = await dmAll(env, row.recipient_discord_user_id, { content: notice });
    noticed = !!rr.sent;
  }
  return { dm_row: true, edited, noticed, deferred: !!quietNow };
}

// After a successful id swap (revoke + re-propose), rebind the DM row to the
// new MFL trade id IN PLACE: created_at (the cadence anchor), dm_count, track
// and think state all survive, so the recipient's nudge clock never notices —
// and enqueueTradeOfferDm is never called, so there is no Day-1 blast.
export async function swapDmTradeId(env, oldId, newId) {
  const db = env.UPS_MFL_DB;
  const r = await db.prepare(
    `UPDATE trade_offer_dm
        SET trade_id = ?, extended = 1, reoffer_pending = 0, updated_at_utc = ?
      WHERE trade_id = ?`
  ).bind(safeStr(newId), nowIso(), safeStr(oldId)).run();
  return { swapped: Number(r?.meta?.changes || 0) > 0 };
}
