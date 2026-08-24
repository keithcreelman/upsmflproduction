// §C3 Mid-Year Multi guards — the two limits the worker was believed to enforce
// and did not.
//
// site/m/front_office_mym_submit.js line 10 says, verbatim:
//
//     "Max 4 MYMs per team per season — the WORKER enforces the 14-day window
//      AND the 4-per-season cap on submit; this client is best-effort."
//
// Neither check existed. Verified 2026-08-17 across the whole worker: no count
// of ups_mym_submissions per franchise-season anywhere outside a historical
// import's dupe check, and no 14-day test on the submit path. The client that
// disclaims authority was the only thing enforcing either rule, which means a
// direct POST to /offer-mym bypassed both.
//
// Keith 2026-08-17: build them.
//
// WHY THIS FAILS CLOSED IN THE OWNER'S FAVOUR. A guard that cannot read its own
// inputs must not block a legal submission — an owner locked out of a contract
// window they are entitled to is a worse failure than one extra MYM the commish
// can unwind. So every unreadable input returns `allowed: true` with a stated
// reason, and the reason is surfaced rather than swallowed.

const _s = (v) => String(v == null ? "" : v).trim();
const _fid = (v) => { const d = _s(v).replace(/\D/g, ""); return d ? d.padStart(4, "0") : ""; };

// §C3, raised from 3 in 2025.
export const MYM_MAX_PER_SEASON = 4;
// §C3: an in-season WW/FCFS pickup carries a 14-day MYM window from acquisition.
export const MYM_WINDOW_DAYS = 14;

// How many MYMs this franchise has already used this season.
// dry_run rows are excluded — a simulated submission is not a used slot.
export async function mymSeasonCount(env, { season, leagueId, fid }) {
  const db = env && env.UPS_MFL_DB;
  if (!db) return null;                       // unreadable -> caller must not block
  try {
    const r = await db.prepare(
      `SELECT COUNT(*) AS n FROM ups_mym_submissions
        WHERE league_id = ? AND season = ? AND franchise_id = ? AND COALESCE(dry_run, 0) = 0`
    ).bind(String(leagueId), String(season), _fid(fid)).first();
    return Number(r && r.n) || 0;
  } catch (_) { return null; }
}

// The 4-per-season cap.
export async function checkMymSeasonCap(env, { season, leagueId, fid }) {
  const used = await mymSeasonCount(env, { season, leagueId, fid });
  if (used == null) {
    return { allowed: true, reason: "mym_count_unreadable", used: null, max: MYM_MAX_PER_SEASON };
  }
  return {
    allowed: used < MYM_MAX_PER_SEASON,
    reason: used < MYM_MAX_PER_SEASON ? "" : "mym_season_cap",
    used, max: MYM_MAX_PER_SEASON,
    detail: used < MYM_MAX_PER_SEASON
      ? ""
      : `This franchise has already used ${used} of ${MYM_MAX_PER_SEASON} Mid-Year Multis this season (§C3).`,
  };
}

// The 14-day window, measured from the acquisition that started it.
//
// ups_add_events is the acquisition record (bbid | fcfs, with acquired_at_unix).
// Canon §C3: the clock does NOT reset on trade, so the ORIGINAL add is the
// anchor — which is exactly what this table holds, since a trade writes no add
// event. Nothing extra is needed to honour that rule; it falls out of the source.
//
// A player with no add event is a preseason/auction/draft acquisition, whose MYM
// eligibility runs to the Week 3 deadline rather than a 14-day clock. That is a
// different rule with a different deadline, so this guard stands aside for it.
export async function checkMymWindow(env, { season, leagueId, fid, playerId, nowUnix }) {
  const db = env && env.UPS_MFL_DB;
  const now = Number(nowUnix) || Math.floor(Date.now() / 1000);
  if (!db) return { allowed: true, reason: "no_db" };
  let row = null;
  try {
    row = await db.prepare(
      `SELECT acquired_at_unix, source FROM ups_add_events
        WHERE season = ? AND league_id = ? AND player_id = ? AND franchise_id = ?
        ORDER BY acquired_at_unix DESC LIMIT 1`
    ).bind(String(season), String(leagueId), _s(playerId), _fid(fid)).first();
  } catch (_) {
    return { allowed: true, reason: "add_events_unreadable" };
  }
  const at = Number(row && row.acquired_at_unix) || 0;
  if (!at) {
    // No in-season add on record. Not a violation — a different window governs.
    return { allowed: true, reason: "no_in_season_add" };
  }
  const closes = at + MYM_WINDOW_DAYS * 86400;
  return {
    allowed: now <= closes,
    reason: now <= closes ? "" : "mym_window_closed",
    acquired_at_unix: at,
    closes_unix: closes,
    source: _s(row && row.source),
    detail: now <= closes
      ? ""
      : `The 14-day Mid-Year Multi window for this player closed ${new Date(closes * 1000)
          .toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ET (§C3). It runs from acquisition and does not reset on trade.`,
  };
}

// Both guards, for the submit path. Returns the FIRST blocking reason so the
// owner gets one clear message rather than a list.
export async function checkMymEligibility(env, { season, leagueId, fid, playerId, nowUnix, isCommishOverride }) {
  const cap = await checkMymSeasonCap(env, { season, leagueId, fid });
  const win = await checkMymWindow(env, { season, leagueId, fid, playerId, nowUnix });
  const blocked = !cap.allowed ? cap : (!win.allowed ? win : null);
  // The commissioner can always push one through — §C3's limits are league
  // rules, not data integrity, and every other submit guard in this worker
  // yields to the commish the same way. The override is RECORDED, not silent.
  if (blocked && isCommishOverride) {
    return { allowed: true, overridden: true, reason: blocked.reason, detail: blocked.detail, cap, window: win };
  }
  return blocked
    ? { allowed: false, reason: blocked.reason, detail: blocked.detail, cap, window: win }
    : { allowed: true, cap, window: win };
}
