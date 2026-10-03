// Waiver claims reconcile themselves with MFL after every run.
//   node tests/waiver_claims_clear_after_run.test.mjs
//   WORKER_JS=<another worker index.js> APP_JS=<another app.js> PLAYERS_JS=<another players.js> (defect check)
//
// Keith 2026-10-03 (screenshots ~9:47 AM ET, after Saturday's 9:00 run): the
// Claims screen still showed "Clear every claim in group 1 — withdrawing",
// "Edited — not submitted" and "MFL is holding different claims… Reload before
// you submit", and the Market still said "Finalize claims 1". He wants: no
// "Reload from MFL" after a run; processed claims and withdrawals clear;
// genuinely unsent bids and changes stay; the same on the Market badge, Home
// tile and Claims screen; Eastern Time and DST right.
//
// ROOT CAUSE: the after-run clear compared the plan's target run with
// last_run, and both came only from MFL's calendar export — which lists no
// in-season runs (live that morning: last_run = Thu Aug 13, next run = null).
// So every in-season plan had no target and nothing cleared. Fixed in two
// parts: the worker fills run times from the league's Thu/Fri/Sat/Sun 9:00 AM
// ET schedule (tests/waiver_window_test.js), and app.js reconciles the saved
// plan against MFL's own holdings once per run (reconcileWaiverPlanWithMfl),
// for every surface. Nothing here writes: every write path is stubbed to
// record itself and refuse.
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
// Arrays built inside a vm context have that context's prototypes, so compare by value.
const same = (a, b, m) => t.equal(JSON.stringify(a), JSON.stringify(b), m);

// ── /api/waivers/state, built by the worker's own window function ──
function workerWindow() {
  const WIN = "const _wvWaiverWindow = (calendarRows, nowUnix, opts = {}) => {";
  const a = WORKER.indexOf("const _WV_LEAGUE_BBID_WEEKDAYS"), b = WORKER.indexOf("// Bid floor / step / round cap read LIVE from MFL.");
  const sched = a !== -1 && b !== -1 ? WORKER.slice(a, b) : "";
  const body = sliceFn(WORKER, "const _wvIsSundayEt = (unixSec) => {") + ";\n" +
    sliceFn(WORKER, "const _wvEtLabel = (unixSec) => {") + ";\n" + sched + "\n" +
    sliceFn(WORKER, WIN, WIN.length - 1) + ";\nreturn _wvWaiverWindow;";
  return new Function("safeStr", body)((v) => (v == null ? "" : String(v)));
}
// Live /api/waivers/state calendar_events on 2026-10-03 — unchanged since August.
const REAL_EVENTS = [
  { event_type: "WAIVER_NONE", start_unix: 1784779200, end_unix: 1785902400 },
  { event_type: "WAIVER_LOCK", start_unix: 1785902400, end_unix: null },
  { event_type: "WAIVER_LOCK", start_unix: 1786021200, end_unix: null },
  { event_type: "WAIVER_BBID", start_unix: 1786107600, end_unix: null },
  { event_type: "WAIVER_LOCK", start_unix: 1786107600, end_unix: null },
  { event_type: "WAIVER_BBID", start_unix: 1786194000, end_unix: null },
  { event_type: "WAIVER_LOCK", start_unix: 1786194000, end_unix: null },
  { event_type: "WAIVER_LOCK", start_unix: 1786280400, end_unix: null },
  { event_type: "WAIVER_BBID", start_unix: 1786280400, end_unix: null },
  { event_type: "WAIVER_BBID", start_unix: 1786626000, end_unix: null },
  { event_type: "WAIVER_LOCK", start_unix: 1789434000, end_unix: null },
  { event_type: "WAIVER_NONE", start_unix: 1799114400, end_unix: null },
];
const WEEK1 = et("2026-09-09T20:20:00-04:00");
function stateAt(now) {
  const w = workerWindow()(REAL_EVENTS, now, { calendar_unavailable: false, waiver_type: "BBID_FCFS", week1_kickoff_unix: WEEK1 });
  return { ok: true, window: { mode: w.mode, next_bbid_run_unix: w.next_bbid_run_unix, next_bbid_run_label: w.next_bbid_run_label },
    last_run: { known: true, unix: w.last_bbid_run_unix, label: w.last_bbid_run_label },
    viewer: { known: true, pending_known: true, pending_pick_count: 0 } };
}

