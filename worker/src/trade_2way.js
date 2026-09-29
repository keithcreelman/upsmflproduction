// trade_2way.js — universal server-side STAGING for two-team ("2-way") War Room trades.
//
// Keith's ruling (2026-09-29, docs/LOADED_CONTRACT_DROP_EXECUTION_DESIGN.md §8): no 2-way
// trade this app creates may become a real, natively-acceptable MFL tradeProposal while it is
// still pending -- doing so lets either side accept it directly on MFL, bypassing every gate
// this app enforces (loaded-contract limit, cap, lineup), and a roster can change for reasons
// unrelated to this trade at any point between creation and whenever the recipient actually
// accepts. §8.1 worked through every narrower criterion (stage only if over the limit at
// creation, only if a loaded asset moves, only near the limit) and found none of them a
// GUARANTEE -- only staging every 2-way trade closes the gap, because the risk is a property
// of a roster's state at an unpredictable future moment MFL will act on without asking this
// app anything.
//
// This is a direct, deliberate mirror of worker/src/trade_3way.js, degenerated to exactly two
// parties and exactly one resulting MFL trade (no ring/pairwise decomposition needed -- a
// 2-way deal is already the base case that engine's hub/pairwise logic decomposes 3-way deals
// INTO). Every generic piece is reused, not reimplemented: the execution ledger
// (trade_execution.js), the cap-acknowledgment store (trade_cap_ack.js), the conditional-drop
// selection store (trade_conditional_drops.js), the loaded-contract permits-write gate
// (trade_cap_authority.js), and the commissioner-impersonation MFL writer itself
// (executeCommishTwoPartyTrade, exported from trade_3way.js -- it was already a pure 2-party
// primitive with zero 3-way-specific knowledge).
//
// SAFETY GATES (identical pattern to TRADE_3WAY_ENABLED/TRADE_3WAY_EXECUTE):
//   TRADE_2WAY_STAGING_ENABLED = "1"  -> feature on (creation stages in D1 instead of
//                                       whatever the caller does when it's off). Else this
//                                       module refuses every call; existing direct-to-MFL
//                                       2-way behavior (worker/src/index.js's /trade-offers)
//                                       is completely untouched by this file either way.
//   TRADE_2WAY_STAGING_EXECUTE = "1" -> LIVE MFL writes once a staged trade clears every
//                                       gate. Else DRY-RUN (logs + DMs "would execute" but
//                                       moves no rosters) -- the safe default, so the whole
//                                       staging flow (create, accept, compliance recheck,
//                                       conditional-drop selection) is fully testable with
//                                       zero real MFL writes possible even by accident.
//   Both default OFF (getFeatureFlag fails closed on any unreadable override).
//
// needs_drops NEVER permits a write here either way -- capGate2Way calls the SAME
// loadedContractsPermitsWrite() gate trade_3way.js's capGate already uses, unchanged.

import { dmAll, resolveDiscordUserIds } from "./trade_dm.js";
import { getFeatureFlag } from "./feature_flags.js";
import { EXEC, makeLedger } from "./trade_execution.js";
import { evaluateCapAcknowledgment } from "./trade_cap_ack.js";
import { makeConditionalDropStore } from "./trade_conditional_drops.js";
import { loadedContractsPermitsWrite } from "./trade_cap_authority.js";
import {
  executeCommishTwoPartyTrade, movementsForCompliance, injectCapTokens,
  fetchRosterSalaryMap, movementCapMaxK, unavailableCompliance, ledgerFor, capAckStoreFor,
} from "./trade_3way.js";

const safeStr = (v) => String(v == null ? "" : v).trim();
const safeInt = (v, fb) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : (fb == null ? 0 : fb); };
const padFid = (v) => { const s = safeStr(v).replace(/\D/g, ""); return s ? s.padStart(4, "0") : ""; };
const digits = (v) => safeStr(v).replace(/\D/g, "");
const nowIso = () => new Date().toISOString();
const newId = () => { try { return crypto.randomUUID(); } catch (_) { return "2w-" + digits(nowIso()) + "-" + digits(safeStr(Math.floor(Date.now() % 1e9))); } };

async function enabled(env) { return await getFeatureFlag(env, "TRADE_2WAY_STAGING_ENABLED"); }
async function liveExecute(env) { return await getFeatureFlag(env, "TRADE_2WAY_STAGING_EXECUTE"); }
function allowlist(env) { return safeStr(env.TRADE_2WAY_STAGING_TEST_FRANCHISES).split(",").map(padFid).filter(Boolean); }
function franchiseAllowed(env, fid) { const a = allowlist(env); return a.length === 0 || a.includes(padFid(fid)); }

const lkey = (row) => ({ leagueId: safeStr(row.league_id), season: safeStr(row.season), execKey: safeStr(row.id) });
const capAckKey = (row) => ({ leagueId: safeStr(row.league_id), season: safeStr(row.season), tradeKey: safeStr(row.id) });
const conditionalDropKey = (row) => ({ leagueId: safeStr(row.league_id), season: safeStr(row.season), tradeKey: safeStr(row.id) });
const signatureOf = (gate) => `${gate.kind}|${safeStr(gate.message)}`;

function parseMovements(row) {
  try { const v = JSON.parse(row.movements_json || "[]"); return Array.isArray(v) ? v.filter((m) => m && Array.isArray(m.asset_tokens) && m.asset_tokens.length) : []; }
  catch (_) { return []; }
}
function parseExtReqs(row) {
  try { const v = JSON.parse(row.extension_requests_json || "[]"); return Array.isArray(v) ? v : []; }
  catch (_) { return []; }
}

