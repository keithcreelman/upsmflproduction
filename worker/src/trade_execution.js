// trade_execution.js — the execution ledger: an explicit, STRUCTURAL state model for the one thing that cannot be undone.
//
// MFL accepting a trade is an irreversible external event. Whatever happens afterwards (a contract import that fails, a lost HTTP response, a
// D1 write that throws, a worker that dies mid-request) can never make the application behave as though the trade did not execute, and can
// never put an executed trade back into a state from which it could be executed again. This module owns that guarantee:
//
//   not_executed  ──lock──▶ executing ──MFL confirms──▶ mfl_executed ──▶ postprocessing ──▶ completed
//        ▲                     │  │                          │                │
//        │   MFL refused /     │  └── ambiguous ──▶ (stays `executing`,       └──▶ executed_needs_review ──admin retry──▶ postprocessing
//        └── proven pending ───┘      reconcile against MFL, never retry MFL)
//   blocked_cap (3-way only: cap gate refused BEFORE any MFL write; recoverable) ──recheck──▶ executing
//
//   • The lock is a conditional INSERT / UPDATE — two concurrent accepts cannot both hold it, so MFL is called at most once per trade.
//   • `executing` is entered BEFORE MFL is called and is only left by (a) MFL's confirmation, (b) PROOF from MFL that nothing happened, or
//     (c) an administrator's reconcile. A lost response, a crash, or a failed D1 write therefore leaves `executing`, which is resolved
//     by asking MFL — never by calling it again.
//   • Once `mfl_executed`, the fact is permanent: no transition leads back to `executing`, `not_executed` or `blocked_cap`.
//   • Post-processing (salary adjustments, extensions, taxi) runs only after `mfl_executed`; each step's result is recorded, and a retry
//     runs only the steps not yet proven done.
//
// The ledger table is created on demand (CREATE TABLE IF NOT EXISTS, like the outbox) and also shipped as migration 0160, so the worker does
// not depend on migration ordering.

export const EXEC = Object.freeze({
  NOT_EXECUTED: "not_executed",
  EXECUTING: "executing",
  MFL_EXECUTED: "mfl_executed",
  POSTPROCESSING: "postprocessing",
  COMPLETED: "completed",
  NEEDS_REVIEW: "executed_needs_review",
  BLOCKED_CAP: "blocked_cap",
  // Keith's ruling (2026-09-29, drop-first): a multi-write deal (one or more conditional
  // drops, then the trade) in which at least one write has ALREADY been confirmed on MFL —
  // an irreversible fact — but the full sequence has not yet completed. Distinct from
  // MFL_EXECUTED (which this module has always meant as "the TRADE specifically executed")
  // because a drop confirming is its own, earlier, independently-irreversible fact. See
  // docs/LOADED_CONTRACT_DROP_EXECUTION_DESIGN.md §2.4.3b. Only ever written by
  // worker/src/trade_2way.js's drop-first orchestrator; no other caller produces it.
  PARTIAL_EXECUTED: "partial_executed",
});

/** States in which MFL HAS executed something for this deal — permanent facts. */
export const MFL_DONE_STATES = Object.freeze([EXEC.MFL_EXECUTED, EXEC.POSTPROCESSING, EXEC.COMPLETED, EXEC.NEEDS_REVIEW, EXEC.PARTIAL_EXECUTED]);
export const isMflExecuted = (state) => MFL_DONE_STATES.includes(state);

