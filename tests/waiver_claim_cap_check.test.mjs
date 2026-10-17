// The waiver-claim cap heads-up uses MFL's own cap arithmetic — or says UPS could not verify it (Keith 2026-10-17).
//   node tests/waiver_claim_cap_check.test.mjs
//
// A submitted claim read "you'd be roughly $2,000 over the $300,000 cap" while MFL showed about $6,000 of room. The
// heads-up counted every active AND IR salary at 100% and left out MFL's salary adjustments. MFL counts:
//   active salaries + includeIRWithSalary% of IR salaries + salary adjustments (taxi is off the cap).
// The numbers below are made up; they have the report's shape (IR on the roster, dead money in adjustments).
// Part A drives the REAL /api/waivers/bbid-plan route in dry_run (nothing is sent to MFL); part B checks each rule.
import fs from "node:fs";
import { makeD1 } from "./fixtures/d1_sqlite.mjs";
import { t, test, run } from "./fixtures/mini_test.mjs";
await import("./fixtures/register_md_loader.mjs");
const worker = (await import("../worker/src/index.js")).default;

const LEAGUE = "25625";   // the rehearsal league; dry_run writes nothing anyway
const RAW_2026 = [
  ["WAIVER_NONE", 1784779200, 1785902400, 0], ["WAIVER_LOCK", 1785902400, null, 0], ["WAIVER_LOCK", 1786021200, null, 22],
  ["WAIVER_LOCK", 1786107600, null, 22], ["WAIVER_BBID", 1786107600, null, 22], ["WAIVER_LOCK", 1786194000, null, 22],
  ["WAIVER_BBID", 1786194000, null, 22], ["WAIVER_LOCK", 1786280400, null, 4], ["WAIVER_BBID", 1786280400, null, 22],
  ["WAIVER_BBID", 1786626000, null, 21], ["WAIVER_LOCK", 1789434000, null, 17], ["WAIVER_NONE", 1799114400, null, 0],
].map(([type, s, e, h]) => ({ type, start_time: String(s), end_time: e ? String(e) : "", happens: h ? String(h) : "", title: "", id: "x" }));

// The team under test (0008): 27 active players, 2 on IR, 1 on taxi; MFL salary adjustments per scenario.
const S = { active: [], ir: [], taxi: [], adjustments: [], adjustmentsDown: false, irPercent: "50" };
const roster = () => [
  ...S.active.map((sal, i) => ({ id: String(10000 + i), status: "ROSTER", salary: String(sal) })),
  ...S.ir.map((sal, i) => ({ id: String(11000 + i), status: "INJURED_RESERVE", salary: String(sal) })),
  ...S.taxi.map((sal, i) => ({ id: String(12000 + i), status: "TAXI_SQUAD", salary: String(sal) })),
];
const IMPORTS = [];
const json = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  if (/\/import$/.test(u.pathname)) { IMPORTS.push(u.search); return json({ error: "test: no MFL write" }, 503); }
  const type = u.searchParams.get("TYPE") || "";
  if (type === "myleagues") return json({ leagues: { league: [{ league_id: LEAGUE, franchise_id: "0008", name: "UPS" }] } });
  if (type === "calendar") return json({ calendar: { event: RAW_2026 } });
  if (type === "league") return json({ league: { id: LEAGUE, rosterSize: "30", salaryCapAmount: "300000", bbidMinimum: "1000", bbidIncrement: "1000",
    maxWaiverRounds: "8", bbidConditional: "Yes", currentWaiverType: "BBID_FCFS", ...(S.irPercent == null ? {} : { includeIRWithSalary: S.irPercent }),
    franchises: { franchise: [{ id: "0008", name: "Team Eight" }] } } });
  if (type === "rosters") return json({ rosters: { franchise: [{ id: "0008", player: roster() }] } });
  if (type === "salaryAdjustments") return S.adjustmentsDown ? json({ error: "MFL down" }, 503)
    : json({ salaryAdjustments: { salaryAdjustment: S.adjustments.map((amount, i) => ({ id: String(i), franchise_id: "0008", amount: String(amount), description: "x" })) } });
  if (type === "liveScoring") return json({ liveScoring: { week: "6", matchup: [] } });
  if (type === "nflSchedule") return json({ nflSchedule: { week: u.searchParams.get("W"), matchup: [] } });
  return json({ error: { $t: "test: no such call" } }, 503);
};
// FA_AUCTION_START_AT: a drop after the FA Auction opened books its dead money to NEXT season (canon §6), so this season's room
// is checkable; without it the check says "unverified" (see B4).
const env = { UPS_MFL_DB: makeD1({}), COMMISH_API_KEY: "admin", MFL_COOKIE: "COMMISH", MFL_APIKEY: "k",
  FA_AUCTION_START_AT: String(Math.floor(Date.parse("2026-07-25T12:00:00-04:00") / 1000)) };
