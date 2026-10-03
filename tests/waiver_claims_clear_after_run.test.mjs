// Waiver claims must clear themselves after the run that processed them.
//   node tests/waiver_claims_clear_after_run.test.mjs
//   WORKER_JS=<another worker index.js> PLAYERS_JS=<another players.js> (defect check)
//
// Keith 2026-10-03 (screenshots, ~9:47 AM ET, after Saturday's 9:00 run): the
// Claims screen still showed "Clear every claim in group 1 — withdrawing",
// "Edited — not submitted" and "MFL is holding different claims than the ones
// on this screen… Reload before you submit", and the Market still said
// "Finalize claims 1". "It should auto clear after every run."
//
// ROOT CAUSE: the run-based clear (app.js reconcileWaiverPlanAgainstRun at
// every waiver-state load; players.js runProcessedClear on the Claims screen)
// compares the run a plan was aimed at (target_run, stamped from
// /api/waivers/state next_bbid_run_unix when MFL echoes the plan back) with
// last_run. Both came ONLY from MFL's calendar export, which lists no
// in-season runs: live that morning, last_run = Thu Aug 13 and
// next_bbid_run_unix = null. So every in-season plan was stamped with no
// target and nothing ever cleared. The worker now fills run times from the
// league's Thu/Fri/Sat/Sun 9:00 AM ET schedule (every 2025 + 2026 MFL award
// lands on one of those instants) — see tests/waiver_window_test.js.
//
// Plans saved BEFORE that fix have no target and never will. For those, the
// Claims screen now drops unsent edits that MFL already matches (a staged
// clear of a group the run already emptied) instead of warning — lossless,
// because submitting them would change nothing at MFL. Nothing here sends a
// write: every write path is stubbed to record itself and refuse.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.isAbsolute(p) ? p : path.join(ROOT, p), "utf8");
const WORKER = read(process.env.WORKER_JS || "worker/src/index.js");
const PLAYERS_JS = process.env.PLAYERS_JS || "site/m/views/players.js";
const APP = read("site/m/app.js");

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

// ── the worker's real window function (and its league-schedule helpers) ──
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
// What /api/waivers/state serves at `now`: window + last_run, built from the worker's own function.
function stateAt(now) {
  const w = workerWindow()(REAL_EVENTS, now, { calendar_unavailable: false, waiver_type: "BBID_FCFS", week1_kickoff_unix: WEEK1 });
  return { ok: true, window: { mode: w.mode, next_bbid_run_unix: w.next_bbid_run_unix, next_bbid_run_label: w.next_bbid_run_label },
    last_run: { known: true, unix: w.last_bbid_run_unix, label: w.last_bbid_run_label } };
}

// ── app.js's own plan store + run reconcile, verbatim ──
function appPlanStore() {
  const c = vm.createContext({ JSON });
  const store = {};
  c.window = { localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } } };
  c.state = { ctx: { leagueId: "74598", year: "2026" }, viewerFranchiseId: "0008", waiverState: null,
    waiverPlan: null, waiverMflSig: null, waiverTargetRun: null, waiverPlanVerified: "" };
  const fns = ["function safeStr(", "function safeInt(", "function waiverPlanKey(", "function planSignature(",
    "function mflHoldingsSignature(", "function getWaiverPlan(", "function setWaiverPlan(", "function waiverNextRunUnix(",
    "function waiverLastRun(", "function adoptVerifiedPlan(", "function reconcileWaiverPlanAgainstRun("];
  vm.runInContext("var _waiverPlanCacheKey = '';\n" + fns.map((f) => sliceFn(APP, f)).join("\n") +
    "\nthis.api = { getWaiverPlan, setWaiverPlan, adoptVerifiedPlan, reconcileWaiverPlanAgainstRun };", c);
  return c;
}

