// THE CANONICAL EXTENSION PRICE (worker/src/extension_pricing.js) — the rule, every branch, every boundary, and the comparison that refuses a
// stored offer whose terms differ from it. Pure: no worker, no network.
//   node tests/extension_pricing.test.mjs
//
// Sources the expectations are written from (never from the code under test):
//   • docs/league_context_v1.md §C4 — Schedule 1/2, "Current year stays", the worked examples ($17K → $27K → TCV $44K; $30K 2-yr → $50K → TCV $130K;
//     $25K 2-yr → $45K → TCV $115K), "TCV = sum of remaining year salaries", 75% guarantee;  §C5.1 — the AAV token is preserved verbatim.
//   • REAL production contracts read 2026-09-25 (Kincaid 16213 `Vet-Ext2 … 9K/29K/29K TCV 67K GTD 50.3K`, Tua 14778, London 15751) and the served
//     preview snapshot (`site/trades/extension_previews_2026.json`) — the numbers the league actually carries.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const P = await import("../worker/src/extension_pricing.js");
const { priceExtension, checkExtensionRequest, storedTerms, compareTerms, resolveCurrentAav, parseContractInfo, positionGroup, scheduleFor, lineageWithExtender, SCHEDULE_RAISES, GROUP_SCHEDULE, canonicalizePreviewRows, moneyToDollars } = P;

const price = (o) => priceExtension({ yearsRemaining: 1, ...o });
const ok = (o) => { const r = price(o); t.ok(r.ok, `expected a price: ${JSON.stringify(r)}`); return r.terms; };

test("CANON WORKED EXAMPLES (§C4): the current year stays, the escalator lands on the extension years only, TCV is the forward-looking sum", () => {
  // "1yr remaining at $17K AAV → extend 1yr (Ext1) → AAV for the extension year = $27K. Current year stays at $17K. New TCV = $17K + $27K = $44K."
  const a = ok({ position: "WR", salary: 17000, contractInfo: "CL 1| TCV 17K| AAV 17K| Y1-17K", term: "1YR" });
  t.equal(a.aav_future, 27000); t.equal(a.salary_year1, 17000); t.equal(a.tcv, 44000); t.equal(a.contract_length, 2); t.deepEqual(a.salary_by_year, { 1: 17000, 2: 27000 });
  // "1yr remaining at $30K AAV → extend 2yr Schedule 1 (Ext2) → AAV for both extension years = $50K each. Current year stays $30K. New TCV = $130K."
  const b = ok({ position: "RB", salary: 30000, contractInfo: "CL 1|TCV 30K|AAV 30K|Y1-30K", term: "2YR" });
  t.equal(b.aav_future, 50000); t.equal(b.tcv, 130000); t.equal(b.contract_length, 3); t.deepEqual(b.salary_by_year, { 1: 30000, 2: 50000, 3: 50000 });
  // §T3.3 example: $25K, 2 years, Schedule 1 → $45K for the two extension years ($25K + $20K), TCV = 25 + 45 + 45 = $115K
  const c = ok({ position: "QB", salary: 25000, contractInfo: "CL 1|TCV 25K|AAV 25K|Y1-25K", term: "2YR" });
  t.equal(c.aav_future, 45000); t.equal(c.tcv, 115000);
  // 75% guarantee applies to the NEW TCV
  t.equal(a.gtd, 33000); t.equal(b.gtd, 97500); t.equal(c.gtd, 86250);
  t.equal(a.status, "Vet-Ext1"); t.equal(b.status, "Vet-Ext2");
  t.equal(a.contract_year, 2, "MFL's contractYear is YEARS REMAINING: a 2-year contract starts at 2"); t.equal(b.contract_year, 3);
});

