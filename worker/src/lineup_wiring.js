// §H delivery layer for §G3 lineup compliance — the plumbing around
// lineup_compliance.js's evaluator.
//
// Three jobs, all driven off the hourly cron:
//
//   1. runLineupDmSweep()   — 1.5h before each game window, DM every owner
//                             their status. Keith's §H spec.
//   2. runLineupBooking()   — once the week's last game is final, evaluate and
//                             book violations onto the §G3 ladder.
//   3. resolveReplacements  — "did you have anyone to sub in?", which decides
//                             whether a bad starter is a violation at all
//                             (Keith 2026-08-17).
//
// THE RULE IT SERVES lives in lineup_compliance.js. Nothing here decides
// whether something is a violation; this module only gathers inputs, delivers
// the verdict, and records it.
//
// FAIL CLOSED, EVERYWHERE. Every read that could be unreadable is treated as
// unknown rather than empty. MFL's own lineup contract says it best
// (index.js ~38460): "An unreadable input is never an empty one" — the
// fail-open shape that cost 18 contracts on 2026-08-02. A missing roster read
// must never look like "no starters", and a failed injury poll must never look
// like "everybody healthy". Both would manufacture violations.

import {
  evaluateLineup, composeLineupDm, bookLineupViolation,
  injuryHistoryForWeek, injuryObservedFrom, normalizeInjuryStatus,
  lineupLadderRung, REQUIRED_STARTERS,
} from "./lineup_compliance.js";
// Discord helpers are imported LAZILY, inside the send path only. Statically
// they drag in discord_round -> anthropic_explain -> a `.md` import that only
// wrangler's build can resolve, which makes this whole module unloadable under
// plain node and therefore untestable. Nothing above the send path needs them.

const _s = (v) => String(v == null ? "" : v).trim();
const _fid = (v) => { const d = _s(v).replace(/\D/g, ""); return d ? d.padStart(4, "0") : ""; };
const _arr = (x) => (Array.isArray(x) ? x : x ? [x] : []);

const MFL_API = "https://api.myfantasyleague.com";
const MFL_WWW = "https://www48.myfantasyleague.com";
const UA = { "User-Agent": "upsmflproduction-worker" };

// DM 1.5h out. The hourly cron cannot hit that to the minute, so the window is
// "kickoff is 1–2.5h away" — wide enough that an hourly tick always lands in it
// exactly once, and ups_lineup_dm_log makes a second landing a no-op anyway.
const DM_WINDOW_MIN_SEC = 60 * 60;
const DM_WINDOW_MAX_SEC = 150 * 60;
// Don't judge a week until its last game has had time to finalize.
const WEEK_SETTLE_SEC = 4 * 3600;

async function _json(url) {
  try {
    const r = await fetch(url, { headers: UA, cf: { cacheTtl: 60 } });
    return r.ok ? await r.json().catch(() => null) : null;
  } catch (_) { return null; }
}

// Every kickoff in a week, plus which NFL teams play in each.
// Returns null (NOT an empty schedule) when it cannot be read.
export async function weekSchedule(season, week) {
  const d = await _json(`${MFL_API}/${season}/export?TYPE=nflSchedule&W=${week}&JSON=1`);
  const ms = d && d.nflSchedule && _arr(d.nflSchedule.matchup);
  if (!ms || !ms.length) return null;
  const kickoffByTeam = {};
  const kickoffs = new Set();
  for (const m of ms) {
    const ko = parseInt(m && m.kickoff, 10);
    if (!(ko > 0)) continue;
    kickoffs.add(ko);
    for (const t of _arr(m.team)) {
      const id = _s(t && t.id).toUpperCase();
      if (id) kickoffByTeam[id] = ko;
    }
  }
  return { kickoffByTeam, kickoffs: [...kickoffs].sort((a, b) => a - b) };
}

// NFL teams on bye this week. null when unreadable — a failed read must not
// make everyone look available.
export async function byeTeams(season, week) {
  const d = await _json(`${MFL_API}/${season}/export?TYPE=nflByeWeeks&W=${week}&JSON=1`);
  const rows = d && d.nflByeWeeks && _arr(d.nflByeWeeks.team);
  if (!rows) return null;
  return new Set(rows.map((t) => _s(t && (t.id || t)).toUpperCase()).filter(Boolean));
}

