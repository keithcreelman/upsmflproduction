// The 2-way CUTOVER switch (worker/src/index.js's TRADE_2WAY_CUTOVER_ENABLED gate on the
// legacy /trade-offers /api/trades/proposals CREATE route and its COUNTER action, plus
// trade_2way.js's safety interlock). Keith's ruling (2026-09-29): "Keeping 'Stage via War
// Room' beside the existing direct-MFL Send button leaves an in-app bypass... the legacy
// creation endpoint must also refuse direct creation server-side while staging is enabled.
// Hiding a button alone is insufficient." Covers exactly what was asked: stale clients calling
// the legacy endpoint directly, feature-flag transitions, and rollback without losing staged
// offers. Real worker, real D1, a stateful fake MFL -- no mocked gate logic.
//   node tests/trade_2way_cutover_switch.test.mjs
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet, COMMISH_COOKIE, ADMIN_KEY } from "./fixtures/worker_harness.mjs";
import { THREE_WAY_MIGRATIONS } from "./fixtures/d1_sqlite.mjs";

const restoreConsole = quiet();
const Q = "L=74598&YEAR=2026";
const MIGRATIONS = [...THREE_WAY_MIGRATIONS, "0162_ups_trade_cap_acknowledgments.sql", "0163_ups_trade_conditional_drops.sql", "0164_ups_2way_trades.sql"];

function fresh(over) {
  const env = makeWorkerEnv({ __migrations: MIGRATIONS, ...((over && over.env) || {}) });
  const mfl = makeMfl(over && over.mfl);
  mfl.install();
  mfl.st.rosters["0001"] = [{ id: "14056", salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }];
  mfl.st.rosters["0002"] = [{ id: "13100", salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }];
  return { env, mfl };
}
const asset = (pid, salary) => ({ asset_id: `player:${pid}`, type: "PLAYER", player_id: String(pid), player_name: `P${pid}`, salary, taxi: false });
const legacyBody = (from = "0001", to = "0002", pidFrom = 14056, pidTo = 13100) => ({
  league_id: "74598", season: "2026", from_franchise_id: from, to_franchise_id: to,
  from_franchise_name: "x", to_franchise_name: "y", message: "",
  payload: {
    schema_version: 1, source: "test", league_id: "74598", season: "2026",
    teams: [
      { role: "left", franchise_id: from, selected_assets: [asset(pidFrom, 5000)], traded_salary_adjustment_dollars: 0, traded_salary_adjustment_k: 0, selected_non_taxi_salary_dollars: 5000 },
      { role: "right", franchise_id: to, selected_assets: [asset(pidTo, 5000)], traded_salary_adjustment_dollars: 0, traded_salary_adjustment_k: 0, selected_non_taxi_salary_dollars: 5000 },
    ],
    extension_requests: [], ui: { left_team_id: from, right_team_id: to }, validation: { status: "ready" },
  },
});
const legacyCreate = (env, over) => callWorker(env, "POST", `/trade-offers?${Q}&MFL_USER_ID=tok-B`, { body: legacyBody(...(over || [])) });

// ═══════════════════════════════════ BEFORE THE SWITCH: preserve current behavior ═══════════════════════════════════

test("BEFORE CUTOVER (default off): the legacy create endpoint behaves exactly as today -- a real native MFL trade is proposed", async () => {
  const { env, mfl } = fresh();
  const r = await legacyCreate(env);
  t.equal(r.status, 201, JSON.stringify(r.json));
  t.ok(r.json.ok);
  t.equal(r.json.mode, "direct_mfl");
  const proposeImport = mfl.st.imports.find((i) => i.type === "tradeProposal");
  t.ok(proposeImport, "a real MFL tradeProposal import must have happened -- pre-cutover behavior is completely unchanged");
});

// ═══════════════════════════════════ STALE CLIENTS ═══════════════════════════════════

