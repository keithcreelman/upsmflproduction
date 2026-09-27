// Three-team route matrix, driven through the REAL worker (worker/src/index.js default.fetch),
// so the global no-L guard, routing, session proof (MFL `myleagues` stub) and the 3-way
// engine are all the production code. Real SQLite + the real 3-way migrations.
//   node tests/trade_3way_routes.test.mjs
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet, ADMIN_KEY } from "./fixtures/worker_harness.mjs";
import { seedTrade, readRow, TRADE_ID, DISCORD } from "./fixtures/trade_3way_fixture.mjs";

const restoreConsole = quiet();
// tokens -> franchise:  A=initiator 0008, B=0001, H=0012 (both partners), O=0003 (not in the deal), commish=0000
const TOK = { tokens: { "tok-H": "0012" } };
const fresh = (over) => {
  const env = makeWorkerEnv({ TRADE_3WAY_EXECUTE: "0", ...(over || {}) });
  const mfl = makeMfl(TOK); mfl.install();
  env.UPS_MFL_DB.raw.prepare("INSERT INTO discord_owners VALUES (?,?,?)").run("0008", "Y", DISCORD.A);
  env.UPS_MFL_DB.raw.prepare("INSERT INTO discord_owners VALUES (?,?,?)").run("0001", "Y", DISCORD.B);
  env.UPS_MFL_DB.raw.prepare("INSERT INTO discord_owners VALUES (?,?,?)").run("0012", "Y", DISCORD.C);
  seedTrade(env);
  return { env, mfl };
};
const status = (env, id) => (readRow(env, id) || {}).status;
const CANCEL = "/api/trades/3way/cancel";
const GET = (tok, extra) => `/api/trades/3way?id=${TRADE_ID}${tok ? `&MFL_USER_ID=${tok}` : ""}${extra || ""}`;

// ── the outage itself, end to end: no ?L= at all (exactly what deployed mobile sends) ──
test("MISSING L: the deployed mobile request shape (no L, only MFL_USER_ID) loads and cancels — the original outage", async () => {
  const { env } = fresh();
  const g = await callWorker(env, "GET", GET("tok-A"));
  t.equal(g.status, 200); t.equal(g.json.trade.id, TRADE_ID);
  const c = await callWorker(env, "POST", `${CANCEL}?MFL_USER_ID=tok-A`, { body: { id: TRADE_ID } });
  t.equal(c.status, 200); t.equal(c.json.ok, true);
  t.equal(status(env), "cancelled");
});

test("MISSING L is a fallback to the WORKER's configured league, and the session must belong to it", async () => {
  const { env } = fresh();
  const other = await callWorker(env, "GET", GET("tok-x"));
  t.equal(other.status, 403);
  t.doesNotMatch(other.text, /Real Deal Creel|movements/);
});

test("INVALID L: garbage, a different league and a wrong league in the body are all refused and change nothing", async () => {
  const { env } = fresh();
  for (const L of ["abc", "74598%27%20OR%201%3D1", "1", "99999999999"]) {
    const r = await callWorker(env, "POST", `${CANCEL}?L=${L}&MFL_USER_ID=tok-A`, { body: { id: TRADE_ID } });
    t.ok([400, 403, 404].includes(r.status), `L=${L} -> ${r.status}`);
    t.notEqual(r.json && r.json.ok, true);
  }
  const wrongBody = await callWorker(env, "POST", `${CANCEL}?L=74598&MFL_USER_ID=tok-A`, { body: { id: TRADE_ID, league_id: "99999" } });
  t.equal(wrongBody.status, 400); t.equal(wrongBody.json.code, "league_mismatch");
  const otherLeague = await callWorker(env, "POST", `${CANCEL}?L=99999&MFL_USER_ID=tok-A`, { body: { id: TRADE_ID } });
  t.equal(otherLeague.status, 403);
  t.equal(status(env), "collecting");
});

// ── session ──
test("MISSING SESSION: every 3-way route is 401 and reveals nothing", async () => {
  const { env } = fresh();
  for (const [m, p, b] of [["GET", GET(""), undefined], ["GET", "/api/trades/3way?franchise_id=0008", undefined], ["POST", CANCEL, { id: TRADE_ID }], ["POST", "/api/trades/3way", { initiator: { fid: "0008" } }]]) {
    const r = await callWorker(env, m, p, b ? { body: b } : undefined);
    t.equal(r.status, 401, `${m} ${p}`); t.equal(r.json.code, "unauthenticated");
    t.doesNotMatch(r.text, /Hawks|L\.A\. Looks|movements/);
  }
  t.equal(status(env), "collecting");
});

