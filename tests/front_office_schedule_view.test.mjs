// Front Office → Roster → Players → Schedule: the choice sits beside Performance and Contract; ONE /api/fantasy-sos?season=<season>&v=2
// read feeds the whole view (never per player or per week; no position parameter); no D1 query; no easy/tough or forecast wording.
//   node tests/front_office_schedule_view.test.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const HTML = read("site/rosters/v2/front_office.html"), RO = read("site/rosters/v2/fo_roster.js"), DA = read("site/rosters/v2/fo_data.js"), LD = read("site/rosters/fo_embed_loader.js");
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("Schedule is the third Roster-columns choice, after Performance and Contract, in the Front Office choice style", () => {
  const chips = [...HTML.matchAll(/data-colset="(\w+)"/g)].map((m) => m[1]);
  t.equal(JSON.stringify(chips), JSON.stringify(["perf", "contract", "sched"]));
  t.ok(/<div class="fo-subview-chips fo-choice" id="fo-colset"/.test(HTML), "same choice group as the other two");
  t.ok(/id="fo-sched-wrap"[^>]*hidden/.test(HTML), "its own container, hidden until chosen");
});
test("the shared module loads before the roster view, in the page and in the MFL embed", () => {
  t.ok(HTML.indexOf("player_schedule.js") > 0 && HTML.indexOf("player_schedule.js") < HTML.indexOf("fo_roster.js"));
  t.ok(LD.indexOf('"shared/player_schedule.js"') > 0 && LD.indexOf('"shared/player_schedule.js"') < LD.indexOf('"rosters/v2/fo_roster.js"'));
});
test("ONE read for the whole view: /api/fantasy-sos?season=<active season>&v=2, no position, no per-player or per-week request", () => {
  const src = DA.match(/SOURCES\.sos = function \(\) \{[\s\S]*?\n  \};/)[0];
  t.ok(/"\/api\/fantasy-sos\?season=" \+ encodeURIComponent\(cfg\.season\) \+ "&v=2"/.test(src), "the URL");
  t.ok(!/pos=|&W=|week/i.test(src), "no position or week parameter");
  t.ok(!/no-store/.test(src), "the browser's cache may serve it");
  const calls = (code(RO).match(/DATA\.load\("sos"/g) || []).length;
  t.ok(calls >= 1 && !/DATA\.load\("sos",/.test(code(RO)), "the roster view only ever loads the single 'sos' entry (no argument per player or week)");
  t.ok(!/fetch\(/.test(code(RO)), "the roster view makes no request of its own");
  t.ok(!/fantasy-sos/.test(code(RO)), "and does not build another URL");
});
test("no D1, no write, no forecast wording in the new code", () => {
  const mine = code(read("site/shared/player_schedule.js")) + code(RO.slice(RO.indexOf("// ── Schedule (Roster"), RO.indexOf("function wirePerf")));
  t.ok(!/D1|prepare\(|POST|PUT|PATCH|DELETE|method:/.test(mine), "read-only, no database");
  t.ok(!/\b(easy|easier|tough|tougher|smash|forecast|projected|will score)\b/i.test(mine.replace(/it is not a forecast/gi, "")), "no easy/tough or forecast claims (apart from saying it is not one)");
  t.ok(/allowed so far/i.test(RO) && /not a forecast/.test(RO), "labelled 'allowed so far' with the not-a-forecast line");
});
test("players are rows and league weeks are columns; Next 5 is a fixed five-week grid; Rest of season is ONE sideways-scrolling grid with the player column pinned", () => {
  const body = code(RO), css = read("site/rosters/v2/front_office.css");
  t.ok(/'<th scope="col" class="num" title="League week ' \+ w \+ '">W' \+ w/.test(body), "week columns are headed W8, W9, …");
  t.ok(/'<th scope="row" class="fo-sched-who">'/.test(body), "a player's name heads his row");
  t.ok(!/P\.chunk|schedBlock/.test(body), "no repeated five-week blocks");
  t.ok(/var scroll = sched\.mode === "rest";/.test(body) && /schedGrid\(wl\.weeks, items, multi, FO\.groupByPosition\(\), scroll\)/.test(body), "one grid over all remaining weeks, scrolling only in rest mode");
  t.ok(/fo-sched-scroll" tabindex="0" role="region" aria-label="[^"]*swipe sideways/.test(body), "a focusable, labelled scroll region that says it swipes");
  t.ok(/swipe sideways for later weeks\. The player column stays in place/.test(body), "a visible hint line");
  t.ok(/data-left="0" data-right="1"/.test(body) && /fo-sched-fade-r/.test(body) && /fo-sched-fade-l/.test(body), "edge shadows that show when more weeks are hidden");
  t.ok(/\.fo-sched-scroll \{[^}]*overflow-x: auto/.test(css), "the box scrolls its own overflow");
  t.ok(/\.fo-sched-wide \.fo-sched-whohead, \.fo-sched-wide \.fo-sched-who \{ position: sticky; left: 0/.test(css), "the player column is sticky");
  t.ok(/table-layout: fixed/.test(css), "fixed layout");
});
test("each week cell shows the opponent, the prominent vs-usual %, points allowed per game and rank IN the cell; the full explanation is a tap and keyboard detail panel, not a hover title", () => {
  const body = code(RO), css = read("site/rosters/v2/front_office.css");
  t.ok(/fo-sched-opp[\s\S]{0,200}fo-sched-pct[\s\S]{0,200}fo-sched-sub[\s\S]{0,120}fo-sched-sub/.test(body), "opponent, percentage, per game, rank");
  t.ok(/P\.allowedCompact\(a\)/.test(body) && /cp\.pct/.test(body) && /cp\.pg/.test(body) && /cp\.rank/.test(body), "the compact labels come from the shared module");
  t.ok(/'<button type="button" class="fo-sched-btn" data-sched-cell="'/.test(body), "each week with a game is a real button (tap, Enter, Space)");
  t.ok(!/title="' \+ H\.esc\(tip\)/.test(body) && !/\btip\b/.test(body), "no hover-only tooltip carries the information");
  t.ok(/H\.openDialog\(d\.title, html, \{ returnFocus: function \(\) \{ return btn; \} \}\)/.test(body) && /P\.detail\(e\.data, rec\.cell, rec\.pos, rec\.p\.name\)/.test(body), "the detail panel is the Front Office dialog, focus returns to the cell");
  t.ok(/P\.tone\(a\)/.test(body) && /fo-sched-more/.test(body) && /fo-sched-less/.test(body), "tone from the shared rule");
  t.ok(/\.fo-sched-btn:focus-visible/.test(css) && /\.fo-sched-wide \{ --sw-name: 96px; --sw-col: 70px;/.test(css), "visible focus; wider columns inside the scrolling box");
  for (const s of ["Green: that opponent has allowed 10% or more above usual", "Red: it has allowed 10% or more below usual", "No color: within 9% of usual, fewer than 3 games counted, or no number yet", "@ = away game", "BYE = bye week", "/g</b> = points it has allowed per game", "Tap a week for kickoff and the full explanation"]) t.ok(RO.includes(s), s);
  t.ok(/allowed so far/i.test(RO) && /not a forecast/.test(RO) && !/\b(easy|tough)\b/i.test(code(RO).replace(/never "easy"/g, "")), "past points allowed, not a forecast, no easy/tough");
});
test("missing data is handled in words", () => {
  for (const s of ["No NFL team is listed", "is not in the schedule data", "No game listed", "No number yet", "couldn’t be read", "have no numbers yet", "BYE"]) t.ok(RO.includes(s), s);
});
await run("front_office_schedule_view");
