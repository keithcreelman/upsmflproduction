// LOADED-CONTRACT LIMIT (HARD BLOCK) — canon §2.G/§6.G: max 5 loaded (front + back combined)
// contracts per roster after a trade.   node tests/trade_loaded_contracts.test.mjs
//
// RULING (2026-09-28): a trade must not execute if the authoritative post-trade calculation
// PROVES a participating franchise would end up with more than 5 loaded contracts. Fails
// closed on unreadable authority. No owner or commissioner override. Same shared calculation
// (worker/src/trade_cap_authority.js's evaluateTradeCompliance) as the salary cap, enforced
// at the identical set of points (2-way accept/preview, 3-way accept/execute/recheck).
//
// Part 1  the calculation itself (pure): every input that can move the loaded-contract count
// Part 2  two-team accept through the real worker
// Part 3  three-team gates (Discord accept + execute + recheck) through the real worker
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, bindSelf, quiet } from "./fixtures/worker_harness.mjs";
import * as F from "./fixtures/trade_3way_fixture.mjs";
import { evaluateTradeCompliance } from "../worker/src/trade_cap_authority.js";
import { classifyLoaded, isLoaded } from "../worker/src/contract_classification.js";
await import("./fixtures/register_md_loader.mjs");
const { handle3WayButton, execute3Way } = await import("../worker/src/trade_3way.js");
const { makeLedger } = await import("../worker/src/trade_execution.js");

const restore = quiet();
const Q = "L=74598&YEAR=2026";
const CAP = 300000;

// ───────────────────────────────── Part 1 — the pure calculation ─────────────────────────────────
const ok = (data) => ({ ok: true, status: 200, data });
const league = (o) => ok({ league: { salaryCapAmount: String(CAP), rosterSize: "35", franchises: { franchise: [{ id: "0001", name: "L.A. Looks" }, { id: "0002", name: "CBP" }, { id: "0003", name: "Gride" }] }, ...(o || {}) } });
const rosterOf = (map) => ok({ rosters: { franchise: Object.entries(map).map(([id, ps]) => ({ id, player: ps.map((p) => ({ id: p.id, salary: p.salary == null ? "1000" : String(p.salary), status: p.status || "ROSTER", contractYear: String(p.contractYear ?? 2), ...(p.contractStatus ? { contractStatus: p.contractStatus } : {}) })) })) } });
const adjOf = (rows) => ok({ salaryAdjustments: rows === undefined ? "" : { salaryAdjustment: rows } });
const noSalaries = ok({ salaries: { leagueUnit: { player: [] } } });
const calc = (o) => evaluateTradeCompliance({ league: league(), salaries: noSalaries, adjustments: adjOf([]), ...o });

// N loaded (BL) contracts for one franchise, ids starting at `from`.
const loadedIds = (from, count, cs = "Vet-Ext2-BL") => Array.from({ length: count }, (_, i) => ({ id: String(from + i), contractStatus: cs }));

test("LC 1: exactly 4 -> 5 loaded contracts passes", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractStatus: "Vet-FAA-FL" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(c.loaded_contracts.status, "ok");
  t.equal(c.loaded_contracts.rows.find((r) => r.franchise_id === "0001").loaded_after, 5);
});

test("LC 2: 5 -> 6 blocks", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 5), "0002": [{ id: "200", contractStatus: "Vet-FAA-FL" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(c.loaded_contracts.status, "blocked");
  t.equal(c.loaded_contracts.violations.length, 1);
  t.equal(c.loaded_contracts.violations[0].franchise_id, "0001");
  t.match(c.loaded_contracts.violations[0].message, /L\.A\. Looks would move from 5 to 6 loaded contracts\. The maximum is 5\./);
});

test("LC 3: sending and receiving one loaded contract stays at 5 and passes", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 5), "0002": [{ id: "200", contractStatus: "Vet-FAA-FL" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }, { from: "0001", to: "0002", tokens: ["100"] }],
  });
  t.equal(c.loaded_contracts.status, "ok");
  const r1 = c.loaded_contracts.rows.find((r) => r.franchise_id === "0001");
  t.equal(r1.loaded_before, 5); t.equal(r1.loaded_after, 5);
});

test("LC 4: sending two loaded and receiving one decreases the count", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 5), "0002": [{ id: "200", contractStatus: "Vet-FAA-FL" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }, { from: "0001", to: "0002", tokens: ["100", "101"] }],
  });
  const r1 = c.loaded_contracts.rows.find((r) => r.franchise_id === "0001");
  t.equal(r1.loaded_before, 5); t.equal(r1.loaded_after, 4, "5 - 2 sent + 1 received = 4");
  t.equal(c.loaded_contracts.status, "ok");
});