test("INVALID SESSION: a bogus token is 401 (expired), an MFL outage is 503, neither leaks or changes anything", async () => {
  const { env } = fresh();
  const bad = await callWorker(env, "POST", `${CANCEL}?MFL_USER_ID=tok-bogus`, { body: { id: TRADE_ID } });
  t.equal(bad.status, 401); t.equal(bad.json.code, "session_expired");
  const { env: e2 } = (() => { const x = fresh(); return x; })();
  const down = makeMfl({ ...TOK, myleaguesDown: true }); down.install();
  const r = await callWorker(e2, "GET", GET("tok-A"));
  t.equal(r.status, 503); t.equal(r.json.code, "identity_unavailable");
  t.equal(status(env), "collecting"); t.equal(status(e2), "collecting");
});

test("A cookie header can carry the session too, but the WORKER's own commissioner cookie can never be presented as one", async () => {
  const { env } = fresh();
  const r = await callWorker(env, "GET", GET(""), { headers: { Cookie: "MFL_USER_ID=tok-B" } });
  t.equal(r.status, 200);
  const smuggled = await callWorker(env, "GET", GET("COMMISH-COOKIE-SECRET"));
  t.ok(smuggled.status >= 400);
});

// ── authorization ──
test("NONPARTICIPANT: cannot load, cannot cancel; the answer does not confirm the trade exists in that state", async () => {
  const { env } = fresh();
  const g = await callWorker(env, "GET", GET("tok-O"));
  t.equal(g.status, 403); t.doesNotMatch(g.text, /Real Deal Creel|Hawks|movements|collecting/);
  const c = await callWorker(env, "POST", `${CANCEL}?MFL_USER_ID=tok-O`, { body: { id: TRADE_ID } });
  t.equal(c.status, 403); t.equal(c.json.trade, undefined);
  const list = await callWorker(env, "GET", `/api/trades/3way?franchise_id=0008&MFL_USER_ID=tok-O`);
  t.equal(list.status, 403);
  t.equal(status(env), "collecting");
});

test("PARTICIPANT: the initiator sees it and may cancel; a partner sees it but may not cancel (they decline in Discord)", async () => {
  const { env } = fresh();
  for (const tok of ["tok-A", "tok-B", "tok-H"]) t.equal((await callWorker(env, "GET", GET(tok))).status, 200);
  const partner = await callWorker(env, "POST", `${CANCEL}?MFL_USER_ID=tok-B`, { body: { id: TRADE_ID } });
  t.equal(partner.status, 403); t.equal(partner.json.code, "only_initiator_can_cancel");
  t.equal(status(env), "collecting");
  const init = await callWorker(env, "POST", `${CANCEL}?MFL_USER_ID=tok-A`, { body: { id: TRADE_ID } });
  t.equal(init.status, 200);
  t.equal(status(env), "cancelled");
});

test("COMMISSIONER: may VIEW; the OWNER route refuses a commissioner session and acting-as (administrative cancel is a separate action)", async () => {
  const { env } = fresh();
  t.equal((await callWorker(env, "GET", GET("tok-commish"))).status, 200);
  const adm = await callWorker(env, "POST", `${CANCEL}?MFL_USER_ID=tok-commish`, { body: { id: TRADE_ID } });
  t.equal(adm.status, 403); t.equal(adm.json.code, "commissioner_use_admin_action");
  const as = await callWorker(env, "POST", `${CANCEL}?MFL_USER_ID=tok-commish&acting_franchise_id=0008`, { body: { id: TRADE_ID } });
  t.equal(as.status, 403); t.equal(as.json.code, "commissioner_use_admin_action");
  t.equal(status(env), "collecting");
});

test("BODY franchise_id / acting_franchise_id is never identity: an ordinary owner cannot borrow the initiator", async () => {
  const { env } = fresh();
  for (const [q, b] of [["", { id: TRADE_ID, franchise_id: "0008" }], ["&acting_franchise_id=0008", { id: TRADE_ID }], ["", { id: TRADE_ID, acting_franchise_id: "0008" }]]) {
    const r = await callWorker(env, "POST", `${CANCEL}?MFL_USER_ID=tok-B${q}`, { body: b });
    t.equal(r.status, 403); t.equal(r.json.code, "forbidden");
  }
  t.equal(status(env), "collecting");
});

