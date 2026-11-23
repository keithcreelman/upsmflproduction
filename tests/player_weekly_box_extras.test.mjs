// r6 draft Worker reads (read-only), offline:
//   node tests/player_weekly_box_extras.test.mjs
//   • /api/player-weekly-box gains per-week `ext` (first downs, tackles with an assist, coverage targets) and
//     `team_totals` (his team's box totals that game, for shares); every existing field is unchanged
//   • team totals: one season table at the edge keyed on the nflverse_weekly / pfr_advstats stamps, else the
//     per-player join; both equal a direct SUM; missing stays null; the club is the box row's club (trade)
//   • /api/player-projections: primary-key reads, capture times, null for no row
//   • /api/position-season-stats: one fill builds all nine groups; sums, team denominators, coverage, pool
//   • every new SQL is checked with EXPLAIN QUERY PLAN on the production DDL fixture (+ migration-built ext)
// In-memory D1, fake edge cache, every outbound fetch refused.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeD1 } from "./fixtures/d1_sqlite.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA = fs.readFileSync(path.join(ROOT, "tests/fixtures/player_weekly_box_schema.sql"), "utf8")
  + fs.readFileSync(path.join(ROOT, "tests/fixtures/player_weekly_box_extras_schema.sql"), "utf8");
const SRC = fs.readFileSync(path.join(ROOT, "worker/src/index.js"), "utf8");
await import("./fixtures/register_md_loader.mjs");
const worker = (await import("../worker/src/index.js")).default;
const TT = await import("../worker/src/team_totals_season.js");
const PS = await import("../worker/src/position_season_stats.js");
const net = [];
globalThis.fetch = async (u) => { net.push(String(u && u.url || u)); return new Response("offline", { status: 503 }); };

// [mfl, gsis, pfr, mfl_position]
const P = { qb: ["2001", "00-0000101", "QbAa00", "QB"], wr: ["2002", "00-0000102", "WrBb00", "WR"], wr2: ["2003", "00-0000103", "WrCc00", "WR"],
  rb: ["2004", "00-0000104", "RbDd00", "RB"], lb: ["2005", "00-0000105", "LbEe00", "LB"], cb: ["2006", "00-0000106", "CbFf00", "CB"] };
// box: season, week, gsis, team, pass_att, pass_sacks, targets, receptions, rush_att, rec_air, pass_air, solo, ast, total
const BOX = [
  [2026, 1, P.qb[1], "BUF", 30, 2, null, null, 3, null, 250, null, null, null],
  [2026, 1, P.wr[1], "BUF", null, null, 9, 6, null, 90, null, null, null, null],
  [2026, 1, P.rb[1], "BUF", null, null, 4, 3, 18, 5, null, null, null, null],
  [2026, 2, P.qb[1], "BUF", 35, 1, null, null, 2, null, 280, null, null, null],
  [2026, 2, P.rb[1], "BUF", null, null, 6, 5, 20, null, null, null, null, null],   // targets, no air yards: partial air total
  [2026, 2, P.wr[1], "MIA", null, null, 7, 4, null, 70, null, null, null, null],    // traded after week 1
  [2026, 2, P.wr2[1], "MIA", null, null, 5, 5, null, 40, null, null, null, null],
  [2026, 3, P.wr[1], "MIA", null, null, 8, 8, 1, 60, null, null, null, null],
  [2026, 1, P.lb[1], "BUF", null, null, null, null, null, null, null, 4, 2, 7],
  [2026, 2, P.lb[1], "BUF", null, null, null, null, null, null, null, 6, 1, 7],
  [2026, 1, P.cb[1], null, null, null, null, null, null, null, null, 3, 0, 3],      // team-less row
  [2025, 1, P.wr[1], "BUF", null, null, 99, 99, null, 999, null, null, null, null], // another season
];
const EXT = [ // season, week, gsis, pass_fd, rush_fd, rec_fd, twa, def_targets
  [2026, 1, P.wr[1], null, 0, 5, null, null], [2026, 2, P.wr[1], null, null, 3, null, null],
  [2026, 1, P.lb[1], null, null, null, 1, 2],                                          // with-assist tackle + coverage targets
  [2026, 2, P.lb[1], null, null, null, null, 4],                                       // pfr_advstats-only row: first downs NULL
];
const SNAPS = [ // season, week, pfr, team, off, off_pct, def, def_pct, st
  [2026, 1, P.qb[2], "BUF", 60, 1.0, 0, 0, 0], [2026, 1, P.wr[2], "BUF", 50, 0.83, 0, 0, 0], [2026, 2, P.wr[2], "MIA", 40, 0.62, 0, 0, 1],
  [2026, 2, P.wr2[2], "MIA", 30, 0.46, 0, 0, 0], [2026, 1, P.lb[2], "BUF", 0, 0, 70, 1.0, 4], [2026, 2, P.lb[2], "BUF", 0, 0, 66, 1.0, 5],
];

