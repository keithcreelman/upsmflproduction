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
//   - adds m/ups_test_idempotency.js, loaded before every other script: each write the page sends to the test
//     worker gets its own Idempotency-Key, which the test worker's write ledger requires (the real app never
//     sends one; this file exists only on the test site)
//   - adds MFL 2.0 (apps/m2/**, Release 1; Keith 2026-11-26) at /m2/, with the same checks. apps/m2 is outside site/,
//     so the public GitHub Pages workflow (site/ only) never publishes it. Its config.js placeholders
//     __UPS_TEST_WORKER__ / __UPS_TEST_LEAGUE__ are filled here, and its pages may not carry inline scripts.
//   - refuses any symlink in the source, and any source whose real path is outside site/m or the selected shared files
//   - refuses to finish if any output file still names the production worker, league 74598, or a file outside the allowlist
// It deploys nothing. Publishing is `wrangler pages deploy <outDir> --project-name ups-test-25625 --branch main`.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SITE = path.join(ROOT, "site");
const M2 = path.join(ROOT, "apps", "m2");
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

// The test worker refuses a write without an Idempotency-Key (428 idempotency_key_required). The real app has no
// such header, so the TEST site wraps fetch: every POST/PUT/PATCH/DELETE to the test worker that carries no key
// gets a new random one. One key per send: a retry by the app is a new attempt, and the ledger's operation
// locks (not the key) are what stop the same MFL write going out twice. Reads, other hosts and a key the
// caller set are left alone. Found by Keith's first phone test, 2026-11-26.
export const IDEMPOTENCY_SHIM = "ups_test_idempotency.js";
export function idempotencyShim(worker) {
  return `// UPS TEST site only (built by scripts/test_env/build_test_site.mjs); never part of the real app.
(function () {
  var WORKER = ${JSON.stringify(new URL(worker).origin)};
  var orig = window.fetch;
  if (typeof orig !== "function" || orig.__upsTestKeyed) return;
  function newKey() {
    var c = window.crypto;
    if (c && typeof c.randomUUID === "function") return "ui-" + c.randomUUID();
    var b = new Uint8Array(16); c.getRandomValues(b);
    return "ui-" + Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join("");
  }
  var keyed = function (input, init) {
    try {
      var isReq = typeof Request === "function" && input instanceof Request;
      var url = isReq ? input.url : String(input);
      var method = String((init && init.method) || (isReq ? input.method : "GET")).toUpperCase();
      if (/^(POST|PUT|PATCH|DELETE)$/.test(method) && new URL(url, window.location.href).origin === WORKER) {
        var h = new Headers((init && init.headers) || (isReq ? input.headers : undefined));
        if (!h.has("Idempotency-Key")) {
          h.set("Idempotency-Key", newKey());
          init = Object.assign({}, init || {}, { headers: h });
        }
      }
    } catch (e) { /* leave the request as it was: the worker then refuses it (428), it never goes out unkeyed */ }
    return orig.call(this, input, init);
  };
  keyed.__upsTestKeyed = true;
  window.fetch = keyed;
})();
`;
}

export function rewrite(text, worker) {
  return text.split(PROD_WORKER).join(worker).split(PROD_LEAGUE).join(TEST_LEAGUE);
}

