// A lost response never stages the same offer twice (Keith 2026-10-31, #1425; worker/src/trade_2way.js createStaged2WayTrade).
// With TRADE_2WAY_CUTOVER_ENABLED on, Send stores a row in D1 and MFL never lists it, so nothing a client can read proves the first
// attempt isn't there. The worker decides for every client: an atomic lock on the offer, then an identical OPEN offer answers with its
// id (no row, no DM). A client key adds one thing: that same attempt replays even after the offer closed.
// The first half is the real route on real SQLite; the second is the REAL whole War Room against the REAL worker.
//   node tests/trade_2way_stage_no_duplicate.test.mjs
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeD1, applyMigrations, THREE_WAY_MIGRATIONS } from "./fixtures/d1_sqlite.mjs";
import { installDiscordRecorder, quietConsole, viewer } from "./fixtures/trade_3way_fixture.mjs";
import { settle } from "./fixtures/fake_dom.mjs";
import { bootDesktop, pageWorld, readyOffer, resp } from "./fixtures/war_room_page.mjs";
await import("./fixtures/register_md_loader.mjs");
const { cancel2WayTrade } = await import("../worker/src/trade_2way.js");
const { handle2WayStagedHttp } = await import("../worker/src/trade_2way_http.js");
const { IDEM_SCOPE, IDEM_STALE_MS, makeIdempotencyStore, stagedOfferShape } = await import("../worker/src/trade_idempotency.js");

const restoreConsole = quietConsole();
const discord = installDiscordRecorder();
const FR = { A: "0008", B: "0001" };
const MIGRATIONS = [...THREE_WAY_MIGRATIONS, "0162_ups_trade_cap_acknowledgments.sql", "0163_ups_trade_conditional_drops.sql", "0164_ups_2way_trades.sql"];
const KEY = "attempt-key-0001";
const OFFER = (over) => ({ from: { fid: FR.A }, to: { fid: FR.B }, movements: [{ from: FR.A, to: FR.B, asset_tokens: ["16614", "DP_00_03"], cap_k: 0 }, { from: FR.B, to: FR.A, asset_tokens: ["14056"], cap_k: 0 }], notes: "hi", ...(over || {}) });

function makeEnv() {
  const db = makeD1({}); applyMigrations(db, MIGRATIONS);
  db.raw.exec("CREATE TABLE IF NOT EXISTS discord_owners (franchise_id TEXT, active_owner TEXT, discord_user_id TEXT)");
  db.raw.prepare("INSERT INTO discord_owners VALUES (?,?,?)").run(FR.B, "Y", "100000000000000002");
  return { UPS_MFL_DB: db, DISCORD_BOT_TOKEN: "test-token", TRADE_2WAY_STAGING_ENABLED: "1", COMMISH_API_KEY: "k", MFL_APIKEY: "m" };
}
const post = async (env, body) => {
  const url = new URL("https://worker.test/api/trades/2way?MFL_USER_ID=tok-A"), p = [];
  const request = new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const res = await handle2WayStagedHttp({ request, url, path: url.pathname, env, ctx: { waitUntil: (x) => p.push(x) }, corsHeaders: {},
    defaultLeagueId: "74598", defaultSeason: "2026", browserMflUserId: "tok-A", cookieMflUserId: "",
    deps: { detectFranchise: async (tok) => (tok === "tok-A" ? { franchise_id: FR.A, franchise_name: "Real Deal Creel" } : { error: "HTTP 401" }), commishFids: () => [] } });
  await Promise.all(p);
  return { status: res.status, json: await res.json() };
};
const rows = (env) => env.UPS_MFL_DB.raw.prepare("SELECT * FROM ups_2way_trades ORDER BY created_at_utc").all();
const age = (env, ms) => env.UPS_MFL_DB.raw.prepare("UPDATE ups_trade_idempotency SET updated_at_utc=?").run(new Date(Date.now() - ms).toISOString());
const seen = (env, r) => cancel2WayTrade(env, { waitUntil() {} }, r.json.id, viewer(FR.A, { leagueId: "74598", season: "2026" }), "no");

