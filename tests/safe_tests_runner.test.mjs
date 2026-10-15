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
//   * the manifest cannot smuggle in a secret, an opt-in flag or a stale entry;
//   * MAT-4: uncommitted work is refused by default; with --allow-dirty (never in
//     CI) a test that rewrites an already-dirty file is still caught, byte for byte;
//   * MAT-2: the run names the commit it actually tested (PR head or GitHub's
//     merge result) and fails before any test if the reported SHA is wrong.
// Nested runs execute only fixtures under tests/fixtures/safe_tests/, inside
// throwaway git repos.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { t, test, run } from "./fixtures/mini_test.mjs";
import {
  loadManifest, plan, listRepoFiles, globToRegExp, neverRun, tripwireText, verifyProvenance, describeProvenance,
  SECRET_ENV_PATTERN, UNSAFE_ARG_PATTERN,
} from "../scripts/safe_tests/run.mjs";
import { isLoopbackHost } from "../scripts/safe_tests/guards/no_network.mjs";

const FIX = "tests/fixtures/safe_tests/";
const GIT_ENV = { GIT_AUTHOR_NAME: "safe-tests", GIT_AUTHOR_EMAIL: "safe-tests@example.invalid", GIT_COMMITTER_NAME: "safe-tests", GIT_COMMITTER_EMAIL: "safe-tests@example.invalid" };

// Nested runs never touch this checkout: each one runs a copy of the runner in a
// throwaway git repo, so the self-test does not depend on (or disturb) the real
// worktree, and can build merge commits and dirty files on purpose.
function git(repo, ...args) {
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "init.defaultBranch=main", ...args],
    { cwd: repo, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "safe-tests-selftest-repo-"));
  const skipCache = (src) => !src.includes("__pycache__");
  fs.cpSync("scripts/safe_tests", path.join(repo, "scripts/safe_tests"), { recursive: true, filter: skipCache });
  fs.cpSync(FIX, path.join(repo, FIX), { recursive: true, filter: skipCache });
  fs.writeFileSync(path.join(repo, "tests/safe_suite.json"), JSON.stringify({
    discover: { node: ["tests/*.test.mjs"], python: [] }, exclude: [], partial: [], known_network_attempts: [],
    tripwire_reviewed: [], env: {}, serial: [], timeouts_seconds: {},
  }, null, 2));
  fs.writeFileSync(path.join(repo, "SELFTEST_REPO_MARKER"), "safe-tests self-test repo\n");
  fs.writeFileSync(path.join(repo, "notes.txt"), "committed line\n");
  git(repo, "init", "-q");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  return repo;
}

function nested(repo, args, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "safe-tests-selftest-out-"));
  const json = path.join(dir, "result.json");
  const summary = path.join(dir, "summary.md");
  const env = { ...process.env, ...extraEnv };
  for (const k of ["CI", "GITHUB_ACTIONS"]) if (!(k in extraEnv)) delete env[k];
  const r = spawnSync(process.execPath, [path.join(repo, "scripts/safe_tests/run.mjs"), ...args, "--json", json, "--summary", summary, "--concurrency", "1"],
    { cwd: repo, encoding: "utf8", env, timeout: 120000 });
  const result = fs.existsSync(json) ? JSON.parse(fs.readFileSync(json, "utf8")) : null;
  const md = fs.existsSync(summary) ? fs.readFileSync(summary, "utf8") : "";
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: r.status, out: r.stdout + r.stderr, result, md };
}

const fixtureArgs = (...names) => ["--files", names.map((n) => FIX + n).join(",")];
const REPO = makeRepo();

test("a deliberately failing test makes the run fail and is named in the report", () => {
  const r = nested(REPO, fixtureArgs("always_fails.mjs", "always_passes.mjs"));
  t.equal(r.status, 1, r.out.slice(-800));
  t.equal(r.result.counts.failed, 1);
  t.equal(r.result.counts.passed, 1);
  t.match(r.md, /❌ Safe offline tests: FAIL/);
  t.match(r.md, /always_fails\.mjs/);
});

test("an all-passing run exits 0 and every guard check passes", () => {
  const r = nested(REPO, fixtureArgs("always_passes.mjs"));
  t.equal(r.status, 0, r.out.slice(-800));
  t.match(r.md, /✅ Safe offline tests: PASS/);
  t.ok(r.result.canaries.length >= 5);
  for (const c of r.result.canaries) t.ok(c.ok, `${c.name}: ${c.output}`);
});

