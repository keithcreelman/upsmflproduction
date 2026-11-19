// Owner bug reports (private D1, behind BUG_REPORT_ENABLED) -- the REAL worker under Node,
// real SQLite (the real migration), a stubbed MFL at the network edge.   node tests/bug_reports.test.mjs
//
// What this proves, in the order a reviewer would ask:
//   flag off -> nothing runs; identity -> a signed-in owner only, every failed-sign-in state is
//   explained; fields -> an allowlist; redaction -> secrets never reach the database; duplicates ->
//   a retry or the same problem never makes a second row; rate limit -> per team, with a
//   retry-after; privacy -> an owner sees only their own, only the commissioner sees all;
//   outbound calls -> exactly one MFL identity read per request, nothing to Discord or GitHub;
//   D1 -> every query uses an index.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet, ADMIN_KEY } from "./fixtures/worker_harness.mjs";
import { THREE_WAY_MIGRATIONS } from "./fixtures/d1_sqlite.mjs";
import { handleBugReportRequest, makeMemoryStore } from "../worker/src/bug_reports.js";

const restoreConsole = quiet();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The migration number is provisional (renumbered at merge), so find it by name.
const MIGRATION = fs.readdirSync(path.join(ROOT, "worker", "migrations")).filter((f) => /^\d{4}_bug_reports\.sql$/.test(f));
if (MIGRATION.length !== 1) throw new Error("expected exactly one *_bug_reports.sql migration, found " + MIGRATION.length);

const Q = "?L=74598&YEAR=2026";
const OWNER_A = "tok-C";      // franchise 0002
const OWNER_B = "tok-O";      // franchise 0003
const COMMISH = "tok-A";      // franchise 0008 (commissioner)
let rid = 0;
const newId = () => "req-" + String(++rid).padStart(6, "0");

function fresh(over) {
  const env = makeWorkerEnv({ BUG_REPORT_ENABLED: "1", __migrations: [...THREE_WAY_MIGRATIONS, MIGRATION[0]], ...(over && over.env) });
  const mfl = makeMfl(over && over.mfl);
  mfl.install();
  return { env, mfl, db: env.UPS_MFL_DB };
}
const report = (over) => ({
  client_request_id: newId(), mfl_user_id: OWNER_A,
  summary: "Waiver window won't load", note: "I tapped Market, then Bids.",
  screen: "Market › Find players", build: "2026.11.19.1", client_time: "2026-11-19T15:00:00Z",
  viewport: { w: 375, h: 812 }, online: true,
  error: { name: "TypeError", message: "Cannot read properties of undefined (reading 'window')", endpoint: "/api/waivers/window", status: 500 },
  ...(over || {}),
});
const post = (env, p, body, extra) => callWorker(env, "POST", p + (extra === undefined ? Q : extra), { body });
const submit = (env, over, extra) => post(env, "/api/bug-reports", report(over), extra);
const rows = (db) => db.raw.prepare("SELECT * FROM ups_bug_reports ORDER BY id").all();
const events = (db) => db.raw.prepare("SELECT * FROM ups_bug_report_events ORDER BY id").all();
const everything = (db) => JSON.stringify({ r: rows(db), e: events(db) });
const withClock = async (startMs, fn) => {
  const real = Date.now; let now = startMs;
  Date.now = () => now;
  try { await fn({ advance: (s) => { now += s * 1000; }, now: () => now }); } finally { Date.now = real; }
};

// ------------------------------------------------------------------ flag
test("flag off (the default): 404 before any MFL call or database read", async () => {
  const { env, mfl, db } = fresh({ env: { BUG_REPORT_ENABLED: "0" } });
  const before = db.log.length;
  const r = await submit(env);
  t.equal(r.status, 404);
  t.equal(r.json.code, "disabled");
  t.equal(mfl.st.exports.length, 0, "no MFL identity read when the flag is off");
  t.ok(!db.log.slice(before).some((q) => /ups_bug_report/.test(q.sql)), "the report tables are never touched");
  for (const p of ["/api/bug-reports/mine", "/api/bug-reports/commish/list", "/api/bug-reports/commish/get"]) t.equal((await post(env, p, { mfl_user_id: COMMISH })).status, 404, p);
});

