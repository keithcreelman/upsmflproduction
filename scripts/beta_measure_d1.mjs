#!/usr/bin/env node
// Measures the D1 cost of the mobile beta's session queries (#1475, Stage 1) on a LOCAL Miniflare D1, never production.
//
//   node scripts/beta_measure_d1.mjs [--json out.json]
//
// Miniflare (the local workerd) reports meta.rows_read / meta.rows_written per statement, as production D1 does (the same technique as the
// leaderboard measurement in docs/D1_QUERY_RULES.md; local numbers matched production within about 5% there). This script runs the REAL store
// (worker/src/beta_session.js) and the REAL flag reader (worker/src/feature_flags.js) against the real migration, on a table filled to a
// realistic steady state, and prints MEASURED per-operation costs, then daily ESTIMATES from stated traffic assumptions.
// It starts a local workerd process and needs Wrangler installed (it finds Miniflare inside it). It is NOT part of the safe test suite.
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as B from "../worker/src/beta_session.js";
import { getFeatureFlagsFor } from "../worker/src/feature_flags.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jsonOut = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : "";

// ── traffic ASSUMPTIONS (stated, not measured; change them here) ──
const A = { owners: 12, sessionsPerOwnerPerDay: 2, betaRequestsPerOwnerPerDay: 100, sweepsPerDay: 24, steadyLivePerOwner: 3, oldExpiredRows: 100 };

const wr = fs.realpathSync(execSync("which wrangler").toString().trim());
const req = createRequire(wr.slice(0, wr.indexOf("/wrangler/") + "/wrangler".length) + "/package.json");
const { Miniflare } = req("miniflare");
const mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok'); } }", d1Databases: { DB: "beta-measure" }, compatibilityDate: "2026-02-02" });
const raw = await mf.getD1Database("DB");

// A D1-shaped wrapper that records every statement's meta (first() is run as all() so its meta is visible).
const log = [];
const norm = (s) => s.replace(/\s+/g, " ").trim();
const db = {
  prepare(sql) {
    const mk = (args) => ({
      _sql: sql, _stmt: () => raw.prepare(sql).bind(...args),
      run: async () => { const r = await raw.prepare(sql).bind(...args).run(); log.push({ sql: norm(sql), meta: r.meta }); return r; },
      all: async () => { const r = await raw.prepare(sql).bind(...args).all(); log.push({ sql: norm(sql), meta: r.meta }); return r; },
      first: async () => { const r = await raw.prepare(sql).bind(...args).all(); log.push({ sql: norm(sql), meta: r.meta }); return r.results[0] || null; },
    });
    return { bind: (...args) => mk(args), ...mk([]) };
  },
  async batch(stmts) { const out = await raw.batch(stmts.map((s) => s._stmt())); out.forEach((r, i) => log.push({ sql: norm(stmts[i]._sql), meta: r.meta })); return out; },
};
const take = () => { const l = log.splice(0); return { reads: l.reduce((n, x) => n + (x.meta.rows_read || 0), 0), writes: l.reduce((n, x) => n + (x.meta.rows_written || 0), 0), statements: l.length, detail: l }; };

// apply the real migration, statement by statement (comments stripped; D1 exec() reads one statement per line)
for (const stmt of fs.readFileSync(path.join(ROOT, "worker/migrations/0176_beta_sessions.sql"), "utf8").replace(/--[^\n]*/g, "").split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean)) await raw.prepare(stmt).run();
await raw.exec("CREATE TABLE IF NOT EXISTS ups_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)");
await raw.prepare("INSERT INTO ups_settings (key, value) VALUES ('feature_flags', ?)").bind(JSON.stringify({ BETA_ENABLED: "1", BETA_FLOW_LINEUP: "1" })).run();

const store = B.makeBetaStore(db);
const keyEnv = { BETA_SESSION_KEY: `k1:${B.b64urlEncode(new Uint8Array(32).fill(5))}`, UPS_MFL_DB: db };
const keyring = B.parseKeyring(keyEnv);
const T0 = Date.now();
const fid = (i) => String(i).padStart(4, "0");

