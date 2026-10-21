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

// ── Commish Settings push: the TRADE event goes to MFL only at the rule's instant ──
const unixEt = (iso) => String(Math.floor(Date.parse(iso) / 1000));
let IMPORTS = [], SCHEDULE_UP = true;
const PROD = [
  { id: "901", type: "TRADE", start_time: unixEt("2026-11-24T12:00:00-05:00") },
  { id: "902", type: "TRADE", start_time: unixEt("2026-11-25T20:00:00-05:00") },
  { id: "903", type: "TRADE", start_time: unixEt("2026-11-25T20:00:00-05:00") },
];
let CALENDAR = PROD;
globalThis.fetch = async (input, init) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  const type = u.searchParams.get("TYPE");
  if (/myfantasyleague\.com$/.test(u.hostname) && u.pathname.endsWith("/export")) {
    if (type === "calendar") return new Response(JSON.stringify({ calendar: { event: CALENDAR } }));
    if (type === "nflSchedule") return SCHEDULE_UP ? new Response(JSON.stringify(SCHED)) : new Response("<html>not published</html>", { status: 200 });
  }
  if (/myfantasyleague\.com$/.test(u.hostname) && u.pathname.endsWith("/import")) { IMPORTS.push(Object.fromEntries(u.searchParams)); return new Response("<status>OK</status>"); }
  throw new Error("test: unexpected network call " + u.href);
};
function league(tradeDeadlineAt, season = "2026") {
  const db = makeD1({});
  db.raw.exec("CREATE TABLE ups_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)");
  db.raw.exec("CREATE TABLE league_events (event TEXT, date TEXT, nfl_season TEXT, description TEXT, source TEXT, UNIQUE(event, nfl_season))");
  db.raw.prepare("INSERT INTO ups_settings VALUES ('auction_calendar', ?, '2026-08-06T11:51:58Z')").run(JSON.stringify({
    season, faa: { trade_deadline_at: tradeDeadlineAt } }));
  return { UPS_MFL_DB: db, MFL_COOKIE: "COMMISH", COMMISH_API_KEY: "admin", LEAGUE_ID: "74598" };
}
async function push(env, qs, year = "2026") {
  IMPORTS = [];
  const res = await worker.fetch(new Request("https://w.test/admin/auction/push-mfl-calendar?L=74598&YEAR=" + year + "&APIKEY=admin" + (qs || ""), { method: "POST" }),
    env, { waitUntil() {}, passThroughOnException() {} });
  return { status: res.status, json: await res.json() };
}
const tradeOf = (j) => (j.events || []).find((e) => e.event_type === "TRADE");

test("push dry run: Commish Settings' Wed 11-25 20:00 IS the rule and is already on MFL → nothing new for the trade lock", async () => {
  CALENDAR = PROD; SCHEDULE_UP = true;
  const r = await push(league("2026-11-25T20:00"));
  const tr = tradeOf(r.json);
  t.equal(r.json.dryRun, true);
  t.equal(tr.start_unix, WED_8PM); t.equal(tr.matches_rule, true); t.equal(tr.already_exists, true); t.ok(!tr.held);
  t.equal(tr.trade_rule.label, "Wed, Nov 25, 8:00 PM ET");
  t.ok(r.json.stale.some((s) => s.event_type === "TRADE" && Number(s.start_unix) === Number(PROD[0].start_time)), "the Tue noon event is reported stale (delete it on MFL)");
});

test("push: a typed Thursday 1:00 PM is HELD, not pushed, even on commit; an unpublished schedule holds it too", async () => {
  CALENDAR = [PROD[1]]; SCHEDULE_UP = true;
  const thu = await push(league("2026-11-26T13:00"));
  t.equal(tradeOf(thu.json).matches_rule, false);
  t.match(tradeOf(thu.json).held, /^differs_from_trade_deadline_rule \(rule: Wed, Nov 25, 8:00 PM ET\)/);
  const c = await push(league("2026-11-26T13:00"), "&commit=1");
  t.equal(IMPORTS.filter((i) => i.EVENT_TYPE === "TRADE").length, 0, "no TRADE event sent to MFL");
  t.ok(c.json.mfl.results.some((x) => x.event_type === "TRADE" && x.held), "the push reports the hold");
  CALENDAR = []; SCHEDULE_UP = false;
  const blind = await push(league("2027-11-24T20:00", "2027"), "", "2027");
  t.match(tradeOf(blind.json).held, /^trade_deadline_rule_unresolved \(nfl_schedule_unavailable\)/, "2027 before the NFL schedule exists → held, never a guessed day");
  await push(league("2027-11-24T20:00", "2027"), "&commit=1", "2027");
  t.equal(IMPORTS.filter((i) => i.EVENT_TYPE === "TRADE").length, 0, "…and not pushed on commit");
  SCHEDULE_UP = true; CALENDAR = [];
  const ok = await push(league("2026-11-25T20:00"), "&commit=1");
  t.equal(IMPORTS.filter((i) => i.EVENT_TYPE === "TRADE").map((i) => i.START_TIME).join(), String(WED_8PM), "at the rule's instant it is pushed");
  t.ok(ok.json.mfl.results.some((x) => x.event_type === "TRADE" && x.ok && !x.skipped));
});

await run("trade_deadline_rule");
