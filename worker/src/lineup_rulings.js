// §G3 — from a booked CANDIDATE to a commissioner RULING, a final NOTICE, and a
// MANUAL sanction checklist.
//
// lineup_compliance.js decides whether a franchise-week looks illegal and
// lineup_wiring.js books it into ups_lineup_violations. Until this module,
// nothing happened after that: no ruling, no notice, no record of a penalty.
// The Saturday Injury Report post is a pre-game warning, not that notice.
//
// THREE THINGS, KEPT APART ON PURPOSE
//
//   candidate   ups_lineup_violations      what the algorithm booked
//   ruling      ups_lineup_rulings.ruling  what the commissioner decided
//   sanction    ups_lineup_rulings.sanction_status
//                                          what still has to be done on MFL
//
// 2026 is the reason. A lineup-read bug booked all 12 franchises in every week
// 1-4 (48 rows); the only thing that kept 12 owners from being told they were
// on their 4th violation is that nothing read the table. So:
//
//   - nothing is announced from a candidate; only a CONFIRMED ruling posts;
//   - a week cannot be confirmed while an EARLIER week for the same franchise
//     is still an unruled candidate, because that earlier row sets this one's
//     offense number (a bogus #1-#4 would make a real first offense read #5);
//   - no MFL write ever happens here. The ladder's pick and cap consequences
//     are written out as a checklist (sanction_status 'pending_manual') and
//     marked done by a person.
//
// Canon: docs/league_context_v1.md §G3. The ladder resets each season; one
// violation per franchise-week; commissioner immunity is retroactive (void).

import { LINEUP_LADDER, lineupLadderRung, voidLineupViolation, recomputeLineupOffenses } from "./lineup_compliance.js";

// Same hard block as lineup_wiring.js (Keith 2026-09-19: "NEVER POST TO
// COFFEE SHOP only to the injury report page").
export const COFFEE_SHOP_CHANNEL_ID = "1087157907419840644";
export const MENTION_TOKEN = "{{MENTION}}";

const _s = (v) => String(v == null ? "" : v).trim();
const _fid = (v) => { const d = _s(v).replace(/\D/g, ""); return d ? d.padStart(4, "0") : ""; };
const _nowIso = () => new Date().toISOString();

export function ordinal(n) {
  const k = Number(n) || 0;
  const t = k % 100;
  if (t >= 11 && t <= 13) return `${k}th`;
  return `${k}${({ 1: "st", 2: "nd", 3: "rd" })[k % 10] || "th"}`;
}

// MFL names are "Last, First". Owners read "First Last".
export function displayName(mflName) {
  const s = _s(mflName);
  if (!s.includes(",")) return s;
  const [last, first] = s.split(",", 2).map(_s);
  return first ? `${first} ${last}` : last;
}

// What the ladder says happens at this offense, as a plan for a PERSON to carry
// out. `season` is the season of the offense; cap money lands on the next one.
export function sanctionPlan(offenseNo, season) {
  const rung = lineupLadderRung(offenseNo);
  if (!rung) return null;
  const next = Number(season) + 1;
  const steps = [];
  if (rung.pick) {
    steps.push(`Strip a ${rung.pick}-round pick on MFL. If the franchise holds none, it is taken the next time one becomes available (trade or league-year rollover).`);
  }
  if (rung.cap_k) {
    steps.push(`Post a $${rung.cap_k}K salary adjustment against the ${next} cap.`);
  }
  if (rung.membership === "retention") steps.push("Call a league vote on retention. The cap adjustment above applies only if retained.");
  if (rung.membership === "expulsion") steps.push("Automatic expulsion: commissioner process, not an app action.");
  return {
    offense_no: Number(offenseNo),
    label: rung.label,
    pick_round: rung.pick || null,
    cap_k: rung.cap_k || 0,
    cap_season: rung.cap_k ? next : null,
    membership: rung.membership || null,
    steps,
    status: steps.length ? "pending_manual" : "none",
  };
}

function consequencePhrase(offenseNo, season) {
  const next = Number(season) + 1;
  switch (Number(offenseNo)) {
    case 1: return "warning, no penalty";
    case 2: return `loss of a 4th-round pick + $5K against the ${next} cap`;
    case 3: return `loss of a 2nd-round pick + a further $5K against the ${next} cap`;
    case 4: return `league vote on retention; +$10K against the ${next} cap if retained`;
    default: return "automatic expulsion";
  }
}

