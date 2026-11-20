#!/usr/bin/env node
// Preview build: copies an explicit allowlist of files into an output folder and records what it made.
//
//   node apps/mobile2027/scripts/build.mjs [outDir]       (default: apps/mobile2027/dist, which is not committed)
//   node apps/mobile2027/scripts/build.mjs --write-lock   re-pin the shared modules after reviewing a change to one of them
//   node apps/mobile2027/scripts/build.mjs --dev [outDir]  a LOCAL working copy to open while editing (dirty tree allowed; never deployable)
//
// There is no bundler and nothing is transformed: the bytes that were reviewed are the bytes that are deployed.
// Two sources feed the artifact, both by an explicit list:
//   FILES   files under apps/mobile2027/src/
//   SHARED  files under site/shared/ that the phone app and the Front Office already use, taken BYTE FOR BYTE (one copy of
//           the rule, never a second one). Each is pinned by SHA-256 in shared.lock.json, so a change to a shared file made
//           for the classic app stops this build until someone reviews it and re-pins it on purpose.
// The manifest names every file with its SHA-256, one digest over all of them, the build mode and the git commit the files
// came from, so a deploy can cite exactly what it published and prove it. The build refuses to run if a file is missing, if
// an extra file is in src/, if a shared file no longer matches its pin, if a file looks like it holds a secret or contains
// write code (this is the Preview build: it can read, it cannot write), or if the git working tree has uncommitted changes.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..");
export const SRC = path.join(ROOT, "src");
export const REPO = path.resolve(ROOT, "..", "..");
export const LOCK = path.join(ROOT, "shared.lock.json");

// The one build mode that exists. A Test build (write modules, league 25625) is a later, separately approved stage.
export const MODE = "preview";

export const FILES = [
  "index.html", "styles.css", "team-colors.css", "config.js", "app.js", "_headers",
  "lib/format.js", "lib/contract.js", "lib/model.js", "lib/data.js", "lib/photo.js", "lib/sample.js", "lib/views.js",
];

// Shared modules taken from site/shared/ unchanged: the contract-window rules and the taxi rule, which the next stages need.
// Both are pure (no network, no storage). Two shared modules are NOT here on purpose, and the scan above would refuse them:
//   site/shared/cap_math.js       calls the worker itself and hard-codes league 74598;
//   site/shared/injury_status.js  carries a loader (createLoader) that calls fetch, a second network path. Stage R2 takes its
//                                 pure resolver either by a reviewed exception proven dormant, or as a generated twin.
export const SHARED_DIR = path.join(REPO, "site", "shared");
export const SHARED = ["contract_windows.js", "taxi_rule.js"];
export const sharedOut = (name) => "shared/" + name;
// Every file in the artifact, in the order the digest is computed.
export const ALL_PATHS = FILES.concat(SHARED.map(sharedOut));

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

