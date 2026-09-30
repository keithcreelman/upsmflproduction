// COMMISSIONER REVIEW QUEUE — the Execute action (Keith, 2026-09-30): "Please add the Execute
// action to the commissioner review queue... The button must show the teams, trade terms,
// selected loaded-player drops, and current compliance; require a deliberate commissioner
// confirmation; then call the existing route, which must recalculate and fail closed before
// any write. Disable the button for an unresolved or uncertain sequence and show its ledger
// steps instead. Test the real queue action without making a live MFL write."
//
// Runs the REAL site/commish/trade_review_queue.html script (not a re-implementation) in Node
// against a fake DOM, with fetch() bridged to the REAL worker + real SQLite D1 + a stateful
// fake MFL -- the same technique tests/trade_2way_staged_clients.test.mjs already established.
// Every scenario here uses the fake MFL exclusively; nothing ever reaches myfantasyleague.com.
//   node tests/trade_review_queue_execute_action.test.mjs
import fs from "node:fs";
import { createRequire } from "node:module";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, bindSelf, quiet, ADMIN_KEY } from "./fixtures/worker_harness.mjs";
import { makeEl, settle } from "./fixtures/fake_dom.mjs";
import { THREE_WAY_MIGRATIONS } from "./fixtures/d1_sqlite.mjs";

const require = createRequire(import.meta.url);
const T = require("../site/shared/trade_3way_view.js");
const worker = (await (async () => { await import("./fixtures/register_md_loader.mjs"); return import("../worker/src/index.js"); })()).default;
const PAGE_SRC = fs.readFileSync(new URL("../site/commish/trade_review_queue.html", import.meta.url), "utf8");
const restoreConsole = quiet();

