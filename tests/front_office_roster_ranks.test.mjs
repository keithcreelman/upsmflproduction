// Front Office → Roster → Players (2026-10-28): a season-points rank and a last-4 rank beside the PPG rank (same universe and
// minimum, said on screen); Start / Boom / Bust from the worker's existing starter-pool model, read ONCE league-wide; one player
// cell in Performance, Contract and Schedule; and the same Active → IR → Taxi sections in all three.
//   node tests/front_office_roster_ranks.test.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { computeStarterRates, MIN_WEEKS } from "../worker/src/starter_rates.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const C = createRequire(import.meta.url)(path.join(ROOT, "site/shared/fo_roster_core.js"));
const RO = read("site/rosters/v2/fo_roster.js"), FO = read("site/rosters/v2/front_office.js"), HUB = read("site/rosters/v2/fo_hub.js"), DA = read("site/rosters/v2/fo_data.js");
const HTML = read("site/rosters/v2/front_office.html"), LD = read("site/rosters/fo_embed_loader.js");
const sliceFn = (src, sig) => { const a = src.indexOf(sig); const b = src.indexOf("\n  }\n", a); return src.slice(a, b); };

test("sections: active players by position, then IR, then Taxi; All players = Active, IR, Taxi; empty sections left out", () => {
  const P = (id, pos, x) => Object.assign({ id, pos }, x || {});
  const rows = [P("1", "WR"), P("2", "QB", { isTaxi: true }), P("3", "RB", { isIr: true }), P("4", "QB"), P("5", "XX"), P("6", "WR", { isTaxi: true }), P("7", "DL")];
  const by = C.sections(rows, { byPosition: true, posOf: (p) => p.pos });
  t.deepEqual(by.map((s) => s.label), ["QB", "WR", "DL", "Other", "IR", "Taxi"]);
  t.deepEqual(by.map((s) => s.rows.map((r) => r.id).join(",")), ["4", "1", "7", "5", "3", "2,6"], "IR and taxi players are in their own sections only; incoming order kept");
  const flat = C.sections(rows, { byPosition: false });
  t.deepEqual(flat.map((s) => [s.label, s.rows.length]), [["Active", 4], ["IR", 1], ["Taxi", 2]]);
  t.deepEqual(C.sections([P("1", "QB")], { byPosition: false }).map((s) => s.label), ["Active"], "no empty IR / Taxi sections");
  t.equal(C.statusOf({ isIr: true, isTaxi: true }), "ir", "IR wins if both were ever set (the Contract table's status rule)");
});

