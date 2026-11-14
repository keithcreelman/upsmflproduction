// UPS regular-season standings truth: the inputs seeding is allowed to read, and
// the division order MFL's standingsSort defines. Pure (no D1, no fetch) so the
// route, the tests and any offline proof run the same code.
//
// WHY (2026-10-17, Standings & League History review):
//   - Seeds are a REGULAR-SEASON ranking (canon §F.1). /api/standings seeded the
//     live season from src_standings totals, and the live sync folds every played
//     week into those totals, playoff weeks included -- so from Week 15 on the
//     seeds would move while the playoffs are being played. Here the totals are
//     rebuilt from the weekly rows, regular-season weeks only.
//   - Division winners follow MFL's year-specific standingsSort (§F.2). The route
//     skipped its H2H step and read PTS as a per-game AVERAGE; here H2H is the
//     record among the tied teams and PTS is season Points For.
//   - A playoff flag is trusted only when it is exactly regular (0, "0", false)
//     or playoff (1, "1", true). Anything else on a row that involves the
//     league's own franchises makes the table `incomplete`, never `preseason`
//     (the F3 ruling, applied at the source).

const pad4 = (v) => String(v == null ? "" : v).padStart(4, "0");
const pct = (w, l, t) => { const n = w + l + t; return n ? (w + 0.5 * t) / n : 0; };
const num = (v) => (v == null || v === "" ? NaN : Number(v));

// 0 = regular season, 1 = playoff, null = not a flag we recognize.
export function playoffFlag(v) {
  if (v === 0 || v === "0" || v === false) return 0;
  if (v === 1 || v === "1" || v === true) return 1;
  return null;
}

