// The commissioner Trade Review Queue page (site/commish/trade_review_queue.html). Was a
// READ-ONLY hold/review surface (Keith's ruling, 2026-09-29: "do not add a drop or trade
// execution button yet") -- superseded 2026-09-30 by a real, confirmed Execute action (see
// tests/trade_review_queue_execute_action.test.mjs for that action's own thorough coverage:
// what it shows, when it's disabled, and that it calls the real route with zero live MFL
// writes in every scenario tested). This file keeps the surrounding read-only-page behavior
// that is STILL true today (auth, zero writes from merely loading the page, per-step ledger
// detail, aging banners) and updates the two tests whose premise the new Execute action
// deliberately changed. Runs the page's REAL inline script in a vm sandbox against a fake DOM,
// with fetch() bridged to the real worker + real D1 + a stateful fake MFL, mirroring the
// established slice-and-stub technique.
//   node tests/trade_review_queue_page.test.mjs
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, bindSelf, quiet, COMMISH_COOKIE, ADMIN_KEY } from "./fixtures/worker_harness.mjs";
import { settle } from "./fixtures/fake_dom.mjs";
import { THREE_WAY_MIGRATIONS } from "./fixtures/d1_sqlite.mjs";

const require = createRequire(import.meta.url);
const T = require("../site/shared/trade_3way_view.js");
const worker = (await (async () => { await import("./fixtures/register_md_loader.mjs"); return import("../worker/src/index.js"); })()).default;
const HTML = fs.readFileSync(new URL("../site/commish/trade_review_queue.html", import.meta.url), "utf8");
const restoreConsole = quiet();

const MIGRATIONS = [...THREE_WAY_MIGRATIONS, "0162_ups_trade_cap_acknowledgments.sql", "0163_ups_trade_conditional_drops.sql", "0164_ups_2way_trades.sql"];
const flat = (id) => ({ id, salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" });

function fresh(over) {
  const env = makeWorkerEnv({ __migrations: MIGRATIONS, TRADE_2WAY_STAGING_ENABLED: "1", ...((over && over.env) || {}) });
  bindSelf(env);
  const mfl = makeMfl(over && over.mfl);
  mfl.install();
  return { env, mfl };
}

async function stageViaHttp(env, over) {
  const bridge = bridgeFetch(env);
  const url = "https://worker.test/api/trades/2way?L=74598&YEAR=2026&MFL_USER_ID=tok-B";
  const body = { from: { fid: "0001", name: "L.A. Looks" }, to: { fid: "0002", name: "CBP" }, movements: [{ from: "0001", to: "0002", asset_tokens: ["14056"] }], ...(over || {}) };
  const res = await bridge(url, { method: "POST", body: JSON.stringify(body) });
  return JSON.parse(await res.text()).id;
}

function bridgeFetch(env) {
  const calls = [];
  const fn = async (input, init) => {
    init = init || {};
    const url = new URL(String(input));
    calls.push({ method: (init.method || "GET").toUpperCase(), path: url.pathname, query: Object.fromEntries(url.searchParams) });
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

// Minimal DOM: real elements keyed by id, enough for getElementById/innerHTML/className/
// addEventListener/textContent, plus a querySelectorAll("[data-trq-toggle]") stub that scans
// rendered HTML for that one attribute (the only selector this page's script ever queries).
function makePageEl(id) {
  const listeners = {};
  return {
    id, innerHTML: "", textContent: "", className: "", checked: false, value: "",
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    fire(type, ev) { (listeners[type] || []).forEach((fn) => fn(ev || {})); },
    querySelectorAll(sel) {
      if (sel !== "[data-trq-toggle]") return [];
      const ids = [...this.innerHTML.matchAll(/data-trq-toggle="([^"]+)"/g)].map((m) => m[1]);
      return ids.map((tid) => ({ getAttribute: () => tid, addEventListener(type, fn) { (this.__l = this.__l || {})[type] = fn; }, fire() { this.__l.click(); } }));
    },
  };
}

function loadPage(env, { session, apiKey } = {}) {
  const bridge = bridgeFetch(env);
  const scriptStart = HTML.indexOf("<script>\n(function () {");
  const scriptEnd = HTML.indexOf("</script>", scriptStart);
  const code = HTML.slice(scriptStart + "<script>\n".length, scriptEnd);
  const registry = {};
  const get = (id) => (registry[id] = registry[id] || makePageEl(id));
  const store = {};
  const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } };
  const document = { getElementById: get };
  const win = {
    location: { href: "https://trade.test/site/commish/trade_review_queue.html" },
    UPS_COMMISH_MFL_USER_ID: session || "", UPS_TRADE_3WAY: T,
    history: { replaceState() {} },
    document, localStorage,
  };
  win.window = win;
  // Pre-seed every id the real script's getElementById calls reference, so it never sees
  // undefined and silently no-ops -- mirrors the real DOM always having the page's own markup.
  ["trqAuthBanner", "trqAuthMsg", "trqApiKeyInput", "trqRefreshBtn", "trqIncludeAll", "trqCount", "trqList"].forEach(get);
  if (apiKey) localStorage.setItem("ups_commish_apikey", apiKey);
  const sandbox = { window: win, document, localStorage, fetch: bridge, URL, encodeURIComponent, decodeURIComponent, console, setTimeout, Promise, Object, Array, String, Number, JSON, Math, Date };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "site/commish/trade_review_queue.html (inline script)" });
  return { els: registry, calls: bridge.calls };
}