const realNow = Date.now;
async function submit(rounds) {
  const NOW = Date.parse("2026-10-14T12:00:00-04:00");
  Date.now = () => NOW;
  try {
    const res = await worker.fetch(new Request(`https://w.test/api/waivers/bbid-plan?L=${LEAGUE}&YEAR=2026&MFL_USER_ID=tok-owner`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rounds, dry_run: true }),
    }), env, { waitUntil() {}, passThroughOnException() {} });
    const text = await res.text();
    let body = {}; try { body = JSON.parse(text); } catch (_) {}
    return { status: res.status, body, text, warn: Object.fromEntries((body.warnings || []).map((w) => [w.code, w.message])) };
  } finally { Date.now = realNow; }
}
const claim = (bid, drop) => [{ round: 1, picks: [{ add_pid: "20001", bid_dollars: bid, ...(drop ? { drop_pid: drop } : {}) }] }];
const setTeam = (active, ir, adjustments) => {
  S.active = Array.from({ length: 27 }, (_, i) => (i === 0 ? active - 26 * 10000 : 10000));
  S.ir = ir; S.taxi = [4000]; S.adjustments = adjustments; S.adjustmentsDown = false; S.irPercent = "50";
};

// ═════════ A. the real route ═════════
test("A1. the report's shape — IR on the roster, dead money in adjustments: MFL has room, so NO over-cap heads-up (it used to say over)", async () => {
  setTeam(270000, [14000, 16000], [5000, 3000]);          // MFL: 270,000 + 15,000 + 8,000 = 293,000 → $7,000 room
  const r = await submit(claim(3000));
  t.equal(r.status, 200, r.text.slice(0, 300));
  t.equal(r.warn.CAP_ROOM, undefined, "after the claim: $4,000 left");
  t.equal(r.warn.CAP_UNVERIFIED, undefined);
  t.deepEqual([r.body.cap_check.used_now, r.body.cap_check.room_now, r.body.cap_check.worst_room], [293000, 7000, 4000]);
  t.deepEqual(IMPORTS, [], "dry run: nothing sent to MFL");
});
test("A2. dead money leaves no room: under the hard cap MFL won't award the claim, and the note says so with MFL's room now", async () => {
  setTeam(288000, [], [12000]);                           // MFL: 300,000 used → $0 room
  const r = await submit(claim(2000));
  t.equal(r.warn.CAP_ROOM, "MFL won't award your $2,000 claim in group 1 under the hard cap: it needs about $2,000 more cap room than you have. "
    + "MFL cap room now: $0 (salary adjustments included).");
});
test("A2b. the dropped player's salary counts: a $5,000 claim that drops a $2,000 player costs $3,000 — with $1,000 of room MFL won't award it", async () => {
  setTeam(287000, [], [12000]);                           // MFL: 299,000 used → $1,000 room
  S.active[1] = 8000; S.active.push(2000);                // the same total, with a $2,000 player to drop (pid 10027)
  const r = await submit(claim(5000, "10027"));
  t.equal(r.warn.CAP_ROOM, "MFL won't award your $5,000 claim in group 1 under the hard cap: after its drop frees $2,000, it needs about $2,000 more cap room than you have. "
    + "MFL cap room now: $1,000 (salary adjustments included).");
  const ok = await submit(claim(3000, "10027"));           // $3,000 − $2,000 = $1,000: fits exactly
  t.equal(ok.warn.CAP_ROOM, undefined);
});
test("A2c. claims that each fit can't all win: one note that MFL won't award the one that no longer fits", async () => {
  setTeam(296000, [], []);                                // $4,000 room
  const r = await submit([{ round: 1, picks: [{ add_pid: "20001", bid_dollars: 3000 }] }, { round: 2, picks: [{ add_pid: "20002", bid_dollars: 2000 }] }]);
  t.equal(r.warn.CAP_ROOM, "Your claims fit one at a time, but one in each of your 2 groups would need about $1,000 more cap room than you have — MFL won't award a claim that no longer fits when its turn comes. "
    + "MFL cap room now: $4,000 (salary adjustments included).");
});
test("A3. MFL's salary adjustments unreadable: no number at all — UPS says it couldn't verify (never treats the adjustments as $0)", async () => {
  setTeam(288000, [], [12000]); S.adjustmentsDown = true;
  const r = await submit(claim(2000));
  t.equal(r.warn.CAP_ROOM, undefined);
  t.equal(r.warn.CAP_UNVERIFIED, "UPS couldn't independently verify your post-award cap space because MFL salary adjustments are not included. MFL will enforce the cap when waivers process.");
  t.equal(r.body.cap_check.verified, false);
});

