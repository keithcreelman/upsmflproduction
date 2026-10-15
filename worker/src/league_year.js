// league_year.js — which MFL league year is LIVE right now (the season the */5 drop pipeline runs as).
//
// The calendar year is not the league year. The UPS season ends with NFL Week 17, which can run into January
// (2026: Thu Dec 31 – Mon Jan 4), and MFL does not roll the league over on Jan 1: the 2026 league stays live until
// the commissioner renews it, and until then the 2027 league does not exist — its exports 404 (verified
// 2026-10-09: https://api.myfantasyleague.com/2027/export?TYPE=league&L=74598 → HTTP 404 "Not Found"; a year MFL
// has opened but this league has not been renewed in answers HTTP 200 {"error":{"$t":"Invalid league ID …"}}).
// Run as the calendar year from Jan 1, the drop recorder scans a league that does not exist and every drop made
// in the still-live league is missed.
//
// So the live league year is read from MFL itself:
//   - this calendar year's league EXISTS                                → it is live (the normal case, Mar–Dec)
//   - it is definitively ABSENT, and last year's league exists and its own history lists nothing later than
//     itself                                                             → last year's league is still live
//   - anything else — an unreadable export, a timeout, or the two answers contradicting each other (last year's
//     history already lists this year, yet this year's export is "absent")
//                                                                        → UNRESOLVED: the caller runs nothing.
// UNRESOLVED is never turned into a guess. A drop recorded under the wrong season is priced on the wrong week
// calendar (a 2026 Week-17 drop read on 2027's calendar has 0 weeks earned → the full guarantee), so the pipeline
// waits — the recorder's lookback picks the drop up on the first tick that resolves.
//
// MFL's league history is the cross-check: renewing a league lists the new year in EVERY linked year's history
// (verified 2026-10-09: the 2025 league's export lists 2010–2026), so "last year's league is still the latest"
// is something MFL states, not something inferred from the calendar.
//
// env.YEAR, when set, is an explicit operator pin and wins (unchanged behaviour).
//
// resolveLiveLeagueYear is kept (exported, unchanged) but the drop pipeline now runs on resolveActiveSeason (below,
// #1237): it also waits for the old season's last week to be PROVABLY final before moving to the new league.

import { fpaScoredTeams, fpaUrls } from "./fpa_engine.js";

function digits(v) { return String(v == null ? "" : v).replace(/\D/g, ""); }

// Classify one raw MFL `TYPE=league` export response: { state: "exists" | "absent" | "unknown", history_years, detail }.
// Strict on purpose — only the two shapes MFL actually serves for a league year that does not exist count as
// "absent"; everything else that is not this league's own export is "unknown".
export function classifyLeagueExport(res, leagueId) {
  const status = Number(res && res.status) || 0;
  const text = String((res && res.text) || "");
  if (status === 404) return { state: "absent", history_years: null, detail: "http_404" };
  if (status !== 200) return { state: "unknown", history_years: null, detail: status ? `http_${status}` : "no_response" };
  let data = null;
  try { data = JSON.parse(text); } catch (_) { data = null; }
  if (!data || typeof data !== "object") return { state: "unknown", history_years: null, detail: "non_json" };
  const err = data.error && (typeof data.error === "object" ? data.error.$t : data.error);
  if (err) {
    return /invalid league id/i.test(String(err))
      ? { state: "absent", history_years: null, detail: "invalid_league_id" }
      : { state: "unknown", history_years: null, detail: `mfl_error:${String(err).slice(0, 80)}` };
  }
  const lg = data.league;
  if (!lg || typeof lg !== "object" || !digits(lg.id) || digits(lg.id) !== digits(leagueId)) {
    return { state: "unknown", history_years: null, detail: "not_this_league" };
  }
  let hist = lg.history && lg.history.league;
  hist = Array.isArray(hist) ? hist : (hist ? [hist] : []);
  const years = hist.map((h) => Number(digits(h && h.year))).filter((y) => y > 1900);
  return { state: "exists", history_years: years.length ? years : null, detail: "ok" };
}

