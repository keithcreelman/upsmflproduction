// The Stats UI contract on the desktop Player Stats page (docs/STATS_UI_CONTRACT.md; Keith
// 2026-10-15). Two parts:
//   A. the contract's static rules, read from the page: stat groups per position (Fantasy points
//      first, at most 8 numbers, every column defined, points per game only in Fantasy points),
//      Sched Δ / Opp ±% never colored, American spelling, the order of the screen.
//   B. the REAL page script (site/stats_workbench/stats_workbench.html) run in node:vm on a tree
//      DOM, fed a trimmed copy of production's own 2025 answers (tests/fixtures/
//      stats_workbench_2025.json, read 2026-10-15 by GET): every position × every stat group,
//      each default sort both ways ("—" last), every window, one season, an old season, two
//      seasons together, More filters, compare mode, keyboard sorting, the drawer, the count,
//      Custom columns, and not one non-GET request.
//   node tests/stats_ui_contract.test.mjs
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert";
import { makeDocument, settle } from "./fixtures/tree_dom.mjs";

const read = (p) => fs.readFileSync(new URL("../" + p, import.meta.url), "utf8");
// WORKBENCH_HTML=<path> runs the same checks on another copy of the page (mutation checks).
const SRC = process.env.WORKBENCH_HTML ? fs.readFileSync(process.env.WORKBENCH_HTML, "utf8") : read("site/stats_workbench/stats_workbench.html");
const FX = JSON.parse(read("tests/fixtures/stats_workbench_2025.json"));
const SCRIPT = (() => { const m = [...SRC.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((x) => x[1]); return m[m.length - 1]; })();

let fails = 0, passes = 0;
const check = async (n, fn) => { try { await fn(); passes++; console.log("  ok   " + n); } catch (e) { fails++; console.log("  FAIL " + n + "\n         " + (e && e.message)); } };

// ── A. static: evaluate the page's own definitions ──
// Object literals are evaluated with every free name stubbed, so a compute() that mentions a
// helper still evaluates (it is never called here).
function evalLiteral(start, endMarker) {
  const a = SCRIPT.indexOf(start); assert.ok(a >= 0, start);
  const open = SCRIPT.indexOf("{", a);
  let depth = 0, i = open;
  for (; i < SCRIPT.length; i++) { if (SCRIPT[i] === "{") depth++; else if (SCRIPT[i] === "}") { depth--; if (depth === 0) break; } }
  const stub = new Proxy({}, { has: (t, k) => !["Math", "JSON", "String", "Number", "Object", "Array", "parseInt", "parseFloat", "isNaN", "isFinite", "undefined"].includes(k), get: () => function () {} });
  return new Function("stub", "with (stub) { return (" + SCRIPT.slice(open, i + 1) + "); }")(stub);
}
const COLS = evalLiteral("  var COLS = {");
const TAB_IDS = Object.keys(evalLiteral("  var TABS = {"));
const SG = (() => {
  const a = SCRIPT.indexOf("  var STAT_GROUP_MAX"), b = SCRIPT.indexOf("  function statGroupById(");
  const ctx = vm.createContext({});
  vm.runInContext(SCRIPT.slice(a, b) + "\nthis.out = JSON.stringify({ STAT_GROUPS: STAT_GROUPS, MAX: STAT_GROUP_MAX, SG_SRC: SG_SRC });", ctx);
  return JSON.parse(ctx.out);   // (copied into this realm: deepStrictEqual compares prototypes)
})();
const WANT_GROUPS = {
  qb: ["fantasy", "usage", "passing", "rushing", "redzone", "nextgen", "boom", "schedule"],
  rb: ["fantasy", "usage", "rushing", "receiving", "redzone", "nextgen", "boom", "schedule"],
  wr: ["fantasy", "usage", "receiving", "rushing", "redzone", "nextgen", "boom", "schedule"],
  te: ["fantasy", "usage", "receiving", "redzone", "nextgen", "boom", "schedule"],
  flex_o: ["fantasy", "usage", "rushing", "receiving", "redzone", "boom", "schedule"],
  dl: ["fantasy", "usage", "idp", "boom", "schedule"], lb: ["fantasy", "usage", "idp", "boom", "schedule"],
  db: ["fantasy", "usage", "idp", "boom", "schedule"], flex_idp: ["fantasy", "usage", "idp", "boom", "schedule"],
  pk: ["fantasy", "kicking", "boom", "schedule"], pn: ["fantasy", "punting", "boom", "schedule"],
};
console.log("A. the contract's static rules");
await check("every position has its stat groups, Fantasy points first and the default (contract §2)", () => {
  assert.deepStrictEqual(Object.keys(SG.STAT_GROUPS).sort(), TAB_IDS.slice().sort());
  for (const t of TAB_IDS) assert.deepStrictEqual(SG.STAT_GROUPS[t].map((g) => g.id), WANT_GROUPS[t], t);
});
await check("at most 8 numbers per group; every column exists, is a number, has a label and a one-line definition; no duplicates", () => {
  assert.strictEqual(SG.MAX, 8);
  for (const t of TAB_IDS) for (const g of SG.STAT_GROUPS[t]) {
    assert.ok(g.cols.length >= 1 && g.cols.length <= 8, t + "/" + g.id + ": " + g.cols.length);
    assert.strictEqual(new Set(g.cols).size, g.cols.length, t + "/" + g.id + " duplicates");
    for (const k of g.cols) {
      const d = COLS[k]; assert.ok(d, t + "/" + g.id + ": " + k + " missing");
      assert.ok(d.num, k + " is a number column"); assert.ok(d.label, k + " label");
      assert.ok(typeof d.title === "string" && d.title.length >= 8, k + " has no definition (title)");
    }
    assert.ok(g.cols.includes(g.sort), t + "/" + g.id + ": its sort " + g.sort + " is one of its columns");
    for (const s of g.src) assert.ok(SG.SG_SRC[s], t + "/" + g.id + " source " + s);
  }
});
await check("points per game only in Fantasy points (never beside box-score or schedule numbers)", () => {
  for (const t of TAB_IDS) for (const g of SG.STAT_GROUPS[t]) if (g.id !== "fantasy") assert.ok(!g.cols.includes("mfl_ppg"), t + "/" + g.id);
});
await check("Sched Δ and Opp ±% are never colored: no heat, no best/worst, signed text (contract §8)", () => {
  for (const k of ["mfl_points_sos", "mfl_sched_opp"]) { assert.strictEqual(COLS[k].noHeat, true, k); assert.ok(!COLS[k].cls, k + " has no class"); }
  assert.match(SCRIPT, /if \(!def\.num \|\| def\.noHeat\) return;/, "heat skips them");
  assert.match(SCRIPT, /numericVals\.length > 1 && !def\.noHeat\)/, "compare's best/worst skips them");
  for (const t of TAB_IDS) assert.deepStrictEqual(SG.STAT_GROUPS[t].find((g) => g.id === "schedule").cols.filter((k) => /sos|sched/.test(k)), ["mfl_points_sos", "mfl_sched_opp"], t);
});
await check("words: no easy/tough schedule wording, nothing called a forecast, American spelling (contract §11)", () => {
  const visible = Object.values(COLS).map((d) => (d.label || "") + " " + (d.title || "")).join(" | ") + " | " +
    SG.STAT_GROUPS.qb.concat(...Object.values(SG.STAT_GROUPS)).map((g) => g.label + " " + (g.title || "")).join(" | ");
  assert.ok(!/\beasy\b|\btough\b|soft schedule|hard schedule/i.test(visible), "easy/tough");
  assert.ok(!/(?<!not a |isn’t a |isn't a )\bforecast\b/i.test(visible.replace(/not a forecast|isn’t a forecast/g, "")), "forecast");
  const body = SRC.slice(SRC.indexOf("<body"));
  // (aria-labelledby is an HTML attribute, not a word on screen.)
  for (const w of ["colour", "favour", "behaviour", "labelled", "analyse", "centre", "organis", "optimis", "defence"]) assert.ok(!new RegExp("\\b" + w, "i").test(body.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "").replace(/aria-labelledby/g, "")), w);
});
await check("the screen's order: heading → Season · Window · Position → Stat group → search and sort → More filters → band → table → About (contract §1)", () => {
  const sec = SRC.slice(SRC.indexOf('<section id="asw-view-player-stats">'), SRC.indexOf("</section>", SRC.indexOf('<section id="asw-view-player-stats">')));
  const at = (s) => { const i = sec.indexOf(s); assert.ok(i >= 0, s); return i; };
  const order = ['id="asw-season"', 'id="asw-scope"', 'id="asw-tabs"', 'id="asw-groups"', 'id="asw-search"', 'id="asw-sort"', 'id="asw-more-btn"', 'id="asw-more"', 'id="asw-band"', 'id="asw-table-wrap"', 'id="asw-about"'].map(at);
  for (let i = 1; i < order.length; i++) assert.ok(order[i] > order[i - 1], "out of order at " + i);
  const more = sec.slice(at('id="asw-more"'), at('id="asw-band"'));
  for (const id of ["asw-team", "asw-seasons", "asw-cols-bar", "asw-compare-mode"]) assert.ok(more.includes('id="' + id + '"'), id + " is under More filters");
  assert.match(sec, /<div class="asw-more" id="asw-more" hidden>/, "More filters starts closed");
  assert.match(sec, /aria-expanded="false" aria-controls="asw-more"/);
  assert.ok(!/asw-filters-pill/.test(sec), "the old Filters pill is gone");
  assert.match(SRC, /<h1 id="asw-page-title">Player Stats<\/h1>/, "no version badge in the heading (it's in About)");
});
await check("accessibility (contract §10): focus ring on names, the closed drawer out of the tab order, a focus trap, light-theme contrast", () => {
  assert.match(SRC, /\.asw-table \.asw-pname:focus-visible\{outline:2px solid var\(--accent\)/);
  assert.match(SRC, /\.asw-drawer\{visibility:hidden;transition:transform \.22s ease,visibility 0s linear \.22s\}\n\.asw-drawer\.open\{visibility:visible;/);
  assert.match(SCRIPT, /drawerEl\.addEventListener\("keydown", function \(e\) \{\n    if \(e\.key !== "Tab"/);
  assert.match(SRC, /html\[data-theme="light"\]\{[\s\S]*?--muted:rgba\(14,17,24,\.62\)/, "light muted text ≥ 4.5:1 on white and the light panel");
  assert.match(SRC, /\.asw-ctl \.asw-tab\[aria-pressed="true"\]\{background:var\(--accent\);color:var\(--bg\)/);
  assert.ok(!/aria-describedby="asw-season-note"/.test(SRC), "no reference to a missing element");
});
await check("layout: the page never scrolls sideways; the table scrolls in its own region; [hidden] wins; the drawer is a dialog", () => {
  assert.match(SRC, /\.asw-compare-bar\[hidden\]\{display:none!important\}/);
  assert.match(SRC, /\.asw-ctl-f\[hidden\],\.asw-more\[hidden\]\{display:none!important\}/);
  assert.match(SRC, /\.asw-ctl\{display:flex;flex-wrap:wrap;/, "controls wrap instead of widening the page");
  assert.match(SRC, /\.asw-table\.no-sel td\.name,\.asw-table\.no-sel th\.name-col\{left:40px\}/, "the frozen Player column without the compare column");
  assert.match(SRC, /#asw-view-player-stats \.asw-table-wrap\{max-height:calc\(100vh - 16px\);overflow:auto\}/, "the table is a region one window tall, so its header row stays in view");
  assert.match(SRC, /<aside class="asw-drawer" id="asw-drawer" aria-hidden="true" role="dialog" aria-modal="true" aria-labelledby="asw-drawer-title">/);
});

// ── B. the real page on production's own 2025 answers ──
function richen(doc) {
  const P = Object.getPrototypeOf(doc.body);
  const detach = (n) => { const p = n.parentNode; if (!p) return; p.childNodes = p.childNodes.filter((x) => x !== n); p.children = p.children.filter((x) => x !== n); n.parentNode = null; };
  Object.assign(P, {
    appendChild(n) { detach(n); n.parentNode = this; this.childNodes.push(n); if (n.tagName !== "#TEXT") this.children.push(n); return n; },
    insertBefore(n, ref) { if (!ref) return this.appendChild(n); detach(n); n.parentNode = this; this.childNodes.splice(this.childNodes.indexOf(ref), 0, n); this.children = this.childNodes.filter((x) => x.tagName !== "#TEXT"); return n; },
    removeChild(n) { detach(n); return n; },
    removeAttribute(k) { delete this.attrs[k]; },
    remove() { detach(this); },
    contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; },
    insertAdjacentHTML(where, html) { const tmp = doc.createElement("div"); tmp.innerHTML = html; const kids = tmp.childNodes.slice(); if (where === "beforeend") kids.forEach((k) => this.appendChild(k)); else if (where === "afterbegin") kids.reverse().forEach((k) => this.insertBefore(k, this.childNodes[0])); else throw new Error("insertAdjacentHTML " + where); },
    dispatchEvent(ev) { return this.dispatch(ev.type, ev); },
    blur() {}, scrollIntoView() {},
  });
  Object.defineProperty(P, "classList", { get() { const n = this; const list = () => (n.attrs.class || "").split(/\s+/).filter(Boolean); const set = (l) => { n.attrs.class = l.join(" "); };
    return { contains: (c) => list().includes(c), add: (...c) => set([...new Set(list().concat(c))]), remove: (...c) => set(list().filter((x) => !c.includes(x))),
      toggle: (c, f) => { const has = list().includes(c); const want = f === undefined ? !has : !!f; if (want && !has) set(list().concat(c)); if (!want && has) set(list().filter((x) => x !== c)); return want; } }; } });
  const tc = Object.getOwnPropertyDescriptor(P, "textContent");
  Object.defineProperty(P, "textContent", { get: tc.get, set(v) { this.childNodes = []; this.children = []; this.__html = ""; const t = doc.createElement("#text"); t.text = String(v); t.parentNode = this; this.childNodes.push(t); } });
  Object.defineProperty(P, "className", { get() { return this.attrs.class || ""; }, set(v) { this.attrs.class = String(v); } });
  Object.defineProperty(P, "id", { get() { return this.attrs.id || ""; }, set(v) { this.attrs.id = String(v); } });
  Object.defineProperty(P, "innerText", { get() { return this.textContent; }, set(v) { this.textContent = v; } });
  Object.defineProperty(P, "selected", { get() { return "selected" in this.attrs; }, set(v) { if (v) this.attrs.selected = ""; else delete this.attrs.selected; if (v && this.parentNode && this.parentNode.tagName === "SELECT" && !("multiple" in this.parentNode.attrs)) { this.parentNode.options.forEach((o) => { if (o !== this) delete o.attrs.selected; }); delete this.parentNode.__props.v; } } });
  Object.defineProperty(P, "checked", { get() { return !!this.__props.checked || ("checked" in this.attrs && this.__props.checked !== false); }, set(v) { this.__props.checked = !!v; } });
  Object.defineProperty(P, "selectedOptions", { get() { return this.options.filter((o) => o.selected); } });
  const vd = Object.getOwnPropertyDescriptor(P, "value");
  Object.defineProperty(P, "value", { get: vd.get, set(v) { if (this.tagName === "SELECT") { this.options.forEach((o) => { if (o.value === String(v)) o.attrs.selected = ""; else delete o.attrs.selected; }); } this.__props.v = String(v); } });
  doc.createTextNode = (t) => { const n = doc.createElement("#text"); n.text = String(t); return n; };
  doc.documentElement = doc.createElement("html");
  Object.defineProperty(doc.documentElement, "scrollHeight", { value: 1000 });
  return doc;
}
const BODY = SRC.slice(SRC.indexOf("<body>") + 6, SRC.indexOf("</body>")).replace(/<script[\s\S]*?<\/script>/g, "");
function route(url) {
  const u = new URL(url), name = u.pathname.split("/").pop();
  if (name === "advanced-stats-leaderboard") return FX["leaderboard:" + u.searchParams.get("pos")];
  if (FX[name]) return FX[name];
  if (/league-years/.test(name)) return { ok: true, years: [2025, 2026] };
  return null;
}
async function boot(hash) {
  const doc = richen(makeDocument());
  doc.body.innerHTML = BODY;
  const calls = [], writes = [];
  let hashNow = hash || "";
  const store = {};
  const c = vm.createContext({ console: { log() {}, warn() {}, error() {}, info() {} }, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, Promise, URL, URLSearchParams, JSON, Math, Date, Intl,
    String, Number, Object, Array, RegExp, Set, Map, Error, isNaN, isFinite, parseInt, parseFloat, encodeURIComponent, decodeURIComponent, Symbol, Infinity, NaN });
  c.window = c; c.document = doc; c.self = c; c.parent = { postMessage() {} };
  c.navigator = { userAgent: "node", clipboard: { writeText: () => Promise.resolve() } };
  c.location = { get hash() { return hashNow; }, set hash(v) { hashNow = v; }, href: "https://x.test/stats_workbench.html", search: "", pathname: "/stats_workbench.html", hostname: "x.test", origin: "https://x.test" };
  c.history = { replaceState(a, b, h) { hashNow = h; } };
  c.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  c.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
  c.requestAnimationFrame = (f) => setTimeout(f, 0);
  c.getComputedStyle = () => ({ getPropertyValue: () => "" });
  c.addEventListener = () => {}; c.removeEventListener = () => {};
  c.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } preventDefault() { this.defaultPrevented = true; } stopPropagation() { this.__stop = true; } };
  c.Blob = class {}; c.alert = () => {}; c.confirm = () => false; c.prompt = () => null;
  c.fetch = (url, init) => {
    const m = (init && init.method) || "GET"; calls.push({ m, url: String(url) });
    if (m !== "GET") { writes.push(String(url)); return Promise.reject(new Error("write refused")); }
    const body = route(String(url));
    return Promise.resolve({ ok: !!body, status: body ? 200 : 404, json: () => Promise.resolve(JSON.parse(JSON.stringify(body || { ok: false }))), text: () => Promise.resolve(JSON.stringify(body || {})) });
  };
  vm.runInContext(SCRIPT, c);
  await settle(40);
  const $ = (s) => doc.querySelector(s), $$ = (s) => doc.querySelectorAll(s);
  const env = { doc, c, calls, writes, $, $$, hash: () => hashNow };
  env.click = async (el) => { assert.ok(el, "nothing to click"); el.click(); await settle(30); };
  env.change = async (sel, v) => { const el = $(sel); el.value = v; el.dispatch("change"); await settle(30); };
  env.headers = () => $$("#asw-body thead tr.asw-col-row th").filter((t) => t.getAttribute("data-col-key")).map((t) => t.getAttribute("data-col-key"));
  env.sorted = () => { const t = $$("#asw-body thead tr.asw-col-row th").find((x) => x.getAttribute("aria-sort")); return t ? [t.getAttribute("data-col-key"), t.getAttribute("aria-sort")] : null; };
  env.col = (k) => { const ths = $$("#asw-body thead tr.asw-col-row th"); const i = ths.findIndex((t) => t.getAttribute("data-col-key") === k); return $$("#asw-body tbody tr").map((tr) => tr.children[i] && tr.children[i].textContent.trim()); };
  env.meta = () => $("#asw-meta").textContent;
  return env;
}
const num = (t) => { t = String(t || "").replace(/−/g, "-").replace(/[%,+]/g, ""); if (t === "—" || !t) return null; const m = /^-?\d+(\.\d+)?/.exec(t); return m ? parseFloat(m[0]) : null; };
function inOrder(vals, dir, where) {
  const v = vals.map(num), firstNull = v.indexOf(null);
  if (firstNull >= 0) assert.ok(v.slice(firstNull).every((x) => x === null), where + ": a value after '—' (— sorts last both ways)");
  const n = v.filter((x) => x !== null);
  for (let i = 1; i < n.length; i++) assert.ok(dir === "descending" ? n[i] <= n[i - 1] + 1e-9 : n[i] >= n[i - 1] - 1e-9, where + ": " + n[i - 1] + " then " + n[i]);
}
const LABEL = { qb: "QB", rb: "RB", wr: "WR", te: "TE", flex_o: "Flex·O", dl: "DL", lb: "LB", db: "DB", flex_idp: "Flex·IDP", pk: "PK", pn: "PN" };

console.log("\nB. the real page, every position and stat group (production's own 2025 answers, trimmed)");
const E = await boot("#tab=qb&seasons=2025&scope=mfl_total");
let views = 0, sorted = 0;
await check("it boots on Fantasy points with the controls in place", () => {
  assert.deepStrictEqual(E.headers(), ["player_name", "pos_rank", "mfl_points", "mfl_ppg", "games"]);
  assert.deepStrictEqual(E.sorted(), ["mfl_points", "descending"]);
  assert.strictEqual(E.$("#asw-season").value, "2025");
  assert.match(E.meta(), /^QB · 2025 · MFL Total \(Wks 1–17\) · Sources: MFL scoring \(this league’s rules\); nflverse box scores · read \d{1,2}:\d\d [AP]M ET$/);
});
for (const tab of TAB_IDS) {
  await E.click(E.$('#asw-tabs [data-tab="' + tab + '"]'));
  for (const g of SG.STAT_GROUPS[tab]) {
    await check(tab + " · " + g.label + ": its columns, its sort both ways (— last), the band, the Player cell, About", async () => {
      await E.click(E.$('#asw-groups [data-group="' + g.id + '"]'));
      views++;
      assert.deepStrictEqual(E.headers(), ["player_name"].concat(g.cols), "columns");
      assert.strictEqual(E.$$('#asw-groups [aria-pressed="true"]').map((b) => b.getAttribute("data-group")).join(), g.id, "the group button is pressed");
      assert.strictEqual(E.$$('#asw-tabs .asw-tab[aria-pressed="true"]').map((b) => b.getAttribute("data-tab")).join(), tab, "the position button is pressed");
      assert.deepStrictEqual(E.sorted(), [g.sort, "descending"], "the group's default sort");
      assert.strictEqual(E.$("#asw-sort").value, g.sort, "Sort by says the same");
      assert.match(E.$("#asw-sort-dir").textContent, /^▼ High to low$/);
      inOrder(E.col(g.sort), "descending", tab + "/" + g.id + "/" + g.sort);
      E.$('#asw-body th[data-col-key="' + g.sort + '"]').click(); await settle(10);
      assert.deepStrictEqual(E.sorted(), [g.sort, "ascending"]);
      assert.match(E.$("#asw-sort-dir").textContent, /^▲ Low to high$/);
      inOrder(E.col(g.sort), "ascending", tab + "/" + g.id + "/" + g.sort);
      sorted += 2;
      const m = E.meta();
      assert.ok(m.startsWith(LABEL[tab] + " · 2025 · MFL Total (Wks 1–17) · Sources: " + g.src.map((s) => SG.SG_SRC[s]).join("; ")), m);
      const rows = E.$$("#asw-body tbody tr");
      assert.ok(rows.length >= 3, rows.length + " rows");
      for (const tr of rows) {
        const cell = tr.querySelector("td.name");
        assert.ok(cell && cell.querySelector("button.asw-pname") && / · /.test(cell.querySelector(".asw-psub").textContent), "Player cell: a name button and NFL team · owner");
      }
      if (tab === "flex_o" || tab === "flex_idp") assert.match(rows[0].querySelector(".asw-psub").textContent, /^[A-Z]{1,3} · /, "the Flex tabs lead with the position");
      assert.ok(!rows.some((tr) => tr.querySelector(".asw-compare-check")), "no compare checkboxes unless asked");
      const about = E.$("#asw-about-body").textContent;
      for (const k of g.cols) assert.ok(about.includes(COLS[k].label + COLS[k].title), "About defines " + k);
      const cnt = /^(\d+) of (\d+) players$|^(\d+) players?$/.exec(E.$("#asw-count").textContent);
      assert.ok(cnt && !(cnt[1] && +cnt[1] > +cnt[2]), "count: " + E.$("#asw-count").textContent);
    });
  }
}
await check("the whole sweep ran: every position × group, each default sort both ways", () => {
  assert.strictEqual(views, Object.values(SG.STAT_GROUPS).reduce((n, gs) => n + gs.length, 0)); assert.strictEqual(sorted, views * 2);
});
await check("every column sorts as a number, both ways, '—' last: all of PK Kicking and DB IDP (made/attempted as numbers, not text)", async () => {
  for (const [tab, grp] of [["pk", "kicking"], ["db", "idp"], ["wr", "receiving"]]) {
    await E.click(E.$('#asw-tabs [data-tab="' + tab + '"]')); await E.click(E.$('#asw-groups [data-group="' + grp + '"]'));
    for (const k of E.headers().slice(1)) {
      const th = () => E.$('#asw-body th[data-col-key="' + k + '"]');
      th().click(); await settle(5);
      if (E.sorted()[1] !== "descending") { th().click(); await settle(5); }
      assert.deepStrictEqual(E.sorted(), [k, "descending"], tab + "/" + k);
      inOrder(E.col(k), "descending", tab + "/" + k);
      th().click(); await settle(5);
      assert.deepStrictEqual(E.sorted(), [k, "ascending"], tab + "/" + k);
      inOrder(E.col(k), "ascending", tab + "/" + k);
    }
  }
  await E.click(E.$('#asw-tabs [data-tab="pk"]')); await E.click(E.$('#asw-groups [data-group="kicking"]'));
  assert.ok(E.col("fg_40_49").some((v) => /^\d+\/\d+$/.test(v)), "the distance cells show made/attempted");
  await E.click(E.$('#asw-groups [data-group="schedule"]'));   // leave PK where the sweep left it
});
await check("switching position keeps the stat group when the new one has it (WR Receiving → TE Receiving); else the group last used there; Fantasy points the first time", async () => {
  await E.click(E.$('#asw-tabs [data-tab="wr"]')); await E.click(E.$('#asw-groups [data-group="receiving"]'));
  await E.click(E.$('#asw-tabs [data-tab="te"]'));
  assert.strictEqual(E.$('#asw-groups [aria-pressed="true"]').getAttribute("data-group"), "receiving");
  await E.click(E.$('#asw-tabs [data-tab="pk"]'));
  assert.strictEqual(E.$('#asw-groups [aria-pressed="true"]').getAttribute("data-group"), "schedule", "PK's last group (the sweep above ended PK on Schedule)");
  assert.match(E.hash(), /tab=pk.*grp=schedule/, "the link carries the group");
  const F = await boot("#tab=wr&seasons=2025&scope=mfl_total&grp=receiving");
  await F.click(F.$('#asw-tabs [data-tab="pk"]'));
  assert.strictEqual(F.$('#asw-groups [aria-pressed="true"]').getAttribute("data-group"), "fantasy", "a position not visited yet opens on Fantasy points");
});
await check("DL / DB sub-positions (DE, DT · CB, S) are their own buttons beside Position, not inside the DL button", async () => {
  await E.click(E.$('#asw-tabs [data-tab="dl"]'));
  const subs = E.$$(".asw-ctl-pos .asw-subtab-group .asw-subtab");
  assert.deepStrictEqual(subs.map((b) => b.textContent), ["All", "DT", "DE"]);
  assert.strictEqual(E.$('#asw-tabs [data-tab="dl"]').querySelectorAll("button").length, 0, "no button inside a button");
  const all = E.$$("#asw-body tbody tr").length;
  await E.click(subs[2]);
  const de = E.$$("#asw-body tbody tr").length;
  assert.ok(de > 0 && de < all, "DE narrows the list: " + de + " of " + all);
  assert.strictEqual(subs[2].getAttribute("aria-pressed"), "true");
  await E.click(E.$('#asw-tabs [data-tab="lb"]'));
  assert.strictEqual(E.$$(".asw-subtab-group").length, 0, "LB has none");
});
await check("every window asks the server for its weeks and the band names them; the group stays", async () => {
  await E.click(E.$('#asw-tabs [data-tab="wr"]')); await E.click(E.$('#asw-groups [data-group="receiving"]'));
  for (const [w, lo, hi, label] of [["mfl_reg", 1, 14, "MFL Reg (Wks 1–14)"], ["mfl_playoffs", 15, 17, "MFL Playoffs (Wks 15–17)"], ["full", 1, 22, "Full + NFL Playoffs (Wks 1–22)"], ["mfl_total", 1, 17, "MFL Total (Wks 1–17)"]]) {
    const before = E.calls.length;
    await E.change("#asw-scope", w);
    const lb = E.calls.slice(before).find((x) => /advanced-stats-leaderboard/.test(x.url));
    assert.ok(lb && new URL(lb.url).searchParams.get("week_min") === String(lo) && new URL(lb.url).searchParams.get("week_max") === String(hi), w + ": " + (lb && lb.url));
    assert.ok(E.meta().startsWith("WR · 2025 · " + label), E.meta());
    assert.strictEqual(E.$('#asw-groups [aria-pressed="true"]').getAttribute("data-group"), "receiving");
  }
  await E.change("#asw-scope", "custom");
  assert.ok(!E.$("#asw-weeks-label").hasAttribute("hidden"), "Custom shows the week pickers");
  await E.change("#asw-week-start", "3"); await E.change("#asw-week-end", "8");
  assert.ok(E.meta().startsWith("WR · 2025 · Wks 3–8"), E.meta());
  await E.change("#asw-scope", "mfl_total");
  assert.ok(E.$("#asw-weeks-label").hasAttribute("hidden"));
});
await check("Season: one season at a time; an old season is asked for as itself (never another substituted)", async () => {
  for (const y of ["2011", "2026", "2025"]) {
    const before = E.calls.length;
    await E.change("#asw-season", y);
    const lb = E.calls.slice(before).find((x) => /advanced-stats-leaderboard/.test(x.url));
    assert.strictEqual(new URL(lb.url).searchParams.get("seasons"), y);
    assert.ok(E.meta().startsWith("WR · " + y + " · "), E.meta());
  }
});
await check("two seasons (More filters → Add seasons): asked for together, the band and the Season box say so, More filters counts it", async () => {
  await E.click(E.$("#asw-more-btn"));
  assert.strictEqual(E.$("#asw-more-btn").getAttribute("aria-expanded"), "true"); assert.ok(!E.$("#asw-more").hasAttribute("hidden"));
  const sel = E.$("#asw-seasons"); sel.options.forEach((o) => { o.selected = o.value === "2024" || o.value === "2025"; });
  const before = E.calls.length; sel.dispatch("change"); await settle(30);
  const lb = E.calls.slice(before).find((x) => /advanced-stats-leaderboard/.test(x.url));
  assert.deepStrictEqual(new URL(lb.url).searchParams.get("seasons").split(",").sort(), ["2024", "2025"]);
  assert.ok(/^WR · 2025, 2024 · /.test(E.meta()), E.meta());
  assert.strictEqual(E.$("#asw-season").selectedOptions[0].textContent, "2024 + 2025");
  assert.strictEqual(E.$("#asw-more-n").textContent, "(1)");
  await E.change("#asw-season", "2025");
  assert.deepStrictEqual(E.$("#asw-seasons").options.filter((o) => o.selected).map((o) => o.value), ["2025"], "picking one season again clears the others");
  await E.click(E.$("#asw-more-btn")); assert.ok(E.$("#asw-more").hasAttribute("hidden"));
});
await check("compare: checkboxes only while 'Select players to compare' is on; the bar only with a player picked", async () => {
  assert.strictEqual(E.$$("#asw-body .asw-compare-check").length, 0);
  assert.ok(E.$("#asw-body table").classList.contains("no-sel"));
  const cm = E.$("#asw-compare-mode"); cm.checked = true; cm.dispatch("change"); await settle(10);
  assert.ok(E.$$("#asw-body .asw-compare-check").length > 0); assert.ok(!E.$("#asw-body table").classList.contains("no-sel"));
  assert.ok(E.$("#asw-compare-bar").hasAttribute("hidden"), "nothing picked: no bar");
  cm.checked = false; cm.dispatch("change"); await settle(10);
  assert.strictEqual(E.$$("#asw-body .asw-compare-check").length, 0);
});
await check("keyboard: a header sorts with Enter; the name opens the drawer, a dialog that takes focus", async () => {
  const th = E.$('#asw-body th[data-col-key="rec_tds"]');
  assert.strictEqual(th.getAttribute("tabindex"), "0");
  th.focus(); th.dispatch("keydown", { key: "Enter" }); await settle(10);
  assert.deepStrictEqual(E.sorted(), ["rec_tds", "descending"]);
  assert.strictEqual(E.doc.activeElement && E.doc.activeElement.getAttribute("data-col-key"), "rec_tds", "focus stays on the header after a keyboard sort");
  const gb = E.$('#asw-groups [data-group="usage"]'); gb.focus(); gb.click(); await settle(10);
  assert.strictEqual(E.doc.activeElement, gb, "choosing a stat group keeps focus on its button (updated in place)");
  assert.strictEqual(gb.getAttribute("aria-pressed"), "true");
  await E.click(E.$('#asw-groups [data-group="receiving"]'));
  const nameBtn = E.$("#asw-body tbody tr .asw-pname");
  nameBtn.focus(); nameBtn.click(); await settle(30); await new Promise((r) => setTimeout(r, 60));   // (a real click focuses the button)
  assert.ok(E.$("#asw-drawer").classList.contains("open"));
  assert.strictEqual(E.doc.activeElement && E.doc.activeElement.id, "asw-drawer-close", "focus on Close");
  const chips = E.$("#asw-drawer-body").textContent;
  assert.ok(!/Xpert #|⚕/.test(chips), "no expert rank, no market injury word");
  E.$("#asw-drawer-close").click(); await settle(5); await new Promise((r) => setTimeout(r, 10));
  assert.ok(!E.$("#asw-drawer").classList.contains("open"));
  assert.ok(E.doc.activeElement && /asw-pname/.test(E.doc.activeElement.className), "focus back on the player's name");
});
await check("Custom columns (More filters → a preset): the group reads 'Custom columns', Pos Rk follows Player, the band points to About", async () => {
  await E.click(E.$("#asw-more-btn"));
  await E.click(E.$('#asw-cols-bar [data-view="advanced"]'));
  assert.strictEqual(E.$('#asw-groups [aria-pressed="true"]').getAttribute("data-group"), "custom");
  assert.deepStrictEqual(E.headers().slice(0, 2), ["player_name", "pos_rank"]);
  assert.ok(E.headers().length > 9);
  assert.match(E.meta(), / · Custom columns: sources under About/);
  assert.match(E.hash(), /grp=custom/);
  await E.click(E.$('#asw-groups [data-group="fantasy"]'));
  assert.deepStrictEqual(E.headers(), ["player_name", "pos_rank", "mfl_points", "mfl_ppg", "games"], "a stat group again");
});
await check("the count's total uses the same position rule as the rows (was '206 of 205 players')", async () => {
  await E.click(E.$('#asw-tabs [data-tab="dl"]'));
  assert.match(E.$("#asw-count").textContent, /^\d+ players$/, E.$("#asw-count").textContent);
  E.$("#asw-search").value = "zz-nobody"; E.$("#asw-search").dispatch("input"); await settle(5);
  assert.match(E.$("#asw-count").textContent, /^0 of \d+ players \(search\)$/);
  E.$("#asw-search").value = ""; E.$("#asw-search").dispatch("input"); await settle(5);
});
await check("heat (a link with heat=1) never colors Sched Δ or Opp ±%", async () => {
  const H = await boot("#tab=qb&seasons=2025&scope=mfl_total&grp=schedule&heat=1");
  const ths = H.$$("#asw-body thead tr.asw-col-row th"), idx = ["mfl_points_sos", "mfl_sched_opp"].map((k) => ths.findIndex((t) => t.getAttribute("data-col-key") === k));
  assert.ok(idx.every((i) => i > 0));
  assert.ok(H.$$("#asw-body td").some((td) => /pct-q/.test(td.attrs.class || "")), "heat is on for other columns");
  for (const tr of H.$$("#asw-body tbody tr")) for (const i of idx) assert.ok(!/pct-q/.test(tr.children[i].attrs.class || ""), "colored");
});
await check("an older link (view=advanced, no grp=) opens its custom columns; a Standard link opens Fantasy points", async () => {
  const A = await boot("#tab=wr&seasons=2025&scope=mfl_total&view=advanced");
  assert.strictEqual(A.$('#asw-groups [aria-pressed="true"]').getAttribute("data-group"), "custom");
  const B = await boot("#tab=wr&seasons=2025&scope=mfl_total&view=standard");
  assert.strictEqual(B.$('#asw-groups [aria-pressed="true"]').getAttribute("data-group"), "fantasy");
  const C = await boot("#tab=rb&seasons=2025&scope=mfl_total&grp=redzone");
  assert.deepStrictEqual(C.headers(), ["player_name"].concat(SG.STAT_GROUPS.rb.find((g) => g.id === "redzone").cols));
});
await check("nothing was written: every request was a GET", () => { assert.deepStrictEqual(E.writes, []); assert.ok(E.calls.length > 20); });

console.log(fails ? `\n${fails} FAILED (${passes} passed)` : `\nall ${passes} passed (${views} position × group views, ${sorted} sorts checked)`);
process.exit(fails ? 1 : 0);
