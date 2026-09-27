// The five-minute cron, end to end: an FCFS pickup with a BLANK contract is stamped by the TICK itself, and a blank contract that a rule cannot decide
// is an ALERT (a commissioner DM), not a log line.
//   node tests/fcfs_cron.test.mjs
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, runCron, quiet } from "./fixtures/fcfs_worker_harness.mjs";
const restore = quiet();
const CRON = "*/5 * * * *";
const TS = Math.floor(Date.now() / 1000) - 600;
const COMMISH = "100000000000000001";
const DDL = `
CREATE TABLE IF NOT EXISTS ups_add_events (id INTEGER PRIMARY KEY AUTOINCREMENT, season TEXT NOT NULL, league_id TEXT NOT NULL, player_id TEXT NOT NULL, player_name TEXT, position TEXT, nfl_team TEXT,
  franchise_id TEXT NOT NULL, franchise_name TEXT, acquired_at_unix INTEGER NOT NULL, acquired_at_iso TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('bbid','fcfs')), bid_dollars INTEGER, acquisition_week INTEGER,
  contract_annotated INTEGER NOT NULL DEFAULT 0, annotated_at_utc TEXT, pre_annotate_contract_info TEXT, discord_posted INTEGER NOT NULL DEFAULT 0, discord_channel_id TEXT, discord_message_id TEXT,
  raw_transaction_json TEXT, detected_at_utc TEXT NOT NULL, notes TEXT, discord_parent_message_id TEXT, UNIQUE (season, league_id, player_id, franchise_id, acquired_at_unix));
CREATE TABLE IF NOT EXISTS ups_auction_contract_finalizations (player_id TEXT NOT NULL, season TEXT NOT NULL, league_id TEXT NOT NULL, winner_fid TEXT, source TEXT NOT NULL, won_bid_k INTEGER, salary INTEGER,
  contract_year TEXT, contract_status TEXT, contract_info TEXT, finalized_at_unix INTEGER, PRIMARY KEY (player_id, season, league_id, source));
CREATE TABLE IF NOT EXISTS ups_bot_heartbeat (bot TEXT PRIMARY KEY, last_ts INTEGER NOT NULL, status TEXT DEFAULT 'ok', env TEXT DEFAULT '');
`;
function tick(over) {
  const env = makeWorkerEnv({ YEAR: "2026", LEAGUE_ID: "74598", ADD_TRACKER_ENABLED: "1", WW_CONTRACT_STAMP_ENABLED: "1", COMMISH_DISCORD_USER_ID: COMMISH, ...(over || {}) });
  env.UPS_MFL_DB.raw.exec(DDL);
  const mfl = makeMfl(); mfl.install();
  return { env, mfl, db: env.UPS_MFL_DB.raw };
}
const world = (mfl, salary) => {
  mfl.st.rosters = { "0004": [{ id: "16619", salary: salary === "" ? null : Number(salary) }] };
  mfl.st.salaries = [{ id: "16619", salary, contractStatus: "", contractYear: "", contractInfo: "" }];
  mfl.st.transactions = [{ type: "FREE_AGENT", franchise: "0004", timestamp: String(TS), transaction: "16619,|16639," }];
};
const dms = (mfl) => mfl.st.discord.filter((d) => d.body && d.body.content).map((d) => d.body.content);

test("TICK: a blank FCFS pickup is stamped by the five-minute cron itself — canonical contract, verified, no alert; the next tick is quiet", async () => {
  const { env, mfl, db } = tick(); world(mfl, "");
  await runCron(env, CRON);
  t.deepEqual(mfl.st.salaries[0], { id: "16619", salary: "1000", contractStatus: "Vet-WW", contractYear: "1", contractInfo: "CL 1| TCV 1K| AAV 1K" }, "the contract is on MFL after ONE tick");
  t.equal(mfl.writes("salaries").length, 1);
  t.equal(db.prepare("SELECT COUNT(*) n FROM ups_auction_contract_finalizations WHERE source = 'fcfs'").get().n, 1, "audited under the FCFS source");
  t.equal(dms(mfl).filter((m) => /Blank contract needs review|FCFS contract still unresolved/.test(m)).length, 0, "nothing to alert");
  await runCron(env, CRON);
  t.equal(mfl.writes("salaries").length, 1, "the second tick writes nothing"); t.equal(db.prepare("SELECT COUNT(*) n FROM ups_auction_contract_finalizations").get().n, 1, "no duplicate audit row");
});
test("TICK: a blank contract the rule cannot decide (MFL's salary is not $1,000) is an ALERT — a commissioner DM naming the player and why — sent once per batch, not every tick", async () => {
  const { env, mfl, db } = tick(); world(mfl, "5000");
  await runCron(env, CRON);
  t.equal(mfl.writes("salaries").length, 0, "nothing was written");
  const first = dms(mfl).filter((m) => /Blank contract needs review/.test(m));
  t.equal(first.length, 1, "one DM"); t.match(first[0], /16619/); t.match(first[0], /fcfs_salary_not_canonical/); t.match(first[0], /Nothing was written/);
  t.equal(db.prepare("SELECT status FROM ups_bot_heartbeat WHERE bot = 'fcfs_contract_needs_review_alert'").get().status, "16619", "the batch is recorded");
  await runCron(env, CRON); await runCron(env, CRON);
  t.equal(dms(mfl).filter((m) => /Blank contract needs review/.test(m)).length, 1, "the same batch is not re-sent every tick");
});
test("TICK: a write that keeps failing escalates once after ~10 minutes (fcfs_contract_retryable), and clears when the contract lands", async () => {
  const { env, mfl, db } = tick(); world(mfl, "");
  mfl.st.salariesImportIgnored = true;                       // MFL says OK and applies nothing: every tick is retryable
  await runCron(env, CRON);
  t.equal(mfl.st.salaries[0].contractStatus, "", "still blank");
  t.equal(db.prepare("SELECT status FROM ups_bot_heartbeat WHERE bot = 'fcfs_unresolved:16619'").get().status, "retryable", "first seen — a retry is not yet an alert");
  t.equal(dms(mfl).filter((m) => /still unresolved/.test(m)).length, 0);
  db.prepare("UPDATE ups_bot_heartbeat SET last_ts = last_ts - 700 WHERE bot = 'fcfs_unresolved:16619'").run();     // …ten minutes later
  await runCron(env, CRON);
  const esc = dms(mfl).filter((m) => /FCFS contract still unresolved \(fcfs_contract_retryable\)/.test(m)); t.equal(esc.length, 1); t.match(esc[0], /16619/);
  t.equal(db.prepare("SELECT status FROM ups_bot_heartbeat WHERE bot = 'fcfs_unresolved:16619'").get().status, "escalated");
  await runCron(env, CRON); t.equal(dms(mfl).filter((m) => /still unresolved/.test(m)).length, 1, "escalated ONCE");
  mfl.st.salariesImportIgnored = false;                      // MFL recovers
  await runCron(env, CRON);
  t.equal(mfl.st.salaries[0].contractStatus, "Vet-WW"); t.equal(db.prepare("SELECT COUNT(*) n FROM ups_bot_heartbeat WHERE bot = 'fcfs_unresolved:16619'").get().n, 0, "verified ⇒ the marker is cleared");
});

