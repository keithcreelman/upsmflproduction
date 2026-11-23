/* UPS 2027 R9: lineup coverage for Team › Roster › Byes. Pure functions of the state object: no network, no storage, no DOM.

   The question each week answers: can this team still fill the WHOLE legal starting lineup that week from the players on its active roster?
   - The slots are the league's lineup (roster.js SLOTS, canon docs/league_context_v1.md §B4: QB 1, RB 2, WR 2, TE 1, OFX 2 (RB/WR/TE), SFX 1
     (QB/RB/WR/TE), K 1, P 1, DL 2, LB 2, DB 2, DFX 1 (DL/LB/DB) = 18). Taxi and IR players are not startable (§B4), so only the active roster counts.
   - Filling is a bipartite assignment (one player per slot, one slot per player), solved exactly by augmenting paths: the required position slots
     are taken first, then the flex slots by eligibility. The result is the largest number of slots that can be filled at once, so a shortage is
     reported only when no assignment fills every slot.
   - A player is left out of a week only for a CONFIRMED absence: a bye that week (MFL's bye week for his club), or, in the current week only, an
     Out game status or an MFL roster designation (IR, PUP, NFI, SUSP, RET) from the injury read. Questionable, Doubtful and Holdout never remove
     anyone. The injury read speaks for the current week only, so a later week leaves out byes alone.
   - Taxi and IR players are OPTIONS, kept apart from the active-roster count, and are listed only for a week that is short. Taxi facts come from
     the roster read (the Worker's shared taxi rule: eligibility text, call-ups used and allowed); an IR player is a possible return only with
     supporting evidence in the current week's official NFL report (a game status other than Out and practice participation). Nothing here
     activates, calls up or sets a lineup. */
