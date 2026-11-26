// UPS 2027 Trades v1 (Keith, 2026-11-26: "go trades v1"): League › Trades on the Test target. The classic phone app (site/m/views/trade.js) is the
// baseline: the same worker routes and request bodies, the worker's cap / loaded-contract check and accept gate, MFL's trade lock (fail closed).
//   node tests/mobile2027_r13_trades.test.mjs
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..", "apps", "mobile2027"), SRC = path.join(APP, "src");
const require = createRequire(import.meta.url);
const M = require(path.join(SRC, "lib/model.js")), D = require(path.join(SRC, "lib/data.js")), RC = require(path.join(SRC, "lib/recorded.js"));
const V = require(path.join(SRC, "lib/views.js")), T = require(path.join(SRC, "lib/trades.js"));
const ld = (f) => { const c = vm.createContext({}); c.window = c; vm.runInContext(fs.readFileSync(path.join(SRC, f), "utf8"), c); return JSON.parse(JSON.stringify(c.UPS2027_RECORDED || c.UPS2027_CONFIG)); };
const BUNDLE = ld("recorded_data.js"), CFG = ld("config.js");
const text = (h) => h.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const SUBMIT = fs.readFileSync(path.join(SRC, "lib/submit.js"), "utf8"), TRADES = fs.readFileSync(path.join(SRC, "lib/trades.js"), "utf8");
const appJs = fs.readFileSync(path.join(SRC, "app.js"), "utf8");
const B = await import(new URL("file://" + path.join(APP, "scripts/build.mjs")).href);
const FIXSH = path.join(HERE, "fixtures/mobile2027/shared"), FIXLOCK = path.join(os.tmpdir(), "m27-trades-lock-" + process.pid + ".json");
fs.writeFileSync(FIXLOCK, JSON.stringify(B.computeLock(FIXSH), null, 2));
process.on("exit", () => { try { fs.rmSync(FIXLOCK, { force: true }); } catch (e) { /* ignore */ } });
const git = () => ({ commit: "c".repeat(40), dirty: false });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "m27-tr-"));

async function fresh(me) {
  const L = D.createLoader(CFG, RC.createFetch(BUNDLE));
  const core = await L.loadCore();
  const model = M.build(core.roster.data, core.league.data, core.weekly.data, core.week, 2026);
  const S = { model, load: { core: "ok", coreNotes: [] }, penalty: { state: "idle" }, ns: { state: "idle" }, teamId: me, tab: "league", sub: "roster", view: "lineup", open: {}, flags: {}, profile: null, sheet: null,
    skin: "system", vib: "1", build: "test", requestLog: [], wk: null, live: null, pf: { s: "pos", open: {}, res: {}, q: "", pos: "all", xt: false, xpos: "all", note: null },
    ct: { f: "all", l: "all", s: "exp", y: 0, d: 1, open: {}, hist: {}, bd: false, cat: {}, ns: false }, requestSummary: { requests: 0, ok: 0, failed: 0, refused: 0, nonGet: 0 }, sample: { on: false },
    plans: {}, planPick: null, planFor: null, submitMode: true, me: { signedIn: true, fid: me }, submit: null, leave: null, intel: { status: null, mu: {}, wk: {}, scores: {}, sched: {}, players: null, cal: null, proj: {}, reread: {} } };
  S.tradesUi = T; S.tr = Object.assign(T.fresh(), { league: "25625", season: "2026" });
  return S;
}
const NOW = Date.UTC(2026, 10, 26, 20, 0, 0);
const LOCK_UP = { state: "upcoming", start_unix: Date.UTC(2026, 11, 4, 1, 15) / 1000, end_unix: Date.UTC(2027, 0, 6) / 1000, label: "Thu, Dec 3, 8:15 PM ET" };
const ids = (S, fid, n) => S.model.teams.find((x) => x.id === fid).players.slice(0, n).map((p) => String(p.id));
function inv(S, fid) {
  const tm = S.model.teams.find((x) => x.id === fid);
  return { state: "ok", players: tm.players.slice(0, 4).map((p, i) => ({ player_id: String(p.id), display: p.name, position: p.pos, nfl_team: "DET", salary: [20000, 9000, 3000, 1000][i], contract_year: 1, contract_status: "Veteran", taxi: i === 3, roster_status: i === 3 ? "TAXI_SQUAD" : "ROSTER" })),
    future_picks: [{ year: "2027", round: "1", original_fid: fid }, { year: "2027", round: "2", original_fid: "0009", original_team_name: "Other" }, { year: "2027", round: "6", original_fid: fid }, { year: "2028", round: "3", original_fid: fid, forfeited: true, forfeit_label: "Forfeited — lineup penalty" }] };
}

