/* Players tab — Free-agent browser + in-app waiver acquisition.
   Free agents = anyone in players export NOT on any roster (exempts taxi/IR
   since those ARE on rosters). Rows show Name / POS / NFL team / actual pts
   (MFL league scoring, completed weeks — see pointsBasis) / PPG · games / rank,
   then next week's projection + matchup. Tap row opens player sheet.

   ACQUISITION (2026-07-30 — in-app waivers, Phase 3):
   This file used to deep-link out to MFL's native /add_drop form because no
   UPS worker route existed. It now drives the real thing:
     POST /api/waivers/bbid-plan   — blind-bid rounds (see §2 below)
     POST /api/waivers/fcfs        — a one-shot first-come add
   The window (blind-bid vs FCFS vs blackout vs not-yet-open) is NEVER derived
   here: it comes from GET /api/waivers/state, which mirrors MFL's own league
   calendar (WAIVER_BBID runs, WAIVER_NONE blackout spans). See
   docs/ups_v2/V2_GOVERNED/requirements/actions/add_action_rule.md — the rule
   that a player either gets a real Add, a real Bid, or context text, but
   never a dead/disabled button.

   CONTRACT v2 (the rules this file must not break):
     §1 pending/verified claims arrive as { known, rounds }. Adopt server
        state ONLY when known === true. known:false = "we couldn't read MFL",
        which is NOT "you have no claims" — keep the local plan, warn visibly.
     §2 clearing a round is EXPLICIT: a round sent with picks:[] is cleared, a
        round left OUT of the payload is untouched. `rounds: []` therefore
        means "change nothing". Withdrawing = sending the round back empty.
     §3 a dry run writes nothing, so it is never truth: render would_write as
        a preview and leave the local plan alone.
     §4 the mode is window.mode from the server. Never re-derived here.
     §5 write_enabled false → read-only view + the MFL link, no submit CTA.
     §6 roster/cap headroom is ADVISORY — never hard-block a move on a number
        we are not sure of. One carve-out (Keith 2026-08-08): "No drop" is
        withheld when the active roster is KNOWN full against the UPS roster
        ceiling (27 min / 35 pre-deadline / 30 post-deadline, via
        DATA.rosterCapMax()), because that option can only be refused. Anything
        unknown still offers it. See rosterHeadroom().

   The drop sheet that was parked here in 2026-05-15 is resurrected as a
   general-purpose drop PICKER (openDropPicker) and now serves three callers:
   the FCFS drop list, the BBID conditional drop, and re-editing a staged pick.
*/
(function () {
  "use strict";
  if (!window.UPS_MOBILE) return;
  var M = window.UPS_MOBILE;
  var U = M.util;
  var DATA = M.data;

  var FO = window.UPS_FRONT_OFFICE_LINEUP;

  var POSITIONS = ["ALL", "QB", "RB", "WR", "TE", "PK", "PN", "DL", "LB", "DB"];
  var POS_GROUP = {
    DT: "DL", DE: "DL",
    LB: "LB",
    CB: "DB", S: "DB"
  };
  // Canonical group for the matchup/window lookups. POS_GROUP above only
  // knows DT/DE and CB/S — it misses FS/SS/NT/OLB/ILB/MLB/HB/FB/K/P, and the
  // worker's defRatings are keyed QB/RB/WR/TE/PK/PN/DL/LB/DB, so a raw
  // position would silently miss the rating (or read the wrong one). FO owns
  // the full vocabulary. Falls back to the local map only if front_office_
  // lineup.js somehow didn't load, in which case the miss renders nothing.
  function posGrp(pos) {
    var p = U.safeStr(pos).toUpperCase();
    return FO ? FO.posGroup(p) : (POS_GROUP[p] || p);
  }

  // Volatile UI state — survives between renders within one session.
  var view = {
    query: "",
    pos: "ALL",
    scope: "fa",    // "fa" (default) | "all" — Keith 2026-06-08: allow browsing ALL players
    teamFilter: "", // "" = none | franchise id — filter list to one team (Keith 2026-06-10)
    sort: "ppg",    // "ppg" | "pts" | "proj" | "hot" | "cold"
    window: 0,      // 0 = YTD (season) | 2 | 4 | 6 = last-N weeks
    debounceTimer: null,
    dropSheetFor: null   // pid of player being added (drop-sheet open)
  };

  // Bid-sheet working state. `editRef` is set when re-opening an already
  // staged pick so Confirm replaces it in place instead of appending.
  var bidView = null;
  // Drop-picker callback for the currently open picker.
  var dropPicker = null;

  function franchiseName(fid) {
    var f = (M.state.franchises || []).find(function (x) { return x.id === U.pad4(fid); });
    return f ? f.name : ("Franchise " + fid);
  }
  // pid → owning franchise id (for "All players" scope → propose-trade).
  function rosteredFidByPid() {
    var map = {};
    var rs = M.state.rosters && M.state.rosters.rosters;
    if (rs) {
      U.asArray(rs.franchise).forEach(function (fr) {
        var fid = U.pad4(fr.id);
        U.asArray(fr.player).forEach(function (p) { if (p && p.id) map[String(p.id)] = fid; });
      });
    }
    return map;
  }

  function nameFor(player) {
    var raw = U.safeStr(player && player.name);
    if (!raw) return "";
    if (raw.indexOf(",") >= 0) {
      var parts = raw.split(",");
      var last = (parts[0] || "").trim();
      var rest = (parts[1] || "").trim();
      return rest ? rest + " " + last : last;
    }
    return raw;
  }
  function nameForPid(pid) {
    return nameFor(DATA.playerById(pid)) || ("Player " + pid);
  }
  function posTeamForPid(pid) {
    var p = DATA.playerById(pid);
    var pos = U.safeStr(p && p.position).toUpperCase();
    var team = U.safeStr(p && p.team);
    return pos + (team ? " · " + team : "");
  }

  // ══ Actual points (MFL league scoring) ═════════════════════════════════
  // EVERY points number on this screen — Season, L2/L4/L6, PPG, positional rank —
  // comes from ONE source: DATA.getSeasonScoring(), i.e. MFL's own per-week
  // playerScores for THIS league (site/m/season_scoring.js has the rules).
  // "Season" is MFL's own YTD, a week still being played included (Keith
  // 2026-10-02: after Thursday night of Week 4 the screen still showed Wk 1–3
  // totals while MFL's YTD had the game — Andre Szmyt 27.7 here, 40.7 on MFL).
  // Only the last-N windows are FINAL weeks, and they say so on their label.
  // Keith 2026-10-01: "YTD Points do not appear to match the points players
  // actually scored in our MFL league" — they didn't. YTD came
  // from /api/advanced-stats-leaderboard's mfl_points, a D1 copy of src_weekly
  // that the standings sync had cut down to ACTIVE-roster rows, so every free
  // agent read 0.0 and the PPG sort put one-week wonders on top; L2/L4/L6 came
  // from a third source again (/api/lineup-matchups). Players the board didn't
  // return got MFL's YTD divided by CALENDAR weeks, which ignored byes and ran
  // a week behind every Tuesday/Wednesday — exactly when bids are placed.
  //
  // Basis, in order:
  //   season       MFL has posted a current-season score → MFL's numbers.
  //   prior        the read worked but MFL has posted no current-season score
  //                yet (preseason) → last season's final board, labelled with
  //                ITS year, never as "YTD".
  //   none         nothing to show for either season.
  //   unavailable  MFL's scoring didn't load (or came back unreadable) → say
  //                so; no substitute number.
  var SSMOD = window.UPS_MOBILE_SEASON_SCORING || null;
  function seasonScoring() { return DATA.getSeasonScoring ? DATA.getSeasonScoring() : null; }
  function pointsBasis() {
    var ss = seasonScoring();
    if (ss && ss.known && ss.seasonWeeks.length) return { kind: "season", ss: ss };
    if (ss && ss.known) {
      var cur = U.safeInt(M.state.ctx && M.state.ctx.year, 0);
      var priorYear = cur - 1;
      var priorMap = DATA.getAdvancedStatsMap ? DATA.getAdvancedStatsMap(priorYear) : null;
      // A current-year leaderboard can contain preseason rows even before MFL
      // posts a score. Read the previous year explicitly, never infer it from
      // whichever leaderboard happened to be the latest nonempty one.
      if (priorYear > 0 && priorMap && Object.keys(priorMap).length) {
        return { kind: "prior", year: priorYear, map: priorMap, ss: ss };
      }
      return { kind: "none", ss: ss };
    }
    return { kind: "unavailable", reason: ss && ss.reason || "unavailable" };
  }
  // Canonical group for a pid, for ranking ("" = not a fantasy position).
  function groupOfPid(pid) {
    var pl = DATA.playerById(pid);
    var g = posGrp(pl && pl.position);
    return (g && g !== "OTH") ? g : "";
  }
  // MFL wks a player needs for a PPG rank in period k (season_scoring's
  // rankMinimum: half the final weeks for Season, half the window for Last N).
  // Below it the player keeps his real PPG but shows "unranked · 1 MFL wk"
  // and sorts after every ranked player under Sort: PPG (Keith 2026-10-02).
  function rankMinFor(ss, k) { return ss && ss.rankMinimum ? ss.rankMinimum(k) : 1; }
  // Positional PPG rank for the season or a last-N window, cached per
  // (scoring object, window) so the search box doesn't re-sort ~1,300 players
  // on every keystroke. Players below the minimum aren't in it at all.
  var rankCache = { ss: null, key: null, map: null };
  function rankMapFor(ss, k) {
    if (!ss || !SSMOD) return {};
    if (rankCache.ss === ss && rankCache.key === k && rankCache.map) return rankCache.map;
    var map = SSMOD.rankMap(ss.windowFor(k), groupOfPid, rankMinFor(ss, k));
    rankCache = { ss: ss, key: k, map: map };
    return map;
  }

  function buildFreeAgents() {
    var rostered = DATA.getAllRosteredPids();
    // "All Players" OR a specific team filter both need rostered players in
    // the list + their owner mapping.
    var showAll = (view.scope === "all") || !!view.teamFilter;
    var fidByPid = showAll ? rosteredFidByPid() : null;
    var basis = pointsBasis();
    var seasonMap = basis.kind === "season" ? basis.ss.byPid : null;
    var seasonRank = seasonMap ? rankMapFor(basis.ss, 0) : null;
    var priorMap = basis.kind === "prior" ? basis.map : null;
    var players = (M.state.players && M.state.players.players) || null;
    if (!players) return [];
    var list = U.asArray(players.player);
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!p || !p.id) continue;
      var pid = String(p.id);
      var isRostered = rostered.has(pid);
      if (!showAll && isRostered) continue;
      var pos = U.safeStr(p.position).toUpperCase();
      if (!pos) continue;
      var group = POS_GROUP[pos] || pos;
      var grp = posGrp(pos);
      // pts/games/ppg are null when UNKNOWN. A player MFL has no completed-week
      // row for really did score nothing yet: 0 points, 0 games, no PPG.
      var pts = null, games = null, ppg = null, rank = 0, rankGroup = grp;
      if (seasonMap) {
        var st = seasonMap[pid];
        pts = st ? st.pts : 0;
        games = st ? st.games : 0;
        ppg = st ? st.ppg : null;
        var rk = seasonRank[pid];
        if (rk) { rank = rk.rank; rankGroup = rk.group; }
      } else if (priorMap && priorMap[pid]) {
        var pr = priorMap[pid];
        pts = Number(pr.mfl_points || 0);
        games = U.safeInt(pr.games, 0);
        ppg = Number(pr.mfl_ppg || 0);
        rank = U.safeInt(pr.posRank, 0);
        rankGroup = U.safeStr(pr.pos) || grp;
      }
      var keep = (pts || 0) > 0 || ["QB", "RB", "WR", "TE", "PK", "PN"].indexOf(group) !== -1
                 || ["DL", "LB", "DB"].indexOf(group) !== -1;
      if (!keep) continue;
      out.push({
        id: pid,
        name: nameFor(p) || ("Player " + pid),
        pos: pos,
        // `group` drives the position chips. `grp` is the canonical group the
        // worker's defRatings and every rank here are keyed by — see posGrp().
        group: group,
        grp: grp,
        team: U.safeStr(p.team),
        ytdPts: pts,
        ytdGames: games,
        ppg: ppg,
        posRank: rank,
        rankGroup: rankGroup,
        rosteredFid: (isRostered && fidByPid) ? (fidByPid[pid] || "") : ""
      });
    }
    return out;
  }

  // ══ Decision-support intel (projection + upcoming matchup) ═════════════
  // The projection and the opponent / defense-rank line are READ from
  // views/lineup.js's M.lineupIntel — the same /api/lineup-matchups call, the
  // same per-window cache, the same join. Window POINTS no longer come from
  // its playerWindow (2026-10-01): that dropped any week the player's CURRENT
  // NFL team didn't play, and it was a second points source beside YTD. They
  // come from pointsBasis() above, like every other points number here. If the
  // intel module or its data is missing, the matchup line simply isn't drawn.
  function intel() { return M.lineupIntel || null; }
  // CHOSEN vs EFFECTIVE (2026-10-02). view.window / view.sort hold what the
  // owner picked, and no render ever rewrites them. A choice that can't apply
  // right now — "Last 2 wks" before three weeks are final, Most added /
  // Most dropped outside Free agents, a projection sort before projections
  // load — falls back for THIS render only (eff.*) and comes back by itself.
  // clampControls used to overwrite the choice: pick Most added, peek at All
  // players, come back, and the list had quietly become PPG.
  var eff = { window: 0, sort: "ppg", sortNote: "" };
  function winKey() { return eff.window; }

  // Which window toggles are meaningful. A last-N window is FINAL weeks only,
  // and it is offered once MORE than N weeks are final — before that it is
  // just "every final week", a dead control (same rule as the Lineup view's
  // availWindows()). No week known to be final (the week check failed) ⇒ no
  // windows at all, never a guess. Preseason / prior-season basis ⇒ Season
  // only ⇒ the toggle row doesn't render at all.
  function availWindows() {
    var b = pointsBasis(), wa = b.kind === "season" ? b.ss.finalWeeks.length : 0, out = [[0, "YTD"]];
    if (wa > 2) out.push([2, "L2"]);
    if (wa > 4) out.push([4, "L4"]);
    if (wa > 6) out.push([6, "L6"]);
    return out;
  }
  // Resolve this render's EFFECTIVE period and sort from the owner's choices
  // (see eff above). Never writes view.*.
  function clampControls() {
    var wk = view.window || 0;
    eff.window = availWindows().some(function (o) { return o[0] === wk; }) ? wk : 0;
    var s = view.sort || "ppg", note = "";
    if (s === "proj" && !projReady()) {
      note = "the " + projLabel().toLowerCase() + " isn't loaded yet";
      s = "ppg";
    } else if ((s === "hot" || s === "cold") && !faScopeActive()) {
      // Hot/Cold only make sense in FA scope: MFL's topAdds/topDrops are free
      // agents only. Do NOT fall back on "not loaded yet" / "MFL unreadable" —
      // those are real, active states (a loading note / an inline notice).
      note = (s === "hot" ? "Most added" : "Most dropped") + " covers free agents only";
      s = "ppg";
    }
    eff.sort = s;
    eff.sortNote = note ? (note + " — sorted by PPG here") : "";
    // What every row's points chip names: "Wks 1–4" (Season = MFL YTD) /
    // "Wks 2–3 final" (a last-N window) / "2025 season".
    var b = pointsBasis();
    eff.span = b.kind === "season"
      ? (SSMOD ? SSMOD.weeksLabel(windowWeeks(eff.window)) : "") + (eff.window ? " final" : "")
      : (b.kind === "prior" ? (b.year + " season") : "");
  }

  // The weeks a period covers, and its name. Same weeks season_scoring sums:
  //   Season      every posted week — "Wks 1–4 · live" while Week 4 is being
  //               played, "Wks 1–4 · final" once it isn't, bare "Wks 1–4"
  //               when the week check failed and finality is unknown.
  //   Last N wks  the last N FINAL weeks — always "· final".
  // Short on purpose: four of these share a 320px row late in the season.
  function windowWeeks(k) {
    var b = pointsBasis();
    if (b.kind !== "season") return [];
    if (!k) return b.ss.seasonWeeks;
    var lo = b.ss.finalThrough - k + 1;
    return b.ss.finalWeeks.filter(function (w) { return w >= lo; });
  }
  function periodName(k) { return k ? ("Last " + k + " wks") : "Season"; }
  // { weeks: "Wks 1–4", status: "live" | "final" | "" }
  function periodParts(k) {
    var b = pointsBasis();
    var weeks = SSMOD ? SSMOD.weeksLabel(windowWeeks(k)) : "";
    if (!weeks || b.kind !== "season") return { weeks: weeks, status: "" };
    if (k) return { weeks: weeks, status: "final" };
    if (b.ss.liveWeeks.length) return { weeks: weeks, status: "live" };
    return { weeks: weeks, status: b.ss.finalKnown ? "final" : "" };
  }
  function periodSpan(k) {
    var pp = periodParts(k);
    return pp.weeks + (pp.status ? " · " + pp.status : "");
  }

  // Total / PPG / games / positional rank for the selected window, from the
  // one MFL source (see pointsBasis). `pts` null = we have no number (show
  // nothing, sort last); `ppg` null = no scored weeks in the window (0 MFL wks, not 0.0 PPG).
  // A player with no MFL row in the window (season or final weeks) genuinely
  // scored nothing in it yet, so that is 0 pts / 0 MFL wks — a real answer,
  // unlike an unloaded source.
  function statsFor(r) {
    var b = pointsBasis();
    // `label` is the span the numbers cover, shown on the row's points chip.
    // `ranked` false = has a PPG but fewer than `minGames` MFL wks this period.
    if (b.kind === "unavailable") return { have: false, unavailable: true, label: "season" };
    if (b.kind === "prior") {
      // Last season's final board, ranked as it was served — the minimum is a
      // current-season rule (its base is this season's final weeks).
      return r.ytdPts === null
        ? { have: false, label: eff.span }
        : { have: true, label: eff.span, pts: r.ytdPts, ppg: r.ppg, games: r.ytdGames,
            rank: r.posRank, group: r.rankGroup, ranked: true };
    }
    if (b.kind !== "season") return { have: false, label: "season" };
    var k = winKey(), min = rankMinFor(b.ss, k);
    if (!k) {
      return { have: true, label: eff.span, pts: r.ytdPts, ppg: r.ppg, games: r.ytdGames,
               rank: r.posRank, group: r.rankGroup, minGames: min, ranked: r.ytdGames >= min };
    }
    var f = b.ss.windowFor(k)[String(r.id)];
    var rk = rankMapFor(b.ss, k)[String(r.id)];
    var g = f ? f.games : 0;
    return { have: true, label: eff.span, pts: f ? f.pts : 0, ppg: f ? f.ppg : null, games: g,
      rank: rk ? rk.rank : 0, group: rk ? rk.group : r.grp, minGames: min, ranked: g >= min };
  }
  function projFor(pid) { var I = intel(); return I ? I.projFor(pid) : null; }
  // Projections only exist once MFL publishes them for the upcoming week —
  // no projections ⇒ the Proj sort button is not offered.
  function projReady() { var I = intel(); return !!(I && I.projLoaded()); }

  // ══ Hot/Cold (MFL platform-wide add/drop trend) ════════════════════════
  // GET /api/hot-cold (worker) mirrors MFL's own topAdds ("Who's Hot?") /
  // topDrops ("Who's Cold?") exports — most-added / most-dropped free agents
  // across EVERY MFL-hosted league this week, not just ours. Lazy: fetched
  // only when the Hot or Cold sort button is first tapped (see bind()),
  // never on the Market screen's default render.
  //
  // Only offered in FA scope: topAdds/topDrops with STATUS=FA structurally
  // cannot match most rows while browsing "All Players" or a single team's
  // roster, so the buttons don't render there (see renderToolbar).
  function faScopeActive() { return view.scope !== "all" && !view.teamFilter; }
  function hotColdData() { return (M.hotCold && M.hotCold.get) ? M.hotCold.get() : null; }
  function hotColdLoading() { return !!(M.hotCold && M.hotCold.isLoading && M.hotCold.isLoading()); }
  // The {pid: percent} map for one side, or null when it hasn't loaded yet
  // OR MFL's export was unreadable. null is UNKNOWN — never treated the same
  // as "nobody is trending" (same known/unknown discipline as every other
  // MFL-backed read in this app, e.g. M.waivers.getPending()).
  function hotColdMapFor(side) {
    var hc = hotColdData();
    if (!hc) return null;
    return side === "hot" ? hc.hot : side === "cold" ? hc.cold : null;
  }
  // Owner-facing text for a side that came back known:false. "" once it's
  // loaded fine (or hasn't been tapped yet — nothing to say before then).
  function hotColdErrorFor(side) {
    var hc = hotColdData();
    if (!hc) return "";
    if (side === "hot") return hc.hot ? "" : (hc.hotError || "Couldn't read MFL's most-added list.");
    if (side === "cold") return hc.cold ? "" : (hc.coldError || "Couldn't read MFL's most-dropped list.");
    return "";
  }
  // undefined (never null/0) means "not on MFL's list" — a real 0.0% is a
  // legitimate answer and must sort ABOVE "no data", not get conflated with
  // it. filterAndSort's have-predicate below relies on this distinction.
  function hotColdPercent(side, pid) {
    var map = hotColdMapFor(side);
    if (!map) return undefined;
    var v = map[String(pid)];
    return typeof v === "number" ? v : undefined;
  }
  function hotColdBadgeHtml(r) {
    if (eff.sort !== "hot" && eff.sort !== "cold") return "";
    var pct = hotColdPercent(eff.sort, r.id);
    if (pct === undefined) return "";
    var icon = eff.sort === "hot" ? "🔥" : "❄️";
    return '<span>' + icon + ' ' + pct.toFixed(1) + '%</span>';
  }

  function filterAndSort(all) {
    var q = view.query.trim().toLowerCase();
    var pos = view.pos;
    var filtered = all.filter(function (r) {
      if (view.teamFilter && r.rosteredFid !== view.teamFilter) return false;
      if (pos !== "ALL" && r.group !== pos) return false;
      if (q) {
        var hay = (r.name + " " + r.team + " " + r.pos).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
    // Annotate once, then sort — statsFor does map lookups and a comparator
    // would repeat them O(n log n) times.
    filtered.forEach(function (r) { r.win = statsFor(r); });
    // Rows we have no number for always sort LAST, by partition rather than by
    // a sentinel value: fantasy scores (and so window totals) can be negative,
    // so "unknown = -1" would rank a real -3.5 below a blank.
    function by(valOf, haveOf) {
      return function (a, b) {
        var ha = haveOf(a), hb = haveOf(b);
        if (ha !== hb) return ha ? -1 : 1;
        if (!ha) return 0;
        return valOf(b) - valOf(a);
      };
    }
    // PPG has its own predicate: a player with no games has no average, and
    // sorting him as 0.0 would rank him above every real negative average.
    function ptsHave(r) { return !!r.win.have && r.win.pts != null; }
    function ppgHave(r) { return !!r.win.have && r.win.ppg != null; }
    if (eff.sort === "proj") {
      filtered.sort(by(function (r) { return projFor(r.id); },
                      function (r) { return projFor(r.id) != null; }));
    } else if (eff.sort === "hot") {
      filtered.sort(by(function (r) { return hotColdPercent("hot", r.id); },
                      function (r) { return hotColdPercent("hot", r.id) !== undefined; }));
    } else if (eff.sort === "cold") {
      filtered.sort(by(function (r) { return hotColdPercent("cold", r.id); },
                      function (r) { return hotColdPercent("cold", r.id) !== undefined; }));
    } else if (eff.sort === "pts") {
      filtered.sort(by(function (r) { return r.win.pts; }, ptsHave));
    } else {
      // Sort: PPG — ranked players first, then those below the rank minimum
      // (each group by PPG), then no PPG at all. A one-week 31.5 no longer
      // sits above every real three-week average (Keith 2026-10-02).
      var byPpg = by(function (r) { return r.win.ppg; }, ppgHave);
      filtered.sort(function (a, b) {
        var ha = ppgHave(a), hb = ppgHave(b);
        if (ha && hb && (a.win.ranked !== false) !== (b.win.ranked !== false)) return a.win.ranked !== false ? -1 : 1;
        return byPpg(a, b);
      });
    }
    return filtered;
  }

  // ══ Waiver window / CTA resolution ═════════════════════════════════════
  // Everything below reads M.waivers (app.js), which reads
  // GET /api/waivers/state. No waiver timing is computed in this file, and
  // per contract v2 §4 the MODE is not re-derived either — `window.mode` is
  // the server's answer and we render off it verbatim.

  function waiverModeInfo() {
    return (M.waivers && M.waivers.mode)
      ? M.waivers.mode()
      : { mode: "unknown", label: "", detail: "", writeEnabled: false, nativeLink: "" };
  }
  // §5: no submit/add control may render while the server says writes are off.
  function writeEnabled() {
    return !!(M.waivers && M.waivers.writeEnabled && M.waivers.writeEnabled());
  }
  function nativeLink() {
    return (M.waivers && M.waivers.nativeLink) ? M.waivers.nativeLink() : "";
  }
  function waiverLimits() {
    return (M.waivers && M.waivers.limits) ? M.waivers.limits() : null;
  }
  function stagedPlan() {
    return (M.waivers && M.waivers.getPlan) ? M.waivers.getPlan() : [];
  }
  function stagedCount() {
    return (M.waivers && M.waivers.pickCount) ? M.waivers.pickCount() : 0;
  }
  // Rounds staged for an explicit clear (a pending withdrawal). Submittable
  // work that carries no picks — see contract v2 §2.
  function clearCount() {
    return (M.waivers && M.waivers.clearCount) ? M.waivers.clearCount() : 0;
  }
  function planIsDirty() {
    return !!(M.waivers && M.waivers.isDirty && M.waivers.isDirty());
  }
  // What MFL last told us it is holding. `known:false` means the read failed
  // — the count is not zero, it is UNKNOWN, and the UI must say so rather
  // than implying an empty slate (contract v2 §1).
  function pendingInfo() {
    var p = (M.waivers && M.waivers.getPending) ? M.waivers.getPending() : null;
    var known = !!(p && p.known === true && Array.isArray(p.rounds));
    var rounds = known ? p.rounds : [];
    var count = rounds.reduce(function (n, g) { return n + ((g.picks || []).length); }, 0);
    return { known: known, count: count, rounds: rounds };
  }
  // The read-only escape hatch. Offered instead of a write whenever the kill
  // switch is dark — never a button whose only outcome is a 503.
  function openNativeWaiverPage() {
    // "Switched off" is only true when we actually LOADED state and it said so.
    // A failed load is a different sentence — see app.js waiverStateKnown().
    var known = !(M.waivers && M.waivers.stateKnown) || M.waivers.stateKnown();
    var why = known
      ? "In-app waiver moves are switched off right now."
      : "Couldn't reach the waiver service — retrying in the background.";
    var link = nativeLink();
    if (!link) {
      M.ui.showToast(why, "err");
      return;
    }
    if (window.confirm(why + "\n\nOpen MFL's own add/drop page?")) {
      window.open(link, "_blank");
    }
  }
  // Which groups is this player already claimed in? (Same player in multiple
  // priority groups is legal — we surface it, we don't block it.)
  function stagedRoundsFor(pid) {
    var rounds = [];
    stagedPlan().forEach(function (g) {
      (g.picks || []).forEach(function (p) {
        if (String(p.add_pid) === String(pid)) rounds.push(g.round);
      });
    });
    return rounds;
  }
  // Where this player's FIRST staged claim lives, as an editRef the bid sheet
  // understands. commitPlan keeps the plan round-sorted, so "first" is the
  // lowest group — the one that gets processed soonest.
  function firstStagedRefFor(pid) {
    var plan = stagedPlan();
    for (var i = 0; i < plan.length; i++) {
      var picks = plan[i].picks || [];
      for (var j = 0; j < picks.length; j++) {
        if (String(picks[j].add_pid) === String(pid)) {
          return { round: U.safeInt(plan[i].round, 0), index: j };
        }
      }
    }
    return null;
  }
  // THE entry point for "act on this player's bid" from any surface.
  //
  // The Market button used to relabel itself "Bid ✓" once a claim was staged —
  // which reads as "tap to see/change it" — and then opened a blank CREATE
  // sheet: minimum bid, group 1, no drop. Your $12K looked like it had
  // vanished, and confirming staged a SECOND minimum-priced claim (or, if it
  // was already in group 1, hit the dupe guard and appeared to do nothing at
  // all). The claims screen's Edit button did the right thing all along, so the
  // same-looking control behaved two opposite ways depending on where you
  // tapped it. That is the "disjointed between that and edit".
  function openBidFor(pid) {
    // Reconcile a run-stale board BEFORE anything is staged on top of it.
    //
    // A bid staged from the Market never opens the Claims screen, so without
    // this the new pick lands on a plan still carrying a pre-run stamp — and
    // the next trip to Claims wipes the whole board, the fresh pick with it,
    // while telling the owner MFL "processed" a claim MFL has never seen.
    // Clearing first means the new pick starts on a clean board and the stamp
    // is already nulled (runProcessedClear nulls it even when the board is
    // empty), so nothing staged from here on can be mistaken for pre-run work.
    runProcessedClear();
    var refs = stagedRoundsFor(pid);
    // Claimed in several groups (a deliberate ladder) — we can't know which one
    // they mean, so hand them the screen that shows all of them rather than
    // guessing and silently editing the wrong bid.
    if (refs.length > 1) { openClaimsScreen(); return; }
    openBidSheet(pid, refs.length === 1 ? firstStagedRefFor(pid) : null);
  }

  // The one place that decides which acquisition control an unrostered
  // player gets. Three outcomes, per add_action_rule.md:
  //   bbid → "Bid"      fcfs → "Add"      anything else → NO button.
  // A missing waiver state, missing limits, or no signed-in franchise all
  // collapse to "no button", because the spec would rather show nothing
  // than a control that can't work.
  //
  // §5 adds one more: `write_enabled:false` from the server means NO submit
  // control renders at all — the surfaces show the read-only view plus the
  // MFL native link instead. `info.writeEnabled` already folds the kill
  // switch together with the window, so this is the whole check.
  function acquisitionCta(pid, opts) {
    opts = opts || {};
    var info = waiverModeInfo();
    if (!M.state.viewerFranchiseId) return { mode: "unknown", html: "" };
    if (!info.writeEnabled) return { mode: info.mode, html: "", readOnly: true };
    if (info.mode === "bbid") {
      if (!waiverLimits()) return { mode: "unknown", html: "" };
      var rounds = stagedRoundsFor(pid);
      // Says what the tap DOES. "Bid ✓" read as a status ("done") on a control
      // that is actually still a button, and it opened a blank create sheet —
      // see openBidFor. One staged claim → edit it; several → the claims screen.
      var label = rounds.length
        ? (rounds.length > 1 ? "Edit bids ×" + rounds.length : "Edit bid")
        : "Bid";
      return {
        mode: "bbid",
        html: '<button class="ups-m-fa-add bid' + (rounds.length ? " staged" : "") +
          '" data-act="waiver-bid" data-pid="' + U.escapeHtml(String(pid)) + '">' +
          U.escapeHtml(label) + '</button>'
      };
    }
    if (info.mode === "fcfs") {
      return {
        mode: "fcfs",
        html: '<button class="ups-m-fa-add" data-act="waiver-add" data-pid="' +
          U.escapeHtml(String(pid)) + '">' +
          (opts.longLabel ? "Add now — $1K, 1-yr WW" : "Add") + '</button>'
      };
    }
    return { mode: info.mode, html: "" };
  }

  // One-shot "you're done" line, set by a fully-verified submit just before it
  // drops the owner back here. The toast is gone in ~2.4s and the chip's
  // amber→blue flip is easy to miss if you weren't watching it; this bridges
  // the two. Time-boxed so it can't linger into a later visit and read as a
  // claim about the CURRENT state. { text, until }.
  var waiverFlash = null;

  // Context strip above the list: what window are we in, and a Claims entry
  // point. When there's no button to show, this line IS the answer.
  function renderWaiverStrip() {
    var info = waiverModeInfo();
    var flash = (waiverFlash && Date.now() < waiverFlash.until)
      ? '<div class="ups-m-waiver-flash' + (waiverFlash.tone === "warn" ? " warn" : "") + '">' +
          U.escapeHtml(waiverFlash.text) + '</div>'
      : "";
    if (flash === "") waiverFlash = null;
    if (info.mode === "unknown" && !stagedCount() && !clearCount()) return flash;
    var cls = "ups-m-waiver-strip " + info.mode + (info.writeEnabled ? "" : " readonly");
    var w = (M.state.waiverState && M.state.waiverState.window) || null;
    var detail = info.detail || "";
    if (info.mode === "bbid" && w && w.next_bbid_run_unix && M.waivers.countdown) {
      var cd = M.waivers.countdown(w.next_bbid_run_unix);
      if (cd) detail += " (" + cd + ")";
    }
    var n = stagedCount() + clearCount();
    // The viewer block's count is only a number when the server could READ
    // MFL. Unknown is NOT zero, so this takes the count only on an explicit
    // known:true. The worker emits the flag under BOTH `known` (canonical) and
    // `pending_known` (alias, identical value) — grep-verified in
    // /api/waivers/state — and pending_pick_count is null whenever it is false.
    var pendingN = 0;
    var viewer = M.state.waiverState && M.state.waiverState.viewer;
    var viewerKnown = !!viewer && (viewer.known === true || viewer.pending_known === true);
    if (viewerKnown && viewer.pending_pick_count != null) {
      pendingN = U.safeInt(viewer.pending_pick_count, 0);
    }
    var chipN = n || pendingN;
    // Keith 2026-07-30: this was a small outlined chip and he missed it — the
    // one control that actually sends claims to MFL has to read as THE action
    // on this screen, and be on screen the moment it loads (the strip sits
    // above the list, so no scrolling to find it). Says what it does rather
    // than just counting: "Finalize" while there are unsent edits, "Edit"
    // once everything is submitted.
    var dirty = planIsDirty() && n;
    var chip = (info.mode === "bbid" || chipN > 0)
      ? '<button class="ups-m-waiver-claims-cta' + (dirty ? " dirty" : "") +
          '" data-act="open-claims">' +
          (dirty ? "Finalize claims" : "Edit claims") +
          (chipN ? ' <span class="n">' + chipN + '</span>' : "") +
        '</button>'
      : "";
    // §5: when writes are dark in an otherwise-live window, the link out to
    // MFL replaces the CTA that would only have 503'd.
    var link = "";
    if (!info.writeEnabled && (info.mode === "bbid" || info.mode === "fcfs") && info.nativeLink) {
      link = ' <a class="ups-m-waiver-native" href="' + U.escapeHtml(info.nativeLink) +
        '" target="_blank" rel="noopener">Add/drop on MFL</a>';
    }
    return flash + '<div class="' + cls + '">' +
      '<span class="txt">' + U.escapeHtml(detail) + link + '</span>' + chip +
    '</div>';
  }

  function renderToolbar() {
    var chips = POSITIONS.map(function (p) {
      var label = p === "ALL" ? "All" : p;
      return '<button class="ups-m-pos-chip' + (view.pos === p ? " on" : "") +
        '" data-pos="' + U.escapeHtml(p) + '">' + U.escapeHtml(label) + '</button>';
    }).join("");
    // One filter for team/FA (Keith 2026-06-10): Free Agents · All Players ·
    // then each franchise. Replaces the old FA/All toggle + the redundant
    // Market hub tiles.
    var teamOpts = (M.state.franchises || []).slice().sort(function (a, b) {
      return U.safeStr(a.name).localeCompare(U.safeStr(b.name));
    }).map(function (f) {
      return '<option value="team:' + U.escapeHtml(f.id) + '"' + (view.teamFilter === f.id ? ' selected' : '') + '>' +
        U.escapeHtml(f.name || f.abbrev || f.id) + '</option>';
    }).join("");
    var scopeToggle = '<select class="ups-m-players-filter" id="ups-m-players-filter" aria-label="Filter players by team or free-agent status">' +
      '<option value="fa"' + (view.scope !== "all" && !view.teamFilter ? ' selected' : '') + '>Free Agents</option>' +
      '<option value="all"' + (view.scope === "all" && !view.teamFilter ? ' selected' : '') + '>All Players</option>' +
      '<optgroup label="By team">' + teamOpts + '</optgroup>' +
    '</select>';
    // THE points-period control (Keith 2026-10-02: "YTD" and "L2" looked like
    // a second sort, and "Sort: L2 pts" in the dropdown looked like a second
    // period control). It is the ONLY control that picks which weeks the
    // points, PPG, MFL wks and rank on every row cover — and it names them:
    // "Season · Wks 1–4 · live" (MFL's YTD), "Last 2 wks · Wks 2–3 · final".
    // It changes nothing else: the sort keeps its own choice, and the matchup line always uses
    // season-to-date defense ranks. Shown whenever current-season points are,
    // even with one option, because the week span is the point of it.
    // "live" / "final" is its own element: with three or four periods on a
    // phone it drops to its own line instead of being cut to "Wks 10–11 · fi…".
    var wins = availWindows();
    var winRow = pointsBasis().kind === "season"
      ? '<div class="ups-m-period' + (wins.length > 2 ? " crowd" : "") + '" role="radiogroup" aria-label="Points period">' +
          '<span class="lbl">Points</span>' + wins.map(function (o) {
            var on = winKey() === o[0], pp = periodParts(o[0]);
            return '<button class="ups-m-period-btn' + (on ? " on" : "") + '" data-win="' + o[0] +
              '" role="radio" aria-checked="' + (on ? "true" : "false") + '">' +
              '<span class="nm">' + U.escapeHtml(periodName(o[0])) + '</span>' +
              '<span class="wk">' + U.escapeHtml(pp.weeks) +
                (pp.status ? '<span class="st"><span class="sep"> · </span>' + U.escapeHtml(pp.status) + '</span>' : '') +
              '</span></button>';
          }).join("") + '</div>'
      : '';
    // The ONE sort control. Its options name WHAT is ranked, never the period
    // (that is the control above): PPG and Total pts rank the selected
    // period; the projection names its week; Hot/Cold say they are MFL-wide.
    var hcLoading = hotColdLoading();
    var sortOpts = [["ppg", "PPG"], ["pts", "Total pts"]];
    if (projReady()) sortOpts.push(["proj", projLabel().replace(/ proj$/, " projection")]);
    // Hot/Cold — MFL's own platform-wide topAdds/topDrops, free agents only.
    // FA scope only (see faScopeActive); STATUS=FA data structurally can't
    // rank most rows in "All Players" or a single team's roster.
    if (faScopeActive()) {
      sortOpts.push(["hot", "Most added, all MFL"]);
      sortOpts.push(["cold", "Most dropped, all MFL"]);
    }
    var sortSel = '<select class="ups-m-players-filter ups-m-players-sort" id="ups-m-players-sort" aria-label="Sort players">' +
      sortOpts.map(function (o) {
        return '<option value="' + o[0] + '"' + (eff.sort === o[0] ? ' selected' : '') + '>Sort: ' +
          U.escapeHtml(o[1]) + '</option>';
      }).join("") + '</select>';
    // Inline "couldn't read MFL" notice — only once the fetch has actually
    // settled (not mid-flight) and the tapped side came back known:false.
    // Reuses the existing warn-banner styling (.ups-m-waiver-flash.warn)
    // rather than inventing a new notice component.
    var hotColdNoticeText = (!hcLoading && (eff.sort === "hot" || eff.sort === "cold"))
      ? hotColdErrorFor(eff.sort)
      : "";
    var hotColdNotice = hotColdNoticeText
      ? '<div class="ups-m-waiver-flash warn">' + U.escapeHtml(hotColdNoticeText) + '</div>'
      : '';
    return '<div class="ups-m-players-toolbar">' +
      '<div class="ups-m-players-selects">' + scopeToggle + sortSel + '</div>' +
      '<input type="search" class="ups-m-players-search" id="ups-m-players-search" ' +
        'placeholder="' + (view.scope === "all" ? "Search all players…" : "Search free agents…") + '" autocomplete="off" autocorrect="off" ' +
        'value="' + U.escapeHtml(view.query) + '" />' +
      '<div class="ups-m-pos-chips">' + chips + '</div>' +
      winRow +
      basisHtml(hcLoading) +
    '</div>' + hotColdNotice + renderWaiverStrip();
  }

  // The week MFL's projections on this screen are for (the week being played,
  // or the next one) — from the same resolver the Lineup view uses.
  function projWeek() { return U.safeInt(M.state.lineupWeek || M.state.lineupProjWeek, 0); }
  function projLabel() { var w = projWeek(); return w ? ("Wk " + w + " proj") : "Proj"; }

  // One line under the controls that says exactly what the numbers ARE and
  // how fresh they are. Keith 2026-10-01: labels for actual points,
  // projections, PPG and freshness must not be confusable.
  function basisHtml(hcLoading) {
    var b = pointsBasis();
    var cur = U.safeStr(M.state.ctx && M.state.ctx.year);
    var txt, warn = false;
    if (b.kind === "season") {
      var ss = b.ss, span = SSMOD ? SSMOD.weeksLabel(ss.seasonWeeks) : "";
      txt = "Season = MFL's YTD, league scoring, " + span;
      if (ss.liveWeeks.length) {
        txt += " — Wk " + ss.liveWeeks.join(", ") + " in progress: games already played count, the rest aren't in yet";
      } else if (ss.finalKnown) {
        txt += " (final)";
      } else {
        txt += " · couldn't confirm which weeks are final, so last-weeks totals are hidden";
      }
      var lastN = availWindows().slice(1).map(function (o) { return o[0]; });
      if (lastN.length) txt += " · Last " + lastN.join("/") + " wks = final weeks only";
      var need = rankMinFor(ss, eff.window);
      txt += " · PPG rank needs " + need + "+ MFL wk" + (need === 1 ? "" : "s") +
        (eff.window ? " in the last " + eff.window : (ss.finalKnown
          ? " (half the " + ss.finalWeeks.length + " final week" + (ss.finalWeeks.length === 1 ? "" : "s") + ", rounded up)"
          : " (half of every posted week — finality unconfirmed)"));
      var asOf = clockLabel(ss.fetchedAt);
      if (asOf) txt += " · MFL as of " + asOf;
    } else if (b.kind === "prior") {
      txt = "No " + cur + " scores posted yet — points are " + b.year + " season totals";
    } else if (b.kind === "none") {
      txt = "No " + cur + " scores posted yet — no points to show";
    } else {
      txt = b.reason === "unreadable_scores"
        ? "MFL's " + cur + " scores came back unreadable — points are hidden rather than guessed. Tap refresh to retry."
        : "Couldn't load MFL's scoring — points are hidden rather than guessed. Tap refresh to retry.";
      warn = true;
    }
    if (projReady()) txt += " · " + projLabel() + " = MFL projection";
    if (eff.sortNote) txt += " · " + eff.sortNote;
    if (hcLoading && (eff.sort === "hot" || eff.sort === "cold")) txt += " · Loading MFL's " + (eff.sort === "hot" ? "most-added" : "most-dropped") + " list…";
    return '<div class="ups-m-fa-basis' + (warn ? " warn" : "") + '">' + U.escapeHtml(txt) + '</div>';
  }

  function fmt1(v) { return (Math.round((Number(v) || 0) * 10) / 10).toFixed(1); }
  // "9:38 AM" for the time MFL's scores were read; "" when unknown.
  function clockLabel(ms) {
    if (!(ms > 0)) return "";
    try { return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
    catch (e) { return ""; }
  }

  // Points / PPG / games / positional rank, scoped to the selected window. The
  // points number leads and is labelled with what it covers; PPG carries its
  // games so "16.9 PPG" can't be mistaken for a total or for a projection.
  function statChipsHtml(r) {
    var w = r.win || statsFor(r);
    if (w.unavailable) return '<span class="ups-m-fa-stat na">pts unavailable</span>';
    if (!w.have) return '<span class="ups-m-fa-stat na">no pts · ' + U.escapeHtml(w.label) + '</span>';
    var wks = w.games + ' MFL wk' + (w.games === 1 ? '' : 's');
    var ppgTitle = "Points per MFL scored week; MFL wks = weeks MFL posted a score (0.0 counts), not NFL games";
    var chips = '<span class="ups-m-fa-stat pts"><b>' + fmt1(w.pts) + '</b> pts · ' + U.escapeHtml(w.label) + '</span>';
    if (!(w.games > 0)) return chips + '<span class="ups-m-fa-stat">0 MFL wks</span>';
    // Below the rank minimum: the real PPG stays, the "#N" becomes
    // "unranked · 1 MFL wk" (the count moves there so it isn't said twice).
    if (w.ranked === false) {
      return chips + '<span class="ups-m-fa-stat" title="' + ppgTitle + '">' + fmt1(w.ppg) + ' PPG</span>' +
        '<span class="ups-m-fa-stat unranked" title="A PPG rank needs ' + w.minGames + '+ MFL wks' +
          (winKey() ? ' in the last ' + winKey() + ' weeks' : ' (half the final weeks, rounded up)') + '">unranked · ' + wks + '</span>';
    }
    return chips + '<span class="ups-m-fa-stat" title="' + ppgTitle + '">' + fmt1(w.ppg) + ' PPG · ' + wks + '</span>' +
      (w.rank > 0 ? '<span class="ups-m-fa-stat">#' + w.rank + ' ' + U.escapeHtml(w.group) + '</span>' : '');
  }

  // The decision line: projected points for the upcoming week · who they play ·
  // that opponent's rank against this player's position (rank 1 = MOST
  // generous = easiest matchup). The player → NFL team → this week's game →
  // defRatings[opp][group] join is M.lineupIntel.matchupFor (views/lineup.js),
  // not re-derived here. Whatever we don't have is left out — a bye, an
  // unscheduled week, the preseason, or a cold/failed cache produces no line
  // at all rather than "— proj" or "#0".
  function faIntelHtml(r) {
    var I = intel();
    if (!I) return "";
    var bits = [];
    var p = I.projFor(r.id);
    if (p != null) bits.push(U.escapeHtml(projLabel()) + " " + U.escapeHtml(I.fmtProj(p)));
    // Always the SEASON window (key 0): the points-period control changes
    // player points only. It used to re-rank the opponent's defense too —
    // tapping "L2" moved GBP from #22 to #7 vs PK with no label saying why.
    var mu = I.matchupFor(r.id, 0);
    if (mu && mu.opp) {
      bits.push(U.escapeHtml((mu.isHome ? "vs " : "@ ") + mu.opp));
      if (mu.rank != null) {
        var basis = I.priorSeason() ? "last season" : "season to date";
        bits.push('<span class="ups-m-mu-rank ' + I.rankCls(mu.rank) +
          '" title="Opponent-adjusted defense vs ' + U.escapeHtml(mu.grp) +
          ', rank 1 = most generous (' + U.escapeHtml(basis) + ')">' +
          U.escapeHtml(mu.opp) + ' #' + mu.rank + ' to ' + U.escapeHtml(mu.grp) + '</span>');
      }
    }
    return bits.length ? '<div class="ups-m-fa-mu">' + bits.join(" · ") + '</div>' : "";
  }

  function renderRows(rows) {
    if (!rows.length) {
      return '<div class="ups-m-stub"><div>No matching ' + (view.scope === "all" ? "players" : "free agents") + '.</div></div>';
    }
    var capped = rows.slice(0, 200); // limit DOM cost on mobile
    var myFid = U.pad4(M.state.viewerFranchiseId);
    var html = '<div class="ups-m-fa-list">';
    capped.forEach(function (r, idx) {
      var posClass = r.group.toLowerCase();
      // Rostered player (All-players scope): show the owner; offer Propose
      // trade for players on OTHER teams (Keith 2026-06-08).
      // Unrostered player: the acquisition CTA for the CURRENT waiver window
      // (Bid / Add / nothing) — see acquisitionCta.
      var ownerTag = "", actionBtn = "";
      if (r.rosteredFid) {
        if (r.rosteredFid === myFid) {
          ownerTag = '<span class="owned you">Your team</span>';
        } else {
          ownerTag = '<span class="owned">' + U.escapeHtml(franchiseName(r.rosteredFid)) + '</span>';
          actionBtn = '<button class="ups-m-fa-trade" data-act="propose-trade" data-fid="' + U.escapeHtml(r.rosteredFid) + '" data-pid="' + U.escapeHtml(r.id) + '">Propose trade</button>';
        }
      } else {
        actionBtn = acquisitionCta(r.id).html;
      }
      html += '<div class="ups-m-fa-row' + (actionBtn ? ' has-act' : '') + '" data-pid="' + U.escapeHtml(r.id) + '">' +
        '<div class="rank">' + (idx + 1) + '</div>' +
        '<div class="pos ' + posClass + '">' + U.escapeHtml(r.pos) + '</div>' +
        // Three lines, always in this order so a column of rows scans:
        //   name · NFL team
        //   [owner]  actual points · PPG · games · rank  [trend]
        //   Wk N proj · opponent · opponent rank
        '<div class="body">' +
          '<div class="name">' + U.escapeHtml(r.name) +
            (r.team ? '<span class="tm">' + U.escapeHtml(r.team) + '</span>' : '') + '</div>' +
          '<div class="sub">' +
            ownerTag +
            statChipsHtml(r) +
            hotColdBadgeHtml(r) +
          '</div>' +
          faIntelHtml(r) +
        '</div>' +
        actionBtn +
      '</div>';
    });
    if (rows.length > capped.length) {
      html += '<div class="ups-m-fa-more">Showing top ' + capped.length + ' of ' + rows.length + ' — refine your search to see more.</div>';
    }
    html += '</div>';
    return html;
  }

  // ══ Drop picker ════════════════════════════════════════════════════════
  // Full-roster list, cheapest cap penalty first. Penalties come from
  // DATA.dropPenaltyFor, which prefers the worker's authoritative
  // /api/cap-penalty/preview batch (state.capPenaltyByPid) and only falls
  // back to local math when that hasn't landed.
  function dropCandidateRows() {
    var fid = M.state.viewerFranchiseId;
    if (!fid) return [];
    return DATA.getRosterFor(fid).map(function (r) {
      var p = DATA.playerById(r.id);
      var penalty = DATA.dropPenaltyFor(r, M.state.ctx.year);
      var pAmt = (penalty && typeof penalty.amount === "number") ? penalty.amount : 0;
      return {
        id: r.id,
        name: nameFor(p) || ("Player " + r.id),
        pos: U.safeStr(p && p.position).toUpperCase(),
        team: U.safeStr(p && p.team),
        salary: r.salary,
        contractYear: r.contractYear,
        penaltyAmt: pAmt,
        // authoritative === straight from the worker; false means we're
        // showing the offline estimate and should say so.
        authoritative: !!(penalty && penalty.authoritative),
        penaltyNote: (penalty && penalty.note) || ""
      };
    }).sort(function (a, b) { return a.penaltyAmt - b.penaltyAmt; });
  }

  // ══ "No drop" gating ═══════════════════════════════════════════════════
  // RULE (Keith 2026-08-08) — do NOT offer "No drop" when we positively KNOW
  // the active roster is already full. A claim/add with no drop can only be
  // refused at that point, and an option whose single outcome is a rejection
  // is not an option. This REVERSES the 2026-07-30 rule that "No drop" is
  // always selectable; do not restore that one from the old rationale below.
  //
  // The rule it replaces was not careless, and its reasoning still shapes this
  // one. Contract v2 §6 keeps roster headroom ADVISORY because a WRONG
  // headroom number would block a move MFL would have allowed — v1 shipped
  // exactly that bug (`allowNone: !(rosterCount >= 35)`: rosterCount counts IR
  // and taxi bodies that hold no active spot, and 35 is a hardcoded constant
  // that is only the PRE-deadline ceiling). So the gate below fires only on
  // numbers we can stand behind, on a matched basis:
  //   max    — DATA.rosterCapMax(), the ONE mobile ceiling (app.js). 0/absent
  //            is treated as UNKNOWN even though today it always answers.
  //   active — cap.activeCount (roster − IR − taxi; neither occupies an active
  //            spot). rosterCount 0 means the cap mirror hasn't loaded, which
  //            is UNKNOWN, not "empty roster".
  // Either number unreadable → known:false → callers keep offering "No drop"
  // exactly as they did before. That is deliberately the OPPOSITE of the usual
  // fail-closed guard in this repo: here the destructive direction is BLOCKING
  // a legal claim on arithmetic we can't stand behind, so uncertainty falls to
  // the permissive side. MFL still owns the real limit at award time.
  //
  // ── Where `max` comes from, and why NOT MFL's rosterSize ────────────────
  // The ceiling is the UPS rule: MIN 27, MAX 35 through the September contract
  // deadline, MAX 30 after it. Canon docs/league_context_v1.md §B1 ~302
  // ("Size: 27 (min, at close of auction) – 30 (max, after contract deadline)";
  // "Auction window: 27 (close min) – 35 (max)"), implemented once per client:
  // desktop team_operations.js rosterCaps() ~1020, mobile DATA.rosterCapMax().
  // Both prefer the league calendar's own contract-deadline date and fall back
  // to the fixed Sep 6 boundary. This file adds no third copy — read the helper.
  //
  // An earlier pass sourced `max` from MFL's `rosterSize` (league export →
  // worker _wvRosterLimit → limits.roster_size) and argued our own 30/35 math
  // was "the kind of number the old rationale warned about". That was exactly
  // backwards, and the repo already knew it. team_operations.js ~1020, verbatim:
  //
  //     "MFL's league export carries no usable roster cap for us —
  //      rosterSize:'50' is offseason trading headroom, NOT the real rule — so
  //      state.rosterLimit came back 0 and every consumer fell back to a
  //      hardcoded 26, flagging legal rosters as 'over the limit'."
  //
  // rosterSize is a league SETTING, not the UPS ceiling. It has read 50. It
  // reads 35 today by coincidence, and — this is the part that breaks a gate —
  // it does NOT drop to 30 when the contract deadline passes. Gated on it, this
  // whole feature silently goes inert every September: an owner at 32/30 keeps
  // being offered "No drop" for a claim with no spot to land in, and the
  // caption prints a confidently wrong "(32/35)".
  //
  // The superseded argument also cited data/mfl-snapshots/2026-08-08/league.json
  // (rosterSize 35 / injuredReserve 15 / taxiSquad 10) as proof rosterSize is
  // the active ceiling. One day's sample cannot establish a rule — it is equally
  // consistent with a setting that simply hasn't been changed yet — and canon
  // already answers the question. Do not restore it.
  //
  // Basis check, since a ceiling and a count must measure the same thing:
  // rosterCapMax() is an ACTIVE ceiling (canon §B1 is the Active Roster
  // section; taxi §B2 and IR are separate states with their own sizes), and
  // activeCount is roster − IR − taxi. Matched. team_operations.js ~3198 has
  // the scar from mismatching them: 28 active + 3 IR + 7 taxi rendered as
  // "38 rostered · max 30", eight over a limit the owner was two under.
  function rosterHeadroom() {
    var fid = M.state.viewerFranchiseId;
    var cap = fid ? DATA.computeCap(fid) : null;
    // Guarded rather than called bare: an app.js without the helper must land
    // on UNKNOWN (permissive), never on a thrown TypeError that takes the whole
    // drop picker down.
    var max = (DATA && DATA.rosterCapMax) ? U.safeInt(DATA.rosterCapMax(), 0) : 0;
    var active = (cap && U.safeInt(cap.rosterCount, 0) > 0 && cap.activeCount != null)
      ? U.safeInt(cap.activeCount, -1)
      : -1;
    if (max <= 0 || active < 0) return { known: false, full: false, active: null, max: 0 };
    return { known: true, full: active >= max, active: active, max: max };
  }

  function renderDropSheet(opts) {
    var fid = M.state.viewerFranchiseId;
    if (!fid) return "";
    var cap = DATA.computeCap(fid);
    var rosterRows = dropCandidateRows();
    var anyEstimate = rosterRows.some(function (r) { return !r.authoritative; });

    var rows = rosterRows.map(function (r) {
      // What cap room would look like AFTER the drop. The add side is not
      // included — a blind bid's price isn't settled until the run, and an
      // FCFS add is the league-default $1K WW.
      var roomAfter = cap.capRoom + Math.max(0, r.salary) - r.penaltyAmt;
      var pLabel = r.penaltyAmt > 0
        ? '<span class="penalty">' + U.fmtUsd(r.penaltyAmt) + ' penalty</span>'
        : '<span class="penalty ok">no penalty</span>';
      var selected = opts.selectedPid && String(opts.selectedPid) === String(r.id);
      return '<button class="ups-m-drop-row' + (selected ? " on" : "") + '" data-drop-pid="' + U.escapeHtml(r.id) + '">' +
        '<div class="body">' +
          '<div class="name">' + U.escapeHtml(r.name) + '</div>' +
          '<div class="sub">' +
            U.escapeHtml(r.pos) + (r.team ? ' · ' + U.escapeHtml(r.team) : '') +
            ' · ' + U.fmtUsd(r.salary) + (r.contractYear ? ' (' + U.escapeHtml(r.contractYear) + 'yr)' : '') +
          '</div>' +
        '</div>' +
        '<div class="right">' +
          pLabel +
          '<div class="after">Cap room after: ' + U.fmtUsd(roomAfter) + '</div>' +
        '</div>' +
      '</button>';
    }).join("");

    // When "No drop" is withheld the owner has to be TOLD why — a control that
    // was there yesterday and is gone today, with nothing in its place, reads
    // as a broken screen and gets reported as a bug. The note is a plain <div>,
    // not a .ups-m-drop-row, so the row-click wiring below can't hand back an
    // empty drop_pid through it.
    var noneRow = opts.allowNone
      ? '<button class="ups-m-drop-row none' + (!opts.selectedPid ? " on" : "") + '" data-drop-pid="">' +
          '<div class="body"><div class="name">No drop</div>' +
          '<div class="sub">' + U.escapeHtml(opts.noneSub || "Only add if there is room.") + '</div></div>' +
        '</button>'
      : (opts.noneBlockedNote
          ? '<div class="ups-m-drop-note">' + U.escapeHtml(opts.noneBlockedNote) + '</div>'
          : "");

    return '<div class="ups-m-drop-overlay" id="ups-m-drop-overlay">' +
      '<div class="ups-m-drop-sheet">' +
        '<div class="ups-m-drop-head">' +
          '<button class="ups-m-drop-close" id="ups-m-drop-close" aria-label="Close">×</button>' +
          '<div class="grip"></div>' +
          '<div class="title">' + U.escapeHtml(opts.title || "Drop which player?") + '</div>' +
          '<div class="sub">' + (opts.sub || "") + '</div>' +
        '</div>' +
        '<div class="ups-m-drop-body">' + noneRow + rows + '</div>' +
        (anyEstimate
          ? '<div class="ups-m-drop-foot">Penalties are estimates until the cap service responds — MFL charges the official amount.</div>'
          : '') +
      '</div>' +
    '</div>';
  }

  function closeDropSheet() {
    view.dropSheetFor = null;
    dropPicker = null;
    var ov = document.getElementById("ups-m-drop-overlay");
    if (ov) ov.remove();
    // The bid sheet / claims screen may still be open underneath — only
    // release the page scroll when nothing modal is left.
    if (!document.getElementById("ups-m-bid-overlay") &&
        !document.getElementById("ups-m-claims-overlay")) {
      document.body.style.overflow = "";
    }
  }

  // opts: { title, sub, allowNone, noneSub, noneBlockedNote, selectedPid,
  //         onPick(pidOrEmpty) }
  // allowNone:false + noneBlockedNote renders the note in place of the "No
  // drop" row (see rosterHeadroom()); allowNone:false with no note omits both.
  // NOTE: `sub` is injected as HTML so callers can bold a player name; every
  // caller in this file escapes the dynamic part with U.escapeHtml first.
  // `title` / `noneSub` are escaped for you.
  function openDropPicker(opts) {
    opts = opts || {};
    closeDropSheet();
    if (!M.state.viewerFranchiseId) return;
    dropPicker = opts;
    view.dropSheetFor = opts.addPid || null;
    var mount = document.getElementById("ups-m-app");
    if (!mount) return;
    mount.insertAdjacentHTML("beforeend", renderDropSheet(opts));
    document.body.style.overflow = "hidden";
    var overlay = document.getElementById("ups-m-drop-overlay");
    if (!overlay) return;
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) closeDropSheet();
    });
    var closeBtn = document.getElementById("ups-m-drop-close");
    if (closeBtn) closeBtn.addEventListener("click", closeDropSheet);
    var rows = overlay.querySelectorAll(".ups-m-drop-row");
    for (var i = 0; i < rows.length; i++) {
      rows[i].addEventListener("click", function () {
        var dropPid = this.getAttribute("data-drop-pid") || "";
        var cb = dropPicker && dropPicker.onPick;
        closeDropSheet();
        if (cb) cb(dropPid);
      });
    }
  }

  // ══ Bid sheet (BBID) ═══════════════════════════════════════════════════
  // Stages one pick into the LOCAL plan. Nothing is written to MFL here —
  // the Claims screen submits the staged rounds in one POST. Rounds the owner
  // never touched are not in that payload and are left alone at MFL (§2).
  function openBidSheet(addPid, editRef) {
    // §5 — the Bid button doesn't render while writes are dark, but the player
    // sheet also calls in here, so the gate lives at the entry point too.
    if (!writeEnabled()) { openNativeWaiverPage(); return; }
    var lim = waiverLimits();
    if (!lim) {
      M.ui.showToast("Bid limits unavailable — try again in a moment.", "err");
      return;
    }
    var existing = null;
    if (editRef) {
      var g = stagedPlan().filter(function (x) { return x.round === editRef.round; })[0];
      existing = g && g.picks[editRef.index];
    }
    bidView = {
      addPid: String(addPid),
      amount: legalBid(existing ? U.safeInt(existing.bid_dollars, lim.min) : lim.min, lim),
      round: editRef ? editRef.round : 1,
      dropPid: existing && existing.drop_pid ? String(existing.drop_pid) : "",
      editRef: editRef || null,
      snapNote: ""
    };
    renderBidSheet();
  }

  // The worker's OWN rule (POST /api/waivers/bbid-plan): a bid must be at least
  // bbid_minimum AND an exact multiple of bbid_increment. This used to snap to
  // min + k·step, which is the same thing only while the minimum happens to be
  // a multiple of the step ($1K/$1K today) — a $1,500 minimum with $1K steps
  // would have staged $2,500 and been refused as BID_NOT_MULTIPLE at submit.
  // Rounds to the nearest legal step, never below the smallest legal bid.
  function legalBid(amount, lim) {
    var step = U.safeInt(lim && lim.step, 0), min = U.safeInt(lim && lim.min, 0);
    if (step <= 0) return Math.max(min, Math.round(Number(amount) || 0));
    var floor = Math.ceil(min / step) * step;
    var snapped = Math.round((Number(amount) || 0) / step) * step;
    return Math.max(floor, snapped);
  }
  // The amount box takes thousands ("12" = $12K, "12.5" = $12,500) — the way
  // every UPS price is already written — so a $25K bid is two keystrokes, not
  // 24 taps of +. Anyone who types whole dollars anyway ("12000", "$12,000")
  // gets dollars: 1,000+ "thousand" would be a $1M+ bid against a $300K cap,
  // so that reading can only be a mistake. null = nothing usable typed.
  function parseBidK(raw) {
    var s = String(raw == null ? "" : raw).trim();
    // Refuse malformed text rather than stripping it into a different bid:
    // "-12" must not become +$12K and a cleared box must not stage the old
    // amount. A pasted whole-dollar amount may use a $ and commas.
    if (!/^\$?(?:\d+(?:\.\d+)?|\d{1,3}(?:,\d{3})+(?:\.\d+)?)$/.test(s)) return null;
    var n = Number(s.replace(/[$,]/g, ""));
    if (!isFinite(n)) return null;
    return Math.round(n >= 1000 ? n : n * 1000);
  }
  function fmtK(dollars) {
    var k = (Number(dollars) || 0) / 1000;
    return String(Math.round(k * 1000) / 1000);
  }
  // One line of real context where the bid is decided: the player's ACTUAL
  // points (same source and labels as the Market row) and next week's
  // projection, so nobody prices a claim off a number they can't see.
  function bidContextHtml(pid) {
    var b = pointsBasis();
    var bits = [];
    if (b.kind === "season") {
      var st = b.ss.byPid[String(pid)];
      var span = periodSpan(0);
      // Always the SEASON (MFL's YTD), whatever period the list is showing:
      // this is the line the bid amount is decided against, so it never
      // changes under it.
      bits.push("Season" + (span ? " · " + U.escapeHtml(span) : "") + ": <b>" +
        fmt1(st ? st.pts : 0) + "</b> pts" +
        (st && st.games > 0 ? " · " + fmt1(st.ppg) + " PPG · " + st.games + " MFL wk" + (st.games === 1 ? "" : "s") : " · 0 MFL wks"));
    } else if (b.kind === "prior") {
      var pr = b.map[String(pid)];
      if (pr) bits.push("<b>" + fmt1(pr.mfl_points) + "</b> " + b.year + " pts · " + fmt1(pr.mfl_ppg) + " PPG");
    } else if (b.kind === "unavailable") {
      bits.push("Points unavailable — MFL's scoring didn't load");
    }
    var I = intel();
    var pj = I ? I.projFor(pid) : null;
    if (pj != null) bits.push(U.escapeHtml(projLabel()) + " " + U.escapeHtml(I.fmtProj(pj)));
    return bits.length ? '<div class="ups-m-bid-context">' + bits.join(" · ") + '</div>' : "";
  }

  function closeBidSheet() {
    bidView = null;
    var ov = document.getElementById("ups-m-bid-overlay");
    if (ov) ov.remove();
    if (!document.getElementById("ups-m-claims-overlay")) document.body.style.overflow = "";
  }

  function bidAdvisoryHtml() {
    var fid = M.state.viewerFranchiseId;
    var cap = fid ? DATA.computeCap(fid) : null;
    // Cap room is ADVISORY ONLY. MFL enforces the real $300K cap at award
    // time; we never block a bid on our own arithmetic.
    var advisory = "";
    if (cap && cap.capAmount) {
      var roomAfterDrop = cap.capRoom + (bidView.dropPid ? Math.max(0, dropSalary(bidView.dropPid)) - dropPenalty(bidView.dropPid) : 0);
      var over = bidView.amount > roomAfterDrop;
      advisory = '<div class="ups-m-bid-advisory' + (over ? " warn" : "") + '">' +
        'Cap room ' + (bidView.dropPid ? "after that drop" : "today") + ': <strong>' + U.fmtUsd(roomAfterDrop) + '</strong>' +
        (over ? ' — this bid is above it. MFL enforces the cap when the claim is awarded.' : '') +
      '</div>';
    }
    // Roster headroom on THIS line stays advisory (§6) and quotes no ceiling —
    // it is a passive "here is where you stand" note next to a bid field, and
    // the count alone is what it is for. The ceiling is quoted where it changes
    // what an owner can pick: the drop picker, from rosterHeadroom(). (The
    // reason recorded here previously — that our own 30/35 deadline math "would
    // be wrong some of the time" — was not the real one; that math IS the UPS
    // rule. See rosterHeadroom().)
    if (cap && cap.rosterCount > 0 && cap.activeCount != null) {
      advisory += '<div class="ups-m-bid-advisory">Active roster: ' + cap.activeCount +
        ((cap.irCount || cap.taxiCount)
          ? ' (' + (cap.irCount || 0) + ' IR · ' + (cap.taxiCount || 0) + ' taxi, not counted)'
          : '') +
        '. MFL enforces the roster limit when a claim is awarded.</div>';
    }
    return advisory;
  }

  function bidSheetHtml() {
    var lim = waiverLimits();
    if (!lim || !bidView) return "";
    var info = waiverModeInfo();
    // Wrapped so typing in the amount box can refresh the cap line in place
    // (see bindBidAmount) without rebuilding the sheet under the keyboard.
    var advisory = '<div id="ups-m-bid-advisory-wrap">' + bidAdvisoryHtml() + '</div>';

    var groupChips = "";
    var plan = stagedPlan();
    for (var rd = 1; rd <= lim.maxRounds; rd++) {
      var cnt = (plan.filter(function (g) { return g.round === rd; })[0] || { picks: [] }).picks.length;
      groupChips += '<button class="ups-m-bid-round' + (bidView.round === rd ? " on" : "") +
        '" data-round="' + rd + '">' + rd + (cnt ? '<span class="n">' + cnt + '</span>' : '') + '</button>';
    }

    var needDrop = dropRequired();
    var dropLabel = bidView.dropPid
      ? (nameForPid(bidView.dropPid) + " · " + U.fmtUsd(dropPenalty(bidView.dropPid)) + " penalty")
      : (needDrop ? "Choose who this replaces — roster full (" + needDrop.active + "/" + needDrop.max + ")"
                  : "No conditional drop");

    return '<div class="ups-m-bid-overlay" id="ups-m-bid-overlay">' +
      '<div class="ups-m-bid-sheet">' +
        '<div class="ups-m-bid-head">' +
          '<button class="ups-m-bid-close" id="ups-m-bid-close" aria-label="Close">×</button>' +
          // Edit and create share this sheet; it has to say which one it is,
          // or a pre-filled bid reads as a brand-new claim at a mystery price.
          '<div class="title">' +
            (bidView.editRef ? "Edit claim" : "Bid on " + U.escapeHtml(nameForPid(bidView.addPid))) +
          '</div>' +
          '<div class="sub">' +
            (bidView.editRef ? U.escapeHtml(nameForPid(bidView.addPid)) + ' · ' : '') +
            U.escapeHtml(posTeamForPid(bidView.addPid)) +
            (bidView.editRef ? ' · currently group ' + U.safeInt(bidView.editRef.round, 0) : '') +
            (info.detail ? ' · ' + U.escapeHtml(info.detail) : '') + '</div>' +
          bidContextHtml(bidView.addPid) +
        '</div>' +
        '<div class="ups-m-bid-body">' +
          '<div class="ups-m-bid-label"><label for="ups-m-bid-amt">Bid amount ($K)</label></div>' +
          '<div class="ups-m-bid-stepper">' +
            '<button class="step" data-act="bid-minus" aria-label="Lower bid by ' + U.escapeHtml(U.fmtUsd(lim.step)) + '">−</button>' +
            '<div class="amt-wrap"><span class="cur">$</span>' +
              '<input class="amt" id="ups-m-bid-amt" type="text" inputmode="decimal" autocomplete="off" aria-describedby="ups-m-bid-total" ' +
                'enterkeyhint="done" value="' + U.escapeHtml(fmtK(bidView.amount)) + '" />' +
              '<span class="cur">K</span></div>' +
            '<button class="step" data-act="bid-plus" aria-label="Raise bid by ' + U.escapeHtml(U.fmtUsd(lim.step)) + '">+</button>' +
          '</div>' +
          '<div class="ups-m-bid-total" id="ups-m-bid-total" aria-live="polite">' + U.fmtUsd(bidView.amount) +
            (bidView.snapNote ? ' <span class="snap">' + U.escapeHtml(bidView.snapNote) + '</span>' : '') + '</div>' +
          '<div class="ups-m-bid-hint">Minimum ' + U.fmtUsd(legalBid(lim.min, lim)) + ', in ' + U.fmtUsd(lim.step) + ' steps — ' +
            'other amounts round to the nearest step. ' +
            'A winning bid becomes this season’s salary on a 1-year WW contract.</div>' +
          advisory +
          '<div class="ups-m-bid-label">Priority group</div>' +
          '<div class="ups-m-bid-rounds">' + groupChips + '</div>' +
          '<div class="ups-m-bid-hint">Group 1 is processed first. Within a group, your claims run in the order you set on the Claims screen.</div>' +
          // Shown unless MFL explicitly reported conditional bidding OFF.
          // `conditional` is now a tri-state — true / false / null ("MFL did not
          // say") — and null must not collapse to "off": the drop rider is part
          // of MFL's blindBidWaiverRequest on every claim (the worker accepts
          // drop_pid unconditionally and MFL enforces at award time), so hiding
          // it on an unread setting would remove a capability the league uses.
          (lim.conditional || !lim.conditionalKnown
            ? '<div class="ups-m-bid-label">Conditional drop</div>' +
              '<button class="ups-m-bid-droppick' + (needDrop && !bidView.dropPid ? " need" : "") + '" data-act="pick-drop">' + U.escapeHtml(dropLabel) + '</button>' +
              '<div class="ups-m-bid-hint">Only dropped if this claim is awarded.</div>'
            : '') +
        '</div>' +
        '<div class="ups-m-bid-foot">' +
          '<button class="ups-m-bid-btn ghost" data-act="bid-cancel">Cancel</button>' +
          '<button class="ups-m-bid-btn primary" data-act="bid-confirm">' +
            (bidView.editRef ? "Save changes" : "Add to claims") + '</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function dropSalary(pid) {
    var fid = M.state.viewerFranchiseId;
    if (!fid || !pid) return 0;
    var row = DATA.getRosterFor(fid).filter(function (r) { return String(r.id) === String(pid); })[0];
    return row ? (Number(row.salary) || 0) : 0;
  }
  function dropPenalty(pid) {
    var fid = M.state.viewerFranchiseId;
    if (!fid || !pid) return 0;
    var row = DATA.getRosterFor(fid).filter(function (r) { return String(r.id) === String(pid); })[0];
    if (!row) return 0;
    var p = DATA.dropPenaltyFor(row, M.state.ctx.year);
    return (p && typeof p.amount === "number") ? p.amount : 0;
  }

  function renderBidSheet() {
    var existing = document.getElementById("ups-m-bid-overlay");
    if (existing) existing.remove();
    var mount = document.getElementById("ups-m-app");
    if (!mount || !bidView) return;
    mount.insertAdjacentHTML("beforeend", bidSheetHtml());
    document.body.style.overflow = "hidden";
    var overlay = document.getElementById("ups-m-bid-overlay");
    if (!overlay) return;
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) closeBidSheet();
    });
    var closeBtn = document.getElementById("ups-m-bid-close");
    if (closeBtn) closeBtn.addEventListener("click", closeBidSheet);
    overlay.addEventListener("click", onBidSheetClick);
    bindBidAmount();
  }

  // Typed amounts. While typing: snap a COPY to the legal step and refresh the
  // dollar line + cap advisory in place — never rebuild the sheet (that would
  // drop the keyboard) and never rewrite the box mid-keystroke. On commit
  // (blur / Done): write the legal value back into the box. So what the owner
  // sees on the dollar line is always exactly what "Add to claims" stages.
  function bindBidAmount() {
    var input = document.getElementById("ups-m-bid-amt");
    if (!input) return;
    function apply(commit) {
      var lim = waiverLimits();
      if (!lim || !bidView) return;
      var typed = parseBidK(input.value);
      var tot = document.getElementById("ups-m-bid-total");
      if (typed == null) {
        input.setAttribute("aria-invalid", "true");
        if (tot) tot.textContent = "Enter a valid bid amount";
        var staleAdvisory = document.getElementById("ups-m-bid-advisory-wrap");
        if (staleAdvisory) staleAdvisory.innerHTML = "";
        return;
      }
      input.removeAttribute("aria-invalid");
      var legal = legalBid(typed, lim);
      bidView.amount = legal;
      bidView.snapNote = (typed != null && typed !== legal)
        ? (typed < legal && legal === legalBid(lim.min, lim) ? "raised to the minimum" : "rounded to a " + U.fmtUsd(lim.step) + " step")
        : "";
      if (tot) {
        tot.innerHTML = U.fmtUsd(legal) +
          (bidView.snapNote ? ' <span class="snap">' + U.escapeHtml(bidView.snapNote) + '</span>' : '');
      }
      var adv = document.getElementById("ups-m-bid-advisory-wrap");
      if (adv) adv.innerHTML = bidAdvisoryHtml();
      if (commit) input.value = fmtK(legal);
    }
    input.addEventListener("input", function () { apply(false); });
    input.addEventListener("change", function () { apply(true); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { apply(true); input.blur(); }
    });
    input.addEventListener("focus", function () { try { input.select(); } catch (e) {} });
  }

  function onBidSheetClick(e) {
    var t = e.target && e.target.closest ? e.target.closest("[data-act],[data-round]") : null;
    if (!t || !bidView) return;
    var lim = waiverLimits();
    if (!lim) return;
    var rd = t.getAttribute("data-round");
    if (rd) {
      bidView.round = U.safeInt(rd, 1);
      renderBidSheet();
      return;
    }
    var act = t.getAttribute("data-act");
    if (act === "bid-minus") {
      bidView.amount = legalBid(bidView.amount - lim.step, lim);
      bidView.snapNote = "";
      renderBidSheet();
    } else if (act === "bid-plus") {
      bidView.amount = legalBid(bidView.amount + lim.step, lim);
      bidView.snapNote = "";
      renderBidSheet();
    } else if (act === "pick-drop") {
      var keep = { addPid: bidView.addPid, amount: bidView.amount, round: bidView.round,
                   dropPid: bidView.dropPid, editRef: bidView.editRef, snapNote: "" };
      // "No drop" only when a claim carrying none could actually be awarded
      // (Keith 2026-08-08 — see rosterHeadroom()). Unknown headroom keeps it.
      // This changes what can be STAGED from here; it never edits what is
      // already staged — a pick saved earlier with no conditional drop keeps
      // its empty drop_pid and submits unchanged.
      var hr = rosterHeadroom();
      openDropPicker({
        title: "Conditional drop",
        sub: 'Dropped only if the claim on <strong>' + U.escapeHtml(nameForPid(bidView.addPid)) + '</strong> wins.',
        allowNone: !hr.full,
        // Exactly one of these two ever renders: noneSub labels the "No drop"
        // row, noneBlockedNote replaces it. Neither is built on the branch
        // where it can't be read — the alternative is a string that contradicts
        // the one on screen sitting live in the same options object.
        noneSub: hr.full ? "" : "Claim is only awarded if you already have room.",
        // Rule, not prophecy — same reasoning as the FCFS note below.
        noneBlockedNote: hr.full
          ? "Your active roster is full (" + hr.active + "/" + hr.max + " — the league limit " +
            "right now), so a winning claim would have no open spot to land in. " +
            "Pick the player this claim replaces."
          : "",
        selectedPid: bidView.dropPid,
        addPid: bidView.addPid,
        onPick: function (pid) {
          bidView = keep;
          bidView.dropPid = pid || "";
          renderBidSheet();
        }
      });
    } else if (act === "bid-cancel") {
      closeBidSheet();
    } else if (act === "bid-confirm") {
      confirmBid();
    }
  }

  // Keith 2026-08-08: "No drop" is never offered when the active roster is
  // KNOWN full — a claim with no drop could only be refused. The drop picker
  // already withheld it, but the sheet itself starts at "no drop" and could be
  // confirmed without the picker ever opening. Same carve-out, same numbers
  // (rosterHeadroom); unknown headroom still allows no drop. Only applies when
  // MFL takes a conditional drop at all.
  function dropRequired() {
    var lim = waiverLimits();
    if (!lim || !(lim.conditional || !lim.conditionalKnown)) return null;
    var hr = rosterHeadroom();
    return (hr.known && hr.full) ? hr : null;
  }

  // Where the claim being EDITED sits in `plan` right now. editRef is a slot
  // captured when the sheet opened, and a background reconcile (a run
  // processing, a resolved claim swept when the app comes back to the
  // foreground) can shift the group under an open sheet. Trusting the stale
  // slot spliced out whichever claim had slid into it — on a group move that
  // deleted a different player's claim and left this one in both groups.
  // -1 = the claim is no longer there.
  function resolveEditIndex(plan, ref, addPid) {
    if (!ref) return -1;
    var g = plan.filter(function (x) { return x.round === ref.round; })[0];
    if (!g || !g.picks) return -1;
    var at = g.picks[ref.index];
    if (at && String(at.add_pid) === String(addPid)) return ref.index;
    for (var i = 0; i < g.picks.length; i++) {
      if (String(g.picks[i].add_pid) === String(addPid)) return i;
    }
    return -1;
  }

  function confirmBid() {
    var lim = waiverLimits();
    if (!lim || !bidView) return;
    var needDrop = dropRequired();
    if (needDrop && !bidView.dropPid) {
      M.ui.showToast("Your active roster is full (" + needDrop.active + "/" + needDrop.max +
        ") — choose the player this claim replaces.", "err");
      // The drop control sits below the fold on a small phone — bring it up.
      var ovl = document.getElementById("ups-m-bid-overlay");
      var dp = ovl && ovl.querySelector ? ovl.querySelector('[data-act="pick-drop"]') : null;
      if (dp && dp.scrollIntoView) { try { dp.scrollIntoView({ block: "center" }); } catch (e) {} }
      return;
    }
    // Re-read the box: a tap on "Add to claims" can land before its change
    // event on some keyboards. Same legal-amount rule as the worker.
    var box = document.getElementById("ups-m-bid-amt");
    var typed = box ? parseBidK(box.value) : null;
    if (box && typed == null) {
      M.ui.showToast("Enter a valid bid amount in $K.", "err");
      box.focus();
      return;
    }
    var amt = legalBid(box ? typed : bidView.amount, lim);

    var plan = clonePlan();
    // Editing: pull the old pick out first so the round move is a real move —
    // by PLAYER, re-found now (resolveEditIndex), never by the stale slot.
    var editIdx = -1;
    if (bidView.editRef) {
      editIdx = resolveEditIndex(plan, bidView.editRef, bidView.addPid);
      if (editIdx < 0) {
        var gone = nameForPid(bidView.addPid);
        closeBidSheet();
        M.ui.showToast(gone + "'s claim changed while you were editing (a waiver run may have processed it). " +
          "Nothing was saved — check your claims.", "err");
        if (document.getElementById("ups-m-claims-overlay")) renderClaimsScreen({ keepScroll: true });
        else renderRoute();
        return;
      }
      plan.forEach(function (g) {
        if (g.round === bidView.editRef.round) g.picks.splice(editIdx, 1);
      });
    }
    var group = plan.filter(function (g) { return g.round === bidView.round; })[0];
    if (!group) { group = { round: bidView.round, picks: [] }; plan.push(group); }
    // One claim per player per group — the same player across DIFFERENT
    // groups is fine and intentional (that's how you ladder a bid).
    var dupe = group.picks.filter(function (p) { return String(p.add_pid) === String(bidView.addPid); })[0];
    if (dupe) {
      M.ui.showToast(nameForPid(bidView.addPid) + " is already claimed in group " + bidView.round + ".", "err");
      return;
    }
    var newPick = {
      add_pid: String(bidView.addPid),
      bid_dollars: amt,
      drop_pid: bidView.dropPid ? String(bidView.dropPid) : null
    };
    // Order inside a round IS priority — MFL honours it, and this screen gives
    // it dedicated ▲/▼ controls. So an edit that STAYS in its group has to keep
    // its slot: pushing silently demoted your #1 target to last just for
    // nudging the bid $1K, and the snap-to-top re-render meant you might not
    // even see it happen. A genuine group MOVE still lands at the end of the
    // destination group, which is the only sane default there.
    var sameRound = !!bidView.editRef && bidView.editRef.round === bidView.round;
    if (sameRound) group.picks.splice(Math.min(editIdx, group.picks.length), 0, newPick);
    else group.picks.push(newPick);
    commitPlan(plan);
    var wasEdit = !!bidView.editRef;
    closeBidSheet();
    // The toast repeats the amount actually staged, so a rounded bid is never
    // a surprise on the Claims screen.
    M.ui.showToast((wasEdit ? "Claim updated: " : "Staged ") + U.fmtUsd(amt) + " in group " + group.round +
      " — not submitted yet.", "ok");
    // Follow the claim to its group. Staging or moving into a group you aren't
    // looking at otherwise leaves you on the group it LEFT, watching it vanish
    // — and if it was that group's last pick, staring at a red "withdrawing"
    // panel you never asked for. claim-copy-group already did this; edit/move
    // didn't. Same-round edits keep their scroll (like reorder/remove do);
    // a real move snaps to top so header + tabs + destination are all visible.
    claimsTab = group.round;
    if (document.getElementById("ups-m-claims-overlay")) renderClaimsScreen({ keepScroll: sameRound });
    else renderRoute();
  }

  function clonePlan() {
    try { return JSON.parse(JSON.stringify(stagedPlan())); } catch (e) { return []; }
  }
  function commitPlan(plan) {
    plan.sort(function (a, b) { return U.safeInt(a.round, 0) - U.safeInt(b.round, 0); });
    // CONTRACT v2 §2 — a round the owner just emptied has to STAY in the plan
    // carrying an explicit clear. Drop it and the round is simply absent from
    // the payload, which now means "leave it alone" — i.e. the claim they just
    // deleted would still be live at MFL, still spending cap, while the Claims
    // screen cheerfully read "No claims staged".
    plan.forEach(function (g) {
      if (!g.picks || !g.picks.length) { g.picks = []; g.clear = true; }
      else { g.clear = false; }
    });
    if (M.waivers && M.waivers.setPlan) M.waivers.setPlan(plan);
    // Every mutation funnels through here, so this is the one place that can
    // keep the banners honest. A green "Claims submitted and verified" (or a
    // dry-run preview of a payload that no longer exists) must not survive the
    // next edit — it would sit directly above an amber "Edited — not
    // submitted" pill saying the opposite.
    //
    // The tone check is LOAD-BEARING: the warn-toned banners (§1 "couldn't read
    // your claims back", partial-submit "rounds 1-2 already went through") are
    // exactly the ones an owner must keep seeing while they fix things up, and
    // clearing those on edit would bury a duplicate-write hazard.
    claimsPreview = null;
    if (claimsNotice && claimsNotice.tone === "ok") claimsNotice = null;
    // Same reasoning for the Market's flash line: the moment the plan changes,
    // "Submitted and verified" is no longer true of what's on screen, and
    // leaving it up would put a green tick directly above the amber "Finalize
    // claims" chip — the exact contradiction this sweep exists to prevent.
    waiverFlash = null;
  }

  // ══ Claims screen ══════════════════════════════════════════════════════
  // Full-screen overlay. Groups 1..N, each an ORDERED list of picks (MFL
  // honours order inside a round). Reorder with ▲/▼ buttons — drag on mobile
  // is unreliable inside a scrolling overlay, so it's deliberately not used.
  var claimsBusy = false;
  // A sticky banner rather than a toast: when the server couldn't read our
  // claims (`known:false`) the owner has to keep seeing that what's on screen
  // is their LOCAL draft, not MFL's truth — a toast that fades away is not
  // good enough for that. { tone:"warn"|"ok", text }.
  var claimsNotice = null;
  // Which group tab is showing. View state only — never part of the payload.
  var claimsTab = 1;
  // Dry-run result: `would_write` from the server, rendered as a preview.
  // Never adopted into the plan (contract v2 §3).
  var claimsPreview = null;
  // True while the initial pending-read is in flight, so an empty screen can
  // say "checking" instead of asserting "no claims" before we've asked.
  var claimsLoading = false;
  // Is the claims screen SUPPOSED to be on screen? A submit can outlive it now
  // that navigating away dismisses overlays, and every async completion path
  // calls renderClaimsScreen() — which builds the overlay from scratch. Without
  // this, a slow submit that settles after the owner has moved to another tab
  // would slam a full-screen modal back over an unrelated route (and re-lock
  // the page scroll). renderClaimsScreen bails when this is false.
  var claimsOpen = false;

  // ── "MFL's copy changed while you weren't looking" ─────────────────────
  //
  // Keith 2026-08-08: after the Sunday 9:00 AM BBID run, this screen still
  // showed a claim for a player he had ALREADY WON in that run, with the
  // button reading "Submit 2 claims" — submitting would have re-claimed a
  // player he owns.
  //
  // MFL is NOT at fault and there is nothing to withdraw: MFL clears granted
  // claims when the run processes, and /api/waivers/pending reads MFL live.
  // The stale thing is the CLIENT'S LOCAL DRAFT PLAN, which is persisted and
  // therefore outlives the run — which is exactly why "Reload from MFL" fixed
  // the screen.
  //
  // The question asked here is NOT "has a run time passed". A clock says
  // nothing about whether MFL has actually processed anything: the state
  // endpoint's next_bbid_run_unix is computed off `now`, so it rolls forward
  // the instant 09:00:00 passes, while the run itself may not have cleared a
  // single claim yet. Keying off it would nag about a run that changed nothing
  // — or worse, re-baseline against claims that are still pending.
  //
  // So compare CONTENT instead: MFL's holdings right now, against the holdings
  // this plan was hydrated from (M.waivers.mflBasis(), persisted in the same
  // record as the plan, so it survives a PWA relaunch). A difference is
  // processing-derived and real, and it is true whoever caused it — the run,
  // another device, or the commish.
  //
  // Set only in the dirty case: MFL's copy differs and we refuse to swap the
  // plan out from under unsent edits, so the screen says so instead.
  var claimsMflChanged = false;
  // One check in flight at a time. The screen can be reopened, or the app
  // foregrounded twice, faster than a round trip completes.
  var claimsCheckInFlight = false;

  // Re-read MFL's pending claims and compare them against the basis this plan
  // was hydrated from. Makes NO writes — one extra GET, the same read the
  // manual "Reload from MFL" performs.
  //
  // Every uncertain outcome falls through to "leave the screen exactly as it
  // is". No basis (a plan stored before this existed, or one never hydrated
  // from MFL) and an unreadable /pending both mean UNKNOWN. Unknown is never
  // reported as changed — that would offer to replace a clean draft on the
  // strength of a dead endpoint — and never as unchanged, which would require
  // asserting something we did not read.
  function checkMflHoldingsChanged() {
    if (!M.waivers || !M.waivers.fetchPending || !M.waivers.mflBasis ||
        !M.waivers.mflSignature) return;
    if (claimsCheckInFlight) return;
    var basis = M.waivers.mflBasis();
    // null = we have never seen MFL's copy for this plan. Nothing to compare.
    if (typeof basis !== "string") return;
    claimsCheckInFlight = true;
    M.waivers.fetchPending().then(function (resp) {
      claimsCheckInFlight = false;
      // Screen was dismissed, or something re-hydrated the plan while this was
      // in flight — either way this answer is about a screen that's gone.
      if (!claimsOpen) return;
      if (M.waivers.mflBasis() !== basis) return;
      var now = M.waivers.mflSignature(resp);
      if (typeof now !== "string") return;   // unreadable → assert nothing
      if (now === basis) return;             // MFL still holds what we think
      // MFL's copy has moved. Unsent work on screen is never swapped out from
      // under the owner — reloadClaimsFromServer is a whole-plan replace, and
      // the manual control confirms first for exactly this reason. State what
      // changed and let them press Reload themselves.
      if (planIsDirty() && (stagedCount() || clearCount())) {
        claimsMflChanged = true;
        // keepScroll: an owner reading group 3 stays in group 3.
        renderClaimsScreen({ keepScroll: true });
        return;
      }
      // Clean plan: nothing unsent can be lost, so adopt MFL's copy. The
      // response is already in hand, so this costs no second round trip.
      adoptClaimsFrom(resp);
    }).catch(function () {
      claimsCheckInFlight = false;           // unreadable → leave the screen alone
    });
  }

  // ── "Already on my roster" sweep (Keith 2026-08-09) ─────────────────────
  //
  // CORRECTION (2026-08-09, supersedes the note this replaces). The original
  // comment here asserted that "MFL's pendingWaivers export does NOT reliably
  // drop a round just because that round's run already processed; it can keep
  // echoing the same submitted request back." That is FALSE. A live
  // authenticated read of TYPE=pendingWaivers for this league, taken hours
  // after a processed run, returned literally
  // {"version":"1.0","pendingWaivers":{},"encoding":"utf-8"} — MFL was holding
  // NOTHING and had cleared the round correctly. MFL is not at fault and does
  // not echo stale rounds.
  //
  // THE ACTUAL ROOT CAUSE (as of 2026-08-09) was the client's own persisted
  // draft plus two guards that between them guaranteed it was never
  // reconciled away:
  //   1. openClaimsScreen() below computes `willFetch` as
  //      `!stagedCount() && !clearCount() && …`, so it seed-reads /pending ONLY
  //      when nothing is staged locally. A stale staged claim therefore
  //      suppresses the exact read that would have corrected it. STILL TRUE.
  //   2. checkMflHoldingsChanged() above DOES read /pending, but returns at
  //      `if (typeof basis !== "string") return;` whenever the stored MFL basis
  //      is null — and a plan restored from localStorage commonly has mfl:null
  //      (app.js getWaiverPlan sets it null for the v1 on-disk shape). This
  //      half still holds for old on-disk shapes. The OTHER half — "even with
  //      a basis present, a cold-restored plan reads as dirty because
  //      waiverPlanVerified was session-only" — is FIXED (Keith 2026-09-03,
  //      "i had a submitted claim not unsubmitted"): the verified signature
  //      now rides in the same persisted record as the basis, so a plan that
  //      is genuinely unchanged since MFL last confirmed it correctly reads
  //      as clean and gets adopted, not just flagged, after a cold start.
  // Net: a submitted-and-since-processed plan with a KNOWN basis (mfl set)
  // now reconciles automatically on a fresh check; one with mfl:null (an old
  // v1/v2 on-disk shape, or a plan never yet hydrated from MFL) still relies
  // on this sweep. checkMflHoldingsChanged is otherwise left exactly as it
  // is — everything below is additional, independent signal, not a
  // replacement for that comparison.
  //
  // WHAT THIS SWEEP ACTUALLY IS: a complementary FAST PATH for the WIN case,
  // not the primary mechanism. Roster membership is ground truth — a player
  // can't simultaneously be "still awaiting a bid result" and "already on my
  // own roster" — so whenever a staged pick's add_pid shows up in
  // M.waivers.getOwnRosterPids(), that specific pick has unambiguously
  // resolved, and it can be cleared immediately without waiting for anything
  // else. Its blind spot is the case Keith actually hit: a LOSING bid never
  // lands on the roster, so this sweep never fires for it and the claim would
  // render as pending forever. That case is covered by runProcessedClear()
  // below, which keys off the league-wide waiver-RUN log and therefore covers
  // wins and losses alike. Both are kept: this one is faster and names the
  // player, that one is complete.
  //
  // Deliberately NOT commitPlan(): a round left empty by THIS sweep is empty
  // because it already executed for real, not because the owner asked to
  // withdraw it. commitPlan's picks:[]+clear:true path is reserved for that
  // second, opposite case — the owner deliberately emptying a round via the
  // Remove button — and it has to survive as an explicit withdrawal
  // instruction so MFL doesn't keep processing a bid the owner just deleted
  // (CONTRACT v2 §2, see the block comment on commitPlan above). Sending
  // clear:true from here would render the swept round as "withdrawing"
  // (claimsScreenHtml's cleared-round branch below) — which is false, and
  // exactly the confusing state this fix exists to eliminate. So a round
  // whose picks are ALL swept away is simply OMITTED from the array handed
  // to setPlan(): setWaiverPlan (app.js) already drops a round with no picks
  // and no clear:true exactly like it drops one absent from the input
  // altogether, so this needs no new handling there — see the comment on
  // setWaiverPlan.
  //
  // An already-empty round (picks:[], clear:true — i.e. a pending explicit
  // withdrawal that hasn't been submitted yet) has nothing for this sweep to
  // filter and is passed through untouched: collapsing it to "omitted" would
  // silently turn the owner's withdrawal into "leave it alone", which is the
  // exact v1 bug CONTRACT v2 was written to fix.
  //
  // Calls M.waivers.setPlan(...) directly (never commitPlan) so the
  // explicit-clear invariant above is respected, and returns the list of
  // { round, add_pid } picks it removed (or false when there was nothing to
  // do / nothing removed) so a caller can render an explanatory notice.
  function sweepResolvedPicks() {
    if (!M.waivers || !M.waivers.getOwnRosterPids) return false;
    var owned = M.waivers.getOwnRosterPids();
    if (!owned || !owned.size) return false;
    var plan = stagedPlan();
    var removed = [];
    var next = [];
    plan.forEach(function (g) {
      var picks = g.picks || [];
      var round = U.safeInt(g.round, 0);
      if (!picks.length) {
        // Nothing to sweep — preserve as-is (see the already-empty-round
        // note above).
        next.push(g);
        return;
      }
      var kept = picks.filter(function (p) {
        if (p && owned.has(String(p.add_pid))) {
          removed.push({ round: round, add_pid: p.add_pid });
          return false;
        }
        return true;
      });
      if (kept.length === picks.length) { next.push(g); return; } // untouched
      if (kept.length) { next.push({ round: round, picks: kept }); return; } // some remain
      // every pick in this round resolved — OMIT it entirely (never clear:true)
    });
    if (!removed.length) return false;
    if (M.waivers.setPlan) M.waivers.setPlan(next);
    return removed;
  }

  // Notice text for sweepResolvedPicks() results — same claimsNotice
  // { tone, text } shape this file already uses (see adoptClaimsFrom above).
  function resolvedSweepNotice(removed) {
    var names = [];
    removed.forEach(function (r) {
      var n = nameForPid(r.add_pid);
      if (names.indexOf(n) === -1) names.push(n);
    });
    var text = names.length === 1
      ? names[0] + " is on your roster now — that claim already went through, so it's cleared here."
      : names.join(", ") + " are on your roster now — those claims already went through, so they're cleared here.";
    return { tone: "ok", text: text };
  }

  // Shared by both openClaimsScreen() call sites and the visibilitychange
  // handler below: runs the sweep and, if it found anything, sets the
  // notice and repaints so the shorter plan + the message actually show up.
  function applyResolvedSweep() {
    var removed = sweepResolvedPicks();
    if (!removed || !removed.length) return false;
    // A "warn" notice already on screen (couldn't read MFL, partial-submit
    // mismatch, ...) is the load-bearing text standing between the owner and
    // a duplicate cap-spending write (see commitPlan's own comment on this
    // same rule). The sweep's plan-level fix — removing the resolved
    // pick(s) — still applies either way; only the notice text is gated,
    // so a good-news "cleared" message can never bury an active hazard
    // warning that was already on screen.
    if (!(claimsNotice && claimsNotice.tone === "warn")) {
      claimsNotice = resolvedSweepNotice(removed);
    }
    if (claimsOpen) renderClaimsScreen();
    return true;
  }

  // ── "A real waiver run has already processed this" (Keith 2026-08-09) ────
  //
  // Keith's objection to the roster sweep above, verbatim: "no because i might
  // not win a player, it should be based on true waiver runs...you need to
  // check the logs." He is right. The sweep only fires when the owner WON —
  // a losing bid never lands on the roster, so nothing ever clears it and it
  // renders as pending forever. This is the signal that covers both outcomes.
  //
  // Two facts, both from MFL's OWN WAIVER_BBID calendar events, compared
  // against each other — no clock, no timestamp arithmetic, nothing derived
  // from the device:
  //   • last_run   — /api/waivers/state: the newest scheduled BBID run at or
  //                  before now.
  //   • targetRun  — stamped onto the plan when it was staged/adopted, from
  //                  that same calendar's next_bbid_run_unix. "Which run is
  //                  this plan waiting for."
  // If the run the plan was waiting for has passed, MFL has processed that
  // plan. Whether each bid won or lost is NOT knowable from this signal, and
  // the notice below is careful never to imply otherwise.
  //
  // Keith 2026-08-09: "just read the previously processed waivers report OR
  // read the API to see when waivers ran...or read my schedule. Cmon i feel
  // like this is asking for trouble." The schedule it is. An earlier cut of
  // this read a 30-day BBID_WAIVER transaction log and compared it against a
  // device-clock submitted-at stamp — an extra MFL round trip per request,
  // clock-skew hazards, and a real hole: it inferred "a run happened" from
  // AWARDS, so a run nobody won left no trace and read as no run at all.
  // Cross-checked 2026-08-09 on L=74598 — the calendar's Fri/Sat/Sun 09:00 ET
  // WAIVER_BBID events matched the award timestamps 1786107600 / 1786194000 /
  // 1786280400 exactly, all three — so the schedule says everything the log
  // said, for free, and says it even when nobody won.
  //
  // ── FAIL CLOSED, on every input ──
  // known:false (unreadable calendar), a missing/zero unix, a missing target
  // (a plan restored from an on-disk record written before the field existed),
  // an empty plan — every one returns false and changes NOTHING. An
  // unreadable input is never an empty one (rule_no_fail_open_guards); the
  // whole point is that we would rather leave a stale claim on screen for
  // another cycle than clear a live one on a guess.
  //
  // ── LOCAL-ONLY, and it MUST STAY THAT WAY ──
  // Deliberately NOT commitPlan(), for exactly the reason spelled out on
  // sweepResolvedPicks above: commitPlan converts an emptied round into
  // picks:[] + clear:true, which under CONTRACT v2 §2 is an EXPLICIT
  // "withdraw this round at MFL" instruction and is reserved for the owner
  // pressing Remove. A round cleared HERE is gone because MFL already
  // processed it, not because anyone asked to withdraw it — there is nothing
  // left at MFL to withdraw. So this calls M.waivers.setPlan(...) directly
  // with the rounds removed, same as sweepResolvedPicks, and sends NOTHING
  // anywhere. This function makes no network call of any kind.
  //
  // `{ targetRun: null }` on the setPlan is load-bearing: the target belonged
  // to the plan that just got cleared. Leaving it on disk would mean the NEXT
  // run also satisfies it, so a claim the owner stages tomorrow — aimed at a
  // later run entirely — would be wiped the moment it was staged.
  //
  // Returns { ran_unix, removed:[{round, add_pid}], cleared_rounds:[n] } when
  // it acted, false otherwise.
  function runProcessedClear() {
    if (!M.waivers || !M.waivers.lastRun || !M.waivers.targetRun || !M.waivers.setPlan) return false;
    var lr = M.waivers.lastRun();
    // known !== true is UNREADABLE (or a worker without the field), never
    // "no run happened".
    if (!lr || lr.known !== true) return false;
    var ranAt = lr.unix;
    // known:true + unix:null is a legitimately readable answer — the calendar
    // was read and no BBID run is scheduled at or before now. Nothing to act on.
    if (typeof ranAt !== "number" || !isFinite(ranAt) || ranAt <= 0) return false;
    var target = M.waivers.targetRun();
    // null = we do not know which run this plan was aimed at (a record written
    // before the field existed, or staged while the calendar had no upcoming
    // run). Unknown, so we do nothing.
    if (typeof target !== "number" || !isFinite(target) || target <= 0) return false;
    // >=, not >: `target` IS a run instant, so the run it names counts as
    // having happened the moment last_run reaches it. Both sides are the same
    // kind of value from the same MFL calendar, which is the whole point —
    // there is no "now", no device clock, and nothing to skew.
    if (!(ranAt >= target)) return false;

    var plan = stagedPlan();
    if (!plan.length) {
      // Nothing on the board to clear — but the spent TARGET still has to go.
      //
      // It names a run that has now happened, so it describes nothing. Leaving
      // it on disk is how a genuinely-live plan gets wiped later: the target
      // stays satisfied forever, so the next plan written without a fresh
      // target (a record restored mid-flight, an adopt whose read-back failed)
      // would be cleared on sight while its claims are live at MFL and
      // spending cap.
      //
      // Local-only, same as every other write in this function: setPlan with
      // the plan we already have is a no-op on the plan itself and cannot
      // reach MFL.
      M.waivers.setPlan(plan, { targetRun: null });
      return false;
    }
    var removed = [];
    var clearedRounds = [];
    plan.forEach(function (g) {
      var round = U.safeInt(g.round, 0);
      var picks = g.picks || [];
      if (picks.length) {
        picks.forEach(function (p) {
          if (p) removed.push({ round: round, add_pid: p.add_pid });
        });
      } else if (g.clear === true) {
        // An unsubmitted explicit withdrawal. sweepResolvedPicks passes these
        // through untouched because it has no evidence about them — but here we
        // DO: the run processed that round at MFL, so there is no longer a live
        // claim for this withdrawal to cancel. Keeping it would leave the round
        // rendering as "withdrawing" forever, which is the same stale-pending
        // bug wearing a different label. Dropping it is local-only and cannot
        // reach MFL (see the block comment above).
        clearedRounds.push(round);
      }
    });
    if (!removed.length && !clearedRounds.length) return false;
    // Everything staged predates the run, so the whole board is stale.
    M.waivers.setPlan([], { targetRun: null });
    return { ran_unix: ranAt, removed: removed, cleared_rounds: clearedRounds };
  }

  // Notice text for runProcessedClear() — same claimsNotice { tone, text }
  // shape the rest of this file uses.
  //
  // HONESTY RULE: this signal proves a run happened and that MFL processed
  // what was on file. It proves NOTHING about who won what. So the text says
  // "processed" and sends the owner to their roster; it must never say or
  // imply won/lost. Absolute time comes from M.waivers.when() — the existing
  // formatter (app.js waiverWhen), not a new one. waiverCountdown is no use
  // here: it renders any past instant as "now".
  function runProcessedNotice(res) {
    // PREFER THE SERVER'S ET LABEL. This is a league-wide 9:00 AM ET event, so
    // rendering it with the device's timezone would tell a Pacific owner
    // "Waivers ran 6:00 AM" — wrong, and stated as fact. M.waivers.when() is
    // only the fallback for a worker that didn't send a label (it owns ET
    // formatting; we don't guess a timezone).
    var lr = (M.waivers && M.waivers.lastRun) ? M.waivers.lastRun() : null;
    var when = U.safeStr(lr && lr.label) ||
      ((M.waivers && M.waivers.when) ? M.waivers.when(res.ran_unix) : "");
    var lead = when ? ("Waivers ran " + when + ". ") : "Waivers have run since these were staged. ";
    var names = [];
    (res.removed || []).forEach(function (r) {
      var n = nameForPid(r.add_pid);
      if (n && names.indexOf(n) === -1) names.push(n);
    });
    var body;
    if (names.length === 1) {
      body = "MFL has processed your claim on " + names[0] +
        " — check your roster to see whether you won it.";
    } else if (names.length > 1) {
      body = "MFL has processed these claims (" + names.join(", ") +
        ") — check your roster to see which, if any, you won.";
    } else if ((res.cleared_rounds || []).length) {
      var rds = res.cleared_rounds;
      body = "MFL has already processed " +
        (rds.length === 1 ? "group " + rds[0] : "groups " + rds.join(", ")) +
        ", so the withdrawal staged here no longer applies.";
    } else {
      body = "MFL has processed what was staged here — check your roster to see which, if any, you won.";
    }
    return { tone: "ok", text: lead + body };
  }

  // Wrapper mirroring applyResolvedSweep: run the check and, if it acted, set
  // the notice and repaint.
  //
  // Same warn-preservation rule, and for the same reason (established by the
  // roster sweep): a "warn" notice already on screen — couldn't read MFL,
  // partial submit, verify mismatch — is the text standing between the owner
  // and a duplicate cap-spending write. The plan-level fix still applies
  // either way; only the good-news text is gated, so it can never bury an
  // active hazard warning.
  function applyRunProcessedClear() {
    var res = runProcessedClear();
    if (!res) return false;
    if (!(claimsNotice && claimsNotice.tone === "warn")) {
      claimsNotice = runProcessedNotice(res);
    }
    if (claimsOpen) renderClaimsScreen();
    return true;
  }

  function claimsScreenHtml() {
    var lim = waiverLimits();
    var plan = stagedPlan();
    var dirty = planIsDirty();
    var total = stagedCount();
    var clears = clearCount();
    var info = waiverModeInfo();
    var pend = pendingInfo();

    var body = "";
    if (!plan.length && claimsLoading) {
      // We have not asked MFL yet. "No claims staged." here is an assertion we
      // haven't earned — and for an owner whose Home tile just said "3 claims"
      // it reads as "your live, cap-spending bids are gone."
      body = '<div class="ups-m-claims-empty">' +
        '<div class="t">Checking your claims at MFL…</div>' +
        '<div class="s">One moment.</div>' +
      '</div>';
    } else if (!plan.length) {
      // Honest empty state. "No claims staged" is only safe to say alongside
      // what we actually know about MFL's side — when the pending read failed,
      // an empty local plan proves nothing about what MFL is holding.
      var emptySub = pend.known
        ? 'Find a player in the Market and tap <strong>Bid</strong>. ' +
          'Claims stay here until you submit them.'
        : 'Find a player in the Market and tap <strong>Bid</strong>. ' +
          'We haven’t been able to read your live claims from MFL, so this ' +
          'screen shows your local draft only — check MFL if you think a claim is out there.';
      body = '<div class="ups-m-claims-empty">' +
        '<div class="t">No claims staged.</div>' +
        '<div class="s">' + emptySub + '</div>' +
      '</div>';
    } else {
      // TABBED GROUPS (Keith 2026-07-30: "make the groups tab based rather than
      // scroll based"). Conditional bidding runs up to 8 rounds; stacking them
      // vertically buried the submit affordance under a long scroll. One group
      // at a time, with the tab strip pinned under the header.
      var tabRounds = plan.map(function (g) { return U.safeInt(g.round, 0); })
        .filter(function (n) { return n > 0; })
        .sort(function (a, b) { return a - b; });
      if (tabRounds.indexOf(claimsTab) === -1) claimsTab = tabRounds[0] || 1;
      var tabs = '<div class="ups-m-claim-tabs" role="tablist">' +
        tabRounds.map(function (rd) {
          var gg = plan.filter(function (g) { return U.safeInt(g.round, 0) === rd; })[0] || {};
          var cnt = (gg.picks || []).length;
          return '<button class="ups-m-claim-tab' + (rd === claimsTab ? " on" : "") +
            (cnt ? "" : " cleared") + '" role="tab" data-act="claim-tab" data-round="' + rd + '">' +
            'G' + rd + '<span class="n">' + (cnt ? cnt : "clr") + '</span></button>';
        }).join("") +
      '</div>';
      body = tabs + plan.filter(function (g) {
        return U.safeInt(g.round, 0) === claimsTab;
      }).map(function (g) {
        // A cleared round: no picks, an explicit "withdraw everything in this
        // group" that gets sent as picks:[]. Rendered as its own row so the
        // destructive thing on the screen is the thing the owner asked for.
        if (!g.picks || !g.picks.length) {
          return '<section class="ups-m-claim-group cleared">' +
            '<h3>Group ' + g.round + '<span class="n">withdrawing</span></h3>' +
            '<div class="ups-m-claim-clearrow">' +
              '<div class="body">' +
                '<div class="name">Clear every claim in group ' + g.round + '</div>' +
                '<div class="sub">Submits this group empty — MFL drops whatever it is holding for it.</div>' +
              '</div>' +
              '<button class="lnk" data-act="claim-unclear" data-round="' + g.round + '">Undo</button>' +
            '</div>' +
          '</section>';
        }
        var picks = (g.picks || []).map(function (p, i) {
          var moveOpts = "";
          if (lim) {
            for (var rd = 1; rd <= lim.maxRounds; rd++) {
              moveOpts += '<option value="' + rd + '"' + (rd === g.round ? ' selected' : '') + '>Group ' + rd + '</option>';
            }
          }
          return '<div class="ups-m-claim-row" data-round="' + g.round + '" data-index="' + i + '">' +
            '<div class="ord">' + (i + 1) + '</div>' +
            '<div class="body">' +
              '<div class="name">' + U.escapeHtml(nameForPid(p.add_pid)) + '</div>' +
              '<div class="sub">' + U.escapeHtml(posTeamForPid(p.add_pid)) +
                ' · <strong>' + U.escapeHtml(U.fmtUsd(p.bid_dollars)) + '</strong>' +
                (p.drop_pid ? ' · drop ' + U.escapeHtml(nameForPid(p.drop_pid)) : ' · no drop') +
              '</div>' +
            '</div>' +
            '<div class="ctl">' +
              '<button class="mv" data-act="claim-up" ' + (i === 0 ? 'disabled' : '') + ' aria-label="Move up">▲</button>' +
              '<button class="mv" data-act="claim-down" ' + (i === g.picks.length - 1 ? 'disabled' : '') + ' aria-label="Move down">▼</button>' +
            '</div>' +
            '<div class="ctl2">' +
              (lim ? '<select class="ups-m-claim-move" data-act="claim-move" aria-label="Move to group">' + moveOpts + '</select>' : '') +
              '<button class="lnk" data-act="claim-edit">Edit</button>' +
              '<button class="lnk danger" data-act="claim-remove">Remove</button>' +
            '</div>' +
          '</div>';
        }).join("");
        // Copy-group target list: every round EXCEPT this one. The common real
        // move is "same targets, higher bids in the next round", which is
        // copy-then-edit rather than re-entering six players by hand.
        var copyOpts = "";
        if (lim) {
          for (var crd = 1; crd <= lim.maxRounds; crd++) {
            if (crd === g.round) continue;
            copyOpts += '<option value="' + crd + '">Group ' + crd + '</option>';
          }
        }
        return '<section class="ups-m-claim-group">' +
          '<h3>Group ' + g.round + '<span class="n">' + g.picks.length +
            (g.picks.length === 1 ? " claim" : " claims") + '</span>' +
            '<button class="gclear" data-act="claim-clear-group" data-round="' + g.round +
              '">Clear group</button>' +
          '</h3>' +
          picks +
          (copyOpts
            ? '<div class="ups-m-claim-copy">' +
                '<span>Copy these ' + g.picks.length +
                  (g.picks.length === 1 ? " claim to" : " claims to") + '</span>' +
                '<select class="ups-m-claim-copysel" aria-label="Copy to group">' + copyOpts + '</select>' +
                '<button class="lnk" data-act="claim-copy-group" data-round="' + g.round + '">Copy</button>' +
              '</div>'
            : "") +
        '</section>';
      }).join("");
    }

    var pendingWork = total + clears;
    var status = dirty && pendingWork
      ? '<span class="ups-m-claims-dirty">Edited — not submitted</span>'
      : (total ? '<span class="ups-m-claims-clean">Submitted &amp; verified</span>' : "");

    // MFL's copy moved while these edits sat here unsent.
    //
    // It says only what was actually observed: the two copies differ. All this
    // read establishes is that MFL is holding something else — it did NOT see
    // a run process, so it does not claim one did. The likely causes are named
    // as possibilities, which is what they are.
    //
    // Non-destructive by construction: it hands over the SAME "Reload from
    // MFL" control the footer carries — data-act and all, so it runs through
    // onClaimsClick's confirm before anything is replaced. Showing this does
    // not touch the plan. The owner decides.
    //
    // Classes are ones app.css already defines (no stylesheet change here):
    // the notice box, and the footer's own button styling.
    var mflChanged = claimsMflChanged
      ? '<div class="ups-m-claims-notice warn">' +
          'MFL is holding different claims than the ones on this screen — its ' +
          'copy changed after these were loaded (a waiver run processing, ' +
          'another device, or the commissioner). Reload before you submit, or ' +
          'you could re-claim a player you already own.' +
          '<div><button class="ups-m-bid-btn ghost" data-act="claims-refresh">' +
            'Reload from MFL</button></div>' +
        '</div>'
      : "";

    var notice = claimsNotice
      ? '<div class="ups-m-claims-notice ' + (claimsNotice.tone === "ok" ? "ok" : "warn") + '">' +
          U.escapeHtml(claimsNotice.text) +
          (claimsNotice.tone !== "ok" && info.nativeLink
            ? ' <a href="' + U.escapeHtml(info.nativeLink) + '" target="_blank" rel="noopener">Check on MFL</a>'
            : '') +
        '</div>'
      : "";

    // §3: a dry run wrote nothing, so it can only ever be shown as a preview
    // of what a live submit WOULD send. It never touches the plan.
    var preview = "";
    if (claimsPreview) {
      var pw = (claimsPreview.rounds || []).map(function (g) {
        return "Group " + U.safeInt(g.round, 0) + ": " + ((g.picks || []).length) +
          ((g.picks || []).length === 1 ? " claim" : " claims");
      });
      var pc = (claimsPreview.cleared_rounds || []).map(function (r) {
        return "Group " + U.safeInt(r, 0) + ": cleared";
      });
      var plines = pw.concat(pc);
      preview = '<div class="ups-m-claims-preview">' +
        '<div class="t">Dry run — what a live submit would send</div>' +
        (plines.length
          ? '<ul>' + plines.map(function (l) { return '<li>' + U.escapeHtml(l) + '</li>'; }).join("") + '</ul>'
          : '<div class="s">Nothing — no round would change.</div>') +
        '<div class="s">Groups not listed are left exactly as they are at MFL.</div>' +
      '</div>';
    }

    // "Withdraw all" is offered whenever MFL might be holding something: a
    // known pending count, our own staged claims, or a pending read we could
    // NOT complete (in which case we clear every legal round to be sure).
    var offerWithdraw = info.writeEnabled && (total > 0 || pend.count > 0 || !pend.known);
    var withdrawRow = offerWithdraw
      ? '<div class="ups-m-claims-withdraw">' +
          '<button class="lnk danger" data-act="claims-withdraw-all"' + (claimsBusy ? ' disabled' : '') + '>' +
            'Withdraw all claims' + '</button>' +
          '<div class="s">Sends every group empty, which cancels whatever MFL is holding for you.</div>' +
        '</div>'
      : "";

    // §5: while write_enabled is false NO submit CTA renders — read-only view
    // plus the link out to MFL, never a button that can only 503.
    var submitLabel = claimsBusy
      ? "Submitting…"
      : (total
          ? ("Submit " + total + (total === 1 ? " claim" : " claims") +
             (clears ? " + " + clears + (clears === 1 ? " clear" : " clears") : ""))
          : ("Submit " + clears + (clears === 1 ? " clear" : " clears")));
    var foot = '<div class="ups-m-claims-foot">' +
      '<button class="ups-m-bid-btn ghost" data-act="claims-refresh">Reload from MFL</button>' +
      (info.writeEnabled && pendingWork
        ? '<button class="ups-m-bid-btn ghost" data-act="claims-preview"' + (claimsBusy ? ' disabled' : '') + '>Preview</button>' +
          '<button class="ups-m-bid-btn primary" data-act="claims-submit"' + (claimsBusy ? ' disabled' : '') + '>' +
            U.escapeHtml(submitLabel) + '</button>'
        : (!info.writeEnabled && info.nativeLink
            ? '<a class="ups-m-bid-btn primary" href="' + U.escapeHtml(info.nativeLink) +
              '" target="_blank" rel="noopener">Add/drop on MFL</a>'
            : '')) +
    '</div>';

    return '<div class="ups-m-claims-overlay" id="ups-m-claims-overlay">' +
      '<div class="ups-m-claims-screen">' +
        '<header class="ups-m-claims-head">' +
          '<button class="ups-m-claims-back" data-act="claims-close" aria-label="Back">‹</button>' +
          '<div class="ttl"><div class="t">Waiver claims</div>' +
            '<div class="s">' + U.escapeHtml(info.detail || "") + '</div></div>' +
          // Keith 2026-07-30: the dirty/clean pill has to stay put — it lived in
          // the scrolling body, so "Edited — not submitted" disappeared the
          // moment you scrolled to the group you were editing, which is exactly
          // when you need to know the plan is unsent. Pinned in the header now.
          (status ? '<div class="ups-m-claims-status">' + status + '</div>' : '') +
        '</header>' +
        '<div class="ups-m-claims-body" id="ups-m-claims-body">' +
          mflChanged +
          notice +
          preview +
          body +
          withdrawRow +
        '</div>' +
        foot +
      '</div>' +
    '</div>';
  }

  // opts.keepScroll — preserve the body's scroll position across this repaint.
  // Default is to snap back to the TOP (Keith 2026-07-30: "don't scroll on this
  // screen always render the top"). With groups tabbed, the whole point is that
  // the status, the tab strip and the group you picked are all on screen at
  // once; restoring a stale offset from the previous tab dropped you into the
  // middle of a different group. Only the in-place list edits (reorder, remove)
  // ask to keep it, since those should not yank the page under your thumb.
  function renderClaimsScreen(opts) {
    // Dismissed while an async submit/read was in flight — do NOT rebuild it.
    if (!claimsOpen) return;
    var existing = document.getElementById("ups-m-claims-overlay");
    var scrollTop = 0;
    if (existing) {
      var b = document.getElementById("ups-m-claims-body");
      scrollTop = (opts && opts.keepScroll && b) ? b.scrollTop : 0;
      existing.remove();
    }
    var mount = document.getElementById("ups-m-app");
    if (!mount) return;
    mount.insertAdjacentHTML("beforeend", claimsScreenHtml());
    document.body.style.overflow = "hidden";
    var overlay = document.getElementById("ups-m-claims-overlay");
    if (!overlay) return;
    overlay.addEventListener("click", onClaimsClick);
    overlay.addEventListener("change", onClaimsChange);
    var body2 = document.getElementById("ups-m-claims-body");
    if (body2 && scrollTop) body2.scrollTop = scrollTop;
  }

  // Tear the claims screen down.
  //
  // opts.toMarket — force a landing on #players. Passed ONLY by the
  // fully-verified submit, where the errand should end back on the Market that
  // carries the confirmation (flash line + the chip flipping to "Edit claims").
  // The ‹ back button passes nothing and stays on whatever route the screen was
  // opened over — it's reachable from the player sheet on #stats, #league, …
  // and yanking someone to the Market because they closed a panel is its own
  // kind of disorienting.
  function exitClaimsScreen(opts) {
    var ov = document.getElementById("ups-m-claims-overlay");
    if (ov) ov.remove();
    claimsOpen = false;
    if (!document.getElementById("ups-m-bid-overlay") &&
        !document.getElementById("ups-m-drop-overlay")) {
      document.body.style.overflow = "";
    }
    // Landing back on the Market after a submit: go to the TOP. The flash line
    // and the waiver strip both sit directly under the sticky toolbar, and
    // neither replaceState nor a hash assignment scrolls — so an owner who had
    // scrolled down to find their player would be dropped back mid-list with
    // every trace of the confirmation off-screen above them.
    if (opts && opts.toMarket) { try { window.scrollTo(0, 0); } catch (e) {} }
    var route = M.route.currentRoute();
    // Arrived via the #players/claims deep link (Home card)? The route itself
    // owns the overlay, so it MUST change or render() immediately re-opens it.
    //
    // REPLACE rather than navigate(): navigate() assigns location.hash, which
    // PUSHES a history entry, so dismissing the screen and then pressing Back
    // re-opened the very screen you just closed. replaceState swaps the entry
    // instead, and Back goes wherever you actually came from.
    if (route === "players/claims") {
      var replaced = false;
      try {
        if (window.history && window.history.replaceState) {
          window.history.replaceState(null, "", "#players");
          replaced = true;
        }
      } catch (e) { replaced = false; }
      if (!replaced) { M.route.navigate("#players"); return; }   // navigate() re-renders itself
      renderRoute();
      return;
    }
    if (opts && opts.toMarket && route.split("/")[0] !== "players") {
      M.route.navigate("#players");
      return;
    }
    renderRoute();
  }

  function closeClaimsScreen() { exitClaimsScreen(); }

  // Tear down every waiver overlay without touching the plan. Used when the
  // route changes out from under us (see app.js's hashchange handler).
  function dismissWaiverOverlays() {
    var found = false;
    ["ups-m-drop-overlay", "ups-m-bid-overlay", "ups-m-claims-overlay"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) { el.remove(); found = true; }
    });
    if (!found) return;
    claimsOpen = false;
    bidView = null;
    dropPicker = null;
    view.dropSheetFor = null;
    // The PLAYER SHEET holds this lock too and is not ours to dismiss — it
    // sits below the bid sheet and can legitimately still be open.
    //
    // Test OPEN-ness, not existence: player_sheet.js injects #ups-m-sheet-overlay
    // exactly once (ensureMount's `if (!mount.firstChild)`) and NEVER removes it
    // — close() only drops the .open class, and the CSS hides it with
    // display:none. So an existence check is true forever after the first player
    // sheet of the session, and would leave the whole app scroll-locked.
    var psheet = document.getElementById("ups-m-sheet-overlay");
    if (!psheet || !psheet.classList.contains("open")) document.body.style.overflow = "";
  }

  function claimRefFrom(el) {
    var row = el.closest ? el.closest(".ups-m-claim-row") : null;
    if (!row) return null;
    return {
      round: U.safeInt(row.getAttribute("data-round"), 0),
      index: U.safeInt(row.getAttribute("data-index"), -1)
    };
  }

  function onClaimsChange(e) {
    var sel = e.target;
    if (!sel || sel.getAttribute("data-act") !== "claim-move") return;
    var ref = claimRefFrom(sel);
    if (!ref) return;
    var toRound = U.safeInt(sel.value, 0);
    if (!toRound || toRound === ref.round) return;
    var plan = clonePlan();
    var from = plan.filter(function (g) { return g.round === ref.round; })[0];
    if (!from) return;
    var pick = from.picks.splice(ref.index, 1)[0];
    if (!pick) return;
    var to = plan.filter(function (g) { return g.round === toRound; })[0];
    if (!to) { to = { round: toRound, picks: [] }; plan.push(to); }
    var dupe = to.picks.filter(function (p) { return String(p.add_pid) === String(pick.add_pid); })[0];
    if (dupe) {
      M.ui.showToast(nameForPid(pick.add_pid) + " is already claimed in group " + toRound + ".", "err");
      renderClaimsScreen();
      return;
    }
    to.picks.push(pick);
    commitPlan(plan);
    claimsTab = toRound;          // follow the claim — see confirmBid's note
    renderClaimsScreen();
  }

  function onClaimsClick(e) {
    var t = e.target && e.target.closest ? e.target.closest("[data-act]") : null;
    if (!t) return;
    var act = t.getAttribute("data-act");
    if (act === "claims-close") { closeClaimsScreen(); return; }
    if (act === "claims-submit") { submitClaims({}); return; }
    if (act === "claims-preview") { submitClaims({ dryRun: true, skipConfirm: true }); return; }
    if (act === "claims-withdraw-all") { withdrawAllClaims(); return; }
    if (act === "claims-refresh") {
      // This REPLACES the plan with MFL's copy (adoptVerified is a whole-plan
      // swap), so with unsent edits on screen it is a destructive control —
      // and it sits shoulder-to-shoulder with Submit while sounding like a
      // harmless refresh. Every other destructive action in this file confirms
      // first; this one didn't, and then reported "Loaded N claims" as success.
      if (planIsDirty() && (stagedCount() || clearCount()) &&
          !window.confirm("Reload from MFL?\n\nYour unsubmitted changes on this screen will be replaced by whatever MFL is holding.")) {
        return;
      }
      reloadClaimsFromServer();
      return;
    }
    // Explicit clears (contract v2 §2). "Clear group" stages the round with
    // picks:[]; "Undo" takes the round back out of the payload entirely, which
    // leaves whatever MFL holds for it untouched.
    // Tab switch — pure view state, never touches the plan.
    if (act === "claim-tab") {
      var tabRd = U.safeInt(t.getAttribute("data-round"), 0);
      if (tabRd) { claimsTab = tabRd; renderClaimsScreen(); }
      return;
    }
    // Copy a whole group's picks into another round. Bids and conditional drops
    // ride along; the owner then edits the copies. Appends rather than
    // replaces, so an existing target group is never silently destroyed.
    if (act === "claim-copy-group") {
      var srcRd = U.safeInt(t.getAttribute("data-round"), 0);
      var sel = t.parentNode ? t.parentNode.querySelector(".ups-m-claim-copysel") : null;
      var dstRd = sel ? U.safeInt(sel.value, 0) : 0;
      if (!srcRd || !dstRd || srcRd === dstRd) return;
      var cpPlan = clonePlan();
      var srcG = cpPlan.filter(function (g) { return U.safeInt(g.round, 0) === srcRd; })[0];
      if (!srcG || !(srcG.picks || []).length) return;
      var dstG = cpPlan.filter(function (g) { return U.safeInt(g.round, 0) === dstRd; })[0];
      if (!dstG) { dstG = { round: dstRd, picks: [] }; cpPlan.push(dstG); }
      // A cleared group being copied INTO stops being a clear — the owner is
      // putting claims back in it.
      if (dstG.clear) delete dstG.clear;
      if (!dstG.picks) dstG.picks = [];
      srcG.picks.forEach(function (p) {
        dstG.picks.push({ add_pid: p.add_pid, bid_dollars: p.bid_dollars, drop_pid: p.drop_pid || null });
      });
      commitPlan(cpPlan);
      claimsPreview = null;
      claimsTab = dstRd;
      renderClaimsScreen();
      M.ui.showToast("Copied " + srcG.picks.length + " to Group " + dstRd, "ok");
      return;
    }
    if (act === "claim-clear-group" || act === "claim-unclear") {
      var roundAttr = U.safeInt(t.getAttribute("data-round"), 0);
      if (!roundAttr) return;
      var cp = clonePlan().filter(function (g) { return U.safeInt(g.round, 0) !== roundAttr; });
      if (act === "claim-clear-group") cp.push({ round: roundAttr, picks: [], clear: true });
      commitPlan(cp);
      claimsPreview = null;
      renderClaimsScreen();
      return;
    }

    var ref = claimRefFrom(t);
    if (!ref) return;
    var plan = clonePlan();
    var group = plan.filter(function (g) { return g.round === ref.round; })[0];
    if (!group) return;

    if (act === "claim-up" && ref.index > 0) {
      var a = group.picks.splice(ref.index, 1)[0];
      group.picks.splice(ref.index - 1, 0, a);
      commitPlan(plan);
      renderClaimsScreen({ keepScroll: true });
    } else if (act === "claim-down" && ref.index < group.picks.length - 1) {
      var b = group.picks.splice(ref.index, 1)[0];
      group.picks.splice(ref.index + 1, 0, b);
      commitPlan(plan);
      renderClaimsScreen({ keepScroll: true });
    } else if (act === "claim-remove") {
      group.picks.splice(ref.index, 1);
      commitPlan(plan);
      renderClaimsScreen({ keepScroll: true });
    } else if (act === "claim-edit") {
      openBidSheet(group.picks[ref.index].add_pid, ref);
    }
  }

  // Pull the server's view of our claims. CONTRACT v2 §1: adopt ONLY when the
  // envelope says `known:true`. A failed or unparseable MFL read comes back
  // `known:false / rounds:null` and we keep the owner's local plan, with a
  // sticky banner saying so — adopting an "empty" unknown is exactly the bug
  // that used to wipe live, cap-spending claims off this screen.
  // "We couldn't read MFL" banner text, with the worker's own explanation
  // appended when it sent one.
  //
  // FIELD NAMES, grep-verified against /api/waivers/pending: the explanation is
  // emitted as `normalize_warning` (canonical) AND `warning` (retained alias,
  // always the identical string); `unknown_reason` is the machine-readable code
  // and `mfl_status` / `mfl_response` carry the upstream detail when the export
  // itself never answered. `message` is NOT part of this envelope — reading it
  // (and nothing else) is why the explanation was empty on every single unknown
  // read, leaving the owner with generic text and no idea what had gone wrong.
  function unknownClaimsText(resp) {
    var why = U.safeStr(resp && (resp.normalize_warning || resp.warning));
    if (!why) {
      var mr = U.safeStr(resp && resp.mfl_response).replace(/<\/?error>/gi, "");
      if (mr) why = mr;
      else if (resp && U.safeInt(resp.mfl_status, 0)) {
        why = "MFL answered HTTP " + U.safeInt(resp.mfl_status, 0) + ".";
      }
      // Last resort: `message` only exists on the ERROR envelopes (the 401
      // MISSING_VIEWER_COOKIE body), which is how this function can be reached
      // from the .catch path with err.body.
      else if (resp && resp.message) why = U.safeStr(resp.message);
    }
    return "Couldn't read your claims from MFL — showing your local draft." +
      (why ? " (" + why + ")" : "");
  }

  // Adopt an ALREADY-READ /pending envelope as the plan, and repaint. Split
  // out of reloadClaimsFromServer so checkMflHoldingsChanged — which has just
  // read /pending to make its comparison — can adopt without a second GET.
  // §1 still governs: a `known:false` envelope adopts nothing and says so.
  function adoptClaimsFrom(resp) {
    claimsPreview = null;
    if (M.waivers.adoptVerified(resp)) {
      // On screen == MFL's copy again, so the "MFL's copy differs" banner is
      // false by construction; adoptVerified has also re-stamped the basis
      // behind it.
      claimsMflChanged = false;
      var n = stagedCount();
      claimsNotice = { tone: "ok", text: n
        ? ("Loaded " + n + (n === 1 ? " claim" : " claims") + " from MFL.")
        : "MFL is holding no claims for you." };
    } else {
      claimsNotice = { tone: "warn", text: unknownClaimsText(resp) };
    }
    // Reconcile whatever is now staged, on both signals, before the single
    // repaint below. Order: run-based clear FIRST, roster sweep second — see
    // openClaimsScreen for the reasoning. Both use the raw functions rather
    // than their apply* wrappers so this path renders exactly once.
    //
    // In the COMMON case here both no-op by construction, and that is the
    // design working: adoptVerified above re-targets the plan at the NEXT run,
    // which last_run cannot have reached yet, so runProcessedClear bails at the
    // comparison — we never clear something MFL just told us it is holding.
    // They matter on the OTHER branch: when adoptVerified returned false
    // (known:false, MFL unreadable) nothing was adopted and no target was
    // written, so the older stamp still describes the plan on screen and a run
    // since then is still proof it was processed. The run signal comes from the
    // transactions log, which is independent of the /pending read that just
    // failed.
    //
    // Same warn-preserving notice rule on both (a "couldn't read" warning above
    // must never lose to a good-news "cleared" line).
    var runCleared = runProcessedClear();
    if (runCleared && !(claimsNotice && claimsNotice.tone === "warn")) {
      claimsNotice = runProcessedNotice(runCleared);
    }
    var swept = sweepResolvedPicks();
    if (swept && swept.length && !(claimsNotice && claimsNotice.tone === "warn")) {
      claimsNotice = resolvedSweepNotice(swept);
    }
    renderClaimsScreen();
  }

  function reloadClaimsFromServer() {
    if (!M.waivers || !M.waivers.fetchPending) return;
    M.waivers.fetchPending().then(function (resp) {
      adoptClaimsFrom(resp);
    }).catch(function (err) {
      claimsNotice = { tone: "warn",
        text: "Couldn't read your claims from MFL — showing your local draft. " +
              ((err && err.message) || String(err)) };
      renderClaimsScreen();
    });
  }

  // Withdraw EVERYTHING: stage every round we have reason to think is live
  // with picks:[] and submit that. This is the explicit, user-asked-for
  // destructive operation contract v2 §2 requires — as opposed to v1, where
  // "withdraw" was inexpressible (empty groups were filtered out, the Submit
  // button hid itself at zero claims, and submitClaims early-returned) so an
  // owner's last claim could never be pulled from the app at all.
  function withdrawAllClaims() {
    if (claimsBusy) return;
    if (!writeEnabled()) { openNativeWaiverPage(); return; }
    var rounds = (M.waivers && M.waivers.withdrawAllPlan) ? M.waivers.withdrawAllPlan() : [];
    if (!rounds.length) { M.ui.showToast("Nothing to withdraw.", "ok"); return; }
    var pend = pendingInfo();
    var stagedNow = stagedCount();
    var msg = "Withdraw every waiver claim?\n\nGroup" + (rounds.length === 1 ? " " : "s ") +
      rounds.map(function (g) { return g.round; }).join(", ") +
      " will be sent to MFL empty, which cancels whatever they hold.";
    if (!pend.known) {
      msg += "\n\nWe couldn't read your live claims from MFL, so every group is cleared to be sure.";
    }
    if (stagedNow) {
      msg += "\n\nThe " + stagedNow + (stagedNow === 1 ? " claim" : " claims") +
        " staged on this screen will be discarded too.";
    }
    if (!window.confirm(msg)) return;
    commitPlan(rounds);
    claimsPreview = null;
    renderClaimsScreen();
    submitClaims({ skipConfirm: true });
  }

  // opts: { dryRun, skipConfirm }
  function submitClaims(opts) {
    opts = opts || {};
    if (claimsBusy) return;
    // §5 — belt and braces; no submit control renders while writes are dark.
    if (!writeEnabled()) { openNativeWaiverPage(); return; }
    var plan = stagedPlan();
    // An empty plan now genuinely means "change nothing" (§2), so there is
    // nothing to send. Rounds staged for an explicit clear are NOT empty —
    // they're in the plan carrying picks:[] and they submit like any other.
    if (!plan.length) return;
    var total = stagedCount();
    var clears = clearCount();
    if (!opts.dryRun && !opts.skipConfirm) {
      var lines = [];
      lines.push(total
        ? ("Submit " + total + (total === 1 ? " claim" : " claims") + " to MFL?")
        : "Withdraw your claims?");
      // The last screen before MFL: every claim exactly as it will be sent —
      // group, player, amount, drop — plus when MFL processes them.
      if (total) {
        lines.push("");
        plan.forEach(function (g) {
          (g.picks || []).forEach(function (pk, i) {
            lines.push("Group " + g.round + " #" + (i + 1) + ": " + nameForPid(pk.add_pid) + " — " +
              U.fmtUsd(pk.bid_dollars) + (pk.drop_pid ? " — drop " + nameForPid(pk.drop_pid) : " — no drop"));
          });
        });
      }
      var when = U.safeStr(waiverModeInfo().detail);
      if (when) lines.push("", when.replace(/\.?$/, "."));
      if (clears) {
        lines.push("", clears + (clears === 1 ? " group" : " groups") +
          " will be sent empty, cancelling whatever MFL holds for " +
          (clears === 1 ? "it" : "them") + ".");
      }
      lines.push("", "Groups you haven't touched here are left exactly as they are.");
      if (!window.confirm(lines.join("\n"))) return;
    }
    claimsBusy = true;
    renderClaimsScreen();
    M.waivers.submitPlan(plan, { dryRun: !!opts.dryRun }).then(function (resp) {
      claimsBusy = false;
      // §3 — a dry run wrote NOTHING, so `verified` is always known:false and
      // there is nothing to adopt. Show what a live run would send and leave
      // the local plan completely alone.
      if (opts.dryRun || (resp && resp.dry_run)) {
        claimsPreview = (resp && resp.would_write) || { rounds: [], cleared_rounds: [] };
        claimsNotice = { tone: "ok", text: "Preview only — nothing was sent to MFL." };
        renderClaimsScreen();
        return;
      }
      claimsPreview = null;
      // §1 — adopt the verified block ONLY when it says known:true. Otherwise
      // MFL wrote (or may have written) but we could not read it back: keep
      // the local plan and say so, rather than silently blanking the screen.
      var adopted = M.waivers.adoptVerified(resp && resp.verified);
      // A verified read-back is a hydration like any other: adoptVerified has
      // re-stamped the MFL basis from it, so the "MFL's copy differs" banner
      // no longer describes anything true.
      if (adopted) claimsMflChanged = false;
      var rawWarn = (resp && resp.warnings) || [];
      var warn = rawWarn.map(function (w) {
        return U.safeStr(w && (w.message || w.code));
      }).filter(function (x) { return !!x; });
      // Not all warnings mean the same thing, and treating them as one bucket
      // is why "take me back to the Market" would almost never have fired: the
      // worker attaches ADVISORY §6 notes (ROSTER_HEADROOM, CAP_ROOM,
      // LIMITS_UNKNOWN, …) to perfectly successful, fully-verified submits —
      // e.g. every time you claim without a conditional drop. Those describe
      // what MFL *might* do at award time; they are explicitly "never block".
      //
      // VERIFY_* is the different kind: it says the write itself couldn't be
      // confirmed, or MFL's read-back disagreed on a bid. That one has to keep
      // the owner on the screen with the sticky banner.
      var integrityWarn = rawWarn.some(function (w) {
        return /^VERIFY_/.test(U.safeStr(w && w.code));
      });
      // CLEAN SUCCESS — and ONLY a clean success — ends the errand and drops
      // the owner back on the Market they started from. The gate is
      // deliberately narrow: `adopted` means MFL's own read-back agreed
      // (known:true), and no warnings means it agreed without caveats.
      //
      // Every other outcome MUST stay on this screen, because each one carries
      // something the owner has to read before touching anything again:
      //   dry run          — nothing was written; the preview IS the result
      //   adopted + warns  — MFL took it, with caveats worth reading
      //   !adopted         — "we couldn't read it back, check MFL before the
      //                      run" (§1); navigating away buries the one sentence
      //                      that stops a duplicate cap-spending resubmit
      //   .catch           — partial / verify_mismatch / reject (see below)
      // Do NOT widen this condition, and never treat warnings as success.
      if (adopted && !integrityWarn) {
        claimsNotice = null;
        claimsPreview = null;
        var doneTxt = total
          ? (total + (total === 1 ? " claim" : " claims") + " submitted to MFL ✓")
          : "Claims withdrawn at MFL ✓";
        // Bridges the gap between the toast (gone in ~2.4s) and the Market's
        // own chip state, which is the durable "you're done" signal. Any
        // advisory notes ride out WITH us rather than being dropped on the
        // floor — they're worth reading, just not worth being held hostage by.
        waiverFlash = warn.length
          ? { tone: "warn", text: doneTxt + " — " + warn.join(" · "), until: Date.now() + 30000 }
          : { tone: "ok", text: "Submitted and verified against MFL ✓", until: Date.now() + 15000 };
        exitClaimsScreen({ toMarket: true });      // overlay down FIRST…
        M.ui.showToast(doneTxt, "ok");             // …then the toast, over the Market
        return;
      }
      if (adopted) {
        claimsNotice = { tone: "warn", text: warn.join(" · ") };
      } else {
        claimsNotice = { tone: "warn",
          text: "Submitted, but we couldn't read your claims back from MFL — showing your local draft. " +
                (warn.length ? warn.join(" · ") + " " : "") + "Check MFL before the run." };
      }
      renderClaimsScreen();
      M.ui.showToast(warn.length ? warn.join(" · ") : "Claims submitted ✓", warn.length ? "err" : "ok");
    }).catch(function (err) {
      claimsBusy = false;
      // P2 — "not submitted" is a claim about MFL's state, so it may only be
      // made when nothing landed. Two ways that is false even on an error:
      //   - verify_mismatch: MFL ACCEPTED the writes; its read-back disagrees.
      //   - mfl_reject MID-SEQUENCE: rounds post one at a time, so a refusal on
      //     round 3 leaves rounds 1-2 live at MFL as real, cap-spending claims.
      //     The worker reports exactly which in rounds_written/rounds_cleared.
      // Telling an owner "not submitted" there is how they resubmit on top of
      // claims that already exist.
      var eb = (err && err.body) || {};
      var wrote = (eb.rounds_written || []).concat(eb.rounds_cleared || []);
      var partial = wrote.length > 0;
      var wasSent = eb.error === "verify_mismatch" || partial;
      var partialTxt = partial
        ? "Round" + (wrote.length > 1 ? "s " : " ") + wrote.sort(function (a, b) { return a - b; }).join(", ") +
          " already went through at MFL" +
          (eb.failed_round ? " before round " + eb.failed_round + " was refused" : "") + ". "
        : "";
      claimsNotice = { tone: "warn",
        text: (partial ? "Partly submitted. " + partialTxt
                       : (wasSent ? "Sent, but MFL's copy doesn't match what was submitted: " : "Not submitted: ")) +
              ((err && err.message) || String(err)) +
              (partial ? " Check MFL before resubmitting — the rounds above are already live."
                       : " Your staged claims are still here.") };
      renderClaimsScreen();
      showWaiverError(partial ? "Claims partly submitted"
                              : (wasSent ? "Claims sent but not verified" : "Claims not submitted"), err);
    });
  }

  // MFL's own reject text is surfaced verbatim (app.js waiverErrorMessage
  // already unwraps it); a 503 hands back native_link so the owner can still
  // do it on MFL's site.
  function showWaiverError(prefix, err) {
    var msg = (err && err.message) || String(err);
    M.ui.showToast(prefix + ": " + msg, "err");
    // The 503 envelope carries native_link; fall back to the same URL we
    // already know from /api/waivers/state so the owner is never stranded.
    var link = (err && err.nativeLink) || nativeLink();
    if (link && window.confirm(prefix + ".\n\n" + msg + "\n\nOpen MFL's own waiver page instead?")) {
      window.open(link, "_blank");
    }
  }

  // ══ FCFS one-shot add ══════════════════════════════════════════════════
  // No bid, no plan: the league default salary row already makes this a
  // 1-year WW at $1K, so we never write salary or contract fields.
  function startFcfsAdd(pid) {
    if (!M.state.viewerFranchiseId) return;
    if (!writeEnabled()) { openNativeWaiverPage(); return; }
    var fid = M.state.viewerFranchiseId;
    var cap = DATA.computeCap(fid);
    // Headroom caption. rosterCount 0 means the cap mirror hasn't loaded —
    // say nothing rather than advertise "Active roster: 0".
    var headroom = "";
    if (cap && cap.rosterCount > 0 && cap.activeCount != null) {
      headroom = "Active roster: " + cap.activeCount +
        ((cap.irCount || cap.taxiCount)
          ? " (" + (cap.irCount || 0) + " IR · " + (cap.taxiCount || 0) + " taxi, not counted)"
          : "") +
        ". MFL enforces the roster limit when the add lands.";
    }
    // "No drop" is offered only when the add could actually land — see
    // rosterHeadroom() (Keith 2026-08-08, superseding the 2026-07-30
    // "always selectable" rule). Keith 2026-07-30 still holds for the wording
    // when it IS offered: "Can't have false statements of add none if it's not
    // possible" — so the label quotes the UPS active-roster ceiling against the
    // active count (IR/taxi excluded), and stays vague when either is unknown
    // rather than guessing in either direction.
    // noneSub labels the "No drop" row, so it is only built when that row is
    // going to exist. On the full branch its "open spot" wording would be a
    // flat contradiction of the note that takes the row's place — computing it
    // there is not just dead, it is a wrong string one edit away from shipping.
    var hr = rosterHeadroom();
    var noneSub = "";
    if (!hr.full) {
      noneSub = hr.known
        ? "Add into an open spot (" + hr.active + "/" + hr.max + " active)."
        : "Add without dropping anyone. MFL enforces the roster limit.";
    }
    openDropPicker({
      title: hr.full ? "Drop a player" : "Drop a player? (optional)",
      sub: 'Adding <strong>' + U.escapeHtml(nameForPid(pid)) + '</strong> — $1K, 1-year WW.' +
        (headroom ? '<br>' + U.escapeHtml(headroom) : ''),
      allowNone: !hr.full,
      noneSub: noneSub,
      // States the RULE, not a prediction of MFL's behaviour. `hr.max` is the
      // league's own ceiling; MFL's configured rosterSize is a separate number
      // that can lag it, so "MFL will refuse this" is a promise we are not in a
      // position to make — and a false one is exactly what Keith 2026-07-30
      // objected to. Say what is true: there is no open spot.
      noneBlockedNote: hr.full
        ? "Your active roster is full (" + hr.active + "/" + hr.max + " — the league limit " +
          "right now), so there is no open spot to add into. Pick the player this add replaces."
        : "",
      addPid: pid,
      onPick: function (dropPid) {
        confirmFcfsAdd(pid, dropPid ? [dropPid] : []);
      }
    });
  }

  function confirmFcfsAdd(addPid, dropPids) {
    var lines = ["Add " + nameForPid(addPid) + " now?", "", "$1,000 · 1-year WW contract."];
    if (dropPids.length) {
      dropPids.forEach(function (d) {
        var pen = dropPenalty(d);
        lines.push("Drop " + nameForPid(d) + (pen > 0 ? " — " + U.fmtUsd(pen) + " cap penalty" : " — no cap penalty"));
      });
    }
    lines.push("", "This writes to MFL immediately.");
    if (!window.confirm(lines.join("\n"))) return;
    M.ui.showToast("Adding " + nameForPid(addPid) + "…", "ok");
    M.waivers.submitFcfs({ addPid: addPid, dropPids: dropPids }).then(function (resp) {
      return M.actions.reloadData().then(function () {
        // P2 — "submitted" and "confirmed" are different facts, and this route
        // now tells us which one we have. A 200 with `verified:false` means MFL
        // ACCEPTED the write and the roster read-back that confirms it failed
        // (`verified` / `verify_known` / `retry_safe:false`, grep-verified in
        // /api/waivers/fcfs; `roster_verified` is the retained alias). A failed
        // READ is never evidence the WRITE failed — so this is not an error, but
        // it is not a tick either, and it must never read as "try again": an
        // add/cut is not idempotent, and a resend cuts a second player.
        var confirmed = !!(resp && (resp.verified === true || resp.roster_verified === true));
        if (!confirmed) {
          M.ui.showToast(
            U.safeStr(resp && resp.message) ||
            "Sent to MFL, but we couldn't confirm it on your roster. Check MFL's add/drop page — don't send it again.",
            "err"
          );
          renderRoute();
          return;
        }
        var note = (resp && resp.contract_note) || "$1,000 · 1-yr WW";
        M.ui.showToast(nameForPid(addPid) + " added ✓ — " + note, "ok");
        renderRoute();
      });
    }).catch(function (err) {
      // "Failed" is only honest when nothing landed — i.e. MFL itself rejected
      // the import (`mfl_reject`, retry_safe:true). On a `verify_mismatch` MFL
      // took the request and part of it may have applied, so the prefix must not
      // read as "nothing happened, do it again".
      var eb = (err && err.body) || {};
      showWaiverError(eb.error === "verify_mismatch" ? "Add not confirmed" : "Add failed", err);
    });
  }

  // ══ Public surface for the other mobile views ══════════════════════════
  // player_sheet.js (unrostered players) and views/home.js both drive the
  // waiver UI through this rather than duplicating window logic.
  M.waiverUI = {
    cta: acquisitionCta,
    modeInfo: waiverModeInfo,
    // §5 — surfaces ask this before drawing any write control of their own.
    writeEnabled: writeEnabled,
    nativeLink: nativeLink,
    // Edits the existing claim when there is one (see openBidFor) — the player
    // sheet's Bid button inherits that for free.
    openBid: function (pid) { openBidFor(pid); },
    startFcfs: startFcfsAdd,
    openClaims: openClaimsScreen,
    // Called by app.js's hashchange handler when the route moves away while an
    // overlay is still up. DOM + scroll-lock ONLY — it must never touch the
    // staged plan or adopt anything, or a stray Back press could quietly
    // discard work the owner hasn't submitted.
    dismissOverlays: dismissWaiverOverlays,
    stagedRoundsFor: stagedRoundsFor,
    stagedCount: stagedCount,
    clearCount: clearCount,
    isDirty: planIsDirty
  };

  function openClaimsScreen() {
    claimsOpen = true;
    claimsPreview = null;
    // Only a resolved/acknowledged notice may be dropped on re-entry. A WARN
    // notice is the partial-submit / verify-mismatch / "couldn't read MFL"
    // hazard text — "rounds 1-2 already went through, don't resubmit" — and
    // clearing it here is how an owner loses the one sentence standing between
    // them and a duplicate, cap-spending write (§B). It survives until an edit
    // supersedes it (commitPlan) or a fresh read replaces it.
    if (claimsNotice && claimsNotice.tone === "ok") claimsNotice = null;
    // Nothing staged locally? Seed from the server so an owner who bid on
    // desktop (or last week) sees their real claims, not an empty screen.
    // §1 again: only a `known:true` envelope may seed anything. A failed read
    // leaves the screen as-is and says the count is unknown, because "we
    // couldn't ask" must never be drawn as "you have none".
    var willFetch = !stagedCount() && !clearCount() && M.waivers && M.waivers.fetchPending;
    claimsLoading = !!willFetch;      // set BEFORE the first paint
    renderClaimsScreen();
    if (willFetch) {
      M.waivers.fetchPending().then(function (resp) {
        claimsLoading = false;
        if (M.waivers.adoptVerified(resp)) claimsMflChanged = false;
        else {
          claimsNotice = { tone: "warn", text: unknownClaimsText(resp) };
        }
        // Both run AFTER adoptVerified, on purpose, so they reconcile the
        // freshly-adopted plan and not just the one we had before the fetch.
        //
        // ORDER: run-based clear first, roster sweep second. The run signal is
        // the authoritative superset (it covers lost bids as well as won ones),
        // so letting it go first means at most one plan write and one notice
        // per pass instead of the sweep's narrower message being overwritten a
        // moment later. When it does not fire — unreadable calendar, no target
        // — it changes nothing at all and the roster sweep behaves exactly as
        // it did before this existed.
        //
        // On the SUCCESS path adoptVerified has just re-targeted the plan at
        // the NEXT run, so runProcessedClear correctly bails; it earns its
        // place on the known:false path just below, where nothing was adopted
        // and the older target still stands.
        applyRunProcessedClear();
        applyResolvedSweep();
        if (document.getElementById("ups-m-claims-overlay")) renderClaimsScreen();
      }).catch(function (err) {
        claimsLoading = false;
        // Signed-out is a normal cold-start case; anything else still has to
        // be visible rather than reading as an empty slate.
        if (!(err && err.ownerAuthExpired)) {
          claimsNotice = { tone: "warn", text: unknownClaimsText(err && err.body) };
        }
        // Nothing was adopted, so no stamp was written and the one on disk
        // still describes what is on screen — the run signal is fully in play
        // here, and it does not depend on the /pending read that just failed.
        // Same order as the success branch. Any warn notice set just above is
        // preserved by both wrappers.
        applyRunProcessedClear();
        applyResolvedSweep();
        if (document.getElementById("ups-m-claims-overlay")) renderClaimsScreen();
      });
    }
    // Only the local-draft path needs the check: `willFetch` means we are
    // already adopting MFL's own copy, which is the freshest thing there is.
    // What survives a run — and what Keith was looking at — is a plan that was
    // hydrated BEFORE the run, and which comes back out of storage unchanged
    // on the next cold start.
    if (!willFetch) {
      checkMflHoldingsChanged();
      // THE path that produced Keith's bug report: a plan restored from
      // localStorage, so `willFetch` is false (guard 1) and
      // checkMflHoldingsChanged bails on a null basis (guard 2) — see the
      // block comment on sweepResolvedPicks. Both checks below are
      // independent of that, and both run against state already in hand: no
      // network round trip, no writes anywhere.
      //
      // ORDER: run-based clear first, roster sweep second. Same reasoning as
      // the fetch branch above — the run signal covers wins AND losses, so it
      // subsumes the sweep; running it first avoids clearing the plan twice
      // and overwriting the sweep's notice a moment later. If it does not fire
      // (unreadable log / no stamp / no run since the submit) it does nothing
      // whatsoever and the sweep proceeds exactly as it did before.
      applyRunProcessedClear();
      applyResolvedSweep();
    }
  }

  // Backgrounding the PWA across a 9:00 AM run is the ordinary way to hit this:
  // the screen is left open, the run processes, and coming back shows claims
  // for players you already own. Re-check on return to the foreground — no
  // timer, no polling, and nothing at all unless the claims screen is up.
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible") return;
    if (!claimsOpen) return;
    checkMflHoldingsChanged();
    // Run-based clear FIRST, before the roster sweep below, for the same
    // reason as the two openClaimsScreen sites: it is the superset signal, so
    // going first means one plan write and one notice rather than the sweep's
    // narrower message being overwritten a moment later.
    //
    // Two passes on purpose. The synchronous one uses the waiver state already
    // in hand, which fixes the ordering relative to the roster sweep's async
    // reloadData() chain below (that chain cannot resolve before this line
    // runs). The second pass runs after a forced state refresh, which is what
    // actually matters here: "backgrounded across a 9:00 AM run" is precisely
    // the case where the cached last_run predates the run we are looking for.
    // The second pass is idempotent — if the first one cleared, the stamp it
    // nulled makes the second bail immediately.
    applyRunProcessedClear();
    // Gated on there actually being staged work, same reasoning (and same
    // gate) as the reloadData() call below: for a signed-in owner this
    // request bypasses the edge cache entirely, so each forced refresh costs
    // three MFL exports. With an empty board there is nothing a fresher
    // last_run could clear, so repeated app-switching would be hammering MFL
    // to reach a guaranteed no-op.
    if (M.waivers && M.waivers.fetchState && stagedCount()) {
      M.waivers.fetchState(true).then(function () {
        applyRunProcessedClear();
      }).catch(function () {});   // unreadable → leave the screen alone
    }
    // Roster data itself may be stale here — "backgrounded across a run" is
    // exactly the case where state.rosters predates that run, so a plain
    // sweepResolvedPicks() would be checking membership against a snapshot
    // from before the win and would miss it. Reload first, then sweep
    // against the fresh copy. Gated on there being staged picks worth
    // reconciling so a trivial tab-switch with nothing staged doesn't
    // trigger a full reload.
    if (M.actions && M.actions.reloadData && stagedCount()) {
      M.actions.reloadData().then(function () {
        applyResolvedSweep();
      }).catch(function () {}); // unreadable → leave the screen alone
    }
  });

  function bind(mount) {
    var search = document.getElementById("ups-m-players-search");
    if (search) {
      search.addEventListener("input", function (e) {
        var val = e.target.value;
        clearTimeout(view.debounceTimer);
        view.debounceTimer = setTimeout(function () {
          view.query = val;
          renderRoute();
          // Re-focus the input after re-render (DOM was replaced).
          var s = document.getElementById("ups-m-players-search");
          if (s) {
            s.focus();
            try { s.setSelectionRange(val.length, val.length); } catch (e) {}
          }
        }, 250);
      });
    }
    var chips = mount.querySelectorAll(".ups-m-pos-chip");
    for (var i = 0; i < chips.length; i++) {
      chips[i].addEventListener("click", function () {
        view.pos = this.getAttribute("data-pos");
        renderRoute();
      });
    }
    var sortSel = document.getElementById("ups-m-players-sort");
    if (sortSel) {
      sortSel.addEventListener("change", function () {
        var s = this.value;
        view.sort = s;
        // Lazy-fetch: /api/hot-cold is only ever hit once the owner actually
        // picks Most added / Most dropped — never from this view's default
        // render/boot path. fetchHotCold's own TTL + in-flight guard (app.js)
        // makes repeat picks within a few minutes free.
        if ((s === "hot" || s === "cold") && M.hotCold && M.hotCold.fetch) {
          M.hotCold.fetch().then(function () { renderRoute(); }).catch(function () {});
        }
        renderRoute();
      });
    }
    var winBtns = mount.querySelectorAll(".ups-m-period-btn[data-win]");
    for (var wj = 0; wj < winBtns.length; wj++) {
      winBtns[wj].addEventListener("click", function () {
        view.window = parseInt(this.getAttribute("data-win"), 10) || 0;
        renderRoute();
      });
    }
    var filterSel = document.getElementById("ups-m-players-filter");
    if (filterSel) {
      filterSel.addEventListener("change", function () {
        var v = this.value;
        if (v === "fa") { view.scope = "fa"; view.teamFilter = ""; }
        else if (v === "all") { view.scope = "all"; view.teamFilter = ""; }
        else if (v.indexOf("team:") === 0) { view.teamFilter = v.slice(5); view.scope = "all"; }
        renderRoute();
      });
    }
    var tradeBtns = mount.querySelectorAll(".ups-m-fa-trade");
    for (var t = 0; t < tradeBtns.length; t++) {
      tradeBtns[t].addEventListener("click", function (e) {
        e.stopPropagation();
        var tfid = this.getAttribute("data-fid");
        var tpid = this.getAttribute("data-pid");
        if (M.tradeView && M.tradeView.openBuilder) M.tradeView.openBuilder({ toFid: tfid, preGetPid: tpid });
        else M.route.navigate("#league/trade");
      });
    }
    // Waiver controls: Bid / Add on a row, and the Claims chip in the strip.
    var waiverBtns = mount.querySelectorAll('[data-act="waiver-bid"],[data-act="waiver-add"],[data-act="open-claims"]');
    for (var wI = 0; wI < waiverBtns.length; wI++) {
      waiverBtns[wI].addEventListener("click", function (e) {
        e.stopPropagation();
        var act = this.getAttribute("data-act");
        var wpid = this.getAttribute("data-pid");
        if (act === "waiver-bid") openBidFor(wpid);
        else if (act === "waiver-add") startFcfsAdd(wpid);
        else openClaimsScreen();
      });
    }
    var rows = mount.querySelectorAll(".ups-m-fa-row");
    for (var k = 0; k < rows.length; k++) {
      rows[k].addEventListener("click", function () {
        var pid = this.getAttribute("data-pid");
        if (pid && M.sheet) M.sheet.open(pid);
      });
    }
  }

  function renderRoute() { M.route.renderRoute(); }

  // MFL's YTD moves while games are being played; the copy on hand is read at
  // boot. Re-read it once it is over 5 minutes old, on entering this screen or
  // returning to the app. Re-render only when the numbers actually changed,
  // and never under an open sheet — the bid sheet, drop picker and claims
  // screen keep what they opened with, and a staged claim is never touched.
  var SCORES_MAX_AGE_MS = 5 * 60 * 1000;
  function onPlayersRoute() {
    return !!(M.route.currentRoute && String(M.route.currentRoute()).split("/")[0] === "players");
  }
  var scoresRefreshPending = false;
  function refreshScoresIfStale() {
    if (scoresRefreshPending || !DATA.refreshSeasonScoringIfStale || !onPlayersRoute()) return;
    scoresRefreshPending = true;
    DATA.refreshSeasonScoringIfStale(SCORES_MAX_AGE_MS).then(function (changed) {
      scoresRefreshPending = false;
      if (!changed || !onPlayersRoute()) return;
      if (document.getElementById("ups-m-bid-overlay") || document.getElementById("ups-m-drop-overlay") ||
          document.getElementById("ups-m-claims-overlay")) return;
      renderRoute();
    });
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") refreshScoresIfStale();
  });

  function render(mount, parts) {
    // Lazy + cached: projections and the season/selected windows are fetched
    // once each and re-render when they land. Both fetches carry their own
    // .catch inside M.lineupIntel, so nothing here is gated on them — a dead
    // worker just means no extra line and no window toggles.
    clampControls();   // this render's effective period + sort; the owner's choices are kept
    refreshScoresIfStale();
    // Season window only: the matchup line no longer follows the points period.
    if (M.lineupIntel) M.lineupIntel.load(0);
    var all = buildFreeAgents();
    var filtered = filterAndSort(all);
    // Those fetches re-render this view when they land, which can be mid-typing
    // — carry the search box's focus + caret across the rebuild so a stat load
    // doesn't eat a keystroke.
    // The input is re-emitted with value="{view.query}", but view.query only
    // catches up 250ms after the last keypress — so restoring focus+caret alone
    // silently reverts whatever is still in flight. Type "jefferson", let a
    // stat fetch land at ~1s, and the box snaps back to "" while staying
    // focused; the next keystroke then clears the pending debounce and the list
    // filters on the tail of the word. Carry the LIVE value across the rebuild
    // too, and only trust the caret if the value survived unchanged.
    var prevSearch = document.getElementById("ups-m-players-search");
    var hadFocus = !!(prevSearch && document.activeElement === prevSearch);
    var liveVal = prevSearch ? prevSearch.value : null;
    var caret = null;
    if (hadFocus) { try { caret = prevSearch.selectionStart; } catch (e) { caret = null; } }
    mount.innerHTML = renderToolbar() + renderRows(filtered);
    bind(mount);
    var nextSearch = document.getElementById("ups-m-players-search");
    if (nextSearch && liveVal != null && nextSearch.value !== liveVal) {
      nextSearch.value = liveVal;
    }
    if (hadFocus && nextSearch) {
      nextSearch.focus();
      if (caret != null) { try { nextSearch.setSelectionRange(caret, caret); } catch (e) {} }
    }
    // #players/claims — deep link from the Home waiver card.
    if (parts && parts[0] === "claims" && !document.getElementById("ups-m-claims-overlay")) {
      openClaimsScreen();
    }
  }

  M.route.registerView("players", render);
})();