async function newHandoff(f, now) {
  const rowId = B.newRowId(), code = B.newHandoffCode();
  const sealed = await B.sealMflSession(keyring, { rowId, franchiseId: f, leagueId: "74598", environment: "live" }, "MFL-SESSION-" + "x".repeat(40));
  const r = await store.createHandoff({ rowId, franchiseId: f, leagueId: "74598", environment: "live", codeHash: await B.sha256Hex(code), mflEnc: sealed.mflEnc, keyId: sealed.keyId, now });
  return { r, rowId, code };
}
async function activate(code, now) {
  const sid = B.newSessionId();
  const r = await store.redeem({ codeHash: await B.sha256Hex(code), environment: "live", sidHash: await B.sha256Hex(sid), now });
  return { r, sid, sidHash: await B.sha256Hex(sid) };
}

// ── steady state: 12 invited franchises, 3 live sessions each, plus (optionally) old expired rows ──
for (let i = 1; i <= A.owners; i++) await store.invite(fid(i), "74598", "live", "owner", T0);
async function reset(old) {
  await raw.prepare("DELETE FROM ups_beta_sessions").run();
  const live = [];
  for (let i = 1; i <= A.owners; i++) for (let k = 0; k < A.steadyLivePerOwner; k++) { const h = await newHandoff(fid(i), T0 + k); const s = await activate(h.code, T0 + k + 5); live.push({ f: fid(i), ...s }); }
  for (let i = 0; i < old; i++) await raw.prepare("INSERT INTO ups_beta_sessions (row_id, franchise_id, league_id, environment, handoff_expires_at, live_until, mfl_enc, key_id, created_at) VALUES (?, ?, '74598', 'live', 1, ?, ?, 'k1', 1)").bind("OLD" + i, fid(1 + (i % A.owners)), 1000 + i, "v1." + "a".repeat(16) + "." + "b".repeat(80)).run();
  take();
  return live;
}
const M = {};
const rec = (name, fn) => async () => { take(); const out = await fn(); M[name] = take(); return out; };

