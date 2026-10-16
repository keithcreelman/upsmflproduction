// Mobile Stats → Players (#league/stats) and the player sheet it opens — Keith's 2026-10-09 review.
//   node tests/mobile_stats_players_review.test.mjs
//
// What this pins, each against the day's REAL read-only MFL + worker capture
// (tests/fixtures/mobile_stats_players_2026_10_09.json, 2026-10-10 00:06Z, after
// Week 5's Thursday DAL–TB game):
//   1. Actual MFL points on the first screen: Fantasy pts is the default set and
//      every Pts / PPG equals MFL's own W=ALL sum — live week included — the same
//      numbers (and ranks) the player sheet shows. The leaderboard copy stopped at
//      Week 4: Dak Prescott 107.5 there, 125.5 on MFL.
//   2. Every heading names its period; the week in progress is marked; recent form
//      is L2 now and L4 once more than four weeks are final (the Players market's
//      rule); a stored copy is shown ONLY for the weeks it says are final.
//   3. The PPG-rank minimum (Jordan Mason, one week, was RB #21). WHO is listed comes
//      from MFL's players export already loaded at boot (stacked PR on #1213): MFL
//      positions (DE → DL: Gregory Rousseau was "#1 LB"), every scoring IDP (the
//      leaderboard stopped at 500), list rank = sheet rank on every tab; a missing or
//      partial export falls back to / unions with the leaderboard, said on screen.
//   4. Controls (Keith 2026-10-10): PPG only in Fantasy pts; YPC and Targets; IDP sets without
//      PPG; kicker distance bands and punter I20 as made/attempts; Schedule-adjusted, All-MFL
//      usage and XpertRk removed; empty Routes hidden; every data heading sorts the WHOLE list,
//      unavailable values last, with the direction shown.
//   5. The sheet: verified owner chip; Propose trade through the existing builder;
//      REMAINING GUARANTEED for the whole contract from the worker's cap row (never "salary −
//      this season's earned", never ÷17), with a year-by-year split that must add up to the
//      engine's figure; a weekly game log; OWNER UNKNOWN is never offered Bid / Add; opening
//      ANY player makes no write-route request.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const FX = JSON.parse(read("tests/fixtures/mobile_stats_players_2026_10_09.json"));
const APP = read("site/m/app.js");
const CSS = read("site/m/app.css");

function sliceFn(src, sig) {
  const at = src.indexOf(sig);
  if (at < 0) throw new Error("not found: " + sig);
  let i = src.indexOf("{", at), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error("unbalanced: " + sig);
}
const UTIL_SRC = ["function safeStr(", "function safeInt(", "function pad4(", "function escapeHtml(",
  "function fmtUsd(", "function asArray("].map((s) => sliceFn(APP, s)).join("\n");

// ── fixture → MFL / worker shapes ──
function scoresPayload(weeks) {
  return { playerScoresAllWeeks: { year: "2026", playerScores: Object.entries(weeks).map(([w, m]) =>
    ({ week: String(w), playerScore: Object.entries(m).map(([id, score]) => ({ id, week: String(w), score: String(score) })) })) } };
}
const PLAYERS = Object.entries(FX.players).map(([id, [name, position, team]]) => ({ id, name, position, team }));
function rostersPayload(edit) {
  const franchise = Object.entries(FX.rosters).map(([id, rows]) => ({ id, player: rows.map((r) => ({
    id: r[0], status: r[1], salary: r[2] || "", contractYear: r[3] || "", contractStatus: r[4] || "", contractInfo: r[5] || "" })) }));
  const out = { rosters: { franchise } };
  if (edit) edit(out.rosters);
  return out;
}
function leaderboard(alias, over) {
  const lb = FX.leaderboard[alias];
  const rows = lb.cols ? lb.rows.map((r) => Object.fromEntries(lb.cols.map((k, i) => [k, r[i]]))) : lb.rows;
  return Object.assign({ rows, finalized_through_week: lb.finalized_through_week, built_for_week: lb.built_for_week,
    source_coverage: lb.source_coverage, stale: lb.stale, count: lb.count }, over || {});
}
const pidOf = (name) => Object.keys(FX.players).find((id) => FX.players[id][0] === name);
// MFL's own numbers, straight from the W=ALL capture (YTD = every posted week; AVG = YTD ÷ posted rows).
function mflYtd(pid, maxWeek = 99) {
  let pts = 0, n = 0;
  for (const [w, m] of Object.entries(FX.weeks)) if (+w <= maxWeek && m[pid] != null) { pts += Number(m[pid]); n++; }
  // MFL rounds YTD to tenths and AVG to hundredths (Shough: 109.8 / 27.45); shown to tenths, half up → 27.5.
  const ytd = Math.round(pts * 10) / 10;
  return { pts: ytd, n, ppg: n ? Math.round(ytd / n * 10) / 10 : null };
}

