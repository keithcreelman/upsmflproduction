// The Stats page in MFL's frame (site/stats_workbench/mfl_hpm_embed_loader.js), desktop redesign
// 2026-10-15: the frame is an app pane as tall as the window below MFL's header (at least 600px;
// shorter only when the page is). Before, it took its height once at load, before the table
// arrived: measured on MFL at 1280×900, a 640px box around a 2,670px page, one table row visible.
//   node tests/stats_workbench_frame_loader.test.mjs
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert";

const SRC = fs.readFileSync(new URL("../site/stats_workbench/mfl_hpm_embed_loader.js", import.meta.url), "utf8");
let fails = 0, passes = 0;
const check = async (n, fn) => { try { await fn(); passes++; console.log("  ok   " + n); } catch (e) { fails++; console.log("  FAIL " + n + "\n         " + (e && e.message)); } };
const tick = () => new Promise((r) => setTimeout(r, 0));

async function run(o) {
  o = Object.assign({ innerHeight: 900, top: 68, content: 2670, url: null }, o);
  const listeners = {}, fetched = [];
  let iframe = null, observer = null;
  const mount = { innerHTML: "", appendChild(el) { iframe = el; } };
  const script = { getAttribute: () => "upsStatsWorkbenchMount", parentNode: { insertBefore() {} } };
  const doc = { currentScript: script, getElementById: () => mount,
    createElement: () => {
      const el = { attrs: {}, style: {}, ev: {}, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(t, f) { this.ev[t] = f; },
        getBoundingClientRect: () => ({ top: o.top }),
        contentDocument: { body: { get scrollHeight() { return o.content; } }, documentElement: { get scrollHeight() { return Math.max(o.content, 824); } } },
        contentWindow: { ResizeObserver: class { constructor(f) { observer = f; } observe() {} } } };
      return el;
    } };
  const c = vm.createContext({ document: doc, Promise, Math, Number, String, encodeURIComponent,
    fetch: (u) => { fetched.push(u); return Promise.resolve({ ok: true, text: () => Promise.resolve("<html>stats</html>") }); } });
  c.window = c; c.innerHeight = o.innerHeight; c.pageYOffset = 0;
  c.addEventListener = (t, f) => { listeners[t] = f; };
  if (o.url) c.UPS_STATS_WORKBENCH_HTML_URL = o.url;
  vm.runInContext(SRC, c);
  for (let i = 0; i < 5; i++) await tick();
  return { iframe: () => iframe, load: () => iframe.ev.load(), fetched, message: (h) => listeners.message({ data: { type: "ups-asw-height", height: h } }),
    resize: (ih) => { c.innerHeight = ih; listeners.resize(); }, grow: (h) => { o.content = h; observer(); } };
}

await check("a tall page: the frame is the window below MFL's header (1280×900, header 68px → 824px), not a 640px box", async () => {
  const L = await run({}); L.load();
  assert.strictEqual(L.iframe().style.height, "824px");
  assert.strictEqual(L.iframe().srcdoc, "<html>stats</html>");
  assert.strictEqual(L.iframe().attrs.title, "UPS Stats", "the frame has an accessible name");
});
await check("a short page: as tall as the page (+40), never under 600px", async () => {
  const L = await run({ content: 700 }); L.load(); assert.strictEqual(L.iframe().style.height, "740px");
  const S = await run({ content: 200 }); S.load(); assert.strictEqual(S.iframe().style.height, "600px");
});
await check("it refits when the page grows (data arrives, a view switches) and when the window resizes", async () => {
  const L = await run({ content: 300 }); L.load(); assert.strictEqual(L.iframe().style.height, "600px");
  L.grow(2670); assert.strictEqual(L.iframe().style.height, "824px", "the table arrived");
  L.resize(1100); assert.strictEqual(L.iframe().style.height, "1024px");
  L.resize(500); assert.strictEqual(L.iframe().style.height, "600px", "a short window: still 600px");
});
await check("a view's height message is capped at the window (the page scrolls inside the pane)", async () => {
  const L = await run({}); L.load();
  L.message(5000); assert.strictEqual(L.iframe().style.height, "824px");
  L.message(650); assert.strictEqual(L.iframe().style.height, "690px");
});
await check("a deep MFL header is capped at 160px so the pane stays tall", async () => {
  const L = await run({ top: 400 }); L.load(); assert.strictEqual(L.iframe().style.height, String(900 - 160 - 8) + "px");
});
await check("the release SHA picks the page; a preview may point at its own read-only copy", async () => {
  const L = await run({}); assert.match(L.fetched[0], /^https:\/\/rawcdn\.githack\.com\/keithcreelman\/upsmflproduction\/main\/site\/stats_workbench\/stats_workbench\.html$/);
  const P = await run({ url: "https://preview.example/after/stats_workbench.html" }); assert.strictEqual(P.fetched[0], "https://preview.example/after/stats_workbench.html");
});

console.log(fails ? `\n${fails} FAILED (${passes} passed)` : `\nall ${passes} passed`);
process.exit(fails ? 1 : 0);