test("the same offer again, with no key at all (a stale client, the phone, a reload): the first offer's id, no second row, no second DM", async () => {
  const env = makeEnv(); discord.reset();
  const a = await post(env, OFFER());
  t.equal(a.status, 201, JSON.stringify(a.json));
  const b = await post(env, OFFER());
  t.equal(b.status, 200, JSON.stringify(b.json));
  t.deepEqual(b.json, { ok: true, id: a.json.id, staged: true, already_staged: true });
  t.equal(rows(env).length, 1);
  t.equal(discord.messages().length, 1, "the partner was told once");
});

test("the same offer under a NEW key (Send again after a lost answer): the first offer's id, no second row", async () => {
  const env = makeEnv();
  const a = await post(env, OFFER({ idempotency_key: KEY }));
  const b = await post(env, OFFER({ idempotency_key: "attempt-key-0002" }));
  t.equal(b.status, 200); t.equal(b.json.id, a.json.id); t.equal(b.json.already_staged, true);
  t.equal(rows(env).length, 1);
});

test("the same offer however it was ordered or spelled is the same offer; the note and the drop selection don't make it a new one", async () => {
  const env = makeEnv();
  await post(env, OFFER());
  const flip = OFFER(); flip.movements.reverse(); flip.movements[1].asset_tokens = ["DP_0_3", "16614"];
  flip.notes = "a different note"; flip.loaded_contract_drops = ["14056"];
  t.equal((await post(env, flip)).json.already_staged, true);
  t.equal(rows(env).length, 1);
});

test("a DIFFERENT offer still stages: other assets, other extension terms, another partner, the other direction; other cap money reads as different", async () => {
  const env = makeEnv();
  await post(env, OFFER());
  const asset = OFFER(); asset.movements[1].asset_tokens = ["13100"];
  const back = OFFER({ from: { fid: FR.B }, to: { fid: FR.A } });
  const ext = OFFER({ extension_requests: [{ player_id: "16614", from_franchise_id: FR.A, to_franchise_id: FR.B, preview_contract_info_string: "CL 2|TCV 10K|AAV 5K", option_key: "1", extension_term: "1YR" }] });
  const other = OFFER({ to: { fid: "0002" } }); other.movements = [{ from: FR.A, to: "0002", asset_tokens: ["16614"], cap_k: 0 }];
  for (const [why, body] of [["assets", asset], ["extension", ext], ["partner", other]]) t.equal((await post(env, body)).status, 201, why);
  t.equal(rows(env).length, 4);
  const shape = (o) => stagedOfferShape({ from: o.from.fid, to: o.to.fid, movements: o.movements, extensionRequests: [] });
  const cap = OFFER(); cap.movements[1].cap_k = 1;
  t.ok(shape(cap) !== shape(OFFER()), "cap money");            // (a cap-money create needs the §A6 rosters read; the comparison is what matters here)
  t.ok(shape(back) !== shape(OFFER()), "the other direction");
});

test("a closed offer doesn't count: with no key, or a new key, an owner can offer the same deal again after it was cancelled", async () => {
  const env = makeEnv();
  const a = await post(env, OFFER({ idempotency_key: KEY }));
  t.equal((await seen(env, a)).ok, true);
  const b = await post(env, OFFER({ idempotency_key: "attempt-key-0002" }));
  t.equal(b.status, 201); t.ok(b.json.id !== a.json.id);
  t.equal(rows(env).length, 2);
});

test("the SAME key after the first offer closed: its first answer replays, the offer doesn't come back and nobody is told twice", async () => {
  const env = makeEnv(); discord.reset();
  const a = await post(env, OFFER({ idempotency_key: KEY }));
  t.equal((await seen(env, a)).ok, true);
  const dms = discord.messages().length;
  const b = await post(env, OFFER({ idempotency_key: KEY }));
  t.equal(b.status, 201); t.equal(b.json.id, a.json.id); t.equal(b.json.idempotent_replay, true);
  t.equal(rows(env).length, 1); t.equal(discord.messages().length, dms);
});

test("the same key on a different offer is refused and stores nothing", async () => {
  const env = makeEnv();
  await post(env, OFFER({ idempotency_key: KEY }));
  const other = OFFER({ idempotency_key: KEY }); other.movements[1].asset_tokens = ["13100"];
  const b = await post(env, other);
  t.equal(b.status, 409); t.equal(b.json.code, "idempotency_key_reused"); t.equal(rows(env).length, 1);
});

