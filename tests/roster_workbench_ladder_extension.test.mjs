// Roster Workbench extension eligibility — preseason WW/FCFS pickups must use
// the LADDER stage, not the in-season days-15-28 clock.
//   node tests/roster_workbench_ladder_extension.test.mjs
//
// THE DEFECT (found in review of PR #1136): rosterContractEligibility's
// extension check called UPS_CONTRACT_WINDOWS.standardExtensionWindow() for
// EVERY candidate, unconditionally. standardExtensionWindow's isWW branch
// only tests "acquired THIS season + a WW/FCFS-shaped acquisition label" — it
// has no idea whether the pickup happened BEFORE or AFTER Week 1 kickoff, so
// a genuinely PRE-season pickup (who is actually on the MYAC -> MYM ->
// Extension LADDER, resolved server-side) could land inside [acqDate+15,
// acqDate+28] by pure coincidence of the calendar and show as
// extension-eligible, even though his real, authoritative status (the ladder
// rung) is still "myac" or "mym" — extension hasn't opened for him yet.
//
// Fix: isPreseasonWwPickupRW(player) classifies a WW/FCFS player as
// pre-season ("yes") using Week 1's real kickoff instant (server-resolved via
// /api/league-events, the SAME source desktop/mobile already read — never
// recomputed independently). A "yes" gates extensionEligible on the ladder
// stage; "unknown" fails closed; "no" (or non-WW players entirely, including
// Dallas Goedert) falls through to the untouched off-ladder matrix.
//
// This test extracts and runs the ACTUAL functions from roster_workbench.js
// (not a hand-copied mirror), following the extractFn pattern already used by
// tests/tag_and_extension_canon.test.mjs. contractDeadlineYmdForSeason and
// tagDeadlineDateForSeason are stubbed (fixed return values) because they
// pull in this file's full season-events/offseason-meta machinery, which is
// not what this test is about — the real deadline matrix itself already has
// full coverage in tests/contract_windows_shared.test.mjs. Everything that
// decides ladder-vs-off-ladder routing is the REAL, unmodified source.
import fs from "fs";
import assert from "assert";

const RW_SRC = fs.readFileSync("site/rosters/roster_workbench.js", "utf8");
const CW_SRC = fs.readFileSync("site/shared/contract_windows.js", "utf8");

function extractFn(src, name) {
  const re = new RegExp("(?:function\\s+" + name + "\\s*\\()");
  const m = re.exec(src);
  assert.ok(m, "no " + name + " found in roster_workbench.js");
  let i = src.indexOf("{", m.index), depth = 0, j = i;
  for (; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (!depth) { j++; break; } }
  }
  return src.slice(m.index, j);
}

// Real shared module (the same file production loads), not a mirror.
const cwSandbox = {};
new Function("window", CW_SRC)(cwSandbox);
assert.ok(cwSandbox.UPS_CONTRACT_WINDOWS, "site/shared/contract_windows.js must define window.UPS_CONTRACT_WINDOWS");

const FNS = [
  "safeStr", "safeInt", "rookieLikeContractStatus", "parseContractLengthValue",
  "parseRookieOptionToken", "rookieOptionStateForPlayer", "rookieOptionActionEligible",
  "kickoffMsFromRW", "isPreseasonWwPickupRW", "contractLadderStageRW",
  "restructureWindowOpenRW", "currentYearInt", "rosterContractEligibility",
].map((name) => extractFn(RW_SRC, name)).join("\n");

const HARNESS = `
  var state = { ctx: { year: 2026 }, weekKickoffs: { 1: null, 3: null, 5: null }, contractLadderServer: null };
  // Stubbed on purpose — see file header. Fixed to the real 2026 deadline
  // (2026-09-06) so the off-ladder veteran/in-season branches under test
  // still behave realistically.
  function contractDeadlineYmdForSeason(season) { return "2026-09-06"; }
  function tagDeadlineDateForSeason(season) { return null; }
  ${FNS}
  return { rosterContractEligibility: rosterContractEligibility, state: state,
           isPreseasonWwPickupRW: isPreseasonWwPickupRW, contractLadderStageRW: contractLadderStageRW };
`;
const RW = new Function("window", HARNESS)(cwSandbox);