const listNames = (ns) => (ns.length <= 1 ? ns.join("") : `${ns.slice(0, -1).join(", ")} and ${ns[ns.length - 1]}`);

// The evaluator's per-starter verdicts, in the owner's terms: starters with the
// same reason share one clause ("A and B were listed OUT ..."), clauses join
// with "; ". Order follows the first appearance of each reason.
export function describeViolations(violations) {
  const groups = new Map();
  const loose = [];
  for (const v of (violations || [])) {
    const reason = _s(v && v.reason);
    if (reason === "out" || reason === "doubtful_did_not_play" || reason === "bye") {
      if (!groups.has(reason)) groups.set(reason, []);
      groups.get(reason).push(displayName(v && v.name));
    } else {
      loose.push(reason === "missing_starter" ? (_s(v && v.detail) || "The lineup was short") : (_s(v && v.detail) || reason));
    }
  }
  const clauses = [];
  for (const [reason, names] of groups) {
    const be = names.length > 1 ? "were" : "was";
    if (reason === "out") clauses.push(`${listNames(names)} ${be} listed OUT before the notice deadline and did not play`);
    if (reason === "doubtful_did_not_play") clauses.push(`${listNames(names)} ${be} Doubtful at the notice deadline and did not play`);
    if (reason === "bye") clauses.push(`${listNames(names)} ${be} on a bye`);
  }
  return [...loose.map((l) => l.replace(/\.$/, "")), ...clauses].join("; ");
}

function ladderLine(season) {
  const next = Number(season) + 1;
  return `Ladder this season: #2 = 4th-round pick + $5K (${next} cap) · #3 = 2nd-round pick + $5K · #4 = retention vote + $10K · #5 = expulsion. Resets every season.`;
}

// The two messages a CONFIRMED ruling sends. `league` carries MENTION_TOKEN
// right after the team name; postLineupNotice swaps it for the owner's
// @mention (or nothing). Stored at ruling time so what was previewed posts.
export function composeFinalNotices({ teamName, week, season, offenseNo, violations }) {
  const team = _s(teamName) || "Team";
  const what = describeViolations(violations);
  const nth = ordinal(offenseNo);
  const cons = consequencePhrase(offenseNo, season);
  const nextRung = lineupLadderRung(Number(offenseNo) + 1);
  const nextLine = Number(offenseNo) < LINEUP_LADDER.length && nextRung
    ? `A ${ordinal(Number(offenseNo) + 1)} violation this season means ${consequencePhrase(Number(offenseNo) + 1, season)}.`
    : "";

  const owner = [
    `⚖️ **Week ${week} lineup ruling — ${team}**`,
    `${what}.`,
    "",
    `Under §G3 that is one lineup violation for the week. It's your **${nth} this season: ${cons}.**`,
    nextLine,
    "",
    "If something outside your control kept you from changing it, reply to the commissioner — a violation can be excused after the fact.",
  ].filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n").replace(/\n{3,}/g, "\n\n").trim();

  const league = [
    `⚖️ **Week ${week} lineup ruling**`,
    `**${team}**${MENTION_TOKEN}: **${nth} violation (${cons}).** ${what}.`,
    "",
    `One violation per week, however many starters. ${ladderLine(season)}`,
  ].join("\n");

  return { owner, league };
}

// The franchise's MFL name for the notice. Falls back to "Team 0002" rather
// than failing: the name is cosmetic, the ruling is not.
export async function fetchTeamName(season, leagueId, fid) {
  try {
    const r = await fetch(`https://www48.myfantasyleague.com/${encodeURIComponent(season)}/export?TYPE=league&L=${encodeURIComponent(leagueId)}&JSON=1`,
      { headers: { "User-Agent": "upsmflproduction-worker" } });
    const d = r.ok ? await r.json().catch(() => null) : null;
    const rows = d && d.league && d.league.franchises && d.league.franchises.franchise;
    const hit = (Array.isArray(rows) ? rows : rows ? [rows] : []).find((f) => _fid(f && f.id) === _fid(fid));
    return _s(hit && hit.name) || `Team ${_fid(fid)}`;
  } catch (_) {
    return `Team ${_fid(fid)}`;
  }
}

// ── D1 ──────────────────────────────────────────────────────────────────────

const KEY_SQL = "season=? AND league_id=? AND fid=? AND week=?";
const keyArgs = (k) => [Number(k.season), String(k.leagueId), _fid(k.fid), Number(k.week)];

