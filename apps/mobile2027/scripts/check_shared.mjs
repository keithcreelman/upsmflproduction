#!/usr/bin/env node
// Checks the beta's use of the classic app's shared code against the REAL files in site/shared/.
//
//   node apps/mobile2027/scripts/check_shared.mjs            exit 1 if anything differs (use on a beta change)
//   node apps/mobile2027/scripts/check_shared.mjs --notice   report only, always exit 0 (use on a classic change)
//
// Why this is a script and not part of the safe test suite: the classic app's releases must never wait on the beta. The
// suite's beta tests run against reviewed copies in tests/fixtures/mobile2027/shared/, so a change to a file in site/shared/
// cannot turn a classic pull request red. What a classic change CAN do is make the beta's pins stale. This script is where
// that shows up, in two ways that never touch the classic release:
//   * on a pull request that changes site/shared/, a notice (a warning line, not a failure) says which module the beta pins;
//   * the beta's own build and deploy script refuse a module that no longer matches its pin, so nothing stale can be published.
// Checked here, against the real files: the pins; that each module is still free of write and network code (the Preview scan);
// that each loads as a plain script and makes no request while loading; and that the beta's contract parser still agrees with
// the shared cap math for every recorded player in the test recording.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { DERIVED, LOCK, REPO, SHARED, SHARED_DIR, SRC, derivedOut, readLock, scan, scanWriteCode, sharedOut } from "./build.mjs";
import { compareResolvers, loadResolver } from "./injury_equivalence.mjs";

const require = createRequire(import.meta.url);
const GLOBALS = { "contract_windows.js": "UPS_CONTRACT_WINDOWS", "taxi_rule.js": "UPS_TAXI_RULE",
  // Standings (#1503); standings_clinch.js and odds_display.js are #1521's reviewed head (b5b02799)
  "standings_race.js": "UPS_STANDINGS_RACE", "standings_clinch.js": "UPS_STANDINGS_CLINCH", "odds_display.js": "UPS_ODDS_DISPLAY" };