test("SCHEDULES: every position group and both terms — Schedule 1 (QB RB WR TE) +10K/+20K; Schedule 2 (DL LB DB PK PN) +3K/+5K; the raise is added to the AAV, never the salary", () => {
  const cases = [["QB", 1], ["RB", 1], ["WR", 1], ["TE", 1], ["DL", 2], ["DE", 2], ["DT", 2], ["NT", 2], ["EDGE", 2], ["LB", 2], ["DB", 2], ["CB", 2], ["S", 2], ["FS", 2], ["SS", 2], ["PK", 2], ["K", 2], ["PN", 2], ["P", 2]];
  for (const [pos, sched] of cases) {
    const want = sched === 1 ? { 1: 10000, 2: 20000 } : { 1: 3000, 2: 5000 };
    for (const yrs of [1, 2]) {
      const r = ok({ position: pos, salary: 8000, contractInfo: "CL 1|TCV 8K|AAV 12K|Y1-8K", term: `${yrs}YR` });
      t.equal(r.schedule, sched, `${pos} is Schedule ${sched}`); t.equal(r.escalator, want[yrs], `${pos} ${yrs}YR raise`);
      t.equal(r.aav_future, 12000 + want[yrs], `${pos} ${yrs}YR: future AAV = AAV(12K) + raise — NOT salary(8K) + raise`);
      t.equal(r.tcv, 8000 + (12000 + want[yrs]) * yrs, `${pos} ${yrs}YR TCV`);
    }
  }
  for (const bad of ["", "DEF", "TM", "OL", "??", "Def", "COACH"]) t.equal(price({ position: bad, salary: 5000, contractInfo: "CL 1|TCV 5K|AAV 5K", term: "1YR" }).reason, "pricing_position_unavailable", `"${bad}" has no schedule — never assumed`);
});

test("CANON TABLE: the constants equal what canon says (§C4 / §T3.3) and what the browser's copy carries", () => {
  const canon = fs.readFileSync(path.join(ROOT, "docs", "league_context_v1.md"), "utf8");
  const s1 = canon.match(/Schedule 1 \(QB \/ RB \/ WR \/ TE\):\*\*\s*\+\$(\d+)K \(1yr\) \/ \+\$(\d+)K \(2yr\)/);
  const s2 = canon.match(/Schedule 2 \(DL \/ LB \/ DB \/ K \/ P\):\*\*\s*\+\$(\d+)K \(1yr\) \/ \+\$(\d+)K \(2yr\)/);
  t.ok(s1 && s2, "canon states both schedules");
  t.deepEqual({ ...SCHEDULE_RAISES[1] }, { 1: Number(s1[1]) * 1000, 2: Number(s1[2]) * 1000 }); t.deepEqual({ ...SCHEDULE_RAISES[2] }, { 1: Number(s2[1]) * 1000, 2: Number(s2[2]) * 1000 });
  t.deepEqual({ ...GROUP_SCHEDULE }, { QB: 1, RB: 1, WR: 1, TE: 1, DL: 2, LB: 2, DB: 2, PK: 2, PN: 2 });
  const ctx = { window: {} }; vm.createContext(ctx); vm.runInContext(fs.readFileSync(path.join(ROOT, "site/shared/pretrade_extension.js"), "utf8"), ctx);
  const client = ctx.window.UPS_PRETRADE_EXT.PRETRADE_EXTENSION_RAISES;
  for (const [g, sched] of Object.entries(GROUP_SCHEDULE)) t.deepEqual({ 1: client[g][1], 2: client[g][2] }, { ...SCHEDULE_RAISES[sched] }, `the browser's ${g} row equals the worker's`);
  t.equal(positionGroup("edge"), "DL"); t.equal(scheduleFor("wr").schedule, 1); t.equal(scheduleFor("Def"), null);
});