function world({ weeklyStamp = "2026-11-17T05:00:00Z", pfrStamp = "2026-11-17T05:10:00Z" } = {}) {
  const d1 = makeD1();
  d1.raw.exec(SCHEMA);
  const st = d1.raw.prepare("INSERT INTO etl_runs VALUES (?, ?, 'ok', '2026')");
  st.run("nflverse_snaps", "2026-11-17T05:05:00Z");
  if (weeklyStamp) st.run("nflverse_weekly", weeklyStamp);
  if (pfrStamp) st.run("pfr_advstats", pfrStamp);
  for (const [mfl, gsis, pfr, pos] of Object.values(P))
    d1.raw.prepare("INSERT INTO player_id_map (mfl_id, gsis_id, pfr_id, mfl_position, status, accepted) VALUES (?, ?, ?, ?, 'verified', 1)").run(mfl, gsis, pfr, pos);
  d1.raw.prepare("INSERT INTO player_id_map (mfl_id, gsis_id, pfr_id, mfl_position, status, accepted) VALUES ('2099', NULL, NULL, 'DT', 'unmapped', 0)").run();
  const b = d1.raw.prepare("INSERT INTO nfl_player_weekly (season, week, gsis_id, team, pos_group, pass_att, pass_sacks, targets, receptions, rush_att, receiving_air_yards, passing_air_yards, def_tackles_solo, def_tackles_ast, def_tackles_total) VALUES (?,?,?,?,'X',?,?,?,?,?,?,?,?,?,?)");
  for (const r of BOX) b.run(...r);
  d1.raw.prepare("INSERT INTO nfl_player_weekly (season, week, gsis_id, team, pos_group, targets) VALUES (2026, 1, '00-0009999', 'BUF', 'WR', 2)").run(); // unmapped
  const e = d1.raw.prepare("INSERT INTO nfl_player_weekly_ext (season, week, gsis_id, pass_first_downs, rush_first_downs, rec_first_downs, def_tackles_with_assist, def_targets) VALUES (?,?,?,?,?,?,?,?)");
  for (const r of EXT) e.run(...r);
  const s = d1.raw.prepare("INSERT INTO nfl_player_snaps (season, week, pfr_id, team, off_snaps, off_snap_pct, def_snaps, def_snap_pct, st_snaps) VALUES (?,?,?,?,?,?,?,?,?)");
  for (const r of SNAPS) s.run(...r);
  d1.raw.prepare("INSERT INTO nfl_player_redzone (season, week, gsis_id, targets_i20, targets_ez) VALUES (2026, 1, ?, 2, 1), (2026, 3, ?, 1, NULL)").run(P.wr[1], P.wr[1]);
  const pr = d1.raw.prepare("INSERT INTO ups_player_projections VALUES (?,?,?,?,?,?,?,?)");
  pr.run(2026, 12, "2002", 14.5, 12.0, 1795521600, 1795867200, 4);
  pr.run(2026, 12, "2001", 21.25, 21.25, 1795521600, 1795521600, 1);
  return d1;
}
class EdgeCache {
  constructor(o = {}) { this.m = new Map(); this.o = o; this.puts = []; }
  async match(req) { if (this.o.matchThrows) throw new Error("cache down"); const v = this.m.get(req.url); return v ? new Response(v.body, { headers: v.headers }) : undefined; }
  async put(req, res) { if (this.o.putRejects) throw new Error("put failed"); this.puts.push({ url: req.url, cc: res.headers.get("Cache-Control") });
    this.m.set(req.url, { body: await res.text(), headers: [...res.headers] }); }
}
async function get(d1, pathq, { cache } = {}) {
  const waits = [], had = "caches" in globalThis, prev = globalThis.caches;
  if (cache) globalThis.caches = { default: cache }; else delete globalThis.caches;
  const from = d1.log.length;
  try {
    const r = await worker.fetch(new Request(`https://w.test${pathq}${pathq.includes("?") ? "&" : "?"}L=74598`), { UPS_MFL_DB: d1 },
      { waitUntil: (p) => waits.push(p), passThroughOnException() {} });
    await Promise.all(waits);
    const body = await r.text();
    return { status: r.status, body, json: JSON.parse(body), sql: d1.log.slice(from).map((x) => x.sql) };
  } finally { if (had) globalThis.caches = prev; else delete globalThis.caches; }
}
const box = (d1, mfl, o) => get(d1, `/api/player-weekly-box?season=2026&mfl_id=${mfl}`, o);
const plan = (db, sql, args) => db.prepare("EXPLAIN QUERY PLAN " + sql).all(...args).map((r) => r.detail).join(" ; ");
const oracleTotals = (d1, week, team) => d1.raw.prepare(
  "SELECT SUM(targets) targets, SUM(receptions) receptions, SUM(rush_att) rush_att, SUM(pass_att) pass_att, SUM(pass_sacks) pass_sacks, " +
  "SUM(receiving_air_yards) rec_air_yards, SUM(CASE WHEN targets > 0 AND receiving_air_yards IS NULL THEN 1 ELSE 0 END) rec_air_missing, " +
  "SUM(passing_air_yards) pass_air_yards FROM nfl_player_weekly WHERE season = 2026 AND week = ? AND team = ?").get(week, team);

