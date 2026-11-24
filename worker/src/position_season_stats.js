// GET /api/position-season-stats?season=YYYY&through=W&group=QB|RB|WR|TE|PK|PN|DL|LB|DB  (r6 draft, read-only)
//
// One shared, edge-cached, league-wide season aggregate per MFL position group, so the phone can rank a
// player's season stats against his position without reading every competitor's game log. Per player:
// the SUM of each additive count over REG weeks 1..through (rates and shares are left to the caller and
// come from these aggregate numerators and denominators, never from weekly rates), the team denominators
// over the games he played (team targets / carries / receptions / receiving air yards from the box rows,
// team offensive / defensive snaps the way ./team_snaps_season.js estimates them), and per-field
// coverage where a field was missing in some of his weeks. Ranks are NOT computed here: tie, direction and
// rate-minimum rules are the caller's (and rate minimums are not approved), and a rank pool is exactly the
// `players` list returned for the group.
//
// Pool: players with an ACCEPTED player_id_map row (gsis '00-…') whose mfl_position falls in the group
// (DE/DT = DL, CB/S = DB) and at least one box row in the window. Box rows whose gsis has no accepted map
// row are counted in `unmapped_box_players`, never guessed by name or team.
//
// Missing is not zero: a field's sum is null when every one of his weeks is null; `cov[field]` = weeks
// with a value, given only when it is fewer than his box weeks. An absent _ext row contributes nothing
// (not a zero) to the ext sums; their cov says how many weeks had one.
//
// Box week (a game): an nfl_player_weekly row with team IS NOT NULL. Only the nflverse weekly writer sets
// team (with opponent, position, pos_group); the rows the PFR advanced-stats upsert INSERTs
// (fetch_pfr_advstats.py _dual_write_d1) leave all four NULL. `source` cannot prove it: its column DEFAULT
// is 'nflverse' (migration 0006), so those PFR rows read 'nflverse' too. A team-less row is not a game: it
// adds nothing to games, sums, cov or team totals, and his ext / red-zone rows for that week are not read;
// a player with only such rows is not in the pool. A team-set row whose stats are all 0 IS an appearance
// (the nflverse writer fills 0, not NULL): a game with 0 values and complete coverage.
// Two narrow PBP exceptions, for the MFL group only: a PN row with `punts` and a PK row with an FG distance
// bucket. fetch_nflverse_pbp.py's D1 writes are upserts (D1Writer INSERT … ON CONFLICT): FG :556 and punts
// :619 (local stub INSERT :604) can create a team-less row for a kicker / punter whose nflverse row is
// missing (e.g. the nflverse_weekly step failed before nflverse_pbp ran), and a PBP kick or punt by him
// is direct evidence that he played. Production D1 had none in 2012-2026 (2026-11-23). Excluded rows are
// counted in `non_box_rows`.
//
// Red zone: an absent nfl_player_redzone row is ZERO only for a box week whose (week, team) has the PBP
// load marker nfl_team_weekly.rz_pass_att IS NOT NULL: the same fetch_nflverse_pbp.py run writes that team
// total (0 included) for every team-game it loaded, after the player rows (migration 0169), and creates a
// player row for anyone with a carry, dropback or target anywhere on the field. Without the marker the
// week stays missing (partial cov). `rz_proven_team_weeks` = marked (week, team) pairs; null when that
// read failed (then nothing is zero-filled).
//
// Cost per cache fill (all nine groups at once; each group is stored under its own key):
//   nfl_player_weekly, nfl_player_weekly_ext, nfl_player_redzone, nfl_player_snaps: one primary-key
//   range search each, (season, week 1..through): about one row per player-week of the season
//   (10,589 box rows for 2026 Weeks 1-10, measured 2026-11-23), plus a scan of player_id_map (2,295 rows).
//   Roughly 30-45k rows per fill at Week 10 (ext / red-zone / snap row counts not measured).
//   nfl_team_weekly (rz marker): primary-key range (season, week 1..through), about 32 rows per week
//   (~300 at Week 10; estimated, unmeasured).
//   A cache hit reads 4 rows (etl_runs stamps). Fills: one per data center per (season, through)
//   per stamp change, at most one per POSITION_STATS_TTL_S otherwise.

