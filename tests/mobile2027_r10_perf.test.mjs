// UPS 2027 R10 (Keith 2026-11-23, decisions 4 and 5): the INT-rate minimum on each QB's own club games (behind a data check), and the
// Performance position chips (this team's positions; the other-teams search has its own position control).
//   node tests/mobile2027_r10_perf.test.mjs
// Offline: recorded public reads drawn through the real views, plus source checks of app.js. Evidence and the impact table: S/r7notes/r10c.md.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "apps", "mobile2027", "src");
const require = createRequire(import.meta.url);
const M = require(path.join(SRC, "lib/model.js")), D = require(path.join(SRC, "lib/data.js")), V = require(path.join(SRC, "lib/views.js")), X = require(path.join(SRC, "lib/complete.js"));
const TV = require(path.join(SRC, "lib/tabviews.js")), BL = require(path.join(SRC, "lib/boxlog.js")), SR = require(path.join(SRC, "lib/statranks.js"));
const FX = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/public_reads.json"), "utf8"));
const FX3 = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/r3_reads.json"), "utf8"));
const FX4 = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/r4_reads.json"), "utf8"));
const CAL = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/calendar_2026.json"), "utf8"));
const CFG = { workerBase: "https://upsmflproduction.keith-creelman.workers.dev", leagueId: "74598", season: "2026" };
const appJs = fs.readFileSync(path.join(SRC, "app.js"), "utf8");
const text = (html) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const body = (html) => html.split('id="screen"')[1].split("<nav")[0];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TEAM = "0010";
const ORDER = ["QB", "RB", "WR", "TE", "PK", "PN", "DL", "LB", "DB"], LABEL = { PK: "K", PN: "P" };
async function intel() {
  const ok = (b) => ({ ok: true, status: 200, text: async () => JSON.stringify(b) });
  const fake = async (url) => {
    const u = new URL(url), ty = u.searchParams.get("TYPE"), w = u.searchParams.get("W");
    if (u.pathname === "/api/lineup-matchups") return ok(Object.assign({}, FX3.lineup_matchups_w11, FX4.hist, { week: Number(w) }));
    if (ty === "playerScores") return ok({ playerScores: { playerScore: FX4.scores[w] || (w === "11" ? [{ id: "1", score: "0" }] : []) } });
    if (ty === "players") return ok({ players: { player: FX4.players } });
    if (ty === "nflByeWeeks") return ok(CAL.byes);
    if (ty === "nflSchedule" && w === "ALL") return ok(CAL.full);
    if (ty === "nflSchedule") return ok(w === "10" ? FX4.schedule10 : w === "11" ? FX4.schedule11 : { nflSchedule: { matchup: [] } });
    return ok({});
  };
  const L = D.createLoader(CFG, fake), rec = (r) => ({ state: r.state, data: r.data, error: r.error, at: Date.now() });
  const out = { status: null, mu: { 11: rec(await L.loadMatchups(11)) }, wk: {}, scores: {}, sched: {}, players: rec(await L.loadPlayers()) };
  for (const w of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) out.scores[w] = rec(await L.loadScores(w));
  for (const w of [10, 11]) out.sched[w] = rec(await L.loadSchedule(w, X.parseSchedule));
  out.cal = rec(await L.loadCalendar(X.parseCalendar));
  Object.keys(out.scores).forEach((k) => { out.scores[k].at += 1000; });
  return out;
}
const PF = (o) => Object.assign({ s: "pos", open: {}, res: {}, q: "", pos: "all", xt: false, xpos: "all", note: null }, o || {});
const state = (over) => ({ model: M.build(FX.roster_workbench, FX.league, FX.weekly_results, 11, 2026), load: { core: "ok", coreNotes: [] }, penalty: { state: "idle" }, ns: { state: "idle" }, teamId: TEAM, tab: "team", sub: "performance", view: "lineup",
  open: {}, flags: {}, profile: null, sheet: null, skin: "system", vib: "1", build: "test", requestLog: [], gdef: "needs", wk: null, live: null, pf: PF(),
  requestSummary: { requests: 0, ok: 0, failed: 0, refused: 0, nonGet: 0 }, ...(over || {}) });
