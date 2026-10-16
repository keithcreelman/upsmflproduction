// Finished-season Player Stats store (#1266): served whole from its stored copy, 0 D1 rows,
// identical for the phone and the desktop, and a VISIBLE failure — never the live query — when
// the copy can't be used.
//   node tests/leaderboard_store.test.mjs
//
// Drives the real builder (pipelines/etl/scripts/build_leaderboard_season_store.mjs buildSeason)
// over a generated 2015 season (650 linebackers, so a board past the old 500-row cap), then the
// real worker route with FPA_STORE answering from those bytes. D1 = node:sqlite, production schema.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { t, test, run } from "./fixtures/mini_test.mjs";
import * as harness from "./fixtures/fcfs_worker_harness.mjs";
import { LB_STORE, LB_STORE_VOLATILE, lbStoreRequest, lbStoreDir, _resetLbStoreMemo } from "../worker/src/leaderboard_store.js";
import { leaderboardQueryVersion } from "../pipelines/etl/lib/leaderboard_store_version.mjs";
import { buildSeason } from "../pipelines/etl/scripts/build_leaderboard_season_store.mjs";

const SRC = fs.readFileSync("worker/src/index.js", "utf8");
const worker = (await import("../worker/src/index.js")).default;
const SCHEMA = fs.readFileSync("tests/fixtures/leaderboard_schema_pre0169.sql", "utf8");
const MIG = ["0169_redzone_v2_epa_through_week.sql", "0170_player_id_map.sql"].map((f) => fs.readFileSync("worker/migrations/" + f, "utf8"));
const SEASON = 2015, LBS = 650;