// Rebuild each franchise's regular-season record from weekly rows.
//   franchiseIds  -- the season's franchises (the "expected" set)
//   divisionOf    -- { fid: division id } (for divisional records)
//   weeklyScores  -- [{ week, franchise_id, team_score, is_playoff }] one row per franchise-week
//   games         -- [{ week, franchise_id, opponent_franchise_id, team_score, opponent_score, is_playoff }]
//                    each game once from each side (src_schedule's shape)
//   lastRegularSeasonWeek -- MFL's setting for the season (src_league_season_meta)
// Returns { status: "preseason" | "ok" | "incomplete", problems, weeks, throughWeek, teams }.
// teams[fid] = { ap, overall, div (each { w, l, t, pct }), pf, pa_total, games, weeks }.
export function regularSeasonTotals({ franchiseIds, divisionOf, weeklyScores, games, lastRegularSeasonWeek }) {
  const expected = new Set((franchiseIds || []).map(pad4));
  const lastReg = Number(lastRegularSeasonWeek);
  const problems = [];
  const flag = (v, where) => {
    const f = playoffFlag(v);
    if (f === null) problems.push({ code: "malformed_playoff_flag", value: v === undefined ? "missing" : v, ...where });
    return f;
  };
  if (!Array.isArray(weeklyScores) || !Array.isArray(games)) {
    problems.push({ code: "weekly_unreadable" });
    return { status: "incomplete", problems, weeks: [], throughWeek: null, teams: {} };
  }

  // Weekly scores of the expected franchises (foreign rows ignored entirely).
  const score = new Map();            // "week|fid" -> score, regular-season weeks only
  let relevant = 0;
  for (const r of weeklyScores) {
    const fid = pad4(r.franchise_id);
    if (!expected.has(fid)) continue;
    relevant++;
    const wk = num(r.week);
    const f = flag(r.is_playoff, { table: "weekly_scores", week: r.week, franchise_id: fid });
    if (f === null) continue;
    if (lastReg > 0 && f === 0 && wk > lastReg) problems.push({ code: "regular_flag_after_last_regular_week", week: wk, franchise_id: fid });
    if (lastReg > 0 && f === 1 && wk <= lastReg) problems.push({ code: "playoff_flag_in_regular_week", week: wk, franchise_id: fid });
    if (f !== 0) continue;
    const ts = num(r.team_score);
    if (!(ts >= 0)) { problems.push({ code: "missing_score", week: wk, franchise_id: fid }); continue; }
    const key = wk + "|" + fid;
    if (score.has(key) && score.get(key) !== ts) problems.push({ code: "conflicting_score", week: wk, franchise_id: fid });
    score.set(key, ts);
  }

  // Head-to-head rows that involve an expected franchise on either side.
  const regGames = [];
  for (const g of games) {
    const a = pad4(g.franchise_id), b = pad4(g.opponent_franchise_id);
    if (!expected.has(a) && !expected.has(b)) continue;
    relevant++;
    const wk = num(g.week);
    const f = flag(g.is_playoff, { table: "games", week: g.week, franchise_id: a, opponent_franchise_id: b });
    if (f === null) continue;
    if (lastReg > 0 && f === 0 && wk > lastReg) problems.push({ code: "regular_flag_after_last_regular_week", week: wk, franchise_id: a });
    if (lastReg > 0 && f === 1 && wk <= lastReg) problems.push({ code: "playoff_flag_in_regular_week", week: wk, franchise_id: a });
    if (f !== 0 || !expected.has(a)) continue;
    const ts = num(g.team_score), os = num(g.opponent_score);
    if (!(ts > 0) || !(os > 0)) continue;   // not played yet
    regGames.push({ week: wk, a, b, ts, os });
  }

  if (relevant === 0 && !problems.length) {
    return { status: "preseason", problems, weeks: [], throughWeek: null, teams: {} };
  }
  if (!(lastReg > 0)) problems.push({ code: "unknown_last_regular_week" });

  // Every regular week that has any score must have all expected franchises, and
  // every played game's week must have scores.
  const weeks = [...new Set([...score.keys()].map((k) => Number(k.split("|")[0])))].sort((x, y) => x - y);
  for (const wk of weeks) {
    for (const fid of expected) if (!score.has(wk + "|" + fid)) problems.push({ code: "missing_week_score", week: wk, franchise_id: fid });
  }
  for (const g of regGames) if (!weeks.includes(g.week)) problems.push({ code: "game_without_week_scores", week: g.week, franchise_id: g.a });
  // Weeks must run 1..N with no gap (a gap means a week failed to load).
  weeks.forEach((wk, i) => { if (wk !== i + 1) problems.push({ code: "week_gap", week: i + 1 }); });
  if (relevant > 0 && weeks.length === 0 && !problems.length) problems.push({ code: "no_regular_season_rows" });

  const teams = {};
  for (const fid of expected) teams[fid] = { ap: { w: 0, l: 0, t: 0 }, overall: { w: 0, l: 0, t: 0 }, div: { w: 0, l: 0, t: 0 }, pf: 0, pa_total: 0, games: 0, weeks: 0 };
  for (const wk of weeks) {
    const ids = [...expected].filter((f) => score.has(wk + "|" + f));
    for (const f of ids) {
      const s = score.get(wk + "|" + f);
      teams[f].pf += s; teams[f].weeks++;
      for (const o of ids) {
        if (o === f) continue;
        const so = score.get(wk + "|" + o);
        teams[f].ap[s > so ? "w" : s < so ? "l" : "t"]++;
      }
    }
  }
  for (const g of regGames) {
    const t = teams[g.a];
    const k = g.ts > g.os ? "w" : g.ts < g.os ? "l" : "t";
    t.overall[k]++; t.games++; t.pa_total += g.os;
    if (divisionOf && divisionOf[g.a] != null && divisionOf[g.a] === divisionOf[g.b]) t.div[k]++;
  }
  for (const t of Object.values(teams)) {
    for (const k of ["ap", "overall", "div"]) t[k].pct = pct(t[k].w, t[k].l, t[k].t);
    t.pf = Math.round(t.pf * 100) / 100;
    t.pa_total = Math.round(t.pa_total * 100) / 100;
  }
  return {
    status: problems.length ? "incomplete" : "ok",
    problems,
    weeks,
    throughWeek: weeks.length ? weeks[weeks.length - 1] : null,
    teams,
    games: regGames,
  };
}

