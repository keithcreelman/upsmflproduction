// War Room two-team Retry never sends the same offer twice (S6b; site/trades/trade_workbench.js retryLastSubmitRequest).
// Before resending, Retry reloads the owner's outgoing offers and compares partner, assets and cap money in dollars; a
// match means the first send already reached MFL. Retry resends only when it can PROVE the first send isn't there: a
// complete list, every row readable, and five minutes for MFL to list a new offer. Anything else refuses (fail closed).
// The resend goes through submitTradeCreateWithGates, so the loaded-contract, cap-acknowledgment and staging steps apply.
// The REAL whole War Room against the REAL worker (MFL stubbed at the edge).
//   node tests/trade_war_room_retry_no_duplicate.test.mjs
import { t, test, run } from "./fixtures/mini_test.mjs";
import { quiet } from "./fixtures/worker_harness.mjs";
import { settle } from "./fixtures/fake_dom.mjs";
import { bootDesktop, pageWorld, readyOffer, resp } from "./fixtures/war_room_page.mjs";

const restore = quiet();
const creates = (w) => w.log.filter((r) => r.method === "POST" && /\/trade-offers$/.test(r.path));
const isCreate = (u, i) => !!(i && i.method === "POST" && /\/trade-offers\?/.test(u));
const clickRetry = async (d) => { d.els.twbSubmitRetryBtn.__l.click(); await settle(60); };
const SETTLE_MS = 5 * 60 * 1000;
const settled = (d) => { d.api.state.submit.lastAttemptMs = Date.now() - SETTLE_MS; };
const isList = (u, i) => (!i || !i.method || i.method === "GET") && /\/trade-offers\?/.test(u);
const REFUSED = /Couldn't check whether your offer already reached MFL, so it was NOT sent again/;

// The first send reaches MFL and its answer is lost. `after(w)` then changes what MFL lists; `list` can rewrite the worker's answer.
async function lostSend(after, list) {
  const w = pageWorld();
  let lose = true;
  const d = await bootDesktop(w, { token: "tok-B", fid: "0001", override: async (u, i, real) => {
    if (lose && isCreate(u, i)) { lose = false; await real(u, i); throw new TypeError("Failed to fetch"); }
    if (list && isList(u, i)) { const r = await real(u, i); return resp(200, list(await r.json())); }
    return null;
  } });
  t.equal(readyOffer(d, "hi", { capK: 2 }), "ready");
  await d.api.submitOfferToQueue(); await settle(30);
  t.equal(w.mfl.st.pending.length, 1, "the first send reached MFL");
  if (after) after(w);
  settled(d);                        // the wait is over: only the list itself can refuse here
  await clickRetry(d);
  return { w, d };
}
function refused({ w, d }, why) {
  t.equal(creates(w).length, 1, why + ": Retry made NO second create request");
  t.equal(w.mfl.st.pending.length, 1, why + ": still exactly one offer in MFL");
  t.match(d.api.state.submit.message, REFUSED, why);
  t.equal(d.api.state.submit.canRetry, true, why + ": Retry stays available");
}

test("first send lands in MFL but its answer is lost: Retry finds it and sends nothing ('Already reached MFL (Trade ID n)')", async () => {
  const w = pageWorld();
  let lose = true;
  const d = await bootDesktop(w, { token: "tok-B", fid: "0001", override: async (u, i, real) => {
    if (lose && isCreate(u, i)) { lose = false; await real(u, i); throw new TypeError("Failed to fetch"); }   // MFL took it; the answer never arrived
    return null;
  } });
  t.equal(readyOffer(d, "hi", { capK: 2 }), "ready");
  await d.api.submitOfferToQueue(); await settle(30);
  t.equal(w.mfl.st.pending.length, 1, "the first send reached MFL");
  t.equal(d.api.state.submit.canRetry, true, "the owner saw a failure and is offered Retry");
  await clickRetry(d);
  t.equal(creates(w).length, 1, "Retry made NO second create request");
  t.equal(w.mfl.st.pending.length, 1, "still exactly one offer in MFL");
  t.match(d.api.state.submit.message, /^Already reached MFL \(Trade ID 2001\)/);
  t.equal(d.api.state.submit.canRetry, false);
});

test("an outgoing offer with the same partner and players but DIFFERENT cap money is not a match: Retry sends", async () => {
  const w = pageWorld();
  w.mfl.addPending({ offeringteam: "0001", offeredto: "0002", will_give_up: "14056,", will_receive: "13100," });   // no cap money
  let fail = true;
  const d = await bootDesktop(w, { token: "tok-B", fid: "0001", override: async (u, i) => (fail && isCreate(u, i) ? (fail = false, resp(503, { ok: false, error: "busy" })) : null) });
  t.equal(readyOffer(d, "hi", { capK: 2 }), "ready");   // this one carries $2,000 from 0001
  await d.api.submitOfferToQueue(); await settle(30);
  settled(d);
  await clickRetry(d);
  t.equal(creates(w).length, 1, "the retry reached the worker (the first attempt never did)");
  t.equal(w.mfl.st.pending.length, 2, "a second, different offer now exists");
  t.match(d.api.state.submit.message, /^Offer submitted to MFL/);
});

