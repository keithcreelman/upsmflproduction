/* Season scoring — MFL's OWN league-scored player points, through the last
   COMPLETED week. Pure: no fetch, no DOM. app.js feeds it two reads it makes at
   boot and the Players market / player sheet read the result.

     playerScores&W=ALL    every player's score for every week, under THIS
                           league's scoring rules, in one MFL export
                           (playerScoresAllWeeks.playerScores[] = one block per
                           week). The same numbers MFL's own W=YTD sums.
     /api/current-lineup-week   { week, source } from the worker's
                           resolveCurrentLineupWeek() — the one definition of
                           "which week is being played" the whole app uses.

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

   RULES (each one is a decision, not an accident):
   - A week counts only once it is COMPLETE. completedWeekFrom() mirrors the
     worker's deriveCompletedWeekFromLineupResolution (worker/src/index.js) —
     a live_scoring* source means `week - 1` is done; anything else is null,
     never a guess. Scores already posted for a later, in-progress week are
     left OUT of every total and reported in excludedWeeks so the UI can say so.
   - When the completed week can't be resolved, posted current-season scores
     are unavailable: a posted score may belong to a game still being played.
     If the MFL export loaded but has no posted score at all, throughWeek=0
     lets the market show the previous season with its year clearly labelled.
   - games = weeks MFL posted a score row for the player (0.0 included) — MFL's
     own AVG denominator (W=AVG == W=YTD / rows, verified on all 1,371 players
     2026-10-01). A week with no row (bye, not active) is not a game.
   - Zero and negative weeks are real scores and count, in points AND games.
   - A blank score is "no score", never 0.
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
    return { known: false, reason: reason, throughWeek: 0, finalized: false,
             includedWeeks: [], excludedWeeks: [], byPid: {},
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
        // With no completed-week authority, fail closed on that evidence.
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
    if (completed === null && hasPostedScore) return unknown("week_unresolved");
    var maxScored = scored.length ? scored[scored.length - 1] : 0;
    var through = completed === null ? 0 : Math.min(completed, maxScored);
    var included = scored.filter(function (w) { return w <= through; });
    var excluded = scored.filter(function (w) { return w > through; });
    var byPid = aggregate(perWeek, included);
    var windows = {};
    return {
      known: true,
      reason: completed === null ? "no_scores_posted" : "",
      throughWeek: through,
      finalized: completed !== null,
      includedWeeks: included,
      excludedWeeks: excluded,
      duplicateRows: duplicateRows,
      byPid: byPid,
      // Last-N COMPLETED weeks ending at throughWeek — same weeks, same rules,
      // same source as the season total, so YTD and L4 can never disagree on
      // what a week was worth.
      windowFor: function (n) {
        n = parseInt(n, 10) || 0;
        if (n <= 0) return byPid;
        if (windows[n]) return windows[n];
        var lo = through - n + 1;
        windows[n] = aggregate(perWeek, included.filter(function (w) { return w >= lo; }));
        return windows[n];
      }
    };
  }

  // Positional rank by PPG inside each group (groupOf(pid) → "QB"|"RB"|…|"" to
  // skip). Only players with at least one game are ranked; ties break on total
  // points, then id, so the order is stable between renders.
  function rankMap(stats, groupOf) {
    var buckets = {};
    Object.keys(stats || {}).forEach(function (pid) {
      var r = stats[pid];
      if (!r || !(r.games > 0)) return;
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