// ── app.js's own plan store + reconcile, verbatim; network stubbed ──
function appStore() {
  const c = vm.createContext({ JSON, Promise });
  const store = {};
  const rec = { reads: 0, renders: 0, events: [] };
  let mfl = { known: true, rounds: [] }, readFails = false;
  c.window = {
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    dispatchEvent: (e) => { rec.events.push(e.detail); return true; },
  };
  c.CustomEvent = function (type, init) { this.type = type; this.detail = init && init.detail; };
  c.state = { ctx: { leagueId: "74598", year: "2026" }, viewerFranchiseId: "0008", waiverState: null, waiverPending: null,
    waiverPlan: null, waiverMflSig: null, waiverTargetRun: null, waiverPlanVerified: "", waiverCheckedRun: null, waiverReconcileResult: null };
  c.fetchPendingClaims = () => { rec.reads++; if (readFails) return Promise.reject(new Error("signed out")); c.state.waiverPending = mfl; return Promise.resolve(mfl); };
  c.renderRoute = () => { rec.renders++; };
  const fns = ["function safeStr(", "function safeInt(", "function waiverPlanKey(", "function planSignature(",
    "function mflHoldingsSignature(", "function getWaiverPlan(", "function setWaiverPlan(", "function waiverNextRunUnix(",
    "function waiverLastRun(", "function adoptVerifiedPlan(", "function waiverPickCount(", "function waiverClearCount(",
    "function waiverPlanDirty(", "function waiverPicksKey(", "function reconcileWaiverPlanWithMfl(", "function reconcileWaiverPlanAfterRun("];
  vm.runInContext("var _waiverPlanCacheKey = '', waiverReconcilePromise = null;\n" + fns.map((f) => sliceFn(APP, f)).join("\n") +
    "\nthis.api = { getWaiverPlan, setWaiverPlan, adoptVerifiedPlan, waiverPickCount, waiverClearCount, waiverPlanDirty, planSignature," +
    " mflHoldingsSignature, waiverLastRun, reconcileWaiverPlanWithMfl, reconcileWaiverPlanAfterRun };", c);
  return { c, A: c.api, rec, store, setMfl: (m) => { mfl = m; }, failReads: (v) => { readFails = v; },
    at: (iso) => { c.state.waiverState = stateAt(et(iso)); },
    // A device that saved this exact record BEFORE the fix (no target, no checked_run).
    seed: (plan, confirmedRounds) => {
      c.state.waiverPlan = null;
      store["ups_waiver_plan_74598_2026_0008"] = JSON.stringify({ plan, mfl: null, target_run: null,
        verified: c.api.planSignature(confirmedRounds.map((g) => ({ round: g.round, picks: g.picks, clear: false }))) });
    } };
}
const claim = (add, bid, drop) => ({ add_pid: add, bid_dollars: bid, drop_pid: drop || null });
const staged = (A) => A.waiverPickCount() + A.waiverClearCount();   // the Market badge / Home tile count

// Home tile, verbatim from views/home.js, over the same store.
function homeTile(s) {
  const c = vm.createContext({});
  const home = read("site/m/views/home.js");
  vm.runInContext(sliceFn(home, "function waiverTileInfo(") + "\nthis.f = waiverTileInfo;", c);
  c.U = { safeInt: (v, d) => { const n = parseInt(v, 10); return isFinite(n) ? n : d; } };
  c.M = { state: s.c.state, waivers: { mode: () => ({ mode: "bbid", writeEnabled: true, detail: "" }), countdown: () => "",
    pickCount: s.A.waiverPickCount, clearCount: s.A.waiverClearCount, isDirty: s.A.waiverPlanDirty } };
  return c.f();
}

