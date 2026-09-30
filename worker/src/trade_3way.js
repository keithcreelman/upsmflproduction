// trade_3way.js — UPS 3-way trade engine (free-form routing).
//
// Three teams A (initiator), B, C exchange a set of "movements" — each movement
// is one team sending specific assets to another ({from, to, asset_tokens}).
// This covers a clean ring (A->B->C->A) AND deals where teams "work together"
// (A + C both feed B; B sends back to both; etc.). MFL only does 2-party trades,
// so the engine decomposes the movements two ways:
//
//   • Clean cycle (exactly A->B, B->C, C->A)  -> the proven 2-trade HUB path:
//       Trade 1 (A<->B): A gives X, receives Y   (A temporarily holds the Y pass-through)
//       Trade 2 (A<->C): A gives Y, receives Z
//       Net: A -X +Z · B +X -Y · C +Y -Z  ✓
//   • Anything else -> PAIRWISE: one MFL trade per team-pair (a gives its
//       a->b assets, b gives its b->a assets). Up to three trades; a one-sided
//       pair is a valid lopsided MFL trade (give-for-nothing).
//
// Both partners (B, C) consent via an in-Discord Accept button (A is implicit by
// building it). When both accept, the commish (env.MFL_APIKEY) executes every
// leg server-side — the partners never touch MFL. MFL has NO undo for a
// COMPLETED trade, so execution is ordered + verified between legs + all-or-
// nothing with a CRITICAL commish alert on partial failure.
//
// SAFETY GATES:
//   TRADE_3WAY_ENABLED = "1"  -> feature on (DMs, acceptance). Else dark.
//   TRADE_3WAY_EXECUTE = "1"  -> LIVE MFL writes. Else DRY-RUN (logs + DMs
//                               "would execute" but moves no rosters). Default
//                               off so the whole flow is testable safely.
//   TRADE_DM_TEST_FRANCHISES  -> reused allowlist for the rollout.

import { dmAll, resolveDiscordUserIds } from "./trade_dm.js";
import { getFeatureFlag } from "./feature_flags.js";
import { buildCanonical3Way, decideCancel, decideAdminCancel, ADMIN_CANCEL_BASIS, canView } from "./trade_3way_model.js";
import { makeLedger, EXEC, findExecutedTrade, isMflExecuted, franchiseHasUnresolvedDropSequence } from "./trade_execution.js";
import { makeCapAckStore, capAckSignature, evaluateCapAcknowledgment } from "./trade_cap_ack.js";
import { makeConditionalDropStore } from "./trade_conditional_drops.js";
import { loadedContractsPermitsWrite } from "./trade_cap_authority.js";

// ───────────────────────────── helpers ─────────────────────────────────────
function safeStr(v) { return String(v == null ? "" : v).trim(); }
function safeInt(v, fb) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : (fb == null ? 0 : fb); }
function padFid(v) { const s = safeStr(v).replace(/\D/g, ""); return s ? s.padStart(4, "0") : ""; }
function digits(v) { return safeStr(v).replace(/\D/g, ""); }
function nowIso() { return new Date().toISOString(); }
function newId() { try { return crypto.randomUUID(); } catch (_) { return "3w-" + digits(nowIso()) + "-" + digits(safeStr(Math.floor((Date.now() % 1e9)))); } }
function jsonResponse(obj) { return new Response(JSON.stringify(obj), { headers: { "Content-Type": "application/json" } }); }
function ephemeral(content) { return jsonResponse({ type: 4, data: { content: safeStr(content).slice(0, 1990), flags: 64 } }); }
function callerId(i) { return safeStr(i?.member?.user?.id || i?.user?.id || ""); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const GIF_URL = "https://media0.giphy.com/media/v1.Y2lkPWVjZjA1ZTQ3ejVjaG5hOHI4emZqdzhzZzZyM2N6ejZ0dXNpZG4xd3hobWlyb3IyNiZlcD12MV9naWZzX3NlYXJjaCZjdD1n/Ve4lppminZGFyGGqYD/200.webp";

// ───────────────────────────── gates ───────────────────────────────────────
// Async: runtime overrides (commish kill switches in the FO), read from D1 with
// the env var as the default.
async function enabled(env) { return await getFeatureFlag(env, "TRADE_3WAY_ENABLED"); }
async function liveExecute(env) { return await getFeatureFlag(env, "TRADE_3WAY_EXECUTE"); }
function allowlist(env) { return safeStr(env.TRADE_3WAY_TEST_FRANCHISES).split(",").map(padFid).filter(Boolean); }
function franchiseAllowed(env, fid) {
  const list = allowlist(env);
  if (!list.length) return true;
  return list.includes(padFid(fid));
}

// ─────────────────────── MFL asset-token translation ───────────────────────
// Mirror of _toMflAsset in index.js (/api/trade/process): builder tokens ->
// MFL import tokens. P_<id>-> bare id; FP_<yr>_<rd>_<orig> -> FP_<orig>_<yr>_<rd>;
// DP_<yr>_<rd>_<slot> -> DP_<rd-1>_<slot-1> (0-indexed); BB_<amt> unchanged.
export function toMflAsset(a) {
  a = safeStr(a);
  if (a.startsWith("P_")) return a.slice(2);
  if (a.startsWith("BB_")) return `BB_${a.slice(3)}`;
  if (a.startsWith("DP_")) { const [, , rd, slot] = a.split("_"); return `DP_${String(Number(rd) - 1).padStart(2, "0")}_${String(Number(slot) - 1).padStart(2, "0")}`; }
  if (a.startsWith("FP_")) {
    // Robust to token-order variance — the commish path uses FP_<yr>_<rd>_<orig>
    // while the mobile builder emits FP_<orig>_<yr>_<rd>. Identify the year
    // (20xx), the original franchise id (4-digit, e.g. 0001), and the round
    // (1-2 digit), then emit the canonical MFL token FP_<orig>_<yr>_<rd>.
    const parts = a.slice(3).split("_").filter(Boolean);
    const year = parts.find((p) => /^20\d\d$/.test(p)) || "";
    const rest = parts.filter((p) => p !== year);
    const orig = rest.find((p) => p.length === 4) || rest[0] || "";
    const round = rest.find((p) => p !== orig) || "";
    return `FP_${orig}_${year}_${round}`;
  }
  return a;
}

// ───────────── commish 2-party executor (self-contained) ────────────────────
// Propose + accept a 2-party trade server-side with env.MFL_APIKEY (the commish
// can do both sides). Standalone parallel of /api/trade/process (index.js:11878)
// so it's callable from the ctx.waitUntil execution context (no request-scoped
// closures). Returns { ok, tradeId, step, error }.
// Exported (2026-09-29) so worker/src/trade_2way.js can reuse this exact primitive for staged
// 2-way trade execution -- it is already a pure 2-party helper with zero 3-way-specific
// knowledge; the caller owns all state-machine/ledger bookkeeping around it. See that
// module's own execute2Way for the (much simpler, single-leg, no ring/pairwise decomposition)
// caller.
export async function executeCommishTwoPartyTrade(env, { leagueId, year, fromFid, toFid, give, receive, comments }) {
  const apiKey = safeStr(env.MFL_APIKEY);
  if (!apiKey) return { ok: false, step: "config", error: "MFL_APIKEY missing" };
  const giveMfl = (give || []).map(toMflAsset).filter(Boolean).join(",");
  const receiveMfl = (receive || []).map(toMflAsset).filter(Boolean).join(",");
  if (!giveMfl && !receiveMfl) return { ok: false, step: "validate", error: "empty leg" };

  // Step 1 — propose as fromFid
  const proposeUrl = `https://www48.myfantasyleague.com/${year}/import?TYPE=tradeProposal&L=${leagueId}&APIKEY=${encodeURIComponent(apiKey)}&JSON=1`;
  const proposeForm = new URLSearchParams();
  proposeForm.set("FRANCHISE_ID", padFid(fromFid));
  proposeForm.set("OFFEREDTO", padFid(toFid));
  proposeForm.set("WILL_GIVE_UP", giveMfl);
  proposeForm.set("WILL_RECEIVE", receiveMfl);
  proposeForm.set("COMMENTS", "[Commish-processed: 3-way] " + safeStr(comments));
  let proposeResp = "", proposeStatus = 0;
  try {
    const r = await fetch(proposeUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "upsmflproduction-worker" }, body: proposeForm.toString() });
    proposeStatus = r.status; proposeResp = await r.text();
  } catch (e) { return { ok: false, step: "propose", error: `fetch failed: ${e?.message || e}` }; }
  // MFL's commissioner "lockout" disables acting-as-a-franchise (impersonation),
  // which is exactly how the bot proposes/accepts. It returns 200 with an error
  // body "Commissioner can not impersonate another franchise with lockout on."
  // Surface it as its OWN step so the caller can tell the commish to toggle it,
  // rather than mislabeling it as a generic propose/no-trade-id failure.
  if (/impersonate[^.]*lockout|lockout[^.]*impersonate/i.test(proposeResp)) {
    return { ok: false, step: "lockout", error: "MFL commissioner lockout is ON — the bot can't act on a franchise's behalf while it's on. Turn lockout OFF in MFL, then retry; turn it back on after.", mfl_status: proposeStatus };
  }
  // IDEMPOTENCY: MFL rejects an identical re-propose with "Duplicate trade
  // offer" — which means the offer ALREADY EXISTS (e.g. a prior run created it
  // but couldn't read the id back because the pendingTrades lookup was blocked
  // by lockout, orphaning it). Don't fail: fall through to the pendingTrades
  // lookup below, find the existing offer, and accept it. This makes a retry
  // safe — it picks up its own orphan instead of stacking duplicates.
  const proposeDuplicate = /duplicate trade offer/i.test(proposeResp);
  if (!proposeDuplicate && !(proposeStatus >= 200 && proposeStatus < 300 && !/error/i.test(proposeResp))) {
    return { ok: false, step: "propose", error: safeStr(proposeResp).slice(0, 300), mfl_status: proposeStatus };
  }

  // Extract trade_id (from the response, else pendingTrades for fromFid). On a
  // duplicate the response has no id, so the pendingTrades lookup is the path.
  let tradeId = "";
  for (const re of [/TradeID[^\d]*(\d{4,})/i, /trade[_ -]?id[^\d]*(\d{4,})/i, /"id"\s*:\s*"?(\d{4,})"?/i, /\bid\s*=\s*"?(\d{4,})"?/i]) {
    const m = proposeResp.match(re); if (m && m[1]) { tradeId = m[1]; break; }
  }
  if (!tradeId) {
    try {
      const u = `https://www48.myfantasyleague.com/${year}/export?TYPE=pendingTrades&L=${leagueId}&FRANCHISE_ID=${padFid(fromFid)}&APIKEY=${encodeURIComponent(apiKey)}&JSON=1`;
      const r = await fetch(u, { headers: { "User-Agent": "upsmflproduction-worker", Accept: "application/json" } });
      const j = await r.json().catch(() => null);
      const root = (j && (j.pendingTrades || j.pendingtrades)) || {};
      let arr = root.pendingTrade || root.pendingtrade || root.trade || root.trades || [];
      if (!Array.isArray(arr)) arr = arr ? [arr] : [];
      // newest matching offer from->to
      for (const t of arr) {
        const tf = padFid(t?.offeringteam || t?.franchise_id || t?.offering_franchise);
        const tt = padFid(t?.offeredto || t?.to_franchise);
        if ((!tf || tf === padFid(fromFid)) && (!tt || tt === padFid(toFid))) {
          const id = digits(t?.trade_id || t?.id); if (id) { tradeId = id; break; }
        }
      }
    } catch (_) {}
  }
  if (!tradeId) return { ok: false, step: "extract_trade_id", error: "no trade_id from propose or pendingTrades" };

  // Step 2 — accept on behalf of toFid
  const acceptUrl = `https://www48.myfantasyleague.com/${year}/import?TYPE=tradeResponse&L=${leagueId}&APIKEY=${encodeURIComponent(apiKey)}&JSON=1`;
  const acceptForm = new URLSearchParams();
  acceptForm.set("TRADE_ID", tradeId);
  acceptForm.set("RESPONSE", "accept");
  acceptForm.set("FRANCHISE_ID", padFid(toFid));
  acceptForm.set("COMMENTS", "[Commish-processed: 3-way]");
  let acceptResp = "", acceptStatus = 0;
  try {
    const r = await fetch(acceptUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "upsmflproduction-worker" }, body: acceptForm.toString() });
    acceptStatus = r.status; acceptResp = await r.text();
  } catch (e) { return { ok: false, step: "accept", tradeId, error: `fetch failed: ${e?.message || e}` }; }
  if (/impersonate[^.]*lockout|lockout[^.]*impersonate/i.test(acceptResp)) {
    return { ok: false, step: "lockout", tradeId, error: "MFL commissioner lockout is ON — the bot can't accept on a franchise's behalf while it's on. Turn lockout OFF in MFL, then retry.", mfl_status: acceptStatus };
  }
  if (!(acceptStatus >= 200 && acceptStatus < 300 && !/error/i.test(acceptResp))) {
    return { ok: false, step: "accept", tradeId, error: safeStr(acceptResp).slice(0, 300), mfl_status: acceptStatus };
  }
  return { ok: true, tradeId };
}