test("TIER BOUNDARIES: rounding to the nearest $1K (halves up), the $1K floor, and the guarantee's two branches", () => {
  const f = (aavToken, term = "1YR", pos = "WR") => ok({ position: pos, salary: 5000, contractInfo: `CL 1|TCV 5K|AAV ${aavToken}|Y1-5K`, term });
  t.equal(f("9.4K").aav_current, 9000, "9.4K rounds down"); t.equal(f("9.5K").aav_current, 10000, "9.5K rounds UP (the half)"); t.equal(f("9.499K").aav_current, 9000);
  t.equal(f("9.4K").aav_future, 19000); t.equal(f("9.5K").aav_future, 20000, "the extension price follows the rounded AAV");
  t.equal(f("12.5K").aav_current, 13000); t.equal(f("12.49K").aav_current, 12000);
  // a $0.4K AAV rounds to $0 → the future AAV is the raise alone (Schedule 2 1yr = $3K), and that is the tier where the small-TCV guarantee applies
  const tiny = ok({ position: "DL", salary: 1000, contractInfo: "CL 1|TCV 1K|AAV 0.4K|Y1-1K", term: "1YR" });
  t.equal(tiny.aav_current, 0); t.equal(tiny.aav_future, 3000); t.equal(tiny.tcv, 4000); t.equal(tiny.gtd, 3000, "TCV ≤ $4K: guarantee = TCV − the current year (the exporter's rule), not 75%");
  const big = ok({ position: "DL", salary: 1000, contractInfo: "CL 1|TCV 1K|AAV 1K|Y1-1K", term: "1YR" });
  t.equal(big.tcv, 5000); t.equal(big.gtd, 3750, "TCV > $4K: 75% of the new TCV");
  // the price is never below $1K
  t.equal(ok({ position: "PK", salary: 1000, contractInfo: "CL 1|TCV 1K|AAV 1K|Y1-1K", term: "1YR" }).aav_future, 4000);
  t.equal(ok({ position: "WR", salary: 800, contractInfo: "CL 1|TCV 1K|AAV 1K", term: "1YR" }).salary_year1, 1000, "a sub-$1K salary reads as the $1K floor");
  // salary rounding for year 1
  t.equal(ok({ position: "WR", salary: 4499, contractInfo: "CL 1|TCV 4K|AAV 4K", term: "1YR" }).salary_year1, 4000); t.equal(ok({ position: "WR", salary: 4500, contractInfo: "CL 1|TCV 4K|AAV 4K", term: "1YR" }).salary_year1, 5000);
});

test("EXTENSION LENGTHS: 1 year → CL 2, 2 years → CL 3; the term accepts every spelling the builders emit; nothing else", () => {
  for (const [term, yrs] of [["1YR", 1], ["1", 1], ["EXT1", 1], ["Vet-Ext1", 1], ["2YR", 2], ["2", 2], ["EXT2", 2], ["Vet-Ext2", 2], ["2YR|NONE", 2]]) {
    const r = ok({ position: "WR", salary: 10000, contractInfo: "CL 1|TCV 10K|AAV 10K", term }); t.equal(r.extension_years, yrs, term); t.equal(r.contract_length, yrs + 1); t.equal(Object.keys(r.salary_by_year).length, yrs + 1);
  }
  for (const bad of ["3YR", "0YR", "", "abc", "EXT3"]) t.equal(price({ position: "WR", salary: 10000, contractInfo: "CL 1|TCV 10K|AAV 10K", term: bad }).reason, "bad_term", `"${bad}" is not an extension length`);
});