// ── The Preview write-code scan ─────────────────────────────────────────────────────────────────────────────────────
// The Preview build can read and cannot write. This looks for anything that could send data anywhere or run code from
// somewhere else, in every script and page of the artifact. Comments are ignored (they may talk about writes); strings
// and code are not. `fetch(` is allowed in exactly one file, the loader that only issues bare GETs.
export const FETCH_FILE = "lib/data.js"; // the loader: the only file that calls the network
export const FETCH_MENTION_FILES = [FETCH_FILE, "app.js"]; // app.js only hands the loader the page's fetch function
export const WRITE_PATTERNS = [
  [/\bFormData\b/, "FormData"],
  [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
  [/\bsendBeacon\b/, "sendBeacon"],
  [/\bWebSocket\b/, "WebSocket"],
  [/\bEventSource\b/, "EventSource"],
  [/\bimportScripts\b/, "importScripts"],
  [/\beval\s*\(/, "eval"],
  [/\bnew\s+Function\b/, "new Function"],
  [/["'`](?:POST|PUT|PATCH|DELETE)["'`]/i, "a write verb as a string"],
  [/\bmethod\s*[:=](?!=)(?!\s*["']GET["'])/, "a request method other than a literal GET"],
  [/\bcredentials\s*[:=](?!=)(?!\s*["']omit["'])/, "credentials other than omit"],
];
export function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\"'`])\/\/[^\n]*/g, "$1");
}
export function scanWriteCode(name, text) {
  const hits = [];
  if (/(?:^|\/)[^/]*(?:submit|write|post|put|delete|save)[^/]*$/i.test(name)) hits.push(`${name}: the file name says it writes (a Preview file must not)`);
  if (!/\.(?:js|html)$/.test(name)) return hits;
  const code = name.endsWith(".html") ? stripComments(text.replace(/<!--[\s\S]*?-->/g, "")) : stripComments(text);
  for (const [re, what] of WRITE_PATTERNS) if (re.test(code)) hits.push(`${name}: write code: ${what}`);
  if (!FETCH_MENTION_FILES.includes(name) && /(?:^|[^A-Za-z0-9_$])fetch\b/.test(code)) hits.push(`${name}: network code: a reference to fetch outside ${FETCH_FILE} (a Preview file has one transport)`);
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

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// The pins: the SHA-256 of each shared module as reviewed. `sharedDir` and `lockPath` are only passed by tests.
export function readLock(lockPath = LOCK) {
  try { return JSON.parse(fs.readFileSync(lockPath, "utf8")); } catch (e) { return null; }
}
export function computeLock(sharedDir = SHARED_DIR) {
  const files = {};
  for (const n of SHARED) files[n] = sha(fs.readFileSync(path.join(sharedDir, n)));
  return { note: "SHA-256 of each shared module as reviewed. If a classic-app change touches one, review whether the beta may take it, then run: node apps/mobile2027/scripts/build.mjs --write-lock", from: "site/shared", files };
}

// `srcDir`, `git`, `sharedDir` and `lockPath` are only passed by tests, to prove the build refuses a missing file, an extra
// file, a secret, write code, a changed shared module, a wrong mode and a dirty tree.
// `opts.dev` makes a LOCAL working copy to look at while editing (the page needs the shared files next to it, which a plain
// folder server cannot give). It skips only the clean-tree check, and its manifest carries `dev: true`, which the deploy
// script does not accept: a dev build can be opened on this machine and cannot be deployed.
export function build(outDir, srcDir = SRC, git = gitState, sharedDir = SHARED_DIR, lockPath = LOCK, opts = {}) {
  const problems = [];
  let state = null;
  try { state = git(); } catch (e) { problems.push("could not read the git state, so the build cannot name its source commit: " + e.message); }
  if (state && !/^[0-9a-f]{40}$/.test(state.commit)) problems.push("the source commit is not a full 40-character git commit id");
  if (state && state.dirty && !opts.dev) problems.push("the git working tree has uncommitted changes: commit them first, so the build names the commit it came from");
  const present = listSrc(srcDir);
  for (const f of FILES) if (!present.includes(f)) problems.push(`missing from src/: ${f}`);
  for (const f of present) if (!FILES.includes(f)) problems.push(`not on the allowlist (add it to FILES on purpose, or remove it): ${f}`);
  const files = [];
  for (const f of FILES) {
    if (!present.includes(f)) continue;
    const buf = fs.readFileSync(path.join(srcDir, f));
    const text = buf.toString("utf8");
    problems.push(...scan(f, text), ...scanWriteCode(f, text));
    files.push({ path: f, bytes: buf.length, sha256: sha(buf), buf });
  }
  const lock = readLock(lockPath);
  if (!lock || !lock.files) problems.push("shared.lock.json is missing or unreadable: run build.mjs --write-lock after reviewing the shared modules");
  for (const n of SHARED) {
    const p = path.join(sharedDir, n);
    if (!fs.existsSync(p)) { problems.push(`missing shared module: site/shared/${n}`); continue; }
    const buf = fs.readFileSync(p);
    const text = buf.toString("utf8");
    problems.push(...scan(sharedOut(n), text), ...scanWriteCode(sharedOut(n), text));
    if (lock && lock.files && lock.files[n] !== sha(buf)) problems.push(`shared module changed since it was pinned: site/shared/${n}. Review the change, then run build.mjs --write-lock.`);
    files.push({ path: sharedOut(n), bytes: buf.length, sha256: sha(buf), buf });
  }
  if (lock && lock.files) for (const n of Object.keys(lock.files)) if (!SHARED.includes(n)) problems.push(`shared.lock.json pins a module that is not on the SHARED list: ${n}`);
  // the page's own configuration names the mode; it must be the one mode this build makes
  const cfg = files.find((x) => x.path === "config.js");
  const m = cfg ? /\bmode\s*:\s*"([a-z]+)"/.exec(cfg.buf.toString("utf8")) : null;
  if (!m) problems.push("config.js does not name a build mode");
  else if (m[1] !== MODE) problems.push(`config.js says mode "${m[1]}", but this build only makes "${MODE}"`);
  if (problems.length) return { ok: false, problems };
  const digest = digestOf(files);
  const manifest = { build: "preview0", mode: MODE, source: { commit: state.commit }, digest, files: files.map(({ path: p, bytes, sha256 }) => ({ path: p, bytes, sha256 })) };
  if (opts.dev) manifest.dev = true; // not accepted by deploy_preview.mjs
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
  if (process.argv.includes("--write-lock")) {
    fs.writeFileSync(LOCK, JSON.stringify(computeLock(), null, 2) + "\n");
    console.log("Pinned " + SHARED.length + " shared modules in " + path.relative(process.cwd(), LOCK));
  } else {
    const dev = process.argv.includes("--dev");
    const out = path.resolve(process.argv.slice(2).find((a) => !a.startsWith("--")) || path.join(ROOT, dev ? "dist-dev" : "dist"));
    const r = build(out, SRC, gitState, SHARED_DIR, LOCK, { dev });
    if (!r.ok) { console.error("Build refused:\n  " + r.problems.join("\n  ")); process.exit(1); }
    console.log(`Built ${r.manifest.files.length} files (mode ${r.manifest.mode}) into ${out}\nsource commit ${r.manifest.source.commit}\nartifact digest ${r.digest}`);
  }
}
