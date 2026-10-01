// STAGED TRADES UI REMOVED FROM THE NORMAL OWNER EXPERIENCE (Keith, 2026-10-01, second pass):
// "I still see 'Staged Trades' in the Trade War Room. That is not the experience I requested...
// this section should not appear to owners." The four staging flags are off in production and
// ups_2way_trades has zero rows, but NOTHING in the client ever checked flag state or list
// emptiness before rendering the dropdown/button/detail panel -- they were static, always-on UI.
//
// This file is the dedicated regression guard Keith asked for: it exercises the ACTUAL RENDER
// PATHS (the real static HTML file on desktop; the REAL mobile render() function, run in a VM
// against a REAL worker, not a stub) rather than just grepping source for an absent string --
// see tests/trade_staged_no_accidental_crossover.test.mjs for the source-level wiring checks
// that complement this file.
//
// Deliberately NOT removed, and NOT tested here as absent: the reactive cutover fallback
// (submitViaStagingFallback / submitViaStagingFallbackMobile / submitCounterViaStagingFallbackMobile)
// -- it is not a visible UI element, only fires if the server itself returns
// `staging_required` (impossible today, TRADE_2WAY_CUTOVER_ENABLED=0), and Keith has twice now
// explicitly asked for the normal trade flow to be kept intact. The staged D1 engine
// (worker/src/trade_2way.js) and its table are also untouched -- this is a UI-only removal.
//   node tests/trade_staged_ui_hidden_from_owners.test.mjs
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, workerFetch, quiet } from "./fixtures/worker_harness.mjs";
import { makeEl } from "./fixtures/fake_dom.mjs";

const require = createRequire(import.meta.url);
const T = require("../site/shared/trade_3way_view.js");
const MOBILE_SRC = fs.readFileSync(new URL("../site/m/views/trade.js", import.meta.url), "utf8");
const DESK_HTML = fs.readFileSync(new URL("../site/trades/trade_workbench.html", import.meta.url), "utf8");
const restore = quiet();

// ───────────────────────── DESKTOP: the real, as-shipped static HTML file ─────────────────────────
// The dropdown/button/detail-panel were static markup -- always in the DOM on first paint, no JS
// needed to show them. Reading the exact file that ships to the browser (not a copy, not a
// fixture) IS the real render path for this always-visible part of the page.
test("DESKTOP: the real trade_workbench.html file never contains the Staged Trades dropdown, the Stage button, or the staged detail panel", () => {
  t.doesNotMatch(DESK_HTML, /id="twb2sDropdown"/);
  t.doesNotMatch(DESK_HTML, /id="twb2sList"/);
  t.doesNotMatch(DESK_HTML, /id="twb2sCount"/);
  t.doesNotMatch(DESK_HTML, /id="twbStageOfferBtn"/);
  t.doesNotMatch(DESK_HTML, /id="twb2sDetailPanel"/);
  t.doesNotMatch(DESK_HTML, /id="twb2sDetailBody"/);
  t.doesNotMatch(DESK_HTML, /Staged Trades/);
  t.doesNotMatch(DESK_HTML, /Stage via War Room/);
  // The 3-way dropdown it used to sit beside is still there -- proves this is a targeted
  // removal, not an accidental deletion of the whole header offers bar.
  t.match(DESK_HTML, /id="twb3wDropdown"/);
  t.match(DESK_HTML, /3-Way Trades/);
  // The normal Submit Offer button is untouched.
  t.match(DESK_HTML, /id="twbSubmitOfferBtn"/);
  t.match(DESK_HTML, />Submit Offer</);
});