// Best-effort: does franchise `fid` currently own all the player ids in `tokens`?
// (Picks are not verified — MFL's rosters export doesn't list future picks the
// same way. Players are the common passthrough; this is a guard, not a gate.)
async function rosterOwnsPlayers(env, leagueId, year, fid, tokens) {
  const wantPids = (tokens || []).map(safeStr).filter((t) => t.startsWith("P_")).map((t) => t.slice(2));
  if (!wantPids.length) return true; // nothing player-shaped to verify
  try {
    const apiKey = safeStr(env.MFL_APIKEY);
    const u = `https://www48.myfantasyleague.com/${year}/export?TYPE=rosters&L=${leagueId}&FRANCHISE=${padFid(fid)}&APIKEY=${encodeURIComponent(apiKey)}&JSON=1`;
    const r = await fetch(u, { headers: { "User-Agent": "upsmflproduction-worker", Accept: "application/json" } });
    const j = await r.json().catch(() => null);
    let franchises = j?.rosters?.franchise || [];
    if (!Array.isArray(franchises)) franchises = franchises ? [franchises] : [];
    const f = franchises.find((x) => padFid(x?.id) === padFid(fid)) || franchises[0];
    let players = f?.player || [];
    if (!Array.isArray(players)) players = players ? [players] : [];
    const have = new Set(players.map((p) => digits(p?.id)));
    return wantPids.every((pid) => have.has(digits(pid)));
  } catch (_) { return false; }
}

// ─────────────────────────── cap money (§A6) ───────────────────────────────
// UPS "trade salary" / cap money is MFL BlindBid$ — a BB_<dollars> asset on the
// giving side of a trade (exactly what the 2-party path does: index.js:18434 sums
// BB_ tokens into traded_salary_adjustment_k). The 3-way carries cap_k per
// movement; here we (a) validate it against §A6 and (b) inject the BB_ token at
// execution so the existing decomposition + executeCommishTwoPartyTrade move it.

// Append each movement's cap money as a BlindBid$ token on its giving side, so
// the from→to leg gives `to` that cap. Players already ride asset_tokens, so a
// cap-bearing movement is never dropped by the decomposition.
export function injectCapTokens(movements) {
  return (movements || []).map((m) => {
    const capK = Math.max(0, safeInt(m?.cap_k, 0));
    const toks = Array.isArray(m?.asset_tokens) ? m.asset_tokens.slice() : [];
    if (capK > 0) toks.push(`BB_${capK * 1000}`);
    return { ...m, asset_tokens: toks };
  });
}

// The SAME {from, to, tokens} shape every compliance call needs (a bare numeric id per player,
// `BB_<dollars>` for cap money) -- built from raw {from, to, asset_tokens, cap_k} movements,
// whether they come from a STORED row (via parseMovements) or a not-yet-created spec's own
// `body.movements` (the loaded-contract CREATE-time gate below, before create3WayTrade exists).
// Exported so trade_3way_http.js's create handler can build this identically to get3WayTrade.
export function movementsForCompliance(movements) {
  return (Array.isArray(movements) ? movements : []).map((m) => ({
    from: padFid(m?.from), to: padFid(m?.to),
    tokens: injectCapTokens([m])[0].asset_tokens.map((t) => safeStr(t).replace(/^P_/, "")),
  }));
}

// Live non-taxi salary + taxi flag per `franchise|player`, for the §A6 cap check.
export async function fetchRosterSalaryMap(env, leagueId, year) {
  try {
    const apiKey = safeStr(env.MFL_APIKEY);
    const u = `https://www48.myfantasyleague.com/${year}/export?TYPE=rosters&L=${leagueId}&APIKEY=${encodeURIComponent(apiKey)}&JSON=1`;
    const r = await fetch(u, { headers: { "User-Agent": "upsmflproduction-worker", Accept: "application/json" } });
    const j = await r.json().catch(() => null);
    let franchises = j?.rosters?.franchise || [];
    if (!Array.isArray(franchises)) franchises = franchises ? [franchises] : [];
    const salaryByFp = {}, taxiByFp = {};
    for (const f of franchises) {
      const fid = padFid(f?.id);
      if (!fid) continue;
      let players = f?.player || [];
      if (!Array.isArray(players)) players = players ? [players] : [];
      for (const p of players) {
        const pid = digits(p?.id);
        if (!pid) continue;
        salaryByFp[`${fid}|${pid}`] = Number(p?.salary) || 0;
        taxiByFp[`${fid}|${pid}`] = String(p?.status || "").toUpperCase().includes("TAXI");
      }
    }
    return { ok: true, salaryByFp, taxiByFp };
  } catch (e) { return { ok: false, error: e?.message || String(e) }; }
}

// §A6: cap money a side may attach ≤ 50% of the summed salary of the NON-TAXI
// players it trades away → floor(sumNonTaxiSalary / 2000) in $K. Picks + taxi
// players don't unlock cap. `from` is the giving franchise of the movement.
export function movementCapMaxK(movement, salaryByFp, taxiByFp) {
  const from = padFid(movement?.from);
  let sum = 0;
  for (const tok of (movement?.asset_tokens || [])) {
    const t = safeStr(tok);
    if (!t.startsWith("P_")) continue;       // only players unlock cap money
    const pid = digits(t.slice(2));
    const key = `${from}|${pid}`;
    if (taxiByFp[key]) continue;             // taxi salary doesn't count
    sum += Number(salaryByFp[key]) || 0;
  }
  return Math.floor(sum / 2000);
}

// ─────────────── post-trade salary cap (HARD) + roster counts (advisory) ───────────────
// RULING (Keith, 2026-09-25): a trade must not execute if the authoritative post-trade calculation proves a
// participating franchise would exceed the salary cap; an unavailable calculation fails closed. Roster counts are
// projected and flagged, never a block. The calculation is the SAME one the 2-way accept uses
// (worker/src/trade_cap_authority.js), reached through the worker's own /admin/3way/compliance route so this engine
// (which runs from Discord buttons and waitUntil, with no request closures) shares it instead of copying it.
const UNAVAILABLE_MSG = "We couldn't verify the salary cap for this trade right now.";
export function unavailableCompliance(reason) {
  return {
    participants: [],
    cap: { status: "unavailable", reason, cap_dollars: null, rows: [], violations: [], message: UNAVAILABLE_MSG },
    roster: { status: "unavailable", advisory: true, rows: [], warnings: [], message: "We couldn't check the roster counts for this trade right now." },
    loaded_contracts: { status: "unavailable", max: 5, rows: [], violations: [], message: "We couldn't verify the loaded-contract count for this trade right now." },
    lineup: { status: "unavailable", advisory: true, rows: [], warnings: [], message: "We couldn't check lineup feasibility for this trade right now." },
    extension_skipped: [],
  };
}
async function complianceViaSelf(env, row) {
  if (!env.SELF) return unavailableCompliance("no_self_binding");
  const apiKey = safeStr(env.COMMISH_API_KEY);
  if (!apiKey) return unavailableCompliance("no_commish_key");
  try {
    const movements = parseMovements(row).map((m) => ({ from: padFid(m.from), to: padFid(m.to), tokens: injectCapTokens([m])[0].asset_tokens }));
    // Whatever conditional loaded-contract drops any participant has already selected for THIS
    // trade (worker/src/trade_conditional_drops.js) -- validity is re-derived fresh from live
    // data on the far side of this call, never trusted here.
    let conditionalDrops = {};
    try { conditionalDrops = await conditionalDropStoreFor(env).readAllForTrade(conditionalDropKey(row)); } catch (_) { conditionalDrops = {}; }
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
    console.error(`[3way] ${row.id}: compliance call failed: ${e?.message || e}`);
    return unavailableCompliance("call_failed");
  }
}
// Keith's ruling (2026-09-30, second pass): "Fix the D1 binding fallback now, with a test that
// proves an outbox DB failure cannot bypass or falsely satisfy the hold." These three stores
// back the execution ledger, the cap-acknowledgment store, and the conditional-drop store --
// UPS_MFL_DB is where every one of their tables actually lives (every other direct read/write in
// trade_2way.js/trade_3way.js requires env.UPS_MFL_DB, never the outbox-named bindings). The
// other names are legacy outbox bindings that happen to point at the SAME physical D1 in
// production today (wrangler.toml), but preferring them here meant a failure in a DIFFERENT,
// unrelated binding could break or falsely satisfy the drop-first hold, the ledger itself, or
// either store. UPS_MFL_DB first, unconditionally; the others are a last-resort fallback only
// for an environment that somehow never defines it.
function tradeDb(env) { return env.UPS_MFL_DB || env.TWB_OUTBOX_DB || env.TWB_DB || env.DB; }
// The execution ledger (worker/src/trade_execution.js) — one row per 3-way, keyed by the trade id.
export function ledgerFor(env) {
  const db = tradeDb(env);
  if (!db) throw new Error("no D1 binding for the execution ledger");
  return makeLedger(db);
}
// The SAME D1 binding, a separate on-demand table (worker/src/trade_cap_ack.js) -- the
// salary-cap overage acknowledgment store. Keyed by the 3-way trade's own `id` (a stable
// uuid from creation through execution, unlike a 2-way trade which has no id until MFL
// assigns one -- see trade_cap_ack.js's module doc for why 2-way instead keys by payload_hash).
export function capAckStoreFor(env) {
  const db = tradeDb(env);
  if (!db) throw new Error("no D1 binding for the cap-acknowledgment store");
  return makeCapAckStore(db);
}
const capAckKey = (row) => ({ leagueId: safeStr(row.league_id), season: safeStr(row.season), tradeKey: safeStr(row.id) });
// The SAME D1 binding, a separate on-demand table (worker/src/trade_conditional_drops.js) -- the
// loaded-contract conditional-drop selection store. Keyed the SAME way as capAckKey (the 3-way
// trade's own stable id).
export function conditionalDropStoreFor(env) {
  const db = tradeDb(env);
  if (!db) throw new Error("no D1 binding for the conditional-drop store");
  return makeConditionalDropStore(db);
}
const conditionalDropKey = (row) => ({ leagueId: safeStr(row.league_id), season: safeStr(row.season), tradeKey: safeStr(row.id) });
const lkey = (row) => ({ leagueId: safeStr(row.league_id), season: safeStr(row.season), execKey: safeStr(row.id) });
const signatureOf = (gate) => `${gate.kind}|${safeStr(gate.message)}`;

/** A cap, loaded-contract, or extension/unavailable gate that refused BEFORE any MFL write:
 * recoverable, never `failed`. Approvals stay; the row goes back to `collecting`. The
 * `blocked_cap` ledger state name is kept unchanged for backward compatibility with the
 * deployed enum/schema (worker/src/trade_execution.js) -- it now covers a salary-cap
 * overage still missing its owner's acknowledgment (Keith's ruling, 2026-09-28 -- see
 * capGate() below), a loaded-contract post-trade violation (a genuine hard block, never
 * satisfied by any acknowledgment), or an unavailable/stale-extension check; all are "the
 * post-trade math proved this deal can't go through as built right now, but the approvals
 * are still good and a fix + re-check (or, for cap, an acknowledgment + re-check) can heal
 * it" in exactly the same way. */