const cards = (html) => [...html.matchAll(/data-act="card" data-pid="(\d+)"( data-x="1")? aria-label="Open ([^"]+?) profile/g)].map((m) => ({ id: m[1], x: !!m[2], name: m[3] }));
const chipsOf = (html, act) => [...html.matchAll(new RegExp('data-act="' + act + '" data-v="([A-Z]+|all)" aria-pressed="(true|false)">([^<]+)<', "g"))].map((m) => ({ v: m[1], on: m[2] === "true", label: m[3] }));
// a model where one team lacks a position: drop TEAM's punters (or kickers) from the built model
function withoutPos(S, tid, pos) { const tm = S.model.teams.find((x) => x.id === tid); tm.players = tm.players.filter((p) => p.pos !== pos); return S; }

// ---------------- 4. INT-rate minimum: his own club games, behind a data check ----------------
const pool = (players, extra) => Object.assign({ ok: true, season: 2026, through: 10, group: "QB", data_max_week: 10, unmapped_box_players: 0, ambiguous_ids: 0, fields: [], players }, extra || {});
const E = (id, ints, att, tg) => Object.assign({ mfl_id: String(id), gsis_id: "00-" + id, games: 9, snap_games: 9, s: { pass_ints: ints, pass_att: att, pass_cmp: Math.round(att * 0.6) } }, tg == null ? {} : { team_games: tg });
const rank = (j, id, key, G) => SR.rankOf(SR.checkPool(j, 2026, 10, "QB"), id, key || "int_rate", { group: "QB", G: G == null ? 9 : G });

test("INT rate (R10): with every QB's own club games in the answer, the bar is 15 x HIS club games; competitors qualify on their own bar", () => {
  // A: 140 att, club played 9 -> bar 135, ranked. B: 140 att, club played 10 -> bar 150, not ranked. C: 0 INT in 145, club 10 -> under 150, never outranks.
  const j = pool([E(1, 3, 140, 9), E(2, 1, 140, 10), E(3, 0, 145, 10), E(4, 4, 300, 10), E(5, 2, 200, 9)]);
  t.equal(SR.checkPool(j, 2026, 10, "QB").ownGames, true, "every player carries team_games");
  const a = rank(j, 1); t.equal(a.text, "QB3", "A qualifies at 135 (9 club games): 2/200 and 4/300 are better (1.00%, 1.33% < 2.14%)");
  const b = rank(j, 2); t.equal(b.text, "—");
  t.equal(b.why, "Ranked at 150 pass attempts or more (15 for each of his club's 10 games); he has 140.", "the reason names his own club games");
  t.equal(rank(j, 5).text, "QB1", "C (0 INT in 145, club 10) is under his own 150 bar, so he is not a competitor");
  t.equal(rank(j, 4).text, "QB2");
  // the same pool under the fewest-games bar (no team_games): C qualifies at 135 and leads; B qualifies too
  const k = pool([E(1, 3, 140), E(2, 1, 140), E(3, 0, 145), E(4, 4, 300), E(5, 2, 200)]);
  t.equal(SR.checkPool(k, 2026, 10, "QB").ownGames, false);
  t.equal(rank(k, 3).text, "QB1"); t.equal(rank(k, 2).text, "QB2");
  t.equal(rank(pool([E(1, 1, 100), E(2, 1, 200)]), 1).why, "Ranked at 135 pass attempts or more; he has 100.", "fewest-games wording unchanged");
  // other rates keep the fewest-games bar even when team_games is present (Keith's decision is the INT-rate minimum)
  t.match(rank(j, 2, "cmp_pct").text, /^QB\d+$/, "Completion %: 140 >= 135 (fewest games), ranked");
});

