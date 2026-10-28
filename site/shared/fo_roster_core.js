/* Front Office → Roster → Players: the pure pieces the Performance, Contract and Schedule views share (#1338, 2026-10-28).
     statusOf / sections   one Active → IR → Taxi split, same order and labels in every view. By position: QB … DB, Other
                           (active players only), then IR, then Taxi. All players: Active, IR, Taxi.
     pointsRankMap         a SEASON-POINTS rank in the PPG rank's universe and minimum (site/m/season_scoring.js rankMap:
                           every player MFL scored at the lineup position, free agents too, with rankMinimum() MFL wks).
     rankLabel             "#4 RB" / "unranked" (below the minimum) / "—" (no MFL week), the PPG rank's wording.
     rateView              one player's Start / Boom / Bust from /api/player-starter-rates (worker/src/starter_rates.js). The
                           model decides sufficiency: it sends a % only with 3+ graded weeks (MIN_WEEKS); a null % = "few".
                           Boom weeks are INSIDE Start (P75 >= P50) and Bust excludes Start, so the model's own counts give an
                           exclusive split that adds up to the graded weeks: Boom, Start-only (start - boom), Middle
                           (q - start - bust: below the median, not a Bust) and Bust. Derived only; the model is unchanged.
     newsFlagKind          whether a player's /api/player-news items earn the news flag: a headline from the last 7 days.
                           Sleeper status / depth cards never do (the injury chip is the one injury signal), and the flag
                           never says "injury".
   Attaches window.UPS_FO_ROSTER_CORE and module.exports. No fetch, no DOM. */