// lib/submit.js against a fake browser
function browser(stored, answers) {
  const calls = [], store = Object.assign({}, stored || {});
  const win = { location: { href: "https://ups-test-25625.pages.dev/m2/" }, crypto: globalThis.crypto, URL, Uint8Array, JSON, Promise, String, Object, Array, Date,
    history: { replaceState: () => {} },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    fetch: (url, opts) => { calls.push({ url, opts }); const a = answers(url, opts); return Promise.resolve({ ok: a.status < 400, status: a.status, text: () => Promise.resolve(JSON.stringify(a.body)), headers: { get: () => "" } }); } };
  win.window = win;
  vm.runInNewContext(SUBMIT, win);
  return { calls, api: win.UPS2027.submit.trades };
}
const CFGT = { workerBase: "https://ups-test.keith-creelman.workers.dev", leagueId: "25625", season: "2026" };
const route = (c) => { const u = new URL(c.url); return u.origin + u.pathname; };

test("submit.js: offers is a GET with the owner's sign-in; check, create and every action are one POST each with a new Idempotency-Key, credentials omitted", async () => {
  const W = browser({ ups_mfl_user_id: "tok" }, (url) => ({ status: 200, body: { ok: true, incoming: [], outgoing: [] } }));
  await W.api.offers(CFGT, "0001");
  const g = W.calls[0], gu = new URL(g.url);
  t.equal(route(g), "https://ups-test.keith-creelman.workers.dev/api/trades/proposals"); t.equal(g.opts.method, "GET"); t.equal(g.opts.credentials, "omit");
  t.equal(gu.searchParams.get("MFL_USER_ID"), "tok"); t.equal(gu.searchParams.get("franchise_id"), "0001"); t.equal(gu.searchParams.get("L"), "25625"); t.equal(gu.searchParams.get("YEAR"), "2026");
  await W.api.check(CFGT, "0001", [{ from: "0001", to: "0002", asset_tokens: ["P_1"], cap_k: 0 }]);
  await W.api.create(CFGT, { from_franchise_id: "0001", to_franchise_id: "0002", payload: {} }, "sig-1");
  await W.api.action(CFGT, "0001", "accept", "123", "");
  await W.api.action(CFGT, "0001", "reject", "124", "no thanks");
  const posts = W.calls.slice(1);
  t.deepEqual(posts.map(route).map((u) => u.replace("https://ups-test.keith-creelman.workers.dev", "")), ["/api/trades/compliance-preview", "/api/trades/proposals", "/api/trades/proposals/action", "/api/trades/proposals/action"]);
  posts.forEach((c) => { t.equal(c.opts.method, "POST"); t.equal(c.opts.credentials, "omit"); t.match(c.opts.headers["Idempotency-Key"], /^m27-/); t.equal(new URL(c.url).searchParams.get("MFL_USER_ID"), "tok"); });
  t.equal(new Set(posts.map((c) => c.opts.headers["Idempotency-Key"])).size, 4, "a new key for every request");
  t.deepEqual(JSON.parse(posts[1].opts.body).cap_ack, { signature: "sig-1" }, "an acknowledged overage is sent with its signature");
  const a = JSON.parse(posts[2].opts.body); t.equal(a.action, "accept"); t.equal(a.trade_id, "123"); t.equal(a.franchise_id, "0001"); t.equal(a.acting_franchise_id, "0001"); t.equal(a.league_id, "25625");
  t.equal(JSON.parse(posts[3].opts.body).message, "no thanks");
  let threw = false; try { await W.api.action(CFGT, "0001", "counter", "1", ""); } catch (e) { threw = true; }
  t.ok(threw, "an unknown verb is refused"); t.equal(W.calls.length, 5, "and sends nothing");
  const W2 = browser({}, () => ({ status: 200, body: {} }));
  t.equal((await W2.api.offers(CFGT, "0001")).status, 401, "signed out: no request"); t.equal(W2.calls.length, 0);
  t.deepEqual(B.scanSubmit("lib/submit.js", SUBMIT), [], "still one network line and one POST");
});

