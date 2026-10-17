// The phone app shows the worker's waiver-availability answer, keeps it current by itself, and every surface agrees
// (Keith 2026-10-17, Demario Davis).
//   node tests/mobile_waiver_availability.test.mjs
//
// One lookup for every surface: players[pid] (a recent drop) || by_team[his NFL team] || no_game. Time moves the answer
// on by itself — a run, a kickoff, the first-come close, the weekly rollover — with no deploy, no completed run, no data
// fix and no pull-to-refresh. The functions below are the REAL ones from site/m/app.js and site/m/views/players.js.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { CASES, payloadAt, stateAt, control, fcfsOpen } from "./fixtures/waiver_availability/timeline.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = fs.readFileSync(path.join(ROOT, "site/m/app.js"), "utf8");
const PL = fs.readFileSync(path.join(ROOT, "site/m/views/players.js"), "utf8");
const sliceFn = (src, sig) => {
  const at = src.indexOf(sig); if (at < 0) throw new Error("not found: " + sig);
  let i = src.indexOf("{", at), depth = 0;
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1); }
  throw new Error("unbalanced: " + sig);
};
const AVAIL_FNS = ["function waiverAvailSignature(", "function scheduleWaiverAvailabilityTick(", "function reloadRostersAfterRun(", "function waiverAvailabilityFor("]
  .map((f) => sliceFn(APP, f)).join("\n");

const FRI_RUN = 1792155600, SAT_RUN = 1792242000;   // Fri / Sat Oct 16 / 17 2026, 9:00 AM ET
const PAYLOAD = {
  ok: true, now_unix: FRI_RUN - 1800, changes_at_unix: FRI_RUN, next_run_unix: FRI_RUN, next_run_label: "Friday's run, Oct 16 at 9:00 AM ET",
  last_run_unix: FRI_RUN - 86400, last_run_label: "Thursday's run, Oct 15 at 9:00 AM ET", last_run_processed: true, last_run_adds: [],
  players: { 10816: { code: "waivers_later", badge: "Sat waiver", headline: "Waivers — eligible for Saturday's run, Oct 17 at 9:00 AM ET", lines: ["…"], eligible_run_unix: SAT_RUN } },
  by_team: { NYJ: { code: "waivers", badge: "", headline: "Waivers — next run: Friday's run, Oct 16 at 9:00 AM ET", eligible_run_label: "Friday's run, Oct 16 at 9:00 AM ET", lines: [] },
             SEA: { code: "game_locked", badge: "Game locked", headline: "Game locked — eligible again for Thursday's run, Oct 22 at 9:00 AM ET", lines: [] } },
  no_game: { code: "waivers", badge: "", headline: "Waivers — next run: Friday's run, Oct 16 at 9:00 AM ET", lines: [] },
};

// app.js's availability functions in a sandbox with a fake clock, timers, rosters and reload.
function loadApp({ nowSec, rostersReadSec, payload = PAYLOAD, error = "", rostered = [], busy = false, synced = 0 }) {
  const ctx = vm.createContext({ JSON, String, Object, Promise, console, Math });
  ctx.Date = { now: () => nowSec * 1000 };
  ctx.refetches = 0; ctx.reloads = 0; ctx.timers = []; ctx.renders = 0;
  ctx.state = { waiverAvail: payload, waiverAvailError: error, rostersReadAt: rostersReadSec * 1000, waiverAvailTriedAt: 0, rostersSyncedRun: synced };
  ctx.fetchWaiverAvailability = () => { ctx.refetches++; return { then() {} }; };
  ctx.reloadData = () => { ctx.reloads++; return { then(ok) { ctx.__reloadDone = ok; } }; };
  ctx.renderRoute = () => { ctx.renders++; };
  ctx.setTimeout = (fn, ms) => { ctx.timers.push({ fn, ms }); return ctx.timers.length; };
  ctx.clearTimeout = () => {};
  ctx.ownerOfPid = (pid) => ({ known: true, free: !rostered.includes(String(pid)) });
  ctx.document = { getElementById: (id) => (busy && id === "ups-m-claims-overlay" ? {} : null) };
  vm.runInContext(AVAIL_FNS + "\nthis.forPid = waiverAvailabilityFor; this.tick = scheduleWaiverAvailabilityTick;", ctx);
  return ctx;
}

