// Players market (waiver claims) — one control per choice, and no control can
// change the player or bid being submitted.
//   node tests/mobile_players_controls.test.mjs
//   PLAYERS_JS=<another players.js> node tests/mobile_players_controls.test.mjs
//
// Keith 2026-10-02: "Some controls appear to do the same thing." They did look
// alike — the YTD / L2 buttons (a points PERIOD) sat right under a "Sort: L2
// pts" dropdown option (a SORT that renamed itself after the period) — and one
// control quietly did a third job: L2 also re-ranked every opponent's defense
// in the matchup line (GBP #22 -> #7 vs PK, live 10-02). And a sort you picked
// was overwritten, not set aside, when it couldn't apply: Most added -> All
// players -> back to Free agents left the list on PPG.
//
// Drives the REAL views/players.js render + bind under Node: a fake mount whose
// period / position buttons and filter / sort / search controls fire the real
// listeners. Data = tests/fixtures/mobile_players_mfl_scoring_2026_wk3.json
// (real MFL captures, Wks 1-3) and, for the live-week cases,
// mobile_players_mfl_scoring_2026_wk4_tnf.json (2026-10-02: Wks 1-3 final,
// Week 4's Thursday game posted). The bid-sheet flows that need a real DOM
// (staging, the roster-full drop rule, the final review) are driven in a real
// browser against the same files — see the PR — and their pure helpers are
// checked here.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.isAbsolute(p) ? p : path.join(ROOT, p), "utf8");
const FX = JSON.parse(read("tests/fixtures/mobile_players_mfl_scoring_2026_wk3.json"));
const FX4 = JSON.parse(read("tests/fixtures/mobile_players_mfl_scoring_2026_wk4_tnf.json"));
const PLAYERS_JS = process.env.PLAYERS_JS || "site/m/views/players.js";
const APP = read("site/m/app.js");

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
// The fixture's rosters read is COMPLETE, so a player on none of them is a confirmed
// free agent (app.js rosterOwnership / ownerOfPid; tests/mobile_players_ownership_unknown
// covers the incomplete cases).
function completeOwnership(fx) {
  const own = { readable: true, complete: true, missing: [],
    byPid: Object.fromEntries(Object.entries(fx.rosters).map(([pid, r]) => [pid, r.fid])) };
  return { rosterOwnership: () => own,
    ownerOfPid: (pid) => (own.byPid[String(pid)] ? { known: true, free: false, fid: own.byPid[String(pid)] } : { known: true, free: true, fid: "" }) };
}