// Record among a set of franchises, from regular-season games ({ a, b, ts, os }).
function recordAmong(ids, games) {
  const set = new Set(ids);
  const out = new Map(ids.map((f) => [f, { w: 0, l: 0, t: 0 }]));
  for (const g of games || []) {
    if (!set.has(g.a) || !set.has(g.b)) continue;
    out.get(g.a)[g.ts > g.os ? "w" : g.ts < g.os ? "l" : "t"]++;
  }
  return out;
}

const KEY = { pct: (v) => Math.round(Number(v || 0) * 1e6), pts: (v) => Math.round(Number(v || 0) * 10) };

// MFL standingsSort tokens this league uses (league export, 2010-2026):
//   PCT (overall win %), DIVPCT (division win %), H2H (record among the tied teams),
//   PTS (season points for), ALL_PLAY_PCT, PWR (MFL power rating; not served by the
//   export, so for the live season it cannot decide anything and is reported when
//   reached; a recorded season's stored pwr decides it when every tied row has one).
// rows: [{ franchise_id, franchise_name, overall_pct, div_pct, pf_total, allplay_pct, pwr? }]
// Returns { order: [rows best first], steps: [{ above, below, step }] } -- step names the
// token that separated each adjacent pair ("name" = the deterministic fallback, not a rule).
export function divisionOrder(rows, games, standingsSort) {
  const tokens = String(standingsSort || "PCT,DIVPCT,H2H,PTS,ALL_PLAY_PCT,PWR")
    .split(",").map((t) => t.trim().toUpperCase()).filter(Boolean);
  const value = (tok, group) => {
    if (tok === "PCT") return (r) => KEY.pct(r.overall_pct);
    if (tok === "DIVPCT") return (r) => KEY.pct(r.div_pct);
    if (tok === "PTS") return (r) => KEY.pts(r.pf_total);
    if (tok === "ALL_PLAY_PCT") return (r) => KEY.pct(r.allplay_pct);
    if (tok === "H2H") {
      const rec = recordAmong(group.map((r) => pad4(r.franchise_id)), games);
      return (r) => { const x = rec.get(pad4(r.franchise_id)); const n = x.w + x.l + x.t; return n ? KEY.pct(pct(x.w, x.l, x.t)) : KEY.pct(0.5); };
    }
    if (tok === "PWR" && group.every((r) => r.pwr != null && r.pwr !== "")) return (r) => KEY.pct(r.pwr);
    return null;   // PWR without stored values, or an unknown token
  };
  const decided = new Map();   // "above|below" -> step
  const sortGroup = (group, i) => {
    if (group.length < 2) return group;
    if (i >= tokens.length) {
      const out = group.slice().sort((x, y) => String(x.franchise_name || "").localeCompare(String(y.franchise_name || "")) || pad4(x.franchise_id).localeCompare(pad4(y.franchise_id)));
      for (let k = 0; k + 1 < out.length; k++) decided.set(pad4(out[k].franchise_id) + "|" + pad4(out[k + 1].franchise_id), tokens.includes("PWR") ? "name_after_pwr_unavailable" : "name");
      return out;
    }
    const f = value(tokens[i], group);
    if (!f) return sortGroup(group, i + 1);
    const sorted = group.slice().sort((x, y) => f(y) - f(x));
    const out = [];
    let run = [sorted[0]];
    const flush = () => { out.push(...sortGroup(run, i + 1)); };
    for (let k = 1; k < sorted.length; k++) {
      if (f(sorted[k]) === f(run[0])) { run.push(sorted[k]); continue; }
      flush();
      decided.set(pad4(out[out.length - 1].franchise_id) + "|" + pad4(sorted[k].franchise_id), tokens[i]);
      run = [sorted[k]];
    }
    flush();
    return out;
  };
  const order = sortGroup(rows.slice(), 0);
  const steps = [];
  for (let k = 0; k + 1 < order.length; k++) {
    const a = pad4(order[k].franchise_id), b = pad4(order[k + 1].franchise_id);
    steps.push({ above: a, below: b, step: decided.get(a + "|" + b) || null });
  }
  return { order, steps };
}

