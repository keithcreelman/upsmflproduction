// War Room roster-maximum and five-active-QB gates (Keith 2026-10-07), on the REAL #1249 and #1247 shapes.
//   node tests/trade_roster_qb_gates.test.mjs
//
// Rules under test:
//   • A War Room trade isn't blocked merely because an arriving, taxi-eligible player lands active, PROVIDED he
//     has a valid taxi destination (eligible now, open taxi spot, game not started) and the count AFTER that move
//     is at most the maximum. Any other move must be made BEFORE acceptance. Both counts are shown.
//   • The cap and the ACTUAL count never credit an unverified taxi move.
//   • At Send and at Accept no team may end up with more than 5 ACTIVE QBs (taxi and IR excluded).
//   • Trades accepted on MFL's own site can't be stopped: the after-trade check notifies with a deadline of
//     24 hours or the team's next player lock, whichever is first.
// Pure functions only (the routes are exercised in tests/trade_roster_qb_routes.test.mjs).
import { t, test, run } from "./fixtures/mini_test.mjs";
import { evaluateTradeCompliance, ACTIVE_QB_MAX, tradeLimitBlockPayload } from "../worker/src/trade_cap_authority.js";
import { evaluateTaxiDestinations } from "../worker/src/trade_taxi_destination.js";
import { planRosterChecks, cureDeadline, rosterCheckMessage } from "../worker/src/trade_roster_check.js";

const ok = (data) => ({ ok: true, data });
const NAMES = { "0003": "Gride", "0006": "The Long Haulers", "0010": "Blake Bombers" };
const league = (o) => ok({ league: { salaryCapAmount: "300000", rosterSize: "30", taxiSquad: "10", franchises: { franchise: Object.entries(NAMES).map(([id, name]) => ({ id, name })) }, ...(o || {}) } });
const adj = ok({ salaryAdjustments: { salaryAdjustment: [] } });
const noSalaries = ok({ salaries: { leagueUnit: { player: [] } } });
const C = { contractYear: "2", contractStatus: "Rookie-Draft", contractInfo: "CL 3|TCV 15K|AAV 5K|Y1-5K, Y2-5K, Y3-5K" };
const P = (id, salary, status, extra) => ({ id, salary: String(salary), status: status || "ROSTER", ...C, ...(extra || {}) });
const fill = (start, n, status, salary) => Array.from({ length: n }, (_, i) => P(String(start + i), salary || 1000, status));
const rostersOf = (by) => ok({ rosters: { franchise: Object.entries(by).map(([id, player]) => ({ id, player })) } });
const players = (pos) => ok({ players: { player: Object.entries(pos).map(([id, [position, name]]) => ({ id, position, name })) } });

// ── #1249 (2026-10-06): Gride 30 active / 4 IR / 8 taxi; Blake Bombers sends Omarion Hampton (active, $13K) and
//    Matthew Golden (Blake's TAXI, $5K) for Gride's 2027 1st + 3rd. Jadarian Price is on NFL IR, still active.
const POS_1249 = { "17044": ["RB", "Hampton, Omarion"], "17075": ["WR", "Golden, Matthew"], "17473": ["RB", "Price, Jadarian"] };
const gride = (priceOnIr) => [
  ...fill(1000, 29), P("17473", 12000, priceOnIr ? "INJURED_RESERVE" : "ROSTER"),
  ...fill(1100, 4, "INJURED_RESERVE"), ...fill(1200, 8, "TAXI_SQUAD", 2000),
];
const blake = () => [P("17044", 13000), P("17075", 5000, "TAXI_SQUAD"), ...fill(2000, 28), ...fill(2100, 1, "INJURED_RESERVE"), ...fill(2200, 8, "TAXI_SQUAD", 2000)];
const MV_1249 = [{ from: "0003", to: "0010", tokens: ["FP_0003_2027_1", "FP_0003_2027_3"] }, { from: "0010", to: "0003", tokens: ["17044", "17075", "FP_0010_2027_4"] }];
const GOLDEN_OK = { "17075": { eligible: true, reason: "", text: "" } };
const c1249 = (o) => evaluateTradeCompliance({ league: league(), salaries: noSalaries, adjustments: adj, players: players(POS_1249), movements: MV_1249,
  rosters: rostersOf({ "0003": gride(o && o.priceOnIr), "0010": blake() }), taxiDestinations: o && "dest" in o ? o.dest : GOLDEN_OK });