async function enterBlockedCap(env, row, gate, dmAllThree) {
  const violations = gate.kind === "loaded_contract_drops_required"
    ? ((gate.compliance && gate.compliance.loaded_contracts && gate.compliance.loaded_contracts.violations) || []).map((v) => ({ franchise_id: v.franchise_id, franchise_name: v.franchise_name, projected: v.projected, max: v.max, required_drops: v.required_drops, valid_drops: v.valid_drops }))
    : ((gate.compliance && gate.compliance.cap && gate.compliance.cap.violations) || []).map((v) => ({ franchise_id: v.franchise_id, franchise_name: v.franchise_name, amount_over: v.amount_over }));
  const info = { kind: gate.kind, message: safeStr(gate.message), violations, checked_at_utc: nowIso(), signature: signatureOf(gate) };
  let prev = null;
  try {
    const r = await ledgerFor(env).block(lkey(row), { kind: "three_way", actorFid: padFid(row.initiator_fid), participants: [row.initiator_fid, row.team_b_fid, row.team_c_fid].map(padFid).join(","), blockInfo: info });
    prev = r.prev;
  } catch (e) { console.error(`[3way] ${row.id}: couldn't record the cap block on the ledger: ${e?.message || e}`); }
  // back to `collecting` (conditional: only from `executing`) — the trade never goes `failed` for a cap/loaded-contract block
  await env.UPS_MFL_DB.prepare(`UPDATE ups_3way_trades SET status='collecting', failure_reason=NULL, updated_at_utc=? WHERE id=? AND status='executing'`).bind(nowIso(), row.id).run();
  const same = prev && prev.state === EXEC.BLOCKED_CAP && prev.block && prev.block.signature === info.signature;
  if (!same && dmAllThree) {
    await dmAllThree(String(gate.kind).startsWith("extension")
      ? `⏸️ The 3-way is approved by all three, but it can't run: ${gate.message} Nothing has moved. **Commish:** this needs to be cancelled and rebuilt.`
      : gate.kind === "cap_ack_required"
      ? `⏸️ The 3-way is approved by all three, but it can't run yet: ${gate.message} Nothing has moved. The affected owner needs to acknowledge this on the trade page, then use “Re-check.”`
      : gate.kind === "loaded_contract_drops_required"
      ? `⏸️ The 3-way is approved by all three, but it can't run yet: ${gate.message} Nothing has moved. The affected owner needs to select their conditional drops on the trade page, then use “Re-check.”`
      : `⏸️ The 3-way is approved by all three, but it can't run yet: ${gate.message} Nothing has moved and everyone's accept is saved. It will go through once that's fixed (use “Re-check” on the trade).`);
  }
  return info;
}

/** { ok:true, compliance } | { ok:false, kind:"loaded_contracts"|"cap_ack_required"|"unavailable"|"extension"|"extension_stale", message, compliance, cap_ack? } */
async function capGate(env, row) {
  const compliance = await complianceViaSelf(env, row);
  if (compliance.cap.status === "unavailable") return { ok: false, kind: "unavailable", message: `${UNAVAILABLE_MSG} Try again in a moment.`, compliance };
  if (compliance.loaded_contracts && compliance.loaded_contracts.status === "unavailable") return { ok: false, kind: "unavailable", message: "We couldn't verify the loaded-contract count for this trade right now. Try again in a moment.", compliance };
  const skipped = Array.isArray(compliance.extension_skipped) ? compliance.extension_skipped : [];
  if (skipped.length) {
    const reasons = skipped.map((x) => safeStr(x && x.reason));
    const unavailable = (r) => r === "extension_pricing_unavailable" || r === "failed_to_load_salaries_export" || r.startsWith("authority_unavailable");
    // a stale PRICE: the contract moved since the trade was built, so the promised extension is no longer the canonical price — it must be rebuilt
    if (reasons.includes("extension_terms_stale")) return { ok: false, kind: "extension_stale", message: "The price of a pre-trade extension in this trade no longer matches the player's current contract, so it can't go through as built. Ask the initiator to build it again.", compliance };
    // an authority we could not READ is not a verdict on the extension: recoverable (the accept is kept; a re-check retries)
    if (reasons.every(unavailable)) return { ok: false, kind: "unavailable", message: "We couldn't verify a pre-trade extension in this trade right now. Try again in a moment.", compliance };
    return { ok: false, kind: "extension", message: "A pre-trade extension in this trade is no longer allowed, so it can't go through. Ask the initiator to build it again.", compliance };
  }
  // The loaded-contract limit (PR #1135) is checked FIRST, independent of the cap acknowledgment
  // below -- a cap acknowledgment never satisfies it and vice versa. Keith's ruling (2026-09-25):
  // a franchise projected over 5 may still trade once its OWN owner has validly selected enough
  // of its OWN loaded-contract players to drop (worker/src/trade_conditional_drops.js) -- BUT
  // (Keith's ruling, 2026-09-29, reviewing the first PR): a valid, SATISFIED selection
  // ("needs_drops") is NOT the same thing as an EXECUTED drop, and must not itself unblock a
  // real 3-way EXECUTION -- no code anywhere calls MFL to actually drop a player yet (see
  // docs/LOADED_CONTRACT_DROP_EXECUTION_DESIGN.md). loadedContractsPermitsWrite() is the ONE
  // gate for this, covering "blocked" (unsatisfied) AND "needs_drops" (satisfied but
  // unexecuted) identically until a real executor is built and separately reviewed/approved.
  if (compliance.loaded_contracts && !loadedContractsPermitsWrite(compliance.loaded_contracts.status)) {
    const waiting = (compliance.loaded_contracts.drop_requirements || []).filter((d) => !d.satisfied).map((d) => d.franchise_name || d.franchise_id).join(", ");
    const heldMsg = compliance.loaded_contracts.status === "needs_drops"
      ? `${safeStr(compliance.loaded_contracts.message)} Conditional-drop execution isn't built yet, so this trade stays held until it is.`
      : `${safeStr(compliance.loaded_contracts.message)}${waiting ? ` Waiting on ${waiting} to select conditional drops.` : ""}`;
    return { ok: false, kind: "loaded_contract_drops_required", message: heldMsg, compliance, drop_requirements: compliance.loaded_contracts.drop_requirements || [] };
  }
  // ACKNOWLEDGE, DON'T BLOCK (Keith's ruling, 2026-09-28, separate PR): a proven cap overage
  // never itself refuses the trade -- it requires each AFFECTED franchise's own owner to have
  // explicitly acknowledged the exact current projected figure (see worker/src/trade_cap_ack.js
  // for how "current" is enforced -- a stale acknowledgment from before the numbers changed does
  // not count). Each participant is tracked separately, by franchise, matching "for a three-way
  // trade, handle each affected franchise separately."
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
function rosterNote(compliance) {
  const r = compliance && compliance.roster;
  if (!r) return "";
  if (r.status === "warn") return `\n⚠️ Heads-up: ${r.warnings.map((w) => w.message).join(" ")} (Advisory only — MFL decides when the trade is processed.)`;
  if (r.status === "unavailable") return "\nℹ️ We couldn't check roster counts right now.";
  return "";
}

// ─────────────────────────── message builders ──────────────────────────────
// What a team gives + gets across the free-form movements, each line naming the
// other team involved (so "MHJ → LA Looks", "Caleb Williams ← Sex Manther").
function movementSummaries(row, teamFid) {
  const movements = parseLegs(row);
  const t = padFid(teamFid);
  const gives = [], gets = [];
  for (const m of movements) {
    const from = padFid(m?.from), to = padFid(m?.to);
    const toks = Array.isArray(m?.asset_tokens) ? m.asset_tokens : [];
    const capK = safeInt(m?.cap_k, 0);
    const sum = safeStr(m?.summary) || (toks.length ? `${toks.length} asset(s)` : "");
    if (from === t) {
      if (sum) gives.push(`${sum} → ${teamLabel(row, to)}`);
      if (capK > 0) gives.push(`💰 $${capK}K cap → ${teamLabel(row, to)}`);
    }
    if (to === t) {
      if (sum) gets.push(`${sum} ← ${teamLabel(row, from)}`);
      if (capK > 0) gets.push(`💰 $${capK}K cap ← ${teamLabel(row, from)}`);
    }
  }
  return { gives, gets };
}
function buildPartnerButtons(id) {
  return [{ type: 1, components: [
    { type: 2, style: 3, label: "✅ Accept", custom_id: `tr3:accept:${id}` },
    { type: 2, style: 4, label: "❌ Decline", custom_id: `tr3:decline:${id}` },
  ] }];
}
function partnerDmPayload(row, teamFid) {
  const A = safeStr(row.initiator_name) || "the commish";
  const me = movementSummaries(row, teamFid);
  const bullet = (arr) => (arr.length ? arr.map((x) => `• ${x}`).join("\n") : "• —");
  const lines = [
    `🔀 **${A} has roped you into a 3-way trade.**`,
    `_If you've never had a 3-way, now's your chance — if you have, welcome back._`,
    ``,
    `**You give:**`,
    bullet(me.gives),
    `**You get:**`,
    bullet(me.gets),
  ];
  const exts = parseExtReqs(row);
  if (exts.length) {
    lines.push(``, `✨ **Pre-trade extensions in this deal:**`);
    exts.forEach((e) => {
      const term = safeStr(e.extension_term) === "2YR" ? "+2 yr" : "+1 yr";
      const nm = safeStr(e.player_name) || ("Player " + safeStr(e.player_id));
      lines.push(`• ${nm} (${term}) — ${teamLabel(row, e.from_franchise_id)} extends → ${teamLabel(row, e.to_franchise_id)}`);
    });
  }
  const note = safeStr(row.notes);
  if (note) lines.push(``, `💬 _${note.slice(0, 300)}_`);
  lines.push(``, `All three have to be in for it to go through. Tap **Accept** or **Decline** — the other two get pinged either way.`);
  return { content: lines.join("\n").slice(0, 1990), embeds: [{ image: { url: GIF_URL } }], components: buildPartnerButtons(row.id) };
}

// ───────────────────────────── data helpers ────────────────────────────────
function parseLegs(row) { try { const v = JSON.parse(row.legs_json || "[]"); return Array.isArray(v) ? v : []; } catch (_) { return []; } }
// Only movements that actually move something.
function parseMovements(row) { return parseLegs(row).filter((m) => m && Array.isArray(m.asset_tokens) && m.asset_tokens.length); }
function parseExtReqs(row) { try { const v = JSON.parse(row.extension_requests_json || "[]"); return Array.isArray(v) ? v : []; } catch (_) { return []; } }
// Apply this deal's pre-trade extensions AFTER its legs land. Calls the worker's
// own /admin/3way/apply-extensions (which reuses applyExtensionsFromPayload — a
// cookie-only salaries import the APIKEY trade path can't do) via the SELF service
// binding. Best-effort: the trade already executed by the time we get here.
async function applyExtensionsViaSelf(env, row, tradeIds) {
  const extReqs = parseExtReqs(row);
  if (!extReqs.length) return { ok: true, applied: 0, none: true };
  if (!env.SELF) { console.error(`[3way] ${row.id}: ${extReqs.length} extension(s) but env.SELF missing — cannot apply.`); return { ok: false, error: "no_self_binding" }; }
  const apiKey = safeStr(env.COMMISH_API_KEY);
  if (!apiKey) { console.error(`[3way] ${row.id}: extensions need COMMISH_API_KEY (unset).`); return { ok: false, error: "no_commish_key" }; }
  try {
    const u = `https://self.invalid/admin/3way/apply-extensions?L=${safeStr(row.league_id)}&YEAR=${safeStr(row.season)}&APIKEY=${encodeURIComponent(apiKey)}`;
    const r = await env.SELF.fetch(u, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ league_id: safeStr(row.league_id), season: safeStr(row.season), extension_requests: extReqs, trade_id: (tradeIds || []).join(",") }),
    });
    const j = await r.json().catch(() => null);
    return j || { ok: false, error: `apply HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}
function pairKey(x, y) { return [padFid(x), padFid(y)].sort().join("|"); }
// Decompose free-form movements into pairwise 2-party trades. For each team-pair
// {a,b} (a<b by fid), a gives its a->b assets and b gives its b->a assets — a
// single MFL trade (possibly lopsided if only one direction has assets).
function pairwiseTrades(movements) {
  const pairs = {};
  for (const m of movements) {
    const from = padFid(m?.from), to = padFid(m?.to);
    const toks = Array.isArray(m?.asset_tokens) ? m.asset_tokens : [];
    if (!from || !to || from === to || !toks.length) continue;
    const key = pairKey(from, to); const [a, b] = key.split("|");
    if (!pairs[key]) pairs[key] = { a, b, aToB: [], bToA: [] };
    if (from === a) pairs[key].aToB.push(...toks); else pairs[key].bToA.push(...toks);
  }
  return Object.values(pairs);
}
// Detect a clean 3-cycle (exactly A->B, B->C, C->A) so we can use the proven
// 2-trade hub path instead of three lopsided pairwise trades. Returns {X,Y,Z}
// (the A->B, B->C, C->A token arrays) or null.
function asCycle(movements, A, B, C) {
  if (movements.length !== 3) return null;
  const edge = {};
  for (const m of movements) edge[`${padFid(m.from)}>${padFid(m.to)}`] = (m.asset_tokens || []);
  const X = edge[`${A}>${B}`], Y = edge[`${B}>${C}`], Z = edge[`${C}>${A}`];
  if (X && Y && Z && Object.keys(edge).length === 3) return { X, Y, Z };
  return null;
}
async function getRow(env, id) {
  try { return await env.UPS_MFL_DB.prepare(`SELECT * FROM ups_3way_trades WHERE id=?`).bind(safeStr(id)).first(); }
  catch (e) { console.error(`[3way] getRow failed: ${e?.message || e}`); return null; }
}
function teamLabel(row, fid) {
  const f = padFid(fid);
  if (f === padFid(row.initiator_fid)) return safeStr(row.initiator_name) || f;
  if (f === padFid(row.team_b_fid)) return safeStr(row.team_b_name) || f;
  if (f === padFid(row.team_c_fid)) return safeStr(row.team_c_name) || f;
  return f;
}

// ───────────────────────── create a 3-way trade ────────────────────────────
// spec: { leagueId, season, initiator:{fid,name}, teamB:{fid,name}, teamC:{fid,name},
//         legs:[{from,to,asset_tokens[],cap_k,summary}] (ring order A->B, B->C, C->A) }
export async function create3WayTrade(env, ctx, spec) {
  try {
    if (!(await enabled(env))) return { ok: false, error: "3way_disabled" };
    if (!env.UPS_MFL_DB) return { ok: false, error: "no_db" };
    const leagueId = safeStr(spec?.leagueId), season = safeStr(spec?.season);
    const A = padFid(spec?.initiator?.fid), B = padFid(spec?.teamB?.fid), C = padFid(spec?.teamC?.fid);
    if (!leagueId || !season || !A || !B || !C) return { ok: false, error: "missing_fields" };
    if (A === B || B === C || A === C) return { ok: false, error: "teams_must_be_distinct" };
    // ---- 🔒 PER-FRANCHISE DROP-FIRST HOLD (§8.6, Keith 2026-09-30) --------------------
    // A franchise with an unresolved 2-way drop-first sequence must not be added to a brand
    // new 3-way deal either -- its true compliance state is a known, bounded uncertainty.
    try {
      for (const fid of [A, B, C]) {
        if (await franchiseHasUnresolvedDropSequence(env, leagueId, season, fid)) {
          return { ok: false, error: "franchise_has_unresolved_drop_sequence", franchise_id: fid };
        }
      }
    } catch (e) {
      return { ok: false, error: "hold_check_unavailable" };
    }
    // Free-form movements ({from, to, asset_tokens}); `legs` accepted as a
    // back-compat alias. Every from/to must be one of the three teams.
    const movements = Array.isArray(spec?.movements) ? spec.movements : (Array.isArray(spec?.legs) ? spec.legs : []);
    if (!movements.length) return { ok: false, error: "no_movements" };
    const fidSet = new Set([A, B, C]);
    for (const m of movements) {
      const from = padFid(m?.from), to = padFid(m?.to);
      if (!fidSet.has(from) || !fidSet.has(to) || from === to) return { ok: false, error: "bad_movement" };
    }
    if (!movements.some((m) => Array.isArray(m?.asset_tokens) && m.asset_tokens.length)) return { ok: false, error: "no_assets" };
    // Normalize cap money (cap_k ≥ 0) on each movement, then §A6-validate: the cap
    // a giver attaches to a destination ≤ floor(its non-taxi salary sent there /
    // 2000). The builders clamp client-side; this is the bypass backstop. Best-
    // effort — if the rosters fetch fails we trust the client clamp.
    for (const m of movements) m.cap_k = Math.max(0, safeInt(m?.cap_k, 0));
    if (movements.some((m) => m.cap_k > 0)) {
      const sm = await fetchRosterSalaryMap(env, leagueId, season);
      if (sm.ok) {
        for (const m of movements) {
          if (m.cap_k <= 0) continue;
          const maxK = movementCapMaxK(m, sm.salaryByFp, sm.taxiByFp);
          if (m.cap_k > maxK) {
            return { ok: false, code: "TRADE_CAP_MONEY_50PCT",
              error: `cap money ${m.cap_k}K from ${padFid(m.from)}→${padFid(m.to)} exceeds the §A6 max (${maxK}K = 50% of the non-taxi salary sent).` };
          }
        }
      } else {
        console.warn(`[3way] §A6 cap check skipped (rosters fetch failed): ${sm.error}`);
      }
    }
    const notes = safeStr(spec?.notes).slice(0, 500);
    // Pre-trade extensions (canon §C4): a player moving in this deal can be
    // extended by the franchise giving it up. Keep only well-formed requests whose
    // from/to are participants; the worker re-derives + re-validates the contract
    // from preview_contract_info_string at apply time (its own safety net).
    const extReqs = (Array.isArray(spec?.extension_requests) ? spec.extension_requests : [])
      .filter((e) => e && safeStr(e.player_id) && safeStr(e.preview_contract_info_string)
        && fidSet.has(padFid(e.from_franchise_id)) && fidSet.has(padFid(e.to_franchise_id)))
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
    // Allowlist: every participant must be allowed during the test rollout.
    if (![A, B, C].every((f) => franchiseAllowed(env, f))) return { ok: false, error: "not_in_allowlist" };

    const [aIds, bIds, cIds] = await Promise.all([resolveDiscordUserIds(env, A), resolveDiscordUserIds(env, B), resolveDiscordUserIds(env, C)]);
    const id = newId();
    await env.UPS_MFL_DB.prepare(
      `INSERT INTO ups_3way_trades
        (id, league_id, season, status, initiator_fid, team_b_fid, team_c_fid,
         initiator_name, team_b_name, team_c_name, legs_json, notes, extension_requests_json,
         team_b_state, team_c_state, initiator_discord_ids, team_b_discord_ids, team_c_discord_ids,
         created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, 'collecting', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', ?, ?, ?, ?, ?)`
    ).bind(id, leagueId, season, A, B, C,
      safeStr(spec?.initiator?.name), safeStr(spec?.teamB?.name), safeStr(spec?.teamC?.name), JSON.stringify(movements), notes, JSON.stringify(extReqs),
      aIds.join(","), bIds.join(","), cIds.join(","), nowIso(), nowIso()).run();

    const row = await getRow(env, id);
    // DM both partners (B, C) the intro + GIF + Accept/Decline.
    const dm = async (csv, fid) => { const r = await dmAll(env, csv, partnerDmPayload(row, fid)); console.log(`[3way] invite DM to ${fid}: ${r.sent} account(s) (trade ${id})`); };
    if (ctx?.waitUntil) { ctx.waitUntil(dm(bIds.join(","), B)); ctx.waitUntil(dm(cIds.join(","), C)); }
    else { await dm(bIds.join(","), B); await dm(cIds.join(","), C); }
    console.log(`[3way] created ${id}: teams ${A},${B},${C} · ${movements.length} movement(s)`);
    return { ok: true, id };
  } catch (e) {
    console.error(`[3way] create failed: ${e?.message || e}`);
    return { ok: false, error: e?.message || String(e) };
  }
}

