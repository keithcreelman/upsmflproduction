// §H delivery layer for §G3 lineup compliance — the plumbing around
// lineup_compliance.js's evaluator.
//
// Three jobs, all driven off the hourly cron:
//
//   1. runLineupDmSweep()       — 1.5h before each game window, DM every
//                                 owner their status. Keith's §H spec.
//   2. runLineupBooking()       — once the week's FINAL kickoff has passed,
//                                 evaluate and book violations onto the §G3
//                                 ladder.
//   3. runLineupSaturdayAnnounce() — once, Saturday morning, ONE public post
//                                 (not DMs) summarizing every franchise's
//                                 current lineup risk off the injury report
//                                 (Keith 2026-09-13: "a Sat AM Post that's
//                                 supposed to be based off the injury
//                                 reports not just DMs"), plus a league-wide
//                                 Out/Doubtful-by-game report (Keith
//                                 2026-09-19).
//
// A fourth job, resolveReplacements ("did you have anyone to sub in?"),
// existed here through 2026-09-19 -- it downgraded a bad starter to an
// advisory when nothing on the bench could have replaced him. Keith removed
// that exception live that day: "it doesn't matter if there's nobody
// eligible it would be a violation." See evaluateStarter in
// lineup_compliance.js for where the rule itself lives now.
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
  injuryHistoryForWeek, injuryObservedFrom, statusAsOf,
  lineupLadderRung, REQUIRED_STARTERS,
} from "./lineup_compliance.js";
// Discord helpers are imported LAZILY, inside the send path only. Statically
// they drag in discord_round -> anthropic_explain -> a `.md` import that only
// wrangler's build can resolve, which makes this whole module unloadable under
// plain node and therefore untestable. Nothing above the send path needs them.

const _s = (v) => String(v == null ? "" : v).trim();
const _fid = (v) => { const d = _s(v).replace(/\D/g, ""); return d ? d.padStart(4, "0") : ""; };
const _arr = (x) => (Array.isArray(x) ? x : x ? [x] : []);

// Neither job stamped ups_bot_heartbeat before 2026-09-08, unlike auction_poll
// / trade_roast / cron_cf — found while verifying this plumbing was live for
// Keith ahead of Week 1. A silent failure here would not surface in Commish
// Settings' cron-health view.
//
// Stamped on EVERY reachable return, deliberately INCLUDING the "nothing was
// due this tick" skips (no_window_due / week_not_final are the common case,
// most of an hour) — that is what makes a stale row mean something. Called
// only from inside a caught branch (never from a spot that could throw first),
// so an actual crash leaves last_ts stale and staleness stays diagnostic. A
// heartbeat write failing is diagnostics-only and must never fail the job it
// is reporting on.
async function _stampLineupHeartbeat(db, bot, status) {
  if (!db) return;
  try {
    await db.prepare(
      `INSERT INTO ups_bot_heartbeat (bot, last_ts, status, env)
       VALUES (?, ?, ?, '')
       ON CONFLICT(bot) DO UPDATE SET last_ts = excluded.last_ts, status = excluded.status`
    ).bind(bot, Math.floor(Date.now() / 1000), String(status).slice(0, 64)).run();
  } catch (_) { /* diagnostics only — never worth failing the job over */ }
}

const MFL_API = "https://api.myfantasyleague.com";
const MFL_WWW = "https://www48.myfantasyleague.com";
const UA = { "User-Agent": "upsmflproduction-worker" };

// HARD BLOCK, not a default that can be overridden (Keith 2026-09-19: the
// Saturday post's own dedup lost a race with its window check earlier the
// same day and one real post reached the Coffee Shop before a manual D1
// block could land. Config alone -- DISCORD_LINEUP_ANNOUNCE_CHANNEL_ID now
// points elsewhere -- is a default, not a guarantee: an explicit channelId
// override, on the cron path or the admin preview route, could still name
// it. "DELETE THIS ENTIRELY...NEVER POST TO COFFEE SHOP only to the
// injury report page" -- enforced in code, not just config, so a bad
// override refuses instead of posting.
const COFFEE_SHOP_CHANNEL_ID = "1087157907419840644";

