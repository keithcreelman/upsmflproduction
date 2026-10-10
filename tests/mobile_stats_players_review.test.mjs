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
//   4. Controls: XpertRk gone, empty Routes hidden, SoSΔ / Market renamed.
//   5. The sheet: verified owner chip; Propose trade through the existing builder;
//      contract money from the worker's cap row (never ÷17); OWNER UNKNOWN is never
//      offered Bid / Add; opening ANY player makes no write-route request.
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
function boot(opt = {}) {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, Promise, URL, Date, Math, JSON });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  vm.runInContext(UTIL_SRC + "\nthis.__util = { safeStr, safeInt, pad4, escapeHtml, fmtUsd, asArray };", ctx);
  for (const f of ["site/m/season_scoring.js", "site/m/front_office_lineup.js"]) vm.runInContext(read(f), ctx);
  const state = {
    ctx: { year: "2026", leagueId: "74598" }, players: { players: { player: PLAYERS } },
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
  ctx.document = { getElementById: getEl, addEventListener() {}, body: { style: {} } };
  ctx.fetch = async (url, o) => {
    requests.push({ url: String(url), method: (o && o.method) || "GET" });
    const u = new URL(url);
    let body = {};
    if (u.pathname === "/api/advanced-stats-leaderboard") body = opt.leaderboard ? opt.leaderboard(u.searchParams.get("pos")) : leaderboard(u.searchParams.get("pos"));
    else if (u.pathname === "/api/player-routes") body = { by_gsis: opt.routes || {} };
    else if (/^\/api\/(sos-adjusted-points|player-consistency|player-epa|player-ngs)$/.test(u.pathname)) body = { by_gsis: {} };
    else if (u.pathname === "/api/mfl-market") body = { by_mfl: {} };
    return { ok: true, json: async () => body };
  };
  vm.runInContext(read("site/m/views/stats.js"), ctx);
  vm.runInContext(read("site/m/player_sheet.js"), ctx);
  return { ctx, M, state, els, getEl, mount, requests, builderCalls, render: () => views.stats(mount) };
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
    const cells = [...m[2].matchAll(/<span class="v[^"]*">([\s\S]*?)<\/span>(?=<span class="v|<\/div>|$)/g)].map((c) => c[1].replace(/<[^>]+>/g, "").trim());
    const rk = /<span class="rk">([^<]*)<\/span>/.exec(m[2])[1];
    const tm = /<span class="tm">([\s\S]*?)<\/span><\/span><\/span>/.exec(m[2])[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&");
    out.push({ pid: m[1], rk, cells, tm, live: m[2].includes("ups-m-st-live") });
  }
  return out;
}
const bands = (html) => [...html.matchAll(/<span class="band"[^>]*>([\s\S]*?)<\/span>(?=<span class="band|<span class="rk)/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());
const labels = (html) => [...html.matchAll(/<span class="v"[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]);

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
  t.match(v.mount.innerHTML, new RegExp('data-pid="' + ROUSSEAU + '"><span class="rk">\\d+</span><span class="nm"><span class="pos dl">DE</span>'));
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
  t.match(box.notes, /The stats source returns at most 500 players here, so \d+ listed DBs have no box score/);
  t.deepEqual(bands(box.head), ["nflverse Wk 1–4", "Wk 1–5"], "box score and live PPG under separate, explicit periods");
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
  t.match(v.getEl("ups-m-st-notes").innerHTML || v.mount.innerHTML, /MFL’s player list didn’t load, so this is the stats source’s list: nflverse positions, ranks within this list/);
  const dl = await openTab(v, "DL");
  t.match(v.mount.innerHTML, /This list is the stats source’s top 500 IDPs/, "the capped-list note returns with the capped list");
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
  t.deepEqual(paths, ["/api/advanced-stats-leaderboard", "/api/mfl-market", "/api/player-consistency", "/api/player-epa",
    "/api/player-ngs", "/api/player-routes", "/api/sos-adjusted-points"]);
  t.equal(v.requests.filter((r) => /leaderboard/.test(r.url)).length, 5, "one leaderboard call per alias, cached after");
});

test("the stats.js position table agrees with UPS_FRONT_OFFICE_LINEUP.posGroup on every position", () => {
  const v = boot();
  const FOL = v.ctx.UPS_FRONT_OFFICE_LINEUP;
  const src = read("site/m/views/stats.js");
  const table = JSON.parse("{" + /var GROUP = \{([^}]*)\}/.exec(src)[1].replace(/([A-Z]+):/g, '"$1":') + "}");
  for (const [pos, g] of Object.entries(table)) t.equal(FOL.posGroup(pos), g, pos);
});

