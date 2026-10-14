// Stats → Sched on mobile (site/m/views/stats.js, #1270), run for real in node:vm on a tree DOM,
// fed the draft engine's own /api/fantasy-sos?v=2 answers (2026 after Wk 5; 2025 finished).
// Keith's rulings 2026-10-13: a DESCRIPTIVE schedule (no easy/tough), opens on QB and shares the
// position with Pts Agst, Weeks = Rest of season / All weeks / Playoffs / Custom, a Points allowed
// vs "vs usual" toggle, an Avg per team for the chosen weeks (sortable; most allowed first), and
// the Pts Agst restrained color rule. Plus the review's bugs: late paint over another screen,
// position-tap races, stuck failures, Week 18, wrong pre-2021 playoff weeks.
//   node tests/mobile_sched.test.mjs
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert";
import { makeDocument, settle } from "./fixtures/tree_dom.mjs";

const read = (p) => fs.readFileSync(new URL("../" + p, import.meta.url), "utf8");
const FX = JSON.parse(read("tests/fixtures/sched_v2_2026_10_13.json"));
const D26 = FX.v2_2026, D25 = FX.v2_2025;
const APP = read("site/m/app.js");
function sliceFn(src, sig) { const at = src.indexOf(sig); let i = src.indexOf("{", at), d = 0; for (; i < src.length; i++) { if (src[i] === "{") d++; else if (src[i] === "}" && --d === 0) return src.slice(at, i + 1); } }
const UTIL = ["function safeStr(", "function safeInt(", "function pad4(", "function escapeHtml(", "function fmtUsd(", "function asArray("].map((s) => sliceFn(APP, s)).join("\n");

let fails = 0;
const check = async (n, fn) => { try { await fn(); console.log("  ok   " + n); } catch (e) { fails++; console.log("  FAIL " + n + "\n         " + (e && e.message)); } };
const clone = (x) => JSON.parse(JSON.stringify(x));

// A minimal Pts Agst breakdown, enough for the drill to render (its numbers are tested elsewhere).
const detail = (team, pos) => ({ ok: true, year: "2026", team, pos, season: D26.season, weeksUsed: [1, 2, 3, 4, 5], gamesPlayed: 5,
  perGame: D26.teams[team][pos].raw.perGame, usualPerGame: D26.teams[team][pos].raw.oppNorm, ratio: D26.teams[team][pos].adj.ratio,
  rank: D26.teams[team][pos].adj.rank, of: 32, schedule: [], weeks: [], teamGames: {} });

