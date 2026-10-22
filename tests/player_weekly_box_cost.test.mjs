// /api/player-weekly-box (the phone game log): same answer, ~30k → ~20 D1 rows per player view.
//   node tests/player_weekly_box_cost.test.mjs
//   • the three per-player reads carry no ORDER BY, so the planner uses the (gsis_id|pfr_id, season)
//     player indexes instead of walking the whole season by primary key (production DDL fixture)
//   • team snaps come from one season table kept at the edge, keyed on etl_runs' nflverse_snaps stamp;
//     the response equals the original per-player join, including a mid-season trade, NULL shares,
//     zero snaps and a team-less row
//   • freshness: a new stamp is read at once; an unstamped write waits out max-age (1 h); seasons apart
//   • failure: no stamp, no etl_runs, no edge cache, a throwing / corrupt cache, a failed season read,
//     a failed store, NO_CACHE=1 → the original per-player join, identical answer
// Offline: in-memory D1, fake edge cache, every outbound fetch refused.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeD1 } from "./fixtures/d1_sqlite.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA = fs.readFileSync(path.join(ROOT, "tests/fixtures/player_weekly_box_schema.sql"), "utf8");
const SRC = fs.readFileSync(path.join(ROOT, "worker/src/index.js"), "utf8");
await import("./fixtures/register_md_loader.mjs");
const worker = (await import("../worker/src/index.js")).default;
const { seasonTeamSnaps, coversPlayer, TEAM_SNAPS_TTL_S } = await import("../worker/src/team_snaps_season.js");
const net = [];
globalThis.fetch = async (u) => { net.push(String(u && u.url || u)); return new Response("offline", { status: 503 }); };

// The original per-player join, kept here as the oracle for team snaps.
const ORACLE = "SELECT s.week, s.team, " +
  "CAST(ROUND(MAX(s.off_snaps) * 1.0 / NULLIF(MAX(CASE WHEN s.off_snaps > 0 THEN s.off_snap_pct END), 0)) AS INTEGER) AS team_off, " +
  "CAST(ROUND(MAX(s.def_snaps) * 1.0 / NULLIF(MAX(CASE WHEN s.def_snaps > 0 THEN s.def_snap_pct END), 0)) AS INTEGER) AS team_def " +
  "FROM nfl_player_snaps s JOIN (SELECT week, team FROM nfl_player_snaps WHERE season = ? AND pfr_id = ?) p " +
  "ON p.week = s.week AND p.team = s.team WHERE s.season = ? GROUP BY s.week, s.team";

// players: [mfl_id, gsis_id, pfr_id]
const P = { qb: ["1001", "00-0000001", "QbbbAa00"], wr: ["1002", "00-0000002", "WrrrBb00"], rb: ["1003", "00-0000003", "RbbbCc00"],
  lb: ["1004", "00-0000004", "LbbbDd00"], s: ["1005", "00-0000005", "SsssEe00"], nt: ["1006", "00-0000006", "NtttFf00"],
  nopfr: ["1007", "00-0000007", null] };
// snaps: season, week, pfr, team, off, off_pct, def, def_pct, st
const SNAPS = [
  [2026, 1, "QbbbAa00", "BUF", 60, 1.0, 0, 0, 0], [2026, 2, "QbbbAa00", "BUF", 65, 1.0, 0, 0, 0], [2026, 3, "QbbbAa00", "BUF", 58, 1.0, 0, 0, 0],
  [2026, 1, "WrrrBb00", "BUF", 50, 0.83, 0, 0, 2],                                        // traded after week 1
  [2026, 2, "WrrrBb00", "MIA", 40, 0.62, 0, 0, 1], [2026, 3, "WrrrBb00", "MIA", 44, 0.7, 0, 0, 3],
  [2026, 1, "RbbbCc00", "MIA", 30, 0.5, 0, 0, 5], [2026, 2, "RbbbCc00", "MIA", 0, 0, 0, 0, 9], [2026, 3, "RbbbCc00", "MIA", 12, null, 0, 0, 0],
  [2026, 1, "LbbbDd00", "BUF", 0, 0, 70, 1.0, 4], [2026, 2, "LbbbDd00", "BUF", 0, 0, 66, 1.0, 6],
  [2026, 1, "SsssEe00", "MIA", 0, 0, 55, 0.9, 7], [2026, 2, "SsssEe00", "MIA", 3, 0.05, 61, 0.92, 2],
  [2026, 1, "NtttFf00", null, 10, 0.2, 0, 0, 0],                                          // a team-less row
  [2025, 1, "QbbbAa00", "BUF", 70, 1.0, 0, 0, 0], [2025, 1, "WrrrBb00", "BUF", 35, 0.5, 0, 0, 0],
];

