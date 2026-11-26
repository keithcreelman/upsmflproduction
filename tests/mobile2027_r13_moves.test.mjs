// UPS 2027 R13 F8 (Keith, 2026-11-26: "F8"): roster moves on the owner's own player (Move to IR, Activate from IR, Move to taxi, Promote from taxi).
//   node tests/mobile2027_r13_moves.test.mjs
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


function own(S, fid) { S.submitMode = true; S.me = { signedIn: true, fid: fid }; return S; }
function withChip(code, fn) { const orig = R.injuryChip; R.injuryChip = (S, p) => (p.__chip ? { code: p.__chip, kind: "res" } : null); try { return fn(); } finally { R.injuryChip = orig; } }

test("movesFor: only the owner's own player; Move to IR needs an MFL IR-type designation AND more than 27 active (canon §B3); taxi only when the worker says eligible", async () => {
  const S = own(await fresh(), "0006"), tm = teamOf(S);
  const act = tm.players.find((p) => p.status === "active");
  withChip(null, () => {
    act.__chip = "IR";
    const m = V.movesFor(S, act), ir = m.find((x) => x.act === "deactivate_ir");
    t.ok(ir, "an IR-designated active player can be offered IR");
    t.equal(ir.ok, tm.counts.active > 27, "allowed only above 27 active (" + tm.counts.active + " active)");
    const saved = tm.counts.active; tm.counts.active = 27;
    const at27 = V.movesFor(S, act).find((x) => x.act === "deactivate_ir"); t.equal(at27.ok, false); t.match(at27.why, /27-player active minimum/);
    tm.counts.active = 28; t.equal(V.movesFor(S, act).find((x) => x.act === "deactivate_ir").ok, true); tm.counts.active = saved;
    act.__chip = "Q"; t.ok(!V.movesFor(S, act).some((x) => x.act === "deactivate_ir"), "a Questionable tag is not IR-eligible");
    ["SUSP", "HOLD", "IR-R", "PUP", "NFI"].forEach((c) => { act.__chip = c; t.ok(V.movesFor(S, act).some((x) => x.act === "deactivate_ir"), c + " is IR-eligible"); });
    delete act.__chip;
  });
  const elig = Object.assign({}, act, { taxi: Object.assign({}, act.taxi, { eligible: true }) }), notElig = Object.assign({}, act, { taxi: Object.assign({}, act.taxi, { eligible: false }) });
  t.ok(V.movesFor(S, elig).some((x) => x.act === "demote_taxi")); t.ok(!V.movesFor(S, notElig).some((x) => x.act === "demote_taxi"));
  const irP = Object.assign({}, act, { status: "ir" }), txP = Object.assign({}, act, { status: "taxi", taxi: { used: 1, max: 3, eligible: false } });
  const acts = (q) => V.movesFor(S, q).map((x) => x.act).filter((a) => a !== "drop_player");   // Drop is tested on its own below
  t.deepEqual(acts(irP), ["activate_ir"]); t.deepEqual(acts(txP), ["promote_taxi"]);
  const saved = tm.counts.active; tm.counts.active = S.model.limits.roster || 30;
  t.equal(V.movesFor(S, irP)[0].ok, false); t.match(V.movesFor(S, irP)[0].why, /active roster is full/); tm.counts.active = saved;
  // another team, signed out, or the Preview build: nothing
  t.deepEqual(V.movesFor(Object.assign({}, S, { me: { signedIn: true, fid: "0001" } }), irP), []);
  t.deepEqual(V.movesFor(Object.assign({}, S, { me: { signedIn: false } }), irP), []);
  t.deepEqual(V.movesFor(Object.assign({}, S, { submitMode: false }), irP), []);
});

test("the profile shows Actions only for the owner's player; the confirm sheet says what the move does; the 4th call-up is permanent", async () => {
  const S = own(await fresh(), "0006"), tm = teamOf(S), p = tm.players.find((x) => x.status === "active");
  S.profile = { pid: String(p.id), tab: "contract" };
  const tx = (h) => h.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
  const txP = Object.assign(p, { status: "taxi", taxi: { used: 3, max: 3, eligible: false } });
  t.match(V.app(S), /<div class="pact"><div class="lbl">Actions<\/div><button class="btn blk" data-act="move" data-v="promote_taxi"/);
  S.move = { pid: String(p.id), act: "promote_taxi" }; S.sheet = "move";
  t.match(tx(V.app(S)), /Promote from taxi\? .* This is his 4th call-up: he’s promoted for good and can never go back to the taxi squad\./);
  txP.taxi.used = 1; t.match(tx(V.moveSheet(S)), /Call-up 2 of 3\./);
  S.move.act = "deactivate_ir"; t.match(tx(V.moveSheet(S)), /50% of his salary against the cap/);
  S.me = { signedIn: true, fid: "0001" }; S.sheet = null; t.doesNotMatch(V.app(S), /data-act="move"/, "another team's player: no Actions");
});

