// SALARY-CAP OVERAGE ACKNOWLEDGMENT — dedicated, defect-sensitive coverage of the acknowledge-don't-block
// mechanism itself (worker/src/trade_cap_ack.js + its three integration points), separate from
// tests/trade_cap_gate.test.mjs (which re-proves the cap CALCULATION and exercises the mechanism as part of
// the normal accept/execute flow). This file drills into the properties Keith's ruling (2026-09-28) requires
// that are easiest to get subtly wrong:
//   node tests/trade_cap_acknowledgment.test.mjs
//
// RULING: a proven post-trade salary-cap overage is displayed and must be explicitly acknowledged by the
// AFFECTED franchise's own owner, but never itself blocks the trade. The initiator acknowledges their own
// overage when creating an offer; each receiving owner acknowledges their own at accept; a 3-way trade
// acknowledges each affected franchise SEPARATELY. Recalculated fresh at every accept/execution point; a
// changed projected amount invalidates a prior acknowledgment; a missing or forged acknowledgment is refused
// BEFORE any MFL write; an unavailable cap calculation is NEVER treated as acknowledged/satisfied.
//
// Part 1  the pure primitives (capAckSignature, evaluateCapAcknowledgment) — no D1, no fetch
// Part 2  2-way: the INITIATOR's own acknowledgment, at creation, carried through to accept
// Part 3  2-way: the RECIPIENT's own acknowledgment, inline at accept — and that it cannot cover the sender
// Part 4  2-way: ACK_CAP is usable by either party, on their own violation only, and never writes MFL
// Part 5  3-way: each of the three franchises' acknowledgment is independent (one can't cover another's)
// Part 6  cross-trade / cross-franchise: a signature from elsewhere never transfers
// Part 7  fail-closed: an unavailable cap calculation is never satisfied by any acknowledgment
// Part 8  the underlying cap/roster calculation itself is untouched by this feature
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, bindSelf, quiet } from "./fixtures/worker_harness.mjs";
import * as F from "./fixtures/trade_3way_fixture.mjs";
import { capAckSignature, evaluateCapAcknowledgment } from "../worker/src/trade_cap_ack.js";
await import("./fixtures/register_md_loader.mjs");
const { handle3WayButton, execute3Way } = await import("../worker/src/trade_3way.js");

const restore = quiet();
const Q = "L=74598&YEAR=2026";
const CAP = 300000;

// ───────────────────────────────── Part 1 — the pure primitives ─────────────────────────────────
test("capAckSignature: a deterministic fingerprint of (trade, franchise, amount over, projected total) — nothing else moves it", () => {
  const base = { tradeKey: "abc", franchiseId: "0001", amountOver: 10000, usedAfter: 310000 };
  const sig = capAckSignature(base);
  t.equal(typeof sig, "string"); t.ok(sig.length > 0);
  t.equal(capAckSignature(base), sig, "same inputs -> same signature, every time");
  t.notEqual(capAckSignature({ ...base, tradeKey: "xyz" }), sig, "a different trade changes it");
  t.notEqual(capAckSignature({ ...base, franchiseId: "0002" }), sig, "a different franchise changes it");
  t.notEqual(capAckSignature({ ...base, amountOver: 10001 }), sig, "a one-dollar-different overage changes it");
  t.notEqual(capAckSignature({ ...base, usedAfter: 310001 }), sig, "a one-dollar-different projected total changes it");
  // rounds fractional cents the same way the cap math does, so a float vs. its rounded int agree
  t.equal(capAckSignature({ ...base, amountOver: 9999.6 }), capAckSignature({ ...base, amountOver: 10000 }));
});
test("evaluateCapAcknowledgment: PURE — missing / stale / acknowledged, and a franchise with NO current violation needs nothing regardless of what's stored", () => {
  const violations = [
    { franchise_id: "0001", franchise_name: "L.A. Looks", amount_over: 10000, projected_used: 310000 },
    { franchise_id: "0002", franchise_name: "CBP", amount_over: 500, projected_used: 300500 },
  ];
  // nothing stored at all
  let out = evaluateCapAcknowledgment({ violations, tradeKey: "t1", acks: {} });
  t.equal(out.satisfied, false);
  t.deepEqual(out.perFranchise.map((f) => [f.franchise_id, f.status]), [["0001", "missing"], ["0002", "missing"]]);
  // one acknowledged with the CURRENT signature, one not
  const sig1 = capAckSignature({ tradeKey: "t1", franchiseId: "0001", amountOver: 10000, usedAfter: 310000 });
  out = evaluateCapAcknowledgment({ violations, tradeKey: "t1", acks: { "0001": { signature: sig1, acknowledged_by_fid: "0001", acknowledged_at_utc: "x" } } });
  t.equal(out.satisfied, false);
  t.equal(out.perFranchise.find((f) => f.franchise_id === "0001").status, "acknowledged");
  t.equal(out.perFranchise.find((f) => f.franchise_id === "0002").status, "missing");
  // a STORED signature that doesn't match the CURRENT figures (the numbers moved since) is "stale", not "acknowledged"
  out = evaluateCapAcknowledgment({ violations, tradeKey: "t1", acks: { "0001": { signature: "some-old-signature-from-before", acknowledged_by_fid: "0001", acknowledged_at_utc: "x" } } });
  t.equal(out.perFranchise.find((f) => f.franchise_id === "0001").status, "stale");
  t.equal(out.satisfied, false);
  // both acknowledged with current signatures -> satisfied
  const sig2 = capAckSignature({ tradeKey: "t1", franchiseId: "0002", amountOver: 500, usedAfter: 300500 });
  out = evaluateCapAcknowledgment({ violations, tradeKey: "t1", acks: { "0001": { signature: sig1 }, "0002": { signature: sig2 } } });
  t.equal(out.satisfied, true);
  t.ok(out.perFranchise.every((f) => f.status === "acknowledged"));
  // a franchise with a stored ack but NO current violation needs nothing at all (old ack for a violation that's gone)
  out = evaluateCapAcknowledgment({ violations: [violations[1]], tradeKey: "t1", acks: { "0001": { signature: sig1 }, "0002": { signature: "irrelevant" } } });
  t.equal(out.perFranchise.length, 1, "only franchises with a CURRENT violation are ever reported");
  t.equal(out.perFranchise[0].franchise_id, "0002");
});