test("plans on the production DDL (+ migration-built ext / projections): every new read uses a key or index", () => {
  const db = new DatabaseSync(":memory:"); db.exec(SCHEMA);
  const extSql = SRC.match(/db\.prepare\("(SELECT week, pass_first_downs[^"]+)"\)/)[1];
  t.match(plan(db, extSql, [2026, "x"]), /USING INDEX idx_nflweekly_ext_player \(gsis_id=\? AND season=\?\)/);
  // the season table: one search of nfl_player_weekly's primary key on season, no other table
  const p1 = plan(db, TT.TEAM_TOTALS_SQL, [2026]);
  t.match(p1, /SEARCH t USING (COVERING )?INDEX (sqlite_autoindex_nfl_player_weekly_1|idx_nflweekly_seasonpos) \(season=\?\)/, p1);
  t.doesNotMatch(p1, /SCAN/);
  // the per-player fallback: his rows by the player index, then one week of the key per game
  const p2 = plan(db, TT.TEAM_TOTALS_JOIN_SQL, [2026, "x", 2026]);
  t.match(p2, /idx_nflweekly_player \(gsis_id=\? AND season=\?\)/, p2);
  t.match(p2, /SEARCH t USING INDEX sqlite_autoindex_nfl_player_weekly_1 \(season=\? AND week=\?\)/, p2);
  t.doesNotMatch(p2, /SEARCH t USING (COVERING )?INDEX \w+ \(season=\?\)/, p2);   // never the whole season
  if (process.env.R6_PRINT_PLANS) {   // the existing snaps fallback join (index.js), for the record
    const snapJoin = "SELECT s.week, s.team, MAX(s.off_snaps) FROM nfl_player_snaps s JOIN (SELECT week, team FROM nfl_player_snaps WHERE season = ? AND pfr_id = ?) p " +
      "ON p.week = s.week AND p.team = s.team WHERE s.season = ? GROUP BY s.week, s.team";
    console.log("snaps fallback join plan: " + plan(db, snapJoin, [2026, "x", 2026]));
  }
  t.match(plan(db, "SELECT source, last_run_utc FROM etl_runs WHERE source IN ('nflverse_weekly', 'pfr_advstats')", []), /etl_runs_1 \(source=\?\)/);
  // projections: primary key, one search per id
  const p3 = plan(db, "SELECT player_id, projected_score FROM ups_player_projections WHERE season = ? AND week = ? AND player_id IN (?,?)", [2026, 12, "1", "2"]);
  t.match(p3, /sqlite_autoindex_ups_player_projections_1 \(season=\? AND week=\? AND player_id=\?\)/, p3);
  // position stats: each data read is one primary-key range (season, week 1..through)
  for (const k of ["box", "ext", "rz", "snaps"]) {
    const p = plan(db, PS.SQL[k], [2026, 10]);
    t.match(p, /USING (COVERING )?INDEX sqlite_autoindex_\w+_1 \(season=\? AND week>\? AND week<\?\)/, k + ": " + p);
  }
  t.match(plan(db, PS.SQL.map, []), /SCAN player_id_map/);   // ~2.3k rows in production (measured 2026-11-23)
});

