#!/usr/bin/env node
// dryrun_gap01_measure_local_d1.mjs -- measure what the GAP-01 load would cost
// on D1, against a LOCAL in-memory Miniflare D1. Never touches production.
//
//   node pipelines/etl/scripts/dryrun_gap01_measure_local_d1.mjs --out <build out dir>
//
// Applies worker/migrations/manual/gap01_ups_hist_auction_bids.sql, runs the
// build's forward statements and sums D1's own meta.rows_written / rows_read
// (the counters Cloudflare bills), runs them again (must write 0), measures
// every read query listed in local_proof.json, then runs the rollback.
// Writes <out>/measure.json. Run `local-proof` first.
//
// Miniflare is the copy bundled with the globally installed wrangler; pass
// --miniflare <path to miniflare/dist/src/index.js> to override.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]]);
  return acc;
}, []));
if (!args.out) {
  console.error("usage: --out <build out dir> [--miniflare <index.js>]");
  process.exit(2);
}
const OUT = path.resolve(args.out);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCHEMA = path.join(REPO, "worker", "migrations", "manual", "gap01_ups_hist_auction_bids.sql");

function miniflarePath() {
  if (args.miniflare) return args.miniflare;
  const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  return path.join(root, "wrangler", "node_modules", "miniflare", "dist", "src", "index.js");
}

// One statement per entry: drop `--` comments, split on `;`.
function statementsOf(sql) {
  return sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n")
    .split(";").map((s) => s.trim()).filter(Boolean);
}

const { Miniflare } = await import(pathToFileURL(miniflarePath()).href);
const mf = new Miniflare({
  modules: true,
  script: "export default { fetch() { return new Response('local only'); } }",
  d1Databases: { DB: "dryrun-gap01-local" },
  d1Persist: false,
});
const db = await mf.getD1Database("DB");

async function runAll(stmts) {
  const t = { statements: stmts.length, rows_read: 0, rows_written: 0, changes: 0 };
  for (let i = 0; i < stmts.length; i += 50) {
    for (const r of await db.batch(stmts.slice(i, i + 50).map((sql) => db.prepare(sql)))) {
      t.rows_read += r.meta.rows_read || 0;
      t.rows_written += r.meta.rows_written || 0;
      t.changes += r.meta.changes || 0;
    }
  }
  return t;
}

const st = JSON.parse(fs.readFileSync(path.join(OUT, "statements.json"), "utf8"));
const proof = JSON.parse(fs.readFileSync(path.join(OUT, "local_proof.json"), "utf8"));
const summary = JSON.parse(fs.readFileSync(path.join(OUT, "summary.json"), "utf8"));
const result = { measured_at_utc: new Date().toISOString(), engine: "miniflare (local D1)", checks: [] };
const check = (name, pass, detail) => result.checks.push({ name, pass: Boolean(pass), detail });

result.schema = await runAll(statementsOf(fs.readFileSync(SCHEMA, "utf8")));
result.forward = await runAll(st.forward);
const rows = Object.values(summary.tables).reduce((a, b) => a + b, 0);
check("forward writes every row once", result.forward.changes === rows, { changes: result.forward.changes, rows });
check("forward billed writes = build estimate", result.forward.rows_written === summary.billed_writes_estimate,
  { rows_written: result.forward.rows_written, estimate: summary.billed_writes_estimate });
result.forward_again = await runAll(st.forward);
check("forward run again writes 0 rows", result.forward_again.rows_written === 0, result.forward_again);

result.reads = {};
for (const [name, q] of Object.entries(proof.plans)) {
  const r = await db.prepare(q.sql).all();
  const plan = (await db.prepare("EXPLAIN QUERY PLAN " + q.sql).all()).results.map((x) => x.detail);
  result.reads[name] = { rows: r.results.length, rows_read: r.meta.rows_read, plan };
}
result.rollback = await runAll(st.rollback);
const left = (await db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'ups_hist_auction%'").all()).results;
check("rollback leaves no table", left.length === 0, left);
result.pass = result.checks.every((c) => c.pass);
fs.writeFileSync(path.join(OUT, "measure.json"), JSON.stringify(result, null, 1));
for (const c of result.checks) console.log(`${c.pass ? "PASS" : "FAIL"} ${c.name}`);
for (const [n, r] of Object.entries(result.reads)) console.log(`read ${n}: rows ${r.rows}, rows_read ${r.rows_read}; ${r.plan.join(" | ")}`);
console.log(`forward: ${JSON.stringify(result.forward)}; rollback: ${JSON.stringify(result.rollback)}`);
await mf.dispose();
process.exit(result.pass ? 0 : 1);
