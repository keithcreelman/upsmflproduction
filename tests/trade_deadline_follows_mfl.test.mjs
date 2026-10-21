// Every owner-facing trade deadline states when MFL actually stops accepting trades (Keith 2026-10-21): the earliest
// "No Trades Allowed" (TRADE) event on MFL's league calendar that has not ended — worker/src/trade_deadline.js — served
// on /api/league-events (phone Home chip, Team Operations, the MFL-page countdown) and used by the Discord reminders.
// Boundaries are pinned to the second (test league 25625, 2026-10-21: accepted inside the start second, refused 1 s after).
//   node tests/trade_deadline_follows_mfl.test.mjs
import { makeD1 } from "./fixtures/d1_sqlite.mjs";
import { t, test, run } from "./fixtures/mini_test.mjs";
await import("./fixtures/register_md_loader.mjs");
const { mflTradeLock, tradeEventWeeks, etParts, parseMflIcsStarts } = await import("../worker/src/trade_deadline.js");
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

// MFL's ICS export for test league 25625 on 2026-10-21 (the TRADE events only, as MFL wrote them).
const ICS_25625 = [
  "BEGIN:VEVENT", "UID:8554892@myfantasyleague.com", "SUMMARY:No Trades Allowed", "DTSTART:19700101T000000", "END:VEVENT",
  "BEGIN:VEVENT", "UID:8458722@myfantasyleague.com", "SUMMARY:No Trades Allowed", "DTSTART:20261124T170000", "END:VEVENT",
  "BEGIN:VEVENT", "UID:8554893@myfantasyleague.com", "SUMMARY:No Trades Allowed", "DTSTART:20261126T010000", "END:VEVENT",
  "BEGIN:VEVENT", "UID:8330110@myfantasyleague.com", "SUMMARY:No Trades Allowed", "DTSTART:20261204T011500", "END:VEVENT",
].join("\r\n");

test("a week-numbered event (START_TIME '12' = MFL's native 'start of Week 12') is placed where MFL's ICS export puts it", () => {
  const ics = parseMflIcsStarts(ICS_25625);
  t.equal(ics["8554893"], WED_8PM, "Week 12 → MFL resolved 2026-11-26T01:00Z = Wed Nov 25 8:00 PM ET");
  t.equal(ics["8330110"], WK13_KICK, "Week 13 → Thu Dec 3 8:15 PM ET");
  const weekOnly = cal([{ id: "8554893", type: "TRADE", start_time: "12" }]);
  t.equal(JSON.stringify(tradeEventWeeks(weekOnly)), "[12]");
  const r = mflTradeLock(weekOnly, { nowUnix: u("2026-10-21T08:00:00-04:00"), icsStarts: ics });
  t.equal(r.state, "upcoming"); t.equal(r.label, "Wed, Nov 25, 8:00 PM ET"); t.equal(r.events[0].nfl_week, 12);
  const test25625 = cal([
    { id: "8330110", type: "TRADE", start_time: "13", end_time: "1799211600" },
    { id: "8458722", type: "TRADE", start_time: String(TUE_NOON) },
    { id: "8554893", type: "TRADE", start_time: "12" },
  ]);
  t.equal(mflTradeLock(test25625, { nowUnix: u("2026-10-21T08:00:00-04:00"), icsStarts: ics }).start_unix, TUE_NOON,
    "adding the Week-12 lock while Tue noon remains leaves Tue noon in force (the earliest)");
  const blind = mflTradeLock(weekOnly, { nowUnix: u("2026-10-21T08:00:00-04:00"), icsStarts: {} });
  t.equal(blind.state, "unresolved"); t.equal(blind.reason, "week_12_start_not_in_mfl_ics");
  t.equal(blind.start_unix, null, "never 1970: a week number is not a timestamp");
});

