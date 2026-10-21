// Taxi eligibility — the ONE rule (worker/src/taxi_rule.js, browser twin site/shared/taxi_rule.js), checked at every
// boundary canon §A1 / §B2 / T2.4 / §G14 draws, and wired into every application path:
//   UPS Rookie Draft round/year decide it (never the NFL fields); Round 1 never; Round 2+ for the first 3 league
//   years; activations 1–3 are temporary (demotion allowed after each); the 4th is permanent; a cut/release ends
//   the original eligibility and re-acquiring doesn't restore it; a trade keeps it.
//   node tests/taxi_rule.test.mjs
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { taxiEligibility, taxiPermanent, TAXI_CALLUPS_MAX } from "../worker/src/taxi_rule.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const TWIN = createRequire(import.meta.url)("../site/shared/taxi_rule.js");

// A 2025 Round 3 pick, never released, read in the 2026 league year, active roster.
const base = { upsRound: 3, upsYear: 2025, season: 2026, contractStatus: "Rookie-Draft", isTaxi: false, isIr: false, used: 0, pending: 0 };
const v = (o) => taxiEligibility({ ...base, permanent: taxiPermanent({ used: (o && o.used) || 0, marked: 0, priorActive: false }), ...o });

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
  t.equal(taxiPermanent({ used: 4, marked: 0, priorActive: false }), true);
  t.equal(taxiPermanent({ used: 3, marked: 0, priorActive: false }), false);
});

test("pending activations never count; they do decide whether the NEXT promote is the 4th", () => {
  const r = v({ used: 2, pending: 1 });
  t.equal(r.eligible, true); t.equal(r.callups_used, 2); t.equal(r.callups_left, 1);
  t.equal(r.next_callup, 4); t.equal(r.next_callup_permanent, true, "used 2 + 1 pending → a further promote is the 4th activation");
  t.equal(v({ used: 0, pending: 1 }).can_demote, true, "demote right after a promote, before the week locks");
});

test("other permanence: a marked call-up row, a prior season ended active, or an explicit contract conversion", () => {
  t.equal(taxiPermanent({ used: 1, marked: 1, priorActive: false }), true);
  t.equal(taxiPermanent({ used: 0, marked: 0, priorActive: true }), true);
  t.equal(taxiEligibility({ ...base, permanent: true }).text, "Not eligible · permanently promoted");
  // MYAC / extension / restructure replace the entry contract → no longer "Rookie-Draft".
  t.equal(taxiEligibility({ ...base, contractStatus: "Vet-Ext1", permanent: false }).reason, "released");
});