test("the flag is a wrangler var that ships off", () => {
  const toml = fs.readFileSync(path.join(ROOT, "worker", "wrangler.toml"), "utf8");
  t.match(toml, /^BUG_REPORT_ENABLED\s*=\s*"0"\s*$/m);
});

test("a flag that cannot be read counts as off", async () => {
  const calls = [];
  const res = await handleBugReportRequest({
    request: new Request("https://x/api/bug-reports", { method: "POST", body: "{}" }), url: new URL("https://x/api/bug-reports"), path: "/api/bug-reports", env: {},
    deps: { isEnabled: async () => { throw new Error("D1 down"); }, detectFranchise: async () => { calls.push("mfl"); }, commishFids: () => [], store: () => { calls.push("store"); } },
  });
  t.equal(res.status, 404);
  t.equal(calls.length, 0);
});

test("only POST; other paths fall through to the rest of the worker", async () => {
  const { env } = fresh();
  t.equal((await callWorker(env, "GET", "/api/bug-reports" + Q)).status, 405);
  const noRoute = await handleBugReportRequest({ request: new Request("https://x/api/other", { method: "POST" }), url: new URL("https://x/api/other"), path: "/api/other", env: {}, deps: {} });
  t.equal(noRoute, null);
});

// ------------------------------------------------------------------ identity
test("a signed-in owner files a report: stored against the PROVEN team, one MFL read, token never stored", async () => {
  const { env, mfl, db } = fresh();
  const r = await submit(env);
  t.equal(r.status, 201);
  t.equal(r.json.report.code, "TEST-001");
  t.equal(r.json.report.status, "open");
  const [row] = rows(db);
  t.equal(row.franchise_id, "0002", "franchise comes from the MFL session");
  t.equal(row.env, "test");
  t.equal(row.screen, "Market › Find players");
  t.equal(row.err_endpoint, "/api/waivers/window");
  t.equal(row.viewport, "375x812");
  t.equal(mfl.st.exports.filter((e) => e.type === "myleagues").length, 1, "exactly one MFL identity read per submit");
  t.equal(mfl.st.exports.length, 1, "and no other MFL read");
  t.ok(!everything(db).includes(OWNER_A), "the sign-in token is not in the database");
  t.ok(!JSON.stringify(r.json).includes(OWNER_A), "and not echoed");
  t.equal(events(db).length, 1);
  t.equal(events(db)[0].kind, "submitted");
});

test("a franchise id in the body is a refused field, never identity", async () => {
  const { env, db } = fresh();
  const r = await submit(env, { franchise_id: "0008" });
  t.equal(r.status, 400);
  t.equal(r.json.code, "unknown_field");
  t.deepEqual(r.json.fields, ["franchise_id"]);
  t.equal(rows(db).length, 0);
});

const SIGNIN_CASES = [
  { name: "no sign-in at all", over: { mfl_user_id: "" }, status: 401, code: "unauthenticated", state: "signin" },
  { name: "an expired or invalid MFL session", over: { mfl_user_id: "tok-expired" }, status: 401, code: "session_expired", state: "signin" },
  { name: "an MFL login that is not in this league", over: { mfl_user_id: "tok-x" }, status: 403, code: "forbidden", state: "signin" },
];
for (const c of SIGNIN_CASES) {
  test("failed sign-in is explained: " + c.name, async () => {
    const { env, db } = fresh();
    const r = await submit(env, c.over);
    t.equal(r.status, c.status);
    t.equal(r.json.code, c.code);
    t.equal(r.json.state, c.state);
    t.ok(r.json.title && r.json.title.length > 8, "has a title the sheet can show");
    t.match(r.json.message, /Nothing was sent/, "says nothing was sent");
    t.equal(rows(db).length, 0, "nothing stored");
  });
}
test("failed sign-in is explained: MFL does not answer", async () => {
  const { env, db } = fresh({ mfl: { myleaguesDown: true } });
  const r = await submit(env);
  t.equal(r.status, 503);
  t.equal(r.json.code, "identity_unavailable");
  t.equal(r.json.state, "retry");
  t.match(r.json.message, /Try again/);
  t.match(r.json.message, /note is still here/);
  t.equal(rows(db).length, 0);
});

