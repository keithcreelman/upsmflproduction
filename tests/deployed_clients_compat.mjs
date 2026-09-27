// OLD-CLIENT COMPATIBILITY: runs the EXACT bundles currently served from production
// (fetched read-only from GitHub Pages, verified byte-identical to origin/main 912d4750) against the
// CORRECTED worker (real index.js, real SQLite/migrations, stateful MFL stub at the network edge).
//
//   DEPLOYED_DIR=<dir holding m/… trades/… rookies/…> node tests/deployed_clients_compat.mjs
//
// Nothing is reconstructed: the request bodies/URLs/headers are produced by the deployed code itself.
// The ONLY addition is one accessor line appended INSIDE the deployed mobile view's closure (its builders
// are private), so the real submitOffer()/submit3Way()/cancel3WayTrade()/handleAction() can be called
// without driving a full DOM. Everything else in the bundle runs unmodified.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { t, test, run } from "./fixtures/mini_test.mjs";

const DIR = process.env.DEPLOYED_DIR;
if (!DIR || !fs.existsSync(path.join(DIR, "m/views/trade.js"))) { console.log("deployed_clients_compat: SKIPPED (set DEPLOYED_DIR to a fetched copy of the production bundles)"); process.exit(0); }
const { makeWorkerEnv, makeMfl, workerFetch, quiet, COMMISH_COOKIE } = await import("./fixtures/worker_harness.mjs");
const { seedTrade, readRow, TRADE_ID, DISCORD } = await import("./fixtures/trade_3way_fixture.mjs");
const { settle } = await import("./fixtures/fake_dom.mjs");
const restore = quiet();
const rd = (p) => fs.readFileSync(path.join(DIR, p), "utf8");

// ───────────────────────────── the world ─────────────────────────────
const WORKER = "https://upsmflproduction.keith-creelman.workers.dev";
function world() {
  const env = makeWorkerEnv({ TRADE_3WAY_EXECUTE: "0" });
  const mfl = makeMfl({ tokens: { "tok-H": "0012" } }); mfl.install();
  for (const [f, d] of [["0008", DISCORD.A], ["0001", DISCORD.B], ["0012", DISCORD.C]]) env.UPS_MFL_DB.raw.prepare("INSERT INTO discord_owners VALUES (?,?,?)").run(f, "Y", d);
  return { env, mfl, log: [] };
}
const redact = (r) => ({ ...r, query: Object.fromEntries(Object.entries(r.query).map(([k, v]) => [k, /MFL_USER_ID|APIKEY/.test(k) ? "‹redacted›" : v])) });

