// Mobile Live Scoring (#scores): Q / D / OUT come from the OFFICIAL NFL injury report — Keith's 2026-10-12 ruling.
//   node tests/mobile_live_scoring_official_injury.test.mjs
//
// The board used to tag AND discount live projections by MFL's own injuries export, which keeps
// Q/D/Out for weeks after they lapse. It now reads the same source as Stats → Players and the
// player sheet (/api/player-status through UPS_MOBILE_PLAYER_STATUS in site/m/player_sheet.js):
//   1. official Out → OUT tag and no remaining projection; official Q / D → 0.75 / 0.40;
//   2. MFL says Out (or Doubtful) but the official report doesn't list him → no tag, no discount;
//   3. report loading / stale / unavailable / not current / another week → NO Q/D/OUT tag, NO
//      game-status discount, and one line says the report is unavailable (or being checked);
//   4. MFL's roster designations (IR, IR-PUP, Suspended …) still tag and zero the remainder, as before.
// The real modules run in one vm context (live_scoring.js, injury_overrides.js, player_sheet.js,
// views/scores.js) against tests/fixtures/mobile_live_scoring_official_injury.json (synthetic
// players, real export shapes). fetch is stubbed; nothing leaves the process.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const FX = JSON.parse(read("tests/fixtures/mobile_live_scoring_official_injury.json"));
const APP = read("site/m/app.js");
const SCORES = read("site/m/views/scores.js");

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
const UTIL_SRC = ["function safeStr(", "function safeInt(", "function pad4(", "function escapeHtml(", "function asArray("]
  .map((s) => sliceFn(APP, s)).join("\n");

// /api/player-status as the worker answers it (fixture: Wk 6 report read, current), with edits.
const STATUS = (feed = {}, players) => Object.assign({}, FX.playerStatus, {
  report_feed: Object.assign({}, FX.playerStatus.report_feed, feed),
  players: players || FX.playerStatus.players });
const deferred = () => { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; };

function boot(opt = {}) {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, Promise, URL, Date, Math, JSON });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  vm.runInContext(UTIL_SRC + "\nthis.__util = { safeStr, safeInt, pad4, escapeHtml, asArray };", ctx);
  for (const f of ["site/shared/live_scoring.js", "site/shared/injury_overrides.js"]) vm.runInContext(read(f), ctx);
  const state = Object.assign({ ctx: { year: "2026", leagueId: "74598" }, viewerFranchiseId: "0001",
    franchises: FX.franchises, lineupWeek: 6, sbExpand: "me", sbApExpand: "0002" }, opt.state || {});
  const byId = Object.fromEntries(FX.players.map((p) => [p.id, p]));
  const requests = [], views = {};
  let renders = 0;
  const mount = { innerHTML: "", querySelector: () => null, querySelectorAll: () => [] };
  const paint = () => { renders++; views.scores(mount); };
  ctx.UPS_MOBILE = {
    util: ctx.__util, state,
    api: { workerUrl: (p) => "https://w.test" + p, workerBase: () => "https://w.test" },
    data: { playerById: (id) => byId[String(id)] || null, irEligibilityFor: () => ({ known: false }) },
    actions: {}, ui: { showToast() {} },
    route: { registerView: (n, fn) => (views[n] = fn), renderRoute: paint, currentRoute: () => "scores", navigate() {} },
    renderRoute: paint,
  };
  ctx.document = { getElementById: () => null, addEventListener() {}, hidden: false, body: { style: {} } };
  let statusCalls = 0;
  ctx.fetch = async (url, o) => {
    requests.push({ url: String(url), method: (o && o.method) || "GET" });
    const u = new URL(url);
    let body = null;
    if (u.pathname === "/api/player-status") {
      const st = typeof opt.status === "function" ? opt.status(statusCalls++) : opt.status;
      if (st === 500) return { ok: false, status: 500, json: async () => ({ ok: false }) };
      if (st === "hold") return new Promise(() => {});                       // never answers
      if (st && typeof st.then === "function") return st.then((b) => ({ ok: true, status: 200, json: async () => b }));
      body = st || STATUS();
    }
    else if (u.pathname === "/api/league-years") body = { years: [{ season: 2026, server: "www48", league_id: "74598" }, { season: 2025, server: "www48", league_id: "74598" }] };
    else if (u.pathname === "/api/current-lineup-week") body = { week: 6 };
    else if (u.pathname === "/api/mfl-export") {
      const type = u.searchParams.get("TYPE");
      body = opt.exports && type in opt.exports ? opt.exports[type] : FX[type];
    }
    return { ok: true, status: 200, json: async () => body };
  };
  vm.runInContext(read("site/m/player_sheet.js"), ctx);
  vm.runInContext(read("site/m/views/scores.js"), ctx);
  return { ctx, state, mount, requests, paint, renders: () => renders, PS: ctx.UPS_MOBILE_PLAYER_STATUS };
}
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); };
async function open(opt) { const v = boot(opt); v.paint(); await settle(); return v; }

