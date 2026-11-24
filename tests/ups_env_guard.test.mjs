// #1475 isolated test environment: the environment guard, the outbound guard, binding and
// credential checks, the write ledger, and production pass-through.
//
// Runs the REAL worker (worker/src/entry.js -> worker/src/index.js) under Node with the shared
// harness: D1 is node:sqlite, MFL/Discord/GitHub are stubs, anything else throws. No network.
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet } from "./fixtures/worker_harness.mjs";
import { makeD1, applyMigrations, THREE_WAY_MIGRATIONS } from "./fixtures/d1_sqlite.mjs";
import * as G from "../worker/src/ups_env_guard.js";
import { handleTestFetch, __resetTestRuntime, __egressEvents } from "../worker/src/test_env_runtime.js";
const entry = (await import("../worker/src/entry.js")).default;
const indexWorker = (await import("../worker/src/index.js")).default;

const TEST_LEAGUE = "25625";
const PROD = "74598";
const COMMISH_TOK = "tok-test-commish";   // the dedicated test account (commissioner of 25625 only)
const OWNER_TOK = "tok-test-owner";       // the dedicated test account acting as franchise 0012
const ADMIN = "test-admin-key-0123456789";
const WEBHOOK = "https://discord.com/api/webhooks/123456789012345678/abcDEF_ghi-JKL";
const SETUP_SQL = fs.readFileSync(new URL("../worker/test_env/ups_test_db_setup.sql", import.meta.url), "utf8");

function testDb({ marker = true, markerSql } = {}) {
  const db = makeD1({});
  applyMigrations(db, THREE_WAY_MIGRATIONS);
  db.raw.exec("CREATE TABLE IF NOT EXISTS discord_owners (franchise_id TEXT, active_owner TEXT, discord_user_id TEXT)");
  if (marker) db.raw.exec(markerSql || SETUP_SQL);
  return db;
}

// A test deployment's env: the harness env minus every production credential, plus test names.
function testEnv(over = {}) {
  const base = makeWorkerEnv({});
  for (const k of ["COMMISH_API_KEY", "MFL_COOKIE", "MFL_APIKEY", "DISCORD_BOT_TOKEN"]) delete base[k];
  const db = over.__db || testDb();
  const env = { ...base, UPS_MFL_DB: db, TWB_OUTBOX_DB: db,
    UPS_ENV: "test", LEAGUE_ID: TEST_LEAGUE, WRITE_LEAGUES: TEST_LEAGUE, YEAR: "2026",
    MFLTEST_COMMISHCOOKIE: COMMISH_TOK, TEST_ADMIN_API_KEY: ADMIN, TEST_DISCORD_CHANNEL_ID: "1089538054236160010",
    DISCORD_DROPS_CHANNEL_ID: "1059111651846131833", ...over };
  delete env.__db;
  return env;
}

function testMfl() {
  const mfl = makeMfl({ tokens: { [OWNER_TOK]: "0012" } });
  mfl.st.otherLeague[COMMISH_TOK] = { league: TEST_LEAGUE, fid: "0000" };
  mfl.st.otherLeague[OWNER_TOK] = { league: TEST_LEAGUE, fid: "0012" };
  mfl.st.rosters["0012"] = ["17517", "17558"];
  return mfl;
}

const ctx = () => { const waits = []; return { waits, waitUntil: (p) => waits.push(p), passThroughOnException() {} }; };
async function viaEntry(env, method, pathAndQuery, { body, headers } = {}) {
  const c = ctx();
  const h = { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(headers || {}) };
  const res = await entry.fetch(new Request("https://ups-test.example" + pathAndQuery, { method, headers: h, body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)) }), env, c);
  await Promise.allSettled(c.waits);
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (_) { json = null; }
  return { status: res.status, json, text, headers: res.headers };
}

