// Idempotency keys for creating trade offers (P0 S6, server side).   node tests/trade_idempotency.test.mjs
//
// Part 1  two-team propose (POST /api/trades/proposals) through the REAL worker, real SQLite, a stateful MFL stub
// Part 2  three-team create (POST /api/trades/3way) through the real HTTP handler + engine, Discord recorded
// Part 3  the store itself: purge (14 days, index-backed), migration ↔ runtime DDL parity, the cron wiring
//
// The key is OPTIONAL: a request without one must behave exactly as before (deployed clients send none).
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet } from "./fixtures/worker_harness.mjs";
import { makeEnv as make3WayEnv, goodDeps, installDiscordRecorder, DISCORD } from "./fixtures/trade_3way_fixture.mjs";
import { makeD1, applyMigrations } from "./fixtures/d1_sqlite.mjs";
await import("./fixtures/register_md_loader.mjs");
const { handle3WayHttp } = await import("../worker/src/trade_3way_http.js");
const { purgeTradeIdempotency, makeIdempotencyStore, replyForExisting, readIdempotencyKey, IDEM_DDL, IDEM_INDEX_DDL, IDEM_STALE_MS } = await import("../worker/src/trade_idempotency.js");

const restoreConsole = quiet();
const Q = "L=74598&YEAR=2026";
const KEY = "3f2b8c1e-7d4a-4f5e-9a1b-2c3d4e5f6a7b";
const KEY2 = "9e8d7c6b-5a49-4382-a1b0-c9d8e7f6a5b4";

// ───────────────────────────── Part 1 — two-team propose ─────────────────────────────
function fresh() {
  const env = makeWorkerEnv();
  const mfl = makeMfl();
  mfl.install();
  mfl.st.rosters["0001"] = [{ id: "14056", salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }];
  mfl.st.rosters["0002"] = [{ id: "13100", salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }];
  return { env, mfl };
}
const asset = (pid, salary) => ({ asset_id: `player:${pid}`, type: "PLAYER", player_id: String(pid), player_name: `P${pid}`, salary, taxi: false });
const proposal = (extra, capK) => ({
  league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002",
  from_franchise_name: "x", to_franchise_name: "y", message: "",
  payload: {
    schema_version: 1, source: "test", league_id: "74598", season: "2026",
    teams: [
      { role: "left", franchise_id: "0001", selected_assets: [asset(14056, 5000)], traded_salary_adjustment_dollars: (capK || 0) * 1000, traded_salary_adjustment_k: capK || 0, selected_non_taxi_salary_dollars: 5000 },
      { role: "right", franchise_id: "0002", selected_assets: [asset(13100, 5000)], traded_salary_adjustment_dollars: 0, traded_salary_adjustment_k: 0, selected_non_taxi_salary_dollars: 5000 },
    ],
    extension_requests: [], ui: { left_team_id: "0001", right_team_id: "0002" }, validation: { status: "ready" },
  },
  ...(extra || {}),
});
const send = (env, body) => callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, { body });
const idemRows = (env) => { try { return env.UPS_MFL_DB.raw.prepare("SELECT * FROM ups_trade_idempotency").all(); } catch (_) { return []; } };
const outboxRows = (env) => { try { return env.UPS_MFL_DB.raw.prepare("SELECT COUNT(*) AS n FROM twb_trade_outbox").get().n; } catch (_) { return 0; } };
const strip = (j) => { const { idempotent_replay, ...rest } = j || {}; return rest; };

test("2-WAY 1: double submit with the same key → exactly ONE tradeProposal; the second call gets the original response + idempotent_replay", async () => {
  const { env, mfl } = fresh();
  const a = await send(env, proposal({ idempotency_key: KEY }));
  t.equal(a.status, 201, a.text.slice(0, 300)); t.equal(a.json.idempotent_replay, undefined);
  const dmsAfterFirst = mfl.st.discord.length;
  const b = await send(env, proposal({ idempotency_key: KEY }));
  t.equal(b.status, 201); t.equal(b.json.idempotent_replay, true);
  t.deepEqual(strip(b.json), a.json, "the replay is the original body");
  t.equal(mfl.writes("tradeProposal").length, 1); t.equal(mfl.st.pending.length, 1);
  t.equal(mfl.st.discord.length, dmsAfterFirst, "no second DM");
  t.equal(outboxRows(env), 1, "one outbox row");
  const rows = idemRows(env);
  t.equal(rows.length, 1); t.equal(rows[0].state, "done"); t.equal(rows[0].status_code, 201); t.equal(rows[0].scope, "two_way_propose"); t.equal(rows[0].actor_fid, "0001");
});