// Resolve the live league year. `readLeague(year)` returns { status, text } for that year's raw `TYPE=league`
// export (it may throw — a throw is "unknown"). Returns { ok: true, season, source, calendar_year } or
// { ok: false, season: null, reason, calendar_year }.
export async function resolveLiveLeagueYear({ leagueId, nowMs, pinnedYear, readLeague }) {
  const pin = digits(pinnedYear);
  const cal = new Date(Number(nowMs)).getUTCFullYear();
  if (pin) return { ok: true, season: pin, source: "env.YEAR", calendar_year: cal };
  if (!(cal > 1900)) return { ok: false, season: null, reason: "clock_unreadable", calendar_year: null };
  const read = async (y) => {
    try { return classifyLeagueExport(await readLeague(y), leagueId); }
    catch (e) { return { state: "unknown", history_years: null, detail: `fetch_failed:${String((e && e.message) || e).slice(0, 80)}` }; }
  };
  const cur = await read(cal);
  if (cur.state === "exists") return { ok: true, season: String(cal), source: `mfl_league_${cal}_exists`, calendar_year: cal };
  if (cur.state !== "absent") return { ok: false, season: null, reason: `league_${cal}_unreadable:${cur.detail}`, calendar_year: cal };
  const prevYear = cal - 1;
  const prev = await read(prevYear);
  if (prev.state !== "exists") {
    return { ok: false, season: null, reason: `league_${cal}_absent:${cur.detail}+league_${prevYear}_${prev.state}:${prev.detail}`, calendar_year: cal };
  }
  const hist = prev.history_years;
  if (!hist || !hist.includes(prevYear)) {
    return { ok: false, season: null, reason: `league_${cal}_absent+league_${prevYear}_history_unreadable`, calendar_year: cal };
  }
  const later = hist.filter((y) => y > prevYear);
  if (later.length) {
    return { ok: false, season: null, reason: `contradiction:league_${prevYear}_history_lists_${Math.max(...later)}_but_league_${cal}_${cur.detail}`, calendar_year: cal };
  }
  return { ok: true, season: String(prevYear), source: `mfl_league_${cal}_${cur.detail}+league_${prevYear}_latest`, calendar_year: cal };
}

// ── The ACTIVE season (#1237): what the app shows, what a worker request that names no season means, and what the
// */5 drop pipeline runs as ──────────────────────────────────────────────────────────────────────────────────────────
// Keith 2026-10-14/15: never "whichever season MFL currently reports" and never the calendar. Creating next year's
// league early must not move anything off a season whose last week is still being played (2026: UPS Week 17 =
// NFL Week 17, Fri 2027-01-01 01:15 UTC → Tue 2027-01-05 01:15 UTC).
//
// N = the newest year MFL lists for this league (any linked year's export lists every renewed year in `history`),
// P = N − 1. The active season is N only when BOTH hold; otherwise it is P:
//   1. P is PROVABLY complete: every NFL game of P's own last week (P's export `endWeek`) passes seasonGameFinal
//      (below; stricter than the Pts Agst board's fpaGameStatus, which is left as it is), and MFL's live scoring
//      for the league's week shows nobody still playing.
//   2. N is the live league (#1207's evidence): N's export answers as this league AND P's own history lists N.
// Evidence that a game isn't over (yet) → P. Anything unreadable or contradictory → { ok: false, reason } and the
// caller fails visibly or skips. Never early to N, never a calendar year: the clock only picks which export to read
// first and times the games against their kickoffs.
const SETTLED_MS = 4 * 86400 * 1000;   // a week whose every clock reads 0 this long after its last kickoff is settled
const MIN_GAME_MS = 2.5 * 3600 * 1000; // no NFL game ends sooner: a clock of 0 earlier than this is a feed glitch
const NO_CLOCK_MS = 5 * 3600 * 1000;   // with no clock at all, nothing counts as over before 5 h after kickoff
const arr = (x) => (Array.isArray(x) ? x : (x == null ? [] : [x]));

// Is one NFL game of a season's last week PROVABLY final? → { final, why }. m = an MFL nflSchedule matchup.
// scored = the Set of NFL teams (MFL codes) with posted MFL fantasy points that week (fpaScoredTeams), or null if
// unread. Rules:
//   - kicked off (by MFL's current `kickoff`: a postponed game carries its new, later kickoff);
//   - nobody has the ball (`hasPossession` "1" = a live drive, overtime included);
//   - clock: `gameSecondsRemaining` "0" (and ≥ 2.5 h after kickoff). Any other number (the 3600 of a game still to
//     start or delayed, a clock stopped mid-game by a suspension, a negative overtime count) is NOT over, however
//     long ago the kickoff was. With no clock at all, elapsed time may stand in, but only from 5 h after kickoff;
//   - points: BOTH teams have posted MFL fantasy points — on either clock path. One side's points (or none) can be
//     a game that never finished; both sides always score in this league (IDP, kickers, punters), so requiring both
//     costs nothing once a game is really over.
export function seasonGameFinal(m, nowMs, scored) {
  const ko = (Number(m && m.kickoff) || 0) * 1000;
  if (!(ko > 0)) return { final: false, why: "no_kickoff" };
  if (ko > nowMs) return { final: false, why: "not_started" };
  const teams = arr(m && m.team);
  const ids = teams.map((t) => String((t && t.id) || "").trim().toUpperCase()).filter(Boolean);
  if (ids.length !== 2) return { final: false, why: "teams_unreadable" };
  if (teams.some((t) => String(t && t.hasPossession).trim() === "1")) return { final: false, why: "a_team_has_the_ball" };
  const raw = m && m.gameSecondsRemaining, clock = raw == null ? "" : String(raw).trim();
  if (clock === "0") {
    if (nowMs < ko + MIN_GAME_MS) return { final: false, why: "clock_0_too_soon_after_kickoff" };
  } else if (/^-?\d+$/.test(clock)) {
    return { final: false, why: `clock_${clock}` };
  } else if (nowMs < ko + NO_CLOCK_MS) {
    return { final: false, why: "no_clock_under_5h" };
  }
  if (!scored) return { final: false, why: "points_unread" };
  const missing = ids.filter((id) => !scored.has(id));
  if (missing.length) return { final: false, why: `no_points_${missing.join("_")}` };
  return { final: true, why: clock === "0" ? "clock_0+both_scored" : "no_clock+5h+both_scored" };
}

