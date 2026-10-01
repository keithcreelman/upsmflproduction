// THE COMPLETE HAMMER TIMES / CHIG OKONKWO FLOW, END TO END (Keith, 2026-09-30, third pass):
// "Bring #1163 up to date with #1149 and verify the complete Hammer/Chig flow: warning -> staged
// offer -> Hammer selects one of his loaded players -> accepts -> fresh compliance check ->
// authorized drop -> verified trade completion, with clear hold and notification on any failure.
// Test the same flow on desktop and mobile, including two required drops and IR counting."
//
// The warning + server-side refusal of an illegal native offer is proven in
// tests/trade_loaded_contract_clients.test.mjs and tests/trade_loaded_contracts.test.mjs
// (the "HAMMER TIMES / CHIG OKONKWO" tests there). The real drop-action CODE (parsing, posting,
// classification) is proven in tests/trade_drop_action_reconstructed_fixture.test.mjs -- against
// a RECONSTRUCTED fixture, not a captured MFL response; see that file's own header for exactly
// what is and isn't verified (no authorized read-only MFL session was available in that session
// either). THIS file reuses the identical stub and is bound by the identical caveat: it proves
// the same real code against the same unverified-shape fixture, walking every step of the
// Hammer/Chig scenario back to back through the REAL staged 2-way engine and the REAL
// drop-first execution engine (never the old JSON-stub shortcut), on the real worker and real D1.
//   node tests/trade_hammer_chig_end_to_end.test.mjs
import fs from "node:fs";
import { createRequire } from "node:module";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, bindSelf, quiet, NAMES } from "./fixtures/worker_harness.mjs";
import { makeEl, settle } from "./fixtures/fake_dom.mjs";
import { THREE_WAY_MIGRATIONS } from "./fixtures/d1_sqlite.mjs";

const require = createRequire(import.meta.url);
const T = require("../site/shared/trade_3way_view.js");
const worker = (await (async () => { await import("./fixtures/register_md_loader.mjs"); return import("../worker/src/index.js"); })()).default;
const DESK_SRC = fs.readFileSync(new URL("../site/trades/trade_workbench.js", import.meta.url), "utf8");
const MOBILE_SRC = fs.readFileSync(new URL("../site/m/views/trade.js", import.meta.url), "utf8");
const restoreConsole = quiet();

const { createStaged2WayTrade, accept2WayTrade, select2WayLoadedContractDrops, executeDropFirstDeal } = await import("../worker/src/trade_2way.js");