test("a slow MFL is cut off at the timeout, not held open", async () => {
  const store = makeMemoryStore();
  const res = await handleBugReportRequest({
    request: new Request("https://x/api/bug-reports?L=74598&YEAR=2026", { method: "POST", body: JSON.stringify(report()) }),
    url: new URL("https://x/api/bug-reports?L=74598&YEAR=2026"), path: "/api/bug-reports", env: {}, identityTimeoutMs: 30,
    defaultLeagueId: "74598", defaultSeason: "2026",
    deps: { isEnabled: async () => true, detectFranchise: () => new Promise(() => {}), commishFids: () => [], store: () => store },
  });
  t.equal(res.status, 503);
  t.equal((await res.json()).code, "identity_unavailable");
  t.equal(store._reports.length, 0);
});

test("the admin key never files a report, and a stray APIKEY beside an owner session is ignored", async () => {
  const { env, db } = fresh();
  const asAdmin = await submit(env, { mfl_user_id: "" }, Q + "&APIKEY=" + ADMIN_KEY);
  t.equal(asAdmin.status, 401, "admin key alone is not a report author");
  const stray = await submit(env, {}, Q + "&APIKEY=not-the-key");
  t.equal(stray.status, 201, "a foreign APIKEY beside a real owner session is not an error");
  t.equal(rows(db).length, 1);
});

// ------------------------------------------------------------------ fields
test("every field is on the allowlist; extras anywhere are refused by name", async () => {
  const { env, db } = fresh();
  const a = await submit(env, { stack: "…" });
  t.equal(a.json.code, "unknown_field");
  const b = await submit(env, { error: { name: "X", message: "m", cookie: "c" } });
  t.equal(b.json.code, "unknown_field");
  t.deepEqual(b.json.fields, ["error.cookie"]);
  t.equal(rows(db).length, 0);
});

test("required fields and length caps", async () => {
  const { env, db } = fresh();
  t.equal((await submit(env, { summary: "  " })).json.code, "summary_required");
  t.equal((await submit(env, { client_request_id: "x" })).json.code, "bad_request");
  t.equal((await submit(env, { screen: "" })).json.code, "bad_request");
  const long = await submit(env, { summary: "ab ".repeat(200), note: "note text ".repeat(300), error: { message: "err ".repeat(300) } });
  t.equal(long.status, 201);
  const row = rows(db)[0];
  t.equal(row.summary.length, 120);
  t.equal(row.note.length, 1000);
  t.equal(row.err_message.length, 500);
});

test("a body over 8 KB is refused before anything else", async () => {
  const { env, mfl } = fresh();
  const r = await post(env, "/api/bug-reports", { ...report(), note: "x ".repeat(6000) });
  t.equal(r.status, 413);
  t.equal(r.json.code, "too_large");
  t.equal(mfl.st.exports.length, 0, "no MFL call for an oversized body");
});

// ------------------------------------------------------------------ redaction
test("server-side redaction: secrets never reach the database", async () => {
  const { env, db } = fresh();
  const SECRETS = ["S3cr3tK3y123", "tok-A-session-9999", "AbCdEf0123456789AbCdEf0123456789xyz", "hunter2pass", "owner@example.com", "hook-token-abc", "cookie-value-77"];
  const r = await submit(env, {
    summary: "Fetch failed APIKEY=S3cr3tK3y123 for owner@example.com",
    note: "My MFL_USER_ID=tok-A-session-9999 and password: hunter2pass. Cookie: cookie-value-77. https://discord.com/api/webhooks/1/hook-token-abc",
    error: {
      name: "FetchError",
      message: "GET https://api.myfantasyleague.com/2026/export?TYPE=rosters&APIKEY=S3cr3tK3y123 failed; Authorization: Bearer AbCdEf0123456789AbCdEf0123456789xyz",
      endpoint: "https://worker.example.dev/api/roster?MFL_USER_ID=tok-A-session-9999#frag", status: 401,
    },
  });
  t.equal(r.status, 201);
  t.ok(r.json.redactions >= 6, "reports how many items were removed: " + r.json.redactions);
  const dump = everything(db);
  for (const s of SECRETS) t.ok(!dump.includes(s), "stored data must not contain " + s);
  const row = rows(db)[0];
  t.equal(row.err_endpoint, "/api/roster", "endpoint is path only");
  t.equal(row.redactions, r.json.redactions);
  t.match(row.err_message, /export \b/, "the useful words survive");
  t.ok(!JSON.stringify(r.json).includes("S3cr3tK3y123"));
});

