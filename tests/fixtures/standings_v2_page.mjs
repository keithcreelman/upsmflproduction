// Runs the REAL desktop standings page script (site/standings/mfl_hpm_standings_v2.html) in node, against a caller-supplied
// fetch (typically the real worker via tests/fixtures/worker_harness.mjs callWorker), with a deliberately small DOM: every
// element records its innerHTML, so a test reads what a view actually rendered. The page boots from its own query string
// (?view=&year=&scope=), exactly as in the browser.
import fs from "node:fs";
import vm from "node:vm";

const PAGE = fs.readFileSync(new URL("../../site/standings/mfl_hpm_standings_v2.html", import.meta.url), "utf8");

function inlineScripts(html) {
  const out = [];
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) out.push(m[1]);
  return out;
}
function srcScripts(html) {
  return [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g)].map((m) => m[1]);
}

function makeEl(id) {
  const listeners = {};
  return {
    id: id || "", innerHTML: "", textContent: "", value: "", style: {}, dataset: {}, children: [], hidden: false,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {}, setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    appendChild(c) { this.children.push(c); return c; }, insertBefore(c) { this.children.push(c); return c; },
    querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
    focus() {}, scrollIntoView() {}, getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
  };
}

// opts: { query: "view=overall&year=2026&scope=regular", fetch: async (url) => Response-like, shared: { "../shared/x.js": src } }
export function loadStandingsPage(opts) {
  const els = new Map();
  const byId = (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };
  const body = makeEl("body");
  const document = {
    body, documentElement: makeEl("html"), title: "",
    getElementById: byId, querySelector: () => null, querySelectorAll: () => [],
    createElement: (tag) => makeEl(tag), createTextNode: (t) => ({ textContent: t }), addEventListener() {},
  };
  const href = "https://keithcreelman.github.io/upsmflproduction/standings/mfl_hpm_standings_v2.html?" + (opts.query || "");
  const window = {
    location: { href, search: "?" + (opts.query || ""), hash: "" }, history: { replaceState() {}, pushState() {} },
    addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), localStorage: { getItem: () => null, setItem() {} },
  };
  const ctx = { window, document, fetch: opts.fetch, console, setTimeout, clearTimeout, Promise, URL, URLSearchParams, Date, Math, JSON };
  window.document = document;
  vm.createContext(ctx);
  // the page's own <script src> modules under ../shared/ (none on main; A1 adds standings_race.js), then its inline script
  for (const src of srcScripts(PAGE)) {
    const m = /^\.\.\/shared\/([\w.-]+\.js)/.exec(src);
    if (!m) continue;
    vm.runInContext(fs.readFileSync(new URL("../../site/shared/" + m[1], import.meta.url), "utf8"), ctx);
  }
  for (const code of inlineScripts(PAGE)) vm.runInContext(code, ctx);
  return {
    // every element's rendered HTML, concatenated (views write into a host element the page looked up by id)
    html: () => [body.innerHTML, ...[...els.values()].map((e) => e.innerHTML)].join("\n"),
    els, ctx,
  };
}

// A fetch that sends the page's worker calls to the REAL worker (callWorker) — the worker-to-client path.
export function workerFetch(callWorker, env) {
  return async (url) => {
    const u = new URL(url);
    const r = await callWorker(env, "GET", u.pathname + u.search);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json, text: async () => r.text };
  };
}

export const settle = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