// DM 1.5h out. The hourly cron cannot hit that to the minute, so the window is
// "kickoff is 1–2.5h away" — wide enough that an hourly tick always lands in it
// exactly once, and ups_lineup_dm_log makes a second landing a no-op anyway.
const DM_WINDOW_MIN_SEC = 60 * 60;
const DM_WINDOW_MAX_SEC = 150 * 60;
// WHEN THE WEEK IS JUDGED (Keith 2026-10-11): at the FINAL scheduled kickoff
// of the fantasy week — normally Monday night. From that instant every
// starting slot is locked, every starter's status at his own kickoff is
// known, and an empty slot can no longer be filled; nothing after it can
// change the verdict. (Until 2026-10-11 this waited 4 hours past the final
// kickoff, which put the run at ~1am ET Tuesday — after MFL had already
// rolled its implicit lineup week, which is how weeks 1-4 were booked off
// the wrong lineup.) "Final kickoff" is re-read from MFL's schedule on every
// run, so a postponed or rescheduled final game simply moves the moment.
//
// The hourly :05 cron alone can be up to ~60 minutes late (a kickoff at
// hh:05:01 waits for (hh+1):05). The */5 cron therefore also runs the booking
// for FAST_BOOKING_WINDOW_SEC after the final kickoff — see
// runLineupBookingFastPath — and the hourly run stays as the safety net.
export const FAST_BOOKING_WINDOW_SEC = 15 * 60;

export function finalKickoffUnix(sched) {
  const ks = (sched && sched.kickoffs) || [];
  return ks.length ? Math.max(...ks) : 0;
}

async function _json(url) {
  try {
    const r = await fetch(url, { headers: UA, cf: { cacheTtl: 60 } });
    return r.ok ? await r.json().catch(() => null) : null;
  } catch (_) { return null; }
}

