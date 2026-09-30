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
import { EXEC, makeLedger, LEDGER_DDL, franchiseHasUnresolvedDropSequence } from "./trade_execution.js";
import { evaluateCapAcknowledgment } from "./trade_cap_ack.js";
import { makeConditionalDropStore } from "./trade_conditional_drops.js";
import { loadedContractsPermitsWrite } from "./trade_cap_authority.js";
import { resolveLoadedStatus } from "./contract_classification.js";
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

// Cutover (worker/src/index.js's legacy-create refusal) implies staging must be usable --
// without this OR, turning cutover on while forgetting to also turn on plain staging would
// brick ALL 2-way trade creation league-wide (the legacy path refuses, and the staged path
// ALSO refuses) -- exactly the kind of foot-gun this codebase's own "no fail-open guards"
// lesson is about, just inverted (a missing flag combination silently fails CLOSED on
// something that must keep working). Cutover being on is always sufficient on its own.
async function enabled(env) {
  if (await getFeatureFlag(env, "TRADE_2WAY_CUTOVER_ENABLED")) return true;
  return await getFeatureFlag(env, "TRADE_2WAY_STAGING_ENABLED");
}
async function liveExecute(env) { return await getFeatureFlag(env, "TRADE_2WAY_STAGING_EXECUTE"); }
// Keith's ruling (2026-09-29): "Proceed with the separate execution PR... Keep real execution
// disabled throughout development." A SEPARATE, more specific kill switch from
// TRADE_2WAY_STAGING_EXECUTE (which only ever ran the no-drops-required trade path) -- the
// drop-first orchestrator below is materially more dangerous (real, irreversible roster drops,
// not just a trade) and deserves its own, independently-off default. Unset = OFF.
async function dropExecuteEnabled(env) { return await getFeatureFlag(env, "TRADE_2WAY_DROP_EXECUTE_ENABLED"); }
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