// A finished season on disk, as the builder's replica would hold it.
function replicaFile() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lbstore-")), `replica_${SEASON}.db`);
  const db = new DatabaseSync(file);
  db.exec(SCHEMA); MIG.forEach((m) => db.exec(m));
  const wk = db.prepare(`INSERT INTO nfl_player_weekly (season, week, gsis_id, position, pos_group, team, def_tackles_solo, targets, receptions, rec_yds)
                         VALUES (${SEASON}, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const sw = db.prepare(`INSERT INTO src_weekly (season, week, player_id, pos_group, score) VALUES (${SEASON}, ?, ?, ?, ?)`);
  const ff = db.prepare("INSERT INTO ff_player_ids (mfl_id, gsis_id) VALUES (?, ?)");
  for (let i = 0; i < LBS; i++) {
    const g = "00-LB" + String(i).padStart(4, "0"), mfl = String(20000 + i);
    ff.run(mfl, g);
    for (let w = 1; w <= 3; w++) { wk.run(w, g, "LB", "LB", "T" + (i % 32), 1 + (i % 9), 0, 0, 0); sw.run(w, mfl, "LB", 2 + (i % 7)); }
    wk.run(16, g, "LB", "LB", "T" + (i % 32), 2, 0, 0, 0);
  }
  for (let i = 0; i < 40; i++) {
    const g = "00-WR" + String(i).padStart(4, "0"), mfl = String(30000 + i);
    ff.run(mfl, g);
    for (let w = 1; w <= 17; w++) { wk.run(w, g, "WR", "WR", "T" + (i % 32), 0, 5, 3, 30 + i); sw.run(w, mfl, "WR", 8 + (i % 5)); }
  }
  // An owner's player: today's MFL owner/contract must NOT be frozen into the stored copy.
  db.prepare("INSERT INTO src_contracts (season, player_id, franchise_id, team_name, salary, contract_year) VALUES (2026, '30001', '0005', 'Owner Five', 12000, 2)").run();
  db.prepare("INSERT INTO player_id_crosswalk (mfl_player_id, gsis_id, confidence) VALUES (30001, '00-WR0001', 'exact')").run();
  db.close();
  return file;
}

let built = null;
async function store() {
  if (built) return built;
  const store = { ...LB_STORE, volatile: LB_STORE_VOLATILE };
  const r = await buildSeason({ season: SEASON, replica: replicaFile(), outDir: null, store, builtAt: "2026-10-15T00:00:00.000Z", harness });
  built = { files: r.files, checked: r.checked, store };
  return built;
}

// The worker over an EMPTY D1 (a stored answer must need none of it) and FPA_STORE serving `files`.
function envWith(files, { manifest } = {}) {
  const env = harness.makeWorkerEnv();   // empty D1: any query a stored answer made would show in env.UPS_MFL_DB.log
  const dir = lbStoreDir();
  const m = manifest || { format: LB_STORE.format, query_version: LB_STORE.query_version, files: Object.fromEntries(Object.entries(files).map(([n, f]) => [n, f.entry])) };
  env.FPA_STORE = { fetch: async (req) => {
    const rel = new URL(req.url).pathname.slice(1);
    if (rel === dir + "/manifest.json") return m === "missing" ? new Response("", { status: 404 }) : new Response(typeof m === "string" ? m : JSON.stringify(m));
    const f = files[rel.slice(dir.length + 1)];
    return f ? new Response(f.gz) : new Response("", { status: 404 });
  } };
  _resetLbStoreMemo();
  return env;
}
async function get(env, qs) {
  const restore = harness.quiet();
  try {
    const res = await worker.fetch(new Request("https://worker.test/api/advanced-stats-leaderboard?" + qs), env, { waitUntil() {}, passThroughOnException() {} });
    const buf = Buffer.from(await res.arrayBuffer());
    const bytes = res.headers.get("content-encoding") === "gzip" ? zlib.gunzipSync(buf) : buf;
    return { status: res.status, headers: res.headers, bytes, json: JSON.parse(bytes.toString() || "null") };
  } finally { restore(); }
}
const desk = (pos, lo, hi, extra = "") => `seasons=${SEASON}&pos=${pos}&week_min=${lo}&week_max=${hi}&min_games=1&limit=500${extra}&YEAR=2026&L=74598`;
const phone = (pos, extra = "") => `season=${SEASON}&pos=${pos}&min_games=1&limit=500${extra}&YEAR=2026&L=74598`;

test("the calculation version this worker serves is the one its leaderboard code hashes to", () => {
  t.equal(LB_STORE.query_version, leaderboardQueryVersion(SRC),
    "the leaderboard SQL or row code changed: set LB_STORE.query_version to the new value and rebuild every stored season");
});

test("which requests the store answers", () => {
  const base = { seasons: [2019], pos: "idp", minGames: 1 };
  const cases = [
    [{ ...base }, { season: 2019, board: "idp", lo: 1, hi: 17 }, "the phone's request (no week params) is Wks 1-17"],
    [{ ...base, weekMin: 1, weekMax: 17 }, { season: 2019, board: "idp", lo: 1, hi: 17 }, "MFL Total"],
    [{ ...base, weekMin: 1, weekMax: 14 }, { season: 2019, board: "idp", lo: 1, hi: 14 }, "MFL Reg"],
    [{ ...base, weekMin: 15, weekMax: 17 }, { season: 2019, board: "idp", lo: 15, hi: 17 }, "MFL Playoffs"],
    [{ ...base, weekMin: 1, weekMax: 22 }, { season: 2019, board: "idp", lo: 1, hi: 22 }, "Full + NFL playoffs"],
    [{ ...base, weekMin: 3, weekMax: 9 }, null, "a custom range runs live"],
    [{ ...base, weeksParam: "1,3" }, null, "a week list runs live"],
    [{ ...base, teamFilter: "0005" }, null, "a team filter runs live"],
    [{ ...base, minGames: 3 }, null, "min_games > 1 runs live"],
    [{ ...base, includePost: true }, null, "include_post runs live"],
    [{ ...base, seasons: [2018, 2019] }, null, "two seasons run live"],
    [{ ...base, seasons: [2026] }, null, "the current season stays live"],
    [{ ...base, seasons: [2010] }, null, "before 2011 isn't stored"],
    [{ ...base, noPrecompute: true }, null, "NO_PRECOMPUTE (the builder itself) runs live"],
    [{ ...base, pos: "flex" }, null, "an unknown board"],
  ];
  for (const [p, want, why] of cases) t.deepEqual(lbStoreRequest(p), want, why);
});

test("the builder's own check: every stored file served back equals the live route", async () => {
  const s = await store();
  t.equal(s.checked, 20, "5 boards x 4 windows");
  t.equal(s.files[`${SEASON}/idp_1-17.json.gz`].entry.row_count, LBS, "every linebacker — no 500-row cap");
});

test("a stored board: whole, 0 D1 rows, today's owner fields left out", async () => {
  const s = await store();
  const env = envWith(s.files);
  const r = await get(env, desk("idp", 1, 17));
  t.equal(r.status, 200);
  t.equal(r.json.rows.length, LBS, "one answer carries the whole board");
  t.equal(r.json.next_offset, null);
  t.equal(r.json.source, "stored");
  t.equal(r.headers.get("X-UPS-Store"), `${lbStoreDir()}/${SEASON}/idp_1-17.json.gz`);
  t.equal(env.UPS_MFL_DB.log.length, 0, "no D1 query at all");
  t.deepEqual([r.json.store.season, r.json.store.board, r.json.store.window, r.json.store.query_version, r.json.store.built_at_utc],
    [SEASON, "idp", { week_min: 1, week_max: 17 }, LB_STORE.query_version, "2026-10-15T00:00:00.000Z"]);
  t.ok(/^[0-9a-f]{64}$/.test(r.json.store.rows_sha256), "the rows' checksum is recorded");
  const wr = (await get(env, desk("skill", 1, 17))).json.rows.find((x) => x.gsis_id === "00-WR0001");
  t.ok(wr && LB_STORE_VOLATILE.every((k) => !(k in wr)), "no MFL owner, contract or current team in the stored row");
});

test("the phone and the desktop get the same bytes; a later page is the empty last one", async () => {
  const s = await store();
  const env = envWith(s.files);
  const d = await get(env, desk("idp", 1, 17)), p = await get(env, phone("idp"));
  t.equal(Buffer.compare(d.bytes, p.bytes), 0, "phone request = desktop request, byte for byte");
  const p2 = await get(env, phone("idp", "&offset=500"));
  t.deepEqual([p2.status, p2.json.rows.length, p2.json.next_offset], [200, 0, null]);
  t.equal(env.UPS_MFL_DB.log.length, 0);
});

test("a stored copy that can't be used fails VISIBLY and never runs the live query", async () => {
  const s = await store();
  const name = `${SEASON}/qb_1-14.json.gz`;
  const corrupt = { ...s.files, [name]: { ...s.files[name], gz: Buffer.concat([s.files[name].gz.subarray(0, 40), Buffer.from([0]), s.files[name].gz.subarray(41)]) } };
  const missing = { ...s.files }; delete missing[name];
  const cases = [
    [envWith(corrupt), "checksum mismatch"],
    [envWith(missing, { manifest: { format: 1, query_version: LB_STORE.query_version, files: Object.fromEntries(Object.entries(s.files).map(([n, f]) => [n, f.entry])) } }), "missing (HTTP 404)"],
    [envWith(missing), "isn't in the manifest"],
    [envWith(s.files, { manifest: { format: 1, query_version: "0000000000000000", files: {} } }), "built by query 0000000000000000"],
    [envWith(s.files, { manifest: "missing" }), "manifest missing"],
    [envWith(s.files, { manifest: "{not json" }), "manifest unreadable"],
    [(() => { const e = envWith(s.files); delete e.FPA_STORE; return e; })(), "isn't bound"],
  ];
  for (const [env, why] of cases) {
    const r = await get(env, desk("qb", 1, 14));
    t.equal(r.status, 503, why);
    t.equal(r.json.error, "stored_board_unavailable", why);
    t.ok(String(r.json.reason).includes(why), `reason says "${why}": ${r.json.reason}`);
    t.equal(r.headers.get("Cache-Control"), "no-store", "a failure is never cached");
    t.equal(env.UPS_MFL_DB.log.length, 0, why + ": no live fallback");
  }
});

test("everything else is unchanged: custom windows, the current season and the builder run live", async () => {
  const s = await store();
  for (const qs of [desk("idp", 3, 9), `seasons=2026&pos=idp&week_min=1&week_max=14&min_games=1&limit=500&YEAR=2026&L=74598`,
                    desk("idp", 1, 17, "&NO_PRECOMPUTE=1&NO_CACHE=1")]) {
    const env = envWith(s.files);
    const r = await get(env, qs);
    t.ok(!r.headers.get("X-UPS-Store"), qs + " is not served from the store");
    t.ok(env.UPS_MFL_DB.log.length > 0, qs + " runs the live path");
  }
});

await run("finished-season leaderboard store");