const rowOf = (c, fid) => c.roster_limit.rows.find((r) => r.franchise_id === fid);

test("#1249 BEFORE: 30 + Hampton + Golden − Golden-to-taxi = 31 > 30 → refused; both counts shown; Gride must make 1 legal move first", () => {
  const c = c1249();
  const g = rowOf(c, "0003");
  t.equal(g.active_before, 30); t.equal(g.active_after, 32, "actual: MFL lands both on the active roster"); t.equal(g.active_after_taxi, 31, "after Golden's valid taxi move");
  t.equal(JSON.stringify(g.taxi_moves), JSON.stringify([{ player_id: "17075", player_name: "Matthew Golden" }])); t.equal(g.moves_needed, 1);
  t.equal(c.roster_limit.status, "blocked"); t.equal(c.roster_limit.executable, false);
  t.equal(c.roster_limit.violations[0].message,
    "Gride would have 32 active players right after this trade and 31 once Matthew Golden is moved to its taxi squad — the maximum is 30. Gride must first make 1 legal roster move (for example, move an eligible injured player to IR), or the offer must be revised.");
  const cap = c.cap.rows.find((r) => r.franchise_id === "0003");
  t.equal(cap.used_after - cap.used_before, 18000, "the cap carries Hampton's $13K AND Golden's $5K — no credit for an unverified taxi move");
  const blocked = tradeLimitBlockPayload(c.roster_limit, "roster_room_required");
  t.equal(blocked.code, "roster_room_required"); t.equal(blocked.teams[0].active_after_taxi, 31);
});

test("#1249 AFTER Price moves to IR first (29 active): 29 + 2 − Golden = 30 → allowed, no drop; display stays 31 actual until MFL confirms Golden", () => {
  const c = c1249({ priceOnIr: true });
  const g = rowOf(c, "0003");
  t.equal(g.active_before, 29); t.equal(g.active_after, 31); t.equal(g.active_after_taxi, 30); t.equal(g.moves_needed, 0);
  t.equal(c.roster_limit.status, "ok"); t.equal(c.roster_limit.executable, true);
  t.match(c.roster_limit.message, /Until MFL confirms that move, the actual count is what MFL shows/);
  t.equal(c.qb_limit.status, "ok");
});