test("trades.js: tokens read as owners say them (MFL's DP_ is zero-indexed; BB_ is dollars; a pick from another team names it)", async () => {
  const S = await fresh("0006"), p = S.model.teams[0].players[0];
  t.match(T.tokenLabel(S, String(p.id), "0001"), new RegExp("^" + p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " · "));
  t.equal(T.tokenLabel(S, "99999999", "0001"), "Player 99999999");
  t.equal(T.tokenLabel(S, "DP_0_3", "0001"), "Pick 1.04");
  t.equal(T.tokenLabel(S, "BB_4000", "0001"), "$4,000 cap money");
  t.equal(T.tokenLabel(S, "FP_0006_2027_1", "0006"), "2027 Round 1");
  t.match(T.tokenLabel(S, "FP_0002_2027_2", "0006"), /^2027 Round 2 \(.+\)$/);
});

test("the trade lock fails closed: Send and Accept need MFL's calendar read, and a time before the lock", async () => {
  const S = await fresh("0006");
  t.equal(T.gate(S, NOW).ok, false, "not read yet");
  S.tr.lock = { state: "error" }; t.deepEqual(T.gate(S, NOW), { ok: false, text: "Trade deadline couldn’t be checked." });
  S.tr.lock = { state: "ok", data: LOCK_UP }; t.deepEqual(T.gate(S, NOW), { ok: true, text: "Trades lock Thu, Dec 3, 8:15 PM ET." });
  t.equal(T.gate(S, LOCK_UP.start_unix * 1000 + 1000).ok, false, "past the start: locked");
  S.tr.lock = { state: "ok", data: { state: "closed" } }; t.deepEqual(T.gate(S, NOW), { ok: false, text: "Trades are locked." });
  S.tr.lock = { state: "ok", data: { state: "unresolved" } }; t.equal(T.gate(S, NOW).ok, false);
  S.tr.lock = { state: "ok", data: { state: "none" } }; t.equal(T.gate(S, NOW).ok, true, "no trade lock on MFL's calendar");
});

