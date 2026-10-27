// Front Office view choices (Keith 2026-10-27): the groups that choose WHAT a screen shows are labeled, grouped and styled as
// controls (Direction A: solid blue selected + check mark + heavier weight; 44 px targets; 14 px text in the wider screen-first
// font; a keyboard focus ring), separate from the quiet filters; Market wraps to rows. No data, rule or handler changes.
//   node tests/front_office_view_choices.test.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const HTML = read("site/rosters/v2/front_office.html"), CSS = read("site/rosters/v2/front_office.css");
const MK = read("site/rosters/v2/fo_market.js"), TF = read("site/rosters/v2/fo_trades.js"), ACT = read("site/rosters/v2/fo_activity.js");

test("every named choice group has a visible label and names itself by it (aria-labelledby)", () => {
  const groups = [
    [HTML, 'id="fo-lbl-colset">Roster columns', 'id="fo-colset" role="group" aria-labelledby="fo-lbl-colset"'],
    [HTML, 'id="fo-lbl-group">Group players', 'id="fo-group-toggle" role="tablist" aria-labelledby="fo-lbl-group"'],
    [HTML, 'id="fo-lbl-capview">Cap plan view', 'aria-labelledby="fo-lbl-capview"'],
    [MK, 'id="fo-lbl-mk">Browse players', 'aria-labelledby="fo-lbl-mk"'],
    [TF, 'id="fo-lbl-tfby">Compare by', 'aria-labelledby="fo-lbl-tfby"'],
    [TF, 'id="fo-lbl-tfms">Measure', 'aria-labelledby="fo-lbl-tfms"'],
    [ACT, 'id="fo-lbl-mv">Show moves for', 'aria-labelledby="fo-lbl-mv"'],
  ];
  for (const [src, label, ref] of groups) { t.ok(src.includes(label), label); t.ok(src.includes(ref), ref); t.ok(/fo-choice/.test(src.slice(src.indexOf(ref) - 160, src.indexOf(ref) + 40)), label + ": styled as a choice control"); }
});

test("nothing that drives behavior moved: the same buttons, data attributes, ids and handlers", () => {
  for (const a of ['data-colset="perf"', 'data-colset="contract"', 'data-group="flat"', 'data-group="position"', 'data-subview="summary"', 'data-subview="detail"']) t.ok(HTML.includes(a), a);
  t.ok(/data-mk-scope="' \+ s\[0\]/.test(MK) && /\["fa", "Free agents"\], \["bait", "On the block"\], \["all", "All players"\]/.test(MK), "Market: Free agents, On the block, All players (Keith 2026-10-27)");
  t.ok(/chips\(BY, "data-tf-by", view\.by\)/.test(TF) && /chips\(MEASURES, "data-tf-measure", view\.measure\)/.test(TF), "Trade finder: the same two choice lists");
  t.ok(/data-mv-scope="mine"/.test(ACT) && /data-mv-scope="league"/.test(ACT), "Activity: My team / League");
  t.ok(/view\.by === "mix" \? "" :/.test(TF), "Measure still hides on Starter Mix");
});

test("Market: filters are separate from browsing (own label, own block); the choices wrap to rows on a phone", () => {
  t.ok(/fo-choice-filters"><div class="fo-choice-label">Filter the list/.test(MK) && /data-mk-pos=/.test(MK) && /data-mk-team/.test(MK) && /data-mk-q/.test(MK), "position, team and search sit under 'Filter the list'");
  t.ok(/fo-choice fo-choice-wrap/.test(MK) && /\.fo-root \.fo-choice-wrap \.fo-subview-chip \{ flex: 1 1 calc\(50% - 6px\); \}/.test(CSS), "two columns on a phone, so 'All players' is never cut off");
  t.ok(/\.fo-root \.fo-choice \{[^}]*flex-wrap: wrap/.test(CSS), "the track wraps");
});

test("style: Direction A, 44 px targets, 14 px wider font on the controls only, check mark, weight, focus ring", () => {
  const c = CSS.slice(CSS.indexOf("View choices (Keith 2026-10-27)"));
  t.ok(/min-height: 44px; min-width: 44px/.test(c), "44 px targets");
  t.ok(/font-family: var\(--fo-choice-font\); font-size: 14px; font-weight: 600/.test(c), "14 px, in the control font");
  t.ok(/--fo-choice-font: Verdana, "DejaVu Sans", Geneva, -apple-system/.test(c), "wider font first, then the page font as the fallback");
  t.ok(/background: var\(--accent\); color: #07101f/.test(c) && /font-weight: 800/.test(c), "selected = solid blue, dark text, heavier");
  t.ok(/\.active::before[\s\S]*content: "✓"/.test(c) && /\[aria-pressed="true"\]::before/.test(c), "selected shows a check mark, not only color");
  t.ok(/:focus-visible \{ outline: 3px solid var\(--fo-focus\)/.test(c), "visible keyboard focus");
  t.ok(!/body\s*\{[^}]*--fo-choice-font/.test(c) && !/\.fo-root \{[^}]*--fo-choice-font/.test(c) && (c.match(/var\(--fo-choice-font\)/g) || []).length === 2, "the font is used only by the choice label and the choice buttons");
  // contrast of the selected state (dark text on #5b8dff)
  const lum = (h) => { const v = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4))); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  t.ok(ratio("#5b8dff", "#07101f") >= 4.5, "selected text contrast " + ratio("#5b8dff", "#07101f").toFixed(1) + ":1");
  t.ok(ratio("#e8edf5", "#1f293a") >= 4.5, "unselected text contrast " + ratio("#e8edf5", "#1f293a").toFixed(1) + ":1");
});

test("Market search no longer pokes past its card on a phone", () => {
  t.ok(/\.fo-mk-controls \.fo-mk-search input \{ min-width: 0; width: 100%; \}/.test(CSS));
});

test("Market on a phone: each row's status sits under the player's name (the Status column would be half off-screen)", () => {
  t.ok(/<div class="fo-mk-statusline">' \+ availCell\(r\) \+ "<\/div><\/td>"/.test(MK) && /<td class="fo-mk-col-status">' \+ availCell\(r\)/.test(MK) && /"fo-mk-col-status"\)/.test(MK), "the same status cell content under the name and in the column");
  t.ok(/\.fo-root \.fo-mk-statusline \{ display: none; \}/.test(CSS) && /@media \(max-width: 560px\) \{\s*\.fo-root \.fo-mk-col-status \{ display: none; \}\s*\.fo-root \.fo-mk-statusline \{ display: block;/.test(CSS), "desktop keeps the column; phones swap it for the under-name line");
});

test("version stamps changed with the files that changed", () => {
  for (const f of ["fo_trades.js", "fo_activity.js"]) t.ok(HTML.includes(f + "?v=2026.10.27.2"), f);
  for (const f of ["front_office.css", "fo_market.js"]) t.ok(HTML.includes(f + "?v=2026.10.27.3"), f + " (changed again by the Market choices revision)");
  t.ok(/var BUILD = "2026\.10\.27\.3";/.test(read("site/rosters/fo_embed_loader.js")), "embed loader BUILD");
});

await run("front_office_view_choices");
