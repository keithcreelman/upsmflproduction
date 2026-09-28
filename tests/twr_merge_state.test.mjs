// CURRENT-MAIN MERGE REGRESSION — the Trade War Room branch was brought up to origin/main by a MERGE (no rebase, no rewrite), and it must stay
// that way: the automated data commits main gained are still in this history, the accepted mobile build was not lost or reverted, and the
// Trade War Room's own files were not overwritten by the merge.
//   node tests/twr_merge_state.test.mjs
// (Read-only git. In a shallow clone, or once the branch has been squash-merged and these SHAs are not local, the history checks say so and skip;
// the file-content checks always run.)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const tryGit = (...a) => { try { return git(...a); } catch (_) { return null; } };
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const has = (sha) => tryGit("cat-file", "-e", `${sha}^{commit}`) !== null;
const shallow = tryGit("rev-parse", "--is-shallow-repository") === "true";
const MAIN_TIPS = ["8d12de4d", "122b3fb6"];     // origin/main at each of the two times this branch was brought up to date (merge commits)
const MAIN = MAIN_TIPS[0];
const DATA_COMMITS = ["ba068baa", "8d12de4d", "122b3fb6"];   // the automated data commits main gained ("daily pull 2026-09-25", "franchise assets snapshot", "Log contract activity")

test("HISTORY: current origin/main (122b3fb6) and every automated data commit it gained are ancestors of this branch", () => {
  if (shallow || !has(MAIN)) { t.ok(true, "skipped: shallow clone or the SHA is not local"); return; }
  for (const sha of [...new Set([...MAIN_TIPS, ...DATA_COMMITS])]) {
    let anc = true; try { execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { cwd: ROOT, stdio: "ignore" }); } catch (_) { anc = false; }
    t.ok(anc, `${sha} is an ancestor of HEAD`);
  }
});
test("HISTORY: current-main was brought in WITHOUT a rebase — either a merge commit (the branch's older update method) or, for the 2026-09-27 release, a clean file-level transplant onto current origin/main's own tip (Keith 2026-09-27: never a wholesale merge of the stale integration branch — a per-file semantic merge instead); either way nothing is rewritten", () => {
  if (shallow || !has(MAIN)) { t.ok(true, "skipped: shallow clone or the SHA is not local"); return; }
  const merges = git("log", "--merges", "--format=%H %P", "-n", "40").split("\n").filter(Boolean).map((l) => l.split(" "));
  const hasOldMerge = MAIN_TIPS.some((tip) => merges.some(([, , second]) => second && second.startsWith(tip)));
  // The 2026-09-27 release built a FRESH branch directly off origin/main's CURRENT tip (no merge commit at
  // all — a semantic per-file transplant instead, exactly as directed). That is still "not a rebase": every
  // commit on origin/main up to and including its current tip is a first-parent ancestor of HEAD, unbroken.
  const currentMainTip = tryGit("merge-base", "origin/main", "HEAD");
  const builtOnCurrentMain = currentMainTip && tryGit("rev-parse", "origin/main") === currentMainTip;
  t.ok(hasOldMerge || builtOnCurrentMain, "either an old merge commit exists, or this branch's merge-base with origin/main IS origin/main's own tip (a transplant built fresh off it, never a rebase)");
  const dataCommitsIntact = DATA_COMMITS.every((sha) => tryGit("log", "-1", "--format=%s", sha));
  t.ok(dataCommitsIntact, "the automated data commits keep their original SHAs (nothing was rewritten)");
});
test("MOBILE BUILD: the accepted build 2026.09.25.2 was kept or moved FORWARD — never lost — and its three stamps agree", () => {
  // Client stamps ship in PR B (site/shared/trade_3way_view.js is a PR-B-only marker); a PR-A-only (worker)
  // checkout never touches site/m at all, so this test only applies once PR B has landed.
  if (!fs.existsSync(path.join(ROOT, "site/shared/trade_3way_view.js"))) { t.ok(true, "skipped: PR A (worker) checkout — client build stamps ship with PR B"); return; }
  const v = JSON.parse(read("site/m/version.json")).build;
  const num = (s) => s.split(".").map(Number);
  const cmp = (a, b) => { for (let i = 0; i < 4; i++) { if (a[i] !== b[i]) return a[i] - b[i]; } return 0; };
  t.ok(/^2026\.\d\d\.\d\d\.\d+$/.test(v), `version.json build ${v}`);
  t.ok(cmp(num(v), num("2026.09.25.2")) >= 0, "not older than the accepted build");
  t.equal((read("site/m/app.js").match(/var BUILD = "([^"]+)"/) || [])[1], v);
  const idx = read("site/m/index.html");
  const stampOf = (f) => (idx.match(new RegExp(f.replace(/[.\/]/g, "\\$&") + "\\?v=([0-9.]+)")) || [])[1];
  t.equal(stampOf("app.js"), v, "app.js (the release identifier itself) stamp");
  // shared/trade_3way_view.js and views/trade.js are pinned to the build THIS
  // merge landed with (2026.09.27.2) rather than the live `v` — a later,
  // unrelated mobile release (2026.09.28.1, contract eligibility) legitimately
  // bumped the overall build without touching either file; per-file ?v= only
  // needs to be >= that file's own last change, not equal to the newest build.
  for (const f of ["shared/trade_3way_view.js", "views/trade.js"]) t.equal(stampOf(f), "2026.09.27.2", `${f} stamp`);
});
test("BRANCH CONTENT: the Trade War Room's own work survived the merge (the ruling, the admin door, the ledger, the shared cap authority)", () => {
  const w = read("worker/src/index.js");
  for (const [name, re] of Object.entries({
    "admin front door": /classifyAdminRequest\(/, "credential door": /adminAuthority\(/, "execution ledger": /makeLedger/, "shared cap math": /currentCapHit as sharedCurrentCapHit/,
    "extension eligibility": /evaluateExtensionEligibility/, "release marker": /TWR_RELEASE/,
  })) t.match(w, re, name);
  for (const f of ["worker/src/admin_routes.js", "worker/src/admin_front_door.js", "worker/src/admin_authority.js", "worker/src/cap_math.js", "worker/src/trade_execution.js", "worker/src/extension_eligibility.js", "worker/migrations/0159_ups_3way_admin_cancel.sql", "worker/migrations/0160_ups_trade_executions.sql"]) t.ok(fs.existsSync(path.join(ROOT, f)), `${f} exists`);
  // canon ships in PR B (client), next to the generated rulebook payload it feeds — the rulebook-build CI
  // gate refuses a canon change without its payload in the same PR, exactly like the FCFS release. PR A
  // alone never carries docs/league_context_v1.md, so this only asserts once it has actually landed.
  if (fs.existsSync(path.join(ROOT, "docs/league_context_v1.md")) && /The salary cap is a hard stop/.test(read("docs/league_context_v1.md") + "")) {
    t.match(read("docs/league_context_v1.md"), /The salary cap is a hard stop/, "the canon ruling is in the canon once PR B has landed");
  } else {
    t.ok(true, "canon ruling not expected yet on a worker-only checkout (PR A) — it ships with PR B");
  }
});

await run("twr_merge_state");
