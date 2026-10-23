// A draft pick forfeited as a lineup penalty is SHOWN greyed out in every War
// Room offer builder, with its label, and can never be added to an offer.
//   node tests/trade_forfeited_pick_view.test.mjs
//
// Keith 2026-10-12 ("Build it" on the Rulings Desk): grey the pick out with a
// "Forfeited — lineup penalty" label rather than hiding it, on desktop, mobile
// and three-team trades. Display only — the Send/Accept/Execute guard
// (checkForfeitedPicks, tests/lineup_forfeits.test.mjs) stays the authority.
//
// Worker: real SQLite with the real migrations; /api/franchise-assets through
// the REAL worker fetch handler with MFL stubbed. Clients: the REAL mobile
// view (site/m/views/trade.js) in a vm with a small fake DOM, and the REAL
// desktop functions extracted by name from site/trades/trade_workbench.js.
import fs from "node:fs";
import vm from "node:vm";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeD1, applyMigrations } from "./fixtures/d1_sqlite.mjs";
await import("./fixtures/register_md_loader.mjs");
const F = await import("../worker/src/lineup_forfeits.js");
const worker = (await import("../worker/src/index.js")).default;

const SEASON = 2026, L = "74598";
const LINEUP = ["0129_lineup_compliance.sql", "0149_lineup_sat_announce_log.sql", "0171_lineup_rulings.sql", "0172_lineup_pick_reservation_state.sql"];
function db() { const d = makeD1({}); applyMigrations(d, LINEUP); return d; }
function reserve(d, { holder, week = 6, year, round, orig, state = "reserved", options = null, released = false }) {
  d.raw.prepare(`INSERT INTO ups_lineup_pick_reservations (season, league_id, holder_fid, week, pick_year, pick_round, original_owner, ownership_basis, reserved_at_utc, state, options_json, released_at_utc)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'mfl_future_picks', 'x', ?, ?, ?)`).run(SEASON, L, holder, week, year, round, orig || holder, state, options ? JSON.stringify(options) : null, released ? "y" : null);
}
const FORFEITED = "Forfeited — lineup penalty", ON_HOLD = "On hold — lineup penalty";
const UNVERIFIED = "Pick restrictions could not be verified. The server will recheck before this trade can be sent.";

// ═══════════════════════════════ worker ═══════════════════════════════
test("marks reserved, obligation and traded-away picks 'Forfeited', needs-selection candidates 'On hold', in either token order", async () => {
  const d = db(); const env = { UPS_MFL_DB: d };
  reserve(d, { holder: "0004", year: 2027, round: 4 });
  reserve(d, { holder: "0002", year: 2027, round: 2, state: "obligation" });
  reserve(d, { holder: "0011", year: 2027, round: 3, state: "traded_away" });
  reserve(d, { holder: "0001", year: 2027, round: 1, state: "needs_selection", options: [{ year: 2027, round: 1, original_owner: "0007" }, { year: 2027, round: 1, original_owner: "0009" }] });
  reserve(d, { holder: "0003", year: 2027, round: 3, state: "secured" });
  reserve(d, { holder: "0005", year: 2027, round: 5, released: true });
  const picks = [
    { asset_id: "FP_2027_4_0004" }, { asset_id: "FP_0002_2027_2" }, { asset_id: "FP_2027_3_0011" },
    { asset_id: "FP_2027_1_0007" }, { asset_id: "FP_2027_1_0009" },
    { asset_id: "FP_2027_3_0003" }, { asset_id: "FP_2027_5_0005" }, { asset_id: "FP_2027_4_0001" }, { asset_id: "DP_2026_1_3" },
  ];
  const r = await F.markForfeitedPicks(env, L, picks, (p) => p.asset_id);
  t.deepEqual(r, { ok: true, marked: 5 });
  t.deepEqual(picks.slice(0, 3).map((p) => [p.forfeited, p.forfeit_state, p.forfeit_label]), Array(3).fill([true, "forfeited", FORFEITED]));
  t.deepEqual(picks.slice(3, 5).map((p) => [p.forfeited, p.forfeit_state, p.forfeit_label]), Array(2).fill([true, "on_hold", ON_HOLD]), "both candidates held until Keith chooses");
  for (const p of picks.slice(5)) t.equal(p.forfeited, undefined, `${p.asset_id} untouched (secured / released / other pick / current-year)`);
});