test("two requests at once, the second arriving while the first is between its check and its INSERT: one row and one DM, with or without keys", async () => {
  for (const keys of [[undefined, undefined], ["attempt-key-0001", "attempt-key-0002"]]) {
    const env = makeEnv(); discord.reset();
    let open, reached;
    const gate = new Promise((r) => { open = r; }), inCheck = new Promise((r) => { reached = r; });
    const db = env.UPS_MFL_DB;
    const held = { prepare: (sql) => {
      const st = db.prepare(sql);
      if (!/SELECT id, movements_json/.test(sql)) return st;
      return { bind: (...a) => { const b = st.bind(...a); return { all: async () => { const r = await b.all(); reached(); await gate; return r; } }; } };
    } };
    const first = post({ ...env, UPS_MFL_DB: held }, OFFER(keys[0] ? { idempotency_key: keys[0] } : {}));
    await inCheck;                                                // the first has looked and found nothing, and hasn't stored yet
    const second = await post(env, OFFER(keys[1] ? { idempotency_key: keys[1] } : {}));
    open();
    const one = await first;
    t.equal(one.status, 201, JSON.stringify(one.json));
    t.equal(second.status, 409, JSON.stringify(second.json)); t.equal(second.json.code, "request_in_progress");
    t.equal(rows(env).length, 1);
    t.equal(discord.messages().length, 1);
  }
});

test("the lock: held refuses, released or dead takes over, ±1 second at the stale line", async () => {
  const env = makeEnv(), store = makeIdempotencyStore(env.UPS_MFL_DB);
  const k = { leagueId: "74598", season: "2026", scope: IDEM_SCOPE.TWO_WAY_STAGE_LOCK, actorFid: FR.A, key: "a".repeat(64) };
  t.equal((await store.lockOffer(k, "h")).acquired, true);
  const held = await store.lockOffer(k, "h");
  t.equal(held.acquired, false); t.equal(held.reply.status, 409); t.equal(held.reply.body.code, "request_in_progress");
  age(env, IDEM_STALE_MS - 1000);
  t.equal((await store.lockOffer(k, "h")).acquired, false, "1 second before the line: still held");
  age(env, IDEM_STALE_MS + 1000);
  t.equal((await store.lockOffer(k, "h")).acquired, true, "1 second after: the dead holder is taken over");
  t.equal(await store.finish(k, { state: "done", statusCode: 200, body: null }), true);
  t.equal((await store.lockOffer(k, "h")).acquired, true, "released");
});

test("a holder that died leaves the offer stageable after the stale line: the lock is released, never a permanent block", async () => {
  const env = makeEnv();
  await makeIdempotencyStore(env.UPS_MFL_DB).read({ leagueId: "x", season: "x", scope: "x", actorFid: "x", key: "x" });
  const first = await post(env, OFFER());
  env.UPS_MFL_DB.raw.prepare("UPDATE ups_trade_idempotency SET state='in_progress'").run();
  t.equal((await post(env, OFFER())).status, 409, "held");
  age(env, IDEM_STALE_MS + 1000);
  t.equal((await post(env, OFFER())).json.id, first.json.id, "taken over, and the check still finds the first offer");
  t.equal(rows(env).length, 1);
});

test("FAILS CLOSED: the lock can't be taken → 503, nothing stored, no DM", async () => {
  const env = makeEnv(); discord.reset();
  env.UPS_MFL_DB.opts.beforeRun = (sql) => { if (/ups_trade_idempotency/.test(sql)) throw new Error("D1_ERROR: simulated"); };
  const r = await post(env, OFFER());
  t.equal(r.status, 503); t.equal(r.json.code, "idempotency_unavailable");
  env.UPS_MFL_DB.opts.beforeRun = null;
  t.equal(rows(env).length, 0); t.equal(discord.messages().length, 0);
});