function boot(opt = {}) {
  const doc = makeDocument();
  const mount = doc.mount("ups-m-main");
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, Promise, URL, Date, Math, JSON, AbortController });
  ctx.window = ctx; ctx.document = doc;
  const winL = {};
  ctx.addEventListener = (t, fn) => (winL[t] = winL[t] || []).push(fn);
  ctx.scrollY = 0; ctx.scrollTo = (x, y) => { ctx.scrollY = y; };
  const stack = [{ state: null }];
  ctx.history = {
    get state() { return stack[stack.length - 1].state; },
    pushState(s) { stack.push({ state: JSON.parse(JSON.stringify(s)) }); },
    replaceState(s) { stack[stack.length - 1] = { state: s }; },
    back() { if (stack.length > 1) stack.pop(); setTimeout(() => (winL.popstate || []).forEach((fn) => fn({ state: ctx.history.state })), 0); },
  };
  vm.runInContext(UTIL + "\nthis.__util = { safeStr, safeInt, pad4, escapeHtml, fmtUsd, asArray };", ctx);
  const requests = [];
  let route = "league/stats";
  const views = {};
  const state = { ctx: { year: "2026", leagueId: "74598" }, players: { players: { player: [] } }, viewerFranchiseId: "0008", loadingPromise: {} };
  ctx.UPS_MOBILE = {
    util: ctx.__util, state,
    api: { workerUrl: (p) => "https://w.test" + p },
    data: { getAdvancedStatsLatestYear: () => 2026, playerById: () => null, getSeasonScoring: () => null, ownerOfPid: () => ({}), rosterOwnership: () => ({}) },
    route: { registerView: (n, fn) => (views[n] = fn), renderRoute: () => views.stats(mount), currentRoute: () => route, navigate() {} },
    sheet: { open() {} }, ui: { showToast() {} },
  };
  const gates = [];
  ctx.fetch = (url, o) => {
    requests.push({ url: String(url), method: (o && o.method) || "GET" });
    const u = new URL(url), q = u.searchParams;
    const answer = (status, body) => ({ ok: status === 200, status, json: async () => body });
    const respond = () => {
      if (u.pathname === "/api/league-years") return answer(200, { years: [{ season: 2026 }, { season: 2025 }, { season: 2024 }] });
      if (opt.fail && opt.fail(u)) return answer(502, { ok: false, error: "mfl_unavailable" });
      if (opt.answer) { const a = opt.answer(u); if (a) return answer(200, a); }
      if (u.pathname === "/api/fantasy-sos") return answer(200, q.get("season") === "2025" ? D25 : D26);
      if (u.pathname === "/api/fantasy-points-against") return answer(200, { ok: true, year: "2026", season: D26.season, weeksUsed: D26.weeksUsed, teams: D26.teams, teamGames: D26.teamGames, pending: [] });
      if (u.pathname === "/api/fpa-detail") return answer(200, detail(q.get("team"), q.get("pos")));
      return null;
    };
    const r = respond();
    if (r == null) return new Promise(() => {});          // the Players board's own loaders: never answer
    if (opt.hold && opt.hold(u)) return new Promise((res) => gates.push(() => res(r)));
    return Promise.resolve(r);
  };
  vm.runInContext(read("site/m/views/stats.js"), ctx);
  const render = () => views.stats(mount);
  const v = {
    ctx, doc, mount, requests, gates, stack,
    setRoute: (r) => { route = r; },
    render,
    async board(key) { mount.querySelector('.ups-m-stseg[data-inner="' + key + '"]').click(); await settle(); },
    async open() { render(); await settle(); await v.board("sched"); },
    rows: () => mount.querySelectorAll(".ups-m-sched-row[data-schedteam]"),
    heads: () => mount.querySelectorAll(".ups-m-sched-row.head .wk").map((h) => h.textContent.trim()),
    text: () => mount.textContent.replace(/\s+/g, " "),
    sosGets: () => requests.filter((r) => /\/api\/fantasy-sos/.test(r.url)),
    async sel(id, val) { const s = mount.querySelector("#" + id); s.value = String(val); s.dispatch("change"); await settle(); },
    pressed: (attr) => mount.querySelectorAll("[" + attr + "]").filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.getAttribute(attr)),
  };
  return v;
}

// ── Independent expectations, straight from the fixture ──
const K = { QB: 50, RB: 30, WR: 50, TE: 30, DL: 20, LB: 120, DB: 50, PK: 50, PN: 120 };
const gamesOf = (d, t, pos) => { const tg = d.teamGames[t]; return tg && tg.games != null ? tg.games : d.teams[t][pos].raw.games; };
const colored = (r, g, pos) => r != null && Math.round((r - 1) * 100) !== 0 && g > 0 && Math.abs((g * r + K[pos]) / (g + K[pos]) - 1) >= 0.08;
const signedPct = (r) => { const p = Math.round((r - 1) * 100); return p === 0 ? "0%" : (p > 0 ? "+" : "−") + Math.abs(p) + "%"; };
function expectRows(d, pos, weeks, show) {
  const lg = d.league.perGame[pos];
  return Object.keys(d.schedule).map((tm) => {
    const games = d.schedule[tm], bye = (games.find((g) => g.bye) || {}).wk || null;
    let sum = 0, n = 0;
    const cells = weeks.map((w) => {
      const g = games.find((x) => x.wk === w);
      if (g.bye) return { txt: "BYE", color: false };
      const c = d.teams[g.opp] && d.teams[g.opp][pos];
      const val = !c ? null : (show === "vs" ? c.adj.ratio : c.raw.perGame);
      const r = !c ? null : (show === "vs" ? c.adj.ratio : c.raw.perGame / lg);
      if (val != null) { sum += val; n++; }
      return { txt: (g.home ? "vs" : "@") + g.opp + (val == null ? "—" : (show === "vs" ? signedPct(val) : val.toFixed(1))), color: c ? colored(r, gamesOf(d, g.opp, pos), pos) : false, status: g.status };
    });
    return { tm, bye, cells, avg: n ? sum / n : null };
  }).sort((a, b) => (b.avg - a.avg) || (a.tm < b.tm ? -1 : 1));
}
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const cellTexts = (row) => row.querySelectorAll(".c").map((c) => c.textContent.replace(/\s+/g, ""));