// Every kickoff in a week, plus which NFL teams play in each, plus the game
// pairings themselves (added 2026-09-19 for the per-game Out/Doubtful report
// -- home/away, so a game can be labeled "AWAY @ HOME" rather than just
// listing two team codes).
// Returns null (NOT an empty schedule) when it cannot be read.
export async function weekSchedule(season, week) {
  const d = await _json(`${MFL_API}/${season}/export?TYPE=nflSchedule&W=${week}&JSON=1`);
  const ms = d && d.nflSchedule && _arr(d.nflSchedule.matchup);
  if (!ms || !ms.length) return null;
  const kickoffByTeam = {};
  const kickoffs = new Set();
  const games = [];
  for (const m of ms) {
    const ko = parseInt(m && m.kickoff, 10);
    if (!(ko > 0)) continue;
    kickoffs.add(ko);
    const teamsRaw = _arr(m.team);
    for (const t of teamsRaw) {
      const id = _s(t && t.id).toUpperCase();
      if (id) kickoffByTeam[id] = ko;
    }
    if (teamsRaw.length === 2) {
      const home = teamsRaw.find((t) => String(t && t.isHome) === "1") || teamsRaw[0];
      const away = teamsRaw.find((t) => t !== home) || teamsRaw[1];
      const homeId = _s(home && home.id).toUpperCase(), awayId = _s(away && away.id).toUpperCase();
      if (homeId && awayId) games.push({ home: homeId, away: awayId, kickoff: ko });
    }
  }
  return { kickoffByTeam, kickoffs: [...kickoffs].sort((a, b) => a - b), games: games.sort((a, b) => a.kickoff - b.kickoff) };
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
//
// `week` is REQUIRED for a correct answer (found 2026-10-11). Without &W= MFL
// answers for ITS current lineup week, which rolls forward as soon as a week's
// games end. The end-of-week booking pass runs ~1am ET Tuesday, so it was
// reading the NEXT week's mostly-empty lineup and booked "Only 0 of 18" for all
// 12 teams in weeks 1-4. MFL honors W (verified live 2026-10-11: one player read NS for
// W=4 and S for W=5 on the same day). The booking pass no longer uses this read
// at all — see weekStartersFromResults — but the pre-kickoff passes do, and
// they pass the week they are evaluating rather than trusting MFL's clock.
export async function submittedStarters(season, leagueId, fid, playerIds, cookieHeader, week) {
  const ids = (playerIds || []).map((p) => (typeof p === "string" ? p : p.id)).filter(Boolean);
  if (!ids.length) return { known: false, state: "unknown", starters: null, reason: "no roster ids" };
  const wParam = Number(week) > 0 ? `&W=${Number(week)}` : "";
  const url = `${MFL_WWW}/${season}/export?TYPE=playerRosterStatus&L=${leagueId}&P=${ids.join(",")}${wParam}&JSON=1`;
  let d = null;
  try {
    const r = await fetch(url, { headers: cookieHeader ? { ...UA, Cookie: cookieHeader } : UA });
    d = r.ok ? await r.json().catch(() => null) : null;
  } catch (_) { d = null; }
  if (!d) return { known: false, state: "unknown", starters: null, reason: "playerRosterStatus read failed" };
  // CONTRACT (verified against a live L=74598 FID=0008 fetch — see the fuller
  // parser + comment at index.js's GET /api/lineup, ~40677, which this was
  // copied from after discovering this function never matched a single row):
  // payload.playerRosterStatuses.playerStatus[] entries, each { id,
  // roster_franchise }; roster_franchise is an object normally but an ARRAY
  // in leagues with multiple copies of a player, and carries { franchise_id,
  // status } — NOT { id, status }. Key order varies between entries, so read
  // by name, never by position.
  const block = d.playerRosterStatuses;
  const rows = block && _arr(block.playerStatus);
  if (!rows || !rows.length) return { known: false, state: "unknown", starters: null, reason: "empty payload" };
  const starters = [];
  const seenStarter = {};
  let sawAny = false;
  for (const r of rows) {
    const pid = _s(r && (r.id || r.player_id));
    for (const rf of _arr(r && r.roster_franchise)) {
      if (_fid(rf && rf.franchise_id) !== _fid(fid)) continue;
      const st = _s(rf && rf.status).toUpperCase();
      if (st) sawAny = true;
      if (st === "S" && pid && !seenStarter[pid]) { seenStarter[pid] = 1; starters.push(pid); }
    }
  }
  if (!sawAny) return { known: false, state: "no_record", starters: null, reason: "no lineup submitted" };
  return { known: true, state: "submitted", starters };
}

// fid -> [starter player ids] for ONE completed week, from MFL's scored results
// (TYPE=weeklyResults&W=week). This is the booking pass's lineup source.
//
// Why not playerRosterStatus&W=: that read needs a P= list, and the only list
// available is the roster as it stands NOW. A player who started in week N and
// was dropped before the Tuesday booking would vanish from the lineup and turn
// a legal 18-man lineup into a "17 of 18" violation. weeklyResults carries the
// starters MFL actually scored, independent of today's roster.
//
// Returns null (NOT {}) when the export cannot be read. A franchise that plays
// several games in a week appears in several matchups; every copy lists the
// same lineup, so the first one wins.
export async function weekStartersFromResults(season, leagueId, week, cookieHeader) {
  const url = `${MFL_WWW}/${season}/export?TYPE=weeklyResults&L=${leagueId}&W=${Number(week)}&JSON=1`;
  let d = null;
  try {
    const r = await fetch(url, { headers: cookieHeader ? { ...UA, Cookie: cookieHeader } : UA });
    d = r.ok ? await r.json().catch(() => null) : null;
  } catch (_) { d = null; }
  const wr = d && d.weeklyResults;
  if (!wr) return null;
  // Guard against MFL answering a different week than the one asked for.
  if (wr.week != null && Number(wr.week) !== Number(week)) return null;
  const out = {};
  for (const m of _arr(wr.matchup)) {
    for (const f of _arr(m && m.franchise)) {
      const fid = _fid(f && f.id);
      if (!fid || out[fid]) continue;
      out[fid] = _s(f && f.starters).split(",").map(_s).filter(Boolean);
    }
  }
  return Object.keys(out).length ? out : null;
}

// Never book more than this many franchises in one week without a human
// looking first. The 2026 weeks 1-4 bug booked 12 of 12, four weeks running,
// and nothing noticed because nothing reads the ledger yet. A real week with
// more than a third of the league fielding an illegal lineup is far more
// likely to be a broken input than a broken league — so the pass refuses,
// stamps the heartbeat, and books NOTHING for that week until someone checks.
export const MAX_BOOKINGS_PER_WEEK = 4;

// REMOVED 2026-09-19. Used to answer "could this owner have started somebody
// else in his place?" so a bad starter with no eligible bench replacement
// downgraded to an advisory (Keith 2026-08-17). Keith corrected that same
// ruling live: "it doesn't matter if there's nobody eligible it would be a
// violation" -- so the question this function answered no longer changes
// anything, and it's gone along with its one call site in ctxFor below.

// Assemble everything one franchise-week needs and hand it to the evaluator.
// `final` false = a pre-kickoff advisory pass; true = the end-of-week booking.
// `nowUnix` (optional) lets evaluateStarter tell a still-ahead kickoff from a
// finished one -- pass the caller's own `now` for a preview/DM pass. The
// booking pass passes its `now` too; it only runs at or after the week's
// final kickoff, so every kickoff reads as passed (see FAST_BOOKING_WINDOW_SEC).
// `weekStarters` (optional) is the booking pass's fid -> [ids] map from
// weekStartersFromResults. When it is supplied the lineup comes ONLY from it —
// a franchise missing from it is unknown, never a fallback to the live read.
export async function evaluateFranchiseWeek(env, {
  season, leagueId, fid, week, roster, players, sched, byes, history, observedFrom, final, nowUnix, weekStarters,
}) {
  const st = weekStarters
    ? (Array.isArray(weekStarters[fid])
        ? { known: true, state: "submitted", starters: weekStarters[fid] }
        : { known: false, state: "unknown", starters: null, reason: "franchise missing from weeklyResults" })
    : await submittedStarters(season, leagueId, fid, roster, env && env.MFL_COOKIE, week);
  if (!st.known) {
    // No lineup, or an unreadable one. Either way this module refuses to judge:
    // "failed to submit any lineup" is a SEPARATE §G3 offense with its own
    // process (explain by Tuesday, league vote), not something to book here.
    return { skipped: true, reason: st.state, detail: st.reason };
  }
  if (final && !st.starters.length) {
    // At booking time ZERO starters is not a short lineup, it is no lineup —
    // the same separate process as above. Booking it as "Only 0 of 18" is how
    // weeks 1-4 of 2026 produced 44 of 48 false violations (the read was a week
    // ahead). Pre-kickoff passes keep the "still fixable" advisory.
    return { skipped: true, reason: "no_record", detail: "zero starters recorded for this week" };
  }
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
      nowUnix,
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
  if (!sched) { await _stampLineupHeartbeat(db, "lineup_dm_sweep", "skipped:schedule_unreadable"); return { ok: true, skipped: "schedule_unreadable" }; }
  // Which game window(s) are ~1.5h out right now?
  const due = sched.kickoffs.filter((k) => (k - now) > DM_WINDOW_MIN_SEC && (k - now) <= DM_WINDOW_MAX_SEC);
  if (!due.length) { await _stampLineupHeartbeat(db, "lineup_dm_sweep", "ok:no_window_due"); return { ok: true, skipped: "no_window_due" }; }

  const [players, rosters, byes] = await Promise.all([
    playerIndex(season, leagueId),
    leagueRosters(season, leagueId, env.MFL_COOKIE),
    byeTeams(season, week),
  ]);
  // Fail closed: without rosters or the player index there is nothing
  // trustworthy to say, and a wrong "you're clean" DM is worse than silence.
  if (!players || !rosters) { await _stampLineupHeartbeat(db, "lineup_dm_sweep", "skipped:inputs_unreadable"); return { ok: true, skipped: "inputs_unreadable" }; }

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
      season, leagueId, fid, week, roster, players, sched, byes, history, observedFrom, final: false, nowUnix: now,
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
  await _stampLineupHeartbeat(db, "lineup_dm_sweep", `ok:sent=${sent.length}`);
  return { ok: true, week, window_key: windowKey, window_label: windowLabel, sent: sent.length, detail: sent };
}

// ── 2. the end-of-week booking pass ─────────────────────────────────────────
export async function runLineupBooking(env, { season, leagueId, week, nowUnix, dryRun = false }) {
  const db = env && env.UPS_MFL_DB;
  if (!db) return { ok: false, error: "no_db" };
  const now = Number(nowUnix) || Math.floor(Date.now() / 1000);

  const sched = await weekSchedule(season, week);
  if (!sched) { await _stampLineupHeartbeat(db, "lineup_booking", "skipped:schedule_unreadable"); return { ok: true, skipped: "schedule_unreadable" }; }
  const last = finalKickoffUnix(sched);
  // Judge at the week's FINAL kickoff, never before: booking early would judge
  // a player whose game has not kicked off and a slot that can still be filled.
  if (!last || now < last) { await _stampLineupHeartbeat(db, "lineup_booking", "ok:week_not_final"); return { ok: true, skipped: "week_not_final", final_kickoff: last || null }; }

  const [players, rosters, byes] = await Promise.all([
    playerIndex(season, leagueId),
    leagueRosters(season, leagueId, env.MFL_COOKIE),
    byeTeams(season, week),
  ]);
  if (!players || !rosters) { await _stampLineupHeartbeat(db, "lineup_booking", "skipped:inputs_unreadable"); return { ok: true, skipped: "inputs_unreadable" }; }

  // The lineup for THE WEEK BEING BOOKED, from MFL's scored results — never the
  // live lineup read, which by booking time has rolled to the next week.
  const weekStarters = await weekStartersFromResults(season, leagueId, week, env.MFL_COOKIE);
  if (!weekStarters) { await _stampLineupHeartbeat(db, "lineup_booking", "skipped:week_results_unreadable"); return { ok: true, skipped: "week_results_unreadable" }; }

  const history = await injuryHistoryForWeek(env, { season, week });
  const observedFrom = await injuryObservedFrom(env, { season, week });

  // Evaluate everyone FIRST, book afterwards — the mass-booking guard below has
  // to see the whole week before a single row is written.
  const candidates = [], clean = [], skipped = [];
  for (const fid of Object.keys(rosters).sort()) {
    const already = await db.prepare(
      `SELECT 1 FROM ups_lineup_violations WHERE season=? AND league_id=? AND fid=? AND week=?`
    ).bind(Number(season), String(leagueId), fid, Number(week)).first();
    if (already) { skipped.push({ fid, reason: "already_booked" }); continue; }

    const ev = await evaluateFranchiseWeek(env, {
      season, leagueId, fid, week, roster: rosters[fid], players, sched, byes, history, observedFrom, final: true, nowUnix: now, weekStarters,
    });
    if (ev.skipped) { skipped.push({ fid, reason: ev.reason }); continue; }
    if (ev.result.verdict !== "violation") { clean.push(fid); continue; }
    candidates.push({ fid, result: ev.result });
  }

  if (candidates.length > MAX_BOOKINGS_PER_WEEK) {
    // Fail closed: book NOTHING for this week. Re-evaluated every hourly tick,
    // so a stale input that clears books normally; a real mass-violation week
    // waits for a human, which is the right owner for that call anyway.
    await _stampLineupHeartbeat(db, "lineup_booking", `refused:mass_booking wk${week} n=${candidates.length}`);
    return { ok: false, week, refused: "mass_booking", candidates: candidates.length, limit: MAX_BOOKINGS_PER_WEEK,
             detail: { candidates: candidates.map((c) => ({ fid: c.fid, reasons: c.result.violations.map((v) => v.reason) })), skipped } };
  }

  const booked = [];
  for (const c of candidates) {
    if (dryRun) { booked.push({ fid: c.fid, dry_run: true, reasons: c.result.violations.map((v) => v.reason) }); continue; }
    const b = await bookLineupViolation(env, { season, leagueId, fid: c.fid, week, result: c.result });
    booked.push({ fid: c.fid, offense_no: b.offense_no, rung: b.rung && b.rung.label,
                  reasons: c.result.violations.map((v) => v.reason) });
  }
  await _stampLineupHeartbeat(db, "lineup_booking", `ok:booked=${booked.length}`);
  return { ok: true, week, booked: booked.length, clean: clean.length, skipped: skipped.length,
           detail: { booked, skipped } };
}

// The */5 cron's entry point: book on the first 5-minute tick at or after the
// final kickoff instead of waiting for the hourly :05 run. Cheap when idle —
// one MFL schedule read (cached 60s) and a time comparison — and it only does
// the full evaluation inside FAST_BOOKING_WINDOW_SEC. Idempotent with the
// hourly run (same primary key; the second run finds the rows and skips), so
// the two crons overlapping at :05 cannot double-book.
export async function runLineupBookingFastPath(env, { season, leagueId, week, nowUnix }) {
  const now = Number(nowUnix) || Math.floor(Date.now() / 1000);
  const sched = await weekSchedule(season, week);
  const last = finalKickoffUnix(sched);
  if (!last || now < last || now >= last + FAST_BOOKING_WINDOW_SEC) return { ok: true, skipped: "outside_fast_window", final_kickoff: last || null };
  return runLineupBooking(env, { season, leagueId, week, nowUnix: now });
}

// fid -> franchise name, for the public post (DMs don't need this — Discord
// already knows who it's DMing).
async function franchiseNames(season, leagueId) {
  const d = await _json(`${MFL_WWW}/${season}/export?TYPE=league&L=${leagueId}&JSON=1`);
  const rows = d && d.league && d.league.franchises && _arr(d.league.franchises.franchise);
  if (!rows) return null;
  const out = {};
  for (const f of rows) { const fid = _fid(f && f.id); if (fid) out[fid] = _s(f && f.name) || `Team ${fid}`; }
  return out;
}

// Saturday morning ET, once. A plain UTC-hour gate (like the 09:05 UTC daily
// backup elsewhere) would drift a Saturday post onto Friday or Sunday across
// EDT/EST and DST — this reads the wall clock in the timezone the rule
// actually runs on.
function _etWeekdayHour(nowUnix) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "2-digit", hour12: false,
  }).formatToParts(new Date(nowUnix * 1000));
  const g = (t) => (f.find((p) => p.type === t) || {}).value;
  return { weekday: g("weekday"), hour: parseInt(g("hour"), 10) };
}
const SAT_ANNOUNCE_HOUR_ET = 8; // 8am ET Saturday — ahead of the Saturday-8pm MNF notice cap

