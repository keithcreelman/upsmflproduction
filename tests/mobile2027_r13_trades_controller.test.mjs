// UPS 2027 Trades v1 (Keith, 2026-11-26): the real app.js, lib/submit.js and lib/trades.js run against a stub page and a fake TEST worker.
// Proven: League › Trades loads the signed-in owner's offers and the trade lock; a new offer is checked, sent once and confirmed only when MFL's
// pending list shows it; an accept is reviewed first and confirmed only when the owner's MFL roster shows the players; decline and cancel are
// confirmed only when the offer is gone; nothing is sent without a tap, and every trade POST carries its own Idempotency-Key.
//   node tests/mobile2027_r13_trades_controller.test.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "apps", "mobile2027", "src");
const FX = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/public_reads.json"), "utf8"));
const BUILD = await import(pathToFileURL(path.join(HERE, "..", "apps", "mobile2027", "scripts", "build.mjs")).href);
const INJURY_PURE = BUILD.derivedBytes(BUILD.DERIVED[0], path.join(HERE, "fixtures/mobile2027/shared")).toString("utf8");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const tick = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const text = (h) => h.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

const ME = "0010", THEM = "0003";
const team = (fid) => FX.roster_workbench.teams.find((x) => x.franchise_id === fid);
const assetsOf = (fid) => ({ ok: true, players: team(fid).players.slice(0, 5).map((p) => ({ player_id: p.id, display: p.name, position: p.position, nfl_team: p.nfl_team, salary: p.salary, contract_year: p.years, contract_status: p.type, taxi: !!p.is_taxi, roster_status: p.status })),
  future_picks: [{ year: "2027", round: "1", original_fid: fid }, { year: "2027", round: "6", original_fid: fid }], forfeit_check: "ok" });
const COMPLIANCE = { cap: { status: "ok", rows: [{ franchise_id: ME, franchise_name: "Blake Bombers", used_after: 250000, cap_dollars: 300000, room_after: 50000, over_by: 0 }] }, roster: { status: "ok", rows: [] }, loaded_contracts: { status: "ok", executable: true, max: 5, rows: [] } };