test("a cached copy's stale marks are cleared; unreadable reservations mark nothing and say so", async () => {
  const d = db(); const env = { UPS_MFL_DB: d };
  const stale = [{ asset_id: "FP_0004_2027_4", forfeited: true, forfeit_state: "forfeited", forfeit_label: FORFEITED }];
  t.deepEqual(await F.markForfeitedPicks(env, L, stale, (p) => p.asset_id), { ok: true, marked: 0 });
  t.equal(stale[0].forfeited, undefined, "released since the cache was written → no longer greyed");
  const broken = { UPS_MFL_DB: { prepare() { throw new Error("D1_ERROR: boom"); } } };
  const picks = [{ asset_id: "FP_0004_2027_4" }];
  t.deepEqual(await F.markForfeitedPicks(broken, L, picks, (p) => p.asset_id), { ok: false, marked: 0 });
  t.equal(picks[0].forfeited, undefined);
  t.equal((await F.checkForfeitedPicks(broken, L, ["FP_0004_2027_4"])).http, 503, "…while Send/Accept still fail closed");
  let reads = 0;
  const counting = { UPS_MFL_DB: { prepare() { reads += 1; throw new Error("no"); } } };
  t.deepEqual(await F.markForfeitedPicks(counting, L, [{ asset_id: "DP_2026_1_3" }, { asset_id: "P_123" }], (p) => p.asset_id), { ok: true, marked: 0 });
  t.equal(reads, 0, "no future pick → no database read");
});

// /api/franchise-assets through the REAL worker handler, MFL stubbed.
const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
function stubMfl() {
  globalThis.fetch = async (input) => {
    const u = String(input && input.url || input);
    if (u.includes("TYPE=futureDraftPicks")) return json({ futureDraftPicks: { franchise: [
      { id: "0004", futureDraftPick: [{ year: "2027", round: "1", originalPickFor: "0004" }, { year: "2027", round: "4", originalPickFor: "0004" }, { year: "2027", round: "4", originalPickFor: "0007" }] },
      { id: "0007", futureDraftPick: [{ year: "2027", round: "2", originalPickFor: "0007" }] },
    ] } });
    if (u.includes("TYPE=rosters")) return json({ rosters: { franchise: { id: "0004", player: [] } } });
    if (u.includes("TYPE=draftResults")) return json({ draftResults: { draftUnit: { draftPick: [] } } });
    if (u.includes("TYPE=players")) return json({ players: { player: [] } });
    if (u.includes("TYPE=league")) return json({ league: { franchises: { franchise: [{ id: "0004", name: "Pure Greatness" }, { id: "0007", name: "Sex Manther" }] } } });
    throw new Error("unexpected fetch " + u);
  };
}
async function assets(env, fid) {
  const res = await worker.fetch(new Request(`https://w.test/api/franchise-assets?L=${L}&YEAR=${SEASON}&fid=${fid}`), env, { waitUntil() {}, passThroughOnException() {} });
  return { status: res.status, body: JSON.parse(await res.text()) };
}

test("/api/franchise-assets: the forfeited pick is listed AND flagged; the team's other picks are not", async () => {
  stubMfl();
  const d = db();
  reserve(d, { holder: "0004", year: 2027, round: 4 });     // own 2027 4th (own pick first)
  const { status, body } = await assets({ UPS_MFL_DB: d }, "0004");
  t.equal(status, 200); t.equal(body.forfeit_check, "ok");
  t.deepEqual(body.future_picks.map((p) => [p.asset_id, !!p.forfeited, p.forfeit_label || ""]), [
    ["FP_2027_1_0004", false, ""],
    ["FP_2027_4_0004", true, FORFEITED],
    ["FP_2027_4_0007", false, ""],
  ], "listed, not hidden; the acquired 4th stays tradeable");
});

