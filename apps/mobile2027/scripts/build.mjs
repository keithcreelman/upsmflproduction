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
  "lib/format.js", "lib/contract.js", "lib/adjust.js", "lib/model.js", "lib/roster.js", "lib/data.js", "lib/photo.js", "lib/sample.js", "lib/clubhist.js", "lib/ranks.js", "lib/complete.js", "lib/tabviews.js", "lib/views.js",
];

// Shared modules taken from site/shared/ unchanged: the contract-window rules and the taxi rule, which the next stages need.
// Both are pure (no network, no storage). Two shared modules are NOT here on purpose, and the scan above would refuse them:
//   site/shared/cap_math.js       calls the worker itself and hard-codes league 74598;
//   site/shared/injury_status.js  carries a loader (createLoader) that calls fetch, a second network path. It is taken as a DERIVED
//                                 copy instead (below): the same file with exactly that loader cut out.
export const SHARED_DIR = path.join(REPO, "site", "shared");
export const SHARED = ["contract_windows.js", "taxi_rule.js"];
export const sharedOut = (name) => "shared/" + name;

// DERIVED copies (stage R2). The injury resolver is one classic file that mixes ~200 lines of pure rules with a small loader that calls
// fetch. The Preview build may not contain a fetch reference, and the classic file may not change for the beta, so the build derives
// the beta's copy by cutting out exactly two spans: the createLoader function and its entry in the export list. Nothing else is
// touched. The lock pins BOTH hashes (the classic source and the derived result); the build and the deploy refuse a source that no
// longer matches its pin, an anchor that is not found exactly once, or a result that differs from its pin. tests/ run the original and
// the derived file side by side and require identical answers.
const LOADER_START = "  // A small loader for a page that has no status loader of its own (desktop Game Day).\n";
const LOADER_END = "    return { load: load, read: function () { return st; } };\n  }\n\n";
const LOADER_EXPORT = "createLoader: createLoader, ";
function findOnce(text, piece) { const i = text.indexOf(piece); return i >= 0 && text.indexOf(piece, i + 1) < 0 ? i : -1; }
export function deriveInjuryPure(text) {
  const a = findOnce(text, LOADER_START), b = findOnce(text, LOADER_END), c = findOnce(text, LOADER_EXPORT);
  if (a < 0) return { ok: false, why: "the loader's opening comment was not found exactly once" };
  if (b < 0) return { ok: false, why: "the loader's closing lines were not found exactly once" };
  if (c < 0) return { ok: false, why: "the loader's export entry was not found exactly once" };
  if (!(a < b && b < c)) return { ok: false, why: "the loader and its export entry are not in the expected order" };
  const out = text.slice(0, a) + text.slice(b + LOADER_END.length, c) + text.slice(c + LOADER_EXPORT.length);
  return { ok: true, text: out };
}
export const DERIVED = [{ name: "injury_status.js", out: "injury_status.pure.js", derive: deriveInjuryPure }];
export const derivedOut = (d) => "shared/" + d.out;
// The derived bytes for one entry, from the classic source in `sharedDir` (null if the source is missing or does not derive).
export function derivedBytes(d, sharedDir = SHARED_DIR) {
  const p = path.join(sharedDir, d.name);
  if (!fs.existsSync(p)) return null;
  const r = d.derive(fs.readFileSync(p, "utf8"));
  return r.ok ? Buffer.from(r.text, "utf8") : null;
}
// Every file in the artifact, in the order the digest is computed.
export const ALL_PATHS = FILES.concat(SHARED.map(sharedOut), DERIVED.map(derivedOut));

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

