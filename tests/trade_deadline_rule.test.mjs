// The trade deadline RULE (Keith 2026-10-21, revised): "Trading closes at kickoff of the first NFL game in the NFL schedule
// week that includes Thanksgiving Day." 2026: Week 12 opens Wed Nov 25 8:00 PM ET (GB @ LAR). The week, not the day:
// it follows whatever day the NFL gives that week's opener, from the official NFL schedule only, and fails closed until
// the schedule establishes it. The Commish Settings push holds a TRADE event that isn't at the rule's instant.
//   node tests/trade_deadline_rule.test.mjs
import fs from "node:fs";
import { makeD1 } from "./fixtures/d1_sqlite.mjs";
import { t, test, run } from "./fixtures/mini_test.mjs";
await import("./fixtures/register_md_loader.mjs");
const { tradeDeadlineRule, thanksgivingDateEt } = await import("../worker/src/trade_deadline.js");
const worker = (await import("../worker/src/index.js")).default;

const SCHED = JSON.parse(fs.readFileSync(new URL("./fixtures/nfl_schedule_2026_weeks_10_14.json", import.meta.url), "utf8"));
const weeksOf = (sched) => sched.fullNflSchedule.nflSchedule.map((w) => ({ week: Number(w.week), kickoffs: w.matchup.map((m) => Number(m.kickoff)) }));
const W = weeksOf(SCHED);
const WED_8PM = 1795654800, THU_1PM = 1795716000;

test("2026: Week 12 includes Thanksgiving (Thu Nov 26); its first game is Wed Nov 25 8:00 PM ET, GB @ LAR", () => {
  t.equal(thanksgivingDateEt(2026), "2026-11-26");
  const r = tradeDeadlineRule(2026, W);
  t.equal(r.state, "resolved"); t.equal(r.nfl_week, 12); t.equal(r.start_unix, WED_8PM);
  t.equal(r.label, "Wed, Nov 25, 8:00 PM ET");
  const g = SCHED.fullNflSchedule.nflSchedule.find((w) => w.week === "12").matchup.find((m) => Number(m.kickoff) === WED_8PM);
  t.equal(g.team.map((x) => x.id).sort().join(","), "GBP,LAR", "the opener is Green Bay at the Rams");
});

test("the rule follows the WEEK's opener, whatever day it is (not 'Thanksgiving Day', not 'Wednesday')", () => {
  const noWed = W.map((w) => (w.week === 12 ? { ...w, kickoffs: w.kickoffs.filter((k) => k !== WED_8PM) } : w));
  t.equal(tradeDeadlineRule(2026, noWed).start_unix, THU_1PM, "no Wednesday game → the Thursday opener");
  const tue = W.map((w) => (w.week === 12 ? { ...w, kickoffs: [...w.kickoffs, WED_8PM - 86400] } : w));
  t.equal(tradeDeadlineRule(2026, tue).label, "Tue, Nov 24, 8:00 PM ET", "a Tuesday opener → Tuesday");
});

test("fail closed until the official schedule establishes it", () => {
  t.equal(tradeDeadlineRule(2027, []).reason, "nfl_schedule_unavailable", "2027: MFL has no NFL schedule yet");
  t.equal(tradeDeadlineRule(2027, []).start_unix, null);
  const tbd = W.map((w) => (w.week === 12 ? { ...w, kickoffs: [0, ...w.kickoffs] } : w));
  t.equal(tradeDeadlineRule(2026, tbd).reason, "week_12_has_a_game_without_a_kickoff_time");
  t.equal(tradeDeadlineRule(2026, W.filter((w) => w.week !== 12)).reason, "no_nfl_week_includes_thanksgiving");
  const overlap = [...W, { week: 99, kickoffs: [THU_1PM - 3 * 86400, THU_1PM + 86400] }];
  t.equal(tradeDeadlineRule(2026, overlap).reason, "more_than_one_nfl_week_includes_thanksgiving");
  t.equal(thanksgivingDateEt(2027), "2027-11-25"); t.equal(thanksgivingDateEt(2028), "2028-11-23");
});

