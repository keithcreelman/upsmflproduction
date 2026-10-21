// Overview → Lineup strength breakdowns (#1338, Keith 2026-10-21). One modeled owned-roster lineup per team, in the
// slots MFL's league settings define, shown By Position (the Trade finder's numbers) and By Lineup Slot (the same
// lineup by the slot each starter fills: a second TE is Flex, a second QB is Superflex); every starter counts once and
// each breakdown reconciles to Overall. Slot baselines come from slot-eligible free agents. Starter Mix is the ACTUAL
// lineups submitted to MFL in completed weeks, by natural position; an incomplete or invalid week is named and left
// out, never averaged in silently.
//   node tests/lineup_breakdowns.test.mjs
//   TRADE_FIT_JS=<path> LINEUP_STRENGTH_JS=<path> STARTER_MIX_JS=<path> node tests/lineup_breakdowns.test.mjs   (defect check)
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(f, "utf8");
const ctx = vm.createContext({ document: { addEventListener() {}, getElementById() { return null; } }, Intl, Date });
ctx.window = ctx;
vm.runInContext(read(path.join(ROOT, "site/m/front_office_lineup.js")), ctx);
vm.runInContext(read(process.env.TRADE_FIT_JS || path.join(ROOT, "site/shared/trade_fit.js")), ctx);
vm.runInContext(read(process.env.LINEUP_STRENGTH_JS || path.join(ROOT, "site/shared/lineup_strength.js")), ctx);
vm.runInContext(read(process.env.STARTER_MIX_JS || path.join(ROOT, "site/shared/starter_mix.js")), ctx);
vm.runInContext(read(path.join(ROOT, "site/rosters/v2/fo_overview.js")), ctx);
const TF = ctx.UPS_TRADE_FIT, LS = ctx.UPS_LINEUP_STRENGTH, SM = ctx.UPS_STARTER_MIX, L = ctx.UPS_FRONT_OFFICE_LINEUP, OV = ctx.UPS_FO_OVERVIEW;
const FX = JSON.parse(read(path.join(ROOT, "tests/fixtures/trade_fit_2026_wk6.json")));
const STARTERS = JSON.parse(read(path.join(ROOT, "tests/fixtures/mfl_league_starters_74598_2026.json"))).starters;
const WEEKLY = JSON.parse(read(path.join(ROOT, "tests/fixtures/weekly_starters_2026_wk1_7.json")));
const SLOTS = TF.deriveSlots(STARTERS);
const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

// ── a small synthetic league: replacement levels QB 10, RB 7, WR 8, TE 5 (3rd-best free agent) ──
const FA = [];
const FAV = {};
function fa(pos, vals) { vals.forEach((v, i) => { const pid = "fa" + pos + i; FA.push({ pid, pos }); FAV[pid] = v; }); }
fa("QB", [12, 11, 10, 9, 8]); fa("RB", [9, 8, 7, 6, 5, 4, 3]); fa("WR", [10, 9, 8, 7, 6, 5, 4]); fa("TE", [7, 6, 5, 4, 3]);
fa("PK", [9, 8, 7, 6, 5, 4, 3]); fa("PN", [9, 8, 7, 6, 5, 4, 3]);
for (const g of ["DT", "LB", "CB"]) fa(g, Array.from({ length: 16 }, (_, i) => 12 - i * 0.5));
const CORE = [["QB", 20], ["RB", 15], ["RB", 14], ["WR", 16], ["WR", 13], ["TE", 10], ["PK", 8], ["PN", 6],
  ["DT", 9], ["DT", 8], ["LB", 9], ["LB", 8], ["CB", 9], ["CB", 8], ["CB", 7.5]];
function team(fid, players, opts = {}) {
  const list = (opts.core === false ? [] : CORE).concat(players);
  const values = {};
  const out = { fid, name: "Team " + fid, players: list.map(([pos, v], i) => { const pid = fid + "_" + i + pos; values[pid] = v; return { pid, pos, status: "ROSTER", chip: "" }; }) };
  return { team: out, values };
}
function league(teamsSpec) {
  const values = Object.assign({}, FAV);
  const teams = teamsSpec.map(([fid, players, opts]) => { const x = team(fid, players, opts); Object.assign(values, x.values); return x.team; });
  return TF.buildLeague({ teams, values, freeAgents: FA, slots: SLOTS });
}
const slotOf = (model, fid) => { const m = {}; for (const s of model.teams[fid].best.starters) m[s.slot] = s; return m; };
const pidAt = (model, fid, slot) => slotOf(model, fid)[slot].pid;