test("FAILS CLOSED: open offers can't be read → 503, nothing stored, the key isn't spent, and the lock is released", async () => {
  const env = makeEnv(); discord.reset();
  env.UPS_MFL_DB.opts.beforeRun = (sql) => { if (/SELECT id, movements_json/.test(sql)) throw new Error("D1_ERROR: simulated"); };
  const r = await post(env, OFFER({ idempotency_key: KEY }));
  t.equal(r.status, 503); t.equal(r.json.code, "idempotency_unavailable");
  env.UPS_MFL_DB.opts.beforeRun = null;
  t.equal(rows(env).length, 0); t.equal(discord.messages().length, 0);
  t.equal((await post(env, OFFER({ idempotency_key: KEY }))).status, 201, "the same attempt can still go through");
});

test("FAILS CLOSED: an open row that can't be read → 503, not a second offer", async () => {
  const env = makeEnv();
  await post(env, OFFER());
  env.UPS_MFL_DB.raw.prepare("UPDATE ups_2way_trades SET movements_json='{not json'").run();
  t.equal((await post(env, OFFER())).status, 503);
  t.equal(rows(env).length, 1);
});

test("the INSERT fails with no way to know whether it landed: that attempt never stores again; a new Send goes through the check", async () => {
  const env = makeEnv();
  env.UPS_MFL_DB.opts.beforeRun = (sql) => { if (/INSERT INTO ups_2way_trades/.test(sql)) throw new Error("D1_ERROR: simulated"); };
  t.equal((await post(env, OFFER({ idempotency_key: KEY }))).status, 400);
  env.UPS_MFL_DB.opts.beforeRun = null;
  const again = await post(env, OFFER({ idempotency_key: KEY }));
  t.equal(again.status, 409); t.equal(again.json.code, "request_in_progress"); t.equal(rows(env).length, 0);
  env.UPS_MFL_DB.raw.prepare("UPDATE ups_trade_idempotency SET updated_at_utc=? WHERE scope=?").run(new Date(Date.now() - IDEM_STALE_MS - 1000).toISOString(), IDEM_SCOPE.TWO_WAY_STAGE);
  t.equal((await post(env, OFFER({ idempotency_key: KEY }))).json.code, "request_outcome_unknown");
  t.equal(rows(env).length, 0);
  t.equal((await post(env, OFFER({ idempotency_key: "attempt-key-0002" }))).status, 201);
});

test("a malformed key is refused before anything else", async () => {
  const env = makeEnv();
  const r = await post(env, OFFER({ idempotency_key: "!" }));
  t.equal(r.status, 400); t.equal(r.json.code, "invalid_idempotency_key"); t.equal(rows(env).length, 0);
});

test("a staged create never touches MFL: the guard adds no network call", async () => {
  const env = makeEnv(); discord.reset();
  await post(env, OFFER()); await post(env, OFFER());
  t.equal(discord.messages().length, 1);   // installDiscordRecorder throws on any other fetch
});

// ════════════════════════ the REAL War Room, with staging on ════════════════════════
const isStage = (u, i) => !!(i && i.method === "POST" && /\/api\/trades\/2way\?/.test(u));
const SETTLE_MS = 5 * 60 * 1000;
const world = () => pageWorld({ __migrations: MIGRATIONS, TRADE_2WAY_STAGING_ENABLED: "1", TRADE_2WAY_CUTOVER_ENABLED: "1" });
const pageRows = (w) => w.env.UPS_MFL_DB.raw.prepare("SELECT * FROM ups_2way_trades").all();
const stages = (w) => w.log.filter((r) => r.method === "POST" && /\/api\/trades\/2way$/.test(r.path));
async function lostStage(override) {
  const w = world();
  let lose = true;
  const d = await bootDesktop(w, { token: "tok-B", fid: "0001", override: async (u, i, real) => {
    if (lose && isStage(u, i)) { lose = false; await real(u, i); throw new TypeError("Failed to fetch"); }
    return override ? override(u, i, real) : null;
  } });
  t.equal(readyOffer(d, "hi", { capK: 2 }), "ready");
  await d.api.submitOfferToQueue(); await settle(30);
  t.equal(pageRows(w).length, 1, "the first attempt stored its row");
  t.equal(d.api.state.submit.canRetry, true, "the owner saw a failure and is offered Retry");
  return { w, d };
}
const retryAfterWait = async (d) => { d.api.state.submit.lastAttemptMs = Date.now() - SETTLE_MS; d.els.twbSubmitRetryBtn.__l.click(); await settle(60); };

