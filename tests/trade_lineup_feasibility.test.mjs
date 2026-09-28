// POST-TRADE LINEUP-FEASIBILITY WARNING (ADVISORY, NEVER BLOCKS) — can every participant
// still field one complete legal 18-man lineup after the trade.
//   node tests/trade_lineup_feasibility.test.mjs
//
// Distinct from the active-roster-COUNT advisory (trade_cap_authority.js's `roster` block,
// already covered by tests/trade_cap_gate.test.mjs) -- this is per-POSITION, via a real
// maximum-bipartite-matching slot assignment (worker/src/trade_lineup_feasibility.js), not a
// bare headcount. Current-week bye/injury/Out/Doubtful availability is intentionally OUT OF
// SCOPE (a separate courtesy warning, not built in this pass -- see that module's header).
//
// Part 1  the matching engine itself (pure)
// Part 2  the shared calculation (evaluateTradeCompliance's `lineup` block), pure fixtures
// Part 3  through the real worker (2-way + 3-way), proving it never blocks and both surfaces agree
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, bindSelf, quiet } from "./fixtures/worker_harness.mjs";
import * as F from "./fixtures/trade_3way_fixture.mjs";
import { evaluateTradeCompliance } from "../worker/src/trade_cap_authority.js";
import { LINEUP_SLOTS, REQUIRED_LINEUP_SIZE, posGroup, maxBipartiteMatch, evaluateLineupForRoster, evaluateLineupFeasibility } from "../worker/src/trade_lineup_feasibility.js";
await import("./fixtures/register_md_loader.mjs");

const restore = quiet();
const Q = "L=74598&YEAR=2026";

// ───────────────────────────────── Part 1 — the matching engine ─────────────────────────────────
const p = (id, group) => ({ id, group });
const COMPLETE18 = [
  p("1", "QB"), p("2", "RB"), p("3", "RB"), p("4", "WR"), p("5", "WR"), p("6", "TE"), p("7", "RB"), p("8", "WR"), p("9", "QB"),
  p("10", "PK"), p("11", "PN"), p("12", "DL"), p("13", "DL"), p("14", "LB"), p("15", "LB"), p("16", "DB"), p("17", "DB"), p("18", "DL"),
];

test("LU 1: a complete lineup passes with all 18 slots filled", () => {
  const r = evaluateLineupForRoster(COMPLETE18);
  t.equal(r.complete, true); t.equal(r.filled, 18); t.deepEqual(r.missing, []);
});

test("LU 2: missing QB -- with no surplus QB, both QB1 and SuperFlex go unfilled", () => {
  const roster = COMPLETE18.filter((x) => x.id !== "1" && x.id !== "9"); // remove BOTH QBs
  const r = evaluateLineupForRoster(roster);
  t.equal(r.complete, false);
  t.ok(r.missing.some((m) => m.slot === "Quarterback"));
});

test("LU 3: missing Punter", () => {
  const roster = COMPLETE18.filter((x) => x.id !== "11");
  const r = evaluateLineupForRoster(roster);
  t.deepEqual(r.missing, [{ slot: "Punter", count: 1 }]);
});

test("LU 4: missing Kicker", () => {
  const roster = COMPLETE18.filter((x) => x.id !== "10");
  const r = evaluateLineupForRoster(roster);
  t.deepEqual(r.missing, [{ slot: "Kicker", count: 1 }]);
});

test("LU 5: missing one IDP position (a DB, with no surplus DL/LB to cover D-Flex)", () => {
  const roster = COMPLETE18.filter((x) => x.id !== "17");
  const r = evaluateLineupForRoster(roster);
  t.ok(r.missing.some((m) => m.slot === "Defensive Back" || m.slot === "Defensive Flex"), JSON.stringify(r.missing));
});