// ──────────────── read: canonical trade + outbox list ─────────────────────────
// Every surface (mobile, desktop) renders the SAME canonical object built by
// trade_3way_model.js#buildCanonical3Way. `viewer` is the server-resolved actor
// ({ fid, isCommish, sessionFid }) — the engine never trusts a caller-supplied
// franchise id. `deps` are optional, fail-soft enrichers supplied by the HTTP
// layer: franchiseNames({leagueId, season}) and playersByIds({leagueId, season, ids}).
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
// A trade from another league OR another season is indistinguishable from a missing one:
// the caller's identity was proven for exactly one (league, season).
function inScope(row, viewer) {
  if (!viewer) return false;
  return safeStr(row.league_id) === safeStr(viewer.leagueId) && safeStr(row.season) === safeStr(viewer.season);
}
async function getRowStrict(env, id) {
  // Unlike getRow() this THROWS on a D1 failure so callers can tell "not found"
  // (404) from "database unavailable" (503) instead of collapsing both to null.
  return await env.UPS_MFL_DB.prepare(`SELECT * FROM ups_3way_trades WHERE id=?`).bind(safeStr(id)).first();
}
async function enrich(deps, rows) {
  let names = null, players = null;
  if (!deps || !rows.length) return { names, players };
  const leagueId = safeStr(rows[0].league_id), season = safeStr(rows[0].season);
  try { if (deps.franchiseNames) names = await deps.franchiseNames({ leagueId, season }); }
  catch (e) { console.warn(`[3way] franchise name lookup failed (using stored names): ${e?.message || e}`); }
  try {
    if (deps.playersByIds) {
      const ids = new Set();
      for (const r of rows) for (const m of parseLegs(r)) for (const t of (m && m.asset_tokens) || []) { const x = /^P_(\d+)$/.exec(safeStr(t)); if (x) ids.add(x[1]); }
      if (ids.size) players = await deps.playersByIds({ leagueId, season, ids: [...ids] });
    }
  } catch (e) { console.warn(`[3way] player lookup failed (labels fall back to ids): ${e?.message || e}`); }
  return { names, players };
}
const dbDown = (e) => { console.error(`[3way] db error: ${e?.message || e}`); return { ok: false, http: 503, code: "unavailable", message: "Trades are temporarily unavailable. Try again in a moment." }; };

export async function get3WayTrade(env, id, viewer, deps) {
  if (!env.UPS_MFL_DB) return dbDown(new Error("no_db"));
  const tid = safeStr(id);
  if (!ID_RE.test(tid)) return { ok: false, http: 400, code: "bad_request", message: "That isn't a valid trade id." };
  let row;
  try { row = await getRowStrict(env, tid); } catch (e) { return dbDown(e); }
  // A row from another league is indistinguishable from a missing one.
  if (!row || !inScope(row, viewer)) {
    return { ok: false, http: 404, code: "not_found", message: "This 3-way trade doesn't exist." };
  }
  if (!canView(row, viewer)) return { ok: false, http: 403, code: "forbidden", message: "You aren't part of this trade." };
  const { names, players } = await enrich(deps, [row]);
  let execution = null; try { execution = await ledgerFor(env).read(lkey(row)); } catch (_) { execution = null; }
  const trade = buildCanonical3Way(row, { names, players, viewer, execution });
  // A live trade also carries its projected salary-cap (hard rule) and roster-count (advisory) picture so every
  // surface can show it BEFORE the partners accept. Fail-soft: an unavailable calculation is shown as unavailable.
  if (deps && typeof deps.compliance === "function" && ["collecting", "executing"].includes(safeStr(row.status))) {
    try {
      const movements = movementsForCompliance(parseMovements(row));
      let storedDropsForDetail = {}; try { storedDropsForDetail = await conditionalDropStoreFor(env).readAllForTrade(conditionalDropKey(row)); } catch (_) { storedDropsForDetail = {}; }
      trade.compliance = await deps.compliance({ leagueId: safeStr(row.league_id), season: safeStr(row.season), movements, extensionRequests: parseExtReqs(row), offerCreatedAtUtc: safeStr(row.created_at_utc), conditionalDrops: storedDropsForDetail });
    } catch (e) {
      console.warn(`[3way] compliance lookup failed: ${e?.message || e}`);
      trade.compliance = unavailableCompliance("lookup_failed");
    }
    // A blocked trade's `execution.block` is a SNAPSHOT from whenever it was recorded
    // (worker/src/trade_3way.js's enterBlockedCap) -- it does not move as owners act. Fold in
    // the CURRENT acknowledgment / drop-selection picture here so the detail view (and
    // "Re-check") show who still needs to act without requiring a re-check to see it change.
    if (trade.execution && trade.execution.blocked && trade.execution.block && trade.compliance && trade.compliance.cap && trade.compliance.cap.status === "blocked") {
      try {
        const acks = await capAckStoreFor(env).readAllForTrade(capAckKey(row));
        const ackEval = evaluateCapAcknowledgment({ violations: trade.compliance.cap.violations, tradeKey: safeStr(row.id), acks });
        trade.execution.block.cap_ack = ackEval.perFranchise;
      } catch (e) { console.warn(`[3way] cap-ack lookup failed (block shown without it): ${e?.message || e}`); }
    }
    // Also refreshes for "needs_drops" (satisfied but not yet -- and not yet ABLE to be --
    // executed), not just "blocked", so the detail view keeps reflecting a completed selection
    // instead of going stale the moment everyone finishes picking (Keith's ruling, 2026-09-29).
    if (trade.execution && trade.execution.blocked && trade.execution.block && trade.compliance && trade.compliance.loaded_contracts && !loadedContractsPermitsWrite(trade.compliance.loaded_contracts.status)) {
      trade.execution.block.drop_requirements = trade.compliance.loaded_contracts.drop_requirements || [];
    }
  }
  return { ok: true, trade };
}