test("STALE CLIENT: a client calling the legacy CREATE endpoint directly (as if it never got the UI update) is refused server-side once cutover is on -- ZERO MFL writes, whatever button or code version sent it", async () => {
  const { env, mfl } = fresh({ env: { TRADE_2WAY_CUTOVER_ENABLED: "1" } });
  const r = await legacyCreate(env);
  t.equal(r.status, 409);
  t.equal(r.json.code, "staging_required");
  t.equal(mfl.st.imports.length, 0, "no MFL import of any kind -- the refusal happens before any MFL call");
});

test("STALE CLIENT: the legacy COUNTER action is ALSO refused once cutover is on, and -- critically -- the ORIGINAL native offer is never rejected either (checked before any side effect, not after)", async () => {
  const { env, mfl } = fresh({ env: { TRADE_2WAY_CUTOVER_ENABLED: "1" } });
  const tid = mfl.addPending({ offeringteam: "0002", offeredto: "0001", will_give_up: "13100,", will_receive: "14056," });
  const r = await callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-B`, {
    body: { action: "COUNTER", trade_id: tid, league_id: "74598", season: "2026", franchise_id: "0001", acting_franchise_id: "0001",
      counter_offer: { from_franchise_id: "0001", to_franchise_id: "0002", payload: legacyBody("0001", "0002").payload, message: "" } },
  });
  t.equal(r.status, 409);
  t.equal(r.json.code, "staging_required");
  t.equal(mfl.st.imports.length, 0, "the original offer must NOT have been rejected -- the gate runs before any side effect");
  const stillPending = mfl.st.pending.find((p) => p.trade_id === tid);
  t.ok(stillPending, "the original native offer is untouched, still pending");
});

test("EXISTING NATIVE OFFERS UNAFFECTED: cutover blocks NEW creation only -- an owner can still ACCEPT a native offer that already existed before cutover", async () => {
  const { env, mfl } = fresh({ env: { TRADE_2WAY_CUTOVER_ENABLED: "1" } });
  const tid = mfl.addPending({ offeringteam: "0001", offeredto: "0002", will_give_up: "14056,", will_receive: "13100," });
  const r = await callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-C`, {
    body: { action: "ACCEPT", trade_id: tid, league_id: "74598", season: "2026", franchise_id: "0002", acting_franchise_id: "0002" },
  });
  t.equal(r.status, 200, JSON.stringify(r.json));
  t.ok(r.json.ok, "accepting a pre-existing native offer must still work -- cutover never touches actions on offers that already exist");
});

// ═══════════════════════════════════ SAFETY INTERLOCK ═══════════════════════════════════

test("SAFETY INTERLOCK: cutover ON alone (plain staging flag left OFF/unset) still permits STAGED creation -- turning on cutover can never brick 2-way trade creation league-wide", async () => {
  const { env } = fresh({ env: { TRADE_2WAY_CUTOVER_ENABLED: "1" } }); // TRADE_2WAY_STAGING_ENABLED intentionally NOT set
  const r = await callWorker(env, "POST", `/api/trades/2way?${Q}&MFL_USER_ID=tok-B`, {
    body: { from: { fid: "0001", name: "x" }, to: { fid: "0002", name: "y" }, movements: [{ from: "0001", to: "0002", asset_tokens: ["14056"] }] },
  });
  t.equal(r.status, 201, JSON.stringify(r.json));
  t.ok(r.json.staged);
});

// ═══════════════════════════════════ FEATURE-FLAG TRANSITIONS ═══════════════════════════════════

