// The claim-submit heads-ups count at most ONE pickup per group — MFL's conditional blind bidding (canon §A4) (Keith 2026-10-16).
//   node tests/waiver_claim_warnings_one_per_group.test.mjs
//
// Keith submitted 4 claims, all in group 1, and was told:
//   "Round 1: winning all 4 claims would put you at 33 active players (MFL's limit is 30…)"
//   "Round 1: winning every claim would put you roughly $4,000 over the $300,000 cap…"
// Within a group MFL awards at most one claim, so the most he could pick up was one player and one bid's salary.
// Part A drives the REAL /api/waivers/bbid-plan route with dry_run (nothing is sent to MFL; the fake MFL refuses any
// import). Part B checks the worst-case helper's rules one by one.
import fs from "node:fs";
import { makeD1 } from "./fixtures/d1_sqlite.mjs";
import { t, test, run } from "./fixtures/mini_test.mjs";
await import("./fixtures/register_md_loader.mjs");
const worker = (await import("../worker/src/index.js")).default;

const LEAGUE = "25625";   // the rehearsal league (its write gate is armed without a production flag; dry_run writes nothing anyway)
const RAW_2026 = [
  ["WAIVER_NONE", 1784779200, 1785902400, 0], ["WAIVER_LOCK", 1785902400, null, 0], ["WAIVER_LOCK", 1786021200, null, 22],
  ["WAIVER_LOCK", 1786107600, null, 22], ["WAIVER_BBID", 1786107600, null, 22], ["WAIVER_LOCK", 1786194000, null, 22],
  ["WAIVER_BBID", 1786194000, null, 22], ["WAIVER_LOCK", 1786280400, null, 4], ["WAIVER_BBID", 1786280400, null, 22],
  ["WAIVER_BBID", 1786626000, null, 21], ["WAIVER_LOCK", 1789434000, null, 17], ["WAIVER_NONE", 1799114400, null, 0],
].map(([type, s, e, h]) => ({ type, start_time: String(s), end_time: e ? String(e) : "", happens: h ? String(h) : "", title: "", id: "x" }));

// 0008's roster: 29 players in active spots, 2 on taxi, 1 on IR — $2,000 of cap room by MFL's count
// ($295,000 active + 50% of a $6,000 IR salary; taxi off the cap; no salary adjustments).
const ROSTER = [];
for (let i = 0; i < 29; i += 1) ROSTER.push({ id: String(10000 + i), status: "ROSTER", salary: i === 0 ? "15000" : "10000" });
ROSTER.push({ id: "12000", status: "TAXI_SQUAD", salary: "5000" }, { id: "12001", status: "TAXI_SQUAD", salary: "2000" }, { id: "12002", status: "INJURED_RESERVE", salary: "6000" });
let CONDITIONAL = "1";
const IMPORTS = [];
const json = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  if (/\/import$/.test(u.pathname)) { IMPORTS.push(u.search); return json({ error: "test: no MFL write" }, 503); }
  const type = u.searchParams.get("TYPE") || "";
  if (type === "myleagues") return json({ leagues: { league: [{ league_id: LEAGUE, franchise_id: "0008", name: "UPS" }] } });
  if (type === "calendar") return json({ calendar: { event: RAW_2026 } });
  if (type === "league") return json({ league: { id: LEAGUE, rosterSize: "30", salaryCapAmount: "300000", bbidMinimum: "1000", bbidIncrement: "1000",
    maxWaiverRounds: "5", bbidConditional: CONDITIONAL, currentWaiverType: "BBID_FCFS", includeIRWithSalary: "50", franchises: { franchise: [{ id: "0008", name: "Real Deal Creel" }] } } });
  if (type === "rosters") return json({ rosters: { franchise: [{ id: "0008", player: ROSTER }] } });
  if (type === "salaryAdjustments") return json({ salaryAdjustments: {} });
  if (type === "liveScoring") return json({ liveScoring: { week: "6", matchup: [] } });
  if (type === "nflSchedule") return json({ nflSchedule: { week: u.searchParams.get("W"), matchup: [] } });
  return json({ error: { $t: "test: no such call" } }, 503);
};
const env = { UPS_MFL_DB: makeD1({}), COMMISH_API_KEY: "admin", MFL_COOKIE: "COMMISH", MFL_APIKEY: "k" };
const realNow = Date.now;
async function submit(rounds) {
  const NOW = Date.parse("2026-10-14T12:00:00-04:00");   // a Wednesday: the Thursday blind-bid run is open
  Date.now = () => NOW;
  try {
    const req = new Request(`https://w.test/api/waivers/bbid-plan?L=${LEAGUE}&YEAR=2026&MFL_USER_ID=tok-owner`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rounds, dry_run: true }),
    });
    const res = await worker.fetch(req, env, { waitUntil() {}, passThroughOnException() {} });
    const text = await res.text();
    let body = {}; try { body = JSON.parse(text); } catch (_) {}
    return { status: res.status, body, text, warn: Object.fromEntries((body.warnings || []).map((w) => [w.code, w.message])) };
  } finally { Date.now = realNow; }
}
const pick = (add_pid, bid_dollars, drop_pid) => ({ add_pid, bid_dollars, ...(drop_pid ? { drop_pid } : {}) });

