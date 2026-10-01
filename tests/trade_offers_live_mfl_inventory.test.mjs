// GET /admin/trade-offers/live-mfl-inventory — a PURE READ of MFL's actual pendingTrades,
// right now, for every franchise. Built 2026-09-29 because Keith is right that
// ups_trade_offer_watch's 4 all-'gone' rows and no sentinel heartbeat don't by themselves
// prove today's real count is zero — this route asks MFL directly instead of trusting the
// mirror. It must never write anything: not to ups_trade_offer_watch, not an act_log entry,
// not an MFL import of any kind — it only issues GET pendingTrades exports (via the same
// commissioner-impersonated call worker/src/index.js's own trade-sentinel tick STEP A uses).
//
// Run: node tests/trade_offers_live_mfl_inventory.test.mjs
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet, ADMIN_KEY } from "./fixtures/worker_harness.mjs";

const restoreConsole = quiet();
const Q = "L=74598&YEAR=2026";

function fresh(over) {
  const env = makeWorkerEnv(over && over.env);
  const mfl = makeMfl(over && over.mfl);
  mfl.install();
  return { env, mfl };
}

test("AUTH: no APIKEY is 401 (unauthenticated), the wrong one is 403 (forbidden) -- the shared admin gate refuses both before any MFL call is made", async () => {
  const { env, mfl } = fresh();
  mfl.addPending({ offeringteam: "0001", offeredto: "0002", will_give_up: "14056,", will_receive: "13100," });
  const none = await callWorker(env, "GET", `/admin/trade-offers/live-mfl-inventory?${Q}`);
  t.equal(none.status, 401);
  const wrong = await callWorker(env, "GET", `/admin/trade-offers/live-mfl-inventory?${Q}&APIKEY=nope`);
  t.equal(wrong.status, 403);
  t.equal(mfl.st.exports.length, 0, "an unauthenticated call must reach MFL zero times");
});

test("INVENTORY: aggregates real pending trades across ALL 12 franchises, deduped, with real names attached -- and reads MFL only, writes nothing anywhere", async () => {
  const { env, mfl } = fresh();
  const id1 = mfl.addPending({ offeringteam: "0001", offeredto: "0002", will_give_up: "14056,", will_receive: "13100,", comments: "let's do this" });
  const id2 = mfl.addPending({ offeringteam: "0003", offeredto: "0005", will_give_up: "15000,", will_receive: "", comments: "" });
  const r = await callWorker(env, "GET", `/admin/trade-offers/live-mfl-inventory?${Q}&APIKEY=${ADMIN_KEY}`);
  t.equal(r.status, 200);
  t.ok(r.json.ok);
  t.equal(r.json.complete, true);
  t.equal(r.json.pending_count, 2);
  const ids = r.json.pending.map((p) => p.trade_id).sort();
  t.deepEqual(ids, [id1, id2].sort());
  const first = r.json.pending.find((p) => p.trade_id === id1);
  t.equal(first.from_franchise_id, "0001");
  t.equal(first.to_franchise_id, "0002");
  t.equal(first.from_franchise_name, "L.A. Looks");
  t.equal(first.comments, "let's do this");

  // Zero writes anywhere: no MFL import call, no D1 row in ups_trade_offer_watch.
  t.equal(mfl.st.imports.length, 0, "a read-only inventory must never call an MFL import");
  const { results } = await env.UPS_MFL_DB.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='ups_trade_offer_watch'").all();
  // The table may not even exist yet in a fresh test env (it's created on-demand by the
  // sentinel tick, never by this route) -- either way, if it exists it must be empty.
  if (results[0]?.n) {
    const cnt = await env.UPS_MFL_DB.prepare("SELECT COUNT(*) AS n FROM ups_trade_offer_watch").first();
    t.equal(cnt?.n || 0, 0, "this route must never mirror anything into ups_trade_offer_watch");
  }
});

test("INVENTORY: zero pending trades league-wide is reported plainly, distinct from a failed read", async () => {
  const { env } = fresh();
  const r = await callWorker(env, "GET", `/admin/trade-offers/live-mfl-inventory?${Q}&APIKEY=${ADMIN_KEY}`);
  t.equal(r.status, 200);
  t.equal(r.json.ok, true);
  t.equal(r.json.complete, true);
  t.equal(r.json.pending_count, 0);
  t.deepEqual(r.json.pending, []);
  t.match(r.json.note, /live pendingTrades state for every franchise, right now/);
});

test("PARTIAL FAILURE: one franchise's pendingTrades export failing marks the result incomplete -- a lower bound, never silently reported as a proven zero", async () => {
  const { env, mfl } = fresh();
  mfl.addPending({ offeringteam: "0001", offeredto: "0002", will_give_up: "14056,", will_receive: "13100," });
  mfl.st.exportFail = { pendingTrades: 500 };
  const r = await callWorker(env, "GET", `/admin/trade-offers/live-mfl-inventory?${Q}&APIKEY=${ADMIN_KEY}`);
  t.equal(r.status, 200);
  t.equal(r.json.ok, false);
  t.equal(r.json.complete, false);
  t.ok(r.json.franchises_failed.length > 0);
  t.match(r.json.note, /LOWER BOUND, not proven complete/);
});

test("LEAGUE FETCH FAILS: a broken franchise list is a clean 502, never a silent empty inventory", async () => {
  const { env, mfl } = fresh();
  mfl.st.exportFail = { league: 500 };
  const r = await callWorker(env, "GET", `/admin/trade-offers/live-mfl-inventory?${Q}&APIKEY=${ADMIN_KEY}`);
  t.equal(r.status, 502);
  t.equal(r.json.ok, false);
});

await run("trade_offers_live_mfl_inventory");
restoreConsole();