console.log("1. the default board (2026 after Wk 5): QB, Rest of season, Points allowed, Avg most allowed first");
{
  const v = await (async () => { const b = boot(); await b.open(); return b; })();
  await check("ONE request for the whole board: /api/fantasy-sos?v=2 (this season; no pos: the answer holds all nine)", () => {
    const g = v.sosGets(); assert.strictEqual(g.length, 1, g.map((r) => r.url).join());
    assert.strictEqual(g[0].url, "https://w.test/api/fantasy-sos?v=2");
  });
  await check("opens on QB (only the QB chip pressed)", () => assert.deepStrictEqual(v.pressed("data-schedpos"), ["QB"]));
  await check("Weeks = Rest of season: Wk 6 … Wk 17 headings; Wk 6 marked 'now', 15–17 'playoff'; no Week 18", () => {
    assert.strictEqual(v.mount.querySelector("#ups-m-sched-weeks").value, "rest");
    assert.deepStrictEqual(v.heads(), range(6, 17).map((w) => "Wk " + w + (w === 6 ? "now" : (w >= 15 ? "playoff" : ""))));
  });
  const want = expectRows(D26, "QB", range(6, 17), "pts");
  await check("32 rows, ordered by Avg (opponents' QB points allowed per game, weeks 6–17, byes skipped), highest first", () => {
    assert.deepStrictEqual(v.rows().map((r) => r.getAttribute("data-schedteam")), want.map((r) => r.tm));
  });
  await check("every cell = 'vs DET'/'@GB' + that opponent's points allowed per game to QBs; BYE in the bye week; Avg to one decimal", () => {
    for (const r of v.rows()) {
      const w = want.find((x) => x.tm === r.getAttribute("data-schedteam"));
      assert.deepStrictEqual(cellTexts(r), w.cells.map((c) => c.txt), w.tm);
      assert.strictEqual(r.querySelector(".ag").textContent.trim(), w.avg.toFixed(1), w.tm + " avg");
      assert.strictEqual(r.querySelector(".tm small").textContent, w.bye ? "Bye Wk " + w.bye : "No bye");
    }
  });
  await check("BUF's row matches MFL's schedule: Wk 6 @LVR, Wk 7 BYE (spot check against the raw answer)", () => {
    const buf = v.rows().find((r) => r.getAttribute("data-schedteam") === "BUF");
    const c = cellTexts(buf);
    assert.ok(c[0].startsWith("@LVR"), c[0]); assert.strictEqual(c[1], "BYE");
  });
  await check("restrained color (QB k = 50 games): exactly the cells whose gap is still 8%+ after shrinking (none this early)", () => {
    const got = [], exp = [];
    for (const r of v.rows()) {
      const w = want.find((x) => x.tm === r.getAttribute("data-schedteam"));
      r.querySelectorAll(".c").forEach((c, i) => { if (c.querySelector(".ups-m-tr.up, .ups-m-tr.dn")) got.push(w.tm + i); if (w.cells[i].color) exp.push(w.tm + i); });
    }
    assert.deepStrictEqual(got.sort(), exp.sort());
  });
  await check("the plain line names the weeks, the number, the basis and the default order; three sentences; no easy/tough", () => {
    const t = v.mount.querySelector("#ups-m-sched-window").textContent.replace(/\s+/g, " ");
    assert.strictEqual(t, "Wks 6–17 · points opponents have allowed to QBs so far (Wks 1–5), per game; league average " + D26.league.perGame.QB.toFixed(1) + ". Default order: most allowed first.");
    assert.ok(/This shows games already played\. It isn’t a forecast of future matchups\. Color appears only when the difference remains large after adjusting for small sample sizes\./.test(v.text()));
    assert.ok(!/easy|tough|easiest|strength of schedule/i.test(v.text()), "no easy/tough wording");
  });
  await check("no played-week dimming in Rest of season (Wk 6 hasn't started)", () => assert.strictEqual(v.mount.querySelectorAll(".c.off").length, 0));
}

