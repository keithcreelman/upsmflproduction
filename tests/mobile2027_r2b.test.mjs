// UPS 2027 beta, stage R2b: the roster refinement (owner authorization P1 to P6, 2026-11-20).
//   node tests/mobile2027_r2b.test.mjs
//
// Offline, over the same recorded reads as the R2 tests. What is proven here:
//   P1/P2  Contracts and Byes never show today's roster under a past week's heading; they are "as of now" whatever week was chosen,
//          Lineup and Performance keep the chosen week, and returning to them finds the same week.
//   P3     the read-only starting-decisions card: one entry per slot, no double counting, "Doubtful" is a decision not an absence,
//          kickoff only when it is not the ordinary Sunday 1:00 PM slate, Unavailable stays Unavailable, one injury chip on all four views.
//   P4     Performance: the prominent number is the labeled score of the last completed week; states for a score that is loading,
//          failed or not recorded; no projection column; narrow-screen tokens do not wrap.
//   P5     Contracts: no link to a destination that does not exist; the placeholder says where contracts are, with a working jump.
//   P6     Byes: chronological groups, today's slots only, no invented lineup, played weeks collapsed.
// The view code asks for nothing itself: these tests also pin that the read allowlist and request counts are the R2 ones.
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
const M = require(path.join(SRC, "lib/model.js"));
const D = require(path.join(SRC, "lib/data.js"));
const R = require(path.join(SRC, "lib/roster.js"));
const V = require(path.join(SRC, "lib/views.js"));
const CSS = fs.readFileSync(path.join(SRC, "styles.css"), "utf8");

const CFG = { workerBase: "https://upsmflproduction.keith-creelman.workers.dev", leagueId: "74598", season: "2026" };
const clone = (x) => JSON.parse(JSON.stringify(x));
const TEAM = "0009", SHORT = "0010";
const model = () => M.build(FX.roster_workbench, FX.league, FX.weekly_results, 11, 2026);
const VIEWS = ["lineup", "performance", "contracts", "byes"];

