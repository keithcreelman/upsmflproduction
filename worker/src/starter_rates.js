// starter_rates.js — Boom / Bust / Startable against the UPS starter pool.
//
// WHY (Keith 2026-10-10). The old Boom/Bust (/api/player-consistency) compared
// a player's week with the 75th/25th percentile of EVERY weekly score at his
// position — free agents and inactive 0.0 weeks included — so it mostly told
// people who play from people who don't (old RB Bust% was 0 for every regular
// starter; a bench RB who never reached a starter's 75th percentile read Boom
// 100%). "Consistency" (100 × (1 − σ/μ)) was opaque.
//
// The model, as Keith specified it:
//   * pool = each COMPLETED week's UPS lineup starters at the player's MFL
//     lineup group (DL = DE+DT, DB = CB+S), who PLAYED that week;
//   * a played week is a Boom when it reaches that week's starter P75, a Bust
//     at or below the starter P25, Startable when it reaches the starter
//     median; Startable% = qualifying played weeks reaching the median ÷
//     qualifying played weeks. Counts are shown beside every %;
//   * anyone (starter, bench, free agent) is measured against those numbers;
//   * no-game, bye and no-snap weeks are counted apart from played games, and
//     a started player who didn't play (a true DNP / no-snap week) is kept OUT
//     of that week's lines. A player who PLAYED and scored 0.0 had a bust: that
//     week stays in his record AND in the lines (Keith 2026-10-10 ruling — low
//     snaps don't prove an injury, and there is no reliable injury-exit record
//     to say otherwise). Availability (weeks played / weeks his team played)
//     is reported beside the rates;
//   * final weeks only; three qualifying weeks before a % is shown.
// Percentiles are linear (R-7 = numpy default = Excel PERCENTILE.INC =
// d3.quantile) on integer TENTHS of a point, so every engine agrees exactly.
// Reference implementation and oracle: the 2026-10-10 agent-B model
// (tests/fixtures/starter_rates_cases.json).

export const MIN_POOL = 6;          // fewer played starters than this: no thresholds that week
export const SMALL_POOL = 12;       // flagged small below this (PK/PN are always 12)
export const MIN_WEEKS = 3;         // qualifying played weeks before a % is shown
export const GROUP_OF = { QB: "QB", RB: "RB", WR: "WR", TE: "TE", PK: "PK", PN: "PN", DE: "DL", DT: "DL", LB: "LB", CB: "DB", S: "DB", DL: "DL", DB: "DB" };

export const tenths = (x) => Math.round(Number(x) * 10);

/** Linear (R-7) quantile of an ascending array of integer tenths. */
export function quantile(sorted, p) {
  if (!sorted.length) return null;
  const h = (sorted.length - 1) * p, lo = Math.floor(h), hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (h - lo);
}

export function thresholdsFor(pool) {
  const s = pool.slice().sort((a, b) => a - b);
  if (s.length < MIN_POOL) return { n: s.length, p25: null, p50: null, p75: null, small: true };
  return { n: s.length, p25: quantile(s, 0.25), p50: quantile(s, 0.5), p75: quantile(s, 0.75), small: s.length < SMALL_POOL };
}

/** "Reaches" = ≥; "at or below" = ≤. A score that is both at P25 and at the
 * median (P25 = P50) is a median starter week: Startable, not Bust. */
export function label(t, thr) {
  const startable = t >= thr.p50;
  return { startable, boom: t >= thr.p75, bust: t <= thr.p25 && !startable };
}

/** played | no_snap | bye | no_game | unknown, with the reason. */
export function classify(row, teamsWithGame, byeWeek) {
  const st = row.snaps_total, ms = row.mfl_score;
  if (st != null && st > 0) return ["played", "snaps"];
  if (ms != null && ms !== 0) return ["played", "mfl_score_no_snap_row"];   // a snap-data gap; nonzero points prove he played
  // No snap data for him at all this season (no snap-count id, or none of
  // his weeks has a row): a 0.0 or a missing score can't say whether he
  // played — neither a bust nor a missed game (QA 2026-10-10).
  if (row.snap_source === false && st == null) return ["unknown", "no_snap_source"];
  const team = row.nfl_team;
  if (!team) return ["no_game", "no_nfl_team"];
  if (byeWeek[team] === row.week) return ["bye", "team_bye"];
  if ((teamsWithGame[row.week] || []).includes(team)) return ["no_snap", "team_played"];
  return ["no_game", "team_did_not_play"];
}

export const rate = (n, q) => (q >= MIN_WEEKS ? Math.round((100 * n) / q) : null);

