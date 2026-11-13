// The live Front Office's Rosters tab = the redesign's Roster view (#1338), and nothing else from the redesign.
//   node tests/front_office_roster_from_dev.test.mjs
//
// Keith 2026-11-13: swap only the Rosters page for the one built in the redesign. The other live tabs (Cap Planning,
// Contracts, Salary Adjustments, Misc, Activity) keep their code and styling. This pins that boundary.
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";

const read = (p) => fs.readFileSync(new URL("../" + p, import.meta.url), "utf8");
const html = read("site/rosters/v2/front_office.html");
const loader = read("site/rosters/fo_embed_loader.js");
const js = read("site/rosters/v2/front_office.js");
const css = read("site/rosters/v2/front_office.css");
const ROSTER_VIEW = ["shared/injury_status.js", "m/front_office_lineup.js", "m/season_scoring.js", "shared/player_facts.js",
  "rosters/v2/fo_data.js", "shared/bye_planner.js", "rosters/v2/fo_hub.js", "rosters/v2/fo_roster.js"];
const REDESIGN_ONLY = ["fo_overview.js", "fo_market.js", "fo_trades.js", "fo_trade_builder.js", "fo_activity.js", "fo_player_modal.js",
  "fo_cap_ledger.js", "trade_fit.js", "lineup_strength.js", "starter_mix.js", "trade_builder_core.js", "trade_rules.js"];

test("the live tabs are unchanged: Rosters, Cap Planning, Contracts, Salary Adjustments, Misc, Activity", () => {
  const tabs = [...html.slice(html.indexOf('id="fo-tabs"'), html.indexOf("</nav>", html.indexOf('id="fo-tabs"'))).matchAll(/data-tab="([^"]+)"[^>]*>([^<]+)</g)].map((m) => m[1] + ":" + m[2]);
  t.deepEqual(tabs, ["roster:Rosters", "cap:Cap Planning", "contracts:Contracts", "saladj:Salary Adjustments", "contractlog:Misc", "activity:Activity &amp; Audit"]);
  for (const sec of ["roster", "bye", "cap", "myac", "extensions", "restructure", "mym", "tag", "saladj", "contractlog", "activity"]) {
    t.ok(html.includes(`data-section="${sec}"`), `section ${sec}`);
  }
});

test("the Rosters tab carries the redesign's Roster view: Players (Performance | Contract) and the Bye planner", () => {
  t.match(html, /id="fo-roster-subnav"[\s\S]*data-subtab="roster"[^>]*>Players<[\s\S]*data-subtab="bye">Bye planner</);
  t.match(html, /id="fo-colset"[\s\S]*data-colset="perf"[\s\S]*data-colset="contract"/);
  t.ok(html.includes('id="fo-perf-wrap"') && html.includes('id="fo-contract-table-wrap"'), "both column sets");
  t.ok(html.includes('id="fo-roster-table"'), "the Contract column set is the live roster table");
  t.ok(html.includes('id="fo-about"') && html.includes('id="fo-about-btn"'), "About these numbers");
});

test("the Roster view's modules load before front_office.js, on the page and in the MFL embed, and nothing else from the redesign does", () => {
  const pageOrder = ROSTER_VIEW.map((p) => html.indexOf(p.replace(/^rosters\/v2\//, "")));
  t.ok(pageOrder.every((i) => i > 0), "every module is on the page");
  t.ok(pageOrder.every((i, k) => k === 0 || i > pageOrder[k - 1]), "in order");
  t.ok(pageOrder[pageOrder.length - 1] < html.indexOf("front_office.js?v="), "before front_office.js");
  const list = loader.slice(loader.indexOf("var rosterViewScripts"), loader.indexOf("];", loader.indexOf("var rosterViewScripts")));
  t.deepEqual([...list.matchAll(/"([^"]+\.js)"/g)].map((m) => m[1]), ROSTER_VIEW, "the embed loads the same list");
  t.match(loader, /injectScript\(masterCandidates, function \(\) \{\s*loadRosterView\(0, function \(\) \{\s*injectScript\(jsCandidates/, "before front_office.js in the embed");
  for (const f of REDESIGN_ONLY) {
    t.ok(!html.includes(f) && !loader.includes('"' + f) && !loader.includes("/" + f + '"'), `${f} is not loaded`);
  }
});

test("front_office.js gives the Roster view a read-only API and the four page events; no write route is added", () => {
  for (const ev of ["fo:ready", "fo:roster", "fo:tab", "fo:injury"]) t.ok(js.includes(`new CustomEvent("${ev}"`), ev);
  const api = js.slice(js.indexOf("function exposeFrontOfficeApi()"), js.indexOf("function setupSubviewChips()"));
  t.ok(api.length > 0, "the API");
  t.ok(!/fetch\(|postContractUpdate|method:\s*"POST"/.test(api), "the API reads only");
  const block = js.slice(js.indexOf("// ── Rosters tab = the Front Office redesign's Roster view"), js.indexOf("function setupSubviewChips()"));
  t.ok(!/fetch\(|POST|import\?/.test(block), "the added block makes no request of its own");
});

test("the CSS only appends: every selector before the Roster view block is unchanged from main's file", () => {
  const i = css.indexOf("/* ── Rosters tab = the Front Office redesign's Roster view (#1338)");
  t.ok(i > 0, "the appended block is marked");
  // nothing in the block redefines a selector the rest of the file uses for the other tabs
  const before = css.slice(0, i), after = css.slice(i);
  for (const sel of ["nav.fo-subtabs {", ".fo-subview-chip {", ".fo-subview-chips {", ".fo-group-row td {", ".fo-tabs", ".fo-table {"]) {
    t.ok(!after.includes("\n" + sel), `${sel} not redefined`);
  }
  t.ok(before.length > 40000, "the live stylesheet is intact above it");
});

await run("front_office_roster_from_dev");