console.log("2. Show: vs usual (no request), sorting, and the shared position");
{
  const v = boot(); await v.open();
  v.mount.querySelector('[data-schedshow="vs"]').click(); await settle();
  const want = expectRows(D26, "QB", range(6, 17), "vs");
  await check("vs usual: cells = the opponent's signed % vs usual (real minus); Avg = the opponents' average %; re-ordered; no new request", () => {
    assert.deepStrictEqual(v.pressed("data-schedshow"), ["vs"]);
    assert.deepStrictEqual(v.rows().map((r) => r.getAttribute("data-schedteam")), want.map((r) => r.tm));
    for (const r of v.rows()) {
      const w = want.find((x) => x.tm === r.getAttribute("data-schedteam"));
      assert.deepStrictEqual(cellTexts(r), w.cells.map((c) => c.txt));
      assert.strictEqual(r.querySelector(".ag").textContent.trim(), signedPct(w.avg));
    }
    assert.strictEqual(v.sosGets().length, 1);
    assert.ok(/^Wks 6–17 · how far above or below usual opponents have held QBs so far \(Wks 1–5\)\. Default order: most above usual first\./.test(v.mount.querySelector("#ups-m-sched-window").textContent));
  });
  await check("Team sorts A→Z, again Z→A; Avg returns to most allowed first, again lowest first (aria-sort follows)", async () => {
    const order = () => v.rows().map((r) => r.getAttribute("data-schedteam"));
    const az = order().slice().sort();
    v.mount.querySelector('[data-schedsort="team"]').click(); await settle();
    assert.deepStrictEqual(order(), az);
    assert.strictEqual(v.mount.querySelector('[data-schedsort="team"]').parentNode.getAttribute("aria-sort"), "ascending");
    v.mount.querySelector('[data-schedsort="team"]').click(); await settle();
    assert.deepStrictEqual(order(), az.slice().reverse());
    v.mount.querySelector('[data-schedsort="avg"]').click(); await settle();
    assert.deepStrictEqual(order(), want.map((r) => r.tm));
    assert.strictEqual(v.mount.querySelector('[data-schedsort="avg"]').parentNode.getAttribute("aria-sort"), "descending");
    v.mount.querySelector('[data-schedsort="avg"]').click(); await settle();
    assert.deepStrictEqual(order(), want.slice().reverse().map((r) => r.tm).sort((a, b) => {
      const A = want.find((x) => x.tm === a).avg, B = want.find((x) => x.tm === b).avg; return (A - B) || (a < b ? -1 : 1);
    }));
    assert.strictEqual(v.sosGets().length, 1);
  });
  await check("tapping RB re-colors from the same answer (no request), and Pts Agst then opens on RB (shared position)", async () => {
    v.mount.querySelector('[data-schedpos="RB"]').click(); await settle();
    assert.deepStrictEqual(v.pressed("data-schedpos"), ["RB"]);
    assert.strictEqual(v.sosGets().length, 1);
    await v.board("fpa");
    assert.deepStrictEqual(v.pressed("data-fpapos"), ["RB"]);
  });
  await check("…and a position picked on Pts Agst carries back to Sched (WR)", async () => {
    v.mount.querySelector('[data-fpapos="WR"]').click(); await settle();
    await v.board("sched");
    assert.deepStrictEqual(v.pressed("data-schedpos"), ["WR"]);
    assert.ok(/allowed to WRs|held WRs/.test(v.mount.querySelector("#ups-m-sched-window").textContent));
  });
}