// pid → { tag, live, proj } of every expanded player row (my starters + the opponent's via All-Play).
function rowsOf(html) {
  const out = {};
  for (const m of html.matchAll(/data-bd-pid="(\d+)">([\s\S]*?)<span class="ups-m-sb-pl-pts">([-\d.]+)<small>([-\d.]+)<\/small>/g)) {
    const tag = /<span class="ups-m-sb-inj">([^<]*)<\/span>/.exec(m[2]);
    out[m[1]] = { tag: tag ? tag[1] : "", live: m[3], proj: m[4] };
  }
  return out;
}
// fid → All-Play projected finish.
const teamProj = (html) => Object.fromEntries([...html.matchAll(/data-apexp="(\d{4})">[\s\S]*?<span class="pj">([-\d.]+)<\/span>/g)].map((m) => [m[1], m[2]]));
const noteOf = (html) => { const m = /<div class="ups-m-sb-note">([^<]*)<\/div>/.exec(html); return m ? m[1] : ""; };
const GAME_TAGS = ["OUT", "D", "Q"];
const gameTagged = (rows) => Object.keys(rows).filter((pid) => GAME_TAGS.includes(rows[pid].tag));
const UNAVAILABLE = /^Injury report unavailable, so no Q\/D\/OUT tags or injury discounts — no tag doesn’t mean healthy\.$/;
const CHECKING = /^Checking this week’s injury report — no Q\/D\/OUT tags or injury discounts until it’s read\.$/;
// MFL's roster designations, the same with or without the report (injuryShort: IR-PUP → IR, SUSPENDED → SUS).
function rosterKindsStand(rows, proj) {
  t.equal(rows["90003"].tag, "IR", "MFL IR still tagged"); t.equal(rows["90003"].proj, "0.0", "and still projects nothing more");
  t.equal(rows["90007"].tag, "IR", "MFL IR-PUP still tagged (as before)"); t.equal(rows["90007"].proj, "0.0");
  t.equal(rows["90010"].tag, "SUS", "MFL Suspended still tagged"); t.equal(rows["90010"].proj, "0.0");
  t.equal(proj["0002"], "19.0", "the opponent: 10.0 so far + QB 18 × half a game; IR-PUP and Suspended add nothing");
}

// ═══ 1. the official report drives Q / D / OUT ═══
test("fixture sanity: Wk 6 in progress (liveScoring, weeklyResults all 0.0), MFL's export carries lapsed Out/Doubtful, the official report is current", () => {
  t.equal(FX.liveScoring.liveScoring.week, "6");
  t.ok(FX.weeklyResults.weeklyResults.matchup[0].franchise.every((f) => Number(f.score) === 0));
  const mfl = Object.fromEntries(FX.injuries.injuries.injury.map((i) => [i.id, i.status]));
  t.equal(mfl["90002"], "Out"); t.equal(mfl["90008"], "Doubtful");
  t.equal(FX.playerStatus.players["90002"], undefined, "90002 is not on the official Wk 6 report");
  t.equal(FX.playerStatus.players["90008"], undefined, "nor is 90008");
  t.equal(FX.playerStatus.report_feed.current, true); t.equal(FX.playerStatus.report_feed.week, 6);
});

test("official Out → OUT tag and no remaining projection; official Q and D discount the remainder by 0.75 and 0.40", async () => {
  const v = await open();
  const html = v.mount.innerHTML, rows = rowsOf(html), proj = teamProj(html);
  t.equal(rows["90001"].tag, "OUT", "official Out"); t.equal(rows["90001"].proj, "0.0", "20.0 projected, ruled out → nothing more");
  t.equal(rows["90004"].tag, "Q", "official Questionable"); t.equal(rows["90004"].proj, "8.5", "4.0 + 12 × 0.75 × half a game");
  t.equal(rows["90005"].tag, "D", "official Doubtful"); t.equal(rows["90005"].proj, "4.0", "10 × 0.40");
  t.equal(rows["90006"].tag, ""); t.equal(rows["90006"].live, "7.0", "a finished, healthy kicker (a final row shows its original 8.0)");
  t.equal(proj["0001"], "31.5", "11.0 so far + 12 (90002) + 4.5 (90004) + 4.0 (90005)");
  t.match(html, /<span class="ups-m-sb-num">11\.0<small>proj 31\.5<\/small>/, "my row's projection");
  rosterKindsStand(rows, proj);
  t.equal(noteOf(html), "", "a current report needs no line");
  const st = v.requests.filter((r) => new URL(r.url).pathname === "/api/player-status");
  t.equal(st.length, 1, "one read of the shared status route");
  t.equal(new URL(st[0].url).searchParams.get("season"), "2026");
});

