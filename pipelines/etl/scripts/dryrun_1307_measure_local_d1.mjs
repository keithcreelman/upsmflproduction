#!/usr/bin/env node
// dryrun_1307_measure_local_d1.mjs -- measure what the #1307 repair SQL would
// cost on D1, against a LOCAL in-memory Miniflare D1. Never touches production.
//
//   node pipelines/etl/scripts/dryrun_1307_measure_local_d1.mjs --out <build out dir>
//
// Loads the build's schema.json (src_weekly + its three indexes, copied from
// production sqlite_master) and before_rows.jsonl into a throwaway D1, then runs
// every statement in statements/*.json and sums D1's own meta.rows_read /
// meta.rows_written -- the counters Cloudflare bills. Order: forward A, B, C, E;
// forward again (must write 0); rollback E, C, B, A (must restore the exact
// before-state, compared by a hash over every row).
//
// Miniflare is the copy bundled with the globally installed wrangler; pass
// --miniflare <path to miniflare/dist/src/index.js> to override.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]]);
  return acc;
}, []));
if (!args.out) {
  console.error("usage: --out <build out dir> [--miniflare <index.js>]");
  process.exit(2);
}
const OUT = path.resolve(args.out);
const COLS = ["season", "week", "player_id", "pos_group", "status", "score", "is_reg",
  "roster_franchise_id", "roster_franchise_name", "pos_rank", "overall_rank", "win_chunks"];

function miniflarePath() {
  if (args.miniflare) return args.miniflare;
  const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  return path.join(root, "wrangler", "node_modules", "miniflare", "dist", "src", "index.js");
}

const { Miniflare } = await import(pathToFileURL(miniflarePath()).href);
const mf = new Miniflare({
  modules: true,
  script: "export default { fetch() { return new Response('local only'); } }",
  d1Databases: { DB: "dryrun-1307-local" },
  d1Persist: false,
});
const db = await mf.getD1Database("DB");

async function tableHash() {
  const res = await db.prepare(`SELECT ${COLS.join(", ")} FROM src_weekly ORDER BY season, week, player_id`).all();
  const h = createHash("sha256");
  for (const r of res.results) h.update(JSON.stringify(COLS.map((c) => r[c])) + "\n");
  return { rows: res.results.length, sha256: h.digest("hex") };
}

async function runAll(stmts) {
  // One request per 200 statements (a request per statement exhausts local
  // ports at ~80k statements); D1 still reports meta for each statement.
  const t = { statements: stmts.length, rows_read: 0, rows_written: 0, changes: 0 };
  for (let i = 0; i < stmts.length; i += 200) {
    for (const r of await db.batch(stmts.slice(i, i + 200).map((sql) => db.prepare(sql)))) {
      t.rows_read += r.meta.rows_read || 0;
      t.rows_written += r.meta.rows_written || 0;
      t.changes += r.meta.changes || 0;
    }
  }
  return t;
}

// Schema exactly as production holds it (tables first, then indexes).
const schema = JSON.parse(fs.readFileSync(path.join(OUT, "schema.json"), "utf8"))
  .sort((a, b) => (a.type === "table" ? 0 : 1) - (b.type === "table" ? 0 : 1));
for (const r of schema) if (r.sql) await db.prepare(r.sql).run();
const cols = (await db.prepare("PRAGMA table_info(src_weekly)").all()).results.map((c) => c.name);
if (!cols.includes("win_chunks")) await db.prepare("ALTER TABLE src_weekly ADD COLUMN win_chunks REAL").run();

const before = fs.readFileSync(path.join(OUT, "before_rows.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
const ins = db.prepare(`INSERT INTO src_weekly (${COLS.join(", ")}) VALUES (${COLS.map(() => "?").join(", ")})`);
for (let i = 0; i < before.length; i += 500) {
  await db.batch(before.slice(i, i + 500).map((r) => ins.bind(...COLS.map((c) => (r[c] === undefined ? null : r[c])))));
}
const h0 = await tableHash();

const files = fs.readdirSync(path.join(OUT, "statements")).filter((f) => f.endsWith(".json"));
const order = files.map((f) => f.replace(/\.json$/, "")).sort((a, b) => ("ABCE".indexOf(a[0]) - "ABCE".indexOf(b[0])) || a.localeCompare(b));
const stmts = Object.fromEntries(order.map((n) => [n, JSON.parse(fs.readFileSync(path.join(OUT, "statements", n + ".json"), "utf8"))]));

const report = { run_at_utc: new Date().toISOString(), engine: "miniflare D1 (local, in-memory)", before: h0, phases: {} };
for (const n of order) report.phases[n] = { forward: await runAll(stmts[n].forward) };
report.after_forward = await tableHash();
for (const n of order) report.phases[n].rerun = await runAll(stmts[n].forward);
report.after_rerun = await tableHash();
for (const n of [...order].reverse()) report.phases[n].rollback = await runAll(stmts[n].rollback);
report.after_rollback = await tableHash();

const sum = (k, f) => order.reduce((acc, n) => acc + report.phases[n][k][f], 0);
report.totals = {
  forward_rows_written: sum("forward", "rows_written"),
  forward_rows_read: sum("forward", "rows_read"),
  rerun_rows_written: sum("rerun", "rows_written"),
  rerun_rows_read: sum("rerun", "rows_read"),
  rollback_rows_written: sum("rollback", "rows_written"),
  rollback_rows_read: sum("rollback", "rows_read"),
};
report.ok = report.totals.rerun_rows_written === 0
  && report.after_rerun.sha256 === report.after_forward.sha256
  && report.after_rollback.sha256 === h0.sha256;
fs.writeFileSync(path.join(OUT, "d1_measure.json"), JSON.stringify(report, null, 1));
console.log(JSON.stringify({ before: h0, after_forward: report.after_forward, after_rollback: report.after_rollback, totals: report.totals, ok: report.ok }));
await mf.dispose();
process.exit(report.ok ? 0 : 1);
