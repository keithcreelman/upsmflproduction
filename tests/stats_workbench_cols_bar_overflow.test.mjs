// Stats Workbench — #asw-cols-bar must not push the PAGE wider than the
// viewport at phone widths.
//   node tests/stats_workbench_cols_bar_overflow.test.mjs
//
// THE DEFECT (found 2026-09-28, during the season-default/freshness release):
// #asw-cols-bar (Columns label + 4 view-preset chips + named-view chips +
// "Save view" + the "Columns ▾" trigger + a flex spacer + the Filters/
// Scatter/Heat/CSV buttons) was `display:flex` with NO flex-wrap and no
// overflow container of its own. At 375/390px that row is wider than the
// viewport, and since nothing clips or scrolls it, the overflow bubbles all
// the way up: documentElement.scrollWidth (694px) > clientWidth (375/390px)
// — the WHOLE PAGE gets a horizontal scrollbar, not just this bar.
//
// Fix: `.asw-cols-bar` gets flex-wrap:wrap — the exact same pattern
// `.asw-tabs` (the position-tab row directly above it, QB/RB/WR/...) already
// uses for the identical problem. Verified live at 375/390/997/1280px
// (documentElement.scrollWidth === clientWidth at all four, popover still
// opens and is fully visible, the table's own independent horizontal scroll
// — #asw-topscroll / #asw-table-wrap — is untouched and still works) — see
// the PR description for the exact measurements. This file only guards the
// source-level fix (a rendered-layout guard needs a real browser, which this
// repo's test suite doesn't drive — see the sibling tests in this file for
// the same convention).
import fs from "fs";
import assert from "assert";

const HTML = fs.readFileSync("site/stats_workbench/stats_workbench.html", "utf8");
let fails = 0;
const check = (n, fn) => { try { fn(); console.log("  ok   " + n); }
  catch (e) { fails++; console.log("  FAIL " + n + "\n         " + e.message); } };

// Anchored on the BASE rule's known, distinctive opening (not just the bare
// selector) — several of these selectors are re-opened inside @media blocks
// earlier in the file with only an override property or two (e.g.
// ".asw-tabs{padding:8px}" inside the <=820px query), and a bare
// `indexOf(selector + "{")` finds whichever comes first in character order,
// which is usually that narrow override, not the base rule this test means
// to check.
function baseRule(distinctiveOpening) {
  const i = HTML.indexOf(distinctiveOpening);
  assert.ok(i >= 0, "base rule opening not found: " + distinctiveOpening);
  return HTML.slice(i, HTML.indexOf("}", i) + 1);
}

console.log(".asw-cols-bar");
check("has flex-wrap:wrap (the fix — was completely absent before this pass)", () => {
  const rule = baseRule(".asw-cols-bar{display:flex");
  assert.match(rule, /flex-wrap:\s*wrap/, ".asw-cols-bar must wrap its children rather than overflow the page");
});
check("is still position:relative (the popover's containing block — must not change)", () => {
  const rule = baseRule(".asw-cols-bar{display:flex");
  assert.match(rule, /position:\s*relative/,
    "the Columns popover is position:absolute inside this bar — removing position:relative here would reposition it against a further ancestor and likely break or mislocate it");
});
check("matches the established sibling pattern: .asw-tabs (the position-tab row) already wraps the same way", () => {
  const tabsRule = baseRule(".asw-tabs{display:flex");
  assert.match(tabsRule, /flex-wrap:\s*wrap/,
    ".asw-tabs is the reference pattern this fix follows — if this ever stops wrapping too, the fix's own rationale (\"do it the way the sibling row already does\") no longer holds");
});

console.log("\n.asw-cols-popover — must still be able to open below the (now possibly multi-row) bar");
check("still position:absolute, anchored below the bar (top: calc(100% + ...))", () => {
  const rule = baseRule(".asw-cols-popover{position:absolute");
  assert.match(rule, /top:\s*calc\(100%/,
    "must open BELOW the bar's full rendered height, including any wrapped rows — not a fixed pixel offset that could land mid-bar once it wraps to 2-3 lines");
});

console.log("\n.asw-topscroll / .asw-table-wrap — the table's OWN horizontal scroll must be untouched by this fix");
check("topscroll is still its own overflow-x scroll container, independent of .asw-cols-bar", () => {
  const rule = baseRule(".asw-topscroll{overflow-x:auto");
  assert.match(rule, /overflow-x:\s*auto/,
    "the table's independent horizontal scrollbar must still exist — this fix must not touch it");
});
check(".asw-table-wrap rule still present", () => {
  assert.ok(HTML.indexOf(".asw-table-wrap{") >= 0, ".asw-table-wrap rule not found");
});

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
