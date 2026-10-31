// A tiny page for the Front Office trade builder view (site/shared/trade_builder_view.js) in Node: the real core + view run in a vm,
// rendered into an element that records innerHTML and listeners. A "click" or "change" on a rendered tag builds its target from that
// tag's own attributes, so a test can only press what the page actually drew. Used by the trade_builder_* tests.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

export function makeEl() {
  const listeners = {};
  const el = {
    innerHTML: "", isConnected: true,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    contains() { return false; },
    // The first rendered tag matching tagRe, as an element-like target (getAttribute / hasAttribute / closest / disabled / value).
    node(tagRe) {
      const m = tagRe.exec(el.innerHTML); if (!m) return null;
      const attrs = {}; for (const a of m[0].matchAll(/([a-zA-Z0-9-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
      const node = { tag: m[0], disabled: /\sdisabled(\s|>|=)/.test(m[0]), value: attrs.value || "",
        getAttribute: (a) => (a in attrs ? attrs[a] : null), hasAttribute: (a) => a in attrs };
      node.closest = (sel) => { const want = /^\[([a-z0-9-]+)\]$/.exec(sel); return want && want[1] in attrs ? node : null; };
      return node;
    },
    fire(type, target) { (listeners[type] || []).forEach((fn) => fn({ target, preventDefault() {} })); },
  };
  return el;
}

// A vm context with the shared rules, core and view loaded (plus any extra files), a fake document and a counting fetch.
export function makeContext(extra = []) {
  const calls = { fetch: 0 };
  const listeners = {};
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, Promise, JSON, Math, Object, Array, String, Number, parseInt, isFinite, encodeURIComponent });
  ctx.window = ctx; ctx.self = ctx;
  ctx.document = { activeElement: null, getElementById: () => null, addEventListener: (k, f) => { (listeners[k] = listeners[k] || []).push(f); }, createElement: () => ({}) };
  ctx.fetch = () => { calls.fetch++; return Promise.reject(new Error("no network in this test")); };
  for (const f of ["site/shared/trade_rules.js", "site/shared/trade_builder_core.js", "site/shared/trade_builder_view.js", ...extra]) vm.runInContext(read(f), ctx, { filename: f });
  return { ctx, calls, fireDoc: (k) => (listeners[k] || []).forEach((f) => f()) };
}

export const tick = () => new Promise((r) => setTimeout(r, 5));
export const verdict = (status, reasons) => ({ ok: true, verdict: { status, reasons: reasons || [], trade_lock: { state: "none", sample: true } } });

// Page actions, by what is rendered.
export function toggle(el, n) { const b = el.node(new RegExp(`<button[^>]*data-disc="${n}"[^>]*>`)); if (!b) throw new Error("no disclosure " + n); el.fire("click", b); }
export function expanded(el, n) { const b = el.node(new RegExp(`<button[^>]*data-disc="${n}"[^>]*>`)); return b && b.getAttribute("aria-expanded") === "true"; }
export function choose(el, idx, fid) { const n = el.node(new RegExp(`<select[^>]*data-partner="${idx}"[^>]*>`)); if (!n) throw new Error("no partner select " + idx + " (is Build trade open?)"); n.value = fid; el.fire("change", n); }
export function add(el, from, pid) { const n = el.node(new RegExp(`<button[^>]*data-tok="P_${pid}" data-from="${from}"[^>]*>`)); if (!n) throw new Error(`no Add button for ${pid}`); el.fire("click", n); }
export function stepBtn(el, d, from, to) { return el.node(new RegExp(`<button[^>]*data-cap-step="${d}" data-step-from="${from}" data-step-to="${to}"[^>]*>`)); }
export function step(el, d, from, to) { const b = stepBtn(el, d, from, to); if (!b) throw new Error(`no ${d} step ${from}>${to}`); el.fire("click", b); return b; }
export function capInput(el, from, to) { return el.node(new RegExp(`<input[^>]*data-cap-from="${from}" data-cap-to="${to}"[^>]*>`)); }
export function type(el, from, to, value) { const n = capInput(el, from, to); n.value = String(value); el.fire("change", n); }
export function dest(el, from, pid, to) { const n = el.node(new RegExp(`<select[^>]*data-dest="P_${pid}" data-from="${from}"[^>]*>`)); n.value = to; el.fire("change", n); }
export function sendButton(el) { return el.node(/<button[^>]*data-go="send"[^>]*>/); }