// `opts` ({ sharedDir, lockPath, capMath, recording }) is only passed by tests, to stand in for the repository.
export function checkShared(opts = {}) {
  const sharedDir = opts.sharedDir || SHARED_DIR, lockPath = opts.lockPath || LOCK;
  const capMathPath = opts.capMath || path.join(sharedDir, "cap_math.js");
  const recordingPath = opts.recording || path.join(REPO, "tests", "fixtures", "mobile2027", "public_reads.json");
  const items = [];
  const add = (name, ok, detail) => items.push({ name, ok: !!ok, detail: detail || "" });

  const lock = readLock(lockPath);
  if (!lock || !lock.files) { add("the pin file", false, "shared.lock.json is missing or unreadable"); return finish(items); }
  for (const n of SHARED) {
    const file = path.join(sharedDir, n);
    if (!fs.existsSync(file)) { add(`${n}: present`, false, `site/shared/${n} is gone`); continue; }
    const text = fs.readFileSync(file, "utf8");
    const actual = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    add(`${n}: bytes equal the pin`, lock.files[n] === actual, lock.files[n] === actual ? "" : `site/shared/${n} changed since the beta pinned it. Review whether the beta may take the change, then run: node apps/mobile2027/scripts/build.mjs --write-lock`);
    const problems = [...scan(sharedOut(n), text), ...scanWriteCode(sharedOut(n), text)];
    add(`${n}: still free of write and network code`, problems.length === 0, problems.join("; "));
    const calls = [];
    const sandbox = { fetch: () => { calls.push("fetch"); }, XMLHttpRequest: function () { calls.push("xhr"); } };
    sandbox.window = sandbox; vm.createContext(sandbox);
    let loaded = true, why = "";
    try { vm.runInContext(text, sandbox, { filename: n }); } catch (e) { loaded = false; why = String(e && e.message || e); }
    add(`${n}: loads and attaches ${GLOBALS[n]}`, loaded && !!sandbox[GLOBALS[n]], why);
    add(`${n}: makes no request while loading`, calls.length === 0, calls.join(","));
  }
  for (const n of Object.keys(lock.files)) if (!SHARED.includes(n)) add(`pin for ${n}`, false, "the lock pins a module that is not on the SHARED list");

  // derived copies: the classic source and the extraction, each against its pin, then the original and the derived side by side
  for (const d of DERIVED) {
    const file = path.join(sharedDir, d.name), pin = lock.derived && lock.derived[d.name];
    if (!fs.existsSync(file)) { add(`${d.name}: present`, false, `site/shared/${d.name} is gone`); continue; }
    const buf = fs.readFileSync(file), text = buf.toString("utf8");
    add(`${d.name}: bytes equal the pin`, !!pin && pin.source === crypto.createHash("sha256").update(buf).digest("hex"), `site/shared/${d.name} changed since the beta pinned it (the beta derives ${d.out} from it). Review whether the beta may take the change, then run: node apps/mobile2027/scripts/build.mjs --write-lock`);
    const r = d.derive(text);
    add(`${d.out}: the extraction still applies`, r.ok, r.why || "");
    if (!r.ok) continue;
    add(`${d.out}: equals its pin`, !!pin && pin.output === crypto.createHash("sha256").update(Buffer.from(r.text, "utf8")).digest("hex"), "the derived result differs from the pinned, reviewed one");
    const problems = [...scan(derivedOut(d), r.text), ...scanWriteCode(derivedOut(d), r.text)];
    add(`${d.out}: free of write and network code`, problems.length === 0, problems.join("; "));
    const eq = compareResolvers(text, r.text);
    add(`${d.out}: answers exactly like ${d.name} (${eq.cases} generated cases)`, eq.diffs.length === 0, eq.diffs.slice(0, 3).join(" | "));
  }
  for (const n of Object.keys((lock.derived) || {})) if (!DERIVED.some((d) => d.name === n)) add(`derived pin for ${n}`, false, "the lock pins a derived copy that is not on the DERIVED list");

  // the beta's contract parser against the shared cap math, for every recorded player
  try {
    const ctx = vm.createContext({});
    vm.runInContext(fs.readFileSync(capMathPath, "utf8"), ctx);
    const CM = ctx.UPS_CAP_MATH;
    const C = require(path.join(SRC, "lib", "contract.js"));
    const rec = JSON.parse(fs.readFileSync(recordingPath, "utf8"));
    const players = rec.roster_workbench.teams.flatMap((x) => x.players);
    const diffs = [];
    for (const p of players) {
      const mine = C.parseSpecial(p.special), theirs = CM.parseContractInfo(p.special);
      if ((mine.cl || 0) !== theirs.length) diffs.push(`${p.name} length`);
      if ((mine.tcv || 0) !== theirs.tcv) diffs.push(`${p.name} tcv`);
      if ((mine.gtd || 0) !== theirs.gtd) diffs.push(`${p.name} gtd`);
      Object.keys(mine.y).forEach((k) => { if (mine.y[k] !== theirs.yearVals[k]) diffs.push(`${p.name} Y${k}`); });
    }
    add(`contract parser agrees with cap_math.js (${players.length} recorded players)`, players.length >= 100 && diffs.length === 0, diffs.length ? "differs: " + diffs.slice(0, 5).join(", ") + (diffs.length > 5 ? ` and ${diffs.length - 5} more` : "") : players.length < 100 ? "too few players in the recording" : "");
  } catch (e) { add("contract parser agrees with cap_math.js", false, String(e && e.message || e)); }
  return finish(items);
}
function finish(items) { return { ok: items.every((i) => i.ok), items }; }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const notice = process.argv.includes("--notice");
  const r = checkShared();
  for (const i of r.items) console.log(`${i.ok ? "ok  " : "FAIL"} ${i.name}${i.ok || !i.detail ? "" : "\n       " + i.detail}`);
  if (r.ok) console.log("The beta's shared code matches the classic app's files.");
  else if (notice) {
    for (const i of r.items.filter((x) => !x.ok)) console.log(`::warning title=2027 beta compatibility::${i.name}. ${i.detail}`);
    console.log("Notice only: this does not block the classic app. The beta's build and deploy stop until the change is reviewed and re-pinned.");
  } else { console.error("The beta's shared code no longer matches the classic app's files."); process.exit(1); }
}