// Division order from STORED season rows (src_standings): what /api/standings and /api/playoff-bracket use for a
// recorded season (2010-2025). Same divisionOrder as the live season: PCT = overall win %, PTS = the stored season
// Points For (src_standings.pf), H2H = regular-season games among the tied teams, a tie when the season kept no game
// pairings. Before 2026-10-22 both routes skipped H2H and /api/standings read PTS as the AVERAGE of the src_schedule
// rows -- in 2010 those are playoff games only, which put the wrong team atop Division 00 (#1329, decision 5 C6+C9).
//   rows  -- [{ franchise_id, franchise_name, division, h2h_pct, div_pct, pf_total, allplay_pct, pwr }]
//   games -- src_schedule rows { franchise_id, opponent_franchise_id, team_score, opponent_score, is_playoff };
//            only rows flagged exactly regular season count.
// Returns Map franchise_id (4 digits) -> { division_rank, is_division_leader, step_vs_below }.
export function storedDivisionOrder(rows, games, standingsSort) {
  const reg = (games || []).filter((g) => playoffFlag(g.is_playoff) === 0).map((g) => ({
    a: pad4(g.franchise_id), b: pad4(g.opponent_franchise_id), ts: Number(g.team_score) || 0, os: Number(g.opponent_score) || 0,
  }));
  const out = new Map();
  const divs = [...new Set((rows || []).filter((r) => r.division != null).map((r) => String(r.division)))];
  for (const d of divs) {
    const group = rows.filter((r) => r.division != null && String(r.division) === d).map((r) => ({
      franchise_id: pad4(r.franchise_id), franchise_name: r.franchise_name,
      overall_pct: r.h2h_pct, div_pct: r.div_pct, pf_total: r.pf_total, allplay_pct: r.allplay_pct, pwr: r.pwr,
    }));
    const { order, steps } = divisionOrder(group, reg, standingsSort);
    order.forEach((r, i) => out.set(r.franchise_id, {
      division_rank: i + 1, is_division_leader: i === 0, step_vs_below: i < steps.length ? steps[i].step : null,
    }));
  }
  return out;
}

