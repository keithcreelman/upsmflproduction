// Every owner-facing trade deadline states when MFL actually stops accepting trades (Keith 2026-10-21): the earliest
// "No Trades Allowed" (TRADE) event on MFL's league calendar that has not ended — worker/src/trade_deadline.js — served
// on /api/league-events (phone Home chip, Team Operations, the MFL-page countdown) and used by the Discord reminders.
// Boundaries are pinned to the second (test league 25625, 2026-10-21: accepted inside the start second, refused 1 s after).
//   node tests/trade_deadline_follows_mfl.test.mjs
import { makeD1 } from "./fixtures/d1_sqlite.mjs";
import { t, test, run } from "./fixtures/mini_test.mjs";
await import("./fixtures/register_md_loader.mjs");
const { mflTradeLock, tradeEventWeeks, etParts } = await import("../worker/src/trade_deadline.js");
const { normalizeMflCalendar } = await import("../worker/src/auction_calendar.js");
const { buildLeagueEvents } = await import("../worker/src/league_events_ladder.js");
const worker = (await import("../worker/src/index.js")).default;

const u = (isoEt) => Math.floor(Date.parse(isoEt) / 1000);
const TUE_NOON = u("2026-11-24T12:00:00-05:00");
const WED_8PM = u("2026-11-25T20:00:00-05:00");
const THU_1PM = u("2026-11-26T13:00:00-05:00");            // CHI @ DET, Thanksgiving Day (not the deadline)
const WK13_KICK = u("2026-12-03T20:15:00-05:00");
const cal = (events) => normalizeMflCalendar({ calendar: { event: events } });
const PROD = cal([                                         // production's MFL calendar, 2026-10-21 (public page)
  { id: "901", type: "TRADE", start_time: String(TUE_NOON) },
  { id: "902", type: "TRADE", start_time: String(WED_8PM) },
  { id: "903", type: "TRADE", start_time: String(WED_8PM) },
  { id: "10", type: "WAIVER_BBID", start_time: String(u("2026-09-10T09:00:00-04:00")), happens: "17" },
]);

test("today's production calendar → Tue, Nov 24, 12:00 PM ET (the earliest of three)", () => {
  const r = mflTradeLock(PROD, { nowUnix: u("2026-10-21T08:00:00-04:00") });
  t.equal(r.state, "upcoming"); t.equal(r.start_unix, TUE_NOON); t.equal(r.event_id, "901");
  t.equal(r.date_et, "2026-11-24"); t.equal(r.time_et, "12:00"); t.equal(r.label, "Tue, Nov 24, 12:00 PM ET");
  t.equal(r.events.length, 3, "all three TRADE events listed; the waiver event ignored");
});

test("the boundary, ±1 s, as MFL enforces it: open through the start second, closed from the next (test league 2026-10-21)", () => {
  t.equal(mflTradeLock(PROD, { nowUnix: TUE_NOON - 1 }).state, "upcoming");
  t.equal(mflTradeLock(PROD, { nowUnix: TUE_NOON }).state, "upcoming", "MFL accepted proposals stamped 07:53:00 for a 07:53:00 start");
  t.equal(mflTradeLock(PROD, { nowUnix: TUE_NOON + 1 }).state, "closed");
  t.equal(mflTradeLock(PROD, { nowUnix: TUE_NOON + 1 }).label, "Tue, Nov 24, 12:00 PM ET", "after the deadline it still names it");
});

test("after production is corrected (one TRADE event at Week 12's first kickoff, GB @ LAR) → Wed, Nov 25, 8:00 PM ET", () => {
  const fixed = cal([{ id: "902", type: "TRADE", start_time: String(WED_8PM) }]);
  const r = mflTradeLock(fixed, { nowUnix: u("2026-10-21T08:00:00-04:00") });
  t.equal(r.label, "Wed, Nov 25, 8:00 PM ET"); t.equal(r.start_unix, 1795654800, "Unix 1795654800");
  t.equal(etParts(1795654800).date_et, "2026-11-25"); t.equal(etParts(1795654800).time_et, "20:00");
  t.ok(THU_1PM > WED_8PM, "Thanksgiving Day's first game is later and is not the deadline");
});

