/* My Team → Lineup view — slot-based lineup builder.

   18 starters (UPS 2026): 11 offense + 7 defense, presented as fixed + flex
   slots. Each slot is an eligibility-filtered dropdown; picking a player
   removes them from every other dropdown, so you can't double-start anyone.
   The header tracks fill progress live (dynamic as completed). Submission is
   the flat list of the 18 chosen player IDs — MFL auto-slots by position.

   Slot model + validation live in site/m/front_office_lineup.js. */
(function () {
  "use strict";
  if (!window.UPS_MOBILE || !window.UPS_FRONT_OFFICE_LINEUP) return;
  var M = window.UPS_MOBILE;
  var U = M.util;
  var DATA = M.data;
  var API = M.api;
  var FO = window.UPS_FRONT_OFFICE_LINEUP;
  var LS = window.UPSLive;
  var SLOTS = FO.LINEUP_SLOTS;
  var TOTAL = FO.TOTAL_STARTERS;

  // Projected points for the current scoring week. Source: MFL projectedScores
  // (keyless) via the worker /api/mfl-export proxy. Lazy-loaded + cached on
  // M.state; re-renders once it arrives. MFL is "fine for now" per Keith — a
  // better projection source can swap in behind projFor() later.
  function projMap() { return (M.state.lineupProj && M.state.lineupProj.map) || {}; }
  function projFor(pid) { var v = projMap()[String(pid)]; return v == null ? null : v; }
  function fmtProj(v) { return v == null ? "—" : (Math.round(v * 10) / 10).toFixed(1); }
  function projLoaded() { return !!(M.state.lineupProj && M.state.lineupProj.loaded && Object.keys(projMap()).length); }
  // "Has the projections fetch settled at all" — success OR failure, unlike
  // projLoaded() above which also requires actual scores. M.state.lineupWeek
  // is only ever set inside loadProjections()'s SUCCESS branch (never on a
  // failure), so this is the signal loadSubmittedLineup needs: wait for the
  // week-resolution attempt to finish one way or the other before reading it,
  // rather than racing it. Both fetches are kicked off in the same tick at
  // the top of render() — a small D1 lookup (lineup read) plausibly resolves
  // FASTER than a full MFL projectedScores pull, so without this gate the
  // lineup read would commonly fire with an unresolved (blank) week even
  // though the real week arrives moments later — misreading/miswriting a
  // just-submitted lineup as "no_record" on the very next load.
  function projSettled() { return !!(M.state.lineupProj && M.state.lineupProj.loaded); }
  // Optimal-lineup score: projection (no-projection sorts last).
  function projScore(r) { var p = projFor(r.id); return p == null ? -1 : p; }
  // League-wide positional rank by projection (cached): { pid: { rank, group } }.
  function posRankMap() {
    if (M.state.lineupProjRank) return M.state.lineupProjRank;
    var pm = projMap(), byGroup = {};
    Object.keys(pm).forEach(function (pid) {
      var pl = DATA.playerById(pid); var g = FO.posGroup(pl && pl.position);
      if (g === "OTH") return;
      (byGroup[g] = byGroup[g] || []).push({ pid: pid, proj: pm[pid] });
    });
    var map = {};
    Object.keys(byGroup).forEach(function (g) {
      byGroup[g].sort(function (a, b) { return b.proj - a.proj; });
      byGroup[g].forEach(function (x, i) { map[x.pid] = { rank: i + 1, group: g }; });
    });
    M.state.lineupProjRank = map;
    return map;
  }
  function posRankFor(pid) { return posRankMap()[String(pid)] || null; }
  // Resolve the week an owner is SETTING A LINEUP for. Runs alongside
  // loadProjections(); whichever lands first, this wins, because
  // loadProjections only fills lineupWeek when it is still unset and this
  // always overwrites. projSettled() still gates the lineup read, and both
  // fetches start in the same tick, so the read cannot outrun them.
  //
  // Source: worker GET /api/current-lineup-week, NOT a raw liveScoring fetch
  // (Keith 2026-09-15). liveScoring.week alone is wrong in TWO different
  // windows -- too early (rolls to N+1 at week N's first kickoff, the
  // original 2026-09-10 bug) and too late (stays pinned on N through the
  // whole Tue/Wed gap after N's last game ends, until N+1's games start
  // producing live scores -- exactly when lineups for the NEXT week get set:
  // verified live 2026-09-15, this screen was showing Week 1 opponents a full
  // day after Week 1's last game had ended). The worker's
  // resolveCurrentLineupWeek() is the one place that decides this now, so the
  // screen and the POST /api/submit-lineup write (which calls the very same
  // function) can never disagree again.
  // MFL's KEYLESS projectedScores rolls forward to the NEXT week once the
  // current week's early games are underway, even though loadLiveWeek's
  // resolveCurrentLineupWeek correctly stays on the week actually being
  // played (Keith 2026-09-19: Kyler Murray and Chigoziem Okonkwo showed a
  // live "Out" tag sitting right next to a real point projection -- they're
  // projected to be BACK next week per MFL, and the keyless fetch below had
  // already rolled to next week's numbers while everything else -- the week
  // label, the injury tag -- correctly stayed on this week). Whenever the
  // resolved week (lineupWeek) and the keyless response's own week
  // (lineupProjWeek) disagree, re-fetch ONCE, pinned explicitly to
  // lineupWeek, and replace the map. lineupProjWeekFixedFor guards against
  // looping on a persistent mismatch or a failed refetch; either fetch may
  // land first (see loadLiveWeek's comment), so both call sites call this.
  function reconcileProjWeek() {
    var wk = M.state.lineupWeek;
    if (!wk || !M.state.lineupProj || !M.state.lineupProj.loaded) return;
    if (!M.state.lineupProjWeek || M.state.lineupProjWeek === wk) return;
    if (M.state.lineupProjWeekFixedFor === wk) return;
    M.state.lineupProjWeekFixedFor = wk;
    fetch(API.mflExportUrl("projectedScores", { W: wk }), { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var map = {}, ps = j && j.projectedScores && j.projectedScores.playerScore;
        (Array.isArray(ps) ? ps : (ps ? [ps] : [])).forEach(function (p) {
          if (p && p.id) { var n = parseFloat(p.score); if (!isNaN(n)) map[String(p.id)] = n; }
        });
        M.state.lineupProj = { loaded: true, map: map };
        M.state.lineupProjWeek = wk;
        M.state.lineupProjRank = null;
        renderRoute();
      })
      .catch(function () { /* keep the mismatched map rather than show nothing */ });
  }
  function loadLiveWeek() {
    if (M.state.lineupLiveWeekLoading) return;
    M.state.lineupLiveWeekLoading = true;
    fetch(API.workerUrl("/api/current-lineup-week"), { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var w = parseInt((j && j.week) || 0, 10) || 0;
        if (w) { M.state.lineupWeek = w; reconcileProjWeek(); renderRoute(); }
      })
      .catch(function () { /* projectedScores.week remains the fallback */ });
  }
  function loadProjections() {
    if (M.state.lineupProj) return;   // already loaded or in-flight
    M.state.lineupProj = { loaded: false, map: {} };
    loadLiveWeek();
    fetch(API.mflExportUrl("projectedScores"), { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var map = {}, ps = j && j.projectedScores && j.projectedScores.playerScore;
        (Array.isArray(ps) ? ps : (ps ? [ps] : [])).forEach(function (p) {
          if (p && p.id) { var n = parseFloat(p.score); if (!isNaN(n)) map[String(p.id)] = n; }
        });
        M.state.lineupProj = { loaded: true, map: map };
        // projectedScores.week is not reliably "the week being played" on its
        // own (see loadLiveWeek's comment for the full history) -- the
        // projection MAP above is still rightly projectedScores; only the
        // WEEK comes from the worker's shared resolveCurrentLineupWeek() via
        // loadLiveWeek(), and this raw projectedScores.week is kept only as
        // the last-resort fallback for when that call is unreadable.
        M.state.lineupProjWeek = parseInt((j && j.projectedScores && j.projectedScores.week) || 0, 10) || 0;
        if (!M.state.lineupWeek) M.state.lineupWeek = M.state.lineupProjWeek;
        M.state.lineupProjRank = null;  // rebuild ranks against fresh projections
        // Upgrade an un-edited salary seed to the Optimal (projection) lineup.
        if (M.state.lineupSeed === "salary") { M.state.lineupSlots = null; M.state.lineupSeed = null; }
        reconcileProjWeek();
        renderRoute();
      })
      .catch(function () { M.state.lineupProj = { loaded: true, map: {} }; renderRoute(); });
  }

  // ── Matchup info: opponent · home/away · kickoff, and where the opponent ranks in
  // MFL points allowed to this player's position, from worker /api/lineup-matchups.
  // One tappable line per player; the rest behind "Details" (Keith 2026-06-21).
  //
  // Review 2026-10-13 (#1249). The numbers are the Pts Agst board's: the same engine
  // (worker/src/fpa_engine.js), final games only, each player counted for the team he
  // played for that day, the full season through the latest completed game. Keith
  // 2026-10-13: rank and color by MFL POINTS ALLOWED PER GAME to the position (#1 = the
  // most; the board's Allowed column, high to low), green = ranks 1–10, red = the bottom
  // 10; Details keeps "vs usual" too, uncolored. Measured on 2019–2025 (review #1249, L2b): top-10 vs bottom-10 = +0.95 pts a
  // game against a player's own usual (QB +2.3; LB/DB/P and Weeks 2–4 ≈ nothing). The
  // Season/L3/L5 toggle is gone: shorter windows were less accurate, not more.
  var MU_PLURAL = { QB: "QBs", RB: "RBs", WR: "WRs", TE: "TEs", DL: "DL", LB: "LBs", DB: "DBs", PK: "Ks", PN: "Ps" };
  var MU_WORD = { QB: "quarterbacks", RB: "running backs", WR: "wide receivers", TE: "tight ends", DL: "defensive linemen", LB: "linebackers", DB: "defensive backs", PK: "kickers", PN: "punters" };
  var MU_IDP = { DL: 1, LB: 1, DB: 1 };
  var MU_STALE_MS = 5 * 60 * 1000;   // re-read a good answer after 5 minutes (the worker caches 2–5)
  var MU_RETRY_MS = 60 * 1000;       // a failed read is tried again on the next render after a minute
  // The season and week the matchups are for. Keyed by both, so an answer for one week
  // is never shown for another (the week can resolve after the first read).
  function muCtx() {
    var qp; try { qp = new URLSearchParams(location.search); } catch (e) { qp = { get: function () { return null; } }; }
    return { year: String(qp.get("mYEAR") || M.state.ctx.year || ""), week: String(qp.get("mW") || M.state.lineupWeek || "") };
  }
  function muKeyOf(c) { return c.year + ":" + c.week; }
  function muEntry() { var c = muCtx(); return c.week ? (M.state.lineupMuCache || {})[muKeyOf(c)] || null : null; }
  // Only a 200 with ok:true is an answer; anything else is a failure, never "no matchups".
  function muNormalize(d) {
    return { matchups: d.matchups || {}, defRatings: d.defRatings || {}, playerWindow: d.playerWindow || {},
      horizon: d.horizon || {}, horizonWeeks: d.horizonWeeks || [], weather: d.weather || {}, weatherState: d.weatherState || "",
      weeksUsed: d.weeksUsed || [], basis: d.ratingsBasis || "", ratingYear: String(d.ratingYear || d.year || ""),
      priorSeason: !!d.priorSeason, weeksAvailable: d.weeksAvailable || 0, readAt: d.mfl_read_at || d.as_of || "" };
  }
  function loadMatchups() {
    var c = muCtx();
    if (!M.state.lineupMuCache || typeof M.state.lineupMuCache !== "object") M.state.lineupMuCache = {};
    if (!M.state._muLoading || typeof M.state._muLoading !== "object") M.state._muLoading = {};
    // No scoring week yet: wait for the week to resolve (loadProjections / loadLiveWeek).
    if (!c.week) return;
    var key = muKeyOf(c), hit = M.state.lineupMuCache[key], now = Date.now();
    if (M.state._muLoading[key]) return;
    if (hit && hit.d && !hit.err && now - hit.at < MU_STALE_MS) return;
    if (hit && hit.err && now - hit.at < MU_RETRY_MS) return;
    M.state._muLoading[key] = 1;
    fetch(API.workerUrl("/api/lineup-matchups?YEAR=" + encodeURIComponent(c.year) + "&W=" + encodeURIComponent(c.week)), { mode: "cors", credentials: "omit" })
      .then(function (r) {
        return r.json().catch(function () { return null; }).then(function (j) {
          if (!r.ok || !j || j.ok !== true) throw new Error(j && j.error === "mfl_unavailable" ? "mfl" : "http");
          return j;
        });
      })
      .then(function (d) {
        M.state.lineupMuCache[key] = { d: muNormalize(d), at: Date.now() };
        delete M.state._muLoading[key]; renderRoute();
      }, function (e) {
        // Keep the last good answer (its read time is on screen); otherwise say why.
        var prev = M.state.lineupMuCache[key];
        M.state.lineupMuCache[key] = { d: prev && prev.d ? prev.d : null, err: e && e.message === "mfl" ? "mfl" : "net", at: Date.now() };
        delete M.state._muLoading[key]; renderRoute();
      });
  }
  function muData() { var e = muEntry(); return e && e.d ? e.d : null; }
  function fmtKick(unix) {
    if (!unix) return "";
    try {
      var d = new Date(unix * 1000), days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      var h = d.getHours(), m = d.getMinutes(), ap = h >= 12 ? "p" : "a", h12 = h % 12 || 12;
      return days[d.getDay()] + " " + h12 + (m ? ":" + (m < 10 ? "0" + m : m) : "") + ap;
    } catch (e) { return ""; }
  }
  function fmtClock(iso) {
    var t = Date.parse(iso || ""); if (isNaN(t)) return "";
    var d = new Date(t), h = d.getHours(), m = d.getMinutes();
    return (h % 12 || 12) + ":" + (m < 10 ? "0" : "") + m + " " + (h < 12 ? "AM" : "PM");
  }
  // "+29%" / "−12%" (a real minus) / "0%".
  function signedPct(p) { return p === 0 ? "0%" : (p > 0 ? "+" : "−") + Math.abs(p) + "%"; }
  function ordinal(n) { var s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
  // Green = the 10 teams allowing the most per game, red = the 10 allowing the least.
  // Only with 20+ teams ranked (the first days of a season have a handful).
  function muTier(rank, of) {
    if (rank == null || !(of >= 20)) return "";
    return rank <= 10 ? "good" : (rank > of - 10 ? "tough" : "");
  }
  function muRating(d, team, grp) {
    var x = d && d.defRatings && d.defRatings[team] && d.defRatings[team][grp];
    if (!x || x.ppgRank == null) return null;
    var pct = x.ratio == null ? null : Math.round((x.ratio - 1) * 100);
    return { ppgRank: x.ppgRank, ppgOf: x.ppgOf, tier: muTier(x.ppgRank, x.ppgOf), perGame: x.perGame, games: x.games,
      usual: x.usual, pct: pct };
  }
  // Which weeks the numbers cover: "Wks 1–5", or "2025 season" in Week 1.
  function muBasis(d) { return d ? (d.priorSeason ? d.ratingYear + " season" : d.basis) : ""; }
  // Kept for callers that pass a window (the Players picker): there is one window now.
  function matchupFor(pid) {
    var pl = DATA.playerById(pid); if (!pl) return null;
    var team = U.safeStr(pl.team).toUpperCase(), grp = FO.posGroup(pl.position);
    var d = muData();
    if (!d) return null;
    var m = d.matchups[team]; if (!m) return null;
    var hz = [], seen = {};
    (d.horizon[team] || []).forEach(function (h) { seen[h.wk] = h; });
    var wks = d.horizonWeeks.length ? d.horizonWeeks : Object.keys(seen).map(Number);
    wks.slice(0, 3).forEach(function (w) {
      var h = seen[w];
      hz.push(h ? { wk: w, opp: h.opp, isHome: h.isHome, rating: muRating(d, h.opp, grp) } : { wk: w, bye: true });
    });
    return { team: team, opp: m.opp, isHome: m.isHome, kickoff: m.kickoff, spread: m.spread, grp: grp, idp: !!MU_IDP[grp],
      rating: muRating(d, m.opp, grp), basis: muBasis(d), priorSeason: d.priorSeason, ratingYear: d.ratingYear,
      avg: d.playerWindow[String(pid)] || null, horizon: hz, weather: d.weather[team] || null };
  }
  // The short chip: "#30 vs QBs" — the opponent's rank (the line already names him:
  // "@ GBP · Sun 8:20p · #30 vs QBs"); IDP "#3 vs DL" = that offense. Green or red by
  // the tier; the rank number says the same thing in text. Week 1: "(2025)".
  function chipText(mu) {
    if (!mu || !mu.rating) return "";
    return "#" + mu.rating.ppgRank + " vs " + (MU_PLURAL[mu.grp] || mu.grp) + (mu.priorSeason ? " (" + mu.ratingYear + ")" : "");
  }
  function chipSay(mu) {
    if (!mu || !mu.rating) return "";
    var r = mu.rating;
    return mu.opp + (mu.idp ? "'s offense" : "") + " is " + ordinal(r.ppgRank) + " of " + r.ppgOf + " in MFL points allowed per game to " +
      (MU_WORD[mu.grp] || mu.grp) + ", " + (r.perGame == null ? "" : r.perGame.toFixed(1) + ", ") + mu.basis +
      (r.tier === "good" ? ", among the 10 most" : (r.tier === "tough" ? ", among the 10 fewest" : ""));
  }
  function chipHtml(mu) {
    var t = chipText(mu); if (!t) return "";
    return '<span class="ups-m-mu-chip' + (mu.rating.tier ? " " + mu.rating.tier : "") + '">' + U.escapeHtml(t) + '</span>';
  }
  // "Forecast at kickoff: 54°F · wind 12 mph · P.Cloudy", "Indoors", or a neutral site
  // (London, Munich, …), where the home team's city would be the wrong forecast.
  function wxText(w, kickoff) {
    if (!w) return "";
    if (w.neutral) return "Neutral site: no forecast here";
    if (w.dome) return "Indoors";
    var bits = [];
    if (w.tempF != null) bits.push(w.tempF + "°F");
    if (w.windMph != null) bits.push("wind " + w.windMph + " mph");
    if (w.summary) bits.push(w.summary);
    if (w.precip && w.precip >= 0.05) bits.push(w.precip + '" precip');
    if (!bits.length) return "";
    return (kickoff && Date.now() / 1000 >= kickoff ? "At kickoff: " : "Forecast at kickoff: ") + bits.join(" · ");
  }
  // MFL's spread: negative = favored.
  function lineText(s) {
    if (s == null || s === 0 || !isFinite(s)) return "";
    var n = Math.abs(s);
    return (s < 0 ? "Favored by " : "Underdog by ") + (Math.round(n * 10) / 10);
  }
  function fmtAvg(v) { return v == null ? "—" : (Math.round(v * 10) / 10).toFixed(1); }

  // ── Injury status (Keith 2026-10-13: "I need to see a player's injury status") ──
  // The app's ONE status loader (player_sheet.js UPS_MOBILE_PLAYER_STATUS), the same as
  // Stats → Players, the player sheet and Live Scoring: Q / D / OUT from this week's
  // OFFICIAL NFL injury report, IR / PUP / NFI / Suspended from MFL. MFL's own Q/D/Out
  // aren't used (its export keeps them for weeks after they lapse). No chip never means
  // "healthy": the note says when the report isn't out or couldn't be read. Q/D/OUT
  // only from a report for the week this lineup is for.
  var injWait = false;
  function PSx() { return window.UPS_MOBILE_PLAYER_STATUS || null; }
  function injSig() {
    var PS = PSx(); if (!PS) return "";
    var r = PS.currentReport ? PS.currentReport() : {};
    return PS.state() + ":" + r.state + ":" + (r.week || "") + ":" + (r.at || "");
  }
  function loadInjuries() {
    var PS = PSx();
    if (!PS || injWait || !M.state.ctx.year) return;
    var before = injSig();
    injWait = true;
    PS.load(M.state.ctx.year).then(function () {
      injWait = false;
      if (injSig() !== before) renderRoute();
    }, function () { injWait = false; });
  }
  // The report's week vs this lineup's week: Q/D/OUT only when they match.
  function injReport() {
    var PS = PSx(); if (!PS || !PS.currentReport) return { state: "none" };
    var r = PS.currentReport(), wk = parseInt(M.state.lineupWeek, 10) || 0;
    if (r.state === "ok" && wk && r.week !== wk) return { state: "otherweek", week: r.week };
    return r;
  }
  var GAME_CLS = { out: 1, d: 1, q: 1 };
  var PRIOR_SHORT = { Out: "OUT", Doubtful: "D", Questionable: "Q" }, PRIOR_CLS = { Out: "out", Doubtful: "d", Questionable: "q" };
  // Until his team's report for this week is out (the first one comes mid-week), his
  // LAST final official designation, labeled with its week ("W5 OUT") and outlined, so
  // it's never read as this week's (Keith 2026-10-13: "I need to see a player's
  // injury status"). Source: the same official report, via the worker's `prior`.
  function priorChip(p) {
    return { t: "W" + p.week + " " + PRIOR_SHORT[p.status], cls: PRIOR_CLS[p.status] + " prior",
      title: "Wk " + p.week + " injury report (final): " + p.status, prior: p };
  }
  function priorLine(p) {
    return "Wk " + p.week + " injury report (final): " + p.status + (p.injury ? " — " + p.injury : "") +
      ". Wk " + M.state.lineupWeek + "’s isn’t out yet for his team.";
  }
  function injInfo(pid, team) {
    var PS = PSx(); if (!PS) return { chips: [], report: "", roster: "" };
    var i = PS.info(pid, team), rep = injReport(), wk = parseInt(M.state.lineupWeek, 10) || 0;
    var chips = i.chips, report = i.report;
    if (rep.state === "otherweek") {
      // A current report for an EARLIER week than this lineup's (it lags the lineup
      // week): its designations are last week's, so they're shown as such.
      var older = rep.week < wk;
      chips = i.chips.map(function (c) { return !GAME_CLS[c.cls] ? c : (older ? { t: "W" + rep.week + " " + c.t, cls: c.cls + " prior", title: c.title + " (final)" } : null); })
        .filter(Boolean);
      report = older ? "" : "The newest NFL injury report is Wk " + rep.week + ", not Wk " + wk + ".";
      return { chips: chips, report: report, roster: i.roster, priorWeek: older ? rep.week : 0 };
    }
    var hasGame = chips.some(function (c) { return GAME_CLS[c.cls]; });
    var p = !hasGame && PS.prior ? PS.prior(pid) : null;
    if (p && wk && p.week < wk) return { chips: chips.concat([priorChip(p)]), report: priorLine(p), roster: i.roster, priorWeek: p.week };
    return i;
  }
  function injChipsHtml(pid, team) {
    return injInfo(pid, team).chips.map(function (c) {
      return '<span class="ups-m-inj-chip ' + c.cls + ' lu" title="' + U.escapeHtml(c.title) + '">' + U.escapeHtml(c.t) + "</span>";
    }).join("");
  }
  // The weeks of the last-week designations in the current read (for the note).
  function injPriorWeeks() { var PS = PSx(); return PS && PS.priorWeeks ? PS.priorWeeks() : []; }
  // " · OUT" for a dropdown choice (plain text).
  function injOptText(pid, team) {
    var ch = injInfo(pid, team).chips;
    return ch.length ? "  ·  " + ch.map(function (c) { return c.t; }).join(" ") : "";
  }
  function injNoteText() {
    var PS = PSx(); if (!PS) return "";
    var rep = injReport(), wk = M.state.lineupWeek;
    var st = PS.state();
    if (st === "error") return "Injury status couldn’t be loaded. No tag doesn’t mean healthy.";
    if (rep.state === "loading" || st === "idle" || st === "loading") return "Checking this week’s injury report…";
    var pw = injPriorWeeks();
    var marked = "“W" + pw.join("/W") + "”";
    if (rep.state === "ok") return "Injury tags: NFL injury report Wk " + rep.week + "; IR/PUP from MFL." + (pw.length ? " Teams yet to report for Wk " + wk + " show last week’s final tags, marked " + marked + "." : " No tag: not on the report, or a bye.");
    if (rep.state === "otherweek" && rep.week < (parseInt(wk, 10) || 0)) return "Injury tags: Wk " + wk + "’s NFL report isn’t out yet, so Q/D/OUT tags are marked “W" + rep.week + "” (last week’s final report); IR/PUP from MFL.";
    if (rep.state === "otherweek") return "Injury tags: Wk " + wk + "’s NFL report isn’t out yet (the newest is Wk " + rep.week + "), so no Q/D/OUT tags; IR/PUP from MFL. No tag doesn’t mean healthy.";
    return "Injury tags: Wk " + (wk || "") + "’s NFL report isn’t out yet, so Q/D/OUT tags" + (pw.length ? " are last week’s final report, marked " + marked : " will show once it is") + "; IR/PUP from MFL. No tag doesn’t mean healthy.";
  }

  // Compact, tappable matchup line (with a visible "Details" button) + the detail card.
  function slotMatchupHtml(pid) {
    var mu = matchupFor(pid); if (!mu) return "";
    var loc = (mu.isHome ? "vs " : "@ ") + mu.opp, when = fmtKick(mu.kickoff);
    // Several cards can be open at once, so opening one never moves the line you tapped.
    var open = !!(M.state.lineupMuOpen && M.state.lineupMuOpen[pid]);
    var did = "ups-m-mu-d-" + String(pid).replace(/[^\w-]/g, "");
    var say = (mu.isHome ? "Home against " : "At ") + mu.opp + (when ? ", " + when : "") + (mu.rating ? ". " + chipSay(mu) : "") + ".";
    var compact = '<button type="button" class="ups-m-slot-mu" data-mu-pid="' + U.escapeHtml(pid) + '" aria-expanded="' + (open ? "true" : "false") + '"' +
      (open ? ' aria-controls="' + did + '"' : "") + ' aria-label="' + U.escapeHtml(say + (open ? " Hide details." : " Show details.")) + '">' +
      '<span class="ups-m-mu-where">' + U.escapeHtml(loc) + (when ? " · " + U.escapeHtml(when) : "") + '</span>' +
      (mu.rating ? '<span class="ups-m-mu-sep" aria-hidden="true">·</span>' + chipHtml(mu) : "") +
      '<span class="ups-m-mu-more' + (open ? " on" : "") + '" aria-hidden="true">' + (open ? "Hide ▴" : "Details ▾") + '</span></button>';
    if (!open) return compact;
    var rows = [];
    // His line from this week's report (on it or not), or last week's final one while
    // his team's isn't out; otherwise the screen's injury note says so once, not on
    // every card.
    var pl = DATA.playerById(pid), inj = injInfo(pid, pl && pl.team);
    if (inj.report && (injReport().state === "ok" || inj.priorWeek)) rows.push('<div class="r ups-m-mu-inj">' + U.escapeHtml(inj.report) + '</div>');
    if (inj.roster) rows.push('<div class="r ups-m-mu-inj">' + U.escapeHtml(inj.roster) + '</div>');
    var line = lineText(mu.spread);
    if (line) rows.push('<div class="r">' + U.escapeHtml(line) + '</div>');
    var wx = wxText(mu.weather, mu.kickoff);
    if (wx) rows.push('<div class="r ups-m-mu-wx">' + U.escapeHtml(wx) + '</div>');
    var r = mu.rating;
    if (r) {
      rows.push('<div class="r">' + U.escapeHtml(mu.opp + (mu.idp ? "’s offense" : "") + " allows " + (MU_PLURAL[mu.grp] || mu.grp)) + ' <b>' +
        U.escapeHtml(fmtAvg(r.perGame)) + '</b> a game: <span class="ups-m-mu-rk' + (r.tier ? " " + r.tier : "") + '">#' + r.ppgRank + ' of ' + r.ppgOf + '</span> · ' +
        U.escapeHtml(mu.basis) + '</div>');
      // Keith 2026-10-13: keep both — the rank (points allowed) and "vs usual" (what
      // those same players usually score; the Pts Agst board's order). Uncolored, so
      // green/red only ever comes from the rank.
      if (r.usual != null && r.pct != null) {
        rows.push('<div class="r">Those ' + U.escapeHtml(MU_PLURAL[mu.grp] || mu.grp) + ' usually score ' + U.escapeHtml(fmtAvg(r.usual)) +
          ' a game: ' + U.escapeHtml(signedPct(r.pct)) + ' vs usual</div>');
      }
    } else if (muData()) {
      rows.push('<div class="r">' + U.escapeHtml(mu.opp + " hasn’t played a final game" + (mu.basis ? " in " + mu.basis : " yet") + ".") + '</div>');
    }
    if (mu.avg && mu.avg.games) {
      rows.push('<div class="r">His avg <b>' + U.escapeHtml(fmtAvg(mu.avg.avg)) + '</b> pts a game (' + U.escapeHtml(mu.basis) + ', ' +
        mu.avg.games + (mu.avg.games === 1 ? " game" : " games") + ')</div>');
    }
    if (mu.horizon.length) {
      rows.push('<div class="r">Next: ' + mu.horizon.map(function (h) {
        if (h.bye) return '<span class="ups-m-hz">Wk ' + h.wk + ' bye</span>';
        var t = h.rating ? h.rating.tier : "";
        return '<span class="ups-m-hz">Wk ' + h.wk + " " + (h.isHome ? "" : "@") + U.escapeHtml(h.opp) +
          (h.rating ? ' <span class="ups-m-mu-rk' + (t ? " " + t : "") + '">#' + h.rating.ppgRank + '</span>' : "") + '</span>';
      }).join('<span aria-hidden="true"> · </span>') + '</div>');
    }
    return compact + '<div class="ups-m-mu-detail" id="' + did + '">' + rows.join("") + '</div>';
  }
  // The notes for the whole screen: what the rank is, which games, when MFL was read,
  // and the injury report's week. On a failure, the reason and a way to try again.
  function matchupNoteHtml() {
    var c = muCtx(); if (!c.week) return "";
    var e = muEntry(), d = e && e.d;
    var inj = injNoteText(), injHtml = inj ? '<div class="ups-m-mu-note inj">' + U.escapeHtml(inj) + '</div>' : "";
    if (!d) {
      if (e && e.err) {
        return '<div class="ups-m-mu-note warn" role="status">Matchup numbers couldn’t be read' + (e.err === "mfl" ? " from MFL" : "") +
          ' right now. <button type="button" class="ups-m-mu-retry" id="ups-m-mu-retry">Try again</button></div>' + injHtml;
      }
      return '<div class="ups-m-mu-note" role="status">Loading matchups…</div>' + injHtml;
    }
    var lead;
    if (d.priorSeason) lead = "No " + c.year + " games yet, so the ranks are from the " + d.ratingYear + " season.";
    else if (!d.weeksUsed.length) lead = "No final games yet, so there are no ranks.";
    else lead = "Rank = MFL points allowed per game to the position, " + d.basis + " (#1 = most). Green: top 10 · red: bottom 10.";
    var at = fmtClock(d.readAt);
    var read = e.err ? "Couldn’t refresh; showing MFL read " + at + "." : (at ? "MFL read " + at + "." : "");
    return '<div class="ups-m-mu-note' + (d.priorSeason || e.err ? " warn" : "") + '">' + U.escapeHtml(lead + (read ? " " + read : "")) +
      " Games already played, not a forecast. " +
      '<details class="ups-m-st-more" id="ups-m-mu-about"' + (M.state.lineupMuNoteOpen ? " open" : "") + '><summary>About</summary><div>' +
      "“@ GBP · #30 vs QBs” = Green Bay is 30th of 32 in MFL points allowed per game to quarterbacks (#1 = the most). " +
      "Only final games count, and a player counts for the team he played for that day. " +
      MU_ABOUT_EVIDENCE +
      '</div></details></div>' + injHtml;
  }
  // The measured size of green vs red (2019–2025 games, leak-free; review #1249 L2b).
  var MU_ABOUT_EVIDENCE = "On 2019–2025 games, a player facing one of the 10 teams allowing the most to his position scored about 1 point more than facing one of the 10 allowing the least (QB about 2).";

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

  // Per-player kickoff times for M.state.lineupWeek, mirroring Game Day's
  // identical fetch -- the same LS.parseKickoffs() the Live Scoring tab
  // already trusts, so a team's kickoff can never read differently on the
  // two surfaces. Fetches once per resolved week; every row reads unlocked
  // until it lands (buildRows() re-runs on the next render either way).
  function loadKickoffs() {
    var wk = M.state.lineupWeek;
    if (!wk || M.state.lineupKickoffsFor === wk) return;
    M.state.lineupKickoffsFor = wk;
    fetch(API.mflExportUrl("nflSchedule", { W: wk }), { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.json(); })
      .then(function (j) { M.state.lineupKickoffs = (LS && LS.parseKickoffs(j)) || {}; renderRoute(); })
      .catch(function () { /* leave undefined -- rows stay unlocked, not wrongly locked */ });
    loadByes();
  }
  // Teams on a BYE in the lineup week, from MFL's own nflByeWeeks — the list
  // MFL's "League rules forbid starting players on a Bye week" check uses
  // (Keith 2026-10-06: Nick Bolton, KCC, Week 5, rejected with no cue on
  // screen). League-agnostic export: the worker proxy sends it to api.*
  // without L=. Unread = {} = no BYE tags, never "nobody is on bye".
  function loadByes() {
    var wk = M.state.lineupWeek;
    if (!wk || M.state.lineupByesFor === wk || !(LS && LS.parseByeTeams)) return;
    M.state.lineupByesFor = wk;
    fetch(API.mflExportUrl("nflByeWeeks", { W: wk }), { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.json(); })
      .then(function (j) { M.state.lineupByes = LS.parseByeTeams(j, wk); renderRoute(); })
      .catch(function () { /* no BYE tags rather than a wrong one */ });
  }
  // The bye week number for this team (0 = plays this week / unknown).
  function byeWeekFor(team) {
    var b = M.state.lineupByes && M.state.lineupByes[U.safeStr(team).toUpperCase()];
    return b || 0;
  }
  // Locked = his NFL team's kickoff for this week has passed. See Game Day's
  // isKickedOff() for the full rationale (canon §B4, added 2026-08-15; Keith
  // caught it live 2026-09-19 with a played-out Greg Rousseau still freely
  // swappable). A bye-week player (no kickoff entry this week) is never
  // locked by this rule -- he never "begins".
  function isKickedOff(team) {
    var ko = M.state.lineupKickoffs && M.state.lineupKickoffs[U.safeStr(team).toUpperCase()];
    return !!(ko && Date.now() / 1000 >= ko);
  }
  function buildRows() {
    var fid = M.state.viewerFranchiseId;
    if (!fid) return [];
    var roster = DATA.getRosterFor(fid);
    return roster.map(function (r) {
      var player = DATA.playerById(r.id);
      var pos = U.safeStr(player && player.position).toUpperCase();
      var team = U.safeStr(player && player.team);
      var name = nameFor(player) || ("Player " + r.id);
      var cy = parseInt(r.contractYear, 10);
      var row = {
        id: r.id, name: name, pos: pos, team: team, salary: r.salary,
        group: FO.posGroup(pos),
        isTaxi: /taxi/i.test(r.status || ""),
        isIr: /ir|injured/i.test(r.status || ""),
        isExpired: cy === 0
      };
      row.bye = byeWeekFor(team);
      row.eligible = FO.lineupEligibleRow(row);
      row.locked = isKickedOff(team);
      return row;
    });
  }

  function rowsById(rows) {
    var m = {};
    rows.forEach(function (r) { m[r.id] = r; });
    return m;
  }

  // Draft = { slotId: pid }. Persisted on M.state so switching sub-tabs
  // doesn't lose work.
  //
  // Seed from the lineup MFL ACTUALLY holds — never from Optimal. This used
  // to auto-fill Optimal (by projection, falling back to salary) on every
  // first render: an owner who deliberately benched a starter (bad matchup,
  // injury hunch) came back to this tab showing Optimal with no indication
  // it wasn't their real lineup, and hitting Submit silently overwrote their
  // real choice. Same bug class Game Day was fixed for (2026-08-03); found on
  // this sibling surface by the regression audit run right after. The
  // explicit "⚡ Optimal" button (bind(), below) is still exactly how you get
  // the auto-filled lineup — it's just never the unannounced default again.
  //
  // `known` is a promise (mirrors the worker's /api/lineup contract): only a
  // known:true response may seed anything. An unreadable read leaves the
  // screen on an explicit loading/error placeholder (see render()) rather
  // than falling back to Optimal or silently starting empty — either would
  // let an owner submit over a real lineup we simply failed to read back.
  function loadSubmittedLineup(rows) {
    if (M.state.lineupRead) return;     // once per page load
    M.state.lineupRead = "loading";
    var url = API.workerUrl("/api/lineup");
    var wk = String(M.state.lineupWeek || "").replace(/\D/g, "");
    var qs = [];
    if (wk) qs.push("W=" + encodeURIComponent(wk));
    var uid = API.getStoredMflUserId && API.getStoredMflUserId();
    if (uid) qs.push("MFL_USER_ID=" + encodeURIComponent(uid));
    if (qs.length) url += "?" + qs.join("&");
    fetch(url, { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.known === true && Object.prototype.toString.call(j.starters) === "[object Array]" && j.starters.length) {
          M.state.lineupSlots = FO.slotsFromStarters(rows, j.starters);
          M.state.lineupSeed = "submitted";
          M.state.lineupRead = "ok";
        } else if (j && j.state === "no_record") {
          // As of 2026-08-10 this means MFL ITSELF reports no lineup submitted
          // for this week (its playerRosterStatus export came back all-R), not
          // merely "we have no record of one". Behaviour is unchanged and
          // deliberately so: start blank and offer Optimal as an explicit
          // choice rather than silently applying it.
          M.state.lineupRead = "norecord";
        } else {
          M.state.lineupRead = "unknown";
          M.state.lineupReadErr = (j && j.error) || "Couldn't read your saved lineup.";
        }
        renderRoute();
      })
      .catch(function (e) {
        M.state.lineupRead = "unknown";
        M.state.lineupReadErr = String((e && e.message) || e);
        renderRoute();
      });
  }

  function renderLineupReadPlaceholder() {
    if (M.state.lineupRead === "loading" || !M.state.lineupRead) {
      return '<div class="ups-m-stub">Loading your current lineup from MFL…</div>';
    }
    return '<div class="ups-m-lineup-msg err">Couldn’t read your current lineup from MFL, so nothing is shown here — ' +
      'filling in the optimal lineup could overwrite starters you set on purpose. ' +
      U.escapeHtml(M.state.lineupReadErr || "") + '</div>' +
      '<div class="ups-m-lineup-tools"><button type="button" class="ups-m-lineup-tool" id="ups-m-lineup-retry">Try again</button></div>';
  }

  function subTabs(active) {
    function tab(href, label, key) {
      return '<a class="ups-m-subtab' + (key === active ? ' active' : '') +
             '" href="#myteam/' + href + '">' + label + '</a>';
    }
    return '<div class="ups-m-subtabs">' +
      tab("roster", "Roster", "roster") +
      tab("lineup", "Lineup", "lineup") +
      tab("taxi", "Taxi", "taxi") +
      tab("ir", "IR", "ir") +
      tab("contracts", "Contracts", "contracts") +
      '</div>';
  }

  function renderMessage() {
    var msg = M.state.lineupMessage;
    if (!msg) return "";
    return '<div class="ups-m-lineup-msg ' + U.escapeHtml(msg.kind || "info") + '">' +
      U.escapeHtml(msg.text || "") + '</div>';
  }

  function renderHeader(v, projTotal) {
    var fillClass = v.ok ? "ok" : (v.filled > TOTAL ? "over" : "under");
    var pct = Math.min(100, Math.round((v.filled / TOTAL) * 100));
    var summary = v.ok
      ? '<strong>' + TOTAL + ' / ' + TOTAL + '</strong> starters · ready to submit'
      : '<strong>' + v.filled + ' / ' + TOTAL + '</strong> starters set';
    var offCls = v.bySide.O === FO.OFFENSE_STARTERS ? "ok" : "under";
    var defCls = v.bySide.D === FO.DEFENSE_STARTERS ? "ok" : "under";
    var projChip = (projTotal != null)
      ? '<span class="ups-m-lineup-chip proj" title="Projected points (MFL, current week)">' + fmtProj(projTotal) + ' Proj Pts</span>'
      : '';
    var chips = projChip +
      '<span class="ups-m-lineup-chip ' + offCls + '">Off ' + v.bySide.O + '/' + FO.OFFENSE_STARTERS + '</span>' +
      '<span class="ups-m-lineup-chip ' + defCls + '">Def ' + v.bySide.D + '/' + FO.DEFENSE_STARTERS + '</span>';
    var errorList = "";
    if (v.errors.length) {
      errorList = '<ul class="ups-m-lineup-errors">' +
        v.errors.map(function (e) { return '<li>' + U.escapeHtml(e) + '</li>'; }).join("") +
        '</ul>';
    }
    return '' +
      '<div class="ups-m-lineup-status-card">' +
        '<div class="ups-m-lineup-status-line">' + summary +
          '<span class="ups-m-lineup-chips">' + chips + '</span>' +
        '</div>' +
        '<div class="ups-m-lineup-bar"><div class="ups-m-lineup-bar-fill ' + fillClass + '" style="width:' + pct + '%"></div></div>' +
        errorList +
        '<div class="ups-m-lineup-tools">' +
          '<button type="button" class="ups-m-lineup-tool" id="ups-m-lu-autofill" title="Fill the highest-projected eligible player into every slot">⚡ Optimal</button>' +
          '<button type="button" class="ups-m-lineup-tool" id="ups-m-lu-clear">Clear all</button>' +
        '</div>' +
        matchupNoteHtml() +
      '</div>';
  }

  // Build the option text for a candidate inside a dropdown. Salary is
  // irrelevant for a starting lineup — show the projection + positional
  // projection rank instead (Keith 2026-06-21).
  function optText(r) {
    // Player · Team · proj · POS#rank — the rank already carries the position,
    // so the standalone position token is dropped (Keith 2026-06-21).
    var line = r.name + (r.team ? "  ·  " + r.team : "") + (r.bye ? "  ·  BYE" : "") + injOptText(r.id, r.team);
    var p = projFor(r.id);
    if (p != null) {
      line += "  ·  " + fmtProj(p) + " pts";
      var rk = posRankFor(r.id);
      if (rk) line += "  ·  " + rk.group + " #" + rk.rank;
    }
    return line;
  }

  // One slot = a label tag + a <select> of eligible, not-yet-used players.
  function renderSlot(slot, rows, draft, used) {
    var current = draft[slot.id] || "";
    var currentRow = current ? rows.filter(function (r) { return r.id === current; })[0] : null;
    // Locked (his game has started): stays visible and selected, but the slot
    // itself goes read-only -- canon §B4. He's also excluded below from every
    // OTHER slot's candidates, so he can't be swapped in elsewhere either.
    var isLocked = !!(currentRow && currentRow.locked);
    var isBye = !!(currentRow && currentRow.bye);
    // Candidates: eligible, group accepted, and either unused elsewhere or
    // the player already in THIS slot (so the select can show them). A saved
    // starter on a bye stays visible in HIS slot, flagged, and nowhere else.
    var cands = rows.filter(function (r) {
      if (!(r.eligible || (r.bye && r.id === current))) return false;
      if (!FO.slotAccepts(slot, r.group)) return false;
      if (r.locked && r.id !== current) return false;
      return !used[r.id] || r.id === current;
    });
    // Highest projected first (players with no projection sort last), tie → salary.
    cands.sort(function (a, b) {
      var va = projFor(a.id), vb = projFor(b.id);
      va = va == null ? -1 : va; vb = vb == null ? -1 : vb;
      if (vb !== va) return vb - va;
      return (b.salary || 0) - (a.salary || 0);
    });

    var filled = !!current;
    var opts = '<option value="">— Empty —</option>';
    cands.forEach(function (r) {
      opts += '<option value="' + U.escapeHtml(r.id) + '"' +
        (r.id === current ? " selected" : "") + '>' +
        U.escapeHtml(optText(r)) + '</option>';
    });

    var labelCls = slot.flex ? "pos flex" : "pos";
    var note = slot.note ? '<span class="elig">' + U.escapeHtml(slot.note) + '</span>' : "";
    if (currentRow) { var ic = injChipsHtml(currentRow.id, currentRow.team); if (ic) note += '<span class="inj">' + ic + '</span>'; }
    var selCls = "ups-m-slot-sel" + (filled ? "" : " empty");
    var emptyHint = cands.length ? "" : ' data-none="1"';
    var cur = current ? projFor(current) : null;
    var projCell = '<div class="ups-m-slot-proj' + (cur != null ? "" : " none") + '" title="Projected points">' + U.escapeHtml(fmtProj(cur)) + '</div>';
    var lockAttr = isLocked
      ? ' disabled title="Locked — his game has started; league rule says he can’t be swapped once kickoff passes."'
      : "";
    var lockBadge = isLocked
      ? '<div class="ups-m-slot-lock-row"><span class="ups-m-lock-badge">🔒 Locked — kickoff passed</span></div>'
      : (isBye ? '<div class="ups-m-slot-lock-row"><span class="ups-m-bye-badge">BYE · Week ' + U.escapeHtml(String(currentRow.bye)) +
          ' — bench him; MFL won’t accept a bye-week starter</span></div>' : "");

    return '<div class="ups-m-slot' + (filled ? " filled" : "") + (isLocked ? " locked" : "") + (isBye ? " bye" : "") + '" data-slot="' + slot.id + '"' + emptyHint + '>' +
      '<div class="ups-m-slot-tag">' +
        '<span class="' + labelCls + '">' + U.escapeHtml(slot.label) + '</span>' + note +
      '</div>' +
      '<select class="' + selCls + '" data-slot="' + U.escapeHtml(slot.id) + '"' + lockAttr + '>' + opts + '</select>' +
      projCell +
    '</div>' + lockBadge + (current ? slotMatchupHtml(current) : "");
  }

  function renderSection(side, title, count, rows, draft, used) {
    var html = '<div class="ups-m-lineup-section-head"><span>' + title + '</span><span class="n">' + count + '</span></div>';
    SLOTS.filter(function (s) { return s.side === side; }).forEach(function (s) {
      html += renderSlot(s, rows, draft, used);
    });
    return html;
  }

  function renderFooter(v, submitting) {
    var label, ready = false, disabled = false;
    if (submitting) { label = "Submitting…"; disabled = true; }
    else if (v.problems > 0) { label = "Fix lineup errors"; disabled = true; }
    else if (v.complete) { label = "Submit Lineup to MFL"; ready = true; }
    else if (v.filled > 0) { label = "Save Lineup (" + v.filled + "/" + TOTAL + ")"; }
    else { label = "Pick your starters"; disabled = true; }
    return '<div class="ups-m-lineup-footer">' +
      '<button class="ups-m-lineup-submit' + (ready ? " ready" : "") +
              (submitting ? " busy" : "") + '" id="ups-m-lineup-submit"' +
              (disabled ? " disabled" : "") + '>' +
        U.escapeHtml(label) +
      '</button>' +
    '</div>';
  }

  function bind(mount, rows) {
    var draft = M.state.lineupSlots;
    var selects = mount.querySelectorAll(".ups-m-slot-sel");
    for (var i = 0; i < selects.length; i++) {
      selects[i].addEventListener("change", function (e) {
        var slotId = e.target.getAttribute("data-slot");
        var pid = e.target.value;
        if (pid) draft[slotId] = pid; else delete draft[slotId];
        M.state.lineupSeed = "user";
        renderRoute();
      });
    }
    var af = document.getElementById("ups-m-lu-autofill");
    if (af) af.addEventListener("click", function () {
      M.state.lineupSlots = FO.autoFillSlots(rows, projLoaded() ? projScore : null, draft, rowsById(rows));
      M.state.lineupSeed = projLoaded() ? "proj" : "user";
      M.state.lineupMessage = null;
      renderRoute();
    });
    var clr = document.getElementById("ups-m-lu-clear");
    // Clear keeps only the LOCKED slots -- wiping one out from under an
    // already-kicked-off player would leave his slot empty with no legal way
    // to refill it (canon §B4).
    if (clr) clr.addEventListener("click", function () {
      M.state.lineupSlots = FO.lockedDraftEntries(draft, rowsById(rows));
      M.state.lineupSeed = "user";
      M.state.lineupMessage = null;
      renderRoute();
    });
    var submit = document.getElementById("ups-m-lineup-submit");
    if (submit) submit.addEventListener("click", function () { handleSubmit(); });
    var benchT = document.getElementById("ups-m-bench-toggle");
    if (benchT) benchT.addEventListener("click", function () { M.state.lineupShowBench = !M.state.lineupShowBench; renderRoute(); });
    var muRetry = document.getElementById("ups-m-mu-retry");
    if (muRetry) muRetry.addEventListener("click", function () {
      var c = muCtx(), k = muKeyOf(c);
      if (M.state.lineupMuCache && M.state.lineupMuCache[k] && M.state.lineupMuCache[k].err) delete M.state.lineupMuCache[k];
      renderRoute();
    });
    var muLines = mount.querySelectorAll(".ups-m-slot-mu[data-mu-pid]");
    for (var mi = 0; mi < muLines.length; mi++) {
      muLines[mi].addEventListener("click", (function (el) {
        return function () {
          var p = el.getAttribute("data-mu-pid");
          var open = M.state.lineupMuOpen || (M.state.lineupMuOpen = {});
          if (open[p]) delete open[p]; else open[p] = 1;
          M.state.lineupMuFocus = p;   // the re-render replaces the button: put focus back on it
          renderRoute();
        };
      })(muLines[mi]));
    }
    var about = document.getElementById("ups-m-mu-about");
    if (about) about.addEventListener("toggle", function () { M.state.lineupMuNoteOpen = about.open; });
    if (M.state.lineupMuFocus) {
      var back = mount.querySelector('.ups-m-slot-mu[data-mu-pid="' + String(M.state.lineupMuFocus).replace(/[^\w-]/g, "") + '"]');
      M.state.lineupMuFocus = null;
      if (back) { try { back.focus({ preventScroll: true }); } catch (e) { back.focus(); } }
    }
  }

  function handleSubmit() {
    if (M.state.lineupSubmitting) return;
    var fid = M.state.viewerFranchiseId;
    if (!fid) return;
    var draft = M.state.lineupSlots || {};
    // Flat list of chosen player IDs, in slot order, de-duped defensively.
    var seen = {}, starters = [];
    SLOTS.forEach(function (s) {
      var pid = draft[s.id];
      if (pid && !seen[pid]) { seen[pid] = 1; starters.push(pid); }
    });
    if (!starters.length) return;  // nothing to save; button is gated on problems===0
    M.state.lineupSubmitting = true;
    M.state.lineupMessage = { kind: "info", text: "Submitting lineup to MFL…" };
    renderRoute();
    // Forward the viewer's MFL_USER_ID — /api/submit-lineup REQUIRES it to
    // authenticate the write to MFL and verifies it matches this franchise
    // (worker returns 401/403 otherwise). Cross-origin from github.io we
    // can't send the MFL cookie, so it goes as a query param — same pattern
    // as the roster-workbench actions + trade builder.
    var luUrl = API.workerUrl("/api/submit-lineup");
    var luStored = API.getStoredMflUserId && API.getStoredMflUserId();
    if (luStored) luUrl += "?MFL_USER_ID=" + encodeURIComponent(luStored);
    // week: without it the worker's ups_lineup_submissions row is stamped
    // week="" (its ONLY default when the field is simply absent — see
    // worker/src/index.js /api/submit-lineup), while GET /api/lineup matches
    // on an EXACT week. This view was omitting it entirely, so a lineup
    // submitted here could never be read back by week-scoped GETs (from either
    // surface) — the read-back fix above would have looked for
    // week=<M.state.lineupWeek> and found nothing, even for a lineup this exact
    // screen just submitted.
    //
    // CORRECTION 2026-08-10: this comment used to assert "Game Day always sends
    // its own resolved week". That was FALSE. site/gameday/gameday.html
    // computed `wk` in submitLineup() and then never put it in the POST body,
    // so its rows were stranded at week="" too — a live dump of the whole
    // ledger held one row, week length 0. Game Day now sends it; both surfaces
    // do, and both resolve "current week" from the same source -- which as of
    // 2026-09-10 is liveScoring.week, NOT projectedScores.week, because MFL
    // rolls the projection week forward at the first kickoff of a week and
    // both surfaces were posting week=2 into a Week 1 that was still open.
    // The worker overrides the week from liveScoring too (PR #1051), so the
    // body value below is now a corroborating hint rather than the authority.
    // (The ledger is now only the FALLBACK
    // for GET /api/lineup anyway — MFL's playerRosterStatus export is the
    // primary source — but a mis-stamped row is still a row nobody can read.)
    var luWeek = String(M.state.lineupWeek || "").replace(/\D/g, "");
    fetch(luUrl, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ franchiseId: fid, week: luWeek, starters: starters })
    }).then(function (r) {
      return r.json().then(function (j) { return { status: r.status, body: j }; });
    }).then(function (resp) {
      if (resp.body && resp.body.ok) {
        // Name the week the WORKER wrote, not the one this screen asked for.
        var usedWk = resp.body && (resp.body.week_used || resp.body.week);
        M.state.lineupMessage = { kind: "ok",
          text: "Lineup saved to MFL ✓" + (usedWk ? " (Week " + String(usedWk) + ")" : "") };
      } else {
        var err = (resp.body && resp.body.error)
                 || (resp.body && resp.body.mfl_response && resp.body.mfl_response.error && resp.body.mfl_response.error.$t)
                 || (resp.body && resp.body.mfl_response && resp.body.mfl_response.error)
                 || ("HTTP " + resp.status);
        M.state.lineupMessage = { kind: "err", text: String(err) };
      }
    }).catch(function (e) {
      M.state.lineupMessage = { kind: "err", text: "Submit failed: " + (e && e.message || e) };
    }).then(function () {
      M.state.lineupSubmitting = false;
      renderRoute();
    });
  }

  function renderRoute() { M.route.renderRoute(); }

  // Bench (toggle) — every other active-roster player by position + projection,
  // with the same matchup intel, so you can see everyone laid out.
  var BENCH_ORDER = { QB: 0, RB: 1, WR: 2, TE: 3, PK: 4, PN: 5, DL: 6, LB: 7, DB: 8, OTH: 9 };
  // Why this player can't be started, or null if they're a real bench option.
  // The slot dropdowns already exclude them (FO.lineupEligibleRow), but this
  // list showed them identically to a startable player — so a taxi/IR guy read
  // as an available option you just couldn't find in the dropdown.
  // Falls through to a generic tag rather than no tag: anything `eligible`
  // rejects must say so, including an unrecognized position (posGroup "OTH").
  function benchBlockedTag(r) {
    if (r.isTaxi) return { cls: "taxi", label: "TAXI" };
    if (r.isIr) return { cls: "ir", label: "IR" };
    if (r.isExpired) return { cls: "exp", label: "EXPIRED" };
    if (r.bye) return { cls: "bye", label: "BYE · WK " + r.bye };
    if (!r.eligible) return { cls: "exp", label: "INELIGIBLE" };
    // Kicked off already: he's real and eligible, just no longer startable
    // this week (canon §B4) -- same reason he's absent from every slot's
    // dropdown a few lines down.
    if (r.locked) return { cls: "locked", label: "🔒 LOCKED" };
    return null;
  }
  function renderBench(rows, used) {
    var bench = rows.filter(function (r) { return !used[r.id]; }).sort(function (a, b) {
      // Unstartable players sink below the real options — a taxi player (or
      // a locked one) must never outrank a player you can actually put in
      // the lineup.
      var ba = (a.eligible && !a.locked) ? 0 : 1, bb = (b.eligible && !b.locked) ? 0 : 1;
      if (ba !== bb) return ba - bb;
      var ga = BENCH_ORDER[a.group] == null ? 9 : BENCH_ORDER[a.group], gb = BENCH_ORDER[b.group] == null ? 9 : BENCH_ORDER[b.group];
      if (ga !== gb) return ga - gb;
      var pa = projFor(a.id), pb = projFor(b.id); pa = pa == null ? -1 : pa; pb = pb == null ? -1 : pb;
      return pb - pa;
    });
    var nBlocked = bench.filter(function (r) { return !r.eligible || r.locked; }).length;
    var count = nBlocked ? (bench.length - nBlocked) + " + " + nBlocked + " unavailable" : String(bench.length);
    var show = !!M.state.lineupShowBench;
    var head = '<div class="ups-m-bench-head"><button type="button" class="ups-m-bench-toggle" id="ups-m-bench-toggle">' + (show ? "▾" : "▸") + ' Bench &amp; matchups (' + U.escapeHtml(count) + ')</button></div>';
    if (!show) return head;
    var body = bench.length ? bench.map(function (r) {
      var tag = benchBlockedTag(r);
      return '<div class="ups-m-bench-row' + (tag ? " blocked" : "") + '"><div class="ups-m-bench-id"><span class="nm">' + U.escapeHtml(r.name) + '</span>' +
        '<span class="meta">' + U.escapeHtml(r.pos || "—") + ' · ' + U.escapeHtml(r.team || "—") + '</span>' +
        (tag ? '<span class="ups-m-bench-tag ' + tag.cls + '">' + tag.label + '</span>' : "") + injChipsHtml(r.id, r.team) + '</div>' +
        '<div class="ups-m-bench-proj">' + U.escapeHtml(fmtProj(projFor(r.id))) + '</div></div>' + slotMatchupHtml(r.id);
    }).join("") : '<div class="ups-m-bench-empty">No bench players.</div>';
    return head + '<div class="ups-m-bench">' + body + '</div>';
  }
  function render(mount) {
    var rows = buildRows();
    if (!rows.length) {
      mount.innerHTML = subTabs("lineup") +
        '<div class="ups-m-stub"><div>No roster found.</div></div>';
      return;
    }
    loadProjections();   // lazy fetch; re-renders when projections arrive
    loadMatchups();      // lazy: opponent/kickoff/spread + the Pts Agst numbers for that opponent
    loadInjuries();      // lazy: the shared injury/roster status (official NFL report + MFL IR/PUP)
    loadKickoffs();       // lazy: per-player kickoff -> locks a started slot
    if (!M.state.lineupSlots) {
      if (!projSettled()) {
        // Wait for the projections fetch to SETTLE (success or failure)
        // before reading/writing a lineup — it's what resolves
        // M.state.lineupWeek, and firing the week-scoped read before that
        // lands would key it off a still-unresolved (blank) week, misreading
        // a real submission as "no_record". Re-renders itself once settled
        // (loadProjections' own .then/.catch both call renderRoute()).
        mount.innerHTML = subTabs("lineup") + '<div class="ups-m-stub">Loading your current lineup from MFL…</div>';
        return;
      }
      loadSubmittedLineup(rows);   // lazy: seeds M.state.lineupSlots from MFL, never Optimal
      if (!M.state.lineupSlots) {
        if (M.state.lineupRead === "loading" || !M.state.lineupRead || M.state.lineupRead === "unknown") {
          // Nothing seeded yet (still reading) or the read FAILED. Must not
          // paint a lineup we can't vouch for — an unreadable lineup is not an
          // empty one (see loadSubmittedLineup).
          mount.innerHTML = subTabs("lineup") + renderLineupReadPlaceholder();
          var retryBtn = document.getElementById("ups-m-lineup-retry");
          if (retryBtn) retryBtn.addEventListener("click", function () {
            M.state.lineupRead = null; M.state.lineupReadErr = null; renderRoute();
          });
          return;
        }
        // "norecord": start EMPTY, never Optimal. We don't know what MFL is
        // holding (they may have set it natively) — the Optimal button is
        // right there if that's genuinely what the owner wants.
        M.state.lineupSlots = {};
      }
    }
    var draft = M.state.lineupSlots;
    var byId = rowsById(rows);
    var v = FO.validateSlots(draft, byId);
    var submitting = !!M.state.lineupSubmitting;

    // Players already used (so each dropdown can exclude them).
    var used = {};
    SLOTS.forEach(function (s) { if (draft[s.id]) used[draft[s.id]] = 1; });

    // Sum projected points across filled slots (null until any projection loads).
    var projTotal = null;
    SLOTS.forEach(function (s) {
      var p = draft[s.id] ? projFor(draft[s.id]) : null;
      if (p != null) projTotal = (projTotal || 0) + p;
    });

    var html = subTabs("lineup");
    html += renderMessage();
    html += renderHeader(v, projTotal);
    html += renderSection("O", "Offense", FO.OFFENSE_STARTERS, rows, draft, used);
    html += renderSection("D", "Defense", FO.DEFENSE_STARTERS, rows, draft, used);
    html += renderBench(rows, used);
    html += renderFooter(v, submitting);
    mount.innerHTML = html;
    bind(mount, rows);
  }

  M.lineupView = { render: render };

  // ── Shared matchup/projection intel ────────────────────────────────────
  // views/players.js (the FA picker) needs the same projection + opponent +
  // matchup join this view already does. It reads it from here rather than
  // re-implementing it: same endpoint, same cache, same chip and tiers.
  //   load()            lazy fetch of projections + this week's matchups. Both
  //                     fetches are fire-and-forget with their own catch, so a
  //                     dead worker never blocks a caller's render.
  //   matchupFor(pid)   the join. Null when there's no data / no game.
  //   chipHtml(mu)      "#30 vs QBs", green top 10 / red bottom 10 in MFL points allowed.
  //   muData()          the raw answer for this week ({ defRatings, … }).
  M.lineupIntel = {
    // This week's per-team kickoffs, shared with the Players market so its
    // FCFS "Add now" locks at the same instant a lineup slot does.
    kickoffs: {
      load: loadKickoffs,
      loaded: function () { return !!M.state.lineupKickoffs && M.state.lineupKickoffsFor === M.state.lineupWeek; },
      kickedOff: isKickedOff,
      kickoffFor: function (team) {
        var ko = M.state.lineupKickoffs && M.state.lineupKickoffs[U.safeStr(team).toUpperCase()];
        return ko || null;
      }
    },
    // The argument (a window) is ignored: there is one window, the full season.
    load: function () {
      loadProjections();
      loadMatchups();
    },
    projLoaded: projLoaded,
    projFor: projFor,
    fmtProj: fmtProj,
    matchupFor: matchupFor,
    slotMatchupHtml: slotMatchupHtml,
    chipHtml: chipHtml,
    chipText: chipText,
    chipSay: chipSay,
    muData: muData,
    // Final weeks of the CURRENT season (0 ⇒ the numbers are last season's).
    weeksAvailable: function () { var s = muData(); return s ? (s.weeksAvailable || 0) : 0; },
    priorSeason: function () { var s = muData(); return !!(s && s.priorSeason); }
  };
})();
