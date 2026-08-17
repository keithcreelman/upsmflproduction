// §G3 lineup compliance — detection, the 24-hour anchor, and the violation ladder.
//
// Canon §G3 (Keith 2026-08-16): a lineup is a violation when it contains a
// missing starter, a player on bye, a player listed Out, or a player listed
// Doubtful who does not play. Injury-report timing is measured **24 hours
// before that player's kickoff**.
//
// Built on that anchor per Keith 2026-08-17, replacing the Friday-midnight
// snapshot in the §H proposal. A weekly anchor cannot evaluate a Wednesday or
// Thursday game, and 2026 opens WEDNESDAY Sept 9 — the same defect that retired
// the 2018 fixed-day wording ("Sunday & Monday → Friday PM"). §H's own DM
// schedule was already per-kickoff; only its violation test was weekly.
//
//
// THE SHAPE OF THE PROBLEM
//
// The failure this catches is NOT an owner submitting a short lineup — MFL
// already shows them an error on submit. It is Keith's actual case: "guys
// submit players then those players get declared out on Friday." The lineup was
// legal when submitted and became illegal afterwards, which is why the verdict
// can only be reached at kickoff, and why status has to be evaluated as of a
// moment in the past rather than as of now.
//
//
// EVALUATE AS OF THE 24-HOUR MARK, NOT AT KICKOFF
//
// The whole rule collapses into one idea: what did the owner know, 24 hours
// before this player's game? Everything follows from reading status at that
// instant rather than tracking transitions:
//
//   OUT at the mark                      -> violation   (you had a day to react)
//   DOUBTFUL at the mark + did not play  -> violation   (§G3, and §H's "start
//                                                        at own risk")
//   OUT/DOUBTFUL only AFTER the mark     -> advisory    (late news, never a fine)
//   anything else                        -> clean
//
// Tracking transitions instead would need every intermediate state and would
// still have to answer "as of when?" — this answers it once.
//
//
// IT REFUSES TO GUESS
//
// Every verdict that could cost an owner a 4th-round pick is gated on having
// actually observed the 24-hour window. If polling started late, or was down,
// the evaluator returns `unknown` and books nothing. An unobserved window and a
// clean one are indistinguishable in the data, and only one of them may produce
// a fine.

// One row per franchise per week: a week with three bad starters is ONE
// violation, because the ladder counts illegal LINEUPS (§G3).
export const LINEUP_LADDER = [
  { offense: 1, cap_k: 0,  pick: null,  membership: null,           label: "1st violation — warning, no penalty" },
  { offense: 2, cap_k: 5,  pick: "4th", membership: null,           label: "2nd violation — 4th-round pick + $5K next season" },
  { offense: 3, cap_k: 5,  pick: "2nd", membership: null,           label: "3rd violation — 2nd-round pick + a further $5K" },
  { offense: 4, cap_k: 10, pick: null,  membership: "retention",    label: "4th violation — league vote on retention; +$10K if retained" },
  { offense: 5, cap_k: 0,  pick: null,  membership: "expulsion",    label: "5th violation — automatic expulsion" },
];

export const REQUIRED_STARTERS = 18;         // §B4
export const INJURY_NOTICE_SECONDS = 24 * 3600;

export function lineupLadderRung(offenseNo) {
  const n = Number(offenseNo || 0);
  if (n < 1) return null;
  // Past the written ladder there is nothing left to escalate to — #5 is
  // expulsion. Clamp rather than inventing a 6th rung.
  return LINEUP_LADDER[Math.min(n, LINEUP_LADDER.length) - 1];
}

export function lineupLadderLabel(offenseNo) {
  const rung = lineupLadderRung(offenseNo);
  return rung ? rung.label : "no violation";
}

const _s = (v) => String(v == null ? "" : v).trim();
const _up = (v) => _s(v).toUpperCase();

// MFL injury statuses vary in spelling and case across feeds. Normalize to the
// four canon cares about; everything else is ACTIVE, which is the safe default
// because only OUT and DOUBTFUL can produce a violation.
export function normalizeInjuryStatus(raw) {
  const s = _up(raw).replace(/[^A-Z]/g, "");
  if (!s) return "ACTIVE";
  if (s.startsWith("OUT")) return "OUT";
  if (s.startsWith("IR") || s.startsWith("INJUREDRESERVE")) return "IR";
  if (s.startsWith("DOUBT")) return "DOUBTFUL";
  if (s.startsWith("QUEST")) return "QUESTIONABLE";
  if (s.startsWith("PROB")) return "QUESTIONABLE";   // retired NFL tag, still in old rows
  return "ACTIVE";
}

