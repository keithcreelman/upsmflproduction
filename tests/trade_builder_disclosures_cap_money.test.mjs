// Front Office trade builder view (site/shared/trade_builder_view.js), Keith's phone review of #1419:
//  - three disclosures (1 Build trade · 2 Cap & contracts · 3 Lineup impact): real buttons with aria-expanded, ALL CLOSED at first,
//    each with a one-line summary; opening or closing one never erases or resets the draft (it lives outside the markup);
//  - cap money: explicit − / + buttons (accessible names, disabled at $0 and at the rule's maximum), typed entry held to the same
//    maximum (core capMoneyMaxK / clampCap, unchanged), and a plain "A → B: $3K" line for every direction / destination.
//   node tests/trade_builder_disclosures_cap_money.test.mjs
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeEl, makeContext, tick, verdict, toggle, expanded, choose, add, step, stepBtn, capInput, type, dest, sendButton } from "./fixtures/trade_builder_view_harness.mjs";

const TEAMS = [{ fid: "0008", name: "Real Deal Creel" }, { fid: "0010", name: "Long Haulers" }, { fid: "0003", name: "Third Team" }];
// Cap money maximum = half the NON-TAXI player salary sent, whole $K rounded down: 10,000 -> 5, 6,000 -> 3, 4,000 -> 2.
const ASSETS = {
  "0008": { players: [{ id: "101", name: "Mine, One", pos: "WR", salary: 10000, years: 1, type: "Vet-FAA" }, { id: "102", name: "Mine, Two", pos: "RB", salary: 2000, years: 1, type: "Vet-FAA" }], picks: [{ token: "FP_0008_2027_1", label: "2027 1st" }] },
  "0010": { players: [{ id: "201", name: "Theirs, One", pos: "RB", salary: 6000, years: 2, type: "Rookie-Draft" }], picks: [] },
  "0003": { players: [{ id: "301", name: "Third, One", pos: "TE", salary: 4000, years: 1, type: "Vet-FAA" }], picks: [] },
};
const R = (over, loadedOver) => ({ r: { overCap: !!over, loadedOver: !!loadedOver, before: { space: 1000, alloc: 0, active: 0, loaded: 1 }, after: { space: 0, alloc: 0, active: 0, loaded: 1 }, ceiling: 0, loadedMax: 5, loadedKnown: true } });
function harness({ impact } = {}) {
  const { ctx, calls } = makeContext();
  const el = makeEl(), seen = { preview: 0, drafts: [] };
  const handle = ctx.UPS_TRADE_BUILDER_VIEW.mount(el, {
    teams: TEAMS, ctx: { leagueId: "74598", season: "2026", viewerFid: "0008" },
    assets: (fid) => ASSETS[fid] || { players: [], picks: [] },
    impact: impact || (() => ({ cap: null, lineup: { state: "off", message: "Lineup impact is off in this test." }, ext: [] })),
    preview: () => { seen.preview++; return verdict("provisional"); },
    onDraft: (d, meta) => seen.drafts.push({ d: JSON.parse(JSON.stringify(d)), meta }),
    debounceMs: 0,
  });
  return { ctx, el, handle, calls, seen, cap: () => JSON.parse(JSON.stringify(handle.draft().capK)) };
}
const summaryOf = (el, n) => { const m = new RegExp(`data-disc="${n}"[\\s\\S]*?<span class="fo-tb-dsum">([^<]*)</span>`).exec(el.innerHTML); return m && m[1].replace(/&amp;/g, "&"); };
async function twoTeam(h) { toggle(h.el, 1); choose(h.el, 0, "0010"); add(h.el, "0008", "101"); add(h.el, "0010", "201"); await tick(); await tick(); }

test("all three disclosures start CLOSED, as real buttons, each with a useful summary", () => {
  const h = harness();
  for (const n of [1, 2, 3]) {
    const b = h.el.node(new RegExp(`<button[^>]*data-disc="${n}"[^>]*>`));
    t.ok(b && /^<button type="button"/.test(b.tag), n + ": a real button");
    t.equal(b.getAttribute("aria-expanded"), "false", n + ": closed");
    t.equal(b.getAttribute("aria-controls"), "fo-tb-p" + n, n + ": controls its panel");
    t.ok(h.el.innerHTML.includes(`id="fo-tb-p${n}" hidden>`), n + ": panel hidden");
  }
  t.ok(/<span class="fo-tb-dnum" aria-hidden="true">1<\/span><span class="fo-tb-dtext"><span class="fo-tb-dtitle">Build trade/.test(h.el.innerHTML), "1 Build trade");
  t.ok(h.el.innerHTML.includes('<span class="fo-tb-dtitle">Cap &amp; contracts</span>') && h.el.innerHTML.includes('<span class="fo-tb-dtitle">Lineup impact</span>'), "2 Cap & contracts, 3 Lineup impact");
  t.equal(summaryOf(h.el, 1), "Choose a team to start"); t.equal(summaryOf(h.el, 2), "Add players or picks to see the cap effect"); t.equal(summaryOf(h.el, 3), "Add players to see the lineup change");
  t.ok(!/data-tok=/.test(h.el.innerHTML), "closed panels render no controls");
  t.ok(/fo-tb-verdict fo-tb-none/.test(h.el.innerHTML) && sendButton(h.el).disabled, "the Review (validation + disabled Send) is visible with everything closed");
});

