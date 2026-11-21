// UPS 2027 beta, stage R2: Team › Roster (four views, slot tags, opponents and kickoffs, injury chips, scores, summaries, past weeks).
//   node tests/mobile2027_roster.test.mjs
//
// Offline. Data is a trimmed recording of the public routes (tests/fixtures/mobile2027/public_reads.json and r2_reads.json); the injury
// resolver is the beta's DERIVED copy of the reviewed copy of the classic file; nothing here reads site/shared/ or the network.
// What is proven: the 18 slots and their tags (canon §B4), what each view draws, that a missing fact is never 0, that MFL's
// "expected return" text is never kept or drawn (ruling 2026-11-20: Unavailable), and that a past week shows only that week's
// facts (lineup, scores, matchups) with every CURRENT fact (injuries, bench, IR, taxi, cap notes) left out or labeled as of now.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "apps", "mobile2027", "src");
const require = createRequire(import.meta.url);
const FX = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/public_reads.json"), "utf8"));
const FX2 = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/r2_reads.json"), "utf8"));
const FIXSH = path.join(HERE, "fixtures/mobile2027/shared");
const B = await import(pathToFileURL(path.join(HERE, "..", "apps", "mobile2027", "scripts", "build.mjs")).href);
const EQ = await import(pathToFileURL(path.join(HERE, "..", "apps", "mobile2027", "scripts", "injury_equivalence.mjs")).href);
globalThis.UPSInjuryStatus = EQ.loadResolver(B.derivedBytes(B.DERIVED[0], FIXSH).toString("utf8"), "injury_status.pure.js");
const F = require(path.join(SRC, "lib/format.js"));
const M = require(path.join(SRC, "lib/model.js"));
const D = require(path.join(SRC, "lib/data.js"));
const R = require(path.join(SRC, "lib/roster.js"));
const V = require(path.join(SRC, "lib/views.js"));

const WORKER = "https://upsmflproduction.keith-creelman.workers.dev";
const CFG = { workerBase: WORKER, leagueId: "74598", season: "2026" };
const clone = (x) => JSON.parse(JSON.stringify(x));
const TEAM = "0009"; // a team whose recorded lineup has all 18 starters ("0010"'s Week 11 lineup has 17: its empty slot is used on purpose below)
const SHORT = "0010";
const model = () => M.build(FX.roster_workbench, FX.league, FX.weekly_results, 11, 2026);

