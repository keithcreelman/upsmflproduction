// COMMISSIONER ADMINISTRATIVE CANCEL of a three-team trade (RULING, Keith 2026-09-25).
//   node tests/trade_3way_admin_cancel.test.mjs      (REAL worker, real SQLite + migrations, MFL/Discord stubbed)
//
// POST /admin/3way/cancel?L=…&APIKEY=…   { id, reason }
//   - a DISTINCT administrative action: explicit COMMISH_API_KEY only — not a commissioner session, not
//     "acting as" the initiator, not the owner route
//   - only while `collecting`; non-empty reason required; recorded as commissioner/admin with time + reason
//   - all three teams told exactly once; repeat is idempotent; never touches MFL; history preserved
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet, ADMIN_KEY } from "./fixtures/worker_harness.mjs";
import { THREE_WAY_MIGRATIONS_BEFORE_0159 } from "./fixtures/d1_sqlite.mjs";
import { seedTrade, readRow, TRADE_ID, DISCORD } from "./fixtures/trade_3way_fixture.mjs";
import { decideAdminCancel, decodeReason, cleanAdminReason } from "../worker/src/trade_3way_model.js";

const restore = quiet();
const TOK = { tokens: { "tok-H": "0012" } };
function fresh(over, seed) {
  const env = makeWorkerEnv({ TRADE_3WAY_EXECUTE: "0", ...(over || {}) });
  const mfl = makeMfl(TOK); mfl.install();
  for (const [f, d] of [["0008", DISCORD.A], ["0001", DISCORD.B], ["0012", DISCORD.C]]) env.UPS_MFL_DB.raw.prepare("INSERT INTO discord_owners VALUES (?,?,?)").run(f, "Y", d);
  seedTrade(env, seed);
  return { env, mfl };
}
const ADMIN = (extra) => `/admin/3way/cancel?L=74598&APIKEY=${ADMIN_KEY}${extra || ""}`;
const REASON = "Two of the three owners asked me to unwind this after the injury news.";
const cancel = (env, body, path) => callWorker(env, "POST", path || ADMIN(), { body });
const dms = (mfl) => mfl.st.discord.filter((d) => /\/messages$/.test(d.url));
const dmTo = (mfl, discordId) => dms(mfl).filter((d) => d.url.includes(`dm-${discordId}`));
const row = (env) => readRow(env);
const unchanged = (env, mfl, status = "collecting") => { t.equal(row(env).status, status); t.equal(row(env).failure_reason, status === "collecting" ? null : row(env).failure_reason); t.equal(dms(mfl).length, 0); t.equal(mfl.st.imports.length, 0); };

// ═════════════════════════ authority: only the explicit admin key ═════════════════════════
test("AUTHORITY: no key → 401, a wrong or empty key → 403 (the admin door), nothing changes", async () => {
  const { env, mfl } = fresh();
  for (const [path, want, code] of [["/admin/3way/cancel?L=74598", 401, "unauthenticated"], ["/admin/3way/cancel?L=74598&APIKEY=wrong", 403, "forbidden"], ["/admin/3way/cancel?L=74598&APIKEY=", 401, "unauthenticated"]]) {
    const r = await cancel(env, { id: TRADE_ID, reason: REASON }, path);
    t.equal(r.status, want, path); t.equal(r.json.code, code, path);
  }
  unchanged(env, mfl);
});
test("AUTHORITY: a commissioner SESSION is not enough — with or without acting as the initiator", async () => {
  const { env, mfl } = fresh();
  for (const q of ["&MFL_USER_ID=tok-commish", "&MFL_USER_ID=tok-commish&acting_franchise_id=0008", "&MFL_USER_ID=tok-A"]) {
    const r = await cancel(env, { id: TRADE_ID, reason: REASON }, `/admin/3way/cancel?L=74598${q}`);
    t.equal(r.status, 403);
  }
  unchanged(env, mfl);
});
test("AUTHORITY: the initiator, a partner and an unrelated owner cannot use it (their own routes are unchanged)", async () => {
  const { env, mfl } = fresh();
  for (const tok of ["tok-A", "tok-B", "tok-H", "tok-O"]) t.equal((await cancel(env, { id: TRADE_ID, reason: REASON }, `/admin/3way/cancel?L=74598&MFL_USER_ID=${tok}`)).status, 403);
  unchanged(env, mfl);
  // owner route: initiator cancels (2 DMs to the partners, recorded as the initiator's)
  const own = await callWorker(env, "POST", "/api/trades/3way/cancel?MFL_USER_ID=tok-A", { body: { id: TRADE_ID } });
  t.equal(own.status, 200); t.equal(row(env).failure_reason, "cancelled_by_initiator"); t.equal(row(env).cancelled_by, null);
  t.equal(dms(mfl).length, 2);
});
test("AUTHORITY: the owner route never becomes an administrative cancel (session, acting-as or admin key)", async () => {
  const { env, mfl } = fresh();
  const tries = [["?MFL_USER_ID=tok-commish", {}], ["?MFL_USER_ID=tok-commish&acting_franchise_id=0008", {}], [`?APIKEY=${ADMIN_KEY}&acting_franchise_id=0008`, {}], [`?APIKEY=${ADMIN_KEY}`, { reason: REASON }]];
  for (const [q, extra] of tries) {
    const r = await callWorker(env, "POST", `/api/trades/3way/cancel${q}`, { body: { id: TRADE_ID, ...extra } });
    t.ok(r.status >= 400, `${q} -> ${r.status}`); t.notEqual(r.json.basis, "cancelled_by_commissioner");
  }
  unchanged(env, mfl);
});
test("SCOPE: L is required (the global guard), and a trade from another league is a 404 even for the admin key", async () => {
  const { env, mfl } = fresh();
  const noL = await cancel(env, { id: TRADE_ID, reason: REASON }, `/admin/3way/cancel?APIKEY=${ADMIN_KEY}`);
  t.equal(noL.status, 400); t.equal(noL.json.reason, "Missing L param");
  const other = await cancel(env, { id: TRADE_ID, reason: REASON }, `/admin/3way/cancel?L=99999&APIKEY=${ADMIN_KEY}`);
  t.equal(other.status, 404);
  unchanged(env, mfl);
  for (const id of ["nope", "'; DROP TABLE ups_3way_trades;--", "", "00000000-0000-0000-0000-000000000000"]) {
    const r = await cancel(env, { id, reason: REASON });
    t.ok([400, 404].includes(r.status), `id=${id} -> ${r.status}`); t.ok(r.json.code);
  }
  unchanged(env, mfl);
});