// ── The Preview scan ────────────────────────────────────────────────────────────────────────────────────────────────
// The Preview build can read and cannot write. Four layers keep it that way, and this scan is only the first:
//   1. this scan: a LINT against accidents and the obvious. It cannot prove arbitrary JavaScript harmless, and does not claim to;
//   2. the loader's own allowlist: lib/data.js refuses any address, method or query outside six GET routes before the network;
//   3. the page's content policy and the response headers, both pinned below (connect-src names the worker only);
//   4. tests that run the real app against a fake fetch and count every request, including while Sample mode is on.
// The scan refuses what it recognizes: network and write APIs, a method other than a literal GET, credentials other than
// omit, computed access to the global object, dynamic code, loading properties set from script, and any `fetch` except the one
// sanctioned line in app.js (which hands the loader a guarded fetch). Comments are ignored by a small tokenizer that keeps
// strings, so a "//" or "/*" inside a string cannot hide code. Template literals are not allowed in Preview scripts: they
// would need a full parser to read safely.
export const SANCTIONED_FETCH = { "app.js": "window.fetch(url, opts)" };
export const SRC_ASSIGN_FILES = ["lib/photo.js"]; // images are loaded by assigning src; the content policy limits which hosts
export const WRITE_PATTERNS = [
  [/\bFormData\b/, "FormData"],
  [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
  [/\bsendBeacon\b/, "sendBeacon"],
  [/\bWebSocket\b/, "WebSocket"],
  [/\bEventSource\b/, "EventSource"],
  [/\bimportScripts\b/, "importScripts"],
  [/\beval\b/, "eval"],
  [/(?<![.\w$])Function\s*\(/, "the Function constructor"],
  [/\bnew\s+Function\b/, "new Function"],
  [/\bimport\s*\(/, "dynamic import"],
  [/\bnew\s+(?:Image|Worker|SharedWorker|Request|Audio)\b/, "an object that can load or send"],
  [/\b(?:window|self|globalThis|top|parent|frames)\s*\[/, "computed access to the global object"],
  [/\bnavigator\s*\./, "navigator"],
  [/\blocation\s*=(?!=)|\blocation\s*\.\s*(?:href|hash|pathname|search|protocol|host|hostname|port)\s*=(?!=)|\blocation\s*\.\s*(?:assign|replace|reload)\b/, "navigating or rewriting the address from script"],
  [/\bwindow\s*\.\s*open\b/, "window.open"],
  [/\bpostMessage\b/, "postMessage"],
  [/\bBroadcastChannel\b/, "BroadcastChannel"],
  [/\bserviceWorker\b/, "serviceWorker"],
  [/\bdocument\s*\.\s*(?:write|writeln|createElement|createElementNS|cookie|domain)\b/, "document write, create or cookie"],
  [/\.\s*setAttribute\s*\(\s*["'](?:src|href|action|formaction|ping|srcset|data)["']/i, "setting a loading attribute"],
  [/\\u00[4-7][0-9a-fA-F]|\\x[4-7][0-9a-fA-F]/, "an escaped ASCII letter (it can hide a name)"],
  [/`/, "a template literal (not allowed in Preview scripts)"],
  [/["'](?:POST|PUT|PATCH|DELETE)["']/i, "a write verb as a string"],
  [/\bmethod\s*[:=](?!=)(?!\s*["']GET["'])/, "a request method other than a literal GET"],
  [/\bcredentials\s*[:=](?!=)(?!\s*["']omit["'])/, "credentials other than omit"],
];
export function stripComments(text) {
  const out = []; const n = text.length; let i = 0, last = "";
  const regexOk = () => last === "" || "(,=:[!&|?{};+-*%<>~^".includes(last);
  while (i < n) {
    const c = text[i], d = text[i + 1];
    if (c === "/" && d === "/") { while (i < n && text[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { i += 2; while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++; i += 2; out.push(" "); continue; }
    if (c === '"' || c === "'") {
      out.push(c); i++;
      while (i < n && text[i] !== c && text[i] !== "\n") { if (text[i] === "\\") { out.push(text[i], text[i + 1] || ""); i += 2; continue; } out.push(text[i++]); }
      if (text[i] === c) { out.push(c); i++; }
      last = c; continue;
    }
    if (c === "/" && regexOk()) {
      out.push(c); i++; let cls = false;
      while (i < n && text[i] !== "\n") {
        const e = text[i];
        if (e === "\\") { out.push(e, text[i + 1] || ""); i += 2; continue; }
        if (e === "[") cls = true; else if (e === "]") cls = false; else if (e === "/" && !cls) { out.push(e); i++; break; }
        out.push(e); i++;
      }
      last = "/"; continue;
    }
    out.push(c); if (!/\s/.test(c)) last = c; i++;
  }
  return out.join("");
}

// The content policy of the page, exactly as reviewed. A different policy stops the build.
export const EXPECTED_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src https://a.espncdn.com https://*.myfantasyleague.com data:; connect-src https://upsmflproduction.keith-creelman.workers.dev; base-uri 'none'; form-action 'none'";
// The response headers the page may set (names, and the one content-policy value), exactly as reviewed.
export const ALLOWED_HEADERS = ["cache-control", "x-content-type-options", "referrer-policy", "x-robots-tag", "x-frame-options", "content-security-policy", "permissions-policy"];

function scanHtml(name, text) {
  const hits = []; const h = text.replace(/<!--[\s\S]*?-->/g, "");
  const bad = [
    [/<form\b/i, "a form"], [/<iframe\b/i, "an iframe"], [/<(?:object|embed|applet|frame|frameset)\b/i, "an embedded object"],
    [/<img\b/i, "an image tag (images are loaded by the page's code, under the content policy)"], [/<base\b/i, "a base tag"],
    [/<style\b/i, "an inline style block"], [/\sstyle\s*=/i, "an inline style"], [/\son[a-z]+\s*=/i, "an event handler"],
    [/http-equiv\s*=\s*["']?refresh/i, "a refresh"],
    [/<script(?![^>]*\ssrc\s*=)[^>]*>/i, "an inline script"],
    [/\s(?:src|href|action|formaction|data|ping|poster|srcset)\s*=\s*["']?\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/i, "an absolute or protocol-relative address"],
  ];
  for (const [re, what] of bad) if (re.test(h)) hits.push(`${name}: page: ${what}`);
  const csp = /http-equiv\s*=\s*"Content-Security-Policy"\s+content\s*=\s*"([^"]*)"/i.exec(h);
  if (!csp) hits.push(`${name}: page: no content policy`);
  else if (csp[1] !== EXPECTED_CSP) hits.push(`${name}: page: the content policy is not the reviewed one`);
  return hits;
}
function scanCss(name, text) {
  const t = stripComments(text); const hits = [];
  for (const [re, what] of [[/@import/i, "@import"], [/url\s*\(/i, "url()"], [/expression\s*\(/i, "expression()"], [/behavior\s*:/i, "behavior"], [/javascript:/i, "javascript:"]]) if (re.test(t)) hits.push(`${name}: style: ${what}`);
  return hits;
}
function scanHeaders(name, text) {
  const hits = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim(); if (!line || line.startsWith("#") || line.startsWith("/")) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m || !ALLOWED_HEADERS.includes(m[1].toLowerCase())) { hits.push(`${name}: header not on the reviewed list: ${line.slice(0, 40)}`); continue; }
    if (m[1].toLowerCase() === "content-security-policy" && m[2].trim() !== "frame-ancestors 'none'") hits.push(`${name}: the header content policy is not the reviewed one`);
  }
  return hits;
}

export function scanWriteCode(name, text) {
  const hits = [];
  if (/(?:^|[\/_.\-])(?:submit|write|post|put|delete|save|upload|send|xhr|beacon|form|sync)(?:[\/_.\-]|$)/i.test(name)) hits.push(`${name}: the file name says it writes or sends (a Preview file must not)`);
  if (name.endsWith(".html")) return hits.concat(scanHtml(name, text));
  if (name.endsWith(".css")) return hits.concat(scanCss(name, text));
  if (name === "_headers") return hits.concat(scanHeaders(name, text));
  if (!name.endsWith(".js")) return hits;
  let code = stripComments(text);
  for (const [re, what] of WRITE_PATTERNS) {
    if (re.test(code)) hits.push(`${name}: write code: ${what}`);
  }
  if (!SRC_ASSIGN_FILES.includes(name) && /\.\s*(?:src|href|action|formAction|srcset)\s*=(?!=)/.test(code)) hits.push(`${name}: write code: assigning a loading property from script`);
  if (SANCTIONED_FETCH[name]) code = code.split(SANCTIONED_FETCH[name]).join("");
  if (/(?:^|[^A-Za-z0-9_$])fetch\b/.test(code)) hits.push(`${name}: network code: a reference to fetch (the page has one sanctioned line, in app.js; everything else goes through the loader)`);
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
  const files = {}, derived = {};
  for (const n of SHARED) files[n] = sha(fs.readFileSync(path.join(sharedDir, n)));
  for (const d of DERIVED) {
    const r = d.derive(fs.readFileSync(path.join(sharedDir, d.name), "utf8"));
    if (!r.ok) throw new Error(`cannot derive ${d.out} from site/shared/${d.name}: ${r.why}`);
    derived[d.name] = { source: sha(fs.readFileSync(path.join(sharedDir, d.name))), output: sha(Buffer.from(r.text, "utf8")) };
  }
  return { note: "SHA-256 of each shared module as reviewed, and, for each derived copy, of the classic source and of the derived result. If a classic-app change touches one, review whether the beta may take it, then run: node apps/mobile2027/scripts/build.mjs --write-lock", from: "site/shared", files, derived };
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
  for (const d of DERIVED) {
    const p = path.join(sharedDir, d.name);
    if (!fs.existsSync(p)) { problems.push(`missing shared module: site/shared/${d.name}`); continue; }
    const srcBuf = fs.readFileSync(p);
    const pin = lock && lock.derived && lock.derived[d.name];
    if (!pin) { problems.push(`shared.lock.json has no pin for the derived copy of ${d.name}: review it, then run build.mjs --write-lock`); continue; }
    if (pin.source !== sha(srcBuf)) { problems.push(`shared module changed since it was pinned: site/shared/${d.name} (the beta derives ${d.out} from it). Review the change, then run build.mjs --write-lock.`); continue; }
    const r = d.derive(srcBuf.toString("utf8"));
    if (!r.ok) { problems.push(`cannot derive ${d.out} from site/shared/${d.name}: ${r.why}`); continue; }
    const buf = Buffer.from(r.text, "utf8");
    if (pin.output !== sha(buf)) { problems.push(`the derived copy ${d.out} does not match its pin (the extraction changed)`); continue; }
    problems.push(...scan(derivedOut(d), r.text), ...scanWriteCode(derivedOut(d), r.text));
    files.push({ path: derivedOut(d), bytes: buf.length, sha256: sha(buf), buf });
  }
  if (lock && lock.derived) for (const n of Object.keys(lock.derived)) if (!DERIVED.some((d) => d.name === n)) problems.push(`shared.lock.json pins a derived copy that is not on the DERIVED list: ${n}`);
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
