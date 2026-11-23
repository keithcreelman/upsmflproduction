// UPS 2027 R9 (Keith, 2026-11-23): Team › Contracts sort order (Contract exp. | Salary | Position | Name), grouped Position, surname order from MFL's
// "Last, First", column heads inside the list container, inset Details, recorded AAV by year, Contract source "Extension" with the acquisition kept
// separate, a collapsed Contract history, the Salary structure filter on the rule classification, and (evidence check 2026-11-23) restructure-bound
// extension attributions shown as not verified.
//   node tests/mobile2027_r9_contracts.test.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "apps", "mobile2027", "src");
const require = createRequire(import.meta.url);
const C = require(path.join(SRC, "lib", "contract.js")), M = require(path.join(SRC, "lib", "model.js")), V = require(path.join(SRC, "lib", "views.js")), TV = require(path.join(SRC, "lib", "tabviews.js"));
const CSS = fs.readFileSync(path.join(SRC, "styles.css"), "utf8");
const box = { window: {} }; vm.runInNewContext(fs.readFileSync(path.join(SRC, "recorded_data.js"), "utf8"), box);
const ROUTES = box.window.UPS2027_RECORDED.routes;
const route = (frag) => ROUTES[Object.keys(ROUTES).find((k) => k.indexOf(frag) >= 0)];
const RW = route("/roster-workbench?"), PEN = route("/api/cap-penalty/preview?");
const text = (html) => html.replace(/<br>/g, " ").replace(/<[^>]*>/g, " ").replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const body = (html) => html.split('id="screen"')[1].split("<nav")[0];
const MODEL = M.build(RW, null, null, 11, 2026), TEAMS = MODEL.teams;
const CT0 = () => ({ f: "all", l: "all", s: "exp", y: 0, d: 1, open: {}, hist: {}, bd: false, cat: {}, ns: false });
const state = (over) => ({ model: MODEL, load: { core: "ok", coreNotes: [] }, penalty: { state: "ok", data: PEN.players, meta: { earnedThroughWeek: PEN.earned_through_week } }, ns: { state: "idle" }, teamId: "0010", tab: "team", sub: "contracts", view: "lineup",
  open: {}, flags: {}, profile: null, sheet: null, skin: "system", vib: "1", build: "test", requestLog: [], gdef: "needs", wk: null, intel: { mu: {}, wk: {}, scores: {}, players: { state: "ok", data: { byId: {} }, at: 1 } }, ct: CT0(),
  requestSummary: { requests: 0, ok: 0, failed: 0, refused: 0, nonGet: 0 }, ...(over || {}) });