// ------------------------------------------------------------------ duplicates
test("a retry (same request id) replays the first report and never makes another", async () => {
  const { env, db } = fresh();
  const body = report();
  const a = await post(env, "/api/bug-reports", body);
  const b = await post(env, "/api/bug-reports", body);
  t.equal(a.status, 201);
  t.equal(b.status, 200);
  t.equal(b.json.replay, true);
  t.equal(b.json.report.code, a.json.report.code);
  t.equal(rows(db).length, 1);
  t.equal(rows(db)[0].dup_count, 0, "a retry is not a duplicate");
});

test("the same problem from the same team is added to the open report, not a second one", async () => {
  const { env, db } = fresh();
  await withClock(Date.parse("2026-11-19T15:00:00Z"), async ({ advance }) => {
    const a = await submit(env);
    advance(120);
    const b = await submit(env, { note: "Happened again just now.", error: { name: "TypeError", message: "Cannot read properties of undefined (reading 'window')", endpoint: "/api/waivers/window", status: 500 } });
    t.equal(b.status, 200);
    t.equal(b.json.duplicate, true);
    t.equal(b.json.report.code, a.json.report.code);
    t.match(b.json.message, /already reported this \(TEST-001\)/);
    t.equal(b.json.report.times_reported, 2);
    t.equal(rows(db).length, 1);
    t.equal(rows(db)[0].dup_count, 1);
    t.deepEqual(events(db).map((e) => e.kind), ["submitted", "duplicate"]);
    t.equal(events(db)[1].detail, "Happened again just now.");
  });
});

test("digits and case in an error do not hide a duplicate; a different problem is a new report", async () => {
  const { env, db } = fresh();
  await withClock(Date.parse("2026-11-19T15:00:00Z"), async ({ advance }) => {
    await submit(env, { error: { name: "HTTPError", message: "Request 1234 failed with Status 500", endpoint: "/api/a", status: 500 } });
    advance(60);
    const same = await submit(env, { error: { name: "httperror", message: "request 98765 FAILED with status 500", endpoint: "/api/a", status: 500 } });
    t.equal(same.json.duplicate, true);
    advance(60);
    const other = await submit(env, { error: { name: "HTTPError", message: "Request 1 failed with Status 500", endpoint: "/api/b", status: 500 } });
    t.equal(other.status, 201, "a different endpoint is a different problem");
    t.equal(rows(db).length, 2);
  });
});

test("another team reporting the same problem gets its own report", async () => {
  const { env, db } = fresh();
  await submit(env);
  const b = await submit(env, { mfl_user_id: OWNER_B });
  t.equal(b.status, 201);
  t.deepEqual(rows(db).map((r) => r.franchise_id), ["0002", "0003"]);
});

test("duplicates are capped: the 11th is refused", async () => {
  const { env, db } = fresh();
  await withClock(Date.parse("2026-11-19T15:00:00Z"), async ({ advance }) => {
    await submit(env);
    for (let i = 0; i < 10; i++) { advance(30); t.equal((await submit(env)).json.duplicate, true); }
    advance(30);
    const r = await submit(env);
    t.equal(r.status, 429);
    t.equal(r.json.code, "duplicate_limit");
    t.equal(rows(db)[0].dup_count, 10);
  });
});

