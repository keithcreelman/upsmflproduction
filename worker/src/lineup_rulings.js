// §G3 — from a booked CANDIDATE to a RULING, one post in that week's Injury
// Report thread, and a penalty that is ASSESSED, then APPLIED.
//
// lineup_compliance.js decides whether a franchise-week looks illegal and
// lineup_wiring.js books it into ups_lineup_violations at the week's final
// kickoff. This module is what happens next, as Keith specified on 2026-10-11:
//
//   AUTOMATIC (runLineupAutoPublish — the standing rule, Keith 2026-10-11:
//   "I do not want to approve every obvious case manually"). On the first
//   run after the final kickoff, for each booked candidate:
//     1. RULE     re-derive the season rung; re-read the evidence for every
//                 starter behind it — status and when it was first recorded
//                 against the notice deadline, corroborated by the official
//                 NFL report; still in the locked lineup at kickoff; did not
//                 play — and, on a pick rung, resolve and RESERVE the exact
//                 pick (earliest future year the team owns one in that round).
//     2. VERIFY   the stored "Week N Injury Report" thread with Discord itself
//                 and the owner's mention.
//     3. POST     once, into that thread.
//   It STOPS for Keith — holds, and DMs him once per reason — whenever the
//   evidence is ambiguous or a safety check fails: missing/conflicting
//   injury evidence, an unreadable or changed lineup, a missing/unverifiable
//   thread or owner mention, the mass-booking breaker, unreadable pick
//   ownership, several qualifying picks, or needs_review.
//
//   BY HAND (admin routes): rule / excuse / choose a pick / preview / post /
//   verify the sanction.
//
// The penalty reads "assessed" until the exact pick and cap action are
// verified on MFL; only then "applied". Nothing here writes MFL. Every step is
// idempotent: one ruling per franchise-week, one live reservation per pick,
// the post claimed before it is sent, each alert claimed before it is sent.

import {
  LINEUP_LADDER, lineupLadderRung, voidLineupViolation, recomputeLineupOffenses,
  injuryHistoryForWeek, noticeMarkUnix, saturdayCapUnix, INJURY_NOTICE_SECONDS, REQUIRED_STARTERS,
} from "./lineup_compliance.js";
import { weekSchedule, playerIndex, byeTeams, weekStartersFromResults, finalKickoffUnix, runLineupBooking } from "./lineup_wiring.js";
import { getFeatureFlag } from "./feature_flags.js";

// Same hard block as lineup_wiring.js (Keith 2026-09-19: "NEVER POST TO
// COFFEE SHOP only to the injury report page").
export const COFFEE_SHOP_CHANNEL_ID = "1087157907419840644";
export const MENTION_TOKEN = "{{MENTION}}";
export const AUTO_RULER = "auto (Keith standing rule 2026-10-11)";
// Kill switch, fail-closed: wrangler.toml ships it "1"; a D1 override "0"
// (Commish Settings) stops automatic rulings and posts at once.
export const AUTO_FLAG = "LINEUP_AUTO_PUBLISH_ENABLED";

const MFL_WWW = "https://www48.myfantasyleague.com";
const NFLVERSE_INJURIES = (season) => `https://github.com/nflverse/nflverse-data/releases/download/injuries/injuries_${encodeURIComponent(season)}.csv`;
const UA = { "User-Agent": "upsmflproduction-worker" };
const _s = (v) => String(v == null ? "" : v).trim();
const _fid = (v) => { const d = _s(v).replace(/\D/g, ""); return d ? d.padStart(4, "0") : ""; };
const _arr = (x) => (Array.isArray(x) ? x : x ? [x] : []);
const _nowIso = () => new Date().toISOString();

// Read failures that a later run may clear on its own. Everything else waits
// for Keith. Transient holds are retried automatically; their alert is held
// back for the first 30 minutes after the final kickoff.
export const TRANSIENT_HOLDS = new Set([
  "evidence_unreadable", "lineup_unreadable", "team_name_unreadable", "pick_inventory_unreadable",
  "official_report_unreadable", "injury_thread_unreadable",
]);
const TRANSIENT_ALERT_GRACE_SEC = 30 * 60;

export function ordinal(n) {
  const k = Number(n) || 0;
  const t = k % 100;
  if (t >= 11 && t <= 13) return `${k}th`;
  return `${k}${({ 1: "st", 2: "nd", 3: "rd" })[k % 10] || "th"}`;
}
const ROUND_WORD = { 1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth", 6: "sixth" };
export const roundWord = (r) => ROUND_WORD[roundNo(r)] || `${ordinal(roundNo(r))}`;

// MFL names are "Last, First". Owners read "First Last".
export function displayName(mflName) {
  const s = _s(mflName);
  if (!s.includes(",")) return s;
  const [last, first] = s.split(",", 2).map(_s);
  return first ? `${first} ${last}` : last;
}

// MFL's three-letter team codes → the abbreviations owners read (and that
// the official report uses; nflverse writes the Rams as "LA").
const NFL_ABBR = { NOS: "NO", GBP: "GB", KCC: "KC", LVR: "LV", NEP: "NE", SFO: "SF", TBB: "TB", JAC: "JAX" };
export const nflAbbr = (t) => NFL_ABBR[_s(t).toUpperCase()] || _s(t).toUpperCase();
const nflverseTeam = (t) => (_s(t).toUpperCase() === "LAR" ? "LA" : nflAbbr(t));

function etParts(unix) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
  }).formatToParts(new Date(Number(unix) * 1000));
  const g = (k) => (f.find((p) => p.type === k) || {}).value || "";
  return { wd: g("weekday"), mon: g("month"), day: g("day"), time: `${g("hour")}:${g("minute")} ${g("dayPeriod").toUpperCase()}` };
}
// "Fri, Oct 9, 5:05 PM ET" — the stored evidence record.
export function etLabel(unix) {
  if (!unix) return "";
  const p = etParts(unix);
  return `${p.wd}, ${p.mon} ${p.day}, ${p.time} ET`;
}
// The public copy, in Keith's own formats (2026-10-11):
const etSeen = (u) => { const p = etParts(u); return `${p.wd} ${p.mon} ${p.day} at ${p.time} ET`; };   // "Fri Oct 9 at 5:05 PM ET"
const etWhen = (u) => { const p = etParts(u); return `${p.wd} ${p.mon} ${p.day}, ${p.time}`; };        // "Sat Oct 10, 1:00 PM"

// The status in effect at `at`, WITH the instant it was first seen.
export function statusEntryAsOf(history, at) {
  let best = null;
  for (const h of (history || [])) {
    const seen = Number(h && h.first_seen_unix) || 0;
    if (!seen || seen > at) continue;
    if (!best || seen > best.first_seen_unix) best = { status: _s(h.status).toUpperCase(), first_seen_unix: seen };
  }
  return best;
}

// ── the ladder, in words ────────────────────────────────────────────────────

function roundNo(r) { return parseInt(String(r == null ? "" : r).replace(/\D/g, ""), 10) || 0; }

// "own 2027 fourth-round pick" / "2027 fourth-round pick acquired from X"
function pickPhrase(pick, holder, names) {
  const orig = _fid(pick.original_owner);
  const base = `${pick.year} ${roundWord(pick.round)}-round pick`;
  return orig && orig !== _fid(holder) ? `${base} acquired from ${(names && names[orig]) || `Team ${orig}`}` : `own ${base}`;
}

// What the rung assesses NOW. A pick rung names the exact pick; "assessed"
// is said out loud until it is verified on MFL.
export function penaltyNowText({ offenseNo, team, season, pick, holder, names }) {
  const next = Number(season) + 1;
  switch (Number(offenseNo)) {
    case 1: return "Warning only. No draft pick or cap charge applies to a first violation.";
    case 2: return `Forfeiture of ${team}’s ${pickPhrase(pick, holder, names)} and a $5,000 charge against the ${next} salary cap. Status: assessed — not yet applied on MFL.`;
    case 3: return `Forfeiture of ${team}’s ${pickPhrase(pick, holder, names)} and a further $5,000 charge against the ${next} salary cap. Status: assessed — not yet applied on MFL.`;
    case 4: return `League vote on ${team}’s retention; if retained, a further $10,000 charge against the ${next} salary cap. Status: assessed — the vote has not been held.`;
    default: return "Automatic expulsion. Status: assessed — commissioner action pending.";
  }
}