(function (root, factory) {
  var req = typeof require === "function";
  var api = factory(req ? require("./format.js") : root.UPS2027.format, req ? require("./roster.js") : root.UPS2027.roster);
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.UPS2027 = root.UPS2027 || {}; root.UPS2027.coverage = api; }
})(typeof self !== "undefined" ? self : this, function (F, R) {
  "use strict";

  function int(v) { var n = parseInt(v, 10); return isFinite(n) ? n : null; }
  function groupKey(slot) { return slot.tag.replace(/\d+$/, ""); }

  // ---------- the assignment ----------
  // slots: R.SLOTS (or a subset); players: [{ id, pos }]. Required (non-flex) slots are tried first, then the flex slots, so a required slot is
  // never left empty to fill a flex slot. Each new slot looks for an augmenting path (Kuhn's algorithm), which can move an earlier player to
  // another slot he also fits but never empties a slot already filled: the count filled is the maximum possible.
  function assign(slots, players) {
    var order = slots.map(function (s, i) { return i; }).filter(function (i) { return !slots[i].flex; })
      .concat(slots.map(function (s, i) { return i; }).filter(function (i) { return slots[i].flex; }));
    var slotOf = {}, inSlot = new Array(slots.length);
    function fits(i, p) { return slots[i].acc.indexOf(p.pos) >= 0; }
    function tryFill(i, seen) {
      for (var j = 0; j < players.length; j++) {
        var p = players[j];
        if (seen[p.id] || !fits(i, p)) continue;
        seen[p.id] = true;
        if (slotOf[p.id] === undefined || tryFill(slotOf[p.id], seen)) { slotOf[p.id] = i; inSlot[i] = p; return true; }
      }
      return false;
    }
    order.forEach(function (i) { tryFill(i, {}); });
    var filled = 0;
    for (var k = 0; k < slots.length; k++) if (inSlot[k]) filled++;
    return { filled: filled, total: slots.length, inSlot: inSlot, open: slots.filter(function (s, i) { return !inSlot[i]; }) };
  }

  // The slot groups in lineup order: { key, acc, flex, required }.
  function slotGroups(slots) {
    var out = [], at = {};
    slots.forEach(function (s) {
      var k = groupKey(s);
      if (at[k] === undefined) { at[k] = out.length; out.push({ key: k, acc: s.acc.slice(), flex: !!s.flex, required: 0 }); }
      out[at[k]].required++;
    });
    return out;
  }

  // ---------- absences ----------
  function curWeek(S) { return S.model ? S.model.week : null; }
  // A confirmed absence for week wk, or null. In the current week the injury chip decides (resolver kinds "out" and "res" only); in a later
  // week only the bye does, because the injury read speaks for the current week alone.
  function absence(S, p, wk) {
    if (R.onBye(p, wk)) return { kind: "bye", text: "Bye week" };
    if (wk !== curWeek(S)) return null;
    var c = R.injuryChip(S, p);
    if (c && c.kind === "out") return { kind: "out", text: "Out" };
    if (c && c.kind === "res") return { kind: "designation", code: c.code, text: "MFL designation: " + c.code };
    return null;
  }

  // ---------- recent weekly points ----------
  // The three most recent weeks whose games are all final (the Worker's lastCompleteWeek on the current week's games read), oldest first.
  function recentWeeks(S) {
    var cur = curWeek(S), mu = cur && S.intel && S.intel.mu && S.intel.mu[cur];
    var lc = mu && mu.state === "ok" && mu.data ? int(mu.data.lastComplete) : null;
    if (!(lc >= 1)) return [];
    var out = [];
    for (var w = Math.max(1, lc - 2); w <= lc; w++) out.push(w);
    return out;
  }
  // { week, text }: the recorded score, "…" while the week's read is out, "Unavailable" when it failed, "—" when MFL has no score for him.
  function recentPoints(S, p) {
    return recentWeeks(S).map(function (w) {
      var rec = S.intel && S.intel.scores && S.intel.scores[w];
      if (!rec || rec.state === "loading") return { week: w, text: "…" };
      if (rec.state !== "ok" || !rec.data || !rec.data.scores) return { week: w, text: "Unavailable" };
      var v = rec.data.scores[p.id];
      return { week: w, text: typeof v === "number" ? R.pts(v) : "—" };
    });
  }

  // ---------- option obstacles ----------
  function gameStarted(S, p, wk) {
    var mu = S.intel && S.intel.mu && S.intel.mu[wk];
    var g = mu && mu.state === "ok" && mu.data && mu.data.games ? mu.data.games[String(p.nflTeam || "").toUpperCase()] : null;
    var st = g ? String(g.status || "").toLowerCase() : "";
    return st === "final" || st === "live" || st === "inprogress" || st === "in_progress";
  }
  // Team-wide obstacles to moving anyone onto the active roster, verified from the roster read and the league's limits. A temporary call-up
  // counts against the active roster limit (canon §B2); an IR player does not count against it until activated (§B3).
  function teamObstacles(S, team) {
    var lim = S.model && S.model.limits ? S.model.limits.roster : null, out = [];
    if (lim == null) out.push({ kind: "limit", text: "The active roster limit didn’t load, so an open spot can’t be confirmed" });
    else if (team.counts.active >= lim) out.push({ kind: "full", text: "Active roster is full (" + team.counts.active + " of " + lim + "). Moving a player up needs an open spot." });
    return out;
  }
  function fitsAny(open, p) { return open.some(function (s) { return s.acc.indexOf(p.pos) >= 0; }); }

  // A taxi player who could fill one of the week's open slots. Every one whose position fits is listed, whatever his points.
  function taxiOption(S, p, wk) {
    var t = p.taxi || {}, used = t.used, max = t.max, obs = [];
    var eligible = t.eligible === true;
    var left = used != null && max != null ? Math.max(0, max - used) : null;
    if (!eligible) obs.push({ kind: "ineligible", text: t.text || "Call-up eligibility not recorded" });
    else if (left === 0) obs.push({ kind: "last", text: "No temporary call-ups left: another call-up is permanent" });
    if (R.onBye(p, wk)) obs.push({ kind: "bye", text: "Also on bye" });
    if (wk === curWeek(S)) {
      var c = R.injuryChip(S, p);
      if (c && (c.kind === "out" || c.kind === "res")) obs.push({ kind: "injury", text: c.kind === "out" ? "Out" : "MFL designation: " + c.code });
      if (gameStarted(S, p, wk)) obs.push({ kind: "started", text: "His game has started" });
    }
    return {
      player: p, eligible: eligible, eligibility: eligible ? "Call-up eligible" : (t.text || "Eligibility not recorded"),
      left: left, leftText: left == null ? "Call-ups left: Not recorded" : left + " of " + max + " call-ups left", obstacles: obs, points: recentPoints(S, p)
    };
  }

  // An IR player is a POSSIBLE return in week wk only with evidence for that week: the current official NFL report (its own week equal to wk)
  // lists him with a game status other than Out and with practice participation. MFL's "designated to return" is shown beside it, never alone.
  function irEvidence(S, p, wk) {
    if (wk !== curWeek(S) || !R.injuryFresh(S)) return null;
    var d = S.intel.status.data || {}, rf = d.report_feed || {}, e = (d.players || {})[p.id] || {};
    if (!rf.current || int(rf.week) !== wk || !e.report) return null;
    var st = e.report.status || "", pr = String(e.report.practice || "");
    if (st === "Out" || !pr || /did not participate/i.test(pr)) return null;
    var practice = pr.replace(/ (Participation )?in Practice$/i, "").toLowerCase();
    var bits = ["NFL report Week " + wk + ": " + (st || "no game status") + " · " + practice + " practice"];
    if (e.roster && e.roster.chip === "IR-R") bits.push("MFL: designated to return");
    return bits.join(" · ");
  }
  function irOption(S, p, wk, why) {
    var obs = [];
    if (R.onBye(p, wk)) obs.push({ kind: "bye", text: "Also on bye" });
    if (gameStarted(S, p, wk)) obs.push({ kind: "started", text: "His game has started" });
    return { player: p, evidence: why, obstacles: obs, points: recentPoints(S, p) };
  }

  // ---------- one week ----------
  function byPos(a, b) { return (F.POS_ORDER.indexOf(a.pos) - F.POS_ORDER.indexOf(b.pos)) || a.name.localeCompare(b.name); }
  function week(S, team, wk) {
    var cur = curWeek(S), slots = R.SLOTS, active = team.players.filter(function (p) { return p.status === "active"; });
    var pool = [], byes = [], absent = [];
    active.forEach(function (p) {
      var a = absence(S, p, wk);
      if (!a) pool.push(p); else if (a.kind === "bye") byes.push(p); else absent.push({ player: p, text: a.text });
    });
    var fit = assign(slots, pool), groups = slotGroups(slots), openBy = {};
    fit.open.forEach(function (s) { var k = groupKey(s); openBy[k] = (openBy[k] || 0) + 1; });
    var short = groups.filter(function (g) { return openBy[g.key]; }).map(function (g) {
      // a required slot: how many players of that position are available; a flex slot: how many of its slots the assignment could fill
      var avail = g.flex ? g.required - openBy[g.key] : pool.filter(function (p) { return g.acc.indexOf(p.pos) >= 0; }).length;
      return { key: g.key, acc: g.acc, flex: g.flex, required: g.required, available: avail };
    });
    var out = { week: wk, current: wk === cur, injuriesChecked: wk !== cur || R.injuryFresh(S), filled: fit.filled, total: fit.total, short: short,
      byes: byes.sort(byPos), absent: absent.sort(function (a, b) { return byPos(a.player, b.player); }), pool: pool.length, taxi: null, ir: null };
    if (!short.length) return out;
    var tx = team.players.filter(function (p) { return p.status === "taxi" && fitsAny(fit.open, p); }).sort(byPos).map(function (p) { return taxiOption(S, p, wk); });
    out.taxi = { options: tx, eligible: tx.filter(function (o) { return o.eligible; }).length, team: teamObstacles(S, team) };
    var irs = [];
    team.players.filter(function (p) { return p.status === "ir" && fitsAny(fit.open, p); }).sort(byPos).forEach(function (p) {
      var why = irEvidence(S, p, wk); if (why) irs.push(irOption(S, p, wk, why));
    });
    out.ir = { options: irs, team: teamObstacles(S, team), checked: wk === cur && R.injuryFresh(S) };
    return out;
  }

  // The weeks the Byes view checks: the current week and every later week in which one of the team's active players is on bye.
  function weeks(S, team) {
    var cur = curWeek(S); if (!cur) return [];
    var set = {}; set[cur] = true;
    team.players.forEach(function (p) { if (p.status === "active" && p.bye && p.bye > cur) set[p.bye] = true; });
    return Object.keys(set).map(Number).sort(function (a, b) { return a - b; }).map(function (w) { return week(S, team, w); });
  }

  return { assign: assign, slotGroups: slotGroups, absence: absence, week: week, weeks: weeks, recentWeeks: recentWeeks, recentPoints: recentPoints, teamObstacles: teamObstacles, irEvidence: irEvidence };
});