// The status in effect for a player at a given instant, from the first-seen
// ledger. `history` is [{ status, first_seen_unix }, ...] for one player-week.
//
// "In effect" = the LATEST status whose first sighting is at or before the
// instant. A status first seen after the instant did not exist for the owner
// yet, which is the entire point of the 24-hour rule.
export function statusAsOf(history, atUnix) {
  let best = null;
  for (const h of (history || [])) {
    const seen = Number(h && h.first_seen_unix) || 0;
    if (!seen || seen > atUnix) continue;
    if (!best || seen > best.first_seen_unix) best = { status: normalizeInjuryStatus(h.status), first_seen_unix: seen };
  }
  return best ? best.status : null;   // null = nothing observed at or before the mark
}

// One starter's verdict.
//
// `player`   { id, name, nfl_team }
// `ctx`      { kickoffUnix, onBye, played, history, observedFromUnix }
//
// observedFromUnix is the earliest injury poll we have for this week. If the
// 24-hour mark falls before it, we never watched the window that decides the
// verdict and must not judge it — see the header note on refusing to guess.
export function evaluateStarter(player, ctx) {
  const name = _s(player && player.name) || _s(player && player.id);
  const base = { player_id: _s(player && player.id), name };

  if (ctx && ctx.onBye) {
    // Byes are published months ahead. There is no notice question to ask, so
    // the 24-hour rule never enters into it.
    return { ...base, verdict: "violation", reason: "bye", detail: `${name} was on a bye week.` };
  }

  const kickoff = Number(ctx && ctx.kickoffUnix) || 0;
  if (!kickoff) {
    return { ...base, verdict: "unknown", reason: "no_kickoff", detail: `No kickoff time resolved for ${name}; not judged.` };
  }

  const mark = kickoff - INJURY_NOTICE_SECONDS;
  const observedFrom = Number(ctx && ctx.observedFromUnix) || 0;
  const status = statusAsOf(ctx && ctx.history, mark);

  // Did we actually watch the window? A missing status could mean "healthy" or
  // "we weren't looking". Only judge when polling demonstrably covered the mark.
  if (!observedFrom || observedFrom > mark) {
    if (status === "OUT" || status === "IR" || status === "DOUBTFUL") {
      // We saw a bad designation even though coverage started late — real, judge it.
    } else {
      return { ...base, verdict: "unknown", reason: "window_unobserved",
               detail: `Injury polling for ${name} began after the 24-hour mark; not judged.` };
    }
  }

  const played = !!(ctx && ctx.played);

  if (status === "OUT" || status === "IR") {
    if (played) {
      // Canon says "a player listed Out" with no did-not-play qualifier, so this
      // is still a violation — but an Out player who suits up is exactly the
      // case a human should look at rather than the machine deciding the rule
      // means something it does not say.
      return { ...base, verdict: "violation", reason: "out_but_played", needs_review: true,
               detail: `${name} was listed ${status} 24h before kickoff but played. Canon books this; worth a look.` };
    }
    return { ...base, verdict: "violation", reason: "out",
             detail: `${name} was listed ${status} more than 24 hours before kickoff.` };
  }

  if (status === "DOUBTFUL") {
    if (played) return { ...base, verdict: "clean", reason: "doubtful_played", detail: `${name} was Doubtful and played.` };
    return { ...base, verdict: "violation", reason: "doubtful_did_not_play",
             detail: `${name} was Doubtful 24 hours before kickoff and did not play.` };
  }

  // Healthy or merely Questionable at the mark. If he later turned Out, that is
  // late news — §H's "courtesy advisory", never a fine.
  const now = statusAsOf(ctx && ctx.history, kickoff);
  if ((now === "OUT" || now === "IR") && !played) {
    return { ...base, verdict: "advisory", reason: "late_out",
             detail: `${name} was ruled ${now} inside the 24-hour window. Not a violation.` };
  }
  if (now === "DOUBTFUL" && !played) {
    return { ...base, verdict: "advisory", reason: "late_doubtful",
             detail: `${name} turned Doubtful inside the 24-hour window and did not play. Not a violation.` };
  }
  return { ...base, verdict: "clean", reason: "ok", detail: "" };
}