test("a 409 cap_overage_ack_required on Retry shows the cap acknowledgment dialog; acknowledging resends with cap_ack", async () => {
  const w = pageWorld();
  let n = 0;
  const bodies = [];
  const d = await bootDesktop(w, { token: "tok-B", fid: "0001", override: async (u, i) => {
    if (!isCreate(u, i)) return null;
    n += 1; bodies.push(JSON.parse(i.body));
    if (n === 1) return resp(503, { ok: false, error: "busy" });
    if (n === 2) return resp(409, { ok: false, code: "cap_overage_ack_required", error: "Over the cap", cap_ack_needed: { signature: "sig-1", amount_over: 1000, cap_dollars: 300000 } });
    return null;   // the acknowledged resend reaches the worker
  } });
  t.equal(readyOffer(d, "hi"), "ready");
  await d.api.submitOfferToQueue(); await settle(30);
  settled(d);
  d.els.twbSubmitRetryBtn.__l.click(); await settle(60);
  t.match(d.els.twbCapAckDialogBody.innerHTML, /Acknowledge and send/, "the cap acknowledgment dialog is shown on Retry");
  d.els.twbCapAckDialogBody.onclick({ target: { closest: () => ({ getAttribute: () => "confirm" }) } });
  await settle(60);
  t.equal(bodies.length, 3);
  t.equal(bodies[2].cap_ack && bodies[2].cap_ack.signature, "sig-1", "the resend carries the acknowledgment");
  t.equal(w.mfl.st.pending.length, 1, "one offer in MFL");
});