test("INT rate (R10): one QB without supported club games (or a bad value) keeps the fewest-games bar for EVERY QB; the recorded answer has none", () => {
  const base = [E(1, 3, 140, 9), E(2, 1, 140, 10), E(4, 4, 300, 10)];
  for (const bad of [undefined, null, 0, 11, 9.5, "10", -1]) {
    const ps = base.concat([Object.assign(E(9, 2, 200), bad === undefined ? {} : { team_games: bad })]), j = pool(ps), P = SR.checkPool(j, 2026, 10, "QB");
    t.equal(P.ok, true); t.equal(P.ownGames, false, "team_games " + JSON.stringify(bad) + ": not supported");
    t.equal(rank(j, 2).text, "QB1", "B (1/140) ranks under the fewest-games bar 135: " + JSON.stringify(bad));
  }
  t.equal(SR.checkPool(pool([]), 2026, 10, "QB").ownGames, false, "an empty pool never switches the rule");
  // the recorded Week 10 QB answer: no team_games, so the fewest-games bar (15 x 9 = 135) is what shows
  const ctx = { window: {} }; vm.runInNewContext(fs.readFileSync(path.join(SRC, "recorded_data.js"), "utf8"), ctx);
  const R = ctx.window.UPS2027_RECORDED.routes["/api/position-season-stats?group=QB&season=2026&through=10"];
  const ans = typeof R === "string" ? JSON.parse(R) : (R && (R.body || R.json)) ? (typeof (R.body || R.json) === "string" ? JSON.parse(R.body || R.json) : (R.body || R.json)) : R;
  t.ok(ans && Array.isArray(ans.players) && ans.players.length >= 60, "the recorded QB pool");
  t.ok(ans.players.every((e) => e.team_games === undefined), "the recorded answer carries no club games");
  t.equal(SR.checkPool(ans, 2026, 10, "QB").ownGames, false);
  // Week 10 qualifiers stay 31 (r9c snapshot), every one with >= 135 attempts
  const P = SR.checkPool(ans, 2026, 10, "QB"), q = ans.players.filter((e) => SR.rankOf(P, e.mfl_id, "int_rate", { group: "QB", G: 9 }).text !== "—");
  t.equal(q.length, 31, "31 ranked QBs at Week 10"); t.ok(q.every((e) => e.s.pass_att >= 135));
});

