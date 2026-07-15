// auction_compliance.js — §F RULE 2: missed-nomination offenses + fines.
//
// Canon (league_context_v1.md §F RULE 2, written 2026-07-14):
//   1st offense — $3K,  applied to the current season AND the next season.
//   2nd offense — $7K,  ditto  ($10K total each year, cumulative).
//   3rd offense — $15K, ditto  ($25K total each year, cumulative).
//   4th offense — no fine. It's a conversation about league fit, not a
//                 transaction. Never automated; the commish is alerted.
//   Caveat     — a family emergency, or advance notice to a CC member, grants
//                 immunity. The commish voids the day and no penalty attaches.
//
// Two hard rules this module exists to enforce:
//
//   1. A day is only judged once it is CLOSED. Compliance is an ET-calendar-day
//      question, so "did they miss?" is unanswerable until midnight ET has
//      passed. The 9 AM report is the first moment yesterday's verdict is final;
//      the 9 PM report can only ever WARN about today.
//
//   2. The floor is WAIVED once a franchise can field a legal lineup (§A2). A
//      team sitting at 0/2 with a complete roster has done nothing wrong. Any
//      code that decides "missed" without consulting roster_met is broken.

import { getFeatureFlag } from "./feature_flags.js";

// $K per offense. Index 0 = 1st offense. Beyond this array there is no fine —
// see the 4th-offense note above.
export const RULE2_FINE_K_BY_OFFENSE = [3, 7, 15];
export const RULE2_MAX_FINED_OFFENSE = RULE2_FINE_K_BY_OFFENSE.length;

function safeStr(v) { return String(v == null ? "" : v).trim(); }
function padFid(v) { const d = safeStr(v).replace(/\D/g, ""); return d ? d.padStart(4, "0") : ""; }

// The fine for offense N (1-based), in $K. 0 = no fine (4th+).
export function rule2FineK(offenseNo) {
  const n = Number(offenseNo || 0);
  if (n < 1 || n > RULE2_MAX_FINED_OFFENSE) return 0;
  return RULE2_FINE_K_BY_OFFENSE[n - 1];
}

// Human label for a report line.
export function rule2Label(offenseNo) {
  const n = Number(offenseNo || 0);
  const ord = n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`;
  if (n > RULE2_MAX_FINED_OFFENSE) return `${ord} offense — league-fit review (no fine)`;
  const k = rule2FineK(n);
  return `${ord} offense — $${k}K this season + $${k}K next`;
}

// ET calendar day for a unix second, 'YYYY-MM-DD'. en-CA gives ISO order.
export function etDayKeyOf(unixSec) {
  return new Date(Number(unixSec) * 1000)
    .toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

// The ET day BEFORE the given one. Anchored on noon to sidestep DST — adding
// -24h to a midnight can land on the same calendar day across a shift.
export function previousEtDay(etDay) {
  const [y, m, d] = String(etDay).split("-").map(Number);
  const noonUtc = Date.UTC(y, m - 1, d, 16, 0, 0);   // ~noon ET in either offset
  return new Date(noonUtc - 86400000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

// Close out an ET day: write the immutable per-franchise fact rows, stamp
// offense numbers, and book the penalties. Idempotent — re-running for the same
// day is a no-op, because the 9 AM cron can retry and must never double-fine.
//
// rows: /api/auction/fa-schedule rows AS OF the close of `etDay`.
// Returns { day, closed, misses: [...], penalties: [...], already_closed }.
export async function closeEtDay(env, { season, leagueId, etDay, rows }) {
  const db = env.UPS_MFL_DB;
  if (!db) return { ok: false, error: "no_db" };

  const existing = await db.prepare(
    `SELECT COUNT(*) AS n FROM ups_faa_nom_days WHERE season=? AND league_id=? AND et_day=?`
  ).bind(Number(season), String(leagueId), String(etDay)).first();
  if (Number(existing?.n || 0) > 0) {
    return { ok: true, day: etDay, already_closed: true, misses: [], penalties: [] };
  }

  const misses = [];
  for (const r of (rows || [])) {
    const fid = padFid(r.franchise_id);
    if (!fid) continue;
    const used = Number(r.noms_used || 0);
    const required = Number(r.noms_required || 2);
    const rosterMet = !!r.roster_met;
    // The floor is waived once the roster is legal — §A2. This is the whole
    // ballgame: judging on `used < required` alone fines the one owner who
    // finished.
    const missed = !rosterMet && used < required;
    await db.prepare(
      `INSERT OR IGNORE INTO ups_faa_nom_days
         (season, league_id, fid, et_day, noms_used, noms_required, roster_met, total_deficit, missed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      Number(season), String(leagueId), fid, String(etDay),
      used, required, rosterMet ? 1 : 0, Number(r.total_deficit || 0), missed ? 1 : 0
    ).run();
    if (missed) misses.push({ fid, franchise_name: r.franchise_name, noms_used: used, noms_required: required });
  }

  // Book penalties for each miss, in a stable order so offense numbers are
  // deterministic when several teams miss the same day.
  const penalties = [];
  for (const m of misses.sort((a, b) => a.fid.localeCompare(b.fid))) {
    const p = await bookPenaltyForMiss(env, { season, leagueId, fid: m.fid, etDay });
    if (p) penalties.push({ ...p, franchise_name: m.franchise_name });
  }
  return { ok: true, day: etDay, closed: true, misses, penalties };
}

