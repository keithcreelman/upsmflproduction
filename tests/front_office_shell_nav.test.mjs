// Front Office shell (#1338): six destinations, every section reachable, deep links, the ONE War Room route,
// season from data (never hard-coded), About is a real dialog, and the embed loads the new views in order.
//   node tests/front_office_shell_nav.test.mjs
//   FO_JS=<path> FO_HTML=<path> node tests/front_office_shell_nav.test.mjs   (defect check against other copies)
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FO = fs.readFileSync(process.env.FO_JS || path.join(ROOT, "site/rosters/v2/front_office.js"), "utf8");
const HTML = fs.readFileSync(process.env.FO_HTML || path.join(ROOT, "site/rosters/v2/front_office.html"), "utf8");
const LDR = fs.readFileSync(path.join(ROOT, "site/rosters/fo_embed_loader.js"), "utf8");
const HUB = fs.readFileSync(path.join(ROOT, "site/rosters/v2/fo_hub.js"), "utf8");

function sliceFn(src, sig) {
  const at = src.indexOf(sig);
  if (at < 0) throw new Error("not found: " + sig);
  let i = src.indexOf("{", at), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error("unbalanced: " + sig);
}
function sliceConst(src, name) {
  const at = src.indexOf("const " + name + " = ");
  if (at < 0) throw new Error("not found: const " + name);
  const open = src.indexOf("{", at);
  let i = open, depth = 0;
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}" && --depth === 0) break; }
  return src.slice(at, i + 1) + ";";
}
const nav = vm.createContext({});
vm.runInContext(sliceConst(FO, "NAV_GROUPS") + "\n" + sliceConst(FO, "NAV_DEFAULT") + "\n" + sliceFn(FO, "function navGroupOf(") +
  "\nthis.G = NAV_GROUPS; this.D = NAV_DEFAULT; this.groupOf = navGroupOf;", nav);

test("six destinations, in order, each with a default section", () => {
  const tabs = [...HTML.matchAll(/<nav class="fo-tabs"[^>]*>([\s\S]*?)<\/nav>/g)][0][1];
  const keys = [...tabs.matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1]);
  t.equal(JSON.stringify(keys), JSON.stringify(["overview", "roster", "market", "trades", "contracts", "moves"]));
  for (const k of keys) t.ok(nav.G[k] && nav.G[k].includes(nav.D[k]), k + " opens " + nav.D[k]);
  t.ok(/Trade War Room/.test(HTML) && /id="fo-war-room-link"/.test(HTML), "Trades carries the Trade War Room link");
});