// A whole franchise-week.
//
// `starters` is the submitted lineup; `ctxFor(player)` supplies per-player
// context. Returns one verdict for the week plus every per-player line, because
// the DM needs the detail and the ladder needs only the verdict.
export function evaluateLineup(starters, ctxFor, opts) {
  const required = Number((opts && opts.requiredStarters) || REQUIRED_STARTERS);
  const list = Array.isArray(starters) ? starters : [];
  const lines = list.map((p) => evaluateStarter(p, ctxFor(p) || {}));

  // A short lineup is its own violation and needs no injury data — you did not
  // field a team. Counted once however many slots are empty.
  const short = list.length < required;
  if (short) {
    lines.unshift({
      player_id: "", name: "", verdict: "violation", reason: "missing_starter",
      detail: `Only ${list.length} of ${required} starting slots filled.`,
    });
  }

  const violations = lines.filter((l) => l.verdict === "violation");
  const advisories = lines.filter((l) => l.verdict === "advisory");
  const unknowns   = lines.filter((l) => l.verdict === "unknown");

  return {
    // ONE verdict for the week — the ladder counts illegal lineups, not bad
    // starters, so three Out players in a week is a single violation.
    verdict: violations.length ? "violation" : advisories.length ? "advisory" : "clean",
    needs_review: violations.some((l) => l.needs_review),
    review_note: violations.filter((l) => l.needs_review).map((l) => l.detail).join(" ") || null,
    starters_seen: list.length,
    starters_required: required,
    violations, advisories, unknowns,
    lines,
  };
}

// ── ledger ──────────────────────────────────────────────────────────────────

// Record what TYPE=injuries says right now. First-seen wins and is never
// overwritten — that instant is the evidence the 24-hour rule turns on, so a
// later poll may only extend last_seen.
export async function recordInjurySnapshot(env, { season, week, rows, nowUnix }) {
  const db = env && env.UPS_MFL_DB;
  if (!db) return { ok: false, error: "no_db" };
  const at = Number(nowUnix) || Math.floor(Date.now() / 1000);
  const list = Array.isArray(rows) ? rows : [];
  let written = 0;
  for (const r of list) {
    const pid = _s(r && (r.id || r.player_id));
    if (!pid) continue;
    const status = normalizeInjuryStatus(r && (r.status || r.game_status));
    await db.prepare(
      `INSERT INTO ups_injury_status (season, week, player_id, status, first_seen_unix, last_seen_unix, details)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(season, week, player_id, status) DO UPDATE SET
         last_seen_unix = excluded.last_seen_unix`
    ).bind(Number(season), Number(week), pid, status, at, at, _s(r && r.details) || null).run();
    written += 1;
  }
  // Always log the poll, even when it wrote nothing. An empty status table is
  // otherwise ambiguous between "healthy league" and "poller was down", and
  // only one of those may lead to a fine.
  await db.prepare(
    `INSERT OR IGNORE INTO ups_injury_polls (season, week, polled_unix, rows_seen) VALUES (?, ?, ?, ?)`
  ).bind(Number(season), Number(week), at, list.length).run();
  return { ok: true, written, polled_unix: at };
}

// The earliest poll this week — the start of our observed window.
export async function injuryObservedFrom(env, { season, week }) {
  const db = env && env.UPS_MFL_DB;
  if (!db) return 0;
  const r = await db.prepare(
    `SELECT MIN(polled_unix) AS first FROM ups_injury_polls WHERE season=? AND week=?`
  ).bind(Number(season), Number(week)).first();
  return Number(r && r.first) || 0;
}

export async function injuryHistoryForWeek(env, { season, week }) {
  const db = env && env.UPS_MFL_DB;
  if (!db) return {};
  const { results } = await db.prepare(
    `SELECT player_id, status, first_seen_unix FROM ups_injury_status WHERE season=? AND week=?`
  ).bind(Number(season), Number(week)).all();
  const out = {};
  for (const r of (results || [])) {
    const pid = _s(r.player_id);
    (out[pid] = out[pid] || []).push({ status: r.status, first_seen_unix: Number(r.first_seen_unix) || 0 });
  }
  return out;
}

// Book a franchise-week as a violation and stamp its offense number.
//
// Season-scoped by construction — this is where Keith's 2026-08-17 "violations
// reset each season" ruling actually lives. Idempotent on (season, league, fid,
// week), so a re-run cannot double-count a week.
export async function bookLineupViolation(env, { season, leagueId, fid, week, result }) {
  const db = env && env.UPS_MFL_DB;
  if (!db) return { ok: false, error: "no_db" };
  const prior = await db.prepare(
    `SELECT COUNT(*) AS n FROM ups_lineup_violations
      WHERE season=? AND league_id=? AND fid=? AND voided=0 AND week < ?`
  ).bind(Number(season), String(leagueId), String(fid), Number(week)).first();
  const offenseNo = Number(prior && prior.n || 0) + 1;
  await db.prepare(
    `INSERT INTO ups_lineup_violations
       (season, league_id, fid, week, offense_no, reasons_json, needs_review, review_note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(season, league_id, fid, week) DO UPDATE SET
       reasons_json = excluded.reasons_json,
       needs_review = excluded.needs_review,
       review_note  = excluded.review_note`
  ).bind(
    Number(season), String(leagueId), String(fid), Number(week), offenseNo,
    JSON.stringify((result && result.violations) || []),
    result && result.needs_review ? 1 : 0,
    (result && result.review_note) || null
  ).run();
  return { ok: true, fid, week, offense_no: offenseNo, rung: lineupLadderRung(offenseNo) };
}