test("/api/franchise-assets: reservations unreadable → picks still listed, unflagged, forfeit_check 'unavailable'", async () => {
  stubMfl();
  const broken = { UPS_MFL_DB: { prepare() { throw new Error("D1_ERROR: boom"); } } };
  const { status, body } = await assets(broken, "0004");
  t.equal(status, 200); t.equal(body.forfeit_check, "unavailable");
  t.equal(body.future_picks.length, 3); t.ok(body.future_picks.every((p) => !p.forfeited));
});

// ═════════════════════ mobile: the REAL site/m/views/trade.js ═════════════════════
const MOBILE_SRC = fs.readFileSync(new URL("../site/m/views/trade.js", import.meta.url), "utf8");

// Just enough DOM: innerHTML strings, class-selector queries over them, and
// elements whose listeners can be fired with `this` bound (a disabled button
// is fired too — the view's own guard is what's under test).
function fakeEl(tag, attrs) {
  const listeners = {};
  const cls = new Set(String((attrs && attrs.class) || "").split(/\s+/).filter(Boolean));
  const el = {
    tag, attrs: attrs || {}, style: {}, textContent: "", value: "", inserted: [],
    disabled: !!(attrs && "disabled" in attrs),
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) },
    getAttribute: (a) => (el.attrs[a] == null ? null : el.attrs[a]),
    addEventListener: (type, fn) => (listeners[type] = listeners[type] || []).push(fn),
    fire: (type) => (listeners[type] || []).forEach((fn) => fn.call(el, { preventDefault() {} })),
    insertAdjacentHTML: (pos, html) => el.inserted.push(html),
    remove() {}, focus() {},
    querySelector: () => null,
    parentNode: null,
  };
  el.parentNode = { querySelector: () => null, querySelectorAll: () => [], insertAdjacentHTML() {} };
  let html = "", parsed = null;
  Object.defineProperty(el, "innerHTML", { get: () => html, set: (v) => { html = String(v); parsed = null; } });
  el.querySelectorAll = (sel) => {
    const want = /^\.([\w-]+)$/.exec(sel);
    if (!want) return [];
    if (!parsed) {
      parsed = [];
      for (const m of html.matchAll(/<(button|div|input|a)\b([^>]*)>/g)) {
        const a = {};
        for (const x of m[2].matchAll(/([a-zA-Z0-9-]+)(?:="([^"]*)")?/g)) a[x[1]] = x[2] == null ? "" : x[2];
        parsed.push(fakeEl(m[1], a));
      }
    }
    return parsed.filter((e) => e.classList.contains(want[1]));
  };
  return el;
}

const FR = [{ id: "0008", name: "Real Deal Creel" }, { id: "0004", name: "Pure Greatness" }, { id: "0007", name: "Sex Manther" }];
const INV = {
  "0008": { forfeit_check: "ok", players: [], future_picks: [{ asset_id: "FP_2027_2_0008", display: "2027 R2", year: "2027", round: "2", original_fid: "0008" }] },
  "0004": { forfeit_check: "ok", players: [], future_picks: [
    { asset_id: "FP_2027_1_0004", display: "2027 R1", year: "2027", round: "1", original_fid: "0004" },
    { asset_id: "FP_2027_4_0004", display: "2027 R4", year: "2027", round: "4", original_fid: "0004", forfeited: true, forfeit_state: "forfeited", forfeit_label: FORFEITED },
  ] },
  "0007": { forfeit_check: "ok", players: [], future_picks: [
    { asset_id: "FP_2027_3_0007", display: "2027 R3", year: "2027", round: "3", original_fid: "0007", forfeited: true, forfeit_state: "on_hold", forfeit_label: ON_HOLD },
  ] },
};
const settle = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

