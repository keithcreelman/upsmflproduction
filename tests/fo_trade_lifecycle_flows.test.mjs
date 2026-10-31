// Front Office offer lifecycle state machines (site/shared/trade_offer_lifecycle.js; #1338, Keith's rulings 4-6, 2026-10-28).
// Every transition and failure branch with a MOCKED send(): no worker, no MFL, no network. Each test counts the requests made.
//   flag off → nothing is sent; no session → nothing; acting-for rules; create gates (cap acknowledgment resent once, loaded-contract
//   hard stop, staging fallback, in-progress / unknown / network / MFL refusal); Retry checks before resending and refuses when it
//   can't; the counter sequence (never decline first); accept / decline / revoke outcomes; three-team; inbox states; deep links.
//   node tests/fo_trade_lifecycle_flows.test.mjs
import { createRequire } from "node:module";
import { t, test, run } from "./fixtures/mini_test.mjs";

const require = createRequire(import.meta.url);
const LC = require("../site/shared/trade_offer_lifecycle.js");
const RULES = require("../site/shared/trade_rules.js");

const player = (pid, name, salary = 5000) => ({ asset_id: "player:" + pid, type: "PLAYER", player_id: pid, player_name: name, position: "WR", nfl_team: "TST", salary, years: 1, contract_type: "Vet-FAA", contract_info: "CL 1|TCV " + salary / 1000 + "K|AAV " + salary / 1000 + "K|Y1-" + salary / 1000 + "K" });
const RAW = { ok: true, league_id: "74598", season: 2026, meta: { league_id: "74598", season: 2026, commissioner_lockout: "Y" }, teams: [
  { franchise_id: "0001", franchise_name: "Alpha", assets: [player("14056", "One, Player", 20000)] },
  { franchise_id: "0002", franchise_name: "Bravo", assets: [player("13100", "Two, Player")] },
  { franchise_id: "0003", franchise_name: "Charlie", assets: [player("13999", "Three, Player")] },
  { franchise_id: "0000", franchise_name: "Commish", assets: [] }] };
const wr = () => LC.warRoom({ raw: JSON.parse(JSON.stringify(RAW)), href: "https://x/?L=74598&YEAR=2026", rules: RULES });
const DRAFT = { teams: ["0001", "0002"], items: [{ from: "0001", to: "0002", token: "P_14056" }, { from: "0002", to: "0001", token: "P_13100" }], capK: { "0001>0002": 2 }, ext: {} };
const DRAFT3 = { teams: ["0001", "0002", "0003"], items: [{ from: "0001", to: "0002", token: "P_14056" }, { from: "0002", to: "0003", token: "P_13100" }, { from: "0003", to: "0001", token: "P_13999" }], capK: {}, ext: {} };
const OFFER_IN = { status: "PENDING", mfl_present: true, id: "2001", trade_id: "2001", from_franchise_id: "0002", to_franchise_id: "0001", will_give_up: "13100,", will_receive: "14056,", comments: "hello" };
const OFFER_OUT = { status: "PENDING", mfl_present: true, id: "2002", trade_id: "2002", from_franchise_id: "0001", to_franchise_id: "0002", will_give_up: "14056,", will_receive: "13100," };

const R = (status, body) => ({ status, ok: status >= 200 && status < 300, body });
// A scripted transport: answers in order by matcher; records every request.
function transport(script) {
  const log = [];
  const send = async (req) => {
    log.push({ method: req.method, url: req.url, body: req.body ? JSON.parse(req.body) : null, path: new URL(req.url).pathname });
    const step = script.find((s) => !s.used && s.when(req));
    if (!step) throw new Error("unscripted request " + req.method + " " + new URL(req.url).pathname);
    if (!step.repeat) step.used = true;
    const a = typeof step.answer === "function" ? step.answer(req) : step.answer;
    if (a === "network") return { networkError: true };
    return a;
  };
  return { send, log, posts: () => log.filter((r) => r.method === "POST"), gets: () => log.filter((r) => r.method === "GET") };
}
const POST = (p) => (req) => req.method === "POST" && new URL(req.url).pathname === p;
const GET = (p) => (req) => req.method === "GET" && new URL(req.url).pathname === p;
const ROUTES = LC.routes({ apiBase: "https://worker.test", leagueId: "74598", season: "2026", sessionUrl: (u) => u + "&MFL_USER_ID=tok&APIKEY=secret" });
const NOSESSION = LC.routes({ apiBase: "https://worker.test", leagueId: "74598", season: "2026", sessionUrl: (u) => u });
let keyN = 0;
const ctx = (extra) => Object.assign({ newKey: () => "fo-key-" + String(++keyN).padStart(8, "0") }, extra || {});
function cl(tr, o = {}) {
  return LC.client({ cfg: "cfg" in o ? o.cfg : { FO_TRADE_BUILDER_SEND: true }, send: tr.send, warRoom: o.warRoom || wr(), routes: o.routes || ROUTES,
    me: o.me || { sessionFid: "0001", isCommish: false }, lockout: "lockout" in o ? o.lockout : "Y" });
}
const sentOk = R(200, { ok: true, mfl: { trade_id: "3001" } });
const inboxWith = (outgoing, incoming = []) => R(200, { ok: true, outgoing, incoming, outgoing_complete: true });

