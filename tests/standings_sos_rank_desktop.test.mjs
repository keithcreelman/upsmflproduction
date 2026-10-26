// Strength-of-schedule rank in Full League Overall (#1388 Opponent pass, Keith 2026-10-26: "Remove the separate Opponent choice
// from Full League. In Full League Overall, show strength of schedule as a rank, with 1st meaning hardest schedule so far.
// Show ties explicitly ... compact `SoS: T-9th of 12` line in the Team cell; on desktop, one sortable Schedule column ...
// the short explanation and an unavailable state ... Do not show the index values by default or add an advanced toggle.").
// The REAL /api/standings route (worker harness) on the recorded 2026 season through Week 6 (the same recording as
// standings_wc_back) → the REAL desktop page. Every expected rank is worked out HERE from the response's weekly scores with its
// own copy of the definition (opponent's score / that week's league average, in its OTHER regular-season weeks; rounded to
// 0.001; ranks compare hundredths), never read back from the page or the shared module.
//   node scripts/safe_tests/run.mjs --only standings_sos_rank_desktop
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet } from "./fixtures/worker_harness.mjs";
import { loadSeason, recorded2026 } from "./fixtures/standings_d1.mjs";
import { loadStandingsPage, workerFetch, settle, PAGE_SOURCE } from "./fixtures/standings_v2_page.mjs";

