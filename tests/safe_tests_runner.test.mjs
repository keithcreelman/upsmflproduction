// The safe offline suite's own regression test.
//   node tests/safe_tests_runner.test.mjs     (the suite also runs it every time)
//
// Proves, on every run, the promises in docs/SAFE_TESTS.md:
//   * a failing test turns the run red (exit 1, named in the report);
//   * a test that quietly tries the network is caught even though it "passed";
//   * secrets and production opt-ins in the caller's environment never reach a
//     test, and the Node and Python network guards are loaded in every test;
//   * send-capable and production-reading files are never planned to run, and
//     every file a stock `node --test` or `pytest` would pick up is classified;
//   * the manifest cannot smuggle in a secret, an opt-in flag or a stale entry.
// The nested runs only execute fixtures under tests/fixtures/safe_tests/.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { t, test, run } from "./fixtures/mini_test.mjs";
import {
  loadManifest, plan, listRepoFiles, globToRegExp, neverRun, tripwireText,
  SECRET_ENV_PATTERN, UNSAFE_ARG_PATTERN,
} from "../scripts/safe_tests/run.mjs";
import { isLoopbackHost } from "../scripts/safe_tests/guards/no_network.mjs";

const RUNNER = "scripts/safe_tests/run.mjs";
const FIX = "tests/fixtures/safe_tests/";

function nested(files, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "safe-tests-selftest-"));
  const json = path.join(dir, "result.json");
  const summary = path.join(dir, "summary.md");
  const r = spawnSync(process.execPath, [RUNNER, "--files", files.join(","), "--json", json, "--summary", summary, "--concurrency", "1"],
    { encoding: "utf8", env: { ...process.env, ...extraEnv }, timeout: 120000 });
  const result = fs.existsSync(json) ? JSON.parse(fs.readFileSync(json, "utf8")) : null;
  const md = fs.existsSync(summary) ? fs.readFileSync(summary, "utf8") : "";
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: r.status, out: r.stdout + r.stderr, result, md };
}

test("a deliberately failing test makes the run fail and is named in the report", () => {
  const r = nested([FIX + "always_fails.mjs", FIX + "always_passes.mjs"]);
  t.equal(r.status, 1, r.out.slice(-800));
  t.equal(r.result.counts.failed, 1);
  t.equal(r.result.counts.passed, 1);
  t.match(r.md, /❌ Safe offline tests: FAIL/);
  t.match(r.md, /always_fails\.mjs/);
});

test("a run that selects nothing fails instead of passing vacuously", () => {
  const r = spawnSync(process.execPath, [RUNNER, "--only", "no-such-test-anywhere-xyz"], { encoding: "utf8", timeout: 60000 });
  t.equal(r.status, 1, r.stdout + r.stderr);
  t.match(r.stdout, /no planned test matches/);
});

test("an all-passing run exits 0", () => {
  const r = nested([FIX + "always_passes.mjs"]);
  t.equal(r.status, 0, r.out.slice(-800));
  t.match(r.md, /✅ Safe offline tests: PASS/);
});

test("a test that swallows a blocked network call still fails the run", () => {
  const r = nested([FIX + "tries_network.mjs"]);
  t.equal(r.status, 1, r.out.slice(-800));
  t.equal(r.result.counts.passed, 1, "the fixture itself exits 0");
  t.ok(r.result.blocked.some((b) => b.target.startsWith("http://192.0.2.1:9/") && !b.known), JSON.stringify(r.result.blocked));
  t.ok(r.result.problems.some((p) => /tried to reach the network/.test(p)));
});

test("secrets and production opt-ins in the caller's environment never reach a test", () => {
  const planted = {
    UPS_ALLOW_PROD_D1_READS: "1", CLOUDFLARE_API_TOKEN: "planted", DISCORD_BOT_TOKEN: "planted",
    MFL_COOKIE: "planted", ANTHROPIC_API_KEY: "planted", OPENAI_API_KEY: "planted", GITHUB_TOKEN: "planted",
    UPS_COMMISH_API_KEY: "planted",
  };
  const r = nested([FIX + "prints_env.mjs", FIX + "prints_env.py"], planted);
  t.equal(r.status, 0, r.out.slice(-800));
  for (const tr of r.result.tests) {
    const line = tr.output.split("\n").find((l) => l.startsWith("SAFE_TESTS_ENV "));
    t.ok(line, `${tr.path} printed its environment`);
    const seen = JSON.parse(line.slice("SAFE_TESTS_ENV ".length));
    for (const k of Object.keys(planted)) t.ok(!seen.keys.includes(k), `${tr.path} must not see ${k}`);
    t.equal(seen.keys.filter((k) => SECRET_ENV_PATTERN.test(k)).length, 0, `${tr.path}: ${seen.keys.join(",")}`);
    t.equal(seen.guard, true, `${tr.path}: network guard loaded`);
  }
});