test("weekly box: existing fields unchanged; ext and team_totals added per week", async () => {
  const d1 = world(), v = await box(d1, P.wr[0], { cache: new EdgeCache() });
  t.equal(v.status, 200);
  t.deepEqual(Object.keys(v.json).sort(), ["box_through_week", "gsis_id", "id_source", "mfl_id", "ok", "pfr_id", "season", "weeks"]);
  for (const w of v.json.weeks) t.deepEqual(Object.keys(w), ["week", "box", "redzone", "snaps", "ext", "team_totals"]);
  const raw = d1.raw.prepare("SELECT * FROM nfl_player_weekly WHERE season = 2026 AND gsis_id = ? ORDER BY week").all(P.wr[1]);
  t.deepEqual(v.json.weeks.map((w) => w.box), JSON.parse(JSON.stringify(raw)));
  t.deepEqual(v.json.weeks.map((w) => w.ext), [
    { pass_first_downs: null, rush_first_downs: 0, rec_first_downs: 5, def_tackles_with_assist: null, def_targets: null },
    { pass_first_downs: null, rush_first_downs: null, rec_first_downs: 3, def_tackles_with_assist: null, def_targets: null },
    null]);                                                                            // week 3: no ext row → null, not zeros
  t.deepEqual(v.json.weeks.map((w) => w.team_totals && w.team_totals.team), ["BUF", "MIA", "MIA"]);   // the club he played for
  for (const w of v.json.weeks) { const { team, ...rest } = w.team_totals; t.deepEqual(rest, { ...oracleTotals(d1, w.week, team) }); }
  // BUF week 1: 9+4+2 targets (the unmapped player counts toward his team), 18+3 carries, 30 att, air 95 of 3 targeted rows
  t.deepEqual(v.json.weeks[0].team_totals, { team: "BUF", targets: 15, receptions: 9, rush_att: 21, pass_att: 30, pass_sacks: 2, rec_air_yards: 95, rec_air_missing: 1, pass_air_yards: 250 });
  t.equal(net.length, 0);
});

test("weekly box: an all-NULL team sum stays null; a team-less box row has no team totals; ext-only defender row", async () => {
  const d1 = world();
  const lb = await box(d1, P.lb[0], { cache: new EdgeCache() });
  t.deepEqual(lb.json.weeks.map((w) => w.ext), [
    { pass_first_downs: null, rush_first_downs: null, rec_first_downs: null, def_tackles_with_assist: 1, def_targets: 2 },
    { pass_first_downs: null, rush_first_downs: null, rec_first_downs: null, def_tackles_with_assist: null, def_targets: 4 }]);
  t.equal(lb.json.weeks[1].team_totals.pass_air_yards, 280);
  const cb = await box(d1, P.cb[0], { cache: new EdgeCache() });
  t.equal(cb.json.weeks[0].team_totals, null);
  // MIA week 3 has no passer row: pass_att is null (unknown), not 0
  const wr = await box(d1, P.wr[0]);
  t.equal(wr.json.weeks[2].team_totals.pass_att, null); t.equal(wr.json.weeks[2].team_totals.pass_sacks, null);
});

test("team totals cost: one season read fills the edge; the next view reads none; same answer as the per-player join", async () => {
  const d1 = world(), cache = new EdgeCache();
  const isSeason = (s) => s === TT.TEAM_TOTALS_SQL, isJoin = (s) => s === TT.TEAM_TOTALS_JOIN_SQL;
  const a = await box(d1, P.wr[0], { cache }), b = await box(d1, P.qb[0], { cache });
  t.equal(a.sql.filter(isSeason).length, 1); t.equal(a.sql.filter(isJoin).length, 0);
  t.equal(b.sql.filter(isSeason).length, 0); t.equal(b.sql.filter(isJoin).length, 0);
  const tp = cache.puts.filter((p) => /team-totals-season/.test(p.url));
  t.equal(tp.length, 1); t.equal(tp[0].cc, `public, max-age=${TT.TEAM_TOTALS_TTL_S}`);
  t.match(tp[0].url, /^https:\/\/upsmfl-stats\.local\/team-totals-season\?season=2026&w=2026-11-17T05%3A00%3A00Z&p=2026-11-17T05%3A10%3A00Z&q=1$/);
  for (const [mfl] of Object.values(P)) {
    const cached = await box(d1, mfl, { cache }), nocache = await box(d1, mfl), off = await get(d1, `/api/player-weekly-box?season=2026&mfl_id=${mfl}&NO_CACHE=1`, { cache });
    t.equal(cached.body, nocache.body); t.equal(off.body, nocache.body);
    t.equal(nocache.sql.filter(isSeason).length, 0);
  }
  // a new box-score stamp is read at once
  d1.raw.exec("UPDATE nfl_player_weekly SET targets = 10 WHERE season = 2026 AND week = 1 AND gsis_id = '00-0000102'");
  d1.raw.exec("UPDATE etl_runs SET last_run_utc = '2026-11-18T05:00:00Z' WHERE source = 'nflverse_weekly'");
  const c = await box(d1, P.wr[0], { cache });
  t.equal(c.json.weeks[0].team_totals.targets, 16); t.equal(c.sql.filter(isSeason).length, 1);
});

