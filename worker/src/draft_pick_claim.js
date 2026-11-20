// draft_pick_claim.js — one row per rookie-draft pick slot, written BEFORE the worker calls MFL or posts to Discord,
// so a slot is submitted and announced at most once no matter how many times (or how concurrently) the request arrives.
//
// Same shape as the trade execution ledger (trade_execution.js): lock before MFL, MFL success is permanent, and nothing
// after a confirmed write ever calls MFL again.
//
//   (no row) ──claim──▶ claimed ──MFL accepted──▶ mfl_accepted ──announced or muted──▶ done
//                         │  │                          └── announcement not delivered ──▶ announce_failed   (the pick stands)
//                         │  └── MFL refused it ──▶ released ──claim──▶ claimed       (nothing was drafted; a corrected retry may run)
//                         └── no clear answer from MFL ──▶ mfl_unknown                 (held: check the board; never resent from here)
//
//   rehearsal (dry_run): claimed ──test post sent──▶ done   |   test post definitely not sent ──▶ released
//
// Only `released` can be claimed again. Every move is a compare-and-set on the claim's own lock token, so two requests can
// never both hold a slot. If the claim can't be written or read, the caller must do nothing (fail closed).
//
// The table is created on demand (CREATE TABLE IF NOT EXISTS, exactly this DDL) and also shipped as migration
// 0173_ups_draft_pick_claims.sql, so the worker does not depend on the migration being applied first.

export const PICK_CLAIM_DDL = `CREATE TABLE IF NOT EXISTS ups_draft_pick_claims (
  league_id       TEXT NOT NULL,
  season          TEXT NOT NULL,
  claim_key       TEXT NOT NULL,
  mode            TEXT NOT NULL,
  round           INTEGER NOT NULL,
  pick            INTEGER NOT NULL,
  franchise_id    TEXT NOT NULL,
  player_id       TEXT NOT NULL,
  actor           TEXT NOT NULL,
  state           TEXT NOT NULL,
  lock_token      TEXT NOT NULL,
  detail          TEXT,
  created_at_utc  TEXT NOT NULL,
  updated_at_utc  TEXT NOT NULL,
  PRIMARY KEY (league_id, season, claim_key)
)`;

export const PICK_STATE = Object.freeze({
  CLAIMED: "claimed",
  MFL_ACCEPTED: "mfl_accepted",
  DONE: "done",
  ANNOUNCE_FAILED: "announce_failed",
  MFL_UNKNOWN: "mfl_unknown",
  RELEASED: "released",
});

// The only legal moves out of each state (`released` is re-entered only through claim()).
const FROM = Object.freeze({
  [PICK_STATE.MFL_ACCEPTED]: [PICK_STATE.CLAIMED],
  [PICK_STATE.MFL_UNKNOWN]: [PICK_STATE.CLAIMED],
  [PICK_STATE.RELEASED]: [PICK_STATE.CLAIMED],
  [PICK_STATE.DONE]: [PICK_STATE.CLAIMED, PICK_STATE.MFL_ACCEPTED],   // CLAIMED → DONE is the rehearsal path (no MFL step)
  [PICK_STATE.ANNOUNCE_FAILED]: [PICK_STATE.MFL_ACCEPTED],
});

export const PICK_MODES = Object.freeze(["live", "dry_run"]);

const s = (v) => String(v == null ? "" : v).trim();
const nowIso = () => new Date().toISOString();
const newToken = () => { try { return crypto.randomUUID(); } catch (_) { return `t-${Date.now()}-${Math.floor(Math.random() * 1e9)}`; } };
const changes = (r) => Number(r && r.meta && r.meta.changes != null ? r.meta.changes : r && r.changes != null ? r.changes : 0);

/** "live:R1.04" / "dry_run:R1.04" — one key per slot per mode. */
export function pickClaimKey(mode, round, pick) {
  const m = s(mode);
  const r = Number(round), p = Number(pick);
  if (!PICK_MODES.includes(m)) throw new Error(`pick claim: unknown mode ${m}`);
  if (!Number.isInteger(r) || r < 1 || !Number.isInteger(p) || p < 1) throw new Error("pick claim: round and pick are required");
  return `${m}:R${r}.${String(p).padStart(2, "0")}`;
}

/** True only when a Discord post provably did not go out (an error status, or nothing was sent). A thrown request is not proof. */
export function discordPostNotSent(res) {
  if (!res || res.ok) return false;
  if (res.error === "missing_discord_config") return true;
  return Number(res.status) >= 400;
}

export function makePickClaims(db) {
  if (!db || typeof db.prepare !== "function") throw new Error("pick claim: no D1 binding");
  let ensured = false;
  const ensure = async () => { if (!ensured) { await db.prepare(PICK_CLAIM_DDL).run(); ensured = true; } };

  const read = async (leagueId, season, claimKey) => {
    await ensure();
    return await db.prepare("SELECT * FROM ups_draft_pick_claims WHERE league_id=? AND season=? AND claim_key=?")
      .bind(s(leagueId), s(season), s(claimKey)).first();
  };

  /**
   * Take the slot. Exactly one caller can: a new row is inserted `claimed`, or a `released` row (MFL refused an earlier
   * attempt, nothing was drafted) is moved back to `claimed`. Otherwise returns { acquired:false, row } and the caller
   * must not call MFL or Discord.
   */
  const claim = async (c) => {
    await ensure();
    const leagueId = s(c.leagueId), season = s(c.season), mode = s(c.mode);
    const key = pickClaimKey(mode, c.round, c.pick);
    if (!leagueId || !season) throw new Error("pick claim: league and season are required");
    const token = newToken(), at = nowIso();
    const ins = await db.prepare(
      `INSERT INTO ups_draft_pick_claims (league_id, season, claim_key, mode, round, pick, franchise_id, player_id, actor, state, lock_token, created_at_utc, updated_at_utc)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(league_id, season, claim_key) DO NOTHING`
    ).bind(leagueId, season, key, mode, Number(c.round), Number(c.pick), s(c.franchiseId), s(c.playerId), s(c.actor), PICK_STATE.CLAIMED, token, at, at).run();
    const ref = { leagueId, season, claimKey: key };
    if (changes(ins) === 1) return { acquired: true, token, ref };
    const upd = await db.prepare(
      `UPDATE ups_draft_pick_claims SET state=?, lock_token=?, franchise_id=?, player_id=?, actor=?, detail=NULL, updated_at_utc=?
        WHERE league_id=? AND season=? AND claim_key=? AND state=?`
    ).bind(PICK_STATE.CLAIMED, token, s(c.franchiseId), s(c.playerId), s(c.actor), at, leagueId, season, key, PICK_STATE.RELEASED).run();
    if (changes(upd) === 1) return { acquired: true, token, ref };
    return { acquired: false, ref, row: await read(leagueId, season, key) };
  };

  /** Compare-and-set a move for the holder of `token`. Returns true iff this call made the change. */
  const settle = async (ref, token, to, detail) => {
    await ensure();
    const froms = FROM[to];
    if (!froms) throw new Error(`pick claim: cannot move to ${to}`);
    const r = await db.prepare(
      `UPDATE ups_draft_pick_claims SET state=?, detail=?, updated_at_utc=?
        WHERE league_id=? AND season=? AND claim_key=? AND lock_token=? AND state IN (${froms.map(() => "?").join(",")})`
    ).bind(to, detail == null ? null : s(detail).slice(0, 1000), nowIso(), s(ref.leagueId), s(ref.season), s(ref.claimKey), s(token), ...froms).run();
    return changes(r) === 1;
  };

  return { ensure, read, claim, settle };
}