(function (root) {
  "use strict";

  var POS_ORDER = ["QB", "RB", "WR", "TE", "PK", "PN", "DL", "LB", "DB"];
  var STATUS_LABEL = { active: "Active", ir: "IR", taxi: "Taxi" };

  // IR first, then Taxi (MFL never lists a player on both); anything else is active.
  function statusOf(p) { return p && p.isIr ? "ir" : (p && p.isTaxi ? "taxi" : "active"); }

  /* sections(items, { byPosition, player(it) → roster row, posOf(it) → "QB" … "DB" or "" })
       → [{ key, label, status, rows }] in display order; empty sections are left out. Row order inside a section is the
       caller's (items keep their incoming order). */
  function sections(items, opts) {
    opts = opts || {};
    var player = opts.player || function (it) { return it; };
    var posOf = opts.posOf || function () { return ""; };
    var buckets = {};
    (items || []).forEach(function (it) {
      var st = statusOf(player(it)), k;
      if (st !== "active") k = STATUS_LABEL[st];
      else if (!opts.byPosition) k = "Active";
      else { var g = String(posOf(it) || "").toUpperCase(); k = POS_ORDER.indexOf(g) >= 0 ? g : "Other"; }
      (buckets[k] = buckets[k] || []).push(it);
    });
    var order = (opts.byPosition ? POS_ORDER.concat(["Other"]) : ["Active"]).concat(["IR", "Taxi"]);
    return order.filter(function (k) { return buckets[k]; }).map(function (k) {
      return { key: k, label: k, status: k === "IR" ? "ir" : (k === "Taxi" ? "taxi" : "active"), rows: buckets[k] };
    });
  }

  /* pointsRankMap(stats, groupOf, minGames) → { pid: { rank, group } } — the PPG rank's rules (season_scoring.js rankMap) with
     season points as the measure: only players with minGames+ MFL wks, inside each lineup group; ties break on PPG, then id. */
  function pointsRankMap(stats, groupOf, minGames) {
    var min = Math.max(1, parseInt(minGames, 10) || 1), buckets = {};
    Object.keys(stats || {}).forEach(function (pid) {
      var r = stats[pid];
      if (!r || !(r.games >= min)) return;
      var g = groupOf ? groupOf(pid) : "";
      if (!g) return;
      (buckets[g] = buckets[g] || []).push({ pid: pid, pts: r.pts, ppg: r.ppg });
    });
    var out = {};
    Object.keys(buckets).forEach(function (g) {
      buckets[g].sort(function (a, b) { return (b.pts - a.pts) || (b.ppg - a.ppg) || (a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : 0); });
      buckets[g].forEach(function (x, i) { out[x.pid] = { rank: i + 1, group: g }; });
    });
    return out;
  }
  // One points-rank map per scoring read and grouping (a table lists every row's rank; never rebuild it per player).
  var memo = { ss: null, groupOf: null, map: null };
  function pointsRankFor(ss, groupOf) {
    if (!ss || !ss.known) return {};
    if (memo.ss !== ss || memo.groupOf !== groupOf || !memo.map) {
      memo = { ss: ss, groupOf: groupOf, map: pointsRankMap(ss.windowFor(0), groupOf, ss.rankMinimum ? ss.rankMinimum(0) : 1) };
    }
    return memo.map;
  }

  function rankLabel(rank, group, games) {
    if (rank) return "#" + rank + (group ? " " + group : "");
    return games > 0 ? "unranked" : "—";
  }

  /* rateView(rec) for one player's /api/player-starter-rates record (or undefined when the answer has none for him):
       { state: "ok", q, start: { n, pct }, boom: { n, pct }, bust: { n, pct } }   — the model sent its %s
       { state: "few", q }                                                          — fewer graded weeks than the model needs */
  function rateView(rec) {
    var q = rec && rec.q > 0 ? rec.q : 0;
    if (!rec || rec.startable_pct == null || rec.boom_pct == null || rec.bust_pct == null) return { state: "few", q: q };
    return { state: "ok", q: q,
      start: { n: rec.startable_n, pct: rec.startable_pct }, boom: { n: rec.boom_n, pct: rec.boom_pct }, bust: { n: rec.bust_n, pct: rec.bust_pct },
      split: { boom: rec.boom_n, startOnly: rec.startable_n - rec.boom_n, middle: q - rec.startable_n - rec.bust_n, bust: rec.bust_n } };
  }
  // The last final week the starter-rates answer graded (0 when none).
  function ratesThrough(answer) {
    var w = (answer && answer.final_weeks) || [];
    return w.length ? Math.max.apply(null, w) : 0;
  }

  // News flag (2026-10-28, Keith's review): Joe Milton and Jack Strand carried a hospital icon from a Sleeper "Injury Status:
  // Out (Coach's Decision)" card (a healthy inactive, Strand's dated 2026-09-24) with no MFL or NFL injury listed. A player is
  // never labeled injured from news: only headline / injury-news items count, only from the last NEWS_DAYS days before refMs
  // (the news read's own time), and the flag is always plain "news". Returns "news" or "".
  var NEWS_DAYS = 7;
  function newsFlagKind(items, refMs) {
    var ref = refMs > 0 ? refMs : Date.now(), cut = ref - NEWS_DAYS * 86400000;
    return (items || []).some(function (it) {
      if (!it || (it.type !== "headline" && it.type !== "injury")) return false;
      var ts = Number(it.timestamp) * 1000;
      return ts > 0 && ts >= cut && ts <= ref + 86400000;
    }) ? "news" : "";
  }
  // The record for an MFL id in the answer (the worker keys players by the id's integer text).
  function rateRecord(answer, pid) {
    var m = answer && answer.players;
    if (!m) return undefined;
    var k = /^\d+$/.test(String(pid)) ? String(parseInt(pid, 10)) : String(pid);
    return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : undefined;
  }

  var api = { POS_ORDER: POS_ORDER, STATUS_LABEL: STATUS_LABEL, statusOf: statusOf, sections: sections,
    pointsRankMap: pointsRankMap, pointsRankFor: pointsRankFor, rankLabel: rankLabel, rateView: rateView, rateRecord: rateRecord,
    ratesThrough: ratesThrough, NEWS_DAYS: NEWS_DAYS, newsFlagKind: newsFlagKind };
  root.UPS_FO_ROSTER_CORE = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : this);
