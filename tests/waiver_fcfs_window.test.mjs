// Sunday FCFS: the app and the worker use the SAME verified window.
//   node tests/waiver_fcfs_window.test.mjs
//   WORKER_JS=<another worker index.js> APP_JS=<…> PLAYERS_JS=<…> (defect check)
//
// Keith 2026-10-03: "Owners should be able to use Add now in the app during the
// same window that MFL permits immediate free-agent additions." In season the
// app read blind-bid mode all week — the worker read only the FIRST row of each
// recurring MFL calendar series — so Sunday showed "Bid" and the worker refused
// an in-app add with 409 not_fcfs_window, while every 2026 FCFS add went
// through MFL directly (9 adds, all Sundays 9:24–11:07 AM ET).
//
// Verified window (league calendar rows + MFL transaction behavior):
//   opens  Sunday 9:00 AM ET, at the blind-bid run (from NFL Week 1)
//   closes Monday 9:00 PM ET, the weekly WAIVER_LOCK (×17, Sep 14 → Jan 4)
//   inside it, a player locks at HIS game's kickoff (league lockout = Yes)
//   season shut-off: open-ended WAIVER_NONE Mon Jan 4 2027 9:00 PM ET
//
// Chain under test, all shipped code: the worker's _wvWaiverWindow over the
// real 2026 calendar rows → app.js waiverMode → players.js row button, with
// lineup.js isKickedOff deciding the per-player lock. Nothing writes: every
// write path is stubbed to record itself and refuse.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.isAbsolute(p) ? p : path.join(ROOT, p), "utf8");
const WORKER = read(process.env.WORKER_JS || "worker/src/index.js");
const APP = read(process.env.APP_JS || "site/m/app.js");
const PLAYERS_JS = process.env.PLAYERS_JS || "site/m/views/players.js";
const LINEUP = read("site/m/views/lineup.js");

function sliceFn(src, sig, openAt) {
  const at = src.indexOf(sig);
  if (at < 0) throw new Error("not found: " + sig);
  let i = openAt != null ? at + openAt : src.indexOf("{", at), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error("unbalanced: " + sig);
}
const et = (iso) => Math.floor(Date.parse(iso) / 1000);

// Worker window + the league calendar's real 2026 rows (repeat counts intact).
const windowFn = (() => {
  const WIN = "const _wvWaiverWindow = (calendarRows, nowUnix, opts = {}) => {";
  const a = WORKER.indexOf("const _WV_LEAGUE_BBID_WEEKDAYS"), b = WORKER.indexOf("// Bid floor / step / round cap read LIVE from MFL.");
  const body = sliceFn(WORKER, "const _wvIsSundayEt = (unixSec) => {") + ";\n" + sliceFn(WORKER, "const _wvEtLabel = (unixSec) => {") + ";\n" +
    (a !== -1 && b !== -1 ? WORKER.slice(a, b) : "") + "\n" + sliceFn(WORKER, WIN, WIN.length - 1) + ";\nreturn _wvWaiverWindow;";
  return new Function("safeStr", body)((v) => (v == null ? "" : String(v)));
})();
const RAW_2026 = [
  ["WAIVER_NONE", 1784779200, 1785902400, 0], ["WAIVER_LOCK", 1785902400, null, 0], ["WAIVER_LOCK", 1786021200, null, 22],
  ["WAIVER_LOCK", 1786107600, null, 22], ["WAIVER_BBID", 1786107600, null, 22], ["WAIVER_LOCK", 1786194000, null, 22],
  ["WAIVER_BBID", 1786194000, null, 22], ["WAIVER_LOCK", 1786280400, null, 4], ["WAIVER_BBID", 1786280400, null, 22],
  ["WAIVER_BBID", 1786626000, null, 21], ["WAIVER_LOCK", 1789434000, null, 17], ["WAIVER_NONE", 1799114400, null, 0],
].map(([event_type, start_unix, end_unix, happens]) => ({ event_type, start_unix, end_unix, happens }));
const WEEK1 = et("2026-09-09T20:20:00-04:00");
function waiverStateAt(now) {
  const w = windowFn(RAW_2026, now, { calendar_unavailable: false, waiver_type: "BBID_FCFS", week1_kickoff_unix: WEEK1 });
  return { ok: true, mode: w.mode, write_enabled: true, write_enabled_source: "flag",
    window: { mode: w.mode, mode_reason: w.mode_reason, blackout: w.blackout, next_bbid_run_unix: w.next_bbid_run_unix,
      next_bbid_run_label: w.next_bbid_run_label, fcfs_closes_unix: w.fcfs_closes_unix, fcfs_closes_label: w.fcfs_closes_label },
    limits: { known: true, min: 1000, step: 1000, max_rounds: 8, conditional: true },
    last_run: { known: true, unix: w.last_bbid_run_unix, label: w.last_bbid_run_label } };
}

