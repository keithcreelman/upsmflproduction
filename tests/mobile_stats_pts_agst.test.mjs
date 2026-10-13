// Stats → Pts Agst on mobile (site/m/views/stats.js), run for real in node:vm on a tree
// DOM, fed the draft engine's own responses for the 2026-10-12 23:12 UTC pull (Wk 5 in
// progress: Monday night BUF @ LAR not yet played). Review 2026-10-12: no silent switch
// to last season, failures never cached, paints only while the owner is on the board,
// drill levels in history, sortable headings, accessible rows, Allowed / Usual / vs usual.
//   node tests/mobile_stats_pts_agst.test.mjs
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert";
import { makeDocument, settle } from "./fixtures/tree_dom.mjs";

const read = (p) => fs.readFileSync(new URL("../" + p, import.meta.url), "utf8");
const FX = JSON.parse(read("tests/fixtures/mobile_pts_agst_2026_10_12.json"));
const APP = read("site/m/app.js");
function sliceFn(src, sig) { const at = src.indexOf(sig); let i = src.indexOf("{", at), d = 0; for (; i < src.length; i++) { if (src[i] === "{") d++; else if (src[i] === "}" && --d === 0) return src.slice(at, i + 1); } }
const UTIL = ["function safeStr(", "function safeInt(", "function pad4(", "function escapeHtml(", "function fmtUsd(", "function asArray("].map((s) => sliceFn(APP, s)).join("\n");

let fails = 0;
const check = async (n, fn) => { try { await fn(); console.log("  ok   " + n); } catch (e) { fails++; console.log("  FAIL " + n + "\n         " + (e && e.message)); } };

function boot(opt = {}) {
  const doc = makeDocument();
  const mount = doc.mount("ups-m-main");
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, Promise, URL, Date, Math, JSON, AbortController });
  ctx.window = ctx; ctx.document = doc;
  const winL = {};
  ctx.addEventListener = (t, fn) => (winL[t] = winL[t] || []).push(fn);
  ctx.scrollY = 0; ctx.scrollTo = (x, y) => { ctx.scrollY = y; };
  // history: drill levels push entries; back() pops one and fires popstate like a browser.
  const stack = [{ state: null }];
  ctx.history = {
    get state() { return stack[stack.length - 1].state; },
    pushState(s) { stack.push({ state: JSON.parse(JSON.stringify(s)) }); },
    replaceState(s) { stack[stack.length - 1] = { state: s }; },
    back() { if (stack.length > 1) stack.pop(); setTimeout(() => (winL.popstate || []).forEach((fn) => fn({ state: ctx.history.state })), 0); },
  };
  vm.runInContext(UTIL + "\nthis.__util = { safeStr, safeInt, pad4, escapeHtml, fmtUsd, asArray };", ctx);
  const requests = [], sheetOpened = [];
  let route = "league/stats";
  const views = {};
  const state = { ctx: { year: "2026", leagueId: "74598" }, players: { players: { player: [] } }, viewerFranchiseId: "0008", loadingPromise: {} };
  ctx.UPS_MOBILE = {
    util: ctx.__util, state,
    api: { workerUrl: (p) => "https://w.test" + p },
    data: { getAdvancedStatsLatestYear: () => 2026, playerById: () => null, getSeasonScoring: () => null, ownerOfPid: () => ({}), rosterOwnership: () => ({}) },
    route: { registerView: (n, fn) => (views[n] = fn), renderRoute: () => views.stats(mount), currentRoute: () => route, navigate() {} },
    sheet: { open: (pid) => sheetOpened.push(pid) },
    ui: { showToast() {} },
  };
  const gates = [];
  ctx.fetch = (url, o) => {
    const method = (o && o.method) || "GET";
    requests.push({ url: String(url), method });
    const u = new URL(url), q = u.searchParams;
    const answer = (status, body) => ({ ok: status === 200, status, json: async () => body });
    const respond = () => {
      if (u.pathname === "/api/league-years") return answer(200, { years: [{ season: 2026 }, { season: 2025 }] });
      if (opt.fail && opt.fail(u)) return answer(500, { ok: false, error: "boom" });
      if (opt.answer) { const a = opt.answer(u); if (a) return answer(200, a); }
      if (u.pathname === "/api/fantasy-points-against") return answer(200, q.get("week_max") === "5" ? FX.list_w5 : FX.list_auto);
      if (u.pathname === "/api/fpa-detail") {
        const key = "detail_" + q.get("team") + "_" + q.get("pos") + (q.get("week_max") === "5" ? "_w5" : "");
        return FX[key] ? answer(200, FX[key]) : answer(500, { ok: false });
      }
      return null;
    };
    const r = respond();
    if (r == null) return new Promise(() => {});          // the Players board's own loaders: never answer
    if (opt.hold && opt.hold(u)) return new Promise((res) => gates.push(() => res(r)));
    return Promise.resolve(r);
  };
  vm.runInContext(read("site/m/views/stats.js"), ctx);
  const render = () => views.stats(mount);
  return {
    ctx, doc, mount, requests, sheetOpened, gates, state,
    setRoute: (r) => { route = r; },
    render,
    async openBoard() { render(); await settle(); mount.querySelector('.ups-m-stseg[data-inner="fpa"]').click(); await settle(); },
    rows: () => mount.querySelectorAll(".ups-m-fpa-r").map((r) => ({ tm: r.getAttribute("data-fpateam"), cells: r.children.map((c) => c.textContent.trim()), el: r })),
    text: () => mount.textContent.replace(/\s+/g, " "),
    fpaGets: () => requests.filter((r) => /fantasy-points-against|fpa-detail/.test(r.url)),
  };
}
const byRank = (pos, d) => Object.keys(d.teams).filter((t) => d.teams[t][pos]).sort((a, b) => (d.teams[a][pos].adj ? d.teams[a][pos].adj.rank : 999) - (d.teams[b][pos].adj ? d.teams[b][pos].adj.rank : 999) || (a < b ? -1 : 1));

