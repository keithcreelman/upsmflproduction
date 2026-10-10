/* Player Stats (#league/stats) — mobile per-position leaderboard. Position
   tabs + a curated set of per-position columns + search; tap a player → the
   shared player sheet. Read-only.

   ACTUAL POINTS (Keith 2026-10-09 review). Every Pts / PPG / L2-L4 PPG / MFL
   wks / rank on this screen comes from the app's ONE scoring path,
   DATA.getSeasonScoring() — MFL's own playerScores W=ALL for THIS league
   (site/m/season_scoring.js) — the same numbers the player sheet and the
   Players market show. It used to read /api/advanced-stats-leaderboard's
   mfl_points / mfl_ppg, a precompute that stops at the last FINAL week: on
   2026-10-09, after Thursday's DAL–TB game, 53 players were a week behind MFL
   (Dak Prescott 107.5 here vs MFL's 125.5) and tapping one showed a different
   PPG on his sheet.
     - WHO is listed, and on which tab, is MFL's: the players export already
       loaded at boot (no new request), at the MFL position (DE/DT → DL, CB/S
       → DB), every player with a posted score this season. The leaderboard's
       nflverse position put 53 MFL defensive ends on the LB tab (Rousseau
       "#1 LB"), and its 500-row cap left out 302 scoring IDPs.
       · A scoring player MFL's export lacks, but the leaderboard has, is still
         listed (union), so a partial export can't silently drop him.
       · MFL's players export didn't load → the leaderboard's rows, as before,
         and the screen says so (IDPs capped at 500, nflverse positions).
     - The leaderboard is still the source of the nflverse BOX SCORE columns,
       joined by MFL id and labelled with the weeks it covers.
     - Rank = season_scoring's rankMap with the PPG-rank minimum (Keith
       2026-10-02), over every MFL player at the MFL position — exactly the
       player sheet's ranking, so the two can't disagree. (Without MFL's player
       list: rank within the listed rows, said on screen.)
     - MFL's scoring unreadable → the last VERIFIED stored totals (the
       leaderboard's finalized weeks), labelled with that period and the time
       the app read them. A stored copy that doesn't state its weeks shows no
       points at all rather than a guess.

   OWNERSHIP comes from live MFL rosters through the app's one rule,
   DATA.ownerOfPid / DATA.rosterOwnership (app.js, #1208) — the same answer the
   player sheet, the Players market and search give — never the leaderboard's
   mfl_franchise_id (#1203). Positions display in MFL's vocabulary
   (OLB/ILB/MLB → LB, FS/SS → S) per Keith 2026-06-20. */