test("2-WAY 2: two concurrent submits with the same key → one MFL call, one 201 and one 409 request_in_progress", async () => {
  const { env, mfl } = fresh();
  let release; const gate = new Promise((r) => { release = r; });
  let reached; const reachedP = new Promise((r) => { reached = r; });
  const inner = globalThis.fetch;
  globalThis.fetch = async (u, init) => {
    const body = init && typeof init.body === "string" ? init.body : "";
    if (/\/import/.test(String(u)) && /TYPE=tradeProposal/.test(String(u) + "&" + body)) { reached(); await gate; }
    return inner(u, init);
  };
  try {
    const first = send(env, proposal({ idempotency_key: KEY }));
    await reachedP;                                           // the first request is inside MFL's tradeProposal right now
    const second = await send(env, proposal({ idempotency_key: KEY }));
    t.equal(second.status, 409, second.text.slice(0, 200)); t.equal(second.json.code, "request_in_progress");
    release();
    const a = await first;
    t.equal(a.status, 201, a.text.slice(0, 200));
  } finally { globalThis.fetch = inner; }
  t.equal(mfl.writes("tradeProposal").length, 1); t.equal(mfl.st.pending.length, 1);
});

// The cap-acknowledgment loop: the sender is over the cap, so the first send is refused with the figure to acknowledge; the client
// resends with the SAME key + the acknowledgment. That 409 happens before the key is taken, so it must never be cached or replayed.
function overCapWorld(mfl) {
  mfl.st.rosters["0001"] = [{ id: "14056", salary: 5000, contractYear: 3, contractStatus: "Vet-FAA" }, { id: "90001", salary: 290000, contractYear: 3, contractStatus: "Vet-FAA" }];
  mfl.st.rosters["0002"] = [{ id: "13100", salary: 20000, contractYear: 3, contractStatus: "Vet-FAA" }, { id: "90002", salary: 100000, contractYear: 3, contractStatus: "Vet-FAA" }];
}
const capPayload = () => ({
  schema_version: 1, source: "test", league_id: "74598", season: "2026",
  teams: [
    { role: "left", franchise_id: "0001", selected_assets: [{ asset_id: "P_14056", type: "PLAYER", player_id: "14056", player_name: "P14056", salary: 5000, taxi: false, contract_info: "" }], traded_salary_adjustment_k: 0, traded_salary_adjustment_dollars: 0, selected_non_taxi_salary_dollars: 5000 },
    { role: "right", franchise_id: "0002", selected_assets: [{ asset_id: "P_13100", type: "PLAYER", player_id: "13100", player_name: "P13100", salary: 20000, taxi: false, contract_info: "" }], traded_salary_adjustment_k: 0, traded_salary_adjustment_dollars: 0, selected_non_taxi_salary_dollars: 20000 },
  ],
  extension_requests: [], ui: { left_team_id: "0001", right_team_id: "0002" }, validation: { status: "ready" },
});
test("2-WAY 3: cap-acknowledgment loop with the same key → the first 409 is NOT cached; the acknowledged resend sends; a third tap replays", async () => {
  const { env, mfl } = fresh(); overCapWorld(mfl);
  const body0 = { league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002", from_franchise_name: "x", to_franchise_name: "y", message: "", payload: capPayload(), idempotency_key: KEY };
  const r0 = await send(env, body0);
  t.equal(r0.status, 409, r0.text.slice(0, 200)); t.equal(r0.json.code, "cap_overage_ack_required");
  t.equal(idemRows(env).length, 0, "the refusal took no key"); t.equal(mfl.writes("tradeProposal").length, 0);
  const acked = { ...body0, cap_ack: { signature: r0.json.cap_ack_needed.signature } };
  const r1 = await send(env, acked);
  t.equal(r1.status, 201, r1.text.slice(0, 300)); t.equal(r1.json.idempotent_replay, undefined);
  t.equal(mfl.writes("tradeProposal").length, 1);
  const r2 = await send(env, acked);
  t.equal(r2.status, 201); t.equal(r2.json.idempotent_replay, true);
  t.equal(mfl.writes("tradeProposal").length, 1, "the double tap after acknowledging sent nothing");
});

test("2-WAY 4: no key → today's behavior (every submit sends; nothing recorded)", async () => {
  const { env, mfl } = fresh();
  const a = await send(env, proposal());
  const b = await send(env, proposal());
  t.equal(a.status, 201); t.equal(b.status, 201);
  t.equal(a.json.idempotent_replay, undefined); t.equal(b.json.idempotent_replay, undefined);
  t.equal(mfl.writes("tradeProposal").length, 2, "without a key a second submit still sends (unchanged; refusing duplicates needs a separate ruling)");
  t.equal(idemRows(env).length, 0);
});

test("2-WAY 5: the same key with different contents → 409 idempotency_key_reused; nothing sent", async () => {
  const { env, mfl } = fresh();
  const a = await send(env, proposal({ idempotency_key: KEY }));
  t.equal(a.status, 201, a.text.slice(0, 200));
  const b = await send(env, proposal({ idempotency_key: KEY }, 1));     // 1K of cap money added — a different offer
  t.equal(b.status, 409, b.text.slice(0, 200)); t.equal(b.json.code, "idempotency_key_reused");
  t.equal(mfl.writes("tradeProposal").length, 1);
  const c = await send(env, proposal({ idempotency_key: KEY, message: "a different note", cap_ack: { signature: "x" } }));
  t.equal(c.status, 201); t.equal(c.json.idempotent_replay, true, "the message and a cap acknowledgment are not part of the offer's identity");
  const d = await send(env, proposal({ idempotency_key: KEY2 }, 1));
  t.equal(d.status, 201, "a NEW key sends the different offer"); t.equal(mfl.writes("tradeProposal").length, 2);
});

test("2-WAY 6: an MFL refusal is recorded too — the same key replays the 502, never re-sends", async () => {
  const { env, mfl } = fresh();
  mfl.st.failNext = { type: "tradeProposal", status: 500 };
  const a = await send(env, proposal({ idempotency_key: KEY }));
  t.equal(a.status, 502, a.text.slice(0, 200));
  const b = await send(env, proposal({ idempotency_key: KEY }));
  t.equal(b.status, 502); t.equal(b.json.idempotent_replay, true); t.equal(b.json.error_type, "trade_proposal_import_failed");
  t.equal(mfl.writes("tradeProposal").length, 1); t.equal(idemRows(env)[0].state, "failed");
});

test("2-WAY 7: outcome not recorded (D1 failed after MFL) → the caller still gets its 201; a retry gets request_in_progress, then request_outcome_unknown once stale — never re-sent", async () => {
  const { env, mfl } = fresh();
  env.UPS_MFL_DB.opts.beforeRun = (sql) => { if (/^\s*UPDATE ups_trade_idempotency/i.test(sql)) throw new Error("D1_ERROR: simulated"); };
  const a = await send(env, proposal({ idempotency_key: KEY }));
  t.equal(a.status, 201, a.text.slice(0, 200)); t.doesNotMatch(a.text, /D1_ERROR|simulated/);
  env.UPS_MFL_DB.opts.beforeRun = null;
  t.equal(idemRows(env)[0].state, "in_progress");
  const b = await send(env, proposal({ idempotency_key: KEY }));
  t.equal(b.status, 409); t.equal(b.json.code, "request_in_progress");
  env.UPS_MFL_DB.raw.prepare("UPDATE ups_trade_idempotency SET updated_at_utc=?").run(new Date(Date.now() - IDEM_STALE_MS - 1000).toISOString());
  const c = await send(env, proposal({ idempotency_key: KEY }));
  t.equal(c.status, 409); t.equal(c.json.code, "request_outcome_unknown"); t.match(c.json.message, /Check your sent offers before trying again/);
  t.equal(mfl.writes("tradeProposal").length, 1);
});

test("2-WAY 8: key present but the key table is unreachable → 503 idempotency_unavailable; no outbox row, no tradeProposal", async () => {
  const { env, mfl } = fresh();
  env.UPS_MFL_DB.opts.beforeRun = (sql) => { if (/ups_trade_idempotency/.test(sql)) throw new Error("D1_ERROR: simulated"); };
  const a = await send(env, proposal({ idempotency_key: KEY }));
  t.equal(a.status, 503, a.text.slice(0, 200)); t.equal(a.json.code, "idempotency_unavailable"); t.doesNotMatch(a.text, /D1_ERROR|simulated/);
  t.equal(mfl.writes("tradeProposal").length, 0); t.equal(outboxRows(env), 0);
  // ...and the same outage does not touch a client that sends no key
  const b = await send(env, proposal());
  t.equal(b.status, 201); t.equal(mfl.writes("tradeProposal").length, 1);
});

test("2-WAY 9: a malformed key is refused (400) before anything is read or sent; an empty one is the same as none", async () => {
  const { env, mfl } = fresh();
  for (const bad of ["short", "has spaces in it!!", 12345678, { x: 1 }]) {
    const r = await send(env, proposal({ idempotency_key: bad }));
    t.equal(r.status, 400); t.equal(r.json.code, "invalid_idempotency_key");
  }
  t.equal(mfl.writes().length, 0);
  const r = await send(env, proposal({ idempotency_key: "" }));
  t.equal(r.status, 201); t.equal(idemRows(env).length, 0);
});

// ───────────────────────────── Part 2 — three-team create ─────────────────────────────
const CREATE_BODY = (over) => ({
  league_id: "74598", season: "2026",
  initiator: { fid: "0008", name: "x" }, team_b: { fid: "0001", name: "L.A. Looks" }, team_c: { fid: "0012", name: "Hawks" },
  movements: [{ from: "0008", to: "0012", asset_tokens: ["P_16614"], cap_k: 0, summary: "MHJ" }, { from: "0012", to: "0001", asset_tokens: ["FP_0012_2027_1"], cap_k: 0, summary: "R1" }, { from: "0001", to: "0008", asset_tokens: ["P_16181"], cap_k: 0, summary: "CB" }],
  ...(over || {}),
});
const SESSIONS = { "tok-A": "0008", "tok-B": "0001", "tok-C": "0012" };
const deps3 = { detectFranchise: async (tok) => (SESSIONS[tok] ? { franchise_id: SESSIONS[tok], franchise_name: "x" } : { error: "HTTP 401" }), commishFids: () => ["0000"], ...goodDeps };
async function create3(env, body) {
  const url = new URL("https://worker.test/api/trades/3way?L=74598&MFL_USER_ID=tok-A");
  const request = new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const p = []; const ctx = { waitUntil: (x) => p.push(x) };
  const resp = await handle3WayHttp({ request, url, path: url.pathname, env, ctx, corsHeaders: {}, defaultLeagueId: "74598", defaultSeason: "2026", browserMflUserId: "tok-A", cookieMflUserId: "", deps: deps3 });
  await Promise.all(p);
  return { status: resp.status, json: await resp.json() };
}
const threeRows = (env) => env.UPS_MFL_DB.raw.prepare("SELECT COUNT(*) AS n FROM ups_3way_trades").get().n;
async function with3Way(fn) {
  const discord = installDiscordRecorder();
  try { await fn(discord); } finally { discord.restore(); }
}

test("3-WAY 1: double create with the same key → ONE row, ONE set of invite DMs; the second call replays the original {ok, id}", () => with3Way(async (discord) => {
  const env = make3WayEnv();
  const a = await create3(env, CREATE_BODY({ idempotency_key: KEY }));
  t.equal(a.status, 201, JSON.stringify(a.json)); t.equal(a.json.idempotent_replay, undefined);
  const b = await create3(env, CREATE_BODY({ idempotency_key: KEY }));
  t.equal(b.status, 201); t.equal(b.json.id, a.json.id); t.equal(b.json.idempotent_replay, true);
  t.equal(threeRows(env), 1);
  t.equal(discord.messages().length, 2, "one invite each to the two partners — not four");
  t.equal(discord.to(DISCORD.B).length, 1); t.equal(discord.to(DISCORD.C).length, 1);
  const row = env.UPS_MFL_DB.raw.prepare("SELECT * FROM ups_trade_idempotency").get();
  t.equal(row.scope, "three_way_create"); t.equal(row.state, "done"); t.equal(row.actor_fid, "0008");
}));

test("3-WAY 2: two concurrent creates with the same key → one row, one set of DMs, one 409 request_in_progress", () => with3Way(async (discord) => {
  const env = make3WayEnv();
  const db = env.UPS_MFL_DB, realPrepare = db.prepare.bind(db);
  let release; const gate = new Promise((r) => { release = r; });
  let reached; const reachedP = new Promise((r) => { reached = r; });
  db.prepare = (sql) => {
    const st = realPrepare(sql);
    if (!/INSERT INTO ups_3way_trades/.test(sql)) return st;
    return { ...st, bind: (...args) => { const w = st.bind(...args); return { ...w, run: async () => { reached(); await gate; return w.run(); } }; } };
  };
  const first = create3(env, CREATE_BODY({ idempotency_key: KEY }));
  await reachedP;                                             // the first create holds the key and is inside its INSERT
  const second = await create3(env, CREATE_BODY({ idempotency_key: KEY }));
  t.equal(second.status, 409); t.equal(second.json.code, "request_in_progress");
  release();
  const a = await first;
  t.equal(a.status, 201, JSON.stringify(a.json));
  t.equal(threeRows(env), 1); t.equal(discord.messages().length, 2);
}));

test("3-WAY 3: a refusal before the INSERT is not cached — the corrected create with the same key goes through", () => with3Way(async () => {
  const env = make3WayEnv();
  const bad = CREATE_BODY({ idempotency_key: KEY }); bad.team_c = { fid: "0001", name: "dup" };
  const r0 = await create3(env, bad);
  t.equal(r0.status, 400); t.equal(r0.json.error, "A 3-way needs three different teams.");
  t.equal(env.UPS_MFL_DB.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='ups_trade_idempotency'").get().n ? env.UPS_MFL_DB.raw.prepare("SELECT COUNT(*) AS n FROM ups_trade_idempotency").get().n : 0, 0);
  const r1 = await create3(env, CREATE_BODY({ idempotency_key: KEY }));
  t.equal(r1.status, 201, JSON.stringify(r1.json)); t.equal(threeRows(env), 1);
}));

test("3-WAY 4: no key → today's behavior (two creates, two rows)", () => with3Way(async (discord) => {
  const env = make3WayEnv();
  const a = await create3(env, CREATE_BODY()), b = await create3(env, CREATE_BODY());
  t.equal(a.status, 201); t.equal(b.status, 201); t.notEqual(a.json.id, b.json.id);
  t.equal(threeRows(env), 2); t.equal(discord.messages().length, 4);
}));

test("3-WAY 5: the same key with different contents → 409 idempotency_key_reused; nothing created", () => with3Way(async (discord) => {
  const env = make3WayEnv();
  await create3(env, CREATE_BODY({ idempotency_key: KEY }));
  const other = CREATE_BODY({ idempotency_key: KEY }); other.movements[2].asset_tokens = ["P_16650"];
  const r = await create3(env, other);
  t.equal(r.status, 409); t.equal(r.json.code, "idempotency_key_reused");
  t.equal(threeRows(env), 1); t.equal(discord.messages().length, 2);
  const reordered = CREATE_BODY({ idempotency_key: KEY }); reordered.movements.reverse();
  const r2 = await create3(env, reordered);
  t.equal(r2.status, 201); t.equal(r2.json.idempotent_replay, true, "movement order is not part of the deal's identity");
}));

test("3-WAY 6: key present but the key table is unreachable → 503 idempotency_unavailable; no row, no DM", () => with3Way(async (discord) => {
  const env = make3WayEnv();
  env.UPS_MFL_DB.opts.beforeRun = (sql) => { if (/ups_trade_idempotency/.test(sql)) throw new Error("D1_ERROR: simulated"); };
  const r = await create3(env, CREATE_BODY({ idempotency_key: KEY }));
  t.equal(r.status, 503); t.equal(r.json.code, "idempotency_unavailable");
  t.equal(threeRows(env), 0); t.equal(discord.messages().length, 0);
}));

// ───────────────────────────── Part 3 — the store ─────────────────────────────
const DAY = 86400000;
test("PURGE: removes only rows created more than 14 days ago; a database without the table is a no-op", async () => {
  const db = makeD1({}); applyMigrations(db, ["0174_ups_trade_idempotency.sql"]);
  const now = Date.parse("2026-10-23T12:00:00Z");
  const ins = db.raw.prepare("INSERT INTO ups_trade_idempotency (league_id, season, scope, actor_fid, idem_key, request_hash, state, created_at_utc, updated_at_utc) VALUES ('74598','2026','two_way_propose','0001',?,'h','done',?,?)");
  for (const [k, ageMs] of [["old-30d", 30 * DAY], ["old-14d1m", 14 * DAY + 60000], ["keep-14d-1m", 14 * DAY - 60000], ["keep-1d", DAY], ["keep-now", 0]]) {
    const at = new Date(now - ageMs).toISOString(); ins.run(k, at, at);
  }
  const r = await purgeTradeIdempotency(db, now);
  t.equal(r.ok, true); t.equal(r.deleted, 2);
  t.deepEqual(db.raw.prepare("SELECT idem_key FROM ups_trade_idempotency ORDER BY idem_key").all().map((x) => x.idem_key), ["keep-14d-1m", "keep-1d", "keep-now"]);
  const empty = makeD1({});
  const r2 = await purgeTradeIdempotency(empty, now);
  t.equal(r2.ok, true); t.equal(r2.deleted, 0);
});

test("PURGE: the DELETE is a range search on the created_at index (never a table scan)", () => {
  const db = makeD1({}); applyMigrations(db, ["0174_ups_trade_idempotency.sql"]);
  const plan = db.raw.prepare("EXPLAIN QUERY PLAN DELETE FROM ups_trade_idempotency WHERE created_at_utc < ?").all("2026-10-09T00:00:00.000Z").map((r) => r.detail).join(" | ");
  t.match(plan, /SEARCH ups_trade_idempotency USING (COVERING )?INDEX idx_ups_trade_idempotency_created \(created_at_utc<\?\)/, plan);
  const pk = db.raw.prepare("EXPLAIN QUERY PLAN SELECT * FROM ups_trade_idempotency WHERE league_id=? AND season=? AND scope=? AND actor_fid=? AND idem_key=?").all("a", "b", "c", "d", "e").map((r) => r.detail).join(" | ");
  t.match(pk, /SEARCH ups_trade_idempotency USING INDEX sqlite_autoindex_ups_trade_idempotency_1/, pk);
});

test("DDL: migration 0174 and the runtime CREATE produce the same table and index", async () => {
  const viaMigration = makeD1({}); applyMigrations(viaMigration, ["0174_ups_trade_idempotency.sql"]);
  const viaRuntime = makeD1({});
  await makeIdempotencyStore(viaRuntime).read({ leagueId: "74598", season: "2026", scope: "two_way_propose", actorFid: "0001", key: KEY });
  const cols = (d) => d.raw.prepare("PRAGMA table_info(ups_trade_idempotency)").all().map((c) => `${c.name}:${c.type}:${c.notnull}:${c.pk}`).join(",");
  t.equal(cols(viaRuntime), cols(viaMigration));
  const idx = (d) => d.raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='ups_trade_idempotency' ORDER BY name").all().map((x) => x.name).join(",");
  t.equal(idx(viaRuntime), idx(viaMigration)); t.match(idx(viaRuntime), /idx_ups_trade_idempotency_created/);
  const mig = fs.readFileSync(new URL("../worker/migrations/0174_ups_trade_idempotency.sql", import.meta.url), "utf8");
  const norm = (x) => x.replace(/\s+/g, " ").trim();
  t.ok(norm(mig).includes(norm(IDEM_DDL)), "the migration carries the runtime DDL verbatim"); t.ok(norm(mig).includes(norm(IDEM_INDEX_DDL)));
});

test("REPLY rules (pure): mismatch beats state; finished → replay; fresh in_progress → in progress; stale → unknown", () => {
  const now = Date.parse("2026-10-23T12:00:00Z");
  const row = (o) => ({ request_hash: "h", state: "in_progress", status_code: null, response_json: null, updated_at_utc: new Date(now - 1000).toISOString(), ...o });
  t.equal(replyForExisting(row({ state: "done", status_code: 201, response_json: '{"ok":true}' }), "other", now).body.code, "idempotency_key_reused");
  const done = replyForExisting(row({ state: "done", status_code: 201, response_json: '{"ok":true,"id":"x"}' }), "h", now);
  t.equal(done.status, 201); t.deepEqual(done.body, { ok: true, id: "x", idempotent_replay: true });
  t.equal(replyForExisting(row({ state: "done", status_code: 201, response_json: "not json" }), "h", now).body.code, "request_outcome_unknown");
  t.equal(replyForExisting(row(), "h", now).body.code, "request_in_progress");
  t.equal(replyForExisting(row({ updated_at_utc: new Date(now - IDEM_STALE_MS).toISOString() }), "h", now).body.code, "request_outcome_unknown");
  t.equal(readIdempotencyKey({}).key, ""); t.equal(readIdempotencyKey({ idempotency_key: KEY }).key, KEY);
});

test("CRON: the hourly cron purges the key table (and only the hourly cron)", () => {
  const src = fs.readFileSync(new URL("../worker/src/index.js", import.meta.url), "utf8");
  const hourly = src.indexOf("// ---------- HOURLY CRON (5 * * * *) ----------");
  const at = src.indexOf("purgeTradeIdempotency(env.UPS_MFL_DB)");
  t.ok(hourly > 0 && at > hourly, "the purge runs inside the hourly section");
  t.equal(src.split("purgeTradeIdempotency(").length - 1, 1, "called exactly once");
});

await run("trade_idempotency");
restoreConsole();
