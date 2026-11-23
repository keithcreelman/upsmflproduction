/* lineup_flex.js — Flex / SuperFlex are never "declared": they are whoever plays LAST.
   Pure, side-effect free; shared by the phone app (site/m/views/lineup.js) and Game Day (site/gameday/gameday.html).

   Keith 2026-11-13: MFL itself only says "start 2-4 WR"; nobody declares a Flex. The 18-slot look (1 QB, 2 RB, 2 WR, 1 TE,
   2 Flex, 1 SuperFlex, K, P / 2 DL, 2 LB, 2 DB, 1 Flex) stays, but it is DERIVED from the starters chosen, never a lock:
     - the starters you pick are what counts (MFL gets the same flat list as before);
     - the fixed slots take each position's EARLIEST games, Flex / SuperFlex take the LATEST, so a late game keeps the most
       freedom (a Sunday-night WR is the Flex, not the Thursday one) — however the lineup was submitted, here, on MFL or
       by another device;
     - any QB / RB / WR / TE may be picked for any offensive slot (any DL / LB / DB for any defensive slot); only MFL's own
       ranges apply (QB 1-2, RB 2-5, WR 2-5, TE 1-4, DL 2-3, LB 2-3, DB 2-3; always 1 K, 1 P).
   A slot's player never changes WHO starts: arrange() only relabels. A player whose game has started has the earliest
   kickoff, so he always lands in a fixed slot and never loses his place (canon §B4 locks are by player, unchanged).

   API (window.UPS_LINEUP_FLEX):
     RANGES                         { QB:[1,2], RB:[2,5], WR:[2,5], TE:[1,4], PK:[1,1], PN:[1,1], DL:[2,3], LB:[2,3], DB:[2,3] }
     pickAccepts(slot, group)       may this player GROUP be chosen for this slot? (the slot's own positions, as before)
     arrange(draft, rowOf, kickoffOf, slots)  -> a new draft { slotId: pid }, flex slots holding the latest games
     rangeProblems(draft, rowOf, slots)       -> { errors: [text], count }   MFL's ranges, not slot labels
   rowOf(pid) -> a row with .group, or null; kickoffOf(row) -> unix seconds (0 / null = unknown or no game). */
