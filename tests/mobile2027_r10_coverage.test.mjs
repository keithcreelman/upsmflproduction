// UPS 2027 beta, R10: Team › Roster › Byes. Keith's decisions 6 and 7 (2026-11-23).
//   node tests/mobile2027_r10_coverage.test.mjs
//
// Offline. The injury resolver is the beta's DERIVED copy; the real cases come from the committed recording, read through the recorded-data
// answer (lib/recorded.js) and the app's own loader, so the reads are exactly the ones the page makes. What is proven:
//   6. "Confirmed absences reduce future coverage. Questionable does not. Keep uncertain IR/PUP returns separate; when coverage depends on one,
//      show a concise dependency note rather than declaring the lineup covered."
//      - an MFL roster designation (IR, PUP, NFI, SUSP, RET) removes the player from the current week AND every later week; an Out removes him
//        from the current week only; Questionable, Doubtful and Holdout never remove anyone; an expired injury read removes nobody;
//      - an uncertain return (IR-R, PUP, NFI, or a designation with an MFL expected-return date) is never counted; a short week he alone (or a
//        few together) would complete gets "Covered only if … returns from IR" and stays short; no note when no return would complete it;
//   7. "Taxi recent scores use Performance's shared settled-week cutoff, with weeks labeled. Preserve zero and negative scores; distinguish missing
//      entries. Do not hide low-scoring candidates or count taxi players as confirmed active coverage."
//      - the weeks are W*-2..W* from tabviews.seasonCutoff (not the Worker's lastCompleteWeek); "W8 0.0 · W9 — · W10 −1.5"; Unreadable for an
//        entry that is not a number; every fitting taxi player listed; a taxi player never fills a slot; Byes reads no new route.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "apps", "mobile2027", "src");
const require = createRequire(import.meta.url);
const B = await import(pathToFileURL(path.join(HERE, "..", "apps", "mobile2027", "scripts", "build.mjs")).href);
const EQ = await import(pathToFileURL(path.join(HERE, "..", "apps", "mobile2027", "scripts", "injury_equivalence.mjs")).href);
globalThis.UPSInjuryStatus = EQ.loadResolver(B.derivedBytes(B.DERIVED[0], path.join(HERE, "fixtures/mobile2027/shared")).toString("utf8"), "injury_status.pure.js");
const M = require(path.join(SRC, "lib/model.js"));
const R = require(path.join(SRC, "lib/roster.js"));
const COV = require(path.join(SRC, "lib/coverage.js"));
const V = require(path.join(SRC, "lib/views.js"));
const TV = require(path.join(SRC, "lib/tabviews.js"));
const D = require(path.join(SRC, "lib/data.js"));
const X = require(path.join(SRC, "lib/complete.js"));
const REC = require(path.join(SRC, "lib/recorded.js"));
const text = (html) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const NOW = Date.UTC(2026, 10, 22, 15, 30);
const CUT = { state: "ok", week: 10 };

let seq = 5000;
function P(pos, o) { seq++; return Object.assign({ id: String(seq), name: pos + " Player " + seq, pos, nflTeam: "AAA", status: "active", bye: 16, salary: 1000, years: 1, taxi: { used: null, max: null, eligible: false, text: "" } }, o || {}); }
// a full legal lineup: 15 required-slot players plus an RB, a QB and a WR for OFX1, OFX2 and SFX (exactly 18, nothing to spare)
function full() { return [P("QB"), P("RB"), P("RB"), P("WR"), P("WR"), P("TE"), P("PK"), P("PN"), P("DL"), P("DL"), P("LB"), P("LB"), P("DB"), P("DB"), P("DL"), P("RB"), P("QB"), P("WR")]; }
function teamOf(players) { return { id: "0001", name: "Test", players, counts: { active: players.filter((p) => p.status === "active").length, taxi: 0, ir: 0 }, lineup: { state: "ok", count: 0, ids: [] } }; }
function stateOf(team, at) {
  const byId = {}; team.players.forEach((p) => { byId[p.id] = p; });
  return { model: { week: 11, limits: { roster: 30, ir: 15, taxi: 10, starters: 18 }, teams: [team], byId }, teamId: team.id, nowMs: NOW, view: "byes", sub: "roster", tab: "team", open: {}, load: { core: "ok", coreNotes: [] },
    intel: { status: { state: "ok", data: { ok: true, report_feed: { ok: true, current: true, week: 11, teams_mfl: ["AAA"] }, roster_feed: { ok: true }, mfl_feed: { ok: true }, mapped_mfl_ids: team.players.map((p) => p.id), players: {} }, at: at != null ? at : NOW }, mu: {}, wk: {}, scores: {}, sched: {} } };
}
const roster = (chip, extra) => ({ roster: Object.assign({ chip, label: chip, detail: "Knee" }, extra || {}) });
// the module's "A or B" order: by position, then name (both TEs here)
const nameList2 = (names) => names.slice().sort((a, b) => a.localeCompare(b)).join(" or ");

