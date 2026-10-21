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

   STRENGTH at a position = the team's starters there (flex included), points
   a week above replacement. NEED = points a week the best lineup gains by
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
  function bestLineup(rows, repl, L, rule) {
    var pool = rows.slice();
    if (rule === "replacement") {
      GROUPS.forEach(function (g) {
        (repl[g] || []).forEach(function (v, i) { pool.push({ id: "REP:" + g + ":" + i, pos: g, v: v, rep: true }); });
      });
    }
    var byId = {};
    pool.forEach(function (r) { byId[r.id] = r; });
    var slots = L.autoFillSlots(pool, function (r) { return r.v || 0; });
    var used = {};
    Object.keys(slots).forEach(function (k) { if (slots[k]) used[slots[k]] = 1; });
    var total = 0, starters = [];
    L.LINEUP_SLOTS.forEach(function (s) {
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
      if (!pid) { starters.push({ slot: s.id, pid: "", group: "", v: 0, empty: true }); return; }
      var r = byId[pid];
      total += r.v || 0;
      starters.push({ slot: s.id, pid: r.rep ? "" : pid, rep: !!r.rep, group: L.posGroup(r.pos), v: r.v || 0 });
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
    var model = { repl: repl, values: values, lineup: L, lineupRule: rule, teams: {}, order: [], medians: {}, typical: {}, generatedFrom: input.basis || null };
    var startersByGroup = {};
    teams.forEach(function (t) {
      var best = bestLineup(teamRows(t, values, L), repl, L, rule);
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
        var with_ = bestLineup(teamRows(tm.team, values, L, null, [hyp]), repl, L, rule).total;
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

  function addGain(model, fid, player) {
    var tm = model.teams[fid];
    var row = { id: player.pid, pos: player.pos, v: num(model.values[player.pid]) || 0 };
    return bestLineup(teamRows(tm.team, model.values, model.lineup, null, [row]), model.repl, model.lineup, model.lineupRule).total - tm.total;
  }

  // Team `fid`'s lineup after it sends `out` (pid) and receives `inPlayer` ({pid,pos}).
  function swapLineup(model, fid, outPid, inPlayer) {
    var tm = model.teams[fid];
    var ex = {}; ex[outPid] = 1;
    var row = { id: inPlayer.pid, pos: inPlayer.pos, v: num(model.values[inPlayer.pid]) || 0 };
    return bestLineup(teamRows(tm.team, model.values, model.lineup, ex, [row]), model.repl, model.lineup, model.lineupRule);
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
    buildLeague: buildLeague, pairFits: pairFits, teamSummary: teamSummary, swapGain: swapGain, swapLineup: swapLineup, addGain: addGain
  };
  if (typeof window !== "undefined") window.UPS_TRADE_FIT = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