// Readers over MFL's exports. fetchImpl(url, ttlSeconds) → a fetch Response. Same URLs as the Pts Agst engine.
export function mflSeasonReaders({ leagueId, fetchImpl }) {
  const lid = digits(leagueId) || "74598";
  const body = async (url, ttl) => { const res = await fetchImpl(url, ttl); return { status: res.status, text: await res.text() }; };
  const json = async (url, ttl) => {
    const r = await body(url, ttl);
    if (r.status !== 200) throw new Error(`http_${r.status}`);
    return JSON.parse(r.text);
  };
  return {
    readLeague: (y) => body(`https://api.myfantasyleague.com/${encodeURIComponent(y)}/export?TYPE=league&L=${lid}&JSON=1`, 300),
    readSchedule: (y, w) => json(fpaUrls(y, lid).sched(w), 120),
    readScores: (y, w) => json(fpaUrls(y, lid).scores(w), 120),
    readPlayers: (y) => json(fpaUrls(y, lid).players, 21600),
    readLive: (y, w) => json(`https://www48.myfantasyleague.com/${encodeURIComponent(y)}/export?TYPE=liveScoring&L=${lid}&W=${encodeURIComponent(w)}&JSON=1`, 60),
  };
}

// Is season `year` complete? → { state: "complete" | "incomplete" | "unknown", detail }.
export async function seasonComplete({ year, endWeek, nowMs, readSchedule, readScores, readPlayers, readLive }) {
  let sched;
  try { sched = await readSchedule(year, endWeek); } catch (e) { return { state: "unknown", detail: `nflSchedule_${year}_w${endWeek}_unreadable` }; }
  const ns = sched && sched.nflSchedule;
  const games = arr(ns && ns.matchup);
  if (!ns || String(ns.week || "") !== String(endWeek) || !games.length) return { state: "unknown", detail: `nflSchedule_${year}_w${endWeek}_no_games` };
  const tag = (m) => arr(m && m.team).map((t) => String((t && t.id) || "?")).join("@");
  // Anything the schedule alone shows isn't over → not complete (no further reads).
  const early = games.map((m) => ({ m, r: seasonGameFinal(m, nowMs, null) })).filter((x) => x.r.why !== "points_unread");
  if (early.length) return { state: "incomplete", detail: `w${endWeek}:${early.length}_of_${games.length}_not_over:${tag(early[0].m)}:${early[0].r.why}` };
  // Settled: every clock reads 0 and the last kickoff is 4+ days back (MFL's points long posted).
  const lastKo = Math.max(...games.map((m) => (Number(m.kickoff) || 0) * 1000));
  if (lastKo <= nowMs - SETTLED_MS && games.every((m) => String(m.gameSecondsRemaining).trim() === "0")) {
    return { state: "complete", detail: `w${endWeek}:all_${games.length}_games_final_settled` };
  }
  let scored, live;
  try {
    const [s, p, l] = await Promise.all([readScores(year, endWeek), readPlayers(year), readLive(year, endWeek)]);
    const rows = arr(s && s.playerScores && s.playerScores.playerScore);
    const players = arr(p && p.players && p.players.player);
    if (String(s && s.playerScores && s.playerScores.week) !== String(endWeek) || !players.length) throw new Error("shape");
    scored = fpaScoredTeams({ players, scoresByWeek: { [endWeek]: rows } })[endWeek];
    live = l && l.liveScoring;
    if (!live || String(live.week || "") !== String(endWeek)) throw new Error("live");
  } catch (e) { return { state: "unknown", detail: `mfl_points_or_live_scoring_${year}_w${endWeek}_unreadable` }; }
  const notFinal = games.map((m) => ({ m, r: seasonGameFinal(m, nowMs, scored) })).filter((x) => !x.r.final);
  if (notFinal.length) return { state: "incomplete", detail: `w${endWeek}:${notFinal.length}_of_${games.length}_not_final:${tag(notFinal[0].m)}:${notFinal[0].r.why}` };
  // MFL's own scoring for the league's week must agree that nobody is still playing.
  const franchises = arr(live.franchise).concat(...arr(live.matchup).map((x) => arr(x && x.franchise)));
  const playing = franchises.filter((f) => Number(f && f.playersCurrentlyPlaying) > 0).length;
  if (playing) return { state: "incomplete", detail: `w${endWeek}:mfl_live_scoring_${playing}_franchises_still_playing` };
  return { state: "complete", detail: `w${endWeek}:all_${games.length}_games_final` };
}