// Count PRIOR un-voided misses this auction, stamp the next offense number, and
// write the two penalty rows (current season + next season).
async function bookPenaltyForMiss(env, { season, leagueId, fid, etDay }) {
  const db = env.UPS_MFL_DB;
  const prior = await db.prepare(
    `SELECT COUNT(*) AS n FROM ups_faa_nom_days
      WHERE season=? AND league_id=? AND fid=? AND missed=1 AND voided=0 AND et_day < ?`
  ).bind(Number(season), String(leagueId), fid, String(etDay)).first();
  const offenseNo = Number(prior?.n || 0) + 1;
  const amountK = rule2FineK(offenseNo);

  // 4th+ offense carries no fine — no rows, just the number, so the report can
  // raise it with the commish.
  if (amountK <= 0) return { fid, et_day: etDay, offense_no: offenseNo, amount_k: 0, rows: 0 };

  // TWO rows: RULE 2 fines this season and next. They diverge on when they may
  // reach MFL — the next-season row is ledger-only until the rollover.
  for (const applies of [Number(season), Number(season) + 1]) {
    const id = `${season}|${leagueId}|${fid}|${etDay}|${applies}`;
    await db.prepare(
      `INSERT OR IGNORE INTO ups_faa_nom_penalties
         (penalty_id, season, league_id, fid, et_day, offense_no, amount_k, applies_to_season)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, Number(season), String(leagueId), fid, String(etDay), offenseNo, amountK, applies).run();
  }
  return { fid, et_day: etDay, offense_no: offenseNo, amount_k: amountK, rows: 2 };
}

// Per-franchise standing this auction, for the reports.
// Returns Map<fid, { offenses, fined_k_this_season, fined_k_next_season, days: [] }>
export async function complianceStandings(env, { season, leagueId }) {
  const db = env.UPS_MFL_DB;
  const out = new Map();
  if (!db) return out;
  const { results } = await db.prepare(
    `SELECT fid,
            SUM(CASE WHEN applies_to_season = ?      THEN amount_k ELSE 0 END) AS k_now,
            SUM(CASE WHEN applies_to_season = ? + 1  THEN amount_k ELSE 0 END) AS k_next,
            COUNT(DISTINCT et_day)                                            AS offenses
       FROM ups_faa_nom_penalties
      WHERE season=? AND league_id=? AND voided=0
      GROUP BY fid`
  ).bind(Number(season), Number(season), Number(season), String(leagueId)).all();
  for (const r of (results || [])) {
    out.set(padFid(r.fid), {
      offenses: Number(r.offenses || 0),
      fined_k_this_season: Number(r.k_now || 0),
      fined_k_next_season: Number(r.k_next || 0),
    });
  }
  return out;
}

// Penalties that are allowed to post to MFL right now: current-season only, not
// voided, not already posted. The next-season rows are deliberately invisible
// here — they cross over at the rollover, not before.
export async function pendingMflPenalties(env, { season, leagueId }) {
  const db = env.UPS_MFL_DB;
  if (!db) return [];
  if (!(await getFeatureFlag(env, "AUCTION_FAA_PENALTIES_ENABLED"))) return [];
  const { results } = await db.prepare(
    `SELECT * FROM ups_faa_nom_penalties
      WHERE season=? AND league_id=? AND applies_to_season=?
        AND voided=0 AND posted_to_mfl=0`
  ).bind(Number(season), String(leagueId), Number(season)).all();
  return results || [];
}

// Commish override (§F RULE 2 caveat). Voids the DAY and every penalty it
// caused, in one transaction-ish sweep. Voiding is not deleting: the row stays
// as evidence that the owner called ahead, which is what protects them if it
// comes up again.
//
// Later offenses are NOT renumbered. Their offense_no was stamped from the
// facts known when they were booked, and re-deriving history to match a later
// ruling would silently re-price a fine an owner has already been told about.
// The reports count un-voided days, so the standings read correctly regardless.
export async function voidNomDay(env, { season, leagueId, fid, etDay, reason, by }) {
  const db = env.UPS_MFL_DB;
  if (!db) return { ok: false, error: "no_db" };
  const f = padFid(fid);
  const now = new Date().toISOString();
  const d = await db.prepare(
    `UPDATE ups_faa_nom_days
        SET voided=1, void_reason=?, voided_by=?, voided_at_utc=?
      WHERE season=? AND league_id=? AND fid=? AND et_day=? AND voided=0`
  ).bind(safeStr(reason) || null, safeStr(by) || null, now,
    Number(season), String(leagueId), f, String(etDay)).run();
  const p = await db.prepare(
    `UPDATE ups_faa_nom_penalties
        SET voided=1, void_reason=?, voided_by=?, voided_at_utc=?
      WHERE season=? AND league_id=? AND fid=? AND et_day=? AND voided=0`
  ).bind(safeStr(reason) || null, safeStr(by) || null, now,
    Number(season), String(leagueId), f, String(etDay)).run();
  return {
    ok: true,
    days_voided: d.meta?.changes || 0,
    penalties_voided: p.meta?.changes || 0,
    // A penalty already posted to MFL needs its salaryAdj reversed by hand —
    // voiding the row does NOT undo the write.
    needs_mfl_reversal: await postedCount(env, { season, leagueId, fid: f, etDay }),
  };
}

async function postedCount(env, { season, leagueId, fid, etDay }) {
  const r = await env.UPS_MFL_DB.prepare(
    `SELECT COUNT(*) AS n FROM ups_faa_nom_penalties
      WHERE season=? AND league_id=? AND fid=? AND et_day=? AND posted_to_mfl=1`
  ).bind(Number(season), String(leagueId), fid, String(etDay)).first();
  return Number(r?.n || 0);
}
