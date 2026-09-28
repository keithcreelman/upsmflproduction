// site/shared/contract_windows.js — the §B3/§C5/§C4 client authority.
//   node tests/contract_windows_shared.test.mjs
//
// Loaded the same way tests/gameday_player_status.test.mjs loads a browser
// IIFE (new Function("window", SRC)), so this runs the ACTUAL shipped code,
// not a hand-copied mirror of it.
//
// Covers the 2026-09-28 correctness pass:
//   - §B3 IR: the exact vocabulary the worker's deactivate_ir gate matches
//     against, plus the Real Deal Creel 4-flagged/0-eligible regression.
//   - §C5 restructure window: boundary seconds + parity against the worker's
//     OWN checkRestructureWindow (worker/src/restructure_cap.js) for the
//     same deadline/now.
//   - §C4 extension: Dallas Goedert's exact regression fixture (traded
//     2025-11-27, final year of a Veteran deal, Sept 2026 deadline passed)
//     plus boundary seconds for the veteran/rookie/WW/trade branches.
import fs from "fs";
import assert from "assert";
import { checkRestructureWindow } from "../worker/src/restructure_cap.js";

const SRC = fs.readFileSync("site/shared/contract_windows.js", "utf8");
const sandbox = {};
new Function("window", SRC)(sandbox);
const CW = sandbox.UPS_CONTRACT_WINDOWS;
assert.ok(CW, "window.UPS_CONTRACT_WINDOWS must be defined");

let fails = 0;
// async so the worker-parity block's `await checkRestructureWindow(...)` is
// actually awaited before the try/catch decides pass/fail — a plain sync
// check() here would print "ok" before the async assertion ever ran.
const check = async (n, fn) => { try { await fn(); console.log("  ok   " + n); }
  catch (e) { fails++; console.log("  FAIL " + n + "\n         " + e.message); } };

// ───────────────────────── §B3 IR designation eligibility ─────────────────────────
console.log("§B3 IR designation vocabulary");
const IR_ELIGIBLE = ["IR", "IR-PUP", "IR-NFI", "IR-R", "Suspended", "Holdout", "COVID-19", "Reserve/COVID-19"];
const IR_INELIGIBLE = ["Out", "Doubtful", "Questionable", "Retired", "", null, undefined, "Injured", "Reserve"];
for (const d of IR_ELIGIBLE) {
  await check(`"${d}" is IR-eligible`, () => assert.strictEqual(CW.irDesignationEligible(d), true));
}
for (const d of IR_INELIGIBLE) {
  await check(`"${d}" is NOT IR-eligible`, () => assert.strictEqual(CW.irDesignationEligible(d), false));
}
await check('a broad "reserve" substring alone does not qualify (the overcounting bug)', () => {
  assert.strictEqual(CW.irDesignationEligible("Reserve"), false);
  assert.strictEqual(CW.irDesignationEligible("Physically Unable to Perform Reserve"), false);
});
await check('"RETIRED" does not survive the IR prefix test (canon D2 handles it, not §B3)', () => {
  assert.strictEqual(CW.irDesignationEligible("RETIRED"), false);
});

console.log("\nReal Deal Creel regression (live production data, 2026-09-28)");
// Exactly the 4 active-roster players the buggy front_office.js:3761 predicate
// flagged (all genuinely "Out", none IR-caliber) plus the 2 players already
// correctly on IR. The corrected predicate must find 0 of the 4 eligible and
// both of the 2 still eligible (they remain IR-eligible; being ALREADY on IR
// doesn't change their designation).
const RDC_FLAGGED_OUT = ["Goedert, Dallas", "Nacua, Puka", "Okonkwo, Chigoziem", "Strand, Jack"];
for (const name of RDC_FLAGGED_OUT) {
  await check(`${name} (designation "Out") is correctly EXCLUDED`, () => {
    assert.strictEqual(CW.irDesignationEligible("Out"), false);
  });
}
await check("Pearce, James (designation \"Suspended\", already on IR) is eligible", () => {
  assert.strictEqual(CW.irDesignationEligible("Suspended"), true);
});
await check("Benson, Trey (designation \"IR\", already on IR) is eligible", () => {
  assert.strictEqual(CW.irDesignationEligible("IR"), true);
});

