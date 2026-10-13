// Stats → Pts Agst engine: /api/fantasy-points-against (list) and /api/fpa-detail
// (drill). Both routes build from this ONE computation, so a team's games, points
// and "usual" are the same number on the list and in its breakdown.
//
// Fixed here (review 2026-10-12):
//  - Games are counted per TEAM from the schedule's game state. Only FINAL games
//    count, so a team still to play (Monday night) or on a bye is never divided by
//    a game it hasn't played. Live and unplayed games are reported, not counted.
//  - MFL answers a week past the league's last week with that last week's scores
//    again (2025 W18 = W17; 2020 W17/W18 = W16). The season is the league's own
//    weeks (TYPE=league endWeek), and a scores reply for any other week is refused.
//  - A player's points go to the team he FACED ON GAME DAY (nflverse team that week,
//    via ff_player_ids), not to his current MFL team's opponent. MFL's team is the
//    fallback, and the response counts how many rows used each.
//  - Any MFL read that fails makes the whole answer fail (fpaUpstreamError): a board
//    quietly missing a week looks right and isn't.
//
// The functions below are pure (no fetch, no D1) except fpaLoadMfl and
// fpaLoadSeasonContext, which take their I/O as arguments, so node tests run the
// real arithmetic on fixtures.

export const FPA_ENGINE_VERSION = "fpa2-2026-10-13";

export const FPA_GROUPS = ["QB", "RB", "WR", "TE", "DL", "LB", "DB", "PK", "PN"];
// For these the listed team is the OFFENSE the players faced (an IDP scores
// against an offense); for the rest it is the defense.
export const FPA_OFFENSE_GROUPS = { DL: 1, LB: 1, DB: 1 };

export function fpaPosGroup(p) {
  p = String(p == null ? "" : p).trim().toUpperCase();
  if (p === "QB") return "QB";
  if (p === "RB" || p === "FB" || p === "HB") return "RB";
  if (p === "WR") return "WR";
  if (p === "TE") return "TE";
  if (p === "PK" || p === "K") return "PK";
  if (p === "PN" || p === "P") return "PN";
  if (p === "DT" || p === "DE" || p === "NT" || p === "DL") return "DL";
  if (p === "LB" || p === "OLB" || p === "ILB" || p === "MLB") return "LB";
  if (p === "CB" || p === "S" || p === "FS" || p === "SS" || p === "DB") return "DB";
  return "";
}

// nflverse team codes → MFL's. Anything else is the same in both (ARI, BAL, …).
const NFLV_TO_MFL = { GB: "GBP", KC: "KCC", NE: "NEP", NO: "NOS", SF: "SFO", TB: "TBB", LV: "LVR", JAX: "JAC", LA: "LAR" };
// MFL → nflverse, for the D1 pace / plays tables (which use nflverse codes).
export const MFL_TO_NFLV = { GBP: "GB", KCC: "KC", NEP: "NE", NOS: "NO", SFO: "SF", TBB: "TB", LVR: "LV", JAC: "JAX", LAR: "LA", OAK: "LV", SDC: "LAC", SD: "LAC", STL: "LA", ARZ: "ARI", BLT: "BAL", CLV: "CLE", HST: "HOU" };

const arr = (x) => Array.isArray(x) ? x : (x == null ? [] : [x]);
const str = (v) => String(v == null ? "" : v).trim();
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

export class FpaUpstreamError extends Error {
  constructor(what, weeks) {
    super("MFL read failed: " + what + (weeks && weeks.length ? " (weeks " + weeks.join(", ") + ")" : ""));
    this.what = what; this.weeks = weeks || [];
  }
}

export function fpaUrls(yr, lid, tag) {
  const t = tag ? "&ups=" + tag : "";
  return {
    league: `https://www48.myfantasyleague.com/${yr}/export?TYPE=league&L=${lid}&JSON=1${t}`,
    players: `https://www48.myfantasyleague.com/${yr}/export?TYPE=players&L=${lid}&DETAILS=1&JSON=1${t}`,
    sched: (w) => `https://api.myfantasyleague.com/${yr}/export?TYPE=nflSchedule&W=${w}&JSON=1${t}`,
    scores: (w) => `https://www48.myfantasyleague.com/${yr}/export?TYPE=playerScores&L=${lid}&W=${w}&JSON=1${t}`,
  };
}

// Game state from MFL's nflSchedule matchup: "final" = kicked off and the clock
// reads 0; "live" = kicked off, clock still running; "scheduled" = not kicked off.
export function fpaGameStatus(m, nowMs) {
  const ko = Number(m && m.kickoff) || 0;
  const started = ko > 0 && ko * 1000 <= nowMs;
  const secs = str(m && m.gameSecondsRemaining);
  if (started && secs === "0") return "final";
  // Old seasons can omit the clock; a game that kicked off 6+ hours ago is over.
  if (started && secs === "" && ko * 1000 <= nowMs - 6 * 3600 * 1000) return "final";
  if (started) return "live";
  return "scheduled";
}

