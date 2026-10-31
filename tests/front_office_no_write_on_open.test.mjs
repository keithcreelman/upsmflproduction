// Front Office (desktop): opening a player never calls a write route, and the off-MFL testing hook that
// changes the worker origin is ignored on the MFL page.
//   node tests/front_office_no_write_on_open.test.mjs
//   FO_JS=<path> node tests/front_office_no_write_on_open.test.mjs   (defect check against another copy)
//
// #1338 audit (2026-10-20): the slide-over's Actions tab POSTed a dry-run drop_player to /roster-workbench/action
// the moment it rendered for an "-ERA" player (no click). The phone sheet removed the same probe on 2026-10-09
// ("Opening a player must never call a write route"); the worker enforces ERA retention on the real drop.
// Every write URL carries the viewer's MFL session (appendViewerSessionQuery), so ?worker_base= must not be
// honored on the MFL page.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FO = fs.readFileSync(process.env.FO_JS || path.join(ROOT, "site/rosters/v2/front_office.js"), "utf8");

function sliceFrom(src, sig) {
  const at = src.indexOf(sig);
  if (at < 0) throw new Error("not found: " + sig);
  let i = src.indexOf("{", at), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error("unbalanced: " + sig);
}
// Remove every `addEventListener("click", function (…) { … })` body: what is left runs when the tab renders.
function withoutClickHandlers(src) {
  let out = "", i = 0;
  const re = /addEventListener\(\s*["']click["']\s*,\s*function\s*\([^)]*\)\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    out += src.slice(i, m.index);
    let j = m.index + m[0].length, depth = 1;
    for (; j < src.length && depth; j++) { if (src[j] === "{") depth++; else if (src[j] === "}") depth--; }
    i = j; re.lastIndex = j;
  }
  return out + src.slice(i);
}

test("rendering the Actions tab sends nothing: every write sits behind a click", () => {
  const wire = sliceFrom(FO, "function wireActionsTab(");
  const onRender = withoutClickHandlers(wire);
  for (const call of ["fetch(", "postRosterAction(", "postContractUpdate(", "submitRosterMove(", "gateEraRetentionDropFO("]) {
    t.ok(!onRender.includes(call), "no " + call + " outside a click handler in wireActionsTab");
  }
  t.ok(!/function gateEraRetentionDropFO\s*\(/.test(FO), "the ERA dry-run probe is gone");
  t.ok(!/drop_player"\s*,\s*dry_run:\s*1/.test(FO), "no hard-coded dry-run drop body anywhere in the file");
});

test("the slide-over's tab renderer calls no write route either", () => {
  const body = sliceFrom(FO, "function renderSlideoverBody(");
  t.ok(!/method:\s*"POST"/.test(body), "no POST in renderSlideoverBody");
  t.ok(!body.includes("postRosterAction(") && !body.includes("postContractUpdate("), "no write helper in renderSlideoverBody");
});

function workerBaseFor(hostname, query) {
  const at = FO.indexOf("const IS_LOCAL_PAGE");
  t.ok(at > 0, "IS_LOCAL_PAGE guard present");
  const end = FO.indexOf("})();", FO.indexOf("const WORKER_BASE", at)) + 5;
  const code = "const QS = new URLSearchParams(" + JSON.stringify(query) + ");\n" + FO.slice(at, end) + "\nthis.out = WORKER_BASE;";
  const ctx = vm.createContext({ window: { location: { hostname } }, URLSearchParams });
  vm.runInContext(code, ctx);
  return ctx.out;
}

test("?worker_base= is ignored on the MFL page and honored on this machine", () => {
  const prod = "https://upsmflproduction.keith-creelman.workers.dev";
  t.equal(workerBaseFor("www48.myfantasyleague.com", "worker_base=https://elsewhere.example"), prod, "MFL page keeps the production worker");
  t.equal(workerBaseFor("keithcreelman.github.io", "worker_base=https://elsewhere.example"), prod, "Pages keeps the production worker");
  t.equal(workerBaseFor("localhost", "worker_base=http://127.0.0.1:8787/"), "http://127.0.0.1:8787", "local testing still works");
  t.equal(workerBaseFor("127.0.0.1", ""), prod, "no override → production");
});

await run("front_office_no_write_on_open");