// The SAME self-call pattern trade_3way.js's complianceViaSelf uses, reusing the identical
// /admin/3way/compliance route -- it is already fully generic (league_id/season/movements/
// extension_requests/conditional_drops in, {cap, roster, loaded_contracts, lineup,
// extension_skipped} out), nothing 3-way-specific about its body. A staged 2-way trade needs
// no new admin route for this.
async function complianceViaSelf2Way(env, row) {
  if (!env.SELF) return unavailableCompliance("no_self_binding");
  const apiKey = safeStr(env.COMMISH_API_KEY);
  if (!apiKey) return unavailableCompliance("no_commish_key");
  try {
    const movements = parseMovements(row).map((m) => ({ from: padFid(m.from), to: padFid(m.to), tokens: injectCapTokens([m])[0].asset_tokens }));
    let conditionalDrops = {};
    try { conditionalDrops = await makeConditionalDropStore(ledgerDbFor(env)).readAllForTrade(conditionalDropKey(row)); } catch (_) { conditionalDrops = {}; }
    const u = `https://self.invalid/admin/3way/compliance?L=${encodeURIComponent(safeStr(row.league_id))}&YEAR=${encodeURIComponent(safeStr(row.season))}&APIKEY=${encodeURIComponent(apiKey)}`;
    const r = await env.SELF.fetch(u, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ league_id: safeStr(row.league_id), season: safeStr(row.season), movements, extension_requests: parseExtReqs(row), offer_created_at_utc: safeStr(row.created_at_utc), conditional_drops: conditionalDrops }),
    });
    const j = await r.json().catch(() => null);
    const c = j && j.ok && j.compliance;
    if (!r.ok || !c || !c.cap || !c.roster || !c.loaded_contracts) return unavailableCompliance("bad_response");
    return c;
  } catch (e) {
    console.error(`[2way-staged] ${row.id}: compliance call failed: ${e?.message || e}`);
    return unavailableCompliance("call_failed");
  }
}

function ledgerDbFor(env) {
  const db = env.TWB_OUTBOX_DB || env.TWB_DB || env.DB || env.UPS_MFL_DB;
  if (!db) throw new Error("no D1 binding");
  return db;
}

function inScope(row, viewer) {
  if (!viewer) return false;
  return safeStr(row.league_id) === safeStr(viewer.leagueId) && safeStr(row.season) === safeStr(viewer.season);
}
function canView2Way(row, viewer) {
  if (!inScope(row, viewer)) return false;
  const myFid = padFid(viewer && viewer.fid);
  return !!(viewer.isCommish || myFid === padFid(row.from_fid) || myFid === padFid(row.to_fid));
}

// ─────────────────────────────────── capGate2Way ───────────────────────────────────
// Direct mirror of trade_3way.js's capGate(), for the 2-party row shape. Same priority
// order: unavailable data -> fail closed; stale/ineligible extension -> refuse; the
// loaded-contract limit (via loadedContractsPermitsWrite -- covers BOTH "blocked" and
// "needs_drops" identically, since a satisfied drop selection is not the same thing as an
// executed drop, and no executor exists yet) -> hold; a proven cap overage -> require each
// affected franchise's own acknowledgment.
async function capGate2Way(env, row) {
  const compliance = await complianceViaSelf2Way(env, row);
  if (compliance.cap.status === "unavailable") return { ok: false, kind: "unavailable", message: "We couldn't verify the salary cap for this trade right now. Try again in a moment.", compliance };
  if (compliance.loaded_contracts && compliance.loaded_contracts.status === "unavailable") return { ok: false, kind: "unavailable", message: "We couldn't verify the loaded-contract count for this trade right now. Try again in a moment.", compliance };
  const skipped = Array.isArray(compliance.extension_skipped) ? compliance.extension_skipped : [];
  if (skipped.length) {
    const reasons = skipped.map((x) => safeStr(x && x.reason));
    const unavailableReason = (r) => r === "extension_pricing_unavailable" || r === "failed_to_load_salaries_export" || r.startsWith("authority_unavailable");
    if (reasons.includes("extension_terms_stale")) return { ok: false, kind: "extension_stale", message: "The price of a pre-trade extension in this trade no longer matches the player's current contract, so it can't go through as built. Ask the initiator to build it again.", compliance };
    if (reasons.every(unavailableReason)) return { ok: false, kind: "unavailable", message: "We couldn't verify a pre-trade extension in this trade right now. Try again in a moment.", compliance };
    return { ok: false, kind: "extension", message: "A pre-trade extension in this trade is no longer allowed, so it can't go through. Ask the initiator to build it again.", compliance };
  }
  if (compliance.loaded_contracts && !loadedContractsPermitsWrite(compliance.loaded_contracts.status)) {
    const waiting = (compliance.loaded_contracts.drop_requirements || []).filter((d) => !d.satisfied).map((d) => d.franchise_name || d.franchise_id).join(", ");
    const heldMsg = compliance.loaded_contracts.status === "needs_drops"
      ? `${safeStr(compliance.loaded_contracts.message)} Conditional-drop execution isn't built yet, so this trade stays held until it is.`
      : `${safeStr(compliance.loaded_contracts.message)}${waiting ? ` Waiting on ${waiting} to select conditional drops.` : ""}`;
    return { ok: false, kind: "loaded_contract_drops_required", message: heldMsg, compliance, drop_requirements: compliance.loaded_contracts.drop_requirements || [] };
  }
  if (compliance.cap.status === "blocked") {
    const acks = await capAckStoreFor(env).readAllForTrade(capAckKey(row));
    const ackEval = evaluateCapAcknowledgment({ violations: compliance.cap.violations, tradeKey: safeStr(row.id), acks });
    if (!ackEval.satisfied) {
      const waiting = ackEval.perFranchise.filter((f) => f.status !== "acknowledged").map((f) => f.franchise_name || f.franchise_id).join(", ");
      return { ok: false, kind: "cap_ack_required", message: `${safeStr(compliance.cap.message)} Waiting on ${waiting} to acknowledge.`, compliance, cap_ack: ackEval.perFranchise };
    }
  }
  return { ok: true, compliance };
}

