#!/usr/bin/env node
// Safe offline suite runner -- the one command that runs every approved
// offline test in this repo, locally and in CI:
//
//   node scripts/safe_tests/run.mjs            run the suite
//   node scripts/safe_tests/run.mjs --list     show what would run and what is excluded, run nothing
//
// It never reads production, writes to MFL / D1 / Discord, deploys, reads the
// Keychain or calls a paid API. That is enforced in layers, documented in
// docs/SAFE_TESTS.md:
//   1. Discovery is explicit (tests/safe_suite.json) and every excluded file is
//      named with a category and a reason, then printed in the report.
//   2. A tripwire refuses to execute an unreviewed test whose source invokes
//      production tooling (wrangler --remote, the Keychain, credential env vars).
//   3. Each test runs with a scrubbed environment: no inherited secrets or
//      opt-in flags, and a throwaway HOME so CLI logins are not found.
//   4. Network, credential and deploy CLIs are shadowed on PATH by stubs that
//      exit 97, and git can only run local subcommands.
//   5. Node and Python processes load a loopback-only network guard.
//   6. In GitHub Actions the whole run sits in a network namespace with only a
//      loopback interface (--expect-no-network asserts that).
// Before any test runs, canaries prove layers 3-5 are active; if a canary
// reaches the network the run aborts.
//
// Options:
//   --list                    print the plan only
//   --only <substring>        run only planned tests whose path contains it
//   --files <a,b,...>         run exactly these files (still guarded; used by the self-test)
//   --concurrency <n>         parallel test processes (default: min(4, CPUs))
//   --json <path>             write machine-readable results
//   --summary <path>          write the Markdown report (default: $GITHUB_STEP_SUMMARY if set)
//   --expect-no-network       fail unless the only network interface is loopback (CI)
//   --tested-sha <sha>        fail unless this full SHA is the commit actually checked out (CI passes $GITHUB_SHA)
//   --pr-head <sha>           fail unless the checkout is that PR head, or a merge commit whose second
//                             parent is it (GitHub's pull_request merge result); the report names both
//   --allow-dirty             local only, never in CI: run over uncommitted work after backing every
//                             modified and untracked file up, then compare them byte for byte
//
// By default the runner refuses to start when the worktree has uncommitted
// changes: a test that rewrote one of those files could destroy work git cannot
// give back. Run in a clean checkout or worktree instead.

import { spawn, spawnSync, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const MANIFEST_PATH = path.join(ROOT, "tests", "safe_suite.json");
const NODE_GUARD = path.join(HERE, "guards", "no_network.mjs");
const PY_GUARD_DIR = path.join(HERE, "guards", "python");
const CANARY_DIR = path.join(HERE, "canary");

export const EXCLUDE_CATEGORIES = {
  "send-capable": "can write to MFL, D1, Discord or GitHub, deploy, or call a paid API",
  "prod-read": "reads production (MFL, D1, the live worker or Keychain credentials)",
  "prod-read-opt-in": "reads production only behind an explicit opt-in; never opted in here",
  "needs-unavailable-input": "needs a gitignored file, local database or package a clean checkout does not have",
  "not-a-test": "matches a test filename pattern but is a helper, fixture or manual tool",
  "needs-network": "needs the public internet (for example downloads a package at run time); the suite is offline",
  "known-failing": "fails on main today; tracked so it is visible, not silently skipped",
};

// CLIs that can reach the network, read credentials, deploy, or install
// something on the host (a LaunchAgent, a cron entry, a browser tab). Inside the
// suite each one is replaced by a stub that prints why and exits 97.
export const DENIED_COMMANDS = [
  "wrangler", "npx", "npm", "pnpm", "yarn", "curl", "wget", "gh", "security", "op", "aws", "gcloud",
  "ssh", "scp", "sftp", "rsync", "nc", "ncat", "telnet", "ftp", "http", "https", "xh", "openssl",
  "launchctl", "crontab", "osascript", "open", "xdg-open", "docker", "systemctl",
];
// git subcommands that talk to a remote. Everything else (status, diff, log,
// ls-files, show, rev-parse ...) runs normally.
export const GIT_NETWORK_SUBCOMMANDS = [
  "push", "fetch", "pull", "clone", "ls-remote", "remote", "submodule", "send-email", "request-pull", "svn", "p4", "lfs",
];
// Environment variables whose names suggest a secret or a production opt-in.
// The suite never passes them to a test, and a manifest env override may not set one.
export const SECRET_ENV_PATTERN = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|COOKIE|WEBHOOK|CREDENTIAL|PRIVATE|SESSION|AUTH|ALLOW_PROD|PROD_|_PROD|REMOTE|LIVE)/i;

// ---------------------------------------------------------------------------
// Manifest + discovery

