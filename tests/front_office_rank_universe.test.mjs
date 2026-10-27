// Front Office PPG ranks (#1338): a rank counts every player MFL scored at the position, free agents included —
// the phone's rule. Scores can arrive before MFL's players list; until the list is read no rank is shown, and a
// rank map built in that gap is never reused once it arrives (Market opened after Roster showed every free agent
// "unranked", and rostered players ranked among rostered players only).
//   node tests/front_office_rank_universe.test.mjs
//   FO_HUB_JS=<path> PLAYER_FACTS_JS=<path> node tests/front_office_rank_universe.test.mjs   (defect check)
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(p, "utf8");
const FX = JSON.parse(read(path.join(ROOT, "tests/fixtures/season_scoring_2026_wk7_qb_te_pk.json")));

function page() {
  const ctx = vm.createContext({ document: { addEventListener() {}, getElementById() { return null; } } });
  ctx.window = ctx;
  vm.runInContext(read(path.join(ROOT, "site/m/season_scoring.js")), ctx);
  vm.runInContext(read(path.join(ROOT, "site/m/front_office_lineup.js")), ctx);
  vm.runInContext(read(path.join(ROOT, "site/shared/trade_fit.js")), ctx);
  vm.runInContext(read(process.env.PLAYER_FACTS_JS || path.join(ROOT, "site/shared/player_facts.js")), ctx);
  vm.runInContext(read(process.env.FO_HUB_JS || path.join(ROOT, "site/rosters/v2/fo_hub.js")), ctx);
  const SS = ctx.UPS_MOBILE_SEASON_SCORING;
  const ss = SS.build(FX.playerScoresAll, { completedWeek: SS.completedWeekFrom(FX.lineup_week), season: 2026 });
  ss.season = 2026;
  const STARTERS = JSON.parse(read(path.join(ROOT, "tests/fixtures/mfl_league_starters_74598_2026.json"))).starters;
  const entries = { scores: { state: "ok", data: ss }, league: { state: "ok", data: { league: { starters: STARTERS } } } };
  ctx.UPS_FO_DATA = { get: (k) => entries[k] || null };
  // One team: Prescott (#14 QB league-wide), Penix (#20), Brissett (#21). Cousins (#7) is not on it.
  const teams = [{ fid: "0008", name: "Real Deal Creel", players: [
    { id: "12620", name: "Prescott, Dak", position: "QB" },
    { id: "16583", name: "Penix Jr., Michael", position: "QB" },
    { id: "12616", name: "Brissett, Jacoby", position: "QB" }] }];
  ctx.UPS_FO = { teams: () => teams };
  return { ctx, ss, entries, H: ctx.UPS_FO_HUB, F: ctx.UPS_PLAYER_FACTS, SS };
}
// The phone's rank, straight from its own module with MFL's full players list.
function truth(p) {
  const pos = {}; for (const x of FX.players.players.player) pos[x.id] = x.position;
  const L = p.ctx.UPS_FRONT_OFFICE_LINEUP;
  const g = (pid) => { const v = L.posGroup(String(pos[pid] || "").toUpperCase()); return v && v !== "OTH" ? v : ""; };
  return { map: p.SS.rankMap(p.ss.windowFor(0), g, p.ss.rankMinimum(0)), groupOf: g };
}

test("scores before the players list: no rank yet (never a rank among rostered players only)", () => {
  const p = page();
  const pres = p.H.seasonLine("12620", 4);
  t.ok(pres && pres.pts > 0, "points show as soon as scores are read");
  t.equal(pres.rank, null, "no rank while MFL's players list is unread");
  t.equal(pres.rankLabel, "…", "the rank reads as pending");
  t.ok(!pres.last || pres.last.rank === null, "no last-4 rank either");
});

test("once the players list arrives: rostered and free-agent ranks are the phone's, league-wide", () => {
  const p = page(), T = truth(p);
  p.H.seasonLine("12620", 4); p.H.seasonLine("7836", 4);           // views render in the gap first
  p.entries.players = { state: "ok", data: FX.players };
  for (const [pid, who] of [["12620", "Prescott"], ["16583", "Penix"], ["12616", "Brissett"], ["10700", "Cousins (free agent here)"]]) {
    const line = p.H.seasonLine(pid, 4);
    t.equal(line.rank, T.map[pid].rank, who + ": #" + T.map[pid].rank + " QB, as on the phone");
    t.equal(line.rankLabel, "#" + T.map[pid].rank + " QB");
  }
  t.equal(T.map["12620"].rank, 14, "fixture check: Prescott is #14 QB among every QB MFL scored");
});

test("the slide-over's own groupOf and the views' never share a rank map", () => {
  const p = page(), T = truth(p);
  const partial = (pid) => (pid === "12620" || pid === "16583" || pid === "12616" ? "QB" : "");
  t.equal(p.F.season(p.ss, "12620", partial).rank, 1, "a rostered-only universe would say #1");
  t.equal(p.F.season(p.ss, "12620", T.groupOf).rank, 14, "the full universe is not answered from that map");
  t.equal(p.F.season(p.ss, "10700", T.groupOf).rank, 7);
});

test("if the players list can't be read, ranks stay blank rather than wrong", () => {
  const p = page();
  p.entries.players = { state: "error", data: null };
  const line = p.H.seasonLine("12620", 4);
  t.equal(line.rank, null); t.equal(line.rankLabel, "—");
  t.ok(line.pts > 0, "points still show");
});

test("the league model is rebuilt once the players list arrives (no stale replacement level)", () => {
  const p = page();
  const before = p.H.leagueModel(0);
  t.ok(before, "a model can be built from scores (and MFL's lineup settings) alone");
  t.equal(before.repl.QB[0], 0, "no players list yet → no free agents → replacement level 0");
  p.entries.players = { state: "ok", data: FX.players };
  const after = p.H.leagueModel(0);
  t.ok(after !== before, "a new model, not the cached one");
  t.ok(after.repl.QB[0] > 0, "replacement QB from the free agents: " + after.repl.QB[0]);
  t.ok(p.H.leagueModel(0) === after, "and that one is reused while nothing changes");
});

test("the league model is never built on assumed slots: it waits for MFL's lineup settings, and an unreadable read is an error", () => {
  const p = page();
  const lg = p.entries.league;
  delete p.entries.league;
  t.equal(p.H.leagueModel(0), null, "no MFL settings yet → no model");
  t.equal(p.H.lineupSlotsState(), "", "reading");
  p.entries.league = { state: "error", data: null };
  t.equal(p.H.leagueModel(0), null); t.equal(p.H.lineupSlotsState(), "error", "unreadable → error, never the engine's default slots");
  p.entries.league = lg;
  const m = p.H.leagueModel(0);
  t.ok(m && m.slotSource === "mfl" && m.slots.length === 18, "with MFL's settings: 18 slots from MFL");
});

await run("front_office_rank_universe");
