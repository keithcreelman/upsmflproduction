// Mobile beta, Stage 1 (#1475): the rule-drafting agent cannot read the beta's session tables, by ANY query.
//   node tests/beta_agent_denylist.test.mjs
//
// The agent (worker/src/rule_draft_agent.js) runs model-written SELECTs against the production D1 binding and sends the rows to a model provider.
// Hiding tables from its list_tables is not enough: this test drives the REAL tool dispatcher (list_tables, describe_table, run_sql) against real
// SQLite holding a canary row in ups_beta_sessions, and proves that direct reads, joins, subqueries, CTEs, quoted and re-cased names, schema
// qualification, UNIONs, comments and table-valued pragmas never return it. Ordinary queries still work (positive controls).
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeD1, applyMigrations } from "./fixtures/d1_sqlite.mjs";
await import("./fixtures/register_md_loader.mjs");      // the agent imports the league canon as text
const { executeTool, guardSql, runGuardedSql, touchesDeniedTable, DENIED_TABLE_PREFIXES } = await import("../worker/src/rule_draft_agent.js");

const CANARY = "CANARY-CIPHERTEXT-v1.AAAA.BBBB";
function world() {
  const d1 = makeD1({}); applyMigrations(d1, ["0176_beta_sessions.sql"]);
  d1.raw.exec("CREATE TABLE ups_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)");
  d1.raw.exec("INSERT INTO ups_settings VALUES ('public_note', 'hello', 'x')");
  d1.raw.prepare("INSERT INTO ups_beta_sessions (row_id, franchise_id, league_id, environment, sid_hash, handoff_expires_at, live_until, mfl_enc, key_id, created_at) VALUES ('ROW-CANARY', '0008', '74598', 'live', 'SIDHASH-CANARY', 1, 9999999999999, ?, 'k1', 1)").run(CANARY);
  d1.raw.prepare("INSERT INTO ups_beta_invites (franchise_id, league_id, environment, invited_at, note) VALUES ('0008', '74598', 'live', 1, 'INVITE-CANARY')").run();
  return { env: { UPS_MFL_DB: d1 }, d1 };
}
const tool = (w, name, input) => executeTool(w.env, "sess", { name, input }, { draft: {} });
const asText = (x) => (typeof x === "string" ? x : JSON.stringify(x));

const ATTACKS = [
  ["direct", "SELECT * FROM ups_beta_sessions"],
  ["direct, one column", "SELECT mfl_enc FROM ups_beta_sessions LIMIT 1"],
  ["invites table", "SELECT * FROM ups_beta_invites"],
  ["upper case", "SELECT * FROM UPS_BETA_SESSIONS"],
  ["mixed case", "select * from Ups_Beta_Sessions"],
  ["double-quoted", 'SELECT * FROM "ups_beta_sessions"'],
  ["backticked", "SELECT * FROM `ups_beta_sessions`"],
  ["bracketed", "SELECT * FROM [ups_beta_sessions]"],
  ["schema-qualified", "SELECT * FROM main.ups_beta_sessions"],
  ["schema-qualified, quoted", 'SELECT * FROM "main"."ups_beta_sessions"'],
  ["join (inner)", "SELECT s.key, b.mfl_enc FROM ups_settings s JOIN ups_beta_sessions b ON 1=1"],
  ["join (left, aliased)", "SELECT * FROM ups_settings a LEFT JOIN ups_beta_sessions AS b ON a.key = b.row_id"],
  ["join (cross, comma)", "SELECT b.mfl_enc FROM ups_settings a, ups_beta_sessions b"],
  ["join (natural)", "SELECT * FROM ups_beta_sessions NATURAL JOIN ups_beta_invites"],
  ["subquery in WHERE", "SELECT key FROM ups_settings WHERE key IN (SELECT row_id FROM ups_beta_sessions)"],
  ["subquery in SELECT", "SELECT (SELECT mfl_enc FROM ups_beta_sessions LIMIT 1) AS x"],
  ["scalar subquery in FROM", "SELECT x FROM (SELECT mfl_enc AS x FROM ups_beta_sessions)"],
  ["EXISTS", "SELECT 1 WHERE EXISTS (SELECT 1 FROM ups_beta_sessions WHERE mfl_enc LIKE 'CANARY%')"],
  ["CTE", "WITH x AS (SELECT * FROM ups_beta_sessions) SELECT * FROM x"],
  ["recursive CTE", "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r WHERE n < 2) SELECT (SELECT mfl_enc FROM ups_beta_sessions) FROM r"],
  ["UNION", "SELECT key FROM ups_settings UNION SELECT mfl_enc FROM ups_beta_sessions"],
  ["UNION ALL, second", "SELECT 1 UNION ALL SELECT sid_hash FROM ups_beta_sessions"],
  ["INTERSECT / EXCEPT", "SELECT key FROM ups_settings EXCEPT SELECT mfl_enc FROM ups_beta_sessions"],
  ["a blind boolean probe", "SELECT COUNT(*) FROM ups_settings WHERE EXISTS (SELECT 1 FROM ups_beta_sessions WHERE substr(mfl_enc,1,1) = 'C')"],
  ["comment before the name", "SELECT * FROM /* hi */ ups_beta_sessions"],
  ["comment after", "SELECT * FROM ups_beta_sessions -- trailing"],
  ["newline between", "SELECT *\nFROM\n  ups_beta_sessions"],
  ["tab", "SELECT *\tFROM\tups_beta_sessions"],
  ["in a string literal (still refused: the whole text is scanned)", "SELECT 'ups_beta_sessions'"],
  ["table-valued pragma", "SELECT * FROM pragma_table_info('ups_beta_sessions')"],
  ["table-valued pragma, other", "SELECT * FROM pragma_index_list('ups_beta_sessions')"],
  ["rowid access", "SELECT rowid, * FROM ups_beta_sessions"],
  ["the table named only by prefix scan", "SELECT name FROM sqlite_master WHERE name LIKE 'ups_beta_%'"],
];

