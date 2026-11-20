#!/usr/bin/env node
// Publishes the built Preview 0 files to the PREVIEW address of the ups-mobile-beta Pages project, and nowhere else.
//
//   node apps/mobile2027/scripts/deploy_preview.mjs <builtDir>             prints the plan, deploys nothing
//   node apps/mobile2027/scripts/deploy_preview.mjs <builtDir> --execute   runs the one wrangler command it printed
//
// The project name and the branch are constants. There is no flag to change either, and the script refuses the
// production branch, any other project, any extra wrangler flag, a built folder that is not the output of build.mjs,
// and a working tree that is not clean. Every wrangler call carries an explicit --branch (wrangler otherwise takes the
// git branch name, which is how an unintended deployment happens).
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT = "ups-mobile-beta";
export const BRANCH = "preview";
export const PRODUCTION_BRANCH = "live";

// Pure: validates arguments and the built folder, returns the plan. Throws a plain Error on anything unexpected.
export function plan(argv, fsImpl = fs) {
  const args = argv.slice();
  const execute = args.includes("--execute");
  const rest = args.filter((a) => a !== "--execute");
  if (rest.length !== 1) throw new Error("Usage: deploy_preview.mjs <builtDir> [--execute]. No other arguments are accepted.");
  const dir = rest[0];
  if (dir.startsWith("-")) throw new Error(`Unexpected flag: ${dir}. No wrangler flags can be passed through.`);
  const manifestPath = path.join(dir, "build-manifest.json");
  if (!fsImpl.existsSync(manifestPath)) throw new Error("That folder has no build-manifest.json. Build it with apps/mobile2027/scripts/build.mjs first.");
  const manifest = JSON.parse(fsImpl.readFileSync(manifestPath, "utf8"));
  const names = manifest.files.map((f) => f.path).sort();
  const onDisk = [];
  (function walk(d) { for (const e of fsImpl.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else onDisk.push(path.relative(dir, p).split(path.sep).join("/")); } })(dir);
  const expected = names.concat(["build-manifest.json"]).sort();
  if (JSON.stringify(onDisk.sort()) !== JSON.stringify(expected)) throw new Error("The folder's files do not match its manifest (extra or missing files).");
  for (const f of manifest.files) {
    const sha = crypto.createHash("sha256").update(fsImpl.readFileSync(path.join(dir, f.path))).digest("hex");
    if (sha !== f.sha256) throw new Error(`File changed since the build: ${f.path}`);
  }
  if (BRANCH === PRODUCTION_BRANCH) throw new Error("Refusing: the preview branch equals the production branch.");
  const command = ["wrangler", "pages", "deploy", dir, "--project-name", PROJECT, "--branch", BRANCH, "--commit-dirty=true"];
  return { execute, dir, digest: manifest.digest, files: manifest.files.length, project: PROJECT, branch: BRANCH, command };
}

function gitClean() {
  const out = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" });
  return out.trim() === "";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const p = plan(process.argv.slice(2));
    console.log(`Plan: publish ${p.files} files (artifact digest ${p.digest})\n  project ${p.project}, branch ${p.branch} (preview address only; the production branch is "${PRODUCTION_BRANCH}")\n  npx ${p.command.join(" ")}`);
    if (!p.execute) { console.log("Dry run. Nothing was published. Add --execute to publish."); process.exit(0); }
    if (!gitClean()) throw new Error("The working tree has uncommitted changes. Commit first so the deploy names a commit.");
    execFileSync("npx", p.command, { stdio: "inherit" });
  } catch (e) { console.error("Refused: " + e.message); process.exit(1); }
}
