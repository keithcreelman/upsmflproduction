// Desktop Stats workbench → Schedule (#1270): the same rules as mobile Sched. One /api/fantasy-sos?v=2
// read per season; opens on QB (Pts Agst's position, shared); Weeks = Rest of season / All weeks /
// Playoffs / Custom (league weeks, never 18); Points allowed vs "vs usual"; Avg per team, sortable,
// most allowed first; restrained text color, never a fill; no easy/tough wording; Retry on failure;
// the offseason (from Jan 1) shows last season, labeled, instead of a blank page; the word
// "Position" is no longer a <label> around the chips (clicking it pressed QB). The real page code
// runs in node:vm on a tree DOM with fetch answered from the 2026-10-13 fixture.
//   node tests/desktop_sched.test.mjs
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert";
import { makeDocument, settle } from "./fixtures/tree_dom.mjs";

const HTML = fs.readFileSync(new URL("../site/stats_workbench/stats_workbench.html", import.meta.url), "utf8");
const FX = JSON.parse(fs.readFileSync(new URL("./fixtures/sched_v2_2026_10_13.json", import.meta.url), "utf8"));
const D26 = FX.v2_2026, D25 = FX.v2_2025;
const a0 = HTML.indexOf("    function esc(s){", HTML.indexOf("Fantasy Points Against (Stats sub-tab)"));
const a1 = HTML.indexOf("    function notifyResize(){", a0);
const b0 = HTML.indexOf("    // ---- Schedule (Stats → Schedule, #1270) ----");
const b1 = HTML.indexOf("    var sections = {", b0);
assert.ok(a0 > 0 && a1 > a0 && b0 > a1 && b1 > b0, "the desktop Pts Agst and Schedule blocks must be found");
const CODE = HTML.slice(a0, a1) + "\n" + HTML.slice(b0, b1);

let fails = 0;
const check = async (n, fn) => { try { await fn(); console.log("  ok   " + n); } catch (e) { fails++; console.log("  FAIL " + n + "\n         " + (e && e.message)); } };
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

function boot(opt = {}) {
  const doc = makeDocument();
  const host = doc.mount("asw-view-fpa");
  const sec = doc.mount("asw-view-schedule");
  const requests = [], gates = [];
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, Promise, URL, Math, JSON, String, parseInt, Date, Number, Object });
  ctx.document = doc; ctx.window = ctx;
  ctx.fetch = (url, o) => {
    requests.push({ url: String(url), method: (o && o.method) || "GET" });
    const u = new URL(url), q = u.searchParams;
    const ans = (status, b) => ({ ok: status === 200, status, json: async () => b });
    let r = null;
    if (u.pathname === "/api/league-years") r = ans(200, { years: [{ season: 2026 }, { season: 2025 }] });
    else if (u.pathname === "/api/fantasy-sos") {
      if (opt.fail && opt.fail(u)) r = ans(502, { ok: false, error: "mfl_unavailable" });
      else if (opt.answer && opt.answer(u)) r = ans(200, opt.answer(u));
      else r = ans(200, q.get("season") === "2025" ? D25 : D26);
    }
    if (!r) return new Promise(() => {});
    if (opt.hold && opt.hold(u)) return new Promise((res) => gates.push(() => res(r)));
    return Promise.resolve(r);
  };
  vm.runInContext(
    "var host = document.getElementById('asw-view-fpa'); var THIS_YEAR = 2026; var API_BASE = 'https://w.test';" +
    "function notifyResize(){}\n" + CODE + "\nthis.__t = { fpa: fpa, sched: sched, schedRenderShell: schedRenderShell, schedLoad: schedLoad, schedPaint: schedPaint };", ctx);
  const T = ctx.__t;
  const v = {
    sec, requests, T, gates,
    async open() { T.schedRenderShell(); T.schedLoad(); await settle(); await settle(); },
    rows: () => sec.querySelectorAll("tbody tr"),
    team: (r) => r.querySelector("th.team").childNodes[0].textContent,
    heads: () => sec.querySelectorAll("thead th.wk").map((h) => h.textContent),
    sos: () => requests.filter((r) => /fantasy-sos/.test(r.url)),
    async sel(cls, val) { const s = sec.querySelector(cls); s.value = String(val); s.dispatch("change"); await settle(); },
    pressed: (attr) => sec.querySelectorAll("[" + attr + "]").filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.getAttribute(attr)),
    basis: () => (sec.querySelector("#sched-basis") || {}).textContent || "",
  };
  return v;
}
const avgOf = (d, pos, tm, weeks, show) => {
  let s = 0, n = 0;
  for (const w of weeks) { const g = d.schedule[tm].find((x) => x.wk === w); if (!g || g.bye) continue; const c = d.teams[g.opp] && d.teams[g.opp][pos]; if (!c) continue; s += show === "vs" ? c.adj.ratio : c.raw.perGame; n++; }
  return n ? s / n : null;
};
const order = (d, pos, weeks, show) => Object.keys(d.schedule).sort((a, b) => (avgOf(d, pos, b, weeks, show) - avgOf(d, pos, a, weeks, show)) || (a < b ? -1 : 1));

