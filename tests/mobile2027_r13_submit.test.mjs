// UPS 2027 R13 F3 (Keith, 2026-11-26: "Now F3"): Submit Lineup, the Test target's one write (lib/submit.js).
//   node tests/mobile2027_r13_submit.test.mjs
// Offline: the build and its scans, lib/submit.js against a fake browser (no network), and the views in submit mode over the committed recording.
import os from "node:os";
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
    plans: {}, planPick: null, planFor: null, submitMode: false, me: null, submit: null, leave: null, intel: { status: null, mu: {}, wk: {}, scores: {}, sched: {}, players: null, cal: null, proj: {}, reread: {} } };
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

const APP = path.join(HERE, "..", "apps", "mobile2027");
const B = await import(new URL("file://" + path.join(APP, "scripts/build.mjs")).href);
const SUBMIT = fs.readFileSync(path.join(SRC, "lib/submit.js"), "utf8");
const FIXSH = path.join(HERE, "fixtures/mobile2027/shared"), FIXLOCK = path.join(os.tmpdir(), "m27-submit-lock-" + process.pid + ".json");
fs.writeFileSync(FIXLOCK, JSON.stringify(B.computeLock(FIXSH), null, 2));
process.on("exit", () => { try { fs.rmSync(FIXLOCK, { force: true }); } catch (e) { /* ignore */ } });
const git = () => ({ commit: "b".repeat(40), dirty: false });
const out = () => fs.mkdtempSync(path.join(os.tmpdir(), "m27-sub-"));

test("build: only the Test target carries lib/submit.js, loaded before app.js; the Preview build has no write module", () => {
  const pv = out(), tt = out();
  const p = B.build(pv, SRC, git, FIXSH, FIXLOCK, {}), q = B.build(tt, SRC, git, FIXSH, FIXLOCK, { target: "test" });
  t.ok(p.ok && q.ok, JSON.stringify((p.problems || []).concat(q.problems || [])));
  t.ok(!fs.existsSync(path.join(pv, "lib/submit.js")) && !fs.readFileSync(path.join(pv, "index.html"), "utf8").includes("submit.js"), "Preview: no submit module");
  t.ok(!p.manifest.files.some((f) => f.path === "lib/submit.js"));
  const idx = fs.readFileSync(path.join(tt, "index.html"), "utf8");
  t.ok(fs.existsSync(path.join(tt, "lib/submit.js")) && idx.indexOf('<script src="lib/submit.js"></script>') > 0 && idx.indexOf('<script src="lib/submit.js"></script>') < idx.indexOf('<script src="app.js"></script>'), "Test: submit.js loads before app.js");
  t.deepEqual(B.scanSubmit("lib/submit.js", SUBMIT), [], "the real module passes its scan");
});

test("build: the submit scan refuses a second write verb, a second network line, another route, a missing key, and the Preview bans", () => {
  const bad = (from, to) => B.scanSubmit("lib/submit.js", SUBMIT.split(from).join(to));
  t.ok(bad('method: "POST"', 'method: "PUT"').length, "PUT instead of POST");
  t.ok(B.scanSubmit("lib/submit.js", SUBMIT + '\nvar z = "DELETE";').length, "an extra verb");
  t.ok(B.scanSubmit("lib/submit.js", SUBMIT + "\nroot.fetch(url, opts);").length, "a second network line");
  t.ok(B.scanSubmit("lib/submit.js", SUBMIT + '\nvar r = "/api/trades/2way/accept";').length, "a route outside the three");
  t.ok(bad('"Idempotency-Key": key', '"X-Other": key').length, "no Idempotency-Key");
  t.ok(B.scanSubmit("lib/submit.js", SUBMIT + "\nnew XMLHttpRequest();").length, "XHR");
  t.ok(bad('credentials: "omit", cache: "no-store", redirect: "error",\n      headers', 'credentials: "include", cache: "no-store", redirect: "error",\n      headers').length, "credentials other than omit");
  // and the Preview scan still refuses the module outright
  t.ok(B.scanWriteCode("lib/submit.js", SUBMIT).length > 0, "the Preview scan would refuse it");
});

