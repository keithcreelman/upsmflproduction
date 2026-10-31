/* Trade impact (Front Office Trade builder): what a proposed trade does to ONE team's cap and roster counts.
   Pure arithmetic over numbers the caller reads from the Front Office's own engines (UPS_FO.capFor for the "before",
   its cap-hit and loaded-contract functions for each player), so there is no second reading of the league rules here.
   The rules it applies are the ones the worker applies (docs: Trade War Room §cap):
     - the sender's cap falls by the cap hit of each player sent (taxi $0, IR 50%, as the Front Office counts them);
     - a traded player arrives ACTIVE at his full salary;
     - cap money is charged to the sender and credited to the receiver, this season only;
     - landing exactly at the cap is fine; over it needs the owner's acknowledgment (not a block);
     - loaded contracts: at most 5, counting IR and taxi (a hard block).
   This is a calculation for display. The server's verdict is the authority. Attaches window.UPS_TRADE_IMPACT. */
(function (root) {
  "use strict";
  var LOADED_MAX = 5;
  function n(v) { var x = Number(v); return isFinite(x) ? x : 0; }

  // before: { ceiling, capAlloc, activeN, taxiN, irN, loadedN, activeMax, activeMin, taxiMax }
  // out / in: [{ salary, hit?, isTaxi, isIr, loaded (true | false | null = unknown) }]
  // moneySentK / moneyReceivedK: whole $K of cap money this team sends / receives
  function capImpact(before, out, inn, moneySentK, moneyReceivedK) {
    out = out || []; inn = inn || [];
    var outHit = 0, inHit = 0, a = n(before.activeN), tx = n(before.taxiN), ir = n(before.irN), loaded = n(before.loadedN), unknown = false;
    out.forEach(function (p) {
      outHit += n(p.hit);
      if (p.isTaxi) tx -= 1; else if (p.isIr) ir -= 1; else a -= 1;
      if (p.loaded === null || p.loaded === undefined) unknown = true; else if (p.loaded) loaded -= 1;
    });
    inn.forEach(function (p) {
      inHit += n(p.salary);
      a += 1;                                              // arrives active, even from a taxi squad or IR
      if (p.loaded === null || p.loaded === undefined) unknown = true; else if (p.loaded) loaded += 1;
    });
    var sent = n(moneySentK) * 1000, got = n(moneyReceivedK) * 1000;
    var beforeAlloc = n(before.capAlloc), ceiling = n(before.ceiling);
    var afterAlloc = beforeAlloc - outHit + inHit + sent - got;
    var net = afterAlloc - beforeAlloc;
    var loadedKnown = !unknown && before.loadedN != null;
    return {
      sending: outHit, receiving: inHit, moneySent: sent, moneyReceived: got, net: net,
      before: { alloc: beforeAlloc, space: ceiling - beforeAlloc, active: n(before.activeN), taxi: n(before.taxiN), ir: n(before.irN), loaded: before.loadedN == null ? null : n(before.loadedN) },
      after: { alloc: afterAlloc, space: ceiling - afterAlloc, active: a, taxi: tx, ir: ir, loaded: loadedKnown ? loaded : null },
      ceiling: ceiling,
      overCap: afterAlloc > ceiling,                       // strictly over; exactly at the cap is allowed
      overCapBefore: beforeAlloc > ceiling,
      loadedKnown: loadedKnown, loadedOver: loadedKnown && loaded > LOADED_MAX, loadedMax: LOADED_MAX,
      activeOverMax: before.activeMax != null && a > n(before.activeMax), activeMax: before.activeMax, taxiMax: before.taxiMax
    };
  }

  var api = { capImpact: capImpact, LOADED_MAX: LOADED_MAX };
  root.UPS_TRADE_IMPACT = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : this);
