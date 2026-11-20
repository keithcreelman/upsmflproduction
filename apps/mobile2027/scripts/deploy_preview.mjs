#!/usr/bin/env node
// Publishes the built Preview 0 files to the PREVIEW address of the ups-mobile-beta Pages project, and nowhere else.
//
//   node apps/mobile2027/scripts/deploy_preview.mjs <builtDir>             prints the plan, deploys nothing
//   node apps/mobile2027/scripts/deploy_preview.mjs <builtDir> --execute   runs the one wrangler command it printed
//
// The project name and the branch are constants. There is no flag to change either, and the script refuses the
// production branch, any other project, any extra wrangler flag, a built folder that is not the output of build.mjs
// at the commit checked out right now (the file list, every file hash and the aggregate digest are all re-verified,
// never taken from the manifest on trust), and a working tree that is not clean, in a dry run as well as with --execute.
// Every wrangler call carries an explicit --branch (wrangler otherwise takes the git branch name, which is how an
// unintended deployment happens).
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_PATHS, LOCK, MODE, SHARED_DIR, SRC, digestOf, gitState, readLock, scan, scanWriteCode } from "./build.mjs";

export const PROJECT = "ups-mobile-beta";
export const BRANCH = "preview";
export const PRODUCTION_BRANCH = "live";

