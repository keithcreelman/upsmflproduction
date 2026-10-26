// The desktop's 2025 views after Keith's decision 2 item 1 (#1329 comment 6298376269): the REAL desktop page on the
// REAL 2025 /api/standings response (tests/fixtures/standings_2025_recorded.json — three Week 17 games whose stored
// game scores differ from the teams' final weekly scores). Week 17 is the only week held back, and every message says
// which week and why, never "Week 14 couldn't be verified".
//   node scripts/safe_tests/run.mjs --only standings_desktop_2025_week17
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { loadStandingsPage, settle } from "./fixtures/standings_v2_page.mjs";

const S2025 = fs.readFileSync(new URL("./fixtures/standings_2025_recorded.json", import.meta.url), "utf8");
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ");
const WHY = "Week 17: 3 game scores don’t match the teams’ final weekly scores.";
function page(query) {
  const fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/api/standings" && u.searchParams.get("year") === "2025") return { ok: true, status: 200, json: async () => JSON.parse(S2025) };
    if (u.pathname === "/api/historical-finishes") return { ok: true, status: 200, json: async () => ({ ok: true, rows: [] }) };
    return { ok: false, status: 404, json: async () => ({ ok: false }) };
  };
  return loadStandingsPage({ query, fetch });
}

test("One week: Week 14 (the default for a finished season) is ranked; Week 17 says what's wrong and that the other weeks are fine", async () => {
  const p14 = page("view=weekly&year=2025&wv=week"); await settle();
  const h14 = text(p14.html());
  t.match(h14, /Week 14 top score:/);
  t.ok(!/Week 14 can’t be shown|Week 14 couldn’t be verified/.test(h14));
  const p17 = page("view=weekly&year=2025&week=17"); await settle();
  t.match(text(p17.html()), new RegExp("Week 17 can’t be shown\\. " + WHY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " The other weeks are unaffected\\."));
});
test("Heat map, all 17 weeks: 16 columns of ranks, P17 marked with the reason under the map", async () => {
  const p = page("view=weekly&year=2025&wv=heat&wkall=1"); await settle();
  const html = p.html(), h = text(html);
  t.ok(!/Heat map unavailable/.test(h));
  t.match(h, /ALL WEEKS, 17 WEEKS|all weeks, 17 weeks/i);
  t.match(h, /P17\*/);
  t.match(h, new RegExp("\\* P17 can’t be shown: " + WHY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " The other weeks are unaffected\\."));
  const reg = page("view=weekly&year=2025&wv=heat"); await settle();
  t.ok(!/can’t be shown/.test(text(reg.html())), "the regular season (Weeks 1-14) is untouched");
});
test("Team by week: Weeks 1-16 listed; P17 says it can't be shown and why", async () => {
  const p = page("view=weekly&year=2025&wv=team&team=0009"); await settle();
  const h = text(p.html());
  t.ok(!/Week by week couldn’t be verified/.test(h));
  t.match(h, new RegExp("P17 Can’t be shown: " + WHY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  t.match(h, /P16 \d+\.\d/, "Week 16 still shows its score");
});
test("Full League Scoring covers the regular season, so 2025 shows it", async () => {
  const p = page("view=league&year=2025&show=scored"); await settle();
  const h = text(p.html());
  t.ok(!/couldn’t be verified/.test(h));
  t.match(h, /POTENTIAL PF|Potential PF/i);
});

await run();