async function enterBlockedCap2Way(env, row, gate, dmBoth) {
  const violations = gate.kind === "loaded_contract_drops_required"
    ? ((gate.compliance && gate.compliance.loaded_contracts && gate.compliance.loaded_contracts.violations) || []).map((v) => ({ franchise_id: v.franchise_id, franchise_name: v.franchise_name, projected: v.projected, max: v.max, required_drops: v.required_drops, valid_drops: v.valid_drops }))
    : ((gate.compliance && gate.compliance.cap && gate.compliance.cap.violations) || []).map((v) => ({ franchise_id: v.franchise_id, franchise_name: v.franchise_name, amount_over: v.amount_over }));
  const info = { kind: gate.kind, message: safeStr(gate.message), violations, checked_at_utc: nowIso(), signature: signatureOf(gate) };
  let prev = null;
  try {
    const r = await ledgerFor(env).block(lkey(row), { kind: "two_way_staged", actorFid: padFid(row.from_fid), participants: [row.from_fid, row.to_fid].map(padFid).join(","), blockInfo: info });
    prev = r.prev;
  } catch (e) { console.error(`[2way-staged] ${row.id}: couldn't record the cap block on the ledger: ${e?.message || e}`); }
  await ledgerDbFor(env).prepare(`UPDATE ups_2way_trades SET status='collecting', failure_reason=NULL, updated_at_utc=? WHERE id=? AND status='executing'`).bind(nowIso(), row.id).run();
  const same = prev && prev.state === EXEC.BLOCKED_CAP && prev.block && prev.block.signature === info.signature;
  if (!same && dmBoth) {
    await dmBoth(String(gate.kind).startsWith("extension")
      ? `⏸️ This 2-way trade is accepted by both sides, but it can't run: ${gate.message} Nothing has moved. **Commish:** this needs to be cancelled and rebuilt.`
      : gate.kind === "cap_ack_required"
      ? `⏸️ This 2-way trade is accepted by both sides, but it can't run yet: ${gate.message} Nothing has moved. The affected owner needs to acknowledge this on the trade page, then use "Re-check."`
      : gate.kind === "loaded_contract_drops_required"
      ? `⏸️ This 2-way trade is accepted by both sides, but it can't run yet: ${gate.message} Nothing has moved. The affected owner needs to select their conditional drops on the trade page, then use "Re-check."`
      : `⏸️ This 2-way trade is accepted by both sides, but it can't run yet: ${gate.message} Nothing has moved and both accepts are saved. It will go through once that's fixed (use "Re-check" on the trade).`);
  }
  return info;
}