// A loader with a fake fetch that serves the recorded reads, so the page's own stripping and shaping run on them.
function loaderOf(over) {
  const calls = [];
  const fetchFake = async (url) => {
    const u = new URL(url); calls.push(u.pathname + u.search);
    let body = {};
    if (u.pathname === "/api/player-status") body = (over && over.status) || FX2.player_status;
    else if (u.pathname === "/api/lineup-matchups") body = Object.assign({}, FX2.lineup_matchups_w11, { week: Number(u.searchParams.get("W")) });
    else if (u.searchParams.get("TYPE") === "weeklyResults") body = u.searchParams.get("W") === "10" ? FX2.weekly_results_w10 : FX.weekly_results;
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return { L: D.createLoader(CFG, fetchFake), calls };
}
async function intelFor(over) {
  const { L } = loaderOf(over);
  const st = await L.loadStatus(), mu = await L.loadMatchups(11), w10 = await L.loadWeekly(10), w11 = await L.loadWeekly(11);
  const rec = (r) => ({ state: r.state, data: r.data, at: r.at || Date.now() });
  return { status: rec(st), mu: { 11: rec(mu), 10: rec(await L.loadMatchups(10)) }, wk: { 11: rec(w11), 10: rec(w10) } };
}
function state(intel, over) {
  return {
    model: model(), load: { core: "ok", coreNotes: [] }, penalty: { state: "idle" }, teamId: TEAM, tab: "team", sub: "roster", view: "lineup",
    open: {}, flags: {}, profile: null, sheet: null, skin: "system", vib: "1", build: "test", requestLog: [], gdef: "needs", wk: null, intel,
    requestSummary: { requests: 0, ok: 0, failed: 0, refused: 0, nonGet: 0 }, ...(over || {}),
  };
}
const text = (html) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

test("the 18 slots follow canon §B4 and carry the demo's tags; flex slots take what the fixed slots leave; nothing is dropped", () => {
  t.equal(R.SLOTS.length, 18);
  t.deepEqual(R.SLOTS.map((s) => s.tag), ["QB1", "RB1", "RB2", "WR1", "WR2", "TE1", "FX1", "FX2", "SF", "K", "P", "DL1", "DL2", "LB1", "LB2", "DB1", "DB2", "DF"]);
  const count = (label) => R.SLOTS.filter((s) => s.label === label).length;
  t.deepEqual(["QB", "RB", "WR", "TE", "Flex", "Superflex", "Kicker", "Punter", "DL", "LB", "DB", "Defensive flex"].map(count), [1, 2, 2, 1, 2, 1, 1, 1, 2, 2, 2, 1], "canon: QB 1, RB 2, WR 2, TE 1, Flex 2, SuperFlex 1, K 1, P 1, DL 2, LB 2, DB 2, Defensive Flex 1");
  const P = (id, pos) => ({ id: String(id), pos, name: "P" + id });
  // a second QB takes the SuperFlex slot, a third RB takes a Flex slot
  const a = R.assignSlots([P(1, "QB"), P(2, "QB"), P(3, "RB"), P(4, "RB"), P(5, "RB"), P(6, "WR"), P(7, "WR"), P(8, "TE"), P(9, "PK"), P(10, "PN"), P(11, "DL"), P(12, "DL"), P(13, "LB"), P(14, "LB"), P(15, "DB"), P(16, "DB"), P(17, "DL"), P(18, "WR")]);
  const by = Object.fromEntries(a.slots.map((x) => [x.slot.tag, x.player && x.player.id]));
  t.equal(by.QB1, "1"); t.equal(by.SF, "2"); t.equal(by.RB1, "3"); t.equal(by.RB2, "4"); t.equal(by.FX1, "5"); t.equal(by.FX2, "18"); t.equal(by.DF, "17"); t.equal(a.extra.length, 0);
  t.equal(a.slots.filter((x) => x.player).length, 18);
  // a starter no slot accepts is kept, not dropped; a short lineup leaves empty slots
  const b = R.assignSlots([P(1, "QB"), P(2, "QB"), P(3, "QB")]);
  t.equal(b.extra.length, 1); t.equal(b.slots.filter((x) => !x.player).length, 16);
});

test("Lineup view, current week: slot tags, opponent on every row, a kickoff only off the ordinary slate, one injury chip, a bye chip only for a starter", async () => {
  const intel = await intelFor();
  const S = state(intel), html = V.rosterBody(S);
  t.match(html, /Week 11 starters · 18 of 18/);
  const tags = [...html.matchAll(/<span class="tag sl">([A-Z0-9]+)<\/span>/g)].map((m) => m[1]);
  t.deepEqual(tags, R.SLOTS.map((s) => s.tag), "all 18 slots, in order");
  const qb = R.lineupFor(S, S.model.teams.find((x) => x.id === TEAM), 11).slots[0].player;
  const first = text(html).match(new RegExp(qb.name + " " + qb.nflTeam + " · (vs|@) \\w+ · \\w{3} \\d{1,2}:\\d{2} [AP]M"));
  t.ok(first, "a starter off the ordinary slate shows his NFL team, the opponent and the kickoff (Eastern): " + qb.name);
  t.match(text(html), /A kickoff time is shown on a row only when it is not Sunday 1:00 PM \(Eastern\)/);
  // ordinary-slate starters show the opponent and no kickoff at all
  const ord = R.lineupFor(S, S.model.teams.find((x) => x.id === TEAM), 11).slots.map((x) => x.player).find((p) => R.kickoffInfo(S, p, 11).ordinary);
  t.ok(ord, "the team has a starter on the ordinary Sunday 1:00 PM slate");
  const ordRow = html.split('<div class="rx').find((r) => r.includes('data-pid="' + ord.id + '"'));
  t.doesNotMatch(text(ordRow), /\d{1,2}:\d{2} [AP]M/, "no kickoff on an ordinary-slate row");
  t.match(text(ordRow), new RegExp(ord.nflTeam + " · (vs|@) \\w+"));
  // the recorded week has Questionable starters: one chip, MFL's word, and no second source machinery on the row
  const chips = [...html.matchAll(/<span class="chip (?:wn|cr)">([^<]*)<\/span>/g)].map((m) => m[1]);
  t.ok(chips.some((c) => /Questionable/.test(c)), "a Questionable starter shows its chip");
  const rowsWithChips = html.split('<div class="rx').filter((r) => /class="fl"/.test(r));
  rowsWithChips.forEach((r) => t.ok((r.match(/class="chip /g) || []).length <= 2, "at most a bye chip and one injury chip per row"));
  // a starter whose bye is this week gets the bye chip and is highlighted; a bench player on a bye does not
  const m2 = model(); const starter = M.starters(m2.teams.find((x) => x.id === TEAM))[0]; m2.byId[starter.id].bye = 11;
  const h2 = V.rosterBody(state(intel, { model: m2 }));
  t.match(h2, /▲ Bye week/); t.match(h2, /class="rx prob"/);
  t.match(text(h2), /Bye week|Opponent unavailable|bye/i);
});

test("a missing fact is 'Unavailable' or '—', never 0: no opponent read, no score, no average, no status", async () => {
  const intel = await intelFor();
  // no matchup read yet: rows draw without an opponent (still loading) ...
  const loading = V.rosterBody(state({ ...intel, mu: {} }));
  t.doesNotMatch(text(loading), /Opponent unavailable/, "still loading is not 'unavailable'");
  // ... and a failed one says so
  const failed = V.rosterBody(state({ ...intel, mu: { 11: { state: "error", error: "HTTP 500" } } }));
  t.match(text(failed), /Opponent unavailable/);
  // no injury read: no chips, and the resolver's own line says why
  const none = V.rosterBody(state({ ...intel, status: { state: "error", error: "x" } }));
  t.doesNotMatch(none, /▲ Questionable/); t.match(text(none), /Injury status couldn’t be loaded, so no injury tags are shown/);
  const checking = V.rosterBody(state({ ...intel, status: { state: "loading" } })); t.match(text(checking), /Checking injury status/);
});

test("Byes view (R2b P6): grouped by upcoming bye week in order; each group says which of TODAY's starting slots it affects; played byes collapsed", async () => {
  const intel = await intelFor();
  const S = state(intel, { view: "byes" }), html = V.rosterBody(S), tx = text(html);
  const tm = S.model.teams.find((x) => x.id === TEAM), lineup = R.lineupFor(S, tm, 11), g = R.byeGroups(S, tm, 11, lineup);
  t.ok(g.groups.length >= 2, "the team has players on at least two upcoming byes");
  t.deepEqual(g.groups.map((x) => x.week), g.groups.map((x) => x.week).slice().sort((a, b) => a - b), "chronological");
  t.ok(g.groups.every((x) => x.week >= 11), "no played week among the upcoming groups"); t.ok(g.past.length > 0 && g.past.every((p) => p.bye < 11));
  // each group header: the week, how many CURRENT starters it leaves out, and their slot tags (today's lineup)
  g.groups.forEach((grp) => {
    const n = grp.starters.length, label = n ? "Week " + grp.week + " · " + n + " current starter" + (n === 1 ? "" : "s") + " on bye: " + grp.starters.map((x) => x.tag).join(", ") : "Week " + grp.week + " · no current starters on bye";
    t.ok(tx.includes(label), "group header: " + label);
  });
  t.match(tx, /Next byes: Week 11 · 0 current starters · Week 13 · 2 current starters · Week 14 · 2 current starters/);
  t.match(tx, /This week · Week 11 · no current starters on bye/);
  t.match(tx, /Week 13 · 2 current starters on bye: RB2, TE1/); t.match(tx, /Week 14 · 2 current starters on bye: DB1, DF/);
  // the groups come out in week order on the page
  t.deepEqual([...html.matchAll(/data-g="bw(\d+|past)"/g)].map((m) => m[1]), [...g.groups.map((x) => String(x.week)), "past"], "upcoming groups in week order, then the played ones");
  // slots are TODAY's: the page says so, and invents no past or future assignment
  t.match(tx, /Slots are today’s lineup \(Week 11\)\. The lineup for a later week is not set, so these players may not fill the same slots then\./);
  t.doesNotMatch(tx, /will start|will be your|projected lineup for Week 1[2-9]/i);
  // played byes are collapsed by default and say so; opening them lists the players
  t.match(html, /data-g="bwpast" aria-expanded="false"/); t.match(tx, /Already played · \d+ players/);
  t.match(V.rosterBody(state(intel, { view: "byes", open: { bwpast: true } })), /data-g="bwpast" aria-expanded="true"/);
  t.match(html, /data-g="bw13" aria-expanded="true"/, "upcoming groups are open");
  // a starter row says "current starter", a bench player "bench"; a played bye reads "bye was Week N"
  t.match(tx, /Breece Hall NYJ · current starter/); t.match(tx, /Isaiah Davis NYJ · bench/);
  t.match(text(V.rosterBody(state(intel, { view: "byes", open: { bwpast: true } }))), /· bye was Week \d+/);
  // a player MFL gave no bye week for is grouped apart as unavailable, not week 0
  const m2 = model(); const p = M.starters(m2.teams.find((x) => x.id === TEAM))[0]; m2.byId[p.id].bye = null;
  const h2 = text(V.rosterBody(state(intel, { view: "byes", model: m2 })));
  t.match(h2, /Bye week unavailable/); t.doesNotMatch(h2, /Week 0\b/);
});

test("MFL's 'expected return' text is never kept or drawn (ruling 2026-11-20: Unavailable until its meaning is verified)", async () => {
  // the recorded read really carries it ...
  const raw = JSON.stringify(FX2.player_status);
  t.match(raw, /"exp_return":"[A-Z][a-z]{2} \d{1,2}, \d{4}"/, "the recording has expected-return text on its rows");
  // ... and the page drops it before anything else can hold it
  const { L } = loaderOf(); const st = await L.loadStatus();
  t.equal(st.state, "ok"); t.doesNotMatch(JSON.stringify(st.data), /exp_return|return_date/, "the kept read has no expected-return field");
  t.ok(Object.keys(st.data.players).length === Object.keys(FX2.player_status.players).length, "every player is still there");
  // so no screen can show it, in any view, week or state
  const intel = await intelFor();
  const dates = [...new Set([...raw.matchAll(/"exp_return":"([^"]+)"/g)].map((m) => m[1]))];
  const screens = ["lineup", "performance", "contracts", "byes"].map((view) => V.rosterBody(state(intel, { view, open: { ir: true, taxi: true, bRB: true, bWR: true, bTE: true, bQB: true } })))
    .concat([V.rosterBody(state(intel, { wk: 10 })), V.app(state(intel, { sheet: "weeks" })), V.app(state(intel, { sheet: "about" }))]);
  screens.forEach((h) => { t.doesNotMatch(h, /expected back|expected return|exp_return|return_date/i); dates.forEach((d) => t.ok(!h.includes(d), "no recorded return date (" + d + ") on a screen")); });
  // an IR row says it is Unavailable
  t.match(text(V.rosterBody(state(intel, { open: { ir: true } }))), /Return: Unavailable/);
  // the profile's More tab, which reads the same player, does not show it either
  const ir = model().teams.find((x) => x.id === TEAM).players.find((p) => p.status === "ir");
  t.doesNotMatch(V.app(state(intel, { profile: { pid: ir.id, tab: "more" } })), /expected back|exp_return|return_date/i);
});

test("a past week shows only that week's facts; every current fact is left out or labeled as of now", async () => {
  const intel = await intelFor();
  const S = state(intel, { wk: 10 }), html = V.rosterBody(S), tx = text(html);
  t.match(tx, /Week 10 · played · Lineup and scores are from that week/);
  t.match(tx, /NFL opponents and bye weeks are Unavailable for a past week: no read says which NFL team a player was with then/);
  t.match(tx, /Injury status, rosters and contracts are as of now, so none of them is drawn here/);
  t.match(tx, /Go to Week 11 \(current\)/);
  t.match(html, /class="wsel past"/); t.match(tx, /Played · as MFL recorded it/);
  t.match(tx, /Week 10 starters · \d+ of 18/);
  t.match(html, /<b[^>]*>[\d.]+<\/b><span class="mu sm">Wk 10<\/span>/, "each starter shows that week's points, labeled with the week");
  // current facts are absent: injury chips, cap notes, the bench, injured reserve and taxi blocks
  t.doesNotMatch(html, /▲ Questionable|■ OUT|■ IR|class="chip (wn|cr)">[^<]*(Questionable|Doubtful|OUT)/);
  t.doesNotMatch(tx, /cap hit 50%|taxi, \$0|call-ups|Return: Unavailable|Bench · |Injured reserve ·|Taxi squad ·|Needs you/);
  t.match(tx, /Bench, injured reserve and taxi are not shown for past weeks/);
  // Byes is not week-by-week (R2b P1/P2): it draws TODAY's data under "As of now · Week 11", never under the chosen past week
  ["byes"].forEach((view) => {
    const h = V.rosterBody(state(intel, { wk: 10, view })), tx2 = text(h);
    t.match(tx2, /As of now · Week 11 · This view always shows today’s roster, injuries and lineup\./);
    t.doesNotMatch(tx2, /Week 10/, view + ": nothing is labeled Week 10"); t.doesNotMatch(h, /class="wsel past"/, view + ": no past-week bar");
    t.doesNotMatch(tx2, /Played · as MFL recorded it|Lineup and scores are from that week/);
  });
  t.match(text(V.rosterBody(state(intel, { wk: 10, view: "byes" }))), /18 of 18 starters/, "today's starters carry today's week");
  // a starter who is no longer on a UPS roster is shown by id with no current facts, never with today's team
  const m2 = model(); const w = clone(FX2.weekly_results_w10); w.weeklyResults.matchup.flatMap((x) => x.franchise).filter((x) => x.id === TEAM).forEach((f) => { f.player[0].id = "99999999"; f.player[0].status = "starter"; });
  const gone = text(V.rosterBody(state({ ...intel, wk: { ...intel.wk, 10: { state: "ok", data: w, at: Date.now() } } }, { wk: 10, model: m2 })));
  t.match(gone, /Player 99999999 No longer on a UPS roster/);
});

test("a past week that could not be read says so and offers a retry; nothing is guessed in its place", async () => {
  const intel = await intelFor();
  const bad = V.rosterBody(state({ ...intel, wk: { ...intel.wk, 10: { state: "error", error: "HTTP 502" } } }, { wk: 10 }));
  t.match(text(bad), /That week’s lineup could not be read \(HTTP 502\)\. Nothing is guessed in its place/); t.match(bad, /data-act="pickweek" data-v="10"/);
  t.doesNotMatch(bad, /class="tag sl"/);
  const wait = V.rosterBody(state({ ...intel, wk: { 11: intel.wk[11] } }, { wk: 10 })); t.match(wait, /aria-busy="true"/); t.match(text(wait), /Loading Week 10/);
  const missing = clone(FX2.weekly_results_w10); missing.weeklyResults.matchup = missing.weeklyResults.matchup.filter((m) => !m.franchise.some((f) => f.id === TEAM));
  t.match(text(V.rosterBody(state({ ...intel, wk: { ...intel.wk, 10: { state: "ok", data: missing, at: Date.now() } } }, { wk: 10 }))), /MFL has no lineup recorded for this team in that week/);
});

test("'Needs you' on a bench group: a player still on the active roster with an MFL roster designation; the group rule opens it", async () => {
  const s2 = clone(FX2.player_status); const bench = M.benchGroups(model().teams.find((x) => x.id === TEAM)).find((g) => g.pos === "WR").players[0];
  s2.players[bench.id] = { roster: { status: "IR", label: "Injured reserve", chip: "IR", detail: "Knee", exp_return: "Nov 29, 2026" } };
  const intel = await intelFor({ status: s2 });
  const on = V.rosterBody(state(intel)), tx = text(on);
  t.match(tx, /on bench Needs you/); t.match(tx, new RegExp(bench.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " has an MFL IR designation"));
  t.match(on, /data-g="bWR" aria-expanded="true"/, "'Only what needs you' opens it by default");
  t.match(on, /data-g="bRB" aria-expanded="false"/, "and leaves the others closed");
  t.match(on, /■ IR/, "his row carries the IR chip");
  t.match(V.rosterBody(state(intel, { gdef: "all" })), /data-g="bRB" aria-expanded="true"/, "'All groups open' opens every bench group");
  t.equal(V.isOpen(state(intel, { open: { bWR: false } }), "bWR"), false, "a group the owner closed stays closed");
  // a Questionable bench player does not 'need you' (it is not an action)
  t.doesNotMatch(text(V.rosterBody(state(await intelFor()))), /Needs you/);
});

test("the week sheet: past weeks can be chosen, later weeks are listed as not available, the current week is marked", async () => {
  const html = V.weekSheet(state(await intelFor(), { sheet: "weeks" }));
  t.match(html, /aria-label="Choose a week"/);
  t.equal((html.match(/data-act="pickweek" data-v="\d+"( disabled)?/g) || []).length, 17);
  t.equal((html.match(/data-act="pickweek" data-v="\d+" disabled/g) || []).length, 6, "weeks 12 to 17 are listed and disabled");
  t.match(text(html), /Week 11 Current week/); t.match(text(html), /Week 12 Not available in this preview/); t.match(text(html), /Week 3 Played/);
  t.deepEqual([...html.matchAll(/data-act="pickweek" data-v="(\d+)"/g)].map((m) => +m[1]), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 12, 13, 14, 15, 16, 17], "current week first, then played weeks most recent first, then later weeks");
  t.match(html, /data-v="11" aria-pressed="true"/);
  t.match(text(html), /NFL opponents and bye weeks, injury status, rosters and contracts are only shown for the current week/);
});

test("the status line (R2b P3): 'n need attention' counts slots that need a decision, once each; empty slots, byes, Out, designations and Doubtful count, Questionable does not", async () => {
  const intel = await intelFor();
  const ok = text(V.rosterBody(state(intel, { view: "byes" })));
  t.match(ok, /18 of 18 starters · nothing needs attention Open Lineup/);
  // the recorded Week 11 lineup of another team really has an empty slot (a genuine empty slot, no leftover starter)
  const short = text(V.rosterBody(state(intel, { view: "byes", teamId: SHORT })));
  t.match(short, /17 of 18 starters · 1 needs attention Open Lineup/);
  t.match(text(V.rosterBody(state(intel, { teamId: SHORT }))), /DF · Empty No starter is set for this slot/); t.match(text(V.rosterBody(state(intel, { teamId: SHORT }))), /DF Empty/);
  const m2 = model(); const tm = m2.teams.find((x) => x.id === TEAM); tm.lineup.ids = tm.lineup.ids.slice(0, 16); // two empty slots
  t.match(text(V.rosterBody(state(intel, { view: "byes", model: m2 }))), /16 of 18 starters · 2 need attention/);
  const s2 = clone(FX2.player_status); const st = M.starters(tm)[0]; s2.players[st.id] = { mfl: { status: "Out", week: 11, details: "Knee" } };
  const i2 = await intelFor({ status: s2 });
  t.match(text(V.rosterBody(state(i2, { view: "byes" }))), /18 of 18 starters · 1 needs attention/);
  t.match(V.rosterBody(state(i2)), /■ OUT/);
  // injuries not read: the line says so rather than "nothing needs attention"
  const nr = text(V.rosterBody(state({ ...intel, status: { state: "loading" } }, { view: "byes" })));
  t.match(nr, /18 of 18 starters · injuries not checked/); t.doesNotMatch(nr, /nothing needs attention/);
  t.match(text(V.rosterBody(state({ ...intel, status: { state: "error", error: "x" } }))), /injuries not checked/);
});

test("each fact is the one the read gave: home or away, the team's own week, one decimal, the years that end, bye and IR rules", async () => {
  const intel = await intelFor();
  const m = model(), tm = m.teams.find((x) => x.id === TEAM), lineup = R.lineupFor(state(intel), tm, 11);
  // home and away: "vs" is the home team, "@" the visitor, from the recorded games
  const games = intel.mu[11].data.games;
  const homeP = lineup.slots.map((x) => x.player).find((p) => games[p.nflTeam] && games[p.nflTeam].isHome), awayP = lineup.slots.map((x) => x.player).find((p) => games[p.nflTeam] && !games[p.nflTeam].isHome);
  t.ok(homeP && awayP, "the recorded lineup has a home starter and an away starter");
  t.match(R.oppText(state(intel), homeP, 11), /^vs [A-Z]{2,3}$/); t.match(R.oppText(state(intel), awayP, 11), /^@ [A-Z]{2,3}$/);
  // a team the games read does not list, and no bye for him, is "unavailable", not blank and not a guess
  t.equal(R.oppText(state(intel), { ...homeP, nflTeam: "XXX", bye: null }, 11), "Opponent unavailable");
  t.equal(R.oppText(state(intel), { ...homeP, nflTeam: "XXX", bye: 11 }, 11), "Bye week", "unless MFL's own bye week says so");
  // the Performance and past rows speak for the right week, with one decimal
  const sc10 = Object.fromEntries(FX2.weekly_results_w10.weeklyResults.matchup.flatMap((x) => x.franchise).filter((f) => f.id === TEAM)[0].player.map((p) => [p.id, p.score]));
  const withDecimal = lineup.slots.map((x) => x.player).find((p) => /\.\d$/.test(String(sc10[p.id])) && !/\.0$/.test(String(sc10[p.id])));
  t.ok(withDecimal, "a recorded starter with a non-whole score");
  const rowText = (html, pid) => text(html.split('<div class="rx').find((r) => r.includes('data-pid="' + pid + '"')));
  const past = V.rosterBody(state(intel, { wk: 10 }));
  t.match(rowText(past, withDecimal.id), new RegExp(withDecimal.name + " [A-Z]+ now · Opponent unavailable " + String(sc10[withDecimal.id]).replace(".", "\\.") + " Wk 10"), "past week 10: that week's own score, his club labeled 'now', the opponent Unavailable");
  // a starter on a bye this week is one to fix
  const m2 = model(); const st = lineup.slots.map((x) => x.player)[0]; m2.byId[st.id].bye = 11;
  t.match(text(V.rosterBody(state(intel, { view: "byes", model: m2 }))), /18 of 18 starters · 1 needs attention/);
  // "end after 2026" counts a final year only (years left = 1), not an expired or unrecorded contract
  const m3 = model(); const t3 = m3.teams.find((x) => x.id === TEAM); const act = t3.players.filter((p) => p.status === "active");
  const want = act.filter((p) => p.years === 1).length; act[0].years = 0; act[1].years = 1;
  t.equal(R.endingAfterSeason(t3), act.filter((p) => p.years === 1).length); t.ok(want >= 1);
  // an IR-section player does not repeat the IR chip, but another designation (PUP) still shows
  const s2 = clone(FX2.player_status); const irs = tm.players.filter((p) => p.status === "ir");
  t.ok(irs.length >= 2, "the team has IR players");
  s2.players[irs[0].id] = { roster: { status: "IR", label: "Injured reserve", chip: "IR", detail: null, exp_return: null } };
  s2.players[irs[1].id] = { roster: { status: "IR-PUP", label: "Physically unable to perform", chip: "PUP", detail: null, exp_return: null } };
  const irHtml = V.rosterBody(state(await intelFor({ status: s2 }), { open: { ir: true } }));
  const rowOf = (pid) => irHtml.split('<div class="rx').find((r) => r.includes('data-pid="' + pid + '"'));
  t.doesNotMatch(rowOf(irs[0].id), /■ IR/, "an IR player in the IR section shows no IR chip"); t.match(rowOf(irs[1].id), /■ PUP/, "a PUP designation still shows");
});


test("MAT-1 (Codex, dc5b35d7): a past week never uses a player's club TODAY to find that week's opponent or bye; the recorded lineup and score stay", async () => {
  const intel = await intelFor();
  const m0 = model(), tm0 = m0.teams.find((x) => x.id === TEAM);
  const starter = R.lineupFor(state(intel, { wk: 10 }), tm0, 10).starters[0];
  const sc10 = Object.fromEntries(FX2.weekly_results_w10.weeklyResults.matchup.flatMap((x) => x.franchise).filter((f) => f.id === TEAM)[0].player.map((p) => [p.id, p.score]));
  // a games read for that week IS in memory (the page no longer asks for one, but a stale or future read must not be used either),
  // and the two clubs have different opponents and different bye weeks
  const games = { OLD: { opp: "AAA", isHome: true, kickoff: 1795000000, status: "final" }, NEW: { opp: "BBB", isHome: false, kickoff: 1795000000, status: "final" } };
  const withGames = { ...intel, mu: { ...intel.mu, 10: { state: "ok", data: { week: 10, games, avg: {}, asOf: "" }, at: Date.now() } } };
  const rowOf = (html, pid) => html.split('<div class="rx').find((r) => r.includes('data-pid="' + pid + '"'));
  const draw = (club, bye) => { const m = model(); m.byId[starter.id].nflTeam = club; m.byId[starter.id].bye = bye; return V.rosterBody(state(withGames, { model: m, wk: 10 })); };
  const before = rowOf(draw("OLD", 5), starter.id), after = rowOf(draw("NEW", 10), starter.id);
  t.ok(before && after, "the starter's row is drawn");
  // only his club's label changes (it says 'now'); nothing about the opponent or the bye depends on it
  t.equal(before.replace("OLD now", "CLUB now"), after.replace("NEW now", "CLUB now"), "changing only his current club changes nothing else in the row");
  [before, after].forEach((r) => {
    t.match(text(r), /now · Opponent unavailable/); t.doesNotMatch(r, /\b(vs|@) (AAA|BBB)\b|AAA|BBB/, "no opponent from either club's schedule");
    t.doesNotMatch(r, /Bye week|▲|>Bye</, "no bye indicator, whichever club's bye week it would be");
    t.match(text(r), new RegExp(String(sc10[starter.id]).replace(".", "\\.") + " Wk 10"), "the recorded score stays");
    t.match(r, /class="tag sl" role="img" aria-label="Recorded starter number 1">1</, "and his place in the recorded order stays (no slot is claimed for a past week)");
  });
  // his current bye week equals the selected past week: still no bye indicator
  const m3 = model(); m3.byId[starter.id].bye = 10;
  t.doesNotMatch(V.rosterBody(state(withGames, { model: m3, wk: 10 })), /Bye week/);
  // a past week's starter with no recorded score reads as a dash labeled with the week, never 'Bye' taken from his club's bye week today
  const m5 = model(); const target = R.lineupFor(state(intel, { model: m5 }), m5.teams.find((x) => x.id === TEAM), 11).slots[1].player; m5.byId[target.id].bye = 10;
  const i5 = { ...intel, wk: { ...intel.wk, 10: { state: "ok", at: Date.now(), data: { weeklyResults: { week: "10", matchup: [{ franchise: [{ id: TEAM, score: "1", player: [{ id: target.id, status: "starter", score: "" }] }] }] } } } } };
  const pastHtml = V.rosterBody(state(i5, { model: m5, wk: 10 }));
  const tRow = text(pastHtml.split('<div class="rx').find((r) => r.includes('data-pid="' + target.id + '"')));
  t.match(tRow, /— Wk 10/, "no score reads as a dash"); t.doesNotMatch(tRow, /Bye/);
  // the current week is unchanged: a bye this week still shows, from his club's bye week today (a current fact)
  const m6 = model(); const cur = R.lineupFor(state(intel, { model: m6 }), m6.teams.find((x) => x.id === TEAM), 11).slots[0].player; m6.byId[cur.id].bye = 11;
  t.match(V.rosterBody(state(intel, { model: m6 })), /▲ Bye week/);
});


test("MAT-2 (Codex, 4951dfce): a past week lists the recorded starters in the recorded order with the recorded count; today's positions cannot change membership, count, slots or empty slots", async () => {
  const intel = await intelFor();
  const tm = model().teams.find((x) => x.id === TEAM);
  const rec = R.lineupFor(state(intel, { wk: 10 }), tm, 10);
  t.equal(rec.recorded, true); t.equal(rec.count, 18, "the recorded starter count"); t.equal(rec.starters.length, 18);
  t.equal(rec.slots, undefined, "no slots are built for a past week"); t.equal(rec.filled, undefined, "and no filled-slot count");
  const recordedIds = FX2.weekly_results_w10.weeklyResults.matchup.flatMap((x) => x.franchise).filter((f) => f.id === TEAM)[0].player.filter((p) => p.status === "starter").map((p) => p.id);
  t.deepEqual(rec.starters.map((p) => p.id), recordedIds, "the starters are the recorded ones, in the recorded order");
  const base = V.rosterBody(state(intel, { wk: 10 }));
  t.match(text(base), /Week 10 starters · 18 of 18/); t.doesNotMatch(base, /Empty|class="tag sl">[A-Z]/, "no empty slot and no slot tag");
  const rows = (html) => (html.match(/aria-label="Recorded starter number (\d+)"/g) || []).length;
  t.equal(rows(base), 18, "eighteen recorded rows, numbered in the recorded order");
  // Codex's reproduction: the current slots are all filled; change ONLY one starter's current position (DB -> LB)
  const cur = R.lineupFor(state(intel), tm, 11);
  t.equal(cur.filled, 18, "(control: the current Week 11 lineup fills all 18 slots)");
  const mv = (pid, pos) => { const m = model(); m.byId[pid].pos = pos; m.byId[pid].rawPos = pos; return m; };
  const dbRow = rec.starters.find((p) => p.pos === "DB"), anyRow = rec.starters[3];
  t.ok(dbRow, "the recorded lineup has a DB starter");
  [mv(dbRow.id, "LB"), mv(anyRow.id, "QB"), mv(rec.starters[7].id, "PK"), mv(rec.starters[9].id, "?")].forEach((m, i) => {
    const html = V.rosterBody(state(intel, { wk: 10, model: m }));
    t.equal(html, base, "past week, position change " + i + ": the screen is byte for byte the same");
    t.equal(R.lineupFor(state(intel, { model: m, wk: 10 }), m.teams.find((x) => x.id === TEAM), 10).count, 18);
  });
  // the Performance view of a past week is the same list
  const perf = V.rosterBody(state(intel, { wk: 10 }));
  t.equal(V.rosterBody(state(intel, { wk: 10, model: mv(dbRow.id, "LB") })), perf);
  // the recorded count is the recorded count: 17 recorded starters read 17, 19 read 19, never a filled-slot count
  const withCount = (n) => { const w = clone(FX2.weekly_results_w10); w.weeklyResults.matchup.flatMap((x) => x.franchise).filter((f) => f.id === TEAM).forEach((f) => {
    const starters = f.player.filter((p) => p.status === "starter"), others = f.player.filter((p) => p.status !== "starter");
    if (n < 18) starters.slice(n).forEach((p) => { p.status = "nonstarter"; }); else others.slice(0, n - 18).forEach((p) => { p.status = "starter"; }); });
    return state({ ...intel, wk: { ...intel.wk, 10: { state: "ok", data: w, at: Date.now() } } }, { wk: 10 }); };
  const h17 = V.rosterBody(withCount(17)), h19 = V.rosterBody(withCount(19));
  t.match(text(h17), /Week 10 starters · 17 of 18/); t.equal(rows(h17), 17); t.doesNotMatch(h17, /Empty/);
  t.match(text(h19), /Week 10 starters · 19 of 18/); t.equal(rows(h19), 19); t.doesNotMatch(h19, /Empty/);
  // the note says what is not shown; no recorded starters reads as no starters recorded
  t.match(text(base), /Listed in the order MFL recorded them\. Slots and positions are not shown for a past week/);
  // the current week is unchanged: slots, empty slots and the filled count are still built from today's positions
  const curBase = V.rosterBody(state(intel));
  t.match(curBase, /class="tag sl">QB1</); t.match(text(curBase), /Week 11 starters · 18 of 18/);
  const dbNow = cur.slots.map((x) => x.player).find((p) => p.pos === "DB");
  t.notEqual(V.rosterBody(state(intel, { model: mv(dbNow.id, "LB") })), curBase, "the current week still follows today's positions");
});

await run("mobile2027_roster");