test("LOADED / FRONT-LOADED CONTRACTS: the escalator's base is the AAV TOKEN (its current tier) and year 1 is the live salary — never the salary, never TCV ÷ CL", () => {
  // Tua (14778): front-loaded, Y1-86 Y2-15 Y3-15 (only the last year left: salary $15K), AAV token 49K. Production's served preview: Y1-15K … AAV 49K, 59K.
  const tua = ok({ position: "QB", salary: 15000, contractInfo: "CL 3| TCV 116K| AAV 49K| Y1-86 Y2-15 Y3-15| GTD: 87K| Ext: C-Town", term: "1YR", extLineage: "C-Town" });
  t.equal(tua.aav_current, 49000, "the token, not the $15K salary and not TCV ÷ CL = $39K"); t.equal(tua.aav_future, 59000); t.equal(tua.salary_year1, 15000); t.equal(tua.tcv, 74000);
  t.equal(tua.contract_info, "CL 2|TCV 74K|AAV 49K, 59K|Y1-15K, Y2-59K|Ext: C-Town|GTD: 55.5K", "byte-for-byte the row the league's preview snapshot serves for Tua");
  const tua2 = ok({ position: "QB", salary: 15000, contractInfo: "CL 3| TCV 116K| AAV 49K| Y1-86 Y2-15 Y3-15| GTD: 87K| Ext: C-Town", term: "2YR", extLineage: "C-Town" });
  t.equal(tua2.contract_info, "CL 3|TCV 153K|AAV 49K, 69K|Y1-15K, Y2-69K, Y3-69K|Ext: C-Town|GTD: 114.8K", "and the 2-year row");
  // a BACK-loaded contract: current salary above the AAV (Hurts-like: salary 67K, AAV 42K)
  const back = ok({ position: "QB", salary: 67000, contractInfo: "CL 2|TCV 119K|AAV 42K, 52K|Y1-67K, Y2-52K", term: "1YR" });
  t.equal(back.aav_current, 42000); t.equal(back.aav_future, 52000); t.equal(back.salary_year1, 67000);
  // a dual-AAV token: the FIRST tier is the current one
  const dual = ok({ position: "WR", salary: 33000, contractInfo: "CL 2| TCV 95K| AAV 33K, 43K| Y1-33K, Y2-62K", term: "1YR" });
  t.equal(dual.aav_current, 33000); t.equal(dual.aav_future, 43000); t.equal(dual.tcv, 76000, "London: the preview snapshot serves TCV 76K / AAV 33K, 43K");
  t.equal(dual.aav_source, "token");
  // no token → TCV ÷ CL; no token and no TCV/CL → refused (never the salary)
  t.equal(ok({ position: "WR", salary: 20000, contractInfo: "CL 2|TCV 30K|Y1-10K, Y2-20K", term: "1YR" }).aav_current, 15000);
  t.equal(ok({ position: "WR", salary: 20000, contractInfo: "CL 2|TCV 30K|Y1-10K, Y2-20K", term: "1YR" }).aav_source, "tcv_over_cl");
  t.equal(price({ position: "WR", salary: 20000, contractInfo: "Y1-20K", term: "1YR" }).reason, "pricing_aav_unavailable");
});

test("REAL CONTRACT: Brock Bowers (TE, Rookie-Draft, $9K, 3-yr) priced for 2 years is EXACTLY the Vet-Ext2 record Dalton Kincaid carries in MFL", () => {
  const r = ok({ position: "TE", salary: 9000, contractInfo: "CL 3| TCV 27K| AAV 9K| Y1-9K, Y2-9K, Y3-9K| GTD: 20.3K", term: "2YR" });
  t.equal(r.contract_info, "CL 3|TCV 67K|AAV 9K, 29K|Y1-9K, Y2-29K, Y3-29K|GTD: 50.3K");
  const kincaid = parseContractInfo("CL 3| TCV 67K| AAV 29K| Y1-9K, Y2-29K, Y3-29K| GTD: 50.3K| Ext: PG");   // live MFL 16213 (`Vet-Ext2`, cy 2 — the leading AAV tier already rolled off)
  t.equal(r.tcv, kincaid.tcv); t.deepEqual(r.salary_by_year, { 1: kincaid.years["1"], 2: kincaid.years["2"], 3: kincaid.years["3"] }); t.equal(r.gtd, 50250); t.equal(kincaid.gtd, 50300, "(MFL rounds the display to 50.3K)");
  t.equal(r.status, "Vet-Ext2", "plain Ext2 — the current year is not compared for FL/BL");
});