/** The only legal moves. Nothing leaves an MFL-executed state except forward. */
export const TRANSITIONS = Object.freeze({
  [EXEC.NOT_EXECUTED]: [EXEC.EXECUTING],
  [EXEC.BLOCKED_CAP]: [EXEC.EXECUTING],
  [EXEC.EXECUTING]: [EXEC.MFL_EXECUTED, EXEC.NOT_EXECUTED, EXEC.BLOCKED_CAP, EXEC.NEEDS_REVIEW, EXEC.PARTIAL_EXECUTED],
  [EXEC.MFL_EXECUTED]: [EXEC.POSTPROCESSING, EXEC.COMPLETED, EXEC.NEEDS_REVIEW],
  [EXEC.POSTPROCESSING]: [EXEC.POSTPROCESSING, EXEC.COMPLETED, EXEC.NEEDS_REVIEW],   // (re-entry = a stale, crashed post-processing run being resumed)
  [EXEC.NEEDS_REVIEW]: [EXEC.POSTPROCESSING, EXEC.COMPLETED],
  [EXEC.COMPLETED]: [],
  // Forward-only, exactly like MFL_EXECUTED: NEVER back to NOT_EXECUTED/BLOCKED_CAP/EXECUTING
  // via a plain move() — a drop already happened and must never be treated as "nothing
  // happened yet." Resuming to attempt the NEXT step goes through resumeDropSequence() below,
  // which takes a fresh lock token exactly like claimResume() does for postprocessing, never
  // through a bare move().
  [EXEC.PARTIAL_EXECUTED]: [EXEC.PARTIAL_EXECUTED, EXEC.MFL_EXECUTED, EXEC.NEEDS_REVIEW],
});
export const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

const s = (v) => String(v == null ? "" : v).trim();
const nowIso = () => new Date().toISOString();
const newToken = () => { try { return crypto.randomUUID(); } catch (_) { return `t-${Date.now()}-${Math.floor(Math.random() * 1e9)}`; } };
const jparse = (v, fb) => { try { const x = JSON.parse(v); return x == null ? fb : x; } catch (_) { return fb; } };
const changes = (r) => Number(r && r.meta && r.meta.changes != null ? r.meta.changes : r && r.changes != null ? r.changes : 0);