test("Keith's device, untouched: after Saturday's 9:00 run the stale withdrawal clears on its own — Market badge + Home tile", async () => {
  const s = appStore();
  s.seed([{ round: 1, picks: [], clear: true }], [{ round: 1, picks: [claim("14717", 12000)] }]);
  s.at("2026-10-03T09:47:00-04:00");                     // the screenshot
  t.equal(s.c.state.waiverState.last_run.label, "Sat Oct 3, 9:00 AM ET", "worker: last run = Sat Oct 3 9:00 AM ET (was Thu Aug 13)");
  t.equal(staged(s.A), 1, "before: 'Finalize claims 1' / Home tile '1 claim'");
  t.match(homeTile(s).sub, /1 claim/);
  await s.A.reconcileWaiverPlanAfterRun();               // what every waiver-state load runs
  t.equal(s.rec.reads, 1, "one read of MFL's pending claims");
  t.equal(staged(s.A), 0, "after: nothing staged — no 'Finalize claims', no 'withdrawing'");
  t.equal(homeTile(s).badge, null, "Home tile: no badge");
  t.doesNotMatch(homeTile(s).sub, /claim/, "Home tile: no claim count");
  t.equal(s.rec.renders, 1, "the current screen repaints itself");
  same([...s.rec.events[0].cleared_withdrawals], [1], "and an open Claims screen is told why");
  await s.A.reconcileWaiverPlanAfterRun();
  t.equal(s.rec.reads, 1, "no second read until the next run");
});

test("unsent work is kept: a processed claim clears, an unsent bid and an unsent edit stay (still 'edited — not submitted')", async () => {
  const s = appStore();
  s.at("2026-10-02T15:00:00-04:00");                     // Friday: MFL echoes groups 1 and 2 back
  s.A.adoptVerifiedPlan({ known: true, rounds: [{ round: 1, picks: [claim("14717", 12000)] }, { round: 2, picks: [claim("17167", 4000)] }] });
  t.equal(s.c.state.waiverTargetRun, et("2026-10-03T09:00:00-04:00"), "stamped: aimed at Sat 9:00 (was null before the worker fix)");
  // Before the run: raise group 2's bid (unsent) and stage a new group 3 bid (unsent).
  s.A.setWaiverPlan([{ round: 1, picks: [claim("14717", 12000)] }, { round: 2, picks: [claim("17167", 5000)] }, { round: 3, picks: [claim("16419", 7000)] }]);
  s.at("2026-10-03T08:59:00-04:00");
  await s.A.reconcileWaiverPlanAfterRun();
  t.equal(s.rec.reads, 0, "08:59: no run since MFL confirmed the plan — nothing to do");
  s.at("2026-10-03T09:47:00-04:00");
  s.setMfl({ known: true, rounds: [] });                 // the run processed everything MFL held
  await s.A.reconcileWaiverPlanAfterRun();
  const plan = s.A.getWaiverPlan();
  same(plan.map((g) => g.round), [2, 3], "group 1 (processed, unchanged) cleared; groups 2 and 3 kept");
  t.equal(plan[0].picks[0].bid_dollars, 5000, "the unsent $5K edit is kept as edited");
  t.equal(plan[1].picks[0].add_pid, "16419", "the unsent Szmyt bid is kept");
  t.ok(s.A.waiverPlanDirty(), "both still read 'edited — not submitted'");
  same([...s.rec.events[0].cleared_claims.map((x) => x.add_pid)], ["14717"]);
  same([...s.rec.events[0].kept_unsent], [2, 3]);
});

test("MFL's side is honoured: a withdrawal MFL still has claims for stays; groups MFL holds that weren't on screen come in", async () => {
  const s = appStore();
  s.seed([{ round: 1, picks: [], clear: true }, { round: 2, picks: [claim("14717", 12000)] }], [{ round: 2, picks: [claim("14717", 12000)] }]);
  s.at("2026-10-03T09:47:00-04:00");
  // After the run, claims were submitted from another device: group 1 and group 4.
  s.setMfl({ known: true, rounds: [{ round: 1, picks: [claim("16419", 7000)] }, { round: 4, picks: [claim("17075", 3000)] }] });
  await s.A.reconcileWaiverPlanAfterRun();
  const plan = s.A.getWaiverPlan();
  same(plan.map((g) => [g.round, g.clear ? "clear" : g.picks.map((p) => p.add_pid).join()]), [[1, "clear"], [4, "17075"]],
    "group 1 withdrawal kept (MFL still holds a claim there); group 2 processed → gone; group 4 loaded from MFL");
});