function world({ stamp = "2026-10-21T15:50:30Z", etl = true } = {}) {
  const d1 = makeD1();
  d1.raw.exec(SCHEMA);
  if (!etl) d1.raw.exec("DROP TABLE etl_runs");
  else if (stamp) d1.raw.prepare("INSERT INTO etl_runs VALUES ('nflverse_snaps', ?, 'ok', '2026')").run(stamp);
  for (const [mfl, gsis, pfr] of Object.values(P))
    d1.raw.prepare("INSERT INTO player_id_map (mfl_id, gsis_id, pfr_id, status, accepted) VALUES (?, ?, ?, 'verified', 1)").run(mfl, gsis, pfr);
  const ins = d1.raw.prepare("INSERT INTO nfl_player_snaps (season, week, pfr_id, team, off_snaps, off_snap_pct, def_snaps, def_snap_pct, st_snaps) VALUES (?,?,?,?,?,?,?,?,?)");
  for (const r of SNAPS) ins.run(...r);
  for (const [, gsis, pfr] of Object.values(P)) {
    const weeks = SNAPS.filter((r) => r[2] === pfr && r[0] === 2026).map((r) => r[1]);
    for (const w of (weeks.length ? weeks : [1]))
      d1.raw.prepare("INSERT INTO nfl_player_weekly (season, week, gsis_id, team, pos_group) VALUES (2026, ?, ?, 'BUF', 'QB')").run(w, gsis);
  }
  d1.raw.prepare("INSERT INTO nfl_player_redzone (season, week, gsis_id) VALUES (2026, 1, ?)").run(P.qb[1]);
  d1.raw.prepare("INSERT INTO nfl_player_weekly (season, week, gsis_id, team, pos_group) VALUES (2025, 1, ?, 'BUF', 'QB')").run(P.qb[1]);
  return d1;
}
class EdgeCache {   // caches.default: match / put by URL, honoring nothing but presence
  constructor(o = {}) { this.m = new Map(); this.o = o; this.matches = 0; this.puts = []; }
  async match(req) { this.matches++; if (this.o.matchThrows) throw new Error("cache down"); const v = this.m.get(req.url);
    return v ? new Response(this.o.corrupt ? "{not json" : v.body, { headers: v.headers }) : undefined; }
  async put(req, res) { if (this.o.putRejects) throw new Error("put failed");
    this.puts.push({ url: req.url, cc: res.headers.get("Cache-Control") }); this.m.set(req.url, { body: await res.text(), headers: [...res.headers] }); }
}
async function view(d1, mfl, { cache, season = 2026, extra = "" } = {}) {
  const waits = [], had = "caches" in globalThis, prev = globalThis.caches;
  if (cache) globalThis.caches = { default: cache }; else delete globalThis.caches;
  const from = d1.log.length;
  try {
    const r = await worker.fetch(new Request(`https://w.test/api/player-weekly-box?season=${season}&mfl_id=${mfl}&L=74598${extra}`),
      { UPS_MFL_DB: d1 }, { waitUntil: (p) => waits.push(p), passThroughOnException() {} });
    await Promise.all(waits);
    return { status: r.status, body: await r.text(), json: null, sql: d1.log.slice(from).map((x) => x.sql) };
  } finally { if (had) globalThis.caches = prev; else delete globalThis.caches; }
}
const parse = (v) => JSON.parse(v.body);
const teamSnapsOf = (v) => parse(v).weeks.filter((w) => w.snaps).map((w) => [w.week, w.snaps.team, w.snaps.team_off, w.snaps.team_def]);
function oracle(d1, pfr, season = 2026) {
  const tt = {};
  for (const r of d1.raw.prepare(ORACLE).all(season, pfr, season)) tt[r.week + "|" + r.team] = r;
  return d1.raw.prepare("SELECT week, team FROM nfl_player_snaps WHERE season = ? AND pfr_id = ? ORDER BY week").all(season, pfr)
    .map((r) => [r.week, r.team, tt[r.week + "|" + r.team] ? tt[r.week + "|" + r.team].team_off : null,
                 tt[r.week + "|" + r.team] ? tt[r.week + "|" + r.team].team_def : null]);
}
const usedJoin = (v) => v.sql.some((s) => s.includes("JOIN (SELECT week, team FROM nfl_player_snaps"));
const usedSeason = (v) => v.sql.some((s) => /GROUP BY week, team$/.test(s));

