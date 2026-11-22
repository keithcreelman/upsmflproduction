/* UPS 2027 beta (PR B): when is a game, a week and a season figure "complete"? Pure functions: no network, no storage, no DOM.

   Completion is judged per GAME, from two sources that must agree:
     - the NFL schedule (per matchup: seconds remaining and both teams' scores), and
     - the Worker's per-team game status for the lineup week ("final" / "scheduled").
   The Worker answer's `latestFinalWeek` is NEVER used: it means "the latest week with at least one final game" (at the recorded Thursday it said Week 11
   while 1 of 13 Week 11 games was final). `lastCompleteWeek` (every game final) is used only as a second opinion for a past week.
   Anything missing, unparsable or in disagreement is "unknown": no "final" claim is made. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.UPS2027 = root.UPS2027 || {}; root.UPS2027.complete = api; }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function asArray(v) { return Array.isArray(v) ? v : v == null || v === "" ? [] : [v]; }
  function isInt(n) { return typeof n === "number" && isFinite(n) && Math.floor(n) === n; }
  function hasScore(s) { return s != null && !(typeof s === "string" && s.trim() === "") && isFinite(Number(s)); }

  // The schedule export for one week -> [{ clubs: [a, b], secondsRemaining, scored, final }]. null when the answer is not the expected shape.
  function parseSchedule(j, week) {
    var root = j && j.nflSchedule;
    if (!root || typeof root !== "object") return null;
    if (week != null && root.week != null && String(root.week).trim() !== String(week)) return null;   // an answer for another week is not this week's schedule
    var ms = asArray(root.matchup), out = [];
    for (var i = 0; i < ms.length; i++) {
      var m = ms[i], tm = asArray(m && m.team);
      if (!m || tm.length !== 2 || !tm[0] || !tm[1] || typeof tm[0] !== "object" || typeof tm[1] !== "object") return null;   // a missing or malformed team is an unexpected shape, never a crash
      var secs = m.gameSecondsRemaining == null || String(m.gameSecondsRemaining).trim() === "" ? null : Number(m.gameSecondsRemaining);
      var scored = hasScore(tm[0].score) && hasScore(tm[1].score);
      out.push({ clubs: [String(tm[0].id || "").toUpperCase(), String(tm[1].id || "").toUpperCase()], secondsRemaining: isFinite(secs) ? secs : null, scored: scored, final: secs === 0 && scored });
    }
    return out;
  }

  // One game's state from the schedule and (for the lineup week) the Worker's status for a club in it.
  // -> "final" | "live" | "scheduled" | "unknown"
  function gameState(game, status) {
    if (!game || game.secondsRemaining == null) return "unknown";
    var st = status == null ? null : String(status).toLowerCase();
    if (game.final) return st === null || st === "final" ? "final" : "unknown";           // the schedule says final: the status may not contradict it
    if (st === "final") return "unknown";                                                  // the status says final and the schedule does not
    if (game.secondsRemaining > 0 && (game.scored || game.secondsRemaining < 3600)) return "live";
    if (game.secondsRemaining > 0) return st === null || st === "scheduled" ? "scheduled" : "unknown";
    return "unknown";                                                                      // 0 seconds but no scores: not established
  }
  function gameOf(games, club) {
    var c = String(club || "").toUpperCase();
    for (var i = 0; i < games.length; i++) if (games[i].clubs[0] === c || games[i].clubs[1] === c) return games[i];
    return null;
  }

  // The Worker's status for a club when statuses are expected (the lineup week): a club with no entry is "missing", which is never agreement.
  function statusOf(byClub, club) { return Object.prototype.hasOwnProperty.call(byClub, club) ? byClub[club] : "missing"; }
  // Every game of the week is final by the schedule (and, when given, the per-club status agrees). An empty or missing schedule is not complete.
  function weekComplete(games, statusByClub) {
    if (!Array.isArray(games) || !games.length) return false;
    for (var i = 0; i < games.length; i++) {
      var g = games[i], a = statusByClub ? statusOf(statusByClub, g.clubs[0]) : null, b = statusByClub ? statusOf(statusByClub, g.clubs[1]) : null;
      if (gameState(g, a) !== "final" || gameState(g, b) !== "final") return false;
    }
    return true;
  }

  // The week every season figure runs through. lastComplete: the Worker's `lastCompleteWeek`; schedules: { week: games | null (the read failed) | undefined (not read) };
  // statusByClub: the Worker's per-team statuses for the lineup week (only used when that week is examined). Never reads latestFinalWeek.
  // -> { state: "ok", week } | { state: "none" } (no week is complete yet) | { state: "unavailable", need } (the schedule of `need` is missing) | { state: "conflict" }
  function cutoffWeek(lastComplete, schedules, statusByClub, lineupWeek) {
    if (!isInt(lastComplete) || lastComplete < 1) return { state: "none" };
    var w = lastComplete, tried = 0;
    while (w >= 1 && tried < 2) {
      var g = schedules ? schedules[w] : undefined;
      if (g === undefined || g === null) return { state: "unavailable", need: w };
      if (weekComplete(g, w === lineupWeek ? statusByClub : null)) return { state: "ok", week: w };
      w--; tried++;
    }
    return w < 1 ? { state: "none" } : { state: "conflict" };
  }

  // ---------- the Live -> Final · updating -> regular display handoff ----------
  // p: { game: "final"|"live"|"scheduled"|"unknown", score: number|null (the recorded score of the unfinished or just-finished game),
  //      cutoff: N (the week the regular display runs through), week: the lineup week, weekAllFinal: bool,
  //      read: { state: "ok"|"loading"|"error", at } the weekly read for `week`, completeSeenAt, tries: { startedAt, now, failed } }
  // -> { state, chip } where chip is the text drawn on the right of the row ("" for none) and state is one of
  //    live | final_updating | final_pending | final_failed | included | unsure | none
  var QUIET_MS = 30 * 60 * 1000;
  function handoff(p) {
    var sc = p.score == null ? "" : " " + (Math.round(p.score * 10) / 10).toFixed(1);
    if (isInt(p.cutoff) && isInt(p.week) && p.cutoff >= p.week) return { state: "included", chip: "" };       // the regular display includes the week: the temporary display is gone
    if (p.game === "live") return { state: "live", chip: "Live" + (sc ? " ·" + sc : "") };
    if (p.game === "final") {
      var t = p.tries || {};
      if (p.weekAllFinal && p.read && p.read.state === "error") return { state: "final_failed", chip: "Final · not yet in season totals", retry: true };
      if (p.weekAllFinal && t.startedAt != null && t.now != null && t.now - t.startedAt >= QUIET_MS) return { state: "final_pending", chip: "Final · not yet in season totals", retry: true };
      return { state: "final_updating", chip: "Final · updating" + sc };
    }
    if (p.game === "unknown") return p.score != null ? { state: "unsure", chip: "Live ·" + sc } : { state: "unsure", chip: "" };   // no "Final" claim without agreeing evidence
    return { state: "none", chip: "" };
  }
  // Is an answer usable for the handoff? It must be from the current load and read after the preview first saw the game (or week) final.
  function answerFresh(a) { return !!a && a.gen === a.currentGen && isInt(a.readAt) && isInt(a.firstSeenFinalAt) && a.readAt >= a.firstSeenFinalAt; }

  return { parseSchedule: parseSchedule, gameState: gameState, gameOf: gameOf, weekComplete: weekComplete, cutoffWeek: cutoffWeek, handoff: handoff, answerFresh: answerFresh, QUIET_MS: QUIET_MS };
});
