// The trade-deadline reminders state when MFL ACTUALLY stops accepting trades (Keith 2026-10-09: "Until resolved,
// owner-facing reminders must accurately state when MFL will actually stop accepting trades").
//   node tests/trade_deadline_reminder_mfl_time.test.mjs
//
// MFL's trade deadline is a calendar event (EVENT_TYPE TRADE, "No Trades Allowed starts at …") with no end, so the
// EARLIEST one is the instant trading stops. Production, read from MFL's public League Calendar on 2026-10-09:
//   Tue 2026-11-24 12:00 PM ET, Wed 2026-11-25 8:00 PM ET, Wed 2026-11-25 8:00 PM ET   → trading stops Tue 11-24 noon.
// The commish calendar (ups_settings) says Wed 11-25 8:00 PM; ESPN's Thanksgiving scoreboard says Thu 11-26 1:00 PM.
// origin/main's reminders read the ESPN scoreboard and announce Thu 11-26 1:00 PM: two days after MFL closes trades.
//
// The REAL /admin/deadline-reminders/run route (what the hourly cron calls) against a fake MFL calendar, a fake GitHub
// contents store for the reminder log, fake Discord and a fake ESPN, on a fake clock. Nothing leaves the process.
import { makeD1 } from "./fixtures/d1_sqlite.mjs";
import { t, test, run } from "./fixtures/mini_test.mjs";
await import("./fixtures/register_md_loader.mjs");
const worker = (await import("../worker/src/index.js")).default;

const RealDate = Date;
let NOW = RealDate.parse("2026-11-17T14:05:00Z");
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
const at = (isoEt) => (NOW = RealDate.parse(isoEt));
const unixEt = (isoEt) => String(Math.floor(RealDate.parse(isoEt) / 1000));

// ── MFL's calendar for 2026, as production holds it (plus the waiver events every sweep also sees) ──
const PROD_TRADE_EVENTS = [
  { id: "901", type: "TRADE", start_time: unixEt("2026-11-24T12:00:00-05:00") },
  { id: "902", type: "TRADE", start_time: unixEt("2026-11-25T20:00:00-05:00") },
  { id: "903", type: "TRADE", start_time: unixEt("2026-11-25T20:00:00-05:00") },
];
const OTHER_EVENTS = [
  { id: "10", type: "WAIVER_BBID", start_time: unixEt("2026-09-10T09:00:00-04:00"), happens: "17" },
  { id: "11", type: "WAIVER_NONE", start_time: unixEt("2027-01-04T21:00:00-05:00") },
];
let CAL = { mode: "ok", trade: PROD_TRADE_EVENTS };   // mode: ok | http500 | login_error | empty
let MFL_CALENDAR_READS = 0;

// ── GitHub contents store for the reminder log (site/…/deadline_reminders_2026.json) ──
const GH = new Map();   // path -> { content (base64), sha }
let GH_SHA = 0;
// ── Discord ──
let POSTS = [];   // { channel, embed }

