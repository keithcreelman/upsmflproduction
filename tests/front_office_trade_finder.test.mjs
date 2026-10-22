// Front Office → Trade finder (#1338, Keith 2026-10-22). The all-team lineup-strength table is the feature: the
// Overview's card for all 12 teams with the same controls (By Position / By Lineup Slot; PPG / Rank / Above
// Replacement / Index), the same default (By Position, PPG) and the same numbers for the same view. Starter Mix is a
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
  for (const f of ["site/m/front_office_lineup.js", "site/shared/trade_fit.js", "site/shared/lineup_strength.js", "site/shared/starter_mix.js"]) vm.runInContext(read(path.join(ROOT, f)), ctx);
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
    openDialog: (title, html, opts) => { dialog.open = { title, html, opts }; } };
  const FO = { viewerFid: () => viewer, teams: () => FX.teams, capCeiling: 300000,
    capFor: (f) => ({ capSpace: FX.capRoom[f], capAlloc: 300000 - FX.capRoom[f] }), warRoomUrl: (o) => "#war-room?" + Object.entries(o).map(([k, v]) => k + "=" + v).join("&") };
  const DATA = { get: (k, a) => entries[a != null ? k + ":" + a : k] || null, load: () => ({ then() {} }) };
  Object.assign(ctx, { UPS_FO_HUB: H, UPS_FO: FO, UPS_FO_DATA: DATA });
  vm.runInContext(SRC, ctx);
  (listeners["fo:ready"] || []).forEach((f) => f());
  // The Overview card is rendered through its own test seam (its boot needs the full page).
  vm.runInContext(read(path.join(ROOT, "site/rosters/v2/fo_overview.js")), ctx);
  const TR = ctx.UPS_FO_TRADES;
  const show = (state) => { Object.assign(TR._view, state.view || {}); if ("team" in state) TR._sel.team = state.team; (listeners["fo:tab"] || []).forEach((f) => f({ detail: { section: "trades" } })); return el.innerHTML; };
  const team = (f) => TR._teamHtml(f);
  return { ctx, TF, LS, SM, model, slots, mix, show, team, dialog, TR, H, FO, DATA, OV: ctx.UPS_FO_OVERVIEW };
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

test("default = the Overview's default (By Position, PPG); same controls in the same order", () => {
  const p = page();
  const html = p.show({});
  t.equal([...html.matchAll(/data-tf-by="(\w+)"[^>]*>([^<]+)</g)].map((x) => x[2]).join(" | "), "By Position | By Lineup Slot | Starter Mix");
  t.equal([...html.matchAll(/data-tf-measure="(\w+)"[^>]*>([^<]+)</g)].map((x) => x[2]).join(" | "), "PPG | Rank | Above Replacement | Index");
  t.ok(/data-tf-by="position" aria-pressed="true"/.test(html) && /data-tf-measure="ppg" aria-pressed="true"/.test(html), "By Position + PPG selected");
  t.ok(/var lsView = "ppg"/.test(read(path.join(ROOT, "site/rosters/v2/fo_overview.js"))) && /var lsBy = "position"/.test(read(path.join(ROOT, "site/rosters/v2/fo_overview.js"))), "and that is the Overview's default");
});