test("#1249 with Golden NOT creditable: each reason is named and counts him active", () => {
  for (const [dest, re] of [[{}, /his taxi eligibility couldn't be checked/], [{ "17075": { eligible: false, reason: "game_started", text: "his game has already started this week, so MFL won't move him until the week is over" } }, /game has already started/]]) {
    const c = c1249({ priceOnIr: true, dest });
    const g = rowOf(c, "0003");
    t.equal(g.active_after_taxi, 31, "not credited → still 31"); t.equal(c.roster_limit.status, "blocked");
    t.match(c.roster_limit.violations[0].message, re);
  }
  // a full taxi squad is no valid destination either
  const full = evaluateTradeCompliance({ league: league(), salaries: noSalaries, adjustments: adj, players: players(POS_1249), movements: MV_1249, taxiDestinations: GOLDEN_OK,
    rosters: rostersOf({ "0003": [...gride(true).filter((p) => p.status !== "TAXI_SQUAD"), ...fill(1300, 10, "TAXI_SQUAD", 2000)], "0010": blake() }) });
  t.equal(rowOf(full, "0003").active_after_taxi, 31); t.match(full.roster_limit.violations[0].message, /taxi squad would be full \(10 of 10\)/);
  // an unknown taxi limit is not assumed
  const noTaxi = evaluateTradeCompliance({ league: league({ taxiSquad: "" }), salaries: noSalaries, adjustments: adj, players: players(POS_1249), movements: MV_1249, taxiDestinations: GOLDEN_OK,
    rosters: rostersOf({ "0003": gride(true), "0010": blake() }) });
  t.match(noTaxi.roster_limit.violations[0].message, /couldn't read the taxi squad limit/);
});

// ── #1247 (2026-10-06): The Long Haulers 29 active (5 QBs) / 3 IR / 9 taxi get Cam Ward (QB), Chris Godwin and
//    Eli Raridon (Blake's TAXI) for Derrick Henry + $20K.
const POS_1247 = { "17030": ["QB", "Ward, Cam"], "13163": ["WR", "Godwin, Chris"], "17607": ["TE", "Raridon, Eli"], "12626": ["RB", "Henry, Derrick"],
  "9101": ["QB", "Lawrence, Trevor"], "9102": ["QB", "Hurts, Jalen"], "9103": ["QB", "Mendoza, Fernando"], "9104": ["QB", "Lock, Drew"], "9105": ["QB", "Jones, Mac"], "9106": ["QB", "Sanders, Shedeur"] };
const haulers = (lockDropped) => [P("12626", 44000), P("9101", 30000), P("9102", 30000), P("9103", 1000), ...(lockDropped ? [] : [P("9104", 1000)]), P("9105", 1000), ...fill(3000, 23),
  ...fill(3100, 3, "INJURED_RESERVE"), P("9106", 2000, "TAXI_SQUAD"), ...fill(3200, 8, "TAXI_SQUAD", 2000)];
const blake47 = () => [P("17030", 4000), P("13163", 10000), P("17607", 2000, "TAXI_SQUAD"), ...fill(4000, 27), ...fill(4200, 8, "TAXI_SQUAD", 2000)];
const MV_1247 = [{ from: "0006", to: "0010", tokens: ["12626", "BB_20000"] }, { from: "0010", to: "0006", tokens: ["17030", "13163", "17607", "FP_0008_2027_1"] }];
const c1247 = (lockDropped) => evaluateTradeCompliance({ league: league(), salaries: noSalaries, adjustments: adj, players: players(POS_1247), movements: MV_1247,
  rosters: rostersOf({ "0006": haulers(lockDropped), "0010": blake47() }), taxiDestinations: { "17607": { eligible: true, reason: "", text: "" } } });

test("#1247 BEFORE: the Long Haulers would have 6 active QBs → refused (QB move named); the roster fits once Raridon is on taxi (31 → 30)", () => {
  const c = c1247(false);
  const h = rowOf(c, "0006");
  t.equal(h.active_before, 29); t.equal(h.active_after, 31); t.equal(h.active_after_taxi, 30); t.equal(c.roster_limit.status, "ok");
  const q = c.qb_limit.rows.find((r) => r.franchise_id === "0006");
  t.equal(q.active_qbs_before, 5); t.equal(q.active_qbs_after, 6); t.equal(q.active_qbs_after_taxi, 6, "Shedeur Sanders on their taxi squad doesn't count");
  t.equal(c.qb_limit.status, "blocked"); t.equal(c.qb_limit.executable, false);
  t.equal(c.qb_limit.violations[0].message,
    "The Long Haulers would have 6 QBs on the active roster after this trade — the maximum is 5 (taxi and IR QBs don't count). The Long Haulers must first make a legal QB move — move a QB to IR if MFL lists him on IR, move an eligible QB to the taxi squad, or drop one — or the offer must be revised. A move made for this stands whether or not the trade happens.");
  t.equal(tradeLimitBlockPayload(c.qb_limit, "qb_limit_exceeded").teams[0].active_qbs_after_taxi, 6);
  t.equal(c.qb_limit.rows.find((r) => r.franchise_id === "0010").active_qbs_after, 0);
});

test("#1247 AFTER Drew Lock is dropped first: 5 active QBs → allowed; roster 28 + 3 − 1 = 30 actual, 29 once Raridon is on taxi", () => {
  const c = c1247(true);
  const h = rowOf(c, "0006");
  t.equal(h.active_after, 30); t.equal(h.active_after_taxi, 29);
  t.equal(c.qb_limit.status, "ok"); t.equal(c.qb_limit.rows.find((r) => r.franchise_id === "0006").active_qbs_after_taxi, ACTIVE_QB_MAX);
  t.equal(c.roster_limit.status, "ok");
});

test("QB counting: taxi and IR QBs excluded; an arriving taxi QB with a valid destination ends on taxi; no positions → fails CLOSED", () => {
  const pos = { 801: ["QB", "A"], 802: ["QB", "B"], 803: ["QB", "C"], 804: ["QB", "D"], 805: ["QB", "E"], 806: ["QB", "Hurt"], 807: ["QB", "Rookie"], 808: ["WR", "X"] };
  const base = { "0003": [P("801", 1000), P("802", 1000), P("803", 1000), P("804", 1000), P("805", 1000), P("806", 1000, "INJURED_RESERVE"), P("808", 1000)], "0010": [P("807", 1000, "TAXI_SQUAD"), P("809", 1000)] };
  const mv = [{ from: "0010", to: "0003", tokens: ["807"] }, { from: "0003", to: "0010", tokens: ["808"] }];
  const credited = evaluateTradeCompliance({ league: league(), salaries: noSalaries, adjustments: adj, players: players(pos), movements: mv, rosters: rostersOf(base), taxiDestinations: { 807: { eligible: true } } });
  const r = credited.qb_limit.rows.find((x) => x.franchise_id === "0003");
  t.equal(r.active_qbs_before, 5, "the IR QB doesn't count"); t.equal(r.active_qbs_after, 6, "actual: the rookie lands active"); t.equal(r.active_qbs_after_taxi, 5);
  t.equal(credited.qb_limit.status, "ok", "a valid taxi destination means he ends on taxi");
  const notCredited = evaluateTradeCompliance({ league: league(), salaries: noSalaries, adjustments: adj, players: players(pos), movements: mv, rosters: rostersOf(base), taxiDestinations: {} });
  t.equal(notCredited.qb_limit.status, "blocked");
  const noPos = evaluateTradeCompliance({ league: league(), salaries: noSalaries, adjustments: adj, players: { ok: false }, movements: mv, rosters: rostersOf(base), taxiDestinations: {} });
  t.equal(noPos.qb_limit.status, "unavailable"); t.equal(noPos.qb_limit.executable, false);
});

test("the 27 minimum stays a heads-up: never part of the hard gate", () => {
  const c = evaluateTradeCompliance({ league: league(), salaries: noSalaries, adjustments: adj, players: players({}), taxiDestinations: {},
    rosters: rostersOf({ "0003": fill(1, 27), "0010": fill(100, 27) }), movements: [{ from: "0003", to: "0010", tokens: ["1", "2"] }, { from: "0010", to: "0003", tokens: ["100"] }] });
  t.equal(c.roster.status, "warn"); t.match(c.roster.message, /minimum is a heads-up/); t.equal(c.roster_limit.status, "ok"); t.equal(c.roster_limit.executable, true);
});

test("taxi destination eligibility: every condition, and every unreadable source fails CLOSED", () => {
  const base = { season: 2026, nowUnix: 1000, draftPicks: { 17075: { round: 2, year: 2025 } }, callupCounts: { 17075: 1 }, priorSeasonActive: new Set(), kickoffByTeam: { GB: 2000 } };
  const one = (over, arrival) => evaluateTaxiDestinations({ ...base, ...over, arrivals: [{ player_id: "17075", contract_status: "Rookie-Draft", nfl_team: "GB", ...(arrival || {}) }] })["17075"];
  t.equal(one({}).eligible, true, "Golden's real facts: R2.05 2025, 1 call-up, game ahead");
  t.equal(one({ draftPicks: null }).reason, "draft_unreadable");
  t.equal(one({ draftPicks: {} }).reason, "not_drafted");
  t.equal(one({ draftPicks: { 17075: { round: 1, year: 2025 } } }).reason, "round_1");
  t.equal(one({ draftPicks: { 17075: { round: 3, year: 2023 } } }).reason, "graduated");
  t.equal(one({}, { contract_status: "Rookie-Ext1" }).reason, "contract_not_rookie");
  t.equal(one({ callupCounts: null }).reason, "callups_unreadable");
  t.equal(one({ callupCounts: { 17075: 4 } }).reason, "permanently_promoted");
  t.equal(one({ callupCounts: { 17075: 3 } }).eligible, true, "3 used is still temporary");
  t.equal(one({ priorSeasonActive: null }).reason, "prior_season_unreadable");
  t.equal(one({ priorSeasonActive: new Set(["17075"]) }).reason, "finished_season_active");
  t.equal(one({ kickoffByTeam: null }).reason, "schedule_unreadable");
  t.equal(one({ nowUnix: 2000 }).reason, "game_started");
  t.equal(one({}, { nfl_team: "BYE" }).eligible, true, "no game this week = open");
});

test("after-trade check (trades accepted on MFL): over the max and over 5 QBs are found; War Room trades and old trades are skipped", () => {
  const trades = [
    { type: "TRADE", timestamp: "1791320240", franchise: "0003", franchise2: "0010" },          // #1249 time
    { type: "TRADE", timestamp: "1791320211", franchise: "0006", franchise2: "0010" },          // #1247 time — a War Room accept
    { type: "TRADE", timestamp: "1700000000", franchise: "0003", franchise2: "0001" },          // long ago
  ];
  const rosters = { "0003": [...Array.from({ length: 32 }, (_, i) => ({ id: `g${i}`, status: "ROSTER" })), { id: "t", status: "TAXI_SQUAD" }],
    "0010": Array.from({ length: 27 }, (_, i) => ({ id: `b${i}`, status: "ROSTER" })),
    "0006": [...Array.from({ length: 6 }, (_, i) => ({ id: `q${i}`, status: "ROSTER" })), ...Array.from({ length: 25 }, (_, i) => ({ id: `h${i}`, status: "ROSTER" }))] };
  const positions = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`q${i}`, "QB"]));
  const f = planRosterChecks({ trades, rosters, rosterMax: 30, positions, sinceUnix: 1791000000, nowUnix: 1791325000,
    warRoom: [{ participants: "0006,0010", mfl_executed_at_unix: 1791320211 }] });
  t.equal(JSON.stringify(f.map((x) => [x.franchise_id, x.kind, x.active])), JSON.stringify([["0003", "roster", 32]]));
  const qb = planRosterChecks({ trades: [trades[1]], rosters, rosterMax: 30, positions, sinceUnix: 0, nowUnix: 1791325000, warRoom: [] });
  t.equal(JSON.stringify(qb.map((x) => [x.franchise_id, x.kind, x.active, x.active_qbs])), JSON.stringify([["0006", "roster", 31, 6], ["0006", "qb", 31, 6]]));
});

