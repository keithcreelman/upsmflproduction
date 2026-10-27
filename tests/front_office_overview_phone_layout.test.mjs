// Front Office Overview at phone widths (#1375, a Front Office release blocker): the top row of cards goes to one
// column under 600 px, and a Cap card line lets its amount wrap under the label instead of clipping it. The live
// check (each .fo-ov-capnum inside its card at 320 and 375 px) is in the preview checklist; this pins the CSS.
//   node tests/front_office_overview_phone_layout.test.mjs
//   FO_CSS=<path> node tests/front_office_overview_phone_layout.test.mjs   (defect check against another copy)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CSS = fs.readFileSync(process.env.FO_CSS || path.join(ROOT, "site/rosters/v2/front_office.css"), "utf8");

test("under 600 px the Overview's top row is one card per row", () => {
  t.ok(/@media \(max-width: 600px\) \{ \.fo-ov-row \{ grid-template-columns: 1fr; \} \}/.test(CSS), "one-column rule for phone widths");
  t.ok(/@media \(max-width: 1100px\) \{ \.fo-ov-row \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \} \}/.test(CSS), "two columns kept for tablets");
});

test("a Cap card amount wraps under its label rather than clipping", () => {
  t.ok(/\.fo-ov-capline \{[^}]*flex-wrap: wrap;/.test(CSS), "the line can wrap");
  t.ok(/\.fo-ov-capnum \{[^}]*white-space: nowrap;[^}]*margin-left: auto;/.test(CSS), "the amount stays whole and right-aligned");
});

await run("front_office_overview_phone_layout");