// lib/submit.js against a fake browser
function browser(href, stored, answers) {
  const calls = [], store = Object.assign({}, stored || {});
  const win = { location: { href: href }, crypto: globalThis.crypto, URL, Uint8Array, JSON, Promise, String, Object, Array, Date,
    history: { replaceState: (a, b, u) => { win.location.href = new URL(u, href).toString(); calls.push({ replaced: u }); } },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    fetch: (url, opts) => { calls.push({ url, opts }); const a = answers(url, opts); return Promise.resolve({ ok: a.status < 400, status: a.status, text: () => Promise.resolve(JSON.stringify(a.body)), headers: { get: () => a.ledger || "" } }); } };
  win.window = win;
  vm.runInNewContext(SUBMIT, win);
  return { win, calls, store, api: win.UPS2027.submit };
}
const CFGT = { workerBase: "https://ups-test.keith-creelman.workers.dev", leagueId: "25625", season: "2026" };
const weekly = (fid, ids) => ({ weeklyResults: { week: "12", matchup: [{ franchise: [{ id: fid, player: ids.map((id) => ({ id, status: "starter" })).concat([{ id: "999", status: "nonstarter" }]) }, { id: "0001", player: [] }] }] } });

test("submit.js: one POST to the test worker's /api/submit-lineup with an Idempotency-Key; MFL read back; confirmed only when it matches", async () => {
  const B1 = browser("https://ups-test-25625.pages.dev/m2/?MFL_USER_ID=tok-abc#x", {}, (url, opts) => {
    if (opts.method === "POST") return { status: 200, body: { ok: true, franchise_id: "0003", week_used: "12" }, ledger: "responded" };
    if (url.includes("TYPE=weeklyResults")) return { status: 200, body: weekly("0003", ["16148", "15700"]) };
    return { status: 404, body: {} };
  });
  t.equal(B1.store.ups_mfl_user_id, "tok-abc", "the sign-in from the link is kept on this device");
  t.doesNotMatch(B1.win.location.href, /MFL_USER_ID/, "and removed from the address bar");
  const r = await B1.api.lineup(CFGT, "0003", 12, ["16148", "15700"]);
  const post = B1.calls.find((c) => c.opts && c.opts.method === "POST"), u = new URL(post.url);
  t.equal(u.origin + u.pathname, "https://ups-test.keith-creelman.workers.dev/api/submit-lineup");
  t.equal(u.searchParams.get("L"), "25625"); t.equal(u.searchParams.get("MFL_USER_ID"), "tok-abc");
  t.equal(post.opts.credentials, "omit"); t.match(post.opts.headers["Idempotency-Key"], /^m27-[0-9a-f-]{32,36}$/);
  t.deepEqual(JSON.parse(post.opts.body), { franchiseId: "0003", week: "12", starters: ["16148", "15700"] });
  const rb = B1.calls.filter((c) => c.url && c.url.includes("TYPE=weeklyResults"));
  t.equal(rb.length, 1); t.ok(new URL(rb[0].url).searchParams.get("_"), "the read-back skips the worker's short cache"); t.equal(new URL(rb[0].url).searchParams.get("W"), "12");
  t.equal(r.state, "confirmed"); t.deepEqual(r.starters, ["16148", "15700"]); t.match(r.text, /MFL shows the same 2 starters for week 12/);
  t.equal(B1.calls.filter((c) => c.opts && c.opts.method === "POST").length, 1, "exactly one write");
});