// franchiseHasUnresolvedDropSequence moved to trade_execution.js (Keith, 2026-09-30, §8.6) so
// index.js's legacy 2-way path AND trade_3way.js can both reuse it without a circular import
// (trade_3way.js is imported BY this file; it cannot import back from here). Re-exported here
// only for this module's own internal use.

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

    // Per-franchise hold (Keith's ruling, 2026-09-29): refuse staging a NEW offer touching
    // either franchise while either has an unresolved drop-first sequence in flight.
    try {
      for (const fid of [from, to]) {
        if (await franchiseHasUnresolvedDropSequence(env, leagueId, season, fid)) {
          return { ok: false, error: "franchise_has_unresolved_drop_sequence", franchise_id: fid };
        }
      }
    } catch (e) {
      return { ok: false, error: "hold_check_unavailable" };
    }

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
  let compliance = null, capAck = null;
  if (row.status === "collecting" || row.status === "executing") {
    compliance = await complianceViaSelf2Way(env, row);
    // The detail view needs this on a plain GET (a reload, a re-open, a deep link), not only
    // in the moment right after an accept/recheck response -- otherwise "who still needs to
    // acknowledge" would silently vanish the instant a dialog closes.
    if (compliance && compliance.cap && Array.isArray(compliance.cap.violations) && compliance.cap.violations.length) {
      try {
        const acks = await capAckStoreFor(env).readAllForTrade(capAckKey(row));
        capAck = evaluateCapAcknowledgment({ violations: compliance.cap.violations, tradeKey: safeStr(row.id), acks });
      } catch (e) { console.warn(`[2way-staged] ${row.id}: cap-ack read failed (detail view): ${e?.message || e}`); }
    }
  }
  const { names, players } = await enrich(deps, [row]);
  return { ok: true, trade: buildCanonical2Way(row, viewer, { names, players, compliance, capAck }) };
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
    // §12.1 -- read-only "ready to complete" + a dry-run preview, byte-identical to what
    // execute2Way would attempt (deriveExecute2WayPlan, shared, not re-derived). Never touches
    // the ledger or MFL -- see previewExecute2Way's own header for the guarantee.
    let readyToComplete = false, notReadyReason = "terminal", dryRunPreview = null;
    if (row.status === "collecting" || row.status === "executing") {
      try {
        const preview = await previewExecute2Way(env, row);
        readyToComplete = preview.ready_to_complete;
        notReadyReason = preview.not_ready_reason;
        dryRunPreview = preview.dry_run_preview;
      } catch (e) { console.warn(`[2way-staged] commish queue: completion preview failed for ${row.id}: ${e?.message || e}`); notReadyReason = "preview_unavailable"; }
    }
    trades.push({
      ...canonical,
      compliance,
      cap_ack: capAck,
      ledger,
      age_hours_since_created: ageHours(row.created_at_utc),
      age_hours_since_updated: ageHours(row.updated_at_utc),
      ready_to_complete: readyToComplete,
      // Always false -- no commissioner-facing execute action exists yet, independent of
      // whether compliance passes. See previewExecute2Way's header comment.
      completion_available: false,
      not_ready_reason: notReadyReason,
      dry_run_preview: dryRunPreview,
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
    cap_ack: (extra && extra.capAck) || null,
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
  // §8.6 coverage audit (Keith, 2026-09-30): `ups_2way_trades.status` stays 'collecting'
  // throughout the ENTIRE drop-first sequence (executeDropFirstDeal never flips it to
  // 'executing' during the drop loop -- only runTradeLegAfterDrops does, on success) -- so
  // without this check, a real, already-confirmed drop could be "cancelled" away, which would
  // misrepresent an irreversible fact as though nothing happened, AND drop the deal out of the
  // commissioner queue's default view (which excludes 'cancelled'). Once the execution ledger
  // shows ANY attempt has started, cancellation must go through commissioner resolution
  // (§2.4.3b step 7), never the ordinary party-cancel path.
  try {
    const led = await ledgerFor(env).read(lkey(row));
    if (led && led.state && led.state !== EXEC.NOT_EXECUTED && led.state !== EXEC.BLOCKED_CAP) {
      return { ok: false, http: 409, code: "execution_in_progress", message: "This trade has already started executing (at least one step has been attempted) — it can no longer be cancelled through this action. The commissioner must resolve it directly." };
    }
  } catch (e) {
    return { ok: false, http: 503, code: "unavailable", message: "Couldn't confirm it's safe to cancel this right now. Try again in a moment." };
  }
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

  // Per-franchise hold (Keith's ruling, 2026-09-29): refuse an accept touching EITHER
  // franchise while either has an unresolved drop-first sequence in flight -- accepting would
  // build a fresh deal's compliance math on a roster whose true state is a known uncertainty.
  try {
    for (const fid of [row.from_fid, row.to_fid]) {
      if (await franchiseHasUnresolvedDropSequence(env, row.league_id, row.season, fid)) {
        return { ok: false, http: 409, code: "franchise_has_unresolved_drop_sequence", message: "One of the teams in this trade has another deal still being untangled by the commissioner — this can't be accepted until that resolves.", franchise_id: padFid(fid) };
      }
    }
  } catch (e) {
    return { ok: false, http: 503, code: "unavailable", message: "Couldn't confirm it's safe to accept this right now. Try again in a moment." };
  }

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
  // §8.6 coverage audit (Keith, 2026-09-30): once execution has started, the selection must be
  // FROZEN. Without this, an owner could change their pick mid-sequence (e.g. after their
  // originally-selected player is ALREADY confirmed dropped for real) — the orchestrator would
  // then chase the NEW selection too, dropping MORE players than the deal actually required.
  try {
    const led = await ledgerFor(env).read(lkey(row));
    if (led && led.state && led.state !== EXEC.NOT_EXECUTED && led.state !== EXEC.BLOCKED_CAP) {
      return { ok: false, http: 409, code: "execution_in_progress", message: "This trade has already started executing — the drop selection is now locked. Contact the commissioner if this needs to change." };
    }
  } catch (e) {
    return { ok: false, http: 503, code: "unavailable", message: "Couldn't confirm it's safe to change this right now. Try again in a moment." };
  }
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
  // Keith's ruling (2026-09-30): "an owner must never retrigger a failed or uncertain execution
  // step. Only a commissioner may resume it." `ups_2way_trades.status` stays 'collecting'
  // throughout an ENTIRE drop-first sequence (only runTradeLegAfterDrops ever moves it off
  // 'collecting', on success) -- so without this check, THIS is the one owner-facing route that
  // could still be called mid-sequence. It was never actually able to cause a SECOND MFL write
  // (execute2Way's own ledger.acquire() only succeeds from NOT_EXECUTED/BLOCKED_CAP, so it would
  // safely no-op against a ledger already at EXECUTING/PARTIAL_EXECUTED/NEEDS_REVIEW) -- but it
  // WOULD flip row.status to 'executing' (misrepresenting a stuck, commissioner-owned deal as
  // "clearing final checks") and hand the owner a falsely-optimistic `rechecking: true`, silently
  // discarding their action instead of saying it's held. Refuse explicitly instead.
  try {
    const led = await ledgerFor(env).read(lkey(row));
    if (led && led.state && led.state !== EXEC.NOT_EXECUTED && led.state !== EXEC.BLOCKED_CAP) {
      return { ok: false, http: 409, code: "execution_in_progress", message: "This trade has already started executing (at least one step has been attempted) — it's waiting on the commissioner, not a re-check. The commissioner must resume it after reviewing the ledger and MFL evidence." };
    }
  } catch (e) {
    return { ok: false, http: 503, code: "unavailable", message: "Couldn't confirm it's safe to re-check this right now. Try again in a moment." };
  }
  const { success } = await env.UPS_MFL_DB.prepare(`UPDATE ups_2way_trades SET status='executing', updated_at_utc=? WHERE id=? AND status='collecting'`).bind(nowIso(), tid).run();
  if (!success) return { ok: false, http: 409, code: "race", message: "This trade just changed state — refresh and try again." };
  const run = () => execute2Way(env, tid);
  if (ctx?.waitUntil) ctx.waitUntil(run()); else await run();
  return { ok: true, rechecking: true };
}

// The pure give/receive derivation both execute2Way and the read-only completion-preview
// (§12.1, listCommish2WayQueue) call -- ONE implementation, so what a commissioner previews in
// the queue is provably byte-identical to what a real execution would attempt, never two
// independently-written copies that could quietly drift apart. Touches nothing -- no D1 write,
// no MFL call, no ledger read. Safe to call on a row in ANY status.
function deriveExecute2WayPlan(row) {
  const fromFid = padFid(row.from_fid), toFid = padFid(row.to_fid);
  const movement = injectCapTokens(parseMovements(row)).find((m) => padFid(m.from) === fromFid) || { asset_tokens: [] };
  const reverseMovement = injectCapTokens(parseMovements(row)).find((m) => padFid(m.from) === toFid) || { asset_tokens: [] };
  return { fromFid, toFid, give: movement.asset_tokens || [], receive: reverseMovement.asset_tokens || [] };
}

// ═══════════════════════════════════ COMPLETION PREVIEW (§12.1 — read-only, zero writes) ═══════════════════════════════════
// "Ready to complete": the recipient has accepted AND a FRESH compliance re-check is fully "ok"
// (never "needs_drops", even satisfied -- §2.4.1's own rule: a satisfied selection is not an
// executed drop). For a ready trade, also returns the exact give/receive plan execute2Way would
// use -- the SAME function (deriveExecute2WayPlan), not a re-derivation, so the preview can never
// silently disagree with a real completion. This function never acquires the execution ledger
// lock, never writes to D1, and never calls MFL under any flag state -- calling it (e.g. by
// loading the commissioner queue) can never itself start or advance an execution attempt.
// `ready_to_complete` means ONLY "today's compliance re-check passed" -- it says NOTHING about
// whether this trade can actually be completed right now. Keith's correction (2026-09-29): "it
// must not imply it can currently be executed when the execution flag is off or conditional
// drops remain unimplemented." So `completion_available` is a SEPARATE, always-false field: no
// commissioner-facing execute action exists anywhere in this codebase yet, full stop, regardless
// of compliance state. Callers (the queue page) must display these as two independent facts, not
// collapse "compliance clear" into "you can complete this now."
async function previewExecute2Way(env, row) {
  const gate = await capGate2Way(env, row);
  const readyToComplete = !!(gate.ok && row.to_state === "accepted" && (row.status === "collecting" || row.status === "executing"));
  const plan = readyToComplete ? deriveExecute2WayPlan(row) : null;
  return {
    ready_to_complete: readyToComplete,
    completion_available: false,
    not_ready_reason: readyToComplete ? null : (row.to_state !== "accepted" ? "not_yet_accepted" : (gate.kind || "compliance_not_ok")),
    dry_run_preview: plan ? { from_fid: plan.fromFid, to_fid: plan.toFid, give: plan.give, receive: plan.receive } : null,
    compliance: gate.compliance || null,
  };
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
  const { fromFid, toFid, give, receive } = deriveExecute2WayPlan(row);

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

// ═══════════════════ DROP-FIRST EXECUTION (Keith's ruling, 2026-09-29, §2.4.3b) ═══════════════════
// Behind TRADE_2WAY_DROP_EXECUTE_ENABLED, its own kill switch, separate from
// TRADE_2WAY_STAGING_EXECUTE above -- "keep real execution disabled throughout development."
// The sequence: every required conditional drop, one at a time (verify -> MANDATORY snapshot
// -> write -> verify -> record -> notify), stop the WHOLE sequence on any failure/uncertainty;
// only once every drop across every franchise is confirmed does the trade itself run, via
// execute2Way() UNCHANGED above (its own compliance gate naturally reads "ok" once the drops
// are truly reflected in the live roster count -- no bypass, no re-derivation, no drift risk).

function commishDiscordIds(env) {
  return safeStr(env.COMMISH_DISCORD_USER_ID).split(",").map(digits).filter((x) => /^\d{15,20}$/.test(x));
}
async function notifyCommish(env, content) {
  const ids = commishDiscordIds(env);
  if (!ids.length) return { sent: 0 };
  return await dmAll(env, ids.join(","), { content: safeStr(content).slice(0, 1990) });
}
const stepName = (playerId) => `drop:${digits(playerId)}`;

// ═══════════════════ AGING ALERT (Keith, 2026-09-30) ═══════════════════
// "Add an aging alert for unresolved partial sequences; route it to the existing commissioner
// channel and show the age prominently in the queue." An unresolved PARTIAL_EXECUTED/
// NEEDS_REVIEW row means at least one real, irreversible drop already happened and the deal is
// waiting on commissioner action (Keith's retry ruling above: an owner can never advance it).
// The immediate per-step DMs above fire once, at the moment something goes uncertain -- this is
// the separate, later escalation for "nobody has resolved it yet." Deliberately NOT gated on
// TRADE_2WAY_DROP_EXECUTE_ENABLED: a stuck row can outlive the flag being turned back off (e.g.
// turned off BECAUSE something got stuck), and visibility into already-irreversible state must
// never depend on the switch that created it.
const AGING_ALERT_THRESHOLD_MIN = 30; // first alert once stuck this long since the last ledger update
const AGING_ALERT_RECHECK_SEC = 60 * 60; // re-alert cadence while still unresolved and unchanged
// On-demand, exactly like LEDGER_DDL above -- this table is shipped as migration 0093, but this
// check must never depend on migration ordering any more than the ledger itself does.
const HEARTBEAT_DDL = `CREATE TABLE IF NOT EXISTS ups_bot_heartbeat (bot TEXT PRIMARY KEY, last_ts INTEGER NOT NULL, status TEXT DEFAULT 'ok', env TEXT DEFAULT '')`;
async function findAgingDropFirstSequences(env) {
  const db = ledgerDbFor(env);
  await db.prepare(LEDGER_DDL).run().catch(() => {});
  let rows;
  try {
    const res = await db.prepare(
      `SELECT league_id, season, exec_key, state, participants, failed_step, failure_detail, created_at_utc, updated_at_utc
         FROM ups_trade_executions
        WHERE kind = 'two_way_staged_drop_first' AND state IN (?, ?)`
    ).bind(EXEC.PARTIAL_EXECUTED, EXEC.NEEDS_REVIEW).all();
    rows = res.results || [];
  } catch (e) {
    if (/no such table:\s*ups_trade_executions\b/i.test(safeStr(e?.message))) return [];
    console.error(`[drop-first-aging] query failed: ${e?.message || e}`);
    return [];
  }
  const nowMs = Date.now();
  return rows.map((r) => {
    const updatedMs = Date.parse(safeStr(r.updated_at_utc));
    const ageMin = Number.isFinite(updatedMs) ? Math.floor((nowMs - updatedMs) / 60000) : null;
    return { ...r, age_min: ageMin };
  }).filter((r) => r.age_min != null && r.age_min >= AGING_ALERT_THRESHOLD_MIN);
}
/**
 * Scans for unresolved drop-first sequences that have sat stuck long enough to escalate, and DMs
 * the commissioner channel for each one not already alerted (or whose state changed since the
 * last alert). Safe to call on any cron tick -- cheap, read-mostly, and every write is a
 * best-effort heartbeat dedup row, never a ledger mutation. Returns a plain summary, never throws.
 */
export async function checkAgingDropFirstSequences(env) {
  const db = ledgerDbFor(env);
  await db.prepare(HEARTBEAT_DDL).run().catch(() => {});
  let aging;
  try { aging = await findAgingDropFirstSequences(env); } catch (e) { return { ok: false, error: e?.message || String(e) }; }
  let alerted = 0;
  for (const row of aging) {
    const alertKey = `drop_first_aging:${row.league_id}:${row.season}:${row.exec_key}`;
    const nowSec = Math.floor(Date.now() / 1000);
    try {
      const seen = await db.prepare(`SELECT last_ts, status FROM ups_bot_heartbeat WHERE bot = ?`).bind(alertKey).first();
      const lastTs = Number(seen?.last_ts || 0);
      const sameState = seen && safeStr(seen.status) === safeStr(row.state);
      if (sameState && nowSec - lastTs < AGING_ALERT_RECHECK_SEC) continue; // already alerted this state recently
    } catch (e) {
      console.log(`[drop-first-aging] dedupe read failed for ${row.exec_key}, alerting anyway: ${e?.message || e}`);
    }
    const stateLabel = row.state === EXEC.NEEDS_REVIEW ? "NEEDS REVIEW" : "PARTIAL — still resolving";
    const hours = Math.floor(row.age_min / 60), mins = row.age_min % 60;
    const ageLabel = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
    const detail = row.failed_step ? ` Stuck at step \`${safeStr(row.failed_step)}\`${row.failure_detail ? ` (${safeStr(row.failure_detail).slice(0, 200)})` : ""}.` : "";
    await notifyCommish(env, `⏰ **AGING — 2-way trade ${row.exec_key} has been ${stateLabel} for ${ageLabel}** (teams ${safeStr(row.participants)}).${detail} At least one real drop has already happened on this deal. Only the commissioner can resume it, after reviewing the ledger and MFL's own evidence — review it in the trade queue.`);
    alerted += 1;
    try {
      await db.prepare(
        `INSERT INTO ups_bot_heartbeat (bot, last_ts, status, env) VALUES (?, ?, ?, '')
         ON CONFLICT(bot) DO UPDATE SET last_ts = excluded.last_ts, status = excluded.status`
      ).bind(alertKey, nowSec, safeStr(row.state)).run();
    } catch (e) {
      console.log(`[drop-first-aging] dedupe write failed for ${row.exec_key} (alert already sent): ${e?.message || e}`);
    }
  }
  return { ok: true, found: aging.length, alerted };
}

// One live rosters read serves BOTH the "still valid" re-check and the mandatory snapshot --
// never trusted from an earlier read (§2.4.3b step 1/2).
async function fetchLiveRosterRow(env, leagueId, season, franchiseId, playerId) {
  try {
    const apiKey = safeStr(env.MFL_APIKEY);
    if (!apiKey) return { ok: false, reason: "no_mfl_apikey" };
    const u = `https://www48.myfantasyleague.com/${encodeURIComponent(season)}/export?TYPE=rosters&L=${encodeURIComponent(leagueId)}&APIKEY=${encodeURIComponent(apiKey)}&JSON=1`;
    const r = await fetch(u, { headers: { "User-Agent": "upsmflproduction-worker", Accept: "application/json" } });
    const j = await r.json().catch(() => null);
    let franchises = j?.rosters?.franchise || [];
    if (!Array.isArray(franchises)) franchises = franchises ? [franchises] : [];
    const fr = franchises.find((f) => padFid(f?.id) === padFid(franchiseId));
    if (!fr) return { ok: false, reason: "franchise_not_found" };
    let players = fr?.player || [];
    if (!Array.isArray(players)) players = players ? [players] : [];
    const p = players.find((x) => digits(x?.id) === digits(playerId));
    if (!p) return { ok: false, reason: "player_not_on_roster" };
    return { ok: true, row: { salary: safeStr(p.salary), contractStatus: safeStr(p.contractStatus), contractYear: safeStr(p.contractYear), contractInfo: safeStr(p.contractInfo) } };
  } catch (e) {
    return { ok: false, reason: `rosters_fetch_failed: ${e?.message || e}` };
  }
}

// Keith's ruling (2026-09-29): "The exact pre-drop snapshot is mandatory. If the player's
// contract terms or roster state cannot be captured and verified, stop before any drop." This
// is the ONLY gate on whether a drop write is attempted at all -- no default/guessed snapshot,
// ever (mirrors this whole codebase's "don't substitute defaults for MFL fields" rule).
async function captureAndVerifyPreDropSnapshot(env, row, franchiseId, playerId, excludeTokens) {
  if (excludeTokens && excludeTokens.has(digits(playerId))) return { ok: false, reason: "also_being_sent" };
  const live = await fetchLiveRosterRow(env, row.league_id, row.season, franchiseId, playerId);
  if (!live.ok) return { ok: false, reason: live.reason };
  const lst = resolveLoadedStatus(live.row.contractStatus, live.row.contractInfo);
  if (!lst.resolved) return { ok: false, reason: "contract_unresolved" };
  if (!lst.loaded) return { ok: false, reason: "not_a_loaded_contract_anymore" };
  return { ok: true, snapshot: live.row };
}

// Minimal, deliberate re-implementation of index.js's own proven FREE_AGENT-drop transaction
// parser (`_dropPidsFromTx`) -- duplicated rather than imported (trade_dm.js's own stated
// pattern: "re-implements the few it needs so it has no host dependency," avoiding a circular
// import since index.js imports FROM this file). Shape confirmed live 2026-08-16 against every
// real drop transaction this league has ever produced: "added,|dropped," -- dropped ids are
// field 1.
function dropPidsFromFreeAgentTx(blob) {
  const field = safeStr(blob).split("|")[1];
  return (safeStr(field).match(/\d{3,6}/g) || []).map(digits);
}

// Keith's ruling (2026-09-30): "roster presence alone does not prove what happened. A player
// could disappear for another reason, or be dropped and re-added before reconciliation. Use a
// matching MFL transaction record or other authoritative evidence tied to the franchise, player,
// and attempt." This queries MFL's OWN transaction log directly -- the actual recorded event,
// not an inference from a roster snapshot. `sinceUnix` scopes the search to AT OR AFTER this
// specific attempt (with a small backward pad for clock skew), so a match can only be evidence
// of THIS attempt's own drop, never an unrelated historical one.
async function findFreeAgentDropTransaction(env, { leagueId, season, franchiseId, playerId, sinceUnix }) {
  try {
    const apiKey = safeStr(env.MFL_APIKEY);
    if (!apiKey) return { ok: false, reason: "no_mfl_apikey" };
    const u = `https://www48.myfantasyleague.com/${encodeURIComponent(season)}/export?TYPE=transactions&L=${encodeURIComponent(leagueId)}&TRANS_TYPE=FREE_AGENT&APIKEY=${encodeURIComponent(apiKey)}&JSON=1`;
    // Reconciliation evidence must never read a CACHED answer -- explicit cache-bypass closes
    // that one class of staleness completely (Keith, 2026-09-30: "verify the export's
    // coverage"). This does NOT prove MFL's own backend has no independent processing lag --
    // see MIN_RECONCILE_AGE_MS below for how that separate, unverified risk is handled.
    const r = await fetch(u, { headers: { "User-Agent": "upsmflproduction-worker", Accept: "application/json" }, cf: { cacheTtl: 0, cacheEverything: false } });
    const j = await r.json().catch(() => null);
    let rows = j && j.transactions && j.transactions.transaction;
    if (!Array.isArray(rows)) rows = rows ? [rows] : [];
    const fid = padFid(franchiseId), pid = digits(playerId), since = safeInt(sinceUnix, 0);
    const match = rows.find((rowTx) => {
      if (padFid(rowTx && rowTx.franchise) !== fid) return false;
      const ts = safeInt(rowTx && rowTx.timestamp, 0);
      if (ts && since && ts < since) return false;
      return dropPidsFromFreeAgentTx(rowTx && rowTx.transaction).includes(pid);
    });
    return { ok: true, found: !!match, evidence: match ? { timestamp: safeStr(match.timestamp), franchise: fid, raw_transaction: safeStr(match.transaction) } : null };
  } catch (e) {
    return { ok: false, reason: `transactions_fetch_failed: ${e?.message || e}` };
  }
}

// The full reconciliation decision (Keith, 2026-09-30) for a step whose prior attempt's outcome
// is unknown (`attempting`/`unconfirmed`). NEVER presence-alone in either direction:
//   - a matching FREE_AGENT transaction record for THIS franchise+player at/after the attempt
//     is authoritative proof it happened -- confirmed regardless of current roster presence
//     (handles "dropped, then re-added before reconciliation": the transaction record still
//     proves the original drop was real, even though presence alone would now say otherwise).
//   - no matching transaction record AND the player is still genuinely present -- both signals
//     agree nothing happened -- safe to retry.
//   - no matching transaction record but the player is ABSENT -- an unrelated event could have
//     moved them (a waiver claim, a different drop, a data lag) -- never assumed to be OUR OWN
//     doing. Held for commissioner review, not guessed.
//   - the transaction log itself can't be read -- held; evidence is unavailable, never guessed.
// Keith's ruling (2026-09-30): "'no matching transaction + player present' is safe to retry
// only if the MFL export is complete through the attempt time. If the export can lag, truncate,
// or omit that transaction, absence of a match proves nothing." This codebase has NO proven
// evidence MFL's transactions export is instantaneous -- the one existing precedent for using
// this same export to reconcile an ambiguous write (trade_3way.js's legExecuted/findExecutedTrade)
// only ever uses it as SECONDARY corroboration of an ALREADY-positive signal (a tradeId in a bad
// response), never as the sole source of truth for "nothing happened" the way this function's
// own "retry" branch does. Absent proof either way, a "no match" result is trusted for the RETRY
// decision only once this much real time has passed since the attempt -- long enough that any
// ordinary processing lag would have resolved. This is a conservative BUFFER, not a proven-
// sufficient one; if real evidence about the export's actual latency ever surfaces, this constant
// should be revisited, not treated as settled.
const MIN_RECONCILE_AGE_MS = 5 * 60000; // 5 minutes

async function reconcilePriorAttempt(env, row, step, prior) {
  const attemptedIso = safeStr(prior.attempted_at_utc) || safeStr(prior.confirmed_at_utc) || "";
  const attemptedMs = Date.parse(attemptedIso);
  const sinceUnix = Number.isFinite(attemptedMs) ? Math.floor(attemptedMs / 1000) - 60 : 0;
  const tx = await findFreeAgentDropTransaction(env, { leagueId: row.league_id, season: row.season, franchiseId: step.franchiseId, playerId: step.playerId, sinceUnix });
  if (!tx.ok) return { outcome: "hold", reason: `transaction_log_unavailable: ${tx.reason}` };
  if (tx.found) return { outcome: "confirmed", evidence: tx.evidence };
  const live = await fetchLiveRosterRow(env, row.league_id, row.season, step.franchiseId, step.playerId);
  if (!live.ok && live.reason === "player_not_on_roster") return { outcome: "hold", reason: "absent_without_matching_transaction" };
  if (!live.ok) return { outcome: "hold", reason: `roster_check_failed: ${live.reason}` };
  // Present + no transaction match -- but do NOT trust "no match" as proof of "never happened"
  // until enough time has passed for the export to plausibly have caught up.
  const ageMs = Number.isFinite(attemptedMs) ? Date.now() - attemptedMs : Infinity;
  if (ageMs < MIN_RECONCILE_AGE_MS) return { outcome: "hold", reason: "too_soon_to_trust_export_completeness" };
  return { outcome: "retry" };
}

// Classifies the REAL /roster-workbench/action {unload_player} response (worker/src/index.js,
// the same route the ERA auto-drop sweep already uses, unchanged, ERA-gated) into exactly
// three outcomes -- confirmed / failed / unconfirmed -- never conflating "we know it didn't
// happen" with "we don't know what happened" (§2.1's rule, reused here for the drop leg).
function classifyDropActionResponse(status, data) {
  if (data && data.ok === true && data.verification && data.verification.ok) {
    return { status: "confirmed", verification: data.verification };
  }
  const detailErr = safeStr(data && data.details && data.details.error);
  const preview = safeStr(data && data.details && data.details.preview).toLowerCase();
  const lockoutLike = detailErr === "commissioner_access_required" || preview.includes("commissioner access required") || preview.includes("not authorized");
  if (lockoutLike) return { status: "failed", reason: `lockout: ${safeStr((data && data.error) || "commissioner access required")}`, verification: (data && data.verification) || null };
  const verifReason = safeStr(data && data.verification && data.verification.reason);
  if (verifReason === "player_still_found_on_roster") {
    return { status: "failed", reason: "mfl_did_not_remove_player", verification: data.verification };
  }
  if (!data || data.ok == null || verifReason === "post_membership_rosters_export_failed") {
    return { status: "unconfirmed", reason: safeStr(data && data.error) || `status_${status}`, verification: (data && data.verification) || null };
  }
  if (data.ok === false) return { status: "failed", reason: safeStr(data.error) || `status_${status}`, verification: data.verification || null };
  return { status: "unconfirmed", reason: `unexpected_response_status_${status}` };
}

async function performConditionalDrop(env, { leagueId, season, franchiseId, playerId }) {
  if (!env.SELF) return { status: "unconfirmed", reason: "no_self_binding" };
  const apiKey = safeStr(env.COMMISH_API_KEY);
  if (!apiKey) return { status: "unconfirmed", reason: "no_commish_key" };
  try {
    const u = `https://self.invalid/roster-workbench/action?APIKEY=${encodeURIComponent(apiKey)}`;
    const r = await env.SELF.fetch(u, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "unload_player", league_id: leagueId, season, franchise_id: franchiseId, player_id: playerId }),
    });
    const data = await r.json().catch(() => null);
    return classifyDropActionResponse(r.status, data);
  } catch (e) {
    return { status: "unconfirmed", reason: `call_failed: ${e?.message || e}` };
  }
}

