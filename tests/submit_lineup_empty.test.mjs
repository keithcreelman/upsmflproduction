// Keith 2026-11-26 (#1475/#1537): an empty lineup may be submitted. /api/submit-lineup requires the starters LIST, not a non-empty one; an empty
// list is posted to MFL as STARTERS= and MFL's own answer decides. (Source check; the live behavior is checked on the TEST worker.)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "worker", "src", "index.js"), "utf8");
const at = SRC.indexOf('path === "/api/submit-lineup" && request.method === "POST"'), block = SRC.slice(at, at + 9000);

test("submit-lineup: the starters list is required, an empty one is allowed and posted as STARTERS=", () => {
  t.ok(at > 0);
  t.match(block, /if \(!Array\.isArray\(body\.starters\)\) return jsonOut\(400, \{ ok: false, error: "starters\[\] required"/);
  t.doesNotMatch(block, /if \(!starters\.length\) return/, "no refusal of an empty list");
  t.match(block, /form\.set\("STARTERS", starters\.join\(","\)\);/, "an empty list joins to an empty STARTERS");
  t.equal([].join(","), "");
});

await run("submit_lineup_empty");
