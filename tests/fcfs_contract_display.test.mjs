// FCFS CONTRACTS (PR B — client display) — Front Office · roster workbench · mobile · cap_math · Team Operations · the player profile
// all show the FCFS classes ("Full-year rule" / "Not applicable") the SAME way the worker (worker/src/fcfs_contract.js, PR A) classifies them.
//   node tests/fcfs_contract_display.test.mjs
// Split out of tests/fcfs_contract.test.mjs 2026-09-27 so PR A (worker + tooling) never needs the new client rendering, and PR B (this file)
// never needs the worker harness / SQLite fixtures PR A's tests use. See tests/fcfs_contract.test.mjs for the worker-side rule tests.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";
const FC = await import("../worker/src/fcfs_contract.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

test("DISPLAY: Front Office — '1K Per Yr' / 'Full-year rule' for the $1K-a-year class; 'nK Per Yr' / 'Not applicable' for the canon §C3 WW class; EVERY other contract shows its ACTUAL per-week rate — no TCV proxy", () => {
  const fo = read("site/rosters/v2/front_office.js");
  const i = fo.indexOf("function isOneKPerYearPlayer(player) {"), j = fo.indexOf("  // Per-Week Earning = current-year salary");
  const k = fo.indexOf("function isWwEarnedNaPlayer(player) {"), l = fo.indexOf("function perWeekEarningValue");
  t.ok(i > 0 && j > i && k > j && l > k, "the slices are in the expected order");
  const rows = { "1": { penalty: 0, guaranteed: 0, earned: null, earned_rule: "full_year_sub_5k", exempt: true, exempt_reason: "WW pickup salary ≤ $4K, final year (§D2).", tcv: 1000, basis: "ww_under_5k_exempt" },
    "2": { penalty: 0, guaranteed: 0, earned: 4000, tcv: 25000, basis: "guarantee_minus_earned" },
    "3": { penalty: 0, guaranteed: 0, earned: null, earned_rule: "ww_earned_na", exempt: true, exempt_reason: "WW pickup salary ≤ $4K, final year (§D2).", tcv: 4000, basis: "ww_under_5k_earned_na" },
    "4": { penalty: 0, guaranteed: 0, earned: 235, tcv: 2000, basis: "one_year_under_5k_exempt", exempt: true },
    "5": { penalty: 0, guaranteed: 0, earned: 353, tcv: 3000, basis: "ww_under_5k_exempt", exempt: true },
    "6": { penalty: 0, guaranteed: 0, earned: null, earned_rule: "ww_earned_na", exempt: true, exempt_reason: "WW pickup salary ≤ $4K, final year (§D2).", tcv: 3000, basis: "ww_under_5k_earned_na" } };
  const mk = (feed, byPid) => { const ctx = { STATE: { capPenaltyFeed: feed, capPenaltyByPid: byPid }, safeStr: (v) => String(v == null ? "" : v), safeInt: (v, d) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : (d || 0); },
    totalContractValueForPlayer: (p) => p.tcv, contractLengthForPlayer: (p) => p.cl, guaranteedContractValueForPlayer: () => 0, money: (n) => "$" + n, fmtUSD: (n) => (Number.isFinite(n) ? "$" + n : "—"), result: null };
    vm.createContext(ctx); vm.runInContext(fo.slice(i, j) + "\n" + fo.slice(k, l), ctx); return ctx; };
  const ctx = mk("ok", rows);
  vm.runInContext(`result = {
    a: dropPenaltyEstimate({id:'1', tcv:1000, salary:1000, years:1}), b: dropPenaltyEstimate({id:'2', tcv:25000, salary:25000, years:1}), c: dropPenaltyEstimate({id:'3', tcv:4000, salary:4000, years:1}),
    d: dropPenaltyEstimate({id:'4', tcv:2000, salary:2000, years:1}), e: dropPenaltyEstimate({id:'5', tcv:3000, salary:3000, years:1}),
    pw1: perWeekEarningInfo({id:'1', type:'Vet-WW', tcv:1000, cl:1, salary:1000, years:1}), pw2: perWeekEarningInfo({id:'2', type:'Vet-FAA', tcv:25000, cl:1, salary:25000, years:1}),
    pw3: perWeekEarningInfo({id:'3', type:'Vet-WW', tcv:4000, cl:1, salary:4000, years:1}), pw4: perWeekEarningInfo({id:'4', type:'Vet-FAA', tcv:2000, cl:1, salary:2000, years:1}),
    pw5: perWeekEarningInfo({id:'6', type:'Vet-WW', tcv:3000, cl:1, salary:3000, years:1}), pw5b: perWeekEarningInfo({id:'5', type:'Vet-WW', tcv:3000, cl:1, salary:3000, years:1}), pw6: perWeekEarningInfo({id:'9', type:'Vet-FAA', tcv:4000, cl:1, salary:4000, years:1}),
    pw7: perWeekEarningInfo({id:'9', type:'Vet-FAA', tcv:4000, cl:2, salary:2000, years:2}), pw8: perWeekEarningInfo({id:'9', type:'Vet-MYM', tcv:3000, cl:3, salary:1000, years:3}),
    pw9: perWeekEarningInfo({id:'9', type:'Vet-FAA', tcv:5000, cl:5, salary:1000, years:5}) };`, ctx);
  const r = ctx.result;
  // the $1K class
  t.equal(r.a.earnedRule, "full_year"); t.equal(Number.isNaN(r.a.earned), true, "no number at all"); t.equal(r.a.earnedState, "ok"); t.equal(r.a.amount, 0); t.match(r.a.note, /full-year rule/i);
  t.equal(r.pw1.label, "1K Per Yr", "PER WK: the proven class"); t.notEqual(r.pw2.label, "1K Per Yr");
  t.equal(r.b.earned, 4000, "a normal contract still shows its earned"); t.equal(r.b.earnedRule, undefined);
  // the canon §C3 WW class — earned NOT APPLICABLE, penalty unchanged
  t.equal(r.c.earnedRule, "ww_na"); t.equal(Number.isNaN(r.c.earned), true, "not a number"); t.equal(r.c.earnedState, "ok"); t.equal(r.c.amount, 0); t.match(r.c.note, /not applicable/i);
  t.equal(r.pw3.label, "4K Per Yr", "PER WK: the WW class reads its own rate"); t.equal(r.pw5.label, "3K Per Yr"); t.equal(r.pw5b.label, "$176", "a WW row the worker did NOT classify shows its actual rate");
  // everything else: earned as before, and the ACTUAL per-week rate — never '1K Per Yr' because TCV ≤ $4K
  t.equal(r.d.earned, 235, "a $2K Vet-FAA one-year deal is NOT the class: its earned figure is untouched"); t.equal(r.d.earnedRule, undefined);
  t.equal(r.e.earnedRule, undefined, "a row the worker did not classify keeps its number"); t.equal(r.e.earned, 353);
  t.equal(r.pw4.label, "$118", "$2K Vet-FAA: $2,000 / 17 = $118 a week"); t.equal(r.pw6.label, "$235", "$4K Vet-FAA: $235 a week — the old TCV ≤ $4K proxy called it '1K Per Yr'");
  t.equal(r.pw7.label, "$118", "a 2-year $2K-a-year deal (TCV $4K)"); t.equal(r.pw8.label, "1K Per Yr", "a 3-year $1K-a-year deal IS the class"); t.equal(r.pw9.label, "$59", "a 5-year $1K deal (TCV $5K) is not");
  for (const [k2, v] of Object.entries({ pw2: 1, pw4: 1, pw6: 1, pw7: 1, pw9: 1 })) t.notEqual(r[k2].label, "1K Per Yr", k2 + " never the class label");
  // before the batch lands: the exact local class checks (a status check for WW — NOT a TCV cutoff); after it lands the WORKER decides
  const pre = mk("pending", null);
  vm.runInContext(`result = { ww3: perWeekEarningInfo({id:'7', type:'Vet-WW', tcv:3000, cl:1, salary:3000, years:1}), ww1: perWeekEarningInfo({id:'7', type:'Vet-WW', tcv:1000, cl:1, salary:1000, years:1}),
    faa: perWeekEarningInfo({id:'7', type:'Vet-FAA', tcv:3000, cl:1, salary:3000, years:1}), mym: perWeekEarningInfo({id:'7', type:'Vet-WW-MYM', tcv:3000, cl:1, salary:3000, years:1}),
    multi: perWeekEarningInfo({id:'7', type:'Vet-WW', tcv:6000, cl:2, salary:3000, years:2}), taxi: perWeekEarningInfo({id:'7', type:'Vet-WW', tcv:3000, cl:1, salary:3000, years:1, isTaxi:true}) };`, pre);
  t.equal(pre.result.ww3.label, "3K Per Yr"); t.equal(pre.result.ww1.label, "1K Per Yr"); t.equal(pre.result.faa.label, "$176", "a non-WW $3K deal: its actual rate");
  t.equal(pre.result.mym.label, "$176", "a WW-MYM is not the class"); t.equal(pre.result.multi.label, "$176", "a multi-year WW is not the class"); t.equal(pre.result.taxi.label, "$176", "taxi is not in the class");
  const loaded = mk("ok", { "7": { penalty: 0, earned: 176, tcv: 3000, basis: "ww_under_5k_exempt" } });
  vm.runInContext(`result = { ww3: perWeekEarningInfo({id:'7', type:'Vet-WW', tcv:3000, cl:1, salary:3000, years:1}) };`, loaded);
  t.equal(loaded.result.ww3.label, "$176", "the worker's row has no rule ⇒ the worker did not put it in the class ⇒ the local check stands down");
  t.match(fo, /drop\.earnedRule === "full_year" \? `<span class="fo-tt" data-tip="\$\{escapeHtml\(drop\.note\)\}">Full-year rule<\/span>`/, "the EARNED cell says so");
  t.match(fo, /drop\.earnedRule === "ww_na" \? `<span class="fo-tt" data-tip="\$\{escapeHtml\(drop\.note\)\}">Not applicable<\/span>`/, "…and 'Not applicable' for the WW class");
  t.match(fo, /isOneKPerYearPlayer\(p\) \? _rbr\.priorEarned : _rbr\.earned/, "the restructure view's 'remaining owed' has no in-season accrual for a $1K-per-year contract");
  t.ok(!/tcv > 0 && tcv <= 4000\) return \{ label: "1K Per Yr"/.test(fo), "the TCV ≤ $4K proxy is gone");
});