test("the builder: the classic app's offer body; cap money held to half the non-taxi salary sent; round 6 and forfeited picks can't be picked", async () => {
  const S = await fresh("0006"), me = "0006", to = "0002";
  S.tr.inv[me] = inv(S, me); S.tr.inv[to] = inv(S, to);
  const mine = S.tr.inv[me].players, theirs = S.tr.inv[to].players;
  S.tr.d = Object.assign(T.blankDraft(), { to });
  t.equal(T.build(S, me).ready, false, "each side needs a player or a pick");
  S.tr.d.give["P_" + mine[0].player_id] = true; S.tr.d.give["P_" + mine[3].player_id] = true;   // $20,000 + a taxi player
  S.tr.d.get["P_" + theirs[1].player_id] = true; S.tr.d.get["FP_" + to + "_2027_1"] = true; S.tr.d.get["FP_" + to + "_2027_6"] = true; S.tr.d.get["FP_" + to + "_2028_3"] = true;
  S.tr.d.capGive = 50; S.tr.d.capGet = 9;
  const X = T.build(S, me);
  t.equal(T.maxCapK(S.tr.inv[me], S.tr.d.give), 10, "half of $20,000 (the taxi player doesn't count)");
  t.equal(X.capGive, 10, "held to the max"); t.equal(X.capGet, 4, "half of $9,000, rounded down to whole $1K");
  t.equal(X.ready, true);
  t.deepEqual(X.get.map((a) => a.asset_id), ["P_" + theirs[1].player_id, "FP_" + to + "_2027_1"], "round 6 and the forfeited pick are left out");
  const L = X.body.payload.teams[0], R = X.body.payload.teams[1];
  t.equal(L.role, "left"); t.equal(L.franchise_id, me); t.equal(L.traded_salary_adjustment_k, 10); t.equal(L.traded_salary_adjustment_dollars, 10000); t.equal(L.selected_non_taxi_salary_dollars, 20000);
  t.equal(R.role, "right"); t.equal(R.franchise_id, to); t.equal(R.selected_assets[1].type, "PICK"); t.equal(R.selected_assets[1].pick_key, "FP_" + to + "_2027_1");
  t.equal(L.selected_assets[0].type, "PLAYER"); t.equal(L.selected_assets[0].player_id, mine[0].player_id); t.equal(L.selected_assets[1].taxi, true);
  t.equal(X.body.from_franchise_id, me); t.equal(X.body.to_franchise_id, to); t.equal(X.body.league_id, "25625");
  t.deepEqual(X.movements, [{ from: me, to, asset_tokens: ["P_" + mine[0].player_id, "P_" + mine[3].player_id], cap_k: 10 }, { from: to, to: me, asset_tokens: ["P_" + theirs[1].player_id, "FP_" + to + "_2027_1"], cap_k: 4 }]);
  t.deepEqual(X.expect.giveUp, [mine[0].player_id, mine[3].player_id, "BB_6000"].sort(), "MFL lists the net cap money as BB_ dollars on the side that pays it");
  t.deepEqual(X.expect.receive, ["FP_" + to + "_2027_1", theirs[1].player_id].sort());
  t.ok(T.findSent([{ to_franchise_id: to, will_give_up: X.expect.giveUp.slice().reverse().join(","), will_receive: X.expect.receive.join(", ") }], to, X.expect), "the read-back finds the offer");
  t.equal(T.findSent([{ to_franchise_id: to, will_give_up: mine[0].player_id, will_receive: X.expect.receive.join(",") }], to, X.expect), null, "a different offer isn't it");
  S.tr.lock = { state: "ok", data: LOCK_UP }; S.tr.sub = "new";
  const html = V.app(S);
  t.doesNotMatch(html, /data-act="trget" data-v="FP_0002_2027_6"(?![^>]*disabled)/, "round 6 is drawn disabled");
  t.match(text(html), /Round 6 can’t be traded/); t.match(text(html), /Forfeited — lineup penalty/);
  t.match(text(html), /Cap money you give \$10,000 Max \$10,000/); t.match(html, /data-act="trsend" disabled/, "not checked yet: Send off");
  t.match(html, /data-act="trcheck">Check trade/);
});

test("Send: only after a check of THIS offer with the loaded-contract limit met, before the lock", async () => {
  const S = await fresh("0006"), me = "0006", to = "0002";
  S.tr.inv[me] = inv(S, me); S.tr.inv[to] = inv(S, to);
  S.tr.d = Object.assign(T.blankDraft(), { to }); S.tr.d.give["P_" + S.tr.inv[me].players[0].player_id] = true; S.tr.d.get["P_" + S.tr.inv[to].players[0].player_id] = true;
  const G = { ok: true }, X = T.build(S, me), C = { cap: { status: "ok", rows: [] }, loaded_contracts: { status: "ok", rows: [] }, roster: { status: "ok" } };
  t.equal(T.canSend(S, X, G), false, "not checked");
  S.tr.chk = { state: "ok", sig: X.sig, c: C }; t.equal(T.canSend(S, X, G), true);
  t.equal(T.canSend(S, X, { ok: false }), false, "locked");
  S.tr.chk.c = Object.assign({}, C, { loaded_contracts: { status: "blocked" } }); t.equal(T.canSend(S, X, G), false, "over the loaded-contract limit");
  S.tr.chk.c = Object.assign({}, C, { loaded_contracts: { status: "unavailable" } }); t.equal(T.canSend(S, X, G), false, "couldn't be checked");
  S.tr.chk.c = Object.assign({}, C, { cap: { status: "blocked", rows: [] } }); t.equal(T.canSend(S, X, G), true, "over the cap: the worker asks for the acknowledgment at Send (classic flow)");
  S.tr.chk.c = Object.assign({}, C, { cap: { status: "unavailable" } }); t.equal(T.canSend(S, X, G), false);
  S.tr.chk.c = C; S.tr.d.capGive = 1; t.equal(T.canSend(S, T.build(S, me), G), false, "a changed offer needs a new check");
  t.match(appJs, /if \(!B \|\| !U\.trades\.canSend\(S, B, G\)\) return;/, "app.js sends nothing canSend refuses");
  t.match(appJs, /b\.code === "cap_overage_ack_required" && b\.cap_ack_needed && !capAck\) \{ S\.tr\.busy = false; S\.tr\.ack = b\.cap_ack_needed; S\.sheet = "trackSend"/);
});