// Reads everything MFL has for (yr, window). fetchJson(url, ttlSeconds) → parsed JSON
// or null. Throws FpaUpstreamError when any needed read fails.
export async function fpaLoadMfl({ yr, wMin, wMax, lid, fetchJson, nowMs, currentSeason, tag }) {
  const U = fpaUrls(yr, lid, tag);
  const past = !currentSeason;
  const [league, players] = await Promise.all([
    fetchJson(U.league, 86400),
    fetchJson(U.players, past ? 86400 : 21600),
  ]);
  const endWeek = parseInt(str(league && league.league && league.league.endWeek), 10);
  if (!(endWeek >= 1 && endWeek <= 18)) throw new FpaUpstreamError("league settings");
  const plist = arr(players && players.players && players.players.player);
  if (!plist.length) throw new FpaUpstreamError("players");

  const seasonWeeks = []; for (let w = 1; w <= endWeek; w++) seasonWeeks.push(w);
  const scheds = await Promise.all(seasonWeeks.map((w) => fetchJson(U.sched(w), past ? 86400 : 120)));
  const badSched = seasonWeeks.filter((w, i) => !(scheds[i] && scheds[i].nflSchedule));
  if (badSched.length) throw new FpaUpstreamError("NFL schedule", badSched);
  const schedByWeek = {};
  seasonWeeks.forEach((w, i) => { schedByWeek[w] = arr(scheds[i].nflSchedule.matchup); });

  // Scores only for window weeks that have kicked off. A week whose games are all
  // final and ≥ 4 days past its last kickoff is done (stat corrections land within
  // days); it can be cached for a day. Anything newer is re-read every 2 minutes.
  const lo = Math.max(1, wMin), hi = Math.min(endWeek, wMax);
  const scoreWeeks = [], scoreTtl = {};
  for (let w = lo; w <= hi; w++) {
    const ms = schedByWeek[w];
    const started = ms.some((m) => fpaGameStatus(m, nowMs) !== "scheduled");
    if (!started) continue;
    const allFinal = ms.length > 0 && ms.every((m) => fpaGameStatus(m, nowMs) === "final");
    const lastKo = Math.max.apply(null, ms.map((m) => Number(m.kickoff) || 0)) * 1000;
    scoreWeeks.push(w);
    scoreTtl[w] = (past || (allFinal && lastKo <= nowMs - 4 * 86400 * 1000)) ? 86400 : 120;
  }
  const scoresRaw = await Promise.all(scoreWeeks.map((w) => fetchJson(U.scores(w), scoreTtl[w])));
  const badScores = [], scoresByWeek = {};
  scoreWeeks.forEach((w, i) => {
    const ps = scoresRaw[i] && scoresRaw[i].playerScores;
    // MFL hands back its last week for any later week number: refuse a reply that
    // isn't the week asked for, rather than credit those points a second time.
    if (!ps || str(ps.week) !== String(w)) { badScores.push(w); return; }
    scoresByWeek[w] = arr(ps.playerScore);
  });
  if (badScores.length) throw new FpaUpstreamError("player scores", badScores);
  return { yr: String(yr), endWeek, players: plist, schedByWeek, scoresByWeek, readAtMs: nowMs };
}

// Game-day team for each MFL player, from nflverse weekly rows (D1) joined through
// ff_player_ids, plus team plays per week and season pace for the drill's context.
// One scan per season, cached by the caller. queryAll(sql, ...binds) → rows.
export async function fpaLoadSeasonContext(queryAll, season) {
  const s = parseInt(season, 10);
  const teamRows = await queryAll(
    "WITH pw AS (" +
    "  SELECT f.mfl_id AS m, w.week AS wk, w.team AS t" +
    "    FROM nfl_player_weekly w JOIN ff_player_ids f ON f.gsis_id = w.gsis_id" +
    "   WHERE w.season = ?1 AND w.week BETWEEN 1 AND 18 AND w.team IS NOT NULL AND w.team <> ''" +
    "     AND f.mfl_id IS NOT NULL AND f.gsis_id NOT IN ('', 'NA')" +
    "), agg AS (SELECT m, MIN(t) AS t, MIN(wk) AS lo, MAX(wk) AS hi, COUNT(DISTINCT t) AS n FROM pw GROUP BY m)" +
    " SELECT m, t, lo, hi, NULL AS wk FROM agg WHERE n = 1" +
    " UNION ALL SELECT pw.m, pw.t, NULL, NULL, pw.wk FROM pw JOIN agg ON agg.m = pw.m WHERE agg.n > 1", s);
  const playRows = await queryAll(
    "SELECT week, team, SUM(COALESCE(rush_att,0)+COALESCE(pass_att,0)+COALESCE(pass_sacks,0)) AS plays " +
    "FROM nfl_player_weekly WHERE season = ?1 AND week BETWEEN 1 AND 18 GROUP BY week, team", s);
  const paceRows = await queryAll("SELECT team, off_plays_pg, def_plays_pg FROM nfl_team_pace WHERE season = ?1", s);
  const one = {}, multi = {};
  for (const r of teamRows) {
    const m = str(r.m); if (!m) continue;
    if (r.wk == null) one[m] = [str(r.t), Number(r.lo), Number(r.hi)];
    else (multi[m] = multi[m] || {})[Number(r.wk)] = str(r.t);
  }
  const plays = {}; let through = 0;
  for (const r of playRows) { const w = Number(r.week); (plays[w] = plays[w] || {})[str(r.team)] = Number(r.plays) || 0; if (w > through) through = w; }
  const pace = {};
  for (const r of paceRows) pace[str(r.team)] = { off: r.off_plays_pg == null ? null : Number(r.off_plays_pg), def: r.def_plays_pg == null ? null : Number(r.def_plays_pg) };
  return { season: String(s), one, multi, plays, pace, through };
}