test("plans: the per-player reads carry no ORDER BY and use the player indexes (production DDL)", () => {
  const block = SRC.slice(SRC.indexOf('path === "/api/player-weekly-box"'), SRC.indexOf('path === "/api/player-routes"'));
  const reads = [...block.matchAll(/db\.prepare\("(SELECT [^"]+FROM (nfl_player_weekly|nfl_player_redzone|nfl_player_snaps) WHERE season = \? AND (gsis_id|pfr_id) = \?[^"]*)"\)/g)].map((m) => m[1]);
  t.equal(reads.length, 3);
  const db = new DatabaseSync(":memory:"); db.exec(SCHEMA);
  const want = { nfl_player_weekly: "idx_nflweekly_player", nfl_player_redzone: "idx_redzone_player", nfl_player_snaps: "idx_nflsnaps_player" };
  for (const sql of reads) {
    t.doesNotMatch(sql, /ORDER BY/);
    const table = sql.match(/FROM (\w+)/)[1];
    const plan = db.prepare("EXPLAIN QUERY PLAN " + sql).all(2026, "x").map((r) => r.detail).join(" ; ");
    t.match(plan, new RegExp(`USING INDEX ${want[table]} \\((gsis_id|pfr_id)=\\? AND season=\\?\\)`), plan);
    // the old form, for the record: ORDER BY week walks the whole season on the primary key
    t.match(db.prepare("EXPLAIN QUERY PLAN " + sql + " ORDER BY week").all(2026, "x").map((r) => r.detail).join(), /sqlite_autoindex_\w+_1 \(season=\?\)/);
  }
  t.match(db.prepare("EXPLAIN QUERY PLAN SELECT last_run_utc FROM etl_runs WHERE source = 'nflverse_snaps'").all().map((r) => r.detail).join(), /etl_runs_1 \(source=\?\)/);
});

test("same answer as the per-player join, from the season table: trade, NULL share, zero snaps, team-less row", async () => {
  const d1 = world(), cache = new EdgeCache();
  for (const [mfl, , pfr] of Object.values(P)) {
    const fallback = await view(d1, mfl), cached = await view(d1, mfl, { cache }), off = await view(d1, mfl, { cache, extra: "&NO_CACHE=1" });
    t.equal(fallback.status, 200); t.equal(cached.body, fallback.body); t.equal(off.body, fallback.body);
    if (pfr) t.deepEqual(teamSnapsOf(cached), oracle(d1, pfr)); else t.deepEqual(teamSnapsOf(cached), []);
  }
  // spot values: BUF has a 100% QB (exact); MIA's offense is an estimate from its top share; the team-less row has none
  // MIA week 2: 40 / 0.62 → 65 offense, 61 / 0.92 → 66 defense; week 3: no defender logged → null
  t.deepEqual(teamSnapsOf(await view(d1, P.wr[0], { cache })), [[1, "BUF", 60, 70], [2, "MIA", 65, 66], [3, "MIA", 63, null]]);
  t.deepEqual(teamSnapsOf(await view(d1, P.s[0], { cache })), [[1, "MIA", 60, 61], [2, "MIA", 65, 66]]);
  t.deepEqual(teamSnapsOf(await view(d1, P.nt[0], { cache })), [[1, null, null, null]]);
  t.equal(parse(await view(d1, "999999", { cache })).weeks.length, 0);
  t.equal(cache.puts.length, 1); t.equal(net.length, 0);
});

test("cost shape: one season read fills the cache; later views read no team-snap rows at all", async () => {
  const d1 = world(), cache = new EdgeCache();
  const first = await view(d1, P.qb[0], { cache }), second = await view(d1, P.lb[0], { cache });
  t.equal(usedSeason(first), true); t.equal(usedJoin(first), false);
  t.equal(usedSeason(second), false); t.equal(usedJoin(second), false);
  t.ok(second.sql.every((s) => !/ORDER BY/.test(s)));
  t.deepEqual(second.sql.filter((s) => /nfl_player_snaps/.test(s)), ["SELECT week, team, off_snaps, def_snaps, st_snaps FROM nfl_player_snaps WHERE season = ? AND pfr_id = ?"]);
  t.equal(cache.puts.length, 1); t.equal(cache.puts[0].cc, `public, max-age=${TEAM_SNAPS_TTL_S}`); t.equal(TEAM_SNAPS_TTL_S, 3600);
  t.match(cache.puts[0].url, /^https:\/\/upsmfl-stats\.local\/team-snaps-season\?season=2026&v=2026-10-21T15%3A50%3A30Z&q=1$/);
});