console.log("1. the list (RB default, Wks 1–4 = through the latest complete week)");
{
  const v = boot();
  await v.openBoard();
  await check("one list request: this season, no week_max (the worker picks the latest complete week)", () => {
    const g = v.fpaGets(); assert.strictEqual(g.length, 1, g.map((r) => r.url).join());
    assert.ok(!/YEAR=/.test(g[0].url) && !/week_max/.test(g[0].url), g[0].url);
  });
  await check("32 rows in the API's rank order, numbers to one decimal, vs usual signed with a real minus", () => {
    const rows = v.rows();
    assert.deepStrictEqual(rows.map((r) => r.tm), byRank("RB", FX.list_auto));
    for (const r of rows) {
      const c = FX.list_auto.teams[r.tm].RB;
      assert.strictEqual(r.cells[2], c.raw.perGame.toFixed(1)); assert.strictEqual(r.cells[3], c.raw.oppNorm.toFixed(1));
      const pct = Math.round((c.adj.ratio - 1) * 100);
      assert.strictEqual(r.cells[4], pct === 0 ? "0%" : (pct > 0 ? "+" : "−") + Math.abs(pct) + "%");
    }
  });
  await check("each row says its games and next game (BUF: 4 games · Wk 5 @LAR)", () => {
    const buf = v.rows().find((r) => r.tm === "BUF");
    assert.strictEqual(buf.cells[1].replace(/\s+/g, " "), "BUF4 games · Wk 5 @LAR");
  });
  await check("no colour on RB (no gap survives shrinking toward average)", () => {
    assert.strictEqual(v.mount.querySelectorAll(".ups-m-fpa-list .ups-m-tr.up").length + v.mount.querySelectorAll(".ups-m-fpa-list .ups-m-tr.dn").length, 0);
  });
  await check("one plain basis line + the RB caveat + About (≤3 sentences); no Alw/Norm/Δ%", () => {
    const t = v.mount.querySelector("#ups-m-fpa-notes").textContent.replace(/\s+/g, " ");
    assert.ok(/^Points RBs scored vs each defense, per game\. Top = easiest matchup\. Wks 1–4, final\. Wk 5 is in progress: choose To: Wk 5 to add it\./.test(t), t);
    assert.ok(/Mostly noise: a back’s workload/.test(t), t);
    const about = v.mount.querySelector(".ups-m-st-more div").textContent;
    assert.ok(about.split(/(?<=\.)\s/).length <= 3, about);
    assert.ok(!/\bAlw\b|\bNorm\b|Δ%/.test(v.text()));
  });
  await check("controls are labelled: Season / From / To; unplayed weeks are disabled", () => {
    const labels = v.mount.querySelectorAll(".ups-m-fpa-tools label span").map((s) => s.textContent);
    assert.deepStrictEqual(labels, ["Season", "From", "To"]);
    const wk6 = v.mount.querySelector('#ups-m-fpa-wmin option[value="6"]');
    assert.ok(wk6.disabled && /not played/.test(wk6.textContent));
  });
  await check("chips: a group with aria-pressed; switching all nine sends no request", async () => {
    assert.strictEqual(v.mount.querySelector(".ups-m-fpa-chips").getAttribute("role"), "group");
    const before = v.requests.length;
    for (const p of ["QB", "WR", "TE", "DL", "LB", "DB", "PK", "PN", "RB"]) { v.mount.querySelector(`[data-fpapos="${p}"]`).click(); await settle(); }
    assert.strictEqual(v.requests.length, before);
    assert.strictEqual(v.mount.querySelector('[data-fpapos="RB"]').getAttribute("aria-pressed"), "true");
  });
  await check("QB: colour only where the gap is still 8%+ after shrinking (k = 20 games)", async () => {
    v.mount.querySelector('[data-fpapos="QB"]').click(); await settle();
    const want = byRank("QB", FX.list_auto).filter((t) => { const c = FX.list_auto.teams[t].QB, g = FX.list_auto.teamGames[t].games; return Math.abs((g * c.adj.ratio + 20) / (g + 20) - 1) >= 0.08; });
    const got = v.rows().filter((r) => r.el.querySelector(".ups-m-tr.up, .ups-m-tr.dn")).map((r) => r.tm);
    assert.deepStrictEqual(got.sort(), want.sort());
  });
  await check("DL is the OFFENSE the linemen faced: heading 'Offense', no defense wording", async () => {
    v.mount.querySelector('[data-fpapos="DL"]').click(); await settle();
    assert.strictEqual(v.mount.querySelector(".ups-m-fpa-head .nm").textContent, "Offense");
    assert.ok(/Points DL scored vs each offense/.test(v.mount.querySelector("#ups-m-fpa-notes").textContent));
  });
}