const json = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  const method = (init?.method || "GET").toUpperCase();
  if (/myfantasyleague\.com$/.test(u.hostname)) {
    const type = u.searchParams.get("TYPE");
    if (type === "calendar") {
      MFL_CALENDAR_READS += 1;
      if (CAL.mode === "http500") return json({ error: "boom" }, 500);
      if (CAL.mode === "login_error") return json({ error: { $t: "API requires logged in user in league ID 74598" } });
      if (CAL.mode === "empty") return json({ calendar: {} });
      return json({ calendar: { event: [...OTHER_EVENTS, ...CAL.trade] } });
    }
    return json({ error: "test: no such export " + type }, 503);
  }
  if (u.hostname === "site.api.espn.com") {
    // what origin/main asked: ESPN's scoreboard for Thanksgiving Day → the first game, Thu 11-26 1:00 PM ET (CHI @ DET)
    return json({ events: [{ id: "401", name: "Chicago Bears at Detroit Lions", date: "2026-11-26T18:00Z" }] });
  }
  if (u.hostname === "api.github.com") {
    const path = decodeURIComponent(u.pathname.replace(/^\/repos\/[^/]+\/[^/]+\/contents\//, ""));
    if (method === "GET") {
      const f = GH.get(path);
      return f ? json({ content: f.content, sha: f.sha }) : json({ message: "Not Found" }, 404);
    }
    if (method === "PUT") {
      const b = JSON.parse(init.body);
      GH.set(path, { content: b.content, sha: "sha" + (++GH_SHA) });
      return json({ content: { sha: "sha" + GH_SHA } });
    }
  }
  if (u.hostname === "discord.com") {
    if (method === "POST" && /\/channels\/(\d+)\/messages$/.test(u.pathname)) {
      const b = JSON.parse(init.body || "{}");
      POSTS.push({ channel: u.pathname.split("/")[4], embed: (b.embeds || [])[0] || {} });
      return json({ id: "msg" + POSTS.length });
    }
    if (/\/users\/@me\/channels$/.test(u.pathname)) return json({ id: "dm1" });
    return json({ id: "x" });
  }
  throw new Error("test: unexpected network call " + method + " " + u.href);
};

// A channel per scenario: the worker paces sends per channel off Date.now(), and the scenarios rewind the fake clock.
let CHANNEL = 555;
function freshLeague() {
  CHANNEL += 1;
  GH.clear(); POSTS = []; MFL_CALENDAR_READS = 0; CAL = { mode: "ok", trade: PROD_TRADE_EVENTS };
  const db = makeD1({});
  db.raw.exec("CREATE TABLE ups_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)");
  // the commish calendar exactly as production stores it (trade_deadline_at = Wed 11-25 8:00 PM)
  db.raw.prepare("INSERT INTO ups_settings (key, value, updated_at) VALUES ('auction_calendar', ?, '2026-08-06T11:51:58Z')").run(JSON.stringify({
    season: "2026",
    faa: { trade_deadline_at: "2026-11-25T20:00", rookie_draft_at: "2026-05-24T13:00", faa_roster_lock_at: "2026-07-23T00:00",
      faa_open_at: "2026-07-25T12:00", rookie_ext_tag_deadline_at: "2026-05-27T23:59", contract_deadline_at: "2026-09-06T23:59" },
  }));
  const env = { UPS_MFL_DB: db, COMMISH_API_KEY: "admin", MFL_COOKIE: "COMMISH", DISCORD_BOT_TOKEN: "bot",
    DISCORD_REMINDER_CHANNEL_ID: String(CHANNEL), GITHUB_PAT: "pat", DISCORD_DM_USER_IDS: "" };
  const sweep = async () => {
    const res = await worker.fetch(new Request("https://w.test/admin/deadline-reminders/run?APIKEY=admin&L=74598&YEAR=2026",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ spacing_seconds: 0 }) }),
      env, { waitUntil() {}, passThroughOnException() {} });
    const text = await res.text();
    let j = null; try { j = JSON.parse(text); } catch (_) {}
    return { status: res.status, json: j, text };
  };
  return { env, sweep };
}
const tradePosts = () => POSTS.filter((p) => /Trade Deadline/.test(p.embed.title || ""));
const text = (embed) => [embed.title, embed.description, ...(embed.fields || []).map((f) => f.name + ": " + f.value)].join("\n");

test("1 week out (Tue 11-17 9:05 AM ET): the reminder says Tuesday, November 24 at 12:00 PM ET — MFL's earliest 'No Trades Allowed'", async () => {
  const L = freshLeague();
  at("2026-11-17T09:05:00-05:00");
  const r = await L.sweep();
  t.equal(r.status, 200, r.text.slice(0, 300));
  t.equal(tradePosts().length, 1);
  const e = tradePosts()[0].embed;
  t.equal(e.title, "Reminder: Trade Deadline in 1 Week");
  t.match(e.description, /^Tuesday, November 24, 2026 at 12:00 PM ET\n/);
  t.match(text(e), /MFL stops accepting trades at this time\. Finish your deals before then\./);
  t.ok(!/Thanksgiving|Thursday|November 26|November 25/.test(text(e)), "neither ESPN's Thursday nor the commish Wednesday: " + text(e));
  t.equal(tradePosts()[0].channel, String(CHANNEL), "the league's reminder channel");
  const res = r.json.trade_deadline_resolution;
  t.equal(res.source, "mfl_calendar"); t.equal(res.fallback_used, false);
  t.deepEqual(res.mfl_trade_events.map((x) => [x.date_et, x.time_et]), [["2026-11-24", "12:00"], ["2026-11-25", "20:00"], ["2026-11-25", "20:00"]], "all three MFL events reported");
  t.equal(r.json.trade_deadline_reminder_withheld, false);
});

