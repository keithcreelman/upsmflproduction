// auction_compliance.js — §F RULE 2: missed-nomination offenses + fines.
//
// Canon (league_context_v1.md §F RULE 2, written 2026-07-14):
//   1st offense — $3K,  applied to the current season AND the next season.
//   2nd offense — $7K,  ditto  ($10K total each year, cumulative).
//   3rd offense — $15K, ditto  ($25K total each year, cumulative).
//   4th offense — no fine. It's a conversation about league fit, not a
//                 transaction. Never automated; the commish is alerted.
//   Caveat     — a family emergency, or advance notice to THE LEAGUE, grants
//                 immunity. (Canon quotes "a member of a CC"; the CC no longer
//                 exists — Keith 2026-07-15 — so notice to the league is the
//                 standard. A heads-up, not an application.) The commish voids
//                 the day and no penalty attaches.
//   Re-engagement forfeit (Keith 2026-07-29) — the roster-legal floor waiver
//                 is not a license to keep actively bidding while skipping
//                 nominations. After a missed day, staying excused requires
//                 either going fully passive (no new bids/noms at all) or
//                 letting only already-open lots resolve. Placing any NEW bid
//                 or nomination without having cured forfeits the waiver — the
//                 missed day counts for real, same as non-compliance. This is
//                 judgment, not a formula (same reason the 4th-offense
//                 "league fit" call and the immunity caveat are commish-driven,
//                 not automatic) — see flagReengagementMiss(), the mirror
//                 image of voidNomDay().
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
//      (The re-engagement forfeit above is the commish-driven exception to
//      this — it never runs automatically inside closeEtDay/nomCountsForDay.)

import { getFeatureFlag } from "./feature_flags.js";
import { etDayBounds, faaNomSchedule } from "./auction_windows.js";
import { getAuctionCalendar } from "./auction_calendar.js";

// $K per offense. Index 0 = 1st offense. Beyond this array there is no fine —
// see the 4th-offense note above.
export const RULE2_FINE_K_BY_OFFENSE = [3, 7, 15];
export const RULE2_MAX_FINED_OFFENSE = RULE2_FINE_K_BY_OFFENSE.length;

// EXTRA NOMINATIONS — the other half of §F RULE 2 (canon §T4.3a, Keith's text
// supplied 2026-08-17). The same ladder shifted one rung, with a warning at the
// front: warning -> $3K -> $7K -> $15K -> league-fit review.
//
// The free first offense is not leniency about harm. Canon's Principle 0 prices
// offense #1 on whether a diligent owner can trip it BY ACCIDENT — Keith on
// over-nominating: "It can happen by accident we've all done it"; on missing
// one: "you need to be dumb as shit not to understand to nominate 2 guys in a
// day." A stray tap explains one; a whole ET day of silence does not.
export const RULE2_OVER_FINE_K_BY_OFFENSE = [0, 3, 7, 15];
export const RULE2_OVER_MAX_OFFENSE = RULE2_OVER_FINE_K_BY_OFFENSE.length;

// The nomination CEILING is a hard 2, every franchise, every day — §A2: "The
// ceiling is unconditional — it applies to every franchise every day, including
// one that has already met its roster requirement."
//
// Deliberately NOT `noms_required`. The floor is conditional (waived once the
// roster is legal) and could in principle be set to something other than 2; the
// ceiling is neither. Deriving the ceiling from the floor would silently let a
// franchise with a waived floor nominate freely, which is the exact case §A2
// calls out.
export const NOM_MAX_PER_DAY = 2;

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

// The fine for extra-nomination offense N (1-based), in $K. 0 = no fine, which
// means TWO different things on this ladder — a 1st-offense warning and a
// 5th-offense league-fit review. Callers that show it to a human must use
// rule2OverLabel(), which distinguishes them; callers that only write money can
// treat both as "no rows".
export function rule2OverFineK(offenseNo) {
  const n = Number(offenseNo || 0);
  if (n < 1 || n > RULE2_OVER_MAX_OFFENSE) return 0;
  return RULE2_OVER_FINE_K_BY_OFFENSE[n - 1];
}