export function build(outDir, worker, site = SITE, m2 = site === SITE ? M2 : null) {
  if (!/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(worker) || worker === PROD_WORKER) throw new Error("--worker must be the test worker's https://<name>.<account>.workers.dev address, not production's");
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) throw new Error(`${outDir} is not empty`);
  // Review round 4: a symlink inside site/m (or a shared file that is one) could point at a private file elsewhere and be
  // copied into an allowed output path. Every source must be a plain file or folder, and its real path must stay inside
  // site/m or be one of the selected shared files.
  const realSite = fs.realpathSync(site);
  const plain = (rel) => {
    const st = fs.lstatSync(path.join(site, rel));
    if (st.isSymbolicLink()) throw new Error(`test site build refused a symlink: site/${rel.split(path.sep).join("/")}`);
    return st;
  };
  plain("m"); plain("shared");
  const index = fs.readFileSync(path.join(site, "m", "index.html"), "utf8");
  const shared = sharedRefs(index);
  if (fs.existsSync(path.join(site, "m", IDEMPOTENCY_SHIM))) throw new Error(`site/m/${IDEMPOTENCY_SHIM} already exists; the test build writes that file itself`);
  if (!/<script\b/.test(index)) throw new Error("site/m/index.html loads no script; can't place the idempotency shim before them");
  const files = [];
  (function walk(rel) {
    for (const e of fs.readdirSync(path.join(site, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      const st = plain(r);
      if (st.isDirectory()) walk(r); else if (st.isFile()) files.push(r);
      else throw new Error(`test site build refused a non-regular file: site/${r.split(path.sep).join("/")}`);
    }
  })("m");
  for (const f of shared) { const r = path.join("shared", f); if (!plain(r).isFile()) throw new Error(`test site build: site/shared/${f} is not a regular file`); files.push(r); }
  const allowedReal = (rel) => {
    const real = fs.realpathSync(path.join(site, rel));
    const m = path.join(realSite, "m") + path.sep;
    return real.startsWith(m) || shared.some((f) => real === path.join(realSite, "shared", f));
  };
  const out = [];
  for (const rel of files) {
    if (!allowedReal(rel)) throw new Error(`test site build refused a source outside the allowlist: site/${rel.split(path.sep).join("/")}`);
    const src = path.join(site, rel), dst = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (/\.(js|html|json|css|webmanifest)$/.test(rel)) {
      let t = rewrite(fs.readFileSync(src, "utf8"), worker);
      if (rel === path.join("m", "index.html")) {
        t = t.replace(/<title>([^<]*)<\/title>/, (_, x) => `<title>UPS TEST · ${x}</title>`);
        const at = t.search(/<script\b/);
        t = t.slice(0, at) + `<script src="${IDEMPOTENCY_SHIM}"></script>\n  ` + t.slice(at);
      }
      fs.writeFileSync(dst, t);
    } else fs.copyFileSync(src, dst);
    out.push(rel.split(path.sep).join("/"));
  }
  if (m2 && fs.existsSync(m2)) {
    // MFL 2.0: every source a plain file or folder whose real path stays inside apps/m2.
    if (fs.lstatSync(m2).isSymbolicLink()) throw new Error("test site build refused a symlink: apps/m2");
    const realM2 = fs.realpathSync(m2) + path.sep;
    const BUILD_STAMP = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 12);   // cache-buster for /m2/ assets
    (function walk(rel) {
      for (const e of fs.readdirSync(path.join(m2, rel), { withFileTypes: true })) {
        const r = path.join(rel, e.name), src = path.join(m2, r);
        const st = fs.lstatSync(src);
        if (st.isSymbolicLink()) throw new Error(`test site build refused a symlink: apps/m2/${r.split(path.sep).join("/")}`);
        if (st.isDirectory()) { walk(r); continue; }
        if (!st.isFile()) throw new Error(`test site build refused a non-regular file: apps/m2/${r.split(path.sep).join("/")}`);
        if (!fs.realpathSync(src).startsWith(realM2)) throw new Error(`test site build refused a source outside apps/m2: ${r}`);
        const dst = path.join(outDir, "m2", r);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        if (/\.(js|html|json|css|webmanifest)$/.test(r)) {
          let t = rewrite(fs.readFileSync(src, "utf8"), worker).split("__UPS_TEST_WORKER__").join(worker).split("__UPS_TEST_LEAGUE__").join(TEST_LEAGUE).split("__UPS_BUILD__").join(BUILD_STAMP);
          if (/\.html$/.test(r) && /<script(?![^>]*\bsrc=)[^>]*>/i.test(t)) throw new Error(`apps/m2/${r} has an inline script; the test site's policy allows only the /m/ boot script`);
          fs.writeFileSync(dst, t);
        } else fs.copyFileSync(src, dst);
        out.push(["m2", ...r.split(path.sep)].join("/"));
      }
    })("");
  }
  fs.writeFileSync(path.join(outDir, "m", IDEMPOTENCY_SHIM), idempotencyShim(worker));
  out.push(`m/${IDEMPOTENCY_SHIM}`);
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