// group 1: the request path and the session lifecycle, on the steady-state table
let live = await reset(0);
const size = await raw.prepare("SELECT COUNT(*) AS n, SUM(LENGTH(row_id)+LENGTH(franchise_id)+LENGTH(league_id)+LENGTH(environment)+IFNULL(LENGTH(handoff_hash),0)+IFNULL(LENGTH(sid_hash),0)+IFNULL(LENGTH(mfl_enc),0)+IFNULL(LENGTH(key_id),0)+60) AS bytes FROM ups_beta_sessions").all();
const rows = size.results[0];
await rec("flags read (master + one flow)", () => getFeatureFlagsFor({ UPS_MFL_DB: db }, ["BETA_ENABLED", "BETA_FLOW_LINEUP"]))();
const probe = live[5];
await rec("session lookup (session + invitation)", () => store.lookup(probe.sidHash))();
const h = await rec("handoff: insert + cap eviction (franchise already has 3 live)", () => newHandoff(probe.f, T0 + 10_000))();
const act = await rec("redeem a handoff code", () => activate(h.code, T0 + 10_100))();
await rec("sign out (wipes the stored MFL session)", () => store.signout(act.sidHash, T0 + 20_000))();
await rec("is-invited lookup", () => store.isInvited(fid(2), "74598", "live"))();
await rec("invite (admin)", () => store.invite(fid(2), "74598", "live", "owner", T0 + 30_000))();
await rec("un-invite + revoke sessions (admin)", () => store.uninvite(fid(3), "74598", "live", T0 + 31_000))();
// group 2: purge on a freshly filled table
live = await reset(0);
await rec("purge every stored MFL session (admin)", () => store.purgeAll(T0 + 32_000))();
// group 3: deletion maintenance. Typical hour: 2 expired rows still holding ciphertext and 1 row past its 24-hour keep window.
live = await reset(0);
await raw.prepare("UPDATE ups_beta_sessions SET live_until = ? WHERE row_id IN (SELECT row_id FROM ups_beta_sessions LIMIT 2)").bind(T0 - 1000).run();
await raw.prepare("UPDATE ups_beta_sessions SET live_until = ? WHERE row_id IN (SELECT row_id FROM ups_beta_sessions WHERE live_until > ? LIMIT 1)").bind(T0 - B.KEEP_AFTER_EXPIRY_MS - 1000, T0).run();
take();
await rec("hourly sweep, typical (2 expired to wipe, 1 past 24 h to delete)", () => store.sweep(T0))();
await rec("hourly sweep, nothing to do", () => store.sweep(T0))();
live = await reset(A.oldExpiredRows);
await rec("sweep, worst case (100 old expired rows)", () => store.sweep(T0))();
const per = (n) => M[n];
const reqReads = per("flags read (master + one flow)").reads + per("session lookup (session + invitation)").reads;
const lifecycleWrites = per("handoff: insert + cap eviction (franchise already has 3 live)").writes + per("redeem a handoff code").writes + per("sign out (wipes the stored MFL session)").writes;
const sweepPerRow = (per("sweep, worst case (100 old expired rows)").writes) / A.oldExpiredRows;
const lifecycleReads = per("handoff: insert + cap eviction (franchise already has 3 live)").reads + per("redeem a handoff code").reads + per("sign out (wipes the stored MFL session)").reads;
const days = {
  reads: A.owners * A.betaRequestsPerOwnerPerDay * reqReads + A.owners * A.sessionsPerOwnerPerDay * lifecycleReads + A.sweepsPerDay * per("hourly sweep, nothing to do").reads,
  writes: A.owners * A.sessionsPerOwnerPerDay * (lifecycleWrites + sweepPerRow) + A.sweepsPerDay * per("hourly sweep, nothing to do").writes,
};
const THRESH = { readsPerRequest: 3, writesPerLifecycleIncludingCleanup: 20 };
const checks = {
  readsPerBetaRequest: { measured: reqReads, limit: THRESH.readsPerRequest, pass: reqReads <= THRESH.readsPerRequest },
  writesPerLifecycleWithCleanup: { measured: +(lifecycleWrites + sweepPerRow).toFixed(1), limit: THRESH.writesPerLifecycleIncludingCleanup, pass: lifecycleWrites + sweepPerRow <= THRESH.writesPerLifecycleIncludingCleanup },
};
const result = { measured_on: "local Miniflare D1 (workerd), NOT production", assumptions: A, steady_state: { rows: rows.n, approx_bytes: rows.bytes, approx_bytes_per_row: Math.round(rows.bytes / rows.n) }, measured: Object.fromEntries(Object.entries(M).map(([k, v]) => [k, { rows_read: v.reads, rows_written: v.writes, statements: v.statements }])), derived: { reads_per_beta_request: reqReads, writes_per_session_lifecycle_with_cleanup: +(lifecycleWrites + sweepPerRow).toFixed(1), sweep_writes_per_expired_row: sweepPerRow }, estimated_per_day: { rows_read: days.reads, rows_written: Math.round(days.writes), free_plan_read_share_pct: +(days.reads / 5_000_000 * 100).toFixed(3), free_plan_write_share_pct: +(days.writes / 100_000 * 100).toFixed(3) }, checks };

console.log("\nMEASURED (local Miniflare D1; one operation each; table at steady state):");
console.log("| operation | rows read | rows written | statements |\n|---|---|---|---|");
for (const [k, v] of Object.entries(M)) console.log(`| ${k} | ${v.reads} | ${v.writes} | ${v.statements} |`);
console.log(`\nsteady-state table: ${rows.n} rows, about ${rows.bytes} bytes (about ${Math.round(rows.bytes / rows.n)} bytes per row)`);
console.log(`\nDERIVED: ${reqReads} rows read per beta request; ${(lifecycleWrites + sweepPerRow).toFixed(1)} rows written per session lifecycle including its later deletion (${sweepPerRow} per swept row)`);
console.log(`\nESTIMATED from ASSUMED traffic (${A.owners} owners, ${A.sessionsPerOwnerPerDay} sessions/owner/day, ${A.betaRequestsPerOwnerPerDay} beta requests/owner/day, ${A.sweepsPerDay} sweeps/day):`);
console.log(`  ${days.reads} rows read/day (${result.estimated_per_day.free_plan_read_share_pct}% of the 5M Free limit); ${Math.round(days.writes)} rows written/day (${result.estimated_per_day.free_plan_write_share_pct}% of the 100k Free limit)`);
console.log("\nCHECKS:", JSON.stringify(checks));
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(result, null, 1));
await mf.dispose();
process.exit(Object.values(checks).every((c) => c.pass) ? 0 : 1);