test("summaries once a trade is built: teams/players/picks/money, cap status, lineup change", async () => {
  const impact = (d) => ({ cap: { "0008": R(false), "0010": R(false) }, loadedMoving: 1, ext: [],
    lineup: { state: "ok", basis: "", teams: { "0008": { delta: 1.8, before: 0, after: 0, players: [], depth: [], slots: [] }, "0010": { delta: -0.6, before: 0, after: 0, players: [], depth: [], slots: [] } } } });
  const h = harness({ impact });
  await twoTeam(h);
  h.el.fire("click", h.el.node(/<button[^>]*data-tok="FP_0008_2027_1" data-from="0008"[^>]*>/));
  step(h.el, 1, "0008", "0010"); step(h.el, 1, "0008", "0010"); step(h.el, 1, "0008", "0010"); await tick();
  t.equal(summaryOf(h.el, 1), "2 teams · 2 players · 1 pick · $3K cap money");
  t.equal(summaryOf(h.el, 2), "Cap OK · $3K money · 1 loaded contract");
  t.equal(summaryOf(h.el, 3), "+1.8 pts/wk for you · −0.6 pts/wk for Long Haulers");
});

test("opening and closing sections never erases or resets the draft (and never re-asks the server)", async () => {
  const h = harness();
  await twoTeam(h);
  step(h.el, 1, "0008", "0010"); step(h.el, 1, "0010", "0008"); await tick();
  const before = JSON.stringify(h.handle.draft()), previews = h.seen.preview, phase = h.handle.state().phase;
  for (const n of [1, 2, 3, 2, 1, 3, 1, 1, 2, 3]) toggle(h.el, n);
  await tick();
  t.equal(JSON.stringify(h.handle.draft()), before, "the draft is identical");
  t.equal(h.seen.preview, previews, "no new server check"); t.equal(h.handle.state().phase, phase, "verdict state unchanged");
  t.ok(expanded(h.el, 1) && expanded(h.el, 2) && expanded(h.el, 3), "each section remembers open / closed (all open after that sequence)");
  toggle(h.el, 2); t.ok(expanded(h.el, 1) && !expanded(h.el, 2) && expanded(h.el, 3), "closing 2 leaves 1 and 3 open");
  t.equal(JSON.stringify(h.handle.draft()), before, "still identical");
  t.ok(/Real Deal Creel → Long Haulers: \$1K/.test(h.el.innerHTML), "re-opened Build shows the same cap money");
});

