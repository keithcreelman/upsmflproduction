// /api/player-starter-rates edge cache (Keith 2026-10-28, #1421 ruling A): a miss runs the route's reads once
// (37,473 D1 rows for 2026 through Wk 7, measured) and stores every variant; a HIT reads 0 D1 rows; one computation per
// season + MFL-authoritative completed week + graded-through week, so a newly completed week misses at once and no group,
// player or through value buys another read; 6 h settled / 1 h pending; NO_CACHE=1 reads live only with the commissioner
// key (anyone else is served from cache, 0 D1 rows); a cache that throws never breaks the answer; errors are never cached.
//   node tests/starter_rates_edge_cache.test.mjs
// Offline: in-memory D1 (node:sqlite), a fake caches.default, a stub MFL; every other outbound call is refused.
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, callWorker, quiet, ADMIN_KEY } from "./fixtures/fcfs_worker_harness.mjs";
import { CACHE_TTL_S, CACHE_PENDING_TTL_S, GROUPS, starterRatesCacheKey, starterRatesTtl, parseThrough } from "../worker/src/starter_rates.js";

const SCHEMA = fs.readFileSync("tests/fixtures/leaderboard_schema_pre0169.sql", "utf8");
const MIG = ["0169_redzone_v2_epa_through_week.sql", "0170_player_id_map.sql"].map((f) => fs.readFileSync("worker/migrations/" + f, "utf8"));