test("submit.js rosterMove: one POST to /roster-workbench/action with the owner session and an Idempotency-Key; verified = done; a refusal says why", async () => {
  const B1 = browser("https://x/m2/", { ups_mfl_user_id: "tok" }, (url, opts) => ({ status: 200, body: { ok: true, message: "Moved Brazzell, Chris to injured reserve.", verification: { ok: true } } }));
  const r = await B1.api.rosterMove(CFGT, "0003", "17509", "deactivate_ir");
  const post = B1.calls[0], u = new URL(post.url);
  t.equal(u.origin + u.pathname, "https://ups-test.keith-creelman.workers.dev/roster-workbench/action"); t.equal(u.searchParams.get("MFL_USER_ID"), "tok"); t.equal(u.searchParams.get("L"), "25625");
  t.equal(post.opts.method, "POST"); t.equal(post.opts.credentials, "omit"); t.match(post.opts.headers["Idempotency-Key"], /^m27-/);
  t.deepEqual(JSON.parse(post.opts.body), { action: "deactivate_ir", league_id: "25625", season: "2026", franchise_id: "0003", player_id: "17509" });
  t.equal(r.state, "confirmed"); t.equal(r.okTitle, "Moved to IR"); t.equal(B1.calls.length, 1, "exactly one request");
  const B2 = browser("https://x/m2/", { ups_mfl_user_id: "tok" }, () => ({ status: 400, body: { ok: false, code: "IR_NOT_ELIGIBLE", error: "Player has no IR designation on MFL" } }));
  const r2 = await B2.api.rosterMove(CFGT, "0003", "1", "deactivate_ir"); t.equal(r2.state, "refused"); t.equal(r2.noTitle, "Not moved to IR"); t.match(r2.reason, /no IR designation/);
  const B3 = browser("https://x/m2/", { ups_mfl_user_id: "tok" }, () => ({ status: 200, body: { ok: true, verified: false, error_code: "MFL_WRITE_UNCONFIRMED" } }));
  t.equal((await B3.api.rosterMove(CFGT, "0003", "1", "promote_taxi")).state, "unconfirmed");
  const B4 = browser("https://x/m2/", { ups_mfl_user_id: "tok" }, () => { throw new Error("no"); });
  t.equal((await B4.api.rosterMove(CFGT, "0003", "1", "drop")).state, "refused"); t.equal(B4.calls.length, 0, "an unknown move sends nothing");
  t.deepEqual(B.scanSubmit("lib/submit.js", SUBMIT), [], "still one network line and one POST");
});

test("app.js: a move is sent only if the profile offers it (own team, rule-checked); a confirmed move reloads the roster", () => {
  t.match(appJs, /var offer = U\.views\.movesFor\(S, p\)\.filter\(function \(x\) \{ return x\.act === mv\.act && x\.ok; \}\)\[0\];\s*if \(!offer\) return;/);
  t.match(appJs, /if \(r\.state === "confirmed"\) \{ S\.profile = null; S\.penalty = \{ state: "idle" \}; loadCore\(\); \}/);
});

// ---------- Drop (Keith 2026-11-26 "Drop"; rulings 2026-11-18) ----------
function penaltyState(S, pid, row, charge) { S.penalty = { state: "ok", data: { [String(pid)]: row }, meta: { calculatedAt: "", earnedThroughWeek: 11, charge } }; }
test("Drop is held unless the worker priced the cut, confirmed it, named the season, and his game hasn't started; otherwise it shows the penalty and the season", async () => {
  const S = own(await fresh(), "0006"), tm = teamOf(S), wk = S.model.week;
  const free = tm.players.find((p) => p.status === "active" && !PL.lockOf(S, p, wk).locked);
  const started = tm.players.find((p) => p.status === "active" && PL.lockOf(S, p, wk).locked);
  const drop = (p) => V.movesFor(S, p).find((x) => x.act === "drop_player");
  S.penalty = { state: "idle" }; t.equal(drop(free).ok, false); t.match(drop(free).why, /cut price isn’t loaded/);
  penaltyState(S, free.id, { penalty: 23029, guaranteed: 42000, earned: 18971, needs_review: true, review_reason: "Taxi eligibility could not be confirmed." }, { ok: true, season: 2027 });
  t.equal(drop(free).ok, false); t.match(drop(free).why, /isn’t confirmed yet/);
  penaltyState(S, free.id, { penalty: 23029, needs_review: false }, { ok: false, reason: "auction_start_unresolved" });
  t.equal(drop(free).ok, false); t.match(drop(free).why, /season the penalty is charged to can’t be confirmed/);
  penaltyState(S, free.id, { penalty: null, needs_review: false }, { ok: true, season: 2027 }); t.equal(drop(free).ok, false);
  penaltyState(S, free.id, { penalty: 23029, needs_review: false }, { ok: true, season: 2027 });
  const savedA = tm.counts.active; tm.counts.active = 27; t.equal(drop(free).ok, false); t.match(drop(free).why, /27-player active minimum: add a player before dropping one/);
  tm.counts.active = 28; t.equal(drop(free).ok, true); tm.counts.active = Math.max(savedA, 28);
  S.profile = { pid: String(free.id), tab: "contract" }; S.move = { pid: String(free.id), act: "drop_player" }; S.sheet = "move";
  const tx = V.moveSheet(S).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
  t.match(tx, /Drop\? .*Cut penalty: \$23,029, charged to the 2027 cap\. He leaves your roster\./);
  penaltyState(S, free.id, { penalty: 0, exempt: true, exempt_reason: "WW pickup salary ≤ $4K, final year (§D2).", needs_review: false }, { ok: true, season: 2027 });
  t.match(V.moveSheet(S).replace(/<[^>]*>/g, " "), /No cut penalty \(WW pickup salary ≤ \$4K, final year\)\. He leaves your roster\./); t.doesNotMatch(V.moveSheet(S), /§/);
  if (started) { penaltyState(S, started.id, { penalty: 1000, needs_review: false }, { ok: true, season: 2027 }); t.match(drop(started).why, /game has started/); t.equal(drop(started).ok, false); }
  S.penalty = { state: "idle" }; t.equal(V.moveSheet(S), "", "a held drop has no confirm sheet");
});