// Flattens EVERY franchise's SATISFIED, valid drop selection (from a fresh capGate2Way's
// compliance.loaded_contracts.drop_requirements -- never re-derived, never trusted from a
// stale read) into an ordered list of {franchiseId, playerId} steps. Order between different
// franchises' drops doesn't matter to each other (§2.3.1) -- what matters is EVERY one of them
// runs before the trade.
function flattenRequiredDropSteps(gate) {
  const reqs = (gate && gate.drop_requirements) || [];
  const steps = [];
  for (const r of reqs) {
    const players = (r.selected || []).filter((x) => x.valid).map((x) => digits(x.player_id));
    for (const pid of players) steps.push({ franchiseId: padFid(r.franchise_id), franchiseName: safeStr(r.franchise_name), playerId: pid });
  }
  return steps;
}

// Never fabricates a name -- the drop-first orchestrator has no player-name lookup wired in
// yet (see docs/LOADED_CONTRACT_DROP_EXECUTION_DESIGN.md §12.3's still-open items), so every
// notification identifies the player by id rather than guessing or leaving it blank.
function playerLabelFor(playerId) { return `player ${digits(playerId)}`; }

/**
 * The drop-first orchestrator. Never throws; every path returns a plain status object.
 * Safe to call repeatedly (idempotent) -- a retry skips any step already `confirmed` in
 * steps_json (§2.4.3b: "retries must never repeat a confirmed drop"), and picks up exactly
 * where a prior attempt stopped.
 */