async function getRow(env, id) {
  try { return await ledgerDbFor(env).prepare(`SELECT * FROM ups_2way_trades WHERE id=?`).bind(safeStr(id)).first(); }
  catch (e) { console.error(`[2way-staged] getRow failed: ${e?.message || e}`); return null; }
}
async function getRowStrict(env, id) {
  return await ledgerDbFor(env).prepare(`SELECT * FROM ups_2way_trades WHERE id=?`).bind(safeStr(id)).first();
}
const dbDown = (e) => { console.error(`[2way-staged] db error: ${e?.message || e}`); return { ok: false, http: 503, code: "unavailable", message: "Trades are temporarily unavailable. Try again in a moment." }; };
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// ═══════════════════════════════════ CREATE ═══════════════════════════════════
//
// Writes ONLY to D1. There is no fetch() to myfantasyleague.com anywhere in this
// function's call graph -- no native MFL tradeProposal is ever created here, by design
// (that is the entire point of staging, §8 of the design doc).
export async function createStaged2WayTrade(env, ctx, spec) {
  try {
    if (!(await enabled(env))) return { ok: false, error: "2way_staging_disabled" };
    if (!env.UPS_MFL_DB) return { ok: false, error: "no_db" };
    const leagueId = safeStr(spec?.leagueId), season = safeStr(spec?.season);
    const from = padFid(spec?.from?.fid), to = padFid(spec?.to?.fid);
    if (!leagueId || !season || !from || !to) return { ok: false, error: "missing_fields" };
    if (from === to) return { ok: false, error: "teams_must_be_distinct" };
    const movements = Array.isArray(spec?.movements) ? spec.movements : [];
    if (!movements.length) return { ok: false, error: "no_movements" };
    const fidSet = new Set([from, to]);
    for (const m of movements) {
      const mf = padFid(m?.from), mt = padFid(m?.to);
      if (!fidSet.has(mf) || !fidSet.has(mt) || mf === mt) return { ok: false, error: "bad_movement" };
    }
    if (!movements.some((m) => Array.isArray(m?.asset_tokens) && m.asset_tokens.length)) return { ok: false, error: "no_assets" };
    // §A6 cap-money 50% backstop -- identical check to create3WayTrade's.
    for (const m of movements) m.cap_k = Math.max(0, safeInt(m?.cap_k, 0));
    if (movements.some((m) => m.cap_k > 0)) {
      const sm = await fetchRosterSalaryMap(env, leagueId, season);
      if (sm.ok) {
        for (const m of movements) {
          if (m.cap_k <= 0) continue;
          const maxK = movementCapMaxK(m, sm.salaryByFp, sm.taxiByFp);
          if (m.cap_k > maxK) return { ok: false, code: "TRADE_CAP_MONEY_50PCT", error: `cap money ${m.cap_k}K from ${padFid(m.from)}→${padFid(m.to)} exceeds the §A6 max (${maxK}K = 50% of the non-taxi salary sent).` };
        }
      } else {
        console.warn(`[2way-staged] §A6 cap check skipped (rosters fetch failed): ${sm.error}`);
      }
    }
    const notes = safeStr(spec?.notes).slice(0, 500);
    const extReqs = (Array.isArray(spec?.extension_requests) ? spec.extension_requests : [])
      .filter((e) => e && safeStr(e.player_id) && safeStr(e.preview_contract_info_string) && fidSet.has(padFid(e.from_franchise_id)) && fidSet.has(padFid(e.to_franchise_id)))
      .map((e) => ({
        player_id: safeStr(e.player_id), player_name: safeStr(e.player_name),
        from_franchise_id: padFid(e.from_franchise_id), to_franchise_id: padFid(e.to_franchise_id),
        applies_to_acquirer: true,
        option_key: safeStr(e.option_key), extension_term: safeStr(e.extension_term),
        loaded_indicator: safeStr(e.loaded_indicator) || "NONE", preview_id: e.preview_id || null,
        preview_contract_info_string: safeStr(e.preview_contract_info_string),
        new_contract_status: safeStr(e.new_contract_status),
        new_contract_length: e.new_contract_length != null ? safeInt(e.new_contract_length, 0) : null,
        new_TCV: e.new_TCV != null ? safeInt(e.new_TCV, 0) : null,
        new_aav_future: e.new_aav_future != null ? safeInt(e.new_aav_future, 0) : null,
      }));
    if (![from, to].every((f) => franchiseAllowed(env, f))) return { ok: false, error: "not_in_allowlist" };

    // A satisfied conditional-drop selection made by the SENDER at create time (mirrors the
    // existing direct-MFL create route's own CREATE-time loaded-contract gate) is persisted
    // here too, informational -- it NEVER unlocks creation of a native MFL trade (there is
    // none to unlock: staging means this offer never reaches MFL until BOTH sides' gates
    // clear, checked again at accept and at execute).
    const senderDrops = Array.isArray(spec?.loaded_contract_drops) ? spec.loaded_contract_drops.map(safeStr).filter(Boolean) : [];

    const [fromIds, toIds] = await Promise.all([resolveDiscordUserIds(env, from), resolveDiscordUserIds(env, to)]);
    const id = newId();
    await env.UPS_MFL_DB.prepare(
      `INSERT INTO ups_2way_trades
        (id, league_id, season, status, from_fid, to_fid, from_name, to_name,
         movements_json, notes, extension_requests_json, to_state,
         from_discord_ids, to_discord_ids, created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, 'collecting', ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
    ).bind(id, leagueId, season, from, to,
      safeStr(spec?.from?.name), safeStr(spec?.to?.name), JSON.stringify(movements), notes, JSON.stringify(extReqs),
      fromIds.join(","), toIds.join(","), nowIso(), nowIso()).run();

    if (senderDrops.length) {
      try { await makeConditionalDropStore(ledgerDbFor(env)).setForFranchise({ leagueId, season, tradeKey: id }, { franchiseId: from, playerIds: senderDrops, selectedByFid: from }); }
      catch (e) { console.error(`[2way-staged] ${id}: couldn't persist the sender's conditional-drop selection (non-fatal, the offer is still staged): ${e?.message || e}`); }
    }

    const row = await getRow(env, id);
    const dm = async () => { const r = await dmAll(env, toIds.join(","), { content: `📬 New War Room offer from ${safeStr(spec?.from?.name) || from} — held server-side for review, not yet a native MFL trade. Open the Trade War Room to respond.` }); console.log(`[2way-staged] invite DM to ${to}: ${r.sent} account(s) (trade ${id})`); };
    if (ctx?.waitUntil) ctx.waitUntil(dm()); else await dm();
    console.log(`[2way-staged] created ${id}: ${from} -> ${to} · ${movements.length} movement(s) · staged, no native MFL proposal`);
    return { ok: true, id };
  } catch (e) {
    console.error(`[2way-staged] create failed: ${e?.message || e}`);
    return { ok: false, error: e?.message || String(e) };
  }
}

// ═══════════════════════════════════ READ ═══════════════════════════════════
async function enrich(deps, rows) {
  let names = null, players = null;
  if (!deps || !rows.length) return { names, players };
  const leagueId = safeStr(rows[0].league_id), season = safeStr(rows[0].season);
  try { if (deps.franchiseNames) names = await deps.franchiseNames({ leagueId, season }); }
  catch (e) { console.warn(`[2way-staged] franchise name lookup failed (using stored names): ${e?.message || e}`); }
  try {
    if (deps.playersByIds) {
      const ids = new Set();
      for (const r of rows) for (const m of parseMovements(r)) for (const t of (m && m.asset_tokens) || []) { const x = /^P_(\d+)$/.exec(safeStr(t)); if (x) ids.add(x[1]); }
      if (ids.size) players = await deps.playersByIds({ leagueId, season, ids: [...ids] });
    }
  } catch (e) { console.warn(`[2way-staged] player lookup failed (labels fall back to ids): ${e?.message || e}`); }
  return { names, players };
}

export async function get2WayTrade(env, id, viewer, deps) {
  if (!env.UPS_MFL_DB) return dbDown(new Error("no_db"));
  const tid = safeStr(id);
  if (!ID_RE.test(tid)) return { ok: false, http: 400, code: "bad_request", message: "That isn't a valid trade id." };
  let row; try { row = await getRowStrict(env, tid); } catch (e) { return dbDown(e); }
  if (!row || !inScope(row, viewer)) return { ok: false, http: 404, code: "not_found", message: "This trade doesn't exist." };
  if (!canView2Way(row, viewer)) return { ok: false, http: 403, code: "forbidden", message: "You aren't part of this trade." };
  let compliance = null;
  if (row.status === "collecting" || row.status === "executing") compliance = await complianceViaSelf2Way(env, row);
  const { names, players } = await enrich(deps, [row]);
  return { ok: true, trade: buildCanonical2Way(row, viewer, { names, players, compliance }) };
}

export async function list2WayForFranchise(env, leagueId, fid, opts) {
  if (!env.UPS_MFL_DB) return dbDown(new Error("no_db"));
  const f = padFid(fid);
  if (!f) return { ok: false, http: 400, code: "bad_request", message: "Missing franchise id." };
  const includeAll = !!(opts && opts.includeAll);
  try {
    const sql = includeAll
      ? `SELECT * FROM ups_2way_trades WHERE league_id=? AND season=? AND (from_fid=? OR to_fid=?) ORDER BY created_at_utc DESC LIMIT 25`
      : `SELECT * FROM ups_2way_trades WHERE league_id=? AND season=? AND status IN ('collecting','executing') AND (from_fid=? OR to_fid=?) ORDER BY created_at_utc DESC LIMIT 25`;
    const { results } = await env.UPS_MFL_DB.prepare(sql).bind(safeStr(leagueId), safeStr(opts && opts.season), f, f).all();
    const rows = results || [];
    const { names, players } = await enrich(opts && opts.deps, rows);
    return { ok: true, trades: rows.map((r) => buildCanonical2Way(r, { leagueId: safeStr(leagueId), season: safeStr(opts && opts.season), fid: f }, { names, players })) };
  } catch (e) { return dbDown(e); }
}

// ═══════════════════════════════════ COMMISSIONER QUEUE (read-only) ═══════════════════════════════════
// League-wide, not scoped to one franchise's own trades. READ-ONLY by construction: this
// function never writes anything (no D1 write, no MFL call of any kind, no ledger transition,
// no cap-ack write, no conditional-drop write) -- it only READS the same fresh compliance
// (complianceViaSelf2Way -- the exact same self-call every gate uses, never a cached or looser
// figure), the same cap-acknowledgment store, and the same execution ledger every enforcement
// point already reads. There is deliberately no "execute" or "drop" action anywhere in this
// module's commissioner-facing surface -- Keith's ruling (2026-09-29): the review queue is a
// hold-and-inspect surface for now, not an execution console.
//
// Per trade this returns everything a commissioner needs to judge a hold without guessing:
//   - the canonical trade (participants, movements, state_view — same shape owners see)
//   - compliance: freshly recomputed right now (cap/roster/loaded_contracts/lineup), including
//     loaded_contracts.drop_requirements[].selected -- each affected owner's OWN current
//     conditional-drop picks, already player-id-scoped to THEIR OWN roster by
//     evaluateTradeCompliance (a sender can never populate a recipient's selected list; the
//     compliance calculation itself only ever reads a franchise's own stored selection under
//     its own franchise_id key)
//   - cap_ack: each affected franchise's acknowledgment status against the LIVE cap violation
//     (not a stale one -- evaluateCapAcknowledgment re-signs against compliance.cap.violations
//     fetched in this same call)
//   - ledger: the real ups_trade_executions row for this trade (state, failed_step,
//     failure_detail, block reason, timestamps) -- "the real ledger state" Keith asked for,
//     not a re-derivation of it from the trade row's own status column
//   - age: hours since created, hours since last updated -- for spotting a hold that's gone
//     stale
export async function listCommish2WayQueue(env, leagueId, season, opts) {
  if (!env.UPS_MFL_DB) return dbDown(new Error("no_db"));
  const includeAll = !!(opts && opts.includeAll);
  let rows;
  try {
    const sql = includeAll
      ? `SELECT * FROM ups_2way_trades WHERE league_id=? AND season=? ORDER BY updated_at_utc DESC LIMIT 100`
      : `SELECT * FROM ups_2way_trades WHERE league_id=? AND season=? AND status IN ('collecting','executing','failed') ORDER BY updated_at_utc DESC LIMIT 100`;
    const res = await env.UPS_MFL_DB.prepare(sql).bind(safeStr(leagueId), safeStr(season)).all();
    rows = res.results || [];
  } catch (e) { return dbDown(e); }
  const { names, players } = await enrich(opts && opts.deps, rows);
  const nowMs = Date.now();
  const ageHours = (iso) => { const t = Date.parse(safeStr(iso)); return Number.isFinite(t) ? Math.round(((nowMs - t) / 36e5) * 10) / 10 : null; };
  const trades = [];
  for (const row of rows) {
    const viewer = { fid: "0000", leagueId: safeStr(row.league_id), season: safeStr(row.season), isCommish: true };
    const canonical = buildCanonical2Way(row, viewer, { names, players });
    let compliance = null, capAck = null, ledger = null;
    if (row.status === "collecting" || row.status === "executing" || row.status === "failed") {
      compliance = await complianceViaSelf2Way(env, row);
      if (compliance && compliance.cap && Array.isArray(compliance.cap.violations) && compliance.cap.violations.length) {
        try {
          const acks = await capAckStoreFor(env).readAllForTrade(capAckKey(row));
          capAck = evaluateCapAcknowledgment({ violations: compliance.cap.violations, tradeKey: safeStr(row.id), acks });
        } catch (e) { console.warn(`[2way-staged] commish queue: cap-ack read failed for ${row.id}: ${e?.message || e}`); }
      }
    }
    try { ledger = await makeLedger(ledgerDbFor(env)).read(lkey(row)); } catch (e) { console.warn(`[2way-staged] commish queue: ledger read failed for ${row.id}: ${e?.message || e}`); }
    trades.push({
      ...canonical,
      compliance,
      cap_ack: capAck,
      ledger,
      age_hours_since_created: ageHours(row.created_at_utc),
      age_hours_since_updated: ageHours(row.updated_at_utc),
    });
  }
  return { ok: true, league_id: safeStr(leagueId), season: safeStr(season), trades };
}

// Minimal canonical shape -- mirrors trade_3way_model.js's buildCanonical3Way's spirit
// (per-viewer permissions + a plain-English state_view), scoped down to what a 2-way trade
// actually needs. Kept in this file rather than a new trade_2way_model.js given the current
// scope; split out if this grows.
function buildCanonical2Way(row, viewer, extra) {
  const myFid = padFid(viewer && viewer.fid);
  const isFrom = myFid === padFid(row.from_fid), isTo = myFid === padFid(row.to_fid);
  const compliance = extra && extra.compliance;
  let stateCode = row.status, stateLabel = row.status, stateMessage = "";
  if (row.status === "collecting") {
    if (row.to_state === "declined") { stateCode = "declined"; stateLabel = "Declined"; }
    else if (row.to_state === "accepted") { stateCode = "awaiting_review"; stateLabel = "Accepted — awaiting compliance review"; stateMessage = "Both sides have agreed. This stays held, server-side, until it clears the loaded-contract, cap, and lineup checks — never a native MFL trade until then."; }
    else { stateCode = "pending_response"; stateLabel = "Awaiting response"; }
  } else if (row.status === "executing") { stateCode = "executing"; stateLabel = "Clearing final checks"; }
  else if (row.status === "completed") { stateCode = "completed"; stateLabel = "Completed"; }
  else if (row.status === "failed") { stateCode = "failed"; stateLabel = "Needs commissioner review"; stateMessage = safeStr(row.failure_reason); }
  else if (row.status === "cancelled") { stateCode = "cancelled"; stateLabel = "Cancelled"; }
  return {
    id: row.id, league_id: row.league_id, season: row.season, status: row.status,
    from_fid: padFid(row.from_fid), to_fid: padFid(row.to_fid),
    from_name: (extra && extra.names && extra.names[padFid(row.from_fid)]) || row.from_name,
    to_name: (extra && extra.names && extra.names[padFid(row.to_fid)]) || row.to_name,
    to_state: row.to_state,
    movements: parseMovements(row),
    notes: safeStr(row.notes),
    mfl_trade_id: row.mfl_trade_id || null,
    created_at_utc: row.created_at_utc, updated_at_utc: row.updated_at_utc, executed_at_utc: row.executed_at_utc,
    permissions: { can_view: canView2Way(row, viewer), can_accept: isTo && row.status === "collecting" && row.to_state === "pending", can_cancel: (isFrom || isTo || !!(viewer && viewer.isCommish)) && (row.status === "collecting" || row.status === "executing"), can_recheck: row.status === "failed" },
    state_view: { code: stateCode, label: stateLabel, message: stateMessage },
    compliance: compliance || null,
  };
}

// ═══════════════════════════════════ CANCEL ═══════════════════════════════════
export async function cancel2WayTrade(env, ctx, id, viewer, reason) {
  if (!env.UPS_MFL_DB) return dbDown(new Error("no_db"));
  const tid = safeStr(id);
  if (!ID_RE.test(tid)) return { ok: false, http: 400, code: "bad_request", message: "That isn't a valid trade id." };
  let row; try { row = await getRowStrict(env, tid); } catch (e) { return dbDown(e); }
  if (!row || !inScope(row, viewer)) return { ok: false, http: 404, code: "not_found", message: "This trade doesn't exist." };
  const myFid = padFid(viewer && viewer.fid);
  const isParty = myFid === padFid(row.from_fid) || myFid === padFid(row.to_fid);
  if (!isParty && !(viewer && viewer.isCommish)) return { ok: false, http: 403, code: "forbidden", message: "You aren't part of this trade." };
  if (row.status !== "collecting" && row.status !== "executing") return { ok: false, http: 409, code: "not_cancellable", message: "This trade is no longer open." };
  const basis = (viewer && viewer.isCommish && !isParty) ? "commissioner" : "party";
  const { success } = await env.UPS_MFL_DB.prepare(`UPDATE ups_2way_trades SET status='cancelled', cancel_basis=?, cancelled_by=?, cancel_reason=?, cancelled_at_utc=?, updated_at_utc=? WHERE id=? AND status IN ('collecting','executing')`).bind(basis, myFid, safeStr(reason).slice(0, 500), nowIso(), nowIso(), tid).run();
  if (!success) return { ok: false, http: 409, code: "race", message: "This trade just changed state — refresh and try again." };
  console.log(`[2way-staged] ${tid} cancelled by ${myFid} (${basis})`);
  return { ok: true };
}

// ═══════════════════════════════════ ACCEPT ═══════════════════════════════════
// HTTP-driven (a proven owner session, not a Discord button -- the recipient of a 2-way
// trade is a real logged-in owner at accept time, exactly like the existing direct-MFL
// accept route). Re-checks compliance for BOTH sides via capGate2Way -- never only the
// recipient's own requirement -- before recording the accept as anything more than "this
// side agreed."
export async function accept2WayTrade(env, ctx, id, viewer, body) {
  if (!env.UPS_MFL_DB) return dbDown(new Error("no_db"));
  const tid = safeStr(id);
  if (!ID_RE.test(tid)) return { ok: false, http: 400, code: "bad_request", message: "That isn't a valid trade id." };
  let row; try { row = await getRowStrict(env, tid); } catch (e) { return dbDown(e); }
  if (!row || !inScope(row, viewer)) return { ok: false, http: 404, code: "not_found", message: "This trade doesn't exist." };
  const myFid = padFid(viewer && viewer.fid);
  if (myFid !== padFid(row.to_fid)) return { ok: false, http: 403, code: "forbidden", message: "Only the recipient can accept this trade." };
  if (row.status !== "collecting") return { ok: false, http: 409, code: "not_open", message: "This trade is no longer open." };
  if (row.to_state !== "pending") return { ok: false, http: 409, code: "already_responded", message: "You've already responded to this trade." };

  // The recipient may supply their OWN conditional-drop selection inline, in this same
  // request -- the fresh recompute inside capGate2Way IS the validation, so there is
  // nothing to forge (mirrors the existing direct-MFL accept route's identical pattern).
  const recipientDrops = Array.isArray(body?.loaded_contract_drops) ? body.loaded_contract_drops.map(safeStr).filter(Boolean) : null;
  if (recipientDrops) {
    try { await makeConditionalDropStore(ledgerDbFor(env)).setForFranchise(conditionalDropKey(row), { franchiseId: myFid, playerIds: recipientDrops, selectedByFid: myFid }); }
    catch (e) { return { ok: false, http: 503, code: "loaded_contract_drops_unavailable", message: "Couldn't save your conditional-drop selection right now, so the accept wasn't recorded. Try again in a moment." }; }
  }

  const { success } = await env.UPS_MFL_DB.prepare(`UPDATE ups_2way_trades SET to_state='accepted', updated_at_utc=? WHERE id=? AND status='collecting' AND to_state='pending'`).bind(nowIso(), tid).run();
  if (!success) return { ok: false, http: 409, code: "race", message: "This trade just changed state — refresh and try again." };

  // Re-run the SAME gate the eventual execute() will run again -- reported to the accepting
  // owner immediately, but the accept itself is preserved regardless of the outcome (what
  // the gate blocks is EXECUTION, never a party's own consent -- mirrors 3-way's identical
  // "an accept is recorded regardless of gate outcome" rule).
  const freshRow = await getRow(env, tid);
  const gate = await capGate2Way(env, freshRow);
  if (!gate.ok) {
    console.log(`[2way-staged] ${tid}: both sides now agreed, but held (${gate.kind}): ${gate.message}`);
    return { ok: true, accepted: true, executing: false, held: true, kind: gate.kind, message: gate.message, compliance: gate.compliance };
  }

  const { success: movedToExecuting } = await env.UPS_MFL_DB.prepare(`UPDATE ups_2way_trades SET status='executing', updated_at_utc=? WHERE id=? AND status='collecting'`).bind(nowIso(), tid).run();
  if (!movedToExecuting) return { ok: true, accepted: true, executing: false, held: false };
  const run = () => execute2Way(env, tid);
  if (ctx?.waitUntil) ctx.waitUntil(run()); else await run();
  return { ok: true, accepted: true, executing: true };
}

// ═══════════════════════ conditional-drop selection (re-check, never a write) ═══════════════════════
export async function select2WayLoadedContractDrops(env, id, viewer, playerIds) {
  if (!env.UPS_MFL_DB) return dbDown(new Error("no_db"));
  const tid = safeStr(id);
  if (!ID_RE.test(tid)) return { ok: false, http: 400, code: "bad_request", message: "That isn't a valid trade id." };
  let row; try { row = await getRowStrict(env, tid); } catch (e) { return dbDown(e); }
  if (!row || !inScope(row, viewer)) return { ok: false, http: 404, code: "not_found", message: "This trade doesn't exist." };
  if (!canView2Way(row, viewer)) return { ok: false, http: 403, code: "forbidden", message: "You aren't part of this trade." };
  const myFid = padFid(viewer && viewer.fid);
  if (myFid !== padFid(row.from_fid) && myFid !== padFid(row.to_fid)) return { ok: false, http: 403, code: "forbidden", message: "You aren't part of this trade." };
  const selectedIds = (Array.isArray(playerIds) ? playerIds : []).map(safeStr).filter(Boolean);
  const priorDrops = await makeConditionalDropStore(ledgerDbFor(env)).readAllForTrade(conditionalDropKey(row));
  const movements = parseMovements(row).map((m) => ({ from: padFid(m.from), to: padFid(m.to), tokens: injectCapTokens([m])[0].asset_tokens }));
  const apiKey = safeStr(env.COMMISH_API_KEY);
  let compliance;
  if (!env.SELF || !apiKey) { compliance = unavailableCompliance(!env.SELF ? "no_self_binding" : "no_commish_key"); }
  else {
    try {
      const u = `https://self.invalid/admin/3way/compliance?L=${encodeURIComponent(safeStr(row.league_id))}&YEAR=${encodeURIComponent(safeStr(row.season))}&APIKEY=${encodeURIComponent(apiKey)}`;
      const r = await env.SELF.fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ league_id: safeStr(row.league_id), season: safeStr(row.season), movements, extension_requests: parseExtReqs(row), offer_created_at_utc: safeStr(row.created_at_utc), conditional_drops: { ...priorDrops, [myFid]: selectedIds } }) });
      const j = await r.json().catch(() => null);
      const c = j && j.ok && j.compliance;
      compliance = (!r.ok || !c || !c.loaded_contracts) ? unavailableCompliance("bad_response") : c;
    } catch (e) { console.error(`[2way-staged] ${row.id}: compliance call failed: ${e?.message || e}`); compliance = unavailableCompliance("call_failed"); }
  }
  if (compliance.loaded_contracts.status === "unavailable") return { ok: false, http: 503, code: "loaded_contract_check_unavailable", message: "We couldn't verify the loaded-contract count for this trade right now, so nothing was selected. Try again in a moment.", compliance };
  const myReq = (compliance.loaded_contracts.drop_requirements || []).find((d) => safeStr(d.franchise_id) === myFid);
  if (!myReq) return { ok: true, http: 200, code: "nothing_required", message: "Your team isn't projected to need a conditional drop on this trade right now.", compliance };
  await makeConditionalDropStore(ledgerDbFor(env)).setForFranchise(conditionalDropKey(row), { franchiseId: myFid, playerIds: selectedIds, selectedByFid: myFid });
  const executable = loadedContractsPermitsWrite(compliance.loaded_contracts.status);
  return {
    ok: true, http: 200, code: myReq.satisfied ? "selected" : "selected_insufficient",
    message: myReq.satisfied
      ? `Selected: ${myReq.valid_count} of ${myReq.required_drops} required conditional drop${myReq.required_drops === 1 ? "" : "s"}. This trade is staged, awaiting commissioner review${executable ? "" : " — conditional-drop execution isn't built yet, so it stays held until it is"}.`
      : `${myReq.valid_count} of ${myReq.required_drops} required conditional drops are valid so far -- ${myReq.required_drops - myReq.valid_count} more needed.`,
    compliance, drop_requirement: myReq, executable,
  };
}

