// Front Office trade builder view (site/shared/trade_builder_view.js): no numbered step headings, and Send offer is ALWAYS disabled.
// The Front Office has no send connection. Whatever the server's verdict (provisional, needs an acknowledgment, blocked, can't be
// checked) or the trade's state (nothing selected, incomplete), Send offer renders disabled with its plain reason, a click on it
// changes nothing, no confirmation element is ever created, and no send or network call happens. The verdict display is unchanged.
//   node tests/trade_builder_view_send_disabled.test.mjs
import { t, test, run } from "./fixtures/mini_test.mjs";
import { read, makeEl, makeContext, tick, verdict, toggle, choose, add, sendButton } from "./fixtures/trade_builder_view_harness.mjs";
const VIEW = read("site/shared/trade_builder_view.js");

const TEAMS = [{ fid: "0008", name: "Me" }, { fid: "0010", name: "Blake" }, { fid: "0003", name: "Third" }];
const ASSETS = {
  "0008": { players: [{ id: "101", name: "Mine, One", pos: "WR", salary: 5000, years: 1, type: "Vet-FAA" }], picks: [] },
  "0010": { players: [{ id: "201", name: "Theirs, One", pos: "RB", salary: 4000, years: 2, type: "Rookie-Draft" }], picks: [] },
  "0003": { players: [{ id: "301", name: "Third, One", pos: "TE", salary: 3000, years: 1, type: "Vet-FAA" }], picks: [] },
};
function harness(answer) {
  const { ctx, calls: net } = makeContext();
  const calls = { preview: 0, send: 0, dialog: 0, get fetch() { return net.fetch; } };
  const el = makeEl();
  const handle = ctx.UPS_TRADE_BUILDER_VIEW.mount(el, {
    teams: TEAMS, ctx: { leagueId: "74598", season: "2026", viewerFid: "0008" },
    assets: (fid) => ASSETS[fid] || { players: [], picks: [] },
    impact: () => ({ cap: null, lineup: { state: "off", message: "Lineup impact is off in this test." }, ext: [] }),
    preview: () => { calls.preview++; return answer; },
    // Even an injected send (and the old notice option) must be ignored: the view has no send path at all.
    send: () => { calls.send++; return { ok: true, message: "sent" }; }, sendNotice: "ignored",
    openDialog: () => { calls.dialog++; }, closeDialog() {},
    warRoomUrl: "https://example.test/war-room", debounceMs: 0,
  });
  toggle(el, 1);                                   // "1 Build trade" starts closed: open it to pick teams and add players
  return { ctx, el, handle, calls };
}
async function build(h, kind) {
  if (kind === "none") return;
  choose(h.el, 0, "0010");
  if (kind === "three") choose(h.el, 1, "0003");        // a ring: Me → Blake → Third → Me, so every team sends and receives
  add(h.el, "0008", "101");
  if (kind === "incomplete") { await tick(); return; }
  add(h.el, "0010", "201");
  if (kind === "three") add(h.el, "0003", "301");
  await tick(); await tick();
}

function assertSendOff(h, label) {
  const html = h.el.innerHTML, b = sendButton(h.el);
  t.ok(b, label + ": Send offer is rendered");
  t.ok(b.disabled, label + ": Send offer has the disabled attribute");
  t.equal(b.getAttribute("aria-disabled"), "true", label + ": aria-disabled");
  t.ok(/class="btn fo-tb-send"/.test(b.tag), label + ": disabled styling class");
  t.ok(html.includes('id="fo-tb-send-off">Sending from the Front Office is not available yet.</span>'), label + ": the plain reason is shown beside it");
  t.equal(b.getAttribute("aria-describedby"), "fo-tb-send-off", label + ": the reason is the button's description");
  t.ok(html.includes("Trade War Room"), label + ": the Trade War Room link stays");
}
function assertNoConfirm(html, label) {
  t.ok(!/alertdialog|fo-tb-confirm|confirm-send|cancel-send|Yes, send/.test(html), label + ": no confirmation element");
  t.ok(!/Nothing was sent|Sending…/.test(html), label + ": no send result message");
}
// Round 1 removed the old stepper and the "Trade proposal / Trade impact / Review and send" stage headings; round 2 (Keith's phone review)
// asked for three numbered DISCLOSURES instead (1 Build trade · 2 Cap & contracts · 3 Lineup impact). The old ones must stay gone.
function assertNoOldHeadings(html, label) {
  t.ok(!/fo-tb-steps|fo-tb-stagehead|data-jump/.test(html), label + ": no old stepper or stage head");
  t.ok(!/<h[1-6][^>]*>\s*(?:\d\s*)?(Trade proposal|Trade impact|Review and send)\s*<\/h[1-6]>/.test(html) && !/>(Trade proposal|Review and send)</.test(html), label + ": no Trade proposal / Trade impact / Review and send heading");
  for (const [n, name] of [[1, "Build trade"], [2, "Cap & contracts"], [3, "Lineup impact"]]) t.ok(html.includes(`id="fo-tb-s${n}" aria-label="${name.replace("&", "&amp;")}"`), label + ": " + name + " region keeps an accessible name");
  t.ok(html.includes('id="fo-tb-review" aria-label="Review"'), label + ": the Review region is named");
  t.ok(!/aria-labelledby="fo-tb-h\d"/.test(html), label + ": no pointer to a removed heading id");
}