/**
 * rows: one per (player, final week): {mfl_id, week, group, started, rostered,
 *   snaps_total (null = no snap row), mfl_score (null = no MFL row), nfl_team}
 * ctx: {final_weeks, teams_with_game: {week: [team]}, bye_week: {team: week}}
 */
export function computeStarterRates(rows, ctx) {
  const finalWeeks = ctx.final_weeks || [];
  const cls = new Map();
  const key = (pid, w) => pid + "|" + w;
  for (const r of rows) {
    const [c, why] = classify(r, ctx.teams_with_game || {}, ctx.bye_week || {});
    let score = r.mfl_score;
    if (c === "played" && score == null) score = r.rostered ? 0 : null;   // rostered + no MFL row = 0 pts; FA + no row = unscored
    cls.set(key(r.mfl_id, r.week), { c, why, score });
  }
  const pools = {};
  const noShows = [], playedZero = [];
  for (const r of rows) {
    if (!r.started) continue;
    const k = r.week + "|" + r.group;
    pools[k] = pools[k] || [];
    const x = cls.get(key(r.mfl_id, r.week));
    if (x.c !== "played" || x.score == null) { noShows.push({ mfl_id: r.mfl_id, week: r.week, group: r.group, class: x.c }); continue; }
    if (x.score === 0) playedZero.push({ mfl_id: r.mfl_id, week: r.week, group: r.group, snaps: r.snaps_total });   // listed, and IN the lines
    pools[k].push(tenths(x.score));
  }
  const thr = {};
  for (const w of finalWeeks) for (const g of new Set(rows.map((r) => r.group))) thr[w + "|" + g] = thresholdsFor(pools[w + "|" + g] || []);
  const byPlayer = new Map();
  for (const r of rows) { if (!byPlayer.has(r.mfl_id)) byPlayer.set(r.mfl_id, []); byPlayer.get(r.mfl_id).push(r); }
  const players = {};
  for (const [pid, rs] of byPlayer) {
    rs.sort((a, b) => a.week - b.week);
    const g = rs[0].group;
    const n = { qualifying: 0, startable: 0, boom: 0, bust: 0, no_snap: 0, bye: 0, no_game: 0, unknown: 0, started: 0, started_played: 0, started_no_show: 0,
                played_zero: 0, started_played_zero: 0, played_unscored: 0, pool_too_small: 0 };
    let pts = 0;
    const wk = [];
    for (const r of rs) {
      const x = cls.get(key(pid, r.week)), t = thr[r.week + "|" + g] || thresholdsFor([]);
      if (r.started) n.started++;
      let lab;
      if (x.c === "played") {
        if (x.score == null) { n.played_unscored++; lab = "played_unscored"; }
        else if (t.p50 == null) { n.pool_too_small++; lab = "pool_too_small"; }
        else {
          const L = label(tenths(x.score), t);
          n.qualifying++; pts += x.score;
          if (L.startable) n.startable++;
          if (L.boom) n.boom++;
          if (L.bust) n.bust++;
          if (r.started) n.started_played++;
          if (x.score === 0) { n.played_zero++; if (r.started) n.started_played_zero++; }
          lab = L.boom ? "boom" : L.bust ? "bust" : L.startable ? "startable" : "below_median";
        }
      } else {
        n[x.c]++;
        if (r.started) n.started_no_show++;
        lab = x.c + (r.started ? "_started" : "");    // e.g. no_snap_started: a lineup no-show
      }
      wk.push([r.week, x.score == null ? null : x.score, lab, r.started ? 1 : 0]);
    }
    const q = n.qualifying;
    players[pid] = {
      group: g, q,
      startable_n: n.startable, boom_n: n.boom, bust_n: n.bust,
      startable_pct: rate(n.startable, q), boom_pct: rate(n.boom, q), bust_pct: rate(n.bust, q),
      no_snap_n: n.no_snap, bye_n: n.bye, no_game_n: n.no_game,
      started_n: n.started, started_played_n: n.started_played, started_no_show_n: n.started_no_show, played_zero_n: n.played_zero,
      started_played_zero_n: n.started_played_zero, played_unscored_n: n.played_unscored, pool_too_small_n: n.pool_too_small,
      unknown_n: n.unknown,   // weeks we can't tell whether he played: in neither Played count
      // Availability: weeks he played ÷ weeks his NFL team played (byes and
      // weeks without a team game are in neither).
      played_n: q + n.played_unscored + n.pool_too_small, team_games_n: q + n.played_unscored + n.pool_too_small + n.no_snap,
      ppg: q ? Math.round((pts / q) * 100) / 100 : null,
      wk,
    };
  }
  const thresholds = {};
  for (const [k, v] of Object.entries(thr)) {
    const [w, g] = k.split("|");
    thresholds[w] = thresholds[w] || {};
    thresholds[w][g] = { n: v.n, small: v.small,
      p25: v.p25 == null ? null : v.p25 / 10, p50: v.p50 == null ? null : v.p50 / 10, p75: v.p75 == null ? null : v.p75 / 10 };
  }
  const weeks_label = finalWeeks.length
    ? (finalWeeks.length > 1 ? `Wks ${finalWeeks[0]}–${finalWeeks[finalWeeks.length - 1]}` : `Wk ${finalWeeks[0]}`) : "";
  return { thresholds, players, weeks_label, started_no_shows: noShows, started_played_zero: playedZero };
}