// ═════════ A. the real route ═════════
test("A1. Keith's submit — 4 claims in group 1, no drops: one pickup at most → 30 active (no roster heads-up); each $1,000 claim fits his $2,000 of room (no cap note)", async () => {
  const r = await submit([{ round: 1, picks: [pick("20001", 1000), pick("20002", 1000), pick("20003", 1000), pick("20004", 1000)] }]);
  t.equal(r.status, 200, r.text.slice(0, 400));
  t.equal(r.body.dry_run, true);
  t.equal(r.warn.ROSTER_HEADROOM, undefined, "29 + 1 = 30, MFL's limit — not over it");
  t.equal(r.warn.CAP_ROOM, undefined, "one $1,000 pickup at most, and $2,000 of room");
  t.deepEqual(IMPORTS, [], "dry run: nothing sent to MFL");
});
test("A2. two groups, each with a no-drop claim: two pickups at most → 31 active; the $3,000 claim can't be awarded, and the claims that fit don't fit together", async () => {
  const r = await submit([{ round: 1, picks: [pick("20001", 1000), pick("20002", 3000)] }, { round: 2, picks: [pick("20003", 2000)] }]);
  t.equal(r.warn.ROSTER_HEADROOM, "If MFL awards one claim in each of your 2 groups (the most it can — one per group), you'd be at 31 active players (MFL's limit is 30; taxi and IR are not counted). Heads-up only — MFL decides at award time.");
  t.equal(r.warn.CAP_ROOM, "MFL won't award your $3,000 claim in group 1 under the hard cap: it needs about $1,000 more cap room than you have. "
    + "Your other claims fit one at a time, but one in each of your 2 groups would need about $1,000 more cap room than you have — MFL won't award a claim that no longer fits when its turn comes. "
    + "MFL cap room now: $2,000 (salary adjustments included, IR counted at 50%).");
});
test("A3. a league MFL reports as NOT conditional: every claim can land, so all four count", async () => {
  CONDITIONAL = "0";
  const r = await submit([{ round: 1, picks: [pick("20001", 1000), pick("20002", 1000), pick("20003", 1000), pick("20004", 1000)] }]);
  CONDITIONAL = "1";
  t.match(r.warn.ROSTER_HEADROOM, /^If MFL awards every claim, you'd be at 33 active players/);
  t.match(r.warn.CAP_ROOM, /^Your claims fit one at a time, but all of them would need about \$2,000 more cap room than you have/);
});

// ═════════ B. the worst-case rules ═════════
const SRC = fs.readFileSync(new URL("../worker/src/index.js", import.meta.url), "utf8");
const i = SRC.indexOf("function _waiverClaimWorstCase(");
const WC = new Function(SRC.slice(i, SRC.indexOf("\n}\n", i) + 2) + "\nreturn _waiverClaimWorstCase;")();
const roster = { by_pid: new Map([["10001", { salary: 10000, taxi: false, ir: false }], ["12000", { salary: 5000, taxi: true, ir: false }], ["12002", { salary: 3000, taxi: false, ir: true }]]) };
test("B1. a claim that drops an active player adds no one; dropping a taxi or IR player frees no active spot", () => {
  t.equal(WC([{ round: 1, picks: [pick("1", 1000, "10001")] }], roster).max_new_active, 0);
  t.equal(WC([{ round: 1, picks: [pick("1", 1000, "12000")] }], roster).max_new_active, 1, "taxi");
  t.equal(WC([{ round: 1, picks: [pick("1", 1000, "12002")] }], roster).max_new_active, 1, "IR");
});
test("B2. cap: the bid less the drop's salary; a taxi drop frees no cap (taxi salary isn't on it); a claim that frees cap never counts as worse than winning nothing", () => {
  t.equal(WC([{ round: 1, picks: [pick("1", 4000, "12000")] }], roster).max_cap_added, 4000);
  t.equal(WC([{ round: 1, picks: [pick("1", 4000, "12002")] }], roster).max_cap_added, 1000, "IR salary is on the cap");
  t.equal(WC([{ round: 1, picks: [pick("1", 4000, "10001")] }], roster).max_cap_added, 0, "−$6,000: the worst case is winning nothing");
});
test("B3. the same player chased in two groups is one pickup; a drop an earlier group already used can't land again", () => {
  t.equal(WC([{ round: 1, picks: [pick("1", 1000)] }, { round: 3, picks: [pick("1", 5000)] }], roster).max_new_active, 1);
  t.equal(WC([{ round: 1, picks: [pick("1", 9000, "10001")] }, { round: 2, picks: [pick("2", 9000, "10001")] }], roster).max_cap_added, 0, "−$1,000 then refused");
  t.equal(WC([{ round: 1, picks: [pick("1", 12000, "10001")] }, { round: 2, picks: [pick("2", 12000, "10001")] }], roster).max_cap_added, 2000, "one $12K claim for a $10K player");
});
test("B4. groups are reported in plan order; an empty (withdrawn) group adds nothing", () => {
  const wc = WC([{ round: 2, picks: [] }, { round: 4, picks: [pick("1", 1000)] }], roster);
  t.deepEqual([wc.groups, wc.max_new_active, wc.conditional], [[4], 1, true]);
});

await run("waiver_claim_warnings_one_per_group");
