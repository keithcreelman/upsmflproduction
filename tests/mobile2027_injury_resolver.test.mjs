// UPS 2027 beta, stage R2: the derived copy of the classic injury resolver.
//   node tests/mobile2027_injury_resolver.test.mjs
//
// Offline. The classic file mixes about 200 lines of pure rules with a small loader that calls fetch. The Preview build may not contain a
// fetch reference and the classic file may not change for the beta, so the build derives its copy by cutting out exactly two spans. What is
// proven here, on the REVIEWED COPY of the classic file in tests/fixtures/mobile2027/shared/ (the suite never reads site/shared/):
//   - the derived text is the original minus exactly those two spans (nothing added, nothing else removed) and has no fetch or loader;
//   - the original and the derived file give identical answers over ~40,000 generated cases;
//   - the build and the deploy script refuse each way the pins or the extraction can go wrong.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..", "apps", "mobile2027");
const SRC = path.join(APP, "src");
const FIXSH = path.join(HERE, "fixtures/mobile2027/shared");
const B = await import(pathToFileURL(path.join(APP, "scripts/build.mjs")).href);
const EQ = await import(pathToFileURL(path.join(APP, "scripts/injury_equivalence.mjs")).href);
const S = await import(pathToFileURL(path.join(APP, "scripts/deploy_preview.mjs")).href);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const ORIGINAL = fs.readFileSync(path.join(FIXSH, "injury_status.js"), "utf8");
const D = B.DERIVED[0];
const COMMIT = "a".repeat(40);
const G = (commit = COMMIT, dirty = false) => () => ({ commit, dirty });

// a throwaway copy of the shared folder and a lock for it
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m27ir-"));
  const shared = path.join(dir, "shared"); fs.cpSync(FIXSH, shared, { recursive: true });
  const lockPath = path.join(dir, "lock.json"); fs.writeFileSync(lockPath, JSON.stringify(B.computeLock(shared), null, 2));
  const lock = () => JSON.parse(fs.readFileSync(lockPath, "utf8"));
  const save = (l) => fs.writeFileSync(lockPath, JSON.stringify(l, null, 2));
  const build = () => { const out = path.join(dir, "out"); const r = B.build(out, SRC, G(), shared, lockPath); return { r, out }; };
  return { dir, shared, lockPath, lock, save, build };
}