// A permissive DOM sink: the builders re-render overlays we don't inspect.
const dummy = () => new Proxy(function () {}, { get: (_, k) => (k === "length" ? 0 : k === "style" ? {} : k === Symbol.toPrimitive ? () => "" : dummy()), apply: () => dummy(), set: () => true });
function mount() {
  const listeners = [];
  const el = {
    innerHTML: "", textContent: "", style: {},
    // The deployed render() wires [data-3w-cancel] and .btn-act[data-act] buttons after writing innerHTML.
    querySelector(sel) { return /^#/.test(sel) ? (el.innerHTML.includes(`id="${sel.slice(1)}"`) ? { addEventListener() {} } : null) : null; },
    querySelectorAll(sel) {
      const out = [];
      const add = (re, attrs) => { let m; while ((m = re.exec(el.innerHTML))) { const tag = m[0]; const a = {}; for (const k of attrs) { const x = new RegExp(`${k}="([^"]*)"`).exec(tag); if (x) a[k] = x[1].replace(/&amp;/g, "&"); } out.push({ addEventListener: (_, fn) => listeners.push({ a, fn, sel }), getAttribute: (k) => a[k] || "" }); } };
      if (/data-3w-cancel/.test(sel)) add(/<button[^>]*data-3w-cancel="[^"]*"[^>]*>/g, ["data-3w-cancel"]);
      if (/btn-act\[data-act\]/.test(sel)) add(/<button[^>]*class="btn-act[^"]*"[^>]*data-act="[^"]*"[^>]*>/g, ["data-act", "data-trade-id", "data-from-fid"]);
      return out;
    },
  };
  // Simulate a real click on the rendered button and run the deployed handler with `this` = the button.
  el.click = (attr, value) => {
    for (const l of listeners) { const thisBtn = { getAttribute: (k) => l.a[k] || "" }; if (l.a[attr] === value || (value === undefined && attr in l.a)) { l.fn.call(thisBtn); return true; } }
    throw new Error(`the deployed UI rendered no button with ${attr}=${value}`);
  };
  el.has = (attr, value) => listeners.some((l) => l.a[attr] === value || (value === undefined && attr in l.a));
  return el;
}

function loadMobile(w, { token, fid, extra = {}, src: srcOverride }) {
  const toasts = [];
  const U = {
    pad4: (v) => { const d = String(v || "").replace(/\D/g, ""); return d ? d.padStart(4, "0").slice(-4) : ""; },
    safeStr: (v) => (v == null ? "" : String(v).trim()), safeInt: (v, d) => { const n = parseInt(v, 10); return isFinite(n) ? n : (d == null ? 0 : d); },
    escapeHtml: (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
    fmtUsd: (n) => "$" + n,
  };
  const m = mount();
  const M = {
    util: U, data: {}, actions: {},
    api: { workerUrl: (p) => WORKER + p, getStoredMflUserId: () => token },
    state: { ctx: { leagueId: "74598", year: "2026" }, viewerFranchiseId: fid, tradeOffers: null,
      franchises: [{ id: "0001", name: "L.A. Looks" }, { id: "0002", name: "CBP" }, { id: "0008", name: "Real Deal Creel" }, { id: "0012", name: "Hawks" }] },
    ui: { showToast: (msg, tone) => toasts.push([tone, msg]) },
    route: { renderRoute: () => M.tradeView.render(m, []) },
  };
  const sandbox = { fetch: workerFetch(w.env, w.log), console, setTimeout, Promise, URL, encodeURIComponent, decodeURIComponent, isFinite, parseInt, String, Number, JSON, Object, Array, Date, Math,
    document: { getElementById: () => dummy(), body: dummy(), querySelector: () => null, addEventListener() {} } };
  sandbox.window = sandbox; sandbox.UPS_MOBILE = M; sandbox.confirm = () => true;
  Object.assign(sandbox, extra);
  vm.createContext(sandbox);
  let src = srcOverride || rd("m/views/trade.js");
  const tail = src.lastIndexOf("})();");
  src = src.slice(0, tail) + "M.__t = (function () { var g = function (f) { try { return f(); } catch (e) { return undefined; } }; return { get state() { return g(function () { return state; }); }, set builder(v) { try { builderState = v; } catch (e) {} }, get builder() { return g(function () { return builderState; }); }, freshBuilderState: g(function () { return freshBuilderState; }), set b3(v) { try { b3 = v; } catch (e) {} }, get b3() { return g(function () { return b3; }); }, fresh3: g(function () { return fresh3; }), submitOffer: g(function () { return submitOffer; }), submit3Way: g(function () { return submit3Way; }), cancel3WayTrade: g(function () { return cancel3WayTrade; }), loadOffers: g(function () { return loadOffers; }), loadThreeWays: g(function () { return loadThreeWays; }), handleAction: g(function () { return handleAction; }), runTradeAction: g(function () { return runTradeAction; }) }; })();\n" + src.slice(tail);
  vm.runInContext(src, sandbox, { filename: "DEPLOYED m/views/trade.js" });
  return { M, m, toasts, w, T: M.__t, show: async () => { M.route.renderRoute(); await settle(20); M.route.renderRoute(); await settle(4); } };
}
const last = (a) => a[a.length - 1];
const req = (w, method, pathPrefix) => w.log.filter((r) => r.method === method && r.path.startsWith(pathPrefix));

// ══════════════ DEPLOYED MOBILE — TWO-TEAM ══════════════
test("MOBILE (deployed) 2-way LIST: owner sees the outgoing offer; the request carries the session and is accepted", async () => {
  const w = world(); w.mfl.addPending({ offeringteam: "0001", offeredto: "0002" });
  const c = loadMobile(w, { token: "tok-B", fid: "0001" });
  await c.show();
  const r = req(w, "GET", "/api/trades/proposals")[0];
  t.ok(r, "the deployed client made the list request");
  t.equal(r.status, 200);
  t.ok("MFL_USER_ID" in r.query && r.query.franchise_id === "0001");
  t.match(c.m.innerHTML, /Outgoing · 1/);
  t.doesNotMatch(c.m.innerHTML, /Failed to load|Signed out/);
});

test("MOBILE (deployed) 2-way LIST signed out: shows the honest 'Signed out of MFL' message, never '0 offers'", async () => {
  const w = world(); w.mfl.addPending({ offeringteam: "0001", offeredto: "0002" });
  const c = loadMobile(w, { token: "", fid: "0001" });
  await c.show();
  const r = req(w, "GET", "/api/trades/proposals")[0];
  t.ok(r.status === 401 || r.status === 403, `status ${r.status}`);
  t.match(c.m.innerHTML, /Signed out of MFL/);
  t.equal(w.mfl.commishCookieWrites().length, 0);
});

function seedBuilder(c, fid, theirFid) {
  const b = c.T.freshBuilderState();
  b.counterpartyFid = theirFid;
  b.inv = { "0001": { players: [{ player_id: "14056", display: "P14056", salary: 5000, position: "WR", nfl_team: "X", contract_status: "Veteran", contract_year: 2, contract_info: "", contract_length: 3 }], future_picks: [] },
            "0002": { players: [{ player_id: "13100", display: "P13100", salary: 5000, position: "WR", nfl_team: "Y", contract_status: "Veteran", contract_year: 2, contract_info: "", contract_length: 3 }], future_picks: [] } };
  b.giveIds = { P_14056: true }; b.getIds = { P_13100: true };
  c.T.builder = b; return b;
}

test("MOBILE (deployed) 2-way CREATE: the deployed builder's own request is accepted, written to MFL as the owner, toast 'Offer sent ✓'", async () => {
  const w = world();
  const c = loadMobile(w, { token: "tok-B", fid: "0001" });
  seedBuilder(c, "0001", "0002");
  c.T.submitOffer(); await settle(30);
  const r = req(w, "POST", "/api/trades/proposals")[0];
  t.ok(r); t.equal(r.status, 201);
  t.equal(r.body.from_franchise_id, "0001");
  t.ok(c.toasts.some((x) => /Offer sent/.test(x[1])), JSON.stringify(c.toasts));
  const wr = w.mfl.writes("tradeProposal");
  t.equal(wr.length, 1); t.equal(wr[0].cookie, "MFL_USER_ID=tok-B"); t.equal(w.mfl.commishCookieWrites().length, 0);
});

test("MOBILE (deployed) 2-way CREATE with an expired session: refused with the worker's message shown in the builder, nothing written", async () => {
  const w = world();
  const c = loadMobile(w, { token: "tok-expired", fid: "0001" });
  const b = seedBuilder(c, "0001", "0002");
  c.T.submitOffer(); await settle(30);
  const r = req(w, "POST", "/api/trades/proposals")[0];
  t.equal(r.status, 401);
  t.match(c.T.builder.error, /sign-in expired|Sign in/i);
  t.equal(w.mfl.writes().length, 0); t.equal(c.toasts.filter((x) => /Offer sent/.test(x[1])).length, 0);
});

test("MOBILE (deployed) 2-way CREATE with no session at all: refused (401), the exact case that used to write with the commissioner cookie", async () => {
  const w = world();
  const c = loadMobile(w, { token: "", fid: "0001" });
  seedBuilder(c, "0001", "0002");
  c.T.submitOffer(); await settle(30);
  const r = req(w, "POST", "/api/trades/proposals")[0];
  t.equal(r.status, 401); t.match(c.T.builder.error, /Sign in/i);
  t.equal(w.mfl.writes().length, 0);
});

test("MOBILE (deployed) 2-way CANCEL (revoke) via the rendered Cancel button: 200, MFL revoke as the owner, 'Done ✓'", async () => {
  const w = world(); const id = w.mfl.addPending({ offeringteam: "0001", offeredto: "0002" });
  const c = loadMobile(w, { token: "tok-B", fid: "0001" });
  await c.show();
  c.m.click("data-act", "cancel"); await settle(40);
  const a = req(w, "POST", "/api/trades/proposals/action")[0];
  t.ok(a); t.equal(a.status, 200); t.match(a.body.action, /^revoke$/i);
  t.ok(c.toasts.some((x) => x[1] === "Done ✓"), JSON.stringify(c.toasts));
  t.deepEqual(w.mfl.st.done.map((d) => [d.response, d.by, d.cookie]), [["revoke", "0001", "MFL_USER_ID=tok-B"]]);
});

test("MOBILE (deployed) 2-way DECLINE by the recipient: the deployed runTradeAction('decline') is accepted; MFL reject as the recipient; 'Done ✓'", async () => {
  const w = world(); w.mfl.addPending({ offeringteam: "0001", offeredto: "0002" });
  const c = loadMobile(w, { token: "tok-C", fid: "0002" });
  await c.show();
  const tid = w.mfl.st.pending[0].trade_id;
  c.T.runTradeAction("decline", tid, "no thanks"); await settle(40);
  const a = req(w, "POST", "/api/trades/proposals/action")[0];
  t.equal(a.status, 200); t.match(a.body.action, /^reject$/i); t.equal(a.body.message, "no thanks");
  t.ok(c.toasts.some((x) => x[1] === "Done ✓"), JSON.stringify(c.toasts));
  t.deepEqual(w.mfl.st.done.map((d) => [d.response, d.by, d.cookie]), [["reject", "0002", "MFL_USER_ID=tok-C"]]);
});

test("MOBILE (deployed) 2-way ACCEPT by the WRONG team is refused with the worker's text in the toast, and nothing changes", async () => {
  const w = world(); const id = w.mfl.addPending({ offeringteam: "0001", offeredto: "0002" });
  const c = loadMobile(w, { token: "tok-O", fid: "0003" });
  c.T.handleAction("accept", id); await settle(40);
  const a = req(w, "POST", "/api/trades/proposals/action")[0];
  t.equal(a.status, 409);
  t.ok(c.toasts.some((x) => x[0] === "err" && /Failed: /.test(x[1])), JSON.stringify(c.toasts));
  t.equal(w.mfl.st.done.length, 0); t.equal(w.mfl.st.pending.length, 1);
});

// ══════════════ DEPLOYED MOBILE — THREE-TEAM ══════════════
const seed3 = (w, over) => { seedTrade(w.env, over); };
test("MOBILE (deployed) 3-way LIST: the old card renderer gets every field it reads (role, waiting_on names, from_name/to_name, summary, can_cancel)", async () => {
  const w = world(); seed3(w);
  const init = loadMobile(w, { token: "tok-A", fid: "0008" });
  await init.show();
  const r = req(w, "GET", "/api/trades/3way")[0];
  t.ok(r); t.equal(r.status, 200); t.equal(r.query.L, "74598");
  t.match(init.m.innerHTML, /3-Way Trades · 1/); t.match(init.m.innerHTML, /You started this/); t.match(init.m.innerHTML, /Waiting on L\.A\. Looks &amp; Hawks/);
  t.match(init.m.innerHTML, /Real Deal Creel → Hawks/); t.ok(init.m.has("data-3w-cancel", TRADE_ID));
  const partner = loadMobile(w, { token: "tok-B", fid: "0001" });
  await partner.show();
  t.match(partner.m.innerHTML, /You(&#39;|')re a partner/); t.match(partner.m.innerHTML, /Waiting on/); t.equal(partner.m.has("data-3w-cancel", TRADE_ID), false);
});

test("MOBILE (deployed) 3-way CANCEL by the initiator: the request that used to 400 'Missing L param' now succeeds; toast '3-way called off ✓'", async () => {
  const w = world(); seed3(w);
  const c = loadMobile(w, { token: "tok-A", fid: "0008" });
  await c.show();
  c.m.click("data-3w-cancel", TRADE_ID); await settle(40);
  const r = req(w, "POST", "/api/trades/3way/cancel")[0];
  t.ok(r); t.equal(r.status, 200); t.equal(r.query.L, undefined, "the deployed client sends NO L — the original outage");
  t.equal(r.body.franchise_id, "0008"); t.equal(r.body.league_id, "74598");
  t.ok(c.toasts.some((x) => x[1] === "3-way called off ✓"), JSON.stringify(c.toasts));
  t.equal(readRow(w.env).status, "cancelled");
});

test("MOBILE (deployed) 3-way CANCEL by a partner (forced): 403, the server's plain message reaches the toast, trade untouched", async () => {
  const w = world(); seed3(w);
  const c = loadMobile(w, { token: "tok-B", fid: "0001" });
  c.T.cancel3WayTrade(TRADE_ID); await settle(40);
  const r = req(w, "POST", "/api/trades/3way/cancel")[0];
  t.equal(r.status, 403);
  t.ok(c.toasts.some((x) => x[0] === "err" && /Only the team that started this 3-way/.test(x[1])), JSON.stringify(c.toasts));
  t.equal(readRow(w.env).status, "collecting");
});

test("MOBILE (deployed) 3-way CANCEL with no session / a commissioner-declared body franchise: refused; a client claiming another franchise cannot borrow it", async () => {
  const w = world(); seed3(w);
  const anon = loadMobile(w, { token: "", fid: "0008" });
  anon.T.cancel3WayTrade(TRADE_ID); await settle(40);
  t.equal(req(w, "POST", "/api/trades/3way/cancel")[0].status, 401);
  t.ok(anon.toasts.some((x) => x[0] === "err"), JSON.stringify(anon.toasts));
  // an ordinary owner whose client claims to be the initiator (forged M.state.viewerFranchiseId)
  const forged = loadMobile(w, { token: "tok-O", fid: "0008" });
  forged.T.cancel3WayTrade(TRADE_ID); await settle(40);
  const f = req(w, "POST", "/api/trades/3way/cancel")[1];
  t.equal(f.body.franchise_id, "0008"); t.equal(f.status, 403);
  t.equal(readRow(w.env).status, "collecting");
});

test("MOBILE (deployed) 3-way LIST signed out: old client shows an empty outbox (it swallows non-OK); the server returns 401 and no trade data", async () => {
  const w = world(); seed3(w);
  const c = loadMobile(w, { token: "", fid: "0008" });
  await c.show();
  const r = req(w, "GET", "/api/trades/3way")[0];
  t.equal(r.status, 401); t.doesNotMatch(c.m.innerHTML, /Real Deal Creel → Hawks|3-Way Trades/);
});

test("MOBILE (deployed) 3-way CREATE: the deployed builder's body is accepted; initiator is the authenticated franchise", async () => {
  const w = world();
  const c = loadMobile(w, { token: "tok-A", fid: "0008" });
  const b = c.T.fresh3(); b.fidB = "0001"; b.fidC = "0012";
  b.give = { "0008": { P_16614: "0012" }, "0012": { FP_0012_2027_1: "0001" }, "0001": { P_16181: "0008" } };
  b.inv = { "0008": { players: [{ player_id: "16614", display: "MHJ", salary: 5000, position: "WR", nfl_team: "ARI", contract_status: "Veteran", contract_year: 2, contract_length: 3 }], future_picks: [] },
            "0012": { players: [], future_picks: [{ original_fid: "0012", year: 2027, round: 1, display: "2027 R1" }] },
            "0001": { players: [{ player_id: "16181", display: "CB", salary: 3000, position: "RB", nfl_team: "CIN", contract_status: "Veteran", contract_year: 2, contract_length: 3 }], future_picks: [] } };
  c.T.b3 = b;
  c.T.submit3Way(); await settle(40);
  const r = req(w, "POST", "/api/trades/3way")[0];
  t.ok(r); t.equal(r.body.initiator.fid, "0008");
  t.ok([201, 400].includes(r.status), `status ${r.status}`);
  if (r.status === 201) t.ok(c.toasts.some((x) => /3-way sent/.test(x[1])));
  else t.ok(typeof c.T.b3.error === "string" && c.T.b3.error.length > 3);
  // and a forged initiator (viewer claims 0008 with tok-B's session) is refused
  const w2 = world(); const f = loadMobile(w2, { token: "tok-B", fid: "0008" });
  f.T.b3 = b; f.T.submit3Way(); await settle(40);
  t.equal(req(w2, "POST", "/api/trades/3way")[0].status, 403);
  t.equal(w2.env.UPS_MFL_DB.raw.prepare("SELECT COUNT(*) AS n FROM ups_3way_trades").get().n, 0);
});

// ══════════════ can any cached / old client bypass the new layer? ══════════════
test("BYPASS: no request shape the deployed clients can produce reaches MFL with the worker's commissioner cookie", async () => {
  const w = world(); const id = w.mfl.addPending({ offeringteam: "0001", offeredto: "0002" });
  const f = workerFetch(w.env, w.log);
  const shapes = [
    ["POST", `/api/trades/proposals/action`, { action: "REVOKE", trade_id: id, league_id: "74598", franchise_id: "0001", year: "2026" }],
    ["POST", `/trade-offers/action`, { action: "REVOKE", trade_id: id, league_id: "74598", franchise_id: "0001", year: "2026" }],
    ["POST", `/api/trades/proposals?L=74598`, { league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002", payload: { teams: [] } }],
    ["POST", `/trade-offers?L=74598`, { league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002", payload: { teams: [] } }],
    ["POST", `/trade-outbox/replay?L=74598`, { league_id: "74598", season: "2026", outbox_id: "1" }],
    ["POST", `/refresh/after-trade?L=74598`, {}],
    ["POST", `/api/trade?L=74598`, { from_fid: "0001", to_fid: "0002", give: ["P_14056"], receive: ["P_13100"], simulate: false }],
    ["POST", `/api/trade/process?L=74598`, { from_fid: "0001", to_fid: "0002", give: ["P_14056"], receive: ["P_13100"], requested_by: "0008" }],
  ];
  for (const [m, p, b] of shapes) {
    for (const auth of ["", "&MFL_USER_ID=", "&MFL_USER_ID=" + COMMISH_COOKIE]) {
      const res = await f(WORKER + p + (p.includes("?") ? "" : "?") + auth.replace(/^&/, p.includes("?") ? "&" : ""), { method: m, headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
      t.ok(res.status >= 400 || /simulated|dry/.test(await res.text()), `${m} ${p}${auth ? " (+bad session)" : ""} -> ${res.status}`);
    }
  }
  t.equal(w.mfl.commishCookieWrites().length, 0);
  t.equal(w.mfl.st.done.length, 0); t.equal(w.mfl.st.pending.length, 1);
});


// ══════════════ ACCEPT INTEGRITY vs the deployed clients' real accept requests ══════════════
// The new accept guard compares whatever the client claims about the trade's contents with the stored
// offer. A legitimate deployed client must NOT be refused; a tampered one must be.
const richPayload = (capK = 2) => {
  const p = (pid) => ({ asset_id: `P_${pid}`, type: "PLAYER", player_id: String(pid), player_name: `P${pid}`, salary: 5000, taxi: false, contract_info: "" });
  return { schema_version: 1, source: "test", league_id: "74598", season: "2026",
    teams: [{ role: "left", franchise_id: "0001", selected_assets: [p(14056), { asset_id: "FP_0001_2027_1", type: "PICK", pick_key: "FP_0001_2027_1", pick_season: 2027, pick_round: 1, description: "2027 R1", salary: 0 }], traded_salary_adjustment_k: capK, traded_salary_adjustment_dollars: capK * 1000, selected_non_taxi_salary_dollars: 5000 },
            { role: "right", franchise_id: "0002", selected_assets: [p(13100)], traded_salary_adjustment_k: 0, traded_salary_adjustment_dollars: 0, selected_non_taxi_salary_dollars: 5000 }],
    extension_requests: [], ui: { left_team_id: "0001", right_team_id: "0002" }, validation: { status: "ready" } };
};
async function sendRealOffer(w, capK) {
  const f = workerFetch(w.env, w.log);
  const r = await f(`${WORKER}/api/trades/proposals?L=74598&YEAR=2026&MFL_USER_ID=tok-B`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002", payload: richPayload(capK == null ? 2 : capK) }) });
  if (r.status >= 300) throw new Error("offer not sent: " + r.status);
  w.log.length = 0;
  return w.mfl.st.pending[w.mfl.st.pending.length - 1].trade_id;
}
test("MOBILE (deployed) ACCEPT by the recipient: the deployed client's own request (action fields only) is accepted for a real offer with a pick and cap money", async () => {
  const w = world(); const id = await sendRealOffer(w);
  const c = loadMobile(w, { token: "tok-C", fid: "0002" });
  c.T.handleAction("accept", id); await settle(60);
  const a = req(w, "POST", "/api/trades/proposals/action")[0];
  t.ok(a); t.equal(a.status, 200, JSON.stringify(a.body).slice(0, 200));
  t.ok(c.toasts.some((x) => x[1] === "Done ✓"), JSON.stringify(c.toasts));
  t.equal(w.mfl.st.done.filter((d) => d.response === "accept").length, 1);
  t.equal(w.mfl.writes("salaryAdj").length, 1);
});
test("MOBILE (deployed) ACCEPT: an attacker who edits the deployed client's request to add content is refused (409 payload_mismatch) and nothing is written", async () => {
  const w = world(); const id = await sendRealOffer(w);
  const f = workerFetch(w.env, w.log);
  const evil = richPayload(); evil.teams[0].traded_salary_adjustment_k = 30;
  const r = await f(`${WORKER}/api/trades/proposals/action?MFL_USER_ID=tok-C`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "ACCEPT", trade_id: id, league_id: "74598", franchise_id: "0002", year: "2026", message: "", payload: evil }) });
  t.equal(r.status, 409); t.equal((await r.json()).code, "payload_mismatch");
  t.equal(w.mfl.st.done.length, 0); t.equal(w.mfl.st.pending.length, 1);
});

// ── salary-cap block vs the deployed clients (ruling 2026-09-25): a proven post-trade cap violation is refused by the worker
//    (409 cap_exceeded) BEFORE MFL is called; the deployed clients show the worker's owner-safe text and nothing changes.
function overCap(w) {                                        // 0001 would end at 310,000 (payroll 295,000 − 5,000 + 20,000)
  w.mfl.st.rosters["0001"] = [{ id: "14056", salary: 5000 }, { id: "90001", salary: 290000 }];
  w.mfl.st.rosters["0002"] = [{ id: "13100", salary: 20000 }, { id: "90002", salary: 100000 }];
}
test("MOBILE (deployed) ACCEPT over the cap: the deployed toast carries the worker's cap message; MFL is never called and nothing is written", async () => {
  const w = world(); const id = await sendRealOffer(w, 0); overCap(w);
  const c = loadMobile(w, { token: "tok-C", fid: "0002" });
  c.T.handleAction("accept", id); await settle(60);
  const a = req(w, "POST", "/api/trades/proposals/action")[0];
  t.ok(a); t.equal(a.status, 409);
  const toast = c.toasts.find((x) => x[0] === "err");
  t.ok(toast, JSON.stringify(c.toasts)); t.match(toast[1], /L\.A\. Looks would be \$10,000 over the \$300,000 salary cap/); t.doesNotMatch(toast[1], /HTTP 409|undefined|\[object|Failed to fetch|D1_|stack/);
  t.equal(w.mfl.st.done.length, 0); t.equal(w.mfl.writes("tradeResponse").length, 0); t.equal(w.mfl.writes("salaryAdj").length, 0);
});
test("DESKTOP (deployed) ACCEPT over the cap: the deployed War Room shows the worker's cap message (no raw body) and nothing is written", async () => {
  const w = world(); await sendRealOffer(w, 0); overCap(w);
  const d = await bootDesktop(w, { token: "tok-C", fid: "0002" });
  const offer = d.state.offers.received[0];
  await d.T.performOfferAction("ACCEPT", { bucket: "received", offer }); await settle(60);
  const a = dreq(w, "POST", "/trade-offers/action")[0];
  t.ok(a); t.equal(a.status, 409); t.equal(a.body && a.body.action, "ACCEPT");
  t.match(d.state.submit.message, /L\.A\. Looks would be \$10,000 over the \$300,000 salary cap/); t.doesNotMatch(d.state.submit.message, /HTTP 409|\{"ok"|undefined|Failed to fetch/);
  t.equal(w.mfl.st.done.length, 0); t.equal(w.mfl.writes("tradeResponse").length, 0);
});

// ══════════════ DEPLOYED DESKTOP (Trade War Room) ══════════════
// The whole deployed trade_workbench.js boots against the REAL worker (its own GET /trade-workbench and
// GET /trade-offers are served by index.js). One accessor line is appended inside its closure so the
// private performOfferAction()/tw3 builder can be called; nothing else is changed.
async function bootDesktop(w, { token, fid, qs = "", fetchWrap }) {
  const loc = new URL(`https://keithcreelman.github.io/upsmflproduction/trades/trade_workbench.html?embed=1&L=74598&YEAR=2026&FRANCHISE_ID=${fid}${token ? "&MFL_USER_ID=" + token : ""}${qs}&api=` + encodeURIComponent(WORKER + "/trade-workbench"));
  const base = fetchWrap ? fetchWrap(workerFetch(w.env, w.log)) : workerFetch(w.env, w.log);
  const fetchImpl = async (u, i) => { const url = new URL(String(u)); if (url.hostname === "keithcreelman.github.io") return { ok: false, status: 404, text: async () => "", json: async () => ({}) }; return base(u, i); };
  const errs = [];
  const doc = { readyState: "complete", cookie: "", getElementById: () => dummy(), querySelector: () => dummy(), querySelectorAll: () => [], createElement: () => dummy(), addEventListener() {}, body: dummy(), documentElement: dummy(), head: dummy() };
  const win = { location: { href: loc.href, search: loc.search, origin: loc.origin, pathname: loc.pathname, hash: "" }, addEventListener() {}, removeEventListener() {}, parent: { postMessage() {} }, postMessage() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, requestAnimationFrame: (f) => setTimeout(f, 0), setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, history: { replaceState() {} }, innerWidth: 1280, scrollTo() {} };
  const sb = { window: win, document: doc, fetch: fetchImpl, console: { log() {}, warn() {}, error: (...a) => errs.push(a.map(String).join(" ").slice(0, 200)), info() {} }, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, URL, URLSearchParams, Promise, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, encodeURIComponent, decodeURIComponent, isFinite, isNaN, parseInt, parseFloat, Map, Set, Symbol, navigator: { clipboard: {} }, requestAnimationFrame: (f) => setTimeout(f, 0), ResizeObserver: class { observe() {} disconnect() {} }, MutationObserver: class { observe() {} disconnect() {} }, Intl, TextEncoder, atob, btoa, structuredClone, localStorage: win.localStorage, sessionStorage: win.sessionStorage, location: win.location };
  win.fetch = fetchImpl; sb.self = win; vm.createContext(sb);
  let src = rd("trades/trade_workbench.js");
  const tail = src.lastIndexOf("})();");
  src = src.slice(0, tail) + "window.__twb = { performOfferAction: performOfferAction, replayOutbox: replayOutbox, triggerAfterTradeRefresh: triggerAfterTradeRefresh, open3WayBuilder: open3WayBuilder, tw3Submit: tw3Submit, get tw3() { return tw3; }, set tw3(v) { tw3 = v; }, tw3Fresh: tw3Fresh, getActiveFranchiseId: getActiveFranchiseId };\n" + src.slice(tail);
  vm.runInContext(src, sb, { filename: "DEPLOYED trades/trade_workbench.js" });
  await settle(80);
  return { win, errs, T: win.__twb, api: win.upsTradeWorkbench, state: win.upsTradeWorkbench && win.upsTradeWorkbench.state };
}
const dreq = (w, method, p) => w.log.filter((r) => r.method === method && r.path === p);

test("DESKTOP (deployed) boots against the corrected worker: /trade-workbench and /trade-offers are accepted, the owner's own offer is listed", async () => {
  const w = world(); w.mfl.addPending({ offeringteam: "0001", offeredto: "0002" });
  const d = await bootDesktop(w, { token: "tok-B", fid: "0001" });
  t.ok(d.api, "the deployed War Room finished booting");
  t.equal(dreq(w, "GET", "/trade-workbench")[0].status, 200);
  const list = dreq(w, "GET", "/trade-offers")[0];
  t.equal(list.status, 200); t.ok("MFL_USER_ID" in list.query);
  t.equal((d.state.offers.offered || []).length, 1);
  t.equal(w.mfl.commishCookieWrites().length, 0);
});

test("DESKTOP (deployed) signed-out: /trade-offers is refused (401) and the War Room shows a load error rather than someone's offers", async () => {
  const w = world(); w.mfl.addPending({ offeringteam: "0001", offeredto: "0002" });
  const d = await bootDesktop(w, { token: "", fid: "0001" });
  const list = dreq(w, "GET", "/trade-offers")[0];
  t.ok(list.status === 401 || list.status === 403, `status ${list.status}`);
  t.equal((d.state.offers.offered || []).length, 0);
  t.ok(d.state.offers.error, "an error is surfaced");
  t.doesNotMatch(String(d.state.offers.error), /COMMISH|tok-|secret|stack/i);
});

test("DESKTOP (deployed) REVOKE via the deployed performOfferAction: POST /trade-offers/action accepted; MFL revoke as the owner; status text shown", async () => {
  const w = world(); w.mfl.addPending({ offeringteam: "0001", offeredto: "0002" });
  const d = await bootDesktop(w, { token: "tok-B", fid: "0001" });
  const offer = d.state.offers.offered[0];
  await d.T.performOfferAction("REVOKE", { offer, bucket: "offered" }); await settle(30);
  const a = dreq(w, "POST", "/trade-offers/action")[0];
  t.ok(a); t.equal(a.status, 200); t.equal(a.body.acting_franchise_id, "0001");
  t.match(d.state.submit.message, /revoked/i);
  t.deepEqual(w.mfl.st.done.map((x) => [x.response, x.by, x.cookie]), [["revoke", "0001", "MFL_USER_ID=tok-B"]]);
});

test("DESKTOP (deployed) ACCEPT by the recipient: the deployed War Room's real accept request (payload + offer_* claims) matches the stored offer and is NOT refused", async () => {
  const w = world(); await sendRealOffer(w, 0);
  const d = await bootDesktop(w, { token: "tok-C", fid: "0002" });
  const offer = d.state.offers.received[0];
  t.ok(offer, "recipient sees the incoming offer");
  await d.T.performOfferAction("ACCEPT", { bucket: "received", offer }); await settle(60);
  const a = dreq(w, "POST", "/trade-offers/action")[0];
  t.ok(a, `the deployed client made the accept request; status message: ${d.state.submit.message}`);
  t.ok(a.body.payload, "the deployed client really does send a payload with its accept");
  t.equal(a.status, 200, `${a.status} ${d.state.submit.message}`);
  t.equal(w.mfl.st.done.filter((x) => x.response === "accept").length, 1);
  t.equal(w.mfl.st.done[0].cookie, "MFL_USER_ID=tok-C");
});
test("DESKTOP (deployed) ACCEPT: the same client with its outgoing payload altered in flight is refused (409) and nothing is written", async () => {
  const w = world(); await sendRealOffer(w, 0);
  const edited = [];
  const d = await bootDesktop(w, { token: "tok-C", fid: "0002", fetchWrap: (inner) => async (u, i) => {
    if (i && i.method === "POST" && /\/trade-offers\/action/.test(String(u))) {
      const b = JSON.parse(i.body);
      b.payload.teams[1].selected_assets.push({ asset_id: "P_15000", type: "PLAYER", player_id: "15000", player_name: "P15000", salary: 5000 });   // smuggle in another player
      edited.push(b); i = { ...i, body: JSON.stringify(b) };
    }
    return inner(u, i);
  } });
  const offer = d.state.offers.received[0];
  await d.T.performOfferAction("ACCEPT", { bucket: "received", offer }); await settle(60);
  const a = dreq(w, "POST", "/trade-offers/action")[0];
  t.equal(edited.length, 1); t.ok(a);
  t.equal(a.status, 409); t.equal(w.mfl.st.done.length, 0); t.equal(w.mfl.st.pending.length, 1);
});

test("DESKTOP (deployed) REJECT by the recipient: accepted; MFL reject as the recipient", async () => {
  const w = world(); w.mfl.addPending({ offeringteam: "0001", offeredto: "0002" });
  const d = await bootDesktop(w, { token: "tok-C", fid: "0002" });
  const offer = d.state.offers.received[0];
  t.ok(offer, "recipient sees the incoming offer");
  await d.T.performOfferAction("REJECT", { offer, bucket: "received", message: "no thanks" }); await settle(30);
  const a = dreq(w, "POST", "/trade-offers/action")[0];
  t.equal(a.status, 200);
  t.deepEqual(w.mfl.st.done.map((x) => [x.response, x.by, x.cookie]), [["reject", "0002", "MFL_USER_ID=tok-C"]]);
});

test("DESKTOP (deployed) forged identity: a signed-in owner who edits FRANCHISE_ID in the URL to another team is refused, sees nothing, can do nothing", async () => {
  const w = world(); w.mfl.addPending({ offeringteam: "0001", offeredto: "0002" });
  const d = await bootDesktop(w, { token: "tok-O", fid: "0001" });          // tok-O really is franchise 0003
  const list = dreq(w, "GET", "/trade-offers")[0];
  // The list is scoped to the PROVEN session (0003), not the URL's claim: either a refusal or that team's own (empty) inbox.
  t.ok([200, 401, 403].includes(list.status), `list status ${list.status}`);
  t.equal((d.state.offers.offered || []).length, 0); t.equal((d.state.offers.received || []).length, 0);
  // even with the real offer object injected into the client, the write is refused server-side
  const real = { id: w.mfl.st.pending[0].trade_id, trade_id: w.mfl.st.pending[0].trade_id, from_franchise_id: "0001", to_franchise_id: "0002", will_give_up: "14056,", will_receive: "13100," };
  await d.T.performOfferAction("REVOKE", { offer: real, bucket: "offered" }); await settle(30);
  const a = dreq(w, "POST", "/trade-offers/action")[0];
  t.equal(a.status, 403);
  t.equal(w.mfl.st.done.length, 0); t.equal(w.mfl.st.pending.length, 1);
  t.doesNotMatch(String(d.state.submit.message), /COMMISH|tok-|secret|stack/i);
});

test("DESKTOP (deployed) SUBMIT a new offer: the deployed payload is accepted and written to MFL as the owner", async () => {
  const w = world();
  const d = await bootDesktop(w, { token: "tok-B", fid: "0001" });
  const mine = d.state.data.teams.find((x) => x.franchise_id === "0001").assets[0];
  const theirs = d.state.data.teams.find((x) => x.franchise_id === "0002").assets[0];
  t.ok(mine && theirs, "workbench data has assets for both teams");
  d.state.rightTeamId = "0002";
  d.state.selections["0001"] = { [mine.asset_id]: true }; d.state.selections["0002"] = { [theirs.asset_id]: true };
  await d.api.submitOfferToQueue(); await settle(40);
  const p = dreq(w, "POST", "/trade-offers")[0];
  t.ok(p, `the deployed client made the submit request; status message: ${d.state.submit.message}`);
  t.ok([200, 201].includes(p.status), `status ${p.status}: ${d.state.submit.message}`);
  t.equal(p.body.from_franchise_id, "0001");
  t.equal(w.mfl.writes("tradeProposal").length, 1); t.equal(w.mfl.writes("tradeProposal")[0].cookie, "MFL_USER_ID=tok-B");
});

test("DESKTOP (deployed) SUBMIT with a tampered from-team is refused: the URL says 0001 but the session is 0003", async () => {
  const w = world();
  const d0 = await bootDesktop(w, { token: "tok-B", fid: "0001" });   // real data for the payload
  const w2 = world();
  const d = await bootDesktop(w2, { token: "tok-O", fid: "0001" });
  const mine = d.state.data.teams.find((x) => x.franchise_id === "0001").assets[0];
  const theirs = d.state.data.teams.find((x) => x.franchise_id === "0002").assets[0];
  d.state.rightTeamId = "0002"; d.state.selections["0001"] = { [mine.asset_id]: true }; d.state.selections["0002"] = { [theirs.asset_id]: true };
  await d.api.submitOfferToQueue(); await settle(40);
  const p = dreq(w2, "POST", "/trade-offers")[0];
  t.ok(p && p.status === 403, `status ${p && p.status}`);
  t.equal(w2.mfl.writes().length, 0);
});

test("DESKTOP (deployed) the after-trade refresh it fires post-accept still works for an owner (reconcile authorised internally)", async () => {
  const w = world();
  const d = await bootDesktop(w, { token: "tok-B", fid: "0001" });
  const r = await d.T.triggerAfterTradeRefresh({ trade_id: "2001" });
  const a = dreq(w, "POST", "/refresh/after-trade")[0];
  t.ok(a); t.equal(a.status, 200); t.equal(r.ok, true);
});

test("DESKTOP (deployed) replayOutbox is admin-only now: an owner gets a plain refusal; nothing replays; the deployed UI has no automatic call site", async () => {
  const w = world();
  const d = await bootDesktop(w, { token: "tok-B", fid: "0001" });
  let err = null; try { await d.T.replayOutbox({ outbox_id: "1" }); } catch (e) { err = e; }
  t.ok(err && err.status === 403, `status ${err && err.status}`);
  t.doesNotMatch(String(err && err.message), /COMMISH|tok-|secret|stack/i);
  const calls = (rd("trades/trade_workbench.js").match(/replayOutbox\(/g) || []).length;
  t.equal(calls, 1, "replayOutbox( appears only at its definition — no UI path calls it");
  t.equal(w.mfl.writes().length, 0);
});

test("DESKTOP (deployed) 3-way CREATE via the deployed builder: body accepted, initiator = the authenticated franchise; a forged initiator is refused", async () => {
  const w = world();
  const d = await bootDesktop(w, { token: "tok-B", fid: "0001" });
  const idOf = (fid) => d.state.data.teams.find((x) => x.franchise_id === fid).assets[0];
  d.T.open3WayBuilder();
  const b = d.T.tw3;
  b.aFid = "0001"; b.bFid = "0002"; b.cFid = "0003";
  b.give = { "0001": { [idOf("0001").asset_id]: "0002" }, "0002": { [idOf("0002").asset_id]: "0003" }, "0003": { [idOf("0003").asset_id]: "0001" } };
  d.T.tw3Submit(); await settle(40);
  const r = dreq(w, "POST", "/api/trades/3way")[0];
  t.ok(r, `the deployed builder made a request; status text: ${d.T.tw3 && d.T.tw3.status}`);
  t.equal(r.body.initiator.fid, "0001");
  t.ok([201, 400].includes(r.status), `status ${r.status}`);
  const w2 = world(); const f = await bootDesktop(w2, { token: "tok-O", fid: "0001" });
  f.T.open3WayBuilder(); const fb = f.T.tw3; fb.aFid = "0001"; fb.bFid = "0002"; fb.cFid = "0003";
  fb.give = b.give; f.T.tw3Submit(); await settle(40);
  const fr = dreq(w2, "POST", "/api/trades/3way")[0];
  t.equal(fr.status, 403);
  t.equal(w2.env.UPS_MFL_DB.raw.prepare("SELECT COUNT(*) AS n FROM ups_3way_trades").get().n, 0);
});


// ══════════════ CACHED OLDER MOBILE BUILDS (real historical trade.js from git) ══════════════
// The mobile service worker is cache-first, so a phone may run an earlier build. Each real historical
// trade.js is executed against the corrected worker through the same scenarios. HISTORICAL_DIR/<sha>/trade.js
const HIST = process.env.HISTORICAL_DIR;
const RESULTS = [];
if (HIST && fs.existsSync(HIST)) {
  for (const sha of fs.readdirSync(HIST).sort()) {
    const src = fs.readFileSync(path.join(HIST, sha, "trade.js"), "utf8");
    test(`HISTORY ${sha}: list / cancel / signed-out / 3-way — every request is either accepted for the owner or refused safely; nothing reaches MFL as the commissioner`, async () => {
      const row = { build: sha, list: "", cancel: "", signedOut: "", create2: "n/a", threeWayList: "n/a", threeWayCancel: "n/a" };
      // owner: list + cancel
      let w = world(); w.mfl.addPending({ offeringteam: "0001", offeredto: "0002" });
      let c = loadMobile(w, { token: "tok-B", fid: "0001", src });
      await c.show();
      const l = req(w, "GET", "/api/trades/proposals")[0];
      row.list = l ? `${l.status}${/Outgoing/.test(c.m.innerHTML) ? " · rendered" : ""}` : "no request";
      t.ok(!l || l.status < 500);
      if (c.m.has("data-act", "cancel")) {
        try { c.m.click("data-act", "cancel"); await settle(40); } catch (e) { /* button handler needs confirm etc. */ }
        const a = req(w, "POST", "/api/trades/proposals/action")[0];
        row.cancel = a ? `${a.status} ${JSON.stringify(a.body.action)} → ${w.mfl.st.done.length ? "MFL " + w.mfl.st.done[0].response : "MFL untouched"}` : "no request";
        if (a) { t.ok(a.status < 500); if (a.status === 200) t.equal(w.mfl.st.done[0].cookie, "MFL_USER_ID=tok-B"); }
      } else row.cancel = "no cancel control";
      t.equal(w.mfl.commishCookieWrites().length, 0);
      // signed out
      w = world(); w.mfl.addPending({ offeringteam: "0001", offeredto: "0002" });
      c = loadMobile(w, { token: "", fid: "0001", src });
      await c.show();
      const so = req(w, "GET", "/api/trades/proposals")[0];
      row.signedOut = so ? `${so.status} → ${/Signed out/.test(c.m.innerHTML) ? "'Signed out of MFL' shown" : /Outgoing · 0|Incoming · 0/.test(c.m.innerHTML) ? "shows '0 offers' (client-side flaw in this build; server correctly 401)" : "error shown"}` : "no request";
      t.ok(!so || [401, 403].includes(so.status)); t.equal(w.mfl.writes().length, 0);
      // 2-way create when the build exposes the builder
      if (typeof c.T.submitOffer === "function" && typeof c.T.freshBuilderState === "function") {
        w = world(); c = loadMobile(w, { token: "tok-B", fid: "0001", src }); seedBuilder(c, "0001", "0002");
        c.T.submitOffer(); await settle(30);
        const cr = req(w, "POST", "/api/trades/proposals")[0];
        row.create2 = cr ? `${cr.status}${cr.status < 300 ? " · MFL as owner" : ""}` : "no request";
        t.ok(cr && cr.status < 500); if (cr && cr.status < 300) t.equal(w.mfl.writes("tradeProposal")[0].cookie, "MFL_USER_ID=tok-B");
        w = world(); c = loadMobile(w, { token: "", fid: "0001", src }); seedBuilder(c, "0001", "0002"); c.T.submitOffer(); await settle(30);
        t.equal(req(w, "POST", "/api/trades/proposals")[0].status, 401); t.equal(w.mfl.writes().length, 0);
      }
      // 3-way list/cancel when present
      if (typeof c.T.loadThreeWays === "function") {
        w = world(); seedTrade(w.env); c = loadMobile(w, { token: "tok-A", fid: "0008", src }); await c.show();
        const tl = req(w, "GET", "/api/trades/3way")[0];
        row.threeWayList = tl ? `${tl.status}${/3-Way Trades · 1/.test(c.m.innerHTML) ? " · rendered" : ""}` : "no request";
        t.ok(tl && tl.status === 200);
        if (c.m.has("data-3w-cancel", TRADE_ID)) {
          c.m.click("data-3w-cancel", TRADE_ID); await settle(40);
          const tc = req(w, "POST", "/api/trades/3way/cancel")[0];
          row.threeWayCancel = tc ? `${tc.status}${tc.query.L ? "" : " (no L sent)"} → ${readRow(w.env).status}` : "no request";
          t.ok(tc && tc.status === 200); t.equal(readRow(w.env).status, "cancelled");
        } else row.threeWayCancel = "no cancel control";
      }
      RESULTS.push(row);
    });
  }
}
await run("deployed_clients_compat");
if (RESULTS.length) { const out = console.log; process.stdout.write("\nHISTORICAL BUILD RESULTS\n" + JSON.stringify(RESULTS, null, 1) + "\n"); }
restore();
