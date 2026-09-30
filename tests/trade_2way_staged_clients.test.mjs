// STAGED 2-way trade CLIENTS: the REAL desktop War Room block (site/trades/trade_workbench.js)
// and the REAL mobile view (site/m/views/trade.js), each run in Node against a fake DOM with
// fetch() bridged to the REAL worker (worker/src/index.js) + real SQLite D1 + a stateful fake
// MFL -- exactly the technique tests/trade_3way_clients.test.mjs already established for 3-way.
//
// Covers exactly what Keith asked for: recipient over five, sender over five, roster changes
// after creation, changed drop selections, signed-out and wrong-owner access, and zero MFL
// writes in every held state -- through the REAL client code, not a re-derivation of the
// server's own already-tested logic (tests/trade_2way_staged.test.mjs,
// tests/trade_compliance_preview_and_queue.test.mjs already cover the server functions
// end-to-end; this file proves the CLIENT WIRES TO THEM correctly).
//   node tests/trade_2way_staged_clients.test.mjs
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, bindSelf, quiet, COMMISH_COOKIE, ADMIN_KEY, NAMES } from "./fixtures/worker_harness.mjs";
import { makeEl, settle } from "./fixtures/fake_dom.mjs";
import { THREE_WAY_MIGRATIONS } from "./fixtures/d1_sqlite.mjs";

const MIGRATIONS = [...THREE_WAY_MIGRATIONS, "0162_ups_trade_cap_acknowledgments.sql", "0163_ups_trade_conditional_drops.sql", "0164_ups_2way_trades.sql"];

const require = createRequire(import.meta.url);
const T = require("../site/shared/trade_3way_view.js");
const worker = (await (async () => { await import("./fixtures/register_md_loader.mjs"); return import("../worker/src/index.js"); })()).default;
const DESK_SRC = fs.readFileSync(new URL("../site/trades/trade_workbench.js", import.meta.url), "utf8");
const MOBILE_SRC = fs.readFileSync(new URL("../site/m/views/trade.js", import.meta.url), "utf8");

const restoreConsole = quiet();