// player_id -> { position, team }
export async function playerIndex(season, leagueId) {
  const d = await _json(`${MFL_WWW}/${season}/export?TYPE=players&L=${leagueId}&DETAILS=1&JSON=1`);
  const rows = d && d.players && _arr(d.players.player);
  if (!rows || !rows.length) return null;
  const out = {};
  for (const p of rows) {
    const id = _s(p && p.id);
    if (id) out[id] = { position: _s(p.position).toUpperCase(), team: _s(p.team).toUpperCase(), name: _s(p.name) };
  }
  return out;
}

// fid -> [player_id]. Whole-league rosters.
export async function leagueRosters(season, leagueId, cookieHeader) {
  const url = `${MFL_WWW}/${season}/export?TYPE=rosters&L=${leagueId}&JSON=1`;
  let d = null;
  try {
    const r = await fetch(url, { headers: cookieHeader ? { ...UA, Cookie: cookieHeader } : UA });
    d = r.ok ? await r.json().catch(() => null) : null;
  } catch (_) { d = null; }
  const fr = d && d.rosters && _arr(d.rosters.franchise);
  if (!fr || !fr.length) return null;
  const out = {};
  for (const f of fr) {
    const fid = _fid(f && f.id);
    if (!fid) continue;
    out[fid] = _arr(f.player).map((p) => ({ id: _s(p && p.id), status: _s(p && p.status).toUpperCase() }))
                            .filter((p) => p.id);
  }
  return out;
}

// Who a franchise actually STARTED, per MFL's playerRosterStatus (S | NS | IR |
// TS | R). Follows the contract documented in index.js ~38460 — P is required,
// so the roster ids are fed in — and keeps its three distinct states.
//
//   { known: true,  starters: [...] }   we have the lineup
//   { known: false, state: 'no_record' } nobody submitted one
//   { known: false, state: 'unknown' }   the READ FAILED — never "empty"
export async function submittedStarters(season, leagueId, fid, playerIds, cookieHeader) {
  const ids = (playerIds || []).map((p) => (typeof p === "string" ? p : p.id)).filter(Boolean);
  if (!ids.length) return { known: false, state: "unknown", starters: null, reason: "no roster ids" };
  const url = `${MFL_WWW}/${season}/export?TYPE=playerRosterStatus&L=${leagueId}&P=${ids.join(",")}&JSON=1`;
  let d = null;
  try {
    const r = await fetch(url, { headers: cookieHeader ? { ...UA, Cookie: cookieHeader } : UA });
    d = r.ok ? await r.json().catch(() => null) : null;
  } catch (_) { d = null; }
  if (!d) return { known: false, state: "unknown", starters: null, reason: "playerRosterStatus read failed" };
  const block = d.playerRosterStatuses || d.playerRosterStatus;
  const rows = block && _arr(block.playerRosterStatus || block.player);
  if (!rows || !rows.length) return { known: false, state: "unknown", starters: null, reason: "empty payload" };
  const starters = [];
  let sawAny = false;
  for (const r of rows) {
    const pid = _s(r && r.id);
    // Key order varies between entries, so read the franchise block defensively.
    for (const rf of _arr(r && (r.roster_franchise || r.franchise))) {
      if (_fid(rf && rf.id) !== _fid(fid)) continue;
      const st = _s(rf && rf.status).toUpperCase();
      if (st) sawAny = true;
      if (st === "S") starters.push(pid);
    }
  }
  if (!sawAny) return { known: false, state: "no_record", starters: null, reason: "no lineup submitted" };
  return { known: true, state: "submitted", starters };
}