test("DISPLAY: the three clients share ONE local class check — exactly $1,000 in every year; a $4K deal, a $2K deal and a 5-year $1K deal are not in it", () => {
  const players = [[{ salary: 1000, cl: 1, tcv: 1000 }, true], [{ salary: 1000, cl: 3, tcv: 3000 }, true], [{ salary: 1000, cl: 4, tcv: 4000 }, true], [{ salary: 1000, cl: 5, tcv: 5000 }, false], [{ salary: 4000, cl: 1, tcv: 4000 }, false], [{ salary: 2000, cl: 1, tcv: 2000 }, false], [{ salary: 1000, cl: 0, tcv: 0 }, false], [{ salary: 1000, cl: 2, tcv: 3000 }, false]];
  for (const file of ["site/rosters/v2/front_office.js", "site/rosters/roster_workbench.js", "site/m/front_office_penalty.js"]) {
    const src2 = read(file); const i = src2.indexOf("function isOneKPerYearPlayer(player) {"); t.ok(i > 0, file + " has the helper");
    const fn = src2.slice(i, src2.indexOf("\n  }\n", i) + 4);
    const ctx = { safeInt: (v, d) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : (d || 0); }, contractLengthForPlayer: (p) => p.cl, totalContractValueForPlayer: (p) => p.tcv, out: null }; vm.createContext(ctx);
    vm.runInContext(fn + "\nout = " + JSON.stringify(players.map((x) => x[0])) + ".map(isOneKPerYearPlayer);", ctx);
    t.deepEqual(Array.from(ctx.out), players.map((x) => x[1]), file);
  }
});

