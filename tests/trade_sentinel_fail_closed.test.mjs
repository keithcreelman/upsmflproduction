// The trade sentinel must never read MFL REFUSING it as "no pending offers".
//   node tests/trade_sentinel_fail_closed.test.mjs
//
// 2026-10-06: the league runs lockout=Yes, and under lockout MFL refuses every
// commissioner FRANCHISE_ID impersonation — including the sentinel's STEP A
// pendingTrades read: "Commissioner can not impersonate another franchise with
// lockout on." STEP A used to fall through to [] on any error, so from
// 2026-07-22 19:05Z every tick saw zero offers, marked its whole mirror 'gone',
// and never recorded another offer (ups_trade_offer_watch: 4 rows, all from the
// hour lockout was off for the 3-way trade). It stamped no heartbeat, so nobody
// knew. Real tick route, stateful fake MFL (tests/fixtures/worker_harness.mjs,
// whose commissioner impersonation honours `lockout` exactly like MFL).
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet, ADMIN_KEY } from "./fixtures/worker_harness.mjs";
import { applyMigrations } from "./fixtures/d1_sqlite.mjs";

const restoreConsole = quiet();

function fresh({ lockout }) {
  const env = makeWorkerEnv({ TRADE_SENTINEL_ENABLED: "1", TRADE_SENTINEL_ACT_ENABLED: "0", YEAR: "2026", LEAGUE_ID: "74598" });
  applyMigrations(env.UPS_MFL_DB, ["0076_trade_offer_dm.sql", "0093_ups_bot_heartbeat.sql", "0102_trade_sentinel.sql"]);
  const mfl = makeMfl();
  mfl.install();
  mfl.st.lockout = lockout;
  // An offer the mirror already holds as pending (from an earlier, sighted tick) …
  env.UPS_MFL_DB.raw.prepare(`INSERT INTO ups_trade_offer_watch (trade_id, league_id, season, from_franchise_id, to_franchise_id, will_give_up, will_receive,
      first_seen_utc, last_seen_utc, origin, lifecycle, anchor_utc, updated_at_utc) VALUES ('1990','74598','2026','0001','0002','14056,','13100,',
      '2026-10-06T10:00:00Z','2026-10-06T10:00:00Z','inapp','pending','2026-10-06T10:00:00Z','2026-10-06T10:00:00Z')`).run();
  // … and two live offers MFL really has.
  mfl.addPending({ offeringteam: "0001", offeredto: "0002", will_give_up: "14056,", will_receive: "13100," });
  mfl.addPending({ offeringteam: "0003", offeredto: "0008", will_give_up: "15000,", will_receive: "16614," });
  return { env, mfl };
}
const tick = (env) => callWorker(env, "POST", `/admin/trade-sentinel/tick?APIKEY=${ADMIN_KEY}`);
const watch = (env) => env.UPS_MFL_DB.raw.prepare("SELECT trade_id, lifecycle FROM ups_trade_offer_watch ORDER BY trade_id").all();
const hb = (env) => env.UPS_MFL_DB.raw.prepare("SELECT status FROM ups_bot_heartbeat WHERE bot='trade_sentinel'").get();

test("lockout ON: blind — stops at the first refusal, keeps the mirror, says so", async () => {
  const { env, mfl } = fresh({ lockout: true });
  const r = await tick(env);
  t.equal(r.status, 200);
  t.equal(r.json.blind, "lockout"); t.equal(r.json.ok, false);
  t.match(r.json.errors[0], /Commissioner can not impersonate another franchise with lockout on/);
  // The harness league lists the commissioner's own franchise (0000) first — that read is not an
  // impersonation and succeeds; 0001 is refused; nothing after it is attempted.
  t.equal(mfl.st.exports.filter((e) => e.type === "pendingTrades").length, 2, "stops at the first refusal — not a failing call per franchise every hour");
  t.equal(JSON.stringify(watch(env)), JSON.stringify([{ trade_id: "1990", lifecycle: "pending" }]),
    "the pending offer is NOT marked gone, and nothing new is invented from a refused read");
  t.equal(hb(env).status, "blind:lockout", "a heartbeat says it is blind instead of staying silent");
  t.equal(mfl.st.imports.length, 0, "no MFL write of any kind");
});

test("lockout OFF: sighted — mirrors MFL's real offers and stamps a healthy heartbeat", async () => {
  const { env } = fresh({ lockout: false });
  const r = await tick(env);
  t.equal(r.status, 200);
  t.ok(!r.json.blind);
  t.equal(r.json.seen, 2);
  const ids = watch(env).map((w) => `${w.trade_id}:${w.lifecycle}`);
  t.ok(ids.includes("2001:pending") && ids.includes("2002:pending"), ids.join(" "));
  t.ok(ids.includes("1990:gone"), "an offer MFL no longer lists is correctly gone — only because every read SUCCEEDED");
  t.match(hb(env).status, /^ok:full:seen=2,gone=1,errors=0$/);
});

test("the switch ships OFF, and Commish Settings' health API reports the sentinel's heartbeat", async () => {
  const fs = await import("node:fs");
  t.match(fs.readFileSync(new URL("../worker/wrangler.toml", import.meta.url), "utf8"), /\nTRADE_SENTINEL_ENABLED = "0"\n/);
  t.match(fs.readFileSync(new URL("../worker/src/index.js", import.meta.url), "utf8"),
    /WHERE bot IN \('auction_poll','trade_roast','cron_cf','fa_report_morning','fa_report_evening','trade_sentinel'\)/);
});

await run("trade_sentinel_fail_closed");
restoreConsole();