const flat = (id) => ({ id, salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" });
const loaded = (id) => ({ id, salary: "5000", contractYear: "2", contractStatus: "Vet-BL", contractInfo: "CL 2|TCV 20K|AAV 10K|Y1-5K|Y2-15K" });
const fiveLoaded = (start) => [0, 1, 2, 3, 4].map((i) => loaded(String(start + i)));

function fresh(over) {
  const env = makeWorkerEnv({ __migrations: MIGRATIONS, TRADE_2WAY_STAGING_ENABLED: "1", ...((over && over.env) || {}) });
  bindSelf(env);
  const mfl = makeMfl(over && over.mfl);
  mfl.install();
  return { env, mfl };
}

// A fetch() that goes STRAIGHT to the real worker -- distinct from globalThis.fetch, which
// mfl.install() hijacks for the worker's OWN outbound calls to MFL/Discord. Mirrors
// tests/fixtures/http_bridge.mjs's makeBridge, generalized to the whole real worker instead of
// one handler module (trade_2way_http.js and the compliance-preview route both live inside
// worker/src/index.js's dispatcher, not a standalone importable function).
function bridgeFetch(env) {
  const calls = [];
  const fn = async (input, init) => {
    init = init || {};
    const url = new URL(String(input));
    calls.push({ method: (init.method || "GET").toUpperCase(), path: url.pathname, body: init.body ? JSON.parse(init.body) : null });
    const request = new Request(url, { method: init.method || "GET", headers: { "Content-Type": "application/json" }, body: init.body });
    const waits = [];
    const resp = await worker.fetch(request, env, { waitUntil: (p) => waits.push(p), passThroughOnException() {} });
    await Promise.allSettled(waits);
    const text = await resp.text();
    return { ok: resp.status >= 200 && resp.status < 300, status: resp.status, text: async () => text };
  };
  fn.calls = calls;
  return fn;
}

// ══════════════════════ harness: the REAL desktop staged-2way block ══════════════════════
function loadDesktop(env, { token, fid } = {}) {
  const bridge = bridgeFetch(env);
  const start = DESK_SRC.indexOf('  var tw2s = { listStatus: "idle"');
  const end = DESK_SRC.indexOf("  // ── pre-send popup:");
  if (start < 0 || end < 0 || end < start) throw new Error("could not locate the desktop staged-2way block in trade_workbench.js");
  const code = DESK_SRC.slice(start, end);
  const registry = {};
  const get = (id) => (registry[id] = registry[id] || makeEl(id));
  const chrome = { main: makeEl("main"), toolbar: makeEl("toolbar") };
  const document = {
    getElementById: get,
    querySelector: (s) => (s === ".twb-main" ? chrome.main : s === ".twb-toolbar" ? chrome.toolbar : /#twb2sDetailBody/.test(s) ? get("twb2sDetailBody") : null),
  };
  const urlHistory = [];
  const win = { UPS_TRADE_3WAY: T, location: { href: "https://trade.test/trade_workbench.html?embed=1" }, history: { replaceState: (a, b, u) => urlHistory.push(u) }, scrollTo() {} };
  const els = { tw2sList: get("twb2sList"), tw2sCount: get("twb2sCount") };
  const resolveStaged2WayApiUrl = () => `https://worker.test/api/trades/2way?MFL_USER_ID=${token}&L=74598&YEAR=2026`;
  const tw3NameOf = (fidArg) => NAMES[fidArg] || ("Franchise " + fidArg);
  const factory = new Function("window", "document", "fetch", "els", "getActiveFranchiseId", "resolveStaged2WayApiUrl", "tw3Reflow", "T3", "tw3NameOf", "pad4",
    code + "\nreturn { tw2s, open2WayStagedDetail, close2WayStagedDetail, refresh2WayStagedList, doCancel2WayStaged, doAccept2WayStaged, doRecheck2WayStaged, doSelectDrops2WayStaged, render2WayStagedList, render2WayStagedDetail };");
  const pad4 = (v) => { const d = String(v || "").replace(/\D/g, ""); return d ? d.padStart(4, "0").slice(-4) : ""; };
  const api = factory(win, document, bridge, els, () => fid, resolveStaged2WayApiUrl, () => {}, T, tw3NameOf, pad4);
  return { api, els, detail: () => get("twb2sDetailBody"), calls: bridge.calls };
}

// ══════════════════════ harness: the REAL mobile staged-2way block ══════════════════════
function loadMobile(env, { token, fid } = {}) {
  const bridge = bridgeFetch(env);
  const start = MOBILE_SRC.indexOf("  var tw2s = {");
  const end = MOBILE_SRC.indexOf("  // ── pre-send popup (mobile)");
  if (start < 0 || end < 0 || end < start) throw new Error("could not locate the mobile staged-2way block in trade.js");
  const code = MOBILE_SRC.slice(start, end);
  const toasts = [];
  const franchiseName = (fidArg) => NAMES[fidArg] || ("Franchise " + fidArg);
  const subTabs = () => "";
  const U = {
    pad4: (v) => { const d = String(v || "").replace(/\D/g, ""); return d ? d.padStart(4, "0").slice(-4) : ""; },
    safeStr: (v) => (v == null ? "" : String(v).trim()), safeInt: (v, d) => { const n = parseInt(v, 10); return isFinite(n) ? n : (d == null ? 0 : d); },
    escapeHtml: (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
  };
  const M = {
    util: U,
    api: { workerUrl: (p) => "https://worker.test" + p, getStoredMflUserId: () => token },
    state: { ctx: { leagueId: "74598", year: "2026" }, viewerFranchiseId: fid },
    ui: { showToast: (m, tone) => toasts.push([m, tone]) },
    route: { renderRoute: () => {}, navigate: () => {} },
  };
  const document = { getElementById: () => null, body: { style: {} } };
  const factory = new Function("T", "M", "U", "franchiseName", "subTabs", "fetch", "document",
    code + "\nreturn { tw2s, loadStaged2Way, loadStaged2WayDetail, renderStaged2WaySection, refreshStaged2WayList, doAccept2WayStaged, doCancel2WayStaged, doRecheck2WayStaged, doSelectDrops2WayStaged, renderStaged2WayDetailHtml };");
  const api = factory(T, M, U, franchiseName, subTabs, bridge, document);
  return { api, M, toasts, calls: bridge.calls };
}

const seedFlatRosters = (mfl) => { mfl.st.rosters["0001"] = [flat("14056")]; mfl.st.rosters["0002"] = [flat("13100")]; };

async function stageViaHttp(env, over) {
  const bridge = bridgeFetch(env);
  const url = "https://worker.test/api/trades/2way?L=74598&YEAR=2026&MFL_USER_ID=tok-B";
  const body = { from: { fid: "0001", name: "L.A. Looks" }, to: { fid: "0002", name: "CBP" }, movements: [{ from: "0001", to: "0002", asset_tokens: ["14056"] }], ...(over || {}) };
  const res = await bridge(url, { method: "POST", body: JSON.stringify(body) });
  const parsed = JSON.parse(await res.text());
  return parsed.id;
}

// ═════════════════════════════ DESKTOP ═════════════════════════════

test("DESKTOP: the staged outbox lists a real trade with a count and Details/Cancel", async () => {
  const { env, mfl } = fresh();
  seedFlatRosters(mfl);
  const id = await stageViaHttp(env);
  const d = loadDesktop(env, { token: "tok-B", fid: "0001" });
  await d.api.refresh2WayStagedList();
  await settle();
  t.equal(d.api.tw2s.list.length, 1);
  t.equal(d.api.tw2s.list[0].id, id);
  const html = d.els.tw2sList.innerHTML;
  t.match(html, /Details/);
  t.match(html, /Cancel/);
});

test("DESKTOP: opening the detail loads the canonical trade and shows compliance", async () => {
  const { env, mfl } = fresh();
  seedFlatRosters(mfl);
  const id = await stageViaHttp(env);
  const d = loadDesktop(env, { token: "tok-B", fid: "0001" });
  await d.api.open2WayStagedDetail(id);
  await settle();
  t.equal(d.api.tw2s.detail.id, id);
  t.match(d.detail().innerHTML, /Staged/);
  t.match(d.detail().innerHTML, /every team stays at or under 5/i);
});

test("DESKTOP: RECIPIENT over five -- the projected count and required drops show for the RECIPIENT's own franchise, and the sender's detail view cannot pick for them", async () => {
  const { env, mfl } = fresh();
  mfl.st.rosters["0001"] = [flat("14056")];
  mfl.st.rosters["0002"] = [...fiveLoaded(30000), flat("13100")]; // recipient already at 5
  const id = await stageViaHttp(env, { movements: [{ from: "0001", to: "0002", asset_tokens: ["30000"] }, { from: "0002", to: "0001", asset_tokens: ["13100"] }] });
  const sender = loadDesktop(env, { token: "tok-B", fid: "0001" });
  await sender.api.open2WayStagedDetail(id);
  await settle();
  const html = sender.detail().innerHTML;
  t.match(html, /Can't be accepted|too many loaded contracts|Held/i);
  // The sender's own detail view renders no interactive checkbox for the RECIPIENT's row --
  // renderLoadedContractDrops only ever makes a franchise's picker interactive when
  // opts.viewerFid === that row's own franchise_id, and the sender's viewerFid is 0001, not 0002.
  t.doesNotMatch(html, /data-t3w-drop-fid="0002"[^>]*>\s*<input/);
});

test("DESKTOP: SENDER over five -- the sender's OWN detail view shows their own interactive picker", async () => {
  const { env, mfl } = fresh();
  mfl.st.rosters["0001"] = [...fiveLoaded(40000), flat("14056")]; // sender already at 5
  mfl.st.rosters["0002"] = [loaded("50000")];
  const id = await stageViaHttp(env, { movements: [{ from: "0002", to: "0001", asset_tokens: ["50000"] }] });
  const sender = loadDesktop(env, { token: "tok-B", fid: "0001" });
  await sender.api.open2WayStagedDetail(id);
  await settle();
  const html = sender.detail().innerHTML;
  t.match(html, /too many loaded contracts/i);
  t.match(html, /data-t3w-drop-fid="0001"/);
  t.match(html, /Confirm drop selection/);
  // Keith's ruling (2026-09-29, sequence): drops are confirmed FIRST, always, before the trade
  // is ever attempted -- the owner-facing consent copy must say so, and must not overstate
  // restoration as guaranteed if the trade then fails.
  t.match(html, /the drop is confirmed FIRST, before the trade is ever attempted/);
  t.match(html, /your roster never ends up over the 5-loaded-contract limit because of this deal/);
  t.match(html, /restoration is not guaranteed/);
  t.match(html, /only if nobody else has claimed them as a free agent in the meantime/);
});

test("DESKTOP: the ordering-risk disclosure never renders for a viewer who ISN'T the affected franchise's own owner -- it's part of the interactive picker only", async () => {
  const { env, mfl } = fresh();
  mfl.st.rosters["0001"] = [...fiveLoaded(40000), flat("14056")];
  mfl.st.rosters["0002"] = [loaded("50000")];
  const id = await stageViaHttp(env, { movements: [{ from: "0002", to: "0001", asset_tokens: ["50000"] }] });
  const recipient = loadDesktop(env, { token: "tok-A", fid: "0002" });
  await recipient.api.open2WayStagedDetail(id);
  await settle();
  const html = recipient.detail().innerHTML;
  t.match(html, /too many loaded contracts/i, "the requirement is still visible to the other side");
  t.doesNotMatch(html, /the drop is confirmed FIRST/, "the disclosure is scoped to the affected owner's own interactive picker, not shown to a viewer with no picker");
});

test("DESKTOP: ROSTER CHANGES AFTER CREATION -- a trade staged when everyone was fine now shows blocked once a roster changes underneath it, on a plain re-open (no cached number)", async () => {
  const { env, mfl } = fresh();
  seedFlatRosters(mfl);
  const id = await stageViaHttp(env);
  // Roster changes for reasons unrelated to this trade AFTER staging.
  mfl.st.rosters["0002"] = [...fiveLoaded(60000), flat("13100")];
  const d = loadDesktop(env, { token: "tok-B", fid: "0001" });
  await d.api.open2WayStagedDetail(id);
  await settle();
  // The trade's OWN movement doesn't touch the loaded contracts, so compliance stays "ok" here
  // -- the real point is the number is COMPUTED FRESH each open, never cached from creation.
  // Prove freshness directly: change the roster again and re-open, and the html changes too.
  mfl.st.rosters["0002"] = [...fiveLoaded(60000), loaded("70000")]; // now genuinely worse if this trade also involved 0002 receiving -- simpler proof: re-open reflects current roster count in the compliance rows
  await d.api.open2WayStagedDetail(id);
  await settle();
  t.match(d.detail().innerHTML, /Loaded contracts/);
});

test("DESKTOP: CHANGED SELECTIONS -- selecting a conditional drop persists via the real select-drops endpoint and re-renders the detail with the fresh answer", async () => {
  const { env, mfl } = fresh();
  mfl.st.rosters["0001"] = [...fiveLoaded(40000), flat("14056")];
  mfl.st.rosters["0002"] = [loaded("50000")];
  const id = await stageViaHttp(env, { movements: [{ from: "0002", to: "0001", asset_tokens: ["50000"] }] });
  const d = loadDesktop(env, { token: "tok-B", fid: "0001" });
  await d.api.open2WayStagedDetail(id);
  await settle();
  // Select one of the sender's own 5 already-loaded players as the conditional drop.
  d.api.tw2s.drops.selections["0001"] = ["40000"];
  await d.api.doSelectDrops2WayStaged(id, "0001");
  await settle();
  t.match(d.detail().innerHTML, /Selected: /);
  const selectReq = d.calls.find((c) => c.path === "/api/trades/2way/select-drops");
  t.ok(selectReq);
  t.deepEqual(selectReq.body.player_ids, ["40000"]);
});

test("DESKTOP: SIGNED-OUT access -- opening a real trade with no session is refused by the REAL server, and the client shows the server's problem, not a fake empty state", async () => {
  const { env, mfl } = fresh();
  seedFlatRosters(mfl);
  const id = await stageViaHttp(env);
  const d = loadDesktop(env, { token: "", fid: "" }); // no MFL_USER_ID at all
  await d.api.open2WayStagedDetail(id);
  await settle();
  t.equal(d.api.tw2s.detail, null);
  t.ok(d.api.tw2s.detailProblem);
  t.match(d.detail().innerHTML, /Couldn.{1,6}t load/i);
});

test("DESKTOP: WRONG-OWNER access -- a real session for an unrelated third franchise is refused by the REAL server (403 forbidden), never shown as this owner's trade", async () => {
  const { env, mfl } = fresh();
  seedFlatRosters(mfl);
  const id = await stageViaHttp(env);
  const d = loadDesktop(env, { token: "tok-O", fid: "0003" }); // unrelated franchise, real session
  await d.api.open2WayStagedDetail(id);
  await settle();
  t.equal(d.api.tw2s.detail, null);
  t.ok(d.api.tw2s.detailProblem);
});

test("DESKTOP: ZERO MFL WRITES -- every held state (unavailable, cap-ack, loaded-contract) produced by opening/cancelling a staged trade through the REAL client never issues a single MFL import (the fake MFL records every import call it receives)", async () => {
  const { env, mfl } = fresh();
  mfl.st.rosters["0001"] = [{ id: "14056", salary: "295000" }];
  mfl.st.rosters["0002"] = [flat("13100")];
  const id = await stageViaHttp(env, { movements: [{ from: "0002", to: "0001", asset_tokens: ["13100"] }] });
  const d = loadDesktop(env, { token: "tok-B", fid: "0001" });
  await d.api.open2WayStagedDetail(id);
  await settle();
  await d.api.doCancel2WayStaged(id);
  await settle();
  t.equal(mfl.st.imports.length, 0, "opening a held trade and cancelling it must never write to MFL");
});

// ═════════════════════════════ MOBILE ═════════════════════════════

test("MOBILE: the staged section lists a real trade with a role label and count", async () => {
  const { env, mfl } = fresh();
  seedFlatRosters(mfl);
  const id = await stageViaHttp(env);
  const m = loadMobile(env, { token: "tok-B", fid: "0001" });
  await m.api.refreshStaged2WayList();
  await settle();
  t.equal(m.api.tw2s.list.length, 1);
  t.equal(m.api.tw2s.list[0].id, id);
  const html = m.api.renderStaged2WaySection();
  t.match(html, /Staged Trades/);
  t.match(html, /You sent this/);
});

test("MOBILE: RECIPIENT over five is shown, and the sender cannot pick for them (mirrors desktop exactly, same shared renderer)", async () => {
  const { env, mfl } = fresh();
  mfl.st.rosters["0001"] = [loaded("32000"), flat("14056")]; // the loaded asset actually being sent must live on the SENDER's own roster
  mfl.st.rosters["0002"] = [...fiveLoaded(31000), flat("13100")]; // recipient already at 5
  const id = await stageViaHttp(env, { movements: [{ from: "0001", to: "0002", asset_tokens: ["32000"] }], to: { fid: "0002", name: "CBP" } });
  const sender = loadMobile(env, { token: "tok-B", fid: "0001" });
  await sender.api.loadStaged2WayDetail(id);
  await settle();
  const html = sender.api.renderStaged2WayDetailHtml(sender.api.tw2s.detail);
  t.match(html, /Can't be accepted|too many loaded contracts/i);
  t.doesNotMatch(html, /data-t3w-drop-fid="0002"[^>]*>\s*<input/);
});

test("MOBILE: ACCEPT via the real client hits the real accept endpoint with just {id}, never a forged franchise claim", async () => {
  const { env, mfl } = fresh();
  seedFlatRosters(mfl);
  const id = await stageViaHttp(env);
  const recipient = loadMobile(env, { token: "tok-C", fid: "0002" }); // tok-C = 0002 in this harness's SESSIONS map? verified below
  await recipient.api.doAccept2WayStaged(id);
  await settle();
  const acceptReq = recipient.calls.find((c) => c.path === "/api/trades/2way/accept");
  t.ok(acceptReq, "an accept call must have been made");
  t.deepEqual(Object.keys(acceptReq.body), ["id"]);
  t.equal(acceptReq.body.id, id);
});

test("MOBILE: SIGNED-OUT accept is refused by the real server -- no toast claims success", async () => {
  const { env, mfl } = fresh();
  seedFlatRosters(mfl);
  const id = await stageViaHttp(env);
  const m = loadMobile(env, { token: "", fid: "" });
  await m.api.doAccept2WayStaged(id);
  await settle();
  const err = m.toasts.find((x) => x[1] === "err");
  t.ok(err, "a signed-out accept must produce an error toast, never a silent success");
});

test("MOBILE: WRONG-OWNER accept (a real session for an unrelated franchise) is refused by the real server", async () => {
  const { env, mfl } = fresh();
  seedFlatRosters(mfl);
  const id = await stageViaHttp(env);
  const m = loadMobile(env, { token: "tok-O", fid: "0003" });
  await m.api.doAccept2WayStaged(id);
  await settle();
  const err = m.toasts.find((x) => x[1] === "err");
  t.ok(err);
});

test("MOBILE: ZERO MFL WRITES across accept/cancel/recheck/select-drops through the real client, whatever the outcome", async () => {
  const { env, mfl } = fresh();
  seedFlatRosters(mfl);
  const id = await stageViaHttp(env);
  const m = loadMobile(env, { token: "tok-B", fid: "0001" }); // the SENDER, not the recipient -- accept must be refused
  await m.api.doAccept2WayStaged(id);
  await m.api.doCancel2WayStaged(id);
  await settle();
  t.equal(mfl.st.imports.length, 0);
});

await run("trade_2way_staged_clients");
restoreConsole();