test("LC 5: front-loaded contracts count (suffix -FL, and legacy bare FL)", () => {
  t.equal(classifyLoaded("Vet-FAA-FL"), "FL");
  t.equal(classifyLoaded("FL"), "FL");
  t.equal(isLoaded("Vet-Ext2-FL"), true);
});

test("LC 6: back-loaded contracts count (suffix -BL, and legacy bare BL)", () => {
  t.equal(classifyLoaded("Vet-Ext2-BL"), "BL");
  t.equal(classifyLoaded("BL"), "BL");
  t.equal(isLoaded("Vet-WW-BL"), true);
});

test("LC 7: flat contracts do not count", () => {
  t.equal(classifyLoaded("Vet-FAA"), "");
  t.equal(classifyLoaded("Vet-Ext2"), "");
  t.equal(classifyLoaded("Vet-WW"), "");
  t.equal(isLoaded("Vet-ERA"), false);
});

test("LC 8: Rookie three-year contracts do not accidentally count as loaded", () => {
  t.equal(classifyLoaded("Rookie-Draft"), "");
  const c = calc({
    rosters: rosterOf({ "0001": [{ id: "1", contractStatus: "Rookie-Draft" }, { id: "2", contractStatus: "Rookie-Draft" }], "0002": [{ id: "200", contractStatus: "Rookie-Draft" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(c.loaded_contracts.rows.find((r) => r.franchise_id === "0001").loaded_after, 0);
});

test("LC 9: a loaded contract on taxi still counts (no taxi carve-out)", () => {
  const c = calc({
    rosters: rosterOf({
      "0001": [...loadedIds(100, 4), { id: "104", contractStatus: "Vet-Ext2-BL", status: "TAXI_SQUAD" }],
      "0002": [{ id: "200", contractStatus: "Vet-FAA-FL" }],
    }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(c.loaded_contracts.rows.find((r) => r.franchise_id === "0001").loaded_before, 5, "the taxi player's loaded contract must be counted in the baseline");
  t.equal(c.loaded_contracts.status, "blocked", "5 (incl. taxi) -> 6 must block, never silently pass because one was on taxi");
});

test("LC 10: a pre-trade loaded extension is included, attributed to the acquiring franchise", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractStatus: "Vet-FAA" }] }), // 200 is currently FLAT
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
    extensionRequests: [{ player_id: "200", from_franchise_id: "0002", to_franchise_id: "0001", loaded_indicator: "BL" }],
  });
  const r1 = c.loaded_contracts.rows.find((r) => r.franchise_id === "0001");
  t.equal(r1.loaded_before, 4); t.equal(r1.loaded_after, 5, "the extension's NEW loaded status (BL), not player 200's current flat status, must land on the receiver");
  t.equal(c.loaded_contracts.status, "ok");
});

test("LC 10b: a pre-trade extension that pushes the receiver from 5 to 6 blocks", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 5), "0002": [{ id: "200", contractStatus: "Vet-FAA" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
    extensionRequests: [{ player_id: "200", from_franchise_id: "0002", to_franchise_id: "0001", loaded_indicator: "FL" }],
  });
  t.equal(c.loaded_contracts.status, "blocked");
  t.equal(c.loaded_contracts.rows.find((r) => r.franchise_id === "0001").loaded_after, 6);
});

test("LC 11: extension loaded_indicator NONE never adds to the count", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractStatus: "Vet-Ext2-BL" }] }), // currently loaded
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
    extensionRequests: [{ player_id: "200", from_franchise_id: "0002", to_franchise_id: "0001", loaded_indicator: "NONE" }],
  });
  t.equal(c.loaded_contracts.rows.find((r) => r.franchise_id === "0001").loaded_after, 4, "the extension resets 200 to flat -- the acquirer does not inherit its pre-extension loaded status");
});

