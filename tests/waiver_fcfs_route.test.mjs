// POST /api/waivers/fcfs — the REAL worker route at the window and kickoff boundaries.
//   node tests/waiver_fcfs_route.test.mjs
//
// The route decides, fresh against MFL, (1) whether the league is in its FCFS
// window and (2) whether the player's own game has kicked off. Every network
// edge is faked here: a fake MFL answers ONLY the reads this route makes before
// its gates (owner sign-in, the league calendar with its real 2026 recurring
// rows, liveScoring, nflSchedule, the player's team). Every other call — the
// roster read, MFL's add import — is recorded and answered 503 by the FAKE MFL,
// so nothing is ever acquired: an allowed add is proved by the route reaching
// the (fake) MFL add, a refused one by it never getting there. The rehearsal
// league (25625) is used because its write gate is armed without a production
// flag.
import { makeD1 } from "./fixtures/d1_sqlite.mjs";
import { t, test, run } from "./fixtures/mini_test.mjs";
await import("./fixtures/register_md_loader.mjs");
const worker = (await import("../worker/src/index.js")).default;

const et = (iso) => Date.parse(iso);
const LEAGUE = "25625";
const RAW_2026 = [
  ["WAIVER_NONE", 1784779200, 1785902400, 0], ["WAIVER_LOCK", 1785902400, null, 0], ["WAIVER_LOCK", 1786021200, null, 22],
  ["WAIVER_LOCK", 1786107600, null, 22], ["WAIVER_BBID", 1786107600, null, 22], ["WAIVER_LOCK", 1786194000, null, 22],
  ["WAIVER_BBID", 1786194000, null, 22], ["WAIVER_LOCK", 1786280400, null, 4], ["WAIVER_BBID", 1786280400, null, 22],
  ["WAIVER_BBID", 1786626000, null, 21], ["WAIVER_LOCK", 1789434000, null, 17], ["WAIVER_NONE", 1799114400, null, 0],
].map(([type, s, e, h]) => ({ type, start_time: String(s), end_time: e ? String(e) : "", happens: h ? String(h) : "", title: "", id: "x" }));
// MFL nflSchedule per week: Week 1 opener (Week-1 rule), Week 4 (London IND@WAS 9:30 AM, TBB 1:00 PM,
// PIT@CLE Thursday), Week 8 = the DST Sunday (TBB 1:00 PM EST), last game Monday night.
const SCHED = {
  1: [["DAL", "PHI", "2026-09-09T20:20:00-04:00"]],
  4: [["PIT", "CLE", "2026-10-01T20:15:00-04:00"], ["IND", "WAS", "2026-10-04T09:30:00-04:00"], ["TBB", "GBP", "2026-10-04T13:00:00-04:00"], ["NYG", "DAL", "2026-10-05T20:15:00-04:00"]],
  8: [["TBB", "IND", "2026-11-01T13:00:00-05:00"], ["NYG", "DAL", "2026-11-02T20:15:00-05:00"]],
};
const TEAMS = { "9001": "IND", "9002": "TBB", "9003": "PIT", "9004": "KCC" };

let NOW = 0;
const realNow = Date.now;
const calls = [];
const json = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  const type = u.searchParams.get("TYPE") || "";
  calls.push(u.pathname + (type ? " " + type : ""));
  if (type === "myleagues") return json({ leagues: { league: [{ league_id: LEAGUE, franchise_id: "0008", name: "UPS" }, { league_id: "74598", franchise_id: "0008", name: "UPS" }] } });
  if (type === "calendar") return json({ calendar: { event: RAW_2026 } });
  if (type === "liveScoring") {
    const week = NOW >= et("2026-10-26T00:00:00-04:00") ? 8 : 4;
    return json({ liveScoring: { week: String(week), matchup: [] } });
  }
  if (type === "nflSchedule") {
    const w = parseInt(u.searchParams.get("W"), 10);
    return json({ nflSchedule: { week: String(w), matchup: (SCHED[w] || []).map(([a, b, k]) => ({ kickoff: String(Math.floor(et(k) / 1000)), team: [{ id: a }, { id: b }] })) } });
  }
  if (type === "players") {
    const ids = String(u.searchParams.get("P") || "").split(",");
    return json({ players: { player: ids.filter((id) => TEAMS[id]).map((id) => ({ id, name: "Test, " + id, position: "WR", team: TEAMS[id] })) } });
  }
  return json({ error: { $t: "test: no such call" } }, 503);   // rosters, imports, everything else
};

const env = { UPS_MFL_DB: makeD1({}), COMMISH_API_KEY: "admin", MFL_COOKIE: "COMMISH", MFL_APIKEY: "k" };
async function addAt(iso, pid) {
  NOW = et(iso);
  Date.now = () => NOW;
  calls.length = 0;
  try {
    const req = new Request(`https://w.test/api/waivers/fcfs?L=${LEAGUE}&YEAR=2026&MFL_USER_ID=tok-owner`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ add_pid: pid }),
    });
    const res = await worker.fetch(req, env, { waitUntil() {}, passThroughOnException() {} });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, error: body.error || "", message: body.message || "", calls: calls.slice() };
  } finally { Date.now = realNow; }
}
// Allowed = the route went past both gates all the way to MFL's add import (the fake answers it 503).
const reachedAdd = (r) => r.calls.some((c) => /\/import\b/.test(c));
const passedGates = (r) => r.error !== "not_fcfs_window" && r.error !== "player_locked" && reachedAdd(r);