test("every section on the page belongs to exactly one destination, and every destination section exists", () => {
  const sections = [...HTML.matchAll(/class="fo-section[^"]*" data-section="([a-z]+)"/g)].map((m) => m[1]);
  t.ok(sections.length >= 15, sections.length + " sections");
  for (const s of sections) t.ok(nav.groupOf(s), "section '" + s + "' is reachable");
  const all = Object.values(nav.G).flat();
  t.equal(new Set(all).size, all.length, "no section in two destinations");
  for (const s of all) t.ok(sections.includes(s), "destination section '" + s + "' exists on the page");
  t.ok(!/data-section="activity"/.test(HTML), "the hidden static-JSON Activity & Audit tab is gone");
  for (const sub of ["roster", "bye"]) t.ok(new RegExp('id="fo-roster-subnav"[\\s\\S]*?data-subtab="' + sub + '"').test(HTML), "Roster chip " + sub);
  for (const sub of ["cap", "myac", "picks", "saladj", "contractlog"]) t.ok(new RegExp('id="fo-contracts-subnav"[\\s\\S]*?data-subtab="' + sub + '"').test(HTML), "Contracts chip " + sub);
});

test("deep links: #fo=<section> opens that section; unknown values are ignored", () => {
  const c = vm.createContext({ window: { location: { hash: "" } } });
  vm.runInContext(sliceConst(FO, "NAV_GROUPS") + "\n" + sliceFn(FO, "function navGroupOf(") + "\n" + sliceFn(FO, "function readNavHash("), c);
  const read = (h) => { c.window.location.hash = h; return vm.runInContext("readNavHash()", c); };
  t.equal(read("#fo=cap"), "cap"); t.equal(read("#fo=bye"), "bye"); t.equal(read("#x=1&fo=market"), "market");
  t.equal(read("#fo=nope"), ""); t.equal(read(""), "");
  t.ok(/showSection\(readNavHash\(\) \|\| "overview"/.test(FO), "first view = the deep link, else Overview");
});

test("the War Room link is the Home button's route (MESSAGE6=N) with preselect keys in the hash", () => {
  const c = vm.createContext({ window: { location: { hostname: "www48.myfantasyleague.com", origin: "https://www48.myfantasyleague.com" } }, SEASON: "2026", LEAGUE_ID: "74598", encodeURIComponent });
  vm.runInContext(sliceFn(FO, "function warRoomUrl("), c);
  t.equal(vm.runInContext("warRoomUrl({})", c), "https://www48.myfantasyleague.com/2026/home/74598?MODULE=MESSAGE6=N");
  t.equal(vm.runInContext('warRoomUrl({ twb_left_team: "0008", twb_right_team: "0004", twb_give: "15711" })', c),
    "https://www48.myfantasyleague.com/2026/home/74598?MODULE=MESSAGE6=N#twb_left_team=0008&twb_right_team=0004&twb_give=15711");
  c.window.getWarRoomUrl = () => "https://www44.myfantasyleague.com/2026/home/74598?MODULE=MESSAGE6=N";
  t.ok(vm.runInContext("warRoomUrl({ twb_side: 'partner' })", c).startsWith("https://www44.myfantasyleague.com/2026/home/74598?MODULE=MESSAGE6=N#"), "the header's canonical URL wins");
  const trade = sliceFn(FO, "function wireActionsTab(");
  t.ok(/warRoomUrl\(params\)/.test(trade) && /twb_player_id: p\.id/.test(trade), "the panel's Trade button preselects the player");
});

test("no hard-coded season in the header; the subtitle comes from data", () => {
  t.ok(!/UPS League · 2026/.test(HTML), "no '· 2026' in the page");
  t.ok(/id="fo-subtitle"/.test(HTML) && /sub\.textContent = \(vt \? vt\.name \+ " · " : ""\) \+ SEASON \+ " season"/.test(FO), "subtitle = team · season");
  t.ok(!/Click for module changelog/.test(HTML), "no promise of a changelog the badge never opened");
});

test("About is a real dialog: labelled, focus moves in and returns, Esc closes, Tab stays inside", () => {
  t.ok(/role="dialog" aria-modal="true" aria-labelledby="fo-about-title"/.test(HTML));
  const about = sliceFn(HUB, "function setupAbout(");
  t.ok(/e\.key === "Escape"/.test(about) && /e\.key === "Tab"/.test(about), "Esc + focus trap");
  t.ok(/panel\.focus\(\)/.test(sliceFn(HUB, "function openAbout(")) && /__opener\.focus\(\)/.test(sliceFn(HUB, "function closeAbout(")), "focus in, focus back");
});

test("a destination whose view isn't built says so; the ledger's own tabs are never overwritten", () => {
  t.ok(/\["overview", "bye", "market", "trades", "picks", "moves"\]\.indexOf\(sec\) === -1\) return/.test(HUB));
});

test("the embed loads the views after their data and models, before front_office.js", () => {
  const order = ["rosters/v2/fo_data.js", "shared/trade_fit.js", "shared/bye_planner.js", "rosters/v2/fo_hub.js", "rosters/v2/fo_overview.js", "rosters/v2/front_office.js"];
  const at = order.map((f) => LDR.indexOf('"' + f + '"'));
  t.ok(at.every((x) => x > 0), "all listed");
  t.ok(at.every((x, i) => i === 0 || at[i - 1] < x), "in order");
  for (const f of ["trade_fit.js", "bye_planner.js", "fo_hub.js", "fo_overview.js"]) t.ok(HTML.includes(f), "standalone page loads " + f);
});

await run("front_office_shell_nav");
