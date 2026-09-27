// A Cloudflare-D1-shaped adapter over node:sqlite so worker code that calls
//   env.UPS_MFL_DB.prepare(sql).bind(...).first() / .all() / .run()
// runs against REAL SQLite semantics — including the real migration files'
// CHECK constraints — instead of a hand-rolled fake.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function makeD1(opts) {
  opts = opts || {};
  const db = new DatabaseSync(":memory:");
  const log = [];
  const wrap = (sql, args) => ({
    first: async () => { log.push({ sql, args }); if (opts.beforeRun) opts.beforeRun(sql, args, db); return db.prepare(sql).get(...args) || null; },
    all: async () => { log.push({ sql, args }); if (opts.beforeRun) opts.beforeRun(sql, args, db); return { results: db.prepare(sql).all(...args) }; },
    run: async () => {
      log.push({ sql, args });
      if (opts.failWrites && /^\s*(UPDATE|INSERT|DELETE)/i.test(sql)) throw new Error("D1_ERROR: simulated write failure");
      if (opts.beforeRun) opts.beforeRun(sql, args, db);
      const r = db.prepare(sql).run(...args);
      // D1 reports both; the worker reads last_row_id to learn an INSERT's id.
      return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  const d1 = {
    raw: db, log, opts,   // (a test can set d1.opts.beforeRun / failWrites at any time — e.g. make D1 fail AFTER MFL succeeded)
    // D1's exec(): run raw SQL (the worker lazily creates tables this way).
    async exec(sql) { if (opts.failWrites && /^\s*(CREATE|INSERT|UPDATE|DELETE)/i.test(sql)) throw new Error("D1_ERROR: simulated write failure"); db.exec(sql); return { count: 1 }; },
    prepare(sql) { return { bind: (...args) => wrap(sql, args), ...wrap(sql, []) }; },
    // D1 batch(): statements run in order inside ONE transaction; any failure rolls all back.
    async batch(stmts) {
      const out = [];
      db.exec("BEGIN");
      try { for (const st of stmts) out.push(await st.run()); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; }
      return out;
    },
  };
  return d1;
}

export function applyMigrations(d1, files) {
  // 0073 back-fills from the ETL-loaded src_contracts table; an empty one is exactly "no data" (its fallback branch handles that).
  if (files.some((f) => f.startsWith("0073_"))) d1.raw.exec("CREATE TABLE IF NOT EXISTS src_contracts (season INTEGER, player_id TEXT, contract_length INTEGER)");
  for (const f of files) d1.raw.exec(fs.readFileSync(path.join(ROOT, "worker", "migrations", f), "utf8"));
}
export const THREE_WAY_MIGRATIONS = ["0077_ups_3way_trades.sql", "0078_ups_3way_notes.sql", "0079_ups_3way_extensions.sql", "0159_ups_3way_admin_cancel.sql",
  // the extension-eligibility authorities (tag lock, extension history, restructure history) and the execution ledger
  "0030_tag_master.sql", "0035_extension_master.sql", "0073_extension_master_contract_end_year.sql", "0047_restructure_submissions.sql", "0160_ups_trade_executions.sql"];
// The tables as they were BEFORE 0159 — used to prove the administrative cancel fails closed until it is applied.
export const THREE_WAY_MIGRATIONS_BEFORE_0159 = THREE_WAY_MIGRATIONS.slice(0, 3);
