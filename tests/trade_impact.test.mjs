// Trade impact arithmetic (site/shared/trade_impact.js): cap, roster counts and loaded contracts after a trade.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const I = require("../site/shared/trade_impact.js");
const before = { ceiling: 300000, capAlloc: 290000, activeN: 28, taxiN: 5, irN: 1, loadedN: 4, activeMax: 30 };
const P = (salary, o = {}) => Object.assign({ salary, hit: salary, isTaxi: false, isIr: false, loaded: false }, o);

test("sender falls by the hit of each player sent, receiver rises by full salary", () => {
  const r = I.capImpact(before, [P(10000)], [P(4000)], 0, 0);
  assert.equal(r.after.alloc, 284000); assert.equal(r.net, -6000); assert.equal(r.after.space, 16000);
  assert.equal(r.before.space, 10000);
});
test("taxi sends cost nothing; IR sends use the cap hit given (50%); arrivals are active at full salary", () => {
  const r = I.capImpact(before, [P(8000, { hit: 0, isTaxi: true }), P(10000, { hit: 5000, isIr: true })], [P(6000, { isTaxi: true })], 0, 0);
  assert.equal(r.sending, 5000); assert.equal(r.receiving, 6000); assert.equal(r.after.alloc, 291000);
  assert.deepEqual([r.after.active, r.after.taxi, r.after.ir], [29, 4, 0]);
});
test("cap money: charged to the sender, credited to the receiver", () => {
  assert.equal(I.capImpact(before, [P(10000)], [], 3, 0).after.alloc, 283000);
  assert.equal(I.capImpact(before, [], [P(10000)], 0, 3).after.alloc, 297000);
});
test("exactly at the cap is allowed; $1 over is over", () => {
  assert.equal(I.capImpact({ ...before, capAlloc: 290000 }, [], [P(10000)], 0, 0).overCap, false);
  assert.equal(I.capImpact({ ...before, capAlloc: 290000 }, [], [P(10001)], 0, 0).overCap, true);
});
test("loaded contracts: counted after, over five is flagged, unknown is never a pass", () => {
  assert.equal(I.capImpact(before, [], [P(1000, { loaded: true })], 0, 0).loadedOver, false);
  const two = I.capImpact(before, [], [P(1000, { loaded: true }), P(1000, { loaded: true })], 0, 0);
  assert.equal(two.after.loaded, 6); assert.equal(two.loadedOver, true);
  const unk = I.capImpact(before, [], [P(1000, { loaded: null })], 0, 0);
  assert.equal(unk.loadedKnown, false); assert.equal(unk.after.loaded, null); assert.equal(unk.loadedOver, false);
  assert.equal(I.capImpact(before, [P(1000, { loaded: true })], [], 0, 0).after.loaded, 3);
});
test("active roster over the max is reported (advisory)", () => {
  assert.equal(I.capImpact(before, [], [P(1), P(1), P(1)], 0, 0).activeOverMax, true);
  assert.equal(I.capImpact(before, [P(1)], [P(1)], 0, 0).activeOverMax, false);
});
