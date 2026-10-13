// Desktop Stats workbench → Fantasy Points Against: opens on QB; weeks run 1 → the league's own last
// week for the shown season (17 now, 16 in 2017–2020, from the API's season.endWeek; never 18);
// "To wk" defaults to Latest game (no week_max: Full season through the latest completed game, as on
// mobile); the header names the weeks actually counted. The real page code (esc … renderShell) runs
// in node:vm on a tree DOM with fetch answered from the 2026-10-12 fixture.
//   node tests/desktop_pts_agst_defaults.test.mjs
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert";
import { makeDocument, settle } from "./fixtures/tree_dom.mjs";

const HTML = fs.readFileSync(new URL("../site/stats_workbench/stats_workbench.html", import.meta.url), "utf8");
const FX = JSON.parse(fs.readFileSync(new URL("./fixtures/mobile_pts_agst_2026_10_12.json", import.meta.url), "utf8"));
const start = HTML.indexOf("    function esc(s){", HTML.indexOf("Fantasy Points Against (Stats sub-tab)"));
const end = HTML.indexOf("    function notifyResize(){", start);
assert.ok(start > 0 && end > start, "the desktop Pts Agst block must be found");
const CODE = HTML.slice(start, end);

let fails = 0;
const check = async (n, fn) => { try { await fn(); console.log("  ok   " + n); } catch (e) { fails++; console.log("  FAIL " + n + "\n         " + (e && e.message)); } };

// A finished 16-week season (2019), from the fixture's shape.
const Y2019 = JSON.parse(JSON.stringify(FX.list_auto));
Y2019.year = "2019"; Y2019.weeksUsed = Array.from({ length: 16 }, (_, i) => i + 1);
Y2019.season = Object.assign({}, Y2019.season, { state: "complete", endWeek: 16, lastCompleteWeek: 16, latestFinalWeek: 16 });

function boot() {
  const doc = makeDocument();
  const host = doc.mount("asw-view-fpa");
  const requests = [];
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, Promise, URL, Math, JSON, String, parseInt });
  ctx.document = doc; ctx.window = ctx;
  ctx.fetch = (url) => {
    requests.push(String(url));
    const u = new URL(url), q = u.searchParams;
    const ok = (b) => Promise.resolve({ ok: true, status: 200, json: async () => b });
    if (u.pathname === "/api/league-years") return ok({ years: [{ season: 2026 }, { season: 2025 }, { season: 2019 }] });
    if (u.pathname === "/api/fantasy-points-against") {
      if (q.get("YEAR") === "2019") return ok(Y2019);
      return ok(q.get("week_max") === "4" ? FX.list_w4 : FX.list_auto);
    }
    if (u.pathname === "/api/fpa-detail") return ok(FX["detail_BUF_QB"] || { ok: true, weeks: [] });
    return new Promise(() => {});
  };
  vm.runInContext(
    "var host = document.getElementById('asw-view-fpa'); var THIS_YEAR = 2026; var API_BASE = 'https://w.test';" +
    "function notifyResize(){}\n" + CODE + "\nthis.__t = { fpa: fpa, renderShell: renderShell, load: load };", ctx);
  const T = ctx.__t;
  return {
    host, requests, T,
    async open() { T.renderShell(); T.load(); await settle(); await settle(); },
    pressed: () => host.querySelectorAll(".fpa-pos button").filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.getAttribute("data-pos")),
    opts: (cls) => host.querySelector(cls).querySelectorAll("option").map((o) => o.getAttribute("value")),
    sub: () => (host.querySelector(".fpa-sub") || {}).textContent || "",
    lists: () => requests.filter((r) => /fantasy-points-against/.test(r)),
  };
}

console.log("desktop Pts Agst: defaults and weeks");
{
  const v = boot();
  await v.open();
  await check("opens on QB (only the QB chip pressed)", () => assert.deepStrictEqual(v.pressed(), ["QB"]));
  await check("the first read is Full season through the latest completed game (no week_max)", () => {
    const r = v.lists()[0]; assert.ok(/YEAR=2026&week_min=1$/.test(r), r);
  });
  await check("From wk runs 1–17; To wk is 'Latest game' then 1–17; no Week 18", () => {
    assert.deepStrictEqual(v.opts(".fpa-wmin"), Array.from({ length: 17 }, (_, i) => String(i + 1)));
    assert.deepStrictEqual(v.opts(".fpa-wmax"), ["0"].concat(Array.from({ length: 17 }, (_, i) => String(i + 1))));
    assert.strictEqual(v.host.querySelector(".fpa-wmax").querySelectorAll("option")[0].textContent, "Latest game");
    assert.strictEqual(v.host.querySelector(".fpa-wmax").value, "0");
  });
  await check("the header names the weeks counted: '2026 · weeks 1–5, through the latest completed game · rank 1 = most generous to QB'", () => {
    assert.ok(/^2026 · weeks 1–5, through the latest completed game · rank 1 = most generous to QB/.test(v.sub()), v.sub());
  });
  const ys = v.host.querySelector(".fpa-year"); ys.value = "2019"; ys.dispatch("change"); await settle(); await settle();
  await check("a 16-week season (2019): both pickers become 1–16, header 'weeks 1–16'", () => {
    assert.deepStrictEqual(v.opts(".fpa-wmin"), Array.from({ length: 16 }, (_, i) => String(i + 1)));
    assert.deepStrictEqual(v.opts(".fpa-wmax"), ["0"].concat(Array.from({ length: 16 }, (_, i) => String(i + 1))));
    assert.ok(/^2019 · weeks 1–16, through the latest completed game/.test(v.sub()), v.sub());
  });
  ys.value = "2026"; ys.dispatch("change"); await settle(); await settle();
  await check("back to 2026 (from cache): pickers return to 1–17", () => {
    assert.deepStrictEqual(v.opts(".fpa-wmin"), Array.from({ length: 17 }, (_, i) => String(i + 1)));
  });
  const to = v.host.querySelector(".fpa-wmax"); to.value = "4"; to.dispatch("change"); await settle(); await settle();
  await check("To wk 4 reads week_max=4 and the header says 'weeks 1–4' (no 'latest' wording)", () => {
    const r = v.lists().slice(-1)[0]; assert.ok(/week_min=1&week_max=4$/.test(r), r);
    assert.ok(/^2026 · weeks 1–4 · rank 1/.test(v.sub()), v.sub());
  });
  to.value = "0"; to.dispatch("change"); await settle(); await settle();
  v.host.querySelector('.fpa-team-row[data-team="BUF"]').click(); await settle(); await settle();
  await check("a team's breakdown reads the same window (Latest: no week_max)", () => {
    const r = v.requests.filter((x) => /fpa-detail/.test(x)).slice(-1)[0]; assert.ok(/team=BUF&pos=QB&week_min=1$/.test(r), r);
  });
  await check("picking DL keeps DL (no reset to QB)", async () => {
    v.host.querySelector(".fpa-back") && v.host.querySelector(".fpa-back").click(); await settle();
    v.host.querySelector('.fpa-pos button[data-pos="DL"]').click(); await settle();
    assert.deepStrictEqual(v.pressed(), ["DL"]);
  });
}
await check("no 'w <= 18' week loop and no wkMax: 18 default remain in the page's Pts Agst block", () => {
  assert.ok(!/w <= 18/.test(CODE) && !/wkMax: 18/.test(CODE));
});
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
