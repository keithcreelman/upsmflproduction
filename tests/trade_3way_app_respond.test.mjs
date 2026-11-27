// Keith 2026-11-26 ("A"): on the TEST deployment, a 3-team partner answers in the app (POST /api/trades/3way/respond), because Discord is off there.
// The rules are the Discord button's own (trade_3way.respond3Way, shared); the route exists only where env TRADE_3WAY_APP_RESPOND is "1"
// (worker/wrangler.test.toml), and answers only for the caller's own team, proven by its MFL session.
//   node tests/trade_3way_app_respond.test.mjs
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeEnv, seedTrade, readRow, goodDeps, installDiscordRecorder, quietConsole, TRADE_ID, DISCORD } from "./fixtures/trade_3way_fixture.mjs";
await import("./fixtures/register_md_loader.mjs");
const { handle3WayHttp, THREE_WAY_ROUTES } = await import("../worker/src/trade_3way_http.js");
const { handle3WayButton } = await import("../worker/src/trade_3way.js");

const restoreConsole = quietConsole();
const discord = installDiscordRecorder();
const SESSIONS = { "tok-A": "0008", "tok-B": "0001", "tok-C": "0012", "tok-O": "0003", "tok-commish": "0000" };
const deps = { detectFranchise: async (tok) => (SESSIONS[tok] ? { franchise_id: SESSIONS[tok], franchise_name: "x" } : { error: "HTTP 401" }), commishFids: () => ["0000"], ...goodDeps };
async function call(env, token, body, q = "") {
  const url = new URL("https://worker.test/api/trades/3way/respond?L=74598&MFL_USER_ID=" + token + q);
  const request = new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const p = []; const ctx = { waitUntil: (x) => p.push(x) };
  const resp = await handle3WayHttp({ request, url, path: url.pathname, env, ctx, corsHeaders: {}, defaultLeagueId: "74598", defaultSeason: "2026", browserMflUserId: token, cookieMflUserId: "", deps });
  await Promise.all(p);
  return resp ? { status: resp.status, json: await resp.json() } : { none: true };
}
const world = (flag = "1") => { const env = makeEnv({ env: { TRADE_3WAY_APP_RESPOND: flag, TRADE_3WAY_EXECUTE: "0" } }); seedTrade(env); discord.reset(); return env; };

test("the route exists only where TRADE_3WAY_APP_RESPOND is \"1\"; production's config doesn't set it, the test config does", async () => {
  t.equal((await call(world("0"), "tok-B", { id: TRADE_ID, action: "accept" })).none, true, "flag off: not answered here");
  t.equal((await call(world(""), "tok-B", { id: TRADE_ID, action: "accept" })).none, true);
  t.ok(THREE_WAY_ROUTES.includes("/api/trades/3way/respond"));
  t.doesNotMatch(fs.readFileSync(new URL("../worker/wrangler.toml", import.meta.url), "utf8"), /TRADE_3WAY_APP_RESPOND/, "never in production's config");
  t.match(fs.readFileSync(new URL("../worker/wrangler.test.toml", import.meta.url), "utf8"), /^TRADE_3WAY_APP_RESPOND = "1"$/m);
});

test("partners accept in the app: B then C; with both in, the trade runs as the Discord path does (dry-run here: recorded, nothing moved)", async () => {
  const env = world();
  const b = await call(env, "tok-B", { id: TRADE_ID, action: "accept" });
  t.equal(b.status, 200); t.equal(b.json.code, "accepted_waiting"); t.equal(readRow(env).team_b_state, "accepted"); t.equal(readRow(env).status, "collecting");
  t.equal((await call(env, "tok-B", { id: TRADE_ID, action: "accept" })).json.code, "already_accepted", "again: nothing new");
  const c = await call(env, "tok-C", { id: TRADE_ID, action: "accept" });
  t.equal(c.status, 200); t.equal(c.json.code, "accepted_all_in");
  const row = readRow(env); t.equal(row.team_c_state, "accepted"); t.equal(row.status, "completed"); t.equal(row.failure_reason, "dry_run");
});

test("decline calls it off; only the two partners, as themselves, may answer", async () => {
  const env = world();
  t.equal((await call(env, "tok-A", { id: TRADE_ID, action: "accept" })).status, 403, "the initiator isn't a partner");
  t.equal((await call(env, "tok-O", { id: TRADE_ID, action: "accept" })).status, 403, "an unrelated team");
  t.equal((await call(env, "tok-commish", { id: TRADE_ID, action: "accept" }, "&acting_franchise_id=0001")).status, 403, "not the commissioner acting as a partner");
  t.equal((await call(env, "tok-B", { id: TRADE_ID, action: "maybe" })).status, 400);
  t.equal((await call(env, "tok-B", { id: "nope", action: "accept" })).status, 404);
  t.equal(readRow(env).team_b_state, "pending", "none of those recorded anything");
  const d = await call(env, "tok-C", { id: TRADE_ID, action: "decline" });
  t.equal(d.status, 200); t.equal(d.json.code, "declined"); t.equal(readRow(env).status, "cancelled");
  t.equal((await call(env, "tok-B", { id: TRADE_ID, action: "accept" })).status, 409, "a called-off trade can't be accepted");
});

test("the Discord button still answers exactly as before (it now shares the same core)", async () => {
  const env = world();
  const press = (u, a) => ({ data: { custom_id: "tr3:" + a + ":" + TRADE_ID }, member: { user: { id: u } } });
  const say = async (r) => (await r.json()).data.content;
  t.match(await say(await handle3WayButton(press(DISCORD.A, "accept"), env, { waitUntil() {} })), /Only the two partners can respond/);
  t.match(await say(await handle3WayButton(press(DISCORD.B, "accept"), env, { waitUntil() {} })), /You're in\. Waiting on/);
  t.match(await say(await handle3WayButton(press(DISCORD.B, "accept"), env, { waitUntil() {} })), /already in/);
  t.match(await say(await handle3WayButton({ data: { custom_id: "bad" } }, env, {})), /Unknown button/);
});

await run("trade_3way_app_respond");
restoreConsole();