test("the chain, live calendar: a plan MFL echoed back on Friday clears itself after Saturday's 9:00 run", () => {
  const c = appPlanStore(), A = c.api;
  c.state.waiverState = stateAt(et("2026-10-02T15:00:00-04:00"));       // Friday afternoon
  t.equal(c.state.waiverState.window.next_bbid_run_unix, et("2026-10-03T09:00:00-04:00"), "worker: next run = Sat Oct 3 9:00 AM ET (was null)");
  t.ok(A.adoptVerifiedPlan({ known: true, rounds: [{ round: 1, picks: [{ add_pid: "14717", bid_dollars: 12000, drop_pid: null }] }] }),
    "MFL echoes the submitted claim back");
  t.equal(c.state.waiverTargetRun, et("2026-10-03T09:00:00-04:00"), "the plan is stamped: aimed at Sat 9:00");
  // Keith then stages a withdrawal of group 1 — a local edit, not submitted.
  A.setWaiverPlan([{ round: 1, picks: [], clear: true }]);
  t.equal(c.state.waiverTargetRun, et("2026-10-03T09:00:00-04:00"), "a local edit keeps the target");
  c.state.waiverState = stateAt(et("2026-10-03T08:59:00-04:00"));
  t.equal(A.reconcileWaiverPlanAgainstRun(), false, "08:59 — the run hasn't happened: nothing cleared");
  t.equal(A.getWaiverPlan().length, 1);
  c.state.waiverState = stateAt(et("2026-10-03T09:47:00-04:00"));       // the screenshot
  t.equal(c.state.waiverState.last_run.label, "Sat Oct 3, 9:00 AM ET", "worker: last run = Sat Oct 3 9:00 AM ET (was Aug 13)");
  t.equal(A.reconcileWaiverPlanAgainstRun(), true, "09:47 — cleared on the waiver-state load (Market badge + Home tile)");
  t.equal(A.getWaiverPlan().length, 0, "nothing staged: no 'Finalize claims 1', no 'withdrawing'");
  t.equal(c.state.waiverTargetRun, null, "and the spent target is gone, so tomorrow's plan isn't wiped on sight");
});

test("the chain clears after EVERY run — Thu, Fri, Sat and Sun — not just one", () => {
  const runs = ["2026-10-04T09:00:00-04:00", "2026-10-08T09:00:00-04:00", "2026-10-09T09:00:00-04:00", "2026-10-10T09:00:00-04:00"];
  let staged = et("2026-10-03T12:00:00-04:00");
  for (const r of runs) {
    const c = appPlanStore(), A = c.api;
    c.state.waiverState = stateAt(staged);
    A.adoptVerifiedPlan({ known: true, rounds: [{ round: 1, picks: [{ add_pid: "16419", bid_dollars: 7000, drop_pid: null }] }] });
    t.equal(c.state.waiverTargetRun, et(r), `staged ${new Date(staged * 1000).toISOString()} → aimed at ${r}`);
    c.state.waiverState = stateAt(et(r) + 60);
    t.equal(A.reconcileWaiverPlanAgainstRun(), true, `cleared one minute after ${r}`);
    staged = et(r) + 3600;
  }
});