console.log("\n2. sorting sweep: every position × column × direction");
{
  const v = boot();
  await v.openBoard();
  let n = 0;
  await check("54 orders correct, nulls last, ties keep rank order, aria-sort follows, # resets", async () => {
    for (const pos of ["QB", "RB", "WR", "TE", "DL", "LB", "DB", "PK", "PN"]) {
      v.mount.querySelector(`[data-fpapos="${pos}"]`).click(); await settle();
      for (const [k, col] of [["alw", 2], ["usual", 3], ["vs", 4]]) for (const dir of ["desc", "asc"]) {
        v.mount.querySelector(`[data-fpasort="${k}"]`).click(); await settle();
        const vals = v.rows().map((r) => { const t = r.cells[col].replace("−", "-").replace("%", ""); return t === "—" ? null : parseFloat(t); });
        let seenNull = false;
        vals.forEach((x, i) => {
          if (x == null) { seenNull = true; return; }
          assert.ok(!seenNull, pos + " " + k + " null before value");
          if (i && vals[i - 1] != null) assert.ok(dir === "desc" ? x <= vals[i - 1] + 1e-9 : x >= vals[i - 1] - 1e-9, `${pos} ${k} ${dir} @${i}`);
        });
        const h = v.mount.querySelector(`[data-fpasort="${k}"]`).closest("[role=columnheader]").getAttribute("aria-sort");
        assert.strictEqual(h, dir === "desc" ? "descending" : "ascending", `${pos} ${k} ${dir} aria-sort`);
        n++;
      }
      v.mount.querySelector('[data-fpasort=""]').click(); await settle();
      assert.deepStrictEqual(v.rows().map((r) => r.tm), byRank(pos, FX.list_auto), pos + " default order");
    }
    assert.strictEqual(n, 54);
  });
}