// The current season's whole field, computed once for every route that seeds it
// (/api/standings and /api/playoff-bracket), so the two can never disagree.
//   franchises -- [{ franchise_id, franchise_name, division }]
//   weeklyScores, games, lastRegularSeasonWeek -- as regularSeasonTotals
//   standingsSort -- MFL's chain for the season (division order)
//   ladder -- seeding.js { seedLadderSteps, modernField } (passed in to keep this module pure)
// Returns { status, problems, throughWeek, lastRegularSeasonWeek, complete, order, teams }.
// When status isn't "ok" there are NO seeds, no division leaders and no reasons:
// a table that can't be trusted is not ranked at all.
export function seedCurrentSeason({ franchises, weeklyScores, games, lastRegularSeasonWeek, standingsSort, ladder, history = true }) {
  const fr = (franchises || []).map((f) => ({ ...f, franchise_id: pad4(f.franchise_id) }));
  const divisionOf = Object.fromEntries(fr.map((f) => [f.franchise_id, f.division == null ? null : String(f.division)]));
  const tot = regularSeasonTotals({ franchiseIds: fr.map((f) => f.franchise_id), divisionOf, weeklyScores, games, lastRegularSeasonWeek });
  const lastReg = Number(lastRegularSeasonWeek) || null;
  const base = {
    status: tot.status, problems: tot.problems.slice(0, 25), problem_count: tot.problems.length,
    throughWeek: tot.throughWeek, lastRegularSeasonWeek: lastReg,
    complete: tot.status === "ok" && lastReg != null && tot.throughWeek === lastReg,
  };
  if (tot.status !== "ok") return { ...base, order: fr.map((f) => f.franchise_id), teams: {} };

  const rows = fr.map((f) => {
    const t = tot.teams[f.franchise_id];
    return {
      franchise_id: f.franchise_id, franchise_name: f.franchise_name, division: divisionOf[f.franchise_id],
      allplay_pct: t.ap.pct, h2h_pct: t.overall.pct, overall_pct: t.overall.pct, div_pct: t.div.pct, pf_total: t.pf,
    };
  });
  const teams = {};
  for (const r of rows) {
    const t = tot.teams[r.franchise_id];
    teams[r.franchise_id] = {
      regular_season: {
        all_play: t.ap, record: t.overall, division: t.div,
        points_for: t.pf, pf_per_week: t.weeks ? Math.round((t.pf / t.weeks) * 100) / 100 : null,
        pa_per_game: t.games ? Math.round((t.pa_total / t.games) * 100) / 100 : null,
        games: t.games, weeks: t.weeks,
      },
    };
  }

  // Division order (MFL standingsSort, H2H step included).
  const winners = new Set();
  const divs = [...new Set(rows.map((r) => r.division).filter((d) => d != null))];
  for (const d of divs) {
    const { order, steps } = divisionOrder(rows.filter((r) => r.division === d), tot.games, standingsSort);
    const lead = order[0];
    winners.add(lead.franchise_id);
    order.forEach((r, i) => {
      const t = teams[r.franchise_id];
      t.division_rank = i + 1;
      t.is_division_leader = i === 0;
      const rec = tot.teams[r.franchise_id].overall, lr = tot.teams[lead.franchise_id].overall;
      t.division_games_back = ((lr.w - rec.w) + (rec.l - lr.l)) / 2;
      const above = i > 0 ? steps[i - 1] : null;      // the step that put the team above it ahead of it
      const below = i < steps.length ? steps[i] : null;
      t.division_reason = {
        basis: "mfl_standings_sort", standings_sort: standingsSort || null,
        vs_above: above ? { franchise_id: above.above, step: above.step } : null,
        vs_below: below ? { franchise_id: below.below, step: below.step } : null,
      };
    });
  }

  // Seeds (§F.1 ladder on the regular-season values).
  const ladderGames = tot.games.map((g) => ({ franchise_id: g.a, opponent_franchise_id: g.b, team_score: g.ts, opponent_score: g.os }));
  const L = ladder.seedLadderSteps(rows, ladderGames);
  const f = ladder.modernField(rows, winners, L.cmp);
  const wc = new Set(f.wildCards.map((r) => r.franchise_id));
  f.byes.forEach((r, i) => Object.assign(teams[r.franchise_id], { playoff_seed: i + 1, playoff_status: "bye", is_wild_card: false }));
  f.seeds3to6.forEach((r, i) => Object.assign(teams[r.franchise_id], { playoff_seed: i + 3, playoff_status: wc.has(r.franchise_id) ? "wild_card" : "division_winner", is_wild_card: wc.has(r.franchise_id) }));
  f.outside.forEach((r) => Object.assign(teams[r.franchise_id], { playoff_seed: null, playoff_status: "non_playoff", is_wild_card: false }));

  // Why each team sits where it does (same steps the order used; pages never re-derive it).
  const seedOf = (r) => teams[r.franchise_id].playoff_seed;
  const reasonVs = (team, rival, pool) => ({
    basis: "ladder", pool, step: L.decidingStep(team, rival),
    position: L.cmp(team, rival) < 0 ? "ahead" : "behind",
    rival_franchise_id: rival.franchise_id, rival_name: rival.franchise_name || null,
    rival_seed: seedOf(rival) == null ? null : seedOf(rival),
  });
  // seed_reason compares with the next team in the pool (the last one: the one above); vs_above, when there is one,
  // names the step that kept the team BELOW its neighbor ("Why is CBP behind Real Deal Creel?").
  const ordered = [...f.byes, ...f.seeds3to6, ...f.outside];
  const poolReasons = (list, pool) => list.forEach((r, i) => {
    const rival = i < list.length - 1 ? list[i + 1] : list[i - 1];
    teams[r.franchise_id].seed_reason = rival ? reasonVs(r, rival, pool) : { basis: "ladder", pool, step: null };
  });
  // When the team above would LOSE the ladder comparison, the gap is structural: a bye needs a division title, and a
  // division winner is in the field ahead of a better non-winner.
  const addAbove = () => ordered.forEach((r, i) => {
    if (i === 0) return;
    const up = ordered[i - 1];
    const upSeed = teams[up.franchise_id].playoff_seed;
    let step = L.decidingStep(up, r);
    if (L.cmp(up, r) > 0) step = upSeed != null && upSeed <= 2 ? "bye_requires_division_title" : "division_winner_in_field";
    teams[r.franchise_id].seed_reason.vs_above = { franchise_id: up.franchise_id, name: up.franchise_name || null, step };
  });
  poolReasons(f.byes, "bye");
  poolReasons(f.seeds3to6, "seeds3to6");
  const cut = f.wildCards.length ? f.wildCards[f.wildCards.length - 1] : null;   // the last wild card in the field
  f.outside.forEach((r) => { teams[r.franchise_id].seed_reason = cut ? reasonVs(r, cut, "outside") : { basis: "ladder", pool: "outside", step: null }; });
  addAbove();

  // ap_back ("WC Back"): All-Play wins behind the LAST WILD CARD (ties count half), the race a team outside the field
  // is actually in. The four division winners are protected (a better All-Play record never takes a division winner's
  // place), so the 6th seed is the wrong yardstick whenever it is a division winner: 2026 Week 6 measured Hawks against
  // Real Deal Creel and showed -1 (#1329). Seeds 1-6 are null; no wild card, null. Every team outside is a non-winner
  // the ladder put behind the wild cards, so the figure is never negative.
  const apWins = (fid) => tot.teams[fid].ap.w + 0.5 * tot.teams[fid].ap.t;
  for (const r of rows) {
    const t = teams[r.franchise_id];
    t.ap_back = t.playoff_seed == null && cut ? Math.round((apWins(cut.franchise_id) - apWins(r.franchise_id)) * 10) / 10 : null;
  }
  const order = [...f.byes, ...f.seeds3to6, ...f.outside].map((r) => r.franchise_id);   // outside is already in ladder order
  order.forEach((fid, i) => { teams[fid].order_index = i; });
  // Seed order after every completed week (same computation on weeks 1..k), for "moved up since last week"
  // and the Trends chart. Pages never recompute it.
  let seedByWeek = null;
  if (history && tot.weeks.length) {
    seedByWeek = {};
    for (const k of tot.weeks) {
      if (k === tot.throughWeek) { seedByWeek[k] = order; continue; }
      const past = seedCurrentSeason({
        franchises, standingsSort, ladder, lastRegularSeasonWeek, history: false,
        weeklyScores: weeklyScores.filter((r) => Number(r.week) <= k),
        games: games.filter((g) => Number(g.week) <= k),
      });
      seedByWeek[k] = past.status === "ok" ? past.order : null;
    }
    const prev = tot.weeks.length > 1 ? seedByWeek[tot.weeks[tot.weeks.length - 2]] : null;
    for (const fid of order) {
      const t = teams[fid];
      t.prior_order_index = prev ? prev.indexOf(fid) : null;
      // positive = moved up the order since the previous week
      t.order_change = prev ? prev.indexOf(fid) - t.order_index : null;
    }
  }
  return { ...base, order, teams, seed_by_week: seedByWeek, next_out: f.outside.length ? f.outside[0].franchise_id : null };
}
