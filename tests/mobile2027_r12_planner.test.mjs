// UPS 2027 R12 (Keith, 2026-11-23, P1): the Lineup planner. Plan only, never submitted.
//   node tests/mobile2027_r12_planner.test.mjs
// Offline and read-only: the real views over the committed recording through the recorded fetch (no network). The current app's lineup rules are run
// from reviewed fixture copies (tests/fixtures/mobile2027/shared/front_office_lineup.js and lineup_flex.js, byte copies of site/m/front_office_lineup.js
// and site/shared/lineup_flex.js; this suite never reads site/) and compared with the beta's planner for every team in the recording.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "apps", "mobile2027", "src");
const FIX = path.join(HERE, "fixtures", "mobile2027", "shared");
const require = createRequire(import.meta.url);
const M = require(path.join(SRC, "lib/model.js")), D = require(path.join(SRC, "lib/data.js")), RC = require(path.join(SRC, "lib/recorded.js"));
const PL = require(path.join(SRC, "lib/planner.js")), V = require(path.join(SRC, "lib/views.js")), R = require(path.join(SRC, "lib/roster.js"));
const ld = (f) => { const c = vm.createContext({}); c.window = c; vm.runInContext(fs.readFileSync(path.join(SRC, f), "utf8"), c); return JSON.parse(JSON.stringify(c.UPS2027_RECORDED || c.UPS2027_CONFIG)); };
const BUNDLE = ld("recorded_data.js"), CFG = ld("config.js");
const text = (h) => h.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const screen = (h) => h.split('id="screen"')[1].split("<nav")[0];
const appJs = fs.readFileSync(path.join(SRC, "app.js"), "utf8"), plannerJs = fs.readFileSync(path.join(SRC, "lib/planner.js"), "utf8");

// the current app's rules, from the reviewed fixture copies, in a sandbox with a window object
function classic() {
  const c = vm.createContext({}); c.window = c;
  vm.runInContext(fs.readFileSync(path.join(FIX, "lineup_flex.js"), "utf8"), c);
  vm.runInContext(fs.readFileSync(path.join(FIX, "front_office_lineup.js"), "utf8"), c);
  return c.window.UPS_FRONT_OFFICE_LINEUP;
}
async function fresh(teamId) {
  const L = D.createLoader(CFG, RC.createFetch(BUNDLE)), rec = (r) => ({ state: r.state, data: r.data, error: r.error, at: Date.now() });
  const core = await L.loadCore();
  const model = M.build(core.roster.data, core.league.data, core.weekly.data, core.week, 2026);
  const S = { model, load: { core: "ok", coreNotes: [] }, penalty: { state: "idle" }, ns: { state: "idle" }, teamId: teamId || "0006", tab: "team", sub: "roster", view: "lineup", open: {}, flags: {}, profile: null, sheet: null,
    skin: "system", vib: "1", build: "test", requestLog: [], gdef: "needs", wk: null, live: null, pf: { s: "pos", open: {}, res: {}, q: "", pos: "all", xt: false, xpos: "all", note: null },
    ct: { f: "all", l: "all", s: "exp", y: 0, d: 1, open: {}, hist: {}, bd: false, cat: {}, ns: false }, requestSummary: { requests: 0, ok: 0, failed: 0, refused: 0, nonGet: 0 }, sample: { on: false },
    plans: {}, planPick: null, intel: { status: null, mu: {}, wk: {}, scores: {}, sched: {}, players: null, cal: null, proj: {}, reread: {} } };
  S.intel.mu[core.week] = rec(await L.loadMatchups(core.week));
  return S;
}
const teamOf = (S, id) => S.model.teams.find((x) => x.id === (id || S.teamId));
// what app.js planPick does (only a listed, allowed choice; a return to the recorded lineup leaves no plan)
function pick(S, slotId, name) {
  const tm = teamOf(S), Dr = PL.draftOf(S, tm), O = PL.options(S, tm, Dr.draft, slotId), c = O.choices.find((x) => x.p.name === name && x.ok);
  if (!c) return false;
  const next = PL.apply(Dr.draft, slotId, String(c.p.id));
  if (PL.sig(next) === PL.sig(Dr.base)) delete S.plans[tm.id]; else S.plans[tm.id] = { week: S.model.week, base: PL.sig(Dr.base), draft: next };
  return true;
}
const nameIn = (S, slotId) => { const tm = teamOf(S), d = PL.draftOf(S, tm).draft; return d[slotId] ? S.model.byId[d[slotId]].name : null; };
const slotRow = (h, tag) => { const i = h.indexOf('data-v="' + tag + '"'); return i < 0 ? "" : text(h.slice(i, h.indexOf("</div></div>", i) + 12)); };

