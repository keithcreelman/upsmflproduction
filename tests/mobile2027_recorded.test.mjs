// UPS 2027 Preview: recorded-data mode.
//   node tests/mobile2027_recorded.test.mjs
//
// Offline. The committed bundle (apps/mobile2027/src/recorded_data.js) is the only data the page reads in recorded mode. What is proven:
//   (a) the bundle: its meta, canonical route keys, the same routes as the committed recording manifest, no forbidden pattern, only the allowlisted
//       fields of each route, and a size cap; the generator refuses a secret, an unknown route and an unreadable recording;
//   (b) ZERO NETWORK: the real app runs in a vm in which fetch, XMLHttpRequest and navigator.sendBeacon all throw, and is tapped through every screen
//       (boot, Roster lineup and byes, a past week, Contracts with its Breakdown, a category, the 2027 row, every sort, Performance, a profile and its
//       Performance tab, Help, About, Sample mode on and off): nothing throws, nothing is unrecorded, no "Couldn't load" text appears, and the key
//       figures draw;
//   (c) a route that was not recorded answers a 404-like failure, is counted, and the screen's normal failure path runs; a missing bundle never
//       falls back to the network;
//   (d) the config switch: "live" still uses the supplied fetch (and never the recording); an unknown mode makes no request at all.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..", "apps", "mobile2027");
const SRC = path.join(APP, "src");
const require = createRequire(import.meta.url);
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const tick = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const R = require(path.join(SRC, "lib/recorded.js"));
const D = require(path.join(SRC, "lib/data.js"));
const BUILD = await import(pathToFileURL(path.join(APP, "scripts/build.mjs")).href);
const GEN = await import(pathToFileURL(path.join(APP, "scripts/record_bundle.mjs")).href);
// The injury resolver the page loads is the beta's DERIVED copy, made from the reviewed copy of the classic file (tests never read site/shared/).
const FIXSH = path.join(HERE, "fixtures/mobile2027/shared");
const INJURY_PURE = BUILD.derivedBytes(BUILD.DERIVED[0], FIXSH).toString("utf8");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(APP, "recording_manifest.json"), "utf8"));
const BUNDLE_PATH = path.join(SRC, "recorded_data.js");
const BUNDLE_TEXT = fs.readFileSync(BUNDLE_PATH, "utf8");
const SIZE_CAP = 3 * 1024 * 1024;   // the stated cap: the bundle ships with the page, and a phone parses it on every open

// the bundle, read the way the page reads it: a plain script that sets window.UPS2027_RECORDED
function loadBundle() { const c = vm.createContext({}); c.window = c; vm.runInContext(BUNDLE_TEXT, c, { filename: "recorded_data.js" }); return JSON.parse(JSON.stringify(c.UPS2027_RECORDED)); }
const BUNDLE = loadBundle();
const CFG = (() => { const c = vm.createContext({}); c.window = c; vm.runInContext(read("config.js"), c); return JSON.parse(JSON.stringify(c.UPS2027_CONFIG)); })();
const ROSTER_ROUTE = R.canonical("/roster-workbench?L=74598&YEAR=2026");

