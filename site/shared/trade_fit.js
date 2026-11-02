/* Trade fit — every team's strength and need by position, and 1-for-1 swaps
   that improve BOTH lineups, in points a week. Pure: no fetch, no DOM.

   WHAT IT IS, AND IS NOT (#1338). Discovery, not a verdict: "both best
   lineups get better by X and Y points a week on this season's numbers". It
   never says a trade is fair, never proposes, submits or messages anything.
   Inputs are public MFL data only (rosters, MFL's own league scores, injury
   designations, salaries); nothing from the commissioner-only draft-guide or
   auction-value models.

   THE UNIT. A player's value is what the caller passes (the Front Office
   passes season-to-date points per MFL-scored week, the released phone
   definition, site/m/season_scoring.js). A team's value is the total of its
   best LEGAL lineup under the league's 18 slots (canon §B4), filled by the
   same engine the lineup screens use (site/m/front_office_lineup.js
   autoFillSlots: fixed slots first, then flex — exact for this league's
   nested slot sets, see pipelines/etl/wire/lineup_engine.py).

   WHY SEASON PPG. Backtest 2022-2025, cut at Weeks 4/6/8/10, target = rest of
   season (pipelines/etl/scripts/trade_fit_signal_backtest.py; docs/
   FRONT_OFFICE_TRADE_FIT.md): season PPG ranks whole lineups best of the
   signals the app has (Spearman .70 vs .62 for the last 4 weeks); recent form
   never beats it overall. Kickers and punters barely predict (.2), so they
   never drive a fit.

   THE OWNED ROSTER (Keith 2026-10-21, Overview and Trade finder alike). A
   team's lineup is built from ITS OWN available players. A replacement free
   agent fills a slot ONLY when no available rostered player can play it, and
   such a slot is flagged (rep: true; the screens mark it *). It never starts
   because it outscores someone on the roster. Replacement bodies are real
   free agents at the waiver-wire level — the 3rd best at QB/RB/WR/TE, 6th at
   K/P, 12th at DL/LB/DB — the Wire forecast's tested setting (season_sim.py
   REPLACEMENT_RANK_BY_GROUP). The old rule (a replacement competes with the
   roster for every slot) is kept only as lineupRule "replacement", for the
   before/after comparison; no screen uses it.

   THE SLOTS COME FROM MFL (Keith 2026-10-21). MFL's league settings
   (export TYPE=league → starters) give a range per position and a total;
   deriveSlots turns them into named slots: each position's minimum is a fixed
   slot, and the remaining starters are Flex slots, each open to the
   positions that still have room under their maximum. A Flex slot open to QB
   is Superflex; one on defense is IDP Flex. For 74598 (QB 1-2, RB/WR 2-5,
   TE 1-4, K 1, P 1, DL/LB/DB 2-3, 18 starters, 7 IDP) that is the released
   engine's 18 slots exactly (QB, 2 RB, 2 WR, TE, 2 Flex, Superflex, K, P,
   2 DL, 2 LB, 2 DB, IDP Flex). fillSlots fills them the engine's way: fixed
   slots first with the best player at that position, then the Flex slots,
   narrowest first, with the best player left. So a second TE who starts sits
   in Flex, and a second QB sits in Superflex. Each starter is in exactly one
   slot.

   STRENGTH at a position = the team's starters there (flex included), points
   a week above replacement. NEED (shown as "lineup gain", Keith 2026-10-22:
   it is NOT a weakness or a deficit — a team ranked 1st at WR can still gain
   when a typical WR would take a Flex spot; additionDetail says where he'd
   start and who'd leave the lineup) = points a week the best lineup gains by
   adding the league's median starter at that position (handles Flex and
   SuperFlex with no special case). SURPLUS = a healthy player outside his
   team's best lineup who would start for at least one other team. The
   Overview's Lineup strength (site/shared/lineup_strength.js) reads these
   lineups, so both screens show the same numbers.
*/
(function () {
  "use strict";

  var GROUPS = ["QB", "RB", "WR", "TE", "PK", "PN", "DL", "LB", "DB"];
  var REPLACEMENT_RANK_BY_GROUP = { QB: 3, RB: 3, WR: 3, TE: 3, PK: 6, PN: 6, DL: 12, LB: 12, DB: 12 };
  // Replacement bodies per group: enough to fill every slot the group can play.
  var REP_DEPTH = { QB: 2, RB: 5, WR: 5, TE: 4, PK: 1, PN: 1, DL: 3, LB: 3, DB: 3 };
  // Designations that keep a player out of THIS week's lineup (released chip vocabulary, #1311).
  var UNAVAILABLE_CHIPS = { IR: 1, PUP: 1, NFI: 1, SUSP: 1, HOLD: 1, RET: 1, OUT: 1 };
  // Kickers and punters are shown, never a reason for a fit (backtest: ~.2 rank correlation).
  var FIT_EXCLUDED_GROUPS = { PK: 1, PN: 1 };
  var EPS = 0.05;

  function round1(n) { return Math.round(n * 10) / 10; }
  function num(v) { var n = Number(v); return isFinite(n) ? n : null; }
  function median(list) {
    var a = list.filter(function (x) { return x != null && isFinite(x); }).sort(function (x, y) { return x - y; });
    if (!a.length) return null;
    var m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  // MFL's position names in the league's starter ranges → the lineup groups.
  var MFL_POS = { QB: ["QB"], RB: ["RB"], WR: ["WR"], TE: ["TE"], PK: ["PK"], PN: ["PN"], "DT+DE": ["DL"], DL: ["DL"], DT: ["DL"], DE: ["DL"],
    LB: ["LB"], "CB+S": ["DB"], DB: ["DB"], CB: ["DB"], S: ["DB"] };
  var OFFENSE_FLEX = ["QB", "RB", "WR", "TE"], IDP = ["DL", "LB", "DB"];
  var SLOT_ROW = { FLEX: "Flex", SFLEX: "Superflex", DFLEX: "IDP Flex" };

  // MFL starters node ({count, idp_starters, position:[{name, limit "1-2"}]}) → named slots, or null when MFL's
  // settings can't be expressed as slots (an unknown position name, or ranges that don't reach the count).
  // Each slot: {id, label, row, accepts[], flex}. row = the slot's line in the By Lineup Slot view.
  function deriveSlots(starters) {
    if (!starters || !starters.position) return null;
    var list = Array.isArray(starters.position) ? starters.position : [starters.position];
    var lim = {};
    for (var i = 0; i < list.length; i++) {
      var groups = MFL_POS[String(list[i].name || "").toUpperCase()];
      var m = String(list[i].limit || "").match(/^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/);
      if (!groups || groups.length !== 1 || !m) return null;
      lim[groups[0]] = { min: +m[1], max: m[2] != null ? +m[2] : +m[1] };
    }
    var count = num(starters.count), idp = num(starters.idp_starters);
    if (count == null) return null;
    var sumMin = function (gs) { return gs.reduce(function (a, g) { return a + (lim[g] ? lim[g].min : 0); }, 0); };
    var sumMax = function (gs) { return gs.reduce(function (a, g) { return a + (lim[g] ? lim[g].max : 0); }, 0); };
    var idpSet = IDP.filter(function (g) { return lim[g]; });
    var offSet = Object.keys(lim).filter(function (g) { return IDP.indexOf(g) === -1; });
    if (idp == null) idp = idpSet.length ? sumMin(idpSet) : 0;
    var off = count - idp;
    // Display (and summing) order is the released engine's: offense fixed, offense Flex, K, P, IDP fixed, IDP Flex.
    var slots = [];
    function fixed(gs) {
      gs.forEach(function (g) {
        if (!lim[g]) return;
        for (var k = 1; k <= lim[g].min; k++) slots.push({ id: g + k, label: g === "PK" ? "K" : g === "PN" ? "P" : g, row: g, accepts: [g], flex: false });
      });
    }
    // Flex slots for one side: E extra starters among `gs`; slot j (narrowest first) accepts a group with room for
    // at least E − j + 1 more (exact for nested ranges, which MFL's per-position limits always are).
    function flex(gs, extra, kind) {
      if (extra < 0 || extra > sumMax(gs) - sumMin(gs)) return false;
      var n = { FLEX: 0, SFLEX: 0, DFLEX: 0 };
      for (var j = 1; j <= extra; j++) {
        var acc = gs.filter(function (g) { return lim[g].max - lim[g].min >= extra - j + 1; });
        if (!acc.length) return false;
        var row = kind === "D" ? "DFLEX" : (acc.indexOf("QB") !== -1 ? "SFLEX" : "FLEX");
        n[row] += 1;
        slots.push({ id: (row === "FLEX" ? "OF" : row === "SFLEX" ? "SF" : "DF") + n[row], label: SLOT_ROW[row], row: row, accepts: acc, flex: true });
      }
      return true;
    }
    var offFlexGroups = offSet.filter(function (g) { return OFFENSE_FLEX.indexOf(g) !== -1; });
    var offFixedOnly = offSet.filter(function (g) { return OFFENSE_FLEX.indexOf(g) === -1; });
    if (offFixedOnly.some(function (g) { return lim[g].max !== lim[g].min; })) return null;
    fixed(OFFENSE_FLEX);
    if (!flex(offFlexGroups, off - sumMin(offSet), "O")) return null;
    fixed(["PK", "PN"]);
    fixed(IDP);
    if (!flex(idpSet, idp - sumMin(idpSet), "D")) return null;
    return slots;
  }

  // Fill `slots` from rows ({id,pos,v}): fixed slots first with the best player at that position, then the Flex
  // slots in order (narrowest first) with the best player left — the released engine's order (autoFillSlots).
  function fillSlots(rows, slots, L) {
    var byGroup = {};
    rows.forEach(function (r) {
      var g = L.posGroup(r.pos);
      if (g === "OTH") return;
      (byGroup[g] = byGroup[g] || []).push(r);
    });
    Object.keys(byGroup).forEach(function (g) { byGroup[g].sort(function (a, b) { return (b.v || 0) - (a.v || 0); }); });
    var used = {}, draft = {};
    function take(accepts) {
      var best = null;
      accepts.forEach(function (g) {
        (byGroup[g] || []).forEach(function (r) { if (!used[r.id] && (!best || (r.v || 0) > (best.v || 0))) best = r; });
      });
      if (best) { used[best.id] = 1; return best.id; }
      return "";
    }
    slots.forEach(function (s) { if (!s.flex) draft[s.id] = take(s.accepts); });
    slots.forEach(function (s) { if (s.flex) draft[s.id] = take(s.accepts); });
    return draft;
  }
  // A slot's replacement baseline: the best replacement-level free agent the slot accepts (the body the owned rule
  // would start there). A Flex slot's comes from RB/WR/TE free agents, a Superflex slot's from QB/RB/WR/TE.
  function slotBaseline(slot, repl) {
    var best = null;
    slot.accepts.forEach(function (g) { var v = repl[g] && repl[g][0]; if (v != null && (best == null || v > best)) best = v; });
    return best || 0;
  }

  function lineupApi(opts) {
    var L = (opts && opts.lineup) || (typeof window !== "undefined" && window.UPS_FRONT_OFFICE_LINEUP);
    if (!L || typeof L.autoFillSlots !== "function") throw new Error("trade_fit: UPS_FRONT_OFFICE_LINEUP is required");
    return L;
  }

  // A player can start for his team now: on the active roster and not ruled out.
  function availableNow(p) {
    if (!p) return false;
    var st = String(p.status || "ROSTER").toUpperCase();
    if (st !== "ROSTER") return false;
    var chip = String(p.chip || "").toUpperCase();
    return !UNAVAILABLE_CHIPS[chip];
  }

  // Replacement level per group from free agents' values: the Nth best and the next ones down.
  function replacementLevels(freeAgents, values, L) {
    var byGroup = {};
    (freeAgents || []).forEach(function (fa) {
      var g = L.posGroup(fa.pos);
      var v = num(values[fa.pid]);
      if (GROUPS.indexOf(g) === -1 || v == null) return;
      (byGroup[g] = byGroup[g] || []).push(v);
    });
    var out = {};
    GROUPS.forEach(function (g) {
      var list = (byGroup[g] || []).sort(function (a, b) { return b - a; });
      var start = REPLACEMENT_RANK_BY_GROUP[g] - 1, bodies = [];
      for (var i = 0; i < REP_DEPTH[g]; i++) bodies.push(list[start + i] != null ? list[start + i] : 0);
      out[g] = bodies;
    });
    return out;
  }

  // Best legal lineup over `rows` ({id,pos,v}). Returns {total, slots, starters}; a starter filled at replacement
  // level has rep: true (and slots[slot] = "REP:<group>:<i>").
  //   rule "owned" (default): the rows fill every slot they can (the released engine: fixed slots first, then flex);
  //     a slot still empty takes the best unused replacement body that slot accepts.
  //   rule "replacement" (comparison only): replacement bodies join the pool and compete for every slot.
  function bestLineup(rows, repl, L, rule, slotList) {
    var SL = slotList || L.LINEUP_SLOTS;
    var pool = rows.slice();
    if (rule === "replacement") {
      GROUPS.forEach(function (g) {
        (repl[g] || []).forEach(function (v, i) { pool.push({ id: "REP:" + g + ":" + i, pos: g, v: v, rep: true }); });
      });
    }
    var byId = {};
    pool.forEach(function (r) { byId[r.id] = r; });
    var slots = fillSlots(pool, SL, L);
    var used = {};
    Object.keys(slots).forEach(function (k) { if (slots[k]) used[slots[k]] = 1; });
    var total = 0, starters = [];
    SL.forEach(function (s) {
      var pid = slots[s.id];
      if (!pid && rule !== "replacement") {
        var best = null;
        s.accepts.forEach(function (g) {
          (repl[g] || []).forEach(function (v, i) {
            var id = "REP:" + g + ":" + i;
            if (!used[id] && (!best || v > best.v)) best = { id: id, pos: g, v: v, rep: true };
          });
        });
        if (best) { used[best.id] = 1; byId[best.id] = best; slots[s.id] = pid = best.id; }
      }
      if (!pid) { starters.push({ slot: s.id, slotRow: s.row || "", pid: "", group: "", v: 0, empty: true }); return; }
      var r = byId[pid];
      total += r.v || 0;
      starters.push({ slot: s.id, slotRow: s.row || "", pid: r.rep ? "" : pid, rep: !!r.rep, group: L.posGroup(r.pos), v: r.v || 0 });
    });
    return { total: total, slots: slots, starters: starters };
  }

  function teamRows(team, values, L, exclude, extra) {
    var rows = [];
    (team.players || []).forEach(function (p) {
      if (exclude && exclude[p.pid]) return;
      if (!availableNow(p)) return;
      if (L.posGroup(p.pos) === "OTH") return;
      rows.push({ id: p.pid, pos: p.pos, v: num(values[p.pid]) || 0 });
    });
    (extra || []).forEach(function (r) { rows.push(r); });
    return rows;
  }

  function buildLeague(input) {
    var L = lineupApi(input);
    var values = input.values || {};
    var teams = input.teams || [];
    var repl = replacementLevels(input.freeAgents, values, L);
    var rule = input.lineupRule === "replacement" ? "replacement" : "owned";
    // The slots: MFL's league settings (deriveSlots) when the caller passes them; the engine's own 18 otherwise
    // (tests and the phone-equivalent default). slotSource says which.
    var slotList = input.slots || L.LINEUP_SLOTS.map(function (s) {
      var row = !s.flex ? s.accepts[0] : (s.accepts.indexOf("QB") !== -1 ? "SFLEX" : s.side === "D" ? "DFLEX" : "FLEX");
      return { id: s.id, label: s.flex ? SLOT_ROW[row] : s.label, row: row, accepts: s.accepts.slice(), flex: !!s.flex };
    });
    var model = { repl: repl, values: values, lineup: L, lineupRule: rule, slots: slotList, slotSource: input.slots ? "mfl" : "engine",
      teams: {}, order: [], medians: {}, typical: {}, generatedFrom: input.basis || null };
    model.slotBase = {};
    slotList.forEach(function (s) { model.slotBase[s.id] = slotBaseline(s, repl); });
    var startersByGroup = {};
    teams.forEach(function (t) {
      var best = bestLineup(teamRows(t, values, L), repl, L, rule, slotList);
      var strength = {}, count = {};
      GROUPS.forEach(function (g) { strength[g] = 0; count[g] = 0; });
      best.starters.forEach(function (s) {
        if (!s.group || GROUPS.indexOf(s.group) === -1) return;
        strength[s.group] += s.v - (repl[s.group][0] || 0);
        count[s.group] += 1;
        if (!s.rep && s.pid) (startersByGroup[s.group] = startersByGroup[s.group] || []).push(s.v);
      });
      var starterIds = {};
      best.starters.forEach(function (s) { if (s.pid) starterIds[s.pid] = s.slot; });
      model.teams[t.fid] = { fid: t.fid, name: t.name, team: t, best: best, total: best.total,
        strength: strength, starterCount: count, starterIds: starterIds,
        replacementStarts: best.starters.filter(function (s) { return s.rep; }).length,
        replacementSlots: best.starters.filter(function (s) { return s.rep; }).map(function (s) { return { slot: s.slot, group: s.group, v: s.v }; }) };
      model.order.push(t.fid);
    });
    GROUPS.forEach(function (g) {
      model.medians[g] = median(model.order.map(function (fid) { return model.teams[fid].strength[g]; }));
      var typ = median(startersByGroup[g] || []);
      model.typical[g] = typ != null ? typ : (repl[g][0] || 0);
    });
    model.medianTotal = median(model.order.map(function (fid) { return model.teams[fid].total; }));
    model.order.forEach(function (fid) {
      var tm = model.teams[fid];
      tm.vsMedian = {};
      GROUPS.forEach(function (g) { tm.vsMedian[g] = round1(tm.strength[g] - (model.medians[g] || 0)); });
      // Need: lineup gain from adding the league's median starter at each group.
      tm.need = {};
      GROUPS.forEach(function (g) {
        var hyp = { id: "HYP:" + g, pos: g, v: model.typical[g] };
        var with_ = bestLineup(teamRows(tm.team, values, L, null, [hyp]), repl, L, rule, slotList).total;
        tm.need[g] = round1(Math.max(0, with_ - tm.total));
      });
    });
    // Surplus: available non-starters who would start somewhere else.
    model.order.forEach(function (fid) {
      var tm = model.teams[fid];
      tm.surplus = [];
      (tm.team.players || []).forEach(function (p) {
        if (!availableNow(p) || tm.starterIds[p.pid]) return;
        var g = L.posGroup(p.pos);
        if (GROUPS.indexOf(g) === -1 || FIT_EXCLUDED_GROUPS[g]) return;
        var gains = [];
        model.order.forEach(function (ofid) {
          if (ofid === fid) return;
          var gain = addGain(model, ofid, p);
          if (gain > EPS) gains.push({ fid: ofid, gain: round1(gain) });
        });
        if (!gains.length) return;
        gains.sort(function (a, b) { return b.gain - a.gain; });
        tm.surplus.push({ pid: p.pid, group: g, v: num(values[p.pid]) || 0, teamsHelped: gains.length, best: gains[0], gains: gains });
      });
      tm.surplus.sort(function (a, b) { return b.best.gain - a.best.gain; });
    });
    return model;
  }

  // What one typical starter at `g` would do to `fid`'s modeled lineup: where he'd start, who'd leave the lineup, the
  // lineup before and after. { group, typical, before, after, gain, slot, slotLabel, leaves:[{pid, group, v, slot,
  // rep}], starts: bool }. gain = model.teams[fid].need[g] (same computation, unrounded here).
  function additionDetail(model, fid, g) {
    var tm = model.teams[fid];
    var hyp = { id: "HYP:" + g, pos: g, v: model.typical[g] };
    var after = bestLineup(teamRows(tm.team, model.values, model.lineup, null, [hyp]), model.repl, model.lineup, model.lineupRule, model.slots);
    var slotById = {};
    (model.slots || []).forEach(function (s) { slotById[s.id] = s; });
    var key = function (s) { return s.rep ? "REP:" + s.slot : s.pid; };
    var afterKeys = {}, beforeKeys = {};
    after.starters.forEach(function (s) { afterKeys[key(s)] = 1; });
    tm.best.starters.forEach(function (s) { beforeKeys[key(s)] = 1; });
    var hypStart = after.starters.filter(function (s) { return s.pid === hyp.id; })[0];
    var leaves = tm.best.starters.filter(function (s) { return !afterKeys[key(s)]; })
      .map(function (s) { return { pid: s.pid, group: s.group, v: s.v, slot: s.slot, slotLabel: (slotById[s.slot] || {}).label || s.slot, rep: !!s.rep }; });
    return { group: g, typical: model.typical[g], before: tm.total, after: after.total, gain: Math.max(0, after.total - tm.total),
      starts: !!hypStart, slot: hypStart ? hypStart.slot : "", slotLabel: hypStart ? ((slotById[hypStart.slot] || {}).label || hypStart.slot) : "", leaves: leaves };
  }

  function addGain(model, fid, player) {
    var tm = model.teams[fid];
    var row = { id: player.pid, pos: player.pos, v: num(model.values[player.pid]) || 0 };
    return bestLineup(teamRows(tm.team, model.values, model.lineup, null, [row]), model.repl, model.lineup, model.lineupRule, model.slots).total - tm.total;
  }

  // Team `fid`'s lineup after it sends `out` (pid) and receives `inPlayer` ({pid,pos}).
  function swapLineup(model, fid, outPid, inPlayer) {
    var tm = model.teams[fid];
    var ex = {}; ex[outPid] = 1;
    var row = { id: inPlayer.pid, pos: inPlayer.pos, v: num(model.values[inPlayer.pid]) || 0 };
    return bestLineup(teamRows(tm.team, model.values, model.lineup, ex, [row]), model.repl, model.lineup, model.lineupRule, model.slots);
  }
  function swapGain(model, fid, outPid, inPlayer) {
    return swapLineup(model, fid, outPid, inPlayer).total - model.teams[fid].total;
  }
  // Slots the swap leaves to a replacement free agent that the team's lineup fills itself today (the * on a fit).
  function newReplacementSlots(model, fid, lineup) {
    var before = {};
    model.teams[fid].best.starters.forEach(function (s) { if (s.rep) before[s.group] = (before[s.group] || 0) + 1; });
    var out = [];
    lineup.starters.forEach(function (s) {
      if (!s.rep) return;
      if (before[s.group]) { before[s.group] -= 1; return; }
      out.push({ slot: s.slot, group: s.group, v: round1(s.v) });
    });
    return out;
  }

  function fitCandidates(model, fid) {
    var L = model.lineup;
    return (model.teams[fid].team.players || []).filter(function (p) {
      var g = L.posGroup(p.pos);
      return availableNow(p) && GROUPS.indexOf(g) !== -1 && !FIT_EXCLUDED_GROUPS[g];
    });
  }

  // 1-for-1 swaps where BOTH best lineups gain. opts: {limit, minGain, alt (a second model on other values),
  // capRoom {fid: dollars|null}}.
  function pairFits(model, fidA, fidB, opts) {
    opts = opts || {};
    var minGain = opts.minGain != null ? opts.minGain : 0.1;
    var A = fitCandidates(model, fidA), B = fitCandidates(model, fidB);
    var room = opts.capRoom || {};
    var out = [];
    A.forEach(function (p) {
      B.forEach(function (q) {
        var luA = swapLineup(model, fidA, p.pid, q), gA = luA.total - model.teams[fidA].total;
        if (gA <= minGain) return;
        var luB = swapLineup(model, fidB, q.pid, p), gB = luB.total - model.teams[fidB].total;
        if (gB <= minGain) return;
        var fit = { give: p.pid, get: q.pid, giveGroup: model.lineup.posGroup(p.pos), getGroup: model.lineup.posGroup(q.pos),
          gainA: round1(gA), gainB: round1(gB), mutual: round1(Math.min(gA, gB)),
          repA: newReplacementSlots(model, fidA, luA), repB: newReplacementSlots(model, fidB, luB) };
        var salP = num(p.salary) || 0, salQ = num(q.salary) || 0;
        var rA = num(room[fidA]), rB = num(room[fidB]);
        fit.capAfterA = rA == null ? null : rA - (salQ - salP);
        fit.capAfterB = rB == null ? null : rB - (salP - salQ);
        fit.overCap = (fit.capAfterA != null && fit.capAfterA < 0) || (fit.capAfterB != null && fit.capAfterB < 0);
        fit.capUnknown = fit.capAfterA == null || fit.capAfterB == null;
        fit.idpOnly = /^(DL|LB|DB)$/.test(fit.giveGroup) && /^(DL|LB|DB)$/.test(fit.getGroup);
        if (opts.alt) {
          var aA = swapGain(opts.alt, fidA, p.pid, q), aB = swapGain(opts.alt, fidB, q.pid, p);
          fit.holdsOnAlt = aA > EPS && aB > EPS;
        } else {
          fit.holdsOnAlt = null;
        }
        out.push(fit);
      });
    });
    out.sort(function (x, y) { return (y.mutual - x.mutual) || ((y.gainA + y.gainB) - (x.gainA + x.gainB)); });
    return out.slice(0, opts.limit || 10);
  }

  // Where each team is strong / short, as plain lists (largest first).
  function teamSummary(model, fid, opts) {
    opts = opts || {};
    var tm = model.teams[fid];
    var strongMin = opts.strongMin != null ? opts.strongMin : 1.0;
    var needMin = opts.needMin != null ? opts.needMin : 1.0;
    var strong = GROUPS.filter(function (g) { return !FIT_EXCLUDED_GROUPS[g] && tm.vsMedian[g] >= strongMin; })
      .sort(function (a, b) { return tm.vsMedian[b] - tm.vsMedian[a]; });
    var needs = GROUPS.filter(function (g) { return !FIT_EXCLUDED_GROUPS[g] && tm.need[g] >= needMin; })
      .sort(function (a, b) { return tm.need[b] - tm.need[a]; });
    return { fid: fid, total: round1(tm.total), vsMedianTotal: round1(tm.total - (model.medianTotal || 0)),
      strong: strong, needs: needs, surplus: tm.surplus.slice(0, opts.surplusLimit || 8),
      replacementStarts: tm.replacementStarts, replacementSlots: tm.replacementSlots };
  }

  var api = {
    GROUPS: GROUPS, REPLACEMENT_RANK_BY_GROUP: REPLACEMENT_RANK_BY_GROUP, REP_DEPTH: REP_DEPTH,
    UNAVAILABLE_CHIPS: UNAVAILABLE_CHIPS, FIT_EXCLUDED_GROUPS: FIT_EXCLUDED_GROUPS,
    availableNow: availableNow, replacementLevels: replacementLevels, bestLineup: bestLineup,
    deriveSlots: deriveSlots, fillSlots: fillSlots, slotBaseline: slotBaseline, SLOT_ROW: SLOT_ROW,
    buildLeague: buildLeague, pairFits: pairFits, additionDetail: additionDetail, teamSummary: teamSummary, swapGain: swapGain, swapLineup: swapLineup, addGain: addGain
  };
  if (typeof window !== "undefined") window.UPS_TRADE_FIT = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