test("ADMIN KEY on the OWNER route: never a cancel — wrong key 403, bare key refused, naming the initiator refused", async () => {
  const { env } = fresh();
  t.equal((await callWorker(env, "POST", `${CANCEL}?APIKEY=wrong&acting_franchise_id=0008`, { body: { id: TRADE_ID } })).status, 403);
  const bare = await callWorker(env, "POST", `${CANCEL}?APIKEY=${ADMIN_KEY}`, { body: { id: TRADE_ID } });
  t.ok(bare.status >= 400); t.equal(status(env), "collecting");
  const named = await callWorker(env, "POST", `${CANCEL}?APIKEY=${ADMIN_KEY}&acting_franchise_id=0008`, { body: { id: TRADE_ID } });
  t.equal(named.status, 403); t.equal(named.json.code, "commissioner_use_admin_action");
  t.equal(status(env), "collecting");
});

// ── trade identity ──
test("CROSS-LEAGUE trade id: a trade that belongs to another league is 404 for everyone, even the commissioner", async () => {
  const { env } = fresh();
  env.UPS_MFL_DB.raw.prepare("UPDATE ups_3way_trades SET league_id='99999' WHERE id=?").run(TRADE_ID);
  for (const who of ["tok-A", "tok-commish"]) {
    const g = await callWorker(env, "GET", GET(who)); t.equal(g.status, 404); t.doesNotMatch(g.text, /Real Deal Creel|movements/);
    const c = await callWorker(env, "POST", `${CANCEL}?MFL_USER_ID=${who}&acting_franchise_id=0008`, { body: { id: TRADE_ID } });
    t.equal(c.status, 404);
  }
  t.equal(status(env), "collecting");
});

test("OTHER-SEASON trade id: a 2025 trade is 404 in the 2026 context, and visible only when that season is asked for", async () => {
  const { env } = fresh();
  env.UPS_MFL_DB.raw.prepare("UPDATE ups_3way_trades SET season='2025' WHERE id=?").run(TRADE_ID);
  const now = await callWorker(env, "GET", GET("tok-A"));
  t.equal(now.status, 404);
  const c = await callWorker(env, "POST", `${CANCEL}?MFL_USER_ID=tok-A`, { body: { id: TRADE_ID } });
  t.equal(c.status, 404);
  const list = await callWorker(env, "GET", `/api/trades/3way?MFL_USER_ID=tok-A&include=all`);
  t.equal(list.status, 200); t.equal(list.json.trades.length, 0);
  t.equal(status(env), "collecting");
});

test("MALFORMED / MISSING trade id: 400 or 404 with a clear code, never a 500 and never a change", async () => {
  const { env } = fresh();
  for (const id of ["nope", "'; DROP TABLE ups_3way_trades;--", "", "00000000-0000-0000-0000-000000000000", "54A0306A-552E-4F79-8D34-98D72EB704A0 "]) {
    const c = await callWorker(env, "POST", `${CANCEL}?MFL_USER_ID=tok-A`, { body: { id } });
    t.ok([400, 404].includes(c.status), `id=${id} -> ${c.status}`);
    t.ok(c.json && c.json.code);
  }
  t.equal((await callWorker(env, "GET", `/api/trades/3way?id=zzz&MFL_USER_ID=tok-A`)).status, 400);
  t.equal((await callWorker(env, "GET", `/api/trades/3way?id=00000000-0000-0000-0000-000000000000&MFL_USER_ID=tok-A`)).status, 404);
  t.equal(status(env), "collecting");
  t.equal(env.UPS_MFL_DB.raw.prepare("SELECT COUNT(*) AS n FROM ups_3way_trades").get().n, 1);
});

test("TERMINAL trades: still viewable (history), cannot be cancelled or revived; a repeat cancel is idempotent", async () => {
  for (const [st, code] of [["executing", "cannot_cancel_executing"], ["completed", "cannot_cancel_completed"], ["failed", "cannot_cancel_failed"]]) {
    const { env } = fresh(); env.UPS_MFL_DB.raw.prepare("UPDATE ups_3way_trades SET status=? WHERE id=?").run(st, TRADE_ID);
    t.equal((await callWorker(env, "GET", GET("tok-A"))).status, 200);
    const c = await callWorker(env, "POST", `${CANCEL}?MFL_USER_ID=tok-A`, { body: { id: TRADE_ID } });
    t.equal(c.status, 409); t.equal(c.json.code, code);
    t.equal(status(env), st);
  }
  const { env } = fresh();
  const one = await callWorker(env, "POST", `${CANCEL}?MFL_USER_ID=tok-A`, { body: { id: TRADE_ID } });
  const two = await callWorker(env, "POST", `${CANCEL}?MFL_USER_ID=tok-A`, { body: { id: TRADE_ID } });
  t.equal(one.status, 200); t.equal(two.status, 200); t.equal(two.json.already, true);
});

