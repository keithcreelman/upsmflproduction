// War Room two-team Retry never sends the same offer twice (S6b; site/trades/trade_workbench.js retryLastSubmitRequest).
// Before resending, Retry reloads the owner's outgoing offers and compares partner, assets and cap money in dollars; a
// match means the first send already reached MFL. If the list can't load, Retry refuses (fail closed). The resend goes
// through submitTradeCreateWithGates, so the loaded-contract, cap-acknowledgment and staging steps apply.
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
  await clickRetry(d);
  t.equal(creates(w).length, 1, "once the list loads (no match), Retry sends");
  t.equal(w.mfl.st.pending.length, 1);
});

await run("trade_war_room_retry_no_duplicate");
