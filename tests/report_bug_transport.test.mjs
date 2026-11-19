// Report bug, test-only integration (#1473): the facts the global-fetch observer's coverage rests on.
//   node tests/report_bug_transport.test.mjs
//
// The observer in site/m/report_bug.js wraps window.fetch. It sees every failed request the phone app makes ONLY IF
// every request goes through that global fetch. These tests pin that, so a new XMLHttpRequest, beacon, EventSource,
// WebSocket, Worker, importScripts or aliased/captured fetch anywhere in site/m fails the build instead of silently
// escaping. They also pin the expected-exception ledger (every entry justified by real code) and the page names.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RB = createRequire(import.meta.url)("../site/m/report_bug.js");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

// Every script the phone app runs: site/m/*.js and site/m/views/*.js, minus the sheet itself and the service worker
// (a service worker's own fetches are not the page's requests; the page's fetches through it still hit window.fetch).
function appFiles() {
  const out = [];
  for (const dir of ["site/m", "site/m/views"]) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) {
      if (!f.endsWith(".js") || f === "report_bug.js" || f === "sw.js") continue;
      out.push(path.posix.join(dir, f));
    }
  }
  return out.sort();
}
// Code only, so a comment that mentions XMLHttpRequest does not trip the scan.
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/[^\n]*/g, "$1");