test("6 (fix): a designation is a confirmed absence in the CURRENT week only; in a later week availability is not confirmed and the note names him", () => {
  const ps = full(), te = ps[5], tm = teamOf(ps), S = stateOf(tm), st = S.intel.status.data.players;
  t.equal(COV.week(S, tm, 13).filled, 18, "baseline: a full lineup in Week 13");
  st[te.id] = roster("IR");
  // current week: confirmed absence, plain IR carries no return in the data, so no note
  let cv = COV.week(S, tm, 11, CUT);
  t.deepEqual(cv.short.map((s) => s.key + " " + s.available + "/" + s.required), ["TE 0/1"]);
  t.ok(cv.absent.some((a) => a.player.id === te.id && a.text === "MFL designation: IR"), "current week: confirmed absent");
  t.equal(cv.dependency, null); t.equal(cv.dependencyText, "");
  // later weeks: not counted as available, not a confirmed absence; the week is short only pending his return, and says so
  for (const w of [13, 14]) {
    cv = COV.week(S, tm, w, CUT);
    t.equal(cv.filled, 17, "Week " + w + ": never counted as available");
    t.equal(cv.absent.length, 0, "Week " + w + ": not a confirmed absence (no verified duration)");
    t.ok(cv.uncertain.some((a) => a.player.id === te.id && /availability not confirmed/.test(a.text)), "Week " + w + ": listed as availability not confirmed");
    t.equal(cv.dependencyText, "Covered only if " + te.name + " returns from IR", "Week " + w + ": dependency note, never a definite shortage");
  }
  for (const code of ["SUSP", "NFI", "PUP", "IR-R"]) {
    st[te.id] = roster(code); cv = COV.week(S, tm, 14, CUT);
    t.equal(cv.filled, 17, code + " is never counted as available"); t.equal(cv.absent.length, 0, code + ": not confirmed absent in a later week");
    t.ok(cv.dependencyText.indexOf("Covered only if " + te.name + " returns from ") === 0, code + ": dependency note");
  }
  st[te.id] = roster("SUSP"); t.equal(COV.week(S, tm, 14, CUT).dependencyText, "Covered only if " + te.name + " returns from a suspension");
  // RET is permanent: a confirmed absence in every later week, no note
  st[te.id] = roster("RET"); cv = COV.week(S, tm, 14, CUT);
  t.equal(cv.filled, 17); t.ok(cv.absent.some((a) => a.player.id === te.id)); t.equal(cv.dependency, null, "RET is never a return");
  st[te.id] = { mfl: { status: "Out", details: "Knee" }, report: { status: "Out", injury: "Knee", practice: "Did Not Participate In Practice" } };
  t.equal(COV.week(S, tm, 11).filled, 17, "Out: absent this week"); t.equal(COV.week(S, tm, 13).filled, 18, "Out is a game status for this week only: not carried to Week 13");
  for (const v of [{ mfl: { status: "Questionable" } }, { mfl: { status: "Doubtful" } }, roster("HOLD")]) {
    st[te.id] = v; t.equal(COV.week(S, tm, 11).filled, 18); t.equal(COV.week(S, tm, 13).filled, 18, JSON.stringify(v) + " never reduces coverage");
  }
  // an expired injury read removes nobody and every week says injuries were not checked
  st[te.id] = roster("IR");
  const old = stateOf(tm, NOW - 60 * 60 * 1000); old.intel.status.data.players = st;
  const w13 = COV.week(old, tm, 13); t.equal(w13.filled, 18); t.equal(w13.injuriesChecked, false);
  t.equal(COV.week(S, tm, 13).injuriesChecked, true);
});

