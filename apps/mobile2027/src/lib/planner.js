/* UPS 2027 R12 (Keith, 2026-11-23, P1): the Lineup planner. A LOCAL, unsaved what-if of the current week's lineup. Pure: no network, no storage,
   no DOM. Nothing here submits, saves or changes anything on MFL; the plan lives only in the page's memory (S.plans) until it is reset, the page is
   reloaded or the page is closed.

   The rules are the current app's, mirrored one for one so the beta never disagrees with the lineup screen owners use today (a parity test
   runs the classic files against this module, tests/mobile2027_r12_planner.test.mjs):
     - slot eligibility    site/m/front_office_lineup.js slotAccepts / site/shared/lineup_flex.js pickAccepts (a slot takes only its own positions);
     - who may start       front_office_lineup.js lineupEligibleRow (not taxi, not injured reserve, not on a bye this week);
     - locks               canon §B4 and lockedDraftEntries: once a player's game has begun he cannot be moved in or out;
     - the checks          front_office_lineup.js validateSlots (filled count, a player in two slots, ineligible, wrong slot, bye) and
                           lineup_flex.js rangeProblems (MFL's per-position ranges).
   A move is applied as a swap, so one player is never in two slots: the chosen player takes the slot and the slot's occupant takes the chosen player's
   old place (his slot, or the bench).

   UPS2027.planner:
     SLOTS                                   the beta's 18 slots (roster.js), in display order
     lockOf(S, p, wk)       -> { locked, why }        from the lineup week's NFL game status (the matchups read)
     baseDraft(S, team)     -> { ok, draft, why }     the recorded lineup as { slotId: playerId }
     draftOf(S, team)       -> { draft, base, changed: [slotId], planned }  the plan if there is one, else the recorded lineup
     options(S, team, draft, slotId) -> { slot, occupant, blocked, why, choices: [{ p, from, ok, why }] }
     apply(draft, slotId, pid)       -> a new draft (a swap)
     validate(S, team, draft)        -> { ok, complete, problems, filled, total, errors }   (validateSlots semantics)
     lineupOf(S, team, draft)        -> the lineup object the Lineup view draws (roster.js lineupFor shape) */