test("MFL's settings → the league's slots (QB 1-2, RB/WR 2-5, TE 1-4, K, P, DL/LB/DB 2-3; 18 starters, 7 IDP)", () => {
  t.ok(Array.isArray(SLOTS), "derived from MFL's starters node");
  t.equal(SLOTS.length, 18, "18 starting slots");
  const byId = Object.fromEntries(SLOTS.map((s) => [s.id, s]));
  for (const s of L.LINEUP_SLOTS) t.equal(byId[s.id] && byId[s.id].accepts.join("/"), s.accepts.join("/"), s.id + " matches the released engine (" + s.accepts.join("/") + ")");
  t.equal(SLOTS.filter((s) => s.row === "FLEX").length, 2, "two Flex (RB/WR/TE)");
  t.equal(SLOTS.filter((s) => s.row === "SFLEX").length, 1, "one Superflex (QB/RB/WR/TE)");
  t.equal(SLOTS.filter((s) => s.row === "DFLEX").length, 1, "one IDP Flex (DL/LB/DB)");
  // Not hard-coded: other MFL settings give other slots.
  const two = TF.deriveSlots({ count: "16", idp_starters: "6", position: [{ name: "QB", limit: "1" }, { name: "RB", limit: "2-4" }, { name: "WR", limit: "3-5" }, { name: "TE", limit: "1-3" },
    { name: "PK", limit: "1" }, { name: "PN", limit: "1" }, { name: "DT+DE", limit: "2" }, { name: "LB", limit: "2" }, { name: "CB+S", limit: "2" }] });
  t.equal(two.filter((s) => s.row === "FLEX").length, 1, "a 1-QB league: one Flex");
  t.equal(two.filter((s) => s.row === "SFLEX").length, 0, "and no Superflex");
  t.equal(two.filter((s) => s.row === "DFLEX").length, 0, "no IDP Flex when IDP has no room");
  t.equal(TF.deriveSlots({ count: "18", position: [{ name: "XX", limit: "1" }] }), null, "an unknown MFL position → no slots (the card says so), never a guess");
  t.equal(TF.deriveSlots(null), null);
});

test("MFL's slots build exactly the lineups the released engine builds (fillSlots = autoFillSlots), so nothing else moves", () => {
  const eng = TF.buildLeague({ teams: FX.teams, values: FX.values, freeAgents: FX.freeAgents });
  const mfl = TF.buildLeague({ teams: FX.teams, values: FX.values, freeAgents: FX.freeAgents, slots: SLOTS });
  t.equal(eng.slotSource, "engine"); t.equal(mfl.slotSource, "mfl");
  for (const fid of eng.order) {
    t.ok(close(eng.teams[fid].total, mfl.teams[fid].total), fid + " total");
    for (const g of TF.GROUPS) {
      t.ok(close(eng.teams[fid].strength[g], mfl.teams[fid].strength[g]), fid + " " + g + " strength");
      t.equal(eng.teams[fid].need[g], mfl.teams[fid].need[g], fid + " " + g + " need");
    }
    const a = {}, b = {};
    eng.teams[fid].best.starters.forEach((s) => (a[s.slot] = s.pid)); mfl.teams[fid].best.starters.forEach((s) => (b[s.slot] = s.pid));
    t.equal(JSON.stringify(Object.keys(a).sort().map((k) => [k, a[k]])), JSON.stringify(Object.keys(b).sort().map((k) => [k, b[k]])), fid + ": same player in every slot");
    const rows = FX.teams.find((x) => x.fid === fid).players.filter((p) => TF.availableNow(p)).map((p) => ({ id: p.pid, pos: p.pos, v: Number(FX.values[p.pid]) || 0 }));
    const mine = TF.fillSlots(rows, SLOTS, L), engine = L.autoFillSlots(rows, (r) => r.v || 0);
    t.equal(JSON.stringify(SLOTS.map((s) => [s.id, mine[s.id]])), JSON.stringify(SLOTS.map((s) => [s.id, engine[s.id]])), fid + ": fillSlots = autoFillSlots, slot by slot");
  }
  const pf = (m) => JSON.stringify(TF.pairFits(m, "0008", "0003", { limit: 20 }));
  t.equal(pf(eng), pf(mfl), "Trade finder swaps unchanged (Real Deal Creel × Gride)");
});