// ═════════════════════════ a reason is required ═════════════════════════
test("REASON: missing, empty, whitespace-only and control-only reasons are refused (400 reason_required)", async () => {
  const { env, mfl } = fresh();
  for (const reason of [undefined, null, "", "   ", "\n\t  ", "\u0000\u0007", 42 && "  \r\n "]) {
    const r = await cancel(env, { id: TRADE_ID, reason });
    t.equal(r.status, 400); t.equal(r.json.code, "reason_required");
  }
  unchanged(env, mfl);
});
test("REASON: it is normalised (control chars removed, whitespace collapsed) and capped at 500 characters", async () => {
  t.equal(cleanAdminReason("  a\u0000b \n\n c  "), "a b c");
  t.equal(cleanAdminReason("x".repeat(900)).length, 500);
  const { env } = fresh();
  await cancel(env, { id: TRADE_ID, reason: "y".repeat(900) });
  t.equal(row(env).cancel_reason.length, 500);
});

// ═════════════════════════ what it records ═════════════════════════
test("RECORD: state, basis, actor (commissioner/admin — NOT the initiator), timestamp and reason are written atomically", async () => {
  const { env, mfl } = fresh();
  const before = row(env);
  const r = await cancel(env, { id: TRADE_ID, reason: REASON });
  t.equal(r.status, 200, r.text.slice(0, 200)); t.equal(r.json.ok, true);
  t.equal(r.json.basis, "cancelled_by_commissioner"); t.equal(r.json.already, false);
  t.equal(r.json.cancelled_by, "commissioner_admin"); t.equal(r.json.reason, REASON);
  t.match(r.json.cancelled_at_utc, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);
  const a = row(env);
  t.equal(a.status, "cancelled"); t.equal(a.failure_reason, "cancelled_by_commissioner");
  t.equal(a.cancel_basis, "cancelled_by_commissioner"); t.equal(a.cancelled_by, "commissioner_admin");
  t.equal(a.cancel_reason, REASON); t.equal(a.cancelled_at_utc, r.json.cancelled_at_utc);
  t.notEqual(a.failure_reason, "cancelled_by_initiator"); t.doesNotMatch(String(a.cancelled_by), /^\d{4}$/);   // never a franchise id
  // complete history preserved: legs, notes, participants, extension requests untouched, row still exists
  for (const k of ["legs_json", "notes", "extension_requests_json", "initiator_fid", "team_b_fid", "team_c_fid", "initiator_name", "created_at_utc", "team_b_state", "team_c_state", "mfl_trade_ids"]) t.equal(a[k], before[k], k);
  t.equal(env.UPS_MFL_DB.raw.prepare("SELECT COUNT(*) AS n FROM ups_3way_trades").get().n, 1);
  t.equal(mfl.st.imports.length, 0);
});
test("RECORD: the canonical trade shows every participant who cancelled it and why — as the commissioner, not the initiator", async () => {
  const { env } = fresh();
  await cancel(env, { id: TRADE_ID, reason: REASON });
  for (const tok of ["tok-A", "tok-B", "tok-H", "tok-commish"]) {
    const g = await callWorker(env, "GET", `/api/trades/3way?id=${TRADE_ID}&MFL_USER_ID=${tok}`);
    t.equal(g.status, 200);
    const c = g.json.trade;
    t.equal(c.status, "cancelled"); t.equal(c.state_view.label, "Called off by the commissioner"); t.match(c.state_view.message, /Reason: Two of the three owners/);
    t.equal(c.cancelled.by_role, "commissioner"); t.equal(c.cancelled.basis, "cancelled_by_commissioner"); t.equal(c.cancelled.reason, REASON); t.match(c.cancelled.at_utc, /^\d{4}/);
    t.equal(c.permissions.can_cancel, false); t.equal(c.terminal, true);
  }
  const unrelated = await callWorker(env, "GET", `/api/trades/3way?id=${TRADE_ID}&MFL_USER_ID=tok-O`);
  t.equal(unrelated.status, 403); t.doesNotMatch(unrelated.text, /Two of the three owners/);
  const list = await callWorker(env, "GET", `/api/trades/3way?include=all&MFL_USER_ID=tok-B`);
  t.equal(list.json.trades.length, 1);            // history is still there
});
test("RECORD: the legacy `cancelled_by_commish:<fid>` rows written by older code still decode as a commissioner cancel", () => {
  const d = decodeReason({ status: "cancelled", failure_reason: "cancelled_by_commish:0000" });
  t.equal(d.code, "cancelled_by_commissioner"); t.equal(d.by_role, "commissioner");
});