const CASES = [
  { name: "provisional (Looks fine so far)", answer: verdict("provisional"), state: "provisional", favorable: true },
  { name: "needs_acknowledgment", answer: verdict("needs_acknowledgment", [{ code: "roster_over_max", message: "Over the roster maximum." }]), state: "needs_ack", favorable: true },
  { name: "blocked", answer: verdict("blocked", [{ code: "cap_over", message: "Over the cap." }]), state: "blocked" },
  { name: "unavailable (verdict status)", answer: verdict("unavailable"), state: "unavailable" },
  { name: "unavailable (no answer)", answer: null, state: "unavailable" },
];

for (const c of CASES) {
  test(`${c.name}: Send offer disabled, click opens nothing, no send, verdict shown as before`, async () => {
    const h = harness(c.answer);
    await build(h, "two");
    const html = h.el.innerHTML;
    t.ok(html.includes(`fo-tb-verdict fo-tb-${c.state}"`), "verdict display reads " + c.state);
    if (c.favorable) {
      // The core still calls this state favorable (the old code enabled Send here); the view must ignore that.
      const C = h.ctx.UPS_TRADE_BUILDER_CORE, r = C.readiness([], "done", c.answer, { blocked: [], ack: [] });
      t.ok(r.canAttempt, "the core rates it favorable");
    }
    assertSendOff(h, c.name); assertNoConfirm(html, c.name); assertNoOldHeadings(html, c.name);
    const before = h.el.innerHTML, previews = h.calls.preview;
    h.el.fire("click", sendButton(h.el));         // even a click that reaches the handler (a disabled button never fires one) does nothing
    await tick();
    t.equal(h.el.innerHTML, before, "the page is unchanged after the click");
    assertNoConfirm(h.el.innerHTML, c.name + " after click");
    t.equal(h.calls.send, 0, "no send"); t.equal(h.calls.fetch, 0, "no network"); t.equal(h.calls.preview, previews, "no extra check");
    t.equal(h.calls.dialog, 0, "no dialog opened");
    t.ok(!("sent" in h.handle.state()), "the view keeps no send state");
  });
}

test("none and incomplete: Send offer disabled with the same reason; click does nothing", async () => {
  for (const kind of ["none", "incomplete"]) {
    const h = harness(verdict("provisional"));
    await build(h, kind);
    const html = h.el.innerHTML;
    t.ok(html.includes(`fo-tb-verdict fo-tb-${kind}"`), kind + " verdict display");
    t.equal(h.calls.preview, 0, kind + ": an unfinished trade is never checked");
    assertSendOff(h, kind); assertNoConfirm(html, kind); assertNoOldHeadings(html, kind);
    h.el.fire("click", sendButton(h.el)); await tick();
    t.equal(h.el.innerHTML, html, kind + ": unchanged after the click");
    t.equal(h.calls.send + h.calls.fetch, 0, kind + ": no send, no network");
  }
});