const MIGRATIONS = [...THREE_WAY_MIGRATIONS, "0162_ups_trade_cap_acknowledgments.sql", "0163_ups_trade_conditional_drops.sql", "0164_ups_2way_trades.sql"];
const SENDER = "0001", HAMMER = "0005";
const flat = (id) => ({ id, salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" });
const loaded = (id) => ({ id, salary: "5000", contractYear: "2", contractStatus: "Vet-BL", contractInfo: "CL 2|TCV 20K|AAV 10K|Y1-5K|Y2-15K" });

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
const tradeRow = (env, id) => env.UPS_MFL_DB.raw.prepare("SELECT * FROM ups_2way_trades WHERE id=?").get(id);
const ledgerRow = (env, id) => env.UPS_MFL_DB.raw.prepare("SELECT * FROM ups_trade_executions WHERE exec_key=?").get(id);

// A fetch() that goes STRAIGHT to the real worker -- mirrors tests/trade_2way_staged_clients.test.mjs's
// bridgeFetch, generalized to this page's own worker-base URL convention.
function bridgeFetch(env) {
  const calls = [];
  return async (input, init) => {
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
}

// The REAL queue page's inline script, stripped of its own `(function () { ... })();` wrapper
// so the internals (load, doExecute, execFor) can be returned and driven directly -- same
// "extract the real code, don't re-implement it" rule every other client test in this repo
// already follows.
function extractInnerScript() {
  const start = PAGE_SRC.indexOf("(function () {");
  const end = PAGE_SRC.lastIndexOf("})();");
  if (start < 0 || end < 0 || end < start) throw new Error("could not locate the queue page's own IIFE");
  return PAGE_SRC.slice(start + "(function () {".length, end);
}

// A minimal real click-target: querySelectorAll(sel) scans the CURRENT innerHTML for every tag
// carrying the attribute named in `sel` (e.g. "[data-trq-exec-open]"), and returns one fake
// element per match whose getAttribute reads that match's own value -- exactly what
// renderList's own addEventListener loops need. click(attr, value) replays whichever listener
// was registered for that exact attribute+value pair, invoked with `this` bound the same way a
// real element would be.
function makeMountEl() {
  let html = "";
  let registry = {};
  const el = {
    get innerHTML() { return html; },
    set innerHTML(v) { html = v; registry = {}; },
    querySelectorAll(sel) {
      const m = /\[([\w-]+)\]/.exec(sel);
      const attr = m ? m[1] : "";
      const re = new RegExp("<[^>]*\\b" + attr + '="([^"]*)"[^>]*>', "g");
      const found = [];
      let mm;
      while ((mm = re.exec(html))) {
        const value = mm[1];
        const fakeEl = { getAttribute: (a) => (a === attr ? value : null) };
        registry[attr + "=" + value] = registry[attr + "=" + value] || { el: fakeEl };
        fakeEl.addEventListener = (type, fn) => { registry[attr + "=" + value].fn = fn; };
        found.push(fakeEl);
      }
      return found;
    },
    click(attr, value) {
      const entry = registry[attr + "=" + value];
      if (!entry || !entry.fn) throw new Error(`no element for [${attr}="${value}"] is rendered`);
      entry.fn.call(entry.el, {});
    },
    has(attr, value) { return !!registry[attr + "=" + value]; },
  };
  return el;
}

function loadQueuePage(env, { apiKey = ADMIN_KEY } = {}) {
  const bridge = bridgeFetch(env);
  const registry = { trqAuthBanner: makeEl("trqAuthBanner"), trqAuthMsg: makeEl("trqAuthMsg"), trqApiKeyInput: makeEl("trqApiKeyInput"), trqRefreshBtn: makeEl("trqRefreshBtn"), trqIncludeAll: makeEl("trqIncludeAll"), trqCount: makeEl("trqCount"), trqList: makeMountEl() };
  registry.trqIncludeAll.checked = false;
  const document = { getElementById: (id) => registry[id] || null };
  const localStorageData = {};
  const localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(localStorageData, k) ? localStorageData[k] : null),
    setItem: (k, v) => { localStorageData[k] = String(v); },
    removeItem: (k) => { delete localStorageData[k]; },
  };
  if (apiKey) localStorage.setItem("ups_commish_apikey", apiKey);
  const win = {
    location: { href: "https://commish.test/trade_review_queue.html" },
    history: { replaceState() {} },
    UPS_COMMISH_LEAGUE: "74598", UPS_COMMISH_YEAR: "2026",
    UPS_COMMISH_API_BASE: "https://worker.test",
    UPS_COMMISH_MFL_USER_ID: "",
    UPS_TRADE_3WAY: T,
  };
  const code = extractInnerScript();
  const factory = new Function("window", "document", "fetch", "localStorage",
    code + "\n  return { load: load, execFor: execFor, doExecute: doExecute };");
  const api = factory(win, document, bridge, localStorage);
  return { api, mount: registry.trqList };
}

// ═══════════════════ NO-DROPS-REQUIRED, flags off (today's real production state) ═══════════════════

test("QUEUE EXECUTE: a NO-DROPS-REQUIRED trade, accepted, flags off -- the REAL button shows, and Confirm & Execute correctly HOLDS (zero MFL writes, ledger unchanged), never claiming success", async () => {
  const { env, mfl } = fresh({ env: { TRADE_2WAY_STAGING_EXECUTE: "0" } });
  mfl.st.rosters[SENDER] = [flat("14056")];
  mfl.st.rosters[HAMMER] = [flat("13100")];
  const { createStaged2WayTrade, accept2WayTrade } = await import("../worker/src/trade_2way.js");
  const created = await createStaged2WayTrade(env, {}, { leagueId: "74598", season: "2026", from: { fid: SENDER, name: "Sender Squad" }, to: { fid: HAMMER, name: "HammerTime" }, movements: [{ from: SENDER, to: HAMMER, asset_tokens: ["14056"], cap_k: 0 }] });
  const acceptCtx = { waits: [], waitUntil(p) { this.waits.push(p); }, async flush() { await Promise.allSettled(this.waits); } };
  await accept2WayTrade(env, acceptCtx, created.id, { fid: HAMMER, leagueId: "74598", season: "2026" }, {});
  await acceptCtx.flush(); // the no-drops execute2Way auto-fire (held for execution_disabled) runs inside this waitUntil promise
  t.equal(tradeRow(env, created.id).status, "collecting", "sanity: held, not completed");

  const q = loadQueuePage(env);
  await settle(40);
  t.ok(q.mount.has("data-trq-exec-open", created.id), "the Execute button is rendered for this eligible, held trade");

  q.mount.click("data-trq-exec-open", created.id);
  await settle(40);
  const panelHtml = q.mount.innerHTML;
  t.match(panelHtml, /L\.A\. Looks/, "shows the sending team (the real resolved franchise name, not the create-time literal)");
  t.match(panelHtml, /HammerTime/, "shows the receiving team");
  t.match(panelHtml, /14056/, "shows the trade terms (asset token)");
  t.ok(q.mount.has("data-trq-exec-confirm", created.id), "the deliberate second confirm control is rendered");

  q.mount.click("data-trq-exec-confirm", created.id);
  await settle(60);

  t.equal(mfl.st.imports.length, 0, "zero MFL writes of any kind -- fails closed, exactly as the existing route already does");
  const row = tradeRow(env, created.id);
  t.equal(row.status, "collecting", "still held -- never falsely marked completed by clicking the button");
  t.equal(row.mfl_trade_id, null);
  t.doesNotMatch(q.mount.innerHTML, /✅|Executed\./i, "never claims success -- the route itself is fire-and-continue (202), so the button can't and doesn't claim a result it doesn't have");
  t.match(q.mount.innerHTML, /Execution started/i, "tells the commissioner plainly what actually happened: started, not finished");
});

test("QUEUE EXECUTE: the SAME button, once the commissioner turns the execution flag on, actually completes the trade (via the fake MFL only) -- proving the button really does call the existing, already-tested route, not a stub", async () => {
  const { env, mfl } = fresh({ env: { TRADE_2WAY_STAGING_EXECUTE: "0" } }); // held first, matching the real sequencing
  mfl.st.rosters[SENDER] = [flat("14056")];
  mfl.st.rosters[HAMMER] = [flat("13100")];
  const { createStaged2WayTrade, accept2WayTrade } = await import("../worker/src/trade_2way.js");
  const created = await createStaged2WayTrade(env, {}, { leagueId: "74598", season: "2026", from: { fid: SENDER, name: "Sender Squad" }, to: { fid: HAMMER, name: "HammerTime" }, movements: [{ from: SENDER, to: HAMMER, asset_tokens: ["14056"], cap_k: 0 }] });
  const acceptCtx = { waits: [], waitUntil(p) { this.waits.push(p); }, async flush() { await Promise.allSettled(this.waits); } };
  await accept2WayTrade(env, acceptCtx, created.id, { fid: HAMMER, leagueId: "74598", season: "2026" }, {});
  await acceptCtx.flush();
  t.equal(tradeRow(env, created.id).status, "collecting", "sanity: held while off");

  env.TRADE_2WAY_STAGING_EXECUTE = "1"; // the commissioner turns it on
  const q = loadQueuePage(env);
  await settle(40);
  t.ok(q.mount.has("data-trq-exec-open", created.id));
  q.mount.click("data-trq-exec-open", created.id);
  await settle(40);
  q.mount.click("data-trq-exec-confirm", created.id);
  await settle(80);

  const row = tradeRow(env, created.id);
  t.equal(row.status, "completed", "now genuinely completed via the same button, same route");
  t.ok(row.mfl_trade_id, "a real (fake-MFL) trade id was produced");
  const tradeImports = mfl.st.imports.filter((x) => x.type === "tradeProposal" || x.type === "tradeResponse");
  t.equal(tradeImports.length, 2, "a real commissioner-run propose+accept pair actually ran, through the fake MFL only");
});

// ═══════════════════ HAMMER/CHIG drop-first, flags off -- the exact scenario Keith asked about ═══════════════════

test("QUEUE EXECUTE: Hammer's own drop-first deal, flags off -- Confirm & Execute shows his selected drop and current compliance, then correctly HOLDS the trade leg with zero MFL writes", async () => {
  const { env, mfl } = fresh({ env: { TRADE_2WAY_DROP_EXECUTE_ENABLED: "1", TRADE_2WAY_STAGING_EXECUTE: "0" } });
  mfl.st.rosters[SENDER] = [{ id: "14056", salary: "5000", contractYear: "2", contractStatus: "Vet-BL", contractInfo: "CL 2|TCV 20K|AAV 10K|Y1-5K|Y2-15K" }];
  mfl.st.rosters[HAMMER] = [flat("13100"), loaded("9000"), loaded("9001"), loaded("9002"), loaded("9003"), loaded("9004")];
  const { createStaged2WayTrade, accept2WayTrade, select2WayLoadedContractDrops } = await import("../worker/src/trade_2way.js");
  const created = await createStaged2WayTrade(env, {}, { leagueId: "74598", season: "2026", from: { fid: SENDER, name: "Sender Squad" }, to: { fid: HAMMER, name: "HammerTime" }, movements: [{ from: SENDER, to: HAMMER, asset_tokens: ["14056"], cap_k: 0 }] });
  await select2WayLoadedContractDrops(env, created.id, { fid: HAMMER, leagueId: "74598", season: "2026" }, ["9004"]);
  await accept2WayTrade(env, { waitUntil: (p) => p }, created.id, { fid: HAMMER, leagueId: "74598", season: "2026" }, {});

  const q = loadQueuePage(env);
  await settle(40);
  t.ok(q.mount.has("data-trq-exec-open", created.id), "Execute is offered -- drops selected and satisfied, not yet executed");
  q.mount.click("data-trq-exec-open", created.id);
  await settle(40);
  t.match(q.mount.innerHTML, /Selected loaded-contract drops/i);
  t.match(q.mount.innerHTML, /9004/, "shows Hammer's own selected drop");

  q.mount.click("data-trq-exec-confirm", created.id);
  await settle(80);

  // No live MFL write of any kind -- the fake MFL never saw a real drop action or trade import.
  t.equal(mfl.st.imports.length, 0, "zero trade/roster imports -- nothing reached even the FAKE MFL's write surface");
  t.equal(mfl.st.rosters[HAMMER].some((p) => p.id === "9004"), true, "the player is still on Hammer's roster -- no drop happened either, since execution is disabled end to end");
  const row = tradeRow(env, created.id);
  t.equal(row.status, "collecting");
  t.equal(row.mfl_trade_id, null);
});

// ═══════════════════ disabled state: needs_review / failed ═══════════════════

test("QUEUE EXECUTE: a NEEDS-REVIEW sequence disables the button and points at the ledger steps shown above it -- clicking Execute is not offered at all", async () => {
  const { env, mfl } = fresh({ env: { TRADE_2WAY_DROP_EXECUTE_ENABLED: "1", TRADE_2WAY_STAGING_EXECUTE: "0" } });
  mfl.st.rosters[SENDER] = [{ id: "14056", salary: "5000", contractYear: "2", contractStatus: "Vet-BL", contractInfo: "CL 2|TCV 20K|AAV 10K|Y1-5K|Y2-15K" }];
  mfl.st.rosters[HAMMER] = [flat("13100"), loaded("9000"), loaded("9001"), loaded("9002"), loaded("9003"), loaded("9004")];
  const { createStaged2WayTrade, accept2WayTrade, select2WayLoadedContractDrops } = await import("../worker/src/trade_2way.js");
  const created = await createStaged2WayTrade(env, {}, { leagueId: "74598", season: "2026", from: { fid: SENDER, name: "Sender Squad" }, to: { fid: HAMMER, name: "HammerTime" }, movements: [{ from: SENDER, to: HAMMER, asset_tokens: ["14056"], cap_k: 0 }] });
  await select2WayLoadedContractDrops(env, created.id, { fid: HAMMER, leagueId: "74598", season: "2026" }, ["9004"]);
  await accept2WayTrade(env, { waitUntil: (p) => p }, created.id, { fid: HAMMER, leagueId: "74598", season: "2026" }, {});
  // Force a real NEEDS_REVIEW row directly (a prior attempt that came back genuinely uncertain) --
  // the exact shape tests/trade_2way_drop_first_execute.test.mjs's own reconciliation tests use.
  env.UPS_MFL_DB.raw.prepare(
    `INSERT INTO ups_trade_executions (league_id, season, exec_key, kind, state, steps_json, created_at_utc, updated_at_utc)
     VALUES ('74598', '2026', ?, 'two_way_staged_drop_first', 'executed_needs_review', ?, ?, ?)`
  ).run(created.id, JSON.stringify({ "drop:9004": { status: "unconfirmed", reason: "call_failed: network timeout" } }), new Date().toISOString(), new Date().toISOString());

  const q = loadQueuePage(env);
  await settle(40);
  t.ok(!q.mount.has("data-trq-exec-open", created.id), "Execute is NOT offered while the sequence reads needs-review");
  t.match(q.mount.innerHTML, /Execution ledger.*executed_needs_review/s, "the real ledger state is shown");
  t.match(q.mount.innerHTML, /unconfirmed/i, "the per-step detail (from the real ledger) is shown in place of the button");
  t.match(q.mount.innerHTML, /reviewed the ledger steps/i, "explains WHY the button is disabled");
});

await run("trade_review_queue_execute_action");