export async function list3WayForFranchise(env, leagueId, fid, opts) {
  opts = opts || {};
  if (!env.UPS_MFL_DB) return { ok: false, http: 503, code: "unavailable", message: "Trades are temporarily unavailable. Try again in a moment." };
  const f = padFid(fid);
  if (!f) return { ok: false, http: 400, code: "bad_request", message: "Missing franchise." };
  const statusClause = opts.includeTerminal ? "" : "AND status IN ('collecting','executing')";
  let rows;
  try {
    const { results } = await env.UPS_MFL_DB.prepare(
      `SELECT * FROM ups_3way_trades
       WHERE league_id = ? AND season = ? ${statusClause}
         AND (initiator_fid = ? OR team_b_fid = ? OR team_c_fid = ?)
       ORDER BY created_at_utc DESC LIMIT 25`
    ).bind(safeStr(leagueId), safeStr(opts.season || (opts.viewer && opts.viewer.season)), f, f, f).all();
    rows = results || [];
  } catch (e) { return dbDown(e); }
  const { names, players } = await enrich(opts.deps, rows);
  const viewer = opts.viewer || null;
  let exec = {}; try { exec = await ledgerFor(env).readMany(safeStr(leagueId), safeStr(opts.season || (opts.viewer && opts.viewer.season)), rows.map((r) => r.id)); } catch (_) { exec = {}; }
  return { ok: true, trades: rows.map((row) => buildCanonical3Way(row, { names, players, viewer, execution: exec[row.id] || null })) };
}

// ──────────────── cancel a pending 3-way (initiator or commissioner) ─────────────
// Server-authoritative: the actor comes from the proven MFL session (see
// trade_3way_http.js), never from the request body. Atomic (conditional UPDATE),
// idempotent, and returns the canonical post-cancel trade. Notifies partners
// exactly once — only the request whose UPDATE actually changed the row.
export async function cancel3WayTrade(env, ctx, id, viewer, deps) {
  if (!env.UPS_MFL_DB) return dbDown(new Error("no_db"));
  const tid = safeStr(id);
  if (!ID_RE.test(tid)) return { ok: false, http: 400, code: "bad_request", message: "That isn't a valid trade id." };
  let row;
  try { row = await getRowStrict(env, tid); } catch (e) { return dbDown(e); }
  if (!row || !inScope(row, viewer)) {
    return { ok: false, http: 404, code: "not_found", message: "This 3-way trade doesn't exist." };
  }
  const decision = decideCancel(row, viewer);
  const respond = async (extra) => {
    // Never echo a trade back to someone who isn't allowed to see it (a failed
    // cancel by a non-participant must not double as a read of the deal).
    if (!canView(row, viewer)) return { ...extra };
    const { names, players } = await enrich(deps, [row]);
    return { ...extra, trade: buildCanonical3Way(row, { names, players, viewer }) };
  };
  if (!decision.ok) return await respond({ ok: false, http: decision.http, code: decision.code, message: decision.message });
  if (decision.idempotent) return await respond({ ok: true, http: 200, code: "already_cancelled", already: true });

  const actorFid = padFid(viewer.fid);
  // Only the initiator, through their OWN session, can reach here (decideCancel). A commissioner's
  // cancel is the separate administrative action (adminCancel3WayTrade).
  const reason = "cancelled_by_initiator";
  let res;
  try {
    res = await env.UPS_MFL_DB.prepare(
      `UPDATE ups_3way_trades SET status='cancelled', failure_reason=?, updated_at_utc=? WHERE id=? AND status='collecting'`
    ).bind(reason, nowIso(), tid).run();
  } catch (e) { return dbDown(e); }
  const changed = Number(res?.meta?.changes ?? res?.changes ?? 0);
  try { row = await getRowStrict(env, tid); } catch (e) { return dbDown(e); }
  if (!changed) {
    // Lost a race (accepted/cancelled between our read and write). Report truthfully.
    if (safeStr(row.status) === "cancelled") return await respond({ ok: true, http: 200, code: "already_cancelled", already: true });
    return await respond({ ok: false, http: 409, code: `cannot_cancel_${safeStr(row.status)}`, message: decideCancel(row, viewer).message || "This trade can't be called off in its current state." });
  }
  const who = teamLabel(row, row.initiator_fid) || "The initiator";
  const alert = { content: `❌ **${who}** called off the 3-way trade.`.slice(0, 1990) };
  const fire = async () => {
    await dmAll(env, row.team_b_discord_ids, alert);
    await dmAll(env, row.team_c_discord_ids, alert);
  };
  if (ctx?.waitUntil) ctx.waitUntil(fire()); else await fire();
  console.log(`[3way] ${tid} cancelled by initiator ${actorFid}`);
  return await respond({ ok: true, http: 200, code: "cancelled" });
}

// ──────────────── commissioner ADMINISTRATIVE cancel (RULING, Keith 2026-09-25) ─────────────────
// A distinct action — not owner impersonation, not "acting as" the initiator. The caller (index.js
// /admin/3way/cancel) has already proven the explicit COMMISH_API_KEY; this enforces the STATE rules
// (decideAdminCancel), writes the audit trail atomically with the state change, tells all three teams
// exactly once, and NEVER touches MFL (no trade proposal, accept, or execution of any kind).
export async function adminCancel3WayTrade(env, ctx, { id, leagueId, reason }, deps) {
  if (!env.UPS_MFL_DB) return dbDown(new Error("no_db"));
  const tid = safeStr(id);
  if (!ID_RE.test(tid)) return { ok: false, http: 400, code: "bad_request", message: "That isn't a valid trade id." };
  let row;
  try { row = await getRowStrict(env, tid); } catch (e) { return dbDown(e); }
  if (!row || safeStr(row.league_id) !== safeStr(leagueId)) {
    return { ok: false, http: 404, code: "not_found", message: "This 3-way trade doesn't exist." };
  }
  const viewer = { fid: "", sessionFid: "", isCommish: true, via: "apikey", leagueId: safeStr(row.league_id), season: safeStr(row.season) };
  const show = async (extra) => {
    const { names, players } = await enrich(deps, [row]);
    return { ...extra, basis: ADMIN_CANCEL_BASIS, trade: buildCanonical3Way(row, { names, players, viewer }) };
  };
  const audit = () => ({ cancelled_by: safeStr(row.cancelled_by) || "commissioner_admin", cancelled_at_utc: safeStr(row.cancelled_at_utc), reason: safeStr(row.cancel_reason) });
  const decision = decideAdminCancel(row, reason);
  if (!decision.ok) return { ok: false, http: decision.http, code: decision.code, message: decision.message, ...(safeStr(row.status) !== "" && decision.http === 409 ? { status: safeStr(row.status) } : {}) };
  if (decision.idempotent) return await show({ ok: true, http: 200, code: "already_cancelled", already: true, ...audit() });

  const at = nowIso();
  let res;
  try {
    res = await env.UPS_MFL_DB.prepare(
      `UPDATE ups_3way_trades
          SET status='cancelled', failure_reason=?, cancel_basis=?, cancelled_by=?, cancel_reason=?, cancelled_at_utc=?, updated_at_utc=?
        WHERE id=? AND status='collecting'`
    ).bind(ADMIN_CANCEL_BASIS, ADMIN_CANCEL_BASIS, "commissioner_admin", decision.reason, at, at, tid).run();
  } catch (e) {
    if (/no such column/i.test(safeStr(e && e.message))) {
      console.error(`[3way] admin cancel needs migration 0159: ${e.message}`);
      return { ok: false, http: 503, code: "migration_required", message: "The administrative cancel needs the latest database update (migration 0159) before it can record who cancelled and why. Nothing was changed." };
    }
    return dbDown(e);
  }
  const changed = Number(res?.meta?.changes ?? res?.changes ?? 0);
  try { row = await getRowStrict(env, tid); } catch (e) { return dbDown(e); }
  if (!changed) {
    // Lost a race (accepted / cancelled between our read and write). Report what is true now.
    const again = decideAdminCancel(row, decision.reason);
    if (again.ok && again.idempotent) return await show({ ok: true, http: 200, code: "already_cancelled", already: true, ...audit() });
    return { ok: false, http: again.http || 409, code: again.code || `cannot_cancel_${safeStr(row.status)}`, message: again.message || "This trade can't be called off in its current state." };
  }
  // Tell ALL THREE teams, once — only the request whose UPDATE changed the row gets here.
  const alert = { content: `❌ The commissioner called off the 3-way trade. Reason: ${decision.reason}`.slice(0, 1990) };
  const fire = async () => {
    for (const csv of [row.initiator_discord_ids, row.team_b_discord_ids, row.team_c_discord_ids]) await dmAll(env, csv, alert);
  };
  if (ctx?.waitUntil) ctx.waitUntil(fire()); else await fire();
  console.log(`[3way] ${tid} cancelled ADMINISTRATIVELY by the commissioner (reason on file)`);
  return await show({ ok: true, http: 200, code: "cancelled", already: false, ...audit() });
}

