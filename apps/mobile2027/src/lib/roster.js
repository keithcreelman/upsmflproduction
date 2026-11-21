/* UPS 2027 R2: the facts the Team › Roster views draw (slots, opponents, injury chips, scores, summaries). Pure functions of the
   state object: no network, no storage, no DOM. Every fact that is not known comes back as null or "unavailable", never as 0.

   Two kinds of fact are kept apart on purpose (Keith, 2026-11-20):
     HISTORICAL  a past week's submitted lineup and its scores (read for that week);
     CURRENT     injury status, who is on the roster, contracts, cap rules, and each player's position, NFL club, bye week and opponent (read now).
   A past week's screen shows only the historical kind. A current fact is never drawn inside a past-week row. In particular no read says
   which NFL club or position a player had in a past week, so a past week's opponents and bye weeks are Unavailable (MAT-1) and its slots,
   empty slots and filled-slot count are not rebuilt: the recorded starters are listed in the recorded order with their scores (MAT-2). */
(function (root, factory) {
  var req = typeof require === "function";
  var api = factory(req ? require("./format.js") : root.UPS2027.format);
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.UPS2027 = root.UPS2027 || {}; root.UPS2027.roster = api; }
})(typeof self !== "undefined" ? self : this, function (F) {
  "use strict";
  var G = typeof globalThis !== "undefined" ? globalThis : {};

  function asArray(v) { return Array.isArray(v) ? v : v == null || v === "" ? [] : [v]; }
  function num(v) {
    if (v == null || typeof v === "boolean" || (typeof v === "string" && v.trim() === "")) return null;
    var n = Number(v); return isFinite(n) ? n : null;
  }
  function pad4(v) { var d = String(v == null ? "" : v).replace(/\D/g, ""); return d ? ("0000" + d).slice(-4) : ""; }

  // The 18 starting slots in the demo's order and with the demo's tags. Canon: docs/league_context_v1.md §B4 (QB 1, RB 2, WR 2, TE 1,
  // Flex 2, SuperFlex 1, K 1, P 1, DL 2, LB 2, DB 2, Defensive Flex 1 = 18).
  var SLOTS = [
    { id: "QB1", tag: "QB1", label: "QB", acc: ["QB"] }, { id: "RB1", tag: "RB1", label: "RB", acc: ["RB"] }, { id: "RB2", tag: "RB2", label: "RB", acc: ["RB"] },
    { id: "WR1", tag: "WR1", label: "WR", acc: ["WR"] }, { id: "WR2", tag: "WR2", label: "WR", acc: ["WR"] }, { id: "TE1", tag: "TE1", label: "TE", acc: ["TE"] },
    { id: "FX1", tag: "FX1", label: "Flex", acc: ["RB", "WR", "TE"], flex: true }, { id: "FX2", tag: "FX2", label: "Flex", acc: ["RB", "WR", "TE"], flex: true },
    { id: "SF", tag: "SF", label: "Superflex", acc: ["QB", "RB", "WR", "TE"], flex: true },
    { id: "K", tag: "K", label: "Kicker", acc: ["PK"] }, { id: "P", tag: "P", label: "Punter", acc: ["PN"] },
    { id: "DL1", tag: "DL1", label: "DL", acc: ["DL"] }, { id: "DL2", tag: "DL2", label: "DL", acc: ["DL"] },
    { id: "LB1", tag: "LB1", label: "LB", acc: ["LB"] }, { id: "LB2", tag: "LB2", label: "LB", acc: ["LB"] },
    { id: "DB1", tag: "DB1", label: "DB", acc: ["DB"] }, { id: "DB2", tag: "DB2", label: "DB", acc: ["DB"] },
    { id: "DF", tag: "DF", label: "Defensive flex", acc: ["DL", "LB", "DB"], flex: true }
  ];

  // Puts the week's starters (in MFL's order) into the slots: the fixed slots first, then the flex slots, each taking the first
  // starter it accepts, the same way the current app does. A starter no slot takes is returned in `extra` (never dropped).
  function assignSlots(players) {
    var placed = {}, used = {};
    function fill(list) {
      list.forEach(function (s) {
        for (var i = 0; i < players.length; i++) {
          var p = players[i];
          if (used[p.id]) continue;
          if (s.acc.indexOf(p.pos) >= 0) { placed[s.id] = p; used[p.id] = true; return; }
        }
      });
    }
    fill(SLOTS.filter(function (s) { return !s.flex; }));
    fill(SLOTS.filter(function (s) { return s.flex; }));
    return {
      slots: SLOTS.map(function (s) { return { slot: s, player: placed[s.id] || null }; }),
      extra: players.filter(function (p) { return !used[p.id]; })
    };
  }

  // MFL weeklyResults -> { fid: { starters: [ids in MFL's order], scores: { id: number|null }, total: number|null } }, or null.
  function weeklyIndex(weekly) {
    var wr = weekly && weekly.weeklyResults;
    if (!wr) return null;
    var out = {}, n = 0;
    asArray(wr.matchup).forEach(function (m) {
      asArray(m && m.franchise).forEach(function (f) {
        var fid = pad4(f && f.id);
        if (!fid) return;
        var starters = [], scores = {};
        asArray(f.player).forEach(function (p) {
          if (!p) return;
          var id = String(p.id);
          scores[id] = num(p.score);
          if (p.status === "starter") starters.push(id);
        });
        out[fid] = { starters: starters, scores: scores, total: num(f.score) };
        n++;
      });
    });
    return n ? out : null;
  }
  function indexOf(rec) { if (!rec || rec.state !== "ok") return null; if (rec._idx === undefined) rec._idx = weeklyIndex(rec.data); return rec._idx; }

  // ---------- which week is on screen ----------
  function weekInfo(S) {
    var cur = S.model ? S.model.week : null, sel = S.wk != null ? S.wk : cur;
    return { cur: cur, sel: sel, past: !!(cur && sel && sel < cur) };
  }
  // The weeks the sheet lists: the current week first, then the played weeks, most recent first, then the later weeks.
  // The week context a view draws with (R2b, P1 and P2). Lineup honors the chosen week; Byes is always "as of now": it uses the current week
  // and today's data, whatever week was chosen (the choice is kept for when the owner returns). Contracts and Performance are Team tabs of
  // their own and do not use the week selector.
  function viewWeek(S) {
    var wi = weekInfo(S);
    if (S.view === "lineup") return wi;
    return { cur: wi.cur, sel: wi.cur, past: false };
  }
  function weekChoices(cur) {
    var all = [];
    for (var n = 1; n <= 17; n++) all.push({ n: n, kind: !cur ? "unknown" : n < cur ? "past" : n === cur ? "current" : "future" });
    if (!cur) return all;
    return all.filter(function (c) { return c.kind === "current"; })
      .concat(all.filter(function (c) { return c.kind === "past"; }).reverse(), all.filter(function (c) { return c.kind === "future"; }));
  }

  // ---------- one team's lineup for one week (historical when the week is past) ----------
  function stub(id) { return { id: String(id), name: "Player " + id, pos: "?", nflTeam: "", status: "gone", franchiseId: "", salary: null, years: 0, type: "", bye: null }; }
  function lineupFor(S, team, wk) {
    if (S.model && wk === S.model.week && team.lineup && team.lineup.state === "ok" && team.lineup.ids) {
      var cp = team.lineup.ids.map(function (id) { return S.model.byId[id] || stub(id); }), ca = assignSlots(cp);
      return { state: "ok", slots: ca.slots, extra: ca.extra, count: cp.length, filled: ca.slots.filter(function (x) { return x.player; }).length, scores: {}, total: null };
    }
    var rec = S.intel && S.intel.wk && S.intel.wk[wk];
    if (!rec || rec.state === "loading") return { state: "loading" };
    if (rec.state !== "ok") return { state: "error", error: rec.error || "" };
    var idx = indexOf(rec), e = idx && idx[team.id];
    if (!e) return { state: "missing" };
    // MAT-2 (Codex, review of 4951dfce): a past week's record is the starters' ids, in MFL's order, with their scores. It does not say which
    // slot each filled or what position he played that week, and today's position may differ, so slots, empty slots and a filled-slot count
    // are NOT rebuilt from today's positions. The starters are listed in the recorded order, with the recorded count.
    var players = e.starters.map(function (id) { return S.model.byId[id] || stub(id); });
    return { state: "ok", recorded: true, starters: players, count: e.starters.length, scores: e.scores, total: e.total };
  }

  // ---------- NFL games ----------
  function gameState(S, wk) {
    var r = S.intel && S.intel.mu && S.intel.mu[wk];
    return !r || r.state === "loading" ? "loading" : r.state === "ok" ? "ok" : "error";
  }
  function gameOf(S, nflTeam, wk) {
    var r = S.intel && S.intel.mu && S.intel.mu[wk];
    return r && r.state === "ok" ? (r.data.games[String(nflTeam || "").toUpperCase()] || null) : null;
  }
  // "vs NYG", "@ DAL", "Bye week", "" while the read is out, or "Opponent unavailable". A team with no game in a week that the
  // read did answer is on a bye only if MFL's own bye week for him says so; otherwise it is unavailable, not a guess.
  function oppText(S, p, wk) {
    var st = gameState(S, wk);
    if (st === "loading") return "";
    if (st === "error") return "Opponent unavailable";
    var g = gameOf(S, p.nflTeam, wk);
    if (g && g.opp) return (g.isHome ? "vs " : "@ ") + g.opp; // MFL's own team code, as the roster rows print it
    return p.bye && p.bye === wk ? "Bye week" : "Opponent unavailable";
  }
  function kickoffText(S, p, wk) {
    var g = gameOf(S, p.nflTeam, wk);
    return g && g.kickoff ? F.etKickoff(g.kickoff) : "";
  }
  // A row shows a kickoff only when it is NOT the ordinary Sunday 1:00 PM slate (R2b, P3). "unknown": the game is known but its time is not
  // (shown as "Kickoff unavailable", never guessed); "none": no game to speak of (a bye, or the games read is out or failed: the opponent
  // text already says which).
  var ORDINARY_SLATE = "Sun 1:00 PM";
  function kickoffInfo(S, p, wk) {
    if (gameState(S, wk) !== "ok") return { state: "none", text: "" };
    var g = gameOf(S, p.nflTeam, wk);
    if (!g) return { state: "none", text: "" };
    var t = g.kickoff ? F.etKickoff(g.kickoff) : "";
    return t ? { state: "known", text: t, ordinary: t === ORDINARY_SLATE } : { state: "unknown", text: "" };
  }

  // ---------- injury chips (CURRENT information: drawn only on the current week) ----------
  function statusRead(S) { var st = S.intel && S.intel.status; return st && st.state === "ok" ? { state: "ok", data: st.data, at: st.at } : null; }
  // The injury read is USABLE only while the resolver would use it: state "ok" with data, and no older than the resolver's own limit
  // (IS.TTL, the same comparison its `fresh` makes), judged on the same clock (S.nowMs, else Date.now()) the chips and note use. An
  // expired read draws no chips, so a screen must not count it as "checked" (R2b Codex finding MAT-1).
  function injuryFresh(S) {
    var IS = G.UPSInjuryStatus, read = statusRead(S);
    if (!IS || !read || !read.data) return false;
    var now = S.nowMs != null ? S.nowMs : Date.now();
    return (now - (read.at || 0)) <= IS.TTL;
  }
  // One chip per player from the classic app's resolver (the derived copy). `code` is the resolver's designation; `kind` is
  // "out" (can't play), "res" (an MFL roster designation: IR, PUP, NFI, SUSP, RET) or "warn" (Questionable, Doubtful, HOLD).
  function injuryChip(S, p) {
    var IS = G.UPSInjuryStatus, read = statusRead(S);
    if (!IS || !read) return null;
    var res = IS.resolve(read, p.id, p.nflTeam, { now: S.nowMs != null ? S.nowMs : Date.now() });
    var c = res.chips && res.chips[0];
    if (!c) return null;
    if (c.t === "IR" && p.status === "ir") return null; // he is already in the Injured reserve section
    var kind = c.cls === "out" ? "out" : c.cls === "res" ? "res" : "warn";
    var text = c.t === "OUT" ? "■ OUT" : c.t === "D" ? "▲ Doubtful" : c.t === "Q" ? "▲ Questionable" : (kind === "res" ? "■ " : "▲ ") + c.t;
    return { cls: kind === "warn" ? "wn" : "cr", text: text, code: c.t, kind: kind };
  }
  // The one line the screen shows only when the injury read is not usable (the resolver's own wording).
  function injuryNote(S) {
    var IS = G.UPSInjuryStatus, st = S.intel && S.intel.status;
    if (!IS) return "";
    if (!st || st.state === "loading") return "Checking injury status…";
    if (st.state === "error") return "Injury status couldn’t be loaded, so no injury tags are shown.";
    return IS.noteText({ state: "ok", data: st.data, at: st.at }, { now: S.nowMs != null ? S.nowMs : Date.now() });
  }

  function onBye(p, wk) { return !!(p.bye && wk && p.bye === wk); }

  // ---------- scores ----------
  // undefined = still being read; null = unknown (the read failed, or he was on no lineup that week)
  function scoreRead(S, wk) { var rec = S.intel && S.intel.wk && S.intel.wk[wk]; return !rec || rec.state === "loading" ? "loading" : rec.state === "ok" ? "ok" : "error"; }
  function scoreOf(S, pid, wk) {
    var rec = S.intel && S.intel.wk && S.intel.wk[wk];
    if (rec && rec.state === "error") return null;
    var idx = indexOf(rec);
    if (!idx) return undefined;
    for (var f in idx) if (Object.prototype.hasOwnProperty.call(idx[f].scores, pid)) return idx[f].scores[pid];
    return null; // read, but he was on no lineup that week
  }
  function teamScoreOf(S, fid, wk) {
    var rec = S.intel && S.intel.wk && S.intel.wk[wk];
    if (rec && rec.state === "error") return null;
    var idx = indexOf(rec);
    if (!idx) return undefined;
    return idx[fid] ? idx[fid].total : null;
  }
  // The week before the selected (current) week: the most recent one whose games are all final. A past week's rows use that week
  // itself (views.js passes it), so this is only for the current week.
  function scoreWeek(wi) { return wi.sel != null && wi.sel - 1 >= 1 ? wi.sel - 1 : null; }
  function avgOf(S, pid, wk) {
    var r = S.intel && S.intel.mu && S.intel.mu[wk];
    if (r && r.state === "error") return null;
    if (!r || r.state !== "ok") return undefined;
    var a = r.data.avg[pid];
    return a ? a.avg : null;
  }
  function pts(v) { return v == null ? "—" : (Math.round(v * 10) / 10).toFixed(1); }

  // ---------- summaries and groups ----------
  // Starting slots that NEED ATTENTION this week (R2b, P3), one entry per slot, never two for the same player: OUT, an MFL roster designation
  // (IR, PUP, NFI, SUSP, RET), Doubtful ("a decision may be needed", not "out"), a bye this week, and a slot that is genuinely empty. A slot is
  // reported as empty only when no starter is left over: a starter that fits no slot is reported as that, never as an empty slot.
  // Questionable is a chip, not an alert. `injuriesChecked` is false while the injury read is out, failed or EXPIRED (see injuryFresh), so a screen never says
  // "nothing needs attention" on an injury read it does not have.
  function attention(S, lineup, cur) {
    var items = [], st = S.intel && S.intel.status;
    lineup.slots.forEach(function (x) {
      var p = x.player; if (!p) return;
      var issues = [], c = injuryChip(S, p);
      if (c && c.kind === "out") issues.push({ kind: "out", text: "Out" });
      else if (c && c.kind === "res") issues.push({ kind: "designation", text: "MFL designation: " + c.code });
      else if (c && c.code === "D") issues.push({ kind: "doubtful", text: "Doubtful: a decision may be needed" });
      if (onBye(p, cur)) issues.push({ kind: "bye", text: "Bye week" });
      if (issues.length) items.push({ slot: x.slot, player: p, issues: issues });
    });
    var extras = lineup.extra || [];
    var empties = extras.length ? [] : lineup.slots.filter(function (x) { return !x.player; }).map(function (x) { return x.slot; });
    return { items: items, empties: empties, extras: extras, n: items.length + empties.length + extras.length, injuriesChecked: injuryFresh(S), injuryState: st ? (st.state === "ok" && !injuryFresh(S) ? "stale" : st.state) : "loading" };
  }
  // Bench groups that "need you": a player still on the active roster who carries an MFL roster designation (IR, PUP, NFI, SUSP, RET).
  function groupReasons(S, players) {
    return players.filter(function (p) { var c = p.status === "active" ? injuryChip(S, p) : null; return c && c.kind === "res"; })
      .map(function (p) { return p.name + " has an MFL " + injuryChip(S, p).code + " designation"; });
  }
  function endingAfterSeason(team) { return team.players.filter(function (p) { return p.status === "active" && p.years === 1; }).length; }
  // Byes (R2b, P6): players grouped by their bye week, in week order from this week on, with the starters in TODAY's lineup that each bye
  // would leave out. Slots are today's (Week `cur`): the lineup for a later week is not known, so a group never claims who will fill a slot then.
  // Already-played byes and players with no bye week are returned apart.
  function byeGroups(S, team, cur, lineup) {
    var have = !!(lineup && lineup.state === "ok"), slotOf = {}, order = {};
    if (have) lineup.slots.forEach(function (x, i) { if (x.player) { slotOf[x.player.id] = x.slot.tag; order[x.player.id] = i; } });
    function isStarter(p) { return slotOf[p.id] !== undefined; }
    function sortP(a, b) {
      if (isStarter(a) !== isStarter(b)) return isStarter(a) ? -1 : 1;
      if (isStarter(a)) return order[a.id] - order[b.id];
      return (F.POS_ORDER.indexOf(a.pos) - F.POS_ORDER.indexOf(b.pos)) || a.name.localeCompare(b.name);
    }
    var weeks = {}, past = [], none = [];
    team.players.forEach(function (p) {
      if (!p.bye) none.push(p);
      else if (cur && p.bye < cur) past.push(p);
      else (weeks[p.bye] = weeks[p.bye] || []).push(p);
    });
    var groups = Object.keys(weeks).map(Number).sort(function (a, b) { return a - b; }).map(function (w) {
      var ps = weeks[w].sort(sortP);
      return { week: w, players: ps, starters: ps.filter(isStarter).map(function (p) { return { tag: slotOf[p.id], player: p }; }) };
    });
    past.sort(function (a, b) { return (a.bye - b.bye) || sortP(a, b); }); none.sort(sortP);
    return { groups: groups, past: past, none: none, haveLineup: have, slotOf: slotOf };
  }
  function relWeek(bye, cur) {
    if (!bye) return "bye week unavailable";
    if (!cur) return "week " + bye;
    return bye === cur ? "this week" : bye < cur ? "earlier" : "in " + (bye - cur) + " wk" + (bye - cur > 1 ? "s" : "");
  }
  // Rule notes for the Contracts view (canon: docs/league_context_v1.md: salary on taxi does not count against the cap; IR is 50% cap relief).
  function capNote(p) { return p.status === "ir" ? " · cap hit 50%" : p.status === "taxi" ? " · taxi, $0 on cap" : ""; }

  return {
    SLOTS: SLOTS, assignSlots: assignSlots, weeklyIndex: weeklyIndex, weekInfo: weekInfo, weekChoices: weekChoices, lineupFor: lineupFor,
    gameState: gameState, oppText: oppText, kickoffText: kickoffText, injuryChip: injuryChip, injuryFresh: injuryFresh, injuryNote: injuryNote, onBye: onBye,
    scoreOf: scoreOf, scoreRead: scoreRead, teamScoreOf: teamScoreOf, scoreWeek: scoreWeek, avgOf: avgOf, pts: pts, attention: attention, groupReasons: groupReasons,
    endingAfterSeason: endingAfterSeason, byeGroups: byeGroups, relWeek: relWeek, capNote: capNote, viewWeek: viewWeek, kickoffInfo: kickoffInfo, ORDINARY_SLATE: ORDINARY_SLATE
  };
});
