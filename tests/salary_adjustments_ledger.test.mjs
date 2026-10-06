// GET /api/salary-adjustments/ledger — the Front Office "Salary Adjustments" tab.
//   node tests/salary_adjustments_ledger.test.mjs
//
// Keith 2026-10-06: "a new tab for Salary Adjustments … a listing by team, year,
// type (traded salary vs. dropped player vs. misc), date of assessment,
// adjustment amt, player w. contract details (original yrs, TCV, GTD, Earned)
// dropped if dropped player, if salary traded indicate the other team involved
// and trade details, if misc indicate for what. For now let's show '26 as well
// as the future penalties for '27."
//
// The REAL worker route runs over the league's REAL data, read 2026-10-06
// (tests/fixtures/salary_adjustments_2026_10_06.json): MFL's 58 posted 2026
// salaryAdjustments, the 2026 TRADE transactions, D1's 2026 drop ledger and
// the RULE 2 fines. The 2025-era drops' contracts come from the repo's own
// site/reports/salary_adjustments/salary_adjustments_2026.json, served for the
// Pages URL the worker fetches. Every other outbound call answers 503.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { makeD1 } from "./fixtures/d1_sqlite.mjs";
import { t, test, run } from "./fixtures/mini_test.mjs";
await import("./fixtures/register_md_loader.mjs");
const worker = (await import("../worker/src/index.js")).default;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FX = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/salary_adjustments_2026_10_06.json"), "utf8"));
const REPORT = fs.readFileSync(path.join(ROOT, "site/reports/salary_adjustments/salary_adjustments_2026.json"), "utf8");
const WORKER_SRC = fs.readFileSync(path.join(ROOT, process.env.WORKER_JS || "worker/src/index.js"), "utf8");

const json = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { "content-type": "application/json" } });
const calls = [];
globalThis.fetch = async (input) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  calls.push(u.host + u.pathname + (u.searchParams.get("TYPE") ? " " + u.searchParams.get("TYPE") : ""));
  if (u.host === "keithcreelman.github.io" && u.pathname.endsWith("/reports/salary_adjustments/salary_adjustments_2026.json")) {
    return new Response(REPORT, { status: 200, headers: { "content-type": "application/json" } });
  }
  if (u.pathname.endsWith("/export")) {
    const type = u.searchParams.get("TYPE");
    if (type === "salaryAdjustments") return json(FX.salaryAdjustments);
    if (type === "league") return json({ league: { franchises: { franchise: FX.franchises } } });
    if (type === "transactions" && u.searchParams.get("TRANS_TYPE") === "TRADE") return json(FX.trades);
    if (type === "players") {
      const ids = String(u.searchParams.get("P") || "").split(",");
      return json({ players: { player: FX.players.filter((p) => ids.includes(p.id)) } });
    }
  }
  return json({ error: "test: no such call" }, 503);
};

