/* Season scoring — MFL's OWN league-scored player points. Pure: no fetch, no
   DOM. app.js feeds it two reads it makes at boot and the Players market /
   player sheet read the result.

     playerScores&W=ALL    every player's score for every week, under THIS
                           league's scoring rules, in one MFL export
                           (playerScoresAllWeeks.playerScores[] = one block per
                           week). Summed over every posted week it IS MFL's
                           W=YTD, and YTD ÷ posted rows IS MFL's W=AVG —
                           verified on all 1,371 players 2026-10-02, Week 4
                           Thursday included.
     /api/current-lineup-week   { week, source } from the worker's
                           resolveCurrentLineupWeek() — which weeks are FINAL.
                           Only the last-N windows depend on it.

   WHY THIS EXISTS (2026-10-01). The market's "YTD" came from the worker's
   /api/advanced-stats-leaderboard `mfl_points`, which is SUM(D1 src_weekly.score).
   On 2026-09-29 src_weekly held only players who sat on an ACTIVE UPS roster
   that week (the standings sync DELETEs the season and rewrites it from
   weeklyResults, which lists no free agents and no taxi squad), so 241 of the
   481 players the leaderboard returned were wrong — every free agent the owner
   was shopping for read 0.0 (Chase McLaughlin: shown 0.0, MFL 42.1; Matthew
   Golden: 0.0 vs 50.7), and anyone added mid-season showed only their weeks on
   a UPS roster (Darren Waller: 13.2 vs 39.8). A week-3 Elias correction was also
   still missing (Fred Warner: 32.5 vs MFL's 32.0). The refresh path is repaired
   separately (pipelines/etl/scripts/sync_live_season_from_mfl_to_d1.py); this
   reads the primary source so the bid screen can't lag MFL by an ETL hop.

   SEASON = MFL's YTD, LIVE WEEK INCLUDED (Keith 2026-10-02). The first version
   counted completed weeks only, so after Thursday night of Week 4 the 76
   players from PIT–CLE showed their Wk 1–3 total while MFL's own YTD already
   had the game in it (Andre Szmyt 27.7 vs MFL 40.7). "Season" now sums every
   week MFL has posted a score for, exactly like W=YTD, and says when a week is
   still being played. Finalized-week data is a separate thing with its own
   label: the last-N windows ("Last 2 wks · Wks 2–3 · final").

   RULES (each one is a decision, not an accident):
   - byPid / seasonWeeks: every week with a posted score, the live one too.
     Needs no completed-week authority — it is MFL's number either way.
   - finalWeeks / windowFor(n>0): completed weeks only. completedWeekFrom()
     mirrors the worker's deriveCompletedWeekFromLineupResolution
     (worker/src/index.js) — a live_scoring* source means `week - 1` is done;
     anything else is null, never a guess. When it is null, finalKnown is
     false and the windows are empty: no week is called final on a guess.
   - liveWeeks: posted weeks after the last final one (a week in progress).
   - If the MFL export loaded but has no posted score at all, seasonWeeks is
     empty and reason "no_scores_posted" lets the market show the previous
     season with its year clearly labelled. Posted values that can't be read
     are NOT "no scores": that fails closed (reason "unreadable_scores").
   - games = weeks MFL posted a score row for the player (0.0 included) — MFL's
     own AVG denominator. A week with no row (bye, not active, hasn't played
     yet this week) is not a game.
   - Zero and negative weeks are real scores and count, in points AND games.
   - A blank score is "no score", never 0.
   - A PPG RANK needs a minimum of MFL wks — rankMinimum(), below. Every
     player's actual PPG is still reported; only the "#N" is withheld.
*/
(function () {
  "use strict";

  function asArray(x) { return x == null ? [] : (Array.isArray(x) ? x : [x]); }
  function num(v) {
    if (v == null) return null;
    var s = String(v).trim();
    if (s === "") return null;
    var n = Number(s);
    return isFinite(n) ? n : null;
  }
  function round1(n) { return Math.round(n * 10) / 10; }

  // Mirror of worker deriveCompletedWeekFromLineupResolution. Keep in step.
  function completedWeekFrom(resolution) {
    if (!resolution) return null;
    if (resolution.source !== "live_scoring_week_complete" && resolution.source !== "live_scoring") return null;
    var wk = Number(resolution.week);
    if (!isFinite(wk)) return null;
    var c = wk - 1;
    return c >= 0 ? c : null;
  }

  function aggregate(perWeek, weeks) {
    var out = {};
    weeks.forEach(function (w) {
      var m = perWeek[w] || {};
      Object.keys(m).forEach(function (pid) {
        var row = out[pid] || (out[pid] = { pts: 0, games: 0, ppg: null, weeks: {} });
        row.pts += m[pid];
        row.games += 1;
        row.weeks[w] = m[pid];
      });
    });
    Object.keys(out).forEach(function (pid) {
      var r = out[pid];
      r.pts = round1(r.pts);
      r.ppg = r.games > 0 ? r.pts / r.games : null;
    });
    return out;
  }

  function unknown(reason) {
    return { known: false, reason: reason, latestWeek: 0, seasonWeeks: [],
             finalKnown: false, finalThrough: 0, finalWeeks: [], liveWeeks: [], byPid: {},
             windowFor: function () { return {}; } };
  }

  // payload: the playerScores&W=ALL JSON. opts: { completedWeek: number|null }.
  function build(payload, opts) {
    opts = opts || {};
    if (payload && payload.error) return unknown("mfl_error");
    var root = payload && payload.playerScoresAllWeeks;
    if (!root || typeof root !== "object" || Array.isArray(root)) return unknown("unavailable");
    var completed = (typeof opts.completedWeek === "number" && isFinite(opts.completedWeek) && opts.completedWeek >= 0)
      ? opts.completedWeek : null;
    var perWeek = {}, scored = [], duplicateRows = 0, hasPostedScore = false;
    asArray(root.playerScores).forEach(function (block) {
      var w = parseInt(block && block.week, 10);
      if (!(w >= 1)) return;
      var m = perWeek[w] || {}, any = false;
      asArray(block.playerScore).forEach(function (s) {
        if (!s) return;
        // A nonblank value is evidence that THIS season has started scoring,
        // even if MFL sent a value we cannot parse or a row without an ID.
        if (s.score != null && String(s.score).trim() !== "") hasPostedScore = true;
        if (!s.id) return;
        var n = num(s.score);
        if (n === null) return;
        var pid = String(s.id);
        if (Object.prototype.hasOwnProperty.call(m, pid)) { duplicateRows++; return; }
        m[pid] = n;
        any = true;
      });
      if (any) { perWeek[w] = m; if (scored.indexOf(w) === -1) scored.push(w); }
    });
    scored.sort(function (a, b) { return a - b; });
    // Scores were posted but none could be read: the season HAS started, so
    // falling back to last season would be a wrong answer, not a missing one.
    if (hasPostedScore && !scored.length) return unknown("unreadable_scores");
    var latest = scored.length ? scored[scored.length - 1] : 0;
    var finalKnown = completed !== null;
    var finalThrough = finalKnown ? Math.min(completed, latest) : 0;
    var finalWeeks = finalKnown ? scored.filter(function (w) { return w <= finalThrough; }) : [];
    var liveWeeks = finalKnown ? scored.filter(function (w) { return w > finalThrough; }) : [];
    var byPid = aggregate(perWeek, scored);
    var windows = {};
    return {
      known: true,
      reason: !scored.length ? "no_scores_posted" : (finalKnown ? "" : "week_unresolved"),
      latestWeek: latest,
      seasonWeeks: scored,
      finalKnown: finalKnown,
      finalThrough: finalThrough,
      finalWeeks: finalWeeks,
      liveWeeks: liveWeeks,
      duplicateRows: duplicateRows,
      // MINIMUM MFL WKS FOR A PPG RANK (Keith 2026-10-02). A PPG built on one
      // week is a real number but not a rank: Case Keenum read "#3 QB" off a
      // single 31.5-point start, Brock Bowers "#1 TE" off one game.
      //   n <= 0 (Season): half the FINAL weeks, rounded up. A week still
      //          being played counts toward a player's MFL wks but not toward
      //          the bar, so Thursday night can't raise it for everyone.
      //   n > 0  (Last n wks): half the window — L2 1, L4 2, L6 3.
      // MFL's posted 0.0 weeks count, as in its own AVG; a bye is a week with
      // no row, so it counts against the player like any other missed week.
      // Never below 1. No week confirmed final → every posted week is the
      // base instead: stricter, never looser.
      rankMinimum: function (n) {
        n = parseInt(n, 10) || 0;
        var base = n > 0 ? n : (finalKnown ? finalWeeks.length : scored.length);
        return Math.max(1, Math.ceil(base / 2));
      },
      // MFL's W=YTD / W=AVG: every posted week, a week in progress included.
      byPid: byPid,
      // n <= 0: the season (byPid). n > 0: the last n FINAL weeks ending at
      // finalThrough — same rows, same rules, same source as the season, minus
      // any week still being played. Empty when no week is known to be final.
      windowFor: function (n) {
        n = parseInt(n, 10) || 0;
        if (n <= 0) return byPid;
        if (!finalKnown) return {};
        if (windows[n]) return windows[n];
        var lo = finalThrough - n + 1;
        windows[n] = aggregate(perWeek, finalWeeks.filter(function (w) { return w >= lo; }));
        return windows[n];
      }
    };
  }

  // Positional rank by PPG inside each group (groupOf(pid) → "QB"|"RB"|…|"" to
  // skip). Only players with at least minGames MFL wks are ranked (default 1;
  // callers pass the scoring's rankMinimum() for the period). A player below
  // it is left out entirely, so he neither holds a rank nor pushes anyone
  // else's down. Ties break on total points, then id, so the order is stable
  // between renders.
  function rankMap(stats, groupOf, minGames) {
    var min = Math.max(1, parseInt(minGames, 10) || 1);
    var buckets = {};
    Object.keys(stats || {}).forEach(function (pid) {
      var r = stats[pid];
      if (!r || !(r.games >= min)) return;
      var g = groupOf ? groupOf(pid) : "";
      if (!g) return;
      (buckets[g] = buckets[g] || []).push({ pid: pid, ppg: r.ppg, pts: r.pts });
    });
    var out = {};
    Object.keys(buckets).forEach(function (g) {
      buckets[g].sort(function (a, b) {
        return (b.ppg - a.ppg) || (b.pts - a.pts) || (a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : 0);
      });
      buckets[g].forEach(function (x, i) { out[x.pid] = { rank: i + 1, group: g }; });
    });
    return out;
  }

  // "Wks 1–3" / "Wk 1" — the span a total covers, for labels.
  function weeksLabel(weeks) {
    if (!weeks || !weeks.length) return "";
    var a = weeks[0], b = weeks[weeks.length - 1];
    return a === b ? ("Wk " + a) : ("Wks " + a + "–" + b);
  }

  window.UPS_MOBILE_SEASON_SCORING = {
    build: build,
    completedWeekFrom: completedWeekFrom,
    rankMap: rankMap,
    weeksLabel: weeksLabel
  };
})();