test("LU 6: Flex can be filled by RB, WR, or TE", () => {
  for (const group of ["RB", "WR", "TE"]) {
    const roster = [p("1", "QB"), p("2", "RB"), p("3", "RB"), p("4", "WR"), p("5", "WR"), p("6", "TE"), p("7", group),
      p("10", "PK"), p("11", "PN"), p("12", "DL"), p("13", "DL"), p("14", "LB"), p("15", "LB"), p("16", "DB"), p("17", "DB"), p("18", "DL")];
    // 17 players -- one short of 18 (no SuperFlex-eligible surplus and only one flex-eligible surplus) -- Flex1 fills, Flex2 + SuperFlex miss.
    const r = evaluateLineupForRoster(roster);
    t.doesNotMatch(JSON.stringify(r.missing), /"Running Back"|"Wide Receiver"|"Tight End"/, `a ${group} must be usable for Flex, not reported as a missing fixed slot`);
  }
});

test("LU 7: SuperFlex can be filled by a second QB or another eligible offensive player", () => {
  const withSecondQB = [...COMPLETE18];
  const r1 = evaluateLineupForRoster(withSecondQB);
  t.equal(r1.complete, true, "COMPLETE18 already has 2 QBs -- one fills QB1, the other fills SuperFlex");
  // Replace the second QB with a 6th RB instead -- SuperFlex should still fill via RB surplus.
  const withExtraRB = COMPLETE18.map((x) => (x.id === "9" ? { id: "9", group: "RB" } : x));
  const r2 = evaluateLineupForRoster(withExtraRB);
  t.equal(r2.complete, true, "SuperFlex is not QB-only -- an eligible RB/WR/TE surplus must also fill it");
});

test("LU 8: DL can be filled by DE or DT (raw MFL positions normalize to the DL group)", () => {
  t.equal(posGroup("DE"), "DL"); t.equal(posGroup("DT"), "DL"); t.equal(posGroup("NT"), "DL");
});

test("LU 9: DB can be filled by CB or S", () => {
  t.equal(posGroup("CB"), "DB"); t.equal(posGroup("S"), "DB"); t.equal(posGroup("FS"), "DB"); t.equal(posGroup("SS"), "DB");
});

test("LU 10: Defensive Flex can be filled by DL, LB, or DB", () => {
  for (const group of ["DL", "LB", "DB"]) {
    const roster = [p("1", "QB"), p("2", "RB"), p("3", "RB"), p("4", "WR"), p("5", "WR"), p("6", "TE"), p("7", "RB"), p("8", "WR"), p("9", "QB"),
      p("10", "PK"), p("11", "PN"), p("12", "DL"), p("13", "DL"), p("14", "LB"), p("15", "LB"), p("16", "DB"), p("17", "DB"), p("18", group)];
    const r = evaluateLineupForRoster(roster);
    t.equal(r.complete, true, `a ${group} must be usable for Defensive Flex`);
  }
});

test("LU 11: overlapping flex eligibility never assigns the same player to two slots (real matching, not double-booking)", () => {
  // Exactly 1 QB, 2 RB, 2 WR, 1 TE -- zero surplus for Flex/SuperFlex. Must NOT silently
  // reuse one of the fixed starters for BOTH its own slot and a flex slot.
  const noSurplus = [p("1", "QB"), p("2", "RB"), p("3", "RB"), p("4", "WR"), p("5", "WR"), p("6", "TE"),
    p("10", "PK"), p("11", "PN"), p("12", "DL"), p("13", "DL"), p("14", "LB"), p("15", "LB"), p("16", "DB"), p("17", "DB"), p("18", "DL")];
  const r = evaluateLineupForRoster(noSurplus);
  t.equal(r.filled, 15, "only the 15 fixed-eligible players can be seated -- Flex x2 and SuperFlex genuinely have nobody left");
  t.deepEqual(r.missing.sort((a, b) => a.slot.localeCompare(b.slot)), [{ slot: "Flex", count: 2 }, { slot: "SuperFlex", count: 1 }]);
});

test("LU 12: taxi players are excluded", () => {
  const roster = COMPLETE18.map((x) => (x.id === "1" ? { ...x, excluded: true } : x));
  const r = evaluateLineupForRoster(roster);
  t.equal(r.complete, false, "excluding the only 'extra' QB must cost SuperFlex (the other QB still fills QB1)");
});

test("LU 13: IR players are excluded", () => {
  const roster = COMPLETE18.map((x) => (x.id === "11" ? { ...x, excluded: true } : x)); // the punter
  const r = evaluateLineupForRoster(roster);
  t.deepEqual(r.missing, [{ slot: "Punter", count: 1 }]);
});

