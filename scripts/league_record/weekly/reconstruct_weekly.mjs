// League Record: local, read-only reconstruction of historical weekly attribution from MFL's original weekly results (issue #1488).
//
// Source of truth: `weeklyresults` in the league archive (MFL's own weeklyResults export: one row per player, franchise and week, with starter/non-starter status and score). The derived tables
// built from it (`player_weeklyscoringresults`, `weekly_player_scores`, `player_pointssummary`) lose the franchise and status for 2012-2019; this module does not use them as a source, only as a
// comparison. Nothing is fetched, nothing is written to any database. A row that does not exist stays missing: no week, player or score is ever filled with zero or copied from a neighbor.
//
// Every figure is checked against an independent table of the same archive:
//   (a) the starters' scores add up to the team score of the same rows;
//   (b) that team score equals the franchise's score in `weeklyresults_summary`;
//   (c) each player's score equals MFL's per-player score in `playerscores_weekly`;
//   (d) all-play wins recomputed from the team scores equal `weeklyresults_summary` (and the committed fixture tests/fixtures/weekly_allplay_2010_2025.json).
// Defects found in the original rows (contaminated franchise-weeks, a week that duplicates another, missing weeks, playoff weeks without bye franchises) are reported, not repaired.

export const REGULAR_SEASON_LAST_WEEK = (season) => (season >= 2021 ? 14 : 13);      // canon schedule, as in the committed all-play fixture
const near = (a, b) => a != null && b != null && Math.abs(a - b) < 0.011;
const r2 = (x) => Math.round(x * 100) / 100;