export const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS ups_trade_executions (
  league_id            TEXT NOT NULL,
  season               TEXT NOT NULL,
  exec_key             TEXT NOT NULL,
  kind                 TEXT NOT NULL,
  state                TEXT NOT NULL,
  lock_token           TEXT,
  actor_fid            TEXT,
  participants         TEXT,
  payload_hash         TEXT,
  payload_json         TEXT,
  mfl_evidence_json    TEXT,
  steps_json           TEXT,
  failed_step          TEXT,
  failure_detail       TEXT,
  block_json           TEXT,
  created_at_utc       TEXT NOT NULL,
  updated_at_utc       TEXT NOT NULL,
  mfl_executed_at_utc  TEXT,
  completed_at_utc     TEXT,
  PRIMARY KEY (league_id, season, exec_key)
)`;

const keyOf = (k) => [s(k.leagueId), s(k.season), s(k.execKey)];

/** All ledger operations for one D1 database. Every mutation is a conditional UPDATE / INSERT (compare-and-set). */
export function makeLedger(db) {
  let ensured = false;
  const ensure = async () => { if (!ensured) { await db.prepare(LEDGER_DDL).run(); ensured = true; } };

  const read = async (k) => {
    await ensure();
    const row = await db.prepare("SELECT * FROM ups_trade_executions WHERE league_id=? AND season=? AND exec_key=?").bind(...keyOf(k)).first();
    return row ? hydrate(row) : null;
  };

  /**
   * Take the execution lock. Only ONE caller can: a new row is inserted `executing`, or a row that provably never executed
   * (`not_executed` / `blocked_cap`) is moved to `executing` by a conditional UPDATE. Anything else returns the current row
   * and `acquired:false` — the trade is executing, executed, or in review, and MUST NOT be sent to MFL again.
   */
  const acquire = async (k, seed) => {
    await ensure();
    const token = newToken(), at = nowIso();
    const ins = await db.prepare(
      `INSERT INTO ups_trade_executions (league_id, season, exec_key, kind, state, lock_token, actor_fid, participants, payload_hash, payload_json, created_at_utc, updated_at_utc)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(league_id, season, exec_key) DO NOTHING`
    ).bind(...keyOf(k), s(seed && seed.kind) || "two_way", EXEC.EXECUTING, token, s(seed && seed.actorFid), s(seed && seed.participants), s(seed && seed.payloadHash),
      seed && seed.payload ? JSON.stringify(seed.payload) : null, at, at).run();
    if (changes(ins) === 1) return { acquired: true, token, row: await read(k) };
    const upd = await db.prepare(
      `UPDATE ups_trade_executions SET state=?, lock_token=?, actor_fid=?, payload_hash=COALESCE(?, payload_hash), payload_json=COALESCE(?, payload_json),
              block_json=NULL, failed_step=NULL, failure_detail=NULL, updated_at_utc=?
        WHERE league_id=? AND season=? AND exec_key=? AND state IN (?, ?)`
    ).bind(EXEC.EXECUTING, token, s(seed && seed.actorFid), s(seed && seed.payloadHash) || null, seed && seed.payload ? JSON.stringify(seed.payload) : null, at,
      ...keyOf(k), EXEC.NOT_EXECUTED, EXEC.BLOCKED_CAP).run();
    if (changes(upd) === 1) return { acquired: true, token, row: await read(k) };
    return { acquired: false, row: await read(k) };
  };

  /**
   * Compare-and-set a transition. `from` is the set of states the row must currently be in; `to` must be a legal move from each. Never moves a
   * row out of an MFL-executed state except forward. Returns true iff THIS call made the change.
   */
  const move = async (k, { from, to, token, set }) => {
    await ensure();
    const froms = (Array.isArray(from) ? from : [from]).filter((f) => canTransition(f, to));
    if (!froms.length) return false;
    const cols = ["state=?", "updated_at_utc=?"], binds = [to, nowIso()];
    for (const [c, v] of Object.entries(set || {})) {
      if (!/^(mfl_evidence_json|steps_json|failed_step|failure_detail|block_json|mfl_executed_at_utc|completed_at_utc)$/.test(c)) throw new Error(`ledger: column not writable: ${c}`);
      cols.push(`${c}=?`); binds.push(v == null ? null : typeof v === "string" ? v : JSON.stringify(v));
    }
    const sql = `UPDATE ups_trade_executions SET ${cols.join(", ")} WHERE league_id=? AND season=? AND exec_key=? AND state IN (${froms.map(() => "?").join(",")})${token ? " AND lock_token=?" : ""}`;
    const r = await db.prepare(sql).bind(...binds, ...keyOf(k), ...froms, ...(token ? [token] : [])).run();
    return changes(r) === 1;
  };

  /**
   * Claim the right to (re)run post-processing — and ONLY post-processing — for a trade MFL has already executed. Compare-and-set: the row
   * must be `mfl_executed` or `executed_needs_review` (an explicit retry), or a `postprocessing` run that has been silent since `staleBeforeIso`
   * (a crashed worker). The claim takes a fresh lock token, so two resumers cannot both post the same contract/adjustment rows.
   */
  const claimResume = async (k, staleBeforeIso) => {
    await ensure();
    const token = newToken(), at = nowIso();
    const r = await db.prepare(
      `UPDATE ups_trade_executions SET state=?, lock_token=?, updated_at_utc=?
        WHERE league_id=? AND season=? AND exec_key=?
          AND (state IN (?, ?) OR (state=? AND updated_at_utc <= ?))`
    ).bind(EXEC.POSTPROCESSING, token, at, ...keyOf(k), EXEC.MFL_EXECUTED, EXEC.NEEDS_REVIEW, EXEC.POSTPROCESSING, s(staleBeforeIso)).run();
    return changes(r) === 1 ? { claimed: true, token, row: await read(k) } : { claimed: false, row: await read(k) };
  };

  /**
   * Claim (or resume) a drop-first multi-write sequence (§2.4.3b) — the SAME shape as
   * acquire(), except it ALSO resumes a row already `partial_executed` (some drops already
   * confirmed, the sequence isn't done), a row `executed_needs_review` from a prior stopped
   * attempt (an EXPLICIT retry — every caller of this orchestrator is itself an explicit
   * commissioner action, never an automatic background resume, exactly the same "explicit
   * retry" framing claimResume() above already uses for executed_needs_review), or a stale
   * `executing` row (a crashed mid-step attempt). Never resumes mfl_executed/postprocessing/
   * completed — those are terminal or belong to a different lifecycle stage entirely. A fresh
   * lock token every time, so two concurrent callers can never both act on the same step.
   */
  const resumeDropSequence = async (k, staleBeforeIso, seed) => {
    await ensure();
    const token = newToken(), at = nowIso();
    const ins = await db.prepare(
      `INSERT INTO ups_trade_executions (league_id, season, exec_key, kind, state, lock_token, actor_fid, participants, payload_hash, payload_json, created_at_utc, updated_at_utc)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(league_id, season, exec_key) DO NOTHING`
    ).bind(...keyOf(k), s(seed && seed.kind) || "two_way_drop_first", EXEC.EXECUTING, token, s(seed && seed.actorFid), s(seed && seed.participants), s(seed && seed.payloadHash),
      seed && seed.payload ? JSON.stringify(seed.payload) : null, at, at).run();
    if (changes(ins) === 1) return { acquired: true, token, row: await read(k) };
    const upd = await db.prepare(
      `UPDATE ups_trade_executions SET state=?, lock_token=?, updated_at_utc=?
        WHERE league_id=? AND season=? AND exec_key=?
          AND (state IN (?, ?, ?, ?) OR (state=? AND updated_at_utc <= ?))`
    ).bind(EXEC.EXECUTING, token, at, ...keyOf(k), EXEC.NOT_EXECUTED, EXEC.BLOCKED_CAP, EXEC.PARTIAL_EXECUTED, EXEC.NEEDS_REVIEW, EXEC.EXECUTING, s(staleBeforeIso)).run();
    if (changes(upd) === 1) return { acquired: true, token, row: await read(k) };
    return { acquired: false, row: await read(k) };
  };

  /**
   * Record that a trade is BLOCKED BEFORE any MFL write (3-way cap gate). Only a row that never executed can become / stay `blocked_cap`
   * (no row yet, `not_executed`, or already `blocked_cap`); it can never overwrite an executing or executed trade. Returns the previous block
   * (so a caller can tell a NEW problem from the same one it already announced).
   */
  const block = async (k, { kind, actorFid, participants, payload, blockInfo }) => {
    await ensure();
    const prev = await read(k);
    if (prev && !["not_executed", "blocked_cap"].includes(prev.state)) return { changed: false, prev };
    const at = nowIso();
    await db.prepare(
      `INSERT INTO ups_trade_executions (league_id, season, exec_key, kind, state, actor_fid, participants, payload_json, block_json, created_at_utc, updated_at_utc)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(league_id, season, exec_key) DO UPDATE SET state=?, block_json=excluded.block_json, updated_at_utc=excluded.updated_at_utc
         WHERE ups_trade_executions.state IN (?, ?)`
    ).bind(...keyOf(k), s(kind) || "three_way", EXEC.BLOCKED_CAP, s(actorFid), s(participants), payload ? JSON.stringify(payload) : null, JSON.stringify(blockInfo), at, at,
      EXEC.BLOCKED_CAP, EXEC.BLOCKED_CAP, EXEC.NOT_EXECUTED).run();
    return { changed: true, prev };
  };

  /** Ledger rows for many keys of one league/season (the trade list). */
  const readMany = async (leagueId, seasonId, execKeys) => {
    await ensure();
    const keys = [...new Set((execKeys || []).map(s).filter(Boolean))];
    if (!keys.length) return {};
    const { results } = await db.prepare(`SELECT * FROM ups_trade_executions WHERE league_id=? AND season=? AND exec_key IN (${keys.map(() => "?").join(",")})`).bind(s(leagueId), s(seasonId), ...keys).all();
    return Object.fromEntries((results || []).map((r) => [r.exec_key, hydrate(r)]));
  };

  /** Merge one post-processing step's outcome into steps_json (read-modify-write inside one request; steps only ever move toward done). */
  const recordStep = async (k, name, result) => {
    await ensure();
    const row = await read(k);
    const steps = { ...(row && row.steps || {}) };
    steps[name] = { ...(steps[name] || {}), ...result, at_utc: nowIso() };
    await db.prepare("UPDATE ups_trade_executions SET steps_json=?, updated_at_utc=? WHERE league_id=? AND season=? AND exec_key=?").bind(JSON.stringify(steps), nowIso(), ...keyOf(k)).run();
    return steps;
  };

  return { ensure, read, readMany, acquire, block, move, claimResume, resumeDropSequence, recordStep };
}

function hydrate(row) {
  return {
    league_id: row.league_id, season: row.season, exec_key: row.exec_key, kind: row.kind, state: row.state, lock_token: row.lock_token,
    actor_fid: row.actor_fid, participants: s(row.participants).split(",").filter(Boolean), payload_hash: row.payload_hash,
    payload: jparse(row.payload_json, null), evidence: jparse(row.mfl_evidence_json, null), steps: jparse(row.steps_json, {}),
    failed_step: row.failed_step || "", failure_detail: row.failure_detail || "", block: jparse(row.block_json, null),
    created_at_utc: row.created_at_utc, updated_at_utc: row.updated_at_utc, mfl_executed_at_utc: row.mfl_executed_at_utc || "", completed_at_utc: row.completed_at_utc || "",
    mfl_executed: isMflExecuted(row.state),
  };
}

// ── reconciliation: did MFL execute this trade? ─────────────────────────────────────────────────────────────────────────
const normTok = (t) => {
  const x = s(t).toUpperCase().replace(/^P_/, "");
  const dp = /^DP_(\d+)_(\d+)$/.exec(x);                     // DP_00_03 and DP_0_3 are the same pick
  return dp ? `DP_${Number(dp[1])}_${Number(dp[2])}` : x;
};
const tokenSet = (csv) => [...new Set(s(csv).split(",").map(normTok).filter(Boolean))].sort().join(",");
const pad4 = (v) => { const d = s(v).replace(/\D/g, ""); return d ? d.padStart(4, "0").slice(-4) : ""; };

/**
 * Find the executed trade in MFL's `transactions` export (TYPE=TRADE: franchise, franchise1_gave_up, franchise2, franchise2_gave_up, timestamp).
 * MFL gives a trade no id there, so the identity is the two franchises + the exact asset sets each gave up, at or after `sinceUnix`.
 * @param spec { from, to, give, receive, sinceUnix }  give = what `from` gave up, receive = what `to` gave up (CSV or arrays)
 */
// ── PER-FRANCHISE HOLD (Keith's ruling, 2026-09-29, §2.4.3a row 5/§2.4.3b step 6; moved here
// and made a shared export 2026-09-30, §8.6) ──
// A franchise with an unresolved drop-first sequence (some steps confirmed -- real, irreversible
// facts -- the rest not yet) has a KNOWN, BOUNDED uncertainty in its true roster/compliance
// state; a fresh, unrelated deal must never be built or accepted on top of that uncertainty.
// `partial_executed`/`executed_needs_review` are NEVER produced for a staged 2-way trade's
// ledger row by any path other than trade_2way.js's drop-first orchestrator (execute2Way's own
// failure path only ever moves to not_executed) -- so finding either state here is unambiguous,
// not a guess. Lives HERE, not in trade_2way.js, so the legacy direct-MFL 2-way path (index.js)
// and the 3-way engine (trade_3way.js, which trade_2way.js itself imports FROM) can both call it
// without a circular import. `excludeTradeId` lets the drop-first EXECUTOR itself call this
// (checking whether either franchise has an unresolved sequence on a DIFFERENT deal) without the
// check finding its own in-progress row and refusing to let a stuck deal ever resume itself.
export async function franchiseHasUnresolvedDropSequence(env, leagueId, season, fid, excludeTradeId) {
  try {
    // Keith's ruling (2026-09-30, second pass): "Fix the D1 binding fallback now, with a test
    // that proves an outbox DB failure cannot bypass or falsely satisfy the hold." UPS_MFL_DB is
    // where ups_2way_trades and ups_trade_executions actually live -- confirmed by every OTHER
    // read/write to these same tables throughout trade_2way.js, which requires env.UPS_MFL_DB
    // directly, never this fallback chain. The other names are legacy bindings from the outbox
    // subsystem (see wrangler.toml's TWB_OUTBOX_DB comment) that happen to point at the SAME
    // physical D1 in production today -- but preferring them here meant an outbox-only failure
    // (a different binding, degraded for a reason having nothing to do with this hold) could
    // make the hold check throw and fail closed, or -- worse, if a stale/mispointed binding ever
    // existed -- silently query the WRONG database and falsely report "no unresolved sequence."
    // UPS_MFL_DB first, unconditionally; the others are kept only as a last-resort fallback for
    // an environment that somehow never defines it at all.
    const db = env.UPS_MFL_DB || env.TWB_OUTBOX_DB || env.TWB_DB || env.DB;
    if (!db) throw new Error("no D1 binding");
    // The ledger table is created on demand -- a league/season where nothing has ever executed
    // yet legitimately has no ups_trade_executions table at all, and this query must not treat
    // that as an error.
    await db.prepare(LEDGER_DDL).run();
    const padFid = (v) => { const d = s(v).replace(/\D/g, ""); return d ? d.padStart(4, "0") : ""; };
    const row = await db.prepare(
      `SELECT t.id FROM ups_2way_trades t
        JOIN ups_trade_executions e ON e.exec_key = t.id AND e.league_id = t.league_id AND e.season = t.season
       WHERE t.league_id=? AND t.season=? AND (t.from_fid=? OR t.to_fid=?)
         AND e.state IN (?, ?)
         AND t.id != ?
       LIMIT 1`
    ).bind(s(leagueId), s(season), padFid(fid), padFid(fid), EXEC.PARTIAL_EXECUTED, EXEC.NEEDS_REVIEW, s(excludeTradeId) || "\0impossible\0").first();
    return !!row;
  } catch (e) {
    // ups_2way_trades itself is ALSO created on demand (never migration-gated, same convention
    // as every other outbox/ledger/store table in this codebase) -- a league/season where no
    // 2-way trade has EVER been staged genuinely has no such table, which is a PROVABLE "no
    // unresolved sequence exists" (not a guess: the only table that could hold one doesn't
    // exist), not the kind of ambiguity the NO-FAIL-OPEN rule below is protecting against.
    if (/no such table:\s*ups_2way_trades\b/i.test(s(e?.message))) return false;
    // NO FAIL-OPEN for every OTHER failure: if we can't tell, refuse to assume it's safe. Every
    // caller treats a thrown hold-check the same as "held."
    console.error(`[hold-check] failed for ${fid}: ${e?.message || e}`);
    throw e;
  }
}

export function findExecutedTrade(txData, spec) {
  let rows = txData && txData.transactions && txData.transactions.transaction;
  if (!Array.isArray(rows)) rows = rows ? [rows] : [];
  const from = pad4(spec.from), to = pad4(spec.to);
  const give = tokenSet(Array.isArray(spec.give) ? spec.give.join(",") : spec.give);
  const recv = tokenSet(Array.isArray(spec.receive) ? spec.receive.join(",") : spec.receive);
  const since = Number(spec.sinceUnix) || 0;
  for (const r of rows) {
    if (!r || String(r.type).toUpperCase() !== "TRADE") continue;
    const a = pad4(r.franchise), b = pad4(r.franchise2);
    const g1 = tokenSet(r.franchise1_gave_up), g2 = tokenSet(r.franchise2_gave_up);
    const direct = a === from && b === to && g1 === give && g2 === recv;
    const flipped = a === to && b === from && g1 === recv && g2 === give;
    if (!(direct || flipped)) continue;
    if (Number(r.timestamp) < since) continue;
    return { timestamp: String(r.timestamp), franchise: a, franchise2: b, franchise1_gave_up: s(r.franchise1_gave_up), franchise2_gave_up: s(r.franchise2_gave_up) };
  }
  return null;
}