// ------------------------------------------------------------------ rate limit
test("rate limit: 20 seconds between new reports, 5 per team per 24 hours, with a retry-after", async () => {
  const { env, db } = fresh();
  await withClock(Date.parse("2026-11-19T15:00:00Z"), async ({ advance }) => {
    const distinct = (i) => ({ screen: "Screen " + String.fromCharCode(65 + i), error: { name: "E" + String.fromCharCode(65 + i), message: "boom " + String.fromCharCode(65 + i), endpoint: "/api/x" + String.fromCharCode(97 + i), status: 500 } });
    t.equal((await submit(env, distinct(0))).status, 201);
    advance(5);
    const fast = await submit(env, distinct(1));
    t.equal(fast.status, 429);
    t.equal(fast.json.code, "too_fast");
    t.equal(fast.json.retry_after_seconds, 15);
    t.equal(fast.headers.get("retry-after"), "15");
    for (let i = 1; i < 5; i++) { advance(21); t.equal((await submit(env, distinct(i))).status, 201, "report " + (i + 1)); }
    advance(21);
    const sixth = await submit(env, distinct(5));
    t.equal(sixth.status, 429);
    t.equal(sixth.json.code, "daily_limit");
    t.ok(sixth.json.retry_after_seconds > 86000 && sixth.json.retry_after_seconds <= 86400, "retry after ~24h: " + sixth.json.retry_after_seconds);
    t.equal(rows(db).length, 5);
    const other = await submit(env, { ...distinct(5), mfl_user_id: OWNER_B });
    t.equal(other.status, 201, "the limit is per team");
    advance(sixth.json.retry_after_seconds + 1);
    t.equal((await submit(env, distinct(5))).status, 201, "allowed again once the oldest leaves the window");
  });
});

test("a retry or a duplicate does not use up the daily allowance", async () => {
  const { env, db } = fresh();
  await withClock(Date.parse("2026-11-19T15:00:00Z"), async ({ advance }) => {
    const body = report();
    await post(env, "/api/bug-reports", body);
    for (let i = 0; i < 4; i++) { advance(25); await post(env, "/api/bug-reports", body); }
    for (let i = 0; i < 3; i++) { advance(25); await submit(env); }
    t.equal(rows(db).length, 1);
    advance(25);
    t.equal((await submit(env, { screen: "Some other screen" })).status, 201);
  });
});

// ------------------------------------------------------------------ privacy and access
test("an owner sees only their own reports, in a minimal view", async () => {
  const { env } = fresh();
  await withClock(Date.parse("2026-11-19T15:00:00Z"), async ({ advance }) => {
    await submit(env);                                         // team 0002
    advance(30);
    await submit(env, { mfl_user_id: OWNER_B, summary: "Other owner's problem", note: "PRIVATE-NOTE-B" });
    const a = await post(env, "/api/bug-reports/mine", { mfl_user_id: OWNER_A });
    t.equal(a.status, 200);
    t.equal(a.json.reports.length, 1);
    t.deepEqual(Object.keys(a.json.reports[0]).sort(), ["code", "created_at", "status", "summary", "times_reported", "updated_at"]);
    t.ok(!a.text.includes("PRIVATE-NOTE-B") && !a.text.includes("Other owner"), "never another team's data");
    t.ok(!/franchise|note|err|0002|0003/.test(a.text), "no team ids, notes or error fields in an owner's own list");
    t.equal((await post(env, "/api/bug-reports/mine", { mfl_user_id: "" })).status, 401);
  });
});

test("only the commissioner reads reports: a signed-in owner, a stranger and a wrong key are all refused", async () => {
  const { env } = fresh();
  await submit(env);
  for (const p of ["/api/bug-reports/commish/list", "/api/bug-reports/commish/get"]) {
    t.equal((await post(env, p, { mfl_user_id: OWNER_A, id: 1 })).status, 403, "owner on " + p);
    t.equal((await post(env, p, { mfl_user_id: OWNER_B, id: 1 })).status, 403, "other owner on " + p);
    t.equal((await post(env, p, { mfl_user_id: "", id: 1 })).status, 401, "nobody on " + p);
    t.equal((await post(env, p, { mfl_user_id: "", id: 1 }, Q + "&APIKEY=wrong")).status, 403, "wrong key on " + p);
  }
});