test("run_sql: every attack query is refused by the tool dispatcher and no row of a beta table is ever returned", async () => {
  const w = world();
  for (const [label, q] of ATTACKS) {
    const out = asText(await tool(w, "run_sql", { query: q, purpose: label }));
    t.match(out, /not available to this tool/, `${label}: ${q.slice(0, 60)} -> ${out.slice(0, 100)}`);
    t.doesNotMatch(out, /CANARY|SIDHASH|ROW-CANARY|INVITE/, `${label}: no canary in the output`);
  }
  // and at the guard itself, so the refusal does not depend on the dispatcher
  for (const [label, q] of ATTACKS) t.ok(guardSql(q).error && /not available/.test(guardSql(q).error), "guardSql: " + label);
  const r = await runGuardedSql(w.env, "SELECT * FROM ups_beta_sessions");
  t.equal(r.ok, false); t.ok(!JSON.stringify(r).includes("CANARY"));
});

test("run_sql: SQLite cannot build an identifier from pieces, so no query WITHOUT the prefix in its text can name a beta table (the guard's soundness)", async () => {
  const w = world();
  const tries = ['SELECT * FROM ("ups_" || "beta_sessions")', "SELECT * FROM ups_|| 'beta_sessions'", "SELECT * FROM ups_/**/beta_sessions", "SELECT * FROM `ups_`+`beta_sessions`",
    "SELECT * FROM char(117,112,115)", "SELECT * FROM ups_ beta_sessions", "SELECT * FROM ups_beta"];
  for (const q of tries) {
    t.equal(touchesDeniedTable(q), q.toLowerCase().includes("ups_beta_"), "scan agrees with the text: " + q);
    let rows = null, err = "";
    try { rows = w.d1.raw.prepare(q).all(); } catch (e) { err = e.message; }
    t.ok(err || !JSON.stringify(rows).includes("CANARY"), "executing it directly never yields the canary: " + q + " -> " + (err || "no canary"));
  }
});

test("list_tables and describe_table: the beta tables are not listed, not described, not counted and not sampled", async () => {
  const w = world();
  const listed = JSON.parse(await tool(w, "list_tables", {}));
  t.ok(listed.includes("ups_settings"), "other tables are still listed");
  t.ok(!listed.some((n) => n.startsWith("ups_beta_")), "no beta table is listed: " + listed.join(","));
  for (const table of ["ups_beta_sessions", "ups_beta_invites", "UPS_BETA_SESSIONS", "Ups_Beta_Invites"]) {
    const out = asText(await tool(w, "describe_table", { table }));
    t.match(out, /not available to this tool|no such table/, table);
    t.doesNotMatch(out, /CANARY|SIDHASH|row_count|columns/, table + " leaks nothing");
  }
  const bogus = asText(await tool(w, "describe_table", { table: 'ups_beta_sessions" --' }));
  t.match(bogus, /invalid table name/, "an injection attempt in the name is still rejected first");
});

test("POSITIVE CONTROLS: ordinary queries and other ups_ tables still work, so the guard is not a blanket refusal", async () => {
  const w = world();
  const ok = async (q) => JSON.parse(await tool(w, "run_sql", { query: q, purpose: "control" }));
  t.equal((await ok("SELECT value FROM ups_settings WHERE key = 'public_note'")).rows[0].value, "hello");
  t.equal((await ok("SELECT COUNT(*) AS n FROM ups_settings")).rows[0].n, 1);
  t.equal((await ok("WITH x AS (SELECT key FROM ups_settings) SELECT * FROM x")).row_count, 1);
  t.ok((await ok("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ups_settings'")).row_count === 1);
  t.equal(guardSql("SELECT 1 AS ups_beta_x").error ? true : false, true, "even a column ALIAS that looks like the prefix is refused (conservative, by design)");
  t.deepEqual(DENIED_TABLE_PREFIXES, ["ups_beta_"]);
  for (const stillBlocked of ["DELETE FROM ups_settings", "SELECT 1; SELECT 2", "PRAGMA table_info(ups_settings)", "INSERT INTO ups_settings VALUES (1,2,3)"]) t.ok(guardSql(stillBlocked).error, "the existing guards still hold: " + stillBlocked);
});

test("THE ROWS ARE STILL THERE: the canary survived every attack (nothing was deleted or altered by the tool)", async () => {
  const w = world();
  for (const [, q] of ATTACKS) await tool(w, "run_sql", { query: q });
  t.equal(w.d1.raw.prepare("SELECT mfl_enc FROM ups_beta_sessions").get().mfl_enc, CANARY);
});

await run("beta_agent_denylist");