function nflvTeamFor(ctx, pid, w) {
  if (!ctx) return "";
  const m = ctx.multi[pid];
  if (m) return m[w] || "";
  const o = ctx.one[pid];
  if (o && w >= o[1] && w <= o[2]) return o[0];
  return "";
}

// Each season week's state from the schedule alone ("final" = every game final,
// "partial" = some kicked off, "scheduled" = none), and the last complete week
// counting from Week 1.
export function fpaWeekStates(mfl, nowMs) {
  const weekState = {};
  let lastComplete = 0, run = true;
  for (let w = 1; w <= mfl.endWeek; w++) {
    const ms = (mfl.schedByWeek[w] || []).filter((m) => arr(m.team).length >= 2);
    const st = ms.map((m) => fpaGameStatus(m, nowMs));
    weekState[w] = ms.length && st.every((x) => x === "final") ? "final" : (st.some((x) => x !== "scheduled") ? "partial" : "scheduled");
    if (run && weekState[w] === "final") lastComplete = w; else run = false;
  }
  return { weekState, lastComplete };
}

export function fpaPlayerIndex(players) {
  const m = new Map();
  for (const p of players) {
    const id = typeof p.id === "string" ? p.id : str(p.id);
    m.set(id, { grp: fpaPosGroup(p.position), team: typeof p.team === "string" ? p.team.toUpperCase() : str(p.team).toUpperCase(), p });
  }
  return m;
}
function fpaName(info) { return info && info.p ? str(info.p.name) : ""; }