export async function getCandidate(db, k) {
  return await db.prepare(`SELECT * FROM ups_lineup_violations WHERE ${KEY_SQL}`).bind(...keyArgs(k)).first();
}

export async function getRuling(db, k) {
  return await db.prepare(`SELECT * FROM ups_lineup_rulings WHERE ${KEY_SQL}`).bind(...keyArgs(k)).first();
}

// Every candidate this season with its ruling (if any), oldest week first.
// `preview_offense_no` is what the offense number WOULD be if confirmed now:
// 1 + earlier unvoided candidates. Read-only.
export async function listLineupCases(env, { season, leagueId }) {
  const db = env && env.UPS_MFL_DB;
  if (!db) return { ok: false, error: "no_db" };
  const { results } = await db.prepare(
    `SELECT v.season, v.league_id, v.fid, v.week, v.offense_no, v.reasons_json, v.needs_review, v.review_note,
            v.voided, v.void_reason, v.voided_by, v.recorded_at_utc,
            r.ruling, r.offense_no AS ruled_offense_no, r.note AS ruling_note, r.ruled_by, r.ruled_at_utc,
            r.notice_claimed_at_utc, r.notice_posted_at_utc, r.notice_error, r.sanction_status
       FROM ups_lineup_violations v
       LEFT JOIN ups_lineup_rulings r
         ON r.season=v.season AND r.league_id=v.league_id AND r.fid=v.fid AND r.week=v.week
      WHERE v.season=? AND v.league_id=?
      ORDER BY v.fid, v.week`
  ).bind(Number(season), String(leagueId)).all();
  const rows = (results || []).map((r) => ({ ...r }));
  const live = {};
  for (const r of rows) {
    if (Number(r.voided)) { r.preview_offense_no = 0; continue; }
    live[r.fid] = (live[r.fid] || 0) + 1;
    r.preview_offense_no = live[r.fid];
  }
  return { ok: true, season: Number(season), league_id: String(leagueId), cases: rows };
}

