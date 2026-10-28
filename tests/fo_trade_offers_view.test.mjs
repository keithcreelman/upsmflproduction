// Front Office → Trades → Offers (site/rosters/v2/fo_trade_offers.js), behind the off-by-default write flag (#1338, 2026-10-28).
//   FLAG OFF: no lifecycle script is downloaded, no request is made, no Offers view exists, sendDraft refuses; the builder's Send
//   offer stays exactly as #1419 built it (tests/trade_builder_view_send_disabled.test.mjs is unchanged and still passes).
//   FLAG ON (mocked transport only): the inbox reads, the acting team is shown, Revoke / Decline / Accept (preview first) /
//   Counter (create → see → decline) run through the lifecycle with the War Room's bodies, outcomes are shown, and a trade that
//   moved players triggers the after-trade refresh and one batch of re-reads.
//   node tests/fo_trade_offers_view.test.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const settle = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

const player = (pid, name) => ({ asset_id: "player:" + pid, type: "PLAYER", player_id: pid, player_name: name, position: "WR", nfl_team: "TST", salary: 5000, years: 1, contract_type: "Vet-FAA", contract_info: "CL 1|TCV 5K|AAV 5K|Y1-5K" });
const RAW = (lockout) => ({ ok: true, league_id: "74598", season: 2026, meta: { league_id: "74598", season: 2026, commissioner_lockout: lockout }, teams: [
  { franchise_id: "0001", franchise_name: "Alpha", assets: [player("14056", "One, Player")] }, { franchise_id: "0002", franchise_name: "Bravo", assets: [player("13100", "Two, Player")] },
  { franchise_id: "0000", franchise_name: "Commish", assets: [] }] });
const IN = { status: "PENDING", mfl_present: true, id: "2001", trade_id: "2001", from_franchise_id: "0002", to_franchise_id: "0001", will_give_up: "13100,", will_receive: "14056,", comments: "hi" };
const OUT = { status: "PENDING", mfl_present: true, id: "2002", trade_id: "2002", from_franchise_id: "0001", to_franchise_id: "0002", will_give_up: "14056,", will_receive: "13100," };
const R = (status, body) => ({ status, ok: status >= 200 && status < 300, body });