test("a second TE wins a Flex spot: TE By Position, Flex By Lineup Slot, once in Overall", () => {
  // Core TE 10; extras TE 12, RB 11, WR 9, QB 5. The better TE holds the TE slot; the other TE wins Flex.
  const m = league([["A", [["TE", 12], ["RB", 11], ["WR", 9], ["QB", 5]]], ["B", []]]);
  const te = (v) => m.teams.A.team.players.find((p) => p.pos === "TE" && m.values[p.pid] === v).pid;
  t.equal(pidAt(m, "A", "TE1"), te(12), "the 12-point TE holds the TE slot");
  t.ok([pidAt(m, "A", "OF1"), pidAt(m, "A", "OF2")].includes(te(10)), "the second (10-point) TE starts in Flex");
  const pos = LS.build(m), slot = LS.build(m, { by: "slot" });
  t.ok(close(pos.teams.A.TE.ppg, 22), "By Position: TE = 12 + 10");
  t.equal(pos.teams.A.TE.starters, 2);
  t.ok(close(slot.teams.A.TE.ppg, 12), "By Lineup Slot: TE = the TE slot only");
  t.ok(close(slot.teams.A.FLEX.ppg, 11 + 10), "By Lineup Slot: Flex = the third RB + the second TE");
  t.ok(close(slot.teams.A.SFLEX.ppg, 9), "Superflex = the third WR (the 5-point QB doesn't start)");
  t.ok(close(pos.teams.A.ALL.ppg, slot.teams.A.ALL.ppg) && close(pos.teams.A.ALL.ppg, m.teams.A.total), "Overall is the same lineup, counted once");
  t.ok(close(slot.teams.A.FLEX.above, (11 - 8) + (10 - 8)), "Flex baseline = the best RB/WR/TE replacement (WR 8), not TE's 5 or RB's 7");
  t.ok(close(pos.teams.A.TE.above, (12 - 5) + (10 - 5)), "By Position keeps TE's own baseline (5)");
});

test("a QB wins Superflex: QB By Position, Superflex By Lineup Slot", () => {
  const m = league([["A", [["QB", 18], ["RB", 11], ["WR", 12], ["TE", 4]]], ["B", []]]);
  const qb2 = m.teams.A.team.players.find((p) => p.pos === "QB" && m.values[p.pid] === 18).pid;
  t.equal(pidAt(m, "A", "SF1"), qb2, "the second QB starts in Superflex");
  const pos = LS.build(m), slot = LS.build(m, { by: "slot" });
  t.ok(close(pos.teams.A.QB.ppg, 38), "By Position: QB = 20 + 18");
  t.ok(close(slot.teams.A.QB.ppg, 20) && close(slot.teams.A.SFLEX.ppg, 18), "By Lineup Slot: QB 20, Superflex 18");
  t.ok(close(slot.teams.A.SFLEX.above, 18 - 10), "Superflex baseline = the best QB/RB/WR/TE replacement (QB 10)");
  t.equal(m.slotBase.SF1, 10); t.equal(m.slotBase.OF1, 8); t.equal(m.slotBase.QB1, 10); t.equal(m.slotBase.TE1, 5); t.equal(m.slotBase.DF1, Math.max(m.repl.DL[0], m.repl.LB[0], m.repl.DB[0]));
});