// ── the Claims screen (players.js), driven through its own overlay handlers ──
function claimsHarness({ plan, verified, basisRounds, mflNow, lastRun }) {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, Promise });
  ctx.window = ctx;
  const UTIL = ["function safeStr(", "function safeInt(", "function pad4(", "function escapeHtml(", "function fmtUsd(", "function asArray("]
    .map((s) => sliceFn(APP, s)).join("\n");
  vm.runInContext(UTIL + "\nthis.__util = { safeStr, safeInt, pad4, escapeHtml, fmtUsd, asArray };", ctx);
  const sig = (rounds) => JSON.stringify((rounds || []).filter((g) => (g.picks || []).length)
    .map((g) => [g.round, g.picks.map((p) => [p.add_pid, p.bid_dollars, p.drop_pid || ""])]));
  const planSig = (p) => JSON.stringify((p || []).map((g) => [g.round, g.clear ? 1 : 0, (g.picks || []).map((x) => [x.add_pid, x.bid_dollars, x.drop_pid || ""])]));
  let cur = JSON.parse(JSON.stringify(plan)), basis = sig(basisRounds), ver = verified != null ? verified : "never";
  const rec = { writes: [], confirms: [], fetches: 0 };
  ctx.confirm = (m) => { rec.confirms.push(m); return false; };
  const nowrite = (what) => () => { rec.writes.push(what); return Promise.reject(new Error("no writes in tests")); };
  const players = [
    { id: "14717", name: "McLaughlin, Chase", position: "PK", team: "TBB" },
    { id: "16419", name: "Szmyt, Andre", position: "PK", team: "CLE" },
    { id: "12263", name: "Waller, Darren", position: "TE", team: "MIA" },
  ];
  const byId = Object.fromEntries(players.map((p) => [p.id, p]));
  ctx.UPS_MOBILE = {
    util: ctx.__util,
    state: { ctx: { year: "2026", leagueId: "74598" }, players: { players: { player: players } }, viewerFranchiseId: "0008",
      franchises: [{ id: "0008", name: "Real Deal Creel" }], waiverState: { window: { mode: "bbid" } } },
    data: { getAllRosteredPids: () => new Set(["12263"]), getSeasonScoring: () => null, getAdvancedStatsMap: () => ({}),
      getAdvancedStatsLatestYear: () => 2026, getYtdScoresMap: () => ({}), playerById: (id) => byId[String(id)] || null,
      computeCap: () => null, rosterCapMax: () => 30, getRosterFor: () => [{ id: "12263", salary: 3000 }], dropPenaltyFor: () => null },
    ui: { showToast() {} },
    route: { registerView: (n, fn) => { if (n === "players") ctx.__render = fn; }, renderRoute: () => ctx.__render(mount, []), navigate() {},
      currentRoute: () => "players" },
    hotCold: { get: () => ({ hot: {}, cold: {} }), isLoading: () => false, fetch: () => Promise.resolve() },
    waivers: {
      mode: () => ({ mode: "bbid", label: "Bid", detail: "Blind bids run at MFL's next scheduled run", writeEnabled: true, nativeLink: "" }),
      writeEnabled: () => true, stateKnown: () => true, nativeLink: () => "",
      limits: () => ({ min: 1000, step: 1000, maxRounds: 8, conditional: true, conditionalKnown: true }),
      getPlan: () => cur, setPlan: (p) => { cur = JSON.parse(JSON.stringify(p)); },
      pickCount: () => cur.reduce((n, g) => n + (g.picks || []).length, 0),
      clearCount: () => cur.filter((g) => !(g.picks || []).length && g.clear).length,
      isDirty: () => planSig(cur) !== ver,
      getPending: () => ({ known: true, rounds: mflNow.rounds || [] }),
      fetchPending: () => { rec.fetches++; return Promise.resolve(mflNow); },
      mflBasis: () => basis, mflSignature: (r) => (r && r.known === true ? sig(r.rounds) : null),
      adoptVerified: (r) => {
        if (!r || r.known !== true) return false;
        cur = (r.rounds || []).filter((g) => (g.picks || []).length).map((g) => ({ round: g.round, picks: g.picks, clear: false }));
        basis = sig(r.rounds); ver = planSig(cur);
        return true;
      },
      lastRun: () => lastRun || { known: false, unix: null }, targetRun: () => null,   // a plan saved before the stamp existed
      submitPlan: nowrite("submitPlan"), submitFcfs: nowrite("submitFcfs"),
      when: () => "", countdown: () => "",
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
  return { ctx, rec, plan: () => cur, open: () => ctx.UPS_MOBILE.waiverUI.openClaims(), screen, settle: () => new Promise((r) => setTimeout(r, 20)) };
}
const WARNING = /MFL is holding different claims than the ones on this screen/;
const SAT = { known: true, unix: et("2026-10-03T09:00:00-04:00"), label: "Sat Oct 3, 9:00 AM ET" };
const claim = (add, bid, drop) => ({ add_pid: add, bid_dollars: bid, drop_pid: drop || null });

test("Keith's screen: a staged 'clear group 1' that Saturday's run already emptied → dropped, no warning", async () => {
  // Before the run MFL held McLaughlin in group 1; Keith staged a withdrawal; the run processed group 1.
  const h = claimsHarness({ plan: [{ round: 1, picks: [], clear: true }], verified: "submitted-before",
    basisRounds: [{ round: 1, picks: [claim("14717", 12000)] }], mflNow: { known: true, rounds: [] }, lastRun: SAT });
  h.open();
  await h.settle();
  t.equal(h.rec.fetches, 1, "one read of MFL's pending claims");
  t.equal(h.plan().length, 0, "the stale withdrawal is gone");
  t.doesNotMatch(h.screen(), WARNING, "no 'MFL is holding different claims' warning");
  t.doesNotMatch(h.screen(), /withdrawing|Clear every claim in group 1/, "no 'withdrawing' group");
  t.match(h.screen(), /Waivers ran Sat Oct 3, 9:00 AM ET\. MFL has already processed group 1, so the withdrawal staged here no longer applies\./, "says why");
  t.doesNotMatch(h.screen(), /Submit 1 clear/, "nothing left to submit");
  t.equal(h.rec.writes.length, 0, "no write of any kind");
});

test("unsent NEW bids are never dropped silently: MFL changed + a staged claim MFL doesn't hold → still warns", async () => {
  const h = claimsHarness({ plan: [{ round: 1, picks: [claim("16419", 7000)], clear: false }], verified: "older",
    basisRounds: [{ round: 1, picks: [claim("14717", 12000)] }], mflNow: { known: true, rounds: [] }, lastRun: SAT });
  h.open();
  await h.settle();
  t.equal(h.plan().length, 1, "Szmyt $7K is kept");
  t.match(h.screen(), WARNING, "the owner is told MFL's copy moved");
  t.equal(h.rec.writes.length, 0);
});

test("mixed: a moot clear plus a real new bid → kept and warned (nothing is lost)", async () => {
  const h = claimsHarness({ plan: [{ round: 1, picks: [], clear: true }, { round: 2, picks: [claim("16419", 7000)], clear: false }],
    verified: "older", basisRounds: [{ round: 1, picks: [claim("14717", 12000)] }], mflNow: { known: true, rounds: [] }, lastRun: SAT });
  h.open();
  await h.settle();
  t.equal(h.plan().length, 2, "both groups kept");
  t.match(h.screen(), WARNING);
});

test("unsent picks identical to what MFL now holds (e.g. sent from another device) → adopted, no warning", async () => {
  const same = [{ round: 1, picks: [claim("16419", 7000, "12263")] }];
  const h = claimsHarness({ plan: [{ round: 1, picks: same[0].picks, clear: false }], verified: "older",
    basisRounds: [], mflNow: { known: true, rounds: same }, lastRun: SAT });
  h.open();
  await h.settle();
  t.equal(h.plan().length, 1, "the claim stays — it IS MFL's claim");
  t.doesNotMatch(h.screen(), WARNING);
  t.match(h.screen(), /already match what MFL is holding/);
});

test("MFL unreadable → nothing changes (an unread answer proves nothing)", async () => {
  const h = claimsHarness({ plan: [{ round: 1, picks: [], clear: true }], verified: "older",
    basisRounds: [{ round: 1, picks: [claim("14717", 12000)] }], mflNow: { known: false, rounds: null }, lastRun: SAT });
  h.open();
  await h.settle();
  t.equal(h.plan().length, 1, "the staged clear stays");
  t.equal(h.rec.writes.length, 0);
});

await run("waiver_claims_clear_after_run");