test("invoked through a symlinked path, the runner still runs (no silent exit 0)", () => {
  const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "safe-tests-link-")), "repo");
  fs.symlinkSync(REPO, link);
  const r = spawnSync(process.execPath, [path.join(link, "scripts/safe_tests/run.mjs"), ...fixtureArgs("always_fails.mjs")], { encoding: "utf8", timeout: 120000 });
  t.equal(r.status, 1, "a failing fixture must fail the run: " + (r.stdout + r.stderr).slice(-400));
  t.match(r.stdout, /Safe offline tests: FAIL/);
  fs.rmSync(path.dirname(link), { recursive: true, force: true });
});

test("a run that selects nothing fails instead of passing vacuously", () => {
  const r = nested(REPO, ["--only", "no-such-test-anywhere-xyz"]);
  t.equal(r.status, 1, r.out.slice(-800));
  t.match(r.out, /no planned test matches/);
});

test("a test that swallows a blocked network call still fails the run", () => {
  const r = nested(REPO, fixtureArgs("tries_network.mjs"));
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
  const r = nested(REPO, fixtureArgs("prints_env.mjs", "prints_env.py"), planted);
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

test("the never-run list refuses dot-directories and known send scripts", () => {
  t.ok(neverRun(".claude/worktrees/x/pipelines/etl/scripts/test_fire_ab.py"));
  t.ok(neverRun("pipelines/etl/scripts/test_fire_ab.py"));
  t.ok(neverRun("scripts/hall_test_summaries.sh"));
  t.ok(!neverRun("tests/safe_tests_runner.test.mjs"));
  const r = nested(REPO, ["--files", ".claude/worktrees/x/test_fire_ab.py"]);
  t.equal(r.status, 1);
  t.equal(r.result.counts.run, 0, "nothing executed");
});

// ---- MAT-4: uncommitted work is protected --------------------------------------
test("MAT-4: a dirty worktree is refused by default, nothing runs, and the files are untouched", () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "notes.txt"), "my uncommitted work\n");
  fs.writeFileSync(path.join(repo, "scratch.txt"), "untracked notes\n");
  const r = nested(repo, fixtureArgs("mutates_dirty.mjs"));
  t.equal(r.status, 1, r.out.slice(-800));
  t.equal(r.result.counts.run, 0, "no test ran");
  t.ok(r.result.canaries.some((c) => /Working tree: clean before the run/.test(c.name) && !c.ok));
  t.match(r.out, /uncommitted change/);
  t.equal(fs.readFileSync(path.join(repo, "notes.txt"), "utf8"), "my uncommitted work\n");
  t.ok(fs.existsSync(path.join(repo, "scratch.txt")));
});

test("MAT-4: with --allow-dirty, a test that changes an already-dirty file (same status line) is caught, and the original is backed up", () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "notes.txt"), "my uncommitted work\n");
  fs.writeFileSync(path.join(repo, "scratch.txt"), "untracked notes\n");
  const statusBefore = git(repo, "status", "--porcelain");
  const r = nested(repo, ["--allow-dirty", ...fixtureArgs("mutates_dirty.mjs")]);
  t.equal(r.status, 1, r.out.slice(-800));
  t.equal(r.result.counts.passed, 1, "the fixture itself passed");
  const notesLine = (st) => st.split("\n").find((l) => l.endsWith("notes.txt"));
  t.ok(notesLine(statusBefore), "notes.txt was dirty before the run");
  t.equal(notesLine(git(repo, "status", "--porcelain")), notesLine(statusBefore), "notes.txt shows the same status line before and after");
  t.ok(r.result.pollution.some((p) => /^notes\.txt: changed during the run/.test(p)), JSON.stringify(r.result.pollution));
  t.ok(r.result.pollution.some((p) => /^scratch\.txt: was uncommitted/.test(p)), JSON.stringify(r.result.pollution));
  t.ok(r.result.backupDir && fs.existsSync(r.result.backupDir), "backup kept");
  t.equal(fs.readFileSync(path.join(r.result.backupDir, "notes.txt"), "utf8"), "my uncommitted work\n");
  t.equal(fs.readFileSync(path.join(r.result.backupDir, "scratch.txt"), "utf8"), "untracked notes\n");
  fs.rmSync(r.result.backupDir, { recursive: true, force: true });
});