test("the guard checks run before any test and all pass", () => {
  const r = nested([FIX + "always_passes.mjs"]);
  t.ok(r.result.canaries.length >= 4);
  for (const c of r.result.canaries) t.ok(c.ok, `${c.name}: ${c.output}`);
});

const { manifest, errors } = loadManifest();
const files = listRepoFiles();
const p = plan(manifest, files);
const planned = new Set(p.run.map((x) => x.path));

test("the manifest loads cleanly: every exclusion exists, has a category and a reason", () => {
  t.deepEqual(errors, []);
  for (const e of manifest.exclude) t.ok(e.reason.length >= 20, e.path);
});

test("production-reading and send-capable files are never planned to run", () => {
  for (const f of ["pipelines/etl/scripts/test_asof_leakage.py", "scripts/hall_test_summaries.sh", "tests/worker_syntax_check.test.mjs"]) {
    t.ok(!planned.has(f), `${f} must not run`);
  }
  t.ok(p.skipped.some((s) => s.path === "pipelines/etl/scripts/test_asof_leakage.py" && s.category === "prod-read-opt-in"));
  t.ok(planned.has("pipelines/etl/scripts/test_asof_leakage_offline_default.py"), "the offline twin that proves the opt-in gate runs");
});

test("the never-run list refuses dot-directories and known send scripts", () => {
  t.ok(neverRun(".claude/worktrees/x/pipelines/etl/scripts/test_fire_ab.py"));
  t.ok(neverRun("pipelines/etl/scripts/test_fire_ab.py"));
  t.ok(neverRun("scripts/hall_test_summaries.sh"));
  t.ok(!neverRun("tests/safe_tests_runner.test.mjs"));
  const r = nested([".claude/worktrees/x/test_fire_ab.py"]);
  t.equal(r.status, 1);
  t.equal(r.result.counts.run, 0, "nothing executed");
});

test("every file a stock `node --test` or `pytest` would collect is classified", () => {
  const known = new Set([...p.run, ...p.skipped, ...p.documented].map((x) => x.path));
  const nodeDefault = ["**/*.test.{cjs,mjs,js}", "**/*-test.{cjs,mjs,js}", "**/*_test.{cjs,mjs,js}", "**/test-*.{cjs,mjs,js}", "**/test.{cjs,mjs,js}", "**/test/**/*.{cjs,mjs,js}"].map(globToRegExp);
  const pyDefault = ["**/test_*.py", "**/*_test.py"].map(globToRegExp);
  const unclassified = files.filter((f) => !known.has(f) && !f.startsWith("tests/fixtures/")
    && (nodeDefault.some((r) => r.test(f)) || pyDefault.some((r) => r.test(f))));
  t.deepEqual(unclassified, [], "classify these in tests/safe_suite.json: " + unclassified.join(", "));
});

test("the tripwire flags a test that invokes production tooling itself", () => {
  t.ok(tripwireText('execFileSync("npx", ["wrangler", "d1", "execute", "ups-mfl-db", "--remote"])').length > 0);
  t.ok(tripwireText('subprocess.run(["security", "find-generic-password", "-s", "x"])').length > 0);
  t.ok(tripwireText('const tok = process.env.DISCORD_BOT_TOKEN;').length > 0);
  t.equal(tripwireText('const x = await fetch(env.SELF_URL);').length, 0);
});

test("the manifest may not set secrets, opt-ins or write flags", () => {
  for (const k of ["UPS_ALLOW_PROD_D1_READS", "CLOUDFLARE_API_TOKEN", "MFL_COOKIE", "DISCORD_WEBHOOK_URL", "X_API_KEY"]) t.ok(SECRET_ENV_PATTERN.test(k), k);
  t.ok(!SECRET_ENV_PATTERN.test("UPS_CENTER_AUTO_QUIET"));
  for (const a of ["--allow-prod-d1", "--apply", "--yes", "--remote", "--post", "--send"]) t.ok(UNSAFE_ARG_PATTERN.test(a), a);
  t.ok(!UNSAFE_ARG_PATTERN.test("--no-backtest"));
});

test("only real loopback addresses count as loopback", () => {
  for (const h of ["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]) t.ok(isLoopbackHost(h), h);
  for (const h of ["127.example.com", "evil.localhost", "www48.myfantasyleague.com", "192.0.2.1", "::ffff:8.8.8.8"]) t.ok(!isLoopbackHost(h), h);
});

await run("safe tests runner");
