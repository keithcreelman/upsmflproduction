// POST /admin/drops/post-discord CLAIMS a drop before its card goes to Discord (2026-10-09). The */5 cron, the launchd stand-in
// (scripts/drop_scan_tick.sh) and the manual GitHub workflow can all run it at once; each used to SELECT `discord_posted = 0`, post,
// and only THEN flip the flag — so two overlapping runs both posted the same public drop card. Through the REAL route, against one
// in-memory D1 and a fake Discord that records every card it receives:
//   a. two overlapping runs on one unposted priced drop → exactly ONE card; the loser reports claimed_by_other_run.
//   b. Discord answers with an error → the claim is released, and the next run posts it once.
//   c. a claim that never finalizes (the isolate died after Discord got the card) is never re-posted: listed as in flight, then as
//      STUCK in the response (the cron console.errors stuck_claims); a commissioner settles it by hand.
//   c2. no answer from Discord at all → outcome unknown: held (never re-posted), surfaced at once, and the batch stops.
//   c3. Discord posted but the "posted" write failed → held with its message id, never re-posted on the next tick.
//   e. dry_run claims nothing and writes nothing.
//   f. the manual repost_ids path is unchanged — and never sends Discord a claim marker as a message id to delete.
//   node tests/drop_post_discord_claim.test.mjs
import fs from "node:fs";
import { makeD1 } from "./fixtures/d1_sqlite.mjs";
import { t, test, run } from "./fixtures/mini_test.mjs";
await import("./fixtures/register_md_loader.mjs");
const worker = (await import("../worker/src/index.js")).default;

const RealDate = Date;
let NOW = RealDate.parse("2026-10-27T16:05:00Z");
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
const ET = (iso) => Math.floor(RealDate.parse(iso) / 1000);

// Fake Discord. `posts` = every card Discord RECEIVED (a held, hung or transport-failed request still delivered its card — the worst
// case for a duplicate). `next` = what happens to the next message POST: hold (wait on a gate), hang (never answer), fail (HTTP 500,
// not delivered), throw (delivered, then the connection drops).
const DISCORD = { posts: [], deletes: [], next: null };
const json = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  const method = (init?.method || "GET").toUpperCase();
  if (u.hostname === "discord.com") {
    if (method === "DELETE") { DISCORD.deletes.push(u.pathname); return new Response(null, { status: 204 }); }
    if (method === "POST" && /\/messages$/.test(u.pathname)) {
      const mode = DISCORD.next; DISCORD.next = null;
      if (mode && mode.kind === "fail") return json({ message: "500: Internal Server Error" }, 500);
      DISCORD.posts.push(JSON.parse(init.body || "{}"));
      const id = "msg" + DISCORD.posts.length;
      if (mode && mode.kind === "hold") { mode.onHit(); await mode.gate; }
      if (mode && mode.kind === "hang") { mode.onHit(); await new Promise(() => {}); }
      if (mode && mode.kind === "throw") throw new TypeError("Network connection lost.");
      return json({ id });
    }
    return json({ id: "thr" + RealDate.now() });     // thread create
  }
  if (/myfantasyleague\.com$/.test(u.hostname)) {
    if (u.searchParams.get("TYPE") === "league") return json({ league: { franchises: { franchise: [{ id: "0008", name: "Real Deal Creel" }, { id: "0010", name: "Blake Bombers" }] } } });
    return json({ error: "test: no such export" }, 503);
  }
  return json({ error: "test: no such call " + u.hostname }, 503);
};