export function rule2OverLabel(offenseNo) {
  const n = Number(offenseNo || 0);
  const ord = n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`;
  if (n === 1) return "1st extra nomination — warning, no fine";
  if (n > RULE2_OVER_MAX_OFFENSE) return `${ord} extra nomination — league-fit review (no fine)`;
  const k = rule2OverFineK(n);
  return `${ord} extra nomination — $${k}K this season + $${k}K next`;
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

// Nominations each franchise actually made ON `etDay`, counted from the bid
// ledger the */5 poll has been writing all along.
//
// This CANNOT come from /api/auction/fa-schedule. That endpoint reports the
// CURRENT window, and the 9 AM report runs nine hours after the window it is
// judging has closed and a new one has reset every counter to zero. Handing it
// yesterday's date and today's rows records all 12 franchises at 0/2 and fines
// the entire league, every morning, forever — including the owner who nominated
// three times. (Caught by previewing the real output on 2026-07-15: six teams
// had nominated the day before; the report claimed nobody had.)
//
// Counting from ups_auction_bids also picks up nominations made natively on
// MFL's own O=43 page, which is the same reason the §A2 cap counts them there.
async function nomCountsForDay(env, { season, leagueId, etDay }) {
  const bounds = etDayBounds(etDay);
  if (!bounds) return {};
  const { results } = await env.UPS_MFL_DB.prepare(
    `SELECT fid, COUNT(DISTINCT player_id) AS n
       FROM ups_auction_bids
      WHERE season = ? AND league_id = ?
        AND note LIKE '[nomination]%'
        AND bid_at_unix >= ? AND bid_at_unix < ?
      GROUP BY fid`
  ).bind(Number(season), String(leagueId), bounds.start_unix, bounds.end_unix).all();
  const out = {};
  for (const r of (results || [])) out[padFid(r.fid)] = Number(r.n || 0);
  return out;
}

// Close out an ET day: write the immutable per-franchise fact rows, stamp
// offense numbers, and book the penalties. Idempotent — re-running for the same
// day is a no-op, because the 9 AM cron can retry and must never double-fine.
//
// rows: /api/auction/fa-schedule rows — used ONLY for the franchise list and
//       roster state. The nomination COUNT comes from the ledger (see above);
//       fa-schedule's noms_used describes today, not the day being closed.
//
// roster_met is read as of NOW rather than as of the close. Rosters only grow,
// so the only drift is a franchise that became legal overnight being excused
// for a miss it technically made — lenient, and lenient is the right direction
// for a rule that ends in a fine.
//
// Returns { day, closed, misses: [...], penalties: [...], already_closed }.
// positionsOk: pass buildFaScheduleRows' `positions_ok`. Defaults to true so
// existing/manual callers are unaffected; the unattended nightly job passes the
// real value, which is where the hazard lives.
export async function closeEtDay(env, { season, leagueId, etDay, rows, positionsOk = true }) {
  const db = env.UPS_MFL_DB;
  if (!db) return { ok: false, error: "no_db" };

  const existing = await db.prepare(
    `SELECT COUNT(*) AS n FROM ups_faa_nom_days WHERE season=? AND league_id=? AND et_day=?`
  ).bind(Number(season), String(leagueId), String(etDay)).first();
  if (Number(existing?.n || 0) > 0) {
    return { ok: true, day: etDay, already_closed: true, misses: [], penalties: [] };
  }

  // ── Nomination-schedule guard ─────────────────────────────────────────
  // Days AFTER the configured last-day-to-nominate have no nomination window
  // at all — nothing to owe, nothing to fine. (The final day itself still
  // closes normally: the 2-nom FLOOR applies there; only the ceiling was
  // waived.) Unset deadline ⇒ every day is a window (pre-2026 behavior).
  try {
    const sched = faaNomSchedule((await getAuctionCalendar(env))?.faa?.faa_nom_deadline_at, null);
    if (sched.configured && String(etDay) > sched.final_day_key) {
      return { ok: true, day: etDay, no_window: true, misses: [], penalties: [] };
    }
  } catch (_) { /* schedule unavailable → close normally */ }

  // ── Ledger-freshness interlock ────────────────────────────────────────
  // NEVER judge a day the poll hasn't fully ingested. The verdict below reads
  // nomination counts from ups_auction_bids, which only the auction poll
  // feeds; if the poll is dead, a franchise that nominated on MFL looks like
  // a miss here, and this function then writes an immutable missed=1 fact row
  // and books a real two-season fine. Not hypothetical: on 2026-07-15
  // Cloudflare stopped invoking the crons at 12:10 UTC, franchise 0006
  // nominated twice at 12:37/12:38 (meeting §A2), D1 never saw it, and the
  // next close would have fined them $3K+$3K for a day they completed.
  //
  // The guard: the poll must have COMPLETED a run after the day being judged
  // ended (heartbeat is stamped only on completion). Because MFL timestamps
  // every bid, a poll that finishes after day-end has necessarily captured
  // that day in full — late ingestion lands in the correct ET day. +300s
  // grace covers a run that straddles midnight ET.
  //
  // Refusing is always recoverable: the day stays unclosed and the next
  // morning-job run (cron or manual re-run) closes it once the ledger is
  // fresh. A wrong close is only recoverable through the commish void UI.
  const bounds = etDayBounds(etDay);
  if (bounds) {
    const hb = await db.prepare(
      `SELECT last_ts FROM ups_bot_heartbeat WHERE bot = 'auction_poll'`
    ).first().catch(() => null);
    const pollTs = Number(hb?.last_ts || 0);
    const requiredAfter = Number(bounds.end_unix) + 300;
    if (pollTs < requiredAfter) {
      return {
        ok: false, error: "ledger_stale", day: etDay,
        poll_last_ts: pollTs || null, required_after_unix: requiredAfter,
        misses: [], penalties: [],
      };
    }
  }

  // ── Roster state must be KNOWN before it can excuse or condemn anyone ────
  // Exactly the ledger_stale argument above, one input over. §A2's floor waiver
  // hinges on roster_met, and roster_met is derived from player POSITIONS,
  // which come from one place: MFL's players export, fetched in 200-id chunks.
  // A dropped chunk used to be skipped silently, leaving those players with no
  // position; computeLineupNeeds counts a positionless player toward no slot,
  // so the affected franchises score a full 18-slot deficit and read as
  // roster-incomplete. That flips roster_met false for teams that are actually
  // fine, and this function then fines them for a floor they were entitled to
  // have waived — an immutable missed=1 row, a two-season penalty, and (with
  // fines armed) a real MFL salaryAdjustment.
  //
  // A PARTIAL failure is the dangerous one: half the league looking short reads
  // as plausible league state, not as an outage.
  //
  // Same recovery asymmetry as ledger_stale: refusing leaves the day unclosed
  // for the next run to pick up; a wrong close is undone only by hand.
  if (positionsOk === false) {
    return {
      ok: false, error: "roster_state_unknown", day: etDay,
      detail: "players export incomplete — positions missing, so roster_met is unreliable",
      misses: [], penalties: [],
    };
  }

  const nomCounts = await nomCountsForDay(env, { season, leagueId, etDay });

  // ── Fines-dark auto-void ────────────────────────────────────────────────
  // While AUCTION_FAA_PENALTIES_ENABLED is off (test weeks), a close still
  // records everything — the misses, the day rows, the penalty rows with
  // their amounts — but writes every missed day and its penalties PRE-VOIDED
  // (void_reason says why). The report copy is unchanged (it renders from the
  // returned objects), the void UI shows them as excused evidence, and the
  // offense ladder ignores them, so the first REAL miss after arming books as
  // a 1st offense at $3K. Without this, the 2026-07-14 test close banked 20
  // live penalty rows and every owner's first genuine miss on auction day
  // would have priced as a 2nd offense at $7K. Keith 2026-07-15: record
  // nothing (that counts) until fines are armed.
  const armed = !!(await getFeatureFlag(env, "AUCTION_FAA_PENALTIES_ENABLED"));

  const misses = [];
  const overs = [];
  for (const r of (rows || [])) {
    const fid = padFid(r.franchise_id);
    if (!fid) continue;
    const used = Number(nomCounts[fid] || 0);
    const required = Number(r.noms_required || 2);
    const rosterMet = !!r.roster_met;
    // The floor is waived once the roster is legal — §A2. This is the whole
    // ballgame: judging on `used < required` alone fines the one owner who
    // finished.
    const missed = !rosterMet && used < required;
    // The CEILING is not waived by anything (§A2), so this is deliberately
    // independent of rosterMet and of `required` — see NOM_MAX_PER_DAY. The two
    // verdicts are mutually exclusive (used cannot be both < 2 and > 2), which
    // is why one row per franchise per day still holds.
    const over = used > NOM_MAX_PER_DAY;
    const autoVoid = (missed || over) && !armed;
    await db.prepare(
      `INSERT OR IGNORE INTO ups_faa_nom_days
         (season, league_id, fid, et_day, noms_used, noms_required, roster_met, total_deficit, missed, over,
          voided, void_reason, voided_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      Number(season), String(leagueId), fid, String(etDay),
      used, required, rosterMet ? 1 : 0, Number(r.total_deficit || 0), missed ? 1 : 0, over ? 1 : 0,
      autoVoid ? 1 : 0, autoVoid ? "auto: fines dark (pre-auction test)" : null, autoVoid ? "system" : null
    ).run();
    if (missed) misses.push({ fid, franchise_name: r.franchise_name, noms_used: used, noms_required: required });
    if (over) overs.push({ fid, franchise_name: r.franchise_name, noms_used: used, noms_max: NOM_MAX_PER_DAY });
  }

  // Book penalties for each miss, in a stable order so offense numbers are
  // deterministic when several teams miss the same day.
  const penalties = [];
  for (const m of misses.sort((a, b) => a.fid.localeCompare(b.fid))) {
    const p = await bookPenaltyForMiss(env, { season, leagueId, fid: m.fid, etDay, armed });
    if (p) penalties.push({ ...p, franchise_name: m.franchise_name });
  }
  // Same for over-nominations, on their own ladder and their own offense count.
  // The two ladders never share an offense number: missing Tuesday and
  // over-nominating Friday is a 1st offense on each, not a 2nd on either.
  const overPenalties = [];
  for (const o of overs.sort((a, b) => a.fid.localeCompare(b.fid))) {
    const p = await bookPenaltyForOver(env, { season, leagueId, fid: o.fid, etDay, armed });
    if (p) overPenalties.push({ ...p, franchise_name: o.franchise_name, noms_used: o.noms_used });
  }
  return {
    ok: true, day: etDay, closed: true,
    misses, penalties,
    overs, over_penalties: overPenalties,
    penalties_armed: armed,
  };
}