for (const [name, setup] of [
  ["no nflverse_weekly stamp", () => ({ d1: world({ weeklyStamp: null }), cache: new EdgeCache() })],
  ["no edge cache", () => ({ d1: world(), cache: null })],
  ["the edge cache throws", () => ({ d1: world(), cache: new EdgeCache({ matchThrows: true }) })],
  ["the store rejects", () => ({ d1: world(), cache: new EdgeCache({ putRejects: true }) })],
]) {
  test(`team totals failure → per-player join or none, never zeros: ${name}`, async () => {
    const { d1, cache } = setup();
    const v = await box(d1, P.wr[0], { cache });
    t.equal(v.status, 200);
    for (const w of v.json.weeks) { const { team, ...rest } = w.team_totals; t.deepEqual(rest, { ...oracleTotals(d1, w.week, team) }); }
  });
}
test("team totals: a failed join read leaves team_totals null; a pre-0114 database leaves ext null", async () => {
  const d1 = world({ weeklyStamp: null });
  d1.opts.beforeRun = (sql) => { if (sql === TT.TEAM_TOTALS_JOIN_SQL) throw new Error("D1_ERROR: simulated"); };
  const v = await box(d1, P.wr[0]);
  t.equal(v.status, 200); t.ok(v.json.weeks.every((w) => w.team_totals === null)); t.ok(v.json.weeks[0].box);
  d1.opts.beforeRun = null;
  d1.raw.exec("DROP TABLE nfl_player_weekly_ext");
  const n = await box(d1, P.wr[0]);
  t.equal(n.status, 200); t.ok(n.json.weeks.every((w) => w.ext === null));
});
test("coversTeams: a well-formed entry for each non-null week|team, every field a number or null", () => {
  const e = { targets: 1, receptions: 1, rush_att: null, pass_att: 1, pass_sacks: 0, rec_air_yards: null, rec_air_missing: 0, pass_air_yards: null };
  const rows = [{ week: 1, team: "BUF" }, { week: 2, team: null }];
  t.equal(TT.coversTeams({ "1|BUF": e }, rows), true);
  t.equal(TT.coversTeams({}, rows), false);
  t.equal(TT.coversTeams({ "1|BUF": { ...e, targets: "1" } }, rows), false);
  const { pass_air_yards: _x, ...short } = e;
  t.equal(TT.coversTeams({ "1|BUF": short }, rows), false);
  for (const bad of [null, [], "x"]) t.equal(TT.coversTeams(bad, rows), false);
});

test("projections: captured value and times; missing → null; ids deduped and bounded; edge-cached", async () => {
  const d1 = world(), cache = new EdgeCache();
  const v = await get(d1, "/api/player-projections?season=2026&week=12&ids=2002,2001,2002,9999", { cache });
  t.equal(v.status, 200);
  t.deepEqual(v.json.projections, {
    "2002": { projected_score: 14.5, captured_at: "2026-11-28T12:00:00.000Z", first_projected: 12, first_captured_at: "2026-11-24T12:00:00.000Z", capture_count: 4 },
    "2001": { projected_score: 21.25, captured_at: "2026-11-24T12:00:00.000Z", first_projected: 21.25, first_captured_at: "2026-11-24T12:00:00.000Z", capture_count: 1 },
    "9999": null });
  const q = v.sql.filter((s) => /ups_player_projections/.test(s));
  t.equal(q.length, 1); t.match(q[0], /player_id IN \(\?,\?,\?\)$/);
  t.equal((await get(d1, "/api/player-projections?season=2026&week=12&ids=2002,2001,2002,9999", { cache })).sql.filter((s) => /ups_player_projections/.test(s)).length, 0);
  t.equal((await get(d1, "/api/player-projections?season=2026&week=11&ids=2002")).json.projections["2002"], null);
  t.equal((await get(d1, "/api/player-projections?season=2026&ids=2002")).status, 400);
  t.equal((await get(d1, "/api/player-projections?season=2026&week=12")).status, 400);
  const many = Array.from({ length: 81 }, (_, i) => 3000 + i).join(",");
  t.equal((await get(d1, `/api/player-projections?season=2026&week=12&ids=${many}`)).status, 400);
});