test("INT rate: a QB below the minimum keeps his interception count and INT rate, with a — rank (both rules)", () => {
  const rows = [{ week: 1, box: { pass_ints: 1, pass_att: 140, pass_cmp: 90 }, snaps: null, rz: null }];
  const items = BL.rollup({ pos: "QB", cutoff: 10, box: { state: "ok", through: 10, weeks: {} } }, rows).sections[0].items;
  const it = (l) => items.find((x) => x.label === l);
  t.equal(it("Interceptions").value, "1", "the count shows"); t.equal(it("Interceptions").key, null, "the count has no rank");
  t.equal(it("INT rate").value, "0.71%", "the rate shows"); t.equal(it("INT rate").key, "int_rate");
  const own = pool([E(2, 1, 140, 10), E(4, 4, 300, 10)]), few = pool([E(2, 1, 140), E(4, 4, 300)]);
  t.equal(rank(own, 2).text, "—", "own club games: 140 < 150"); t.equal(rank(few, 2, "int_rate", 10).text, "—", "fewest games 10: 140 < 150");
  t.ok(/he has 140\.$/.test(rank(own, 2).why) && /he has 140\.$/.test(rank(few, 2, "int_rate", 10).why), "Rank details give his attempts");
  t.match(SR.helpText(), /For INT rate, once the position figures give every quarterback's own club games, the minimum becomes 15 × the games his NFL club played while he was on it/);
  t.match(SR.helpText(), /15 pass attempts × 9 games = 135/, "the bar in force today is still documented");
});

// ---------------- 5. Position chips: All + this team's positions ----------------
test("position chips: All + the positions on the selected team (every team), league order, K/P labels; no chip for a position the team lacks", async () => {
  const I = await intel(), S0 = state({ intel: I });
  // the recorded scores cover TEAM's players, so only TEAM's Performance reaches its list state offline; the chip rule (posOf) is checked for all 12
  let drawn = 0;
  for (const tm of S0.model.teams) {
    const has = ORDER.filter((g) => tm.players.some((p) => p.pos === g));
    t.deepEqual(TV.posOf(tm.players).map((g) => g[0]), has, tm.name + ": its positions");
    const h = body(V.app(state({ intel: I, teamId: tm.id }))), ch = chipsOf(h, "pfpos");
    if (!ch.length) continue;
    drawn++;
    t.deepEqual(ch.map((c) => c.v), ["all"].concat(has), tm.name + ": All + its positions");
    t.deepEqual(ch.map((c) => c.label), ["All"].concat(has.map((g) => LABEL[g] || g)));
  }
  t.ok(drawn >= 1 && chipsOf(body(V.app(state({ intel: I }))), "pfpos").length >= 2, "drawn for " + drawn + " team(s), including " + TEAM);
  const S1 = withoutPos(state({ intel: I }), TEAM, "PN"), h1 = body(V.app(S1));
  t.ok(!chipsOf(h1, "pfpos").some((c) => c.v === "PN"), "no P chip when the team has no punter");
  t.deepEqual(TV.posOf([{ pos: "DB" }, { pos: "QB" }, { pos: "PK" }]).map((g) => g[1]), ["QB", "K", "DB"], "league order, K label");
});

test("team switch: the filter stays when the new team has the position; otherwise it resets to All and says so once; search, sort and cross-team state stay", async () => {
  const I = await intel(), S0 = state({ intel: I }), other = S0.model.teams.find((x) => x.id !== TEAM);
  // keep: QB on a team with a QB
  t.deepEqual(TV.pfTeamSwitch(state({ intel: I, pf: PF({ pos: "QB" }) }), other), { pos: "QB", note: null });
  t.deepEqual(TV.pfTeamSwitch(state({ intel: I, pf: PF({ pos: "all" }) }), other), { pos: "all", note: null });
  // reset: P on a team without a punter
  const S1 = withoutPos(state({ intel: I, pf: PF({ pos: "PN", q: "zz", s: "tot" }) }), TEAM, "PN"), tm = S1.model.teams.find((x) => x.id === TEAM);
  const r = TV.pfTeamSwitch(S1, tm);
  t.deepEqual(r, { pos: "all", note: "No P on " + tm.name + ", so Position is back to All." });
  S1.pf.pos = r.pos; S1.pf.note = r.note; S1.pf.q = "";
  const h = body(V.app(S1));
  t.equal((text(h).match(/so Position is back to All\./g) || []).length, 1, "said once");
  t.ok(chipsOf(h, "pfpos").find((c) => c.v === "all").on, "All is pressed");
  S1.pf.note = null; t.doesNotMatch(text(body(V.app(S1))), /back to All/, "gone after the next action clears it");
  // a leftover filter for an absent position never empties the list silently: the view shows everyone with All pressed
  const S2 = withoutPos(state({ intel: I, pf: PF({ pos: "PN", res: { ir: true, taxi: true } }) }), TEAM, "PN"), h2 = body(V.app(S2));
  t.ok(chipsOf(h2, "pfpos").find((c) => c.v === "all").on); t.ok(cards(h2).length >= 10, "everyone is listed"); t.doesNotMatch(text(h2), /No P on/);
  // app.js: pickteam runs pfOnTeam, which changes only pos and note (search, sort, cross-team mode and open rows stay)
  t.match(appJs, /act === "pickteam"\) \{[^\n]*pfOnTeam\(\); render\(\); \}/);
  const fn = appJs.split("function pfOnTeam()")[1].split("\n  }\n")[0];
  t.match(fn, /S\.pf\.pos = r\.pos; S\.pf\.note = r\.note;/); t.doesNotMatch(fn, /S\.pf\.(q|s|xt|xpos|open|res)\b/, "nothing else in S.pf changes");
  for (const a of ["pfpos", "pfs", "pfxt"]) t.match(appJs.split('act === "' + a + '"')[1].split("\n")[0], /S\.pf\.note = null/, a + " clears the note");
  t.match(appJs.split('addEventListener("input"')[1].split("});")[0], /S\.pf\.note = null/, "typing clears the note");
  // the profile still never touches S.pf; closing restores team and scroll (R9, unchanged)
  t.doesNotMatch(appJs.split("function openProfile(")[1].split("\n  }\n")[0], /S\.pf\b/);
  t.match(appJs.split("function returnFromProfile()")[1].split("\n  }\n")[0], /S\.teamId = r\.teamId;[\s\S]*render\(\);[\s\S]*scr\.scrollTop = r\.top/);
});

