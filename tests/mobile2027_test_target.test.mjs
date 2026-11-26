// mobile2027 Test target (Keith 2026-11-26, #1454): the same app and the same scans, pointed at the UPS TEST environment
// (test worker, league 25625, live reads), without the recorded production snapshot. The beta preview deploy refuses it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..", "apps", "mobile2027");
const SRC = path.join(APP, "src");
const FIXSH = path.join(HERE, "fixtures/mobile2027/shared");
const FIXLOCK = path.join(os.tmpdir(), "m27-test-target-lock-" + process.pid + ".json");
const B = await import(pathToFileURL(path.join(APP, "scripts/build.mjs")).href);
const S = await import(pathToFileURL(path.join(APP, "scripts/deploy_preview.mjs")).href);
fs.writeFileSync(FIXLOCK, JSON.stringify(B.computeLock(FIXSH), null, 2));
process.on("exit", () => { try { fs.rmSync(FIXLOCK, { force: true }); } catch (e) { /* ignore */ } });
const COMMIT = "a".repeat(40);
const git = () => ({ commit: COMMIT, dirty: false });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "m27-tt-"));
const bld = (out, opts, src = SRC) => B.build(out, src, git, FIXSH, FIXLOCK, opts);

test("test target: test worker, league 25625, live data, mode test; content policy names only the test worker; no recorded snapshot", () => {
  const out = tmp();
  const r = bld(out, { target: "test" });
  t.ok(r.ok, JSON.stringify(r.problems));
  t.equal(r.manifest.mode, "test"); t.equal(r.manifest.build, "test");
  const cfg = fs.readFileSync(path.join(out, "config.js"), "utf8");
  t.match(cfg, /\n  workerBase: "https:\/\/ups-test\.keith-creelman\.workers\.dev",/);
  t.match(cfg, /\n  leagueId: "25625",/); t.match(cfg, /\n  data: "live",/); t.match(cfg, /\n  mode: "test"/);
  const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
  t.ok(html.includes('content="' + B.TEST_CSP + '"'), "the reviewed policy with the test worker as the only connect-src");
  t.match(B.TEST_CSP, /connect-src https:\/\/ups-test\.keith-creelman\.workers\.dev;/);
  t.doesNotMatch(html, /recorded_data/); t.ok(!fs.existsSync(path.join(out, "recorded_data.js")), "the production snapshot is not published");
  t.match(html, /<title>UPS TEST · UPS 2027<\/title>/);
  const all = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else all.push(p); } })(out);
  for (const p of all) t.ok(!/74598|upsmflproduction\.keith-creelman/.test(fs.readFileSync(p, "utf8")), path.relative(out, p) + ": names no production league or worker");
  fs.rmSync(out, { recursive: true, force: true });
});

test("test target: the Preview build is unchanged; the beta preview deploy refuses a test build", () => {
  const pv = tmp(), tt = tmp();
  const p = bld(pv, {}), q = bld(tt, { target: "test" });
  t.ok(p.ok && q.ok);
  t.equal(p.manifest.mode, "preview");
  t.match(fs.readFileSync(path.join(pv, "config.js"), "utf8"), /leagueId: "74598"/, "the Preview build still reads the real league (recorded)");
  t.ok(fs.existsSync(path.join(pv, "recorded_data.js")));
  t.throws(() => S.plan([tt], fs, { git, sharedDir: FIXSH, lockPath: FIXLOCK }), /not a Preview 0 build|mode is not/, "deploy_preview.mjs refuses the test build");
  fs.rmSync(pv, { recursive: true, force: true }); fs.rmSync(tt, { recursive: true, force: true });
});

test("test target: an edit that doesn't match exactly once, or an unknown target, refuses the build", () => {
  const src = tmp();
  (function copy(a, b) { fs.mkdirSync(b, { recursive: true }); for (const e of fs.readdirSync(a, { withFileTypes: true })) { const x = path.join(a, e.name), y = path.join(b, e.name); if (e.isDirectory()) copy(x, y); else fs.copyFileSync(x, y); } })(SRC, src);
  const cfg = path.join(src, "config.js");
  fs.writeFileSync(cfg, fs.readFileSync(cfg, "utf8").replace('leagueId: "74598"', 'leagueId: "12345"'));
  const r = bld(tmp(), { target: "test" }, src);
  t.ok(!r.ok); t.ok(r.problems.some((x) => /test edit expected exactly one "leagueId: "74598""/.test(x)), JSON.stringify(r.problems));
  const u = bld(tmp(), { target: "prod" });
  t.ok(!u.ok); t.ok(u.problems.some((x) => /unknown build target/.test(x)));
  fs.rmSync(src, { recursive: true, force: true });
});

await run("mobile2027_test_target");