function makeDb() {
  const db = makeD1({});
  db.raw.exec(`CREATE TABLE ups_drop_events (id INTEGER PRIMARY KEY AUTOINCREMENT, season TEXT, league_id TEXT, player_id TEXT, player_name TEXT, position TEXT, nfl_team TEXT,
    franchise_id TEXT, franchise_name TEXT, dropped_at_unix INTEGER, dropped_at_iso TEXT, pre_drop_contract_status TEXT, pre_drop_salary INTEGER, pre_drop_contract_year INTEGER,
    pre_drop_contract_length INTEGER, pre_drop_contract_info TEXT, pre_drop_tcv INTEGER, pre_drop_aav INTEGER, pre_drop_years_remaining INTEGER, pre_drop_taxi INTEGER,
    earned_to_date INTEGER, guaranteed_amount INTEGER, penalty_amount INTEGER, penalty_basis TEXT, penalty_exempt INTEGER, penalty_exempt_reason TEXT, ledger_key TEXT UNIQUE,
    posted_to_mfl INTEGER DEFAULT 0, posted_at_utc TEXT, posted_amount INTEGER, posted_explanation TEXT, source TEXT, detected_at_utc TEXT, raw_transaction_json TEXT,
    snapshot_source TEXT, discord_posted INTEGER DEFAULT 0, discord_channel_id TEXT, discord_message_id TEXT, notes TEXT,
    UNIQUE (season, league_id, player_id, dropped_at_unix))`);
  return db;
}
// Two priced, unposted drops (the recorder's own numbers): Shipley $5,712, and an auction contract's $5,000.
const DROPS = {
  "16601": ["Will Shipley", "RB", "PHI", "0008", "Real Deal Creel", "2026-10-27T12:00:00-04:00", "Vet-WW", 11000, "CL 1| TCV 11K| AAV 11K", 2538, 8250, 5712],
  "18002": ["Steady Auction", "TE", "DAL", "0010", "Blake Bombers", "2026-10-27T12:30:00-04:00", "Vet-FAA", 16000, "CL 1| TCV 16K| AAV 16K", 7000, 12000, 5000],
};
function seed(db, ...pids) {
  for (const pid of pids) {
    const [name, pos, team, fid, fname, iso, status, sal, info, earned, gtd, pen] = DROPS[pid];
    db.raw.prepare(`INSERT INTO ups_drop_events (season, league_id, player_id, player_name, position, nfl_team, franchise_id, franchise_name, dropped_at_unix, dropped_at_iso,
        pre_drop_contract_status, pre_drop_salary, pre_drop_contract_year, pre_drop_contract_length, pre_drop_contract_info, pre_drop_tcv, earned_to_date, guaranteed_amount,
        penalty_amount, penalty_basis, penalty_exempt, ledger_key, source, detected_at_utc, discord_posted)
      VALUES ('2026', '74598', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, 'guarantee_minus_earned', 0, ?, 'transactions_poll', ?, 0)`)
      .run(pid, name, pos, team, fid, fname, ET(iso), new RealDate(RealDate.parse(iso)).toISOString(), status, sal, info, sal, earned, gtd, pen, `${pid}_${ET(iso)}`, new RealDate(NOW).toISOString());
  }
}
const makeEnv = (d) => ({ UPS_MFL_DB: d, COMMISH_API_KEY: "admin", MFL_COOKIE: "COMMISH", MFL_APIKEY: "k",
  FA_AUCTION_START_AT: String(ET("2026-07-25T12:00:00-04:00")), DISCORD_BOT_TOKEN: "bot", DISCORD_DROPS_TEST_CHANNEL_ID: "999" });
async function call(env, body) {
  const res = await worker.fetch(new Request("https://w.test/admin/drops/post-discord?L=74598&YEAR=2026&APIKEY=admin",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ season: "2026", league_id: "74598", target: "test", limit: 20, ...(body || {}) }) }),
    env, { waitUntil() {}, passThroughOnException() {} });
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch (_) {}
  return { status: res.status, json: j, text };
}
const rowOf = (db, pid) => ({ ...db.raw.prepare("SELECT * FROM ups_drop_events WHERE player_id = ?").get(pid) });
const writes = (db, from) => db.log.slice(from).filter((x) => /^\s*(UPDATE|INSERT|DELETE)/i.test(x.sql));
// Hold ONE D1 statement (matching `re`) of the env it is given until `gate` resolves; `onHit` fires when it is reached. A statement
// can be made to throw instead (`fail`) — D1 refusing the write.
function gated(db, re, { onHit, gate, fail } = {}) {
  return { ...db, prepare(sql) {
    const st = db.prepare(sql);
    if (!re.test(sql)) return st;
    return { ...st, bind: (...a) => { const w = st.bind(...a); return { ...w, run: async () => {
      if (onHit) onHit();
      if (gate) await gate;
      if (fail) throw new Error("D1_ERROR: simulated write failure");
      return w.run();
    } }; } };
  } };
}
const CLAIM_SQL = /UPDATE ups_drop_events\s+SET discord_posted = 2\b/;
const FINALIZE_SQL = /UPDATE ups_drop_events\s+SET discord_posted = 1,/;

