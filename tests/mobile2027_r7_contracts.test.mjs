// UPS 2027 R7 (Keith, 2026-11-23, decision 1): the current-contract salary schedule is extension-aware, and "Extended by [UPS team] · [year]" comes
// from evidence only (the contract's own Ext: record), never from the current owner.
//   node tests/mobile2027_r7_contracts.test.mjs
// Data: the committed recorded bundle (apps/mobile2027/src/recorded_data.js, public league reads of 2026-11-22) and small hand-made players.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");
const SRC = path.join(REPO, "apps", "mobile2027", "src");
const require = createRequire(import.meta.url);
const C = require(path.join(SRC, "lib", "contract.js")), M = require(path.join(SRC, "lib", "model.js")), V = require(path.join(SRC, "lib", "views.js"));
const box = { window: {} }; vm.runInNewContext(fs.readFileSync(path.join(SRC, "recorded_data.js"), "utf8"), box);
const ROUTES = box.window.UPS2027_RECORDED.routes;
const route = (frag) => ROUTES[Object.keys(ROUTES).find((k) => k.indexOf(frag) >= 0)];
const RW = route("/roster-workbench?"), PEN = route("/api/cap-penalty/preview?");
const text = (html) => html.replace(/<[^>]*>/g, " ").replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const body = (html) => html.split('id="screen"')[1].split("<nav")[0];
const re = (s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

const MODEL = M.build(RW, null, null, 11, 2026);
const TEAMS = MODEL.teams;
const CT0 = () => ({ f: "all", s: "exp", y: 0, d: 1, open: {}, bd: false, cat: {}, ns: false });
const state = (over) => ({ model: MODEL, load: { core: "ok", coreNotes: [] }, penalty: { state: "ok", data: PEN.players, meta: { earnedThroughWeek: PEN.earned_through_week } }, ns: { state: "idle" }, teamId: "0010", tab: "team", sub: "contracts", view: "lineup",
  open: {}, flags: {}, profile: null, sheet: null, skin: "system", vib: "1", build: "test", requestLog: [], gdef: "needs", wk: null, intel: { mu: {}, wk: {}, scores: {}, players: { state: "ok", data: { byId: {} }, at: 1 } }, ct: CT0(),
  requestSummary: { requests: 0, ok: 0, failed: 0, refused: 0, nonGet: 0 }, ...(over || {}) });
const P = (special, years, salary, extra) => ({ id: "1", name: "Test, Player", pos: "WR", status: "active", salary, years, special, type: "Vet-FAA", acquisition: "", franchiseId: "0010", ...(extra || {}) });
const player = (name) => { for (const tm of TEAMS) { const p = tm.players.find((x) => x.name === name); if (p) return p; } throw new Error("no " + name); };
const detailsOf = (name) => {
  const p = player(name), html = body(V.app(state({ teamId: p.franchiseId, ct: { ...CT0(), open: { [p.id]: true } } })));
  return text(html.split('aria-label="Open ' + p.name.replace(/&/g, "&amp;").replace(/'/g, "&#39;") + ' profile"')[1].split('<div class="rw">')[0]);
};
const yrs = (h) => h.rows.map((r) => [r.year, r.amount, r.phase]);

// ───────────────────────── the schedule of the contract in force ─────────────────────────
test("no extension: a 3-year deal from 2024 shows 2024, 2025 and 2026 (its own year tokens), and no extension line", () => {
  const p = P("CL 3| TCV 15K| AAV 5K| Y1-5K, Y2-5K, Y3-5K| GTD: 11.3K", 1, 5000, { type: "Vet-FAA", acquisition: "Auction $5,000 (2024)" });
  const h = C.history(p, 2026);
  t.deepEqual(yrs(h), [[2024, 5000, "done"], [2025, 5000, "done"], [2026, 5000, "now"]]); t.equal(h.start, 2024); t.equal(h.length, 3); t.ok(h.complete);
  t.equal(C.extension(p, 2026, TEAMS), null, "not an extension contract"); t.equal(C.extensionLine(null), "");
  // a real one from the recording: Javon Bullard (Rookie-Draft, CL 3)
  t.match(detailsOf("Javon Bullard"), /Salary schedule 2024 Completed \$1,000 2025 Completed \$1,000 2026 This season \$1,000 Contract 3 years, 2024–2026/);
  t.doesNotMatch(detailsOf("Javon Bullard"), /Extended/);
});

test("extended in 2026 for two more years: the current contract is 2026/2027/2028 (2026 is the extension's own first year); the 2024-2025 years of the earlier deal are not stitched in", () => {
  // canon §C4: the extension keeps this year's salary as Y1 and adds the extension years; its TCV is forward-looking (MFL text after the extension)
  const p = P("CL 3|TCV 70K|AAV 10K, 30K|Y1-10K, Y2-30K, Y3-30K|Ext: PG|GTD: 52.5K", 3, 10000, { type: "Vet-Ext2", franchiseId: "0004" });
  const h = C.history(p, 2026);
  t.deepEqual(yrs(h), [[2026, 10000, "now"], [2027, 30000, "left"], [2028, 30000, "left"]]); t.equal(h.start, 2026); t.equal(h.earlier, "none");
  const e = C.extension(p, 2026, TEAMS); t.equal(e.year, 2026); t.equal(e.years, 2); t.equal(e.by.id, "0004"); t.equal(C.extensionLine(e), "Extended by Pure Greatness · 2026");
  // the boundary one season later: in 2027 the same contract shows 2026 as Completed, never a year before 2026
  const h27 = C.history({ ...p, years: 2, salary: 30000 }, 2027); t.deepEqual(yrs(h27), [[2026, 10000, "done"], [2027, 30000, "now"], [2028, 30000, "left"]]);
  t.equal(C.extension({ ...p, years: 2, salary: 30000 }, 2027, TEAMS).year, 2026, "the extension year does not move with the season");
  // an expired rookie's extension (fresh deal, CL = the added years): the year is its first year
  const er = P("CL 1|TCV 12K|AAV 12K|Y1-12K|Ext: Cash|GTD: 9K", 1, 12000, { type: "Vet-Ext1", franchiseId: "0011" });
  t.equal(C.extension(er, 2026, TEAMS).year, 2026);
  // recorded: Rico Dowdle extended in 2025 (CL 2, 1 left): 2025 is the extension's first year, so it stays in the current contract
  t.match(detailsOf("Rico Dowdle"), /Salary schedule Extended by Blake Bombers · 2025 2025 Completed \$1,000 2026 This season \$11,000 Contract 2 years, 2025–2026/);
});

test("a length that does not fit the extension type gives no extension year (no guess)", () => {
  const p = P("CL 3|Y1-1K, Y2-1K, Y3-1K|Ext: PG", 1, 1000, { type: "Vet-Ext1" });   // an Ext1 is 1 or 2 years
  const e = C.extension(p, 2026, TEAMS); t.equal(e.year, null); t.equal(C.extensionLine(e), "Extended by Pure Greatness");
});

// ───────────────────────── attribution ─────────────────────────
test("attribution survives a later owner change: the LAST Ext: name is the extending team, not the current owner (Derrick Henry: LH extended, now with the Blake Bombers)", () => {
  const dh = player("Derrick Henry"); t.equal(dh.franchiseId, "0010");
  const e = C.extension(dh, 2026, TEAMS); t.equal(e.by.id, "0006"); t.ok(e.traded); t.equal(e.year, 2025);
  t.match(detailsOf("Derrick Henry"), /Extended by The Long Haulers · 2025/); t.doesNotMatch(detailsOf("Derrick Henry"), /Extended by Blake Bombers/);
  // a lineage of several grants: only the last one made the contract in force (A.J. Brown: Sex, Creel, LH -> LH)
  t.equal(C.extension(player("A.J. Brown"), 2026, TEAMS).by.id, "0006");
  // hand-made: extended by PG in 2025, traded to 0010 since
  const p = P("CL 2|Y1-5K, Y2-15K|Ext: Blake, PG", 1, 15000, { type: "Vet-Ext1", franchiseId: "0010" });
  t.equal(C.extensionLine(C.extension(p, 2026, TEAMS)), "Extended by Pure Greatness · 2025");
});

test("names are matched only through today's abbreviation/name, MFL's Latin-1 rendering of it, or the worker's nickname table; C.J. Stroud's 'ð¨ â°' is HammerTime", () => {
  const ids = (n) => { const x = C.teamForName(n, TEAMS); return x ? x.id : null; };
  t.equal(ids("Bomb"), "0010"); t.equal(ids("Blake"), "0010"); t.equal(ids("L.A."), "0001"); t.equal(ids("L.A. Looks"), "0001"); t.equal(ids("C-Town"), "0009"); t.equal(ids("CTwn"), "0009");
  t.equal(ids("GRide"), "0003"); t.equal(ids("Hammer"), "0005"); t.equal(ids("RealDeal"), "0008"); t.equal(ids("Creel"), "0008"); t.equal(ids("Cleon"), "0011"); t.equal(ids("Hawks"), "0012");
  const st = player("C.J. Stroud"); t.equal(C.extension(st, 2026, TEAMS).by.id, "0005", "mojibake of the emoji abbreviation");
  t.equal(ids("Mafia"), null, "a franchise that is not a current team is not named"); t.equal(ids("Nobody"), null);
});

test("unknown extender: no Ext: record, or a name that matches no current team -> 'Extended · 2026', never the current owner", () => {
  const noTok = P("CL 2|Y1-1K, Y2-11K|GTD: 9K", 2, 1000, { type: "Vet-Ext1", franchiseId: "0010" });
  const e = C.extension(noTok, 2026, TEAMS); t.equal(e.by, null); t.equal(C.extensionLine(e), "Extended · 2026");
  const odd = P("CL 2|Y1-1K, Y2-11K|Ext: Somebody", 2, 1000, { type: "Vet-Ext1", franchiseId: "0010" });
  t.equal(C.extensionLine(C.extension(odd, 2026, TEAMS)), "Extended · 2026");
  const old = P("CL 2|Y1-1K, Y2-11K|Ext: LH, Mafia", 2, 1000, { type: "Vet-Ext1", franchiseId: "0006" });
  t.equal(C.extensionLine(C.extension(old, 2026, TEAMS)), "Extended · 2026", "the last grant names no current team: the earlier LH is not used");
  // on the screen
  const s = state(), p = s.model.teams.find((x) => x.id === "0010").players.find((x) => x.name === "Will Anderson"), keep = p.special;
  p.special = "CL 2|TCV 5K|AAV 1K, 4K|Y1-1K, Y2-4K|GTD: 3.8K";
  const h = text(body(V.app({ ...s, ct: { ...CT0(), open: { [p.id]: true } } }))); p.special = keep;
  t.match(h, /Salary schedule Extended · 2026 2026 This season \$1,000 2027 Remaining \$4,000/); t.doesNotMatch(h, /Extended by/, "the current owner is not substituted");
});

test("the nickname table is the worker's own (worker/src/index.js EXT_OWNER_BY_NICKNAME), byte for byte", () => {
  const src = fs.readFileSync(path.join(REPO, "worker", "src", "index.js"), "utf8");
  const blk = src.match(/const EXT_OWNER_BY_NICKNAME = \{([^}]*)\}/); t.ok(blk, "the worker table is found");
  const w = {}; blk[1].replace(/(\w+)\s*:\s*"(\d{4})"/g, (_, k, v) => { w[k] = v; return ""; });
  t.deepEqual(C.LEGACY_EXT_NAMES, w);
});

// ───────────────────────── restructures ─────────────────────────
test("restructure: the re-based terms (canon §C5.1) start at the restructure; the start is claimed only from evidence", () => {
  // an Ext1 restructured in 2026 with exactly one year after it: the restructure came in the extension's own first season (§C4 + §C5) -> start 2026
  const hurts = player("Jalen Hurts"), hh = C.history(hurts, 2026), eh = C.extension(hurts, 2026, TEAMS);
  t.equal(hh.restructured, 2026); t.equal(hh.start, 2026); t.equal(hh.startWhy, "extension"); t.equal(eh.year, 2026); t.equal(eh.by.id, "0005"); t.ok(eh.traded);
  // an Ext2 restructured with one year after it: extended that season or the one before -> unknown, no start, no length, no year
  const nc = player("Nico Collins"), hn = C.history(nc, 2026), en = C.extension(nc, 2026, TEAMS);
  t.equal(hn.earlier, "restructured"); t.equal(hn.start, null); t.equal(hn.length, null); t.equal(hn.complete, false); t.equal(en.year, null); t.equal(C.extensionLine(en), "Extended by CBP");
  t.deepEqual(yrs(hn), [[2026, 19000, "now"], [2027, 75000, "left"]]);
  const dn = detailsOf("Nico Collins");
  t.match(dn, /Salary schedule Extended by CBP 2026 This season \$19,000 2027 Remaining \$75,000 Restructured in 2026\. Years before the restructure are not in the recorded terms\./);
  t.match(dn, /Contract Start not recorded, ends 2027/);
  // a re-based 2025 restructure keeps its recorded 2025 year (Chris Olave): listed, start still unknown
  t.deepEqual(yrs(C.history(player("Chris Olave"), 2026)), [[2025, 51000, "done"], [2026, 11000, "now"]]);
  // an auction contract restructured later: the auction year is its start; the year before the restructure is Not recorded (Terry McLaurin)
  const tm = C.history(player("Terry McLaurin"), 2026);
  t.equal(tm.start, 2025); t.equal(tm.startWhy, "auction"); t.deepEqual(yrs(tm), [[2025, null, "done"], [2026, 8000, "now"], [2027, 30000, "left"]]); t.equal(tm.earlier, "partial");
  t.match(detailsOf("Terry McLaurin"), /2025 Completed Not recorded 2026 This season \$8,000 2027 Remaining \$30,000 Restructured in 2026\. Salaries before the restructure are not in the recorded terms\. .*Contract 3 years, 2025–2027/);
  // a restructure token that is not the first recorded year (not re-based): the terms are read as they are
  const nr = C.history(P("CL 3| Y1-4K, Y2-5K, Y3-6K| Restructured 2025", 1, 6000), 2026); t.equal(nr.start, 2024); t.equal(nr.earlier, "recorded");
  t.equal(C.restructureYear("CL 2| restructure: 2025"), 2025); t.equal(C.restructureYear("Restructured 2026"), 2026); t.equal(C.restructureYear("CL 2"), null);
});

test("never copied backward: a completed or pre-restructure year with no recorded amount stays Not recorded, never today's salary", () => {
  const gap = C.history(P("CL 3| Y3-6K", 1, 6000), 2026); t.deepEqual(gap.rows.map((r) => r.amount), [null, null, 6000]);
  const auc = C.history(P("CL 2| Y1-8K, Y2-30K| Restructured 2026", 2, 8000, { type: "Vet-FAA-BL", acquisition: "Auction $19,000 (2024)" }), 2026);
  t.deepEqual(yrs(auc), [[2024, null, "done"], [2025, null, "done"], [2026, 8000, "now"], [2027, 30000, "left"]]); t.equal(auc.missing, 2);
  // the auction price in the acquisition text is not used as a salary
  t.ok(auc.rows.every((r) => r.amount !== 19000));
  // a trade acquisition gives no start evidence
  const tr = C.history(P("CL 2| Y1-8K, Y2-30K| Restructured 2026", 2, 8000, { type: "Vet-FAA-BL", acquisition: "Trade (2024)" }), 2026); t.equal(tr.earlier, "restructured"); t.equal(tr.start, null);
});

// ───────────────────────── the recorded league, counted ─────────────────────────
test("recorded league: 45 extension contracts, extending team named for 45, extension year for 36 (9 unknown after a restructure), 23 extended then traded; 21 restructured, 10 with an unknown start", () => {
  let ext = 0, team = 0, year = 0, traded = 0, rs = 0, rsUnknown = 0;
  TEAMS.forEach((tm) => tm.players.forEach((p) => {
    const e = C.extension(p, 2026, TEAMS), h = C.history(p, 2026);
    if (e) { ext++; if (e.by) team++; if (e.year != null) year++; if (e.traded) traded++; t.ok(!e.by || e.by.id !== p.franchiseId || !e.traded); }
    if (h.restructured != null) { rs++; if (h.earlier === "restructured") rsUnknown++; }
  }));
  t.deepEqual([ext, team, year, traded, rs, rsUnknown], [45, 45, 36, 23, 21, 10]);
});

run("mobile2027_r7_contracts");