// ───────────────────────── §C5 restructure window ─────────────────────────
console.log("\n§C5 restructure window — boundary seconds + worker parity");
const DEADLINE_YMD = "2026-09-06";
const DEADLINE_MS = CW.contractDeadlineUnixMs(DEADLINE_YMD);
await check("deadline instant matches the worker's own parser (2026-09-06T23:59:59-04:00)", () => {
  assert.strictEqual(DEADLINE_MS, Date.parse("2026-09-06T23:59:59-04:00"));
});
await check("1 second before the deadline: open", () => {
  assert.strictEqual(CW.restructureWindowOpen(DEADLINE_MS - 1000, DEADLINE_YMD).open, true);
});
await check("exactly at the deadline: open", () => {
  assert.strictEqual(CW.restructureWindowOpen(DEADLINE_MS, DEADLINE_YMD).open, true);
});
await check("1 second after the deadline: CLOSED", () => {
  const r = CW.restructureWindowOpen(DEADLINE_MS + 1000, DEADLINE_YMD);
  assert.strictEqual(r.open, false);
  assert.strictEqual(r.reason, "window_closed");
  assert.match(r.detail, /September contract deadline/);
});
await check("missing deadline authority: FAILS CLOSED, never open", () => {
  for (const bad of [null, undefined, "", "not-a-date", "2026-13-99"]) {
    const r = CW.restructureWindowOpen(Date.now(), bad);
    assert.strictEqual(r.open, false, `deadline=${JSON.stringify(bad)} must not read as open`);
    assert.strictEqual(r.reason, "window_unreadable");
  }
});
await check("today (2026-09-28) with the real 2026 deadline: CLOSED — matches the worker's live rejection", () => {
  const today = Date.parse("2026-09-28T12:00:00-04:00");
  assert.strictEqual(CW.restructureWindowOpen(today, DEADLINE_YMD).open, false);
});

console.log("\nparity: shared client check agrees with worker/src/restructure_cap.js checkRestructureWindow");
{
  const env = { UPS_MFL_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ date: DEADLINE_YMD }) }) }) } };
  for (const [label, nowMs] of [
    ["1s before", DEADLINE_MS - 1000],
    ["exactly at", DEADLINE_MS],
    ["1s after", DEADLINE_MS + 1000],
    ["today (2026-09-28)", Date.parse("2026-09-28T12:00:00-04:00")],
  ]) {
    await check(`${label}: client.open === worker.open`, async () => {
      const clientResult = CW.restructureWindowOpen(nowMs, DEADLINE_YMD);
      const workerResult = await checkRestructureWindow(env, { season: "2026", nowUnix: Math.floor(nowMs / 1000) });
      assert.strictEqual(clientResult.open, workerResult.open,
        `client said open=${clientResult.open}, worker said open=${workerResult.open}`);
    });
  }
}

// ───────────────────────── §C4 extension window ─────────────────────────
console.log("\n§C4 extension — Dallas Goedert exact regression fixture");
// Live production data traced 2026-09-28: current contract is a 2yr Veteran
// (season=2026, years remaining=1 i.e. final year), contractStatus "Vet-FAA"
// (auction-signed by a DIFFERENT team in 2025 — NOT by Real Deal Creel), most
// recent acquisition by his CURRENT team (Real Deal Creel) was a TRADE dated
// 2025-11-27 — last season, not this one. No extension/restructure/tag
// history. Standard veteran deadline (Sept 2026 = 2026-09-06) applies and has
// passed by the time this ran (2026-09-28).
const GOEDERT = {
  years: 1,
  type: "Vet-FAA",
  special: "CL 2| TCV 14K| AAV 7K| Y1-7K, Y2-7K| GTD: 10.5K",
  acquisitionTypeLabel: "Trade",
  acquisitionDate: "2025-11-27"
};
const isRookieLikeStatus = (s) => /rookie/.test(s);
const GOEDERT_CTX = {
  season: 2026,
  contractDeadlineYmd: DEADLINE_YMD,
  isRookieLikeStatus,
  tagDeadlineDate: () => null,
  nowMs: Date.parse("2026-09-28T12:00:00-04:00")
};
await check("Goedert: NOT extension-eligible (deadline passed)", () => {
  const r = CW.standardExtensionWindow(GOEDERT, GOEDERT_CTX);
  assert.strictEqual(r.in_window, false, "must not be eligible — this is the reported regression");
  assert.strictEqual(r.resolved, true, "the deadline WAS resolvable — this is deadline_passed, not unknown");
  assert.match(r.basis, /Veteran/, "must classify as the standard veteran branch, not a trade/WW window");
});
await check("Goedert's 2025 trade is NOT treated as an in-season trade-acquisition this season", () => {
  // acquisitionDate year (2025) !== season (2026) -> isTradeAcq must be false,
  // so he falls through to the veteran branch above, not a 4-week trade window.
  const r = CW.standardExtensionWindow(GOEDERT, GOEDERT_CTX);
  assert.doesNotMatch(r.basis, /Trade-acquired/);
});