const Q = "L=74598&YEAR=2026";
const MIGRATIONS = [...THREE_WAY_MIGRATIONS, "0162_ups_trade_cap_acknowledgments.sql", "0163_ups_trade_conditional_drops.sql", "0164_ups_2way_trades.sql"];
// The sender is franchise 0001 ("L.A. Looks", the default fixture name); HammerTime is 0005 --
// the real fixture name matching Keith's own naming, not a generic stand-in.
const SENDER = "0001", HAMMER = "0005";
const flat = (id) => ({ id, salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" });
const loaded = (id) => ({ id, salary: "5000", contractYear: "2", contractStatus: "Vet-BL", contractInfo: "CL 2|TCV 20K|AAV 10K|Y1-5K|Y2-15K" });
const loadedIR = (id) => ({ id, salary: "5000", contractYear: "2", contractStatus: "Vet-BL", contractInfo: "CL 2|TCV 20K|AAV 10K|Y1-5K|Y2-15K", status: "INJURED_RESERVE" });

function fresh(over) {
  const env = makeWorkerEnv({ __migrations: MIGRATIONS, TRADE_2WAY_STAGING_ENABLED: "1", COMMISH_DISCORD_USER_ID: "621530026831118346", ...((over && over.env) || {}) });
  env.UPS_MFL_DB.raw.exec("CREATE TABLE IF NOT EXISTS discord_owners (franchise_id TEXT, active_owner TEXT, discord_user_id TEXT)");
  env.UPS_MFL_DB.raw.prepare("INSERT INTO discord_owners VALUES (?,?,?)").run(SENDER, "Y", "100000000000000001");
  env.UPS_MFL_DB.raw.prepare("INSERT INTO discord_owners VALUES (?,?,?)").run(HAMMER, "Y", "100000000000000005");
  bindSelf(env);
  const mfl = makeMfl({ tokens: { "tok-H": HAMMER }, ...(over && over.mfl) });
  mfl.install();
  return { env, mfl };
}
const ledgerRow = (env, id) => env.UPS_MFL_DB.raw.prepare("SELECT * FROM ups_trade_executions WHERE exec_key=?").get(id);
const tradeRow = (env, id) => env.UPS_MFL_DB.raw.prepare("SELECT * FROM ups_2way_trades WHERE id=?").get(id);

// ═══════ THE drop-action fetch stub, against a RECONSTRUCTED (not captured) fixture -- from
// tests/trade_drop_action_reconstructed_fixture.test.mjs; see that file's header for exactly
// what this does and does not prove. ═══════
const ACTION_URL = "https://www48.myfantasyleague.com/2026/csetup";
function loadRostPageHtml(leagueId, franchiseId, rosterIds) {
  const options = rosterIds.map((pid) => `<option value="${pid}">Player ${pid}</option>`).join("\n        ");
  return `<!DOCTYPE html><html><body>
    <form action="${ACTION_URL}?L=${leagueId}&FRANCHISE=${franchiseId}&C=LOADROST" method="POST">
      <input type="hidden" name="L" value="${leagueId}">
      <input type="hidden" name="FRANCHISE" value="${franchiseId}">
      <input type="hidden" name="C" value="LOADROST">
      <input type="text" name="sel_pid" value="">
      <input type="text" name="picker_filt_name" value="">
      <select name="ROSTER" multiple="multiple">
        ${options}
      </select>
      <input type="submit" value="Submit">
    </form>
  </body></html>`;
}
const LOCKOUT_PAGE_HTML = `<!DOCTYPE html><html><body><h1>Commissioner Access Required</h1></body></html>`;
function installRealDropActionFetchStub(env, mfl, { pageResponder, postResponder } = {}) {
  const delegate = globalThis.fetch;
  const postedCalls = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const isCsetupLoadRost = url.pathname.endsWith("/csetup") && url.searchParams.get("C") === "LOADROST";
    if (isCsetupLoadRost && (!init || (init.method || "GET").toUpperCase() === "GET")) {
      const res = (pageResponder ? pageResponder(url) : null) || { status: 200, body: loadRostPageHtml(url.searchParams.get("L"), url.searchParams.get("FRANCHISE"), (mfl.st.rosters[url.searchParams.get("FRANCHISE")] || []).map((p) => p.id)) };
      return new Response(res.body, { status: res.status, headers: { "content-type": "text/html" } });
    }
    if (url.pathname.endsWith("/csetup") && init && (init.method || "").toUpperCase() === "POST") {
      const params = new URLSearchParams(init.body);
      const rosterIds = params.getAll("ROSTER");
      postedCalls.push({ franchiseId: params.get("FRANCHISE"), rosterIds });
      const res = postResponder ? postResponder(params, postedCalls.length) : { status: 200, body: "OK" };
      if (res.applyToRoster !== false) {
        const fid = params.get("FRANCHISE");
        if (fid && mfl.st.rosters[fid]) {
          const keep = new Set(rosterIds);
          mfl.st.rosters[fid] = mfl.st.rosters[fid].filter((p) => keep.has(String(p.id)));
        }
      }
      return new Response(res.body, { status: res.status, headers: { "content-type": "text/html" } });
    }
    return delegate(input, init);
  };
  return { postedCalls, restore: () => { globalThis.fetch = delegate; } };
}

// ═══════ STEP-BY-STEP SERVER FLOW ═══════
test("HAMMER/CHIG END-TO-END, ONE REQUIRED DROP (incl. IR): warning -> staged offer -> Hammer selects his own IR loaded contract -> accepts -> fresh compliance check -> REAL authorized drop -> verified trade completion", async () => {
  const { env, mfl } = fresh({ env: { TRADE_2WAY_DROP_EXECUTE_ENABLED: "1", TRADE_2WAY_STAGING_EXECUTE: "1" } });

  // Step 1 -- HammerTime sits at 5 loaded, one on IR. Chig Okonkwo (loaded) would be his 6th.
  mfl.st.rosters[SENDER] = [{ id: "14056", salary: "5000", contractYear: "2", contractStatus: "Vet-BL", contractInfo: "CL 2|TCV 20K|AAV 10K|Y1-5K|Y2-15K" }]; // "Chig Okonkwo"
  mfl.st.rosters[HAMMER] = [flat("13100"), loaded("9000"), loaded("9001"), loaded("9002"), loaded("9003"), loadedIR("9004")];

  // Step 2 -- staged offer (never a native MFL proposal -- confirmed by mfl.st.imports staying
  // empty across this ENTIRE test, asserted at the end).
  const created = await createStaged2WayTrade(env, {}, {
    leagueId: "74598", season: "2026",
    from: { fid: SENDER, name: "Sender Squad" }, to: { fid: HAMMER, name: "HammerTime" },
    movements: [{ from: SENDER, to: HAMMER, asset_tokens: ["14056"], cap_k: 0 }],
  });
  t.ok(created && created.id, "the offer stages successfully -- this is exactly what 'warning, not a dead end' means: the deal is real and reviewable, not rejected outright");

  // Step 3 -- Hammer selects ONE of his own loaded players to drop. His IR player is a fully
  // legal candidate (proven directly: the selection is accepted as VALID, not rejected).
  const sel = await select2WayLoadedContractDrops(env, created.id, { fid: HAMMER, leagueId: "74598", season: "2026" }, ["9004"]);
  t.equal(sel.ok, true, JSON.stringify(sel));
  t.equal(sel.code, "selected");
  t.equal(sel.drop_requirement.satisfied, true);
  t.ok(sel.drop_requirement.candidates.includes("9004"), "the IR player is offered as a real candidate");

  // Step 4 -- Hammer accepts. Held, not executed (no auto-drop): the selection is conditional.
  const ctx = { waitUntil: (p) => p };
  const acc = await accept2WayTrade(env, ctx, created.id, { fid: HAMMER, leagueId: "74598", season: "2026" }, {});
  t.equal(acc.ok, true);
  t.equal(acc.accepted, true);
  t.equal(acc.executing, false);
  t.equal(mfl.st.rosters[HAMMER].some((p) => p.id === "9004"), true, "nothing has been dropped merely by selecting and accepting");

  // Step 5/6 -- the commissioner triggers execution. A FRESH compliance re-check runs (not a
  // cached one from creation), then the REAL MFL drop-action pipeline (real HTML parse, real
  // POST, real post-write verification) -- then the trade itself completes.
  const stub = installRealDropActionFetchStub(env, mfl);
  try {
    const r = await executeDropFirstDeal(env, {}, created.id);
    t.equal(r.ok, true, JSON.stringify(r));
    t.equal(stub.postedCalls.length, 1);
    t.ok(!stub.postedCalls[0].rosterIds.includes("9004"), "the REAL posted roster list omits the dropped IR player");
    t.equal(mfl.st.rosters[HAMMER].some((p) => p.id === "9004"), false, "the player is genuinely off HammerTime's roster now");
    const steps = JSON.parse(ledgerRow(env, created.id).steps_json);
    t.equal(steps["drop:9004"].status, "confirmed");
    t.equal(ledgerRow(env, created.id).state, "completed");
    t.equal(tradeRow(env, created.id).status, "completed");
  } finally {
    stub.restore();
  }

  // Through create/select/accept, ZERO MFL writes of any kind -- confirmed by every assertion
  // above (mfl.st.rosters only ever changed via the drop stub's own explicit POST handling).
  // The trade's own completion IS a real, legitimate MFL write -- exactly what "verified trade
  // completion" means -- but it is the commissioner-run pairwise executor's OWN propose+accept
  // pair (asCommish), never a pending native offer the sender's own session created or could act
  // on directly; nothing was ever left sitting in MFL's native pending-offer queue.
  t.equal(mfl.st.pending.length, 0, "no dangling native pending offer was ever left in MFL's own queue");
  const tradeImports = mfl.st.imports.filter((x) => x.type === "tradeProposal" || x.type === "tradeResponse");
  t.equal(tradeImports.length, 2, "exactly one commissioner-run propose+accept pair, for the final completion only");
  t.ok(tradeImports.every((x) => x.apikey), "both writes authenticate via the commissioner API key (executeCommishTwoPartyTrade), never a forwarded owner session");
});

test("HAMMER/CHIG END-TO-END, TWO REQUIRED DROPS: the same full flow when Chig's arrival pushes HammerTime from 5 to 7 -- exactly two distinct, valid selections required, one satisfies nothing", async () => {
  const { env, mfl } = fresh({ env: { TRADE_2WAY_DROP_EXECUTE_ENABLED: "1", TRADE_2WAY_STAGING_EXECUTE: "1" } });
  mfl.st.rosters[SENDER] = [
    { id: "14056", salary: "5000", contractYear: "2", contractStatus: "Vet-BL", contractInfo: "CL 2|TCV 20K|AAV 10K|Y1-5K|Y2-15K" }, // Chig
    { id: "14057", salary: "5000", contractYear: "2", contractStatus: "Vet-BL", contractInfo: "CL 2|TCV 20K|AAV 10K|Y1-5K|Y2-15K" }, // a second loaded player, also incoming
  ];
  mfl.st.rosters[HAMMER] = [flat("13100"), loaded("9000"), loaded("9001"), loaded("9002"), loaded("9003"), loadedIR("9004")];

  const created = await createStaged2WayTrade(env, {}, {
    leagueId: "74598", season: "2026",
    from: { fid: SENDER, name: "Sender Squad" }, to: { fid: HAMMER, name: "HammerTime" },
    movements: [{ from: SENDER, to: HAMMER, asset_tokens: ["14056", "14057"], cap_k: 0 }],
  });

  const onePick = await select2WayLoadedContractDrops(env, created.id, { fid: HAMMER, leagueId: "74598", season: "2026" }, ["9004"]);
  t.equal(onePick.code, "selected_insufficient", "one valid pick never satisfies a two-drop requirement");
  t.equal(onePick.drop_requirement.required_drops, 2);
  t.equal(onePick.drop_requirement.valid_count, 1);

  const twoPicks = await select2WayLoadedContractDrops(env, created.id, { fid: HAMMER, leagueId: "74598", season: "2026" }, ["9004", "9000"]);
  t.equal(twoPicks.code, "selected");
  t.equal(twoPicks.drop_requirement.satisfied, true);

  const ctx = { waitUntil: (p) => p };
  const acc = await accept2WayTrade(env, ctx, created.id, { fid: HAMMER, leagueId: "74598", season: "2026" }, {});
  t.equal(acc.accepted, true);
  t.equal(acc.executing, false);

  const stub = installRealDropActionFetchStub(env, mfl);
  try {
    const r = await executeDropFirstDeal(env, {}, created.id);
    t.equal(r.ok, true, JSON.stringify(r));
    t.equal(stub.postedCalls.length, 2, "both required drops go through the REAL drop-action pipeline, one at a time");
    t.equal(mfl.st.rosters[HAMMER].some((p) => p.id === "9004"), false);
    t.equal(mfl.st.rosters[HAMMER].some((p) => p.id === "9000"), false);
    const steps = JSON.parse(ledgerRow(env, created.id).steps_json);
    t.equal(steps["drop:9004"].status, "confirmed");
    t.equal(steps["drop:9000"].status, "confirmed");
    t.equal(ledgerRow(env, created.id).state, "completed");
  } finally {
    stub.restore();
  }
});

test("HAMMER/CHIG END-TO-END, HOLD ON FAILURE: the exact same staged/selected/accepted deal, but MFL's real roster-edit page shows commissioner lockout at execution time -- clear hold, clear notification, nothing dropped, nothing completed", async () => {
  const { env, mfl } = fresh({ env: { TRADE_2WAY_DROP_EXECUTE_ENABLED: "1", TRADE_2WAY_STAGING_EXECUTE: "1" } });
  mfl.st.rosters[SENDER] = [{ id: "14056", salary: "5000", contractYear: "2", contractStatus: "Vet-BL", contractInfo: "CL 2|TCV 20K|AAV 10K|Y1-5K|Y2-15K" }];
  mfl.st.rosters[HAMMER] = [flat("13100"), loaded("9000"), loaded("9001"), loaded("9002"), loaded("9003"), loadedIR("9004")];
  const created = await createStaged2WayTrade(env, {}, {
    leagueId: "74598", season: "2026",
    from: { fid: SENDER, name: "Sender Squad" }, to: { fid: HAMMER, name: "HammerTime" },
    movements: [{ from: SENDER, to: HAMMER, asset_tokens: ["14056"], cap_k: 0 }],
  });
  await select2WayLoadedContractDrops(env, created.id, { fid: HAMMER, leagueId: "74598", season: "2026" }, ["9004"]);
  const ctx = { waitUntil: (p) => p };
  await accept2WayTrade(env, ctx, created.id, { fid: HAMMER, leagueId: "74598", season: "2026" }, {});

  const discord = mfl.st.discord; discord.length = 0;
  const stub = installRealDropActionFetchStub(env, mfl, { pageResponder: () => ({ status: 200, body: LOCKOUT_PAGE_HTML }) });
  try {
    const r = await executeDropFirstDeal(env, {}, created.id);
    t.equal(r.ok, false);
    t.equal(stub.postedCalls.length, 0, "never even attempts the write once the real page shows lockout");
    t.equal(mfl.st.rosters[HAMMER].some((p) => p.id === "9004"), true, "the player is still genuinely rostered -- nothing was dropped");
    t.equal(ledgerRow(env, created.id).state, "executed_needs_review");
    t.notEqual(tradeRow(env, created.id).status, "completed");
    const texts = discord.map((d) => String((d.body && d.body.content) || ""));
    t.ok(texts.some((c) => /not confirmed|lockout/i.test(c)), "a clear notification explains the hold -- not silence");
  } finally {
    stub.restore();
  }
});

// ═══════ DESKTOP + MOBILE: HAMMER'S OWN SESSION, HIS OWN PICKER, TWO DROPS INCLUDING IR ═══════
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
function loadDesktopStaged(env, { token, fid }) {
  const bridge = bridgeFetch(env);
  const start = DESK_SRC.indexOf('  var tw2s = { listStatus: "idle"');
  const end = DESK_SRC.indexOf("  // ── pre-send notice:");
  const code = DESK_SRC.slice(start, end);
  const registry = {};
  const get = (id) => (registry[id] = registry[id] || makeEl(id));
  const chrome = { main: makeEl("main"), toolbar: makeEl("toolbar") };
  const document = { getElementById: get, querySelector: (s) => (s === ".twb-main" ? chrome.main : s === ".twb-toolbar" ? chrome.toolbar : /#twb2sDetailBody/.test(s) ? get("twb2sDetailBody") : null) };
  const win = { UPS_TRADE_3WAY: T, location: { href: "https://trade.test/trade_workbench.html?embed=1" }, history: { replaceState() {} }, scrollTo() {} };
  const els = { tw2sList: get("twb2sList"), tw2sCount: get("twb2sCount") };
  const tw3NameOf = (fidArg) => NAMES[fidArg] || ("Franchise " + fidArg);
  const pad4 = (v) => { const d = String(v || "").replace(/\D/g, ""); return d ? d.padStart(4, "0").slice(-4) : ""; };
  const factory = new Function("window", "document", "fetch", "els", "getActiveFranchiseId", "resolveStaged2WayApiUrl", "tw3Reflow", "T3", "tw3NameOf", "pad4",
    code + "\nreturn { tw2s, open2WayStagedDetail, doSelectDrops2WayStaged, render2WayStagedDetail };");
  const api = factory(win, document, bridge, els, () => fid, () => `https://worker.test/api/trades/2way?MFL_USER_ID=${token}&L=74598&YEAR=2026`, () => {}, T, tw3NameOf, pad4);
  return { api, detail: () => get("twb2sDetailBody"), calls: bridge.calls };
}
function loadMobileStaged(env, { token, fid }) {
  const bridge = bridgeFetch(env);
  const start = MOBILE_SRC.indexOf("  var tw2s = {");
  const end = MOBILE_SRC.indexOf("  // ── pre-send notice (mobile)");
  const code = MOBILE_SRC.slice(start, end);
  const franchiseName = (fidArg) => NAMES[fidArg] || ("Franchise " + fidArg);
  const U = { pad4: (v) => { const d = String(v || "").replace(/\D/g, ""); return d ? d.padStart(4, "0").slice(-4) : ""; }, safeStr: (v) => (v == null ? "" : String(v).trim()), safeInt: (v, d) => { const n = parseInt(v, 10); return isFinite(n) ? n : (d == null ? 0 : d); }, escapeHtml: (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])) };
  const M = { util: U, api: { workerUrl: (p) => "https://worker.test" + p, getStoredMflUserId: () => token }, state: { ctx: { leagueId: "74598", year: "2026" }, viewerFranchiseId: fid }, ui: { showToast() {} }, route: { renderRoute() {}, navigate() {} } };
  const document = { getElementById: () => null, body: { style: {} } };
  const factory = new Function("T", "M", "U", "franchiseName", "subTabs", "fetch", "document",
    code + "\nreturn { tw2s, loadStaged2WayDetail, doSelectDrops2WayStaged, renderStaged2WayDetailHtml };");
  const api = factory(T, M, U, franchiseName, () => "", bridge, document);
  return { api, calls: bridge.calls };
}
function seedHammerTwoDropScenario(env, mfl) {
  mfl.st.rosters[SENDER] = [
    { id: "14056", salary: "5000", contractYear: "2", contractStatus: "Vet-BL", contractInfo: "CL 2|TCV 20K|AAV 10K|Y1-5K|Y2-15K" },
    { id: "14057", salary: "5000", contractYear: "2", contractStatus: "Vet-BL", contractInfo: "CL 2|TCV 20K|AAV 10K|Y1-5K|Y2-15K" },
  ];
  mfl.st.rosters[HAMMER] = [flat("13100"), loaded("9000"), loaded("9001"), loaded("9002"), loaded("9003"), loadedIR("9004")];
  return { from: SENDER, to: HAMMER, asset_tokens: ["14056", "14057"] };
}

// RULING (Keith, 2026-10-01, REPLACING the conditional-drop-picker ruling of 2026-09-29):
// "I do not want owners using... a conditional-drop picker... for this rule." The shared
// renderer's picker (site/shared/trade_3way_view.js's old renderLoadedContractDrops) is
// deleted, so the staged detail view -- unchanged code, but now rendering through the fixed
// shared renderer -- shows the SAME plain hard-block message as every other surface, with no
// checkboxes and no select-drops affordance for Hammer to click. The staged engine's own
// server-side select-drops mechanics (worker/src/trade_2way.js) are untouched and still
// covered directly at the worker layer above (this file's own WORKER FLOW tests); there is no
// UI path left to exercise it through anymore, so these two tests no longer try.
test("DESKTOP: HAMMER'S OWN session on the staged detail view shows the SAME hard-block message as every other surface -- no picker, no select-drops affordance", async () => {
  const { env, mfl } = fresh();
  const movement = seedHammerTwoDropScenario(env, mfl);
  const created = await createStaged2WayTrade(env, {}, { leagueId: "74598", season: "2026", from: { fid: SENDER, name: "Sender Squad" }, to: { fid: HAMMER, name: "HammerTime" }, movements: [{ ...movement, cap_k: 0 }] });
  const hammer = loadDesktopStaged(env, { token: "tok-H", fid: HAMMER });
  await hammer.api.open2WayStagedDetail(created.id);
  await settle();
  const html1 = hammer.detail().innerHTML;
  t.match(html1, /too many loaded contracts/i);
  t.match(html1, /would have 7 loaded contracts \(including IR\) after this trade — the limit is 5/, "names HammerTime's own projected count");
  t.doesNotMatch(html1, /data-t3w-drop-pid/, "no picker -- nothing for Hammer to check");
  t.equal(mfl.st.imports.length, 0);
});

test("MOBILE: the SAME HammerTime scenario shows the SAME hard-block message, no picker", async () => {
  const { env, mfl } = fresh();
  const movement = seedHammerTwoDropScenario(env, mfl);
  const created = await createStaged2WayTrade(env, {}, { leagueId: "74598", season: "2026", from: { fid: SENDER, name: "Sender Squad" }, to: { fid: HAMMER, name: "HammerTime" }, movements: [{ ...movement, cap_k: 0 }] });
  const hammer = loadMobileStaged(env, { token: "tok-H", fid: HAMMER });
  await hammer.api.loadStaged2WayDetail(created.id);
  await settle();
  const html1 = hammer.api.renderStaged2WayDetailHtml(hammer.api.tw2s.detail);
  t.match(html1, /too many loaded contracts/i);
  t.match(html1, /would have 7 loaded contracts \(including IR\) after this trade — the limit is 5/);
  t.doesNotMatch(html1, /data-t3w-drop-pid/, "no picker on mobile either");
  t.equal(mfl.st.imports.length, 0);
});

await run("trade_hammer_chig_end_to_end");
restoreConsole();
