/* UPS 2027 Preview: club-history evidence for the Performance screen. Plain script (browser) and CommonJS (tests).
   Pure: no network, no DOM, no clock. ES5 only. Rules: owner-approved implementation scope (U1, U2, F1 to F4).

   UPS2027.clubhist.evaluate(input) -> { state: "ok"|"unavailable",
       reason: null|"absent"|"malformed"|"past_season"|"context_failed"|"no_history"|"crosswalk_failed"|"crosswalk_suspect"|"stale",
       cutoff: N|null, latestFinal: L, gap: g|null, stripWeeks: [L-3..L within 1..L],
       banner: { text, kind: "through"|"stale"|"unavailable", reason? }, rows: { id: row } }
     input: { through, latestFinal, hist (the Worker's teamHistory* fields, or null), clubs: {id: "KCC"}, byeOf: {club: week},
              season: {id: {total, games}} (through latestFinal; an object without the id = no scores this season; null = unavailable),
              scores: {week: {id: number}} (loaded weeks only), ids: [...],
              newerFinal?: { complete: bool, clubs: {CLUB: bool} }  only matters for a week above the cutoff (gap 1): the Worker's season
                total counts a game only when it is FINAL. complete = that week is fully over; else clubs[club] = that club's game is final }
     hist must carry teamHistoryFirst {id: firstWeek 1..through} when state is "ok" (else "malformed"): a no-change player's weeks
     before his first weekly row are unknown identity and opportunity.
     row: { seasonAvg, scoredGames, seasonThrough,            season figures through the cutoff (an included newer score is taken
                                                              back out); seasonThrough = latestFinal when that cannot be settled
            strip: [{ week, kind: "score"|"none"|"bye"|"newer"|"live"|"unloaded", score, loaded, byeByCandidates? }],
              "live" = latest final week L, newerFinal.complete === false and his club's game not final: score carried, counted nowhere
            range: { lo, hi, fromWeek, toWeek, n }|null,       recorded scores in loaded strip weeks up to the cutoff
            teamGames: { known, of, text },                    "of" only when every week 1..cutoff has an established game/bye
            coverage: [{ fromWeek, toWeek, identity, opportunity, grade, note }],
            window: { weeks, scoredCount }|null,   the last 3 COMPLETED team games up to the cutoff: byes and live games skipped, a completed game
                                                   with no score stays a gap (it keeps its slot; Recent needs >= 2 recorded scores in it) recent, earlier, difference, recentN, earlierN   (raw, unrounded)
            cmp: { state: "shown"|"withheld", reason, text, week? },
            cls: "changed"|"nochange"|"missing"|"conflict"|"none"|"unavailable" }
       cmp reasons: recent_scores_lt_2, earlier_scores_lt_4, team_history_unavailable, team_history_stale, club_game_unclear,
                    records_conflict, score_week_not_loaded, season_unavailable, newer_score_unseparable (Earlier/Difference withheld)
   UPS2027.clubhist.logFor(input, id, opts?) -> [{ week, kind, score, byeKnown, recorded }]   one row per week opts.fromWeek..toWeek
       (default: the strip weeks); kinds score|none|bye|newer|live|unloaded; a week absent from input.scores is "unloaded"; never an opponent
   UPS2027.clubhist.weeksNeeded(input) -> { strip: [L-3..L], log: [1..L] }
   UPS2027.clubhist.clubByeMap(players) -> { club: byeWeek }     players = [{club, bye}]; clubs with disagreeing/invalid byes omitted
   UPS2027.clubhist.roundHalfUp1(x) -> x rounded to one decimal, halves up (mirrored for negatives)

   Evidence per week: confirmed (a segment covers it) | bracketed (same club both sides of a gap) | continuation (after the last
   segment, last club = MFL's club, no `cur`) | nochange (in none of the Worker's lists: MFL's club, through the cutoff only) all
   give club identity. candidates (between two clubs, or after the last segment when MFL's club differs) give a game or a bye only
   when every candidate agrees, never an identity. Before the first segment: unknown identity and opportunity. A recorded score
   proves only that a score was recorded: it never resolves identity or opportunity. MFL's current club is used for no week
   outside the continuation, nochange and candidate grades. A BYE is drawn only with known identity. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.UPS2027 = root.UPS2027 || {}; root.UPS2027.clubhist = api; }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var HIST_REASONS = ["past_season", "context_failed", "no_history", "crosswalk_failed", "crosswalk_suspect"];
  var KNOWN = { confirmed: 1, bracketed: 1, continuation: 1, nochange: 1 };   // the grades that give club identity

  function own(o, k) { return o != null && Object.prototype.hasOwnProperty.call(o, k); }
  function isNum(n) { return typeof n === "number" && isFinite(n); }
  function isInt(n) { return isNum(n) && Math.floor(n) === n; }
  function r6(x) { return Math.round(x * 1e6) / 1e6; }                        // kills binary drift in sums of one-decimal scores
  function norm(c) { return typeof c === "string" ? c.trim().toUpperCase() : ""; }
  function club(c) { var s = norm(c); return s === "FA" ? "" : s; }          // "" = no club
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }

  // One decimal, halves up. The league reconciles with JS rounding (halves up); 1e-9 keeps 0.45 * 10 = 4.5 from landing on 4.4999999.
  function roundHalfUp1(x) {
    if (!isNum(x)) return null;
    return x >= 0 ? Math.round(x * 10 + 1e-9) / 10 : -(Math.round(-x * 10 + 1e-9) / 10) + 0;
  }

  // { club: byeWeek } from roster rows. A club whose rows disagree, or any row with a bye that is not an integer 1..18, is omitted.
  function clubByeMap(players) {
    var out = {}, bad = {}, i;
    for (i = 0; i < (players || []).length; i++) {
      var p = players[i] || {}, c = club(p.club);
      if (!c) continue;
      var raw = typeof p.bye === "string" && /^\s*\d{1,2}\s*$/.test(p.bye) ? Number(p.bye) : p.bye;
      if (!isInt(raw) || raw < 1 || raw > 18) { bad[c] = true; continue; }
      if (!own(out, c)) out[c] = raw; else if (out[c] !== raw) bad[c] = true;
    }
    for (var k in bad) if (own(bad, k)) delete out[k];
    return out;
  }

  // The Worker's fields, validated. Anything odd is unavailable ("malformed"): nothing is guessed.
  function checkHist(hist, L) {
    var bad = { ok: false, reason: "malformed" };
    if (hist == null) return { ok: false, reason: "absent" };
    if (typeof hist !== "object" || Array.isArray(hist)) return bad;
    var st = hist.teamHistoryState, rs = hist.teamHistoryReason == null ? null : hist.teamHistoryReason;
    if (st === "unavailable") return HIST_REASONS.indexOf(rs) >= 0 ? { ok: false, reason: rs } : bad;
    if (st !== "ok" || rs !== null) return bad;
    var through = hist.teamHistoryThrough;
    if (!isInt(through) || through < 1 || through > L + 1) return bad;   // PR B: the history may run one week past the last all-final week (a partial week); it is clamped to L below
    var th = hist.teamHistory, out = { ok: true, through: through, th: {}, missing: {}, conflict: {}, first: {} };
    if (th == null || typeof th !== "object" || Array.isArray(th)) return bad;
    var fi = hist.teamHistoryFirst;                                       // required: the phone ships only with the W1 that sends it
    if (fi == null || typeof fi !== "object" || Array.isArray(fi)) return bad;
    for (var f in fi) { if (!own(fi, f)) continue; if (!isInt(fi[f]) || fi[f] < 1 || fi[f] > through) return bad; out.first[f] = fi[f]; }
    var lists = [["teamHistoryMissing", out.missing], ["teamHistoryConflict", out.conflict]], i, j;
    for (i = 0; i < lists.length; i++) {
      var arr = hist[lists[i][0]];
      if (!Array.isArray(arr)) return bad;
      for (j = 0; j < arr.length; j++) { if (typeof arr[j] !== "string") return bad; lists[i][1][arr[j]] = true; }
    }
    for (var id in th) {
      if (!own(th, id)) continue;
      var e = th[id], segs = e && e.seg, prev = 0;
      if (e == null || typeof e !== "object" || !Array.isArray(segs) || segs.length < 1) return bad;
      if (e.cur != null && typeof e.cur !== "string") return bad;
      for (j = 0; j < segs.length; j++) {
        var s = segs[j];
        if (!Array.isArray(s) || s.length !== 3 || typeof s[0] !== "string" || !norm(s[0]) || !isInt(s[1]) || !isInt(s[2])) return bad;
        if (s[1] < 1 || s[1] > s[2] || s[2] > through || s[1] <= prev) return bad;   // in range, ordered, no overlap
        prev = s[2];
      }
      out.th[id] = { seg: segs, cur: e.cur == null ? "" : club(e.cur), hasCur: e.cur != null && !!club(e.cur) };
    }
    return out;
  }

  // The evidence grade of week w for a player, per the scope's evidence table.
  function gradeOf(w, e, cur) {
    var segs = e.seg, i, prev = null, next = null;
    for (i = 0; i < segs.length; i++) {
      if (segs[i][1] <= w && w <= segs[i][2]) return { grade: "confirmed", clubs: [club(segs[i][0])] };
      if (segs[i][2] < w) prev = segs[i];
      if (segs[i][1] > w && !next) next = segs[i];
    }
    if (!prev) return { grade: "before_first", clubs: [] };               // identity and opportunity unknown; not assigned backward
    var a = club(prev[0]);
    if (next) { var b = club(next[0]); return a === b ? { grade: "bracketed", clubs: [a] } : { grade: "candidates", clubs: [a, b] }; }
    if (e.hasCur) {                                                       // MFL's club differs from his last record's (F2)
      var cl = [a]; if (e.cur !== a) cl.push(e.cur);
      if (cur && cl.indexOf(cur) < 0) cl.push(cur);
      return cl.length === 1 ? { grade: "continuation", clubs: [a] } : { grade: "candidates", clubs: cl };
    }
    if (cur && cur === a) return { grade: "continuation", clubs: [a] };   // F2: only while MFL's club equals the last record's club
    return cur ? { grade: "candidates", clubs: [a, cur] } : { grade: "no_club_after_last", clubs: [a] };
  }

  // Game (g), bye (b) or unknown (u) for a set of candidate clubs: established only when every candidate agrees.
  function opportunity(cands, w, byeOf) {
    var res = null, i;
    if (!cands.length) return "u";
    for (i = 0; i < cands.length; i++) {
      var b = own(byeOf, cands[i]) ? byeOf[cands[i]] : null, o;
      if (!isInt(b) || b < 1 || b > 18) return "u";
      o = w === b ? "b" : "g";
      if (res !== null && res !== o) return "u";
      res = o;
    }
    return res;
  }

  // `first` (optional, nochange only): the week of his first weekly record, when the caller knows it; earlier weeks are then unknown.
  function weekInfo(cls, w, e, cur, byeOf, cutoff, first) {
    var g, ids = "";
    if (cls === "changed") g = gradeOf(w, e, cur);
    else if (cls === "nochange") g = first && w < first ? { grade: "before_first", clubs: [] } : { grade: "nochange", clubs: [cur] };
    else g = { grade: cls === "conflict" ? "conflict" : "none", clubs: [] };
    var known = KNOWN[g.grade] === 1, opp = g.grade === "no_club_after_last" ? "u" : opportunity(g.clubs, w, byeOf);
    if (g.grade === "candidates") ids = g.clubs.join(" or ");
    var note = {
      confirmed: "Club confirmed by his weekly record", bracketed: "No record this week; same club on both sides of the gap",
      continuation: "No record after his last week; same club as MFL's current club",
      nochange: "No club change seen through Week " + cutoff + "; MFL's current club",
      candidates: "No record; he was with " + ids + (opp === "u" ? " and their games differ" : (opp === "b" ? ", all with a bye" : ", all with a game")),
      before_first: "Before his first weekly record: club and team game unknown", no_club_after_last: "After his last weekly record: club not confirmed",
      conflict: "Records conflict: club unknown", none: "No club evidence"
    }[g.grade];
    return { grade: g.grade, identity: known ? "known" : { candidates: "one_of_two_clubs", before_first: "unknown_before_first_record", conflict: "conflict" }[g.grade] || "no_evidence",
             opp: opp, note: note, byeByCandidates: g.grade === "candidates" && opp === "b", cands: g.clubs.slice() };
  }

  function groupCoverage(weeks, cutoff) {
    var out = [], w, last = null;
    for (w = 1; w <= cutoff; w++) {
      var x = weeks[w], opp = x.opp === "u" ? "unknown" : "known";
      if (last && last.identity === x.identity && last.opportunity === opp && last.note === x.note && last.grade === x.grade) last.toWeek = w;
      else { last = { fromWeek: w, toWeek: w, identity: x.identity, opportunity: opp, grade: x.grade, note: x.note }; out.push(last); }
    }
    return out;
  }

  // Is a newer-week score in the Worker's season total (which counts only FINAL games)? true / false / null = cannot be established.
  function newerIncluded(ne, cur) {
    if (!ne || typeof ne !== "object") return null;
    if (ne.complete === true) return true;
    if (cur && ne.clubs && typeof ne.clubs === "object" && own(ne.clubs, cur) && typeof ne.clubs[cur] === "boolean") return ne.clubs[cur];
    return null;
  }

  function evaluate(input) {
    input = input || {};
    var L = input.latestFinal, byeOf = input.byeOf || {}, clubs = input.clubs || {}, ids = input.ids || [];
    var scores = input.scores || {}, season = input.season || null, rows = {}, i, w;
    if (!isInt(L) || L < 1) return { state: "unavailable", reason: "malformed", cutoff: null, latestFinal: L, gap: null, stripWeeks: [], banner: { text: "Team history unavailable", kind: "unavailable", reason: "malformed" }, rows: rows };
    var H = checkHist(input.hist, L), cutoff = null, gap = null, state = "ok", reason = null;
    if (H.ok && input.through != null && input.through !== H.through) H = { ok: false, reason: "malformed" };   // two answers to one question
    var banner = { text: "", kind: "through" };
    if (H.ok) {
      cutoff = Math.min(H.through, L); gap = L - cutoff;   // never past the last all-final week, whatever the history covers
      if (gap >= 2) { H = { ok: false, reason: "stale" }; state = "unavailable"; reason = "stale"; banner = { text: "Team history is " + gap + " weeks behind", kind: "stale" }; }
      else banner.text = "Comparison through Week " + cutoff;
    } else {
      state = "unavailable"; reason = H.reason; cutoff = null;
      banner = { text: "Team history unavailable", kind: "unavailable", reason: reason };
    }
    var stripWeeks = [];
    for (w = Math.max(1, L - 3); w <= L; w++) stripWeeks.push(w);
    var T = H.ok ? cutoff : L;                                           // the week every figure runs through
    function scoreOf(wk, id) {                                           // undefined: week not loaded; null: loaded, none recorded
      var o = scores[wk];
      if (o == null || typeof o !== "object") return undefined;
      return own(o, id) && isNum(o[id]) ? o[id] : null;
    }
    for (i = 0; i < ids.length; i++) rows[ids[i]] = buildRow(ids[i]);
    return { state: state, reason: reason, cutoff: cutoff, latestFinal: L, gap: gap, stripWeeks: stripWeeks, banner: banner, rows: rows };

    function stale() { return reason === "stale"; }

    function buildRow(id) {
      var se = season && own(season, id) && season[id] && isNum(season[id].total) && isInt(season[id].games) && season[id].games >= 0 ? season[id] : null;
      var cur = club(clubs[id]), cls, e = null, k;
      var first = own(H.first, id) ? H.first[id] : 0;                      // a no-change player's first weekly-row week (W1 teamHistoryFirst)
      // An id absent from `season` is unavailable, never zero: the Worker drops unattributed player-games, so earlier scores may exist.
      // B: the latest final week L can hold LIVE scores. With newerFinal.complete === false, a score is live when that club's game is not
      // final (excluded from every figure, strip kind "live"), unsettled when that cannot be established (comparison withheld).
      // gstat: is his current club's game in week L completed? "final" | "live" (not final) | "unknown". Only newerFinal.complete === false asks.
      var sL = scoreOf(L, id), lstat = "final", gstat = "final", ne = input.newerFinal, hasScores = !!(se && se.games > 0), q;
      if (ne && typeof ne === "object" && ne.complete === false) { q = newerIncluded(ne, cur); gstat = q === true ? "final" : (q === false ? "live" : "unknown"); }
      if (typeof sL === "number") lstat = gstat === "unknown" ? "unsettled" : gstat;
      var unsettledL = H.ok && cutoff >= L && lstat === "unsettled";
      var cs = function (wk) { var v = scoreOf(wk, id); return wk === L && lstat === "live" ? null : v; };   // a live score counts as no score
      for (k in scores) if (own(scores, k) && typeof scoreOf(Number(k), id) === "number") hasScores = true;
      // Season figures through the cutoff. The Worker's total counts a game only when it is FINAL, so a recorded newer-week score is
      // taken back out only when that game is known to be final (newerFinal); a recorded score whose inclusion cannot be settled, or a
      // newer week that is not loaded, leaves the total as the Worker gave it (seasonThrough = latestFinal) and Earlier is withheld.
      var sCut = se ? { total: se.total, games: se.games } : null, seasonTh = T, unsettled = false;
      for (k = T + 1; sCut && H.ok && k <= L; k++) {
        var sc = scoreOf(k, id), inc = sc === null ? false : newerIncluded(input.newerFinal, cur);
        if (sc === undefined) unsettled = true;
        else if (inc === null) unsettled = true;
        else if (inc) { sCut.total = r6(sCut.total - sc); sCut.games -= 1; }
      }
      if (unsettled && sCut) { sCut = { total: se.total, games: se.games }; seasonTh = L; }
      if (sCut && sCut.games < 0) sCut = null;
      if (!H.ok) cls = "unavailable";
      else if (own(H.conflict, id)) cls = "conflict";
      else if (own(H.missing, id)) cls = "missing";
      else if (own(H.th, id)) { cls = "changed"; e = H.th[id]; }
      else cls = hasScores && cur ? "nochange" : "none";                // F1: "no change seen" needs MFL scores and a current club
      var wk = null, of = null, win = null, blocked = null, unknown = 0, games = 0, uw = [];
      var mk = function (c) {
        var arr = [], x;
        for (x = 1; x <= cutoff; x++) arr[x] = weekInfo(c, x, e, cur, byeOf, cutoff, first);
        return arr;
      };
      if (H.ok) {
        wk = mk(cls);
        // a recorded score in a loaded week where the determined club had a bye is a conflict (shown once, nothing hidden)
        for (k = 1; k <= cutoff; k++) if (wk[k].opp === "b" && typeof scoreOf(k, id) === "number") { cls = "conflict"; wk = mk(cls); break; }
        for (k = 1; k <= cutoff; k++) { if (wk[k].opp === "u") { unknown++; uw.push({ week: k, clubs: wk[k].cands }); } else if (wk[k].opp === "g") games++; }
        if (!unknown) of = games;
        if (cutoff >= L && wk[L].opp === "g" && of !== null) { if (gstat === "live") of -= 1; else if (gstat === "unknown") of = null; }   // a live game is not a completed team game
        if (of !== null && sCut && !unsettled && !unsettledL && sCut.games > of) { cls = "conflict"; wk = mk(cls); of = null; unknown = cutoff; }   // more scores than team games
      }
      var usable = H.ok && cls !== "conflict" && cls !== "missing" && cls !== "none";
      if (usable) {      // window: the last 3 COMPLETED team games up to the cutoff. A bye and a live (not final) game are skipped, never gaps; a completed
                         // game with no score keeps its slot (a gap); an unknown week (or unknown finality) stops the look-back
        win = [];
        for (k = cutoff; k >= 1; k--) {
          if (wk[k].opp === "b") continue;
          if (wk[k].opp === "u") { blocked = k; break; }
          if (k === L && gstat === "live") continue;
          if (k === L && gstat === "unknown" && scoreOf(L, id) === null) { blocked = k; break; }
          win.push(k); if (win.length === 3) break;
        }
        win.reverse();
      }

      // one cell per week; the strip and the full-season log share it
      function cellAt(wn) {
        var v = scoreOf(wn, id), cell, lv = wn === L && lstat === "live" && typeof v === "number";
        if (H.ok && wn > cutoff) cell = { week: wn, kind: "newer", score: v === undefined ? null : v, loaded: v !== undefined };
        else if (v === undefined) cell = { week: wn, kind: "unloaded", score: null, loaded: false };
        else if (lv) cell = { week: wn, kind: "live", score: v, loaded: true };                    // an unfinished game: shown, counted nowhere
        else if (v !== null) cell = { week: wn, kind: "score", score: v, loaded: true };
        else if (H.ok && wk[wn] && wk[wn].opp === "b" && wk[wn].identity === "known") cell = { week: wn, kind: "bye", score: null, loaded: true };
        else cell = { week: wn, kind: "none", score: null, loaded: true };
        if (cell.kind === "none" && H.ok && wk[wn] && wk[wn].byeByCandidates) cell.byeByCandidates = true;   // a bye by candidate agreement: counted nowhere, drawn as a dash
        return cell;
      }
      var strip = [], rec = [], loadedWeeks = [], r4 = 0, all4 = true, c = 0;
      for (c = 0; c < stripWeeks.length; c++) {
        var cell = cellAt(stripWeeks[c]), s = cell.score;
        if (!cell.loaded) all4 = false; else if (s !== null && cell.kind !== "live") r4++;
        if (cell.loaded && cell.kind !== "newer") { loadedWeeks.push(cell.week); if (s !== null && cell.kind !== "live") rec.push(s); }
        strip.push(cell);
      }
      var log = null;
      if (input.logWeeks) { log = []; for (c = input.logWeeks[0]; c <= input.logWeeks[1]; c++) log.push(cellAt(c)); }
      var range = null;
      if (rec.length) { range = { lo: Math.min.apply(null, rec), hi: Math.max.apply(null, rec), fromWeek: loadedWeeks[0], toWeek: loadedWeeks[loadedWeeks.length - 1], n: rec.length }; }

      var known = sCut ? sCut.games : null;
      // C: when the season figures run through a different week than the cutoff (unsettled score, or a stale history) the count is
      // never set against a team-game total, and the text names the week it is through.
      var mixed = unsettled || unsettledL, other = known !== null && (mixed || (cutoff !== null && seasonTh !== cutoff));
      if (mixed) of = null;
      var teamGames = { known: known, of: of, text: known === null ? "Scored games unavailable" : (of !== null ? known + " of " + of + " team games" : plural(known, "scored game", "scored games") + (other ? " through Week " + seasonTh : "")) };

      // comparison
      var recent = null, earlier = null, difference = null, recentN = null, earlierN = null, scoredCount = null;
      var cmp = null, withheld = function (reason, text, wkn) { cmp = { state: "withheld", reason: reason, text: text }; if (wkn) cmp.week = wkn; };
      var needLoaded = true, lo = 0, x;
      if (win && win.length) {
        lo = win[0];
        for (x = lo; x <= L; x++) { if (scoreOf(x, id) === undefined) needLoaded = false; }
        if (needLoaded) {
          var inWin = 0, sumW = 0, sumAll = 0, cntAll = 0;
          for (x = lo; x <= cutoff; x++) { var v = cs(x); if (typeof v === "number") { sumAll += v; cntAll++; if (win.indexOf(x) >= 0) { sumW += v; inWin++; } } }
          scoredCount = inWin; recentN = inWin;
          if (inWin) recent = sumW / inWin;
          if (sCut && !mixed) { earlierN = sCut.games - cntAll; if (earlierN > 0) earlier = r6(sCut.total - sumAll) / earlierN; }
        }
      }
      var lt2 = function () { withheld("recent_scores_lt_2", "Not enough recent scores (needs 2)"); };
      if (known !== null && known < 2) lt2();
      else if (all4 && r4 < 2) lt2();                                    // true under any club
      else if (known !== null && known < 6) withheld("earlier_scores_lt_4", "Not enough earlier scores (needs 4)");
      else if (!H.ok) {
        if (stale()) withheld("team_history_stale", "Team history is " + gap + " weeks behind");
        else withheld("team_history_unavailable", "Team history unavailable");
      }
      else if (cls === "conflict") withheld("records_conflict", "Records conflict");
      else if (cls === "missing" || cls === "none") withheld("team_history_unavailable", "Team history unavailable");
      else if (blocked) withheld("club_game_unclear", "Team game unclear in Week " + blocked, blocked);
      else if (!win.length) lt2();
      else if (!needLoaded) withheld("score_week_not_loaded", "Scores for a needed week are not loaded");
      else if (recentN < 2) lt2();
      else if (!sCut) withheld("season_unavailable", "Season totals unavailable");
      else if (mixed) withheld("newer_score_unseparable", "A newer score is recorded and it is not clear whether the season total includes it");
      else if (earlierN < 0) withheld("season_unavailable", "Season totals unavailable");
      else if (earlierN < 4) withheld("earlier_scores_lt_4", "Not enough earlier scores (needs 4)");
      else { difference = recent - earlier; cmp = { state: "shown", reason: "shown", text: "Last 3 team games against earlier scored games" }; }
      // numbers only when shown; Recent survives the two Earlier-only withholdings (unavailable season, unsettled NEWER score)
      if (cmp.state !== "shown") { if (unsettledL || (cmp.reason !== "newer_score_unseparable" && cmp.reason !== "season_unavailable")) recent = null; earlier = null; }

      // PR B: what the per-game eligibility needs. `games` = weeks of a known club that had a game (supported team games); `unknownWeeks` = weeks the
      // history does not settle (they widen the upper bound, never the supported count); `hist` says why there is no evidence at all.
      var eligIn = usable ? { hist: "ok", games: games, unknownWeeks: uw } : { hist: !H.ok ? "unavailable" : cls === "conflict" ? "conflict" : "missing", games: null, unknownWeeks: [] };
      return {
        elig: eligIn,
        seasonAvg: sCut && sCut.games > 0 ? sCut.total / sCut.games : null, scoredGames: known, seasonThrough: sCut ? seasonTh : null, mixedBase: mixed,
        strip: strip, range: range, teamGames: teamGames, coverage: H.ok ? groupCoverage(wk, cutoff) : [],
        window: win && win.length ? { weeks: win, scoredCount: scoredCount } : null,
        recent: recent, earlier: earlier, difference: difference, recentN: recentN, earlierN: earlierN, cmp: cmp, cls: cls, log: log
      };
    }
  }

  // The profile game log: one row per week fromWeek..toWeek (default: the strip weeks). A week absent from input.scores is "unloaded", never
  // "none". A BYE only with known club identity; weeks above the cutoff are "newer"; never an opponent.
  function logFor(input, id, opts) {
    var o = {}, k, L = input && input.latestFinal;
    for (k in input) if (own(input, k)) o[k] = input[k];
    o.ids = [id];
    var from = opts && isInt(opts.fromWeek) ? opts.fromWeek : Math.max(1, L - 3), to = opts && isInt(opts.toWeek) ? opts.toWeek : L;
    if (!isInt(L) || from < 1 || to < from) return [];
    o.logWeeks = [from, to];
    var r = evaluate(o).rows[id];
    return r && r.log ? r.log.map(function (c) { return { week: c.week, kind: c.loaded ? c.kind : "unloaded", score: c.score, byeKnown: c.kind === "bye", recorded: c.score !== null }; }) : [];
  }

  // The weeks of scores the caller must load: the Performance strip, and the full-season profile log.
  function weeksNeeded(input) {
    var L = input && input.latestFinal, strip = [], log = [], w;
    if (!isInt(L) || L < 1) return { strip: strip, log: log };
    for (w = Math.max(1, L - 3); w <= L; w++) strip.push(w);
    for (w = 1; w <= L; w++) log.push(w);
    return { strip: strip, log: log };
  }

  return { evaluate: evaluate, logFor: logFor, weeksNeeded: weeksNeeded, clubByeMap: clubByeMap, roundHalfUp1: roundHalfUp1 };
});
