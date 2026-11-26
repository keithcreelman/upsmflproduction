// UPS 2027 R13 F7 + F5 (Keith, 2026-11-26: "5 & 7"): the projected total in the Starting lineup header, and "MFL Optimal Starters".
//   node tests/mobile2027_r13_optimal.test.mjs
// Offline: the real views and planner over the committed recording; projections are supplied as a live MFL read would supply them.
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
    plans: {}, planPick: null, planFor: null, submitMode: true, me: null, submit: null, leave: null, intel: { status: null, mu: {}, wk: {}, scores: {}, sched: {}, players: null, cal: null, proj: {}, reread: {} } };
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

const TV = require(path.join(SRC, "lib/tabviews.js"));
// a deterministic projection per player (as MFL's live read would give, in the shape app.js keeps)
const projFor = (id) => { let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) % 1000; return h % 7 === 0 ? null : Math.round(h / 3) / 10; };
function withProj(S) {
  const out = {}; S.model.teams.forEach((tm) => tm.players.forEach((p) => { const v = projFor(p.id); out[String(p.id)] = v == null ? null : { projected_score: v, captured_at: new Date().toISOString(), first_projected: null, first_captured_at: null }; }));
  S.intel.proj = { [S.model.week]: { state: "ok", data: { ok: true, season: Number(S.model.season), week: S.model.week, provider: "MFL", live: true, projections: out } } };
  return S;
}
const projOf = (S) => (p) => { const g = TV.projectionSlot(S, p); return g ? g.value : null; };

test("F7: the Starting lineup header carries the projected total of the starters shown, and says how many have no projection", async () => {
  const S = withProj(await fresh()); S.me = { signedIn: true, fid: S.teamId };
  const tm = teamOf(S), lu = R.lineupFor(S, tm, S.model.week);
  let sum = 0, miss = 0; lu.slots.forEach((x) => { if (!x.player) return; const v = projOf(S)(x.player); if (v == null) miss++; else sum += v; });
  const want = "Starting lineup · " + lu.count + "/18 · Proj. " + (Math.round(sum * 10) / 10).toFixed(1) + (miss ? " (" + miss + " without)" : "");
  t.ok(text(screen(V.app(S))).includes(want), want);
  const bare = await fresh(); bare.submitMode = true; bare.me = S.me;
  t.doesNotMatch(text(screen(V.app(bare))), /Starting lineup · \d+\/18 · Proj\./, "no projections loaded: no total");
});

test("F5: for every team, the optimal lineup is legal, keeps started games, uses only startable players, and no single swap improves it", async () => {
  const S = withProj(await fresh()), wk = S.model.week, val = (v) => (v == null ? -0.001 : v);
  let teams = 0, filled = 0;
  for (const tm of S.model.teams) {
    const Dr = PL.draftOf(S, tm); if (!Dr.ok) continue; teams++;
    const out = PL.optimal(S, tm, Dr.draft, projOf(S));
    const v = PL.validate(S, tm, out); t.equal(v.problems, 0, tm.name + ": " + v.errors.join(" · "));
    const ids = Object.values(out); t.equal(new Set(ids).size, ids.length, tm.name + ": one slot each");
    PL.SLOTS.forEach((s) => { const pid = Dr.draft[s.id], p = pid && S.model.byId[pid]; if (p && PL.lockOf(S, p, wk).locked && !R.onBye(p, wk)) t.equal(out[s.id], pid, tm.name + ": " + p.name + " (game started) stays in " + s.id); });
    Object.entries(out).forEach(([sid, pid]) => { const p = S.model.byId[pid]; if (Dr.draft[sid] !== pid || !PL.lockOf(S, p, wk).locked) t.ok(PL.startable(S, p, wk).ok || Dr.draft[sid] === pid, tm.name + ": " + p.name + " can start"); });
    // no unused startable player who fits a slot beats that slot's (unlocked) occupant
    const usedSet = new Set(ids);
    PL.SLOTS.forEach((s) => {
      const pid = out[s.id], occ = pid ? S.model.byId[pid] : null;
      if (occ && PL.lockOf(S, occ, wk).locked) return;
      tm.players.forEach((p) => { if (usedSet.has(String(p.id)) || !PL.startable(S, p, wk).ok || s.acc.indexOf(p.pos) < 0) return;
        t.ok(val(projOf(S)(p)) <= (occ ? val(projOf(S)(occ)) : -Infinity) + 1e-9, tm.name + " " + s.id + ": " + p.name + " would not be better than " + (occ ? occ.name : "empty")); });
    });
    filled += ids.length;
  }
  t.ok(teams >= 10, "covered " + teams + " teams (" + filled + " starters)");
});

test("F5: the button is on the owner's own lineup, waits for projections, and makes a plan to review (nothing is sent)", async () => {
  const S = await fresh(); S.me = { signedIn: true, fid: S.teamId };
  t.match(screen(V.app(S)), /data-act="optimal" disabled>MFL Optimal Starters/); t.match(text(screen(V.app(S))), /Projections not loaded\./);
  withProj(S); t.match(screen(V.app(S)), /<button class="btn blk" data-act="optimal">MFL Optimal Starters<\/button>/);
  S.me = { signedIn: true, fid: "0001" }; t.doesNotMatch(screen(V.app(S)), /data-act="optimal"/, "another team: no button");
  t.match(appJs, /function doOptimal\(\) \{[\s\S]{0,260}if \(!t \|\| !P \|\| !mayPlan\(t\) \|\| !S\.submitMode \|\| !S\.intel\.proj/, "own team, test target, projections loaded");
  t.match(appJs, /S\.plans\[t\.id\] = \{ week: wk, base: P\.sig\(D\.base\), draft: next \};/, "it only becomes the plan; Submit Lineup sends it");
  t.doesNotMatch(appJs.slice(appJs.indexOf("function doOptimal"), appJs.indexOf("function doOptimal") + 1200), /U\.submit\.lineup|doSubmit/, "optimal never submits");
});

await run("mobile2027_r13_optimal");
