/* Front Office → Roster (#1338): the Performance column set (default) beside
   the Contract ledger, and the Bye planner. Read-only.

   Performance shows the rows the Contract table shows (same team / position /
   type / status filters), with:
     Lineup   where the player sits in this week's best legal lineup by season
              PPG (18 slots; taxi, IR and players ruled Out are not available)
     Pts      MFL points, league scoring, every week MFL posted (the phone's)
     Pts rank season-points rank, same universe and minimum as the PPG rank
     PPG      per MFL-scored week (a 0.0 week counts, a bye doesn't)
     PPG rank PPG rank at the lineup position, among every player MFL scored
              with at least half the final weeks (phone rule)
     L4       last four FINAL weeks' PPG (context: the season is the better guide)
     L4 rank  that PPG's rank, same universe, 2+ of the 4 weeks (season_scoring rankMinimum(4))
     Start / Boom / Bust
              the worker's starter-pool model (worker/src/starter_rates.js) from ONE
              league-wide /api/player-starter-rates answer; a % only with the model's
              own 3+ graded weeks, else "Not enough games"
     Week split the same graded weeks split so each counts once (Boom · Start-only · Middle ·
              Bust, adding up to the graded weeks; derived from the model's counts)
     Next     this lineup week's opponent and kickoff, or BYE (MFL schedule)
     Proj     MFL's projection for this lineup week (a forecast, labelled)
     Bye      the NFL bye week (MFL)
   The Bye planner runs site/shared/bye_planner.js on the same values.
*/
(function (root) {
  "use strict";

  var H, FO, DATA;
  var colset = "perf";
  var sort = { key: "", dir: -1 };
  var byeView = { pos: "ALL", week: null };   // whole roster only (Keith 2026-10-26): no starters-only scope
  var GROUP_ORDER = ["QB", "RB", "WR", "TE", "PK", "PN", "DL", "LB", "DB"];
  var NCOL = 17;          // Performance columns
  var srAsked = false;    // the starter-rates read is asked for once per visit
  var SLOT_LABEL = { QB1: "QB", RB1: "RB", RB2: "RB", WR1: "WR", WR2: "WR", TE1: "TE", OF1: "Flex", OF2: "Flex", SF1: "SuperFlex",
    PK1: "K", PN1: "P", DL1: "DL", DL2: "DL", LB1: "LB", LB2: "LB", DB1: "DB", DB2: "DB", DF1: "D-Flex" };

  function lineupWeek() {
    var ss = H.scoring();
    if (!ss) return null;
    if (ss.lineupWeek) return ss.lineupWeek;
    return ss.latestWeek ? ss.latestWeek + (ss.liveWeeks && ss.liveWeeks.length ? 0 : 1) : null;
  }

  function arr(x) { return x == null ? [] : (Array.isArray(x) ? x : [x]); }
  // { TEAM: { opp, home, kickoff(ms) } } from one week of MFL's nflSchedule (pure; a team with no game isn't listed).
  function parseSchedule(json) {
    var out = {};
    arr(json && json.nflSchedule && json.nflSchedule.matchup).forEach(function (m) {
      var teams = arr(m && m.team);
      if (teams.length !== 2) return;
      var k = parseInt(m.kickoff, 10) * 1000 || 0;
      out[String(teams[0].id).toUpperCase()] = { opp: String(teams[1].id).toUpperCase(), home: teams[0].isHome === "1", kickoff: k };
      out[String(teams[1].id).toUpperCase()] = { opp: String(teams[0].id).toUpperCase(), home: teams[1].isHome === "1", kickoff: k };
    });
    return out;
  }
  function scheduleMap(week) {
    var e = week ? DATA.get("nflSchedule", week) : null;
    return e && e.state === "ok" ? parseSchedule(e.data) : null;
  }
  // { pid: points } from MFL's projectedScores (pure; a blank projection is "none", never 0).
  function parseProjections(json) {
    var out = {};
    arr(json && json.projectedScores && json.projectedScores.playerScore).forEach(function (r) {
      if (r && r.id && r.score !== "" && r.score != null && isFinite(Number(r.score))) out[String(r.id)] = Number(r.score);
    });
    return out;
  }
  function projMap(week) {
    var e = week ? DATA.get("projections", week) : null;
    return e && e.state === "ok" ? parseProjections(e.data) : null;
  }
  function byeMap() {
    var e = DATA.get("byes"), BP = root.UPS_BYE_PLANNER;
    return e && e.state === "ok" && BP ? BP.byesFromMfl(e.data) : null;
  }
  function kickLabel(ms) {
    if (!(ms > 0)) return "";
    try { return new Date(ms).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" }); } catch (e) { return ""; }
  }

  // Likely lineup slot per player for each visible team (best legal lineup this week, season PPG).
  function likelySlots(teamFids, week, byes) {
    var BP = root.UPS_BYE_PLANNER, out = {};
    if (!BP || !week) return out;
    var vals = H.values(0);
    H.modelTeams().forEach(function (t) {
      if (teamFids.indexOf(t.fid) === -1) return;
      var plan = BP.plan({ players: t.players, values: vals, byeWeekByTeam: byes || {}, fromWeek: week, toWeek: week, currentWeek: week });
      var slots = plan.weeks[0] ? plan.weeks[0].slots : {};
      Object.keys(slots).forEach(function (sid) { if (slots[sid]) out[slots[sid]] = SLOT_LABEL[sid] || sid; });
    });
    return out;
  }

  // ── Performance table ─────────────────────────────────────────────
  function perfRows() {
    var rows = FO.visibleRows() || [];
    var week = lineupWeek(), sched = scheduleMap(week), proj = projMap(week), byes = byeMap();
    var fids = []; rows.forEach(function (p) { if (fids.indexOf(p.fid) === -1) fids.push(p.fid); });
    var slots = likelySlots(fids, week, byes);
    var C = root.UPS_FO_ROSTER_CORE, sr = DATA.get("starterRates");
    return rows.map(function (p) {
      var line = H.seasonLine(p.id, 4);
      var g = H.groupOf(p.id) || "";
      var team = String(p.nflTeam || "").toUpperCase();
      var next = sched ? sched[team] : null;
      var onBye = byes && week && byes[team] === week;
      return {
        p: p, group: g, line: line,
        slot: p.isTaxi ? "Taxi" : (p.isIr ? "IR" : (slots[String(p.id)] || "Bench")),
        next: onBye ? { bye: true } : next, proj: proj ? (proj[String(p.id)] != null ? proj[String(p.id)] : null) : undefined,
        bye: byes ? (byes[team] || null) : undefined,
        rates: sr && sr.state === "ok" ? C.rateView(C.rateRecord(sr.data, p.id)) : null
      };
    });
  }
  function sortVal(r, key) {
    switch (key) {
      case "name": return String(r.p.name || "");
      case "pts": return r.line ? r.line.pts : null;
      case "ppg": return r.line ? r.line.ppg : null;
      case "rank": return r.line && r.line.rank ? -r.line.rank : null;
      case "ptsrank": return r.line && r.line.ptsRank ? -r.line.ptsRank : null;
      case "l4": return r.line && r.line.last ? r.line.last.ppg : null;
      case "l4rank": return r.line && r.line.last && r.line.last.rank ? -r.line.last.rank : null;
      case "start": case "boom": case "bust": return r.rates && r.rates.state === "ok" ? r.rates[key].pct : null;
      case "proj": return r.proj == null ? null : r.proj;
      case "bye": return r.bye == null ? null : -r.bye;
      case "salary": return r.p.salary || 0;
      case "years": return r.p.years || 0;
      default: return null;
    }
  }
  function applySort(list) {
    if (!sort.key) {
      return list.slice().sort(function (a, b) {
        return ((b.line && b.line.ppg) || -1) - ((a.line && a.line.ppg) || -1);
      });
    }
    return list.slice().sort(function (a, b) {
      var x = sortVal(a, sort.key), y = sortVal(b, sort.key);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      var c = typeof x === "string" ? x.localeCompare(y) : (x - y);
      return sort.dir > 0 ? c : -c;
    });
  }
  function th(key, label, title, cls) {
    var arrow = sort.key === key ? (sort.dir > 0 ? " ▲" : " ▼") : "";
    var aria = sort.key === key ? (sort.dir > 0 ? "ascending" : "descending") : "none";
    return '<th class="' + (cls || "") + '" scope="col" aria-sort="' + aria + '"' + (title ? ' title="' + H.esc(title) + '"' : "") + ">" +
      (key ? '<button type="button" class="fo-th-sort" data-perf-sort="' + key + '">' + H.esc(label) + arrow + "</button>" : H.esc(label)) + "</th>";
  }
  // Start / Boom / Bust cells: "…" while reading, "—" if the read failed, "Not enough games" below the model's minimum.
  // Then the Week split: each graded week once (Boom · Start-only · Middle · Bust), adding up to the graded weeks, and the
  // basis of that count ("of 7 graded, thru Wk 7") so it is never read as the PPG column's MFL weeks.
  function rateCells(r) {
    var e = DATA.get("starterRates"), v = r.rates, C = root.UPS_FO_ROSTER_CORE;
    if (!e || e.state !== "ok" || !v) {
      var c = '<td class="num">' + (e && e.state !== "ok" ? "—" : '<span class="fo-muted">…</span>') + "</td>";
      return c + c + c + c;
    }
    var thru = C.ratesThrough(e.data), basis = v.q + " graded wk" + (v.q === 1 ? "" : "s") + (thru ? " thru Wk " + thru : "");
    if (v.state !== "ok") {
      return '<td colspan="4" class="fo-rate-few"><span class="fo-muted">Not enough games</span><div class="fo-muted fo-perf-sub">' + basis + "</div></td>";
    }
    var sp = v.split;
    return ["start", "boom", "bust"].map(function (k) {
      return '<td class="num">' + v[k].pct + '%<div class="fo-muted fo-perf-sub">' + v[k].n + " of " + v.q + "</div></td>";
    }).join("") +
      '<td class="num fo-rate-split" aria-label="' + H.esc(sp.boom + " Boom, " + sp.startOnly + " Start only, " + sp.middle + " Middle, " + sp.bust + " Bust: " + basis) + '">' +
      [sp.boom, sp.startOnly, sp.middle, sp.bust].join(" · ") + '<div class="fo-muted fo-perf-sub">' + H.esc(basis) + "</div></td>";
  }
  function rowHtml(r, multiTeam) {
    var p = r.p, l = r.line;
    var nextTxt = r.next === undefined || r.next === null
      ? (scheduleMap(lineupWeek()) ? '<span class="fo-muted">—</span>' : '<span class="fo-muted">…</span>')
      : (r.next.bye ? '<span class="fo-bye">BYE</span>' : (r.next.home ? "vs " : "@ ") + H.esc(r.next.opp) + ' <span class="fo-muted">' + H.esc(kickLabel(r.next.kickoff)) + "</span>");
    var slotCls = r.slot === "Bench" ? "bench" : (r.slot === "Taxi" || r.slot === "IR" ? "off" : "start");
    return "<tr>" +
      '<td class="fo-perf-player">' + H.playerCell(p, { multi: multiTeam }) + "</td>" +
      '<td><span class="fo-slot fo-slot-' + slotCls + '">' + H.esc(r.slot) + "</span></td>" +
      '<td class="num">' + (l ? H.fmt1(l.pts) : "—") + "</td>" +
      '<td class="num">' + (l ? H.esc(l.ptsRankLabel || "—") : "—") + "</td>" +
      '<td class="num">' + (l && l.ppg != null ? H.fmt1(l.ppg) : "—") + (l ? '<div class="fo-muted fo-perf-sub">' + l.games + " MFL wk" + (l.games === 1 ? "" : "s") + "</div>" : "") + "</td>" +
      '<td class="num">' + (l ? H.esc(l.rankLabel) : "—") + "</td>" +
      '<td class="num">' + (l && l.last && l.last.ppg != null ? H.fmt1(l.last.ppg) : "—") + "</td>" +
      '<td class="num">' + (l && l.last ? H.esc(l.last.rankLabel || "—") : "—") + "</td>" +
      rateCells(r) +
      "<td>" + nextTxt + "</td>" +
      '<td class="num">' + (r.proj === undefined ? '<span class="fo-muted">…</span>' : (r.proj == null ? "—" : H.fmt1(r.proj))) + "</td>" +
      '<td class="num col-md">' + (r.bye == null ? "—" : r.bye) + "</td>" +
      '<td class="num">' + H.esc(H.money(p.salary)) + "</td>" +
      '<td class="num col-lo">' + (p.years > 0 ? p.years : (p.years === 0 ? "Exp" : "—")) + "</td>" +
      "</tr>";
  }
  // The section head every Roster → Players view uses (same markup and labels: QB … DB, Other, Active, IR, Taxi).
  function sectionHead(sec, colspan) {
    return '<tr class="fo-group-row"><td colspan="' + colspan + '"><span class="fo-pos ' + H.esc(sec.key) + '">' + H.esc(sec.label) + '</span> <span class="small">' + sec.rows.length + "</span></td></tr>";
  }
  // The visible legend under the basis line: who a rank is among, its minimum, and what Start / Boom / Bust mean (never hover-only).
  function perfLegend(ss) {
    var out = "";
    if (ss && ss.rankMinimum && ss.seasonWeeks && ss.seasonWeeks.length) {
      var ms = ss.rankMinimum(0), ml = ss.rankMinimum(4);
      out += '<p class="fo-basis fo-perf-legend" data-legend="ranks">Ranks are among every MFL-scored player at the same lineup position, free agents too (e.g. #4 RB). ' +
        "Pts and PPG ranks need " + ms + "+ MFL wk" + (ms === 1 ? "" : "s") + "; L4 rank needs " + ml + "+ of the last 4 final wks.</p>";
    }
    var e = DATA.get("starterRates");
    if (!e) out += '<p class="fo-basis fo-perf-legend" data-legend="rates">Start / Boom / Bust: reading the starter-pool numbers…</p>';
    else if (e.state !== "ok") out += '<p class="fo-basis fo-perf-legend warn" data-legend="rates">Start / Boom / Bust couldn’t be read right now, so they show —. Reload to retry.</p>';
    else {
      var d = e.data, pend = (d.pending_weeks || []).filter(function (w) { return w > 0; });
      out += '<p class="fo-basis fo-perf-legend" data-legend="rates">Start / Boom / Bust: each final week he played (' + H.esc(d.weeks_label || "no final weeks yet") +
        (pend.length ? "; Wk " + H.esc(pend.join(", ")) + " not graded yet" : "") + ") vs that week’s UPS starters at his position. " +
        "Start = usable (their median or better), Boom = elite (top quarter), Bust = dud (bottom quarter). Needs 3+ graded weeks, else “Not enough games”.</p>";
      out += '<p class="fo-basis fo-perf-legend" data-legend="split">Every Boom week is also a Start week (the top quarter is above the median), so Start includes Boom. ' +
        "Week split counts each graded week once: Boom · Start only · Middle (below the median, not a Bust) · Bust, adding up to his graded weeks.</p>";
      // Two bases, said on the page: points count every MFL-posted week (a week in progress too); grades count final weeks
      // he played. When their last weeks differ, a player's week counts can too (Dak Prescott: 6 MFL wks vs 7 graded).
      var thru = root.UPS_FO_ROSTER_CORE.ratesThrough(d), pw = ss && ss.seasonWeeks && ss.seasonWeeks.length ? ss.seasonWeeks[ss.seasonWeeks.length - 1] : 0;
      out += '<p class="fo-basis fo-perf-legend' + (pw && thru && pw !== thru ? " warn" : "") + '" data-legend="bases">Week counts: “MFL wks” (under PPG) = weeks MFL posted a score for him' +
        (pw ? " (through Wk " + pw + ")" : "") + "; “graded wks” = final weeks he played" + (thru ? " (through Wk " + thru + ")" : "") + ". Byes and games he missed are in neither." +
        (pw && thru && pw !== thru ? " They run through different weeks right now, so they can differ." : "") + "</p>";
    }
    return out;
  }
  function renderPerf() {
    var wrap = document.getElementById("fo-perf-wrap");
    if (!wrap) return;
    var contract = document.getElementById("fo-contract-table-wrap"), schedWrap = document.getElementById("fo-sched-wrap");
    wrap.hidden = colset !== "perf";
    if (contract) contract.hidden = colset !== "contract";
    if (schedWrap) schedWrap.hidden = colset !== "sched";
    if (colset === "sched") { renderSched(schedWrap); return; }
    if (colset !== "perf") return;
    H.wireClicks(wrap);
    var ss = H.scoring(), se = DATA.get("scores");
    var week = lineupWeek();
    var F = root.UPS_PLAYER_FACTS;
    var basis = F ? F.basis(ss) : { text: "", warn: true };
    if (!se) { H.loading(wrap, "Reading MFL’s scores…"); return; }
    var C = root.UPS_FO_ROSTER_CORE;
    if (!C) { wrap.innerHTML = H.banner("The Performance view didn’t load. Reload to retry.", "warn"); return; }
    if (!srAsked) { srAsked = true; DATA.load("starterRates").then(function () { if (colset === "perf") renderPerf(); }); }
    var rows = perfRows();
    var multi = FO.selectedTeam() === "__all__";
    var head = "<thead><tr>" + th("name", "Player", "", "") + th("", "Lineup", "Slot in this week's best legal lineup by season PPG (taxi, IR and players ruled Out excluded)", "") +
      th("pts", "Pts", "MFL points, league scoring, every week MFL posted", "num") +
      th("ptsrank", "Pts rank", "Season-points rank at the lineup position among every player MFL scored, with the same minimum weeks as the PPG rank", "num") +
      th("ppg", "PPG", "Points per MFL-scored week (0.0 counts; a bye doesn't)", "num") +
      th("rank", "PPG rank", "PPG rank at the player's lineup position among every player MFL scored, with at least half the final weeks", "num") +
      th("l4", "L4", "PPG over the last 4 final weeks — context only; season PPG is the better guide", "num") +
      th("l4rank", "L4 rank", "Last-4-weeks PPG rank at the lineup position among every player MFL scored, with 2+ of those weeks", "num") +
      th("start", "Start", "Usable weeks: at or above that week's UPS-starter median at his position (count of graded weeks under it)", "num") +
      th("boom", "Boom", "Elite weeks: at or above that week's UPS-starter 75th percentile", "num") +
      th("bust", "Bust", "Dud weeks: at or below that week's UPS-starter 25th percentile", "num") +
      th("", "Week split", "Each graded week once: Boom · Start only · Middle · Bust; they add up to the graded weeks", "num") +
      th("", week ? "Wk " + week : "Next", "Opponent and kickoff for this lineup week (MFL schedule)", "") +
      th("proj", week ? "Wk " + week + " proj" : "Proj", "MFL's projection for this lineup week — a forecast, not a result", "num") +
      th("bye", "Bye", "NFL bye week (MFL)", "num col-md") + th("salary", "Salary", "This season's salary", "num") + th("years", "Yrs", "Years left on the contract", "num col-lo") + "</tr></thead>";
    var body = "";
    if (!rows.length) body = '<tr><td colspan="' + NCOL + '" class="fo-table-empty">No players match the current filters.</td></tr>';
    else {
      // Active → IR → Taxi in every view; By position splits the active players by position (a column sort lists them together).
      C.sections(rows, { byPosition: FO.groupByPosition() && !sort.key, player: function (r) { return r.p; }, posOf: function (r) { return r.group; } }).forEach(function (sec) {
        body += sectionHead(sec, NCOL) + applySort(sec.rows).map(function (r) { return rowHtml(r, multi); }).join("");
      });
    }
    wrap.innerHTML = '<p class="fo-basis' + (basis.warn ? " warn" : "") + '">' + H.esc(basis.text) +
      (projMap(week) ? " · Wk " + week + " proj = MFL projection" : "") + "</p>" + perfLegend(ss) +
      '<div class="fo-table-scroll"><table class="fo-table fo-perf-table">' + head + "<tbody>" + body + "</tbody></table></div>";
    if (ss) H.setFreshness("MFL read " + H.clock(ss.fetchedAt));
  }
  // ── Schedule (Roster → Players → Schedule) ───────────────────────────
  // Players are ROWS and league weeks are COLUMNS (W8, W9, …): five weeks fit a 320 px phone without sideways scroll. Default = the next five
  // UPS league weeks (byes count as a week); Rest of season = the same grid in blocks of five weeks. Each week cell shows the opponent
  // (@ = away) and that opponent's "vs usual" % at the player's position: what it has ALLOWED SO FAR over the weeks already played.
  // Green = it allowed more than usual, red = less (10% or more, 3+ games counted; see player_schedule.js); no color = about usual, too few games, or no number.
  // The number is always printed, so color is never the only signal. It describes past points allowed; it is not a forecast. One
  // /api/fantasy-sos?season=<season>&v=2 answer feeds the whole page (DATA "sos"), never per player or per week; no D1 query here.
  var sched = { mode: "next5" };
  var schedCells = {};      // pid|wk -> { p, cell } for the detail panel (rebuilt on every render)
  function schedControls() {
    var b = function (m, label) { return '<button type="button" class="fo-subview-chip' + (sched.mode === m ? " active" : "") + '" data-schedmode="' + m + '" aria-pressed="' + (sched.mode === m) + '">' + label + "</button>"; };
    return '<div class="fo-choice-row"><div class="fo-choice-group"><div class="fo-choice-label" id="fo-lbl-schedwk">Weeks</div>' +
      '<div class="fo-subview-chips fo-choice" role="group" aria-labelledby="fo-lbl-schedwk">' + b("next5", "Next 5 weeks") + b("rest", "Rest of season") + "</div></div></div>";
  }
  function schedLegend() {
    return '<ul class="fo-sched-legend" aria-label="How to read the weeks">' +
      '<li><span class="fo-sched-key fo-sched-more" aria-hidden="true">+12%</span> Green: that opponent has allowed 10% or more above usual at the position</li>' +
      '<li><span class="fo-sched-key fo-sched-less" aria-hidden="true">−12%</span> Red: it has allowed 10% or more below usual</li>' +
      '<li><span class="fo-sched-key" aria-hidden="true">+3%</span> No color: within 9% of usual, fewer than 3 games counted, or no number yet</li>' +
      '<li><span class="fo-sched-key" aria-hidden="true">@DEN</span> @ = away game; no @ = home; BYE = bye week; — = no game or no number</li>' +
      '<li>Each week: opponent, <b>vs usual %</b>, then <b>/g</b> = points it has allowed per game to the position, then <b>rank</b> out of 32 (1st = allowed the most). Tap a week for kickoff and the full explanation.</li></ul>';
  }
  function schedCell(c, pos, p) {
    var P = root.UPS_PLAYER_SCHEDULE;
    if (c.kind === "bye") return '<td class="fo-sched-c fo-sched-bye"><span class="fo-sched-opp">BYE</span></td>';
    if (c.kind !== "game") return '<td class="fo-sched-c"><span class="fo-muted" title="No game listed">—</span></td>';
    var a = c.allowed, tone = P.tone(a), cp = P.allowedCompact(a), parts = P.allowedParts(a);
    var key = p.id + "|" + c.wk; schedCells[key] = { p: p, cell: c, pos: pos };
    var label = "Week " + c.wk + ", " + (c.home ? "home vs " : "away at ") + c.opp + ". " +
      (cp.pct || cp.pg || cp.rank ? [parts.vs, parts.pg, parts.rank].filter(Boolean).join(", ") + ". " : "No number yet. ") + "Opens the details.";
    return '<td class="fo-sched-c' + (tone === "more" ? " fo-sched-more" : tone === "less" ? " fo-sched-less" : "") + '">' +
      '<button type="button" class="fo-sched-btn" data-sched-cell="' + H.esc(key) + '" aria-label="' + H.esc(label) + '">' +
      '<span class="fo-sched-opp">' + (c.home ? "" : "@") + H.esc(c.opp) + '</span><span class="fo-sched-pct">' + H.esc(cp.pct || "—") + "</span>" +
      '<span class="fo-sched-sub">' + H.esc(cp.pg || "—") + '</span><span class="fo-sched-sub">' + H.esc(cp.rank || "—") + "</span></button></td>";
  }
  // The tap / keyboard detail panel (the Front Office's own dialog), not a hover tooltip.
  function openSchedDetail(btn) {
    var P = root.UPS_PLAYER_SCHEDULE, e = DATA.get("sos"), rec = schedCells[btn.getAttribute("data-sched-cell")];
    if (!P || !rec || !e || e.state !== "ok") return;
    var d = P.detail(e.data, rec.cell, rec.pos, rec.p.name);
    var html = '<dl class="fo-sched-detail">' + d.rows.map(function (r) { return "<dt>" + H.esc(r[0]) + "</dt><dd>" + H.esc(r[1]) + "</dd>"; }).join("") + "</dl>" +
      d.notes.map(function (n) { return '<p class="fo-basis">' + H.esc(n) + "</p>"; }).join("");
    H.openDialog(d.title, html, { returnFocus: function () { return btn; } });
  }
  function schedRowHtml(it, weeks, multi) {
    var p = it.p, r = it.r, span = weeks.length + 1;
    var who = '<th scope="row" class="fo-sched-who fo-perf-player">' + H.playerCell(p, { multi: multi }) + "</th>";
    if (r.state === "no_team") return "<tr>" + who + '<td colspan="' + weeks.length + '" class="fo-muted fo-sched-note">No NFL team is listed for him, so there is no schedule.</td></tr>';
    if (r.state === "no_pos") return "<tr>" + who + '<td colspan="' + weeks.length + '" class="fo-muted fo-sched-note">The schedule numbers cover QB, RB, WR, TE, DL, LB, DB, K and P; not this position.</td></tr>';
    if (r.state === "no_sched") return "<tr>" + who + '<td colspan="' + weeks.length + '" class="fo-muted fo-sched-note">' + H.esc(String(p.nflTeam).toUpperCase()) + " is not in the schedule data.</td></tr>";
    var byWk = {}; r.cells.forEach(function (c) { byWk[c.wk] = c; });
    return "<tr>" + who + weeks.map(function (w) { return schedCell(byWk[w] || { wk: w, kind: "none" }, r.pos, p); }).join("") + "</tr>";
  }
  // One grid of players (rows) by league weeks (columns). Next 5 = five fixed columns. Rest of season = ALL remaining weeks in ONE grid that swipes
  // sideways inside its own box while the player column stays pinned; the page itself never scrolls sideways.
  function schedGrid(weeks, items, multi, grouped, scroll) {
    var body = "";
    var order = function (list) { return list.slice().sort(function (a, b2) { return String(a.p.name || "").localeCompare(String(b2.p.name || "")); }); };
    // Active → IR → Taxi, the same sections (order and labels) as Performance and Contract.
    root.UPS_FO_ROSTER_CORE.sections(items, { byPosition: grouped, player: function (it) { return it.p; }, posOf: function (it) { return it.group; } }).forEach(function (sec) {
      // the section label lives in the pinned first column, so it stays in view while the weeks swipe
      body += '<tr class="fo-group-row"><th scope="rowgroup" class="fo-sched-who fo-sched-grouphead"><span class="fo-pos ' + H.esc(sec.key) + '">' + H.esc(sec.label) + '</span> <span class="small">' + sec.rows.length + '</span></th><td colspan="' + weeks.length + '"></td></tr>';
      body += order(sec.rows).map(function (it) { return schedRowHtml(it, weeks, multi); }).join("");
    });
    var head = '<tr><th scope="col" class="fo-sched-whohead">Player</th>' + weeks.map(function (w) { return '<th scope="col" class="num" title="League week ' + w + '">W' + w + "</th>"; }).join("") + "</tr>";
    var table = '<table class="fo-table fo-sched-grid' + (scroll ? " fo-sched-wide" : "") + '"' + (scroll ? ' style="--n:' + weeks.length + '"' : "") + "><thead>" + head + "</thead><tbody>" + body + "</tbody></table>";
    if (!scroll) return table;
    return '<div class="fo-sched-scrollwrap" data-left="0" data-right="1"><div class="fo-sched-scroll" tabindex="0" role="region" aria-label="Schedule for the rest of the season: swipe sideways for later weeks. The player column stays in place.">' + table +
      '</div><span class="fo-sched-fade fo-sched-fade-l" aria-hidden="true"></span><span class="fo-sched-fade fo-sched-fade-r" aria-hidden="true"></span></div>';
  }
  // Keeps the edge shadows honest: a shadow shows on a side only while more weeks are hidden on that side.
  function wireSchedScroll(el) {
    Array.prototype.forEach.call(el.querySelectorAll(".fo-sched-scrollwrap"), function (w) {
      var sc = w.querySelector(".fo-sched-scroll");
      var upd = function () {
        var max = sc.scrollWidth - sc.clientWidth;
        w.setAttribute("data-left", sc.scrollLeft > 2 ? "1" : "0");
        w.setAttribute("data-right", max > 2 && sc.scrollLeft < max - 2 ? "1" : "0");
      };
      sc.addEventListener("scroll", upd, { passive: true });
      upd();
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(upd);
    });
  }
  function renderSched(el) {
    var P = root.UPS_PLAYER_SCHEDULE;
    if (!el) return;
    H.wireClicks(el);
    if (!P || !root.UPS_FO_ROSTER_CORE) { el.innerHTML = H.banner("The schedule view didn’t load. Reload to retry.", "warn"); return; }
    var e = DATA.get("sos");
    if (!e) {
      DATA.load("sos").then(function () { if (colset === "sched") renderPerf(); });
      H.loading(el, "Reading the schedule…"); return;
    }
    if (e.state !== "ok") { el.innerHTML = H.banner("The schedule couldn’t be read right now, so this view is off. Reload to retry.", "warn"); return; }
    var d = e.data, wl = P.weekList(d, sched.mode), b = P.basis(d);
    schedCells = {};
    var head = schedControls();
    if (!wl.weeks.length) { el.innerHTML = head + H.banner(wl.note, "info"); return; }
    var rows = FO.visibleRows() || [];
    var multi = FO.selectedTeam() === "__all__";
    var note = b.none
      ? "No " + H.esc(String(d.year || "")) + " games have been played yet, so opponents have no numbers yet."
      : "Each number is how far above or below usual that opponent has allowed at the player’s position in " + H.esc(b.label) + " (allowed so far, the weeks already played). It describes past points allowed; it is not a forecast.";
    if (!rows.length) { el.innerHTML = head + '<p class="fo-basis">' + note + '</p><p class="fo-table-empty">No players match the current filters.</p>'; return; }
    var items = rows.map(function (p) { var g = H.groupOf(p.id) || ""; return { p: p, group: g, r: P.playerRows(d, { nflTeam: p.nflTeam, group: g }, wl.weeks) }; });
    var scroll = sched.mode === "rest";
    el.innerHTML = head + '<p class="fo-basis">' + note + "</p>" + (b.none ? "" : schedLegend()) +
      (scroll ? '<p class="fo-sched-hint">' + H.esc(P.weeksLabel(wl.weeks[0], wl.weeks[wl.weeks.length - 1])) + ": swipe sideways for later weeks. The player column stays in place. <span aria-hidden=\"true\">→</span></p>" : "") +
      schedGrid(wl.weeks, items, multi, FO.groupByPosition(), scroll);
    wireSchedScroll(el);
  }
  function wirePerf() {
    var cs = document.getElementById("fo-colset");
    if (cs && !cs.__foWired) {
      cs.__foWired = true;
      cs.addEventListener("click", function (e) {
        var b = e.target && e.target.closest ? e.target.closest("[data-colset]") : null;
        if (!b) return;
        colset = b.getAttribute("data-colset");
        if (colset === "sched") DATA.load("sos").then(function () { if (colset === "sched") renderPerf(); }, function () { if (colset === "sched") renderPerf(); });
        Array.prototype.forEach.call(cs.querySelectorAll("[data-colset]"), function (x) {
          var on = x === b; x.classList.toggle("active", on); x.setAttribute("aria-pressed", on ? "true" : "false");
        });
        renderPerf();
      });
    }
    var sw = document.getElementById("fo-sched-wrap");
    if (sw && !sw.__schedWired) {
      sw.__schedWired = true;
      sw.addEventListener("click", function (e) {
        var b = e.target && e.target.closest ? e.target.closest("[data-schedmode]") : null;
        if (!b) return;
        sched.mode = b.getAttribute("data-schedmode");
        renderPerf();
      });
      sw.addEventListener("click", function (e) {
        var c = e.target && e.target.closest ? e.target.closest("[data-sched-cell]") : null;
        if (c) openSchedDetail(c);
      });
    }
    var wrap = document.getElementById("fo-perf-wrap");
    if (wrap && !wrap.__sortWired) {
      wrap.__sortWired = true;
      wrap.addEventListener("click", function (e) {
        var b = e.target && e.target.closest ? e.target.closest("[data-perf-sort]") : null;
        if (!b) return;
        var k = b.getAttribute("data-perf-sort");
        sort = sort.key === k ? { key: k, dir: -sort.dir } : { key: k, dir: k === "name" ? 1 : -1 };
        renderPerf();
      });
    }
  }

  // ── Bye planner ───────────────────────────────────────────────────
  var ROWS = [
    { label: "QB", slots: ["QB1"] }, { label: "RB", slots: ["RB1", "RB2"] }, { label: "WR", slots: ["WR1", "WR2"] }, { label: "TE", slots: ["TE1"] },
    { label: "Flex", slots: ["OF1", "OF2"] }, { label: "SuperFlex", slots: ["SF1"] }, { label: "K", slots: ["PK1"] }, { label: "P", slots: ["PN1"] },
    { label: "DL", slots: ["DL1", "DL2"] }, { label: "LB", slots: ["LB1", "LB2"] }, { label: "DB", slots: ["DB1", "DB2"] }, { label: "D-Flex", slots: ["DF1"] }
  ];
  var ROW_GROUPS = { QB: ["QB"], RB: ["RB"], WR: ["WR"], TE: ["TE"], Flex: ["RB", "WR", "TE"], SuperFlex: ["QB", "RB", "WR", "TE"], K: ["PK"], P: ["PN"], DL: ["DL"], LB: ["LB"], DB: ["DB"], "D-Flex": ["DL", "LB", "DB"] };
  var REASON = { bye: "bye", injury: "injury", ir: "IR", taxi: "taxi", no_team: "no NFL team" };

  function focusFid() {
    var me = FO.viewerFid(), sel = FO.selectedTeam();
    if (sel && sel !== "__all__") return sel;
    return me && FO.teams().some(function (t) { return t.fid === me; }) ? me : "";
  }

  function renderBye() {
    var el = document.getElementById("fo-bye-body");
    if (!el) return;
    H.wireClicks(el);
    var BP = root.UPS_BYE_PLANNER, fid = focusFid();
    if (!fid) { el.innerHTML = H.banner("Pick a team (Roster → Team) to plan its byes.", "info"); return; }
    var ss = H.scoring(), byes = byeMap(), week = lineupWeek();
    var se = DATA.get("scores"), be = DATA.get("byes");
    if (!se || !be) { H.loading(el, "Reading MFL’s scores and bye weeks…"); return; }
    if (!ss || !byes || !week) { el.innerHTML = H.banner(!byes ? "MFL’s bye weeks couldn’t be read, so the planner is off." : "MFL’s scores couldn’t be read, so the planner is off.", "warn"); return; }
    var team = H.modelTeams().filter(function (t) { return t.fid === fid; })[0];
    var fas = H.freeAgents();
    var plan = BP.plan({ players: team.players, values: H.values(0), byeWeekByTeam: byes, fromWeek: week, toWeek: 17, currentWeek: week, freeAgents: fas });
    var nameOf = {}; team.players.forEach(function (p) { nameOf[p.pid] = p; });
    if (byeView.week == null || byeView.week < week) byeView.week = (plan.worst && plan.worst.empty.length ? plan.worst.week : week);

    var weeksHead = plan.weeks.map(function (w) {
      var hot = w.empty.length ? " short" : "";
      // The grid's column heads are plain text (a click still selects the week); the labeled choice above the grid is the control.
      return '<th scope="col" class="fo-bye-wk' + hot + (w.week === byeView.week ? " sel" : "") + '" data-bye-week="' + w.week + '">Wk ' + w.week +
        '<span class="fo-bye-cost">' + (w.cost > 0.05 ? "−" + H.fmt1(w.cost) : "·") + "</span></th>";
    }).join("");
    var weekChoice = '<div class="fo-choice-group"><div class="fo-choice-label" id="fo-lbl-bye">Week to inspect</div>' +
      '<div class="fo-subview-chips fo-choice fo-choice-weeks" role="group" aria-labelledby="fo-lbl-bye">' + plan.weeks.map(function (w) {
        return '<button type="button" class="fo-subview-chip' + (w.week === byeView.week ? " active" : "") + '" data-bye-week="' + w.week + '" aria-pressed="' + (w.week === byeView.week) + '"' +
          (w.empty.length ? ' title="Lineup shortage this week"' : "") + ">Wk " + w.week +
          '<span class="fo-choice-sub">' + (w.empty.length ? "short" : (w.cost > 0.05 ? "−" + H.fmt1(w.cost) : "·")) + "</span></button>";
      }).join("") + "</div></div>";
    var rows = ROWS.filter(function (r) { return byeView.pos === "ALL" || ROW_GROUPS[r.label].indexOf(byeView.pos) !== -1; }).map(function (r) {
      var cells = plan.weeks.map(function (w) {
        var need = r.slots.length, empty = r.slots.filter(function (sid) { return w.empty.indexOf(sid) !== -1; }).length;
        var filled = need - empty;
        var benchIn = r.slots.filter(function (sid) { var pid = w.slots[sid]; return pid && !plan.fullStarters[pid]; }).length;
        var cls = empty ? "empty" : (benchIn ? "sub" : "ok");
        var title = empty ? empty + " of " + need + " empty — no eligible player" : (benchIn ? benchIn + " filled by a bench player" : "full strength");
        return '<td class="fo-bye-cell ' + cls + (w.week === byeView.week ? " sel" : "") + '" title="' + H.esc(r.label + " Wk " + w.week + ": " + title) + '">' + filled + "/" + need + "</td>";
      }).join("");
      return '<tr><th scope="row">' + H.esc(r.label) + "</th>" + cells + "</tr>";
    }).join("");

    var wsel = plan.weeks.filter(function (w) { return w.week === byeView.week; })[0] || plan.weeks[0];
    var outRows = wsel.out.filter(function (o) {
      if (byeView.pos !== "ALL") { var p = nameOf[o.pid]; var L = root.UPS_FRONT_OFFICE_LINEUP; if (!p || L.posGroup(p.pos) !== byeView.pos) return false; }
      return true;
    });
    var outHtml = outRows.length ? '<ul class="fo-bye-out">' + outRows.map(function (o) {
      var p = nameOf[o.pid];
      return "<li>" + H.playerButton(o.pid, fid, p ? p.name : o.pid) + ' <span class="fo-muted">' + H.esc((p ? p.pos + " · " + p.nflTeam : "")) + "</span> — " + H.esc(REASON[o.reason] || o.reason) + "</li>";
    }).join("") + "</ul>" : '<p class="fo-ov-empty">' + "Nobody is out." + "</p>";
    var opts = "";
    if (wsel.empty.length) {
      var lines = Object.keys(wsel.options).filter(function (g) { return wsel.options[g] && wsel.options[g].length; }).map(function (g) {
        return "<li><b>" + H.esc(g) + "</b>: " + wsel.options[g].map(function (fa) {
          return H.playerButton(fa.pid, "", fa.name || fa.pid) + ' <span class="fo-muted">' + H.esc(fa.nflTeam) + " · " + H.fmt1(fa.v) + " PPG</span>";
        }).join(", ") + "</li>";
      }).join("");
      opts = '<h4 class="fo-bye-h">Free agents with a game in Week ' + wsel.week + ' <span class="fo-muted">(options, not recommendations; by season PPG)</span></h4>' +
        (lines ? '<ul class="fo-bye-out">' + lines + "</ul>" : '<p class="fo-ov-empty">No free agent with a game fits these slots.</p>') +
        '<p class="fo-muted fo-perf-sub">Waiver timing for each is on the phone app’s Market (bids) and in Market here.</p>';
    }

    el.innerHTML =
      '<div class="fo-card"><div class="fo-card-head"><h2>Bye planner · ' + H.esc(H.teamName(fid)) + "</h2>" +
      '<label class="fo-field fo-inline">Position <select data-bye-pos>' + ["ALL"].concat(GROUP_ORDER).map(function (g) { return '<option value="' + g + '"' + (g === byeView.pos ? " selected" : "") + ">" + (g === "ALL" ? "All" : g === "PK" ? "K" : g === "PN" ? "P" : g) + "</option>"; }).join("") + "</select></label></div>" +
      '<p class="fo-basis">Slots you can fill / slots required (best lineup by season PPG). <span class="fo-bye-key empty">red</span> empty slot · <span class="fo-bye-key sub">amber</span> a bench player starts · column top = points a week lost to byes and absences.</p>' +
      weekChoice +
      (plan.shortWeeks.length ? H.banner("Lineup shortage in Week " + plan.shortWeeks.join(", ") + ".", "warn") : "") +
      '<div class="fo-table-scroll"><table class="fo-table fo-bye-grid"><thead><tr><th scope="col">Slots</th>' + weeksHead + "</tr></thead><tbody>" + rows + "</tbody></table></div></div>" +
      '<div class="fo-card"><h3 class="fo-bye-h">Week ' + wsel.week + ": who’s out</h3>" + outHtml + opts + "</div>";
  }
  function wireBye() {
    var el = document.getElementById("fo-bye-body");
    if (!el || el.__byeWired) return;
    el.__byeWired = true;
    el.addEventListener("click", function (e) {
      var t = e.target && e.target.closest ? e.target.closest("[data-bye-week]") : null;
      if (!t) return;
      if (t.hasAttribute("data-bye-week")) byeView.week = parseInt(t.getAttribute("data-bye-week"), 10);
      renderBye();
    });
    el.addEventListener("change", function (e) {
      if (e.target && e.target.hasAttribute && e.target.hasAttribute("data-bye-pos")) { byeView.pos = e.target.value; renderBye(); }
    });
  }

  function loadFor(section) {
    var week = lineupWeek();
    var keys = section === "bye" ? ["scores", "players", "byes"] : ["scores", "players", "byes"];
    keys.forEach(function (k) { DATA.load(k).then(function () { rerender(section); afterScores(section); }); });
    if (week && section === "roster") { DATA.load("projections", week).then(function () { rerender(section); }); DATA.load("nflSchedule", week).then(function () { rerender(section); }); }
  }
  function afterScores(section) {
    var week = lineupWeek();
    if (week && section === "roster") {
      if (!DATA.get("projections", week)) DATA.load("projections", week).then(function () { rerender(section); });
      if (!DATA.get("nflSchedule", week)) DATA.load("nflSchedule", week).then(function () { rerender(section); });
    }
  }
  function rerender(section) {
    var active = document.querySelector(".fo-section.active");
    var cur = active ? active.getAttribute("data-section") : "";
    if (section === "roster" && cur === "roster") renderPerf();
    if (section === "bye" && cur === "bye") renderBye();
  }

  function boot() {
    H = root.UPS_FO_HUB; FO = root.UPS_FO; DATA = root.UPS_FO_DATA;
    if (!H || !FO || !DATA) return;
    wirePerf(); wireBye();
    H.registerAbout("roster", "<h3>Roster → Performance</h3><ul>" +
      "<li><b>Lineup:</b> the player’s slot in this week’s best legal 18-player lineup by season PPG (taxi, IR and players ruled Out don’t start).</li>" +
      "<li><b>Pts / PPG / PPG rank:</b> MFL’s own league scoring; PPG per MFL-scored week; rank at the lineup position among every player MFL scored (free agents too) with at least half the final weeks. Same as the phone.</li>" +
      "<li><b>Pts rank:</b> season points, ranked the same way with the same minimum.</li>" +
      "<li><b>L4 / L4 rank:</b> PPG over the last 4 final weeks and its rank (2+ of those weeks). Context only: in a 2022–2025 backtest, season PPG predicted the rest of the season better than the last 3–4 weeks at every position but punter.</li>" +
      "<li><b>Start / Boom / Bust:</b> the phone’s starter-pool numbers (Stats → Boom/Bust). Each final week he played is compared with that week’s UPS starters at his position: Start = usable (their median or better), Boom = elite (top quarter), Bust = dud (bottom quarter). A 0.0 in a game he played counts; games he didn’t play aren’t graded. Shown with 3+ graded weeks. Every Boom week is also a Start week; <b>Week split</b> counts each graded week once (Boom · Start only · Middle · Bust) and adds up to his graded weeks, which can differ from his MFL weeks (final weeks he played only).</li>" +
      "<li><b>📰</b> beside a name: a news headline from the last 7 days (tap for News). News never marks a player injured; the colored chip is the injury status (MFL, checked against the official NFL report).</li>" +
      "<li><b>Groups:</b> Active players first (by position when grouped), then IR, then Taxi, in Performance, Contract and Schedule.</li>" +
      "<li><b>Wk N / Wk N proj / Bye:</b> MFL’s NFL schedule, MFL’s projection for that week (a forecast) and MFL’s bye weeks.</li>" +
      "<li><b>Contract</b> columns (Contract chip): the contract ledger, unchanged.</li></ul>");
    H.registerAbout("bye", "<h3>Bye planner</h3><p>For every remaining week, your best legal 18-player lineup from the players who can play (by season PPG) against your full-strength lineup. " +
      "An empty slot means no eligible player at all. Taxi and IR players never start; IR, PUP, NFI, suspensions and holdouts count every week; an Out designation only this week (next week’s report doesn’t exist yet). Free agents listed for a short week have a game that week; they are options, not recommendations.</p>");
    renderPerf();
  }
  if (root.UPS_FO_HUB) { root.UPS_FO_HUB.registerView("bye"); }
  // Pure pieces, for tests.
  root.UPS_FO_ROSTER = { parseSchedule: parseSchedule, parseProjections: parseProjections, ROWS: ROWS, SLOT_LABEL: SLOT_LABEL };
  document.addEventListener("fo:ready", boot);
  document.addEventListener("fo:roster", function () { if (H) renderPerf(); });
  document.addEventListener("fo:injury", function () { if (H) { rerender("roster"); rerender("bye"); } });
  document.addEventListener("fo:tab", function (e) {
    if (!H) return;
    var s = e.detail && e.detail.section;
    if (s === "roster") { renderPerf(); loadFor("roster"); }
    if (s === "bye") { renderBye(); loadFor("bye"); }
  });
})(typeof window !== "undefined" ? window : this);