test("MFL unreadable: a plan whose run has passed clears locally (unsent kept); one with no known run is left alone", async () => {
  const s = appStore();
  s.at("2026-10-02T15:00:00-04:00");
  s.A.adoptVerifiedPlan({ known: true, rounds: [{ round: 1, picks: [claim("14717", 12000)] }] });
  s.A.setWaiverPlan([{ round: 1, picks: [claim("14717", 12000)] }, { round: 2, picks: [claim("16419", 7000)] }]);
  s.failReads(true);
  s.at("2026-10-03T09:47:00-04:00");
  await s.A.reconcileWaiverPlanAfterRun();
  same(s.A.getWaiverPlan().map((g) => g.round), [2], "processed group 1 cleared without a read; unsent group 2 kept");
  t.equal(s.c.state.waiverMflSig, null, "and it doesn't pretend it read MFL");
  const k = appStore();                                   // Keith's pre-fix record, signed out
  k.seed([{ round: 1, picks: [], clear: true }], [{ round: 1, picks: [claim("14717", 12000)] }]);
  k.failReads(true);
  k.at("2026-10-03T09:47:00-04:00");
  await k.A.reconcileWaiverPlanAfterRun();
  t.equal(staged(k.A), 1, "no target and no read: nothing is cleared on a guess");
  k.failReads(false);
  await k.A.reconcileWaiverPlanAfterRun();
  t.equal(staged(k.A), 0, "…and the next load, with MFL readable, clears it");
});

test("a plan that changes while the read is in flight is never overwritten", async () => {
  const s = appStore();
  s.seed([{ round: 1, picks: [], clear: true }], [{ round: 1, picks: [claim("14717", 12000)] }]);
  s.at("2026-10-03T09:47:00-04:00");
  const p = s.A.reconcileWaiverPlanAfterRun();
  s.A.setWaiverPlan([{ round: 1, picks: [claim("16419", 7000)] }]);   // the owner stages a bid mid-read
  await p;
  t.equal(s.A.getWaiverPlan()[0].picks[0].add_pid, "16419", "the new bid stands");
});

test("every run day, and across the November DST change: Thu, Fri, Sat, Sun 9:00 AM ET", async () => {
  const runs = ["2026-10-04T09:00:00-04:00", "2026-10-08T09:00:00-04:00", "2026-10-09T09:00:00-04:00", "2026-10-10T09:00:00-04:00",
    "2026-11-01T09:00:00-05:00",   // DST ends 2 AM Sun Nov 1 → this run is 14:00 UTC
    "2026-11-05T09:00:00-05:00"];
  let at = et("2026-10-03T12:00:00-04:00");
  for (const [i, r] of runs.entries()) {
    if (i === 4) at = et("2026-10-31T12:00:00-04:00");
    const s = appStore();
    s.c.state.waiverState = stateAt(at);
    s.A.adoptVerifiedPlan({ known: true, rounds: [{ round: 1, picks: [claim("16419", 7000)] }] });
    t.equal(s.c.state.waiverTargetRun, et(r), `staged ${new Date(at * 1000).toISOString()} → aimed at ${r}`);
    s.c.state.waiverState = stateAt(et(r) - 60);
    await s.A.reconcileWaiverPlanAfterRun();
    t.equal(s.rec.reads, 0, `one minute before ${r}: nothing`);
    s.c.state.waiverState = stateAt(et(r) + 60);
    await s.A.reconcileWaiverPlanAfterRun();
    t.equal(staged(s.A), 0, `one minute after ${r}: cleared`);
    at = et(r) + 3600;
  }
});

