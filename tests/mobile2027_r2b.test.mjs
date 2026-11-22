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
const VIEWS = ["lineup", "byes"];

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

test("P1/P2: Byes is always 'as of now', whatever week was chosen; Lineup keeps the chosen week", async () => {
  const intel = await intelFor();
  t.deepEqual(R.viewWeek(state(intel, { view: "lineup", wk: 10 })), { cur: 11, sel: 10, past: true }, "Lineup honors the chosen week");
  t.deepEqual(R.viewWeek(state(intel, { view: "byes", wk: 10 })), { cur: 11, sel: 11, past: false }, "Byes uses the current week");
  // the screen with a past week chosen is the same screen as with none chosen, for the two as-of-now views
  ["byes"].forEach((view) => {
    t.equal(V.rosterBody(state(intel, { view, wk: 10 })), V.rosterBody(state(intel, { view })), view + ": a chosen past week changes nothing on this screen, byte for byte");
    t.equal(V.rosterBody(state(intel, { view, wk: 3 })), V.rosterBody(state(intel, { view })));
    const tx = text(V.rosterBody(state(intel, { view, wk: 10 })));
    t.match(tx, /As of now · Week 11 · This view always shows today’s roster, injuries and lineup\./);
    t.doesNotMatch(tx, /Week 10|Week 3\b|Played · as MFL recorded it/);
  });
  // the week-aware view still shows the chosen week
  t.match(text(V.rosterBody(state(intel, { view: "lineup", wk: 10 }))), /Recorded starters · Week 10 · 18 of 18/);
  t.match(V.rosterBody(state(intel, { view: "lineup", wk: 10 })), /class="wsel past"/);
  t.doesNotMatch(V.rosterBody(state(intel, { view: "byes", wk: 10 })), /class="wsel/);
});

test("P1: a past week's number never leaks into an as-of-now screen: a bye or an injury is judged against the CURRENT week only", async () => {
  const intel = await intelFor();
  const S0 = state(intel), p = starterOf(S0, 0), q = starterOf(S0, 1);
  // p's bye is the PAST week 10 (long over), q's bye is the current week 11: only q needs attention, with or without a past week chosen
  const m = model(); m.byId[p.id].bye = 10; m.byId[q.id].bye = 11;
  [null, 10, 5].forEach((wk) => ["byes"].forEach((view) => {
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
  t.ok(acts.every((x) => ["card", "view", "pickweek", "weeks", "grp", "expall", "teams", "nav", "sub", "help"].includes(x)), "only read-only controls: " + [...new Set(acts)].join(","));
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

test("P3: one injury chip, the same chip, on both roster views (and a profile-free read of the same player)", async () => {
  const S0 = state(await intelFor()), out = starterOf(S0, 4), q = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17].map((i) => starterOf(S0, i)).find((p) => p.name === "Brock Bowers");
  t.ok(q, "the recorded Questionable starter");
  const intel = await intelFor({ status: statusWith({ [out.id]: { mfl: { status: "Out", week: 11, details: "Knee" } } }) });
  const chipsOf = (view, pid) => { const r = rowOf(V.rosterBody(state(intel, { view, open: { bwpast: true, bwnone: true } })), pid); t.ok(r, view + ": the player's row is on the screen"); return [...r.matchAll(/<span class="chip (?:wn|cr)">([^<]*)<\/span>/g)].map((x) => x[1]).filter((x) => !/Bye|Final year/.test(x)); };
  const outChips = VIEWS.map((v) => chipsOf(v, out.id)), qChips = VIEWS.map((v) => chipsOf(v, q.id));
  outChips.forEach((c, i) => { t.equal(c.length, 1, VIEWS[i] + ": exactly one injury chip for the Out starter"); t.match(c[0], /OUT/); });
  qChips.forEach((c, i) => { t.equal(c.length, 1, VIEWS[i] + ": exactly one injury chip for the Questionable starter"); t.match(c[0], /Questionable/); });
  t.equal(new Set(outChips.map((c) => c[0])).size, 1, "the same chip on every view"); t.equal(new Set(qChips.map((c) => c[0])).size, 1);
  // a past week draws no chips (an injury is a today fact)
  ["lineup"].forEach((view) => t.doesNotMatch(V.rosterBody(state(intel, { view, wk: 10 })), /■ OUT|▲ Questionable/, view + " in a past week"));
  // the bye chip is for starters on the Lineup view; Byes uses words
  const m = model(); m.byId[out.id].bye = 11;
  t.match(rowOf(V.rosterBody(state(intel, { view: "lineup", model: m })), out.id), /▲ Bye week/);
  t.doesNotMatch(rowOf(V.rosterBody(state(intel, { view: "byes", model: m })), out.id), /▲ Bye week/);
});

// ───────────────────────── P4: Performance ─────────────────────────

test("P4: narrow screens (320 px): the opponent, kickoff and week tokens cannot wrap in the middle", async () => {
  const intel = await intelFor(), html = V.rosterBody(state(intel)), lhtml = html;
  t.match(CSS, /\.nw\{white-space:nowrap\}/, "the no-wrap rule exists");
  // every opponent token is a single non-breaking unit
  const opps = [...html.matchAll(/<span class="nw">((?:vs|@) [A-Z]{2,3})<\/span>/g)].map((m) => m[1]);
  t.ok(opps.length >= 15, "opponent tokens are wrapped: " + opps.length);
  // kickoff tokens too
  const kicks = [...lhtml.matchAll(/<span class="nw">((?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{1,2}:\d{2} [AP]M)<\/span>/g)].map((m) => m[1]);
  t.ok(kicks.length >= 3, "kickoff tokens are wrapped: " + kicks.length);
  // a past week's rows: "BUF now" and "Opponent unavailable" are single units too, so a narrow screen breaks between them, not inside them
  const past = V.rosterBody(state(intel, { wk: 10 }));
  t.match(past, /<span class="nw">[A-Z]{2,3} now<\/span> · <span class="nw">Opponent unavailable<\/span>/);
  // the score column does not shrink and its label sits under the number
  t.match(CSS, /\.rx \.rt\{flex:0 0 auto/); t.match(past, /<div class="rt"><b>[\d.—…]+<\/b><span class="mu sm">Wk 10<\/span><\/div>/);
  // no fixed widths that would overflow 320 px in the roster rows
  t.doesNotMatch(CSS.split("\n").filter((l) => /^\.rx/.test(l)).join("\n"), /min-width:\s*(?:[3-9]\d{2}|\d{4})px/);
});

// ───────────────────────── P5: Contracts ─────────────────────────

test("P5: the roster views carry no link to a Contracts destination; Team › Contracts is a real tab with no jump into Cap & picks", async () => {
  const intel = await intelFor();
  VIEWS.forEach((view) => [null, 10].forEach((wk) => {
    const html = V.rosterBody(state(intel, { view, wk }));
    t.doesNotMatch(text(html), /Open full Contracts|full Contracts/, view + " / " + wk);
    t.doesNotMatch(html, /data-act="sub" data-v="contracts"/);
  }));
  // Team › Contracts is a real tab now (R3): it says what it is, carries no jump into Cap & picks, and the only way to Cap & picks is its own tab
  const ph = V.app(state(intel, { sub: "contracts" })), tx = text(ph);
  t.match(tx, /Recorded salary, not cap space/); t.doesNotMatch(tx, /Cap space, adjustments and penalties are not part of this preview/);
  t.doesNotMatch(ph, /gotoview/); t.equal((ph.match(/data-v="cap"/g) || []).length, 1, "only the tab itself points at Cap & picks");
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

// ───────────────────────── P3 / Codex MAT-1: an EXPIRED injury read is not "checked" ─────────────────────────
// The resolver (site/shared/injury_status.js) refuses a read older than its TTL (5 minutes) and draws no chips from it. The card used to
// look only at the read's state, so an idle screen showed the green "nothing needs attention" over an injury read it no longer trusted.
// The clock is the state's own (`nowMs`), the one the chips and the note already use; nothing here waits or reads the real time.

test("MAT-1: an expired injury read is never an all-clear; the TTL boundary, known bye warnings, and recovery on a fresh read", async () => {
  const TTL = globalThis.UPSInjuryStatus.TTL, T0 = 1700000000000, a = starterOf(state(await intelFor()), 0), b = starterOf(state(await intelFor()), 1);
  const out = statusWith({ [a.id]: { mfl: { status: "Out", week: 11, details: "Knee" } } });
  const base = await intelFor({ status: out }), m = model(); m.byId[b.id].bye = 11; // b is on a bye: a schedule fact, known without any injury read
  const at = (when) => ({ ...base, status: { state: "ok", data: base.status.data, at: when } });
  const S = (intel, now, over) => state(intel, { model: m, nowMs: now, ...(over || {}) }), lu = (s) => R.lineupFor(s, s.model.teams.find((x) => x.id === TEAM), 11);

  // fresh, and exactly at the limit (the resolver's comparison is "not older than TTL"): the OUT starter and the bye both count
  [T0, T0 + 1000, T0 + TTL].forEach((now) => {
    const s = S(at(T0), now), x = R.attention(s, lu(s), 11);
    t.equal(R.injuryFresh(s), true, "fresh at +" + (now - T0)); t.equal(x.injuriesChecked, true); t.equal(x.injuryState, "ok");
    t.equal(x.n, 2, "OUT and bye are two slots"); t.ok(R.injuryChip(s, a), "the resolver draws the chip");
    t.match(text(V.rosterBody(s)), /18 of 18 starters · 2 need attention/); t.doesNotMatch(text(V.rosterBody(s)), /injuries not checked|not available yet/);
  });

  // one millisecond past the limit, SAME data and SAME state, only the clock moved (the screen idled): the resolver draws nothing and the card says so
  const old = S(at(T0), T0 + TTL + 1), xo = R.attention(old, lu(old), 11);
  t.equal(R.injuryFresh(old), false); t.equal(R.injuryChip(old, a), null, "the resolver refuses the expired read");
  t.equal(xo.injuriesChecked, false, "the card does not count an expired read as checked"); t.equal(xo.injuryState, "stale");
  t.equal(R.injuryNote(old), "Checking injury status…", "the card agrees with the resolver's own note");
  t.equal(xo.n, 1, "the known bye is still reported; the OUT starter is not invented from an expired read");
  VIEWS.forEach((view) => {
    const tx = text(V.rosterBody(S(at(T0), T0 + TTL + 1, { view })));
    t.match(tx, /18 of 18 starters · 1 needs attention/, view + ": the bye still counts"); t.doesNotMatch(tx, /nothing needs attention/, view);
    if (view === "lineup") t.match(tx, /Injury status is not available yet, so injuries are not counted here\./);
  });
  // without any known issue, an expired read says "injuries not checked", on all four views, never "nothing needs attention"
  const clean = await intelFor(), atC = (when) => ({ ...clean, status: { state: "ok", data: clean.status.data, at: when } });
  const m0 = model(), plain = (now, view) => state(atC(T0), { model: m0, nowMs: now, view }), s0 = plain(T0 + TTL + 1, "lineup");
  t.equal(R.attention(s0, lu(s0), 11).n, 0);
  VIEWS.forEach((view) => {
    const tx = text(V.rosterBody(plain(T0 + TTL + 60000, view)));
    t.match(tx, /18 of 18 starters · injuries not checked/, view); t.doesNotMatch(tx, /nothing needs attention/, view);
    t.doesNotMatch(V.rosterBody(plain(T0 + TTL + 60000, view)), /class="card okc"/, view + ": no green all-clear card");
  });

  // the chip and the card never disagree: the resolver draws a chip exactly when the card calls the read checked, at every clock point
  [-1000, 0, TTL - 1, TTL, TTL + 1, 10 * TTL].forEach((d) => { const s = S(at(T0), T0 + d); t.equal(!!R.injuryChip(s, a), R.injuryFresh(s), "chip and freshness agree at +" + d); });

  // recovery: a fresh successful read (a later `at`) restores the injury items and the count, same screen, same clock
  const rec = S(at(T0 + TTL + 1), T0 + TTL + 1), xr = R.attention(rec, lu(rec), 11);
  t.equal(R.injuryFresh(rec), true); t.equal(xr.injuriesChecked, true); t.equal(xr.n, 2); t.ok(R.injuryChip(rec, a));
  t.match(text(V.rosterBody(rec)), /18 of 18 starters · 2 need attention/); t.doesNotMatch(text(V.rosterBody(rec)), /injuries not checked/);
  // and the plain case recovers to the green card
  t.match(text(V.rosterBody(state(atC(T0 + 5 * TTL), { model: m0, nowMs: T0 + 5 * TTL }))), /18 of 18 starters · nothing needs attention/);

  // a read with no timestamp is not fresh (the resolver treats a missing `at` as the epoch): never an all-clear either
  const noAt = state({ ...clean, status: { state: "ok", data: clean.status.data } }, { model: m0, nowMs: T0 });
  t.equal(R.injuryFresh(noAt), false); t.match(text(V.rosterBody(noAt)), /injuries not checked/);
});

await run("mobile2027_r2b");