// ═══ 2b. The stored fallback ═══
test("MFL scoring unreadable → the last VERIFIED stored totals, labelled Wks 1–4 with the read time; no recent form", async () => {
  const v = boot({ scores: { error: { $t: "simulated" } } });
  const html = await openTab(v, "QB");
  t.deepEqual(bands(html), ["Stored Wk 1–4"]);
  t.match(html, /MFL’s live scoring couldn’t be read, so these are the last verified stored totals: Wks 1–4, final weeks only \(stored copy read \d{1,2}:\d{2} (AM|PM)\)/);
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
test("column sets: Fantasy pts first; XpertRk removed; SoSΔ → Schedule-adjusted / 'Adj ±'; Market → All-MFL usage; ≤ 4 numbers each", async () => {
  const v = boot();
  const html = await openTab(v, "WR");
  const sets = [...html.matchAll(/<option value="([a-z]+)"[^>]*>([^<]*)<\/option>/g)].map((m) => m[2]).filter((l) => !/^(All|Rostered|Free agents)$/.test(l));
  t.deepEqual(sets, ["Fantasy pts", "Receiving", "Efficiency", "Schedule-adjusted", "Boom/Bust", "EPA", "All-MFL usage"], "Routes hidden: its source is empty for 2026");
  const srcNoComments = read("site/m/views/stats.js").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  t.ok(!/XpertRk|SoSΔ|l: "Market"|mrank/.test(srcNoComments), "no XpertRk column, no SoSΔ / Market labels in code");
  const sos = await chooseSet(v, "sos");
  t.deepEqual(labels(sos.head), ["Raw", "Adj", "Adj ±", "Wks"]);
  t.deepEqual(bands(sos.head), ["Stored MFL pts · own wks"], "never under the live Fantasy pts period");
  const boom = await chooseSet(v, "boom");
  t.deepEqual(labels(boom.head), ["Cons", "Boom%", "Bust%", "Wks"], "Boom/Bust carries the weeks ITS source counted");
  t.match(boom.notes, /Wks = the weeks it counted/);
  const usage = await chooseSet(v, "usage");
  t.match(usage.notes, /all MFL leagues .* — not UPS/);
  const setBlock = read("site/m/views/stats.js").slice(read("site/m/views/stats.js").indexOf("var TABS = ["), read("site/m/views/stats.js").indexOf("// scope:"));
  for (const m of setBlock.matchAll(/cols: \[([^\]]*)\]/g)) t.ok(m[1].split(",").length <= 4, "≤ 4 columns: " + m[1]);
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
const kv = (html) => Object.fromEntries([...html.matchAll(/<div class="lbl[^"]*">([^<]*)<\/div><div class="val[^"]*">([^<]*)<\/div>/g)].map((m) => [m[1], m[2]]));

test("Purdy (another team's player): salary, window, per week, earned through Wk 4, still due, and the arithmetic — all the worker's", () => {
  const v = boot();
  const body = bodyOf(v, PURDY), f = kv(body);
  t.equal(f["Salary"], "$22,000");
  t.equal(f["Earning window"], "Wks 1–17 · 17 wks");
  t.equal(f["Per week"], "$1,294");
  t.equal(f["Earned to date"], "$5,176 · thru Wk 4", "worker current_year_earned 5176, earned_through_week 4");
  t.equal(f["Still due this season"], "$16,824");
  t.match(body, /\$22,000 ÷ 17 eligible weeks \(Wks 1–17, from the week this contract began\) = \$1,294 a week\. Earned through Wk 4 = \$22,000 × 4 ÷ 17 = \$5,176, rounded once on the total\. Still due = \$22,000 − \$5,176\. League cap engine, calculated Oct \d+, \d{1,2}:\d{2} (AM|PM)\./);
  t.equal(f["Length"], "3 yrs"); t.equal(f["Total value"], "$84,000"); t.equal(f["Guaranteed"], "$63,000");
  t.equal(f["By year"], "Y1 $40K · Y2 $22K · Y3 $22K");
});

test("the window is the contract's OWN (eligible_weeks): Shipley's Week-5 claim earns over 13 weeks → $846/wk, never $11,000 ÷ 17", () => {
  const row = FX.cap_rows["16601"];
  t.ok(row, "Shipley's cap row is in the fixture");
  const v = boot();
  const f = kv(bodyOf(v, "16601"));
  t.equal(f["Earning window"], "Wks " + (18 - row.eligible_weeks) + "–17 · " + row.eligible_weeks + " wks");
  t.equal(f["Per week"], "$" + Math.round(row.current_year_salary / row.eligible_weeks).toLocaleString("en-US"));
  t.notEqual(f["Per week"], "$" + Math.round(row.current_year_salary / 17).toLocaleString("en-US"));
});

test("unpriceable → a stated reason, never a local estimate", () => {
  const cases = [
    [{ capMeta: null }, /Loading this contract’s earned-to-date/],
    [{ capMeta: { status: "error" } }, /couldn’t be reached\. Reload to retry — nothing is estimated in its place/],
    [{ capRows: {} }, /isn’t in the league cap engine’s list/],
    [{ capRows: { [PURDY]: Object.assign({}, FX.cap_rows[PURDY], { eligible_weeks: null }) } }, /couldn’t resolve this contract’s earning window .* never assumed to be 17 weeks/],
    [{ capRows: { [PURDY]: (({ eligible_weeks, ...r }) => r)(FX.cap_rows[PURDY]) } }, /never assumed to be 17 weeks/],
    [{ capRows: { [PURDY]: Object.assign({}, FX.cap_rows[PURDY], { needs_review: true, review_reason: "unstamped contract" }) } }, /under review \(unstamped contract\)/],
  ];
  for (const [opt, re] of cases) {
    const body = bodyOf(boot(opt), PURDY), f = kv(body);
    t.match(body, re, JSON.stringify(opt).slice(0, 60));
    t.equal(f["Salary"], "$22,000", "salary (MFL's) still shows");
    t.equal(f["Earned to date"], undefined, "no earned number");
    t.equal(f["Still due this season"], undefined);
    t.doesNotMatch(body, /\$1,294|\$5,176/, "nothing computed locally");
  }
  const full = kv(bodyOf(boot({ capRows: { [PURDY]: Object.assign({}, FX.cap_rows[PURDY], { earned_rule: "full_year_sub_5k", current_year_earned: null }) } }), PURDY));
  t.equal(full["Earned to date"], "Full-year rule");
  const ww = kv(bodyOf(boot({ capRows: { [PURDY]: Object.assign({}, FX.cap_rows[PURDY], { earned_rule: "ww_earned_na", current_year_earned: null }) } }), PURDY));
  t.equal(ww["Earned to date"], "n/a");
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

await run("mobile_stats_players_review");