// ---------------- 5. Search other teams: its own position control ----------------
function otherOnly(S, need) {
  const team = S.model.teams.find((x) => x.id === TEAM), mine = team.players.map((p) => p.name.toLowerCase());
  for (const o of S.model.teams) { if (o.id === TEAM) continue; for (const p of o.players) { if (need && !need(p)) continue; const w = p.name.split(/[ ,]+/).filter((x) => x.length >= 4)[0]; if (w && !mine.some((n) => n.includes(w.toLowerCase()))) return { p, team: o, q: w }; } }
  return null;
}
test("Search other teams: own position chips = All + every position among the matches (not limited to this team's); a position none of them has shows all, said", async () => {
  const I = await intel(), S0 = state({ intel: I });
  // a punter on another team, while this team has no punter: the other-teams control still offers P
  const hit = otherOnly(S0, (p) => p.pos === "PN"); t.ok(hit, "an other-team punter with a name unique to him");
  const S1 = withoutPos(state({ intel: I, pf: PF({ q: hit.q, xt: true }) }), TEAM, "PN"), h1 = body(V.app(S1));
  const xc = chipsOf(h1, "pfxpos"), any = TV.crossHits(S1, S1.model.teams.find((x) => x.id === TEAM), { pos: "all" }, TV.pfMatcher(hit.q));
  t.deepEqual(xc.map((c) => c.v), ["all"].concat(ORDER.filter((g) => any.some((h) => h.p.pos === g))), "All + the positions among the matches");
  t.ok(xc.some((c) => c.v === "PN" && c.label === "P"), "P is offered for the other teams although this team has none");
  t.ok(!chipsOf(h1, "pfpos").some((c) => c.v === "PN"), "while this team's chips have no P");
  t.match(h1, /<div class="chs pfpos xtp" role="group" aria-label="Position, other teams">/);
  const h2 = body(V.app(withoutPos(state({ intel: I, pf: PF({ q: hit.q, xt: true, xpos: "PN" }) }), TEAM, "PN")));
  t.ok(cards(h2).length >= 1 && cards(h2).every((c) => c.x && S0.model.byId[c.id].pos === "PN"), "P narrows the other-teams list");
  t.match(h2, /Other teams · P · rostered players only/);
  // this team's filter is K and the name is another team's QB: the local list is empty, the tap carries K over, and K is absent among the matches
  const qb = otherOnly(S0, (p) => p.pos === "QB" && !S0.model.teams.some((o) => o.id !== TEAM && o.players.some((x) => x.pos === "PK" && TV.pfMatcher(p.name.split(/[ ,]+/).filter((y) => y.length >= 4)[0])(x))));
  t.ok(qb, "an other-team QB whose name no other-team kicker shares");
  const loc = body(V.app(state({ intel: I, pf: PF({ q: qb.q, pos: "PK" }) })));
  t.match(loc, /data-act="pfxt"/, "nothing local: the action is offered");
  const h3 = body(V.app(state({ intel: I, pf: PF({ q: qb.q, pos: "PK", xt: true, xpos: "PK" }) })));
  t.match(text(h3), new RegExp("No K on another team has a name containing “" + esc(qb.q) + "”, so every position is shown\\."), "said, not silently empty");
  t.ok(cards(h3).some((c) => c.id === String(qb.p.id)), "the QB is listed");
  t.ok(chipsOf(h3, "pfxpos").find((c) => c.v === "all").on, "All pressed in the other-teams control");
  t.ok(chipsOf(h3, "pfpos").find((c) => c.v === "PK").on, "this team's filter is unchanged (K)");
  // app.js: the tap starts the control at this team's filter; its chips set only xpos, validated
  t.match(appJs, /act === "pfxt"\)[^\n]*S\.pf\.xpos = S\.pf\.pos;/);
  t.match(appJs, /act === "pfxpos"\) \{ if \(U\.tabviews\.pfPosOk\(v\)\) \{ S\.pf\.xpos = v; render\(true\); \} \}/);
  const cl = fs.readFileSync(path.join(SRC, "lib/tabviews.js"), "utf8").split("function crossList")[1].split("function perfList")[0];
  t.doesNotMatch(cl, /fetch|XMLHttpRequest|loader|load[A-Z]/, "still no read");
  t.doesNotMatch(body(V.app(state({ intel: I, pf: PF({ q: '"><i>zz', xt: true, xpos: "PK" }) }))), /"><i>zz/, "typed text escaped");
});

run("mobile2027_r10_perf");