test("release / re-acquisition ends it; a trade keeps it", () => {
  for (const status of ["Vet-FAA", "Rookie-FAA", "Vet-MYM", "WW", ""]) {
    const r = taxiEligibility({ ...base, contractStatus: status, permanent: false });
    t.equal(r.eligible, false, status); t.equal(r.reason, "released"); t.ok(/re-acquiring doesn't restore it/.test(r.text));
  }
  // A trade keeps MFL's contract status as-is.
  t.equal(taxiEligibility({ ...base, contractStatus: "Rookie-Draft", permanent: false }).eligible, true);
  t.equal(taxiEligibility({ ...base, contractStatus: "rookie-draft", permanent: false }).eligible, true, "case-insensitive");
});

test("round and the three-league-year window (UPS draft, not NFL)", () => {
  t.equal(taxiEligibility({ ...base, upsRound: 1, permanent: false }).reason, "round_1");
  t.equal(taxiEligibility({ ...base, upsRound: 6, permanent: false }).eligible, true, "Round 6 (IDP) is eligible");
  t.equal(taxiEligibility({ ...base, upsYear: 2024, permanent: false }).eligible, true, "2 league years elapsed");
  const ended = taxiEligibility({ ...base, upsYear: 2023, permanent: false });
  t.equal(ended.reason, "window_ended"); t.equal(ended.text, "Not eligible · taxi window ended (2023 draft)");
  t.equal(taxiEligibility({ ...base, upsRound: 0, upsYear: 0, permanent: false }).reason, "not_ups_pick");
  t.equal(taxiEligibility({ ...base, upsRound: 0, upsYear: 0, permanent: false, windowIndexOnly: true }).reason, "no_recent_pick",
    "an index of the last 3 drafts never calls an older pick (e.g. Dak Prescott, 2016) 'not a UPS pick'");
});

test("unknown is never a guess: unreadable draft, contract or call-up history → Unknown, no Demote", () => {
  for (const o of [{ draftKnown: false, permanent: false }, { contractKnown: false, permanent: false }, { permanent: null }]) {
    const r = taxiEligibility({ ...base, ...o });
    t.equal(r.eligible, null, JSON.stringify(o)); t.equal(r.can_demote, false); t.ok(/^Unknown · /.test(r.text));
  }
  t.equal(taxiPermanent({ used: 0, marked: 0, priorActive: null }), null, "unreadable prior-season rosters → unknown");
  t.equal(taxiPermanent({ used: 4, marked: 0, priorActive: null }), true, "but 4 activations is permanent regardless");
  t.equal(taxiEligibility({ ...base, upsRound: 1, contractKnown: false, permanent: false }).reason, "round_1", "a known disqualifier still decides");
  // Outside the window (or Round 1) a new contract is an expired rookie deal, not a release: Dak Prescott 2016 R5, Vet-FAA.
  const dak = taxiEligibility({ upsRound: 5, upsYear: 2016, season: 2026, contractStatus: "Vet-FAA", permanent: false });
  t.equal(dak.text, "Not eligible · taxi window ended (2016 draft)"); t.equal(dak.reasons.length, 1, "no 'released' claim");
});

test("already on taxi or IR: eligible, but there is nothing to demote", () => {
  t.equal(v({ isTaxi: true }).eligible, true); t.equal(v({ isTaxi: true }).can_demote, false);
  t.equal(v({ isIr: true }).can_demote, false);
});

test("the browser twin is the same rule, byte for byte and on a grid", () => {
  const w = read("worker/src/taxi_rule.js"), s = read("site/shared/taxi_rule.js");
  const body = w.slice(w.indexOf("export const TAXI_CALLUPS_MAX")).replace(/export const /g, "const ").replace(/export function /g, "function ");
  const twin = s.slice(s.indexOf("---- body: generated") ).split("\n").slice(1).join("\n");
  const twinBody = twin.slice(0, twin.indexOf("  // ---- end body ----")).split("\n").map((l) => l.replace(/^  /, "")).join("\n");
  t.equal(twinBody.trim(), body.trim(), "regenerate site/shared/taxi_rule.js from the worker module");
  let n = 0;
  for (const upsRound of [0, 1, 2, 6]) for (const upsYear of [0, 2023, 2024, 2026]) for (const contractStatus of ["Rookie-Draft", "Vet-FAA"])
    for (const permanent of [true, false, null]) for (const used of [0, 3, 4]) for (const isTaxi of [false, true]) {
      const i = { upsRound, upsYear, season: 2026, contractStatus, permanent, used, isTaxi };
      t.deepEqual(JSON.parse(JSON.stringify(TWIN.taxiEligibility(i))), JSON.parse(JSON.stringify(taxiEligibility(i)))); n++;
    }
  t.ok(n > 500);
});

test("every application path reads the one verdict", () => {
  const W = read("worker/src/index.js");
  t.ok(/import \{ taxiEligibility, taxiPermanent \} from "\.\/taxi_rule\.js";/.test(W));
  t.ok(/taxi_status: taxiStatus,/.test(W) && /const isTaxiEligible = taxiStatus\.eligible === true;/.test(W), "/roster-workbench emits taxi_status; taxi_eligible is its answer");
  t.ok(/priorActive: taxiPriorActive\.size \? taxiPriorActive\.has\(playerId\) : null/.test(W), "roster-workbench: prior-season permanence, unknown when unreadable");
  // Demote write guard: same rule, full permanence predicate, fail closed.
  const guard = W.slice(W.indexOf('if (action === "demote_taxi") {'), W.indexOf("if (isMembershipRosterAction) {"));
  t.ok(/taxiPermanent\(\{/.test(guard) && /priorActive: prior && prior\.size \? prior\.has\(String\(playerId\)\) : null/.test(guard), "demote guard: 4th activation, marked row, prior season active");
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
  t.ok(/return r\.ok \? r\.json\(\) : \{ ok: false, players: \{\} \}/.test(APP), "a failed /api/taxi-callups read is recorded, not read as 'nobody promoted'");
  t.ok(IDX.indexOf("../shared/taxi_rule.js") > 0 && IDX.indexOf("../shared/taxi_rule.js") < IDX.indexOf("./app.js"), "the phone loads the rule before app.js");
});

await run("taxi_rule");