export const POSITION_STATS_TTL_S = 21600;
const QUERY_VERSION = "3";

export const POSITION_GROUPS = ["QB", "RB", "WR", "TE", "PK", "PN", "DL", "LB", "DB"];
const GROUP_OF = { QB: "QB", RB: "RB", WR: "WR", TE: "TE", PK: "PK", PN: "PN", DE: "DL", DT: "DL", LB: "LB", CB: "DB", S: "DB" };

const PASS = ["pass_att", "pass_cmp", "pass_yds", "pass_tds", "pass_ints", "pass_sacks", "pass_sack_yds", "passing_air_yards", "passing_times_pressured"];
const RUSH = ["rush_att", "rush_yds", "rush_tds", "rush_fumbles_lost"];
const REC = ["targets", "receptions", "rec_yds", "rec_tds", "rec_fumbles_lost", "receiving_air_yards"];
const IDP = ["def_tackles_solo", "def_tackles_ast", "def_tackles_total", "def_tfl", "def_qb_hits", "def_sacks", "def_sack_yds", "def_ff",
  "def_fr", "def_ints", "def_pass_def", "def_tds", "def_pressures", "def_completions_allowed", "def_yards_allowed"];
const KICK = ["fg_att", "fg_made", "fg_att_0_39", "fg_made_0_39", "fg_att_40_49", "fg_made_40_49", "fg_att_50_59", "fg_made_50_59",
  "fg_att_60plus", "fg_made_60plus", "xp_att", "xp_made", "fg_distance_sum_made"];
const PUNT = ["punts", "punt_yds", "punt_inside20", "punt_tb", "punt_net_yds_sum", "punt_inside5", "punt_inside10", "punt_inside15", "punt_inside20_pbp"];
const BOX_COLS = [...new Set([...PASS, ...RUSH, ...REC, ...IDP, ...KICK, ...PUNT])];
const EXT_COLS = ["pass_first_downs", "rush_first_downs", "rec_first_downs", "def_tackles_with_assist", "def_targets"];
const RZ_COLS = ["targets_i20", "targets_i10", "targets_i5", "targets_ez", "rec_i20", "rec_tds_i20", "rush_att_i20", "rush_att_i10",
  "rush_att_i5", "rush_tds_i20", "pass_att_i20", "pass_cmp_i20", "pass_tds_i20", "pass_att_ez"];

// Every counter fetch_nflverse_pbp.py rz_bucket() initializes to 0 (0007 + 0169): a proven-zero week is 0 in each.
export const PLAYER_RZ_COUNT_COLS = ["rush_att_i20", "rush_att_i10", "rush_att_i5", "rush_yds_i20", "rush_tds_i20", "targets_i20", "targets_i10",
  "targets_i5", "targets_ez", "rec_i20", "rec_tds_i20", "pass_att_i20", "pass_tds_i20", "pass_att_ez", "pass_cmp_i20", "sacks_i20"];

// Red-zone coverage basis while proof comes from the nfl_team_weekly marker (PR #1500 design: "inferred").
export const RZ_BASIS = "inferred";
export const RZ_MARKER_SOURCE = "nfl_team_weekly.rz_pass_att";

const OFF = { box: [...PASS, ...RUSH, ...REC], ext: ["pass_first_downs", "rush_first_downs", "rec_first_downs"], rz: RZ_COLS };
const FIELDS = {
  QB: OFF, RB: OFF, WR: OFF, TE: OFF,
  PK: { box: KICK, ext: [], rz: [] },
  PN: { box: PUNT, ext: [], rz: [] },
  DL: { box: IDP, ext: ["def_tackles_with_assist", "def_targets"], rz: [] },
  LB: { box: IDP, ext: ["def_tackles_with_assist", "def_targets"], rz: [] },
  DB: { box: IDP, ext: ["def_tackles_with_assist", "def_targets"], rz: [] },
};

