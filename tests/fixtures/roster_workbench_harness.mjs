// Loads the REAL, unmodified site/rosters/roster_workbench.js into an isolated vm sandbox
// (a minimal window/document stub -- no real DOM, no network) and exposes its internal,
// non-exported functions for testing, exactly as the browser would run them. Mirrors
// tests/fixtures/front_office_v2_harness.mjs's technique -- see that file's header for the
// full rationale (roster_workbench.js is also a single IIFE with no module exports).
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC_PATH = path.join(ROOT, "site/rosters/roster_workbench.js");

const HOOK_NAMES = [
  "isLoadedContractStatus",
  "contractBucket",
  "typeTone",
  "isLoadedContractPlayer",
  "loadedContractTally",
  "contractLimitSummaryForPlayers",
];

// extra: optional { hooks: [more function names], raw: "name: expression, ..." } — e.g. a setter for an IIFE-private
// variable. Existing callers pass nothing and get exactly the original hook set.
export function loadRosterWorkbench(windowExtra, extra) {
  const raw = fs.readFileSync(SRC_PATH, "utf8");
  const tail = "})();";
  const lastClose = raw.lastIndexOf(tail);
  if (lastClose === -1 || lastClose < raw.length - tail.length - 5) {
    throw new Error("roster_workbench_harness: could not find the file's closing `})();` -- source shape changed, update this harness");
  }
  const names = HOOK_NAMES.concat((extra && extra.hooks) || []);
  const rawHooks = extra && extra.raw ? ", " + extra.raw : "";
  const hookAssignment = `\n  window.__RWB_TEST_HOOKS__ = { ${names.join(", ")}${rawHooks} };\n`;
  const patched = raw.slice(0, lastClose) + hookAssignment + raw.slice(lastClose);

  const win = Object.assign(
    { location: { href: "https://example.com/site/rosters/roster_workbench.html" } },
    windowExtra || {}
  );
  const doc = {
    currentScript: null,
    readyState: "loading", // avoid the immediate init() call at the bottom of the file
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: () => null,
    addEventListener: () => {}, // init() is deferred to a DOMContentLoaded that never fires here
    removeEventListener: () => {},
    createElement: () => ({ style: {}, addEventListener: () => {}, appendChild: () => {}, setAttribute: () => {}, classList: { add: () => {}, remove: () => {} } }),
    body: { appendChild: () => {}, addEventListener: () => {} },
  };
  const ctx = {
    window: win,
    document: doc,
    navigator: { userAgent: "node-test" },
    URL,
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout,
    fetch: () => Promise.reject(new Error("roster_workbench_harness: no network in tests")),
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  };
  ctx.window.top = ctx.window;
  ctx.self = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(patched, ctx, { filename: "roster_workbench.js (test copy)" });

  const hooks = win.__RWB_TEST_HOOKS__;
  if (!hooks || typeof hooks.isLoadedContractStatus !== "function") {
    throw new Error("roster_workbench_harness: hook injection failed -- __RWB_TEST_HOOKS__.isLoadedContractStatus not found after load");
  }
  return { hooks, window: win };
}
