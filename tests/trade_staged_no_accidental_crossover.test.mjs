// UPDATED SCOPE (2026-09-29, second ruling): the button-level story below is still true and
// still tested -- "Stage via War Room" and "Submit Offer" are two separate, independently-
// invoked functions, not a shared decision point with a flag. But Keith correctly identified
// that this alone was an insufficient fix ("hiding a button alone is insufficient"): the
// NORMAL Send button must itself stage once cutover is live server-side, which means
// submitOfferToQueue/submitOffer NOW deliberately fall through to staging when the legacy
// endpoint refuses (worker's TRADE_2WAY_CUTOVER_ENABLED, code "staging_required") --
// see submitTradeCreateWithGates/submitViaStagingFallback (desktop) and
// submitTradeCreateWithGatesMobile/submitViaStagingFallbackMobile (mobile), and their own
// dedicated, REAL-worker, end-to-end coverage in tests/trade_cutover_send_fallback.test.mjs
// and tests/trade_2way_cutover_switch.test.mjs (the server-side gate itself). What THIS file
// still verifies, and what remains true even with the fallback: neither function's own body
// contains a hardcoded, unconditional reference to the OTHER endpoint family -- the only
// bridge between them is the explicit, server-authorized fallback path, never a silent shared
// branch a stale client could stumble into on its own. Verified at the SOURCE level: each
// creation function's own body (sliced between its own `function` line and the next
// function's, both located by exact, verified line anchors -- not a generic heuristic, since
// this file mixes function-declaration and function-expression styles freely, which breaks a
// "next `function` keyword" search).
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
  const body = sliceByAnchors(deskLines, "async function submitStagedOfferToQueue()", 8690, "function init3WayTrade()", 8733);
  t.doesNotMatch(body, /resolveTradeOffersApiUrl|\/trade-offers|submitTradeCreateWithGates\(|submitOfferToQueue\(/);
  t.match(body, /tw2sUrl\(/, "it must go through the staged 2-way URL builder");
});

test("DESKTOP: submitOfferToQueue's own body never references the staged endpoint family, and never calls submitStagedOfferToQueue", () => {
  const body = sliceByAnchors(deskLines, "async function submitOfferToQueue()", 4282, "async function retryLastSubmitRequest()", 4428);
  t.doesNotMatch(body, /resolveStaged2WayApiUrl|\/api\/trades\/2way|submitStagedOfferToQueue\(/);
});

test("DESKTOP: the staged URL builder resolves to the staged endpoint (it legitimately derives its OWN base from resolveTradeOffersApiUrl()'s worker host, then rewrites the path -- the same pattern resolve3WayApiUrl already uses -- so referencing that helper is expected; landing on a different final path is the actual property)", () => {
  const m = /function resolveStaged2WayApiUrl\(\)[\s\S]{0,600}/.exec(DESK)[0];
  t.match(m, /\/api\/trades\/2way/);
  t.match(m, /replace\(\/\\\/trade-offers\\\/\?\$\/i, "\/api\/trades\/2way"\)/, "it rewrites the path, never keeps the direct-MFL one");
});

test("MOBILE: submitStagedOffer's own body never references the direct-MFL proposals endpoint, and never calls submitOffer/submitTradeCreateWithGatesMobile", () => {
  const body = sliceByAnchors(mobileLines, "function submitStagedOffer()", 2349, "function render(mount, parts)", 2387);
  t.doesNotMatch(body, /\/api\/trades\/proposals|submitTradeCreateWithGatesMobile\(|[^d]submitOffer\(/);
  t.match(body, /\/api\/trades\/2way/, "it must post to the staged endpoint");
});

test("MOBILE: submitOffer's own body never references the staged endpoint, and never calls submitStagedOffer", () => {
  const body = sliceByAnchors(mobileLines, "function submitOffer()", 1110, "function mflActionVerb(action)", 1199);
  t.doesNotMatch(body, /\/api\/trades\/2way(?!-)|submitStagedOffer\(/);
});

// RULING (Keith, 2026-10-01): "That is not the experience I requested... this section should
// not appear to owners." The Stage button/dropdown/detail panel are REMOVED from the normal
// UI (site/trades/trade_workbench.html, site/m/views/trade.js) -- submitStagedOfferToQueue/
// submitStagedOffer and the staged list/detail render functions above still exist (the D1
// engine itself is untouched, per Keith's own instruction to keep it, not delete it), but
// nothing in the normal page wires a click to them anymore. See
// tests/trade_staged_ui_hidden_from_owners.test.mjs for the dedicated "cannot regress" coverage
// of this (asserts against the REAL rendered page output, not just source-level absence).
test("DESKTOP: no 'Stage via War Room' button exists anywhere in the page source, and submitStagedOfferToQueue is wired to nothing", () => {
  t.doesNotMatch(DESK, /twbStageOfferBtn/, "the button's own id string is gone, not just unwired");
  t.doesNotMatch(DESK, /addEventListener\("click",\s*submitStagedOfferToQueue\)/, "nothing attaches a click listener to it");
});
test("MOBILE: no 'Stage via War Room' button exists anywhere in the page source, and submitStagedOffer is wired to nothing", () => {
  t.doesNotMatch(MOBILE, /ups-m-tb-stage/, "the button's own id string is gone, not just unwired");
  t.doesNotMatch(MOBILE, /addEventListener\("click",\s*function\s*\(\)\s*\{[^}]*submitStagedOffer\(\);/, "nothing attaches a click listener to it");
});

await run("trade_staged_no_accidental_crossover");