// ───────────────────────────────── shared 2-way world (mirrors trade_cap_gate.test.mjs) ─────────────────────────────────
const player = (pid, salary = 5000, extra) => ({ asset_id: `P_${pid}`, type: "PLAYER", player_id: String(pid), player_name: `P${pid}`, salary, taxi: false, contract_info: "", ...(extra || {}) });
const payloadOf = (from, to, give, recv) => ({
  schema_version: 1, source: "test", league_id: "74598", season: "2026",
  teams: [
    { role: "left", franchise_id: from, selected_assets: give, traded_salary_adjustment_k: 0, traded_salary_adjustment_dollars: 0, selected_non_taxi_salary_dollars: 5000 },
    { role: "right", franchise_id: to, selected_assets: recv, traded_salary_adjustment_k: 0, traded_salary_adjustment_dollars: 0, selected_non_taxi_salary_dollars: 5000 },
  ],
  extension_requests: [], ui: { left_team_id: from, right_team_id: to }, validation: { status: "ready" },
});
const SWAP = () => payloadOf("0001", "0002", [player(14056)], [player(13100)]);
function world(mfl, o) {
  o = o || {};
  mfl.st.rosters["0001"] = [{ id: "14056", salary: o.s1 == null ? 5000 : o.s1 }, ...(o.fill1 ? [{ id: "90001", salary: o.fill1 }] : [])];
  mfl.st.rosters["0002"] = [{ id: "13100", salary: o.s2 == null ? 5000 : o.s2 }, ...(o.fill2 ? [{ id: "90002", salary: o.fill2 }] : [])];
}
function fresh() {
  const env = makeWorkerEnv();
  const mfl = makeMfl({ tokens: { "tok-H": "0012" } });
  mfl.install();
  return { env, mfl };
}
const createBody = (payload) => ({ league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002", from_franchise_name: "x", to_franchise_name: "y", message: "", payload });
const create = (env, body) => callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, { body });
const mobileBody = (id, action, actorFid, tok) => ({ action: action || "ACCEPT", trade_id: id, league_id: "74598", franchise_id: actorFid || "0002", year: "2026", message: "" });
const act = (env, body, tok) => callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=${tok || "tok-C"}`, { body });
const outbox = (env) => env.UPS_MFL_DB.raw.prepare("SELECT action_type, status FROM twb_trade_outbox ORDER BY rowid").all();
function nothingHappened(mfl, env, label) {
  t.equal(mfl.st.done.length, 0, `${label}: MFL never accepted`);
  t.equal(mfl.writes("tradeResponse").length, 0, `${label}: no tradeResponse import`);
  t.equal(mfl.writes("salaryAdj").length, 0, `${label}: no salary adjustment import`);
  t.equal(mfl.writes("salaries").length, 0, `${label}: no contract import`);
  t.equal(outbox(env).filter((r) => r.action_type === "ACCEPT").length, 0, `${label}: no ACCEPT row written`);
  t.equal(outbox(env).filter((r) => ["VERIFIED", "COMPLETED"].includes(r.status)).length, 0, `${label}: nothing recorded as completed`);
}

// ───────────────────────────────── Part 2 — 2-way INITIATOR acknowledgment (at creation) ─────────────────────────────────
test("2-WAY CREATE: missing acknowledgment refuses creation (409), nothing sent to MFL, nothing pending", async () => {
  const { env, mfl } = fresh(); world(mfl, { s1: 5000, s2: 20000, fill1: 290000, fill2: 100000 });   // sender (0001) would be $10,000 over
  const r = await create(env, createBody(SWAP()));
  t.equal(r.status, 409); t.equal(r.json.code, "cap_overage_ack_required"); t.equal(r.json.ok, false);
  t.equal(r.json.cap_ack_needed.franchise_id, "0001"); t.equal(r.json.cap_ack_needed.amount_over, 10000);
  t.ok(r.json.cap_ack_needed.signature, "the exact signature to send back is handed to the client");
  t.equal(mfl.st.pending.length, 0); t.equal(mfl.writes().length, 0, "zero MFL writes of any kind");
});
test("2-WAY CREATE: a FORGED acknowledgment signature is refused — creating an offer with a made-up string does not bypass it", async () => {
  const { env, mfl } = fresh(); world(mfl, { s1: 5000, s2: 20000, fill1: 290000, fill2: 100000 });
  for (const forged of ["", "0", "null", "totally-made-up", "0001|abc|10000|310000"]) {
    const r = await create(env, { ...createBody(SWAP()), cap_ack: { signature: forged } });
    t.equal(r.status, 409, `forged signature "${forged}" is refused`); t.equal(r.json.code, "cap_overage_ack_required");
  }
  t.equal(mfl.st.pending.length, 0); t.equal(mfl.writes().length, 0);
});
test("2-WAY CREATE: the CORRECT (server-issued) signature creates the offer, and the acknowledgment is REUSED unchanged at accept", async () => {
  const { env, mfl } = fresh(); world(mfl, { s1: 5000, s2: 20000, fill1: 290000, fill2: 100000 });
  const r0 = await create(env, createBody(SWAP()));
  const r1 = await create(env, { ...createBody(SWAP()), cap_ack: { signature: r0.json.cap_ack_needed.signature } });
  t.equal(r1.status, 201, r1.text.slice(0, 200));
  t.equal(mfl.st.pending.length, 1, "the offer WAS created once acknowledged");
  const id = mfl.st.pending[0].trade_id;
  // nothing changed since -> accept succeeds without asking the sender again (their creation-time ack still covers it)
  const r2 = await act(env, mobileBody(id));
  t.equal(r2.status, 200, r2.text.slice(0, 200)); t.equal(mfl.st.done.length, 1);
  t.equal(r2.json.compliance.cap.rows.find((x) => x.franchise_id === "0001").used_after, 310000, "still shown, never hidden, even though acknowledged");
});
test("2-WAY CREATE→ACCEPT: if the SENDER's projected figure changes after creation, the earlier acknowledgment goes STALE and accept is refused again", async () => {
  const { env, mfl } = fresh(); world(mfl, { s1: 5000, s2: 20000, fill1: 290000, fill2: 100000 });   // $10,000 over
  const r0 = await create(env, createBody(SWAP()));
  const r1 = await create(env, { ...createBody(SWAP()), cap_ack: { signature: r0.json.cap_ack_needed.signature } });
  t.equal(r1.status, 201); const id = mfl.st.pending[0].trade_id;
  // the sender's payroll grows further before the recipient gets to it
  mfl.st.rosters["0001"].push({ id: "90099", salary: 1 });
  const r2 = await act(env, mobileBody(id));
  t.equal(r2.status, 409, "the STALE creation-time acknowledgment no longer covers the NEW figure");
  t.equal(r2.json.code, "cap_overage_ack_required");
  t.equal(r2.json.cap_ack.find((f) => f.franchise_id === "0001").status, "stale");
  nothingHappened(mfl, env, "stale initiator acknowledgment");
});
test("2-WAY CREATE: an unavailable cap calculation is NOT gated at creation (unrelated to what creation has ever depended on) — fail-closed is enforced at PREVIEW/ACCEPT instead", async () => {
  const { env, mfl } = fresh(); world(mfl, { fill1: 100000, fill2: 100000 });
  mfl.st.exportFail = { salaryAdjustments: 500 };
  const r = await create(env, createBody(SWAP()));
  t.equal(r.status, 201, r.text.slice(0, 200));
  const id = mfl.st.pending[0].trade_id;
  const acc = await act(env, mobileBody(id));
  t.equal(acc.status, 503, "the fail-closed guarantee still holds -- just at accept, where it always has"); t.equal(acc.json.code, "cap_check_unavailable");
  nothingHappened(mfl, env, "unavailable at accept");
});

// ───────────────────────────────── Part 3 — 2-way RECIPIENT acknowledgment (inline at accept) ─────────────────────────────────
test("2-WAY ACCEPT: the RECIPIENT's missing acknowledgment refuses (409), zero MFL writes", async () => {
  const { env, mfl } = fresh(); world(mfl, { s1: 20000, s2: 5000, fill1: 100000, fill2: 290000 });   // recipient (0002) $10,000 over
  const r0 = await create(env, createBody(SWAP())); t.equal(r0.status, 201);
  const id = mfl.st.pending[0].trade_id;
  const r = await act(env, mobileBody(id));
  t.equal(r.status, 409); t.equal(r.json.code, "cap_overage_ack_required");
  t.equal(r.json.cap_ack[0].franchise_id, "0002"); t.equal(r.json.cap_ack[0].status, "missing");
  nothingHappened(mfl, env, "recipient missing ack");
});
test("2-WAY ACCEPT: a FORGED acknowledgment signature on the accept body is refused, never trusted", async () => {
  const { env, mfl } = fresh(); world(mfl, { s1: 20000, s2: 5000, fill1: 100000, fill2: 290000 });
  const r0 = await create(env, createBody(SWAP())); const id = mfl.st.pending[0].trade_id;
  for (const forged of ["", "made-up", "0002|xyz|10000|310000"]) {
    const r = await act(env, { ...mobileBody(id), cap_ack: { signature: forged } });
    t.equal(r.status, 409, `forged "${forged}" refused`); t.equal(r.json.code, "cap_overage_ack_required");
  }
  nothingHappened(mfl, env, "recipient forged ack");
});
test("2-WAY ACCEPT: the CORRECT signature (as PREVIEW hands back) satisfies the recipient's own overage inline, in the SAME request", async () => {
  const { env, mfl } = fresh(); world(mfl, { s1: 20000, s2: 5000, fill1: 100000, fill2: 290000 });
  const r0 = await create(env, createBody(SWAP())); const id = mfl.st.pending[0].trade_id;
  const p = await act(env, mobileBody(id, "PREVIEW"));
  t.equal(p.status, 200); t.equal(p.json.cap_ack.satisfied, false);
  const sig = p.json.cap_ack.per_franchise.find((f) => f.franchise_id === "0002").signature;
  const r = await act(env, { ...mobileBody(id), cap_ack: { signature: sig } });
  t.equal(r.status, 200, r.text.slice(0, 200)); t.equal(mfl.st.done.length, 1);
});
test("2-WAY ACCEPT: the RECIPIENT's own inline acknowledgment does NOT cover a SENDER-side overage they don't control", async () => {
  // both sides over cap: the recipient's signature only ever targets their OWN franchise
  const { env, mfl } = fresh(); world(mfl, { s1: 20000, s2: 20000, fill1: 290000, fill2: 290000 });
  const r0 = await create(env, createBody(SWAP()), {});
  t.equal(r0.status, 409, "the SENDER side alone already gates creation"); t.equal(r0.json.cap_ack_needed.franchise_id, "0001");
  const r1 = await create(env, { ...createBody(SWAP()), cap_ack: { signature: r0.json.cap_ack_needed.signature } });
  t.equal(r1.status, 201, r1.text.slice(0, 200)); const id = mfl.st.pending[0].trade_id;
  // now the recipient tries to accept -- their OWN inline signature can't also satisfy the sender's (already-acknowledged, separately) side; confirm both are tracked
  const p = await act(env, mobileBody(id, "PREVIEW"));
  t.equal(p.json.cap_ack.per_franchise.length, 2, "BOTH franchises' overage is tracked, not merged into one");
  const mine = p.json.cap_ack.per_franchise.find((f) => f.franchise_id === "0002");
  const theirs = p.json.cap_ack.per_franchise.find((f) => f.franchise_id === "0001");
  t.equal(mine.status, "missing"); t.equal(theirs.status, "acknowledged", "the sender's creation-time acknowledgment already covers their own side");
  const r = await act(env, { ...mobileBody(id), cap_ack: { signature: mine.signature } });
  t.equal(r.status, 200, r.text.slice(0, 200)); t.equal(mfl.st.done.length, 1);
});

// ───────────────────────────────── Part 4 — 2-way ACK_CAP (either party, own violation only) ─────────────────────────────────
test("2-WAY ACK_CAP: either party may acknowledge their OWN current violation; it never writes to MFL; 'nothing to acknowledge' when there isn't one", async () => {
  const { env, mfl } = fresh(); world(mfl, { s1: 20000, s2: 5000, fill1: 100000, fill2: 290000 });   // recipient (0002) over
  const r0 = await create(env, createBody(SWAP())); const id = mfl.st.pending[0].trade_id;
  // the SENDER (0001, tok-B) has nothing to acknowledge
  const bAsk = await act(env, { action: "ACK_CAP", trade_id: id, league_id: "74598", franchise_id: "0001", year: "2026" }, "tok-B");
  t.equal(bAsk.status, 200); t.equal(bAsk.json.code, "nothing_to_acknowledge");
  // the RECIPIENT (0002, tok-C) acknowledges explicitly (not via the accept body)
  const cAsk = await act(env, { action: "ACK_CAP", trade_id: id, league_id: "74598", franchise_id: "0002", year: "2026" }, "tok-C");
  t.equal(cAsk.status, 200); t.equal(cAsk.json.code, "acknowledged"); t.equal(cAsk.json.cap_ack.franchise_id, "0002"); t.equal(cAsk.json.cap_ack.amount_over, 10000);
  // the offer CREATE itself already posted a legitimate MFL trade proposal; ACK_CAP must add
  // NOTHING beyond that -- no tradeResponse (accept), no salary adjustment, no contract import
  t.equal(mfl.writes("tradeResponse").length, 0, "ACK_CAP never accepts anything in MFL");
  t.equal(mfl.writes("salaryAdj").length, 0, "ACK_CAP never posts a salary adjustment");
  t.equal(mfl.writes("salaries").length, 0, "ACK_CAP never posts a contract import");
  t.equal(mfl.st.done.length, 0, "ACK_CAP never completes the trade");
  // now a plain accept (no inline signature at all) succeeds, since it was already persisted
  const r = await act(env, mobileBody(id));
  t.equal(r.status, 200, r.text.slice(0, 200)); t.equal(mfl.st.done.length, 1);
});
test("2-WAY ACK_CAP: a third party (neither side of the offer) cannot acknowledge on anyone's behalf", async () => {
  const { env, mfl } = fresh(); world(mfl, { s1: 20000, s2: 5000, fill1: 100000, fill2: 290000 });
  const r0 = await create(env, createBody(SWAP())); const id = mfl.st.pending[0].trade_id;
  const stranger = await act(env, { action: "ACK_CAP", trade_id: id, league_id: "74598", franchise_id: "0003", year: "2026" }, "tok-O");
  t.ok([403, 404, 409].includes(stranger.status), `a non-party is refused (${stranger.status})`);
  nothingHappened(mfl, env, "third-party ACK_CAP");
});

// ───────────────────────────────── Part 5 — 3-way: each franchise's acknowledgment is independent ─────────────────────────────────
const DISCORD = F.DISCORD;
function threeWayWorld(o) {
  o = o || {};
  const env = makeWorkerEnv({ TRADE_3WAY_EXECUTE: o.live ? "1" : "0", ...(o.env || {}) });
  const mfl = makeMfl({ tokens: { "tok-H": "0012" } }); mfl.install();
  bindSelf(env);
  for (const [fid, d] of [["0008", DISCORD.A], ["0001", DISCORD.B], ["0012", DISCORD.C]]) env.UPS_MFL_DB.raw.prepare("INSERT INTO discord_owners VALUES (?,?,?)").run(fid, "Y", d);
  const legs = [{ from: "0008", to: "0001", asset_tokens: ["P_16614"], cap_k: 0, summary: "P16614" }, { from: "0001", to: "0012", asset_tokens: ["P_16181"], cap_k: 0, summary: "P16181" }, { from: "0012", to: "0008", asset_tokens: ["P_16650"], cap_k: 0, summary: "P16650" }];
  F.seedTrade(env, { legs_json: JSON.stringify(legs), ...(o.row || {}) });
  const s = o.sal || {};
  mfl.st.rosters = {
    "0008": [{ id: "16614", salary: s.a1 == null ? 5000 : s.a1 }, ...(o.fillA ? [{ id: "90008", salary: o.fillA }] : [])],
    "0001": [{ id: "16181", salary: s.b1 == null ? 5000 : s.b1 }, ...(o.fillB ? [{ id: "90001", salary: o.fillB }] : [])],
    "0012": [{ id: "16650", salary: s.c1 == null ? 5000 : s.c1 }, ...(o.fillC ? [{ id: "90012", salary: o.fillC }] : [])],
  };
  return { env, mfl };
}
const press = (action, userId) => ({ data: { custom_id: `tr3:${action}:${F.TRADE_ID}` }, member: { user: { id: userId } } });
const say = async (resp) => (await resp.json()).data.content;
const ctxWait = () => { const p = []; return { waitUntil: (x) => p.push(x), flush: () => Promise.all(p) }; };
const ackCap = (env, tok) => callWorker(env, "POST", `/api/trades/3way/ack-cap?${Q}&MFL_USER_ID=${tok}`, { body: { id: F.TRADE_ID } });
const recheck = (env, tok) => callWorker(env, "POST", `/api/trades/3way/recheck?${Q}&MFL_USER_ID=${tok || "tok-A"}`, { body: { id: F.TRADE_ID } });
async function bothAccept(env, ctx) {
  await say(await handle3WayButton(press("accept", DISCORD.B), env, ctx));
  return say(await handle3WayButton(press("accept", DISCORD.C), env, ctx));
}
test("3-WAY: TWO franchises over cap at once — each must acknowledge SEPARATELY; one acknowledging does not satisfy the other", async () => {
  // A(0008) sends 16614(5000) receives 16650(c1) ; B(0001) sends 16181(b1) receives 16614(5000) ; C(0012) sends 16650(c1) receives 16181(b1)
  // make A over (huge fillA + receives an expensive 16650) AND B over (huge fillB + receives an expensive 16181... wait B receives 16614 which is fixed at 5000) -- use A and C over instead: A receives 16650 (c1, large); C receives 16181 (b1, large)
  const { env, mfl } = threeWayWorld({ live: true, sal: { a1: 5000, b1: 20000, c1: 20000 }, fillA: 285000, fillB: 100000, fillC: 285000 });
  // A: 5000+285000 -5000(sends 16614)+20000(receives 16650,c1) = 305000 (over by 5000)
  // C: 20000+285000 -20000(sends 16650)+20000(receives 16181,b1) = 305000 (over by 5000)
  const ctx = ctxWait();
  const msg = await bothAccept(env, ctx);
  await ctx.flush();
  t.match(msg, /that's everyone/);
  const detail = await callWorker(env, "GET", `/api/trades/3way?id=${F.TRADE_ID}&${Q}&MFL_USER_ID=tok-A`);
  const ack0 = detail.json.trade.execution.block.cap_ack;
  t.equal(ack0.length, 2, "both A (0008) and C (0012) are tracked, independently");
  t.deepEqual(ack0.map((f) => f.franchise_id).sort(), ["0008", "0012"]);
  t.ok(ack0.every((f) => f.status === "missing"));
  // C (Hawks, tok-H) acknowledges -- A's requirement is UNCHANGED
  const ackC = await ackCap(env, "tok-H");
  t.equal(ackC.status, 200); t.equal(ackC.json.cap_ack.franchise_id, "0012");
  const stillA = await recheck(env);
  t.equal(stillA.status, 409, "A (0008) has not acknowledged -- still blocked");
  t.match(stillA.json.message, /to acknowledge/);
  t.equal(mfl.writes().length, 0);
  const detail2 = await callWorker(env, "GET", `/api/trades/3way?id=${F.TRADE_ID}&${Q}&MFL_USER_ID=tok-A`);
  const ack1 = detail2.json.trade.execution.block.cap_ack;
  t.equal(ack1.find((f) => f.franchise_id === "0012").status, "acknowledged");
  t.equal(ack1.find((f) => f.franchise_id === "0008").status, "missing", "A's own status is untouched by C's acknowledgment");
  // A (tok-A) acknowledges -- now both satisfied, recheck runs it
  const ackA = await ackCap(env, "tok-A");
  t.equal(ackA.status, 200); t.equal(ackA.json.cap_ack.franchise_id, "0008");
  env.TRADE_3WAY_EXECUTE = "0";
  const now = await recheck(env);
  t.equal(now.status, 200, now.text.slice(0, 200)); t.equal(now.json.code, "rechecking");
  t.equal(F.readRow(env).status, "completed");
});
test("3-WAY ACK_CAP: a stranger (not one of the three participants) is refused, and cannot acknowledge on a participant's behalf", async () => {
  const { env, mfl } = threeWayWorld({ live: true, sal: { a1: 5000, b1: 20000, c1: 5000 }, fillA: 100000, fillB: 100000, fillC: 285000 });
  const ctx = ctxWait();
  await bothAccept(env, ctx); await ctx.flush();
  const stranger = await ackCap(env, "tok-O");   // 0003, not in this trade at all
  t.ok([401, 403, 404].includes(stranger.status), `a non-participant is refused (${stranger.status})`);
  t.equal(mfl.writes().length, 0);
  const still = await recheck(env);
  t.equal(still.status, 409, "the real violation is still unacknowledged");
});
test("3-WAY ACK_CAP: acknowledging is IDEMPOTENT and re-acknowledging after the figure changes replaces the old signature (stale never silently counts)", async () => {
  const { env, mfl } = threeWayWorld({ live: true, sal: { a1: 5000, b1: 20000, c1: 5000 }, fillA: 100000, fillB: 100000, fillC: 285000 });
  const ctx = ctxWait();
  await bothAccept(env, ctx); await ctx.flush();
  const first = await ackCap(env, "tok-H");
  t.equal(first.status, 200); const sig1 = first.json.cap_ack.signature;
  const again = await ackCap(env, "tok-H");
  t.equal(again.status, 200); t.equal(again.json.cap_ack.signature, sig1, "identical figures -> identical signature (idempotent)");
  // the figure changes (more dead money added for Hawks)
  mfl.st.salaryAdjustments = [{ franchise_id: "0012", amount: "1000", description: "extra dead money" }];
  const third = await ackCap(env, "tok-H");
  t.equal(third.status, 200); t.notEqual(third.json.cap_ack.signature, sig1, "a different figure gets a different signature");
  t.equal(third.json.cap_ack.amount_over, 6000);
  env.TRADE_3WAY_EXECUTE = "0";
  const now = await recheck(env);
  t.equal(now.status, 200, now.text.slice(0, 200));
  t.equal(F.readRow(env).status, "completed", "it executes still $6,000 over cap -- the overage itself never blocks, only the missing acknowledgment did");
});

// ───────────────────────────────── Part 6 — cross-trade / cross-franchise: a signature never transfers ─────────────────────────────────
test("CROSS-TRADE: a valid signature from ONE offer does not satisfy a genuinely DIFFERENT offer, even with the same dollar figures", async () => {
  const { env: e1, mfl: m1 } = fresh(); world(m1, { s1: 20000, s2: 5000, fill1: 100000, fill2: 290000 });
  const r1 = await create(e1, createBody(SWAP())); const id1 = m1.st.pending[0].trade_id;
  const p1 = await act(e1, mobileBody(id1, "PREVIEW"));
  const sig1 = p1.json.cap_ack.per_franchise[0].signature;

  // a DIFFERENT trade (different assets -> a different payload_hash / trade_key), engineered to
  // land on the SAME dollar figures ($10,000 over CBP's cap) as trade 1, so only the trade identity differs.
  const { env: e2, mfl: m2 } = fresh();
  m2.st.rosters["0001"] = [{ id: "77001", salary: 20000 }, { id: "90001", salary: 100000 }];
  m2.st.rosters["0002"] = [{ id: "77002", salary: 5000 }, { id: "90002", salary: 290000 }];
  const otherPayload = payloadOf("0001", "0002", [player(77001, 20000)], [player(77002, 5000)]);
  const r2 = await create(e2, createBody(otherPayload)); const id2 = m2.st.pending[0].trade_id;
  const p2 = await act(e2, mobileBody(id2, "PREVIEW"));
  t.equal(p2.json.cap_ack.per_franchise[0].amount_over, 10000, "same dollar figures as trade 1 -- only the trade identity differs");
  const bad = await act(e2, { ...mobileBody(id2), cap_ack: { signature: sig1 } });
  t.equal(bad.status, 409, "a signature computed for a DIFFERENT trade_id does not carry over, even with the same amounts");
  t.equal(m2.st.done.length, 0);
});
test("CROSS-FRANCHISE: a franchise's own valid signature does not satisfy a DIFFERENT franchise's requirement", async () => {
  const { env, mfl } = fresh(); world(mfl, { s1: 20000, s2: 20000, fill1: 290000, fill2: 290000 });   // both over
  const r0 = await create(env, createBody(SWAP()));
  const r1 = await create(env, { ...createBody(SWAP()), cap_ack: { signature: r0.json.cap_ack_needed.signature } });
  t.equal(r1.status, 201); const id = mfl.st.pending[0].trade_id;
  // try to satisfy the RECIPIENT's (0002) requirement using the SENDER's (0001) already-used signature
  const p = await act(env, mobileBody(id, "PREVIEW"));
  const senderSig = p.json.cap_ack.per_franchise.find((f) => f.franchise_id === "0001").signature;
  const bad = await act(env, { ...mobileBody(id), cap_ack: { signature: senderSig } });
  t.equal(bad.status, 409, "0001's signature does not satisfy 0002's requirement");
  t.equal(mfl.st.done.length, 0);
});

// ───────────────────────────────── Part 7 — fail-closed: unavailable is NEVER satisfied ─────────────────────────────────
test("FAIL-CLOSED: an unavailable cap calculation at accept is never treated as satisfied, even with a cap_ack claim attached", async () => {
  const { env, mfl } = fresh(); world(mfl, { fill1: 100000, fill2: 100000 });
  const r0 = await create(env, createBody(SWAP())); const id = mfl.st.pending[0].trade_id;
  mfl.st.exportFail = { salaryAdjustments: 500 };
  const r = await act(env, { ...mobileBody(id), cap_ack: { signature: "anything-at-all", satisfied: true } });
  t.equal(r.status, 503); t.equal(r.json.code, "cap_check_unavailable"); t.equal(r.json.compliance.cap.status, "unavailable");
  nothingHappened(mfl, env, "unavailable + a claimed ack");
});
test("FAIL-CLOSED (3-way): an unavailable cap calculation at execute is never treated as satisfied", async () => {
  const { env, mfl } = threeWayWorld({ live: true, fillA: 100000, fillB: 100000, fillC: 100000 });
  mfl.st.exportFail = { salaryAdjustments: 500 };
  const ctx = ctxWait();
  await bothAccept(env, ctx); await ctx.flush();
  const led = env.UPS_MFL_DB.raw.prepare("SELECT * FROM ups_trade_executions WHERE exec_key=?").get(F.TRADE_ID);
  t.equal(led.state, "blocked_cap"); t.equal(JSON.parse(led.block_json).kind, "unavailable");
  t.equal(mfl.writes().length, 0);
  const stranger = await ackCap(env, "tok-A");
  t.equal(stranger.status, 503, "acknowledging is refused too -- there's no violation figure to acknowledge while unavailable"); t.equal(stranger.json.code, "cap_check_unavailable");
});

// ───────────────────────────────── Part 8 — the underlying calculation is untouched ─────────────────────────────────
test("SOURCE: trade_cap_authority.js (the cap/roster CALCULATION) carries no acknowledgment logic -- this feature is a layer above it, not a change to it", () => {
  const src = fs.readFileSync(new URL("../worker/src/trade_cap_authority.js", import.meta.url), "utf8");
  t.doesNotMatch(src, /cap_ack|acknowledg|trade_cap_ack/i, "the pure compliance calculation never mentions acknowledgment at all");
});
test("SOURCE: trade_cap_ack.js never trusts a client claim of 'acknowledged' -- every write requires proven caller identity, and reads only ever compare against a FRESH server-computed signature", () => {
  const src = fs.readFileSync(new URL("../worker/src/trade_cap_ack.js", import.meta.url), "utf8");
  t.match(src, /export function capAckSignature/); t.match(src, /export function evaluateCapAcknowledgment/); t.match(src, /export function makeCapAckStore/);
  t.doesNotMatch(src, /body\.(cap_ack|acknowledged)/, "this module itself never reads a request body -- callers pass in already-verified figures");
});

await run("trade_cap_acknowledgment");
restore();
