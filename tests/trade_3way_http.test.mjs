// 3-way trade HTTP surface: identity, authorization, status codes, canonical bodies,
// and the worker's global "Missing L param" guard. Run: node tests/trade_3way_http.test.mjs
//
// Root cause under test (2026-09-25): mobile's cancel request had no ?L=, and the
// worker's global no-L guard 400'd it ("Missing L param") before the handler ran.
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeEnv, seedTrade, readRow, goodDeps, installDiscordRecorder, quietConsole, TRADE_ID, DISCORD } from "./fixtures/trade_3way_fixture.mjs";
await import("./fixtures/register_md_loader.mjs");
const { handle3WayHttp } = await import("../worker/src/trade_3way_http.js");

const restoreConsole = quietConsole();
const discord = installDiscordRecorder();
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };

const SESSIONS = { "tok-A": "0008", "tok-B": "0001", "tok-C": "0012", "tok-O": "0003", "tok-commish": "0000" };
const deps = (over) => ({
  detectFranchise: async (tok) => {
    if (tok === "tok-net") return { error: "fetch failed" };
    if (tok === "tok-nomember") return { error: "MFL_USER_ID not a member of league 74598" };
    return SESSIONS[tok] ? { franchise_id: SESSIONS[tok], franchise_name: "x" } : { error: "HTTP 401" };
  },
  commishFids: () => ["0000"],
  ...goodDeps, ...(over || {}),
});
const ctxWait = () => { const p = []; return { waitUntil: (x) => p.push(x), flush: () => Promise.all(p) }; };