test("RB / WR / TE alternatives for Flex: the two best extras take Flex, the next takes Superflex unless a QB beats it", () => {
  const cases = [
    { extras: [["RB", 13], ["RB", 12], ["WR", 11]], flex: ["RB", "RB"], sf: "WR" },
    { extras: [["WR", 15], ["TE", 11], ["RB", 9]], flex: ["WR", "TE"], sf: "RB" },
    { extras: [["TE", 14], ["TE", 13], ["WR", 3], ["QB", 6]], flex: ["TE", "TE"], sf: "QB" },
    { extras: [["WR", 9], ["RB", 8]], flex: ["WR", "RB"], sf: "QB", note: "a thin roster: the free-agent QB fills Superflex only because no rostered player can" }
  ];
  for (const c of cases) {
    const m = league([["A", c.extras], ["B", []]]);
    const st = slotOf(m, "A");
    t.equal([st.OF1.group, st.OF2.group].join(","), c.flex.join(","), "Flex: " + c.flex.join(" + "));
    t.equal(st.SF1.group, c.sf, "Superflex: " + c.sf + (c.note ? " — " + c.note : ""));
    t.equal(!!st.SF1.rep, !!c.note, c.note ? "marked as a replacement (*)" : "a rostered player");
  }
});

test("no player is ever counted twice, and both breakdowns reconcile to Overall (real league, MFL's slots)", () => {
  const m = TF.buildLeague({ teams: FX.teams, values: FX.values, freeAgents: FX.freeAgents, slots: SLOTS });
  const pos = LS.build(m), slot = LS.build(m, { by: "slot" });
  t.equal(JSON.stringify(slot.rows), JSON.stringify(["ALL", "QB", "RB", "WR", "TE", "FLEX", "SFLEX", "DL", "LB", "DB", "DFLEX", "PK", "PN"]), "slot rows from MFL's settings");
  for (const fid of m.order) {
    const ids = m.teams[fid].best.starters.filter((s) => s.pid).map((s) => s.pid);
    t.equal(new Set(ids).size, ids.length, fid + ": each rostered starter in one slot");
    t.equal(m.teams[fid].best.starters.length, 18, fid + ": 18 starters");
    for (const tb of [pos, slot]) {
      const rows = tb.rows.filter((r) => r !== "ALL");
      t.equal(sum(rows.map((r) => tb.teams[fid][r].starters)), 18, fid + " " + tb.by + ": the rows hold all 18 starters once");
      t.ok(close(sum(rows.map((r) => tb.teams[fid][r].ppg)), tb.teams[fid].ALL.ppg), fid + " " + tb.by + ": rows' PPG add up to Overall");
      t.ok(close(sum(rows.map((r) => tb.teams[fid][r].above)), tb.teams[fid].ALL.above), fid + " " + tb.by + ": rows' above-replacement add up to Overall");
    }
    t.ok(close(pos.teams[fid].ALL.ppg, slot.teams[fid].ALL.ppg), fid + ": Overall PPG is the same in both");
    t.equal(pos.teams[fid].ALL.rank, slot.teams[fid].ALL.rank, fid + ": Overall rank the same");
    t.ok(close(pos.teams[fid].ALL.index, slot.teams[fid].ALL.index), fid + ": Overall index the same");
  }
});

test("Overview By Position and the Trade finder return identical positional values (one calculation, MFL's slots)", () => {
  const m = TF.buildLeague({ teams: FX.teams, values: FX.values, freeAgents: FX.freeAgents, slots: SLOTS });
  const tb = LS.build(m);
  for (const fid of m.order) for (const g of TF.GROUPS) {
    t.ok(close(tb.teams[fid][g].above, m.teams[fid].strength[g]), fid + " " + g + " above replacement = trade_fit strength");
    t.equal(Math.round(tb.teams[fid][g].vsMedian * 10) / 10, m.teams[fid].vsMedian[g], fid + " " + g + " vs median = the Trade finder's cell");
    t.equal(tb.teams[fid].need[g], m.teams[fid].need[g], fid + " " + g + " need");
  }
  const sl = LS.build(m, { by: "slot" });
  for (const fid of m.order) t.equal(sl.teams[fid].biggestNeed, tb.teams[fid].biggestNeed, fid + ": Biggest need stays by natural position in the slot view");
});