test("the commissioner (session or admin key) sees everything, including private fields and events", async () => {
  const { env } = fresh();
  await withClock(Date.parse("2026-11-19T15:00:00Z"), async ({ advance }) => {
    await submit(env, { note: "owner note A" });
    advance(30);
    await submit(env, { mfl_user_id: OWNER_B, note: "owner note B", screen: "Roster" });
    for (const [label, body, extra] of [["session", { mfl_user_id: COMMISH }, Q], ["admin key", {}, Q + "&APIKEY=" + ADMIN_KEY]]) {
      const l = await post(env, "/api/bug-reports/commish/list", body, extra);
      t.equal(l.status, 200, label);
      t.equal(l.json.reports.length, 2, label);
      const first = l.json.reports.find((x) => x.franchise_id === "0002");
      t.equal(first.note, "owner note A", label);
      t.equal(first.error.endpoint, "/api/waivers/window", label);
      t.ok(!l.text.includes(OWNER_A) && !l.text.includes(COMMISH), "no tokens in the commissioner view either");
      const g = await post(env, "/api/bug-reports/commish/get", { ...body, id: first.id }, extra);
      t.equal(g.status, 200, label);
      t.equal(g.json.events[0].kind, "submitted", label);
      t.equal((await post(env, "/api/bug-reports/commish/get", { ...body, id: 999 }, extra)).status, 404, label);
    }
  });
});

test("the commissioner key may arrive as a Bearer header, so it never has to sit in an address", async () => {
  const { env } = fresh();
  await submit(env);
  const ok = await callWorker(env, "POST", "/api/bug-reports/commish/list" + Q, { body: {}, headers: { Authorization: "Bearer " + ADMIN_KEY } });
  t.equal(ok.status, 200);
  t.equal(ok.json.reports.length, 1);
  const bad = await callWorker(env, "POST", "/api/bug-reports/commish/list" + Q, { body: {}, headers: { Authorization: "Bearer nope" } });
  t.equal(bad.status, 403);
});