test("every cell equals the Overview card for the same team and view (both breakdowns × all four measures × 12 teams)", () => {
  const p = page();
  let n = 0;
  for (const by of ["position", "slot"]) for (const measure of ["ppg", "rank", "above", "index"]) {
    const { cells, order } = readTable(p.show({ view: { by, measure, sort: "ALL" } }));
    t.equal(order.length, 12, by + "/" + measure + ": 12 teams, each with a View button");
    for (const fid of order) {
      const card = p.OV._strengthCard(fid, { H: p.H, FO: p.FO, DATA: p.DATA }, by, measure);
      const bars = Object.fromEntries([...card.matchAll(/data-ls-row="(\w+)"[\s\S]*?fo-ov-bar-val">([^<]*)</g)].map((x) => [x[1], unesc(x[2])]));
      for (const r of Object.keys(bars)) { t.equal(cells[fid][r], bars[r], by + "/" + measure + " " + fid + " " + r + " = Overview"); n += 1; }
    }
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

test("one addition, modeled: the typical starter's PPG, where he'd start, who'd leave, lineup before → after", () => {
  const p = page();
  const tb = p.LS.build(p.model);
  let checked = 0, flexFromTop = 0;
  for (const f of p.model.order) {
    const html = p.team(f);
    for (const g of ["QB", "RB", "WR", "TE", "DL", "LB", "DB"]) {
      const gain = tb.teams[f].need[g];
      if (gain < 1) continue;
      const d = p.TF.additionDetail(p.model, f, g);
      t.equal(Math.round(d.gain * 10) / 10, gain, f + " " + g + ": the detail's gain is the table's");
      t.ok(Math.abs(d.after - d.before - d.gain) < 1e-9 && d.starts, f + " " + g + ": after − before = gain; he starts");
      t.equal(d.leaves.length, 1, f + " " + g + ": exactly one starter leaves the lineup");
      const s = "A typical " + g + " (" + (Math.round(d.typical * 10) / 10).toFixed(1) + " PPG, the league’s median starting " + g + ") would start at " + d.slotLabel;
      if (html.indexOf("<b>" + g + " +" + gain.toFixed(1) + " pts/wk</b>") !== -1) {
        t.ok(html.includes(esc(s)), f + " " + g + ": where he'd start");
        t.ok(html.includes("Lineup " + (Math.round(d.before * 10) / 10).toFixed(1) + " → " + (Math.round(d.after * 10) / 10).toFixed(1) + " pts a week (+" + gain.toFixed(1) + ")"), f + " " + g + ": before → after");
        if (tb.teams[f][g].rank <= 3) { flexFromTop += 1; t.ok(html.includes("ranks " + p.LS.ordinal(tb.teams[f][g].rank) + " — the gain comes from the " + esc(d.slotLabel) + " spot"), f + " " + g + ": a top-ranked position's gain is explained by its slot"); }
        checked += 1;
      }
    }
  }
  t.ok(checked >= 12, checked + " gains described");
  t.ok(flexFromTop >= 1, "at least one top-3 position with a gain (the Flex case) is explained, not called weak");
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

test("Biggest gain column: a gain, not a weakness, with the addition's sentence in its tooltip; the League average row is the reference", () => {
  const p = page();
  const html = p.show({ view: { by: "position", measure: "ppg", sort: "ALL" } });
  t.ok(/>Biggest gain<\/th>/.test(html) && !/Biggest need/.test(html), "column named Biggest gain");
  t.ok(/A potential gain, not a weakness/.test(html), "header says so");
  const tb = p.LS.build(p.model);
  const row = html.slice(html.indexOf('data-tf-team="0008"'), html.indexOf("</tr>", html.indexOf('data-tf-team="0008"')));
  const g = tb.teams["0008"].biggestGain;
  t.ok(row.includes("<b>" + g + '</b> <span class="fo-muted">+' + tb.teams["0008"].need[g].toFixed(1)), "0008: " + g + " +" + tb.teams["0008"].need[g]);
  t.ok(/title="A typical \w+ \([\d.]+ PPG, the league’s median starting \w+\) would start at [^"]+Lineup [\d.]+ → [\d.]+ pts a week/.test(row), "tooltip: where he'd start and the lineup before → after");
  const foot = html.slice(html.indexOf("<tfoot>"), html.indexOf("</tfoot>"));
  t.ok(/League average<\/th>/.test(foot) && foot.includes('<td class="num">' + (Math.round(tb.league.ALL.meanPpg * 10) / 10).toFixed(1) + "</td>"), "PPG: the league-average row (outside the sorted body)");
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
  const order = [...html.matchAll(/<tbody>[\s\S]*?<\/tbody>/g)][0][0].match(/data-tf-team="(\d{4})"/g).map((x) => x.slice(14, 18));
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

await run("front_office_trade_finder");