// ───────────────────────── MOBILE: the real render(), run against a real worker ─────────────────────────
function world() {
  const env = makeWorkerEnv();
  const mfl = makeMfl({ tokens: { "tok-A": "0001" } });
  mfl.install();
  return { env, mfl };
}
// Mirrors tests/trade_loaded_contract_clients.test.mjs's loadMobileForAccept harness: the REAL
// trade.js source, run whole in a VM, against the REAL worker (fetch is never stubbed/faked at
// the client layer -- only MFL itself is stubbed, at the edge).
function loadMobileApp(env, { incoming, outgoing } = {}) {
  const log = [];
  const registry = {};
  const app = makeEl("ups-m-app");
  app.insertAdjacentHTML = (pos, html) => {
    for (const m of html.matchAll(/id="([a-zA-Z0-9-]+)"/g)) {
      if (registry[m[1]]) continue;
      const el = makeEl(m[1]);
      el.remove = () => { delete registry[m[1]]; };
      registry[m[1]] = el;
    }
    const overlayMatch = html.match(/id="([a-zA-Z0-9-]+-overlay)"/);
    if (overlayMatch) { registry[overlayMatch[1]].innerHTML = html; }
  };
  const mount = makeEl("ups-m-main");
  const U = {
    pad4: (v) => { const dd = String(v || "").replace(/\D/g, ""); return dd ? dd.padStart(4, "0").slice(-4) : ""; },
    safeStr: (v) => (v == null ? "" : String(v).trim()), safeInt: (v, dft) => { const n = parseInt(v, 10); return isFinite(n) ? n : (dft == null ? 0 : dft); },
    escapeHtml: (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
    fmtUsd: (n) => "$" + n,
  };
  const M = {
    util: U, data: {}, actions: { reloadData: async () => {} },
    api: { workerUrl: (p) => "https://worker.test" + p, getStoredMflUserId: () => "tok-A" },
    state: { ctx: { leagueId: "74598", year: "2026" }, viewerFranchiseId: "0001", franchises: [{ franchise_id: "0001", name: "L.A. Looks" }, { franchise_id: "0002", name: "CBP" }],
      tradeOffers: { incoming: incoming || [], outgoing: outgoing || [] } },
    ui: { showToast: () => {} },
    route: { renderRoute: () => M.tradeView.render(mount, []), navigate() {} },
  };
  const doc = {
    getElementById: (elId) => (elId === "ups-m-app" ? app : registry[elId] || null),
    body: { style: {} },
  };
  const sandbox = { fetch: workerFetch(env, log), console, setTimeout, Promise, URL, encodeURIComponent, decodeURIComponent, isFinite, parseInt, String, Number, JSON, Object, Array, Date, Math, document: doc };
  sandbox.window = sandbox; sandbox.UPS_MOBILE = M; sandbox.UPS_TRADE_3WAY = T;
  vm.createContext(sandbox);
  vm.runInContext(MOBILE_SRC, sandbox, { filename: "site/m/views/trade.js" });
  return { M, mount, registry, log, doc };
}

test("MOBILE: the real render() of the main trade list never writes 'Staged Trades' or any staged-section markup into the DOM, and never fetches the staged-2way endpoint", async () => {
  const { env } = world();
  const app = loadMobileApp(env, { incoming: [{ trade_id: "9001", offered_by: "0002", will_give_up: "100,", will_receive: "200," }], outgoing: [] });
  app.M.tradeView.render(app.mount, []);
  // Let any still-pending promises from render() settle (3-way list load, offers, etc.) and
  // re-render once more, the same way a real route change would -- the staged section must stay
  // absent across a settle + re-render, not just on the very first synchronous paint.
  await new Promise((r) => setTimeout(r, 30));
  app.M.tradeView.render(app.mount, []);
  await new Promise((r) => setTimeout(r, 30));

  const html = app.mount.innerHTML;
  t.doesNotMatch(html, /Staged Trades/, "the list header text never renders");
  t.doesNotMatch(html, /ups-m-pos-group[^>]*>Staged/, "no staged position-group block renders");
  t.doesNotMatch(html, /tw2sdetailid|data-tw2s-act/i, "no staged-card markup renders");
  // The 3-way section it used to sit beside is untouched -- a real section, proving this is a
  // targeted removal of ONE section's injection, not a broken render() that dropped everything.
  t.match(html, /ups-m-3w-open|Build 3-way/i, "the 3-way builder entry point still renders");
  // Real network behavior: no call to the staged-2way list endpoint happened at all, on EITHER
  // render pass -- not just "the section is hidden," the fetch that used to populate it never
  // fires anymore.
  const stagedCalls = app.log.filter((r) => r.path.indexOf("/api/trades/2way") !== -1);
  t.deepEqual(stagedCalls, [], "zero requests to the staged-2way endpoint from a normal page load");
});

test("MOBILE: the real render() of an EMPTY offers/3-way state still never shows Staged Trades (not just hidden behind other content)", async () => {
  const { env } = world();
  const app = loadMobileApp(env, { incoming: [], outgoing: [] });
  app.M.tradeView.render(app.mount, []);
  await new Promise((r) => setTimeout(r, 30));
  app.M.tradeView.render(app.mount, []);
  const html = app.mount.innerHTML;
  t.doesNotMatch(html, /Staged Trades/);
  t.doesNotMatch(html, /data-tw2s-act/i);
});

test("MOBILE: a stale #league/trade/2s/<id> deep link (an old bookmark or chat link) no longer opens a staged detail view -- it falls through to the normal list, never throws", async () => {
  const { env } = world();
  const app = loadMobileApp(env, {});
  // parts[0] === "2s" used to route to renderStaged2WayDetail(mount, parts[1]) -- it must now
  // behave exactly like any other unrecognized route segment: render the normal list, not throw,
  // not show a staged detail.
  app.M.tradeView.render(app.mount, ["2s", "some-old-id"]);
  await new Promise((r) => setTimeout(r, 30));
  const html = app.mount.innerHTML;
  t.doesNotMatch(html, /Staged Trade\b/);
  t.doesNotMatch(html, /Held server-side/);
  t.match(html, /ups-m-3w-open|Build 3-way/i, "fell through to the normal trade list");
});

await run("trade_staged_ui_hidden_from_owners");
restore();