const player = (name) => { for (const tm of TEAMS) { const p = tm.players.find((x) => x.name === name); if (p) return p; } throw new Error("no " + name); };
const screen = (p, ct) => body(V.app(state({ teamId: p.franchiseId, ct: { ...CT0(), ...ct } })));
const rowOf = (html, p) => html.split('aria-label="Open ' + p.name.replace(/&/g, "&amp;").replace(/'/g, "&#39;") + ' profile"')[1].split('<div class="rw">')[0];
const details = (name, hist) => { const p = player(name); return rowOf(screen(p, { open: { [p.id]: true }, hist: hist ? { [p.id]: true } : {} }), p); };
const idsOf = (html) => [...html.matchAll(/data-act="ctx" data-v="(\d+)"/g)].map((m) => m[1]);
const P = (special, years, salary, extra) => ({ id: "1", name: "Test Player", rawName: "Player, Test", pos: "WR", status: "active", salary, years, special, type: "Vet-FAA", acquisition: "", franchiseId: "0010", ...(extra || {}) });

// ───────────────────────── sort ─────────────────────────
test("sort control reads Contract exp. | Salary | Position | Name; Contract exp. is the default", () => {
  const h = screen(player("Rico Dowdle"), {});
  t.deepEqual([...h.matchAll(/data-act="cts" data-v="(\w+)" aria-pressed="(true|false)"/g)].map((m) => m[1] + ":" + m[2]), ["exp:true", "sal:false", "pos:false", "name:false"]);
  t.deepEqual(TV.ctNextSort({ s: "exp", d: 1 }, "pos"), { s: "pos", d: 1 }); t.deepEqual(TV.ctNextSort({ s: "pos", d: 1 }, "pos"), { s: "pos", d: -1 });
  t.match(h, /class="seg seg4"/, "the existing four-segment layout (wraps 2×2 under 360 px)");
});

test("Position sort draws grouped sections in the league's order (QB first), reversed with the direction; every player appears once", () => {
  const tm = TEAMS.find((x) => x.id === "0010"), asc = screen(tm.players[0], { s: "pos", d: 1 }), desc = screen(tm.players[0], { s: "pos", d: -1 });
  const heads = (h) => [...h.matchAll(/<div class="gh3"><span><span class="pc (\w+)">/g)].map((m) => m[1]);
  t.ok(heads(asc).length >= 4); t.equal(heads(asc)[0], "QB"); t.deepEqual(heads(desc), heads(asc).slice().reverse());
  t.equal(idsOf(asc).length, tm.players.length); t.deepEqual(idsOf(desc), idsOf(asc).slice().reverse());
  const order = ["QB", "RB", "WR", "TE", "K", "P", "DL", "LB", "DB"]; const ix = heads(asc).map((x) => order.indexOf(x)); t.deepEqual(ix, ix.slice().sort((a, b) => a - b));
  t.match(text(asc), /QB · \d+ players? \$[\d.]+K 2026 salary/);
});

test("Name sort is by surname then given name from MFL's 'Last, First'; suffixes and multi-word surnames are kept whole", () => {
  t.deepEqual(TV.nameParts({ rawName: "Cooper Jr., Omar" }), { last: "Cooper", first: "Omar", suffix: "Jr." });
  t.deepEqual(TV.nameParts({ rawName: "Walker III, Kenneth" }), { last: "Walker", first: "Kenneth", suffix: "III" });
  t.deepEqual(TV.nameParts({ rawName: "St. Brown, Amon-Ra" }), { last: "St. Brown", first: "Amon-Ra", suffix: "" });
  t.deepEqual(TV.nameParts({ rawName: "Van Ginkel, Andrew" }), { last: "Van Ginkel", first: "Andrew", suffix: "" });
  t.deepEqual(TV.nameParts({ rawName: "Bills, Buffalo", name: "Buffalo Bills" }).last, "Bills");
  t.deepEqual(TV.nameParts({ rawName: "", name: "Some Team" }), { last: "Some Team", first: "", suffix: "" }, "no Last, First structure: the whole name");
  const ppl = ["Walker III, Kenneth", "Walker, Aaron", "Brown, Zed", "St. Brown, Amon-Ra", "Smith-Njigba, Jaxon", "Cooper Jr., Omar", "Cooper, Amari", "Van Ginkel, Andrew"].map((n, i) => ({ id: String(i), rawName: n, name: n }));
  // the last displayed word would have put "Amon-Ra St. Brown" under B and "Omar Cooper Jr." under J
  t.deepEqual(ppl.slice().sort(TV.byName).map((p) => p.rawName), ["Brown, Zed", "Cooper, Amari", "Cooper Jr., Omar", "Smith-Njigba, Jaxon", "St. Brown, Amon-Ra", "Van Ginkel, Andrew", "Walker, Aaron", "Walker III, Kenneth"]);
  // on screen: a team with a Jr. (Cooper Jr., CBP) sorts him under C
  const cbp = TEAMS.find((tm) => tm.players.some((p) => p.rawName === "Cooper Jr., Omar")), h = screen(cbp.players[0], { s: "name" });
  const names = idsOf(h).map((id) => cbp.players.find((p) => p.id === id).rawName); t.equal(names.join(" | "), cbp.players.slice().sort(TV.byName).map((p) => p.rawName).join(" | "));
  const at = names.indexOf("Cooper Jr., Omar"); t.ok(at >= 0 && names.slice(0, at).every((n) => n.localeCompare("Cooper") <= 0));
});

// ───────────────────────── layout ─────────────────────────
test("the column heads and group headings are inside ONE list container, on the rows' inset; opened Details are an inset band", () => {
  const h = screen(player("Rico Dowdle"), {});
  t.equal((h.match(/<div class="card rows ctl">/g) || []).length, 1, "one container");
  const box = h.split('<div class="card rows ctl">')[1];
  t.ok(box.indexOf('<div class="thead g') === 0, "the heads open the container"); t.ok(box.indexOf('<div class="gh3">') > 0 && box.indexOf('<div class="rw">') > box.indexOf('<div class="gh3">'));
  t.doesNotMatch(h, /<div class="gh2">/, "no free-floating group boxes on Contracts");
  t.match(text(box.split("</div>")[0]), /If cut now 2026 2027/, "'If cut now' is kept");
  t.match(CSS, /\.ctl \.thead\{margin:0 -12px;padding:6px 14px/); t.match(CSS, /\.gh3\{[^}]*margin:0 -12px;padding:4px 14px/); t.match(CSS, /\.rw>\.cells\{padding:2px 2px 8px\}/, "rows' amounts are at 12 + 2 px, the heads at 14 px");
  t.match(CSS, /\.ctl \.rw>\.det\{margin:0 -12px;padding:8px 14px 10px;background:var\(--s2\);border-top:1px solid var\(--bd\)\}/, "one tint and a divider, no nested border box");
});

// ───────────────────────── AAV ─────────────────────────
test("AAV: recorded tiers labeled by year; single, dual mapped (an extension made this season), unmapped; never TCV ÷ years", () => {
  t.match(text(details("Rico Dowdle")), /AAV 2026 · \$11K/, "single tier over the remaining term");
  t.match(text(details("Will Anderson")), /AAV 2026 · \$1K 2027 · \$4K/, "dual: this season keeps the old AAV, the added year the new one (§C4; tiers roll)");
  t.match(text(details("Jaxon Smith-Njigba")), /AAV 2026–2027 · \$30K/, "a range");
  const ext3 = C.aavYears(P("CL 3|TCV 50K|AAV 10K, 20K|Y1-10K, Y2-20K, Y3-20K|Ext: PG", 3, 10000, { type: "Vet-Ext2" }), 2026, TEAMS);
  t.deepEqual(ext3.lines, [{ from: 2026, to: 2026, amount: 10000 }, { from: 2027, to: 2028, amount: 20000 }]);
  const stale = C.aavYears(P("CL 2|TCV 28K|AAV 4K, 24K|Y1-4K, Y2-24K|Ext: PG", 1, 24000, { type: "Vet-Ext1" }), 2026, TEAMS);
  t.equal(stale.state, "unmapped", "two tiers but only one year left: the tiers did not roll, so not placed");
  const nonExt = C.aavYears(P("CL 2|TCV 28K|AAV 4K, 24K|Y1-4K, Y2-24K", 2, 4000), 2026, TEAMS); t.equal(nonExt.state, "unmapped");
  const one = C.aavYears(P("CL 2|TCV 24K|AAV 12K|Y1-1K, Y2-23K|Ext: PG", 2, 1000, { type: "Vet-Ext1" }), 2026, TEAMS); t.equal(one.state, "unmapped", "one tier on an extension made this season cannot be placed");
  t.equal(C.aavYears(P("CL 2|TCV 24K", 2, 12000), 2026, TEAMS).state, "none");
  t.equal(TV.contractFacts(C.history(P("CL 2|TCV 28K|AAV 4K, 24K|Y1-4K, Y2-24K", 2, 4000), 2026), C.describe({ type: "Vet-FAA" }), { aav: nonExt }).match(/<b>AAV<\/b><span>([^<]*)<\/span>/)[1], "Recorded: $4K, $24K · years not mapped");
  t.ok(!/\$14K/.test(text(details("Will Anderson")).split("AAV")[1].split("If cut")[0]), "not TCV 5K ÷ 2 or any average");
  let mapped = 0, dual = 0; TEAMS.forEach((tm) => tm.players.forEach((p) => { const a = C.aavYears(p, 2026, TEAMS); if (a.state === "mapped") mapped++; if (a.lines.length === 2) dual++; }));
  t.deepEqual([mapped, dual], [486, 12], "recording: every AAV maps; the 12 dual tiers are all extensions made in 2026");
});

// ───────────────────────── source, acquisition, history ─────────────────────────
test("Contract source: Extension (years added), the extending team and year once; Acquired kept separate", () => {
  const d = text(details("Rico Dowdle"));
  t.match(d, /Salary schedule Extended by Blake Bombers · 2025 2025 Completed \$1,000 2026 This season \$11,000/);
  t.match(d, /Contract Source Extension 1 year added Acquired Trade · 2025 Later changes None recorded/);
  t.equal((d.match(/Extended by Blake Bombers/g) || []).length, 1, "the attribution appears once in Details");
  const prof = text(V.app(state({ profile: { pid: player("Rico Dowdle").id, tab: "contract" }, flags: { rules: true } })));
  t.match(prof, /Contract Source Extension 1 year added · Extended by Blake Bombers · 2025 Acquired Trade · 2025/, "the profile (no schedule line) carries it under the source");
  t.match(text(details("Terry McLaurin")), /Contract Source FA Auction Acquired Auction, \$19,000 · 2025/);
  t.match(text(details("Javon Bullard")), /Acquired Rookie Draft, pick 6\.09 · 2024/);
});

test("Contract history: collapsed by default, below the current contract; chronological by season; derived seasons say so; trades and restructures add no extending team", () => {
  const closed = details("Rico Dowdle"); t.match(closed, /data-act="cth" data-v="\d+" aria-expanded="false"/); t.doesNotMatch(closed, /class="hist"/);
  const open = details("Rico Dowdle", true), tx = text(open);
  t.ok(tx.indexOf("If cut now") < tx.indexOf("Contract history"), "facts above the history");
  t.match(tx, /2025 Acquired by trade 2025 Extended by Blake Bombers \(current contract, 1 year added\) Season from the contract terms/);
  t.match(tx, /Seasons only, no dates\. Extension eligibility is not shown\./);
  t.doesNotMatch(tx, /2025-\d\d|November|\d{1,2}:\d\d/, "no invented dates");
  // the schedule is unchanged by the history
  t.match(tx, /Salary schedule Extended by Blake Bombers · 2025 2025 Completed \$1,000 2026 This season \$11,000 Term 2025–2026/);
  // a restructure is an event, never an extending team
  const mc = C.contractHistory(player("Terry McLaurin"), 2026, TEAMS); t.deepEqual(mc.events.map((e) => [e.year, e.kind]), [[2025, "acquired"], [2026, "restructure"]]); t.deepEqual(mc.extTeams, []); t.ok(mc.complete);
  t.deepEqual(C.contractHistory(player("Rico Dowdle"), 2026, TEAMS).extTeams.map((x) => x.name), ["Blake Bombers"], "the trade adds no team");
  // every Ext: name is listed (Higgins: Mafia, LH, C-Town)
  const hig = C.contractHistory(player("Tee Higgins"), 2026, TEAMS); t.equal(hig.events.filter((e) => e.kind === "extension" && e.words.indexOf("current contract") < 0).length, 3);
  t.deepEqual(hig.extTeams.map((x) => x.name), ["The Long Haulers", "C-Town Chivalry"], "Mafia is not a current team");
  // profile toggle
  const p = player("Rico Dowdle"); t.match(V.app(state({ profile: { pid: p.id, tab: "contract" } })), /data-act="tog" data-v="hist" aria-expanded="false"/);
  t.match(text(V.app(state({ profile: { pid: p.id, tab: "contract" }, flags: { hist: true } }))), /Contract history .*2025 Extended by Blake Bombers/);
});

// ───────────────────────── evidence check: restructure-bound attributions ─────────────────────────
test("restructure-bound extension years (London, Cook, Love, Hurts shapes): the last Ext: name is not presented as the extender in force", () => {
  for (const [name, recorded] of [["Drake London", ["Pure Greatness"]], ["James Cook", ["CBP"]], ["Jordan Love", ["Pure Greatness"]], ["Jalen Hurts", ["Gride", "HammerTime"]]]) {
    const p = player(name), e = C.extension(p, 2026, TEAMS);
    t.equal(e.yearWhy, "restructure_bound", name); t.equal(e.verified, false); t.equal(e.year, 2026);
    t.equal(C.extensionLine(e), "Extended · 2026 · extending team not verified", name);
    const tx = text(details(name, true));
    t.doesNotMatch(tx, /Extended by [^·(]*· 2026/, name + ": no team paired with the 2026 year");
    t.equal((tx.match(/extending team not verified/g) || []).length, 2, name + ": once on the schedule line, once as the history's current-contract event");
    t.match(tx, /2026 Extended · extending team not verified \(current contract, 1 year added\) Season from the restructured terms/);
    recorded.forEach((r) => t.match(tx, new RegExp("— Extended by " + r + "[^(]*\\(in the extension record\\)"), name + ": the record's " + r + " is listed, undated"));
    t.match(tx, /Incomplete: .*the record may not name the team that made the current extension/);
    const h = C.contractHistory(p, 2026, TEAMS); t.equal(h.extTeamsComplete, false); t.equal(h.complete, false);
  }
  // a terms-bound extension is unchanged (Dowdle; Derrick Henry still names The Long Haulers, now with the Bombers)
  t.equal(C.extension(player("Rico Dowdle"), 2026, TEAMS).verified, true); t.equal(C.extensionLine(C.extension(player("Derrick Henry"), 2026, TEAMS)), "Extended by The Long Haulers · 2025");
  let changed = []; TEAMS.forEach((tm) => tm.players.forEach((p) => { const e = C.extension(p, 2026, TEAMS); if (e && e.verified === false) changed.push(p.name); }));
  t.deepEqual(changed.sort(), ["Courtland Sutton", "Drake London", "Jalen Hurts", "James Cook", "Jaxon Smith-Njigba", "Jordan Love", "Jordan Mason", "Kenneth Walker III", "Sam Darnold", "Tee Higgins"], "10 contracts change: every restructure-bound year");
});

// ───────────────────────── Salary structure ─────────────────────────
test("Salary structure filter reads the rule classification only; a Flat extension with uneven salaries keeps Flat and says so factually", () => {
  const all = TEAMS.flatMap((tm) => tm.players), cnt = (v) => all.filter((p) => C.describe(p).structure === v).length;
  t.deepEqual([cnt("Flat"), cnt("Front-loaded"), cnt("Back-loaded")], [447, 18, 21]);
  const tm = TEAMS.find((x) => x.id === "0010"), h = (l) => screen(tm.players[0], { l });
  t.deepEqual([...h("all").matchAll(/data-act="ctl" data-v="(\w+)" aria-pressed="(true|false)">([^<]+)</g)].map((m) => m[3] + ":" + m[2]), ["All:true", "Flat:false", "Front-loaded:false", "Back-loaded:false"]);
  [["flat", "Flat"], ["fl", "Front-loaded"], ["bl", "Back-loaded"]].forEach(([k, v]) => t.equal(idsOf(h(k)).length, tm.players.filter((p) => C.describe(p).structure === v).length, v));
  t.equal(idsOf(h("bogus")).length, tm.players.length, "an unknown value is All");
  const dd = text(details("Rico Dowdle")); t.match(dd, /Salary structure Flat Rule classification; the yearly salaries differ\./);
  t.doesNotMatch(text(details("Javon Bullard")), /yearly salaries differ/, "equal salaries: no note");
  t.doesNotMatch(text(details("Terry McLaurin")), /Rule classification/, "a loaded contract has no note");
});

run("mobile2027_r9_contracts");