test("MAT-4: a test that modifies a clean tracked file is caught", () => {
  const repo = makeRepo();
  const r = nested(repo, fixtureArgs("mutates_dirty.mjs"));
  t.equal(r.status, 1, r.out.slice(-800));
  t.ok(r.result.pollution.some((p) => /^notes\.txt: modified during the run/.test(p)), JSON.stringify(r.result.pollution));
});

test("MAT-4: --allow-dirty is refused in CI", () => {
  const r = nested(REPO, ["--allow-dirty", ...fixtureArgs("always_passes.mjs")], { GITHUB_ACTIONS: "true" });
  t.equal(r.status, 1, r.out.slice(-800));
  t.equal(r.result.counts.run, 0);
  t.ok(r.result.canaries.some((c) => /refused in CI/.test(c.name) && !c.ok));
});

// ---- MAT-2: what CI tested, exactly ------------------------------------------------
test("MAT-2: verifyProvenance tells the PR head from GitHub's merge result and rejects a wrong tested SHA", () => {
  const B = "b".repeat(40), H = "a".repeat(40), M = "c".repeat(40);
  const merge = verifyProvenance({ head: M, parents: [B, H], testedSha: M, prHead: H });
  t.ok(merge.ok);
  t.equal(merge.kind, "merge-result");
  t.equal(merge.base, B);
  t.match(describeProvenance(merge), /merge result `cccccccc`.*PR head `aaaaaaaa`.*base `bbbbbbbb`.*not the PR head alone/);
  t.equal(verifyProvenance({ head: H, parents: [B], testedSha: H, prHead: H }).kind, "pr-head");
  t.ok(!verifyProvenance({ head: M, parents: [B, H], testedSha: H, prHead: H }).ok, "tested SHA reported as the head while the merge commit is checked out");
  t.ok(!verifyProvenance({ head: M, parents: [H, B], testedSha: M, prHead: H }).ok, "PR head must be the second parent");
  t.ok(!verifyProvenance({ head: M, parents: [B, H], testedSha: "cccccc" }).ok, "abbreviated SHA refused");
});

test("MAT-2: on a real merge commit the runner reports both SHAs, and fails before any test on a mismatch", () => {
  const repo = makeRepo();
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "-b", "feature");
  fs.writeFileSync(path.join(repo, "feature.txt"), "pr change\n");
  git(repo, "add", "feature.txt");
  git(repo, "commit", "-q", "-m", "pr head");
  const head = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "main");
  git(repo, "merge", "--no-ff", "-q", "-m", "Merge pr head into main", "feature");
  const merge = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "--detach", merge);

  const ok = nested(repo, ["--tested-sha", merge, "--pr-head", head, ...fixtureArgs("always_passes.mjs")]);
  t.equal(ok.status, 0, ok.out.slice(-800));
  t.equal(ok.result.provenance.kind, "merge-result");
  t.equal(ok.result.provenance.tested, merge);
  t.equal(ok.result.provenance.prHead, head);
  t.equal(ok.result.provenance.base, base);
  t.ok(ok.md.includes(`PR head \`${head}\``) && ok.md.includes(`tested merge commit \`${merge}\``), ok.md.slice(0, 600));

  const lie = nested(repo, ["--tested-sha", head, "--pr-head", head, ...fixtureArgs("always_passes.mjs")]);
  t.equal(lie.status, 1, "claiming the head was tested while the merge commit is checked out fails");
  t.equal(lie.result.counts.run, 0, "no test ran");
  t.ok(lie.result.problems.some((p) => /differs from the commit actually checked out/.test(p)), JSON.stringify(lie.result.problems));

  const wrongHead = nested(repo, ["--tested-sha", merge, "--pr-head", "d".repeat(40), ...fixtureArgs("always_passes.mjs")]);
  t.equal(wrongHead.status, 1);
  t.equal(wrongHead.result.counts.run, 0);

  git(repo, "checkout", "-q", "--detach", head);
  const atHead = nested(repo, ["--tested-sha", head, "--pr-head", head, ...fixtureArgs("always_passes.mjs")]);
  t.equal(atHead.status, 0, atHead.out.slice(-800));
  t.equal(atHead.result.provenance.kind, "pr-head");
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
fs.rmSync(REPO, { recursive: true, force: true });