// Could this owner have started somebody else in his place?
//
// Keith 2026-08-17: "if you don't have a player on your roster you can sub out"
// there is no penalty. Conservative on purpose — same position only, and the
// candidate must himself be startable. Getting this WRONG in the lenient
// direction excuses a real violation; getting it wrong in the strict direction
// FINES SOMEBODY FOR A MOVE THEY COULD NOT MAKE, which is what Keith ruled out.
// So anything uncertain resolves to "a replacement existed = false".
export function replacementAvailable(pid, { roster, starting, players, byes, injuryAt }) {
  const me = players && players[pid];
  if (!me || !me.position) return false;            // unknown position -> excuse
  for (const r of (roster || [])) {
    const cid = r.id;
    if (!cid || cid === pid) continue;
    if (starting.has(cid)) continue;                 // already in the lineup
    if (r.status === "TAXI_SQUAD" || r.status === "INJURED_RESERVE") continue;
    const c = players[cid];
    if (!c || c.position !== me.position) continue;  // same position only
    if (byes && byes.has(c.team)) continue;          // a bye player is no help
    const st = injuryAt ? injuryAt(cid) : null;
    if (st === "OUT" || st === "IR") continue;       // nor is another Out player
    return true;
  }
  return false;
}

// Assemble everything one franchise-week needs and hand it to the evaluator.
// `final` false = a pre-kickoff advisory pass; true = the end-of-week booking.
export async function evaluateFranchiseWeek(env, {
  season, leagueId, fid, week, roster, players, sched, byes, history, observedFrom, final,
}) {
  const st = await submittedStarters(season, leagueId, fid, roster, env && env.MFL_COOKIE);
  if (!st.known) {
    // No lineup, or an unreadable one. Either way this module refuses to judge:
    // "failed to submit any lineup" is a SEPARATE §G3 offense with its own
    // process (explain by Tuesday, league vote), not something to book here.
    return { skipped: true, reason: st.state, detail: st.reason };
  }
  const starting = new Set(st.starters);
  const injuryAt = (pid) => {
    const h = history[pid] || [];
    let best = null;
    for (const e of h) if (!best || e.first_seen_unix > best.first_seen_unix) best = e;
    return best ? normalizeInjuryStatus(best.status) : null;
  };
  const starters = st.starters.map((id) => ({
    id, name: (players[id] && players[id].name) || id, nfl_team: players[id] && players[id].team,
  }));
  const ctxFor = (p) => {
    const info = players[p.id] || {};
    return {
      kickoffUnix: (sched.kickoffByTeam || {})[info.team] || 0,
      onBye: byes ? byes.has(info.team) : false,
      history: history[p.id] || [],
      observedFromUnix: observedFrom,
      replacementAvailable: replacementAvailable(p.id, { roster, starting, players, byes, injuryAt }),
    };
  };
  return { skipped: false, result: evaluateLineup(starters, ctxFor, { final, requiredStarters: REQUIRED_STARTERS }) };
}