// MFL: liveScoring says week `live` is being scored (no schedule → no grace bump), so the completed week is live - 1.
const mfl = { live: 4, calls: [], down: false };
globalThis.fetch = async (input) => {
  const u = new URL(String(input && input.url || input));
  mfl.calls.push(u.hostname + u.pathname + "?" + (u.searchParams.get("TYPE") || ""));
  if (mfl.down) throw new Error("offline");
  if (/myfantasyleague\.com$/.test(u.hostname)) {
    const type = u.searchParams.get("TYPE");
    const body = type === "liveScoring" ? { liveScoring: { week: String(mfl.live) } } : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("offline", { status: 503 });
};

class EdgeCache {   // caches.default: match / put by URL
  constructor(o = {}) { this.m = new Map(); this.o = o; this.matches = []; this.puts = []; }
  async match(req) { this.matches.push(req.url); if (this.o.matchThrows) throw new Error("cache down"); const v = this.m.get(req.url);
    return v ? new Response(v.body, { headers: v.headers }) : undefined; }
  async put(req, res) { if (this.o.putRejects) throw new Error("put failed");
    this.puts.push({ url: req.url, cc: res.headers.get("Cache-Control") }); this.m.set(req.url, { body: await res.text(), headers: [...res.headers] }); }
}

// Three final weeks of six LB starters (two franchises), snap counts for each; Wk 4 has lineups but no snaps yet (pending).
function world({ pendingWk4 = false } = {}) {
  const env = makeWorkerEnv(), db = env.UPS_MFL_DB.raw;
  db.exec(SCHEMA); MIG.forEach((m) => db.exec(m));
  const sw = db.prepare("INSERT INTO src_weekly (season, week, player_id, pos_group, status, score, is_reg, roster_franchise_id) VALUES (2026, ?, ?, ?, ?, ?, 1, ?)");
  const sn = db.prepare("INSERT INTO nfl_player_snaps (season, week, pfr_id, team, off_snaps, def_snaps, st_snaps) VALUES (2026, ?, ?, 'AAA', 0, 50, 0)");
  for (let i = 0; i < 6; i++) db.prepare("INSERT INTO player_id_map (mfl_id, gsis_id, pfr_id, status, accepted) VALUES (?, ?, ?, 'verified', 1)").run(String(18000 + i), "00-S" + i, "Strt" + i);
  for (const w of [1, 2, 3, 4]) for (let i = 0; i < 6; i++) {
    sw.run(w, String(18000 + i), "LB", "starter", 4 + i * 2 + w, "000" + (i % 2 + 1));
    if (w < 4 || !pendingWk4) sn.run(w, "Strt" + i);
  }
  sw.run(1, "19000", "QB", "starter", 20, "0001");
  return env;
}
async function get(env, cache, qs, headers) {
  const had = "caches" in globalThis, prev = globalThis.caches;
  if (cache) globalThis.caches = { default: cache }; else delete globalThis.caches;
  const from = env.UPS_MFL_DB.log.length, r = quiet();
  try {
    const res = await callWorker(env, "GET", (/season=/.test(qs || "") ? "/api/player-starter-rates?L=74598&YEAR=2026" : "/api/player-starter-rates?L=74598&YEAR=2026&season=2026") + (qs || ""), headers ? { headers } : undefined);
    return { ...res, d1: env.UPS_MFL_DB.log.slice(from).map((x) => x.sql) };
  } finally { r(); if (had) globalThis.caches = prev; else delete globalThis.caches; }
}

test("a HIT reads 0 D1 rows: the second identical request never touches the database and returns the same answer", async () => {
  mfl.live = 4; mfl.down = false;
  const env = world(), cache = new EdgeCache();
  const miss = await get(env, cache);
  t.equal(miss.status, 200, miss.text.slice(0, 200));
  t.ok(miss.d1.some((s) => /FROM src_weekly/.test(s)) && miss.d1.some((s) => /FROM nfl_player_snaps/.test(s)), "a miss runs the model's reads (" + miss.d1.length + " statements)");
  t.equal(cache.puts.length, 2 + GROUPS.length, "every variant stored from the one computation (list, " + GROUPS.length + " groups, full)");
  t.deepEqual(miss.json.final_weeks, [1, 2, 3]);
  const hit = await get(env, cache);
  t.equal(hit.d1.length, 0, "HIT: zero D1 statements, so zero rows read");
  t.equal(hit.text, miss.text, "same answer");
  t.equal(cache.puts.length, 2 + GROUPS.length, "nothing re-stored on a hit");
});

test("the key: a private host plus season, completed week, authority, graded-through week and variant; no query value buys another read", async () => {
  mfl.live = 4; mfl.down = false;
  const env = world(), cache = new EdgeCache();
  const first = await get(env, cache, "&group=LB");
  const k = new URL(cache.puts.find((p) => /variant=LB/.test(p.url)).url);
  t.equal(k.hostname, "upsmfl-starter-rates.local", "built explicitly (workers.dev's caches.default is shared and ignores the host)");
  t.deepEqual(Object.fromEntries(k.searchParams), { v: "2", season: "2026", completed: "3", authority: "mfl_live_scoring", bound: "3", variant: "LB" });
  t.equal(starterRatesCacheKey({ season: 2026, completed: 3, authority: "mfl_live_scoring", bound: 3, variant: "all" }),
    "https://upsmfl-starter-rates.local/api/player-starter-rates?v=2&season=2026&completed=3&authority=mfl_live_scoring&bound=3&variant=all");
  t.ok(first.d1.length > 0, "the first request computes");
  t.deepEqual(Object.values(first.json.players).map((p) => p.group).filter((g) => g !== "LB"), [], "a group answer holds that group only");
  for (const qs of ["&group=QB", "", "&mfl_id=18001", "&mfl_id=99999", "&through=3", "&through=9", "&group=DB&through=12", "&cb=123&_=9"]) {
    const r = await get(env, cache, qs);
    t.ok(r.status === 200 && r.d1.length === 0, (qs || "(none)") + ": served from the one computation, 0 D1 statements");
  }
  const pl = await get(env, cache, "&mfl_id=18001");
  t.deepEqual([Object.keys(pl.json.players), Array.isArray(pl.json.players["18001"].wk)], [["18001"], true], "a player's answer is cut from the full one, weekly detail kept");
  t.equal(cache.puts.length, 2 + GROUPS.length, "and nothing new was stored");
  const two = await get(env, cache, "&through=2");
  t.ok(two.d1.length > 0 && two.json.through_week === 2, "a smaller graded-through week is the only other computation (at most one per final week)");
  for (const qs of ["&group=XYZ", "&season=1999", "&season=3000"]) {
    const r = await get(env, cache, qs);
    t.ok(r.status === 400 && r.d1.length === 0, qs + ": refused before any read");
  }
});

test("a newly completed week is a new key: it misses at once (no waiting out the TTL)", async () => {
  mfl.down = false; mfl.live = 3;
  const env = world(), cache = new EdgeCache();
  const a = await get(env, cache);
  t.deepEqual([a.json.completed_week, a.json.final_weeks], [2, [1, 2]]);
  t.equal((await get(env, cache)).d1.length, 0, "same week: hit");
  mfl.live = 4;   // Wk 3 completes
  const b = await get(env, cache);
  t.ok(b.d1.length > 0, "Wk 3 final: miss");
  t.deepEqual([b.json.completed_week, b.json.final_weeks], [3, [1, 2, 3]]);
});

test("TTL: 6 h once every completed week is graded; 1 h while a week is pending or MFL couldn't be read", async () => {
  t.equal(CACHE_TTL_S, 21600); t.equal(CACHE_PENDING_TTL_S, 3600);
  mfl.down = false; mfl.live = 4;
  let cache = new EdgeCache();
  await get(world(), cache);
  t.equal(cache.puts[0].cc, "public, max-age=21600", "settled");
  mfl.live = 5; cache = new EdgeCache();   // Wk 4 completed by MFL, but its snap counts haven't synced
  const p = await get(world({ pendingWk4: true }), cache);
  t.deepEqual([p.json.final_weeks, p.json.pending_weeks], [[1, 2, 3], [4]]);
  t.equal(cache.puts[0].cc, "public, max-age=3600", "pending week: 1 hour");
  mfl.down = true; cache = new EdgeCache();
  const s = await get(world(), cache);
  t.equal(s.json.week_authority, "synced_data_only");
  t.equal(cache.puts[0].cc, "public, max-age=3600", "MFL unreadable: 1 hour");
  t.equal(starterRatesTtl({ pending_weeks: [] }, "mfl_live_scoring"), 21600); t.equal(starterRatesTtl({ pending_weeks: [7] }, "mfl_live_scoring"), 3600);
  mfl.down = false;
});

test("through=W grades final weeks up to W only, same SQL, a smaller bound", async () => {
  mfl.down = false; mfl.live = 4;
  const env = world();
  const a = await get(env, null, "&through=2");
  t.deepEqual([a.json.through_week, a.json.completed_week, a.json.final_weeks], [2, 3, [1, 2]]);
  const b = await get(env, null, "&through=9");
  t.deepEqual([b.json.final_weeks, b.json.through_week], [[1, 2, 3], 3], "a bound past the completed week changes nothing (graded through Wk 3)");
  t.equal((await get(env, null)).json.through_week, 3, "no bound: graded through the completed week");
  t.deepEqual([parseThrough("6"), parseThrough("0"), parseThrough("19"), parseThrough(""), parseThrough("x")], [6, null, null, null, null]);
  const sqlA = a.d1.filter((s) => /FROM (src_weekly|nfl_player_snaps)/.test(s)), sqlB = b.d1.filter((s) => /FROM (src_weekly|nfl_player_snaps)/.test(s));
  t.deepEqual(sqlA, sqlB, "the same statements either way (only the bound value differs)");
});

test("NO_CACHE=1 is a commissioner-only diagnostic: without the key it is served from cache (0 D1 rows); with it, a live read that stores nothing", async () => {
  mfl.down = false; mfl.live = 4;
  const env = world(), cache = new EdgeCache();
  await get(env, cache);                                   // warm
  const stored = cache.puts.length;
  for (const [label, qs, h] of [["no key", "&NO_CACHE=1"], ["wrong key", "&NO_CACHE=1&APIKEY=guess"], ["wrong header", "&NO_CACHE=1", { "X-COMMISH-APIKEY": "guess" }], ["empty key", "&NO_CACHE=1&APIKEY="]]) {
    const r = await get(env, cache, qs, h);
    t.ok(r.status === 200 && r.d1.length === 0, label + ": served from cache, never D1");
  }
  t.equal(cache.puts.length, stored, "and nothing re-stored");
  const viaQuery = await get(env, cache, "&NO_CACHE=1&APIKEY=" + ADMIN_KEY);
  t.ok(viaQuery.status === 200 && viaQuery.d1.some((x) => /FROM src_weekly/.test(x)), "commissioner key (query): live read");
  const viaHeader = await get(env, cache, "&NO_CACHE=1", { "X-COMMISH-APIKEY": ADMIN_KEY });
  t.ok(viaHeader.status === 200 && viaHeader.d1.some((x) => /FROM src_weekly/.test(x)), "commissioner key (header): live read");
  t.equal(cache.puts.length, stored, "a live diagnostic read stores nothing");
  // No key configured on the worker: nothing can prove the commissioner, so the bypass is closed.
  const env2 = world(); env2.COMMISH_API_KEY = ""; const c2 = new EdgeCache();
  await get(env2, c2);
  const r2 = await get(env2, c2, "&NO_CACHE=1&APIKEY=");
  t.ok(r2.status === 200 && r2.d1.length === 0, "no key configured: served from cache (fail closed)");
});

test("never worse than no cache: a throwing cache or failed store still answers; no caches API answers live; errors aren't cached", async () => {
  mfl.down = false; mfl.live = 4;
  const env = world();
  let cache = new EdgeCache({ matchThrows: true });
  t.equal((await get(env, cache)).status, 200, "cache down: live answer");
  cache = new EdgeCache({ putRejects: true });
  t.equal((await get(env, cache)).status, 200, "store failed: live answer");
  t.equal((await get(env, null)).status, 200, "no caches API at all");
  cache = new EdgeCache();
  env.UPS_MFL_DB.raw.exec("DROP TABLE src_weekly");
  const e = await get(env, cache);
  t.ok(e.status === 500 && cache.puts.length === 0, "a failed read is never stored");
});

await run("starter_rates_edge_cache");