const MANIFEST_KEYS = ["build", "digest", "files", "mode", "source"];
const ENTRY_KEYS = ["bytes", "path", "sha256"];
const sameKeys = (o, keys) => !!o && typeof o === "object" && !Array.isArray(o) && JSON.stringify(Object.keys(o).sort()) === JSON.stringify(keys);
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// Validates the arguments, the built folder and the repository, and returns the plan. Throws a plain Error on anything unexpected.
// Nothing in the manifest is trusted: the file list must equal the build allowlist, every file is re-hashed, the aggregate
// digest is recomputed with the build's own function, and the manifest's commit must be the commit checked out right now,
// on a clean tree, with every built file byte for byte equal to that commit's source file.
// `ctx` ({ git, srcDir, sharedDir }) is only passed by tests, to stand in for the repository.
export function plan(argv, fsImpl = fs, ctx = {}) {
  const git = ctx.git || gitState, srcDir = ctx.srcDir || SRC, sharedDir = ctx.sharedDir || SHARED_DIR;
  const args = argv.slice();
  const execute = args.includes("--execute");
  const rest = args.filter((a) => a !== "--execute");
  if (rest.length !== 1) throw new Error("Usage: deploy_preview.mjs <builtDir> [--execute]. No other arguments are accepted.");
  const dir = rest[0];
  if (dir.startsWith("-")) throw new Error(`Unexpected flag: ${dir}. No wrangler flags can be passed through.`);
  const manifestPath = path.join(dir, "build-manifest.json");
  if (!fsImpl.existsSync(manifestPath)) throw new Error("That folder has no build-manifest.json. Build it with apps/mobile2027/scripts/build.mjs first.");
  let manifest;
  try { manifest = JSON.parse(fsImpl.readFileSync(manifestPath, "utf8")); } catch (e) { throw new Error("build-manifest.json is not valid JSON."); }
  if (!sameKeys(manifest, MANIFEST_KEYS)) throw new Error(`build-manifest.json must have exactly these fields: ${MANIFEST_KEYS.join(", ")}.`);
  if (manifest.build !== "preview0") throw new Error("The manifest is not a Preview 0 build.");
  if (manifest.mode !== MODE) throw new Error(`The manifest mode is not "${MODE}". This script publishes the Preview build only.`);
  if (!sameKeys(manifest.source, ["commit"]) || !/^[0-9a-f]{40}$/.test(manifest.source.commit)) throw new Error("The manifest does not name a full 40-character source commit.");
  if (typeof manifest.digest !== "string" || !/^[0-9a-f]{64}$/.test(manifest.digest)) throw new Error("The manifest digest is not a SHA-256.");
  if (!Array.isArray(manifest.files) || !manifest.files.every((f) => sameKeys(f, ENTRY_KEYS) && typeof f.path === "string" && typeof f.sha256 === "string" && /^[0-9a-f]{64}$/.test(f.sha256) && Number.isInteger(f.bytes))) {
    throw new Error("The manifest's file list is malformed.");
  }
  // 1. exactly the build allowlist (the app's own files, then the shared modules), once each, in the build's order (no more, no fewer, no alternate set)
  if (JSON.stringify(manifest.files.map((f) => f.path)) !== JSON.stringify(ALL_PATHS)) throw new Error("The manifest's file list is not exactly the build allowlist.");
  // 2. exactly those files on disk, plus the manifest
  const onDisk = [];
  (function walk(d) { for (const e of fsImpl.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else onDisk.push(path.relative(dir, p).split(path.sep).join("/")); } })(dir);
  if (JSON.stringify(onDisk.sort()) !== JSON.stringify(ALL_PATHS.concat(["build-manifest.json"]).sort())) throw new Error("The folder's files do not match its manifest (extra or missing files).");
  // 3. every file's size and hash
  for (const f of manifest.files) {
    const buf = fsImpl.readFileSync(path.join(dir, f.path));
    if (buf.length !== f.bytes) throw new Error(`File size differs from the manifest: ${f.path}`);
    if (sha(buf) !== f.sha256) throw new Error(`File changed since the build: ${f.path}`);
  }
  // 3b. the deploy does not trust that the build ran its checks: it runs them again on the files it is about to publish
  //     (secrets, the write-code scan, the pinned content policy and headers, and the pins of the shared modules)
  const lock = readLock(ctx.lockPath || LOCK);
  if (!lock || !lock.files) throw new Error("shared.lock.json is missing or unreadable.");
  for (const f of manifest.files) {
    const text = fsImpl.readFileSync(path.join(dir, f.path), "utf8");
    const problems = [...scan(f.path, text), ...scanWriteCode(f.path, text)];
    if (problems.length) throw new Error("A built file fails the Preview scan: " + problems.join("; "));
    if (f.path.startsWith("shared/")) {
      const name = f.path.slice("shared/".length);
      if (lock.files[name] !== f.sha256) throw new Error(`A shared module is not the pinned, reviewed one: ${f.path}`);
    }
  }
  // 4. the aggregate digest, recomputed from the verified files
  if (digestOf(manifest.files) !== manifest.digest) throw new Error("The manifest digest does not match its files (recomputed from the verified files).");
  // 5. the commit: clean tree, HEAD is the manifest's commit, and the built bytes are that commit's source
  let state;
  try { state = git(); } catch (e) { throw new Error("Could not read the git state: " + e.message); }
  if (state.dirty) throw new Error("The working tree has uncommitted changes. Commit first so the deploy names a commit.");
  if (state.commit !== manifest.source.commit) throw new Error(`The build came from commit ${manifest.source.commit.slice(0, 8)} but HEAD is ${String(state.commit).slice(0, 8)}. Rebuild at this commit.`);
  for (const f of manifest.files) {
    // a shared module must be the byte-for-byte file in site/shared/ at this commit; everything else is the app's own source
    const src = f.path.startsWith("shared/") ? path.join(sharedDir, f.path.slice("shared/".length)) : path.join(srcDir, f.path);
    if (!fsImpl.existsSync(src) || sha(fsImpl.readFileSync(src)) !== f.sha256) throw new Error(`Built file is not the source at the named commit: ${f.path}`);
  }
  if (BRANCH === PRODUCTION_BRANCH) throw new Error("Refusing: the preview branch equals the production branch.");
  const command = ["wrangler", "pages", "deploy", dir, "--project-name", PROJECT, "--branch", BRANCH, "--commit-dirty=true"];
  return { execute, dir, digest: manifest.digest, commit: manifest.source.commit, files: manifest.files.length, project: PROJECT, branch: BRANCH, command };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const p = plan(process.argv.slice(2));
    console.log(`Plan: publish ${p.files} files from commit ${p.commit} (artifact digest ${p.digest})\n  project ${p.project}, branch ${p.branch} (preview address only; the production branch is "${PRODUCTION_BRANCH}")\n  npx ${p.command.join(" ")}`);
    if (!p.execute) { console.log("Dry run. Nothing was published. Add --execute to publish."); process.exit(0); }
    execFileSync("npx", p.command, { stdio: "inherit" });
  } catch (e) { console.error("Refused: " + e.message); process.exit(1); }
}