test("a replacement free agent appears only for a slot the roster genuinely can't fill", () => {
  // A has no TE at all; B has a 1-point TE while free-agent TEs score 5–7; C has no kicker.
  const m = league([
    ["A", [["RB", 11], ["WR", 9], ["QB", 6]], { core: true }],
    ["B", [["TE", 1], ["RB", 11], ["WR", 9], ["QB", 6]]],
    ["C", [["TE", 4], ["RB", 11], ["WR", 9], ["QB", 6]]]
  ]);
  // Remove A's TE and C's kicker.
  const strip = (fid, pos) => { const tm = m.teams[fid].team; tm.players = tm.players.filter((p) => p.pos !== pos); };
  strip("A", "TE"); strip("C", "PK");
  const m2 = TF.buildLeague({ teams: [m.teams.A.team, m.teams.B.team, m.teams.C.team], values: m.values, freeAgents: FA, slots: SLOTS });
  const repA = m2.teams.A.best.starters.filter((s) => s.rep), repB = m2.teams.B.best.starters.filter((s) => s.rep), repC = m2.teams.C.best.starters.filter((s) => s.rep);
  t.equal(repA.map((s) => s.slot).join(","), "TE1", "A: only the TE slot (no TE on the roster)");
  t.equal(repA[0].v, 5, "at the replacement TE (the 3rd-best free-agent TE), never a better one");
  t.equal(repB.length, 0, "B starts its own 1-point TE, never a better free agent");
  t.equal(repC.map((s) => s.slot).join(","), "PK1", "C: only the kicker");
  const slot = LS.build(m2, { by: "slot" });
  t.equal(slot.teams.A.TE.replacementStarters, 1, "the slot view marks the TE slot *");
  t.equal(slot.teams.A.FLEX.replacementStarters, 0, "and nothing else");
  t.equal(slot.teams.A.replacementSlots[0].slotRow, "TE");
});

// ── Actual starter mix ──
function wk(week, lineups) {
  return { week: String(week), matchup: [{ franchise: Object.entries(lineups).map(([id, st]) => ({ id, starters: st.map((x) => x[0]).join(",") + ",",
    player: st.map(([pid, sc]) => ({ id: pid, score: String(sc) })) })) }] };
}
const BASE = [["q1", 20], ["r1", 15], ["r2", 12], ["w1", 14], ["w2", 11], ["t1", 9], ["k", 8], ["p", 6], ["d1", 5], ["d2", 4], ["l1", 6], ["l2", 5], ["b1", 7], ["b2", 6]];
const POS = { q1: "QB", q2: "QB", q3: "QB", r1: "RB", r2: "RB", r3: "RB", w1: "WR", w2: "WR", w3: "WR", w4: "WR", t1: "TE", t2: "TE", k: "PK", p: "PN",
  d1: "DT", d2: "DE", l1: "LB", l2: "LB", b1: "CB", b2: "S", b3: "S" };
const grp = (pid) => { const g = L.posGroup(POS[pid] || ""); return g === "OTH" ? "" : g; };
const threeRb = BASE.concat([["r3", 10], ["w3", 8], ["q2", 13], ["b3", 3]]);
const twoRb = BASE.concat([["w3", 10], ["w4", 9], ["q2", 13], ["b3", 3]]);

test("actual starter mix: averages over completed weeks give fractional starters, e.g. 2.4 RBs a week", () => {
  const json = { allWeeklyResults: { weeklyResults: [wk(1, { "0001": threeRb }), wk(2, { "0001": threeRb }), wk(3, { "0001": twoRb }), wk(4, { "0001": twoRb }), wk(5, { "0001": twoRb }),
    wk(6, { "0001": [] })] } };
  const mix = SM.build({ weeklyResults: json, completedWeek: 5, slots: SLOTS, groupOf: grp });
  const a = mix.teams["0001"];
  t.equal(a.validWeeks.join(","), "1,2,3,4,5", "Week 6 is not completed, so it isn't read");
  t.ok(close(a.avg.RB, 2.4), "RB: (3+3+2+2+2)/5 = 2.4 a week");
  t.ok(close(a.avg.WR, 3.6), "WR: (3+3+4+4+4)/5 = 3.6");
  t.ok(close(a.avg.QB, 2), "QB: 2 a week (Superflex QB every week)");
  t.ok(close(sum(SM.GROUPS.map((g) => a.avg[g])), 18), "the weekly totals reconcile to the 18 required starters");
  t.equal(JSON.stringify(SM.mixList(a.mix.FLEX).map((x) => [x.g, x.n])), JSON.stringify([["WR", 8], ["RB", 2]]), "Flex: WR 8 of 10 starts, RB 2 of 10");
  t.ok(close(SM.mixList(a.mix.FLEX)[0].pct, 80), "Flex: 80% WR · 20% RB");
  const thirds = SM.mixList({ total: 3, by: { WR: 1, RB: 1, TE: 1 } });
  t.equal(sum(thirds.map((x) => x.whole)), 100, "shown whole percents always add to 100 (34/33/33, never 99)");
  t.equal(SM.mixList(a.mix.SFLEX).map((x) => x.g + " " + x.pct).join(","), "QB 100", "Superflex: 100% QB");
});