test("one lookup: a recent drop, else his NFL team's state, else no-game; null while loading; a failed load retries by itself", () => {
  const a = loadApp({ nowSec: FRI_RUN - 1200, rostersReadSec: FRI_RUN - 1500 });
  t.equal(a.forPid("10816", "NYJ").badge, "Sat waiver", "Demario Davis: his own entry wins over NYJ's");
  t.equal(a.forPid("99999", "nyj").code, "waivers");
  t.equal(a.forPid("88888", "SEA").code, "game_locked");
  t.equal(a.forPid("77777", "").code, "waivers", "no team → no_game");
  t.equal(loadApp({ nowSec: FRI_RUN - 1200, rostersReadSec: FRI_RUN - 1500, payload: null }).forPid("1", "NYJ"), null);
  const failed = loadApp({ nowSec: FRI_RUN - 1200, rostersReadSec: 0, payload: null, error: "the availability check didn't load" });
  t.equal(failed.forPid("1", "NYJ").headline, "Availability could not be confirmed — the availability check didn't load. Trying again automatically.");
  t.equal(failed.refetches, 1, "and re-reads in the background");
});

test("a failed read is retried twice at once; afterwards the answer schedules its own re-read", async () => {
  const ctx = vm.createContext({ JSON, String, Object, Promise, console, encodeURIComponent, Math });
  let calls = 0;
  ctx.fetch = () => { calls++; return calls < 3 ? Promise.reject(new Error("offline")) : Promise.resolve({ ok: true, json: () => Promise.resolve(PAYLOAD) }); };
  ctx.timers = [];
  ctx.setTimeout = (fn, ms) => { if (ms < 2000) fn(); else ctx.timers.push({ fn, ms }); return 1; };
  ctx.clearTimeout = () => {};
  ctx.Date = { now: () => (FRI_RUN - 1200) * 1000 };
  ctx.window = { dispatchEvent() {} }; ctx.CustomEvent = function () {};
  ctx.renders = 0; ctx.renderRoute = () => { ctx.renders++; };
  ctx.workerUrl = (p) => "https://w.test" + p;
  ctx.state = { ctx: { leagueId: "74598", year: "2026" } };
  vm.runInContext(sliceFn(APP, "function fetchWaiverAvailability(") + "\n" + sliceFn(APP, "function waiverAvailSignature(") + "\n" +
    sliceFn(APP, "function scheduleWaiverAvailabilityTick(") + "\nthis.go = fetchWaiverAvailability;", ctx);
  await ctx.go(true);
  t.equal(calls, 3, "two failures, then the third attempt lands");
  t.equal(ctx.state.waiverAvail, PAYLOAD); t.equal(ctx.state.waiverAvailError, "");
  t.equal(ctx.renders, 1, "the screen repaints once with the answer");
  t.equal(ctx.timers.length, 1); t.equal(ctx.timers[0].ms, 1200 * 1000 + 2000, "next re-read: 2 s after changes_at (Friday's run)");
});

test("time moves the answer on by itself: a re-read at every change instant (a run, a kickoff, the rollover), capped at 6 h", () => {
  const a = loadApp({ nowSec: FRI_RUN - 60, rostersReadSec: FRI_RUN - 1500 });
  a.tick();
  t.equal(a.timers.length, 1); t.equal(a.timers[0].ms, 62000);
  a.timers[0].fn(); t.equal(a.refetches, 1, "the timer re-reads the answer");
  const far = loadApp({ nowSec: FRI_RUN - 86400 * 3, rostersReadSec: 0 }); far.tick();
  t.equal(far.timers[0].ms, 6 * 3600 * 1000);
  const late = loadApp({ nowSec: FRI_RUN + 3, rostersReadSec: 0 }); late.tick();
  t.equal(late.timers[0].ms, 5000, "an answer already past its instant re-reads in 5 s, not in a tight loop");
});