// The whole computation for one (season, window). baseline: "leave_out" (a player's
// usual = his average in his OTHER games in the window) or "include_self" (his
// average over all of them, this game included).
export function fpaCompute(mfl, ctx, { wMin, wMax, nowMs, baseline }) {
  const endWeek = mfl.endWeek;
  const lo = Math.max(1, wMin), hi = Math.min(endWeek, Math.max(lo, wMax));
  // id → { grp, team, p } (built once per season read; MFL ids and team codes are
  // already trimmed upper-case strings).
  const pInfo = mfl.pInfo || (mfl.pInfo = fpaPlayerIndex(mfl.players));

  // Every game of the season with its state; team → week → game.
  const gameOf = {}, teamsAll = {}, weekState = {}, weekGames = {};
  for (let w = 1; w <= endWeek; w++) {
    const ms = mfl.schedByWeek[w] || [];
    let fin = 0, started = 0;
    weekGames[w] = [];
    for (const m of ms) {
      const ts = arr(m.team); if (ts.length < 2) continue;
      const a = str(ts[0].id).toUpperCase(), b = str(ts[1].id).toUpperCase();
      const st = fpaGameStatus(m, nowMs), ko = Number(m.kickoff) || 0;
      const aHome = str(ts[0].isHome) === "1";
      (gameOf[a] = gameOf[a] || {})[w] = { wk: w, opp: b, home: aHome, kickoff: ko, status: st };
      (gameOf[b] = gameOf[b] || {})[w] = { wk: w, opp: a, home: !aHome, kickoff: ko, status: st };
      teamsAll[a] = 1; teamsAll[b] = 1;
      weekGames[w].push({ a, b, status: st, kickoff: ko });
      if (st === "final") fin++;
      if (st !== "scheduled") started++;
    }
    const n = weekGames[w].length;
    weekState[w] = n && fin === n ? "final" : (started ? "partial" : "scheduled");
  }
  // The last week whose games are ALL final, counting from Week 1.
  let lastComplete = 0;
  for (let w = 1; w <= endWeek; w++) { if (weekState[w] === "final") lastComplete = w; else break; }

  // Player-games in the window, credited to the team faced on game day; final only.
  const attribution = { gameDay: 0, mflTeam: 0, unattributed: 0, notFinal: 0 };
  const pg = [];   // { pid, wk, pts, def, own, grp }
  for (let w = lo; w <= hi; w++) {
    for (const s of (mfl.scoresByWeek[w] || [])) {
      const pid = typeof s.id === "string" ? s.id : str(s.id), info = pInfo.get(pid);
      if (!info || !info.grp) continue;
      const grp = info.grp;
      const pts = parseFloat(s.score); if (isNaN(pts)) continue;
      let own = "", src = "";
      const nv = nflvTeamFor(ctx, pid, w);
      if (nv) {
        const cand = NFLV_TO_MFL[nv] || nv;
        if (gameOf[cand] && gameOf[cand][w]) { own = cand; src = "gameDay"; }
      }
      if (!own && gameOf[info.team] && gameOf[info.team][w]) { own = info.team; src = "mflTeam"; }
      if (!own) { attribution.unattributed++; continue; }
      const g = gameOf[own][w];
      if (g.status !== "final") { attribution.notFinal++; continue; }
      attribution[src]++;
      pg.push({ pid, wk: w, pts, def: g.opp, own, grp });
    }
  }

  // Final games each team played in the window (THE per-game denominator).
  const games = {};
  for (const t in gameOf) for (let w = lo; w <= hi; w++) { const g = gameOf[t][w]; if (g && g.status === "final") games[t] = (games[t] || 0) + 1; }

  // Each player's games in the window, for his usual. Sums are kept per player and
  // per (player, team faced), so a leave-out average is O(1).
  const per = new Map();
  for (const x of pg) {
    let t = per.get(x.pid);
    if (!t) { t = { s: 0, n: 0, d: {}, games: [] }; per.set(x.pid, t); }
    t.s += x.pts; t.n++; t.games.push(x);
    const v = t.d[x.def];
    if (v) { v.s += x.pts; v.n++; } else t.d[x.def] = { s: x.pts, n: 1 };
  }
  const gamesOf = (pid) => { const t = per.get(pid); return t ? t.games : []; };
  const usualFor = (pid, def) => {
    const t = per.get(pid); if (!t) return null;
    if (baseline === "include_self") return { avg: t.s / t.n, n: t.n };
    const v = t.d[def];
    const n = t.n - (v ? v.n : 0);
    return n > 0 ? { avg: (t.s - (v ? v.s : 0)) / n, n } : null;
  };

  return { yr: mfl.yr, endWeek, lo, hi, pInfo, gameOf, teamsAll, weekState, weekGames, lastComplete, attribution, pg, games, gamesOf, usualFor, baseline, readAtMs: mfl.readAtMs };
}

// Per (team, group): points, games, usual, ratio. Rank 1 = the highest ratio
// (the most points over what those players usually score).
export function fpaAggregate(E, groups) {
  const acc = {};   // def → grp → { pts, ptsB, exp, n }
  for (const x of E.pg) {
    if (groups && groups.indexOf(x.grp) < 0) continue;
    const a = ((acc[x.def] = acc[x.def] || {})[x.grp] = acc[x.def][x.grp] || { pts: 0, ptsB: 0, exp: 0, n: 0, nb: 0 });
    a.pts += x.pts; a.n++;
    const u = E.usualFor(x.pid, x.def);
    if (u) { a.ptsB += x.pts; a.exp += u.avg; a.nb++; }
  }
  const out = {};
  for (const g of (groups || FPA_GROUPS)) {
    const rows = [];
    for (const d in acc) {
      const a = acc[d][g]; if (!a) continue;
      const ratio = a.exp > 0 ? a.ptsB / a.exp : null;
      rows.push({ d, a, ratio });
    }
    rows.sort((x, y) => (x.ratio == null) - (y.ratio == null) || (y.ratio - x.ratio) || (x.d < y.d ? -1 : 1));
    const ranked = rows.filter((r) => r.ratio != null).length;
    rows.forEach((r, i) => {
      const G = E.games[r.d] || 0;
      const perGame = G ? r.a.pts / G : null;
      // Usual per game = per game at those players' usual rate, so that
      // Allowed ÷ Usual is exactly the ratio the list is ranked by.
      const usual = perGame != null && r.ratio ? perGame / r.ratio : null;
      (out[r.d] = out[r.d] || {})[g] = {
        raw: { total: r1(r.a.pts), perGame: perGame != null ? r1(perGame) : null, oppNorm: usual != null ? r1(usual) : null, games: G },
        adj: r.ratio != null ? { rank: i + 1, of: ranked, ratio: r2(r.ratio) } : null,
        n: r.a.n, nBaseline: r.a.nb,
      };
    });
  }
  return out;
}