function boot() {
  const now = Math.floor(Date.now() / 1000);
  const W = { offers: { incoming: [], outgoing: [] }, roster: team(ME).players.map((p) => p.id), posts: [], next: 900, holdCreate: null, refuseAccept: false };
  W.offers.incoming.push({ trade_id: "777", from_franchise_id: THEM, to_franchise_id: ME, will_give_up: team(THEM).players[0].id, will_receive: team(ME).players[0].id, message: "" });
  W.offers.outgoing.push({ trade_id: "778", from_franchise_id: ME, to_franchise_id: "0004", will_give_up: team(ME).players[1].id, will_receive: "FP_0004_2027_1" });
  const calls = [];
  const answer = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), headers: { get: () => "" } });
  const fetchFake = async (url, opts) => {
    const u = new URL(url), p = u.pathname, m = (opts && opts.method) || "GET", b = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, path: p, method: m, opts, body: b });
    if (m === "POST") W.posts.push({ path: p, key: opts.headers["Idempotency-Key"], body: b });
    if (p === "/api/me") return answer(200, { configured: true, franchise_id: ME, franchise_name: "Blake Bombers" });
    if (p === "/api/league-events") return answer(200, { ok: true, trade_lock: { state: "upcoming", start_unix: now + 7 * 86400, end_unix: now + 40 * 86400, label: "Thu, Dec 3, 8:15 PM ET" } });
    if (p === "/api/trades/proposals" && m === "GET") return answer(200, { ok: true, incoming: W.offers.incoming, outgoing: W.offers.outgoing });
    if (p === "/api/franchise-assets") return answer(200, assetsOf(u.searchParams.get("fid")));
    if (p === "/api/trades/compliance-preview") return answer(200, { ok: true, compliance: COMPLIANCE });
    if (p === "/api/trades/proposals" && m === "POST") {
      if (W.holdCreate) await W.holdCreate;
      const L = b.payload.teams[0], R = b.payload.teams[1], net = L.traded_salary_adjustment_k - R.traded_salary_adjustment_k;
      const tok = (side, n) => side.selected_assets.map((a) => (a.type === "PLAYER" ? a.player_id : a.pick_key)).concat(n > 0 ? ["BB_" + n * 1000] : []);
      W.offers.outgoing.push({ trade_id: String(W.next++), from_franchise_id: ME, to_franchise_id: b.to_franchise_id, will_give_up: tok(L, net).join(","), will_receive: tok(R, -net).join(",") });
      return answer(201, { ok: true, mode: "direct_mfl" });
    }
    if (p === "/api/trades/proposals/action") {
      const tid = b.trade_id;
      if (b.action === "preview") return answer(200, { ok: true, compliance: COMPLIANCE, cap_ack: null });
      if (b.action === "accept") {
        if (W.refuseAccept) return answer(409, { ok: false, error: "That trade is no longer pending on MFL." });
        const o = W.offers.incoming.find((x) => x.trade_id === tid); W.offers.incoming = W.offers.incoming.filter((x) => x.trade_id !== tid);
        W.roster.push(...o.will_give_up.split(",")); return answer(200, { ok: true });
      }
      if (b.action === "reject") { W.offers.incoming = W.offers.incoming.filter((x) => x.trade_id !== tid); return answer(200, { ok: true }); }
      if (b.action === "revoke") { W.offers.outgoing = W.offers.outgoing.filter((x) => x.trade_id !== tid); return answer(200, { ok: true }); }
    }
    if (p === "/api/mfl-export" && u.searchParams.get("TYPE") === "rosters") return answer(200, { rosters: { franchise: { id: ME, player: W.roster.map((id) => ({ id })) } } });
    if (p === "/roster-workbench") return answer(200, FX.roster_workbench);
    if (p === "/api/current-lineup-week") return answer(200, FX.current_lineup_week);
    if (p === "/api/cap-penalty/preview") return answer(200, FX.cap_penalty);
    if (u.searchParams.get("TYPE") === "league") return answer(200, FX.league);
    if (u.searchParams.get("TYPE") === "weeklyResults") return answer(200, FX.weekly_results);
    return answer(404, {});
  };
  const listeners = {}, storage = { ups_mfl_user_id: "owner-token" };
  const appEl = { innerHTML: "", addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); }, contains: () => true, querySelector: () => null, querySelectorAll: () => [] };
  const location = { hash: "", pathname: "/m2/", search: "", href: "https://ups-test-25625.pages.dev/m2/" };
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, URL, URLSearchParams, Intl, JSON, Date, Math, Promise, Array, Object, String, Number, isFinite, parseInt, parseFloat, encodeURIComponent, Uint8Array, crypto: globalThis.crypto,
    document: { getElementById: (id) => (id === "app" ? appEl : null), documentElement: { setAttribute() {} }, activeElement: null, title: "" },
    localStorage: { getItem: (k) => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v); }, removeItem: (k) => { delete storage[k]; } },
    history: { state: null, pushState() {}, replaceState() {}, back() {} }, location,
  });
  ctx.window = ctx; ctx.self = ctx; ctx.fetch = fetchFake;
  ctx.matchMedia = () => ({ matches: false, addEventListener() {} });
  ctx.addEventListener = () => {};
  vm.runInContext(INJURY_PURE, ctx);
  for (const f of ["config.js", "lib/format.js", "lib/contract.js", "lib/reviewed_names.js", "lib/adjust.js", "lib/model.js", "lib/roster.js", "lib/planner.js", "lib/coverage.js", "lib/data.js", "lib/recorded.js", "lib/photo.js", "lib/sample.js", "lib/clubhist.js", "lib/ranks.js", "lib/complete.js", "lib/boxlog.js", "lib/statranks.js", "lib/tabviews.js", "lib/breakdown.js", "lib/views.js", "lib/submit.js", "lib/trades.js", "app.js"]) {
    vm.runInContext(read(f), ctx, { filename: f });
    if (f === "config.js") Object.assign(ctx.UPS2027_CONFIG, { data: "live", leagueId: "25625", workerBase: "https://ups-test.keith-creelman.workers.dev" });
  }
  const click = async (attrs) => { const el = { getAttribute: (k) => (k in attrs ? attrs[k] : null) }; (listeners.click || []).forEach((fn) => fn({ target: { closest: () => el } })); await tick(); };
  const type = async (id, value) => { (listeners.input || []).forEach((fn) => fn({ target: { id, value } })); await tick(2); };
  return { W, calls, click, type, html: () => appEl.innerHTML };
}

test("League › Trades: the owner's offers and the lock load; nothing is POSTed until a tap", async () => {
  const a = boot(); await tick(60);
  await a.click({ "data-act": "nav", "data-v": "league" }); await tick(30);
  const tx = text(a.html());
  t.match(tx, /Offers to you · 1/); t.match(tx, /Your offers · 1/); t.match(tx, /Trades lock Thu, Dec 3, 8:15 PM ET\./);
  t.match(a.html(), /data-act="trreview" data-v="777">Accept/); t.match(a.html(), /data-act="trcancel" data-v="778"/);
  const off = a.calls.find((c) => c.path === "/api/trades/proposals"); t.equal(new URL(off.url).searchParams.get("MFL_USER_ID"), "owner-token"); t.equal(new URL(off.url).searchParams.get("franchise_id"), ME);
  t.equal(a.W.posts.length, 0, "reads only");
});