test("position season stats: sums, team denominators, coverage, pool; one fill stores all nine groups", async () => {
  const d1 = world(), cache = new EdgeCache();
  const wr = await get(d1, "/api/position-season-stats?season=2026&through=3&group=WR", { cache });
  t.equal(wr.status, 200);
  t.equal(wr.json.group, "WR"); t.equal(wr.json.through, 3); t.equal(wr.json.data_max_week, 3);
  t.equal(wr.json.unmapped_box_players, 1);
  t.deepEqual(wr.json.players.map((p) => p.mfl_id), ["2002", "2003"]);
  const jw = wr.json.players[0];
  t.equal(jw.games, 3); t.equal(jw.snap_games, 2);
  t.equal(jw.s.targets, 24); t.equal(jw.s.receptions, 18); t.equal(jw.s.receiving_air_yards, 220);
  t.equal(jw.s.team_targets, 15 + 12 + 8);                       // BUF wk1 + MIA wk2 + MIA wk3: his club each game
  t.equal(jw.s.rec_first_downs, 8); t.equal(jw.s.rush_first_downs, 0);
  t.equal(jw.s.targets_i20, 3); t.equal(jw.s.targets_ez, 1);
  t.equal(jw.s.off_snaps, 90); t.equal(jw.s.team_off_snaps, 60 + 65);
  t.equal(jw.s.pass_att, undefined);                             // never a passing attempt: absent, not 0
  t.equal(jw.cov.rec_first_downs, 2); t.equal(jw.cov.targets_ez, 1);
  t.equal(cache.puts.length, 9);
  const lb = await get(d1, "/api/position-season-stats?season=2026&through=3&group=LB", { cache });
  t.ok(lb.sql.every((s) => !/FROM (nfl_player_weekly|nfl_player_weekly_ext|nfl_player_redzone|nfl_player_snaps|player_id_map)\b/.test(s)), lb.sql.join("\n"));
  t.deepEqual(lb.json.players.map((p) => [p.mfl_id, p.s.def_tackles_solo, p.s.def_tackles_with_assist, p.s.def_targets, p.s.def_snaps, p.s.team_def_snaps]), [["2005", 10, 1, 6, 136, 136]]);
  const db = await get(d1, "/api/position-season-stats?season=2026&through=3&group=DB", { cache });
  t.deepEqual(db.json.players.map((p) => [p.mfl_id, p.s.def_tackles_solo, p.s.team_targets]), [["2006", 3, undefined]]);   // CB → DB; team-less row: no denominator
  t.equal((db.json.players[0].cov || {}).team_targets, undefined);
  // through=1 is its own window; a stamp change refills
  const w1 = await get(d1, "/api/position-season-stats?season=2026&through=1&group=WR", { cache });
  t.equal(w1.json.players[0].s.targets, 9); t.equal(w1.json.players.length, 1);
  for (const bad of ["through=0&group=WR", "through=19&group=WR", "through=3&group=K", "group=WR"])
    t.equal((await get(d1, `/api/position-season-stats?season=2026&${bad}`)).status, 400);
  t.equal(net.length, 0);
});

test("position season stats: a gsis on two MFL ids is excluded and counted, not guessed", () => {
  const map = [{ mfl_id: "1", gsis_id: "00-1", pfr_id: null, mfl_position: "WR" }, { mfl_id: "2", gsis_id: "00-1", pfr_id: null, mfl_position: "WR" }];
  const g = PS.buildGroups({ box: [{ gsis_id: "00-1", week: 1, team: "BUF", targets: 3 }], ext: [], rz: [], snaps: [], map }, 2026, 1);
  t.equal(g.WR.players.length, 0); t.equal(g.WR.ambiguous_ids, 1);
});

// ── r7c: box weeks are nflverse rows; red-zone zero only where the PBP load is proven ──
const RZ0 = Object.fromEntries(PS.PLAYER_RZ_COUNT_COLS.map((c) => [c, 0]));
const MAP1 = [{ mfl_id: "1", gsis_id: "00-1", pfr_id: null, mfl_position: "WR" }, { mfl_id: "2", gsis_id: "00-2", pfr_id: null, mfl_position: "PN" },
  { mfl_id: "3", gsis_id: "00-3", pfr_id: null, mfl_position: "PK" }];
const nv = (week, o = {}) => ({ gsis_id: "00-1", week, team: "BUF", pos_group: "WR", targets: 4, receptions: 3, ...o });
const wrOf = (g) => g.WR.players.find((p) => p.mfl_id === "1");