// ── the Claims screen (players.js) over the SAME app.js store ──
function claimsHarness(s) {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, Promise });
  ctx.window = ctx;
  const UTIL = ["function safeStr(", "function safeInt(", "function pad4(", "function escapeHtml(", "function fmtUsd(", "function asArray("]
    .map((f) => sliceFn(APP, f)).join("\n");
  vm.runInContext(UTIL + "\nthis.__util = { safeStr, safeInt, pad4, escapeHtml, fmtUsd, asArray };", ctx);
  const writes = [];
  ctx.confirm = () => false;
  const nowrite = (what) => () => { writes.push(what); return Promise.reject(new Error("no writes in tests")); };
  const players = [
    { id: "14717", name: "McLaughlin, Chase", position: "PK", team: "TBB" },
    { id: "16419", name: "Szmyt, Andre", position: "PK", team: "CLE" },
    { id: "17167", name: "Sanker, Jonas", position: "S", team: "NOS" },
  ];
  const byId = Object.fromEntries(players.map((p) => [p.id, p]));
  const A = s.A, st = s.c.state;
  ctx.UPS_MOBILE = {
    util: ctx.__util,
    state: { ctx: { year: "2026", leagueId: "74598" }, players: { players: { player: players } }, viewerFranchiseId: "0008",
      franchises: [{ id: "0008", name: "Real Deal Creel" }], get waiverState() { return st.waiverState; } },
    data: { getAllRosteredPids: () => new Set(), getSeasonScoring: () => null, getAdvancedStatsMap: () => ({}),
      getAdvancedStatsLatestYear: () => 2026, getYtdScoresMap: () => ({}), playerById: (id) => byId[String(id)] || null,
      computeCap: () => null, rosterCapMax: () => 30, getRosterFor: () => [], dropPenaltyFor: () => null, getOwnRosterPids: () => new Set() },
    ui: { showToast() {} },
    route: { registerView: (n, fn) => { if (n === "players") ctx.__render = fn; }, renderRoute: () => ctx.__render(mount, []), navigate() {},
      currentRoute: () => "players" },
    hotCold: { get: () => ({ hot: {}, cold: {} }), isLoading: () => false, fetch: () => Promise.resolve() },
    waivers: {
      mode: () => ({ mode: "bbid", label: "Bid", detail: "Blind bids run Sun Oct 4, 9:00 AM ET", writeEnabled: true, nativeLink: "" }),
      writeEnabled: () => true, stateKnown: () => true, nativeLink: () => "",
      limits: () => ({ min: 1000, step: 1000, maxRounds: 8, conditional: true, conditionalKnown: true }),
      getPlan: A.getWaiverPlan, setPlan: A.setWaiverPlan, pickCount: A.waiverPickCount, clearCount: A.waiverClearCount,
      isDirty: A.waiverPlanDirty, getPending: () => st.waiverPending, fetchPending: () => s.c.fetchPendingClaims(),
      adoptVerified: A.adoptVerifiedPlan, lastRun: A.waiverLastRun, targetRun: () => { A.getWaiverPlan(); return st.waiverTargetRun; },
      mflBasis: () => st.waiverMflSig, mflSignature: A.mflHoldingsSignature,
      reconcile: (b, o) => A.reconcileWaiverPlanWithMfl(b, o), planSignature: A.planSignature,
      verifiedSignature: () => { A.getWaiverPlan(); return st.waiverPlanVerified || ""; }, lastReconcile: () => st.waiverReconcileResult,
      submitPlan: nowrite("submitPlan"), submitFcfs: nowrite("submitFcfs"), when: () => "", countdown: () => "",
    },
  };
  const overlays = [];
  const element = (ov, id) => {
    ov.els = ov.els || {};
    if (ov.els[id]) return ov.els[id];
    const el = { id, value: "", innerHTML: "", textContent: "", attrs: {}, listeners: id.endsWith("-overlay") ? ov.listeners : {},
      addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
      setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
      focus() {}, select() {}, blur() {}, scrollTop: 0, querySelectorAll: () => [], querySelector: () => null,
      set outerHTML(h) { ov.html = h; },
      remove() { const i = overlays.indexOf(ov); if (i >= 0) overlays.splice(i, 1); } };
    ov.els[id] = el;
    return el;
  };
  const ctrl = {};
  const control = (id) => ctrl[id] || (ctrl[id] = { id, value: "", listeners: {}, focus() {}, setSelectionRange() {},
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); } });
  const mount = { innerHTML: "", querySelector: () => null, querySelectorAll: () => [] };
  ctx.document = {
    body: { style: {} }, activeElement: null, addEventListener() {},
    getElementById(id) {
      if (id === "ups-m-app") return { insertAdjacentHTML: (pos, html) => { overlays.push({ html, listeners: {} }); } };
      if (["ups-m-players-filter", "ups-m-players-sort", "ups-m-players-search"].includes(id)) return control(id);
      for (let i = overlays.length - 1; i >= 0; i--) if (overlays[i].html.includes('id="' + id + '"')) return element(overlays[i], id);
      return null;
    },
  };
  vm.runInContext(read(PLAYERS_JS), ctx);
  ctx.__render(mount, []);
  const screen = () => { const ov = overlays.filter((o) => o.html.includes('id="ups-m-claims-overlay"')).pop(); return ov ? ov.html : ""; };
  return { writes, open: () => ctx.UPS_MOBILE.waiverUI.openClaims(), screen, market: () => { ctx.__render(mount, []); return mount.innerHTML; },
    settle: () => new Promise((r) => setTimeout(r, 20)) };
}
const WARNING = /MFL is holding different claims than the ones on this screen/;