test("MFL says Out (lapsed) but the official report doesn't list him → no tag and his full projection; same for a lapsed Doubtful on the bench", async () => {
  const v = await open();
  const rows = rowsOf(v.mount.innerHTML);
  t.equal(rows["90002"].tag, "", "no OUT from MFL's lapsed designation"); t.equal(rows["90002"].proj, "12.0", "no discount");
  v.state.sbRosterView = "bench"; v.paint();
  const bench = rowsOf(v.mount.innerHTML);
  t.equal(bench["90008"].tag, "", "no D from MFL's lapsed Doubtful"); t.equal(bench["90008"].proj, "6.0");
  // BEFORE (the same board on MFL's export alone — what shipped through build 2026.10.11.4):
  const LS = v.ctx.UPSLive, store = LS.createInjuryStore();
  store.put(FX.injuries, { season: 2026 });
  const projOf = Object.fromEntries(FX.projectedScores.projectedScores.playerScore.map((p) => [p.id, Number(p.score)]));
  const old = LS.computeTeam("0001", "Test Alphas", { source: "live", live: FX.liveScoring, weekly: FX.weeklyResults,
    injuryOf: (pid) => LS.injuryStatusFor({ store, season: 2026, week: 6 }, pid), projOf: (pid) => projOf[pid] || 0, metaOf: () => ({}) });
  const oldRow = (pid) => old.starters.find((r) => r.pid === pid);
  t.equal(oldRow("90002").status, "OUT", "before: MFL's lapsed Out was shown"); t.equal(oldRow("90002").projFinal, 0, "and zeroed his 12.0");
  t.equal(oldRow("90001").status, "", "before: the player actually ruled out on the official report had no tag"); t.equal(oldRow("90001").projFinal, 20);
  t.equal(old.projFinal, 45.5, "before: 45.5; after: 31.5");
});

// ═══ 2. no current report → no Q/D/OUT and no game-status discount, said in one line ═══
test("report unavailable (the route fails) → no Q/D/OUT tag, no game-status discount, the unavailable line; MFL IR/PUP/Suspended still tagged", async () => {
  const v = await open({ status: 500 });
  const html = v.mount.innerHTML, rows = rowsOf(html), proj = teamProj(html);
  t.deepEqual(gameTagged(rows), [], "no Q, D or OUT anywhere — not even MFL's Questionable on 90004");
  t.equal(rows["90001"].proj, "20.0", "no discount without the report");
  t.equal(rows["90004"].proj, "10.0", "4.0 + 12 × half a game, undiscounted");
  t.equal(rows["90005"].proj, "10.0");
  t.equal(proj["0001"], "59.0");
  rosterKindsStand(rows, proj);
  t.match(noteOf(html), UNAVAILABLE);
});

test("report loading → no Q/D/OUT and the 'checking' line; when the read lands the board repaints ONCE with the official tags", async () => {
  const d = deferred();
  const v = await open({ status: () => d.p });
  let html = v.mount.innerHTML, rows = rowsOf(html);
  t.deepEqual(gameTagged(rows), []);
  t.equal(rows["90001"].proj, "20.0");
  rosterKindsStand(rows, teamProj(html));
  t.match(noteOf(html), CHECKING);
  const before = v.renders();
  d.resolve(STATUS()); await settle();
  t.equal(v.renders(), before + 1, "one repaint when the report lands");
  html = v.mount.innerHTML; rows = rowsOf(html);
  t.equal(rows["90001"].tag, "OUT"); t.equal(rows["90001"].proj, "0.0");
  t.equal(noteOf(html), "");
  v.paint(); await settle();
  t.equal(v.renders(), before + 2, "a cached read repaints nothing more (no render loop)");
  t.equal(v.requests.filter((r) => /player-status/.test(r.url)).length, 1, "and reads nothing more inside 5 minutes");
});