let fails = 0;
const check = (n, fn) => { try { fn(); console.log("  ok   " + n); }
  catch (e) { fails++; console.log("  FAIL " + n + "\n         " + e.message); } };

const DAY = 86400000;
// Real NFL Week 1 2026 kickoff: Wed 2026-09-09, 8:20pm ET (per front_office.js's
// own comment quoting this exact instant).
const WEEK1_KICKOFF_MS = Date.parse("2026-09-09T20:20:00-04:00");

function preseasonPickup(daysBeforeKickoff) {
  const acqMs = WEEK1_KICKOFF_MS - daysBeforeKickoff * DAY;
  return {
    years: 1, type: "Vet-WW", special: "CL 1|TCV 3K|AAV 3K", salary: 3000,
    acquisitionTypeLabel: "Waiver", acquisitionDate: new Date(acqMs).toISOString().slice(0, 10),
  };
}
function inSeasonPickup(daysSinceAcq) {
  // A fixed calendar day, well after Week 1 kickoff (Sept 9). standardExtensionWindow
  // reconstructs acqDate from the DATE STRING at noon ET internally — __nowMsForTest
  // must be computed from that SAME noon-ET instant, not an arbitrary precise moment,
  // or a UTC/ET day-boundary mismatch shifts every day-count test by up to a day.
  const acqDateOnly = "2026-09-14";
  const acqNoonEtMs = Date.parse(acqDateOnly + "T12:00:00-04:00");
  return {
    years: 1, type: "Vet-WW", special: "CL 1|TCV 3K|AAV 3K", salary: 3000,
    acquisitionTypeLabel: "Waiver", acquisitionDate: acqDateOnly,
    __nowMsForTest: acqNoonEtMs + daysSinceAcq * DAY,
  };
}

console.log("classification: isPreseasonWwPickupRW");
check('a pickup made 20 days before Week 1 kickoff classifies "yes" (pre-season)', () => {
  RW.state.weekKickoffs[1] = WEEK1_KICKOFF_MS;
  assert.strictEqual(RW.isPreseasonWwPickupRW(preseasonPickup(20)), "yes");
});
check('week 1 kickoff instant unresolvable -> "unknown", never a guess', () => {
  RW.state.weekKickoffs[1] = null;
  assert.strictEqual(RW.isPreseasonWwPickupRW(preseasonPickup(20)), "unknown");
});