test("offers: incoming shows Accept and Decline, outgoing shows Cancel; Accept is off while trades are locked", async () => {
  const S = await fresh("0006");
  const a = ids(S, "0002", 1)[0], b = ids(S, "0006", 2);
  S.tr.lock = { state: "ok", data: LOCK_UP };
  S.tr.offers = { state: "ok", inc: [{ trade_id: "501", from_franchise_id: "0002", to_franchise_id: "0006", will_give_up: a + ",BB_2000", will_receive: b[0], message: "fair?" }],
    out: [{ trade_id: "502", from_franchise_id: "0006", to_franchise_id: "0003", will_give_up: b[1], will_receive: "FP_0003_2027_1" }] };
  const h = V.app(S), tx = text(h);
  t.match(h, /data-act="trreview" data-v="501"/); t.match(h, /data-act="trdecline" data-v="501"/); t.match(h, /data-act="trcancel" data-v="502"/);
  t.match(tx, /You get .*\$2,000 cap money/); t.match(tx, /“fair\?”/); t.match(tx, /2027 Round 1/);
  S.tr.lock = { state: "ok", data: { state: "closed" } };
  t.match(V.app(S), /data-act="trreview" data-v="501" disabled/, "locked: Accept off"); t.match(text(V.app(S)), /Trades are locked\./);
  S.tr.offers = { state: "error", why: "Your MFL sign-in expired." }; t.match(text(V.app(S)), /Your MFL sign-in expired\. Try again/);
  S.me = { signedIn: false }; t.match(text(V.app(S)), /Sign in with your own team to trade\./);
});

test("the accept review: the worker decides; Accept only when the cap is fine (or every overage acknowledged) and the loaded-contract limit can run", async () => {
  const ok = { ok: true, status: 200, body: { ok: true, compliance: { cap: { status: "ok", rows: [{ franchise_name: "A", room_after: 5000, over_by: 0 }] }, roster: { status: "ok" }, loaded_contracts: { status: "ok", executable: true, max: 5, rows: [] } } } };
  t.equal(T.review(ok).data.canAccept, true);
  const over = JSON.parse(JSON.stringify(ok)); over.body.compliance.cap.status = "blocked"; over.body.cap_ack = { satisfied: false, per_franchise: [{ franchise_id: "0006", amount_over: 3000, status: "missing" }] };
  t.equal(T.review(over).data.canAccept, false); t.equal(T.review(over).data.message, "Over the salary cap.");
  over.body.cap_ack.satisfied = true; t.equal(T.review(over).data.canAccept, true, "an acknowledged overage");
  const lc = JSON.parse(JSON.stringify(ok)); lc.body.compliance.loaded_contracts.executable = false; t.equal(T.review(lc).data.canAccept, false);
  t.deepEqual(T.review({ ok: false, status: 409, body: { ok: false, error: "That trade is no longer pending." } }), { state: "error", why: "That trade is no longer pending." });
  const S = await fresh("0006");
  S.tr.lock = { state: "ok", data: LOCK_UP };
  S.tr.offers = { state: "ok", inc: [{ trade_id: "501", from_franchise_id: "0002", to_franchise_id: "0006", will_give_up: ids(S, "0002", 1)[0], will_receive: ids(S, "0006", 1)[0] }], out: [] };
  S.sheet = "trreview"; S.tr.rv = Object.assign({ tid: "501", offer: S.tr.offers.inc[0] }, T.review(over));
  over.body.cap_ack.satisfied = false; S.tr.rv = Object.assign({ tid: "501", offer: S.tr.offers.inc[0] }, T.review(over));
  let h = V.app(S);
  t.match(h, /data-act="traccept" disabled/); t.match(text(h), /Acknowledge \$3,000 over/);
  S.tr.rv = Object.assign({ tid: "501", offer: S.tr.offers.inc[0] }, T.review(ok)); h = V.app(S);
  t.match(h, /data-act="traccept">Accept trade/); t.match(text(h), /A \$5,000 room/);
  S.tr.lock = { state: "ok", data: { state: "closed" } }; t.match(V.app(S), /data-act="traccept" disabled/, "locked");
  t.match(appJs, /if \(verb === "accept" && !\(S\.tr\.rv && S\.tr\.rv\.data && S\.tr\.rv\.data\.canAccept && U\.trades\.gate\(S\)\.ok\)\) return;/, "app.js re-checks before it accepts");
});

