// §H delivery layer for §G3 lineup compliance — the plumbing around
// lineup_compliance.js's evaluator.
//
// Three jobs, all driven off the hourly cron:
//
//   1. runLineupDmSweep()       — 1.5h before each game window, DM every
//                                 owner their status. Keith's §H spec.
//   2. runLineupBooking()       — once the week's last game is final,
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

// REMOVED 2026-09-19. Used to answer "could this owner have started somebody
// else in his place?" so a bad starter with no eligible bench replacement
// downgraded to an advisory (Keith 2026-08-17). Keith corrected that same
// ruling live: "it doesn't matter if there's nobody eligible it would be a
// violation" -- so the question this function answered no longer changes
// anything, and it's gone along with its one call site in ctxFor below.

// Assemble everything one franchise-week needs and hand it to the evaluator.
// `final` false = a pre-kickoff advisory pass; true = the end-of-week booking.
// `nowUnix` (optional) lets evaluateStarter tell a still-ahead kickoff from a
// finished one -- pass the caller's own `now` for a preview/DM pass; omit it
// for the booking pass, which never runs until every kickoff in the week is
// hours in the past anyway (see WEEK_SETTLE_SEC).
export async function evaluateFranchiseWeek(env, {
  season, leagueId, fid, week, roster, players, sched, byes, history, observedFrom, final, nowUnix,
}) {
  const st = await submittedStarters(season, leagueId, fid, roster, env && env.MFL_COOKIE);
  if (!st.known) {
    // No lineup, or an unreadable one. Either way this module refuses to judge:
    // "failed to submit any lineup" is a SEPARATE §G3 offense with its own
    // process (explain by Tuesday, league vote), not something to book here.
    return { skipped: true, reason: st.state, detail: st.reason };
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
  const last = sched.kickoffs[sched.kickoffs.length - 1] || 0;
  // Wait for the last game to finish AND for injury status to settle. Booking
  // early would judge a player whose game has not kicked off yet.
  if (!last || now < last + WEEK_SETTLE_SEC) { await _stampLineupHeartbeat(db, "lineup_booking", "ok:week_not_final"); return { ok: true, skipped: "week_not_final" }; }

  const [players, rosters, byes] = await Promise.all([
    playerIndex(season, leagueId),
    leagueRosters(season, leagueId, env.MFL_COOKIE),
    byeTeams(season, week),
  ]);
  if (!players || !rosters) { await _stampLineupHeartbeat(db, "lineup_booking", "skipped:inputs_unreadable"); return { ok: true, skipped: "inputs_unreadable" }; }

  const history = await injuryHistoryForWeek(env, { season, week });
  const observedFrom = await injuryObservedFrom(env, { season, week });

  const booked = [], clean = [], skipped = [];
  for (const fid of Object.keys(rosters).sort()) {
    const already = await db.prepare(
      `SELECT 1 FROM ups_lineup_violations WHERE season=? AND league_id=? AND fid=? AND week=?`
    ).bind(Number(season), String(leagueId), fid, Number(week)).first();
    if (already) { skipped.push({ fid, reason: "already_booked" }); continue; }

    const ev = await evaluateFranchiseWeek(env, {
      season, leagueId, fid, week, roster: rosters[fid], players, sched, byes, history, observedFrom, final: true, nowUnix: now,
    });
    if (ev.skipped) { skipped.push({ fid, reason: ev.reason }); continue; }
    if (ev.result.verdict !== "violation") { clean.push(fid); continue; }
    if (dryRun) { booked.push({ fid, dry_run: true, reasons: ev.result.violations.map((v) => v.reason) }); continue; }

    const b = await bookLineupViolation(env, { season, leagueId, fid, week, result: ev.result });
    booked.push({ fid, offense_no: b.offense_no, rung: b.rung && b.rung.label,
                  reasons: ev.result.violations.map((v) => v.reason) });
  }
  await _stampLineupHeartbeat(db, "lineup_booking", `ok:booked=${booked.length}`);
  return { ok: true, week, booked: booked.length, clean: clean.length, skipped: skipped.length,
           detail: { booked, skipped } };
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

// Every ROSTERED player (any franchise, whether he's started or not) who is
// CURRENTLY Out or Doubtful, grouped by his NFL game (Keith 2026-09-19:
// "please post a list of players per game that are rostered and either Out
// or Doubtful"). Separate from the per-team violation list above: this is
// informational for the whole league, not a judgment about anyone's lineup
// choices. "Currently" = statusAsOf as of `nowUnix`, the same first-seen
// ledger the violation check reads, so the two sections can never disagree
// about what a player's status is RIGHT NOW.
function rosteredOutDoubtfulByGame({ rosters, players, history, sched, names, nowUnix }) {
  const ownerOf = {};
  for (const fid of Object.keys(rosters || {})) {
    for (const r of (rosters[fid] || [])) ownerOf[r.id] = fid;
  }
  const gameByTeam = new Map();
  for (const g of (sched && sched.games) || []) {
    gameByTeam.set(g.home, g);
    gameByTeam.set(g.away, g);
  }
  const byGame = new Map();
  for (const pid of Object.keys(ownerOf)) {
    const info = players[pid];
    if (!info) continue;
    const status = statusAsOf(history[pid] || [], nowUnix);
    if (status !== "OUT" && status !== "DOUBTFUL") continue;
    const game = gameByTeam.get(info.team);
    if (!game) continue;   // on a bye, or a team not in this week's schedule
    const key = `${game.away}@${game.home}`;
    if (!byGame.has(key)) byGame.set(key, { ...game, rows: [] });
    const fid = ownerOf[pid];
    byGame.get(key).rows.push({
      name: info.name || pid, pos: info.position || "", team: info.team,
      status, owner: (names && names[fid]) || `Team ${fid}`,
    });
  }
  return [...byGame.values()].sort((a, b) => a.kickoff - b.kickoff);
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

  // Out/Doubtful, by game -- every rostered player, not just this week's
  // issues above (Keith 2026-09-19).
  const gameRows = rosteredOutDoubtfulByGame({ rosters, players, history, sched, names, nowUnix: now });
  L.push("");
  L.push(`🩹 **Rostered players Out/Doubtful, by game**`);
  if (!gameRows.length) {
    L.push("Nobody rostered is currently listed Out or Doubtful.");
  } else {
    for (const g of gameRows) {
      const when = new Date(g.kickoff * 1000).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" });
      L.push(`${when} ET — ${g.away} @ ${g.home}`);
      for (const r of g.rows) {
        const badge = r.status === "OUT" ? "🚨" : "⚠️";
        L.push(`   ${badge} ${r.name}${r.pos ? " (" + r.pos + ")" : ""} — ${r.status === "OUT" ? "Out" : "Doubtful"} · ${r.owner}`);
      }
    }
  }
  const body = L.join("\n");

  let messageId = "";
  if (!dryRun) {
    try {
      const { postToDiscordChannel } = await import("./discord_roast_reply.js");
      const botToken = _s(env.DISCORD_BOT_TOKEN || env.DISCORD_BOT || "");
      const chId = _s(channelId || env.DISCORD_LINEUP_ANNOUNCE_CHANNEL_ID || "");
      if (botToken && chId) {
        const res = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(chId)}/messages`, {
          method: "POST",
          headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json",
                     "User-Agent": "upsmflproduction-worker" },
          // allowed_mentions now permits user pings (Keith 2026-09-19 added
          // owner @mentions to this post so the 🚨/⚠️ lines actually reach
          // them); every other Discord post this module sends stays silent.
          body: JSON.stringify({ content: body.slice(0, 1900), allowed_mentions: { parse: ["users"] } }),
        });
        const j = await res.json().catch(() => null);
        if (res.ok) messageId = _s(j && j.id);
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
  return { ok: true, week, clean: clean.length, issues: issues.length, message_id: messageId, body, preview: skipLog };
}