// ── The worker-owned lock: planTradeLock (pure) and /admin/trade-lock/reconcile against a fake MFL that behaves as the
// test league did on 2026-10-21: import adds an event every time (no de-duplication, no update, no delete); week-based
// events are stored as the week number and placed by MFL's ICS at that week's first kickoff.
const { planTradeLock, mflTradeLock } = await import("../worker/src/trade_deadline.js");
const RULE = tradeDeadlineRule(2026, W);
const TUE = 1795539600;
const absEv = (id, start) => ({ id, event_type: "TRADE", start_unix: start, end_unix: null });
const wkEv = (id, week) => ({ id, event_type: "TRADE", start_unix: week, end_unix: null });

test("plan: production today (Tue noon + Wed 8 PM twice) → add the Week-12 lock AND the commissioner deletes all three", () => {
  const p = planTradeLock({ events: [absEv("901", TUE), absEv("902", WED_8PM), absEv("903", WED_8PM)], rule: RULE, nowUnix: 1792600000 });
  t.equal(p.status, "needs_commissioner_cleanup"); t.equal(p.aligned, false);
  t.equal(JSON.stringify(p.create), JSON.stringify({ EVENT_TYPE: "TRADE", START_TIME: "12" }));
  t.equal(p.remove.map((r) => r.id + ":" + r.why).join(), "901:earlier_than_rule_is_in_force,902:not_the_rule_lock,903:not_the_rule_lock");
  t.equal(p.effective_start_unix, TUE, "until Tue is deleted, Tue noon is what MFL enforces");
});

test("plan: exactly one week-12 lock that MFL places at the rule's kickoff → aligned; duplicates and stale locks are named", () => {
  const ics = { "950": WED_8PM, "951": WED_8PM };
  const ok = planTradeLock({ events: [wkEv("950", 12)], rule: RULE, icsStarts: ics, nowUnix: 1792600000 });
  t.equal(ok.status, "aligned"); t.equal(ok.aligned, true); t.equal(ok.create, null); t.equal(ok.keep.id, "950");
  const dup = planTradeLock({ events: [wkEv("951", 12), wkEv("950", 12)], rule: RULE, icsStarts: ics, nowUnix: 1792600000 });
  t.equal(dup.keep.id, "950", "the oldest is kept"); t.equal(dup.remove.map((r) => r.id + ":" + r.why).join(), "951:duplicate"); t.equal(dup.create, null, "never a third");
  const inert = planTradeLock({ events: [wkEv("950", 12), { id: "8554892", event_type: "TRADE", start_unix: null }, { id: "1", event_type: "TRADE", start_unix: 1790000000, end_unix: 1790000060 }],
    rule: RULE, icsStarts: ics, nowUnix: 1792600000 });
  t.equal(inert.aligned, true, "an inert (start-less) lock and an ended lock don't count"); t.equal(inert.inert.length, 1);
  const moved = planTradeLock({ events: [wkEv("950", 12)], rule: RULE, icsStarts: { "950": WED_8PM + 3600 }, nowUnix: 1792600000 });
  t.equal(moved.status, "mfl_places_week_elsewhere", "MFL's own placement must equal the NFL schedule's kickoff");
  const blind = planTradeLock({ events: [absEv("901", TUE)], rule: tradeDeadlineRule(2027, []), nowUnix: 1792600000 });
  t.equal(blind.status, "waiting_for_nfl_schedule"); t.equal(blind.create, null, "future season: nothing is created until the schedule exists");
});