test("an incomplete or invalid week is named and left out — never silently averaged", () => {
  const short = threeRb.slice(0, 17);
  const threeQb = BASE.concat([["q2", 13], ["q3", 12], ["w3", 8], ["b3", 3]]);
  const json = { allWeeklyResults: { weeklyResults: [wk(1, { "0001": threeRb }), wk(2, { "0001": short }), wk(3, { "0001": threeQb }), wk(4, { "0001": twoRb }),
    wk(5, { "0001": twoRb.concat([["zz", 1]]).slice(1) })] } };
  const mix = SM.build({ weeklyResults: json, completedWeek: 6, slots: SLOTS, groupOf: grp, fids: ["0001"] });
  const a = mix.teams["0001"];
  t.equal(a.weeks, 6, "6 completed weeks");
  t.equal(a.validWeeks.join(","), "1,4", "only the two complete, legal lineups count");
  const byWeek = Object.fromEntries(a.issues.map((x) => [x.week, x.text]));
  t.equal(byWeek[2], "17 of 18 starters", "Week 2: 17 of 18 starters");
  t.ok(/^3 QB — more than the lineup allows/.test(byWeek[3]), "Week 3: three QBs: " + byWeek[3]);
  t.ok(/unknown position/.test(byWeek[5]), "Week 5: a starter with an unknown position: " + byWeek[5]);
  t.equal(byWeek[6], "no lineup", "Week 6: no lineup on file");
  t.ok(close(a.avg.RB, 2.5), "averages over the 2 counted weeks only (3 and 2 RBs → 2.5), and the card shows 2 of 6");
  // MFL repeats a franchise once per game; two different copies are flagged.
  const conflict = { weeklyResults: { week: "1", matchup: [{ franchise: [{ id: "0001", starters: twoRb.map((x) => x[0]).join(","), player: [] }] },
    { franchise: [{ id: "0001", starters: threeRb.map((x) => x[0]).join(","), player: [] }] }] } };
  const c = SM.build({ weeklyResults: conflict, completedWeek: 1, slots: SLOTS, groupOf: grp });
  t.ok(/two different lineups/.test(c.teams["0001"].issues[0].text), "two different copies of a week's lineup → named");
});

test("real league, Weeks 1–6 (Week 7 in progress is not read): every lineup is complete and reconciles to 18", () => {
  const mix = SM.build({ weeklyResults: WEEKLY, completedWeek: 6, slots: SLOTS, groupOf: (pid) => { const g = L.posGroup(WEEKLY.positions[pid] || ""); return g === "OTH" ? "" : g; } });
  t.equal(Object.keys(mix.teams).length, 12, "12 teams");
  for (const fid of Object.keys(mix.teams)) {
    const a = mix.teams[fid];
    t.equal(a.validWeeks.length, 6, fid + ": 6 of 6 weeks counted");
    t.ok(close(sum(SM.GROUPS.map((g) => a.avg[g])), 18), fid + ": 18 starters a week");
    t.equal(a.mix.FLEX.total, 12, fid + ": 2 Flex × 6 weeks"); t.equal(a.mix.SFLEX.total, 6); t.equal(a.mix.DFLEX.total, 6);
  }
  const rdc = mix.teams["0008"];
  t.equal([rdc.avg.QB, rdc.avg.RB, rdc.avg.WR, rdc.avg.TE].map((x) => x.toFixed(2)).join(" "), "2.00 2.17 3.67 1.17", "Real Deal Creel: QB 2.0, RB 2.2, WR 3.7, TE 1.2");
  t.equal(SM.mixList(rdc.mix.SFLEX).map((x) => x.g).join(","), "QB", "Real Deal Creel: Superflex always a QB");
  const ham = mix.teams["0005"];
  t.equal(SM.mixList(ham.mix.FLEX)[0].g, "TE", "HammerTime: Flex mostly TE");
  t.ok(close(SM.mixList(ham.mix.SFLEX).find((x) => x.g === "QB").pct, 400 / 6), "HammerTime: Superflex 67% QB");
});

