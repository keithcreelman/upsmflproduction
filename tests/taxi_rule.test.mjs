// Taxi eligibility — the ONE rule (worker/src/taxi_rule.js, browser twin site/shared/taxi_rule.js), checked at every
// boundary canon §A1 / §B2 / T2.4 / §G14 draws, and wired into every application path:
//   UPS Rookie Draft round/year decide it (never the NFL fields); Round 1 never; Round 2+ for the first 3 league
//   years; from 2026, activations 1–3 are temporary (demotion allowed after each, the third included) and the next
//   promotion after all three is permanent; ending a season active or on IR is not, by itself, permanent; the 2025
//   legacy rule (active or IR in any 2025 week → permanent) is one-time; a cut/release ends the original eligibility
//   and re-acquiring doesn't restore it; a trade keeps it (Keith 2026-10-21).
//   node tests/taxi_rule.test.mjs
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { taxiEligibility, taxiPermanent, taxiCutVerdict, TAXI_CALLUPS_MAX, TAXI_LEGACY_SEASON, TAXI_TRACKED_FROM_SEASON } from "../worker/src/taxi_rule.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const TWIN = createRequire(import.meta.url)("../site/shared/taxi_rule.js");

// A 2025 Round 3 pick, never released, read in the 2026 league year, active roster.
const base = { upsRound: 3, upsYear: 2025, season: 2026, contractStatus: "Rookie-Draft", isTaxi: false, isIr: false, used: 0, pending: 0, legacy2025: false };
const v = (o) => taxiEligibility({ ...base, permanent: taxiPermanent({ used: (o && o.used) || 0, marked: 0, legacy2025: false }), ...o });

test("activations 0, 1, 2, 3 are temporary: eligible, demotable after each; the 4th is permanent", () => {
  t.equal(TAXI_CALLUPS_MAX, 3);
  for (const used of [0, 1, 2, 3]) {
    const r = v({ used });
    t.equal(r.eligible, true, used + " used → eligible");
    t.equal(r.can_demote, true, used + " used → Demote to Taxi allowed (canon: after each of the first three)");
    t.equal(r.callups_left, 3 - used);
    t.equal(r.next_callup, used + 1); t.equal(r.next_callup_permanent, used + 1 > 3);
  }
  const four = v({ used: 4 });
  t.equal(four.eligible, false); t.equal(four.reason, "permanently_promoted"); t.equal(four.can_demote, false);
  t.equal(four.text, "Not eligible · permanently promoted after three temporary call-ups");
  t.equal(taxiPermanent({ used: 4, marked: 0, legacy2025: false }), true);
  t.equal(taxiPermanent({ used: 3, marked: 0, legacy2025: false }), false);
  t.equal(TAXI_LEGACY_SEASON, 2025); t.equal(TAXI_TRACKED_FROM_SEASON, 2026);
});

test("demotion after the THIRD call-up is still allowed; the next promotion after all three is permanent", () => {
  const third = v({ used: 3 });
  t.deepEqual([third.eligible, third.can_demote, third.callups_left], [true, true, 0], "3 used, on the active roster: Demote allowed");
  t.deepEqual([third.next_callup, third.next_callup_permanent], [4, true], "promoting him from taxi again would be permanent");
  const backOnTaxi = v({ used: 3, isTaxi: true });
  t.equal(backOnTaxi.eligible, true, "demoted after the third: still eligible on taxi");
  t.equal(backOnTaxi.next_callup_permanent, true);
  const after = v({ used: 4 });
  t.deepEqual([after.eligible, after.permanent, after.can_demote], [false, true, false], "that next promotion happened: permanently ineligible");
  t.equal(v({ used: 4, isTaxi: true }).eligible, false, "and never eligible again, wherever he sits");
});