// Fake MFL (calendar + ICS + import) and fake Discord for the route.
let CAL2 = [], NEXT_ID = 960, IMPORTS2 = [], DMS = [], SCHED_UP2 = true, EXTRA_ON_IMPORT = false;
const icsOf = (evs) => evs.map((e) => {
  const st = Number(e.start_time) <= 30 ? (Number(e.start_time) === 12 ? WED_8PM : 0) : Number(e.start_time);
  const d = new Date(st * 1000).toISOString().replace(/[-:]/g, "").slice(0, 15);
  return `BEGIN:VEVENT\r\nUID:${e.id}@myfantasyleague.com\r\nSUMMARY:No Trades Allowed\r\nDTSTART:${d}\r\nEND:VEVENT`;
}).join("\r\n");
globalThis.fetch = async (input, init) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  const type = u.searchParams.get("TYPE");
  if (/myfantasyleague\.com$/.test(u.hostname) && u.pathname.endsWith("/export")) {
    if (type === "calendar") return new Response(JSON.stringify({ calendar: { event: [{ id: "10", type: "WAIVER_NONE", start_time: "1799200000" }, ...CAL2] } }));
    if (type === "ics") return new Response("BEGIN:VCALENDAR\r\n" + icsOf(CAL2) + "\r\nEND:VCALENDAR");
    if (type === "nflSchedule") return SCHED_UP2 ? new Response(JSON.stringify(SCHED)) : new Response("<html></html>");
    if (type === "myleagues") {   // the /admin front door asks MFL who the session is
      const ck = String((init && init.headers && (init.headers.Cookie || init.headers.cookie)) || "");
      const fid = /COMMISHTOKEN/.test(ck) ? "0008" : /OWNERTOKEN/.test(ck) ? "0003" : "";
      return new Response(JSON.stringify(fid ? { leagues: { league: [{ league_id: "74598", franchise_id: fid }] } } : { error: "not logged in" }), { status: fid ? 200 : 200 });
    }
  }
  if (/myfantasyleague\.com$/.test(u.hostname) && u.pathname.endsWith("/import")) {
    const f = Object.fromEntries(new URLSearchParams(init && init.body || ""));
    IMPORTS2.push(f);
    CAL2.push({ id: String(NEXT_ID++), type: f.EVENT_TYPE, start_time: f.START_TIME || "", end_time: f.END_TIME || "" });   // MFL adds, always
    if (EXTRA_ON_IMPORT) CAL2.push({ id: String(NEXT_ID++), type: "TRADE", start_time: "12", end_time: "" });   // someone else adds one too
    return new Response("<status>OK</status>");
  }
  if (u.hostname === "discord.com") {
    if (/\/users\/@me\/channels$/.test(u.pathname)) return new Response(JSON.stringify({ id: "dm1" }));
    if (/\/channels\/dm1\/messages$/.test(u.pathname)) { DMS.push(JSON.parse(init.body).content); return new Response(JSON.stringify({ id: "m" })); }
  }
  throw new Error("test: unexpected network call " + u.href);
};
function env2(write) {
  const db = makeD1({});
  db.raw.exec("CREATE TABLE ups_bot_heartbeat (bot TEXT PRIMARY KEY, last_ts INTEGER, status TEXT, env TEXT)");
  return { UPS_MFL_DB: db, MFL_COOKIE: "COMMISH", COMMISH_API_KEY: "admin", LEAGUE_ID: "74598", DISCORD_BOT_TOKEN: "bot",
    COMMISH_DISCORD_USER_ID: "621530026831118346", TRADE_LOCK_RECONCILE_WRITE: write ? "1" : "0" };
}
async function reconcile(env, qs, year = "2026", auth = "&APIKEY=admin") {
  const res = await worker.fetch(new Request("https://w.test/admin/trade-lock/reconcile?L=74598&YEAR=" + year + auth + (qs || ""), { method: "POST" }),
    env, { waitUntil() {}, passThroughOnException() {} });
  return { status: res.status, json: await res.json() };
}