console.log("\nTHE DEFECT ITSELF: a pre-season pickup still at MYAC/MYM must NOT show extension-eligible");
check("pre-season pickup, ladder stage MYAC, but 20 days after his OWN acquisition (inside the in-season 15-28 window by coincidence): NOT extension-eligible", () => {
  RW.state.weekKickoffs[1] = WEEK1_KICKOFF_MS;
  RW.state.contractLadderServer = { stage: "myac", end_unix: Math.floor(WEEK1_KICKOFF_MS / 1000) };
  const player = preseasonPickup(60); // acquired ~2 months before kickoff
  // "Now" is 20 days after THIS PLAYER'S acquisition date — squarely inside
  // the in-season 15-28 window standardExtensionWindow would have granted.
  const acqMs = Date.parse(player.acquisitionDate + "T12:00:00-04:00");
  const savedNow = Date.now;
  Date.now = () => acqMs + 20 * DAY;
  try {
    const elig = RW.rosterContractEligibility(player);
    assert.strictEqual(elig.extensionEligible, false,
      "regression: a pre-season pickup at MYAC must never show extension-eligible just because his acquisition date, run through the in-season clock, happens to land in days 15-28");
  } finally { Date.now = savedNow; }
});
check("same pre-season pickup, ladder stage MYM: still NOT extension-eligible", () => {
  RW.state.contractLadderServer = { stage: "mym", end_unix: Math.floor((WEEK1_KICKOFF_MS + 20 * DAY) / 1000) };
  const player = preseasonPickup(60);
  const acqMs = Date.parse(player.acquisitionDate + "T12:00:00-04:00");
  const savedNow = Date.now;
  Date.now = () => acqMs + 20 * DAY;
  try {
    assert.strictEqual(RW.rosterContractEligibility(player).extensionEligible, false);
  } finally { Date.now = savedNow; }
});
check("same pre-season pickup, ladder stage EXTENSION: now correctly eligible", () => {
  RW.state.contractLadderServer = { stage: "extension", end_unix: Math.floor((WEEK1_KICKOFF_MS + 40 * DAY) / 1000) };
  const player = preseasonPickup(60);
  const acqMs = Date.parse(player.acquisitionDate + "T12:00:00-04:00");
  const savedNow = Date.now;
  Date.now = () => acqMs + 20 * DAY;
  try {
    assert.strictEqual(RW.rosterContractEligibility(player).extensionEligible, true);
  } finally { Date.now = savedNow; }
});
check("same pre-season pickup, ladder CLOSED (past Week 5): NOT extension-eligible", () => {
  RW.state.contractLadderServer = { stage: "closed", end_unix: null };
  const player = preseasonPickup(60);
  const acqMs = Date.parse(player.acquisitionDate + "T12:00:00-04:00");
  const savedNow = Date.now;
  Date.now = () => acqMs + 20 * DAY;
  try {
    assert.strictEqual(RW.rosterContractEligibility(player).extensionEligible, false);
  } finally { Date.now = savedNow; }
});
check('ladder UNRESOLVED (server never answered): fails closed, not extension-eligible', () => {
  RW.state.contractLadderServer = null;
  const player = preseasonPickup(60);
  const acqMs = Date.parse(player.acquisitionDate + "T12:00:00-04:00");
  const savedNow = Date.now;
  Date.now = () => acqMs + 20 * DAY;
  try {
    assert.strictEqual(RW.rosterContractEligibility(player).extensionEligible, false);
  } finally { Date.now = savedNow; }
});

console.log("\nPRESERVED: genuine in-season WW/FCFS pickup still uses the days-15-28 clock");
for (const [label, daysSinceAcq, expected] of [
  ["day 14 (still MYM territory, not extension yet)", 14, false],
  ["day 15 (extension opens)", 15, true],
  ["day 28 (last eligible day)", 28, true],
  ["day 29 (window shut)", 29, false],
]) {
  check(`in-season pickup, ${label}: extensionEligible=${expected}`, () => {
    RW.state.weekKickoffs[1] = WEEK1_KICKOFF_MS;
    RW.state.contractLadderServer = { stage: "closed", end_unix: null }; // irrelevant — not on the ladder
    const player = inSeasonPickup(daysSinceAcq);
    const savedNow = Date.now;
    Date.now = () => player.__nowMsForTest;
    try {
      assert.strictEqual(RW.rosterContractEligibility(player).extensionEligible, expected);
    } finally { Date.now = savedNow; }
  });
}

console.log("\nPRESERVED: Dallas Goedert (held veteran, Sept deadline long passed) is still NOT extension-eligible");
check("Goedert's exact live shape: not on any ladder (not a WW contract at all), deadline passed", () => {
  RW.state.weekKickoffs[1] = WEEK1_KICKOFF_MS;
  RW.state.contractLadderServer = { stage: "extension", end_unix: 9e12 }; // even if the ladder is WIDE OPEN right now
  const goedert = {
    years: 1, type: "Vet-FAA", special: "CL 2| TCV 14K| AAV 7K| Y1-7K, Y2-7K| GTD: 10.5K",
    acquisitionTypeLabel: "Trade", acquisitionDate: "2025-11-27",
  };
  assert.strictEqual(RW.isPreseasonWwPickupRW(goedert), "no", "a Vet-FAA contract is not a WW contract at all");
  const savedNow = Date.now;
  Date.now = () => Date.parse("2026-09-28T12:00:00-04:00");
  try {
    assert.strictEqual(RW.rosterContractEligibility(goedert).extensionEligible, false);
  } finally { Date.now = savedNow; }
});

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