test("ROLL-FORWARD REPAIR: MFL clobbers the AAV token when a contract rolls; the AAV is last season's LAST tier — but only for the SAME contract", () => {
  const prior = { years: 2, info: "CL 3| TCV 52K| AAV 4K, 24K| Y1-14K, Y2-14K, Y3-24K" };
  // Mason: the raw token now says 14K (the Y1 salary); the repair restores the extension-year AAV, 24K
  const r = ok({ position: "RB", salary: 14000, contractInfo: "CL 3| TCV 52K| AAV 14K| Y1-14K, Y2-14K, Y3-24K", prior, term: "1YR" });
  t.equal(r.aav_current, 24000); t.equal(r.aav_source, "prior_last_tier"); t.equal(r.aav_future, 34000);
  t.equal(resolveCurrentAav({ contractInfo: "CL 3| TCV 52K| AAV 14K", yearsRemaining: 1, prior: { years: 3, info: prior.info } }).source, "token", "prior must have exactly one more year remaining");
  t.equal(resolveCurrentAav({ contractInfo: "CL 3| TCV 99K| AAV 14K", yearsRemaining: 1, prior }).source, "token", "a DIFFERENT contract (TCV differs) is never spliced onto");
  t.equal(resolveCurrentAav({ contractInfo: "CL 2| TCV 52K| AAV 14K", yearsRemaining: 1, prior }).source, "token", "CL differs → a different contract");
  t.equal(resolveCurrentAav({ contractInfo: "CL 3| TCV 52K| AAV 14K", yearsRemaining: 1, prior: null }).source, "token");
  t.equal(resolveCurrentAav({ contractInfo: "CL 3| TCV 52K| AAV 14K", yearsRemaining: 1, prior: { years: 2, info: "CL 3| TCV 52K| Y1-14K" } }).source, "token", "a prior row with no AAV tiers repairs nothing");
});

test("MISSING PRICING AUTHORITY: every input the price needs, refused with its own reason — never a default", () => {
  const base = { position: "WR", salary: 5000, contractInfo: "CL 1|TCV 5K|AAV 5K", term: "1YR" };
  t.equal(price({ ...base, position: "" }).reason, "pricing_position_unavailable");
  t.equal(price({ ...base, salary: "" }).reason, "pricing_salary_unreadable"); t.equal(price({ ...base, salary: 0 }).reason, "pricing_salary_unreadable"); t.equal(price({ ...base, salary: null }).reason, "pricing_salary_unreadable");
  t.equal(price({ ...base, contractInfo: "" }).reason, "pricing_aav_unavailable");
  t.equal(priceExtension({ ...base, yearsRemaining: "" }).reason, "pricing_contract_unreadable"); t.equal(priceExtension({ ...base, yearsRemaining: undefined }).reason, "pricing_contract_unreadable");
  t.equal(priceExtension({ ...base, yearsRemaining: 0 }).reason, "expired_contract_not_priced"); t.equal(priceExtension({ ...base, yearsRemaining: 2 }).reason, "not_final_year");
  t.equal(price({ ...base, loaded: "FL" }).reason, "loaded_extension_unsupported"); t.equal(price({ ...base, loaded: "BL" }).reason, "loaded_extension_unsupported");
  t.equal(price({ ...base, loaded: "NONE" }).ok, true);
  for (const r of [price({ ...base, position: "" }), price({ ...base, contractInfo: "" })]) t.equal(r.terms, undefined, "a refusal carries no terms to fall back on");
});

// ── stored vs canonical ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const LIVE = { position: "TE", yearsRemaining: 1, salary: 9000, contractInfo: "CL 3| TCV 27K| AAV 9K| Y1-9K, Y2-9K, Y3-9K| GTD: 20.3K" };
const STORED = () => ({ player_id: "16641", extension_term: "2YR", option_key: "2YR|NONE", loaded_indicator: "NONE", new_contract_status: "EXT2", new_contract_length: 3, new_TCV: 67000, new_aav_future: 29000, preview_contract_info_string: "CL 3| TCV 67K| AAV 9K, 29K| Y1-9K, Y2-29K, Y3-29K" });
const stale = (mut, live) => { const r = STORED(); mut(r); return checkExtensionRequest(r, live || LIVE); };
const fields = (res) => (res.diffs || []).map((d) => d.field);

test("STORED == CANONICAL: the stored terms of a correctly priced offer match exactly, in both separator styles, with or without the optional tokens", () => {
  const good = checkExtensionRequest(STORED(), LIVE); t.equal(good.ok, true); t.equal(good.terms.contract_info, "CL 3|TCV 67K|AAV 9K, 29K|Y1-9K, Y2-29K, Y3-29K|GTD: 50.3K");
  const compact = STORED(); compact.preview_contract_info_string = "CL 3|TCV 67K|AAV 9K, 29K|Y1-9K, Y2-29K, Y3-29K|Ext: CTwn|GTD: 50.3K"; t.equal(checkExtensionRequest(compact, LIVE).ok, true, "the snapshot's own format (Ext + GTD tokens) matches too");
  const noStatus = STORED(); delete noStatus.new_contract_status; delete noStatus.option_key; t.equal(checkExtensionRequest(noStatus, LIVE).ok, true, "fields the builder omitted are read from the string");
  t.equal(compareTerms(storedTerms(STORED()), good.terms).match, true);
});