// ───────────────────────── (a) the bundle ─────────────────────────
test("the committed bundle: meta, canonical keys, the recording's routes, and a size under the cap", () => {
  t.deepEqual(Object.keys(BUNDLE).sort(), ["meta", "routes"]);
  t.deepEqual(Object.keys(BUNDLE.meta).sort(), ["league", "note", "recordedAt", "routeCount", "season", "source"]);
  const earliest = MANIFEST.items.map((i) => Date.parse(i.retrieved_at)).sort((a, b) => a - b)[0];
  t.equal(BUNDLE.meta.recordedAt, new Date(earliest).toISOString().replace(/\.\d{3}Z$/, "Z"), "recordedAt is the earliest retrieved_at, in UTC");
  t.equal(BUNDLE.meta.recordedAt, "2026-11-22T15:22:25Z");
  t.equal(BUNDLE.meta.source, "public read-only routes of the UPS Worker"); t.equal(BUNDLE.meta.league, "74598"); t.equal(BUNDLE.meta.season, "2026");
  t.match(BUNDLE.meta.note, /recorded snapshot/i); t.match(BUNDLE.meta.note, /not a live read/i);
  const keys = Object.keys(BUNDLE.routes);
  t.equal(BUNDLE.meta.routeCount, keys.length); t.equal(keys.length, MANIFEST.items.length);
  keys.forEach((k) => {
    t.equal(R.canonical(k), k, "canonical: " + k);
    t.ok(GEN.kindOfRoute(k), "a route the app asks for: " + k);
    const names = [...new URL("http://x" + k).searchParams.keys()]; t.deepEqual(names, names.slice().sort(), "query names are sorted: " + k);
    t.ok(BUNDLE.routes[k] && typeof BUNDLE.routes[k] === "object", "parses to an object: " + k);
  });
  t.deepEqual(keys.slice().sort(), MANIFEST.items.map((i) => R.canonical(i.path)).sort(), "the route list equals the recording manifest's");
  MANIFEST.items.forEach((i) => t.equal(i.status, 200, i.key + " answered 200 when it was recorded"));
  // every read the app can make is in the recording: the loader's own addresses for the weeks that were recorded
  const u = D.createLoader(CFG, async () => { throw new Error("none"); }).urls;
  const asked = [u.roster, u.league, u.week, u.players, u.penalty, u.status, u.matchups(11), u.nextSeason, u.byes, u.fullSchedule, u.schedule(10), u.schedule(11)];
  for (let w = 1; w <= 11; w++) asked.push(u.weekly(w), u.scores(w));
  asked.forEach((a) => t.ok(Object.prototype.hasOwnProperty.call(BUNDLE.routes, R.canonical(a)), "recorded: " + a.replace(/^https:\/\/[^/]+/, "")));
  t.ok(Buffer.byteLength(BUNDLE_TEXT) < SIZE_CAP, "the bundle is under " + SIZE_CAP + " bytes (" + Buffer.byteLength(BUNDLE_TEXT) + ")");
  t.equal(GEN.render(BUNDLE), BUNDLE_TEXT, "the file is exactly what the generator writes for its own content (deterministic, and not edited by hand)");
});

