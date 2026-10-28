/* Player schedule (Front Office → Roster → Players → Schedule). Pure functions over ONE /api/fantasy-sos?season=<season>&v=2 answer.
   The same rules as Stats → Sched (#1270): DESCRIPTIVE. Each opponent carries what it has allowed to the player's position in the weeks
   already played ("allowed so far", through the answer's last counted week): MFL points per game, how that compares with usual, and its
   rank (adjusted; 1st = allowed the most). There is no easy/tough wording and no forecast: the 2019–2025 backtest found the old
   schedule ranking no better than chance. League weeks only (no NFL Week 18); byes are shown; missing data is said plainly.
   Attaches window.UPS_PLAYER_SCHEDULE and module.exports. No fetch, no DOM. */
(function (root) {
  "use strict";

  var POSITIONS = { QB: 1, RB: 1, WR: 1, TE: 1, DL: 1, LB: 1, DB: 1, PK: 1, PN: 1 };
  function up(v) { return String(v == null ? "" : v).trim().toUpperCase(); }
  function num(v) { var n = Number(v); return v != null && v !== "" && isFinite(n) ? n : null; }

  function endWeek(d) { return (d && d.season && Number(d.season.endWeek)) || 17; }
  // The first league week with a game still to finish; 0 when none is left or the season is not running (same rule as Stats → Sched).
  function nowWeek(d) {
    var s = (d && d.season) || {}, st = s.weeks || {};
    if (s.state !== "in_season") return 0;
    for (var w = 1; w <= endWeek(d); w++) if (st[w] !== "final") return w;
    return 0;
  }
  // The weeks to show. mode "next5" (default) = the next five league weeks, byes included; "rest" = through the last league week.
  // { weeks: [..], note: "" } — note says plainly why there are none (a finished season, or a season not yet started).
  function weekList(d, mode) {
    var end = endWeek(d), st = d && d.season ? d.season.state : "", from = nowWeek(d);
    if (st === "complete") return { weeks: [], note: "This season is complete: there are no games left to show." };
    if (!from) {
      if (st === "in_season") return { weeks: [], note: "Every league week is already final." };
      from = 1;                                              // not started: the schedule from Week 1
    }
    var to = mode === "rest" ? end : Math.min(end, from + 4), out = [];
    for (var w = from; w <= to; w++) out.push(w);
    return { weeks: out, note: "" };
  }
  function weeksLabel(a, b) { return a === b ? "Wk " + a : "Wks " + a + "–" + b; }
  // What the opponent numbers cover: the weeks the answer counted, or null when none have been played.
  function basis(d) {
    var used = (d && d.weeksUsed) || [];
    if (!used.length) return { through: null, label: "", none: true };
    return { through: used[used.length - 1], label: weeksLabel(used[0], used[used.length - 1]), none: false };
  }

  // The opponent's numbers at one position, or null when the answer has none for it.
  function allowed(d, opp, pos) {
    var c = d && d.teams && d.teams[up(opp)] && d.teams[up(opp)][pos];
    if (!c) return null;
    var pg = c.raw ? num(c.raw.perGame) : null, ratio = c.adj ? num(c.adj.ratio) : null;
    var rank = c.adj ? num(c.adj.rank) : null, of = c.adj ? num(c.adj.of) : null;
    if (pg == null && ratio == null && rank == null) return null;
    return { perGame: pg, ratio: ratio, rank: rank, of: of, games: c.raw ? num(c.raw.games) : null };
  }

  // One league week of one player: a game (opponent, home or away, kickoff, the opponent's numbers), a bye, or "no game listed".
  function cell(d, team, week, pos) {
    var list = (d && d.schedule && d.schedule[up(team)]) || null;
    if (!list) return { wk: week, kind: "noteam" };
    var g = list.filter(function (x) { return x && x.wk === week; })[0];
    if (!g) return { wk: week, kind: "none" };
    if (g.bye) return { wk: week, kind: "bye" };
    return { wk: week, kind: "game", opp: up(g.opp), home: !!g.home, kickoffMs: num(g.kickoff) ? num(g.kickoff) * 1000 : 0, status: g.status || "", allowed: allowed(d, g.opp, pos) };
  }
  // A player's rows. state: ok | no_team (no NFL team listed) | no_pos (position outside the nine) | no_sched (his team is not in the answer).
  function playerRows(d, player, weeks) {
    var team = up(player && player.nflTeam), pos = up(player && player.group);
    if (!team) return { state: "no_team", cells: [] };
    if (!POSITIONS[pos]) return { state: "no_pos", cells: [] };
    if (!(d && d.schedule && d.schedule[team])) return { state: "no_sched", cells: [] };
    return { state: "ok", pos: pos, team: team, cells: weeks.map(function (w) { return cell(d, team, w, pos); }) };
  }

  // ── Color. A week cell is colored by the NUMBER PRINTED IN IT: the opponent's "vs usual" % (rounded, as shown) at the player's position.
  // "more" = it has allowed MORE than usual (green), "less" = LESS (red); within ±9%, fewer than 3 games counted, or no number = neutral.
  // Restrained on purpose: a 10% gap and a minimum of games, never a ranking, never a forecast (Stats → Sched found the schedule ranking no
  // better than chance). The number is always shown, so color is never the only signal.
  // The Pts Agst rule (toneShrunk below: shrink the gap toward average by k games per position, color only if 8%+) is stricter: it colors
  // about 1 cell in 288 with a Week 1–5 answer and about 1 in 16 even after a full season. It is kept, identical to Stats → Sched, so the
  // choice is a one-line switch in tone() if Keith prefers it (a test keeps its table identical to site/m/views/stats.js FPA_COLOR_K).
  var COLOR_MIN_PCT = 10, COLOR_MIN_GAMES = 3;
  function tone(a) {
    if (!a || a.ratio == null || !(a.games >= COLOR_MIN_GAMES)) return "none";
    var p = Math.round((a.ratio - 1) * 100);
    return Math.abs(p) < COLOR_MIN_PCT ? "none" : (p > 0 ? "more" : "less");
  }
  var COLOR_K = { QB: 50, RB: 30, WR: 50, TE: 30, DL: 20, LB: 120, DB: 50, PK: 50, PN: 120 };
  var COLOR_MIN_GAP = 0.08;
  function toneShrunk(a, pos) {
    var k = COLOR_K[up(pos)];
    if (!a || !k || a.ratio == null || !(a.games > 0)) return "none";
    var gap = (a.games * a.ratio + k) / (a.games + k) - 1;
    return Math.abs(gap) < COLOR_MIN_GAP ? "none" : (gap > 0 ? "more" : "less");
  }
  // ── Text ──
  function ordinal(n) { var v = n % 100, s = ["th", "st", "nd", "rd"]; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
  function fix1(n) { return (Math.round(n * 10) / 10).toFixed(1); }
  function pct(r) { var p = Math.round((r - 1) * 100); return p === 0 ? "0%" : (p > 0 ? "+" : "−") + Math.abs(p) + "%"; }
  // "Sun 1:00p" in Eastern time (the league's clock); "" when the kickoff is unknown.
  function kickoffLabel(ms) {
    if (!(ms > 0)) return "";
    try {
      var p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(new Date(ms)), o = {};
      p.forEach(function (x) { o[x.type] = x.value; });
      return o.weekday + " " + o.hour + ":" + o.minute + (String(o.dayPeriod || "").toLowerCase().charAt(0) || "");
    } catch (e) { return ""; }
  }
  // The three parts of the opponent number: points per game, vs usual, and the rank. Each is "" when missing (never a zero).
  function allowedParts(a) {
    if (!a) return { pg: "", vs: "", rank: "" };
    return { pg: a.perGame != null ? fix1(a.perGame) + " per game" : "", vs: a.ratio != null ? pct(a.ratio) + " vs usual" : "",
      rank: a.rank != null && a.of != null ? ordinal(a.rank) + " of " + a.of : "" };
  }

  // The compact labels printed IN a week cell: "+22%" (vs usual, the prominent number), "28.2/g" (points allowed per game), "7th/32" (rank of 32,
  // 1st = allowed the most). Each is "" when the engine has no value (never a 0).
  function allowedCompact(a) {
    if (!a) return { pct: "", pg: "", rank: "" };
    return { pct: a.ratio != null ? pct(a.ratio) : "", pg: a.perGame != null ? fix1(a.perGame) + "/g" : "", rank: a.rank != null && a.of != null ? ordinal(a.rank) + "/" + a.of : "" };
  }
  // The full explanation behind a week cell, for the detail panel (tap or keyboard, not hover): rows of [label, value] plus the plain notes.
  // `d` is the one fantasy-sos answer; `cell` a game cell from playerRows(); `pos` the player's position group.
  function detail(d, cell, pos, playerName) {
    var b = basis(d), a = cell && cell.allowed, rows = [], notes = [];
    if (!cell || cell.kind !== "game") return { title: "", rows: [], notes: ["No game to describe."] };
    rows.push(["Opponent", (cell.home ? "Home vs " : "Away at ") + cell.opp]);
    var k = kickoffLabel(cell.kickoffMs);
    rows.push(["Kickoff", k ? k + " ET (Eastern time)" : "Not scheduled yet"]);
    var basisTxt = b.none ? "" : " (" + b.label + ")";
    if (!a || (a.perGame == null && a.ratio == null && a.rank == null)) {
      rows.push(["Allowed so far" + basisTxt, "No number yet for " + pos + "."]);
    } else {
      if (a.perGame != null) rows.push(["Points allowed per game" + basisTxt, fix1(a.perGame) + " to " + pos + "s"]);
      if (a.ratio != null) { var p = Math.round((a.ratio - 1) * 100); rows.push(["Versus usual", (p === 0 ? "About usual (0%)" : Math.abs(p) + "% " + (p > 0 ? "above" : "below") + " usual") + " (" + pct(a.ratio) + ")"]); }
      if (a.rank != null && a.of != null) rows.push(["Rank among " + a.of + " teams", ordinal(a.rank) + " (1st = has allowed the most to " + pos + "s)"]);
      if (a.games != null) rows.push(["Games counted", String(a.games)]);
      var t = tone(a);
      notes.push(t === "more" ? "Green: this opponent has allowed 10% or more above usual to " + pos + "s." : t === "less" ? "Red: this opponent has allowed 10% or more below usual to " + pos + "s."
        : "No color: within 9% of usual, fewer than " + COLOR_MIN_GAMES + " games counted, or no number.");
    }
    notes.push("This describes past points allowed in games already played. It is not a forecast.");
    return { title: "Wk " + cell.wk + ": " + (cell.home ? "" : "@ ") + cell.opp + (playerName ? " · " + playerName : ""), rows: rows, notes: notes };
  }

  var api = { allowedCompact: allowedCompact, detail: detail, POSITIONS: POSITIONS, endWeek: endWeek, nowWeek: nowWeek, weekList: weekList, weeksLabel: weeksLabel, basis: basis, allowed: allowed,
    COLOR_K: COLOR_K, COLOR_MIN_GAP: COLOR_MIN_GAP, COLOR_MIN_PCT: COLOR_MIN_PCT, COLOR_MIN_GAMES: COLOR_MIN_GAMES, tone: tone, toneShrunk: toneShrunk, cell: cell, playerRows: playerRows, ordinal: ordinal, pct: pct, kickoffLabel: kickoffLabel, allowedParts: allowedParts };
  root.UPS_PLAYER_SCHEDULE = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : this);