/** MFL team codes → nflverse codes (bye list vs snap rows). */
export const TEAM_NORM = { GBP: "GB", KCC: "KC", JAC: "JAX", LAR: "LA", LVR: "LV", NEP: "NE", NOS: "NO", SFO: "SF", TBB: "TB" };
export const normTeam = (t) => {
  const u = String(t || "").trim().toUpperCase();
  if (!u || u === "FA" || u === "FA*" || u === "UNK") return null;
  return TEAM_NORM[u] || u;
};

/**
 * Assemble the rows from D1 and run the model. Reads only:
 *   src_weekly (MFL scores, UPS starter/bench status), nfl_player_snaps,
 *   player_id_map (0170) → ff_player_ids → player_id_crosswalk (id-matched rows only) for MFL id → pfr,
 *   src_players (current NFL team, the last resort for a team).
 * completedWeek: the last COMPLETED week (the caller's authority); byeWeek: {team: week} or null.
 */
export async function loadStarterRates(db, { season, completedWeek, byeWeek }) {
  const sw = (await db.prepare(
    "SELECT player_id, week, pos_group, status, score, roster_franchise_id FROM src_weekly WHERE season = ? AND week <= ? AND COALESCE(is_reg, 1) = 1"
  ).bind(season, completedWeek).all()).results || [];
  const snaps = (await db.prepare(
    "SELECT week, pfr_id, team, COALESCE(off_snaps,0) + COALESCE(def_snaps,0) + COALESCE(st_snaps,0) AS tot FROM nfl_player_snaps WHERE season = ? AND week <= ?"
  ).bind(season, completedWeek).all()).results || [];
  // A week is FINAL here only once both of its sources have synced:
  //   * lineups — every UPS franchise that set a lineup in any week has starter
  //     rows that week (by FRANCHISE, so one empty lineup slot can't hold a
  //     week "pending" forever);
  //   * snap counts — rows for every team the schedule says played that week
  //     (nfl_team_vegas_weekly), not merely one snap row. Without a schedule
  //     row for the week, any snap rows count.
  const franchisesByWeek = {}, allFranchises = new Set(), snapTeamsByWeek = {};
  for (const r of sw) {
    if (r.status !== "starter" || !r.roster_franchise_id) continue;
    (franchisesByWeek[r.week] = franchisesByWeek[r.week] || new Set()).add(r.roster_franchise_id);
    allFranchises.add(r.roster_franchise_id);
  }
  for (const r of snaps) (snapTeamsByWeek[r.week] = snapTeamsByWeek[r.week] || new Set()).add(r.team);
  const expectedTeams = {};
  try {
    for (const r of (await db.prepare("SELECT week, COUNT(DISTINCT team) AS n FROM nfl_team_vegas_weekly WHERE season = ? AND week <= ? GROUP BY week")
      .bind(season, completedWeek).all()).results || []) expectedTeams[r.week] = Number(r.n);
  } catch (_) { /* no schedule table: any snap rows count */ }
  const finalWeeks = [], pendingWeeks = [];
  for (let w = 1; w <= completedWeek; w++) {
    const lineups = franchisesByWeek[w] && franchisesByWeek[w].size >= allFranchises.size;
    const nSnapTeams = snapTeamsByWeek[w] ? snapTeamsByWeek[w].size : 0;
    const snapsIn = nSnapTeams > 0 && (!expectedTeams[w] || nSnapTeams >= expectedTeams[w]);
    if (lineups && snapsIn) finalWeeks.push(w); else pendingWeeks.push(w);
  }
  const ids = new Map();   // mfl_id -> pfr_id
  const put = (rows, src) => { for (const r of rows || []) { const k = String(parseInt(r.mfl_id, 10)); if (!ids.has(k) && r.pfr_id && r.pfr_id !== "NA") ids.set(k, String(r.pfr_id)); } };
  try { put((await db.prepare("SELECT mfl_id, pfr_id FROM player_id_map WHERE accepted = 1 AND pfr_id IS NOT NULL").all()).results); } catch (_) { /* pre-0170 */ }
  put((await db.prepare(
    "SELECT mfl_id, pfr_id FROM ff_player_ids WHERE pfr_id IS NOT NULL AND pfr_id <> 'NA' AND mfl_id IN (SELECT DISTINCT player_id FROM src_weekly WHERE season = ?)"
  ).bind(season).all()).results);
  put(((await db.prepare(
    "SELECT CAST(mfl_player_id AS TEXT) AS mfl_id, pfr_id FROM player_id_crosswalk WHERE pfr_id IS NOT NULL AND pfr_id <> 'NA' AND COALESCE(confidence, '') NOT LIKE 'fuzzy%'"
  ).all()).results));
  const curTeam = new Map();
  try {
    for (const r of (await db.prepare("SELECT player_id, nfl_team FROM src_players WHERE season = (SELECT MAX(season) FROM src_players)").all()).results || []) {
      curTeam.set(String(parseInt(r.player_id, 10)), normTeam(r.nfl_team));
    }
  } catch (_) { /* optional */ }
  const snapAt = new Map(), snapWeeksByPfr = new Map(), teamsWithGame = {};
  for (const r of snaps) {
    snapAt.set(r.week + "|" + r.pfr_id, r);
    if (!snapWeeksByPfr.has(r.pfr_id)) snapWeeksByPfr.set(r.pfr_id, new Map());
    snapWeeksByPfr.get(r.pfr_id).set(Number(r.week), r.team);
    (teamsWithGame[r.week] = teamsWithGame[r.week] || new Set()).add(r.team);
  }
  const twg = {};
  for (const [w, s] of Object.entries(teamsWithGame)) twg[w] = [...s];
  const teamFor = (pfr, pid, w) => {
    const m = pfr && snapWeeksByPfr.get(pfr);
    if (m) {
      if (m.has(w)) return m.get(w);
      const prior = [...m.keys()].filter((x) => x < w), later = [...m.keys()].filter((x) => x > w);
      if (prior.length) return m.get(Math.max(...prior));
      if (later.length) return m.get(Math.min(...later));
    }
    return curTeam.get(pid) || null;
  };
  const ups = new Map(), groupOf = new Map();
  for (const r of sw) {
    const pid = String(parseInt(r.player_id, 10));
    const g = GROUP_OF[String(r.pos_group || "").toUpperCase()];
    if (!g) continue;
    groupOf.set(pid, g);
    ups.set(pid + "|" + r.week, r);
  }
  const rows = [];
  for (const [pid, g] of groupOf) {
    const pfr = ids.get(pid) || null;
    for (const w of finalWeeks) {
      const u = ups.get(pid + "|" + w);
      const sn = pfr ? snapAt.get(w + "|" + pfr) : null;
      rows.push({
        mfl_id: pid, week: w, group: g,
        started: !!(u && u.status === "starter"),
        rostered: !!(u && (u.status === "starter" || u.status === "nonstarter")),
        snaps_total: sn ? Number(sn.tot) : null,
        snap_source: !!(pfr && snapWeeksByPfr.has(pfr)),
        mfl_score: u && u.score != null ? Number(u.score) : null,
        nfl_team: teamFor(pfr, pid, w),
      });
    }
  }
  const out = computeStarterRates(rows, { final_weeks: finalWeeks, teams_with_game: twg, bye_week: byeWeek || {} });
  out.final_weeks = finalWeeks;
  out.pending_weeks = pendingWeeks;
  out.bye_list = byeWeek ? "mfl" : "unavailable";
  out.unmapped_snaps = [...groupOf.keys()].filter((pid) => !ids.has(pid)).length;
  return out;
}

/** MFL's NFL bye list as {nflverse team: week}; null when MFL can't be read
 * (then a team without a game reads "no game", never a guessed bye). */
export async function fetchMflByeWeeks(season, fetchImpl = fetch) {
  try {
    const r = await fetchImpl(`https://api.myfantasyleague.com/${encodeURIComponent(season)}/export?TYPE=nflByeWeeks&JSON=1`,
      { headers: { "User-Agent": "upsmflproduction-worker" } });
    if (!r.ok) return null;
    const j = await r.json();
    const m = {};
    for (const tm of [].concat((j && j.nflByeWeeks && j.nflByeWeeks.team) || [])) {
      const k = normTeam(tm && tm.id), w = parseInt(tm && tm.bye_week, 10);
      if (k && w) m[k] = w;
    }
    return Object.keys(m).length ? m : null;
  } catch (_) { return null; }
}