test("the derived copy is the original minus exactly the loader and its export entry, and contains no network code", () => {
  const r = D.derive(ORIGINAL); t.equal(r.ok, true);
  const d = r.text;
  t.ok(d.length < ORIGINAL.length && ORIGINAL.length - d.length > 600 && ORIGINAL.length - d.length < 1400, "about 1 KB shorter: " + (ORIGINAL.length - d.length));
  t.doesNotMatch(d, /createLoader|\bfetch\b\s*\(|root\.fetch|fetchImpl/, "no loader, no fetch call");
  t.deepEqual(B.scanWriteCode("shared/injury_status.pure.js", d), [], "the Preview scan passes it (the only 'fetch' left is the word in a comment)");
  t.deepEqual(B.scan("shared/injury_status.pure.js", d), []);
  // rebuild the original from the derived text plus the two cut spans: nothing else changed
  const a = ORIGINAL.indexOf("  // A small loader for a page that has no status loader of its own"), b = ORIGINAL.indexOf("    return { load: load, read: function () { return st; } };\n  }\n\n") + "    return { load: load, read: function () { return st; } };\n  }\n\n".length;
  const cutLoader = ORIGINAL.slice(a, b), expo = "createLoader: createLoader, ";
  const joined = d.slice(0, a) + cutLoader + d.slice(a);
  t.equal(joined.replace("fromMflStore: fromMflStore,\n    fresh: fresh };", "fromMflStore: fromMflStore,\n    " + expo + "fresh: fresh };"), ORIGINAL, "derived + the two spans = the original, byte for byte");
  t.match(cutLoader, /function createLoader\(url, fetchImpl\)/); t.match(cutLoader, /root\.fetch/);
  // the derived file still attaches the same global and exports everything but the loader
  const A = EQ.loadResolver(ORIGINAL, "o"), Bz = EQ.loadResolver(d, "d");
  t.deepEqual(Object.keys(Bz).sort(), Object.keys(A).filter((k) => k !== "createLoader").sort());
});

test("the original and the derived resolver give identical answers over a generated matrix (every designation, feed state, team spelling, freshness and fallback)", () => {
  const r = EQ.compareResolvers(ORIGINAL, D.derive(ORIGINAL).text);
  t.ok(r.cases > 30000, "cases: " + r.cases);
  t.deepEqual(r.diffs.slice(0, 5), [], "no difference (" + r.diffs.length + ")");
  // the comparison can fail: a derived copy with one rule changed is caught
  const broken = D.derive(ORIGINAL).text.replace('Doubtful: "d"', 'Doubtful: "q"');
  t.ok(broken !== D.derive(ORIGINAL).text); t.ok(EQ.compareResolvers(ORIGINAL, broken).diffs.length > 0, "a changed rule is reported");
  const loose = D.derive(ORIGINAL).text.replace('var TTL = 5 * 60 * 1000;', 'var TTL = 6 * 60 * 1000;'); t.ok(EQ.compareResolvers(ORIGINAL, loose).diffs.length > 0, "a changed freshness limit is reported");
});

test("the extraction refuses a source that does not have the loader exactly once, in order", () => {
  const miss = (text, re) => { const r = D.derive(text); t.equal(r.ok, false); t.match(r.why, re); };
  miss(ORIGINAL.replace("  // A small loader for a page that has no status loader of its own", "  // A loader"), /opening comment was not found exactly once/);
  miss(ORIGINAL.replace("    return { load: load, read: function () { return st; } };\n  }\n\n", "    return { load: load };\n  }\n\n"), /closing lines were not found exactly once/);
  miss(ORIGINAL.replace("createLoader: createLoader, ", ""), /export entry was not found exactly once/);
  miss(ORIGINAL + "\n// createLoader: createLoader, \n", /export entry was not found exactly once/);
  miss(ORIGINAL + "\n  // A small loader for a page that has no status loader of its own (desktop Game Day).\n", /opening comment was not found exactly once/);
  const swapped = ORIGINAL.replace("createLoader: createLoader, ", "").replace("  // A small loader for a page that has no status loader of its own (desktop Game Day).\n", "createLoader: createLoader, \n  // A small loader for a page that has no status loader of its own (desktop Game Day).\n");
  miss(swapped, /not in the expected order/);
  t.equal(B.derivedBytes(D, path.join(os.tmpdir(), "no-such-dir")), null, "a missing source gives nothing");
});

test("the build refuses each way the pins or the extraction can go wrong, and writes nothing", () => {
  const ok = sandbox(); const good = ok.build();
  t.equal(good.r.ok, true, JSON.stringify(good.r.problems)); t.ok(good.r.manifest.files.some((f) => f.path === "shared/injury_status.pure.js"));
  const built = fs.readFileSync(path.join(good.out, "shared/injury_status.pure.js"), "utf8"); t.equal(built, D.derive(ORIGINAL).text, "the artifact holds the derived text");
  t.equal(good.r.manifest.files.find((f) => f.path === "shared/injury_status.pure.js").sha256, ok.lock().derived["injury_status.js"].output, "and its hash is the pinned output hash");
  fs.rmSync(ok.dir, { recursive: true, force: true });
  const refused = (label, mutate, re) => { const x = sandbox(); mutate(x); const { r, out } = x.build(); t.equal(r.ok, false, label); t.match((r.problems || []).join(" | "), re, label); t.equal(fs.existsSync(out), false, label + ": nothing written"); fs.rmSync(x.dir, { recursive: true, force: true }); };
  refused("the classic source changed", (x) => fs.appendFileSync(path.join(x.shared, "injury_status.js"), "\n// changed for the classic app\n"), /shared module changed since it was pinned: site\/shared\/injury_status\.js \(the beta derives injury_status\.pure\.js from it\)/);
  refused("the extraction no longer matches its pin", (x) => { const l = x.lock(); l.derived["injury_status.js"].output = "0".repeat(64); x.save(l); }, /does not match its pin \(the extraction changed\)/);
  refused("no pin for the derived copy", (x) => { const l = x.lock(); delete l.derived; x.save(l); }, /no pin for the derived copy of injury_status\.js/);
  refused("a pin for something that is not derived", (x) => { const l = x.lock(); l.derived["cap_math.js"] = { source: "1".repeat(64), output: "2".repeat(64) }; x.save(l); }, /pins a derived copy that is not on the DERIVED list: cap_math\.js/);
  refused("the loader anchor moved (source re-pinned, extraction cannot run)", (x) => { const f = path.join(x.shared, "injury_status.js"); fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("  // A small loader for a page that has no status loader of its own", "  // A loader")); const l = x.lock(); l.derived["injury_status.js"].source = sha(fs.readFileSync(f)); x.save(l); }, /cannot derive injury_status\.pure\.js .*opening comment was not found exactly once/);
  refused("the classic source is missing", (x) => fs.rmSync(path.join(x.shared, "injury_status.js")), /missing shared module: site\/shared\/injury_status\.js/);
});

test("the deploy script re-checks the derived copy: its pin, its extraction at this commit, and the scan", () => {
  const x = sandbox(); const { r, out } = x.build(); t.equal(r.ok, true);
  const ctx = { git: G(), srcDir: SRC, sharedDir: x.shared, lockPath: x.lockPath };
  t.equal(S.plan([out], fs, ctx).digest, r.digest, "an untouched build passes");
  const mf = () => JSON.parse(fs.readFileSync(path.join(out, "build-manifest.json"), "utf8"));
  const save = (m) => { m.digest = B.digestOf(m.files); fs.writeFileSync(path.join(out, "build-manifest.json"), JSON.stringify(m, null, 2) + "\n"); };
  const orig = fs.readFileSync(path.join(out, "shared/injury_status.pure.js"));
  const rewrite = (buf) => { fs.writeFileSync(path.join(out, "shared/injury_status.pure.js"), buf); const m = mf(); const e = m.files.find((f) => f.path === "shared/injury_status.pure.js"); e.bytes = buf.length; e.sha256 = sha(buf); save(m); };
  // a derived file edited after the build, with the manifest rewritten to match: it is not the pinned one
  rewrite(Buffer.concat([orig, Buffer.from("\n// edited\n")]));
  t.throws(() => S.plan([out], fs, ctx), /A derived copy is not the pinned, reviewed one: shared\/injury_status\.pure\.js/);
  // a derived file with a fetch in it fails the scan before anything else
  rewrite(Buffer.concat([orig, Buffer.from("\nfetch('/x');\n")]));
  t.throws(() => S.plan([out], fs, ctx), /A built file fails the Preview scan: .*reference to fetch/);
  // a build whose lock was edited to match a tampered file still has to match what the extraction makes at this commit
  const tampered = Buffer.concat([orig, Buffer.from("\n// edited\n")]); rewrite(tampered);
  const l = x.lock(); l.derived["injury_status.js"].output = sha(tampered); x.save(l);
  t.throws(() => S.plan([out], fs, ctx), /not what the extraction makes at the named commit/);
  fs.rmSync(x.dir, { recursive: true, force: true });
});

await run("mobile2027_injury_resolver");