test("a TRADE event with no start time is inert (MFL accepted it and kept trading open on 2026-10-21)", () => {
  const r = mflTradeLock(cal([{ id: "8554892", type: "TRADE", start_time: "" }, { id: "902", type: "TRADE", start_time: String(WED_8PM) }]),
    { nowUnix: u("2026-10-21T08:00:00-04:00") });
  t.equal(r.state, "upcoming"); t.equal(r.event_id, "902"); t.equal(r.events.find((e) => e.id === "8554892").inert, true);
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
  t.ok(/nm\.label \+ \(etTime\(e\)/.test(HM) && /whenFor\(ctx\.next\) \+ \(etTime\(ctx\.next\)/.test(HM), "Home: calendar row and the Events tile show the time");
  const TO = fs.readFileSync(new URL("../site/team_operations/team_operations.js", import.meta.url), "utf8");
  t.ok(/time: etTimeLabel\(ev\.time_et\)/.test(TO) && /tops-cal-t/.test(TO), "Team Operations: the calendar and 'inside a week' rows show the time");
  const IX = fs.readFileSync(new URL("../worker/src/index.js", import.meta.url), "utf8");
  t.equal((IX.match(/according to your league calendar\/\.test\(respLower\)/g) || []).length, 2,
    "the commissioner trade route names MFL's calendar refusal (verified text) instead of calling it a lockout");
});

test("Rules (the deadlines topic) and the phone/Team Ops calendars read MFL's lock, and say 'passed' from the second MFL refuses", async () => {
  const fs = await import("node:fs");
  const vm = await import("node:vm");
  const RJ = fs.readFileSync(new URL("../site/m/views/rules.js", import.meta.url), "utf8");
  const topics = JSON.parse(fs.readFileSync(new URL("../docs/rulebook_topics.json", import.meta.url), "utf8")).topics;
  const dl = topics.find((x) => x.key === "deadlines");
  t.equal(dl.live_trade_lock, true, "the deadlines topic is marked live");
  const live = (lock, nowMs) => {
    const ctx = vm.createContext({ Date: class extends Date { static now() { return nowMs; } }, JSON, String, Number, parseInt });
    ctx.window = ctx; ctx.UPS_M = { state: { leagueEvents: { trade_lock: lock } } };
    vm.runInContext("var M = window.UPS_M;\n" + RJ.match(/var MON = [\s\S]*?\n  function renderTopic/)[0].replace(/\n  function renderTopic$/, "") + "\nwindow.f = withLiveTradeLock;", ctx);
    return ctx.f(dl);
  };
  const wed = { state: "upcoming", date_et: "2026-11-25", time_et: "20:00", start_unix: WED_8PM };
  const a = live(wed, (WED_8PM - 3600) * 1000);
  t.equal(a.numbers.find((n) => /trade deadline/i.test(n.label)).value, "Wed Nov 25, 8:00 PM ET");
  t.equal(a.timeline.find((e) => /trade deadline/i.test(e.what)).when, "Wed Nov 25");
  t.ok(/^MFL stops accepting trades at 8:00 PM ET\. /.test(a.timeline.find((e) => /trade deadline/i.test(e.what)).detail));
  t.equal(a.table.rows.find((r) => /trade deadline/i.test(r[0]))[1], "Wed Nov 25, 8:00 PM ET (MFL's league calendar)");
  t.equal(live(wed, (WED_8PM + 1) * 1000).numbers.find((n) => /trade deadline/i.test(n.label)).value, "Passed: Wed Nov 25, 8:00 PM ET", "one second after: passed");
  t.equal(live({ state: "unresolved" }, Date.now()).numbers.find((n) => /trade deadline/i.test(n.label)).value,
    dl.numbers.find((n) => /trade deadline/i.test(n.label)).value, "no lock read → the written value");
  const HM = fs.readFileSync(new URL("../site/m/views/home.js", import.meta.url), "utf8");
  t.ok(/if \(t > 0 && Date\.now\(\) \/ 1000 > t\) return "passed";/.test(HM) && /whenFor\(e\)/.test(HM), "Home: passed at MFL's instant");
  const TO = fs.readFileSync(new URL("../site/team_operations/team_operations.js", import.meta.url), "utf8");
  t.ok(/passed: Number\(ev\.start_unix\) > 0 && Date\.now\(\) \/ 1000 > Number\(ev\.start_unix\)/.test(TO), "Team Operations: passed at MFL's instant");
});

await run("trade_deadline_follows_mfl");