test("the Overview card: PPG first and selected, Above Replacement spelled out, three breakdowns, Starter Mix labeled Actual", () => {
  const m = TF.buildLeague({ teams: FX.teams, values: FX.values, freeAgents: FX.freeAgents, slots: SLOTS });
  const esc = (x) => String(x == null ? "" : x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const ss = { finalKnown: true, finalThrough: 6, fetchedAt: 1 };
  const entries = { weeklyResults: { state: "ok", at: 1, data: WEEKLY }, players: { state: "ok", at: 1 } };
  const deps = {
    H: { esc, fmt1: (v) => (Math.round(v * 10) / 10).toFixed(1), banner: (x) => x, goLink: () => "", leagueModel: () => m, lineupSlots: () => SLOTS, lineupSlotsState: () => "ok",
      scoring: () => ss, playerGroup: (pid) => { const g = L.posGroup(WEEKLY.positions[pid] || ""); return g === "OTH" ? "" : g; } },
    FO: { teams: () => FX.teams },
    DATA: { get: (k) => entries[k] || null, load: () => ({ then() {} }) }
  };
  const html = OV._strengthCard("0008", deps, "position", "ppg");
  const chips = [...html.matchAll(/data-ls-view="(\w+)"[^>]*>([^<]+)</g)].map((x) => x[2]);
  t.equal(chips.join(" | "), "PPG | Rank | Above Replacement | Index", "measure order");
  t.ok(/data-ls-view="ppg" aria-pressed="true"/.test(html), "PPG selected");
  t.equal([...html.matchAll(/data-ls-by="(\w+)"[^>]*>([^<]+)</g)].map((x) => x[2]).join(" | "), "By Position | By Lineup Slot | Starter Mix");
  t.equal([...html.matchAll(/data-ls-row="(\w+)"/g)].map((x) => x[1]).join(","), "ALL,QB,RB,WR,TE,DL,LB,DB,PK,PN", "By Position rows");
  const bySlot = OV._strengthCard("0008", deps, "slot", "above");
  t.equal([...bySlot.matchAll(/data-ls-row="(\w+)"/g)].map((x) => x[1]).join(","), "ALL,QB,RB,WR,TE,FLEX,SFLEX,DL,LB,DB,DFLEX,PK,PN", "By Lineup Slot rows");
  t.ok(/>Superflex</.test(bySlot) && />IDP Flex</.test(bySlot), "slot labels");
  t.ok(/Biggest need: <b>/.test(bySlot) || !m.teams["0008"].need, "Biggest need still shown (by position)");
  const mixHtml = OV._strengthCard("0008", deps, "mix");
  t.ok(/<b>Actual starter mix<\/b> · Weeks 1–6 · 6 of 6 weeks counted/.test(mixHtml), "labeled Actual starter mix, with the weeks counted");
  t.ok(!/data-ls-view/.test(mixHtml), "no strength measures on the actual mix");
  t.ok(/data-ls-flex="SFLEX"><b>Superflex:<\/b> 100% QB/.test(mixHtml), "Real Deal Creel Superflex: 100% QB");
  t.ok(/<b>Flex:<\/b> 84% WR · 8% RB · 8% TE/.test(mixHtml), "Flex composition: 10, 1 and 1 of 12 starts, shown in whole percents that add to 100");
  deps.H.lineupSlotsState = () => "error";
  t.ok(/lineup settings couldn’t be read/.test(OV._strengthCard("0008", deps, "position", "ppg")), "MFL's settings unreadable → says so, no assumed slots");
});

await run("lineup_breakdowns");