test("PFR-only box row (pos_group NULL): not a game, not in sums, cov or team totals; its ext/rz rows are not read", () => {
  const pfrOnly = { gsis_id: "00-1", week: 2, team: null, pos_group: null, receiving_air_yards: 30, passing_times_pressured: 1 };
  const g = PS.buildGroups({ box: [nv(1, { receiving_air_yards: 50 }), pfrOnly], ext: [{ gsis_id: "00-1", week: 2, rec_first_downs: 1 }],
    rz: [{ gsis_id: "00-1", week: 2, ...RZ0, targets_i20: 9 }], snaps: [], map: MAP1, rzMarks: [] }, 2026, 2);
  const p = wrOf(g);
  t.equal(p.games, 1); t.equal(p.s.targets, 4); t.equal(p.s.receiving_air_yards, 50);
  t.equal(p.cov, undefined);                                     // complete over his ONE game, not "1 of 2"
  t.equal(p.s.rec_first_downs, undefined); t.equal(p.s.targets_i20, undefined);   // week-2 ext / rz not read; week 1 no marker
  t.equal(g.WR.non_box_rows, 1); t.equal(g.WR.data_max_week, 1);
  // a PFR-only row of an unmapped gsis is not an unmapped box player
  t.equal(PS.buildGroups({ box: [{ ...pfrOnly, gsis_id: "00-9" }], ext: [], rz: [], snaps: [], map: MAP1 }, 2026, 2).WR.unmapped_box_players, 0);
  t.equal(PS.rowKind({ pos_group: null, punts: null, fg_att_0_39: null }), "other");
});

test("PBP-only rows: a PN punt row and a PK FG-bucket row count as games; a PFR-only row for them does not", () => {
  const g = PS.buildGroups({ box: [
    { gsis_id: "00-2", week: 1, team: null, pos_group: null, punts: 5, punt_yds: 230 },
    { gsis_id: "00-2", week: 2, team: null, pos_group: null },
    { gsis_id: "00-3", week: 1, team: "BUF", pos_group: "PK", fg_att: 2, fg_made: 2 },
    { gsis_id: "00-3", week: 2, team: null, pos_group: null, fg_att_40_49: 1, fg_made_40_49: 1 },
  ], ext: [], rz: [], snaps: [], map: MAP1 }, 2026, 2);
  t.deepEqual(g.PN.players.map((p) => [p.games, p.s.punts]), [[1, 5]]);
  t.deepEqual(g.PK.players.map((p) => [p.games, p.s.fg_att, (p.cov || {}).fg_att]), [[2, 2, 1]]);
});

test("red zone: absent row + PBP marker for his (week, team) = 0 and complete; no marker = missing; a present row is unchanged", () => {
  const box = [nv(1), nv(2), nv(3, { team: "MIA" })];
  const rz = [{ gsis_id: "00-1", week: 1, ...RZ0, targets_i20: 2, targets_ez: 1 }];
  // markers for every game: weeks 2 and 3 are proven zero
  let p = wrOf(PS.buildGroups({ box, ext: [], rz, snaps: [], map: MAP1, rzMarks: [{ week: 1, team: "BUF" }, { week: 2, team: "BUF" }, { week: 3, team: "MIA" }] }, 2026, 3));
  t.equal(p.s.targets_i20, 2); t.equal(p.s.targets_ez, 1); t.equal(p.s.rush_att_i20, 0);
  t.equal((p.cov || {}).targets_i20, undefined);
  // week 3 MIA has no marker (BUF does: not his club that week): week 3 stays missing → partial
  const g = PS.buildGroups({ box, ext: [], rz, snaps: [], map: MAP1, rzMarks: [{ week: 2, team: "BUF" }, { week: 3, team: "BUF" }] }, 2026, 3);
  p = wrOf(g);
  t.equal(p.s.targets_i20, 2); t.equal(p.cov.targets_i20, 2); t.equal(g.WR.rz_proven_team_weeks, 2);
  // the marker read failed (null): nothing is zero-filled
  const gn = PS.buildGroups({ box, ext: [], rz, snaps: [], map: MAP1, rzMarks: null }, 2026, 3);
  t.equal(wrOf(gn).cov.targets_i20, 1); t.equal(gn.WR.rz_proven_team_weeks, null);
  // present rows: summed as stored, a NULL in a present row stays missing even with a marker
  const rz2 = [{ gsis_id: "00-1", week: 1, ...RZ0, targets_i20: 2 }, { gsis_id: "00-1", week: 2, ...RZ0, targets_i20: 3, pass_cmp_i20: null }];
  p = wrOf(PS.buildGroups({ box: box.slice(0, 2), ext: [], rz: rz2, snaps: [], map: MAP1, rzMarks: [{ week: 1, team: "BUF" }, { week: 2, team: "BUF" }] }, 2026, 2));
  t.equal(p.s.targets_i20, 5); t.equal(p.cov.pass_cmp_i20, 1); t.equal((p.cov || {}).targets_i20, undefined);
  // a team-less box week is never zero-filled
  p = wrOf(PS.buildGroups({ box: [nv(1, { team: null })], ext: [], rz: [], snaps: [], map: MAP1, rzMarks: [{ week: 1, team: "BUF" }] }, 2026, 1));
  t.equal(p.s.targets_i20, undefined);
});