console.log("3. Weeks: All weeks, Playoffs, Custom; a finished season; a 16-week league");
{
  const v = boot(); await v.open();
  await v.sel("ups-m-sched-weeks", "all");
  await check("All weeks = Wk 1–17 (never 18); the 5 played weeks dimmed in every row", () => {
    assert.deepStrictEqual(v.heads().map((h) => h.replace(/now|playoff/, "")), range(1, 17).map((w) => "Wk " + w));
    for (const r of v.rows()) {
      const off = r.querySelectorAll(".c").map((c, i) => c.classList.contains("off") ? i + 1 : 0).filter(Boolean);
      const games = D26.schedule[r.getAttribute("data-schedteam")];
      assert.deepStrictEqual(off, games.filter((g) => !g.bye && g.status === "final").map((g) => g.wk));
    }
  });
  await check("Avg for All weeks matches the opponents over weeks 1–17", () => {
    const want = expectRows(D26, "QB", range(1, 17), "pts");
    assert.deepStrictEqual(v.rows().map((r) => r.getAttribute("data-schedteam") + " " + r.querySelector(".ag").textContent.trim()), want.map((w) => w.tm + " " + w.avg.toFixed(1)));
  });
  await v.sel("ups-m-sched-weeks", "playoffs");
  await check("Playoffs = the league's playoff weeks from the answer (15–17)", () => {
    assert.deepStrictEqual(D26.playoffWeeks, [15, 16, 17]);
    assert.deepStrictEqual(v.heads().map((h) => h.replace(/now|playoff/, "")), ["Wk 15", "Wk 16", "Wk 17"]);
    assert.ok(/Playoffs \(Wks 15–17\)/.test(v.mount.querySelector("#ups-m-sched-weeks").textContent));
  });
  await v.sel("ups-m-sched-weeks", "custom");
  await check("Custom starts from the weeks on screen (15–17); From/To pick any league week", async () => {
    assert.strictEqual(v.mount.querySelector("#ups-m-sched-from").value, "15");
    assert.strictEqual(v.mount.querySelector("#ups-m-sched-to").value, "17");
    assert.strictEqual(v.mount.querySelector("#ups-m-sched-to").querySelectorAll("option").length, 17);
    await v.sel("ups-m-sched-from", 8); await v.sel("ups-m-sched-to", 10);
    assert.deepStrictEqual(v.heads(), ["Wk 8", "Wk 9", "Wk 10"]);
    await v.sel("ups-m-sched-from", 12);   // From after To: To follows
    assert.deepStrictEqual(v.heads(), ["Wk 12"]);
    assert.strictEqual(v.sosGets().length, 1);
  });
  await check("a finished season (2025): no Rest of season option, opens on All weeks, nothing dimmed, one request for 2025", async () => {
    await v.sel("ups-m-sched-year", "2025");
    const opts = v.mount.querySelector("#ups-m-sched-weeks").querySelectorAll("option").map((o) => o.getAttribute("value"));
    assert.deepStrictEqual(opts, ["all", "playoffs", "custom"]);
    assert.strictEqual(v.mount.querySelector("#ups-m-sched-weeks").value, "all");
    assert.strictEqual(v.heads().length, 17);
    assert.strictEqual(v.mount.querySelectorAll(".c.off").length, 0);
    assert.strictEqual(v.sosGets().filter((r) => /season=2025&v=2$/.test(r.url)).length, 1);
    assert.ok(/^Wks 1–17 · points opponents have allowed to QBs so far \(Wks 1–17\)/.test(v.mount.querySelector("#ups-m-sched-window").textContent));
  });
  await check("2025 RB, the full season: color only where the shrunk gap is 8%+ (k = 30 games)", async () => {
    v.mount.querySelector('[data-schedpos="RB"]').click(); await settle();
    const want = expectRows(D25, "RB", range(1, 17), "pts");
    let got = 0, exp = 0;
    for (const r of v.rows()) {
      const w = want.find((x) => x.tm === r.getAttribute("data-schedteam"));
      r.querySelectorAll(".c").forEach((c, i) => {
        const on = !!c.querySelector(".ups-m-tr.up, .ups-m-tr.dn");
        assert.strictEqual(on, w.cells[i].color, w.tm + " wk " + (i + 1));
        got += on ? 1 : 0; exp += w.cells[i].color ? 1 : 0;
      });
    }
    assert.ok(exp > 0 && exp < 32 * 16, "some but not all cells colored (" + exp + ")");
  });
  await check("a 16-week league (2017–2020 style): weeks 1–16 only, playoffs 14–16 from the answer", async () => {
    const old = clone(D25); old.year = "2019"; old.season.endWeek = 16; old.playoffWeeks = [14, 15, 16];
    Object.keys(old.schedule).forEach((t) => { old.schedule[t] = old.schedule[t].filter((g) => g.wk <= 16); });
    const w = boot({ answer: (u) => (u.pathname === "/api/fantasy-sos" ? old : null) }); await w.open();
    assert.deepStrictEqual(w.heads().map((h) => h.replace(/now|playoff/, "")), range(1, 16).map((x) => "Wk " + x));
    await w.sel("ups-m-sched-weeks", "playoffs");
    assert.deepStrictEqual(w.heads().map((h) => h.replace(/playoff/, "")), ["Wk 14", "Wk 15", "Wk 16"]);
  });
}

