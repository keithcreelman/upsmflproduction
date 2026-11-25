/* UPS 2027 R9: lineup coverage for Team › Roster › Byes. Pure functions of the state object: no network, no storage, no DOM.

   The question each week answers: can this team still fill the WHOLE legal starting lineup that week from the players on its active roster?
   - The slots are the league's lineup (roster.js SLOTS, canon docs/league_context_v1.md §B4: QB 1, RB 2, WR 2, TE 1, OFX 2 (RB/WR/TE), SFX 1
     (QB/RB/WR/TE), K 1, P 1, DL 2, LB 2, DB 2, DFX 1 (DL/LB/DB) = 18). Taxi and IR players are not startable (§B4), so only the active roster counts.
   - Filling is a bipartite assignment (one player per slot, one slot per player), solved exactly by augmenting paths: the required position slots
     are taken first, then the flex slots by eligibility. The result is the largest number of slots that can be filled at once, so a shortage is
     reported only when no assignment fills every slot.
   - A player counts as available unless his absence is CONFIRMED (a bye that week; an Out game status or an MFL roster designation in the
     current week; RET in any week) or his availability is NOT CONFIRMED (an MFL designation IR, IR-R, PUP, NFI or SUSP in a later week: the
     data gives no duration, and an expected-return date is uncertainty, not clearance). Questionable, Doubtful and Holdout never remove anyone.
     Neither group is counted as available; a short week that a not-confirmed or returnable player would complete gets a dependency note
     ("Covered only if … returns from IR"), never "covered".
   - Taxi and IR players are OPTIONS, kept apart from the active-roster count, and are listed only for a week that is short. Taxi facts come from
     the roster read (the Worker's shared taxi rule: eligibility text, call-ups used and allowed); an IR player is a possible return only with
     supporting evidence in the current week's official NFL report (a game status other than Out and practice participation). Recent points
     run through the shared settled-week cutoff W* (R10). Nothing here
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
  // R10 (Keith, 2026-11-23, decision 6): "Confirmed absences reduce future coverage. Questionable does not."
  // What the injury read actually states, and for how long (worker/src/player_status.js):
  //   - an MFL ROSTER designation (IR, IR-R, PUP, NFI, SUSP, RET, from MFL's injuries export) is a standing roster state with no week attached:
  //     it holds until MFL changes it, so it removes the player from the current week AND every later week the screen checks;
  //   - an Out game status (MFL's, or the official report's for report_feed.week) is a game designation for the current week only (the export
  //     keeps no week on it, and lapsed ones linger: see the worker's header), so a later week never carries an Out forward;
  //   - Questionable, Doubtful and Holdout never remove anyone. An expired or missing injury read removes nobody for injury, and the week says
  //     "injuries not checked".
  // A designation that can end with a return (IR-R "designated to return", PUP, NFI, or any designation MFL gives an expected-return date) makes
  // the player an UNCERTAIN RETURN: still never counted as available, but a lineup that only he would complete gets a dependency note instead of
  // "covered" (see dependency below). Plain IR, SUSP and RET carry no return in the data, so they are absences with no note.
  var RETURNABLE = { "IR-R": "IR", "PUP": "PUP", "NFI": "NFI" };
  function rosterEntry(S, p) {
    if (!R.injuryFresh(S)) return null;
    var d = S.intel.status.data || {}, e = (d.players || {})[p.id];
    return e && e.roster ? e.roster : null;
  }
  // { from: "IR" | "PUP" | …, code } when the player's MFL designation can end with a return, else null.
  function returnable(S, p) {
    var ro = rosterEntry(S, p); if (!ro) return null;
    var code = String(ro.chip || "").toUpperCase();
    if (RETURNABLE[code]) return { from: RETURNABLE[code], code: code };
    if (ro.exp_return && code !== "RET" && code !== "HOLD") return { from: code === "SUSP" ? "a suspension" : code, code: code };
    return null;
  }
  // How a designation is named in a dependency note ("returns from IR", "returns from a suspension").
  function returnLabel(S, p, code) { var b = returnable(S, p); return b ? b.from : code === "SUSP" ? "a suspension" : code; }
  // Week wk's state for an active player: null (available), or
  //   { kind: "bye" }                  his club's bye that week (confirmed);
  //   { kind: "out" }                  an Out game status, current week only (confirmed);
  //   { kind: "designation", back }    an MFL roster designation in the CURRENT week, or RET (retired) in any week (confirmed);
  //   { kind: "uncertain", from }      an MFL roster designation (IR, IR-R, PUP, NFI, SUSP) in a LATER week.
  // R10 fix (Keith, 2026-11-23, against decision 6): a designation has no verified duration in the data (MFL's export carries no week and no end
  // date; an expected-return date is evidence of uncertainty, not of clearance), so it is not carried forward as a confirmed absence. In a later
  // week the player is neither counted as available nor confirmed absent: his availability is not confirmed, and a lineup he would complete
  // gets the dependency note. Only RET, a permanent status, is confirmed for later weeks.
  function absence(S, p, wk) {
    if (R.onBye(p, wk)) return { kind: "bye", text: "Bye week" };
    var cur = curWeek(S);
    if (!(wk >= cur)) return null;
    var c = R.injuryChip(S, p);
    if (c && c.kind === "out" && wk === cur) return { kind: "out", text: "Out" };
    if (c && c.kind === "res") {
      var code = String(c.code || "").toUpperCase();
      if (wk === cur || code === "RET") return { kind: "designation", code: c.code, text: "MFL designation: " + c.code, back: code === "RET" ? null : returnable(S, p) };
      return { kind: "uncertain", code: c.code, text: "MFL designation: " + c.code + " · availability not confirmed", from: returnLabel(S, p, code) };
    }
    return null;
  }

  // ---------- recent weekly points ----------
  // R10 (Keith, 2026-11-23, decision 7): the shared settled-week cutoff W* (tabviews.seasonCutoff, the week Performance's season figures run
  // through), passed in by the caller as `cut` ({ state, week }). The three weeks W*-2 .. W*, oldest first; none until W* is established.
  function recentWeeks(cut) {
    var W = cut && cut.state === "ok" ? int(cut.week) : null;
    if (!(W >= 1)) return [];
    var out = [];
    for (var w = Math.max(1, W - 2); w <= W; w++) out.push(w);
    return out;
  }
  // A score as the screen prints it: one decimal, a true minus sign for a negative score, 0.0 kept as 0.0.
  function scoreText(v) { var s = R.pts(v); return s.charAt(0) === "-" ? "−" + s.slice(1) : s; }
  // { week, text, kind }: the recorded score ("score", zero and negative included), "—" when MFL's week has no score entry for him ("none"),
  // "Unreadable" when the entry is there but is not a number, "…" while the week's read is out, "Unavailable" when it failed.
  function recentPoints(S, p, cut) {
    return recentWeeks(cut).map(function (w) {
      var rec = S.intel && S.intel.scores && S.intel.scores[w];
      if (!rec || rec.state === "loading") return { week: w, text: "…", kind: "loading" };
      if (rec.state !== "ok" || !rec.data || !rec.data.scores) return { week: w, text: "Unavailable", kind: "error" };
      var m = rec.data.scores;
      if (!Object.prototype.hasOwnProperty.call(m, p.id)) return { week: w, text: "—", kind: "none" };
      var v = m[p.id];
      return typeof v === "number" && isFinite(v) ? { week: w, text: scoreText(v), kind: "score" } : { week: w, text: "Unreadable", kind: "bad" };
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
  function taxiOption(S, p, wk, cut) {
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
      left: left, leftText: left == null ? "Call-ups left: Not recorded" : left + " of " + max + " call-ups left", obstacles: obs, points: recentPoints(S, p, cut)
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
  function irOption(S, p, wk, why, cut) {
    var obs = [];
    if (R.onBye(p, wk)) obs.push({ kind: "bye", text: "Also on bye" });
    if (gameStarted(S, p, wk)) obs.push({ kind: "started", text: "His game has started" });
    return { player: p, evidence: why, obstacles: obs, points: recentPoints(S, p, cut) };
  }

  // ---------- dependency on an uncertain return ----------
  // R10 (decision 6): "when coverage depends on one, show a concise dependency note rather than declaring the lineup covered". A short week
  // whose lineup WOULD fill if one uncertain return came back (an active player with a returnable designation, or a UPS IR player whose MFL
  // designation can end with a return), names him; if no single one suffices but several together do, it names the fewest found together.
  // The week stays short: the note never makes it covered. Nobody here is counted as available.
  function dependency(slots, pool, cands) {
    if (!cands.length) return null;
    var total = slots.length;
    function fills(extra) { return assign(slots, pool.concat(extra.map(function (c) { return c.player; }))).filled === total; }
    var singles = cands.filter(function (c) { return fills([c]); });
    if (singles.length) return { any: singles, all: null };
    if (!fills(cands)) return null;
    var need = cands.slice();
    cands.forEach(function (c) { var rest = need.filter(function (x) { return x !== c; }); if (fills(rest)) need = rest; });
    return { any: null, all: need };
  }
  function nameList(list, joiner) {
    var n = list.map(function (c) { return c.player.name; });
    if (n.length > 3) n = n.slice(0, 3).concat([(list.length - 3) + " more"]);
    return n.length > 1 ? n.slice(0, -1).join(", ") + " " + joiner + " " + n[n.length - 1] : n[0];
  }
  // "Covered only if Tyjae Spears returns from IR", "Covered only if A or B returns", "Covered only if A and B return".
  function dependencyText(dep) {
    if (!dep) return "";
    if (dep.any) return dep.any.length === 1 ? "Covered only if " + dep.any[0].player.name + " returns from " + dep.any[0].from : "Covered only if " + nameList(dep.any, "or") + " returns";
    return "Covered only if " + nameList(dep.all, "and") + " return";
  }

  // ---------- one week ----------
  function byPos(a, b) { return (F.POS_ORDER.indexOf(a.pos) - F.POS_ORDER.indexOf(b.pos)) || a.name.localeCompare(b.name); }
  // cut: the shared settled-week cutoff (tabviews.seasonCutoff), for the recent points of the options only.
  function week(S, team, wk, cut) {
    var cur = curWeek(S), slots = R.SLOTS, active = team.players.filter(function (p) { return p.status === "active"; });
    var pool = [], byes = [], absent = [], uncertain = [], cands = [];
    active.forEach(function (p) {
      var a = absence(S, p, wk);
      if (!a) pool.push(p); else if (a.kind === "bye") byes.push(p);
      else if (a.kind === "uncertain") { uncertain.push({ player: p, text: a.text, from: a.from }); cands.push({ player: p, from: a.from }); }
      else {
        absent.push({ player: p, text: a.text, back: a.back || null });
        if (a.back) cands.push({ player: p, from: a.back.from });
      }
    });
    team.players.forEach(function (p) {
      if (p.status !== "ir" || R.onBye(p, wk)) return;
      var b = returnable(S, p); if (b) { cands.push({ player: p, from: b.from, ir: true }); return; }
      // a later week: a UPS IR player with any MFL designation but RET might be back (no verified duration), so he is a dependency candidate too
      var ro = wk > cur ? rosterEntry(S, p) : null, code = ro ? String(ro.chip || "").toUpperCase() : "";
      if (code && code !== "RET" && code !== "HOLD") cands.push({ player: p, from: code === "SUSP" ? "a suspension" : code, ir: true });
    });
    cands.sort(function (a, b) { return byPos(a.player, b.player); });
    var fit = assign(slots, pool), groups = slotGroups(slots), openBy = {};
    fit.open.forEach(function (s) { var k = groupKey(s); openBy[k] = (openBy[k] || 0) + 1; });
    var short = groups.filter(function (g) { return openBy[g.key]; }).map(function (g) {
      // a required slot: how many players of that position are available; a flex slot: how many of its slots the assignment could fill
      var avail = g.flex ? g.required - openBy[g.key] : pool.filter(function (p) { return g.acc.indexOf(p.pos) >= 0; }).length;
      return { key: g.key, acc: g.acc, flex: g.flex, required: g.required, available: avail };
    });
    // R10: the injury read now decides later weeks too (standing designations), so every week is "checked" only while that read is usable.
    var out = { week: wk, current: wk === cur, injuriesChecked: R.injuryFresh(S), filled: fit.filled, total: fit.total, short: short,
      byes: byes.sort(byPos), absent: absent.sort(function (a, b) { return byPos(a.player, b.player); }), uncertain: uncertain.sort(function (a, b) { return byPos(a.player, b.player); }), pool: pool.length, taxi: null, ir: null, dependency: null, dependencyText: "" };
    if (!short.length) return out;
    out.dependency = dependency(slots, pool, cands);
    out.dependencyText = dependencyText(out.dependency);
    var tx = team.players.filter(function (p) { return p.status === "taxi" && fitsAny(fit.open, p); }).sort(byPos).map(function (p) { return taxiOption(S, p, wk, cut); });
    out.taxi = { options: tx, eligible: tx.filter(function (o) { return o.eligible; }).length, team: teamObstacles(S, team), weeks: recentWeeks(cut), cut: cut || null };
    var irs = [];
    team.players.filter(function (p) { return p.status === "ir" && fitsAny(fit.open, p); }).sort(byPos).forEach(function (p) {
      var why = irEvidence(S, p, wk); if (why) irs.push(irOption(S, p, wk, why, cut));
    });
    out.ir = { options: irs, team: teamObstacles(S, team), checked: wk === cur && R.injuryFresh(S) };
    return out;
  }

  // The weeks the Byes view checks: the current week and every later week in which one of the team's active players is on bye.
  function weeks(S, team, cut) {
    var cur = curWeek(S); if (!cur) return [];
    var set = {}; set[cur] = true;
    team.players.forEach(function (p) { if (p.status === "active" && p.bye && p.bye > cur) set[p.bye] = true; });
    return Object.keys(set).map(Number).sort(function (a, b) { return a - b; }).map(function (w) { return week(S, team, w, cut); });
  }

  return { assign: assign, slotGroups: slotGroups, absence: absence, returnable: returnable, dependency: dependency, dependencyText: dependencyText, week: week, weeks: weeks, recentWeeks: recentWeeks, recentPoints: recentPoints, scoreText: scoreText, teamObstacles: teamObstacles, irEvidence: irEvidence };
});