// ═════════════════════════ notifications: all three, exactly once ═════════════════════════
test("NOTIFY: all three participants get exactly one message (with the reason); nothing goes to anyone else", async () => {
  const { env, mfl } = fresh();
  const r = await cancel(env, { id: TRADE_ID, reason: REASON });
  t.equal(r.status, 200);
  t.equal(dms(mfl).length, 3);
  for (const d of [DISCORD.A, DISCORD.B, DISCORD.C]) { t.equal(dmTo(mfl, d).length, 1); t.match(dmTo(mfl, d)[0].body.content, /The commissioner called off the 3-way trade\. Reason: Two of the three owners/); }
});
test("IDEMPOTENT: repeating it is a 200 already_cancelled — no second write, no second message, the original reason stays", async () => {
  const { env, mfl } = fresh();
  const first = await cancel(env, { id: TRADE_ID, reason: REASON });
  const at = row(env).cancelled_at_utc;
  const again = await cancel(env, { id: TRADE_ID, reason: "A different reason the second time" });
  t.equal(again.status, 200); t.equal(again.json.already, true); t.equal(again.json.code, "already_cancelled"); t.equal(again.json.reason, REASON);
  t.equal(row(env).cancel_reason, REASON); t.equal(row(env).cancelled_at_utc, at);
  t.equal(dms(mfl).length, 3);
  t.equal(first.json.already, false);
});
test("CONCURRENT: two simultaneous administrative cancels change the row once and notify once", async () => {
  const { env, mfl } = fresh();
  const rs = await Promise.all([cancel(env, { id: TRADE_ID, reason: REASON }), cancel(env, { id: TRADE_ID, reason: REASON }), cancel(env, { id: TRADE_ID, reason: REASON })]);
  t.ok(rs.every((r) => r.status === 200));
  t.equal(rs.filter((r) => r.json.already === false).length, 1);
  t.equal(dms(mfl).length, 3);
});
test("RACE: an owner cancel and an administrative cancel at the same moment — exactly one wins, and the loser is told the truth", async () => {
  const { env, mfl } = fresh();
  const [o, a] = await Promise.all([callWorker(env, "POST", "/api/trades/3way/cancel?MFL_USER_ID=tok-A", { body: { id: TRADE_ID } }), cancel(env, { id: TRADE_ID, reason: REASON })]);
  const winners = [o.status === 200 && o.json.already === false, a.status === 200 && a.json.already === false].filter(Boolean).length;
  t.equal(winners, 1);
  const fr = row(env).failure_reason;
  t.ok(fr === "cancelled_by_initiator" || fr === "cancelled_by_commissioner");
  if (fr === "cancelled_by_initiator") { t.equal(a.status, 409); t.equal(dms(mfl).length, 2); }
  else { t.equal(o.status, 200); t.equal(dms(mfl).length, 3); }
});
test("STATE: after an owner cancel, an administrative cancel is a 409 (it does not overwrite who cancelled), and no messages are sent", async () => {
  const { env, mfl } = fresh();
  await callWorker(env, "POST", "/api/trades/3way/cancel?MFL_USER_ID=tok-A", { body: { id: TRADE_ID } });
  const sent = dms(mfl).length;
  const r = await cancel(env, { id: TRADE_ID, reason: REASON });
  t.equal(r.status, 409); t.equal(r.json.code, "cannot_cancel_cancelled");
  t.equal(row(env).failure_reason, "cancelled_by_initiator"); t.equal(dms(mfl).length, sent);
});