// ── 3. the Saturday-AM public compliance post (§H, per Keith 2026-09-13) ───
//
// Distinct from runLineupDmSweep: that is a PRIVATE per-owner heads-up fired
// close to kickoff. This is ONE public post to the league, once a week,
// summarizing what the injury report says about everyone's CURRENT lineup —
// "based off the injury reports, not just DMs." Uses the same evaluator,
// final:false (advisory view — the week isn't over, nothing is booked here).

// "Sun 1PM ET" / "Sun 4:05PM ET" -- compact, no ":00" on the hour, no space
// before AM/PM (Keith 2026-09-19's own example: "Sun 1PM ET").
function fmtKickCompact(unix) {
  if (!unix) return "";
  const d = new Date(unix * 1000);
  const wd = d.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short" });
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "numeric", minute: "2-digit", hour12: true,
  }).formatToParts(d);
  let hour = "", minute = "", ampm = "";
  for (const p of parts) {
    if (p.type === "hour") hour = p.value;
    else if (p.type === "minute") minute = p.value;
    else if (p.type === "dayPeriod") ampm = p.value.toUpperCase();
  }
  const time = minute === "00" ? `${hour}${ampm}` : `${hour}:${minute}${ampm}`;
  return `${wd} ${time} ET`;
}

// Every ACTIVE-ROSTER player (any franchise, whether he's started or not)
// who is CURRENTLY Out or Doubtful, grouped by TEAM (Keith 2026-09-19,
// revising the original by-game ask: "rather than by game list each player
// per team that are out or doubtful. EXCLUDE TAXI & IR Players" -- a taxi
// or IR player was never going to start regardless of his injury tag, so
// listing him here is just noise). "Currently" = statusAsOf as of
// `nowUnix`, the same first-seen ledger the violation check reads, so this
// section and Part 1 can never disagree about what a player's status is
// RIGHT NOW.
function rosteredOutDoubtfulByTeam({ rosters, players, history, sched, names, nowUnix }) {
  const byFid = new Map();
  for (const fid of Object.keys(rosters || {})) {
    for (const r of (rosters[fid] || [])) {
      const st = _s(r && r.status);
      if (/taxi/i.test(st) || /ir|injured/i.test(st)) continue;
      const info = players[r.id];
      if (!info) continue;
      const status = statusAsOf(history[r.id] || [], nowUnix);
      if (status !== "OUT" && status !== "DOUBTFUL") continue;
      if (!byFid.has(fid)) byFid.set(fid, { fid, name: (names && names[fid]) || `Team ${fid}`, rows: [] });
      byFid.get(fid).rows.push({
        name: info.name || r.id, pos: info.position || "", team: info.team,
        status, kickoff: (sched && sched.kickoffByTeam || {})[info.team] || 0,
      });
    }
  }
  const teams = [...byFid.values()];
  teams.forEach((t) => t.rows.sort((a, b) => (a.kickoff - b.kickoff) || a.name.localeCompare(b.name)));
  teams.sort((a, b) => a.name.localeCompare(b.name));
  return teams;
}

