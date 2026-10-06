// Front Office → Salary Adjustments tab: the REAL renderer over the REAL route.
//   node tests/front_office_salary_adjustments_tab.test.mjs
//   SNAPSHOT_OUT=<file.html> also writes the rendered tab (both years) for eyeballing.
//
// renderSalaryAdjustmentsTab and its helpers are sliced out of the shipped
// site/rosters/v2/front_office.js and run against what the real worker route
// returns for the league's 2026-10-06 data (the same fixture as
// tests/salary_adjustments_ledger.test.mjs). Only FO's own tiny DOM helpers
// ($, $$, escapeHtml, money …) are stubbed.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { makeD1 } from "./fixtures/d1_sqlite.mjs";
import { t, test, run } from "./fixtures/mini_test.mjs";
await import("./fixtures/register_md_loader.mjs");
const worker = (await import("../worker/src/index.js")).default;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FO_SRC = fs.readFileSync(path.join(ROOT, process.env.FO_JS || "site/rosters/v2/front_office.js"), "utf8");
const FO_HTML = fs.readFileSync(path.join(ROOT, "site/rosters/v2/front_office.html"), "utf8");
const FX = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/salary_adjustments_2026_10_06.json"), "utf8"));
const REPORT = fs.readFileSync(path.join(ROOT, "site/reports/salary_adjustments/salary_adjustments_2026.json"), "utf8");