export function loadManifest(file = MANIFEST_PATH) {
  const m = JSON.parse(fs.readFileSync(file, "utf8"));
  const errors = [];
  if (!m.discover || !Array.isArray(m.discover.node) || !Array.isArray(m.discover.python)) {
    errors.push("manifest.discover must have node[] and python[] glob lists");
  }
  const seen = new Set();
  for (const ex of m.exclude || []) {
    if (!ex.path) { errors.push(`exclusion without a path: ${JSON.stringify(ex)}`); continue; }
    if (seen.has(ex.path)) errors.push(`duplicate exclusion: ${ex.path}`);
    seen.add(ex.path);
    if (!EXCLUDE_CATEGORIES[ex.category]) errors.push(`${ex.path}: unknown category "${ex.category}" (use one of ${Object.keys(EXCLUDE_CATEGORIES).join(", ")})`);
    if (!ex.reason || ex.reason.trim().length < 20) errors.push(`${ex.path}: every exclusion needs a reason of at least 20 characters`);
    if (!fs.existsSync(path.join(ROOT, ex.path))) errors.push(`${ex.path}: excluded file does not exist (stale exclusion -- remove it)`);
  }
  for (const [file, vars] of Object.entries(m.env || {})) {
    for (const k of Object.keys(vars)) {
      if (SECRET_ENV_PATTERN.test(k)) errors.push(`${file}: manifest may not set "${k}" -- it looks like a secret or production opt-in`);
    }
  }
  for (const rv of m.tripwire_reviewed || []) {
    if (!rv.path || !rv.reason) errors.push(`tripwire_reviewed entry needs path and reason: ${JSON.stringify(rv)}`);
    else if (!fs.existsSync(path.join(ROOT, rv.path))) errors.push(`${rv.path}: tripwire_reviewed file does not exist`);
  }
  for (const p of m.partial || []) {
    if (!p.path || !Array.isArray(p.argv) || !EXCLUDE_CATEGORIES[p.category] || !p.reason || p.reason.trim().length < 20) {
      errors.push(`partial entry needs path, argv[], a known category and a reason: ${JSON.stringify(p)}`);
    } else if (!fs.existsSync(path.join(ROOT, p.path))) {
      errors.push(`${p.path}: partial-run file does not exist`);
    }
    for (const a of p.argv || []) {
      if (UNSAFE_ARG_PATTERN.test(a)) errors.push(`${p.path}: argument "${a}" looks like a production opt-in or write flag and may not be set by the suite`);
    }
  }
  for (const [file, to] of Object.entries(m.timeouts_seconds || {})) {
    if (!to || !Number.isFinite(to.seconds) || to.seconds <= 0 || !to.reason) errors.push(`${file}: timeouts_seconds entries are {seconds, reason}`);
    else if (!fs.existsSync(path.join(ROOT, file))) errors.push(`${file}: timeouts_seconds file does not exist`);
  }
  for (const k of m.known_network_attempts || []) {
    if (!k.path || !Array.isArray(k.targets) || !k.targets.length || !k.reason) errors.push(`known_network_attempts entry needs path, targets[] and reason: ${JSON.stringify(k)}`);
    else if (!fs.existsSync(path.join(ROOT, k.path))) errors.push(`${k.path}: known_network_attempts file does not exist`);
  }
  return { manifest: m, errors };
}

export const DEFAULT_TIMEOUT_SECONDS = 180;

// Arguments the manifest may never pass to a test.
export const UNSAFE_ARG_PATTERN = /^--?(allow-prod|prod|remote|live|apply|yes|send|post|publish|deploy|write|commit|fire)/i;

export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*" && glob[i + 2] === "/") { re += "(?:.*/)?"; i += 2; }
    else if (c === "*" && glob[i + 1] === "*") { re += ".*"; i += 1; }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      re += "(?:" + glob.slice(i + 1, end).split(",").map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&")).join("|") + ")";
      i = end;
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}

export function listRepoFiles() {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 });
  return out.toString("utf8").split("\0").filter(Boolean).filter((f) => fs.existsSync(path.join(ROOT, f)));
}

// Never executed, whatever the manifest says: anything under a dot-directory
// (.claude/worktrees holds whole old checkouts, including the deleted
// test_fire_ab.py that posted to Discord -- #1233) and known send scripts by name.
export const NEVER_RUN_BASENAMES = new Set(["test_fire_ab.py", "hall_test_summaries.sh"]);
export function neverRun(file) {
  return file.split("/").some((seg) => seg.startsWith(".")) || NEVER_RUN_BASENAMES.has(path.basename(file));
}

export function plan(manifest, files = listRepoFiles()) {
  const excluded = new Map((manifest.exclude || []).map((e) => [e.path, e]));
  const run = [];
  const skipped = [];
  const seen = new Set();
  for (const [lang, globs] of [["node", manifest.discover.node], ["python", manifest.discover.python]]) {
    const res = globs.map(globToRegExp);
    for (const f of files) {
      if (seen.has(f) || neverRun(f) || !res.some((r) => r.test(f))) continue;
      seen.add(f);
      if (excluded.has(f)) skipped.push({ ...excluded.get(f), lang });
      else run.push({ path: f, lang });
    }
  }
  // Exclusions that discovery does not reach are still reported: they document
  // send-capable or production-reading files that match a common test-runner
  // naming pattern (node --test, pytest) so nobody runs them by accident.
  const documented = (manifest.exclude || []).filter((e) => !seen.has(e.path));
  run.sort((a, b) => a.path.localeCompare(b.path));
  skipped.sort((a, b) => a.path.localeCompare(b.path));
  return { run, skipped, documented };
}