// Week-level facts the screen states: which weeks are final, which games are left,
// each team's byes and next game.
export function fpaSeasonFacts(E) {
  const weeksFinal = [], weeksPartial = [], pending = [];
  for (let w = E.lo; w <= E.hi; w++) {
    if (E.weekState[w] === "final") weeksFinal.push(w);
    else if (E.weekState[w] === "partial") {
      weeksPartial.push(w);
      for (const g of E.weekGames[w] || []) if (g.status !== "final") pending.push({ wk: w, away: g.a, home: g.b, kickoff: g.kickoff, status: g.status });
    }
  }
  const teamGames = {};
  for (const t in E.teamsAll) {
    const bye = [], left = [];
    for (let w = E.lo; w <= E.hi; w++) {
      const g = E.gameOf[t][w];
      if (!g) { if (E.weekGames[w] && E.weekGames[w].length) bye.push(w); continue; }
      // Only a game in a week being played: future weeks aren't "pending" yet.
      if (g.status !== "final" && E.weekState[w] === "partial") left.push({ wk: w, opp: g.opp, home: g.home, kickoff: g.kickoff, status: g.status });
    }
    let next = null;
    for (let w = 1; w <= E.endWeek; w++) {
      const g = E.gameOf[t][w];
      if (g && g.status !== "final") { next = { wk: w, opp: g.opp, home: g.home, kickoff: g.kickoff, status: g.status }; break; }
    }
    teamGames[t] = { games: E.games[t] || 0, bye, pending: left, next };
  }
  let seasonState = "complete";
  const anyFinal = Object.keys(E.weekState).some((w) => E.weekState[w] !== "scheduled");
  if (!anyFinal) seasonState = "not_started";
  else if (E.lastComplete < E.endWeek) seasonState = "in_season";
  const weekStates = {}; for (let w = 1; w <= E.endWeek; w++) weekStates[w] = E.weekState[w];
  return { weeksFinal, weeksPartial, pending, teamGames, seasonState, weekStates };
}