(function (global) {
  "use strict";

  var RANGES = { QB: [1, 2], RB: [2, 5], WR: [2, 5], TE: [1, 4], PK: [1, 1], PN: [1, 1], DL: [2, 3], LB: [2, 3], DB: [2, 3] };
  var OFF_SKILL = ["QB", "RB", "WR", "TE"], DEF = ["DL", "LB", "DB"];

  function kickerSlot(slot) { return !!slot && slot.accepts.length === 1 && (slot.accepts[0] === "PK" || slot.accepts[0] === "PN"); }
  function groupsFor(slot) {
    if (kickerSlot(slot)) return slot.accepts;
    return slot.side === "O" ? OFF_SKILL : DEF;
  }
  // Picker eligibility is the ORIGINAL one: a slot takes only the positions it always did (a TE is never offered for QB). MFL's ranges are checked separately.
  function pickAccepts(slot, group) { return !!slot && slot.accepts.indexOf(group) !== -1; }

  function ko(kickoffOf, row) { var v = kickoffOf ? Number(kickoffOf(row)) : 0; return isFinite(v) && v > 0 ? v : 0; }

  // One side (offense skill players or defense). Returns { slotId: pid } plus any pids that found no slot.
  function arrangeSide(slots, side, groups, pids, rowOf, kickoffOf, flexNow) {
    var fixed = slots.filter(function (s) { return s.side === side && !s.flex && !kickerSlot(s); });
    var flex = slots.filter(function (s) { return s.side === side && s.flex; });
    var min = {};
    groups.forEach(function (g) { min[g] = fixed.filter(function (s) { return s.accepts[0] === g; }).length; });
    var left = pids.slice(), count = {};
    groups.forEach(function (g) { count[g] = 0; });
    left.forEach(function (p) { count[rowOf(p).group]++; });
    // Latest game first; among equal kickoffs the one already in a flex slot stays there, then by id (stable, idempotent).
    var order = left.slice().sort(function (a, b) {
      var d = ko(kickoffOf, rowOf(b)) - ko(kickoffOf, rowOf(a));
      if (d) return d;
      d = (flexNow[b] ? 1 : 0) - (flexNow[a] ? 1 : 0);
      if (d) return d;
      return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
    });
    var chosen = [], qbIn = false;
    order.forEach(function (p) {
      var g = rowOf(p).group;
      if (chosen.length >= flex.length) return;
      if (count[g] - 1 < min[g]) return;                 // that position still needs him in a fixed slot
      if (g === "QB" && qbIn) return;                    // only the SuperFlex takes a QB
      count[g]--; chosen.push(p); if (g === "QB") qbIn = true;
    });
    var out = {}, placed = {};
    // Fixed slots: each position's earliest games first.
    groups.forEach(function (g) {
      var mine = left.filter(function (p) { return chosen.indexOf(p) === -1 && rowOf(p).group === g; }).sort(function (a, b) {
        var d = ko(kickoffOf, rowOf(a)) - ko(kickoffOf, rowOf(b));
        if (d) return d;
        d = (flexNow[a] ? 1 : 0) - (flexNow[b] ? 1 : 0);
        if (d) return d;
        return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
      });
      fixed.filter(function (s) { return s.accepts[0] === g; }).forEach(function (s) {
        if (mine.length) { var p = mine.shift(); out[s.id] = p; placed[p] = 1; }
      });
    });
    // Flex slots: earliest of the flex players first, the latest in the last flex slot (SuperFlex when there is one).
    // A QB can only sit in the SuperFlex (the slot that accepts QB).
    var asc = chosen.slice().sort(function (a, b) {
      var d = ko(kickoffOf, rowOf(a)) - ko(kickoffOf, rowOf(b));
      if (d) return d;
      return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
    });
    var qbSlot = flex.filter(function (s) { return s.accepts.indexOf("QB") !== -1; })[0] || null;
    var qbPid = asc.filter(function (p) { return rowOf(p).group === "QB"; })[0];
    if (qbPid && qbSlot) { out[qbSlot.id] = qbPid; placed[qbPid] = 1; }
    var rest = asc.filter(function (p) { return !placed[p]; });
    flex.filter(function (s) { return !out[s.id]; }).forEach(function (s) {
      if (rest.length) { var p = rest.shift(); out[s.id] = p; placed[p] = 1; }
    });
    var overflow = left.filter(function (p) { return !placed[p]; });
    return { out: out, overflow: overflow };
  }

  function arrange(draft, rowOf, kickoffOf, slots) {
    draft = draft || {};
    var bySlot = {}, seen = {}, offense = [], defense = [], flexNow = {};
    var keep = {};          // K / P slots and anything we cannot place stay exactly as they were
    for (var i = 0; i < slots.length; i++) {
      var s = slots[i], pid = draft[s.id];
      if (!pid) continue;
      var row = rowOf(pid);
      if (!row || !row.group) return draft;              // a player we know nothing about: relabel nothing
      if (seen[pid]) return draft;                       // a duplicate is the validator's to report, not ours to hide
      seen[pid] = 1;
      if (kickerSlot(s)) { keep[s.id] = pid; continue; }
      if (s.flex) flexNow[pid] = 1;
      if (OFF_SKILL.indexOf(row.group) !== -1 && s.side === "O") offense.push(pid);
      else if (DEF.indexOf(row.group) !== -1 && s.side === "D") defense.push(pid);
      else return draft;                                 // a K in a skill slot etc.: leave for the validator
    }
    var o = arrangeSide(slots, "O", OFF_SKILL, offense, rowOf, kickoffOf, flexNow);
    var d = arrangeSide(slots, "D", DEF, defense, rowOf, kickoffOf, flexNow);
    var out = {}, k;
    for (k in keep) out[k] = keep[k];
    for (k in o.out) out[k] = o.out[k];
    for (k in d.out) out[k] = d.out[k];
    // More players of a position than MFL allows (the validator names it): keep them visible in any empty slot of the side.
    function spill(list, side) {
      list.forEach(function (p) {
        for (var j = 0; j < slots.length; j++) {
          var sl = slots[j];
          if (sl.side === side && !kickerSlot(sl) && !out[sl.id]) { out[sl.id] = p; return; }
        }
      });
    }
    spill(o.overflow, "O"); spill(d.overflow, "D");
    return out;
  }

  // MFL's ranges, as errors. Maxima always; minima once a side is full (a partial lineup may still be filling up).
  function rangeProblems(draft, rowOf, slots) {
    draft = draft || {};
    var count = {}, filled = { O: 0, D: 0 }, total = { O: 0, D: 0 };
    slots.forEach(function (s) {
      total[s.side]++;
      var pid = draft[s.id]; if (!pid) return;
      filled[s.side]++;
      var r = rowOf(pid); if (!r || !r.group) return;
      count[r.group] = (count[r.group] || 0) + 1;
    });
    var errors = [], names = { QB: "QB", RB: "RB", WR: "WR", TE: "TE", DL: "DL", LB: "LB", DB: "DB" };
    function check(g, side) {
      var c = count[g] || 0, r = RANGES[g];
      if (c > r[1]) errors.push("At most " + r[1] + " " + names[g] + " can start (you have " + c + ")");
      else if (filled[side] === total[side] && c < r[0]) errors.push("At least " + r[0] + " " + names[g] + (r[0] === 1 ? " is" : "s are") + " needed to start (you have " + c + ")");
    }
    OFF_SKILL.forEach(function (g) { check(g, "O"); });
    DEF.forEach(function (g) { check(g, "D"); });
    return { errors: errors, count: errors.length };
  }

  var api = { RANGES: RANGES, pickAccepts: pickAccepts, arrange: arrange, rangeProblems: rangeProblems };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.UPS_LINEUP_FLEX = api;
})(typeof window !== "undefined" ? window : this);
