// UPS 2027 R13 (Keith, 2026-11-26 phone review, fix log on #1537): F1 "No lineup set", F2 the clean "Swap" picker, F4 a bench player's badge.
//   node tests/mobile2027_r13_lineup_fixes.test.mjs
// Offline and read-only: the real views over the committed recording through the recorded fetch (no network), as the R12 planner suite does.
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
    plans: {}, planPick: null, planFor: null, intel: { status: null, mu: {}, wk: {}, scores: {}, sched: {}, players: null, cal: null, proj: {}, reread: {} } };
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

// a team whose week has no submitted lineup (the read succeeded; MFL lists no starters)
async function emptyWeek() { const S = await fresh(); const tm = teamOf(S); tm.lineup = { state: "ok", count: 0, ids: [] }; return S; }

test("F1: no lineup submitted this week reads 'No lineup set', with no empty slots and no 'need attention' card", async () => {
  const S = await emptyWeek(), h = screen(V.app(S)), tx = text(h);
  t.match(tx, /Starting lineup · No lineup set/);
  t.doesNotMatch(tx, /need attention|· Empty|No starter is set|0\/18/, "no 18-slot list, no attention card");
  t.doesNotMatch(h, /data-act="plan" data-v="/, "no slot badges to tap: there are no slots shown");
  t.ok((h.match(/data-act="planfor" data-v="/g) || []).length > 10, "every active bench player's badge starts a plan instead");
  t.match(text(screen(V.app(Object.assign(S, { view: "byes" })))), /Starting lineup · No lineup set/);
});

test("F1: while planning a week with no submission, only the planned starters show; open slots are not issues", async () => {
  const S = await emptyWeek(), tm = teamOf(S), Dr = PL.draftOf(S, tm);
  t.ok(Dr.ok, Dr.why);
  const slot = PL.SLOTS.find((s) => PL.options(S, tm, Dr.draft, s.id).choices.some((c) => c.ok));
  const c = PL.options(S, tm, Dr.draft, slot.id).choices.find((x) => x.ok);
  S.plans[tm.id] = { week: S.model.week, base: PL.sig(Dr.base), draft: PL.apply(Dr.draft, slot.id, String(c.p.id)) };
  const h = screen(V.app(S)), tx = text(h);
  t.match(tx, /Starting lineup · 1\/18/); t.match(tx, new RegExp(c.p.name));
  t.doesNotMatch(tx, /· Empty|No starter is set|need attention/, "17 open slots are not listed or counted as issues");
  t.equal((h.match(/class="rx empty/g) || []).length, 0, "no empty-slot rows");
});

test("F1: a week WITH a submission still shows every slot, and a real empty slot still warns", async () => {
  const S = await fresh(), tm = teamOf(S); tm.lineup = { state: "ok", count: tm.lineup.ids.length - 1, ids: tm.lineup.ids.slice(1) };
  const tx = text(screen(V.app(S)));
  t.match(tx, /Starting lineup · 17\/18/); t.match(tx, /▲ 1 needs attention/); t.match(tx, /· Empty/);
});

test("F2: the slot picker heads its choices 'Swap' and a row is the player, his game and his projection", async () => {
  const S = await fresh(); S.sheet = "plan"; S.planPick = "OFX1";
  const sh = V.planSheet(S), tx = text(sh);
  t.match(tx, / Swap /); t.doesNotMatch(tx, /Can move here|From the bench|goes to the bench/);
  t.match(tx, /Chris Godwin WR @ DET · Sun 1:00 PM ET · Proj\. —/);
});

test("F4: a bench player's badge lists exactly the slots the planner allows him, and choosing one makes the same swap", async () => {
  const S = await fresh(), tm = teamOf(S), Dr = PL.draftOf(S, tm);
  let checked = 0;
  for (const g of M.benchGroups(tm)) for (const p of g.players) {
    S.sheet = "planfor"; S.planFor = String(p.id);
    const sh = V.planForSheet(S);
    const listed = [...sh.matchAll(/data-act="planforpick" data-v="([A-Z0-9]+)"/g)].map((m) => m[1]).sort();
    const allowed = PL.SLOTS.filter((s) => { const O = PL.options(S, tm, Dr.draft, s.id); return !O.blocked && O.choices.some((c) => String(c.p.id) === String(p.id) && c.ok); }).map((s) => s.id).sort();
    t.deepEqual(listed, allowed, p.name + ": the slots offered = the planner's allowed moves"); checked++;
    if (!allowed.length) t.match(text(sh), /\S/, "a player who can't start says why");
  }
  t.ok(checked > 5, "checked " + checked + " bench players");
  // Chris Godwin from the bench into OFX1 through his own badge = the same draft as from the OFX1 badge
  const godwin = tm.players.find((p) => p.name === "Chris Godwin");
  S.planFor = String(godwin.id); const sh = text(V.planForSheet(S));
  t.match(sh, /Chris Godwin WR/); t.match(sh, / Swap /); t.match(sh, /OFX1 · Offensive flex Adonai Mitchell/);
  t.deepEqual(PL.apply(Dr.draft, "OFX1", String(godwin.id)), (function () { const d = Object.assign({}, Dr.draft); d.OFX1 = String(godwin.id); return d; })());
  const app = fs.readFileSync(path.join(SRC, "app.js"), "utf8");
  t.match(app, /function planForPick\(slotId\) \{\s*var pid = S\.planFor; S\.planFor = null;\s*if \(!pid \|\| !U\.planner \|\| !U\.planner\.slotById\(slotId\)\) return;\s*S\.planPick = slotId; planPick\(pid\);/, "the bench path goes through planPick, which applies only a listed, allowed choice");
});

test("F9: a starter can be moved to the bench with no replacement; a locked starter can't; the slot is left empty in the plan", async () => {
  const S = await fresh(), tm = teamOf(S), Dr = PL.draftOf(S, tm);
  const open = PL.SLOTS.find((s) => Dr.draft[s.id] && !PL.options(S, tm, Dr.draft, s.id).blocked);
  const locked = PL.SLOTS.find((s) => Dr.draft[s.id] && PL.options(S, tm, Dr.draft, s.id).blocked);
  const occ = S.model.byId[Dr.draft[open.id]];
  S.sheet = "plan"; S.planPick = open.id;
  const sh = V.planSheet(S);
  t.match(sh, /data-act="planbench"/); t.match(text(sh), new RegExp("Bench Move " + occ.name + " to the bench " + open.tag + " is left empty"));
  if (locked) { S.planPick = locked.id; t.doesNotMatch(V.planSheet(S), /data-act="planbench"/, "a locked starter has no bench choice"); }
  // what app.js planBench does
  const app = fs.readFileSync(path.join(SRC, "app.js"), "utf8");
  t.match(app, /function planBench\(\) \{[\s\S]{0,400}var O = P\.options\(S, t, D\.draft, slotId\); if \(O\.blocked\) return;/, "planBench refuses a locked slot");
  const next = {}; Object.keys(Dr.draft).forEach((k) => { if (k !== open.id && Dr.draft[k]) next[k] = Dr.draft[k]; });
  S.plans[tm.id] = { week: S.model.week, base: PL.sig(Dr.base), draft: next }; S.sheet = null;
  const h = screen(V.app(S)), tx = text(h);
  t.match(tx, /Starting lineup · 17\/18/); t.match(tx, new RegExp(occ.name + "[^]*Was starting"), "he is on the bench, marked as the starter he was");
  t.match(tx, /▲ 1 needs attention/, "a submitted week: the slot left empty is a real open slot");
});

await run("mobile2027_r13_lineup_fixes");