test("the outgoing-offers list can't load: Retry REFUSES to send and says why", async () => {
  const w = pageWorld();
  let fail = true, listDown = false;
  const d = await bootDesktop(w, { token: "tok-B", fid: "0001", override: async (u, i) => {
    if (fail && isCreate(u, i)) { fail = false; return resp(503, { ok: false, error: "busy" }); }
    if (listDown && (!i || !i.method || i.method === "GET") && /\/trade-offers\?/.test(u)) return resp(500, "<html>down</html>");
    return null;
  } });
  t.equal(readyOffer(d, "hi"), "ready");
  await d.api.submitOfferToQueue(); await settle(30);
  listDown = true;
  await clickRetry(d);
  t.equal(creates(w).length, 0, "no create request was sent");
  t.equal(w.mfl.st.pending.length, 0);
  t.match(d.api.state.submit.message, /Couldn't check whether your offer already reached MFL, so it was NOT sent again/);
  t.equal(d.api.state.submit.canRetry, true, "Retry stays available for when the list loads");
  listDown = false;
  settled(d);
  await clickRetry(d);
  t.equal(creates(w).length, 1, "once the list loads (no match), Retry sends");
  t.equal(w.mfl.st.pending.length, 1);
});

test("lost response, and MFL lists the offer without a side's assets: Retry refuses, it doesn't read a blank as 'not my offer'", async () => {
  refused(await lostSend((w) => { w.mfl.st.pending[0].will_give_up = ""; }), "will_give_up blank");
  refused(await lostSend((w) => { w.mfl.st.pending[0].will_receive = ""; }), "will_receive blank");
  refused(await lostSend((w) => { delete w.mfl.st.pending[0].will_give_up; delete w.mfl.st.pending[0].will_receive; }), "both sides missing");
});

test("lost response, and a listed asset can't be parsed: Retry refuses (a bad cap token no longer reads as $0)", async () => {
  refused(await lostSend((w) => { w.mfl.st.pending[0].will_give_up = "14056,BB_abc,"; }), "bad cap token");
  refused(await lostSend((w) => { w.mfl.st.pending[0].will_receive = "13100,???,"; }), "unknown token");
});

test("lost response, and MFL's row has no readable sender: it never reaches `outgoing`, and Retry still refuses", async () => {
  refused(await lostSend((w) => { const [row] = w.mfl.st.pending; w.mfl.st.exportBody = { pendingTrades: { pendingTrades: { pendingTrade: [{ trade_id: row.trade_id, offeredto: row.offeredto, will_give_up: row.will_give_up, will_receive: row.will_receive }] } } }; }), "no sender");
});

test("MFL answers 200 with no pendingTrades block: that isn't an empty list, so Retry refuses", async () => {
  refused(await lostSend((w) => { w.mfl.st.exportBody = { pendingTrades: { version: "1.0" } }; }), "no block");
});

test("a worker that doesn't say the list is complete (older, or a commissioner's read): Retry refuses", async () => {
  refused(await lostSend(null, (j) => ({ ...j, outgoing: [], outgoing_complete: false })), "says incomplete");
  refused(await lostSend(null, (j) => { const { outgoing_complete: _, ...rest } = j; return { ...rest, outgoing: [] }; }), "field missing");
});

test("a stored offer MFL doesn't list yet, same contents: Retry neither sends nor claims it landed", async () => {
  const { w, d } = await lostSend(null, (j) => ({ ...j, outgoing: j.outgoing.map((o) => ({ ...o, mfl_present: false, source: "stored_only", mfl_trade_id: "", trade_id: "" })) }));
  refused({ w, d }, "stored only");
});

test("the same pick in another spelling is the same offer: DP_00_03 in MFL's list matches, so Retry doesn't resend", async () => {
  const w = pageWorld();
  let lose = true;
  const d = await bootDesktop(w, { token: "tok-B", fid: "0001", override: async (u, i, real) => { if (lose && isCreate(u, i)) { lose = false; await real(u, i); throw new TypeError("Failed to fetch"); } return null; } });
  readyOffer(d, "hi", { capK: 2 }); await d.api.submitOfferToQueue(); await settle(30);
  const body = d.api.state.submit.lastRequestBody, mine = body.payload.teams.find((x) => x.franchise_id === "0001");
  mine.selected_assets = mine.selected_assets.concat([{ type: "PICK", pick_key: "DP_00_03" }]);
  w.mfl.st.pending[0].will_give_up = "14056,BB_2000,DP_0_3,";
  settled(d);
  await clickRetry(d);
  t.equal(creates(w).length, 1, "nothing sent"); t.equal(w.mfl.st.pending.length, 1);
  t.match(d.api.state.submit.message, /^Already reached MFL/);
});

test("the wait for MFL to list a new offer: refused one second before five minutes, sends at five minutes, and a listed offer never waits", async () => {
  const w = pageWorld();
  let fail = true;
  const d = await bootDesktop(w, { token: "tok-B", fid: "0001", override: async (u, i) => (fail && isCreate(u, i) ? (fail = false, resp(503, { ok: false, error: "busy" })) : null) });
  t.equal(readyOffer(d, "hi"), "ready");
  await d.api.submitOfferToQueue(); await settle(30);
  t.ok(d.api.state.submit.lastAttemptMs > 0, "the send stamped its attempt");
  await clickRetry(d);
  t.equal(creates(w).length, 0, "right after the failure: not sent");
  t.match(d.api.state.submit.message, /MFL can take a few minutes to list a new offer, so it was NOT sent again yet\..*try Retry in 5 minutes\./);
  t.equal(d.api.state.submit.canRetry, true);
  const realNow = Date.now, at = realNow(); Date.now = () => at;
  try {
    d.api.state.submit.lastAttemptMs = at - SETTLE_MS + 1000;
    await clickRetry(d);
    t.equal(creates(w).length, 0, "one second short: not sent");
    t.match(d.api.state.submit.message, /try Retry in 1 minute\./);
    d.api.state.submit.lastAttemptMs = at - SETTLE_MS;
    await clickRetry(d);
    t.equal(creates(w).length, 1, "at five minutes: sent");
  } finally { Date.now = realNow; }
  t.equal(w.mfl.st.pending.length, 1);
});

test("the wait never hides a landed offer, and an attempt that was never stamped can't prove anything", async () => {
  const w = pageWorld();
  let lose = true;
  const d = await bootDesktop(w, { token: "tok-B", fid: "0001", override: async (u, i, real) => { if (lose && isCreate(u, i)) { lose = false; await real(u, i); throw new TypeError("Failed to fetch"); } return null; } });
  readyOffer(d, "hi"); await d.api.submitOfferToQueue(); await settle(30);
  await clickRetry(d);
  t.match(d.api.state.submit.message, /^Already reached MFL/, "found immediately, no wait");
  const w2 = pageWorld();
  let fail = true;
  const d2 = await bootDesktop(w2, { token: "tok-B", fid: "0001", override: async (u, i) => (fail && isCreate(u, i) ? (fail = false, resp(503, { ok: false, error: "busy" })) : null) });
  readyOffer(d2, "hi"); await d2.api.submitOfferToQueue(); await settle(30);
  d2.api.state.submit.lastAttemptMs = 0;
  await clickRetry(d2);
  t.equal(creates(w2).length, 0, "no stamp: not sent");
});

await run("trade_war_room_retry_no_duplicate");