console.log("desktop Schedule");
{
  const v = boot(); await v.open();
  await check("one read: /api/fantasy-sos?v=2 (no season: the worker picks the current one; no pos)", () => {
    assert.deepStrictEqual(v.sos().map((r) => r.url), ["https://w.test/api/fantasy-sos?v=2"]);
  });
  await check("opens on QB, Rest of season (Wk 6 now … Wk 17), Points allowed", () => {
    assert.deepStrictEqual(v.pressed("data-spos"), ["QB"]);
    assert.deepStrictEqual(v.pressed("data-sshow"), ["pts"]);
    assert.deepStrictEqual(v.heads(), range(6, 17).map((w) => "Wk " + w + (w === 6 ? "now" : (w >= 15 ? "playoff" : ""))));
  });
  await check("32 rows, Avg = opponents' QB points allowed per game over Wks 6–17, most allowed first", () => {
    assert.deepStrictEqual(v.rows().map(v.team), order(D26, "QB", range(6, 17), "pts"));
    for (const r of v.rows()) assert.strictEqual(r.querySelector("td.ag").textContent, avgOf(D26, "QB", v.team(r), range(6, 17), "pts").toFixed(1));
  });
  await check("cells read 'vs DET' / '@GB' + the number; BYE labeled; a tooltip names the games behind it; no fills", () => {
    const buf = v.rows().find((r) => v.team(r) === "BUF");
    const c = buf.querySelectorAll("td.sc");
    assert.strictEqual(c[0].querySelector("b").textContent, "@LVR"); assert.strictEqual(c[0].querySelector(".asw-trend").textContent, D26.teams.LVR.QB.raw.perGame.toFixed(1));
    assert.strictEqual(c[1].textContent, "BYE");
    assert.ok(/^Wk 6 @LVR · allowed \d+\.\d per game to QBs, [+−]\d+% vs usual · 5 games$/.test(c[0].getAttribute("title")), c[0].getAttribute("title"));
    assert.ok(!/style="[^"]*background/.test(v.sec.innerHTML), "no background fills");
  });
  await check("byes: BYE in the bye week and Avg over the opponents only (MIN: 11 of Wks 6–17)", () => {
    const min = v.rows().find((r) => v.team(r) === "MIN");
    assert.strictEqual(min.querySelectorAll("td.sc")[0].textContent, "BYE");
    const opps = D26.schedule.MIN.filter((g) => g.wk >= 6 && !g.bye).map((g) => D26.teams[g.opp].QB.raw.perGame);
    assert.strictEqual(opps.length, 11);
    assert.strictEqual(min.querySelector("td.ag").textContent, (opps.reduce((a, b) => a + b, 0) / 11).toFixed(1));
  });
  await check("descriptive wording; no easy/tough; masthead renamed 'Schedule'", () => {
    assert.ok(/^Wks 6–17 · points opponents have allowed to QBs so far \(Wks 1–5\), per game; league average \d+\.\d\. Default order: most allowed first\.$/.test(v.basis()), v.basis());
    assert.ok(/This describes what each opponent has allowed in games already played\. It isn’t a forecast of what a team will score; it doesn’t account for that team’s offense, injuries or future changes\. Color appears only when the difference remains large after adjusting for small sample sizes\./.test(v.sec.textContent));
    assert.ok(!/easy|tough|easiest|strength of schedule/i.test(v.sec.textContent));
    assert.ok(/"schedule":\s*\{ title:"Schedule", desc:"Who each NFL team plays, week by week, with what each opponent has allowed to the position so far\. It describes games already played; it is not a forecast of what a team will score\." \}/.test(HTML));
  });
  await check("vs usual: signed % cells and Avg, re-ordered, no new read", async () => {
    v.sec.querySelector('[data-sshow="vs"]').click(); await settle();
    assert.deepStrictEqual(v.rows().map(v.team), order(D26, "QB", range(6, 17), "vs"));
    const r0 = v.rows()[0], p = Math.round((avgOf(D26, "QB", v.team(r0), range(6, 17), "vs") - 1) * 100);
    assert.strictEqual(r0.querySelector("td.ag").textContent, p === 0 ? "0%" : (p > 0 ? "+" : "−") + Math.abs(p) + "%");
    assert.strictEqual(v.sos().length, 1);
    v.sec.querySelector('[data-sshow="pts"]').click(); await settle();
  });
  await check("Team sorts A→Z then Z→A; Avg back to most allowed first (aria-sort follows)", async () => {
    const az = Object.keys(D26.schedule).sort();
    v.sec.querySelector('[data-ssort="team"]').click(); await settle();
    assert.deepStrictEqual(v.rows().map(v.team), az);
    assert.strictEqual(v.sec.querySelector('[data-ssort="team"]').parentNode.getAttribute("aria-sort"), "ascending");
    v.sec.querySelector('[data-ssort="team"]').click(); await settle();
    assert.deepStrictEqual(v.rows().map(v.team), az.slice().reverse());
    v.sec.querySelector('[data-ssort="avg"]').click(); await settle();
    assert.deepStrictEqual(v.rows().map(v.team), order(D26, "QB", range(6, 17), "pts"));
    assert.strictEqual(v.sec.querySelector('[data-ssort="avg"]').parentNode.getAttribute("aria-sort"), "descending");
  });
  await check("Weeks: All = 1–17 (played weeks dimmed), Playoffs = 15–17, Custom 8–10; never Week 18; no new read", async () => {
    await v.sel(".sched-weeks", "all");
    assert.deepStrictEqual(v.heads().map((h) => h.replace(/now|playoff/, "")), range(1, 17).map((w) => "Wk " + w));
    const buf = v.rows().find((r) => v.team(r) === "BUF");
    assert.deepStrictEqual(buf.querySelectorAll("td.sc").map((c, i) => (c.classList.contains("off") ? i + 1 : 0)).filter(Boolean), [1, 2, 3, 4, 5]);
    await v.sel(".sched-weeks", "playoffs");
    assert.deepStrictEqual(v.heads().map((h) => h.replace(/playoff/, "")), ["Wk 15", "Wk 16", "Wk 17"]);
    await v.sel(".sched-weeks", "custom"); await v.sel(".sched-from", 8); await v.sel(".sched-to", 10);
    assert.deepStrictEqual(v.heads(), ["Wk 8", "Wk 9", "Wk 10"]);
    assert.strictEqual(v.sec.querySelector(".sched-to").querySelectorAll("option").length, 17);
    assert.strictEqual(v.sos().length, 1);
  });
  await check("a position picked here is Pts Agst's position (shared); its chips follow on the tab switch", async () => {
    v.sec.querySelector('[data-spos="RB"]').click(); await settle();
    assert.strictEqual(v.T.fpa.pos, "RB"); assert.deepStrictEqual(v.pressed("data-spos"), ["RB"]);
    assert.strictEqual(v.T.fpa._posFromSched, true);
    assert.ok(/fpa\._posFromSched\) \{ fpa\._posFromSched = false; host\.querySelectorAll\("\.fpa-pos button"\)/.test(HTML), "the tab switch re-syncs Pts Agst's chips");
  });
  await check("2025 (finished): no Rest of season, opens on All weeks, nothing dimmed, 'over the 2025 season'", async () => {
    await v.sel(".sched-year", "2025");
    assert.deepStrictEqual(v.sec.querySelector(".sched-weeks").querySelectorAll("option").map((o) => o.getAttribute("value")), ["all", "playoffs", "custom"]);
    assert.strictEqual(v.heads().length, 17); assert.strictEqual(v.sec.querySelectorAll("td.sc.off").length, 0);
    assert.ok(/^Wks 1–17 · points opponents allowed to RBs over the 2025 season, per game/.test(v.basis()), v.basis());
  });
}
{
  let down = true;
  const v = boot({ fail: () => down }); await v.open();
  await check("a failed read: 'Couldn’t load the schedule (MFL didn’t answer).' + Retry — never 'No schedule data.', never stored", async () => {
    assert.ok(/Couldn’t load the schedule \(MFL didn’t answer\)\./.test(v.sec.textContent), v.sec.textContent);
    assert.ok(!/No schedule data/.test(v.sec.textContent));
    down = false;
    v.sec.querySelector(".sched-retry").click(); await settle(); await settle();
    assert.strictEqual(v.rows().length, 32); assert.strictEqual(v.sos().length, 2);
  });
}
{
  const ns = { ok: true, year: "2027", season: { state: "not_started" }, teams: {}, weeksUsed: [], view: "schedule", schedule: {}, playoffWeeks: [], league: {} };
  const v = boot({ answer: (u) => (!u.searchParams.get("season") ? ns : null) }); await v.open(); await settle();
  await check("from Jan 1 (next season not started): last season, labeled — the page is never blank", () => {
    assert.ok(v.sos().some((r) => /season=2026&v=2$/.test(r.url)));
    assert.ok(/^No 2027 games yet, so this is 2026\./.test(v.basis()), v.basis());
    assert.strictEqual(v.rows().length, 32);
  });
}
{
  const v = boot({ hold: (u) => !u.searchParams.get("season") }); await v.open();
  await v.sel(".sched-year", "2025"); await settle();
  v.gates.forEach((g) => g()); await settle();
  await check("a late answer for the season the owner left never repaints over the one picked", () => {
    assert.strictEqual(v.sec.querySelector(".sched-year").value, "2025");
    assert.ok(/over the 2025 season/.test(v.basis()), v.basis());
  });
}
await check("the word 'Position' is no longer a <label> wrapping the chips (Sched and Pts Agst)", () => {
  for (const blk of [HTML.slice(a0, a1), HTML.slice(b0, b1)]) assert.ok(!/<label>Position<div class="fpa-pos/.test(blk), "a <label> still wraps a chip group");
  assert.ok(/<span id="fpa-pos-lbl">Position<\/span><div class="fpa-pos" role="group" aria-labelledby="fpa-pos-lbl">/.test(HTML));
});
await check("the old heatmap (hsl ramp, Week 18 loop, legacy pos= read) is gone", () => {
  const blk = HTML.slice(b0, b1);
  assert.ok(!/hsl\(|w <= 18|&pos=|schedCellColor|SCHED_POS/.test(blk));
});

console.log(fails ? `\ndesktop_sched: ${fails} FAILED` : "\ndesktop_sched: all passed");
process.exit(fails ? 1 : 0);
