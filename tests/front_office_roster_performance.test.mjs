// Roster → Performance and the Bye planner screen (#1338): every column is defined, the projection is labelled as a
// projection with its week, MFL's schedule and projections are read as MFL sends them (a blank projection is "none",
// never 0), the bye grid covers all 18 slots once, and the season line is the shared (phone) one.
//   node tests/front_office_roster_performance.test.mjs
//   FO_ROSTER_JS=<path> node tests/front_office_roster_performance.test.mjs   (defect check against another copy)
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(process.env.FO_ROSTER_JS || path.join(ROOT, "site/rosters/v2/fo_roster.js"), "utf8");
const FX = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/mfl_week7_schedule_projections_2026.json"), "utf8"));
const ctx = vm.createContext({ document: { addEventListener() {} } });
ctx.window = ctx;
vm.runInContext(fs.readFileSync(path.join(ROOT, "site/m/front_office_lineup.js"), "utf8"), ctx);
vm.runInContext(SRC, ctx);
const R = ctx.UPS_FO_ROSTER;

test("MFL's Week-7 schedule: opponent, home/away and kickoff per team; a team on a bye isn't listed", () => {
  const m = R.parseSchedule(FX.nflSchedule);
  t.equal(m.NEP.opp, "CHI"); t.equal(m.CHI.opp, "NEP"); t.equal(m.CHI.home, true); t.equal(m.NEP.home, false);
  t.equal(m.NEP.kickoff, 1792714500 * 1000, "kickoff from MFL (unix seconds → ms)");
  for (const bye of ["BUF", "JAC", "LAC", "WAS"]) t.equal(m[bye], undefined, bye + " (Week-7 bye) has no game");
  t.ok(Object.keys(m).length >= 26, Object.keys(m).length + " teams play");
});

test("projections: MFL's number as sent; a blank projection is none, never 0", () => {
  const p = R.parseProjections(FX.projectedScores);
  t.equal(p["16211"], 28.3); t.equal(p["16162"], 22.9);
  t.equal(p["99999"], undefined, "blank → no projection");
});

test("every Performance column is defined on screen; the projection says it's a projection and names its week", () => {
  const heads = [...SRC.matchAll(/th\("([a-z0-9]*)", ([^,]+), "([^"]*)"/g)].map((m) => ({ key: m[1], label: m[2], title: m[3] }));
  t.ok(heads.length >= 11, heads.length + " columns");
  for (const h of heads) if (h.label !== '"Player"') t.ok(h.title.length > 10, "column " + h.label + " has a definition");
  const proj = heads.find((h) => h.key === "proj");
  t.ok(/proj/.test(proj.label) && /forecast, not a result/.test(proj.title), "projection labelled, with its week, as a forecast");
  t.ok(/Wk " \+ week \+ " proj = MFL projection"/.test(SRC), "the basis line names the projection source");
  t.ok(/H\.seasonLine\(p\.id, 4\)/.test(SRC), "season numbers come from the shared (phone) season line");
  t.ok(!/PPG over the last 4[^"]*predict/.test(SRC) || /context only/i.test(SRC), "recent form is labelled context");
});

test("the bye grid covers the 18 starting slots exactly once", () => {
  const L = ctx.UPS_FRONT_OFFICE_LINEUP;
  const slots = R.ROWS.flatMap((r) => r.slots);
  t.equal(slots.length, 18);
  t.equal(new Set(slots).size, 18, "no slot twice");
  for (const s of L.LINEUP_SLOTS) t.ok(slots.includes(s.id), s.id + " is on the grid");
});

test("no write and no other season: the screen only reads", () => {
  t.ok(!/fetch\(/.test(SRC), "the view itself fetches nothing (fo_data.js does, GET only)");
  t.ok(!/method:\s*"POST"/.test(SRC));
  t.ok(/options, not recommendations/.test(SRC), "free agents for a short week are called options");
});

test("Bye planner shows the whole roster only: no Likely starters view or scope control (Keith 2026-10-26)", () => {
  const SRC_R = fs.readFileSync(path.join(ROOT, "site/rosters/v2/fo_roster.js"), "utf8");
  t.ok(!/>Likely starters</.test(SRC_R) && !/data-bye-scope/.test(SRC_R) && !/byeView\.scope/.test(SRC_R) && !/No likely starters are out/.test(SRC_R), "the Likely starters button, its handler and its filter are gone");
  t.ok(/Nobody is out\./.test(SRC_R) && /data-bye-week/.test(SRC_R) && /data-bye-pos/.test(SRC_R), "who's-out list, week and position controls stay");
});

await run("front_office_roster_performance");
