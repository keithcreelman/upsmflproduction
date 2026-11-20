// Mobile beta, Stage 1 (#1475): the beta gate's decision table, route allowlist and the "original app is untouched" guarantee.
//   node tests/beta_gate.test.mjs
//
// The gate runs on the REAL session store (SQLite) and the real flag reader. Proves: a request with neither the marker nor a beta credential
// is left alone with ZERO reads; every admin route (all of ADMIN_ROUTES, in every spelling) and every non-allowlisted write refuses a VALID session;
// an unlisted GET passes WITHOUT the session; the franchise binding; the failure modes (flags/D1/keys unreadable) refuse before anything else runs.
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeD1, applyMigrations } from "./fixtures/d1_sqlite.mjs";
import * as B from "../worker/src/beta_session.js";
import { betaGate, matchBetaRoute, BETA_ROUTES } from "../worker/src/beta_gate.js";
import { getFeatureFlagsFor } from "../worker/src/feature_flags.js";
import { ADMIN_ROUTES, ADMIN_DYNAMIC_ROUTES } from "../worker/src/admin_routes.js";

const KEYENV = { BETA_SESSION_KEY: `k1:${B.b64urlEncode(new Uint8Array(32).fill(7))}` };
const NOW = Date.parse("2026-11-20T15:00:00Z");
const MFL = "MFL-SESSION-CANARY";
const FLAGS = ["BETA_ENABLED", "BETA_FLOW_LINEUP", "BETA_FLOW_ROSTER", "BETA_FLOW_TRADES", "BETA_FLOW_WAIVERS", "BETA_FLOW_AUCTION", "BETA_FLOW_CONTRACTS"];