export function reconstructWeekly(db) {
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const seasons = all("select distinct season s from weeklyresults order by 1").map((r) => r.s);
  const leagueSize = new Map(all("select season s, count(distinct franchise_id) n from weeklyresults_summary group by 1").map((r) => [r.s, r.n]));
  const summary = new Map(all("select season, week, franchise_id f, h2h_team_score sc, allplay_wins aw, allplay_games ag, h2h_opponent1_id o1 from weeklyresults_summary").map((r) => [`${r.season}:${r.week}:${r.f}`, r]));
  const sched = new Map(all("select season, week, franchise_id f, team_score sc, opponent_franchise_id o from schedule").map((r) => [`${r.season}:${r.week}:${r.f}`, r]));
  const psw = new Map(all("select season, week, cast(player_id as text) p, score from playerscores_weekly").map((r) => [`${r.season}:${r.week}:${String(r.p)}`, r.score]));
  const out = { seasons: {}, defects: [] };

  for (const y of seasons) {
    const rows = all("select week, franchise_id f, player_id p, status, player_score ps, team_score ts, is_playoff pl from weeklyresults where season = ? order by week, f, p", y);
    const weeks = [...new Set(rows.map((r) => r.week))].sort((a, b) => a - b);
    const lastSummaryWeek = Math.max(...all("select week from weeklyresults_summary where season = ?", y).map((r) => r.week), 0);
    const S = { league_size: leagueSize.get(y) || null, weeks_present: weeks, weeks_missing: [], player_rows: rows.length, starter_rows: 0, bench_rows: 0, franchise_weeks: 0,
      starter_sum_equals_team_score: 0, team_score_equals_summary: 0, franchise_weeks_with_summary: 0, player_score_equals_mfl: 0, player_rows_with_mfl_score: 0, player_rows_zero_without_mfl_row: 0,
      allplay_recomputed_equals_summary: 0, allplay_compared: 0, contaminated_franchise_weeks: 0, contaminated_rows: 0, duplicate_of_next_week: [], playoff_weeks: [], players_on_two_franchises_same_week: 0 };
    for (let w = 1; w <= lastSummaryWeek; w++) if (!weeks.includes(w)) S.weeks_missing.push(w);
    for (const w of S.weeks_missing) {
      const inSummary = [...summary.keys()].filter((k) => k.startsWith(`${y}:${w}:`)).length, inSchedule = [...sched.keys()].filter((k) => k.startsWith(`${y}:${w}:`)).length;
      out.defects.push({ season: y, week: w, kind: "week_missing_from_weekly_results", summary_franchise_rows: inSummary, schedule_franchise_rows: inSchedule });
    }
    const byFw = new Map();
    for (const r of rows) {
      const k = `${r.week}:${r.f}`;
      if (!byFw.has(k)) byFw.set(k, []);
      byFw.get(k).push(r);
      if (r.status === "starter") S.starter_rows += 1; else S.bench_rows += 1;
      const m = psw.get(`${y}:${r.week}:${String(r.p)}`);
      if (m != null) { S.player_rows_with_mfl_score += 1; if (near(m, r.ps)) S.player_score_equals_mfl += 1; }
      else if (r.ps === 0) S.player_rows_zero_without_mfl_row += 1;                                  // MFL's per-player table leaves out zero-point rows
    }
    // a player listed on two franchises in the same week is a contamination signal
    const seen = new Map();
    for (const r of rows) { const k = `${r.week}:${r.p}`; seen.set(k, (seen.get(k) || new Set()).add(r.f)); }
    S.players_on_two_franchises_same_week = [...seen.values()].filter((s) => s.size > 1).length;
    const teamScoreByWeek = new Map();
    for (const [k, rs] of byFw) {
      const [w, f] = k.split(":"); const week = Number(w);
      S.franchise_weeks += 1;
      const groups = [...new Set(rs.map((r) => r2(r.ts)))];
      const sm = summary.get(`${y}:${week}:${f}`);
      // several team-score groups in one franchise-week: keep the group that is SELF-CONSISTENT (its starters add up to its own team score). The summary table cannot arbitrate,
      // because it is contaminated for some of the same franchise-weeks; whether it agrees is reported, not used.
      let keep = groups[0];
      if (groups.length > 1) {
        S.contaminated_franchise_weeks += 1;
        const consistent = groups.filter((g) => near(r2(rs.filter((r) => near(r2(r.ts), g) && r.status === "starter").reduce((a, r) => a + (r.ps || 0), 0)), g));
        keep = consistent.length === 1 ? consistent[0] : null;
        const bad = rs.filter((r) => keep == null || !near(r2(r.ts), keep)).length;
        S.contaminated_rows += bad;
        out.defects.push({ season: y, week, franchise: f, kind: "franchise_week_has_several_team_scores", team_score_groups: groups.length, rows_set_aside: bad, self_consistent_group_identified: keep != null, summary_agrees_with_kept_group: keep != null && !!sm && near(keep, sm.sc) });
      }
      const ts = keep != null ? keep : groups[0];
      const starters = rs.filter((r) => r.status === "starter" && (groups.length === 1 || near(r2(r.ts), ts)));   // only the kept group's starters
      const sum = r2(starters.reduce((a, r) => a + (r.ps || 0), 0));
      if (near(sum, ts)) S.starter_sum_equals_team_score += 1;
      if (sm) { S.franchise_weeks_with_summary += 1; if (near(ts, sm.sc)) S.team_score_equals_summary += 1; }
      if (!teamScoreByWeek.has(week)) teamScoreByWeek.set(week, new Map());
      teamScoreByWeek.get(week).set(f, ts);
    }
    // all-play: wins against every other franchise's score that week (regular season only), compared with the summary
    for (const [week, m] of teamScoreByWeek) {
      if (week > REGULAR_SEASON_LAST_WEEK(y)) continue;
      for (const [f, sc] of m) {
        const sm = summary.get(`${y}:${week}:${f}`); if (!sm || sm.aw == null) continue;
        const wins = [...m.entries()].filter(([g, s]) => g !== f && s < sc - 1e-9).length;
        S.allplay_compared += 1; if (wins === sm.aw) S.allplay_recomputed_equals_summary += 1;
      }
    }
    // a week whose rows are identical to the next week's rows
    const sig = (w) => rows.filter((r) => r.week === w).map((r) => `${r.f}|${r.p}|${r.status}|${r2(r.ps)}`).sort().join("\n");
    for (let i = 0; i + 1 < weeks.length; i++) if (weeks[i + 1] === weeks[i] + 1 && sig(weeks[i]) && sig(weeks[i]) === sig(weeks[i + 1])) { S.duplicate_of_next_week.push(weeks[i]); out.defects.push({ season: y, week: weeks[i], kind: "week_rows_identical_to_next_week", next_week: weeks[i + 1] }); }
    // playoff weeks: franchises present versus the league size (bye franchises are absent from MFL's export unless requested)
    for (const w of weeks.filter((x) => x > REGULAR_SEASON_LAST_WEEK(y))) {
      const n = new Set(rows.filter((r) => r.week === w).map((r) => r.f)).size;
      S.playoff_weeks.push({ week: w, franchises: n, flagged_playoff: rows.some((r) => r.week === w && r.pl === 1) });
      if (S.league_size && n < S.league_size) out.defects.push({ season: y, week: w, kind: "playoff_week_missing_franchises", franchises: n, league_size: S.league_size });
      if (!rows.some((r) => r.week === w && r.pl === 1)) out.defects.push({ season: y, week: w, kind: "playoff_week_not_flagged" });
    }
    // regular-season opponent pairings: does any table name the opponent for each regular-season franchise-week?
    let paired = 0, regular = 0;
    for (const [k] of byFw) { const [w, f] = k.split(":"); if (Number(w) > REGULAR_SEASON_LAST_WEEK(y)) continue; regular += 1; const sm = summary.get(`${y}:${w}:${f}`), sc = sched.get(`${y}:${w}:${f}`); if ((sm && sm.o1) || (sc && sc.o)) paired += 1; }
    S.regular_season_franchise_weeks = regular; S.regular_season_with_opponent = paired;
    // what the derived table keeps for the same season (comparison only)
    S.derived_rows_with_franchise = all("select count(*) n from player_weeklyscoringresults where season = ? and status in ('starter','nonstarter') and roster_franchise_id is not null and roster_franchise_id not in ('', 'FA')", y)[0].n;   // the derived table writes the literal 'FA' as the franchise when it lost the attribution
    out.seasons[y] = S;
  }
  return out;
}