// Record the commissioner's ruling on one candidate.
//   ruling 'confirmed' — it stands; composes the final notice and the sanction plan.
//   ruling 'excused'   — commissioner immunity; voids the candidate (never deletes)
//                        and re-derives later offense numbers.
// Idempotent: the same ruling twice changes nothing. Once a notice has been
// claimed for posting, the ruling is frozen.
export async function recordLineupRuling(env, { season, leagueId, fid, week, ruling, note, by, teamName }) {
  const db = env && env.UPS_MFL_DB;
  if (!db) return { ok: false, error: "no_db" };
  const k = { season, leagueId, fid, week };
  const rl = _s(ruling).toLowerCase();
  if (rl !== "confirmed" && rl !== "excused") return { ok: false, error: "bad_ruling", detail: "ruling must be confirmed or excused" };
  if (!_s(by)) return { ok: false, error: "by_required" };

  const cand = await getCandidate(db, k);
  if (!cand) return { ok: false, error: "no_candidate", detail: "nothing was booked for this franchise-week" };

  const existing = await getRuling(db, k);
  if (existing && existing.notice_claimed_at_utc) {
    if (existing.ruling === rl) return { ok: true, unchanged: true, ruling: existing };
    return { ok: false, error: "notice_already_claimed", detail: "the final notice for this ruling has been posted or is posting; the ruling is frozen" };
  }
  if (existing && existing.ruling === rl && _s(existing.note) === _s(note)) return { ok: true, unchanged: true, ruling: existing };

  const now = _nowIso();
  let offenseNo = 0, sanction = null, notices = { owner: null, league: null };

  if (rl === "excused") {
    // Excusing re-derives every LATER offense number. A later week that has
    // already been confirmed carries its number in its notice and sanction
    // plan, so silently renumbering underneath it would leave both wrong.
    const later = await db.prepare(
      `SELECT week FROM ups_lineup_rulings
        WHERE season=? AND league_id=? AND fid=? AND week > ? AND ruling='confirmed' ORDER BY week`
    ).bind(...keyArgs(k)).all();
    const laterWeeks = ((later && later.results) || []).map((r) => Number(r.week));
    if (laterWeeks.length) return { ok: false, error: "later_ruling_exists", weeks: laterWeeks, detail: "a later confirmed week would be renumbered; correct it by hand" };
    if (!Number(cand.voided)) {
      await voidLineupViolation(env, { season, leagueId, fid: _fid(fid), week, reason: _s(note) || "excused by commissioner", by });
    }
  } else {
    if (Number(cand.voided)) return { ok: false, error: "candidate_voided", detail: "this week was voided; it cannot be confirmed" };
    if (Number(cand.needs_review) && !_s(note)) return { ok: false, error: "review_note_required", detail: _s(cand.review_note) || "this candidate is flagged needs_review" };
    // An earlier week that is still only a candidate decides this week's
    // number. Rule it first — never let an unreviewed row price this one.
    const earlier = await db.prepare(
      `SELECT v.week FROM ups_lineup_violations v
         LEFT JOIN ups_lineup_rulings r
           ON r.season=v.season AND r.league_id=v.league_id AND r.fid=v.fid AND r.week=v.week
        WHERE v.season=? AND v.league_id=? AND v.fid=? AND v.week < ? AND v.voided=0 AND r.ruling IS NULL
        ORDER BY v.week`
    ).bind(...keyArgs(k)).all();
    const pending = ((earlier && earlier.results) || []).map((r) => Number(r.week));
    if (pending.length) return { ok: false, error: "earlier_candidates_unruled", weeks: pending };

    const ladder = await recomputeLineupOffenses(env, { season, leagueId, fid: _fid(fid) });
    const mine = (ladder || []).find((x) => Number(x.week) === Number(week));
    offenseNo = mine ? Number(mine.offense_no) : 0;
    if (!offenseNo) return { ok: false, error: "offense_unresolved" };
    let violations = [];
    try { violations = JSON.parse(cand.reasons_json || "[]"); } catch (_) { violations = []; }
    if (!violations.length) return { ok: false, error: "candidate_has_no_reasons" };
    sanction = sanctionPlan(offenseNo, season);
    notices = composeFinalNotices({ teamName: teamName || `Team ${_fid(fid)}`, week, season, offenseNo, violations });
  }

  await db.prepare(
    `INSERT INTO ups_lineup_rulings
       (season, league_id, fid, week, ruling, offense_no, candidate_reasons_json, note, ruled_by, ruled_at_utc,
        owner_notice, league_notice, sanction_json, sanction_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(season, league_id, fid, week) DO UPDATE SET
       ruling=excluded.ruling, offense_no=excluded.offense_no, candidate_reasons_json=excluded.candidate_reasons_json,
       note=excluded.note, ruled_by=excluded.ruled_by, ruled_at_utc=excluded.ruled_at_utc,
       owner_notice=excluded.owner_notice, league_notice=excluded.league_notice,
       sanction_json=excluded.sanction_json, sanction_status=excluded.sanction_status`
  ).bind(
    ...keyArgs(k), rl, offenseNo, cand.reasons_json || null, _s(note) || null, _s(by), now,
    notices.owner, notices.league, sanction ? JSON.stringify(sanction) : null, sanction ? sanction.status : "none"
  ).run();

  return { ok: true, ruling: rl, offense_no: offenseNo, sanction, notices: rl === "confirmed" ? notices : null };
}

async function _discordPost(env, channelId, content) {
  const token = _s(env.DISCORD_BOT_TOKEN || env.DISCORD_BOT || "");
  if (!token) return { ok: false, status: 0, error: "no_bot_token" };
  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json", "User-Agent": "upsmflproduction-worker" },
      body: JSON.stringify({ content: String(content).slice(0, 1900), allowed_mentions: { parse: ["users"] } }),
    });
    const j = await res.json().catch(() => null);
    return { ok: res.ok && !!(j && j.id), status: res.status, id: _s(j && j.id), error: res.ok ? "" : JSON.stringify(j).slice(0, 300) };
  } catch (e) {
    return { ok: false, status: 0, error: _s(e && e.message) };
  }
}

async function _defaultDm(env, fid, content) {
  const { resolveDiscordUserIds, dmAll } = await import("./trade_dm.js");
  const ids = await resolveDiscordUserIds(env, fid);
  if (!ids || !ids.length) return { sent: 0, undeliverable: false, no_recipient: true };
  const r = await dmAll(env, ids, { content });
  return { sent: r.sent, undeliverable: !!r.undeliverable };
}