// ═════════════════════════ only while collecting ═════════════════════════
for (const [status, reason] of [["executing", null], ["completed", null], ["completed", "dry_run"], ["failed", "PARTIAL_x"], ["cancelled", "declined_by_0001"], ["cancelled", "cancelled_by_initiator"]]) {
  test(`STATE: a ${status}${reason ? ` (${reason})` : ""} trade cannot be cancelled administratively — 409, unchanged, silent`, async () => {
    const { env, mfl } = fresh({}, { status, failure_reason: reason });
    const r = await cancel(env, { id: TRADE_ID, reason: REASON });
    t.equal(r.status, 409); t.equal(r.json.code, `cannot_cancel_${status}`);
    t.equal(row(env).status, status); t.equal(row(env).failure_reason, reason); t.equal(row(env).cancel_reason, null);
    t.equal(dms(mfl).length, 0); t.equal(mfl.st.imports.length, 0);
  });
}
test("STATE: any status the state machine doesn't list (e.g. 'expired') is refused too — the pure decision is default-deny", () => {
  for (const s of ["expired", "executing", "completed", "failed", "", "weird"]) {
    const d = decideAdminCancel({ status: s, failure_reason: "" }, REASON);
    t.equal(d.ok, false); t.equal(d.http, 409); t.equal(d.code, `cannot_cancel_${s || "unknown"}`);
  }
  t.equal(decideAdminCancel({ status: "collecting" }, REASON).ok, true);
  t.equal(decideAdminCancel({ status: "collecting" }, "").http, 400);
});

// ═════════════════════════ it is administrative only: no MFL, no execution ═════════════════════════
test("NO MFL: it never proposes, accepts or executes anything — zero MFL imports, and nothing calls execute even with live execution ON", async () => {
  const { env, mfl } = fresh({ TRADE_3WAY_EXECUTE: "1" });
  await cancel(env, { id: TRADE_ID, reason: REASON });
  t.equal(mfl.st.imports.length, 0); t.equal(mfl.writes().length, 0); t.equal(mfl.st.pending.length, 0); t.equal(mfl.st.done.length, 0);
  t.equal(row(env).mfl_trade_ids, null);
});

// ═════════════════════════ failures ═════════════════════════
test("FAIL CLOSED: before migration 0159 the administrative cancel changes nothing and says why (503 migration_required); owner cancel still works", async () => {
  const { env, mfl } = fresh({ __migrations: THREE_WAY_MIGRATIONS_BEFORE_0159 });
  const r = await cancel(env, { id: TRADE_ID, reason: REASON });
  t.equal(r.status, 503); t.equal(r.json.code, "migration_required"); t.doesNotMatch(r.text, /no such column|SQLITE/i);
  unchanged(env, mfl);
  const own = await callWorker(env, "POST", "/api/trades/3way/cancel?MFL_USER_ID=tok-A", { body: { id: TRADE_ID } });
  t.equal(own.status, 200);
});
test("FAIL CLOSED: a D1 failure is a 503, reports no success and sends no message", async () => {
  const { env, mfl } = fresh();
  const real = env.UPS_MFL_DB; env.UPS_MFL_DB = { prepare: (sql) => (/^\s*UPDATE/i.test(sql) ? { bind: () => ({ run: async () => { throw new Error("D1_ERROR: simulated"); } }) } : real.prepare(sql)) };
  const r = await cancel(env, { id: TRADE_ID, reason: REASON });
  env.UPS_MFL_DB = real;
  t.equal(r.status, 503); t.notEqual(r.json.ok, true); t.doesNotMatch(r.text, /D1_ERROR|simulated/);
  t.equal(row(env).status, "collecting"); t.equal(dms(mfl).length, 0);
});
test("A Discord delivery failure never rolls back or misreports the cancel", async () => {
  const { env, mfl } = fresh();
  const real = globalThis.fetch;
  globalThis.fetch = async (u, i) => (String(u).startsWith("https://discord.com/") ? { ok: false, status: 500, headers: new Headers(), text: async () => "no", json: async () => ({}) } : real(u, i));
  const r = await cancel(env, { id: TRADE_ID, reason: REASON });
  globalThis.fetch = real;
  t.equal(r.status, 200); t.equal(row(env).status, "cancelled"); t.equal(row(env).cancel_reason, REASON);
});

await run("trade_3way_admin_cancel");
restore();