// ── the flag ──
test("flag OFF (absent, false, the string 'true', 1): every flow refuses and NOTHING is sent", async () => {
  for (const cfg of [undefined, {}, { FO_TRADE_BUILDER_SEND: false }, { FO_TRADE_BUILDER_SEND: "true" }, { FO_TRADE_BUILDER_SEND: 1 }]) {
    const tr = transport([]), c = cl(tr, { cfg });
    t.equal(c.enabled, false);
    const outs = await Promise.all([c.sendTwoTeam(DRAFT, "0001", "", ctx()), c.sendThreeTeam(DRAFT3, "0001", "", ctx()), c.retry({ lastBody: { a: 1 } }, "0001"),
      c.counter(OFFER_IN, DRAFT, "0001", "", ctx()), c.acceptPreview(OFFER_IN, "0001"), c.accept(OFFER_IN, "0001", { canAccept: true }), c.decline(OFFER_IN, "0001", ""),
      c.revoke(OFFER_OUT, "0001"), c.ackCap(OFFER_IN, "0001"), c.stagedAction("accept", "s1", "0001"), c.threeWayAction("cancel", "x1", "0001"), c.afterTrade("1", "0001")]);
    outs.forEach((o) => t.equal(o.code, "flag_off"));
    const ib = await c.readInbox("0001"), ls = await c.readList("staged", "0001");
    t.equal(ib.kind, "off"); t.equal(ls.kind, "off");
    t.equal(tr.log.length, 0, "zero requests with the flag " + JSON.stringify(cfg));
  }
});

test("no MFL session: refuses before any request (fails closed), with sign-in wording", async () => {
  const tr = transport([]), c = cl(tr, { routes: NOSESSION });
  const r = await c.sendTwoTeam(DRAFT, "0001", "", ctx());
  t.equal(r.code, "unauthenticated"); t.match(r.message, /Sign in to MFL/);
  t.equal((await c.readInbox("0001")).kind, "signed_out");
  t.equal(tr.log.length, 0);
});

test("the admin key is never forwarded; the MFL session is", () => {
  const u = ROUTES.create();
  t.match(u, /MFL_USER_ID=tok/); t.doesNotMatch(u, /APIKEY/);
  t.doesNotMatch(ROUTES.offers("0001"), /APIKEY/);
});

// ── acting for another team (ruling 5) ──
test("acting for another team: owners never; commissioner only with lockout 'N'; unknown lockout refuses", async () => {
  t.equal(LC.acting({ sessionFid: "0001" }, "0002", "N").code, "not_commissioner");
  t.equal(LC.acting({ sessionFid: "0000", isCommish: true }, "0001", "Y").code, "lockout_on_or_unknown");
  t.equal(LC.acting({ sessionFid: "0000", isCommish: true }, "0001", "").code, "lockout_on_or_unknown");
  t.equal(LC.acting({ sessionFid: "0000", isCommish: true }, "0001", undefined).code, "lockout_on_or_unknown");
  t.deepEqual(LC.acting({ sessionFid: "0000", isCommish: true }, "0001", "N"), { ok: true, fid: "0001", actingFor: true });
  t.deepEqual(LC.acting({ sessionFid: "0001" }, "", "Y"), { ok: true, fid: "0001", actingFor: false });
  const tr = transport([{ when: POST("/trade-offers"), answer: sentOk }]);
  const off = await cl(tr, { me: { sessionFid: "0000", isCommish: true }, lockout: "Y" }).sendTwoTeam(DRAFT, "0001", "", ctx());
  t.equal(off.code, "lockout_on_or_unknown"); t.equal(tr.log.length, 0);
  const on = await cl(tr, { me: { sessionFid: "0000", isCommish: true }, lockout: "N" }).sendTwoTeam(DRAFT, "0001", "", ctx());
  t.equal(on.state, "sent"); t.equal(on.actingFid, "0001", "the acting team is on the result");
  t.equal(tr.posts()[0].body.from_franchise_id, "0001", "sent as the acting team");
});