test("the commissioner routes are not under /admin (no address-borne session, no second MFL read)", () => {
  const src = fs.readFileSync(path.join(ROOT, "worker", "src", "bug_reports.js"), "utf8");
  t.doesNotMatch(src, /["']\/admin\/bug-reports/);
});

test("every response is private: no-store, including refusals", async () => {
  const { env } = fresh();
  const responses = [
    await submit(env), await submit(env, { mfl_user_id: "" }), await submit(env, { stack: "x" }),
    await post(env, "/api/bug-reports/mine", { mfl_user_id: OWNER_A }), await post(env, "/api/bug-reports/commish/list", { mfl_user_id: OWNER_A }),
  ];
  for (const r of responses) t.match(r.headers.get("cache-control"), /no-store/);
});

// ------------------------------------------------------------------ outbound calls and D1 cost
test("the route's only outbound calls are the MFL identity read and D1: nothing to Discord or GitHub", async () => {
  const { env, mfl } = fresh();
  await submit(env);
  await post(env, "/api/bug-reports/mine", { mfl_user_id: OWNER_A });
  await post(env, "/api/bug-reports/commish/list", { mfl_user_id: COMMISH });
  t.equal(mfl.st.discord.length, 0, "no Discord call or DM");
  t.ok(mfl.st.exports.every((e) => e.type === "myleagues"), "only the myleagues identity read");
  t.equal(mfl.st.exports.length, 3, "one identity read per request");
  const src = ["bug_reports.js", "bug_report_core.js"].map((f) => fs.readFileSync(path.join(ROOT, "worker", "src", f), "utf8")).join("\n");
  t.doesNotMatch(src, /\bfetch\s*\(/, "the module never calls fetch itself");
  t.doesNotMatch(src, /discord\.com|api\.github\.com|api\.anthropic\.com/i, "no Discord, GitHub or Anthropic address in either module");
});

test("D1 cost: every query uses an index, and a submit touches a handful of rows", async () => {
  const { env, db } = fresh();
  db.log.length = 0;
  await submit(env);
  await post(env, "/api/bug-reports/mine", { mfl_user_id: OWNER_A });
  await post(env, "/api/bug-reports/commish/list", { mfl_user_id: COMMISH });
  await post(env, "/api/bug-reports/commish/list", { mfl_user_id: COMMISH, status: "open" });
  await post(env, "/api/bug-reports/commish/get", { mfl_user_id: COMMISH, id: 1 });
  const seen = new Map();
  for (const q of db.log) if (/ups_bug_report/.test(q.sql)) seen.set(q.sql, q.args);
  t.ok(seen.size >= 9, "exercised every store query, saw " + seen.size);
  for (const [sql, args] of seen) {
    if (!/^\s*SELECT/i.test(sql)) continue;
    const plan = db.raw.prepare("EXPLAIN QUERY PLAN " + sql).all(...args.map((a) => (a === undefined ? null : a))).map((p) => p.detail).join(" | ");
    const indexed = /USING (COVERING )?INDEX|USING INTEGER PRIMARY KEY|PRIMARY KEY/.test(plan);
    const rowidOrder = /ORDER BY id DESC LIMIT/.test(sql);   // commissioner list, newest first by row id, LIMIT 100
    t.ok(indexed || rowidOrder, "indexed: " + sql.slice(0, 70) + " -> " + plan);
    if (!rowidOrder) t.doesNotMatch(plan, /SCAN ups_bug_reports(?! USING)/, "no full scan: " + sql.slice(0, 70));
  }
  const dupSql = [...seen.keys()].find((q) => /fingerprint=\?/.test(q));
  const dupPlan = db.raw.prepare("EXPLAIN QUERY PLAN " + dupSql).all(...seen.get(dupSql)).map((p) => p.detail).join(" | ");
  t.match(dupPlan, /idx_ups_bug_reports_team_fp/, "the duplicate lookup is pinned to the team+fingerprint index: " + dupPlan);
  const writes = db.log.filter((q) => /^\s*(INSERT|UPDATE)/i.test(q.sql) && /ups_bug_report/.test(q.sql));
  t.equal(writes.length, 2, "a new report is two inserts (report + event)");
});

// ------------------------------------------------------------------ failure safety
test("a database failure on save answers 500, stores nothing and does not log the report text", async () => {
  const { env, db } = fresh();
  const logged = [];
  const orig = console.error; console.error = (...a) => logged.push(a.join(" "));
  db.opts.failWrites = true;
  try {
    const r = await submit(env, { summary: "SECRET-SUMMARY-TEXT" });
    t.equal(r.status, 500);
    t.equal(r.json.code, "server_error");
    t.match(r.json.message, /wasn't saved/);
  } finally { console.error = orig; db.opts.failWrites = false; }
  t.equal(rows(db).length, 0);
  t.ok(!logged.join("\n").includes("SECRET-SUMMARY-TEXT"), "report text is never logged");
});

test("two identical requests racing: the unique index lets one through, the loser is answered as a replay", async () => {
  const store = makeMemoryStore();
  const base = { path: "/api/bug-reports", env: {}, defaultLeagueId: "74598", defaultSeason: "2026" };
  const call = (st, body) => handleBugReportRequest({
    ...base, request: new Request("https://x/api/bug-reports?L=74598&YEAR=2026", { method: "POST", body: JSON.stringify(body) }), url: new URL("https://x/api/bug-reports?L=74598&YEAR=2026"),
    deps: { isEnabled: async () => true, detectFranchise: async () => ({ franchise_id: "0002" }), commishFids: () => [], store: () => st },
  });
  const body = report();
  t.equal((await call(store, body)).status, 201);
  // The second request read the table BEFORE the first one committed: every pre-check came back empty.
  let looked = 0;
  const stale = { ...store, findByRequestId: async (f, r) => (looked++ === 0 ? null : store.findByRequestId(f, r)), findOpenByFingerprint: async () => null, recentByFranchise: async () => [] };
  const loser = await call(stale, body);
  t.equal(loser.status, 200);
  t.equal((await loser.json()).replay, true);
  t.equal(store._reports.length, 1);
});

restoreConsole();
await run("bug_reports");