function makeDb() {
  const db = makeD1({});
  const cols = Object.keys(FX.drop_events[0]);
  db.raw.exec(`CREATE TABLE ups_drop_events (${cols.map((c) => c + (/(_unix|_salary|_year|_length|_tcv|_aav|earned|guaranteed|penalty_amount|exempt|posted)/.test(c) ? " INTEGER" : " TEXT")).join(", ")})`);
  const ins = db.raw.prepare(`INSERT INTO ups_drop_events (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
  for (const r of FX.drop_events) ins.run(...cols.map((c) => r[c]));
  db.raw.exec("CREATE TABLE ups_faa_nom_penalties (penalty_id TEXT, season INTEGER, league_id TEXT, fid TEXT, et_day TEXT, offense_no INTEGER, amount_k INTEGER, applies_to_season INTEGER, posted_to_mfl INTEGER, voided INTEGER)");
  const r2 = db.raw.prepare("INSERT INTO ups_faa_nom_penalties VALUES (?,?,?,?,?,?,?,?,?,?)");
  for (const r of FX.faa_nom_penalties) r2.run(r.penalty_id, r.season, r.league_id, r.fid, r.et_day, r.offense_no, r.amount_k, r.applies_to_season, r.posted_to_mfl, r.voided);
  return db;
}

let DB = null;
async function ledger() {
  DB = makeDb();
  calls.length = 0;
  const env = { UPS_MFL_DB: DB, MFL_COOKIE: "COMMISH", MFL_APIKEY: "k", FA_AUCTION_START_AT: String(FX.auction_start_unix) };
  const res = await worker.fetch(new Request("https://w.test/api/salary-adjustments/ledger?L=74598&YEAR=2026"), env, { waitUntil() {}, passThroughOnException() {} });
  return { status: res.status, body: await res.json() };
}
const { status, body } = await ledger();
const Y26 = body.years && body.years[0];
const Y27 = body.years && body.years[1];
const find = (rows, pred) => rows.find(pred) || null;

test("one response, two years: 2026 = MFL's 58 posted rows; 2027 = the next-season ledger", () => {
  t.equal(status, 200); t.equal(body.ok, true);
  t.equal(Y26.season, 2026); t.equal(Y26.source, "mfl_salary_adjustments");
  t.equal(Y26.rows.length, 58, "every MFL row, none dropped");
  const mflTotal = FX.salaryAdjustments.salaryAdjustments.salaryAdjustment.reduce((a, r) => a + Number(r.amount), 0);
  t.equal(Y26.total, mflTotal, `2026 total = MFL's own sum (${mflTotal})`);
  t.equal(Y27.season, 2027); t.equal(Y27.source, "ups_next_season_ledger");
  t.equal(Y27.rows.length, 16, "15 post-auction drops + the Hawks' RULE 2 carry-over");
  t.equal(Y27.total, 25471, "= /api/cap-adjustments/next-season's grand_total on 2026-10-06 (22,471 drops + the 3,000 fine)");
  t.equal(body.franchises.length, 12);
});

test("types: 8 traded-salary, 41 dropped-player, 9 misc (rounding + RULE 2) in 2026", () => {
  const n = (ty) => Y26.rows.filter((r) => r.type === ty).length;
  t.equal(n("trade"), 8); t.equal(n("drop"), 41); t.equal(n("misc"), 9);
  t.equal(Y26.by_type.trade, 0, "settlements net to zero across the league");
  const labels = Array.from(new Set(Y26.rows.map((r) => r.type_label))).sort();
  t.equal(JSON.stringify(labels), JSON.stringify(["Dropped player", "Misc", "Traded salary"]));
});

test("a 2025-era drop (adddrop id) carries its pre-drop contract from the season report", () => {
  const r = find(Y26.rows, (x) => x.drop && x.drop.player_name === "Fitzpatrick, Minkah");
  t.ok(r, "Minkah Fitzpatrick's row");
  t.equal(r.franchise_id, "0010"); t.equal(r.amount, 1000);
  t.equal(r.assessed_iso, "2026-04-17T15:50:58.000Z", "assessed = when MFL posted it");
  t.equal(r.drop.dropped_at_et, "2025-08-13 17:53:39", "dropped = the add/drop transaction");
  t.equal(r.drop.original_years, 3); t.equal(r.drop.tcv, 12000); t.equal(r.drop.gtd, 9000); t.equal(r.drop.earned, 8000);
  t.equal(r.drop.details_source, "report_salary_adjustments_2026");
  const all = Y26.rows.filter((x) => x.type === "drop" && /adddrop/.test(x.description));
  t.equal(all.length, 31); t.ok(all.every((x) => x.drop.details_source === "report_salary_adjustments_2026"), "all 31 joined");
});