test("a week-numbered event (MFL shows START_TIME 13 at Week 13's first kickoff) is placed there; unreadable → unresolved", () => {
  const test25625 = cal([                                 // the test league's calendar, 2026-10-21
    { id: "8330110", type: "TRADE", start_time: "13", end_time: "1799211600" },
    { id: "8458722", type: "TRADE", start_time: String(TUE_NOON) },
  ]);
  t.equal(JSON.stringify(tradeEventWeeks(test25625)), "[13]");
  const r = mflTradeLock(test25625, { nowUnix: u("2026-10-21T08:00:00-04:00"), weekKickoff: { 13: WK13_KICK } });
  t.equal(r.state, "upcoming"); t.equal(r.start_unix, TUE_NOON, "Tue noon is earlier than Week 13");
  t.equal(r.events.find((e) => e.id === "8330110").start_unix, WK13_KICK, "Week 13 → Thu Dec 3 8:15 PM");
  const blind = mflTradeLock(test25625, { nowUnix: u("2026-10-21T08:00:00-04:00"), weekKickoff: {} });
  t.equal(blind.state, "unresolved"); t.equal(blind.reason, "week_13_kickoff_unreadable");
  t.equal(blind.start_unix, null, "never 1970: a week number is not a timestamp");
});

test("an ended blackout doesn't count; an empty calendar is unresolved; no TRADE event is 'none'", () => {
  const ended = cal([{ id: "1", type: "TRADE", start_time: "1790000000", end_time: "1790003600" }, { id: "2", type: "TRADE", start_time: String(THU_1PM) }]);
  t.equal(mflTradeLock(ended, { nowUnix: 1790003600 }).event_id, "2", "end reached → the next one applies");
  t.equal(mflTradeLock(ended, { nowUnix: 1790003599 }).event_id, "1", "one second before its end it still applies");
  t.equal(mflTradeLock([], {}).state, "unresolved", "empty = what a failed login looks like");
  t.equal(mflTradeLock(cal([{ id: "3", type: "WAIVER_NONE", start_time: "1790000000" }]), {}).state, "none");
});

test("league-events: the trade deadline row is MFL's lock (date, time, label); the typed date rides along as stored_date", async () => {
  const rows = [{ event: "ups_trade_deadline", date: "2026-11-25", nfl_season: "2026", description: "In-season trade deadline" }];
  const kickoffFor = async () => 0;
  const lock = mflTradeLock(PROD, { nowUnix: u("2026-10-21T08:00:00-04:00") });
  const b = await buildLeagueEvents({ rows, season: "2026", from: "all", limit: 50, kickoffFor, tradeLock: lock });
  const td = b.events.find((e) => e.event === "ups_trade_deadline");
  t.equal(td.date, "2026-11-24"); t.equal(td.time_et, "12:00"); t.equal(td.label, "Tue, Nov 24, 12:00 PM ET");
  t.equal(td.date_source, "mfl_calendar"); t.equal(td.stored_date, "2026-11-25");
  const blind = await buildLeagueEvents({ rows, season: "2026", from: "all", limit: 50, kickoffFor, tradeLock: mflTradeLock([], {}) });
  t.equal(blind.events.find((e) => e.event === "ups_trade_deadline").date, null, "unreadable → no date, never the typed Nov 25");
  const legacy = await buildLeagueEvents({ rows, season: "2026", from: "all", limit: 50, kickoffFor });
  t.equal(legacy.events.find((e) => e.event === "ups_trade_deadline").date, "2026-11-25", "callers that pass no lock are unchanged");
});

