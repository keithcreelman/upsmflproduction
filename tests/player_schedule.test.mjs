// Player schedule (site/shared/player_schedule.js): the rules behind Front Office → Roster → Players → Schedule, on the REAL
// /api/fantasy-sos?season=2026&v=2 answer recorded 2026-10-13 (Wks 1-5 final) and the finished 2025 answer.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const S = require("../site/shared/player_schedule.js");
const FX = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/sched_v2_2026_10_13.json"), "utf8"));
const D26 = FX.v2_2026, D25 = FX.v2_2025;
const clone = (o) => JSON.parse(JSON.stringify(o));

test("weeks: default is the NEXT FIVE league weeks starting at the first week not final; Rest of season runs to the last league week", () => {
  t.equal(S.nowWeek(D26), 6);
  t.equal(JSON.stringify(S.weekList(D26).weeks), JSON.stringify([6, 7, 8, 9, 10]));
  t.equal(JSON.stringify(S.weekList(D26, "next5").weeks), JSON.stringify([6, 7, 8, 9, 10]));
  const rest = S.weekList(D26, "rest").weeks; t.equal(rest[0], 6); t.equal(rest[rest.length - 1], 17); t.equal(rest.length, 12);
  t.ok(S.weekList(D26, "rest").weeks.every((w) => w <= 17), "league weeks only, no NFL Week 18");
});
test("weeks near the end stop at the last league week; a finished or not-started season is said plainly", () => {
  const late = clone(D26); late.season.weeks = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [i + 1, i + 1 < 15 ? "final" : "scheduled"]));
  t.equal(JSON.stringify(S.weekList(late).weeks), JSON.stringify([15, 16, 17]), "only three weeks left, not five");
  const done = S.weekList(D25); t.equal(done.weeks.length, 0); t.ok(/complete/.test(done.note), done.note);
  const pre = clone(D26); pre.season.state = "preseason"; t.equal(JSON.stringify(S.weekList(pre).weeks), JSON.stringify([1, 2, 3, 4, 5]));
  const allFinal = clone(D26); allFinal.season.weeks = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [i + 1, "final"]));
  t.ok(/final/.test(S.weekList(allFinal).note));
});
test("a player's rows: opponent, home/away, kickoff and the opponent's numbers at HIS position, from the one answer", () => {
  const r = S.playerRows(D26, { nflTeam: "DEN", group: "QB" }, S.weekList(D26).weeks);
  t.equal(r.state, "ok"); t.equal(r.cells.length, 5);
  const wk6 = r.cells[0];
  t.equal(wk6.kind, "game"); t.equal(wk6.opp, D26.teamGames.DEN.next.opp); t.equal(wk6.home, D26.teamGames.DEN.next.home); t.equal(wk6.kickoffMs, D26.teamGames.DEN.next.kickoff * 1000);
  // the opponent's QB numbers are the answer's own
  const opp = D26.teams[wk6.opp].QB;
  t.equal(wk6.allowed.perGame, opp.raw.perGame); t.equal(wk6.allowed.ratio, opp.adj.ratio); t.equal(wk6.allowed.rank, opp.adj.rank); t.equal(wk6.allowed.of, opp.adj.of);
  // a different position reads that position's numbers for the same opponent
  const rb = S.playerRows(D26, { nflTeam: "DEN", group: "RB" }, [6]).cells[0];
  t.equal(rb.allowed.perGame, D26.teams[rb.opp].RB.raw.perGame);
});
test("byes are shown in place (ARI's bye is Wk 14; the next five and rest-of-season both keep it)", () => {
  const r = S.playerRows(D26, { nflTeam: "ARI", group: "WR" }, S.weekList(D26, "rest").weeks);
  const bye = r.cells.filter((c) => c.kind === "bye");
  t.equal(bye.length, 1); t.equal(bye[0].wk, 14);
  const win = S.playerRows(D26, { nflTeam: "ARI", group: "WR" }, [12, 13, 14, 15, 16]).cells;
  t.equal(win.length, 5, "a bye inside the window still takes its place (five weeks, not five games)"); t.equal(win[2].kind, "bye");
});
test("missing data is plain: no NFL team, a position outside the nine, a team not in the answer, a week with no listed game, an opponent with no number", () => {
  t.equal(S.playerRows(D26, { nflTeam: "", group: "QB" }, [6]).state, "no_team");
  t.equal(S.playerRows(D26, { nflTeam: "DEN", group: "OTH" }, [6]).state, "no_pos");
  t.equal(S.playerRows(D26, { nflTeam: "XXX", group: "QB" }, [6]).state, "no_sched");
  const d = clone(D26); d.schedule.DEN = d.schedule.DEN.filter((g) => g.wk !== 7);
  t.equal(S.cell(d, "DEN", 7, "QB").kind, "none");
  const oppTeam = S.cell(D26, "DEN", 6, "QB").opp; const e = clone(D26); delete e.teams[oppTeam].QB;
  const c = S.cell(e, "DEN", 6, "QB"); t.equal(c.kind, "game"); t.equal(c.allowed, null, "the game still shows; the number is missing, not 0");
  const parts = S.allowedParts(null); t.equal(parts.pg, ""); t.equal(parts.vs, ""); t.equal(parts.rank, "");
});
test("zero is a real number: 0.0 per game and 0% are shown; only a missing value is blank", () => {
  const p = S.allowedParts({ perGame: 0, ratio: 1, rank: 16, of: 32 });
  t.equal(p.pg, "0.0 per game"); t.equal(p.vs, "0% vs usual"); t.equal(p.rank, "16th of 32");
  t.equal(S.allowedParts({ perGame: 12.34, ratio: 0.8, rank: 27, of: 32 }).vs, "−20% vs usual");
  t.equal(S.allowedParts({ perGame: 25, ratio: 1.67, rank: 1, of: 32 }).rank, "1st of 32");
});
test("the basis says what the numbers cover (through-week), and says so plainly before any game is played", () => {
  const b = S.basis(D26); t.equal(b.label, "Wks 1–5"); t.equal(b.through, 5); t.equal(b.none, false);
  const none = clone(D26); none.weeksUsed = []; t.equal(S.basis(none).none, true);
  t.equal(S.basis(D25).through, D25.weeksUsed[D25.weeksUsed.length - 1]);
});
test("kickoff is shown in Eastern time", () => {
  t.equal(S.kickoffLabel(Date.UTC(2026, 9, 18, 17, 0)), "Sun 1:00p");     // Oct 18 2026, 17:00Z = 1:00 PM EDT
  t.equal(S.kickoffLabel(Date.UTC(2026, 10, 30, 1, 20)), "Sun 8:20p");    // Nov 30 01:20Z = Sun Nov 29 8:20 PM EST
  t.equal(S.kickoffLabel(0), ""); t.equal(S.kickoffLabel(null), "");
});
test("no forecast or easy/tough words anywhere in the module", () => {
  const src = fs.readFileSync(path.join(ROOT, "site/shared/player_schedule.js"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");   // code and strings only, not the comments that disclaim the words
  t.ok(!/\b(easy|easier|tough|tougher|smash|avoid)\b/i.test(src), "no easy/tough wording in strings");
});

test("color is decided by the number PRINTED in the cell: +10% or more is green, -10% or more is red, within 9% is neutral", () => {
  const a = (ratio, games) => ({ ratio, games });
  t.equal(S.tone(a(1.10, 5)), "more"); t.equal(S.tone(a(0.90, 5)), "less");
  t.equal(S.tone(a(1.09, 5)), "none"); t.equal(S.tone(a(0.91, 5)), "none"); t.equal(S.tone(a(1, 5)), "none");
  t.equal(S.tone(a(1.096, 5)), "more", "1.096 prints as +10%, so it is colored (what you read is what is colored)");
  t.equal(S.tone(a(1.094, 5)), "none", "1.094 prints as +9%");
  t.equal(S.pct(1.096), "+10%"); t.equal(S.pct(1.094), "+9%");
});
test("color needs at least 3 games counted, and a real number; missing is neutral, never colored", () => {
  const a = (ratio, games) => ({ ratio, games });
  t.equal(S.tone(a(1.5, 2)), "none"); t.equal(S.tone(a(1.5, 3)), "more"); t.equal(S.tone(a(0.5, 1)), "none");
  for (const x of [null, undefined, {}, { ratio: null, games: 5 }, { ratio: 1.4 }, { ratio: 1.4, games: 0 }]) t.equal(S.tone(x), "none");
});
test("color on the REAL recorded answers: some green, some red, many neutral, and the side always matches the printed sign; the stricter Pts Agst rule would color almost nothing", () => {
  for (const [name, d] of [["2026 thru Wk 5", D26], ["2025 full season", D25]]) {
    const seen = { more: 0, less: 0, none: 0 }, strict = { more: 0, less: 0, none: 0 };
    for (const team of Object.keys(d.teams)) for (const pos of Object.keys(S.POSITIONS)) {
      const x = S.allowed(d, team, pos); if (!x) continue;
      const k = S.tone(x); seen[k]++; strict[S.toneShrunk(x, pos)]++;
      if (k === "more") t.ok(S.pct(x.ratio).startsWith("+"), name + " " + team + " " + pos); if (k === "less") t.ok(S.pct(x.ratio).startsWith("−"), name + " " + team + " " + pos);
    }
    t.ok(seen.more > 20 && seen.less > 20 && seen.none > 20, name + " " + JSON.stringify(seen));
    t.ok(strict.more + strict.less < (seen.more + seen.less) / 4, name + " strict rule colors far fewer: " + JSON.stringify(strict));
  }
});
test("the Pts Agst rule (kept as an alternative) is the SAME table and rule as Stats → Sched; a test keeps the copies identical", () => {
  const src = fs.readFileSync(path.join(ROOT, "site/m/views/stats.js"), "utf8");
  const m = /var FPA_COLOR_K = (\{[^}]*\});/.exec(src); t.ok(m, "the Pts Agst table is there");
  t.equal(JSON.stringify(S.COLOR_K), JSON.stringify(Function("return " + m[1])()), "identical k per position");
  t.ok(/Math\.abs\(\(games \* ratio \+ k\) \/ \(games \+ k\) - 1\) >= 0\.08/.test(src) && S.COLOR_MIN_GAP === 0.08);
  const a = (ratio, games) => ({ ratio, games });
  t.equal(S.toneShrunk(a(1.5, 17), "DL"), "more"); t.equal(S.toneShrunk(a(1.5, 1), "DL"), "none"); t.equal(S.toneShrunk(a(1.3, 5), "LB"), "none");
});
test("rest of season is EVERY remaining league week in order (one grid), the next-five window is the first five of them", () => {
  const rest = S.weekList(D26, "rest").weeks, five = S.weekList(D26, "next5").weeks;
  t.equal(JSON.stringify(rest), JSON.stringify([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]));
  t.equal(JSON.stringify(five), JSON.stringify(rest.slice(0, 5)));
  t.ok(typeof S.chunk === "undefined", "no repeated five-week blocks any more");
});

test("compact cell labels: +22%, 28.2/g, 7th/32; each blank when missing, zero shown as 0", () => {
  t.equal(JSON.stringify(S.allowedCompact({ perGame: 28.2, ratio: 1.22, rank: 7, of: 32 })), JSON.stringify({ pct: "+22%", pg: "28.2/g", rank: "7th/32" }));
  t.equal(JSON.stringify(S.allowedCompact({ perGame: 0, ratio: 1, rank: 16, of: 32 })), JSON.stringify({ pct: "0%", pg: "0.0/g", rank: "16th/32" }));
  t.equal(JSON.stringify(S.allowedCompact({ perGame: null, ratio: null, rank: null, of: 32 })), JSON.stringify({ pct: "", pg: "", rank: "" }));
  t.equal(JSON.stringify(S.allowedCompact(null)), JSON.stringify({ pct: "", pg: "", rank: "" }));
});
test("the detail panel text carries everything a cell abbreviates: opponent, home/away, kickoff, per game, vs usual, rank, games, why the color, and 'not a forecast'", () => {
  const cell = S.cell(D26, "DEN", 8, "QB"); const d = S.detail(D26, cell, "QB", "Pat Example");
  const text = d.rows.map((r) => r.join(": ")).concat(d.notes).join(" | ");
  t.ok(d.title.startsWith("Wk 8:") && /Pat Example/.test(d.title), d.title);
  t.ok(/Opponent: (Home vs|Away at) [A-Z]{2,3}/.test(text), text);
  t.ok(/Kickoff: .* ET/.test(text) || /Kickoff: Not scheduled yet/.test(text), text);
  t.ok(/Points allowed per game \(Wks 1–5\): \d+\.\d to QBs/.test(text), text);
  t.ok(/Versus usual: .*(above|below|About usual)/.test(text) && /Rank among 32 teams: \d+(st|nd|rd|th) \(1st = has allowed the most to QBs\)/.test(text) && /Games counted: \d/.test(text), text);
  t.ok(/not a forecast/.test(text) && !/\b(easy|tough)\b/i.test(text), text);
  // a colored cell explains its color; a neutral one says why
  const colored = ["ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN", "DET"].map((tm) => S.cell(D26, tm, 6, "QB")).find((c) => c.kind === "game" && S.tone(c.allowed) !== "none");
  t.ok(colored, "a colored cell exists"); const dc = S.detail(D26, colored, "QB", ""); t.ok(dc.notes.join(" ").match(/(Green|Red): this opponent has allowed 10% or more (above|below) usual to QBs/), dc.notes.join(" "));
  const neutral = S.cell(D26, "ARI", 6, "QB"); const nn = clone(D26); nn.teams[neutral.opp].QB.adj.ratio = 1.02;
  t.ok(S.detail(nn, S.cell(nn, "ARI", 6, "QB"), "QB", "").notes.join(" ").includes("No color: within 9% of usual"));
  // missing number: said plainly, never a zero
  const e = clone(D26); const o = S.cell(e, "DEN", 8, "QB").opp; delete e.teams[o].QB;
  const dm = S.detail(e, S.cell(e, "DEN", 8, "QB"), "QB", ""); t.ok(dm.rows.some((r) => /No number yet/.test(r[1])) && !dm.rows.some((r) => /per game/.test(r[0])));
  t.equal(S.detail(D26, { kind: "bye", wk: 8 }, "QB", "").rows.length, 0);
});
await run("player_schedule");
