// League Record S1: trade PACKAGES and what may and may not be credited to one asset of a package.
//
// A trade is one transaction between franchises. Every asset a franchise gave up was given up for everything it got back, together. The record states no allocation among the assets,
// so this module keeps three things apart (Keith's ruling, 2026-11-20):
//   1. DIRECT CONSIDERATION: everything a franchise received in exchange for the COMPLETE set it surrendered in that transaction (cap money included, in its direction).
//   2. LINEAGE PARTICIPATION: a traced asset took part in that transaction. It says where the asset went and what travelled with it; it says nothing about value.
//   3. ATTRIBUTABLE ECONOMIC RETURN: the value reasonably assignable to ONE asset. It is ESTABLISHED only when the transaction itself pairs the assets (exactly one asset each way and no cap
//      money in the trade). In every other package it is NOT_ESTABLISHED and nothing is allocated: no incoming asset, point total, salary or cap amount is credited to a single outgoing
//      asset, and no outgoing asset is said to have "become" or "bought" an incoming one.
// Nothing here invents a split. The numbers it returns are counts and the recorded cap amounts.

export const ALLOCATION = Object.freeze({ ESTABLISHED: "ESTABLISHED_ONE_FOR_ONE", NOT_ESTABLISHED: "NOT_ESTABLISHED" });

// trade: { id, date, time, date_quality, source, parties, legs: [{ asset, from, to, label? }], cap: [{ amount, from, to }] }.
// labelOf(assetId) gives a readable label. Returns the package view of every party.
export function packageView(trade, labelOf = (a) => a) {
  const lab = (l) => ({ asset: l.asset, kind: l.kind || null, label: (l.label ? `${l.label}` : null) || labelOf(l.asset) });
  const sides = (trade.parties || []).map((p) => {
    const sent = trade.legs.filter((l) => l.from === p && l.asset).map(lab);
    const received = trade.legs.filter((l) => l.to === p && l.asset).map(lab);
    const capSent = trade.cap.filter((c) => c.from === p).map((c) => c.amount);
    const capReceived = trade.cap.filter((c) => c.to === p).map((c) => c.amount);
    const hasCap = trade.cap.length > 0;
    const pairs = sent.length === 1 && received.length === 1 && !hasCap && trade.legs.every((l) => l.to && l.asset);
    const n = sent.length + capSent.length, m = received.length + capReceived.length;
    return {
      franchise: p, sent, received, cap_sent: capSent, cap_received: capReceived, assets_sent: n, assets_received: m,
      direct_consideration: { surrendered_in_full: sent.map((x) => x.asset).concat(capSent.map((c) => `cap:${c}`)), received_in_full: received.map((x) => x.asset).concat(capReceived.map((c) => `cap:${c}`)) },
      allocation: pairs
        ? { status: ALLOCATION.ESTABLISHED, basis: "one asset each way and no cap money: the transaction itself pairs them" }
        : { status: ALLOCATION.NOT_ESTABLISHED, basis: `the trade record states no allocation among the ${n} item(s) ${p} sent and the ${m} item(s) it received (cap money counted as an item): nothing is credited to any single asset` },
    };
  });
  return { trade: trade.id, class: "CONFIRMED", date: trade.date, time: trade.time, date_quality: trade.date_quality, source: trade.source, package: sides.some((s) => s.allocation.status === ALLOCATION.NOT_ESTABLISHED), sides };
}

// How a traced asset took part in a transaction: the direction, the full package on each side, and whether an allocation exists. No value is returned.
export function participation(view, assetId, from, to) {
  const sender = view.sides.find((s) => s.franchise === from) || null;
  return {
    trade: view.trade, asset: assetId, from, to,
    sender_package: sender ? { sent: sender.direct_consideration.surrendered_in_full, received: sender.direct_consideration.received_in_full } : null,
    attributable_return: sender ? sender.allocation : { status: ALLOCATION.NOT_ESTABLISHED, basis: "the sender is not a party recorded for this trade" },
  };
}

// One sentence for a franchise's side of a package, built only from the record. It never says an asset "became", "bought" or "returned" another.
export function packageSentence(view, franchise, labelOf = (x) => x) {
  const s = view.sides.find((x) => x.franchise === franchise);
  if (!s) return null;
  const name = (x) => x.label || labelOf(x.asset);
  const list = (items, caps) => [...items.map(name), ...caps.map((c) => `${Number(c).toLocaleString("en-US")} in cap money`)].join(", ") || "nothing";
  const head = `In ${view.trade} (${view.date}) ${franchise} sent ${list(s.sent, s.cap_sent)} and received ${list(s.received, s.cap_received)}`;
  return s.allocation.status === ALLOCATION.ESTABLISHED ? `${head}: a one-for-one exchange, so the transaction itself pairs them.` : `${head}, in one transaction. The record states no allocation among these assets, so no single asset is credited with any part of what was received.`;
}

// Credits an amount per asset of ONE side of a package under the only rule that never invents: nothing is credited unless the allocation is established. Returns a Map asset -> credit,
// and the total credited, which is therefore never more than the amount offered (the "no double credit" invariant the tests assert).
export function creditByAsset(sideView, amount) {
  const credits = new Map();
  for (const x of sideView.sent) credits.set(x.asset, 0);
  if (sideView.allocation.status === ALLOCATION.ESTABLISHED && sideView.sent.length === 1) credits.set(sideView.sent[0].asset, amount);
  const total = [...credits.values()].reduce((a, b) => a + b, 0);
  return { credits, total };
}