test("FLAG TRANSITION: off -> on -> off is clean and fully reversible -- legacy create works, then is refused, then works again, with no lingering state from the refused attempt", async () => {
  const { env, mfl } = fresh();
  const r1 = await legacyCreate(env, ["0001", "0002", 14056, 13100]);
  t.equal(r1.status, 201);
  const proposeCountAfterFirst = mfl.st.imports.filter((i) => i.type === "tradeProposal").length;
  t.equal(proposeCountAfterFirst, 1);

  // The harness's env object is a plain object -- flip the flag by re-setting it directly,
  // matching how getFeatureFlag reads a live D1/env override in production.
  env.TRADE_2WAY_CUTOVER_ENABLED = "1";
  mfl.st.rosters["0001"].push({ id: "14057", salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" });
  const r2 = await legacyCreate(env, ["0001", "0002", 14057, 13100]);
  t.equal(r2.status, 409);
  t.equal(r2.json.code, "staging_required");
  t.equal(mfl.st.imports.filter((i) => i.type === "tradeProposal").length, 1, "the refused attempt added zero new MFL proposals");

  env.TRADE_2WAY_CUTOVER_ENABLED = "0";
  mfl.st.rosters["0001"].push({ id: "14058", salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" });
  const r3 = await legacyCreate(env, ["0001", "0002", 14058, 13100]);
  t.equal(r3.status, 201, JSON.stringify(r3.json));
  t.equal(mfl.st.imports.filter((i) => i.type === "tradeProposal").length, 2, "flipping cutover back off restores the exact original behavior");
});

// ═══════════════════════════════════ ROLLBACK WITHOUT LOSING STAGED OFFERS ═══════════════════════════════════

test("ROLLBACK: staged offers created while cutover was ON survive a rollback (cutover flipped back OFF) fully intact -- detail GET, accept, and cancel all keep working exactly as before, since cutover only ever gates the LEGACY create route and never touches ups_2way_trades", async () => {
  const { env, mfl } = fresh({ env: { TRADE_2WAY_CUTOVER_ENABLED: "1", TRADE_2WAY_STAGING_ENABLED: "1" } });
  const created = await callWorker(env, "POST", `/api/trades/2way?${Q}&MFL_USER_ID=tok-B`, {
    body: { from: { fid: "0001", name: "L.A. Looks" }, to: { fid: "0002", name: "CBP" }, movements: [{ from: "0001", to: "0002", asset_tokens: ["14056"] }] },
  });
  t.equal(created.status, 201, JSON.stringify(created.json));
  const id = created.json.id;

  // Rollback: cutover OFF (staging flag can stay on or off -- either way the STAGED trade
  // already in D1 must be unaffected; here we roll back cutover only, as the least invasive
  // rollback -- the legacy path reopens, and the already-staged offer is untouched).
  env.TRADE_2WAY_CUTOVER_ENABLED = "0";

  const detail = await callWorker(env, "GET", `/api/trades/2way?id=${id}&${Q}&MFL_USER_ID=tok-B`);
  t.equal(detail.status, 200);
  t.equal(detail.json.trade.id, id);
  t.equal(detail.json.trade.status, "collecting", "the staged trade is exactly as it was -- rollback did not touch it");

  const accept = await callWorker(env, "POST", `/api/trades/2way/accept?${Q}&MFL_USER_ID=tok-C`, { body: { id } });
  t.ok(accept.json.ok, JSON.stringify(accept.json));

  const cancelCreated = await callWorker(env, "POST", `/api/trades/2way?${Q}&MFL_USER_ID=tok-B`, {
    body: { from: { fid: "0001", name: "L.A. Looks" }, to: { fid: "0002", name: "CBP" }, movements: [{ from: "0002", to: "0001", asset_tokens: ["13100"] }] },
  });
  const cancel = await callWorker(env, "POST", `/api/trades/2way/cancel?${Q}&MFL_USER_ID=tok-B`, { body: { id: cancelCreated.json.id, reason: "test" } });
  t.ok(cancel.json.ok);
  t.equal(mfl.st.imports.filter((i) => i.type === "tradeProposal").length, 0, "nothing staged before or across the rollback ever became a real MFL trade");
});

await run("trade_2way_cutover_switch");
restoreConsole();
