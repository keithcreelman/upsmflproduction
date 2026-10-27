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
  t.ok(!/\b(easy|easier|tough|tougher|smash|forecast|projected|will score)\b/i.test(mine.replace(/it is not a forecast/g, "")), "no easy/tough or forecast claims (apart from saying it is not one)");
  t.ok(/Allowed so far/.test(RO) && /not a forecast/.test(RO), "labelled 'Allowed so far' with the not-a-forecast line");
});
test("missing data is handled in words", () => {
  for (const s of ["No NFL team is listed", "is not in the schedule data", "No game listed", "No number yet", "couldn’t be read", "have no numbers yet", "Bye week"]) t.ok(RO.includes(s), s);
});
await run("front_office_schedule_view");
