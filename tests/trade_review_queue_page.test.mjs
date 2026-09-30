// The commissioner Trade Review Queue page (site/commish/trade_review_queue.html) -- a
// READ-ONLY hold/review surface (Keith's ruling, 2026-09-29: "do not add a drop or trade
// execution button yet"). Runs the page's REAL inline script in a vm sandbox against a fake
// DOM, with fetch() bridged to the real worker + real D1 + a stateful fake MFL, mirroring the
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

test("NO EXECUTE/DROP AFFORDANCE: nothing in the rendered page, for any trade or state, offers to execute a trade or drop a player", async () => {
  const { env, mfl } = fresh();
  mfl.st.rosters["0001"] = [flat("14056")];
  mfl.st.rosters["0002"] = [flat("13100")];
  await stageViaHttp(env);
  const p = loadPage(env, { session: "tok-commish" });
  await settle();
  const html = p.els.trqList.innerHTML;
  t.doesNotMatch(html, /data-t3w-act="select-drops"/, "the drop picker's own confirm button must never appear on this read-only page -- renderCompliance is called with no viewerFid, so its interactive picker never renders");
  t.doesNotMatch(html, /<button[^>]*>\s*[Ee]xecute/, "no button anywhere offers to execute a trade");
  t.doesNotMatch(html, /<button[^>]*>\s*(Drop this player|Confirm drop)/i, "no button anywhere offers to drop a player");
  // Every actionable element on the page is exactly the read-only toggle -- nothing else.
  const buttonActs = [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1].trim());
  for (const label of buttonActs) t.match(label, /^(Show full compliance|Hide detail)/, `unexpected button on a read-only page: "${label}"`);
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

test("§12.1 COMPLETION STATUS: a not-ready trade shows why, a ready trade shows the dry-run preview -- both purely descriptive text, no action anywhere -- and the page carries its own prominent 'cannot be completed yet' banner", async () => {
  const { env, mfl } = fresh();
  mfl.st.rosters["0001"] = [flat("14056")];
  mfl.st.rosters["0002"] = [flat("13100")];
  const id = await stageViaHttp(env);
  const p1 = loadPage(env, { session: "tok-commish" });
  await settle();
  t.match(p1.els.trqList.innerHTML, /Not ready to complete — waiting on the recipient/);
  t.doesNotMatch(p1.els.trqList.innerHTML, /Would send to MFL/);

  // Move straight to the ready state via direct SQL -- same technique
  // tests/trade_2way_completion_preview.test.mjs uses, avoiding a race against the real accept
  // flow's own synchronously-started execute2Way call.
  env.UPS_MFL_DB.raw.prepare("UPDATE ups_2way_trades SET status='executing', to_state='accepted', updated_at_utc=? WHERE id=?").run(new Date().toISOString(), id);
  const p2 = loadPage(env, { session: "tok-commish" });
  await settle();
  const html = p2.els.trqList.innerHTML;
  t.match(html, /Compliance clear — completion unavailable/, "must not say 'ready to complete' -- compliance passing is not the same fact as being executable");
  t.doesNotMatch(html, /Ready to complete/i, "no wording anywhere may imply this trade can be executed right now");
  t.match(html, /Dry-run preview only, if this were completed today:.*0001 gives \[14056\].*0002 gives \[\(nothing\)\].*Would send to MFL/s);
  t.match(html, /Nothing here executes anything, and there is no completion action anywhere in this app yet/);
  // Still no button anywhere, and zero MFL writes just from loading this ready state.
  const buttonActs = [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1].trim());
  for (const label of buttonActs) t.match(label, /^(Show full compliance|Hide detail)/);
  t.equal(mfl.st.imports.length, 0);

  // The page's own blocker banner is present regardless of any trade's state.
  t.match(HTML, /A staged trade cannot be completed yet/);
  // Keith's ruling (2026-09-29): the banner itself must not say "ready to complete" either --
  // it must state plainly that neither write order can guarantee both "never exceeds five" and
  // "nothing lost if the other half fails."
  t.doesNotMatch(HTML, /is <b>ready to complete<\/b>/);
  // Keith's ruling (2026-09-29, sequence): drop-first is decided, not left open or per-deal.
  t.match(HTML, /Sequence is decided \(Keith's ruling, 2026-09-29\): required drops confirm FIRST/);
  t.match(HTML, /does <b>not<\/b> make the trade safe/, "must not overstate the guarantee -- the trade side can still fail after every drop confirms");
  t.match(HTML, /restoration is a manual, race-prone workaround/);
  t.doesNotMatch(HTML, /Neither write order is decided/);
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