console.log("\n3. the drill: team → weeks → players, in history, focus follows");
{
  const v = boot();
  await v.openBoard();
  v.mount.querySelector('[data-fpapos="QB"]').click(); await settle();
  const buf = v.mount.querySelector('[data-fpateam="BUF"]');
  await check("rows are buttons a keyboard can reach and Enter opens", () => {
    assert.strictEqual(buf.getAttribute("role"), "button"); assert.strictEqual(buf.getAttribute("tabindex"), "0");
    assert.ok(/^BUF, rank \d+ of 32\. Allowed 27\.9 per game/.test(buf.getAttribute("aria-label")), buf.getAttribute("aria-label"));
  });
  buf.dispatch("keydown", { key: "Enter" }); await settle();
  await check("one fpa-detail GET; title, summary; focus moves to the title; a history entry", () => {
    assert.strictEqual(v.fpaGets().filter((r) => /fpa-detail/.test(r.url)).length, 1);
    assert.strictEqual(v.mount.querySelector(".ups-m-fpa-title").textContent, "BUF defense vs QBs");
    assert.ok(/^4 games · 27\.9 per game · usual /.test(v.mount.querySelector(".ups-m-fpa-sum").textContent));
    assert.strictEqual(v.doc.activeElement, v.mount.querySelector(".ups-m-fpa-title"));
    assert.deepStrictEqual(v.ctx.history.state, { upsFpa: { team: "BUF", week: null, pos: "QB" } });
  });
  await check("week rows Wk 1–4, each with the one QB's name; Allowed totals = the API", () => {
    const wk = v.mount.querySelectorAll(".ups-m-fpa-wk2[data-fpawk]");
    assert.deepStrictEqual(wk.map((w) => w.getAttribute("data-fpawk")), ["1", "2", "3", "4"]);
    assert.ok(/Jared Goff/.test(wk[1].textContent));
    assert.deepStrictEqual(wk.map((w) => w.querySelector(".v").textContent), FX.detail_BUF_QB.weeks.map((w) => w.total.toFixed(1)));
  });
  v.mount.querySelector('[data-fpawk="2"]').click(); await settle();
  await check("level 2: the player row opens his card", () => {
    const p = v.mount.querySelector("[data-fpapid]");
    assert.ok(/Jared Goff/.test(p.textContent) && /snaps \(usual \d+\)/.test(p.textContent), p.textContent);
    p.click(); assert.deepStrictEqual(v.sheetOpened, ["12611"]);
  });
  v.mount.querySelector('[data-fpaback="weeks"]').click(); await settle();
  await check("the on-screen back = Back: up one level, focus on the week row it came from", () => {
    assert.ok(v.mount.querySelector('[data-fpawk="2"]'));
    assert.strictEqual(v.doc.activeElement && v.doc.activeElement.getAttribute("data-fpawk"), "2");
  });
  v.ctx.history.back(); await settle();
  await check("Back again: the list, focus on BUF", () => {
    assert.strictEqual(v.rows().length, 32);
    assert.strictEqual(v.doc.activeElement && v.doc.activeElement.getAttribute("data-fpateam"), "BUF");
  });
  await check("re-opening BUF is served from memory (no new request)", async () => {
    const n = v.fpaGets().length;
    v.mount.querySelector('[data-fpateam="BUF"]').click(); await settle();
    assert.strictEqual(v.fpaGets().length, n);
  });
}

console.log("\n4. byes, unplayed games, IDP snaps");
{
  const v = boot();
  await v.openBoard();
  v.mount.querySelector("#ups-m-fpa-wmax").value = "5"; v.mount.querySelector("#ups-m-fpa-wmax").dispatch("change"); await settle();
  v.mount.querySelector('[data-fpapos="TE"]').click(); await settle();
  v.mount.querySelector('[data-fpateam="KCC"]').click(); await settle();
  await check("KCC Wk 5 is a 'Bye' row that can't be tapped", () => {
    const rows = v.mount.querySelectorAll(".ups-m-fpa-wk2.off");
    assert.ok(rows.some((r) => /Wk 5\s*Bye/.test(r.textContent)), rows.map((r) => r.textContent).join("|"));
    assert.strictEqual(v.mount.querySelector('[data-fpawk="5"]'), null);
  });
  const w = boot();
  await w.openBoard();
  w.mount.querySelector('[data-fpapos="DL"]').click(); await settle();
  w.mount.querySelector('[data-fpateam="DAL"]').click(); await settle();
  w.mount.querySelector('[data-fpawk="1"]').click(); await settle();
  await check("DL drill: 'DAL offense vs DL', defensive snaps, never '0snp'", () => {
    assert.strictEqual(w.mount.querySelector(".ups-m-fpa-title").textContent, "Wk 1 · DAL offense vs DL");
    assert.ok(/def snaps \(usual \d+\)/.test(w.text()) && !/0snp/.test(w.text()));
  });
}