export async function executeDropFirstDeal(env, ctx, id) {
  if (!(await dropExecuteEnabled(env))) return { ok: false, error: "drop_execute_disabled" };
  const row = await getRow(env, id);
  if (!row) return { ok: false, error: "not_found" };
  if (row.to_state !== "accepted") return { ok: false, error: "not_accepted" };
  if (!(row.status === "collecting" || row.status === "executing")) return { ok: false, error: "not_active", status: row.status };

  const fromFid = padFid(row.from_fid), toFid = padFid(row.to_fid);
  const dmBoth = async (content) => { for (const c of [row.from_discord_ids, row.to_discord_ids]) await dmAll(env, c, { content: safeStr(content).slice(0, 1990) }); };
  const dmOne = async (discordIds, content) => { await dmAll(env, discordIds, { content: safeStr(content).slice(0, 1990) }); };

  // Per-franchise hold, applied to the EXECUTOR itself (§8.6 audit, Keith 2026-09-30): a
  // franchise cannot have TWO drop-first sequences in flight at once. Excludes THIS trade's own
  // id, so a stuck deal can always resume itself -- only a DIFFERENT unresolved deal blocks.
  try {
    for (const fid of [fromFid, toFid]) {
      if (await franchiseHasUnresolvedDropSequence(env, row.league_id, row.season, fid, id)) {
        return { ok: false, blocked: true, kind: "franchise_has_unresolved_drop_sequence", franchise_id: fid };
      }
    }
  } catch (e) {
    return { ok: false, error: "hold_check_unavailable" };
  }

  // STEP 0 (§2.4.3b): verify the trade can proceed BEFORE the first drop. A fresh compliance
  // gate -- the SAME one execute2Way itself will re-run at the end, never a second
  // implementation. If it's already fully "ok" (no drops needed, or already resolved), this
  // isn't this orchestrator's job at all -- the ordinary execute2Way path handles it.
  const gate0 = await capGate2Way(env, row);
  if (gate0.ok) return { ok: true, no_drops_needed: true, delegate: "execute2Way" };
  if (gate0.kind !== "loaded_contract_drops_required") {
    // cap_ack_required / extension / unavailable -- not this orchestrator's job; leave it held
    // exactly as the ordinary path already does.
    await enterBlockedCap2Way(env, row, gate0, dmBoth);
    return { ok: false, blocked: true, kind: gate0.kind };
  }
  const reqs = gate0.drop_requirements || [];
  if (reqs.some((r) => !r.satisfied)) {
    await enterBlockedCap2Way(env, row, gate0, dmBoth);
    return { ok: false, blocked: true, kind: "not_all_satisfied" };
  }
  const steps = flattenRequiredDropSteps(gate0);
  if (!steps.length) {
    // Every franchise reads "satisfied" with zero actual valid picks -- can't happen from a
    // real capGate2Way (satisfied implies validCount >= required > 0), but never assume; treat
    // as held rather than silently doing nothing.
    return { ok: false, blocked: true, kind: "no_drop_steps_derived" };
  }

  const ledger = ledgerFor(env);
  const key = lkey(row);
  const claim = await ledger.resumeDropSequence(key, new Date(Date.now() - 120000).toISOString(), {
    kind: "two_way_staged_drop_first", actorFid: fromFid, participants: [fromFid, toFid].join(","),
    payload: { movements: parseMovements(row), extension_requests: parseExtReqs(row), steps: steps.map((s) => ({ franchise_id: s.franchiseId, player_id: s.playerId })) },
  });
  if (!claim.acquired) return { skipped: "execution_not_acquirable", state: claim.row && claim.row.state };
  const token = claim.token;
  const excludeTokens = new Set(injectCapTokens(parseMovements(row)).flatMap((m) => (m.asset_tokens || []).map(digits)));

  // Reconcile ANY prior `attempting`/`unconfirmed` step BEFORE the main loop, even one no
  // longer in the freshly-recomputed `steps` list above. The required-drops count is recomputed
  // fresh from the LIVE roster every time (§2.3.1) -- once a drop genuinely lands, the very next
  // compliance read may already show one fewer drop required, which would otherwise let that
  // step's own ledger record sit unreconciled forever (never revisited by the main loop, since
  // it's no longer "required"). The ledger must reflect what's TRUE, not only what's currently
  // required -- an auditing commissioner must never see a permanently-stuck `attempting` row for
  // a drop that in fact already happened.
  const priorSteps = (claim.row && claim.row.steps) || {};
  for (const [existingName, existingVal] of Object.entries(priorSteps)) {
    if (!/^drop:/.test(existingName)) continue;
    if (existingVal.status !== "attempting" && existingVal.status !== "unconfirmed") continue;
    if (steps.some((s) => stepName(s.playerId) === existingName)) continue; // the main loop below reconciles it in place
    const orphanFid = padFid(existingVal.franchise_id), orphanPid = digits(existingVal.player_id);
    const orphanRecon = await reconcilePriorAttempt(env, row, { franchiseId: orphanFid, playerId: orphanPid }, existingVal);
    if (orphanRecon.outcome === "confirmed") {
      await ledger.recordStep(key, existingName, { status: "confirmed", reconciled: true, reason: "reconciled_via_transaction_log_no_longer_required", mfl_evidence: orphanRecon.evidence, franchise_id: orphanFid, player_id: orphanPid, pre_drop_snapshot: existingVal.pre_drop_snapshot || null, confirmed_at_utc: nowIso() });
      const orphanLabel = playerLabelFor(orphanPid);
      await dmOne(row[`${orphanFid === fromFid ? "from" : "to"}_discord_ids`], `✅ **${orphanLabel} has been dropped from your roster** as part of this trade (confirmed on a re-check). The trade itself has **not** gone through yet.`);
      await notifyCommish(env, `✅ 2-way trade ${id}: drop for ${orphanLabel} (${orphanFid}) RECONCILED as confirmed via MFL's own transaction record, and is no longer part of the required set (the requirement recomputed once it landed).`);
      continue;
    }
    if (orphanRecon.outcome === "hold") {
      // Unlike `retry` below, an unresolved AMBIGUITY on ANY step of this deal -- even one no
      // longer required -- stops the WHOLE sequence. "No longer required" only means the
      // compliance math doesn't currently need a NEW drop of this player; it says nothing about
      // whether something concerning already happened to them that the commissioner needs to
      // see before anything else proceeds (Keith's "no fail-open guards" principle, applied
      // here: silently completing the rest of the deal while a real ambiguity sits unresolved
      // for the SAME deal is exactly the kind of quiet pass-through this codebase refuses).
      await ledger.recordStep(key, existingName, { status: "unconfirmed", reason: `reconciliation_${orphanRecon.reason}`, franchise_id: orphanFid, player_id: orphanPid });
      await ledger.move(key, { from: [EXEC.EXECUTING, EXEC.PARTIAL_EXECUTED], to: EXEC.NEEDS_REVIEW, token, set: { failed_step: existingName, failure_detail: `reconciliation_${orphanRecon.reason}` } });
      const orphanLabel = playerLabelFor(orphanPid);
      await dmOne(row.from_discord_ids + "," + row.to_discord_ids, `⚠️ We could not confirm what happened with an earlier conditional-drop attempt on this trade (${orphanLabel}) — ${orphanRecon.reason === "absent_without_matching_transaction" ? "the player is gone from that roster, but MFL's own transaction log shows no record of us dropping them" : "the evidence we need to check couldn't be read right now"}. Nothing else in this deal proceeds until the commissioner reviews it directly.`);
      await notifyCommish(env, `⚠️ 2-way trade ${id}: an earlier drop attempt (${orphanLabel}) could not be reconciled (${orphanRecon.reason}), even though it's no longer part of the current required set. Held for manual review before anything else in this deal proceeds.`);
      return { ok: false, stopped_at: existingName, status: "unconfirmed", reason: `reconciliation_${orphanRecon.reason}` };
    }
    // `retry`: genuinely safe -- present, no transaction evidence, and not currently required.
    // Left exactly as-is; nothing to reconcile and nothing blocking.
  }

  for (const step of steps) {
    const name = stepName(step.playerId);
    const cur = await ledger.read(key);
    const prior = cur && cur.steps && cur.steps[name];
    if (prior && prior.status === "confirmed") continue; // never repeat a confirmed drop

    // §2.4.3b addendum (Keith, 2026-09-30): "A retry cannot safely infer from a missing ledger
    // step that the drop never happened... roster presence alone does not prove what happened.
    // A player could disappear for another reason, or be dropped and re-added before
    // reconciliation. Use a matching MFL transaction record or other authoritative evidence."
    // `attempting`/`unconfirmed` are the ONLY two prior statuses that mean "we know we tried,
    // but we don't know what happened" -- a step that was never touched, or one already proven
    // `failed` with direct evidence (a genuine MFL refusal, verified), does NOT get this
    // treatment: reconciliation exists to resolve OUR OWN uncertainty, never to guess at a
    // situation we have no reason to think we caused. Runs BEFORE any fresh snapshot/write
    // attempt, and its verdict is FINAL for this pass -- never overridden by a subsequent
    // presence check.
    if (prior && (prior.status === "attempting" || prior.status === "unconfirmed")) {
      const recon = await reconcilePriorAttempt(env, row, step, prior);
      if (recon.outcome === "confirmed") {
        // Authoritative: a matching MFL transaction record proves this happened, regardless of
        // current roster presence (this is exactly what makes "dropped, then re-added before
        // reconciliation" safe -- the transaction record survives a later re-add).
        await ledger.recordStep(key, name, { status: "confirmed", reconciled: true, reason: "reconciled_via_transaction_log", mfl_evidence: recon.evidence, franchise_id: step.franchiseId, player_id: step.playerId, pre_drop_snapshot: prior.pre_drop_snapshot || null, confirmed_at_utc: nowIso() });
        await ledger.move(key, { from: [EXEC.EXECUTING, EXEC.PARTIAL_EXECUTED], to: EXEC.PARTIAL_EXECUTED, token });
        const label0 = playerLabelFor(step.playerId);
        await dmOne(row[`${step.franchiseId === fromFid ? "from" : "to"}_discord_ids`], `✅ **${label0} has been dropped from your roster** as part of this trade (confirmed on a re-check against MFL's own transaction record — an earlier attempt's own result was lost, but MFL's log proves it happened). The trade itself has **not** gone through yet.`);
        await notifyCommish(env, `✅ 2-way trade ${id}: drop for ${label0} (${step.franchiseName}) RECONCILED as confirmed — MFL's own FREE_AGENT transaction log shows this exact drop (timestamp ${recon.evidence && recon.evidence.timestamp}). Trade still pending.`);
        continue;
      }
      if (recon.outcome === "hold") {
        // Never guessed: either the evidence source itself is unavailable, or the player is
        // absent with NO matching transaction record -- which could mean an UNRELATED event
        // moved them, never assumed to be our own doing.
        await ledger.recordStep(key, name, { status: "unconfirmed", reason: `reconciliation_${recon.reason}`, franchise_id: step.franchiseId, player_id: step.playerId });
        await ledger.move(key, { from: [EXEC.EXECUTING, EXEC.PARTIAL_EXECUTED], to: EXEC.NEEDS_REVIEW, token, set: { failed_step: name, failure_detail: `reconciliation_${recon.reason}` } });
        const label0 = playerLabelFor(step.playerId);
        await dmOne(row.from_discord_ids + "," + row.to_discord_ids, `⚠️ We could not confirm what happened with this trade's conditional drop (${label0}, ${step.franchiseName}) from an earlier attempt — ${recon.reason === "absent_without_matching_transaction" ? "the player is gone from that roster, but MFL's own transaction log shows no record of us dropping them, so we cannot assume that was us" : "the evidence we need to check couldn't be read right now"}. Nothing else in this deal proceeds until the commissioner reviews it directly.`);
        await notifyCommish(env, `⚠️ 2-way trade ${id}: drop step for ${label0} (${step.franchiseName}) — reconciliation could not confirm the outcome (${recon.reason}). Held for manual review — check MFL's own roster and transaction log before doing anything else.`);
        return { ok: false, stopped_at: name, status: "unconfirmed", reason: `reconciliation_${recon.reason}` };
      }
      // outcome === "retry": no matching transaction record AND the player is still genuinely
      // present -- both signals agree nothing happened. Falls through to the ordinary fresh
      // snapshot + write attempt below, exactly as if this were a never-attempted step.
    }

    const revalidation = await captureAndVerifyPreDropSnapshot(env, row, step.franchiseId, step.playerId, excludeTokens);
    if (!revalidation.ok) {
      await ledger.recordStep(key, name, { status: "failed", reason: `snapshot_failed: ${revalidation.reason}`, franchise_id: step.franchiseId, player_id: step.playerId });
      await ledger.move(key, { from: [EXEC.EXECUTING, EXEC.PARTIAL_EXECUTED], to: EXEC.NEEDS_REVIEW, token, set: { failed_step: name, failure_detail: `snapshot_failed: ${revalidation.reason}` } });
      const label = playerLabelFor(step.playerId);
      await dmOne(row.from_discord_ids + "," + row.to_discord_ids, `🛑 This trade's conditional drop (${label}, ${step.franchiseName}) could not be safely verified before dropping, so **nothing was dropped**. The commissioner will look into it — this deal is on hold.`);
      await notifyCommish(env, `🛑 2-way trade ${id}: drop step for ${label} (${step.franchiseName}) stopped BEFORE any write — snapshot/verification failed (${revalidation.reason}). Mandatory per Keith's ruling: no drop is attempted without a verified pre-drop snapshot.`);
      return { ok: false, stopped_at: name, reason: `snapshot_failed: ${revalidation.reason}` };
    }

    // Record OUR OWN intent to write BEFORE the risky call -- the fix for the exact gap Keith
    // identified: if this worker dies or times out between MFL confirming the drop and this
    // code recording it, the NEXT attempt finds `attempting` here (never silence), and the
    // branch above reconciles it against the live roster instead of blindly re-attempting or
    // blindly assuming success.
    await ledger.recordStep(key, name, { status: "attempting", franchise_id: step.franchiseId, player_id: step.playerId, pre_drop_snapshot: revalidation.snapshot, attempted_at_utc: nowIso() });

    const result = await performConditionalDrop(env, { leagueId: row.league_id, season: row.season, franchiseId: step.franchiseId, playerId: step.playerId });
    if (result.status !== "confirmed") {
      await ledger.recordStep(key, name, { status: result.status, reason: result.reason, franchise_id: step.franchiseId, player_id: step.playerId, pre_drop_snapshot: revalidation.snapshot, mfl_verification: result.verification || null });
      await ledger.move(key, { from: [EXEC.EXECUTING, EXEC.PARTIAL_EXECUTED], to: EXEC.NEEDS_REVIEW, token, set: { failed_step: name, failure_detail: result.reason } });
      const label = playerLabelFor(step.playerId);
      const unknown = result.status === "unconfirmed";
      await dmOne(row.from_discord_ids + "," + row.to_discord_ids, unknown
        ? `⚠️ This trade's conditional drop (${label}, ${step.franchiseName}) came back **unconfirmed** — we could not verify whether it happened. Nothing else in this deal proceeds until the commissioner checks the live roster. Do not assume either outcome.`
        : `🛑 This trade's conditional drop (${label}, ${step.franchiseName}) was **not confirmed** (${result.reason}). Nothing else in this deal proceeds until the commissioner resolves it.`);
      await notifyCommish(env, `${unknown ? "⚠️ UNCONFIRMED" : "🛑 FAILED"} 2-way trade ${id}: drop step for ${label} (${step.franchiseName}) — ${result.reason}. Sequence stopped here; remaining steps (if any) never ran.`);
      return { ok: false, stopped_at: name, status: result.status, reason: result.reason };
    }

    await ledger.recordStep(key, name, { status: "confirmed", franchise_id: step.franchiseId, player_id: step.playerId, pre_drop_snapshot: revalidation.snapshot, mfl_verification: result.verification, confirmed_at_utc: nowIso() });
    await ledger.move(key, { from: [EXEC.EXECUTING, EXEC.PARTIAL_EXECUTED], to: EXEC.PARTIAL_EXECUTED, token });
    const label = playerLabelFor(step.playerId);
    // Distinct, per Keith's explicit instruction, from the eventual "trade completed" DM below.
    await dmOne(row[`${step.franchiseId === fromFid ? "from" : "to"}_discord_ids`], `✅ **${label} has been dropped from your roster** as part of this trade. The trade itself has **not** gone through yet — you'll get a separate message once it does (or if anything stops it).`);
    await notifyCommish(env, `✅ 2-way trade ${id}: drop confirmed for ${label} (${step.franchiseName}). Trade still pending.`);
  }

  // Every required drop confirmed -- the row is now `partial_executed`. Delegate the trade
  // leg itself to execute2Way UNCHANGED: its own capGate2Way will read "ok" because the drops
  // are already reflected in the live roster count, and resumeDropSequence above already moved
  // the row to `executing` under OUR token, which is exactly the state execute2Way expects to
  // find when IT tries to acquire -- except execute2Way calls ledger.acquire() itself, which
  // only matches FROM not_executed/blocked_cap. To avoid a second, subtly different
  // acquire path, release nothing here: call execute2Way with the SAME row id; its internal
  // acquire() will see state=executing (ours) and correctly refuse to re-acquire (acquired:
  // false) UNLESS we hand off cleanly. Handing off cleanly means: run the trade leg HERE,
  // using the identical mechanism execute2Way uses internally, under the token we already hold
  // -- not by calling execute2Way() as a black box (its own acquire() cannot resume our lock).
  return await runTradeLegAfterDrops(env, row, key, token, dmBoth);
}