// ═════════ a. overlapping runs ═════════
test("a. two overlapping runs on one unposted priced drop → exactly ONE Discord card; the loser reports claimed_by_other_run", async () => {
  const db = makeDb(); seed(db, "16601"); const env = makeEnv(db);
  NOW = RealDate.parse("2026-10-27T16:05:00Z");
  const n0 = DISCORD.posts.length;
  // Run A has SELECTed the row and is held at whichever it reaches first: its claim, or (origin/main, which has no claim) its post.
  // Run B — the */5 cron, say, while a manual run is mid-flight — then runs start to finish.
  let hitRes; const hit = new Promise((r) => (hitRes = r));
  let release; const gate = new Promise((r) => (release = r));
  DISCORD.next = { kind: "hold", gate, onHit: () => hitRes("discord") };
  const envA = { ...env, UPS_MFL_DB: gated(db, CLAIM_SQL, { gate, onHit: () => { DISCORD.next = null; hitRes("claim"); } }) };
  const pA = call(envA);
  const heldAt = await hit;
  const b = await call(env);
  release();
  const a = await pA;
  t.equal(DISCORD.posts.length - n0, 1, `exactly ONE drop card reached the league channel (got ${DISCORD.posts.length - n0})`);
  t.equal(heldAt, "claim", "run A was stopped at its CLAIM — before it ever called Discord");
  t.equal(b.json.posted_count, 1, b.text.slice(0, 300));
  t.equal(a.json.posted_count, 0, a.text.slice(0, 300));
  t.equal(a.json.ok, true, "losing the race is not a failure");
  t.equal(a.json.claimed_by_other_run_count, 1);
  t.deepEqual(a.json.results.map((r) => [r.player_id, r.skipped]), [["16601", "claimed_by_other_run"]]);
  const r = rowOf(db, "16601");
  t.equal(r.discord_posted, 1); t.equal(r.discord_message_id, b.json.results[0].message_id); t.equal(r.discord_channel_id, "999");
  t.equal((await call(env)).json.posted_count, 0, "and never again"); t.equal(DISCORD.posts.length - n0, 1);
});

// ═════════ b. Discord says no ═════════
test("b. Discord answers HTTP 500 → the claim is RELEASED (row back to unposted, ids restored); the next run posts it ONCE", async () => {
  const db = makeDb(); seed(db, "16601"); const env = makeEnv(db);
  const n0 = DISCORD.posts.length, l0 = db.log.length;
  DISCORD.next = { kind: "fail" };
  const d1 = await call(env);
  t.equal(d1.json.ok, false); t.equal(d1.json.posted_count, 0); t.equal(d1.json.failed_count, 1);
  t.match(d1.json.results[0].error, /500/);
  t.deepEqual(d1.json.stuck_claims, [], "a refused post is not a stuck claim");
  const w = writes(db, l0).map((x) => x.sql);
  t.ok(w.some((s) => CLAIM_SQL.test(s)), "the row WAS claimed before Discord was called");
  t.ok(w.some((s) => /SET discord_posted = 0,/.test(s)), "…and released after Discord refused");
  const r = rowOf(db, "16601");
  t.equal(r.discord_posted, 0); t.equal(r.discord_message_id, null); t.equal(r.discord_channel_id, null);
  t.equal(DISCORD.posts.length - n0, 0, "nothing was delivered");
  const d2 = await call(env);
  t.equal(d2.json.posted_count, 1, d2.text.slice(0, 300));
  t.equal(DISCORD.posts.length - n0, 1);
  t.equal(rowOf(db, "16601").discord_posted, 1); t.equal(rowOf(db, "16601").discord_message_id, d2.json.results[0].message_id);
});