test("DISPLAY: roster workbench + mobile — the authoritative row AND the pre-batch local estimate both say 'Full-year rule'; the modal never shows a weekly earned; mobile build bumped", () => {
  const rw = read("site/rosters/roster_workbench.js"), mob = read("site/m/front_office_penalty.js");
  t.match(rw, /__cap\.earned_rule === "full_year_sub_5k"/); t.match(rw, /earnedRule: "full_year"/); t.match(rw, /var modalEarnedText = penalty\.earnedRule === "full_year" \? "Full-year rule"/);
  t.equal((rw.match(/escapeHtml\(modalEarnedText\)|: modalEarnedText\)/g) || []).length, 2, "both Earned To Date metrics use it");
  t.match(rw, /function dropPenaltyEstimateRaw\(player\)/); t.match(rw, /!r\.earnedRule && isOneKPerYearPlayer\(player\)/, "local estimate: a $1K-per-year contract has no earned either");
  t.match(mob, /__mc\.earned_rule === "full_year_sub_5k"/); t.match(rw, /__cap\.earned_rule === "ww_earned_na"/); t.match(rw, /earnedRule: "ww_na"/); t.match(rw, /penalty\.earnedRule === "ww_na" \? "Not applicable"/); t.match(mob, /__mc\.earned_rule === "ww_earned_na"/); t.match(mob, /earnedRule: "ww_na"/); t.match(mob, /function dropPenaltyEstimateRaw\(player, season\)/); t.match(mob, /!r\.earnedRule && isOneKPerYearPlayer\(player\)/);
  const idx = read("site/m/index.html"), build = JSON.parse(read("site/m/version.json")).build, esc = build.replace(/\./g, "\\.");
  t.match(build, /^\d{4}\.\d{2}\.\d{2}\.\d+$/); t.ok(build > "2026.09.19.1", "the isolated branch bumps the mobile build past main's 2026.09.19.1 (" + build + ")");
  t.equal((idx.match(new RegExp("app\\.js\\?v=" + esc, "g")) || []).length, 1, "index.html app.js?v= == version.json build");
  t.equal((idx.match(new RegExp("front_office_penalty\\.js\\?v=" + esc, "g")) || []).length, 1, "the changed penalty script is cache-busted with the same build");
  t.equal(read("site/m/app.js").match(/var BUILD = "([^"]+)";/)[1], build, "app.js BUILD == version.json build");
  t.match(read("site/rosters/v2/front_office.html"), /front_office\.js\?v=\d{4}\.\d{2}\.\d{2}\.v[\d.]+/);
});