test("rosterMove drop_player and the preview's charge season as the app keeps it", async () => {
  const B1 = browser("https://x/m2/", { ups_mfl_user_id: "tok" }, () => ({ status: 200, body: { ok: true, message: "Dropped Brazzell II, Chris.", verification: { ok: true } } }));
  const r = await B1.api.rosterMove(CFGT, "0003", "17509", "drop_player");
  t.deepEqual(JSON.parse(B1.calls[0].opts.body), { action: "drop_player", league_id: "25625", season: "2026", franchise_id: "0003", player_id: "17509" });
  t.equal(r.state, "confirmed"); t.equal(r.okTitle, "Player dropped");
  const D = require(path.join(SRC, "lib/data.js"));
  const load = (charge) => { const L = D.createLoader({ workerBase: "https://ups-test.keith-creelman.workers.dev", leagueId: "25625", season: "2026" }, () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, players: { "1": { penalty: 0 } }, calculated_at: "x", earned_through_week: 11, charge }), text: () => Promise.resolve(JSON.stringify({ ok: true, players: { "1": { penalty: 0 } }, calculated_at: "x", earned_through_week: 11, charge })), headers: { get: () => "application/json" } })); return L.loadPenalty(); };
  t.deepEqual((await load({ ok: true, applies_to_season: 2027, bucket: "post_auction_next_season" })).meta.charge, { ok: true, season: 2027 });
  t.equal((await load({ ok: false, applies_to_season: null, reason: "auction_start_unresolved" })).meta.charge.ok, false);
  t.equal((await load(undefined)).meta.charge, null, "an older worker without the field: unresolved");
  t.equal((await load({ ok: true, applies_to_season: "2027x" })).meta.charge.ok, false, "a malformed season is not a season");
});

test("no rulebook references on screen (Keith 2026-11-26: 'Get rid of the B3 nonsense across the entire app'): esc() drops them; other text is untouched", async () => {
  const F = require(path.join(SRC, "lib/format.js"));
  t.equal(F.esc("Player placed on IR in MFL (§B3: 50% cap relief, off the active roster max)."), "Player placed on IR in MFL (50% cap relief, off the active roster max).");
  t.equal(F.esc("WW pickup salary ≤ $4K, final year (§D2)."), "WW pickup salary ≤ $4K, final year.");
  t.equal(F.esc("cap-free (canon §B2/§D2/T5.2)."), "cap-free.");
  t.equal(F.esc("cannot be cut until the FA Auction closes (league_context_v1.md §A3). The commissioner can"), "cannot be cut until the FA Auction closes. The commissioner can");
  t.equal(F.esc(" · "), " · "); t.equal(F.esc("  a  b "), "  a  b "); t.equal(F.esc('<a href="x">'), "&lt;a href=&quot;x&quot;&gt;");
  const S = own(await fresh(), "0006"); S.sheet = "result";
  S.submit = { fid: "0006", state: "confirmed", okTitle: "Moved to IR", text: "Player placed on IR in MFL (§B3: 50% cap relief, off the active roster max)." };
  const h = V.app(S); t.doesNotMatch(h, /§/); t.match(h, /Player placed on IR in MFL \(50% cap relief, off the active roster max\)\./);
});

await run("mobile2027_r13_moves");