export async function recheck2WayExecution(env, ctx, id, viewer) {
  if (!env.UPS_MFL_DB) return dbDown(new Error("no_db"));
  const tid = safeStr(id);
  let row; try { row = await getRowStrict(env, tid); } catch (e) { return dbDown(e); }
  if (!row || !inScope(row, viewer)) return { ok: false, http: 404, code: "not_found", message: "This trade doesn't exist." };
  if (!canView2Way(row, viewer)) return { ok: false, http: 403, code: "forbidden", message: "You aren't part of this trade." };
  if (row.status !== "collecting" || row.to_state !== "accepted") return { ok: false, http: 409, code: "not_recheckable", message: "This trade isn't waiting on a re-check right now." };
  const { success } = await env.UPS_MFL_DB.prepare(`UPDATE ups_2way_trades SET status='executing', updated_at_utc=? WHERE id=? AND status='collecting'`).bind(nowIso(), tid).run();
  if (!success) return { ok: false, http: 409, code: "race", message: "This trade just changed state — refresh and try again." };
  const run = () => execute2Way(env, tid);
  if (ctx?.waitUntil) ctx.waitUntil(run()); else await run();
  return { ok: true, rechecking: true };
}

// ═══════════════════════════════════ EXECUTE ═══════════════════════════════════
// The single-leg degenerate case of execute3Way -- one MFL trade, no ring/pairwise
// decomposition, no pass-through verification (nothing to pass through with only two
// parties). Identical safety shape otherwise: cap gate before ANY MFL call, DRY-RUN unless
// TRADE_2WAY_STAGING_EXECUTE=1, execution-ledger lock acquired before the first MFL call,
// idempotency via legExecuted-equivalent (asking MFL directly on an ambiguous response
// rather than assuming failure), and the identical NOT_EXECUTED/EXECUTING/MFL_EXECUTED/
// NEEDS_REVIEW ledger vocabulary.
export async function execute2Way(env, id) {
  const row = await getRow(env, id);
  if (!row || safeStr(row.status) !== "executing") return { skipped: "not_executing" };
  const leagueId = safeStr(row.league_id), year = safeStr(row.season);
  const fromFid = padFid(row.from_fid), toFid = padFid(row.to_fid);
  const movement = injectCapTokens(parseMovements(row)).find((m) => padFid(m.from) === fromFid) || { asset_tokens: [] };
  const reverseMovement = injectCapTokens(parseMovements(row)).find((m) => padFid(m.from) === toFid) || { asset_tokens: [] };
  const give = movement.asset_tokens || [];
  const receive = reverseMovement.asset_tokens || [];

  const finish = async (status, fields) => {
    const sets = ["status=?", "updated_at_utc=?"]; const binds = [status, nowIso()];
    for (const [k, v] of Object.entries(fields || {})) { sets.push(`${k}=?`); binds.push(v); }
    binds.push(id);
    await ledgerDbFor(env).prepare(`UPDATE ups_2way_trades SET ${sets.join(", ")} WHERE id=?`).bind(...binds).run();
  };
  const dmBoth = async (content) => { for (const c of [row.from_discord_ids, row.to_discord_ids]) await dmAll(env, c, { content: safeStr(content).slice(0, 1990) }); };

  if (!give.length && !receive.length) {
    await finish("failed", { failure_reason: "no_executable_movement" });
    await dmBoth(`⚠️ This trade had nothing to move — the commish will take a look.`);
    return { ok: false, error: "no_movement" };
  }

  const gate = await capGate2Way(env, row);
  if (!gate.ok) {
    console.warn(`[2way-staged] ${id} blocked by the cap gate (${gate.kind}): ${gate.message}`);
    await enterBlockedCap2Way(env, row, gate, dmBoth);
    return { ok: false, blocked: true, error: "cap_gate", kind: gate.kind, message: gate.message, compliance: gate.compliance };
  }

  if (!(await liveExecute(env))) {
    console.log(`[2way-staged][DRY-RUN] ${id} would execute: ${fromFid} gives [${give.join(",")}]  <->  ${toFid} gives [${receive.join(",")}]`);
    await finish("completed", { failure_reason: "dry_run", executed_at_utc: nowIso() });
    await dmBoth(`✅ Both sides agreed and every check cleared. _(Dry-run: staging execution isn't live yet — the commish will finalize.)_`);
    return { ok: true, dry_run: true };
  }

  const ledger = (() => { try { return ledgerFor(env); } catch (_) { return null; } })();
  const key = lkey(row);
  let lock = null;
  try {
    if (!ledger) throw new Error("no ledger");
    lock = await ledger.acquire(key, { kind: "two_way_staged", actorFid: fromFid, participants: [fromFid, toFid].join(","), payload: { movements: parseMovements(row), extension_requests: parseExtReqs(row) } });
  } catch (e) {
    console.error(`[2way-staged] ${id}: execution ledger unavailable — nothing sent to MFL: ${e?.message || e}`);
    await enterBlockedCap2Way(env, row, { kind: "ledger_unavailable", message: "We couldn't safely start this trade right now.", compliance: null }, dmBoth);
    return { ok: false, blocked: true, error: "ledger_unavailable" };
  }
  if (!lock.acquired) {
    console.warn(`[2way-staged] ${id}: not executing — ledger state is ${lock.row && lock.row.state}`);
    return { skipped: "execution_not_acquirable", state: lock.row && lock.row.state };
  }
  const token = lock.token;

  const r = await executeCommishTwoPartyTrade(env, { leagueId, year, fromFid, toFid, give, receive, comments: `staged 2-way ${id}` });
  if (!r.ok) {
    console.error(`[2way-staged] ${id} FAILED (safe — nothing moved): ${r.step}/${r.error}`);
    if (r.step === "lockout") {
      await finish("failed", { failure_reason: `lockout: MFL commissioner lockout on` });
      await ledger.move(key, { from: EXEC.EXECUTING, to: EXEC.NOT_EXECUTED, token }).catch(() => {});
      await dmBoth(`⏸️ Both sides agreed and every check cleared, but MFL's commissioner lockout is on, so the bot can't process it yet. **Commish: toggle lockout off and re-run** — nothing has moved.`);
    } else {
      await finish("failed", { failure_reason: `${r.step}: ${safeStr(r.error).slice(0, 200)}` });
      await ledger.move(key, { from: EXEC.EXECUTING, to: EXEC.NOT_EXECUTED, token }).catch(() => {});
      await dmBoth(`⚠️ This trade couldn't be processed (it failed before anything moved). The commish will take a look.`);
    }
    return { ok: false, error: r.error };
  }

  await finish("executing", { mfl_trade_id: r.tradeId });
  await ledger.move(key, { from: EXEC.EXECUTING, to: EXEC.MFL_EXECUTED, token, set: { mfl_evidence_json: { trade_id: r.tradeId }, mfl_executed_at_utc: nowIso() } }).catch(() => {});
  await ledger.move(key, { from: EXEC.MFL_EXECUTED, to: EXEC.COMPLETED, token }).catch(() => {});
  await finish("completed", { executed_at_utc: nowIso() });
  await dmBoth(`✅ This trade went through on MFL (trade ${r.tradeId}).`);
  return { ok: true, tradeId: r.tradeId };
}