function harness({ fx = FX } = {}) {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout });
  ctx.window = ctx;
  vm.runInContext(UTIL_SRC + "\nthis.__util = { safeStr, safeInt, pad4, escapeHtml, fmtUsd, asArray };", ctx);
  vm.runInContext(read("site/m/season_scoring.js"), ctx);
  const state = {
    ctx: { year: "2026", leagueId: "74598" },
    players: { players: { player: fx.players } },
    viewerFranchiseId: "", franchises: [{ id: "0008", name: "Real Deal Creel" }],
    playerScoresAll: fx.playerScoresAll, lineupWeekResolution: fx.lineup_week, lineupWeek: 4,
  };
  ctx.state = state;
  vm.runInContext("var safeInt = this.__util.safeInt;\n" + sliceFn(APP, "function getSeasonScoring(") +
    "\nthis.__getSeasonScoring = getSeasonScoring;", ctx);
  const byId = Object.fromEntries(fx.players.map((p) => [p.id, p]));
  const rostered = new Set(Object.keys(fx.rosters));
  // MFL-wide most-added list (free agents only) — two real FAs from the fixture.
  const HOT = { "17167": 9.5, "14717": 4.1 };
  const calls = { load: [], matchupFor: [] };
  ctx.UPS_MOBILE = {
    util: ctx.__util, state,
    data: {
      getAllRosteredPids: () => rostered, ...completeOwnership(fx), getSeasonScoring: () => ctx.__getSeasonScoring(),
      getAdvancedStatsMap: () => ({}), getAdvancedStatsLatestYear: () => 2026, getYtdScoresMap: () => ({}),
      playerById: (pid) => byId[String(pid)] || null,
      computeCap: () => null, rosterCapMax: () => 30, getRosterFor: () => [], dropPenaltyFor: () => null,
    },
    hotCold: { get: () => ({ hot: HOT, cold: {} }), isLoading: () => false, fetch: () => Promise.resolve() },
    lineupIntel: {
      load: (k) => { calls.load.push(k); },
      projFor: () => 5.0, fmtProj: (v) => v.toFixed(1), projLoaded: () => true, priorSeason: () => false,
      rankCls: () => "", weeksAvailable: () => 3, muData: () => null,
      matchupFor: (pid, k) => { calls.matchupFor.push(k); return { opp: "GBP", isHome: true, rank: k ? 7 : 22, grp: "PK" }; },
    },
    ui: { showToast() {} },
    route: { registerView: (n, fn) => { if (n === "players") ctx.__render = fn; }, renderRoute: () => ctx.__render(mount, []), navigate() {} },
  };
  // A fake DOM just deep enough for players.js's own bind(): the buttons it
  // queries are rebuilt from the rendered HTML so a "click" fires the real
  // listener with the real data-* attribute.
  const els = {};
  const control = (id) => els[id] || (els[id] = { id, value: "", listeners: {}, focus() {}, setSelectionRange() {},
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    fire(type) { (this.listeners[type] || []).forEach((fn) => fn.call(this, { target: this })); } });
  let buttons = {};
  const mount = {
    innerHTML: "", querySelector: () => null,
    querySelectorAll(sel) {
      let attr = null;
      if (/data-win/.test(sel)) attr = "data-win"; else if (/ups-m-pos-chip/.test(sel)) attr = "data-pos";
      if (!attr) return [];
      const out = [];
      for (const m of mount.innerHTML.matchAll(new RegExp('<button class="[^"]*"[^>]*' + attr + '="([^"]+)"', "g"))) {
        const el = { listeners: [], getAttribute: (a) => (a === attr ? m[1] : null),
          addEventListener(type, fn) { if (type === "click") this.listeners.push(fn); } };
        out.push(el);
      }
      buttons[attr] = out;
      return out;
    },
  };
  ctx.document = {
    getElementById: (id) => (["ups-m-players-filter", "ups-m-players-sort", "ups-m-players-search"].includes(id) ? control(id) : null),
    addEventListener() {}, activeElement: null, body: { style: {} },
  };
  vm.runInContext(read(PLAYERS_JS), ctx);
  ctx.__render(mount, []);
  const click = (attr, v) => {
    const el = (buttons[attr] || []).find((b) => b.getAttribute(attr) === String(v));
    if (!el) throw new Error(`no ${attr}=${v} button is rendered`);
    el.listeners.forEach((fn) => fn.call(el, { stopPropagation() {} }));
  };
  const select = (id, value) => { const c = control(id); c.value = value; c.fire("change"); };
  const html = () => mount.innerHTML;
  const sortOptions = () => Array.from(html().matchAll(/<option value="(\w+)"( selected)?>(Sort: [^<]+)<\/option>/g))
    .map((m) => ({ value: m[1], selected: !!m[2], text: m[3] }));
  const selectedSort = () => (sortOptions().find((o) => o.selected) || {}).value;
  // Button text as a screen reader gets it: name · weeks · status ("live"/"final").
  const periodButtons = () => Array.from(html().matchAll(/data-win="(\d+)"[^>]*>(.*?)<\/button>/g))
    .map((m) => ({ win: m[1],
      text: m[2].replace(/<span class="wk">/, " · ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
      on: new RegExp('class="[^"]*\\bon\\b[^"]*" data-win="' + m[1] + '"').test(html()) }));
  const rowOrder = () => Array.from(html().matchAll(/class="ups-m-fa-row[^"]*" data-pid="(\d+)"/g)).map((m) => m[1]);
  const chipFor = (pid) => { const c = html().split('data-pid="' + pid + '"')[1] || ""; return (c.match(/<span class="ups-m-fa-stat pts">(.*?)<\/span>/) || [])[1] || ""; };
  return { ctx, calls, click, select, html, sortOptions, selectedSort, periodButtons, rowOrder, chipFor };
}

test("the points-period control names its weeks and whether they are final", () => {
  const h = harness();
  const pb = h.periodButtons();
  t.equal(pb.length, 2, "Season + Last 2 (three weeks are final)");
  t.equal(pb[0].text, "Season · Wks 1–3 · final", "Tuesday-style: nothing in progress");
  t.equal(pb[1].text, "Last 2 wks · Wks 2–3 · final");
  t.ok(pb[0].on && !pb[1].on, "Season is the default");
  t.doesNotMatch(h.html(), />YTD<|>L2</, "no bare YTD / L2 buttons");
  // 2026-10-02, after Thursday night: Season is MFL's YTD with the live week in
  // it; Last 2 stays on the two FINAL weeks and says so.
  const live = harness({ fx: FX4 }).periodButtons();
  t.equal(live[0].text, "Season · Wks 1–4 · live", "Season covers Week 4 and says it is in progress");
  t.equal(live[1].text, "Last 2 wks · Wks 2–3 · final", "Last 2 is final weeks only");
});

test("Season vs Last 2 on a live week: Szmyt's Thursday counts in Season, never in Last 2", () => {
  const h = harness({ fx: FX4 });
  t.match(h.chipFor("16419"), /<b>40\.7<\/b> pts · Wks 1–4/, "Season = MFL YTD 40.7 (27.7 + Thursday's 13.0)");
  h.click("data-win", 2);
  const wk = (w) => Number(FX4.playerScoresAll.playerScoresAllWeeks.playerScores.find((b) => b.week === String(w))
    .playerScore.find((s) => s.id === "16419").score);
  const l2 = Math.round((wk(2) + wk(3)) * 10) / 10;
  t.match(h.chipFor("16419"), new RegExp("<b>" + l2.toFixed(1).replace(".", "\\.") + "</b> pts · Wks 2–3 final"),
    `Last 2 = Wk 2 + Wk 3 = ${l2}, labelled final — Week 4 left out`);
  t.match(h.html(), /Last 2 wks = final weeks only/, "the basis line says what Last 2 is");
});

test("the sort never repeats the period: one sort control, one period control", () => {
  const h = harness();
  const labels = h.sortOptions().map((o) => o.text);
  t.deepEqual(labels, ["Sort: PPG", "Sort: Total pts", "Sort: Wk 4 projection", "Sort: Most added, all MFL", "Sort: Most dropped, all MFL"]);
  h.click("data-win", 2);
  t.deepEqual(h.sortOptions().map((o) => o.text), labels, "switching the period does not rename the sort options");
  t.ok(labels.every((l) => !/YTD|L2|L4|L6|season/i.test(l)), "no sort option names a period");
});

test("Last 2 wks changes the points, PPG and rank shown — and nothing else", () => {
  const h = harness();
  h.select("ups-m-players-filter", "all");                // Waller is rostered (0001)
  h.select("ups-m-players-sort", "pts");
  t.match(h.chipFor("12263"), /<b>39\.8<\/b> pts · Wks 1–3/, "Waller, Season: 39.8 over Wks 1–3");
  h.click("data-win", 2);
  t.match(h.chipFor("12263"), /<b>33\.6<\/b> pts · Wks 2–3/, "Waller, Last 2: 20.4 + 13.2 over Wks 2–3");
  t.equal(h.selectedSort(), "pts", "the sort choice is untouched");
  t.equal(h.ctx.document.getElementById("ups-m-players-filter").value, "all", "the filter is untouched");
  t.ok(h.periodButtons()[1].on, "Last 2 is on");
});

test("the matchup line's defense rank always uses season-to-date ranks, whatever the period", () => {
  const h = harness();
  h.click("data-win", 2);
  h.select("ups-m-players-sort", "ppg");
  t.ok(h.calls.matchupFor.length > 0, "matchup line rendered");
  t.ok(h.calls.matchupFor.every((k) => k === 0), "every matchup lookup used the season window");
  t.ok(h.calls.load.every((k) => k === 0), "only season defense ratings are loaded");
  t.match(h.html(), /GBP #22 to PK/, "season rank shown");
  t.doesNotMatch(h.html(), /GBP #7 to PK/, "the last-2 rank never leaks into the line");
});

test("a sort you pick survives a trip through All players (it used to become PPG for good)", () => {
  const h = harness();
  h.select("ups-m-players-sort", "hot");
  t.equal(h.selectedSort(), "hot");
  t.deepEqual(h.rowOrder().slice(0, 2), ["17167", "14717"], "Most added order: Sanker 9.5%, McLaughlin 4.1%");
  h.select("ups-m-players-filter", "all");
  t.equal(h.selectedSort(), "ppg", "All players can't sort by an FA-only list — PPG for now");
  t.match(h.html(), /Most added covers free agents only — sorted by PPG here/, "and the screen says why");
  h.select("ups-m-players-filter", "fa");
  t.equal(h.selectedSort(), "hot", "back on Free agents: Most added again");
  t.deepEqual(h.rowOrder().slice(0, 2), ["17167", "14717"], "and the list is in Most added order again");
});

test("the period choice survives a filter change, a position chip and a search", async () => {
  const h = harness();
  h.click("data-win", 2);
  h.select("ups-m-players-sort", "pts");
  h.select("ups-m-players-filter", "all");
  h.click("data-pos", "PK");
  const search = h.ctx.document.getElementById("ups-m-players-search");
  search.value = "mc"; search.fire("input");
  await new Promise((r) => setTimeout(r, 300));          // players.js debounces search by 250ms
  t.ok(h.periodButtons()[1].on, "still Last 2 wks");
  t.equal(h.selectedSort(), "pts", "still Total pts");
  t.match(h.chipFor("14717"), /pts · Wks 2–3/, "rows still show Wks 2–3");
});

test("an edit re-finds its claim by PLAYER, not by the slot it was opened at", () => {
  const c = vm.createContext({});
  vm.runInContext(sliceFn(read(PLAYERS_JS), "function resolveEditIndex(") + "\nthis.f = resolveEditIndex;", c);
  const plan = [{ round: 1, picks: [{ add_pid: "200" }, { add_pid: "300" }] }];   // "100" was swept out of slot 0
  t.equal(c.f(plan, { round: 1, index: 1 }, "300"), 1, "slot still right -> used");
  t.equal(c.f(plan, { round: 1, index: 1 }, "200"), 0, "B was opened at slot 1, now sits at 0 -> found by player");
  t.equal(c.f(plan, { round: 1, index: 0 }, "100"), -1, "the claim is gone -> -1 (the sheet refuses to save)");
  t.equal(c.f(plan, { round: 2, index: 0 }, "200"), -1, "wrong group -> -1");
  t.equal(c.f(plan, null, "200"), -1);
});

// ── The bid sheet + claims screen, driven through their own overlay handlers ──
// A fake DOM just deep enough for players.js's overlays: insertAdjacentHTML into
// #ups-m-app, getElementById over the inserted HTML, and clicks dispatched to the
// overlay's own [data-act] / [data-round] listener. window.confirm ALWAYS cancels
// and every write path records itself, so nothing here can submit anything.
function bidHarness({ full = false, players = PLAYERS_JS, fx = FX } = {}) {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout });
  ctx.window = ctx;
  vm.runInContext(UTIL_SRC + "\nthis.__util = { safeStr, safeInt, pad4, escapeHtml, fmtUsd, asArray };", ctx);
  vm.runInContext(read("site/m/season_scoring.js"), ctx);
  const state = {
    ctx: { year: "2026", leagueId: "74598" }, players: { players: { player: fx.players } },
    viewerFranchiseId: "0008", franchises: [{ id: "0008", name: "Real Deal Creel" }],
    playerScoresAll: fx.playerScoresAll, lineupWeekResolution: fx.lineup_week, lineupWeek: 4,
    waiverState: { window: { mode: "bbid" } },
  };
  ctx.state = state;
  vm.runInContext("var safeInt = this.__util.safeInt;\n" + sliceFn(APP, "function getSeasonScoring(") +
    "\nthis.__getSeasonScoring = getSeasonScoring;", ctx);
  const byId = Object.fromEntries(fx.players.map((p) => [p.id, p]));
  const rostered = new Set(Object.keys(fx.rosters));
  // Two real players to drop from (any rostered fixture players will do).
  const myRoster = [{ id: "13743", salary: 5000 }, { id: "12263", salary: 3000 }];
  let plan = [];
  const rec = { toasts: [], confirms: [], writes: [] };
  ctx.confirm = (m) => { rec.confirms.push(m); return false; };
  const nowrite = (what) => () => { rec.writes.push(what); return Promise.reject(new Error("no writes in tests")); };
  ctx.UPS_MOBILE = {
    util: ctx.__util, state,
    data: {
      getAllRosteredPids: () => rostered, ...completeOwnership(fx), getSeasonScoring: () => ctx.__getSeasonScoring(),
      getAdvancedStatsMap: () => ({}), getAdvancedStatsLatestYear: () => 2026, getYtdScoresMap: () => ({}),
      playerById: (pid) => byId[String(pid)] || null,
      computeCap: () => ({ capAmount: 300000, capRoom: 18000, rosterCount: 36, activeCount: full ? 30 : 28, irCount: 1, taxiCount: 5 }),
      rosterCapMax: () => 30, getRosterFor: () => myRoster, dropPenaltyFor: () => ({ amount: 0, authoritative: true }),
    },
    ui: { showToast: (m) => rec.toasts.push(m) },
    route: { registerView: (n, fn) => { if (n === "players") ctx.__render = fn; }, renderRoute: () => ctx.__render(mount, []), navigate() {} },
    hotCold: { get: () => ({ hot: { "17167": 9.5, "14717": 4.1 }, cold: {} }), isLoading: () => false, fetch: () => Promise.resolve() },
    waivers: {
      mode: () => ({ mode: "bbid", label: "Bid", detail: "Blind bids run at MFL's next scheduled run", writeEnabled: true, nativeLink: "" }),
      writeEnabled: () => true, stateKnown: () => true, nativeLink: () => "",
      limits: () => ({ min: 1000, step: 1000, maxRounds: 8, conditional: true, conditionalKnown: true }),
      getPlan: () => plan, setPlan: (p) => { plan = JSON.parse(JSON.stringify(p)); },
      pickCount: () => plan.reduce((n, g) => n + (g.picks || []).length, 0), clearCount: () => 0,
      isDirty: () => plan.some((g) => (g.picks || []).length), getPending: () => ({ known: true, rounds: [] }),
      submitPlan: nowrite("submitPlan"), submitFcfs: nowrite("submitFcfs"),
      fetchPending: () => Promise.resolve({ known: true, rounds: [] }), adoptVerified: () => false,
      when: () => "", countdown: () => "",
    },
  };
  const overlays = [];
  const ctrl = {};
  const control = (id) => ctrl[id] || (ctrl[id] = { id, value: "", listeners: {}, focus() {}, setSelectionRange() {},
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    fire(type) { (this.listeners[type] || []).forEach((fn) => fn.call(this, { target: this })); } });
  const element = (ov, id) => {
    ov.els = ov.els || {};
    if (ov.els[id]) return ov.els[id];
    const v = (ov.html.match(new RegExp('id="' + id + '"[^>]*value="([^"]*)"')) || [])[1];
    const el = { id, value: v || "", innerHTML: "", textContent: "", attrs: {}, listeners: id.endsWith("-overlay") ? ov.listeners : {},
      addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
      fire(type, extra) { (this.listeners[type] || []).forEach((fn) => fn.call(this, Object.assign({ target: this, key: "" }, extra || {}))); },
      setAttribute(k, val) { this.attrs[k] = val; }, removeAttribute(k) { delete this.attrs[k]; },
      focus() {}, select() {}, blur() {}, scrollTop: 0, querySelectorAll: () => [], querySelector: () => null,
      remove() { const i = overlays.indexOf(ov); if (i >= 0) overlays.splice(i, 1); } };
    ov.els[id] = el;
    return el;
  };
  // The list under the sheet: period / position buttons rebuilt from the
  // rendered HTML, so a test can switch the period while a claim is staged.
  let listButtons = {};
  const mount = {
    innerHTML: "", querySelector: () => null,
    querySelectorAll(sel) {
      const attr = /data-win/.test(sel) ? "data-win" : (/ups-m-pos-chip/.test(sel) ? "data-pos" : null);
      if (!attr) return [];
      const out = [];
      for (const m of mount.innerHTML.matchAll(new RegExp('<button class="[^"]*"[^>]*' + attr + '="([^"]+)"', "g"))) {
        out.push({ listeners: [], getAttribute: (a) => (a === attr ? m[1] : null),
          addEventListener(type, fn) { if (type === "click") this.listeners.push(fn); } });
      }
      listButtons[attr] = out;
      return out;
    },
  };
  const listClick = (attr, v) => {
    const el = (listButtons[attr] || []).find((b) => b.getAttribute(attr) === String(v));
    if (!el) throw new Error(`no ${attr}=${v} button is rendered`);
    el.listeners.forEach((fn) => fn.call(el, { stopPropagation() {} }));
  };
  ctx.document = {
    body: { style: {} }, activeElement: null, addEventListener() {},
    getElementById(id) {
      if (id === "ups-m-app") return { insertAdjacentHTML: (pos, html) => { overlays.push({ html, listeners: {} }); } };
      if (["ups-m-players-filter", "ups-m-players-sort", "ups-m-players-search"].includes(id)) return control(id);
      for (let i = overlays.length - 1; i >= 0; i--) if (overlays[i].html.includes('id="' + id + '"')) return element(overlays[i], id);
      return null;
    },
  };
  vm.runInContext(read(players), ctx);
  ctx.__render(mount, []);
  const top = () => overlays[overlays.length - 1];
  const click = (sel) => {     // sel: 'data-act="bid-confirm"' or 'data-round="2"'
    const ov = top();
    const tag = (ov.html.match(new RegExp("<[^>]*" + sel + "[^>]*>")) || [])[0];
    if (!tag) throw new Error("nothing rendered with " + sel);
    const attrs = {};
    for (const m of tag.matchAll(/([a-zA-Z0-9-]+)="([^"]*)"/g)) attrs[m[1]] = m[2];
    const target = { getAttribute: (a) => (a in attrs ? attrs[a] : null), disabled: /\sdisabled[\s>]/.test(tag) };
    target.closest = () => target;
    (ov.listeners.click || []).forEach((fn) => fn({ target, preventDefault() {}, stopPropagation() {} }));
  };
  const typeAmount = (v) => { const el = ctx.document.getElementById("ups-m-bid-amt"); el.value = v; el.fire("input"); el.fire("change"); };
  return { ctx, rec, ui: ctx.UPS_MOBILE.waiverUI, plan: () => plan, setPlan: (p) => { plan = JSON.parse(JSON.stringify(p)); },
           click, typeAmount, top, overlays, control, listClick, list: () => mount.innerHTML,
           sheetOpen: () => !!ctx.document.getElementById("ups-m-bid-overlay") };
}
const pick = (pid, bid, drop) => ({ add_pid: pid, bid_dollars: bid, drop_pid: drop || null });

test("the staged claim is the player, amount and group in the sheet — whatever the list does underneath", () => {
  const h = bidHarness();
  h.ui.openBid("14717");
  t.ok(h.sheetOpen(), "bid sheet open");
  t.match(h.top().html, /Bid on Chase McLaughlin/, "for McLaughlin");
  t.match(h.top().html, /Season · Wks 1–3 · final: <b>42\.1<\/b> pts/, "with his SEASON points, whatever the list period");
  h.typeAmount("12");
  // The list re-renders and changes under the open sheet (async loads do this).
  h.control("ups-m-players-filter").value = "all"; h.control("ups-m-players-filter").fire("change");
  h.control("ups-m-players-sort").value = "hot"; h.control("ups-m-players-sort").fire("change");
  h.ctx.UPS_MOBILE.route.renderRoute();
  t.ok(h.sheetOpen(), "the sheet survives list re-renders");
  h.click('data-act="bid-confirm"');
  t.deepEqual(h.plan(), [{ round: 1, clear: false, picks: [pick("14717", 12000)] }], "exactly McLaughlin, $12K (12000), group 1, no drop");
  t.ok(h.rec.toasts.some((m) => /Staged \$12K in group 1 — not submitted yet/.test(m)), "and the toast says so");
  t.equal(h.rec.writes.length, 0, "nothing was sent anywhere");
});

test("roster KNOWN full: a claim cannot be staged without naming a drop", () => {
  const h = bidHarness({ full: true });
  h.ui.openBid("14717");
  t.match(h.top().html, /Choose who this replaces — roster full \(30\/30\)/, "the drop control says it is required");
  h.typeAmount("5");
  h.click('data-act="bid-confirm"');
  t.deepEqual(h.plan(), [], "nothing staged");
  t.ok(h.rec.toasts.some((m) => /roster is full \(30\/30\) — choose the player this claim replaces/.test(m)), "told why");
  t.ok(h.sheetOpen(), "sheet stays open to pick one");
  // A claim that already names a drop saves normally.
  const h2 = bidHarness({ full: true });
  h2.setPlan([{ round: 1, picks: [pick("14717", 5000, "12263")] }]);
  h2.ui.openBid("14717");                                  // one staged claim -> opens it for edit
  t.match(h2.top().html, /Edit claim/);
  h2.typeAmount("6");
  h2.click('data-act="bid-confirm"');
  t.deepEqual(h2.plan(), [{ round: 1, clear: false, picks: [pick("14717", 6000, "12263")] }], "edited, drop kept");
});

test("an edit shifted by a background sweep cannot delete another player's claim", () => {
  const h = bidHarness();
  h.setPlan([{ round: 1, picks: [pick("17075", 3000), pick("17167", 4000), pick("14717", 5000)] }]);
  h.ui.openBid("17167");                                   // Sanker, opened at slot 1
  t.match(h.top().html, /Edit claim/);
  // While the sheet is open, a reconcile sweeps Golden (17075) out — Sanker slides to slot 0.
  h.setPlan([{ round: 1, picks: [pick("17167", 4000), pick("14717", 5000)] }]);
  h.click('data-round="2"');                               // move Sanker to group 2
  h.click('data-act="bid-confirm"');
  const g = Object.fromEntries(h.plan().map((x) => [x.round, x.picks.map((p) => p.add_pid)]));
  t.deepEqual(g[1], ["14717"], "McLaughlin's claim is still in group 1 (the stale slot used to delete it)");
  t.deepEqual(g[2], ["17167"], "Sanker moved to group 2, once");
  // And if the edited claim itself was swept, nothing is saved.
  const h2 = bidHarness();
  h2.setPlan([{ round: 1, picks: [pick("17167", 4000)] }]);
  h2.ui.openBid("17167");
  h2.setPlan([{ round: 1, picks: [] }]);
  h2.click('data-act="bid-confirm"');
  t.deepEqual(h2.plan(), [{ round: 1, picks: [] }], "a vanished claim is not re-created");
  t.ok(h2.rec.toasts.some((m) => /changed while you were editing/.test(m)), "and the owner is told");
});

test("switching Season / Last 2 wks and every sort cannot change a staged claim's player, amount or drop", () => {
  // Live week (2026-10-02): Szmyt's numbers really differ between the periods
  // (Season 40.7 with Thursday, Last 2 = final Wks 2–3 only), and the sorts
  // reorder the list under him — the claim must not move with any of it.
  const h = bidHarness({ fx: FX4 });
  // One claim already staged with a drop (Cam Johnston, $4K, dropping Fred
  // Warner) and one staged here through the real sheet (Szmyt, $7K). The
  // drop-picker taps themselves are covered by the real-browser check.
  h.setPlan([{ round: 1, clear: false, picks: [pick("13848", 4000, "13743")] }]);
  h.ui.openBid("16419");
  t.match(h.top().html, /Bid on Andre Szmyt/, "for Szmyt");
  t.match(h.top().html, /Season · Wks 1–4 · live: <b>40\.7<\/b> pts · 10\.2 PPG · 4 MFL wks/,
    "the sheet prices him on MFL's YTD, Thursday included");
  h.typeAmount("7");
  h.click('data-act="bid-confirm"');
  const staged = [{ round: 1, clear: false, picks: [pick("13848", 4000, "13743"), pick("16419", 7000)] }];
  t.deepEqual(h.plan(), staged, "staged: Johnston $4K dropping Warner, then Szmyt $7K");
  const orders = new Set();
  for (const win of [2, 0, 2]) {
    h.listClick("data-win", win);
    for (const sort of ["pts", "proj", "hot", "cold", "ppg"]) {
      h.control("ups-m-players-sort").value = sort; h.control("ups-m-players-sort").fire("change");
      orders.add(Array.from(h.list().matchAll(/class="ups-m-fa-row[^"]*" data-pid="(\d+)"/g)).map((m) => m[1]).slice(0, 5).join(","));
      t.deepEqual(h.plan(), staged, `period ${win || "Season"}, sort ${sort}: claim unchanged`);
    }
  }
  t.ok(orders.size > 1, `the list really did reorder underneath (${orders.size} different orders)`);
  t.match(h.list(), /pts · Wks 2–3 final/, "and the list really was on Last 2 at one point");
  h.ui.openClaims();
  h.click('data-act="claims-submit"');
  const review = h.rec.confirms[0] || "";
  t.match(review, /Group 1 #1: Cam Johnston — \$4K — drop Fred Warner/, "the final review: the same first claim");
  t.match(review, /Group 1 #2: Andre Szmyt — \$7K — no drop/, "and the same second claim");
  t.equal(h.rec.writes.length, 0, "cancelled -> nothing sent");
});

test("Submit shows every claim, amount, drop and the waiver timing — and sends nothing when cancelled", () => {
  const h = bidHarness();
  h.setPlan([{ round: 1, picks: [pick("14717", 12000)] }, { round: 2, picks: [pick("17167", 5000, "12263")] }]);
  h.ui.openClaims();
  h.click('data-act="claims-submit"');
  const msg = h.rec.confirms[0] || "";
  t.match(msg, /Submit 2 claims to MFL\?/);
  t.match(msg, /Group 1 #1: Chase McLaughlin — \$12K — no drop/);
  t.match(msg, /Group 2 #1: Jonas Sanker — \$5K — drop Darren Waller/);
  t.match(msg, /Blind bids run at MFL's next scheduled run\./, "the waiver timing");
  t.equal(h.rec.writes.length, 0, "cancelled -> submitPlan never called");
});

await run("mobile_players_controls");
