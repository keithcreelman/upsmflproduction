// DROP-FIRST EXECUTION (Keith's ruling, 2026-09-29, docs/LOADED_CONTRACT_DROP_EXECUTION_DESIGN.md
// §2.4.3b): "drop-first under manual commissioner review... The exact pre-drop snapshot is
// mandatory. If the player's contract terms or roster state cannot be captured and verified,
// stop before any drop... Every notification must distinguish 'player dropped; trade still
// pending' from 'trade completed'. A failed or uncertain step must stop the sequence and remain
// visible in the queue; retries must never repeat a confirmed drop."
//
// Runs against the REAL worker (executeDropFirstDeal, trade_2way_http.js's new /execute route)
// + real SQLite D1 + a stateful fake MFL. The ONE thing this file deliberately stubs is
// /roster-workbench/action's own real MFL-HTML-form scraping (fetchLoadRostFormForCookie /
// postLoadRostFormForCookie) -- that route's own LOADROST-page parsing has NO existing test
// coverage anywhere in this repo (grep confirms it) and simulating MFL's real roster-edit HTML
// form is a separate, pre-existing, unowned gap this task does not take on. What IS tested
// against the real thing: the real worker dispatch, the real execution ledger (including the
// new PARTIAL_EXECUTED state + resumeDropSequence), the real capGate2Way/compliance calc, the
// real per-franchise hold queries, and the real /api/trades/2way/execute HTTP route + its authz.
// The stub's own response shapes are traced EXACTLY from worker/src/index.js's real handler
// (formRes.ok=false -> {error, details:{error:"commissioner_access_required"|...}}; a
// verification mismatch -> {verification:{ok:false, reason:"player_still_found_on_roster"|
// "post_membership_rosters_export_failed"}}), not guessed.
//   node tests/trade_2way_drop_first_execute.test.mjs
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, bindSelf, quiet, ADMIN_KEY } from "./fixtures/worker_harness.mjs";
import { THREE_WAY_MIGRATIONS } from "./fixtures/d1_sqlite.mjs";

const restoreConsole = quiet();
await import("./fixtures/register_md_loader.mjs");
const { createStaged2WayTrade, accept2WayTrade, select2WayLoadedContractDrops, executeDropFirstDeal, cancel2WayTrade } = await import("../worker/src/trade_2way.js");
const { create3WayTrade, execute3Way } = await import("../worker/src/trade_3way.js");