// ---------------------------------------------------------------------------
// Tripwire: a test that *itself* invokes production tooling must be reviewed
// by a person before the suite will execute it.

export const TRIPWIRE_PATTERNS = [
  { id: "wrangler-remote", re: /wrangler[^\n]{0,200}--remote|--remote[^\n]{0,200}wrangler/ },
  { id: "wrangler-deploy", re: /wrangler[^\n]{0,80}\b(deploy|publish|secret|d1 migrations apply)\b/ },
  { id: "keychain", re: /find-(generic|internet)-password/ },
  { id: "spawn-network-cli", re: /(spawn|exec|execFile|execSync|execFileSync|spawnSync|subprocess\.\w+|os\.system|Popen)\s*\(\s*\[?\s*["'`](curl|wget|wrangler|gh|security|npx)\b/ },
  { id: "credential-env", re: /(process\.env|os\.environ(\.get)?|getenv)\s*[[(.]\s*["'`]?(CLOUDFLARE_API_TOKEN|CF_API_TOKEN|DISCORD_BOT_TOKEN|DISCORD_WEBHOOK\w*|MFL_COOKIE\w*|MFL_PASSWORD|MFL_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|GITHUB_TOKEN|GH_TOKEN)/ },
];

export function tripwire(file, reviewed) {
  if (reviewed.has(file)) return [];
  return tripwireText(fs.readFileSync(path.join(ROOT, file), "utf8"));
}

export function tripwireText(src) {
  const hits = [];
  for (const p of TRIPWIRE_PATTERNS) {
    const m = p.re.exec(src);
    if (m) hits.push({ id: p.id, line: src.slice(0, m.index).split("\n").length, text: m[0].slice(0, 120) });
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Sandboxed environment

function which(cmd, PATH) {
  for (const dir of PATH.split(path.delimiter)) {
    const p = path.join(dir, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch { /* keep looking */ }
  }
  return null;
}

export function buildSandbox(parentEnv = process.env) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ups-safe-tests-"));
  const home = path.join(tmp, "home");
  const bin = path.join(tmp, "bin");
  const blocks = path.join(tmp, "blocks");
  for (const d of [home, bin, blocks]) fs.mkdirSync(d, { recursive: true });

  const parentPath = parentEnv.PATH || "/usr/bin:/bin";
  const realGit = which("git", parentPath);
  const python = which("python3", parentPath) || which("python", parentPath);

  const deny = (name) => `#!/bin/sh\necho "[safe-tests] blocked: '${name}' is not available in the safe offline suite (network, credentials or deploy)." >&2\nexit 97\n`;
  for (const name of DENIED_COMMANDS) {
    fs.writeFileSync(path.join(bin, name), deny(name), { mode: 0o755 });
  }
  if (realGit) {
    const blocked = GIT_NETWORK_SUBCOMMANDS.join("|");
    fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh
# [safe-tests] git wrapper: local subcommands only. Global options that take a
# separate value (-C dir, -c key=value, ...) are skipped with their value, so
# \`git -C . push\` is still recognized as a push.
skip=0
for a in "$@"; do
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  case "$a" in
    -C|-c|--git-dir|--work-tree|--namespace|--exec-path|--config-env|--super-prefix) skip=1; continue ;;
    -*) continue ;;
    ${blocked}) echo "[safe-tests] blocked: 'git $a' talks to a remote and is not available in the safe offline suite." >&2; exit 97 ;;
    *) break ;;
  esac
done
exec "${realGit}" "$@"
`, { mode: 0o755 });
  }
  // python3/python always resolve to the interpreter the runner found, ahead of anything else.
  if (python) {
    for (const name of ["python3", "python"]) {
      fs.symlinkSync(python, path.join(bin, name));
    }
  }

  const env = {
    PATH: [bin, path.dirname(process.execPath), parentPath].join(path.delimiter),
    HOME: home,
    USERPROFILE: home,
    TMPDIR: tmp,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    LANG: parentEnv.LANG || "en_US.UTF-8",
    NODE_OPTIONS: `--import=${pathToFileURL(NODE_GUARD).href}`,
    NODE_NO_WARNINGS: "1",
    PYTHONPATH: PY_GUARD_DIR,
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONUNBUFFERED: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    SAFE_TESTS: "1",
  };
  if (parentEnv.TZ) env.TZ = parentEnv.TZ;
  // HOME is a throwaway directory, which would also hide packages installed with
  // `pip install --user`. Point Python at the real user base: that is installed
  // code, not credentials.
  if (python) {
    const ub = spawnSync(python, ["-c", "import site; print(site.getuserbase())"], { env: { PATH: parentPath, HOME: parentEnv.HOME || "" }, encoding: "utf8" });
    if (ub.status === 0 && ub.stdout.trim()) env.PYTHONUSERBASE = ub.stdout.trim();
  }
  const dropped = Object.keys(parentEnv).filter((k) => !(k in env)).sort();
  return { tmp, home, bin, blocks, env, python, realGit, dropped };
}

// ---------------------------------------------------------------------------
// Execution

function runProcess(cmd, args, { env, cwd = ROOT, timeoutMs = 120000, maxOutput = 400 * 1024 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let truncated = false;
    const take = (buf) => {
      if (out.length < maxOutput) out += buf.toString("utf8");
      else truncated = true;
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
    }, timeoutMs);
    child.on("error", (err) => { take(Buffer.from(`\n[safe-tests] could not start: ${err.message}\n`)); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, ms: Date.now() - started, output: out + (truncated ? "\n[safe-tests] output truncated\n" : "") });
    });
  });
}

function commandFor(test, sandbox, argv = []) {
  if (test.lang === "node") return [process.execPath, [test.path, ...argv]];
  if (!sandbox.python) return [null, []];
  return [sandbox.python, [test.path, ...argv]];
}

async function runCanaries(sandbox) {
  const results = [];
  const env = { ...sandbox.env, SAFE_TESTS_BLOCK_LOG: path.join(sandbox.blocks, "canary.jsonl") };
  const node = await runProcess(process.execPath, [path.join(CANARY_DIR, "canary.mjs")], { env, timeoutMs: 30000 });
  results.push({ name: "Node guard: external fetch/https/tcp/dns blocked, loopback open", ok: node.code === 0, output: node.output });
  if (sandbox.python) {
    const py = await runProcess(sandbox.python, [path.join(CANARY_DIR, "canary.py")], { env, timeoutMs: 30000 });
    results.push({ name: "Python guard: external urllib/tcp/dns blocked, loopback open", ok: py.code === 0, output: py.output });
  } else {
    results.push({ name: "Python guard", ok: false, output: "python3 not found on PATH" });
  }
  const shims = [];
  for (const name of ["wrangler", "curl", "security", "gh", "npx"]) {
    const r = spawnSync("/bin/sh", ["-c", `${name} --version`], { env, encoding: "utf8" });
    shims.push(`${name}: exit ${r.status}`);
    if (r.status !== 97) results.push({ name: `PATH stub for ${name}`, ok: false, output: `${name} exited ${r.status}, expected 97\n${r.stdout}${r.stderr}` });
  }
  const pushes = ["git push --dry-run origin HEAD", "git -C . push --dry-run origin HEAD", "git -c core.pager=cat fetch --dry-run origin"]
    .map((cmd) => spawnSync("/bin/sh", ["-c", cmd], { env, cwd: ROOT, encoding: "utf8" }).status);
  const gitPush = { status: pushes.every((s) => s === 97) ? 97 : pushes.find((s) => s !== 97) };
  const gitLog = spawnSync("/bin/sh", ["-c", "git rev-parse --is-inside-work-tree"], { env, cwd: ROOT, encoding: "utf8" });
  results.push({
    name: "PATH stubs: wrangler/curl/security/gh/npx exit 97; git push/fetch blocked (also behind -C/-c); local git works",
    ok: shims.every((s) => s.endsWith("exit 97")) && gitPush.status === 97 && gitLog.status === 0,
    output: `${shims.join(", ")}; git push: exit ${gitPush.status}; git rev-parse: exit ${gitLog.status}`,
  });
  const leaked = Object.keys(env).filter((k) => SECRET_ENV_PATTERN.test(k));
  results.push({ name: "Environment: no secret-looking or opt-in variables passed to tests", ok: leaked.length === 0, output: leaked.join(", ") || "none" });
  return results;
}

export function networkInterfacesSummary() {
  const ifaces = os.networkInterfaces();
  return Object.keys(ifaces).sort();
}

// ---------------------------------------------------------------------------
// Working-tree protection. Fails closed: if git cannot report the tree, main()
// throws and the run exits 2.

// `git status --porcelain=v1 -z`: "XY path\0", and a rename or copy carries its
// original path as the next field.
export function parsePorcelainZ(out) {
  const entries = [];
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    entries.push({ xy: rec.slice(0, 2), path: rec.slice(3) });
    if (rec[0] === "R" || rec[0] === "C") i++;
  }
  return entries;
}

function fingerprint(abs) {
  try {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) return "symlink:" + fs.readlinkSync(abs);
    if (!st.isFile()) return "other";
    return "sha256:" + crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
  } catch {
    return "missing";
  }
}

// Every path git reports as modified, staged, deleted or untracked, with a
// byte-level fingerprint of what is on disk now.
export function snapshotTree(root = ROOT) {
  const out = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: root, encoding: "utf8" });
  const map = new Map();
  for (const e of parsePorcelainZ(out)) map.set(e.path, { xy: e.xy, fp: fingerprint(path.join(root, e.path)) });
  return map;
}

export function compareSnapshots(before, after) {
  const changes = [];
  for (const [p, b] of before) {
    const a = after.get(p);
    if (!a) changes.push(`${p}: was uncommitted ("${b.xy.trim()}") before the run and no longer is (reverted or deleted)`);
    else if (a.fp !== b.fp || a.xy !== b.xy) changes.push(`${p}: changed during the run`);
  }
  for (const [p, a] of after) {
    if (!before.has(p)) changes.push(`${p}: ${a.xy === "??" ? "created" : "modified"} during the run`);
  }
  return changes;
}

function backupDirty(snapshot, root = ROOT) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ups-safe-tests-backup-"));
  for (const [p] of snapshot) {
    const src = path.join(root, p);
    try {
      if (!fs.lstatSync(src).isFile()) continue;
      fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      fs.copyFileSync(src, path.join(dir, p));
    } catch { /* deleted in the worktree: nothing to back up */ }
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Provenance: which commit did this run actually test?
// On pull_request, actions/checkout checks out GitHub's merge commit
// (refs/pull/N/merge = $GITHUB_SHA), not the PR head. Its parents are
// [base, PR head]. The report names all three so nobody calls a merge-result run
// "CI on the exact head".
export function verifyProvenance({ head, parents = [], testedSha, prHead }) {
  const r = { ok: true, problems: [], kind: "local checkout", head, prHead: prHead ?? null, base: null };
  const full = /^[0-9a-f]{40}$/;
  if (testedSha !== undefined) {
    if (!full.test(testedSha)) { r.ok = false; r.problems.push(`--tested-sha must be a full 40-character SHA (got "${testedSha}")`); }
    else if (testedSha !== head) { r.ok = false; r.problems.push(`reported tested SHA ${testedSha} differs from the commit actually checked out (${head})`); }
  }
  if (prHead !== undefined) {
    if (!full.test(prHead)) { r.ok = false; r.problems.push(`--pr-head must be a full 40-character SHA (got "${prHead}")`); }
    else if (head === prHead) r.kind = "pr-head";
    else if (parents.length === 2 && parents[1] === prHead) { r.kind = "merge-result"; r.base = parents[0]; }
    else { r.ok = false; r.problems.push(`checked-out ${head} is neither PR head ${prHead} nor a merge commit whose second parent is it (parents: ${parents.join(", ") || "none"})`); }
  }
  return r;
}

export function describeProvenance(p) {
  const s = (x) => (x ? x.slice(0, 8) : "?");
  if (p.kind === "merge-result") return `merge result \`${s(p.head)}\`: GitHub's merge of PR head \`${s(p.prHead)}\` into base \`${s(p.base)}\` (not the PR head alone)`;
  if (p.kind === "pr-head") return `PR head \`${s(p.head)}\` itself`;
  return `local checkout at \`${s(p.head)}\``;
}

function readProvenance(root = ROOT) {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const parents = execFileSync("git", ["rev-list", "--parents", "-n", "1", "HEAD"], { cwd: root, encoding: "utf8" }).trim().split(/\s+/).slice(1);
  return { head, parents };
}

async function pool(items, n, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

function tail(text, lines = 40) {
  const all = text.trimEnd().split("\n");
  return all.slice(-lines).join("\n");
}

// ---------------------------------------------------------------------------
// Report

function markdownReport(r) {
  const L = [];
  const icon = r.ok ? "✅" : "❌";
  L.push(`## ${icon} Safe offline tests: ${r.ok ? "PASS" : "FAIL"}`);
  L.push("");
  L.push(`**${r.counts.passed} passed · ${r.counts.failed} failed · ${r.counts.timedOut} timed out · ${r.counts.excluded} excluded (named below) · ${r.counts.run} run** in ${(r.ms / 1000).toFixed(1)}s`);
  L.push("");
  L.push(`**Tested:** ${r.provenance.description}`);
  if (r.provenance.kind === "merge-result") L.push(`<br>PR head \`${r.provenance.prHead}\` · tested merge commit \`${r.provenance.tested}\` · base \`${r.provenance.base}\``);
  L.push("");
  if (r.problems.length) {
    L.push("### What failed");
    for (const p of r.problems) L.push(`- ${p}`);
    L.push("");
  }
  for (const t of r.tests.filter((x) => !x.ok)) {
    L.push(`<details open><summary>❌ <code>${t.path}</code> — ${t.timedOut ? "timed out" : `exit ${t.code ?? t.signal}`}</summary>`);
    L.push("");
    L.push("```text");
    L.push(tail(t.output).replace(/```/g, "ʼʼʼ"));
    L.push("```");
    L.push("</details>");
    L.push("");
  }
  L.push("### Safety checks");
  L.push(`- Network: ${r.network}`);
  for (const c of r.canaries) L.push(`- ${c.ok ? "✅" : "❌"} ${c.name}`);
  const unexpected = r.blocked.filter((b) => !b.known);
  L.push(`- Network attempts blocked during tests: ${r.blocked.length} (${r.blocked.length - unexpected.length} known and named below, ${unexpected.length} unexpected${unexpected.length ? " ❌" : ""})`);
  const grouped = new Map();
  for (const b of r.blocked) {
    const k = `${b.test} → ${b.what} ${b.target}`;
    grouped.set(k, { b, n: (grouped.get(k)?.n || 0) + 1 });
  }
  for (const [k, { b, n }] of [...grouped].slice(0, 30)) L.push(`  - ${b.known ? "known" : "**unexpected**"}: \`${k}\` ×${n}`);
  L.push(`- Working tree after the run (byte-level): ${r.pollution.length ? `${r.pollution.length} change(s) ❌` : "unchanged ✅"}`);
  for (const p of r.pollution.slice(0, 20)) L.push(`  - \`${p}\``);
  L.push(`- Environment variables withheld from tests: ${r.droppedEnvCount} (secrets and opt-ins are never passed)`);
  L.push("");
  L.push(`### Excluded (${r.skipped.length + r.documented.length}) — named, never silently skipped`);
  L.push("");
  L.push("| File | Category | Why |");
  L.push("| --- | --- | --- |");
  for (const s of [...r.skipped, ...r.documented]) {
    L.push(`| \`${s.path}\` | ${s.category} | ${String(s.reason).replace(/\|/g, "\\|")}${s.issue ? ` (${s.issue})` : ""} |`);
  }
  L.push("");
  if (r.partial.length) {
    L.push(`### Run with part of the file switched off (${r.partial.length})`);
    L.push("");
    L.push("| File | Arguments | Category | Why |");
    L.push("| --- | --- | --- | --- |");
    for (const p of r.partial) L.push(`| \`${p.path}\` | \`${p.argv.join(" ")}\` | ${p.category} | ${String(p.reason).replace(/\|/g, "\\|")}${p.issue ? ` (${p.issue})` : ""} |`);
    L.push("");
  }
  if (r.knownNetwork.length) {
    L.push(`### Known network attempts (blocked every run; the test passes without them)`);
    L.push("");
    for (const k of r.knownNetwork) L.push(`- \`${k.path}\` → ${k.targets.map((x) => `\`${x}\``).join(", ")}: ${k.reason}`);
    L.push("");
  }
  L.push(`<details><summary>All ${r.tests.length} tests run</summary>`);
  L.push("");
  for (const t of r.tests) L.push(`- ${t.ok ? "✅" : "❌"} \`${t.path}\` (${(t.ms / 1000).toFixed(1)}s)`);
  L.push("</details>");
  L.push("");
  L.push("Command: `node scripts/safe_tests/run.mjs` · How it stays offline: `docs/SAFE_TESTS.md`");
  return L.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Main

function parseArgs(argv) {
  const a = { concurrency: Math.min(4, Math.max(1, os.cpus().length)) };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--list") a.list = true;
    else if (k === "--expect-no-network") a.expectNoNetwork = true;
    else if (k === "--allow-dirty") a.allowDirty = true;
    else if (k === "--tested-sha") a.testedSha = argv[++i];
    else if (k === "--pr-head") a.prHead = argv[++i];
    else if (k === "--only") a.only = argv[++i];
    else if (k === "--files") a.files = argv[++i].split(",").filter(Boolean);
    else if (k === "--concurrency") a.concurrency = Number(argv[++i]) || 1;
    else if (k === "--json") a.json = argv[++i];
    else if (k === "--summary") a.summary = argv[++i];
    else if (k === "--help" || k === "-h") a.help = true;
    else throw new Error(`unknown option ${k}`);
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
    return 0;
  }
  const started = Date.now();
  const { manifest, errors } = loadManifest();
  const problems = [...errors];
  let { run, skipped, documented } = plan(manifest);
  if (args.files) {
    const refused = args.files.filter(neverRun);
    for (const f of refused) problems.push(`\`${f}\` is on the never-run list (dot-directory or a known send script) and was not run.`);
    run = args.files.filter((f) => !neverRun(f)).map((f) => ({ path: f, lang: f.endsWith(".py") ? "python" : "node" }));
  } else if (args.only) {
    run = run.filter((t) => t.path.includes(args.only));
    if (!run.length) problems.push(`--only ${args.only}: no planned test matches`);
  } else if (!run.length) {
    problems.push("Discovery found no tests: tests/safe_suite.json globs are broken. An empty run is a failure, not a pass.");
  }

  const reviewed = new Set((manifest.tripwire_reviewed || []).map((r) => r.path));
  for (const t of run) {
    const hits = tripwire(t.path, reviewed);
    if (hits.length) {
      t.tripwire = hits;
      problems.push(`\`${t.path}\` was NOT run: its source invokes production tooling (${hits.map((h) => `${h.id} at line ${h.line}`).join("; ")}). Review it, then exclude it or list it under tripwire_reviewed in tests/safe_suite.json.`);
    }
  }

  if (args.list) {
    console.log(`Would run ${run.length} tests (node ${run.filter((t) => t.lang === "node").length}, python ${run.filter((t) => t.lang === "python").length}):`);
    for (const t of run) console.log(`  ${t.tripwire ? "TRIPWIRE " : ""}${t.path}`);
    console.log(`\nExcluded ${skipped.length + documented.length}:`);
    for (const s of [...skipped, ...documented]) console.log(`  [${s.category}] ${s.path} -- ${s.reason}`);
    for (const p of manifest.partial || []) console.log(`\nPartial: ${p.path} ${p.argv.join(" ")} [${p.category}] -- ${p.reason}`);
    for (const k of manifest.known_network_attempts || []) console.log(`Known network attempt (blocked): ${k.path} -> ${k.targets.join(", ")}`);
    if (problems.length) { console.log("\nProblems:"); for (const p of problems) console.log(`  - ${p}`); }
    return problems.length ? 1 : 0;
  }

  const sandbox = buildSandbox();
  let network = "not isolated by the OS on this machine; the Node/Python guards and PATH stubs are the network barrier";
  const canaries = [];
  if (args.expectNoNetwork) {
    const ifaces = networkInterfacesSummary();
    const external = ifaces.filter((n) => n !== "lo" && n !== "lo0");
    network = external.length ? `NOT isolated: interfaces ${ifaces.join(", ")}` : `isolated network namespace, interfaces: ${ifaces.join(", ") || "(none)"}`;
    canaries.push({ name: "OS network isolation: loopback is the only interface (--expect-no-network)", ok: external.length === 0, output: `interfaces: ${ifaces.join(", ")}` });
  }

  const prov = verifyProvenance({ ...readProvenance(), testedSha: args.testedSha, prHead: args.prHead });
  if (args.testedSha !== undefined || args.prHead !== undefined) {
    canaries.push({ name: "Provenance: the reported tested SHA is the commit actually checked out", ok: prov.ok, output: prov.ok ? describeProvenance(prov) : prov.problems.join("\n") });
  }

  const inCI = Boolean(process.env.GITHUB_ACTIONS || process.env.CI);
  const before = snapshotTree();
  let backupDir = null;
  if (args.allowDirty && inCI) {
    canaries.push({ name: "Working tree: --allow-dirty is refused in CI", ok: false, output: "CI checkouts are clean; --allow-dirty is for local runs only." });
  } else if (before.size && !args.allowDirty) {
    canaries.push({
      name: "Working tree: clean before the run",
      ok: false,
      output: `${before.size} uncommitted change(s): ${[...before.keys()].slice(0, 8).join(", ")}${before.size > 8 ? ", ..." : ""}\n` +
        "The suite will not run tests over uncommitted work: a test that rewrote one of these files could destroy it. " +
        "Commit or stash it, or run in a clean worktree (git worktree add). Locally, --allow-dirty backs the files up and compares them byte for byte.",
    });
  } else if (before.size) {
    backupDir = backupDirty(before);
    canaries.push({ name: `Working tree: ${before.size} uncommitted file(s) backed up (--allow-dirty)`, ok: true, output: backupDir });
  } else {
    canaries.push({ name: "Working tree: clean before the run", ok: true, output: "" });
  }

  canaries.push(...(await runCanaries(sandbox)));
  const canaryFailed = canaries.filter((c) => !c.ok);
  for (const c of canaryFailed) problems.push(`Guard check failed: ${c.name}\n\n  ${tail(c.output, 15).replace(/\n/g, "\n  ")}`);

  let tests = [];
  if (canaryFailed.length) {
    problems.push("No tests were run because a guard check failed.");
  } else {
    const runnable = run.filter((t) => !t.tripwire);
    const timeouts = manifest.timeouts_seconds || {};
    const serial = new Set(manifest.serial || []);
    const partial = new Map((manifest.partial || []).map((p) => [p.path, p]));
    const exec = async (t) => {
      const [cmd, cargs] = commandFor(t, sandbox, partial.get(t.path)?.argv || []);
      const blockLog = path.join(sandbox.blocks, t.path.replace(/[\\/]/g, "__") + ".jsonl");
      const env = { ...sandbox.env, ...(manifest.env?.[t.path] || {}), SAFE_TESTS_BLOCK_LOG: blockLog };
      if (!cmd) return { ...t, ok: false, code: null, ms: 0, output: "python3 not found" };
      const r = await runProcess(cmd, cargs, { env, timeoutMs: (timeouts[t.path]?.seconds || DEFAULT_TIMEOUT_SECONDS) * 1000 });
      const ok = r.code === 0 && !r.timedOut;
      process.stdout.write(`${ok ? "ok  " : "FAIL"} ${t.path} (${(r.ms / 1000).toFixed(1)}s)\n`);
      return { ...t, ...r, ok, blockLog };
    };
    const parallel = runnable.filter((t) => !serial.has(t.path));
    const sequential = runnable.filter((t) => serial.has(t.path));
    tests = [...(await pool(parallel, args.concurrency, exec)), ...(await pool(sequential, 1, exec))];
    tests.sort((a, b) => a.path.localeCompare(b.path));
  }

  const blocked = [];
  for (const t of tests) {
    if (t.blockLog && fs.existsSync(t.blockLog)) {
      for (const line of fs.readFileSync(t.blockLog, "utf8").split("\n").filter(Boolean)) {
        try { blocked.push({ test: t.path, ...JSON.parse(line) }); } catch { /* ignore partial line */ }
      }
    }
  }
  // A blocked attempt is expected only where the manifest names the test and the
  // target. Anything else is a new hidden network dependency: fail the run.
  const known = manifest.known_network_attempts || [];
  for (const b of blocked) {
    b.known = known.some((k) => k.path === b.test && k.targets.some((prefix) => String(b.target).startsWith(prefix)));
  }
  const unexpected = blocked.filter((b) => !b.known);
  for (const t of [...new Set(unexpected.map((b) => b.test))]) {
    const targets = [...new Set(unexpected.filter((b) => b.test === t).map((b) => `${b.what} ${b.target}`))];
    problems.push(`\`${t}\` tried to reach the network (blocked): ${targets.join("; ")}. Stub the call, or name it under known_network_attempts in tests/safe_suite.json with a reason.`);
  }
  const pollution = compareSnapshots(before, snapshotTree());
  if (pollution.length) {
    problems.push(`Tests changed the working tree (a test must not write into the repo): ${pollution.join("; ")}` +
      (backupDir ? `. Your files as they were before the run are in ${backupDir}` : ""));
  } else if (backupDir) {
    fs.rmSync(backupDir, { recursive: true, force: true });
    backupDir = null;
  }
  for (const t of tests.filter((x) => !x.ok)) {
    problems.push(`\`${t.path}\` ${t.timedOut ? "timed out" : `failed (exit ${t.code ?? t.signal})`}`);
    if (process.env.GITHUB_ACTIONS) {
      const msg = tail(t.output, 6).replace(/%/g, "%25").replace(/\r/g, "").replace(/\n/g, "%0A");
      console.log(`::error file=${t.path},title=Safe offline test failed::${msg}`);
    }
  }

  const counts = {
    run: tests.length,
    passed: tests.filter((t) => t.ok).length,
    failed: tests.filter((t) => !t.ok && !t.timedOut).length,
    timedOut: tests.filter((t) => t.timedOut).length,
    excluded: skipped.length + documented.length,
  };
  const result = {
    ok: problems.length === 0,
    ms: Date.now() - started,
    counts,
    problems,
    canaries,
    network,
    blocked,
    pollution,
    backupDir,
    provenance: { kind: prov.kind, tested: prov.head, prHead: prov.prHead, base: prov.base, ok: prov.ok, description: describeProvenance(prov) },
    droppedEnvCount: sandbox.dropped.length,
    skipped,
    documented,
    partial: manifest.partial || [],
    knownNetwork: known,
    tests: tests.map(({ path: p, lang, ok, code, signal, timedOut, ms, output }) => ({ path: p, lang, ok, code, signal, timedOut, ms, output })),
    node: process.version,
    python: sandbox.python ? spawnSync(sandbox.python, ["--version"], { encoding: "utf8" }).stdout.trim() : null,
  };

  const md = markdownReport(result);
  const summaryPath = args.summary || process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) fs.appendFileSync(summaryPath, md);
  if (args.json) fs.writeFileSync(args.json, JSON.stringify(result, null, 2));

  console.log("");
  console.log(`Safe offline tests: ${result.ok ? "PASS" : "FAIL"} -- ${counts.passed} passed, ${counts.failed} failed, ${counts.timedOut} timed out, ${counts.excluded} excluded, ${(result.ms / 1000).toFixed(1)}s`);
  console.log(`Network: ${network}`);
  console.log(`Tested: ${result.provenance.description.replace(/`/g, "")} [tested=${prov.head}${prov.prHead ? ` pr_head=${prov.prHead}` : ""}${prov.base ? ` base=${prov.base}` : ""}]`);
  console.log(`Blocked network attempts: ${blocked.length}; working tree changes: ${pollution.length}; env vars withheld: ${sandbox.dropped.length}`);
  if (problems.length) {
    console.log("\nProblems:");
    for (const p of problems) console.log(`  - ${p}`);
    for (const t of tests.filter((x) => !x.ok)) {
      console.log(`\n----- ${t.path} (last 40 lines) -----\n${tail(t.output)}`);
    }
  }
  fs.rmSync(sandbox.tmp, { recursive: true, force: true });
  return result.ok ? 0 : 1;
}

// Compare real paths: invoked through a symlink (macOS /var -> /private/var, a
// symlinked checkout) a plain path comparison is false and the script would
// silently do nothing and exit 0 -- a pass that tested nothing.
const invokedDirectly = (() => {
  try { return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (invokedDirectly) {
  main().then((code) => process.exit(code), (err) => { console.error(err); process.exit(2); });
}