// Commish override, same semantics as §F RULE 2: void, never delete, then
// re-derive so an excused week cannot push a later one into a heavier rung.
export async function voidLineupViolation(env, { season, leagueId, fid, week, reason, by }) {
  const db = env && env.UPS_MFL_DB;
  if (!db) return { ok: false, error: "no_db" };
  const now = new Date().toISOString();
  const r = await db.prepare(
    `UPDATE ups_lineup_violations SET voided=1, void_reason=?, voided_by=?, voided_at_utc=?
      WHERE season=? AND league_id=? AND fid=? AND week=? AND voided=0`
  ).bind(_s(reason) || null, _s(by) || null, now,
    Number(season), String(leagueId), String(fid), Number(week)).run();
  await recomputeLineupOffenses(env, { season, leagueId, fid });
  return { ok: true, voided: (r.meta && r.meta.changes) || 0 };
}

// Re-derive offense numbers from surviving weeks, oldest first. Exactly the
// reasoning in §T4.3a: excusing someone's 2nd violation must not leave their
// 3rd priced as a 3rd — that would be holding the excused week against them,
// which is the one thing an excuse is supposed to prevent.
export async function recomputeLineupOffenses(env, { season, leagueId, fid }) {
  const db = env && env.UPS_MFL_DB;
  if (!db) return [];
  const { results } = await db.prepare(
    `SELECT week FROM ups_lineup_violations
      WHERE season=? AND league_id=? AND fid=? AND voided=0
      ORDER BY week ASC`
  ).bind(Number(season), String(leagueId), String(fid)).all();
  const out = [];
  for (let i = 0; i < (results || []).length; i += 1) {
    const week = Number(results[i].week);
    const offenseNo = i + 1;
    await db.prepare(
      `UPDATE ups_lineup_violations SET offense_no=? WHERE season=? AND league_id=? AND fid=? AND week=?`
    ).bind(offenseNo, Number(season), String(leagueId), String(fid), week).run();
    out.push({ week, offense_no: offenseNo, rung: lineupLadderRung(offenseNo) });
  }
  return out;
}

export async function lineupStandings(env, { season, leagueId }) {
  const db = env && env.UPS_MFL_DB;
  const out = new Map();
  if (!db) return out;
  const { results } = await db.prepare(
    `SELECT fid, COUNT(*) AS n, MAX(needs_review) AS review
       FROM ups_lineup_violations
      WHERE season=? AND league_id=? AND voided=0
      GROUP BY fid`
  ).bind(Number(season), String(leagueId)).all();
  for (const r of (results || [])) {
    const n = Number(r.n || 0);
    out.set(_s(r.fid), { violations: n, rung: lineupLadderRung(n), needs_review: Number(r.review || 0) === 1 });
  }
  return out;
}

// ── the DM (§H) ─────────────────────────────────────────────────────────────

// §H's requirement, and the thing that makes this usable rather than noise:
// "possible lineup violation" and "courtesy heads-up" must not read the same.
export function composeLineupDm({ franchiseName, week, result, windowLabel }) {
  const L = [];
  const wk = `Week ${week}`;
  if (result.verdict === "violation") {
    L.push(`🚨 **Possible lineup violation — ${wk}**`);
    L.push(`${windowLabel ? windowLabel + " · " : ""}${franchiseName}`);
    L.push("");
    for (const v of result.violations) L.push(`• ${v.detail}`);
    L.push("");
    L.push("_You can still fix this if the game hasn't kicked off._");
    L.push("_A player ruled out **inside** 24 hours of his kickoff is never a violation — this is flagging the ones you had a day's notice on (§G3)._");
  } else if (result.verdict === "advisory") {
    L.push(`⚠️ **Heads up — ${wk}** (not a violation)`);
    L.push(`${windowLabel ? windowLabel + " · " : ""}${franchiseName}`);
    L.push("");
    for (const a of result.advisories) L.push(`• ${a.detail}`);
    L.push("");
    L.push("_Late news, inside the 24-hour window. Nothing counts against you — you just might want to swap._");
  } else {
    L.push(`✅ **Lineup looks clean — ${wk}**`);
    if (windowLabel) L.push(windowLabel);
  }
  if (result.unknowns && result.unknowns.length) {
    L.push("");
    L.push(`_${result.unknowns.length} starter${result.unknowns.length === 1 ? "" : "s"} couldn't be checked (no kickoff or injury data). Not judged either way._`);
  }
  return L.join("\n");
}
