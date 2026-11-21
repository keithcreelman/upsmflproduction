// MFL KEY SOURCE (containment, 2026-11-21): pipelines/etl/scripts/mfl_api.py no longer carries a hard-coded key. It must take the key
// from MFL_APIKEY, else from the git-ignored local config (runtime.env.live, then runtime.env), else run keyless with a warning that
// never shows a value. Every value below is synthetic. No network call: importing mfl_api makes none.
//   node tests/mfl_api_key_source.test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = path.join(ROOT, "pipelines", "etl", "scripts");
const ENV_KEY = "SYNTHETICenvKEY0000000000000";
const LIVE_KEY = "SYNTHETIClivKEY0000000000000";
const PLAIN_KEY = "SYNTHETICplnKEY0000000000000";

// Runs mfl_api with its config folder pointed at `dir`, and prints JSON {apikey, resolved, warned}.
function probe(dir, env = {}) {
  const code = [
    "import json, logging, sys",
    `sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`,
    "records = []",
    "class H(logging.Handler):",
    "    def emit(self, r): records.append(r.getMessage())",
    "logging.getLogger('mfl_api').addHandler(H())",
    "import mfl_api",
    `mfl_api._CONFIG_DIR = ${JSON.stringify(dir)}`,
    "records.clear()",
    "v = mfl_api.resolve_apikey()",
    "print(json.dumps({'resolved': v, 'warned': any('MFL_APIKEY' in m for m in records), 'logs': records}))",
  ].join("\n");
  const base = { ...process.env };
  delete base.MFL_APIKEY;
  const r = spawnSync("python3", ["-I", "-c", code], { encoding: "utf8", env: { ...base, ...env } });
  if (r.status !== 0) throw new Error(`python failed: ${r.stderr.slice(-400)}`);
  return JSON.parse(r.stdout.trim().split("\n").pop());
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mfl-key-src-"));

test("the committed source holds no key: the fallback is gone", () => {
  const src = fs.readFileSync(path.join(SCRIPTS, "mfl_api.py"), "utf8");
  t.ok(!/environ\.get\(\s*["']MFL_APIKEY["']\s*,\s*["'][^"']+["']\s*\)/.test(src), "no os.environ.get('MFL_APIKEY', '<value>') fallback");
});

test("the environment wins over the local config", () => {
  const d = tmp(); fs.writeFileSync(path.join(d, "runtime.env.live"), `MFL_APIKEY=${LIVE_KEY}\n`);
  const r = probe(d, { MFL_APIKEY: ENV_KEY });
  t.equal(r.resolved, ENV_KEY); t.equal(r.warned, false);
});

test("without the environment, runtime.env.live is read first, then runtime.env (quotes, export and comments handled)", () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "runtime.env"), `# local\nMFL_APIKEY="${PLAIN_KEY}"\n`);
  t.equal(probe(d).resolved, PLAIN_KEY, "runtime.env alone");
  fs.writeFileSync(path.join(d, "runtime.env.live"), `UPS_COMMISH_API_KEY=other\nexport MFL_APIKEY=${LIVE_KEY}\n`);
  t.equal(probe(d).resolved, LIVE_KEY, "runtime.env.live preferred");
});

test("the example placeholder is never used as a key; with no key the warning names the variable, never a value", () => {
  const d = tmp(); fs.writeFileSync(path.join(d, "runtime.env"), "MFL_APIKEY=<API_KEY>\n");
  const r = probe(d);
  t.equal(r.resolved, ""); t.equal(r.warned, true);
  t.ok(r.logs.every((m) => !m.includes("<API_KEY>")), "the warning carries no value");
});

test("the local config files are git-ignored", () => {
  for (const f of ["runtime.env", "runtime.env.live"]) {
    const r = spawnSync("git", ["check-ignore", "-q", `pipelines/etl/config/${f}`], { cwd: ROOT });
    t.equal(r.status, 0, `${f} is ignored`);
  }
});

await run("mfl_api_key_source");