test("freshness: a new nflverse_snaps stamp is read at once; an unstamped write waits for max-age; seasons are apart", async () => {
  const d1 = world(), cache = new EdgeCache();
  t.deepEqual(teamSnapsOf(await view(d1, P.wr[0], { cache }))[0], [1, "BUF", 60, 70]);
  d1.raw.exec("UPDATE nfl_player_snaps SET off_snaps = 62 WHERE season = 2026 AND week = 1 AND pfr_id = 'QbbbAa00'");
  // unstamped write (e.g. a manual load): the stored season table is still served, until max-age (1 h) drops it
  t.deepEqual(teamSnapsOf(await view(d1, P.wr[0], { cache }))[0], [1, "BUF", 60, 70]);
  d1.raw.exec("UPDATE etl_runs SET last_run_utc = '2026-10-22T05:00:41Z' WHERE source = 'nflverse_snaps'");
  const fresh = await view(d1, P.wr[0], { cache });
  t.deepEqual(teamSnapsOf(fresh)[0], [1, "BUF", 62, 70]); t.equal(usedSeason(fresh), true);
  t.deepEqual(teamSnapsOf(fresh), oracle(d1, P.wr[2]));
  t.equal(cache.puts.length, 2); t.match(cache.puts[1].url, /v=2026-10-22T05%3A00%3A41Z/);
  const y25 = await view(d1, P.wr[0], { cache, season: 2025 });
  t.deepEqual(teamSnapsOf(y25), [[1, "BUF", 70, null]]); t.deepEqual(teamSnapsOf(y25), oracle(d1, P.wr[2], 2025));
  t.match(cache.puts[2].url, /season=2025&/);
});

for (const [name, setup, expect] of [
  ["no nflverse_snaps stamp", () => ({ d1: world({ stamp: null }), cache: new EdgeCache() }), { matches: 0 }],
  ["no etl_runs table (pre-0084)", () => ({ d1: world({ etl: false }), cache: new EdgeCache() }), { matches: 0 }],
  ["no edge cache at all", () => ({ d1: world(), cache: null }), {}],
  ["the edge cache throws", () => ({ d1: world(), cache: new EdgeCache({ matchThrows: true }) }), { matches: 1 }],
  ["NO_CACHE=1", () => ({ d1: world(), cache: new EdgeCache(), extra: "&NO_CACHE=1" }), { matches: 0 }],
]) {
  test(`failure → original per-player join, same answer: ${name}`, async () => {
    const { d1, cache, extra = "" } = setup();
    const v = await view(d1, P.wr[0], { cache, extra });
    t.equal(v.status, 200); t.equal(usedJoin(v), true); t.equal(usedSeason(v), false);
    t.deepEqual(teamSnapsOf(v), oracle(d1, P.wr[2]));
    if (cache) { t.equal(cache.puts.length, 0); if (expect.matches != null) t.equal(cache.matches, expect.matches); }
  });
}

test("failure → original per-player join: the season read fails, or the cached body is corrupt", async () => {
  const d1 = world(), cache = new EdgeCache();
  d1.opts.beforeRun = (sql) => { if (/GROUP BY week, team$/.test(sql)) throw new Error("D1_ERROR: simulated"); };
  const v = await view(d1, P.wr[0], { cache });
  t.equal(v.status, 200); t.equal(usedJoin(v), true); t.deepEqual(teamSnapsOf(v), oracle(d1, P.wr[2])); t.equal(cache.puts.length, 0);
  d1.opts.beforeRun = null;
  await view(d1, P.wr[0], { cache });            // fills the cache
  cache.o.corrupt = true;                         // the stored body no longer parses
  const c = await view(d1, P.wr[0], { cache });
  t.equal(usedJoin(c), true); t.deepEqual(teamSnapsOf(c), oracle(d1, P.wr[2]));
});

