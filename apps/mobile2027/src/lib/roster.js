/* UPS 2027 R2: the facts the Team › Roster views draw (slots, opponents, injury chips, scores, summaries). Pure functions of the
   state object: no network, no storage, no DOM. Every fact that is not known comes back as null or "unavailable", never as 0.

   Two kinds of fact are kept apart on purpose (Keith, 2026-11-20):
     HISTORICAL  a past week's submitted lineup and its scores (read for that week);
     CURRENT     injury status, who is on the roster, contracts, cap rules, and each player's NFL club, bye week and opponent (read now).
   A past week's screen shows only the historical kind. A current fact is never drawn inside a past-week row. In particular no read says
   which NFL club a player was with in a past week, so a past week's opponents and bye weeks are Unavailable (MAT-1, Codex review of
   dc5b35d7): today's club may not be the club he played for. */
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
    var players = e.starters.map(function (id) { return S.model.byId[id] || stub(id); });
    var a = assignSlots(players);
    var filled = a.slots.filter(function (x) { return x.player; }).length;
    return { state: "ok", slots: a.slots, extra: a.extra, count: e.starters.length, filled: filled, scores: e.scores, total: e.total };
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

  // ---------- injury chips (CURRENT information: drawn only on the current week) ----------
  function statusRead(S) { var st = S.intel && S.intel.status; return st && st.state === "ok" ? { state: "ok", data: st.data, at: st.at } : null; }
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
  // Starters who cannot play this week, plus empty slots (current week). Bye, or an injury chip that rules him out.
  function issues(S, lineup, cur) {
    var n = 0, byes = 0, outs = 0, empty = 0;
    lineup.slots.forEach(function (x) {
      if (!x.player) { n++; empty++; return; }
      var c = injuryChip(S, x.player), by = onBye(x.player, cur);
      if (by) byes++;
      if (c && (c.kind === "out" || c.kind === "res")) outs++;
      if (by || (c && (c.kind === "out" || c.kind === "res"))) n++;
    });
    return { n: n, byes: byes, outs: outs, empty: empty };
  }
  // Bench groups that "need you": a player still on the active roster who carries an MFL roster designation (IR, PUP, NFI, SUSP, RET).
  function groupReasons(S, players) {
    return players.filter(function (p) { var c = p.status === "active" ? injuryChip(S, p) : null; return c && c.kind === "res"; })
      .map(function (p) { return p.name + " has an MFL " + injuryChip(S, p).code + " designation"; });
  }
  function endingAfterSeason(team) { return team.players.filter(function (p) { return p.status === "active" && p.years === 1; }).length; }
  function byeCounts(team, cur) {
    var now = 0, next = 0;
    team.players.forEach(function (p) { if (p.status !== "active") return; if (p.bye === cur) now++; else if (cur && p.bye === cur + 1) next++; });
    return { now: now, next: next };
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
    gameState: gameState, oppText: oppText, kickoffText: kickoffText, injuryChip: injuryChip, injuryNote: injuryNote, onBye: onBye,
    scoreOf: scoreOf, teamScoreOf: teamScoreOf, scoreWeek: scoreWeek, avgOf: avgOf, pts: pts, issues: issues, groupReasons: groupReasons,
    endingAfterSeason: endingAfterSeason, byeCounts: byeCounts, relWeek: relWeek, capNote: capNote
  };
});