// Drive the handler exactly the way index.js does.
async function call(env, method, pathAndQuery, { token, body, d, sessionByApiKey, cookieToken } = {}) {
  const url = new URL("https://worker.test" + pathAndQuery);
  const request = new Request(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const ctx = ctxWait();
  const resp = await handle3WayHttp({
    request, url, path: url.pathname, env, ctx, corsHeaders: CORS,
    defaultLeagueId: "74598", defaultSeason: "2026",
    browserMflUserId: token ? new URL(url).searchParams.get("MFL_USER_ID") || "" : "",
    cookieMflUserId: cookieToken || "", sessionByApiKey: !!sessionByApiKey, deps: d || deps(),
  });
  await ctx.flush();
  if (!resp) return { none: true };
  return { status: resp.status, headers: resp.headers, json: await resp.json() };
}
const fresh = (over) => { const env = makeEnv(); seedTrade(env, over); discord.reset(); return env; };

// ───────────────────── the guard that caused the outage ─────────────────────
function extractGuard(src) {
  const start = src.indexOf("      if (\n        !L &&");
  const end = src.indexOf('\n      ) {\n        return new Response(\n          JSON.stringify({ ok: false, isAdmin: false, reason: "Missing L param" })', start);
  if (start < 0 || end < 0) throw new Error("could not locate the global no-L guard in worker/src/index.js");
  const cond = src.slice(src.indexOf("!L &&", start), end);
  return { cond, blocks: new Function("path", "L", `return (${cond});`) };
}
const INDEX_SRC = fs.readFileSync(new URL("../worker/src/index.js", import.meta.url), "utf8");

test("GUARD: the real no-L guard is extractable and blocks unknown paths (control)", () => {
  const { blocks } = extractGuard(INDEX_SRC);
  t.equal(blocks("/definitely/not/a/route", ""), true);
  t.equal(blocks("/definitely/not/a/route", "74598"), false);
});

test("GUARD: 3-way owner routes are NOT blocked when the client omits ?L= (the outage)", () => {
  const { blocks } = extractGuard(INDEX_SRC);
  for (const p of ["/api/trades/3way", "/api/trades/3way/cancel"]) t.equal(blocks(p, ""), false);
});

test("GUARD: the exemption is EXACT — sibling and look-alike paths under /api/trades/3way are still blocked without L", () => {
  const { blocks } = extractGuard(INDEX_SRC);
  for (const p of ["/api/trades/3way/", "/api/trades/3way/anything", "/api/trades/3way/cancel/x", "/api/trades/3wayx", "/api/trades/3way/../3way/cancel"]) t.equal(blocks(p, ""), true, p);
});

test("GUARD: without the exemption the very same test would fail (proves it is sensitive to the defect)", () => {
  const { cond } = extractGuard(INDEX_SRC);
  const original = cond.replace(/path !== "\/api\/trades\/3way" &&\s*path !== "\/api\/trades\/3way\/cancel" &&\s*/, "");
  t.notEqual(original, cond);
  const blocksOriginal = new Function("path", "L", `return (${original});`);
  t.equal(blocksOriginal("/api/trades/3way/cancel", ""), true);
  t.equal(blocksOriginal("/api/trades/3way", ""), true);
});

test("GUARD: neighbouring 2-way exemptions are untouched", () => {
  const { blocks } = extractGuard(INDEX_SRC);
  for (const p of ["/api/trades/proposals", "/api/trades/proposals/action", "/api/trades/outbox", "/api/trades/reconcile/extensions", "/api/trades/refresh-after-trade", "/trade-pending", "/trade-offers", "/trade-outbox", "/refresh/after-trade"]) {
    t.equal(blocks(p, ""), false);
  }
});

test("WIRING: index.js delegates every owner 3-way route to handle3WayHttp and keeps no legacy copy", () => {
  t.match(INDEX_SRC, /handle3WayHttp\(\{/);
  t.doesNotMatch(INDEX_SRC, /cancel3WayTrade\(/);
  t.doesNotMatch(INDEX_SRC, /list3WayForFranchise\(/);
  t.doesNotMatch(INDEX_SRC, /create3WayTrade\(/);
  t.match(INDEX_SRC, /path === "\/api\/trades\/3way" \|\| path\.startsWith\("\/api\/trades\/3way\/"\)/);
  t.match(INDEX_SRC, /path === "\/admin\/3way\/inspect"/);
  t.match(INDEX_SRC, /path === "\/admin\/3way\/retry"/);
  for (const two of ['path === "/api/trades/proposals"', 'path === "/api/trades/proposals/action"', '"/trade-pending"', '"/api/trades/outbox"']) t.ok(INDEX_SRC.includes(two), two);
});

// ───────────────────────────── cancel ─────────────────────────────
test("CANCEL: mobile's exact request shape (no L, legacy body) now succeeds for the initiator", async () => {
  const env = fresh();
  const r = await call(env, "POST", "/api/trades/3way/cancel?MFL_USER_ID=tok-A", { token: 1, body: { id: TRADE_ID, franchise_id: "0008", league_id: "74598" } });
  t.equal(r.status, 200);
  t.equal(r.json.ok, true);
  t.equal(r.json.code, "cancelled");
  t.equal(r.json.trade.status, "cancelled");
  t.equal(r.json.trade.can_cancel, false);
  t.equal(readRow(env).status, "cancelled");
  t.equal(r.headers.get("access-control-allow-origin"), "*");
});

test("CANCEL: no session at all is a 401 and changes nothing", async () => {
  const env = fresh();
  const r = await call(env, "POST", "/api/trades/3way/cancel?L=74598", { body: { id: TRADE_ID } });
  t.equal(r.status, 401); t.equal(r.json.code, "unauthenticated"); t.equal(r.json.ok, false);
  t.equal(readRow(env).status, "collecting");
});

test("CANCEL: an unverifiable token is rejected (the old code accepted ANY non-empty string)", async () => {
  const env = fresh();
  const r = await call(env, "POST", "/api/trades/3way/cancel?MFL_USER_ID=notarealtoken", { token: 1, body: { id: TRADE_ID, franchise_id: "0008" } });
  t.equal(r.status, 401); t.equal(r.json.code, "session_expired");
  t.equal(readRow(env).status, "collecting");
});

test("CANCEL: an MFL outage while verifying identity fails closed as 503, not as success or 'not yours'", async () => {
  const env = fresh();
  const r = await call(env, "POST", "/api/trades/3way/cancel?MFL_USER_ID=tok-net", { token: 1, body: { id: TRADE_ID } });
  t.equal(r.status, 503); t.equal(r.json.code, "identity_unavailable");
  const r2 = await call(env, "POST", "/api/trades/3way/cancel?MFL_USER_ID=tok-nomember", { token: 1, body: { id: TRADE_ID } });
  t.equal(r2.status, 403);
  t.equal(readRow(env).status, "collecting");
});

test("CANCEL: a body franchise_id cannot be used to cancel as someone else", async () => {
  const env = fresh();
  const r = await call(env, "POST", "/api/trades/3way/cancel?MFL_USER_ID=tok-B", { token: 1, body: { id: TRADE_ID, franchise_id: "0008" } });
  t.equal(r.status, 403); t.equal(r.json.code, "forbidden");
  const q = await call(env, "POST", "/api/trades/3way/cancel?MFL_USER_ID=tok-B&acting_franchise_id=0008", { token: 1, body: { id: TRADE_ID } });
  t.equal(q.status, 403);
  t.equal(readRow(env).status, "collecting");
});

test("CANCEL: a partner acting as themselves gets the specific 'only the initiator' answer", async () => {
  const env = fresh();
  const r = await call(env, "POST", "/api/trades/3way/cancel?MFL_USER_ID=tok-B", { token: 1, body: { id: TRADE_ID, franchise_id: "0001" } });
  t.equal(r.status, 403); t.equal(r.json.code, "only_initiator_can_cancel");
  t.match(r.json.error, /Discord DM/);
  t.equal(r.json.trade.status, "collecting");
  t.equal(readRow(env).status, "collecting");
});

test("CANCEL: an unrelated owner is refused without seeing the trade", async () => {
  const env = fresh();
  const r = await call(env, "POST", "/api/trades/3way/cancel?MFL_USER_ID=tok-O", { token: 1, body: { id: TRADE_ID } });
  t.equal(r.status, 403); t.equal(r.json.trade, undefined);
});

test("CANCEL: acting as the initiator is NOT an owner cancel — even a proven commissioner is sent to the administrative action", async () => {
  const env = fresh();
  const r = await call(env, "POST", "/api/trades/3way/cancel?MFL_USER_ID=tok-commish&acting_franchise_id=0008", { token: 1, body: { id: TRADE_ID } });
  t.equal(r.status, 403); t.equal(r.json.code, "commissioner_use_admin_action");
  t.equal(readRow(env).status, "collecting");
  // an ordinary owner naming the initiator's franchise is refused and changes nothing
  const env2 = fresh();
  const r2 = await call(env2, "POST", "/api/trades/3way/cancel?MFL_USER_ID=tok-B&acting_franchise_id=0008", { token: 1, body: { id: TRADE_ID } });
  t.equal(r2.status, 403); t.equal(r2.json.code, "forbidden");
  t.equal(readRow(env2).status, "collecting");
  // ...and so is a body franchise_id (the legacy way of saying it)
  const r3 = await call(env2, "POST", "/api/trades/3way/cancel?MFL_USER_ID=tok-C", { token: 1, body: { id: TRADE_ID, franchise_id: "0008" } });
  t.equal(r3.status, 403); t.equal(readRow(env2).status, "collecting");
});

test("CANCEL: a commissioner session (not the initiator) is refused on the owner route and pointed to the administrative action", async () => {
  const env = fresh();
  const r = await call(env, "POST", "/api/trades/3way/cancel?MFL_USER_ID=tok-commish", { token: 1, body: { id: TRADE_ID } });
  t.equal(r.status, 403); t.equal(r.json.code, "commissioner_use_admin_action");
  t.match(r.json.error, /administrative cancel/);
  t.equal(readRow(env).status, "collecting");
});

test("CANCEL: a commissioner whose own franchise started the trade cancels it as the initiator", async () => {
  const env = fresh();
  const r = await call(env, "POST", "/api/trades/3way/cancel?MFL_USER_ID=tok-A", { token: 1, body: { id: TRADE_ID }, d: deps({ commishFids: () => ["0008", "0000"] }) });
  t.equal(r.status, 200);
  t.equal(readRow(env).failure_reason, "cancelled_by_initiator");
});

test("CANCEL: the admin key does not turn the OWNER route into a commissioner cancel, with or without naming the initiator", async () => {
  const env = fresh(); env.COMMISH_API_KEY = "admin-key-secret";
  const none = await call(env, "POST", "/api/trades/3way/cancel?APIKEY=admin-key-secret", { body: { id: TRADE_ID } });
  t.ok([400, 403].includes(none.status), `status ${none.status}`); t.equal(readRow(env).status, "collecting");
  const bad = await call(env, "POST", "/api/trades/3way/cancel?APIKEY=wrong&acting_franchise_id=0008", { body: { id: TRADE_ID } });
  t.equal(bad.status, 403); t.equal(readRow(env).status, "collecting");
  const named = await call(env, "POST", "/api/trades/3way/cancel?APIKEY=admin-key-secret&acting_franchise_id=0008", { body: { id: TRADE_ID } });
  t.equal(named.status, 403); t.equal(named.json.code, "commissioner_use_admin_action");
  t.equal(readRow(env).status, "collecting");
});

test("CANCEL: repeated, in-flight and finished trades return clear conflicts, never a generic failure", async () => {
  const env = fresh();
  const first = await call(env, "POST", "/api/trades/3way/cancel?MFL_USER_ID=tok-A", { token: 1, body: { id: TRADE_ID } });
  const again = await call(env, "POST", "/api/trades/3way/cancel?MFL_USER_ID=tok-A", { token: 1, body: { id: TRADE_ID } });
  t.equal(first.json.already, false); t.equal(again.status, 200); t.equal(again.json.already, true);
  const exec = fresh({ status: "executing" });
  const e = await call(exec, "POST", "/api/trades/3way/cancel?MFL_USER_ID=tok-A", { token: 1, body: { id: TRADE_ID } });
  t.equal(e.status, 409); t.equal(e.json.code, "cannot_cancel_executing"); t.match(e.json.error, /being processed/);
  const done = fresh({ status: "completed" });
  t.equal((await call(done, "POST", "/api/trades/3way/cancel?MFL_USER_ID=tok-A", { token: 1, body: { id: TRADE_ID } })).json.code, "cannot_cancel_completed");
});

test("CANCEL: bad JSON, a missing trade and a bad id are 400 / 404 / 400", async () => {
  const env = fresh();
  const url = new URL("https://worker.test/api/trades/3way/cancel?MFL_USER_ID=tok-A");
  const bad = await handle3WayHttp({ request: new Request(url, { method: "POST", body: "{nope" }), url, path: url.pathname, env, ctx: ctxWait(), corsHeaders: CORS, browserMflUserId: "tok-A", deps: deps() });
  t.equal(bad.status, 400);
  t.equal((await call(env, "POST", "/api/trades/3way/cancel?MFL_USER_ID=tok-A", { token: 1, body: { id: "00000000-0000-0000-0000-000000000000" } })).status, 404);
  t.equal((await call(env, "POST", "/api/trades/3way/cancel?MFL_USER_ID=tok-A", { token: 1, body: {} })).status, 400);
});

// ───────────────────────────── load ─────────────────────────────
test("LOAD: detail returns the canonical trade to every participant and to the commissioner", async () => {
  const env = fresh();
  for (const tok of ["tok-A", "tok-B", "tok-C", "tok-commish"]) {
    const r = await call(env, "GET", `/api/trades/3way?id=${TRADE_ID}&MFL_USER_ID=${tok}`, { token: 1 });
    t.equal(r.status, 200);
    t.equal(r.json.trade.id, TRADE_ID);
    t.equal(r.json.trade.participants.length, 3);
    t.equal(r.json.trade.sides.length, 3);
  }
});

test("LOAD: refresh / deep-link returns the identical body every time", async () => {
  const env = fresh();
  const a = await call(env, "GET", `/api/trades/3way?id=${TRADE_ID}&MFL_USER_ID=tok-B`, { token: 1 });
  const b = await call(env, "GET", `/api/trades/3way?id=${TRADE_ID}&MFL_USER_ID=tok-B&L=74598`, { token: 1 });
  t.deepEqual(a.json, b.json);
});

test("LOAD: mobile (list) and desktop (detail) consume byte-identical canonical trades", async () => {
  const env = fresh();
  const list = await call(env, "GET", "/api/trades/3way?L=74598&MFL_USER_ID=tok-A", { token: 1 });
  const detail = await call(env, "GET", `/api/trades/3way?id=${TRADE_ID}&MFL_USER_ID=tok-A`, { token: 1 });
  t.equal(list.json.trades.length, 1);
  t.deepEqual(list.json.trades[0], detail.json.trade);
  t.deepEqual(list.json.three_way, list.json.trades);
});

test("LOAD: unauthenticated, forbidden, missing and invalid ids are distinct answers", async () => {
  const env = fresh();
  t.equal((await call(env, "GET", `/api/trades/3way?id=${TRADE_ID}`)).status, 401);
  t.equal((await call(env, "GET", `/api/trades/3way?id=${TRADE_ID}&MFL_USER_ID=tok-O`, { token: 1 })).status, 403);
  t.equal((await call(env, "GET", "/api/trades/3way?id=00000000-0000-0000-0000-000000000000&MFL_USER_ID=tok-A", { token: 1 })).status, 404);
  t.equal((await call(env, "GET", "/api/trades/3way?id=bad&MFL_USER_ID=tok-A", { token: 1 })).status, 400);
});

test("LOAD: the outbox is no longer readable without a session, and only for your own franchise", async () => {
  const env = fresh();
  t.equal((await call(env, "GET", "/api/trades/3way?L=74598&franchise_id=0008")).status, 401);
  const own = await call(env, "GET", "/api/trades/3way?L=74598&franchise_id=0001&MFL_USER_ID=tok-B", { token: 1 });
  t.equal(own.status, 200); t.equal(own.json.trades.length, 1);
  const peek = await call(env, "GET", "/api/trades/3way?L=74598&franchise_id=0008&MFL_USER_ID=tok-B", { token: 1 });
  t.equal(peek.status, 403);
  const comm = await call(env, "GET", "/api/trades/3way?L=74598&franchise_id=0008&MFL_USER_ID=tok-commish", { token: 1 });
  t.equal(comm.status, 200); t.equal(comm.json.trades.length, 1);
});

test("LOAD: history is opt-in and a cancelled trade still loads by id", async () => {
  const env = fresh({ status: "cancelled", failure_reason: "cancelled_by_initiator" });
  const active = await call(env, "GET", "/api/trades/3way?L=74598&MFL_USER_ID=tok-A", { token: 1 });
  t.equal(active.json.trades.length, 0);
  const all = await call(env, "GET", "/api/trades/3way?L=74598&include=all&MFL_USER_ID=tok-A", { token: 1 });
  t.equal(all.json.trades.length, 1);
  const one = await call(env, "GET", `/api/trades/3way?id=${TRADE_ID}&MFL_USER_ID=tok-A`, { token: 1 });
  t.equal(one.status, 200); t.equal(one.json.trade.state_view.label, "Called off");
});

test("LOAD: cached (pre-fix) mobile clients still read the legacy aliases they expect", async () => {
  const env = fresh();
  const r = await call(env, "GET", "/api/trades/3way?L=74598&MFL_USER_ID=tok-A", { token: 1 });
  const tr = r.json.three_way[0];
  t.equal(tr.role, "initiator"); t.equal(tr.can_cancel, true);
  t.equal(tr.initiator_name, "Real Deal Creel"); t.equal(tr.team_b_name, "L.A. Looks");
  t.deepEqual(tr.waiting_on, ["L.A. Looks", "Hawks"]);
  t.equal(tr.movements[0].from_name, "Real Deal Creel"); t.equal(tr.movements[0].to_name, "Hawks");
  t.equal(tr.created_at_utc, "2026-09-23T20:21:41.139Z");
});

test("LOAD: a database failure is a clean 503 with no internals", async () => {
  const env = makeEnv({ d1: { beforeRun: (sql) => { if (/FROM ups_3way_trades/.test(sql)) throw new Error("D1_ERROR: secret table detail"); } } });
  const r = await call(env, "GET", `/api/trades/3way?id=${TRADE_ID}&MFL_USER_ID=tok-A`, { token: 1 });
  t.equal(r.status, 503); t.equal(r.json.code, "unavailable");
  t.doesNotMatch(JSON.stringify(r.json), /secret|D1_ERROR/);
});

// ───────────────────────────── create ─────────────────────────────
const CREATE_BODY = (initiatorFid) => ({
  league_id: "74598", season: "2026",
  initiator: { fid: initiatorFid, name: "x" }, team_b: { fid: "0001", name: "L.A. Looks" }, team_c: { fid: "0012", name: "Hawks" },
  movements: [{ from: "0008", to: "0012", asset_tokens: ["P_16614"], cap_k: 0, summary: "MHJ" }, { from: "0012", to: "0001", asset_tokens: ["FP_0012_2027_1"], cap_k: 0, summary: "R1" }, { from: "0001", to: "0008", asset_tokens: ["P_16181"], cap_k: 0, summary: "CB" }],
});

test("CREATE: the initiator must be the proven viewer (the old code trusted the body)", async () => {
  const env = makeEnv();
  const r = await call(env, "POST", "/api/trades/3way?L=74598&MFL_USER_ID=tok-B", { token: 1, body: CREATE_BODY("0008") });
  t.equal(r.status, 403); t.equal(r.json.code, "forbidden");
  t.equal(env.UPS_MFL_DB.raw.prepare("SELECT COUNT(*) AS n FROM ups_3way_trades").get().n, 0);
  t.equal(discord.messages().length, 0);
});

test("CREATE: a real initiator creates it; both partners get exactly one invite DM", async () => {
  const env = makeEnv(); discord.reset();
  const r = await call(env, "POST", "/api/trades/3way?L=74598&MFL_USER_ID=tok-A", { token: 1, body: CREATE_BODY("0008") });
  t.equal(r.status, 201); t.equal(r.json.ok, true);
  const row = env.UPS_MFL_DB.raw.prepare("SELECT * FROM ups_3way_trades").get();
  t.equal(row.status, "collecting"); t.equal(row.initiator_fid, "0008"); t.equal(row.team_b_state, "pending");
  t.equal(discord.messages().length, 2);
  t.equal(discord.to(DISCORD.B).length, 1); t.equal(discord.to(DISCORD.C).length, 1); t.equal(discord.to(DISCORD.A).length, 0);
  const seen = await call(env, "GET", `/api/trades/3way?id=${r.json.id}&MFL_USER_ID=tok-C`, { token: 1 });
  t.equal(seen.status, 200);
});

test("CREATE: validation and internal errors are friendly and never leak exception text", async () => {
  const env = makeEnv();
  const dup = CREATE_BODY("0008"); dup.team_c = { fid: "0001", name: "dup" };
  const r = await call(env, "POST", "/api/trades/3way?L=74598&MFL_USER_ID=tok-A", { token: 1, body: dup });
  t.equal(r.status, 400); t.equal(r.json.error, "A 3-way needs three different teams.");
  const broken = makeEnv({ d1: { failWrites: true } });
  const r2 = await call(broken, "POST", "/api/trades/3way?L=74598&MFL_USER_ID=tok-A", { token: 1, body: CREATE_BODY("0008") });
  t.equal(r2.status, 400); t.equal(r2.json.error, "Couldn't create the 3-way trade.");
  t.doesNotMatch(JSON.stringify(r2.json), /simulated|D1_ERROR/);
  const off = makeEnv({ env: { TRADE_3WAY_ENABLED: "0" } });
  const r3 = await call(off, "POST", "/api/trades/3way?L=74598&MFL_USER_ID=tok-A", { token: 1, body: CREATE_BODY("0008") });
  t.equal(r3.json.error, "3-way trades aren't turned on right now.");
});

// ───────────────────────────── routing ─────────────────────────────
test("ROUTING: unrelated paths and methods fall through to the rest of the worker", async () => {
  const env = fresh();
  t.equal((await call(env, "GET", "/api/trades/3way/cancel?MFL_USER_ID=tok-A", { token: 1 })).none, true);
  t.equal((await call(env, "GET", "/api/trades/3way/other", {})).none, true);
  t.equal((await call(env, "DELETE", "/api/trades/3way", {})).none, true);
  t.equal((await call(env, "GET", "/api/trades/proposals", {})).none, true);
});

await run("trade_3way_http");
restoreConsole();
discord.restore();
