// Loads the REAL, unmodified site/m/front_office_myac_submit.js into a minimal vm sandbox --
// no real DOM, no network -- and returns its window.UPS_M_FO_MYAC export exactly as a browser
// would produce it. Unlike roster_workbench.js/front_office.js (un-exported IIFEs, needing the
// hook-injection technique in their own harnesses), this file already exports via
// window.UPS_M_FO_MYAC, so no source patching is needed.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC_PATH = path.join(ROOT, "site/m/front_office_myac_submit.js");

export function loadMobileMyac(windowExtra) {
  const src = fs.readFileSync(SRC_PATH, "utf8");
  const win = Object.assign({}, windowExtra || {});
  const ctx = { window: win, console, setTimeout, clearTimeout, fetch: () => Promise.reject(new Error("mobile_myac_harness: no network in tests")) };
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: "front_office_myac_submit.js (test copy)" });
  if (!win.UPS_M_FO_MYAC || typeof win.UPS_M_FO_MYAC.isLoadedRow !== "function") {
    throw new Error("mobile_myac_harness: window.UPS_M_FO_MYAC.isLoadedRow not found after load");
  }
  return win.UPS_M_FO_MYAC;
}
