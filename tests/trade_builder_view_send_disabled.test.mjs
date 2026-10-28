// Front Office trade builder view (site/shared/trade_builder_view.js): no numbered step headings, and Send offer is ALWAYS disabled.
// The Front Office has no send connection. Whatever the server's verdict (provisional, needs an acknowledgment, blocked, can't be
// checked) or the trade's state (nothing selected, incomplete), Send offer renders disabled with its plain reason, a click on it
// changes nothing, no confirmation element is ever created, and no send or network call happens. The verdict display is unchanged.
//   node tests/trade_builder_view_send_disabled.test.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const VIEW = read("site/shared/trade_builder_view.js");

const TEAMS = [{ fid: "0008", name: "Me" }, { fid: "0010", name: "Blake" }, { fid: "0003", name: "Third" }];
const ASSETS = {
  "0008": { players: [{ id: "101", name: "Mine, One", pos: "WR", salary: 5000, years: 1, type: "Vet-FAA" }], picks: [] },
  "0010": { players: [{ id: "201", name: "Theirs, One", pos: "RB", salary: 4000, years: 2, type: "Rookie-Draft" }], picks: [] },
  "0003": { players: [{ id: "301", name: "Third, One", pos: "TE", salary: 3000, years: 1, type: "Vet-FAA" }], picks: [] },
};
const verdict = (status, reasons) => ({ ok: true, verdict: { status, reasons: reasons || [], trade_lock: { state: "none", sample: true } } });

// A tiny element: innerHTML plus listeners. A "click" on a rendered tag builds its target from that tag's own attributes.
function makeEl() {
  const listeners = {};
  const el = {
    innerHTML: "",
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    node(tagRe) {
      const m = tagRe.exec(el.innerHTML); if (!m) return null;
      const attrs = {}; for (const a of m[0].matchAll(/([a-zA-Z0-9-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
      const node = { tag: m[0], disabled: /\sdisabled(\s|>|=)/.test(m[0]), value: attrs.value || "",
        getAttribute: (a) => (a in attrs ? attrs[a] : null), hasAttribute: (a) => a in attrs };
      node.closest = (sel) => { const want = /^\[([a-z0-9-]+)\]$/.exec(sel); return want && want[1] in attrs ? node : null; };
      return node;
    },
    fire(type, target) { (listeners[type] || []).forEach((fn) => fn({ target, preventDefault() {} })); },
  };
  return el;
}

function harness(answer) {
  const calls = { preview: 0, send: 0, fetch: 0, dialog: 0 };
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, Promise, JSON, Math, Object, Array, String, Number, parseInt, isFinite, encodeURIComponent });
  ctx.window = ctx; ctx.self = ctx;
  ctx.document = { activeElement: null, getElementById: () => null, addEventListener() {} };
  ctx.fetch = () => { calls.fetch++; return Promise.reject(new Error("no network in this test")); };
  for (const f of ["site/shared/trade_rules.js", "site/shared/trade_builder_core.js", "site/shared/trade_builder_view.js"]) vm.runInContext(read(f), ctx, { filename: f });
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
  return { ctx, el, handle, calls };
}
const tick = () => new Promise((r) => setTimeout(r, 5));
function choose(h, idx, fid) { const n = h.el.node(new RegExp(`<select[^>]*data-partner="${idx}"[^>]*>`)); n.value = fid; h.el.fire("change", n); }
function add(h, from, pid) { const n = h.el.node(new RegExp(`<button[^>]*data-tok="P_${pid}" data-from="${from}"[^>]*>`)); t.ok(n, `Add button for ${pid}`); h.el.fire("click", n); }
async function build(h, kind) {
  if (kind === "none") return;
  choose(h, 0, "0010");
  if (kind === "three") choose(h, 1, "0003");        // a ring: Me → Blake → Third → Me, so every team sends and receives
  add(h, "0008", "101");
  if (kind === "incomplete") { await tick(); return; }
  add(h, "0010", "201");
  if (kind === "three") add(h, "0003", "301");
  await tick(); await tick();
}

function sendButton(h) { return h.el.node(/<button[^>]*data-go="send"[^>]*>/); }
function assertSendOff(h, label) {
  const html = h.el.innerHTML, b = sendButton(h);
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
function assertNoNumberedHeadings(html, label) {
  t.ok(!/fo-tb-steps|fo-tb-stagehead|fo-tb-num|data-jump/.test(html), label + ": no numbered stepper or stage head");
  t.ok(!/<h[1-6][^>]*>\s*(?:\d\s*)?(Trade proposal|Trade impact|Review and send)\s*<\/h[1-6]>/.test(html), label + ": no Trade proposal / Trade impact / Review and send heading");
  t.ok(!/<h2[\s>]/.test(html), label + ": no stage-level h2 at all");
  for (const name of ["Trade proposal", "Trade impact", "Review"]) t.ok(html.includes(`<section class="fo-card fo-tb-stage" id="fo-tb-s${["Trade proposal", "Trade impact", "Review"].indexOf(name) + 1}" aria-label="${name}">`), label + ": " + name + " region keeps an accessible name");
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
    assertSendOff(h, c.name); assertNoConfirm(html, c.name); assertNoNumberedHeadings(html, c.name);
    const before = h.el.innerHTML, previews = h.calls.preview;
    h.el.fire("click", sendButton(h));         // even a click that reaches the handler (a disabled button never fires one) does nothing
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
    assertSendOff(h, kind); assertNoConfirm(html, kind); assertNoNumberedHeadings(html, kind);
    h.el.fire("click", sendButton(h)); await tick();
    t.equal(h.el.innerHTML, html, kind + ": unchanged after the click");
    t.equal(h.calls.send + h.calls.fetch, 0, kind + ": no send, no network");
  }
});

test("three-team favorable trade: still disabled, still no confirmation", async () => {
  const h = harness(verdict("provisional"));
  await build(h, "three");
  t.ok(h.el.innerHTML.includes('fo-tb-teams fo-tb-n3'), "three team panels");
  t.ok(h.el.innerHTML.includes('fo-tb-verdict fo-tb-provisional"'), "favorable verdict");
  assertSendOff(h, "three-team"); assertNoNumberedHeadings(h.el.innerHTML, "three-team");
  const before = h.el.innerHTML; h.el.fire("click", sendButton(h)); await tick();
  t.equal(h.el.innerHTML, before, "unchanged after the click"); assertNoConfirm(h.el.innerHTML, "three-team");
  t.equal(h.calls.send + h.calls.fetch, 0, "no send, no network");
});

test("source: no code path from a click to a confirmation or a send, and no switch to add one", () => {
  t.ok(!/confirm-send|cancel-send|alertdialog|st\.confirm|st\.sent/.test(VIEW), "no confirmation markup or state");
  t.ok(!/opt\.send\b|sendPlan|sendNotice/.test(VIEW), "the view never reads a send option or builds a send plan");
  t.ok(!/getAttribute\("data-go"\)|closest\("\[data-go\]"\)/.test(VIEW), "no click handler reads data-go");
  t.ok(/data-go="send" disabled aria-disabled="true"/.test(VIEW), "the button is written disabled, with no condition");
  t.ok(!/\bfetch\(/.test(VIEW), "the view makes no network call");
  const AD = read("site/rosters/v2/fo_trade_builder.js");
  t.ok(!/\bsend\s*:|sendNotice/.test(AD), "the Front Office adapter passes no send function or notice");
});

await run("trade_builder_view_send_disabled");