test("route: position stats read the PBP marker by its primary key; weekly box zero-fills only proven, nflverse weeks", async () => {
  const db = new DatabaseSync(":memory:"); db.exec(SCHEMA);
  t.match(plan(db, PS.SQL.rzMarks, [2026, 10]), /USING (COVERING )?INDEX sqlite_autoindex_nfl_team_weekly_1 \(season=\? AND week>\? AND week<\?\)/);
  const wbSql = SRC.match(/"(SELECT week, team FROM nfl_team_weekly WHERE season = \? AND team IN \()"/)[1] + "?,?) AND rz_pass_att IS NOT NULL";
  const pw = plan(db, wbSql, [2026, "BUF", "MIA"]);
  t.match(pw, /idx_team_weekly_team \(team=\? AND season=\?\)/, pw); t.doesNotMatch(pw, /SCAN/, pw);

  const d1 = world();
  // WR 2002: box weeks 1 BUF (rz row), 2 MIA (no rz row), 3 MIA (rz row); add a PFR-only week 4 row
  d1.raw.exec("INSERT INTO nfl_player_weekly (season, week, gsis_id, receiving_air_yards) VALUES (2026, 4, '00-0000102', 25)");
  d1.raw.exec("INSERT INTO nfl_team_weekly (season, week, team, rz_pass_att) VALUES (2026, 1, 'BUF', 3), (2026, 2, 'MIA', 0), (2026, 4, 'MIA', 1), (2026, 2, 'BUF', NULL)");
  const v = await box(d1, P.wr[0]);
  t.equal(v.status, 200);
  const byW = Object.fromEntries(v.json.weeks.map((w) => [w.week, w.redzone]));
  t.deepEqual(byW[2], { season: 2026, week: 2, gsis_id: P.wr[1], ...RZ0, proven_zero: true });
  t.equal(byW[1].targets_i20, 2); t.equal(byW[1].proven_zero, undefined);      // a stored row is returned as stored
  t.equal(byW[4], null);                                                         // PFR-only week: never zero-filled
  // RB 2004 week 2 BUF: no rz row and no marker (rz_pass_att NULL) → stays null
  const rb = await box(d1, P.rb[0]);
  t.equal(rb.json.weeks.find((w) => w.week === 2).redzone, null);
  t.deepEqual(rb.json.weeks.find((w) => w.week === 1).redzone, { season: 2026, week: 1, gsis_id: P.rb[1], ...RZ0, proven_zero: true });
  // the pool: WR 2002 through 4 has 3 games (the PFR-only week is not one), and week 2 counts as a red-zone zero
  const wr = await get(d1, "/api/position-season-stats?season=2026&through=4&group=WR");
  const jw = wr.json.players.find((p) => p.mfl_id === "2002");
  t.equal(jw.games, 3); t.equal(jw.s.targets_i20, 3); t.equal(jw.s.receiving_air_yards, 220);
  t.equal((jw.cov || {}).targets_i20, undefined);                                // wk 1 row, wk 2 proven 0, wk 3 row: complete (was cov 2)
  t.equal(jw.cov.targets_ez, 2);                                                 // wk 3's stored NULL stays missing
  t.equal(wr.json.non_box_rows, 1); t.equal(wr.json.rz_proven_team_weeks, 3);
  // a failed marker read: no zero fill, every absent week missing
  d1.raw.exec("DROP TABLE nfl_team_weekly");
  const v2 = await box(d1, P.wr[0]);
  t.equal(v2.status, 200); t.equal(Object.fromEntries(v2.json.weeks.map((w) => [w.week, w.redzone]))[2], null);
  t.equal(net.length, 0);
});

await run("player_weekly_box_extras");