// Post a CONFIRMED ruling's final notice: one league message (into that week's
// Injury Report thread when it exists, else the Injury Report channel) and one
// owner DM. Exactly once — claimed before posting, so a double-tap cannot post
// twice; a failure keeps the claim and records the error for a person to look
// at rather than retrying on its own.
export async function postLineupNotice(env, { season, leagueId, fid, week, channelId, mention = true, resolveMentions, dmImpl }) {
  const db = env && env.UPS_MFL_DB;
  if (!db) return { ok: false, error: "no_db" };
  const k = { season, leagueId, fid, week };
  const r = await getRuling(db, k);
  if (!r) return { ok: false, error: "no_ruling" };
  if (r.ruling !== "confirmed") return { ok: false, error: "not_confirmed", detail: "only a confirmed ruling posts a notice" };
  if (!_s(r.league_notice) || !_s(r.owner_notice)) return { ok: false, error: "notice_missing" };

  const ch = _s(channelId || env.DISCORD_LINEUP_ANNOUNCE_CHANNEL_ID || "");
  if (!ch) return { ok: false, error: "no_channel" };
  if (ch === COFFEE_SHOP_CHANNEL_ID) return { ok: false, error: "coffee_shop_blocked" };

  const claimedAt = _nowIso();
  const claim = await db.prepare(
    `UPDATE ups_lineup_rulings SET notice_claimed_at_utc=?
      WHERE ${KEY_SQL} AND ruling='confirmed' AND notice_claimed_at_utc IS NULL`
  ).bind(claimedAt, ...keyArgs(k)).run();
  if (!claim || !claim.meta || Number(claim.meta.changes) !== 1) {
    return { ok: false, error: "already_claimed", posted_at: r.notice_posted_at_utc || null };
  }

  let mentionText = "";
  if (mention && typeof resolveMentions === "function") {
    try {
      const m = await resolveMentions(env, [_fid(fid)]);
      const ids = (m && m.get && m.get(_fid(fid))) || [];
      if (ids.length) mentionText = " " + ids.map((id) => `<@${id}>`).join(" ");
    } catch (_) { mentionText = ""; }
  }
  const leagueText = _s(r.league_notice).split(MENTION_TOKEN).join(mentionText);

  // Prefer the week's own Injury Report thread (logged by the Saturday post).
  let target = ch;
  try {
    const t = await db.prepare(
      `SELECT message_id FROM ups_lineup_sat_announce_log WHERE season=? AND league_id=? AND week=?`
    ).bind(Number(season), String(leagueId), Number(week)).first();
    if (t && /^\d{15,22}$/.test(_s(t.message_id))) target = _s(t.message_id);
  } catch (_) { /* channel fallback */ }

  let post = await _discordPost(env, target, leagueText);
  if (!post.ok && target !== ch) post = await _discordPost(env, ch, leagueText);

  let dm = { sent: 0, undeliverable: false };
  try { dm = await (dmImpl || _defaultDm)(env, _fid(fid), _s(r.owner_notice)); } catch (e) { dm = { sent: 0, error: _s(e && e.message) }; }

  const refs = { league_message_id: post.id || null, league_target: post.ok ? (post.id ? target : null) : null, dm_sent: dm.sent || 0, dm_undeliverable: !!dm.undeliverable, dm_no_recipient: !!dm.no_recipient };
  await db.prepare(
    `UPDATE ups_lineup_rulings SET notice_posted_at_utc=?, notice_refs_json=?, notice_error=? WHERE ${KEY_SQL}`
  ).bind(post.ok ? _nowIso() : null, JSON.stringify(refs), post.ok ? null : (post.error || `discord ${post.status}`), ...keyArgs(k)).run();

  return { ok: post.ok, league_posted: post.ok, refs, error: post.ok ? null : "league_post_failed" };
}

// A person did the MFL work (pick stripped, adjustment posted). Recorded, never performed.
export async function markSanctionApplied(env, { season, leagueId, fid, week, by, note }) {
  const db = env && env.UPS_MFL_DB;
  if (!db) return { ok: false, error: "no_db" };
  if (!_s(by)) return { ok: false, error: "by_required" };
  const res = await db.prepare(
    `UPDATE ups_lineup_rulings
        SET sanction_status='applied_manual', sanction_applied_by=?, sanction_applied_at_utc=?, sanction_note=?
      WHERE ${KEY_SQL} AND ruling='confirmed' AND sanction_status='pending_manual'`
  ).bind(_s(by), _nowIso(), _s(note) || null, ...keyArgs({ season, leagueId, fid, week })).run();
  const changed = Number(res && res.meta && res.meta.changes) === 1;
  return changed ? { ok: true } : { ok: false, error: "nothing_pending" };
}