const FG_PBP = ["fg_att_0_39", "fg_att_40_49", "fg_att_50_59", "fg_att_60plus"];

// Which writer's evidence a box row carries (see the header): "nflverse", "pbp_punt", "pbp_fg" or "other".
export function rowKind(r) {
  if (r.team != null) return "nflverse";
  if (r.punts != null) return "pbp_punt";
  if (FG_PBP.some((c) => r[c] != null)) return "pbp_fg";
  return "other";
}
const isBoxWeek = (kind, group) => kind === "nflverse" || (group === "PN" && kind === "pbp_punt") || (group === "PK" && kind === "pbp_fg");

export const SQL = {
  box: "SELECT gsis_id, week, team, " + BOX_COLS.join(", ") + " FROM nfl_player_weekly WHERE season = ? AND week BETWEEN 1 AND ?",
  ext: "SELECT gsis_id, week, " + EXT_COLS.join(", ") + " FROM nfl_player_weekly_ext WHERE season = ? AND week BETWEEN 1 AND ?",
  rz: "SELECT gsis_id, week, " + RZ_COLS.join(", ") + " FROM nfl_player_redzone WHERE season = ? AND week BETWEEN 1 AND ?",
  snaps: "SELECT pfr_id, week, team, off_snaps, off_snap_pct, def_snaps, def_snap_pct, st_snaps FROM nfl_player_snaps WHERE season = ? AND week BETWEEN 1 AND ?",
  map: "SELECT mfl_id, gsis_id, pfr_id, mfl_position FROM player_id_map WHERE accepted = 1",
  rzMarks: "SELECT week, team FROM nfl_team_weekly WHERE season = ? AND week BETWEEN 1 AND ? AND rz_pass_att IS NOT NULL",
  stamps: "SELECT source, last_run_utc FROM etl_runs WHERE source IN ('nflverse_weekly', 'nflverse_snaps', 'nflverse_pbp', 'pfr_advstats')",
};

const num = (v) => (v == null ? null : Number(v));
function addInto(acc, cov, cols, row) {
  for (const c of cols) {
    const v = num(row[c]);
    if (v == null || !Number.isFinite(v)) continue;
    acc[c] = (acc[c] == null ? 0 : acc[c]) + v;
    cov[c] = (cov[c] || 0) + 1;
  }
}