console.log("4. drill: a team's schedule, then an opponent's Pts Agst breakdown, and Back");
{
  const v = boot(); await v.open();
  v.rows().find((r) => r.getAttribute("data-schedteam") === "BUF").click(); await settle();
  await check("tap BUF: 'BUF schedule · QBs', all 17 league weeks (bye labeled, played dimmed), in history", () => {
    assert.strictEqual(v.mount.querySelector(".ups-m-fpa-title").textContent, "BUF schedule · QBs");
    const rows = v.mount.querySelectorAll(".ups-m-fpa-wklist .ups-m-fpa-wk2");
    assert.strictEqual(rows.length, 17);
    assert.strictEqual(rows[6].textContent.replace(/\s+/g, ""), "Wk7Bye");
    assert.deepStrictEqual(rows.map((r, i) => r.classList.contains("off") ? i + 1 : 0).filter(Boolean), [1, 2, 3, 4, 5, 7]);
    assert.deepStrictEqual(v.stack[v.stack.length - 1].state, { upsSched: { team: "BUF" } });
    assert.strictEqual(v.doc.activeElement && v.doc.activeElement.getAttribute("class"), "ups-m-fpa-title");
  });
  await check("each opponent row: Allowed = its QB points per game, vs usual = its signed %; Wk 15–17 say Playoffs", () => {
    const rows = v.mount.querySelectorAll(".ups-m-fpa-wklist .ups-m-fpa-wk2[data-schedopp]");
    for (const r of rows) {
      const opp = r.getAttribute("data-schedopp"), c = D26.teams[opp].QB, vs = r.querySelectorAll(".v");
      assert.strictEqual(vs[0].textContent, c.raw.perGame.toFixed(1)); assert.strictEqual(vs[1].textContent, signedPct(c.adj.ratio));
      const wk = Number(r.getAttribute("data-schedwk"));
      assert.strictEqual(/Playoffs/.test(r.querySelector("small") ? r.querySelector("small").textContent : ""), wk >= 15, "wk " + wk);
    }
  });
  const lvr = v.mount.querySelector('[data-schedopp="LVR"][data-schedwk="6"]');
  lvr.click(); await settle();
  await check("tap Wk 6 @LVR: Pts Agst opens on LVR's QB breakdown (full season), back button reads '‹ BUF schedule'", () => {
    assert.ok(v.mount.querySelector('.ups-m-stseg.on[data-inner="fpa"]'));
    assert.ok(v.requests.some((r) => /\/api\/fpa-detail\?team=LVR&pos=QB&week_min=1$/.test(r.url)), v.requests.map((r) => r.url).join("\n"));
    assert.strictEqual(v.mount.querySelector(".ups-m-fpa-backbtn").textContent.replace(/\s+/g, " ").trim(), "‹ BUF schedule");
  });
  await check("Back (gesture): BUF's schedule again, focus on its title; Pts Agst forgets the LVR drill", async () => {
    v.ctx.history.back(); await settle();
    assert.ok(v.mount.querySelector('.ups-m-stseg.on[data-inner="sched"]'));
    assert.strictEqual(v.mount.querySelector(".ups-m-fpa-title").textContent, "BUF schedule · QBs");
    await v.board("fpa");
    assert.ok(v.mount.querySelector(".ups-m-fpa-r"), "Pts Agst shows its list, not the LVR drill");
    await v.board("sched");
  });
  await check("the on-screen '‹ BUF schedule' does the same as the gesture", async () => {
    v.mount.querySelector('[data-schedopp="LVR"][data-schedwk="6"]').click(); await settle();
    v.mount.querySelector(".ups-m-fpa-backbtn").click(); await settle();
    assert.strictEqual(v.mount.querySelector(".ups-m-fpa-title").textContent, "BUF schedule · QBs");
  });
  await check("'‹ All teams' returns to the list with focus on the BUF row", async () => {
    v.mount.querySelector("[data-schedback]").click(); await settle();
    assert.ok(v.rows().length === 32);
    assert.strictEqual(v.doc.activeElement && v.doc.activeElement.getAttribute("data-schedteam"), "BUF");
  });
  await check("Enter on a focused row opens it (keyboard / switch control)", async () => {
    v.rows().find((r) => r.getAttribute("data-schedteam") === "DET").dispatch("keydown", { key: "Enter" }); await settle();
    assert.strictEqual(v.mount.querySelector(".ups-m-fpa-title").textContent, "DET schedule · QBs");
  });
}