// The drill for one (team, group): every week in the window as a row (final,
// bye, live, not played yet), and for each final game the players who faced the
// team, with their usual and their snaps. snaps: { byPfr: {pfr: {wk: {off, def}}},
// pfrByMfl: {mfl: pfr}, state: "ok" | "error" | "none" } or null.
export function fpaDetail(E, ctx, agg, team, grp, snaps) {
  const isIdp = !!FPA_OFFENSE_GROUPS[grp];
  const snapKind = (grp === "PK" || grp === "PN") ? "" : (isIdp ? "def" : "off");
  const gOf = E.gameOf[team] || {};
  const faced = E.pg.filter((x) => x.def === team && x.grp === grp);
  const pfrOf = (pid) => snaps && snaps.pfrByMfl ? snaps.pfrByMfl[pid] : null;
  const snapRec = (pid) => { const p = pfrOf(pid); return p && snaps.byPfr ? snaps.byPfr[p] : null; };

  // Pace context (kept for the desktop workbench; the mobile drill doesn't show it).
  // The offense that produced these players' chances: the opponent's for
  // QB/RB/WR/TE/K/P, the listed team's own for DL/LB/DB.
  let dPace = null;
  const pace = ctx && ctx.pace ? ctx.pace : null;
  if (pace) {
    let sum = 0, n = 0;
    const fld = isIdp ? "off" : "def";
    for (const t in pace) if (pace[t][fld] != null) { sum += pace[t][fld]; n++; }
    const lg = n ? sum / n : null, mine = pace[MFL_TO_NFLV[team] || team];
    const f = (mine && mine[fld] != null && lg) ? mine[fld] / lg : null;
    dPace = { team, side: isIdp ? "offense" : "defense", defPlaysPg: mine ? mine[fld] : null, leagueDefAvg: lg != null ? r1(lg) : null, expDeltaPct: f != null ? Math.round((f - 1) * 100) : null };
  }

  const weeks = [], schedule = [];
  for (let w = E.lo; w <= E.hi; w++) {
    const g = gOf[w];
    if (!g) { if (E.weekGames[w] && E.weekGames[w].length) schedule.push({ wk: w, state: "bye" }); continue; }
    if (g.status !== "final") { schedule.push({ wk: w, state: g.status, opp: g.opp, home: g.home, kickoff: g.kickoff }); continue; }
    const ps = faced.filter((x) => x.wk === w).map((x) => {
      const u = E.usualFor(x.pid, team);
      const others = E.gamesOf(x.pid).filter((y) => y.def !== team);
      const vsOthers = others.length ? others.reduce((a, y) => a + y.pts, 0) / others.length : null;
      const row = { wk: w, pid: x.pid, name: fpaName(E.pInfo.get(x.pid)) || x.pid, pts: r1(x.pts),
        usual: u ? r1(u.avg) : null, usualGames: u ? u.n : 0,
        diff: u ? r1(x.pts - u.avg) : null,
        avgVsOthers: vsOthers != null ? r1(vsOthers) : null, otherGames: others.length,
        variancePct: (vsOthers != null && vsOthers > 0) ? Math.round((x.pts / vsOthers - 1) * 100) : null };
      if (snapKind) {
        const rec = snapRec(x.pid);
        const cur = rec && rec[w] ? rec[w][snapKind] : null;
        if (cur != null) {
          const other = [];
          for (let k = E.lo; k <= E.hi; k++) if (k !== w && rec[k] && rec[k][snapKind] != null && rec[k][snapKind] > 0) other.push(rec[k][snapKind]);
          const norm = other.length ? other.reduce((a, b) => a + b, 0) / other.length : null;
          row.snaps = cur; row.snapKind = snapKind;
          row.snapNorm = norm != null ? Math.round(norm) : null;
          row.snapDeltaPct = (norm && norm > 0) ? Math.round((cur / norm - 1) * 100) : null;
        }
      }
      return row;
    }).sort((a, b) => (b.pts - a.pts) || (a.name < b.name ? -1 : 1));
    const total = r1(ps.reduce((a, x) => a + x.pts, 0));
    const withU = ps.filter((x) => x.usual != null);
    const usualTotal = withU.length ? r1(withU.reduce((a, x) => a + x.usual, 0)) : null;
    // Plays context: the offense that produced the chances, vs its season pace.
    let script = { opp: g.opp };
    const offMfl = isIdp ? team : g.opp, offNv = MFL_TO_NFLV[offMfl] || offMfl;
    const playsWk = ctx && ctx.plays && ctx.plays[w] ? ctx.plays[w][offNv] : null;
    const norm = pace && pace[offNv] ? pace[offNv].off : null;
    if (playsWk != null && norm) {
      script.playsWk = playsWk; script.norm = r1(norm); script.offense = offMfl;
      script.actualDeltaPct = Math.round((playsWk / norm - 1) * 100);
      script.expDeltaPct = dPace ? dPace.expDeltaPct : null;
      script.scriptGap = (dPace && dPace.expDeltaPct != null) ? script.actualDeltaPct - dPace.expDeltaPct : null;
    }
    weeks.push({ wk: w, total, usualTotal, players: ps, script, opp: g.opp, home: g.home });
    schedule.push({ wk: w, state: "final", opp: g.opp, home: g.home, total, usualTotal, n: ps.length });
  }
  const gp = E.games[team] || 0;
  const total = r1(weeks.reduce((a, w) => a + w.total, 0));
  const cell = agg && agg[team] && agg[team][grp];
  return {
    team, pos: grp, side: isIdp ? "offense" : "defense",
    weeks, schedule, gamesPlayed: gp, total,
    perGame: gp ? r1(total / gp) : null,
    usualPerGame: cell ? cell.raw.oppNorm : null,
    ratio: cell && cell.adj ? cell.adj.ratio : null, rank: cell && cell.adj ? cell.adj.rank : null, of: cell && cell.adj ? cell.adj.of : null,
    dPace,
    context: { snaps: snapKind ? (snaps ? snaps.state : "none") : "not_applicable", plays: ctx ? (ctx.through >= E.hi ? "ok" : "partial") : "none", playsThrough: ctx ? ctx.through : 0 },
  };
}

// ── HTTP: both routes. Read-only: MFL export GETs and D1 SELECTs, nothing else. ──
// Caches (all GET-only, errors never cached):
//   MFL reads    Cloudflare fetch cache, keyed by URL (+ "&ups=<tag>" so no copy
//                written by the old 24-hour code is reused). Finished weeks 24 h,
//                anything newer 2 min.
//   game-day ctx caches.default, one entry per season: 6 h (this season) / 7 days.
//   response     caches.default: 2 min while the window has a game not final or
//                within 4 days of its last kickoff; 1 h otherwise; 24 h past seasons.
// The caches.default keys sit on a fake host (upsmfl-fpa.local) like the other stat
// caches; a preview worker on workers.dev must namespace them (shared cache).
// "Usual" = each player's average over the window, this game included. Pooled over
// 2019–2025 it forecasts as well as a leave-one-out usual at each one's best shrink
// and better unshrunk, and it is the basis Lineup and Sched already rank by.
export const FPA_BASELINE = "include_self";
const FPA_CACHE_HOST = "https://upsmfl-fpa.local";
const FPA_MFL_TAG = "fpa2";