test("a 2026 drop (pid_unix ledger key) carries its pre-drop contract from D1", () => {
  const r = find(Y26.rows, (x) => x.drop && x.drop.player_name === "Tyreek Hill");
  t.ok(r); t.equal(r.franchise_id, "0007"); t.equal(r.amount, 26500);
  t.equal(r.drop.original_years, 2); t.equal(r.drop.tcv, 142000); t.equal(r.drop.gtd, 106500); t.equal(r.drop.earned, 80000);
  t.equal(r.drop.contract_status, "Vet-FAA"); t.equal(r.drop.details_source, "d1_ups_drop_events");
  const d1 = Y26.rows.filter((x) => x.type === "drop" && /id:\d+_\d+/.test(x.description));
  t.equal(d1.length, 10); t.ok(d1.every((x) => x.drop.details_source === "d1_ups_drop_events"), "all 10 joined");
});

test("MFL's posted dollars are shown; the source's own computed figure rides along, never substituted", () => {
  const felton = find(Y26.rows, (x) => x.drop && x.drop.player_name === "Felton, Tai");
  t.equal(felton.amount, 1000, "MFL posted $1,000");
  t.equal(felton.drop.ledger_amount, 1750, "the report computes $1,750 — kept visible for the audit");
  const roundRow = find(Y26.rows, (x) => /rounding L\.A\. Looks/.test(x.description));
  t.equal(roundRow.amount, 450, "a sub-$1K row is $450, not $450K");
});

test("traded salary: the other team and the MFL trade's assets", () => {
  const cbp = find(Y26.rows, (x) => x.type === "trade" && x.franchise_id === "0002");
  t.equal(cbp.amount, -12000); t.equal(cbp.trade.counterparty_name, "Blake Bombers");
  t.equal(cbp.trade.matched, true); t.equal(cbp.trade.traded_at_iso, "2026-08-24T02:31:21.000Z", "MFL trade 1787538681");
  const sent = cbp.trade.legs.find((l) => l.from_fid === "0002").assets.map((a) => a.label);
  const got = cbp.trade.legs.find((l) => l.to_fid === "0002").assets.map((a) => a.label);
  t.ok(sent.includes("2027 Rd 4 pick (CBP)"), sent.join(" | "));
  t.ok(got.includes("$12K traded salary"), got.join(" | "));
  t.ok(got.every((x) => !/^Player \d+$/.test(x)), "every player resolved to a name: " + got.join(" | "));
  const every = Y26.rows.filter((x) => x.type === "trade");
  t.ok(every.every((x) => x.trade.matched && x.trade.counterparty_fid), "all 8 settlement rows found their trade and counterparty");
});

test("3-way: the settlement names its leg and all three teams", () => {
  const ct = find(Y26.rows, (x) => x.type === "trade" && x.franchise_id === "0009");
  t.equal(ct.amount, 19000); t.equal(ct.trade.three_way, true);
  t.equal(ct.trade.counterparty_fid, "0010");
  t.equal(ct.trade.three_way_teams.map((x) => x.franchise_id).sort().join(","), "0008,0009,0010");
  t.ok(ct.trade.legs.some((l) => l.from_fid === "0009" && l.assets.some((a) => a.label === "$19K traded salary")), "C-Town sent the $19K");
});

test("misc says what it was for", () => {
  const r2 = find(Y26.rows, (x) => x.misc && x.misc.kind === "rule2");
  t.equal(r2.franchise_id, "0012"); t.equal(r2.amount, 3000);
  t.equal(r2.misc.reason, "RULE 2 fine — missed FA Auction nomination on 2026-07-28 (offense 1)");
  const rounds = Y26.rows.filter((x) => x.misc && x.misc.kind === "drop_rounding");
  t.equal(rounds.length, 8);
  t.match(rounds[0].misc.reason, /nearest \$1K/);
});