test("parity with the current app: for every team, each slot's allowed bench players, the locks and the lineup checks equal front_office_lineup.js + lineup_flex.js", async () => {
  const FO = classic(), S = await fresh(), wk = S.model.week;
  t.equal(FO.LINEUP_SLOTS.length, PL.SLOTS.length, "18 slots in both");
  const J = (x) => JSON.parse(JSON.stringify(x));   // values from the sandbox realm, compared as plain data
  FO.LINEUP_SLOTS.forEach((s, i) => t.deepEqual(J(s.accepts), PL.SLOTS[i].acc, "slot " + s.id + " = " + PL.SLOTS[i].id + ": same positions"));
  let teams = 0, cmp = 0, drafts = 0;
  for (const tm of S.model.teams) {
    const Dr = PL.draftOf(S, tm); if (!Dr.ok) continue; teams++;
    const rows = {}; tm.players.forEach((p) => { const L = PL.lockOf(S, p, wk); rows[String(p.id)] = { id: String(p.id), name: p.name, pos: p.pos, team: p.nflTeam, isTaxi: p.status === "taxi", isIr: p.status === "ir", isExpired: false, bye: R.onBye(p, wk) ? p.bye : 0, locked: L.locked }; });
    const toFO = (d) => { const o = {}; PL.SLOTS.forEach((s, i) => { if (d[s.id]) o[FO.LINEUP_SLOTS[i].id] = d[s.id]; }); return o; };
    // locks: lockedDraftEntries == the slots the planner blocks
    const locked = J(Object.keys(FO.lockedDraftEntries(toFO(Dr.draft), rows))).sort();
    const blocked = PL.SLOTS.map((s, i) => ({ s, i })).filter((x) => PL.options(S, tm, Dr.draft, x.s.id).blocked).map((x) => FO.LINEUP_SLOTS[x.i].id).sort();
    t.deepEqual(blocked, locked, tm.name + ": blocked slots = locked occupants");
    // bench choices: allowed exactly when the classic row is startable (lineupEligibleRow), not locked, and the slot takes his position
    PL.SLOTS.forEach((s, i) => {
      const O = PL.options(S, tm, Dr.draft, s.id); if (O.blocked) return;
      tm.players.forEach((p) => {
        const pid = String(p.id); if (PL.slotOfPid(Dr.draft, pid)) return;
        const c = O.choices.find((x) => String(x.p.id) === pid), r = rows[pid];
        const classicOk = FO.lineupEligibleRow(r) && !r.locked && FO.slotAccepts(FO.LINEUP_SLOTS[i], FO.posGroup(r.pos)) && p.status === "active";
        t.equal(!!(c && c.ok), classicOk, tm.name + " " + s.id + " " + p.name); cmp++;
        if (!FO.slotAccepts(FO.LINEUP_SLOTS[i], FO.posGroup(r.pos))) t.ok(!c, "a player whose position the slot does not take is never offered");
      });
    });
    // the checks: the recorded lineup and every one-move plan from it validate the same way in both
    const all = [Dr.draft];
    PL.SLOTS.forEach((s) => { const O = PL.options(S, tm, Dr.draft, s.id); O.choices.filter((c) => c.ok).forEach((c) => all.push(PL.apply(Dr.draft, s.id, String(c.p.id)))); });
    all.forEach((d) => {
      const a = PL.validate(S, tm, d), b = J(FO.validateSlots(toFO(d), rows));
      t.deepEqual({ ok: a.ok, complete: a.complete, problems: a.problems, filled: a.filled, errors: a.errors }, { ok: b.ok, complete: b.complete, problems: b.problems, filled: b.filled, errors: b.errors }); drafts++;
      const ids = Object.values(d); t.equal(new Set(ids).size, ids.length, "never one player in two slots");
    });
  }
  t.ok(teams >= 10 && cmp > 3000 && drafts > 300, "covered " + teams + " teams, " + cmp + " eligibility checks, " + drafts + " drafts");
});

