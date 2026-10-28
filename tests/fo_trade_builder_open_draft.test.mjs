// Front Office trade builder: the public entry point other pages (the Trade finder) use, UPS_FO_TRADE_BUILDER.openDraft(draft, options).
// Contract (also in the header of site/rosters/v2/fo_trade_builder.js): movements in the core's shape, tokens checked against the LOADED
// rosters (unknown ones dropped and reported), a question before replacing a non-empty draft, an editable UNSENT draft labeled
// "Draft from <source> (not sent)", the switch to Trades -> Trade builder, and Send still disabled. The adapter keeps the draft, so a
// re-mounted builder (Trade builder <-> Trade finder) shows the same trade.
//   node tests/fo_trade_builder_open_draft.test.mjs
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeEl, makeContext, tick, verdict, toggle, choose, add, sendButton } from "./fixtures/trade_builder_view_harness.mjs";

const P = (id, name, salary, extra) => ({ id, name, position: "WR", salary, years: 1, type: "Vet-FAA", special: "", isTaxi: false, isIr: false, ...(extra || {}) });
const TEAMS = [
  { fid: "0008", name: "Real Deal Creel", players: [P("101", "Mine, One", 10000), P("102", "Mine, Two", 4000)] },
  { fid: "0010", name: "Long Haulers", players: [P("201", "Theirs, One", 6000)] },
  { fid: "0003", name: "Third Team", players: [P("301", "Third, One", 4000)] },
  { fid: "0004", name: "Fourth Team", players: [P("401", "Fourth, One", 4000)] },
];
const PICKS = { state: "ok", data: { futureDraftPicks: { franchise: [{ id: "0008", futureDraftPick: [{ year: "2027", round: "1", originalPickFor: "0008" }] }] } } };

function page() {
  const { ctx, calls, fireDoc } = makeContext(["site/rosters/v2/fo_trade_builder.js"]);
  const shown = [], modes = [];
  let host = makeEl();
  const mountNow = () => { if (!host.__tbHandle) host.__tbHandle = ctx.UPS_FO_TRADE_BUILDER.mount(host); else host.__tbHandle.refresh(); };
  ctx.UPS_FO = { teams: () => TEAMS, viewerFid: () => "0008", warRoomUrl: () => "", capFor: () => null, capCeiling: 0, capHit: (p) => p.salary, isLoaded: () => false,
    show: (sec) => { shown.push(sec); if (sec === "trades") mountNow(); } };
  ctx.UPS_FO_DATA = { config: () => ({ apiBase: "https://w.test", leagueId: "74598", season: "2026", sessionQuery: (u) => u }), get: (k) => (k === "picks" ? PICKS : null) };
  ctx.UPS_FO_HUB = { asArray: (x) => (Array.isArray(x) ? x : x ? [x] : []), pad4: (x) => String(x).padStart(4, "0"), teamName: (x) => x, playerButton: (a, b, c) => c, openDialog() {}, closeAbout() {} };
  ctx.UPS_FO_TRADES = { _setMode: (m) => modes.push(m) };
  // The preview seam: canned verdicts, and extension facts answered here (so the adapter never reads /trade-workbench).
  ctx.UPS_FO_TRADE_BUILDER_CONFIG = { preview: () => verdict("provisional"), extensionFacts: () => null, debounceMs: 0 };
  fireDoc("fo:ready");
  return { ctx, calls, shown, modes, get host() { return host; }, remount() { host = makeEl(); mountNow(); }, open: (d, o) => JSON.parse(JSON.stringify(ctx.UPS_FO_TRADE_BUILDER.openDraft(d, o))), handle: () => host.__tbHandle };
}
const two = (extra) => ({ source: "Trade finder", movements: [{ from: "0008", to: "0010", tokens: ["P_101", "FP_0008_2027_1"], cap_k: 2 }, { from: "0010", to: "0008", tokens: ["P_201"] }], ...(extra || {}) });
const J = (x) => JSON.parse(JSON.stringify(x));       // values from the vm realm, compared as plain data
const items = (d) => J(d.items.map((i) => `${i.from}>${i.to}:${i.token}`).sort());