// A stand-in for the worker (handleTestFetch takes the app as a parameter), used where the test needs
// precise control over what the "worker" sends: an MFL write, a Discord post, a GitHub dispatch.
function fakeApp(plan) {
  return { fetch: async (request, env) => {
    const out = [];
    for (const step of plan(request, env)) {
      const r = await fetch(step.url, step.init || {});
      out.push({ url: step.url, status: r.status, refused: r.headers && r.headers.get && r.headers.get("x-ups-egress") === "refused" });
    }
    return new Response(JSON.stringify({ ok: true, steps: out, league_seen: new URL(request.url).searchParams.get("L"), mfl_cookie_seen: env.MFL_COOKIE, discord_channel_seen: env.DISCORD_DROPS_CHANNEL_ID }), { headers: { "content-type": "application/json" } });
  } };
}
async function viaRuntime(env, app, method, pathAndQuery, { body, headers } = {}) {
  const c = ctx();
  const res = await handleTestFetch(new Request("https://ups-test.example" + pathAndQuery, { method, headers: { "Content-Type": "application/json", ...(headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), env, c, app);
  await Promise.allSettled(c.waits);
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (_) { json = null; }
  return { status: res.status, json, text, headers: res.headers };
}

function withMfl(fn) {
  return async () => {
    __resetTestRuntime();
    const mfl = testMfl(); mfl.install();
    const unq = quiet();
    try { await fn(mfl); } finally { unq(); mfl.restore(); __resetTestRuntime(); }
  };
}
const mflCalls = (mfl) => mfl.st.exports.length + mfl.st.imports.length;
const importsTo = (mfl, league) => mfl.st.imports.filter((i) => String(i.fields.L || "") === league);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 1. Environment resolution and configuration
// ─────────────────────────────────────────────────────────────────────────────────────────────
test("UPS_ENV must be exactly production or test; anything else is unknown", () => {
  t.equal(G.resolveUpsEnv({ UPS_ENV: "production" }), "production");
  t.equal(G.resolveUpsEnv({ UPS_ENV: "test" }), "test");
  for (const v of [undefined, "", "prod", "Production", "TEST", " test", "test ", "staging", "preview", 1, null]) t.equal(G.resolveUpsEnv({ UPS_ENV: v }), null, `UPS_ENV=${JSON.stringify(v)}`);
  t.equal(G.resolveUpsEnv(undefined), null);
});

test("test configuration: only one non-production league, no production credential names", () => {
  t.ok(G.testConfig(testEnv()).ok, "the reference test env is valid: " + G.testConfig(testEnv()).errors.join("; "));
  const bad = (over, re) => { const c = G.testConfig(testEnv(over)); t.ok(!c.ok, JSON.stringify(over)); t.ok(c.errors.some((e) => re.test(e)), `${JSON.stringify(over)} -> ${c.errors.join("; ")}`); };
  bad({ LEAGUE_ID: PROD, WRITE_LEAGUES: PROD }, /production league/);
  bad({ WRITE_LEAGUES: `${TEST_LEAGUE},${PROD}` }, /exactly one|production league/);
  bad({ WRITE_LEAGUES: "" }, /exactly one/);
  bad({ WRITE_LEAGUES: "11111" }, /disagree/);
  bad({ LEAGUE_ID: "" }, /LEAGUE_ID/);
  bad({ MFLTEST_COMMISHCOOKIE: "" }, /MFLTEST_COMMISHCOOKIE/);
  bad({ TEST_ADMIN_API_KEY: "" }, /TEST_ADMIN_API_KEY/);
  bad({ TEST_DISCORD_WEBHOOK_URL: "https://evil.example/hook" }, /webhook/);
  for (const name of G.FORBIDDEN_TEST_SECRETS) bad({ [name]: "x" }, new RegExp(`credential name present: ${name}$`));
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 2. Inbound requests: league 74598 refused everywhere, other leagues refused, client L ignored
// ─────────────────────────────────────────────────────────────────────────────────────────────
test("inbound: any mention of league 74598 is refused (query, path, JSON at any depth, form, multipart, encoded, lists)", () => {
  const cfg = G.testConfig(testEnv());
  const cases = [
    ["?L=74598", ""], ["?l=74598", ""], ["?league_id=74598", ""], ["?source=74598", ""], ["/api/x/74598/y", ""],
    ["?L=%37%34%35%39%38", ""], ["?L=25625%2C74598", ""],
    ["", JSON.stringify({ league_id: PROD })], ["", JSON.stringify({ payload: { deep: [{ leagueId: PROD }] } })],
    ["", JSON.stringify({ note: "see https://www48.myfantasyleague.com/2026/home/74598" })],
    ["", "L=74598&ADD=1"], ["", "ADD=1&league=74598"], ["", "--b\r\nContent-Disposition: form-data; name=\"L\"\r\n\r\n74598\r\n--b--"],
    ["?L=25625", JSON.stringify({ L: PROD })], ["?L=25625", JSON.stringify({ leagues: [TEST_LEAGUE, PROD] })],
  ];
  for (const [q, body] of cases) {
    const d = G.inboundDecision({ url: `https://x.test${q.startsWith("/") ? q : "/api/waivers/fcfs" + q}`, method: "POST", bodyText: body }, cfg);
    t.ok(!d.ok, `refused: ${q} ${body.slice(0, 60)}`);
    t.equal(d.error, "production_league_refused", `${q} ${body.slice(0, 40)}`);
  }
  t.equal(G.inboundDecision({ url: "https://x.test/api/x?ts=12745981", method: "GET", bodyText: "" }, cfg).ok, true, "a longer number containing the digits is not the league id");
});

test("inbound: other leagues and conflicting values are refused; the test league is pinned as L", () => {
  const cfg = G.testConfig(testEnv());
  const refused = (url, body, err) => { const d = G.inboundDecision({ url, method: "POST", bodyText: body }, cfg); t.ok(!d.ok, url + body); t.equal(d.error, err, url + body); };
  refused("https://x.test/api/a?L=99999", "", "league_not_allowlisted");
  refused("https://x.test/api/a?L=25625", JSON.stringify({ league_id: "99999" }), "conflicting_league_values");
  refused("https://x.test/api/a", "league_id=11111&L=25625", "conflicting_league_values");
  for (const [url, body] of [["https://x.test/api/a", ""], ["https://x.test/api/a?L=25625", ""], ["https://x.test/api/a?league_id=25625&x=1", JSON.stringify({ L: "25625" })]]) {
    const d = G.inboundDecision({ url, method: "POST", bodyText: body }, cfg);
    t.ok(d.ok, url);
    const u = new URL(d.url);
    t.equal(u.searchParams.get("L"), TEST_LEAGUE, `L pinned for ${url}`);
    t.equal(u.searchParams.getAll("L").length, 1);
    t.equal(u.searchParams.get("league_id"), null, "other league keys removed from the query");
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 3. Outbound calls
// ─────────────────────────────────────────────────────────────────────────────────────────────
test("outbound: MFL only for the test league; Discord only the test webhook; no GitHub/AI/other writes; no workers.dev", () => {
  const cfg = G.testConfig(testEnv({ TEST_DISCORD_WEBHOOK_URL: WEBHOOK }));
  const d = (url, method, bodyText) => G.egressDecision({ url, method, bodyText: bodyText === undefined ? "" : bodyText }, cfg);
  const allow = (x, kind, msg) => { t.ok(x.allow, msg + " " + JSON.stringify(x)); if (kind) t.equal(x.kind, kind, msg); };
  const refuse = (x, reason, msg) => { t.ok(!x.allow, msg); t.equal(x.reason, reason, msg); };
  allow(d("https://www48.myfantasyleague.com/2026/import?TYPE=fcfsWaiver&L=25625&JSON=1", "POST", "ADD=17222&DROP=17517"), "mfl_write", "test-league import");
  allow(d("https://api.myfantasyleague.com/2026/export?TYPE=rosters&L=25625&JSON=1", "GET"), "mfl_read", "test-league read");
  allow(d("https://api.myfantasyleague.com/2026/export?TYPE=players&JSON=1", "GET"), "mfl_read", "league-free read");
  refuse(d("https://www48.myfantasyleague.com/2026/import?TYPE=fcfsWaiver&L=74598&JSON=1", "POST", "ADD=1"), "production_league_named", "prod import by query");
  refuse(d("https://www48.myfantasyleague.com/2026/import?TYPE=fcfsWaiver&JSON=1", "POST", "L=74598&ADD=1"), "production_league_named", "prod import by form field");
  refuse(d("https://www48.myfantasyleague.com/2026/import?TYPE=salaries&L=25625", "POST", "DATA=<x league='74598'/>"), "production_league_named", "prod id inside a payload");
  refuse(d("https://api.myfantasyleague.com/2026/export?TYPE=rosters&L=74598&JSON=1", "GET"), "production_league_named", "prod read");
  refuse(d("https://www48.myfantasyleague.com/2026/home/74598", "GET"), "production_league_named", "prod page");
  refuse(d("https://www48.myfantasyleague.com/2026/import?TYPE=lineup&JSON=1", "POST", "STARTERS=1"), "mfl_write_without_league", "import naming no league");
  refuse(d("https://www48.myfantasyleague.com/2026/import?TYPE=lineup&L=11111", "POST", "STARTERS=1"), "mfl_league_not_allowlisted", "another league");
  t.ok(d("https://www48.myfantasyleague.com/2026/import?TYPE=lineup&L=25625", "GET").allow, "GET import with the test league is a test-league write");
  refuse(G.egressDecision({ url: "https://www48.myfantasyleague.com/2026/import?TYPE=lineup&L=25625", method: "POST", bodyText: null }, cfg), "mfl_write_body_not_inspectable", "streamed body");
  refuse(d("https://discord.com/api/v10/channels/1059111651846131833/messages", "POST", "{}"), "discord_refused", "bot API to a prod channel");
  refuse(d("https://discord.com/api/v10/channels/1089538054236160010/messages", "POST", "{}"), "discord_refused", "bot API even to the test channel (no bot token in test)");
  refuse(d("https://discord.com/api/v10/users/@me/channels", "POST", "{}"), "discord_refused", "DMs");
  refuse(d(WEBHOOK + "x", "POST", "{}"), "discord_refused", "a different webhook");
  allow(d(WEBHOOK, "POST", "{}"), "test_webhook", "the configured test webhook");
  refuse(d("https://api.github.com/repos/keithcreelman/upsmflproduction/dispatches", "POST", "{}"), "write_to_unlisted_host", "repository_dispatch");
  refuse(d("https://api.github.com/repos/keithcreelman/upsmflproduction/contents/site/x.json", "PUT", "{}"), "write_to_unlisted_host", "contents API");
  refuse(d("https://api.anthropic.com/v1/messages", "POST", "{}"), "write_to_unlisted_host", "AI");
  refuse(d("https://upsmflproduction.keith-creelman.workers.dev/api/x", "GET"), "worker_or_pages_host_refused", "the production worker");
  refuse(d("https://preview.ups-mobile-beta.pages.dev/env.json", "GET"), "worker_or_pages_host_refused", "pages");
  refuse(d("https://keithcreelman.github.io/upsmflproduction/site/trades/trade_offers_74598_2026.json", "GET"), "production_league_named", "a production data file");
  allow(d("https://api.sleeper.app/v1/players/nfl", "GET"), "read", "a public read");
  t.ok(!G.redactUrl("https://api.myfantasyleague.com/2026/export?TYPE=x&APIKEY=secret&MFL_USER_ID=abc").includes("secret"), "credentials are redacted from logged URLs");
  t.ok(!G.redactUrl(WEBHOOK).includes("abcDEF"), "the webhook token is redacted");
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 4. Bindings, database marker, derived env, cache namespace
// ─────────────────────────────────────────────────────────────────────────────────────────────
test("bindings: only D1 and the static asset binding; R2, KV, queues, Durable Objects and service bindings refused", () => {
  const d1 = testDb();
  t.ok(G.inspectBindings({ UPS_MFL_DB: d1, FPA_STORE: { fetch() {} }, X: "1" }).ok);
  const r2 = { put() {}, get() {}, list() {}, head() {}, delete() {}, createMultipartUpload() {} };
  for (const [name, v, kind] of [["UPS_MFL_BACKUPS", r2, "r2"], ["KV", { get() {}, put() {}, list() {}, getWithMetadata() {} }, "kv"], ["Q", { send() {}, sendBatch() {} }, "queue"],
    ["DO", { idFromName() {} }, "durable_object"], ["SELF", { fetch() {} }, "fetcher"], ["AE", { writeDataPoint() {} }, "analytics"]]) {
    const r = G.inspectBindings({ UPS_MFL_DB: d1, [name]: v });
    t.ok(!r.ok, name); t.equal(r.bindings[name], kind, name);
  }
  t.ok(!G.inspectBindings({ X: "1" }).ok, "no D1 at all is refused");
});

test("database marker: every D1 binding must be the test database for this league", () => {
  t.ok(G.markerVerdict([{ env: "test", league_id: TEST_LEAGUE }], TEST_LEAGUE).ok);
  t.equal(G.markerVerdict([], TEST_LEAGUE).reason, "marker_missing");
  t.equal(G.markerVerdict([{ env: "production", league_id: TEST_LEAGUE }], TEST_LEAGUE).reason, "marker_not_test");
  t.equal(G.markerVerdict([{ env: "test", league_id: "11111" }], TEST_LEAGUE).reason, "marker_league_mismatch");
  t.equal(G.markerVerdict([{ env: "test", league_id: TEST_LEAGUE }, { env: "x", league_id: TEST_LEAGUE }], TEST_LEAGUE).reason, "marker_not_test");
  t.throws(() => testDb({ markerSql: "CREATE TABLE ups_env_marker (env TEXT NOT NULL CHECK (env = 'test'), league_id TEXT NOT NULL CHECK (league_id <> '74598'), created_at TEXT NOT NULL, note TEXT); INSERT INTO ups_env_marker VALUES ('test','74598','x',null);" }), /CHECK/, "the setup table itself rejects the production league id");
  const migs = fs.readdirSync(new URL("../worker/migrations/", import.meta.url)).filter((f) => f.endsWith(".sql"));
  t.ok(migs.length > 100, "migrations found");
  for (const f of migs) t.doesNotMatch(fs.readFileSync(new URL(`../worker/migrations/${f}`, import.meta.url), "utf8"), /ups_env_marker/, `${f} never creates the marker (so production D1 can't carry it)`);
});

test("derived env: test secrets under the names the code reads, production credentials empty, every channel the test channel", () => {
  const env = testEnv({ TEST_DISCORD_WEBHOOK_URL: WEBHOOK });
  const out = G.deriveTestEnv(env, G.testConfig(env));
  t.equal(out.MFL_COOKIE, COMMISH_TOK); t.equal(out.COMMISH_API_KEY, ADMIN); t.equal(out.MFL_APIKEY, "");
  for (const k of ["GITHUB_PAT", "DISCORD_BOT_TOKEN", "DISCORD_CONTRACT_BOT_TOKEN", "ANTHROPIC_API_KEY", "TEST_SYNC_API_KEY"]) t.equal(out[k], "", k);
  for (const k of Object.keys(out).filter((x) => /CHANNEL_ID$/.test(x))) t.equal(out[k], "1089538054236160010", k);
  t.equal(out.LEAGUE_ID, TEST_LEAGUE); t.equal(out.UPS_LEAGUE_ID, TEST_LEAGUE);
  t.equal(out.DROP_TRACKER_DISCORD_TARGET, "test"); t.equal(out.DISCORD_CONTRACT_USE_TEST, "1");
});

test("cache namespace: every caches.default key a test deployment uses moves under its own host prefix", withMfl(async () => {
  const seen = [];
  const fakeCache = { match: async (k) => { seen.push(["match", String(k.url || k)]); return undefined; }, put: async (k) => { seen.push(["put", String(k.url || k)]); }, delete: async (k) => { seen.push(["delete", String(k.url || k)]); return true; } };
  const had = Object.getOwnPropertyDescriptor(globalThis, "caches");
  globalThis.caches = { default: fakeCache };
  try {
    const r = await viaEntry(testEnv(), "GET", "/__test-env/status");
    t.equal(r.status, 200, r.text);
    t.equal(r.json.cache_namespace, `ups-test-${TEST_LEAGUE}`);
    await caches.default.put("https://upsmfl-stats.local/api/player-epa?seasons=2026", new Response("x"));
    await caches.default.match(new Request("https://upsmfl-adv-stats.local/cache?x=1"));
    await caches.default.delete("https://ups.internal/k");
    t.deepEqual(seen.map((x) => x[1]), [
      "https://ups-test-25625.upsmfl-stats.local/api/player-epa?seasons=2026",
      "https://ups-test-25625.upsmfl-adv-stats.local/cache?x=1",
      "https://ups-test-25625.ups.internal/k",
    ]);
  } finally { if (had) Object.defineProperty(globalThis, "caches", had); else delete globalThis.caches; }
}));

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 5. The entry point: production unchanged, unknown environment refuses everything
// ─────────────────────────────────────────────────────────────────────────────────────────────
test("missing or unknown UPS_ENV: every request refused, no scheduled job runs, the worker code is never reached", async () => {
  const mfl = testMfl(); mfl.install();
  const unq = quiet();
  try {
    for (const v of [undefined, "", "prod", "TEST"]) {
      const env = makeWorkerEnv({ UPS_ENV: v });
      for (const [m, p] of [["GET", "/api/health"], ["POST", "/api/waivers/fcfs?L=74598"], ["GET", "/admin/test-sync/prod-rosters"], ["POST", "/commish-contract-update"]]) {
        const r = await viaEntry(env, m, p, m === "POST" ? { body: {} } : {});
        t.equal(r.status, 503, `${v} ${m} ${p}`); t.equal(r.json.error, "ups_env_unconfigured");
      }
      const reads = [];
      const spyEnv = new Proxy(env, { get(o, k) { reads.push(String(k)); return o[k]; } });
      await entry.scheduled({ cron: "*/5 * * * *", scheduledTime: Date.now() }, spyEnv, ctx());
      t.deepEqual([...new Set(reads)], ["UPS_ENV"], "a refused scheduled run reads nothing but UPS_ENV");
    }
    t.equal(mflCalls(mfl), 0, "no MFL call at all");
    t.equal(mfl.st.discord.length, 0, "no Discord call");
  } finally { unq(); mfl.restore(); }
});

test("UPS_ENV=production: entry.js hands the same request, env and ctx to index.js and installs nothing", async () => {
  const src = fs.readFileSync(new URL("../worker/src/entry.js", import.meta.url), "utf8");
  t.match(src, /if \(mode === "production"\) return app\.fetch\(request, env, ctx\);/);
  t.match(src, /if \(mode === "production"\) return app\.scheduled\(event, env, ctx\);/);
  const mfl = testMfl(); mfl.install();
  const before = globalThis.fetch;
  const unq = quiet();
  try {
    const env = makeWorkerEnv({ UPS_ENV: "production" });
    for (const [m, p] of [["GET", "/api/does-not-exist?L=74598"], ["GET", "/admin/test-sync/prod-rosters?L=74598"], ["POST", "/api/waivers/fcfs?L=74598"]]) {
      const a = await viaEntry(env, m, p, m === "POST" ? { body: { dry_run: true } } : {});
      const c = ctx();
      const bRes = await indexWorker.fetch(new Request("https://ups-test.example" + p, { method: m, headers: m === "POST" ? { "Content-Type": "application/json" } : {}, body: m === "POST" ? JSON.stringify({ dry_run: true }) : undefined }), env, c);
      await Promise.allSettled(c.waits);
      const bText = await bRes.text();
      t.equal(a.status, bRes.status, `${m} ${p} status matches index.js`);
      t.equal(a.text, bText, `${m} ${p} body matches index.js`);
      t.equal(a.headers.get("x-ups-env"), null, "no test stamp in production");
    }
    t.equal(globalThis.fetch, before, "production never wraps fetch");
  } finally { unq(); mfl.restore(); }
  const toml = fs.readFileSync(new URL("../worker/wrangler.toml", import.meta.url), "utf8");
  t.equal([...toml.matchAll(/^UPS_ENV\s*=\s*"production"\s*$/gm)].length, 1, "wrangler.toml pins UPS_ENV = \"production\" exactly once");
  t.match(toml, /^main = "src\/entry\.js"/m, "production deploys through entry.js");
});

test("wrangler.test.toml: no jobs, no service/R2 bindings, both D1 names on the test database, no production ids or secrets", () => {
  const toml = fs.readFileSync(new URL("../worker/wrangler.test.toml", import.meta.url), "utf8");
  const code = toml.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  t.match(code, /^name = "ups-test"$/m);
  t.match(code, /^main = "src\/entry\.js"$/m);
  t.match(code, /^UPS_ENV = "test"$/m);
  t.match(code, /^LEAGUE_ID = "25625"$/m);
  t.match(code, /^WRITE_LEAGUES = "25625"$/m);
  t.match(code, /^\[triggers\]\ncrons = \[\]$/m, "an explicitly empty cron list");
  t.doesNotMatch(code, /\[\[services\]\]|\[\[r2_buckets\]\]|\[\[kv_namespaces\]\]|\[\[queues|\[\[durable_objects|analytics_engine/, "no service, R2, KV, queue, DO or analytics binding");
  t.doesNotMatch(code, /8cfe1ddd-749e-476a-9c2c-a359410c6fc1|ups-mfl-db|ups-mfl-backups|"upsmflproduction"/, "no production database, bucket or worker");
  t.doesNotMatch(code, /74598/, "the production league id appears nowhere");
  t.equal([...code.matchAll(/database_name = "ups-test-db"/g)].length, 2, "UPS_MFL_DB and TWB_OUTBOX_DB both on ups-test-db");
  t.match(code, /binding = "UPS_MFL_DB"/); t.match(code, /binding = "TWB_OUTBOX_DB"/);
  for (const name of G.FORBIDDEN_TEST_SECRETS) t.doesNotMatch(code, new RegExp(`^${name}\\s*=`, "m"), `${name} not set as a var`);
  for (const flag of [...code.matchAll(/^([A-Z0-9_]+_ENABLED|[A-Z0-9_]+_EXECUTE|[A-Z0-9_]+_AUTO_POST|[A-Z0-9_]+_POST_MFL|OTB_LIVE_MODE|RULE_PROPOSALS_LIVE) = "(.*)"$/gm)]) t.equal(flag[2], "0", `${flag[1]} off`);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 6. The test deployment end to end (real worker routes)
// ─────────────────────────────────────────────────────────────────────────────────────────────
test("test deployment refuses to start with a production credential, an R2 or SELF binding, or an unmarked database", withMfl(async (mfl) => {
  for (const [over, err] of [
    [{ MFL_COOKIE: "COMMISH-COOKIE-SECRET" }, "test_env_misconfigured"], [{ GITHUB_PAT: "ghp_x" }, "test_env_misconfigured"], [{ COMMISH_API_KEY: "k" }, "test_env_misconfigured"],
    [{ UPS_MFL_BACKUPS: { put() {}, get() {}, list() {}, head() {}, delete() {}, createMultipartUpload() {} } }, "test_env_bindings_refused"],
    [{ SELF: { fetch() {} } }, "test_env_bindings_refused"],
    [{ __db: testDb({ marker: false }) }, "test_database_unverified"],
    [{ DB: testDb({ marker: false }) }, "test_database_unverified"],
    [{ __db: testDb({ markerSql: SETUP_SQL.replace(/'25625'/g, "'11111'") }) }, "test_database_unverified"],
    [{ __db: testDb({ markerSql: SETUP_SQL.replace(/INSERT INTO ups_env_marker[\s\S]*?FROM ups_env_marker\);/, "") }) }, "test_database_unverified"],
  ]) {
    __resetTestRuntime();
    const r = await viaEntry(testEnv(over), "GET", "/api/does-not-exist");
    t.equal(r.status, 503, JSON.stringify(Object.keys(over)));
    t.equal(r.json.error, err, JSON.stringify(Object.keys(over)) + " " + r.text);
    t.ok(!/COMMISH-COOKIE-SECRET|ghp_x/.test(r.text), "the refusal never echoes a secret value");
  }
  t.equal(mflCalls(mfl), 0, "refused before any MFL call");
}));

test("FCFS add/drop (real route, dry run): no L from the client still targets 25625; 74598 anywhere is refused before any MFL call", withMfl(async (mfl) => {
  const env = testEnv();
  const owner = { Cookie: `MFL_USER_ID=${OWNER_TOK}`, "Idempotency-Key": "fcfs-dry-0001" };
  const ok = await viaEntry(env, "POST", "/api/waivers/fcfs", { body: { dry_run: true, add_pid: "17222", drop_pids: ["17517"] }, headers: owner });
  t.equal(ok.status, 200, ok.text);
  t.equal(ok.headers.get("x-ups-env"), "test"); t.equal(ok.headers.get("x-ups-league"), TEST_LEAGUE);
  t.equal(ok.json.dry_run, true); t.equal(ok.json.franchise_id, "0012");
  t.match(ok.json.would_send.url, /[?&]L=25625(&|$)/, "the route's own MFL target is the test league");
  t.doesNotMatch(ok.json.would_send.url, /74598/);
  t.ok(mfl.st.exports.every((e) => !JSON.stringify(e.params).includes(PROD)), "every MFL read named the test league or none");
  t.equal(mfl.st.imports.length, 0, "a dry run writes nothing");
  const callsBefore = mflCalls(mfl);
  for (const [path, body, err] of [
    ["/api/waivers/fcfs?L=74598", { dry_run: true, add_pid: "17222" }, "production_league_refused"],
    ["/api/waivers/fcfs", { dry_run: true, add_pid: "17222", league_id: PROD }, "production_league_refused"],
    ["/api/waivers/fcfs?L=25625", { dry_run: true, add_pid: "17222", L: PROD }, "production_league_refused"],
    ["/api/waivers/fcfs?L=25625", { dry_run: true, add_pid: "17222", league_id: "99999" }, "conflicting_league_values"],
    ["/commish-contract-update", { L: PROD, player_id: "1" }, "production_league_refused"],
    ["/api/trades/proposals", { league_id: PROD }, "production_league_refused"],
    ["/admin/test-sync/prod-rosters?source=74598", {}, "production_league_refused"],
  ]) {
    const r = await viaEntry(env, "POST", path, { body, headers: owner });
    t.equal(r.status, 403, `${path} ${JSON.stringify(body)} -> ${r.text}`);
    t.equal(r.json.error, err, path);
  }
  t.equal(mflCalls(mfl), callsBefore, "refused requests made no MFL call");
}));

test("credentials: a forwarded session that belongs to league 74598 (a real owner's) is refused; so is a commissioner session that does", withMfl(async (mfl) => {
  const env = testEnv();
  const r = await viaEntry(env, "POST", "/api/waivers/fcfs", { body: { dry_run: true, add_pid: "17222" }, headers: { Cookie: "MFL_USER_ID=tok-A", "Idempotency-Key": "cred-0001" } });
  t.equal(r.status, 403, r.text); t.equal(r.json.error, "credential_is_production_member");
  t.equal(mfl.st.exports.filter((e) => e.type !== "myleagues").length, 0, "only the myleagues check ran; the route never did");
  __resetTestRuntime();
  const r2 = await viaEntry(testEnv({ MFLTEST_COMMISHCOOKIE: "tok-commish" }), "POST", "/api/waivers/fcfs", { body: { dry_run: true, add_pid: "17222" }, headers: { Cookie: `MFL_USER_ID=${OWNER_TOK}`, "Idempotency-Key": "cred-0002" } });
  t.equal(r2.status, 503, r2.text); t.equal(r2.json.error, "commissioner_credential_is_production_member");
  __resetTestRuntime();
  mfl.st.otherLeague["tok-elsewhere"] = { league: "99999", fid: "0001" };
  const r3 = await viaEntry(env, "POST", "/api/waivers/fcfs", { body: { dry_run: true, add_pid: "17222" }, headers: { Cookie: "MFL_USER_ID=tok-elsewhere", "Idempotency-Key": "cred-0003" } });
  t.equal(r3.status, 403); t.equal(r3.json.error, "credential_not_in_test_league");
  t.equal(mfl.st.imports.length, 0);
}));

test("no scheduled job runs in a test deployment; Discord interactions are refused", withMfl(async (mfl) => {
  const env = testEnv();
  const reads = [];
  const spyEnv = new Proxy(env, { get(o, k) { reads.push(String(k)); return o[k]; } });
  await entry.scheduled({ cron: "*/5 * * * *", scheduledTime: Date.now() }, spyEnv, ctx());
  t.ok(reads.every((k) => k === "UPS_ENV" || k === "LEAGUE_ID"), "the scheduled path reads only UPS_ENV and LEAGUE_ID: " + [...new Set(reads)].join(","));
  t.equal(mflCalls(mfl), 0);
  const r = await viaEntry(env, "POST", "/discord/interactions", { body: { type: 1 } });
  t.equal(r.status, 403); t.equal(r.json.error, "discord_interactions_disabled_in_test");
}));

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 7. The write ledger: idempotency, uncertain outcomes, refused side effects
// ─────────────────────────────────────────────────────────────────────────────────────────────
const IMPORT = { url: "https://www48.myfantasyleague.com/2026/import?TYPE=fcfsWaiver&L=25625&JSON=1", init: { method: "POST", body: "ADD=17222&DROP=17517" } };

test("ledger: a write needs an Idempotency-Key; a repeat replays the first answer and never writes MFL twice", withMfl(async (mfl) => {
  const env = testEnv();
  const app = fakeApp(() => [IMPORT]);
  const noKey = await viaRuntime(env, app, "POST", "/api/waivers/fcfs", { body: { add_pid: "17222" } });
  t.equal(noKey.status, 428); t.equal(mfl.st.imports.length, 0);
  const h = { "Idempotency-Key": "adddrop-2026-11-29-0012" };
  const a = await viaRuntime(env, app, "POST", "/api/waivers/fcfs", { body: { add_pid: "17222" }, headers: h });
  t.equal(a.status, 200, a.text); t.equal(a.headers.get("x-ups-ledger-state"), "responded");
  t.equal(a.json.league_seen, TEST_LEAGUE); t.equal(a.json.mfl_cookie_seen, COMMISH_TOK, "the code sees the TEST commissioner session");
  t.equal(importsTo(mfl, TEST_LEAGUE).length, 1);
  const b = await viaRuntime(env, app, "POST", "/api/waivers/fcfs", { body: { add_pid: "17222" }, headers: h });
  t.equal(b.status, 200); t.equal(b.headers.get("x-ups-idempotent-replay"), "1"); t.equal(b.text, a.text, "the replay is the first answer");
  t.equal(importsTo(mfl, TEST_LEAGUE).length, 1, "MFL written exactly once");
  const c = await viaRuntime(env, app, "POST", "/api/waivers/fcfs", { body: { add_pid: "99999" }, headers: h });
  t.equal(c.status, 422); t.equal(c.json.error, "idempotency_key_reused_with_different_request");
  const row = env.UPS_MFL_DB.raw.prepare("SELECT env, league_id, state, http_status, egress_json FROM ups_test_write_ledger WHERE idempotency_key = ?").get(h["Idempotency-Key"]);
  t.equal(row.env, "test"); t.equal(row.league_id, TEST_LEAGUE); t.equal(row.state, "responded"); t.equal(row.http_status, 200);
  t.match(row.egress_json, /fcfsWaiver/); t.doesNotMatch(row.egress_json, /tok-test/, "no credential in the ledger");
}));

test("ledger: a lost MFL answer is 'uncertain'; the same key is blocked until MFL is read and the outcome resolved", withMfl(async (mfl) => {
  const env = testEnv();
  const inner = globalThis.fetch;
  globalThis.fetch = async (u, i) => { if (/\/import/.test(String(u))) { mfl.st.imports.push({ type: "fcfsWaiver", fields: { L: TEST_LEAGUE } }); throw new Error("network reset (response lost)"); } return inner(u, i); };
  const app = fakeApp(() => [IMPORT]);
  const h = { "Idempotency-Key": "adddrop-lost-0001" };
  let r;
  try { r = await viaRuntime(env, app, "POST", "/api/waivers/fcfs", { body: { add_pid: "17222" }, headers: h }); }
  finally { globalThis.fetch.__upsInner = inner; }
  t.equal(r.status, 502, r.text); t.equal(r.json.error, "outcome_unknown_check_mfl"); t.equal(r.json.ledger_state, "uncertain");
  const again = await viaRuntime(env, app, "POST", "/api/waivers/fcfs", { body: { add_pid: "17222" }, headers: h });
  t.equal(again.status, 409); t.equal(again.json.ledger_state, "uncertain"); t.match(again.json.next_step, /read league 25625's MFL transactions/);
  t.equal(mfl.st.imports.length, 1, "no blind retry");
  const noAuth = await viaRuntime(env, app, "POST", "/__test-env/ledger/resolve", { body: { idempotency_key: h["Idempotency-Key"], outcome: "applied", evidence: "x" } });
  t.equal(noAuth.status, 403);
  const res = await viaRuntime(env, app, "POST", "/__test-env/ledger/resolve", { body: { idempotency_key: h["Idempotency-Key"], outcome: "applied", evidence: "25625 transactions: FREE_AGENT 0012 17222,|17517, at 2026-11-29T14:05Z" }, headers: { "x-ups-test-admin-key": ADMIN } });
  t.equal(res.status, 200, res.text); t.equal(res.json.state, "resolved_applied");
  const after = await viaRuntime(env, app, "POST", "/api/waivers/fcfs", { body: { add_pid: "17222" }, headers: h });
  t.equal(after.status, 409); t.equal(after.json.ledger_state, "resolved_applied");
  t.equal(mfl.st.imports.length, 1, "still exactly one MFL write");
}));

test("ledger: an MFL 5xx on a write is 'uncertain' even when the worker code returns normally", withMfl(async (mfl) => {
  const env = testEnv();
  mfl.st.failNext = { type: "fcfsWaiver", status: 504, message: "gateway timeout" };
  const r = await viaRuntime(env, fakeApp(() => [IMPORT]), "POST", "/api/waivers/fcfs", { body: { add_pid: "17222" }, headers: { "Idempotency-Key": "adddrop-504-0001" } });
  t.equal(r.headers.get("x-ups-ledger-state"), "uncertain", r.text);
  const again = await viaRuntime(env, fakeApp(() => [IMPORT]), "POST", "/api/waivers/fcfs", { body: { add_pid: "17222" }, headers: { "Idempotency-Key": "adddrop-504-0001" } });
  t.equal(again.status, 409); t.equal(again.json.ledger_state, "uncertain");
  t.equal(mfl.st.imports.length, 1, "the retry never reached MFL");
  const row = env.UPS_MFL_DB.raw.prepare("SELECT state FROM ups_test_write_ledger WHERE idempotency_key = 'adddrop-504-0001'").get();
  t.equal(row.state, "uncertain");
}));

test("side effects from inside a write: Discord, GitHub, AI, the production worker and a production import are refused and logged in the TEST database", withMfl(async (mfl) => {
  const env = testEnv();
  const app = fakeApp(() => [
    { url: "https://discord.com/api/v10/channels/1059111651846131833/messages", init: { method: "POST", body: "{\"content\":\"drop\"}" } },
    { url: "https://api.github.com/repos/keithcreelman/upsmflproduction/dispatches", init: { method: "POST", body: "{\"event_type\":\"log-contract-activity\"}" } },
    { url: "https://api.anthropic.com/v1/messages", init: { method: "POST", body: "{}" } },
    { url: "https://upsmflproduction.keith-creelman.workers.dev/commish-contract-update", init: { method: "POST", body: "{}" } },
    { url: "https://www48.myfantasyleague.com/2026/import?TYPE=salaries&JSON=1", init: { method: "POST", body: "L=74598&DATA=x" } },
  ]);
  const r = await viaRuntime(env, app, "POST", "/api/x", { body: {}, headers: { "Idempotency-Key": "sidefx-0001" } });
  t.equal(r.status, 200, r.text);
  t.ok(r.json.steps.every((s) => s.refused && s.status === 403), JSON.stringify(r.json.steps));
  t.equal(r.json.discord_channel_seen, "1089538054236160010", "the code sees the test channel id for every channel");
  t.equal(mfl.st.discord.length, 0, "nothing reached Discord"); t.equal(mfl.st.imports.length, 0, "nothing reached MFL");
  const rows = env.UPS_MFL_DB.raw.prepare("SELECT env, decision, reason, host, url_redacted FROM ups_test_egress_log WHERE idempotency_key = ? ORDER BY id").all("sidefx-0001");
  t.deepEqual(rows.map((x) => x.reason), ["discord_refused", "write_to_unlisted_host", "write_to_unlisted_host", "worker_or_pages_host_refused", "production_league_named"]);
  t.ok(rows.every((x) => x.env === "test" && x.decision === "refuse"));
}));

test("the test webhook is the only Discord URL that passes", withMfl(async (mfl) => {
  const env = testEnv({ TEST_DISCORD_WEBHOOK_URL: WEBHOOK });
  const app = fakeApp(() => [{ url: WEBHOOK, init: { method: "POST", body: "{\"content\":\"[TEST 25625] add/drop confirmed\"}" } }, { url: WEBHOOK + "?wait=true", init: { method: "POST", body: "{}" } }]);
  const r = await viaRuntime(env, app, "POST", "/api/x", { body: {}, headers: { "Idempotency-Key": "webhook-0001" } });
  t.equal(r.json.steps[0].refused, false); t.equal(r.json.steps[1].refused, false, "query string on the same webhook is allowed");
  t.equal(mfl.st.discord.length, 2);
  t.ok(mfl.st.discord.every((d) => d.url === "/api/webhooks/123456789012345678/abcDEF_ghi-JKL"));
}));

test("status and verify: status shows configuration and never a secret; verify needs the admin key and proves the outbound refusals", withMfl(async () => {
  const env = testEnv({ TEST_DISCORD_WEBHOOK_URL: WEBHOOK });
  const s = await viaEntry(env, "GET", "/__test-env/status");
  t.equal(s.status, 200); t.equal(s.json.league, TEST_LEAGUE); t.equal(s.json.database_marker, "ok"); t.equal(s.json.egress_guard, true);
  for (const secret of [COMMISH_TOK, ADMIN, "abcDEF_ghi-JKL"]) t.ok(!s.text.includes(secret), "status never shows a secret value");
  const noKey = await viaEntry(env, "GET", "/__test-env/verify");
  t.equal(noKey.status, 403);
  const v = await viaEntry(env, "GET", "/__test-env/verify", { headers: { "x-ups-test-admin-key": ADMIN } });
  t.equal(v.status, 200, v.text); t.equal(v.json.ok, true, v.text);
  t.ok(v.json.egress_probes.length >= 5 && v.json.egress_probes.every((p) => p.refused), JSON.stringify(v.json.egress_probes));
  t.equal(v.json.commissioner_session.ok, true);
  for (const secret of [COMMISH_TOK, ADMIN, "abcDEF_ghi-JKL"]) t.ok(!v.text.includes(secret), "verify never shows a secret value");
}));

await run("ups_env_guard");
