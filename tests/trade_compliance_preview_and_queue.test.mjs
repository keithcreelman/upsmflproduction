// POST /api/trades/compliance-preview and GET /api/trades/2way/queue — the two new
// surfaces built to satisfy Keith's ruling (2026-09-29): a clear popup BEFORE an owner sends
// a two-team or three-team offer showing the projected loaded-contract count for EACH
// affected team, and a read-only commissioner review queue (no execute/drop button).
// Both run through the REAL worker (worker/src/index.js), a stateful MFL stub, and real D1.
//
// NOTE on franchise ids: per _rdhCommishFids' real, documented default (worker/src/index.js),
// franchise 0008 (Real Deal Creel) IS the actual commissioner franchise in this league, and
// 0000 is the second commish pseudo-id -- NOT 0001. Every test here that needs a genuinely
// ORDINARY (non-commissioner) owner uses 0001/0002/0003, never 0008.
//
// Run: node tests/trade_compliance_preview_and_queue.test.mjs
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet, COMMISH_COOKIE, ADMIN_KEY, bindSelf } from "./fixtures/worker_harness.mjs";
import { THREE_WAY_MIGRATIONS } from "./fixtures/d1_sqlite.mjs";

const restoreConsole = quiet();
const Q = "L=74598&YEAR=2026";
// ups_2way_trades (0164) plus the cap-ack/conditional-drop stores the queue reads -- the
// stores self-create on demand, but the trades table itself only exists via its migration.
const MIGRATIONS = [...THREE_WAY_MIGRATIONS, "0162_ups_trade_cap_acknowledgments.sql", "0163_ups_trade_conditional_drops.sql", "0164_ups_2way_trades.sql"];