// Pure: the nine group payloads from the result sets (exported for tests). rzMarks: the nfl_team_weekly
// marker rows, or null when that read failed (then no red-zone week is zero-filled).
export function buildGroups({ box, ext, rz, snaps, map, rzMarks = null }, season, through) {
  const byGsis = {}, pfrToGsis = {}, unmappedBox = new Set();
  for (const m of map || []) {
    const g = GROUP_OF[String(m.mfl_position || "").toUpperCase()];
    if (!m.gsis_id || !/^00-/.test(m.gsis_id) || !g) continue;
    if (byGsis[m.gsis_id]) { byGsis[m.gsis_id].ambiguous = true; continue; }   // one gsis on two MFL ids: excluded below
    byGsis[m.gsis_id] = { mfl_id: String(m.mfl_id), group: g, pfr: m.pfr_id || null };
    if (m.pfr_id) pfrToGsis[m.pfr_id] = m.gsis_id;
  }
  // team-week totals from every nflverse box row of the window (all positions), and team snaps from every snap row
  const team = {};
  for (const r of box || []) {
    if (r.team == null) continue;   // = rowKind(r) === "nflverse"
    const k = r.week + "|" + r.team, t = (team[k] = team[k] || {});
    for (const [out, c] of [["team_targets", "targets"], ["team_rush_att", "rush_att"], ["team_receptions", "receptions"], ["team_rec_air_yards", "receiving_air_yards"]]) {
      const v = num(r[c]); if (v != null) t[out] = (t[out] || 0) + v;
    }
  }
  const tsn = {};
  for (const s of snaps || []) {
    if (s.team == null) continue;
    const k = s.week + "|" + s.team, t = (tsn[k] = tsn[k] || { mo: null, mop: null, md: null, mdp: null });
    if (s.off_snaps != null) t.mo = Math.max(t.mo == null ? -Infinity : t.mo, s.off_snaps);
    if (s.off_snaps > 0 && s.off_snap_pct != null) t.mop = Math.max(t.mop == null ? -Infinity : t.mop, s.off_snap_pct);
    if (s.def_snaps != null) t.md = Math.max(t.md == null ? -Infinity : t.md, s.def_snaps);
    if (s.def_snaps > 0 && s.def_snap_pct != null) t.mdp = Math.max(t.mdp == null ? -Infinity : t.mdp, s.def_snap_pct);
  }
  const teamSnap = (k, which) => { const t = tsn[k]; if (!t) return null;
    const [m, p] = which === "off" ? [t.mo, t.mop] : [t.md, t.mdp];
    return m == null || !p ? null : Math.round(m / p); };

  const players = {};
  const P = (gsis) => {
    const id = byGsis[gsis];
    if (!id || id.ambiguous) return null;
    return (players[gsis] = players[gsis] || { mfl_id: id.mfl_id, gsis_id: gsis, group: id.group, games: 0, snap_games: 0, s: {}, cov: {}, last_week: 0, weeks: new Map() });
  };
  let maxWeek = 0, nonBox = 0;
  for (const r of box || []) {
    const kind = rowKind(r), id = byGsis[r.gsis_id];
    if (kind !== "other") maxWeek = Math.max(maxWeek, Number(r.week) || 0);
    if (!id) { if (kind !== "other") unmappedBox.add(r.gsis_id); continue; }
    if (!isBoxWeek(kind, id.group)) { nonBox += 1; continue; }   // e.g. a PFR-only row: not a game, not a zero
    const p = P(r.gsis_id);
    if (!p) continue;
    p.games += 1; p.last_week = Math.max(p.last_week, Number(r.week));
    p.weeks.set(Number(r.week), r.team != null ? r.team : null);
    addInto(p.s, p.cov, FIELDS[p.group].box, r);
    const t = r.team != null ? team[r.week + "|" + r.team] : null;
    addInto(p.s, p.cov, ["team_targets", "team_rush_att", "team_receptions", "team_rec_air_yards"], t || {});
  }
  // ext and red-zone rows count only in his box weeks
  const inBoxWeek = (r) => { const p = players[r.gsis_id]; return p && p.weeks.has(Number(r.week)) ? p : null; };
  for (const r of ext || []) { const p = inBoxWeek(r); if (p) addInto(p.s, p.cov, FIELDS[p.group].ext, r); }
  const rzSeen = new Set();
  for (const r of rz || []) {
    const p = inBoxWeek(r);
    if (!p) continue;
    rzSeen.add(r.gsis_id + "|" + Number(r.week));
    addInto(p.s, p.cov, FIELDS[p.group].rz, r);
  }
  // absent red-zone row in a box week whose team-game the PBP run provably loaded: zero for every field
  const marked = rzMarks ? new Set(rzMarks.filter((m) => m && m.team != null).map((m) => Number(m.week) + "|" + m.team)) : null;
  if (marked) {
    for (const p of Object.values(players)) {
      const cols = FIELDS[p.group].rz;
      if (!cols.length) continue;
      for (const [w, tm] of p.weeks) {
        if (tm == null || rzSeen.has(p.gsis_id + "|" + w) || !marked.has(w + "|" + tm)) continue;
        addInto(p.s, p.cov, cols, Object.fromEntries(cols.map((c) => [c, 0])));
      }
    }
  }
  for (const s of snaps || []) {
    const p = players[pfrToGsis[s.pfr_id]];
    if (!p) continue;
    p.snap_games += 1;
    addInto(p.s, p.cov, ["off_snaps", "def_snaps", "st_snaps"], s);
    if (s.team != null) {
      const k = s.week + "|" + s.team;
      addInto(p.s, p.cov, ["team_off_snaps", "team_def_snaps"], { team_off_snaps: teamSnap(k, "off"), team_def_snaps: teamSnap(k, "def") });
    }
  }
  const groups = {};
  for (const g of POSITION_GROUPS) groups[g] = { players: [] };
  for (const p of Object.values(players)) {
    const cov = {};
    // cov only where a field is missing in some of the weeks it is counted over
    for (const [f, n] of Object.entries(p.cov)) {
      const base = /_snaps$/.test(f) ? p.snap_games : p.games;
      if (n < base) cov[f] = n;
    }
    groups[p.group].players.push({ mfl_id: p.mfl_id, gsis_id: p.gsis_id, games: p.games, snap_games: p.snap_games, s: p.s, ...(Object.keys(cov).length ? { cov } : {}) });
  }
  for (const g of POSITION_GROUPS) {
    groups[g].players.sort((a, b) => (a.mfl_id < b.mfl_id ? -1 : 1));
    groups[g] = { ok: true, season, through, group: g, data_max_week: maxWeek || null, unmapped_box_players: unmappedBox.size,
      ambiguous_ids: Object.values(byGsis).filter((x) => x.ambiguous).length,
      non_box_rows: nonBox, rz_proven_team_weeks: marked ? marked.size : null,
      // How red-zone zeros were proven. "inferred" = from the nfl_team_weekly side-effect marker; becomes
      // "verified" once the PBP load record (PBP_LOAD_RECORD.md, PR #1500) exists. "unavailable" = the
      // marker or red-zone read failed, so nothing was zero-filled.
      rz_coverage: { basis: marked ? RZ_BASIS : "unavailable", source: RZ_MARKER_SOURCE, team_weeks: marked ? marked.size : null },
      fields: [...FIELDS[g].box, ...FIELDS[g].ext, ...FIELDS[g].rz], players: groups[g].players };
  }
  return groups;
}