// ═════════ B. the rules ═════════
const SRC = fs.readFileSync(new URL("../worker/src/index.js", import.meta.url), "utf8");
const cut = (start, end) => { const i = SRC.indexOf(start); if (i < 0) throw new Error("not found: " + start); return SRC.slice(i, SRC.indexOf(end, i)); };
const code = cut("function _waiverClaimWorstCase(", "\n}\n") + "\n}\n" + cut("function _mflSalaryAdjustmentsTotal(", "// ── Waiver-claim CAP advisory") + cut("function _waiverCapCheck(", "\n}\n") + "\n}\n";
const { _waiverCapCheck: CC, _mflSalaryAdjustmentsTotal: ADJ } = new Function(code + "\nreturn { _waiverCapCheck, _mflSalaryAdjustmentsTotal };")();
// a roster: { pid: [status, salary] }
const R = (rows) => ({ ok: true, by_pid: new Map(Object.entries(rows).map(([pid, [st, sal]]) => [pid, { salary: sal, taxi: st === "TAXI", ir: st === "IR" }])) });
const base = (o) => CC({ capDollars: 300000, irPercent: 50, adjustmentsTotal: 0, conditional: true, anyDrop: false, dropPenaltyHitsThisSeason: false, ...o });
const group = (round, ...picks) => ({ round, picks: picks.map(([bid, drop], i) => ({ add_pid: `${round}${i}`, bid_dollars: bid, drop_pid: drop || null })) });

