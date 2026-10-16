#!/usr/bin/env node
// Build the finished-season Player Stats store (#1266). READ-ONLY on every source: D1 SELECTs
// through `wrangler d1 execute --remote`, nothing else.
//
// For each finished season it copies the rows the leaderboard reads for that season (about 80k
// D1 rows; the id maps and names once per run) into a local SQLite file, runs THIS checkout's
// real /api/advanced-stats-leaderboard route over it (tests/fixtures/fcfs_worker_harness.mjs:
// the worker under Node, D1 = node:sqlite) for every board x preset window, following every
// page, and writes
//   worker/fpa_store/lb1/<query_version>/<season>/<board>_<lo>-<hi>.json.gz
//   worker/fpa_store/lb1/<query_version>/manifest.json
// Each file is the route's own response body for the whole board (no 500-row cap), minus the
// six fields that describe today (owner, contract, current NFL team), plus a `store` block:
// calculation version, season, board, window, build time, row count, the rows' SHA-256 and the
// fingerprints of the inputs it was built from. The manifest holds each gzip file's SHA-256;
// the worker refuses (visibly) any file that doesn't match.
//
// Before writing, every file is served back through the worker's stored path in the same harness
// and must equal the live route's answer byte for byte.
//
//   node pipelines/etl/scripts/build_leaderboard_season_store.mjs --replica-dir ~/ups-lb-replicas
//   node pipelines/etl/scripts/build_leaderboard_season_store.mjs --replica-dir … --seasons 2019
//   node pipelines/etl/scripts/build_leaderboard_season_store.mjs --replica-dir … --check   # compare, write nothing
//   --refresh   re-read the season's rows from D1 even when the replica file exists
//   --out <dir> write the store under <dir> instead of worker/fpa_store (a preview build)
//
// Rebuild: after any change that moves LB_STORE.query_version (the test says so), or when a
// finished season's MFL scores or nflverse rows are corrected (--refresh --seasons <that season>).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { leaderboardQueryVersion } from "../lib/leaderboard_store_version.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const STORE_ROOT = path.join(ROOT, "worker", "fpa_store");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

// The leaderboard's inputs. SEASON tables are copied one season at a time (by week where large);
// SHARED tables once per run. src_players / src_contracts feed only the dropped "today" fields
// and the MFL position fallback, so the latest season of each is what the live route reads too.
const SEASON_TABLES = [["nfl_player_weekly", "week"], ["nfl_player_weekly_ext", "week"], ["nfl_player_redzone", "week"],
  ["nfl_player_snaps", "week"], ["nfl_team_weekly", null], ["nfl_team_pace", null], ["nfl_player_advstats_season", null], ["src_weekly", "week"]];
const SHARED_TABLES = { player_id_map: "1=1", ff_player_ids: "1=1", player_id_crosswalk: "1=1", nfl_player_names: "1=1",
  src_players: "season = (SELECT MAX(season) FROM src_players)", src_contracts: "season = (SELECT MAX(season) FROM src_contracts)" };
const ALL_TABLES = SEASON_TABLES.map(([t]) => t).concat(Object.keys(SHARED_TABLES));

function makeQuery(cwd, budget) {
  let spent = 0;
  const q = (sql) => {
    if (!/^\s*SELECT\b/i.test(sql) || /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|ATTACH|PRAGMA)\b/i.test(sql)) throw new Error("refused: only SELECT is allowed here");
    for (let i = 0; ; i++) {
      try {
        const out = execFileSync("npx", ["--yes", "wrangler@4.87.0", "d1", "execute", "ups-mfl-db", "--remote", "--json", "--command", sql],
          { cwd, maxBuffer: 1 << 29, stdio: ["ignore", "pipe", "pipe"] }).toString();
        const d = JSON.parse(out.slice(out.indexOf("[")))[0];
        spent += Number(d.meta && d.meta.rows_read) || 0;
        if (spent > budget) throw Object.assign(new Error(`STOP: ${spent} rows read, over the ${budget} budget`), { fatal: true });
        return d.results;
      } catch (e) {
        if (e.fatal || i >= 3) throw e;
        execFileSync("sleep", [String(3 * (i + 1))]);
      }
    }
  };
  q.spent = () => spent;
  return q;
}

