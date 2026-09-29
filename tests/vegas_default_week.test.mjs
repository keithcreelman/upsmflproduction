// /api/vegas defaulted to weeks[0] -- the EARLIEST week with a posted line
// in nflverse's games.csv, which keeps every week's line forever (past and
// future alike, since a line is set before kickoff and the row is never
// removed). That earliest week is always week 1, so the default never
// advanced past it all season. Verified live 2026-09-29: with no W= param,
// the API returned week:1 despite weeksWithLines: [1,2,3,4] -- the Vegas
// Implied Points board's own masthead calls it "the cleanest public read on
// how many points a real offense is expected to score", which is inherently
// about the UPCOMING week, not three-plus-weeks-stale lines.
//   node tests/vegas_default_week.test.mjs
import fs from "fs";
import assert from "assert";

const SRC = fs.readFileSync("worker/src/index.js", "utf8");
let fails = 0;
const check = (n, fn) => { try { fn(); console.log("  ok   " + n); }
  catch (e) { fails++; console.log("  FAIL " + n + "\n         " + e.message); } };

const rStart = SRC.indexOf('if (path === "/api/vegas"');
const rEnd = SRC.indexOf('if (path === "/api/auction/fa-pool"', rStart);
const route = rStart > 0 && rEnd > rStart ? SRC.slice(rStart, rEnd) : "";

console.log("anchors hold (else everything below is vacuous)");
check("route slice is substantial", () => {
  assert.ok(route.length > 500, `slice is ${route.length} chars`);
});

console.log("\n1. the default week is the LATEST with a posted line, not the earliest");
check("wk defaults to weeks[weeks.length - 1], not weeks[0]", () => {
  assert.match(route, /const wk = wReq \|\| weeks\[weeks\.length - 1\] \|\| 1;/);
  assert.ok(!/const wk = wReq \|\| weeks\[0\] \|\| 1;/.test(route), "the old earliest-week default must be gone, not just supplemented");
});
check("weeks is still sorted ascending (so [0] is earliest and [length-1] is latest, unambiguously)", () => {
  assert.match(route, /weeks = Object\.keys\(weeksSet\)\.map\(Number\)\.sort\(\(a, b\) => a - b\)/);
});
check("an explicit W= request param still wins over any default (wReq checked first)", () => {
  assert.match(route, /const wk = wReq \|\|/);
});

console.log("\n2. regression check against the live symptom (2026-09-29)");
function pickDefaultWeek(weeksWithLines, wReq) {
  const weeks = weeksWithLines.slice().sort((a, b) => a - b);
  return wReq || weeks[weeks.length - 1] || 1;
}
check("weeksWithLines [1,2,3,4] with no W= param -> defaults to 4 (the live case), not 1", () => {
  assert.strictEqual(pickDefaultWeek([1, 2, 3, 4], 0), 4);
});
check("an explicit W=2 still returns week 2 regardless of what's latest", () => {
  assert.strictEqual(pickDefaultWeek([1, 2, 3, 4], 2), 2);
});
check("preseason / no lines posted yet -> falls back to week 1, not undefined or 0", () => {
  assert.strictEqual(pickDefaultWeek([], 0), 1);
});

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
