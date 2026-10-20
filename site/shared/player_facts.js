/* Player facts — the facts a desktop player card shows, decided the way the
   released phone sheet decides them (site/m/player_sheet.js, #1311 injury
   chip, season points from MFL's own scoring). Desktop lays them out its own
   way; it may show more, never something different (#1338).

   Pure: no fetch, no DOM. Callers pass the reads they already have:
     scoring  UPS_MOBILE_SEASON_SCORING.build(playerScores W=ALL, …) result,
              plus .season and .fetchedAt (ms) set by the caller
     groupOf  pid → lineup group ("QB" … "DB", "" to skip) — the ranking
              universe is every player MFL scored, rostered or not
     read     one /api/player-status read for UPSInjuryStatus.resolve
   Plain script; attaches window.UPS_PLAYER_FACTS.
*/
(function (root) {
  "use strict";

  function str(v) { return v == null ? "" : String(v).trim(); }
  function fmt1(v) { return (Math.round((Number(v) || 0) * 10) / 10).toFixed(1); }
  // "9:38 AM" (viewer's clock) for a read time; "" when unknown.
  function clockLabel(ms) {
    if (!(ms > 0)) return "";
    var d = new Date(ms); if (isNaN(d.getTime())) return "";
    var h = d.getHours(), m = d.getMinutes();
    return ((h % 12) || 12) + ":" + (m < 10 ? "0" : "") + m + " " + (h < 12 ? "AM" : "PM");
  }

  var rankMemo = { ss: null, n: null, map: null };
  function rankMapFor(ss, groupOf, n) {
    var SS = root.UPS_MOBILE_SEASON_SCORING;
    if (!SS || !ss || !ss.known) return {};
    n = n || 0;
    if (rankMemo.ss === ss && rankMemo.n === n && rankMemo.map) return rankMemo.map;
    var min = ss.rankMinimum ? ss.rankMinimum(n) : 1;
    rankMemo = { ss: ss, n: n, map: SS.rankMap(ss.windowFor(n), groupOf, min) };
    return rankMemo.map;
  }

  /* basis(ss) → { ok, warn, text } — the line under the numbers, word for word the phone's
     ("Actual 2026 MFL points, UPS scoring · Wks 1–7 · Wk 7 in progress · Rank needs 4+ MFL wks · MFL read 9:38 AM").
     Never an earlier season's points as this season's (Keith 2026-10-12). */
  function basis(ss) {
    var SS = root.UPS_MOBILE_SEASON_SCORING;
    var yr = str(ss && ss.season);
    if (ss && (ss.reason === "season_mismatch" || ss.reason === "season_unverified")) return { ok: false, warn: true, text: "Points unavailable: MFL’s scores aren’t marked as " + yr + ", so none are shown." };
    if (!SS || !ss || !ss.known) return { ok: false, warn: true, text: "Points unavailable: MFL’s scoring couldn’t be read, so no points or ranks are shown." };
    if (!ss.seasonWeeks || !ss.seasonWeeks.length) return { ok: false, warn: false, text: "No " + yr + " MFL scores yet." };
    var min = ss.rankMinimum ? ss.rankMinimum(0) : 1;
    var at = clockLabel(ss.fetchedAt);
    return { ok: true, warn: false, text: "Actual " + yr + " MFL points, UPS scoring · " + SS.weeksLabel(ss.seasonWeeks) +
      (ss.liveWeeks.length ? " · Wk " + ss.liveWeeks.join(", ") + " in progress" : ss.finalKnown ? " (final)" : "") +
      " · Rank needs " + min + "+ MFL wk" + (min === 1 ? "" : "s") + (at ? " · MFL read " + at : "") };
  }

  /* season(ss, pid, groupOf, opts) → null, or
       { pts, games, ppg (null with no MFL week), rank (number|null), rankLabel ("#4 QB" / "unranked" / "—"),
         weeks ("Wks 1–7"), group, last: { n, pts, games, ppg, rank, weeks } | null }
     opts.last = n for a last-n-FINAL-weeks window (null when no week is confirmed final). */
  function season(ss, pid, groupOf, opts) {
    opts = opts || {};
    var SS = root.UPS_MOBILE_SEASON_SCORING;
    if (!pid || !SS || !ss || !ss.known || !ss.seasonWeeks || !ss.seasonWeeks.length) return null;
    pid = String(pid);
    var g = groupOf ? groupOf(pid) : "";
    var st = ss.byPid[pid];
    var rk = rankMapFor(ss, groupOf, 0)[pid];
    var out = {
      pts: st ? st.pts : 0, games: st ? st.games : 0, ppg: st && st.games > 0 ? st.ppg : null,
      rank: rk ? rk.rank : null, group: g,
      rankLabel: rk ? "#" + rk.rank + (g ? " " + g : "") : (st && st.games > 0 ? "unranked" : "—"),
      weeks: SS.weeksLabel(ss.seasonWeeks), last: null
    };
    var n = parseInt(opts.last, 10) || 0;
    if (n > 0 && ss.finalKnown) {
      var w = ss.windowFor(n)[pid];
      var lr = rankMapFor(ss, groupOf, n)[pid];
      var lo = ss.finalThrough - n + 1;
      out.last = { n: n, pts: w ? w.pts : 0, games: w ? w.games : 0, ppg: w && w.games > 0 ? w.ppg : null,
        rank: lr ? lr.rank : null, weeks: SS.weeksLabel(ss.finalWeeks.filter(function (x) { return x >= lo; })) };
    }
    return out;
  }

  // The injury chip + the red disagreement box, as the shared resolver decides (#1311).
  function injury(read, pid, team, fallback) {
    var IS = root.UPSInjuryStatus;
    if (!IS) return { chips: [], warning: null, lines: [], disagree: false, label: "" };
    return IS.resolve(read, pid, team, { fallback: fallback || null });
  }
  // A raw MFL injuries designation → the resolver's fallback shape (this page's own read).
  var GAME = { OUT: "Out", DOUBTFUL: "Doubtful", QUESTIONABLE: "Questionable" };
  var ROSTER = { "IR": ["IR", "Injured reserve"], "IR-R": ["IR", "Injured reserve – designated to return"], "IR-PUP": ["PUP", "Physically unable to perform"],
    "IR-NFI": ["NFI", "Non-football injury list"], "SUSPENDED": ["SUSP", "Suspended"], "HOLDOUT": ["HOLD", "Holdout"], "RETIRED": ["RET", "Retired"],
    "INJURED RESERVE": ["IR", "Injured reserve"] };
  function fallbackFromMfl(rawStatus, details) {
    var tok = str(rawStatus).toUpperCase();
    if (!tok) return null;
    if (GAME[tok]) return { mfl: { status: GAME[tok], details: str(details) || null } };
    if (ROSTER[tok]) return { roster: { chip: ROSTER[tok][0], label: ROSTER[tok][1], detail: str(details) || null } };
    return null;
  }

  // Years remaining as owners read it: MFL contractYear 0 = "Expired", never the contract's length.
  function yearsLeftText(contractYear) {
    var n = parseInt(contractYear, 10);
    if (!(n >= 0)) return "—";
    if (n === 0) return "Expired";
    return n + (n === 1 ? " yr left" : " yrs left");
  }

  // Who owns a player, the phone's rule (app.js rosterOwnership): "free" only when EVERY franchise's
  // roster was read; a failed read is "unknown", never "free agent" or "retired".
  function ownership(rosterTeams, pid, franchiseIds) {
    pid = String(pid || "");
    var teams = rosterTeams || [];
    var seen = {};
    for (var i = 0; i < teams.length; i++) {
      var t = teams[i] || {};
      var fid = str(t.fid || t.franchise_id || t.id);
      var players = t.players || t.player || [];
      if (players.length) seen[fid] = 1;
      for (var j = 0; j < players.length; j++) {
        var p = players[j] || {};
        if (String(p.id || p.pid || p.player_id) === pid) return { known: true, free: false, fid: fid };
      }
    }
    var all = franchiseIds || [];
    var complete = all.length > 0 && all.every(function (f) { return seen[str(f)]; });
    return complete ? { known: true, free: true, fid: "" } : { known: false, free: false, fid: "" };
  }

  function safeHttpUrl(u) {
    var s = str(u);
    return /^https?:\/\//i.test(s) ? s : "";
  }

  // HTML for one chip / the warning box (callers pass their own escape function).
  function chipHtml(res, esc, cls) {
    if (!res || !res.chips || !res.chips.length) return "";
    var c = res.chips[0];
    return '<span class="' + (cls || "upf-inj") + " upf-inj-" + esc(c.cls) + '" title="' + esc(c.title) + '">' + esc(c.t) + "</span>";
  }
  function warningHtml(res, esc) {
    if (!res || !res.warning) return "";
    return '<div class="upf-inj-warning" role="note"><strong>' + esc(res.warning.title) + "</strong>" +
      res.warning.lines.map(function (l) { return "<div>" + esc(l) + "</div>"; }).join("") + "</div>";
  }

  root.UPS_PLAYER_FACTS = {
    basis: basis, season: season, rankMapFor: rankMapFor, injury: injury, fallbackFromMfl: fallbackFromMfl,
    yearsLeftText: yearsLeftText, ownership: ownership, safeHttpUrl: safeHttpUrl, chipHtml: chipHtml,
    warningHtml: warningHtml, clockLabel: clockLabel, fmt1: fmt1
  };
})(typeof window !== "undefined" ? window : this);