test("ending a season on the active roster or IR does not, by itself, make him permanent: one or two call-ups in 2026 → still eligible in 2027", () => {
  for (const used of [1, 2]) {
    for (const where of [{ isTaxi: false, isIr: false }, { isTaxi: false, isIr: true }]) {
      const r = taxiEligibility({ ...base, season: 2027, used, ...where, permanent: taxiPermanent({ used, marked: 0, legacy2025: false }) });
      t.equal(r.eligible, true, used + " call-up(s), 2027, " + JSON.stringify(where));
      t.equal(r.callups_left, 3 - used);
    }
  }
  t.equal(taxiEligibility({ ...base, season: 2027, used: 2, permanent: false }).can_demote, true, "and he may be returned to taxi");
  t.ok(!/priorActive|ended a prior season/.test(read("worker/src/taxi_rule.js")), "the resolver has no 'ended a prior season active' input any more");
});

test("pending activations never count; they do decide whether the NEXT promote is the 4th", () => {
  const r = v({ used: 2, pending: 1 });
  t.equal(r.eligible, true); t.equal(r.callups_used, 2); t.equal(r.callups_left, 1);
  t.equal(r.next_callup, 4); t.equal(r.next_callup_permanent, true, "used 2 + 1 pending → a further promote is the 4th activation");
  t.equal(v({ used: 0, pending: 1 }).can_demote, true, "demote right after a promote, before the week locks");
});

test("other permanence: a marked call-up row, the 2025 legacy rule, or an explicit contract conversion", () => {
  t.equal(taxiPermanent({ used: 1, marked: 1, legacy2025: false }), true);
  t.equal(taxiPermanent({ used: 0, marked: 0, legacy2025: true }), true);
  t.equal(taxiEligibility({ ...base, permanent: true }).text, "Not eligible · permanently promoted after three temporary call-ups");
  const legacy = taxiEligibility({ ...base, permanent: false, legacy2025: true, isTaxi: true });
  t.deepEqual([legacy.eligible, legacy.reason, legacy.permanent, legacy.legacy_2025], [false, "legacy_2025", true, true]);
  t.equal(legacy.text, "Not eligible · active during 2025 (legacy promotion)", "active during 2025, back on taxi now: still ineligible");
  // MYAC / extension / restructure replace the entry contract → no longer "Rookie-Draft".
  t.equal(taxiEligibility({ ...base, contractStatus: "Vet-Ext1", permanent: false }).reason, "released");
});