async function intelFor(over) {
  const fetchFake = async (url) => {
    const u = new URL(url); let body = {};
    if (u.pathname === "/api/player-status") body = (over && over.status) || FX2.player_status;
    else if (u.pathname === "/api/lineup-matchups") body = Object.assign({}, FX2.lineup_matchups_w11, { week: Number(u.searchParams.get("W")) });
    else if (u.searchParams.get("TYPE") === "weeklyResults") body = u.searchParams.get("W") === "10" ? FX2.weekly_results_w10 : FX.weekly_results;
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const L = D.createLoader(CFG, fetchFake), rec = (r) => ({ state: r.state, data: r.data, at: r.at || Date.now() });
  return { status: rec(await L.loadStatus()), mu: { 11: rec(await L.loadMatchups(11)), 10: rec(await L.loadMatchups(10)) }, wk: { 11: rec(await L.loadWeekly(11)), 10: rec(await L.loadWeekly(10)) } };
}
const state = (intel, over) => ({
  model: model(), load: { core: "ok", coreNotes: [] }, penalty: { state: "idle" }, teamId: TEAM, tab: "team", sub: "roster", view: "lineup",
  open: {}, flags: {}, profile: null, sheet: null, skin: "system", vib: "1", build: "test", requestLog: [], gdef: "needs", wk: null, intel,
  requestSummary: { requests: 0, ok: 0, failed: 0, refused: 0, nonGet: 0 }, ...(over || {}),
});
const text = (html) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
// one player's roster row (not his entry in the starting-decisions card, which has no slot or position tag), cut off before whatever follows it
const rowOf = (html, pid) => { const r = html.split('<div class="rx').find((x) => x.includes('data-pid="' + pid + '"') && /^[^>]*>(<span class="tag )/.test(x)); return r && r.split(/<div class="(?:ex|grp|card|lbl|chs)/)[0]; };
const starterOf = (S, i) => R.lineupFor(S, S.model.teams.find((x) => x.id === TEAM), 11).slots[i].player;
const statusWith = (ids) => { const s = clone(FX2.player_status); Object.entries(ids).forEach(([id, v]) => { s.players[id] = v; }); return s; };

// ───────────────────────── P1 and P2: one week context ─────────────────────────

test("P1/P2: Contracts and Byes are always 'as of now', whatever week was chosen; Lineup and Performance keep the chosen week", async () => {
  const intel = await intelFor();
  t.deepEqual(R.viewWeek(state(intel, { view: "lineup", wk: 10 })), { cur: 11, sel: 10, past: true }, "Lineup honors the chosen week");
  t.deepEqual(R.viewWeek(state(intel, { view: "performance", wk: 10 })), { cur: 11, sel: 10, past: true });
  t.deepEqual(R.viewWeek(state(intel, { view: "contracts", wk: 10 })), { cur: 11, sel: 11, past: false }, "Contracts uses the current week");
  t.deepEqual(R.viewWeek(state(intel, { view: "byes", wk: 10 })), { cur: 11, sel: 11, past: false }, "Byes uses the current week");
  // the screen with a past week chosen is the same screen as with none chosen, for the two as-of-now views
  ["contracts", "byes"].forEach((view) => {
    t.equal(V.rosterBody(state(intel, { view, wk: 10 })), V.rosterBody(state(intel, { view })), view + ": a chosen past week changes nothing on this screen, byte for byte");
    t.equal(V.rosterBody(state(intel, { view, wk: 3 })), V.rosterBody(state(intel, { view })));
    const tx = text(V.rosterBody(state(intel, { view, wk: 10 })));
    t.match(tx, /As of now · Week 11 · This view always shows today’s roster, injuries and lineup\./);
    t.doesNotMatch(tx, /Week 10|Week 3\b|Played · as MFL recorded it/);
  });
  // Contracts: today's starters under today's week heading
  t.match(text(V.rosterBody(state(intel, { view: "contracts", wk: 10 }))), /Week 11 starters · 18 of 18/);
  // the two week-aware views still show the chosen week
  t.match(text(V.rosterBody(state(intel, { view: "lineup", wk: 10 }))), /Week 10 starters · 18 of 18/);
  t.match(text(V.rosterBody(state(intel, { view: "performance", wk: 10 }))), /Week 10 starters · 18 of 18/);
  t.match(V.rosterBody(state(intel, { view: "lineup", wk: 10 })), /class="wsel past"/);
  t.doesNotMatch(V.rosterBody(state(intel, { view: "contracts", wk: 10 })), /class="wsel/);
});

test("P1: a past week's number never leaks into an as-of-now screen: a bye or an injury is judged against the CURRENT week only", async () => {
  const intel = await intelFor();
  const S0 = state(intel), p = starterOf(S0, 0), q = starterOf(S0, 1);
  // p's bye is the PAST week 10 (long over), q's bye is the current week 11: only q needs attention, with or without a past week chosen
  const m = model(); m.byId[p.id].bye = 10; m.byId[q.id].bye = 11;
  [null, 10, 5].forEach((wk) => ["contracts", "byes"].forEach((view) => {
    const tx = text(V.rosterBody(state(intel, { view, wk, model: m })));
    t.match(tx, /18 of 18 starters · 1 needs attention/, view + " with week " + wk + " chosen: exactly the current week's one bye");
  }));
  // and on the Byes screen the groups are built from the current week: Week 10's bye is 'already played', Week 11's is 'this week'
  const byes = text(V.rosterBody(state(intel, { view: "byes", wk: 10, model: m })));
  t.match(byes, /This week · Week 11 · 1 current starter on bye: RB1/); t.doesNotMatch(byes, /Week 10 · 1 current starter/);
  const g = R.byeGroups(state(intel, { model: m }), m.teams.find((x) => x.id === TEAM), 11, R.lineupFor(state(intel, { model: m }), m.teams.find((x) => x.id === TEAM), 11));
  t.ok(g.past.some((x) => x.id === p.id), "the Week 10 bye is in the played group"); t.ok(!g.groups.some((x) => x.week === 10));
});

// ───────────────────────── P3: the starting-decisions card ─────────────────────────

test("P3: the card lists each slot that needs attention once: OUT, an MFL designation, Doubtful, a bye; Questionable is only a chip", async () => {
  const base = await intelFor(), S0 = state(base);
  const [a, b, c, d] = [0, 1, 2, 3].map((i) => starterOf(S0, i));
  // control: the recorded week has only Questionable starters, so nothing needs attention
  const a0 = R.attention(S0, R.lineupFor(S0, S0.model.teams.find((x) => x.id === TEAM), 11), 11);
  t.equal(a0.n, 0, "Questionable does not count"); t.equal(a0.items.length, 0); t.equal(a0.injuriesChecked, true);
  t.match(text(V.rosterBody(S0)), /18 of 18 starters · nothing needs attention/); t.match(V.rosterBody(S0), /class="card okc"/);
  const st = statusWith({
    [a.id]: { mfl: { status: "Out", week: 11, details: "Knee" } },
    [b.id]: { mfl: { status: "Doubtful", week: 11, details: "Ankle" } },
    [c.id]: { roster: { status: "IR", label: "Injured reserve", chip: "IR", detail: "Hamstring", exp_return: null } },
  });
  const intel = await intelFor({ status: st }), m = model(); m.byId[a.id].bye = 11; m.byId[d.id].bye = 11; // a is Out AND on a bye; d is only on a bye
  const S = state(intel, { model: m }), lineup = R.lineupFor(S, m.teams.find((x) => x.id === TEAM), 11), at = R.attention(S, lineup, 11);
  t.equal(at.n, 4, "four slots, not five issues"); t.equal(at.items.length, 4);
  t.equal(new Set(at.items.map((x) => x.player.id)).size, 4, "one entry per player");
  const byId = Object.fromEntries(at.items.map((x) => [x.player.id, x.issues.map((i) => i.kind)]));
  t.deepEqual(byId[a.id], ["out", "bye"], "OUT and bye on the same slot are ONE entry carrying both reasons");
  t.deepEqual(byId[b.id], ["doubtful"]); t.deepEqual(byId[c.id], ["designation"]); t.deepEqual(byId[d.id], ["bye"]);
  const html = V.rosterBody(S), tx = text(html);
  t.match(tx, /18 of 18 starters · 4 need attention/);
  t.equal((html.match(/class="card warnc"/g) || []).length, 1, "one card");
  // each entry: slot, player, the issue, position, opponent (kickoff when not a bye)
  t.match(tx, new RegExp("QB1 · " + a.name + " Out · Bye week · " + a.pos + " (?!·)"), "Out plus Bye: one line, no opponent or kickoff for a bye");
  t.match(tx, new RegExp(b.name + " Doubtful: a decision may be needed · " + b.pos + " · (vs|@) \\w+ · Kickoff "));
  t.match(tx, new RegExp(c.name + " MFL designation: IR · " + c.pos + " · (vs|@) \\w+ · Kickoff "));
  t.match(tx, new RegExp(d.name + " Bye week · " + d.pos + " (?!·)"));
  // Doubtful means a decision may be needed, not that the player is out: the wording says so, and nowhere calls him out
  t.match(tx, /“Doubtful” means a decision may be needed, not that a player is out\./);
  t.doesNotMatch(tx, new RegExp(b.name + " Out\\b"));
  // no write control: no Replace, no Swap, no button that is not a profile or navigation
  t.doesNotMatch(tx, /\b(Replace|Swap|Start him|Sit him|Make the move)\b/i);
  const acts = [...html.matchAll(/data-act="([a-z]+)"/g)].map((m2) => m2[1]);
  t.ok(acts.every((x) => ["card", "view", "pickweek", "weeks", "grp", "expall", "teams", "nav", "sub"].includes(x)), "only read-only controls: " + [...new Set(acts)].join(","));
  t.match(tx, /Read only: nothing here can change the lineup\./);
});

test("P3: empty slots are genuine ones only; a starter that fits no slot is reported as that, never as an empty slot as well", async () => {
  const intel = await intelFor();
  // a short lineup: two truly empty slots, nobody left over
  const m = model(), tm = m.teams.find((x) => x.id === TEAM); tm.lineup.ids = tm.lineup.ids.slice(0, 16);
  const S = state(intel, { model: m }), at = R.attention(S, R.lineupFor(S, tm, 11), 11);
  t.equal(at.empties.length, 2); t.equal(at.extras.length, 0); t.equal(at.n, 2);
  const tx = text(V.rosterBody(S)); t.match(tx, /16 of 18 starters · 2 need attention/);
  t.equal((tx.match(/· Empty No starter is set for this slot/g) || []).length, 2);
  // a third QB cannot take any slot (QB1 and the Superflex are full): he is the leftover, and the slot he left is NOT also reported empty
  const m2 = model(), tm2 = m2.teams.find((x) => x.id === TEAM), S2 = state(intel, { model: m2 });
  const dbs = R.lineupFor(S2, tm2, 11).slots.filter((x) => x.player && x.player.pos === "DB").map((x) => x.player);
  m2.byId[dbs[0].id].pos = "QB"; m2.byId[dbs[0].id].rawPos = "QB";
  const lu = R.lineupFor(S2, tm2, 11), at2 = R.attention(S2, lu, 11);
  t.equal(lu.extra.length, 1, "the QB fits no slot"); t.equal(at2.empties.length, 0, "no empty slot is reported while a starter is left over"); t.equal(at2.n, 1);
  const tx2 = text(V.rosterBody(S2)); t.match(tx2, /1 needs attention/); t.match(tx2, new RegExp(dbs[0].name + " Starter fits no lineup slot"));
  t.doesNotMatch(tx2, /· Empty No starter is set/);
});

test("P3: the injury read missing is said, not hidden: 'injuries not checked', never 'nothing needs attention'", async () => {
  const intel = await intelFor();
  ["loading", "error"].forEach((st) => VIEWS.forEach((view) => {
    const html = V.rosterBody(state({ ...intel, status: { state: st, error: "x" } }, { view })), tx = text(html);
    t.match(tx, /18 of 18 starters · injuries not checked/, view + " / " + st); t.doesNotMatch(tx, /nothing needs attention/);
  }));
  t.match(text(V.rosterBody(state({ ...intel, status: { state: "error", error: "x" } }))), /Injury status is not available yet, so injuries are not counted here\./);
  // a bye is a schedule fact, not an injury: it still counts without an injury read
  const m = model(), S0 = state(intel); m.byId[starterOf(S0, 2).id].bye = 11;
  t.match(text(V.rosterBody(state({ ...intel, status: { state: "error", error: "x" } }, { model: m }))), /18 of 18 starters · 1 needs attention/);
});

test("P3: a kickoff shows on a row only when it is not Sunday 1:00 PM Eastern; an unknown time reads 'Kickoff unavailable', never a guess", async () => {
  const intel = await intelFor(), S = state(intel), lu = R.lineupFor(S, S.model.teams.find((x) => x.id === TEAM), 11);
  const info = lu.slots.map((x) => ({ p: x.player, k: R.kickoffInfo(S, x.player, 11) }));
  const ordinary = info.filter((x) => x.k.ordinary), notable = info.filter((x) => x.k.state === "known" && !x.k.ordinary);
  t.ok(ordinary.length >= 3 && notable.length >= 3, "the recorded week has both kinds of starter");
  t.equal(R.ORDINARY_SLATE, "Sun 1:00 PM");
  const html = V.rosterBody(S);
  ordinary.forEach((x) => t.doesNotMatch(text(rowOf(html, x.p.id)), /\d{1,2}:\d{2} [AP]M|Kickoff/, x.p.name + ": ordinary slate, no kickoff"));
  notable.forEach((x) => t.match(text(rowOf(html, x.p.id)), new RegExp((x.k.text + "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), x.p.name + ": " + x.k.text));
  // Eastern, and said once for the whole list rather than on every row
  t.match(text(html), /A kickoff time is shown on a row only when it is not Sunday 1:00 PM \(Eastern\)\./);
  // a game whose time is not known: Unavailable, and the opponent still shows
  const u = notable[0].p, mu = clone(intel.mu[11].data); mu.games[u.nflTeam].kickoff = null;
  const r1 = text(rowOf(V.rosterBody(state({ ...intel, mu: { ...intel.mu, 11: { state: "ok", data: mu, at: Date.now() } } })), u.id));
  t.match(r1, /Kickoff unavailable/); t.match(r1, new RegExp(u.nflTeam + " · (vs|@) \\w+ · Kickoff unavailable"));
  t.equal(R.kickoffInfo(state({ ...intel, mu: { ...intel.mu, 11: { state: "ok", data: mu, at: Date.now() } } }), u, 11).state, "unknown");
  // the games read failed or is still out: no kickoff text at all (and the opponent says why)
  ["error", "loading"].forEach((st) => {
    const r2 = text(rowOf(V.rosterBody(state({ ...intel, mu: { 11: { state: st, error: "x" } } })), u.id));
    t.doesNotMatch(r2, /Kickoff|\d:\d\d [AP]M/); t.equal(R.kickoffInfo(state({ ...intel, mu: { 11: { state: st } } }), u, 11).state, "none");
  });
  // a bye week has no kickoff to show
  const m = model(); m.byId[u.id].bye = 11;
  t.doesNotMatch(text(rowOf(V.rosterBody(state(intel, { model: m })), u.id)), /\d:\d\d [AP]M|Kickoff/);
  // Performance, Contracts and Byes rows do not carry kickoff times (Lineup only)
  ["performance", "contracts", "byes"].forEach((view) => t.doesNotMatch(text(V.rosterBody(state(intel, { view, open: { bw13: true } }))), /Kickoff|\b(Sun|Mon|Thu|Sat) \d{1,2}:\d{2} [AP]M/, view));
});

test("P3: one injury chip, the same chip, on all four views (and a profile-free read of the same player)", async () => {
  const S0 = state(await intelFor()), out = starterOf(S0, 4), q = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17].map((i) => starterOf(S0, i)).find((p) => p.name === "Brock Bowers");
  t.ok(q, "the recorded Questionable starter");
  const intel = await intelFor({ status: statusWith({ [out.id]: { mfl: { status: "Out", week: 11, details: "Knee" } } }) });
  const chipsOf = (view, pid) => { const r = rowOf(V.rosterBody(state(intel, { view, open: { bwpast: true, bwnone: true } })), pid); t.ok(r, view + ": the player's row is on the screen"); return [...r.matchAll(/<span class="chip (?:wn|cr)">([^<]*)<\/span>/g)].map((x) => x[1]).filter((x) => !/Bye|Final year/.test(x)); };
  const outChips = VIEWS.map((v) => chipsOf(v, out.id)), qChips = VIEWS.map((v) => chipsOf(v, q.id));
  outChips.forEach((c, i) => { t.equal(c.length, 1, VIEWS[i] + ": exactly one injury chip for the Out starter"); t.match(c[0], /OUT/); });
  qChips.forEach((c, i) => { t.equal(c.length, 1, VIEWS[i] + ": exactly one injury chip for the Questionable starter"); t.match(c[0], /Questionable/); });
  t.equal(new Set(outChips.map((c) => c[0])).size, 1, "the same chip on every view"); t.equal(new Set(qChips.map((c) => c[0])).size, 1);
  // a past week draws no chips (an injury is a today fact)
  ["lineup", "performance"].forEach((view) => t.doesNotMatch(V.rosterBody(state(intel, { view, wk: 10 })), /■ OUT|▲ Questionable/, view + " in a past week"));
  // the bye chip is for starters on the two week-aware views; Contracts and Byes use words
  const m = model(); m.byId[out.id].bye = 11;
  t.match(rowOf(V.rosterBody(state(intel, { view: "lineup", model: m })), out.id), /▲ Bye week/); t.match(rowOf(V.rosterBody(state(intel, { view: "performance", model: m })), out.id), /▲ Bye week/);
  t.doesNotMatch(rowOf(V.rosterBody(state(intel, { view: "contracts", model: m })), out.id), /▲ Bye week/);
});

// ───────────────────────── P4: Performance ─────────────────────────

test("P4: the bold number is the score of the completed week and keeps its label; incomplete, loading and failed reads are said, never made up", async () => {
  const intel = await intelFor(), S = state(intel, { view: "performance" }), html = V.rosterBody(S), tx = text(html);
  const sc10 = Object.fromEntries(FX2.weekly_results_w10.weeklyResults.matchup.flatMap((x) => x.franchise).filter((f) => f.id === TEAM)[0].player.map((p) => [p.id, p.score]));
  const b = starterOf(S, 0), want = R.pts(Number(sc10[b.id]));
  t.match(rowOf(html, b.id), new RegExp("<b>" + want.replace(".", "\\.") + '</b><span class="mu sm">Wk 10</span>'), "the recorded Week 10 score with 'Wk 10' under it");
  t.match(tx, /Scores are for Week 10, the last completed week\. Week 11 is not complete\./, "the page says the current week is not complete");
  t.doesNotMatch(tx, /Week 11 (score|points)|Wk 11 [\d.]+/, "no score is shown for the week in progress");
  t.match(tx, /Team score [\d.]+ \(Wk 10\) · Projection Unavailable/);
  // a player with no recorded score: a dash, with the week label, not 0
  const none = clone(FX2.weekly_results_w10); none.weeklyResults.matchup.flatMap((x) => x.franchise).filter((f) => f.id === TEAM).forEach((f) => f.player.forEach((p) => { if (p.id === b.id) p.score = ""; }));
  const r0 = rowOf(V.rosterBody(state({ ...intel, wk: { ...intel.wk, 10: { state: "ok", data: none, at: Date.now() } } }, { view: "performance" })), b.id);
  t.match(r0, /<b>—<\/b><span class="mu sm">Wk 10<\/span>/); t.doesNotMatch(r0, /<b>0(\.0)?<\/b>/);
  // the scores read is still out: an ellipsis, not a dash and not a number; the team line says so too
  const ld = V.rosterBody(state({ ...intel, wk: { 11: intel.wk[11] } }, { view: "performance" }));
  t.match(rowOf(ld, b.id), /<b>…<\/b>/); t.match(text(ld), /Team score … · Projection Unavailable/);
  // the scores read failed: a dash labeled Unavailable, the team score Unavailable, and no Wk label that would pass for a score
  const er = V.rosterBody(state({ ...intel, wk: { ...intel.wk, 10: { state: "error", error: "HTTP 502" } } }, { view: "performance" }));
  t.match(rowOf(er, b.id), /<b>—<\/b><span class="mu sm">Unavailable<\/span>/); t.match(text(er), /Team score Unavailable · Projection Unavailable/);
  t.doesNotMatch(er, /<b>0(\.0)?<\/b>/);
  // no completed week yet (season week 1): no score week at all, no label, no invented number
  const m1 = M.build(FX.roster_workbench, FX.league, FX.weekly_results, 1, 2026), S1 = state({ ...intel, wk: {}, mu: {} }, { view: "performance", model: m1 });
  t.equal(R.scoreWeek(R.weekInfo(S1)), null);
  const h1 = V.rosterBody(S1); t.doesNotMatch(h1, /<b>\d+\.\d<\/b><span class="mu sm">Wk/); t.doesNotMatch(text(h1), /Scores are for Week/);
  t.match(text(h1), /No week has been completed yet, so there are no scores to show\. Week 1 is not complete\./); t.doesNotMatch(text(h1), /Week —/);
  // the projection is said once and never drawn as a column of dashes
  t.equal((tx.match(/Projection Unavailable/g) || []).length, 1); t.doesNotMatch(html, />proj</); t.equal((html.match(/<b>—<\/b>/g) || []).length, (html.match(/<b>—<\/b>/g) || []).length);
  t.ok((html.match(/<b>—<\/b>/g) || []).length <= 5, "dashes only where a score is really missing, not one per row");
});

test("P4: narrow screens (320 px): the opponent, kickoff and week tokens cannot wrap in the middle", async () => {
  const intel = await intelFor(), html = V.rosterBody(state(intel, { view: "performance" })), lhtml = V.rosterBody(state(intel));
  t.match(CSS, /\.nw\{white-space:nowrap\}/, "the no-wrap rule exists");
  // every opponent token is a single non-breaking unit
  const opps = [...html.matchAll(/<span class="nw">((?:vs|@) [A-Z]{2,3})<\/span>/g)].map((m) => m[1]);
  t.ok(opps.length >= 15, "opponent tokens are wrapped: " + opps.length);
  t.doesNotMatch(html, /[^>](vs|@) [A-Z]{2,3} · Season avg/, "no bare opponent text left outside a no-wrap token");
  // kickoff tokens too
  const kicks = [...lhtml.matchAll(/<span class="nw">((?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{1,2}:\d{2} [AP]M)<\/span>/g)].map((m) => m[1]);
  t.ok(kicks.length >= 3, "kickoff tokens are wrapped: " + kicks.length);
  // a past week's rows: "BUF now" and "Opponent unavailable" are single units too, so a narrow screen breaks between them, not inside them
  const past = V.rosterBody(state(intel, { view: "performance", wk: 10 }));
  t.match(past, /<span class="nw">[A-Z]{2,3} now<\/span> · <span class="nw">Opponent unavailable<\/span>/);
  // the score column does not shrink and its label sits under the number
  t.match(CSS, /\.rx \.rt\{flex:0 0 auto/); t.match(html, /<div class="rt"><b>[\d.—…]+<\/b><span class="mu sm">Wk 10<\/span><\/div>/);
  // no fixed widths that would overflow 320 px in the roster rows
  t.doesNotMatch(CSS.split("\n").filter((l) => /^\.rx/.test(l)).join("\n"), /min-width:\s*(?:[3-9]\d{2}|\d{4})px/);
});

// ───────────────────────── P5: Contracts ─────────────────────────

test("P5: no link to a Contracts destination that does not exist; the placeholder says where contracts are and jumps there", async () => {
  const intel = await intelFor();
  VIEWS.forEach((view) => [null, 10].forEach((wk) => {
    const html = V.rosterBody(state(intel, { view, wk }));
    t.doesNotMatch(text(html), /Open full Contracts|full Contracts/, view + " / " + wk);
    t.doesNotMatch(html, /data-act="sub" data-v="contracts"/);
  }));
  // the top-level placeholder: explains, no dead end, one working jump (an in-app view change that asks for nothing)
  const ph = V.app(state(intel, { sub: "contracts" })), tx = text(ph);
  t.match(tx, /The all-years Contracts table is not in this preview yet\./);
  t.match(tx, /Contract information is available now in two places: Roster › Contracts \(salary, years left, final year, and the IR and taxi cap notes\) and each player’s profile \(year-by-year amounts, earned to date, guarantee\)\./);
  t.match(ph, /data-act="gotoview" data-v="contracts"[^>]*>Open Roster › Contracts</);
  t.doesNotMatch(tx, /not in Preview 0/i, "no bare 'not here'");
});

// ───────────────────────── P6: Byes ─────────────────────────

test("P6: Byes groups are chronological, name today's slots only, collapse the played weeks, and invent nothing", async () => {
  const intel = await intelFor(), S = state(intel, { view: "byes" });
  // a team with a Week 12 bye: five current starters (the owner's example: "Week 12 · 5 current starters on bye: QB1, SF, WR1, DF, DB1")
  const m = model(), tm = m.teams.find((x) => x.id === TEAM), lu = R.lineupFor(S, tm, 11);
  const tag = (t2) => lu.slots.find((x) => x.slot.tag === t2).player;
  ["QB1", "SF", "WR1", "DF", "DB1"].forEach((t2) => { m.byId[tag(t2).id].bye = 12; });
  const html = V.rosterBody(state(intel, { view: "byes", model: m })), tx = text(html);
  t.match(tx, /Week 12 · 5 current starters on bye: QB1, WR1, SF, DB1, DF/, "the authorized wording: week, count, slot tags in today's lineup order");
  t.match(tx, /Next byes: Week 11 · 0 current starters · Week 12 · 5 current starters/);
  // a bench player on the same bye week sits in the group but is not a starter and takes no slot tag
  t.doesNotMatch(tx, /Week 12 · 6 current starters/);
  // groups are in week order on the page, played weeks last and closed
  const keys = [...html.matchAll(/data-g="(bw[\dp][a-z\d]*)"/g)].map((x) => x[1]);
  t.ok(keys.indexOf("bw11") < keys.indexOf("bw12") && keys.indexOf("bw12") < keys.indexOf("bwpast"), "order: " + keys.join(","));
  t.match(html, /data-g="bwpast" aria-expanded="false"/);
  // the note: today's slots, not a prediction
  t.match(tx, /Slots are today’s lineup \(Week 11\)\. The lineup for a later week is not set, so these players may not fill the same slots then\./);
  t.doesNotMatch(tx, /Week 12 lineup|Week 12 starters|will start|will fill|projected/i);
  // no lineup read → no slot is claimed at all
  const nolu = state(intel, { view: "byes", model: (() => { const m3 = model(); m3.teams.find((x) => x.id === TEAM).lineup.ids = []; return m3; })() });
  t.doesNotMatch(text(V.rosterBody(nolu)), /current starters? on bye: [A-Z]/);
  // a played bye never shows as 'next'
  t.doesNotMatch(tx.split("Already played")[0].split("Next byes:")[1].split("Slots are")[0], /Week (?:[1-9]|10) ·/);
  // with the injury read out, Byes still works (a bye is a schedule fact)
  t.match(text(V.rosterBody(state({ ...intel, status: { state: "error", error: "x" } }, { view: "byes", model: m }))), /Week 12 · 5 current starters on bye: QB1, WR1, SF, DB1, DF/);
});

await run("mobile2027_r2b");