test("6 (fix, Keith's reproduction): Week 14 full 18/18; plain IR on the only TE → 17/18 with a dependency note; SUSP returning 2026-11-29 → still not confirmed in Week 14", () => {
  const ps = full(), te = ps[5], tm = teamOf(ps), S = stateOf(tm), st = S.intel.status.data.players;
  let cv = COV.week(S, tm, 14, CUT);
  t.equal(cv.filled, 18); t.equal(cv.short.length, 0, "baseline: full Week 14 lineup");
  st[te.id] = roster("IR");
  cv = COV.week(S, tm, 14, CUT);
  t.equal(cv.filled, 17, "17/18: the IR TE is not counted as available");
  t.deepEqual(cv.short.map((s) => s.key), ["TE"]);
  t.equal(cv.dependencyText, "Covered only if " + te.name + " returns from IR", "a dependency, not a definite shortage");
  t.equal(cv.absent.length, 0);
  // an expected-return date is evidence of uncertainty, not clearance: still not counted in Week 14, still a dependency
  st[te.id] = roster("SUSP", { exp_return: "2026-11-29" });
  cv = COV.week(S, tm, 14, CUT);
  t.equal(cv.filled, 17, "SUSP with an expected return before Week 14 is still not counted as available");
  t.equal(cv.absent.length, 0, "and not a confirmed absence");
  t.ok(cv.uncertain.some((a) => a.player.id === te.id));
  t.ok(/^Covered only if .* returns from /.test(cv.dependencyText), cv.dependencyText);
  // the Byes view says it, never "Full lineup", and lists him under availability not confirmed
  te.bye = 16; const spare = P("LB", { bye: 14 }); ps.push(spare); tm.players = ps; S.model.byId[spare.id] = spare; tm.counts.active = ps.length;
  st[te.id] = roster("IR");
  const open = text(V.rosterBody(Object.assign({}, S, { open: { bw14: true } })));
  t.match(open, /Not counted · availability not confirmed · 1/);
  // K and P everywhere: a kicker on bye is grouped under "K", never "PK"; a kicker shortage reads "K"
  const kps = full(); kps[6].bye = 13; const ktm = teamOf(kps), KS = stateOf(ktm);
  const kopen = text(V.rosterBody(Object.assign({}, KS, { open: { bw13: true } })));
  t.match(kopen, /K · 1/); t.doesNotMatch(kopen, /PK · |PK 0\/1|\(PK|PN · /, "no PK/PN text on the Byes screen");
  t.match(kopen, /Short in Week 13 \(K\)/);
  t.match(open, new RegExp("Covered only if " + te.name + " returns from IR"));
});

test("6: an uncertain return is never counted; a lineup only he would complete gets a dependency note and stays short", () => {
  const ps = full(), te = ps[5], tm = teamOf(ps), S = stateOf(tm), st = S.intel.status.data.players;
  st[te.id] = roster("IR-R", { label: "Injured reserve – designated to return" });
  let cv = COV.week(S, tm, 13, CUT);
  t.equal(cv.filled, 17, "never counted as available"); t.ok(cv.short.length === 1, "the week stays short");
  t.equal(cv.dependencyText, "Covered only if " + te.name + " returns from IR");
  st[te.id] = roster("PUP"); t.equal(COV.week(S, tm, 13, CUT).dependencyText, "Covered only if " + te.name + " returns from PUP");
  st[te.id] = roster("IR", { exp_return: "Dec 20, 2026" }); t.equal(COV.week(S, tm, 13, CUT).dependencyText, "Covered only if " + te.name + " returns from IR", "an MFL expected-return date makes plain IR an uncertain return");
  st[te.id] = roster("RET", { exp_return: "Dec 20, 2026" }); t.equal(COV.week(S, tm, 13, CUT).dependency, null, "Retired is never a return");
  // a UPS IR player whose MFL designation can end with a return is a candidate too (the active TE has plain IR)
  const irTe = P("TE", { status: "ir", name: "Return Candidate" }); ps.push(irTe);
  const tm2 = teamOf(ps), S2 = stateOf(tm2); S2.intel.status.data.players = st;
  st[te.id] = roster("IR"); st[irTe.id] = roster("IR-R");
  // current week: the active TE's plain IR is a confirmed absence, so only the UPS IR player's designated return is named
  cv = COV.week(S2, tm2, 11, CUT); t.equal(cv.filled, 17); t.equal(cv.dependencyText, "Covered only if Return Candidate returns from IR");
  // a later week: the active TE's availability is not confirmed either (R10 fix), so either return would complete the lineup
  cv = COV.week(S2, tm2, 13, CUT); t.equal(cv.filled, 17); t.equal(cv.dependencyText, "Covered only if " + nameList2(["Return Candidate", te.name]) + " returns");
  irTe.bye = 13; t.equal(COV.week(S2, tm2, 13, CUT).dependencyText, "Covered only if " + te.name + " returns from IR", "a candidate on bye that week is no help; the active TE still is");
  irTe.bye = 11; t.equal(COV.week(S2, tm2, 11, CUT).dependency, null, "current week, IR candidate on bye: no return would complete it");
  // two needed together: both starting RBs designated to return, and the spare RB alone cannot fill RB2 and an OFX
  const ps3 = full(), r1 = ps3[1], r2 = ps3[2], tm3 = teamOf(ps3), S3 = stateOf(tm3), st3 = S3.intel.status.data.players;
  st3[r1.id] = roster("IR-R"); st3[r2.id] = roster("IR-R");
  cv = COV.week(S3, tm3, 13, CUT); t.equal(cv.filled, 16);
  t.equal(cv.dependencyText, "Covered only if " + [r1, r2].sort((a, b) => a.name.localeCompare(b.name)).map((p) => p.name).join(" and ") + " return");
  // a later-week plain IR is a candidate too (availability not confirmed), so both are still named
  st3[r2.id] = roster("IR"); t.ok(/ and .* return$/.test(COV.week(S3, tm3, 13, CUT).dependencyText), "later week: plain IR is a candidate as well");
  // RET is permanent: no return would complete the lineup, so no note and the shortage stands
  st3[r2.id] = roster("RET"); t.equal(COV.week(S3, tm3, 13, CUT).dependency, null, "no return would complete the lineup: no note, the shortage stands");
  // a full lineup never carries a note
  const ps4 = full().concat([P("TE")]), tm4 = teamOf(ps4), S4 = stateOf(tm4); S4.intel.status.data.players[ps4[5].id] = roster("IR-R");
  t.equal(COV.week(S4, tm4, 13, CUT).short.length, 0); t.equal(COV.week(S4, tm4, 13, CUT).dependency, null);
});

test("6: the Byes view says the dependency once per week, never 'Full lineup', and the summary says the week depends on a return", () => {
  const ps = full(), te = ps[5]; te.bye = 15; const tm = teamOf(ps), S = stateOf(tm);
  const spare = P("LB", { bye: 13 }); ps.push(spare); tm.players = ps; S.model.byId[spare.id] = spare; tm.counts.active = ps.length;   // a spare LB on bye: a week to check
  S.intel.status.data.players[te.id] = roster("IR-R");
  const html = V.rosterBody(S), tx = text(html);
  t.match(tx, /Lineup coverage · ▲ Short in Week 11 \(TE, depends on a return\) · Week 13 \(TE, depends on a return\)/);
  t.match(tx, new RegExp("Week 13 · 1 on bye ▲ Short 1: TE 0/1 · Covered only if " + te.name + " returns from IR"));
  t.doesNotMatch(tx, /Full lineup 18\/18/);
  const open = text(V.rosterBody(Object.assign({}, S, { open: { bw13: true } })));
  t.match(open, new RegExp("Covered only if " + te.name + " returns from IR\\. Not counted as available\\."));
  t.equal(open.split("Covered only if").length - 1, 3, "once in each week's heading, once in the open card (Week 11 is collapsed)");
  t.match(fs.readFileSync(path.join(SRC, "styles.css"), "utf8"), /\.cvl\.cvd\{color:var\(--mu\)/);
});

test("7: recent points run through the shared cutoff W*, each week labeled; zero and negative kept; missing and unreadable told apart", () => {
  t.deepEqual(COV.recentWeeks({ state: "ok", week: 9 }), [7, 8, 9]); t.deepEqual(COV.recentWeeks({ state: "ok", week: 2 }), [1, 2]);
  t.deepEqual(COV.recentWeeks({ state: "loading", week: null }), [], "no W*, no weeks: never guessed from the Worker's latest week");
  const ps = full(), tm0 = ps;
  const low = P("TE", { status: "taxi", name: "Taxi Low", taxi: { used: 0, max: 3, eligible: true, text: "Eligible" } });
  const neg = P("TE", { status: "taxi", name: "Taxi Neg", taxi: { used: 1, max: 3, eligible: true, text: "Eligible" } });
  tm0.push(low, neg);
  const tm = teamOf(tm0), S = stateOf(tm); S.intel.status.data.players[ps[5].id] = roster("IR");
  // the Worker's lastCompleteWeek says 10, but W* is 9 (e.g. the team history is a week behind): the weeks are 7, 8, 9
  S.intel.mu[11] = { state: "ok", data: { lastComplete: 10, games: {}, avg: {} } };
  S.intel.scores = { 7: { state: "ok", data: { scores: { [low.id]: 0, [neg.id]: -1.5 } } }, 8: { state: "ok", data: { scores: { [neg.id]: "x" } } }, 9: { state: "ok", data: { scores: { [low.id]: 3, [neg.id]: -0.04 } } }, 10: { state: "ok", data: { scores: { [low.id]: 99 } } } };
  const cv = COV.week(S, tm, 11, { state: "ok", week: 9 });
  t.equal(cv.filled, 17, "two taxi TEs, and the TE slot is still open: taxi players are never counted as coverage");
  const o = (p) => cv.taxi.options.find((x) => x.player.id === p.id);
  t.ok(o(low) && o(neg), "every fitting taxi player is listed, whatever his points");
  t.deepEqual(o(low).points.map((x) => "W" + x.week + " " + x.text), ["W7 0.0", "W8 —", "W9 3.0"]);
  t.deepEqual(o(neg).points.map((x) => "W" + x.week + " " + x.text), ["W7 −1.5", "W8 Unreadable", "W9 −0.0"].map((s) => s === "W9 −0.0" ? "W9 " + COV.scoreText(-0.04) : s));
  t.deepEqual(o(low).points.map((x) => x.kind), ["score", "none", "score"]);
  t.equal(COV.scoreText(0), "0.0"); t.equal(COV.scoreText(-1.5), "−1.5"); t.equal(COV.scoreText(12.25), "12.3");
  // drawn: the labels, the one key line, and no week 10. The view asks tabviews.seasonCutoff itself; here it answers W* = 9.
  const realCut = TV.seasonCutoff;
  TV.seasonCutoff = () => ({ state: "ok", week: 9 });
  let tx;
  try { tx = text(V.rosterBody(Object.assign({}, S, { open: { bw11: true, bwtx11: true } }))); } finally { TV.seasonCutoff = realCut; }
  t.match(tx, /Not counted in coverage\. Recent: the last three settled weeks, as on Performance \(through W9\)\. — = no MFL score entry\./);
  t.match(tx, /Taxi Low [^▲]*Recent: W7 0\.0 · W8 — · W9 3\.0/);
  t.match(tx, /Taxi Neg [^▲]*Recent: W7 −1\.5 · W8 Unreadable/);
  t.doesNotMatch(tx, /W10/);
});

// the recording, read the way the page reads it: the recorded-data answer behind the app's own loader
function bundle() { const c = vm.createContext({}); c.window = c; vm.runInContext(fs.readFileSync(path.join(SRC, "recorded_data.js"), "utf8"), c); return JSON.parse(JSON.stringify(c.UPS2027_RECORDED)); }
async function recordedState() {
  const BU = bundle(), asked = [];
  const f = REC.createFetch(BU), fetchLog = (a, o) => { asked.push(REC.canonical(a)); return f(a, o); };
  const L = D.createLoader({ workerBase: "https://upsmflproduction.keith-creelman.workers.dev", leagueId: "74598", season: "2026" }, fetchLog);
  const rec = (r) => ({ state: r.state, data: r.data, error: r.error, at: NOW });
  const routes = BU.routes, get = (p) => routes[Object.keys(routes).find((k) => k.startsWith(p))];
  const model = M.build(get("/roster-workbench"), get("/api/mfl-export?JSON=1&L=74598&TYPE=league"), get("/api/mfl-export?JSON=1&L=74598&TYPE=weeklyResults&W=11&"), 11, 2026);
  const intel = { status: rec(await L.loadStatus()), mu: { 11: rec(await L.loadMatchups(11)) }, wk: {}, scores: {}, sched: {}, cal: rec(await L.loadCalendar(X.parseCalendar)) };
  intel.sched[10] = rec(await L.loadSchedule(10, X.parseSchedule));
  return { S: { model, nowMs: NOW, intel, view: "byes", sub: "roster", tab: "team", open: {}, load: { core: "ok", coreNotes: [] } }, L, rec, asked };
}

test("the recording: W* = 10 from the same reads Performance uses; real taxi scores with 0.0 and missing weeks; a later-week designation; no dependency case", async () => {
  const { S, L, rec, asked } = await recordedState();
  const cut = TV.seasonCutoff(S);
  t.equal(cut.state, "ok"); t.equal(cut.week, 10, "W* in the 2026-11-22 recording");
  for (const w of COV.recentWeeks(cut)) S.intel.scores[w] = rec(await L.loadScores(w));
  t.deepEqual(Object.keys(S.intel.scores).map(Number), [8, 9, 10]);
  t.ok(asked.every((a) => /^\/api\/(player-status|lineup-matchups|mfl-export)\?/.test(a)), "only routes the app already reads");
  const team = (id) => S.model.teams.find((x) => x.id === id);
  // every taxi player in the league, his W8-W10 line: real zero, negative and missing cases
  const lines = {}; S.model.teams.forEach((tm) => tm.players.filter((p) => p.status === "taxi").forEach((p) => { lines[p.name] = COV.recentPoints(S, p, cut).map((x) => "W" + x.week + " " + x.text).join(" · "); }));
  const has = (re) => Object.keys(lines).filter((n) => re.test(lines[n]));
  t.ok(has(/W\d+ 0\.0/).length > 0, "a real 0.0: " + has(/W\d+ 0\.0/).slice(0, 3).join(", "));
  t.ok(has(/W\d+ —/).length > 0, "a real missing entry");
  console.log("  recorded taxi lines with zero:", has(/ 0\.0/).map((n) => n + " [" + lines[n] + "]").slice(0, 4).join("; "));
  console.log("  recorded taxi lines with a negative:", has(/−/).map((n) => n + " [" + lines[n] + "]").slice(0, 4).join("; ") || "none");
  const lh = COV.week(S, team("0006"), 13, cut);
  const faulk = lh.taxi.options.find((o) => /Faulk/.test(o.player.name));
  t.equal(faulk.points.map((x) => "W" + x.week + " " + x.text).join(" · "), "W8 3.0 · W9 — · W10 1.0");
  // Dontayvion Wicks (active, MFL IR designation): confirmed absent in the current week; in Week 13 not counted, availability not confirmed (R10 fix)
  const wicks = team("0006").players.find((p) => p.name === "Dontayvion Wicks");
  t.ok(COV.week(S, team("0006"), 11, cut).absent.some((a) => a.player.id === wicks.id), "Wicks confirmed absent, Week 11");
  const w13 = COV.week(S, team("0006"), 13, cut);
  t.ok(!w13.absent.some((a) => a.player.id === wicks.id), "Wicks is not a confirmed absence in Week 13");
  t.ok(w13.uncertain.some((a) => a.player.id === wicks.id), "Wicks: availability not confirmed in Week 13");
  // R10 fix: every dependency note in the recording names only players whose availability that week is not confirmed (a later-week
  // designation) or who can return (a returnable designation); none is a current-week plain IR and none is counted as available
  const deps = [];
  S.model.teams.forEach((tm) => COV.weeks(Object.assign({}, S, { teamId: tm.id }), tm, cut).forEach((w) => {
    if (!w.dependency) return;
    deps.push(tm.id + ":W" + w.week + " " + w.dependencyText);
    t.ok(w.short.length > 0, "a dependency week is still short (" + tm.id + " W" + w.week + ")");
    const named = (w.dependency.any || w.dependency.all).map((c) => c.player.id);
    const ok = new Set(w.uncertain.map((a) => a.player.id).concat(w.absent.filter((a) => a.back).map((a) => a.player.id)));
    named.forEach((id) => { if (!ok.has(id)) { const p = tm.players.find((x) => x.id === id); t.ok(p && p.status === "ir", "named " + id + " is uncertain, returnable or a UPS IR candidate"); } });
  }));
  console.log("  recorded dependency notes:", deps.join("; ") || "none");
});

test("app.js: Byes establishes W* from the shared reads, asks only the three weeks, and never starts Performance's reads", () => {
  const app = fs.readFileSync(path.join(SRC, "app.js"), "utf8");
  const fn = app.split("function ensureByeScores")[1].split("\n  }\n")[0];
  t.match(fn, /U\.coverage\.recentWeeks\(U\.tabviews\.seasonCutoff\(S\)\)/);
  t.match(fn, /ensureCalendar\(force, ensureByeScores\)/); t.match(fn, /ensureSched\(lc, force, ensureByeScores\)/);
  t.doesNotMatch(fn, /ensurePerformance|ensurePlayers|ensureWeekScores/);
  t.match(app, /function timingNext\(next\) \{ return function \(\) \{ if \(next && S\.view === "byes"/);
});

await run("mobile2027_r10_coverage");