// Week 4 2026 kickoffs (MFL nflSchedule, read 2026-10-02): IND @ WAS London Sun 9:30 AM ET,
// TBB home Sun 1:00 PM ET, PIT @ CLE Thu 8:15 PM ET. KCC = no game this week.
const KICKOFFS_WK4 = { IND: 1791120600, WAS: 1791120600, TBB: 1791133200, GBP: 1791133200, PIT: 1790900100, CLE: 1790900100 };
const KICKOFFS_WK8 = { TBB: et("2026-11-01T13:00:00-05:00"), IND: et("2026-11-01T13:00:00-05:00") };

function harness(now, { kickoffs = KICKOFFS_WK4, kickoffsLoaded = true } = {}) {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, Promise, JSON });
  ctx.window = ctx;
  const util = ["function safeStr(", "function safeInt(", "function pad4(", "function escapeHtml(", "function fmtUsd(", "function asArray("]
    .map((f) => sliceFn(APP, f)).join("\n");
  vm.runInContext(util + "\nthis.__util = { safeStr, safeInt, pad4, escapeHtml, fmtUsd, asArray };", ctx);
  // app.js's own waiverMode, over the worker's window at `now`.
  ctx.state = { waiverState: waiverStateAt(now), ctx: { year: "2026", leagueId: "74598" } };
  const months = APP.match(/var WAIVER_MONTHS = \[[^\]]*\];/)[0];
  vm.runInContext(months + "\n" + ["function waiverWriteEnabled(", "function waiverStateKnown(", "function waiverNativeLink(", "function waiverWhen(",
    "function waiverMode("].map((f) => sliceFn(APP, f)).join("\n") + "\nthis.__waiverMode = waiverMode;", ctx);
  // lineup.js's own isKickedOff, on a clock pinned to `now`.
  ctx.M = { state: { lineupKickoffs: kickoffsLoaded ? kickoffs : undefined } };
  ctx.U = ctx.__util;
  ctx.Date = class extends Date { static now() { return now * 1000; } };
  vm.runInContext(sliceFn(LINEUP, "function isKickedOff(") + "\nthis.__isKickedOff = isKickedOff;", ctx);
  const players = [
    { id: "1", name: "Indy, Londoner", position: "WR", team: "IND" },
    { id: "2", name: "Bay, Tampa", position: "PK", team: "TBB" },
    { id: "3", name: "Steel, Thursday", position: "RB", team: "PIT" },
    { id: "4", name: "Chiefs, Bye", position: "TE", team: "KCC" },
  ];
  const byId = Object.fromEntries(players.map((p) => [p.id, p]));
  const writes = [];
  const nowrite = (what) => () => { writes.push(what); return Promise.reject(new Error("no writes in tests")); };
  ctx.UPS_MOBILE = {
    util: ctx.__util,
    state: { ctx: { year: "2026", leagueId: "74598" }, players: { players: { player: players } }, viewerFranchiseId: "0008",
      franchises: [], get waiverState() { return ctx.state.waiverState; }, lineupWeek: 4 },
    data: { getAllRosteredPids: () => new Set(), getSeasonScoring: () => null, getAdvancedStatsMap: () => ({}), getAdvancedStatsLatestYear: () => 2026,
      getYtdScoresMap: () => ({}), playerById: (id) => byId[String(id)] || null, computeCap: () => null, rosterCapMax: () => 30,
      getRosterFor: () => [], dropPenaltyFor: () => null },
    ui: { showToast() {} },
    route: { registerView: (n, fn) => { if (n === "players") ctx.__render = fn; }, renderRoute: () => ctx.__render(mount, []), navigate() {}, currentRoute: () => "players" },
    hotCold: { get: () => ({ hot: {}, cold: {} }), isLoading: () => false, fetch: () => Promise.resolve() },
    lineupIntel: { load() {}, projLoaded: () => false, projFor: () => null, fmtProj: (v) => String(v), matchupFor: () => null, priorSeason: () => false,
      rankCls: () => "", weeksAvailable: () => 0, muData: () => null,
      kickoffs: { load() {}, loaded: () => kickoffsLoaded, kickedOff: (team) => ctx.__isKickedOff(team), kickoffFor: (team) => kickoffs[team] || null } },
    waivers: {
      mode: () => ctx.__waiverMode(), writeEnabled: () => true, stateKnown: () => true, nativeLink: () => "",
      limits: () => ({ min: 1000, step: 1000, maxRounds: 8, conditional: true, conditionalKnown: true }),
      getPlan: () => [], setPlan() {}, pickCount: () => 0, clearCount: () => 0, isDirty: () => false, getPending: () => ({ known: true, rounds: [] }),
      fetchPending: () => Promise.resolve({ known: true, rounds: [] }), adoptVerified: () => false, lastRun: () => ({ known: false }), targetRun: () => null,
      submitPlan: nowrite("submitPlan"), submitFcfs: nowrite("submitFcfs"), when: () => "", countdown: () => "",
    },
  };
  const ctrl = {};
  const control = (id) => ctrl[id] || (ctrl[id] = { id, value: "", listeners: {}, focus() {}, setSelectionRange() {},
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    fire(type) { (this.listeners[type] || []).forEach((fn) => fn.call(this, { target: this })); } });
  const mount = { innerHTML: "", querySelector: () => null, querySelectorAll: () => [] };
  ctx.document = { body: { style: {} }, activeElement: null, addEventListener() {},
    getElementById: (id) => (["ups-m-players-filter", "ups-m-players-sort", "ups-m-players-search"].includes(id) ? control(id) : null) };
  vm.runInContext(read(PLAYERS_JS), ctx);
  ctx.__render(mount, []);
  const btn = (pid) => {
    const chunk = mount.innerHTML.split('<div class="ups-m-fa-row').slice(1).find((c) => c.includes('data-pid="' + pid + '"') || c.includes(byId[pid].name.split(", ").reverse().join(" "))) || "";
    const m = chunk.match(/<(button|span) class="ups-m-fa-add[^"]*"[^>]*>([\s\S]*?)<\/\1>/);
    return m ? m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() : "(none)";
  };
  const strip = () => ((mount.innerHTML.match(/<div class="ups-m-waiver-strip[^"]*"><span class="txt">([^<]*)/) || [])[1] || "")
    .replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  return { btn, strip, writes, mode: () => ctx.__waiverMode().mode };
}

test("Sunday opening, 1s either side of the 9:00 AM ET run: Bid → Add now", () => {
  const before = harness(et("2026-10-04T08:59:59-04:00"));
  t.equal(before.mode(), "bbid");
  t.equal(before.btn("2"), "Bid", "08:59:59 — blind bid");
  const after = harness(et("2026-10-04T09:00:01-04:00"));
  t.equal(after.mode(), "fcfs");
  t.equal(after.btn("2"), "Add now", "09:00:01 — Add now (TBB plays at 1:00 PM)");
  t.equal(after.strip(), "First come, first served until Mon Oct 5, 9:00 PM ET — adds are immediate; a player locks when his game kicks off.",
    "the strip names the close time and the kickoff rule");
  t.equal(after.writes.length, 0);
});

test("Monday re-lock, 1s either side of 9:00 PM ET: Add now → Bid", () => {
  const before = harness(et("2026-10-05T20:59:59-04:00"));
  t.equal(before.btn("4"), "Add now", "20:59:59 — a bye-week player is still addable");
  t.equal(before.btn("2"), "Locked game started", "…a player whose game was Sunday is locked");
  const after = harness(et("2026-10-05T21:00:00-04:00"));
  t.equal(after.mode(), "bbid");
  t.equal(after.btn("4"), "Bid", "21:00:00 — back to blind bids");
  t.equal(after.btn("2"), "Bid", "and the locked player can be bid on again");
});

test("player kickoff inside the window, 1s either side: Add now → Locked (game started)", () => {
  t.equal(harness(et("2026-10-04T09:29:59-04:00")).btn("1"), "Add now", "London game: IND player at 09:29:59");
  t.equal(harness(et("2026-10-04T09:30:00-04:00")).btn("1"), "Locked game started", "IND player at kickoff 09:30:00");
  t.equal(harness(et("2026-10-04T12:59:59-04:00")).btn("2"), "Add now", "TBB player at 12:59:59");
  t.equal(harness(et("2026-10-04T13:00:00-04:00")).btn("2"), "Locked game started", "TBB player at 13:00:00");
  t.equal(harness(et("2026-10-04T09:00:01-04:00")).btn("3"), "Locked game started", "Thursday-night PIT player: locked all window");
  t.equal(harness(et("2026-10-04T15:00:00-04:00")).btn("4"), "Add now", "no game this week (KCC): addable all window");
  t.equal(harness(et("2026-10-04T13:00:00-04:00"), { kickoffsLoaded: false }).btn("2"), "Add now",
    "kickoffs not loaded yet: the button shows (MFL and the worker still refuse a locked player)");
});

test("daylight saving (DST ends Sun Nov 1 2026): the window keeps 9:00 AM / 9:00 PM New York time", () => {
  t.equal(harness(Date.parse("2026-11-01T13:00:00Z") / 1000, { kickoffs: KICKOFFS_WK8 }).btn("2"), "Bid", "13:00 UTC = 8:00 EST — not open (the old 9:00 EDT instant)");
  t.equal(harness(et("2026-11-01T08:59:59-05:00"), { kickoffs: KICKOFFS_WK8 }).btn("2"), "Bid", "08:59:59 EST");
  t.equal(harness(et("2026-11-01T09:00:00-05:00"), { kickoffs: KICKOFFS_WK8 }).btn("2"), "Add now", "09:00:00 EST (14:00 UTC)");
  t.equal(harness(et("2026-11-02T20:59:59-05:00"), { kickoffs: KICKOFFS_WK8 }).btn("4"), "Add now", "Mon 20:59:59 EST");
  t.equal(harness(Date.parse("2026-11-03T01:00:00Z") / 1000, { kickoffs: KICKOFFS_WK8 }).btn("4"), "Add now", "Tue 01:00 UTC = 8:00 PM EST — still open");
  t.equal(harness(et("2026-11-02T21:00:00-05:00"), { kickoffs: KICKOFFS_WK8 }).btn("4"), "Bid", "Mon 21:00:00 EST (Tue 02:00 UTC)");
});

test("preseason, Week 1, and the season shut-off", () => {
  t.equal(harness(et("2026-08-16T09:01:00-04:00")).btn("4"), "Bid", "preseason Sunday after the run: Bid");
  t.equal(harness(et("2026-09-06T09:01:00-04:00")).btn("4"), "Bid", "pre-Week-1 Sunday Sep 6: Bid (Keith's Week 1 rule)");
  t.equal(harness(et("2026-09-13T09:00:01-04:00"), { kickoffs: {} }).btn("4"), "Add now", "first in-season Sunday: Add now");
  t.equal(harness(et("2027-01-04T20:59:59-05:00"), { kickoffs: {} }).btn("4"), "Add now", "last Monday 20:59:59: Add now");
  const shut = harness(et("2027-01-04T21:00:00-05:00"), { kickoffs: {} });
  t.equal(shut.mode(), "blackout", "Jan 4 2027 9:00 PM: blackout");
  t.equal(shut.btn("4"), "Locked no add/drops", "Locked — neither Add now nor Bid");
  t.match(shut.strip(), /the season's add\/drop window has closed/);
});

test("transactions closed → Locked: the FA Auction blackout, and before waivers open", () => {
  const h = harness(et("2026-07-30T12:00:00-04:00"), { kickoffs: {} });
  t.equal(h.mode(), "blackout");
  t.equal(h.btn("4"), "Locked no add/drops", "FA Auction blackout");
  const pre = harness(et("2026-07-20T12:00:00-04:00"), { kickoffs: {} });
  t.equal(pre.mode(), "closed");
  t.equal(pre.btn("4"), "Locked waivers not open", "before the league's first waiver event");
});

await run("waiver_fcfs_window");