test("cure deadline = 24 hours after the trade or the team's next player lock, whichever comes first", () => {
  const trade = 1791320240;   // Tue 2026-10-06 4:57 PM ET
  t.equal(JSON.stringify(cureDeadline({ tradeTs: trade, nflTeams: ["LAC", "CIN"], kickoffs: [{ LAC: trade + 2 * 86400, CIN: trade + 3 * 86400 }], nowUnix: trade })), JSON.stringify({ deadline_unix: trade + 86400, basis: "24h" }));
  t.equal(JSON.stringify(cureDeadline({ tradeTs: trade, nflTeams: ["LAC"], kickoffs: [{ LAC: trade + 3600 }], nowUnix: trade })), JSON.stringify({ deadline_unix: trade + 3600, basis: "next_lock" }));
  t.equal(cureDeadline({ tradeTs: trade, nflTeams: ["LAC"], kickoffs: [{ LAC: trade - 60 }, { LAC: trade + 7200 }], nowUnix: trade }).deadline_unix, trade + 7200, "this week's games are over → next week's first lock");
  t.equal(cureDeadline({ tradeTs: trade, nflTeams: ["LAC"], kickoffs: [{}, {}], nowUnix: trade }).basis, "24h_schedule_unread");
});

test("the after-trade DM: actual counts, the required move, the deadline, and no automatic penalty", () => {
  const msg = rosterCheckMessage({ finding: { kind: "roster", franchise_id: "0003", other_id: "0010", active: 32, max: 30 }, teamName: "Gride", otherName: "Blake Bombers",
    tradeWhenEt: "Tue, Oct 6, 4:57 PM ET", deadlineEt: "Wed, Oct 7, 4:57 PM ET", basis: "24h" });
  t.equal(msg, "⚠️ Roster check after your trade with Blake Bombers (accepted on MFL Tue, Oct 6, 4:57 PM ET): Gride has 32 active players — the maximum is 30. Make 2 legal moves to get back to 30: an eligible player to IR or the taxi squad, or a drop. Do it by Wed, Oct 7, 4:57 PM ET (24 hours after the trade — whichever of the two comes first). If MFL won't let you make the move, tell the commissioner. Nothing will be dropped, voided or penalized automatically.");
  const q = rosterCheckMessage({ finding: { kind: "qb", franchise_id: "0006", other_id: "0010", active_qbs: 6 }, teamName: "The Long Haulers", otherName: "Blake Bombers", tradeWhenEt: "x", deadlineEt: "y", basis: "next_lock" });
  t.match(q, /The Long Haulers has 6 QBs on the active roster — the maximum is 5 \(taxi and IR QBs don't count\)/); t.match(q, /before your next player locks/);
});

await run("trade_roster_qb_gates");
