/* UPS Mobile — Live Scoring scoreboard (#scores).
   ───────────────────────────────────────────────────────────────────────
   Port of the desktop GameDay Live Scoring board (site/gameday/gameday.html)
   to mobile: My team + each opponent as tap-to-expand rows (Won/Lost/Tied by
   game state), an All-Play board, live-adjusted projections, a year/week
   filter, and tap-a-player → the MFL Detailed Results breakdown (the keyless
   /api/mfl-detailed report — first downs, sack yards lost, gross punt yards,
   per-FG distances, full IDP; MFL-exact for any week).

   Data: liveScoring (current week) + weeklyResults (any past week, keyless)
   lazy-loaded per selected week; injuries are the app-global current feed;
   projectedScores (keyless, current week) drives the live remaining-proj blend.
   Reached via the Home "Live Scoring" tile. */
(function () {
  "use strict";
  if (!window.UPS_MOBILE) return;
  var M = window.UPS_MOBILE;
  var U = M.util;
  var DATA = M.data;
  var API = M.api;

  var SIGMA_BASE = 30, SB_POLL_MS = 30000;

  function esc(v) { return U.escapeHtml(v); }
  function pad4(v) { return U.pad4(v); }
  function asArray(v) { return U.asArray(v); }
  function s(v) { return U.safeStr(v); }
  function fmtPts(n) { return (Math.round((Number(n) || 0) * 10) / 10).toFixed(1); }
  function ctx() { return M.state.ctx; }
  function leagueId() { return ctx().leagueId; }
  function renderRoute() { M.route.renderRoute(); }
  function playerById(pid) { return DATA.playerById(pid) || {}; }
  function nameFromMfl(raw) {
    raw = s(raw);
    var i = raw.indexOf(",");
    if (i >= 0) { var last = raw.slice(0, i).trim(), rest = raw.slice(i + 1).trim(); return rest ? rest + " " + last : last; }
    return raw;
  }

  // standard normal CDF (Abramowitz-Stegun 26.2.17)
  function normCdf(z) {
    var t = 1 / (1 + 0.2316419 * Math.abs(z));
    var d = 0.3989422804 * Math.exp(-z * z / 2);
    var p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - p : p;
  }
  function injuryFactor(status) {
    var st = s(status).toUpperCase();
    if (!st) return 1;
    if (st.indexOf("OUT") >= 0 || st.indexOf("IR") >= 0 || st.indexOf("PUP") >= 0 || st.indexOf("SUSP") >= 0) return 0;
    if (st.indexOf("DOUB") >= 0) return 0.40;
    if (st.indexOf("QUES") >= 0) return 0.75;
    return 1;
  }
  function injuryShort(status) {
    var st = s(status).toUpperCase();
    if (!st) return "";
    if (st.indexOf("OUT") >= 0) return "OUT";
    if (st.indexOf("IR") >= 0) return "IR";
    if (st.indexOf("DOUB") >= 0) return "D";
    if (st.indexOf("QUES") >= 0) return "Q";
    if (st.indexOf("PUP") >= 0) return "PUP";
    if (st.indexOf("SUSP") >= 0) return "SUS";
    return st.slice(0, 3);
  }

  // ---- year/week filter + data load ----
  function sbYear() { return M.state.sbYear || ctx().year; }
  function sbWeekSel() { return M.state.sbWeek || ""; }
  // Per-season MFL league_id + shard from D1 (/api/league-years). 74598 is 2017+;
  // pre-2017 seasons live on older shards under distinct ids + are cookie-gated
  // (the worker injects the cookie + the &SERVER= shard for those).
  function loadLeagueYears() {
    if (M.state.sbLeagueYears) return Promise.resolve(M.state.sbLeagueYears);
    if (M.state._lyPromise) return M.state._lyPromise;
    M.state._lyPromise = fetchJson(API.workerUrl("/api/league-years")).then(function (d) {
      var map = {};
      asArray(d && d.years).forEach(function (y) { if (y && y.season) map[String(y.season)] = { server: s(y.server) || "www48", league_id: s(y.league_id) }; });
      M.state.sbLeagueYears = map; return map;
    }).catch(function () { M.state.sbLeagueYears = {}; return {}; });
    return M.state._lyPromise;
  }
  function sbLeagueInfo(year) {
    var m = M.state.sbLeagueYears || {};
    return m[String(year)] || { server: "www48", league_id: leagueId() };
  }
  function sbLid() { return sbLeagueInfo(sbYear()).league_id; }
  function sbExportUrl(type, week) {
    var info = sbLeagueInfo(sbYear()), lid = info.league_id, srv = info.server || "www48";
    var url = API.workerUrl("/api/mfl-export") + "?TYPE=" + encodeURIComponent(type) +
      "&L=" + encodeURIComponent(lid) + "&YEAR=" + encodeURIComponent(sbYear()) + "&JSON=1&DETAILS=1";
    if (String(lid) !== "74598") url += "&SERVER=" + encodeURIComponent(srv);   // historical shard
    if (week) url += "&W=" + encodeURIComponent(week);
    return url;
  }
  function fetchJson(url) {
    return fetch(url, { mode: "cors", credentials: "omit" }).then(function (r) { return r.json(); }).catch(function () { return null; });
  }
  // Loads liveScoring (current) + weeklyResults (historical) + schedule (live-week
  // opponents) + league (that year's names) + projectedScores (live origProj) for
  // the selected week, then picks the source. Mirrors desktop loadScoreboard.
  function loadScoreboard(force) {
    if (M.state.sb && M.state.sb.loaded && !force) { scheduleSbPoll(); return; }
    if (!M.state.sb) M.state.sb = { loaded: false };
    loadLeagueYears().then(function () {   // resolve per-year league_id/shard first
    var wk = sbWeekSel();
    Promise.all([
      fetchJson(sbExportUrl("liveScoring", wk)),
      fetchJson(sbExportUrl("weeklyResults", wk)),
      fetchJson(sbExportUrl("schedule")),
      fetchJson(sbExportUrl("league")),
      fetchJson(sbExportUrl("projectedScores", wk)),
      fetchJson(sbExportUrl("playerScores", wk))   // every player's actual points → positional rank
    ]).then(function (r) {
      var live = r[0], weekly = r[1];
      var liveFr = (live && live.liveScoring && asArray(live.liveScoring.franchise).filter(function (f) { return f && f.id; })) || [];
      var source = liveFr.length ? "live" : ((weekly && weekly.weeklyResults && weekly.weeklyResults.matchup) ? "weekly" : "live");
      var franchises = [];
      try { franchises = asArray(r[3].league.franchises.franchise).map(function (f) { return { id: pad4(f.id), name: s(f.name) }; }); } catch (e) {}
      var proj = {};
      try { asArray(r[4].projectedScores.playerScore).forEach(function (p) { if (p && p.id) { var n = parseFloat(p.score); if (!isNaN(n)) proj[String(p.id)] = n; } }); } catch (e) {}
      var scores = {};
      try { asArray(r[5].playerScores.playerScore).forEach(function (p) { if (p && p.id) { var n = parseFloat(p.score); if (!isNaN(n)) scores[String(p.id)] = n; } }); } catch (e) {}
      M.state.sb = { loaded: true, source: source, live: live, weekly: weekly, schedule: r[2],
        franchises: franchises.length ? franchises : (M.state.franchises || []), proj: proj, scores: scores };
      try { M.state.sbAt = Date.now(); } catch (e) {}
      renderRoute(); scheduleSbPoll();
    }).catch(function () { M.state.sb = { loaded: true, error: true }; renderRoute(); });
    });
  }
  function sbSource() { return (M.state.sb && M.state.sb.source) || "live"; }
  function sbLive() { return (M.state.sb && M.state.sb.live && M.state.sb.live.liveScoring) || null; }
  function sbWeekly() { return (M.state.sb && M.state.sb.weekly && M.state.sb.weekly.weeklyResults) || null; }
  function sbFranchises() { return (M.state.sb && M.state.sb.franchises) || M.state.franchises || []; }
  function projFor(pid) { var m = (M.state.sb && M.state.sb.proj) || {}; var v = m[String(pid)]; return v == null ? 0 : v; }
  function sbWeek() {
    if (sbSource() === "weekly") { var wr = sbWeekly(); return wr ? String(wr.week || sbWeekSel() || "") : (sbWeekSel() || ""); }
    var ls = sbLive(); return ls ? String(ls.week || "") : (sbWeekSel() || "");
  }
  function injStatusFor(pid) { return (M.state.injuriesByPid || {})[String(pid)] || ""; }
  function anyGameLive() {
    if (sbSource() !== "live") return false;
    var ls = sbLive(); return ls ? asArray(ls.franchise).some(function (f) { return parseInt(f.playersCurrentlyPlaying, 10) > 0; }) : false;
  }
  function sbFranchiseRaw(fid) {
    fid = pad4(fid);
    if (sbSource() === "weekly") {
      var wr = sbWeekly(), found = null;
      if (wr) asArray(wr.matchup).forEach(function (m) { asArray(m.franchise).forEach(function (f) { if (pad4(f.id) === fid && !found) found = f; }); });
      return found;
    }
    var ls = sbLive(); if (!ls) return null;
    var direct = asArray(ls.franchise).filter(function (f) { return pad4(f.id) === fid; })[0];
    if (direct) return direct;
    var f2 = null;
    asArray(ls.matchup).forEach(function (m) { asArray(m.franchise).forEach(function (f) { if (pad4(f.id) === fid) f2 = f; }); });
    return f2;
  }
  function sbStarterRows(raw) { return asArray((raw && raw.players && raw.players.player) || (raw && raw.player) || []); }
  // Per-franchise computed line. Live → projection blend; weekly → final.
  function sbCompute(fid) {
    fid = pad4(fid);
    var meta = sbFranchises().filter(function (f) { return f.id === fid; })[0] || { id: fid, name: fid };
    var raw = sbFranchiseRaw(fid);
    if (!raw) return { fid: fid, name: meta.name, live: 0, projFinal: 0, origProj: 0, secRem: 0, slots: 0, starters: [], hasData: false };
    var live = sbSource() === "live";
    var teamScore = Number(raw.score || 0), remaining = 0, secRem = 0, origTot = 0, starters = [];
    sbStarterRows(raw).forEach(function (p) {
      if (String(p.status) !== "starter") return;
      var pid = String(p.id), pts = Number(p.score || 0);
      var gsr = live ? (parseInt(p.gameSecondsRemaining, 10) || 0) : 0;
      var status = live ? injStatusFor(pid) : "";
      var origProj = projFor(pid);   // ORIGINAL projection for the selected week (any week)
      var factor = injuryFactor(status);
      var rem = (!live || factor === 0) ? 0 : origProj * factor * (gsr / 3600);
      remaining += rem; secRem += gsr; origTot += origProj;
      var pm = playerById(pid);
      starters.push({ pid: pid, name: nameFromMfl(pm.name) || pid, pos: s(pm.position).toUpperCase(), nfl: s(pm.team),
        live: pts, gsr: gsr, status: status, origProj: origProj, projFinal: pts + rem,
        playing: live && gsr > 0 && gsr < 3600, done: !live || gsr <= 0, yet: live && gsr >= 3600 });
    });
    starters.sort(function (a, b) { return b.projFinal - a.projFinal; });
    return { fid: fid, name: meta.name, live: teamScore, projFinal: teamScore + remaining, origProj: origTot, secRem: secRem, slots: starters.length, starters: starters, hasData: true };
  }
  function winProb(a, b) {
    var diff = a.projFinal - b.projFinal;
    var slots = (a.slots + b.slots) || 1;
    var frac = Math.max(0, Math.min(1, (a.secRem + b.secRem) / (slots * 3600)));
    var sigma = SIGMA_BASE * Math.sqrt(frac);
    if (sigma < 0.5) return diff > 0 ? 1 : (diff < 0 ? 0 : 0.5);
    return normCdf(diff / sigma);
  }
  // Game state: "pre" (none started) | "live" | "final". Weekly is always final.
  function matchupState(me, o) {
    if (sbSource() === "weekly") return "final";
    var ss = (me.starters || []).concat(o.starters || []);
    if (!ss.length) return "pre";
    if (!ss.some(function (x) { return x.done || x.playing; })) return "pre";
    return ss.every(function (x) { return x.done; }) ? "final" : "live";
  }
  // Outcome pill from ACTUAL scores: final → Won/Lost/Tied; live → Winning/
  // Losing/Tied; pre-game → none.
  function outcomePill(me, o) {
    var st = matchupState(me, o);
    if (st === "pre") return "";
    if (Math.abs(me.live - o.live) < 0.001) return '<span class="ups-m-sb-pill tie">Tied</span>';
    var ahead = me.live > o.live;
    if (st === "final") return ahead ? '<span class="ups-m-sb-pill win">Won</span>' : '<span class="ups-m-sb-pill lose">Lost</span>';
    return ahead ? '<span class="ups-m-sb-pill win">Winning</span>' : '<span class="ups-m-sb-pill lose">Losing</span>';
  }
  // This-week head-to-head record (the UPS double/triple-header result) — W-L[-T]
  // across the viewer's opponents, by actual score. Pre-game matchups skipped.
  function h2hRecord(me, opps) {
    var w = 0, l = 0, t = 0;
    opps.forEach(function (o) {
      if (matchupState(me, o) === "pre") return;
      if (Math.abs(me.live - o.live) < 0.001) t++;
      else if (me.live > o.live) w++;
      else l++;
    });
    return { w: w, l: l, t: t, str: w + "-" + l + (t ? "-" + t : "") };
  }
  function teamFinal(team) {
    if (sbSource() === "weekly") return true;
    return !!(team.starters && team.starters.length && team.starters.every(function (x) { return x.done; }));
  }
  // Single-team game state: "pre" | "live" | "final" — drives live-blend vs orig proj.
  function teamState(team) {
    if (sbSource() === "weekly") return "final";
    var ss = team.starters || [];
    if (!ss.length) return "pre";
    if (!ss.some(function (x) { return x.done || x.playing; })) return "pre";
    return ss.every(function (x) { return x.done; }) ? "final" : "live";
  }
  function posGroup(pos) {
    var p = s(pos).toUpperCase();
    if (p === "QB") return "QB";
    if (p === "RB" || p === "FB" || p === "HB") return "RB";
    if (p === "WR") return "WR";
    if (p === "TE") return "TE";
    if (p === "PK" || p === "K") return "PK";
    if (p === "PN" || p === "P") return "PN";
    if (p === "DT" || p === "DE" || p === "NT" || p === "DL") return "DL";
    if (p === "LB" || p === "OLB" || p === "ILB" || p === "MLB") return "LB";
    if (p === "CB" || p === "S" || p === "FS" || p === "SS" || p === "DB") return "DB";
    return "OTH";
  }
  // Positional-group rank by ACTUAL points that week (from playerScores). Cached.
  function sbPosRank(pid) {
    if (!M.state.sb) return null;
    if (!M.state.sb._posRank) {
      var scores = M.state.sb.scores || {}, byG = {};
      Object.keys(scores).forEach(function (id) {
        var pm = playerById(id) || {}; var g = posGroup(pm.position);
        if (!g || g === "OTH") return;
        (byG[g] = byG[g] || []).push({ id: id, pts: scores[id] });
      });
      var map = {};
      Object.keys(byG).forEach(function (g) {
        byG[g].sort(function (a, b) { return b.pts - a.pts; });
        byG[g].forEach(function (x, i) { map[x.id] = { group: g, rank: i + 1 }; });
      });
      M.state.sb._posRank = map;
    }
    return M.state.sb._posRank[String(pid)] || null;
  }
  function sbOpponents() {
    var opps = [], meId = M.state.viewerFranchiseId;
    if (sbSource() === "weekly") {
      var wr = sbWeekly();
      if (wr) asArray(wr.matchup).forEach(function (m) {
        var fr = asArray(m.franchise).map(function (f) { return pad4(f.id); });
        if (fr.indexOf(meId) >= 0) fr.forEach(function (id) { if (id !== meId && opps.indexOf(id) < 0) opps.push(id); });
      });
      return opps;
    }
    var sched = M.state.sb && M.state.sb.schedule && M.state.sb.schedule.schedule, wk = sbWeek();
    if (sched) {
      var wrow = asArray(sched.weeklySchedule).filter(function (w) { return String(w.week) === wk; })[0];
      if (wrow) asArray(wrow.matchup).forEach(function (m) {
        var fr = asArray(m.franchise).map(function (f) { return pad4(f.id); });
        if (fr.indexOf(meId) >= 0) fr.forEach(function (id) { if (id !== meId) opps.push(id); });
      });
    }
    if (!opps.length) {
      var ls = sbLive();
      if (ls) asArray(ls.matchup).forEach(function (m) {
        var fr = asArray(m.franchise).map(function (f) { return pad4(f.id); });
        if (fr.indexOf(meId) >= 0) fr.forEach(function (id) { if (id !== meId && opps.indexOf(id) < 0) opps.push(id); });
      });
    }
    return opps;
  }
  function scheduleSbPoll() {
    if (M.state.sbTimer) { clearTimeout(M.state.sbTimer); M.state.sbTimer = null; }
    if (M.route.currentRoute().split("/")[0] !== "scores") return;
    try { if (document.hidden) return; } catch (e) {}
    if (!anyGameLive()) return;
    M.state.sbTimer = setTimeout(function () { loadScoreboard(true); }, SB_POLL_MS);
  }

  // ---- per-player breakdown (reuse the keyless /api/mfl-detailed) ----
  function mflPlayerUrl(pid) {
    var wk = sbWeek(), info = sbLeagueInfo(sbYear());
    return "https://" + (info.server || "www48") + ".myfantasyleague.com/" + encodeURIComponent(sbYear()) + "/player?L=" + encodeURIComponent(info.league_id) +
      "&P=" + encodeURIComponent(pid) + (wk ? "&W=" + encodeURIComponent(wk) : "");
  }
  function bdKey(pid) { return sbYear() + ":" + (sbWeek() || "") + ":" + pid; }
  function loadBreakdown(pid) {
    if (!M.state.sbBd) M.state.sbBd = {};
    var key = bdKey(pid);
    if (M.state.sbBd[key]) return;
    M.state.sbBd[key] = { loading: true };
    var wk = sbWeek();
    fetch(API.workerUrl("/api/mfl-detailed") + "?L=" + encodeURIComponent(sbLid()) +
      "&YEAR=" + encodeURIComponent(sbYear()) + "&P=" + encodeURIComponent(pid) + (wk ? "&W=" + encodeURIComponent(wk) : ""),
      { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.json(); })
      // Validate on the lines array — the worker returns a catch-all {ok:true}
      // for unknown /api paths; a real DNP returns lines:[] (still an array).
      .then(function (d) { M.state.sbBd[key] = (d && Array.isArray(d.lines)) ? d : { error: true }; renderRoute(); })
      .catch(function () { M.state.sbBd[key] = { error: true }; renderRoute(); });
  }
  // Re-express raw breakdown lines: duplicate yardage line → milestone bonus;
  // AGGREGATE TDs by type+tier ("2 Passing TD (1-49 yd)" = +12) + 50+ bonus line;
  // DROP 0-point lines. Totals preserved. (Mirror of the desktop version.)
  var YARD_MS = { Rushing: [100, 150, 200, 250], Receiving: [100, 150, 200], Passing: [300, 375, 425] };
  function transformLines(lines) {
    var seenYd = {}, agg = {}, out = [];
    (lines || []).forEach(function (l) {
      var stat = String(l.stat || ""), pts = Number(l.points) || 0;
      var td = stat.match(/^(\d+)\s*yd\s+(.+?)\s+TD$/i);
      if (td) {
        var len = parseInt(td[1], 10), type = td[2], fifty = len >= 50, tier = fifty ? "50+" : "1-49";
        var bk = "B|" + type + "|" + tier;
        if (!agg[bk]) { agg[bk] = { count: 0, points: 0, stat: type + " TD (" + tier + " yd)" }; out.push({ ref: bk }); }
        agg[bk].count++; agg[bk].points += fifty ? (pts - 1) : pts;
        if (fifty) {
          var nk = "N|" + type;
          if (!agg[nk]) { agg[nk] = { count: 0, points: 0, stat: "Bonus 50+ yd " + type + " TD", bonus: true }; out.push({ ref: nk }); }
          agg[nk].count++; agg[nk].points += 1;
        }
        return;
      }
      var yd = stat.match(/^(\d+)\s+(Rushing|Receiving|Passing)\s+Yards$/i);
      if (yd) {
        var kind = yd[2].charAt(0).toUpperCase() + yd[2].slice(1).toLowerCase();
        if (seenYd[kind]) {
          var val = parseInt(yd[1], 10), ms = YARD_MS[kind] || [], thr = 0;
          ms.forEach(function (m) { if (val >= m) thr = m; });
          out.push({ points: pts, stat: "Bonus " + (thr || "") + "+ " + kind + " Yards", bonus: true });
        } else { seenYd[kind] = true; out.push({ points: pts, stat: stat }); }
        return;
      }
      out.push({ points: pts, stat: stat });
    });
    return out.map(function (e) {
      if (!e.ref) return e;
      var a = agg[e.ref];
      return { points: a.points, stat: a.count + " " + a.stat, bonus: a.bonus };
    }).filter(function (e) { return Math.round((Number(e.points) || 0) * 100) !== 0; });
  }
  function breakdownBlock(p) {
    var d = (M.state.sbBd || {})[bdKey(p.pid)];
    var full = '<a href="' + esc(mflPlayerUrl(p.pid)) + '" target="_blank" rel="noopener">Full profile ↗</a>';
    var inner;
    if (!d || d.loading) inner = '<div class="ups-m-sb-bd-loading">Loading breakdown…</div>';
    else if (d.error) inner = '<div class="ups-m-sb-bd-msg">Couldn’t load the breakdown. ' + full + '</div>';
    else {
      var lines = d.lines || [], pl = d.player || {}, game = pl.game || pl.score;
      var head = game ? '<div class="ups-m-sb-bd-game">' + esc(game) + '</div>' : '';
      if (!lines.length) {
        inner = head + '<div class="ups-m-sb-bd-msg">No scoring stats for ' + esc(sbYear()) + (sbWeek() ? ' Week ' + esc(sbWeek()) : '') + '.</div>' +
          '<div class="ups-m-sb-bd-foot"><span>MFL Detailed Results</span>' + full + '</div>';
      } else {
        var rows = transformLines(lines).map(function (l) {
          var pos = (Number(l.points) || 0) >= 0;
          return '<div class="ups-m-sb-bd-line' + (l.bonus ? " bonus" : "") + '"><span class="st">' + esc(l.stat) + '</span>' +
            '<span class="pt ' + (pos ? "p" : "n") + '">' + (pos ? "+" : "") + fmtPts(l.points) + '</span></div>';
        }).join("");
        var subtotal = d.subtotal != null ? d.subtotal : lines.reduce(function (a, l) { return a + (Number(l.points) || 0); }, 0);
        // Above / below expectation vs the player's ORIGINAL projection for this week.
        var op = (p && p.origProj) || 0, expLine = "";
        if (op > 0) {
          var diff = subtotal - op, above = diff >= 0;
          expLine = '<div class="ups-m-sb-bd-exp ' + (above ? "p" : "n") + '">vs proj ' + fmtPts(op) + ' · ' +
            (above ? "+" : "") + fmtPts(diff) + ' ' + (above ? "above" : "below") + ' expectation</div>';
        }
        inner = head + '<div class="ups-m-sb-bd-lines">' + rows + '</div>' +
          '<div class="ups-m-sb-bd-sub"><span>Subtotal</span><span>' + fmtPts(subtotal) + '</span></div>' +
          expLine +
          '<div class="ups-m-sb-bd-foot"><span>MFL Detailed Results</span>' + full + '</div>';
      }
    }
    return '<div class="ups-m-sb-bd">' + inner + '</div>';
  }

  // ---- roster list (expanded under a team row) ----
  function rosterList(team) {
    if (!team.starters.length) return '<div class="ups-m-sb-ros-empty">No starters scored.</div>';
    return team.starters.map(function (p) {
      var st = p.done ? '<span class="st done">Final</span>'
        : p.playing ? '<span class="st now">● ' + Math.ceil(p.gsr / 60) + "'</span>"
        : '<span class="st yet">Yet</span>';
      var inj = injuryShort(p.status) ? ' <span class="ups-m-sb-inj">' + esc(injuryShort(p.status)) + '</span>' : "";
      var open = M.state.sbPlayerExp === p.pid;
      var rk = sbPosRank(p.pid);
      var rkBadge = rk ? ' <span class="ups-m-sb-prank">' + esc(rk.group) + '#' + rk.rank + '</span>' : '';
      var projVal = p.done ? p.origProj : p.projFinal;   // orig proj once final
      var row = '<div class="ups-m-sb-pl' + (open ? " open" : "") + '" data-bd-pid="' + esc(p.pid) + '">' +
        '<span class="ups-m-sb-pl-caret">' + (open ? "▾" : "▸") + '</span>' +
        '<span class="ups-m-sb-pl-id"><span class="nm">' + esc(p.name) + rkBadge + inj + '</span>' +
          '<span class="meta">' + esc(p.pos || "—") + ' · ' + esc(p.nfl || "—") + ' · ' + st + '</span></span>' +
        '<span class="ups-m-sb-pl-pts">' + fmtPts(p.live) + '<small>' + fmtPts(projVal) + '</small></span>' +
      '</div>';
      if (open) row += breakdownBlock(p);
      return row;
    }).join("");
  }

  // ---- year/week controls ----
  function weekControls() {
    var cy = parseInt(ctx().year, 10) || (new Date()).getFullYear(), years = [];
    // Floor at 2020 — earliest season MFL has weeklyResults for L=74598.
    var lyMap = M.state.sbLeagueYears;
    if (lyMap && Object.keys(lyMap).length) {
      years = Object.keys(lyMap).sort(function (a, b) { return Number(b) - Number(a); });
    } else {
      for (var y = cy; y >= 2017; y--) years.push(y);   // keyless fallback until the D1 map loads
    }
    var ySel = '<select class="ups-m-sb-sel" id="ups-m-sb-year">' + years.map(function (y) {
      return '<option value="' + y + '"' + (String(y) === String(sbYear()) ? " selected" : "") + '>' + y + '</option>';
    }).join("") + '</select>';
    var wOpts = '<option value="">Current</option>';
    for (var w = 1; w <= 18; w++) wOpts += '<option value="' + w + '"' + (String(w) === String(sbWeekSel()) ? " selected" : "") + '>Week ' + w + '</option>';
    return '<div class="ups-m-sb-controls">' + ySel + '<select class="ups-m-sb-sel" id="ups-m-sb-week">' + wOpts + '</select></div>';
  }
  function resetSb() { M.state.sb = null; M.state.sbExpand = null; M.state.sbPlayerExp = null; renderRoute(); }

  // ---- team row (Me or opponent) ----
  function teamRow(team, isMe, me, opps) {
    var open = M.state.sbExpand === (isMe ? "me" : team.fid);
    var caret = '<span class="ups-m-sb-caret">' + (open ? "▾" : "▸") + '</span>';
    var main, sub = "";
    if (isMe) {
      // H2H record (double/triple-header result) + ORIGINAL proj once my week is final.
      var h2h = (opps && opps.length) ? h2hRecord(me, opps) : null;
      var h2hChip = h2h ? ' <span class="ups-m-sb-h2h">H2H ' + esc(h2h.str) + '</span>' : '';
      // Live games → live-blend; pre-game or final → ORIGINAL proj (ties to lineup).
      var meProjLbl = (teamState(me) === "live") ? ('proj ' + fmtPts(team.projFinal)) : ('orig proj ' + fmtPts(team.origProj));
      main = caret +
        '<span class="ups-m-sb-team"><span class="lbl">My</span> ' + esc(team.name) + h2hChip + '</span>' +
        '<span class="ups-m-sb-num">' + fmtPts(team.live) + '<small>' + meProjLbl + '</small></span>';
    } else {
      var live = matchupState(me, team) === "live", pill = outcomePill(me, team), projLine;
      if (live) {
        var margin = me.projFinal - team.projFinal, wpPct = Math.round(winProb(me, team) * 100);
        projLine = 'proj ' + fmtPts(me.projFinal) + ' – ' + fmtPts(team.projFinal) + ' (' + (margin >= 0 ? "+" : "") + fmtPts(margin) + ')';
        sub = '<div class="ups-m-sb-wp"><div class="ups-m-sb-wpbar"><div class="fill" style="width:' + wpPct + '%"></div></div><span class="wpn">' + wpPct + '%</span></div>';
      } else {
        projLine = 'orig proj ' + fmtPts(me.origProj) + ' – ' + fmtPts(team.origProj);   // pre/final → orig proj, no bar
      }
      main = caret +
        '<span class="ups-m-sb-team"><span class="lbl">vs</span> ' + esc(team.name) + (pill ? " " + pill : "") + '</span>' +
        '<span class="ups-m-sb-num">' + fmtPts(me.live) + ' – ' + fmtPts(team.live) + '<small>' + projLine + '</small></span>';
    }
    return '<div class="ups-m-sb-row' + (isMe ? " mine" : "") + '">' +
      '<div class="ups-m-sb-row-tap" data-sbexp="' + (isMe ? "me" : esc(team.fid)) + '"><div class="ups-m-sb-row-main">' + main + '</div>' + sub + '</div>' +
      (open ? '<div class="ups-m-sb-ros">' + rosterList(team) + '</div>' : '') +
    '</div>';
  }

  function render(mount) {
    var head = '<section class="ups-m-section-head"><div class="ups-m-kicker">Game Day</div><h1>Live Scoring</h1></section>';
    if (!M.state.sb || !M.state.sb.loaded) {
      mount.innerHTML = head + weekControls() + '<div class="ups-m-stub"><div>Loading scoring…</div></div>';
      bindControls(mount);
      loadScoreboard();
      return;
    }
    var nativeUrl = "https://" + (sbLeagueInfo(sbYear()).server || "www48") + ".myfantasyleague.com/" + encodeURIComponent(sbYear()) + "/ajax_ls?L=" + encodeURIComponent(sbLid());
    if (M.state.sb.error) {
      mount.innerHTML = head + weekControls() +
        '<div class="ups-m-stub"><div>No scoring data for ' + esc(sbYear()) + (sbWeekSel() ? " Week " + esc(sbWeekSel()) : " the current week") + '. Pick another week.</div></div>';
      bindControls(mount);
      return;
    }
    var me = sbCompute(M.state.viewerFranchiseId);
    var opps = sbOpponents().map(function (id) { return sbCompute(id); });
    var wk = sbWeek();
    var statusTag = anyGameLive() ? '<span class="ups-m-sb-livedot">● LIVE</span>'
      : (sbSource() === "weekly" ? '<span class="ups-m-sb-final">Final</span>' : '');
    var top = '<div class="ups-m-sb-top"><span class="wk">' + esc(sbYear()) + ' · Week ' + esc(wk) + ' · ' + esc(me.name) + '</span>' + statusTag + '</div>';

    var meRow = teamRow(me, true, me, opps);
    var oppRows = opps.length
      ? opps.map(function (o) { return teamRow(o, false, me); }).join("")
      : '<div class="ups-m-sb-note">No head-to-head opponent this week (bye) — your All-Play result still counts below.</div>';

    // All-Play board (every team with data, sorted by the toggle metric).
    var sbView = M.state.sbView || "proj";
    var all = sbFranchises().map(function (f) { return sbCompute(f.id); }).filter(function (x) { return x.hasData; });
    var metricOf = function (x) { return sbView === "live" ? x.live : x.projFinal; };
    all.sort(function (a, b) { return metricOf(b) - metricOf(a); });
    var apRows = all.map(function (x, i) {
      var beat = all.filter(function (y) { return y.fid !== x.fid && metricOf(y) < metricOf(x); }).length;
      var tied = all.filter(function (y) { return y.fid !== x.fid && metricOf(y) === metricOf(x); }).length;
      var mine = x.fid === M.state.viewerFranchiseId;
      return '<div class="ups-m-sb-ap-row' + (mine ? " mine" : "") + '">' +
        '<span class="rk">' + (i + 1) + '</span><span class="nm">' + esc(x.name) + '</span>' +
        '<span class="lv">' + fmtPts(x.live) + '</span><span class="pj">' + fmtPts(x.projFinal) + '</span>' +
        '<span class="bt">' + beat + '–' + (all.length - 1 - beat - tied) + (tied ? "–" + tied : "") + '</span></div>';
    }).join("");
    var allplay = '<div class="ups-m-sb-sec">All-Play board' +
      '<span class="ups-m-sb-toggle"><button type="button" data-sbview="proj"' + (sbView === "proj" ? ' class="on"' : '') + '>Proj</button>' +
      '<button type="button" data-sbview="live"' + (sbView === "live" ? ' class="on"' : '') + '>Live</button></span></div>' +
      '<div class="ups-m-sb-ap"><div class="ups-m-sb-ap-row head"><span class="rk">#</span><span class="nm">Team</span><span class="lv">Live</span><span class="pj">Proj</span><span class="bt">All-Play</span></div>' + apRows + '</div>';

    mount.innerHTML = head + weekControls() + top +
      '<div class="ups-m-sb-sec">My Week</div>' + meRow + oppRows +
      allplay +
      '<div class="ups-m-sb-actions"><a href="' + esc(nativeUrl) + '" target="_blank" rel="noopener">MFL Live Scoring ↗</a></div>';
    bindControls(mount);
    bindRows(mount);
    scheduleSbPoll();
  }

  function bindControls(mount) {
    var yEl = mount.querySelector("#ups-m-sb-year");
    if (yEl) yEl.addEventListener("change", function () { M.state.sbYear = yEl.value; resetSb(); });
    var wEl = mount.querySelector("#ups-m-sb-week");
    if (wEl) wEl.addEventListener("change", function () { M.state.sbWeek = wEl.value; resetSb(); });
  }
  function bindRows(mount) {
    var rows = mount.querySelectorAll("[data-sbexp]");
    for (var i = 0; i < rows.length; i++) {
      rows[i].addEventListener("click", (function (el) {
        return function () {
          var id = el.getAttribute("data-sbexp");
          M.state.sbExpand = (M.state.sbExpand === id) ? null : id;
          M.state.sbPlayerExp = null;
          renderRoute();
        };
      })(rows[i]));
    }
    var pls = mount.querySelectorAll(".ups-m-sb-pl[data-bd-pid]");
    for (var j = 0; j < pls.length; j++) {
      pls[j].addEventListener("click", (function (el) {
        return function (e) {
          if (e.target.closest && e.target.closest("a")) return;  // let the Full-profile link work
          var pid = el.getAttribute("data-bd-pid");
          if (M.state.sbPlayerExp === pid) { M.state.sbPlayerExp = null; renderRoute(); return; }
          M.state.sbPlayerExp = pid;
          loadBreakdown(pid);
          renderRoute();
        };
      })(pls[j]));
    }
    var tg = mount.querySelectorAll("[data-sbview]");
    for (var k = 0; k < tg.length; k++) {
      tg[k].addEventListener("click", (function (el) {
        return function () { M.state.sbView = el.getAttribute("data-sbview"); renderRoute(); };
      })(tg[k]));
    }
  }

  M.route.registerView("scores", render);
})();