// The trade leg of a drop-first sequence, run under the SAME lock token the drop loop already
// holds (never execute2Way's own acquire(), which cannot resume a lock -- see the comment
// above). Deliberately SEPARATE from execute2Way's body, not a shared helper: execute2Way's own
// failure path moves EXECUTING -> NOT_EXECUTED, which would be a LIE here (real drops already
// happened -- see trade_execution.js's PARTIAL_EXECUTED comment). Every failure here moves to
// NEEDS_REVIEW instead, and the DM is explicit that drops are confirmed but the trade is not.
async function runTradeLegAfterDrops(env, row, key, token, dmBoth) {
  const fromFid = padFid(row.from_fid), toFid = padFid(row.to_fid);
  const movement = injectCapTokens(parseMovements(row)).find((m) => padFid(m.from) === fromFid) || { asset_tokens: [] };
  const reverseMovement = injectCapTokens(parseMovements(row)).find((m) => padFid(m.from) === toFid) || { asset_tokens: [] };
  const give = movement.asset_tokens || [], receive = reverseMovement.asset_tokens || [];
  const ledger = ledgerFor(env);

  if (!(await liveExecute(env))) {
    console.log(`[2way-staged][DRY-RUN] ${row.id} (drop-first) would execute trade: ${fromFid} gives [${give.join(",")}]  <->  ${toFid} gives [${receive.join(",")}]`);
    await ledgerDbFor(env).prepare(`UPDATE ups_2way_trades SET status='completed', failure_reason='dry_run', executed_at_utc=?, updated_at_utc=? WHERE id=?`).bind(nowIso(), nowIso(), row.id).run();
    await ledger.move(key, { from: EXEC.PARTIAL_EXECUTED, to: EXEC.MFL_EXECUTED, token, set: { mfl_executed_at_utc: nowIso() } }).catch(() => {});
    await ledger.move(key, { from: EXEC.MFL_EXECUTED, to: EXEC.COMPLETED, token }).catch(() => {});
    await dmBoth(`✅ Every required drop for this trade is confirmed, and the trade itself cleared. _(Dry-run: staging execution isn't live yet — the commish will finalize.)_`);
    return { ok: true, dry_run: true };
  }

  const r = await executeCommishTwoPartyTrade(env, { leagueId: safeStr(row.league_id), year: safeStr(row.season), fromFid, toFid, give, receive, comments: `staged 2-way drop-first ${row.id}` });
  if (!r.ok) {
    const lockout = r.step === "lockout";
    await ledgerDbFor(env).prepare(`UPDATE ups_2way_trades SET failure_reason=?, updated_at_utc=? WHERE id=?`).bind(`${lockout ? "lockout" : r.step}: ${safeStr(r.error).slice(0, 200)}`, nowIso(), row.id).run();
    await ledger.move(key, { from: EXEC.PARTIAL_EXECUTED, to: EXEC.NEEDS_REVIEW, token, set: { failed_step: "trade", failure_detail: safeStr(r.error).slice(0, 300) } }).catch(() => {});
    // The single most safety-critical notification in this whole feature: drops are REAL and
    // PERMANENT; the trade is NOT. Never conflated with "the trade completed," never implying
    // restoration is guaranteed (Keith: "do not describe restoration as guaranteed unless MFL
    // behavior proves it").
    await dmBoth(`🚨 **Every required drop for this trade is confirmed and permanent — but the trade itself did NOT go through** (${lockout ? "MFL's commissioner lockout is on" : "MFL refused it"}). This means a player was given up and nothing has been received in return yet. The commissioner has been alerted. Restoration, if attempted, is a manual process and is **not guaranteed** — especially if the player is claimed by someone else first. Do not assume you'll get the player or an equivalent back automatically.`);
    await notifyCommish(env, `🚨 2-way trade ${row.id}: EVERY required drop confirmed, but the TRADE LEG FAILED (${r.step}/${safeStr(r.error).slice(0, 200)}). This is the player-loss scenario — see docs/LOADED_CONTRACT_DROP_EXECUTION_DESIGN.md §2.4.3b's restoration section before doing anything. Act quickly if restoration is to be attempted at all.`);
    return { ok: false, error: r.error, drops_confirmed_trade_failed: true };
  }

  await ledgerDbFor(env).prepare(`UPDATE ups_2way_trades SET status='completed', mfl_trade_id=?, executed_at_utc=?, updated_at_utc=? WHERE id=?`).bind(r.tradeId, nowIso(), nowIso(), row.id).run();
  await ledger.move(key, { from: EXEC.PARTIAL_EXECUTED, to: EXEC.MFL_EXECUTED, token, set: { mfl_evidence_json: { trade_id: r.tradeId }, mfl_executed_at_utc: nowIso() } }).catch(() => {});
  await ledger.move(key, { from: EXEC.MFL_EXECUTED, to: EXEC.COMPLETED, token }).catch(() => {});
  await dmBoth(`✅ This trade went through on MFL (trade ${r.tradeId}) — every required drop and the trade itself are now complete.`);
  await notifyCommish(env, `✅ 2-way trade ${row.id} fully completed (trade ${r.tradeId}) after its required drop(s).`);
  return { ok: true, tradeId: r.tradeId };
}