test("the bundle holds only allowlisted fields, nothing heavy the app never reads, and nothing that looks like a secret or private text", () => {
  Object.keys(BUNDLE.routes).forEach((k) => {
    const clean = GEN.sanitizeRoute(k, BUNDLE.routes[k]);
    t.deepEqual(clean, BUNDLE.routes[k], "re-running the allowlist over " + k + " removes nothing");
  });
  ["extension_previews", "preview_contract_info_string", "exp_return", "return_date", "mfl_post_error", "upstream", "id_map_rows", "defRatings", "taxi_permanent_promotion", "ups_draft_round"].forEach((w) => t.ok(!BUNDLE_TEXT.includes(w), "not shipped: " + w));
  ["spread", "implied", "weather", "rushDefRank", "passDefRank", "rushOffenseRank", "hasPossession", "inRedZone", "opt_pts", "nonstarters", "optimal", "shouldStart", "isAvailable", "regularSeason", "bbidAvailableBalance", "stadium"].forEach((k) => t.ok(!BUNDLE_TEXT.includes('"' + k + '":'), "no such field is shipped: " + k));
  t.deepEqual(GEN.violations(BUNDLE), [], "no e-mail address, credential-like word or phone-like pattern in any key or string");
  t.deepEqual(BUILD.scan("recorded_data.js", BUNDLE_TEXT), [], "the build's secret scan is clean");
  t.deepEqual(BUILD.scanWriteCode("recorded_data.js", BUNDLE_TEXT), [], "the build's Preview scan is clean (no template literal, no write verb, no network word)");
  t.deepEqual(BUILD.scanWriteCode("lib/recorded.js", read("lib/recorded.js")), [], "and so is the recorded fetch");
  t.doesNotMatch(BUNDLE_TEXT, /`/); t.doesNotMatch(BUNDLE_TEXT, /\bfetch\b/i);
  // the roster keeps exactly the player fields the model reads, the player-status map keeps no expected-return text
  const p0 = BUNDLE.routes[ROSTER_ROUTE].teams[0].players[0];
  t.deepEqual(Object.keys(p0).filter((k) => !["id", "name", "position", "nfl_team", "points", "bye", "salary", "salary_unresolved", "years", "aav", "type", "special", "acquisition_text", "status", "espn_id", "order", "taxi_callups_used", "taxi_callups_max", "taxi_eligible", "taxi_status"].includes(k)), []);
});

test("the sanitization check refuses what it should and passes ordinary league data", () => {
  const bad = ["write to me@example.com", "APIKEY=abc", "api_key", "my token", "a Cookie", "session id", "Password", "Authorization: Bearer abcdefghijklmnop", "call (555) 123-4567", "555-123-4567", "555.123.4567"];
  bad.forEach((s) => t.ok(GEN.violations({ x: s }).length >= 1, "refused: " + s));
  t.ok(GEN.violations({ "token": 1 }).length >= 1, "a key is checked too");
  ["74598_franchise_icon0010.jpg", "1795137300", "CL 2|TCV 5K|AAV 1K, 4K|Y1-1K, Y2-4K|Ext: Bomb|GTD: 3.8K", "UPS drop penalty Helm, Gunnar 1000 id:adddrop2025_298.2", "2026-11-22T15:22:25.101Z", "Smith-Njigba, Jaxon", "0.2"].forEach((s) => t.deepEqual(GEN.violations({ x: s }), [], "ordinary: " + s));
});

test("the generator refuses a secret in a kept field, a route the app does not ask for, a failed read, and missing arguments; it writes nothing on refusal", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m27rec-"));
  const raw = path.join(dir, "raw"); fs.mkdirSync(raw);
  const mk = (items, files) => { Object.entries(files).forEach(([k, v]) => fs.writeFileSync(path.join(raw, k + ".json"), JSON.stringify(v))); const m = path.join(dir, "m.json"); fs.writeFileSync(m, JSON.stringify({ items })); return m; };
  const item = (key, p, o) => Object.assign({ key, path: p, status: 200, bytes: 1, retrieved_at: "2026-11-22T15:22:25Z" }, o || {});
  const rosterWith = (name) => ({ ok: true, generated_at: "2026-11-22T15:22:25.101Z", salary_cap_dollars: 300000, secret_extra: "dropped", teams: [{ franchise_id: "0010", franchise_name: "A", extra: "dropped", players: [{ id: "1", name, position: "QB", nfl_team: "KCC", extension_previews: [{ x: 1 }] }] }] });
  const okItems = [item("roster", "/roster-workbench?YEAR=2026&L=74598")];
  const good = GEN.buildBundle(raw, mk(okItems, { roster: rosterWith("Mahomes, Patrick") }));
  t.deepEqual(Object.keys(good.routes), ["/roster-workbench?L=74598&YEAR=2026"], "the key is the canonical route (query sorted)");
  t.deepEqual(good.routes["/roster-workbench?L=74598&YEAR=2026"].teams[0].players[0], { id: "1", name: "Mahomes, Patrick", position: "QB", nfl_team: "KCC" }, "unlisted fields are dropped");
  t.equal(good.routes["/roster-workbench?L=74598&YEAR=2026"].secret_extra, undefined);
  t.equal(good.meta.recordedAt, "2026-11-22T15:22:25Z"); t.equal(good.meta.routeCount, 1);
  t.equal(GEN.render(good), GEN.render(GEN.buildBundle(raw, mk(okItems, { roster: rosterWith("Mahomes, Patrick") }))), "the same recording gives the same file");
  t.throws(() => GEN.buildBundle(raw, mk(okItems, { roster: rosterWith("write me at someone@example.com") })), /sanitization check refused/);
  t.throws(() => GEN.buildBundle(raw, mk(okItems, { roster: rosterWith("Bearer abcdefghijklmnop") })), /sanitization check refused/);
  t.throws(() => GEN.buildBundle(raw, mk([item("roster", "/roster-workbench?L=74598&YEAR=2026"), item("x", "/admin/anything?L=74598")], { roster: rosterWith("A, B"), x: {} })), /does not ask for/);
  t.throws(() => GEN.buildBundle(raw, mk([item("roster", "/roster-workbench?L=74598&YEAR=2026", { status: 503 })], { roster: rosterWith("A, B") })), /did not answer 200/);
  t.throws(() => GEN.buildBundle(raw, mk([item("roster", "/roster-workbench?L=74598&YEAR=2026"), item("again", "/roster-workbench?YEAR=2026&L=74598")], { roster: rosterWith("A, B"), again: rosterWith("A, B") })), /share the route/);
  t.throws(() => GEN.buildBundle(raw, mk([item("week", "/api/current-lineup-week?L=74598&YEAR=2026")], { week: { ok: true, week: 11 } })), /no roster read/);
  t.throws(() => GEN.buildBundle(raw, mk([item("roster", "/roster-workbench?L=74598&YEAR=2026", { retrieved_at: "yesterday" })], { roster: rosterWith("A, B") })), /retrieved_at/);
  t.throws(() => GEN.buildBundle(raw, mk([item("missing", "/roster-workbench?L=74598&YEAR=2026")], {})), /ENOENT/);
  // the command line: both inputs are required, and a refusal writes no file
  const out = path.join(dir, "out.js");
  const { spawnSync } = await import("node:child_process");
  const noArgs = spawnSync(process.execPath, [path.join(APP, "scripts/record_bundle.mjs"), "--out", out], { encoding: "utf8" });
  t.equal(noArgs.status, 2); t.match(noArgs.stderr, /required; there are no defaults/); t.equal(fs.existsSync(out), false);
  const refused = spawnSync(process.execPath, [path.join(APP, "scripts/record_bundle.mjs"), "--raw", raw, "--manifest", mk(okItems, { roster: rosterWith("a@b.co") }), "--out", out], { encoding: "utf8" });
  t.equal(refused.status, 1); t.match(refused.stderr, /sanitization check refused/); t.equal(fs.existsSync(out), false, "nothing was written");
  const wrote = spawnSync(process.execPath, [path.join(APP, "scripts/record_bundle.mjs"), "--raw", raw, "--manifest", mk(okItems, { roster: rosterWith("Mahomes, Patrick") }), "--out", out], { encoding: "utf8" });
  t.equal(wrote.status, 0); t.match(wrote.stdout, /Sanitization check: passed/); t.match(wrote.stdout, /roster/); t.ok(fs.existsSync(out));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the recorded answer: canonical routes, GET only, a miss is a 404-like failure that is counted and never a network call", async () => {
  t.equal(R.canonical("https://host.example/api/mfl-export?W=1&TYPE=weeklyResults&YEAR=2026&JSON=1&L=74598"), "/api/mfl-export?JSON=1&L=74598&TYPE=weeklyResults&W=1&YEAR=2026", "origin ignored, names sorted");
  t.equal(R.canonical("/a?b=2&a=1&a=0#frag"), "/a?a=0&a=1&b=2", "equal names sort by value; the fragment is ignored");
  t.equal(R.canonical("/a?q=x%20y&r=%E2%9C%93"), "/a?q=x%20y&r=%E2%9C%93", "values are re-encoded the same way");
  t.equal(R.canonical("/a"), "/a?", "no query still has the separator");
  const f = R.createFetch({ routes: { "/a?x=1": { ok: true, n: [1, 2] } } });
  const hit = await f("https://anything.example/a?x=1", { method: "GET", credentials: "omit" });
  t.equal(hit.ok, true); t.equal(hit.status, 200); t.deepEqual(JSON.parse(await hit.text()), { ok: true, n: [1, 2] }); t.deepEqual(await hit.json(), { ok: true, n: [1, 2] });
  t.deepEqual(f.served, ["/a?x=1"]); t.deepEqual(f.misses, []);
  const miss = await f("https://anything.example/a?x=2");
  t.equal(miss.ok, false); t.equal(miss.status, 404); t.equal(await miss.text(), "");
  t.deepEqual(f.misses, ["/a?x=2"], "the unrecorded route is counted, not ignored");
  await f("/a?x=1", { method: "GET" });
  await f("/a?x=1", { method: "POST" }).then(() => t.ok(false, "a write must be refused"), (e) => t.match(String(e.message), /GET only/));
  t.deepEqual(f.misses, ["/a?x=2", "POST /a?x=1"], "a refused method is counted too");
  t.ok(R.misses.length >= 2, "and the module keeps the combined list");
  const none = R.createFetch(undefined); t.equal((await none("/a?x=1")).status, 404); t.equal(none.routeCount, 0);
  t.equal((await R.createFetch({ routes: [] })("/a?x=1")).status, 404, "an array is not a route table");
  t.equal((await R.createFetch({ routes: { "/a?x=1": {} } })("/constructor?")).status, 404, "inherited object keys are not routes");
});

// ───────────────────────── the page, run for real ─────────────────────────
// A stub page and a vm: the real files run in a context whose fetch, XMLHttpRequest and sendBeacon throw (and record the attempt).
function boot({ data, bundle, fetchImpl, hash = "" } = {}) {
  const net = [];
  const trap = (name) => (...a) => { net.push(name + " " + String(a[0])); throw new Error("NETWORK ATTEMPT: " + name); };
  const listeners = {}, winL = {}, docAttrs = {}, storage = {};
  const appEl = { innerHTML: "", addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); }, contains: () => true, querySelector: () => null, querySelectorAll: () => [] };
  const location = { hash, pathname: "/", search: "" };
  const history = { state: null, pushState(s, _t, u) { this.state = s; location.hash = u; }, replaceState(s) { this.state = s; location.hash = ""; }, back() { this.state = null; location.hash = ""; (winL.popstate || (() => {}))(); } };
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, URL, URLSearchParams, AbortController: undefined,
    document: { getElementById: (id) => (id === "app" ? appEl : null), documentElement: { setAttribute(k, v) { docAttrs[k] = v; } }, activeElement: null, title: "" },
    localStorage: { getItem: (k) => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v); } },
    history, location, navigator: { sendBeacon: trap("sendBeacon") },
  });
  ctx.window = ctx;
  ctx.fetch = fetchImpl || trap("fetch");
  ctx.XMLHttpRequest = function () { net.push("XMLHttpRequest"); throw new Error("NETWORK ATTEMPT: XMLHttpRequest"); };
  ctx.matchMedia = () => ({ matches: false, addEventListener() {} });
  ctx.addEventListener = (type, fn) => { winL[type] = fn; };
  vm.runInContext(INJURY_PURE, ctx, { filename: "shared/injury_status.pure.js" });
  const files = ["config.js", "recorded_data.js", "lib/format.js", "lib/contract.js", "lib/reviewed_names.js", "lib/adjust.js", "lib/model.js", "lib/roster.js", "lib/data.js", "lib/recorded.js", "lib/photo.js", "lib/sample.js", "lib/clubhist.js", "lib/ranks.js", "lib/complete.js", "lib/boxlog.js", "lib/tabviews.js", "lib/breakdown.js", "lib/views.js", "app.js"];
  for (const f of files) {
    if (f === "recorded_data.js") { if (bundle === undefined) vm.runInContext(read(f), ctx, { filename: f }); else if (bundle !== null) ctx.UPS2027_RECORDED = bundle; continue; }
    vm.runInContext(read(f), ctx, { filename: f });
    if (f === "config.js" && data !== undefined) ctx.UPS2027_CONFIG.data = data;
  }
  const click = async (attrs, n = 30) => {
    const el = { getAttribute: (k) => (k in attrs ? attrs[k] : null) };
    (listeners.click || []).forEach((fn) => fn({ target: { closest: () => el } }));
    await tick(n);
  };
  return { ctx, net, click, html: () => appEl.innerHTML, misses: () => Array.from(ctx.UPS2027.recorded.misses), location };   // Array.from: the page's arrays belong to another realm, which a strict deepEqual would refuse
}
const TROUBLE = /Couldn’t load this|Couldn’t read the league data|could not be read|couldn’t be loaded|couldn’t load|Not in the recorded/;
const FIRST = BUNDLE.routes[ROSTER_ROUTE].teams[0];

test("ZERO NETWORK: every screen of the real app is tapped through with fetch, XMLHttpRequest and sendBeacon all throwing; nothing is unrecorded and no failure text appears", async () => {
  t.equal(CFG.data, "recorded", "the committed default is recorded-data mode");
  const a = boot();
  t.match(a.html(), /aria-busy="true"/, "a loading state is drawn first");
  await tick(80);
  const ok = (where) => { t.doesNotMatch(a.html(), TROUBLE, where + ": no failure text"); t.deepEqual(a.misses(), [], where + ": nothing was asked that is not in the recording"); t.deepEqual(a.net, [], where + ": no network attempt"); };
  // boot: the first team, the marker, the data-as-of line, the Roster lineup
  t.match(a.html(), /Week 11 starters/); t.match(a.html(), new RegExp(FIRST.franchise_name)); t.equal(FIRST.franchise_name, "Blake Bombers");
  t.match(a.html(), /<div class="envbar rec"><span>PREVIEW · RECORDED DATA · recorded Sun Nov 22, 2026, 10:22 AM ET · VIEW ONLY<\/span><\/div>/, "the marker says it is a recording, and when");
  t.doesNotMatch(a.html(), /Preview: view only/);
  t.match(a.html(), /Data as of Sun 10:22 AM ET · Week 11/, "the Data as of line is the roster read's own generated_at");
  t.match(a.html(), /▲ Questionable|Questionable/, "injury chips drawn from the recorded status read");
  ok("boot");
  // Roster › Byes, back to Lineup, and a past week
  await a.click({ "data-act": "view", "data-v": "byes" }); t.match(a.html(), /As of now · Week 11/); ok("byes");
  await a.click({ "data-act": "view", "data-v": "lineup" });
  await a.click({ "data-act": "weeks" }); t.match(a.html(), /aria-label="Choose a week"/);
  await a.click({ "data-act": "pickweek", "data-v": "10" }); t.match(a.html(), /Recorded starters · Week 10/); ok("past week 10");
  await a.click({ "data-act": "weeks" }); await a.click({ "data-act": "pickweek", "data-v": "1" }); t.match(a.html(), /Recorded starters · Week 1\b/); ok("past week 1");
  await a.click({ "data-act": "weeks" }); await a.click({ "data-act": "pickweek", "data-v": "11" }); t.match(a.html(), /Week 11 starters/);
  // Contracts: the cap card with its figures, the Breakdown, a category, the 2027 row, every sort and year, a row opened
  await a.click({ "data-act": "sub", "data-v": "contracts" }, 60);
  t.match(a.html(), /Cap space · 2026 season/); t.match(a.html(), /Available cap space/); t.match(a.html(), /<div class="capa"><div class="big[^"]*">[-−]?\$[\d,]+<\/div>/, "an available cap space figure"); t.match(a.html(), /<div class="capt"><b>\$300,000<\/b><div class="ex">Total cap<\/div>/, "the total cap, from the roster read");
  t.doesNotMatch(a.html(), /Loading…/, "the guarantee column has its values (the calculation was recorded)");
  ok("contracts");
  await a.click({ "data-act": "ctbd" }); t.match(a.html(), /Total committed cap/); t.match(a.html(), /<b>Cap charge<\/b><b>\$[\d,]+<\/b>/, "a cap charge"); t.match(a.html(), /<b>Available cap space<\/b>/); ok("breakdown");
  const cat = /data-act="ctcat" data-v="(y26[^"]+)"/.exec(a.html());
  t.ok(cat, "the Blake Bombers have a 2026 adjustment category to open");
  await a.click({ "data-act": "ctcat", "data-v": cat[1] }); t.match(a.html(), /Total<\/span><b>/, "a category opens its rows"); ok("category");
  await a.click({ "data-act": "nsx" }, 60); t.match(a.html(), /UPS ledger amounts, not yet on MFL/, "the 2027 row opens to the recorded ledger"); ok("2027 row");
  const cat27 = /data-act="ctcat" data-v="(y27[^"]+)"/.exec(a.html());
  t.ok(cat27, "and a 2027 category");
  await a.click({ "data-act": "ctcat", "data-v": cat27[1] }); t.match(a.html(), /Cut [A-Z][a-z]{2} \d{1,2}, 202\d|Cut date not recorded/); t.doesNotMatch(a.html(), /Name unavailable/); ok("2027 category");
  for (const s of ["sal", "exp", "name", "sal", "sal"]) await a.click({ "data-act": "cts", "data-v": s });
  for (const y of ["0", "1", "2"]) { await a.click({ "data-act": "cts", "data-v": "sal" }); await a.click({ "data-act": "cty", "data-v": y }); }
  for (const f of new Set([...a.html().matchAll(/data-act="ctf" data-v="([^"]+)"/g)].map((m) => m[1]))) await a.click({ "data-act": "ctf", "data-v": f });
  const row = /data-act="ctx" data-v="(\d+)"/.exec(a.html()); t.ok(row, "contract rows");
  await a.click({ "data-act": "ctx", "data-v": row[1] }); t.match(a.html(), /data-act="ctx" data-v="\d+" aria-expanded="true"/);
  ok("contract sorts and rows");
  // Performance
  await a.click({ "data-act": "sub", "data-v": "performance" }, 150);
  t.match(a.html(), /Season through Week 10 · completed games/); t.match(a.html(), /<span>Season points<\/span><b>\d/, "season figures draw from the recorded weekly scores");
  ok("performance");
  for (const s of ["diff", "avg", "pos"]) await a.click({ "data-act": "pfs", "data-v": s });
  const pf = /data-act="pfx" data-v="(\d+)"/.exec(a.html()); t.ok(pf, "performance rows");
  await a.click({ "data-act": "pfx", "data-v": pf[1] }); t.match(a.html(), /data-act="pfx" data-v="\d+" aria-expanded="true"/);
  ok("performance sorts and rows");
  // a profile and its tabs, including the game log and the earlier weeks
  const pid = FIRST.players[0].id;
  await a.click({ "data-act": "card", "data-pid": pid }, 60); t.match(a.html(), /role="dialog"/); t.match(a.html(), /Player profile/);
  t.match(a.html(), /Earned to date/); ok("profile");
  await a.click({ "data-act": "ptab", "data-v": "perf" }, 100); t.match(a.html(), /Game log/); ok("profile performance");
  // R6: the Breakdown in recorded mode: the fantasy history through Week 10 and one line; the game-stats read is answered "absent" with no request and no miss
  t.match(a.html(), /Game stats aren’t in this recording/); t.match(a.html(), /<b>W10<\/b>/); t.match(a.html(), /<b>W1<\/b>/); t.doesNotMatch(a.html(), /data-act="bdv"/);
  await a.click({ "data-act": "bdg", "data-v": "10", "data-pid": pid }, 30); t.match(a.html(), /<tr class="bdd">/); ok("breakdown game detail");
  await a.click({ "data-act": "ptab", "data-v": "more" }); await a.click({ "data-act": "ptab", "data-v": "sched" }); await a.click({ "data-act": "ptab", "data-v": "contract" });
  await a.click({ "data-act": "tog", "data-v": "cut" }); ok("profile tabs");
  await a.click({ "data-act": "close" });
  // Help on each tab, About, a team change
  for (const s of ["roster", "contracts", "performance", "cap"]) {
    await a.click({ "data-act": "sub", "data-v": s }, 40);
    await a.click({ "data-act": "help" }); t.match(a.html(), /aria-label="Help for this screen"/);
    t.match(a.html(), /This preview uses a recorded snapshot taken Sun Nov 22, 2026, 10:22 AM ET, so the figures will not move\./, "Help says so on " + s); await a.click({ "data-act": "close" });
  }
  await a.click({ "data-act": "about" });
  t.match(a.html(), /This preview uses a recorded snapshot taken Sun Nov 22, 2026, 10:22 AM ET, not the live league\. The figures will not move\./);
  t.match(a.html(), /Reload the recorded data/); t.match(a.html(), /answered from the snapshot that ships with the page/);
  t.match(a.html(), /<b>\d+<\/b> data requests: <b>\d+<\/b> succeeded, <b>0<\/b> failed, <b>0<\/b> refused/, "the page's own log: every read succeeded, none failed");
  await a.click({ "data-act": "skin", "data-v": "dark" }); await a.click({ "data-act": "close" });
  await a.click({ "data-act": "sub", "data-v": "roster" }); await a.click({ "data-act": "teams" }); await a.click({ "data-act": "pickteam", "data-fid": "0009" }, 20); t.match(a.html(), /C-Town Chivalry/); ok("about and teams");
  // Sample mode on and off: no request while on, the recording again when it ends
  const before = a.ctx.UPS2027.recorded.misses.length;
  await a.click({ "data-act": "about" }); await a.click({ "data-act": "sample" }); t.match(a.html(), /Sample data · nothing is real and nothing is sent/);
  t.doesNotMatch(a.html(), /RECORDED DATA/, "Sample mode keeps its own label");
  await a.click({ "data-act": "sample" }, 80); t.match(a.html(), /RECORDED DATA/); t.match(a.html(), /C-Town Chivalry|Week 11 starters/);
  t.equal(a.misses().length, before); ok("sample mode");
  // a reload re-reads the recording
  await a.click({ "data-act": "sub", "data-v": "roster" }); await a.click({ "data-act": "about" }); await a.click({ "data-act": "retry" }, 80); t.match(a.html(), /Week 11 starters/); ok("reload");
  t.equal(a.net.length, 0);
});

test("recorded mode never falls back to the network: a missing or empty bundle, or one without a route, shows the normal failure", async () => {
  for (const [label, bundle] of [["missing", null], ["empty routes", { meta: BUNDLE.meta, routes: {} }], ["not a route table", { meta: BUNDLE.meta, routes: [] }]]) {
    const a = boot({ bundle }); await tick(30);
    t.match(a.html(), /Couldn’t read the league data/, label + ": the existing failure screen"); t.match(a.html(), /HTTP 404/, label + ": a 404-like answer from the recording");
    t.doesNotMatch(a.html(), /Week 11 starters/); t.match(a.html(), /RECORDED DATA/, label + ": the marker still says recorded");
    t.ok(a.misses().length >= 1, label + ": the miss is counted"); t.deepEqual(a.net, [], label + ": and nothing reached the network");
  }
  // one route missing: that read fails the way any failed read does, the rest of the screens are unaffected
  const noScores5 = JSON.parse(JSON.stringify(BUNDLE)); delete noScores5.routes[R.canonical(D.createLoader(CFG, async () => null).urls.scores(5))];
  const b = boot({ bundle: noScores5 }); await tick(60);
  t.match(b.html(), /Week 11 starters/, "the roster still draws");
  await b.click({ "data-act": "sub", "data-v": "performance" }, 150);
  t.match(b.html(), /Some weeks of scores could not be read/, "Performance names the week it could not read"); t.match(b.html(), /data-act="retryperf"/);
  t.deepEqual(b.misses(), [R.canonical(D.createLoader(CFG, async () => null).urls.scores(5))], "exactly the unrecorded route is counted");
  await b.click({ "data-act": "retryperf" }, 80); t.equal(b.misses().length, 2, "Retry asks again, and the recording still has no answer: counted again, never the network"); t.deepEqual(b.net, []);
  // no roster route at all (a recording of another league): the failure screen
  const noRoster = JSON.parse(JSON.stringify(BUNDLE)); delete noRoster.routes[ROSTER_ROUTE];
  const c = boot({ bundle: noRoster }); await tick(30); t.match(c.html(), /Couldn’t read the league data/); t.deepEqual(c.net, []);
});

test("the config switch: live uses the supplied fetch and never the recording; an unknown mode makes no request; the live marker is the old one", async () => {
  const calls = [];
  const fake = async (url, opts) => { calls.push({ url, opts }); const key = R.canonical(url); const has = Object.prototype.hasOwnProperty.call(BUNDLE.routes, key); return has ? { ok: true, status: 200, text: async () => JSON.stringify(BUNDLE.routes[key]) } : { ok: false, status: 404, text: async () => "" }; };
  const a = boot({ data: "live", fetchImpl: fake }); await tick(80);
  t.ok(calls.length >= 4, "the page made its reads through the supplied fetch (" + calls.length + ")");
  calls.forEach((c) => { t.equal(c.opts.method, "GET"); t.equal(c.opts.credentials, "omit"); t.match(c.url, /^https:\/\/upsmflproduction\.keith-creelman\.workers\.dev\//); });
  t.match(a.html(), /Week 11 starters/); t.match(a.html(), /<div class="envbar"><span>Preview: view only<\/span><\/div>/); t.doesNotMatch(a.html(), /RECORDED/);
  t.deepEqual(a.misses(), [], "the recording was not consulted"); t.equal(a.ctx.UPS2027.recorded.misses.length, 0);
  await a.click({ "data-act": "about" }); t.match(a.html(), /Read from the league when this page opened/); t.match(a.html(), /Reload the data/); t.doesNotMatch(a.html(), /recorded snapshot/);
  await a.click({ "data-act": "close" }); await a.click({ "data-act": "help" }); t.doesNotMatch(a.html(), /Recorded data/, "no recorded-data text in live Help");
  // an unknown mode is not "live": no request of any kind
  const calls2 = []; const b = boot({ data: "typo", fetchImpl: async (u) => { calls2.push(u); return { ok: true, status: 200, text: async () => "{}" }; } }); await tick(40);
  t.equal(calls2.length, 0); t.deepEqual(b.net, []); t.match(b.html(), /Couldn’t read the league data/); t.match(b.html(), /Unknown data mode/);
  t.doesNotMatch(b.html(), /RECORDED/);
});

run("mobile2027_recorded");