// ── two-team create ──
test("two-team send: one request, an idempotency key (valid #1396 format), MFL trade id reported", async () => {
  const tr = transport([{ when: POST("/trade-offers"), answer: sentOk }]);
  const r = await cl(tr).sendTwoTeam(DRAFT, "0001", "hi", {});
  t.equal(r.state, "sent"); t.equal(r.tradeId, "3001");
  t.equal(tr.log.length, 1);
  t.match(tr.posts()[0].body.idempotency_key, /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/);
  t.match(LC.newKey(() => new Uint8Array(16).fill(7)), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  t.equal(LC.newKey(() => null), "", "no randomness → no key");
  const tr2 = transport([]), r2 = await cl(tr2).sendTwoTeam(DRAFT, "0001", "", { newKey: () => "" });
  t.equal(r2.code, "no_key"); t.equal(tr2.log.length, 0, "no key → nothing sent");
});

test("cap acknowledgment: declined → not sent (1 request); confirmed → resent ONCE with the signature and the SAME key", async () => {
  const need = { franchise_id: "0001", amount_over: 1500, projected_used: 301500, cap_dollars: 300000, signature: "sig-1" };
  const ack = R(409, { ok: false, code: "cap_overage_ack_required", error: "Over", cap_ack_needed: need });
  let shown = null;
  let tr = transport([{ when: POST("/trade-offers"), answer: ack }]);
  let r = await cl(tr).sendTwoTeam(DRAFT, "0001", "", ctx({ confirmCapAck: (n) => { shown = n; return false; } }));
  t.equal(r.state, "not_sent"); t.equal(tr.log.length, 1); t.equal(shown.amount_over, 1500, "the owner saw the exact figure");
  tr = transport([{ when: POST("/trade-offers"), answer: ack }, { when: POST("/trade-offers"), answer: sentOk }]);
  r = await cl(tr).sendTwoTeam(DRAFT, "0001", "", ctx({ confirmCapAck: () => true }));
  t.equal(r.state, "sent"); t.equal(tr.log.length, 2);
  t.deepEqual(tr.posts()[1].body.cap_ack, { signature: "sig-1" });
  t.equal(tr.posts()[1].body.idempotency_key, tr.posts()[0].body.idempotency_key, "same key on the resend");
  t.equal(Object.keys(tr.posts()[1].body).slice(-1)[0], "idempotency_key", "key still last");
  tr = transport([{ when: POST("/trade-offers"), answer: ack, repeat: true }]);
  r = await cl(tr).sendTwoTeam(DRAFT, "0001", "", ctx({ confirmCapAck: () => true }));
  t.equal(r.code, "cap_ack_changed", "a changed figure stops; no second loop"); t.equal(tr.log.length, 2);
});

test("loaded-contract limit: a hard stop after one request, teams reported, no picker, nothing resent", async () => {
  const tr = transport([{ when: POST("/trade-offers"), answer: R(409, { ok: false, code: "loaded_contract_limit_exceeded", message: "over", teams: [{ franchise_id: "0002", projected: 6, max: 5 }] }) }]);
  const r = await cl(tr).sendTwoTeam(DRAFT, "0001", "", ctx());
  t.equal(r.state, "blocked_loaded"); t.equal(r.teams[0].projected, 6); t.equal(tr.log.length, 1);
  t.match(r.message, /Revise the offer/);
});

test("staging_required: the War Room's pre-send check, then the staged create with the key; a blocked check stops; a long note stops", async () => {
  const staging = R(409, { ok: false, code: "staging_required" });
  let tr = transport([{ when: POST("/trade-offers"), answer: staging }, { when: POST("/api/trades/compliance-preview"), answer: R(200, { ok: true, compliance: { loaded_contracts: { status: "ok" } } }) }, { when: POST("/api/trades/2way"), answer: R(200, { ok: true, id: "st-9" }) }]);
  let r = await cl(tr).sendTwoTeam(DRAFT, "0001", "short", ctx());
  t.equal(r.state, "staged"); t.equal(r.id, "st-9");
  t.deepEqual(tr.log.map((x) => x.path), ["/trade-offers", "/api/trades/compliance-preview", "/api/trades/2way"]);
  t.equal(tr.posts()[2].body.idempotency_key, tr.posts()[0].body.idempotency_key);
  t.ok(!("loaded_contract_drops" in tr.posts()[2].body), "no drops field");
  t.equal(new URL(tr.log[2].url).searchParams.get("acting_franchise_id"), "0001");
  tr = transport([{ when: POST("/trade-offers"), answer: staging }, { when: POST("/api/trades/compliance-preview"), answer: R(200, { ok: true, compliance: { loaded_contracts: { status: "blocked", violations: [{ franchise_id: "0001", projected: 6, max: 5 }] } } }) }]);
  r = await cl(tr).sendTwoTeam(DRAFT, "0001", "", ctx());
  t.equal(r.state, "blocked_loaded"); t.equal(tr.log.length, 2, "nothing staged");
  tr = transport([{ when: POST("/trade-offers"), answer: staging }]);
  r = await cl(tr).sendTwoTeam(DRAFT, "0001", "x".repeat(600), ctx());
  t.equal(r.state, "needs_shorter_note"); t.equal(r.limit, 500); t.equal(tr.log.length, 1);
});

test("refusals map to states, each after ONE request (no automatic retry)", async () => {
  const cases = [["network", "unconfirmed", "network"], [R(409, { code: "request_in_progress" }), "in_progress"], [R(409, { code: "request_outcome_unknown" }), "unconfirmed", "request_outcome_unknown"],
    [R(401, { code: "unauthenticated" }), "signed_out"], [R(403, { code: "forbidden", error: "no" }), "forbidden"], [R(502, { ok: false, error_type: "trade_proposal_import_failed", reason: "bad" }), "mfl_rejected"],
    [R(503, { ok: false, code: "idempotency_unavailable" }), "refused", "idempotency_unavailable"], [R(409, { code: "idempotency_key_reused" }), "refused", "idempotency_key_reused"], [R(500, { ok: false }), "unconfirmed", "unavailable"],
    [R(200, { ok: false, error: "nope" }), "refused"]];
  for (const [answer, state, code] of cases) {
    const tr = transport([{ when: POST("/trade-offers"), answer }]);
    const r = await cl(tr).sendTwoTeam(DRAFT, "0001", "", ctx());
    t.equal(r.state, state, JSON.stringify(answer)); if (code) t.equal(r.code, code);
    t.equal(tr.log.length, 1, "one request for " + state);
    t.ok(r.message && r.message.length < 200, "owner wording");
  }
});

test("refused before sending: a note over 2,000, cap money over the War Room's limit, an asset the War Room doesn't hold, a missing extension option", async () => {
  const tr = transport([]), c = cl(tr);
  t.equal((await c.sendTwoTeam(DRAFT, "0001", "x".repeat(2001), ctx())).code, "note_too_long");
  t.equal((await c.sendTwoTeam(Object.assign({}, DRAFT, { capK: { "0001>0002": 50 } }), "0001", "", ctx())).code, "cap_money_over_war_room_max");
  t.equal((await c.sendTwoTeam(Object.assign({}, DRAFT, { items: DRAFT.items.concat([{ from: "0001", to: "0002", token: "P_99999" }]) }), "0001", "", ctx())).code, "asset_not_in_war_room");
  t.equal((await c.sendTwoTeam(Object.assign({}, DRAFT, { ext: { "0001|P_14056": "1YR|NONE" } }), "0001", "", ctx())).code, "extension_not_offered");
  t.equal(tr.log.length, 0);
  t.equal(LC.noteLimit("direct"), 2000); t.equal(LC.noteLimit("staged"), 500); t.equal(LC.noteLimit("three_team"), 500);
  t.ok(LC.twoTeam(wr(), DRAFT, "0001", "x".repeat(2000)).ok, "exactly 2,000 is allowed");
});

// ── Retry (ruling 5) ──
test("Retry: an offer that already arrived is NOT sent again; a missing one is resent with the same key; an unreadable list refuses", async () => {
  const first = await (async () => { const tr = transport([{ when: POST("/trade-offers"), answer: "network" }]); return cl(tr).sendTwoTeam(DRAFT, "0001", "", ctx()); })();
  t.equal(first.state, "unconfirmed"); t.ok(first.lastBody);
  const landed = { status: "PENDING", mfl_present: true, id: "3001", trade_id: "3001", from_franchise_id: "0001", to_franchise_id: "0002", will_give_up: "14056,BB_2000", will_receive: "13100," };
  let tr = transport([{ when: GET("/trade-offers"), answer: inboxWith([landed]) }]);
  let r = await cl(tr).retry(first, "0001");
  t.equal(r.state, "already_sent"); t.equal(r.tradeId, "3001"); t.equal(tr.posts().length, 0, "nothing resent");
  tr = transport([{ when: GET("/trade-offers"), answer: inboxWith([]) }, { when: POST("/trade-offers"), answer: sentOk }]);
  r = await cl(tr).retry(first, "0001");
  t.equal(r.state, "sent"); t.equal(tr.posts().length, 1);
  t.equal(tr.posts()[0].body.idempotency_key, first.lastBody.idempotency_key, "same key: the worker replays if it had it");
  t.deepEqual(tr.log.map((x) => x.method), ["GET", "POST"], "the check comes first");
  for (const bad of ["network", R(503, { ok: false }), R(401, { code: "unauthenticated" }), R(200, { ok: true })]) {
    tr = transport([{ when: GET("/trade-offers"), answer: bad }]);
    r = await cl(tr).retry(first, "0001");
    t.equal(r.code, "retry_check_unavailable", JSON.stringify(bad)); t.equal(tr.posts().length, 0, "refused: nothing sent");
  }
  t.equal((await cl(transport([])).retry(null, "0001")).code, "retry_check_unavailable", "nothing to retry");
});

test("Retry refuses unless it can prove the first send isn't there (MAT-2): a row it can't read, or a list the worker doesn't call complete", async () => {
  const first = await (async () => { const tr = transport([{ when: POST("/trade-offers"), answer: "network" }]); return cl(tr).sendTwoTeam(DRAFT, "0001", "", ctx()); })();
  const row = { status: "PENDING", mfl_present: true, id: "3001", trade_id: "3001", from_franchise_id: "0001", to_franchise_id: "0002", will_give_up: "14056,BB_2000", will_receive: "13100," };
  const cases = [
    ["blank give side", inboxWith([{ ...row, will_give_up: "" }])],
    ["blank receive side", inboxWith([{ ...row, will_receive: "" }])],
    ["unreadable token", inboxWith([{ ...row, will_give_up: "14056,BB_abc" }])],
    ["no partner on the row", inboxWith([{ ...row, to_franchise_id: "" }])],
    ["same contents, not in MFL", inboxWith([{ ...row, mfl_present: false }])],
    ["list not called complete", R(200, { ok: true, outgoing: [], incoming: [] })],
  ];
  for (const [why, answer] of cases) {
    const tr = transport([{ when: GET("/trade-offers"), answer }]);
    const r = await cl(tr).retry(first, "0001");
    t.equal(r.code, "retry_check_unavailable", why); t.equal(tr.posts().length, 0, why + ": nothing sent");
  }
  const tr = transport([{ when: GET("/trade-offers"), answer: inboxWith([{ ...row, to_franchise_id: "0003" }]) }, { when: POST("/trade-offers"), answer: sentOk }]);
  t.equal((await cl(tr).retry(first, "0001")).state, "sent", "a readable offer to another team proves nothing about this one");
});

test("Retry for a three-team create: matched by movements in the caller's 3-way list; unreadable list refuses", async () => {
  const pre = R(200, { ok: true, compliance: { loaded_contracts: { status: "ok" } } });
  let tr = transport([{ when: POST("/api/trades/compliance-preview"), answer: pre }, { when: POST("/api/trades/3way"), answer: "network" }]);
  const first = await cl(tr).sendThreeTeam(DRAFT3, "0001", "", ctx());
  t.equal(first.state, "unconfirmed");
  tr = transport([{ when: GET("/api/trades/3way"), answer: R(200, { ok: true, trades: [{ id: "x7", movements: first.lastBody.movements }] }) }]);
  let r = await cl(tr).retry(first, "0001");
  t.equal(r.state, "already_sent_three_team"); t.equal(tr.posts().length, 0);
  tr = transport([{ when: GET("/api/trades/3way"), answer: R(503, { ok: false }) }]);
  r = await cl(tr).retry(first, "0001");
  t.equal(r.code, "retry_check_unavailable"); t.equal(tr.posts().length, 0);
});

// ── Counter (ruling 4): create first; decline the original only after the counter is seen ──
const COUNTER = { teams: ["0001", "0002"], items: [{ from: "0001", to: "0002", token: "P_14056" }, { from: "0002", to: "0001", token: "P_13100" }], capK: {}, ext: {} };
const counterSeen = { status: "PENDING", mfl_present: true, id: "3001", trade_id: "3001", from_franchise_id: "0001", to_franchise_id: "0002", will_give_up: "14056,", will_receive: "13100," };
const order = (tr) => tr.log.map((x) => x.method + " " + x.path + (x.body && x.body.action ? " " + x.body.action : ""));

test("counter, all good: create → see it in the sent list → decline the original (in that order)", async () => {
  const tr = transport([{ when: POST("/trade-offers"), answer: sentOk }, { when: GET("/trade-offers"), answer: inboxWith([counterSeen], [OFFER_IN]) }, { when: POST("/trade-offers/action"), answer: R(200, { ok: true }) }]);
  const r = await cl(tr).counter(OFFER_IN, COUNTER, "0001", "how about", ctx());
  t.equal(r.state, "countered"); t.equal(r.counterTradeId, "3001"); t.equal(r.originalTradeId, "2001");
  t.deepEqual(order(tr), ["POST /trade-offers", "GET /trade-offers", "POST /trade-offers/action REJECT"]);
  t.equal(tr.posts()[1].body.message, LC.COUNTER_DECLINE_NOTE);
  t.ok(!tr.log.some((x) => x.body && x.body.action === "COUNTER"), "the worker's reject-first COUNTER action is never used");
});

test("counter create FAILS (every way): the original is never declined and stays open", async () => {
  for (const answer of ["network", R(409, { code: "loaded_contract_limit_exceeded", teams: [] }), R(502, { error_type: "trade_proposal_import_failed" }), R(503, { code: "idempotency_unavailable" })]) {
    const tr = transport([{ when: POST("/trade-offers"), answer }]);
    const r = await cl(tr).counter(OFFER_IN, COUNTER, "0001", "", ctx());
    t.equal(r.counter, "not_sent"); t.equal(r.originalOpen, true);
    t.ok(!tr.log.some((x) => /action$/.test(x.path)), "no decline sent");
  }
});

test("counter sent but NOT seen (list unreadable or missing it): no decline; original open; recovery = check again", async () => {
  for (const list of ["network", R(503, { ok: false }), inboxWith([], [OFFER_IN])]) {
    const tr = transport([{ when: POST("/trade-offers"), answer: sentOk }, { when: GET("/trade-offers"), answer: list }]);
    const r = await cl(tr).counter(OFFER_IN, COUNTER, "0001", "", ctx());
    t.equal(r.state, "counter_unverified"); t.equal(r.originalOpen, true); t.equal(r.recovery, "check_again");
    t.ok(!tr.log.some((x) => /action$/.test(x.path)));
  }
});

test("counter sent and seen, decline FAILS: both offers exist, the result says so, one recovery action (decline the original) works", async () => {
  const tr = transport([{ when: POST("/trade-offers"), answer: sentOk }, { when: GET("/trade-offers"), answer: inboxWith([counterSeen]) }, { when: POST("/trade-offers/action"), answer: R(503, { ok: false, code: "unavailable" }) }]);
  const c = cl(tr);
  const r = await c.counter(OFFER_IN, COUNTER, "0001", "", ctx());
  t.equal(r.state, "both_open"); t.equal(r.recovery, "decline_original"); t.match(r.message, /original offer is still open/);
  const tr2 = transport([{ when: POST("/trade-offers/action"), answer: R(200, { ok: true }) }]);
  const again = await cl(tr2).declineOriginal(OFFER_IN, { tradeId: r.counterTradeId, lastBody: r.lastBody }, "0001");
  t.equal(again.state, "countered"); t.equal(tr2.log.length, 1, "the recovery sends only the decline");
  const tr3 = transport([{ when: POST("/trade-offers/action"), answer: R(409, { ok: false, code: "offer_not_pending" }) }]);
  const gone = await cl(tr3).declineOriginal(OFFER_IN, { tradeId: "3001" }, "0001");
  t.equal(gone.state, "countered"); t.equal(gone.originalAlreadyClosed, true);
});

test("counter checks before sending: only the recipient, only back to the sender", async () => {
  const tr = transport([]);
  t.equal((await cl(tr).counter(OFFER_OUT, COUNTER, "0001", "", ctx())).code, "forbidden");
  t.equal((await cl(tr).counter(OFFER_IN, { teams: ["0001", "0003"], items: [], capK: {}, ext: {} }, "0001", "", ctx())).code, "not_ready");
  t.equal(tr.log.length, 0);
});

// ── Accept / decline / revoke ──
test("accept needs a clear server preview first; outcomes are distinct (executed, needs review, already, unconfirmed, not pending)", async () => {
  let tr = transport([{ when: POST("/trade-offers/action"), answer: R(200, { ok: true, compliance: { cap: { status: "ok" }, loaded_contracts: { status: "ok" } } }) }]);
  const p = await cl(tr).acceptPreview(OFFER_IN, "0001");
  t.equal(p.state, "preview"); t.equal(tr.posts()[0].body.action, "PREVIEW");
  t.equal((await cl(transport([])).accept(OFFER_IN, "0001", null)).code, "not_ready", "no accept without a preview");
  t.equal((await cl(transport([])).accept(OFFER_IN, "0001", { canAccept: false })).code, "not_ready");
  const outcomes = [[R(200, { ok: true, trade_id: "2001", salary_adjustments: { ok: true, rows: [] }, extensions: { ok: true, applied: [] } }), "executed"],
    [R(200, { ok: true, needs_review: true, message: "review" }), "executed_needs_review"], [R(200, { ok: true, already: true, executed: true }), "already_accepted"],
    [R(409, { ok: false, code: "execution_unconfirmed" }), "accept_unconfirmed"], [R(409, { ok: false, code: "offer_not_pending" }), "not_pending"], ["network", "accept_unconfirmed"],
    [R(502, { ok: false, error: "MFL said no" }), "mfl_rejected"]];
  for (const [answer, state] of outcomes) {
    tr = transport([{ when: POST("/trade-offers/action"), answer }]);
    const r = await cl(tr).accept(OFFER_IN, "0001", { canAccept: true });
    t.equal(r.state, state); t.equal(tr.log.length, 1, "one accept request, never resent");
    if (state === "executed") t.match(r.summary.text, /Salary adjustments: posted 0/);
  }
  t.equal((await cl(transport([])).acceptPreview(OFFER_OUT, "0001")).code, "forbidden", "only the recipient accepts");
});

test("cap acknowledgment inside the accept review posts ACK_CAP for the acting team", async () => {
  const tr = transport([{ when: POST("/trade-offers/action"), answer: R(200, { ok: true, code: "acknowledged", message: "Acknowledged." }) }]);
  const r = await cl(tr).ackCap(OFFER_IN, "0001");
  t.equal(tr.posts()[0].body.action, "ACK_CAP"); t.equal(tr.posts()[0].body.acting_franchise_id, "0001"); t.equal(r.result.ok, true);
});

test("decline (note ≤ 2,000, recipient only) and revoke (sender only)", async () => {
  let tr = transport([{ when: POST("/trade-offers/action"), answer: R(200, { ok: true }) }]);
  let r = await cl(tr).decline(OFFER_IN, "0001", "not for me");
  t.equal(r.state, "declined"); t.equal(tr.posts()[0].body.action, "REJECT"); t.equal(tr.posts()[0].body.message, "not for me");
  t.equal((await cl(transport([])).decline(OFFER_IN, "0001", "x".repeat(2001))).code, "note_too_long");
  t.equal((await cl(transport([])).decline(OFFER_OUT, "0001", "")).code, "forbidden");
  tr = transport([{ when: POST("/trade-offers/action"), answer: R(200, { ok: true }) }]);
  r = await cl(tr).revoke(OFFER_OUT, "0001");
  t.equal(r.state, "revoked"); t.equal(tr.posts()[0].body.action, "REVOKE");
  t.equal((await cl(transport([])).revoke(OFFER_IN, "0001")).code, "forbidden", "only the sender revokes");
  tr = transport([{ when: POST("/trade-offers/action"), answer: R(409, { ok: false, code: "offer_not_pending" }) }]);
  t.equal((await cl(tr).revoke(OFFER_OUT, "0001")).state, "not_pending");
});

// ── Three-team ──
test("three-team: initiator over the loaded limit = hard stop; a partner over it asks first (War Room's 'Send anyway'); sent with a key", async () => {
  const blocked = (fid) => R(200, { ok: true, compliance: { loaded_contracts: { status: "blocked", violations: [{ franchise_id: fid, projected: 6, max: 5 }] } } });
  let tr = transport([{ when: POST("/api/trades/compliance-preview"), answer: blocked("0001") }]);
  let r = await cl(tr).sendThreeTeam(DRAFT3, "0001", "", ctx());
  t.equal(r.state, "blocked_loaded"); t.equal(tr.posts().length, 1, "only the read-only preview");
  tr = transport([{ when: POST("/api/trades/compliance-preview"), answer: blocked("0002") }]);
  r = await cl(tr).sendThreeTeam(DRAFT3, "0001", "", ctx({ confirmPartnerOverLoaded: () => false }));
  t.equal(r.state, "not_sent"); t.equal(tr.posts().length, 1);
  tr = transport([{ when: POST("/api/trades/compliance-preview"), answer: blocked("0002") }, { when: POST("/api/trades/3way"), answer: R(200, { ok: true, id: "x1" }) }]);
  r = await cl(tr).sendThreeTeam(DRAFT3, "0001", "all three", ctx({ confirmPartnerOverLoaded: () => true }));
  t.equal(r.state, "sent_three_team"); t.equal(r.id, "x1");
  const body = tr.posts()[1].body;
  t.ok(body.idempotency_key); t.equal(body.notes, "all three"); t.equal(body.initiator.fid, "0001"); t.equal(body.movements.length, 3);
  t.equal((await cl(transport([])).sendThreeTeam(DRAFT3, "0001", "x".repeat(501), ctx())).code, "note_too_long", "500 for three-team");
});

test("loaded limit: the preview's own `violations` list reaches the 'Send anyway' question; blocked with no team named sends nothing", async () => {
  // The worker's compliance preview names over-limit teams in loaded_contracts.violations (trade_cap_authority.js), never `teams`.
  const asked = [];
  let tr = transport([{ when: POST("/api/trades/compliance-preview"), answer: R(200, { ok: true, compliance: { loaded_contracts: { status: "blocked", max: 5, violations: [{ franchise_id: "2", franchise_name: "Bravo", projected: 6, max: 5, message: "Bravo would have 6" }] } } }) }]);
  let r = await cl(tr).sendThreeTeam(DRAFT3, "0001", "", ctx({ confirmPartnerOverLoaded: (teams) => { asked.push(teams); return false; } }));
  t.equal(r.state, "not_sent"); t.equal(asked.length, 1, "the owner was asked");
  t.deepEqual(JSON.parse(JSON.stringify(asked[0])), [{ franchise_id: "0002", franchise_name: "Bravo", projected: 6, max: 5 }]);
  tr = transport([{ when: POST("/api/trades/compliance-preview"), answer: R(200, { ok: true, compliance: { loaded_contracts: { status: "blocked", violations: [] } } }) }]);
  r = await cl(tr).sendThreeTeam(DRAFT3, "0001", "", ctx({ confirmPartnerOverLoaded: () => true }));
  t.equal(r.state, "blocked_loaded", "blocked without a team list is a stop, not a send"); t.equal(tr.posts().length, 1, "only the read-only preview");
});

test("three-team cap acknowledgment at create resends once; staged/3-way management bodies; no drop selection", async () => {
  const pre = R(200, { ok: true, compliance: { loaded_contracts: { status: "ok" } } });
  const ack = R(409, { ok: false, code: "cap_overage_ack_required", cap_ack_needed: { signature: "s3", amount_over: 10 } });
  let tr = transport([{ when: POST("/api/trades/compliance-preview"), answer: pre }, { when: POST("/api/trades/3way"), answer: ack }, { when: POST("/api/trades/3way"), answer: R(200, { ok: true, id: "x2" }) }]);
  let r = await cl(tr).sendThreeTeam(DRAFT3, "0001", "", ctx({ confirmCapAck: () => true }));
  t.equal(r.state, "sent_three_team"); t.deepEqual(tr.posts()[2].body.cap_ack, { signature: "s3" });
  tr = transport([{ when: POST("/api/trades/2way/cancel"), answer: R(200, { ok: true }) }]);
  r = await cl(tr).stagedAction("decline", "st-1", "0001");
  t.equal(r.state, "declined"); t.deepEqual(tr.posts()[0].body, { id: "st-1", reason: "cancelled from the Trade War Room" });
  t.equal((await cl(transport([])).stagedAction("select-drops", "st-1", "0001")).code, "loaded_contract_drops_removed");
  tr = transport([{ when: POST("/api/trades/3way/cancel"), answer: R(200, { ok: true, trade: { id: "x1", status: "cancelled" } }) }]);
  r = await cl(tr).threeWayAction("cancel", "x1", "0001");
  t.equal(r.state, "cancelled"); t.deepEqual(tr.posts()[0].body, { id: "x1", acting_franchise_id: "0001" });
  tr = transport([{ when: POST("/api/trades/3way/cancel"), answer: "network" }]);
  t.equal((await cl(tr).threeWayAction("cancel", "x1", "0001")).state, "refused", "never 'cancelled' without the server saying so");
});

// ── Reads: inbox states, lists, after-trade refresh ──
test("inbox keeps signed out, failed and empty apart (the War Room's states)", async () => {
  const cases = [[R(401, { ok: false, code: "unauthenticated" }), "signed_out"], [R(503, { ok: false, code: "identity_unavailable", error: "x" }), "error"], ["network", "error"],
    [R(200, { ok: true }), "error"], [inboxWith([]), "empty"], [inboxWith([OFFER_OUT], [OFFER_IN]), "ok"]];
  for (const [answer, kind] of cases) {
    const tr = transport([{ when: GET("/trade-offers"), answer }]);
    const ib = await cl(tr).readInbox("0001");
    t.equal(ib.kind, kind, JSON.stringify(answer));
    if (kind === "ok") { t.equal(ib.sent.length, 1); t.equal(ib.received.length, 1); }
    const q = new URL(tr.log[0].url).searchParams;
    t.equal(q.get("FRANCHISE_ID"), "0001"); t.equal(q.get("status"), "PENDING"); t.equal(q.get("include_payload"), "1");
  }
  const tr = transport([{ when: GET("/api/trades/2way"), answer: R(200, { ok: true, trades: [] }) }, { when: GET("/api/trades/3way"), answer: R(502, { ok: false }) }]);
  t.equal((await cl(tr).readList("staged", "0001")).kind, "empty");
  t.equal((await cl(tr).readList("three", "0001")).kind, "error", "a failed list is never 'none'");
});

test("after-trade refresh posts the War Room's body; deep links round-trip and reject junk", async () => {
  const tr = transport([{ when: POST("/refresh/after-trade"), answer: R(200, { ok: true }) }]);
  t.equal((await cl(tr).afterTrade("2001", "0001")).state, "refreshed");
  t.deepEqual(tr.posts()[0].body, { league_id: "74598", season: "2026", trade_id: "2001", acting_franchise_id: "0001", dispatch_refresh_mym_json: true, reconcile_extensions: true });
  t.equal(LC.offerLink("mfl", "2001"), "#fo=trades&offer=mfl%3A2001");
  t.deepEqual(LC.parseOfferLink("#fo=trades&offer=mfl%3A2001"), { kind: "mfl", id: "2001" });
  t.deepEqual(LC.parseOfferLink(LC.offerLink("3way", "ab-12")), { kind: "3way", id: "ab-12" });
  t.equal(LC.parseOfferLink("#fo=trades&offer=evil%3A1"), null);
  t.equal(LC.parseOfferLink("#fo=trades&offer=mfl%3A%3Cscript%3E"), null);
  t.equal(LC.parseOfferLink("#fo=trades"), null);
});

await run("fo_trade_lifecycle_flows");
