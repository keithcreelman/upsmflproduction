// /api/player-status reads the 2,272-row player_id_map from D1 once per cache entry, not on every call.
//   node tests/player_status_id_map_cache.test.mjs
//
// #1338 (2026-10-20): every injury chip read did `SELECT mfl_id, gsis_id, accepted FROM player_id_map` with no
// WHERE (2,272 rows read per call, measured in D1 insights) and nothing cached it server-side. The desktop Front
// Office is about to use the same route. The id map only changes when the nightly id ETL runs, so the route keeps
// it in the worker cache for 10 minutes; injury data itself (MFL + the official report) is untouched.
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { loadPlayerStatus, cachedIdMapLoader, ID_MAP_CACHE_KEY, ID_MAP_TTL_SECONDS } from "../worker/src/player_status.js";

const ROWS = [
  { mfl_id: 101, gsis_id: "00-0000001", accepted: 1 },
  { mfl_id: 102, gsis_id: "00-0000002", accepted: 1 },
  { mfl_id: 103, gsis_id: "00-0000003", accepted: 0 },
];
function fakeDb(rows = ROWS) {
  const db = { reads: 0, prepare(sql) {
    t.ok(/FROM player_id_map/.test(sql), "only the id map is read");
    return { all: async () => { db.reads += 1; return { results: rows }; } };
  } };
  return db;
}
function fakeCache({ broken = false } = {}) {
  const store = new Map();
  return { store, puts: 0,
    async match(req) { if (broken) throw new Error("cache down"); const v = store.get(req.url); return v ? new Response(v.body, { headers: v.headers }) : undefined; },
    async put(req, res) { if (broken) throw new Error("cache down"); this.puts += 1; store.set(req.url, { body: await res.text(), headers: Object.fromEntries(res.headers) }); } };
}
const okFetch = async (url) => String(url).includes("injuries")
  ? new Response(JSON.stringify({ injuries: { week: "7", timestamp: "1792512064", injury: [{ id: "102", status: "IR", details: "Knee" }] } }), { status: 200 })
  : new Response("season,week,gsis_id,team,report_status\n", { status: 200, headers: { "last-modified": "Tue, 20 Oct 2026 13:00:00 GMT" } });

test("first call reads D1 once and stores the map; the next call reads nothing from D1", async () => {
  const db = fakeDb(), cache = fakeCache();
  const load = cachedIdMapLoader(db, { cache });
  const a = await load();
  t.equal(db.reads, 1, "one D1 read");
  t.equal(a.cached, false);
  t.equal(cache.puts, 1, "stored once");
  t.ok(cache.store.has(ID_MAP_CACHE_KEY), "namespaced key " + ID_MAP_CACHE_KEY);
  t.ok(/max-age=600/.test(cache.store.get(ID_MAP_CACHE_KEY).headers["cache-control"]), "10-minute entry");
  t.equal(ID_MAP_TTL_SECONDS, 600);
  const b = await cachedIdMapLoader(db, { cache })();
  t.equal(db.reads, 1, "second call: 0 D1 rows");
  t.equal(b.cached, true);
  t.deepEqual(b.rows, ROWS, "same rows");
});

test("a broken cache is a miss (reads D1), and an empty map is never stored", async () => {
  const db = fakeDb(), broken = fakeCache({ broken: true });
  const a = await cachedIdMapLoader(db, { cache: broken })();
  t.equal(db.reads, 1); t.deepEqual(a.rows, ROWS, "still answers");
  const empty = fakeDb([]), cache = fakeCache();
  await cachedIdMapLoader(empty, { cache })();
  t.equal(cache.puts, 0, "nothing cached for an empty map");
});

test("the route answer is identical with the cached loader and without it", async () => {
  const now = Date.parse("2026-10-20T16:00:00Z");
  const plain = await loadPlayerStatus(fakeDb(), { season: 2026, fetchImpl: okFetch, now });
  const cache = fakeCache();
  const viaCache1 = await loadPlayerStatus(fakeDb(), { season: 2026, fetchImpl: okFetch, now, idMap: cachedIdMapLoader(fakeDb(), { cache }) });
  const db2 = fakeDb();
  const viaCache2 = await loadPlayerStatus(db2, { season: 2026, fetchImpl: okFetch, now, idMap: cachedIdMapLoader(db2, { cache }) });
  t.deepEqual(viaCache1, plain, "first (miss) answer equals the uncached one");
  t.deepEqual(viaCache2, plain, "second (hit) answer equals the uncached one");
  t.equal(db2.reads, 0, "the hit read no D1 rows");
  t.equal(plain.players["102"].roster.chip, "IR", "a real answer, not an empty one");
  t.equal(plain.id_map_rows, 3);
});

test("the /api/player-status route uses the cached loader", () => {
  const src = fs.readFileSync(new URL("../worker/src/index.js", import.meta.url), "utf8");
  const at = src.indexOf('path === "/api/player-status"');
  t.ok(at > 0, "route found");
  const block = src.slice(at, src.indexOf("\n      }\n", at));
  t.ok(/loadPlayerStatus\(db, \{[^}]*idMap: cachedIdMapLoader\(db/.test(block), "route passes idMap: cachedIdMapLoader(db, …)");
});

await run("player_status_id_map_cache");