test("Performance, Contract and Schedule all use those sections and the same head markup and labels", () => {
  t.ok(/C\.sections\(rows, \{ byPosition: FO\.groupByPosition\(\) && !sort\.key/.test(RO), "Performance");
  t.ok(/UPS_FO_ROSTER_CORE\.sections\(items, \{ byPosition: grouped/.test(RO), "Schedule");
  t.ok(/C\.sections\(players, \{ byPosition: true, posOf: keyOf \}\)/.test(FO) && /C\.sections\(players, \{ byPosition: false \}\)/.test(FO), "Contract, by position and all players");
  t.ok(/renderGroupedRows\(sorted\) : renderStatusRows\(sorted\)/.test(FO), "Contract's all-players list is split too");
  t.ok(!/GROUP_ORDER\.concat\(\["Other", "Taxi", "IR"\]\)/.test(RO), "the old Taxi-before-IR order is gone");
  for (const [name, src] of [["Performance", RO], ["Contract", FO]]) t.ok(/<tr class="fo-group-row"><td colspan="(' \+ [a-z0-9A-Z]+ \+ '|13)"><span class="fo-pos ' \+ (H\.esc|escapeHtml)\((sec\.)?key\) \+ '">' \+ (H\.esc|escapeHtml)\((sec\.)?label\)/.test(src), name + ": same section head markup");
});

test("Contract keeps each position's cap line as before (non-taxi, IR included) and says how many are on IR", () => {
  const g = sliceFn(FO, "function renderGroupedRows(");
  t.ok(/if \(keyOf\(p\) !== sec\.key \|\| p\.isTaxi\) return;/.test(g) && /posSal \+= currentCapHit\(p\)/.test(g), "sum over the position's non-taxi players, IR at its cap hit");
  t.ok(/\(irN \? " \(" \+ irN \+ " on IR\)" : ""\)/.test(g), "the count names the IR players counted in it");
  t.ok(/positionAllocRank\(sec\.key/.test(g) && /positionAvgRank\(sec\.key/.test(g), "league ranks unchanged");
});

test("one player cell: Performance, Contract and Schedule print fo_hub.js playerCell inside a .fo-perf-player cell", () => {
  t.ok(/'<td class="fo-perf-player">' \+ H\.playerCell\(p, \{ multi: multiTeam \}\)/.test(RO), "Performance");
  t.ok(/class="fo-sched-who fo-perf-player">' \+ H\.playerCell\(p, \{ multi: multi \}\)/.test(RO), "Schedule");
  t.ok(/<td class="fo-perf-player">\$\{rosterPlayerCell\(p\)\}<\/td>/.test(FO) && /H\.playerCell\(p, \{ multi: STATE\.selectedTeamId === "__all__", chip: chip, news: newsFlagBadge\(p\.id\) \}\)/.test(FO), "Contract (its own resolved chip and news flag, the same markup)");
  // The helper itself, run: name button, chip, flag, "POS · TEAM" (· franchise only when every team is shown).
  const ctx = vm.createContext({ document: { addEventListener() {} } }); ctx.window = ctx;
  vm.runInContext(HUB, ctx);
  ctx.UPS_FO = { newsFlag: () => ' <span class="fo-news-flag">N</span>', injury: () => null };
  const H = ctx.UPS_FO_HUB, p = { id: "12620", fid: "0008", name: "Prescott, Dak", position: "QB", nflTeam: "DAL", franchise: "Real Deal Creel" };
  t.equal(H.playerCell(p, { multi: false, chip: '<span class="fo-inj">Q</span>' }),
    '<button type="button" class="fo-plink" data-fo-player="12620" data-fo-fid="0008">Prescott, Dak</button><span class="fo-inj">Q</span> <span class="fo-news-flag">N</span><div class="fo-muted fo-perf-sub">QB · DAL</div>');
  t.ok(/QB · DAL · Real Deal Creel<\/div>$/.test(H.playerCell(p, { multi: true })), "franchise when every team is shown");
  t.ok(/closest\("\.fo-news-flag"\)/.test(HUB) && /f\.openPlayer\(nb\.getAttribute\("data-fo-player"\), nb\.getAttribute\("data-fo-fid"\), "news"\)/.test(HUB), "the flag opens News in the hub views too");
});

test("points rank: the PPG rank's universe and minimum (every MFL-scored player at the lineup group, rankMinimum(0) wks), ordered by points", () => {
  const FX = JSON.parse(read("tests/fixtures/season_scoring_2026_wk7_qb_te_pk.json"));
  const ctx = vm.createContext({}); ctx.window = ctx;
  vm.runInContext(read("site/m/season_scoring.js"), ctx);
  vm.runInContext(read("site/m/front_office_lineup.js"), ctx);
  const SS = ctx.UPS_MOBILE_SEASON_SCORING, L = ctx.UPS_FRONT_OFFICE_LINEUP;
  const ss = SS.build(FX.playerScoresAll, { completedWeek: SS.completedWeekFrom(FX.lineup_week), season: 2026 });
  const pos = {}; for (const x of FX.players.players.player) pos[x.id] = x.position;
  const g = (pid) => { const v = L.posGroup(String(pos[pid] || "").toUpperCase()); return v && v !== "OTH" ? v : ""; };
  const min = ss.rankMinimum(0), stats = ss.windowFor(0);
  const ppg = SS.rankMap(stats, g, min), pts = C.pointsRankFor(ss, g);
  t.deepEqual(Object.keys(pts).sort(), Object.keys(ppg).sort(), "exactly the players the PPG rank ranks (" + Object.keys(ppg).length + ")");
  for (const grp of ["QB", "TE", "PK"]) {
    const list = Object.keys(pts).filter((pid) => pts[pid].group === grp).sort((a, b) => pts[a].rank - pts[b].rank);
    t.ok(list.length > 5, grp + " ranked");
    for (let i = 1; i < list.length; i++) t.ok(stats[list[i - 1]].pts >= stats[list[i]].pts, grp + " #" + i + " has at least #" + (i + 1) + "'s points");
  }
  const below = Object.keys(stats).filter((pid) => g(pid) && stats[pid].games < min);
  t.ok(below.length > 0 && below.every((pid) => !pts[pid]), "below the minimum: no points rank (" + below.length + " players)");
  t.equal(C.rankLabel(4, "RB", 6), "#4 RB"); t.equal(C.rankLabel(null, "RB", 2), "unranked"); t.equal(C.rankLabel(null, "RB", 0), "—");
  t.ok(C.pointsRankFor(ss, g) === pts, "one map per scoring read, not one per row");
});

test("the hub's season line carries the points rank and the L4 rank label, and withholds both until MFL's players list is read", () => {
  const FX = JSON.parse(read("tests/fixtures/season_scoring_2026_wk7_qb_te_pk.json"));
  const ctx = vm.createContext({ document: { addEventListener() {}, getElementById() { return null; } } }); ctx.window = ctx;
  for (const f of ["site/m/season_scoring.js", "site/m/front_office_lineup.js", "site/shared/trade_fit.js", "site/shared/player_facts.js", "site/shared/fo_roster_core.js", "site/rosters/v2/fo_hub.js"]) vm.runInContext(read(f), ctx);
  const SS = ctx.UPS_MOBILE_SEASON_SCORING;
  const ss = SS.build(FX.playerScoresAll, { completedWeek: SS.completedWeekFrom(FX.lineup_week), season: 2026 });
  const entries = { scores: { state: "ok", data: Object.assign(ss, { season: 2026 }) } };
  ctx.UPS_FO_DATA = { get: (k) => entries[k] || null };
  ctx.UPS_FO = { teams: () => [{ fid: "0008", players: [{ id: "12620", name: "Prescott, Dak", position: "QB" }] }] };
  const before = ctx.UPS_FO_HUB.seasonLine("12620", 4);
  t.equal(before.ptsRank, null); t.equal(before.ptsRankLabel, "…", "pending, never a rank among rostered players only");
  t.equal(before.last.rankLabel, "…");
  entries.players = { state: "ok", data: FX.players };
  const line = ctx.UPS_FO_HUB.seasonLine("12620", 4);
  t.ok(line.ptsRank > 0 && line.ptsRankLabel === "#" + line.ptsRank + " QB", "points rank " + line.ptsRankLabel);
  t.ok(line.rank > 0 && line.last && /^#\d+ QB$|^unranked$/.test(line.last.rankLabel), "PPG rank kept (" + line.rankLabel + "), L4 rank " + line.last.rankLabel);
});

test("Start / Boom / Bust: the model's own sufficiency rule decides; below it the cell says 'Not enough games'", () => {
  // The worker model, run on its own oracle league: every player it grades, through the Front Office's reader.
  const E = JSON.parse(read("tests/fixtures/starter_rates_cases.json")).end_to_end;
  const out = computeStarterRates(E.rows, { final_weeks: E.final_weeks, teams_with_game: E.teams_with_game, bye_week: E.bye_week });
  let ok = 0, few = 0;
  for (const [pid, rec] of Object.entries(out.players)) {
    const v = C.rateView(C.rateRecord(out, pid));
    if (rec.q >= MIN_WEEKS) { ok++; t.equal(v.state, "ok", pid); t.deepEqual([v.start.n, v.start.pct, v.boom.n, v.boom.pct, v.bust.n, v.bust.pct, v.q], [rec.startable_n, rec.startable_pct, rec.boom_n, rec.boom_pct, rec.bust_n, rec.bust_pct, rec.q], pid + ": the model's numbers, unchanged"); }
    else { few++; t.equal(v.state, "few", pid + " (" + rec.q + " graded)"); t.equal(v.q, rec.q); }
  }
  t.ok(ok > 0 && few > 0, ok + " graded, " + few + " not enough");
  t.equal(C.rateView(C.rateRecord(out, "99999")).state, "few", "no record (never on a UPS roster in a final week) = not enough games");
  t.equal(C.rateRecord({ players: { "123": { q: 1 } } }, "0123").q, 1, "MFL ids are matched as the worker keys them");
  t.equal(MIN_WEEKS, 3, "the on-screen '3+ graded weeks' matches the model");
  t.ok(/Needs 3\+ graded weeks, else “Not enough games”/.test(RO) && /Not enough games/.test(sliceFn(RO, "function rateCells(")), "legend and cell");
  t.ok(!/MIN_WEEKS|>= 3|q >= /.test(code(read("site/shared/fo_roster_core.js"))) && !/q >= /.test(code(RO)), "no threshold of our own: the model's null % is the rule");
});

test("ONE league-wide read of the existing route per visit: no group, no player, bounded to the points' last final week; no new D1 query", () => {
  const src = DA.match(/SOURCES\.starterRates = function \(through\) \{[\s\S]*?\n  \};/)[0];
  t.ok(/worker\("\/api\/player-starter-rates", \{ season: cfg\.season, through: through \}\)/.test(src), "the phone's route, this season, through the points' last final week");
  t.ok(!/group|mfl_id|pid/.test(src.replace(/^\s*\/\/.*$/gm, "")), "no group or player parameter");
  t.ok((code(RO).match(/DATA\.load\("starterRates", rs\.want\)/g) || []).length === 1 && (code(RO).match(/DATA\.load\("starterRates"/g) || []).length === 1, "one load, keyed by the through-week");
  t.ok(/if \(rs\.want && srAsked !== rs\.want\) \{ srAsked = rs\.want;/.test(RO), "asked for once per visit (per through-week)");
  t.ok(!/fetch\(/.test(code(RO)) && !/prepare\(|D1/.test(code(RO + read("site/shared/fo_roster_core.js"))), "the view fetches nothing itself; no database code");
});

test("Performance shows the new columns with on-screen labels and a visible legend (not hover-only)", () => {
  for (const [k, l] of [["ptsrank", "Pts rank"], ["rank", "PPG rank"], ["l4rank", "L4 rank"], ["start", "Start"], ["boom", "Boom"], ["bust", "Bust"]]) t.ok(RO.includes('th("' + k + '", "' + l + '"'), l);
  t.ok(/Ranks are among every MFL-scored player at the same lineup position, free agents too/.test(RO) && /"Pts and PPG ranks need " \+ ms \+ "\+ MFL wk"/.test(RO) && /"; L4 rank needs " \+ ml \+ "\+ of the last 4 final wks/.test(RO), "comparison group and minimums in the legend");
  t.ok(/Start = usable \(their median or better\), Boom = elite \(top quarter\), Bust = dud \(bottom quarter\)/.test(RO), "usable / elite / dud in words");
  t.ok(/var NCOL = 17;/.test(RO) && (RO.match(/\bth\("/g) || []).length === 17, "17 columns, every colspan uses NCOL");
});

test("the shared module loads before the hub in the page and in the MFL embed", () => {
  t.ok(HTML.indexOf("shared/fo_roster_core.js") > 0 && HTML.indexOf("shared/fo_roster_core.js") < HTML.indexOf("fo_hub.js"));
  t.ok(LD.indexOf('"shared/fo_roster_core.js"') > 0 && LD.indexOf('"shared/fo_roster_core.js"') < LD.indexOf('"rosters/v2/fo_hub.js"'));
});


test("Week split: each graded week once (Boom · Start only · Middle · Bust), adding up to the graded weeks; Boom is inside Start", () => {
  const E = JSON.parse(read("tests/fixtures/starter_rates_cases.json")).end_to_end;
  const out = computeStarterRates(E.rows, { final_weeks: E.final_weeks, teams_with_game: E.teams_with_game, bye_week: E.bye_week });
  for (const [pid, rec] of Object.entries(out.players)) {
    const v = C.rateView(rec); if (v.state !== "ok") continue;
    const sp = v.split, labs = rec.wk.map((w) => w[2]).filter((l) => ["boom", "bust", "startable", "below_median"].includes(l));
    t.equal(sp.boom + sp.startOnly + sp.middle + sp.bust, rec.q, pid + ": the four add up to the graded weeks");
    t.deepEqual([sp.boom, sp.startOnly, sp.middle, sp.bust], ["boom", "startable", "below_median", "bust"].map((l) => labs.filter((x) => x === l).length), pid + ": the model's own weekly labels, counted once each");
    t.ok(rec.boom_n <= rec.startable_n, pid + ": Boom is inside Start");
  }
  // Dak Prescott's recorded 2026 answer (Wks 1–7): Start 3, Boom 2, Bust 0 of 7 → 2 · 1 · 4 · 0.
  const dak = C.rateView({ q: 7, startable_n: 3, boom_n: 2, bust_n: 0, startable_pct: 43, boom_pct: 29, bust_pct: 0 });
  t.deepEqual([dak.split.boom, dak.split.startOnly, dak.split.middle, dak.split.bust], [2, 1, 4, 0]);
  t.equal(C.ratesThrough({ final_weeks: [1, 2, 3, 4, 5, 6, 7] }), 7); t.equal(C.ratesThrough({ final_weeks: [] }), 0);
  t.ok(/Every Boom week is also a Start week \(the top quarter is above the median\), so Start includes Boom/.test(RO), "the nesting is said on the page");
  t.ok(/Week split counts each graded week once: Boom · Start only · Middle \(below the median, not a Bust\) · Bust, adding up to his graded weeks/.test(RO));
});

test("same weeks or not shown: grades are asked through the points' last final week and shown only when periodMatch agrees", () => {
  const ss = (o) => Object.assign({ known: true, finalKnown: true, finalThrough: 6, seasonWeeks: [1, 2, 3, 4, 5, 6], finalWeeks: [1, 2, 3, 4, 5, 6], liveWeeks: [] }, o || {});
  const ans = (w) => ({ final_weeks: w });
  t.equal(C.gradeThrough(ss()), 6, "ask for Wks 1–6");
  t.equal(C.gradeThrough(ss({ finalKnown: false, finalThrough: 0 })), 0, "no final week: don't ask");
  t.deepEqual([C.periodMatch(ss(), ans([1, 2, 3, 4, 5, 6]), 6).ok, C.periodMatch(ss(), ans([1, 2, 3, 4, 5, 6]), 6).points], [true, "Wks 1–6"], "same weeks: shown");
  const beyond = C.periodMatch(ss(), ans([1, 2, 3, 4, 5, 6, 7]), 6);
  t.deepEqual([beyond.ok, beyond.reason, beyond.graded, beyond.points], [false, "beyond", "Wks 1–7", "Wks 1–6"], "the first preview: grades through Wk 7 beside points through Wk 6 → hidden (an answer that ignored the bound)");
  const live = C.periodMatch(ss({ seasonWeeks: [1, 2, 3, 4, 5, 6, 7], liveWeeks: [7] }), ans([1, 2, 3, 4, 5, 6]), 6);
  t.deepEqual([live.ok, live.reason, live.live], [false, "live", [7]], "a week in progress is in the points, not in the grades → hidden");
  const pend = C.periodMatch(ss(), ans([1, 2, 3, 4, 5]), 6);
  t.deepEqual([pend.ok, pend.reason, pend.missing], [false, "pending", [6]], "a final week not graded yet → hidden");
  t.equal(C.periodMatch(ss({ finalKnown: false, finalThrough: 0, finalWeeks: [] }), ans([]), 0).reason, "nofinal");
  t.ok(/rates: rs\.show \? C\.rateView/.test(RO) && /if \(!rs\.show\) return "";/.test(RO) && /\(rs\.show \? th\("start"/.test(RO), "rows, cells and headers only when shown");
  t.ok(/Start \/ Boom \/ Bust are hidden: /.test(RO) && /data-rates-hidden=/.test(RO), "the reason is said in words");
  t.ok(/data-legend="bases">Same weeks: Pts, PPG, ranks and Start \/ Boom \/ Bust all cover/.test(RO), "when shown, the page says they cover the same weeks");
  t.ok(/l\.games \+ " MFL wk"/.test(RO) && /basis = v\.q \+ " graded wk" \+ \(v\.q === 1 \? "" : "s"\) \+ \(thru \? " thru Wk " \+ thru : ""\)/.test(RO), "each count still names its basis");
});

test("news flag: a headline from the last 7 days only; a Sleeper status card (Milton, Strand: 'Out (Coach's Decision)') never flags; never 'injury'", () => {
  const at = Date.parse("2026-10-20T17:48:44.517Z");   // the recorded news read
  const milton = [{ type: "status", source: "Sleeper", timestamp: 1792338356, headline: "Injury Status: Out (Coach's Decision)" }, { type: "depth", source: "Sleeper", timestamp: 1792338356, headline: "Depth Chart: QB #3 on PHI" }];
  const strand = [{ type: "status", source: "Sleeper", timestamp: 1790292046, headline: "Injury Status: Out (Coach's Decision)" }, { type: "depth", source: "Sleeper", timestamp: 1790292046, headline: "Depth Chart: QB #4 on ATL" }];
  t.equal(C.newsFlagKind(milton, at), "", "Joe Milton: no flag");
  t.equal(C.newsFlagKind(strand, at), "", "Jack Strand: no flag");
  t.equal(C.newsFlagKind([{ type: "status", timestamp: at / 1000, headline: "Injury Status: Out (Hamstring)" }], at), "", "even a real injury status card is the chip's job, not the news flag's");
  t.equal(C.newsFlagKind([{ type: "headline", timestamp: at / 1000 - 3 * 86400 }], at), "news", "a 3-day-old headline flags, as news");
  t.equal(C.newsFlagKind([{ type: "headline", timestamp: at / 1000 - 8 * 86400 }], at), "", "an 8-day-old headline is stale");
  t.equal(C.newsFlagKind([{ type: "headline" }], at), "", "no date: no flag");
  t.equal(C.newsFlagKind([], at), ""); t.equal(C.newsFlagKind(null, at), "", "no items: no flag");
  t.equal(C.NEWS_DAYS, 7);
  const nf = sliceFn(FO, "function newsFlagBadge(");
  t.ok(!/🏥/.test(FO) && !/fo-news-flag-injury/.test(FO) && /📰/.test(nf), "the Front Office has no injury icon from news");
  t.ok(/C\.newsFlagKind\(ibp\[pid\], at\)/.test(FO) && /news\.meta\.generated_at/.test(FO), "flags come from the shared rule, dated by the news read");
});

await run("front_office_roster_ranks");
