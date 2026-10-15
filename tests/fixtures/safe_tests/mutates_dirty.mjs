// Fixture for tests/safe_tests_runner.test.mjs (MAT-4): a "test" that passes
// while damaging the worktree. It appends to notes.txt (already dirty in one
// scenario, clean in another) and deletes the untracked scratch.txt if present.
// It acts only inside the throwaway self-test repo, which carries a marker file.
import fs from "node:fs";

if (!fs.existsSync("SELFTEST_REPO_MARKER")) {
  console.log("not inside the safe-tests self-test repo; doing nothing");
  process.exit(1);
}
fs.appendFileSync("notes.txt", "a test wrote this line\n");
if (fs.existsSync("scratch.txt")) fs.rmSync("scratch.txt");
console.log("this fixture passes, but it changed the worktree");
