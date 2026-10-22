// The 2025 taxi legacy record FAILS CLOSED (#1364, Keith 2026-10-21): if any of MFL's seventeen 2025 weekly roster
// exports (or a 2023–2025 draft) doesn't answer, nothing is stored and every reader of the rule says "unknown" — no
// Demote and no automatic cap-free cut — never "nobody was active in 2025". Through the REAL worker (/api/taxi-callups,
// the read every phone eligibility check uses), a SQLite D1 and a fake MFL; the cut's held price for the same case is
// tests/waiver_run_drop_pricing_parity.test.mjs C, and the live read is scripts/taxi_legacy_2025_preflight.mjs.
//   node tests/taxi_legacy_2025_fail_closed.test.mjs
import { makeD1 } from "./fixtures/d1_sqlite.mjs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { taxiEligibility, taxiCutVerdict } from "../worker/src/taxi_rule.js";
await import("./fixtures/register_md_loader.mjs");
const worker = (await import("../worker/src/index.js")).default;

// 2025 Round 2 picks: 17001 active in Week 5 only (then taxi), 17002 taxi all season. 2024 Round 3: 16001 on IR Week 9.
const DRAFTS = { 2023: [], 2024: [["16001", "3"]], 2025: [["17001", "2"], ["17002", "2"]] };
const status = (pid, w) => (pid === "17001" && w === 5 ? "ROSTER" : pid === "16001" && w === 9 ? "INJURED_RESERVE" : "TAXI_SQUAD");
const MFL = { downWeek: null, calls: 0 };
const json = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  const type = u.searchParams.get("TYPE"), w = Number(u.searchParams.get("W")), year = u.pathname.split("/")[1];
  MFL.calls++;
  if (type === "draftResults") return json({ draftResults: { draftUnit: { draftPick: (DRAFTS[year] || []).map(([player, round]) => ({ player, round })) } } });
  if (type === "rosters" && year === "2025") {
    if (w === MFL.downWeek) return json({ error: "MFL down" }, 503);
    return json({ rosters: { franchise: [{ id: "0001", player: ["17001", "17002", "16001"].map((id) => ({ id, status: status(id, w) })) }] } });
  }
  return json({ error: "test: no such call " + type }, 503);
};
const db = makeD1({});
db.raw.exec("CREATE TABLE ups_taxi_callups (player_id TEXT, season TEXT, nfl_week INTEGER, pending INTEGER, became_permanent INTEGER DEFAULT 0, demoted_at TEXT)");
db.raw.exec("CREATE TABLE ups_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)");
const env = { UPS_MFL_DB: db };
const get = async () => {
  const res = await worker.fetch(new Request("https://w.test/api/taxi-callups?L=74598&YEAR=2026"), env, { waitUntil() {}, passThroughOnException() {} });
  return res.json();
};
const stored = () => db.raw.prepare("SELECT value FROM ups_settings WHERE key = 'taxi_legacy_active_2025_v1'").get();

for (const down of [1, 12, 17]) {
  test(`2025 Week ${down} unreadable → /api/taxi-callups answers ok:false (every client reads "unknown"), nothing is stored`, async () => {
    MFL.downWeek = down;
    const j = await get();
    t.equal(j.ok, false); t.equal(j.error, "legacy_2025_unreadable"); t.deepEqual(j.players, {});
    t.equal(stored(), undefined, "no partial answer is kept");
  });
}

test("what 'unknown' means for a player the 2025 record decides: no Demote, no automatic cap-free cut (held)", () => {
  const cut = { season: 2026, upsRound: 2, upsYear: 2025, draftKnown: true, used: 0, pending: 0, permanent: false, legacy2025: null };
  for (const where of [{ isTaxi: false, isIr: false }, { isTaxi: true }, { isIr: true }]) {
    const v = taxiEligibility({ ...cut, contractStatus: "Rookie-Draft", ...where });
    t.deepEqual([v.eligible, v.can_demote, v.text], [null, false, "Eligibility could not be confirmed"], JSON.stringify(where));
  }
  t.equal(taxiCutVerdict(cut, "Rookie-Draft", false), null, "cut from the active roster: held");
  t.equal(taxiCutVerdict(cut, "Rookie-Draft", true), null, "cut from taxi: held");
  t.equal(taxiCutVerdict({ ...cut, upsYear: 2026, legacy2025: false }, "Rookie-Draft", false), true, "a 2026 pick doesn't depend on the 2025 record");
});

test("all seventeen weeks readable → the legacy set (an active week, an IR week; taxi all season is not in it), stored once", async () => {
  MFL.downWeek = null;
  const j = await get();
  t.equal(j.ok, true);
  t.deepEqual(Object.keys(j.players).sort(), ["16001", "17001"]);
  t.deepEqual([j.players["17001"].legacy_2025, j.players["17001"].permanent_promotion, j.players["17001"].tracked_permanent], [true, true, false]);
  t.deepEqual(JSON.parse(stored().value), ["16001", "17001"]);
  const before = MFL.calls;
  t.equal((await get()).ok, true);
  t.equal(MFL.calls, before, "the stored answer is read; MFL isn't asked again");
});

await run("taxi_legacy_2025_fail_closed");
