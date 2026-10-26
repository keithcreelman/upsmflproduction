// Overview cards (#1338): the Trade deadline card states when MFL actually stops trades (MFL's calendar, earliest
// "No Trades Allowed" event, Eastern time) — never the league calendar's date as if it were MFL's; the Cap card
// shows player salaries, adjustments, total allocated and cap space with two ledgers; the Overview has no Lineup strength card
// (Keith 2026-10-26: Draft picks takes its place; strength is in Trade finder); "Contracts ending this season" is gone.
//   node tests/front_office_overview_cards.test.mjs
//   FO_OVERVIEW_JS=<path> node tests/front_office_overview_cards.test.mjs   (defect check against another copy)
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(process.env.FO_OVERVIEW_JS || path.join(ROOT, "site/rosters/v2/fo_overview.js"), "utf8");
const CAL = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/mfl_calendar_trade_events_2026.json"), "utf8"));
const ctx = vm.createContext({ document: { addEventListener() {}, getElementById() { return null; } }, Intl, Date });
ctx.window = ctx;
vm.runInContext(SRC, ctx);
const OV = ctx.UPS_FO_OVERVIEW;
const ms = (iso) => Date.parse(iso);

test("Trade deadline = MFL's first 'No Trades Allowed' (Tue Nov 24, 12:00 PM ET), not the league calendar's Nov 25", () => {
  t.ok(OV && typeof OV.tradeDeadlineFrom === "function", "exposed for tests");
  const d = OV.tradeDeadlineFrom(CAL, ms("2026-10-20T20:00:00-04:00"));
  t.equal(d.state, "upcoming");
  t.equal(d.label, "Tue, Nov 24, 12:00 PM ET", "Eastern time, MFL's earliest TRADE event");
  t.ok(/formatToParts/.test(SRC) && !/toLocaleString\("en-US", \{ timeZone: "America\/New_York", weekday/.test(SRC), "built from date parts: Safari's toLocaleString adds \"at\"");
  t.equal(d.days, 35, "Oct 20 → Nov 24 in Eastern calendar days");
  t.equal(d.events, 3, "three TRADE events read; the waiver event ignored");
  const after = OV.tradeDeadlineFrom(CAL, ms("2026-11-24T12:00:01-05:00"));
  t.equal(after.state, "closed", "one second after noon: closed");
  t.equal(OV.tradeDeadlineFrom(CAL, ms("2026-11-24T09:00:00-05:00")).days, 0, "the morning of: today");
  t.equal(OV.tradeDeadlineFrom({ calendar: { event: [] } }, Date.now()), null, "no TRADE event → nothing invented");
  const ended = { calendar: { event: [{ type: "TRADE", start_time: "1790000000", end_time: "1790003600" }] } };
  t.equal(OV.tradeDeadlineFrom(ended, ms("2026-10-20T12:00:00-04:00")), null, "a TRADE blackout that already ended doesn't count");
});

test("the card reads MFL's calendar, with the viewer's session; without it, it says so (no league-calendar date dressed up as MFL's)", () => {
  t.ok(/"mflCalendar"/.test(SRC) && /DATA\.get\("mflCalendar"\)/.test(SRC), "loads and reads the MFL calendar");
  t.ok(/Sign in to MFL to see when MFL stops trades/.test(SRC), "unreadable calendar is said");
  t.ok(!/league calendar · /.test(SRC) && !/ups_trade_deadline/.test(SRC), "the league-calendar deadline is gone from the card and from Needs attention");
  const data = fs.readFileSync(path.join(ROOT, "site/rosters/v2/fo_data.js"), "utf8");
  t.ok(/mflCalendar: function \(\) \{\s*return getJson\(cfg\.sessionQuery\(mflExport\("calendar"\)\)\)/.test(data), "fo_data reads TYPE=calendar with the viewer's session");
});

test("Cap card: player salaries, adjustments, total allocated, cap space; both ledgers open from the card", () => {
  for (const s of ["Player salaries", "Salary adjustments", "Total allocated", "Cap space"]) t.ok(SRC.indexOf('line("' + s + '"') !== -1, s);
  t.ok(/data-ov-ledger="players"/.test(SRC) && /data-ov-ledger="adjustments"/.test(SRC), "two drill-throughs");
  t.ok(/FO\.capLedger\(fid\)/.test(SRC), "numbers from the Front Office cap engine");
  t.ok(/led\.capSnapshot\.salaryCap/.test(SRC) && /led\.capSnapshot\.adjTotal/.test(SRC), "each ledger is checked against the cap card");
});

test("Overview: no Lineup strength card (Keith 2026-10-26); Draft picks takes its place; 'Contracts ending this season' stays removed", () => {
  t.ok(!/strengthCard|Lineup strength vs the league|lsView|lsBy|data-ls-|Biggest lineup gain|additionDetail/.test(SRC), "the Lineup strength card, its controls and its Biggest-gain line are gone from the Overview");
  t.ok(/var side = picksCard\(fid\);/.test(SRC), "the side column starts with Draft picks, where the strength card was");
  t.ok(!/Contracts ending this season/.test(SRC) && !/expiringCard/.test(SRC), "card removed");
  t.ok(!/Biggest need/.test(SRC), "never labeled a need (Keith 2026-10-22)");
  t.ok(/Lineup strength for every team is in Trade finder/.test(SRC), "About points to Trade finder");
  for (const c of ["capCard(", "weekCard(", "deadlineCard()", "Needs attention", "picksCard("]) t.ok(SRC.indexOf(c) !== -1, "kept: " + c);
});

test("an injury or league-events read that lands before fo:ready doesn't throw (render waits for boot)", () => {
  t.ok(/function render\(\) \{\s*\/\/[^\n]*\n\s*if \(!H \|\| !FO \|\| !DATA\) return;/.test(SRC), "render is guarded");
  let threw = null;
  try { ctx.document.listeners = null; } catch (e) {}
  const c2 = vm.createContext({ document: { _l: {}, addEventListener(n, f) { (this._l[n] = this._l[n] || []).push(f); }, getElementById() { return { innerHTML: "" }; } }, Intl, Date });
  c2.window = c2;
  vm.runInContext(SRC, c2);
  try { (c2.document._l["fo:injury"] || []).forEach((f) => f()); (c2.document._l["fo:events"] || []).forEach((f) => f()); } catch (e) { threw = e; }
  t.equal(threw, null, "no TypeError before boot");
});

await run("front_office_overview_cards");