test("release / re-acquisition ends it; a trade keeps it", () => {
  for (const status of ["Vet-FAA", "Rookie-FAA", "Vet-MYM", "WW", ""]) {
    const r = taxiEligibility({ ...base, contractStatus: status, permanent: false });
    t.equal(r.eligible, false, status); t.equal(r.reason, "released"); t.equal(r.text, "Not eligible · released");
    t.ok(/re-acquiring him doesn't restore it/.test(r.detail));
  }
  // A trade keeps MFL's contract status as-is.
  t.equal(taxiEligibility({ ...base, contractStatus: "Rookie-Draft", permanent: false }).eligible, true);
  t.equal(taxiEligibility({ ...base, contractStatus: "rookie-draft", permanent: false }).eligible, true, "case-insensitive");
});

test("round and the three-league-year window (UPS draft, not NFL)", () => {
  t.equal(taxiEligibility({ ...base, upsRound: 1, permanent: false }).reason, "round_1");
  t.equal(taxiEligibility({ ...base, upsRound: 1, permanent: false }).text, "Not eligible · Round 1 selection");
  t.equal(taxiEligibility({ ...base, upsRound: 6, permanent: false }).eligible, true, "Round 6 (IDP) is eligible");
  t.equal(taxiEligibility({ ...base, upsYear: 2024, permanent: false }).eligible, true, "2 league years elapsed");
  const ended = taxiEligibility({ ...base, upsYear: 2023, permanent: false });
  t.equal(ended.reason, "window_ended"); t.equal(ended.text, "Not eligible · taxi window ended"); t.ok(/^2023 UPS Rookie Draft/.test(ended.detail));
  t.equal(taxiEligibility({ ...base, upsRound: 0, upsYear: 0, permanent: false }).reason, "not_ups_pick");
  t.equal(taxiEligibility({ ...base, upsRound: 0, upsYear: 0, permanent: false, windowIndexOnly: true }).reason, "no_recent_pick",
    "an index of the last 3 drafts never calls an older pick (e.g. Dak Prescott, 2016) 'not a UPS pick'");
});

test("unknown is never a guess: unreadable draft, contract, 2025 record or call-up history → 'Eligibility could not be confirmed', no Demote", () => {
  for (const o of [{ draftKnown: false, permanent: false }, { contractKnown: false, permanent: false }, { permanent: null }, { permanent: false, legacy2025: null },
                   { permanent: false, legacy2025: undefined }]) {
    const r = taxiEligibility({ ...base, ...o });
    t.equal(r.eligible, null, JSON.stringify(o)); t.equal(r.can_demote, false); t.equal(r.text, "Eligibility could not be confirmed");
    t.ok(r.detail.length > 0, "says what couldn't be read");
  }
  t.equal(taxiEligibility({ ...base, season: 2025, permanent: false, legacy2025: undefined }).eligible, true, "before 2026 the legacy rule isn't applied");
  t.equal(taxiPermanent({ used: 0, marked: 0, legacy2025: null }), null, "unreadable 2025 rosters → unknown");
  t.equal(taxiPermanent({ used: 4, marked: 0, legacy2025: null }), true, "but 4 activations is permanent regardless");
  t.equal(taxiEligibility({ ...base, upsRound: 1, contractKnown: false, permanent: false }).reason, "round_1", "a known disqualifier still decides");
  // Outside the window (or Round 1) a new contract is an expired rookie deal, not a release: Dak Prescott 2016 R5, Vet-FAA.
  const dak = taxiEligibility({ upsRound: 5, upsYear: 2016, season: 2026, contractStatus: "Vet-FAA", permanent: false });
  t.equal(dak.text, "Not eligible · taxi window ended"); t.equal(dak.reasons.length, 1, "no 'released' claim");
});

test("already on taxi or IR: eligible, but there is nothing to demote", () => {
  t.equal(v({ isTaxi: true }).eligible, true); t.equal(v({ isTaxi: true }).can_demote, false);
  t.equal(v({ isIr: true }).can_demote, false);
});

test("the owner-facing reasons, exactly as ruled (Keith 2026-10-21)", () => {
  const texts = [
    taxiEligibility({ ...base, permanent: false, legacy2025: true }).text,
    taxiEligibility({ ...base, used: 4, permanent: true }).text,
    taxiEligibility({ ...base, contractStatus: "Vet-FAA", permanent: false }).text,
    taxiEligibility({ ...base, upsYear: 2023, permanent: false }).text,
    taxiEligibility({ ...base, upsRound: 1, permanent: false }).text,
    taxiEligibility({ ...base, permanent: null }).text,
  ];
  t.deepEqual(texts, ["Not eligible · active during 2025 (legacy promotion)", "Not eligible · permanently promoted after three temporary call-ups",
    "Not eligible · released", "Not eligible · taxi window ended", "Not eligible · Round 1 selection", "Eligibility could not be confirmed"]);
});

// ── The CUT (Keith 2026-10-21, canon T5.2 / §D2): cap-free iff still taxi-eligible immediately before it, wherever he sits ──
const before = { season: 2026, upsRound: 3, upsYear: 2025, draftKnown: true, used: 0, pending: 0, permanent: false, legacy2025: false };
test("an eligible player's cut is cap-free from the TAXI SQUAD, the ACTIVE ROSTER, IR or a TEMPORARY CALL-UP", () => {
  t.equal(taxiCutVerdict(before, "Rookie-Draft", true), true, "cut from the taxi squad");
  t.equal(taxiCutVerdict(before, "Rookie-Draft", false), true, "cut from the active roster, never on taxi");
  t.equal(taxiCutVerdict({ ...before, isIr: true, used: 1 }, "Rookie-Draft", false), true, "cut from IR (IR is not the taxi squad)");
  for (const used of [1, 2, 3]) t.equal(taxiCutVerdict({ ...before, used }, "Rookie-Draft", false), true, "cut after " + used + " temporary call-up(s)");
  t.equal(taxiCutVerdict(before, "Rookie", false), true, "the pre-2026 spelling of the entry contract");
});

test("after the release: a re-acquired player is never eligible again (and a trade is not a release)", () => {
  for (const st of ["Rookie-FAA", "Vet-FAA", "Rookie-WW", "Vet-WW", "Vet-MYM", "Vet-Ext1"]) {
    t.equal(taxiCutVerdict(before, st, false), false, "re-acquired as " + st);
    t.equal(taxiCutVerdict(before, st, true), false, "re-acquired as " + st + ", even sitting on taxi");
  }
  t.equal(taxiCutVerdict({ ...before, used: 2 }, "Rookie-Draft", false), true, "traded: the Rookie-Draft contract and the call-ups follow him");
});

test("permanent promotion, an expired window, Round 1 and unreadable history never get the cap-free cut", () => {
  t.equal(taxiCutVerdict({ ...before, used: 4, permanent: true }, "Rookie-Draft", false), false, "4th activation");
  t.equal(taxiCutVerdict({ ...before, used: 1, permanent: true }, "Rookie-Draft", true), false, "a marked row, even on taxi");
  t.equal(taxiCutVerdict({ ...before, legacy2025: true }, "Rookie-Draft", true), false, "the 2025 legacy promotion, even on taxi");
  t.equal(taxiCutVerdict({ ...before, upsYear: 2023 }, "Rookie-Draft", true), false, "window ended, even on taxi");
  t.equal(taxiCutVerdict({ ...before, upsRound: 1 }, "Rookie-Draft", false), false, "Round 1");
  for (const c of [{ ...before, permanent: null }, { ...before, draftKnown: false }, { ...before, legacy2025: null }, null, undefined]) {
    t.equal(taxiCutVerdict(c, "Rookie-Draft", false), null, "unknown → held: " + JSON.stringify(c));
  }
  t.equal(taxiCutVerdict(null, "Vet-FAA", true), false, "an unknown history never matters to a re-acquired player");
});

test("the week under way: his 4th activation only if he was NOT on the taxi squad at the cut", () => {
  const third = { ...before, used: 3, liveWeek: true };
  t.equal(taxiCutVerdict(third, "Rookie-Draft", false), false, "active when his game kicked off: the 4th activation, permanent");
  t.equal(taxiCutVerdict(third, "Rookie-Draft", true), true, "on taxi: that week is not an activation");
  t.equal(taxiCutVerdict({ ...third, liveWeek: null }, "Rookie-Draft", false), null, "schedule unreadable: held");
  t.equal(taxiCutVerdict({ ...third, liveWeek: null }, "Rookie-Draft", true), true, "on taxi the schedule doesn't matter");
});

test("the browser twin is the same rule, byte for byte and on a grid", () => {
  const w = read("worker/src/taxi_rule.js"), s = read("site/shared/taxi_rule.js");
  const body = w.slice(w.indexOf("export const TAXI_CALLUPS_MAX")).replace(/export const /g, "const ").replace(/export function /g, "function ");
  const twin = s.slice(s.indexOf("---- body: generated") ).split("\n").slice(1).join("\n");
  const twinBody = twin.slice(0, twin.indexOf("  // ---- end body ----")).split("\n").map((l) => l.replace(/^  /, "")).join("\n");
  t.equal(twinBody.trim(), body.trim(), "regenerate site/shared/taxi_rule.js from the worker module");
  let n = 0;
  for (const upsRound of [0, 1, 2, 6]) for (const upsYear of [0, 2023, 2024, 2026]) for (const contractStatus of ["Rookie-Draft", "Vet-FAA"])
    for (const permanent of [true, false, null]) for (const used of [0, 3, 4]) for (const isTaxi of [false, true])
    for (const legacy2025 of [true, false, null, undefined]) {
      const i = { upsRound, upsYear, season: 2026, contractStatus, permanent, used, isTaxi, legacy2025 };
      t.deepEqual(JSON.parse(JSON.stringify(TWIN.taxiEligibility(i))), JSON.parse(JSON.stringify(taxiEligibility(i)))); n++;
    }
  t.ok(n > 2000);
});

test("every application path reads the one verdict", () => {
  const W = read("worker/src/index.js");
  t.ok(/import \{ taxiEligibility, taxiPermanent, taxiCutVerdict, TAXI_LEGACY_SEASON, TAXI_TRACKED_FROM_SEASON \} from "\.\/taxi_rule\.js";/.test(W));
  t.ok(/taxi_status: taxiStatus,/.test(W) && /const isTaxiEligible = taxiStatus\.eligible === true;/.test(W), "/roster-workbench emits taxi_status; taxi_eligible is its answer");
  t.ok(/legacy2025: taxiLegacy,/.test(W) && /const taxiLegacy = _taxiLegacyFor\(taxiLegacy2025, playerId, currentSeason, upsYear\);/.test(W), "roster-workbench: the 2025 legacy rule, unknown when unreadable");
  t.ok(!/taxiPriorActivePids\(/.test(W), "no caller of the withdrawn 'ended a prior season active' reader");
  // Every call-up count counts DISTINCT qualifying scoring weeks recorded from 2026 — never rows or transactions.
  t.ok(!/SUM\(CASE WHEN pending = 0/.test(W), "no count of raw rows remains");
  t.ok((W.match(/\$\{TAXI_USED_WEEKS_SQL\}/g) || []).length >= 7, "every used-count is distinct recorded weeks");
  t.ok(/COUNT\(DISTINCT CASE WHEN pending = 0 AND \$\{TAXI_TRACKED_SQL\} AND nfl_week IS NOT NULL THEN season \|\| '-' \|\| nfl_week END\)/.test(W));
  // Demote write guard: same rule, full permanence predicate, fail closed.
  const guard = W.slice(W.indexOf('if (action === "demote_taxi") {'), W.indexOf("if (isMembershipRosterAction) {"));
  t.ok(/taxiPermanent\(\{/.test(guard) && /legacy2025: _taxiLegacyFor\(legacy2025, playerId, season, r1Gate\.draftYear\)/.test(guard), "demote guard: 4th activation, marked row, 2025 legacy");
  t.ok(/code: "TAXI_HISTORY_UNREADABLE"/.test(guard) && /if \(permanentAnswer !== false\)/.test(guard), "demote guard fails closed");
  t.ok(!/Number\(permRow\?\.used \|\| 0\) >= 4\) \{/.test(guard), "no used>=4-only check");
  t.ok(/const verdict = taxiEligibility\(\{/.test(W), "the demote gate's draft/window/release verdict is the shared rule");
  // Legacy roster workbench: the call-up-count guard is gone.
  const RW = read("site/rosters/roster_workbench.js");
  t.ok(!/function taxiDemoteLikelyForbidden/.test(RW) && /} else if \(taxiCanDemote\(player\)\) \{/.test(RW) && /player\.taxiStatus\.can_demote === true/.test(RW));
  // Game Day.
  const GD = read("site/gameday/gameday.html");
  t.ok(/p\.taxi_status \? p\.taxi_status\.can_demote === true/.test(GD) && /next_callup_permanent/.test(GD) && !/UPS draft R2–5/.test(GD));
  // Phone: the twin, fail closed on unreadable call-up history.
  const APP = read("site/m/app.js"), IDX = read("site/m/index.html");
  t.ok(/window\.UPS_TAXI_RULE/.test(APP) && /permanent: state\.taxiCallupsOk === false \? null/.test(APP) && /windowIndexOnly: true/.test(APP));
  t.ok(/legacy2025: state\.taxiCallupsOk === false \? null : !!\(callup && callup\.legacy_2025\)/.test(APP), "phone: the 2025 legacy flag, unknown when the read failed");
  t.ok(/error: "legacy_2025_unreadable"/.test(W), "/api/taxi-callups fails closed (ok:false) when the 2025 record can't be read");
  // Front Office bio line: the worker's reason.
  const FO = read("site/rosters/v2/front_office.js");
  t.ok(/taxiStatus:\s+p\.taxi_status \|\| null/.test(FO) && /if \(ts && ts\.eligible !== true && ts\.text\) return \{ text: ts\.text/.test(FO), "Front Office shows the verdict's reason");
  t.ok(/return r\.ok \? r\.json\(\) : \{ ok: false, players: \{\} \}/.test(APP), "a failed /api/taxi-callups read is recorded, not read as 'nobody promoted'");
  t.ok(IDX.indexOf("../shared/taxi_rule.js") > 0 && IDX.indexOf("../shared/taxi_rule.js") < IDX.indexOf("./app.js"), "the phone loads the rule before app.js");
});

await run("taxi_rule");