(function () {
  "use strict";
  if (!window.UPS_MOBILE) return;
  var M = window.UPS_MOBILE;
  var U = M.util, API = M.api;

  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function nn(v) { return (v == null || v === "" || isNaN(Number(v))) ? null : Number(v); }
  function round1(v) { return Math.round(v * 10) / 10; }

  // nflverse position → MFL's set (DT|DE|LB|CB|S). Only used to DISPLAY a
  // stored-copy row's position when the worker sent no mfl_position.
  function mflPos(raw) {
    var p = String(raw || "").toUpperCase();
    if (p === "ILB" || p === "MLB" || p === "OLB" || p === "LB") return "LB";
    if (p === "FS" || p === "SS" || p === "S" || p === "SAF") return "S";
    if (p === "NT") return "DT";
    return p;
  }

  // Position → tab group. The player sheet's rank and the lineup both use
  // UPS_FRONT_OFFICE_LINEUP.posGroup; this is the same table for the moments
  // it isn't loaded (tests/mobile_stats_mfl_universe.test.mjs checks they agree
  // on every position).
  var GROUP = { QB: "QB", RB: "RB", FB: "RB", HB: "RB", WR: "WR", TE: "TE", PK: "PK", K: "PK", PN: "PN", P: "PN",
    DT: "DL", DE: "DL", NT: "DL", DL: "DL", LB: "LB", OLB: "LB", ILB: "LB", MLB: "LB",
    CB: "DB", S: "DB", FS: "DB", SS: "DB", DB: "DB" };
  function groupOf(pos) {
    var p = String(pos || "").toUpperCase();
    var FOL = window.UPS_FRONT_OFFICE_LINEUP;
    if (FOL && FOL.posGroup) { var g = FOL.posGroup(p); return g === "OTH" ? "" : g; }
    return GROUP[p] || "";
  }
  // A leaderboard row's tab: the worker's mfl_position (MFL's own) when it sent
  // one, else its nflverse position group.
  function lbGroup(r) {
    return groupOf(r.mfl_position) || String(r.pos_group || "").toUpperCase();
  }

  function D() { return M.data || {}; }
  function SSMOD() { return window.UPS_MOBILE_SEASON_SCORING || null; }
  // MFL player ids are digits; the leaderboard sends numbers, MFL strings.
  function pidKey(id) {
    var d = String(id == null ? "" : id).replace(/\D/g, "");
    return d ? String(parseInt(d, 10)) : "";
  }

  // ── Columns ──
  // g(r) → value | null over a normalized row (see buildRows). null = "—",
  // which always sorts LAST whichever way a column is sorted. f: dec1 | dec2 |
  // pct | pct100 | delta | epa | ma ("made/attempts", g → { m, a }) — else an
  // integer. w: px width at phone size. src names the source AND period a
  // column reports, which drives the heading band over it:
  //   pts   MFL actual points (season scoring, or the stored copy)
  //   rec   the last N FINAL weeks (season scoring)
  //   box   nflverse box score (the leaderboard's coverage week)
  //   pfr   PFR advanced defense via nflverse (same weekly refresh as box)
  //   srt   /api/player-starter-rates — each FINAL week vs that week's UPS starters
  //   rz    red-zone play-by-play (the leaderboard's coverage week)
  //   adv   season-level nflfastR / Next Gen / routes
  // Rate columns carry a minimum sample (min) and read "—" below it, so a
  // 1-carry 40-yard run can't top a YPC sort (Keith 2026-10-10: sorting must
  // handle unavailable values consistently).
  function L(r) { return r.lb || {}; }
  function rate(n, d, min) { var dd = num(d); return (d != null && dd >= (min || 1)) ? num(n) / dd : null; }
  function madeAtt(m, a) { var aa = nn(a); return aa == null ? null : { m: num(m), a: aa }; }
  var C = {
    pts:   { l: "Pts", src: "pts", w: 46, f: "dec1", t: "Total MFL fantasy points, UPS scoring", g: function (r) { return r.pts; } },
    ppg:   { l: "PPG", src: "pts", w: 40, f: "dec1", strong: true, t: "MFL points per MFL scored week", g: function (r) { return r.ppg; } },
    rcnt:  { l: "PPG", src: "rec", w: 46, f: "dec1", t: "Points per MFL scored week over the last final weeks", g: function (r) { return r.rec ? r.rec.ppg : null; } },
    wks:   { l: "Wks", src: "pts", w: 30, dim: true, t: "Weeks MFL posted a score for him (0.0 included) — MFL's own AVG denominator", g: function (r) { return r.games; } },
    payd:  { l: "PaYd",  src: "box", t: "Passing yards", g: function (r) { return nn(L(r).pass_yds); } },
    patd:  { l: "PaTD",  src: "box", t: "Passing touchdowns", g: function (r) { return nn(L(r).pass_tds); } },
    patt:  { l: "Att",   src: "box", t: "Pass attempts", g: function (r) { return nn(L(r).pass_att); } },
    cmppct:{ l: "Cmp%",  src: "box", f: "pct", t: "Completion % (20+ attempts)", g: function (r) { return rate(L(r).pass_cmp, L(r).pass_att, 20); } },
    pint:  { l: "Int",   src: "box", t: "Interceptions thrown", g: function (r) { return nn(L(r).pass_ints); } },
    qbsk:  { l: "Sk",    src: "box", t: "Times sacked", g: function (r) { return nn(L(r).pass_sacks); } },
    ya:    { l: "Y/A",   src: "box", f: "dec1", t: "Passing yards per attempt (20+ attempts)", g: function (r) { return rate(L(r).pass_yds, L(r).pass_att, 20); } },
    ruatt: { l: "Att",   src: "box", t: "Rushing attempts", g: function (r) { return nn(L(r).rush_att); } },
    ruyd:  { l: "RuYd",  src: "box", t: "Rushing yards", g: function (r) { return nn(L(r).rush_yds); } },
    rutd:  { l: "RuTD",  src: "box", t: "Rushing touchdowns", g: function (r) { return nn(L(r).rush_tds); } },
    ypc:   { l: "YPC",   src: "box", f: "dec1", t: "Rushing yards per carry (10+ carries)", g: function (r) { return rate(L(r).rush_yds, L(r).rush_att, 10); } },
    tgt:   { l: "Tgt",   src: "box", t: "Targets", g: function (r) { return nn(L(r).targets); } },
    rec:   { l: "Rec",   src: "box", t: "Receptions", g: function (r) { return nn(L(r).receptions); } },
    recyd: { l: "RecYd", src: "box", w: 40, t: "Receiving yards", g: function (r) { return nn(L(r).rec_yds); } },
    rectd: { l: "RecTD", src: "box", w: 40, t: "Receiving touchdowns", g: function (r) { return nn(L(r).rec_tds); } },
    ypr:   { l: "Y/R",   src: "box", f: "dec1", t: "Yards per reception (5+ catches)", g: function (r) { return rate(L(r).rec_yds, L(r).receptions, 5); } },
    catchpct: { l: "Catch%", src: "box", w: 46, f: "pct", t: "Catches ÷ targets (10+ targets)", g: function (r) { return rate(L(r).receptions, L(r).targets, 10); } },
    tgtsh: { l: "Tgt%",  src: "box", f: "pct", t: "Share of his team's targets in the weeks he played", g: function (r) { return nn(L(r).target_share); } },
    // "Solo", not "Tkl": def_tackles_total is SOLO tackles only (worker
    // SUM(def_tackles_solo)); MFL's TK also counts assisted tackles.
    solo:  { l: "Solo",  src: "box", t: "Solo tackles", g: function (r) { return nn(L(r).def_tackles_total); } },
    ast:   { l: "Ast",   src: "box", t: "Assisted tackles", g: function (r) { return nn(L(r).def_tackles_ast); } },
    tfl:   { l: "TFL",   src: "box", t: "Tackles for loss", g: function (r) { return nn(L(r).def_tfl); } },
    // Snap% (Keith 2026-10-10): his defensive snaps ÷ his team's defensive
    // snaps, counting only the games he played on defense; count under it.
    snappct: { l: "Snap%", src: "box", w: 46, f: "pctnd", t: "His defensive snaps ÷ his team's defensive snaps, in the games he played on defense. Not box or slot alignment (no source has it).",
      nd: function (r) { var a = nn(L(r).def_snaps_total), d = nn(L(r).def_snaps_team); return a != null && d ? [a, d] : null; },
      g: function (r) { var a = nn(L(r).def_snaps_total), d = nn(L(r).def_snaps_team); return a != null && d ? a / d : null; } },
    // Offensive playing time (Keith 2026-10-10): his offensive snaps ÷ his NFL
    // team's offensive snaps in exactly the games he played on offense (the
    // worker sums both over the same games); — when a team total is missing.
    osnap: { l: "Snaps", src: "snap", w: 40, t: "Offensive snaps (nflverse snap counts); — when there's no snap record for him", g: function (r) { return nn(L(r).off_snaps_total); } },
    osnappct: { l: "Snap%", src: "snap", w: 46, f: "pctnd", t: "His offensive snaps ÷ his team's offensive snaps, in the games he played on offense",
      nd: function (r) { var a = nn(L(r).off_snaps_total), d = nn(L(r).off_snaps_team); return a != null && d ? [a, d] : null; },
      g: function (r) { var a = nn(L(r).off_snaps_total), d = nn(L(r).off_snaps_team); return a != null && d ? a / d : null; } },
    sk:    { l: "Sk",    src: "box", f: "dec1", t: "Sacks", g: function (r) { return nn(L(r).def_sacks); } },
    ff:    { l: "FF",    src: "box", t: "Forced fumbles", g: function (r) { return nn(L(r).def_ff); } },
    pd:    { l: "PD",    src: "box", t: "Passes defended", g: function (r) { return nn(L(r).def_pass_def); } },
    intd:  { l: "INT",   src: "box", t: "Interceptions", g: function (r) { return nn(L(r).def_ints); } },
    press: { l: "Press", src: "pfr", t: "Pressures (PFR: hurries + knockdowns + sacks). — when PFR has no record for him.", g: function (r) { return nn(L(r).def_pressures); } },
    // Completions allowed / targets in coverage, sorted by targets (Keith 2026-10-10).
    cmptgt:{ l: "Cmp/Tgt", src: "pfr", w: 52, f: "ma", t: "Completions allowed / times targeted in coverage (PFR); sorts by targets",
      g: function (r) { var t = nn(L(r).def_targets); return t == null ? null : { m: num(L(r).def_completions_allowed), a: t }; } },
    ydsa:  { l: "Yds",   src: "pfr", t: "Yards allowed in coverage (PFR)", g: function (r) { return nn(L(r).def_yards_allowed); } },
    fgm:   { l: "FGM",   src: "box", t: "Field goals made", g: function (r) { return nn(L(r).fg_made); } },
    fga:   { l: "FGA",   src: "box", t: "Field goals attempted", g: function (r) { return nn(L(r).fg_att); } },
    fgpct: { l: "FG%",   src: "box", f: "pct", t: "Field goal %", g: function (r) { return rate(L(r).fg_made, L(r).fg_att, 1); } },
    xpm:   { l: "XPM",   src: "box", t: "Extra points made", g: function (r) { return nn(L(r).xp_made); } },
    // Distance bands: the play-by-play's own bands (0–39 / 40–49 / 50–59 /
    // 60+). There is no 0–19 / 20–29 / 30–39 split in any 2026 source yet.
    fg39:  { l: "0–39",  src: "box", w: 40, f: "ma", t: "Field goals made/attempted, 0–39 yards", g: function (r) { return madeAtt(L(r).fg_made_0_39, L(r).fg_att_0_39); } },
    fg49:  { l: "40–49", src: "box", w: 40, f: "ma", t: "Field goals made/attempted, 40–49 yards", g: function (r) { return madeAtt(L(r).fg_made_40_49, L(r).fg_att_40_49); } },
    fg59:  { l: "50–59", src: "box", w: 40, f: "ma", t: "Field goals made/attempted, 50–59 yards", g: function (r) { return madeAtt(L(r).fg_made_50_59, L(r).fg_att_50_59); } },
    fg60:  { l: "60+",   src: "box", w: 40, f: "ma", t: "Field goals made/attempted, 60+ yards", g: function (r) { return madeAtt(L(r).fg_made_60plus, L(r).fg_att_60plus); } },
    punts: { l: "Punts", src: "box", t: "Punts", g: function (r) { return nn(L(r).punts); } },
    // I20%: the rate over its numerator/denominator in one cell ("41%" over "9/22").
    i20p:  { l: "I20%",  src: "box", f: "pctnd", t: "Inside-20 punts ÷ all punts, 10+ punts (touchbacks, fair catches, returns and blocks all count as punts)",
      nd: function (r) { return L(r).punts ? [num(L(r).punt_inside20), num(L(r).punts)] : null; },
      g: function (r) { return rate(L(r).punt_inside20, L(r).punts, 10); } },
    navg:  { l: "Net",   src: "box", f: "dec1", t: "Gross yards minus return yards, per punt. Touchbacks are not charged 20 yards, so this runs higher than the NFL's official net.", g: function (r) { return nn(L(r).punt_net_avg); } },
    // Boom / Bust / Startable vs that week's UPS starters (Keith 2026-10-10).
    // The % reads "—" below 3 qualifying weeks; the count under it always shows.
    sstart:{ l: "Start%", src: "srt", w: 46, f: "pctnd", t: "Startable: share of his played weeks at or above that week's UPS-starter median at his position (3+ weeks)",
      nd: function (r) { var x = srRec(r); return x ? [x.startable_n, x.q] : null; }, g: function (r) { var x = srRec(r); return x && x.startable_pct != null ? x.startable_pct / 100 : null; } },
    sboom: { l: "Boom%", src: "srt", w: 44, f: "pctnd", t: "Share of his played weeks at or above that week's UPS-starter 75th percentile (3+ weeks)",
      nd: function (r) { var x = srRec(r); return x ? [x.boom_n, x.q] : null; }, g: function (r) { var x = srRec(r); return x && x.boom_pct != null ? x.boom_pct / 100 : null; } },
    sbust: { l: "Bust%", src: "srt", w: 44, f: "pctnd", t: "Share of his played weeks at or below that week's UPS-starter 25th percentile (3+ weeks)",
      nd: function (r) { var x = srRec(r); return x ? [x.bust_n, x.q] : null; }, g: function (r) { var x = srRec(r); return x && x.bust_pct != null ? x.bust_pct / 100 : null; } },
    // Availability (Keith 2026-10-10): games he played ÷ games his NFL team
    // played, final weeks. Only played weeks are graded; a 0.0 in a game he
    // played is graded (a bust), a game he didn't play is not.
    sq:    { l: "Played", src: "srt", w: 40, f: "ma", t: "Games he played ÷ games his NFL team played (final weeks); only played games are graded",
      g: function (r) { var x = srRec(r); return x && x.team_games_n ? { m: x.played_n, a: x.team_games_n } : null; },   // 0/0 = nothing to say: "—"
      sv: function (v) { return v.m * 100 - v.a; } },
    // Kickers and punters: about 12 UPS starters a week — counts, not a ranking.
    sstartn:{ l: "Start", src: "srt", w: 40, f: "ma", t: "Played weeks at or above that week's UPS-starter median (count / graded weeks)",
      g: function (r) { var x = srRec(r); return x && x.q ? { m: x.startable_n, a: x.q } : null; }, sv: function (v) { return v.m * 100 - v.a; } },
    sboomn: { l: "Boom",  src: "srt", w: 40, f: "ma", t: "Played weeks at or above that week's UPS-starter 75th percentile (count / graded weeks)",
      g: function (r) { var x = srRec(r); return x && x.q ? { m: x.boom_n, a: x.q } : null; }, sv: function (v) { return v.m * 100 - v.a; } },
    sbustn: { l: "Bust",  src: "srt", w: 40, f: "ma", t: "Played weeks at or below that week's UPS-starter 25th percentile (count / graded weeks)",
      g: function (r) { var x = srRec(r); return x && x.q ? { m: x.bust_n, a: x.q } : null; }, sv: function (v) { return v.m * 100 - v.a; } },
    // Red zone (inside the opponent's 20; two-point tries excluded). Shares are
    // of his TEAM's plays in the games he played; the count sits under the %.
    rzatt: { l: "Att",   src: "rz", t: "Inside-20 pass attempts (sacks and two-point tries not counted)", g: function (r) { return rzV2(r) ? nn(L(r).pass_att_i20) : null; } },
    rzcmp: { l: "Cmp",   src: "rz", t: "Inside-20 completions", g: function (r) { return rzV2(r) ? nn(L(r).pass_cmp_i20) : null; } },
    rztd:  { l: "TD",    src: "rz", t: "Inside-20 passing touchdowns", g: function (r) { return rzV2(r) ? nn(L(r).pass_tds_i20) : null; } },
    // The TEAM's red-zone pass rate in the games he played — every inside-20
    // play his team ran, whoever was at QB (Keith 2026-10-10: not his own
    // split; the play-by-play doesn't say who was at QB on a handoff).
    rztmp: { l: "Tm P%", src: "rz", w: 46, f: "pctnd", t: "His TEAM's inside-20 dropbacks (passes, sacks, scrambles) ÷ all its inside-20 plays, in the games he played — whoever was at QB. Not his own pass/run split.",
      nd: function (r) { if (!rzV2(r)) return null; var d = nn(L(r).team_rz_dropbacks), n = nn(L(r).team_rz_plays); return d == null || !n ? null : [d, n]; },
      g: function (r) { if (!rzV2(r)) return null; var d = nn(L(r).team_rz_dropbacks), n = nn(L(r).team_rz_plays); return d == null || !n ? null : d / n; } },
    rzcar: { l: "I20",   src: "rz", t: "Carries inside the 20", g: function (r) { return rzV2(r) ? nn(L(r).rush_att_i20) : null; } },
    rzcsh: { l: "I20%",  src: "rz", w: 46, f: "pctnd", t: "His share of his team's carries inside the 20, in the games he played",
      nd: function (r) { return rzV2(r) && L(r).team_rush_att_i20 != null ? [num(L(r).rush_att_i20), L(r).team_rush_att_i20] : null; }, g: function (r) { return rzV2(r) ? nn(L(r).rz_rush_share) : null; } },
    i5car: { l: "I5",    src: "rz", t: "Carries inside the 5", g: function (r) { return rzV2(r) ? nn(L(r).rush_att_i5) : null; } },
    i5sh:  { l: "I5%",   src: "rz", w: 46, f: "pctnd", t: "His share of his team's carries inside the 5, in the games he played",
      nd: function (r) { return rzV2(r) && L(r).team_rush_att_i5 != null ? [num(L(r).rush_att_i5), L(r).team_rush_att_i5] : null; }, g: function (r) { return rzV2(r) ? nn(L(r).gl_rush_share) : null; } },
    rztgt: { l: "I20",   src: "rz", t: "Targets inside the 20", g: function (r) { return rzV2(r) ? nn(L(r).targets_i20) : null; } },
    rztsh: { l: "I20%",  src: "rz", w: 46, f: "pctnd", t: "His share of his team's targets inside the 20, in the games he played",
      nd: function (r) { return rzV2(r) && L(r).team_targets_i20 != null ? [num(L(r).targets_i20), L(r).team_targets_i20] : null; }, g: function (r) { return rzV2(r) ? nn(L(r).rz_target_share) : null; } },
    eztgt: { l: "EZ",    src: "rz", t: "End-zone targets: passes thrown to him that reached the end zone, from anywhere on the field", g: function (r) { return rzV2(r) ? nn(L(r).targets_ez) : null; } },
    ezsh:  { l: "EZ%",   src: "rz", w: 46, f: "pctnd", t: "His share of his team's end-zone targets, in the games he played",
      nd: function (r) { return rzV2(r) && L(r).team_targets_ez != null ? [num(L(r).targets_ez), L(r).team_targets_ez] : null; }, g: function (r) { return rzV2(r) ? nn(L(r).ez_target_share) : null; } },
    eepa:  { l: "EPA",   src: "adv", w: 40, f: "epa", t: "Expected points added per play (nflfastR)", g: function (r) { var x = epaRecM(r); return x && x.epa != null ? x.epa : null; } },
    ecpoe: { l: "CPOE",  src: "adv", w: 40, f: "delta", t: "Completion % over expected (nflfastR)", g: function (r) { return epaCpoe(r); } },
    esucc: { l: "Succ%", src: "adv", w: 42, f: "pct100", t: "Successful plays %", g: function (r) { var x = epaRecM(r); return x && x.succ != null ? x.succ : null; } },
    evol:  { l: "Plays", src: "adv", w: 40, dim: true, t: "His pass plays: his box score's attempts (spikes included) plus sacks; no two-point tries", g: function (r) { var x = epaRawM(r); return x ? (x.plays != null ? x.plays : x.tgt) : null; } },
    evolc: { l: "Car",   src: "adv", w: 40, dim: true, t: "His carries (kneel-downs included, as in his box score; no two-point tries): the plays EPA and Success% are measured over", g: function (r) { var x = epaRawM(r); return x ? x.plays : null; } },
    evolt: { l: "Tgts",  src: "adv", w: 40, dim: true, t: "His targets (no two-point tries): the plays EPA and Success% are measured over", g: function (r) { var x = epaRawM(r); return x ? x.tgt : null; } },
    rtn:   { l: "Routes", src: "adv", w: 40, g: function (r) { var x = rtRec(r); return x && x.routes ? x.routes : null; } },
    rtpct: { l: "Route%", src: "adv", w: 46, f: "pct100", g: function (r) { var x = rtRec(r); return x && x.route_pct != null ? x.route_pct : null; } },
    tprr:  { l: "TPRR",  src: "adv", w: 40, f: "dec2", g: function (r) { var x = rtRec(r); return x && x.tprr != null ? x.tprr : null; } },
    yprr:  { l: "YPRR",  src: "adv", w: 40, f: "dec2", g: function (r) { var x = rtRec(r); return x && x.yprr != null ? x.yprr : null; } },
    nryoe: { l: "RYOE/A", src: "adv", w: 46, f: "delta", t: "Rush yards over expected per attempt (Next Gen Stats, 30+ attempts)", g: function (r) { var x = ngsRecMob(r); return x && x.rush ? x.rush.ryoe_pa : null; } },
    nbox8: { l: "8+Box", src: "adv", w: 44, f: "pct100", t: "Share of carries against 8+ defenders in the box (Next Gen Stats)", g: function (r) { var x = ngsRecMob(r); return x && x.rush ? x.rush.box8 : null; } },
    nsep:  { l: "Sep",   src: "adv", f: "dec1", t: "Average separation at the catch point, yards (Next Gen Stats, 20+ targets)", g: function (r) { var x = ngsRecMob(r); return x && x.rec ? x.rec.sep : null; } },
    ncush: { l: "Cush",  src: "adv", f: "dec1", t: "Average cushion at the snap, yards (Next Gen Stats)", g: function (r) { var x = ngsRecMob(r); return x && x.rec ? x.rec.cush : null; } },
    ntt:   { l: "TTT",   src: "adv", f: "dec2", t: "Time to throw, seconds (Next Gen Stats)", g: function (r) { var x = ngsRecMob(r); return x && x.pass ? x.pass.tt : null; } },
    nagg:  { l: "AGG%",  src: "adv", w: 40, f: "pct100", t: "Aggressiveness: throws into tight windows (Next Gen Stats)", g: function (r) { var x = ngsRecMob(r); return x && x.pass ? x.pass.agg : null; } }
  };
  // Removed from this view (Keith 2026-10-09/10): XpertRk (an expert ranking),
  // Schedule-adjusted (calculation under review) and All-MFL usage. Points per
  // game appears ONLY in Fantasy pts, never repeated beside box scores.

  // Each tab: alias (the leaderboard's pos param), group (its pos_group values
  // to keep — PN shares the punter alias's PK group) and named column SETS.
  // "Fantasy pts" is the default everywhere. No set has more than four
  // numbers, so the table fits a 320px phone with nothing off the right edge.
  var TABS = [
    { id: "QB", alias: "qb", group: ["QB"], sets: [
      { id: "passing", l: "Passing",   cols: ["payd", "patd", "pint", "ya"] },
      { id: "volume",  l: "Volume",    cols: ["patt", "cmppct", "qbsk"] },
      { id: "rushing", l: "Rushing",   cols: ["ruatt", "ruyd", "rutd", "ypc"] },
      { id: "redzone", l: "Red zone",  needs: "rz", cols: ["rzatt", "rzcmp", "rztd", "rztmp"] } ] },
    { id: "RB", alias: "skill", group: ["RB"], sets: [
      { id: "rushing", l: "Rushing",   cols: ["ruatt", "ruyd", "rutd", "ypc"] },
      { id: "receiving", l: "Receiving", cols: ["tgt", "rec", "recyd", "rectd"] },
      { id: "usage",   l: "Usage",     cols: ["osnap", "osnappct", "ruatt", "tgt"] },
      { id: "redzone", l: "Red zone",  needs: "rz", cols: ["rzcar", "rzcsh", "i5car", "i5sh"] } ] },
    { id: "WR", alias: "skill", group: ["WR"], sets: [
      { id: "receiving", l: "Receiving", cols: ["tgt", "rec", "recyd", "rectd"] },
      { id: "usage",   l: "Usage",     cols: ["osnap", "osnappct", "tgt", "tgtsh"] },
      { id: "efficiency", l: "Efficiency", cols: ["tgtsh", "catchpct", "ypr"] },
      { id: "redzone", l: "Red zone",  needs: "rz", cols: ["rztgt", "rztsh", "eztgt", "ezsh"] } ] },
    { id: "TE", alias: "skill", group: ["TE"], sets: [
      { id: "receiving", l: "Receiving", cols: ["tgt", "rec", "recyd", "rectd"] },
      { id: "usage",   l: "Usage",     cols: ["osnap", "osnappct", "tgt", "tgtsh"] },
      { id: "efficiency", l: "Efficiency", cols: ["tgtsh", "catchpct", "ypr"] },
      { id: "redzone", l: "Red zone",  needs: "rz", cols: ["rztgt", "rztsh", "eztgt", "ezsh"] } ] },
    { id: "DL", alias: "idp", group: ["DL"], sets: [
      { id: "tackles",  l: "Tackles",   cols: ["solo", "ast", "tfl", "snappct"] },
      { id: "passrush", l: "Pass rush", cols: ["sk", "press", "ff"] } ] },
    { id: "LB", alias: "idp", group: ["LB"], sets: [
      { id: "tackles",  l: "Tackles",   cols: ["solo", "ast", "tfl", "snappct"] },
      { id: "passrush", l: "Pass rush", cols: ["sk", "press", "ff"] },
      { id: "coverage", l: "Coverage",  cols: ["intd", "pd", "cmptgt", "ydsa"] } ] },
    { id: "DB", alias: "idp", group: ["DB"], sets: [
      { id: "tackles",  l: "Tackles",   cols: ["solo", "ast", "tfl", "snappct"] },
      { id: "coverage", l: "Coverage",  cols: ["intd", "pd", "cmptgt", "ydsa"] } ] },
    { id: "PK", alias: "kicker", group: ["PK"], sets: [
      { id: "kicking",  l: "Kicking",   cols: ["fgm", "fga", "fgpct", "xpm"] },
      { id: "distance", l: "FG by distance", cols: ["fg39", "fg49", "fg59", "fg60"] } ] },
    { id: "PN", alias: "punter", group: ["PK", "PN"], sets: [
      { id: "punting",  l: "Punting",   cols: ["punts", "i20p", "navg"] } ] }
  ];
  TABS.forEach(function (t) {
    t.sets.unshift({ id: "fantasy", l: "Fantasy pts", cols: ["pts", "ppg", "wks", "rcnt"] });
    t.sets.push({ id: "boom", l: "Boom/Bust", cols: (t.id === "PK" || t.id === "PN") ? ["sstartn", "sboomn", "sbustn", "sq"] : ["sstart", "sboom", "sbust", "sq"] });
    if (t.id === "QB") t.sets.push({ id: "epa", l: "EPA", cols: ["eepa", "ecpoe", "esucc", "evol"] });
    else if (t.id === "RB") t.sets.push({ id: "epa", l: "EPA", cols: ["eepa", "esucc", "evolc"] });
    else if (t.id === "WR" || t.id === "TE") t.sets.push({ id: "epa", l: "EPA", cols: ["eepa", "esucc", "evolt"] });
    // Next Gen Stats publishes passing, rushing and receiving only.
    if (t.id === "QB") t.sets.push({ id: "ngs", l: "Next Gen", cols: ["ntt", "nagg"] });
    else if (t.id === "RB") t.sets.push({ id: "ngs", l: "Next Gen", cols: ["nryoe", "nbox8"] });
    else if (t.id === "WR" || t.id === "TE") t.sets.push({ id: "ngs", l: "Next Gen", cols: ["nsep", "ncush"] });
    // Routes (YPRR, TPRR): HIDDEN while its source has no rows. nflverse marks
    // 2026 participation "not_published" (released after the season).
    if (t.id === "WR" || t.id === "TE") t.sets.push({ id: "routes", l: "Routes", needs: "routes", cols: ["rtn", "rtpct", "tprr", "yprr"] });
    else if (t.id === "RB") t.sets.push({ id: "routes", l: "Routes", needs: "routes", cols: ["rtn", "tprr", "yprr"] });
  });

  // scope: "all" | "ros" (rostered) | "fa" (free agents) — Keith 2026-06-20.
  // inner: "players" (the leaderboard) | "fpa" | "adp" | "vegas" | "pace" | "sched".
  // sort: { key: column key | "", dir: "desc" | "asc" } — "" = the default
  // order (PPG rank, then unranked by PPG).
  var view = { tab: "QB", q: "", scope: "all", set: "fantasy", inner: "players", sort: { key: "", dir: "desc" } };
  var cache = {};     // alias|season → leaderboard rows (box-score join / stored fallback)
  var metaCache = {}; // alias|season → { finalized, coverage, stale, count, limit, readAt }
  var season = 0;

  // Consistency / boom-bust by gsis_id — side-loaded per season, read by the "Boom/Bust" set.
  // Boom / Bust / Startable (/api/player-starter-rates): one request per
  // lineup group, joined by MFL id — so every listed player can have it, not
  // only those the box-score source happens to carry (2026-10-10).
  var srMap = {}, srSeason = 0;
  function leagueParam() {
    var c = window.UPS_MOBILE && window.UPS_MOBILE.state && window.UPS_MOBILE.state.ctx;
    return c && c.leagueId ? "&L=" + encodeURIComponent(c.leagueId) : "";
  }
  function srGroup(tab) { return tab.id === "PN" ? "PN" : tab.id; }
  function loadStarterRates(yr, tab) {
    var g = srGroup(tab), k = yr + "|" + g;
    srSeason = yr;
    if (srMap[k]) return Promise.resolve(srMap[k]);
    return fetch(API.workerUrl("/api/player-starter-rates?season=" + encodeURIComponent(yr) + "&group=" + g + leagueParam()), { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { srMap[k] = j && j.ok ? j : { players: {}, failed: true }; return srMap[k]; })
      .catch(function () { srMap[k] = { players: {}, failed: true }; return srMap[k]; });
  }
  function srFor(grp) { return srMap[srSeason + "|" + grp] || null; }
  function srRec(r) { var m = srFor(r.grp); return (m && m.players && m.players[pidKey(r.pid)]) || null; }
  // Red-zone columns only from a board rebuilt under migration 0168 (two-point
  // tries out, sacks apart from attempts): an older board reads "—".
  function rzV2(r) { return L(r).rz_v2 === 1; }

  // EPA / efficiency (nflfastR), single-season for mobile. Rate stats gated to a
  // qualified sample (the raw "Plays" stays visible) so scrubs don't top a sort.
  var epaMap = null, epaSeason = 0, epaThrough = null;
  function loadEpa(yr) {
    if (epaMap && epaSeason === yr) return Promise.resolve(epaMap);
    epaSeason = yr;
    return fetch(API.workerUrl("/api/player-epa?seasons=" + encodeURIComponent(yr)), { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { epaMap = (j && j.by_gsis) || {}; epaThrough = (j && j.through_week && j.through_week[yr]) || null; return epaMap; })
      .catch(function () { epaMap = {}; return epaMap; });
  }
  function epaRawM(r) { var e = epaMap && r.gsis && epaMap[String(r.gsis)]; if (!e) return null; if (r.grp === "QB") return e.pass; if (r.grp === "RB") return e.rush; return e.rec; }
  function epaRecM(r) { var x = epaRawM(r); if (!x) return null; var n = (x.plays != null ? x.plays : x.tgt) || 0; var min = r.grp === "QB" ? 50 : (r.grp === "RB" ? 25 : 20); return n >= min ? x : null; }
  function epaCpoe(r) { var e = epaMap && r.gsis && epaMap[String(r.gsis)]; return (e && e.pass && e.pass.plays >= 50 && e.pass.cpoe != null) ? e.pass.cpoe : null; }

  // Routes + NGS by gsis_id — per season (2016+), read by the "Routes"/"Next Gen" sets.
  var rtMap = null, rtSeason = 0, ngsMap = null, ngsSeason = 0;
  function loadRoutes(yr) {
    if (rtMap && rtSeason === yr) return Promise.resolve(rtMap);
    rtSeason = yr;
    return fetch(API.workerUrl("/api/player-routes?seasons=" + encodeURIComponent(yr)), { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { rtMap = (j && j.by_gsis) || {}; return rtMap; })
      .catch(function () { rtMap = {}; return rtMap; });
  }
  function loadNgs(yr) {
    if (ngsMap && ngsSeason === yr) return Promise.resolve(ngsMap);
    ngsSeason = yr;
    return fetch(API.workerUrl("/api/player-ngs?seasons=" + encodeURIComponent(yr)), { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { ngsMap = (j && j.by_gsis) || {}; return ngsMap; })
      .catch(function () { ngsMap = {}; return ngsMap; });
  }
  function rtRec(r) { return (rtMap && r.gsis && rtMap[String(r.gsis)]) || null; }
  function ngsRecMob(r) { return (ngsMap && r.gsis && ngsMap[String(r.gsis)]) || null; }

  // The latest season with leaderboard rows — the season the OTHER Stats tabs
  // (Pts Agst, Sched) default to. The Players list's own season is basis().season.
  function curSeason() {
    if (season) return season;
    var ly = (D().getAdvancedStatsLatestYear && D().getAdvancedStatsLatestYear()) || 0;
    season = ly || (new Date().getUTCFullYear() - 1);
    return season;
  }
  function curTab() {
    for (var i = 0; i < TABS.length; i++) if (TABS[i].id === view.tab) return TABS[i];
    return TABS[0];
  }
  // The sets this tab can show right now: a set whose source is loaded and
  // EMPTY is hidden (Routes for 2026), so the dropdown never offers a column
  // set that can only read "—".
  function availSets(tab) {
    return tab.sets.filter(function (s) {
      if (s.needs === "routes") return !!(rtMap && Object.keys(rtMap).length);
      if (s.needs === "rz") { var rows = cache[tab.alias + "|" + basis().season] || []; return rows.some(function (x) { return x.rz_v2 === 1; }); }
      return true;
    });
  }
  function curSet() {
    var sets = availSets(curTab());
    for (var i = 0; i < sets.length; i++) if (sets[i].id === view.set) return sets[i];
    return sets[0];
  }

  // ── Points basis: WHICH numbers this screen shows, and for which weeks ──
  //   live    MFL has posted a current-season score → season scoring (W=ALL).
  //   stored  MFL's scoring couldn't be read, or nothing is posted yet → the
  //           leaderboard's stored totals, ONLY for the weeks it says are final.
  function basis() {
    var SS = SSMOD();
    var ss = D().getSeasonScoring ? D().getSeasonScoring() : null;
    if (SS && ss && ss.known && ss.seasonWeeks && ss.seasonWeeks.length) {
      return { kind: "live", ss: ss, season: Number(ss.season) || curSeason() };
    }
    var reason = !ss || !ss.known ? ((ss && ss.reason) || "unavailable") : "no_scores_posted";
    return { kind: "stored", reason: reason, season: curSeason() };
  }
  function ctxYear() { return U.safeInt ? U.safeInt(M.state.ctx && M.state.ctx.year, 0) : parseInt(M.state.ctx && M.state.ctx.year, 10) || 0; }
  // Recent-form window — the Players market's thresholds (views/players.js
  // availWindows): L2 once more than 2 weeks are FINAL, L4 once more than 4.
  // (At exactly 4 final weeks an L4 would just repeat season PPG.) 0 = none:
  // no week is confirmed final, so no window is shown on a guess.
  function recentWindow(ss) {
    var n = ss && ss.finalKnown ? ss.finalWeeks.length : 0;
    return n > 4 ? 4 : (n > 2 ? 2 : 0);
  }
  function recentWeeks(ss, k) {
    var lo = ss.finalThrough - k + 1;
    return ss.finalWeeks.filter(function (w) { return w >= lo; });
  }
  // "Wks 1–5" → "Wk 1–5" for a 40px heading.
  function wkShort(weeks) {
    var S = SSMOD();
    var s = S ? S.weeksLabel(weeks) : "";
    return s.replace(/^Wks /, "Wk ");
  }
  function clock(ms) {
    if (!ms) return "";
    var d = new Date(ms); if (isNaN(d.getTime())) return "";
    var h = d.getHours(), m = d.getMinutes();
    return ((h % 12) || 12) + ":" + (m < 10 ? "0" : "") + m + " " + (h < 12 ? "AM" : "PM");
  }
  // The stored copy's verified period: its season's final board, or this
  // season's finalized weeks. null = it doesn't say → no points shown.
  function storedPeriod(meta, yr) {
    if (!meta || meta.stale) return null;
    var cur = ctxYear();
    if (cur && yr < cur) return { label: String(yr), weeks: null, prior: true };
    var n = parseInt(meta.finalized, 10);
    if (!(n >= 1)) return null;
    var wk = []; for (var i = 1; i <= n; i++) wk.push(i);
    return { label: wkShort(wk), weeks: wk, prior: false };
  }

  // ── Ownership: the app's one rule (app.js rosterOwnership / ownerOfPid) ──
  // A player on a roster is that franchise's; on NO roster he is a free agent
  // ONLY when MFL's rosters are confirmed complete; otherwise "owner unknown",
  // and neither the Rostered nor the Free agents filter pretends to know.
  //   → { known: false } | { known: true, fid: null } (FA) | { known: true, fid, name }
  function ownerOf(pid) {
    var o = D().ownerOfPid ? D().ownerOfPid(pid) : null;   // helper missing → never guess FA
    if (!o || !o.known) return { known: false };
    return o.free ? { known: true, fid: null } : { known: true, fid: o.fid, name: o.name || "Rostered" };
  }
  function rostersComplete() {
    var own = D().rosterOwnership ? D().rosterOwnership() : null;
    return { readable: !!(own && own.readable), complete: !!(own && own.complete) };
  }
  // Player's CURRENT NFL team: the boot-loaded LIVE MFL players export first,
  // then the worker's current_team, then the season-stamped team.
  function liveTeam(pid, lb) {
    var p = D().playerById ? D().playerById(pid) : null;
    if (p && p.team) return U.safeStr(p.team);
    return lb ? U.safeStr(lb.current_team || lb.team || "") : "";
  }

  // ── Leaderboard (box-score join; stored fallback) ──
  /* Every alias is read WHOLE: 500 rows a page, following the worker's
   * next_offset until it is null (2026-10-10). One 500-row page cut the IDP
   * board at impact 7 inside a 36-way tie and left ~350 scoring IDPs with "—".
   * A worker without paging sends no next_offset: that is one page, and if it
   * came back full the list is marked capped (the notes say so). */
  var PAGE = 500, MAX_PAGES = 12;
  function load(alias, yr) {
    var key = alias + "|" + yr;
    if (cache[key]) return Promise.resolve(cache[key]);
    var base = "/api/advanced-stats-leaderboard?season=" + encodeURIComponent(yr) +
      "&pos=" + encodeURIComponent(alias) + "&min_games=1&limit=" + PAGE;
    var rows = [], first = null, capped = false;
    function page(offset, n) {
      return fetch(API.workerUrl(base + (offset ? "&offset=" + offset : "")), { mode: "cors", credentials: "omit" })
        .then(function (r) { return r.ok ? r.json() : { rows: [] }; })
        .then(function (j) {
          var got = (j && j.rows) || [];
          if (!first) first = j || {};
          rows = rows.concat(got);
          var paged = j && Object.prototype.hasOwnProperty.call(j, "next_offset");
          if (paged && j.next_offset != null && n + 1 < MAX_PAGES) return page(Number(j.next_offset), n + 1);
          capped = paged ? j.next_offset != null : got.length >= PAGE;
          return rows;
        });
    }
    return page(0, 0)
      .then(function () {
        cache[key] = rows;
        var cov = first && first.source_coverage;
        metaCache[key] = {
          finalized: first && first.finalized_through_week,
          coverage: (cov && cov.week) || (first && first.built_for_week) || null,
          stale: !!(first && first.stale),
          count: rows.length, limit: PAGE, capped: capped, readAt: Date.now()
        };
        return rows;
      })
      .catch(function () { cache[key] = []; metaCache[key] = { count: 0, limit: PAGE, capped: false, readAt: Date.now(), failed: true }; return []; });
  }

  // League sub-tab bar (same pattern as league.js/auction.js, with Stats).
  function subTabs(active) {
    function tab(href, label, key) {
      return '<a class="ups-m-subtab' + (key === active ? " active" : "") +
        '" href="#league/' + href + '">' + label + "</a>";
    }
    return '<div class="ups-m-subtabs">' +
      tab("standings", "Standings", "standings") +
      tab("rosters", "Rosters", "rosters") +
      tab("trade", "Trade", "trade") +
      tab("otb", "On the Block", "otb") +
      tab("draft", "Draft", "draft") +
      tab("auction", "Auction", "auction") +
      tab("stats", "Stats", "stats") +
      "</div>";
  }

  function fmt(v, c, r) {
    if (v == null) {
      var nd0 = c.f === "pctnd" && c.nd(r);
      return nd0 ? '<span class="nd"><b>—</b><small>' + nd0[0] + "/" + nd0[1] + "</small></span>" : "—";
    }
    if (c.f === "ma") return v.m + "/" + v.a;
    if (c.f === "pctnd") { var nd = c.nd(r); return '<span class="nd"><b>' + Math.round(v * 100) + "%</b><small>" + nd[0] + "/" + nd[1] + "</small></span>"; }
    if (c.f === "delta") { if (v === 0) return "0"; return '<span class="ups-m-tr ' + (v > 0 ? "up" : "dn") + '">' + (v > 0 ? "+" : "") + v.toFixed(1) + "</span>"; }
    if (c.f === "epa") { return '<span class="ups-m-tr ' + (v > 0 ? "up" : (v < 0 ? "dn" : "")) + '">' + (v > 0 ? "+" : "") + v.toFixed(2) + "</span>"; }
    if (c.f === "pct100") return Math.round(v) + "%";
    if (c.f === "pct") return Math.round(v * 100) + "%";
    // The player sheet's rounding (statRowHtml): round to tenths, then print —
    // so a worker sum like 59.400000000000006 can't read 14.9 here and 14.8 there.
    if (c.f === "dec1") return round1(v).toFixed(1);
    if (c.f === "dec2") return v.toFixed(2);
    return String(Math.round(v));
  }
  function flip(raw) {
    raw = U.safeStr(raw);
    if (raw.indexOf(",") >= 0) { var p = raw.split(","); return ((p[1] || "").trim() + " " + (p[0] || "").trim()).trim(); }
    return raw;
  }

  /* Punctuation-insensitive, order-insensitive matching, the same rule the
   * global search overlay uses (player_search.js). */
  function normTokens(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }
  function normTight(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9\s]+/g, "").replace(/\s+/g, " ").trim();
  }
  function matchesQuery(r, qTokens) {
    if (!qTokens.length) return true;
    var bag = normTokens(r.name) + " " + normTight(r.name) + " " +
              normTokens(r.team) + " " + normTokens(r.pos) + " " +
              normTokens(ownerOf(r.pid).name || "");
    var hay = bag.split(" ").filter(Boolean);
    for (var i = 0; i < qTokens.length; i++) {
      var hit = false;
      for (var j = 0; j < hay.length; j++) {
        if (hay[j].indexOf(qTokens[i]) === 0) { hit = true; break; }
      }
      if (!hit) return false;
    }
    return true;
  }
  function queryTokens() {
    return normTokens(view.q).split(" ").filter(Boolean);
  }

  // ── Rows ──
  // A normalized row: { pid, name, team, pos, grp, lb, gsis, pts, ppg, games,
  // rank (0 = unranked), live (his total includes a week still being played),
  // rec ({ ppg, games } over the recent window | null) }.
  // MFL's players export (boot-loaded), or null when it didn't load.
  function mflPlayers() {
    var pl = M.state && M.state.players && M.state.players.players;
    var list = pl ? U.asArray(pl.player) : [];
    return list.length ? list : null;
  }
  // The leaderboard's rows for a tab, by MFL position where the worker sent it.
  function lbRows(tab, yr) {
    return (cache[tab.alias + "|" + yr] || []).filter(function (r) { return lbGroup(r) === tab.id; });
  }
  var rankCache = { ss: null, map: null };
  // Season PPG ranks, grouped exactly like the player sheet's (liveSeasonRow):
  // MFL position of D.playerById → posGroup, with the same rank minimum.
  function liveRanks(ss) {
    if (rankCache.ss === ss && rankCache.map) return rankCache.map;
    var SS = SSMOD();
    var map = SS ? SS.rankMap(ss.byPid, function (id) {
      var pl = D().playerById ? D().playerById(id) : null;
      return groupOf(U.safeStr(pl && pl.position).toUpperCase());
    }, ss.rankMinimum ? ss.rankMinimum(0) : 1) : {};
    rankCache = { ss: ss, map: map };
    return map;
  }
  // Live: WHO is listed comes from MFL (see the header); points from season scoring.
  //   → rows, with rows.source = "mfl" | "leaderboard" (MFL's player list missing)
  function liveRows(tab, b) {
    var ss = b.ss, SS = SSMOD();
    var win = recentWindow(ss);
    var recMap = win ? ss.windowFor(win) : null;
    var players = mflPlayers();
    var lbBy = {};
    (cache[tab.alias + "|" + b.season] || []).forEach(function (r) { var k = pidKey(r.mfl_pid); if (k) lbBy[k] = r; });
    function row(id, name, team, pos, lb) {
      var st = id ? (ss.byPid[id] || null) : null;
      return {
        pid: id, name: name, team: team, pos: pos, grp: tab.id, lb: lb || null, gsis: lb ? lb.gsis_id : null,
        pts: !id ? null : (st ? st.pts : 0), ppg: st ? st.ppg : null, games: !id ? null : (st ? st.games : 0), rank: 0,
        live: !!st && ss.liveWeeks.some(function (w) { return st.weeks && st.weeks[w] != null; }),
        rec: recMap ? (id && recMap[id] ? { ppg: recMap[id].ppg, games: recMap[id].games } : { ppg: null, games: 0 }) : null
      };
    }
    var out = [], inExport = {};
    if (players) {
      var rk = liveRanks(ss);
      players.forEach(function (p) {
        if (!p || !p.id) return;
        inExport[pidKey(p.id)] = 1;
        var pos = U.safeStr(p.position).toUpperCase();
        if (groupOf(pos) !== tab.id) return;
        var id = pidKey(p.id), st = ss.byPid[String(p.id)] || ss.byPid[id];
        if (!st || !(st.games > 0)) return;   // no posted MFL score this season
        var r = row(String(p.id), flip(p.name), U.safeStr(p.team), pos, lbBy[id]);
        r.rank = rk[String(p.id)] ? rk[String(p.id)].rank : 0;
        out.push(r);
      });
      // Union: a scoring player on the leaderboard whom MFL's export LACKS
      // entirely (a partial export). One the export has at another position
      // stays on that position's tab — MFL's position wins. Unranked, like his
      // sheet: without an MFL position he can't be ranked against anyone.
      lbRows(tab, b.season).forEach(function (lb) {
        var id = pidKey(lb.mfl_pid);
        if (!id || inExport[id] || !(ss.byPid[id] && ss.byPid[id].games > 0)) return;
        var r = row(id, flip(lb.player_name), liveTeam(lb.mfl_pid, lb), U.safeStr(lb.mfl_position).toUpperCase() || mflPos(lb.position), lb);
        r.rank = rk[id] ? rk[id].rank : 0;
        out.push(r);
      });
      out.source = "mfl";
      return out;
    }
    // MFL's player list didn't load: the leaderboard's rows, ranked within them.
    out = lbRows(tab, b.season).map(function (lb) {
      return row(pidKey(lb.mfl_pid), flip(lb.player_name), liveTeam(lb.mfl_pid, lb), U.safeStr(lb.mfl_position).toUpperCase() || mflPos(lb.position), lb);
    });
    var subset = {};
    out.forEach(function (r) { if (r.pid && r.games > 0) subset[r.pid] = { pts: r.pts, ppg: r.ppg, games: r.games }; });
    var rk2 = SS ? SS.rankMap(subset, function () { return tab.id; }, ss.rankMinimum ? ss.rankMinimum(0) : 1) : {};
    out.forEach(function (r) { r.rank = (r.pid && rk2[r.pid]) ? rk2[r.pid].rank : 0; });
    out.source = "leaderboard";
    return out;
  }
  function storedRows(tab, b) {
    var key = tab.alias + "|" + b.season;
    var period = storedPeriod(metaCache[key], b.season);
    var out = lbRows(tab, b.season).map(function (lb) {
      var pts = period ? nn(lb.mfl_points) : null, ppg = period ? nn(lb.mfl_ppg) : null;
      return {
        pid: pidKey(lb.mfl_pid), name: flip(lb.player_name), team: liveTeam(lb.mfl_pid, lb),
        pos: U.safeStr(lb.mfl_position).toUpperCase() || mflPos(lb.position), grp: tab.id, lb: lb, gsis: lb.gsis_id,
        pts: pts, ppg: ppg,
        // MFL scored weeks, exactly as the sheet derives them from a stored row:
        // the leaderboard's `games` counts nflverse NFL games, a different number.
        games: (pts != null && ppg) ? Math.round(pts / ppg) : null,
        rank: 0, live: false, rec: null
      };
    });
    // Rank inside this list with the same minimum (half its final weeks); a
    // prior season's final board is ranked as served, like the market's.
    var min = period && !period.prior && period.weeks ? Math.max(1, Math.ceil(period.weeks.length / 2)) : 1;
    out.filter(function (r) { return r.ppg != null && r.games >= min; })
      .sort(function (a, b2) { return (b2.ppg - a.ppg) || (b2.pts - a.pts); })
      .forEach(function (r, i) { r.rank = i + 1; });
    return out;
  }
  function buildRows(tab, b) {
    var rows = b.kind === "live" ? liveRows(tab, b) : storedRows(tab, b);
    if (!rows.source) rows.source = "leaderboard";
    return rows;
  }
  // Ranked players first by rank; unranked (below the minimum, or no points)
  // after them by PPG — a one-week player never tops the list (Keith 2026-10-02).
  function sortRows(rows) {
    return rows.sort(function (a, b) {
      if (a.rank && b.rank) return a.rank - b.rank;
      if (a.rank !== b.rank) return a.rank ? -1 : 1;
      var pa = a.ppg == null ? -1e9 : a.ppg, pb = b.ppg == null ? -1e9 : b.ppg;
      return (pb - pa) || ((b.pts || 0) - (a.pts || 0)) || (a.name < b.name ? -1 : 1);
    });
  }

  // ── Sorting ──
  function keyOf(c) { for (var k in C) if (C[k] === c) return k; return ""; }
  // The sort key, if its column is on screen (switching to a set without it
  // falls back to the default order rather than sorting by a hidden column).
  function activeSortKey(cols) {
    var k = view.sort && view.sort.key;
    if (!k) return "";
    return cols.some(function (c) { return keyOf(c) === k; }) ? k : "";
  }
  // A number to sort by; null = unavailable. Made/attempts sorts by makes,
  // then by fewer attempts (the more accurate kicker first).
  function sortValue(c, r) {
    var v = c.g(r);
    if (v == null) return null;
    if (c.sv) return c.sv(v);
    if (c.f === "ma") return v.a * 10000 + v.m;   // by attempts (Keith 2026-10-10), then makes: 5/7 above 3/5
    return typeof v === "number" && isFinite(v) ? v : null;
  }
  // Sorts the WHOLE filtered list (the screen then shows its first 150).
  // Players without a value go LAST in both directions; ties keep the default
  // order, so equal values still read in PPG-rank order.
  function applySort(rows, cols) {
    var k = activeSortKey(cols);
    if (!k) return rows;
    var c = C[k], dir = view.sort.dir === "asc" ? 1 : -1;
    var keyed = rows.map(function (r, i) { return { r: r, i: i, v: sortValue(c, r) }; });
    keyed.sort(function (a, b2) {
      if (a.v == null || b2.v == null) return ((a.v == null) - (b2.v == null)) || (a.i - b2.i);
      return ((a.v - b2.v) * dir) || (a.i - b2.i);
    });
    return keyed.map(function (x) { return x.r; });
  }

  function rowsFor(tab, b) {
    var qTokens = queryTokens();
    var all = buildRows(tab, b);
    var out = sortRows(all.filter(function (r) {
      // FA vs rostered scope, by LIVE MFL rosters. Unknown ownership matches neither — renderList says why.
      if (view.scope !== "all") {
        var own = ownerOf(r.pid);
        if (!own.known) return false;
        if (view.scope === "ros" && !own.fid) return false;
        if (view.scope === "fa" && own.fid) return false;
      }
      return matchesQuery(r, qTokens);
    }));
    out = applySort(out, visibleCols(curSet(), b));
    out.source = all.source;
    return out;
  }

  // How many players the query would find on the OTHER position tabs. Live
  // rows need no fetch; a stored-copy tab that was never opened reports 0, so
  // the copy offers a league-wide search rather than claiming a total.
  function matchesElsewhere(tab, b) {
    var qTokens = queryTokens();
    if (!qTokens.length) return 0;
    var n = 0, seen = {};
    TABS.forEach(function (t) {
      if (t.id === tab.id) return;
      buildRows(t, b).forEach(function (r) {
        if (seen[r.pid]) return;
        if (matchesQuery(r, qTokens)) { seen[r.pid] = 1; n++; }
      });
    });
    return n;
  }

  // ── Headings: every column sits under a band naming its source + period ──
  // Two tiers: a band over each run of columns that share a period ("MFL Wks
  // 1–5 ●" over Pts · PPG · Wks; "Wk 3–4" over L2 PPG; "nflverse Wk 1–4" over
  // a box score), then the short labels. A per-column "Wk 1–5" line didn't fit
  // a 40px column. Live MFL totals never share a band with another source.
  function colLabel(c, b) {
    if (c === C.rcnt) { var k = b.kind === "live" ? recentWindow(b.ss) : 0; return "L" + k + " PPG"; }
    return c.l;
  }
  // → { key, text, dot }: columns with the same key share a band.
  function colBand(c, b, tab, set, wide) {
    if (c.src === "pts") {
      if (b.kind === "live") {
        var w = wkShort(b.ss.seasonWeeks);
        return { key: "pts", text: wide ? "MFL " + S_weeks(b.ss.seasonWeeks) : w, dot: b.ss.liveWeeks.length > 0 };
      }
      var p = storedPeriod(metaCache[tab.alias + "|" + b.season], b.season);
      return { key: "pts", text: p ? (p.prior ? p.label : (wide ? "Stored " : "") + p.label) : "no verified wks" };
    }
    if (c.src === "rec") return { key: "rec", text: wkShort(recentWeeks(b.ss, recentWindow(b.ss))) };
    if (c.src === "box") {
      var m = metaCache[tab.alias + "|" + b.season];
      return { key: "box", text: "nflverse" + (m && m.coverage ? " Wk 1–" + m.coverage : " " + b.season) };
    }
    // PFR charting rides the same nflverse weekly refresh and coverage week, so
    // it shares the box-score band (a separate band split narrow columns and
    // truncated both labels); the set note names PFR.
    if (c.src === "pfr") {
      var m2 = metaCache[tab.alias + "|" + b.season];
      return { key: "box", text: "nflverse" + (m2 && m2.coverage ? " Wk 1–" + m2.coverage : " " + b.season) };
    }
    if (c.src === "snap") {
      var m4 = metaCache[tab.alias + "|" + b.season];
      return { key: "box", text: "nflverse" + (m4 && m4.coverage ? " Wk 1–" + m4.coverage : " " + b.season) };
    }
    if (c.src === "srt") {
      var sm = srFor(srGroup(tab));
      return { key: "srt", text: (wide ? "vs UPS starters " : "Starters ") + ((sm && sm.weeks_label) || b.season) };
    }
    if (c.src === "rz") {
      var m3 = metaCache[tab.alias + "|" + b.season];
      return { key: "rz", text: "Red zone" + (m3 && m3.coverage ? " Wk 1–" + m3.coverage : " " + b.season) };
    }
    if (set.id === "epa") return { key: "adv", text: "nflfastR " + (epaThrough ? "Wk 1–" + epaThrough : b.season) };
    return { key: "adv", text: (set.id === "routes" ? "Routes" : "Next Gen") + " " + b.season };
  }
  function S_weeks(weeks) { var S = SSMOD(); return S ? S.weeksLabel(weeks) : ""; }
  function visibleCols(set, b) {
    return set.cols.filter(function (k) {
      if (k === "rcnt") return b.kind === "live" && recentWindow(b.ss) > 0;
      return true;
    }).map(function (k) { return C[k]; });
  }
  function gridCols(cols) {
    return "26px minmax(0,1fr) " + cols.map(function (c) { return (c.w || 40) + "px"; }).join(" ");
  }
  function headHtml(tab, b, cols) {
    var set = curSet(), bands = [];
    cols.forEach(function (c) {
      var k = colBand(c, b, tab, set, false).key, last = bands[bands.length - 1];
      if (last && last.key === k) last.cols.push(c); else bands.push({ key: k, cols: [c] });
    });
    var bandHtml = bands.map(function (bd) {
      var width = bd.cols.reduce(function (n, c) { return n + (c.w || 40); }, 0) + 4 * (bd.cols.length - 1);
      var info = colBand(bd.cols[0], b, tab, set, width >= 90);
      // The in-progress dot rides on the band when there's room for it.
      var dot = info.dot && width >= 60 ? '<span class="ups-m-st-live" aria-hidden="true"></span>' : "";
      return '<span class="band" style="grid-column: span ' + bd.cols.length + '"' +
        (info.dot ? ' title="Includes a week still being played"' : "") + ">" + U.escapeHtml(info.text) + dot + "</span>";
    }).join("");
    // Every data heading is a sort button (Keith 2026-10-10). The second line
    // shows the direction on the sorted column (▼ high→low, ▲ low→high) and a
    // faint ⇅ on the others, so it's visible that each one sorts. "#" puts the
    // default order back (PPG rank, then unranked by PPG).
    var sk = activeSortKey(cols);
    return '<div class="ups-m-st-row head" style="--cols:' + gridCols(cols) + '">' +
      '<span class="band-pad"></span>' + bandHtml +
      '<span class="rk" role="columnheader"' + (sk ? "" : ' aria-sort="ascending"') + '><button type="button" class="ups-m-st-sort' + (sk ? "" : " on") +
        '" data-sort="" aria-label="Default order: PPG rank" title="PPG rank. Tap to put the default order back.">#<i aria-hidden="true">' + (sk ? "" : "•") + "</i></button></span>" +
      '<span class="nm">Player</span>' +
      cols.map(function (c) {
        var on = sk === keyOf(c), dir = on ? view.sort.dir : "";
        var label = colLabel(c, b);
        return '<span class="v" role="columnheader" aria-sort="' + (on ? (dir === "asc" ? "ascending" : "descending") : "none") + '">' +
          '<button type="button" class="ups-m-st-sort' + (on ? " on" : "") + '" data-sort="' + keyOf(c) + '"' +
          ' aria-label="Sort by ' + U.escapeHtml(label) + (on ? (dir === "asc" ? ", lowest first" : ", highest first") : "") + '"' +
          (c.t ? ' title="' + U.escapeHtml(c.t) + '"' : "") + ">" + U.escapeHtml(label) +
          '<i aria-hidden="true">' + (on ? (dir === "asc" ? "▲" : "▼") : "⇅") + "</i></button></span>";
      }).join("") + "</div>";
  }

  // One line under the controls that says exactly what the points ARE, for
  // which weeks, and how fresh — then a second for the chosen set's source.
  function basisHtml(tab, b) {
    var txt, warn = false;
    // On a set with no points column the full basis would only explain "#",
    // and its 3–4 lines pushed the list off the first screen: one line there.
    // That one line now lives in the set note (setNoteHtml), behind
    // "About these numbers" when the set has one.
    if (b.kind === "live" && curSet().id !== "fantasy") return "";
    if (b.kind === "live") {
      var ss = b.ss, S = SSMOD();
      txt = "<b>Actual MFL points, UPS scoring.</b> " + U.escapeHtml(S.weeksLabel(ss.seasonWeeks));
      if (ss.liveWeeks.length) txt += ', <span class="ups-m-st-live"></span>Wk ' + ss.liveWeeks.join(", ") + " in progress (games played so far count)";
      else if (ss.finalKnown) txt += " (final)";
      txt += ".";
      var k = recentWindow(ss);
      if (k) txt += " L" + k + " PPG = " + U.escapeHtml(S.weeksLabel(recentWeeks(ss, k))) + ", final weeks only.";
      else if (!ss.finalKnown) txt += " Couldn’t confirm which weeks are final, so recent form is hidden.";
      var min = ss.rankMinimum ? ss.rankMinimum(0) : 1;
      txt += " Rank needs " + min + "+ MFL wk" + (min === 1 ? "" : "s") + ".";
      var at = clock(ss.fetchedAt);
      if (at) txt += " MFL read " + at + ".";
    } else {
      warn = true;
      var key = tab.alias + "|" + b.season, meta = metaCache[key];
      var per = storedPeriod(meta, b.season), readAt = meta ? clock(meta.readAt) : "";
      var why = b.reason === "no_scores_posted"
        ? "No " + ctxYear() + " MFL scores posted yet"
        : "MFL’s live scoring couldn’t be read";
      if (!meta) txt = U.escapeHtml(why) + ". Loading the stored totals…";
      else if (per && per.prior) txt = U.escapeHtml(why) + " — showing the " + per.label + " season’s final totals (stored copy read " + readAt + ").";
      else if (per) txt = U.escapeHtml(why) + ", so these are the last verified stored totals: " + U.escapeHtml(SSMOD() ? SSMOD().weeksLabel(per.weeks) : per.label) +
        ", final weeks only (stored copy read " + readAt + "). Recent form is hidden. Tap refresh to retry.";
      else txt = U.escapeHtml(why) + " and the stored copy doesn’t say which weeks it covers, so points are hidden rather than guessed. Tap refresh to retry.";
    }
    return '<div class="ups-m-st-basis' + (warn ? " warn" : "") + '" id="ups-m-st-basis">' + txt + "</div>";
  }
  // One short line under the controls (≤ ~2 lines at 375px, so the list stays
  // on the first screen), and the longer definitions behind "About these
  // numbers" (Keith 2026-10-10: explain Boom/Bust/Consistency on screen).
  function setNoteHtml(tab, b, set, rows) {
    var key = tab.alias + "|" + b.season, meta = metaCache[key];
    var cols = set.cols.map(function (k) { return C[k]; });
    var srcs = {}; cols.forEach(function (c) { srcs[c.src] = 1; });
    var line = [], more = [];
    if (srcs.box || srcs.pfr) line.push("Box score: nflverse" + (meta && meta.coverage ? ", Wks 1–" + meta.coverage : "") + ".");
    if (srcs.pfr) more.push("Cmp/Tgt, Yds and Press are PFR charting via nflverse; — means PFR has no record for him.");
    if (set.cols.indexOf("snappct") >= 0) more.push("Snap% = his defensive snaps ÷ his team’s, only in the games he played on defense. It isn’t box or slot alignment — no source has that.");
    if (srcs.snap) {
      line.push("Snap% = his offensive snaps ÷ his team’s, in the games he played on offense.");
      more.push("Snaps: nflverse snap counts. Both counts cover the same games; — when he had no offensive snaps, or his team’s total or his snap record is missing." +
        (set.cols.indexOf("tgtsh") >= 0 ? " Tgt% = his share of his team’s targets in the weeks he played." : ""));
    }
    if (set.id === "distance") line.push("Made/attempted by distance; sorted by attempts.");
    if (set.id === "punting") {
      line.push("I20% = inside-20 punts ÷ all punts.");
      more.push("Net = gross minus return yards; touchbacks aren’t charged 20 yards, so it runs above the NFL’s official net.");
    }
    if (srcs.srt) {
      var sm = srFor(srGroup(tab)), wl = (sm && sm.weeks_label) || "final weeks";
      var small = tab.id === "PK" || tab.id === "PN";
      if (small) {
        var pool = 0;
        if (sm && sm.thresholds) Object.keys(sm.thresholds).forEach(function (w) { var t = sm.thresholds[w] && sm.thresholds[w][srGroup(tab)]; if (t && t.n > pool) pool = t.n; });
        line.push("Counts of the weeks he played vs that week’s UPS starters: Start = their median or better, Boom = top quarter, Bust = bottom quarter.");
        more.push("Only " + (pool || "about 12") + " " + (tab.id === "PK" ? "kickers" : "punters") + " start each week, so a few weeks can’t rank them reliably — these are counts, not a ranking.");
      } else {
        line.push("Each week he played vs that week’s UPS starters at his position: Start% = at or above their median, Boom% = top quarter, Bust% = bottom quarter. A 0.0 in a game he played counts.");
        more.push("A % needs 3+ weeks; the count is under it.");
      }
      more.push("Final weeks only (" + wl + "). Played = games he played ÷ games his team played; games he didn’t play aren’t graded.");
      if (sm && sm.failed) line.push("Couldn’t load this source — the columns read —.");
    }
    if (srcs.rz) {
      var wks = meta && meta.coverage ? "Wks 1–" + meta.coverage : String(b.season);
      if (tab.id === "QB") {
        line.push("Inside the 20, " + wks + "; no two-point tries. Tm P% is his TEAM’s red-zone pass rate in the games he played, not his own split.");
        more.push("Att = pass attempts (a sack isn’t one). Tm P% = his team’s inside-20 dropbacks (passes, sacks, scrambles) ÷ all its inside-20 plays in his games, whoever was at QB: the play-by-play doesn’t say who was at QB on a handoff.");
      } else {
        line.push("Inside the 20, " + wks + "; no two-point tries. % = his share of his team’s, in the games he played.");
        if (tab.id === "RB") more.push("I5 = inside the 5. His team’s totals count every carry.");
        else more.push("EZ = passes to him that reached the end zone, from anywhere on the field.");
      }
      more.push("Source: nflverse play-by-play.");
    }
    if (srcs.adv && set.id === "epa") {
      var through = epaThrough ? "Wks 1–" + epaThrough : b.season + " to date";
      line.push("NFL play measures from nflfastR play-by-play, regular season " + through + " — not UPS fantasy points. Rates need " + (tab.id === "QB" ? "50+ pass plays" : tab.id === "RB" ? "25+ carries" : "20+ targets") + ".");
      var lead = "EPA (expected points added) is how much a play changed the offense’s expected points, from nflfastR’s model of down, distance, field position and clock. ";
      // One definition everywhere (settled 2026-10-10): his EPA plays are his
      // box-score plays, two-point tries out — checked player by player against
      // nflverse's published box score and EPA.
      if (tab.id === "QB") more.push(lead + "EPA/play = the total EPA of his pass plays ÷ his pass plays. Pass plays (Plays) = his box score’s pass attempts (spikes count as attempts) plus sacks. Two-point tries, scrambles (they’re runs) and plays wiped out by a penalty don’t count. A receiver’s fumble after the catch isn’t charged to him.",
        "Success% = the same pass plays with EPA above zero ÷ those pass plays.",
        "CPOE = his average, per throw, of 100 if completed or 0 if not, minus nflfastR’s completion probability for that throw. Sacks and throws with no intended receiver have no CPOE.");
      else if (tab.id === "RB") more.push(lead + "EPA/play = the total EPA of his carries ÷ his carries (Car), as his box score counts them (kneel-downs included). Two-point runs and plays wiped out by a penalty don’t count; passes thrown to him aren’t included.",
        "Success% = the same carries with EPA above zero ÷ his carries.");
      else more.push(lead + "Receiving EPA gives him the whole EPA of every pass thrown to him — complete, incomplete or intercepted — the same EPA the passer gets, so it also reflects the QB, the line and the play call. EPA/target = that total ÷ his targets (Tgts), as his box score counts them. Two-point tries and plays wiped out by a penalty (pass interference included) don’t count.",
        "Success% = the same targets with EPA above zero ÷ his targets.");
    } else if (srcs.adv) line.push((set.id === "routes" ? "nflverse route data" : "Next Gen Stats") + ", " + b.season + " to date.");
    // MFL decides who is listed. The box-score, red-zone and nflverse side-load
    // columns are joined through the stats source's row (and its NFL ID); a
    // listed player without one reads "—" there. Boom/Bust is joined by MFL id.
    if ((srcs.box || srcs.pfr || srcs.rz || srcs.adv) && rows.source === "mfl") {
      var missing = rows.filter(function (r) { return !r.lb; }).length;
      if (missing) {
        line.push(missing + " listed " + tab.id + (missing === 1 ? " has" : "s have") + " no row in the stats source (—).");
        more.push(meta && meta.capped
          ? "They aren’t in the box-score list, which returns at most " + meta.limit + " players here. Their player sheet can show the weekly box score; their MFL points are on Fantasy pts."
          : "Most played without recording an NFL stat; a few are filed by nflverse at another position, or have no verified NFL id yet. Their MFL points are on Fantasy pts.");
      }
    }
    if (b.kind === "live" && rows.source === "leaderboard") {
      // Its rows carry the worker's copy of MFL positions (mfl_position).
      line.push("MFL’s player list didn’t load, so this is the stats source’s list, with its copy of MFL positions" +
        (meta && meta.capped ? "." : "; ranks are within it."));
    }
    // When the LEADERBOARD decides who is listed and it hit its row cap, the
    // list is NOT every player at the position, and the ranks are within it.
    if (rows.source === "leaderboard" && meta && meta.capped) {
      line.push("List = the stats source’s top " + meta.limit + (tab.alias === "idp" ? " IDPs" : " players") + "; ranks are within it.");
      more.push("The stats source returns at most " + meta.limit + " players here, chosen by tackles, sacks and other impact stats, so this isn’t every " + tab.id + ".");
    }
    if (b.kind === "live" && set.id !== "fantasy") {
      var rankLine = "# = PPG rank on actual MFL points, " + SSMOD().weeksLabel(b.ss.seasonWeeks) + ".";
      if (more.length) more.unshift(rankLine); else line.unshift(rankLine);
    }
    var PS = window.UPS_MOBILE_PLAYER_STATUS, inj = PS ? PS.listLine() : "";
    var open = view.noteOpen ? " open" : "";
    return '<div class="ups-m-st-setnote" id="ups-m-st-setnote">' + U.escapeHtml(line.join(" ")) +
      (inj ? '<div class="ups-m-st-injline">' + U.escapeHtml(inj) + "</div>" : "") +
      (more.length ? '<details class="ups-m-st-more"' + open + '><summary>About these numbers</summary><div>' + U.escapeHtml(more.join(" ")) + "</div></details>" : "") +
      "</div>";
  }


  // The status chips lead the team line, so a long name never hides them and
  // they never push the numbers (readable at 320px).
  function injChips(r) {
    var PS = window.UPS_MOBILE_PLAYER_STATUS;
    return PS && r.pid ? PS.chipsHtml(r.pid, r.team, "sm") : "";
  }
  function rowHtml(r, cols, tab, viewerFid) {
    var own = ownerOf(r.pid);
    var ownTag = !own.known ? '<span class="own unk"> · owner unknown</span>'
      : own.fid ? (own.fid === viewerFid ? '<span class="own me"> · Your team</span>' : '<span class="own"> · ' + U.escapeHtml(own.name) + "</span>")
      : '<span class="own fa"> · FA</span>';
    // The position badge only where it says something: the mixed tabs (DE/DT,
    // CB/S). On QB it repeated "QB" on every row and cost the name 32px.
    // On DL/DB it leads the team line ("DE · HOU · Blake Bombers"): as a chip
    // left of the name it cut 146 of 150 names at 320px.
    var badge = (tab.id === "DL" || tab.id === "DB")
      ? '<span class="pos ' + tab.id.toLowerCase() + '">' + U.escapeHtml(r.pos) + "</span> · " : "";
    return '<div class="ups-m-st-row' + (own.known && own.fid && own.fid === viewerFid ? " mine" : "") + '" data-pid="' + U.escapeHtml(r.pid) + '">' +
      '<span class="rk">' + (r.rank || "–") + "</span>" +
      '<span class="nm">' +
        '<span class="t"><span class="pn">' + U.escapeHtml(r.name) + "</span>" +
        '<span class="tm">' + injChips(r) + badge + U.escapeHtml(r.team) + ownTag + "</span></span></span>" +
      cols.map(function (c) {
        var v = c.g(r);
        var dot = (c === C.pts && r.live && v != null) ? '<span class="ups-m-st-live" aria-label="includes the week in progress"></span>' : "";
        return '<span class="v' + (c.strong ? " ppg" : "") + (c.dim ? " dim" : "") + '">' + dot + fmt(v, c, r) + "</span>";
      }).join("") +
    "</div>";
  }

  function renderList(tab, b) {
    // MFL's rosters are unreadable or incomplete: free agents can't be told from rostered players, so neither scope
    // pretends to (a partial Rostered list would read as the whole league's).
    if (view.scope !== "all") {
      var rc = rostersComplete();
      if (!rc.complete) {
        return '<div class="ups-m-stub"><div>Couldn’t read ' + (rc.readable ? "all of " : "") + "MFL’s rosters, so " +
          (view.scope === "fa" ? "free agents" : "rostered players") + " can’t be told apart right now.</div>" +
          '<div class="ups-m-st-nosub">Choose All players, or reload.</div></div>';
      }
    }
    var rows = rowsFor(tab, b);
    if (!rows.length) {
      if (view.q.trim()) {
        var elsewhere = matchesElsewhere(tab, b);
        return '<div class="ups-m-stub"><div class="ups-m-st-noq">' +
          "No " + U.escapeHtml(tab.id) + ' matches “' + U.escapeHtml(view.q.trim()) + '”' +
          (view.scope === "fa" ? " among free agents" : view.scope === "ros" ? " among rostered players" : "") +
          ".</div>" +
          (elsewhere
            ? '<div class="ups-m-st-nosub">' + elsewhere + " match" + (elsewhere === 1 ? "" : "es") +
              " on another position tab.</div>"
            : "") +
          '<button type="button" class="ups-m-st-searchall" data-act="search-all">' +
            "Search all players ›</button></div>";
      }
      return '<div class="ups-m-stub"><div>No ' + U.escapeHtml(tab.id) + " " +
        (view.scope === "fa" ? "free agents" : view.scope === "ros" ? "rostered players" : "data") +
        " for " + b.season + ".</div></div>";
    }
    var cols = visibleCols(curSet(), b);
    var capped = rows.slice(0, 150);
    var viewerFid = M.state && M.state.viewerFranchiseId ? U.pad4(M.state.viewerFranchiseId) : "";
    var body = capped.map(function (r) { return rowHtml(r, cols, tab, viewerFid); }).join("");
    var ranked = rows.filter(function (r) { return r.rank; }).length;
    var sk = activeSortKey(cols);
    var foot = (rows.length > capped.length ? (sk ? "First " : "Top ") + capped.length + " of " + rows.length + " " : rows.length + " ") +
      U.escapeHtml(tab.id) + (rows.length === 1 ? "" : "s") +
      (view.q.trim() ? " matching" : (rows.source === "mfl" ? " with a " + b.season + " MFL score" : " in this list")) +
      " · " + ranked + " ranked" +
      (sk ? " · sorted by " + U.escapeHtml(colLabel(C[sk], b)) + (view.sort.dir === "asc" ? ", low to high" : ", high to low") +
        "; players without a value are listed last" : "") + ".";
    return '<div class="ups-m-st-table" style="--cols:' + gridCols(cols) + '">' + body + "</div>" +
      '<div class="ups-m-fa-more">' + foot + "</div>";
  }

  /* A stable wrapper so a keystroke repaints the ROWS (and the heading /
   * notes that depend on the set) without rebuilding the search box: on a
   * phone a rebuilt input closes the keyboard mid-word. */
  function listShell(tab, b) {
    return '<div class="ups-m-st-listwrap" id="ups-m-st-listwrap">' + renderList(tab, b) + "</div>";
  }
  function repaintList() {
    var tab = curTab(), b = basis();
    var wrap = document.getElementById("ups-m-st-listwrap");
    if (!wrap) return;
    wrap.innerHTML = renderList(tab, b);
    var head = document.getElementById("ups-m-st-head");
    if (head) head.innerHTML = headHtml(tab, b, visibleCols(curSet(), b));
    var note = document.getElementById("ups-m-st-notes");
    if (note) note.innerHTML = basisHtml(tab, b) + setNoteHtml(tab, b, curSet(), buildRows(tab, b));
    var setSel = document.getElementById("ups-m-st-set");
    if (setSel && setSel.options && setSel.options.length !== availSets(tab).length) setSel.outerHTML = setSelectHtml(tab);
  }

  function setSelectHtml(tab) {
    var sets = availSets(tab);
    return '<select class="ups-m-players-filter" id="ups-m-st-set" aria-label="Stat columns">' +
      sets.map(function (s) { return '<option value="' + s.id + '"' + (curSet().id === s.id ? " selected" : "") + ">" + U.escapeHtml(s.l) + "</option>"; }).join("") +
    "</select>";
  }

  // The controls scroll away with the page; the position chips and the column
  // headings are PINNED, directly under the League tabs — never over them.
  // (Both bars used to stick at the same 48px offset, z-index 10, so after a
  // short scroll the 148px toolbar covered the League tabs completely, and the
  // headings sat inside an overflow-x box, which can't stick, so past row four
  // every number was unlabelled.)
  function toolbar(tab, b) {
    var chips = TABS.map(function (t) {
      return '<button class="ups-m-pos-chip' + (view.tab === t.id ? " on" : "") + '" data-tab="' + t.id + '"' +
        (view.tab === t.id ? ' aria-pressed="true"' : ' aria-pressed="false"') + ">" + t.id + "</button>";
    }).join("");
    var scopeSel = '<label class="ups-m-st-sel"><span>Roster</span><select class="ups-m-players-filter" id="ups-m-st-scope" aria-label="Filter by roster status">' +
      '<option value="all"' + (view.scope === "all" ? " selected" : "") + ">All</option>" +
      '<option value="ros"' + (view.scope === "ros" ? " selected" : "") + ">Rostered</option>" +
      '<option value="fa"'  + (view.scope === "fa"  ? " selected" : "") + ">Free agents</option>" +
    "</select></label>";
    var setSel = '<label class="ups-m-st-sel"><span>Columns</span>' + setSelectHtml(tab) + "</label>";
    return '<div class="ups-m-st-tools">' +
      '<input type="search" class="ups-m-players-search" id="ups-m-st-search" placeholder="Search ' +
        U.escapeHtml(tab.id) + 's by name, team or owner" autocomplete="off" autocorrect="off" ' +
        'autocapitalize="off" spellcheck="false" value="' + U.escapeHtml(view.q) + '" />' +
      '<div class="ups-m-st-filters">' + scopeSel + setSel + "</div>" +
      '<div id="ups-m-st-notes">' + basisHtml(tab, b) + setNoteHtml(tab, b, curSet(), buildRows(tab, b)) + "</div>" +
    "</div>" +
    '<div class="ups-m-st-pin">' +
      '<div class="ups-m-pos-chips" role="group" aria-label="Position">' + chips + "</div>" +
      '<div id="ups-m-st-head">' + headHtml(tab, b, visibleCols(curSet(), b)) + "</div>" +
    "</div>";
  }

  function bindToolbar(mount) {
    var s = document.getElementById("ups-m-st-search");
    // Repaint only the rows, straight off the keystroke: the input is not in
    // the subtree being replaced, so it never loses focus.
    if (s) s.addEventListener("input", function (e) {
      view.q = e.target.value;
      repaintList();
    });
    var chips = mount.querySelectorAll(".ups-m-pos-chip");
    try {   // keep the active chip in view (PK/PN sit past the edge at 320px)
      var onChip = null;
      for (var j = 0; j < chips.length; j++) if (/(^|\s)on(\s|$)/.test(chips[j].className || "")) onChip = chips[j];
      var chipRow = onChip && onChip.parentNode;
      if (chipRow && chipRow.getBoundingClientRect && chipRow.scrollWidth > chipRow.clientWidth) {
        var dx = onChip.getBoundingClientRect().right - chipRow.getBoundingClientRect().right;
        if (dx > 0) chipRow.scrollLeft += dx + 16;
      }
    } catch (e) { /* cosmetic only */ }
    for (var i = 0; i < chips.length; i++) chips[i].addEventListener("click", function () {
      view.tab = this.getAttribute("data-tab");
      view.q = "";
      view.set = "fantasy";   // each position opens on Fantasy pts
      view.noteOpen = false;  // "About these numbers" closes: open, it pushed the next set's rows off a 568-px screen
      view.sort = { key: "", dir: "desc" };
      M.route.renderRoute();
    });
    var scope = document.getElementById("ups-m-st-scope");
    if (scope) scope.addEventListener("change", function () { view.scope = this.value; repaintList(); });
    // Delegated: repaintList() may replace the set <select> when a source
    // (Routes) turns out empty.
    var filters = mount.querySelector ? mount.querySelector(".ups-m-st-filters") : null;
    var setSel = document.getElementById("ups-m-st-set");
    var onSet = function (e) { var el = e && e.target && e.target.id === "ups-m-st-set" ? e.target : setSel; view.set = el.value || "fantasy"; view.noteOpen = false; repaintList(); };
    if (filters && filters.addEventListener) filters.addEventListener("change", function (e) { if (e.target && e.target.id === "ups-m-st-set") onSet(e); });
    else if (setSel) setSel.addEventListener("change", function () { view.set = this.value || "fantasy"; view.noteOpen = false; repaintList(); });
    // Heading taps sort: high→low, then low→high, then back to the default
    // order. "#" always goes back to the default. Delegated on the heading's
    // container, which repaintList() keeps (it only replaces what's inside).
    // "About these numbers" stays open across repaints (the note is rebuilt on
    // every keystroke).
    var notes = document.getElementById("ups-m-st-notes");
    if (notes && notes.addEventListener && !notes.__upsMoreBound) notes.__upsMoreBound = true, notes.addEventListener("click", function (e) {
      var t = e.target;
      if (t && t.closest && t.closest("summary")) view.noteOpen = !view.noteOpen;
    });
    var head = document.getElementById("ups-m-st-head");
    if (head && head.addEventListener && !head.__upsSortBound) head.__upsSortBound = true, head.addEventListener("click", function (e) {
      var t = e.target, btn = t && t.closest ? t.closest("[data-sort]") : null;
      if (!btn) return;
      var k = btn.getAttribute("data-sort") || "";
      var cur = view.sort || { key: "", dir: "desc" };
      if (!k) view.sort = { key: "", dir: "desc" };
      else if (cur.key !== k) view.sort = { key: k, dir: "desc" };
      else if (cur.dir === "desc") view.sort = { key: k, dir: "asc" };
      else view.sort = { key: "", dir: "desc" };
      repaintList();
      listToTop();
    });
  }
  // After a re-sort, bring the list's first rows up under the pinned headings
  // when the reader had scrolled past them.
  function listToTop() {
    var wrap = document.getElementById("ups-m-st-listwrap");
    var pin = document.querySelector && document.querySelector(".ups-m-st-pin");
    if (!wrap || !pin || !wrap.getBoundingClientRect || !window.scrollTo) return;
    var gap = wrap.getBoundingClientRect().top - pin.getBoundingClientRect().bottom;
    if (gap < 0) window.scrollTo(0, (window.scrollY || 0) + gap);
  }

  function bind(mount) {
    bindToolbar(mount);
    // Delegated on the stable wrapper, so repaintList() can swap the rows out
    // from under it without rebinding a listener per row on every keystroke.
    var wrap = document.getElementById("ups-m-st-listwrap");
    if (!wrap || wrap.__upsBound) return;
    wrap.__upsBound = true;
    wrap.addEventListener("click", function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('[data-act="search-all"]')) {
        if (M.playerSearch) M.playerSearch.openWith(view.q);
        return;
      }
      var row = t.closest(".ups-m-st-row[data-pid]");
      if (!row) return;
      var pid = row.getAttribute("data-pid");
      if (pid && M.sheet) M.sheet.open(pid);
    });
  }

  // Pin the chips + headings exactly under the League tabs, whatever height
  // those wrap to; and bring the active Stats tab into view in its scroller.
  function settleChrome(mount) {
    if (!mount || !mount.querySelector) return;
    var st = mount.querySelector(".ups-m-subtabs");
    if (st && st.offsetHeight && mount.style && mount.style.setProperty) mount.style.setProperty("--st-subtabs-h", st.offsetHeight + "px");
    var bar = mount.querySelector(".ups-m-stseg-bar");
    var on = bar && bar.querySelector(".ups-m-stseg.on");
    if (bar && on && bar.scrollWidth > bar.clientWidth) {
      var left = on.offsetLeft - bar.offsetLeft, right = left + on.offsetWidth;
      if (left < bar.scrollLeft || right > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = Math.max(0, left - 12);
    }
  }

  // ── Fantasy Points Against (inner view of the Stats sub-tab) ──
  // RAW points a defense allows to a position (per game) + opponent-ADJUSTED
  // rating, from /api/fantasy-points-against. One fetch per (year, week-range)
  // covers all 9 groups; position chips filter client-side.
  var POS_FPA = [["QB", "QB"], ["RB", "RB"], ["WR", "WR"], ["TE", "TE"], ["DL", "DL"], ["LB", "LB"], ["DB", "DB"], ["PK", "K"], ["PN", "P"]];
  var fpa = { year: 0, pos: "RB", wkMin: 1, wkMax: 18, sort: "rank", dir: 1, cache: {}, years: null, _fb: false, detailTeam: null, detailWeek: null, detailCache: {} };
  function fpaYear() { return String(fpa.year || curSeason()); }
  function fpaKey() { return fpaYear() + ":" + fpa.wkMin + "-" + fpa.wkMax; }
  function fpaPosLbl() { return (POS_FPA.filter(function (p) { return p[0] === fpa.pos; })[0] || ["", ""])[1] || fpa.pos; }
  function fpaDetailKey() { return fpaKey() + "|" + fpa.pos + "|" + fpa.detailTeam; }
  function loadFpaDetail() {
    var dk = fpaDetailKey();
    if (fpa.detailCache[dk]) return Promise.resolve(fpa.detailCache[dk]);
    return fetch(API.workerUrl("/api/fpa-detail?YEAR=" + encodeURIComponent(fpaYear()) + "&team=" + encodeURIComponent(fpa.detailTeam) + "&pos=" + encodeURIComponent(fpa.pos) + "&week_min=" + fpa.wkMin + "&week_max=" + fpa.wkMax), { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.json(); })
      .then(function (d) { fpa.detailCache[dk] = (d && d.ok) ? d : { weeks: [] }; return fpa.detailCache[dk]; })
      .catch(function () { fpa.detailCache[dk] = { weeks: [], err: 1 }; return fpa.detailCache[dk]; });
  }

  function loadFpaYears() {
    if (fpa.years) return Promise.resolve(fpa.years);
    return fetch(API.workerUrl("/api/league-years"), { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var ys = [];
        ((d && d.years) || []).forEach(function (y) { if (y && y.season && parseInt(y.season, 10) >= 2017) ys.push(String(y.season)); });
        ys.sort().reverse();
        if (!ys.length) { for (var y = new Date().getUTCFullYear(); y >= 2017; y--) ys.push(String(y)); }
        fpa.years = ys; return ys;
      })
      .catch(function () { var z = []; for (var y = new Date().getUTCFullYear(); y >= 2017; y--) z.push(String(y)); fpa.years = z; return z; });
  }
  function loadFpa() {
    var k = fpaKey();
    if (fpa.cache[k]) return Promise.resolve(fpa.cache[k]);
    return fetch(API.workerUrl("/api/fantasy-points-against?YEAR=" + encodeURIComponent(fpaYear()) + "&week_min=" + fpa.wkMin + "&week_max=" + fpa.wkMax), { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.json(); })
      .then(function (d) { fpa.cache[k] = (d && d.ok) ? d : { teams: {}, weeksUsed: [] }; return fpa.cache[k]; })
      .catch(function () { fpa.cache[k] = { teams: {}, weeksUsed: [], err: 1 }; return fpa.cache[k]; });
  }
  function fpaRkCls(rank, of) { if (rank == null) return "mid"; if (rank <= 10) return "easy"; if (rank > of - 10) return "tough"; return "mid"; }

  // The six Stats boards. Shared navigation: 13px labels in a row that
  // scrolls sideways when it doesn't fit (they were squeezed to 9px with
  // negative tracking to fit 375px), the active one scrolled into view.
  function innerSwitch() {
    function b(key, label) { return '<button class="ups-m-stseg' + (view.inner === key ? " on" : "") + '" data-inner="' + key + '" role="tab" aria-selected="' + (view.inner === key ? "true" : "false") + '">' + label + "</button>"; }
    return '<div class="ups-m-stseg-bar six" role="tablist" aria-label="Stats boards">' + b("players", "Players") + b("fpa", "Pts Agst") + b("adp", "ADP") + b("vegas", "Vegas") + b("pace", "Pace") + b("sched", "Sched") + "</div>";
  }
  // ── Vegas board (Stats → Vegas inner tab) — implied team points + O/U ──
  var vg = { year: 0, week: 0, data: null, weeks: [], _fb: false };
  function vgYear() { return String(vg.year || new Date().getUTCFullYear()); }   // upcoming season's lines (matches desktop)
  function loadVegas() {
    return fetch(API.workerUrl("/api/vegas?YEAR=" + encodeURIComponent(vgYear()) + (vg.week ? "&W=" + vg.week : "")), { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if ((!d || !(d.teams || []).length) && !vg._fb) {   // no lines yet → prior season once
          vg._fb = true; vg.year = String((parseInt(vgYear(), 10) || 0) - 1); vg.week = 0; return loadVegas();
        }
        vg.data = d || {}; vg.weeks = (d && d.weeksWithLines) || []; vg.week = (d && d.week) || vg.week; return vg.data;
      })
      .catch(function () { vg.data = { teams: [], games: [] }; return vg.data; });
  }
  function vegasToolbar() {
    var wkOpts = (vg.weeks || []).map(function (w) { return '<option value="' + w + '"' + (w === vg.week ? " selected" : "") + ">Week " + w + "</option>"; }).join("") || '<option value="0">—</option>';
    return '<div class="ups-m-players-toolbar">' +
      '<div class="ups-m-auc-sec-head">Vegas <span class="ct">implied team points · O/U · ' + vgYear() + "</span></div>" +
      '<div class="ups-m-st-filters"><select class="ups-m-players-filter" id="ups-m-vg-week">' + wkOpts + "</select></div></div>";
  }
  function vegasHtml() {
    if (!vg.data) return '<div class="ups-m-loading">Loading…</div>';
    var teams = vg.data.teams || [];
    if (!teams.length) return '<div class="ups-m-stub"><div>No lines posted for this week yet.</div></div>';
    var head = '<div class="ups-m-adp-row head"><span class="rk">#</span><span class="pl">Team</span><span class="v">Impl</span><span class="v">O/U</span></div>';
    var body = teams.map(function (t, i) {
      var sub = (t.home ? "vs " : "@ ") + (t.opp || "—") + (t.spread != null ? " · " + (t.spread > 0 ? "+" : "") + t.spread : "");
      var icls = t.implied == null ? "" : (t.implied >= 26 ? "up" : (t.implied <= 18 ? "dn" : ""));
      return '<div class="ups-m-adp-row">' +
        '<span class="rk">' + (i + 1) + "</span>" +
        '<span class="pl"><span class="nm">' + U.escapeHtml(t.team) + '</span><span class="sub">' + U.escapeHtml(sub) + "</span></span>" +
        '<span class="v"><span class="ups-m-tr ' + icls + '">' + (t.implied != null ? t.implied : "—") + "</span></span>" +
        '<span class="v">' + (t.total != null ? t.total : "—") + "</span>" +
      "</div>";
    }).join("");
    return '<div class="ups-m-fpa-table">' + head + body + "</div>";
  }
  function bindVegas(mount) {
    var w = document.getElementById("ups-m-vg-week");
    if (w) { w.value = String(vg.week); w.addEventListener("change", function () { vg.week = parseInt(this.value, 10) || 0; loadVegas().then(function () { if (view.inner === "vegas") paint(mount); }); }); }
  }
  // ── ADP board (Stats → ADP inner tab) — multi-source ranks + tiers, Superflex ──
  var adpb = { pos: "ALL", data: null, srcSel: { fc: true, ktc: true, dp: true }, roster: "sf", rdPct: 0.35, generatedAt: null, team: "__ALL__", sort: "ovr" };
  function adpRelTime(iso) { if (!iso) return ""; var t = Date.parse(iso); if (isNaN(t)) return ""; var s = Math.max(0, (Date.now() - t) / 1000); if (s < 90) return "just now"; if (s < 5400) return Math.round(s / 60) + "m ago"; if (s < 172800) return Math.round(s / 3600) + "h ago"; return Math.round(s / 86400) + "d ago"; }
  var ADPB_SRC = [["fc", "FC"], ["ktc", "KTC"], ["dp", "DP"]];
  function adpbKeys() { return { d: "dsf", r: "rsf" }; }   // baked Superflex (UPS league)
  // RANK-CONSENSUS redraft axis (Keith 2026-07-13, mirrors trade_grader.
  // fetch_adp_board() / adpBuildRankConsensus() in stats_workbench.html — keep
  // in sync). KTC/DynastyProcess rarely publish rsf at all, AND where KTC
  // DOES publish it, its redraft $-scale isn't comparable to FC's (a KTC rsf
  // ~4700-4800 can be only KTC's own ~104th-110th-best redraft player).
  // Fix: rank each source against only its own reporting population, average
  // available ranks across {fc.rsf desc, ktc.rsf desc, ffcAdp asc (real
  // live-draft ADP)}, map the consensus rank back onto FC's rsf $-scale.
  function adpbRankMap(board, keyFn, ascending) {
    var scored = [];
    board.forEach(function (p) { var v = keyFn(p); if (v != null) scored.push([v, p]); });
    scored.sort(function (a, b) { return ascending ? a[0] - b[0] : b[0] - a[0]; });
    var m = new Map();
    scored.forEach(function (x, i) { m.set(x[1], i + 1); });
    return m;
  }
  function adpbRankToFcValueCurve(board, fcRank) {
    var pairs = [];
    board.forEach(function (p) { var r = fcRank.get(p), v = p.fc && p.fc.rsf; if (r && v) pairs.push([r, Number(v)]); });
    pairs.sort(function (a, b) { return a[0] - b[0]; });
    return pairs;
  }
  function adpbValueAtRank(r, curve) {
    if (!curve || !curve.length) return null;
    if (r <= curve[0][0]) return curve[0][1];
    if (r >= curve[curve.length - 1][0]) return curve[curve.length - 1][1];
    for (var i = 1; i < curve.length; i++) {
      if (curve[i][0] >= r) {
        var r0 = curve[i - 1][0], v0 = curve[i - 1][1], r1 = curve[i][0], v1 = curve[i][1];
        var f = r1 !== r0 ? (r - r0) / (r1 - r0) : 0;
        return v0 + (v1 - v0) * f;
      }
    }
    return curve[curve.length - 1][1];
  }
  function adpbBuildRankConsensus(board) {
    var fcRank = adpbRankMap(board, function (p) { return p.fc && p.fc.rsf > 0 ? p.fc.rsf : null; }, false);
    var ktcRank = adpbRankMap(board, function (p) { return p.ktc && p.ktc.rsf > 0 ? p.ktc.rsf : null; }, false);
    var ffcRank = adpbRankMap(board, function (p) { return p.ffcAdp; }, true);
    // MFL native AAV — the ONLY source quoting real auction dollars, and it IS
    // live again for 2026 (800 tracked auctions). REFERENCE ONLY, deliberately NOT
    // in the consensus: inspected 2026-07-21, the top six players by average value
    // are all 2026 rookies (Jeremiyah Love $57.39 ... Ja'Marr Chase only 7th,
    // Josh Allen 10th) because the auctions MFL tracks in July are dynasty ROOKIE
    // auctions. That is a rookie-draft ordering, not a redraft one, and ranking it
    // rather than averaging it does not help — the contamination is in the order
    // itself. The rank map is built so the column can be displayed and so this is
    // one uncomment away if the pool shifts once redraft auctions ramp up.
    var mflRank = adpbRankMap(board, function (p) { return p.mflAav > 0 ? p.mflAav : null; }, false);
    return { fcRank: fcRank, ktcRank: ktcRank, ffcRank: ffcRank, mflRank: mflRank, curve: adpbRankToFcValueCurve(board, fcRank) };
  }
  function adpbRedraftConsensus(row, rc) {
    if (!rc) return null;
    var ranks = [];
    if (adpb.srcSel.fc && rc.fcRank.has(row)) ranks.push(rc.fcRank.get(row));
    if (adpb.srcSel.ktc && rc.ktcRank.has(row)) ranks.push(rc.ktcRank.get(row));
    if (rc.ffcRank.has(row)) ranks.push(rc.ffcRank.get(row));   // ffcAdp has no UI toggle — always on
    if (!ranks.length) return null;
    var avg = ranks.reduce(function (a, b) { return a + b; }, 0) / ranks.length;
    return adpbValueAtRank(avg, rc.curve);
  }
  // Per-position tiers via local-cliff detection (matches desktop adpAssignTiers).
  function adpbTiers(arr) {
    var n = arr.length; if (!n) return;
    var vals = arr.map(function (r) { return r._bv != null ? r._bv : (r.idpVal || 0); });
    arr[0]._tier = 1; if (n < 2) return;
    var gaps = []; for (var i = 1; i < n; i++) gaps.push(vals[i - 1] - vals[i]);
    var W = 4, K = 2.5, MINREL = 0.04;
    function med(a) { if (!a.length) return 0; var s = a.slice().sort(function (x, y) { return x - y; }); var m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
    var tier = 1;
    for (var j = 1; j < n; j++) {
      var g = vals[j - 1] - vals[j];
      var lo = Math.max(0, (j - 1) - W), hi = Math.min(gaps.length, (j - 1) + W + 1);
      var local = []; for (var t = lo; t < hi; t++) if (gaps[t] > 0) local.push(gaps[t]);
      var m2 = med(local), rel = vals[j - 1] > 0 ? g / vals[j - 1] : 0;
      if (m2 > 0 && g > m2 * K && rel > MINREL) tier++;
      arr[j]._tier = tier;
    }
  }
  // Dynasty-only sources (DP) drop to null at the redraft extreme (show "—").
  // DYNASTY value of one source's block. Prefer the worker's SCALE-NORMALISED
  // `ndsf` (each source ranked inside its own reporting population, TE-premium-
  // bridged for the non-TEP sources, mapped onto one common cardinal curve).
  // Averaging raw `dsf` across sources is the 2026-07-13 bug in its dynasty-axis
  // form — KTC's curve is ~4.6x flatter than DynastyProcess's past rank 100, so a
  // raw mean silently becomes KTC's board. `dsf` fallback = split-deploy safety.
  function adpbDynVal(blk, k) {
    if (!blk) return null;
    if (blk.ndsf != null && blk.ndsf > 0) return blk.ndsf;
    return blk[(k || adpbKeys()).d];
  }
  function adpbSrcBlend(row, src) {
    var blk = row[src]; if (!blk) return null;
    var k = adpbKeys(), dyn = adpbDynVal(blk, k), rd = blk[k.r];
    if (dyn == null && rd == null) return null;
    if (adpb.rdPct >= 0.999) return (rd != null && rd > 0) ? rd : null;
    if (adpb.rdPct <= 0.001) return (dyn != null && dyn > 0) ? dyn : null;
    if (rd == null) return dyn; if (dyn == null) return rd;
    return Math.round((1 - adpb.rdPct) * dyn + adpb.rdPct * rd);
  }
  // Per-dimension consensus: mean dynasty + mean redraft separately, then blend.
  function adpbBlend(row) {
    if (row.isIdp) return row.idpVal != null ? row.idpVal : null;
    var k = adpbKeys(), dynVals = [];
    ADPB_SRC.forEach(function (p) {
      if (!adpb.srcSel[p[0]]) return;
      var blk = row[p[0]]; if (!blk) return;
      var v = adpbDynVal(blk, k);
      if (v != null && v > 0) dynVals.push(v);
    });
    var dynC = dynVals.length ? dynVals.reduce(function (a, b) { return a + b; }, 0) / dynVals.length : null;
    var rdC = adpbRedraftConsensus(row, adpb._rankConsensus);
    if (dynC == null && rdC == null) return null;
    if (rdC == null) return Math.round(dynC);
    if (dynC == null) return Math.round(rdC);
    return Math.round((1 - adpb.rdPct) * dynC + adpb.rdPct * rdC);
  }
  function loadAdpBoard() {
    if (adpb.data) return Promise.resolve(adpb.data);
    return fetch(API.workerUrl("/api/adp-board"), { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.json(); })
      .then(function (d) { adpb.data = (d && d.board) || []; adpb.generatedAt = (d && d.generated_at) || null; adpb._rankConsensus = adpbBuildRankConsensus(adpb.data); return adpb.data; })
      .catch(function () { adpb.data = []; return adpb.data; });
  }
  // UPS ownership (for the ADP Team/FA filter): mfl_id → franchise + franchise list.
  var adpbOwn = null;
  function loadAdpbOwn() {
    if (adpbOwn) return Promise.resolve(adpbOwn);
    return fetch(API.workerUrl("/api/mfl-league-state"), { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var p2f = {}, f2n = {};
        Object.keys((j && j.pid_to_fid) || {}).forEach(function (pid) { p2f[pid] = String(j.pid_to_fid[pid]); });
        ((j && j.franchises) || []).forEach(function (f) { f2n[String(f.id)] = f.name; });
        adpbOwn = { p2f: p2f, f2n: f2n };
        return adpbOwn;
      })
      .catch(function () { adpbOwn = { p2f: {}, f2n: {} }; return adpbOwn; });
  }
  function adpBoardToolbar() {
    var poss = [["ALL", "All"], ["QB", "QB"], ["RB", "RB"], ["WR", "WR"], ["TE", "TE"], ["DL", "DL"], ["LB", "LB"], ["DB", "DB"]];
    var chips = poss.map(function (p) { return '<button class="ups-m-pos-chip' + (adpb.pos === p[0] ? " on" : "") + '" data-adppos="' + p[0] + '">' + p[1] + "</button>"; }).join("");
    var srcTogs = ADPB_SRC.map(function (p) { return '<label class="ups-m-adp-srctog"><input type="checkbox" data-adpsrc="' + p[0] + '"' + (adpb.srcSel[p[0]] ? " checked" : "") + '/>' + p[1] + "</label>"; }).join("");
    var rdP = Math.round(adpb.rdPct * 100);
    var skew = rdP === 0 ? "all Dynasty" : rdP === 100 ? "all Redraft" : (rdP + "% redraft");
    var teamOpts = '<option value="__ALL__">All teams</option><option value="__ROSTERED__">All Rostered</option><option value="FA">Free Agents</option>';
    if (adpbOwn && adpbOwn.f2n) {
      Object.keys(adpbOwn.f2n).sort(function (a, b) { return (adpbOwn.f2n[a] || "").localeCompare(adpbOwn.f2n[b] || ""); })
        .forEach(function (fid) { teamOpts += '<option value="' + fid + '"' + (adpb.team === fid ? " selected" : "") + ">" + U.escapeHtml(adpbOwn.f2n[fid]) + "</option>"; });
    }
    return '<div class="ups-m-players-toolbar">' +
      '<div class="ups-m-auc-sec-head">ADP <span class="ct">Superflex · ' + skew + ' · ranks + tiers' + (adpb.generatedAt ? ' · fetched ' + adpRelTime(adpb.generatedAt) : '') + '</span></div>' +
      '<div class="ups-m-pos-chips">' + chips + "</div>" +
      '<div class="ups-m-pos-chips" style="margin-top:6px">' +
        '<button class="ups-m-pos-chip' + (adpb.sort === "ovr" ? " on" : "") + '" data-adpsort="ovr">Overall</button>' +
        '<button class="ups-m-pos-chip' + (adpb.sort === "pos" ? " on" : "") + '" data-adpsort="pos">Positional</button>' +
      "</div>" +
      '<div class="ups-m-st-filters"><select class="ups-m-players-filter" id="ups-m-adp-team">' + teamOpts + "</select></div>" +
      '<div class="ups-m-adp-ctl"><span class="ups-m-adp-skew">Dynasty</span>' +
        '<input type="range" class="ups-m-adp-slider" min="0" max="100" step="5" value="' + rdP + '"/>' +
        '<span class="ups-m-adp-skew">Redraft</span></div>' +
      '<div class="ups-m-adp-srcs">' + srcTogs + "</div>" +
      "</div>";
  }
  function adpBoardHtml() {
    if (!adpb.data) return '<div class="ups-m-loading">Loading…</div>';
    var isIdp = (adpb.pos === "DL" || adpb.pos === "LB" || adpb.pos === "DB");
    var universe = adpb.data.filter(function (r) { return isIdp ? r.isIdp : !r.isIdp; });
    universe.forEach(function (r) { r._bv = adpbBlend(r); });
    if (!isIdp) {
      ADPB_SRC.forEach(function (p) {
        universe.forEach(function (r) { r["_rk_" + p[0]] = null; });
        universe.map(function (r) { return { r: r, v: adpbSrcBlend(r, p[0]) }; }).filter(function (x) { return x.v != null && x.v > 0; }).sort(function (a, b) { return b.v - a.v; }).forEach(function (x, i) { x.r["_rk_" + p[0]] = i + 1; });
      });
      universe.forEach(function (r) { r._rk_slp = null; });
      universe.filter(function (r) { return r.sleeperRank != null; }).sort(function (a, b) { return a.sleeperRank - b.sleeperRank; }).forEach(function (r, i) { r._rk_slp = i + 1; });
      universe.forEach(function (r) { r._rk_ffc = null; });
      universe.filter(function (r) { return r.ffcAdp != null; }).sort(function (a, b) { return a.ffcAdp - b.ffcAdp; }).forEach(function (r, i) { r._rk_ffc = i + 1; });
    }
    universe.slice().sort(function (a, b) { return (b._bv || 0) - (a._bv || 0); }).forEach(function (r, i) { r._ovr = i + 1; });
    var byPos = {}; universe.forEach(function (r) { (byPos[r.pos] = byPos[r.pos] || []).push(r); });
    Object.keys(byPos).forEach(function (pos) { var arr = byPos[pos].sort(function (a, b) { return (b._bv || 0) - (a._bv || 0); }); arr.forEach(function (r, i) { r._posRank = i + 1; }); adpbTiers(arr); });
    var rows = universe.slice();
    if (!isIdp && adpb.pos !== "ALL") rows = rows.filter(function (r) { return r.pos === adpb.pos; });
    if (adpb.team && adpb.team !== "__ALL__" && adpbOwn) {
      rows = rows.filter(function (r) {
        var fid = adpbOwn.p2f[String(r.pid)] || null;
        if (adpb.team === "__ROSTERED__") return fid != null;
        if (adpb.team === "FA") return fid == null;
        return fid === adpb.team;
      });
    }
    var sortKey = adpb.sort === "pos" ? "_posRank" : "_ovr";
    rows.sort(function (a, b) { return (a[sortKey] || 9999) - (b[sortKey] || 9999); });
    if (!rows.length) return '<div class="ups-m-stub"><div>No players.</div></div>';
    function tpill(t) { if (t == null) return "—"; var c = t <= 1 ? "t1" : t <= 2 ? "t2" : t <= 3 ? "t3" : "tn"; return '<span class="ups-m-tierp ' + c + '">T' + t + "</span>"; }
    var head = '<div class="ups-m-adp-row head"><span class="rk">#</span><span class="pl">Player</span><span class="v">Pos</span><span class="v">Tier</span></div>';
    var body = rows.slice(0, 300).map(function (r) {
      var sub;
      if (r.isIdp) {
        sub = (r.team || "—") + (r.fpEcr != null ? " · ECR #" + r.fpEcr : "");
      } else {
        var src = [];
        if (r._rk_fc != null) src.push("FC" + r._rk_fc);
        if (r._rk_ktc != null) src.push("KTC" + r._rk_ktc);
        if (r._rk_dp != null) src.push("DP" + r._rk_dp);
        if (r._rk_slp != null) src.push("Slp" + r._rk_slp);
        if (r._rk_ffc != null) src.push("FFC" + r._rk_ffc);
        sub = (r.team || "—") + (src.length ? " · " + src.join(" ") : "");
      }
      return '<div class="ups-m-adp-row">' +
        '<span class="rk">' + (r._ovr != null ? r._ovr : "—") + "</span>" +
        '<span class="pl"><span class="nm">' + U.escapeHtml(r.name) + '</span><span class="sub">' + U.escapeHtml(sub) + "</span></span>" +
        '<span class="v">' + U.escapeHtml(r.pos + (r._posRank != null ? r._posRank : "")) + "</span>" +
        '<span class="v">' + tpill(r._tier) + "</span>" +
      "</div>";
    }).join("");
    return '<div class="ups-m-fpa-table">' + head + body + "</div>";
  }
  function bindAdpBoard(mount) {
    var chips = mount.querySelectorAll(".ups-m-pos-chip[data-adppos]");
    for (var i = 0; i < chips.length; i++) chips[i].addEventListener("click", function () { adpb.pos = this.getAttribute("data-adppos"); M.route.renderRoute(); });
    var togs = mount.querySelectorAll("[data-adpsrc]");
    for (var k = 0; k < togs.length; k++) togs[k].addEventListener("change", function () { adpb.srcSel[this.getAttribute("data-adpsrc")] = this.checked; M.route.renderRoute(); });
    var sl = mount.querySelector(".ups-m-adp-slider");
    if (sl) sl.addEventListener("change", function () { adpb.rdPct = (parseInt(this.value, 10) || 0) / 100; M.route.renderRoute(); });
    var tsel = document.getElementById("ups-m-adp-team");
    if (tsel) { tsel.value = adpb.team; tsel.addEventListener("change", function () { adpb.team = this.value; M.route.renderRoute(); }); }
    var sc = mount.querySelectorAll(".ups-m-pos-chip[data-adpsort]");
    for (var s = 0; s < sc.length; s++) sc[s].addEventListener("click", function () { adpb.sort = this.getAttribute("data-adpsort"); M.route.renderRoute(); });
  }
  function fpaToolbar() {
    var yrs = fpa.years || [fpaYear()];
    var yrSel = '<select class="ups-m-players-filter" id="ups-m-fpa-year" aria-label="Season">' +
      yrs.map(function (y) { return '<option value="' + y + '"' + (y === fpaYear() ? " selected" : "") + ">" + y + "</option>"; }).join("") + "</select>";
    function wkSel(id, sel) { var o = ""; for (var w = 1; w <= 18; w++) o += '<option value="' + w + '"' + (w === sel ? " selected" : "") + ">" + w + "</option>"; return '<select class="ups-m-players-filter" id="' + id + '">' + o + "</select>"; }
    var chips = POS_FPA.map(function (p) { return '<button class="ups-m-pos-chip' + (fpa.pos === p[0] ? " on" : "") + '" data-fpapos="' + p[0] + '">' + p[1] + "</button>"; }).join("");
    return '<div class="ups-m-players-toolbar">' +
      '<div class="ups-m-auc-sec-head">Fantasy Points Against <span class="ct">pts allowed by position</span></div>' +
      '<div class="ups-m-st-filters">' + yrSel + '<span class="ups-m-fpa-wk">Wk ' + wkSel("ups-m-fpa-wmin", fpa.wkMin) + "–" + wkSel("ups-m-fpa-wmax", fpa.wkMax) + "</span></div>" +
      '<div class="ups-m-pos-chips">' + chips + "</div>" +
    "</div>";
  }
  function fpaListHtml() {
    var data = fpa.cache[fpaKey()];
    if (!data) return '<div class="ups-m-loading">Loading…</div>';
    var teams = data.teams || {}, rows = [];
    Object.keys(teams).forEach(function (tm) { var c = teams[tm] && teams[tm][fpa.pos]; if (c) rows.push({ tm: tm, raw: c.raw || {}, adj: c.adj || {} }); });
    rows.sort(function (a, b) { var va = a.adj.rank == null ? 999 : a.adj.rank, vb = b.adj.rank == null ? 999 : b.adj.rank; return va - vb; });
    var of = rows.length;
    var posLabel = (POS_FPA.filter(function (p) { return p[0] === fpa.pos; })[0] || ["", ""])[1] || fpa.pos;
    var wu = (data.weeksUsed || []).length;
    var sub = fpaYear() + " · wks " + fpa.wkMin + "–" + fpa.wkMax + (wu ? " (" + wu + ")" : "") + " · #1 = most generous · tap a team for the breakdown" + (data.err ? " · (load error)" : "");
    if (!rows.length) return '<div class="ups-m-fpa-sub">' + U.escapeHtml(sub) + "</div>" +
      '<div class="ups-m-stub"><div>No data for this position / range.</div></div>';
    var head = '<div class="ups-m-fpa-row head"><span class="rk">#</span><span class="tm">Team</span><span class="v">Alw</span><span class="v">Norm</span><span class="v">Δ%</span></div>';
    var body = rows.map(function (r) {
      var pct = r.adj.ratio != null ? Math.round((r.adj.ratio - 1) * 100) : null;
      var vcls = pct == null ? "" : (pct > 0 ? "up" : (pct < 0 ? "dn" : ""));
      return '<div class="ups-m-fpa-row tap" data-fpateam="' + U.escapeHtml(r.tm) + '">' +
        '<span class="rk"><span class="ups-m-fpa-rk ' + fpaRkCls(r.adj.rank, of) + '">' + (r.adj.rank != null ? r.adj.rank : "—") + "</span></span>" +
        '<span class="tm">' + U.escapeHtml(r.tm) + "</span>" +
        '<span class="v">' + (r.raw.perGame != null ? r.raw.perGame : "—") + "</span>" +
        '<span class="v">' + (r.raw.oppNorm != null ? r.raw.oppNorm : "—") + "</span>" +
        '<span class="v"><span class="ups-m-tr ' + vcls + '">' + (pct != null ? ((pct >= 0 ? "+" : "") + pct + "%") : "—") + "</span></span>" +
      "</div>";
    }).join("");
    return '<div class="ups-m-fpa-sub">' + U.escapeHtml(sub) + '</div><div class="ups-m-fpa-table">' + head + body + "</div>";
  }
  function fpaDetailHtml() {
    var dd = fpa.detailCache[fpaDetailKey()];
    var hdr = fpa.detailTeam + " · " + fpaPosLbl();
    var teamBack = '<div class="ups-m-fpa-sub"><a href="#" class="ups-m-fpa-back">&larr; All teams</a> · ';
    if (!dd) return teamBack + U.escapeHtml(hdr) + "</div>" + '<div class="ups-m-loading">Loading…</div>';
    var weeks = dd.weeks || [];
    function pctsp(p) { return p == null ? "" : '<span class="ups-m-tr ' + (p > 0 ? "up" : (p < 0 ? "dn" : "")) + '">' + (p >= 0 ? "+" : "") + p + "%</span>"; }

    if (fpa.detailWeek == null) {
      // LEVEL 1 — weekly totals + game-script (did the opponent run the implied volume?); tap a week for players.
      var paceNote = (dd.dPace && dd.dPace.expDeltaPct != null) ? (" · D allows " + (dd.dPace.expDeltaPct >= 0 ? "+" : "") + dd.dPace.expDeltaPct + "% plays") : "";
      var sub = teamBack + U.escapeHtml(hdr + (dd.total != null ? " · " + dd.total + " total" : "") + paceNote) + " · tap a week</div>";
      if (!weeks.length) return sub + '<div class="ups-m-stub"><div>No games in range.</div></div>';
      var wrows = weeks.map(function (w) {
        var s = w.script || {};
        var oppSub = s.opp ? ("vs " + s.opp + (s.playsWk != null ? " · " + s.playsWk + "p " + pctsp(s.actualDeltaPct) : "")) : ((w.players ? w.players.length : 0) + " players");
        var sg = s.scriptGap;
        var sgHtml = (sg != null) ? '<span class="ups-m-tr ' + (sg > 0 ? "up" : (sg < 0 ? "dn" : "")) + '">' + (sg >= 0 ? "+" : "") + sg + "</span>" : "";
        return '<div class="ups-m-fpa-wkrow" data-fpawk="' + w.wk + '">' +
          '<span class="wk"><span class="b">Wk ' + w.wk + '</span><span class="s">' + oppSub + "</span></span>" +
          '<span class="tot"><span class="b">' + (w.total != null ? w.total : "—") + '</span><span class="s">' + (sg != null ? "script " + sgHtml : "") + "</span></span>" +
          '<span class="ch">&rsaquo;</span>' +
        "</div>";
      }).join("");
      return sub + '<div class="ups-m-fpa-table">' + wrows + "</div>";
    }

    // LEVEL 2 — the players who faced them in the chosen week (+ snaps vs norm).
    var wk = null; for (var i = 0; i < weeks.length; i++) if (weeks[i].wk === fpa.detailWeek) wk = weeks[i];
    var players = wk ? (wk.players || []) : [];
    var ws = wk && wk.script;
    var wkBack = '<div class="ups-m-fpa-sub"><a href="#" class="ups-m-fpa-wkback">&larr; ' + U.escapeHtml(fpa.detailTeam) + ' weeks</a> · ' +
      U.escapeHtml("Wk " + fpa.detailWeek + (wk && wk.total != null ? " · " + wk.total + " allowed" : "") + (ws && ws.opp ? " · vs " + ws.opp : "")) + "</div>";
    if (!players.length) return wkBack + '<div class="ups-m-stub"><div>No players.</div></div>';
    var rows = players.map(function (g) {
      var v = g.variancePct, vcls = v == null ? "" : (v > 0 ? "up" : (v < 0 ? "dn" : ""));
      var snapSub = (g.snaps != null) ? (" · " + g.snaps + "snp " + pctsp(g.snapDeltaPct)) : "";
      return '<div class="ups-m-fpa-drow nowk">' +
        '<span class="pl"><span class="nm">' + U.escapeHtml(flip(g.name)) + '</span><span class="sub">norm ' + (g.avgVsOthers != null ? g.avgVsOthers : "—") + snapSub + "</span></span>" +
        '<span class="fp">' + (g.pts != null ? g.pts : "—") + "</span>" +
        '<span class="dv"><span class="ups-m-tr ' + vcls + '">' + (v != null ? ((v >= 0 ? "+" : "") + v + "%") : "—") + "</span></span>" +
      "</div>";
    }).join("");
    return wkBack + '<div class="ups-m-fpa-table">' + rows + "</div>";
  }
  function bindInner(mount) {
    var segs = mount.querySelectorAll(".ups-m-stseg[data-inner]");
    for (var i = 0; i < segs.length; i++) segs[i].addEventListener("click", function () { view.inner = this.getAttribute("data-inner"); M.route.renderRoute(); });
  }
  function bindFpa(mount) {
    var y = document.getElementById("ups-m-fpa-year");
    if (y) { y.value = fpaYear(); y.addEventListener("change", function () { fpa.year = this.value; fpa._fb = true; fpa.detailTeam = null; fpa.detailWeek = null; M.route.renderRoute(); }); }
    var wmin = document.getElementById("ups-m-fpa-wmin");
    if (wmin) { wmin.value = String(fpa.wkMin); wmin.addEventListener("change", function () { fpa.wkMin = parseInt(this.value, 10) || 1; if (fpa.wkMax < fpa.wkMin) fpa.wkMax = fpa.wkMin; fpa.detailTeam = null; fpa.detailWeek = null; M.route.renderRoute(); }); }
    var wmax = document.getElementById("ups-m-fpa-wmax");
    if (wmax) { wmax.value = String(fpa.wkMax); wmax.addEventListener("change", function () { fpa.wkMax = parseInt(this.value, 10) || 18; if (fpa.wkMax < fpa.wkMin) fpa.wkMin = fpa.wkMax; fpa.detailTeam = null; fpa.detailWeek = null; M.route.renderRoute(); }); }
    var chips = mount.querySelectorAll(".ups-m-pos-chip[data-fpapos]");
    for (var i = 0; i < chips.length; i++) chips[i].addEventListener("click", function () { fpa.pos = this.getAttribute("data-fpapos"); fpa.detailTeam = null; fpa.detailWeek = null; M.route.renderRoute(); });
    var teamRows = mount.querySelectorAll(".ups-m-fpa-row.tap[data-fpateam]");
    for (var t = 0; t < teamRows.length; t++) teamRows[t].addEventListener("click", function () { fpa.detailTeam = this.getAttribute("data-fpateam"); fpa.detailWeek = null; M.route.renderRoute(); });
    var back = mount.querySelector(".ups-m-fpa-back");
    if (back) back.addEventListener("click", function (e) { e.preventDefault(); fpa.detailTeam = null; fpa.detailWeek = null; M.route.renderRoute(); });
    // two-level drill: tap a week → its players; tap "weeks" → back to the weekly totals
    var wkRows = mount.querySelectorAll(".ups-m-fpa-wkrow[data-fpawk]");
    for (var w = 0; w < wkRows.length; w++) wkRows[w].addEventListener("click", function () { fpa.detailWeek = parseInt(this.getAttribute("data-fpawk"), 10); M.route.renderRoute(); });
    var wkBack = mount.querySelector(".ups-m-fpa-wkback");
    if (wkBack) wkBack.addEventListener("click", function (e) { e.preventDefault(); fpa.detailWeek = null; M.route.renderRoute(); });
  }

  // Team Pace (Stats → Pace inner tab) — moved out of Player Stats.
  var mpace = { season: 0, data: null, seasons: [] };
  function loadPace() {
    return fetch(API.workerUrl("/api/team-pace" + (mpace.season ? "?season=" + encodeURIComponent(mpace.season) : "")), { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.json(); })
      .then(function (d) { mpace.data = d || {}; mpace.seasons = (d && d.seasons) || []; mpace.season = (d && d.season) || mpace.season; return mpace.data; })
      .catch(function () { mpace.data = { teams: [] }; return mpace.data; });
  }
  function paceToolbar() {
    var yopts = (mpace.seasons || []).map(function (y) { return '<option value="' + y + '"' + (String(y) === String(mpace.season) ? " selected" : "") + ">" + y + "</option>"; }).join("") || '<option value="0">—</option>';
    return '<div class="ups-m-players-toolbar"><div class="ups-m-auc-sec-head">Team Pace <span class="ct">plays/game · REG · faster = more snaps</span></div>' +
      '<div class="ups-m-st-filters"><select class="ups-m-players-filter" id="ups-m-pace-year">' + yopts + "</select></div></div>";
  }
  function paceHtml() {
    if (!mpace.data) return '<div class="ups-m-loading">Loading…</div>';
    var teams = (mpace.data.teams || []), avg = mpace.data.leagueAvg || {};
    if (!teams.length) return '<div class="ups-m-stub"><div>No pace data.</div></div>';
    function cls(v, base) { if (v == null || base == null) return ""; if (v >= base * 1.03) return "up"; if (v <= base * 0.97) return "dn"; return ""; }
    var head = '<div class="ups-m-adp-row head"><span class="rk">#</span><span class="pl">Team</span><span class="v">Pace</span><span class="v">PcSoS</span></div>';
    var body = teams.map(function (t, i) {
      return '<div class="ups-m-adp-row">' +
        '<span class="rk">' + (i + 1) + "</span>" +
        '<span class="pl"><span class="nm">' + U.escapeHtml(t.team) + '</span><span class="sub">def faced ' + (t.def_plays_pg != null ? t.def_plays_pg : "—") + " · " + (t.games != null ? t.games : "—") + "g</span></span>" +
        '<span class="v"><span class="ups-m-tr ' + cls(t.off_plays_pg, avg.off) + '">' + (t.off_plays_pg != null ? t.off_plays_pg : "—") + "</span></span>" +
        '<span class="v">' + (t.pace_sos != null ? t.pace_sos : "—") + "</span>" +
      "</div>";
    }).join("");
    return '<div class="ups-m-fpa-table">' + head + body + "</div>";
  }
  function bindPace(mount) {
    var y = document.getElementById("ups-m-pace-year");
    if (y) y.addEventListener("change", function () { mpace.season = this.value; mpace.data = null; M.route.renderRoute(); });
  }

  // ── Schedule (fantasy Strength-of-Schedule heatmap) inner tab ──
  // /api/fantasy-sos: per NFL team × week, the opponent defense's adjusted
  // generosity to the chosen position (>1 = easy, <1 = tough). Compact
  // horizontally-scrollable heatmap; offseason projects from prior-season ratings.
  var msched = { year: 0, pos: "RB", view: "season", data: null };
  function schedYear() { return String(msched.year || curSeason()); }
  function schedYears() { var c = parseInt(curSeason(), 10) || new Date().getUTCFullYear(); var a = []; for (var y = c; y >= 2020; y--) a.push(y); return a; }
  function loadSched() {
    return fetch(API.workerUrl("/api/fantasy-sos?season=" + encodeURIComponent(schedYear()) + "&pos=" + encodeURIComponent(msched.pos)), { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.json(); })
      .then(function (d) { msched.data = (d && d.ok) ? d : { teams: [] }; return msched.data; })
      .catch(function () { msched.data = { teams: [] }; return msched.data; });
  }
  function schedColor(ratio) {
    if (ratio == null) return "background:var(--bg-elev);color:var(--fg-muted)";
    var t = Math.max(0, Math.min(1, (ratio - 0.8) / 0.4));
    return "background:hsl(" + Math.round(t * 120) + ",55%,34%);color:#fff";
  }
  function schedToolbar() {
    var yopts = schedYears().map(function (y) { return '<option value="' + y + '"' + (String(y) === schedYear() ? " selected" : "") + ">" + y + "</option>"; }).join("");
    var chips = POS_FPA.map(function (p) { return '<button class="ups-m-pos-chip' + (msched.pos === p[0] ? " on" : "") + '" data-spos="' + p[0] + '">' + p[1] + "</button>"; }).join("");
    var vchips = [["season", "Full"], ["playoffs", "Playoffs"]].map(function (p) { return '<button class="ups-m-pos-chip' + (msched.view === p[0] ? " on" : "") + '" data-sview="' + p[0] + '">' + p[1] + "</button>"; }).join("");
    return '<div class="ups-m-players-toolbar">' +
      '<div class="ups-m-auc-sec-head">Strength of Schedule <span class="ct">green = easy matchup · red = tough</span></div>' +
      '<div class="ups-m-st-filters"><select class="ups-m-players-filter" id="ups-m-sched-year">' + yopts + "</select>" +
      '<span class="ups-m-pos-chips inline">' + vchips + "</span></div>" +
      '<div class="ups-m-pos-chips">' + chips + "</div></div>";
  }
  function schedHtml() {
    if (!msched.data) return '<div class="ups-m-loading">Loading…</div>';
    var teams = (msched.data.teams || []).slice();
    if (!teams.length) return '<div class="ups-m-stub"><div>No schedule data.</div></div>';
    var agg = msched.view === "playoffs" ? "playoffAvg" : "seasonAvg";
    teams.sort(function (a, b) { return (b[agg] || 0) - (a[agg] || 0); });
    var wks = []; for (var w = 1; w <= 18; w++) wks.push(w);
    var note = (msched.data.projected ? "projected — " + msched.data.ratingSeason + " defense ratings · " : "") + (msched.view === "playoffs" ? "sorted easiest-first by playoff (Wk 15–17) avg" : "sorted easiest-first by season avg");
    var head = '<div class="ups-m-sched-row head"><span class="tm">' + U.escapeHtml(String(msched.data.season || schedYear())) + "</span>" +
      wks.map(function (wk) { return '<span class="cell' + ((wk >= 15 && wk <= 17) ? " po" : "") + '">' + wk + "</span>"; }).join("") + '<span class="ag">Avg</span></div>';
    var body = teams.map(function (t, i) {
      var byW = {}; (t.weeks || []).forEach(function (x) { byW[x.wk] = x; });
      return '<div class="ups-m-sched-row"><span class="tm">' + (i + 1) + " " + U.escapeHtml(t.team) + "</span>" +
        wks.map(function (wk) { var c = byW[wk]; if (!c || c.opp == null) return '<span class="cell bye">—</span>'; return '<span class="cell" style="' + schedColor(c.ratio) + '" title="vs ' + U.escapeHtml(c.opp) + " · " + (c.ratio != null ? c.ratio : "—") + '">' + U.escapeHtml(c.opp) + "</span>"; }).join("") +
        '<span class="ag" style="' + schedColor(t[agg]) + '">' + (t[agg] != null ? t[agg] : "—") + "</span></div>";
    }).join("");
    return '<div class="ups-m-sched-note">' + U.escapeHtml(note) + '</div><div class="ups-m-sched-wrap">' + head + body + "</div>";
  }
  function bindSched(mount) {
    var y = document.getElementById("ups-m-sched-year");
    if (y) y.addEventListener("change", function () { msched.year = this.value; msched.data = null; M.route.renderRoute(); });
    var ps = mount.querySelectorAll("[data-spos]");
    for (var i = 0; i < ps.length; i++) ps[i].addEventListener("click", function () { msched.pos = this.getAttribute("data-spos"); msched.data = null; M.route.renderRoute(); });
    var vs = mount.querySelectorAll("[data-sview]");
    for (var j = 0; j < vs.length; j++) vs[j].addEventListener("click", function () { msched.view = this.getAttribute("data-sview"); paint(mount); });
  }

  function paint(mount) {
    if (view.inner === "pace") {
      mount.innerHTML = subTabs("stats") + innerSwitch() + paceToolbar() + paceHtml();
      settleChrome(mount); bindInner(mount); bindPace(mount);
      return;
    }
    if (view.inner === "fpa") {
      var bodyHtml = fpa.detailTeam ? fpaDetailHtml() : fpaListHtml();
      mount.innerHTML = subTabs("stats") + innerSwitch() + fpaToolbar() + bodyHtml;
      settleChrome(mount); bindInner(mount); bindFpa(mount);
      return;
    }
    if (view.inner === "adp") {
      mount.innerHTML = subTabs("stats") + innerSwitch() + adpBoardToolbar() + adpBoardHtml();
      settleChrome(mount); bindInner(mount); bindAdpBoard(mount);
      return;
    }
    if (view.inner === "vegas") {
      mount.innerHTML = subTabs("stats") + innerSwitch() + vegasToolbar() + vegasHtml();
      settleChrome(mount); bindInner(mount); bindVegas(mount);
      return;
    }
    if (view.inner === "sched") {
      mount.innerHTML = subTabs("stats") + innerSwitch() + schedToolbar() + schedHtml();
      settleChrome(mount); bindInner(mount); bindSched(mount);
      return;
    }
    var tab = curTab(), b = basis();
    mount.innerHTML = subTabs("stats") + innerSwitch() + toolbar(tab, b) + listShell(tab, b);
    settleChrome(mount); bindInner(mount); bind(mount);
  }

  function render(mount) {
    if (view.inner === "pace") {
      if (mpace.data) { paint(mount); return; }
      mount.innerHTML = subTabs("stats") + innerSwitch() + '<div class="ups-m-loading">Loading pace…</div>';
      bindInner(mount);
      loadPace().then(function () { if (view.inner === "pace") paint(mount); });
      return;
    }
    if (view.inner === "fpa") {
      if (fpa.detailTeam) {
        if (fpa.detailCache[fpaDetailKey()]) { paint(mount); return; }
        mount.innerHTML = subTabs("stats") + innerSwitch() + fpaToolbar() +
          '<div class="ups-m-fpa-sub"><a href="#" class="ups-m-fpa-back">&larr; All teams</a></div><div class="ups-m-loading">Loading breakdown…</div>';
        bindInner(mount); bindFpa(mount);
        loadFpaDetail().then(function () { if (view.inner === "fpa" && fpa.detailTeam) paint(mount); });
        return;
      }
      if (fpa.years && fpa.cache[fpaKey()]) { paint(mount); return; }
      mount.innerHTML = subTabs("stats") + innerSwitch() + fpaToolbar() + '<div class="ups-m-loading">Loading points against…</div>';
      bindInner(mount); bindFpa(mount);
      Promise.all([loadFpaYears(), loadFpa()]).then(function (res) {
        var data = res[1];
        // Offseason / empty current year → fall back to the prior season once.
        if (data && !Object.keys(data.teams || {}).length && fpaYear() === String(curSeason()) && !fpa._fb) {
          fpa._fb = true; fpa.year = String((parseInt(curSeason(), 10) || 0) - 1); render(mount); return;
        }
        if (view.inner === "fpa") paint(mount);
      });
      return;
    }
    if (view.inner === "adp") {
      if (adpb.data && adpbOwn) { paint(mount); return; }
      mount.innerHTML = subTabs("stats") + innerSwitch() + adpBoardToolbar() + '<div class="ups-m-loading">Loading ADP…</div>';
      bindInner(mount); bindAdpBoard(mount);
      Promise.all([loadAdpBoard(), loadAdpbOwn()]).then(function () { if (view.inner === "adp") paint(mount); });
      return;
    }
    if (view.inner === "vegas") {
      if (vg.data) { paint(mount); return; }
      mount.innerHTML = subTabs("stats") + innerSwitch() + '<div class="ups-m-loading">Loading Vegas lines…</div>';
      bindInner(mount);
      loadVegas().then(function () { if (view.inner === "vegas") paint(mount); });
      return;
    }
    if (view.inner === "sched") {
      if (msched.data) { paint(mount); return; }
      mount.innerHTML = subTabs("stats") + innerSwitch() + schedToolbar() + '<div class="ups-m-loading">Loading schedule…</div>';
      bindInner(mount); bindSched(mount);
      loadSched().then(function () { if (view.inner === "sched") paint(mount); });
      return;
    }
    var tab = curTab();
    /* Six side-loaders feed the optional column sets (SoS, Boom/Bust, EPA,
     * Market, Routes, NGS). Each used to call paint(), which rebuilds the WHOLE
     * mount — and because a warm map returns an already-resolved promise, every
     * render fired six extra full rebuilds on top of the real one, each
     * re-emitting the subtabs, the toolbar and up to 150 rows.
     *
     * They only ever change CELL VALUES, so they repaint the rows and nothing
     * else. That also stops them from yanking the toolbar (and the focused
     * search box) out from under someone who is mid-word when one resolves. */
    function fillColumns() {
      if (view.inner === "players" && view.tab === tab.id) repaintList();
    }
    var b = basis(), yr = b.season;
    loadStarterRates(yr, tab).then(fillColumns);
    // Status is always THIS season's (a stored prior-season list still shows today's status).
    if (window.UPS_MOBILE_PLAYER_STATUS) window.UPS_MOBILE_PLAYER_STATUS.load(ctxYear() || yr).then(fillColumns);
    loadEpa(yr).then(fillColumns);
    loadRoutes(yr).then(fillColumns);
    loadNgs(yr).then(fillColumns);
    // MFL's YTD moves while games are played: re-read W=ALL once it is 5+
    // minutes old (the same refresh the Players market uses). A failed read
    // keeps the old numbers AND their old "MFL read" time, so staleness shows.
    if (D().refreshSeasonScoringIfStale) D().refreshSeasonScoringIfStale(5 * 60 * 1000).then(function (changed) {
      if (changed && view.inner === "players" && view.tab === tab.id) repaintList();
    });
    if (cache[tab.alias + "|" + yr]) { paint(mount); return; }
    // The leaderboard decides who is listed, so the list waits for it.
    mount.innerHTML = subTabs("stats") + innerSwitch() + '<div class="ups-m-loading">Loading stats…</div>';
    settleChrome(mount); bindInner(mount);
    load(tab.alias, yr).then(function () { if (view.tab === tab.id && view.inner === "players") paint(mount); });
  }

  M.statsView = { render: render };
  M.route.registerView("stats", render);
})();