// ═════════ c. the isolate died after claiming ═════════
test("c. a claim that never finalizes (Discord HAS the card) is never re-posted: in flight, then STUCK — surfaced in the response and the cron log", async () => {
  const db = makeDb(); seed(db, "16601"); const env = makeEnv(db);
  NOW = RealDate.parse("2026-10-27T16:05:00Z");
  const n0 = DISCORD.posts.length;
  let hitRes; const hit = new Promise((r) => (hitRes = r));
  DISCORD.next = { kind: "hang", onHit: () => hitRes() };
  call(env);                                           // never resolves: the isolate "died" with the card already in the channel
  await hit;
  t.equal(DISCORD.posts.length - n0, 1);
  t.equal(rowOf(db, "16601").discord_posted, 2, "claimed"); t.match(rowOf(db, "16601").discord_message_id, /^claim:/);
  // 1 minute later: a live run may still own it — reported as in flight, not posted, not an alarm
  NOW = RealDate.parse("2026-10-27T16:06:00Z");
  const d1 = await call(env);
  t.equal(d1.json.posted_count, 0); t.equal(DISCORD.posts.length - n0, 1, "not re-posted");
  t.deepEqual(d1.json.in_flight_claims.map((c) => c.player_id), ["16601"]); t.deepEqual(d1.json.stuck_claims, []);
  // 20 minutes later: no run can still own it — STUCK, every run, until a commissioner settles it. Still never re-posted.
  NOW = RealDate.parse("2026-10-27T16:25:00Z");
  for (let i = 0; i < 2; i++) {
    const d = await call(env);
    t.equal(d.json.posted_count, 0); t.equal(d.json.stuck_claim_count, 1);
    const s = d.json.stuck_claims[0];
    t.deepEqual([s.player_id, s.reason, s.channel_id, s.claimed_at], ["16601", "claim_never_finalized", "999", "2026-10-27T16:05:00.000Z"]);
    t.equal(s.age_sec, 20 * 60);
    t.match(d.json.stuck_claims_note, /NOT re-posted/);
  }
  t.equal(DISCORD.posts.length - n0, 1, "still exactly one card"); t.equal(rowOf(db, "16601").discord_posted, 2);
  t.deepEqual(DISCORD.deletes, [], "no Discord message is ever deleted");
  // the */5 cron console.errors every stuck claim, every tick
  const src = fs.readFileSync(new URL("../worker/src/index.js", import.meta.url), "utf8");
  t.match(src, /const stuckClaims = Array\.isArray\(postData\?\.stuck_claims\) \? postData\.stuck_claims : \[\];\s*if \(stuckClaims\.length\) \{\s*console\.error\(\s*`\[scheduled \*\/5\] drop-tracker: \$\{stuckClaims\.length\} drop card\(s\) CLAIMED but never confirmed posted/);
  // a commissioner finds the card in the channel and records it: the alarm stops, nothing posts
  db.raw.prepare("UPDATE ups_drop_events SET discord_posted = 1, discord_message_id = 'msg-found' WHERE player_id = '16601'").run();
  const d3 = await call(env);
  t.deepEqual(d3.json.stuck_claims, []); t.equal(d3.json.posted_count, 0); t.equal(DISCORD.posts.length - n0, 1);
});

test("c1. …and when the card is NOT in the channel, the commissioner sets discord_posted = 0 and the next run posts it once", async () => {
  const db = makeDb(); seed(db, "16601"); const env = makeEnv(db);
  NOW = RealDate.parse("2026-10-27T16:05:00Z");
  db.raw.prepare("UPDATE ups_drop_events SET discord_posted = 2, discord_channel_id = '999', discord_message_id = 'claim:dead@2026-10-27T15:00:00.000Z' WHERE player_id = '16601'").run();
  const d0 = await call(env);
  t.equal(d0.json.stuck_claims[0].reason, "claim_never_finalized"); t.equal(d0.json.stuck_claims[0].age_sec, 65 * 60);
  // a hand-set claim with no readable marker is stuck too (its age is unknown, so it is never treated as in flight)
  db.raw.prepare("UPDATE ups_drop_events SET discord_message_id = NULL WHERE player_id = '16601'").run();
  t.equal((await call(env)).json.stuck_claims[0].age_sec, null);
  const n0 = DISCORD.posts.length;
  db.raw.prepare("UPDATE ups_drop_events SET discord_posted = 0 WHERE player_id = '16601'").run();
  const d = await call(env);
  t.equal(d.json.posted_count, 1); t.equal(DISCORD.posts.length - n0, 1); t.equal(rowOf(db, "16601").discord_posted, 1);
});

test("c2. NO answer from Discord (connection lost mid-post) → outcome unknown: held, surfaced at once, batch stops; never re-posted", async () => {
  const db = makeDb(); seed(db, "16601", "18002"); const env = makeEnv(db);
  NOW = RealDate.parse("2026-10-27T17:00:00Z");
  const n0 = DISCORD.posts.length;
  DISCORD.next = { kind: "throw" };
  const d1 = await call(env);
  t.equal(d1.json.ok, false);
  t.deepEqual(d1.json.results.map((r) => [r.player_id, r.ok, r.reason]), [["16601", false, "post_outcome_unknown"]], "the second drop is not even claimed");
  t.deepEqual(d1.json.stuck_claims.map((s) => [s.player_id, s.reason]), [["16601", "post_outcome_unknown"]]);
  t.equal(rowOf(db, "16601").discord_posted, 2, "held"); t.equal(rowOf(db, "18002").discord_posted, 0); t.equal(rowOf(db, "18002").discord_message_id, null);
  NOW = RealDate.parse("2026-10-27T17:05:00Z");
  const d2 = await call(env);
  t.deepEqual(d2.json.results.map((r) => [r.player_id, r.ok]), [["18002", true]], "the next tick posts the OTHER drop only");
  t.equal(DISCORD.posts.length - n0, 2, "one card each");
  t.match(JSON.stringify(DISCORD.posts.slice(n0)), /Drop: Will Shipley[\s\S]*Drop: Steady Auction/);
});

test("c3. Discord posted but the 'posted' write FAILED → held with its message id (one SQL to settle), never re-posted next tick", async () => {
  const db = makeDb(); seed(db, "16601"); const env = makeEnv(db);
  NOW = RealDate.parse("2026-10-27T18:00:00Z");
  const n0 = DISCORD.posts.length;
  const d1 = await call({ ...env, UPS_MFL_DB: gated(db, FINALIZE_SQL, { fail: true }) });
  t.equal(DISCORD.posts.length - n0, 1);
  t.equal(d1.json.ok, false, "a manual caller sees it"); t.equal(d1.json.posted_count, 1, "the card IS out");
  t.equal(d1.json.results[0].recorded, false);
  t.deepEqual(d1.json.stuck_claims.map((s) => [s.player_id, s.reason, s.message_id]), [["16601", "posted_not_recorded", d1.json.results[0].message_id]]);
  NOW = RealDate.parse("2026-10-27T18:05:00Z");
  const d2 = await call(env);
  t.equal(d2.json.posted_count, 0); t.equal(DISCORD.posts.length - n0, 1, "NOT posted a second time (origin/main re-posted it every tick)");
});

// ═════════ e / f. dry run, manual repost ═════════
test("e. dry_run claims nothing and writes nothing; the real run afterwards posts once", async () => {
  const db = makeDb(); seed(db, "16601"); const env = makeEnv(db);
  const n0 = DISCORD.posts.length, l0 = db.log.length;
  const before = rowOf(db, "16601");
  const d = await call(env, { dry_run: true });
  t.equal(d.json.dry_run, true); t.equal(d.json.posted_count, 1, "would post one");
  t.deepEqual(writes(db, l0), [], "no D1 write of any kind"); t.equal(DISCORD.posts.length - n0, 0);
  t.deepEqual(rowOf(db, "16601"), before);
  t.equal((await call(env)).json.posted_count, 1); t.equal(DISCORD.posts.length - n0, 1);
});

test("f. repost_ids (manual correction) is unchanged: corrected + silent, old message replaced, row re-recorded — no claim; a claim marker is never DELETEd", async () => {
  const db = makeDb(); seed(db, "16601"); const env = makeEnv(db);
  const first = await call(env);
  const id = rowOf(db, "16601").id, oldMsg = first.json.results[0].message_id;
  const n0 = DISCORD.posts.length, d0 = DISCORD.deletes.length, l0 = db.log.length;
  const d = await call(env, { repost_ids: [id] });
  t.equal(d.json.posted_count, 1);
  t.match(JSON.stringify(DISCORD.posts.at(-1)), /Corrected/); t.equal(DISCORD.posts.at(-1).flags, 4096);
  t.deepEqual(DISCORD.deletes.slice(d0), [`/api/v10/channels/999/messages/${oldMsg}`], "the old card is replaced, as before");
  t.ok(!writes(db, l0).some((x) => CLAIM_SQL.test(x.sql)), "the manual path takes no claim");
  t.equal(rowOf(db, "16601").discord_message_id, d.json.results[0].message_id); t.equal(DISCORD.posts.length - n0, 1);
  // repost of a STUCK claim: there is no real message id to delete — the marker is not one
  db.raw.prepare("UPDATE ups_drop_events SET discord_posted = 2, discord_message_id = 'claim:dead@2026-10-27T15:00:00.000Z' WHERE id = ?").run(id);
  const d1 = DISCORD.deletes.length;
  await call(env, { repost_ids: [id] });
  t.deepEqual(DISCORD.deletes.slice(d1), []);
  t.equal(rowOf(db, "16601").discord_posted, 1);
});

await run("drop_post_discord_claim");

globalThis.Date = RealDate;