test("B1. positive and negative salary adjustments: dead money uses room, a credit gives it back", () => {
  const roster = R({ a: ["ACTIVE", 290000] });
  t.deepEqual([base({ roster, adjustmentsTotal: 12000, plan: [group(1, [1000])] }).worst_room], [-3000]);
  t.deepEqual([base({ roster, adjustmentsTotal: -15000, plan: [group(1, [1000])] }).worst_room], [24000]);
});
test("B2. IR counts at MFL's share (50%); taxi is off the cap", () => {
  const c = base({ roster: R({ a: ["ACTIVE", 280000], i: ["IR", 20000], x: ["TAXI", 9000] }), plan: [group(1, [1000])] });
  t.deepEqual([c.used_now, c.room_now, c.ir_percent], [290000, 10000, 50]);
});
test("B3. a conditional drop frees what MFL counts for him: active in full, IR at 50%, taxi nothing", () => {
  const roster = R({ a: ["ACTIVE", 296000], d: ["ACTIVE", 4000], i: ["IR", 10000], x: ["TAXI", 3000] });   // used 305,000
  t.equal(base({ roster, anyDrop: true, plan: [group(1, [5000, "d"])] }).worst_added, 1000);
  t.equal(base({ roster, anyDrop: true, plan: [group(1, [6000, "i"])] }).worst_added, 1000, "$6,000 − half of $10,000");
  t.equal(base({ roster, anyDrop: true, plan: [group(1, [2000, "x"])] }).worst_added, 2000);
});
test("B4. a drop's dead money: next season's cap after the FA Auction (room unchanged); this season or unknown → not verified", () => {
  const roster = R({ a: ["ACTIVE", 290000], d: ["ACTIVE", 6000] });
  t.equal(base({ roster, anyDrop: true, dropPenaltyHitsThisSeason: false, plan: [group(1, [1000, "d"])] }).verified, true);
  t.deepEqual(base({ roster, anyDrop: true, dropPenaltyHitsThisSeason: true, plan: [group(1, [1000, "d"])] }), { verified: false, reason: "a dropped player's dead money for this season isn't included" });
  t.equal(base({ roster, anyDrop: true, dropPenaltyHitsThisSeason: null, plan: [group(1, [1000, "d"])] }).verified, false);
});
test("B5. mutually exclusive claims in one group: the costliest one; separate groups: they can all win", () => {
  const roster = R({ a: ["ACTIVE", 290000] });
  t.equal(base({ roster, plan: [group(1, [1000], [3000], [2000])] }).worst_added, 3000);
  t.equal(base({ roster, plan: [group(1, [1000], [3000]), group(2, [2000])] }).worst_added, 5000);
});
test("B6. exactly $0 left is not over; a claim that truly exceeds the cap is", () => {
  const roster = R({ a: ["ACTIVE", 297000] });
  t.equal(base({ roster, plan: [group(1, [3000])] }).worst_room, 0);
  t.equal(base({ roster, plan: [group(1, [4000])] }).worst_room, -1000);
});
test("B7. never a guess: unreadable roster, adjustments or cap, or IR's share unknown with IR on the roster → not verified, with the reason", () => {
  const plan = [group(1, [1000])];
  t.deepEqual(base({ roster: { ok: false }, plan }), { verified: false, reason: "your roster couldn't be read from MFL" });
  t.deepEqual(base({ roster: R({ a: ["ACTIVE", 1] }), adjustmentsTotal: null, plan }), { verified: false, reason: "MFL salary adjustments are not included" });
  t.deepEqual(base({ roster: R({ a: ["ACTIVE", 1] }), capDollars: 0, plan }), { verified: false, reason: "MFL didn't report the salary cap" });
  t.deepEqual(base({ roster: R({ i: ["IR", 5000] }), irPercent: null, plan }), { verified: false, reason: "MFL didn't report how much of an IR salary counts against the cap" });
  t.equal(base({ roster: R({ a: ["ACTIVE", 5000] }), irPercent: null, plan }).verified, true, "no IR on the roster: its share doesn't matter");
});
test("B8. MFL's adjustments export: the team's total, $0 only when MFL lists none for it, null when it can't be read", () => {
  const exp = { salaryAdjustments: { salaryAdjustment: [{ franchise_id: "0008", amount: "5000" }, { franchise_id: "0008", amount: "-2000" }, { franchise_id: "0003", amount: "9000" }] } };
  t.equal(ADJ(exp, "0008"), 3000);
  t.equal(ADJ({ salaryAdjustments: {} }, "0008"), 0);
  t.equal(ADJ(null, "0008"), null);
  t.equal(ADJ({ error: "x" }, "0008"), null);
  t.equal(ADJ({ salaryAdjustments: { salaryAdjustment: [{ franchise_id: "0008", amount: "n/a" }] } }, "0008"), null);
});
test("B9. the old basis vs MFL's: the same team, $3,000 'over' before, $4,000 left now — the difference is IR at 100% and the missing adjustments", () => {
  const roster = R({ a: ["ACTIVE", 270000], i1: ["IR", 14000], i2: ["IR", 16000] });
  const c = base({ roster, adjustmentsTotal: 8000, plan: [group(1, [3000])] });
  const oldUsed = 270000 + 14000 + 16000;                  // what the heads-up used: active + IR in full, no adjustments
  t.equal(300000 - oldUsed - 3000, -3000);
  t.deepEqual([c.used_now, c.worst_room], [293000, 4000]);
  t.equal(oldUsed - c.used_now, 15000 - 8000, "IR overcounted by $15,000, adjustments missing $8,000");
});

await run("waiver_claim_cap_check");