test("COMMISSIONER SESSION: the real page calls /api/trades/2way/queue with the forwarded session and renders a real staged trade with ledger + no auth banner", async () => {
  const { env, mfl } = fresh();
  mfl.st.rosters["0001"] = [flat("14056")];
  mfl.st.rosters["0002"] = [flat("13100")];
  const id = await stageViaHttp(env);
  const p = loadPage(env, { session: "tok-commish" });
  await settle();
  const req = p.calls.find((c) => c.path === "/api/trades/2way/queue");
  t.ok(req, "the queue endpoint must have been called");
  t.equal(req.query.MFL_USER_ID, "tok-commish");
  t.equal(p.els.trqAuthBanner.className, "trq-auth-banner");
  t.match(p.els.trqList.innerHTML, /L\.A\. Looks/);
  t.match(p.els.trqList.innerHTML, /no row yet/i);
});

test("ADMIN KEY FALLBACK: a saved localStorage key works without any session at all", async () => {
  const { env, mfl } = fresh();
  mfl.st.rosters["0001"] = [flat("14056")];
  mfl.st.rosters["0002"] = [flat("13100")];
  const id = await stageViaHttp(env);
  const p = loadPage(env, { apiKey: ADMIN_KEY });
  await settle();
  const req = p.calls.find((c) => c.path === "/api/trades/2way/queue");
  t.ok(req);
  t.equal(req.query.APIKEY, ADMIN_KEY);
  t.match(p.els.trqList.innerHTML, /L\.A\. Looks/);
});

test("NO SESSION, NO KEY: the real server refuses (401), and the page shows the auth banner, never a fabricated empty queue passed off as 'nothing to review'", async () => {
  const { env } = fresh();
  const p = loadPage(env, {});
  await settle();
  t.equal(p.els.trqAuthBanner.className, "trq-auth-banner show");
  t.match(p.els.trqAuthMsg.textContent, /Not authorized/);
});

test("WRONG OWNER: an ordinary owner's real session is refused by the server (403, not_commish-shaped), not silently shown as an empty queue", async () => {
  const { env } = fresh();
  const p = loadPage(env, { session: "tok-B" }); // 0001, a real owner, NOT the commissioner (0008/0000)
  await settle();
  t.equal(p.els.trqAuthBanner.className, "trq-auth-banner show");
});

