/* UPS 2027 preview: League › Standings (#1503). Pure: answers in, one model out. No DOM, no network, no storage.

   Every seeding number comes from code that already exists: the Worker's season standings (its regular-season ladder), and the shared
   site/shared/standings_race.js (why lines, magic numbers, weekly tables, scored/faced, weekly leaders), standings_clinch.js (verified letters)
   and odds_display.js (the one display policy for forecast probabilities). This module adds only:
     - the unresolved-tie treatment (Option B): a tie the Worker reports as unresolved (regular_season.unresolved: no approved step of canon
       §F.1.2-§F.1.4 separates it) withholds the seeds it affects;
     - contributions: official MFL points credited to each franchise's actual starters that week, grouped by the player's position from a FROZEN,
       VERSIONED list (never today's position), and allocated to derived lineup slots each week, then added up; reconciled to the team's official total.

   build(input) -> model. input:
     standings  the /api/standings answer          schedule  { byWeek, raw } from data.loadFantasySchedule
     weeks      { <w>: weeklyResults answer }       positions { version, sha256, positions: { id: MFL position } } | null
     forecast   { throughWeek, teams[] } | null     mods      { race, clinch, odds } (the three shared modules)
     season     number                              abbr      { fid: short name } (optional)
*/
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.UPS2027 = root.UPS2027 || {}; root.UPS2027.standings = api; }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function arr(x) { return Array.isArray(x) ? x : x ? [x] : []; }
  // the seeding rule a forecast must have been simulated under (pipelines/etl/wire/season_sim.py SEEDING_RULE; canon §F.1, Keith 2026-11-25)
  var SEEDING_RULE = "canon-F1-2026-11-25: wild cards AP>PF>H2H; seeds 3-6 AP>PF; byes = top-2 division winners by AP";
  function tenths(x) { return Math.round(Number(x) * 10); }
  function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { var t = b; b = a % b; a = t; } return a || 1; }
  // an exact win share as a reduced fraction "num/den" (ties count half: 2w + t over 2n), so "equal" never comes from a rounded percentage
  function share(r) { var n = 2 * (r.w + r.l + (r.t || 0)), num = 2 * r.w + (r.t || 0); if (!n) return "0/0"; var g = gcd(num, n); return (num / g) + "/" + (n / g); }

  // ---- season lineup rules (docs/league_context_v1.md; checked against MFL's TYPE=league starters by tests). An unknown season has no contributions.
  var GROUP = { QB: "QB", RB: "RB", WR: "WR", TE: "TE", PK: "PK", PN: "PN", DT: "DL", DE: "DL", DL: "DL", LB: "LB", CB: "DB", S: "DB", DB: "DB" };
  var POS = ["QB", "RB", "WR", "TE", "DL", "LB", "DB", "PK", "PN"];
  var RULES = {
    2026: { total: 18, min: { QB: 1, RB: 2, WR: 2, TE: 1, PK: 1, PN: 1, DL: 2, LB: 2, DB: 2 }, max: { QB: 2, RB: 5, WR: 5, TE: 4, PK: 1, PN: 1, DL: 3, LB: 3, DB: 3 },
      slots: ["QB", "RB1", "RB2", "WR1", "WR2", "TE", "SFX", "OFX1", "OFX2", "DL1", "DL2", "LB1", "LB2", "DB1", "DB2", "DFX", "PK", "PN"] }
  };
  // a "×2" group is two slots shown together: its points are the two slots' combined production (the calculation is per slot, unchanged)
  var SLOT_GROUPS = [["QB", ["QB"], "QB"], ["RB", ["RB1", "RB2"], "RB ×2"], ["WR", ["WR1", "WR2"], "WR ×2"], ["TE", ["TE"], "TE"], ["SFX", ["SFX"], "SFX"], ["OFX", ["OFX1", "OFX2"], "OFX ×2"],
    ["DL", ["DL1", "DL2"], "DL ×2"], ["LB", ["LB1", "LB2"], "LB ×2"], ["DB", ["DB1", "DB2"], "DB ×2"], ["DFX", ["DFX"], "DFX"], ["PK", ["PK"], "K"], ["PN", ["PN"], "P"]];
  var CONTRIB = [["off", "Offense", ["QB", "RB", "WR", "TE"]], ["idp", "IDP", ["DL", "LB", "DB"]], ["kp", "Kicking & Punting", ["PK", "PN"]]];

  // A starter's recorded score: a number, or null when MFL lists him as a starter with no score (shown "—", adds nothing, never a recorded zero).
  function scoreOf(p) { var s = p && p.score; if (s == null || (typeof s === "string" && s.trim() === "")) return null; var n = Number(s); return isFinite(n) ? n : null; }
  // the stable order: higher score first; a missing score after every scored starter; equal scores by the lower MFL player id
  function sv(p) { return p.score == null ? -Infinity : p.score; }
  function cmpP(a, b) { var A = sv(a), B = sv(b); if (A !== B) return B > A ? 1 : -1; return Number(a.id) - Number(b.id); }
  function add(p) { return p.score == null ? 0 : p.score; }

  // One franchise-week: the derived slots (weekly, before any aggregation). -> { status, slots: { SLOT: {id,pos,score} }, sum, why }
  // status "ok" | "unknown_position" | "invalid" (more or fewer starters than the season's lineup, or a starter that fits no slot).
  function allocate(list, rule) {
    var a = { status: "ok", slots: {}, sum: 0, why: "", list: list.map(function (p) { return { id: p.id, pos: p.pos, score: p.score }; }) };
    for (var i = 0; i < list.length; i++) a.sum += add(list[i]);
    if (list.some(function (p) { return !p.pos; })) { a.status = "unknown_position"; a.why = "a starter's position is not in the position list"; return a; }
    var by = {}; list.forEach(function (p) { (by[p.pos] = by[p.pos] || []).push(p); });
    Object.keys(by).forEach(function (k) { by[k].sort(cmpP); });
    var bad = list.length !== rule.total;
    POS.forEach(function (k) { var n = (by[k] || []).length; if (n < rule.min[k] || n > rule.max[k]) bad = true; });
    if (bad) { a.status = "invalid"; a.why = "the starters do not match this season's lineup rules"; return a; }
    function take(k) { return by[k] && by[k].length ? by[k].shift() : null; }
    function put(slot, p) { a.slots[slot] = p ? { id: p.id, pos: p.pos, score: p.score } : null; }
    function best(keys) { var pool = []; keys.forEach(function (k) { pool = pool.concat(by[k] || []); }); pool.sort(cmpP); var c = pool[0] || null; if (c) by[c.pos].splice(by[c.pos].indexOf(c), 1); return c; }
    // required positions first, each with its highest scorers
    put("QB", take("QB")); put("RB1", take("RB")); put("RB2", take("RB")); put("WR1", take("WR")); put("WR2", take("WR")); put("TE", take("TE"));
    put("PK", take("PK")); put("PN", take("PN"));
    put("DL1", take("DL")); put("DL2", take("DL")); put("LB1", take("LB")); put("LB2", take("LB")); put("DB1", take("DB")); put("DB2", take("DB"));
    // SFX before OFX: a second starting QB goes to SFX; without one, the best remaining RB/WR/TE
    var q2 = take("QB"); put("SFX", q2 || best(["RB", "WR", "TE"]));
    put("OFX1", best(["RB", "WR", "TE"])); put("OFX2", best(["RB", "WR", "TE"]));
    put("DFX", best(["DL", "LB", "DB"]));
    var left = 0; Object.keys(by).forEach(function (k) { left += by[k].length; });
    var empty = rule.slots.filter(function (s) { return !a.slots[s]; }).length;
    if (left || empty) { a.status = "invalid"; a.why = left ? "a starter fits no slot" : "a slot could not be filled"; }
    return a;
  }

  // ---- Option B: the ties no approved step separates (canon §F.1.2-§F.1.4, Keith 2026-11-25). The Worker reports them
  // (regular_season.unresolved: { pool, franchise_ids, seeds, why }); this module never re-derives the ladder. -> [{ pool, seeds, why, fids:
  // [{ fid, pos }] }], pos = the team's place in the Worker's order. A Worker answer without the field cannot say which ties are open, so it
  // fails closed: every group level on All-Play % and total Points For that reaches the field or the first team out counts as open.
  function unresolvedTies(rows, rs) {
    var at = {}; rows.forEach(function (r, i) { at[r.franchise_id] = i + 1; });
    if (rs && Array.isArray(rs.unresolved)) {
      return rs.unresolved.map(function (u) {
        return { pool: u.pool, seeds: arr(u.seeds).map(Number), why: u.why || null, fids: arr(u.franchise_ids).filter(function (f) { return at[f]; }).map(function (f) { return { fid: f, pos: at[f] }; }) };
      }).filter(function (g) { return g.fids.length > 1; });
    }
    var groups = {};
    rows.forEach(function (r, i) {
      var x = r.regular_season || {};
      if (!x.all_play) return;
      var k = share(x.all_play) + "|" + tenths(x.points_for);
      (groups[k] = groups[k] || []).push({ fid: r.franchise_id, pos: i + 1 });
    });
    return Object.keys(groups).map(function (k) { return groups[k]; }).filter(function (g) { return g.length > 1 && g.some(function (x) { return x.pos <= 7; }); })
      .map(function (g) { var ps = g.map(function (x) { return x.pos; }); return { pool: "unknown", why: "no_worker_report", fids: g,
        seeds: [1, 2, 3, 4, 5, 6].filter(function (s) { return s >= Math.min.apply(null, ps) && s <= Math.max.apply(null, ps); }) }; });
  }

  // ---- MAT-3: a division lead the rules do not settle. MFL's standingsSort orders a division by win % (PCT), then division win % (DIVPCT), then
  // the games between the tied teams (H2H). For THREE or more teams level on both, how the games-between step works is not defined (the approved
  // Option B case), whatever their All-Play % or Points For. -> [{ division, fids }]
  function divisionTies(rows) {
    var byDiv = {}, out = [];
    rows.forEach(function (r) { var rs = r.regular_season || {}; if (rs.record && rs.division) (byDiv[String(r.division)] = byDiv[String(r.division)] || []).push(r); });
    Object.keys(byDiv).forEach(function (d) {
      var g = byDiv[d];
      function v(x) { var p = share(x).split("/"); return Number(p[1]) ? Number(p[0]) / Number(p[1]) : -1; }
      var top = Math.max.apply(null, g.map(function (r) { return v(r.regular_season.record); }));
      var lead = g.filter(function (r) { return v(r.regular_season.record) === top; });   // equal reduced fractions give identical numbers
      var topD = Math.max.apply(null, lead.map(function (r) { return v(r.regular_season.division); }));
      var lead2 = lead.filter(function (r) { return v(r.regular_season.division) === topD; });
      if (lead2.length >= 3) out.push({ division: d, fids: lead2.map(function (r) { return r.franchise_id; }) });
    });
    return out;
  }

  // ---- MAT-2: the forecast must start where these standings are. A port of the desktop page's forecastReconcile
  // (site/standings/mfl_hpm_standings_v2.html, #1521): the forecast's teams are this season's teams; every week through its week is complete;
  // every team's All-Play W-L-T from the weekly scores equals the forecast's; for the current week, the standings' own All-Play records equal them
  // too (here the ladder's regular_season.all_play; the desktop reads the D1 row's allplay_w/l/t); and that week's head-to-head results under the
  // forecast's scores are the standings' results. -> { hard: [...], corrections: [...] }; any hard difference refuses the probabilities.
  // A test runs the desktop's own function on the same inputs and requires the same verdict.
  function pad4(v) { return String(v == null ? "" : v).padStart(4, "0"); }
  function forecastReconcile(sim, P) {
    var W = Number(sim.throughWeek), by = {}, out = [], corr = [], rowsBy = {};
    (P.rows || []).forEach(function (r) { rowsBy[pad4(r.franchise_id)] = r; });
    var fids = arr(sim.teams).map(function (t) { return pad4(t.franchiseId); });
    function hard(msg) { return { hard: [msg], corrections: [] }; }
    function rec3(w, l, t) { return w + "–" + l + (t ? "–" + t : ""); }
    if (!fids.length || fids.length !== (P.rows || []).length || fids.some(function (f) { return !rowsBy[f]; })) return hard("the forecast’s teams aren’t this season’s teams");
    if (!Array.isArray(P.weeklyScores) || !Array.isArray(P.weekly)) return hard("the weekly scores couldn’t be read");
    P.weeklyScores.forEach(function (s) { if (s && Number(s.po) === 0 && Number(s.w) >= 1 && Number(s.w) <= W) (by[s.w] = by[s.w] || {})[pad4(s.fid)] = Number(s.ts); });
    for (var w = 1; w <= W; w++) if (!by[w] || fids.some(function (f) { return !(by[w][f] >= 0); })) return hard("Week " + w + "’s scores are incomplete");
    var simScore = {}; arr(sim.teams).forEach(function (t) { simScore[pad4(t.franchiseId)] = Number(t.weekScore); });
    var current = W === Number((P.regular_season || {}).through_week);
    arr(sim.teams).forEach(function (t) {
      var f = pad4(t.franchiseId), aw = 0, al = 0, at = 0;
      for (var k = 1; k <= W; k++) fids.forEach(function (g) { if (g === f) return; if (by[k][f] > by[k][g]) aw++; else if (by[k][f] < by[k][g]) al++; else at++; });
      var name = rowsBy[f].franchise_name || f;
      if (aw !== t.currentApWins || al !== t.currentApLosses || at !== t.currentApTies) out.push(name + ": All-Play " + rec3(aw, al, at) + " here, " + rec3(t.currentApWins, t.currentApLosses, t.currentApTies) + " in the forecast");
      if (Math.abs(by[W][f] - simScore[f]) > 0.051) corr.push(name + " Week " + W + ": " + (isFinite(simScore[f]) ? simScore[f].toFixed(1) : "—") + " → " + by[W][f].toFixed(1));
      var ap = rowsBy[f].regular_season && rowsBy[f].regular_season.all_play;
      if (current && (!ap || ap.w !== aw || ap.l !== al || (ap.t || 0) !== at)) out.push(name + ": standings All-Play " + (ap ? rec3(ap.w, ap.l, ap.t || 0) : "missing") + ", weekly scores " + rec3(aw, al, at));
    });
    P.weekly.forEach(function (g) {
      if (!g || Number(g.w) !== W || Number(g.po) !== 0) return;
      var a = pad4(g.fid), b = pad4(g.opp);
      if (!(a in simScore) || !(b in simScore)) return;
      var here = Math.sign(Number(g.ts) - Number(g.os)), there = Math.sign(simScore[a] - simScore[b]);
      if (here !== there && a < b) out.push((rowsBy[a].franchise_name || a) + " v " + (rowsBy[b].franchise_name || b) + ", Week " + W + ": the result differs");
    });
    return { hard: out, corrections: out.length ? [] : corr };
  }

  function build(I) {
    var M = { state: "error", why: "", problems: [] };
    var st = I.standings, Rm = I.mods && I.mods.race, CLm = I.mods && I.mods.clinch, OD = I.mods && I.mods.odds;
    if (!st || st.ok !== true || !Array.isArray(st.rows) || !Rm || !OD) { M.why = "The standings did not load."; return M; }
    var rsx = st.regular_season || {};
    if (st.standings_basis !== "regular_season_ladder" || rsx.status !== "ok") { M.state = "unavailable"; M.why = "The Worker could not seed this season from its weekly results" + (rsx.status ? " (" + rsx.status + ")" : "") + ", so no seeds are shown."; return M; }
    var through = Number(rsx.through_week), lastReg = Number(rsx.last_regular_season_week);
    if (!(through >= 1) || !(lastReg >= through)) { M.why = "The standings did not say which weeks are complete."; return M; }
    var rows = st.rows.slice(), N = {}, DIV = {}, DIVN = {}, FIDS = [];
    rows.forEach(function (r) { N[r.franchise_id] = r.franchise_name; DIV[r.franchise_id] = String(r.division); DIVN[String(r.division)] = r.division_name; FIDS.push(r.franchise_id); });
    var payload = { rows: rows, weeklyScores: st.weeklyScores || [], weekly: st.weekly || [], regular_season: rsx, standings_basis: st.standings_basis };
    M.state = "ok"; M.season = I.season; M.through = through; M.lastReg = lastReg; M.names = N; M.division = DIV; M.divisions = DIVN; M.fids = FIDS; M.rows = rows;
    M.abbr = I.abbr || {}; M.generated = st.generated || "";
    M.byFid = {}; rows.forEach(function (r) { M.byFid[r.franchise_id] = r; });

    // ---- race
    M.why = {}; rows.forEach(function (r) { try { M.why[r.franchise_id] = Rm.whySeedForRow(r, rows, payload.weeklyScores, payload); } catch (e) { M.why[r.franchise_id] = null; } });
    var raw = I.schedule && I.schedule.raw;
    M.magic = raw ? Rm.magicNumbers(payload, raw) : { status: "unavailable" };
    var h2hGames = null;
    if (I.schedule && I.schedule.byWeek) { h2hGames = {}; Object.keys(I.schedule.byWeek).forEach(function (w) { if (Number(w) > lastReg) return; I.schedule.byWeek[w].forEach(function (p) { h2hGames[p[0]] = (h2hGames[p[0]] || 0) + 1; h2hGames[p[1]] = (h2hGames[p[1]] || 0) + 1; }); }); }
    var cl = CLm ? CLm.analyze({ teams: rows.map(function (r) { return { fid: r.franchise_id, division: r.division, h2h: r.regular_season.record, ap: r.regular_season.all_play }; }),
      h2hGames: h2hGames, apGamesLeft: (rows.length - 1) * (lastReg - through), byes: 2, wildCards: 2 }) : { status: "unavailable", byFid: {} };
    M.clinch = cl.byFid || {}; M.clinchStatus = cl.status;
    // forecast: only when it was run after the same week as the standings (else "—" with the reason)
    // ...and only when it seeded its simulated seasons by the approved playoff rules (model.seedingRule; a forecast made before the
    // 2026-11-25 correction used the overall-record step and is refused, whatever its week)
    var fcx = I.forecast, sameWeek = !!(fcx && Number(fcx.throughWeek) === through), ruleOk = !!(fcx && fcx.seedingRule === SEEDING_RULE);
    var rc = sameWeek && ruleOk ? forecastReconcile(fcx, payload) : null, fresh = !!(rc && rc.hard.length === 0);
    M.forecast = { fresh: fresh, throughWeek: fcx ? Number(fcx.throughWeek) : null, at: fcx ? fcx.generatedAtUtc : null, runs: fcx ? fcx.runs : null, replay: !!(fcx && fcx.replayOf), by: {}, reconcile: rc,
      why: !fcx ? "No forecast is available in this mode." : !sameWeek ? "The forecast was run after Week " + fcx.throughWeek + ", not Week " + through + ", so it is not shown."
        : !ruleOk ? "The forecast was made under earlier seeding rules, so its probabilities are not shown. Verified clinches still show."
        : !fresh ? "The forecast doesn’t start from these standings (" + rc.hard[0] + (rc.hard.length > 1 ? ", and " + (rc.hard.length - 1) + " more" : "") + "), so its probabilities are not shown. Verified clinches still show."
        : rc.corrections.length ? "A score changed after the forecast ran without changing any result (" + rc.corrections[0] + ")." : "" };
    FIDS.forEach(function (f) {
      var t = fcx && arr(fcx.teams).filter(function (x) { return x.franchiseId === f; })[0], v = OD.verdicts(M.clinch[f] || null);
      // verified: the clinch rules' own outcome (100% / 0%), independent of any simulation; kept wherever simulated percentages are withheld
      M.forecast.by[f] = { verdicts: v, verified: v.playoffs ? OD.pct(null, v.playoffs) : null, playoffs: fresh && t ? OD.pct(t.playoffs, v.playoffs) : (v.playoffs ? OD.pct(null, v.playoffs) : "—"), bye: fresh && t ? OD.pct(t.bye, v.bye) : "—", division: fresh && t ? OD.pct(t.division, v.division) : "—" };
    });
    // Option B: each open tie withholds the seeds it affects (the Worker's list: a bye tie moves seeds 2-6, a tie for the last wild card the
    // seed that wild card holds), the tied teams' tags and simulated Playoff %, and the cutoff line it spans
    var ties = unresolvedTies(rows, rsx), wSeeds = {}, wFids = {}, cutHidden = false, byeTie = false;
    ties.forEach(function (g) {
      g.fids.forEach(function (x) { wFids[x.fid] = true; });
      g.seeds.forEach(function (s) { wSeeds[s] = true; });
      var ps = g.fids.map(function (x) { return x.pos; });
      if (g.pool === "wild_card" || (Math.min.apply(null, ps) <= 6 && Math.max.apply(null, ps) >= 7)) cutHidden = true;
      if (g.pool === "bye" || (Math.min.apply(null, ps) <= 2 && Math.max.apply(null, ps) >= 3)) byeTie = true;
    });
    // MAT-3: an unsettled division lead decides which team is a division winner, and division winners shape the whole field (byes go to division
    // winners; the others compete for wild cards). So no seed, tag or cutoff line is supported for anyone, and no magic number (division and wild-card
    // races both depend on it). Simulated Playoff % is withheld for EVERY team (re-review of 18d45312): any team's wild-card chance can depend on
    // which tied team takes the division berth, and nothing shows it doesn't. Records, verified clinch/elimination outcomes and locked seeds stay.
    var dt = divisionTies(rows), divAll = dt.length > 0, byeHidden = false;
    if (divAll) { for (var s = 1; s <= 6; s++) wSeeds[s] = true; cutHidden = true; byeHidden = true; FIDS.forEach(function (f) { wFids[f] = true; }); }
    var pctHeld = {}; ties.forEach(function (g) { g.fids.forEach(function (x) { pctHeld[x.fid] = true; }); });
    if (divAll) FIDS.forEach(function (f) { pctHeld[f] = true; });
    if (byeTie) byeHidden = true;
    M.withheld = { seeds: wSeeds, fids: wFids, cutHidden: cutHidden, byeHidden: byeHidden, groups: ties, divisionTies: dt, magicHidden: divAll, pctHeld: pctHeld, any: Object.keys(wFids).length > 0 };

    // ---- scoring
    M.sf = Rm.scoredFaced(payload);
    M.leaders = Rm.seasonWeeklyLeaders(payload, { weeks: "regular" });
    M.weeks = {}; M.leagueAvg = {};
    for (var k = 1; k <= through; k++) {
      var t = Rm.weekTable(payload, k);
      M.weeks[k] = t;
      var xs = payload.weeklyScores.filter(function (r) { return Number(r.w) === k; }).map(function (r) { return Number(r.ts); });
      M.leagueAvg[k] = xs.length ? xs.reduce(function (s, x) { return s + x; }, 0) / xs.length : null;
    }

    // ---- contributions
    M.contrib = contributions(I, M, payload);
    return M;
  }

  function contributions(I, M, payload) {
    var C = { state: "unavailable", why: "", version: null };
    var rule = RULES[I.season];
    if (!rule) { C.why = "Contributions are not available for this season (its lineup rules are not in this preview)."; return C; }
    var P = I.positions;
    if (!P || !P.positions || !P.version) { C.why = "Contributions need a dated, versioned position list; none is available in this mode, so they are not shown rather than using today's positions."; return C; }
    C.version = P.version; C.sha = P.sha256_16 || null;
    if (!I.weeks) { C.state = I.weeksState === "error" ? "unavailable" : "loading"; C.why = I.weeksState === "error" ? "Some weeks’ lineups did not load, so contributions are not shown." : "Loading the weekly lineups…"; return C; }
    var through = M.through, FIDS = M.fids, team = {};
    payload.weeklyScores.forEach(function (r) { team[r.fid + "|" + r.w] = Number(r.ts); });
    var byPos = {}, bySlot = {}, audit = {}, problems = [], noScore = [], missingWeeks = [];
    FIDS.forEach(function (f) { byPos[f] = {}; POS.forEach(function (p) { byPos[f][p] = 0; }); bySlot[f] = {}; rule.slots.forEach(function (s) { bySlot[f][s] = 0; }); audit[f] = {}; });
    for (var w = 1; w <= through; w++) {
      var W = I.weeks && I.weeks[w], wr = W && W.weeklyResults;
      if (!wr) { missingWeeks.push(w); continue; }
      var seen = {};
      arr(wr.matchup).forEach(function (m) { arr(m.franchise).forEach(function (f) { if (seen[f.id]) return; seen[f.id] = true;
        var list = arr(f.player).filter(function (p) { return p.status === "starter"; }).map(function (p) {
          var s = scoreOf(p), raw = P.positions[String(p.id)];
          if (s == null) noScore.push({ w: w, fid: f.id, id: String(p.id) });
          return { id: String(p.id), score: s, pos: raw ? (GROUP[raw] || null) : null };
        });
        var a = allocate(list, rule);
        a.team = team[f.id + "|" + w]; a.official = Number(f.score);
        // reconcile: the starters' recorded points must equal the team's official score that week (to the tenth), from BOTH reads
        a.reconciles = tenths(a.sum) === tenths(a.official) && tenths(a.official) === tenths(a.team);
        if (!a.reconciles) problems.push({ w: w, fid: f.id, why: "starters " + (Math.round(a.sum * 10) / 10) + " vs official " + a.official + " vs standings " + a.team });
        if (a.status !== "ok") problems.push({ w: w, fid: f.id, why: a.why });
        if (audit[f.id]) audit[f.id][w] = a;
        if (!byPos[f.id]) return;
        list.forEach(function (p) { if (p.pos) byPos[f.id][p.pos] += add(p); });
        if (a.status === "ok") Object.keys(a.slots).forEach(function (s) { bySlot[f.id][s] += add(a.slots[s]); });
      }); });
      FIDS.forEach(function (f) { if (!audit[f][w]) missingWeeks.push(w + ":" + f); });
    }
    C.noScore = noScore; C.problems = problems; C.missing = missingWeeks;
    if (missingWeeks.length) { C.why = "Some weeks' lineups did not load, so contributions are not shown."; return C; }
    // MAT-1 quarantine: a team with ANY team-week that does not reconcile or cannot be allocated has NO supported season contribution (its points
    // cannot enter a total, and dropping the week would divide the rest by the wrong number of weeks). Its figures are withheld (null), and league
    // RANKS are withheld for every team, because each team's rank depends on the withheld team's value. Official team scores are untouched.
    var bad = {}; problems.forEach(function (p) { (bad[p.fid] = bad[p.fid] || []).indexOf(p.w) < 0 && bad[p.fid].push(p.w); });
    var anyBad = Object.keys(bad).length > 0;
    C.quarantined = bad; C.ranksWithheld = anyBad;
    C.state = anyBad ? "partial" : "ok";
    C.why = anyBad ? Object.keys(bad).map(function (f) { return (M.names[f] || f) + " (Week " + bad[f].join(", ") + ")"; }).join("; ") + ": the starters’ points do not add up to the official score, or could not be allocated. That team’s contributions are not shown, and no league ranks are shown, since every rank would depend on it." : "";
    // groups, positions, slots: season totals, per week, and league rank (1 + teams strictly higher, compared at the tenth)
    function rank(vals) { var o = {}; Object.keys(vals).forEach(function (f) { var me = tenths(vals[f]); o[f] = 1 + Object.keys(vals).filter(function (g) { return tenths(vals[g]) > me; }).length; }); return o; }
    function shared(o, f) { var n = 0; Object.keys(o).forEach(function (g) { if (o[g] === o[f]) n++; }); return n > 1; }
    function pack(getter) {
      var vals = {}; FIDS.forEach(function (f) { vals[f] = bad[f] ? null : getter(f); });
      var rk = anyBad ? null : rank(vals), out = {};
      FIDS.forEach(function (f) { out[f] = { pts: vals[f], pw: vals[f] == null ? null : vals[f] / through, rank: rk ? rk[f] : null, tie: rk ? shared(rk, f) : false }; });
      return out;
    }
    C.groups = {}; CONTRIB.forEach(function (g) { C.groups[g[0]] = pack(function (f) { return g[2].reduce(function (s, p) { return s + byPos[f][p]; }, 0); }); });
    C.byPos = {}; POS.forEach(function (p) { C.byPos[p] = pack(function (f) { return byPos[f][p]; }); });
    C.bySlot = {}; SLOT_GROUPS.forEach(function (g) { C.bySlot[g[0]] = pack(function (f) { return g[1].reduce(function (s, x) { return s + bySlot[f][x]; }, 0); }); });
    C.audit = audit;
    C.recon = FIDS.map(function (f) {
      var tot = payload.weeklyScores.filter(function (r) { return r.fid === f && Number(r.w) <= through; }).reduce(function (s, r) { return s + Number(r.ts); }, 0);
      if (bad[f]) return { fid: f, team: tot, groups: null, slots: null, ok: false, quarantined: bad[f] };
      var g = 0; CONTRIB.forEach(function (x) { g += C.groups[x[0]][f].pts; });
      var sl = 0; SLOT_GROUPS.forEach(function (x) { sl += C.bySlot[x[0]][f].pts; });
      return { fid: f, team: tot, groups: g, slots: sl, ok: tenths(tot) === tenths(g) && tenths(tot) === tenths(sl) };
    });
    return C;
  }

  return { build: build, allocate: allocate, unresolvedTies: unresolvedTies, SEEDING_RULE: SEEDING_RULE, divisionTies: divisionTies, forecastReconcile: forecastReconcile, share: share, RULES: RULES, POS: POS, SLOT_GROUPS: SLOT_GROUPS, CONTRIB: CONTRIB, GROUP: GROUP, cmpP: cmpP };
});