test("after a waiver run, rosters re-read themselves once MFL has posted it — never a pull-to-refresh", () => {
  const posted = { ...PAYLOAD, now_unix: FRI_RUN + 50, changes_at_unix: SAT_RUN, next_run_unix: SAT_RUN, last_run_unix: FRI_RUN,
    last_run_label: "Friday's run, Oct 16 at 9:00 AM ET", last_run_processed: true, last_run_adds: ["15428"] };
  // Not posted yet: "processing", and the 20-s re-read (changes_at) carries on by itself.
  const pending = loadApp({ nowSec: FRI_RUN + 30, rostersReadSec: FRI_RUN - 1500, payload: { ...posted, last_run_processed: false } });
  const p = pending.forPid("10816", "NYJ");
  t.equal(p.code, "unknown"); t.equal(p.headline, "Availability could not be confirmed yet — Friday's run, Oct 16 at 9:00 AM ET is processing; this updates by itself.");
  t.equal(pending.reloads, 0);
  // Posted, and our rosters don't show who it awarded: reload once, by itself.
  const stale = loadApp({ nowSec: FRI_RUN + 60, rostersReadSec: FRI_RUN - 1500, payload: posted });
  t.equal(stale.forPid("1", "NYJ").headline, "Availability could not be confirmed yet — Friday's run, Oct 16 at 9:00 AM ET is in; updating the rosters now.");
  stale.forPid("2", "NYJ");
  t.equal(stale.reloads, 1, "one reload, however many rows ask");
  stale.__reloadDone(); t.equal(stale.state.rostersSyncedRun, FRI_RUN); t.equal(stale.forPid("1", "NYJ").code, "waivers", "then the real answer");
  // Our rosters already show it (the awarded player is rostered): no reload at all.
  const fresh = loadApp({ nowSec: FRI_RUN + 60, rostersReadSec: FRI_RUN + 10, payload: posted, rostered: ["15428"] });
  t.equal(fresh.forPid("1", "NYJ").code, "waivers"); t.equal(fresh.reloads, 0);
  // Mid-claim (Claims screen open): the reload waits.
  const busy = loadApp({ nowSec: FRI_RUN + 60, rostersReadSec: FRI_RUN - 1500, payload: posted, busy: true });
  busy.forPid("1", "NYJ"); t.equal(busy.reloads, 0); t.equal(busy.timers.length, 1, "tried again shortly");
  // The answer itself predates the run (still says it's next): re-read, say it's processing.
  const old = loadApp({ nowSec: FRI_RUN + 5, rostersReadSec: FRI_RUN - 1500 });
  t.match(old.forPid("1", "NYJ").headline, /Friday's run, Oct 16 at 9:00 AM ET is processing; this updates by itself\.$/);
  t.equal(old.refetches, 1);
  t.doesNotMatch(AVAIL_FNS, /[Pp]ull down/, "nothing in the availability path asks for a pull-to-refresh");
});

// ── Requirement 6: the server answer, the Market row, the player sheet, the Claims screen and the stale-button
// guard all agree — at every instant of Keith's four cases. The real players.js renders each instant.
function surfacesAt(tSec, dropAt, team) {
  const payload = payloadAt(tSec, dropAt, team);
  const mode = fcfsOpen(tSec) ? "fcfs" : "bbid";
  const ctx = vm.createContext({ console, Promise, JSON, setTimeout: () => 1, clearTimeout() {} });
  ctx.window = ctx;
  const U = { safeStr: (v) => (v == null ? "" : String(v)), safeInt: (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; },
    escapeHtml: (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"),
    fmtUsd: (n) => "$" + n, pad4: (s) => String(s).padStart(4, "0"), asArray: (v) => (Array.isArray(v) ? v : v ? [v] : []) };
  ctx.U = U;
  ctx.Date = class extends Date { static now() { return tSec * 1000; } };
  const players = [{ id: "1", name: "Player, Test", position: "LB", team }];
  const toasts = [];
  ctx.UPS_MOBILE = {
    util: U,
    state: { ctx: { year: "2026", leagueId: "74598" }, players: { players: { player: players } }, viewerFranchiseId: "0008", franchises: [],
      waiverState: { window: { mode } }, lineupWeek: 6 },
    data: { getAllRosteredPids: () => new Set(), getSeasonScoring: () => null, getAdvancedStatsMap: () => ({}), getAdvancedStatsLatestYear: () => 2026,
      rosterOwnership: () => ({ readable: true, complete: true, missing: [], byPid: {} }), ownerOfPid: () => ({ known: true, free: true, fid: "" }),
      getYtdScoresMap: () => ({}), playerById: (id) => (String(id) === "1" ? players[0] : null), computeCap: () => null, rosterCapMax: () => 30,
      getRosterFor: () => [], dropPenaltyFor: () => null },
    ui: { showToast: (msg) => toasts.push(msg) },
    route: { registerView: (n, fn) => { if (n === "players") ctx.__render = fn; }, renderRoute() {}, navigate() {}, currentRoute: () => "players" },
    hotCold: { get: () => ({ hot: {}, cold: {} }), isLoading: () => false, fetch: () => Promise.resolve() },
    lineupIntel: { load() {}, projLoaded: () => false, projFor: () => null, fmtProj: (v) => String(v), matchupFor: () => null, priorSeason: () => false,
      weeksAvailable: () => 0, muData: () => null, kickoffs: { load() {}, loaded: () => true, kickedOff: () => false, kickoffFor: () => null } },
    waivers: {
      mode: () => ({ mode, label: mode, detail: "", writeEnabled: true, nativeLink: "" }), writeEnabled: () => true, stateKnown: () => true, nativeLink: () => "",
      // The server's answer at this instant, through the same lookup app.js uses.
      availability: (pid, tm) => payload.players[String(pid)] || payload.by_team[String(tm || "").toUpperCase()] || payload.no_game,
      limits: () => ({ min: 1000, step: 1000, maxRounds: 8, conditional: true, conditionalKnown: true }),
      getPlan: () => [], setPlan() {}, pickCount: () => 0, clearCount: () => 0, isDirty: () => false, getPending: () => ({ known: true, rounds: [] }),
      fetchPending: () => Promise.resolve({ known: true, rounds: [] }), adoptVerified: () => false, lastRun: () => ({ known: false }), targetRun: () => null,
      submitPlan: () => Promise.reject(new Error("no writes")), submitFcfs: () => Promise.reject(new Error("no writes")), when: () => "", countdown: () => "",
    },
  };
  const mount = { innerHTML: "", querySelector: () => null, querySelectorAll: () => [] };
  ctx.document = { body: { style: {} }, activeElement: null, addEventListener() {}, getElementById: () => null };
  vm.runInContext(PL, ctx);
  ctx.__render(mount, []);
  const row = (mount.innerHTML.split('<div class="ups-m-fa-row').slice(1).find((c) => c.includes('data-pid="1"')) || "");
  const m = row.match(/<(button|span) class="ups-m-fa-add[^"]*"[^>]*>([\s\S]*?)<\/\1>/);
  const W = ctx.UPS_MOBILE.waiverUI;
  const st = W.availability("1");
  const blocked = W.refuseUnlessAvailable("1");
  return {
    server: payload.players["1"] || payload.by_team[team] || payload.no_game,
    market: m ? m[2].replace(/<[^>]+>/g, "").replace(/&#39;/g, "'").trim() : "(none)",
    sheet: (W.availPanelHtml(st).match(/<div class="hd">([^<]*)<\/div>/) || [])[1] || "",
    claims: W.availWarnHtml("1"),
    blocked, toast: toasts[0] || "",
  };
}
const unesc = (s) => s.replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"');

test("every surface agrees with the server at every instant of the four cases (Market row, sheet, Claims screen, stale-button guard)", () => {
  let instants = 0;
  for (const [name, dropAt, team, steps] of CASES) {
    for (const [label, ev] of steps) {
      for (const tSec of [ev - 1, ev + 1]) {
        if (dropAt && tSec < dropAt) continue;   // still on a roster: no free-agent surfaces
        instants++;
        const s = surfacesAt(tSec, dropAt, team);
        const want = control(stateAt(tSec, dropAt, team));
        const where = `${name} · ${label} ${tSec < ev ? "−1 s" : "+1 s"}`;
        t.equal(s.market, want === "Bid" || want === "Add now" ? (want === "Bid" ? "Bid" : "Add now") : want, where + ": Market row");
        t.equal(unesc(s.sheet), s.server.headline, where + ": sheet headline = server");
        const blocks = !(s.server.code === "waivers" || s.server.code === "available_now");
        t.equal(s.blocked, blocks, where + ": stale-button guard");
        if (blocks) { t.equal(s.toast, s.server.headline, where + ": the guard says why"); t.ok(unesc(s.claims).includes(s.server.headline), where + ": Claims warning"); }
        else t.equal(s.claims, "", where + ": no Claims warning");
      }
    }
  }
  t.ok(instants >= 40, `${instants} instants checked`);
});

await run("mobile_waiver_availability");