// ── a tiny DOM: elements remember innerHTML / listeners; querySelector finds rendered data-act buttons ──
function makeEl(id) {
  const listeners = {}, classes = new Set();
  const el = {
    id, innerHTML: "", value: "", style: { setProperty() {} }, firstChild: null,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
    listeners,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    fire(type, ev) { (listeners[type] || []).forEach((fn) => fn.call(el, ev || { target: el })); },
    // Buttons are parsed from the rendered HTML ONCE per render, so the code that
    // bound a listener and the test that clicks share the same object.
    __btns: null, __btnsFor: null,
    querySelectorAll(sel) {
      const acts = [...String(sel).matchAll(/data-act="([^"]+)"/g)].map((m) => m[1]);
      if (!acts.length) return [];
      if (el.__btnsFor !== el.innerHTML) { el.__btnsFor = el.innerHTML; el.__btns = el.__parse(); }
      return el.__btns.filter((b) => acts.includes(b.attrs["data-act"]));
    },
    __parse() {
      const out = [];
      for (const m of el.innerHTML.matchAll(/<(button|a)\b[^>]*>/g)) {
        const attrs = {}; for (const a of m[0].matchAll(/([a-zA-Z0-9-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
        if (attrs["data-act"]) {
          const L = {};
          out.push({ attrs, getAttribute: (k) => (k in attrs ? attrs[k] : null), addEventListener(type, fn) { (L[type] = L[type] || []).push(fn); },
            click() { (L.click || []).forEach((fn) => fn.call(this, { target: this, stopPropagation() {} })); }, parentNode: null });
        }
      }
      return out;
    },
    querySelector(sel) { return el.querySelectorAll(sel)[0] || null; },
  };
  return el;
}

// The REAL modules in one context: season_scoring + roster_ownership + front_office_lineup + app.js's
// getSeasonScoring/capPenaltyFor + stats.js + player_sheet.js.
// /api/player-status as the worker answers it on a normal week (Wk 5 report read, fresh).
const STATUS_OK = (players = {}, feed = {}) => ({ ok: true, season: 2026,
  report_feed: Object.assign({ ok: true, current: true, week: 5, current_week: 5, updated_utc: "2026-10-10T13:33:06.000Z", reason: null,
    teams_mfl: ["ARI", "ATL", "BAL", "BUF", "CHI", "CIN", "CLE", "DAL", "DEN", "DET", "GBP", "HOU", "IND", "JAC", "LAR", "LAC", "LVR", "MIA", "MIN", "NEP", "NOS", "NYG", "NYJ", "PHI", "PIT", "SEA", "SFO", "TBB", "TEN", "WAS"] }, feed),
  roster_feed: { ok: true, week: 5, updated_utc: "2026-10-10T14:01:03.000Z", reason: null },
  mfl_feed: { ok: true, week: 5, read_utc: "2026-10-10T14:55:00.000Z", updated_utc: "2026-10-10T14:01:03.000Z", reason: null, count: 0 }, players, mapped_mfl_ids: PLAYERS.map((p) => p.id) });
function boot(opt = {}) {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, Promise, URL, Date, Math, JSON });
  ctx.window = ctx;
  // window events are recorded so a test can fire one (e.g. "ups-season-scoring-changed")
  const winListeners = {};
  ctx.addEventListener = (type, fn) => (winListeners[type] = winListeners[type] || []).push(fn);
  ctx.Event = class { constructor(type) { this.type = type; } };
  ctx.dispatchEvent = (e) => { (winListeners[e.type] || []).forEach((fn) => fn(e)); return true; };
  vm.runInContext(UTIL_SRC + "\nthis.__util = { safeStr, safeInt, pad4, escapeHtml, fmtUsd, asArray };", ctx);
  // the shared contract parser the app loads (index.html: ../shared/cap_math.js)
  for (const f of ["site/shared/cap_math.js", "site/m/season_scoring.js", "site/m/front_office_lineup.js", "site/shared/injury_status.js"]) vm.runInContext(read(f), ctx);
  const state = {
    ctx: { year: opt.year || "2026", leagueId: "74598" }, players: { players: { player: PLAYERS } },
    rosters: "rosters" in opt ? opt.rosters : rostersPayload(),
    franchises: "franchises" in opt ? opt.franchises : FX.franchises.map((f) => ({ id: f.id, name: f.name })),
    viewerFranchiseId: opt.viewer == null ? "0008" : opt.viewer,
    playerScoresAll: "scores" in opt ? opt.scores : scoresPayload(FX.weeks),
    lineupWeekResolution: "lineupWeek" in opt ? opt.lineupWeek : FX.lineup_week,
    playerScoresAllAt: Date.parse(FX.fetched_at_utc),
    capPenaltyByPid: "capRows" in opt ? opt.capRows : FX.cap_rows,
    capPenaltyMeta: "capMeta" in opt ? opt.capMeta : { status: "ok", calculatedAt: FX.cap_meta.calculated_at, earnedThroughWeek: FX.cap_meta.earned_through_week },
    tagTracking: [], tagSubmissions: [],
  };
  ctx.state = state;
  vm.runInContext("var safeInt = this.__util.safeInt, safeStr = this.__util.safeStr;\n" + sliceFn(APP, "function getSeasonScoring(") + "\n" +
    sliceFn(APP, "function capPenaltyFor(") + "\n" +
    // the app's ONE ownership rule (#1208) — the Stats list and the sheet both read it
    ["function findFranchiseById(", "function rosterOwnership(", "function ownerOfPid("].map((sig) => sliceFn(APP, sig)).join("\n") +
    "\nthis.__ss = getSeasonScoring; this.__cap = capPenaltyFor; this.__own = ownerOfPid; this.__rosterOwn = rosterOwnership;", ctx);
  let playerIdx = { src: undefined, map: {} };
  const requests = [], builderCalls = [], els = {};
  const getEl = (id) => (els[id] = els[id] || makeEl(id));
  const views = {};
  const mount = makeEl("mount");
  mount.querySelector = () => null;
  mount.querySelectorAll = (sel) => {
    if (sel !== ".ups-m-pos-chip") return [];
    if (mount.__chipsFor !== mount.innerHTML) {
      mount.__chipsFor = mount.innerHTML;
      mount.__chips = [...mount.innerHTML.matchAll(/data-tab="([A-Z]+)"/g)].map((m) => ({ getAttribute: () => m[1], addEventListener(type, fn) { this["on" + type] = fn; } }));
    }
    return mount.__chips;
  };
  const M = ctx.UPS_MOBILE = {
    util: ctx.__util, state,
    api: { workerUrl: (p) => "https://w.test" + p, workerBase: () => "https://w.test" },
    data: {
      // like app.js playerById: reads whatever players export is in state right now
      playerById: (id) => {
        const src = state.players;
        if (playerIdx.src !== src) playerIdx = { src, map: Object.fromEntries(((src && src.players && [].concat(src.players.player)) || []).map((p) => [p.id, p])) };
        return playerIdx.map[String(id)] || null;
      },
      getSeasonScoring: () => ctx.__ss(),
      ...(opt.advMap ? { getAdvancedStatsMap: opt.advMap } : {}),
      ...(opt.refresh ? { refreshSeasonScoringIfStale: (ms) => ctx.__refresh(ms) } : {}),
      getAdvancedStatsLatestYear: () => 2026, getAdvancedStatsFor: () => null,
      capPenaltyFor: (id) => ctx.__cap(id),
      ownerOfPid: (id) => ctx.__own(id), rosterOwnership: () => ctx.__rosterOwn(),
      capPenaltyMeta: () => state.capPenaltyMeta,
      dropPenaltyFor: () => ({ amount: 32426, authoritative: true }),
      getMyTradeBaitIds: () => new Set(), getMyTradeBaitNoteFor: () => "",
      getRosterFor: () => [], irEligibilityFor: () => ({ ok: false }), isTaxiEligibleFor: () => false,
    },
    actions: {}, ui: { showToast() {} },
    route: { registerView: (n, fn) => (views[n] = fn), renderRoute: () => views.stats(mount), navigate() {} },
    tradeView: { openBuilder: (o) => builderCalls.push(o) },
    waiverUI: {
      cta: (pid) => ({ html: '<button class="btn-act" data-act="waiver-bid" data-pid="' + pid + '">Bid</button>' }),
      modeInfo: () => ({ mode: "bbid", detail: "Blind bids run Sat Oct 10, 9:00 AM ET" }), stagedRoundsFor: () => [],
    },
  };
  // Search's overlay (player_search.js open()): its input and list are fake elements a test can read.
  const created = [];
  ctx.document = { getElementById: getEl, addEventListener() {}, removeEventListener() {}, querySelector: () => null,
    body: { style: {}, appendChild(e) { e.parentNode = this; }, removeChild(e) { e.parentNode = null; } },
    createElement() {
      const kids = {};
      const e = { className: "", innerHTML: "", parentNode: null, setAttribute() {}, addEventListener() {},
        querySelector: (sel) => (kids[sel] = kids[sel] || Object.assign(makeEl(sel), { focus() {}, scrollTop: 0 })), kids };
      created.push(e); return e;
    } };
  ctx.fetch = async (url, o) => {
    requests.push({ url: String(url), method: (o && o.method) || "GET" });
    const u = new URL(url);
    let body = {};
    if (u.pathname === "/api/advanced-stats-leaderboard") {
      body = opt.leaderboard ? opt.leaderboard(u.searchParams.get("pos"), Number(u.searchParams.get("offset") || 0)) : leaderboard(u.searchParams.get("pos"));
      if (body && body.__status) return { ok: false, status: body.__status, json: async () => body.__json };   // a refusal (#1266)
    }
    else if (u.pathname === "/api/player-routes") body = { by_gsis: opt.routes || {} };
    else if (u.pathname === "/api/player-weekly-box") {
      if (opt.weeklyBox === 404) return { ok: false, status: 404, json: async () => ({}) };
      body = opt.weeklyBox ? opt.weeklyBox(u.searchParams.get("mfl_id")) : { ok: false };
    }
    else if (u.pathname === "/api/player-starter-rates") body = opt.starter ? opt.starter(u.searchParams.get("group")) : { ok: true, players: {}, weeks_label: "Wks 1–4", pending_weeks: [] };
    else if (u.pathname === "/api/player-status") {
      const st = typeof opt.status === "function" ? opt.status() : opt.status;
      if (st === 500) return { ok: false, status: 500, json: async () => ({ ok: false }) };
      if (st === "hold") return new Promise(() => {});                         // never answers
      body = st || STATUS_OK();
    }
    else if (u.pathname === "/api/player-epa") body = Object.assign({ by_gsis: opt.epa || {}, through_week: opt.epaThrough ? { 2026: opt.epaThrough } : {} },
      opt.epaDefs ? { definitions: opt.epaDefs } : {});
    else if (u.pathname === "/api/player-ngs") body = { by_gsis: opt.ngs || {} };
    else if (/^\/api\/(sos-adjusted-points|player-consistency)$/.test(u.pathname)) body = { by_gsis: {} };
    else if (u.pathname === "/api/mfl-market") body = { by_mfl: {} };
    else if (u.pathname === "/api/current-lineup-week") body = "lineupWeekNext" in opt ? opt.lineupWeekNext : FX.lineup_week;
    else if (u.pathname === "/api/mfl-export" && u.searchParams.get("TYPE") === "nflByeWeeks") body = opt.byes === null ? null : { nflByeWeeks: { team: FX.byes } };
    else if (u.pathname === "/api/player-bundle") {
      if (opt.bundle === "hold") return new Promise(() => {});              // never answers
      if (opt.bundle === "fail") return { ok: false, json: async () => null };
      body = (opt.bundles && opt.bundles[u.searchParams.get("pid")]) || FX.bundles[u.searchParams.get("pid")] || {};
    }
    return { ok: true, json: async () => body };
  };
  vm.runInContext(read("site/m/views/stats.js"), ctx);
  vm.runInContext(read("site/m/player_sheet.js"), ctx);
  if (opt.search) vm.runInContext(read("site/m/player_search.js"), ctx);
  // app.js's real 5-minute re-read of MFL's W=ALL, with MFL's answer from opt.refresh()
  if (opt.refresh) {
    ctx.__fetchJson = async () => opt.refresh();
    vm.runInContext("var fetchJson = this.__fetchJson, mflExportUrl = function (t, p) { return 'https://w.test/api/mfl-export?TYPE=' + t; }," +
      " workerUrl = function (p) { return 'https://w.test' + p; };\nvar seasonScoringRefresh = null, seasonScoringTriedAt = 0;\n" +
      sliceFn(APP, "function refreshSeasonScoringIfStale(") + "\nthis.__refresh = refreshSeasonScoringIfStale;", ctx);
  }
  // Search's overlay list (after M.playerSearch.openWith)
  const searchList = () => { const o = created[created.length - 1]; return o ? o.kids[".ups-m-psr-list"].innerHTML : ""; };
  return { ctx, M, state, els, getEl, mount, requests, builderCalls, searchList, winListeners, render: () => views.stats(mount) };
}
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); };
async function openTab(v, tab) {
  v.render(); await settle();
  const chip = v.mount.querySelectorAll(".ups-m-pos-chip").find((c) => c.getAttribute() === tab);
  chip.onclick.call(chip); await settle();
  return v.mount.innerHTML;
}
async function chooseSet(v, id) {
  const sel = v.getEl("ups-m-st-set"); sel.value = id; sel.fire("change", { target: sel }); await settle();
  return { list: v.getEl("ups-m-st-listwrap").innerHTML, head: v.getEl("ups-m-st-head").innerHTML, notes: v.getEl("ups-m-st-notes").innerHTML };
}
// pid → [rank, Pts, PPG, Wks, L-col] text of every rendered row (Fantasy pts set), in order.
function rowsOf(html) {
  const out = [];
  for (const m of html.matchAll(/<div class="ups-m-st-row[^"]*" data-pid="(\d+)">([\s\S]*?)(?=<div class="ups-m-st-row|<\/div><div class="ups-m-fa-more"|$)/g)) {
    const cells = [...m[2].matchAll(/<span class="v[^"]*">([\s\S]*?)<\/span>(?=<span class="v|<span class="flag"|<\/div>|$)/g)].map((c) => c[1].replace(/<[^>]+>/g, "").trim());
    const rk = /<span class="rk">([^<]*)<\/span>/.exec(m[2])[1];
    const tm = /<span class="tm">([\s\S]*?)<\/span><\/span><\/span>/.exec(m[2])[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&");
    // the row's reliability line ("Small sample · 23 targets"), "" when none
    const flag = (/<span class="flag">([^<]*)<\/span>/.exec(m[2]) || [])[1] || "";
    out.push({ pid: m[1], rk, cells, tm, flag, live: m[2].includes("ups-m-st-live") });
  }
  return out;
}
// A two-line band ("Wk 1–5" over "in progress") reads "Wk 1–5 / in progress".
const bands = (html) => [...html.matchAll(/<span class="band(?: two)?"[^>]*>([\s\S]*?)<\/span>(?=<span class="band|<span class="rk)/g)].map((m) => m[1].replace(/<br>/g, " / ").replace(/<[^>]+>/g, "").trim());
// Column headings are sort buttons: label text before the direction glyph.
const labels = (html) => [...html.matchAll(/class="ups-m-st-sort[^"]*" data-sort="([a-z0-9]+)"[^>]*>([^<]*)<i/g)].map((m) => m[2]);
const sortState = (html) => [...html.matchAll(/aria-sort="([a-z]+)"><button type="button" class="ups-m-st-sort[^"]*" data-sort="([a-z0-9]+)"[^>]*>[^<]*<i aria-hidden="true">([^<]*)</g)].map((m) => m[2] + ":" + m[1] + ":" + m[3]);

const PURDY = pidOf("Purdy, Brock"), DAK = pidOf("Prescott, Dak"), MASON = pidOf("Mason, Jordan"), ROUSSEAU = pidOf("Rousseau, Gregory");
const LOCK = pidOf("Lock, Drew");

// ═══ 1. Actual MFL points on the first screen ═══
test("fixture sanity: Week 5 is in progress (Thursday's game posted), the leaderboard copy stops at Week 4", () => {
  t.deepEqual(Object.keys(FX.weeks).map(Number).sort(), [1, 2, 3, 4, 5]);
  t.equal(FX.lineup_week.week, 5); t.equal(FX.lineup_week.source, "live_scoring");
  t.equal(FX.leaderboard.qb.finalized_through_week, 4);
  const lbDak = FX.leaderboard.qb.rows.find((r) => String(r.mfl_pid) === DAK);
  t.equal(lbDak.mfl_points, 107.5, "the stored copy: Wks 1–4");
  t.deepEqual(mflYtd(DAK), { pts: 125.5, n: 5, ppg: 25.1 }, "MFL: Wks 1–5");
});

test("QB opens on Fantasy pts: Pts · PPG · Wks · L2 PPG, every Pts/PPG/Wks equal to MFL's own W=ALL numbers", async () => {
  const v = boot();
  const html = await openTab(v, "QB");
  t.match(html, /<option value="fantasy" selected>Fantasy pts<\/option>/, "Fantasy pts is the default set");
  t.deepEqual(labels(html).slice(0, 4), ["Pts", "PPG", "Wks", "L2 PPG"]);
  const rows = rowsOf(html);
  t.ok(rows.length > 40, "every QB with a posted 2026 MFL score");
  for (const r of rows) {
    const m = mflYtd(r.pid);
    t.equal(r.cells[0], m.pts.toFixed(1), FX.players[r.pid][0] + " Pts = MFL YTD");
    t.equal(r.cells[1], m.ppg.toFixed(1), FX.players[r.pid][0] + " PPG = MFL AVG");
    t.equal(r.cells[2], String(m.n), FX.players[r.pid][0] + " Wks = MFL scored weeks");
  }
  const dak = rows.find((r) => r.pid === DAK), purdy = rows.find((r) => r.pid === PURDY);
  t.deepEqual(dak.cells.slice(0, 3), ["125.5", "25.1", "5"], "Prescott includes Thursday (stored copy said 107.5 / 26.9)");
  t.ok(dak.live, "…and is marked as including the week in progress");
  t.ok(!purdy.live, "Purdy hasn't played Week 5 yet: no marker");
  t.deepEqual([purdy.rk, ...purdy.cells], ["1", "136.7", "34.2", "4", "35.1"], "L2 = Wks 3–4 (31.2 + 39.0) / 2 = 35.1");
  t.equal(dak.tm, "DAL · Your team", "the viewer's own player");
});

test("headings name every period, mark the week in progress, and the basis line says ACTUAL MFL points", async () => {
  const v = boot();
  const html = await openTab(v, "QB");
  t.deepEqual(bands(html), ["MFL Wks 1–5", "Wk 3–4"]);
  t.match(html, /MFL Wks 1–5<span class="ups-m-st-live"/, "the in-progress dot rides on the live band");
  const basis = /<div class="ups-m-st-basis" id="ups-m-st-basis">([\s\S]*?)<\/div>/.exec(html)[1].replace(/<[^>]+>/g, "");
  t.match(basis, /^Actual MFL points, UPS scoring\. Wks 1–5, Wk 5 in progress/);
  t.match(basis, /L2 PPG = Wks 3–4, final weeks only/);
  t.match(basis, /Rank needs 2\+ MFL wks/);
  t.match(basis, /MFL read \d{1,2}:\d{2} (AM|PM)/);
  t.doesNotMatch(html, /nflverse<\/span>|2026 · nflverse/, "the old '2026 · nflverse' caption on MFL points is gone");
});

test("recent form follows the Players market: none at ≤2 final weeks, L2 at 3–4, L4 at 5+; hidden when finality is unknown", async () => {
  const head = async (weeks, lineupWeek) => {
    const sub = Object.fromEntries(Object.entries(FX.weeks).filter(([w]) => +w <= weeks));
    const v = boot({ scores: scoresPayload(sub), lineupWeek });
    const html = await openTab(v, "RB");
    return { labels: labels(html).slice(0, 4), bands: bands(html), basis: /id="ups-m-st-basis">([\s\S]*?)<\/div>/.exec(html)[1] };
  };
  t.deepEqual((await head(5, FX.lineup_week)).labels, ["Pts", "PPG", "Wks", "L2 PPG"], "4 final weeks → L2 (an L4 would equal season PPG)");
  const five = await head(5, { ok: true, week: 6, source: "live_scoring" });
  t.deepEqual(five.labels, ["Pts", "PPG", "Wks", "L4 PPG"], "5 final weeks → L4");
  t.deepEqual(five.bands, ["MFL Wks 1–5", "Wk 2–5"]);
  t.match(five.basis, /Wks 1–5 \(final\)/, "no week in progress → no marker, says final");
  t.equal((await head(2, { ok: true, week: 3, source: "live_scoring" })).labels.includes("L2 PPG"), false, "2 final weeks → no window");
  const unknown = await head(5, null);
  t.equal(unknown.labels.some((l) => /^L\d PPG$/.test(l)), false, "week check failed → no last-N window on a guess");
  t.match(unknown.basis, /Couldn’t confirm which weeks are final, so recent form is hidden/);
});

test("rank: the PPG-rank minimum (2 MFL wks) — one-week players keep their PPG, show '–', and sort after every ranked player", async () => {
  const v = boot();
  const rows = rowsOf(await openTab(v, "RB"));
  const search = v.getEl("ups-m-st-search");
  search.fire("input", { target: { value: "jordan mason" } });
  const mason = rowsOf(v.getEl("ups-m-st-listwrap").innerHTML).find((r) => r.pid === MASON);
  t.deepEqual([mason.rk, mason.cells[1], mason.cells[2]], ["–", "12.3", "1"], "was RB #21 on the old board");
  const firstUnranked = rows.findIndex((r) => r.rk === "–");
  t.ok(firstUnranked > 0 && rows.slice(firstUnranked).every((r) => r.rk === "–"), "ranked rows first, then unranked");
  t.deepEqual(rows.slice(0, firstUnranked).map((r) => +r.rk), rows.slice(0, firstUnranked).map((_, i) => i + 1), "ranks run 1..N without gaps");
});

test("list rank = player-sheet rank on EVERY tab (one universe, one grouping, one minimum, one source)", async () => {
  for (const tab of ["QB", "RB", "WR", "TE", "DL", "LB", "DB", "PK", "PN"]) {
    const v = boot();
    await openTab(v, tab);
    const all = rowsOf(v.getEl("ups-m-st-listwrap").innerHTML || v.mount.innerHTML);
    for (const r of all.filter((x) => x.rk !== "–").slice(0, 60)) {
      v.ctx.UPS_MOBILE.sheet.open(r.pid);
      const body = v.getEl("ups-m-sheet-body").innerHTML;
      const tile = /<div><b>([^<]*)<\/b><small>PPG rank<\/small><\/div>/.exec(body)[1];
      const ppg = /<div><b>([^<]*)<\/b><small>PPG · /.exec(body)[1];
      t.equal(tile, "#" + r.rk + " " + tab, tab + " " + FX.players[r.pid][0] + " rank");
      t.equal(ppg, r.cells[1], tab + " " + FX.players[r.pid][0] + " PPG");
    }
  }
});

// ═══ 3. MFL positions and a complete IDP universe ═══
test("positions are MFL's: Rousseau (MFL DE) is on DL, not LB; the badge says DE", async () => {
  const v = boot();
  t.equal(FX.players[ROUSSEAU][1], "DE");
  const dl = rowsOf(await openTab(v, "DL"));
  t.ok(dl.some((r) => r.pid === ROUSSEAU), "on the DL tab");
  t.match(v.mount.innerHTML, new RegExp('data-pid="' + ROUSSEAU + '"><span class="rk">\\d+</span><span class="nm"><span class="t"><span class="pn">[^<]*</span><span class="tm"><span class="pos dl">DE</span> · '),
    "the DE badge leads his team line (as a chip left of the name it cut 146 of 150 names at 320px)");
  const lb = rowsOf(await openTab(v, "LB"));
  t.ok(!lb.some((r) => r.pid === ROUSSEAU), "…and not on LB ('#1 LB' on the old board)");
  t.doesNotMatch(v.mount.innerHTML, /<span class="pos /, "single-position tabs carry no badge");
});

test("IDP universe comes from MFL, not the 500-row leaderboard: rostered IDPs it omitted are listed, and the box-score note says the input is capped", async () => {
  t.equal(FX.leaderboard.idp.count, 500, "the stored IDP list is exactly at its cap");
  const inLb = new Set(FX.leaderboard.idp.rows.map((r) => String(r[0])));
  const v = boot();
  const html = await openTab(v, "DB");
  // every DB with a posted MFL score is counted, not just the leaderboard's
  const scoredDbs = Object.keys(FX.players).filter((id) => ["CB", "S"].includes(FX.players[id][1]) && mflYtd(id).n > 0);
  t.match(html, new RegExp("Top 150 of " + scoredDbs.length + " DBs with a 2026 MFL score"));
  t.ok(scoredDbs.filter((id) => !inLb.has(id)).length > 50, "dozens of scoring DBs the stored list didn't have");
  // two ROSTERED players the old list could not show at all — found by search now
  const search = v.getEl("ups-m-st-search");
  for (const [name, pid, tab, team] of [["malachi moore", pidOf("Moore, Malachi"), "DB", "Gride"]]) {
    t.ok(!inLb.has(pid), name + " was missing from the stored list");
    search.fire("input", { target: { value: name } });
    const rows = rowsOf(v.getEl("ups-m-st-listwrap").innerHTML);
    t.equal(rows.length, 1, name);
    t.equal(rows[0].cells[0], mflYtd(pid).pts.toFixed(1));
    t.match(rows[0].tm, new RegExp(" · " + team + "$"));
  }
  search.fire("input", { target: { value: "" } });
  const box = await chooseSet(v, "coverage");
  t.match(box.notes, /\d+ listed DBs have no row in the stats source \(—\)\./, "one short line");
  t.match(box.notes, /<summary>About these numbers<\/summary><div>[^<]*They aren’t in the box-score list, which returns at most 500 players here\. Their player sheet can show the weekly box score; their MFL points are on Fantasy pts\./, "the why: not in the box-score list");
  // Boom/Bust is joined by MFL id (its source grades every MFL-scored player): no "—" line for it
  const bb = await chooseSet(v, "boom");
  t.doesNotMatch(bb.notes, /show — here|at most 500/, "Boom/Bust doesn't depend on the box-score list");
  await chooseSet(v, "coverage");
  t.deepEqual(bands(box.head), ["nflverse Wk 1–4"], "one band: PFR's charting comes through nflverse, same weeks; no PPG in this set");
  const dl = await openTab(v, "DL");
  search.fire("input", { target: { value: "brian burns" } });
  t.equal(rowsOf(v.getEl("ups-m-st-listwrap").innerHTML)[0].pid, pidOf("Burns, Brian"), "Brian Burns (rostered, omitted) is on DL");
  t.ok(dl.length > 0);
});

test("MFL's players export didn't load → the leaderboard's rows (never an empty list), ranked within them, and the screen says so", async () => {
  const v = boot();
  v.state.players = null;
  const qb = rowsOf(await openTab(v, "QB"));
  t.equal(qb.length, FX.leaderboard.qb.rows.length, "every leaderboard QB, not an empty list");
  const dak = qb.find((r) => r.pid === DAK);
  t.deepEqual(dak.cells.slice(0, 3), ["125.5", "25.1", "5"], "points are still MFL's own");
  t.match(v.getEl("ups-m-st-notes").innerHTML || v.mount.innerHTML, /MFL’s player list didn’t load, so this is the stats source’s list, with its copy of MFL positions; ranks are within it\./);
  const dl = await openTab(v, "DL");
  t.match(v.mount.innerHTML, /List = the stats source’s top 500 IDPs; ranks are within it\./, "the capped-list note returns with the capped list");
  t.ok(rowsOf(dl).length > 0);
});

test("a PARTIAL players export can't drop a scoring player the leaderboard has (union) — he stays listed at his MFL position", async () => {
  const v = boot();
  v.state.players = { players: { player: PLAYERS.filter((p) => p.id !== ROUSSEAU) } };
  await openTab(v, "DL");
  v.getEl("ups-m-st-search").fire("input", { target: { value: "rousseau" } });
  const rou = rowsOf(v.getEl("ups-m-st-listwrap").innerHTML).find((r) => r.pid === ROUSSEAU);
  t.ok(rou, "still on DL (the worker's mfl_position: DE)");
  t.equal(rou.cells[0], mflYtd(ROUSSEAU).pts.toFixed(1));
  t.equal(rou.rk, "–", "unranked, like his sheet (no MFL position to rank him against)");
  t.doesNotMatch(v.mount.innerHTML, /MFL’s player list didn’t load/, "the export DID load");
});

test("no new requests: switching every position makes only the requests the tab always made (leaderboard + side stats), never an MFL export", async () => {
  const v = boot();
  for (const tab of ["QB", "RB", "WR", "TE", "DL", "LB", "DB", "PK", "PN"]) await openTab(v, tab);
  const paths = [...new Set(v.requests.map((r) => new URL(r.url).pathname))].sort();
  t.deepEqual(paths, ["/api/advanced-stats-leaderboard", "/api/player-epa",
    "/api/player-ngs", "/api/player-routes", "/api/player-starter-rates", "/api/player-status"], "no MFL export; the Schedule-adjusted and All-MFL usage reads are gone; Boom/Bust reads the starter-pool route; status chips read /api/player-status");
  t.equal(v.requests.filter((r) => /leaderboard/.test(r.url)).length, 5, "one leaderboard call per alias, cached after");
  t.equal(v.requests.filter((r) => /player-status/.test(r.url)).length, 1, "one status read for every tab (cached 5 minutes)");
});

test("the stats.js position table agrees with UPS_FRONT_OFFICE_LINEUP.posGroup on every position", () => {
  const v = boot();
  const FOL = v.ctx.UPS_FRONT_OFFICE_LINEUP;
  const src = read("site/m/views/stats.js");
  const table = JSON.parse("{" + /var GROUP = \{([^}]*)\}/.exec(src)[1].replace(/([A-Z]+):/g, '"$1":') + "}");
  for (const [pos, g] of Object.entries(table)) t.equal(FOL.posGroup(pos), g, pos);
});

// ═══ 2b. The stored fallback ═══
test("the list reads the WHOLE stats board: it follows next_offset across pages, and a paged board is never called 'capped'", async () => {
  const full = leaderboard("idp");
  const paged = (pos, offset) => {
    const b = leaderboard(pos);
    if (pos !== "idp") return b;
    const rows = b.rows.slice(offset, offset + 250);
    return Object.assign({}, b, { rows, count: rows.length, limit: 500, offset, next_offset: offset + 250 < b.rows.length ? offset + 250 : null });
  };
  const v = boot({ leaderboard: paged });
  await openTab(v, "LB");
  const offsets = v.requests.filter((r) => r.url.includes("advanced-stats-leaderboard") && r.url.includes("pos=idp"))
    .map((r) => Number(new URL(r.url).searchParams.get("offset") || 0));
  t.deepEqual(offsets, [0, 250], "page 1, then the offset the worker named, then stop at next_offset null");
  t.ok(v.requests.filter((r) => r.url.includes("advanced-stats-leaderboard")).every((r) => /[?&]limit=500(&|$)/.test(r.url)), "every alias asks for full 500-row pages");
  const tk = await chooseSet(v, "tackles");
  t.doesNotMatch(tk.notes, /top 500|at most 500/, "every page was read: no 'capped' note");
  const v2 = boot();   // today's worker: no next_offset, exactly 500 rows back
  await openTab(v2, "LB");
  t.match((await chooseSet(v2, "tackles")).notes, /returns at most 500 players here/, "an unpaged full page is still reported as capped (MFL's list, so the gap is named)");
  t.equal(full.rows.length, 500);
});

test("MFL scoring unreadable → the stored totals from the last sync, said to include any synced week (never labelled final Wks 1–N), with the read time; no recent form", async () => {
  const v = boot({ scores: { error: { $t: "simulated" } } });
  const html = await openTab(v, "QB");
  // QA 2026-10-11: the stored totals sum every SYNCED week — after Thursday's
  // game that includes the week in progress — so no week range is claimed.
  t.deepEqual(bands(html), ["Stored totals"]);
  t.match(html, /MFL’s live scoring couldn’t be read, so these are the stored totals from the last sync: every week synced so far, which can include a week still being played \(stored copy read \d{1,2}:\d{2} (AM|PM)\)/);
  t.doesNotMatch(html, /final weeks only \(stored/, "never called final weeks");
  t.deepEqual(labels(html).slice(0, 3), ["Pts", "PPG", "Wks"]);
  const dak = rowsOf(html).find((r) => r.pid === DAK);
  t.deepEqual(dak.cells, ["107.5", "26.9", "4"], "Wks 1–4 only — never mixed with Week 5");
  t.ok(!dak.live);
});

test("a stored copy that doesn't state its weeks (or is stale) shows NO points rather than a guess", async () => {
  for (const over of [{ finalized_through_week: null }, { stale: true }]) {
    const v = boot({ scores: null, leaderboard: (a) => leaderboard(a, over) });
    const html = await openTab(v, "QB");
    t.match(html, /the stored copy doesn’t say which weeks it covers, so points are hidden rather than guessed/, JSON.stringify(over));
    const purdy = rowsOf(html).find((r) => r.pid === PURDY);
    t.deepEqual(purdy.cells.slice(0, 2), ["—", "—"]);
  }
});

// ═══ 4. Controls ═══
test("column sets: Fantasy pts first; PPG ONLY there; YPC and Targets; Schedule-adjusted, All-MFL usage and XpertRk gone; ≤ 4 numbers each", async () => {
  const v = boot();
  const html = await openTab(v, "WR");
  const sets = [...html.matchAll(/<option value="([a-z]+)"[^>]*>([^<]*)<\/option>/g)].map((m) => m[2]).filter((l) => !/^(All|Rostered|Free agents)$/.test(l));
  t.deepEqual(sets, ["Fantasy pts", "Receiving", "Usage", "Efficiency", "Boom/Bust", "EPA", "Next Gen"], "Routes hidden: its source is empty for 2026");
  const srcNoComments = read("site/m/views/stats.js").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  t.ok(!/XpertRk|SoSΔ|Schedule-adjusted|All-MFL usage|sos-adjusted-points|mfl-market|mrank/.test(srcNoComments), "no XpertRk, Schedule-adjusted or All-MFL usage left in the code (nor their requests)");
  t.deepEqual(labels((await chooseSet(v, "receiving")).head), ["Tgt", "Rec", "RecYd", "RecTD"], "Receiving shows Targets");
  t.deepEqual(labels((await chooseSet(v, "efficiency")).head), ["Tgt%", "Catch%", "Y/R"], "Efficiency: no PPG, no YPRR (no 2026 routes source)");
  await openTab(v, "RB");
  t.deepEqual(labels((await chooseSet(v, "rushing")).head), ["Att", "RuYd", "RuTD", "YPC"], "Rushing shows YPC");
  const boom = await chooseSet(v, "boom");
  t.deepEqual(labels(boom.head), ["Start%", "Boom%", "Bust%", "Played"], "Boom/Bust is measured against UPS starters; availability beside it");
  t.match(boom.notes, /Each week he played vs that week’s UPS starters at his position: Start% = at or above their median, Boom% = top quarter, Bust% = bottom quarter\. A 0\.0 in a game he played counts\./, "plain-language explanation on screen");
  t.match(boom.notes, /<summary>About these numbers<\/summary><div># = PPG rank on actual MFL points, Wks 1–5\. A % needs 3\+ weeks; the count is under it\. Final weeks only \(Wks 1–4\)\. Played = games he played ÷ games his team played; games he didn’t play aren’t graded\.<\/div>/, "short: three sentences behind the tap (Keith: the long version 'will make your head spin')");
  const src = read("site/m/views/stats.js");
  const setBlock = src.slice(src.indexOf("var TABS = ["), src.indexOf("// scope:"));
  let n = 0;
  for (const m of setBlock.matchAll(/id: "([a-z]+)",\s*l: "[^"]*",(?: needs: "[a-z]+",)?\s*cols: \[([^\]]*)\]/g)) {
    n++;
    t.ok(m[2].split(",").length <= 4, "≤ 4 columns: " + m[2]);
    if (m[1] !== "fantasy") t.ok(!/"ppg"|"rcnt"/.test(m[2]), m[1] + " has no PPG");
  }
  t.ok(n >= 20, "checked every set definition (" + n + ")");
});

test("IDP sets: Tackles = Solo · Ast · TFL · Snap% (team snaps in his games); Pass rush = Sk · Press · FF; Coverage = INT · PD · Cmp/Tgt (sorted by targets) · Yds", async () => {
  const lb = (pos) => {
    const b = leaderboard(pos);
    if (pos === "idp") b.rows = b.rows.map((r, i) => Object.assign({}, r, { def_snaps_total: 200 + i, def_snaps_team: 260,
      def_targets: i % 5 === 0 ? null : 20 - (i % 17), def_completions_allowed: i % 5 === 0 ? null : 10 - (i % 9) }));
    return b;
  };
  const v = boot({ leaderboard: lb });
  await openTab(v, "LB");
  const tk = await chooseSet(v, "tackles");
  t.deepEqual(labels(tk.head), ["Solo", "Ast", "TFL", "Snap%"], "Snap% once, on Tackles");
  t.match(tk.head, /title="Solo tackles"/, "the label says Solo: the source counts solo tackles only");
  const r0 = rowsOf(tk.list)[0];
  t.match(r0.cells[3], /^\d+%\d+\/260$/, "Snap% with his snaps / his team's snaps under it");
  t.match(tk.notes, /Snap% = his defensive snaps ÷ his team’s, only in the games he played on defense\./);
  const pr = await chooseSet(v, "passrush");
  t.deepEqual(labels(pr.head), ["Sk", "Press", "FF"], "no snaps on every defensive page");
  t.deepEqual(bands(pr.head), ["nflverse Wk 1–4"], "one band: PFR's charting reaches the app through nflverse, same weeks");
  t.doesNotMatch(pr.head + pr.notes, /pressure rate|win rate/i, "no rate without a pass-rush-snap source");
  const cv = await chooseSet(v, "coverage");
  t.deepEqual(labels(cv.head), ["INT", "PD", "Cmp/Tgt", "Yds"]);
  t.match(cv.notes, /Cmp\/Tgt, Yds and Press are PFR charting via nflverse; — means PFR has no record for him\./);
  t.match(read("site/m/views/stats.js"), /Pressures \(PFR: hurries \+ knockdowns \+ sacks\)\. — when PFR has no record for him\./, "the Press heading's title says it too");
  const head = v.getEl("ups-m-st-head");
  head.fire("click", { target: { closest: () => ({ getAttribute: () => "cmptgt" }) } }); await settle();
  const tg = rowsOf(v.getEl("ups-m-st-listwrap").innerHTML).map((r) => r.cells[2]);
  const nums = tg.filter((c) => c !== "—").map((c) => +c.split("/")[1]);
  t.ok(nums.every((x, i) => i === 0 || nums[i - 1] >= x), "sorted by TARGETS, high to low");
  t.ok(tg.indexOf("—") === -1 || tg.slice(tg.indexOf("—")).every((c) => c === "—"), "no PFR record: last");
});

test("no guessed values (QA 2026-10-11): Cmp/Tgt needs BOTH counts; Played is — when some of his team's games are unknown", async () => {
  const lb = (pos) => {
    const b = leaderboard(pos);
    if (pos === "idp") b.rows = b.rows.map((r, i) => Object.assign({}, r, i === 0 ? { def_targets: 35, def_completions_allowed: null } : { def_targets: 20, def_completions_allowed: 10 }));
    return b;
  };
  const v = boot({ leaderboard: lb });
  await openTab(v, "LB");
  const cv = await chooseSet(v, "coverage");
  const first = leaderboard("idp").rows[0], firstPid = String(parseInt(first.mfl_pid, 10));
  const row = rowsOf(cv.list).find((r) => r.pid === firstPid);
  if (row) t.equal(row.cells[2], "—", "35 targets but no completions count: — (never 0/35)");
  t.doesNotMatch(cv.list, />0\/35</, "never 0/35");
  t.ok(rowsOf(cv.list).some((r) => r.cells[2] === "10/20"), "both counts: shown");

  const qb = Object.keys(FX.players).find((id) => FX.players[id][1] === "QB" && FX.weeks["1"][id] != null);
  const starter = (g) => ({ ok: true, weeks_label: "Wks 1–4", pending_weeks: [],
    players: g === "QB" ? { [qb]: { q: 1, startable_n: 1, boom_n: 0, bust_n: 0, startable_pct: null, boom_pct: null, bust_pct: null, played_n: 1, team_games_n: 1, unknown_n: 3 } } : {} });
  const v2 = boot({ starter });
  await openTab(v2, "QB");
  const b = await chooseSet(v2, "boom");
  const r2 = rowsOf(b.list).find((r) => r.pid === qb);
  t.equal(r2.cells[r2.cells.length - 1], "—", "1 played of 1 KNOWN, 3 unknown: — (never 1/1)");
  t.match(read("site/m/views/stats.js"), /— when some of his team's games have no snap record for him/, "the heading's title says why");
});

test("a partial coverage week says 'in progress' in words, never a '*' and never shown as a full week (QA 2026-10-11; Keith 2026-10-12)", async () => {
  const part = { built_for_week: 5, finalized_through_week: 4, source_coverage: { week: 5, teams_reported: 30, teams_expected: 32, complete: false } };
  const v = boot({ leaderboard: (a) => { const x = leaderboard(a, part); x.rows = x.rows.map((r) => Object.assign({}, r, { rz_v2: 1 })); return x; } });
  await openTab(v, "WR");
  const rc = await chooseSet(v, "receiving");
  t.deepEqual(bands(rc.head).filter((x) => /Wk/.test(x)), ["nflverse Wk 1–5 · in progress"], "a four-column band has room for the source too");
  t.match(rc.notes, /Wk 1–5 · in progress: Wk 5 has 30 of 32 teams in\./);
  const rz = await chooseSet(v, "redzone");
  t.ok(bands(rz.head).some((x) => x === "Red zone Wk 1–5 · in progress"), bands(rz.head).join(" | "));
  // a three-column band (WR Efficiency, 134px) drops the source name, never the "in progress"
  const ef = await chooseSet(v, "efficiency");
  t.deepEqual(bands(ef.head), ["Wk 1–5 · in progress"]);
  t.match(ef.head, /title="nflverse Wk 1–5 · in progress"/, "the full label stays on the band's title");
  // the one-column aDOT band on Next Gen: two lines, and the column is widened to hold them
  const ng = await chooseSet(v, "ngs");
  t.deepEqual(bands(ng.head), ["Next Gen 2026", "Wk 1–5 / in progress"]);
  const cols = /style="--cols:26px minmax\(0,1fr\) ([^"]+)"/.exec(ng.head)[1].split(" ").map((x) => parseInt(x, 10));
  t.ok(cols[3] >= 62, "aDOT column ≥ 62px for 'in progress' (60.0px in WebKit): " + cols.join(","));
  t.equal(/style="--cols:([^"]+)"/.exec(ng.list)[1], /style="--cols:([^"]+)"/.exec(ng.head)[1], "heading and rows share one grid");
  for (const set of ["receiving", "usage", "efficiency", "redzone", "ngs"]) {
    const x = await chooseSet(v, set);
    t.doesNotMatch(x.head + x.notes + x.list, /Wk 1–\d+\*|\* Wk|tgt\*|\(\* =/, set + ": no '*' marker anywhere");
  }
  const done = boot();   // the fixture's board: Wk 4 complete and final
  await openTab(done, "WR");
  const rc2 = await chooseSet(done, "receiving");
  t.deepEqual(bands(rc2.head).filter((x) => /nflverse/.test(x)), ["nflverse Wk 1–4"], "a complete, final week: no 'in progress'");
  t.doesNotMatch(rc2.notes + rc2.head, /in progress/);
});

test("sheet status wording: an id-map failure isn't blamed on the report; a file ahead of MFL's week says so", async () => {
  const src = read("site/m/player_sheet.js");
  t.match(src, /if \(\/id map\/\.test\(r\)\) return "players couldn’t be matched to it \(the NFL id map couldn’t be read\)";/);
  t.match(src, /has no Wk \\d\+ rows/);
});

test("Separation Score (Keith 2026-10-12): Sep+ in signed yards over expected from cushion + depth, by position, with the tracked-target sample under it; 20–29 flagged small; — when an input is missing", async () => {
  // Real 2026 Wk 1–4 inputs (NGS: tracked targets, separation, cushion; box score: targets, air yards).
  const WADDLE = "15284", FANNIN = "17103";
  const skill = leaderboard("skill").rows;
  const wr = skill.filter((r) => r.position === "WR" && ![WADDLE].includes(String(r.mfl_pid))).slice(0, 3);
  const gs = (pid) => "00-T" + pid;
  const box = { [WADDLE]: { targets: 26, rec_air_yds: 277 }, [FANNIN]: { targets: 23, rec_air_yds: 140 },
                [wr[0].mfl_pid]: { targets: 40, rec_air_yds: 400 }, [wr[1].mfl_pid]: { targets: 30, rec_air_yds: null }, [wr[2].mfl_pid]: { targets: 30, rec_air_yds: 300 } };
  const lb = (a) => { const x = leaderboard(a); if (a === "skill") x.rows = x.rows.map((r) => box[String(r.mfl_pid)] ? Object.assign({}, r, { gsis_id: gs(r.mfl_pid) }, box[String(r.mfl_pid)]) : r); return x; };
  const ngs = { [gs(WADDLE)]: { rec: { tgt: 23, sep: 4.22, cush: 8.12 } }, [gs(FANNIN)]: { rec: { tgt: 20, sep: 5.98, cush: 4.62 } },
                [gs(wr[0].mfl_pid)]: { rec: { tgt: 38, sep: 2.6, cush: 6.0 } },          // 38 tracked targets: no small-sample flag
                [gs(wr[1].mfl_pid)]: { rec: { tgt: 28, sep: 3.0, cush: 6.0 } } };        // no air yards → —
  const v = boot({ leaderboard: lb, ngs });
  await openTab(v, "WR");
  const n = await chooseSet(v, "ngs");
  t.deepEqual(labels(n.head), ["Sep+", "Sep", "Cush", "aDOT"], "Separation Score first, then its inputs");
  t.deepEqual(bands(n.head), ["Next Gen 2026", "Wk 1–4"], "aDOT's one-column box-score band reads its weeks, not a cut-off 'nflve…'");
  t.match(n.head, /<span class="band" style="grid-column: span 1" title="nflverse Wk 1–4">Wk 1–4<\/span>/, "full source on the band's title");
  const row = (pid) => rowsOf(n.list).find((r) => r.pid === String(parseInt(pid, 10)));
  const cell = (pid) => { const m = new RegExp('data-pid="' + parseInt(pid, 10) + '">[\\s\\S]*?<span class="v[^"]*">([\\s\\S]*?)</span></span>(?=<span class="v)').exec(n.list); return m ? m[1] : ""; };
  // Waddle: 4.22 − (2.4138 + 0.2291·8.12 − 0.0864·(277/26)) = +0.866 → "+0.9", 23 tracked targets: small sample
  t.deepEqual(row(WADDLE).cells, ["+0.923 tgt", "4.2", "8.1", "10.7"], "Waddle +0.9 yd over 23 tracked targets");
  t.equal(row(WADDLE).flag, "Small sample · 23 targets", "20–29 tracked targets: said in words on his row (Keith 2026-10-12), not a '*'");
  t.match(cell(WADDLE), /title="Sep\+ \+0\.9 yd on 23 tracked targets · Small sample · 23 targets"/, "tooltip: the same words");
  // 38 tracked targets: 2.6 − (2.4138 + 1.3746 − 0.864) = −0.3244 → "−0.3" (a real minus sign), no flag
  t.deepEqual(row(wr[0].mfl_pid).cells, ["−0.338 tgt", "2.6", "6.0", "10.0"], "negative with a minus sign; 30+ tracked targets: no flag");
  t.equal(row(wr[0].mfl_pid).flag, "", "38 tracked targets: no Small sample line");
  t.equal(row(wr[1].mfl_pid).flag, "", "no Sep+ shown (—): no Small sample line either");
  t.match(cell(wr[0].mfl_pid), /class="ups-m-tr dn"/, "below expected reads as down");
  t.deepEqual([row(wr[1].mfl_pid).cells[0], row(wr[1].mfl_pid).cells[3]], ["—", "—"], "no air yards: no aDOT, no Sep+ (never a guessed depth)");
  t.deepEqual(row(wr[2].mfl_pid).cells.slice(0, 3), ["—", "—", "—"], "no Next Gen record (under 20 tracked targets): —");
  t.match(n.notes, /Sep\+ = yards of separation above \(\+\) or below \(−\) what his cushion and target depth predict; under it, tracked targets; 20–29 is marked “Small sample · N targets” on his row\./, "plain: units, sign, sample flag");
  const about = /<summary>About these numbers<\/summary><div>([^<]*)<\/div>/.exec(n.notes)[1];
  // Only the Sep+ explanation is counted: the "who is listed" note (#1214) is its own topic on every set.
  t.match(about, /not pure receiver talent: route mix, coverage, quarterback and team context still show up in it\./, "a descriptive residual, not a talent rating");
  const sepAbout = /Expected separation[^]*?Sep\+ needs 20\+ tracked targets\./.exec(about);
  t.ok(sepAbout && sepAbout[0].split(/(?<=\.)\s/).length <= 3, "the Sep+ explanation is ≤ 3 short sentences: " + about);
  await openTab(v, "TE");
  const nt = await chooseSet(v, "ngs");
  // Fannin (TE fit): 5.98 − (3.481 + 0.1234·4.62 − 0.1323·(140/23)) = +2.734 → "+2.7" on 20 tracked targets — NEVER without the flag
  const f = rowsOf(nt.list).find((r) => r.pid === FANNIN);
  t.deepEqual(f.cells, ["+2.720 tgt", "6.0", "4.6", "6.1"], "Fannin +2.7 over his 20 tracked targets");
  t.equal(f.flag, "Small sample · 20 targets", "Fannin +2.7 always carries the Small sample line");
  t.match(nt.list, /title="Sep\+ \+2\.7 yd on 20 tracked targets · Small sample · 20 targets"/);
  const shown = rowsOf(nt.list).filter((r) => /^\+2\.7/.test(r.cells[0]));
  t.ok(shown.length >= 1 && shown.every((r) => r.cells[0] === "+2.720 tgt" && r.flag === "Small sample · 20 targets"),
    "every +2.7 shown carries '20 tgt' and 'Small sample · 20 targets': " + JSON.stringify(shown.map((r) => [r.cells[0], r.flag])));
  t.doesNotMatch(nt.list + nt.notes + nt.head, /tgt\*|\(\* =|\* = 20/, "no '*' left on the Next Gen set");
});

test("kickers: made/attempted by distance (0–39 · 40–49 · 50+) and FGA; punters: I20 as made/punts plus I20% — no PPG", async () => {
  const v = boot();
  await openTab(v, "PK");
  t.deepEqual(labels((await chooseSet(v, "kicking")).head), ["FGM", "FGA", "FG%", "XPM"]);
  const dist = await chooseSet(v, "distance");
  t.deepEqual(labels(dist.head), ["0–39", "40–49", "50–59", "60+"], "50–59 and 60+ apart (Keith 2026-10-10)");
  const lb = FX.leaderboard.kicker, ix = (k) => lb.cols.indexOf(k);
  const row = lb.rows.find((r) => r[ix("fg_att_60plus")] > 0) || lb.rows.find((r) => r[ix("fg_att_50_59")] > 1);
  const k = rowsOf(dist.list).find((r) => r.pid === String(row[0]));
  t.deepEqual(k.cells, [row[ix("fg_made_0_39")] + "/" + row[ix("fg_att_0_39")], row[ix("fg_made_40_49")] + "/" + row[ix("fg_att_40_49")],
    row[ix("fg_made_50_59")] + "/" + row[ix("fg_att_50_59")], row[ix("fg_made_60plus")] + "/" + row[ix("fg_att_60plus")]]);
  t.match(dist.notes, /Made\/attempted by distance; sorted by attempts\./);
  const head = v.getEl("ups-m-st-head");
  head.fire("click", { target: { closest: () => ({ getAttribute: () => "fg59" }) } }); await settle();
  const att = rowsOf(v.getEl("ups-m-st-listwrap").innerHTML).map((r) => r.cells[2]).filter((c) => c !== "—").map((c) => c.split("/").map(Number));
  t.ok(att.every((x, i) => i === 0 || att[i - 1][1] > x[1] || (att[i - 1][1] === x[1] && att[i - 1][0] >= x[0])), "50–59 sorts by ATTEMPTS, then makes");
  await openTab(v, "PN");
  const pn = await chooseSet(v, "punting");
  t.deepEqual(labels(pn.head), ["Punts", "I20%", "Net"]);
  const pl = FX.leaderboard.punter, pi = (k) => pl.cols.indexOf(k);
  const rows = rowsOf(pn.list);
  t.ok(rows.length >= 30);
  for (const r of rows) {
    const src = pl.rows.find((x) => String(x[0]) === r.pid);
    // I20% with its numerator/denominator under it: "41%" over "9/22"; under 10 punts "—" over the count.
    const n = src[pi("punt_inside20")], d = src[pi("punts")];
    t.equal(r.cells[1], (d >= 10 ? Math.round(n / d * 100) + "%" : "—") + n + "/" + d, "I20% with numerator/denominator");
  }
  t.match(pn.notes, /touchbacks aren’t charged 20 yards/);
});

test("Purdy's 'Sk 0' is four populated Wk 1–4 records, labelled with its period; the most-sacked QB is the positive control", async () => {
  const v = boot();
  await openTab(v, "QB");
  const vol = await chooseSet(v, "volume");
  t.deepEqual(labels(vol.head), ["Att", "Cmp%", "Sk"]);
  t.deepEqual(bands(vol.head), ["nflverse Wk 1–4"], "the sacks column states its weeks");
  const rows = rowsOf(vol.list), qb = FX.leaderboard.qb.rows;
  const purdy = qb.find((r) => String(r.mfl_pid) === PURDY);
  t.equal(purdy.pass_sacks, 0, "the stored board says 0 (the audit traced it to four weekly rows of 0, nflverse sacks_suffered 0 and no sack plays)");
  t.equal(rows.find((r) => r.pid === PURDY).cells[2], "0");
  const top = qb.slice().sort((a, b) => b.pass_sacks - a.pass_sacks)[0];
  t.ok(top.pass_sacks >= 10, "a QB with real sacks exists in the same data");
  t.equal(rows.find((r) => r.pid === String(top.mfl_pid)).cells[2], String(top.pass_sacks), "positive control shows his count, not 0");
});

test("sorting: every data heading sorts the WHOLE filtered list; '—' stays last both ways; ▼/▲ + aria-sort shown; # restores the default", async () => {
  const v = boot();
  await openTab(v, "RB");
  const set = await chooseSet(v, "rushing");
  t.deepEqual(sortState(set.head), ["ruatt:none:⇅", "ruyd:none:⇅", "rutd:none:⇅", "ypc:none:⇅"], "every heading is a sort button");
  const head = v.getEl("ups-m-st-head");
  const tap = async (key) => { head.fire("click", { target: { closest: () => ({ getAttribute: () => key }) } }); await settle(); return { list: v.getEl("ups-m-st-listwrap").innerHTML, head: head.innerHTML }; };
  const s1 = await tap("ypc");
  t.deepEqual(sortState(s1.head).pop(), "ypc:descending:▼");
  const lb = FX.leaderboard.skill, ix = (k) => lb.cols.indexOf(k);
  const all = lb.rows.filter((r) => r[ix("pos_group")] === "RB");
  const ypcOf = (r) => (r[ix("rush_att")] >= 10 ? r[ix("rush_yds")] / r[ix("rush_att")] : null);
  const withVal = all.filter((r) => ypcOf(r) != null).sort((a, b) => ypcOf(b) - ypcOf(a));
  const shown = rowsOf(s1.list);
  t.equal(shown[0].pid, String(withVal[0][0]), "the best YPC in the WHOLE list leads (not just the top 150 by PPG)");
  const firstDash = shown.findIndex((r) => r.cells[3] === "—");
  t.equal(firstDash, withVal.length, "every player with a YPC comes before every '—'");
  t.ok(shown.slice(firstDash).every((r) => r.cells[3] === "—"));
  for (let i = 1; i < firstDash; i++) t.ok(+shown[i - 1].cells[3] >= +shown[i].cells[3], "descending");
  t.match(s1.list, /sorted by YPC, high to low; players without a value are listed last/);
  const s2 = await tap("ypc");
  t.deepEqual(sortState(s2.head).pop(), "ypc:ascending:▲");
  const asc = rowsOf(s2.list);
  t.equal(asc[0].pid, String(withVal[withVal.length - 1][0]), "low to high");
  t.equal(asc.findIndex((r) => r.cells[3] === "—"), withVal.length, "'—' still last when ascending");
  const s3 = await tap("ypc");
  t.deepEqual(sortState(s3.head).pop(), "ypc:none:⇅", "third tap: back to the default order");
  t.equal(rowsOf(s3.list)[0].rk, "1");
  await tap("ruyd");
  const s4 = await tap("");
  t.equal(rowsOf(s4.list)[0].rk, "1", "# puts the default order back");
  await tap("ruyd");
  const sel = v.getEl("ups-m-st-scope"); sel.value = "fa"; sel.fire("change", { target: sel }); await settle();
  const fa = rowsOf(v.getEl("ups-m-st-listwrap").innerHTML);
  t.ok(fa.length > 0 && fa.every((r) => /· FA$/.test(r.tm)), "Free agents only, still sorted");
  for (let i = 1; i < fa.length; i++) if (fa[i].cells[1] !== "—" && fa[i - 1].cells[1] !== "—") t.ok(+fa[i - 1].cells[1] >= +fa[i].cells[1]);
  sel.value = "all"; sel.fire("change", { target: sel }); await settle();
  // the sort holds across a set change only while its column is on screen
  const recv = await chooseSet(v, "receiving");
  t.ok(!/data-sort="ruyd"/.test(recv.head) && /#<i aria-hidden="true">•/.test(recv.head), "a set without that column falls back to the default order");
  await openTab(v, "WR");
  t.ok(!/class="ups-m-st-sort on" data-sort="[a-z]/.test(v.mount.innerHTML), "changing position resets the sort");
});

test("Boom/Bust vs UPS starters: Start% / Boom% / Bust% with counts, joined by MFL id; under 3 weeks the % is '—' and sorts last", async () => {
  const [a, b2, c, d] = FX.leaderboard.qb.rows.slice(0, 4).map((r) => String(r.mfl_pid));
  const groups = [];
  const starter = (g) => { groups.push(g); return { ok: true, weeks_label: "Wks 1–4", pending_weeks: [], players: g !== "QB" ? {} : {
    [a]: { q: 2, startable_n: 2, boom_n: 2, bust_n: 0, startable_pct: null, boom_pct: null, bust_pct: null, played_n: 2, team_games_n: 3 },
    [b2]: { q: 4, startable_n: 3, boom_n: 2, bust_n: 1, startable_pct: 75, boom_pct: 50, bust_pct: 25, played_n: 4, team_games_n: 4 },
    [c]: { q: 3, startable_n: 1, boom_n: 0, bust_n: 2, startable_pct: 33, boom_pct: 0, bust_pct: 67, played_n: 3, team_games_n: 4 },
    [d]: { q: 0, startable_n: 0, boom_n: 0, bust_n: 0, startable_pct: null, boom_pct: null, bust_pct: null, played_n: 0, team_games_n: 0 } } }; };
  const v = boot({ starter });
  await openTab(v, "QB");
  const boom = await chooseSet(v, "boom");
  t.deepEqual(groups, ["QB"], "one request for the tab's lineup group");
  const rows = rowsOf(boom.list), get = (pid) => rows.find((r) => r.pid === pid);
  t.deepEqual(get(a).cells, ["—2/2", "—2/2", "—0/2", "2/3"], "2 weeks: no %, but the counts show; Played = 2 of his team's 3 games");
  t.equal(get(d).cells[3], "—", "no team games to count (0/0): '—', not 0/0");
  t.deepEqual(get(b2).cells, ["75%3/4", "50%2/4", "25%1/4", "4/4"]);
  t.deepEqual(get(c).cells, ["33%1/3", "0%0/3", "67%2/3", "3/4"], "3 weeks is enough");
  t.match(boom.head, /Starters Wks 1–4|vs UPS starters Wks 1–4/, "the band names the pool and the exact weeks");
  const head = v.getEl("ups-m-st-head");
  head.fire("click", { target: { closest: () => ({ getAttribute: () => "sstart" }) } }); await settle();
  const sorted = rowsOf(v.getEl("ups-m-st-listwrap").innerHTML);
  t.deepEqual(sorted.slice(0, 2).map((r) => r.pid), [b2, c], "Start% ▼ — real samples first");
  t.ok(sorted.findIndex((r) => r.pid === a) > 1, "the 2-week player is not on top");
});

test("red zone: shown once the board was rebuilt under 0168 — QB Att/Cmp/TD/Pass%, RB and WR shares with their counts", async () => {
  const lb = (pos) => {
    const b = leaderboard(pos);
    if (pos === "qb") b.rows = b.rows.map((r, i) => Object.assign({}, r, { rz_v2: 1, pass_att_i20: 21 - i, pass_cmp_i20: 18 - i, pass_tds_i20: 7, rush_att_i20: 3, team_rz_dropbacks: 22, team_rz_plays: 45 }));
    if (pos === "skill") b.rows = b.rows.map((r) => Object.assign({}, r, { rz_v2: 1, rush_att_i20: 23, team_rush_att_i20: 28, rz_rush_share: 23 / 28,
      rush_att_i5: 11, team_rush_att_i5: 13, gl_rush_share: 11 / 13, targets_i20: 10, team_targets_i20: 21, rz_target_share: 10 / 21,
      targets_ez: 6, team_targets_ez: 10, ez_target_share: 0.6 }));
    return b;
  };
  const v = boot({ leaderboard: lb });
  await openTab(v, "QB");
  const qb = await chooseSet(v, "redzone");
  t.deepEqual(labels(qb.head), ["Att", "Cmp", "TD", "Tm P%"]);
  t.deepEqual(rowsOf(qb.list)[0].cells.slice(0, 4).length, 4);
  const first = FX.leaderboard.qb.rows[0], fr = rowsOf(qb.list).find((r) => r.pid === String(first.mfl_pid));
  t.deepEqual(fr.cells, ["21", "18", "7", "49%22/45"], "Tm P% = his TEAM's red-zone dropbacks ÷ plays in his games, with its count (Keith 2026-10-10)");
  t.match(qb.notes, /Inside the 20, Wks 1–4; no two-point tries\. Tm P% is his TEAM’s red-zone pass rate in the games he played, not his own split\./);
  t.match(qb.notes, /whoever was at QB: the play-by-play doesn’t say who was at QB on a handoff\./, "the limitation is stated");
  t.doesNotMatch(qb.notes + qb.head, /with him at QB|while he was the QB/, "no 'with him at QB' claim anywhere");
  await openTab(v, "RB");
  const rb = await chooseSet(v, "redzone");
  t.deepEqual(labels(rb.head), ["I20", "I20%", "I5", "I5%"]);
  t.deepEqual(rowsOf(rb.list)[0].cells, ["23", "82%23/28", "11", "85%11/13"]);
  await openTab(v, "WR");
  const wr = await chooseSet(v, "redzone");
  t.deepEqual(labels(wr.head), ["I20", "I20%", "EZ", "EZ%"]);
  t.deepEqual(rowsOf(wr.list)[0].cells, ["10", "48%10/21", "6", "60%6/10"]);
  t.match(wr.notes, /EZ = passes to him that reached the end zone, from anywhere on the field\./);
  // a board NOT rebuilt since 0168 never offers the set (its attempts still include sacks)
  const v2 = boot();
  const html = await openTab(v2, "QB");
  t.doesNotMatch(html, /<option value="redzone">/);
});

test("EPA: per-position play counts (Plays / Car / Tgts) and an 'About' that states the weeks, plays counted, and that these aren't UPS points", async () => {
  const sk = leaderboard("skill").rows;
  const qbRow = FX.leaderboard.qb.rows[0], rbRow = sk.find((r) => r.pos_group === "RB"), wrRow = sk.find((r) => r.pos_group === "WR");
  const epa = { [qbRow.gsis_id]: { pass: { plays: 120, epa: 0.15, cpoe: 3.1, succ: 51.2 } }, [rbRow.gsis_id]: { rush: { plays: 60, epa: -0.02, succ: 41 } },
                [wrRow.gsis_id]: { rec: { tgt: 30, epa: 0.4, succ: 60 } } };
  const v = boot({ epa, epaThrough: 4 });
  await openTab(v, "QB");
  const q = await chooseSet(v, "epa");
  t.deepEqual(labels(q.head), ["EPA", "CPOE", "Succ%", "Plays"]);
  t.deepEqual(bands(q.head), ["nflfastR Wk 1–4"], "the weeks the EPA covers, from the source");
  t.match(q.notes, /NFL play measures from nflfastR play-by-play, regular season Wks 1–4 — not UPS fantasy points\. Rates need 50\+ pass plays\./);
  t.match(q.notes, /EPA \(expected points added\) is how much a play changed the offense’s expected points[^<]*EPA\/play = the total EPA of his pass plays ÷ his pass plays\. Pass plays \(Plays\) = his box score’s pass attempts \(spikes count as attempts\) plus sacks\. Two-point tries, scrambles \(they’re runs\) and plays wiped out by a penalty don’t count\./);
  t.match(q.notes, /Success% = the same pass plays with EPA above zero ÷ those pass plays\./, "Success over exactly the EPA plays");
  t.doesNotMatch(q.notes, /two-point tries included/, "one definition: two-point tries are out everywhere");
  await openTab(v, "RB");
  const r = await chooseSet(v, "epa");
  t.deepEqual(labels(r.head), ["EPA", "Succ%", "Car"]);
  t.match(r.notes, /as his box score counts them \(kneel-downs included\)\. Two-point runs and plays wiped out by a penalty don’t count; passes thrown to him aren’t included\./);
  await openTab(v, "WR");
  const w = await chooseSet(v, "epa");
  t.deepEqual(labels(w.head), ["EPA", "Succ%", "Tgts"]);
  t.match(w.notes, /Receiving EPA gives him the whole EPA of every pass thrown to him — complete, incomplete or intercepted — the same EPA the passer gets/);
});

test("Routes appears once its source has rows", async () => {
  const v = boot({ routes: { "00-0000001": { routes: 100 } } });
  const html = await openTab(v, "WR");
  t.match(html, /<option value="routes">Routes<\/option>/);
});

// ═══ 5. Ownership — the list and the sheet agree; owner unknown is never offered Bid / Add ═══
test("the app's ownership rule: no player id is 'owner unknown' (it read as a confirmed FA whenever rosters were complete)", () => {
  const v = boot();
  const own = (id) => JSON.parse(JSON.stringify(v.M.data.ownerOfPid(id)));   // plain objects across the vm realm
  t.deepEqual(own(""), { known: false, free: false, fid: "" });
  t.deepEqual(own(null), { known: false, free: false, fid: "" });
  t.deepEqual(own(LOCK), { known: true, free: true, fid: "" }, "a confirmed free agent");
  t.equal(own(PURDY).name, "Blake Bombers");
  t.equal(read("site/m/views/stats.js").includes("UPS_MOBILE_OWNERSHIP"), false, "no second copy of the rule");
});

const rosterStates = {
  "rosters unreadable": { rosters: null },
  "empty rosters response": { rosters: { rosters: {} } },
  "Blake Bombers' roster missing (partial)": { rosters: rostersPayload((r) => { r.franchise = r.franchise.filter((f) => f.id !== "0010"); }) },
  "a franchise listed with no players": { rosters: rostersPayload((r) => { r.franchise.find((f) => f.id === "0010").player = []; }) },
  "league franchise list unavailable": { franchises: [] },
};
for (const [label, opt] of Object.entries(rosterStates)) {
  test("OWNER UNKNOWN (" + label + "): list and sheet agree, and the sheet offers NO Bid / Add — for a free agent either", async () => {
    const v = boot(opt);
    const rows = rowsOf(await openTab(v, "QB"));
    for (const pid of [PURDY, LOCK]) {
      const row = rows.find((r) => r.pid === pid);
      v.ctx.UPS_MOBILE.sheet.open(pid);
      const foot = v.getEl("ups-m-sheet-foot").innerHTML, head = v.getEl("ups-m-sheet-head").innerHTML;
      if (/· owner unknown$/.test(row.tm)) {
        t.match(head, /ups-m-own-chip unk">Owner unknown</, FX.players[pid][0] + " chip");
        t.doesNotMatch(foot, /waiver-bid|waiver-add|propose-trade/, FX.players[pid][0] + ": no acquisition, no trade");
        t.match(foot, /Ownership unknown — .* No add or bid until MFL’s rosters load/);
      } else {
        // positive evidence (found on a roster that DID load) still shows its owner
        t.ok(!/FA$/.test(row.tm), FX.players[pid][0] + " is never FA while rosters are incomplete: " + row.tm);
      }
    }
    t.ok(rows.find((r) => r.pid === LOCK).tm.endsWith("owner unknown"), "Drew Lock is not called FA on a guess");
  });
}

test("confirmed free agent: the existing Bid flow is unchanged; another team's player gets Propose trade (no Bid); own player keeps Block/Drop", async () => {
  const v = boot();
  const S = v.ctx.UPS_MOBILE.sheet;
  S.open(LOCK);
  t.match(v.getEl("ups-m-sheet-head").innerHTML, /ups-m-own-chip fa">Free agent</);
  t.match(v.getEl("ups-m-sheet-foot").innerHTML, /data-act="waiver-bid"/);
  t.match(v.getEl("ups-m-sheet-foot").innerHTML, /Blind bids run Sat Oct 10, 9:00 AM ET/);
  S.open(PURDY);
  t.match(v.getEl("ups-m-sheet-head").innerHTML, /ups-m-own-chip other">Blake Bombers</);
  const foot = v.getEl("ups-m-sheet-foot").innerHTML;
  t.match(foot, /data-act="propose-trade" data-fid="0010" data-pid="15698">Propose trade to Blake Bombers</);
  t.doesNotMatch(foot, /waiver-bid|waiver-add|data-act="drop"/);
  S.open(DAK);
  t.match(v.getEl("ups-m-sheet-head").innerHTML, /ups-m-own-chip mine">Your team</);
  t.match(v.getEl("ups-m-sheet-foot").innerHTML, /data-act="otb"[\s\S]*data-act="drop"/);
  t.doesNotMatch(v.getEl("ups-m-sheet-foot").innerHTML, /propose-trade/);
});

test("Propose trade opens the EXISTING builder with that player preloaded — and sends nothing", async () => {
  const v = boot();
  v.ctx.UPS_MOBILE.sheet.open(PURDY);
  await settle();
  const before = v.requests.length;
  v.getEl("ups-m-sheet-foot").querySelector('[data-act="propose-trade"]').click();
  await settle();
  t.equal(v.builderCalls.length, 1);
  t.equal(v.builderCalls[0].toFid, "0010"); t.equal(v.builderCalls[0].preGetPid, PURDY);
  t.deepEqual(v.requests.slice(before), [], "no request at all from the tap");
  t.ok(!v.getEl("ups-m-sheet-overlay").classList.contains("open"), "the sheet closes under the builder");
});

test("no player id ever reaches 'Propose trade' without a viewer team (the builder needs one)", () => {
  const v = boot({ viewer: "" });
  v.ctx.UPS_MOBILE.sheet.open(PURDY);
  t.doesNotMatch(v.getEl("ups-m-sheet-foot").innerHTML, /propose-trade/);
});

// ═══ 7. Opening a player never calls a write route (the ERA dry-run probe is gone) ═══
test("opening ANY player — own (incl. an ERA contract), another team's, free agent, owner unknown — makes NO non-GET request", async () => {
  const eraRosters = rostersPayload((r) => { r.franchise.find((f) => f.id === "0008").player.find((p) => p.id === DAK).contractStatus = "Vet-ERA"; });
  for (const opt of [{}, { rosters: eraRosters }, { rosters: null }]) {
    const v = boot(opt);
    for (const pid of [DAK, PURDY, LOCK, MASON]) { v.ctx.UPS_MOBILE.sheet.open(pid); await settle(); }
    const writes = v.requests.filter((r) => r.method !== "GET" || /roster-workbench\/action|waivers\/(fcfs|bbid)|trades/.test(r.url));
    t.deepEqual(writes, [], "no write-route request on open");
  }
  t.doesNotMatch(read("site/m/player_sheet.js"), /gateEraRetentionDrop\s*\(/, "the on-open dry-run probe is gone");
});

test("the real drop is still ERA-protected server-side: the worker gates drop_player/unload_player BEFORE its dry-run branch and MFL", () => {
  const W = read("worker/src/index.js");
  const gate = W.indexOf('if (action === "drop_player" || action === "unload_player") {\n          const eraGate = await _eraRetentionBlocked(');
  const dry = W.indexOf("const actionDryRunFlag = (() => {", gate);
  t.ok(gate > 0, "the ERA gate is in the roster action route");
  t.ok(dry > gate, "…ahead of the dry-run short-circuit (and so of every MFL call after it)");
  t.match(W.slice(gate, dry), /code: "ERA_FORCED_RETENTION"/);
  const S = read("site/m/player_sheet.js");
  t.match(sliceFn(S, "function handleDrop("), /showToast\("Drop failed: " \+ \(err && err\.message \|\| err\)/, "its refusal reaches the owner");
});

// ═══ 5b. Contract money from the worker's cap row — never ÷17 ═══
const bodyOf = (v, pid) => { v.ctx.UPS_MOBILE.sheet.open(pid); return v.getEl("ups-m-sheet-body").innerHTML.replace(/&amp;/g, "&"); };
const kv = (html) => Object.fromEntries([...html.matchAll(/<div class="lbl[^"]*">([^<]*)<\/div><div class="val[^"]*">([^<]*)/g)].map((m) => [m[1], m[2]]));

// The worked examples (agent review 2026-10-10, canon §D1/§6.C1/§C5.1): remaining guaranteed =
// max(0, 75% × TCV − all salary earned under the contract) = the cap engine's `penalty` for the
// standard rule — NOT "salary − this season's earned".
const moneyOf = (v, pid) => { v.ctx.UPS_MOBILE.sheet.open(pid); const b = v.getEl("ups-m-sheet-body").innerHTML.replace(/&amp;/g, "&"); return { body: b, f: kv(b), years: yearRows(b) }; };
const yearRows = (html) => [...html.matchAll(/<tr(?: class="[^"]*")?><td>(\d{4}|Total)<\/td>([\s\S]*?)<\/tr>/g)].map((m) => [m[1], ...[...m[2].matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map((x) => x[1])]);

test("REMAINING GUARANTEED, whole contract: Purdy $17,824 — year by year, adding up to the cap engine's figure, with the arithmetic", () => {
  const v = boot();
  const { body, f, years } = moneyOf(v, PURDY);
  t.equal(f["Remaining guaranteed"], "$17,824");
  t.match(body, /of \$63,000 guaranteed \(75% of \$84,000\)/);
  t.equal(f["Earned so far"], "$45,176");
  t.match(body, /2025 \$40,000 · 2026 \$5,176 thru Wk 4/);
  t.deepEqual(years, [["2025", "40,000", "40,000", "40,000", "0"], ["2026", "22,000", "5,176", "22,000", "16,824"],
    ["2027", "22,000", "0", "1,000", "1,000"], ["Total", "84,000", "45,176", "63,000", "17,824"]]);
  t.equal(f["2026 salary"], "$22,000"); t.equal(f["Earning window"], "Wks 1–17 · 17 wks"); t.equal(f["Per week"], "≈ $1,294", "rounded: the engine's earned is the exact sum");
  t.equal(f["Earned this season"], "$5,176 · thru Wk 4");
  t.match(body, /Guaranteed = 75% of the \$84,000 total value = \$63,000\. Earned counts each finished season in full \(\$40,000\) plus this season by completed week: \$22,000 × 4 ÷ 17 = \$5,176 \(this season’s earning window: Wks 1–17\)\. Remaining guaranteed = \$63,000 − \$45,176 = \$17,824, what cutting him now would cost before the team’s rounding\. By year the guarantee is used up in order, leaving 2026 \$16,824 and 2027 \$1,000\. League cap engine, calculated Oct \d+, \d{1,2}:\d{2} (AM|PM)\./);
  t.doesNotMatch(body, /Still due this season/, "the one-season figure is gone");
});

test("Keith's $88,000 (Josh Allen, one year): remaining guaranteed $45,294 — never $88,000 − this season's earned ($67,294)", () => {
  const { body, f, years } = moneyOf(boot(), "13589");
  t.equal(f["Remaining guaranteed"], "$45,294");
  t.match(body, /of \$66,000 guaranteed \(75% of \$88,000\)/);
  t.deepEqual(years, [["2026", "88,000", "20,706", "66,000", "45,294"], ["Total", "88,000", "20,706", "66,000", "45,294"]], "a one-year deal's only year is this season's salary");
  t.doesNotMatch(body, /67,294/);
});

test("every contract shape matches the cap engine: back-loaded, restructured, rookie option, waiver window, bare tokens, flat and $0 rules", () => {
  const cases = [
    ["14777", "Burrow (back-loaded)", "$80,412", [["2026", "28,000", "6,588", "28,000", "21,412"], ["2027", "88,000", "0", "59,000", "59,000"]]],
    ["15281", "Chase (restructured)", "$90,632", [["2026", "26,000", "6,118", "26,000", "19,882"], ["2027", "103,000", "0", "70,750", "70,750"]]],
    ["17042", "Jeanty (rookie)", "$15,221", [["2025", "15,000", "15,000", "15,000", "0"], ["2026", "15,000", "3,529", "15,000", "11,471"], ["2027", "15,000", "0", "3,750", "3,750"]]],
    ["16601", "Shipley (Week-5 waiver)", "$8,250", [["2026", "11,000", "0", "8,250", "8,250"]]],
    ["12263", "Waller (Week-3 waiver)", "$3,083", [["2026", "5,000", "667", "3,750", "3,083"]]],
    ["12620", "Prescott (one year)", "$32,426", null],
    ["14778", "Tua (guarantee fully earned)", "$0", null],
    ["15799", "Ferguson (bare Y1-11 tokens)", "$8,059", [["2025", "11,000", "11,000", "11,000", "0"], ["2026", "21,000", "4,941", "13,000", "8,059"]]],
  ];
  const v = boot();
  for (const [pid, who, amt, yrs] of cases) {
    const { body, f, years } = moneyOf(v, pid);
    t.equal(f["Remaining guaranteed"], amt, who);
    t.equal(f["Remaining guaranteed"], "$" + FX.cap_rows[pid].penalty.toLocaleString("en-US"), who + " = the engine's penalty");
    if (yrs) t.deepEqual(years.filter((y) => y[0] !== "Total" && y.length === 5), yrs, who + " by year");
    t.doesNotMatch(body, /Still due this season/);
  }
  const jeanty = moneyOf(v, "17042");
  t.match(jeanty.body, /<tr class="opt"><td>2028<\/td><td>20,000<\/td><td colspan="3">option — not exercised<\/td><\/tr>/, "the rookie option year is not part of the contract");
  const ship = moneyOf(v, "16601");
  t.equal(ship.f["Earning window"], "Wks 5–17 · 13 wks"); t.equal(ship.f["Per week"], "≈ $846", "$11,000 ÷ 13, never ÷ 17");
});

test("the other rules say what they are: taxi $0, sub-$5K flat $1,000 (DeJean: not $529), small waiver deal $0", () => {
  const v = boot();
  const corum = moneyOf(v, "16593");
  t.equal(corum.f["Remaining guaranteed"], "$0"); t.match(corum.body, /Taxi-squad players carry no guarantee/);
  // a temporary call-up is on the active roster: never "while on the taxi squad"
  const callup = moneyOf(boot({ capRows: Object.assign({}, FX.cap_rows, { "16593": Object.assign({}, FX.cap_rows["16593"], { basis: "taxi_callup_exempt" }) }) }), "16593");
  t.equal(callup.f["Remaining guaranteed"], "$0");
  t.match(callup.body, /A taxi player on a temporary call-up, never permanently promoted, still carries no guarantee/);
  t.doesNotMatch(callup.body, /while on the taxi squad/);
  // earned already past the guarantee: no "$87,000 − $104,529 = $0"
  const tua = moneyOf(v, "14778");
  t.match(tua.body, /Earned \$104,529 already covers the \$87,000 guarantee, so remaining guaranteed is \$0\./);
  t.doesNotMatch(tua.body, /\$87,000 − \$104,529/);
  const watson = moneyOf(v, "13113");
  t.equal(watson.f["Remaining guaranteed"], "$1,000 flat"); t.match(watson.body, /\$1,000-a-year contract costs a flat \$1,000/);
  const dejean = moneyOf(v, "16675");
  t.equal(dejean.f["Remaining guaranteed"], "$1,000 flat"); t.doesNotMatch(dejean.body, /\$529/);
  const fant = moneyOf(v, "14137");
  t.equal(fant.f["Remaining guaranteed"], "$0"); t.match(fant.body, /waiver deal of \$4K or less carries no guarantee/);
});

test("unpriceable → a stated reason, never a local estimate (and a split that doesn't add up is never shown)", () => {
  const cases = [
    [{ capMeta: null }, /Loading the remaining guarantee from the league cap engine/],
    [{ capMeta: { status: "error" } }, /couldn’t be reached\. Reload to retry; this block shows no estimate in its place/],
    [{ capRows: {} }, /isn’t in the league cap engine’s list/],
    [{ capRows: { [PURDY]: Object.assign({}, FX.cap_rows[PURDY], { needs_review: true, review_reason: "unstamped contract" }) } }, /under review \(unstamped contract\)/],
    [{ capRows: { [PURDY]: Object.assign({}, FX.cap_rows[PURDY], { penalty: 1 }) } }, /figures for this contract don’t reconcile/],
    [{ capRows: { [PURDY]: Object.assign({}, FX.cap_rows[PURDY], { basis: "something_new" }) } }, /a rule this screen doesn’t describe \(something_new\)/],
  ];
  for (const [opt, re] of cases) {
    const { body, f } = moneyOf(boot(opt), PURDY);
    t.match(body, re, JSON.stringify(opt).slice(0, 60));
    t.equal(f["Remaining guaranteed"], undefined, "no figure");
    t.doesNotMatch(body, /\$17,824|\$1,294|\$5,176/, "nothing computed locally");
  }
  // a schedule that doesn't sum to TCV: totals stay (the engine's), the year split is hidden
  const bad = rostersPayload((r) => { const p = r.franchise.flatMap((f) => f.player).find((x) => x.id === PURDY); p.contractInfo = "CL 3| TCV 84K| AAV 28K| Y1-40K, Y2-22K"; });
  const m = moneyOf(boot({ rosters: bad }), PURDY);
  t.equal(m.f["Remaining guaranteed"], "$17,824");
  t.equal(m.years.length, 0); t.match(m.body, /year-by-year schedule for this contract is incomplete/);
});

// ═══ 5c. Weekly game log (Stats tab) ═══
async function gameLog(v, pid) {
  v.ctx.UPS_MOBILE.sheet.open(pid);
  await settle();
  v.getEl("ups-m-sheet-tabs").fire("click", { target: { closest: () => ({ getAttribute: () => "stats" }) } });
  await settle(); await settle();
  const html = v.getEl("ups-m-sheet-body").innerHTML;
  const t0 = html.indexOf('class="ups-m-gl-table"');
  const rows = t0 < 0 ? [] : [...html.slice(t0).matchAll(/<tr class="([^"]*)"(?: title="[^"]*")?><td>(\d+)(?: <small>([^<]*)<\/small>)?<\/td><td class="pts">([\s\S]*?)<\/td>([\s\S]*?)<\/tr>/g)]
    .map((m) => ({ cls: m[1], wk: +m[2], opp: m[3] || "", pts: m[4].replace(/<span class="ups-m-gl-live"[^>]*><\/span>/, "●"), stats: [...m[5].matchAll(/<td>([^<]*)<\/td>/g)].map((x) => x[1]) }));
  return { html, rows, wk: (n) => rows.find((r) => r.wk === n), head: (/<table class="ups-m-gl-table"><thead><tr>([\s\S]*?)<\/tr>/.exec(html) || [])[1] || "" };
}
test("game log: every week of the season — MFL points per week (= W=ALL), that week's box score from the bundle, ● on the week in progress", async () => {
  const v = boot();
  const g = await gameLog(v, PURDY);
  t.deepEqual(g.rows.map((r) => r.wk), [5, 4, 3, 2, 1], "most recent week first");
  t.match(g.html, /<div class="ups-m-gl-wrap"><table class="ups-m-gl-table">/, "the table scrolls inside its own box if it ever outgrows the sheet");
  for (const r of g.rows.filter((x) => x.wk <= 4)) t.equal(r.pts, Number(FX.weeks[String(r.wk)][PURDY]).toFixed(1), "Wk " + r.wk + " = MFL's own score");
  const b4 = FX.bundles[PURDY].nfl_weekly.find((x) => x.week === 4);
  t.match(g.head, /<th>Yds<\/th><th>PaTD<\/th><th>Int<\/th><th>Rush<\/th>/, "QB: Yds · PaTD · Int · Rush (fits 320px; says the TDs are passing ones)");
  t.deepEqual(g.wk(4).stats, [String(b4.pass_yds), String(b4.pass_tds), String(b4.pass_ints), b4.rush_att + "-" + b4.rush_yds]);
  t.equal(g.wk(4).opp, b4.opponent);
  t.deepEqual([g.wk(5).pts, g.wk(5).cls], ["—", "dim"], "Wk 5 in progress and SF hasn't played: not called DNP");
  t.match(g.html, /Pts: actual MFL points, UPS scoring, Wks 1–5 \(● Wk 5 in progress\)\. Box score: nflverse; his latest row is Wk 4\./);
  // a live-week score is marked; its box score waits for the nflverse refresh
  const aub = await gameLog(v, "16414");
  const w5 = aub.rows.find((r) => r.wk === 5);
  t.equal(w5.pts, Number(FX.weeks["5"]["16414"]).toFixed(1) + "●");
  t.deepEqual(w5.stats, ["—", "—"], "kicker: FG · XP — no Week 5 box score yet");
  t.match(aub.head, /<th>FG<\/th><th>XP<\/th>/);
  const watt = await gameLog(v, "13214");
  t.match(watt.head, /<th>Solo<\/th><th>Ast<\/th><th>Sk<\/th><th>TFL<\/th>/, "IDP columns");
});

test("game log: MFL points show while the box score loads, and a failed bundle says so instead of 'Loading…' forever", async () => {
  const held = await gameLog(boot({ bundle: "hold" }), PURDY);
  t.match(held.html, /Loading season history…/);
  t.deepEqual(held.rows.map((r) => r.wk), [5, 4, 3, 2, 1], "the weekly points don't wait for the bundle");
  t.equal(held.wk(4).pts, Number(FX.weeks["4"][PURDY]).toFixed(1));
  t.deepEqual(held.wk(4).stats, ["…", "…", "…", "…"], "box cells say they're loading");
  t.match(held.html, /Loading the box score…/);
  const failed = await gameLog(boot({ bundle: "fail" }), PURDY);
  t.match(failed.html, /Season history couldn’t be loaded — close and reopen to retry\./);
  t.match(failed.html, /Box score couldn’t be loaded — close and reopen to retry\./);
  t.equal(failed.wk(4).pts, Number(FX.weeks["4"][PURDY]).toFixed(1), "points still shown");
  t.deepEqual(failed.wk(4).stats, ["—", "—", "—", "—"]);
  t.doesNotMatch(failed.html, /Loading/);
});
test("game log: a player whose bundle has no NFL stat rows (e.g. an unmatched rookie) is told so — never 'No box score yet this season'", async () => {
  const pid = Object.keys(FX.players).find((id) => !FX.bundles[id] && FX.players[id][1] === "WR" && FX.weeks["1"][id] != null && FX.weeks["2"][id] != null);
  const g = await gameLog(boot(), pid);
  t.match(g.html, /Box score isn’t linked for him: the player data has no NFL stat rows under his ID \(often a rookie not yet matched\), so only MFL points show\./);
  t.doesNotMatch(g.html, /No box score yet this season/);
  t.equal(g.wk(1).pts, Number(FX.weeks["1"][pid]).toFixed(1), "his MFL points still show");
});
test("game log via the verified id map: a rookie's box score, '0 snp' when his team played without him, and a Red zone view", async () => {
  const pid = Object.keys(FX.players).find((id) => !FX.bundles[id] && FX.players[id][1] === "TE" && FX.weeks["1"][id] != null && FX.weeks["2"][id] != null);
  const wk = (w, tgt, snapsOff, rz) => ({ week: w, box: tgt == null ? null : { week: w, opponent: "NYJ", targets: tgt, receptions: tgt - 1, rec_yds: 10 * tgt, rec_tds: 0 },
    snaps: snapsOff == null ? null : { team: "XXX", off: snapsOff, def: 0, st: 0 }, redzone: rz || null });
  const weeklyBox = (m) => ({ ok: true, mfl_id: m, gsis_id: "00-ROOKIE", pfr_id: "RookRo00", id_source: "player_id_map:verified", box_through_week: 4,
    weeks: [wk(1, 3, 28, { targets_i20: 1, rec_i20: 1, rec_tds_i20: 1, targets_ez: 1 }), wk(2, 4, 30), wk(4, 2, 20),
            // Wk 5: red-zone rows already in (Thursday's game) but the box score covers Wks 1–4
            wk(5, null, 31, { targets_i20: 2, rec_i20: 1, rec_tds_i20: 1, targets_ez: 1 })] });
  const v = boot({ weeklyBox });
  const g = await gameLog(v, pid);
  t.deepEqual(g.wk(1).stats, ["3", "2", "30", "0"], "the bundle had nothing for him; the weekly route does");
  t.match(g.html, /<th>Tgt<\/th><th>Rec<\/th><th>Yds<\/th><th>RecTD<\/th>/, "the TD column says it counts receiving TDs (QA 2026-10-11)");
  t.match(g.html, /Box score: nflverse, Wks 1–4\./);
  t.doesNotMatch(g.html, /isn’t linked/);
  // Wk 3: no MFL score; his snap data exists (pfr) but has no row that week while the source covers it → his team played without him
  if (FX.weeks["3"][pid] == null) t.deepEqual([g.wk(3).pts, g.wk(3).cls], ["0 snp", "dnp"]);
  // Red zone view
  const body = v.getEl("ups-m-sheet-body");
  body.fire("click", { target: { closest: () => ({ getAttribute: () => "rz" }) } }); await settle();
  const rz = await (async () => { const html = body.innerHTML; const t0 = html.indexOf('class="ups-m-gl-table"');
    return [...html.slice(t0).matchAll(/<tr class="([^"]*)"(?: title="[^"]*")?><td>(\d+)(?: <small>[^<]*<\/small>)?<\/td><td class="pts">[\s\S]*?<\/td>([\s\S]*?)<\/tr>/g)]
      .map((m) => [+m[2], [...m[3].matchAll(/<td>([^<]*)<\/td>/g)].map((x) => x[1])]); })();
  t.match(body.innerHTML, /<th>Tgt<\/th><th>Rec<\/th><th>TD<\/th><th>EZ<\/th>/, "TE red-zone columns");
  t.deepEqual(rz.find((r) => r[0] === 1)[1], ["1", "1", "1", "1"]);
  t.deepEqual(rz.find((r) => r[0] === 2)[1], ["0", "0", "0", "0"], "a box score with no red-zone row = no red-zone plays (0)");
  const r5 = rz.find((r) => r[0] === 5);
  if (r5) t.deepEqual(r5[1], ["—", "—", "—", "—"], "past the box score's Wks 1–4: — even though red-zone rows exist (QA 2026-10-11)");
  t.ok(FX.weeks["5"][pid] == null || r5, "Wk 5 row is checked when he has a Wk 5 row");
  t.match(body.innerHTML, /Red zone: inside the opponent’s 20; two-point tries excluded; sacks are not attempts\./);
});

test("game log: a player with no verified NFL id says so; and an undeployed weekly route falls back to the bundle", async () => {
  const pid = Object.keys(FX.players).find((id) => !FX.bundles[id] && FX.players[id][1] === "WR" && FX.weeks["1"][id] != null);
  const g = await gameLog(boot({ weeklyBox: (m) => ({ ok: true, mfl_id: m, gsis_id: null, pfr_id: null, id_source: "none", box_through_week: 4, weeks: [] }) }), pid);
  t.match(g.html, /Box score unavailable: no verified NFL id for this player, so only MFL points show\./);
  const g2 = await gameLog(boot({ weeklyBox: 404 }), PURDY);
  const b4 = FX.bundles[PURDY].nfl_weekly.find((x) => x.week === 4);
  t.equal(g2.wk(4).stats[0], String(b4.pass_yds), "route not deployed: the bundle's box score, as before");
  t.doesNotMatch(g2.html, /data-glview/, "no Red zone view without the route");
});

test("QA fixes: 'About' closes on a new set; a loss reads 3-(−3); no '0 snp' for a player with no NFL team", async () => {
  const v = boot();
  await openTab(v, "QB");
  await chooseSet(v, "boom");
  v.getEl("ups-m-st-notes").fire("click", { target: { closest: (q) => (q === "summary" ? {} : null) } }); await settle();
  v.getEl("ups-m-st-search").fire("input", { target: { value: "" } }); await settle();   // a repaint keeps it open
  t.match(v.getEl("ups-m-st-notes").innerHTML, /<details class="ups-m-st-more" open>/, "opened");
  const ep = await chooseSet(v, "epa");
  t.doesNotMatch(ep.notes, /<details class="ups-m-st-more" open>/, "closed again on the next set (it pushed rows off a 568-px screen)");
  const pid = Object.keys(FX.players).find((id) => !FX.bundles[id] && FX.players[id][1] === "RB" && FX.weeks["1"][id] != null);
  const g = await gameLog(boot({ weeklyBox: (m) => ({ ok: true, mfl_id: m, gsis_id: "00-RB", pfr_id: "RbRb00", id_source: "player_id_map:verified", box_through_week: 4,
    weeks: [{ week: 1, box: { week: 1, opponent: "NYJ", rush_att: 3, rush_yds: -3, receptions: 0, rec_yds: 0, rush_tds: 0, rec_tds: 0 }, snaps: null, redzone: null }] }) }), pid);
  t.equal(g.wk(1).stats[0], "3-(−3)");
  t.ok(!g.rows.some((r) => r.pts === "0 snp"), "no snap rows all season = no NFL team: never '0 snp'");
  t.doesNotMatch(g.html, /0 snp = his team played/);
});

test("game log: BYE on his team's bye week (MFL's list), DNP for a finished week with no MFL score; bye list unreadable → says so", async () => {
  const v = boot();
  // Week 5 byes: CAR and KCC. A CAR player with a score in earlier weeks:
  const car = Object.keys(FX.players).find((id) => FX.players[id][2] === "CAR" && FX.players[id][1] === "QB" && FX.weeks["1"][id] != null);
  const gb = await gameLog(v, car);
  t.deepEqual([gb.wk(5).pts, gb.wk(5).cls], ["BYE", "bye"]);
  // a player missing from a FINISHED week that wasn't his bye
  const byes = Object.fromEntries(FX.byes.map((b) => [b.id, +b.bye_week]));
  const dnp = Object.keys(FX.players).find((id) => FX.weeks["1"][id] != null && FX.weeks["2"][id] == null && FX.weeks["3"][id] != null &&
    byes[FX.players[id][2]] !== 2 && ["QB", "RB", "WR", "TE"].includes(FX.players[id][1]));
  const gd = await gameLog(v, dnp);
  t.deepEqual([gd.wk(2).pts, gd.wk(2).cls], ["DNP", "dnp"], FX.players[dnp][0] + " Wk 2");
  const v2 = boot({ byes: null });
  const gn = await gameLog(v2, car);
  t.match(gn.html, /Bye weeks couldn’t be read, so a week without a score shows —, not DNP/);
  t.deepEqual([gn.wk(5).pts, gn.wk(5).cls], ["—", "dim"], "bye list unreadable: his bye isn't called DNP");
  t.ok(!gn.rows.some((r) => r.pts === "DNP"), "…and no week is");
});

// ═══ 3b. Layout guards (the rendered geometry was measured in the browser at 320 / 375px — see the PR) ═══
test("layout: the pinned chips + headings sit BELOW the League tabs; the old shared-offset sticky toolbar is gone from Players", () => {
  t.match(CSS, /\.ups-m-st-pin \{\s*position: sticky;\s*top: calc\(var\(--hdr-h\) \+ var\(--safe-top\) \+ var\(--st-subtabs-h, 41px\)\);/);
  t.match(CSS, /\.ups-m-stseg-bar ~ \.ups-m-players-toolbar \{ top: calc\(var\(--hdr-h\) \+ var\(--safe-top\) \+ var\(--st-subtabs-h, 41px\)\)/, "the other boards' toolbars too");
  t.doesNotMatch(CSS, /\.ups-m-st-scroll/, "no overflow-x wrapper (it stopped the headings sticking)");
  t.match(CSS, /\.ups-m-stseg-bar\.six \{[^}]*overflow-x: auto/);
  t.match(CSS, /\.ups-m-stseg-bar\.six \.ups-m-stseg \{ flex: 0 0 auto; font-size: 13px;/, "13px Stats tabs (were 9px)");
  for (const m of CSS.matchAll(/\.ups-m-st-row[^{]*\{[^}]*font-size: (\d+(?:\.\d+)?)px/g)) t.ok(+m[1] >= 11, "Stats list text ≥ 11px: " + m[0].slice(0, 50));
});

// ═══ 6. Round 4 (Keith 2026-10-10): playing time, status chips, kicker counts ═══
const JSN = "16185", LAMB = "14832", OLAVE = "15754", WALKER = "15711";
test("Usage (WR/TE/RB): Snaps · Snap% over his team's offensive snaps in HIS games · Tgt — '—' when a denominator or record is missing, never 0%", async () => {
  const lb = (pos) => {
    const b = leaderboard(pos);
    if (pos === "skill") b.rows = b.rows.map((r) => {
      const id = String(r.mfl_pid);
      if (id === JSN) return Object.assign({}, r, { off_snaps_total: 203, off_snaps_team: 247, off_games: 4 });
      if (id === LAMB) return Object.assign({}, r, { off_snaps_total: 216, off_snaps_team: null, off_games: 4 });   // a game without a team total
      if (id === OLAVE) return Object.assign({}, r, { off_snaps_total: null, off_snaps_team: null });                   // no snap record
      if (id === WALKER) return Object.assign({}, r, { off_snaps_total: 180, off_snaps_team: 260 });
      return r;
    });
    return b;
  };
  const v = boot({ leaderboard: lb });
  await openTab(v, "WR");
  const u = await chooseSet(v, "usage");
  t.deepEqual(labels(u.head), ["Snaps", "Snap%", "Tgt", "Tgt%"]);
  t.deepEqual(bands(u.head), ["nflverse Wk 1–4"], "period and source on the band");
  const rows = rowsOf(u.list), get = (id) => rows.find((r) => r.pid === id);
  t.deepEqual(get(JSN).cells.slice(0, 3), ["203", "82%203/247", "42"]);
  t.deepEqual(get(LAMB).cells.slice(0, 2), ["216", "—"], "no team total for every game he played: '—', not a smaller denominator");
  t.deepEqual(get(OLAVE).cells.slice(0, 2), ["—", "—"], "no snap record: '—', never 0 or 0%");
  t.match(u.notes, /Snap% = his offensive snaps ÷ his team’s, in the games he played on offense\./);
  t.match(u.notes, /Snaps: nflverse snap counts\. Both counts cover the same games; — when he had no offensive snaps, or his team’s total or his snap record is missing\./);
  await openTab(v, "RB");
  const r = await chooseSet(v, "usage");
  t.deepEqual(labels(r.head), ["Snaps", "Snap%", "Att", "Tgt"], "RB targets ride along in Usage (and stay in Receiving)");
  t.deepEqual(rowsOf(r.list).find((x) => x.pid === WALKER).cells, ["180", "69%180/260", "87", "19"]);
  // sorting by Snap% puts the '—' rows last
  await openTab(v, "WR"); await chooseSet(v, "usage");
  v.getEl("ups-m-st-head").fire("click", { target: { closest: () => ({ getAttribute: () => "osnappct" }) } }); await settle();
  const sorted = rowsOf(v.getEl("ups-m-st-listwrap").innerHTML);
  t.ok(sorted.findIndex((x) => x.pid === LAMB) > sorted.findIndex((x) => x.pid === JSN), "'—' sorts after real values");
});

test("game log Usage view: his snaps, his share of his team's offensive snaps that game, targets; a week with no snap row is '—'", async () => {
  const pid = Object.keys(FX.players).find((id) => !FX.bundles[id] && FX.players[id][1] === "WR" && FX.weeks["1"][id] != null && FX.weeks["2"][id] != null);
  const wk = (w, tgt, off, teamOff) => ({ week: w, box: tgt == null ? null : { week: w, opponent: "NYJ", targets: tgt, receptions: 1, rec_yds: 9, rec_tds: 0 },
    snaps: off == null ? null : { team: "XXX", off, def: 0, st: 2, team_off: teamOff, team_def: 60 }, redzone: null });
  const v = boot({ weeklyBox: (m) => ({ ok: true, mfl_id: m, gsis_id: "00-WRX", pfr_id: "WrxWr00", id_source: "player_id_map:verified", box_through_week: 4,
    weeks: [wk(1, 6, 45, 60), wk(2, null, 0, 70), wk(3, 4, 30, null), wk(4, 2, null, null)] }) });
  await gameLog(v, pid);
  const body = v.getEl("ups-m-sheet-body");
  t.match(body.innerHTML, /data-glview="usage"[^>]*>Usage<\/button>/, "a Usage view next to Box score and Red zone");
  body.fire("click", { target: { closest: () => ({ getAttribute: () => "usage" }) } }); await settle();
  const html = body.innerHTML, t0 = html.indexOf('class="ups-m-gl-table"');
  const rows = [...html.slice(t0).matchAll(/<tr class="([^"]*)"(?: title="[^"]*")?><td>(\d+)(?: <small>[^<]*<\/small>)?<\/td><td class="pts">[\s\S]*?<\/td>([\s\S]*?)<\/tr>/g)]
    .map((m) => [+m[2], [...m[3].matchAll(/<td>([^<]*)<\/td>/g)].map((x) => x[1])]);
  t.match(html, /<th>Snaps<\/th><th>Snap%<\/th><th>Tgt<\/th>/);
  t.deepEqual(rows.find((r) => r[0] === 1)[1], ["45", "75%", "6"]);
  t.deepEqual(rows.find((r) => r[0] === 2)[1], ["0", "0%", "—"], "0 offensive snaps with his team's total known is a real 0%; no box row = '—' targets");
  t.deepEqual(rows.find((r) => r[0] === 3)[1], ["30", "—", "4"], "no team total that game: '—', never a guess");
  t.deepEqual(rows.find((r) => r[0] === 4)[1], ["—", "—", "2"], "no snap row: '—'");
  t.match(html, /Usage: nflverse snap counts\. Snap% = his offensive snaps ÷ his team’s offensive snaps that game/);
});

const listChips = (html, pid) => { const m = new RegExp('data-pid="' + pid + '">[\\s\\S]*?<span class="tm">([\\s\\S]*?)</span></span></span>').exec(html); return m ? [...m[1].matchAll(/class="ups-m-inj-chip ([a-z]+) sm"[^>]*>([^<]*)</g)].map((x) => x[2] + ":" + x[1]) : null; };
test("status chips: this week's NFL report (Q/D/OUT) and the roster designation (IR-R …) as separate chips on the list, with the source times", async () => {
  let payload = STATUS_OK({ [PURDY]: { report: { status: "Questionable", injury: "Toe", practice: "Limited Participation in Practice", team: "SF" } },
    [DAK]: { roster: { status: "IR-R", label: "Injured reserve – designated to return", chip: "IR-R", detail: "Hamstring" },
             report: { status: "Doubtful", injury: "Hamstring", practice: "Did Not Participate In Practice", team: "DAL" } } });
  const v = boot({ status: () => payload });
  const html = await openTab(v, "QB");
  const list = v.getEl("ups-m-st-listwrap").innerHTML || html;
  t.deepEqual(listChips(list, PURDY), ["Q:q"]);
  t.deepEqual(listChips(list, DAK), ["IR-R:res", "D:d"], "roster designation and report designation, apart");
  t.ok(/<span class="tm"><span class="ups-m-inj-chip/.test(list), "chips LEAD the team line: never cut by a long name, never over the numbers");
  t.match(v.getEl("ups-m-st-notes").innerHTML, /Tags: NFL injury report Wk 5 \(Sat 9:33 AM ET\); IR\/PUP from MFL \(Sat 10:01 AM ET\)\. No tag: not on the report, a bye, or unmatched — tap him for which\./, "the list says what the tags are, when each source was updated, and what no tag means");
  // a status CHANGE: the next read (after the 5-minute cache, or forced) shows OUT;
  // while it is in flight the last good read stays on screen (chips don't blink off)
  payload = STATUS_OK({ [PURDY]: { report: { status: "Out", injury: "Toe", practice: "Did Not Participate In Practice", team: "SF" } } });
  const inflight = v.ctx.UPS_MOBILE_PLAYER_STATUS.load("2026", true);
  t.deepEqual(JSON.parse(JSON.stringify(v.ctx.UPS_MOBILE_PLAYER_STATUS.info(PURDY, "SFO").chips.map((c) => c.t))), ["Q"], "old read kept during the refresh");
  await inflight; v.render(); await settle();
  const list2 = v.getEl("ups-m-st-listwrap").innerHTML;
  t.deepEqual(listChips(list2, PURDY), ["OUT:out"]);
  t.deepEqual(listChips(list2, DAK), [], "dropped from the report and the roster designation lifted: no chip");
  // 320px: chip text is 11px like the rest of the list
  const css = /\.ups-m-st-row \.nm \.tm \.ups-m-inj-chip\.sm \{[^}]*\}/.exec(CSS);
  t.ok(css && /font-size: 11px/.test(css[0]) && /margin: 0 4px 0 0/.test(css[0]), "readable at 320px");
});

test("status in the sheet (Keith 2026-10-14): MFL's Q/D/OUT first, the official report beside it, every tag and line naming its source and week; an unreadable or stale feed says so", async () => {
  const head = async (opt, pid) => { const v = boot(opt); await v.ctx.UPS_MOBILE_PLAYER_STATUS.load("2026"); v.ctx.UPS_MOBILE.sheet.open(pid); await settle(); await settle(); return v.getEl("ups-m-sheet-head").innerHTML; };
  const MFL_Q = { status: "Questionable", week: 5, updated_utc: "2026-10-10T14:01:03.000Z", details: "Toe", exp_return: "Oct 12, 2026", return_date: "2026-10-12" };
  // MFL Q and the official Wk 5 report Q: one tag (MFL's), both lines
  const q = await head({ status: STATUS_OK({ [PURDY]: { mfl: MFL_Q, report: { status: "Questionable", injury: "Toe", practice: "Limited Participation in Practice", team: "SF" } } }) }, PURDY);
  t.match(q, /<div class="name">[^<]*<span class="ups-m-inj-chip q prior"[^>]*>MFL: Q · est\. return passed<\/span><\/div>/, "MFL's estimated return has passed: said on the tag, dashed");
  t.match(q, /<div>MFL still lists him Questionable — Toe \(MFL’s Wk 5 list; MFL status read at Sat 10:55 AM ET\)\. Its expected return \(Oct 12\) has passed; that’s an estimate, so this doesn’t mean he’s healthy or that the designation is wrong\.<\/div>/);
  t.doesNotMatch(q, /MFL[^<]*10:01/, "MFL's own (unstable) file time is never shown");
  const fut = await head({ status: STATUS_OK({ [PURDY]: { mfl: Object.assign({}, MFL_Q, { exp_return: "Oct 19, 2026", return_date: "2026-10-19" }) } }) }, PURDY);
  t.match(fut, /<span class="ups-m-inj-chip q"[^>]*>MFL: Q<\/span>/, "a future return: solid, no week on MFL's tag");
  t.match(fut, /<div>MFL: Questionable — Toe · Expected return: Oct 19 \(MFL’s Wk 5 list; MFL status read at Sat 10:55 AM ET\)\.<\/div>/);
  t.match(q, /<div>NFL Wk 5 report: Questionable — Toe · practice: limited \(updated Sat 9:33 AM ET\)\.<\/div>/);
  // MFL Q, but SFO's posted report doesn't list him: both shown
  const dis = await head({ status: STATUS_OK({ [PURDY]: { mfl: MFL_Q } }) }, PURDY);
  t.match(dis, />MFL: Q · est\. return passed<\/span><span class="ups-m-inj-chip na"[^>]*>NFL Wk 5: not listed<\/span>/);
  t.match(dis, /MFL and the NFL Wk 5 report disagree: MFL lists Questionable \(its estimated return has passed\); the report doesn’t list him\./);
  // MFL nothing, the report says Out: the report's tag and "MFL: none"
  const out = await head({ status: STATUS_OK({ [PURDY]: { report: { status: "Out", injury: "Toe", practice: "Did Not Participate In Practice", team: "SF" } } }) }, PURDY);
  t.match(out, />NFL: OUT \(Wk 5\)<\/span><span class="ups-m-inj-chip na"[^>]*>MFL: none<\/span>/);
  // no designation anywhere: SFO reported this week and he isn't on it; MFL has none
  const none = await head({}, PURDY);
  t.match(none, /<div>MFL: no designation \(MFL’s Wk 5 list; MFL status read at Sat 10:55 AM ET\)\.<\/div><div>NFL Wk 5 report: not listed \(SFO’s report, updated Sat 9:33 AM ET\)\.<\/div>/);
  t.doesNotMatch(none, /ups-m-inj-chip/, "no chip, and the lines say what each source has");
  // his team's report wasn't read (a bye): no claim either way
  const bye = await head({ status: STATUS_OK({}, { teams_mfl: ["DAL"] }) }, PURDY);
  t.match(bye, /NFL Wk 5 report: not out yet for SFO \(or a bye\)\./);
  // the route is down (and no app MFL read to fall back on): said so, no tag
  const down = await head({ status: 500 }, PURDY);
  t.match(down, /Injury status couldn’t be loaded\. No tag doesn’t mean healthy\./);
  t.doesNotMatch(down, /ups-m-inj-chip/);
  // a stale report (last week's) + an MFL roster designation: the roster tag, the report said in words
  const stale = await head({ status: STATUS_OK({ [PURDY]: { roster: { status: "IR", label: "Injured reserve", chip: "IR", detail: "Toe" } } },
    { current: false, week: 4, reason: "the newest report is Wk 4; Wk 5's is not out yet" }) }, PURDY);
  t.match(stale, /NFL injury report unavailable: the newest report is Wk 4; Wk 5&#39;s is not out yet\./);
  t.match(stale, /<span class="ups-m-inj-chip res"[^>]*>MFL: IR<\/span>/, "the roster designation still shows, as MFL's");
  t.match(stale, /MFL roster: Injured reserve \(Toe\) \(MFL status read at Sat 10:55 AM ET\)\./);
  // no verified NFL id
  const nid = await head({ status: Object.assign(STATUS_OK({}), { mapped_mfl_ids: PLAYERS.map((p) => p.id).filter((id) => id !== PURDY) }) }, PURDY);
  t.match(nid, /NFL report: no verified NFL id, so he can’t be matched to it\./, "not in the matched list (unaccepted, or signed since the map was built)");
  const nolist = await head({ status: Object.assign(STATUS_OK({}), { mapped_mfl_ids: undefined }) }, PURDY);
  t.match(nolist, /NFL Wk 5 report: couldn’t tell whether he’s on it\./, "no matched list: never 'not on the report'");
  // the team can be nflverse's spelling (SF): still matched to SFO's report
  const v2 = boot(); await v2.ctx.UPS_MOBILE_PLAYER_STATUS.load("2026");
  t.ok(v2.ctx.UPS_MOBILE_PLAYER_STATUS.resolve(PURDY, "SF").lines.some((l) => /not listed \(SFO’s report/.test(l)));
  // Stats → Players keeps its own rule (out of scope for the resolver): info() unchanged
  t.match(v2.ctx.UPS_MOBILE_PLAYER_STATUS.info(PURDY, "SF").report, /Not on SFO’s Wk 5 injury report/);
});

test("status fallback: with the route unavailable, MFL's designations from the app's own MFL read still show, labeled as such", async () => {
  for (const [desig, want] of [["IR-PUP", /<span class="ups-m-inj-chip res"[^>]*>MFL: PUP<\/span>/], ["Questionable", /<span class="ups-m-inj-chip q"[^>]*>MFL: Q<\/span>/]]) {
    const v = boot({ status: 500 });
    v.M.state.lineupWeek = 5;
    v.M.state.injuryStore = { known: (s, w) => String(w) === "5", status: (s, w, id) => (String(id) === PURDY ? desig.toUpperCase() : ""), detail: () => "Toe" };
    await v.ctx.UPS_MOBILE_PLAYER_STATUS.load("2026");
    v.ctx.UPS_MOBILE.sheet.open(PURDY); await settle(); await settle();
    const h = v.getEl("ups-m-sheet-head").innerHTML;
    t.match(h, want);
    t.match(h, /\(this page’s (MFL read|read of MFL’s Wk 5 list)\)\./);
  }
});

test("kickers and punters: Boom/Bust as counts with the real pool size — no claim that a few weeks rank them", async () => {
  const k = Object.keys(FX.players).find((id) => FX.players[id][1] === "PK" && FX.weeks["1"][id] != null);
  const starter = (g) => g !== "PK" ? { ok: true, players: {}, weeks_label: "Wks 1–4", pending_weeks: [] } : { ok: true, weeks_label: "Wks 1–4", pending_weeks: [],
    thresholds: { 1: { PK: { n: 12 } }, 2: { PK: { n: 12 } }, 3: { PK: { n: 11 } }, 4: { PK: { n: 12 } } },
    players: { [k]: { q: 4, startable_n: 3, boom_n: 1, bust_n: 1, startable_pct: 75, boom_pct: 25, bust_pct: 25, played_n: 4, team_games_n: 4 } } };
  const v = boot({ starter });
  await openTab(v, "PK");
  const b = await chooseSet(v, "boom");
  t.deepEqual(labels(b.head), ["Start", "Boom", "Bust", "Played"]);
  t.deepEqual(rowsOf(b.list).find((r) => r.pid === k).cells, ["3/4", "1/4", "1/4", "4/4"], "counts, not percentages");
  t.match(b.notes, /Only 12 kickers start each week, so a few weeks can’t rank them reliably — these are counts, not a ranking\./);
});

test("status from the sheet's OTHER entry points (Rosters, Lineup, Search open it without Stats): loading and stale reads never look healthy", async () => {
  const OUT = STATUS_OK({ [PURDY]: { report: { status: "Out", injury: "Toe", practice: "Did Not Participate In Practice", team: "SF" } } });
  const open = async (v) => { v.ctx.UPS_MOBILE.sheet.open(PURDY); await settle(); await settle(); return v.getEl("ups-m-sheet-head").innerHTML; };
  // 1. opened before any status read has answered (the read hangs)
  const slow = await open(boot({ status: "hold" }));
  t.match(slow, /Checking injury status…/, "says it's checking");
  t.doesNotMatch(slow, /Not on |ups-m-inj-chip (q|d|out)"/, "no 'not on the report', no game-status chip while nothing has been read");
  // 2. opened first from another view: the sheet itself reads the status, then shows it
  const v = boot({ status: () => OUT });
  const h = await open(v);
  t.match(h, /<span class="ups-m-inj-chip out"[^>]*>NFL: OUT \(Wk 5\)<\/span>/);
  t.match(h, /NFL Wk 5 report: Out — Toe/);
  // 3. the app sat open: the last read is older than the 5-minute window and its refresh is in flight
  const PS = v.ctx.UPS_MOBILE_PLAYER_STATUS;
  const v2 = boot({ status: () => STATUS_OK({}) });
  await v2.ctx.UPS_MOBILE_PLAYER_STATUS.load("2026");
  v2.ctx.UPS_MOBILE_PLAYER_STATUS._st.at -= v2.ctx.UPS_MOBILE_PLAYER_STATUS.TTL + 1000;
  const stale = JSON.parse(JSON.stringify(v2.ctx.UPS_MOBILE_PLAYER_STATUS.info(PURDY, "SFO")));
  t.equal(stale.report, "Checking this week’s injury report…", "an old 'not on SFO's report' is never shown as this week's finding");
  t.match(v2.ctx.UPS_MOBILE_PLAYER_STATUS.listLine(), /Checking this week’s injury report — no tags until it’s read\./);
  // 4. ...and that refresh fails
  const v3 = boot({ status: (() => { let n = 0; return () => (n++ ? 500 : STATUS_OK({})); })() });
  await v3.ctx.UPS_MOBILE_PLAYER_STATUS.load("2026");
  v3.ctx.UPS_MOBILE_PLAYER_STATUS._st.at -= v3.ctx.UPS_MOBILE_PLAYER_STATUS.TTL + 1000;
  const h3 = await open(v3);
  t.match(h3, /Injury status couldn’t be loaded\. No tag doesn’t mean healthy\./);
  t.doesNotMatch(h3, /Not on /);
  t.ok(PS, "loader shared with the list");
});

test("EPA note follows the season's play definition: rebuilt (2), original (1), mid-rebuild", async () => {
  for (const [def, re] of [[2, /Two-point tries, scrambles \(they’re runs\) and plays wiped out by a penalty don’t count\./],
                           [1, /This season’s EPA uses the original play definition, not comparable with seasons rebuilt on box-score plays\./],
                           ["mixed", /This season’s EPA is being rebuilt, so the columns read — for now\./]]) {
    const v = boot({ epaDefs: { 2026: def } });
    await openTab(v, "QB");
    const e = await chooseSet(v, "epa");
    t.match(e.notes, re, String(def));
    if (def === 1) t.doesNotMatch(e.notes, /box score’s pass attempts/, "the new-definition text isn't shown for an old season");
  }
});

// ═══ 6. Hardening (Keith 2026-10-12): Search = sheet; Snap% at four digits; no "*" ═══
// Search rows → { pid: { ppg, rank } } and the line above them.
function searchRows(html) {
  const out = {};
  for (const m of html.matchAll(/<button type="button" class="ups-m-psr-row" data-pid="(\d+)">([\s\S]*?)<\/button>/g)) {
    const ppg = /<span class="ppg[^"]*">([\s\S]*?)<\/span>/.exec(m[2])[1].replace(/<i>PPG<\/i>/, "");
    const rk = (/<span class="rk">([^<]*)<\/span>/.exec(m[2]) || [])[1] || "";
    out[m[1]] = { ppg, rank: rk };
  }
  return out;
}
const searchBasis = (html) => { const m = /<div class="ups-m-psr-basis( warn)?">([^<]*)<\/div>/.exec(html); return m ? { warn: !!m[1], text: m[2] } : null; };
function sheetPoints(v, pid) {
  v.ctx.UPS_MOBILE.sheet.open(pid);
  const body = v.getEl("ups-m-sheet-body").innerHTML;
  const tile = (label) => (new RegExp("<div><b>([^<]*)</b><small>" + label).exec(body) || [])[1];
  const basis = /<div class="ups-m-stat-basis( warn)?">([^<]*)<\/div>/.exec(body);
  return { ppg: tile("PPG · "), rank: tile("PPG rank"), basis: basis ? { warn: !!basis[1], text: basis[2] } : null, body };
}
const nameOf = (pid) => { const [last, first] = FX.players[pid][0].split(", "); return (first ? first + " " : "") + last; };

test("Search rows show the sheet's PPG and rank for every player — MFL's W=ALL, Week 5 in progress included; the old leaderboard copy is never read", async () => {
  let advReads = 0;
  const v = boot({ search: true, advMap: () => { advReads++; return {}; } });
  const S = v.ctx.UPS_MOBILE.playerSearch;
  // Dak: the leaderboard copy stopped at Week 4 (107.5); MFL has 125.5 through Thursday's Week 5 game.
  const lbDak = FX.leaderboard.qb.rows.find((r) => String(r.mfl_pid) === DAK);
  t.ok(Math.abs(Number(lbDak.mfl_points) - mflYtd(DAK).pts) > 1, "fixture: the two sources disagree for Dak");
  S.openWith("dak prescott");
  const dak = searchRows(v.searchList())[DAK];
  const sd = sheetPoints(v, DAK);
  t.deepEqual(dak, { ppg: sd.ppg, rank: sd.rank }, "Dak: Search = sheet");
  t.equal(dak.ppg, mflYtd(DAK).ppg.toFixed(1), "= MFL's own YTD ÷ MFL weeks");
  // every row of 40 searches, against the sheet that row opens
  const scored = Object.keys(FX.players).filter((id) => FX.weeks["1"][id] != null || FX.weeks["5"][id] != null);
  let checked = 0;
  for (const pid of [DAK, PURDY, MASON, LOCK, ROUSSEAU, ...scored.slice(0, 35)]) {
    S.openWith(nameOf(pid));
    const rows = searchRows(v.searchList());
    t.ok(rows[pid], nameOf(pid) + " is found");
    for (const [id, r] of Object.entries(rows)) {
      const sh = sheetPoints(v, id);
      t.deepEqual(r, { ppg: sh.ppg, rank: sh.rank }, nameOf(id) + ": Search row = sheet tiles");
      const m = mflYtd(id);
      if (m.n) t.equal(r.ppg, m.ppg.toFixed(1), nameOf(id) + ": = MFL W=ALL");
      checked++;
    }
  }
  // and last-name searches that list several players at once
  for (const q of ["williams", "johnson", "smith", "allen", "jones"]) {
    S.openWith(q);
    for (const [id, r] of Object.entries(searchRows(v.searchList()))) {
      const sh = sheetPoints(v, id);
      t.deepEqual(r, { ppg: sh.ppg, rank: sh.rank }, q + " → " + nameOf(id) + ": Search row = sheet tiles");
      checked++;
    }
  }
  t.ok(checked >= 120, checked + " rows checked");
  // Mason: one MFL week, under the 2-week rank minimum — "unranked" on both (the old copy said RB #21)
  S.openWith("jordan mason");
  t.deepEqual(searchRows(v.searchList())[MASON], { ppg: mflYtd(MASON).ppg.toFixed(1), rank: "unranked" });
  // The SAME line above the rows and under the sheet's points: source, weeks, week in progress, rank rule, read time.
  const sb = searchBasis(v.searchList()), shb = sheetPoints(v, DAK).basis;
  t.deepEqual(sb, shb, "Search and sheet say the same thing about the numbers");
  t.match(sb.text, /^Actual 2026 MFL points, UPS scoring · Wks 1–5 · Wk 5 in progress · Rank needs 2\+ MFL wks · MFL read \d{1,2}:\d{2} (AM|PM)$/, "the season is named");
  t.equal(advReads, 0, "getAdvancedStatsMap (the D1 leaderboard copy) is never read by Search");
  t.doesNotMatch(read("site/m/player_search.js"), /getAdvancedStatsMap\s*\(/, "and isn't called anywhere in Search");
});

test("Search sorts by the PPG it shows; players without an MFL week this season sort last and show —", async () => {
  const v = boot({ search: true });
  v.ctx.UPS_MOBILE.playerSearch.openWith("nyj");      // matches only the team (no name starts "nyj"): one tier, so PPG decides
  const ids = [...v.searchList().matchAll(/data-pid="(\d+)"/g)].map((m) => m[1]);
  const ppg = ids.map((id) => searchRows(v.searchList())[id].ppg);
  const nums = ppg.filter((x) => x !== "—").map(Number);
  t.ok(nums.length >= 5, nums.length + " NYJ players with an MFL week");
  t.deepEqual(nums, [...nums].sort((a, b) => b - a), "highest PPG first");
  t.ok(ppg.slice(nums.length).every((x) => x === "—"), "then everyone without one");
});

test("MFL's scoring unreadable → Search shows — with the reason, the sheet says the same, and nothing falls back to the leaderboard copy", async () => {
  let advReads = 0;
  const v = boot({ search: true, scores: { error: "MFL timeout" }, advMap: () => { advReads++; return { [DAK]: { mfl_ppg: 26.9, posRank: 4 } }; } });
  v.ctx.UPS_MOBILE.playerSearch.openWith("dak prescott");
  const html = v.searchList();
  t.deepEqual(searchRows(html)[DAK], { ppg: "—", rank: "" }, "no number, never the old copy's 26.9");
  t.deepEqual(searchBasis(html), { warn: true, text: "Points unavailable: MFL’s scoring couldn’t be read, so no points or ranks are shown." });
  const sh = sheetPoints(v, DAK);
  t.deepEqual(sh.basis, searchBasis(html), "the sheet's Actions tab says the same, instead of dropping the block");
  t.equal(sh.ppg, undefined, "and shows no tiles");
  t.equal(advReads, 0);
  // preseason: MFL answers but has posted no week
  const pre = boot({ search: true, scores: { playerScoresAllWeeks: { year: "2026", playerScores: [] } } });
  pre.ctx.UPS_MOBILE.playerSearch.openWith("dak prescott");
  t.deepEqual(searchBasis(pre.searchList()), { warn: false, text: "No 2026 MFL scores yet." });
  t.equal(searchRows(pre.searchList())[DAK].ppg, "—");
});

test("freshness: a re-read that moves MFL's YTD updates the open Search AND the open sheet together; a failed re-read changes neither and keeps the old read time", async () => {
  // Dak's Week 5 gets a stat correction of +6.0 in the next W=ALL read
  const next = JSON.parse(JSON.stringify(FX.weeks)); next["5"][DAK] = String(Number(next["5"][DAK]) + 6);
  let answer = scoresPayload(next);
  const v = boot({ search: true, refresh: () => answer });
  v.state.loaded = true;
  v.state.playerScoresAllAt = Date.now() - 10 * 60 * 1000;   // read 10 minutes ago
  v.ctx.UPS_MOBILE.sheet.open(DAK);                           // the sheet is open on Dak…
  const before = sheetPoints(v, DAK);
  v.ctx.UPS_MOBILE.playerSearch.openWith("dak prescott");      // …and Search, which asks for a re-read on open
  await settle(); await settle();
  const after = searchRows(v.searchList())[DAK], shAfter = { ppg: /<div><b>([^<]*)<\/b><small>PPG · /.exec(v.getEl("ups-m-sheet-body").innerHTML)[1] };
  t.notEqual(after.ppg, before.ppg, "Search moved: " + before.ppg + " → " + after.ppg);
  t.equal(shAfter.ppg, after.ppg, "the open sheet moved with it (window event, no reopen)");
  t.equal(after.ppg, (Math.round((mflYtd(DAK).pts + 6) / 5 * 10) / 10).toFixed(1));
  const b1 = searchBasis(v.searchList());
  t.deepEqual(b1, sheetPoints(v, DAK).basis, "same read time on both");
  t.notEqual(b1.text, before.basis.text, "the 'MFL read' time moved: " + before.basis.text.slice(-15) + " → " + b1.text.slice(-15));
  // a failed read: nothing changes, the old time stays (staleness shows)
  answer = null;
  v.state.playerScoresAllAt = Date.now() - 10 * 60 * 1000;
  const stamp = searchBasis(v.searchList()).text;
  const r = await v.ctx.__refresh(5 * 60 * 1000);
  t.equal(r, false, "a failed read reports no change");
  t.equal(searchBasis(v.searchList()).text, stamp);
});

test("Snap% at four digits over four (Kamren Curl 2025: 1057/1067 through Wk 17): the column fits the widest count on the tab, heading and rows share it, and it doesn't move while searching", async () => {
  const lb = (pos) => {
    const b = leaderboard(pos);
    if (pos === "idp") b.rows = b.rows.map((r, i) => Object.assign({}, r, i === 0 ? { def_snaps_total: 1057, def_snaps_team: 1067 }
      : i === 1 ? { def_snaps_total: 1068, def_snaps_team: 1067 }          // a bad source row: his more than his team's
      : { def_snaps_total: 40 + i, def_snaps_team: 300 }));
    return b;
  };
  const v = boot({ leaderboard: lb });
  await openTab(v, "LB");
  const tk = await chooseSet(v, "tackles");
  const grid = (html) => /style="--cols:26px minmax\(0,1fr\) ([^"]+)"/.exec(html)[1].split(" ").map((x) => parseInt(x, 10));
  const lbRows = leaderboard("idp").rows;
  const lbPid = (i) => String(parseInt(lbRows[i].mfl_pid, 10));
  const curl = rowsOf(tk.list).find((r) => r.pid === lbPid(0));
  if (curl) t.equal(curl.cells[3], "99%1057/1067", "four digits over four, whole");
  // 8 digits × 7.3 + the slash 3.6 + 2 = 64px (WebKit measures "1365/1400" at 62.0)
  t.equal(grid(tk.list)[3], 64, "the Snap% column grew from 46 to 64px for the widest count on the tab");
  t.deepEqual(grid(tk.head), grid(tk.list), "the heading's grid is the rows' grid");
  // every count on screen fits its column (the same arithmetic the app uses)
  for (const r of rowsOf(tk.list)) {
    const m = /(\d+)\/(\d+)$/.exec(r.cells[3]);
    if (m) t.ok(Math.ceil((m[1].length + m[2].length) * 7.3 + 3.6) + 2 <= grid(tk.list)[3], r.cells[3] + " fits");
  }
  // over 100% is never shown: "—" over the counts, with the reason on the title, and it sorts with the unavailable
  const bad = rowsOf(tk.list).find((r) => r.pid === lbPid(1));
  if (bad) t.equal(bad.cells[3], "—1068/1067");
  t.match(tk.list, /title="The counts disagree \(1068 is more than 1067\), so no % is shown"/);
  t.doesNotMatch(tk.list, />1\d\d%</, "no share over 100% anywhere");
  v.getEl("ups-m-st-head").fire("click", { target: { closest: () => ({ getAttribute: () => "snappct" }) } }); await settle();
  const sorted = rowsOf(v.getEl("ups-m-st-listwrap").innerHTML);
  const iBad = sorted.findIndex((x) => x.pid === lbPid(1));
  t.ok(iBad < 0 || sorted.slice(iBad).every((x) => /^—/.test(x.cells[3])), "the disagreeing row sorts with the unavailable, after every real %");
  // searching down to a short count keeps the width (no jump under the user's thumb)
  v.getEl("ups-m-st-search").fire("input", { target: { value: FX.players[lbPid(5)] ? FX.players[lbPid(5)][0].split(",")[0] : "zz" } });
  t.equal(grid(v.getEl("ups-m-st-listwrap").innerHTML.includes("--cols") ? v.getEl("ups-m-st-listwrap").innerHTML : tk.list)[3], 64, "same 64px with one short row on screen");
  // the design width stays when every count is short (Wk 1–4 of the real board)
  const v2 = boot();
  await openTab(v2, "LB");
  t.equal(grid((await chooseSet(v2, "tackles")).list)[3] >= 46, true);
});

test("Snap% on Usage: 1342/1452 with the postseason (22 weeks) fits; the sheet's game log never shows a game over 100%", async () => {
  const lb = (pos) => {
    const b = leaderboard(pos);
    if (pos === "skill") b.rows = b.rows.map((r) => String(r.mfl_pid) === JSN ? Object.assign({}, r, { off_snaps_total: 1342, off_snaps_team: 1452 }) : r);
    return b;
  };
  const v = boot({ leaderboard: lb });
  await openTab(v, "WR");
  const u = await chooseSet(v, "usage");
  t.equal(rowsOf(u.list).find((r) => r.pid === JSN).cells[1], "92%1342/1452");
  t.equal(/style="--cols:26px minmax\(0,1fr\) ([^"]+)"/.exec(u.list)[1].split(" ")[1], "64px");
  const src = read("site/m/player_sheet.js");
  t.match(src, /u\.off < 0 \|\| u\.off > u\.team_off \? null : Math\.round\(100 \* u\.off \/ u\.team_off\) \+ "%"/, "game log: his snaps over his team's that game → —");
});

// ═══ 7. Season rollover (Keith 2026-10-12): "—" until MFL has actual scores for the season;
//      an earlier season's points or rank only under an explicit year ═══
const ROLL_BUNDLE = { career_summary: [
  { season: 2026, games_played: 17, season_points: 401.2, avg_ppg: 23.6, pos_ppg_rank: 6 },
  { season: 2025, games_played: 16, season_points: 352.0, avg_ppg: 22.0, pos_ppg_rank: 9 } ] };
async function rollover(opt) {
  let advReads = 0;
  const v = boot(Object.assign({ search: true, year: "2027", bundles: { [DAK]: ROLL_BUNDLE },
    advMap: () => { advReads++; return { [DAK]: { mfl_ppg: 25.1, posRank: 10 } }; } }, opt));
  v.ctx.UPS_MOBILE.playerSearch.openWith("dak prescott");
  const search = v.searchList();
  const sheet = sheetPoints(v, DAK);
  await settle();
  v.getEl("ups-m-sheet-tabs").fire("click", { target: { closest: () => ({ getAttribute: () => "stats" }) } });
  await settle(); await settle();
  const statsTab = v.getEl("ups-m-sheet-body").innerHTML;
  return { v, search, row: searchRows(search)[DAK], basis: searchBasis(search), sheet, statsTab, advReads: () => advReads };
}
const yearRowsOf = (html) => [...html.matchAll(/<tr><td>(\d{4})<\/td><td>([^<]*)<\/td><td>([^<]*)<\/td><td>([^<]*)<\/td><td>([^<]*)<\/td><\/tr>/g)].map((m) => m.slice(1));

test("rollover, 2027 before MFL posts a 2027 score: Search and the sheet show — and \"No 2027 MFL scores yet.\"; 2026 appears only as a labelled history row", async () => {
  const r = await rollover({ scores: { playerScoresAllWeeks: { year: "2027", playerScores: [] } }, lineupWeek: null });
  t.deepEqual(r.row, { ppg: "—", rank: "" }, "no PPG, no rank in Search");
  t.deepEqual(r.basis, { warn: false, text: "No 2027 MFL scores yet." });
  t.deepEqual(r.sheet.basis, r.basis, "the sheet's Actions tab says the same");
  t.equal(r.sheet.ppg, undefined, "and shows no points tiles");
  t.doesNotMatch(r.search + r.sheet.body, /25\.1|#10 QB|#6 QB|23\.6/, "no 2026 number anywhere on Search or the Actions tab");
  t.equal(r.advReads(), 0, "the leaderboard copy (2026) is never read");
  // Stats tab: 2026 and 2025 only as rows under their own year; no 2027 row; the line says what they are
  const yrs = yearRowsOf(r.statsTab);
  t.deepEqual(yrs.map((x) => x[0]), ["2026", "2025", "2024"], "history rows, each under its year");
  t.deepEqual(yrs[0], ["2026", "17", "401.2", "23.6", "6"], "2026's final line, labelled 2026");
  t.match(r.statsTab, /No 2027 MFL scores yet\. Rows above are earlier seasons, each under its year\./);
  t.doesNotMatch(r.statsTab, /<td>2027<\/td>/);
  // Stats → Players list: the stored 2026 board, said to be 2026
  const html = await openTab(r.v, "QB");
  t.match(html, /No 2027 MFL scores posted yet — showing the 2026 season’s final totals/, "the list says whose totals they are");
  t.ok(bands(html).includes("2026"), "and its points band reads 2026: " + bands(html).join(" | "));
});

test("rollover: a payload for another season (or one that doesn't say) is never shown as this season's — — plus the reason", async () => {
  const wrong = await rollover({ scores: scoresPayload(FX.weeks) });   // MFL answers with 2026's weeks while the app is on 2027
  t.deepEqual(wrong.row, { ppg: "—", rank: "" });
  t.deepEqual(wrong.basis, { warn: true, text: "Points unavailable: MFL’s scores aren’t marked as 2027, so none are shown." });
  t.deepEqual(wrong.sheet.basis, wrong.basis);
  t.doesNotMatch(wrong.search + wrong.sheet.body, /25\.1/, "Dak's 2026 PPG never appears as 2027's");
  const p = scoresPayload(FX.weeks); delete p.playerScoresAllWeeks.year;
  const unmarked = await rollover({ scores: p, year: "2026" });         // even in the right year, no year = unverified
  t.deepEqual(unmarked.row, { ppg: "—", rank: "" });
  t.equal(unmarked.basis.text, "Points unavailable: MFL’s scores aren’t marked as 2026, so none are shown.");
  // MFL has no 2027 league yet (the export is "Not Found"): unavailable, not a guess
  const gone = await rollover({ scores: { raw: "<H1>Not Found</H1>", parse_error: "Unexpected token '<'" } });
  t.deepEqual(gone.row, { ppg: "—", rank: "" });
  t.deepEqual(gone.basis, { warn: true, text: "Points unavailable: MFL’s scoring couldn’t be read, so no points or ranks are shown." });
});

test("rollover: 2027's first posted score (Thursday of Week 1) is shown as 2027, ranked on 2027 alone", async () => {
  const wk1 = { playerScoresAllWeeks: { year: "2027", playerScores: [{ week: "1", playerScore: [
    { id: DAK, week: "1", score: "31.4" }, { id: PURDY, week: "1", score: "18.2" } ] }] } };
  const r = await rollover({ scores: wk1, lineupWeek: { ok: true, week: 1, source: "live_scoring" } });
  t.deepEqual(r.row, { ppg: "31.4", rank: "#1 QB" }, "2027's own number and rank");
  t.deepEqual({ ppg: r.sheet.ppg, rank: r.sheet.rank }, { ppg: "31.4", rank: "#1 QB" }, "the sheet agrees");
  t.match(r.basis.text, /^Actual 2027 MFL points, UPS scoring · Wk 1 · Wk 1 in progress · Rank needs 1\+ MFL wk · MFL read /);
  t.deepEqual(r.sheet.basis, r.basis);
  const yrs = yearRowsOf(r.statsTab);
  t.deepEqual(yrs.map((x) => x[0]), ["2027", "2026", "2025"], "the 2027 row joins the history, each still under its year");
  t.deepEqual(yrs[0].slice(0, 4), ["2027", "1", "31.4", "31.4"]);
});

test("a season after its last week stays named: 'Actual 2026 MFL points … (final)'", async () => {
  const v = boot({ search: true, lineupWeek: { ok: true, week: 6, source: "live_scoring_week_complete" } });
  v.ctx.UPS_MOBILE.playerSearch.openWith("dak prescott");
  t.match(searchBasis(v.searchList()).text, /^Actual 2026 MFL points, UPS scoring · Wks 1–5 \(final\) · Rank needs 3\+ MFL wks · MFL read /);
});

test("a finished season whose stored copy can't be used says so on the list — it never just looks empty (#1266)", async () => {
  const refuse = (reason) => (pos) => (pos === "idp" ? { __status: 503, __json: { ok: false, error: "stored_board_unavailable", reason } } : leaderboard(pos));
  const v = boot({ leaderboard: refuse("2026/idp_1-17.json.gz checksum mismatch") });
  await openTab(v, "LB");
  const tk = await chooseSet(v, "tackles");
  t.match(tk.notes, /The stored 2026 stats couldn’t be read \(2026\/idp_1-17\.json\.gz checksum mismatch\), so the box-score columns read —\./);
  const v2 = boot({ leaderboard: (pos) => (pos === "idp" ? { __status: 500, __json: { ok: false } } : leaderboard(pos)) });
  await openTab(v2, "LB");
  const tk2 = await chooseSet(v2, "tackles");
  t.match(tk2.notes, /The 2026 stats couldn’t be loaded, so the box-score columns read —\. Tap refresh to retry\./, "any other failed read is said too");
  const ok = boot();
  await openTab(ok, "LB");
  t.doesNotMatch((await chooseSet(ok, "tackles")).notes, /couldn’t be (read|loaded)/, "a good read says nothing");
});

await run("mobile_stats_players_review");
