// §G3 correction DM (2026-10-25, Brian Branch, Team 0009, Week 7).
//
// A pre-kickoff lineup DM can name a player the injury report no longer lists
// (PR #1397 fixed the cause). This is the narrow, audited way to tell the owner.
// It is NOT a general DM sender:
//   - the text is a fixed template; the only variable is the player's name;
//   - it refuses unless a violation DM naming that exact player was actually
//     sent to that franchise that week (ups_lineup_dm_log);
//   - it refuses unless the injury report, read fresh, no longer shows the
//     player Out / IR / Doubtful (so it can never "correct" a real flag);
//   - it sends at most once per franchise, week and player (the claim row is
//     written BEFORE the send, and removed again only if nothing was delivered);
//   - without confirm:"send" it only previews and writes nothing.

import { playerIndex } from "./lineup_wiring.js";
import { injuryHistoryForWeek, statusAsOf, lastInjuryPollUnix } from "./lineup_compliance.js";

const _s = (v) => String(v == null ? "" : v).trim();
export const CORRECTION_MAX_POLL_AGE_SEC = 3 * 3600;

// "Branch, Brian" -> "Brian Branch"
export function displayPlayerName(raw) {
  const n = _s(raw);
  const m = n.match(/^([^,]+),\s*(.+)$/);
  return m ? `${m[2].trim()} ${m[1].trim()}` : n;
}

export function composeCorrectionDm({ playerName, week, teamLabel, count = 2 }) {
  const msgs = count === 1 ? "message you received was" : "messages you received were";
  return `Correction: ${playerName} came off the injury report before kickoff, so he is fine to start. ` +
    `The "Possible lineup violation — Week ${week}" ${msgs} based on an out-of-date injury status. ` +
    `Nothing counts against ${teamLabel}.`;
}

// `deps` is for tests only: { players, history, resolveIds, openDmChannel, sendDm }.
export async function sendLineupCorrectionDm(env, { season, leagueId, fid, week, playerId, send = false, nowUnix, deps = {} }) {
  const db = env && env.UPS_MFL_DB;
  if (!db) return { ok: false, error: "no_db" };
  const now = Number(nowUnix) || Math.floor(Date.now() / 1000);
  const pid = _s(playerId).replace(/\D/g, "");
  if (!pid) return { ok: false, error: "need_player_id" };

  const players = deps.players || await playerIndex(season, leagueId);
  const info = players && players[pid];
  if (!info) return { ok: false, error: "player_unreadable" };   // fail closed

  // 1. A violation DM naming exactly this player was really sent.
  const { results } = await db.prepare(
    `SELECT window_key, body FROM ups_lineup_dm_log
      WHERE season=? AND league_id=? AND fid=? AND week=? AND verdict='violation'`
  ).bind(Number(season), String(leagueId), String(fid), Number(week)).all();
  const needle = `• ${info.name} was listed`;
  const flagged = (results || []).filter((r) => _s(r.body).includes(needle));
  if (!flagged.length) return { ok: false, error: "no_flag_found", detail: `no Week ${week} violation DM to ${fid} names ${info.name}` };

  // 2. The report no longer lists him as Out / IR / Doubtful, read fresh.
  const history = deps.history || await injuryHistoryForWeek(env, { season, week });
  const lastPoll = lastInjuryPollUnix(history);
  if (!lastPoll || now - lastPoll > CORRECTION_MAX_POLL_AGE_SEC) {
    return { ok: false, error: "injury_data_stale", last_poll_unix: lastPoll || null };
  }
  const nowStatus = statusAsOf(history[pid] || [], now);
  if (nowStatus === "OUT" || nowStatus === "IR" || nowStatus === "DOUBTFUL") {
    return { ok: false, error: "still_listed", status: nowStatus };
  }

  const teamLabel = `Team ${fid}`;
  const text = composeCorrectionDm({ playerName: displayPlayerName(info.name), week, teamLabel, count: flagged.length });
  const windowKey = `correction:${pid}`;

  const already = await db.prepare(
    `SELECT sent_unix FROM ups_lineup_dm_log WHERE season=? AND league_id=? AND fid=? AND week=? AND window_key=?`
  ).bind(Number(season), String(leagueId), String(fid), Number(week), windowKey).first();
  if (already) return { ok: true, already_sent: true, sent_unix: Number(already.sent_unix) || null };

  const ids = deps.resolveIds ? await deps.resolveIds(env, fid) : await (await import("./trade_dm.js")).resolveDiscordUserIds(env, fid);
  const preview = { ok: true, preview: !send, text, flagged_windows: flagged.map((r) => r.window_key), recipients: (ids || []).length, injury_poll_unix: lastPoll, status_now: nowStatus || "ACTIVE" };
  if (!send) return preview;
  if (!(ids || []).length) return { ...preview, ok: false, error: "no_discord_recipient", preview: false };

  // Claim BEFORE sending: a double click or a retry can never DM twice.
  const claim = await db.prepare(
    `INSERT OR IGNORE INTO ups_lineup_dm_log (season, league_id, fid, week, window_key, verdict, body, sent_unix)
     VALUES (?, ?, ?, ?, ?, 'correction', ?, ?)`
  ).bind(Number(season), String(leagueId), String(fid), Number(week), windowKey, text, now).run();
  if (!(claim && claim.meta && claim.meta.changes > 0)) return { ok: true, already_sent: true };

  const dr = deps.sendDm ? null : await import("./discord_round.js");
  const sendDm = deps.sendDm || dr.sendDm, openDmChannel = deps.openDmChannel || dr.openDmChannel;
  let delivered = 0;
  for (const uid of ids) {
    try {
      const ch = await openDmChannel(env, uid);
      if (!ch) continue;
      const r = await sendDm(env, ch, { content: text });
      if (r && r.ok) delivered += 1;
    } catch (_) { /* counted as not delivered */ }
  }
  if (!delivered) {
    // Nothing went out: release the claim so a retry is possible.
    await db.prepare(
      `DELETE FROM ups_lineup_dm_log WHERE season=? AND league_id=? AND fid=? AND week=? AND window_key=? AND verdict='correction'`
    ).bind(Number(season), String(leagueId), String(fid), Number(week), windowKey).run();
    return { ok: false, error: "not_delivered", recipients: ids.length };
  }
  return { ok: true, sent: delivered, recipients: ids.length, sent_unix: now, text };
}