test("route: report only reads (no import, no alert); write is refused while TRADE_LOCK_RECONCILE_WRITE is off", async () => {
  CAL2 = [{ id: "901", type: "TRADE", start_time: String(TUE) }, { id: "902", type: "TRADE", start_time: String(WED_8PM) }, { id: "903", type: "TRADE", start_time: String(WED_8PM) }];
  IMPORTS2 = []; DMS = []; SCHED_UP2 = true;
  const r = await reconcile(env2(false));
  t.equal(r.status, 200); t.equal(r.json.plan.status, "needs_commissioner_cleanup"); t.equal(r.json.lock.label, "Tue, Nov 24, 12:00 PM ET");
  t.equal(IMPORTS2.length, 0); t.equal(DMS.length, 0);
  t.equal((await reconcile(env2(false), "&write=1")).status, 409, "write off → refused");
});

test("route: write adds ONE Week-12 lock; a rerun adds nothing; Tue noon stays in force and the commissioner is told what to delete — once", async () => {
  CAL2 = [{ id: "901", type: "TRADE", start_time: String(TUE) }]; IMPORTS2 = []; DMS = [];
  const env = env2(true);
  const a = await reconcile(env, "&write=1&alert=1&confirm=week-12");
  t.equal(IMPORTS2.length, 1); t.equal(IMPORTS2[0].START_TIME, "12"); t.equal(IMPORTS2[0].EVENT_TYPE, "TRADE");
  t.equal(a.json.wrote.ok, true); t.equal(a.json.plan.keep.week, 12);
  t.equal(a.json.wrote.identified, true); t.equal(a.json.wrote.created_id, "960", "the new lock found by diffing the calendar before and after");
  t.equal(a.json.lock.label, "Tue, Nov 24, 12:00 PM ET", "adding Wednesday does not move MFL's deadline while Tuesday remains");
  t.equal(a.json.plan.status, "needs_commissioner_cleanup"); t.equal(a.json.plan.remove.map((x) => x.id).join(), "901");
  t.equal(DMS.length, 1); t.match(DMS[0], /Delete on MFL's League Calendar[^\n]*#901 Tue, Nov 24, 12:00 PM ET \(earlier_than_rule_is_in_force\)/);
  const b = await reconcile(env, "&write=1&alert=1&confirm=week-12");
  t.equal(IMPORTS2.length, 1, "rerun: no second import (the worker reads before it writes)");
  t.equal(b.json.wrote, null); t.equal(DMS.length, 1, "same state → no repeat alert within a day");
});

test("route: after the commissioner deletes the stale lock → aligned at Wed Nov 25 8:00 PM ET, no alert; 2027 waits for the NFL schedule", async () => {
  CAL2 = [{ id: "960", type: "TRADE", start_time: "12", end_time: "" }]; IMPORTS2 = []; DMS = [];
  const r = await reconcile(env2(true), "&write=1&alert=1&confirm=week-12");
  t.equal(r.json.plan.status, "aligned"); t.equal(r.json.lock.label, "Wed, Nov 25, 8:00 PM ET"); t.equal(IMPORTS2.length, 0); t.equal(DMS.length, 0);
  SCHED_UP2 = false; CAL2 = [];
  const f = await reconcile(env2(true), "&alert=1", "2027");
  t.equal(f.json.plan.status, "waiting_for_nfl_schedule"); t.equal(IMPORTS2.length, 0, "no lock invented for 2027"); t.equal(DMS.length, 0);
  SCHED_UP2 = true;
});

test("write protection: commissioner only (an owner's MFL session is refused); explicit confirmation naming the week; one writer at a time", async () => {
  CAL2 = [{ id: "901", type: "TRADE", start_time: String(TUE) }]; IMPORTS2 = []; DMS = []; EXTRA_ON_IMPORT = false;
  t.equal((await reconcile(env2(true), "&write=1&force_write=1&confirm=week-12", "2026", "")).status, 401, "no credential → 401");
  t.equal((await reconcile(env2(true), "&write=1&force_write=1&confirm=week-12", "2026", "&MFL_USER_ID=OWNERTOKEN")).status, 403, "a normal owner (0003) → 403, before any MFL write");
  t.equal(IMPORTS2.length, 0);
  const noConfirm = await reconcile(env2(true), "&write=1");
  t.equal(noConfirm.status, 409); t.equal(noConfirm.json.error, "confirmation_required"); t.equal(noConfirm.json.expected, "week-12");
  t.equal((await reconcile(env2(true), "&write=1&confirm=week-13")).status, 409, "a confirmation for the wrong week is refused");
  t.equal(IMPORTS2.length, 0, "nothing written without the right confirmation");
  const viaSession = await reconcile(env2(true), "&write=1&confirm=week-12", "2026", "&MFL_USER_ID=COMMISHTOKEN");
  t.equal(viaSession.status, 200); t.equal(IMPORTS2.length, 1, "the commissioner's own MFL session may write");
  // A second writer inside 10 minutes (another isolate that hasn't seen the new lock yet) is held, not sent.
  CAL2 = [{ id: "901", type: "TRADE", start_time: String(TUE) }]; IMPORTS2 = [];
  const env = env2(true);
  env.UPS_MFL_DB.raw.prepare("INSERT INTO ups_bot_heartbeat VALUES ('trade_lock_write_2026_74598', ?, 'write', '')").run(Math.floor(Date.now() / 1000) - 60);
  const held = await reconcile(env, "&write=1&confirm=week-12");
  t.equal(IMPORTS2.length, 0); t.equal(held.json.wrote.held, "another_write_within_10_minutes_or_no_claim");
});

test("the created lock must be identified unambiguously; otherwise the result is HELD for review (never guessed)", async () => {
  CAL2 = [{ id: "901", type: "TRADE", start_time: String(TUE) }]; IMPORTS2 = []; DMS = []; EXTRA_ON_IMPORT = true;
  const r = await reconcile(env2(true), "&write=1&alert=1&confirm=week-12");
  EXTRA_ON_IMPORT = false;
  t.equal(IMPORTS2.length, 1); t.equal(r.json.wrote.identified, false); t.equal(r.json.wrote.created_id, null);
  t.equal(r.json.wrote.held, "ambiguous_new_events"); t.equal(r.json.wrote.new_events.length, 2);
  t.equal(DMS.length, 1); t.match(DMS[0], /needs review \(ambiguous_new_events\)/);
  t.equal(r.json.plan.remove.some((x) => x.why === "duplicate"), true, "and the duplicate is named for deletion");
});

test("the Commish Settings push no longer plans or reports TRADE events; the hourly cron runs the reconcile before the reminders", async () => {
  const fsx = await import("node:fs");
  const IX = fsx.readFileSync(new URL("../worker/src/index.js", import.meta.url), "utf8");
  t.ok(/const MANAGED_TYPES = \["DRAFT_START", "AUCTION_START", "WAIVER_NONE"\];/.test(IX), "TRADE is not managed by the push");
  const AC = fsx.readFileSync(new URL("../worker/src/auction_calendar.js", import.meta.url), "utf8");
  t.ok(!/key: "trade_deadline_at"/.test(AC) && !/"TRADE", trade/.test(AC), "no typed trade deadline field, no TRADE push");
  const iRec = IX.indexOf("TRADE_LOCK_RECONCILE_ENABLED || \"0\") === \"1\") {"), iRem = IX.indexOf("deadline-reminder sweep skipped — no COMMISH_API_KEY");
  t.ok(iRec > 0 && iRec < iRem, "the reconcile is awaited before the reminder sweep in the hourly tick");
  const WT = fsx.readFileSync(new URL("../worker/wrangler.toml", import.meta.url), "utf8");
  t.ok(/TRADE_LOCK_RECONCILE_ENABLED = "0"/.test(WT) && /TRADE_LOCK_RECONCILE_WRITE = "0"/.test(WT), "both ship off");
});

await run("trade_deadline_rule");
