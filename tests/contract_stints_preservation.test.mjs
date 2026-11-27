// PRESERVED CONTRACT-STINT BRANCH (#1355): the original scripts are kept as inert evidence. This test makes sure they stay inert, byte-identical to what was reviewed, and flagged for the hazards they carry.
// It reads files in docs/contract_stints_preservation/ only: no database, no network, no process.
//   node tests/contract_stints_preservation.test.mjs
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "docs", "contract_stints_preservation");
const man = JSON.parse(fs.readFileSync(path.join(DIR, "MANIFEST.json"), "utf8"));
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const files = walk(DIR);
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const scripts = man.files.filter((f) => f.preserved_path.endsWith(".py.preserved"));

test("every preserved script matches the reviewed original byte-for-byte", () => {
  t.equal(scripts.length, 13);
  for (const f of scripts) { const p = path.join(ROOT, f.preserved_path); t.ok(fs.existsSync(p), `${f.preserved_path} exists`); t.equal(sha(p), f.sha256_of_original, `${path.basename(p)} hash`); t.equal(fs.statSync(p).size, f.bytes); }
  for (const f of man.files.filter((x) => x.sha256_of_diff)) t.equal(sha(path.join(ROOT, f.preserved_path)), f.sha256_of_diff, `${path.basename(f.preserved_path)} diff hash`);
});

test("nothing in the folder can be run or imported: no executable extension and no executable bit (an original shebang line is kept byte-for-byte, and is harmless without both)", () => {
  const exec = /\.(py|sh|bash|zsh|js|mjs|cjs|ts|sql|rb|pl|command|bat|ps1|yml|yaml)$/i;
  t.deepEqual(files.filter((f) => exec.test(f)).map((f) => path.relative(ROOT, f)), [], "only .preserved, .diff.txt, .json and .md files");
  for (const f of files) t.equal(fs.statSync(f).mode & 0o111, 0, `${path.basename(f)} is not executable`);
});

test("the preserved scripts have not been put back where they could run", () => {
  const live = path.join(ROOT, "pipelines", "etl", "scripts");
  for (const f of scripts) t.ok(!fs.existsSync(path.join(live, path.basename(f.original_path))), `${path.basename(f.original_path)} is not under pipelines/etl/scripts`);
});

test("every script that can reach production D1 is flagged in the manifest, and the writers are named", () => {
  for (const f of scripts) {
    const src = fs.readFileSync(path.join(ROOT, f.preserved_path), "utf8");
    const remote = (src.match(/--remote/g) || []).length;
    t.equal(remote, f.remote_d1_flags, `${path.basename(f.original_path)}: remote flags counted in the manifest`);
    const writes = /--remote[^\n]*\n?[^\n]*--file=/.test(src);
    t.equal(writes, f.executes_remote_d1_write, `${path.basename(f.original_path)}: remote write flag`);
  }
  t.deepEqual(scripts.filter((f) => f.executes_remote_d1_write).map((f) => path.basename(f.original_path)).sort(), ["backfill_cycles_pass3.py", "backfill_cycles_pass4.py"]);
  t.deepEqual(scripts.filter((f) => f.remote_d1_flags > 0).map((f) => path.basename(f.original_path)).sort(), ["backfill_2012_alldrops.py", "backfill_cycles_pass3.py", "backfill_cycles_pass4.py"]);
});

test("the README keeps the preservation-only status, the five reuse categories and the limitations", () => {
  const r = fs.readFileSync(path.join(DIR, "README.md"), "utf8");
  for (const s of ["not approved for merge", "Worth adopting", "Worth extending", "Supporting evidence only", "Replace", "Unresolved assumptions", "Self-referential validation", "Safeguards against accidental production execution"]) t.ok(r.includes(s), `README says: ${s}`);
  for (const f of man.files) t.ok(["ADOPT", "EXTEND", "REFERENCE", "REPLACE", "INVESTIGATE"].includes(f.classification), `${path.basename(f.preserved_path)} classified`);
  t.equal(man.original_commits.length, 16);
});

await run("contract_stints_preservation");