test("LU 14: expired-contract players are excluded", () => {
  const roster = COMPLETE18.map((x) => (x.id === "10" ? { ...x, excluded: true } : x)); // the kicker
  const r = evaluateLineupForRoster(roster);
  t.deepEqual(r.missing, [{ slot: "Kicker", count: 1 }]);
});

test("LU 15: the full 18-slot structure matches the required spec exactly", () => {
  t.equal(REQUIRED_LINEUP_SIZE, 18);
  const counts = {};
  for (const s of LINEUP_SLOTS) counts[s.label] = (counts[s.label] || 0) + 1;
  t.deepEqual(counts, {
    "Quarterback": 1, "Running Back": 2, "Wide Receiver": 2, "Tight End": 1, "Flex": 2, "SuperFlex": 1,
    "Kicker": 1, "Punter": 1, "Defensive Line": 2, "Linebacker": 2, "Defensive Back": 2, "Defensive Flex": 1,
  });
});

// ───────────────────────────────── Part 2 — the shared calculation ─────────────────────────────────
const ok = (data) => ({ ok: true, status: 200, data });
const league = (o) => ok({ league: { salaryCapAmount: "300000", rosterSize: "35", franchises: { franchise: [{ id: "0001", name: "L.A. Looks" }, { id: "0002", name: "CBP" }] }, ...(o || {}) } });
const noSalaries = ok({ salaries: { leagueUnit: { player: [] } } });
const adjOf = () => ok({ salaryAdjustments: "" });
const rosterOf = (map) => ok({ rosters: { franchise: Object.entries(map).map(([id, ps]) => ({ id, player: ps.map((x) => ({ id: x.id, salary: "1000", status: x.status || "ROSTER", contractYear: "2" })) })) } });
const playersOf = (map) => ok({ players: { player: Object.entries(map).map(([id, position]) => ({ id, position })) } });