test("MISSING TRADE row + database down: 404 vs 503 are distinct", async () => {
  const { env } = fresh();
  env.UPS_MFL_DB = { prepare: () => { throw new Error("D1_ERROR: simulated"); } };
  const r = await callWorker(env, "GET", GET("tok-A"));
  t.equal(r.status, 503); t.doesNotMatch(r.text, /D1_ERROR|simulated/);
});

// ── create ──
const CREATE = (fid) => ({
  league_id: "74598", season: "2026",
  initiator: { fid, name: "x" }, team_b: { fid: "0001", name: "L.A. Looks" }, team_c: { fid: "0012", name: "Hawks" },
  movements: [{ from: "0008", to: "0012", asset_tokens: ["P_16614"], cap_k: 0, summary: "MHJ" }, { from: "0012", to: "0001", asset_tokens: ["FP_0012_2027_1"], cap_k: 0, summary: "R1" }, { from: "0001", to: "0008", asset_tokens: ["P_16181"], cap_k: 0, summary: "CB" }],
});
test("CREATE: body initiator must be the authenticated franchise; nonparticipant-as-initiator and unauthenticated create nothing", async () => {
  const { env } = fresh(); env.UPS_MFL_DB.raw.exec("DELETE FROM ups_3way_trades");
  const count = () => env.UPS_MFL_DB.raw.prepare("SELECT COUNT(*) AS n FROM ups_3way_trades").get().n;
  t.equal((await callWorker(env, "POST", `/api/trades/3way?MFL_USER_ID=tok-B`, { body: CREATE("0008") })).status, 403);
  t.equal((await callWorker(env, "POST", `/api/trades/3way`, { body: CREATE("0008") })).status, 401);
  t.equal((await callWorker(env, "POST", `/api/trades/3way?MFL_USER_ID=tok-O`, { body: CREATE("0003") })).status, 400);
  t.equal(count(), 0);
});

// ── the global guard is not a fail-open path ──
test("GUARD: look-alike and sibling paths are still stopped by the global no-L guard (400 Missing L param) — the exemption is exact", async () => {
  const { env } = fresh();
  for (const p of ["/api/trades/3way/", "/api/trades/3way/other", "/api/trades/3way/cancel/x", "/api/trades/3wayx"]) {
    const r = await callWorker(env, "POST", `${p}?MFL_USER_ID=tok-A`, { body: { id: TRADE_ID } });
    t.equal(r.status, 400, p); t.equal(r.json.reason, "Missing L param");
  }
  t.equal(status(env), "collecting");
});

test("GUARD: every exempted route authenticates for itself — none returns data or changes state without proof", async () => {
  const { env, mfl } = fresh();
  const stateBefore = JSON.stringify(readRow(env));
  const routes = [["GET", "/api/trades/3way"], ["POST", "/api/trades/3way"], ["POST", CANCEL], ["GET", "/api/trades/outbox"], ["POST", "/api/trades/outbox/replay"],
    ["GET", "/api/trades/proposals"], ["POST", "/api/trades/proposals"], ["POST", "/api/trades/proposals/action"], ["POST", "/api/trades/reconcile/extensions"], ["POST", "/api/trades/refresh-after-trade"]];
  for (const [m, p] of routes) {
    const r = await callWorker(env, m, p, m === "POST" ? { body: { id: TRADE_ID } } : undefined);
    t.ok([400, 401, 403, 503].includes(r.status), `${m} ${p} -> ${r.status}`);
    t.notEqual(r.json && r.json.ok, true, `${m} ${p}`);
  }
  t.equal(JSON.stringify(readRow(env)), stateBefore);
  t.equal(mfl.writes().length, 0);
});

// ── owner-safe copy ──
test("Every refusal carries a plain-English message and no internals (stack, SQL, table names, tokens)", async () => {
  const { env } = fresh();
  const cases = await Promise.all([
    callWorker(env, "GET", GET("")), callWorker(env, "GET", GET("tok-O")), callWorker(env, "POST", `${CANCEL}?MFL_USER_ID=tok-B`, { body: { id: TRADE_ID } }),
    callWorker(env, "POST", `${CANCEL}?MFL_USER_ID=tok-A`, { body: { id: "nope" } }), callWorker(env, "GET", GET("tok-bogus")),
  ]);
  for (const r of cases) {
    t.ok(r.json && typeof r.json.error === "string" && r.json.error.length > 5);
    t.doesNotMatch(r.text, /ups_3way|SQLITE|stack|at Object|tok-|COMMISH|secret|D1_/);
  }
});

await run("trade_3way_routes");
restoreConsole();
