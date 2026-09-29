// "Confirm a new offer cannot accidentally take the old native-MFL creation path after
// cutover" (Keith's ruling, 2026-09-29). The staged and direct-MFL 2-way creation functions
// are two SEPARATE, independently-invoked functions -- not a shared decision point with a
// flag -- so there is no code path where calling one could silently fall through to the
// other. Verified at the SOURCE level: each creation function's own body (sliced between its
// own `function` line and the next function's, both located by exact, verified line anchors
// -- not a generic heuristic, since this file mixes function-declaration and function-
// expression styles freely, which breaks a "next `function` keyword" search) references ONLY
// its own endpoint family, never the other's.
//   node tests/trade_staged_no_accidental_crossover.test.mjs
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";

const DESK = fs.readFileSync(new URL("../site/trades/trade_workbench.js", import.meta.url), "utf8");
const MOBILE = fs.readFileSync(new URL("../site/m/views/trade.js", import.meta.url), "utf8");
const deskLines = DESK.split("\n");
const mobileLines = MOBILE.split("\n");

// 1-indexed, inclusive line range -> that slice of the file, plus a check that the anchors
// themselves still say what this test assumes (so a future refactor that moves these
// functions trips an assertion here, not a silent false-negative).
function sliceByAnchors(lines, startLineText, startLineNum, endLineText, endLineNum) {
  if (!lines[startLineNum - 1].includes(startLineText)) throw new Error(`anchor drifted: expected line ${startLineNum} to contain "${startLineText}", got: ${lines[startLineNum - 1]}`);
  if (!lines[endLineNum - 1].includes(endLineText)) throw new Error(`anchor drifted: expected line ${endLineNum} to contain "${endLineText}", got: ${lines[endLineNum - 1]}`);
  return lines.slice(startLineNum - 1, endLineNum - 1).join("\n");
}

test("DESKTOP: submitStagedOfferToQueue's own body never references the direct-MFL endpoint family, and never calls submitOfferToQueue/submitTradeCreateWithGates", () => {
  const body = sliceByAnchors(deskLines, "async function submitStagedOfferToQueue()", 8622, "function init2WayStagedTrade()", 8666);
  t.doesNotMatch(body, /resolveTradeOffersApiUrl|\/trade-offers|submitTradeCreateWithGates\(|submitOfferToQueue\(/);
  t.match(body, /tw2sUrl\(/, "it must go through the staged 2-way URL builder");
});

test("DESKTOP: submitOfferToQueue's own body never references the staged endpoint family, and never calls submitStagedOfferToQueue", () => {
  const body = sliceByAnchors(deskLines, "async function submitOfferToQueue()", 4322, "async function retryLastSubmitRequest()", 4445);
  t.doesNotMatch(body, /resolveStaged2WayApiUrl|\/api\/trades\/2way|submitStagedOfferToQueue\(/);
});

test("DESKTOP: the staged URL builder resolves to the staged endpoint (it legitimately derives its OWN base from resolveTradeOffersApiUrl()'s worker host, then rewrites the path -- the same pattern resolve3WayApiUrl already uses -- so referencing that helper is expected; landing on a different final path is the actual property)", () => {
  const m = /function resolveStaged2WayApiUrl\(\)[\s\S]{0,600}/.exec(DESK)[0];
  t.match(m, /\/api\/trades\/2way/);
  t.match(m, /replace\(\/\\\/trade-offers\\\/\?\$\/i, "\/api\/trades\/2way"\)/, "it rewrites the path, never keeps the direct-MFL one");
});

test("MOBILE: submitStagedOffer's own body never references the direct-MFL proposals endpoint, and never calls submitOffer/submitTradeCreateWithGatesMobile", () => {
  const body = sliceByAnchors(mobileLines, "function submitStagedOffer()", 2287, "function render(mount, parts)", 2325);
  t.doesNotMatch(body, /\/api\/trades\/proposals|submitTradeCreateWithGatesMobile\(|[^d]submitOffer\(/);
  t.match(body, /\/api\/trades\/2way/, "it must post to the staged endpoint");
});

test("MOBILE: submitOffer's own body never references the staged endpoint, and never calls submitStagedOffer", () => {
  const body = sliceByAnchors(mobileLines, "function submitOffer()", 947, "function mflActionVerb(action)", 1028);
  t.doesNotMatch(body, /\/api\/trades\/2way(?!-)|submitStagedOffer\(/);
});

// Both surfaces expose the two as genuinely separate UI entry points (a button each), never
// one button whose behavior is chosen by a runtime flag -- the "no shared decision point"
// property that makes accidental crossover structurally impossible, not just untested.
test("DESKTOP: the new Stage button is its own distinct DOM element, directly and unconditionally wired to submitStagedOfferToQueue -- not a branch inside the existing Submit button's own (pre-existing, intent-based) click dispatch", () => {
  t.match(DESK, /var stageBtn = document\.getElementById\("twbStageOfferBtn"\);\s*\n\s*if \(stageBtn[^)]*\) \{ stageBtn\.__tw2sWired = true; stageBtn\.addEventListener\("click", submitStagedOfferToQueue\); \}/);
  // The existing Submit button's own id string never appears inside that new wiring block,
  // and vice versa -- two independent listeners, not one shared handler branching on state.
  t.doesNotMatch(DESK, /getElementById\("twbSubmitOfferBtn"\)[\s\S]{0,120}submitStagedOfferToQueue/);
  t.doesNotMatch(DESK, /getElementById\("twbStageOfferBtn"\)[\s\S]{0,300}(?<!Staged)submitOfferToQueue\(\)/);
});
test("MOBILE: two distinct buttons wired to the two distinct functions", () => {
  t.match(MOBILE, /ups-m-tb-submit"\)[\s\S]{0,200}submitOffer\(\)/);
  t.match(MOBILE, /ups-m-tb-stage"\)[\s\S]{0,200}submitStagedOffer\(\)/);
});

await run("trade_staged_no_accidental_crossover");