// ── 1. the pre-kickoff DM sweep (§H) ────────────────────────────────────────
export async function runLineupDmSweep(env, { season, leagueId, week, nowUnix, dryRun = false }) {
  const db = env && env.UPS_MFL_DB;
  if (!db) return { ok: false, error: "no_db" };
  const now = Number(nowUnix) || Math.floor(Date.now() / 1000);

  const sched = await weekSchedule(season, week);
  if (!sched) return { ok: true, skipped: "schedule_unreadable" };
  // Which game window(s) are ~1.5h out right now?
  const due = sched.kickoffs.filter((k) => (k - now) > DM_WINDOW_MIN_SEC && (k - now) <= DM_WINDOW_MAX_SEC);
  if (!due.length) return { ok: true, skipped: "no_window_due" };

  const [players, rosters, byes] = await Promise.all([
    playerIndex(season, leagueId),
    leagueRosters(season, leagueId, env.MFL_COOKIE),
    byeTeams(season, week),
  ]);
  // Fail closed: without rosters or the player index there is nothing
  // trustworthy to say, and a wrong "you're clean" DM is worse than silence.
  if (!players || !rosters) return { ok: true, skipped: "inputs_unreadable" };

  const history = await injuryHistoryForWeek(env, { season, week });
  const observedFrom = await injuryObservedFrom(env, { season, week });
  const windowKey = new Date(due[0] * 1000).toISOString().slice(0, 16);
  const windowLabel = new Date(due[0] * 1000)
    .toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }) + " ET";

  const sent = [];
  for (const fid of Object.keys(rosters).sort()) {
    // Only DM an owner who actually has a starter in THIS window — nobody
    // wants a Sunday-night ping about a lineup that is already locked.
    const roster = rosters[fid];
    const inWindow = roster.some((p) => {
      const t = players[p.id] && players[p.id].team;
      return t && (sched.kickoffByTeam[t] || 0) === due[0];
    });
    if (!inWindow) continue;

    const already = await db.prepare(
      `SELECT 1 FROM ups_lineup_dm_log WHERE season=? AND league_id=? AND fid=? AND week=? AND window_key=?`
    ).bind(Number(season), String(leagueId), fid, Number(week), windowKey).first();
    if (already) continue;

    const ev = await evaluateFranchiseWeek(env, {
      season, leagueId, fid, week, roster, players, sched, byes, history, observedFrom, final: false,
    });
    if (ev.skipped) continue;

    const body = composeLineupDm({ franchiseName: `Team ${fid}`, week, result: ev.result, windowLabel });
    if (!dryRun) {
      try {
        const [{ resolveDiscordUserIds }, { sendDm, openDmChannel }] = await Promise.all([
          import("./trade_dm.js"), import("./discord_round.js"),
        ]);
        const ids = await resolveDiscordUserIds(env, fid);
        for (const uid of (ids || [])) {
          const ch = await openDmChannel(env, uid);
          if (ch) await sendDm(env, ch, { content: body });
        }
      } catch (_) { /* a failed DM must not stop the sweep */ }
      await db.prepare(
        `INSERT OR IGNORE INTO ups_lineup_dm_log (season, league_id, fid, week, window_key, verdict, body, sent_unix)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(Number(season), String(leagueId), fid, Number(week), windowKey,
             ev.result.verdict, body, now).run();
    }
    sent.push({ fid, verdict: ev.result.verdict });
  }
  return { ok: true, week, window_key: windowKey, window_label: windowLabel, sent: sent.length, detail: sent };
}

// ── 2. the end-of-week booking pass ─────────────────────────────────────────
export async function runLineupBooking(env, { season, leagueId, week, nowUnix, dryRun = false }) {
  const db = env && env.UPS_MFL_DB;
  if (!db) return { ok: false, error: "no_db" };
  const now = Number(nowUnix) || Math.floor(Date.now() / 1000);

  const sched = await weekSchedule(season, week);
  if (!sched) return { ok: true, skipped: "schedule_unreadable" };
  const last = sched.kickoffs[sched.kickoffs.length - 1] || 0;
  // Wait for the last game to finish AND for injury status to settle. Booking
  // early would judge a player whose game has not kicked off yet.
  if (!last || now < last + WEEK_SETTLE_SEC) return { ok: true, skipped: "week_not_final" };

  const [players, rosters, byes] = await Promise.all([
    playerIndex(season, leagueId),
    leagueRosters(season, leagueId, env.MFL_COOKIE),
    byeTeams(season, week),
  ]);
  if (!players || !rosters) return { ok: true, skipped: "inputs_unreadable" };

  const history = await injuryHistoryForWeek(env, { season, week });
  const observedFrom = await injuryObservedFrom(env, { season, week });

  const booked = [], clean = [], skipped = [];
  for (const fid of Object.keys(rosters).sort()) {
    const already = await db.prepare(
      `SELECT 1 FROM ups_lineup_violations WHERE season=? AND league_id=? AND fid=? AND week=?`
    ).bind(Number(season), String(leagueId), fid, Number(week)).first();
    if (already) { skipped.push({ fid, reason: "already_booked" }); continue; }

    const ev = await evaluateFranchiseWeek(env, {
      season, leagueId, fid, week, roster: rosters[fid], players, sched, byes, history, observedFrom, final: true,
    });
    if (ev.skipped) { skipped.push({ fid, reason: ev.reason }); continue; }
    if (ev.result.verdict !== "violation") { clean.push(fid); continue; }
    if (dryRun) { booked.push({ fid, dry_run: true, reasons: ev.result.violations.map((v) => v.reason) }); continue; }

    const b = await bookLineupViolation(env, { season, leagueId, fid, week, result: ev.result });
    booked.push({ fid, offense_no: b.offense_no, rung: b.rung && b.rung.label,
                  reasons: ev.result.violations.map((v) => v.reason) });
  }
  return { ok: true, week, booked: booked.length, clean: clean.length, skipped: skipped.length,
           detail: { booked, skipped } };
}