test("STORED DIFFERS: year-one salary, escalator (extension-year AAV), current AAV, TCV, term, length, any single year, loaded, status↔term — each is a stale price naming the field", () => {
  let r = stale((x) => { x.preview_contract_info_string = "CL 3| TCV 69K| AAV 9K, 29K| Y1-11K, Y2-29K, Y3-29K"; x.new_TCV = 69000; });
  t.equal(r.reason, "extension_terms_stale"); t.deepEqual(fields(r).filter((f) => ["salary_year1", "salary_year_1", "tcv"].includes(f)).sort(), ["salary_year1", "salary_year_1", "tcv"], "year-one salary (and the TCV that follows)");
  r = stale((x) => { x.preview_contract_info_string = "CL 3| TCV 47K| AAV 9K, 19K| Y1-9K, Y2-19K, Y3-19K"; x.new_TCV = 47000; x.new_aav_future = 19000; });
  t.ok(fields(r).includes("aav_future"), "the escalator: +$10K instead of +$20K"); t.equal(r.canonical.escalator, 20000);
  r = stale((x) => { x.preview_contract_info_string = "CL 3| TCV 67K| AAV 12K, 29K| Y1-9K, Y2-29K, Y3-29K"; }); t.deepEqual(fields(r), ["aav_current"], "the current AAV label alone");
  r = stale((x) => { x.new_aav_future = 30000; }); t.ok(fields(r).includes("aav_future") && fields(r).includes("stored_inconsistent_aav_future"), "an AAV that disagrees with the string AND with the canon");
  r = stale((x) => { x.new_TCV = 66000; }); t.ok(fields(r).includes("tcv"));
  r = stale((x) => { x.extension_term = "1YR"; x.option_key = "1YR|NONE"; x.new_contract_status = "EXT1"; }); t.ok(fields(r).includes("contract_length") && fields(r).includes("tcv"), "a 1-year term on 2-year terms: priced for the term it claims, and everything else disagrees");
  r = stale((x) => { x.extension_term = "1YR"; }); t.deepEqual(fields(r), ["term"], "the request says 1 year and 2 years at once");
  r = stale((x) => { x.new_contract_length = 2; }); t.ok(fields(r).includes("contract_length"));
  r = stale((x) => { x.preview_contract_info_string = "CL 3| TCV 67K| AAV 9K, 29K| Y1-9K, Y2-28K, Y3-30K"; }); t.deepEqual(fields(r), ["salary_year_2", "salary_year_3"], "a single year's salary");
  r = stale((x) => { x.loaded_indicator = "FL"; x.option_key = "2YR|FL"; }); t.equal(r.reason, "loaded_extension_unsupported");
  r = stale((x) => { x.new_contract_status = "EXT1"; }); t.deepEqual(fields(r), ["term"], "the status must agree with the term (EXT1 status on a 2YR request)");
  r = stale((x) => { delete x.preview_contract_info_string; delete x.new_TCV; delete x.new_aav_future; delete x.new_contract_length; }); t.equal(r.reason, "extension_terms_stale", "a request that states no terms is not a price");
  r = stale((x) => { x.preview_contract_info_string = "CL 3; TCV 15000; AAV 5000"; }); t.equal(r.reason, "extension_terms_stale", "garbled terms");
  for (const key of ["diffs", "canonical", "stored"]) t.ok(r[key], `a refusal carries ${key} so the sender can regenerate`);
});