function fpaCurrentSeason(nowMs) {
  const d = new Date(nowMs);
  return d.getUTCMonth() >= 2 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

async function fpaCacheMatch(key) {
  if (typeof caches === "undefined" || !caches.default) return null;
  try { return await caches.default.match(new Request(key)); } catch (_) { return null; }
}
function fpaCachePut(ctx, key, body, ttl) {
  if (typeof caches === "undefined" || !caches.default || !ttl) return;
  try {
    const r = new Response(body, { headers: { "content-type": "application/json", "Cache-Control": "public, max-age=" + ttl } });
    const p = caches.default.put(new Request(key), r);
    if (ctx && ctx.waitUntil) ctx.waitUntil(p.catch(() => {}));
  } catch (_) {}
}

async function fpaSeasonContextCached(env, ctx, yr, past) {
  const db = env && env.UPS_MFL_DB;
  if (!db) return { ctx: null, state: "none" };
  const key = FPA_CACHE_HOST + "/ctx?season=" + yr + "&v=" + FPA_ENGINE_VERSION;
  const hit = await fpaCacheMatch(key);
  if (hit) { try { return { ctx: await hit.json(), state: "ok" }; } catch (_) {} }
  try {
    const queryAll = async (sql, ...b) => { const r = await db.prepare(sql).bind(...b).all(); return (r && r.results) || []; };
    const c = await fpaLoadSeasonContext(queryAll, yr);
    fpaCachePut(ctx, key, JSON.stringify(c), past ? 7 * 86400 : 6 * 3600);
    return { ctx: c, state: "ok" };
  } catch (e) {
    return { ctx: null, state: "error" };
  }
}

async function fpaSnaps(env, yr, pids, lo, hi) {
  const db = env && env.UPS_MFL_DB;
  if (!db || !pids.length) return { byPfr: {}, pfrByMfl: {}, state: db ? "ok" : "none" };
  try {
    const chunks = (a) => { const out = []; for (let i = 0; i < a.length; i += 90) out.push(a.slice(i, i + 90)); return out; };
    const pfrByMfl = {};
    for (const c of chunks(pids)) {
      const r = await db.prepare("SELECT mfl_id, pfr_id FROM ff_player_ids WHERE mfl_id IN (" + c.map(() => "?").join(",") + ")").bind(...c).all();
      for (const x of (r && r.results) || []) { const p = str(x.pfr_id); if (p && p !== "NA") pfrByMfl[str(x.mfl_id)] = p; }
    }
    const pfrs = Array.from(new Set(Object.values(pfrByMfl)));
    const byPfr = {};
    for (const c of chunks(pfrs)) {
      const r = await db.prepare("SELECT pfr_id, week, off_snaps, def_snaps FROM nfl_player_snaps WHERE season = ? AND week BETWEEN ? AND ? AND pfr_id IN (" + c.map(() => "?").join(",") + ")")
        .bind(parseInt(yr, 10), lo, hi, ...c).all();
      for (const x of (r && r.results) || []) (byPfr[x.pfr_id] = byPfr[x.pfr_id] || {})[Number(x.week)] = { off: x.off_snaps == null ? null : Number(x.off_snaps), def: x.def_snaps == null ? null : Number(x.def_snaps) };
    }
    return { byPfr, pfrByMfl, state: "ok" };
  } catch (e) {
    return { byPfr: {}, pfrByMfl: {}, state: "error" };
  }
}

export async function handleFpaRequest(request, env, ctx, { jsonOut, nowMs, lid, fetchImpl }) {
  const url = new URL(request.url);
  const path = url.pathname;
  const isDetail = path === "/api/fpa-detail";
  const now = nowMs || Date.now();
  const doFetch = fetchImpl || fetch;
  const yr = str(url.searchParams.get("YEAR") || String(fpaCurrentSeason(now))).replace(/\D/g, "");
  const wMin = Math.max(1, parseInt(url.searchParams.get("week_min") || "1", 10) || 1);
  const wMaxRaw = parseInt(url.searchParams.get("week_max") || "0", 10) || 0;
  const auto = wMaxRaw <= 0;
  const posFilter = str(url.searchParams.get("pos")).toUpperCase().split(/[,\s]+/).filter(Boolean);
  const team = str(url.searchParams.get("team")).toUpperCase();
  const grp = isDetail ? fpaPosGroup(posFilter[0] || "") : "";
  if (!/^\d{4}$/.test(yr)) return jsonOut(400, { ok: false, error: "YEAR must be a 4-digit season" });
  if (isDetail && (!team || !grp)) return jsonOut(400, { ok: false, error: "team and pos are required" });

  const cur = fpaCurrentSeason(now), past = Number(yr) < cur;
  const asOf = new Date(now).toISOString();
  if (Number(yr) > cur) {
    // A season that hasn't started: say so, never fetch (MFL answers 404 HTML).
    return jsonOut(200, { ok: true, engine: FPA_ENGINE_VERSION, year: yr, season: { state: "not_started" }, teams: {}, weeksUsed: [], groups: FPA_GROUPS, as_of: asOf, ...(isDetail ? { team, pos: grp, weeks: [], schedule: [] } : {}) });
  }

  const sp = new URLSearchParams(url.searchParams);
  ["NO_CACHE", "cb", "_"].forEach((k) => sp.delete(k));
  const sorted = new URLSearchParams([...sp.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  const cacheKey = FPA_CACHE_HOST + path + "?" + sorted.toString() + "&v=" + FPA_ENGINE_VERSION;
  const noCache = str(url.searchParams.get("NO_CACHE")) === "1";
  if (!noCache) {
    const hit = await fpaCacheMatch(cacheKey);
    if (hit) { const body = await hit.text(); return new Response(body, { status: 200, headers: jsonOut(200, {}).headers }); }
  }

  const fetchJson = (u, ttl) => doFetch(u, { cf: { cacheTtlByStatus: { "200-299": ttl, "404": 60, "500-599": 0 }, cacheEverything: true }, headers: { "User-Agent": "ups-worker", Accept: "application/json" } })
    .then((r) => (r && r.ok ? r.json() : null)).catch(() => null);
  let mfl;
  try {
    mfl = await fpaLoadMfl({ yr, wMin, wMax: auto ? 99 : wMaxRaw, lid: lid || "74598", fetchJson, nowMs: now, currentSeason: !past, tag: FPA_MFL_TAG });
  } catch (e) {
    if (e instanceof FpaUpstreamError) return jsonOut(502, { ok: false, error: "mfl_unavailable", detail: e.message, failedWeeks: e.weeks, as_of: asOf });
    throw e;
  }
  const { ctx: seasonCtx, state: ctxState } = await fpaSeasonContextCached(env, ctx, yr, past);

  // The window: week_max omitted → through the last COMPLETE week (the Lineup
  // chip's basis); if no week is complete yet, the week being played.
  const ws = fpaWeekStates(mfl, now);
  let hi;
  if (!auto) hi = Math.min(mfl.endWeek, Math.max(wMin, wMaxRaw));
  else if (ws.lastComplete >= wMin) hi = ws.lastComplete;
  else {
    let firstOpen = wMin;
    for (let w = wMin; w <= mfl.endWeek; w++) { if (ws.weekState[w] !== "final") { firstOpen = w; break; } }
    hi = Math.min(mfl.endWeek, firstOpen);
  }
  const lo = Math.min(wMin, mfl.endWeek);
  const E = fpaCompute(mfl, seasonCtx, { wMin: lo, wMax: hi, nowMs: now, baseline: FPA_BASELINE });
  const facts = fpaSeasonFacts(E);
  const groups = isDetail ? [grp] : (posFilter.length ? FPA_GROUPS.filter((g) => posFilter.indexOf(g) >= 0) : FPA_GROUPS);
  const agg = fpaAggregate(E, groups);
  const weeksUsed = [];
  for (let w = lo; w <= hi; w++) if ((E.weekGames[w] || []).some((g) => g.status === "final")) weeksUsed.push(w);
  const base = {
    ok: true, engine: FPA_ENGINE_VERSION, year: yr, baseline: FPA_BASELINE,
    window: { week_min: lo, week_max: hi, requested_max: auto ? null : wMaxRaw, auto },
    weeksUsed,
    season: { state: facts.seasonState, endWeek: mfl.endWeek, lastCompleteWeek: ws.lastComplete, weeks: ws.weekState },
    weeks_final: facts.weeksFinal, weeks_in_progress: facts.weeksPartial,
    attribution: { ...E.attribution, context: ctxState, nflverseThrough: seasonCtx ? seasonCtx.through : 0 },
    as_of: asOf, mfl_read_at: new Date(mfl.readAtMs).toISOString(),
  };
  let payload;
  if (!isDetail) {
    payload = { ...base, groups, teams: agg, pending: facts.pending, teamGames: facts.teamGames };
  } else {
    if (!E.teamsAll[team]) return jsonOut(400, { ok: false, error: "unknown team " + team });
    const pids = Array.from(new Set(E.pg.filter((x) => x.def === team && x.grp === grp).map((x) => x.pid)));
    const snapKind = (grp === "PK" || grp === "PN") ? "" : "x";
    const snaps = snapKind ? await fpaSnaps(env, yr, pids, lo, hi) : null;
    const d = fpaDetail(E, seasonCtx, agg, team, grp, snaps);
    payload = { ...base, ...d, teamGames: { [team]: facts.teamGames[team] } };
  }

  // Cache only a complete, correct answer.
  let lastKo = 0, allFinal = true;
  for (let w = lo; w <= hi; w++) for (const g of E.weekGames[w] || []) { if (g.kickoff > lastKo) lastKo = g.kickoff; if (g.status !== "final") allFinal = false; }
  const ttl = past ? 86400 : (allFinal && lastKo * 1000 <= now - 4 * 86400 * 1000 ? 3600 : 120);
  const body = JSON.stringify(payload);
  if (ctxState === "ok") fpaCachePut(ctx, cacheKey, body, ttl);
  return new Response(body, { status: 200, headers: jsonOut(200, {}).headers });
}