function fresh(over) {
  const envOver = { __migrations: MIGRATIONS, ...((over && over.env) || {}) };
  const env = makeWorkerEnv(envOver);
  bindSelf(env); // the queue reads compliance via env.SELF, exactly like accept2WayTrade/capGate2Way do
  const mfl = makeMfl(over && over.mfl);
  mfl.install();
  return { env, mfl };
}
// A flat, resolvable Vet-FAA contract -- never itself "loaded", so it never contaminates a
// loaded-contract count test by accident.
const flat = (id) => ({ id, salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" });
// A genuinely LOADED (back-loaded) 2-year contract: Y1 < Y2, real -BL suffix.
const loaded = (id) => ({ id, salary: "5000", contractYear: "2", contractStatus: "Vet-BL", contractInfo: "CL 2|TCV 20K|AAV 10K|Y1-5K|Y2-15K" });
const fiveLoaded = (start) => [0, 1, 2, 3, 4].map((i) => loaded(String(start + i)));

// ═══════════════════════════════════ compliance-preview ═══════════════════════════════════

test("PREVIEW: auth -- signed out is 401, an unrelated owner (not a party, not commissioner) is 403", async () => {
  const { env } = fresh();
  const body = { league_id: "74598", season: "2026", from_franchise_id: "0001", movements: [{ from: "0001", to: "0002", asset_tokens: ["14056"] }] };
  const signedOut = await callWorker(env, "POST", `/api/trades/compliance-preview?${Q}`, { body });
  t.equal(signedOut.status, 401);

  const unrelated = await callWorker(env, "POST", `/api/trades/compliance-preview?${Q}&MFL_USER_ID=tok-O`, { body }); // tok-O = 0003, not a party
  t.equal(unrelated.status, 403);
});

test("PREVIEW: a genuinely non-commissioner owner claiming a DIFFERENT franchise's identity is refused, never trusted -- 0008 is the real commissioner and is deliberately excluded from this test", async () => {
  const { env } = fresh();
  const body = { league_id: "74598", season: "2026", from_franchise_id: "0003", movements: [{ from: "0001", to: "0002", asset_tokens: ["14056"] }] };
  const r = await callWorker(env, "POST", `/api/trades/compliance-preview?${Q}&MFL_USER_ID=tok-B`, { body }); // tok-B is 0001, body claims 0003
  t.equal(r.status, 403);
});

test("PREVIEW: shows the RECIPIENT's projected loaded-contract count too, not just the sender's own side -- 0001 is already at 5 and RECEIVES a 6th loaded asset from 0008", async () => {
  const { env, mfl } = fresh();
  mfl.st.rosters["0008"] = [loaded("30000"), flat("16614")];
  mfl.st.rosters["0001"] = [...fiveLoaded(20001), flat("14056")];
  const body = {
    league_id: "74598", season: "2026", from_franchise_id: "0008",
    movements: [{ from: "0008", to: "0001", asset_tokens: ["30000"] }, { from: "0001", to: "0008", asset_tokens: ["14056"] }],
  };
  const r = await callWorker(env, "POST", `/api/trades/compliance-preview?${Q}&MFL_USER_ID=tok-A`, { body });
  t.equal(r.status, 200);
  t.ok(r.json.ok);
  const lc = r.json.compliance.loaded_contracts;
  t.equal(lc.status, "blocked");
  const req0001 = (lc.drop_requirements || []).find((d) => d.franchise_id === "0001");
  t.ok(req0001, "the RECIPIENT's own requirement must be present -- this is the whole point of the fix");
  t.equal(req0001.loaded_before, 5);
  t.equal(req0001.projected, 6, "receiving one MORE loaded asset while already at 5 pushes to 6");
  t.equal(req0001.required_drops, 1);
  const req0008 = (lc.drop_requirements || []).find((d) => d.franchise_id === "0008");
  t.equal(req0008, undefined, "the sender never had a violation here -- it must not appear as a false positive");
  t.equal(mfl.st.imports.length, 0, "a preview must never write to MFL");
});

test("PREVIEW: also shows the SENDER's own projected count, symmetric with the recipient -- 0008 (already at 5) RECEIVES a 6th loaded asset from 0001", async () => {
  const { env, mfl } = fresh();
  mfl.st.rosters["0008"] = [...fiveLoaded(40000), flat("16614")]; // already at 5
  mfl.st.rosters["0001"] = [loaded("21001")];
  const body = { league_id: "74598", season: "2026", from_franchise_id: "0008", movements: [{ from: "0001", to: "0008", asset_tokens: ["21001"] }] };
  const r = await callWorker(env, "POST", `/api/trades/compliance-preview?${Q}&MFL_USER_ID=tok-A`, { body });
  t.equal(r.status, 200);
  const lc = r.json.compliance.loaded_contracts;
  t.equal(lc.status, "blocked");
  const req0008 = (lc.drop_requirements || []).find((d) => d.franchise_id === "0008");
  t.ok(req0008, "the SENDER's own projected count (now receiving a 6th loaded asset) must be shown");
  t.equal(req0008.loaded_before, 5);
  t.equal(req0008.projected, 6);
  t.equal(req0008.required_drops, 1);
});

test("PREVIEW: no assets moved / malformed movements are a clean 400, never a silent empty compliance object", async () => {
  const { env } = fresh();
  const none = await callWorker(env, "POST", `/api/trades/compliance-preview?${Q}&MFL_USER_ID=tok-B`, { body: { league_id: "74598", season: "2026", from_franchise_id: "0001", movements: [] } });
  t.equal(none.status, 400);
  const sameTeam = await callWorker(env, "POST", `/api/trades/compliance-preview?${Q}&MFL_USER_ID=tok-B`, { body: { league_id: "74598", season: "2026", from_franchise_id: "0001", movements: [{ from: "0001", to: "0001", asset_tokens: ["16614"] }] } });
  t.equal(sameTeam.status, 400);
});

test("PREVIEW: the commissioner can preview any pair without being a party to it", async () => {
  const { env } = fresh();
  const body = { league_id: "74598", season: "2026", from_franchise_id: "0002", movements: [{ from: "0002", to: "0003", asset_tokens: ["13100"] }] };
  const r = await callWorker(env, "POST", `/api/trades/compliance-preview?${Q}&MFL_USER_ID=tok-commish`, { headers: { Cookie: COMMISH_COOKIE }, body });
  t.equal(r.status, 200);
});

// ═══════════════════════════════════ 2way/queue (commissioner, read-only) ═══════════════════════════════════

function createStaged(env, over) {
  return callWorker(env, "POST", `/api/trades/2way?${Q}&MFL_USER_ID=tok-B`, {
    body: { from: { fid: "0001", name: "L.A. Looks" }, to: { fid: "0002", name: "CBP" }, movements: [{ from: "0001", to: "0002", asset_tokens: ["14056"] }], ...(over || {}) },
  });
}

test("QUEUE: a genuinely ordinary owner (proven session, but not commissioner) is refused -- commissioner only", async () => {
  const { env } = fresh({ env: { TRADE_2WAY_STAGING_ENABLED: "1" } });
  const r = await callWorker(env, "GET", `/api/trades/2way/queue?${Q}&MFL_USER_ID=tok-B`);
  t.equal(r.status, 403);
});

test("QUEUE: signed out is 401, not a silent empty queue", async () => {
  const { env } = fresh({ env: { TRADE_2WAY_STAGING_ENABLED: "1" } });
  const r = await callWorker(env, "GET", `/api/trades/2way/queue?${Q}`);
  t.equal(r.status, 401);
});

test("QUEUE: the admin key works without any session at all, and an empty league returns an empty list, not an error", async () => {
  const { env } = fresh({ env: { TRADE_2WAY_STAGING_ENABLED: "1" } });
  const r = await callWorker(env, "GET", `/api/trades/2way/queue?${Q}&APIKEY=${ADMIN_KEY}`);
  t.equal(r.status, 200);
  t.deepEqual(r.json.trades, []);
});

test("QUEUE: a proven commissioner SESSION also works (not just the raw admin key, and not the franchise-0008-owner session either) -- and lists a real staged trade with fresh compliance, cap-ack, ledger state and age, all computed live", async () => {
  const { env, mfl } = fresh({ env: { TRADE_2WAY_STAGING_ENABLED: "1" } });
  mfl.st.rosters["0001"] = [flat("14056")];
  mfl.st.rosters["0002"] = [flat("13100")];
  const created = await createStaged(env);
  t.equal(created.status, 201, JSON.stringify(created.json));

  const r = await callWorker(env, "GET", `/api/trades/2way/queue?${Q}&MFL_USER_ID=tok-commish`, { headers: { Cookie: COMMISH_COOKIE } });
  t.equal(r.status, 200);
  t.equal(r.json.trades.length, 1);
  const row = r.json.trades[0];
  t.equal(row.id, created.json.id);
  t.equal(row.from_fid, "0001");
  t.equal(row.to_fid, "0002");
  t.ok(row.compliance, "fresh compliance must be present");
  t.equal(row.compliance.loaded_contracts.status, "ok");
  t.equal(row.ledger, null, "nothing has tried to execute yet -- no ledger row exists");
  t.equal(typeof row.age_hours_since_created, "number");
  t.equal(row.age_hours_since_updated, row.age_hours_since_created, "just created -- both ages start equal");
  t.equal(row.state_view.code, "pending_response");
  // No execution affordance anywhere on this read-only object.
  t.equal(row.permissions.can_accept, false, "the commissioner viewer isn't the recipient -- this must never look like the commissioner can accept on someone's behalf via this surface");
});

test("QUEUE: a cap overage shows fresh cap_ack status (unacknowledged), and it is unaffected by this GET -- no write happens just from viewing", async () => {
  const { env, mfl } = fresh({ env: { TRADE_2WAY_STAGING_ENABLED: "1" } });
  mfl.st.rosters["0001"] = [{ id: "14056", salary: "295000" }]; // a single huge contract, at the edge of the $300k cap
  mfl.st.rosters["0002"] = [flat("13100")];
  const created = await createStaged(env, { movements: [{ from: "0002", to: "0001", asset_tokens: ["13100"] }] }); // 0001 receives, doesn't lose its big contract
  t.equal(created.status, 201, JSON.stringify(created.json));
  const r = await callWorker(env, "GET", `/api/trades/2way/queue?${Q}&APIKEY=${ADMIN_KEY}`);
  t.equal(r.status, 200);
  const row = r.json.trades[0];
  if (row.compliance.cap.status === "blocked") {
    t.ok(row.cap_ack, "cap_ack must be populated when a live cap violation exists");
    t.equal(row.cap_ack.satisfied, false, "nobody acknowledged anything -- viewing the queue must never satisfy it");
  }
  t.equal(mfl.st.imports.length, 0, "the queue is read-only -- zero MFL writes from listing it");
});

test("QUEUE: a cancelled trade drops out of the default (active/failed only) view, and no row exposes any execute/drop action field", async () => {
  const { env, mfl } = fresh({ env: { TRADE_2WAY_STAGING_ENABLED: "1" } });
  mfl.st.rosters["0001"] = [flat("14056")];
  mfl.st.rosters["0002"] = [flat("13100")];
  const created = await createStaged(env);
  t.equal(created.status, 201, JSON.stringify(created.json));
  const cancel = await callWorker(env, "POST", `/api/trades/2way/cancel?${Q}&MFL_USER_ID=tok-B`, { body: { id: created.json.id, reason: "test" } });
  t.ok(cancel.json.ok);
  const r = await callWorker(env, "GET", `/api/trades/2way/queue?${Q}&APIKEY=${ADMIN_KEY}`);
  t.equal(r.json.trades.length, 0, "a cancelled trade drops out of the default (active/failed only) queue view");
});

test("QUEUE: with includeAll=1, a cancelled trade IS visible for history, but STILL with no execute/drop affordance anywhere in the shape", async () => {
  const { env, mfl } = fresh({ env: { TRADE_2WAY_STAGING_ENABLED: "1" } });
  mfl.st.rosters["0001"] = [flat("14056")];
  mfl.st.rosters["0002"] = [flat("13100")];
  const created = await createStaged(env);
  await callWorker(env, "POST", `/api/trades/2way/cancel?${Q}&MFL_USER_ID=tok-B`, { body: { id: created.json.id, reason: "test" } });
  const r = await callWorker(env, "GET", `/api/trades/2way/queue?${Q}&APIKEY=${ADMIN_KEY}&includeAll=1`, {});
  t.equal(r.json.trades.length, 1);
  t.equal(r.json.trades[0].status, "cancelled");
  const keys = new Set();
  for (const row of r.json.trades) for (const k of Object.keys(row)) keys.add(k);
  t.ok(!keys.has("execute") && !keys.has("drop") && !keys.has("execute_url") && !keys.has("drop_url"), "no execution affordance field anywhere, in history view either");
});

await run("trade_compliance_preview_and_queue");
restoreConsole();