console.log("\n5. failures, freshness, route guard");
{
  let down = true;
  const v = boot({ fail: (u) => down && u.pathname === "/api/fantasy-points-against" });
  await v.openBoard();
  await check("a failed list says so with Retry, and never asks for another season", () => {
    assert.ok(/Couldn’t load points against/.test(v.text()) && v.mount.querySelector('[data-fpa="retry"]'));
    assert.ok(v.fpaGets().every((r) => !/YEAR=/.test(r.url)), v.fpaGets().map((r) => r.url).join());
  });
  await check("the failure isn't kept: Retry asks once more and shows the board", async () => {
    down = false; const n = v.fpaGets().length;
    v.mount.querySelector('[data-fpa="retry"]').click(); await settle();
    assert.strictEqual(v.fpaGets().length, n + 1); assert.strictEqual(v.rows().length, 32);
  });
  const d = boot({ fail: (u) => u.pathname === "/api/fpa-detail" });
  await d.openBoard();
  d.mount.querySelector('[data-fpateam="ATL"]').click(); await settle();
  await check("a failed breakdown says so with Retry (never 'No games in range')", () => {
    assert.ok(/Couldn’t load ATL’s breakdown/.test(d.text()) && !/No games/.test(d.text()));
  });
  const s = boot({ hold: (u) => u.pathname === "/api/fantasy-points-against" });
  s.render(); await settle(); s.mount.querySelector('.ups-m-stseg[data-inner="fpa"]').click(); await settle();
  s.setRoute("home"); s.mount.innerHTML = "<div id=home>HOME</div>";
  s.gates.forEach((g) => g()); await settle();
  await check("a slow answer that lands after the owner left paints nothing over Home", () => {
    assert.strictEqual(s.mount.textContent, "HOME");
  });
  const r = boot();
  await r.openBoard();
  await check("pull-to-refresh (a new app load) reads Pts Agst again", async () => {
    const n = r.fpaGets().length;
    r.state.loadingPromise = {}; r.render(); await settle();
    assert.strictEqual(r.fpaGets().length, n + 1);
  });
  const pre = boot({ answer: (u) => (u.pathname === "/api/fantasy-points-against" && !u.searchParams.get("YEAR")) ? { ok: true, year: "2027", season: { state: "not_started" }, teams: {}, weeksUsed: [] } : null });
  await pre.openBoard();
  await check("first open before a season starts: last season, LABELLED, never silently", () => {
    assert.ok(pre.fpaGets().some((x) => /YEAR=2026/.test(x.url)), pre.fpaGets().map((x) => x.url).join());
    assert.ok(/No 2027 games yet, so this is 2026\./.test(pre.mount.querySelector("#ups-m-fpa-notes").textContent));
  });
  const un = boot({ answer: (u) => u.pathname === "/api/fantasy-points-against" ? Object.assign({}, FX.list_auto, { weeksUsed: [], teams: {}, season: Object.assign({}, FX.list_auto.season, { state: "in_season" }) }) : null });
  await un.openBoard();
  await check("weeks not played yet: says so, offers the latest weeks, stays on this season", () => {
    assert.ok(/haven’t been played yet\. The latest final week is Wk 4\./.test(un.text()), un.text().slice(0, 300));
    assert.ok(un.mount.querySelector('[data-fpa="latest"]'));
    assert.ok(un.fpaGets().every((x) => !/YEAR=/.test(x.url)));
  });
}

console.log("\n6. viewing never writes");
{
  const v = boot();
  await v.openBoard();
  for (const p of ["QB", "DL"]) { v.mount.querySelector(`[data-fpapos="${p}"]`).click(); await settle(); }
  v.mount.querySelector('[data-fpateam="DAL"]').click(); await settle();
  v.mount.querySelector('[data-fpawk="1"]').click(); await settle();
  await check("every request is a GET, and Pts Agst only reads its two routes + the season list", () => {
    assert.ok(v.requests.every((r) => r.method === "GET"));
    const mine = v.requests.filter((r) => /fpa|fantasy-points|league-years/.test(r.url)).map((r) => new URL(r.url).pathname);
    assert.ok(mine.every((p) => ["/api/fantasy-points-against", "/api/fpa-detail", "/api/league-years"].includes(p)), mine.join());
  });
}

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