test("window opening: 1s before the Sunday 9:00 AM ET run → refused; 1s after → past the gates", async () => {
  const before = await addAt("2026-10-04T08:59:59-04:00", "9002");
  t.equal(before.status, 409); t.equal(before.error, "not_fcfs_window");
  t.ok(!reachedAdd(before), "refused: never reaches MFL's add");
  const after = await addAt("2026-10-04T09:00:01-04:00", "9002");
  t.ok(passedGates(after), `09:00:01 — FCFS open, TBB plays at 1:00 PM → the route goes on to MFL's add (fake: ${after.calls.filter((c) => /import/.test(c)).join()})`);
});

test("re-lock: 1s before Monday 9:00 PM ET → past the gates; at 9:00 PM → refused", async () => {
  const before = await addAt("2026-10-05T20:59:59-04:00", "9004");
  t.ok(passedGates(before), "20:59:59 — a player with no game this week is still addable");
  const after = await addAt("2026-10-05T21:00:00-04:00", "9004");
  t.equal(after.status, 409); t.equal(after.error, "not_fcfs_window", "21:00:00 — waivers have re-locked");
});

test("player kickoff inside the window: 1s before → past the gates; at kickoff → 409 player_locked", async () => {
  const before = await addAt("2026-10-04T09:29:59-04:00", "9001");
  t.ok(passedGates(before), "London game: IND player at 09:29:59");
  const at = await addAt("2026-10-04T09:30:00-04:00", "9001");
  t.equal(at.status, 409); t.equal(at.error, "player_locked", "IND player at kickoff");
  t.match(at.message, /goes back on waivers at Mon Oct 5, 9:00 PM ET/, "says when he can be bid on");
  t.ok(!reachedAdd(at), "refused: never reaches MFL's add");
  const tnf = await addAt("2026-10-04T10:00:00-04:00", "9003");
  t.equal(tnf.error, "player_locked", "Thursday-night PIT player is locked on Sunday");
});

test("daylight saving: Sun Nov 1 opens at 9:00 EST (14:00 UTC), not 9:00 EDT", async () => {
  const early = await addAt("2026-11-01T08:30:00-05:00", "9002");       // 13:30 UTC — after the old 9:00 EDT instant
  t.equal(early.error, "not_fcfs_window", "08:30 EST is still locked");
  const open = await addAt("2026-11-01T09:00:01-05:00", "9002");
  t.ok(passedGates(open), "09:00:01 EST — open");
  const relock = await addAt("2026-11-02T21:00:00-05:00", "9004");
  t.equal(relock.error, "not_fcfs_window", "Mon Nov 2 21:00 EST — re-locked");
});

test("every call went to the fake MFL — the only adds attempted were inside the window, for unlocked players", async () => {
  const cases = [["2026-10-04T08:59:59-04:00", "9002", false], ["2026-10-04T09:30:00-04:00", "9001", false],
    ["2026-10-05T21:00:00-04:00", "9004", false], ["2026-10-04T09:00:01-04:00", "9002", true]];
  for (const [iso, pid, allowed] of cases) {
    const r = await addAt(iso, pid);
    t.equal(reachedAdd(r), allowed, `${iso} player ${pid}: ${allowed ? "add attempted (fake MFL)" : "no add attempted"}`);
  }
});

async function bidAt(iso, rounds) {
  NOW = et(iso);
  Date.now = () => NOW;
  calls.length = 0;
  try {
    const req = new Request(`https://w.test/api/waivers/bbid-plan?L=${LEAGUE}&YEAR=2026&MFL_USER_ID=tok-owner`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rounds }),
    });
    const res = await worker.fetch(req, env, { waitUntil() {}, passThroughOnException() {} });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, error: body.error || "", message: body.message || "", calls: calls.slice() };
  } finally { Date.now = realNow; }
}
const addClaim = [{ round: 1, picks: [{ add_pid: "9002", bid_dollars: 1000 }] }];

test("bids while transactions are closed are refused (matches the 'Locked' label); withdrawals never are", async () => {
  const shut = await bidAt("2027-01-05T12:00:00-05:00", addClaim);
  t.equal(shut.status, 409); t.equal(shut.error, "transactions_closed", "after the season shut-off");
  t.match(shut.message, /season's add\/drop window has closed/);
  t.ok(!shut.calls.some((c) => / league$/.test(c)), "refused before any league/limits read");
  const auction = await bidAt("2026-07-30T12:00:00-04:00", addClaim);
  t.equal(auction.error, "transactions_closed", "during the FA Auction blackout");
  const clearOnly = await bidAt("2027-01-05T12:00:00-05:00", [{ round: 1, picks: [] }]);
  t.ok(clearOnly.error !== "transactions_closed", "a pure withdrawal is not blocked");
  const tuesday = await bidAt("2026-10-06T12:00:00-04:00", addClaim);
  t.ok(tuesday.error !== "transactions_closed" && tuesday.calls.some((c) => / league$/.test(c)), "a normal waiver period: the bid goes on through the route");
});

await run("waiver_fcfs_route");