// Codex #1380 MAT-1: a cached season table that PARSES but is short or malformed (e.g. built mid-refresh)
// must not blank a player's team snaps. Unless it covers every (week, team) of his snap rows with a
// well-formed entry, the route runs the original join, and his response stays byte-identical.
const restore = (cache, fn) => { for (const [url, v] of cache.m) cache.m.set(url, { ...v, body: JSON.stringify(fn(JSON.parse(v.body))) }); };
for (const [name, fn] of [
  ["an empty table {}", () => ({})],
  ["a table missing his week-2 game (2|MIA)", (m) => { delete m["2|MIA"]; return m; }],
  ["his entry is a string", (m) => ({ ...m, "2|MIA": "x" })],
  ["his entry has team_off as text", (m) => ({ ...m, "2|MIA": { team_off: "65", team_def: 66 } })],
  ["his entry lacks team_def", (m) => ({ ...m, "2|MIA": { team_off: 65 } })],
  ["the table is an array", () => []],
  ["the table is null", () => null],
]) {
  test(`incomplete cached table → original join, same response: ${name}`, async () => {
    const d1 = world(), cache = new EdgeCache();
    const expected = await view(d1, P.wr[0]);                      // no edge cache: the original join
    await view(d1, P.wr[0], { cache });                            // fills the cache with the real table
    restore(cache, fn);
    const v = await view(d1, P.wr[0], { cache });
    t.equal(usedJoin(v), true); t.equal(usedSeason(v), false);     // the short table was read, then refused
    t.equal(v.body, expected.body);
    t.deepEqual(teamSnapsOf(v), oracle(d1, P.wr[2]));
  });
}
test("a cached table that covers his games is used even if other teams are missing; a team-less player needs no entry", async () => {
  const d1 = world(), cache = new EdgeCache();
  const expected = await view(d1, P.wr[0]);
  await view(d1, P.wr[0], { cache });
  restore(cache, (m) => { delete m["2|BUF"]; delete m["3|BUF"]; return m; });   // not his games
  const v = await view(d1, P.wr[0], { cache });
  t.equal(usedJoin(v), false); t.equal(v.body, expected.body);
  restore(cache, () => ({}));
  const nt = await view(d1, P.nt[0], { cache }), ntLive = await view(d1, P.nt[0]);
  t.equal(usedJoin(nt), false); t.equal(nt.body, ntLive.body); t.deepEqual(teamSnapsOf(nt), [[1, null, null, null]]);
});
test("coversPlayer: object with a well-formed entry for each non-null week|team, numbers or null only", () => {
  const rows = [{ week: 1, team: "BUF" }, { week: 2, team: "MIA" }, { week: 3, team: null }];
  t.equal(coversPlayer({ "1|BUF": { team_off: 60, team_def: null }, "2|MIA": { team_off: 65, team_def: 66 } }, rows), true);
  t.equal(coversPlayer({ "1|BUF": { team_off: 60, team_def: null } }, rows), false);
  t.equal(coversPlayer({ "1|BUF": { team_off: 60, team_def: null }, "2|MIA": { team_off: Infinity, team_def: 66 } }, rows), false);
  t.equal(coversPlayer({}, [{ week: 3, team: null }]), true);
  t.equal(coversPlayer({}, []), true);
  for (const bad of [null, undefined, [], "x", 5]) t.equal(coversPlayer(bad, rows), false);
});

test("failure → still answered: the edge store rejects; the next view simply tries again", async () => {
  const d1 = world(), cache = new EdgeCache({ putRejects: true });
  const a = await view(d1, P.wr[0], { cache }), b = await view(d1, P.wr[0], { cache });
  t.equal(a.status, 200); t.deepEqual(teamSnapsOf(a), oracle(d1, P.wr[2]));
  t.equal(usedSeason(a), true); t.equal(usedSeason(b), true); t.equal(b.body, a.body);
});

test("seasonTeamSnaps: null without a cache; skips team-less groups; keyed on season + stamp + query version", async () => {
  const d1 = world();
  t.equal(await seasonTeamSnaps(d1, 2026, null, null), null);
  const cache = new EdgeCache();
  const m = await seasonTeamSnaps(d1, 2026, null, cache);
  t.deepEqual(Object.keys(m).sort(), ["1|BUF", "1|MIA", "2|BUF", "2|MIA", "3|BUF", "3|MIA"]);
  t.deepEqual(m["1|MIA"], { team_off: 60, team_def: 61 });
  t.deepEqual(await seasonTeamSnaps(d1, 2026, null, cache), m);   // hit
  t.equal(cache.puts.length, 1);
});

await run("player_weekly_box_cost");