test("three-team favorable trade: still disabled, still no confirmation", async () => {
  const h = harness(verdict("provisional"));
  await build(h, "three");
  t.ok(h.el.innerHTML.includes('fo-tb-teams fo-tb-n3'), "three team panels");
  t.ok(h.el.innerHTML.includes('fo-tb-verdict fo-tb-provisional"'), "favorable verdict");
  assertSendOff(h, "three-team"); assertNoOldHeadings(h.el.innerHTML, "three-team");
  const before = h.el.innerHTML; h.el.fire("click", sendButton(h.el)); await tick();
  t.equal(h.el.innerHTML, before, "unchanged after the click"); assertNoConfirm(h.el.innerHTML, "three-team");
  t.equal(h.calls.send + h.calls.fetch, 0, "no send, no network");
});

// The offer lifecycle (2026-10-28, Keith's ruling 4) adds ONE switch: `sender` with enabled === true, which the Front Office passes only
// behind its off-by-default write flag (FO_TRADE_BUILDER_SEND, defined by no production config). Without it the Review card is #1419's.
test("source: no confirmation, no send plan, no network; the only switch is sender.enabled === true, passed only behind the write flag", () => {
  t.ok(!/confirm-send|cancel-send|alertdialog|st\.confirm|st\.sent/.test(VIEW), "no confirmation markup or state");
  t.ok(!/opt\.send\b|sendPlan|sendNotice/.test(VIEW), "the view never reads a send option or builds a send plan");
  t.equal((VIEW.match(/closest\("\[data-go\]"\)/g) || []).length, 1, "one data-go reader…");
  t.ok(/data-go="send" disabled aria-disabled="true"/.test(VIEW), "without the sender the button is written disabled, with no condition");
  t.ok(/var SENDER = opt\.sender && opt\.sender\.enabled === true && typeof opt\.sender\.send === "function" \? opt\.sender : null;/.test(VIEW), "the one switch");
  t.ok(/var go = SENDER && e\.target\.closest/.test(VIEW), "the send click is read only when that switch is on");
  t.ok(!/\bfetch\(/.test(VIEW), "the view makes no network call");
  const AD = read("site/rosters/v2/fo_trade_builder.js");
  t.ok(!/sendNotice/.test(AD), "no send notice");
  t.ok(/sender: O && O\.flagOn\(\) \?/.test(AD), "the adapter passes a sender only when the write flag is on");
  t.ok(/flagOn\(\) \{ return cfg\(\)\.FO_TRADE_BUILDER_SEND === true; \}/.test(read("site/rosters/v2/fo_trade_offers.js")), "flagOn is exactly the config flag");
  t.ok(!/FO_TRADE_BUILDER_SEND/.test(read("site/rosters/v2/front_office.js") + read("site/rosters/fo_embed_loader.js") + read("site/rosters/v2/front_office.html")), "no production file defines the flag");
});

test("sender present but not exactly enabled: still #1419's disabled Send, no send", async () => {
  for (const sender of [{ enabled: false, send: () => {} }, { enabled: "true", send: () => {} }, { enabled: 1, send: () => {} }, { send: () => {} }]) {
    const { ctx } = makeContext(); const el = makeEl(); let n = 0; sender.send = () => { n++; };
    ctx.UPS_TRADE_BUILDER_VIEW.mount(el, { teams: TEAMS, ctx: { leagueId: "74598", season: "2026", viewerFid: "0008" }, assets: (fid) => ASSETS[fid] || { players: [], picks: [] },
      impact: () => ({ cap: null, lineup: { state: "off", message: "off" }, ext: [] }), preview: () => verdict("provisional"), openDialog() {}, closeDialog() {}, warRoomUrl: "https://example.test/war-room", debounceMs: 0, sender });
    const h = { el, calls: { send: 0, fetch: 0 } };
    toggle(el, 1); await build(h, "two");
    assertSendOff(h, "sender " + JSON.stringify(sender.enabled)); h.el.fire("click", sendButton(h.el)); await tick();
    t.equal(n, 0, "no send");
  }
});

test("behind the write flag (sender.enabled === true): Send enables on a favorable check, sends once, shows the outcome; 2,000-character note", async () => {
  const { ctx } = makeContext(); const el = makeEl(); const sent = [];
  ctx.UPS_TRADE_BUILDER_VIEW.mount(el, { teams: TEAMS, ctx: { leagueId: "74598", season: "2026", viewerFid: "0008" }, assets: (fid) => ASSETS[fid] || { players: [], picks: [] },
    impact: () => ({ cap: null, lineup: { state: "off", message: "off" }, ext: [] }), preview: () => verdict("provisional"), openDialog() {}, closeDialog() {}, warRoomUrl: "https://example.test/war-room", debounceMs: 0,
    sender: { enabled: true, noteLimit: (n) => (n === 3 ? 500 : 2000), send: (d, note) => { sent.push({ d, note }); return Promise.resolve({ state: "sent", message: "Offer sent to MFL (Trade ID 9001).", done: true }); } } });
  const h = { el, calls: {} };
  toggle(el, 1);
  t.ok(sendButton(el).disabled, "disabled while nothing is built");
  await build(h, "two");
  t.ok(el.innerHTML.includes('maxlength="2000"'), "2,000 for a direct two-team offer");
  const b = sendButton(el); t.ok(!b.disabled, "enabled on a favorable check");
  h.el.fire("click", b); await tick(); await tick();
  t.equal(sent.length, 1, "one send"); t.equal(sent[0].d.items.length, 2);
  t.ok(el.innerHTML.includes("Offer sent to MFL (Trade ID 9001)."), "the outcome is shown");
  t.ok(el.innerHTML.includes("Trade War Room"), "the War Room link stays");
});

test("phones: a three-team trade is one team per row (the 340px three-team minimum is overridden at 600px and below)", () => {
  const CSS = read("site/rosters/v2/front_office.css");
  t.ok(/@media \(max-width: 600px\) \{ \.fo-tb-teams, \.fo-tb-teams\.fo-tb-n3 \{ grid-template-columns: 1fr; \}/.test(CSS), "the phone rule names .fo-tb-n3 so it outranks minmax(340px, 1fr)");
  t.ok(CSS.indexOf(".fo-tb-teams.fo-tb-n3 { grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); }") < CSS.indexOf(".fo-tb-teams, .fo-tb-teams.fo-tb-n3 { grid-template-columns: 1fr; }"), "and comes after it");
});

// Coordinator's race check (2026-10-28): an owner can build and type before the lifecycle code arrives. The sender is attached at the first
// paint (no remount); until it is ready Send is disabled with "Loading…", and the draft and note built in that window are what is sent.
test("before the lifecycle code arrives: Send disabled with 'Loading…', a click sends nothing; once ready the same draft and note are sent", async () => {
  const { ctx } = makeContext(); const el = makeEl(); const sent = []; let ready = false;
  const handle = ctx.UPS_TRADE_BUILDER_VIEW.mount(el, { teams: TEAMS, ctx: { leagueId: "74598", season: "2026", viewerFid: "0008" }, assets: (fid) => ASSETS[fid] || { players: [], picks: [] },
    impact: () => ({ cap: null, lineup: { state: "off", message: "off" }, ext: [] }), preview: () => verdict("provisional"), openDialog() {}, closeDialog() {}, warRoomUrl: "https://example.test/war-room", debounceMs: 0,
    sender: { enabled: true, ready: () => ready, noteLimit: () => 2000, send: (d, note) => { sent.push({ items: d.items.map((i) => i.token), capK: Object.assign({}, d.capK), note }); return Promise.resolve({ state: "sent", message: "Offer sent to MFL (Trade ID 9001).", done: true }); } } });
  const h = { el, calls: {} };
  toggle(el, 1); await build(h, "two");
  let b = sendButton(el);
  t.ok(b.disabled, "disabled while loading"); t.ok(el.innerHTML.includes('id="fo-tb-send-off">Loading…</span>'), "says Loading…, not 'not available'");
  h.el.fire("click", b); await tick(); t.equal(sent.length, 0, "a click during the window sends nothing");
  const before = handle.draft(), note = el.node(/<textarea data-note[^>]*>/); t.ok(note, "the note box is there");
  el.querySelector = (sel) => (sel === "[data-note]" ? { value: "typed while loading" } : null);   // the owner typed a note in the window
  ready = true; handle.refresh(); await tick();
  t.equal(JSON.stringify(handle.draft()), JSON.stringify(before), "the draft is untouched by the code arriving (no remount)");
  b = sendButton(el); t.ok(!b.disabled, "enabled once ready");
  h.el.fire("click", b); await tick(); await tick();
  t.equal(sent.length, 1); t.equal(JSON.stringify(sent[0].items), JSON.stringify(["P_101", "P_201"]), "the players added in the window are sent"); t.equal(sent[0].note, "typed while loading", "the note typed in the window is sent");
});

await run("trade_builder_view_send_disabled");