test("THE CONTRACT MOVED ON: a changed salary, a changed AAV, a changed length or a rolled year makes the same stored offer stale", () => {
  t.equal(checkExtensionRequest(STORED(), { ...LIVE, salary: 12000, contractInfo: "CL 3| TCV 30K| AAV 9K| Y1-12K, Y2-9K, Y3-9K" }).reason, "extension_terms_stale", "salary changed");
  t.equal(checkExtensionRequest(STORED(), { ...LIVE, contractInfo: "CL 3| TCV 27K| AAV 11K| Y1-9K, Y2-9K, Y3-9K" }).reason, "extension_terms_stale", "AAV changed");
  t.equal(checkExtensionRequest(STORED(), { ...LIVE, position: "LB" }).reason, "extension_terms_stale", "his position (schedule) changed: LB is Schedule 2");
  t.equal(checkExtensionRequest(STORED(), { ...LIVE, yearsRemaining: 2 }).reason, "not_final_year", "he is no longer in his final year");
  t.equal(checkExtensionRequest(STORED(), { ...LIVE, yearsRemaining: "" }).reason, "pricing_contract_unreadable");
  // a TE priced as Schedule 2 (someone mislabeled his position) is stale, not accepted
  const wrongSchedule = STORED(); wrongSchedule.new_aav_future = 12000; wrongSchedule.new_TCV = 33000; wrongSchedule.preview_contract_info_string = "CL 3| TCV 33K| AAV 9K, 12K| Y1-9K, Y2-12K, Y3-12K";
  t.ok(fields(checkExtensionRequest(wrongSchedule, LIVE)).includes("aav_future"));
});

test("PREVIEW FEED: every row is priced from the holder's current contract; a row that can't be priced is not offered; prior-season data unreadable ⇒ nothing is offered", () => {
  const assets = { "0009": [{ type: "PLAYER", player_id: "16641", position: "TE", salary: 9000, years: 1, contract_info: LIVE.contractInfo }, { type: "PLAYER", player_id: "99", position: "WR", salary: 0, years: 1, contract_info: "CL 1|TCV 5K|AAV 5K", salary_blank: true }] };
  const rows = [
    { player_id: "16641", franchise_id: "0009", extension_term: "1YR", loaded_indicator: "NONE", new_TCV: 1, preview_contract_info_string: "stale snapshot text" },
    { player_id: "16641", franchise_id: "0009", extension_term: "2YR", loaded_indicator: "NONE", new_TCV: 1 },
    { player_id: "16641", franchise_id: "0009", extension_term: "2YR", loaded_indicator: "FL" },
    { player_id: "99", franchise_id: "0009", extension_term: "1YR", loaded_indicator: "NONE" },
    { player_id: "77", franchise_id: "0009", extension_term: "1YR", loaded_indicator: "NONE" },
  ];
  const out = canonicalizePreviewRows({ rows, assetsByFranchise: assets, abbrevByFid: { "0009": "CTwn" }, prior: {} });
  t.equal(out.rows.length, 2); t.equal(out.dropped, 3, "the loaded row, the blank-salary player and the unknown player are not offered");
  t.deepEqual(out.rows.map((r) => [r.extension_term, r.new_TCV, r.new_aav_future]), [["1YR", 28000, 19000], ["2YR", 67000, 29000]]);
  t.equal(out.rows[1].preview_contract_info_string, "CL 3|TCV 67K|AAV 9K, 29K|Y1-9K, Y2-29K, Y3-29K|Ext: CTwn|GTD: 50.3K", "the exact row the league's snapshot serves for Bowers");
  t.equal(canonicalizePreviewRows({ rows, assetsByFranchise: assets, abbrevByFid: {}, prior: null }).rows.length, 0, "authority unreadable ⇒ no options");
  t.equal(lineageWithExtender("PG, Sex", "Sex"), "PG, Sex"); t.equal(lineageWithExtender("PG", "CTwn"), "PG, CTwn"); t.equal(lineageWithExtender("", "🔨 HammerTime"), "HammerTime"); t.equal(lineageWithExtender("PG", "🔨"), "PG");
  t.equal(moneyToDollars("1.5K"), 1500); t.equal(moneyToDollars("86"), 86000); t.equal(moneyToDollars("9000"), 9000); t.equal(moneyToDollars("x"), null);
});

await run("extension_pricing");