test("a read older than 5 minutes is never used: refresh in flight → 'checking'; refresh failed → unavailable (and the loader's other views agree)", async () => {
  const v = await open({ status: (n) => (n === 0 ? STATUS() : "hold") });
  t.equal(rowsOf(v.mount.innerHTML)["90001"].tag, "OUT");
  v.PS._st.at -= v.PS.TTL + 1000;
  t.equal(v.PS.currentReport().state, "loading", "stale = no finding");
  t.deepEqual(JSON.parse(JSON.stringify(v.PS.info("90001", "BUF").chips.map((c) => c.t))), [], "the sheet shows no chip for the same stale read");
  v.paint(); await settle();
  let html = v.mount.innerHTML;
  t.deepEqual(gameTagged(rowsOf(html)), []); t.equal(rowsOf(html)["90001"].proj, "20.0");
  t.match(noteOf(html), CHECKING);
  t.equal(v.requests.filter((r) => /player-status/.test(r.url)).length, 2, "the stale read was refreshed");

  const v2 = await open({ status: (n) => (n === 0 ? STATUS() : 500) });
  v2.PS._st.at -= v2.PS.TTL + 1000;
  v2.paint(); await settle();
  html = v2.mount.innerHTML;
  t.deepEqual(gameTagged(rowsOf(html)), []); t.equal(rowsOf(html)["90001"].proj, "20.0");
  rosterKindsStand(rowsOf(html), teamProj(html));
  t.match(noteOf(html), UNAVAILABLE);
  t.match(v2.PS.listLine(), /^Injury tags unavailable/, "the Stats list says the same");
});

test("a report that isn't current (too old, or MFL's week unknown) → unavailable: no Q/D/OUT, no discount", async () => {
  for (const feed of [{ current: false, reason: "report not updated for 40.2 h", age_hours: 40.2 },
                      { current: false, reason: "current NFL week unknown (MFL unreadable)", current_week: null }]) {
    const v = await open({ status: STATUS(feed) });
    const html = v.mount.innerHTML, rows = rowsOf(html);
    t.deepEqual(gameTagged(rows), [], feed.reason);
    t.equal(teamProj(html)["0001"], "59.0", feed.reason);
    rosterKindsStand(rows, teamProj(html));
    t.match(noteOf(html), UNAVAILABLE, feed.reason);
  }
});

test("a current report for ANOTHER week than the board shows (Wk 5 report, Wk 6 board) → unavailable, never last week's Out", async () => {
  const v = await open({ status: STATUS({ week: 5, current_week: 5 }) });
  const html = v.mount.innerHTML, rows = rowsOf(html);
  t.equal(v.PS.currentReport().state, "ok", "the loader itself has a current Wk 5 report");
  t.deepEqual(gameTagged(rows), []);
  t.equal(teamProj(html)["0001"], "59.0");
  t.match(noteOf(html), UNAVAILABLE);
});

// ═══ 3. unchanged surfaces ═══
test("a FINAL week (weekly results) shows no designation and no line, as before", async () => {
  const scored = JSON.parse(JSON.stringify(FX.weeklyResults));
  scored.weeklyResults.matchup[0].franchise[0].score = "88.4"; scored.weeklyResults.matchup[0].franchise[1].score = "71.2";
  scored.weeklyResults.matchup[0].franchise[0].player = FX.liveScoring.liveScoring.matchup[0].franchise[0].players.player;
  const v = await open({ exports: { weeklyResults: scored } });
  const html = v.mount.innerHTML;
  t.match(html, /<span class="ups-m-sb-final">Final<\/span>/);
  t.equal(Object.values(rowsOf(html)).filter((r) => r.tag).length, 0, "no tag of any kind on a final week (unchanged)");
  t.equal(noteOf(html), "");
});

test("a past season's board never reads (or resets) the current season's report", async () => {
  const v = await open({ state: { sbYear: "2025" } });
  t.equal(v.requests.filter((r) => /player-status/.test(r.url)).length, 0);
  t.deepEqual(gameTagged(rowsOf(v.mount.innerHTML)), []);
});

test("source: MFL's export is kept for roster kinds only; every request is a GET", async () => {
  const kinds = /var MFL_ROSTER_KINDS = \{([^}]*)\}/.exec(SCORES)[1];
  t.doesNotMatch(kinds, /"OUT"|QUES|DOUB/, "no MFL game status in the kept list");
  t.match(SCORES, /if \(MFL_ROSTER_KINDS\[mfl\]\) return mfl;/);
  t.match(SCORES, /injuryOf: function \(pid\) \{ return boardStatusFor\(rep, pid\); \}/, "computeTeam reads the board status, not MFL's raw designation");
  const v = await open();
  t.ok(v.requests.length > 0 && v.requests.every((r) => r.method === "GET"), "read-only");
});

test("the mobile release is stamped together and busts the cache of both changed files", () => {
  const build = JSON.parse(read("site/m/version.json")).build, idx = read("site/m/index.html");
  t.equal(APP.match(/var BUILD = "([^"]+)";/)[1], build);
  const stampNum = (s) => s.split(".").map((x) => x.padStart(4, "0")).join("");
  for (const f of ["./app.js", "./player_sheet.js", "./views/scores.js"]) {
    const m = idx.match(new RegExp(f.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&") + "\\?v=([0-9.]+)"));
    t.ok(m && stampNum(m[1]) >= stampNum("2026.10.12.1"), f + " carries 2026.10.12.1 or later");
  }
});

run("mobile_live_scoring_official_injury");
