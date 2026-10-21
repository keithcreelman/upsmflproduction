// Overview cards (#1338): the Trade deadline card states when MFL actually stops trades (MFL's calendar, earliest
// "No Trades Allowed" event, Eastern time) — never the league calendar's date as if it were MFL's; the Cap card
// shows player salaries, adjustments, total allocated and cap space with two ledgers; Lineup strength offers four
// views with Overall, K and P; "Contracts ending this season" is gone.
//   node tests/front_office_overview_cards.test.mjs
//   FO_OVERVIEW_JS=<path> node tests/front_office_overview_cards.test.mjs   (defect check against another copy)
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(process.env.FO_OVERVIEW_JS || path.join(ROOT, "site/rosters/v2/fo_overview.js"), "utf8");
const ctx = vm.createContext({ document: { addEventListener() {}, getElementById() { return null; } }, Intl, Date });
ctx.window = ctx;
vm.runInContext(SRC, ctx);
const OV = ctx.UPS_FO_OVERVIEW;
const ms = (iso) => Date.parse(iso);

test("Trade deadline = MFL's own lock as the worker reads it (trade_lock): today Tue Nov 24 12:00 PM ET; Wed 8 PM once corrected", () => {
  t.ok(OV && typeof OV.tradeDeadlineFromLock === "function", "exposed for tests");
  const tue = { state: "upcoming", start_unix: 1795539600, label: "Tue, Nov 24, 12:00 PM ET" };
  const d = OV.tradeDeadlineFromLock(tue, ms("2026-10-20T20:00:00-04:00"));
  t.equal(d.state, "upcoming"); t.equal(d.label, "Tue, Nov 24, 12:00 PM ET"); t.equal(d.days, 35, "Oct 20 → Nov 24 in Eastern calendar days");
  t.equal(OV.tradeDeadlineFromLock(tue, ms("2026-11-24T12:00:00-05:00")).state, "upcoming", "inside the start second MFL still accepts");
  t.equal(OV.tradeDeadlineFromLock(tue, ms("2026-11-24T12:00:01-05:00")).state, "closed", "from the next second: closed, as MFL refuses");
  const wed = OV.tradeDeadlineFromLock({ state: "upcoming", start_unix: 1795654800, label: "Wed, Nov 25, 8:00 PM ET" }, ms("2026-10-21T08:00:00-04:00"));
  t.equal(wed.label, "Wed, Nov 25, 8:00 PM ET", "the corrected week-based lock (Week 12), as MFL places it");
  t.equal(OV.tradeDeadlineFromLock({ state: "unresolved" }, Date.now()).state, "unresolved", "never a guessed time");
  t.equal(OV.tradeDeadlineFromLock({ state: "none" }, Date.now()).state, "none");
  t.equal(OV.tradeDeadlineFromLock(null, Date.now()), null, "not read yet");
});

test("the card reads the worker's trade_lock (one source with the phone, Team Ops, reminders and Rules), not MFL's calendar directly", () => {
  t.ok(/FO\.tradeLock\(\)/.test(SRC) && !/DATA\.get\("mflCalendar"\)/.test(SRC), "reads FO.tradeLock(), not the raw calendar");
  t.ok(/MFL’s trade lock couldn’t be read right now/.test(SRC), "an unreadable lock is said, never replaced by a date");
  t.ok(!/league calendar · /.test(SRC) && !/ups_trade_deadline/.test(SRC), "the typed league-calendar date is not used");
  const fo = fs.readFileSync(path.join(ROOT, "site/rosters/v2/front_office.js"), "utf8");
  t.ok(/STATE\.tradeLock = \(data && data\.trade_lock\) \|\| null;/.test(fo) && /tradeLock: function \(\) \{ return STATE\.tradeLock \|\| null; \}/.test(fo), "front_office.js keeps trade_lock from /api/league-events");
});

test("Cap card: player salaries, adjustments, total allocated, cap space; both ledgers open from the card", () => {
  for (const s of ["Player salaries", "Salary adjustments", "Total allocated", "Cap space"]) t.ok(SRC.indexOf('line("' + s + '"') !== -1, s);
  t.ok(/data-ov-ledger="players"/.test(SRC) && /data-ov-ledger="adjustments"/.test(SRC), "two drill-throughs");
  t.ok(/FO\.capLedger\(fid\)/.test(SRC), "numbers from the Front Office cap engine");
  t.ok(/led\.capSnapshot\.salaryCap/.test(SRC) && /led\.capSnapshot\.adjTotal/.test(SRC), "each ledger is checked against the cap card");
});

test("Lineup strength: four views, Overall + K + P, original view first; 'Contracts ending this season' removed", () => {
  t.ok(/var lsView = "above"/.test(SRC), "the original chart stays the default");
  t.ok(/LS\.ROWS\.map/.test(SRC) && /data-ls-view/.test(SRC), "rows from lineup_strength (ALL, positions, K, P) and a view control");
  t.ok(!/Contracts ending this season/.test(SRC) && !/expiringCard/.test(SRC), "card removed");
  t.ok(/mine\.replacementSlots/.test(SRC) && /fo-ov-rep/.test(SRC), "replacement-filled slots are marked and named");
  t.ok(/mine\.biggestNeed/.test(SRC) && !/TF\.teamSummary\(model, fid\)/.test(SRC), "Biggest need from the same owned-roster table");
  t.ok(/league <b>median<\/b>/.test(SRC) && /league <b>mean<\/b>/.test(SRC), "About explains median (Above repl.) vs mean (Index)");
  for (const c of ["capCard(", "weekCard(", "deadlineCard()", "Needs attention", "strengthCard(", "picksCard("]) t.ok(SRC.indexOf(c) !== -1, "kept: " + c);
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