test("Claims screen, Keith's exact state: opens clean — no warning, no 'withdrawing', says why, sends nothing", async () => {
  const s = appStore();
  s.seed([{ round: 1, picks: [], clear: true }], [{ round: 1, picks: [claim("14717", 12000)] }]);
  s.at("2026-10-03T09:47:00-04:00");
  const h = claimsHarness(s);
  t.match(h.market(), /Finalize claims <span class="n">1<\/span>/, "Market before: 'Finalize claims 1'");
  h.open();
  await h.settle();
  t.doesNotMatch(h.screen(), WARNING, "no 'MFL is holding different claims' warning");
  t.doesNotMatch(h.screen(), /withdrawing|Clear every claim in group 1/, "no 'withdrawing' group");
  t.match(h.screen(), /Waivers ran Sat Oct 3, 9:00 AM ET\. MFL has already processed group 1, so the withdrawal staged here no longer applies\./);
  t.doesNotMatch(h.screen(), /Submit 1 clear/, "nothing left to submit");
  t.doesNotMatch(h.market(), /Finalize claims/, "Market after: no 'Finalize claims'");
  t.equal(h.writes.length, 0, "no write of any kind");
});

test("Claims screen: a processed claim clears and an unsent bid stays, with a notice — no Reload needed", async () => {
  const s = appStore();
  s.seed([{ round: 1, picks: [claim("14717", 12000)] }, { round: 2, picks: [claim("16419", 7000)] }], [{ round: 1, picks: [claim("14717", 12000)] }]);
  s.at("2026-10-03T09:47:00-04:00");
  const h = claimsHarness(s);
  h.open();
  await h.settle();
  same(s.A.getWaiverPlan().map((g) => g.round), [2], "group 1 processed → cleared; group 2 (unsent Szmyt) kept");
  t.doesNotMatch(h.screen(), WARNING);
  t.match(h.screen(), /MFL has processed your claim on Chase McLaughlin — check your roster to see whether you won it\./);
  t.match(h.screen(), /Your unsent changes in group 2 are still here — submit or remove them\./);
  t.equal(h.writes.length, 0);
});

test("Claims screen: the read wins over the no-read fallback — a group sent from another device after the run comes in", async () => {
  const s = appStore();
  s.at("2026-10-02T15:00:00-04:00");
  s.A.adoptVerifiedPlan({ known: true, rounds: [{ round: 1, picks: [claim("14717", 12000)] }] });   // aimed at Sat 9:00
  s.at("2026-10-03T09:47:00-04:00");
  s.setMfl({ known: true, rounds: [{ round: 4, picks: [claim("17167", 3000)] }] });
  const h = claimsHarness(s);
  h.open();
  await h.settle();
  same(s.A.getWaiverPlan().map((g) => [g.round, g.picks.map((p) => p.add_pid).join()]), [[4, "17167"]],
    "group 1 processed → cleared; group 4 (live at MFL) loaded — not lost to a clear-on-assumption first");
  t.match(h.screen(), /Loaded what MFL is holding in group 4\./);
  t.equal(h.writes.length, 0);
});

test("Claims screen: MFL unreadable and no known run → nothing changes", async () => {
  const s = appStore();
  s.seed([{ round: 1, picks: [], clear: true }], [{ round: 1, picks: [claim("14717", 12000)] }]);
  s.failReads(true);
  s.at("2026-10-03T09:47:00-04:00");
  const h = claimsHarness(s);
  h.open();
  await h.settle();
  t.equal(staged(s.A), 1, "the staged withdrawal stays");
  t.equal(h.writes.length, 0);
});

await run("waiver_claims_clear_after_run");