test("submit.js: MFL showing something else is 'different'; a refusal says why and that MFL is unchanged; no sign-in sends nothing", async () => {
  const B2 = browser("https://x/m2/", { ups_mfl_user_id: "tok" }, (url, opts) => opts.method === "POST" ? { status: 200, body: { ok: true, week_used: "12" } } : { status: 200, body: weekly("0003", ["16148"]) });
  const r2 = await B2.api.lineup(CFGT, "0003", 12, ["16148", "15700"]);
  t.equal(r2.state, "different"); t.deepEqual(r2.starters, ["16148"], "MFL's own lineup is what gets shown");
  const B3 = browser("https://x/m2/", { ups_mfl_user_id: "tok" }, () => ({ status: 403, body: { ok: false, error: "Cookie belongs to franchise 0001, cannot submit lineup for 0003" } }));
  const r3 = await B3.api.lineup(CFGT, "0003", 12, ["1"]);
  t.equal(r3.state, "refused"); t.match(r3.text, /Cookie belongs to franchise 0001.*Your lineup on MFL is unchanged\./);
  t.equal(B3.calls.filter((c) => c.url && c.url.includes("weeklyResults")).length, 0, "no read-back after a refusal");
  const B4 = browser("https://x/m2/", {}, () => { throw new Error("must not be called"); });
  const r4 = await B4.api.lineup(CFGT, "0003", 12, ["1"]);
  t.equal(r4.state, "refused"); t.equal(B4.calls.length, 0, "no sign-in: no request at all");
  const w = await browser("https://x/m2/", { ups_mfl_user_id: "tok" }, () => ({ status: 200, body: { configured: true, franchise_id: "3", franchise_name: "Gride" } })).api.whoami(CFGT);
  t.deepEqual(JSON.parse(JSON.stringify(w)), { signedIn: true, fid: "0003", name: "Gride" });
});

// the views in submit mode
async function own(fid) { const S = await fresh(fid); S.submitMode = true; S.me = { signedIn: true, fid: fid || "0006" }; return S; }
function planOne(S) {
  const tm = teamOf(S), Dr = PL.draftOf(S, tm);
  const slot = PL.SLOTS.find((s) => PL.options(S, tm, Dr.draft, s.id).choices.some((c) => c.ok && !c.from));
  const c = PL.options(S, tm, Dr.draft, slot.id).choices.find((x) => x.ok && !x.from);
  S.plans[tm.id] = { week: S.model.week, base: PL.sig(Dr.base), draft: PL.apply(Dr.draft, slot.id, String(c.p.id)) };
  return { slot, c };
}

test("views: a change on your own team shows one 'Submit Lineup' with Undo; no 'Plan only' and no 'Planned' chips", async () => {
  const S = await own(); const before = text(screen(V.app(S)));
  t.match(before, /Tap a badge to change your lineup\./); t.doesNotMatch(before, /Plan only/);
  const { slot } = planOne(S); const h = screen(V.app(S)), tx = text(h);
  t.match(h, /<button class="btn pri" data-act="submit">Submit Lineup<\/button>/, "enabled");
  t.match(tx, /1 change Undo Submit Lineup/); t.doesNotMatch(tx, /Plan only|Planned|Was starting/);
  S.sheet = "plan"; S.planPick = slot.id; t.doesNotMatch(text(V.planSheet(S)), /Plan only/);
});

