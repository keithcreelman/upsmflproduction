// Desktop workbench: EPA / red-zone play definitions across seasons (2026-10-11).
//   node tests/stats_workbench_definition_note.test.mjs
// The 2026 backfill moves EPA to box-score plays (two-point tries out) and the red
// zone to the 0169 rules; 2014-2025 keep the old definitions until rebuilt. The
// worker never adds the two together (EPA empty + mixed_definitions, red-zone
// counts null + rz_mixed); this note says why the cells read "—", and labels an
// all-old window as not comparable with 2026. Silent otherwise.
import fs from "fs";
import vm from "vm";
import assert from "assert";

const SRC = fs.readFileSync("site/stats_workbench/stats_workbench.html", "utf8");
let fails = 0;
const check = (n, fn) => { try { fn(); console.log("  ok   " + n); } catch (e) { fails++; console.log("  FAIL " + n + "\n         " + e.message); } };
function extractFn(name) {
  const start = SRC.indexOf("function " + name + "(");
  if (start < 0) throw new Error(name + " not found");
  let depth = 0, i = SRC.indexOf("{", start);
  for (; i < SRC.length; i++) { if (SRC[i] === "{") depth++; else if (SRC[i] === "}") { depth--; if (depth === 0) break; } }
  return SRC.slice(start, i + 1);
}
const rzVar = /var RZ_COLS = \{[^}]*\};/.exec(SRC)[0];
const note = (state, cols) => {
  const slot = { html: "", insertAdjacentHTML(_, h) { this.html += h; } };
  const ctx = vm.createContext({ state, document: { getElementById: () => slot },
    escapeHtml: (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;") });
  vm.runInContext(rzVar + "\n" + extractFn("renderDefinitionNote") + "\nrenderDefinitionNote(" + JSON.stringify(cols) + ");", ctx);
  return slot.html;
};
check("mixed EPA window: says why the EPA cells read — and how to fix it", () => {
  const h = note({ epaMixed: true, epaDefinitions: { 2025: 1, 2026: 2 } }, ["mfl_ppg", "epa_play", "epa_succ"]);
  assert.match(h, /EPA columns read — : the seasons chosen use different play definitions/);
  assert.match(h, /Choose seasons on one side\./);
});
check("an all-old EPA window is labelled not comparable with 2026", () => {
  const h = note({ epaMixed: false, epaDefinitions: { 2024: 1, 2025: 1 } }, ["epa_play"]);
  assert.match(h, /EPA for 2024, 2025 uses the original play definition .*aren't comparable with it\./);
});
check("2026 alone, or no EPA / red-zone column showing: silent", () => {
  assert.equal(note({ epaMixed: false, epaDefinitions: { 2026: 2 } }, ["epa_play"]), "");
  assert.equal(note({ epaMixed: true, epaDefinitions: { 2025: 1, 2026: 2 }, rzMixed: true }, ["mfl_ppg", "targets"]), "");
});
check("mixed red-zone window: says why those cells read —", () => {
  const h = note({ rzMixed: true, epaDefinitions: null }, ["targets_i20", "rz_target_share"]);
  assert.match(h, /Red-zone columns read — : this window mixes 2026/);
});
check("the note is wired after the freshness note on every render", () => {
  assert.match(SRC, /renderSourceFreshnessNote\(cols\);\s*\n\s*renderDefinitionNote\(cols\);/);
  assert.match(SRC, /state\.epaMixed = !!\(j && j\.mixed_definitions\);/);
  assert.match(SRC, /state\.rzMixed = rows\.some\(function \(r\) \{ return r && r\.rz_mixed === 1; \}\);/);
});
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