test("DISPLAY (cap_math): the shared helper the profile modal and Team Operations use is the SAME class — exactly $1,000 every year, every AAV tier, a complete schedule", () => {
  const ctx = { out: null }; vm.createContext(ctx); vm.runInContext(read("site/shared/cap_math.js"), ctx);
  const M = ctx.UPS_CAP_MATH; t.equal(typeof M.isOneKPerYear, "function");
  const yes = [["1000", "CL 1| TCV 1K| AAV 1K"], ["1000", "CL 3| TCV 3K| AAV 1K| Y1-1K, Y2-1K, Y3-1K"], ["1000", "CL 4| TCV 4K| AAV 1K"], [1000, "CL 2| TCV 2K| AAV 1K| Y1-1, Y2-1"]];
  const no = [["1000", "CL 5| TCV 5K| AAV 1K"], ["4000", "CL 1| TCV 4K| AAV 4K"], ["2000", "CL 1| TCV 2K| AAV 2K"], ["1000", "CL 2| TCV 2K| AAV 1K, 2K| Y1-1K, Y2-1K"], ["1000", "CL 3| TCV 3K| AAV 1K| Y1-1K, Y2-1K"], ["1000", "CL 2| TCV 2K| AAV 1K| Y1-1K, Y2-2K"], ["1000", "TCV 2K| AAV 1K"], ["1000", ""], ["", "CL 1| TCV 1K| AAV 1K"]];
  for (const [s, i] of yes) t.equal(M.isOneKPerYear({ salary: s, contractInfo: i }), true, `${s} ${i}`);
  for (const [s, i] of no) t.equal(M.isOneKPerYear({ salary: s, contractInfo: i }), false, `${s} ${i}`);
  // …and it agrees with the worker class on every one of those shapes
  for (const [s, i] of [...yes, ...no]) { const k = FC.parseContractTokens(i, Number(s) || 0); t.equal(M.isOneKPerYear({ salary: s, contractInfo: i }), FC.classifyFullYearRule({ salary: Number(s) || 0, tcv: k.tcv, cl: k.cl, aav: k.aav, aavTiers: k.aavTiers, yearSalaries: k.yearSalaries }).member, `worker parity: ${s} ${i}`); }
  // the canon §C3 WW class, LOCAL (the profile modal and Team Operations have no cap-penalty batch): a STATUS check — one-year pure-WW, $4K or less, TCV = salary, final year, not taxi
  t.equal(typeof M.isWwEarnedNa, "function");
  const ww = (o) => ({ salary: "2000", contractStatus: "Vet-WW", contractYear: "1", contractInfo: "CL 1| TCV 2K| AAV 2K", ...o });
  for (const [row, want, why] of [[ww({}), true, "Vet-WW $2K"], [ww({ salary: "4000", contractInfo: "CL 1| TCV 4K| AAV 4K" }), true, "$4K"], [ww({ contractStatus: "Rookie-WW", salary: "3000", contractInfo: "CL 1| TCV 3K| AAV 3K" }), true, "Rookie-WW"], [ww({ contractStatus: "WW" }), true, "bare WW"],
      [ww({ salary: "1000", contractInfo: "CL 1| TCV 1K| AAV 1K" }), false, "$1K is the FULL-YEAR class, not this one"], [ww({ contractStatus: "Vet-WW-MYM" }), false, "WW-MYM"], [ww({ contractStatus: "Vet-FAA" }), false, "non-WW"],
      [ww({ salary: "5000", contractInfo: "CL 1| TCV 5K| AAV 5K" }), false, "$5K"], [ww({ contractInfo: "CL 2| TCV 4K| AAV 2K", contractYear: "1" }), false, "multi-year"], [ww({ contractYear: "2" }), false, "years remaining 2"],
      [ww({ contractYear: "" }), false, "BLANK years remaining is unknown, never 'final year'"], [ww({ contractYear: null }), false, "null years remaining"], [ww({ contractYear: "0" }), false, "expired"], [ww({ isTaxi: true }), false, "taxi"], [ww({ contractInfo: "" }), false, "no contract text"],
      [ww({ contractInfo: "CL 1| TCV 3K| AAV 2K" }), false, "TCV differs from salary"]]) t.equal(M.isWwEarnedNa(row), want, why);
  // …and it AGREES with the worker's classifier on every one of those rows (the worker excludes the $1K deal only in the calculator's basis choice)
  for (const [row] of [[ww({})], [ww({ salary: "4000", contractInfo: "CL 1| TCV 4K| AAV 4K" })], [ww({ contractStatus: "Vet-WW-MYM" })], [ww({ contractYear: "2" })], [ww({ contractInfo: "CL 2| TCV 4K| AAV 2K" })], [ww({ salary: "5000", contractInfo: "CL 1| TCV 5K| AAV 5K" })]]) {
    const k = FC.parseContractTokens(row.contractInfo, Number(row.salary)); const w = FC.classifyWwEarnedNa({ status: row.contractStatus, salary: Number(row.salary), tcv: k.tcv, cl: k.cl, yearsRemaining: Number(row.contractYear), taxi: !!row.isTaxi }).member;
    t.equal(M.isWwEarnedNa(row), w, `worker parity: ${row.contractStatus} ${row.salary} ${row.contractInfo} cy${row.contractYear}`);
  }
  const pp = read("site/shared/player_profile_master.js"), to = read("site/team_operations/team_operations.js");
  t.match(pp, /isWwEarnedNa\(sal, contractInfo\)/); t.match(pp, /wwEarnedNa \? "Not applicable"/); t.match(to, /isWwEarnedNa\(sal\)/); t.match(to, /topsWwNa \? 'Not applicable'/);
  t.match(pp, /isOneKPerYear\(sal, contractInfo\) && !\/\^rookie\(-draft\)\?\$\/i\.test/); t.match(pp, /fullYearRule \? "Full-year rule"/);
  t.match(to, /isOneKPerYear\(sal\) && !\/\^rookie\(-draft\)\?\$\/i\.test/);
  // ONLY draft-slot rookie contracts stay numeric — Rookie-WW (the canonical NFL-rookie FCFS contract), Rookie-FAA and Rookie-MYM are ordinary contracts
  const draftSlot = /^rookie(-draft)?$/i; for (const [st, want] of [["Rookie", true], ["Rookie-Draft", true], ["rookie-draft", true], ["Rookie-WW", false], ["Rookie-FAA", false], ["Rookie-MYM", false], ["Vet-WW", false], ["Vet-FAA", false]]) t.equal(draftSlot.test(st), want, st);
  // the LOCAL drop-penalty fallback (used until the worker's batch loads) prices a WW deal cap-free only in its FINAL year — exactly like the worker
  { const c2 = { out: null }; vm.createContext(c2); vm.runInContext(read("site/shared/cap_math.js"), c2); const D = (o) => c2.UPS_CAP_MATH.dropPenalty({ id: "1", ...o }, { season: 2026 });
    t.equal(D({ salary: "1000", contractStatus: "Vet-WW", contractYear: "2", contractInfo: "CL 3| TCV 3K| AAV 1K| Y1-1K, Y2-1K, Y3-1K" }), 1000, "a multi-year WW with years left is the flat $1,000 (it used to read $0)");
    t.equal(D({ salary: "1000", contractStatus: "Vet-WW", contractYear: "1", contractInfo: "CL 3| TCV 3K| AAV 1K| Y1-1K, Y2-1K, Y3-1K" }), 0, "…and $0 in its final year"); t.equal(D({ salary: "3000", contractStatus: "Vet-WW", contractYear: "1", contractInfo: "CL 1| TCV 3K| AAV 3K" }), 0); } t.match(to, /topsFullYear \? 'Full-year rule'/);
});