test("two-team cap money: − / + in BOTH directions, plain direction lines, disabled at $0 and at the maximum", async () => {
  const h = harness();
  await twoTeam(h);
  const html = () => h.el.innerHTML;
  t.ok(html().includes("Real Deal Creel → Long Haulers: $0K") && html().includes("Long Haulers → Real Deal Creel: $0K"), "both directions are shown");
  const dec = stepBtn(h.el, -1, "0008", "0010"), inc = stepBtn(h.el, 1, "0008", "0010");
  t.equal(dec.getAttribute("aria-label"), "Decrease cap money Real Deal Creel sends to Long Haulers"); t.equal(inc.getAttribute("aria-label"), "Increase cap money Real Deal Creel sends to Long Haulers");
  t.ok(dec.disabled && !inc.disabled, "at $0: − disabled, + enabled");
  for (let i = 0; i < 5; i++) step(h.el, 1, "0008", "0010");
  t.equal(h.cap()["0008>0010"], 5, "+ five times = $5K (the maximum: half of $10K)");
  t.ok(stepBtn(h.el, 1, "0008", "0010").disabled && !stepBtn(h.el, -1, "0008", "0010").disabled, "at the maximum: + disabled");
  step(h.el, 1, "0008", "0010");
  t.equal(h.cap()["0008>0010"], 5, "a press on the disabled + changes nothing");
  t.ok(html().includes("Real Deal Creel → Long Haulers: $5K") && /up to \$5K/.test(html()), "line reads $5K, up to $5K");
  step(h.el, -1, "0008", "0010"); step(h.el, -1, "0008", "0010");
  t.equal(h.cap()["0008>0010"], 3, "− twice = $3K");
  // the other direction, in the other team's panel
  t.equal(stepBtn(h.el, 1, "0010", "0008").getAttribute("aria-label"), "Increase cap money Long Haulers sends to Real Deal Creel");
  for (let i = 0; i < 4; i++) step(h.el, 1, "0010", "0008");
  t.equal(h.cap()["0010>0008"], 3, "Long Haulers can send at most $3K (half of $6K)");
  t.ok(stepBtn(h.el, 1, "0010", "0008").disabled, "+ disabled at its maximum");
  for (let i = 0; i < 4; i++) step(h.el, -1, "0010", "0008");
  t.equal(h.cap()["0010>0008"], undefined, "back to $0");
  t.ok(stepBtn(h.el, -1, "0010", "0008").disabled, "− disabled at $0");
  t.ok(capInput(h.el, "0008", "0010").getAttribute("aria-label").startsWith("Cap money Real Deal Creel sends to Long Haulers"), "the amount box is named too");
  t.ok(/\.fo-tb \.fo-tb-step \{ flex: 0 0 44px; min-width: 44px; min-height: 44px;/.test((await import("./fixtures/trade_builder_view_harness.mjs")).read("site/rosters/v2/front_office.css")), "44px targets");
});

test("typed entry still works and is held to the same maximum (and never below $0)", async () => {
  const h = harness();
  await twoTeam(h);
  type(h.el, "0008", "0010", 4); t.equal(h.cap()["0008>0010"], 4, "typed 4");
  type(h.el, "0008", "0010", 99); t.equal(h.cap()["0008>0010"], 5, "typed 99 -> held to $5K");
  t.ok(h.el.innerHTML.includes("Held to the most this team can include."), "and says so");
  type(h.el, "0008", "0010", "2.7"); t.equal(h.cap()["0008>0010"], 2, "typed 2.7 -> whole $K, rounded down");
  type(h.el, "0008", "0010", -4); t.equal(h.cap()["0008>0010"], undefined, "typed −4 -> $0");
  // removing the salaried player lowers the maximum and the amount follows it
  type(h.el, "0008", "0010", 5); h.el.fire("click", h.el.node(/<button[^>]*data-tok="P_101" data-from="0008" aria-label="Remove[^>]*>/));
  t.equal(h.cap()["0008>0010"], undefined, "no salary sent -> no cap money");
  t.ok(stepBtn(h.el, 1, "0008", "0010").disabled && capInput(h.el, "0008", "0010").disabled, "+ and the box are disabled with nothing to base money on");
});

test("three-team: one line and one − / + pair for EACH destination, each held to its own movement's maximum", async () => {
  const h = harness();
  toggle(h.el, 1); choose(h.el, 0, "0010"); choose(h.el, 1, "0003");
  add(h.el, "0008", "101"); add(h.el, "0010", "201"); add(h.el, "0003", "301");   // ring: 0008 -> 0010 -> 0003 -> 0008
  await tick();
  for (const [f, to] of [["0008", "0010"], ["0008", "0003"], ["0010", "0003"], ["0010", "0008"], ["0003", "0008"], ["0003", "0010"]]) t.ok(stepBtn(h.el, 1, f, to) && stepBtn(h.el, -1, f, to), `${f} → ${to} has its own − / +`);
  t.ok(h.el.innerHTML.includes("Real Deal Creel → Long Haulers: $0K") && h.el.innerHTML.includes("Real Deal Creel → Third Team: $0K"), "both destinations named");
  t.equal(stepBtn(h.el, -1, "0008", "0003").getAttribute("aria-label"), "Decrease cap money Real Deal Creel sends to Third Team");
  for (let i = 0; i < 9; i++) step(h.el, 1, "0008", "0010");
  t.equal(h.cap()["0008>0010"], 5, "to Long Haulers: up to $5K (what goes there)");
  t.ok(stepBtn(h.el, 1, "0008", "0003").disabled && capInput(h.el, "0008", "0003").disabled, "to Third Team: nothing sent there, so no money");
  // send Mine, One to Third Team instead: the money to Long Haulers is held to its new maximum ($0)
  dest(h.el, "0008", "101", "0003"); await tick();
  t.equal(h.cap()["0008>0010"], undefined, "money to Long Haulers dropped when no salary goes there");
  for (let i = 0; i < 2; i++) step(h.el, 1, "0008", "0003");
  t.equal(h.cap()["0008>0003"], 2, "money to Third Team steps up");
});

await run("trade_builder_disclosures_cap_money");