(function (root, factory) {
  var req = typeof require === "function";
  var api = factory(req ? require("./roster.js") : root.UPS2027.roster);
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.UPS2027 = root.UPS2027 || {}; root.UPS2027.planner = api; }
})(typeof self !== "undefined" ? self : this, function (R) {
  "use strict";

  var SLOTS = R.SLOTS, TOTAL = SLOTS.length;
  // MFL's per-position ranges (lineup_flex.js RANGES): QB 1-2, RB 2-5, WR 2-5, TE 1-4, DL 2-3, LB 2-3, DB 2-3; K and P exactly one, by their slots.
  var RANGES = { QB: [1, 2], RB: [2, 5], WR: [2, 5], TE: [1, 4], DL: [2, 3], LB: [2, 3], DB: [2, 3] };
  var OFF = ["QB", "RB", "WR", "TE"], DEF = ["DL", "LB", "DB"];
  function slotById(id) { for (var i = 0; i < SLOTS.length; i++) if (SLOTS[i].id === id) return SLOTS[i]; return null; }
  function sideOf(slot) { return slot.acc.some(function (g) { return DEF.indexOf(g) >= 0; }) ? "D" : "O"; }
  function accepts(slot, group) { return !!slot && slot.acc.indexOf(group) >= 0; }
  function own(o, k) { return o != null && Object.prototype.hasOwnProperty.call(o, k); }

  // Locks: the lineup week's game for his CURRENT club, from the matchups read the Lineup view already has. "scheduled" = not started; any other
  // status (live, final) = started; a club with no game that week is on its bye (no lock, but he cannot start). Unknown = treated as locked, said so.
  function lockOf(S, p, wk) {
    var mu = S.intel && S.intel.mu && S.intel.mu[wk];
    if (!mu || mu.state !== "ok" || !mu.data || !mu.data.games) return { locked: true, why: "Game times are not loaded" };
    var c = String(p.nflTeam || "").trim().toUpperCase(), g = c && c !== "FA" ? mu.data.games[c] : null;
    if (!g) return R.onBye(p, wk) ? { locked: false, why: "" } : { locked: true, why: "His game this week is not known" };
    var st = String(g.status || "").toLowerCase();
    if (st === "scheduled") return { locked: false, why: "" };
    return { locked: true, why: st === "final" ? "His game is final" : "His game has started" };
  }
  // Can he be put INTO a starting slot this week? (lineupEligibleRow, plus the lock.)
  function startable(S, p, wk) {
    if (p.status === "ir") return { ok: false, why: "On injured reserve" };
    if (p.status === "taxi") return { ok: false, why: "On the taxi squad" };
    if (p.status !== "active") return { ok: false, why: "Not on the active roster" };
    if (R.onBye(p, wk)) return { ok: false, why: "Bye week" };
    var L = lockOf(S, p, wk);
    if (L.locked) return { ok: false, why: L.why };
    return { ok: true, why: "" };
  }

  // The recorded lineup as a draft. Planning needs every recorded starter placed: a starter no slot takes, or one missing from the roster read,
  // turns the planner off for that team (said why), so a plan is never built on a lineup the screen cannot fully show.
  function baseDraft(S, team) {
    var wk = S.model && S.model.week;
    if (!wk || !team || !team.lineup || team.lineup.state !== "ok") return { ok: false, draft: {}, why: "MFL’s lineup for this week is not loaded" };
    var L = R.lineupFor(S, team, wk);
    if (!L || L.state !== "ok") return { ok: false, draft: {}, why: "MFL’s lineup for this week is not loaded" };
    if ((L.extra && L.extra.length) || (L.unresolved && L.unresolved.length)) return { ok: false, draft: {}, why: "Some recorded starters fit no slot or are not in the roster read" };
    var d = {};
    L.slots.forEach(function (x) { if (x.player) d[x.slot.id] = String(x.player.id); });
    return { ok: true, draft: d, why: "" };
  }
  function sig(d) { return SLOTS.map(function (s) { return s.id + "=" + (d[s.id] || ""); }).join(","); }
  function changedSlots(base, draft) { return SLOTS.filter(function (s) { return (base[s.id] || "") !== (draft[s.id] || ""); }).map(function (s) { return s.id; }); }
  // The plan for this team (S.plans[teamId]) if it still belongs to this week and this recorded lineup; otherwise the recorded lineup.
  function draftOf(S, team) {
    var b = baseDraft(S, team), pl = S.plans && team ? S.plans[team.id] : null;
    if (!b.ok) return { ok: false, why: b.why, draft: {}, base: {}, changed: [], planned: false };
    if (pl && pl.week === S.model.week && pl.base === sig(b.draft)) {
      var ch = changedSlots(b.draft, pl.draft);
      return { ok: true, why: "", draft: pl.draft, base: b.draft, changed: ch, planned: ch.length > 0 };
    }
    return { ok: true, why: "", draft: b.draft, base: b.draft, changed: [], planned: false, stale: !!pl };
  }
  function slotOfPid(draft, pid) { for (var i = 0; i < SLOTS.length; i++) if (draft[SLOTS[i].id] === pid) return SLOTS[i].id; return null; }

  // The choices for one slot. Only players whose position the slot takes are listed (anyone else is never a choice). A listed player who cannot
  // move says why. A starter in another slot is a slot-to-slot swap, allowed only when each player fits the other's slot and neither is locked.
  function options(S, team, draft, slotId) {
    var slot = slotById(slotId), wk = S.model.week, byId = S.model.byId;
    if (!slot) return { slot: null, occupant: null, blocked: true, why: "Unknown slot", choices: [] };
    var occ = draft[slotId] ? byId[draft[slotId]] || null : null;
    if (occ) { var lk = lockOf(S, occ, wk); if (lk.locked) return { slot: slot, occupant: occ, blocked: true, why: lk.why + ": he can’t be moved out of " + slot.tag + ", and no one can be moved in.", choices: [] }; }
    var choices = [];
    team.players.forEach(function (p) {
      var pid = String(p.id);
      if (occ && pid === String(occ.id)) return;
      if (!accepts(slot, p.pos)) return;                                   // not a position this slot takes: never offered
      var from = slotOfPid(draft, pid), c = { p: p, from: from, ok: true, why: "" };
      if (from) {
        var fs = slotById(from), l2 = lockOf(S, p, wk);
        if (l2.locked) { c.ok = false; c.why = l2.why; }
        else if (occ && !accepts(fs, occ.pos)) { c.ok = false; c.why = occ.name + " can’t play " + fs.tag; }
      } else {
        var st = startable(S, p, wk);
        if (!st.ok) { c.ok = false; c.why = st.why; }
      }
      choices.push(c);
    });
    // usable first (bench before other slots), then the rest; by name within each group
    choices.sort(function (a, b) { return (a.ok === b.ok ? 0 : a.ok ? -1 : 1) || ((a.from ? 1 : 0) - (b.from ? 1 : 0)) || a.p.name.localeCompare(b.p.name); });
    return { slot: slot, occupant: occ, blocked: false, why: "", choices: choices };
  }

  // A swap: pid takes slotId; the slot's occupant takes pid's old slot, or goes to the bench when pid came from the bench.
  function apply(draft, slotId, pid) {
    var out = {}, k, from = slotOfPid(draft, String(pid)), occ = draft[slotId] || "";
    for (k in draft) if (own(draft, k) && draft[k]) out[k] = draft[k];
    out[slotId] = String(pid);
    if (from && from !== slotId) { if (occ) out[from] = occ; else delete out[from]; }
    return out;
  }

  // validateSlots (front_office_lineup.js) on the beta's slots, with rangeProblems (lineup_flex.js): the same counts and the same order of messages.
  function validate(S, team, draft) {
    var wk = S.model.week, byId = S.model.byId, filled = 0, dupes = 0, ineligible = 0, mismatch = 0, seen = {}, byes = [], byeWeek = 0, count = {}, fl = { O: 0, D: 0 }, tot = { O: 0, D: 0 };
    SLOTS.forEach(function (s) {
      var side = sideOf(s); tot[side]++;
      var pid = draft[s.id]; if (!pid) return;
      filled++; fl[side]++;
      if (seen[pid]) dupes++; else seen[pid] = 1;
      var p = byId[pid];
      if (p && p.pos) count[p.pos] = (count[p.pos] || 0) + 1;
      if (p && R.onBye(p, wk)) { byes.push(p.name + (p.nflTeam ? " (" + p.nflTeam + ")" : "")); byeWeek = p.bye; return; }
      if (!p || p.status === "taxi" || p.status === "ir") { ineligible++; return; }
      if (!accepts(s, p.pos)) mismatch++;
    });
    var errors = [], rc = 0;
    function check(g, side) {
      var c = count[g] || 0, r = RANGES[g];
      if (c > r[1]) { errors.push("At most " + r[1] + " " + g + " can start (you have " + c + ")"); rc++; }
      else if (fl[side] === tot[side] && c < r[0]) { errors.push("At least " + r[0] + " " + g + (r[0] === 1 ? " is" : "s are") + " needed to start (you have " + c + ")"); rc++; }
    }
    OFF.forEach(function (g) { check(g, "O"); }); DEF.forEach(function (g) { check(g, "D"); });
    if (byes.length) errors.push(byes.join(", ") + (byes.length === 1 ? " is" : " are") + " on a bye" + (byeWeek > 0 ? " in Week " + byeWeek : "") + " — bench " + (byes.length === 1 ? "him" : "them") + "; MFL won't accept a bye-week starter");
    if (filled < TOTAL) { var need = TOTAL - filled; errors.push("Fill " + need + " more slot" + (need === 1 ? "" : "s")); }
    if (dupes) errors.push(dupes + " player" + (dupes === 1 ? "" : "s") + " used in two slots");
    if (ineligible) errors.push(ineligible + " ineligible (taxi/IR/expired) selected");
    if (mismatch) errors.push(mismatch + " player" + (mismatch === 1 ? "" : "s") + " in the wrong slot");
    var problems = dupes + ineligible + mismatch + byes.length + rc;
    return { ok: problems === 0 && filled === TOTAL, complete: filled === TOTAL, problems: problems, filled: filled, total: TOTAL, errors: errors };
  }

  // The plan in the shape the Lineup view already draws (roster.js lineupFor), so its warnings come from the same code (roster.js attention).
  function lineupOf(S, team, draft) {
    var byId = S.model.byId, slots = SLOTS.map(function (s) { return { slot: s, player: draft[s.id] ? byId[draft[s.id]] || null : null }; });
    var filled = slots.filter(function (x) { return x.player; }).length;
    return { state: "ok", slots: slots, extra: [], unresolved: [], count: filled, filled: filled, scores: {}, total: null, planned: true };
  }
  // Active players not starting in the draft (the plan's bench), grouped like model.benchGroups.
  function benchOf(team, draft, posOrder) {
    var inDraft = {}, k, groups = {};
    for (k in draft) if (own(draft, k) && draft[k]) inDraft[draft[k]] = true;
    team.players.forEach(function (p) { if (p.status === "active" && !inDraft[String(p.id)]) (groups[p.pos] = groups[p.pos] || []).push(p); });
    var order = (posOrder || []).concat(Object.keys(groups).filter(function (g) { return (posOrder || []).indexOf(g) < 0; }));
    return order.filter(function (g) { return groups[g] && groups[g].length; }).map(function (g) { return { pos: g, players: groups[g] }; });
  }

  return { SLOTS: SLOTS, RANGES: RANGES, slotById: slotById, lockOf: lockOf, startable: startable, baseDraft: baseDraft, sig: sig, draftOf: draftOf, changedSlots: changedSlots,
    options: options, apply: apply, validate: validate, lineupOf: lineupOf, benchOf: benchOf, slotOfPid: slotOfPid };
});