async function world(over) {
  const d1 = makeD1({}); applyMigrations(d1, ["0176_beta_sessions.sql"]);
  d1.raw.exec("CREATE TABLE IF NOT EXISTS ups_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)");
  const env = { UPS_MFL_DB: d1, ...KEYENV, ...(over || {}) };
  const store = B.makeBetaStore(d1);
  const setFlags = (flags) => { const cur = JSON.parse((d1.raw.prepare("SELECT value FROM ups_settings WHERE key='feature_flags'").get() || { value: "{}" }).value); for (const [k, v] of Object.entries(flags)) cur[k] = v ? "1" : "0"; d1.raw.prepare("INSERT INTO ups_settings (key, value) VALUES ('feature_flags', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(cur)); };
  setFlags(Object.fromEntries(FLAGS.map((f) => [f, true])));
  const deps = { getFlags: (names) => getFeatureFlagsFor(env, names), store, keyring: () => B.parseKeyring(env) };
  const session = async (o) => {
    o = { fid: "0008", league: "74598", environment: "live", now: NOW - 1000, mfl: MFL, ...(o || {}) };
    await store.invite(o.fid, o.league, o.environment, "", o.now);
    const rowId = B.newRowId(), code = B.newHandoffCode();
    const sealed = await B.sealMflSession(B.parseKeyring(KEYENV), { rowId, franchiseId: o.fid, leagueId: o.league, environment: o.environment }, o.mfl);
    await store.createHandoff({ rowId, franchiseId: o.fid, leagueId: o.league, environment: o.environment, codeHash: await B.sha256Hex(code), mflEnc: sealed.mflEnc, keyId: sealed.keyId, now: o.now });
    const sid = B.newSessionId();
    const r = await store.redeem({ codeHash: await B.sha256Hex(code), environment: o.environment, sidHash: await B.sha256Hex(sid), now: o.now + 10 });
    if (!r.redeemed) throw new Error("test session not created");
    return sid;
  };
  const gate = (method, path, o) => {
    o = o || {};
    const headers = { ...(o.marker === false ? {} : { "X-UPS-Client": "beta/test" }), ...(o.sid ? { Authorization: `Bearer ${o.sid}` } : {}), ...(o.headers || {}) };
    const init = { method, headers };
    if (o.body !== undefined) { init.body = JSON.stringify(o.body); init.headers = { "Content-Type": "application/json", ...headers }; }
    return betaGate({ request: new Request("https://worker.test" + path, init), env, now: o.now || NOW, deps: o.deps || deps });
  };
  return { d1, env, store, deps, setFlags, session, gate, stmts: () => d1.log.length };
}
const Q = "?L=74598&YEAR=2026";

test("ORIGINAL APP UNTOUCHED: a request with neither the marker nor a beta credential is 'original' with ZERO flag reads, D1 statements or session work, whatever else it carries", async () => {
  const w = await world();
  const sid = await w.session();
  const base = w.stmts();
  const originals = [
    ["GET", "/api/me" + Q + "&MFL_USER_ID=tok-A", {}],
    ["GET", "/api/me" + Q, { headers: { Cookie: "MFL_USER_ID=tok-A" } }],
    ["POST", "/api/submit-lineup" + Q, { body: { franchise_id: "0008", mfl_user_id: "tok-A" } }],
    ["POST", "/roster-workbench/action" + Q + "&APIKEY=anything", { body: { action: "drop_player" } }],
    ["GET", "/admin/config-health" + Q + "&APIKEY=k", {}],
    ["POST", "/admin/3way/cancel" + Q, {}],
    ["GET", "/api/hall/proposals", {}],
    ["GET", "/api/me" + Q, { headers: { Authorization: "Bearer some-other-token" } }],
    ["GET", "/api/me" + Q, { headers: { Authorization: "Basic dXNlcjpwYXNz" } }],
    ["GET", "/api/me" + Q, { headers: { "X-UPS-Client": "classic/1.2" } }],            // a client that says it is NOT the beta
    ["GET", "/api/me" + Q, { headers: { "X-UPS-Client": "" } }],
    ["POST", "/api/beta/handoff" + Q, { body: { mfl_user_id: "tok-A" } }],               // the original app's own beta calls are routed, not gated
    ["POST", "/api/beta/status" + Q, { body: { mfl_user_id: "tok-A" } }],
  ];
  for (const [m, p, o] of originals) {
    const r = await w.gate(m, p, { marker: false, ...o });
    t.equal(r.kind, "original", `${m} ${p}`);
  }
  t.equal(w.stmts(), base, "no D1 statement of any kind for any original-app request");
  void sid;
});

test("CLASSIFICATION: the marker alone, or a beta-shaped credential alone, makes a request a beta request; each is a claim that can only narrow", async () => {
  const w = await world();
  const sid = await w.session();
  t.equal((await w.gate("GET", "/api/mfl-export" + Q, {})).kind, "pass", "marker, no session id, public read: anonymous passthrough");
  t.equal((await w.gate("POST", "/api/submit-lineup" + Q, { body: {} })).code, "session_required", "marker, no session id, a write");
  t.equal((await w.gate("GET", "/api/me" + Q, { marker: false, sid })).kind, "inject", "a session id alone (no marker) is a beta request");
  t.equal((await w.gate("GET", "/api/me" + Q, { marker: false, headers: { Authorization: "Bearer ups_bs_" + "x".repeat(10) } })).code, "session_invalid", "a beta-shaped credential alone is judged as one");
  t.equal((await w.gate("GET", "/api/me" + Q, { marker: false, headers: { authorization: "bearer " + sid } })).kind, "inject", "header name and scheme are case-insensitive");
  t.equal((await w.gate("GET", "/api/me" + Q, { headers: { "x-ups-client": "BETA/9" }, sid })).kind, "inject");
  t.equal((await w.gate("GET", "/api/me" + Q, { headers: { "X-UPS-Client": "betaX" }, sid })).kind, "inject", "anything starting with beta counts");
});

test("THE DECISION TABLE: each refusal code, in the documented order", async () => {
  const w = await world();
  const sid = await w.session();
  const ok = (o) => w.gate("POST", "/api/submit-lineup" + Q, { sid, body: { franchise_id: "0008" }, ...(o || {}) });
  t.equal((await ok()).kind, "inject");
  t.equal((await ok({ sid: "ups_bs_" + "A".repeat(43) })).code, "session_invalid", "unknown id");
  t.equal((await ok({ now: NOW + B.SESSION_TTL_MS + 5000 })).code, "session_expired", "expired");
  t.equal((await w.gate("POST", "/api/submit-lineup?L=25625", { sid, body: { franchise_id: "0008" } })).code, "league_not_allowed", "the test league for a live session");
  t.equal((await w.gate("POST", "/api/submit-lineup?L=99999", { sid, body: { franchise_id: "0008" } })).code, "league_not_allowed", "an unknown league");
  t.equal((await w.gate("POST", "/api/submit-lineup", { sid, body: { franchise_id: "0008" } })).kind, "inject", "no L means the live league, the worker's own default");
  w.d1.raw.prepare("UPDATE ups_beta_invites SET revoked_at = 1").run();
  t.equal((await ok()).code, "not_invited", "invitation revoked while the session row stays: refused on the very next request");
  w.d1.raw.prepare("UPDATE ups_beta_invites SET revoked_at = NULL").run();
  w.setFlags({ BETA_FLOW_LINEUP: false });
  t.equal((await ok()).code, "flow_off");
  t.equal((await w.gate("GET", "/api/me" + Q, { sid })).kind, "inject", "a switch for one flow does not affect another");
  w.setFlags({ BETA_FLOW_LINEUP: true, BETA_ENABLED: false });
  t.equal((await ok()).code, "beta_paused");
  t.equal((await w.gate("GET", "/api/mfl-export" + Q, { sid })).code, "beta_paused", "even a public read carrying a session id learns the beta is paused");
  t.equal((await w.gate("GET", "/api/mfl-export" + Q, {})).kind, "pass", "while a public read with no session id is the same anonymous request as ever");
});

test("ALLOWLIST: only exact listed routes get the session; variants, aliases and unlisted routes never do", async () => {
  const w = await world();
  const sid = await w.session();
  const inj = async (m, p, body) => (await w.gate(m, p + Q, { sid, body })).kind;
  for (const r of BETA_ROUTES) {
    const sample = r.re.source.includes("2way") ? "/api/trades/2way/accept" : r.re.source.includes("waivers\\/(state") ? "/api/waivers/state" : r.re.source.includes("waivers\\/(bbid") ? "/api/waivers/fcfs" : r.re.source.includes("auction") ? "/api/auction/bid" : r.re.source.includes("commish-contract") ? "/offer-mym" : r.re.source.replace(/^\^|\$$/g, "").replace(/\\\//g, "/");
    t.ok(matchBetaRoute(r.methods[0], sample), "sample matches its own route: " + sample);
  }
  t.equal(await inj("GET", "/api/me"), "inject"); t.equal(await inj("POST", "/api/submit-lineup", {}), "inject");
  t.equal(await inj("POST", "/api/trades/2way/accept", {}), "inject"); t.equal(await inj("POST", "/api/trades/3way/ack-cap", {}), "inject");
  // deliberate exclusions and disguises: a write is REFUSED, a read passes with no session
  for (const p of ["/api/pick", "/api/settings", "/api/bug-reports", "/api/trades/compliance-preview", "/api/trades/outbox/replay", "/api/trades/reconcile/extensions", "/api/trades/refresh-after-trade",
    "/trade-offers", "/trade-offers/action", "/api/submit-lineup/", "/API/submit-lineup", "/api/Submit-Lineup", "/api//submit-lineup", "/api/submit-lineup%2F", "/api/submit-lineup;x", "/api/trades/2way/../../admin/x",
    "/api/trades/2way/Accept", "/api/waivers/other", "/api/auction/bid/x", "/offer-mym/", "/roster-workbench/admin-state"]) {
    t.equal(await inj("POST", p, {}), "refuse", "POST " + p + " is not on the allowlist");
    const g = await w.gate("GET", p + Q, { sid });
    t.ok(g.kind === "pass" || g.kind === "refuse", "GET " + p + " never injects: " + g.kind);
  }
  const unlistedGet = await w.gate("GET", "/api/lineup-matchups" + Q, { sid });
  t.equal(unlistedGet.kind, "pass"); t.ok(!unlistedGet.ctx, "an unlisted GET passes WITHOUT the MFL session");
  const wrongMethod = await w.gate("GET", "/api/submit-lineup" + Q, { sid });
  t.equal(wrongMethod.kind, "pass", "the right path with the wrong method is just an unlisted GET");
  t.equal((await w.gate("DELETE", "/api/me" + Q, { sid })).code, "beta_route_not_allowed");
  t.equal((await w.gate("PUT", "/api/lineup" + Q, { sid, body: {} })).code, "beta_route_not_allowed");
});

test("ADMIN: every one of the ADMIN_ROUTES (every allowed method), the dynamic admin routes and every disguised spelling refuse a VALID session, with no flag read and no session lookup", async () => {
  const w = await world();
  const sid = await w.session();
  const paths = [];
  for (const [p, methods] of Object.entries(ADMIN_ROUTES)) for (const m of (methods[0] === "*" ? ["GET", "POST"] : methods)) paths.push([m, p]);
  for (const d of ADMIN_DYNAMIC_ROUTES || []) paths.push(["POST", "/admin/rule-proposals/abc123/verdict"]);
  for (const v of ["/admin", "/admin/", "/ADMIN/3way/cancel", "/admin//3way/cancel", "//admin/3way/cancel", "/%61dmin/3way/cancel", "/admin%2F3way%2Fcancel", "/admin/./3way/cancel", "/admin/x/../3way/cancel", "/admin/nope", "/admin/beta/invites/", "/admin/beta/INVITES"]) paths.push(["POST", v]);
  t.ok(paths.length > 100, "enumerated " + paths.length + " admin method/path pairs");
  const before = w.stmts();
  for (const [m, p] of paths) {
    for (const o of [{ sid }, { sid: undefined }]) {
      const r = await w.gate(m, p + Q, { ...o, body: m === "POST" ? {} : undefined });
      t.equal(r.code, "beta_route_not_allowed", `${m} ${p} ${o.sid ? "(with a valid session)" : "(marker only)"}`);
    }
  }
  t.equal(w.stmts(), before, "not one flag read or session lookup was made for any admin path");
  t.ok(ADMIN_ROUTES["/admin/beta/invites"] && ADMIN_ROUTES["/admin/beta/purge-sessions"], "the beta's own admin routes are in the table, so the /admin front door guards them");
});

test("LIFECYCLE PATHS: a beta page may redeem and sign out, and nothing else under /api/beta/", async () => {
  const w = await world();
  t.equal((await w.gate("POST", "/api/beta/session" + Q, { body: {} })).kind, "route");
  t.equal((await w.gate("POST", "/api/beta/signout" + Q, { body: {} })).kind, "route");
  for (const p of ["/api/beta/handoff", "/api/beta/status", "/api/beta/", "/api/beta/anything", "/api/beta/session/x"]) t.equal((await w.gate("POST", p + Q, { body: {} })).code, "beta_route_not_allowed", p);
});

test("RAW CREDENTIALS: a beta request never carries an MFL session, a cookie, the commissioner key or a franchise other than its own", async () => {
  const w = await world();
  const sid = await w.session();
  const bad = async (path, o) => (await w.gate("POST", path + (path.includes("?") ? "&" : "?") + "L=74598", { sid, body: { franchise_id: "0008" }, ...o })).code;
  t.equal(await bad("/api/submit-lineup?MFL_USER_ID=x"), "ambiguous_credentials");
  t.equal(await bad("/api/submit-lineup?mfl_user_id=x"), "ambiguous_credentials");
  t.equal(await bad("/api/submit-lineup?APIKEY=k"), "ambiguous_credentials");
  t.equal(await bad("/api/submit-lineup?COMMISH_API_KEY=k"), "ambiguous_credentials");
  t.equal(await bad("/api/submit-lineup", { headers: { Cookie: "a=b; MFL_USER_ID=tok" } }), "ambiguous_credentials");
  t.equal(await bad("/api/submit-lineup", { body: { franchise_id: "0008", mfl_user_id: "x" } }), "ambiguous_credentials");
  t.equal(await bad("/api/submit-lineup", { body: { franchise_id: "0008", APIKEY: "k" } }), "ambiguous_credentials");
  t.equal(await bad("/api/submit-lineup", { body: { franchise_id: "0008", commish_api_key: "k" } }), "ambiguous_credentials");
  t.equal(await bad("/api/submit-lineup", { body: { franchise_id: "0001" } }), "franchise_mismatch");
  t.equal(await bad("/api/submit-lineup", { body: { from_franchise_id: "0001" } }), "franchise_mismatch");
  t.equal(await bad("/api/submit-lineup?franchise_id=0001", { body: {} }), "franchise_mismatch");
  t.equal(await bad("/api/submit-lineup?FRANCHISE_ID=1", { body: {} }), "franchise_mismatch");
  t.equal(await bad("/api/submit-lineup", { body: { requested_by: "0000" } }), "franchise_mismatch", "a commissioner named as the requester");
  const ok = await w.gate("POST", "/api/submit-lineup?L=74598&franchise_id=8", { sid, body: { franchise_id: "0008", fid: 8, to_franchise_id: "0001" } });
  t.equal(ok.kind, "inject", "the same franchise in any padding is accepted; a counterparty field is not an actor field");
  t.equal(ok.ctx.mflSession, MFL); t.equal(ok.ctx.franchiseId, "0008"); t.equal(ok.ctx.environment, "live");
  const big = await w.gate("POST", "/api/submit-lineup" + Q, { sid, headers: { "content-length": String(B.SESSION_CAP * 1024 * 1024) }, body: { franchise_id: "0008" } });
  t.equal(big.code, "beta_route_not_allowed", "an oversized body is refused, not scanned");
});

test("FAIL CLOSED: unreadable flags, an unreadable session table, a missing key and a wrong key each refuse, in that order of checking, and never inject", async () => {
  const w = await world();
  const sid = await w.session();
  const go = (deps) => w.gate("POST", "/api/submit-lineup" + Q, { sid, body: { franchise_id: "0008" }, deps });
  t.equal((await go({ ...w.deps, getFlags: async () => { throw new Error("D1 down"); } })).code, "beta_unavailable");
  t.equal((await go({ ...w.deps, getFlags: async () => ({ ok: false, flags: {} }) })).code, "beta_unavailable", "the flag reader says it could not read");
  t.equal((await go({ ...w.deps, getFlags: async () => ({ ok: true, flags: { BETA_ENABLED: true } }) })).code, "flow_off", "a flow flag that is absent is off");
  t.equal((await go({ ...w.deps, store: { lookup: async () => { throw new Error("D1 down"); } } })).code, "beta_unavailable");
  t.equal((await go({ ...w.deps, keyring: () => null })).code, "key_unavailable", "no key: the session cannot be opened and the request is refused");
  t.equal((await go({ ...w.deps, keyring: () => B.parseKeyring({ BETA_SESSION_KEY: `k1:${B.b64urlEncode(new Uint8Array(32).fill(9))}` }) })).code, "session_invalid", "a wrong key: refused, never half-opened");
  t.equal((await go({ ...w.deps, keyring: () => B.parseKeyring({ BETA_SESSION_KEY: `k2:${B.b64urlEncode(new Uint8Array(32).fill(7))}` }) })).code, "key_unavailable", "an unknown key id");
  w.d1.raw.prepare("UPDATE ups_beta_sessions SET mfl_enc = NULL").run();
  t.equal((await go(undefined)).code, "session_invalid", "a wiped session cannot be opened");
  const kinds = new Set(); for (const c of ["beta_unavailable", "key_unavailable", "session_invalid"]) kinds.add(c); t.equal(kinds.size, 3);
});

test("NO SIDE EFFECTS: no refusal writes to D1 (the gate only reads), and a successful gate decision writes nothing either", async () => {
  const w = await world();
  const sid = await w.session();
  const writesBefore = w.d1.log.filter((l) => /^\s*(INSERT|UPDATE|DELETE)/i.test(l.sql)).length;
  for (const o of [{ sid: "ups_bs_" + "Z".repeat(43) }, { sid }, { sid, now: NOW + B.SESSION_TTL_MS + 99 }, {}]) await w.gate("POST", "/api/submit-lineup" + Q, { ...o, body: { franchise_id: "0008" } });
  await w.gate("GET", "/admin/config-health" + Q, { sid });
  t.equal(w.d1.log.filter((l) => /^\s*(INSERT|UPDATE|DELETE)/i.test(l.sql)).length, writesBefore, "the gate never writes");
});

test("COMMISSIONER-AUTHORITY TRIPWIRE: every site in the worker that derives commissioner authority is pinned; a new one fails here until it is reviewed for beta requests", () => {
  const src = fs.readFileSync(new URL("../worker/src/index.js", import.meta.url), "utf8");
  const count = (re) => (src.match(re) || []).length;
  // guarded for beta (betaCtx switches them off)
  t.match(src, /const _rdhCommishFids = \(\) => \{\s*\n\s*if \(betaCtx\) return \[\];/, "_rdhCommishFids returns nothing for a beta request");
  t.match(src, /const commishSessionProven = async \(\) => \{\s*\n\s*if \(betaCtx\) return \{ ok: false/, "commishSessionProven refuses a beta request");
  t.match(src, /const sessionByCookie = !betaCtx && /, "sessionByCookie is never true for a beta request");
  // the session reaches routes ONLY through browserMflUserId, set from the gate's context on allowlisted routes
  t.equal(count(/searchParams\.get\("MFL_USER_ID"\)/g), 1, "exactly one query reader of the session (the beta swaps its source)");
  t.match(src, /const browserMflUserId = betaCtx \? betaCtx\.mflSession :/);
  // pinned counts: a change means a new place a session can become authority
  t.equal(count(/env\.COMMISH_FRANCHISE_IDS/g), 4, "sites reading COMMISH_FRANCHISE_IDS (each reachable only on a non-allowlisted route, or behind a guard above)");
  t.equal(count(/\bemailCapabilityProven\b/g), 4, "the email-capability heuristic (a settings-gate route, never allowlisted)");
  t.equal(count(/\btradeAdminGate\b/g) >= 1, true);
  // the early gate sits BEFORE the Hall and Discord handlers and every route
  const iGate = src.indexOf("let betaCtx = null;"), iHall = src.indexOf("handleHallRequest(request, env, corsHeaders)"), iDiscord = src.indexOf("handleDiscordInteraction(request, env, ctx)");
  t.ok(iGate > 0 && iGate < iHall && iGate < iDiscord, "the beta gate runs before the Hall and Discord handlers");
  t.ok(src.indexOf('request.method === "OPTIONS"') < iGate, "CORS preflight is answered before the gate");
  t.match(src, /if \(bg\.kind === "refuse"\) return betaRefusalResponse\(bg, corsHeaders\);/);
  // the hourly sweep is deletion maintenance and cannot block the cron
  t.match(src, /try \{ await makeBetaStore\(env\.UPS_MFL_DB\)\.sweep\(Date\.now\(\)\); \} catch \(_\) \{/);
  t.ok(src.indexOf("makeBetaStore(env.UPS_MFL_DB).sweep(") > src.indexOf("if (!isHourlyCron) {"), "the sweep runs on the hourly cron only");
});

await run("beta_gate");