// Which pick the NEXT rung would take today, in Keith's words (2026-10-11:
// "Because CBP does not own a 2027 fourth-round pick, its own 2028
// fourth-round pick is currently the applicable pick."). Informational only —
// nothing is reserved for a violation that has not happened.
export function applicablePickSentence({ team, round, season, resolution, holder, names }) {
  const rw = roundWord(round);
  if (!resolution) return "";
  if (resolution.status === "needs_selection") {
    return `${team} owns more than one ${resolution.year} ${rw}-round pick; the commissioner will choose which one applies.`;
  }
  if (resolution.status !== "resolved") return "";
  const p = resolution.pick;
  const skipped = [];
  for (let y = Number(season) + 1; y < Number(p.year); y += 1) skipped.push(y);
  const what = _fid(p.original_owner) === _fid(holder)
    ? `its own ${p.year} ${rw}-round pick`
    : `the ${p.year} ${rw}-round pick it acquired from ${(names && names[_fid(p.original_owner)]) || `Team ${_fid(p.original_owner)}`}`;
  if (skipped.length) {
    const years = skipped.length === 1 ? `${skipped[0]}` : `${skipped.slice(0, -1).join(", ")} or ${skipped[skipped.length - 1]}`;
    return `Because ${team} does not own a ${years} ${rw}-round pick, ${what} is currently the applicable pick.`;
  }
  return `${what.charAt(0).toUpperCase()}${what.slice(1)} is currently the applicable pick.`;
}

export function nextPenaltyText({ offenseNo, team, pickSentence }) {
  const tail = pickSentence ? ` ${pickSentence}` : "";
  switch (Number(offenseNo)) {
    case 1: return `${team} will forfeit its earliest owned future fourth-round pick and receive a $5,000 charge against the following season’s salary cap.${tail}`;
    case 2: return `${team} will forfeit its earliest owned future second-round pick and receive a further $5,000 charge against the following season’s salary cap.${tail}`;
    case 3: return `the league will vote on ${team}’s retention; if retained, ${team} receives a further $10,000 charge against the following season’s salary cap.`;
    case 4: return `${team}’s owner is expelled automatically.`;
    default: return null;
  }
}

// One bullet per starter (or per short lineup), from VERIFIED evidence, in
// Keith's 2026-10-11 wording with the exact timing.
export function evidenceBullet(item, team) {
  const who = `${displayName(item.name)} (${nflAbbr(item.nfl_team)})`;
  const status = item.status_at_deadline === "IR" ? "on IR" : _s(item.status_at_deadline);
  switch (item.kind) {
    case "out":
    case "doubtful_did_not_play":
      return `${who} was first recorded ${status} on ${etSeen(item.status_first_seen_unix)}—before ${team}’s ${etWhen(item.notice_deadline_unix)} notice deadline. `
        + `He remained in the starting lineup at the ${etWhen(item.kickoff_unix)} kickoff and did not play.`;
    case "bye": return `${who} was on a bye week and remained in the starting lineup.`;
    case "missing_starter": return `${team}’s lineup had only ${item.starters} of ${item.required} starting slots filled when the week’s final game kicked off at ${etWhen(item.final_kickoff_unix)}.`;
    default: return `${who}: ${item.kind}.`;
  }
}

export function composeViolationPost({ team, week, season, offenseNo, evidence, penaltyNow, penaltyNext }) {
  const L = [
    `🚨 Lineup Violation — Week ${week}`,
    "",
    `${team} ${MENTION_TOKEN} — ${ordinal(offenseNo)} violation of the ${season} season`,
    "",
    "Why it occurred",
  ];
  for (const it of (evidence || [])) L.push("", `• ${evidenceBullet(it, team)}`);
  if ((evidence || []).length > 1) L.push("", "Multiple ineligible starters in the same weekly lineup count as one lineup violation.");
  L.push("", `Penalty assessed: ${penaltyNow}`);
  if (penaltyNext) L.push("", `If there is another violation this season: ${penaltyNext}`);
  return L.join("\n");
}

// ── MFL + official-report reads ─────────────────────────────────────────────

async function _mflJson(url) {
  try {
    const r = await fetch(url, { headers: UA });
    return r.ok ? await r.json().catch(() => null) : null;
  } catch (_) { return null; }
}

// fid → franchise name. null when unreadable (the post must name the team).
export async function franchiseNameMap(season, leagueId) {
  const d = await _mflJson(`${MFL_WWW}/${encodeURIComponent(season)}/export?TYPE=league&L=${encodeURIComponent(leagueId)}&JSON=1`);
  const rows = d && d.league && d.league.franchises && _arr(d.league.franchises.franchise);
  if (!rows || !rows.length) return null;
  const out = {};
  for (const f of rows) { const id = _fid(f && f.id); if (id) out[id] = _s(f && f.name) || `Team ${id}`; }
  return out;
}

// Future-pick inventory, by holder. null when unreadable. `years` = the years
// MFL lists for the league at all (a holder missing a year simply owns none).
export async function readPickInventory(season, leagueId) {
  const d = await _mflJson(`${MFL_WWW}/${encodeURIComponent(season)}/export?TYPE=futureDraftPicks&L=${encodeURIComponent(leagueId)}&JSON=1`);
  const fr = d && d.futureDraftPicks && _arr(d.futureDraftPicks.franchise);
  if (!fr || !fr.length) return null;
  const byHolder = {}, years = new Set();
  for (const f of fr) {
    const holder = _fid(f && f.id);
    if (!holder) continue;
    byHolder[holder] = _arr(f.futureDraftPick || f.futureDraftPicks).map((p) => {
      const y = parseInt(_s(p && p.year), 10);
      if (y) years.add(y);
      return { year: y, round: roundNo(p && p.round), original_owner: _fid((p && (p.originalPickFor || p.originalOwner)) || holder) };
    }).filter((p) => p.year && p.round);
  }
  if (!years.size) return null;
  return { byHolder, years: [...years].sort((a, b) => a - b) };
}

const pickKey = (p) => `${p.year}-${p.round}-${_fid(p.original_owner)}`;

// The pick a rung forfeits: the EARLIEST future year in which the franchise
// owns a pick in that round (Keith 2026-10-11; canon §G3).
//   - Years MFL lists are read from MFL; picks already reserved are skipped.
//   - Two or more in that earliest year: the commissioner chooses (`choice`
//     = "YEAR-ROUND-ORIGFID").
//   - Past the years MFL lists: canon A6 makes picks more than a year out
//     untradeable, so the franchise still holds its OWN pick there — resolved
//     with basis 'beyond_trade_horizon' (an obligation until MFL lists it).
//   - A year MFL does not list but that IS tradeable cannot be read: hold.
export function resolveForfeitPick({ inventory, holder, round, season, reserved, choice }) {
  if (!inventory) return { status: "unreadable", reason: "pick_inventory_unreadable" };
  const r = roundNo(round), h = _fid(holder);
  const taken = reserved || new Set();
  const own = (inventory.byHolder[h] || []).filter((p) => p.round === r && p.year > Number(season) && !taken.has(pickKey(p)));
  for (const y of inventory.years.filter((yr) => yr > Number(season))) {
    const inYear = own.filter((p) => p.year === y);
    if (!inYear.length) continue;
    if (inYear.length === 1) return { status: "resolved", pick: { ...inYear[0], basis: "mfl_future_picks" } };
    const picked = choice ? inYear.find((p) => pickKey(p) === _s(choice)) : null;
    if (picked) return { status: "resolved", pick: { ...picked, basis: "mfl_future_picks" } };
    return { status: "needs_selection", year: y, options: inYear.map((p) => ({ ...p, key: pickKey(p) })), bad_choice: choice ? _s(choice) : null };
  }
  const lastListed = Math.max(...inventory.years);
  for (let y = Math.max(lastListed + 1, Number(season) + 1); y <= Number(season) + 6; y += 1) {
    if (y <= Number(season) + 1) return { status: "unreadable", reason: "pick_year_not_listed", year: y };
    const p = { year: y, round: r, original_owner: h };
    if (!taken.has(pickKey(p))) return { status: "resolved", pick: { ...p, basis: "beyond_trade_horizon" } };
  }
  return { status: "unreadable", reason: "no_qualifying_pick" };
}