test("loads an editable, UNSENT draft labeled with its source, switches to Trades -> Trade builder, Send stays disabled", async () => {
  const pg = page();
  const r = pg.open(two(), { confirm: () => { throw new Error("must not ask: nothing to replace"); } });
  t.deepEqual(r, { ok: true, dropped: [], clamped: [] });
  t.deepEqual(pg.modes, ["builder"], "Trade builder mode"); t.deepEqual(pg.shown, ["trades"], "Trades section");
  const d = pg.handle().draft();
  t.deepEqual(J(d.teams), ["0008", "0010"], "viewer first");
  t.deepEqual(items(d), ["0008>0010:FP_0008_2027_1", "0008>0010:P_101", "0010>0008:P_201"]);
  t.deepEqual(JSON.parse(JSON.stringify(d.capK)), { "0008>0010": 2 }, "cap money carried");
  await tick(); await tick();
  const html = pg.host.innerHTML;
  t.ok(html.includes('<div class="fo-banner info fo-tb-draftlabel" role="status"><b>Draft from Trade finder (not sent)</b></div>'), "labeled, not sent");
  t.ok(/fo-tb-verdict fo-tb-provisional/.test(html), "checked like any draft (read-only preview)");
  t.ok(sendButton(pg.host).disabled, "Send offer still disabled");
  t.ok(!/data-tok=/.test(html), "sections stay closed (the summary says what is in it)");
  t.ok(/2 teams · 2 players · 1 pick · \$2K cap money/.test(html), "Build trade summary");
  toggle(pg.host, 1);
  t.ok(/Remove Mine, One/.test(pg.host.innerHTML), "editable: the loaded players have Remove buttons");
  t.equal(pg.calls.fetch, 0, "no network call from openDraft or the builder here");
});

test("unknown tokens are dropped, reported and named on the page; the rest loads", async () => {
  const pg = page();
  const r = pg.open({ source: "Trade finder", movements: [
    { from: "0008", to: "0010", tokens: ["P_101", "P_999", "X_1", "P_101"] },
    { from: "0010", to: "0008", tokens: ["P_201", "FP_0010_2027_1"] },
    { from: "0008", to: "0099", tokens: ["P_102"] }] });
  t.equal(r.ok, true);
  t.deepEqual(r.dropped, [
    { from: "0008", to: "0010", token: "P_999", reason: "not_on_roster" }, { from: "0008", to: "0010", token: "X_1", reason: "bad_token" },
    { from: "0008", to: "0010", token: "P_101", reason: "duplicate" }, { from: "0010", to: "0008", token: "FP_0010_2027_1", reason: "not_on_roster" },
    { from: "0008", to: "0099", token: "P_102", reason: "bad_team" }]);
  t.deepEqual(items(pg.handle().draft()), ["0008>0010:P_101", "0010>0008:P_201"]);
  t.ok(pg.host.innerHTML.includes("Left out (not on the current rosters): P_999 from Real Deal Creel, X_1 from Real Deal Creel, P_101 from Real Deal Creel, FP_0010_2027_1 from Long Haulers, P_102 from Real Deal Creel."), "named on the page");
});