console.log("\n§C4 extension — veteran-branch boundary seconds (21:00 ET, the worker's getContractDeadlineUtc default)");
const EXT_DEADLINE_MS = CW.extensionVeteranDeadlineUnixMs(DEADLINE_YMD);
await check("extension deadline instant is 21:00 ET, distinct from restructure's 23:59:59 ET", () => {
  assert.strictEqual(EXT_DEADLINE_MS, Date.parse("2026-09-06T21:00:00-04:00"));
  assert.notStrictEqual(EXT_DEADLINE_MS, DEADLINE_MS, "extension and restructure cutoffs are DIFFERENT worker gates — must not collapse to one");
});
for (const [label, offsetMs, expected] of [
  ["1s before", -1000, true],
  ["exactly at", 0, true],
  ["1s after", 1000, false],
]) {
  await check(`veteran branch, ${label} the 21:00 deadline: in_window=${expected}`, () => {
    const ctx = { ...GOEDERT_CTX, nowMs: EXT_DEADLINE_MS + offsetMs };
    assert.strictEqual(CW.standardExtensionWindow(GOEDERT, ctx).in_window, expected);
  });
}
await check("missing deadline authority: FAILS CLOSED (resolved=false, in_window=false)", () => {
  const r = CW.standardExtensionWindow(GOEDERT, { ...GOEDERT_CTX, contractDeadlineYmd: null });
  assert.strictEqual(r.resolved, false);
  assert.strictEqual(r.in_window, false);
});
await check("a caller-precomputed contractDeadlineDate takes priority over contractDeadlineYmd", () => {
  const earlierDate = new Date(EXT_DEADLINE_MS - 5000);
  const r = CW.standardExtensionWindow(GOEDERT, {
    ...GOEDERT_CTX, contractDeadlineDate: earlierDate, nowMs: EXT_DEADLINE_MS - 1000
  });
  // now is 1s before the YMD-derived deadline but 4s AFTER the supplied Date -> closed
  assert.strictEqual(r.in_window, false);
});

console.log("\n§C4 extension — in-season WW/FCFS pickup (days 15-28)");
const WW_PLAYER = { years: 1, type: "Vet-WW", special: "", acquisitionTypeLabel: "Waiver", acquisitionDate: "2026-09-15" };
const wwAcqMs = Date.parse("2026-09-15T12:00:00-04:00");
for (const [label, dayOffset, expected] of [
  ["day 14 (still MYM, not extension yet)", 14, false],
  ["day 15 (extension opens)", 15, true],
  ["day 28 (last eligible day)", 28, true],
  ["day 29 (window shut)", 29, false],
]) {
  await check(`WW pickup, ${label}: in_window=${expected}`, () => {
    const ctx = { season: 2026, contractDeadlineYmd: DEADLINE_YMD, isRookieLikeStatus, tagDeadlineDate: () => null,
      nowMs: wwAcqMs + dayOffset * 86400000 };
    assert.strictEqual(CW.standardExtensionWindow(WW_PLAYER, ctx).in_window, expected);
  });
}

console.log("\n§C4 extension — in-season trade acquisition (4 weeks)");
const TRADE_PLAYER = { years: 1, type: "Veteran", special: "", acquisitionTypeLabel: "Trade", acquisitionDate: "2026-09-15" };
const tradeAcqMs = Date.parse("2026-09-15T12:00:00-04:00");
await check("trade-acquired THIS season, day 28: still open", () => {
  const ctx = { season: 2026, contractDeadlineYmd: DEADLINE_YMD, isRookieLikeStatus, tagDeadlineDate: () => null,
    nowMs: tradeAcqMs + 28 * 86400000 };
  assert.strictEqual(CW.standardExtensionWindow(TRADE_PLAYER, ctx).in_window, true);
});
await check("trade-acquired THIS season, day 29: closed", () => {
  const ctx = { season: 2026, contractDeadlineYmd: DEADLINE_YMD, isRookieLikeStatus, tagDeadlineDate: () => null,
    nowMs: tradeAcqMs + 29 * 86400000 };
  assert.strictEqual(CW.standardExtensionWindow(TRADE_PLAYER, ctx).in_window, false);
});
await check("a LAST-season trade (Goedert's actual shape) does NOT get the 4-week window", () => {
  // This is exactly the distinction that matters for Goedert: his trade
  // happened in 2025, so acquisitionDate.slice(0,4) !== season(2026).
  const r = CW.standardExtensionWindow(GOEDERT, GOEDERT_CTX);
  assert.doesNotMatch(r.basis, /Trade-acquired/);
});

console.log("\n§C4 extension — rookie contract (May deadline)");
const ROOKIE_PLAYER = { years: 0, type: "Rookie-Draft", special: "expired rookie", acquisitionTypeLabel: "Rookie Draft", acquisitionDate: "2024-05-01" };
await check("rookie branch resolves via the caller-supplied tagDeadlineDate, not a re-derived copy", () => {
  const mayDeadline = new Date("2026-05-21T04:00:00Z");
  const ctx = {
    season: 2026, contractDeadlineYmd: DEADLINE_YMD, isRookieLikeStatus,
    tagDeadlineDate: (year) => { assert.strictEqual(year, 2026); return mayDeadline; },
    nowMs: mayDeadline.getTime() - 1000
  };
  const r = CW.standardExtensionWindow(ROOKIE_PLAYER, ctx);
  assert.strictEqual(r.in_window, true);
  assert.match(r.basis, /Rookie/);
});
await check("rookie branch fails closed when no tagDeadlineDate is supplied", () => {
  const ctx = { season: 2026, contractDeadlineYmd: DEADLINE_YMD, isRookieLikeStatus, tagDeadlineDate: null, nowMs: Date.now() };
  const r = CW.standardExtensionWindow(ROOKIE_PLAYER, ctx);
  assert.strictEqual(r.resolved, false);
  assert.strictEqual(r.in_window, false);
});

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