const restore = quiet();
const mfl = makeMfl();
mfl.install();
const json = (rel) => JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), "utf8"));
const REC = json("./fixtures/standings_2026_wk5.json");
const WK6 = json("./fixtures/standings_2026_wk6_week.json");
const S2025 = fs.readFileSync(new URL("./fixtures/standings_2025_recorded.json", import.meta.url), "utf8");
mfl.st.league = { standingsSort: REC.standingsSort };
const plain = (html) => html.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const text = (html) => plain(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

const season6 = () => { const s = recorded2026(REC); return { ...s, weeklyScores: s.weeklyScores.concat(WK6.weekly_scores), games: s.games.concat(WK6.games) }; };
const ENV6 = loadSeason(makeWorkerEnv({}), season6());
const RESP6 = (await callWorker(ENV6, "GET", "/api/standings?year=2026")).json;
const nameOf = Object.fromEntries(RESP6.rows.map((r) => [r.franchise_id, r.franchise_name]));

// ── the definition, written out independently ──
function sosRanks(resp) {
  const sc = resp.weeklyScores.filter((s) => s.po === 0);
  const weeks = [...new Set(sc.map((s) => s.w))].sort((a, b) => a - b);
  const avg = Object.fromEntries(weeks.map((w) => { const xs = sc.filter((s) => s.w === w); return [w, xs.reduce((a, s) => a + s.ts, 0) / xs.length]; }));
  const idx = (f, w) => sc.find((s) => s.w === w && s.fid === f).ts / avg[w];
  const games = resp.weekly.filter((g) => g.po === 0);
  const fids = resp.rows.map((r) => r.franchise_id);
  const str = {};
  for (const f of fids) {
    let n = 0, sum = 0;
    for (const g of games.filter((x) => x.fid === f)) {
      const other = weeks.filter((x) => x !== g.w).map((x) => idx(g.opp, x));
      sum += other.reduce((a, b) => a + b, 0) / other.length; n++;
    }
    str[f] = Math.round((1000 * sum) / n) / 1000;
  }
  const h = (x) => Math.round(x * 100);
  const rank = {}, count = {};
  for (const f of fids) rank[f] = 1 + fids.filter((o) => h(str[o]) > h(str[f])).length;
  for (const f of fids) count[rank[f]] = (count[rank[f]] || 0) + 1;
  const label = (f) => (count[rank[f]] > 1 ? "T-" : "") + rank[f] + (rank[f] % 10 === 1 && rank[f] !== 11 ? "st" : rank[f] % 10 === 2 && rank[f] !== 12 ? "nd" : rank[f] % 10 === 3 && rank[f] !== 13 ? "rd" : "th");
  return { str, rank, label: Object.fromEntries(fids.map((f) => [f, label(f)])), n: fids.length };
}
const SOS6 = sosRanks(RESP6);

async function league(query, { fetch, pageSrc } = {}) {
  const p = loadStandingsPage({ query, fetch: fetch || workerFetch(callWorker, ENV6), pageSrc });
  await new Promise((r) => setTimeout(r, 300));
  await settle();
  const raw = p.html();
  return { raw, html: plain(raw), text: text(raw) };
}
// the Full League table: heads and each team row's cells, in the order drawn
function table(raw) {
  const tbl = /<table class="lg-table"><thead>([\s\S]*?)<\/thead><tbody>([\s\S]*?)<\/tbody><\/table>/.exec(raw);
  if (!tbl) return null;
  const heads = [...tbl[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => text(m[1]));
  const body = tbl[2].replace(/<tr class="disclosure-row"[\s\S]*?<\/tr>/g, "");
  const rows = [...body.matchAll(/<tr class="(?:you-row )?race-row"[^>]*data-fid="(\d{4})">([\s\S]*?)<\/tr>/g)]
    .map((m) => ({ fid: m[1], cells: [...m[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]) }));
  const col = (label) => heads.indexOf(label);
  return { heads, rows, col, cell: (fid, label) => text(rows.find((r) => r.fid === fid).cells[col(label)]), raw: (fid, label) => rows.find((r) => r.fid === fid).cells[col(label)] };
}

// ═══ Week 6, desktop ═══
test("the independent definition reproduces the recorded Week 6 groups: Gride 1st · Cleon Ca$h / Long Haulers / Sex Manther T-2nd · CBP / Pure Greatness / Hawks / L.A. Looks T-5th · HammerTime / Blake Bombers / Real Deal Creel T-9th · C-Town 12th", () => {
  const byLabel = {};
  for (const f of Object.keys(SOS6.label)) (byLabel[SOS6.label[f]] = byLabel[SOS6.label[f]] || []).push(nameOf[f]);
  const norm = (a) => a.map((n) => n.replace(/\s*[🔨⏰]\s*/gu, "").trim()).sort();
  t.deepEqual(Object.keys(byLabel).sort(), ["12th", "1st", "T-2nd", "T-5th", "T-9th"]);
  t.deepEqual(norm(byLabel["1st"]), ["Gride"]);
  t.deepEqual(norm(byLabel["T-2nd"]), ["Cleon Ca$h", "Sex Manther", "The Long Haulers"]);
  t.deepEqual(norm(byLabel["T-5th"]), ["CBP", "Hawks", "L.A. Looks", "Pure Greatness"]);
  t.deepEqual(norm(byLabel["T-9th"]), ["Blake Bombers", "HammerTime", "Real Deal Creel"]);
  t.deepEqual(norm(byLabel["12th"]), ["C-Town Chivalry"]);
});
test("Overall: one sortable Schedule column and a 'SoS: T-9th of 12' line under each owner; both show the same rank, ties marked", async () => {
  const p = await league("view=league&year=2026");
  const L = table(p.raw);
  t.deepEqual(L.heads, ["Seed", "Team", "H2H", "All-Play", "AP %", "WC Back", "PF", "PF/week", "PA/game", "Schedule", "Exp. W", "Luck"]);
  t.equal(L.rows.length, 12);
  for (const r of L.rows) {
    const want = SOS6.label[r.fid];
    t.equal(L.cell(r.fid, "Schedule"), want, nameOf[r.fid] + " Schedule column");
    t.match(L.raw(r.fid, "Team"), new RegExp('<span class="owner-sub sos-sub">SoS: ' + want + " of 12</span>"), nameOf[r.fid] + " Team-cell line");
    // after the owner line, never replacing the name or the owner
    t.match(L.raw(r.fid, "Team"), /<span class="owner-sub">[^<]*<\/span><span class="owner-sub sos-sub">/, "the SoS line follows the owner");
    t.ok(L.cell(r.fid, "Team").startsWith(nameOf[r.fid].replace(/\s+/g, " ")), "name intact");
  }
  // a header you can click: hardest first on the first click
  t.match(L.heads.join("|"), /Schedule/);
  t.match(p.raw, /<th class="lg-wide sortable num" data-sort-key="_sosRank"[^>]*title="Strength of schedule: 1st = hardest so far; T- = tied\. Click to sort hardest first\."[^>]*>Schedule<\/th>/);
  t.match(PAGE_SOURCE, /var ASC_FIRST = \{[^}]*_sosRank: 1 \}/, "first click sorts ascending = 1st (hardest) first");
});
test("only the rank: no index values, no Opponent choice, no advanced toggle, nothing else from the old Opponent view", async () => {
  const p = await league("view=league&year=2026");
  const L = table(p.raw);
  t.ok(!/data-show="opponent"/.test(p.raw), "no Opponent button");
  t.equal((p.raw.match(/data-show="[a-z]+"/g) || []).join(","), 'data-show="scored",data-show="overall"');
  for (const gone of ["Opp. strength", "Opp. vs league", "Opp. vs usual", "Opp. pts/game", "Close H2H games", "hardest</span>"]) t.ok(!p.raw.includes(gone), gone + " is gone from the page");
  t.ok(!/advanced|Advanced|show index|Show index/.test(p.html), "no advanced toggle");
  for (const r of L.rows) t.ok(!/\d\.\d\d/.test(L.cell(r.fid, "Schedule")) && !/\d\.\d\d/.test(/sos-sub">([^<]*)/.exec(L.raw(r.fid, "Team"))[1]), "no index value for " + nameOf[r.fid]);
  t.equal(L.cell("0009", "PA/game"), RESP6.rows.find((r) => r.franchise_id === "0009").regular_season.pa_per_game.toFixed(1), "opponents' points stay in PA/game, unchanged");
});
test("the explanation appears once, next to the through-week line; Scored and the other tabs carry no SoS", async () => {
  const p = await league("view=league&year=2026");
  t.equal((p.raw.match(/class="col-note sos-note"/g) || []).length, 1);
  t.match(p.text, /SoS = strength of schedule\. 1st of 12 = hardest schedule so far; tied teams share a rank\. Based on how your opponents scored in their other games\. This does not affect playoff seeds\./);
  t.ok(p.raw.indexOf('class="fresh"') < p.raw.indexOf("sos-note") && p.raw.indexOf("sos-note") < p.raw.indexOf('<table class="lg-table">'), "freshness line, then the note, then the table");
  t.match(p.text, /Through Week 6 of 14/);
  const scored = await league("view=league&year=2026&show=scored");
  t.ok(!/sos-sub|sos-note|Schedule<\/th>/.test(scored.raw), "Scored is untouched");
  for (const v of ["view=divisions&year=2026", "view=picture&year=2026", "view=weekly&year=2026", "view=trends&year=2026"]) t.ok(!/sos-sub|sos-note/.test((await league(v)).raw), v);
});
test("sorted by Schedule: hardest first, tied teams together, the seed order inside a tie; the old Opponent / Faced links open Overall", async () => {
  const src = PAGE_SOURCE.replace('overall: { sortKey: null, sortDir: "asc" }', 'overall: { sortKey: "_sosRank", sortDir: "asc" }');
  t.ok(src !== PAGE_SOURCE, "the test page sorts by Schedule from the start");
  const p = await league("view=league&year=2026", { pageSrc: src });
  const order = table(p.raw).rows.map((r) => r.fid);
  const seedOrder = RESP6.rows.map((r) => r.franchise_id);
  const expected = seedOrder.slice().sort((a, b) => SOS6.rank[a] - SOS6.rank[b] || seedOrder.indexOf(a) - seedOrder.indexOf(b));
  t.deepEqual(order, expected);
  t.deepEqual(order.map((f) => SOS6.label[f]), expected.map((f) => SOS6.label[f]));
  for (const old of ["opponent", "faced"]) {
    const o = await league("view=league&year=2026&show=" + old);
    t.deepEqual(table(o.raw).heads, table((await league("view=league&year=2026")).raw).heads, "?show=" + old + " → Overall");
  }
});
test("scope: shown for Full Season and Regular Season; hidden for Playoffs and Custom weeks (the rank is a regular-season measure)", async () => {
  for (const [q, on] of [["", true], ["&scope=regular", true], ["&scope=playoffs", false], ["&scope=custom&cs=2&ce=4", false]]) {
    const p = await league("view=league&year=2026" + q);
    t.equal(/sos-sub|sos-note/.test(p.raw) || />Schedule<\/th>/.test(p.raw), on, "scope " + (q || "full") + (on ? " shows" : " hides") + " SoS");
  }
});
test("unavailable: weekly results that can't be read give 'SoS —' and a reason, never a rank and never points faced in its place", async () => {
  const real = workerFetch(callWorker, ENV6);
  const fetch = async (url) => {
    const r = await real(url);
    if (new URL(url).pathname !== "/api/standings") return r;
    const j = await r.json();
    return { ...r, json: async () => ({ ...j, weekly: null, weeklyScores: null, weekly_errors: ["weekly: query failed"] }) };
  };
  const p = await league("view=league&year=2026", { fetch });
  const L = table(p.raw);
  t.ok(L, "the table still renders");
  for (const r of L.rows) {
    t.equal(L.cell(r.fid, "Schedule"), "—", nameOf[r.fid]);
    t.match(L.raw(r.fid, "Team"), /<span class="owner-sub sos-sub">SoS: —<\/span>/);
  }
  t.match(p.text, /SoS —\. The schedule-strength rank isn’t shown because the weekly results couldn’t be read\. It is never replaced by the points your opponents scored\./);
  t.ok(!/\b\d+(st|nd|rd|th) of 12\b/.test(text(p.raw.replace(/<details class="about">[\s\S]*?<\/details>/g, ""))), "no rank anywhere (the About list's wording aside)");
  // one week that doesn't add up (a stat correction in one table only): the whole rank is withheld, naming the week
  const fetch2 = async (url) => {
    const r = await real(url);
    if (new URL(url).pathname !== "/api/standings") return r;
    const j = await r.json();
    const ws = j.weeklyScores.map((s, i) => (i === 0 ? { ...s, ts: s.ts + 5 } : s));
    return { ...r, json: async () => ({ ...j, weeklyScores: ws }) };
  };
  const q = await league("view=league&year=2026", { fetch: fetch2 });
  t.match(q.text, /SoS —\. The schedule-strength rank isn’t shown because the regular-season results couldn’t be verified\./);
  t.match(q.raw, /<span class="owner-sub sos-sub">SoS: —<\/span>/);
});

// ═══ a finished season ═══
test("finished season (2025 recorded): the same rank over the regular season, worded 'this season'; Fin and the recorded seeds are unchanged", async () => {
  const fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/api/standings" && u.searchParams.get("year") === "2025") return { ok: true, status: 200, json: async () => JSON.parse(S2025) };
    if (u.pathname === "/api/historical-finishes") return { ok: true, status: 200, json: async () => ({ ok: true, rows: [] }) };
    return { ok: false, status: 404, json: async () => ({ ok: false }) };
  };
  const resp = JSON.parse(S2025);
  const want = sosRanks(resp);
  const p = await league("view=league&year=2025", { fetch });
  const L = table(p.raw);
  t.ok(L && L.rows.length === 12);
  t.ok(L.heads.includes("Schedule") && L.heads.includes("Fin"));
  for (const r of L.rows) {
    t.equal(L.cell(r.fid, "Schedule"), want.label[r.fid], r.fid);
    t.match(L.raw(r.fid, "Team"), new RegExp("SoS: " + want.label[r.fid] + " of 12"));
  }
  t.match(p.text, /1st of 12 = hardest schedule this season; tied teams share a rank\./);
});

// ═══ phones: the layout contract (the real 320 / 375 screenshots are in the preview) ═══
test("phone widths: the Schedule column hides (lg-wide) and the Team-cell line shows; on desktop the line is hidden", () => {
  t.match(PAGE_SOURCE, /\.sos-sub \{ display: none; \}/);
  const off = PAGE_SOURCE.indexOf(".fc-wide, .lg-wide"), on = PAGE_SOURCE.indexOf(".sos-sub { display: block; }");
  t.ok(off > 0 && on > off && on - off < 300, "inside the same phone block as the hidden Schedule column");
  t.match(PAGE_SOURCE, /@media \(max-width: 560px\) \{\s*\.fc-wide, \.lg-wide/, "that block is the 560px media query");
});

await run("standings_sos_rank_desktop");
mfl.restore();
restore();