test("asks before replacing a non-empty draft: declining keeps it exactly; accepting replaces it", async () => {
  const pg = page();
  pg.ctx.UPS_FO.show("trades"); toggle(pg.host, 1); choose(pg.host, 0, "0003"); add(pg.host, "0008", "102"); add(pg.host, "0003", "301"); await tick();
  const mine = JSON.stringify(pg.handle().draft()), asked = [];
  const no = pg.open(two(), { confirm: (q) => { asked.push(q); return false; } });
  t.deepEqual(no, { ok: false, reason: "kept_current", dropped: [], clamped: [] });
  t.deepEqual(asked, ["Replace the trade you are building with the draft from Trade finder?"], "asked once, in plain words");
  t.equal(JSON.stringify(pg.handle().draft()), mine, "declined: the current draft is untouched");
  t.ok(!pg.host.innerHTML.includes("Draft from"), "and not relabeled");
  const yes = pg.open(two(), { confirm: () => true });
  t.equal(yes.ok, true);
  t.deepEqual(items(pg.handle().draft()), ["0008>0010:FP_0008_2027_1", "0008>0010:P_101", "0010>0008:P_201"], "accepted: replaced");
  t.ok(pg.host.innerHTML.includes("Draft from Trade finder (not sent)"));
  // no confirm function and no window.confirm: fail closed (never replace silently)
  const none = pg.open(two({ source: "Somewhere" }));
  t.equal(none.reason, "kept_current", "with no way to ask, the current draft is kept");
});

test("refusals change nothing: not ready, bad shape, viewer not a party, four teams, nothing valid", () => {
  const pg = page();
  t.equal(pg.open(null).reason, "bad_shape"); t.equal(pg.open({ movements: [] }).reason, "bad_shape");
  t.equal(pg.open({ source: "x", movements: [{ from: "0010", to: "0003", tokens: ["P_201"] }] }).reason, "viewer_not_in_trade");
  t.equal(pg.open({ source: "x", movements: [{ from: "0008", to: "0010", tokens: ["P_101"] }, { from: "0003", to: "0004", tokens: ["P_301"] }] }).reason, "too_many_teams");
  const nv = pg.open({ source: "x", movements: [{ from: "0008", to: "0010", tokens: ["P_999"] }] });
  t.deepEqual(nv, { ok: false, reason: "no_valid_assets", dropped: [{ from: "0008", to: "0010", token: "P_999", reason: "not_on_roster" }], clamped: [] });
  t.deepEqual(pg.shown, [], "never switched pages for a refusal");
  const early = page(); early.ctx.UPS_FO.teams = () => [];
  t.equal(early.open(two()).reason, "not_ready", "rosters not loaded yet");
});

test("cap money above the rule's maximum is held to it and reported (core capMoneyMaxK / clampCap)", () => {
  const pg = page();
  const r = pg.open({ source: "Trade finder", movements: [{ from: "0008", to: "0010", tokens: ["P_102"], cap_k: 9 }, { from: "0010", to: "0008", tokens: ["P_201"], cap_k: 1 }] });
  t.deepEqual(r.clamped, [{ from: "0008", to: "0010", asked_k: 9, max_k: 2 }], "half of $4K = $2K");
  t.deepEqual(JSON.parse(JSON.stringify(pg.handle().draft().capK)), { "0008>0010": 2, "0010>0008": 1 });
});

test("three-team draft loads with the viewer first; the adapter keeps it across a re-mount (Trade builder <-> Trade finder)", async () => {
  const pg = page();
  const r = pg.open({ source: "Trade finder", movements: [{ from: "0010", to: "0003", tokens: ["P_201"] }, { from: "0003", to: "0008", tokens: ["P_301"] }, { from: "0008", to: "0010", tokens: ["P_101"] }] });
  t.equal(r.ok, true);
  t.deepEqual(J(pg.handle().draft().teams), ["0008", "0010", "0003"], "viewer first, then in order of appearance");
  await tick();
  const before = JSON.stringify(pg.handle().draft());
  pg.remount(); await tick();
  t.equal(JSON.stringify(pg.handle().draft()), before, "same draft after the builder is mounted again");
  t.ok(pg.host.innerHTML.includes("Draft from Trade finder (not sent)"), "label kept too");
  t.ok(sendButton(pg.host).disabled, "Send still disabled");
});

await run("fo_trade_builder_open_draft");