function loadMobile({ check } = {}) {
  const els = {};
  const document = {
    getElementById: (id) => (/overlay$/.test(id) ? null : (els[id] = els[id] || fakeEl("div", { id }))),
    body: { style: {} },
  };
  const calls = [];
  const fetch = async (u) => {
    const url = new URL(String(u));
    calls.push(url.pathname + url.search);
    if (url.pathname === "/api/franchise-assets") {
      const inv = JSON.parse(JSON.stringify(INV[url.searchParams.get("fid")]));
      if (check !== undefined) { if (check === null) delete inv.forfeit_check; else inv.forfeit_check = check; }
      return { ok: true, status: 200, json: async () => inv, text: async () => JSON.stringify(inv) };
    }
    return { ok: false, status: 404, json: async () => null, text: async () => "" };
  };
  const U = {
    pad4: (v) => { const d = String(v || "").replace(/\D/g, ""); return d ? d.padStart(4, "0").slice(-4) : ""; },
    safeStr: (v) => (v == null ? "" : String(v).trim()), safeInt: (v, d) => { const n = parseInt(v, 10); return isFinite(n) ? n : (d == null ? 0 : d); },
    escapeHtml: (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
    fmtUsd: (n) => "$" + n,
  };
  const M = {
    util: U, data: {}, actions: {},
    api: { workerUrl: (p) => "https://worker.test" + p, getStoredMflUserId: () => "tok-A" },
    state: { ctx: { leagueId: L, year: String(SEASON) }, viewerFranchiseId: "0008", franchises: FR, tradeOffers: { incoming: [], outgoing: [] } },
    ui: { showToast() {} }, route: { renderRoute() {}, navigate() {} },
  };
  const sandbox = { fetch, console, setTimeout, Promise, URL, encodeURIComponent, decodeURIComponent, isFinite, parseInt, String, Number, JSON, Object, Array, Date, Math, document };
  sandbox.window = sandbox; sandbox.UPS_MOBILE = M; sandbox.UPS_TRADE_3WAY = {};
  vm.createContext(sandbox);
  vm.runInContext(MOBILE_SRC, sandbox, { filename: "site/m/views/trade.js" });
  return { M, els, calls };
}
const btnFor = (body, token) => body.querySelectorAll(".ups-m-tb-asset").find((b) => (b.getAttribute("data-id") || b.getAttribute("data-token")) === token);

test("mobile 2-team: the forfeited pick shows greyed with its label, disabled; tapping it selects nothing", async () => {
  const { M, els } = loadMobile();
  M.tradeView.openBuilder({ toFid: "0004" });
  await settle();
  const body = els["ups-m-tb-body"];
  t.match(body.innerHTML, /class="ups-m-tb-asset is-forfeited" disabled aria-disabled="true" data-id="FP_0004_2027_4"/);
  t.match(body.innerHTML, /<span class="nm">2027 R4<\/span><span class="mt">Forfeited — lineup penalty<\/span>/);
  const locked = btnFor(body, "FP_0004_2027_4"), open = btnFor(body, "FP_0004_2027_1");
  t.equal(locked.disabled, true); t.equal(open.disabled, false);
  locked.fire("click");
  t.equal(locked.classList.contains("on"), false); t.equal((els["ups-m-tb-cnt"] || {}).textContent || "", "", "count untouched");
  open.fire("click");
  t.equal(open.classList.contains("on"), true); t.equal(els["ups-m-tb-cnt"].textContent, "1 selected", "an ordinary pick still selects");
  t.equal(body.innerHTML.includes(UNVERIFIED), false, "verified list → no warning");
});

test("mobile: forfeit list unreadable (or not confirmed) → the warning sits above the picks; picks stay selectable, server rechecks", async () => {
  for (const check of ["unavailable", null]) {
    const { M, els } = loadMobile({ check });
    M.tradeView.openBuilder({ toFid: "0004" });
    await settle();
    const body = els["ups-m-tb-body"];
    t.match(body.innerHTML, new RegExp('<div class="ups-m-tb-subhead">Future picks</div><div class="ups-m-tb-warn ups-m-tb-pickwarn" role="status">' + UNVERIFIED.replace(/\./g, "\\.") + "</div>"), String(check));
    const open = btnFor(body, "FP_0004_2027_1");
    t.equal(open.disabled, false);
    open.fire("click");
    t.equal(open.classList.contains("on"), true, "still selectable — the worker refuses a forfeited pick at Send");
  }
  const three = loadMobile({ check: "unavailable" });
  three.M.tradeView.open3WayBuilder();
  const b3 = three.els["ups-m-3w-body"];
  b3.querySelectorAll(".ups-m-tb-frow").find((b) => b.getAttribute("data-fid") === "0004").fire("click");
  b3.querySelectorAll(".ups-m-tb-frow").find((b) => b.getAttribute("data-fid") === "0007").fire("click");
  await settle();
  t.equal(b3.innerHTML.split(UNVERIFIED).length - 1, 3, "one warning per team with future picks (3-team)");
});

test("mobile 3-team: forfeited and on-hold picks show greyed with their labels and can't be given", async () => {
  const { M, els } = loadMobile();
  M.tradeView.open3WayBuilder();
  const body = els["ups-m-3w-body"];
  body.querySelectorAll(".ups-m-tb-frow").find((b) => b.getAttribute("data-fid") === "0004").fire("click");
  body.querySelectorAll(".ups-m-tb-frow").find((b) => b.getAttribute("data-fid") === "0007").fire("click");
  await settle();
  t.match(body.innerHTML, /class="ups-m-tb-asset is-forfeited" disabled aria-disabled="true" data-giver="0004" data-token="FP_0004_2027_4"/);
  t.match(body.innerHTML, /data-token="FP_0007_2027_3"><span class="nm">2027 R3<\/span><span class="mt">On hold — lineup penalty<\/span>/);
  const locked = btnFor(body, "FP_0004_2027_4");
  locked.fire("click");
  t.equal(locked.classList.contains("on"), false); t.equal(locked.inserted.length, 0, "no destination chooser opened");
  const open = btnFor(body, "FP_0004_2027_1");
  open.fire("click");
  t.equal(open.classList.contains("on"), true, "an ordinary pick still selects");
});

// ═════════════════ desktop: the REAL trade_workbench.js functions ═════════════════
const DESK = fs.readFileSync(new URL("../site/trades/trade_workbench.js", import.meta.url), "utf8");
function fn(name) {
  const start = DESK.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in trade_workbench.js`);
  let i = DESK.indexOf("{", start), depth = 0;
  for (; i < DESK.length; i += 1) { if (DESK[i] === "{") depth += 1; else if (DESK[i] === "}" && --depth === 0) break; }
  return DESK.slice(start, i + 1);
}
const dctx = { Object, Math, String, JSON, Array };
vm.createContext(dctx);
vm.runInContext([
  "function safeStr(v){ return String(v == null ? '' : v).trim(); }",
  "function safeInt(v, d){ var n = parseInt(v, 10); return isFinite(n) ? n : (d || 0); }",
  "function pad4(v){ var d = String(v || '').replace(/\\D/g, ''); return d ? ('0000' + d).slice(-4) : ''; }",
  "function resolvePickMeta(a){ return { round: a.pick_round, year: a.pick_season, token: '' }; }",
  "function hasTradeTagDeadlinePassed(){ return false; }",
  "function getFranchiseNameById(f){ return ({ '0004': 'Pure Greatness', '0007': 'Sex Manther' })[f] || ''; }",
  "function ordinalSuffix(n){ return n + (['th','st','nd','rd'][n] || 'th'); }",
  "function livePickLabel(a){ return a.description || ''; }",
  "var TEAM = null; function getTeamById(){ return TEAM; } function getAssetView(){ return 'picks'; } function assetMatchesFilters(){ return true; }",
  "var tw3 = { give: {}, aFid: '0004' }; function tw3DestChooserHtml(){ return '<chooser>'; } function tw3ExtControlHtml(){ return ''; } function tw3NameOf(f){ return 'Team ' + f; }",
  "var state = { data: { meta: { pick_restrictions_verified: true } } };",
  "var PICK_RESTRICTIONS_UNVERIFIED = " + JSON.stringify(UNVERIFIED) + ";",
  ...["isForfeitedPick", "isUntradeableSixthRoundPick", "isTradeEligibleAsset", "isTaggedTradeIneligibleAsset", "getTradeIneligibleReason",
      "escapeHtml", "getVisibleAssetsForTeam", "tw3PickToken", "tw3IsTradeable", "tw3TeamAssets", "tw3AssetName", "tw3AssetMeta", "tw3AssetRowHtml",
      "pickRestrictionsVerified", "hasFuturePick", "tw3ColumnHtml"].map(fn),
].join("\n"), dctx);

const fp = (round, extra) => ({ type: "PICK", asset_id: `pick:FP_0004_2027_${round}`, pick_key: `FP_0004_2027_${round}`, pick_season: 2027, pick_round: round, original_owner_fid: "0004", franchise_id: "0004", ...(extra || {}) });
const locked = fp(4, { forfeited: true, forfeit_label: FORFEITED });

test("desktop: a forfeited pick is ineligible, shows its label, and is LISTED (greyed) — 6th-round picks stay hidden as before", () => {
  t.equal(dctx.isTradeEligibleAsset(locked), false);
  t.equal(dctx.getTradeIneligibleReason(locked), FORFEITED);
  t.equal(dctx.getTradeIneligibleReason(fp(4, { forfeited: true })), FORFEITED, "default label");
  t.equal(dctx.isTradeEligibleAsset(fp(1)), true);
  dctx.TEAM = { assets: [fp(1), locked, fp(6)] };
  vm.runInContext("TEAM = this.TEAM;", dctx);
  t.deepEqual(Array.from(dctx.getVisibleAssetsForTeam("0004"), (a) => a.pick_key), ["FP_0004_2027_1", "FP_0004_2027_4"]);
});

test("desktop 3-team: the forfeited pick renders as a disabled button with its label and no destination chooser", () => {
  t.deepEqual(Array.from(dctx.tw3TeamAssets("0004"), (a) => a.pick_key), ["FP_0004_2027_1", "FP_0004_2027_4"]);
  vm.runInContext("tw3.give['0004'] = { 'pick:FP_0004_2027_4': '0007' };", dctx);   // even if somehow selected
  const html = dctx.tw3AssetRowHtml("0004", locked);
  t.match(html, /class="twb-3w-asset is-forfeited" disabled aria-disabled="true"/);
  t.match(html, /<span class="nm">Pure Greatness&#39;s 2027 4th<\/span><span class="mt">Forfeited — lineup penalty<\/span>/);
  t.doesNotMatch(html, /<chooser>/);
  t.doesNotMatch(dctx.tw3AssetRowHtml("0004", fp(1)), /is-forfeited|disabled/);
});

test("desktop: restrictions not confirmed by the worker → warning in the 3-team column and team panel; confirmed → none", () => {
  vm.runInContext("state.data.meta.pick_restrictions_verified = false;", dctx);
  t.match(dctx.tw3ColumnHtml("a"), new RegExp('<div class="twb-pick-unverified" role="status">' + UNVERIFIED.replace(/\./g, "\\.") + "</div>"));
  vm.runInContext("state.data.meta.pick_restrictions_verified = true;", dctx);
  t.doesNotMatch(dctx.tw3ColumnHtml("a"), /twb-pick-unverified/);
  t.match(fn("normalizeData"), /pick_restrictions_verified: !!\(raw\.meta && raw\.meta\.forfeit_marks && raw\.meta\.forfeit_marks\.ok === true\)/, "only an explicit ok from the worker counts as verified");
  t.match(fn("renderTeamPanel"), /if \(!pickRestrictionsVerified\(\) && hasFuturePick\(visibleAssets\)\) groupsWrap\.appendChild\(pickRestrictionsWarningEl\(\)\);/);
  t.match(fn("renderDiscoveryPanel"), /if \(!pickRestrictionsVerified\(\) && hasFuturePick\(/);
  t.equal(dctx.hasFuturePick([{ type: "PICK", pick_key: "DP_2026_1_3" }]), false, "current-year picks alone don't trigger it");
});

test("desktop wiring: flag kept by normalizeAsset; checkbox can't add it; 3-way click, discovery list and CSS all handle it", () => {
  t.match(fn("normalizeAsset"), /asset\.forfeited = raw\.forfeited === true;/);
  t.match(fn("renderAssetRow"), /cb\.disabled = !eligible && !selected;/);
  t.match(fn("renderAssetRow"), /if \(isForfeitedPick\(asset\)\) tr\.className \+= " twb-row-forfeited";/);
  t.match(fn("toggleAsset"), /if \(!isTradeEligibleAsset\(asset\)\) return;/);
  t.match(DESK, /if \(this\.disabled \|\| this\.classList\.contains\("is-forfeited"\)\) return;\n\s+var giver = this\.getAttribute\("data-3w-giver"\)/);
  t.match(fn("collectDiscoverableMatches"), /!isTradeEligibleAsset\(a\) && !isForfeitedPick\(a\)/);
  t.match(fn("renderDiscoveryPanel"), /btn\.disabled = true;/);
  const css = fs.readFileSync(new URL("../site/trades/trade_workbench.css", import.meta.url), "utf8");
  const html = fs.readFileSync(new URL("../site/trades/trade_workbench.html", import.meta.url), "utf8");
  for (const src of [css, html]) {
    t.match(src, /\.twb-row-forfeited td \{ opacity: 0\.55; \}/);
    t.match(src, /\.twb-3w-asset\.is-forfeited,\n\.twb-discovery-item\.is-forfeited \{ opacity: 0\.55; cursor: not-allowed;/);
  }
  t.match(html, /\.\/trade_workbench\.js\?v=20261023a/);
});

// ═════════════════ Rookie Draft Hub trade window ═════════════════
test("Rookie Draft Hub: the forfeited row is greyed, labelled, and its click adds nothing", () => {
  const src = fs.readFileSync(new URL("../site/rookies/rookie_draft_hub.js", import.meta.url), "utf8");
  t.match(src, /const forfeited = it\.forfeited === true;/);
  t.match(src, /\$\{forfeited \? `<span style="text-decoration:line-through;">\$\{escapeHtml\(it\.display\)\}<\/span>` : escapeHtml\(it\.display\)\}/, "struck through, like desktop and phone");
  t.match(src, /\$\{forfeited \? " is-forfeited" : ""\}"\$\{forfeited \? ' aria-disabled="true"' : ""\}/);
  t.match(src, /row\.addEventListener\("click", \(\) => \{\n\s+if \(row\.classList\.contains\("is-forfeited"\)\) return;/);
  t.match(src, /const pickWarn = \(\(data\.future_picks \|\| \[\]\)\.length && data\.forfeit_check !== "ok"\)/, "warning unless the worker confirmed the forfeit list");
  t.ok(src.includes(UNVERIFIED));
  t.match(fs.readFileSync(new URL("../site/rookies/rookie_draft_hub.html", import.meta.url), "utf8"), /rookie_draft_hub\.js\?v=2026\.10\.12\.3/);
});

await run("trade_forfeited_pick_view");