// ─────────────────── accept / decline (in-Discord button) ───────────────────
export async function handle3WayButton(interaction, env, ctx) {
  const customId = safeStr(interaction?.data?.custom_id || "");
  const [pfx, action, id] = customId.split(":");
  if (pfx !== "tr3" || !action || !id) return ephemeral("Unknown button.");
  if (!env.UPS_MFL_DB) return ephemeral("This trade isn't available anymore.");
  const row = await getRow(env, id);
  if (!row) return ephemeral("This 3-way trade no longer exists.");
  if (safeStr(row.status) !== "collecting") return ephemeral(`This 3-way trade is already ${row.status}.`);

  const caller = digits(callerId(interaction));
  const isB = String(row.team_b_discord_ids || "").split(",").map(digits).includes(caller);
  const isC = String(row.team_c_discord_ids || "").split(",").map(digits).includes(caller);
  if (!isB && !isC) return ephemeral("Only the two partners can respond to this trade.");
  const myFid = isB ? padFid(row.team_b_fid) : padFid(row.team_c_fid);
  const myCol = isB ? "team_b_state" : "team_c_state";
  const myState = safeStr(isB ? row.team_b_state : row.team_c_state);

  if (action === "decline") {
    // Guarded on status='collecting' so a decline can't overwrite a trade that
    // was cancelled/accepted a moment ago (read-then-write race).
    const dres = await env.UPS_MFL_DB.prepare(`UPDATE ups_3way_trades SET ${myCol}='declined', status='cancelled', failure_reason=?, updated_at_utc=? WHERE id=? AND status='collecting'`).bind(`declined_by_${myFid}`, nowIso(), id).run();
    if (!Number(dres?.meta?.changes ?? dres?.changes ?? 0)) {
      const cur = await getRow(env, id);
      return ephemeral(`This 3-way trade is already ${safeStr(cur?.status) || "closed"}.`);
    }
    const who = teamLabel(row, myFid);
    const alert = { content: `❌ **${who}** declined the 3-way trade — it's off.`.slice(0, 1990) };
    const others = [row.initiator_discord_ids, row.team_b_discord_ids, row.team_c_discord_ids].filter((c, i) => {
      const fids = [padFid(row.initiator_fid), padFid(row.team_b_fid), padFid(row.team_c_fid)];
      return fids[i] !== myFid;
    });
    const fire = async () => { for (const c of others) await dmAll(env, c, alert); };
    if (ctx?.waitUntil) ctx.waitUntil(fire()); else await fire();
    return ephemeral("Declined — I let the other two know. It's off.");
  }

  if (action !== "accept") return ephemeral("Button not recognized.");
  if (myState === "accepted") return ephemeral("You're already in — waiting on the other team.");

  // ---- 🔒 PER-FRANCHISE DROP-FIRST HOLD (§8.6, Keith's ruling 2026-09-30, corrected
  // 2026-09-30 second pass) -----------------------------------------------------------
  // Checks ALL THREE participants, not just the responding party. Keith's correction: "If
  // that participant is part of the proposed trade, it must block; an unrelated franchise
  // should not." The earlier version of this check scoped itself to `myFid` alone, reasoning
  // execute3Way's own all-three check was a sufficient backstop once everyone was in -- but
  // that let TWO of three teams record real consent on a deal whose third participant's true
  // compliance state was already a known, bounded uncertainty, deferring the refusal to
  // execution time instead of catching it here, at the first accept. Mirrors create3WayTrade's
  // and execute3Way's own identical [A, B, C] loop exactly -- an UNRELATED franchise (never one
  // of this trade's own three teams) is never checked and never blocks anything.
  try {
    for (const fid of [padFid(row.initiator_fid), padFid(row.team_b_fid), padFid(row.team_c_fid)]) {
      if (await franchiseHasUnresolvedDropSequence(env, safeStr(row.league_id), safeStr(row.season), fid)) {
        return ephemeral("One of the teams in this trade has another deal still being untangled by the commissioner — this can't be accepted until that resolves.");
      }
    }
  } catch (e) {
    return ephemeral("Couldn't confirm it's safe to accept this right now. Try again in a moment.");
  }

  // Salary cap: recomputed NOW from live MFL data, and REPORTED. Consent is recorded either way (a partner's accept is preserved, never
  // discarded because someone else is over the cap); what the cap blocks is EXECUTION — enforced again, freshly, when everyone is in.
  const gate = await capGate(env, row);
  // A stale pre-trade EXTENSION is not a wait-it-out problem (the contract moved on / the window closed): a partner is never asked to consent to
  // a trade that can no longer run as built. (If it goes stale AFTER both accepted, execution blocks recoverably — see enterBlockedCap.)
  if (!gate.ok && String(gate.kind).startsWith("extension")) return ephemeral(`${gate.message} Your accept wasn't recorded and nothing was changed.`);
  const heads = gate.ok ? rosterNote(gate.compliance) : `\n⚠️ ${gate.message} This can't run until that's resolved — your accept is saved and nothing has moved.`;

  const ares =await env.UPS_MFL_DB.prepare(`UPDATE ups_3way_trades SET ${myCol}='accepted', updated_at_utc=? WHERE id=? AND status='collecting'`).bind(nowIso(), id).run();
  if (!Number(ares?.meta?.changes ?? ares?.changes ?? 0)) {
    const cur = await getRow(env, id);
    return ephemeral(`This 3-way trade is already ${safeStr(cur?.status) || "closed"}.`);
  }
  const fresh = await getRow(env, id);
  const bothIn = safeStr(fresh.team_b_state) === "accepted" && safeStr(fresh.team_c_state) === "accepted";

  // Alert the other two participants that this team is in.
  const who = teamLabel(fresh, myFid);
  const waitingFid = isB ? padFid(fresh.team_c_fid) : padFid(fresh.team_b_fid);
  const waitingState = isB ? safeStr(fresh.team_c_state) : safeStr(fresh.team_b_state);
  const msg = bothIn
    ? `✅ **${who}** accepted — all three are in! Processing the trade now.`
    : `✅ **${who}** accepted the 3-way. Still waiting on **${teamLabel(fresh, waitingFid)}**.`;
  const targets = [fresh.initiator_discord_ids];
  if (!isB) targets.push(fresh.team_b_discord_ids);
  if (!isC) targets.push(fresh.team_c_discord_ids);
  const fire = async () => { for (const c of targets) await dmAll(env, c, { content: msg.slice(0, 1990) }); };
  if (ctx?.waitUntil) ctx.waitUntil(fire()); else await fire();

  if (bothIn) {
    // Only the request whose conditional UPDATE actually flips collecting ->
    // executing runs the legs. Two partners accepting in the same instant, or
    // an initiator cancel racing the second accept, can no longer double-execute
    // live MFL trades or resurrect a cancelled one.
    const eres = await env.UPS_MFL_DB.prepare(`UPDATE ups_3way_trades SET status='executing', updated_at_utc=? WHERE id=? AND status='collecting'`).bind(nowIso(), id).run();
    if (!Number(eres?.meta?.changes ?? eres?.changes ?? 0)) {
      const cur = await getRow(env, id);
      return ephemeral(cur && safeStr(cur.status) === "executing"
        ? "You're in — that's everyone! The trade is already being processed."
        : `This 3-way trade is already ${safeStr(cur?.status) || "closed"}.`);
    }
    if (ctx?.waitUntil) ctx.waitUntil(execute3Way(env, id)); else await execute3Way(env, id);
    return ephemeral(gate.ok
      ? `You're in — that's everyone! I'm processing the trade now; you'll get a confirmation shortly.${heads}`
      : `You're in — that's everyone.${heads}`);
  }
  return ephemeral(`You're in. Waiting on ${teamLabel(fresh, waitingFid)} to accept.${heads}`);
}

// Did this leg (a commissioner-run 2-party trade) actually execute in MFL? Read from MFL's trade ledger — never assumed from a response.
async function legExecuted(env, leagueId, year, leg, row) {
  try {
    const u = `https://www48.myfantasyleague.com/${year}/export?TYPE=transactions&L=${leagueId}&TRANS_TYPE=TRADE&APIKEY=${encodeURIComponent(safeStr(env.MFL_APIKEY))}&JSON=1`;
    const r = await fetch(u, { headers: { "User-Agent": "upsmflproduction-worker", Accept: "application/json" } });
    const j = await r.json().catch(() => null);
    if (!j) return null;
    const since = Math.floor(Date.parse(safeStr(row.updated_at_utc) || safeStr(row.created_at_utc)) / 1000) - 3600;
    return findExecutedTrade(j, { from: leg.fromFid, to: leg.toFid, give: (leg.give || []).map((x) => toMflAsset(x)), receive: (leg.receive || []).map((x) => toMflAsset(x)), sinceUnix: since });
  } catch (_) { return null; }
}

/**
 * ADMIN: retry ONLY the post-processing (pre-trade extensions) of a 3-way MFL has already executed. Never touches the trade legs.
 * Refused when: the trade did not execute; a LEG failed (a partly executed trade needs a human, not a retry); or an earlier extension attempt's
 * import request reached MFL but could not be verified (re-applying could extend the contract twice) unless the commissioner passes `force`
 * after checking the contract by hand.
 */
export async function retry3WayPostProcessing(env, id, { force } = {}) {
  if (!env.UPS_MFL_DB) return { ok: false, http: 503, code: "no_db", message: "D1 not bound." };
  const row = await getRow(env, id);
  if (!row) return { ok: false, http: 404, code: "not_found", message: "No such 3-way trade." };
  const ledger = ledgerFor(env), key = lkey(row);
  const led = await ledger.read(key);
  if (!led || !isMflExecuted(led.state)) return { ok: false, http: 409, code: "not_executed", message: "MFL has not executed this trade; there is nothing to retry (use recheck/reconcile).", state: led ? led.state : null };
  if (led.state === EXEC.COMPLETED) return { ok: true, http: 200, code: "already_completed", message: "Nothing to retry — post-processing is complete.", state: led.state };
  if (led.failed_step && led.failed_step !== "extensions") return { ok: false, http: 409, code: "legs_need_manual_fix", message: `This trade only partly executed (${led.failed_step}). It needs a manual fix in MFL; post-processing cannot be retried.`, state: led.state };
  const prev = (led.steps && led.steps.extensions) || {};
  if (prev.request_ok && !prev.ok && !force) return { ok: false, http: 409, code: "manual_verification_required", message: "An earlier extension attempt reached MFL but could not be verified. Check the player's contract in MFL first; retrying blind could extend it twice. Pass force=1 only after confirming it did NOT apply.", state: led.state };
  const claim = await ledger.claimResume(key, new Date(Date.now() - 120000).toISOString());
  if (!claim.claimed) return { ok: false, http: 409, code: "in_progress", message: "Post-processing is already running for this trade.", state: claim.row ? claim.row.state : null };
  const ids = safeStr(row.mfl_trade_ids).split(",").map((x) => x.trim()).filter(Boolean);
  const extOut = await applyExtensionsViaSelf(env, row, ids);
  const ok = !!(extOut && extOut.ok);
  const detail = ok ? "" : safeStr(extOut && (extOut.error || extOut.reason)).slice(0, 300) || "extension import failed";
  await ledger.recordStep(key, "extensions", { ok, request_ok: !!(extOut && extOut.request_ok), ...(ok ? {} : { detail }) });
  await ledger.move(key, ok
    ? { from: [EXEC.POSTPROCESSING], to: EXEC.COMPLETED, token: claim.token, set: { completed_at_utc: nowIso(), failed_step: null, failure_detail: null } }
    : { from: [EXEC.POSTPROCESSING], to: EXEC.NEEDS_REVIEW, token: claim.token, set: { failed_step: "extensions", failure_detail: detail } });
  await env.UPS_MFL_DB.prepare(`UPDATE ups_3way_trades SET failure_reason=?, updated_at_utc=? WHERE id=?`).bind(ok ? null : `executed_needs_review:extensions: ${detail}`.slice(0, 250), nowIso(), row.id).run();
  return { ok, http: 200, code: ok ? "completed" : "still_needs_review", message: ok ? "Extensions applied; the trade is complete." : `Extensions still failing: ${detail}`, state: ok ? EXEC.COMPLETED : EXEC.NEEDS_REVIEW };
}

/**
 * RE-CHECK a trade that is waiting only on the salary cap (both partners already accepted; ledger `blocked_cap`). Recomputes the cap from
 * scratch; if it is fine now, flips `collecting → executing` with a conditional UPDATE (so two re-checks cannot both start it) and executes.
 * Anyone in the trade may ask; the trade that runs is exactly what all three accepted.
 */
export async function recheck3WayExecution(env, ctx, id, viewer) {
  if (!env.UPS_MFL_DB) return dbDown(new Error("no_db"));
  const tid = safeStr(id);
  if (!ID_RE.test(tid)) return { ok: false, http: 400, code: "bad_request", message: "That isn't a valid trade id." };
  let row; try { row = await getRowStrict(env, tid); } catch (e) { return dbDown(e); }
  if (!row || !inScope(row, viewer)) return { ok: false, http: 404, code: "not_found", message: "This 3-way trade doesn't exist." };
  if (!canView(row, viewer)) return { ok: false, http: 403, code: "forbidden", message: "You aren't part of this trade." };
  const both = safeStr(row.team_b_state) === "accepted" && safeStr(row.team_c_state) === "accepted";
  let led = null; try { led = await ledgerFor(env).read(lkey(row)); } catch (_) { led = null; }
  if (safeStr(row.status) !== "collecting" || !both || !led || led.state !== EXEC.BLOCKED_CAP) {
    return { ok: false, http: 409, code: "not_blocked", message: safeStr(row.status) === "collecting" ? "This trade isn't waiting on the salary cap." : "This trade isn't waiting on anything to re-check." };
  }
  const gate = await capGate(env, row);
  if (!gate.ok) {
    await enterBlockedCap(env, { ...row, status: "collecting" }, gate, null);   // refresh the recorded block (no repeat DM from a re-check)
    return {
      ok: false, http: 409,
      code: gate.kind === "unavailable" ? "cap_check_unavailable" : gate.kind === "extension_stale" ? "extension_terms_stale" : gate.kind === "extension" ? "extension_no_longer_eligible" : gate.kind === "loaded_contract_drops_required" ? "loaded_contract_drops_required" : gate.kind === "cap_ack_required" ? "cap_overage_ack_required" : "cap_exceeded",
      message: gate.message, compliance: gate.compliance, cap_ack: gate.cap_ack || null,
    };
  }
  const flip = await env.UPS_MFL_DB.prepare(`UPDATE ups_3way_trades SET status='executing', updated_at_utc=? WHERE id=? AND status='collecting' AND team_b_state='accepted' AND team_c_state='accepted'`).bind(nowIso(), tid).run();
  if (!Number(flip?.meta?.changes ?? flip?.changes ?? 0)) return { ok: false, http: 409, code: "not_blocked", message: "This trade is already being processed." };
  if (ctx && ctx.waitUntil) ctx.waitUntil(execute3Way(env, tid)); else await execute3Way(env, tid);
  return { ok: true, code: "rechecking", message: "The salary cap is fine now — the trade is being processed." };
}