test("2027: the next-season drops with D1 contract details, and the RULE 2 carry-over", () => {
  const jonnu = find(Y27.rows, (x) => x.drop && x.drop.player_name === "Jonnu Smith");
  t.equal(jonnu.amount, 7500); t.equal(jonnu.franchise_name, "HammerTime 🔨 ⏰"); t.equal(jonnu.in_mfl, false);
  t.equal(jonnu.drop.original_years, 3); t.equal(jonnu.drop.tcv, 18000); t.equal(jonnu.drop.gtd, 13500); t.equal(jonnu.drop.earned, 6000);
  t.equal(jonnu.assessed_iso, "2026-08-28T14:48:24.000Z", "assessed = the drop");
  const levis = find(Y27.rows, (x) => x.drop && x.drop.player_name === "Will Levis");
  t.equal(levis.drop.earned, null, "a flat $1K-rule drop has no earned figure in D1 → null, not a guess");
  const fine = find(Y27.rows, (x) => x.misc && x.misc.kind === "rule2");
  t.equal(fine.amount, 3000); t.match(fine.misc.reason, /carried into 2027/);
  t.ok(!Y27.rows.some((x) => x.drop && x.drop.player_name === "Tyreek Hill"), "a pre-auction (2026-cap) drop is not repeated in 2027");
});

test("review: a trade that moved cap dollars with no settlement on MFL is reported", () => {
  const u = body.review.unsettled_traded_salary;
  t.equal(u.length, 1, JSON.stringify(u.map((x) => x.teams.map((y) => y.franchise_id))));
  t.equal(u[0].teams.map((x) => x.franchise_id).join(","), "0001,0003");
  t.equal(u[0].traded_salary.join(), "$10K traded salary");
});

test("read-only: no MFL import, no D1 write", () => {
  t.ok(!calls.some((c) => /\/import\b/.test(c)), calls.join(" | "));
  t.ok(!DB.log.some((x) => /^\s*(INSERT|UPDATE|DELETE|CREATE)/i.test(x.sql)), "only SELECTs");
});

test("pure helpers: picks are zero-indexed DP / owner-named FP; BB_ is traded salary", () => {
  const c = vm.createContext({});
  const fns = ["function saladjClassify(", "function saladjAssetLabel(", "function saladjMatchTrade("];
  const slice = (sig) => {
    const at = WORKER_SRC.indexOf(sig); let i = WORKER_SRC.indexOf("{", at), depth = 0;
    for (; i < WORKER_SRC.length; i++) { if (WORKER_SRC[i] === "{") depth++; else if (WORKER_SRC[i] === "}" && --depth === 0) return WORKER_SRC.slice(at, i + 1); }
    throw new Error(sig);
  };
  vm.runInContext(fns.map(slice).join("\n") + "\nthis.api = { saladjClassify, saladjAssetLabel, saladjMatchTrade };", c);
  const A = c.api;
  t.equal(A.saladjAssetLabel("DP_0_3", { season: "2026" }).label, "2026 pick 1.04");
  t.equal(A.saladjAssetLabel("FP_0004_2027_1", { fidName: { "0004": "Pure Greatness" } }).label, "2027 Rd 1 pick (Pure Greatness)");
  t.equal(A.saladjAssetLabel("BB_2500").label, "$2.5K traded salary");
  t.equal(A.saladjClassify("Commish fix for a scoring error").type, "misc", "an unrecognised row is misc with its own words");
  t.equal(A.saladjClassify("Commish fix for a scoring error").reason, "Commish fix for a scoring error");
  t.equal(A.saladjClassify("UPS drop penalty Tony Pollard 13500 id:14085_1784770121").key, "14085_1784770121");
  const trades = [{ a: "0001", b: "0002", unix: 1000, a_gave: ["BB_5000"], b_gave: [], comments: "" },
    { a: "0002", b: "0001", unix: 1001, a_gave: [], b_gave: [], comments: "" }];
  t.equal(A.saladjMatchTrade("0001", "0002", 1001, 5000, "trade_20261", trades), trades[0], "the BB_ amount outranks a closer timestamp");
  t.equal(A.saladjMatchTrade("0001", "0002", 1000 + 4 * 86400, 5000, "trade_20261", trades), null, "nothing more than 3 days away");
});

await run("salary_adjustments_ledger");