test("New offer: pick a team and players (round 6 off), check, send once; confirmed when MFL's pending list shows the offer", async () => {
  const a = boot(); await tick(60);
  await a.click({ "data-act": "nav", "data-v": "league" }); await tick(30);
  await a.click({ "data-act": "trsub", "data-v": "new" }); await a.click({ "data-act": "trto", "data-v": THEM }); await tick(20);
  const mine = team(ME).players[2].id, theirs = team(THEM).players[1].id;
  await a.click({ "data-act": "trgive", "data-v": "P_" + mine }); await a.click({ "data-act": "trget", "data-v": "P_" + theirs });
  await a.click({ "data-act": "trget", "data-v": "FP_" + THEM + "_2027_6" });
  t.match(a.html(), /data-act="trsend" disabled/, "not checked: Send off");
  await a.click({ "data-act": "trsend" }); t.equal(a.W.posts.length, 0, "a Send tap on a disabled button sends nothing");
  await a.type("trnote", "Let's deal");
  await a.click({ "data-act": "trcheck" }); await tick(20);
  t.equal(a.W.posts.length, 1); t.equal(a.W.posts[0].path, "/api/trades/compliance-preview");
  t.match(text(a.html()), /Salary cap Blake Bombers \$50,000 room/);
  a.W.holdCreate = new Promise((r) => { a.W.releaseCreate = r; });
  await a.click({ "data-act": "trsend" }); await a.click({ "data-act": "trsend" });   // a second tap while sending
  a.W.releaseCreate(); await tick(40);
  const creates = a.W.posts.filter((p) => p.path === "/api/trades/proposals");
  t.equal(creates.length, 1, "sent once");
  const body = creates[0].body;
  t.equal(body.from_franchise_id, ME); t.equal(body.to_franchise_id, THEM); t.equal(body.message, "Let's deal");
  t.deepEqual(body.payload.teams[1].selected_assets.map((x) => x.asset_id), ["P_" + theirs], "round 6 was never selectable");
  t.match(text(a.html()), /Offer sent Confirmed on MFL\./);
  await a.click({ "data-act": "resultok" }); t.match(text(a.html()), /Your offers · 2/, "back on Offers, with the new one");
  t.equal(new Set(a.W.posts.map((p) => p.key)).size, a.W.posts.length, "every POST had its own key");
});

test("Accept: reviewed first, confirmed only when the owner's MFL roster shows the player; a refusal says why and changes nothing", async () => {
  const a = boot(); await tick(60);
  await a.click({ "data-act": "nav", "data-v": "league" }); await tick(30);
  await a.click({ "data-act": "traccept" }); t.equal(a.W.posts.length, 0, "no accept without a review");
  await a.click({ "data-act": "trreview", "data-v": "777" }); await tick(20);
  t.deepEqual(a.W.posts.map((p) => p.body.action), ["preview"]);
  t.match(a.html(), /data-act="traccept">Accept trade/);
  await a.click({ "data-act": "traccept" }); await tick(40);
  t.deepEqual(a.W.posts.map((p) => p.body.action), ["preview", "accept"]);
  t.match(text(a.html()), /Trade accepted Confirmed on MFL\./);
  t.ok(a.calls.some((c) => c.path === "/api/mfl-export" && new URL(c.url).searchParams.get("TYPE") === "rosters"), "the roster was read back");
  const b = boot(); await tick(60); b.W.refuseAccept = true;
  await b.click({ "data-act": "nav", "data-v": "league" }); await tick(30);
  await b.click({ "data-act": "trreview", "data-v": "777" }); await tick(20); await b.click({ "data-act": "traccept" }); await tick(30);
  t.match(text(b.html()), /Trade NOT accepted Nothing changed on MFL\. Why: That trade is no longer pending on MFL\./);
});

test("Decline with a note, and Cancel: each confirmed only when the offer is gone from MFL's list", async () => {
  const a = boot(); await tick(60);
  await a.click({ "data-act": "nav", "data-v": "league" }); await tick(30);
  await a.click({ "data-act": "trdecline", "data-v": "777" }); await a.type("trdeclnote", "too rich");
  await a.click({ "data-act": "trdeclinego" }); await tick(30);
  t.equal(a.W.posts[0].body.action, "reject"); t.equal(a.W.posts[0].body.message, "too rich");
  t.match(text(a.html()), /Offer declined Confirmed on MFL\./);
  await a.click({ "data-act": "resultok" });
  await a.click({ "data-act": "trcancel", "data-v": "778" }); t.match(text(a.html()), /Cancel this offer\?/);
  await a.click({ "data-act": "trcancelgo" }); await tick(30);
  t.equal(a.W.posts[1].body.action, "revoke"); t.match(text(a.html()), /Offer cancelled Confirmed on MFL\./);
});

await run("mobile2027_r13_trades_controller");