test("the scanner sees the app: it finds the known fetch call sites (so an empty scan cannot pass)", () => {
  let fetches = 0, fetchJson = 0;
  for (const f of appFiles()) {
    const code = strip(read(f));
    fetches += (code.match(/\bfetch\(/g) || []).length;
    fetchJson += (code.match(/\bfetchJson\(/g) || []).length;
  }
  t.ok(appFiles().length >= 24, "scanned " + appFiles().length + " files");
  t.ok(fetches >= 80, "direct fetch( call sites found: " + fetches);
  t.ok(fetchJson >= 20, "fetchJson( call sites found: " + fetchJson);
});

const FORBIDDEN = [
    [/\bXMLHttpRequest\b/, "XMLHttpRequest"], [/\bsendBeacon\b/, "navigator.sendBeacon"], [/\bEventSource\b/, "EventSource"],
    [/\bWebSocket\b/, "WebSocket"], [/\bimportScripts\b/, "importScripts"], [/\bnew\s+Worker\b/, "new Worker"], [/\bSharedWorker\b/, "SharedWorker"],
    [/\bnew\s+Request\s*\(/, "new Request (a Request fetched some other way)"],
    [/\bnew\s+Image\s*\(/, "new Image (an image beacon)"],
];

test("the global fetch is the ONLY network transport in the phone app", () => {
  for (const f of appFiles()) {
    const code = strip(read(f));
    for (const [re, name] of FORBIDDEN) t.doesNotMatch(code, re, f + " uses " + name + ": the observer cannot see it. Route it through fetch() or extend the observer and this test.");
  }
});

const ALIASES = [
    /(?:var|let|const)\s+\w+\s*=\s*(?:window\.|self\.|globalThis\.)?fetch\s*[;,)]/,        // var f = fetch;
    /(?:^|[^.\w])fetch\.(?:bind|call|apply)\b/,                                             // fetch.bind(window)
    /(?:window|self|globalThis)\.fetch\s*=(?!=)/,                                           // replacing fetch
    /\bwindow\.fetch\b/, /\bself\.fetch\b/, /\bglobalThis\.fetch\b/,                        // reaching it by another name
    /[:(,]\s*fetch\s*[,)}]/,                                                                // handing the function around: foo(fetch), {fetch: fetch}
];

test("no file captures, aliases, rebinds or replaces fetch (the observer replaces window.fetch; a captured copy would bypass it)", () => {
  for (const f of appFiles()) {
    const code = strip(read(f));
    for (const re of ALIASES) {
      const m = re.exec(code);
      t.ok(!m, f + " has an aliased or captured fetch: " + (m ? JSON.stringify(m[0]) : ""));
    }
  }
});

test("the scanners are not vacuous: each forbidden pattern is caught in a sample", () => {
  const transports = ["var x = new XMLHttpRequest();", "navigator.sendBeacon('/x', d);", "new EventSource(u)", "new WebSocket(u)", "importScripts('a.js')",
    "new Worker('w.js')", "new SharedWorker('w.js')", "fetch(new Request(u))", "new Image().src = u;"];
  transports.forEach((sample, i) => t.ok(FORBIDDEN[i][0].test(strip(sample)), "transport sample " + i + " caught: " + sample));
  const aliasSamples = ["var f = fetch;", "const g = window.fetch;", "let h = fetch.bind(window);", "window.fetch = mine;", "self.fetch(u)", "foo(fetch)", "x = {run: fetch}"];
  aliasSamples.forEach((sample) => t.ok(ALIASES.some((re) => re.test(strip(sample))), "alias sample caught: " + sample));
  // and ordinary calls are NOT flagged
  ["return fetch(url, { mode: 'cors' }).then(f);", "fetch(workerUrl('/api/x')).catch(function () {});"].forEach((ok) => t.ok(!ALIASES.some((re) => re.test(strip(ok))), "ordinary call not flagged: " + ok));
  // comments are ignored
  t.ok(!FORBIDDEN[0][0].test(strip("// XMLHttpRequest is not used\n/* WebSocket */ var a = 1;")));
});

test("index.html does not load the sheet script: with no extra page, the app is exactly as before", () => {
  const html = read("site/m/index.html");
  t.doesNotMatch(html, /report_bug/i);
  t.doesNotMatch(html, /UPSReportBug/);
  // and nothing else in site/ loads it either
  for (const f of ["site/m/app.js", ...fs.readdirSync(path.join(ROOT, "site/m/views")).map((x) => "site/m/views/" + x)]) {
    if (!f.endsWith(".js")) continue;
    const code = strip(read(f));
    // The only allowed mentions are the guarded hooks in app.js (a property read behind try/catch), never a script load.
    t.doesNotMatch(code, /createElement\(\s*["']script["']\s*\)[\s\S]{0,200}report_bug/, f + " injects report_bug.js");
  }
});

test("the expected-exception ledger: every entry names a path, a status and a reason, and is justified by real app code", () => {
  const L = RB.EXPECTED_NON_FAILURES;
  t.ok(L.length >= 1 && L.length <= 12, "short list: " + L.length);
  const all = appFiles().map((f) => strip(read(f))).join("\n");
  const seen = new Set();
  for (const e of L) {
    t.ok(typeof e.path === "string" && e.path.charAt(0) === "/", "path: " + JSON.stringify(e));
    t.ok(Number.isInteger(e.status) && e.status >= 400 && e.status <= 599, "status: " + e.status);
    t.ok(typeof e.reason === "string" && e.reason.length >= 25, "reason: " + e.path);
    const key = e.path + "|" + e.status;
    t.ok(!seen.has(key), "no duplicate entry: " + key); seen.add(key);
    t.ok(all.includes(e.path), "the app really requests " + e.path);
    t.ok(new RegExp("\\b" + e.status + "\\b").test(all), "the app really handles status " + e.status);
  }
  // matching is exact on path (or a stated prefix) AND status
  t.ok(RB.isExpected("/api/trades/proposals", 401));
  t.ok(!RB.isExpected("/api/trades/proposals", 500), "a 500 is never an exception");
  t.ok(!RB.isExpected("/api/trades/proposals/action", 401), "exact path, not a prefix");
  t.ok(RB.isExpected("/api/auction/bid", 503));
  t.ok(!RB.isExpected("/api/auction/bid", 500));
  t.ok(!RB.isExpected("/api/me", 404));
});

test("page names: every route the app registers has one, and the bottom-nav labels agree with them", () => {
  const registered = new Set();
  for (const f of appFiles()) for (const m of strip(read(f)).matchAll(/registerView\(\s*"([a-z0-9_-]+)"/g)) registered.add(m[1]);
  t.ok(registered.size >= 8, "registered routes: " + [...registered].join(","));
  for (const r of registered) t.ok(RB.ROUTE_LABELS[r], "route '" + r + "' needs a page name in ROUTE_LABELS (report_bug.js)");
  const html = read("site/m/index.html");
  let n = 0;
  for (const m of html.matchAll(/data-subroute="([a-z/]+)"[\s\S]*?ups-m-nav-label">([^<]+)</g)) {
    n++;
    t.equal(RB.screenFor("#" + m[1]), m[2].trim(), "nav item " + m[1]);
  }
  t.ok(n >= 5, "nav items checked: " + n);
  t.equal(RB.screenFor("#myteam/lineup/some/deep/path?x=1"), "Lineup");
  t.equal(RB.screenFor(""), "Home");
  t.equal(RB.screenFor("#nonsense"), "Nonsense");
});

await run("report_bug_transport");
