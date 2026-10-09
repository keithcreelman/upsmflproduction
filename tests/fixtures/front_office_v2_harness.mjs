// Loads the REAL, unmodified site/rosters/v2/front_office.js into an isolated vm sandbox
// (a minimal window/document stub -- no real DOM, no network) and exposes its internal,
// non-exported functions for testing, exactly as the browser would run them. front_office.js
// is a single IIFE with no module exports, so this splices one test-only hook
// (`window.__FO_TEST_HOOKS__`) immediately before the closing `})();` of a COPY of the
// source text held only in memory -- the real file on disk is never touched.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC_PATH = path.join(ROOT, "site/rosters/v2/front_office.js");

const HOOK_NAMES = [
  "isLoadedRow",
  "loadedContractCountForTeam",
  "capRosterRuleCounts",
  "aggregateTeamForSummary",
  "capSummaryPlayerMatches",
  "STATE",
];

/**
 * @param {object} [windowExtra] extra properties to seed on the sandbox `window` before load
 *                                (e.g. UPS_LOADED_CONTRACT_CLASSIFICATION).
 * @returns { hooks, window } -- hooks has one property per HOOK_NAMES entry (the real,
 *   unmodified function from the shipped file); window is the sandbox's own window object,
 *   useful for reading STATE-independent test hooks after the fact.
 */
// extra: optional { hooks: [more function names], raw: "name: expression, ..." } — e.g. a setter for an IIFE-private
// variable. Existing callers pass nothing and get exactly the original hook set.
export function loadFrontOfficeV2(windowExtra, extra) {
  const raw = fs.readFileSync(SRC_PATH, "utf8");
  const tail = "})();";
  const lastClose = raw.lastIndexOf(tail);
  if (lastClose === -1 || lastClose < raw.length - tail.length - 5) {
    throw new Error("front_office_v2_harness: could not find the file's closing `})();` -- source shape changed, update this harness");
  }
  const names = HOOK_NAMES.concat((extra && extra.hooks) || []);
  const rawHooks = extra && extra.raw ? ", " + extra.raw : "";
  const hookAssignment = `\n  window.__FO_TEST_HOOKS__ = { ${names.join(", ")}${rawHooks} };\n`;
  const patched = raw.slice(0, lastClose) + hookAssignment + raw.slice(lastClose);

  const win = Object.assign(
    {
      location: { href: "https://example.com/site/rosters/v2/front_office.html" },
    },
    windowExtra || {}
  );
  const doc = {
    currentScript: null,
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: () => null,
    addEventListener: () => {},
    createElement: () => ({ style: {}, addEventListener: () => {}, appendChild: () => {}, setAttribute: () => {}, classList: { add: () => {}, remove: () => {} } }),
    body: { appendChild: () => {}, addEventListener: () => {} },
    readyState: "complete",
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
    fetch: () => Promise.reject(new Error("front_office_v2_harness: no network in tests")),
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  };
  ctx.window.top = ctx.window;
  ctx.self = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(patched, ctx, { filename: "front_office.js (test copy)" });

  const hooks = win.__FO_TEST_HOOKS__;
  if (!hooks || typeof hooks.isLoadedRow !== "function") {
    throw new Error("front_office_v2_harness: hook injection failed -- __FO_TEST_HOOKS__.isLoadedRow not found after load");
  }
  return { hooks, window: win };
}