test("GET /api/league-events end to end: MFL's calendar read with the worker session, the row and trade_lock served", async () => {
  let calendarReads = 0, sentCookie = "";
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (/myfantasyleague\.com$/.test(url.hostname) && url.searchParams.get("TYPE") === "calendar") {
      calendarReads += 1; sentCookie = (init && init.headers && (init.headers.Cookie || init.headers.cookie)) || "";
      return new Response(JSON.stringify({ calendar: { event: [
        { id: "901", type: "TRADE", start_time: String(TUE_NOON) }, { id: "902", type: "TRADE", start_time: String(WED_8PM) }] } }));
    }
    if (/myfantasyleague\.com$/.test(url.hostname) && url.searchParams.get("TYPE") === "nflSchedule") return new Response(JSON.stringify({ nflSchedule: {} }));
    throw new Error("test: unexpected network call " + url.href);
  };
  const db = makeD1({});
  db.raw.exec("CREATE TABLE league_events (event TEXT, date TEXT, nfl_season TEXT, description TEXT)");
  db.raw.prepare("INSERT INTO league_events VALUES ('ups_trade_deadline', '2026-11-25', '2026', 'In-season trade deadline')").run();
  const env = { UPS_MFL_DB: db, MFL_COOKIE: "COOKIEVALUE" };
  const get = async () => {
    const res = await worker.fetch(new Request("https://w.test/api/league-events?season=2026&from=all&limit=50"), env, { waitUntil() {}, passThroughOnException() {} });
    return res.json();
  };
  const j = await get();
  const td = j.events.find((e) => e.event === "ups_trade_deadline");
  t.equal(td && td.date, "2026-11-24"); t.equal(td.time_et, "12:00"); t.equal(td.date_source, "mfl_calendar");
  t.equal(j.trade_lock.label, "Tue, Nov 24, 12:00 PM ET"); t.equal(j.trade_lock.state, "upcoming");
  t.ok(/COOKIEVALUE/.test(sentCookie), "read with the worker's MFL session");
  await get();
  t.equal(calendarReads, 1, "a good read is reused for 5 minutes in the isolate (the phone calls this at boot)");
});

test("owner-facing readers: the MFL-page countdown, the phone Home calendar and Team Operations show MFL's time, never a computed Thanksgiving", async () => {
  const fs = await import("node:fs");
  const W = fs.readFileSync(new URL("../site/ups_options_widget.js", import.meta.url), "utf8");
  t.ok(/\/api\/league-events\?season=/.test(W) && /data && data\.trade_lock/.test(W), "the countdown reads trade_lock from /api/league-events");
  t.ok(!/getThanksgivingDate/.test(W), "no computed Thanksgiving date left in the widget");
  t.ok(/return got && got\.date \? got\.date : null;/.test(W), "no answer → no date (TBD), never a guess");
  t.ok(/When MFL stops accepting trades/.test(W), "the hint says what the time is");
  const HM = fs.readFileSync(new URL("../site/m/views/home.js", import.meta.url), "utf8");
  const etTime = new Function("U", HM.match(/function etTime\(e\) \{[\s\S]*?\n  \}/)[0] + "; return etTime;")({ safeStr: (x) => (x == null ? "" : String(x)) });
  t.equal(etTime({ time_et: "12:00" }), "12:00 PM ET"); t.equal(etTime({ time_et: "13:00" }), "1:00 PM ET"); t.equal(etTime({ time_et: "20:00" }), "8:00 PM ET");
  t.equal(etTime({}), "", "rows without a time are unchanged");
  t.ok(/nm\.label \+ \(etTime\(e\)/.test(HM) && /whenLabel\(ctx\.next\.date\) \+ \(etTime\(ctx\.next\)/.test(HM), "Home: calendar row and the Events tile show the time");
  const TO = fs.readFileSync(new URL("../site/team_operations/team_operations.js", import.meta.url), "utf8");
  t.ok(/time: etTimeLabel\(ev\.time_et\)/.test(TO) && /tops-cal-t/.test(TO), "Team Operations: the calendar and 'inside a week' rows show the time");
  const IX = fs.readFileSync(new URL("../worker/src/index.js", import.meta.url), "utf8");
  t.equal((IX.match(/according to your league calendar\/\.test\(respLower\)/g) || []).length, 2,
    "the commissioner trade route names MFL's calendar refusal (verified text) instead of calling it a lockout");
});

await run("trade_deadline_follows_mfl");