test("EXECUTE AFFORDANCE IS GATED, NEVER A BARE DROP AFFORDANCE: a not-yet-accepted trade offers only a disabled Execute with a plain reason; the drop picker's own interactive checkbox markup never appears anywhere on this page", async () => {
  const { env, mfl } = fresh();
  mfl.st.rosters["0001"] = [flat("14056")];
  mfl.st.rosters["0002"] = [flat("13100")];
  await stageViaHttp(env); // not yet accepted -- to_state stays 'pending'
  const p = loadPage(env, { session: "tok-commish" });
  await settle();
  const html = p.els.trqList.innerHTML;
  // Keith's ruling (2026-09-30) added a real, confirmed Execute action -- but never a bare
  // one-click drop affordance of any kind: renderCompliance is still called with no viewerFid,
  // so its own interactive drop-selection picker (a DIFFERENT control from Execute) never
  // renders here, on this or any other page state.
  t.doesNotMatch(html, /data-t3w-act="select-drops"/, "the drop picker's own confirm button must never appear -- conditional-drop SELECTION stays the owner's own action elsewhere, never a commissioner-side control on this page");
  t.doesNotMatch(html, /<button[^>]*>\s*(Drop this player|Confirm drop)/i, "no button anywhere offers to drop a player directly");
  const execBtn = /<button type="button" class="trq-exec-btn"( disabled)?>([^<]*)<\/button>/.exec(html);
  t.ok(execBtn, "the Execute control is present (gated, not bare)");
  t.ok(execBtn[1], "disabled -- this trade hasn't been accepted yet");
  t.match(html, /Waiting on the recipient&#39;s own accept/);
});

test("ZERO WRITES: loading the queue page never calls anything but a GET on /api/trades/2way/queue -- no MFL import, no other worker route", async () => {
  const { env, mfl } = fresh();
  mfl.st.rosters["0001"] = [flat("14056")];
  mfl.st.rosters["0002"] = [flat("13100")];
  await stageViaHttp(env);
  mfl.st.imports.length = 0; // stageViaHttp itself makes zero MFL imports too (staging), but reset to isolate the page's own load
  const p = loadPage(env, { session: "tok-commish" });
  await settle();
  t.equal(mfl.st.imports.length, 0);
  const paths = new Set(p.calls.map((c) => c.path));
  paths.delete("/api/trades/2way/queue");
  t.equal(paths.size, 0, "the page must never call any route other than the read-only queue endpoint");
});

test("§12.1 COMPLETION STATUS: a not-ready trade shows why (and still offers only a disabled Execute), a ready trade shows the fresh-preview text AND a real, enabled Execute -- and the page still carries its own prominent drop-first-sequencing banner", async () => {
  const { env, mfl } = fresh();
  mfl.st.rosters["0001"] = [flat("14056")];
  mfl.st.rosters["0002"] = [flat("13100")];
  const id = await stageViaHttp(env);
  const p1 = loadPage(env, { session: "tok-commish" });
  await settle();
  t.match(p1.els.trqList.innerHTML, /As of this refresh: waiting on the recipient&#39;s own accept/);
  t.doesNotMatch(p1.els.trqList.innerHTML, /What Execute would send/);
  t.match(p1.els.trqList.innerHTML, /<button type="button" class="trq-exec-btn" disabled>Execute<\/button>/, "disabled -- not yet accepted");

  // Move straight to the ready state via direct SQL -- same technique
  // tests/trade_2way_completion_preview.test.mjs uses, avoiding a race against the real accept
  // flow's own synchronously-started execute2Way call.
  env.UPS_MFL_DB.raw.prepare("UPDATE ups_2way_trades SET status='executing', to_state='accepted', updated_at_utc=? WHERE id=?").run(new Date().toISOString(), id);
  const p2 = loadPage(env, { session: "tok-commish" });
  await settle();
  const html = p2.els.trqList.innerHTML;
  t.match(html, /Compliance clear as of this refresh/);
  t.match(html, /What Execute would send right now:.*0001 gives \[14056\].*0002 gives \[\(nothing\)\]/s);
  t.match(html, /Re-checked fresh at the moment you actually confirm, not assumed from this snapshot/);
  // A real, ENABLED Execute control now appears (Keith's ruling, 2026-09-30) -- never
  // auto-clickable; it only opens the confirm panel, never executes on its own from a page load.
  t.match(html, /<button type="button" class="trq-exec-btn" data-trq-exec-open="[^"]+">Execute…<\/button>/);
  t.equal(mfl.st.imports.length, 0, "zero MFL writes just from loading this ready state -- Execute was never clicked");

  // The page's own sequencing banner is present regardless of any trade's state.
  t.match(HTML, /Required drops confirm FIRST, one at a time, before the trade is ever attempted/);
  t.match(HTML, /does <b>not<\/b> make the trade safe/, "must not overstate the guarantee -- the trade side can still fail after every drop confirms");
  t.match(HTML, /restoration is a manual, race-prone workaround/);
  // Keith's ruling (2026-09-30): the banner must warn that a snapshot goes stale, now that a
  // real action exists that reads it.
  t.match(HTML, /re-derives compliance fresh at that exact moment and fails closed/);
});

test("PER-STEP EXECUTION DETAIL: a drop-first sequence's individual step outcomes (confirmed/failed/unconfirmed) render distinctly in the queue, per Keith's ruling that a failed/uncertain step must remain visible", async () => {
  const { env, mfl } = fresh();
  mfl.st.rosters["0001"] = [flat("14056")];
  mfl.st.rosters["0002"] = [flat("13100")];
  const id = await stageViaHttp(env);
  const now = new Date().toISOString();
  env.UPS_MFL_DB.raw.prepare(
    `INSERT INTO ups_trade_executions (league_id, season, exec_key, kind, state, failed_step, failure_detail, steps_json, created_at_utc, updated_at_utc)
     VALUES ('74598', '2026', ?, 'two_way_staged_drop_first', 'executed_needs_review', 'drop:80001', 'lockout: MFL commissioner lockout on', ?, ?, ?)`
  ).run(id, JSON.stringify({
    "drop:80000": { status: "confirmed", reason: null },
    "drop:80001": { status: "failed", reason: "lockout: MFL commissioner lockout on" },
  }), now, now);
  const p = loadPage(env, { session: "tok-commish" });
  await settle();
  const html = p.els.trqList.innerHTML;
  t.match(html, /drop 80000: ✅ confirmed/);
  t.match(html, /drop 80001: 🛑 failed — lockout: MFL commissioner lockout on/);
});

// ═══════ AGING BANNER (Keith, 2026-09-30): "show the age prominently in the queue." ═══════
test("AGING BANNER: a drop-first sequence stuck past the 30-minute threshold gets a loud, distinct banner and card styling -- not just the generic 48-hour staleness marker", async () => {
  const { env, mfl } = fresh();
  mfl.st.rosters["0001"] = [flat("14056")];
  mfl.st.rosters["0002"] = [flat("13100")];
  const id = await stageViaHttp(env);
  const stuckIso = new Date(Date.now() - 95 * 60000).toISOString(); // 1h 35m
  env.UPS_MFL_DB.raw.prepare(
    `INSERT INTO ups_trade_executions (league_id, season, exec_key, kind, state, failed_step, failure_detail, steps_json, created_at_utc, updated_at_utc)
     VALUES ('74598', '2026', ?, 'two_way_staged_drop_first', 'executed_needs_review', 'drop:80001', 'lockout: MFL commissioner lockout on', ?, ?, ?)`
  ).run(id, JSON.stringify({ "drop:80000": { status: "confirmed", reason: null }, "drop:80001": { status: "failed", reason: "lockout: MFL commissioner lockout on" } }), stuckIso, stuckIso);
  const p = loadPage(env, { session: "tok-commish" });
  await settle();
  const html = p.els.trqList.innerHTML;
  t.match(html, /trq-card-aging/, "the card itself must carry the louder aging style, not just the ledger text");
  t.match(html, /STUCK 1h 35m/, "the age must be stated prominently and match the same threshold/wording as the commissioner DM alert");
  t.match(html, /NEEDS REVIEW/);
  t.match(html, /[Oo]nly the commissioner can resume/);
});

test("AGING BANNER: a drop-first sequence stuck UNDER the threshold gets no banner -- the immediate per-step detail is enough this early", async () => {
  const { env, mfl } = fresh();
  mfl.st.rosters["0001"] = [flat("14056")];
  mfl.st.rosters["0002"] = [flat("13100")];
  const id = await stageViaHttp(env);
  const freshIso = new Date(Date.now() - 5 * 60000).toISOString();
  env.UPS_MFL_DB.raw.prepare(
    `INSERT INTO ups_trade_executions (league_id, season, exec_key, kind, state, failed_step, failure_detail, steps_json, created_at_utc, updated_at_utc)
     VALUES ('74598', '2026', ?, 'two_way_staged_drop_first', 'executed_needs_review', 'drop:80001', 'lockout: MFL commissioner lockout on', ?, ?, ?)`
  ).run(id, JSON.stringify({ "drop:80000": { status: "confirmed", reason: null }, "drop:80001": { status: "failed", reason: "lockout: MFL commissioner lockout on" } }), freshIso, freshIso);
  const p = loadPage(env, { session: "tok-commish" });
  await settle();
  const html = p.els.trqList.innerHTML;
  t.doesNotMatch(html, /trq-card-aging/);
  t.doesNotMatch(html, /STUCK/);
});

await run("trade_review_queue_page");
restoreConsole();