function page({ cfg, viewer = "0001", admin = false, lockout = "Y", answer } = {}) {
  const calls = { fetch: 0, scripts: 0, reqs: [], dialogs: [], reloads: 0, refreshes: 0, opened: [] };
  const docListeners = {};
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, Promise, JSON, Math, Object, Array, String, Number, Boolean, RegExp, Error, Date, parseInt, isFinite, encodeURIComponent, decodeURIComponent, URL, Uint8Array, crypto: globalThis.crypto });
  ctx.window = ctx; ctx.self = ctx;
  ctx.location = { hash: "" }; ctx.window.location = ctx.location;
  ctx.addEventListener = () => {};
  ctx.document = { currentScript: { src: "https://site.test/upsmflproduction/rosters/v2/fo_trade_offers.js?v=2026.10.28.22" }, head: { appendChild: () => {} },
    createElement: (tag) => { if (tag === "script") calls.scripts++; return {}; }, getElementById: () => null, querySelector: () => null,
    addEventListener: (k, f) => { (docListeners[k] = docListeners[k] || []).push(f); } };
  calls.fetchUrls = [];
  ctx.fetch = (u) => { calls.fetch++; calls.fetchUrls.push(String(u)); return Promise.reject(new Error("no network in this test")); };
  ctx.confirm = () => true;
  if (cfg) ctx.UPS_FO_TRADE_LIFECYCLE_CONFIG = Object.assign({}, cfg, cfg.FO_TRADE_BUILDER_SEND === true ? { transport: async (req) => { calls.reqs.push({ method: req.method, path: new URL(req.url).pathname, url: req.url, body: req.body ? JSON.parse(req.body) : null }); return answer(req); } } : {});
  ctx.UPS_FO = { viewerFid: () => viewer, isAdmin: () => admin, teams: () => [{ fid: "0001", name: "Alpha" }, { fid: "0002", name: "Bravo" }], warRoomUrl: () => "https://war.room/", show: () => {}, reloadAfterTrade: async () => { calls.reloads++; } };
  ctx.UPS_FO_DATA = { config: () => ({ apiBase: "https://worker.test", leagueId: "74598", season: "2026", sessionQuery: (u) => u + "&MFL_USER_ID=tok" }), refresh: async () => { calls.refreshes++; } };
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  ctx.UPS_FO_HUB = { esc, banner: (x, k) => '<div class="fo-banner ' + (k || "") + '">' + esc(x) + "</div>", clock: () => "12:00", teamName: (f) => ({ "0001": "Alpha", "0002": "Bravo" })[f] || f,
    openDialog: (title, html) => { calls.dialogs.push({ title, html }); }, closeAbout: () => {} };
  ctx.UPS_FO_TRADE_BUILDER = { openDraft: (d) => { calls.opened.push(d); return { ok: true, dropped: [], clamped: [] }; } };
  if (cfg && cfg.FO_TRADE_BUILDER_SEND === true) {   // in the browser fo_trade_offers.js downloads these itself; here they are preloaded
    for (const f of ["site/shared/trade_rules.js", "site/shared/trade_3way_view.js", "site/shared/war_room_requests.js", "site/shared/trade_offer_lifecycle.js"]) vm.runInContext(read(f), ctx, { filename: f });
  }
  vm.runInContext(read("site/rosters/v2/fo_trade_offers.js"), ctx, { filename: "fo_trade_offers.js" });
  (docListeners["fo:ready"] || []).forEach((f) => f());
  // A host element: records innerHTML and listeners; a click builds its target from a rendered tag's own attributes.
  const ls = {};
  const el = { innerHTML: "", isConnected: true, addEventListener: (k, f) => { (ls[k] = ls[k] || []).push(f); }, querySelector: (s) => (s === ".fo-to" && el.innerHTML.includes('class="fo-card fo-to"') ? { contains: () => true } : null) };
  const press = async (act, id) => {
    const re = new RegExp('<button[^>]*data-to-act="' + act + '"' + (id ? '[^>]*data-id="' + id + '"' : "") + "[^>]*>");
    const m = re.exec(el.innerHTML); if (!m) throw new Error("no " + act + " button rendered");
    const attrs = {}; for (const a of m[0].matchAll(/([a-zA-Z0-9-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    const node = { getAttribute: (a) => attrs[a] ?? null, hasAttribute: (a) => a in attrs }; node.closest = () => node;
    (ls.click || []).forEach((f) => f({ target: node })); await settle();
  };
  const dialog = async (k) => { const O = ctx.UPS_FO_TRADE_OFFERS; const node = { getAttribute: () => k }; node.closest = () => node; await O._dialogAction(node); await settle(); };
  return { ctx, calls, el, press, dialog, O: ctx.UPS_FO_TRADE_OFFERS };
}
const world = (lockout = "Y", extra = {}) => (req) => {
  const p = new URL(req.url).pathname;
  if (req.method === "GET" && p === "/trade-workbench") return R(200, RAW(lockout));
  if (req.method === "GET" && p === "/trade-offers") return extra.inbox ? extra.inbox(req) : R(200, { ok: true, outgoing: [OUT], incoming: [IN] });
  if (req.method === "GET" && p === "/api/trades/2way") return R(200, { ok: true, trades: [] });
  if (req.method === "GET" && p === "/api/trades/3way") return R(200, { ok: true, trades: [] });
  if (extra[req.method + " " + p]) return extra[req.method + " " + p](req);
  return R(500, { ok: false, error: "unscripted " + req.method + " " + p });
};

test("FLAG OFF: nothing downloaded, nothing requested, no Offers view, sendDraft refuses", async () => {
  for (const cfg of [undefined, { FO_TRADE_BUILDER_SEND: false }, { FO_TRADE_BUILDER_SEND: "true" }]) {
    const P = page({ cfg });
    await settle();
    t.equal(P.O.enabled(), false);
    t.equal(P.calls.scripts, 0, "no lifecycle script injected");
    const r = await P.O.sendDraft({ teams: ["0001", "0002"], items: [] }, "");
    t.equal(r.code, "flag_off");
    t.equal(P.O.openLink("#fo=trades&offer=mfl%3A2001"), false, "a deep link does nothing");
    t.equal(P.calls.fetch, 0, "zero requests");
  }
  const trades = read("site/rosters/v2/fo_trades.js");
  t.match(trades, /function modes\(\) \{ return offersOn\(\) \? MODES\.concat\(\[\["offers", "Offers"\]\]\) : MODES; \}/, "the Offers chip exists only when the flag is on");
  t.match(trades, /if \(mode === "offers" && !offersOn\(\)\) mode = "builder";/);
  t.match(trades, /if \(row && !!row\.querySelector\('\[data-tf-mode="offers"\]'\) !== offersOn\(\)\) row\.outerHTML = modeChips\(\);/, "a builder painted before the flag's code loaded gets the Offers chip without a re-mount");
  t.ok(!/__tbSender|TB\.mount\(host\); return;/.test(trades), "the builder is never mounted a second time when the code arrives (no remount race)");
  const html = read("site/rosters/v2/front_office.html");
  t.ok(!/war_room_requests\.js|trade_offer_lifecycle\.js/.test(html), "the lifecycle code is not in the page; it is fetched only with the flag on");
  t.ok(!/FO_TRADE_BUILDER_SEND/.test(html + read("site/rosters/fo_embed_loader.js") + read("site/rosters/v2/front_office.js")), "no production page or loader defines the flag");
});

test("FLAG ON (mocked): inbox renders received and sent offers with the acting team; SIMULATED label when simulated", async () => {
  const P = page({ cfg: { FO_TRADE_BUILDER_SEND: true, simulated: true }, answer: world() });
  P.O.render(P.el, "<chips/>"); await settle();
  const h = P.el.innerHTML;
  t.match(h, /SIMULATED/); t.match(h, /Acting as <b>Alpha<\/b>/);
  t.match(h, /data-to-act="review" data-id="2001"/); t.match(h, /data-to-act="revoke" data-id="2002"/);
  t.match(h, /<b>Bravo<\/b> gives Two, Player/);
  t.match(h, /Trade War Room ↗/, "the War Room link stays");
  t.ok(!/Act for <select/.test(h), "no acting picker for an owner");
  t.deepEqual(P.calls.reqs.map((r) => r.method), ["GET", "GET", "GET", "GET"], "reads only");
  t.deepEqual(P.calls.fetchUrls, ["../player_acquisition_lookup_2026.json"], "only the War Room's static acquisition file is fetched; every worker read went through the mocked transport");
});

test("commissioner: the acting picker appears only with lockout N; acting is shown and used", async () => {
  let P = page({ cfg: { FO_TRADE_BUILDER_SEND: true }, viewer: "0000", admin: true, answer: world("Y") });
  P.O.render(P.el, ""); await settle();
  t.ok(!/Act for <select/.test(P.el.innerHTML)); t.match(P.el.innerHTML, /commissioner lockout is on/);
  P = page({ cfg: { FO_TRADE_BUILDER_SEND: true }, viewer: "0000", admin: true, answer: world("N") });
  P.O.render(P.el, ""); await settle();
  t.match(P.el.innerHTML, /Act for <select data-to-acting>/);
  (P.ctx.UPS_FO_TRADE_OFFERS._state).acting = "0001";
  P.O.render(P.el, ""); await settle();
  t.match(P.el.innerHTML, /Acting as <b>Alpha<\/b> \(commissioner acting for this team\)/);
});

test("Revoke (sender): confirm, then the War Room's REVOKE body; the outcome is shown and the lists re-read", async () => {
  const P = page({ cfg: { FO_TRADE_BUILDER_SEND: true }, answer: world("Y", { "POST /trade-offers/action": () => R(200, { ok: true }) }) });
  P.O.render(P.el, ""); await settle();
  await P.press("revoke", "2002");
  const post = P.calls.reqs.find((r) => r.method === "POST");
  t.equal(post.body.action, "REVOKE"); t.equal(post.body.trade_id, "2002"); t.equal(post.body.acting_franchise_id, "0001");
  t.match(P.el.innerHTML, /Offer revoked in MFL\./);
});

test("Accept: the server preview first, Accept only when it allows; an executed trade refreshes and re-reads once", async () => {
  const P = page({ cfg: { FO_TRADE_BUILDER_SEND: true }, answer: world("Y", {
    "POST /trade-offers/action": (req) => { const b = JSON.parse(req.body); return b.action === "PREVIEW" ? R(200, { ok: true, compliance: { cap: { status: "ok" }, loaded_contracts: { status: "ok", executable: true } } }) : R(200, { ok: true, trade_id: "2001", salary_adjustments: { ok: true, rows: [] }, extensions: { ok: true, applied: [] } }); },
    "POST /refresh/after-trade": () => R(200, { ok: true }) }) });
  P.O.render(P.el, ""); await settle();
  await P.press("review", "2001");
  t.equal(P.calls.dialogs.length, 1); t.match(P.calls.dialogs[0].html, /data-to-dlg="accept"/);
  await P.dialog("accept"); await settle(20);
  const posts = P.calls.reqs.filter((r) => r.method === "POST").map((r) => r.body.action || r.path);
  t.deepEqual(posts, ["PREVIEW", "ACCEPT", "/refresh/after-trade"]);
  t.match(P.el.innerHTML, /Trade executed in MFL \(Trade ID 2001\)\./);
  t.equal(P.calls.reloads, 1, "rosters/cap re-read once"); t.ok(P.calls.refreshes >= 1, "picks re-read");
});

test("Decline: the note goes in the War Room's REJECT body (≤ 2,000)", async () => {
  const P = page({ cfg: { FO_TRADE_BUILDER_SEND: true }, answer: world("Y", { "POST /trade-offers/action": () => R(200, { ok: true }) }) });
  P.O.render(P.el, ""); await settle();
  await P.press("decline", "2001");
  t.match(P.calls.dialogs[0].html, /maxlength="2000"/);
  P.ctx.document.querySelector = (s) => (s === "[data-to-decline-note]" ? { value: "pass" } : null);
  await P.dialog("decline");
  const post = P.calls.reqs.find((r) => r.method === "POST");
  t.equal(post.body.action, "REJECT"); t.equal(post.body.message, "pass");
  t.match(P.el.innerHTML, /Offer declined in MFL\./);
});

test("Counter: loads the turned-around offer into the builder; sending runs create → see → decline; a failed decline offers one recovery", async () => {
  let declines = 0;
  const seen = { status: "PENDING", mfl_present: true, id: "3001", trade_id: "3001", from_franchise_id: "0001", to_franchise_id: "0002", will_give_up: "14056,", will_receive: "13100," };
  let sentYet = false;
  const P = page({ cfg: { FO_TRADE_BUILDER_SEND: true }, answer: world("Y", {
    inbox: () => R(200, { ok: true, outgoing: sentYet ? [seen] : [OUT], incoming: [IN] }),
    "POST /trade-offers": () => { sentYet = true; return R(200, { ok: true, mfl: { trade_id: "3001" } }); },
    "POST /trade-offers/action": () => { declines++; return declines === 1 ? R(503, { ok: false, code: "unavailable" }) : R(200, { ok: true }); } }) });
  P.O.render(P.el, ""); await settle();
  await P.press("counter", "2001");
  t.equal(P.calls.opened.length, 1);
  t.deepEqual(JSON.parse(JSON.stringify(P.calls.opened[0].movements)), [{ from: "0002", to: "0001", tokens: ["P_13100"], cap_k: 0 }, { from: "0001", to: "0002", tokens: ["P_14056"], cap_k: 0 }]);
  t.match(P.el.innerHTML, /Countering Trade 2001/);
  const r = await P.O.sendDraft({ teams: ["0001", "0002"], items: [{ from: "0001", to: "0002", token: "P_14056" }, { from: "0002", to: "0001", token: "P_13100" }], capK: {}, ext: {} }, "counter");
  await settle();
  t.equal(r.state, "both_open");
  const order = P.calls.reqs.filter((x) => x.method === "POST" || x.path === "/trade-offers").map((x) => x.method + " " + x.path + (x.body && x.body.action ? " " + x.body.action : ""));
  const iCreate = order.indexOf("POST /trade-offers"), iDecline = order.indexOf("POST /trade-offers/action REJECT");
  t.ok(iCreate !== -1 && iDecline > iCreate, "create before decline");
  t.ok(order.slice(iCreate, iDecline).includes("GET /trade-offers"), "the sent list is read between them");
  t.match(P.el.innerHTML, /original offer is still open/); t.match(P.el.innerHTML, /data-to-act="decline-original"/);
  await P.press("decline-original");
  t.equal(declines, 2, "the recovery sent only the decline");
  t.match(P.el.innerHTML, /Counter sent \(Trade ID 3001\)\. The original offer was declined\./);
});

test("an unconfirmed send shows Retry; Retry reads the sent list first and does not resend an offer that arrived", async () => {
  let creates = 0;
  const landed = { status: "PENDING", mfl_present: true, id: "3009", trade_id: "3009", from_franchise_id: "0001", to_franchise_id: "0002", will_give_up: "14056,", will_receive: "13100," };
  const P = page({ cfg: { FO_TRADE_BUILDER_SEND: true }, answer: world("Y", { inbox: () => R(200, { ok: true, outgoing: creates ? [landed] : [], incoming: [] }), "POST /trade-offers": () => { creates++; return { networkError: true }; } }) });
  P.O.render(P.el, ""); await settle();
  const r = await P.O.sendDraft({ teams: ["0001", "0002"], items: [{ from: "0001", to: "0002", token: "P_14056" }, { from: "0002", to: "0001", token: "P_13100" }], capK: {}, ext: {} }, "");
  await settle();
  t.equal(r.state, "unconfirmed"); t.match(P.el.innerHTML, /data-to-act="retry"/);
  await P.press("retry");
  t.equal(creates, 1, "not sent again"); t.match(P.el.innerHTML, /Already reached MFL \(Trade ID 3009\)\. It was not sent again\./);
});

test("signed out: one plain message, nothing sent, the War Room link", async () => {
  const P = page({ cfg: { FO_TRADE_BUILDER_SEND: true }, answer: () => R(401, { ok: false, code: "unauthenticated" }) });
  P.O.render(P.el, ""); await settle();
  t.match(P.el.innerHTML, /Sign in to MFL/); t.match(P.el.innerHTML, /Trade War Room ↗/);
  t.equal(P.calls.reqs.filter((r) => r.method === "POST").length, 0);
});

await run("fo_trade_offers_view");