test("1. a legal starter/bench swap: Chris Godwin (bench) into OFX1; Adonai Mitchell goes to the bench; the plan is labeled and never submitted", async () => {
  const S = await fresh(), before = screen(V.app(S));
  t.match(text(before), /Tap a position badge to plan a change\. Plan only · not submitted\./);
  t.equal((before.match(/data-act="plan" data-v="/g) || []).length, 18, "every slot badge is a control");
  t.match(before, /data-act="card" data-pid="\d+" aria-label="Adonai Mitchell, open player profile"/, "the name still opens the profile");
  S.sheet = "plan"; S.planPick = "OFX1";
  const sheet = V.planSheet(S); t.match(text(sheet), /OFX1 · Offensive flex/); t.match(text(sheet), /Plan only · not submitted\./);
  // F2 (Keith 2026-11-26): the choices are headed "Swap", and a bench player's row is just him, his game and his projection; the full move stays in the
  // button's accessible name
  t.match(text(sheet), / Swap Cade Otton TE /); t.doesNotMatch(text(sheet), /Can move here|From the bench|goes to the bench/);
  t.match(text(sheet), /Chris Godwin WR @ DET · Sun 1:00 PM ET · Proj\. —/);
  t.match(sheet, /aria-label="Chris Godwin, [^"]*From the bench · Adonai Mitchell goes to the bench"/);
  t.ok(pick(S, "OFX1", "Chris Godwin")); S.sheet = null;
  const h = screen(V.app(S)), tx = text(h);
  t.equal(nameIn(S, "OFX1"), "Chris Godwin");
  t.match(tx, /Plan only · not submitted Reset 1 slot changed\. MFL still has the recorded lineup\./);
  t.match(slotRow(h, "OFX1"), /Chris Godwin .*Planned/);
  t.match(tx, /Bench · \d+ .*Adonai Mitchell [^·]*· [^·]*·? ?.*Was starting/);
  t.match(tx, /Starting lineup · 18\/18/);
  t.doesNotMatch(h, />\s*Submit|data-act="submit/i, "no submit control anywhere");
});

test("2. a legal flex move: Cam Ward (SFX) into QB1; Fernando Mendoza moves to SFX", async () => {
  const S = await fresh();
  t.ok(pick(S, "QB1", "Cam Ward"));
  t.equal(nameIn(S, "QB1"), "Cam Ward"); t.equal(nameIn(S, "SFX"), "Fernando Mendoza");
  const Dr = PL.draftOf(S, teamOf(S)); t.deepEqual(Dr.changed.sort(), ["QB1", "SFX"]);
  t.equal(PL.validate(S, teamOf(S), Dr.draft).problems, 0);
  const h = screen(V.app(S)); t.match(slotRow(h, "QB1"), /Cam Ward .*Planned/); t.match(slotRow(h, "SFX"), /Fernando Mendoza .*Planned/);
  // a swap that would put a player where his position isn't taken is refused, with the reason
  const O = PL.options(S, teamOf(S), Dr.draft, "DFX"), bad = O.choices.find((c) => c.p.name === "Maxx Crosby");
  t.ok(bad && !bad.ok && /Kyle Hamilton can’t play DL2/.test(bad.why), "a DL can't swap into DFX when the DB in DFX can't play DL");
});

test("3. a blocked locked move: Tyler Warren (OFX2, IND game final) can't be moved, and a bench player whose game started can't be moved in", async () => {
  const S = await fresh(), tm = teamOf(S), Dr = PL.draftOf(S, tm);
  const O = PL.options(S, tm, Dr.draft, "OFX2");
  t.ok(O.blocked); t.equal(O.occupant.name, "Tyler Warren"); t.match(O.why, /His game is final: he can’t be moved out of OFX2, and no one can be moved in\./);
  S.sheet = "plan"; S.planPick = "OFX2"; t.match(text(V.planSheet(S)), /His game is final/); t.doesNotMatch(V.planSheet(S), /data-act="planpick"/, "no choices");
  const rb = PL.options(S, tm, Dr.draft, "RB1").choices.find((c) => c.p.name === "Woody Marks");
  t.ok(rb && !rb.ok); t.equal(rb.why, "His game is final");
  S.planPick = "RB1"; t.match(V.planSheet(S), /<button class="so off" data-act="planpick" data-v="\d+" disabled aria-label="Woody Marks, RB\. Not available: His game is final">/);
  t.equal(pick(S, "RB1", "Woody Marks"), false, "never applied");
  t.match(appJs, /O\.choices\.filter\(function \(x\) \{ return String\(x\.p\.id\) === String\(pid\) && x\.ok; \}\)\[0\];\s*\n\s*if \(!c\) return;/, "app.js applies only an allowed choice");
});

test("4. an ineligible replacement is excluded or explained: other positions never offered; bye, injured reserve and taxi say why", async () => {
  const S = await fresh(), tm = teamOf(S), Dr = PL.draftOf(S, tm), O = PL.options(S, tm, Dr.draft, "TE1");
  t.ok(O.choices.every((c) => c.p.pos === "TE"), "TE1 lists only tight ends");
  const wr = PL.options(S, tm, Dr.draft, "WR1").choices.find((c) => c.p.name === "A.J. Brown"); t.equal(wr.why, "Bye week");
  S.sheet = "plan"; S.planPick = "WR1"; const sh = text(V.planSheet(S));
  t.match(sh, /Can’t move here now .*A\.J\. Brown WR .*Bye week/);
  t.match(sh, /Not on the active roster \(injured reserve or taxi\), so they can’t start: [^.]*Jayden Reed/);
  t.doesNotMatch(sh, /Gunnar Helm|Cade Otton/, "no tight end offered for WR1");
});

test("5. Reset restores the recorded lineup exactly", async () => {
  const S = await fresh(), base = screen(V.app(S));
  t.ok(pick(S, "OFX1", "Chris Godwin")); t.ok(pick(S, "QB1", "Cam Ward"));
  t.notEqual(screen(V.app(S)), base);
  delete S.plans[S.teamId];   // what app.js "planreset" does
  t.equal(screen(V.app(S)), base, "byte-identical to the recorded lineup");
  // R13 F5 (Keith 2026-11-26): Reset also clears the Optimal Starters note
  t.match(appJs, /act === "planreset"\) \{ var tr = curTeam\(\); if \(tr && S\.plans\) delete S\.plans\[tr\.id\]; S\.optNote = null; render\(true\); \}/);
  // undoing a move by hand also leaves no plan
  const S2 = await fresh(); t.ok(pick(S2, "OFX1", "Chris Godwin")); t.ok(pick(S2, "OFX1", "Adonai Mitchell")); t.equal(S2.plans["0006"], undefined);
});

test("6. opening and closing a profile keeps the plan; a team switch keeps it and the team sheet says so; Byes and past weeks never show it", async () => {
  const S = await fresh();
  t.ok(pick(S, "OFX1", "Chris Godwin"));
  S.profile = { pid: S.model.teams.find((x) => x.id === "0006").players.find((p) => p.name === "Chris Godwin").id, tab: "contract" };
  t.match(V.app(S), /aria-label="Player profile/); t.equal(nameIn(S, "OFX1"), "Chris Godwin");
  S.profile = null; t.match(text(screen(V.app(S))), /Plan only · not submitted Reset 1 slot changed/);
  ["function openProfile(", "function closeLayer()", "function returnFromProfile()"].forEach((f) => t.doesNotMatch(appJs.split(f)[1].split("\n  }\n")[0], /S\.plans/, f + " never touches the plan"));
  // team switch: the plan stays with its team, labeled in the team sheet
  S.teamId = "0010"; t.doesNotMatch(text(screen(V.app(S))), /slot changed/);
  t.match(text(V.teamSheet(S)), /The Long Haulers .*Lineup plan · 1 change · not submitted/);
  S.teamId = "0006"; t.equal(nameIn(S, "OFX1"), "Chris Godwin");
  // Byes uses the recorded lineup; a past week shows only what MFL recorded, with no planner controls
  S.view = "byes"; t.doesNotMatch(screen(V.app(S)), /data-act="plan"|Plan only/);
  S.view = "lineup"; S.wk = S.model.week - 1; t.doesNotMatch(screen(V.app(S)), /data-act="plan"|Plan only/);
  t.match(appJs, /if \(!t \|\| !P \|\| !P\.slotById\(slotId\) \|\| S\.view !== "lineup" \|\| S\.wk != null\) return;/, "the planner opens only on the current week's Lineup");
});

test("review fix (b8aee0b1): a starter on a bye is never offered for another slot; a bye-week occupant still leaves through a bench player", async () => {
  // constructed: Cam Ward (SFX) on a bye this week
  const S = await fresh(), tm = teamOf(S), wk = S.model.week, ward = tm.players.find((p) => p.name === "Cam Ward");
  ward.bye = wk;
  let Dr = PL.draftOf(S, tm), c = PL.options(S, tm, Dr.draft, "QB1").choices.find((x) => x.p.name === "Cam Ward");
  t.ok(c && !c.ok, "the SFX quarterback on a bye is not an enabled choice for QB1"); t.equal(c.why, "Bye week");
  t.equal(pick(S, "QB1", "Cam Ward"), false, "never applied");
  // every enabled choice of every slot: never more bye-week starters than before, and the bye-week player never moves to another starting slot
  const byeStarters = (d) => Object.values(d).filter((pid) => R.onBye(S.model.byId[pid], wk)).length;
  PL.SLOTS.forEach((s) => PL.options(S, tm, Dr.draft, s.id).choices.filter((x) => x.ok).forEach((x) => {
    const next = PL.apply(Dr.draft, s.id, String(x.p.id)), at = PL.slotOfPid(next, String(ward.id));
    t.ok(byeStarters(next) <= byeStarters(Dr.draft) && (at === null || at === "SFX"), s.id + " · " + x.p.name);
  }));
  // the bye-week occupant leaves SFX through a bench player, and the bye error goes away
  const before = PL.validate(S, tm, Dr.draft); t.ok(before.errors.some((e) => /Cam Ward \([A-Z]+\) is on a bye/.test(e)), "the recorded lineup now starts a bye-week player");
  const repl = PL.options(S, tm, Dr.draft, "SFX").choices.find((x) => x.ok && !x.from);
  t.ok(repl, "a bench player can replace him (" + (repl && repl.p.name) + ")");
  t.ok(pick(S, "SFX", repl.p.name)); Dr = PL.draftOf(S, tm);
  t.ok(!PL.validate(S, tm, Dr.draft).errors.some((e) => /on a bye/.test(e)), "no bye-week starter after the replacement");
  t.equal(PL.slotOfPid(Dr.draft, String(ward.id)), null, "Cam Ward is on the bench");
  // constructed: Fernando Mendoza (QB1) on a bye; a swap with SFX would keep him starting, so it is refused with the reason; a bench QB replaces him
  const S2 = await fresh(), tm2 = teamOf(S2); tm2.players.find((p) => p.name === "Fernando Mendoza").bye = S2.model.week;
  const O2 = PL.options(S2, tm2, PL.draftOf(S2, tm2).draft, "QB1"), sw = O2.choices.find((x) => x.p.name === "Cam Ward"), mj = O2.choices.find((x) => x.p.name === "Mac Jones");
  t.ok(sw && !sw.ok && /Fernando Mendoza is on a bye/.test(sw.why), "the SFX swap is refused: it would keep the bye-week QB starting");
  t.ok(mj && mj.ok, "a bench quarterback can replace him");
  t.ok(pick(S2, "QB1", "Mac Jones")); t.ok(!PL.validate(S2, tm2, PL.draftOf(S2, tm2).draft).errors.some((e) => /on a bye/.test(e)), "no bye-week starter");
});

test("nothing is saved, stored or sent: the planner is pure and the app keeps plans in memory only", () => {
  t.doesNotMatch(plannerJs, /fetch|XMLHttpRequest|localStorage|sessionStorage|indexedDB|document\.|sendBeacon/);
  const fns = ["function planOpen(", "function planPick("].map((f) => appJs.split(f)[1].split("\n  }\n")[0]);
  fns.forEach((s) => t.doesNotMatch(s, /loader|fetch|setPref|localStorage|history\./));
  t.match(appJs, /plans: \{\}, planPick: null,/);
});

run("mobile2027_r12_planner");