test("TICK: the stamp CALL itself failing is silent by nature — it alerts once after ~15 minutes, at most hourly, and the markers clear on recovery", async () => {
  const { env, mfl, db } = tick(); world(mfl, "");
  mfl.st.exportFail = { salaries: 500 };                     // the salaries export is down: nothing can be stamped
  await runCron(env, CRON);
  t.equal(db.prepare("SELECT status FROM ups_bot_heartbeat WHERE bot = 'ww_stamp_error_first'").get().status, "seen", "first failure is only recorded");
  t.equal(dms(mfl).filter((m) => /FAILING/.test(m)).length, 0, "no alert yet");
  db.prepare("UPDATE ups_bot_heartbeat SET last_ts = last_ts - 1000 WHERE bot = 'ww_stamp_error_first'").run();      // ~17 minutes of failure
  await runCron(env, CRON);
  const a = dms(mfl).filter((m) => /WW \/ FCFS contract stamp is FAILING/.test(m)); t.equal(a.length, 1, "one DM"); t.match(a[0], /Blank contracts are NOT being written/);
  await runCron(env, CRON); t.equal(dms(mfl).filter((m) => /FAILING/.test(m)).length, 1, "not repeated inside the hour");
  mfl.st.exportFail = null;                                  // recovery
  await runCron(env, CRON);
  t.equal(mfl.st.salaries[0].contractStatus, "Vet-WW", "stamped once MFL is back");
  t.equal(db.prepare("SELECT COUNT(*) n FROM ups_bot_heartbeat WHERE bot IN ('ww_stamp_error_first','ww_stamp_error_alerted')").get().n, 0, "the failure markers are cleared");
});
test("TICK: an alert whose DM never landed is NEVER recorded as sent — the next tick sends it (needs-review batch and retry escalation)", async () => {
  const a = tick(); world(a.mfl, "5000"); a.mfl.st.discordFail = true;
  await runCron(a.env, CRON);
  t.equal(a.db.prepare("SELECT COUNT(*) n FROM ups_bot_heartbeat WHERE bot = 'fcfs_contract_needs_review_alert'").get().n, 0, "the batch is not recorded when the DM failed");
  a.mfl.st.discordFail = false; a.mfl.st.discord.length = 0;
  await runCron(a.env, CRON);
  t.equal(dms(a.mfl).filter((m) => /Blank contract needs review/.test(m)).length, 1, "the next tick sends it");
  // the retry escalation
  const b = tick(); world(b.mfl, ""); b.mfl.st.salariesImportIgnored = true;
  await runCron(b.env, CRON);
  b.db.prepare("UPDATE ups_bot_heartbeat SET last_ts = last_ts - 700 WHERE bot = 'fcfs_unresolved:16619'").run();
  b.mfl.st.discordFail = true; await runCron(b.env, CRON);
  t.equal(b.db.prepare("SELECT status FROM ups_bot_heartbeat WHERE bot = 'fcfs_unresolved:16619'").get().status, "retryable", "still retryable — the escalation DM did not land");
  b.mfl.st.discordFail = false; b.mfl.st.discord.length = 0; await runCron(b.env, CRON);
  t.equal(dms(b.mfl).filter((m) => /still unresolved/.test(m)).length, 1, "escalated on the next tick");
  t.equal(b.db.prepare("SELECT status FROM ups_bot_heartbeat WHERE bot = 'fcfs_unresolved:16619'").get().status, "escalated");
});
test("TICK: a retry marker is cleared when the player leaves the loop by ANY route — here he is dropped by hand", async () => {
  const { env, mfl, db } = tick(); world(mfl, ""); mfl.st.salariesImportIgnored = true;
  await runCron(env, CRON);
  t.equal(db.prepare("SELECT COUNT(*) n FROM ups_bot_heartbeat WHERE bot = 'fcfs_unresolved:16619'").get().n, 1, "marker written");
  mfl.st.rosters = { "0004": [] };                            // the player is no longer on the roster
  await runCron(env, CRON);
  t.equal(db.prepare("SELECT COUNT(*) n FROM ups_bot_heartbeat WHERE bot = 'fcfs_unresolved:16619'").get().n, 0, "marker cleared");
});

restore();
await run("fcfs_cron");
