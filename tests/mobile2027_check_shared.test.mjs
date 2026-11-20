// UPS 2027 beta: the check of its shared code against the classic app's files (apps/mobile2027/scripts/check_shared.mjs).
//   node tests/mobile2027_check_shared.test.mjs
//
// Offline. What is proven: the check passes on reviewed copies, and each kind of drift (a changed module, a missing module,
// new network code, a stale or extra pin, a parser that no longer agrees with the cap math) is reported; and the beta's tests
// in this suite never read the live files in site/shared/, so a change made for the classic app cannot turn a classic pull
// request red (the check is where that change shows up, as a notice, and the beta's build and deploy refuse a stale pin).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const APP = path.join(ROOT, "apps", "mobile2027");
const FIXSH = path.join(HERE, "fixtures/mobile2027/shared");
const B = await import(pathToFileURL(path.join(APP, "scripts/build.mjs")).href);
const K = await import(pathToFileURL(path.join(APP, "scripts/check_shared.mjs")).href);

function sandboxCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m27cs-"));
  const shared = path.join(dir, "shared"); fs.cpSync(FIXSH, shared, { recursive: true });
  const lockPath = path.join(dir, "lock.json"); fs.writeFileSync(lockPath, JSON.stringify(B.computeLock(shared), null, 2));
  return { dir, shared, lockPath, opts: { sharedDir: shared, lockPath, capMath: path.join(shared, "cap_math.js") } };
}
const failing = (r) => r.items.filter((i) => !i.ok).map((i) => i.name + " " + i.detail).join(" | ");

test("the check passes on reviewed copies, and reports each kind of drift by name", () => {
  const c = sandboxCopy();
  const ok = K.checkShared(c.opts); t.equal(ok.ok, true, failing(ok)); t.ok(ok.items.length >= 9, "every module is checked for pin, scan, load and no request, plus the parser");
  // a module changed for the classic app: the pin no longer matches
  fs.appendFileSync(path.join(c.shared, "taxi_rule.js"), "\n// changed for the classic app\n");
  const a = K.checkShared(c.opts); t.equal(a.ok, false); t.match(failing(a), /taxi_rule\.js: bytes equal the pin[^|]*Review whether the beta may take the change/);
  t.equal(a.items.filter((i) => !i.ok).length, 1, "only the pin is reported; the changed comment is still clean and loads");
  // a module that gained network code
  fs.writeFileSync(path.join(c.shared, "taxi_rule.js"), fs.readFileSync(path.join(FIXSH, "taxi_rule.js"), "utf8") + "\nfetch('/x');\n");
  const b = K.checkShared(c.opts); t.equal(b.ok, false); t.match(failing(b), /taxi_rule\.js: still free of write and network code[^|]*reference to fetch/); t.match(failing(b), /makes no request while loading/);
  // the derived injury copy: a changed classic source, and an extraction that no longer applies, are each reported by name
  const c2 = sandboxCopy(); fs.appendFileSync(path.join(c2.shared, "injury_status.js"), "\n// changed for the classic app\n");
  const d1 = K.checkShared(c2.opts); t.equal(d1.ok, false); t.match(failing(d1), /injury_status\.js: bytes equal the pin[^|]*the beta derives injury_status\.pure\.js from it/);
  fs.writeFileSync(path.join(c2.shared, "injury_status.js"), fs.readFileSync(path.join(FIXSH, "injury_status.js"), "utf8").replace("  // A small loader for a page that has no status loader of its own", "  // A loader"));
  const d2 = K.checkShared(c2.opts); t.match(failing(d2), /injury_status\.pure\.js: the extraction still applies[^|]*opening comment was not found exactly once/);
  fs.writeFileSync(path.join(c2.shared, "injury_status.js"), fs.readFileSync(path.join(FIXSH, "injury_status.js"), "utf8").replace('Doubtful: "d"', 'Doubtful: "q"'));
  const d3 = K.checkShared(c2.opts); t.match(failing(d3), /injury_status\.js: bytes equal the pin/);
  fs.rmSync(c2.dir, { recursive: true, force: true });
  // a module that is gone
  fs.rmSync(path.join(c.shared, "contract_windows.js"));
  const g = K.checkShared(c.opts); t.equal(g.ok, false); t.match(failing(g), /contract_windows\.js: present/);
  fs.rmSync(c.dir, { recursive: true, force: true });
});

test("a missing lock, an extra pin and a parser that disagrees with the cap math are each reported", () => {
  const c = sandboxCopy();
  t.equal(K.checkShared({ ...c.opts, lockPath: path.join(c.dir, "nope.json") }).ok, false);
  const lock = JSON.parse(fs.readFileSync(c.lockPath, "utf8")); lock.files["injury_status.js"] = "0".repeat(64); fs.writeFileSync(c.lockPath, JSON.stringify(lock));
  t.match(failing(K.checkShared(c.opts)), /pin for injury_status\.js[^|]*not on the SHARED list/);
  // a cap math that reads contracts differently
  const lock2 = B.computeLock(c.shared); fs.writeFileSync(c.lockPath, JSON.stringify(lock2));
  const skewed = path.join(c.dir, "cap_math_skewed.js");
  fs.writeFileSync(skewed, fs.readFileSync(path.join(FIXSH, "cap_math.js"), "utf8") + "\n;(function(){var o=UPS_CAP_MATH.parseContractInfo;UPS_CAP_MATH.parseContractInfo=function(s){var r=o(s);r.tcv=(r.tcv||0)+1;return r;};})();\n");
  const r = K.checkShared({ ...c.opts, capMath: skewed });
  t.equal(r.ok, false, failing(r)); t.match(failing(r), /contract parser agrees with cap_math\.js[^|]*differs/);
  // too few recorded players is a failure, not a pass
  const tiny = path.join(c.dir, "tiny.json"); fs.writeFileSync(tiny, JSON.stringify({ roster_workbench: { teams: [{ players: [] }] } }));
  t.match(failing(K.checkShared({ ...c.opts, recording: tiny })), /too few players/);
  fs.rmSync(c.dir, { recursive: true, force: true });
});

test("the beta's tests in the suite do not read the live classic files, so a classic change cannot turn a classic PR red", () => {
  const files = fs.readdirSync(HERE).filter((f) => /^mobile2027_.*\.test\.mjs$/.test(f) && f !== "mobile2027_check_shared.test.mjs");
  t.ok(files.length >= 2, "found the beta's test files");
  for (const f of files) {
    const src = fs.readFileSync(path.join(HERE, f), "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    t.doesNotMatch(src, /path\.join\([^)]*["']site(?:\/shared)?["']|SHARED_DIR\b/, f + " builds a path into site/shared/ or uses the live shared directory");
  }
  // the build and the deploy still refuse a stale pin on their own (proved in mobile2027_preview0), so nothing stale can be published
  t.ok(fs.existsSync(path.join(APP, "scripts/check_shared.mjs")));
});

await run("mobile2027_check_shared");
