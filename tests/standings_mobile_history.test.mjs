// The phone's finished seasons after Keith's decision 2 correctness items (#1329 comment 6298376269), on REAL recorded
// responses (the #1330 worker on the read-only D1 snapshot of 2026-10-17):
//   1. 2025 Weekly: Week 17's three mismatched games hold back Week 17 only, and the message says so plainly;
//   2. Playoffs: a side whose rounds don't fit today's format, or whose drawn champion isn't the recorded one, is listed
//      by week with the recorded champion (2010-2015 Hawk Tuah sides, 2011-2013 UPS sides); 2016 on draw as before.
//   node scripts/safe_tests/run.mjs --only standings_mobile_history
import fs from "node:fs";
import vm from "node:vm";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { settle } from "./fixtures/standings_v2_page.mjs";

const BR = JSON.parse(fs.readFileSync(new URL("./fixtures/playoff_brackets_recorded.json", import.meta.url), "utf8")).brackets;
const S2025 = fs.readFileSync(new URL("./fixtures/standings_2025_recorded.json", import.meta.url), "utf8");
const RACE_SRC = fs.readFileSync(new URL("../site/shared/standings_race.js", import.meta.url), "utf8");
const APP_SRC = fs.readFileSync(new URL("../site/m/app.js", import.meta.url), "utf8");
const plain = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ");
const utilSrc = ["safeStr", "safeInt", "pad4", "escapeHtml", "asArray"].map((name) => {
  const m = new RegExp(`\\n  function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}\\n|\\n  function ${name}\\([^)]*\\) \\{[^\\n]*\\}\\n`).exec(APP_SRC);
  if (!m) throw new Error("app.js: no " + name);
  return m[0];
}).join("");
const stubStandings = (y) => ({ ok: true, year: Number(y), standings_basis: "recorded_final_standings", season_complete: true, preseason: false, weekly: [], weeklyScores: [],
  rows: BR[y].seeds.map((s) => ({ franchise_id: s.franchise_id, franchise_name: s.franchise_name, owner_name: s.owner_name || "" })) });

async function boot() {
  const views = {};
  const mount = { innerHTML: "", querySelectorAll: () => [], querySelector: () => null, addEventListener() {} };
  const M = { state: { ctx: { year: 2026 }, viewerFranchiseId: "0008", franchises: [] }, api: { workerUrl: (p) => "https://w.test" + p }, data: {},
    route: { registerView: (n, fn) => (views[n] = fn), renderRoute: () => views.league(mount, ["standings"]), navigate() {} } };
  const json = (j, status) => ({ ok: (status || 200) < 400, status: status || 200, json: async () => j });
  const fetch = async (url) => {
    const u = new URL(url, "https://keithcreelman.github.io");
    const y = u.searchParams.get("year");
    if (u.pathname === "/api/playoff-bracket" && BR[y]) return json(BR[y]);
    if (u.pathname === "/api/standings" && y === "2025") return json(JSON.parse(S2025));
    if (u.pathname === "/api/standings" && BR[y]) return json(stubStandings(y));
    if (u.pathname === "/api/historical-finishes") return json({ ok: true, rows: [] });
    return json(null, 404);
  };
  const document = { getElementById: () => null, addEventListener() {}, body: { style: {} }, activeElement: null };
  const ctx = { window: { UPS_MOBILE: M }, document, fetch, console, setTimeout, clearTimeout, Promise, URL, Date, Math, JSON };
  vm.createContext(ctx);
  vm.runInContext(utilSrc + "window.UPS_MOBILE.util = { safeStr, safeInt, pad4, escapeHtml, asArray, fmtUsd: function (n) { return '$' + n; } };", ctx);
  vm.runInContext(RACE_SRC.replace("(typeof window !== 'undefined' ? window : this)", "(window)"), ctx);
  vm.runInContext(fs.readFileSync(new URL("../site/m/standings_sheets.js", import.meta.url), "utf8"), ctx);
  vm.runInContext(fs.readFileSync(new URL("../site/m/views/league.js", import.meta.url), "utf8"), ctx);
  const show = async (o) => { M.leagueView.setStandingsView(o); views.league(mount, ["standings"]); await settle(); M.route.renderRoute(); await settle(); M.route.renderRoute(); await settle(); return mount.innerHTML; };
  return { show };
}

test("2014 Hawk Tuah Bowl: listed by week, recorded champion Pure Greatness, no pick lines from a wrong bracket", async () => {
  const b = await boot();
  const html = await b.show({ mode: "playoffs", side: "hawk", year: 2014 });
  const p = plain(html);
  t.match(p, /Final results, by week\. 2014’s toilet bracket doesn’t follow today’s rounds, so its games are listed by week\./);
  t.match(p, /🚽 Hawk Tuah Bowl champion Pure Greatness · recorded final standings/);
  t.match(p, /2014’s toilet bracket used an older format than today’s, so its games are listed by week below\./, "the intro no longer claims today's byes and pick");
  t.match(p, /Week 14 .* Week 15 .* Week 16/);
  t.ok(!/Hawk Tuah Bowl final|pick 1\.01/.test(p), "no drawn final, no draft-pick line");
  t.equal((html.match(/class="ups-m-bk-game/g) || []).length, 7, "all seven games");
});
test("2013 UPS side: the seeds don't form a bracket, so its games are split by recorded finish; champion DBCA", async () => {
  const b = await boot();
  const p = plain(await b.show({ mode: "playoffs", side: "champ", year: 2013 }));
  t.match(p, /2013’s recorded seeds don’t form a bracket, so its games are listed by week \(split by the recorded final standings\)\./);
  t.match(p, /🏆 UPS champion DBCA · recorded final standings/);
  t.ok(!/Playoff bracket data unavailable/.test(p));
});
test("2010 Hawk Tuah Bowl: no champion marked (the loser advanced); 2011 UPS side (conference bracket): by week", async () => {
  const b = await boot();
  t.match(plain(await b.show({ mode: "playoffs", side: "hawk", year: 2010 })), /None marked: 2010’s toilet bracket had the loser advance\./);
  t.match(plain(await b.show({ mode: "playoffs", side: "champ", year: 2011 })), /2011’s bracket doesn’t follow today’s rounds, so its games are listed by week\. 🏆 UPS champion Blake Bombers/);
});
test("Seasons that fit today's rounds still draw their bracket: 2014 UPS side, 2019 and 2025 both sides", async () => {
  const b = await boot();
  for (const [y, side, title] of [[2014, "champ", "Championship"], [2019, "champ", "Championship"], [2019, "hawk", "Hawk Tuah Bowl final"], [2025, "champ", "Championship"], [2025, "hawk", "Hawk Tuah Bowl final"]]) {
    const p = plain(await b.show({ mode: "playoffs", side, year: y }));
    t.ok(p.includes(title) && !p.includes("Final results, by week"), y + " " + side + " draws");
  }
});
test("2025 Weekly: Week 14 is ranked; Week 17 says exactly what's wrong and that the other weeks are fine", async () => {
  const b = await boot();
  const p14 = plain(await b.show({ mode: "weekly", year: 2025, week: 14 }));
  t.match(p14, /Week 14 top score:/);
  t.ok(!/can’t be shown|couldn’t be verified/.test(p14));
  const p17 = plain(await b.show({ mode: "weekly", year: 2025, week: 17 }));
  t.match(p17, /Week 17 can’t be shown\. Week 17: 3 game scores don’t match the teams’ final weekly scores\. The other weeks are unaffected\./);
  t.ok(!/Week 14 can|Week 14 couldn/.test(p17));
});

await run();
