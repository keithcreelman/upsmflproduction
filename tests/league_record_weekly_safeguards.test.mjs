// Safeguards for the weekly reconstruction (#1488): it must stay a read-only, local, weekly-only tool. This test reads source text only (no database, no network), so it runs in the default safe suite.
//   node tests/league_record_weekly_safeguards.test.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "scripts", "league_record", "weekly");
const FILES = fs.readdirSync(DIR).filter((f) => f.endsWith(".mjs"));
const src = (f) => fs.readFileSync(path.join(DIR, f), "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");   // comments are prose, not behavior

test("the weekly tool reads only weekly tables: nothing about transactions, draft picks, contracts or pick lineage", () => {
  const rx = /\b(transactions_\w+|draftresults_\w+|trade_\w+|contract_\w+|rosters_weekly|pick_lineage|player_contracts|src_contracts|salary_adjust\w*)\b/i;
  for (const f of FILES) t.deepEqual(src(f).split("\n").filter((l) => rx.test(l)), [], `${f} mentions no transaction, draft-pick or contract table`);
});

test("it never writes: no INSERT/UPDATE/DELETE/CREATE/ALTER/DROP/REPLACE statement, no exec, no file write into the repository, read-only database handles", () => {
  const sql = /["'`]\s*(insert|update|delete|create|alter|drop|replace|attach|pragma\s+\w+\s*=)\b/i;
  for (const f of FILES) {
    const s = src(f);
    t.deepEqual(s.split("\n").filter((l) => sql.test(l)), [], `${f}: no write statement`);
    t.ok(!/\.exec\(/.test(s), `${f}: no db.exec`);
  }
  const runner = src("run_reconstruct_weekly.mjs");
  t.equal((runner.match(/new DatabaseSync\(/g) || []).length, (runner.match(/readOnly: true/g) || []).length, "every database opened read-only");
  t.ok(/refusing: the output folder must be outside the repository/.test(runner), "the runner refuses an output folder inside the repository");
});

test("no network, no child process, no secrets, no wrangler or D1", () => {
  const bad = /(\bfetch\(|https?:\/\/|XMLHttpRequest|child_process|spawn|execSync|process\.env|wrangler|d1 execute|APIKEY|MFL_USER_ID|api\.myfantasyleague|workers\.dev)/;
  for (const f of FILES) t.deepEqual(src(f).split("\n").filter((l) => bad.test(l)), [], `${f}: none of those`);
});

test("only the committed weekly directory, its two tests and its documentation belong to this change", () => {
  t.deepEqual(FILES.sort(), ["reconstruct_weekly.mjs", "run_reconstruct_weekly.mjs"]);
  t.ok(fs.existsSync(path.join(ROOT, "docs", "historical_weekly_reconstruction", "README.md")), "documentation present");
});

await run("league_record_weekly_safeguards");
