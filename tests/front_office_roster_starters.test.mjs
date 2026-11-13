// Roster → Performance "Lineup" is the lineup each team SUBMITTED on MFL for the lineup week, not a model (Keith
// 2026-11-13: it showed a bench back ahead of the back he started). One flat list with a sortable Pos column; the
// Flat / By Position button is gone.
//   node tests/front_office_roster_starters.test.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const SRC = read("site/rosters/v2/fo_roster.js");
const ctx = vm.createContext({ document: { addEventListener() {} } });
ctx.window = ctx;
vm.runInContext(read("site/m/front_office_lineup.js"), ctx);
vm.runInContext(SRC, ctx);
const R = ctx.UPS_FO_ROSTER;

// The shape MFL sends for weeklyResults&W=N (synthetic ids): a trailing comma, and a team in two matchups.
const WR = { weeklyResults: { week: "10", matchup: [
  { franchise: [{ id: "0008", starters: "1,2,3,", player: [] }, { id: "0001", starters: "", player: [] }] },
  { franchise: [{ id: "0008", starters: "9,9,9,", player: [] }, { id: "0002", starters: "21,22,", player: [] }] }
] } };

test("MFL's weeklyResults: each team's submitted starters; the first matchup wins; a blank list is no lineup", () => {
  const s = R.parseStarters(WR);
  t.deepEqual(Array.from(s["0008"]), ["1", "2", "3"]);
  t.deepEqual(Array.from(s["0001"]), [], "no lineup submitted");
  t.deepEqual(Array.from(s["0002"]), ["21", "22"]);
  t.deepEqual(Object.keys(R.parseStarters({ weeklyResults: { franchise: { id: "7", starters: "5," } } })), ["0007"], "a single franchise node, padded id");
});

test("submitted starters land in slots the way the phone places a saved lineup; a bench RB is not a starter", () => {
  const pos = { 10: "QB", 11: "QB", 20: "RB", 21: "RB", 22: "RB", 30: "WR", 31: "WR", 32: "WR", 40: "TE", 41: "TE", 99: "RB" };
  const starters = { "0008": ["10", "11", "20", "21", "30", "31", "32", "40", "41"] };
  const slots = R.submittedSlots(starters, (pid) => pos[pid]);
  t.equal(slots["10"], "QB"); t.equal(slots["11"], "SuperFlex", "the second QB is the SuperFlex");
  t.equal(slots["20"], "RB"); t.equal(slots["21"], "RB");
  t.equal(slots["32"], "Flex"); t.equal(slots["41"], "Flex");
  t.equal(slots["99"], undefined, "a rostered back the owner did not start is Bench, whatever his PPG");
});

test("the Lineup column reads the submitted lineup (one MFL read per week), never the best-lineup model", () => {
  t.ok(/SOURCES\.lineups = weekSource\("weeklyResults"\)/.test(read("site/rosters/v2/fo_data.js")), "one weeklyResults&W= read");
  t.ok(!/likelySlots|BP\.plan\(\{ players: t\.players[^)]*fromWeek: week, toWeek: week/.test(SRC.slice(SRC.indexOf("function perfRows"), SRC.indexOf("function sortVal"))), "no model in perfRows");
  t.ok(/startersFor\(week\)/.test(SRC) && /submittedSlots\(starters, H\.groupOf\)/.test(SRC), "perfRows uses the submitted starters");
  t.ok(/"lineups"/.test(SRC.slice(SRC.indexOf("function loadFor"))), "loaded with the roster view");
});

test("one flat list: no By Position grouping or button; Pos is its own sortable column, not under the name", () => {
  const html = read("site/rosters/v2/front_office.html");
  t.ok(!/fo-group-toggle|data-group="position"|By Position/.test(html), "the button is gone");
  t.ok(/groupByPosition: false/.test(read("site/rosters/v2/front_office.js")), "the Contract table is flat too");
  t.ok(!/groupByPosition\(\)|fo-group-row/.test(SRC), "Performance never groups");
  t.ok(/th\("pos", "Pos"/.test(SRC) && /case "pos":/.test(SRC), "sortable Pos column");
  t.ok(!/H\.esc\(p\.position\) \+ " · "/.test(SRC), "position is no longer under the player's name");
});

await run("front_office_roster_starters");