/**
 * Record ONE franchise's explicit acknowledgment of its own currently-projected cap overage on
 * this 3-way trade (Keith's ruling, 2026-09-28, separate PR: "for a three-way trade, handle each
 * affected franchise separately"). `viewer` must be a proven session for the franchise being
 * acknowledged -- never a body-supplied claim (mirrors every other 3-way owner action's identity
 * check, e.g. cancel3WayTrade). Recomputes compliance FRESH in this same call; an unreadable cap
 * calculation is never treated as "nothing to acknowledge" or as satisfied -- it fails closed.
 * Writes nothing to MFL, and never itself flips the trade out of `collecting`/`blocked_cap` --
 * the owner (or anyone) still needs to hit Re-check afterward, exactly like fixing any other
 * blocked-gate condition.
 */
export async function ack3WayCapOverage(env, id, viewer) {
  if (!env.UPS_MFL_DB) return dbDown(new Error("no_db"));
  const tid = safeStr(id);
  if (!ID_RE.test(tid)) return { ok: false, http: 400, code: "bad_request", message: "That isn't a valid trade id." };
  let row; try { row = await getRowStrict(env, tid); } catch (e) { return dbDown(e); }
  if (!row || !inScope(row, viewer)) return { ok: false, http: 404, code: "not_found", message: "This 3-way trade doesn't exist." };
  if (!canView(row, viewer)) return { ok: false, http: 403, code: "forbidden", message: "You aren't part of this trade." };
  const myFid = padFid(viewer && viewer.fid);
  const participantFids = [row.initiator_fid, row.team_b_fid, row.team_c_fid].map(padFid);
  if (!myFid || !participantFids.includes(myFid)) return { ok: false, http: 403, code: "forbidden", message: "You aren't part of this trade." };
  const compliance = await complianceViaSelf(env, row);
  if (compliance.cap.status === "unavailable") {
    return { ok: false, http: 503, code: "cap_check_unavailable", message: `${UNAVAILABLE_MSG} Try again in a moment.`, compliance };
  }
  const myViolation = (compliance.cap.violations || []).find((v) => safeStr(v.franchise_id) === myFid);
  if (!myViolation) {
    return { ok: true, http: 200, code: "nothing_to_acknowledge", message: "Your team isn't projected to be over the salary cap on this trade right now.", compliance };
  }
  const sig = capAckSignature({ tradeKey: tid, franchiseId: myFid, amountOver: myViolation.amount_over, usedAfter: myViolation.projected_used });
  await capAckStoreFor(env).record(capAckKey(row), {
    franchiseId: myFid, acknowledgedByFid: myFid, signature: sig,
    amountOverDollars: myViolation.amount_over, usedAfterDollars: myViolation.projected_used, capDollars: compliance.cap.cap_dollars, tradeKind: "three_way",
  });
  return { ok: true, http: 200, code: "acknowledged", message: `Acknowledged: ${safeStr(myViolation.franchise_name)} would be $${Math.round(myViolation.amount_over).toLocaleString("en-US")} over the $${Math.round(compliance.cap.cap_dollars).toLocaleString("en-US")} salary cap.`, compliance, cap_ack: { franchise_id: myFid, amount_over: myViolation.amount_over, signature: sig } };
}

/**
 * Select (and, by submitting, confirm) THIS caller's OWN conditional loaded-contract drops on
 * this 3-way trade (Keith's ruling, 2026-09-29: "for a three-way trade, handle each affected
 * franchise separately", the SAME principle ack3WayCapOverage above already applies to cap).
 * `viewer` must be a proven session for the franchise being selected for -- never a body-supplied
 * claim (mirrors ack3WayCapOverage and every other 3-way owner action's identity check).
 * `playerIds` REPLACES this franchise's whole selection (an empty array clears it). Recomputes
 * compliance FRESH, WITH this exact selection applied, so the response reports this selection's
 * own validity, not a stale picture; an unreadable calculation fails closed. Writes nothing to
 * MFL, drops no player, and never itself flips the trade out of `collecting`/`blocked_cap` -- the
 * owner (or anyone) still needs to hit Re-check afterward, exactly like fixing any other
 * blocked-gate condition.
 */
export async function select3WayLoadedContractDrops(env, id, viewer, playerIds) {
  if (!env.UPS_MFL_DB) return dbDown(new Error("no_db"));
  const tid = safeStr(id);
  if (!ID_RE.test(tid)) return { ok: false, http: 400, code: "bad_request", message: "That isn't a valid trade id." };
  let row; try { row = await getRowStrict(env, tid); } catch (e) { return dbDown(e); }
  if (!row || !inScope(row, viewer)) return { ok: false, http: 404, code: "not_found", message: "This 3-way trade doesn't exist." };
  if (!canView(row, viewer)) return { ok: false, http: 403, code: "forbidden", message: "You aren't part of this trade." };
  const myFid = padFid(viewer && viewer.fid);
  const participantFids = [row.initiator_fid, row.team_b_fid, row.team_c_fid].map(padFid);
  if (!myFid || !participantFids.includes(myFid)) return { ok: false, http: 403, code: "forbidden", message: "You aren't part of this trade." };
  const selectedIds = (Array.isArray(playerIds) ? playerIds : []).map(safeStr).filter(Boolean);
  // Recompute WITH this exact selection layered onto whatever's already stored for the OTHER
  // participants, so the response reflects this selection's own validity together with theirs.
  const priorDrops = await conditionalDropStoreFor(env).readAllForTrade(conditionalDropKey(row));
  const movements = parseMovements(row).map((m) => ({ from: padFid(m.from), to: padFid(m.to), tokens: injectCapTokens([m])[0].asset_tokens }));
  const apiKey = safeStr(env.COMMISH_API_KEY);
  let compliance;
  if (!env.SELF || !apiKey) { compliance = unavailableCompliance(!env.SELF ? "no_self_binding" : "no_commish_key"); }
  else {
    try {
      const u = `https://self.invalid/admin/3way/compliance?L=${encodeURIComponent(safeStr(row.league_id))}&YEAR=${encodeURIComponent(safeStr(row.season))}&APIKEY=${encodeURIComponent(apiKey)}`;
      const r = await env.SELF.fetch(u, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ league_id: safeStr(row.league_id), season: safeStr(row.season), movements, extension_requests: parseExtReqs(row), offer_created_at_utc: safeStr(row.created_at_utc), conditional_drops: { ...priorDrops, [myFid]: selectedIds } }),
      });
      const j = await r.json().catch(() => null);
      const c = j && j.ok && j.compliance;
      compliance = (!r.ok || !c || !c.loaded_contracts) ? unavailableCompliance("bad_response") : c;
    } catch (e) { console.error(`[3way] ${row.id}: compliance call failed: ${e?.message || e}`); compliance = unavailableCompliance("call_failed"); }
  }
  if (compliance.loaded_contracts.status === "unavailable") {
    return { ok: false, http: 503, code: "loaded_contract_check_unavailable", message: "We couldn't verify the loaded-contract count for this trade right now, so nothing was selected. Try again in a moment.", compliance };
  }
  const myReq = (compliance.loaded_contracts.drop_requirements || []).find((d) => safeStr(d.franchise_id) === myFid);
  if (!myReq) {
    return { ok: true, http: 200, code: "nothing_required", message: "Your team isn't projected to need a conditional drop on this trade right now.", compliance };
  }
  await conditionalDropStoreFor(env).setForFranchise(conditionalDropKey(row), { franchiseId: myFid, playerIds: selectedIds, selectedByFid: myFid });
  // Satisfied is a real, useful state (it's what lets the OTHER participants stop waiting on
  // THIS franchise) -- but never worded as if execution is now unblocked: capGate() above still
  // refuses EXECUTE regardless, until a real executor exists (Keith's ruling, 2026-09-29).
  const selectDropsExecutable = loadedContractsPermitsWrite(compliance.loaded_contracts.status);
  return {
    ok: true, http: 200, code: myReq.satisfied ? "selected" : "selected_insufficient",
    message: myReq.satisfied
      ? `Selected: ${myReq.valid_count} of ${myReq.required_drops} required conditional drop${myReq.required_drops === 1 ? "" : "s"}.` + (selectDropsExecutable ? "" : " Conditional-drop execution isn't built yet, so this trade stays held until it is.")
      : `${myReq.valid_count} of ${myReq.required_drops} required conditional drops are valid so far -- ${myReq.required_drops - myReq.valid_count} more needed.`,
    compliance, drop_requirement: myReq,
  };
}