test("DISPLAY (wrapper gating): the pre-batch estimate is adjusted ONLY while it is the local estimate — never once the worker's authoritative row is loaded, never for a taxi player", () => {
  for (const [file, sig, call] of [["site/rosters/roster_workbench.js", "function dropPenaltyEstimate(player) {", "dropPenaltyEstimate(p)"], ["site/m/front_office_penalty.js", "function dropPenaltyEstimate(player, season) {", "dropPenaltyEstimate(p, 2026)"]]) {
    const src2 = read(file); const i = src2.indexOf(sig), h = src2.indexOf("function isOneKPerYearPlayer(player) {"); t.ok(i > 0 && h > 0, file);
    const wrap = src2.slice(i, src2.indexOf("\n  }\n", i) + 4), helper = src2.slice(h, src2.indexOf("\n  }\n", h) + 4);
    const ctx = { safeInt: (v, d) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : (d || 0); }, contractLengthForPlayer: (p) => p.cl, totalContractValueForPlayer: (p) => p.tcv, raw: null, out: null };
    ctx.dropPenaltyEstimateRaw = () => ctx.raw; vm.createContext(ctx);
    const run2 = (p, raw) => { ctx.raw = raw; ctx.p = p; vm.runInContext(wrap + "\n" + helper + "\nout = " + call + ";", ctx); return ctx.out; };
    const member = { salary: 1000, cl: 1, tcv: 1000 };
    const local = run2(member, { earned: 118, priorEarned: 0, accrued: 118, authoritative: false }); t.equal(local.earnedRule, "full_year", file + " local estimate → full-year rule"); t.equal(local.earned, 0); t.match(local.note, /Full-year rule/);
    const auth = run2(member, { earned: 118, authoritative: true }); t.equal(auth.earnedRule, undefined, file + " authoritative row is NOT rewritten"); t.equal(auth.earned, 118);
    const taxi = run2({ ...member, isTaxi: true }, { earned: 118, authoritative: false }); t.equal(taxi.earnedRule, undefined, file + " taxi is never in the rule"); t.equal(taxi.earned, 118);
    const notMember = run2({ salary: 4000, cl: 1, tcv: 4000 }, { earned: 471, authoritative: false }); t.equal(notMember.earnedRule, undefined, file + " a $4K deal is untouched"); t.equal(notMember.earned, 471);
    const already = run2(member, { earned: null, earnedRule: "full_year", authoritative: true }); t.equal(already.earnedRule, "full_year");
  }
});

await run("fcfs_contract_display");