const Q = "L=74598&YEAR=2026";
const MIGRATIONS = [...THREE_WAY_MIGRATIONS, "0162_ups_trade_cap_acknowledgments.sql", "0163_ups_trade_conditional_drops.sql", "0164_ups_2way_trades.sql"];
const FR = { A: "0008", B: "0001" };
const flat = (id) => ({ id, salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" });
const loaded = (id) => ({ id, salary: "5000", contractYear: "2", contractStatus: "Vet-BL", contractInfo: "CL 2|TCV 20K|AAV 10K|Y1-5K|Y2-15K" });
const fiveLoaded = (start) => [0, 1, 2, 3, 4].map((i) => loaded(String(start + i)));

// Intercepts ONLY /roster-workbench/action (the pre-existing, separately-unowned MFL-HTML-form
// route -- see file header) -- everything else on env.SELF still hits the REAL worker.
function installFakeUnloadPlayer(env, responder) {
  const real = env.SELF.fetch;
  const calls = [];
  env.SELF = {
    fetch: async (u, init) => {
      const url = new URL(String(u));
      if (url.pathname === "/roster-workbench/action") {
        const body = init && init.body ? JSON.parse(init.body) : {};
        calls.push({ franchise_id: body.franchise_id, player_id: body.player_id });
        const resp = await responder(body, calls.length);
        return new Response(JSON.stringify(resp.json), { status: resp.status });
      }
      return real(u, init);
    },
  };
  env.SELF.__unloadCalls = calls;
  return calls;
}
const confirmedResp = (body) => ({ status: 200, json: { ok: true, action: "unload_player", player_id: body.player_id, franchise_id: body.franchise_id, verification: { ok: true, player_id: body.player_id, franchise_id: "" } } });
const lockoutResp = () => ({ status: 502, json: { ok: false, error: "Unable to load commissioner roster form", details: { error: "commissioner_access_required" } } });
const stillOnRosterResp = (body) => ({ status: 502, json: { ok: false, error: "Roster membership verification failed", verification: { ok: false, reason: "player_still_found_on_roster", player_id: body.player_id, franchise_id: body.franchise_id } } });
const unconfirmedResp = (body) => ({ status: 502, json: { ok: false, error: "Roster membership verification failed", verification: { ok: false, reason: "post_membership_rosters_export_failed", player_id: body.player_id, franchise_id: body.franchise_id } } });

function fresh(over) {
  const env = makeWorkerEnv({ __migrations: MIGRATIONS, TRADE_2WAY_STAGING_ENABLED: "1", COMMISH_DISCORD_USER_ID: "621530026831118346", ...(over || {}) });
  env.UPS_MFL_DB.raw.exec("CREATE TABLE IF NOT EXISTS discord_owners (franchise_id TEXT, active_owner TEXT, discord_user_id TEXT)");
  env.UPS_MFL_DB.raw.prepare("INSERT INTO discord_owners VALUES (?,?,?)").run(FR.A, "Y", "100000000000000001");
  env.UPS_MFL_DB.raw.prepare("INSERT INTO discord_owners VALUES (?,?,?)").run(FR.B, "Y", "100000000000000002");
  bindSelf(env);
  const mfl = makeMfl(over && over.mfl);
  mfl.install();
  return { env, mfl };
}
const CREATE_SPEC = (over) => ({
  leagueId: "74598", season: "2026",
  from: { fid: FR.A, name: "Real Deal Creel" }, to: { fid: FR.B, name: "L.A. Looks" },
  movements: [{ from: FR.A, to: FR.B, asset_tokens: ["90000"], cap_k: 0 }],
  ...(over || {}),
});
async function stageAcceptWithDrop(env, mfl, { senderLoadedIds, dropPlayerId }) {
  mfl.st.rosters[FR.A] = [...senderLoadedIds.map((id) => loaded(id)), flat("90000")];
  mfl.st.rosters[FR.B] = [flat("13100")];
  const created = await createStaged2WayTrade(env, {}, CREATE_SPEC());
  const ctx = { waitUntil: (p) => p };
  await select2WayLoadedContractDrops(env, created.id, { fid: FR.A, leagueId: "74598", season: "2026" }, [dropPlayerId]);
  const accept = await accept2WayTrade(env, ctx, created.id, { fid: FR.B, leagueId: "74598", season: "2026" }, {});
  t.equal(accept.held, true, "must be held on needs_drops before any execute call -- no executor existed before this feature");
  return created.id;
}
const ledgerRow = (env, id) => env.UPS_MFL_DB.raw.prepare("SELECT * FROM ups_trade_executions WHERE exec_key=?").get(id);
const tradeRow = (env, id) => env.UPS_MFL_DB.raw.prepare("SELECT * FROM ups_2way_trades WHERE id=?").get(id);

test("FLAG OFF (default): executeDropFirstDeal refuses outright, zero MFL writes of any kind", async () => {
  const { env, mfl } = fresh();
  const id = await stageAcceptWithDrop(env, mfl, { senderLoadedIds: ["80000", "80001", "80002", "80003", "80004", "80005"], dropPlayerId: "80000" });
  const calls = installFakeUnloadPlayer(env, confirmedResp);
  const r = await executeDropFirstDeal(env, {}, id);
  t.equal(r.ok, false);
  t.equal(r.error, "drop_execute_disabled");
  t.equal(calls.length, 0, "the drop-write route must never even be called while the flag is off");
  t.equal(mfl.st.imports.length, 0);
});

test("MANDATORY SNAPSHOT: a SECOND required drop's player leaves the roster in the gap between the first drop confirming and its own turn -- STOPS before that step's write is ever attempted, even though gate0 (run once, up front) originally saw it as valid", async () => {
  const { env, mfl } = fresh({ TRADE_2WAY_DROP_EXECUTE_ENABLED: "1" });
  // Two required drops (7 pre-existing loaded, over by 2).
  mfl.st.rosters[FR.A] = [...fiveLoaded(80000), loaded("80005"), loaded("80006"), flat("90000")];
  mfl.st.rosters[FR.B] = [flat("13100")];
  const created = await createStaged2WayTrade(env, {}, CREATE_SPEC());
  await select2WayLoadedContractDrops(env, created.id, { fid: FR.A, leagueId: "74598", season: "2026" }, ["80000", "80001"]);
  const ctx = { waitUntil: (p) => p };
  await accept2WayTrade(env, ctx, created.id, { fid: FR.B, leagueId: "74598", season: "2026" }, {});

  // Keith's exact scenario: "if the player's contract terms or roster state cannot be captured
  // and verified, stop before any drop." Simulate a THIRD PARTY claiming 80001 (a waiver, an
  // unrelated trade) in the real-world gap between this deal's two drop steps -- realistic
  // because each step is its own separate MFL round trip, not one atomic operation (§2.5). The
  // mutation happens INSIDE the responder for step 1, i.e. strictly AFTER gate0's one-time
  // up-front satisfied check already passed both picks as valid.
  const calls = installFakeUnloadPlayer(env, (body, n) => {
    if (n === 1) { mfl.st.rosters[FR.A] = mfl.st.rosters[FR.A].filter((p) => p.id !== "80001"); return confirmedResp(body); }
    return confirmedResp(body);
  });
  const r = await executeDropFirstDeal(env, {}, created.id);
  t.equal(r.ok, false);
  t.match(r.reason, /snapshot_failed/);
  t.equal(calls.length, 1, "MANDATORY: the write for 80001 must NEVER be attempted once its own snapshot/verification fails -- only 80000's confirmed write happened");
  const led = ledgerRow(env, created.id);
  t.equal(led.state, "executed_needs_review");
  t.match(led.failed_step, /^drop:80001$/);
  t.match(led.failure_detail, /snapshot_failed/);
  const steps = JSON.parse(led.steps_json);
  t.equal(steps["drop:80000"].status, "confirmed", "the FIRST drop, already genuinely confirmed on MFL, remains recorded as confirmed -- it is not undone or forgotten because a LATER step failed");
  t.equal(steps["drop:80001"].status, "failed");
  t.equal(mfl.st.imports.length, 0, "no MFL TRADE import ever happens -- the sequence stopped before the trade leg");
});

test("HAPPY PATH: two required drops across the SAME franchise, both confirmed, then the trade -- distinct notifications at each stage, ledger records both pre-drop snapshots", async () => {
  const { env, mfl } = fresh({ TRADE_2WAY_DROP_EXECUTE_ENABLED: "1" });
  mfl.st.rosters[FR.A] = [...fiveLoaded(80000), flat("90000")]; // 5 loaded + the traded asset -> needs 2 drops after sending 0 loaded away, receiving 0 loaded (projected stays 5... use 6 loaded to force required=1)
  // Force exactly ONE required drop deterministically: 5 loaded is AT the limit (not over) with
  // no net change from this trade, so bump to 6 loaded pre-existing to require exactly 1 drop.
  mfl.st.rosters[FR.A] = [...fiveLoaded(80000), loaded("80005"), flat("90000")];
  mfl.st.rosters[FR.B] = [flat("13100")];
  const created = await createStaged2WayTrade(env, {}, CREATE_SPEC());
  await select2WayLoadedContractDrops(env, created.id, { fid: FR.A, leagueId: "74598", season: "2026" }, ["80000"]);
  const ctx = { waitUntil: (p) => p };
  const accept = await accept2WayTrade(env, ctx, created.id, { fid: FR.B, leagueId: "74598", season: "2026" }, {});
  t.equal(accept.held, true);

  const discord = mfl.st.discord;
  discord.length = 0;
  const calls = installFakeUnloadPlayer(env, confirmedResp);
  const r = await executeDropFirstDeal(env, {}, created.id);
  t.equal(r.ok, true, JSON.stringify(r));
  t.equal(calls.length, 1, "exactly one drop write for the one required drop");
  t.equal(calls[0].player_id, "80000");
  t.equal(calls[0].franchise_id, FR.A);

  const led = ledgerRow(env, created.id);
  t.equal(led.state, "completed");
  const steps = JSON.parse(led.steps_json);
  t.equal(steps["drop:80000"].status, "confirmed");
  t.ok(steps["drop:80000"].pre_drop_snapshot, "the exact pre-drop contract snapshot must be recorded");
  t.equal(steps["drop:80000"].pre_drop_snapshot.contractStatus, "Vet-BL");

  const trade = tradeRow(env, created.id);
  t.equal(trade.status, "completed");

  // Distinct notification content -- "player dropped; trade still pending" vs "trade completed."
  const texts = discord.map((d) => String((d.body && d.body.content) || ""));
  t.ok(texts.some((c) => /has been dropped from your roster/.test(c) && /not.*gone through yet/.test(c)), "must have sent a DISTINCT 'dropped, trade still pending' message");
  t.ok(texts.some((c) => /went through on MFL/.test(c) || /trade itself cleared/.test(c)), "must have sent a DISTINCT 'trade completed' message");
  const droppedMsg = texts.find((c) => /has been dropped from your roster/.test(c));
  const completedMsg = texts.find((c) => /went through on MFL|trade itself cleared/.test(c));
  t.ok(droppedMsg !== completedMsg, "the two messages must not be the same text");
});

test("A DROP STEP FAILS (lockout-shaped): the WHOLE sequence stops -- the trade is never attempted, and the ledger records the exact failed step", async () => {
  const { env, mfl } = fresh({ TRADE_2WAY_DROP_EXECUTE_ENABLED: "1" });
  const id = await stageAcceptWithDrop(env, mfl, { senderLoadedIds: ["80000", "80001", "80002", "80003", "80004", "80005"], dropPlayerId: "80000" });
  mfl.st.imports.length = 0;
  const calls = installFakeUnloadPlayer(env, lockoutResp);
  const r = await executeDropFirstDeal(env, {}, id);
  t.equal(r.ok, false);
  t.equal(r.status, "failed");
  t.match(r.reason, /lockout/);
  t.equal(calls.length, 1, "the drop write was attempted exactly once -- the failure came FROM MFL, not before it");
  t.equal(mfl.st.imports.length, 0, "the failed drop attempt itself must be a real (stubbed) HTTP call, but must NEVER reach the fake MFL's own tradeProposal/import path -- proves the trade leg never ran");
  const led = ledgerRow(env, id);
  t.equal(led.state, "executed_needs_review");
  t.equal(led.failed_step, "drop:80000");
  t.match(led.failure_detail, /lockout/);
  const trade = tradeRow(env, id);
  t.notEqual(trade.status, "completed");
});

test("UNCONFIRMED drop (verification itself failed, not a proven refusal): distinct from FAILED -- never assumed either outcome, sequence still stops", async () => {
  const { env, mfl } = fresh({ TRADE_2WAY_DROP_EXECUTE_ENABLED: "1" });
  const id = await stageAcceptWithDrop(env, mfl, { senderLoadedIds: ["80000", "80001", "80002", "80003", "80004", "80005"], dropPlayerId: "80000" });
  installFakeUnloadPlayer(env, unconfirmedResp);
  const r = await executeDropFirstDeal(env, {}, id);
  t.equal(r.ok, false);
  t.equal(r.status, "unconfirmed");
  const led = ledgerRow(env, id);
  const steps = JSON.parse(led.steps_json);
  t.equal(steps["drop:80000"].status, "unconfirmed");
  t.equal(led.state, "executed_needs_review");
});

test("MFL PROVABLY DID NOT DROP THE PLAYER (verification says still on roster): classified as a genuine FAILURE, not an ambiguity", async () => {
  const { env, mfl } = fresh({ TRADE_2WAY_DROP_EXECUTE_ENABLED: "1" });
  const id = await stageAcceptWithDrop(env, mfl, { senderLoadedIds: ["80000", "80001", "80002", "80003", "80004", "80005"], dropPlayerId: "80000" });
  installFakeUnloadPlayer(env, stillOnRosterResp);
  const r = await executeDropFirstDeal(env, {}, id);
  t.equal(r.ok, false);
  t.equal(r.status, "failed");
  t.match(r.reason, /mfl_did_not_remove_player/);
});

test("RETRY NEVER REPEATS A CONFIRMED DROP: first attempt confirms drop A then fails on drop B; a second attempt (retry) does NOT re-call unload_player for A, and resumes at B", async () => {
  const { env, mfl } = fresh({ TRADE_2WAY_DROP_EXECUTE_ENABLED: "1" });
  // Two required drops: 6 pre-existing loaded (over by 1)... force required=2 by starting at 7.
  mfl.st.rosters[FR.A] = [...fiveLoaded(80000), loaded("80005"), loaded("80006"), flat("90000")];
  mfl.st.rosters[FR.B] = [flat("13100")];
  const created = await createStaged2WayTrade(env, {}, CREATE_SPEC());
  await select2WayLoadedContractDrops(env, created.id, { fid: FR.A, leagueId: "74598", season: "2026" }, ["80000", "80001"]);
  const ctx = { waitUntil: (p) => p };
  await accept2WayTrade(env, ctx, created.id, { fid: FR.B, leagueId: "74598", season: "2026" }, {});

  // Attempt 1: 80000 confirms, 80001 fails (lockout-shaped).
  let calls = installFakeUnloadPlayer(env, (body, n) => (n === 1 ? confirmedResp(body) : lockoutResp()));
  const r1 = await executeDropFirstDeal(env, {}, created.id);
  t.equal(r1.ok, false);
  t.equal(calls.length, 2);
  t.equal(calls[0].player_id, "80000");
  t.equal(calls[1].player_id, "80001");
  let led = ledgerRow(env, created.id);
  t.equal(JSON.parse(led.steps_json)["drop:80000"].status, "confirmed");
  t.equal(JSON.parse(led.steps_json)["drop:80001"].status, "failed");

  // Attempt 2 (retry, e.g. commissioner toggled lockout off): 80001 now confirms.
  calls = installFakeUnloadPlayer(env, confirmedResp);
  const r2 = await executeDropFirstDeal(env, {}, created.id);
  t.equal(r2.ok, true, JSON.stringify(r2));
  t.equal(calls.length, 1, "MUST skip 80000 (already confirmed) -- only 80001 and then the trade run this time");
  t.equal(calls[0].player_id, "80001");
  led = ledgerRow(env, created.id);
  t.equal(led.state, "completed");
});

test("PLAYER-LOSS SCENARIO: every required drop confirms, but the TRADE ITSELF then fails -- the most safety-critical DM in this feature, and it must not claim restoration is guaranteed", async () => {
  const { env, mfl } = fresh({ TRADE_2WAY_DROP_EXECUTE_ENABLED: "1", TRADE_2WAY_STAGING_EXECUTE: "1" }); // LIVE trade-write path, to exercise a real MFL-side trade failure
  const id = await stageAcceptWithDrop(env, mfl, { senderLoadedIds: ["80000", "80001", "80002", "80003", "80004", "80005"], dropPlayerId: "80000" });
  installFakeUnloadPlayer(env, confirmedResp);
  // executeCommishTwoPartyTrade proposes via APIKEY (not the commish cookie), and the fake
  // MFL's own lockout simulation only fires for cookie-authenticated calls (worker_harness.mjs:
  // "if (who.error && !params.get('APIKEY'))" -- an API-key call never sees it) -- so a genuine
  // MFL-side trade failure here is simulated via failNext instead, not st.lockout.
  mfl.st.failNext = { type: "tradeProposal", status: 500, message: "MFL internal error" };
  const discord = mfl.st.discord; discord.length = 0;
  const r = await executeDropFirstDeal(env, {}, id);
  t.equal(r.ok, false);
  t.equal(r.drops_confirmed_trade_failed, true);
  const led = ledgerRow(env, id);
  t.equal(led.state, "executed_needs_review");
  t.equal(led.failed_step, "trade");
  const texts = discord.map((d) => String((d.body && d.body.content) || ""));
  const lossMsg = texts.find((c) => /confirmed and permanent.*did NOT go through/s.test(c));
  t.ok(lossMsg, "must send the distinct player-loss DM");
  t.doesNotMatch(lossMsg, /restoration is guaranteed/i, "must never claim restoration is guaranteed");
  t.match(lossMsg, /not.*guaranteed/i);
  t.match(lossMsg, /claimed by someone else first/i);
  const trade = tradeRow(env, id);
  t.notEqual(trade.status, "completed", "the trade row must never read completed when the trade leg itself failed");
});

test("PER-FRANCHISE HOLD: an unresolved drop-first sequence blocks a NEW offer touching that franchise from being STAGED", async () => {
  const { env, mfl } = fresh({ TRADE_2WAY_DROP_EXECUTE_ENABLED: "1" });
  const id = await stageAcceptWithDrop(env, mfl, { senderLoadedIds: ["80000", "80001", "80002", "80003", "80004", "80005"], dropPlayerId: "80000" });
  installFakeUnloadPlayer(env, lockoutResp); // leaves the deal executed_needs_review (unresolved)
  await executeDropFirstDeal(env, {}, id);
  t.equal(ledgerRow(env, id).state, "executed_needs_review");

  mfl.st.rosters[FR.A] = [flat("70000")];
  mfl.st.rosters["0003"] = [flat("70001")];
  const attempt = await createStaged2WayTrade(env, {}, { leagueId: "74598", season: "2026", from: { fid: FR.A, name: "x" }, to: { fid: "0003", name: "y" }, movements: [{ from: FR.A, to: "0003", asset_tokens: ["70000"] }] });
  t.equal(attempt.ok, false);
  t.equal(attempt.error, "franchise_has_unresolved_drop_sequence");
  t.equal(attempt.franchise_id, FR.A);
});

test("PER-FRANCHISE HOLD: an unresolved drop-first sequence blocks ACCEPTING a different offer touching that franchise", async () => {
  const { env, mfl } = fresh({ TRADE_2WAY_DROP_EXECUTE_ENABLED: "1" });
  const id = await stageAcceptWithDrop(env, mfl, { senderLoadedIds: ["80000", "80001", "80002", "80003", "80004", "80005"], dropPlayerId: "80000" });
  installFakeUnloadPlayer(env, lockoutResp);
  await executeDropFirstDeal(env, {}, id);

  mfl.st.rosters[FR.A] = [flat("70000")];
  mfl.st.rosters["0003"] = [flat("70001")];
  const other = await createStaged2WayTrade(env, {}, { leagueId: "74598", season: "2026", from: { fid: "0003", name: "y" }, to: { fid: FR.A, name: "x" }, movements: [{ from: "0003", to: FR.A, asset_tokens: ["70001"] }] });
  // Staging FROM the clean side TO the held franchise is itself refused too (the hold covers
  // either side of a NEW offer) -- confirm create failed for the same reason before trying accept.
  t.equal(other.ok, false);
  t.equal(other.error, "franchise_has_unresolved_drop_sequence");
});

test("PER-FRANCHISE HOLD, EXECUTOR ITSELF: a franchise cannot have two drop-first sequences in flight -- executeDropFirstDeal refuses to START a DIFFERENT deal while one is unresolved, but a stuck deal can always resume ITSELF", async () => {
  const { env, mfl } = fresh({ TRADE_2WAY_DROP_EXECUTE_ENABLED: "1" });
  const stuckId = await stageAcceptWithDrop(env, mfl, { senderLoadedIds: ["80000", "80001", "80002", "80003", "80004", "80005"], dropPlayerId: "80000" });
  installFakeUnloadPlayer(env, lockoutResp);
  await executeDropFirstDeal(env, {}, stuckId);
  t.equal(ledgerRow(env, stuckId).state, "executed_needs_review", "the first deal is now stuck, unresolved");

  // A second, independent, brand-new offer touching the SAME franchise (0008) -- the hold check
  // runs BEFORE any compliance/drop-satisfaction check, so this is refused purely on the hold.
  mfl.st.rosters["0003"] = [flat("70001")];
  const other = await createStaged2WayTrade(env, {}, { leagueId: "74598", season: "2026", from: { fid: FR.A, name: "x" }, to: { fid: "0003", name: "y" }, movements: [{ from: FR.A, to: "0003", asset_tokens: ["90000"], cap_k: 0 }] });
  t.equal(other.ok, false, "creation itself is already refused by the per-franchise hold (tested above) -- confirming it holds here too, before even reaching the executor");
  t.equal(other.error, "franchise_has_unresolved_drop_sequence");

  // The executor itself, called directly on the STUCK deal's own id, must still be able to
  // resume IT (never blocked by its own unresolved state).
  installFakeUnloadPlayer(env, confirmedResp);
  const resumed = await executeDropFirstDeal(env, {}, stuckId);
  t.equal(resumed.ok, true, JSON.stringify(resumed));
  t.equal(ledgerRow(env, stuckId).state, "completed");
});

test("COVERAGE GAP FOUND AND CLOSED: cancel2WayTrade must refuse once ANY drop-first step has been attempted -- ups_2way_trades.status stays 'collecting' throughout the whole sequence, so without this the deal could be cancelled away while a real, confirmed drop sits unrepresented (and the commissioner queue's default view excludes cancelled trades entirely)", async () => {
  const { env, mfl } = fresh({ TRADE_2WAY_DROP_EXECUTE_ENABLED: "1" });
  const id = await stageAcceptWithDrop(env, mfl, { senderLoadedIds: ["80000", "80001", "80002", "80003", "80004", "80005"], dropPlayerId: "80000" });
  installFakeUnloadPlayer(env, confirmedResp);
  const exec = await executeDropFirstDeal(env, {}, id);
  t.equal(exec.ok, true);
  t.equal(tradeRow(env, id).status, "completed", "sanity: even on the ordinary happy path, ups_2way_trades.status only ever reaches 'completed' via runTradeLegAfterDrops -- it is NEVER set to 'executing' during the drop loop itself");

  // A SEPARATE deal, stopped mid-sequence (one drop confirmed, the next failed) -- status is
  // STILL 'collecting' at the ups_2way_trades level even though real MFL state already changed.
  const id2 = await stageTwoDropDeal(env, mfl);
  installFakeUnloadPlayer(env, (body, n) => (n === 1 ? confirmedResp(body) : lockoutResp()));
  await executeDropFirstDeal(env, {}, id2);
  t.equal(tradeRow(env, id2).status, "collecting", "the exact dangerous state: a real, confirmed drop exists, but the row's own status column still reads 'collecting'");

  const cancel = await cancel2WayTrade(env, {}, id2, { fid: FR.A, leagueId: "74598", season: "2026" }, "changed my mind");
  t.equal(cancel.ok, false);
  t.equal(cancel.code, "execution_in_progress");
  t.equal(tradeRow(env, id2).status, "collecting", "the cancel must NOT have gone through");
  t.equal(ledgerRow(env, id2).state, "executed_needs_review", "the ledger's own record of the real drop is untouched and still visible");
});

test("COVERAGE GAP FOUND AND CLOSED: select2WayLoadedContractDrops must refuse to change the selection once execution has started -- otherwise an owner could redirect the orchestrator to drop an ADDITIONAL player on top of one already confirmed", async () => {
  const { env, mfl } = fresh({ TRADE_2WAY_DROP_EXECUTE_ENABLED: "1" });
  const id = await stageTwoDropDeal(env, mfl);
  installFakeUnloadPlayer(env, (body, n) => (n === 1 ? confirmedResp(body) : lockoutResp()));
  await executeDropFirstDeal(env, {}, id); // drop:80000 confirms for real, drop:80001 fails -- stuck, unresolved

  const change = await select2WayLoadedContractDrops(env, id, { fid: FR.A, leagueId: "74598", season: "2026" }, ["80002", "80003"]);
  t.equal(change.ok, false);
  t.equal(change.code, "execution_in_progress");
  const steps = JSON.parse(ledgerRow(env, id).steps_json);
  t.equal(steps["drop:80000"].status, "confirmed", "the already-real drop stays exactly as recorded -- unaffected by the refused selection change attempt");
});

// ═══════ HOLD CLOSED ON THE LEGACY DIRECT-MFL PATH (§8.6, Keith 2026-09-30) ═══════
// "The hold also needs to cover the legacy in-app 2-way path when cutover is off... Close those
// gaps before any execution flag can be enabled." These three tests exercise the REAL
// worker/src/index.js /trade-offers and /api/trades/proposals/action handlers directly --
// cutover deliberately left OFF, which is exactly the window §8.6 originally reported as open.
const legacyAsset = (pid, salary) => ({ asset_id: `player:${pid}`, type: "PLAYER", player_id: String(pid), player_name: `P${pid}`, salary, taxi: false });
const legacyBody = (from, to, pidFrom, pidTo) => ({
  league_id: "74598", season: "2026", from_franchise_id: from, to_franchise_id: to,
  from_franchise_name: "x", to_franchise_name: "y", message: "",
  payload: {
    schema_version: 1, source: "test", league_id: "74598", season: "2026",
    teams: [
      { role: "left", franchise_id: from, selected_assets: [legacyAsset(pidFrom, 5000)], traded_salary_adjustment_dollars: 0, traded_salary_adjustment_k: 0, selected_non_taxi_salary_dollars: 5000 },
      { role: "right", franchise_id: to, selected_assets: [legacyAsset(pidTo, 5000)], traded_salary_adjustment_dollars: 0, traded_salary_adjustment_k: 0, selected_non_taxi_salary_dollars: 5000 },
    ],
    extension_requests: [], ui: { left_team_id: from, right_team_id: to }, validation: { status: "ready" },
  },
});
async function getFranchiseStuck(env, mfl) {
  const id = await stageAcceptWithDrop(env, mfl, { senderLoadedIds: ["80000", "80001", "80002", "80003", "80004", "80005"], dropPlayerId: "80000" });
  installFakeUnloadPlayer(env, lockoutResp);
  await executeDropFirstDeal(env, {}, id);
  return id;
}

test("HOLD CLOSED — LEGACY CREATE: with cutover OFF, the legacy /trade-offers route refuses to propose a real native MFL trade touching a franchise with an unresolved drop-first sequence", async () => {
  const { env, mfl } = fresh({ TRADE_2WAY_DROP_EXECUTE_ENABLED: "1" });
  await getFranchiseStuck(env, mfl);
  mfl.st.imports.length = 0;
  mfl.st.rosters[FR.A].push(legacyAsset("70000", 5000));
  mfl.st.rosters["0003"] = [legacyAsset("70001", 5000)];
  const r = await callWorker(env, "POST", `/trade-offers?${Q}&MFL_USER_ID=tok-A`, { body: legacyBody(FR.A, "0003", "70000", "70001") });
  t.equal(r.status, 409);
  t.equal(r.json.code, "franchise_has_unresolved_drop_sequence");
  t.equal(mfl.st.imports.length, 0, "no native MFL trade proposal must have been sent");
});

test("HOLD CLOSED — LEGACY COUNTER: with cutover OFF, countering a pending native offer touching the held franchise is refused, and the ORIGINAL offer is never rejected first", async () => {
  const { env, mfl } = fresh({ TRADE_2WAY_DROP_EXECUTE_ENABLED: "1" });
  await getFranchiseStuck(env, mfl);
  mfl.st.rosters["0003"] = [legacyAsset("70001", 5000)];
  mfl.st.rosters[FR.A].push(legacyAsset("70000", 5000));
  const tid = mfl.addPending({ offeringteam: "0003", offeredto: FR.A, will_give_up: "70001,", will_receive: "70000," });
  const r = await callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-A`, {
    body: { action: "COUNTER", trade_id: tid, league_id: "74598", season: "2026", franchise_id: FR.A, acting_franchise_id: FR.A,
      counter_offer: { from_franchise_id: FR.A, to_franchise_id: "0003", payload: legacyBody(FR.A, "0003", "70000", "70001").payload, message: "" } },
  });
  t.equal(r.status, 409);
  t.equal(r.json.code, "franchise_has_unresolved_drop_sequence");
  const stillPending = mfl.st.pending.find((p) => p.trade_id === tid);
  t.ok(stillPending, "the original native offer must be untouched -- the hold is checked before any side effect, same discipline as the cutover gate");
});

test("HOLD CLOSED — LEGACY ACCEPT: an offer created BEFORE the franchise got stuck, then accepted AFTER, is refused -- ACCEPT is this engine's own 'execute', and it must not complete a real trade for a franchise mid-drop-first-sequence", async () => {
  const { env, mfl } = fresh({ TRADE_2WAY_DROP_EXECUTE_ENABLED: "1", TRADE_2WAY_STAGING_EXECUTE: "1" });
  mfl.st.rosters[FR.A] = [flat("70000")];
  mfl.st.rosters["0003"] = [flat("70001")];
  // A REAL offer, created through the real endpoint (so its stored trailer/asset-list metadata
  // is fully valid for the later ownership re-check ACCEPT itself performs) -- BEFORE FR.A gets
  // stuck, exactly the real-world order this closes a gap for.
  const created = await callWorker(env, "POST", `/trade-offers?${Q}&MFL_USER_ID=tok-A`, { body: legacyBody(FR.A, "0003", "70000", "70001") });
  t.equal(created.status, 201, JSON.stringify(created.json));
  const tid = String(mfl.st.pending[mfl.st.pending.length - 1].trade_id);

  // Get FR.A stuck via the PLAYER-LOSS shape (drop confirms, trade leg fails) rather than
  // getFranchiseStuck's lockout-on-drop shape -- this leaves FR.A's loaded-contract count back
  // at the limit (compliant), so THIS test isolates the per-franchise HOLD specifically, not the
  // separate (and also-real, also-correct) pre-existing loaded-contract gate that would
  // otherwise ALSO independently refuse the same accept for an unrelated reason.
  const stuckId = await stageAcceptWithDrop(env, mfl, { senderLoadedIds: ["80000", "80001", "80002", "80003", "80004", "80005"], dropPlayerId: "80000" });
  installFakeUnloadPlayer(env, confirmedResp);
  mfl.st.failNext = { type: "tradeProposal", status: 500, message: "MFL internal error" };
  await executeDropFirstDeal(env, {}, stuckId);
  t.equal(ledgerRow(env, stuckId).state, "executed_needs_review", "sanity: FR.A is genuinely stuck (drop confirmed, trade leg failed)");
  // The fake unload_player stub doesn't itself mutate the roster -- reflect the real-world
  // effect of the CONFIRMED drop by hand, so FR.A's live loaded-contract count is genuinely back
  // at the limit (5) by the time ACCEPT re-checks it, isolating the hold from that other gate.
  mfl.st.rosters[FR.A] = mfl.st.rosters[FR.A].filter((p) => p.id !== "80000");

  mfl.st.rosters[FR.A].push(flat("70000")); // restore the asset this pending offer still needs to own for the ACCEPT-time ownership re-check
  mfl.st.done.length = 0;

  const r = await callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-O`, {
    body: { action: "ACCEPT", trade_id: tid, league_id: "74598", season: "2026", franchise_id: "0003", acting_franchise_id: "0003" },
  });
  t.equal(r.status, 409, JSON.stringify(r.json));
  t.equal(r.json.code, "franchise_has_unresolved_drop_sequence");
  t.equal(mfl.st.done.length, 0, "no accept/response was ever sent to MFL");
  const stillPending = mfl.st.pending.find((p) => String(p.trade_id) === tid);
  t.ok(stillPending, "the pending native offer is untouched");
});

// ═══════ HOLD CLOSED ON THE 3-WAY ENGINE (§8.6, Keith 2026-09-30) ═══════
// "...and the 3-way engine wherever either affected franchise can create, counter, accept, or
// execute a trade." The 3-way engine has no separate "counter" concept either (verified: no
// counter-offer route or client path exists for it, same as staged 2-way) -- create/accept/
// execute are the full surface. accept3Way is Discord-button-driven (handle3WayButton) and its
// OWN fixture ecosystem (interaction objects, trade_3way_fixture.mjs) is a genuinely separate
// harness from the one this whole file is built on; its hold check is in place (mirrors
// accept2WayTrade's own check exactly, reviewed by inspection) but is not independently
// exercised by a test in THIS file -- stated plainly, not silently skipped.

test("HOLD CLOSED — 3-WAY CREATE: a franchise with an unresolved 2-way drop-first sequence cannot be added to a brand-new 3-way deal", async () => {
  const { env, mfl } = fresh({ TRADE_2WAY_DROP_EXECUTE_ENABLED: "1" });
  await getFranchiseStuck(env, mfl);
  mfl.st.rosters[FR.A].push(flat("70000"));
  mfl.st.rosters["0003"] = [flat("70001")];
  mfl.st.rosters["0004"] = [flat("70002")];
  const r = await create3WayTrade(env, {}, {
    leagueId: "74598", season: "2026",
    initiator: { fid: FR.A, name: "x" }, teamB: { fid: "0003", name: "y" }, teamC: { fid: "0004", name: "z" },
    movements: [{ from: FR.A, to: "0003", asset_tokens: ["70000"], cap_k: 0 }, { from: "0003", to: "0004", asset_tokens: ["70001"], cap_k: 0 }, { from: "0004", to: FR.A, asset_tokens: ["70002"], cap_k: 0 }],
  });
  t.equal(r.ok, false);
  t.equal(r.error, "franchise_has_unresolved_drop_sequence");
  t.equal(r.franchise_id, FR.A);
  t.equal(mfl.st.imports.length, 0);
});

test("HOLD CLOSED — 3-WAY EXECUTE: a deal all three already approved is blocked (reverted to collecting, never stuck at 'executing') if any participant develops an unresolved 2-way drop-first sequence before it runs", async () => {
  const { env, mfl } = fresh({ TRADE_2WAY_DROP_EXECUTE_ENABLED: "1", TRADE_2WAY_STAGING_ENABLED: "1" });
  mfl.st.rosters[FR.A] = [flat("70000")];
  mfl.st.rosters["0003"] = [flat("70001")];
  mfl.st.rosters["0004"] = [flat("70002")];
  const created = await create3WayTrade(env, {}, {
    leagueId: "74598", season: "2026",
    initiator: { fid: FR.A, name: "x" }, teamB: { fid: "0003", name: "y" }, teamC: { fid: "0004", name: "z" },
    movements: [{ from: FR.A, to: "0003", asset_tokens: ["70000"], cap_k: 0 }, { from: "0003", to: "0004", asset_tokens: ["70001"], cap_k: 0 }, { from: "0004", to: FR.A, asset_tokens: ["70002"], cap_k: 0 }],
  });
  t.equal(created.ok, true, JSON.stringify(created));
  // All three approved (bypassing the Discord-button flow -- this test targets execute3Way's
  // own hold, not accept's) and the row moved to 'executing', exactly as handle3WayButton does
  // once the third accept lands.
  env.UPS_MFL_DB.raw.prepare(`UPDATE ups_3way_trades SET team_b_state='accepted', team_c_state='accepted', status='executing', updated_at_utc=? WHERE id=?`).run(new Date().toISOString(), created.id);

  // FR.A gets stuck on a SEPARATE 2-way deal AFTER this 3-way was already fully approved.
  await getFranchiseStuck(env, mfl);
  mfl.st.imports.length = 0;

  const r = await execute3Way(env, created.id);
  t.equal(r.ok, false);
  t.equal(r.blocked, true);
  t.equal(r.kind, "franchise_has_unresolved_drop_sequence");
  t.equal(mfl.st.imports.length, 0, "no MFL trade leg was ever sent");
  const row = env.UPS_MFL_DB.raw.prepare("SELECT status FROM ups_3way_trades WHERE id=?").get(created.id);
  t.equal(row.status, "collecting", "reverted, exactly like every other pre-execution block -- never left stuck at status='executing'");
});

test("HTTP: POST /api/trades/2way/execute is commissioner-only -- an ordinary owner session is refused (403), never dispatched", async () => {
  const { env, mfl } = fresh({ TRADE_2WAY_DROP_EXECUTE_ENABLED: "1" });
  const id = await stageAcceptWithDrop(env, mfl, { senderLoadedIds: ["80000", "80001", "80002", "80003", "80004", "80005"], dropPlayerId: "80000" });
  const calls = installFakeUnloadPlayer(env, confirmedResp);
  const r = await callWorker(env, "POST", `/api/trades/2way/execute?${Q}&MFL_USER_ID=tok-B`, { body: { id } });
  t.equal(r.status, 403);
  t.equal(calls.length, 0);
});

test("HTTP: the admin key can start execution -- 202, dispatched via waitUntil, real ledger state afterward", async () => {
  const { env, mfl } = fresh({ TRADE_2WAY_DROP_EXECUTE_ENABLED: "1" });
  const id = await stageAcceptWithDrop(env, mfl, { senderLoadedIds: ["80000", "80001", "80002", "80003", "80004", "80005"], dropPlayerId: "80000" });
  installFakeUnloadPlayer(env, confirmedResp);
  const r = await callWorker(env, "POST", `/api/trades/2way/execute?${Q}&APIKEY=${ADMIN_KEY}`, { body: { id } });
  t.equal(r.status, 202);
  t.equal(JSON.parse(r.text).started, true);
  t.equal(ledgerRow(env, id).state, "completed");
});

// ═══════ RECONCILIATION: the failure window AFTER MFL confirms but BEFORE the ledger records ═══════
// Keith (2026-09-30): "A retry cannot safely infer from a missing ledger step that the drop
// never happened... show how the executor reconciles MFL's live roster and the stored pre-drop
// snapshot after a timeout, process crash, or ambiguous response, and holds for commissioner
// review whenever it cannot prove the outcome." Two required drops each time, per his
// instruction, with failure after the first confirmed drop and uncertainty around the second.
const SNAP_80000 = { salary: "5000", contractStatus: "Vet-BL", contractYear: "2", contractInfo: "CL 2|TCV 20K|AAV 10K|Y1-5K|Y2-15K" };
// MFL's own real FREE_AGENT transaction shape ("added,|dropped,"), the authoritative evidence
// Keith requires (2026-09-30) -- reconciliation must never rely on roster presence alone.
function freeAgentDropTx(franchiseId, playerId, unixTs) {
  return { type: "FREE_AGENT", franchise: franchiseId, timestamp: String(unixTs), transaction: `|${playerId},` };
}
function seedCrashedAttempt(env, id, stepsJson, state) {
  const stale = new Date(Date.now() - 5 * 60000).toISOString(); // well past resumeDropSequence's 2-minute staleness threshold
  env.UPS_MFL_DB.raw.prepare(
    `INSERT INTO ups_trade_executions (league_id, season, exec_key, kind, state, steps_json, created_at_utc, updated_at_utc)
     VALUES ('74598', '2026', ?, 'two_way_staged_drop_first', ?, ?, ?, ?)`
  ).run(id, state || "executing", JSON.stringify(stepsJson), stale, stale);
}
async function stageTwoDropDeal(env, mfl) {
  mfl.st.rosters[FR.A] = [...fiveLoaded(80000), loaded("80005"), loaded("80006"), flat("90000")]; // 7 loaded, required=2
  mfl.st.rosters[FR.B] = [flat("13100")];
  const created = await createStaged2WayTrade(env, {}, CREATE_SPEC());
  await select2WayLoadedContractDrops(env, created.id, { fid: FR.A, leagueId: "74598", season: "2026" }, ["80000", "80001"]);
  const ctx = { waitUntil: (p) => p };
  await accept2WayTrade(env, ctx, created.id, { fid: FR.B, leagueId: "74598", season: "2026" }, {});
  return created.id;
}

test("RECONCILIATION — CRASH BETWEEN MFL CONFIRMING AND THE LEDGER RECORDING IT: drop 80000 already landed on MFL (a matching FREE_AGENT transaction record exists), but its own step was only ever recorded 'attempting' (simulating the exact window Keith flagged) -- a resume RECONCILES it as confirmed via the transaction record, WITHOUT calling unload_player again, then proceeds to drop 80001 and the trade", async () => {
  const { env, mfl } = fresh({ TRADE_2WAY_DROP_EXECUTE_ENABLED: "1" });
  const id = await stageTwoDropDeal(env, mfl);
  const attemptIso = new Date(Date.now() - 6 * 60000).toISOString();
  // The write actually happened -- both signals agree: the roster reflects it AND MFL's own
  // transaction log has a matching record (the authoritative evidence Keith requires).
  mfl.st.rosters[FR.A] = mfl.st.rosters[FR.A].filter((p) => p.id !== "80000");
  mfl.st.transactions = [freeAgentDropTx(FR.A, "80000", Math.floor(Date.parse(attemptIso) / 1000) + 5)];
  seedCrashedAttempt(env, id, { "drop:80000": { status: "attempting", franchise_id: FR.A, player_id: "80000", pre_drop_snapshot: SNAP_80000, attempted_at_utc: attemptIso } });
  const calls = installFakeUnloadPlayer(env, confirmedResp);
  const r = await executeDropFirstDeal(env, {}, id);
  t.equal(r.ok, true, JSON.stringify(r));
  t.equal(calls.length, 1, "unload_player must be called for 80001 only -- NEVER again for 80000, which was reconciled, not re-attempted");
  t.equal(calls[0].player_id, "80001");
  const led = ledgerRow(env, id);
  const steps = JSON.parse(led.steps_json);
  t.equal(steps["drop:80000"].status, "confirmed");
  t.equal(steps["drop:80000"].reconciled, true, "must be flagged as a RECONCILED confirmation, never silently indistinguishable from a direct one");
  t.ok(steps["drop:80000"].mfl_evidence, "must record the ACTUAL transaction evidence used, not just an inference from presence");
  t.equal(steps["drop:80000"].pre_drop_snapshot.contractStatus, "Vet-BL", "the ORIGINAL pre-drop snapshot survives the reconciliation, not a fresh (impossible, since the player is gone) or blank one");
  t.equal(steps["drop:80001"].status, "confirmed");
  t.equal(led.state, "completed");
});

test("RECONCILIATION — UNCONFIRMED THEN RETRIED, PLAYER STILL PRESENT AND NO MATCHING TRANSACTION: the earlier write genuinely never landed -- BOTH signals agree (present + no transaction record) -- a resume safely RE-ATTEMPTS the same step (calls unload_player again) rather than assuming it already happened", async () => {
  const { env, mfl } = fresh({ TRADE_2WAY_DROP_EXECUTE_ENABLED: "1" });
  const id = await stageTwoDropDeal(env, mfl);
  // 80001 is STILL on the roster, and MFL's transaction log has NO record of it being dropped --
  // the earlier ambiguous attempt did NOT actually drop them.
  seedCrashedAttempt(env, id, {
    "drop:80000": { status: "confirmed", franchise_id: FR.A, player_id: "80000", pre_drop_snapshot: SNAP_80000, confirmed_at_utc: new Date(Date.now() - 6 * 60000).toISOString() },
    "drop:80001": { status: "unconfirmed", franchise_id: FR.A, player_id: "80001", reason: "call_failed: network timeout", pre_drop_snapshot: SNAP_80000, attempted_at_utc: new Date(Date.now() - 6 * 60000).toISOString() },
  }, "executed_needs_review");
  mfl.st.rosters[FR.A] = mfl.st.rosters[FR.A].filter((p) => p.id !== "80000"); // 80000's drop DID really happen
  mfl.st.transactions = []; // no record of 80001 anywhere
  const calls = installFakeUnloadPlayer(env, confirmedResp);
  const r = await executeDropFirstDeal(env, {}, id);
  t.equal(r.ok, true, JSON.stringify(r));
  t.equal(calls.length, 1, "80000 is skipped (already confirmed); 80001 is RE-ATTEMPTED for real, since reconciliation found them still present with no transaction evidence");
  t.equal(calls[0].player_id, "80001");
  t.equal(ledgerRow(env, id).state, "completed");
});

test("RECONCILIATION EVIDENCE SOURCE ITSELF FAILS: never guesses either outcome -- holds for commissioner review rather than falling back to a weaker signal", async () => {
  const { env, mfl } = fresh({ TRADE_2WAY_DROP_EXECUTE_ENABLED: "1" });
  const id = await stageTwoDropDeal(env, mfl);
  seedCrashedAttempt(env, id, { "drop:80000": { status: "attempting", franchise_id: FR.A, player_id: "80000", pre_drop_snapshot: SNAP_80000, attempted_at_utc: new Date(Date.now() - 6 * 60000).toISOString() } });
  // Break the evidence sources themselves (not the drop-write route) -- no MFL_APIKEY means
  // BOTH findFreeAgentDropTransaction (the primary, authoritative evidence) and
  // fetchLiveRosterRow (the secondary corroborating check) cannot ask MFL anything.
  env.MFL_APIKEY = "";
  const calls = installFakeUnloadPlayer(env, confirmedResp);
  const r = await executeDropFirstDeal(env, {}, id);
  t.equal(r.ok, false);
  t.equal(calls.length, 0, "when we can't even READ the evidence, we never guess by writing OR by assuming a prior success");
  const led = ledgerRow(env, id);
  t.equal(led.state, "executed_needs_review");
  t.match(led.failure_detail, /reconciliation_transaction_log_unavailable/);
});

test("RECONCILIATION — AN ORPHANED ATTEMPTING STEP (no longer part of the recomputed required set) is reconciled via the transaction record for auditability WITHOUT re-attempting a write or blocking the still-required step", async () => {
  const { env, mfl } = fresh({ TRADE_2WAY_DROP_EXECUTE_ENABLED: "1" });
  const id = await stageTwoDropDeal(env, mfl);
  const attemptIso = new Date(Date.now() - 6 * 60000).toISOString();
  // 80000 truly landed (roster reflects it, AND MFL's transaction log has the matching record)
  // -- which ALSO means the fresh required-drops count recomputes down to 1 (80001 only), so
  // 80000 falls OUT of the main loop's `steps` entirely. This is the exact scenario the orphan
  // pre-pass exists for.
  mfl.st.rosters[FR.A] = mfl.st.rosters[FR.A].filter((p) => p.id !== "80000");
  mfl.st.transactions = [freeAgentDropTx(FR.A, "80000", Math.floor(Date.parse(attemptIso) / 1000) + 5)];
  seedCrashedAttempt(env, id, { "drop:80000": { status: "attempting", franchise_id: FR.A, player_id: "80000", pre_drop_snapshot: SNAP_80000, attempted_at_utc: attemptIso } });
  const calls = installFakeUnloadPlayer(env, confirmedResp);
  const r = await executeDropFirstDeal(env, {}, id);
  t.equal(r.ok, true, JSON.stringify(r));
  t.equal(calls.length, 1, "only 80001 is written -- 80000 is reconciled via the orphan pass, never re-attempted");
  const steps = JSON.parse(ledgerRow(env, id).steps_json);
  t.equal(steps["drop:80000"].status, "confirmed");
  t.equal(steps["drop:80000"].reconciled, true);
  t.ok(steps["drop:80000"].mfl_evidence, "reconciled via the transaction record, not presence alone");
  t.match(steps["drop:80000"].reason, /no_longer_required/);
});

test("RECONCILIATION — AN ORPHANED step that is STILL genuinely present (never happened) is left as-is, not silently marked confirmed and not escalated over a step nothing currently requires", async () => {
  const { env, mfl } = fresh({ TRADE_2WAY_DROP_EXECUTE_ENABLED: "1" });
  // A single-drop deal (required=1): seed an UNRELATED orphan step referencing a player who was
  // never actually part of this requirement, still present on the roster.
  const id = await stageAcceptWithDrop(env, mfl, { senderLoadedIds: ["80000", "80001", "80002", "80003", "80004", "80005"], dropPlayerId: "80000" });
  seedCrashedAttempt(env, id, { "drop:99999": { status: "attempting", franchise_id: FR.A, player_id: "99999", pre_drop_snapshot: SNAP_80000, attempted_at_utc: new Date(Date.now() - 6 * 60000).toISOString() } });
  mfl.st.rosters[FR.A].push(flat("99999")); // genuinely still there -- an unrelated, never-actually-attempted phantom
  const calls = installFakeUnloadPlayer(env, confirmedResp);
  const r = await executeDropFirstDeal(env, {}, id);
  t.equal(r.ok, true, JSON.stringify(r));
  t.equal(calls.length, 1, "only the real required drop (80000) is written -- the orphan is neither written to nor confirmed");
  t.equal(calls[0].player_id, "80000");
  const steps = JSON.parse(ledgerRow(env, id).steps_json);
  t.equal(steps["drop:99999"].status, "attempting", "left exactly as it was -- never silently marked confirmed for a player who is demonstrably still there");
});

// ═══════ THE TWO INTERVENING-CHANGE CASES (Keith, 2026-09-30) ═══════
// "Roster presence alone does not prove what happened. A player could disappear for another
// reason, or be dropped and re-added before reconciliation." Both cases below would have been
// misjudged by the PRIOR (presence-only) reconciliation logic -- this is exactly why it was
// replaced with evidence tied to the franchise, player, and attempt (findFreeAgentDropTransaction).

test("INTERVENING CHANGE, CASE A — player absent for an UNRELATED reason (no matching transaction record for OUR attempt): must NOT be assumed to be our own drop -- holds for commissioner review instead of silently marking confirmed", async () => {
  const { env, mfl } = fresh({ TRADE_2WAY_DROP_EXECUTE_ENABLED: "1" });
  const id = await stageTwoDropDeal(env, mfl);
  const attemptIso = new Date(Date.now() - 6 * 60000).toISOString();
  seedCrashedAttempt(env, id, { "drop:80000": { status: "attempting", franchise_id: FR.A, player_id: "80000", pre_drop_snapshot: SNAP_80000, attempted_at_utc: attemptIso } });
  // 80000 IS gone from the roster -- but for a reason that has NOTHING to do with our attempt
  // (an unrelated waiver claim, a different owner's own action, etc.). Represented here as: no
  // matching FREE_AGENT transaction for FR.A/80000 exists at all -- the PRIOR (presence-only)
  // logic would have wrongly reconciled this as "our own drop succeeded."
  mfl.st.rosters[FR.A] = mfl.st.rosters[FR.A].filter((p) => p.id !== "80000");
  mfl.st.transactions = [freeAgentDropTx("0003", "70000", Math.floor(Date.parse(attemptIso) / 1000) + 10)]; // a real transaction, but for someone else entirely
  const calls = installFakeUnloadPlayer(env, confirmedResp);
  const r = await executeDropFirstDeal(env, {}, id);
  t.equal(r.ok, false);
  t.equal(calls.length, 0, "MUST NOT re-attempt a write for a step reconciliation could not confirm either way");
  const led = ledgerRow(env, id);
  t.equal(led.state, "executed_needs_review");
  t.match(led.failure_detail, /reconciliation_absent_without_matching_transaction/);
  const steps = JSON.parse(led.steps_json);
  t.notEqual(steps["drop:80000"].status, "confirmed", "must NEVER be marked confirmed on absence alone, with no evidence tying the disappearance to OUR OWN attempt");
  t.equal(steps["drop:80000"].status, "unconfirmed");
});

test("INTERVENING CHANGE, CASE B — player dropped for real, then RE-ADDED to the same roster before reconciliation runs: presence alone would wrongly say 'never happened, retry' -- the matching transaction record must win, confirming without a second write", async () => {
  const { env, mfl } = fresh({ TRADE_2WAY_DROP_EXECUTE_ENABLED: "1" });
  const id = await stageTwoDropDeal(env, mfl);
  const attemptIso = new Date(Date.now() - 6 * 60000).toISOString();
  seedCrashedAttempt(env, id, { "drop:80000": { status: "attempting", franchise_id: FR.A, player_id: "80000", pre_drop_snapshot: SNAP_80000, attempted_at_utc: attemptIso } });
  // The drop genuinely happened (a real transaction exists) -- but the player was RE-ADDED to
  // the SAME franchise's roster before this reconciliation run (a commissioner's own manual
  // reinstatement, an automated re-add, whatever the cause). Presence-only logic would see them
  // back on the roster and conclude "the original attempt never landed -- safe to retry," which
  // would misrepresent a real, already-charged drop as never having happened.
  mfl.st.transactions = [freeAgentDropTx(FR.A, "80000", Math.floor(Date.parse(attemptIso) / 1000) + 5)];
  // (roster left untouched by the test -- 80000 is still present in mfl.st.rosters[FR.A], simulating the re-add)
  const calls = installFakeUnloadPlayer(env, confirmedResp);
  const r = await executeDropFirstDeal(env, {}, id);
  t.equal(r.ok, true, JSON.stringify(r));
  t.equal(calls.length, 1, "80000 must NOT be re-attempted -- only 80001 (the genuinely still-outstanding drop) is written");
  t.equal(calls[0].player_id, "80001");
  const steps = JSON.parse(ledgerRow(env, id).steps_json);
  t.equal(steps["drop:80000"].status, "confirmed");
  t.equal(steps["drop:80000"].reconciled, true);
  t.ok(steps["drop:80000"].mfl_evidence, "confirmed via the transaction record even though presence alone would have said otherwise");
  t.equal(ledgerRow(env, id).state, "completed");
});

// Idempotency scope, stated precisely rather than claimed in general (Keith: "Do not describe
// retries as idempotent beyond what those tests and MFL's actual behavior establish"): the three
// tests above establish that a retry (a) never repeats a step already recorded `confirmed`,
// (b) reconciles against a LIVE roster read before deciding on any step recorded `attempting`/
// `unconfirmed`, confirming it without a write when the player is already gone and re-attempting
// the write when they are not, and (c) holds rather than guesses when even that reconciliation
// read fails. This is NOT a claim that /roster-workbench/action's own internal retry behavior,
// or MFL's response to an literal identical double-POST, has been independently verified here --
// only that THIS orchestrator never blindly re-issues a write for a step it has reason to think
// already succeeded.

await run("trade_2way_drop_first_execute");
restoreConsole();