// ───────────────────── execute the chained 2-party trades ───────────────────
// Clean cycle -> 2-trade HUB (A holds the pass-through between legs). Otherwise
// -> PAIRWISE, one MFL trade per team-pair. Ordered, verified between legs, and
// all-or-nothing with a CRITICAL commish alert on partial failure. DRY-RUN
// unless TRADE_3WAY_EXECUTE=1.
export async function execute3Way(env, id) {
  const row = await getRow(env, id);
  if (!row || safeStr(row.status) !== "executing") return { skipped: "not_executing" };
  const leagueId = safeStr(row.league_id), year = safeStr(row.season);
  const A = padFid(row.initiator_fid), B = padFid(row.team_b_fid), C = padFid(row.team_c_fid);
  // Cap money rides as a BlindBid$ (BB_) token on each movement's giving side.
  const movements = injectCapTokens(parseMovements(row));

  const finish = async (status, fields) => {
    const sets = ["status=?", "updated_at_utc=?"]; const binds = [status, nowIso()];
    for (const [k, v] of Object.entries(fields || {})) { sets.push(`${k}=?`); binds.push(v); }
    binds.push(id);
    await env.UPS_MFL_DB.prepare(`UPDATE ups_3way_trades SET ${sets.join(", ")} WHERE id=?`).bind(...binds).run();
  };
  const dmAllThree = async (content) => {
    for (const c of [row.initiator_discord_ids, row.team_b_discord_ids, row.team_c_discord_ids]) await dmAll(env, c, { content: safeStr(content).slice(0, 1990) });
  };
  // ---- 🔒 PER-FRANCHISE DROP-FIRST HOLD (§8.6, Keith 2026-09-30) -----------------------
  // A 3-way trade id can never itself appear in ups_2way_trades (disjoint id namespaces), so
  // no exclude-self parameter is needed here -- unlike the 2-way executor's own cross-deal
  // check. Reuses enterBlockedCap's exact revert-to-collecting + dedup'd-DM mechanism, the
  // same one every other pre-execution block already uses, so this failure mode is never
  // "stuck at status=executing forever."
  try {
    for (const fid of [A, B, C]) {
      if (await franchiseHasUnresolvedDropSequence(env, leagueId, year, fid)) {
        const holdGate = { kind: "franchise_has_unresolved_drop_sequence", message: "One of the teams in this trade has another deal still being untangled by the commissioner.", compliance: null };
        console.warn(`[3way] ${id} blocked by per-franchise hold: ${fid} has an unresolved 2-way drop-first sequence`);
        await enterBlockedCap(env, row, holdGate, dmAllThree);
        return { ok: false, blocked: true, kind: "franchise_has_unresolved_drop_sequence", franchise_id: fid };
      }
    }
  } catch (e) {
    return { ok: false, blocked: true, error: "hold_check_unavailable" };
  }
  // Persist executed trade ids into the legacy two id columns + the CSV column.
  const progressFields = (done) => {
    const f = { mfl_trade_ids: done.join(",") };
    if (done[0]) f.mfl_trade1_id = done[0];
    if (done[1]) f.mfl_trade2_id = done[1];
    return f;
  };

  // Build the ordered execution plan.
  const cyc = asCycle(movements, A, B, C);
  let plan, mode;
  if (cyc) {
    mode = "cycle/hub";
    plan = [
      { fromFid: A, toFid: B, give: cyc.X, receive: cyc.Y, label: "hub-1" },
      { fromFid: A, toFid: C, give: cyc.Y, receive: cyc.Z, label: "hub-2", verifyHold: cyc.Y }, // A must hold the pass-through first
    ];
  } else {
    mode = "pairwise";
    plan = pairwiseTrades(movements).map((p, i) => ({ fromFid: p.a, toFid: p.b, give: p.aToB, receive: p.bToA, label: `pair-${i + 1}` }));
  }
  if (!plan.length) {
    await finish("failed", { failure_reason: "no_executable_legs" });
    await dmAllThree(`⚠️ The 3-way trade had nothing to move — the commish will take a look.`);
    return { ok: false, error: "no_legs" };
  }

  const extReqs = parseExtReqs(row);

  // SALARY CAP GATE (before ANY MFL call and before any completed-state write): recompute the post-trade cap from live MFL data.
  // A proven violation — or a cap we cannot verify — BLOCKS EXECUTION but is RECOVERABLE: the trade returns to `collecting` with a current
  // validation block, every approval is kept, and a re-check recomputes from scratch. It is never marked `failed`.
  const gate = await capGate(env, row);
  if (!gate.ok) {
    console.warn(`[3way] ${id} blocked by the cap gate (${gate.kind}): ${gate.message}`);
    await enterBlockedCap(env, row, gate, dmAllThree);
    return { ok: false, blocked: true, error: "cap_gate", kind: gate.kind, message: gate.message, compliance: gate.compliance };
  }

  // DRY-RUN: log the plan + tell everyone it's "approved" without moving rosters.
  if (!(await liveExecute(env))) {
    const planStr = plan.map((p) => `  ${p.label}: ${p.fromFid} gives [${p.give.join(",")}]  <->  ${p.toFid} gives [${p.receive.join(",")}]`).join("\n");
    console.log(`[3way][DRY-RUN] ${id} would execute (${mode}, ${plan.length} trade(s)):\n${planStr}${extReqs.length ? `\n  + ${extReqs.length} pre-trade extension(s)` : ""}`);
    await finish("completed", { failure_reason: "dry_run", executed_at_utc: nowIso() });
    await dmAllThree(`✅ All three accepted the 3-way trade.${extReqs.length ? ` (${extReqs.length} pre-trade extension(s) included.)` : ""} _(Dry-run: not yet wired to MFL — the commish will finalize.)_`);
    return { ok: true, dry_run: true, mode, legs: plan.length };
  }

  // EXECUTION LOCK — recorded BEFORE the first MFL call. A conditional ledger write: an already-executing / executed trade can never be
  // sent to MFL again. If the ledger is unavailable we fail closed (recoverable: back to `collecting`), because we could not make the
  // "executed" fact durable.
  const ledger = (() => { try { return ledgerFor(env); } catch (_) { return null; } })();
  const key = lkey(row);
  let lock = null;
  try {
    if (!ledger) throw new Error("no ledger");
    lock = await ledger.acquire(key, { kind: "three_way", actorFid: A, participants: [A, B, C].join(","), payload: { legs: movements, extension_requests: extReqs } });
  } catch (e) {
    console.error(`[3way] ${id}: execution ledger unavailable — nothing sent to MFL: ${e?.message || e}`);
    await enterBlockedCap(env, row, { kind: "ledger_unavailable", message: "We couldn't safely start this trade right now.", compliance: null }, dmAllThree);
    return { ok: false, blocked: true, error: "ledger_unavailable" };
  }
  if (!lock.acquired) {
    console.warn(`[3way] ${id}: not executing — ledger state is ${lock.row && lock.row.state}`);
    return { skipped: "execution_not_acquirable", state: lock.row && lock.row.state };
  }
  const token = lock.token;

  // LIVE — run each leg in order, all-or-nothing.
  const done = [];
  for (let i = 0; i < plan.length; i++) {
    const leg = plan[i];
    // Hub pass-through: A must actually hold Y before giving it away in leg 2.
    if (leg.verifyHold && leg.verifyHold.length) {
      let owns = false;
      for (let k = 0; k < 4 && !owns; k++) { await sleep(2500); owns = await rosterOwnsPlayers(env, leagueId, year, A, leg.verifyHold); }
      if (!owns) {
        console.error(`[3way] ${id} ${leg.label}: pass-through unverified after ${done.join(",")} — ABORT.`);
        await finish("failed", { ...progressFields(done), failure_reason: `passthrough_unverified_after_${done.join("+") || "leg1"}` });
        await ledger.move(key, { from: EXEC.EXECUTING, to: done.length ? EXEC.NEEDS_REVIEW : EXEC.NOT_EXECUTED, token, set: done.length ? { failed_step: `leg_${i + 1}`, failure_detail: "pass-through unverified", mfl_evidence_json: { trade_ids: done }, mfl_executed_at_utc: nowIso() } : {} }).catch(() => {});
        await dmAllThree(`⚠️ The first leg of the 3-way went through but the next couldn't verify. **Commish: manual fix needed** (trades ${done.join(", ") || "?"}).`);
        return { ok: false, leg: i + 1, error: "passthrough_unverified", partial: done.length > 0 };
      }
    }
    const r = await executeCommishTwoPartyTrade(env, { leagueId, year, fromFid: leg.fromFid, toFid: leg.toFid, give: leg.give, receive: leg.receive, comments: `3-way ${id} ${leg.label} (${mode})` });
    // A leg's accept can succeed at MFL and still come back as an error (timeout, lost response). Ask MFL before calling it a failure; a leg found
    // in MFL's trade ledger HAS executed and is never sent again.
    if (!r.ok && r.tradeId) {
      const hit = await legExecuted(env, leagueId, year, leg, row);
      if (hit) { done.push(r.tradeId); await finish("executing", progressFields(done)); continue; }
    }
    if (!r.ok) {
      const partial = done.length > 0;
      if (partial) {
        console.error(`[3way] ${id} ${leg.label} FAILED — PARTIAL (already landed: ${done.join(",")}): ${r.step}/${r.error}`);
        await finish("failed", { ...progressFields(done), failure_reason: `PARTIAL_${leg.label}_${r.step}: ${safeStr(r.error).slice(0, 150)} (done=${done.join(",")})` });
        await ledger.move(key, { from: EXEC.EXECUTING, to: EXEC.NEEDS_REVIEW, token, set: { failed_step: leg.label, failure_detail: `${r.step}: ${safeStr(r.error).slice(0, 200)}`, mfl_evidence_json: { trade_ids: done }, mfl_executed_at_utc: nowIso() } }).catch(() => {});
        await dmAllThree(`🚨 The 3-way is **partially done** — ${done.length} leg(s) processed, the next failed. **Commish: manual intervention needed** (done: ${done.join(", ")}).`);
      } else if (r.step === "lockout") {
        console.error(`[3way] ${id} ${leg.label} BLOCKED by MFL commissioner lockout — nothing moved.`);
        await finish("failed", { failure_reason: `lockout_${leg.label}: MFL commissioner lockout on` });
        await ledger.move(key, { from: EXEC.EXECUTING, to: EXEC.NOT_EXECUTED, token }).catch(() => {});
        await dmAllThree(`⏸️ The 3-way is approved by all three, but MFL's commissioner lockout is on, so the bot can't process it yet. **Commish: toggle lockout off and re-run** — nothing has moved.`);
      } else {
        console.error(`[3way] ${id} ${leg.label} FAILED (safe — nothing moved): ${r.step}/${r.error}`);
        await finish("failed", { failure_reason: `${leg.label}_${r.step}: ${safeStr(r.error).slice(0, 200)}` });
        await ledger.move(key, { from: EXEC.EXECUTING, to: EXEC.NOT_EXECUTED, token }).catch(() => {});
        await dmAllThree(`⚠️ The 3-way trade couldn't be processed (it failed before anything moved). The commish will take a look.`);
      }
      return { ok: false, leg: i + 1, error: r.error, partial };
    }
    done.push(r.tradeId);
    await finish("executing", progressFields(done)); // checkpoint after each landed leg
  }

  // ALL LEGS LANDED — MFL has executed the trade. Make that permanent FIRST (a D1 fault here is recoverable by reconciliation, never by re-execution).
  let persisted = true;
  try {
    persisted = await ledger.move(key, { from: EXEC.EXECUTING, to: EXEC.MFL_EXECUTED, token, set: { mfl_evidence_json: { source: "mfl_legs", trade_ids: done, mode }, mfl_executed_at_utc: nowIso() } });
    if (persisted) await ledger.move(key, { from: EXEC.MFL_EXECUTED, to: EXEC.POSTPROCESSING, token });
  } catch (e) { persisted = false; console.error(`[3way] ${id}: CRITICAL — MFL executed (${done.join(",")}) but the ledger write failed: ${e?.message || e}`); }

  // Post-processing (pre-trade extensions) runs only now, after the base trade is known to have executed. A failure here NEVER un-executes the
  // trade: it is recorded as executed_needs_review with the exact failed step, and only that step can be retried.
  let extOut = null, extFailed = false, extDetail = "";
  if (extReqs.length) {
    extOut = await applyExtensionsViaSelf(env, row, done);
    if (extOut && extOut.ok) {
      console.log(`[3way] ${id} extensions applied: ${safeInt(extOut.applied, 0)}/${extReqs.length}`);
    } else {
      extFailed = true; extDetail = safeStr(extOut && (extOut.error || extOut.reason)).slice(0, 300) || "extension import failed";
      console.error(`[3way] ${id} extension apply FAILED: ${extDetail}`);
    }
  }
  try {
    await ledger.recordStep(key, "extensions", extReqs.length ? { ok: !extFailed, request_ok: !!(extOut && extOut.request_ok), ...(extFailed ? { detail: extDetail } : {}) } : { ok: true, skipped: true });
    await ledger.move(key, extFailed
      ? { from: [EXEC.POSTPROCESSING, EXEC.MFL_EXECUTED], to: EXEC.NEEDS_REVIEW, token, set: { failed_step: "extensions", failure_detail: extDetail } }
      : { from: [EXEC.POSTPROCESSING, EXEC.MFL_EXECUTED], to: EXEC.COMPLETED, token, set: { completed_at_utc: nowIso() } });
  } catch (e) { console.error(`[3way] ${id}: ledger settle failed (the trade DID execute): ${e?.message || e}`); }

  // `completed` here means "MFL executed it" — the review flag lives on the ledger and in failure_reason, never a return to a pending state.
  await finish("completed", { ...progressFields(done), executed_at_utc: nowIso(), ...(extFailed ? { failure_reason: `executed_needs_review:extensions: ${extDetail}`.slice(0, 250) } : {}) });
  if (extFailed) {
    await dmAllThree(`⚠️ The 3-way trade WAS executed in MFL (trades ${done.join(", ")}), but ${extReqs.length} pre-trade extension(s) couldn't be applied. **Commish: retry just the extensions** (the trade itself must not be re-run).`);
    return { ok: true, executed: true, needs_review: true, failed_step: "extensions", mode, trades: done, extensions: extOut };
  }
  console.log(`[3way] ${id} COMPLETE (${mode}): trades=${done.join(",")}${extReqs.length ? " ext=ok" : ""}`);
  await dmAllThree(`✅ **3-way trade complete!** Rosters are updated in MFL.${extReqs.length && extOut && extOut.ok ? ` ${safeInt(extOut.applied, 0)} extension(s) applied.` : ""} (The Roast bot will have the play-by-play.)`);
  return { ok: true, mode, trades: done, extensions: extOut };
}