test("results: confirmed only from MFL's answer afterwards (the offer list, and the roster for an accept); trade results don't borrow lineup hints", async () => {
  t.match(appJs, /var found = O\.state === "ok" \? U\.trades\.findSent\(O\.out, B\.body\.to_franchise_id, B\.expect\) : null;/);
  t.match(appJs, /var gone = res\[0\]\.state === "ok" && !trOffer\(tid\), done = gone && res\[1\];/);
  t.match(appJs, /return players\.every\(function \(p\) \{ return ids\.indexOf\(p\) >= 0; \}\);/);
  const S = await fresh("0006");
  S.sheet = "result"; S.submit = { kind: "trade", state: "refused", okTitle: "Offer sent", noTitle: "Offer NOT sent", text: "Nothing was sent to MFL.", reason: "Trades are locked by the commissioner." };
  const tx = text(V.app(S));
  t.match(tx, /Offer NOT sent Nothing was sent to MFL\. Why: Trades are locked by the commissioner\./); t.doesNotMatch(tx, /His game has started/);
});

test("the Preview build: League stays a placeholder and carries no trade code; the Test build adds lib/trades.js, which has no network code", async () => {
  const S = await fresh("0006"); S.tradesUi = null; S.tr = null; S.submitMode = false;
  t.doesNotMatch(V.app(S), /data-act="tr/); t.match(text(V.app(S)), /Standings, scores and schedule/);
  const pv = tmp(), tt = tmp();
  const p = B.build(pv, SRC, git, FIXSH, FIXLOCK, { dev: true }), q = B.build(tt, SRC, git, FIXSH, FIXLOCK, { dev: true, target: "test" });
  t.ok(p.ok, JSON.stringify(p.problems)); t.ok(q.ok, JSON.stringify(q.problems));
  t.ok(!fs.existsSync(path.join(pv, "lib/trades.js")) && !fs.existsSync(path.join(pv, "lib/submit.js")), "no trade or write file in the Preview build");
  t.ok(fs.existsSync(path.join(tt, "lib/trades.js")));
  t.match(fs.readFileSync(path.join(tt, "index.html"), "utf8"), /<script src="lib\/submit\.js"><\/script>\n<script src="lib\/trades\.js"><\/script>\n<script src="app\.js"><\/script>/);
  t.deepEqual(B.scanWriteCode("lib/trades.js", TRADES, B.TEST_CSP), [], "the Preview scan: no network or write code");
  // a fetch slipped into trades.js stops the test build
  const src = tmp();
  (function copy(a, b) { fs.mkdirSync(b, { recursive: true }); for (const e of fs.readdirSync(a, { withFileTypes: true })) { const x = path.join(a, e.name), y = path.join(b, e.name); if (e.isDirectory()) copy(x, y); else fs.copyFileSync(x, y); } })(SRC, src);
  fs.writeFileSync(path.join(src, "lib/trades.js"), TRADES + "\nself.fetch('/x');\n");
  const bad = B.build(tmp(), src, git, FIXSH, FIXLOCK, { dev: true, target: "test" });
  t.ok(!bad.ok); t.ok(bad.problems.some((x) => /lib\/trades\.js: network code/.test(x)), JSON.stringify(bad.problems));
  [pv, tt, src].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});

await run("mobile2027_r13_trades");