test("views F10: only the signed-in owner's own team can be changed; another team, or nobody signed in, has no planner controls at all", async () => {
  // signed out: no badge is a control, no Submit, one line on how to sign in
  const S = await own(); S.me = { signedIn: false, why: "Not signed in" }; planOne(S);
  let h = screen(V.app(S));
  t.doesNotMatch(h, /data-act="(plan|planfor|submit|planreset)"/, "signed out: nothing to tap"); t.match(text(h), /Sign in to change your lineup/);
  // another team: no controls and no message
  S.me = { signedIn: true, fid: "0001" }; h = screen(V.app(S));
  t.doesNotMatch(h, /data-act="(plan|planfor|submit|planreset)"/, "another team: nothing to tap"); t.doesNotMatch(text(h), /Sign in|own team/);
  // his own team: the planner is there
  S.me = { signedIn: true, fid: "0006" }; h = screen(V.app(S));
  t.match(h, /data-act="plan" data-v="/); t.match(h, /data-act="submit"/);
  // app.js refuses a planner action on any other team even if one were drawn
  t.match(appJs, /function mayPlan\(t\) \{ return !S\.submitMode \|\| !!\(t && S\.me && S\.me\.signedIn && S\.me\.fid === t\.id\); \}/);
  ["planOpen(slotId)", "planOpenFor(pid)"].forEach((f) => t.match(appJs, new RegExp("function " + f.replace(/[()]/g, "\\$&") + " \\{\\s*var t = curTeam\\(\\), P = U\\.planner;\\s*if \\(!mayPlan\\(t\\)\\) return;")));
  t.match(appJs, /if \(!t \|\| !P \|\| !slotId \|\| !mayPlan\(t\)\) return;/);
  // F11: signed in, the app opens on his team
  t.match(appJs, /if \(m\.signedIn && S\.model && S\.model\.teams\.some\(function \(x\) \{ return x\.id === m\.fid; \}\) && S\.teamId !== m\.fid\) \{ S\.teamId = m\.fid;/);
});

test("views: a lineup with a real problem can't be sent; an EMPTY one can't either (MFL: 'Missing Starters'; Keith 2026-11-26 'A')", async () => {
  const S2 = await own(), tm = teamOf(S2), Dr = PL.draftOf(S2, tm), wk = S2.model.week;
  const byeP = tm.players.find((p) => p.status === "active" && R.onBye(p, wk) && !PL.slotOfPid(Dr.draft, String(p.id)));
  if (byeP) {
    const sl = PL.SLOTS.find((s) => s.acc.indexOf(byeP.pos) >= 0); const d = Object.assign({}, Dr.draft); d[sl.id] = String(byeP.id);
    S2.plans[tm.id] = { week: wk, base: PL.sig(Dr.base), draft: d };
    const h2 = screen(V.app(S2)); t.match(h2, /data-act="submit" disabled/); t.match(text(h2), /on a bye/);
  }
  S2.plans[tm.id] = { week: wk, base: PL.sig(Dr.base), draft: {} };   // everyone benched
  const h3 = screen(V.app(S2)); t.match(h3, /data-act="submit" disabled/, "an empty lineup can't be sent"); t.match(text(h3), /MFL needs at least one starter\./); t.doesNotMatch(text(h3), /Short lineup: 0/);
  t.match(appJs, /if \(!starters\.length\) return;/, "doSubmit refuses it too");
  t.equal(PL.validate(S2, tm, {}).problems, 0);
  const sending = Object.assign({}, S2, { submit: { state: "sending", fid: tm.id } });
  t.ok(V.submitBar(sending, tm, PL.draftOf(sending, tm)).includes('data-act="submit" disabled'), "not twice while sending");
});

test("views: the submit result stays on screen; the leave sheet offers Submit, Discard and Keep editing; the Preview build is unchanged", async () => {
  const S = await own(); S.submit = { fid: "0006", state: "confirmed", title: "Lineup submitted", text: "MFL shows the same 18 starters for week 11." };
  t.match(text(screen(V.app(S))), /Lineup submitted MFL shows the same 18 starters for week 11\./);
  S.submit = { fid: "0006", state: "refused", title: "Not submitted", text: "x. Your lineup on MFL is unchanged." };
  t.match(screen(V.app(S)), /class="card warnc" role="status"><b>Not submitted/);
  S.sheet = "leave"; const ls = V.app(S);
  t.match(ls, /data-act="leavesubmit">Submit Lineup/); t.match(ls, /data-act="leavediscard">Discard changes/); t.match(ls, /data-act="leavestay">Keep editing/);
  const P = await fresh(); planOne(P); const tx = text(screen(V.app(P)));
  t.match(tx, /Plan only · not submitted/); t.doesNotMatch(screen(V.app(P)), /data-act="submit"/, "the Preview build never shows Submit");
});

test("app.js: Submit goes only through doSubmit (own team, a real change, no problem, not already sending); leaving with changes is held", () => {
  t.match(appJs, /function doSubmit\(then\) \{[\s\S]{0,300}if \(!own \|\| !t \|\| own\.t\.id !== t\.id \|\| \(S\.submit && S\.submit\.state === "sending"\)\) return;\s*var v = P\.validate\(S, t, own\.D\.draft\); if \(v\.problems\) return;/);
  t.match(appJs, /if \(leaveGuard\(act, v, el\)\) return;/); t.match(appJs, /window\.addEventListener\("beforeunload"/);
  t.match(appJs, /submitMode: !!\(U\.submit && cfg\.data === "live"\)/, "submit mode needs the module AND live data");
});

await run("mobile2027_r13_submit");
