#!/usr/bin/env node
// Preview 0 build: copies an explicit allowlist of files from src/ into an output folder and records what it made.
//
//   node apps/mobile2027/scripts/build.mjs [outDir]       (default: apps/mobile2027/dist, which is not committed)
//
// There is no bundler and nothing is transformed: the bytes that were reviewed are the bytes that are deployed.
// The manifest names every file with its SHA-256, one digest over all of them, and the git commit the files came from,
// so a deploy can cite exactly what it published and prove it. The build refuses to run if a file is missing, if an
// extra file is in src/, if a file looks like it holds a secret, or if the git working tree has uncommitted changes.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..");
export const SRC = path.join(ROOT, "src");

export const FILES = [
  "index.html", "styles.css", "team-colors.css", "config.js", "app.js", "_headers",
  "lib/format.js", "lib/contract.js", "lib/model.js", "lib/data.js", "lib/photo.js", "lib/views.js",
];

// Text that must never be in a published file. The page holds no credential, so any of these is a mistake.
export const SECRET_PATTERNS = [
  [/mfl_user_id\s*[=:]/i, "an MFL session id assignment"],
  [/apikey\s*[=:]/i, "an API key assignment"],
  [/bearer\s+[a-z0-9._~+\/-]{12,}/i, "a bearer token"],
  [/ups_b[sh]_[A-Za-z0-9_-]{8,}/, "a beta session or handoff credential"],
  [/\b[0-9a-f]{40,}\b/i, "a long hex secret"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, "an email address"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
];

export function scan(name, text) {
  const hits = [];
  for (const [re, what] of SECRET_PATTERNS) if (re.test(text)) hits.push(`${name}: looks like ${what}`);
  return hits;
}

// The one canonical artifact digest: SHA-256 over "<path>\n<sha256>\n" for each file in allowlist order.
// build.mjs writes it and deploy_preview.mjs recomputes it from the verified files; both must use this function.
export function digestOf(entries) {
  return crypto.createHash("sha256").update(entries.map((x) => `${x.path}\n${x.sha256}\n`).join("")).digest("hex");
}

// What the repository says right now: the commit at HEAD and whether anything is uncommitted (tracked changes or untracked files).
// `cwd` is only passed by tests, to try it on a throwaway repository.
export function gitState(cwd = ROOT) {
  const env = { ...process.env }; delete env.GIT_DIR; delete env.GIT_WORK_TREE; delete env.GIT_INDEX_FILE;
  const run = (args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { commit: run(["rev-parse", "HEAD"]).trim(), dirty: run(["status", "--porcelain"]).trim() !== "" };
}

function listSrc(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listSrc(p, base));
    else out.push(path.relative(base, p).split(path.sep).join("/"));
  }
  return out.sort();
}

// `srcDir` and `git` are only passed by tests, to prove the build refuses a missing file, an extra file, a secret and a dirty tree.
export function build(outDir, srcDir = SRC, git = gitState) {
  const problems = [];
  let state = null;
  try { state = git(); } catch (e) { problems.push("could not read the git state, so the build cannot name its source commit: " + e.message); }
  if (state && !/^[0-9a-f]{40}$/.test(state.commit)) problems.push("the source commit is not a full 40-character git commit id");
  if (state && state.dirty) problems.push("the git working tree has uncommitted changes: commit them first, so the build names the commit it came from");
  const present = listSrc(srcDir);
  for (const f of FILES) if (!present.includes(f)) problems.push(`missing from src/: ${f}`);
  for (const f of present) if (!FILES.includes(f)) problems.push(`not on the allowlist (add it to FILES on purpose, or remove it): ${f}`);
  const files = [];
  for (const f of FILES) {
    if (!present.includes(f)) continue;
    const buf = fs.readFileSync(path.join(srcDir, f));
    problems.push(...scan(f, buf.toString("utf8")));
    files.push({ path: f, bytes: buf.length, sha256: crypto.createHash("sha256").update(buf).digest("hex"), buf });
  }
  if (problems.length) return { ok: false, problems };
  const digest = digestOf(files);
  const manifest = { build: "preview0", source: { commit: state.commit }, digest, files: files.map(({ path: p, bytes, sha256 }) => ({ path: p, bytes, sha256 })) };
  fs.rmSync(outDir, { recursive: true, force: true });
  for (const x of files) {
    const dest = path.join(outDir, x.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, x.buf);
  }
  fs.writeFileSync(path.join(outDir, "build-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { ok: true, digest, manifest, outDir };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.resolve(process.argv[2] || path.join(ROOT, "dist"));
  const r = build(out);
  if (!r.ok) { console.error("Build refused:\n  " + r.problems.join("\n  ")); process.exit(1); }
  console.log(`Built ${r.manifest.files.length} files into ${out}\nsource commit ${r.manifest.source.commit}\nartifact digest ${r.digest}`);
}