// Minimal CSV (quoted fields, doubled quotes).
function parseCsv(text) {
  const rows = [];
  let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i += 1; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i += 1; row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const head = rows.shift() || [];
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] || ""])));
}
const normName = (n) => _s(n).toLowerCase().replace(/[.'’]/g, "").replace(/-/g, " ").replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "").replace(/\s+/g, " ").trim();

// The official NFL game-status report for one week (nflverse mirror of the
// league's injury report). Corroborates MFL's feed, which is known to keep
// lapsed designations. null when unreadable.
export async function officialReportForWeek(season, week) {
  try {
    const r = await fetch(NFLVERSE_INJURIES(season), { headers: UA, cf: { cacheTtl: 600 } });
    if (!r.ok) return null;
    const rows = parseCsv(await r.text());
    const out = new Map();
    for (const x of rows) {
      if (_s(x.week) !== String(week) || _s(x.season_type || "REG") !== "REG") continue;
      out.set(`${_s(x.team).toUpperCase()}|${normName(x.full_name)}`, { status: _s(x.report_status), practice: _s(x.practice_status), gsis_id: _s(x.gsis_id) });
    }
    return { rows: out, last_modified: _s(r.headers && r.headers.get && r.headers.get("last-modified")) };
  } catch (_) { return null; }
}

// ── evidence ────────────────────────────────────────────────────────────────

// Re-read, for every reason the candidate was booked, the facts the post will
// state, with exact timestamps, and confirm each still holds — including the
// official report. Any failed read, missing fact, or disagreement returns
// ok:false with the reason (hold).
export async function gatherEvidence(env, { season, leagueId, fid, week, violations }) {
  const [sched, players, byes, weekStarters] = await Promise.all([
    weekSchedule(season, week), playerIndex(season, leagueId), byeTeams(season, week),
    weekStartersFromResults(season, leagueId, week, env && env.MFL_COOKIE),
  ]);
  if (!sched || !players || !byes) return { ok: false, reason: "evidence_unreadable", detail: { schedule: !!sched, players: !!players, byes: !!byes } };
  if (!weekStarters) return { ok: false, reason: "lineup_unreadable" };
  const lineup = weekStarters[_fid(fid)];
  if (!Array.isArray(lineup)) return { ok: false, reason: "lineup_unreadable" };
  const needsOfficial = (violations || []).some((v) => ["out", "doubtful_did_not_play"].includes(_s(v && v.reason)));
  const official = needsOfficial ? await officialReportForWeek(season, week) : null;
  if (needsOfficial && !official) return { ok: false, reason: "official_report_unreadable" };
  const history = await injuryHistoryForWeek(env, { season, week });
  const finalKo = finalKickoffUnix(sched);
  const source = `MFL weeklyResults W=${week}`;
  const items = [];
  let reason = null;
  for (const v of (violations || [])) {
    const kind = _s(v && v.reason);
    if (kind === "missing_starter") {
      items.push({ kind, starters: lineup.length, required: REQUIRED_STARTERS, final_kickoff_unix: finalKo, final_kickoff_et: etLabel(finalKo),
                   lineup_source: source, confirmed: lineup.length > 0 && lineup.length < REQUIRED_STARTERS });
      if (!items[items.length - 1].confirmed) reason = reason || "lineup_changed";
      continue;
    }
    const pid = _s(v && v.player_id);
    const info = players[pid] || {};
    const team = _s(info.team).toUpperCase();
    const ko = (sched.kickoffByTeam || {})[team] || 0;
    const mark = noticeMarkUnix(ko);
    const cap = saturdayCapUnix(ko);
    const atMark = statusEntryAsOf(history[pid], mark);
    const atKo = statusEntryAsOf(history[pid], ko);
    const inLineup = lineup.includes(pid);
    const played = !(atKo && (atKo.status === "OUT" || atKo.status === "IR"));
    const off = official ? official.rows.get(`${nflverseTeam(team)}|${normName(displayName(info.name || (v && v.name)))}`) : null;
    const item = {
      kind, player_id: pid, name: _s(info.name) || _s(v && v.name), nfl_team: team,
      status_at_deadline: atMark ? atMark.status : null,
      status_first_seen_unix: atMark ? atMark.first_seen_unix : null, status_first_seen_et: atMark ? etLabel(atMark.first_seen_unix) : null,
      notice_deadline_unix: mark, notice_deadline_et: etLabel(mark),
      deadline_rule: cap != null && cap < ko - INJURY_NOTICE_SECONDS ? "Saturday 8:00 PM ET cap" : "kickoff − 24 hours",
      kickoff_unix: ko, kickoff_et: etLabel(ko),
      status_at_kickoff: atKo ? atKo.status : "ACTIVE",
      in_final_lineup: inLineup, played, played_basis: "NFL injury status at kickoff (canon §G3)", lineup_source: source,
      official_report_status: off ? off.status : null, official_source: official ? `nflverse injuries_${season}.csv` : null,
      official_last_modified: official ? official.last_modified : null,
    };
    let why = null;
    if (!inLineup) why = "lineup_changed";
    else if (!ko) why = "evidence_unreadable";
    else if (kind === "out") {
      if (!atMark || !(atMark.status === "OUT" || atMark.status === "IR")) why = "injury_evidence_missing";
      else if (played) why = "injury_evidence_conflict";
      else if (atMark.status === "IR") why = "ir_needs_review";
      else if (!off) why = "official_report_unmatched";
      else if (off.status !== "Out") why = "official_report_conflict";
    } else if (kind === "doubtful_did_not_play") {
      if (!atMark || atMark.status !== "DOUBTFUL") why = "injury_evidence_missing";
      else if (played) why = "injury_evidence_conflict";
      else if (!off) why = "official_report_unmatched";
      else if (!(off.status === "Doubtful" || off.status === "Out")) why = "official_report_conflict";
    } else if (kind === "bye") {
      if (!(team && byes.has(team))) why = "injury_evidence_conflict";
    } else why = "unknown_reason";
    item.confirmed = !why;
    if (why) reason = reason || why;
    items.push(item);
  }
  if (!items.length) return { ok: false, reason: "no_reasons" };
  if (reason) return { ok: false, reason, items };
  return { ok: true, items, final_kickoff_unix: finalKo, lineup_source: source };
}

// ── D1 ──────────────────────────────────────────────────────────────────────

const KEY_SQL = "season=? AND league_id=? AND fid=? AND week=?";
const RES_SQL = "season=? AND league_id=? AND holder_fid=? AND week=?";
const keyArgs = (k) => [Number(k.season), String(k.leagueId), _fid(k.fid), Number(k.week)];

export async function getCandidate(db, k) {
  return await db.prepare(`SELECT * FROM ups_lineup_violations WHERE ${KEY_SQL}`).bind(...keyArgs(k)).first();
}
export async function getRuling(db, k) {
  return await db.prepare(`SELECT * FROM ups_lineup_rulings WHERE ${KEY_SQL}`).bind(...keyArgs(k)).first();
}
async function liveReservations(db, leagueId, exceptKey) {
  const { results } = await db.prepare(
    `SELECT * FROM ups_lineup_pick_reservations WHERE league_id=? AND released_at_utc IS NULL`
  ).bind(String(leagueId)).all();
  const out = new Set();
  for (const r of (results || [])) {
    if (exceptKey && Number(r.season) === Number(exceptKey.season) && _fid(r.holder_fid) === _fid(exceptKey.fid) && Number(r.week) === Number(exceptKey.week)) continue;
    out.add(pickKey({ year: r.pick_year, round: r.pick_round, original_owner: r.original_owner }));
  }
  return out;
}

// Every candidate this season with its ruling, oldest week first.
export async function listLineupCases(env, { season, leagueId }) {
  const db = env && env.UPS_MFL_DB;
  if (!db) return { ok: false, error: "no_db" };
  const { results } = await db.prepare(
    `SELECT v.season, v.league_id, v.fid, v.week, v.offense_no, v.reasons_json, v.needs_review, v.voided, v.void_reason, v.recorded_at_utc,
            r.ruling, r.offense_no AS ruled_offense_no, r.status, r.hold_reason, r.ruled_by, r.ruled_at_utc,
            r.notice_thread_id, r.notice_posted_at_utc, r.notice_message_id, r.sanction_status, r.penalty_json
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

async function _upsertRuling(db, k, f) {
  await db.prepare(
    `INSERT INTO ups_lineup_rulings
       (season, league_id, fid, week, ruling, offense_no, evidence_json, penalty_json, pick_options_json, note, ruled_by, ruled_at_utc,
        status, hold_reason, notice_text, sanction_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(season, league_id, fid, week) DO UPDATE SET
       ruling=excluded.ruling, offense_no=excluded.offense_no, evidence_json=excluded.evidence_json,
       penalty_json=excluded.penalty_json, pick_options_json=excluded.pick_options_json, note=excluded.note,
       ruled_by=excluded.ruled_by, ruled_at_utc=excluded.ruled_at_utc, status=excluded.status,
       hold_reason=excluded.hold_reason, notice_text=excluded.notice_text, sanction_status=excluded.sanction_status
     WHERE ups_lineup_rulings.notice_claimed_at_utc IS NULL`
  ).bind(
    ...keyArgs(k), f.ruling, f.offense_no || 0, f.evidence ? JSON.stringify(f.evidence) : null,
    f.penalty ? JSON.stringify(f.penalty) : null, f.options ? JSON.stringify(f.options) : null,
    _s(f.note) || null, _s(f.by), _nowIso(), f.status, f.hold_reason || null, f.notice_text || null, f.sanction_status || "none"
  ).run();
}

// Record a ruling on one candidate (by hand, or by the standing rule).
//   'confirmed' — the violation stands: rung, evidence, penalty (exact pick
//                 reserved on a pick rung), and the final post text.
//   'excused'   — commissioner immunity: voids the candidate (never deletes),
//                 releases any reserved pick, re-derives later offense numbers.
// Same call again = same result. Frozen once its post has been claimed.
export async function recordLineupRuling(env, { season, leagueId, fid, week, ruling, note, by, pickChoice }) {
  const db = env && env.UPS_MFL_DB;
  if (!db) return { ok: false, error: "no_db" };
  const k = { season, leagueId, fid: _fid(fid), week };
  const rl = _s(ruling).toLowerCase();
  if (rl !== "confirmed" && rl !== "excused") return { ok: false, error: "bad_ruling", detail: "ruling must be confirmed or excused" };
  if (!_s(by)) return { ok: false, error: "by_required" };

  const cand = await getCandidate(db, k);
  if (!cand) return { ok: false, error: "no_candidate", detail: "nothing was booked for this franchise-week" };
  const existing = await getRuling(db, k);
  if (existing && existing.notice_claimed_at_utc) {
    if (existing.ruling === rl) return { ok: true, unchanged: true, ruling: existing };
    return { ok: false, error: "already_published", detail: "this ruling's post has been sent (or is sending); it is frozen" };
  }

  if (rl === "excused") {
    const later = await db.prepare(
      `SELECT week FROM ups_lineup_rulings WHERE season=? AND league_id=? AND fid=? AND week > ? AND ruling='confirmed' ORDER BY week`
    ).bind(...keyArgs(k)).all();
    const laterWeeks = ((later && later.results) || []).map((r) => Number(r.week));
    if (laterWeeks.length) return { ok: false, error: "later_ruling_exists", weeks: laterWeeks, detail: "a later confirmed week would be renumbered; correct it by hand" };
    if (!Number(cand.voided)) await voidLineupViolation(env, { season, leagueId, fid: k.fid, week, reason: _s(note) || "excused by commissioner", by });
    await db.prepare(`UPDATE ups_lineup_pick_reservations SET released_at_utc=?, state='released' WHERE ${RES_SQL} AND released_at_utc IS NULL`)
      .bind(_nowIso(), ...keyArgs(k)).run();
    await _upsertRuling(db, k, { ruling: "excused", note, by, status: "closed", hold_reason: null });
    return { ok: true, ruling: "excused", status: "closed" };
  }

  if (Number(cand.voided)) return { ok: false, error: "candidate_voided", detail: "this week was voided; it cannot be confirmed" };
  if (Number(cand.needs_review) && !_s(note)) return { ok: false, error: "needs_review", detail: _s(cand.review_note) || "flagged needs_review" };
  // An earlier week that is still only a candidate decides this week's rung.
  const earlier = await db.prepare(
    `SELECT v.week FROM ups_lineup_violations v
       LEFT JOIN ups_lineup_rulings r ON r.season=v.season AND r.league_id=v.league_id AND r.fid=v.fid AND r.week=v.week
      WHERE v.season=? AND v.league_id=? AND v.fid=? AND v.week < ? AND v.voided=0
        AND (r.ruling IS NULL OR (r.ruling='confirmed' AND r.status NOT IN ('ready','posted')))
      ORDER BY v.week`
  ).bind(...keyArgs(k)).all();
  const pending = ((earlier && earlier.results) || []).map((r) => Number(r.week));
  if (pending.length) return { ok: false, error: "earlier_candidates_unruled", weeks: pending };

  const ladder = await recomputeLineupOffenses(env, { season, leagueId, fid: k.fid });
  const mine = (ladder || []).find((x) => Number(x.week) === Number(week));
  const offenseNo = mine ? Number(mine.offense_no) : 0;
  const rung = lineupLadderRung(offenseNo);
  if (!rung) return { ok: false, error: "offense_unresolved" };

  const hold = async (reason, extra) => {
    await _upsertRuling(db, k, { ruling: "confirmed", offense_no: offenseNo, note, by, status: "held", hold_reason: reason, evidence: extra && extra.evidence, sanction_status: "none" });
    return { ok: false, held: true, status: "held", reason, offense_no: offenseNo, ...(extra || {}) };
  };

  let violations = [];
  try { violations = JSON.parse(cand.reasons_json || "[]"); } catch (_) { violations = []; }
  const reserved = await liveReservations(db, leagueId, k);
  const plan = await computeConfirmedRuling(env, { season, leagueId, fid: k.fid, week, violations, offenseNo, reserved, pickChoice });
  if (plan.status === "held") return hold(plan.reason, { evidence: plan.evidence });
  if (plan.status === "needs_pick_selection") {
    await _upsertRuling(db, k, { ruling: "confirmed", offense_no: offenseNo, note, by, status: "needs_pick_selection", evidence: plan.evidence, options: plan.options, hold_reason: plan.bad_choice ? `pick_choice_not_an_option:${plan.bad_choice}` : "needs_pick_selection" });
    return { ok: true, status: "needs_pick_selection", offense_no: offenseNo, year: plan.year, options: plan.options, bad_choice: plan.bad_choice };
  }
  let pick = plan.pick;
  if (pick) {
    // Reserve NOW, so a retry or an overlapping call cannot pick a second one,
    // and no other ruling can take the same pick.
    try {
      await db.prepare(
        `INSERT INTO ups_lineup_pick_reservations
           (season, league_id, holder_fid, week, pick_year, pick_round, original_owner, ownership_basis, reserved_at_utc, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(season, league_id, holder_fid, week) DO UPDATE SET
           pick_year=excluded.pick_year, pick_round=excluded.pick_round, original_owner=excluded.original_owner,
           ownership_basis=excluded.ownership_basis, reserved_at_utc=excluded.reserved_at_utc, released_at_utc=NULL, state=excluded.state
         WHERE ups_lineup_pick_reservations.released_at_utc IS NOT NULL`
      ).bind(...keyArgs(k), pick.year, pick.round, _fid(pick.original_owner), pick.basis, _nowIso(),
             // A year MFL does not list yet is an OBLIGATION until it does (lineup_forfeits.js).
             pick.basis === "beyond_trade_horizon" ? "obligation" : "reserved").run();
    } catch (e) {
      return hold("pick_already_reserved", { evidence: plan.evidence, detail: _s(e && e.message) });
    }
    const held = await db.prepare(`SELECT * FROM ups_lineup_pick_reservations WHERE ${RES_SQL}`).bind(...keyArgs(k)).first();
    if (!held || held.released_at_utc) return hold("pick_reservation_failed", { evidence: plan.evidence });
    // An overlapping call may have reserved first; the stored reservation wins.
    pick = { year: Number(held.pick_year), round: Number(held.pick_round), original_owner: _fid(held.original_owner), basis: held.ownership_basis };
  }
  const built = plan.build(pick);
  await _upsertRuling(db, k, { ruling: "confirmed", offense_no: offenseNo, note, by, status: "ready", evidence: plan.evidence, penalty: built.penalty, notice_text: built.notice, sanction_status: plan.sanction });
  return { ok: true, status: "ready", offense_no: offenseNo, penalty: built.penalty, notice_text: built.notice, evidence: plan.evidence };
}

// Everything a confirmed ruling needs, computed READ-ONLY: evidence, team,
// rung, the pick this rung would forfeit, the next rung's applicable pick,
// and a builder for the penalty + post text. No D1 write, no Discord call,
// no owner-mention lookup — shared by the real ruling and the dry run.
export async function computeConfirmedRuling(env, { season, leagueId, fid, week, violations, offenseNo, reserved, pickChoice }) {
  const rung = lineupLadderRung(offenseNo);
  if (!rung) return { status: "held", reason: "offense_unresolved" };
  const ev = await gatherEvidence(env, { season, leagueId, fid, week, violations });
  if (!ev.ok) return { status: "held", reason: ev.reason, evidence: ev.items || ev.detail || null };
  const names = await franchiseNameMap(season, leagueId);
  if (!names || !names[_fid(fid)]) return { status: "held", reason: "team_name_unreadable", evidence: ev.items };
  const team = names[_fid(fid)];
  const nextRung = lineupLadderRung(offenseNo + 1);
  const wantNow = !!rung.pick, wantNext = offenseNo < LINEUP_LADDER.length && !!(nextRung && nextRung.pick);
  let inventory = null;
  if (wantNow || wantNext) {
    inventory = await readPickInventory(season, leagueId);
    if (!inventory) return { status: "held", reason: "pick_inventory_unreadable", evidence: ev.items };
  }
  let pick = null;
  if (wantNow) {
    const res = resolveForfeitPick({ inventory, holder: fid, round: rung.pick, season, reserved, choice: pickChoice });
    if (res.status === "unreadable") return { status: "held", reason: res.reason, evidence: ev.items };
    if (res.status === "needs_selection") return { status: "needs_pick_selection", evidence: ev.items, year: res.year, options: res.options, bad_choice: res.bad_choice };
    pick = res.pick;
  }
  const sanction = rung.pick || rung.cap_k || rung.membership ? "assessed" : "none";
  const build = (finalPick) => {
    let nextSentence = "", nextResolution = null;
    if (wantNext) {
      const exclude = new Set(reserved || []);
      if (finalPick) exclude.add(pickKey(finalPick));
      nextResolution = resolveForfeitPick({ inventory, holder: fid, round: nextRung.pick, season, reserved: exclude });
      nextSentence = nextResolution.status === "unreadable" ? "" : applicablePickSentence({ team, round: nextRung.pick, season, resolution: nextResolution, holder: fid, names });
    }
    const penalty = {
      rung: offenseNo, label: rung.label,
      pick: finalPick, cap_k: rung.cap_k || 0, cap_season: rung.cap_k ? Number(season) + 1 : null,
      cap_description: rung.cap_k ? `UPS lineup violation ${season} W${week} #${offenseNo}` : null,
      membership: rung.membership || null,
      now_text: penaltyNowText({ offenseNo, team, season, pick: finalPick, holder: fid, names }),
      next_text: nextPenaltyText({ offenseNo, team, pickSentence: nextSentence }),
      next_applicable_pick: nextResolution && nextResolution.status === "resolved" ? nextResolution.pick : null,
    };
    const notice = composeViolationPost({ team, week, season, offenseNo, evidence: ev.items, penaltyNow: penalty.now_text, penaltyNext: penalty.next_text });
    return { penalty, notice };
  };
  if (wantNext) {
    // The next rung's applicable pick must be readable before anything posts.
    const probe = resolveForfeitPick({ inventory, holder: fid, round: nextRung.pick, season, reserved: new Set([...(reserved || []), ...(pick ? [pickKey(pick)] : [])]) });
    if (probe.status === "unreadable") return { status: "held", reason: probe.reason, evidence: ev.items };
  }
  return { status: "ready", evidence: ev.items, team, pick, sanction, build };
}

// The post with NO mention — what every preview, dry run and test shows
// ("CBP — 1st violation of the 2026 season"). Only postLineupNotice, at the
// final production send, swaps the token for the owner's real mention.
export const plainNotice = (text) => _s(text).split(` ${MENTION_TOKEN}`).join("").split(MENTION_TOKEN).join("");

// ── destination, mention, alerts, and the one post ─────────────────────────

async function _discord(env, method, path, body) {
  const token = _s(env.DISCORD_BOT_TOKEN || env.DISCORD_BOT || "");
  if (!token) return { ok: false, status: 0, data: null, error: "no_bot_token" };
  try {
    const res = await fetch(`https://discord.com/api/v10${path}`, {
      method, headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json", ...UA },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: _s(e && e.message) };
  }
}

// THE destination: the existing "Week N Injury Report" thread, resolved from
// the Saturday post's record and verified against Discord itself — a thread
// (type 11/12), that exact name, inside the Injury Report channel, not locked.
// Read-only.
export async function verifyInjuryThread(env, { season, leagueId, week }) {
  const db = env && env.UPS_MFL_DB;
  const parent = _s(env && env.DISCORD_LINEUP_ANNOUNCE_CHANNEL_ID);
  if (!parent) return { ok: false, reason: "injury_channel_not_configured" };
  if (parent === COFFEE_SHOP_CHANNEL_ID) return { ok: false, reason: "coffee_shop_blocked" };
  let rec = null;
  try {
    rec = await db.prepare(`SELECT message_id FROM ups_lineup_sat_announce_log WHERE season=? AND league_id=? AND week=?`)
      .bind(Number(season), String(leagueId), Number(week)).first();
  } catch (_) { rec = null; }
  const threadId = _s(rec && rec.message_id);
  if (!/^\d{15,22}$/.test(threadId)) return { ok: false, reason: "injury_thread_missing", thread_id: threadId || null };
  const g = await _discord(env, "GET", `/channels/${encodeURIComponent(threadId)}`);
  if (!g.ok || !g.data) return { ok: false, reason: "injury_thread_unreadable", thread_id: threadId, http: g.status };
  const t = g.data;
  const expected = `Week ${week} Injury Report`;
  const meta = t.thread_metadata || {};
  const checks = {
    is_thread: t.type === 11 || t.type === 12,
    name: _s(t.name) === expected,
    parent: _s(t.parent_id) === parent,
    not_locked: !meta.locked,
  };
  const dest = { thread_id: threadId, name: _s(t.name), parent_id: _s(t.parent_id), guild_id: _s(t.guild_id), type: t.type, archived: !!meta.archived, locked: !!meta.locked, checks };
  if (!Object.values(checks).every(Boolean)) return { ok: false, reason: "injury_thread_unverified", ...dest };
  return { ok: true, ...dest };
}

async function _mentions(env, fid, resolveMentions) {
  if (typeof resolveMentions !== "function") return [];
  try {
    const m = await resolveMentions(env, [_fid(fid)]);
    return ((m && m.get && m.get(_fid(fid))) || []).filter((id) => /^\d{15,22}$/.test(_s(id)));
  } catch (_) { return []; }
}

async function _defaultAlert(env, text) {
  const ids = _s(env.COMMISH_DISCORD_USER_ID).split(/[,\s]+/).filter((x) => /^\d{15,22}$/.test(x));
  if (!ids.length) return { sent: 0 };
  const { dmAll } = await import("./trade_dm.js");
  return dmAll(env, ids, { content: text });
}

// DM the commissioner ONCE per (season, week, franchise, reason). The INSERT
// is the claim, so overlapping runs cannot double-alert.
export async function alertOnce(env, { season, leagueId, week, fid, reason, text, alertImpl }) {
  const db = env && env.UPS_MFL_DB;
  if (!db) return { alerted: false };
  const res = await db.prepare(
    `INSERT OR IGNORE INTO ups_lineup_alerts (season, league_id, week, fid, reason, detail, alerted_at_utc) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(Number(season), String(leagueId), Number(week), fid ? _fid(fid) : "", _s(reason), _s(text).slice(0, 1000), _nowIso()).run();
  if (!res || !res.meta || Number(res.meta.changes) !== 1) return { alerted: false, duplicate: true };
  try { await (alertImpl || _defaultAlert)(env, text); return { alerted: true }; } catch (_) { return { alerted: false, error: true }; }
}

const holdText = (k, team, reason, extra) =>
  `⚠️ Lineup violation HELD for your review — Week ${k.week}, ${team || `Team ${_fid(k.fid)}`}: ${reason}.${extra ? " " + extra : ""} Nothing was posted. Review it in the commissioner tools (GET /admin/lineup/cases).`;

// Does the franchise have an active owner account to mention? Answers with a
// COUNT only — previews and dry runs never look up, return or render the
// owner's id (Keith 2026-10-11: nobody is tagged until the one live post).
export async function ownerAccountCount(env, fid) {
  try {
    const r = await env.UPS_MFL_DB.prepare(
      `SELECT COUNT(*) AS n FROM discord_owners
        WHERE franchise_id=? AND active_owner='Y' AND discord_user_id IS NOT NULL
          AND length(discord_user_id) BETWEEN 15 AND 22 AND discord_user_id NOT GLOB '*[^0-9]*'`
    ).bind(_fid(fid)).first();
    return Number(r && r.n) || 0;
  } catch (_) { return -1; }   // unreadable — never read as "has an owner"
}

// The exact text that would post — WITHOUT any mention — and every check that
// gates it. Read-only: no D1 write, no Discord write, no owner-id lookup.
export async function previewLineupNotice(env, { season, leagueId, fid, week }) {
  const db = env && env.UPS_MFL_DB;
  if (!db) return { ok: false, error: "no_db" };
  const k = { season, leagueId, fid: _fid(fid), week };
  const r = await getRuling(db, k);
  if (!r) return { ok: false, error: "no_ruling" };
  if (r.ruling !== "confirmed") return { ok: false, error: "not_confirmed" };
  if (r.status === "posted") return { ok: false, error: "already_posted", message_id: r.notice_message_id, thread_id: r.notice_thread_id };
  if (r.status !== "ready" && r.status !== "held") return { ok: false, error: `status_${r.status}`, hold_reason: r.hold_reason };
  if (!_s(r.notice_text)) return { ok: false, error: "notice_missing", hold_reason: r.hold_reason };

  const problems = [];
  const dest = await verifyInjuryThread(env, { season, leagueId, week });
  if (!dest.ok) problems.push(dest.reason);
  const owners = await ownerAccountCount(env, k.fid);
  if (owners < 0) problems.push("owner_account_unreadable");
  else if (owners === 0) problems.push("owner_account_missing");
  let pickCheck = null;
  const penalty = r.penalty_json ? JSON.parse(r.penalty_json) : null;
  if (penalty && penalty.pick) {
    pickCheck = await recheckReservedPick({ season, leagueId, holder: k.fid, pick: penalty.pick });
    if (!pickCheck.ok) problems.push(pickCheck.reason);
  }
  return {
    ok: !problems.length, problems, text: plainNotice(r.notice_text), mention: "not rendered in preview", owner_account_active: owners > 0,
    destination: dest, pick_check: pickCheck,
    offense_no: r.offense_no, sanction_status: r.sanction_status, evidence: r.evidence_json ? JSON.parse(r.evidence_json) : null,
  };
}

// The reserved pick must still be the franchise's when the post goes out.
export async function recheckReservedPick({ season, leagueId, holder, pick }) {
  const inv = await readPickInventory(season, leagueId);
  if (!inv) return { ok: false, reason: "pick_inventory_unreadable" };
  if (pick.basis === "beyond_trade_horizon" && !inv.years.includes(Number(pick.year))) {
    return Number(pick.year) > Number(season) + 1 ? { ok: true, basis: "beyond_trade_horizon" } : { ok: false, reason: "pick_year_not_listed" };
  }
  const owns = (inv.byHolder[_fid(holder)] || []).some((p) => pickKey(p) === pickKey(pick));
  return owns ? { ok: true, basis: "mfl_future_picks" } : { ok: false, reason: "reserved_pick_no_longer_owned" };
}

async function _hold(env, k, reason, { alertImpl, team, quiet } = {}) {
  const db = env.UPS_MFL_DB;
  await db.prepare(`UPDATE ups_lineup_rulings SET status='held', hold_reason=? WHERE ${KEY_SQL} AND status IN ('ready','held')`)
    .bind(reason, ...keyArgs(k)).run();
  const a = quiet ? { alerted: false, deferred: true }
    : await alertOnce(env, { season: k.season, leagueId: k.leagueId, week: k.week, fid: k.fid, reason, text: holdText(k, team, reason), alertImpl });
  return { ok: false, held: true, reason, alerted: !!a.alerted };
}

// ── delivering the one post: a time-limited sending lease ─────────────────
//
// Keith 2026-10-11: a permanent "claimed but unsent" mark could silently lose
// the announcement if the worker died, or Discord failed, after the claim. So:
//
//   - a run takes a SENDING LEASE (notice_claimed_at_utc = lease start; it
//     lapses after SEND_LEASE_SEC). Overlapping runs cannot both hold it.
//   - before any RETRY (a lapsed lease), the run reads the target thread for
//     THIS violation's post (our bot, the approved text). Found → adopt its
//     message id, never repost. Not found → send.
//   - every send carries a deterministic Discord nonce with enforce_nonce, so
//     Discord itself returns the existing message instead of creating a second
//     one if the same send repeats within its dedupe window.
//   - the message id is stored ONLY after Discord confirms the post.
//   - a definite rejection (4xx) holds for Keith; an uncertain outcome (5xx,
//     timeout, network, 429) lets the lease lapse and the next run inspect and
//     retry; after MAX_SEND_ATTEMPTS uncertain tries — or if the thread can't
//     be inspected — the ruling is held as delivery_uncertain and Keith is DMed.
//
// The attempt log lives in notice_error as JSON {attempts, last}.
export const SEND_LEASE_SEC = 5 * 60;
export const MAX_SEND_ATTEMPTS = 3;
const _isoAt = (unix) => new Date(Number(unix) * 1000).toISOString();
export const sendNonce = (k) => `lv${k.season}w${String(k.week).padStart(2, "0")}f${_fid(k.fid)}`;   // ≤ 25 chars
const _delivery = (s) => { try { const j = JSON.parse(s || "{}"); return j && typeof j === "object" && !Array.isArray(j) ? j : {}; } catch (_) { return {}; } };
const _plainOf = (content) => _s(content).replace(/ ?<@!?\d+>/g, "");

// Read-only: is THIS violation's post already in the thread? Matches a
// message by our bot whose text, with mentions removed, is the approved post.
export async function findPostedNotice(env, { threadId, noticeText }) {
  const me = await _discord(env, "GET", "/users/@me");
  const botId = me.ok && me.data ? _s(me.data.id) : "";
  const g = await _discord(env, "GET", `/channels/${encodeURIComponent(threadId)}/messages?limit=100`);
  if (!g.ok || !Array.isArray(g.data)) return { ok: false, http: g.status };
  const want = plainNotice(noticeText);
  const hit = g.data.find((m) => m && m.author && (botId ? _s(m.author.id) === botId : !!m.author.bot) && _plainOf(m.content) === want);
  return { ok: true, found: !!hit, message_id: hit ? _s(hit.id) : null, scanned: g.data.length };
}

// Post the confirmed ruling ONCE into the week's Injury Report thread.
// `quietTransient` (the automatic run, early) defers the alert for a read
// failure that the next run may clear. `nowUnix` is for tests.
export async function postLineupNotice(env, { season, leagueId, fid, week, resolveMentions, alertImpl, quietTransient = false, nowUnix }) {
  const db = env && env.UPS_MFL_DB;
  if (!db) return { ok: false, error: "no_db" };
  const k = { season, leagueId, fid: _fid(fid), week };
  const now = Number(nowUnix) || Math.floor(Date.now() / 1000);
  const r = await getRuling(db, k);
  if (!r) return { ok: false, error: "no_ruling" };
  if (r.ruling !== "confirmed") return { ok: false, error: "not_confirmed", detail: "only a confirmed ruling is published" };
  if (r.status === "posted" || r.notice_message_id) return { ok: false, error: "already_posted", message_id: r.notice_message_id || null, thread_id: r.notice_thread_id || null };
  if (r.status !== "ready" && r.status !== "held") return { ok: false, error: `status_${r.status}`, hold_reason: r.hold_reason };
  if (!_s(r.notice_text)) return { ok: false, error: "notice_missing", hold_reason: r.hold_reason };
  if (r.notice_claimed_at_utc && r.notice_claimed_at_utc > _isoAt(now - SEND_LEASE_SEC)) {
    return { ok: false, error: "send_in_progress", lease_since: r.notice_claimed_at_utc };
  }
  const team = (_s(r.notice_text).split("\n")[2] || "").split(` ${MENTION_TOKEN}`)[0];
  const priorAttempt = !!r.notice_claimed_at_utc;
  const log = _delivery(r.notice_error);
  const attempts = Number(log.attempts) || 0;

  // First attempt: every check passes BEFORE a lease is taken.
  let pv = null;
  if (!priorAttempt) {
    pv = await previewLineupNotice(env, { season, leagueId, fid: k.fid, week });
    if (!pv.ok) {
      const reason = (pv.problems && pv.problems[0]) || pv.error || "preview_failed";
      return { ...(await _hold(env, k, reason, { alertImpl, team, quiet: quietTransient && TRANSIENT_HOLDS.has(reason) })), problems: pv.problems };
    }
  }

  // Take the lease — only if none is held, or the last one lapsed.
  const token = _isoAt(now).replace(/Z$/, `.${Math.random().toString(36).slice(2, 8)}Z`);
  const lease = await db.prepare(
    `UPDATE ups_lineup_rulings SET notice_claimed_at_utc=?, notice_thread_id=COALESCE(notice_thread_id, ?), notice_error=?
      WHERE ${KEY_SQL} AND ruling='confirmed' AND status IN ('ready','held') AND notice_message_id IS NULL
        AND (notice_claimed_at_utc IS NULL OR notice_claimed_at_utc < ?)`
  ).bind(token, pv ? pv.destination.thread_id : null, JSON.stringify({ ...log, attempts: attempts + 1, last: { at: _isoAt(now), outcome: "leased" } }),
    ...keyArgs(k), _isoAt(now - SEND_LEASE_SEC)).run();
  if (!lease || !lease.meta || Number(lease.meta.changes) !== 1) return { ok: false, error: "send_in_progress" };
  const mine = `${KEY_SQL} AND notice_claimed_at_utc=? AND notice_message_id IS NULL`;
  const record = (outcome, extra) => db.prepare(`UPDATE ups_lineup_rulings SET notice_error=? WHERE ${mine}`)
    .bind(JSON.stringify({ attempts: attempts + 1, last: { at: _isoAt(now), outcome, ...(extra || {}) } }), ...keyArgs(k), token).run();
  const release = () => db.prepare(`UPDATE ups_lineup_rulings SET notice_claimed_at_utc=NULL WHERE ${mine}`).bind(...keyArgs(k), token).run();
  const needsReview = async (reason, detail) => {
    await record(reason, detail);
    await db.prepare(`UPDATE ups_lineup_rulings SET status='held', hold_reason=? WHERE ${mine}`).bind(reason, ...keyArgs(k), token).run();
    await alertOnce(env, { season, leagueId, week, fid: k.fid, reason, alertImpl,
      text: `⚠️ Lineup violation post NEEDS REVIEW — Week ${week}, ${team || `Team ${k.fid}`}: ${reason}. Delivery is uncertain after ${attempts + 1} attempt(s); nothing more will be sent automatically. Check thread ${_s(r.notice_thread_id || (pv && pv.destination && pv.destination.thread_id))} before re-posting.` });
    return { ok: false, held: true, needs_review: true, reason };
  };

  // RETRY after a lapsed lease: is the post already there?
  if (priorAttempt) {
    const threadId = _s(r.notice_thread_id);
    const found = threadId ? await findPostedNotice(env, { threadId, noticeText: r.notice_text }) : { ok: false };
    if (!found.ok) {
      if (attempts + 1 >= MAX_SEND_ATTEMPTS) return needsReview("delivery_uncertain", { inspection: "unreadable" });
      await record("inspection_unavailable", { http: found.http || 0 });
      return { ok: false, error: "inspection_unavailable", retry: true };   // the lease lapses; the next run tries again
    }
    if (found.found) {
      const adopt = await db.prepare(
        `UPDATE ups_lineup_rulings SET status='posted', notice_posted_at_utc=?, notice_message_id=?, notice_error=?, hold_reason=NULL WHERE ${mine}`
      ).bind(_isoAt(now), found.message_id, JSON.stringify({ attempts: attempts + 1, last: { at: _isoAt(now), outcome: "adopted_existing" } }), ...keyArgs(k), token).run();
      if (!adopt || !adopt.meta || Number(adopt.meta.changes) !== 1) return { ok: false, error: "lease_lost" };
      return { ok: true, posted: true, adopted: true, thread_id: threadId, message_id: found.message_id };
    }
    // Not there: re-run every check before sending again.
    pv = await previewLineupNotice(env, { season, leagueId, fid: k.fid, week });
    if (!pv.ok) {
      await release();
      const reason = (pv.problems && pv.problems[0]) || pv.error || "preview_failed";
      return { ...(await _hold(env, k, reason, { alertImpl, team, quiet: quietTransient && TRANSIENT_HOLDS.has(reason) })), problems: pv.problems };
    }
  }

  // THE FINAL PRODUCTION SEND STEP — the only place the owner's real mention
  // is looked up and inserted (Keith 2026-10-11).
  const ids = await _mentions(env, k.fid, resolveMentions);
  if (!ids.length) { await release(); return await _hold(env, k, "owner_mention_unresolved", { alertImpl, team }); }
  const sendText = _s(r.notice_text).split(MENTION_TOKEN).join(ids.map((id) => `<@${id}>`).join(" "));
  const p = await _discord(env, "POST", `/channels/${encodeURIComponent(pv.destination.thread_id)}/messages`, {
    content: sendText.slice(0, 1990), allowed_mentions: { users: ids }, nonce: sendNonce(k), enforce_nonce: true,
  });
  const msgId = _s(p.data && p.data.id);
  if (p.ok && msgId) {
    // Stored ONLY now that Discord has confirmed the post.
    const fin = await db.prepare(
      `UPDATE ups_lineup_rulings SET status='posted', notice_posted_at_utc=?, notice_message_id=?, notice_error=?, hold_reason=NULL WHERE ${mine}`
    ).bind(_isoAt(now), msgId, JSON.stringify({ attempts: attempts + 1, last: { at: _isoAt(now), outcome: "posted" } }), ...keyArgs(k), token).run();
    if (!fin || !fin.meta || Number(fin.meta.changes) !== 1) {
      const cur = await getRuling(db, k);
      if (cur && cur.notice_message_id === msgId) return { ok: true, posted: true, thread_id: pv.destination.thread_id, message_id: msgId };
      return needsReview("delivery_conflict", { message_id: msgId });
    }
    // The returned text is the plain one; the mention lives only in Discord.
    return { ok: true, posted: true, thread_id: pv.destination.thread_id, message_id: msgId, text: pv.text };
  }
  const http = Number(p.status) || 0;
  if (http >= 400 && http < 500 && http !== 429) {
    // Discord definitively refused: nothing was created. Hold for Keith.
    await record("rejected", { http, detail: JSON.stringify(p.data || "").slice(0, 200) });
    await release();
    return await _hold(env, k, `post_rejected_${http}`, { alertImpl, team });
  }
  // Uncertain (5xx / 429 / network): the post may or may not exist.
  if (attempts + 1 >= MAX_SEND_ATTEMPTS) return needsReview("delivery_uncertain", { http });
  await record("uncertain", { http, detail: _s(p.error).slice(0, 200) });
  return { ok: false, error: "delivery_uncertain", retry: true, http };   // lease lapses; the next run inspects first
}

// ── the standing rule: book → rule → verify → post, unattended ─────────────

// Run for one week, at or after its final kickoff. Idempotent and safe to
// overlap: a posted/claimed ruling is never touched, a non-transient hold
// waits for Keith, a transient hold is retried, every alert is sent once.
export async function runLineupAutoPublish(env, { season, leagueId, week, nowUnix, resolveMentions, alertImpl }) {
  const db = env && env.UPS_MFL_DB;
  if (!db) return { ok: false, error: "no_db" };
  if (!(await getFeatureFlag(env, AUTO_FLAG))) return { ok: true, skipped: "auto_publish_disabled" };
  const now = Number(nowUnix) || Math.floor(Date.now() / 1000);
  const sched = await weekSchedule(season, week);
  const last = finalKickoffUnix(sched);
  if (!last || now < last) return { ok: true, skipped: "week_not_final" };
  const early = now - last < TRANSIENT_ALERT_GRACE_SEC;
  const { results } = await db.prepare(
    `SELECT fid, needs_review, review_note FROM ups_lineup_violations WHERE season=? AND league_id=? AND week=? AND voided=0 ORDER BY fid`
  ).bind(Number(season), String(leagueId), Number(week)).all();
  const names = (results || []).length ? (await franchiseNameMap(season, leagueId)) || {} : {};
  const out = [];
  for (const c of (results || [])) {
    const k = { season, leagueId, fid: _fid(c.fid), week };
    const team = names[k.fid] || `Team ${k.fid}`;
    const alert = (reason, extra) => alertOnce(env, { season, leagueId, week, fid: k.fid, reason, text: holdText(k, team, reason, extra), alertImpl });
    let r = await getRuling(db, k);
    if (r && (r.status === "posted" || r.status === "closed" || r.notice_message_id)) { out.push({ fid: k.fid, status: r.status, skipped: "done" }); continue; }
    if (Number(c.needs_review)) { await alert("needs_review", _s(c.review_note)); out.push({ fid: k.fid, status: "needs_review" }); continue; }
    if (r && r.status === "needs_pick_selection") { await alert("needs_pick_selection", "Choose the exact pick (POST /admin/lineup/rule with pick_choice)."); out.push({ fid: k.fid, status: r.status }); continue; }
    if (r && r.status === "held" && !TRANSIENT_HOLDS.has(_s(r.hold_reason))) { await alert(_s(r.hold_reason)); out.push({ fid: k.fid, status: "held", reason: r.hold_reason }); continue; }
    if (!r || r.status === "held") {
      const rr = await recordLineupRuling(env, { season, leagueId, fid: k.fid, week, ruling: "confirmed", by: AUTO_RULER });
      if (rr.status === "needs_pick_selection") { await alert("needs_pick_selection", "Choose the exact pick (POST /admin/lineup/rule with pick_choice)."); out.push({ fid: k.fid, status: rr.status }); continue; }
      if (!rr.ok) {
        const reason = _s(rr.reason || rr.error);
        if (!(TRANSIENT_HOLDS.has(reason) && early)) await alert(reason, rr.weeks ? `Earlier weeks: ${rr.weeks.join(", ")}.` : "");
        out.push({ fid: k.fid, status: "held", reason });
        continue;
      }
      r = await getRuling(db, k);
    }
    if (r && r.status === "ready") {
      const p = await postLineupNotice(env, { season, leagueId, fid: k.fid, week, resolveMentions, alertImpl, quietTransient: early, nowUnix: now });
      out.push({ fid: k.fid, status: p.ok ? "posted" : "held", reason: p.reason || p.error || null, message_id: p.message_id || null, thread_id: p.thread_id || null });
    }
  }
  return { ok: true, week, results: out };
}

// Booking could not read a franchise's lineup for the week, or found none:
// that is for Keith to review, never a silent skip (Keith 2026-10-11).
export async function alertBookingSkips(env, { season, leagueId, week, skipped, alertImpl }) {
  const out = [];
  for (const sk of (skipped || [])) {
    const reason = sk.reason === "unknown" ? "lineup_unreadable" : sk.reason === "no_record" ? "no_lineup_submitted" : null;
    if (!reason) continue;
    const text = reason === "no_lineup_submitted"
      ? `⚠️ Week ${week}: no lineup was recorded for Team ${_fid(sk.fid)} when the week's final game kicked off. Failing to submit a lineup is its own §G3 process — nothing was booked or posted.`
      : `⚠️ Week ${week}: Team ${_fid(sk.fid)}'s locked lineup couldn't be read, so it was not judged. Nothing was booked or posted — review it.`;
    out.push(await alertOnce(env, { season, leagueId, week, fid: sk.fid, reason, text, alertImpl }));
  }
  return out;
}

// Read-only: how many messages in the thread already carry a violation
// notice. Contents are never returned.
async function auditThreadForViolationPosts(env, threadId) {
  const g = await _discord(env, "GET", `/channels/${encodeURIComponent(threadId)}/messages?limit=100`);
  if (!g.ok || !Array.isArray(g.data)) return { ok: false, http: g.status };
  return { ok: true, messages_scanned: g.data.length, violation_posts: g.data.filter((m) => /Lineup Violation — Week/.test(_s(m && m.content))).length };
}

// THE DRY RUN of the standing rule (Keith 2026-10-11): evaluate the week as
// the live run will at its final kickoff — booking, evidence, offense number,
// penalty, the exact post text — verify the thread and that the owner has an
// active account, and say whether each case would POST or HOLD (and why).
// Writes nothing to D1. Sends nothing to Discord. Never looks up, returns or
// renders an owner mention: the text is the plain "CBP — 1st violation …".
export async function previewStandingRule(env, { season, leagueId, week, nowUnix }) {
  const db = env && env.UPS_MFL_DB;
  if (!db) return { ok: false, error: "no_db" };
  const sched = await weekSchedule(season, week);
  const last = finalKickoffUnix(sched);
  if (!last) return { ok: false, error: "schedule_unreadable" };
  const now = Number(nowUnix) || Math.floor(Date.now() / 1000);
  const evalAt = Math.max(now, last);
  const booking = await runLineupBooking(env, { season, leagueId, week, nowUnix: evalAt, dryRun: true });
  if (booking.skipped) return { ok: false, error: booking.skipped };
  const thread = await verifyInjuryThread(env, { season, leagueId, week });
  const threadAudit = thread.thread_id ? await auditThreadForViolationPosts(env, thread.thread_id) : null;
  const { results: live } = await db.prepare(
    `SELECT fid, reasons_json, needs_review, review_note FROM ups_lineup_violations WHERE season=? AND league_id=? AND week=? AND voided=0`
  ).bind(Number(season), String(leagueId), Number(week)).all();
  const cands = new Map();
  for (const r of (live || [])) cands.set(_fid(r.fid), { violations: JSON.parse(r.reasons_json || "[]"), needs_review: !!Number(r.needs_review), source: "booked" });
  const dryBooked = (booking.detail && booking.detail.booked) || [];
  for (const b of dryBooked) if (!cands.has(_fid(b.fid))) cands.set(_fid(b.fid), { violations: b.violations || [], needs_review: !!b.needs_review, source: "would_book" });
  if (booking.refused) for (const c of ((booking.detail && booking.detail.candidates) || [])) if (!cands.has(_fid(c.fid))) cands.set(_fid(c.fid), { violations: [], source: "would_book", refused: true });
  const reserved = await liveReservations(db, leagueId, null);
  const results = [];
  for (const [fid, c] of cands) {
    const holds = [];
    if (booking.refused) holds.push("mass_booking");
    if (c.needs_review) holds.push("needs_review");
    const pr = await db.prepare(`SELECT COUNT(*) AS n FROM ups_lineup_violations WHERE season=? AND league_id=? AND fid=? AND voided=0 AND week < ?`)
      .bind(Number(season), String(leagueId), fid, Number(week)).first();
    const offenseNo = (Number(pr && pr.n) || 0) + 1;
    const earlier = await db.prepare(
      `SELECT v.week FROM ups_lineup_violations v LEFT JOIN ups_lineup_rulings r ON r.season=v.season AND r.league_id=v.league_id AND r.fid=v.fid AND r.week=v.week
        WHERE v.season=? AND v.league_id=? AND v.fid=? AND v.week < ? AND v.voided=0 AND (r.ruling IS NULL OR r.status NOT IN ('ready','posted'))`
    ).bind(Number(season), String(leagueId), fid, Number(week)).all();
    if (((earlier && earlier.results) || []).length) holds.push("earlier_candidates_unruled");
    const plan = c.refused ? { status: "held", reason: "mass_booking" } : await computeConfirmedRuling(env, { season, leagueId, fid, week, violations: c.violations, offenseNo, reserved });
    if (plan.status !== "ready") holds.push(plan.reason || plan.status);
    if (!thread.ok) holds.push(thread.reason);
    const owners = await ownerAccountCount(env, fid);
    if (owners < 0) holds.push("owner_account_unreadable"); else if (owners === 0) holds.push("owner_account_missing");
    const built = plan.status === "ready" ? plan.build(plan.pick) : null;
    results.push({
      fid, team: plan.team || null, source: c.source, would: holds.length ? "hold" : "post", holds: [...new Set(holds)],
      offense_no: offenseNo, weekly_offenses_recorded: 1, starters_behind_it: (c.violations || []).length,
      evidence: plan.evidence || null, penalty: built ? built.penalty : null,
      notice_text: built ? plainNotice(built.notice) : null,
      owner_account_active: owners > 0,
    });
  }
  return {
    ok: true, week, evaluated_at_unix: evalAt, final_kickoff_unix: last, final_kickoff_et: etLabel(last), evaluated_as_if_final: now < last,
    booking: { would_book: dryBooked.map((b) => b.fid), clean: booking.clean || 0, skipped: (booking.detail && booking.detail.skipped) || [], refused: booking.refused || null },
    thread, thread_audit: threadAudit, results,
    guarantees: { d1_writes: 0, discord_writes: 0, owner_mentions_resolved: 0, owner_mentions_rendered: 0 },
  };
}

// The booking breaker refused this week: tell Keith once.
export async function alertMassBooking(env, { season, leagueId, week, candidates, alertImpl }) {
  return alertOnce(env, {
    season, leagueId, week, fid: "", reason: "mass_booking", alertImpl,
    text: `⚠️ Lineup booking REFUSED for Week ${week}: ${candidates} teams would have been booked (limit 4). Nothing was recorded or posted. This usually means a broken input — review before anything is booked.`,
  });
}

// ── assessed → applied ──────────────────────────────────────────────────────

// Flip a penalty to APPLIED only when the exact MFL actions are verified:
// the reserved pick no longer belongs to the franchise, and a salary
// adjustment of the assessed amount, carrying the ruling's description,
// exists in the cap season's league. Membership rungs (retention vote,
// expulsion) are commissioner actions this cannot verify — they stay assessed.
export async function verifyLineupSanction(env, { season, leagueId, fid, week }) {
  const db = env && env.UPS_MFL_DB;
  if (!db) return { ok: false, error: "no_db" };
  const k = { season, leagueId, fid: _fid(fid), week };
  const r = await getRuling(db, k);
  if (!r || r.ruling !== "confirmed") return { ok: false, error: "no_confirmed_ruling" };
  if (r.sanction_status === "none") return { ok: true, sanction_status: "none", detail: "nothing to apply (warning)" };
  if (r.sanction_status === "applied") return { ok: true, sanction_status: "applied", unchanged: true };
  const pen = r.penalty_json ? JSON.parse(r.penalty_json) : {};
  const out = { pick: null, cap: null, membership: null };
  if (pen.pick) {
    // SECURED only: the pick is gone from EVERY franchise on MFL. A pick that
    // left the team but sits on another one was traded, not secured
    // (Keith 2026-10-11) — the forfeiture is not applied.
    const res = await db.prepare(`SELECT * FROM ups_lineup_pick_reservations WHERE ${RES_SQL} AND released_at_utc IS NULL`).bind(...keyArgs(k)).first();
    const held = res ? { year: Number(res.pick_year), round: Number(res.pick_round), original_owner: _fid(res.original_owner) } : pen.pick;
    const inv = await readPickInventory(season, leagueId);
    if (res && res.state && res.state !== "reserved" && res.state !== "secured") out.pick = { verified: false, reason: `reservation_${res.state}` };
    else if (!inv) out.pick = { verified: false, reason: "pick_inventory_unreadable" };
    else if (!inv.years.includes(Number(held.year))) out.pick = { verified: false, reason: "pick_year_not_listed_on_mfl_yet" };
    else {
      const owner = Object.entries(inv.byHolder).find(([, picks]) => picks.some((p) => pickKey(p) === pickKey(held)));
      if (!owner) out.pick = { verified: true, secured: true };
      else if (_fid(owner[0]) === k.fid) out.pick = { verified: false, reason: "pick_still_owned" };
      else out.pick = { verified: false, reason: "pick_traded_away", owner: _fid(owner[0]) };
    }
  }
  if (pen.cap_k) {
    const d = await _mflJson(`${MFL_WWW}/${encodeURIComponent(pen.cap_season)}/export?TYPE=salaryAdjustments&L=${encodeURIComponent(leagueId)}&JSON=1`);
    const rows = d && d.salaryAdjustments && _arr(d.salaryAdjustments.salaryAdjustment);
    if (!rows) out.cap = { verified: false, reason: `salary_adjustments_unreadable_for_${pen.cap_season}` };
    else {
      const hit = rows.find((a) => _fid(a.franchise_id) === k.fid && Math.round(Number(a.amount)) === pen.cap_k * 1000 && _s(a.description).includes(pen.cap_description));
      out.cap = hit ? { verified: true, adjustment_id: _s(hit.id) } : { verified: false, reason: "adjustment_not_found" };
    }
  }
  if (pen.membership) out.membership = { verified: false, reason: "commissioner_action_not_machine_verifiable" };
  const parts = Object.values(out).filter(Boolean);
  const applied = parts.length > 0 && parts.every((p) => p.verified);
  await db.prepare(
    `UPDATE ups_lineup_rulings SET sanction_status=?, sanction_verified_at_utc=?, sanction_verify_json=? WHERE ${KEY_SQL} AND sanction_status='assessed'`
  ).bind(applied ? "applied" : "assessed", applied ? _nowIso() : null, JSON.stringify(out), ...keyArgs(k)).run();
  return { ok: true, sanction_status: applied ? "applied" : "assessed", detail: out };
}

export { LINEUP_LADDER };