test("LC 12: missing salary/contract export fails the WHOLE calculation closed (cap, roster, and loaded_contracts all unavailable)", () => {
  const c = evaluateTradeCompliance({ league: league(), salaries: { ok: false, status: 500 }, adjustments: adjOf([]),
    rosters: rosterOf({ "0001": loadedIds(100, 5), "0002": [{ id: "200", contractStatus: "Vet-FAA-FL" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }] });
  t.equal(c.loaded_contracts.status, "unavailable");
  t.equal(c.cap.status, "unavailable", "loaded_contracts unavailable must accompany the SAME whole-calculation fail-closed cap/roster path, not a partial result");
  t.equal(c.roster.status, "unavailable");
});

test("LC 13: malformed contract authority (an unparseable rosters export) fails closed the same way for loaded_contracts as for cap", () => {
  const c = evaluateTradeCompliance({ league: league(), salaries: noSalaries, adjustments: adjOf([]),
    rosters: ok({ rosters: {} }), // malformed: no franchise[] at all
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }] });
  t.equal(c.loaded_contracts.status, "unavailable");
  t.equal(c.cap.status, "unavailable");
});

test("LC 14: a franchise NOT part of any movement never poisons the count (foreign franchise's contracts are irrelevant)", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractStatus: "Vet-FAA-FL" }], "0003": loadedIds(900, 20) }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(c.loaded_contracts.status, "ok", "franchise 0003 (20 loaded contracts) is not a participant and must not be scanned at all");
  t.equal(c.loaded_contracts.rows.length, 2);
});

test("LC: 2-way and 3-way routes use the SAME calculation (identical inputs give identical loaded-contract numbers)", () => {
  const rosters = rosterOf({ "0001": loadedIds(100, 5), "0002": [{ id: "200", contractStatus: "Vet-FAA-FL" }] });
  const movements = [{ from: "0002", to: "0001", tokens: ["200"] }];
  const a = evaluateTradeCompliance({ league: league(), salaries: noSalaries, adjustments: adjOf([]), rosters, movements });
  const b = evaluateTradeCompliance({ league: league(), salaries: noSalaries, adjustments: adjOf([]), rosters, movements });
  t.deepEqual(a.loaded_contracts, b.loaded_contracts, "there is only one calculation -- both callers reach the identical function");
});

