/* Cap ledger for one team (#1338): the Overview's Player salaries and Salary
   adjustments breakdowns. Pure: no fetch, no DOM.

   NO SECOND COPY OF THE CAP MATH. front_office.js passes its own functions:
     capHit(p)     currentCapHit — taxi $0, IR 50% (rounded per player),
                   expired contract $0 (canon §6.C/§6.E)
     roundCut(n)   the per-franchise drop-penalty rounding to the nearest $1K
                   (canon §6), the same roundToK the Cap Allocation card uses
   and the adjustments it already merged from MFL's salaryAdjustments feed
   (summary.adj_cut / adj_trade / adj_other, items per category). This module
   only groups and sums, and reports whether the groups add back up.
*/
(function (root) {
  "use strict";

  function int(v) { var n = Math.round(Number(v)); return isFinite(n) ? n : 0; }

  // team = a Front Office team row ({ fid, name, players[], summary }); items = adjByFid[fid] (may be absent).
  function build(team, opts) {
    var capHit = opts.capHit, roundCut = opts.roundCut;
    var groups = {
      active: { key: "active", label: "Active roster", players: [], salary: 0, capHit: 0 },
      ir: { key: "ir", label: "Injured reserve", players: [], salary: 0, capHit: 0 },
      taxi: { key: "taxi", label: "Taxi squad", players: [], salary: 0, capHit: 0 }
    };
    var relief = {
      ir: { key: "ir", label: "IR: half of each IR salary is off the cap", amount: 0, n: 0 },
      taxi: { key: "taxi", label: "Taxi: taxi salaries don’t count", amount: 0, n: 0 },
      expired: { key: "expired", label: "Expired contracts count $0", amount: 0, n: 0 }
    };
    (team.players || []).forEach(function (p) {
      var g = p.isTaxi ? groups.taxi : (p.isIr ? groups.ir : groups.active);
      var salary = Math.max(0, int(p.salary));
      var hit = int(capHit(p));
      g.players.push({ id: String(p.id), name: p.name, position: p.position, salary: salary, capHit: hit });
      g.salary += salary;
      g.capHit += hit;
      var off = hit - salary;                       // ≤ 0: what the cap rules take off this salary
      if (!off) return;
      // The reason, in the same order currentCapHit applies its rules: taxi, then expired, then IR.
      var r = p.isTaxi ? relief.taxi : (hit === 0 ? relief.expired : (p.isIr ? relief.ir : relief.expired));
      r.amount += off; r.n += 1;
    });
    var order = ["active", "ir", "taxi"].map(function (k) { return groups[k]; });
    order.forEach(function (g) { g.players.sort(function (a, b) { return (b.salary - a.salary) || String(a.name).localeCompare(String(b.name)); }); });
    var grossSalary = order.reduce(function (s, g) { return s + g.salary; }, 0);
    var reliefLines = ["ir", "taxi", "expired"].map(function (k) { return relief[k]; }).filter(function (r) { return r.amount !== 0; });
    var reliefTotal = reliefLines.reduce(function (s, r) { return s + r.amount; }, 0);
    var playerTotal = order.reduce(function (s, g) { return s + g.capHit; }, 0);

    var s = team.summary || {};
    var adj = opts.adj || null;                    // { cut, trade, other, items:[{kind, player, amount, when}] } from MFL's feed
    var items = (adj && adj.items) || [];
    function cat(kind, exact, label) {
      var list = items.filter(function (it) { return it.kind === kind; })
        .map(function (it) { return { player: it.player || "", amount: int(it.amount), when: it.when || "" }; })
        .sort(function (a, b) { return String(a.when).localeCompare(String(b.when)) || (b.amount - a.amount); });
      return { kind: kind, label: label, exact: exact, items: list, itemsTotal: list.reduce(function (t, it) { return t + it.amount; }, 0) };
    }
    var cutExact = int(s.adj_cut), trade = int(s.adj_trade), other = int(s.adj_other);
    var penalties = cat("Drop", cutExact, "Cap penalties");
    penalties.rounded = int(roundCut(cutExact));
    penalties.rounding = penalties.rounded - cutExact;
    penalties.total = penalties.rounded;
    var traded = cat("Trade", trade, "Traded salary"); traded.total = trade;
    var misc = cat("Other", other, "Miscellaneous / manual"); misc.total = other;
    var adjTotal = penalties.total + traded.total + misc.total;
    var itemized = !!(adj && adj.items);

    return {
      fid: team.fid, name: team.name,
      players: { groups: order, grossSalary: grossSalary, relief: reliefLines, reliefTotal: reliefTotal, total: playerTotal,
        reconciles: grossSalary + reliefTotal === playerTotal },
      adjustments: { categories: [penalties, traded, misc], total: adjTotal, itemized: itemized,
        // With MFL's itemized feed, each category's items must add to its total (rounding is shown on its own line).
        reconciles: !itemized || (penalties.itemsTotal === cutExact && traded.itemsTotal === trade && misc.itemsTotal === other) },
      allocated: playerTotal + adjTotal
    };
  }

  var api = { build: build };
  root.UPS_FO_CAP_LEDGER = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : this);
