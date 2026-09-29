// Regression coverage for the #1141 release incident (2026-09-29): a
// comment added inside worker/src/index.js's `mfl_scoring_agg` SQL template
// literal wrapped a code snippet in markdown-style backticks -- but that
// comment lives INSIDE a JS backtick-delimited template literal (the SQL
// string sent to D1), so the stray backtick pair closed the JS string
// early. Everything after it was then parsed as bare JavaScript tokens.
// deploy-worker.yml's "Lint (no-undef gate)" step (worker/eslint.config.mjs,
// run as `npx --yes eslint@9 src/` from the worker/ directory) correctly
// caught it as "Parsing error: Unexpected token COALESCE" -- but only AFTER
// the merge had already landed, so #1141's actual fix never went live until
// the follow-up hotfix (#1146).
//
// A LESSON LEARNED WHILE WRITING THIS TEST: `node --check <file>` on a copy
// of the broken content placed OUTSIDE worker/ (e.g. a generic OS tmp dir)
// parses it WITHOUT error -- worker/package.json declares
// `"type": "module"`, and Node's module-vs-script detection is resolved
// from the nearest package.json ancestor. Outside that tree, Node's
// "detect module syntax" auto-heuristic parses the same broken text more
// leniently and misses the bug entirely. Placed back INSIDE worker/src/
// (inheriting the real "type":"module"), `node --check` throws the correct
// SyntaxError. Both checks below place their fixtures inside worker/src/
// for exactly this reason -- a fixture in an unrelated tmp dir gives false
// confidence.
//   node tests/worker_syntax_check.test.mjs
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import assert from "assert";

let fails = 0;
const check = (n, fn) => { try { fn(); console.log("  ok   " + n); }
  catch (e) { fails++; console.log("  FAIL " + n + "\n         " + e.message); } };

const WORKER_DIR = path.resolve("worker");
const BROKEN_COMMIT = "004f2f2450a24678a4f95c5c9c88f34926c4b329"; // #1141's merge, pre-#1146 hotfix

function nodeCheck(absFilePath) {
  try {
    execFileSync("node", ["--check", absFilePath], { stdio: "pipe" });
    return { ok: true, output: "" };
  } catch (e) {
    return { ok: false, output: (e.stderr || Buffer.from("")).toString() };
  }
}
// Exact CI invocation: `npx --yes eslint@9 src/<relPath>`, cwd worker/.
function runEslint(srcRelPath) {
  try {
    const out = execFileSync("npx", ["--yes", "eslint@9", srcRelPath],
      { cwd: WORKER_DIR, stdio: "pipe", maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, output: out.toString() };
  } catch (e) {
    return { ok: false, output: ((e.stdout || Buffer.from("")).toString() + (e.stderr || Buffer.from("")).toString()) };
  }
}
function readBrokenCommitSrc() {
  try {
    return execFileSync("git", ["show", `${BROKEN_COMMIT}:worker/src/index.js`],
      { stdio: "pipe", maxBuffer: 64 * 1024 * 1024 }).toString();
  } catch (e) {
    throw new Error(`could not read ${BROKEN_COMMIT}:worker/src/index.js from git history -- ` +
      "is this a shallow clone missing that commit? " + (e.stderr || e.message));
  }
}
function withTempFixture(relFilename, contents, fn) {
  const abs = path.join(WORKER_DIR, "src", relFilename);
  fs.writeFileSync(abs, contents);
  try { return fn(`src/${relFilename}`, abs); }
  finally { fs.rmSync(abs, { force: true }); }
}

console.log("1. eslint (the exact CI command) -- current file must pass, the historical bug must fail");
check("npx --yes eslint@9 src/index.js (cwd worker/) passes on the current (fixed) source", () => {
  const r = runEslint("src/index.js");
  assert.ok(r.ok, "current worker/src/index.js should lint clean: " + r.output.slice(0, 500));
});
check(`the exact pre-#1146 commit (${BROKEN_COMMIT}) fails that same eslint command`, () => {
  const brokenSrc = readBrokenCommitSrc();
  withTempFixture("_regression_eslint_backtick_incident.js", brokenSrc, (relPath) => {
    const r = runEslint(relPath);
    assert.ok(!r.ok, "expected the pre-hotfix commit to fail eslint, but it passed");
    assert.match(r.output, /Unexpected token COALESCE/,
      "expected the exact historical parse error (a stray backtick inside the mfl_scoring_agg comment closed the template literal early)");
  });
});

console.log("\n2. node --check, scoped inside worker/ so it inherits \"type\":\"module\" -- same verdict, no eslint/network dependency");
check("worker/package.json declares type:module (the reason location matters for this check)", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(WORKER_DIR, "package.json"), "utf8"));
  assert.strictEqual(pkg.type, "module");
});
check("node --check passes on the current (fixed) source", () => {
  const r = nodeCheck(path.join(WORKER_DIR, "src", "index.js"));
  assert.ok(r.ok, "current worker/src/index.js should have no syntax errors: " + r.output);
});
check(`node --check fails on the pre-#1146 commit WHEN placed inside worker/src/`, () => {
  const brokenSrc = readBrokenCommitSrc();
  withTempFixture("_regression_nodecheck_backtick_incident.js", brokenSrc, (_relPath, abs) => {
    const r = nodeCheck(abs);
    assert.ok(!r.ok, "expected node --check to fail on the pre-hotfix commit");
    assert.match(r.output, /Unexpected identifier 'COALESCE'|Unexpected token/,
      "expected a syntax error naming the same stray COALESCE token eslint reported");
  });
});
check(`the SAME broken content placed OUTSIDE worker/ (no "type":"module" ancestor) is a false negative -- documents why fixture location matters`, () => {
  const brokenSrc = readBrokenCommitSrc();
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "regression-outside-"));
  const outsideFile = path.join(outsideDir, "index.js");
  fs.writeFileSync(outsideFile, brokenSrc);
  const r = nodeCheck(outsideFile);
  fs.rmSync(outsideDir, { recursive: true, force: true });
  assert.ok(r.ok, "expected THIS to (wrongly) pass -- demonstrating why the checks above deliberately run inside worker/src/, not a generic tmp dir");
});

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
