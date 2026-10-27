// The REAL, whole desktop Trade War Room (site/trades/trade_workbench.js) booted in a vm against a tiny fake DOM,
// with fetch() going to the REAL worker (real SQLite; MFL stubbed at the edge). The same boot technique as
// tests/trade_inbox_states.test.mjs, plus a captured console and per-test fetch overrides.
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { makeWorkerEnv, makeMfl, workerFetch } from "./worker_harness.mjs";
import { settle } from "./fake_dom.mjs";

const require = createRequire(import.meta.url);
const SHARED_VIEW = require("../../site/shared/trade_3way_view.js");
const SHARED_RULES = require("../../site/shared/trade_rules.js");
const DESK_SRC = fs.readFileSync(new URL("../../site/trades/trade_workbench.js", import.meta.url), "utf8");
export const WORKER = "https://upsmflproduction.keith-creelman.workers.dev";

export const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(), text: async () => (typeof body === "string" ? body : JSON.stringify(body)), json: async () => (typeof body === "string" ? JSON.parse(body) : body) });

export function simpleEl() {
  const target = { children: [], attrs: {}, textContent: "", style: {}, disabled: false, hidden: false, className: "", value: "", classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(c) { target.children.push(c); return c; }, setAttribute(k, v) { target.attrs[k] = v; }, getAttribute: (k) => (k in target.attrs ? target.attrs[k] : null),
    addEventListener(ev, fn) { (target.__l = target.__l || {})[ev] = fn; }, removeEventListener() {}, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    set innerHTML(v) { target.__h = v; if (v === "") target.children.length = 0; }, get innerHTML() { return target.__h || ""; } };
  const dummy = () => new Proxy(function () {}, { get: (_, k) => (k === "length" ? 0 : k === "style" ? {} : k === "value" ? "" : k === Symbol.toPrimitive ? () => "" : dummy()), apply: () => dummy(), set: () => true });
  return new Proxy(target, { get: (o, k) => (k in o ? o[k] : dummy()), set: (o, k, v) => { o[k] = v; return true; } });
}

// Two owners with one flat, non-loaded contract each: 0001 (tok-B) holds 14056, 0002 (tok-C) holds 13100.
export function pageWorld() {
  const env = makeWorkerEnv(); const mfl = makeMfl(); mfl.install();
  mfl.st.rosters["0001"] = [{ id: "14056", salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }];
  mfl.st.rosters["0002"] = [{ id: "13100", salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }];
  return { env, mfl, log: [] };
}

// override(url, init) may return a response (or throw) to replace the worker's answer; real(url, init) reaches the worker.
export async function bootDesktop(w, { token, fid, override, extraQuery = "", win: winExtra = {} }) {
  const loc = new URL(`https://keithcreelman.github.io/upsmflproduction/trades/trade_workbench.html?embed=1&L=74598&YEAR=2026&FRANCHISE_ID=${fid}${token ? "&MFL_USER_ID=" + token : ""}${extraQuery}&api=` + encodeURIComponent(WORKER + "/trade-workbench"));
  const real = workerFetch(w.env, w.log);
  const fetchImpl = async (u, i) => {
    if (new URL(String(u)).hostname === "keithcreelman.github.io") return resp(404, "");
    if (override) { const o = await override(String(u), i, real); if (o) return o; }
    return real(u, i);
  };
  const consoleLines = [];
  const capture = (level) => (...args) => { consoleLines.push(level + " " + args.map((a) => { try { return typeof a === "string" ? a : JSON.stringify(a); } catch (e) { return String(a); } }).join(" ")); };
  const els = {};
  const getEl = (id) => (els[id] = els[id] || simpleEl());
  const doc = { readyState: "complete", cookie: "", getElementById: getEl, querySelector: () => simpleEl(), querySelectorAll: () => [], createElement: () => simpleEl(), addEventListener() {}, body: simpleEl(), documentElement: simpleEl(), head: simpleEl(), currentScript: null };
  const win = { location: { href: loc.href, search: loc.search, origin: loc.origin, pathname: loc.pathname, hash: "" }, addEventListener() {}, removeEventListener() {}, parent: { postMessage() {} }, postMessage() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, requestAnimationFrame: (f) => setTimeout(f, 0), setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, history: { replaceState() {} }, innerWidth: 1280, scrollTo() {}, UPS_TRADE_3WAY: SHARED_VIEW, UPS_TRADE_RULES: SHARED_RULES, ...winExtra };
  const sb = { window: win, document: doc, fetch: fetchImpl, console: { log: capture("log"), warn: capture("warn"), error: capture("error"), info: capture("info"), debug: capture("debug") }, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, URL, URLSearchParams, Promise, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, encodeURIComponent, decodeURIComponent, isFinite, isNaN, parseInt, parseFloat, Map, Set, Symbol, navigator: { clipboard: {} }, requestAnimationFrame: (f) => setTimeout(f, 0), ResizeObserver: class { observe() {} disconnect() {} }, MutationObserver: class { observe() {} disconnect() {} }, Intl, TextEncoder, atob, btoa, structuredClone, localStorage: win.localStorage, sessionStorage: win.sessionStorage, location: win.location, UPS_TRADE_3WAY: SHARED_VIEW };
  win.fetch = fetchImpl; sb.self = win; vm.createContext(sb);
  vm.runInContext(DESK_SRC, sb, { filename: "site/trades/trade_workbench.js" });
  await settle(90);
  return { api: win.upsTradeWorkbench, els, consoleLines, consoleText: () => consoleLines.join("\n") };
}

export const pageText = (d) => Object.values(d.els).map((e) => `${e.innerHTML} ${e.textContent}`).join("\n");

// Put 0001's player against 0002's in the real builder (optionally with cap money from 0001, in $K) and type a message.
// Returns the builder's own validation status.
export function readyOffer(d, message, { capK = 0 } = {}) {
  const S = d.api.state;
  const left = S.data.teams.find((x) => x.franchise_id === "0001"), right = S.data.teams.find((x) => x.franchise_id === "0002");
  S.leftTeamId = "0001"; S.rightTeamId = "0002";
  S.selections["0001"] = { [left.assets.find((a) => a.player_id === "14056").asset_id]: true };
  S.selections["0002"] = { [right.assets.find((a) => a.player_id === "13100").asset_id]: true };
  S.tradeSalaryK["0001"] = capK ? String(capK) : "";
  d.els.twbOfferMessageInput.value = message;
  return d.api.buildTradePayload().validation.status;
}