// ───────────────────────────────── Part 2 — two-team accept, real worker ─────────────────────────────────
// Harness defaults: 0001 owns player 14056, 0002 owns player 13100 (worker_harness.mjs).
const player = (pid, salary = 5000) => ({ asset_id: `P_${pid}`, type: "PLAYER", player_id: String(pid), player_name: `P${pid}`, salary, taxi: false, contract_info: "" });
const payloadOf = (from, to, give, recv) => ({
  schema_version: 1, source: "test", league_id: "74598", season: "2026",
  teams: [
    { role: "left", franchise_id: from, selected_assets: give, traded_salary_adjustment_k: 0, traded_salary_adjustment_dollars: 0, selected_non_taxi_salary_dollars: 5000 },
    { role: "right", franchise_id: to, selected_assets: recv, traded_salary_adjustment_k: 0, traded_salary_adjustment_dollars: 0, selected_non_taxi_salary_dollars: 5000 },
  ],
  extension_requests: [], ui: { left_team_id: from, right_team_id: to }, validation: { status: "ready" },
});
function fresh2(o) {
  const env = makeWorkerEnv(o && o.env);
  const mfl = makeMfl({ tokens: { "tok-H": "0012" } });
  mfl.install();
  return { env, mfl };
}
async function sendOffer(env, mfl, payload) {
  const r = await callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, {
    body: { league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002", from_franchise_name: "x", to_franchise_name: "y", message: "", payload },
  });
  t.ok(r.status < 300, `offer sent: ${r.status} ${r.text.slice(0, 200)}`);
  return { id: mfl.st.pending[mfl.st.pending.length - 1].trade_id, payload };
}
const mobileBody = (id, action) => ({ action: action || "ACCEPT", trade_id: id, league_id: "74598", franchise_id: "0002", year: "2026", message: "" });
const act = (env, body) => callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-C`, { body });

test("LC 2-WAY: 5 -> 6 loaded blocks the accept (409 loaded_contract_limit), nothing is written", async () => {
  const { env, mfl } = fresh2();
  mfl.st.rosters["0001"] = [...loadedIds(9000, 5).map((p) => ({ id: p.id, salary: 1000, contractStatus: p.contractStatus })), { id: "14056", salary: 5000, contractStatus: "Vet-FAA" }];
  mfl.st.rosters["0002"] = [{ id: "13100", salary: 5000, contractStatus: "Vet-FAA-FL" }];
  const { id, payload } = await sendOffer(env, mfl, payloadOf("0001", "0002", [player(14056)], [player(13100)]));
  const r = await act(env, mobileBody(id));
  t.equal(r.status, 409);
  t.equal(r.json.code, "loaded_contract_limit");
  t.match(r.json.error, /would move from 5 to 6 loaded contracts/);
  t.equal(mfl.writes("tradeResponse").length, 0, "a blocked accept must make zero MFL writes");
  t.equal(mfl.st.pending.length, 1, "the offer stays pending");
});

test("LC 2-WAY: false client-supplied loaded-contract totals cannot bypass the gate", async () => {
  const { env, mfl } = fresh2();
  mfl.st.rosters["0001"] = [...loadedIds(9000, 5).map((p) => ({ id: p.id, salary: 1000, contractStatus: p.contractStatus })), { id: "14056", salary: 5000, contractStatus: "Vet-FAA-FL" }];
  mfl.st.rosters["0002"] = [{ id: "13100", salary: 5000, contractStatus: "Vet-FAA-FL" }];
  const { id } = await sendOffer(env, mfl, payloadOf("0001", "0002", [player(14056)], [player(13100)]));
  const r = await act(env, { ...mobileBody(id), compliance: { loaded_contracts: { status: "ok" } }, force: true, override: true, ignore_limit: true });
  t.equal(r.status, 409);
  t.equal(r.json.code, "loaded_contract_limit", "client-supplied compliance/force/override/ignore_limit fields must be completely ignored");
  t.equal(mfl.writes("tradeResponse").length, 0);
});

test("LC 2-WAY: at exactly 5 (not 6), the accept proceeds and MFL is called once", async () => {
  const { env, mfl } = fresh2();
  mfl.st.rosters["0001"] = [...loadedIds(9000, 4).map((p) => ({ id: p.id, salary: 1000, contractStatus: p.contractStatus })), { id: "14056", salary: 5000, contractStatus: "Vet-FAA-FL" }];
  mfl.st.rosters["0002"] = [{ id: "13100", salary: 5000, contractStatus: "Vet-FAA-FL" }];
  const { id } = await sendOffer(env, mfl, payloadOf("0001", "0002", [player(14056)], [player(13100)]));
  const r = await act(env, mobileBody(id));
  t.ok(r.status < 300, r.text.slice(0, 300));
  t.equal(mfl.writes("tradeResponse").length, 1);
});

// ───────────────────────────────── Part 3 — three-team gates, real worker ─────────────────────────────────
const DISCORD = F.DISCORD;
function threeWayWorld(o) {
  o = o || {};
  const env = makeWorkerEnv({ TRADE_3WAY_EXECUTE: "1", ...(o.env || {}) });
  const mfl = makeMfl({ tokens: { "tok-H": "0012" } }); mfl.install();
  bindSelf(env);
  for (const [fid, d] of [["0008", DISCORD.A], ["0001", DISCORD.B], ["0012", DISCORD.C]]) env.UPS_MFL_DB.raw.prepare("INSERT INTO discord_owners VALUES (?,?,?)").run(fid, "Y", d);
  const legs = [{ from: "0008", to: "0001", asset_tokens: ["P_16614"], cap_k: 0, summary: "P16614" }, { from: "0001", to: "0012", asset_tokens: ["P_16181"], cap_k: 0, summary: "P16181" }, { from: "0012", to: "0008", asset_tokens: ["P_16650"], cap_k: 0, summary: "P16650" }];
  F.seedTrade(env, { legs_json: JSON.stringify(legs), ...(o.row || {}) });
  mfl.st.rosters = {
    "0008": [{ id: "16614", salary: 5000, contractStatus: "Vet-FAA" }, ...(o.loadedA ? loadedIds(90000, o.loadedA).map((p) => ({ id: p.id, salary: 1000, contractStatus: p.contractStatus })) : [])],
    "0001": [{ id: "16181", salary: 5000, contractStatus: "Vet-FAA" }, ...(o.loadedB ? loadedIds(90100, o.loadedB).map((p) => ({ id: p.id, salary: 1000, contractStatus: p.contractStatus })) : [])],
    "0012": [{ id: "16650", salary: 5000, contractStatus: "Vet-FAA" }, ...(o.loadedC ? loadedIds(90200, o.loadedC).map((p) => ({ id: p.id, salary: 1000, contractStatus: p.contractStatus })) : [])],
  };
  return { env, mfl };
}
const press = (action, userId) => ({ data: { custom_id: `tr3:${action}:${F.TRADE_ID}` }, member: { user: { id: userId } } });
const say = async (resp) => (await resp.json()).data.content;
const ctxWait = () => { const p = []; return { waitUntil: (x) => p.push(x), flush: () => Promise.all(p) }; };
const ledgerRow = (env) => env.UPS_MFL_DB.raw.prepare("SELECT * FROM ups_trade_executions WHERE exec_key=?").get(F.TRADE_ID);
const recheck = (env, tok) => callWorker(env, "POST", `/api/trades/3way/recheck?${Q}&MFL_USER_ID=${tok || "tok-A"}`, { body: { id: F.TRADE_ID } });

test("LC 3-WAY: the third participant would exceed the loaded-contract limit -> the accept IS recorded, nothing executes", async () => {
  // 0008 receives 16650 (flat) from 0012 and sends 16614 (flat) to 0001 -- unaffected.
  // 0001 sends 16181 (flat) to 0012 and receives 16614 (flat) from 0008 -- unaffected.
  // 0012 already has 5 loaded contracts, sends 16650 (flat) to 0008 and receives 16181 (flat, no change either) --
  // make 0012 receive a LOADED asset instead: swap leg so 0001 sends a loaded contract to 0012.
  const { env, mfl } = threeWayWorld({ loadedC: 5 });
  mfl.st.rosters["0001"][0].contractStatus = "Vet-FAA-FL"; // the asset 0001 sends to 0012 (16181) is now loaded
  const ctx = ctxWait();
  const msg = await say(await handle3WayButton(press("accept", DISCORD.B), env, ctx));
  await ctx.flush();
  t.match(msg, /would move from 5 to 6 loaded contracts/);
  const row = F.readRow(env);
  t.equal(row.team_b_state, "accepted", "the accept WAS recorded — consent is never discarded because someone would exceed the loaded-contract limit");
  t.equal(row.status, "collecting");
  t.equal(mfl.writes().length, 0);
});

test("LC 3-WAY: RECOVERABLE block when both accept over the limit -- collecting, both approvals kept, ledger blocked_cap, zero MFL writes", async () => {
  const { env, mfl } = threeWayWorld({ loadedC: 5, row: { team_b_state: "accepted" } });
  mfl.st.rosters["0001"][0].contractStatus = "Vet-FAA-FL";
  const ctx = ctxWait();
  const msg = await say(await handle3WayButton(press("accept", DISCORD.C), env, ctx));
  await ctx.flush();
  t.match(msg, /would move from 5 to 6 loaded contracts/);
  const row = F.readRow(env);
  t.equal(row.status, "collecting", "NOT failed, NOT executing");
  t.equal(row.team_b_state, "accepted"); t.equal(row.team_c_state, "accepted");
  t.equal(row.failure_reason, null); t.equal(row.mfl_trade_ids, null); t.equal(row.executed_at_utc, null);
  const led = ledgerRow(env); t.equal(led.state, "blocked_cap");
  const blk = JSON.parse(led.block_json); t.equal(blk.kind, "loaded_contracts");
  t.equal(mfl.writes().length, 0, "zero MFL writes"); t.equal(mfl.st.done.length, 0);
});

test("LC 3-WAY: recheck recomputes from FRESH authority -- fixing the roster lets it execute", async () => {
  const { env, mfl } = threeWayWorld({ loadedC: 5, row: { status: "executing", team_b_state: "accepted", team_c_state: "accepted" } });
  mfl.st.rosters["0001"][0].contractStatus = "Vet-FAA-FL";
  const r1 = await execute3Way(env, F.TRADE_ID);
  t.equal(r1.blocked, true); t.equal(r1.kind, "loaded_contracts");
  t.equal(F.readRow(env).status, "collecting", "recoverable -- never failed");
  t.equal(ledgerRow(env).state, "blocked_cap");
  // a re-check while STILL over the limit: refused, recomputed, nothing changes
  const still = await recheck(env);
  t.equal(still.status, 409); t.equal(still.json.code, "loaded_contract_limit");
  t.equal(F.readRow(env).status, "collecting"); t.equal(mfl.writes().length, 0);
  // Fix: 0012 drops one of its 5 loaded contracts, opening a slot -- a fresh read must pick this up.
  // (index 0 is the real trade asset 16650 -- keep it; drop one of the loaded filler players.)
  mfl.st.rosters["0012"] = [mfl.st.rosters["0012"][0], ...mfl.st.rosters["0012"].slice(2)];
  env.TRADE_3WAY_EXECUTE = "0"; // dry-run so this test doesn't have to drive live legs
  const fixed = await recheck(env);
  t.equal(fixed.status, 200, fixed.text.slice(0, 200)); t.equal(fixed.json.code, "rechecking");
  const row = F.readRow(env); t.equal(row.status, "completed"); t.equal(row.failure_reason, "dry_run");
});

await run("trade_loaded_contracts");
restore();