async function stampKey(db) {
  try {
    const rows = ((await db.prepare(SQL.stamps).all()) || {}).results || [];
    const by = {};
    for (const r of rows) if (r && r.last_run_utc) by[r.source] = String(r.last_run_utc);
    return ["nflverse_weekly", "nflverse_snaps", "nflverse_pbp", "pfr_advstats"].map((s) => by[s] || "none").join("~");
  } catch (_) {
    return "none";
  }
}

// { status, body } for the route. cache = caches.default or null (then computed, not stored).
export async function positionSeasonStats(db, { season, through, group }, ctx, cache) {
  const v = await stampKey(db);
  const keyOf = (g) => new Request("https://upsmfl-stats.local/position-season-stats?" + new URLSearchParams({
    season: String(season), through: String(through), group: g, v, q: QUERY_VERSION }).toString(), { method: "GET" });
  if (cache) {
    try { const hit = await cache.match(keyOf(group)); if (hit) return { status: 200, body: await hit.json() }; } catch (_) { /* recompute */ }
  }
  const all = async (sql, ...args) => (((await db.prepare(sql).bind(...args).all()) || {}).results || []);
  // A failed red-zone read must not become zeros: then the markers are dropped too (all red-zone missing).
  let rzOk = true;
  const [box, ext, rz, snaps, map, marks] = await Promise.all([
    all(SQL.box, season, through),
    all(SQL.ext, season, through).catch(() => []),
    all(SQL.rz, season, through).catch(() => { rzOk = false; return []; }),
    all(SQL.snaps, season, through).catch(() => []),
    all(SQL.map),
    all(SQL.rzMarks, season, through).catch(() => null),
  ]);
  const groups = buildGroups({ box, ext, rz, snaps, map, rzMarks: rzOk ? marks : null }, season, through);
  if (cache) {
    const puts = POSITION_GROUPS.map((g) => cache.put(keyOf(g), new Response(JSON.stringify(groups[g]), {
      headers: { "content-type": "application/json", "Cache-Control": `public, max-age=${POSITION_STATS_TTL_S}` } })));
    const all2 = Promise.all(puts).catch(() => {});
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(all2); else await all2;
  }
  return { status: 200, body: groups[group] };
}