test("WAR ROOM: the answer to a staged Send is lost. After the wait Retry leaves one row and says so", async () => {
  const { w, d } = await lostStage();
  await retryAfterWait(d);
  t.equal(pageRows(w).length, 1, "still exactly one staged offer");
  t.equal(w.mfl.st.pending.length, 0, "nothing reached MFL");
  t.match(d.api.state.submit.message, /^Already staged — awaiting review\. It was not staged again\./);
  t.equal(d.api.state.submit.canRetry, false);
  t.equal(stages(w).length, 2, "the second request reached the worker and the worker refused to store it");
});

test("WAR ROOM: inside the five-minute wait Retry doesn't reach the staged route at all", async () => {
  const { w, d } = await lostStage();
  d.api.state.submit.lastAttemptMs = Date.now();
  d.els.twbSubmitRetryBtn.__l.click(); await settle(60);
  t.equal(stages(w).length, 1); t.equal(pageRows(w).length, 1);
  t.match(d.api.state.submit.message, /was NOT sent again yet/);
  t.equal(d.api.state.submit.canRetry, true);
});

test("WAR ROOM: the offer was declined before the owner pressed Retry. The same attempt doesn't bring it back", async () => {
  const { w, d } = await lostStage();
  w.env.UPS_MFL_DB.raw.prepare("UPDATE ups_2way_trades SET status='cancelled'").run();
  await retryAfterWait(d);
  t.equal(pageRows(w).length, 1, "no new offer");
  t.match(d.api.state.submit.message, /^Already staged/);
});

test("WAR ROOM: Retry and Send both resend one key per Send: Retry reuses it, a new Send makes a new one, and neither stages twice", async () => {
  const { w, d } = await lostStage();
  const keyOf = (n) => stages(w)[n].body.idempotency_key;
  t.match(keyOf(0), /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/);
  await d.api.submitOfferToQueue(); await settle(30);
  t.equal(pageRows(w).length, 1, "Send again stored nothing");
  t.ok(keyOf(1) !== keyOf(0), "a new Send is a new attempt");
  t.match(d.api.state.submit.message, /^Already staged/);
});

test("WAR ROOM: Retry resends the key the lost Send used", async () => {
  const { w, d } = await lostStage();
  await retryAfterWait(d);
  t.equal(stages(w)[1].body.idempotency_key, stages(w)[0].body.idempotency_key);
});

test("WAR ROOM: the first attempt never reached the worker. Retry stages it, once", async () => {
  const w = world();
  let fail = true;
  const d = await bootDesktop(w, { token: "tok-B", fid: "0001", override: async (u, i) => (fail && isStage(u, i) ? (fail = false, resp(503, { ok: false, error: "busy" })) : null) });
  t.equal(readyOffer(d, "hi", { capK: 2 }), "ready");
  await d.api.submitOfferToQueue(); await settle(30);
  t.equal(pageRows(w).length, 0);
  await retryAfterWait(d);
  t.equal(pageRows(w).length, 1);
  t.match(d.api.state.submit.message, /^Staged — awaiting review/);
});

test("WAR ROOM: the worker says the first attempt is still running or unknown: nothing stored, the message is shown, Retry stays", async () => {
  const w = world();
  let n = 0;
  const d = await bootDesktop(w, { token: "tok-B", fid: "0001", override: async (u, i) => (isStage(u, i) && ++n <= 2 ? (n === 1 ? resp(503, { ok: false, error: "busy" }) : resp(409, { ok: false, code: "request_outcome_unknown", error: "We couldn't confirm whether your earlier attempt went through.", message: "We couldn't confirm whether your earlier attempt went through." })) : null) });
  t.equal(readyOffer(d, "hi", { capK: 2 }), "ready");
  await d.api.submitOfferToQueue(); await settle(30);
  await retryAfterWait(d);
  t.equal(pageRows(w).length, 0);
  t.match(d.api.state.submit.message, /couldn't confirm/);
  t.equal(d.api.state.submit.canRetry, true);
});

await run();
restoreConsole();