// readLeague(year) → { status, text } (the raw TYPE=league export); readSchedule / readScores / readPlayers / readLive
// → parsed JSON (they may throw). completeMemo: an optional Map remembering when each season was proven complete (a
// season never un-completes). Returns { ok: true, season, source } or { ok: false, season: null, reason } (reasons in
// resolveLiveLeagueYear's format).
export async function resolveActiveSeason({ leagueId, nowMs, pinnedYear, readLeague, readSchedule, readScores, readPlayers, readLive, completeMemo }) {
  const pin = digits(pinnedYear);
  if (pin) return { ok: true, season: pin, source: "env.YEAR" };
  const now = Number(nowMs), cal = new Date(now).getUTCFullYear();
  const fail = (reason) => ({ ok: false, season: null, reason });
  const done = (y, source) => ({ ok: true, season: String(y), source });
  if (!(cal > 1900)) return fail("clock_unreadable");
  const lid = digits(leagueId);
  const seen = {};
  const league = async (y) => {
    if (seen[y]) return seen[y];
    let res;
    try { res = await readLeague(y); } catch (e) { return (seen[y] = { state: "unknown", history_years: null, end_week: 0, detail: `fetch_failed:${String((e && e.message) || e).slice(0, 80)}` }); }
    const c = classifyLeagueExport(res, lid);
    let end = 0;
    if (c.state === "exists") { try { end = parseInt(JSON.parse(res.text).league.endWeek, 10) || 0; } catch (_) { end = 0; } }
    return (seen[y] = { ...c, end_week: end });
  };
  // The newest year MFL lists. The clock only picks the first export to read.
  let probeYear = cal, probe = await league(cal);
  const first = probe;
  if (probe.state === "unknown") return fail(`league_${cal}_unreadable:${probe.detail}`);
  if (probe.state === "absent") {
    probeYear = cal - 1; probe = await league(probeYear);
    if (probe.state !== "exists") return fail(`league_${cal}_absent:${first.detail}+league_${probeYear}_${probe.state}:${probe.detail}`);
  }
  const hist = probe.history_years;
  if (!hist || !hist.includes(probeYear)) return fail(`${probeYear !== cal ? `league_${cal}_absent+` : ""}league_${probeYear}_history_unreadable`);
  if (probeYear !== cal && hist.some((y) => y >= cal)) return fail(`contradiction:league_${probeYear}_history_lists_${Math.max(...hist)}_but_league_${cal}_${first.detail}`);
  const N = Math.max(...hist), P = N - 1;
  if (!hist.includes(P)) {
    const n = await league(N);
    return n.state === "exists" ? done(N, `league_${N}_first_season`) : fail(`league_${N}_${n.state}:${n.detail}`);
  }
  // 1. Is P provably complete?
  const p = await league(P);
  if (p.state !== "exists") return fail(`${p.state === "absent" ? "contradiction:" : ""}league_${P}_${p.state}:${p.detail}`);
  if (!(p.end_week >= 1)) return fail(`league_${P}_endWeek_unreadable`);
  const key = `${lid}:${P}`;
  const provenAt = completeMemo && completeMemo.get(key);
  let fin = provenAt && provenAt <= now ? { state: "complete", detail: "remembered" } : null;
  if (!fin) fin = await seasonComplete({ year: P, endWeek: p.end_week, nowMs: now, readSchedule, readScores, readPlayers, readLive });
  if (fin.state === "unknown") return fail(`season_${P}_completion_unreadable:${fin.detail}`);
  if (fin.state === "incomplete") return done(P, `season_${P}_not_complete:${fin.detail}`);
  if (completeMemo && !(provenAt && provenAt <= now)) completeMemo.set(key, now);
  // 2. Is N the live league?
  const n = await league(N);
  if (n.state !== "exists") return fail(`contradiction:league_${N}_listed_but_${n.state}:${n.detail}`);
  if (!(p.history_years || []).includes(N)) return fail(`contradiction:league_${P}_history_does_not_list_${N}`);
  return done(N, `season_${P}_complete:${fin.detail}+league_${N}_live`);
}
