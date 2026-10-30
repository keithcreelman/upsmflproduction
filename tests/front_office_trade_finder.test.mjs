// Front Office → Trade finder (#1338, Keith 2026-10-22). The all-team lineup-strength table is the feature: the
// current-roster comparison of all 12 teams (By Position / By Lineup Slot; PPG / Rank / Above Replacement / Index;
// default By Position, PPG). No Biggest gain and no imaginary-starter scenario (Keith 2026-10-26). Starter Mix is a
// separate view (recorded starts). Each team has a View button: strong / needs help, cap room, future picks by year and
// round with a visible league comparison ("well stocked" only on complete data with forfeits checked), and possible
// roster surplus labeled as analysis. Partner rankings and suggested swaps are gone. Nothing is sent; the current
// season is never used before MFL has scored a week.
//   node tests/front_office_trade_finder.test.mjs
//   FO_TRADES_JS=<path> node tests/front_office_trade_finder.test.mjs   (defect check against another copy)
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(f, "utf8");
const SRC = read(process.env.FO_TRADES_JS || path.join(ROOT, "site/rosters/v2/fo_trades.js"));
const FX = JSON.parse(read(path.join(ROOT, "tests/fixtures/trade_fit_2026_wk6.json")));
const STARTERS = JSON.parse(read(path.join(ROOT, "tests/fixtures/mfl_league_starters_74598_2026.json"))).starters;
const PICKS = JSON.parse(read(path.join(ROOT, "tests/fixtures/mfl_future_draft_picks_74598_2026.json")));
const WEEKLY = JSON.parse(read(path.join(ROOT, "tests/fixtures/weekly_starters_2026_wk1_7.json")));
const CSS = read(path.join(ROOT, "site/rosters/v2/front_office.css"));
const esc = (x) => String(x == null ? "" : x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unesc = (x) => String(x).replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");

// The real view (and the Overview card) on the 2026 Week-6 league, with a minimal hub. opts: {viewer, picks, forfeitOk}.
function page(opts = {}) {
  const listeners = {};
  const el = { innerHTML: "", addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };
  const dialog = { open: null };
  const ctx = vm.createContext({ document: { addEventListener(n, f) { (listeners[n] = listeners[n] || []).push(f); },
    getElementById: (id) => (id === "fo-trades-body" ? el : null), querySelector: () => null }, Intl, Date });
  ctx.window = ctx;
  for (const f of ["site/m/front_office_lineup.js", "site/shared/trade_fit.js", "site/shared/lineup_strength.js", "site/shared/trade_finder_core.js", "site/shared/starter_mix.js"]) vm.runInContext(read(path.join(ROOT, f)), ctx);
  const TF = ctx.UPS_TRADE_FIT, LS = ctx.UPS_LINEUP_STRENGTH, SM = ctx.UPS_STARTER_MIX, L = ctx.UPS_FRONT_OFFICE_LINEUP;
  const slots = TF.deriveSlots(STARTERS);
  const model = TF.buildLeague({ teams: FX.teams, values: FX.values, freeAgents: FX.freeAgents, slots });
  const viewer = opts.viewer || "0008";
  const rost = {};
  for (const tm of FX.teams) for (const p of tm.players) rost[p.pid] = { fid: tm.fid, p: { name: p.name, position: p.pos } };
  const grp = (pid) => { const g = L.posGroup(WEEKLY.positions[pid] || ""); return g === "OTH" ? "" : g; };
  const mix = SM.build({ weeklyResults: WEEKLY, completedWeek: 6, slots, groupOf: grp, fids: FX.teams.map((x) => x.fid) });
  const entries = {
    scores: { state: "ok" }, players: { state: "ok" }, picks: { state: "ok", data: opts.picks || PICKS }, weeklyResults: { state: "ok", data: WEEKLY },
    ["franchiseAssets:" + viewer]: { state: "ok", data: { forfeit_check: opts.forfeitOk === false ? "unavailable" : "ok", future_picks: [] } }
  };
  const H = { registerView() {}, registerAbout() {}, wireClicks() {}, loading() {}, banner: (m) => m, setFreshness() {}, clock: () => "",
    scoring: () => ({ seasonWeeks: [1, 2, 3, 4, 5, 6], finalKnown: true, finalThrough: 6, fetchedAt: 1 }),
    lineupSlotsState: () => "ok", lineupSlots: () => slots, leagueModel: (n) => (n ? null : model), starterMix: () => mix, playerGroup: grp,
    asArray: (x) => (x == null ? [] : Array.isArray(x) ? x : [x]), pad4: (x) => String(x).padStart(4, "0"), esc,
    fmt1: (v) => (Math.round(Number(v) * 10) / 10).toFixed(1), money: (v) => "$" + Number(v).toLocaleString("en-US"), displayName: (n) => n,
    teamName: (f) => (FX.teams.find((x) => x.fid === f) || {}).name || f, rosterIndex: () => rost, seasonLine: (pid) => ({ ppg: FX.values[pid] }),
    playerButton: (pid, fid, label) => '<button data-fo-player="' + esc(pid) + '">' + esc(label) + "</button>", injuryChip: () => "", goLink: () => "",
    openDialog: (title, html, opts) => { dialog.open = { title, html, opts }; }, closeAbout: () => { dialog.open = null; } };
  const FO = { viewerFid: () => viewer, teams: () => FX.teams, capCeiling: 300000,
    capFor: (f) => ({ capSpace: FX.capRoom[f], capAlloc: 300000 - FX.capRoom[f] }), warRoomUrl: (o) => "#war-room?" + Object.entries(o).map(([k, v]) => k + "=" + v).join("&") };
  const DATA = { get: (k, a) => entries[a != null ? k + ":" + a : k] || null, load: () => ({ then() {} }) };
  Object.assign(ctx, { UPS_FO_HUB: H, UPS_FO: FO, UPS_FO_DATA: DATA });
  vm.runInContext(SRC, ctx);
  (listeners["fo:ready"] || []).forEach((f) => f());
  const TR = ctx.UPS_FO_TRADES;
  const show = (state) => { TR._setMode("finder"); Object.assign(TR._view, state.view || {}); if ("team" in state) TR._sel.team = state.team; (listeners["fo:tab"] || []).forEach((f) => f({ detail: { section: "trades" } })); return el.innerHTML; };
  const team = (f) => TR._teamHtml(f);
  return { ctx, TF, LS, SM, model, slots, mix, show, team, dialog, TR, H, FO, DATA, el, TFC: ctx.UPS_TRADE_FINDER };
}
// The strength table → { fid: { row: text } } (team id from the View button).
function readTable(html) {
  const tb = html.slice(html.indexOf("fo-tf-strength"), html.indexOf("</table>", html.indexOf("fo-tf-strength")));
  const out = {}, order = [];
  for (const tr of tb.split("<tr").slice(2)) {
    const m = tr.match(/data-tf-view="(\d{4})"/); if (!m) continue;
    order.push(m[1]); out[m[1]] = {};
    for (const c of tr.matchAll(/data-tf-row="(\w+)"[^>]*>([^<]*)/g)) out[m[1]][c[1]] = unesc(c[2]);
  }
  return { cells: out, order };
}
const sum = (a) => a.reduce((x, y) => x + y, 0);

test("partner rankings and suggested swaps are gone; nothing is sent; no current-season numbers before Week 1", () => {
  for (const gone of ["Logical partners", "Swaps that improve", "pairFits", "data-tf-partner", "twb_give", "You could offer", "They could offer"]) t.ok(!SRC.includes(gone), "removed: " + gone);
  t.ok(!/fetch\(|method:\s*"POST"|XMLHttpRequest/.test(SRC), "no network write path in the view");
  t.ok(/if \(!ss\.seasonWeeks\.length\) \{ el\.innerHTML = H\.banner\("The Trade finder starts once MFL has scored a week this season\./.test(SRC), "preseason: says it starts after Week 1");
  t.ok(/doesn’t grade trades, rank partners or suggest swaps/.test(SRC) && !/swaps that would improve|logical partner/i.test(SRC), "About describes the new view, promises no partners or swaps");
});

test("default = By Position, PPG; the controls in a fixed order", () => {
  const p = page();
  const html = p.show({});
  t.equal([...html.matchAll(/data-tf-by="(\w+)"[^>]*>([^<]+)</g)].map((x) => x[2]).join(" | "), "By Position | By Lineup Slot | Starter Mix");
  t.equal([...html.matchAll(/data-tf-measure="(\w+)"[^>]*>([^<]+)</g)].map((x) => x[2]).join(" | "), "PPG | Rank | Above Replacement | Index");
  t.ok(/data-tf-by="position" aria-pressed="true"/.test(html) && /data-tf-measure="ppg" aria-pressed="true"/.test(html), "By Position + PPG selected");
});

test("every cell is the lineup-strength table's cell for that team and view (both breakdowns × all four measures × 12 teams)", () => {
  const p = page();
  let n = 0;
  for (const by of ["position", "slot"]) for (const measure of ["ppg", "rank", "above", "index"]) {
    const { cells, order } = readTable(p.show({ view: { by, measure, sort: "ALL" } }));
    t.equal(order.length, 12, by + "/" + measure + ": 12 teams, each with a View button");
    const tb = p.LS.build(p.model, { by });
    for (const fid of order) for (const r of tb.rows) { t.equal(cells[fid][r], p.LS.cell(tb, fid, r, measure).text, by + "/" + measure + " " + fid + " " + r); n += 1; }
  }
  t.equal(n, 12 * (10 + 13) * 4, "all " + 12 * 23 * 4 + " cells compared");
});

test("sorting: by the Overall of the chosen measure (rank ascending), or by any column", () => {
  const p = page();
  const ppg = readTable(p.show({ view: { by: "position", measure: "ppg", sort: "ALL" } })).order;
  t.equal(ppg.join(","), p.model.order.slice().sort((a, b) => p.model.teams[b].total - p.model.teams[a].total).join(","), "PPG: best lineup first");
  const tb = p.LS.build(p.model, { by: "slot" });
  const rb = readTable(p.show({ view: { by: "slot", measure: "rank", sort: "FLEX" } })).order;
  t.equal(rb.map((f) => tb.teams[f].FLEX.rank).join(","), rb.map((f) => tb.teams[f].FLEX.rank).sort((a, b) => a - b).join(","), "Rank sorted by the Flex column: 1st first");
  p.show({ view: { sort: "ALL" } });
});

test("Starter Mix is a separate view of recorded starts, with no strength measures", () => {
  const p = page();
  const html = p.show({ view: { by: "mix" } });
  t.ok(/<b>Actual starter mix<\/b> · Weeks 1–6/.test(html) && /not the modeled lineup/.test(html), "labeled Actual, not modeled");
  t.ok(!/data-tf-measure/.test(html), "no PPG/Rank/Above/Index on recorded starts");
  t.ok(/Flexible slots/.test(html) && /Superflex QB/.test(html), "Flexible slots and the Superflex QB share");
  const rdc = html.slice(html.indexOf('data-tf-view="0008"'), html.indexOf("</tr>", html.indexOf('data-tf-view="0008"')));
  t.ok(rdc.includes('<td class="num">' + p.mix.teams["0008"].avg.RB.toFixed(1) + "</td>"), "values are starter_mix's");
  t.ok(/6 of 6/.test(rdc), "weeks counted shown");
  p.show({ view: { by: "position" } });
});

test("View opens a popup (a bottom sheet on phones), not a card at the bottom; closing returns focus and clears the selection", () => {
  const p = page();
  const before = p.show({});
  p.TR._openTeam("0008");
  t.ok(p.dialog.open, "the hub dialog opened");
  t.equal(p.dialog.open.opts.variant, "team", "team variant (a popup on desktop, a bottom sheet under 600 px)");
  t.equal(p.dialog.open.title, "Real Deal Creel (you)");
  t.ok(/data-tf-team-view="0008"/.test(p.dialog.open.html), "the team view is the dialog body");
  t.equal(p.TR._sel.team, "0008", "row marked selected");
  t.ok(typeof p.dialog.open.opts.returnFocus === "function", "focus returns to that team's View button (looked up fresh, the table may have re-rendered)");
  p.dialog.open.opts.onClose();
  t.equal(p.TR._sel.team, "", "closing clears the selection");
  t.ok(!/id="fo-tf-team"/.test(before) && !/scrollIntoView/.test(SRC), "no team card on the page and no scrolling to one");
  t.ok(/@media \(max-width: 600px\) \{\s*\.fo-about\[data-variant="team"\] \{ align-items: flex-end;/.test(CSS), "bottom sheet on phones");
  const HUB = read(path.join(ROOT, "site/rosters/v2/fo_hub.js"));
  t.ok(/e\.key === "Escape"/.test(HUB) && /keep focus inside the dialog/.test(HUB) && /preventScroll: true/.test(HUB), "Escape closes, Tab stays inside, focus returns without scrolling");
});

test("standing is separate from lineup gain: PPG, league average, gap and rank — never 'needs help'", () => {
  const p = page();
  const tb = p.LS.build(p.model);
  for (const f of p.model.order) {
    const html = p.team(f), tr = tb.teams[f];
    t.ok(!/needs help|Needs help|biggest need|Biggest need/.test(html), f + ": no 'needs help' / 'need' label");
    for (const g of ["QB", "RB", "WR", "TE", "DL", "LB", "DB"]) {
      const row = html.slice(html.indexOf('data-tf-pos="' + g + '"'), html.indexOf("</tr>", html.indexOf('data-tf-pos="' + g + '"')));
      const avg = tb.league[g].meanPpg, gap = tr[g].ppg - avg;
      t.ok(row.includes('<td class="num">' + (Math.round(tr[g].ppg * 10) / 10).toFixed(1) + '</td><td class="num">' + (Math.round(avg * 10) / 10).toFixed(1) + "</td>"), f + " " + g + ": PPG and league average");
      t.ok(row.includes(">" + p.LS.ordinal(tr[g].rank) + "</td>"), f + " " + g + ": rank");
      const tag = tr[g].rank <= 3 ? "Top 3" : tr[g].rank >= 10 ? "Bottom 3" : "";
      t.equal(/Top 3|Bottom 3/.test(row) ? row.match(/Top 3|Bottom 3/)[0] : "", tag, f + " " + g + ": standing tag from rank only");
      t.ok(Math.abs(gap) < 0.05 || row.includes((gap > 0 ? "+" : "−") + Math.abs(Math.round(gap * 10) / 10).toFixed(1)), f + " " + g + ": gap to the league average");
    }
  }
});

test("no hypothetical starter: the team view has no 'One addition' scenario, and the table no Biggest gain (Keith 2026-10-26)", () => {
  const p = page();
  const SRCTF = fs.readFileSync(path.join(ROOT, "site/rosters/v2/fo_trades.js"), "utf8");
  t.ok(!/additionDetail|biggestGain|gainText|One addition|Biggest gain|typical \(median\)|median starting/.test(SRCTF), "no code path builds an imaginary median starter");
  for (const f of p.model.order) {
    const html = p.team(f);
    t.ok(!/One addition|typical starter|median starter|pts\/wk<\/b>|would start at|would leave the lineup/.test(html), f + ": no imaginary-starter text in the team view");
    t.ok(html.includes("Standing by position") && html.includes("Future picks") && html.includes("Possible roster surplus"), f + ": standing, picks and surplus (real players) stay");
  }
});

test("positions expand to their modeled starters (RB1, RB2, Flex…), labeled as modeled — not MFL-recorded slots", () => {
  const p = page();
  const html = p.team("0008");
  for (const g of ["QB", "RB", "WR", "DL", "LB", "DB"]) {
    const list = p.LS.modeledStarters(p.model, "0008", g);
    t.ok(list.length >= 1, g + " has modeled starters");
    t.ok(html.includes('data-tf-pos="' + g + '" aria-expanded="false" aria-controls="fo-tf-pos-' + g + '"'), g + ": a collapsed toggle");
    t.ok(new RegExp('id="fo-tf-pos-' + g + '" hidden').test(html), g + ": detail row hidden until tapped");
    t.equal(list.filter((x) => /\d$/.test(x.depth)).map((x) => x.depth).join(","), Array.from({ length: list.filter((x) => /\d$/.test(x.depth)).length }, (_, i) => g + (i + 1)).join(","), g + ": fixed slots numbered by PPG");
    for (let i = 1; i < list.length; i++) t.ok(list[i - 1].v >= list[i].v, g + ": best first");
  }
  const rb = p.LS.modeledStarters(p.model, "0008", "RB");
  t.ok(rb.length >= 2 && rb[0].depth === "RB1" && rb[1].depth === "RB2", "RB1 and RB2");
  t.ok(/an order by season PPG, not slots MFL recorded/.test(html) && /Starter Mix shows the lineups actually submitted/.test(html), "modeled depth vs actual starts, said plainly");
});

test("cap room as on Overview", () => {
  const p = page();
  t.ok(p.team("0008").includes("$" + FX.capRoom["0008"].toLocaleString("en-US")), "cap room = the cap engine's");
});

test("future picks: grouped by year and round, every MFL pick once; the comparison table is visible", () => {
  const p = page();
  const book = p.TR._pickBook();
  t.equal(book.years.map((y) => y.year).join(","), "2027");
  t.equal(book.years[0].rounds.join(","), "1,2,3,4,5");
  t.ok(book.years[0].complete, "2027: 60 of 60 (12 × 5)");
  const listed = PICKS.futureDraftPicks.franchise.reduce((a, f) => a + [].concat(f.futureDraftPick || []).length, 0);
  t.equal(sum(book.teams.map((f) => book.years[0].byFid[f].count)), listed, "every MFL pick counted once");
  const part = p.team("0001");
  for (const r of [1, 2, 3, 4, 5]) t.ok(part.includes('<span class="fo-tf-rd">R' + r + "</span>"), "round " + r + " row");
  t.ok(/Compare all teams’ picks/.test(part) && (part.match(/<tr class="[^"]*"><th scope="row">/g) || []).length >= 12, "the 12-team comparison is in the view");
});

test("'well stocked' only on complete data with forfeits checked; otherwise the counts without the label", () => {
  // 0007 holds 11 of 60 picks (league median 4.5).
  const other = page({ viewer: "0008" });
  let s = other.TR._pickStock(other.TR._pickBook(), "0007");
  t.equal(s.total, 11); t.equal(s.median, 4.5); t.ok(s.high, "high by the rule (≥ median + 2 and ≥ 1.5×)");
  t.equal(s.wellStocked, false, "not the viewer's team: forfeits unchecked → not called well stocked");
  t.ok(/Lineup-penalty forfeits are only checked for your own team, so this isn’t called well stocked/.test(other.team("0007")));
  const own = page({ viewer: "0007" });
  s = own.TR._pickStock(own.TR._pickBook(), "0007");
  t.equal(s.wellStocked, true, "the viewer's own team, forfeits checked, complete list → well stocked");
  t.ok(/<b>Well stocked:<\/b> 11 picks, the most in the league \(league median 4\.5\)/.test(own.team("0007")));
  const noCheck = page({ viewer: "0007", forfeitOk: false });
  t.equal(noCheck.TR._pickStock(noCheck.TR._pickBook(), "0007").wellStocked, false, "forfeit check unavailable → not asserted");
  // An incomplete list: drop one pick from another team.
  const cut = JSON.parse(JSON.stringify(PICKS));
  const f2 = cut.futureDraftPicks.franchise.find((x) => x.id === "0002"); f2.futureDraftPick = [].concat(f2.futureDraftPick).slice(1);
  const inc = page({ viewer: "0007", picks: cut });
  const book = inc.TR._pickBook();
  t.equal(book.years[0].complete, false, "59 of 60 → incomplete");
  t.equal(inc.TR._pickStock(book, "0007").wellStocked, false, "incomplete → never 'well stocked'");
  const html = inc.team("0007");
  t.ok(/list has 59 of 60 picks \(12 teams × 5 rounds\), so these are the known picks only/.test(html) && /MFL’s pick list is incomplete, so this isn’t called well stocked/.test(html));
});

test("roster surplus: labeled analysis, each gain is trade_fit's for that other team, no offer language", () => {
  const p = page();
  const fid = p.model.order.find((f) => (p.model.teams[f].surplus || []).length);
  const part = p.team(fid);
  t.ok(/Possible roster surplus <span class="fo-muted">\(analysis\)<\/span>/.test(part), "titled as analysis");
  t.ok(/Analysis, not an offer/.test(part) && /says nothing about whether the owner would move them/.test(part), "not a claim the owner is offering");
  const s = p.model.teams[fid].surplus[0];
  const pl = p.model.teams[fid].team.players.find((x) => x.pid === s.pid);
  for (const g of s.gains.slice(0, 3)) {
    t.equal(Math.round(p.TF.addGain(p.model, g.fid, pl) * 10) / 10, g.gain, "gain for " + g.fid + " recomputes");
    t.ok(part.includes(esc(p.H.teamName(g.fid)) + " <b>+" + g.gain.toFixed(1) + "</b>"), "shown: " + g.fid);
  }
  t.ok(!/they could offer|you could offer|available for trade/i.test(part), "no offer claims");
});

test("no Biggest gain column; the League average row is the reference", () => {
  const p = page();
  const html = p.show({ view: { by: "position", measure: "ppg", sort: "ALL" } });
  t.ok(!/Biggest (gain|need)/.test(html) && !/potential gain/.test(html), "no Biggest gain column or note");
  const tb = p.LS.build(p.model);
  const st = html.indexOf("fo-tf-strength"); // the league table (Your team's tables come first on the page)
  const head = html.slice(html.indexOf("<thead>", st), html.indexOf("</thead>", st));
  t.equal((head.match(/<th /g) || []).length, 1 + tb.rows.length, "Team + one column per row of the table, nothing else");
  const row = html.slice(html.indexOf('data-tf-team="0008"'), html.indexOf("</tr>", html.indexOf('data-tf-team="0008"')));
  t.equal((row.match(/<td /g) || []).length, tb.rows.length, "each team row has exactly the table's cells");
  const foot = html.slice(html.indexOf("<tfoot>", st), html.indexOf("</tfoot>", st));
  t.ok(/League average<\/th>/.test(foot) && foot.includes('<td class="num">' + (Math.round(tb.league.ALL.meanPpg * 10) / 10).toFixed(1) + "</td>"), "PPG: the league-average row (outside the sorted body)");
  t.equal((foot.match(/<td/g) || []).length, tb.rows.length, "the footer has no empty extra cell");
  const idx = p.show({ view: { measure: "index" } });
  const ifoot = idx.slice(idx.indexOf("<tfoot>"), idx.indexOf("</tfoot>"));
  t.ok(/League average = 100<\/th>/.test(ifoot) && (ifoot.match(/<td class="num">100<\/td>/g) || []).length === tb.rows.length, "Index: the reference row reads 100 in every column");
  t.ok(/Index: 100 = the league average for that column \(the bottom row\)/.test(idx), "and the note says what 100 means");
  t.ok(!/background: rgba/.test(html), "calmer: no colored cell fills");
  p.show({ view: { measure: "ppg" } });
});

test("Starter Mix: columns sort, the league average row stays apart, and the Flexible-slots share has a stated denominator", () => {
  const p = page();
  const html = p.show({ view: { by: "mix", mixSort: "TE" } });
  const order = [...html.slice(html.indexOf("fo-tf-mix")).matchAll(/<tbody>[\s\S]*?<\/tbody>/g)][0][0].match(/data-tf-team="(\d{4})"/g).map((x) => x.slice(14, 18));
  const te = order.map((f) => p.mix.teams[f].avg.TE);
  t.equal(te.join(","), te.slice().sort((a, b) => b - a).join(","), "sorted by TE per week, most first");
  t.ok(/<tfoot><tr class="fo-tf-ref"><th scope="row" class="fo-tf-teamcol">League average<\/th>/.test(html), "league average in the footer, never sorted into the teams");
  for (const f of p.model.order) {
    const F = p.mix.teams[f].mix.FLEXIBLE;
    if (!F.total) continue;
    const share = (F.by.TE || 0) / F.total * 100;
    const shown = p.SM.mixList(F).find((x) => x.g === "TE");
    t.ok(!shown || Math.abs(shown.whole - share) < 1, f + ": TE share " + (shown ? shown.whole : 0) + "% = " + (F.by.TE || 0) + " of " + F.total + " extra RB/WR/TE starts");
    t.ok(html.includes('title="Of ' + F.total + " extra RB/WR/TE starts: "), f + ": the cell's tooltip gives the counts");
  }
  const ham = p.mix.teams["0005"].mix.FLEXIBLE;
  t.equal(ham.by.TE + "/" + ham.total, "8/14", "HammerTime: 8 of 14 extra starts were a TE (57%)");
  t.ok(/beyond the 2 RB, 2 WR and 1 TE slots/.test(html), "the denominator is explained on screen");
  p.show({ view: { by: "position", mixSort: "" } });
});

test("phone: the table scrolls in its card with the team column pinned; the team view stacks", () => {
  t.ok(/\.fo-tf-strength \.fo-tf-teamcol \{ position: sticky; left: 0;/.test(CSS), "team column pinned");
  t.ok(/fo-table-scroll fo-tf-scroll/.test(SRC), "table inside its own scroll box (the page never scrolls sideways)");
  t.ok(/@media \(max-width: 1100px\) \{ \.fo-tf-grid \{ grid-template-columns: 1fr; \} \.fo-tf-cols \{ grid-template-columns: 1fr; \} \}/.test(CSS), "team view one column on narrow screens");
});

test("Trades opens on the Trade builder (first chip); the Trade finder is the second chip and unchanged", () => {
  t.ok(/var mode = "builder";/.test(SRC), "the default mode is the builder");
  t.ok(/MODES = \[\["builder", "Trade builder"\], \["finder", "Trade finder"\]\]/.test(SRC), "chips: Trade builder first, Trade finder second");
  t.ok(/if \(mode === "builder"\) \{ renderBuilder\(el\); return; \}/.test(SRC), "finder code only runs in finder mode");
});

test("How to use this page: collapsed by default; explains the table, the team view and what possible roster surplus is based on", () => {
  const p = page();
  const html = p.show({ view: { by: "position", measure: "ppg" } });
  t.ok(/data-tf-guide aria-expanded="false" aria-controls="fo-tf-guide">/.test(html), "a disclosure button, collapsed");
  t.ok(/<div class="fo-tf-guide" id="fo-tf-guide" hidden>/.test(html), "the guide is hidden until tapped");
  const guide = unesc(html.slice(html.indexOf('id="fo-tf-guide"'), html.indexOf("</ul></div></div>")));
  t.ok(/<b>The league table<\/b> \(below\) shows every team’s modeled lineup/.test(guide) && /<b>Explore a team<\/b> \(or <b>View<\/b> in the table\) opens it/.test(guide), "the table and the team details");
  t.ok(/<b>Explore a position<\/b> \(the default\) lists where you’re weak/.test(guide) && /their lineup loses nothing/.test(guide) && /Every number is season PPG, not a projection/.test(guide), "explore a position (weak spots → bench help); the basis");
  t.ok(/<b>Possible roster surplus<\/b> = healthy bench players outside that team’s modeled lineup who would start for another team, on season PPG/.test(guide), "what surplus means and its basis");
  t.ok(/doesn’t mean the owner would move them/.test(guide), "no willingness implied");
  t.equal((guide.match(/<li>/g) || []).length, 5, "a few short lines");
  t.ok(/if \(t\.hasAttribute\("data-tf-guide"\)\) \{\s*guideOpen = !guideOpen;/.test(SRC) && /if \(gd\) gd\.hidden = !guideOpen;/.test(SRC), "the button toggles it in place");
  t.ok(p.show({ view: { by: "mix" } }).includes('id="fo-tf-guide"'), "also on Starter Mix");
  p.show({ view: { by: "position" } });
});

test("the two full gain lists are gone from Your team (Keith 2026-10-30); the gains still feed the position options and the popup", () => {
  const p = page();
  p.TR._xview.by = "position"; p.TR._xview.pos = "";
  const html = p.show({ view: { by: "position", measure: "ppg" } });
  const card = unesc(html.slice(html.indexOf("fo-tf-mine"), html.indexOf("fo-tf-main")));
  t.ok(!/Players who would improve your lineup|Your players who would improve theirs|data-tf-gains=|data-tf-gall|data-tf-gmore|fo-tf-gainscard/.test(card), "no gain lists, in either Explore mode");
  p.TR._xview.by = "team";
  t.ok(!/Players who would improve your lineup|data-tf-gains=/.test(unesc(p.show({}))), "nor under Explore a team");
  p.TR._xview.by = "position";
  t.ok(!/gainsHtml|data-tf-gall|data-tf-gmore|Lineup gains<\/b>/.test(SRC), "the code, handlers and About text went with them");
  t.equal(p.TR._gains("0008"), p.TR._gains("0008"), "computed once per model (memoized)");
  const nobody = page({ viewer: "9999" }).show({});
  t.ok(/Your team’s view needs to know which team is yours, and Front Office couldn’t tell\. The league table is below\./.test(unesc(nobody)) && !/data-tf-weak=/.test(nobody) && /fo-tf-strength/.test(nobody), "no viewer team → says so, lists nothing, the league table still shows");
});

test("your team first (Keith 2026-10-30): Explore a position by default — weak spots = trade_finder_core.weakSpots, no best-available table; then the league table", () => {
  const p = page();
  p.TR._xview.by = "position"; p.TR._xview.pos = "";
  const html = p.show({ view: { by: "position", measure: "ppg" } });
  const mine = html.indexOf("fo-tf-mine"), table = html.indexOf("fo-tf-main");
  t.ok(mine > 0 && mine < table, "Your team card before the league table");
  const card = unesc(html.slice(mine, table));
  t.ok(/<h2>Your team: find help<\/h2>/.test(card), "titled");
  t.ok(/<p class="fo-tf-basisline"><b>Based on season points per game, not projections\.<\/b>/.test(card), "basis stated prominently, near the top");
  t.ok(card.indexOf("Based on season points per game") < card.indexOf("fo-tf-weak"), "before any number");
  t.ok(/data-tf-xby="position" aria-pressed="true">Explore a position<\/button>/.test(card) && /data-tf-xby="team" aria-pressed="false">Explore a team<\/button>/.test(card), "two ways in: a position (default) or a team");
  t.ok(!/Best available|fo-tf-stand|<b>Strong<\/b>/.test(card), "the per-position best-available table is gone");
  const TB = p.LS.build(p.model, { by: "position" }), G = p.TF.lineupGains(p.model, "0008");
  const W = p.TFC.weakSpots(p.TFC.standing(TB, "0008", { forMe: G.forMe }));
  const weak = [...card.matchAll(/data-tf-weak="(\w+)"/g)].map((x) => x[1]);
  t.equal(weak.join(","), W.weak.map((r) => r.g).join(","), "weak positions, worst rank first: " + weak.join(","));
  for (const r of W.weak) {
    const i = card.indexOf('data-tf-weak="' + r.g + '"'), row = card.slice(i, card.indexOf("</li>", i));
    t.ok(row.includes(p.LS.ordinal(r.rank) + " of 12") && row.includes(p.H.fmt1(r.ppg) + " PPG · league " + p.H.fmt1(r.avg)), r.g + ": rank, PPG and league average");
    t.equal(/Bottom 3/.test(row), r.tag === "short", r.g + ": Bottom 3 tag");
    t.ok(row.includes('data-tf-xpos="' + r.g + '" aria-expanded="false" aria-controls="fo-tf-posx">Explore ' + r.g + " options</button>"), r.g + ": its Explore button");
    const O = p.TFC.positionOptions(p.model, TB, G, r.g, p.TF);
    t.ok(row.includes(O.surplus.length ? O.surplus.length + " bench " + r.g : O.starters.length ? "No bench " + r.g + " elsewhere would help; " + O.starters.length : "No " + r.g + " on another team"), r.g + ": the help line");
  }
  const others = [...card.slice(card.indexOf("fo-tf-others")).matchAll(/data-tf-xpos="(\w+)"/g)].map((x) => x[1]);
  t.equal(others.join(","), W.others.map((r) => r.g).join(","), "other positions are buttons too, best rank first");
  t.ok(!/data-tf-xpos="(PK|PN)"/.test(card), "K and P aren't listed");
  t.ok(!/id="fo-tf-posx"/.test(card), "no position open until asked");
});

test("Explore a position: bench help first (their lineup loses nothing), then starters with their loss; Explore team opens that team with the player ticked", () => {
  const p = page();
  const TB = p.LS.build(p.model, { by: "position" }), G = p.TF.lineupGains(p.model, "0008");
  p.TR._xview.by = "position"; p.TR._xview.pos = "RB"; p.TR._xview.allStarters = false;
  const card = unesc(p.show({ view: { by: "position" } }));
  const O = p.TFC.positionOptions(p.model, TB, G, "RB", p.TF);
  t.ok(O.surplus.length > 0 && O.starters.length > 5, "the fixture has bench and starter RB help");
  const i = card.indexOf('id="fo-tf-posx"'), panel = card.slice(i, card.indexOf('class="fo-basis">Starters are ordered', i));
  t.ok(i > card.indexOf('data-tf-weak="RB"') && i < card.indexOf("</li>", card.indexOf('data-tf-weak="RB"')), "the panel opens under the RB row");
  t.ok(/<h3 class="fo-tf-gh">RB options<\/h3>/.test(panel) && /data-tf-xpos="RB" aria-expanded="true"[^>]*>Close<\/button>/.test(panel), "titled, with Close");
  t.ok(panel.indexOf("On another team’s bench") < panel.indexOf("Starting for another team"), "bench first");
  const ids = (kind) => [...panel.matchAll(new RegExp('data-tf-opt="(\\d+)" data-tf-optkind="' + kind + '"', "g"))].map((x) => x[1]);
  t.equal(ids("bench").join(","), O.surplus.map((x) => x.pid).join(","), "every bench option, largest gain first");
  t.equal(ids("starter").join(","), O.starters.slice(0, 5).map((x) => x.pid).join(","), "five starters, then Show all");
  t.ok(panel.includes('data-tf-xall aria-expanded="false">Show all ' + O.starters.length + "</button>"), "Show all N");
  for (const x of O.surplus) {
    const r = panel.slice(panel.indexOf('data-tf-opt="' + x.pid + '"'), panel.indexOf("</tr>", panel.indexOf('data-tf-opt="' + x.pid + '"')));
    t.ok(r.includes('<span class="fo-tf-gnum">+' + p.H.fmt1(x.gain) + "</span>") && r.includes("their lineup −0.0") && r.includes(p.H.teamName(x.fid)), x.pid + ": gain, team, no loss");
    t.ok(r.includes('data-tf-xteam="' + x.fid + '" data-tf-xpid="' + x.pid + '"') && />Explore team<\/button>/.test(r), x.pid + ": Explore team");
  }
  for (const x of O.starters.slice(0, 5)) {
    const r = panel.slice(panel.indexOf('data-tf-opt="' + x.pid + '"'), panel.indexOf("</tr>", panel.indexOf('data-tf-opt="' + x.pid + '"')));
    t.ok(r.includes("their lineup −" + p.H.fmt1(x.loss)) && x.loss > 0, x.pid + ": their loss");
  }
  t.ok(!/trade for|in exchange|you could offer|would trade|willing|available for trade/i.test(panel), "no exchange or willingness wording");
  p.TR._xview.allStarters = true;
  const all = unesc(p.show({}));
  t.equal([...all.matchAll(/data-tf-optkind="starter"/g)].length, O.starters.length, "Show all lists every starter");
  // Explore team → that team's popup with the player ticked on their side.
  const x = O.surplus[0];
  p.TR._openTeam(x.fid, { tick: x.pid });
  const dlg = p.dialog.open.html;
  t.ok(new RegExp('data-tf-pick="theirs" value="' + x.pid + '" checked').test(dlg), "the player is ticked in the popup");
  t.equal(p.TR._picks().other, x.fid); t.equal(p.TR._picks().theirs[x.pid], true);
  t.ok(/Selected: 1 of theirs, 0 of yours/.test(dlg), "the selection bar counts him");
  p.TR._xview.pos = ""; p.TR._xview.allStarters = false;
});

test("Explore a team: the team picker (the 11 other teams) replaces the weak list; choosing one opens its popup", () => {
  const p = page();
  p.TR._xview.by = "team";
  const html = p.show({ view: { by: "position" } });
  const card = unesc(html.slice(html.indexOf("fo-tf-mine"), html.indexOf("fo-tf-main")));
  t.ok(/data-tf-xby="team" aria-pressed="true">Explore a team<\/button>/.test(card), "Explore a team chosen");
  const opts = [...card.matchAll(/<option value="(\d{4})">/g)].map((x) => x[1]);
  t.equal(opts.length, 11, "the 11 other teams"); t.ok(!opts.includes("0008"), "not my own");
  t.ok(!/data-tf-weak=/.test(card), "no weak list in this mode");
  t.ok(/el\.addEventListener\("change", function \(e\) \{[\s\S]*?data-tf-explore[\s\S]*?openTeam\(m, f\)/.test(SRC), "choosing a team opens its popup");
  t.ok(/data-tf-xteam[\s\S]*?openTeam\(xm, xf, \{ tick: t\.getAttribute\("data-tf-xpid"\), returnTo: t \}\)/.test(SRC), "Explore team ticks the player and returns focus to its button");
  p.TR._xview.by = "position";
});

test("another team's popup: their players with the gain to MY lineup, my players with the gain to THEIRS (The Long Haulers), checkboxes, basis beside every gain", () => {
  const p = page();
  p.show({});
  p.TR._openTeam("0006");
  const html = p.dialog.open.html;
  const P = p.TFC.pairGains(p.TF.lineupGains(p.model, "0008"), "0006");
  t.ok(/<h4 class="fo-tf-h">Between you and The Long Haulers<\/h4>/.test(html), "the pair section");
  t.ok(html.indexOf("fo-tf-between") < html.indexOf("Standing by position"), "first in the popup");
  t.ok(/<b>Based on season points per game, not projections\.<\/b>/.test(html) && /doesn’t say a trade is fair or that an owner would accept/.test(unesc(html)), "basis and exploration-only note");
  for (const [side, list, title] of [["theirs", P.theirs, "your modeled lineup"], ["mine", P.mine, "The Long Haulers’s modeled lineup"]]) {
    const part = html.slice(html.indexOf('data-tf-pairs="' + side + '"'), html.indexOf("</table>", html.indexOf('data-tf-pairs="' + side + '"')));
    const rows = part.split('<tr data-tf-pair="').slice(1);
    t.equal(rows.length, list.length, side + ": every player of the drilldown");
    rows.forEach((r, i) => {
      const x = list[i];
      t.ok(r.includes('data-tf-pick="' + side + '" value="' + x.pid + '"'), x.pid + ": a checkbox");
      t.ok(r.includes('<span class="fo-tf-gppg">' + p.H.fmt1(x.v) + "</span> PPG"), x.pid + ": season PPG");
      t.ok(r.includes('<span class="fo-tf-gnum">+' + p.H.fmt1(x.gain) + '</span> <span class="fo-tf-unit">pts/wk</span><div class="fo-tf-gsub">season PPG</div>'), x.pid + ": +gain pts/wk, season PPG");
      t.ok(unesc(r).includes("pts/week to " + title + " (season PPG)"), x.pid + ": whose lineup gains");
      t.ok(x.gain >= 1.0, x.pid + " ≥ 1.0");
    });
  }
  const nacua = P.mine.find((x) => x.pid === "16211");
  t.ok(nacua && html.includes('value="16211"'), "Puka Nacua (mine) shows his gain to The Long Haulers: +" + (nacua && nacua.gain));
  t.ok(!/trade for|in exchange|you could offer|they could offer|willing/i.test(unesc(html)), "no exchange or willingness wording");
  p.TR._openTeam("0008");
  t.ok(!/fo-tf-between|data-tf-pick/.test(p.dialog.open.html), "my own team's popup has no pair section");
});

test("copy to Trade builder: disabled with a reason without the builder's openDraft; with it, ticked players go in as an UNSENT draft", () => {
  const p = page();
  p.show({});
  p.TR._openTeam("0006");
  let c = p.TR._copyState();
  t.ok(!c.ok && /can’t take a copied draft yet/.test(c.why), "no openDraft → disabled, says why");
  t.ok(/data-tf-copy disabled>Copy to Trade builder \(not sent\)<\/button>/.test(p.dialog.open.html), "the button is rendered disabled");
  t.equal(p.TR._copy(), null, "and a forced copy does nothing");
  const calls = [];
  let answer = { ok: false, reason: "kept_current", dropped: [], clamped: [] };
  p.ctx.UPS_FO_TRADE_BUILDER = { mount: () => ({ refresh() {} }), openDraft: (d) => { calls.push(JSON.parse(JSON.stringify(d))); return answer; } };
  c = p.TR._copyState();
  t.ok(!c.ok && /Tick at least one player/.test(c.why), "openDraft present, nothing ticked → still disabled");
  const P = p.TFC.pairGains(p.TF.lineupGains(p.model, "0008"), "0006");
  p.TR._picks().theirs[P.theirs[0].pid] = true; p.TR._picks().mine["16211"] = true;
  c = p.TR._copyState();
  t.ok(c.ok && /Nothing is sent/.test(c.why), "ticked → enabled");
  const r1 = p.TR._copy();
  t.equal(calls.length, 1, "openDraft called once");
  t.equal(JSON.stringify(calls[0]), JSON.stringify({ source: "Trade finder", movements: [
    { from: "0008", to: "0006", tokens: ["P_16211"] }, { from: "0006", to: "0008", tokens: ["P_" + P.theirs[0].pid] }] }), "the #1419 draft: my player to them, theirs to me");
  t.ok(r1.ok === false && p.dialog.open, "the builder declined (owner kept the current draft) → the popup stays open, nothing switched");
  answer = { ok: true, dropped: [], clamped: [] };
  const host = { innerHTML: "", __tbHandle: null };
  p.el.querySelector = (q) => (q === "#fo-tb-host" && p.el.innerHTML.includes('id="fo-tb-host"') ? host : null);
  const r2 = p.TR._copy();
  t.ok(r2.ok && p.dialog.open === null, "accepted → the popup closes");
  t.ok(/data-tf-mode="builder" aria-pressed="true"/.test(p.el.innerHTML), "and Trades shows the builder");
  t.ok(!/fetch\(|method:\s*"POST"/.test(SRC), "the finder itself never sends");
});

await run("front_office_trade_finder");