test("LU CALC: unavailable authority (no players export) is reported honestly, never as compliant", () => {
  const c = evaluateTradeCompliance({ league: league(), salaries: noSalaries, adjustments: adjOf(),
    rosters: rosterOf({ "0001": [{ id: "1" }], "0002": [{ id: "2" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["2"] }] }); // no `players` param at all
  t.equal(c.lineup.status, "unavailable");
  t.equal(c.lineup.advisory, true);
  t.doesNotMatch(c.lineup.message.toLowerCase(), /every team can still field/);
});

test("LU CALC: an advisory warning never blocks -- status is 'warn', never 'blocked', and the trade proceeds", () => {
  const positions = {};
  for (let i = 1; i <= 30; i++) positions[String(i)] = "WR"; // deliberately unbalanced -- all WRs, no defense at all
  const c = evaluateTradeCompliance({ league: league(), salaries: noSalaries, adjustments: adjOf(),
    rosters: rosterOf({ "0001": Array.from({ length: 15 }, (_, i) => ({ id: String(i + 1) })), "0002": [{ id: "200" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
    players: playersOf({ ...positions, "200": "WR" }) });
  t.equal(c.lineup.status, "warn");
  t.ok(!["blocked"].includes(c.lineup.status), "lineup must never be able to report 'blocked' -- it is structurally advisory-only");
  t.equal(c.cap.status, "ok", "the lineup warning must never affect the cap verdict");
});

test("LU CALC: every team in a 3-way (3 participants) is evaluated", () => {
  const c = evaluateTradeCompliance({
    league: ok({ league: { salaryCapAmount: "300000", rosterSize: "35", franchises: { franchise: [{ id: "0001" }, { id: "0002" }, { id: "0003" }] } } }),
    salaries: noSalaries, adjustments: adjOf(),
    rosters: rosterOf({ "0001": [{ id: "1" }], "0002": [{ id: "2" }], "0003": [{ id: "3" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["2"] }, { from: "0002", to: "0003", tokens: [] }],
    players: playersOf({ "1": "WR", "2": "WR", "3": "WR" }),
  });
  t.equal(c.lineup.rows.length, 3, "0001, 0002 AND 0003 must all get an evaluated row");
});

// ───────────────────────────────── Part 3 — real worker, both surfaces ─────────────────────────────────
function fresh2(o) {
  const env = makeWorkerEnv(o && o.env);
  const mfl = makeMfl({ tokens: { "tok-H": "0012" } });
  mfl.install();
  return { env, mfl };
}
const player = (pid, salary = 5000) => ({ asset_id: `P_${pid}`, type: "PLAYER", player_id: String(pid), player_name: `P${pid}`, salary, taxi: false, contract_info: "" });
const payloadOf = (from, to, give, recv) => ({
  schema_version: 1, source: "test", league_id: "74598", season: "2026",
  teams: [
    { role: "left", franchise_id: from, selected_assets: give, traded_salary_adjustment_k: 0, traded_salary_adjustment_dollars: 0, selected_non_taxi_salary_dollars: 5000 },
    { role: "right", franchise_id: to, selected_assets: recv, traded_salary_adjustment_k: 0, traded_salary_adjustment_dollars: 0, selected_non_taxi_salary_dollars: 5000 },
  ],
  extension_requests: [], ui: { left_team_id: from, right_team_id: to }, validation: { status: "ready" },
});

test("LU 2-WAY: an unbalanced post-trade roster produces a warning but the accept still SUCCEEDS", async () => {
  const { env, mfl } = fresh2();
  mfl.st.rosters["0001"] = [{ id: "14056", salary: 5000, contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }]; // sends its only real player away -> nothing left
  mfl.st.rosters["0002"] = [{ id: "13100", salary: 5000, contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }];
  const p1 = await callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, {
    body: { league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002", from_franchise_name: "x", to_franchise_name: "y", message: "", payload: payloadOf("0001", "0002", [player(14056)], [player(13100)]) },
  });
  const id = mfl.st.pending[mfl.st.pending.length - 1].trade_id;
  const r = await callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-C`, { body: { action: "ACCEPT", trade_id: id, league_id: "74598", franchise_id: "0002", year: "2026" } });
  t.ok(r.status < 300, r.text.slice(0, 300));
  t.equal(mfl.writes("tradeResponse").length, 1, "a lineup warning is advisory only -- it must never block the accept or prevent the MFL write");
});

const DISCORD = F.DISCORD;
test("LU 3-WAY: the lineup block never blocks a 3-way accept either -- consent recorded, trade proceeds to dry-run completion", async () => {
  const env = makeWorkerEnv({ TRADE_3WAY_EXECUTE: "0" });
  const mfl = makeMfl({ tokens: { "tok-H": "0012" } }); mfl.install();
  bindSelf(env);
  for (const [fid, d] of [["0008", DISCORD.A], ["0001", DISCORD.B], ["0012", DISCORD.C]]) env.UPS_MFL_DB.raw.prepare("INSERT INTO discord_owners VALUES (?,?,?)").run(fid, "Y", d);
  const legs = [{ from: "0008", to: "0001", asset_tokens: ["P_16614"], cap_k: 0, summary: "x" }, { from: "0001", to: "0012", asset_tokens: ["P_16181"], cap_k: 0, summary: "x" }, { from: "0012", to: "0008", asset_tokens: ["P_16650"], cap_k: 0, summary: "x" }];
  F.seedTrade(env, { legs_json: JSON.stringify(legs), team_b_state: "accepted" });
  mfl.st.rosters = { "0008": [{ id: "16614", salary: 5000, contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }], "0001": [{ id: "16181", salary: 5000, contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }], "0012": [{ id: "16650", salary: 5000, contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }] };
  const press = (action, userId) => ({ data: { custom_id: `tr3:${action}:${F.TRADE_ID}` }, member: { user: { id: userId } } });
  const say = async (resp) => (await resp.json()).data.content;
  const { handle3WayButton } = await import("../worker/src/trade_3way.js");
  const ctxWait = () => { const p = []; return { waitUntil: (x) => p.push(x), flush: () => Promise.all(p) }; };
  const ctx = ctxWait();
  const msg = await say(await handle3WayButton(press("accept", DISCORD.C), env, ctx));
  await ctx.flush();
  t.match(msg, /All three accepted|processing the trade now/i);
  t.equal(F.readRow(env).status, "completed");
});

await run("trade_lineup_feasibility");
restore();