// All-play from the committed fixture, compared with the reconstruction's team scores (regular season only).
export function compareAllPlayFixture(db, fixture) {
  const res = {};
  for (const [y, byF] of Object.entries(fixture.weeks)) {
    const season = Number(y); let n = 0, eq = 0, pfEq = 0;
    const ts = new Map(db.prepare("select week, franchise_id f, max(team_score) ts from weeklyresults where season = ? group by 1, 2").all(season).map((r) => [`${r.week}:${r.f}`, r.ts]));
    for (const [f, list] of Object.entries(byF)) for (const [week, wins, games, pf] of list) {
      const t = ts.get(`${week}:${f}`); if (t == null) continue; n += 1;
      if (near(t, pf)) pfEq += 1;
      const others = [...ts.entries()].filter(([k]) => k.startsWith(`${week}:`) && !k.endsWith(`:${f}`)).map(([, v]) => v);
      if (others.filter((v) => v < t - 1e-9).length === wins) eq += 1;
    }
    res[y] = { compared: n, points_for_equal: pfEq, allplay_wins_equal: eq };
  }
  return res;
}

// Weeks the primary source lacks, checked in a SECOND database (for example a newer local ETL copy). Report only: nothing is merged. For each candidate week it says how many franchise-weeks
// the second source has and whether each is self-consistent (starters add up to the team score), so a later, approved load can cite it.
export function compareSecondSource(primary, second, seasonWeeks) {
  const out = [];
  for (const [season, weeks] of seasonWeeks) for (const week of weeks) {
    const g = second.prepare("select franchise_id f, team_score ts, round(sum(case when status = 'starter' then player_score else 0 end), 2) ss, count(*) n from weeklyresults where season = ? and week = ? group by 1, 2").all(season, week);
    const p = primary.prepare("select count(*) n from weeklyresults where season = ? and week = ?").get(season, week).n;
    out.push({ season, week, primary_rows: p, second_rows: g.reduce((a, r) => a + r.n, 0), second_franchise_weeks: g.length, second_self_consistent: g.filter((r) => near(r.ss, r.ts)).length });
  }
  return out;
}