// skipLog (Keith 2026-09-19: "can you show me a preview in the test
// channel?") bypasses the Sat-8am window check, the once-per-week dedup
// read AND the dedup write/heartbeat stamp -- everything except the actual
// compute-and-post. It exists so a preview (posted to a DIFFERENT channel
// via `channelId`) can never cannibalize the real weekly slot: without it,
// posting a preview would either poison ups_lineup_sat_announce_log for the
// real week (permanently blocking the production post) or, with dryRun
// instead, never actually post anything to look at. skipLog=true, dryRun=
// false is the preview combination -- a real Discord message, no bookkeeping.
// resolveMentions (optional) — async (env, fids[]) => Map<fid, userId[]>,
// e.g. index.js's resolveFranchiseMentions. Batched ONE call for every team
// with an issue, after they're known, rather than per-team -- same "one
// batched SELECT" discipline that function's own header documents. Without
// it every team renders by name only, exactly like before 2026-09-19.
export async function runLineupSaturdayAnnounce(env, { season, leagueId, week, nowUnix, channelId, dryRun = false, skipLog = false, resolveMentions }) {
  const db = env && env.UPS_MFL_DB;
  if (!db) return { ok: false, error: "no_db" };
  const now = Number(nowUnix) || Math.floor(Date.now() / 1000);

  if (!skipLog) {
    const { weekday, hour } = _etWeekdayHour(now);
    if (weekday !== "Sat" || hour !== SAT_ANNOUNCE_HOUR_ET) {
      return { ok: true, skipped: "not_sat_am_window" };
    }

    const already = await db.prepare(
      `SELECT 1 FROM ups_lineup_sat_announce_log WHERE season=? AND league_id=? AND week=?`
    ).bind(Number(season), String(leagueId), Number(week)).first();
    if (already) return { ok: true, skipped: "already_posted" };
  }

  const [players, rosters, byes, sched, names] = await Promise.all([
    playerIndex(season, leagueId),
    leagueRosters(season, leagueId, env.MFL_COOKIE),
    byeTeams(season, week),
    weekSchedule(season, week),
    franchiseNames(season, leagueId),
  ]);
  if (!players || !rosters || !sched) {
    await _stampLineupHeartbeat(db, "lineup_sat_announce", "skipped:inputs_unreadable");
    return { ok: true, skipped: "inputs_unreadable" };
  }

  const history = await injuryHistoryForWeek(env, { season, week });
  const observedFrom = await injuryObservedFrom(env, { season, week });

  const clean = [], issues = [];
  for (const fid of Object.keys(rosters).sort()) {
    const name = (names && names[fid]) || `Team ${fid}`;
    const ev = await evaluateFranchiseWeek(env, {
      season, leagueId, fid, week, roster: rosters[fid], players, sched, byes, history, observedFrom, final: false, nowUnix: now,
    });
    if (ev.skipped) { issues.push({ fid, name, verdict: "unchecked", lines: [`Lineup not readable yet (${ev.reason}).`] }); continue; }
    if (ev.result.verdict === "clean") { clean.push({ fid, name }); continue; }
    const lines = [...ev.result.violations, ...ev.result.advisories].map((l) => l.detail);
    issues.push({ fid, name, verdict: ev.result.verdict, lines });
  }

  // One batched mention lookup for every team that has something to fix
  // (Keith 2026-09-19: tag the owner so a 🚨/⚠️ line actually reaches them,
  // not just the team name). Best-effort -- a lookup failure falls back to
  // the bold team name exactly like before mentions existed.
  let mentionsByFid = new Map();
  if (typeof resolveMentions === "function" && issues.length) {
    try { mentionsByFid = await resolveMentions(env, issues.map((it) => it.fid)); } catch (_) { /* fall back to names */ }
  }
  const mentionFor = (fid) => {
    const ids = (mentionsByFid && mentionsByFid.get && mentionsByFid.get(fid)) || [];
    return ids.length ? ids.map((id) => `<@${id}>`).join(" ") : "";
  };

  const dateLabel = new Date(now * 1000).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "short", day: "numeric" });
  const L = [];
  L.push(`📋 **Week ${week} lineup check-in**`);
  L.push(`It's ${dateLabel} — here's where every lineup stands off this morning's injury report.`);
  L.push("");
  if (!issues.length) {
    L.push(`✅ All ${clean.length} teams clean — nobody starting an Out/Doubtful/bye player right now.`);
  } else {
    L.push(`✅ ${clean.length} team${clean.length === 1 ? "" : "s"} clean.`);
    L.push("");
    for (const it of issues) {
      const tag = it.verdict === "violation" ? "🚨" : it.verdict === "advisory" ? "⚠️" : "❔";
      const mention = mentionFor(it.fid);
      L.push(`${tag} **${it.name}**${mention ? " " + mention : ""}`);
      for (const line of it.lines) L.push(`   • ${line}`);
    }
    L.push("");
    L.push("_Violations are only counted at end of week — plenty of time to fix a bench before kickoff._");
  }

  const part1 = L.join("\n");

  // Part 2 -- Out/Doubtful, by TEAM, active roster only (Keith 2026-09-19,
  // revising the original by-game ask). Chunked the same way and for the
  // same reason as the by-game version this replaced: a 2026-09-19 test
  // post proved the un-chunked version silently truncates mid-league at
  // Discord's ~1900-char practical limit.
  const teamRows = rosteredOutDoubtfulByTeam({ rosters, players, history, sched, names, nowUnix: now });
  const part2Chunks = [];
  {
    const header = `🩹 **Week ${week} Saturday Injury Report: rostered players declared Out or Doubtful, by team**`;
    let cur = [header];
    let curLen = header.length;
    const flush = () => { if (cur.length) part2Chunks.push(cur.join("\n")); cur = []; curLen = 0; };
    if (!teamRows.length) {
      cur.push("Nobody on an active roster is currently listed Out or Doubtful.");
    }
    for (const t of teamRows) {
      const block = [`${t.name}:`, ...t.rows.map((r) => {
        const badge = r.status === "OUT" ? "🚨" : "⚠️";
        const when = r.kickoff ? fmtKickCompact(r.kickoff) : "kickoff unresolved";
        return `   ${badge} ${r.name}${r.team ? " - " + r.team : ""}${r.pos ? " (" + r.pos + ")" : ""} — ${when} (${r.status === "OUT" ? "OUT" : "DOUBTFUL"})`;
      })].join("\n");
      if (curLen && curLen + 1 + block.length > 1850) flush();
      cur.push(block);
      curLen += (curLen ? 1 : 0) + block.length;
    }
    flush();
  }

  // Threaded (Keith 2026-09-19: "Can we make it a threaded message? Thread
  // 'Week X Injury Report'"). One thread per week, Part 1 then Part 2
  // (however many chunks it takes) posted as messages inside it -- not a
  // thread spun off a single starter message, a standalone thread created
  // directly in the target channel.
  const messageIds = [];
  let messageId = "";     // the THREAD id -- what gets logged/returned as "the post"
  if (!dryRun) {
    try {
      const botToken = _s(env.DISCORD_BOT_TOKEN || env.DISCORD_BOT || "");
      const chId = _s(channelId || env.DISCORD_LINEUP_ANNOUNCE_CHANNEL_ID || "");
      if (chId === COFFEE_SHOP_CHANNEL_ID) {
        console.log("[lineup-sat-announce] REFUSED: resolved channel is the Coffee Shop -- this post never goes there, by design.");
        return { ok: false, error: "coffee_shop_blocked", message: "This post is permanently blocked from the Coffee Shop. Nothing was sent." };
      }
      if (botToken && chId) {
        const threadRes = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(chId)}/threads`, {
          method: "POST",
          headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json",
                     "User-Agent": "upsmflproduction-worker" },
          // type 11 = GUILD_PUBLIC_THREAD, standalone (no parent message) --
          // valid directly in a normal text channel. 10080 min = 7 days
          // before it auto-archives, so it's still open mid-week.
          body: JSON.stringify({ name: `Week ${week} Injury Report`.slice(0, 100), type: 11, auto_archive_duration: 10080 }),
        });
        const thread = await threadRes.json().catch(() => null);
        const threadId = threadRes.ok ? _s(thread && thread.id) : "";
        if (threadId) {
          messageId = threadId;
          for (const chunk of [part1, ...part2Chunks]) {
            const res = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(threadId)}/messages`, {
              method: "POST",
              headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json",
                         "User-Agent": "upsmflproduction-worker" },
              // allowed_mentions now permits user pings (Keith 2026-09-19
              // added owner @mentions to Part 1 so the 🚨/⚠️ lines actually
              // reach them); every other Discord post this module sends
              // stays silent.
              body: JSON.stringify({ content: chunk.slice(0, 1900), allowed_mentions: { parse: ["users"] } }),
            });
            const j = await res.json().catch(() => null);
            if (res.ok && j && j.id) messageIds.push(_s(j.id));
          }
        } else {
          console.log(`[lineup-sat-announce] thread creation failed: ${JSON.stringify(thread)}`);
        }
      }
    } catch (e) { console.log(`[lineup-sat-announce] post failed: ${e && e.message}`); }
    if (!skipLog) {
      await db.prepare(
        `INSERT OR IGNORE INTO ups_lineup_sat_announce_log
           (season, league_id, week, message_id, clean_count, issue_count, posted_unix)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(Number(season), String(leagueId), Number(week), messageId, clean.length, issues.length, now).run();
    }
  }

  if (!skipLog) {
    await _stampLineupHeartbeat(db, "lineup_sat_announce", `ok:clean=${clean.length} issues=${issues.length}`);
  }
  return {
    ok: true, week, clean: clean.length, issues: issues.length,
    thread_id: messageId, message_id: messageId, message_ids: messageIds, message_count: [part1, ...part2Chunks].length,
    body: part1, part2_chunks: part2Chunks, preview: skipLog,
  };
}
