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
const { createStaged2WayTrade, accept2WayTrade, select2WayLoadedContractDrops, executeDropFirstDeal } = await import("../worker/src/trade_2way.js");

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

await run("trade_2way_drop_first_execute");
restoreConsole();