// Count PRIOR un-voided misses this auction, stamp the next offense number, and
// write the two penalty rows (current season + next season).
async function bookPenaltyForMiss(env, { season, leagueId, fid, etDay, armed = true }) {
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
         (penalty_id, season, league_id, fid, et_day, offense_no, amount_k, applies_to_season,
          voided, void_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, Number(season), String(leagueId), fid, String(etDay), offenseNo, amountK, applies,
      armed ? 0 : 1, armed ? null : "auto: fines dark (pre-auction test)").run();
  }
  return { fid, et_day: etDay, offense_no: offenseNo, amount_k: amountK, rows: 2, voided: !armed };
}

// The over-nomination twin of bookPenaltyForMiss. Same shape, different ladder
// and a different counting column, so the two offense counts stay independent.
async function bookPenaltyForOver(env, { season, leagueId, fid, etDay, armed = true }) {
  const db = env.UPS_MFL_DB;
  const prior = await db.prepare(
    `SELECT COUNT(*) AS n FROM ups_faa_nom_days
      WHERE season=? AND league_id=? AND fid=? AND over=1 AND voided=0 AND et_day < ?`
  ).bind(Number(season), String(leagueId), fid, String(etDay)).first();
  const offenseNo = Number(prior?.n || 0) + 1;
  const amountK = rule2OverFineK(offenseNo);

  // Two different no-money outcomes, both returning zero rows: the 1st-offense
  // warning and the 5th-offense league-fit review. The offense number is what
  // tells them apart — rule2OverLabel() renders the difference for the report.
  if (amountK <= 0) {
    return {
      fid, et_day: etDay, offense_no: offenseNo, amount_k: 0, rows: 0,
      kind: "over",
      outcome: offenseNo === 1 ? "warning" : "league_fit_review",
    };
  }

  for (const applies of [Number(season), Number(season) + 1]) {
    // '|over' suffix keeps these distinct from miss ids. Miss ids stay in their
    // original 5-part form — rewriting them would orphan rows already posted to
    // MFL whose salaryAdj notes reference them.
    const id = `${season}|${leagueId}|${fid}|${etDay}|${applies}|over`;
    await db.prepare(
      `INSERT OR IGNORE INTO ups_faa_nom_penalties
         (penalty_id, season, league_id, fid, et_day, offense_no, amount_k, applies_to_season,
          kind, voided, void_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'over', ?, ?)`
    ).bind(id, Number(season), String(leagueId), fid, String(etDay), offenseNo, amountK, applies,
      armed ? 0 : 1, armed ? null : "auto: fines dark (pre-auction test)").run();
  }
  return { fid, et_day: etDay, offense_no: offenseNo, amount_k: amountK, rows: 2, kind: "over", voided: !armed };
}