// ── The real route's response (no network) ──
const json = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  if (u.host === "keithcreelman.github.io") return new Response(REPORT, { status: 200 });
  const type = u.searchParams.get("TYPE");
  if (type === "salaryAdjustments") return json(FX.salaryAdjustments);
  if (type === "league") return json({ league: { franchises: { franchise: FX.franchises } } });
  if (type === "transactions") return json(FX.trades);
  if (type === "players") { const ids = String(u.searchParams.get("P") || "").split(","); return json({ players: { player: FX.players.filter((p) => ids.includes(p.id)) } }); }
  return json({ error: "no" }, 503);
};
const db = makeD1({});
const cols = Object.keys(FX.drop_events[0]);
db.raw.exec(`CREATE TABLE ups_drop_events (${cols.join(", ")})`);
const ins = db.raw.prepare(`INSERT INTO ups_drop_events (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
for (const r of FX.drop_events) ins.run(...cols.map((c) => r[c]));
db.raw.exec("CREATE TABLE ups_faa_nom_penalties (penalty_id, season, league_id, fid, et_day, offense_no, amount_k, applies_to_season, posted_to_mfl, voided)");
for (const r of FX.faa_nom_penalties) db.raw.prepare("INSERT INTO ups_faa_nom_penalties VALUES (?,?,?,?,?,?,?,?,?,?)").run(r.penalty_id, r.season, r.league_id, r.fid, r.et_day, r.offense_no, r.amount_k, r.applies_to_season, r.posted_to_mfl, r.voided);
const env = { UPS_MFL_DB: db, MFL_COOKIE: "x", MFL_APIKEY: "k", FA_AUCTION_START_AT: String(FX.auction_start_unix) };
const LEDGER = await (await worker.fetch(new Request("https://w.test/api/salary-adjustments/ledger?L=74598&YEAR=2026"), env, { waitUntil() {}, passThroughOnException() {} })).json();

// ── The real renderer ──
const start = FO_SRC.indexOf("  const SALADJ_TYPE_ORDER");
const end = FO_SRC.indexOf("  function renderActivityTab() {");
if (start < 0 || end < start) throw new Error("renderSalaryAdjustmentsTab block not found");
function makeFo(me) {
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, innerHTML: "", value: "", listeners: {}, addEventListener(ty, fn) { (this.listeners[ty] = this.listeners[ty] || []).push(fn); } });
  const fetched = [];
  const c = vm.createContext({
    console, Date, Number, String, Math, JSON, Object, Array, Promise,
    STATE: { me: me || null, teams: [] },
    SEASON: "2026", LEAGUE_ID: "74598",
    $: (sel) => (sel.startsWith("#") ? el(sel.slice(1)) : null),
    $$: () => [],
    apiUrl: (p) => "https://worker.test" + p,
    fetchJSON: async (u) => { fetched.push(u); return JSON.parse(JSON.stringify(LEDGER)); },
    escapeHtml: (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    safeInt: (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; },
    pad4: (v) => String(v || "").padStart(4, "0"),
    money: (n) => { const v = Math.round(Number(n) || 0); return (v < 0 ? "-" : "") + "$" + Math.abs(v).toLocaleString("en-US"); },
  });
  vm.runInContext(FO_SRC.slice(start, end) + "\nthis.render = renderSalaryAdjustmentsTab;", c);
  return { c, body: () => el("fo-saladj-body").innerHTML, el, fetched };
}

const fo = makeFo(null);
await fo.c.render();
const H26 = fo.body();

test("wired: a 'Salary Adjustments' tab, its section, the dispatcher, and a new FO stamp", () => {
  t.match(FO_HTML, /<button data-tab="saladj">Salary Adjustments<\/button>/);
  t.match(FO_HTML, /<section class="fo-section" data-section="saladj">[\s\S]*?<div id="fo-saladj-body"><\/div>/);
  t.match(FO_SRC, /else if \(key === "saladj"\) renderSalaryAdjustmentsTab\(\);/);
  t.match(FO_HTML, /front_office\.js\?v=2026\.10\.06\.v1\.40\.0/);
  t.equal(fo.fetched.length, 1); t.match(fo.fetched[0], /\/api\/salary-adjustments\/ledger\?L=74598&YEAR=2026$/);
});

test("2026: every team grouped with its total; Year is a filter, newest first, opening on the newest season", () => {
  t.match(H26, /<span class="small"[^>]*>Filter<\/span><select id="fo-saladj-year"[^>]*><option value="2027">2027 · booked for next season<\/option><option value="2026" selected>2026 · posted on MFL<\/option><\/select><select id="fo-saladj-team"/,
    "Year sits in the Filter row beside Team and Type; 2026 (the newest posted season) is selected");
  t.ok(!/data-saladj-year=/.test(H26), "the old year chips are gone");
  t.equal((H26.match(/class="fo-saladj-team"/g) || []).length, 12, "12 team headers");
  t.equal((H26.match(/data-saladj-id="/g) || []).length, 58, "58 rows");
  t.match(H26, /Sex Manther <span style="color:var\(--text\);margin-left:6px;">\+\$41,000<\/span>[^<]*<span[^>]*>6 adjustments · Dropped player \+\$36,000 · Traded salary \+\$5,000</, "team header: net total + split by type");
  t.match(H26, /Blake Bombers <span style="color:var\(--ok\);margin-left:6px;">-\$7,000/, "a net-relief team reads as relief");
});

test("a dropped player: date assessed, amount, and the pre-drop contract", () => {
  const row = H26.split('data-saladj-id="').find((x) => x.includes("Fitzpatrick, Minkah"));
  t.ok(row, "Minkah's row");
  t.match(row, /Apr 17, 2026<\/td><td[^>]*><span[^>]*color:var\(--warn\)[^>]*>Dropped player<\/span><\/td><td[^>]*color:var\(--text\);">\+\$1,000</);
  t.match(row, /dropped Aug 13, 2025/);
  t.match(row, /Original 3 yrs · TCV \$12,000 · GTD \$9,000 · Earned \$8,000 · Veteran/);
});

test("traded salary: the other team, the trade date and what moved each way", () => {
  const row = H26.split('data-saladj-id="').find((x) => x.includes('Traded salary with <strong style="color:var(--text);">Blake Bombers</strong>') && x.includes("-$12,000"));
  t.ok(row, "CBP's -$12K settlement");
  t.match(row, /· trade Aug 23, 2026/, "the MFL trade (02:31 UTC Aug 24 = Aug 23 ET)");
  t.match(row, /Sent:<\/span> [^<]*2027 Rd 4 pick \(CBP\)/);
  t.match(row, /Received:<\/span> [^<]*\$12K traded salary/);
  t.match(row, /color:var\(--ok\);">-\$12,000/, "relief shows as relief");
  const tw = H26.split('data-saladj-id="').find((x) => x.includes("3-way trade with") && x.includes("+$19,000"));
  t.ok(tw, "the 3-way row"); t.match(tw, /3-way trade with <strong[^>]*>[^<]+ and [^<]+<\/strong>/);
});

test("readable in MFL's embed: every cell, header and amount sets its own text color", () => {
  const cells = H26.match(/<td[^>]*>/g) || [];
  t.ok(cells.length > 200, cells.length + " cells");
  const bare = cells.filter((c) => !/color:/.test(c));
  t.equal(bare.length, 0, "cells without an explicit color: " + bare.slice(0, 3).join(" "));
  t.match(H26, /<table class="fo-table fo-saladj-table" style="color:var\(--text\);">/);
  t.ok(!/<strong>/.test(H26), "every bold name carries its color too");
});

test("the default is the newest POSTED season, whatever the page's YEAR said", async () => {
  const other = makeFo(null);
  other.c.SEASON = "2027";              // e.g. a link opened with YEAR=2027
  await other.c.render();
  t.match(other.body(), /<option value="2026" selected>/, "still opens on 2026 — the newest season MFL has posted");
});

test("misc says what it was for", () => {
  t.match(H26, /RULE 2 fine — missed FA Auction nomination on 2026-07-28 \(offense 1\)/);
  t.match(H26, /Drop-penalty rounding — the team&#39;s season drop-penalty total|Drop-penalty rounding — the team's season drop-penalty total/);
});

test("filters: Team and Type narrow the list; 2027 shows the booked penalties", async () => {
  fo.c.STATE.saladjFilter.team = "0010"; fo.c.STATE.saladjFilter.type = "drop";
  await fo.c.render();
  const h = fo.body();
  t.equal((h.match(/class="fo-saladj-team"/g) || []).length, 1, "one team");
  t.ok(!/Traded salary with/.test(h), "no trade rows under Type = Dropped player");
  t.match(h, /Fitzpatrick, Minkah/);
  fo.c.STATE.saladjFilter.team = ""; fo.c.STATE.saladjFilter.type = ""; fo.c.STATE.saladjFilter.year = "2027";
  await fo.c.render();
  const h27 = fo.body();
  t.equal((h27.match(/data-saladj-id="/g) || []).length, 16);
  t.match(h27, /Booked for 2027 — owed now, posts to MFL at the 2027 rollover\./);
  const jonnu = h27.split('data-saladj-id="').find((x) => x.includes("Jonnu Smith"));
  t.match(jonnu, /Original 3 yrs · TCV \$18,000 · GTD \$13,500 · Earned \$6,000/);
  t.match(jonnu, />ledger</, "not on MFL yet");
  const levis = h27.split('data-saladj-id="').find((x) => x.includes("Will Levis"));
  t.match(levis, /Earned —/, "no D1 earned figure → a dash, not a number");
  t.equal(fo.fetched.length, 1, "one fetch serves both years and every filter");
  if (process.env.SNAPSHOT_OUT) {
    const css = fs.readFileSync(path.join(ROOT, "site/rosters/v2/front_office.css"), "utf8");
    fs.writeFileSync(process.env.SNAPSHOT_OUT, `<!doctype html><meta charset="utf-8"><title>Salary Adjustments snapshot</title><style>${css}</style><body class="fo-root" style="padding:16px"><div class="fo-card">${H26}</div><div class="fo-card" style="margin-top:24px">${h27}</div></body>`);
  }
});

test("the unsettled-trade note is commish-only", async () => {
  t.ok(!/Commish:/.test(H26), "an owner never sees it");
  const admin = makeFo({ isAdmin: true, configured: true, franchise_id: "0000" });
  await admin.c.render();
  t.match(admin.body(), /👑 Commish: 1 trade moved traded salary with no settlement row on MFL — L\.A\. Looks ↔ Gride \(Jul 22, 2026, \$10K traded salary\)/);
});

await run("front_office_salary_adjustments_tab");
