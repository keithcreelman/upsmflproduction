#!/usr/bin/env node
// Builds the UPS TEST website (#1475): the current mobile app (site/m) plus only the shared files its page loads,
// pointed at the TEST worker and league 25625. Nothing else from site/ is copied (site/ also holds public files
// with owner text that must not be republished; see the private-data note in the v8 plan).
//
//   node scripts/test_env/build_test_site.mjs <outDir> --worker https://ups-test.<account>.workers.dev
//
// What the build does, and checks before it finishes:
//   - copies site/m/** and the ../shared/*.js files that site/m/index.html references (an allowlist read from the page)
//   - replaces the production worker address with the test worker address, and league 74598 with 25625, everywhere
//   - adds _headers: a content security policy whose connect-src is the page itself and the test worker only (a
//     missed production address can't be fetched), noindex, and no referrer
//   - marks the page title "UPS TEST"
//   - refuses to finish if any output file still names the production worker, league 74598, or a file outside the allowlist
// It deploys nothing. Publishing is `wrangler pages deploy <outDir> --project-name ups-test-25625 --branch main`.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SITE = path.join(ROOT, "site");
export const PROD_WORKER = "https://upsmflproduction.keith-creelman.workers.dev";
export const PROD_LEAGUE = "74598";
export const TEST_LEAGUE = "25625";

export function sharedRefs(indexHtml) {
  return [...new Set([...indexHtml.matchAll(/src="\.\.\/shared\/([A-Za-z0-9_.-]+\.js)(?:\?[^"]*)?"/g)].map((m) => m[1]))].sort();
}

// The page's inline scripts (the boot call), allowed by their exact hash and nothing else inline.
export function inlineScriptHashes(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${crypto.createHash("sha256").update(m[1]).digest("base64")}'`);
}

export function headersFor(worker, scriptHashes = []) {
  const csp = [
    "default-src 'self'",
    ["script-src 'self'", ...scriptHashes].join(" "),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    `connect-src 'self' ${worker}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join("; ");
  return `/*\n  Content-Security-Policy: ${csp}\n  X-Robots-Tag: noindex, nofollow\n  Referrer-Policy: no-referrer\n  X-Content-Type-Options: nosniff\n`;
}

export function rewrite(text, worker) {
  return text.split(PROD_WORKER).join(worker).split(PROD_LEAGUE).join(TEST_LEAGUE);
}

export function build(outDir, worker, site = SITE) {
  if (!/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(worker) || worker === PROD_WORKER) throw new Error("--worker must be the test worker's https://<name>.<account>.workers.dev address, not production's");
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) throw new Error(`${outDir} is not empty`);
  const index = fs.readFileSync(path.join(site, "m", "index.html"), "utf8");
  const shared = sharedRefs(index);
  const files = [];
  (function walk(rel) {
    for (const e of fs.readdirSync(path.join(site, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) walk(r); else files.push(r);
    }
  })("m");
  for (const f of shared) files.push(path.join("shared", f));
  const out = [];
  for (const rel of files) {
    const src = path.join(site, rel), dst = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (/\.(js|html|json|css|webmanifest)$/.test(rel)) {
      let t = rewrite(fs.readFileSync(src, "utf8"), worker);
      if (rel === path.join("m", "index.html")) t = t.replace(/<title>([^<]*)<\/title>/, (_, x) => `<title>UPS TEST · ${x}</title>`);
      fs.writeFileSync(dst, t);
    } else fs.copyFileSync(src, dst);
    out.push(rel.split(path.sep).join("/"));
  }
  fs.writeFileSync(path.join(outDir, "_headers"), headersFor(worker, inlineScriptHashes(fs.readFileSync(path.join(outDir, "m", "index.html"), "utf8"))));
  // the root opens the app
  fs.writeFileSync(path.join(outDir, "index.html"), `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=./m/"><title>UPS TEST</title><a href="./m/">UPS TEST (league ${TEST_LEAGUE})</a>\n`);
  // checks on the output itself
  const problems = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      const rel = path.relative(outDir, p).split(path.sep).join("/");
      if (!["_headers", "index.html"].includes(rel) && !out.includes(rel)) problems.push(`not in allowlist: ${rel}`);
      const b = fs.readFileSync(p);
      const t = b.toString("latin1");
      if (t.includes("upsmflproduction.keith-creelman")) problems.push(`names the production worker: ${rel}`);
      if (t.includes(PROD_LEAGUE)) problems.push(`names league ${PROD_LEAGUE}: ${rel}`);
    }
  })(outDir);
  if (problems.length) throw new Error("test site build failed its checks:\n  " + problems.join("\n  "));
  return { files: out.length + 2, shared };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const i = a.indexOf("--worker");
  if (a.length !== 3 || i < 0) { console.error("usage: build_test_site.mjs <outDir> --worker https://ups-test.<account>.workers.dev"); process.exit(2); }
  const worker = a[i + 1], outDir = a.filter((_, j) => j !== i && j !== i + 1)[0];
  try { const r = build(path.resolve(outDir), worker); console.log(JSON.stringify({ ok: true, ...r })); }
  catch (e) { console.error(e.message); process.exit(1); }
}