console.log("5. failures and late answers (the review's bugs)");
{
  let down = true;
  const v = boot({ fail: (u) => down && u.pathname === "/api/fantasy-sos" }); await v.open();
  await check("a failed read says so with Retry (never 'No schedule data.'), and isn't stored", () => {
    assert.ok(/Couldn’t load the schedule \(MFL didn’t answer\)\./.test(v.text()), v.text());
    assert.ok(v.mount.querySelector('[data-sched="retry"]'));
    assert.ok(!/No schedule data/.test(v.text()));
  });
  await check("Retry reads again and shows the board", async () => {
    down = false;
    v.mount.querySelector('[data-sched="retry"]').click(); await settle();
    assert.strictEqual(v.sosGets().length, 2);
    assert.strictEqual(v.rows().length, 32);
  });
}
{
  const v = boot({ hold: (u) => u.pathname === "/api/fantasy-sos" }); await v.open();
  v.setRoute("league/standings"); v.mount.innerHTML = '<div id="standings">Standings</div>';
  v.gates.forEach((g) => g()); await settle();
  await check("a slow answer arriving after the owner left for Standings never paints over it", () => {
    assert.strictEqual(v.mount.textContent, "Standings");
  });
}
{
  const v = boot({ hold: (u) => u.pathname === "/api/fantasy-sos" }); await v.open();
  await v.board("adp");
  const before = v.mount.querySelector('.ups-m-stseg.on').getAttribute("data-inner");
  v.gates.forEach((g) => g()); await settle();
  await check("…or over another Stats board", () => {
    assert.strictEqual(before, "adp");
    assert.ok(v.mount.querySelector('.ups-m-stseg.on[data-inner="adp"]') && !v.mount.querySelector("#ups-m-sched-root"));
  });
}
{
  const v = boot({ hold: (u) => u.pathname === "/api/fantasy-sos" && !u.searchParams.get("season") }); await v.open();
  v.gates.forEach((g) => g()); v.gates.length = 0; await settle();
  const late = boot({ hold: (u) => u.pathname === "/api/fantasy-sos" && u.searchParams.get("season") !== "2025" });
  await late.open();
  await late.sel("ups-m-sched-year", "2025");
  late.gates.forEach((g) => g()); await settle();
  await check("a late answer for the season the owner just left never replaces the one picked (2025 stays)", () => {
    assert.strictEqual(late.mount.querySelector("#ups-m-sched-year").value, "2025");
    assert.strictEqual(late.heads().length, 17);
    assert.strictEqual(late.mount.querySelector("#ups-m-sched-weeks").value, "all");
  });
}
{
  const ns = { ok: true, engine: D26.engine, year: "2027", season: { state: "not_started" }, teams: {}, weeksUsed: [], groups: D26.groups, view: "schedule", schedule: {}, playoffWeeks: [], league: {} };
  const v = boot({ answer: (u) => (u.pathname === "/api/fantasy-sos" && !u.searchParams.get("season") ? ns : null) });
  await v.open();
  await check("a season not started yet (offseason): shows last season, labeled — never a blank board", () => {
    assert.ok(v.sosGets().some((r) => /season=2026&v=2$/.test(r.url)), v.sosGets().map((r) => r.url).join());
    assert.ok(/^No 2027 games yet, so this is 2026\./.test(v.mount.querySelector("#ups-m-sched-window").textContent));
    assert.strictEqual(v.rows().length, 32);
  });
}