test("the 24-hour (Mon 11-23 9:05 AM) and 1-hour (Tue 11-24 11:05 AM) reminders land BEFORE MFL closes trades — and no 'Happy Thanksgiving'", async () => {
  const L = freshLeague();
  at("2026-11-17T09:05:00-05:00"); await L.sweep();
  at("2026-11-23T09:05:00-05:00"); await L.sweep();
  at("2026-11-24T11:05:00-05:00"); await L.sweep();
  t.deepEqual(tradePosts().map((p) => p.embed.title), ["Reminder: Trade Deadline in 1 Week", "Reminder: Trade Deadline in 24 Hours", "Reminder: Trade Deadline in 1 Hour"]);
  t.deepEqual(tradePosts().map((p) => (p.embed.fields || []).find((f) => f.name === "Reminder Time").value),
    ["Tuesday, November 17, 2026 at 9:00 AM ET", "Monday, November 23, 2026 at 9:00 AM ET", "Tuesday, November 24, 2026 at 11:00 AM ET"]);
  t.ok(tradePosts().every((p) => p.embed.description.startsWith("Tuesday, November 24, 2026 at 12:00 PM ET")));
  t.ok(!/Happy Thanksgiving/.test(text(tradePosts()[2].embed)), "the deadline is not Thanksgiving Day");
  at("2026-11-24T12:05:00-05:00"); await L.sweep();
  t.equal(tradePosts().length, 3, "nothing after MFL has closed trades");
});

test("MFL's calendar can't be read (HTTP 500 / login error / empty): NO trade-deadline reminder — never a guessed time; the next readable sweep sends it", async () => {
  for (const mode of ["http500", "login_error", "empty"]) {
    const L = freshLeague();
    CAL.mode = mode;
    at("2026-11-17T09:05:00-05:00");
    const r = await L.sweep();
    t.equal(r.status, 200, mode + ": " + r.text.slice(0, 200));
    t.equal(tradePosts().length, 0, mode + ": withheld");
    t.equal(r.json.trade_deadline_reminder_withheld, true, mode);
    t.equal(r.json.trade_deadline_resolution.fallback_used, true, mode);
    t.ok(!r.json.trade_deadline_resolution.deadline_date_et, mode + ": no date stated");
    CAL.mode = "ok";
    at("2026-11-17T10:05:00-05:00");
    const r2 = await L.sweep();
    t.equal(tradePosts().length, 1, mode + ": sent on the next readable sweep");
    t.match(tradePosts()[0].embed.description, /^Tuesday, November 24, 2026 at 12:00 PM ET/);
    t.equal(r2.json.trade_deadline_reminder_withheld, false);
  }
});

test("a calendar with NO TRADE event: withheld (MFL has no deadline to state) — the commish field is not substituted", async () => {
  const L = freshLeague();
  CAL.trade = [];
  at("2026-11-18T09:05:00-05:00");
  const r = await L.sweep();
  t.equal(tradePosts().length, 0);
  t.equal(r.json.trade_deadline_resolution.upstream_error, "no_trade_event_on_mfl_calendar");
});

test("if the commish removes the Tue noon event on MFL, the reminders follow MFL to Wed 11-25 8:00 PM — no code or config change", async () => {
  const L = freshLeague();
  CAL.trade = PROD_TRADE_EVENTS.slice(1);
  at("2026-11-18T09:05:00-05:00");
  await L.sweep();
  t.equal(tradePosts().length, 1);
  t.match(tradePosts()[0].embed.description, /^Wednesday, November 25, 2026 at 8:00 PM ET/);
});

test("a missed 11:05 tick: the 1-hour reminder is NOT sent at 12:05 — MFL has already closed trades", async () => {
  const L = freshLeague();
  at("2026-11-24T12:05:00-05:00");
  await L.sweep();
  t.equal(tradePosts().length, 0, "no '1 hour left' after the deadline: " + tradePosts().map((p) => p.embed.title).join(", "));
});

test("…and a deadline that really is Thanksgiving Day keeps the 'Happy Thanksgiving.' line on the 1-hour reminder", async () => {
  const L = freshLeague();
  CAL.trade = [{ id: "904", type: "TRADE", start_time: unixEt("2026-11-26T13:00:00-05:00") }];
  at("2026-11-26T12:05:00-05:00");
  await L.sweep();
  t.equal(tradePosts().length, 1);
  t.equal(tradePosts()[0].embed.title, "Reminder: Trade Deadline in 1 Hour");
  t.match(text(tradePosts()[0].embed), /Happy Thanksgiving\./);
});

await run("trade_deadline_reminder_mfl_time");
globalThis.Date = RealDate;
