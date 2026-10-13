// The selected position chip (.ups-m-pos-chip.on: Players, Pts Agst, Draft) must be readable:
// text vs the accent background at least 4.5:1 (WCAG AA for small text). White on #5b8dff was 3.13:1.
//   node tests/mobile_chip_contrast.test.mjs
import fs from "node:fs";
import assert from "node:assert";
const css = fs.readFileSync(new URL("../site/m/app.css", import.meta.url), "utf8");
let fails = 0;
const check = (n, fn) => { try { fn(); console.log("  ok   " + n); } catch (e) { fails++; console.log("  FAIL " + n + "\n         " + e.message); } };
const block = (sel) => { const i = css.indexOf(sel + " {"); assert.ok(i >= 0, "no rule " + sel); return css.slice(i, css.indexOf("}", i)); };
const prop = (b, name) => { const m = new RegExp("(?:^|[;{\\s])" + name + "\\s*:\\s*([^;]+);").exec(b.replace(/\/\*[\s\S]*?\*\//g, "")); return m ? m[1].trim() : null; };
const NAMED = { white: "#ffffff", black: "#000000" };
const hex = (v) => { v = (NAMED[v] || v).toLowerCase(); assert.ok(/^#[0-9a-f]{6}$/.test(v), "not a 6-digit hex color: " + v); return v; };
const lum = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const accent = hex(/--accent\s*:\s*([^;]+);/.exec(css)[1].trim());
const chip = block(".ups-m-pos-chip.on"), seg = block(".ups-m-stseg.on");
check("the selected chip's background is the accent", () => assert.strictEqual(prop(chip, "background"), "var(--accent)"));
check("selected chip text vs accent ≥ 4.5:1", () => { const r = ratio(hex(prop(chip, "color")), accent); assert.ok(r >= 4.5, r.toFixed(2) + ":1"); console.log("         " + ratio(hex(prop(chip, "color")), accent).toFixed(2) + ":1"); });
check("same text color as the selected Stats tab (.ups-m-stseg.on)", () => assert.strictEqual(hex(prop(chip, "color")), hex(prop(seg, "color"))));
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