console.log("6. markup: accessible controls, readable sizes, nothing old left");
{
  const v = boot(); await v.open();
  await check("rows are buttons with a spoken summary; chips and the Show toggle carry aria-pressed", () => {
    const r = v.rows()[0];
    assert.strictEqual(r.getAttribute("role"), "button"); assert.strictEqual(r.getAttribute("tabindex"), "0");
    assert.ok(/^[A-Z]{2,3}(, bye week \d+)?\. Opponents average \d+\.\d points allowed per game in weeks 6 to 17\. Opens [A-Z]{2,3}’s schedule\.$/.test(r.getAttribute("aria-label")), r.getAttribute("aria-label"));
    assert.strictEqual(v.mount.querySelectorAll("[data-schedpos][aria-pressed]").length, 9);
    assert.strictEqual(v.mount.querySelectorAll("[data-schedshow][aria-pressed]").length, 2);
  });
  await check("labeled Season / Weeks pickers (no bare selects)", () => {
    for (const id of ["ups-m-sched-year", "ups-m-sched-weeks"]) assert.ok(v.mount.querySelector("#" + id).closest("label.ups-m-st-sel"), id);
  });
  await check("no request ever sends a write or the old per-position query", () => {
    assert.ok(v.requests.every((r) => r.method === "GET"));
    assert.ok(!v.sosGets().some((r) => /pos=/.test(r.url)));
  });
  const css = read("site/m/app.css");
  const block = css.slice(css.indexOf("/* Stats → Sched (#1270)"), css.indexOf(".ups-m-fpa-table {"));
  await check("Sched CSS: no text under 11px (the old grid used 9–10px), no old heatmap rules", () => {
    const sizes = [...block.matchAll(/font-size:\s*(\d+)px/g)].map((m) => Number(m[1]));
    assert.ok(sizes.length > 5 && sizes.every((s) => s >= 11), sizes.join());
    assert.ok(!/ups-m-sched-wrap|ups-m-sched-note|\.cell\b/.test(css));
  });
  await check("stats.js: the old heatmap, its hsl ramp and the easy/tough legend are gone", () => {
    const js = read("site/m/views/stats.js");
    assert.ok(!/schedColor|green = easy|sorted easiest-first|Strength of Schedule/.test(js));
  });
}

console.log(fails ? `\nmobile_sched: ${fails} FAILED` : "\nmobile_sched: all passed");
process.exit(fails ? 1 : 0);