const insertRows = (db, table, rows) => {
  if (!rows.length) return;
  const gen = new Set(db.prepare(`PRAGMA table_xinfo(${table})`).all().filter((c) => c.hidden === 2 || c.hidden === 3).map((c) => c.name));
  const cols = Object.keys(rows[0]).filter((c) => !gen.has(c));
  const st = db.prepare(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
  db.exec("BEGIN"); for (const r of rows) st.run(...cols.map((c) => r[c])); db.exec("COMMIT");
};

// One season's replica file: schema from production, the season's rows, the shared tables.
function ensureReplica(dir, season, q, { refresh, shared }) {
  const file = path.join(dir, `replica_${season}.db`);
  if (fs.existsSync(file) && !refresh) return file;
  if (fs.existsSync(file)) fs.rmSync(file);
  const db = new DatabaseSync(file);
  for (const o of shared.schema) if (o.type === "table" && o.sql) db.exec(o.sql);
  for (const [t, rows] of Object.entries(shared.rows)) insertRows(db, t, rows);
  for (const [t, chunk] of SEASON_TABLES) {
    const parts = chunk ? Array.from({ length: 22 }, (_, i) => `season = ${season} AND ${chunk} = ${i + 1}`) : [`season = ${season}`];
    for (const p of parts) insertRows(db, t, q(`SELECT * FROM ${t} WHERE ${p}`));
  }
  for (const o of shared.schema) if (o.type === "index" && o.sql) db.exec(o.sql);
  db.close();
  return file;
}

// Fingerprints of what a season was built from: per table, its row count and a SHA-256 of its
// rows (canonical JSON, sorted). A corrected source row changes them.
function inputFingerprint(file, season) {
  const db = new DatabaseSync(file, { readOnly: true });
  const out = {};
  for (const t of ALL_TABLES) {
    const rows = db.prepare(`SELECT * FROM ${t}`).all().map((r) => JSON.stringify(Object.keys(r).sort().map((k) => [k, r[k]]))).sort();
    out[t] = { rows: rows.length, sha256: sha(rows.join("\n")).slice(0, 16) };
  }
  db.close();
  return out;
}

export async function buildSeason({ season, replica, outDir, store, builtAt, harness }) {
  const { makeWorkerEnv, callWorker, quiet } = harness;
  const env = makeWorkerEnv();
  const raw = env.UPS_MFL_DB.raw;
  raw.exec(`ATTACH '${replica.replace(/'/g, "''")}' AS r`);
  for (const { name, sql } of raw.prepare("SELECT name, sql FROM r.sqlite_master WHERE type='table' AND sql IS NOT NULL").all()) {
    raw.exec(sql);
    const cols = raw.prepare(`PRAGMA r.table_xinfo(${name})`).all().filter((c) => c.hidden !== 2 && c.hidden !== 3).map((c) => c.name);
    raw.exec(`INSERT INTO main.${name} (${cols.join(",")}) SELECT ${cols.join(",")} FROM r.${name}`);
  }
  for (const { sql } of raw.prepare("SELECT sql FROM r.sqlite_master WHERE type='index' AND sql IS NOT NULL").all()) raw.exec(sql);
  raw.exec("DETACH r");
  const { computeMflScoresFingerprint } = await import(pathToFileURL(path.join(ROOT, "worker/src/leaderboard_coverage.js")).href);
  const mflFp = await computeMflScoresFingerprint(env.UPS_MFL_DB, season);
  const inputs = inputFingerprint(replica, season);
  const files = {};
  for (const board of store.boards) for (const [lo, hi] of store.windows) {
    let rows = [], offset = 0, first = null, pages = 0;
    for (;;) {
      const restore = quiet();
      let r;
      try { r = await callWorker(env, "GET", `/api/advanced-stats-leaderboard?seasons=${season}&pos=${board}&week_min=${lo}&week_max=${hi}&min_games=1&limit=500&offset=${offset}&NO_PRECOMPUTE=1&NO_CACHE=1&YEAR=${store.lastSeason + 1}&L=74598`); }
      finally { restore(); }
      if (r.status !== 200 || !r.json || !Array.isArray(r.json.rows)) throw new Error(`${season} ${board} ${lo}-${hi} @${offset}: HTTP ${r.status} ${String(r.text).slice(0, 200)}`);
      if (!first) first = r.json;
      rows = rows.concat(r.json.rows); pages++;
      if (r.json.next_offset == null) break;
      offset = r.json.next_offset;
      if (pages > 40) throw new Error(`${season} ${board}: more than 40 pages`);
    }
    const kept = rows.map((x) => { const y = { ...x }; for (const k of store.volatile) delete y[k]; return y; });
    const name = `${season}/${board}_${lo}-${hi}.json.gz`;
    const body = {
      seasons: [season], pos: board, include_post: false, min_games: 1, team: null,
      count: kept.length, limit: null, offset: 0, next_offset: null, source: "stored",
      store: { format: store.format, query_version: store.query_version, season, board, window: { week_min: lo, week_max: hi },
               built_at_utc: builtAt, row_count: kept.length, rows_sha256: sha(JSON.stringify(kept)),
               mfl_scores_fingerprint: mflFp, inputs, not_stored: store.volatile },
      rows: kept,
    };
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(body)), { level: 9 });
    files[name] = { gz, kept, entry: { sha256_gz: sha(gz), bytes_gz: gz.length, bytes_json: Buffer.byteLength(JSON.stringify(body)),
                                       row_count: kept.length, rows_sha256: body.store.rows_sha256, built_at_utc: builtAt, pages } };
  }
  // Self-check: serve every file back through the worker's STORED path (FPA_STORE answering
  // from these bytes) and require the live route's rows exactly; the phone's request shape
  // (no week params) and the desktop's (week_min=1&week_max=17) must get the same bytes.
  const { lbStoreDir, _resetLbStoreMemo } = await import(pathToFileURL(path.join(ROOT, "worker/src/leaderboard_store.js")).href);
  const dir = lbStoreDir(store);
  const manifest = { format: store.format, query_version: store.query_version, files: Object.fromEntries(Object.entries(files).map(([n, f]) => [n, f.entry])) };
  env.FPA_STORE = { fetch: async (req) => {
    const rel = new URL(req.url).pathname.slice(1);
    if (rel === dir + "/manifest.json") return new Response(JSON.stringify(manifest));
    const f = files[rel.slice(dir.length + 1)];
    return f ? new Response(f.gz) : new Response("", { status: 404 });
  } };
  _resetLbStoreMemo();
  const worker = (await import(pathToFileURL(path.join(ROOT, "worker/src/index.js")).href)).default;
  const get = async (qs) => {
    const res = await worker.fetch(new Request("https://worker.test/api/advanced-stats-leaderboard?" + qs), env, { waitUntil() {}, passThroughOnException() {} });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, store: res.headers.get("X-UPS-Store"), bytes: res.headers.get("content-encoding") === "gzip" ? zlib.gunzipSync(buf) : buf };
  };
  let checked = 0;
  for (const [name, f] of Object.entries(files)) {
    const [, board, lo, hi] = name.match(/^\d+\/(\w+)_(\d+)-(\d+)\.json\.gz$/);
    const r = await get(`seasons=${season}&pos=${board}&week_min=${lo}&week_max=${hi}&min_games=1&limit=500`);
    if (r.status !== 200 || !r.store) throw new Error(`${name}: the stored path didn't answer (HTTP ${r.status})`);
    if (JSON.stringify(JSON.parse(r.bytes).rows) !== JSON.stringify(f.kept)) throw new Error(`${name}: stored rows differ from the live route's`);
    if (lo === "1" && hi === "17") {
      const m = await get(`season=${season}&pos=${board}&min_games=1&limit=500`);
      if (Buffer.compare(m.bytes, r.bytes) !== 0) throw new Error(`${name}: the phone's request got different bytes from the desktop's`);
    }
    checked++;
  }
  return { files, mflFp, checked };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const replicaDir = opt("--replica-dir");
  if (!replicaDir) { console.error("--replica-dir <dir outside the repo> is required"); process.exit(2); }
  fs.mkdirSync(replicaDir, { recursive: true });
  const { LB_STORE, LB_STORE_VOLATILE, lbStoreDir } = await import(pathToFileURL(path.join(ROOT, "worker/src/leaderboard_store.js")).href);
  const qv = leaderboardQueryVersion(fs.readFileSync(path.join(ROOT, "worker/src/index.js"), "utf8"));
  if (qv !== LB_STORE.query_version) {
    console.error(`LB_STORE.query_version is ${LB_STORE.query_version} but index.js is ${qv}: set it to ${qv} first, then rebuild every season.`);
    process.exit(2);
  }
  const store = { ...LB_STORE, volatile: LB_STORE_VOLATILE };
  const want = (opt("--seasons") || `${store.firstSeason}-${store.lastSeason}`).split(",").flatMap((p) => {
    const [a, b] = p.split("-").map(Number); return b ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a];
  });
  const check = args.includes("--check"), refresh = args.includes("--refresh");
  const q = makeQuery(opt("--wrangler-cwd") || path.join(ROOT, "worker"), Number(opt("--budget") || 2_500_000));
  let shared = null;
  const needShared = want.some((s) => refresh || !fs.existsSync(path.join(replicaDir, `replica_${s}.db`)));
  if (needShared) {
    const schema = q(`SELECT type, name, sql FROM sqlite_master WHERE tbl_name IN (${ALL_TABLES.map((t) => `'${t}'`).join(",")})`);
    const rows = {};
    for (const [t, where] of Object.entries(SHARED_TABLES)) rows[t] = q(`SELECT * FROM ${t} WHERE ${where}`);
    shared = { schema, rows };
  }
  const harness = await import(pathToFileURL(path.join(ROOT, "tests/fixtures/fcfs_worker_harness.mjs")).href);
  const storeRoot = opt("--out") ? path.resolve(opt("--out")) : STORE_ROOT;
  const outDir = path.join(storeRoot, lbStoreDir(store));
  const manifestFile = path.join(outDir, "manifest.json");
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, "utf8"))
    : { format: store.format, query_version: store.query_version, boards: store.boards, windows: store.windows, files: {} };
  const builtAt = new Date().toISOString();
  let failed = 0;
  for (const season of want) {
    if (season < store.firstSeason || season > store.lastSeason) { console.log(`${season}: REFUSED — outside LB_STORE ${store.firstSeason}-${store.lastSeason}`); failed++; continue; }
    const replica = ensureReplica(replicaDir, season, q, { refresh, shared });
    const { files, checked } = await buildSeason({ season, replica, outDir, store, builtAt, harness });
    let rowsTotal = 0, gzTotal = 0, drift = 0;
    for (const [name, f] of Object.entries(files)) {
      rowsTotal += f.entry.row_count; gzTotal += f.entry.bytes_gz;
      if (check) {
        const old = manifest.files[name];
        if (!old || old.rows_sha256 !== f.entry.rows_sha256) { drift++; console.log(`  ${name}: ${old ? "rows DIFFER from" : "not in"} the committed store`); }
        continue;
      }
      fs.mkdirSync(path.dirname(path.join(outDir, name)), { recursive: true });
      fs.writeFileSync(path.join(outDir, name), f.gz);
      manifest.files[name] = f.entry;
    }
    console.log(`${season}: ${Object.keys(files).length} boards · ${rowsTotal} rows · ${(gzTotal / 1024).toFixed(0)} KB gzip · ${checked} served back = live${check ? ` · ${drift} differ` : ""}`);
    if (check && drift) failed++;
  }
  if (!check) {
    manifest.built_at_utc = builtAt;
    manifest.seasons = [...new Set(Object.keys(manifest.files).map((n) => Number(n.split("/")[0])))].sort();
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 1));
    for (const d of fs.readdirSync(path.join(storeRoot, `lb${store.format}`))) if (d !== store.query_version) {
      fs.rmSync(path.join(storeRoot, `lb${store.format}`, d), { recursive: true }); console.log("removed old store folder lb" + store.format + "/" + d);
    }
  }
  console.log(`D1 rows read: ${q.spent()}`);
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main().catch((e) => { console.error(e); process.exit(1); });