// Per-franchise standing this auction, for the reports.
// Returns Map<fid, { offenses, fined_k_this_season, fined_k_next_season, days: [] }>
export async function complianceStandings(env, { season, leagueId }) {
  const db = env.UPS_MFL_DB;
  const out = new Map();
  if (!db) return out;
  // kind='miss' is LOAD-BEARING, not tidiness. Without it, extra-nomination
  // rows landing in the same table would silently inflate every existing
  // report's offense count and fine total the first time somebody
  // over-nominates. The two ladders are separate offenses and must never merge.
  const { results } = await db.prepare(
    `SELECT fid,
            SUM(CASE WHEN applies_to_season = ?      THEN amount_k ELSE 0 END) AS k_now,
            SUM(CASE WHEN applies_to_season = ? + 1  THEN amount_k ELSE 0 END) AS k_next,
            COUNT(DISTINCT et_day)                                            AS offenses
       FROM ups_faa_nom_penalties
      WHERE season=? AND league_id=? AND voided=0 AND kind='miss'
      GROUP BY fid`
  ).bind(Number(season), Number(season), Number(season), String(leagueId)).all();
  for (const r of (results || [])) {
    out.set(padFid(r.fid), {
      offenses: Number(r.offenses || 0),
      fined_k_this_season: Number(r.k_now || 0),
      fined_k_next_season: Number(r.k_next || 0),
      over_offenses: 0,
      over_fined_k_this_season: 0,
      over_fined_k_next_season: 0,
    });
  }

  // Over-nomination standing, counted from the DAYS table rather than the
  // penalties table — a 1st offense is a warning and books no penalty rows, so
  // counting money would report an owner who over-nominated as having done
  // nothing. The fine totals still come from the penalties table.
  const { results: overDays } = await db.prepare(
    `SELECT fid, COUNT(*) AS n FROM ups_faa_nom_days
      WHERE season=? AND league_id=? AND over=1 AND voided=0
      GROUP BY fid`
  ).bind(Number(season), String(leagueId)).all();
  const { results: overMoney } = await db.prepare(
    `SELECT fid,
            SUM(CASE WHEN applies_to_season = ?      THEN amount_k ELSE 0 END) AS k_now,
            SUM(CASE WHEN applies_to_season = ? + 1  THEN amount_k ELSE 0 END) AS k_next
       FROM ups_faa_nom_penalties
      WHERE season=? AND league_id=? AND voided=0 AND kind='over'
      GROUP BY fid`
  ).bind(Number(season), Number(season), Number(season), String(leagueId)).all();

  const blank = () => ({
    offenses: 0, fined_k_this_season: 0, fined_k_next_season: 0,
    over_offenses: 0, over_fined_k_this_season: 0, over_fined_k_next_season: 0,
  });
  for (const r of (overDays || [])) {
    const f = padFid(r.fid);
    if (!out.has(f)) out.set(f, blank());
    out.get(f).over_offenses = Number(r.n || 0);
  }
  for (const r of (overMoney || [])) {
    const f = padFid(r.fid);
    if (!out.has(f)) out.set(f, blank());
    out.get(f).over_fined_k_this_season = Number(r.k_now || 0);
    out.get(f).over_fined_k_next_season = Number(r.k_next || 0);
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

// Re-derive offense numbers and amounts for one franchise from its surviving
// (un-voided) missed days, oldest first.
//
// This MUST run after any void/unvoid. Excusing a day and leaving later fines
// on their original numbers produces an incoherent schedule: excuse someone's
// 2nd miss and they'd pay $3K + $15K — third-offense money for a second
// offense, skipping the $7K tier that exists between them. Canon §T4.3a is
// explicit that an excused day "won't be held against you", and a day that
// silently pushes your next miss into a higher tier is being held against you.
//
// Re-pricing here can only ever move a fine DOWN or restore it to a number the
// owner was already told — the schedule is a pure function of how many misses
// survive, so there is no version of this that surprises someone upward.
async function recomputeOffenses(env, { season, leagueId, fid }) {
  // BOTH ladders re-derive, independently. An excused day excuses everything
  // that happened on it, so a void can shift either count — and leaving the
  // over ladder un-derived would reintroduce the exact bug §T4.3a forbids, one
  // rung over: excuse someone's 2nd extra nomination and their 3rd would still
  // price at $7K instead of dropping to $3K.
  const missRepriced = await recomputeLadder(env, { season, leagueId, fid, kind: "miss" });
  const overRepriced = await recomputeLadder(env, { season, leagueId, fid, kind: "over" });
  return missRepriced.concat(overRepriced);
}

// One ladder's worth of re-derivation. `kind` selects both the counting column
// on ups_faa_nom_days and the fine schedule, so the two ladders can never read
// each other's offenses.
async function recomputeLadder(env, { season, leagueId, fid, kind }) {
  const db = env.UPS_MFL_DB;
  const isOver = kind === "over";
  const flagCol = isOver ? "over" : "missed";
  const fineK = isOver ? rule2OverFineK : rule2FineK;
  const idFor = (etDay, applies) =>
    isOver ? `${season}|${leagueId}|${fid}|${etDay}|${applies}|over`
           : `${season}|${leagueId}|${fid}|${etDay}|${applies}`;

  const { results: days } = await db.prepare(
    `SELECT et_day FROM ups_faa_nom_days
      WHERE season=? AND league_id=? AND fid=? AND ${flagCol}=1 AND voided=0
      ORDER BY et_day ASC`
  ).bind(Number(season), String(leagueId), fid).all();

  const repriced = [];
  for (let i = 0; i < (days || []).length; i += 1) {
    const etDay = days[i].et_day;
    const offenseNo = i + 1;
    const amountK = fineK(offenseNo);
    // No money at this rung — a 1st-offense warning on the over ladder, or
    // past the fined tiers on either. Drop any rows that exist so the ledger
    // can't hold a fine the schedule doesn't define.
    if (amountK <= 0) {
      const why = (isOver && offenseNo === 1)
        ? "1st extra nomination — warning, no fine"
        : "beyond fine schedule (league-fit review)";
      await db.prepare(
        `UPDATE ups_faa_nom_penalties SET voided=1, void_reason=?
          WHERE season=? AND league_id=? AND fid=? AND et_day=? AND kind=? AND voided=0`
      ).bind(why, Number(season), String(leagueId), fid, etDay, kind).run();
      continue;
    }
    for (const applies of [Number(season), Number(season) + 1]) {
      const id = idFor(etDay, applies);
      const before = await db.prepare(
        `SELECT amount_k, posted_to_mfl FROM ups_faa_nom_penalties WHERE penalty_id=?`
      ).bind(id).first();
      await db.prepare(
        `INSERT INTO ups_faa_nom_penalties
           (penalty_id, season, league_id, fid, et_day, offense_no, amount_k, applies_to_season, kind, voided)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(penalty_id) DO UPDATE SET
           offense_no = excluded.offense_no,
           amount_k   = excluded.amount_k,
           voided     = 0`
      ).bind(id, Number(season), String(leagueId), fid, etDay, offenseNo, amountK, applies, kind).run();
      // A row already posted to MFL whose price just changed needs a human —
      // the salaryAdj out there is now the wrong number.
      if (before && Number(before.posted_to_mfl) === 1 && Number(before.amount_k) !== amountK) {
        repriced.push({ penalty_id: id, was_k: Number(before.amount_k), now_k: amountK });
      }
    }
  }
  return repriced;
}

// Commish override (§F RULE 2 caveat). Voids the DAY and every penalty it
// caused, then re-derives the franchise's remaining offenses so the schedule
// stays coherent. Voiding is not deleting: the row stays as evidence that the
// owner called ahead, which is what protects them if it comes up again.
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
  // Re-derive what's left so an excused day can't push a later miss into a
  // higher tier — see recomputeOffenses.
  const repriced = await recomputeOffenses(env, { season, leagueId, fid: f });
  return {
    ok: true,
    days_voided: d.meta?.changes || 0,
    penalties_voided: p.meta?.changes || 0,
    // A penalty already posted to MFL needs its salaryAdj reversed by hand —
    // voiding the row does NOT undo the write.
    needs_mfl_reversal: await postedCount(env, { season, leagueId, fid: f, etDay }),
    // Already-posted fines whose price moved when the ladder re-derived.
    repriced_posted: repriced,
  };
}

// Undo a void. A mis-click on a fine is not something an owner should have to
// wait for a SQL session to fix, and the alternative (no undo) quietly pushes
// the commish toward "just leave it voided" — which is the wrong answer for the
// league. Restores the day AND its penalties together, so the offense count and
// the money can never disagree.
export async function unvoidNomDay(env, { season, leagueId, fid, etDay, by }) {
  const db = env.UPS_MFL_DB;
  if (!db) return { ok: false, error: "no_db" };
  const f = padFid(fid);
  const note = `restored by ${safeStr(by) || "commish"} at ${new Date().toISOString()}`;
  const d = await db.prepare(
    `UPDATE ups_faa_nom_days
        SET voided=0, void_reason=?, voided_by=NULL, voided_at_utc=NULL
      WHERE season=? AND league_id=? AND fid=? AND et_day=? AND voided=1`
  ).bind(note, Number(season), String(leagueId), f, String(etDay)).run();
  const p = await db.prepare(
    `UPDATE ups_faa_nom_penalties
        SET voided=0, void_reason=?, voided_by=NULL, voided_at_utc=NULL
      WHERE season=? AND league_id=? AND fid=? AND et_day=? AND voided=1`
  ).bind(note, Number(season), String(leagueId), f, String(etDay)).run();
  const repriced = await recomputeOffenses(env, { season, leagueId, fid: f });
  return {
    ok: true,
    days_restored: d.meta?.changes || 0,
    penalties_restored: p.meta?.changes || 0,
    repriced_posted: repriced,
  };
}

// Commish override — the MIRROR IMAGE of voidNomDay. §F RULE 2 clarification
// (Keith 2026-07-29, Hawks/Beckham incident): the roster-legal floor waiver is
// not a license to keep actively bidding while skipping nominations. A
// franchise that misses a nomination day must either go fully passive (no new
// bids/noms at all) or let only its already-open lots resolve; the moment it
// places a NEW bid or nomination without having cured, the waiver is
// forfeited and the missed day counts for real.
//
// Deliberately NOT automatic — same reasoning as the 4th-offense "league fit"
// review and the immunity caveat: whether a franchise "jumped back in" in the
// spirit this rule means is a judgment call, not a formula closeEtDay can
// derive from roster_met/noms_used alone. The commish decides; this function
// books the consequence once they have.
//
// Handles two starting states:
//   - Day already closed as a waived miss (missed=0) -> flips it to missed=1.
//   - Day was never closed at all (e.g. the ledger-freshness guard in
//     closeEtDay refused to judge it) -> creates the row directly as
//     missed=1. No fictitious "waived" state is ever written in between.
// Idempotent: a day already missed=1 is a no-op, so this can never double-fine
// on a retry.
export async function flagReengagementMiss(env, {
  season, leagueId, fid, etDay, reason, by,
  noms_used = 0, noms_required = 2, roster_met = true, total_deficit = 0,
}) {
  const db = env.UPS_MFL_DB;
  if (!db) return { ok: false, error: "no_db" };
  const f = padFid(fid);
  if (!f || !/^\d{4}-\d{2}-\d{2}$/.test(String(etDay))) {
    return { ok: false, error: "need fid + et_day (YYYY-MM-DD)" };
  }
  const now = new Date().toISOString();
  const overrideReason = safeStr(reason) || "re-engagement forfeit (§F RULE 2, Keith 2026-07-29)";
  const overrideBy = safeStr(by) || "commish";

  const existing = await db.prepare(
    `SELECT missed, voided FROM ups_faa_nom_days WHERE season=? AND league_id=? AND fid=? AND et_day=?`
  ).bind(Number(season), String(leagueId), f, String(etDay)).first();

  if (existing && Number(existing.missed) === 1 && Number(existing.voided) === 0) {
    return { ok: true, already_missed: true, fid: f, et_day: etDay };
  }

  if (existing) {
    await db.prepare(
      `UPDATE ups_faa_nom_days
          SET missed=1, override_reason=?, override_by=?, override_at_utc=?
        WHERE season=? AND league_id=? AND fid=? AND et_day=?`
    ).bind(overrideReason, overrideBy, now, Number(season), String(leagueId), f, String(etDay)).run();
  } else {
    await db.prepare(
      `INSERT INTO ups_faa_nom_days
         (season, league_id, fid, et_day, noms_used, noms_required, roster_met, total_deficit, missed,
          voided, override_reason, override_by, override_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)`
    ).bind(
      Number(season), String(leagueId), f, String(etDay),
      Number(noms_used || 0), Number(noms_required || 2), roster_met ? 1 : 0, Number(total_deficit || 0),
      overrideReason, overrideBy, now
    ).run();
  }

  const armed = !!(await getFeatureFlag(env, "AUCTION_FAA_PENALTIES_ENABLED"));
  const penalty = await bookPenaltyForMiss(env, { season, leagueId, fid: f, etDay, armed });
  return { ok: true, fid: f, et_day: etDay, override_reason: overrideReason, penalty };
}

// Every recorded day for the auction, newest first, with its penalties attached.
// Feeds the commish void UI — it must show VOIDED rows too, since the whole
// point is to see and undo them.
export async function nomComplianceLedger(env, { season, leagueId }) {
  const db = env.UPS_MFL_DB;
  if (!db) return { ok: false, error: "no_db", days: [] };
  const { results: days } = await db.prepare(
    `SELECT * FROM ups_faa_nom_days
      WHERE season=? AND league_id=? AND missed=1
      ORDER BY et_day DESC, fid ASC`
  ).bind(Number(season), String(leagueId)).all();
  const { results: pens } = await db.prepare(
    `SELECT * FROM ups_faa_nom_penalties WHERE season=? AND league_id=?`
  ).bind(Number(season), String(leagueId)).all();
  const byKey = {};
  for (const p of (pens || [])) (byKey[`${p.fid}|${p.et_day}`] ||= []).push(p);
  return {
    ok: true,
    days: (days || []).map((d) => ({
      ...d,
      penalties: byKey[`${d.fid}|${d.et_day}`] || [],
    })),
  };
}

async function postedCount(env, { season, leagueId, fid, etDay }) {
  const r = await env.UPS_MFL_DB.prepare(
    `SELECT COUNT(*) AS n FROM ups_faa_nom_penalties
      WHERE season=? AND league_id=? AND fid=? AND et_day=? AND posted_to_mfl=1`
  ).bind(Number(season), String(leagueId), fid, String(etDay)).first();
  return Number(r?.n || 0);
}
