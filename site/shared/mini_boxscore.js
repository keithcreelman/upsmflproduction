/*!
 * mini_boxscore.js — UPS-controlled copy of theeohiostate's mini-boxscore widget.
 * Stage 3 of docs/mfl_native/tos_removal_plan.md
 *
 * Verbatim port from https://www.mflscripts.com/mfl-apps/scoreboard/mini-boxscore/script.js
 * (snapshot 2026-04-06, beautified via prettier 3.8.3). Behavior unchanged.
 *
 * Loaded by HPM #1 ONLY when window.UPS_USE_NATIVE_MINI_BOXSCORE === true.
 * While the flag is false the file is fetched but the guard returns early —
 * TOS's bundled mini-boxscore (in header.js) continues to drive #MFLBoxWrapper.
 *
 * Three external image URLs are preserved (mflscripts.com NFL team logo CDN).
 * Self-hosting those is tracked separately under Stage 8.
 *
 * Public surface: depends on globals provided by MFL native home page rendering:
 *   leagueAttributes, completedWeek, liveScoringWeek, endWeek, thisProgram,
 *   is_offseason, deactivate_all_offseason. Renders into #MFLBoxWrapper.
 *
 * Future refactor (post-Stage 5): replace incrementally with a first-party
 * widget that reads from MFLCache + our worker, drops jQuery dependency,
 * uses our scoreboard module under site/standings/.
 *
 * Safety audit at port time: no eval/new Function/document.write at runtime,
 * no XHR/fetch to non-mflscripts hosts. innerHTML usage is bounded to
 * self-generated HTML strings (no user input).
 */
(function () {
  "use strict";
  if (typeof window === "undefined") return;
  if (!window.UPS_USE_NATIVE_MINI_BOXSCORE) return;
  if (window.__UPS_MINI_BOXSCORE_INSTALLED__) return;
  window.__UPS_MINI_BOXSCORE_INSTALLED__ = true;

  /* ---------- BEGIN verbatim TOS source ---------- */

if (void 0 === mini_offseason_hide) var mini_offseason_hide = !1;
if (void 0 === deactivate_all_offseason) var deactivate_all_offseason = !1;
if ((is_offseason && mini_offseason_hide) || (is_offseason && deactivate_all_offseason))
  ($("#MFLBoxWrapper").parent(".mobile-wrap").remove(), $("#MFLBoxWrapper").remove());
else {
  if (void 0 === mflBoxHomePageOnly) var mflBoxHomePageOnly = !0;
  if (void 0 === mflBoxUseIcon) var mflBoxUseIcon = !1;
  if (void 0 === mflBoxUseLogo) var mflBoxUseLogo = !1;
  if (void 0 === mflBoxUseAbbrev) var mflBoxUseAbbrev = !1;
  if (void 0 === mflBoxIconBase) var mflBoxIconBase = "";
  if (void 0 === mflBoxIconExt) var mflBoxIconExt = "";
  if (void 0 === mflBoxNFLLogoPath)
    var mflBoxNFLLogoPath = "https://www.mflscripts.com/ImageDirectory/script-images/nflTeamsvg_2/";
  if (void 0 === mflBoxNFLLogoExt) var mflBoxNFLLogoExt = "svg";
  if (void 0 === mflBoxPositionSort)
    var mflBoxPositionSort = [
      "Coach",
      "Off",
      "QB",
      "TMQB",
      "RB",
      "TMRB",
      "WR",
      "TMWR",
      "TE",
      "TMTE",
      "PK",
      "TMPK",
      "PN",
      "TMPN",
      "DT",
      "DE",
      "TMDL",
      "LB",
      "TMLB",
      "CB",
      "S",
      "TMDB",
      "Def",
      "ST",
    ];
  if (void 0 === mflBoxIncludeTiebreaker) var mflBoxIncludeTiebreaker = !1;
  if (void 0 === mflBoxShowNonStarter) var mflBoxShowNonStarter = !1;
  if (void 0 === mflBoxShowMFLByeTeams) var mflBoxShowMFLByeTeams = !0;
  if (void 0 === mflBoxHideNFLMatchups) var mflBoxHideNFLMatchups = !1;
  if (void 0 === mflBoxHideFantasyMatchups) var mflBoxHideFantasyMatchups = !1;
  if (void 0 === mflBoxHidePaceScores) var mflBoxHidePaceScores = !1;
  if (void 0 === precision) var precision = 0;
  if (void 0 === mflBoxIsTotalPts) var mflBoxIsTotalPts = !1;
  var doMFLBox = !1;
  function initMiniDomCaches() {
    try {
      "undefined" != typeof window &&
        (window.__mini_nodes || (window.__mini_nodes = Object.create(null)),
        window.__mini_lists || (window.__mini_lists = Object.create(null)),
        window.el$ ||
          (window.el$ = function el$(e) {
            const t = window.__mini_nodes;
            return t[e] || (t[e] = document.getElementById(e));
          }),
        window.els$ ||
          (window.els$ = function els$(e) {
            const t = window.__mini_lists;
            return t[e] || (t[e] = document.querySelectorAll(e));
          }),
        window.invalidateMiniQsCache ||
          (window.invalidateMiniQsCache = function () {
            try {
              for (const e in window.__mini_lists) delete window.__mini_lists[e];
              for (const e in window.__mini_nodes) delete window.__mini_nodes[e];
            } catch (e) {}
          }));
    } catch (e) {}
  }
  function initMiniOnce() {
    try {
      "undefined" != typeof window &&
        (window.__mini_once || (window.__mini_once = new Set()),
        window.addHeadStyleOnce ||
          (window.addHeadStyleOnce = function (e, t) {
            try {
              if (window.__mini_once.has(e)) return;
              window.__mini_once.add(e);
              const a = document.createElement("style");
              ((a.textContent = t), document.head.appendChild(a));
            } catch (e) {}
          }));
    } catch (e) {}
  }
  if (
    (mflBoxHomePageOnly
      ? ("undefined" != typeof thisProgram && "home" === thisProgram && (doMFLBox = !0),
        "undefined" != typeof thisProgram && "options_247" === thisProgram && (doMFLBox = !1),
        new URLSearchParams(window.location.search).has("MODULE") && (doMFLBox = !1))
      : (doMFLBox = !0),
    doMFLBox && (initMiniDomCaches(), initMiniOnce()),
    doMFLBox)
  ) {
    var mflBoxJSON_league,
      mflBoxJSON_matchups,
      mflBoxJSON_nflSchedule,
      mflBoxStartWeek,
      mflBoxLastRegularSeasonWeek,
      mflBoxEndWeek,
      mflBox_byeWeek = {},
      mflBoxJSON_projectedScores = {},
      mflBoxJSON_projectedScoresWeek = {},
      mflBox_matchups = [],
      mflBox_nflSchedule = [],
      mflBox_nflOpponents = {},
      mflBox_players = {},
      mflBoxMFLSchedule = !0,
      mflBoxStarters = leagueAttributes.MaxStarters,
      mflBoxCurrentWeekKickoff = 0,
      mflBoxActiveWeekKickoff = 0,
      mflBoxCurrentWeek = completedWeek,
      mflBoxCurrentLiveScoring = !1,
      mflBoxActiveWeek = liveScoringWeek;
    liveScoringWeek > endWeek && (mflBoxActiveWeek = endWeek);
    var mflBoxIsAllPlay = !1,
      mflBoxAllPlayId = "0001",
      mflBoxDetailsTracker = {},
      mflBoxFirstKickoff = {},
      mflBoxNFLKickoff = {},
      mflBoxFranchise = {},
      mflBoxPlayerDetailsFid = { fid: "", boxid: 0 },
      mflBoxPlayerProjected = {},
      mflBoxLiveStatsPlayer = {},
      mflBoxLiveStatsTeam = {},
      mflBoxTiebreaker = {};
    "undefined" != typeof franchise_id &&
      "0000" !== franchise_id &&
      (mflBoxAllPlayId = franchise_id);
    var mflBoxWeekDay = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
      mflBoxMonth = [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
      ],
      mflBoxNflGameStatus = {},
      mflBox_player_fid_tracker = {};
    (document.getElementById("MFLBoxWrapper") || document.write('<div id="MFLBoxWrapper"></div>'),
      jQuery("#MFLBoxWrapper").html(
        '<div id="MFLBoxContainer"></div><div id="MFLBoxPlayerDetails" style="display:none"></div><div id="MFLBoxOverlay" onclick="mflBoxPlayerDetailsClose()" style="display:none"></div>',
      ),
      addHeadStyleOnce(
        "css-b31e9c4a",
        '#MFLBoxContainer .MFLGameLinks .matchupLolite{border-right:0.375rem solid transparent}#MFLBoxContainer .MFLGameLinks .matchupLolite:last-child{border-right:0}#MFLBoxWrapper .MFLBoxPlayerDetailsTR[onclick*="BYE"]:hover,#MFLBoxWrapper .MFLBoxPlayerDetailsTR[onclick*="AVG"]:hover{background:none!important;cursor:default!important}#MFLBoxWrapper{margin:0.625rem auto}#MFLBoxContainer .MFLGameLinks{width:auto;margin:0 auto;}#MFLBoxContainer .MFLGameLinks tr{height:1.688rem}#MFLBoxContainer .MFLGameLinks .MFLLiveTeam,#MFLBoxContainer .MFLGameLinks .MFLNFLLiveTeam{width:100%}#MFLBoxContainer .MFLGameLinks .MFLPaceScore{font-size:80%;font-style:italic;padding:0 0.313rem;padding:0 .313rem}#MFLBoxContainer .MFLGameLinks .nflicon{height:1.5rem;height:1.5rem;width:auto}#MFLBoxContainer .MFLGameLinks .MFLLiveScore,#MFLBoxContainer .MFLGameLinks .MFLNFLLiveScore{font-weight:700}#MFLBoxContainer .MFLBoxNav .MFLGameLinks td{font-size:0.625rem;text-transform:uppercase;text-align:center}#MFLBoxContainer .MFLGameTable{white-space:nowrap;border:0;padding:0 0.125rem;border-radius:0.188rem;min-width:auto;border-spacing:0;min-width:8.125rem}#MFLBoxMatchups td.matchupLolite:nth-child(1) .MFLGameTable{border-left:0}#MFLBoxContainer .matchupLolite,#MFLBoxContainer .matchupHilite{cursor:default;margin-bottom:0.188rem}#MFLBoxContainer .MFLLiveTeam img{max-height:0.938rem}#MFLBoxContainer .MFLLiveClock,#MFLBoxContainer .MFLNFLLiveClock{text-align:center}#MFLBoxContainer .MFLLiveScore,#MFLBoxContainer .MFLNFLLiveScore{text-align:right}#MFLBoxContainer .MFLExtrasPMR,#MFLBoxContainer .MFLExtrasCP,#MFLBoxContainer .MFLExtrasYTP{text-align:center;font-size:smaller;display:none}#MFLBoxContainer .MFLBoxDetailsArrow{position:absolute;bottom:0.375rem;right:0.125rem;cursor:pointer}.MFLBoxArrowRight:before{content:"\\f054";font-family:"Font Awesome 6 Pro";position:absolute;right:0.125rem;top:2.875rem;font-size:1.875rem;cursor:pointer}.MFLBoxArrowLeft:before{content:"\\f053";font-family:"Font Awesome 6 Pro";position:absolute;right:0.313rem;top:0.375rem;font-size:1.875rem;cursor:pointer}.MFLBoxArrowLeft.MFLBoxArrowFaded:before,.MFLBoxArrowRight.MFLBoxArrowFaded:before{cursor:default;opacity:.4}.mflBoxButtonFaded{opacity:.5}#MFLBoxOverlay{display:none;height:100%;left:0;opacity:.7;position:fixed;top:0;width:100%;z-index:99999;background-color:#000}#MFLBoxWrapper .MFLBoxPlayerDetailsClose{position:absolute;z-index:1;cursor:pointer;text-align:center;font-weight:700;padding:0;right:0.75rem;top:0.938rem;height:1.375rem;width:1.375rem;line-height:1.4;border-radius:0.188rem;border-radius:.188rem;font-family:"Open Sans",sans-serif;font-size:0.813rem;font-size:.813rem;opacity:.6}#MFLBoxWrapper .MFLBoxPlayerDetailsClose:hover{opacity:1}#MFLBoxWrapper .MFLBoxPlayerDetailsNone{text-align:center;font-style:italic}#MFLBoxWrapper #MFLBoxPlayerDetails{position:fixed;z-index:100000;overflow-y:auto;-webkit-overflow-scrolling:touch;border-radius:0.188rem;padding:0.625rem;width:90%;max-width:28.125rem;height:80%;max-height:25rem;overflow-y: auto;left: 0!important;right: 0!important;top: 0!important;bottom: 0!important;margin: auto;}#MFLBoxWrapper .MFLBoxPlayerDetailsTR:hover{cursor:pointer}#MFLBoxWrapper #MFLBoxPlayerDetails td{font-size:small;}#MFLBoxWrapper #MFLBoxPlayerDetails .MFLPaceScore{font-style:italic}#MFLBoxWrapper #MFLBoxPlayerDetailsTable{padding:0.25rem}#MFLBoxWrapper .MFLBoxLiveStatsScore{cursor:pointer}#MFLBoxWrapper .MFLBoxLiveStatsWrapper{position:relative}#MFLBoxWrapper .MFLBoxLiveStatsContent{position:absolute;right:1.875rem;top:-3.25rem;cursor:default;padding:0.625rem 0.875rem 0.625rem 0.5rem;border-radius:0.313rem;font-weight:700;width:12.5rem;text-align:center;white-space:pre-wrap}#MFLBoxWrapper .MFLBoxLiveStatsClose{position:absolute;right:0.188rem;top:0.188rem;cursor:pointer;font-weight:700}#MFLBoxWrapper #MFLBoxContainer{position:relative;margin:0.625rem 0;margin-top:0}#MFLBoxWrapper #MFLBoxMatchups{min-height:5.313rem;border:0.188rem solid transparent;overflow-y:hidden}#MFLBoxWrapper #MFLBoxMatchups div.warning{line-height:5.188rem;margin:0!important;padding:0!important;border-radius:0.188rem;display:table;width:100%}#MFLBoxWrapper #MFLBoxContainer input[type="button"]{padding:0.188rem;margin:0;font-weight:400;font-size:0.875rem;opacity:1}#MFLBoxWrapper #MFLBoxContainer .matchupAllPlay{cursor:pointer}#MFLBoxWrapper .MFLNFLBoxContainer{overflow:auto;width:auto!important;margin-left:2.188rem;margin-right:1.875rem;-webkit-overflow-scrolling:touch}#MFLBoxWrapper .MFLBoxMFLNFL{position:absolute;top:0.125rem;width:auto;margin-left:-1.563rem;width:2.813rem}.MFLLiveTeam{min-width:3.75rem}#MFLBoxWrapper .downDistance{font-size:0.563rem;font-style:italic}#MFLBoxWrapper .possession:before{background-image:url(https://www.mflscripts.com/ImageDirectory/script-images/football.svg)}#MFLBoxWrapper .redzone:before{background-image:url(https://www.mflscripts.com/ImageDirectory/script-images/goal-post.svg)}#MFLBoxWrapper .possession,#MFLBoxWrapper .redzone{position:relative;padding-left:0.875rem}#MFLBoxWrapper .possession:before,#MFLBoxWrapper .redzone:before{content: "";background-size:0.75rem 0.75rem;height:0.75rem;width:0.75rem;position:absolute;top:50%;transform:translateY(-50%);left:0}#MFLBoxWrapper .redzone{background-image:none;padding-right:0}@media only screen and (max-width: 38em){#MFLBoxWrapper #MFLBoxPlayerDetails td,#MFLBoxWrapper #MFLBoxPlayerDetails th{font-size:0.688rem}}@media only screen and (max-width: 22em){#MFLBoxWrapper #MFLBoxPlayerDetails td,#MFLBoxWrapper #MFLBoxPlayerDetails th{font-size:0.563rem}}',
      ),
      mflBoxShowMFLByeTeams &&
        addHeadStyleOnce(
          "css-2eb4dcec",
          "#MFLBoxContainer .MFLGameLinks.fantasyBoxMatchup{width:100%}",
        ),
      mflBoxHideNFLMatchups &&
        addHeadStyleOnce("css-2c106b0d", "#MFLBoxNFLCell,#MFLBoxMFLCell{display:none!important}"),
      mflBoxHidePaceScores &&
        addHeadStyleOnce(
          "css-f3634b97",
          ".MFLGameTable .MFLPaceScore,.MFLGameTable .MFLPaceScore .warning{font-size:0!important;color:transparent!important}",
        ),
      jQuery("#MFLBoxContainer").append(
        '<div class="MFLBoxNav MFLBoxArrowLeft MFLBoxArrowFaded" onclick="mflBoxNewWeek(-1)" style="left:0;"></div>',
      ),
      jQuery("#MFLBoxContainer").append(
        `\n\t<div class="MFLBoxNav MFLBoxMFLNFL" style="left:1.125rem;">\n\t\t<table class="MFLGameLinks">\n\t\t\t<tbody>\n\t\t\t\t<tr>\n\t\t\t\t\t<td id="MFLBoxMFLCell" class="mflBoxCell">\n\t\t\t\t\t\t<span class="form_buttons">\n\t\t\t\t\t\t\t<input \n\t\t\t\t\t\t\t\tid="mflBoxButtonMFL" \n\t\t\t\t\t\t\t\tclass="mflBoxButton" \n\t\t\t\t\t\t\t\tonclick="mflBoxMFLSchedule=true;\n\t\t\t\t\t\t\t\t\tjQuery('#mflBoxButtonMFL').attr('style','cursor:default');\n\t\t\t\t\t\t\t\t\tjQuery('#mflBoxButtonNFL').attr('style','cursor:pointer');\n\t\t\t\t\t\t\t\t\tjQuery('#mflBoxButtonMFL').removeClass('mflBoxButtonFaded');\n\t\t\t\t\t\t\t\t\tjQuery('#mflBoxButtonNFL').addClass('mflBoxButtonFaded');\n\t\t\t\t\t\t\t\t\tmflBoxNewWeek(0);" \n\t\t\t\t\t\t\t\tstyle="cursor:default" \n\t\t\t\t\t\t\t\ttype="button" \n\t\t\t\t\t\t\t\tvalue="MFL"\n\t\t\t\t\t\t\t>\n\t\t\t\t\t\t</span>\n\t\t\t\t\t</td>\n\t\t\t\t</tr>\n\t\t\t\t<tr>\n\t\t\t\t\t<td id="MFLBoxWeekCell">Wk ${mflBoxActiveWeek}</td>\n\t\t\t\t</tr>\n\t\t\t\t<tr>\n\t\t\t\t\t<td id="MFLBoxNFLCell" class="mflBoxCell mflBoxCellInactive">\n\t\t\t\t\t\t<span class="form_buttons">\n\t\t\t\t\t\t\t<input \n\t\t\t\t\t\t\t\tid="mflBoxButtonNFL" \n\t\t\t\t\t\t\t\tclass="mflBoxButton mflBoxButtonFaded" \n\t\t\t\t\t\t\t\tonclick="mflBoxMFLSchedule=false;\n\t\t\t\t\t\t\t\t\tjQuery('#mflBoxButtonNFL').attr('style','cursor:default');\n\t\t\t\t\t\t\t\t\tjQuery('#mflBoxButtonMFL').attr('style','cursor:pointer');\n\t\t\t\t\t\t\t\t\tjQuery('#mflBoxButtonMFL').addClass('mflBoxButtonFaded');\n\t\t\t\t\t\t\t\t\tjQuery('#mflBoxButtonNFL').removeClass('mflBoxButtonFaded');\n\t\t\t\t\t\t\t\t\tmflBoxNewWeek(0);" \n\t\t\t\t\t\t\t\ttype="button" \n\t\t\t\t\t\t\t\tvalue="NFL"\n\t\t\t\t\t\t\t>\n\t\t\t\t\t\t</span>\n\t\t\t\t\t</td>\n\t\t\t\t</tr>\n\t\t\t</tbody>\n\t\t</table>\n\t</div>\n`,
      ),
      jQuery("#MFLBoxContainer").append(
        '<div id="MFLBoxMatchups" class="report MFLNFLBoxContainer"><div class="warning" style="padding:0.938rem;font-weight:bold;vertical-align:middle;text-align:center;font-style:italic;font-size:1.125rem"></div></div>',
      ),
      (function () {
        try {
          if (!window.MFLCache) return;
          var e = window.MFLCache.KEY.mflBoxMatchups(year, league_id),
            t = window.MFLCache.getSync(e);
          if (t && t.data)
            return void (document.getElementById("MFLBoxMatchups").innerHTML = t.data);
          window.MFLCache.get(e)
            .then(function (e) {
              if (e && e.data) {
                var t = document.getElementById("MFLBoxMatchups");
                t && (t.innerHTML = e.data);
              }
            })
            .catch(function () {});
        } catch (e) {}
      })(),
      jQuery("#MFLBoxContainer").append(
        '<div class="MFLBoxNav MFLBoxArrowRight" onclick="mflBoxNewWeek(1)"></div>',
      ));
  } else jQuery("#MFLBoxWrapper").remove();
  function doMFLBoxFantasyWeek() {
    if (mflBoxMFLSchedule)
      return (
        (mflBoxJSON_matchups = {}),
        mflBoxActiveWeek === mflBoxCurrentWeek &&
        liveScoringWeek > completedWeek &&
        !liveScoringLiveWeek?.error
          ? mflBoxCurrentLiveScoring
            ? Promise.resolve()
                .then(() => {
                  const e = liveScoringLiveWeek || {};
                  if (
                    (e.liveScoring?.matchup &&
                      (e.liveScoring.matchup.franchise
                        ? (mflBoxJSON_matchups.matchup = [e.liveScoring.matchup])
                        : (mflBoxJSON_matchups.matchup = e.liveScoring.matchup)),
                    e.liveScoring?.franchise &&
                      (e.liveScoring?.id
                        ? (mflBoxJSON_matchups.franchise = [e.liveScoring.franchise])
                        : (mflBoxJSON_matchups.franchise = e.liveScoring.franchise)),
                    mflBoxIncludeTiebreaker)
                  ) {
                    const e = Math.min(mflBoxActiveWeek, endWeek),
                      t = reportWeeklyResults_ar[`w_${e}`];
                    try {
                      mflBoxPopulateTiebreaker(t.weeklyResults);
                    } catch {}
                  }
                  return mflBoxJSON_matchups;
                })
                .catch((e) => {
                  console.log("Error:", e);
                })
            : Promise.resolve().then(() => {
                const e = Math.min(mflBoxActiveWeek, endWeek),
                  t = reportWeeklyResults_ar[`w_${e}`];
                try {
                  mflBoxJSON_matchups = t.weeklyResults;
                } catch {}
                return mflBoxJSON_matchups;
              })
          : Promise.resolve().then(() => {
              const e = Math.min(mflBoxActiveWeek, endWeek),
                t = reportWeeklyResults_ar[`w_${e}`];
              try {
                mflBoxJSON_matchups = t.weeklyResults;
              } catch {}
              return mflBoxJSON_matchups;
            })
      );
  }
  function mflBoxCheckWeeklyResultsForScore(e) {
    const t = "w_" + Math.min(Number(e ?? mflBoxActiveWeek) || 0, endWeek),
      a = reportWeeklyResults_ar?.[t]?.weeklyResults;
    if (!a || !a.matchup) return !1;
    const o = Array.isArray(a.matchup) ? a.matchup : [a.matchup];
    for (const e of o) {
      const t = Array.isArray(e?.franchise) ? e.franchise : e?.franchise ? [e.franchise] : [];
      for (const e of t) {
        const t = Number(e?.score);
        if (!Number.isNaN(t) && t > 0) return !0;
      }
    }
    return !1;
  }
  function doMFLBoxNFLWeek() {
    return Promise.resolve().then(() => {
      doMFLBoxNFLWeek_response(
        (mflBoxJSON_nflSchedule = reportNflSchedule_ar[`w_${mflBoxActiveWeek}`].nflSchedule),
      );
    });
  }
  function doMFLBoxNFLWeek_response(e) {
    mflBoxNflGameStatus = {};
    var t = [];
    e.matchup && e.matchup.hasOwnProperty("team") ? (t[0] = e.matchup) : (t = e.matchup || []);
    for (var a = 0; a < t.length; a++) {
      var o = t[a];
      if (o && o.team && !(o.team.length < 2)) {
        var r = o.team[0],
          s = o.team[1],
          i = r.id,
          l = s.id,
          n = parseInt(o.kickoff, 10) || 0,
          m = void 0 !== r.score ? parseInt(r.score, 10) : null,
          f = void 0 !== s.score ? parseInt(s.score, 10) : null;
        ((mflBoxNflGameStatus[i] = { time: n, isHome: !1, isBye: !1, score: m }),
          (mflBoxNflGameStatus[l] = { time: n, isHome: !0, isBye: !1, score: f }));
      }
    }
  }
  function doMFLBoxProjectedScores() {
    return mflBoxCurrentWeek >= mflBoxActiveWeek && !mflBoxHideFantasyMatchups && mflBoxMFLSchedule
      ? Promise.resolve().then(() => {
          const e = `w_${mflBoxActiveWeek}`;
          if (mflBoxJSON_projectedScoresWeek.hasOwnProperty(e))
            mflBoxJSON_projectedScores = mflBoxJSON_projectedScoresWeek[e];
          else
            try {
              ((mflBoxJSON_projectedScoresWeek[e] = reportProjectedScores_ar[e]),
                (mflBoxJSON_projectedScores = reportProjectedScores_ar[e]));
            } catch (e) {
              console.error("Error:", e);
            }
        })
      : Promise.resolve();
  }
  function doMFLBoxArrays() {
    for (var e in ((mflBox_players = {}),
    (mflBox_player_fid_tracker = {}),
    (mflBox_matchups = []),
    (mflBox_nflSchedule = []),
    (mflBox_nflOpponents = {}),
    (mflBoxIsAllPlay = !1),
    (mflBoxFranchise = {}),
    (mflBoxPlayerProjected = {}),
    reportStandingsFid_ar))
      if (reportStandingsFid_ar.hasOwnProperty(e)) {
        var t = "0",
          a = "0",
          o = "0";
        (reportStandingsFid_ar[e].hasOwnProperty("w") && (t = reportStandingsFid_ar[e].w),
          reportStandingsFid_ar[e].hasOwnProperty("l") && (a = reportStandingsFid_ar[e].l),
          reportStandingsFid_ar[e].hasOwnProperty("t") && (o = reportStandingsFid_ar[e].t),
          (franchiseDatabase["fid_" + e].record = "(" + t + "-" + a + "-" + o + ")"));
      }
    if (
      mflBoxJSON_matchups &&
      "object" == typeof mflBoxJSON_matchups &&
      ("matchup" in mflBoxJSON_matchups || "franchise" in mflBoxJSON_matchups)
    ) {
      if ("matchup" in mflBoxJSON_matchups) {
        var r = [];
        mflBoxJSON_matchups.matchup.hasOwnProperty("franchise")
          ? r.push(mflBoxJSON_matchups.matchup)
          : (r = mflBoxJSON_matchups.matchup);
        for (var s = 0; s < r.length; s++) {
          var i = r[s].franchise[0],
            l = r[s].franchise[1];
          ((mflBox_matchups[s] = {
            roadId: i.id,
            homeId: l.id,
            roadScore: i.score,
            homeScore: l.score,
            roadProjected: 0,
            homeProjected: 0,
            roadYetToPlay: 0,
            homeYetToPlay: 0,
            roadCurrentlyPlaying: 0,
            homeCurrentlyPlaying: 0,
            roadPlayerMinutesRemaining: 0,
            homePlayerMinutesRemaining: 0,
          }),
            (mflBox_matchups[s].roadSpread = ""),
            (mflBox_matchups[s].homeSpread = ""),
            void 0 !== i.spread &&
              parseFloat(i.spread) < 0 &&
              (mflBox_matchups[s].roadSpread = parseFloat(i.spread).toFixed(1)),
            void 0 !== l.spread &&
              parseFloat(l.spread) < 0 &&
              (mflBox_matchups[s].homeSpread = parseFloat(l.spread).toFixed(1)),
            mflBoxActiveWeek > liveScoringWeek &&
              mflBoxActiveWeek > completedWeek + 1 &&
              ((mflBox_matchups[s].roadSpread = ""), (mflBox_matchups[s].homeSpread = "")),
            (mflBox_matchups[s].roadResult = ""),
            (mflBox_matchups[s].homeResult = ""),
            void 0 !== i.result && (mflBox_matchups[s].roadResult = i.result),
            void 0 !== l.result && (mflBox_matchups[s].homeResult = l.result),
            (mflBox_matchups[s].roadStarters = ""),
            (mflBox_matchups[s].homeStarters = ""),
            i.hasOwnProperty("starters") &&
              void 0 !== i.starters &&
              (mflBox_matchups[s].roadStarters = i.starters),
            l.hasOwnProperty("starters") &&
              void 0 !== l.starters &&
              (mflBox_matchups[s].homeStarters = l.starters));
          try {
            if (
              ((mflBox_matchups[s].roadYetToPlay = parseInt(r[s].franchise[0].playersYetToPlay)),
              (mflBox_matchups[s].homeYetToPlay = parseInt(r[s].franchise[1].playersYetToPlay)),
              (mflBox_matchups[s].roadCurrentlyPlaying = parseInt(
                r[s].franchise[0].playersCurrentlyPlaying,
              )),
              (mflBox_matchups[s].homeCurrentlyPlaying = parseInt(
                r[s].franchise[1].playersCurrentlyPlaying,
              )),
              (mflBox_matchups[s].roadPlayerMinutesRemaining = parseInt(
                parseInt(r[s].franchise[0].gameSecondsRemaining) / 60 + 0.99,
              )),
              (mflBox_matchups[s].homePlayerMinutesRemaining = parseInt(
                parseInt(r[s].franchise[1].gameSecondsRemaining) / 60 + 0.99,
              )),
              r[s].franchise[0].players.hasOwnProperty("player"))
            )
              for (var n = 0; n < r[s].franchise[0].players.player.length; n++) {
                if ("starter" === (c = r[s].franchise[0].players.player[n]).status) var m = "1";
                else m = "0";
                if (
                  (void 0 === mflBox_players["pid_" + c.id]
                    ? ((mflBox_players["pid_" + c.id] = {
                        id: c.id,
                        fid: i.id,
                        score: c.score,
                        gameSecondsRemaining: parseInt(c.gameSecondsRemaining),
                        isStarter: m,
                      }),
                      (mflBox_player_fid_tracker[c.id + "_" + i.id] = 1))
                    : void 0 === mflBox_player_fid_tracker[c.id + "_" + i.id] &&
                      ((mflBox_players["pid_" + c.id].fid += "," + i.id),
                      (mflBox_players["pid_" + c.id].isStarter += "," + m),
                      (mflBox_player_fid_tracker[c.id + "_" + i.id] = 1)),
                  "1" === m)
                )
                  try {
                    void 0 === mflBoxFirstKickoff[r[s].franchise[0].id]
                      ? mflBoxNFLKickoff[playerDatabase["pid_" + c.id].team] > 0 &&
                        (mflBoxFirstKickoff[r[s].franchise[0].id] =
                          mflBoxNFLKickoff[playerDatabase["pid_" + c.id].team])
                      : mflBoxNFLKickoff[playerDatabase["pid_" + c.id].team] > 0 &&
                        mflBoxNFLKickoff[playerDatabase["pid_" + c.id].team] <
                          mflBoxFirstKickoff[r[s].franchise[0].id] &&
                        (mflBoxFirstKickoff[r[s].franchise[0].id] =
                          mflBoxNFLKickoff[playerDatabase["pid_" + c.id].team]);
                  } catch (e) {
                    console.log("error road");
                  }
                (void 0 === mflBoxFranchise["fid_" + i.id] &&
                  (mflBoxFranchise["fid_" + i.id] = { starter: {}, bench: {}, tiebreaker: {} }),
                  "starter" === c.status &&
                    (mflBoxFranchise["fid_" + i.id].starter[c.id] = {
                      score: c.score,
                      gsr: c.gameSecondsRemaining,
                    }),
                  "nonstarter" === c.status &&
                    (mflBoxFranchise["fid_" + i.id].bench[c.id] = {
                      score: c.score,
                      gsr: c.gameSecondsRemaining,
                    }));
              }
            if (r[s].franchise[1].players.hasOwnProperty("player"))
              for (n = 0; n < r[s].franchise[1].players.player.length; n++) {
                if ("starter" === (c = r[s].franchise[1].players.player[n]).status) m = "1";
                else m = "0";
                if (
                  (void 0 === mflBox_players["pid_" + c.id]
                    ? ((mflBox_players["pid_" + c.id] = {
                        id: c.id,
                        fid: l.id,
                        score: c.score,
                        gameSecondsRemaining: parseInt(c.gameSecondsRemaining),
                        isStarter: m,
                      }),
                      (mflBox_player_fid_tracker[c.id + "_" + l.id] = 1))
                    : void 0 === mflBox_player_fid_tracker[c.id + "_" + l.id] &&
                      ((mflBox_players["pid_" + c.id].fid += "," + l.id),
                      (mflBox_players["pid_" + c.id].isStarter += "," + m),
                      (mflBox_player_fid_tracker[c.id + "_" + l.id] = 1)),
                  "1" === m)
                )
                  try {
                    void 0 === mflBoxFirstKickoff[r[s].franchise[1].id]
                      ? mflBoxNFLKickoff[playerDatabase["pid_" + c.id].team] > 0 &&
                        (mflBoxFirstKickoff[r[s].franchise[1].id] =
                          mflBoxNFLKickoff[playerDatabase["pid_" + c.id].team])
                      : mflBoxNFLKickoff[playerDatabase["pid_" + c.id].team] > 0 &&
                        mflBoxNFLKickoff[playerDatabase["pid_" + c.id].team] <
                          mflBoxFirstKickoff[r[s].franchise[1].id] &&
                        (mflBoxFirstKickoff[r[s].franchise[1].id] =
                          mflBoxNFLKickoff[playerDatabase["pid_" + c.id].team]);
                  } catch (e) {
                    console.log("error home");
                  }
                (void 0 === mflBoxFranchise["fid_" + l.id] &&
                  (mflBoxFranchise["fid_" + l.id] = { starter: {}, bench: {}, tiebreaker: {} }),
                  "starter" === c.status &&
                    (mflBoxFranchise["fid_" + l.id].starter[c.id] = {
                      score: c.score,
                      gsr: c.gameSecondsRemaining,
                    }),
                  "nonstarter" === c.status &&
                    (mflBoxFranchise["fid_" + l.id].bench[c.id] = {
                      score: c.score,
                      gsr: c.gameSecondsRemaining,
                    }));
              }
          } catch (e) {
            try {
              if (mflBoxActiveWeek <= completedWeek) {
                ((i = r[s].franchise[0]), (l = r[s].franchise[1]));
                try {
                  for (var f = 0; f < r[s].franchise[0].player.length; f++) {
                    var c = r[s].franchise[0].player[f];
                    (void 0 === mflBoxFranchise["fid_" + i.id] &&
                      (mflBoxFranchise["fid_" + i.id] = { starter: {}, bench: {}, tiebreaker: {} }),
                      "starter" === c.status &&
                        (mflBoxFranchise["fid_" + i.id].starter[c.id] = { score: c.score, gsr: 0 }),
                      "nonstarter" === c.status &&
                        (mflBoxFranchise["fid_" + i.id].bench[c.id] = { score: c.score, gsr: 0 }));
                  }
                } catch (e) {}
                try {
                  for (f = 0; f < r[s].franchise[1].player.length; f++) {
                    c = r[s].franchise[1].player[f];
                    (void 0 === mflBoxFranchise["fid_" + l.id] &&
                      (mflBoxFranchise["fid_" + l.id] = { starter: {}, bench: {}, tiebreaker: {} }),
                      "starter" === c.status &&
                        (mflBoxFranchise["fid_" + l.id].starter[c.id] = { score: c.score, gsr: 0 }),
                      "nonstarter" === c.status &&
                        (mflBoxFranchise["fid_" + l.id].bench[c.id] = { score: c.score, gsr: 0 }));
                  }
                } catch (e) {}
              }
            } catch (e) {}
          }
        }
      } else if (
        mflBoxJSON_matchups &&
        mflBoxJSON_matchups.franchise &&
        mflBoxJSON_matchups.franchise.length
      ) {
        mflBoxIsAllPlay = !0;
        for (l = null, s = 0; s < mflBoxJSON_matchups.franchise.length; s++)
          if (mflBoxAllPlayId === mflBoxJSON_matchups.franchise[s].id) {
            l = mflBoxJSON_matchups.franchise[s];
            break;
          }
        if (l) {
          var d = 0;
          for (s = 0; s < mflBoxJSON_matchups.franchise.length; s++) {
            if (mflBoxAllPlayId !== mflBoxJSON_matchups.franchise[s].id) {
              i = mflBoxJSON_matchups.franchise[s];
              ((mflBox_matchups[d] = {
                roadId: i.id,
                homeId: l.id,
                roadScore: i.score,
                homeScore: l.score,
                roadProjected: 0,
                homeProjected: 0,
                roadYetToPlay: 0,
                homeYetToPlay: 0,
                roadCurrentlyPlaying: 0,
                homeCurrentlyPlaying: 0,
                roadPlayerMinutesRemaining: 0,
                homePlayerMinutesRemaining: 0,
              }),
                (mflBox_matchups[d].roadSpread = ""),
                (mflBox_matchups[d].homeSpread = ""),
                (mflBox_matchups[d].roadResult = ""),
                (mflBox_matchups[d].homeResult = ""),
                mflBoxActiveWeek <= completedWeek &&
                  (parseFloat(i.score) > parseFloat(l.score) &&
                    (mflBox_matchups[d].roadResult = "W"),
                  parseFloat(l.score) > parseFloat(i.score) &&
                    (mflBox_matchups[d].homeResult = "W")),
                (mflBox_matchups[d].roadYetToPlay = parseInt(i.playersYetToPlay)),
                (mflBox_matchups[d].homeYetToPlay = parseInt(l.playersYetToPlay)),
                (mflBox_matchups[d].roadCurrentlyPlaying = parseInt(i.playersCurrentlyPlaying)),
                (mflBox_matchups[d].homeCurrentlyPlaying = parseInt(l.playersCurrentlyPlaying)),
                (mflBox_matchups[d].roadPlayerMinutesRemaining = parseInt(
                  parseInt(i.gameSecondsRemaining) / 60 + 0.99,
                )),
                (mflBox_matchups[d].homePlayerMinutesRemaining = parseInt(
                  parseInt(l.gameSecondsRemaining) / 60 + 0.99,
                )),
                d++);
            }
            try {
              for (n = 0; n < mflBoxJSON_matchups.franchise[s].players.player.length; n++) {
                i = mflBoxJSON_matchups.franchise[s];
                if ("starter" === (c = mflBoxJSON_matchups.franchise[s].players.player[n]).status)
                  m = "1";
                else m = "0";
                if (
                  (void 0 === mflBox_players["pid_" + c.id]
                    ? ((mflBox_players["pid_" + c.id] = {
                        id: c.id,
                        fid: i.id,
                        score: c.score,
                        gameSecondsRemaining: parseInt(c.gameSecondsRemaining),
                        isStarter: m,
                      }),
                      (mflBox_player_fid_tracker[c.id + "_" + i.id] = 1))
                    : void 0 === mflBox_player_fid_tracker[c.id + "_" + i.id] &&
                      ((mflBox_players["pid_" + c.id].fid += "," + i.id),
                      (mflBox_players["pid_" + c.id].isStarter += "," + m),
                      (mflBox_player_fid_tracker[c.id + "_" + i.id] = 1)),
                  "1" === m)
                )
                  try {
                    void 0 === mflBoxFirstKickoff[mflBoxJSON_matchups.franchise[s].id]
                      ? mflBoxNFLKickoff[playerDatabase["pid_" + c.id].team] > 0 &&
                        (mflBoxFirstKickoff[mflBoxJSON_matchups.franchise[s].id] =
                          mflBoxNFLKickoff[playerDatabase["pid_" + c.id].team])
                      : mflBoxNFLKickoff[playerDatabase["pid_" + c.id].team] > 0 &&
                        mflBoxNFLKickoff[playerDatabase["pid_" + c.id].team] <
                          mflBoxFirstKickoff[mflBoxJSON_matchups.franchise[s].id] &&
                        (mflBoxFirstKickoff[mflBoxJSON_matchups.franchise[s].id] =
                          mflBoxNFLKickoff[playerDatabase["pid_" + c.id].team]);
                  } catch (e) {}
                (void 0 === mflBoxFranchise["fid_" + i.id] &&
                  (mflBoxFranchise["fid_" + i.id] = { starter: {}, bench: {}, tiebreaker: {} }),
                  "starter" === c.status &&
                    (mflBoxFranchise["fid_" + i.id].starter[c.id] = {
                      score: c.score,
                      gsr: c.gameSecondsRemaining,
                    }),
                  "nonstarter" === c.status &&
                    (mflBoxFranchise["fid_" + i.id].bench[c.id] = {
                      score: c.score,
                      gsr: c.gameSecondsRemaining,
                    }));
              }
            } catch (e) {
              try {
                if (mflBoxActiveWeek <= completedWeek)
                  for (
                    i = mflBoxJSON_matchups.franchise[s], f = 0;
                    f < mflBoxJSON_matchups.franchise[s].player.length;
                    f++
                  ) {
                    c = mflBoxJSON_matchups.franchise[s].player[f];
                    (void 0 === mflBoxFranchise["fid_" + i.id] &&
                      (mflBoxFranchise["fid_" + i.id] = { starter: {}, bench: {}, tiebreaker: {} }),
                      "starter" === c.status &&
                        (mflBoxFranchise["fid_" + i.id].starter[c.id] = { score: c.score, gsr: 0 }),
                      "nonstarter" === c.status &&
                        (mflBoxFranchise["fid_" + i.id].bench[c.id] = { score: c.score, gsr: 0 }));
                  }
              } catch (e) {}
            }
          }
          mflBox_matchups.sort(function (e, t) {
            return parseFloat(e.roadScore) < parseFloat(t.roadScore)
              ? 1
              : parseFloat(e.roadScore) > parseFloat(t.roadScore)
                ? -1
                : 0;
          });
        }
      }
    } else;
    if (
      !mflBoxIsAllPlay &&
      mflBoxShowMFLByeTeams &&
      mflBoxJSON_matchups &&
      mflBoxJSON_matchups.hasOwnProperty("franchise")
    ) {
      if (mflBoxJSON_matchups.franchise.hasOwnProperty("id"))
        (p = { franchise: [] }).franchise.push(mflBoxJSON_matchups.franchise);
      else var p = mflBoxJSON_matchups;
      for (s = 0; s < p.franchise.length; s++) {
        ((d = mflBox_matchups.length), (i = p.franchise[s]));
        ((mflBox_matchups[d] = {
          roadId: i.id,
          homeId: "BYE",
          roadScore: i.score,
          homeScore: 0,
          roadProjected: 0,
          homeProjected: 0,
          roadYetToPlay: 0,
          homeYetToPlay: 0,
          roadCurrentlyPlaying: 0,
          homeCurrentlyPlaying: 0,
          roadPlayerMinutesRemaining: 0,
          homePlayerMinutesRemaining: 0,
        }),
          (mflBox_matchups[d].roadSpread = ""),
          (mflBox_matchups[d].homeSpread = ""),
          (mflBox_matchups[d].roadResult = ""),
          (mflBox_matchups[d].homeResult = ""),
          (mflBox_matchups[d].roadYetToPlay = parseInt(i.playersYetToPlay)),
          (mflBox_matchups[d].homeYetToPlay = 0),
          (mflBox_matchups[d].roadCurrentlyPlaying = parseInt(i.playersCurrentlyPlaying)),
          (mflBox_matchups[d].homeCurrentlyPlaying = 0),
          (mflBox_matchups[d].roadPlayerMinutesRemaining = parseInt(
            parseInt(i.gameSecondsRemaining) / 60 + 0.99,
          )),
          (mflBox_matchups[d].homePlayerMinutesRemaining = 0),
          d++);
        try {
          for (n = 0; n < p.franchise[s].players.player.length; n++) {
            if ("starter" === (c = p.franchise[s].players.player[n]).status) m = "1";
            else m = "0";
            if (
              (void 0 === mflBox_players["pid_" + c.id]
                ? ((mflBox_players["pid_" + c.id] = {
                    id: c.id,
                    fid: i.id,
                    score: c.score,
                    gameSecondsRemaining: parseInt(c.gameSecondsRemaining),
                    isStarter: m,
                  }),
                  (mflBox_player_fid_tracker[c.id + "_" + i.id] = 1))
                : void 0 === mflBox_player_fid_tracker[c.id + "_" + i.id] &&
                  ((mflBox_players["pid_" + c.id].fid += "," + i.id),
                  (mflBox_players["pid_" + c.id].isStarter += "," + m),
                  (mflBox_player_fid_tracker[c.id + "_" + i.id] = 1)),
              "1" === m)
            )
              try {
                void 0 === mflBoxFirstKickoff[p.franchise[s].id]
                  ? mflBoxNFLKickoff[playerDatabase["pid_" + c.id].team] > 0 &&
                    (mflBoxFirstKickoff[p.franchise[s].id] =
                      mflBoxNFLKickoff[playerDatabase["pid_" + c.id].team])
                  : mflBoxNFLKickoff[playerDatabase["pid_" + c.id].team] > 0 &&
                    mflBoxNFLKickoff[playerDatabase["pid_" + c.id].team] <
                      mflBoxFirstKickoff[p.franchise[s].id] &&
                    (mflBoxFirstKickoff[p.franchise[s].id] =
                      mflBoxNFLKickoff[playerDatabase["pid_" + c.id].team]);
              } catch (e) {}
            (void 0 === mflBoxFranchise["fid_" + i.id] &&
              (mflBoxFranchise["fid_" + i.id] = { starter: {}, bench: {}, tiebreaker: {} }),
              "starter" === c.status &&
                (mflBoxFranchise["fid_" + i.id].starter[c.id] = {
                  score: c.score,
                  gsr: c.gameSecondsRemaining,
                }),
              "nonstarter" === c.status &&
                (mflBoxFranchise["fid_" + i.id].bench[c.id] = {
                  score: c.score,
                  gsr: c.gameSecondsRemaining,
                }));
          }
        } catch (e) {
          try {
            if (mflBoxActiveWeek <= completedWeek)
              for (i = p.franchise[s], f = 0; f < p.franchise[s].player.length; f++) {
                c = p.franchise[s].player[f];
                (void 0 === mflBoxFranchise["fid_" + i.id] &&
                  (mflBoxFranchise["fid_" + i.id] = { starter: {}, bench: {}, tiebreaker: {} }),
                  "starter" === c.status &&
                    (mflBoxFranchise["fid_" + i.id].starter[c.id] = { score: c.score, gsr: 0 }),
                  "nonstarter" === c.status &&
                    (mflBoxFranchise["fid_" + i.id].bench[c.id] = { score: c.score, gsr: 0 }));
              }
          } catch (e) {}
        }
      }
    }
    var x = [];
    if (!mflBoxJSON_nflSchedule || !mflBoxJSON_nflSchedule.matchup) return !0;
    void 0 === mflBoxJSON_nflSchedule.matchup.length
      ? ((x.matchup = []), x.matchup.push(mflBoxJSON_nflSchedule.matchup))
      : (x = mflBoxJSON_nflSchedule);
    for (n = 0; n < 3; n++)
      for (s = 0; s < x.matchup.length; s++) {
        ((i = x.matchup[s].team[0]), (l = x.matchup[s].team[1]));
        switch (n) {
          case 0:
            if ("INPROG" !== mflBoxNflGameStatus[l.id].status) continue;
            break;
          case 1:
            if ("SCHED" !== mflBoxNflGameStatus[l.id].status) continue;
            break;
          case 2:
            if ("OVER" !== mflBoxNflGameStatus[l.id].status) continue;
        }
        if (parseFloat(i.spread) < 0) var B = parseFloat(i.spread).toFixed(1);
        else B = "";
        if (parseFloat(l.spread) < 0) var h = parseFloat(l.spread).toFixed(1);
        else h = "";
        (mflBoxActiveWeek > liveScoringWeek &&
          mflBoxActiveWeek > completedWeek + 1 &&
          ((h = ""), (B = "")),
          mflBox_nflSchedule.push({
            roadId: i.id,
            homeId: l.id,
            roadScore: mflBoxLiveStatsTeam[i.id].TPS,
            homeScore: mflBoxLiveStatsTeam[l.id].TPS,
            roadSpread: B,
            homeSpread: h,
            roadResult: mflBoxLiveStatsTeam[i.id].RES,
            homeResult: mflBoxLiveStatsTeam[l.id].RES,
            kickoff: mflBoxNflGameStatus[l.id].kickoff,
            gameSecondsRemaining: mflBoxNflGameStatus[l.id].secs_left,
            clock: mflBoxNflGameStatus[l.id].clock,
            roadPossession: mflBoxNflGameStatus[i.id].possession,
            roadRedzone: mflBoxNflGameStatus[i.id].redzone,
            roadDownAndDist: mflBoxNflGameStatus[i.id].down_and_dist,
            homePossession: mflBoxNflGameStatus[l.id].possession,
            homeRedzone: mflBoxNflGameStatus[l.id].redzone,
            homeDownAndDist: mflBoxNflGameStatus[l.id].down_and_dist,
          }),
          0 === mflBoxCurrentWeekKickoff &&
            (mflBoxCurrentWeekKickoff = parseInt(x.matchup[s].kickoff)),
          0 === s && (mflBoxActiveWeekKickoff = parseInt(x.matchup[s].kickoff)),
          (mflBox_nflOpponents[i.id] = {
            opponent: l.id,
            isHome: !1,
            score: mflBoxLiveStatsTeam[i.id].TPS,
            result: mflBoxLiveStatsTeam[i.id].RES,
          }),
          (mflBox_nflOpponents[l.id] = {
            opponent: i.id,
            isHome: !0,
            score: mflBoxLiveStatsTeam[l.id].TPS,
            result: mflBoxLiveStatsTeam[l.id].RES,
          }));
      }
    return !0;
  }
  function doMFLBoxArrows() {
    mflBoxMFLSchedule && mflBoxActiveWeek > mflBoxEndWeek && (mflBoxActiveWeek = mflBoxEndWeek);
    const e = el$("MFLBoxWeekCell");
    e && (e.textContent = "Wk " + mflBoxActiveWeek);
    const t = els$(".MFLBoxArrowLeft"),
      a = els$(".MFLBoxArrowRight"),
      setFaded = (e, t) => e.forEach((e) => e.classList.toggle("MFLBoxArrowFaded", t));
    setFaded(
      t,
      mflBoxMFLSchedule ? !(mflBoxActiveWeek > mflBoxStartWeek) : !(mflBoxActiveWeek > 1),
    );
    const o = document.querySelector("#mflBoxButtonMFL.mflBoxButtonFaded"),
      r = document.querySelector("#mflBoxButtonNFL.mflBoxButtonFaded");
    if (o) {
      setFaded(a, !1);
      let e = !1;
      try {
        const t = mflBoxActiveWeek + 1,
          o = "w_" + t,
          r = reportNflSchedule_ar?.[o]?.nflSchedule;
        (r &&
          parseInt(r.week, 10) === t &&
          (Array.isArray(r.matchup)
            ? (e = r.matchup.length > 0)
            : r.matchup && Array.isArray(r.matchup.team) && (e = r.matchup.team.length > 0)),
          setFaded(a, !e));
      } catch (e) {
        (console.log("No Schedule For NFL Week Requested"), setFaded(a, !0));
      }
    } else r && (mflBoxActiveWeek >= endWeek ? setFaded(a, !0) : setFaded(a, !1));
  }
  function mflBoxExpand(e, t) {
    t
      ? (jQuery(".MFLExtras_" + e).show(),
        jQuery("#mflBoxCollapse_" + e).show(),
        jQuery("#mflBoxExpand_" + e).hide(),
        (mflBoxDetailsTracker[e] = t))
      : (jQuery(".MFLExtras_" + e).hide(),
        jQuery("#mflBoxCollapse_" + e).hide(),
        jQuery("#mflBoxExpand_" + e).show(),
        (mflBoxDetailsTracker[e] = t));
  }
  function mflBoxPopulateTiebreaker(e) {
    for (var t in ((mflBoxTiebreaker = {}), franchiseDatabase))
      franchiseDatabase.hasOwnProperty(t) &&
        parseInt(franchiseDatabase[t].id) > 0 &&
        (mflBoxTiebreaker[t] = {});
    try {
      for (var a = 0; a < e.matchup.length; a++) {
        var o = e.matchup[a].franchise[0],
          r = e.matchup[a].franchise[1];
        if (void 0 !== o.tiebreaker && 0 !== o.tiebreaker.length)
          for (var s = o.tiebreaker.split(","), i = 0; i < s.length; i++)
            parseInt(s[i]) > 0 && (mflBoxTiebreaker["fid_" + o.id]["pid_" + s[i]] = 1);
        if (void 0 !== r.tiebreaker && 0 !== r.tiebreaker.length)
          for (s = r.tiebreaker.split(","), i = 0; i < s.length; i++)
            parseInt(s[i]) > 0 && (mflBoxTiebreaker["fid_" + r.id]["pid_" + s[i]] = 1);
      }
    } catch (t) {
      try {
        ((o = e.matchup.franchise[0]), (r = e.matchup.franchise[1]));
        if (void 0 !== o.tiebreaker && 0 !== o.tiebreaker.length)
          for (s = o.tiebreaker.split(","), i = 0; i < s.length; i++)
            parseInt(s[i]) > 0 && (mflBoxTiebreaker["fid_" + o.id]["pid_" + s[i]] = 1);
        if (void 0 !== r.tiebreaker && 0 !== r.tiebreaker.length)
          for (s = r.tiebreaker.split(","), i = 0; i < s.length; i++)
            parseInt(s[i]) > 0 && (mflBoxTiebreaker["fid_" + r.id]["pid_" + s[i]] = 1);
      } catch (t) {
        for (a = 0; a < e.franchise.length; a++) {
          if (mflBoxAllPlayId !== e.franchise[a].id)
            if (void 0 !== (o = e.franchise[a]).tiebreaker && 0 !== o.tiebreaker.length)
              for (s = o.tiebreaker.split(","), i = 0; i < s.length; i++)
                parseInt(s[i]) > 0 && (mflBoxTiebreaker["fid_" + o.id]["pid_" + s[i]] = 1);
        }
      }
    }
  }
  function mflBoxCheckLive() {
    return (
      mflBoxCurrentLiveScoring &&
      mflBoxActiveWeek === mflBoxCurrentWeek &&
      !liveScoringLiveWeek?.error
    );
  }
  function mflBoxCheckCompletedWeek() {
    return mflBoxActiveWeek <= completedWeek;
  }
  function mflBoxNewWeek(e) {
    if (($("#MFLBoxPlayerDetails").hide(), (mflBoxPlayerDetailsFid.fid = ""), e > 0)) {
      if (jQuery(".MFLBoxArrowRight").hasClass("MFLBoxArrowFaded")) return !1;
    } else if (e < 0 && jQuery(".MFLBoxArrowLeft").hasClass("MFLBoxArrowFaded")) return !1;
    ((mflBoxActiveWeek += e), doMFLBoxArrows(), doMFLBoxUpdate(!0));
  }
  function mflBoxGameClockMinutes(e) {
    var t = parseInt((60 * e) / 100),
      a = (60 * e) / 100 - parseInt((60 * e) / 100),
      o = parseInt(60 * a);
    return (o < 10 && (o = "0" + o), t + ":" + o);
  }
  function mflBoxGameClock(e, t) {
    if (0 === t || 3 === t) {
      if (3 === t) {
        if (0 === e) return "Final";
        if (0 === e) return "4th - 0:00";
      }
      return e < 25
        ? "4th - " + mflBoxGameClockMinutes(e)
        : 25 === e
          ? "4th - 15:00"
          : e < 50
            ? "3rd - " + mflBoxGameClockMinutes(e - 25)
            : 50 === e
              ? "Halftime"
              : e < 75
                ? "2nd - " + mflBoxGameClockMinutes(e - 50)
                : 75 === e
                  ? "2nd - 15:00"
                  : e < 100
                    ? "1st - " + mflBoxGameClockMinutes(e - 75)
                    : "1st - 15:00";
    }
    if (1 === t) {
      var a = new Date(1e3 * e);
      return mflBoxWeekDay[a.getDay()] + " " + mflBoxMonth[a.getMonth()] + " " + a.getDate();
    }
    if (2 === t) {
      if ((a = new Date(1e3 * e)).getHours() > 11) var o = "pm";
      else o = "am";
      if (a.getHours() > 12) var r = a.getHours() - 12;
      else r = a.getHours();
      0 === r && (r = 12);
      const t = a.getMinutes() < 10 ? "0" + a.getMinutes() : a.getMinutes();
      return mflBoxWeekDay[a.getDay()] + " " + r + ":" + t + o;
    }
  }
  function doMFLBoxLiveStatsClose() {
    $(".MFLBoxLiveStatsWrapper").attr("style", "display:none");
  }
  function doMFLBoxLiveStatsPopup(e, t) {
    ($(".MFLBoxLiveStatsWrapper").attr("style", "display:none"),
      $("#MFLBoxLiveStatsWrapper_" + e + "_" + t).removeAttr("style"));
    var a = mflBoxGetStatsStr(t);
    ("" === a && (a = "no stats"),
      $("#MFLBoxLiveStatsContent_" + e + "_" + t).html(
        a + '<span class="MFLBoxLiveStatsClose" onclick="doMFLBoxLiveStatsClose()"></span>',
      ));
  }
  function mflBoxGetStatsStr(e) {
    var t = [];
    if (null == mflBoxLiveStatsPlayer[e]) return "";
    if (mflBoxLiveStatsPlayer[e].PA > 0) {
      var a = [];
      (void 0 === mflBoxLiveStatsPlayer[e].PC && (mflBoxLiveStatsPlayer[e].PC = 0),
        void 0 === mflBoxLiveStatsPlayer[e].PY && (mflBoxLiveStatsPlayer[e].PY = 0),
        a.push(
          "Pass: " +
            mflBoxLiveStatsPlayer[e].PC +
            "-" +
            mflBoxLiveStatsPlayer[e].PA +
            "-" +
            mflBoxLiveStatsPlayer[e].PY,
        ),
        mflBoxLiveStatsPlayer[e]["#P"] > 0 &&
          a.push(mflBoxLiveStatsPlayer[e]["#P"] + " PaTD (" + mflBoxLiveStatsPlayer[e].PS + ")"),
        mflBoxLiveStatsPlayer[e].IN > 0 && a.push(mflBoxLiveStatsPlayer[e].IN + " Int"),
        mflBoxLiveStatsPlayer[e].P2 > 0 && a.push(mflBoxLiveStatsPlayer[e].P2 + " Pa2P"),
        t.push(a.join(", ")));
    }
    if (mflBoxLiveStatsPlayer[e].RA > 0) {
      a = [];
      (void 0 === mflBoxLiveStatsPlayer[e].RY && (mflBoxLiveStatsPlayer[e].RY = 0),
        a.push("Rush: " + mflBoxLiveStatsPlayer[e].RA + "-" + mflBoxLiveStatsPlayer[e].RY),
        mflBoxLiveStatsPlayer[e]["#R"] > 0 &&
          a.push(mflBoxLiveStatsPlayer[e]["#R"] + " RuTD (" + mflBoxLiveStatsPlayer[e].RS + ")"),
        mflBoxLiveStatsPlayer[e].R2 > 0 && a.push(mflBoxLiveStatsPlayer[e].R2 + " Ru2P"),
        t.push(a.join(", ")));
    }
    if (mflBoxLiveStatsPlayer[e].CC > 0) {
      a = [];
      (void 0 === mflBoxLiveStatsPlayer[e].CY && (mflBoxLiveStatsPlayer[e].CY = 0),
        a.push("Rec: " + mflBoxLiveStatsPlayer[e].CC + "-" + mflBoxLiveStatsPlayer[e].CY),
        mflBoxLiveStatsPlayer[e]["#C"] > 0 &&
          a.push(mflBoxLiveStatsPlayer[e]["#C"] + " ReTD (" + mflBoxLiveStatsPlayer[e].RC + ")"),
        mflBoxLiveStatsPlayer[e].C2 > 0 && a.push(mflBoxLiveStatsPlayer[e].C2 + " Re2P"),
        t.push(a.join(", ")));
    }
    if (
      (mflBoxLiveStatsPlayer[e].FL > 0 && t.push(mflBoxLiveStatsPlayer[e].FL + " Fum Lost"),
      mflBoxLiveStatsPlayer[e].TK > 0 ||
        mflBoxLiveStatsPlayer[e].AS > 0 ||
        mflBoxLiveStatsPlayer[e].PD > 0)
    ) {
      a = [];
      if (
        (mflBoxLiveStatsPlayer[e].TK > 0 && a.push(mflBoxLiveStatsPlayer[e].TK + " T"),
        mflBoxLiveStatsPlayer[e].TFL > 0 && a.push(mflBoxLiveStatsPlayer[e].TKL + " TFL"),
        mflBoxLiveStatsPlayer[e].AS > 0 && a.push(mflBoxLiveStatsPlayer[e].AS + " A"),
        mflBoxLiveStatsPlayer[e].SK > 0 && a.push(mflBoxLiveStatsPlayer[e].SK + " SK"),
        mflBoxLiveStatsPlayer[e].PD > 0 && a.push(mflBoxLiveStatsPlayer[e].PD + " PD"),
        mflBoxLiveStatsPlayer[e].IC > 0)
      ) {
        var o = mflBoxLiveStatsPlayer[e].IC + " INT";
        (mflBoxLiveStatsPlayer[e]["#IR"] > 0 &&
          (o =
            o +
            " " +
            mflBoxLiveStatsPlayer[e]["#IR"] +
            " IntTD (" +
            mflBoxLiveStatsPlayer[e].IR +
            ")"),
          a.push(o));
      }
      if (
        (mflBoxLiveStatsPlayer[e].FF > 0 && a.push(mflBoxLiveStatsPlayer[e].FF + " FF"),
        mflBoxLiveStatsPlayer[e].FC > 0)
      ) {
        o = mflBoxLiveStatsPlayer[e].FC + " FR";
        (mflBoxLiveStatsPlayer[e]["#DR"] > 0 &&
          (o =
            o +
            " " +
            mflBoxLiveStatsPlayer[e]["#DR"] +
            " FRTD (" +
            mflBoxLiveStatsPlayer[e].DR +
            ")"),
          a.push(o));
      }
      t.push(a.join(", "));
    }
    if (mflBoxLiveStatsPlayer[e]["#A"] > 0 || mflBoxLiveStatsPlayer[e].EA > 0) {
      ((a = []), (o = "Kick: "));
      if (mflBoxLiveStatsPlayer[e]["#A"] > 0) {
        var r = "";
        (void 0 === mflBoxLiveStatsPlayer[e]["#F"] && (mflBoxLiveStatsPlayer[e]["#F"] = 0),
          void 0 !== mflBoxLiveStatsPlayer[e].FG && (r = "(" + mflBoxLiveStatsPlayer[e].FG + ")"),
          a.push(
            o + mflBoxLiveStatsPlayer[e]["#F"] + "-" + mflBoxLiveStatsPlayer[e]["#A"] + " FG " + r,
          ),
          (o = ""));
      }
      (mflBoxLiveStatsPlayer[e].EA > 0 &&
        (void 0 === mflBoxLiveStatsPlayer[e].EP && (mflBoxLiveStatsPlayer[e].EP = 0),
        a.push(o + mflBoxLiveStatsPlayer[e].EP + "-" + mflBoxLiveStatsPlayer[e].EA + " XP"),
        (o = "")),
        t.push(a.join(", ")));
    }
    return t.join("; ");
  }
  function mflBoxGetTeamStatsStr(e) {
    for (var t = [], a = 0; a < show_tstats.length; a++) {
      var o = show_tstats[a];
      void 0 !== mflBoxLiveStatsTeam[e][o] &&
        0 !== mflBoxLiveStatsTeam[e][o] &&
        t.push(mflBoxLiveStatsTeam[e][o] + " " + o);
    }
    return (
      mflBoxLiveStatsTeam[e].FC > 0 &&
        (t.push(mflBoxLiveStatsTeam[e].FC + " FR"),
        mflBoxLiveStatsTeam[e]["#DR"] > 0 &&
          t.push(mflBoxLiveStatsTeam[e]["#DR"] + " FR TD (" + mflBoxLiveStatsTeam[e].DR + ")")),
      mflBoxLiveStatsTeam[e].IC > 0 &&
        (t.push(mflBoxLiveStatsTeam[e].IC + " Int"),
        mflBoxLiveStatsTeam[e]["#IR"] > 0 &&
          t.push(mflBoxLiveStatsTeam[e]["#IR"] + " Int TD (" + mflBoxLiveStatsTeam[e].IR + ")")),
      mflBoxLiveStatsTeam[e]["#KT"] > 0 &&
        t.push(mflBoxLiveStatsTeam[e]["#KT"] + " KTD (" + mflBoxLiveStatsTeam[e].KO + ")"),
      mflBoxLiveStatsTeam[e]["#UT"] > 0 &&
        t.push(mflBoxLiveStatsTeam[e]["#UT"] + " PTD (" + mflBoxLiveStatsTeam[e].PR + ")"),
      mflBoxLiveStatsTeam[e].BLF > 0 &&
        (t.push(mflBoxLiveStatsTeam[e].BLF + " BLF"),
        mflBoxLiveStatsTeam[e]["#BF"] > 0 &&
          t.push(mflBoxLiveStatsTeam[e]["#BF"] + " BF (" + mflBoxLiveStatsTeam[e].BF + ")")),
      mflBoxLiveStatsTeam[e].BLP > 0 &&
        (t.push(mflBoxLiveStatsTeam[e].BLP + " BLP"),
        mflBoxLiveStatsTeam[e]["#BP"] > 0 &&
          t.push(mflBoxLiveStatsTeam[e]["#BP"] + " BP (" + mflBoxLiveStatsTeam[e].BP + ")")),
      mflBoxLiveStatsTeam[e].BLE > 0 && t.push(mflBoxLiveStatsTeam[e].BLE + " BLE"),
      t.join(", ")
    );
  }
  function mflBoxNflGameTime(e) {
    var t = new Date(1e3 * parseInt(e)),
      a = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][t.getDay()],
      o = t.getHours();
    if (o >= 12) var r = "pm";
    else r = "am";
    return (
      0 === o ? (o = 12) : o > 12 && (o -= 12),
      a + " " + o + ":" + ("0" + t.getMinutes()).substr(-2) + r
    );
  }
  function mflBoxParseLiveStats(e, t) {
    if (((mflBoxLiveStatsPlayer = {}), (mflBoxLiveStatsTeam = {}), "CACHE" === e))
      ((lsm_last_update_secs = lsm_last_update_secs_first),
        "function" == typeof structuredClone
          ? ((mflBoxLiveStatsPlayer = structuredClone(lsm_stats)),
            (mflBoxLiveStatsTeam = structuredClone(lsm_tstats)))
          : ((mflBoxLiveStatsPlayer = JSON.parse(JSON.stringify(lsm_stats))),
            (mflBoxLiveStatsTeam = JSON.parse(JSON.stringify(lsm_tstats)))));
    else {
      const t = e.split("\n"),
        a = t.length;
      for (let e = 0; e < a; e++) {
        const a = t[e];
        if (!a) continue;
        const o = a.split("|"),
          r = o[0];
        if ("DATE" === r) {
          ((lsm_last_update_secs = o[1]), (ls_last_update = o[2]));
          continue;
        }
        if ("REFRESH" === r) continue;
        let s;
        "" === r || isNaN(r)
          ? (mflBoxLiveStatsTeam[r] || (mflBoxLiveStatsTeam[r] = {}), (s = mflBoxLiveStatsTeam[r]))
          : (mflBoxLiveStatsPlayer[r] || (mflBoxLiveStatsPlayer[r] = {}),
            (s = mflBoxLiveStatsPlayer[r]));
        for (let e = 1; e < o.length; e++) {
          const t = o[e].indexOf(" ");
          t > 0 && (s[o[e].slice(0, t)] = o[e].slice(t + 1));
        }
      }
    }
    for (var a in mflBoxNflGameStatus)
      if (
        (mflBoxLiveStatsTeam[a] || (mflBoxLiveStatsTeam[a] = {}),
        (mflBoxNFLKickoff[a] = mflBoxNflGameStatus[a].time),
        0 === mflBoxNflGameStatus[a].time)
      )
        ((mflBoxNflGameStatus[a].clock = "BYE"),
          (mflBoxNflGameStatus[a].secs_left = 0),
          (mflBoxNflGameStatus[a].status = "BYE"),
          (mflBoxLiveStatsTeam[a].TPS = ""),
          (mflBoxLiveStatsTeam[a].TPA = ""));
      else if (mflBoxNflGameStatus[a].time > lsm_last_update_secs)
        ((mflBoxNflGameStatus[a].clock = mflBoxNflGameTime(mflBoxNflGameStatus[a].time)),
          (mflBoxNflGameStatus[a].secs_left = 3600),
          (mflBoxNflGameStatus[a].status = "SCHED"),
          (mflBoxLiveStatsTeam[a].TPS = ""),
          (mflBoxLiveStatsTeam[a].TPA = ""));
      else
        try {
          if (
            (void 0 === mflBoxLiveStatsTeam[a].TPS && (mflBoxLiveStatsTeam[a].TPS = 0),
            void 0 === mflBoxLiveStatsTeam[mflBoxLiveStatsTeam[a].OPP]?.TPS &&
              (mflBoxLiveStatsTeam[a].TPA = 0),
            "" === mflBoxLiveStatsTeam[a].QUARTER || "F" === mflBoxLiveStatsTeam[a].QUARTER)
          )
            ((mflBoxNflGameStatus[a].secs_left = 0), (mflBoxNflGameStatus[a].status = "OVER"));
          else {
            mflBoxNflGameStatus[a].status = "INPROG";
            const e = mflBoxLiveStatsTeam[a].REMAINING.split(":");
            let t;
            ((mflBoxNflGameStatus[a].secs_left = 60 * e[0] + Number(e[1])),
              "O" === mflBoxLiveStatsTeam[a].QUARTER || mflBoxLiveStatsTeam[a].QUARTER > 4
                ? (t = "OT")
                : "H" === mflBoxLiveStatsTeam[a].QUARTER
                  ? ((t = "H"), (mflBoxNflGameStatus[a].secs_left += 1800), (custom_is_half = !0))
                  : ((mflBoxNflGameStatus[a].secs_left +=
                      900 * (4 - mflBoxLiveStatsTeam[a].QUARTER)),
                    (t = mflBoxLiveStatsTeam[a].QUARTER + "Q")),
              (mflBoxNflGameStatus[a].clock = t + "&nbsp;" + mflBoxLiveStatsTeam[a].REMAINING));
            let o = parseInt(mflBoxLiveStatsTeam[a].DOWN);
            (isNaN(o) || 0 === o) && (o = 1);
            ((o += ["", "st", "nd", "rd", "th"][o] || "th"),
              (mflBoxNflGameStatus[a].possession = !1),
              (mflBoxNflGameStatus[a].redzone = !1),
              (mflBoxNflGameStatus[a].down_and_dist = ""));
            const r = mflBoxLiveStatsTeam[a].YARDLINE,
              s = mflBoxLiveStatsTeam[a].TOGO;
            if (r) {
              const e = r.split(":");
              let t = e[0],
                i = Number(e[1]);
              ("50" === t && ((t = ""), (i = 50)),
                s &&
                  ((mflBoxNflGameStatus[a].down_and_dist =
                    `${o}&nbsp;and&nbsp;${s} at ${t}&nbsp;${i}`),
                  mflBoxLiveStatsTeam[a].POSSESSION > 0 &&
                    ((mflBoxNflGameStatus[a].possession = !0),
                    t !== a && i < 20 && (mflBoxNflGameStatus[a].redzone = !0))));
            }
          }
        } catch (e) {}
  }
  function getMFLBoxNameIcon(e) {
    return "BYE" === e
      ? '<span class="mflBoxBye">BYE</span>'
      : "AVG" === e
        ? '<span class="mflBoxAvg">AVG</span>'
        : mflBoxUseAbbrev &&
            "" !== franchiseDatabase["fid_" + e].abbrev &&
            "" !== mflBoxIconBase &&
            "" !== mflBoxIconExt
          ? '<img src="' +
            mflBoxIconBase +
            e +
            "." +
            mflBoxIconExt +
            '" title="' +
            franchiseDatabase["fid_" + e].name +
            '" style="vertical-align:middle" /> <span style="vertical-align:middle">' +
            franchiseDatabase["fid_" + e].abbrev +
            "</span>"
          : mflBoxUseAbbrev &&
              "" !== franchiseDatabase["fid_" + e].abbrev &&
              mflBoxUseIcon &&
              "" !== franchiseDatabase["fid_" + e].icon
            ? '<img src="' +
              franchiseDatabase["fid_" + e].icon +
              '" title="' +
              franchiseDatabase["fid_" + e].name +
              '" style="vertical-align:middle" /> <span style="vertical-align:middle">' +
              franchiseDatabase["fid_" + e].abbrev +
              "</span>"
            : mflBoxUseAbbrev &&
                "" !== franchiseDatabase["fid_" + e].abbrev &&
                mflBoxUseLogo &&
                "" !== franchiseDatabase["fid_" + e].logo
              ? '<img src="' +
                franchiseDatabase["fid_" + e].logo +
                '" title="' +
                franchiseDatabase["fid_" + e].name +
                '" style="vertical-align:middle" /> <span style="vertical-align:middle">' +
                franchiseDatabase["fid_" + e].abbrev +
                "</span>"
              : "" !== mflBoxIconBase && "" !== mflBoxIconExt
                ? '<img src="' +
                  mflBoxIconBase +
                  e +
                  "." +
                  mflBoxIconExt +
                  '" title="' +
                  franchiseDatabase["fid_" + e].name +
                  '" />'
                : mflBoxUseIcon && "" !== franchiseDatabase["fid_" + e].icon
                  ? '<img src="' +
                    franchiseDatabase["fid_" + e].icon +
                    '" title="' +
                    franchiseDatabase["fid_" + e].name +
                    '" />'
                  : mflBoxUseLogo && "" !== franchiseDatabase["fid_" + e].logo
                    ? '<img src="' +
                      franchiseDatabase["fid_" + e].logo +
                      '" title="' +
                      franchiseDatabase["fid_" + e].name +
                      '" />'
                    : mflBoxUseAbbrev && "" !== franchiseDatabase["fid_" + e].abbrev
                      ? '<span title="' +
                        franchiseDatabase["fid_" + e].name +
                        '">' +
                        franchiseDatabase["fid_" + e].abbrev +
                        "</span>"
                      : franchiseDatabase["fid_" + e].name;
  }
  function getMFLBoxNFLIcon(e) {
    return "" !== mflBoxNFLLogoPath && "" !== mflBoxNFLLogoExt
      ? '<img src="' +
          mflBoxNFLLogoPath +
          e +
          "." +
          mflBoxNFLLogoExt +
          '" title="' +
          e +
          '" style="vertical-align:middle;max-height:1rem;max-width:1.25rem" />'
      : e;
  }
  function mflBoxPlayerDetailsClose() {
    ($("#MFLBoxOverlay").hide(), $("#MFLBoxPlayerDetails").hide());
    const e = document.querySelector("#MFLBoxPlayerDetails");
    try {
      bodyScrollLock.enableBodyScroll(e);
    } catch (e) {}
    mflBoxPlayerDetailsFid.fid = "";
  }
  function doMFLBoxPlayerDetails(e, t) {
    ((mflBoxPlayerDetailsFid.fid = e), (mflBoxPlayerDetailsFid.boxid = t));
    var a = "";
    a +=
      '<table align="center" cellspacing="1" class="report" id="MFLBoxPlayerDetailsTable"><caption><span>' +
      franchiseDatabase["fid_" + e].name +
      '</span><span class="MFLBoxPlayerDetailsClose" onclick="mflBoxPlayerDetailsClose()">X</span></caption>';
    for (var o = 0; o < 4; o++)
      if (
        (3 !== o || mflBoxShowNonStarter) &&
        ((0 !== o && 1 !== o) ||
          !(liveScoringWeek === completedWeek || mflBoxActiveWeek < liveScoringWeek))
      ) {
        var r = "";
        (0 === o &&
          (a +=
            '<tr class="MFLBoxPlayerDetailsHeader"><th colspan="5">Players Games In Progress</th></tr>'),
          1 === o &&
            (a +=
              '<tr class="MFLBoxPlayerDetailsHeader"><th colspan="5">Players Games Scheduled</th></tr>'),
          2 === o &&
            (a +=
              '<tr class="MFLBoxPlayerDetailsHeader"><th colspan="5">Players Games Over</th></tr>'),
          3 === o &&
            (a += '<tr class="MFLBoxPlayerDetailsHeader"><th colspan="5">Bench Player</th></tr>'));
        for (var s = 0, i = 0; i < mflBoxPositionSort.length; i++)
          try {
            if (3 === o) var l = mflBoxFranchise["fid_" + e].bench;
            else l = mflBoxFranchise["fid_" + e].starter;
            for (var n in l)
              if (playerDatabase["pid_" + n].position === mflBoxPositionSort[i]) {
                var m = !1;
                mflBox_byeWeek[playerDatabase["pid_" + n].team] === mflBoxActiveWeek && (m = !0);
                var f = !1;
                if (
                  !m &&
                  (0 === o || 3 === o) &&
                  parseInt(l[n].gsr) > 0 &&
                  parseInt(l[n].gsr) < 3600
                ) {
                  var c = mflBoxGameClock((parseInt(l[n].gsr) / 3600) * 100, 3),
                    d =
                      '<span class="MFLBoxLiveStatsScore" onmouseout="doMFLBoxLiveStatsClose()" onmouseover="doMFLBoxLiveStatsPopup(\'' +
                      e +
                      "','" +
                      n +
                      "')\">" +
                      l[n].score +
                      '</span><span id="MFLBoxLiveStatsWrapper_' +
                      e +
                      "_" +
                      n +
                      '" class="MFLBoxLiveStatsWrapper" style="display:none"><span  id="MFLBoxLiveStatsContent_' +
                      e +
                      "_" +
                      n +
                      '" class="MFLBoxLiveStatsContent"></span><span class="MFLBoxLiveStatsArrow"></span></span>';
                  try {
                    if (
                      (x =
                        mflBoxPlayerProjected[n] * (parseInt(l[n].gsr) / 3600) +
                        parseFloat(l[n].score)) > mflBoxPlayerProjected[n]
                    )
                      var p =
                        '<span title="On Pace Points" class="MFLPaceScore MFLPaceScorePositive">' +
                        x.toFixed(precision) +
                        "</span>";
                    else
                      p =
                        '<span title="On Pace Points" class="MFLPaceScore MFLPaceScoreNegative">' +
                        x.toFixed(precision) +
                        "</span>";
                  } catch (e) {
                    p = (0).toFixed(precision);
                  }
                  f = !0;
                }
                if (!m && (1 === o || 3 === o) && 3600 === parseInt(l[n].gsr)) {
                  ((c = mflBoxGameClock(mflBoxNFLKickoff[playerDatabase["pid_" + n].team], 2)),
                    (d = l[n].score));
                  try {
                    p =
                      '<span title="Projected Points" class="MFLPaceScore">' +
                      (x = mflBoxPlayerProjected[n].toFixed(precision)) +
                      "</span>";
                  } catch (e) {
                    p = (0).toFixed(precision);
                  }
                  f = !0;
                }
                if ((2 === o || 3 === o) && 0 === parseInt(l[n].gsr)) {
                  if (m) c = "--";
                  else
                    try {
                      c = mflBox_nflOpponents[playerDatabase["pid_" + n].team].result;
                    } catch (e) {
                      c = "";
                    }
                  if (m) d = "--";
                  else
                    var d =
                      '<span class="MFLBoxLiveStatsScore" style="cursor: pointer" onmouseout="doMFLBoxLiveStatsClose()" onmouseover="doMFLBoxLiveStatsPopup(\'' +
                      e +
                      "','" +
                      n +
                      "')\">" +
                      l[n].score +
                      '</span><span id="MFLBoxLiveStatsWrapper_' +
                      e +
                      "_" +
                      n +
                      '" class="MFLBoxLiveStatsWrapper" style="display:none"><span  id="MFLBoxLiveStatsContent_' +
                      e +
                      "_" +
                      n +
                      '" class="MFLBoxLiveStatsContent"></span><span class="MFLBoxLiveStatsArrow"></span></span>';
                  if (m) p = "--";
                  else
                    try {
                      var x;
                      p =
                        '<span title="Original Projection" class="MFLPaceScore">' +
                        (x = mflBoxPlayerProjected[n]).toFixed(precision) +
                        "</span>";
                      if (parseFloat(l[n].score) > mflBoxPlayerProjected[n])
                        d = '<span class="MFLPaceScorePositive">' + d + "</span>";
                      else
                        d =
                          '<span class="MFLPaceScoreNegative" style="cursor: pointer;">' +
                          d +
                          "</span>";
                    } catch (e) {
                      p = (0).toFixed(precision);
                    }
                  f = !0;
                }
                if (f) {
                  if (m) var B = "BYE";
                  else
                    try {
                      if (mflBox_nflOpponents[playerDatabase["pid_" + n].team].isHome)
                        B = "v " + mflBox_nflOpponents[playerDatabase["pid_" + n].team].opponent;
                      else B = "@ " + mflBox_nflOpponents[playerDatabase["pid_" + n].team].opponent;
                    } catch (e) {
                      B = "";
                    }
                  try {
                    var h =
                      ' (<span style="color:red" title="' +
                      mfl_injuries.player["pid_" + n].details +
                      '">' +
                      mfl_injuries.player["pid_" + n].code +
                      "</span>)";
                  } catch (e) {
                    h = "";
                  }
                  if (s % 2) var u = "eventablerow";
                  else u = "oddtablerow";
                  (3 === o
                    ? 3600 === parseInt(l[n].gsr)
                      ? (r +=
                          '<tr class="' +
                          u +
                          '"><td colspan="2">' +
                          playerDatabase["pid_" + n].name +
                          " " +
                          playerDatabase["pid_" + n].team +
                          " " +
                          playerDatabase["pid_" + n].position +
                          h +
                          '</td><td style="text-align:center;white-space:nowrap">' +
                          B +
                          '</td><td style="text-align:center">' +
                          p +
                          ' </td><td style="text-align:center">-- </td></tr>')
                      : (r +=
                          '<tr class="' +
                          u +
                          '"><td colspan="2">' +
                          playerDatabase["pid_" + n].name +
                          " " +
                          playerDatabase["pid_" + n].team +
                          " " +
                          playerDatabase["pid_" + n].position +
                          h +
                          '</td><td style="text-align:center;white-space:nowrap">' +
                          B +
                          '</td><td style="text-align:center">' +
                          p +
                          ' </td><td style="text-align:center">' +
                          d +
                          " </td></tr>")
                    : (r +=
                        1 === o
                          ? '<tr class="' +
                            u +
                            '"><td>' +
                            playerDatabase["pid_" + n].name +
                            " " +
                            playerDatabase["pid_" + n].team +
                            " " +
                            playerDatabase["pid_" + n].position +
                            h +
                            '</td><td style="text-align:center;white-space:nowrap">' +
                            B +
                            '</td><td colspan="2" style="text-align:center">' +
                            c +
                            '</td><td style="text-align:center">' +
                            p +
                            " </td></tr>"
                          : '<tr class="' +
                            u +
                            '"><td>' +
                            playerDatabase["pid_" + n].name +
                            " " +
                            playerDatabase["pid_" + n].team +
                            " " +
                            playerDatabase["pid_" + n].position +
                            h +
                            '</td><td style="text-align:center;white-space:nowrap">' +
                            B +
                            '</td><td style="text-align:center">' +
                            c +
                            '</td><td style="text-align:center">' +
                            p +
                            ' </td><td style="text-align:center">' +
                            d +
                            " </td></tr>"),
                    s++);
                }
              }
          } catch (e) {}
        "" === r
          ? (a +=
              '<tr class="oddtablerow"><td colspan="5" class="MFLBoxPlayerDetailsNone">NONE</td></tr>')
          : (0 === o &&
              (a +=
                '<tr class="MFLBoxPlayerDetailsSubHeader"><th style="text-align:left">Player</th><th>Opp</th><th>Clock</th><th>Pace</th><th>Actual</th></tr>'),
            1 === o &&
              (a +=
                '<tr class="MFLBoxPlayerDetailsSubHeader"><th style="text-align:left">Player</th><th>Opp</th><th colspan="2">Game Time</th><th>Proj.</th></tr>'),
            2 === o &&
              (a +=
                '<tr class="MFLBoxPlayerDetailsSubHeader"><th style="text-align:left">Player</th><th>Opp</th><th>Result</th><th>Proj.</th><th>Actual</th></tr>'),
            3 === o &&
              (a +=
                '<tr class="MFLBoxPlayerDetailsSubHeader"><th colspan="2" style="text-align:left">Player</th><th>Opp</th><th>Proj/Pace</th><th>Actual</th></tr>'),
            (a += r));
      }
    if (mflBoxIncludeTiebreaker) {
      a += '<tr class="MFLBoxPlayerDetailsHeader"><th colspan="5">Tiebreaker(s)</th></tr>';
      s = 0;
      for (var L in mflBoxTiebreaker["fid_" + e]) {
        if (s % 2) u = "eventablerow";
        else u = "oddtablerow";
        ((a +=
          '<tr class="' +
          u +
          '"><td colspan="5">' +
          playerDatabase[L].name +
          " " +
          playerDatabase[L].team +
          " " +
          playerDatabase[L].position +
          "</td></tr>"),
          s++);
      }
    }
    ((a += "</tbody></table>"), $("#MFLBoxOverlay").show());
    const y = document.querySelector("#MFLBoxPlayerDetails");
    try {
      bodyScrollLock.disableBodyScroll(y);
    } catch (e) {}
    ($("#MFLBoxPlayerDetails").html(a).show(),
      $('#MFLBoxPlayerDetails td span.MFLBoxLiveStatsScore:contains("undefined")')
        .parents("td")
        .replaceWith('<td style="text-align:center">-- </td>'));
  }
  function computePaceScores() {
    const e = Object.create(null),
      t = Object.create(null);
    try {
      const a = mflBoxJSON_projectedScores.projectedScores.playerScore,
        o = a.length,
        r = Object.create(null);
      for (let e = 0; e < o; e++) {
        const t = a[e];
        ((r["pid_" + t.id] = !0), (mflBoxPlayerProjected[t.id] = parseFloat(t.score) || 0));
      }
      for (const e in playerDatabase)
        playerDatabase.hasOwnProperty(e) && !r[e] && a.push({ id: playerDatabase[e].id, score: 0 });
      const s = a.length;
      for (let r = 0; r < s; r++) {
        const s = a[r],
          i = s.id,
          l = "" === s.score ? 0 : parseFloat(s.score) || 0;
        r >= o && (mflBoxPlayerProjected[i] = 0);
        try {
          const a = mflBox_players["pid_" + i];
          if (!a) continue;
          const o = parseFloat(a.score) || 0,
            r = 0 | a.gameSecondsRemaining,
            s = o + (r / 3600) * l,
            n = a.fid.split(","),
            m = a.isStarter.split(","),
            f = n.length;
          for (let a = 0; a < f; a++) {
            const o = n[a];
            if ("1" !== m[a]) continue;
            const f = i + "_" + o;
            t[f] ||
              ((t[f] = 1),
              e[o] || (e[o] = { pace: 0, expected_pace: 0, players: 0, gameSecondsRemaining: 0 }),
              (e[o].pace += s),
              (e[o].expected_pace += l),
              (e[o].players += 1),
              (e[o].gameSecondsRemaining += r));
          }
        } catch (e) {}
      }
    } catch (e) {}
    for (const t in e) {
      const a = e[t];
      a.gameSecondsRemaining > 0
        ? ((a.paceClass =
            a.pace > a.expected_pace
              ? " MFLPaceScorePositive"
              : a.pace < a.expected_pace
                ? " MFLPaceScoreNegative"
                : ""),
          (a.paceHtml = `<span class="warning${a.paceClass}" title="Original projection ${a.expected_pace.toFixed(precision)}">${a.pace.toFixed(precision)}</span>`))
        : ((a.paceClass = ""), (a.paceHtml = ""));
    }
    return e;
  }
  function doMFLBoxHTML(e) {
    const t = mflBoxCheckLive(),
      a = mflBoxCheckCompletedWeek(),
      o = mflBoxActiveWeek <= completedWeek || mflBoxActiveWeek === liveScoringWeek;
    let r = {};
    t && mflBoxMFLSchedule && (r = computePaceScores());
    let s = {};
    if (!t && !a && mflBoxMFLSchedule) {
      const e = mflBoxJSON_projectedScores?.projectedScores?.playerScore;
      if (Array.isArray(e))
        for (let t = 0; t < e.length; t++) {
          const a = e[t];
          null != a?.id && (s["pid_" + a.id] = Number(a.score) || 0);
        }
    }
    const i = [];
    if (mflBoxMFLSchedule && !mflBoxHideFantasyMatchups)
      if (0 === mflBox_matchups.length)
        i.push(
          '<div class="warning" style="padding:0.938rem;font-weight:bold;vertical-align:middle;text-align:center;font-style:italic;font-size:1.125rem">NO MATCHUPS FOUND - STARTERS MAY BE HIDDEN UNTIL KICKOFF</div>',
        );
      else {
        i.push('<table class="MFLGameLinks fantasyBoxMatchup"><tbody><tr>');
        const getProjected = (e, t) => {
          const a = (e || "").split(",").filter(Boolean);
          if (a.length) {
            let e = 0;
            for (let t = 0; t < a.length; t++) e += s["pid_" + a[t]] || 0;
            return `<span class="warning projected" title="Projected Score">${e.toFixed(precision)}</span>`;
          }
          return `<span class="warning">${t ?? ""}</span>`;
        };
        for (let e = 0; e < mflBox_matchups.length; e++) {
          const s = mflBox_matchups[e],
            l = s.roadId,
            n = s.homeId,
            m = `${l}_${n}`,
            f = `MFLExtras_${m}`,
            c = o
              ? `<tr class="MFLBoxPlayerDetailsTR" onclick="doMFLBoxPlayerDetails('${l}',${e})">`
              : "<tr>",
            d = o
              ? `<tr class="MFLBoxPlayerDetailsTR" onclick="doMFLBoxPlayerDetails('${n}',${e})">`
              : "<tr>",
            p = mflBoxIsAllPlay
              ? `<span style="position:absolute;${a ? "right" : "left"}:0.313rem;bottom:0.438rem;cursor:pointer" title="Swap All Play Team" onclick="mflBoxAllPlayId='${l}';mflBoxNewWeek(0)"><i class="fa-regular fa-arrow-right-arrow-left" aria-hidden="true"></i></span>`
              : "";
          let x = "",
            B = "",
            h = "",
            u = "",
            L = "",
            y = "",
            S = "",
            F = "",
            v = "",
            _ = "",
            M = "",
            g = "",
            P = "",
            k = "",
            b = "";
          if (a)
            ((x = parseFloat(s.roadScore).toFixed(precision)),
              (B = parseFloat(s.homeScore).toFixed(precision)),
              (h =
                "W" === s.roadResult
                  ? '<i class="fa-regular fa-caret-left" aria-hidden="true"></i>'
                  : ""),
              (u =
                "W" === s.homeResult
                  ? '<i class="fa-regular fa-caret-left" aria-hidden="true"></i>'
                  : ""),
              (v = "Final" + p));
          else if (t)
            if (
              ((x = parseFloat(s.roadScore).toFixed(precision)),
              (B = "BYE" === n ? "&nbsp;" : parseFloat(s.homeScore).toFixed(precision)),
              (L = r[l]?.paceHtml || ""),
              (y = r[n]?.paceHtml || ""),
              (_ = isNaN(s.roadPlayerMinutesRemaining)
                ? ""
                : parseFloat(s.roadPlayerMinutesRemaining)),
              (M = isNaN(s.homePlayerMinutesRemaining)
                ? ""
                : parseFloat(s.homePlayerMinutesRemaining)),
              (g = isNaN(s.roadYetToPlay) ? "" : parseFloat(s.roadYetToPlay)),
              (P = isNaN(s.homeYetToPlay) ? "" : parseFloat(s.homeYetToPlay)),
              (k = isNaN(s.roadCurrentlyPlaying) ? "" : parseFloat(s.roadCurrentlyPlaying)),
              (b = isNaN(s.homeCurrentlyPlaying) ? "" : parseFloat(s.homeCurrentlyPlaying)),
              "BYE" === n)
            )
              v = "&nbsp;";
            else {
              const e = r[l],
                t = r[n],
                a = (e?.players || 0) + (t?.players || 0),
                o = (e?.gameSecondsRemaining || 0) + (t?.gameSecondsRemaining || 0),
                i = 3600 * a || 1;
              if (o === i) {
                let e = mflBoxActiveWeekKickoff;
                try {
                  const t = mflBoxFirstKickoff[l],
                    a = mflBoxFirstKickoff[n];
                  void 0 !== t && void 0 !== a
                    ? (e = Math.min(t, a))
                    : void 0 !== t
                      ? (e = t)
                      : void 0 !== a && (e = a);
                } catch (e) {}
                v = mflBoxGameClock(e, 2) + p;
              } else
                o > 0
                  ? (v =
                      mflBoxGameClock((o / i) * 100, 0) +
                      `<span class="MFLBoxDetailsArrow" id="mflBoxExpand_${m}" onclick="mflBoxExpand('${m}',true)"><i class="fa-regular fa-square-caret-right" aria-hidden="true"></i></span>` +
                      `<span class="MFLBoxDetailsArrow" id="mflBoxCollapse_${m}" onclick="mflBoxExpand('${m}',false)" style="display:none"><i class="fa-regular fa-square-caret-left" aria-hidden="true"></i></span>` +
                      p)
                  : ((v = mflBoxGameClock((o / i) * 100, 3) + p),
                    parseFloat(s.roadScore) > parseFloat(s.homeScore) &&
                      (h = '<i class="fa-regular fa-caret-left" aria-hidden="true"></i>'),
                    parseFloat(s.homeScore) > parseFloat(s.roadScore) &&
                      (u = '<i class="fa-regular fa-caret-left" aria-hidden="true"></i>'));
            }
          else
            ((S = getProjected(s.roadStarters, s.roadSpread)),
              (F = getProjected(s.homeStarters, s.homeSpread)),
              mflBoxIsAllPlay && mflBoxIsTotalPts
                ? ((x = "0"), (B = "0"))
                : ((x = franchiseDatabase?.["fid_" + l]?.record ?? ""),
                  (B = franchiseDatabase?.["fid_" + n]?.record ?? "")),
              (v = mflBoxGameClock(mflBoxActiveWeekKickoff, 1) + p));
          (i.push(
            `<td class="matchupLolite"><table class="MFLGameTable matchupLolite" id="mflBoxMatchup_${e}"><tbody>`,
          ),
            i.push(c),
            i.push(`<td class="MFLLiveTeam">${getMFLBoxNameIcon(l)}</td>`),
            i.push(`<td class="MFLPaceSpread">${S}</td>`),
            i.push(`<td class="MFLPaceScore">${L}</td>`),
            i.push(`<td class="MFLLiveScore" style="text-align:right">${x}</td>`),
            i.push(`<td class="MFLWinMarker">${h}</td>`),
            t &&
              (i.push(`<td class="MFLExtras MFLExtrasPMR ${f}">${_}</td>`),
              i.push(`<td class="MFLExtras MFLExtrasYTP ${f}">${g}</td>`),
              i.push(`<td class="MFLExtras MFLExtrasCP ${f}">${k}</td>`)),
            i.push("</tr>"),
            i.push(d),
            i.push(`<td class="MFLLiveTeam">${getMFLBoxNameIcon(n)}</td>`),
            i.push(`<td class="MFLPaceSpread">${F}</td>`),
            i.push(`<td class="MFLPaceScore">${y}</td>`),
            i.push(`<td class="MFLLiveScore" style="text-align:right">${B}</td>`),
            i.push(`<td class="MFLWinMarker">${u}</td>`),
            t &&
              (i.push(`<td class="MFLExtras MFLExtrasPMR ${f}">${M}</td>`),
              i.push(`<td class="MFLExtras MFLExtrasYTP ${f}">${P}</td>`),
              i.push(`<td class="MFLExtras MFLExtrasCP ${f}">${b}</td>`)),
            i.push("</tr>"),
            i.push(
              `<tr><td colspan="5" class="MFLLiveClock" style="position:relative" id="mflBoxClock_${m}">${v}</td>`,
            ),
            t &&
              (i.push(
                `<td class="MFLExtras MFLExtrasPMR ${f}" title="Player Minutes Remaining">PMR</td>`,
              ),
              i.push(
                `<td class="MFLExtras MFLExtrasYTP ${f}" title="Players Yet To Play">YTP</td>`,
              ),
              i.push(
                `<td class="MFLExtras MFLExtrasCP ${f}" title="Players Currently Playing">CP</td>`,
              )),
            i.push("</tr></tbody></table></td>"));
        }
        i.push("</tr></tbody></table>");
      }
    else if (!mflBoxHideNFLMatchups) {
      i.push('<table class="MFLGameLinks NFLBoxMatchup"><tbody><tr>');
      for (let e = 0; e < mflBox_nflSchedule.length; e++) {
        const t = mflBox_nflSchedule[e],
          a = t.roadId,
          o = t.homeId,
          r = parseInt(t.gameSecondsRemaining);
        let s = "",
          l = "",
          n = "",
          m = "",
          f = "",
          c = "",
          d = "";
        (0 === r
          ? ((s = t.roadScore),
            (l = t.homeScore),
            (d = "Final"),
            parseFloat(t.roadScore) > parseFloat(t.homeScore) &&
              (n = '<i class="fa-regular fa-caret-left" aria-hidden="true"></i>'),
            parseFloat(t.homeScore) > parseFloat(t.roadScore) &&
              (m = '<i class="fa-regular fa-caret-left" aria-hidden="true"></i>'))
          : 3600 === r
            ? ((d = t.clock),
              (f = `<span class="warning">${t.roadSpread}</span>`),
              (c = `<span class="warning">${t.homeSpread}</span>`))
            : ((s = t.roadScore),
              (l = t.homeScore),
              (d = mflBoxGameClock((r / 3600) * 100, 3)),
              (f = t.roadRedzone
                ? `<span class="downDistance redzone">${t.roadDownAndDist}</span>`
                : t.roadPossession
                  ? `<span class="downDistance possession">${t.roadDownAndDist}</span>`
                  : ""),
              (c = t.homeRedzone
                ? `<span class="downDistance redzone">${t.homeDownAndDist}</span>`
                : t.homePossession
                  ? `<span class="downDistance possession">${t.homeDownAndDist}</span>`
                  : "")),
          r < 3500
            ? i.push(
                `<td class="matchupLolite" style="position:relative"><a class="boxmatchLink" style="display:none;position:absolute;width:100%;height:100%;z-index:1;" href="${baseURLDynamic}/${year}/pro_matchup?L=${league_id}&W=${mflBoxActiveWeek}&MATCHUP=${o},${a}"></a>`,
              )
            : i.push('<td class="matchupLolite" style="position:relative">'),
          i.push(`<table class="MFLGameTable matchupLolite" id="mflBoxMatchup_${e}"><tbody>`),
          i.push("<tr>"),
          i.push(
            `<td class="MFLLiveTeam">${getMFLBoxNFLIcon(a)} <span class="MFLLiveAbbrev" style="vertical-align:middle">${a}</span></td>`,
          ),
          i.push(`<td class="MFLPaceSpread">${f}</td>`),
          i.push('<td class="MFLPaceScore"></td>'),
          i.push(`<td class="MFLLiveScore" style="text-align:right">${s}</td>`),
          i.push(`<td class="MFLWinMarker">${n}</td>`),
          i.push("</tr>"),
          i.push("<tr>"),
          i.push(
            `<td class="MFLLiveTeam">${getMFLBoxNFLIcon(o)} <span class="MFLLiveAbbrev" style="vertical-align:middle">${o}</span></td>`,
          ),
          i.push(`<td class="MFLPaceSpread">${c}</td>`),
          i.push('<td class="MFLPaceScore"></td>'),
          i.push(`<td class="MFLLiveScore" style="text-align:right">${l}</td>`),
          i.push(`<td class="MFLWinMarker">${m}</td>`),
          i.push("</tr>"),
          i.push(
            `<tr><td colspan="5" class="MFLLiveClock" id="mflBoxClock_${a}_${o}">${d}</td></tr>`,
          ),
          i.push("</tbody></table></td>"));
      }
      i.push("</tr></tbody></table>");
    }
    if (
      ((document.getElementById("MFLBoxMatchups").innerHTML = i.join("")),
      e && jQuery("#MFLBoxMatchups").scrollLeft(0),
      t && mflBoxMFLSchedule)
    )
      for (let e = 0; e < mflBox_matchups.length; e++) {
        const t = mflBox_matchups[e],
          a = `${t.roadId}_${t.homeId}`;
        mflBoxDetailsTracker[a] && mflBoxExpand(a, !0);
      }
    if (a && mflBoxMFLSchedule)
      try {
        const e = mflBoxJSON_projectedScores.projectedScores.playerScore;
        for (let t = 0; t < e.length; t++) {
          const a = parseFloat(e[t].score);
          mflBoxPlayerProjected[e[t].id] = isNaN(a) ? 0 : a;
        }
      } catch (e) {}
    mflBoxMFLSchedule &&
      "" !== mflBoxPlayerDetailsFid.fid &&
      doMFLBoxPlayerDetails(mflBoxPlayerDetailsFid.fid, mflBoxPlayerDetailsFid.boxid);
  }
  function mflBoxLeagueSettings() {
    ((mflBoxStartWeek = startWeek),
      (mflBoxLastRegularSeasonWeek = standingsEndWeek),
      (mflBoxEndWeek = void 0 === endWeek ? 18 : endWeek),
      completedWeek === liveScoringWeek
        ? ((mflBoxCurrentWeek = completedWeek),
          (mflBoxCurrentLiveScoring = !mflBoxCheckWeeklyResultsForScore(mflBoxCurrentWeek)))
        : ((mflBoxCurrentWeek = liveScoringWeek), (mflBoxCurrentLiveScoring = !0)),
      mflBoxCurrentWeek > mflBoxEndWeek &&
        ((mflBoxCurrentWeek = mflBoxEndWeek), (mflBoxCurrentLiveScoring = !1)),
      0 === liveScoringWeek && (mflBoxCurrentLiveScoring = !1),
      mflBoxCurrentWeek < 1 && (mflBoxCurrentWeek = 1),
      (mflBoxActiveWeek = mflBoxCurrentWeek));
    for (var e = 0; e < reportNflByeWeeks_ar.nflByeWeeks.team.length; e++)
      mflBox_byeWeek[reportNflByeWeeks_ar.nflByeWeeks.team[e].id] = parseInt(
        reportNflByeWeeks_ar.nflByeWeeks.team[e].bye_week,
      );
  }
  function doMFLBoxLiveStats() {
    if (liveScoringWeek < 1 || mflBoxActiveWeek > liveScoringWeek) {
      for (var e in mflBoxNflGameStatus)
        ((mflBoxNflGameStatus[e].clock = mflBoxNflGameTime(mflBoxNflGameStatus[e].time)),
          (mflBoxNflGameStatus[e].secs_left = 3600),
          (mflBoxNflGameStatus[e].status = "SCHED"),
          mflBoxLiveStatsTeam[e] || (mflBoxLiveStatsTeam[e] = {}),
          (mflBoxLiveStatsTeam[e].TPS = ""),
          (mflBoxLiveStatsTeam[e].TPA = ""));
      return (doMFLBoxArrays(), !0);
    }
    if (
      (mflBoxActiveWeek === liveScoringWeek && mflBoxActiveWeek !== completedWeek) ||
      mflBoxMFLSchedule
    ) {
      if (mflBoxActiveWeek === liveScoringWeek) {
        return (
          mflBoxParseLiveStats("CACHE", (t = Date.now ? Date.now() : new Date().getTime())),
          doMFLBoxArrays(),
          !0
        );
      }
      var t;
      t = Date.now ? Date.now() : new Date().getTime();
      var a = xmlBaseURL + "live_stats_";
      return (
        (a =
          (a += "idp_") +
          (mflBoxActiveWeek < 10 ? "0" + mflBoxActiveWeek : mflBoxActiveWeek) +
          ".txt?RANDOM=" +
          t),
        new Promise(function (e) {
          jQuery.ajax({
            url: a,
            success: function (a) {
              (mflBoxParseLiveStats(a, t), doMFLBoxArrays(), e());
            },
            error: function (t, a, o) {
              (console.log("Live stats fetch failed: " + a + " " + o), e());
            },
          });
        })
      );
    }
    for (var e in mflBoxNflGameStatus) {
      var o = mflBoxNflGameStatus[e].score ?? 0;
      (delete mflBoxNflGameStatus[e].clock,
        (mflBoxNflGameStatus[e].secs_left = 0),
        (mflBoxNflGameStatus[e].status = "OVER"),
        mflBoxLiveStatsTeam[e] || (mflBoxLiveStatsTeam[e] = {}),
        (mflBoxLiveStatsTeam[e].TPS = o),
        (mflBoxLiveStatsTeam[e].TPA = ""));
    }
    return (doMFLBoxArrays(), !0);
  }
  function doMFLBoxLiveUpdate(e) {
    doMFLBox &&
      mflBoxActiveWeek === liveScoringWeek &&
      Promise.all([doMFLBoxFantasyWeek(), doMFLBoxNFLWeek(), doMFLBoxProjectedScores()])
        .then(() => doMFLBoxLiveStats())
        .then(() => {
          (doMFLBoxArrows(), doMFLBoxHTML(!0));
        });
  }
  function doMFLBoxUpdate(e) {
    Promise.all([doMFLBoxFantasyWeek(), doMFLBoxNFLWeek(), doMFLBoxProjectedScores()])
      .then(() => doMFLBoxLiveStats())
      .then(() => {
        (doMFLBoxArrows(), doMFLBoxHTML(!0));
      });
  }
  jQuery(".mobile-wrap #MFLBoxWrapper").unwrap();
  try {
    window.MFLGlobalCache.onReady(() => {
      (mflBoxHomePageOnly
        ? ("undefined" != typeof thisProgram && "home" === thisProgram && (doMFLBox = !0),
          "undefined" != typeof thisProgram && "options_247" === thisProgram && (doMFLBox = !1),
          new URLSearchParams(window.location.search).has("MODULE") && (doMFLBox = !1))
        : (doMFLBox = !0),
        doMFLBox &&
          (mflBoxHideFantasyMatchups && (mflBoxMFLSchedule = !1),
          mflBoxLeagueSettings(),
          Promise.all([doMFLBoxFantasyWeek(), doMFLBoxNFLWeek(), doMFLBoxProjectedScores()])
            .then(() => {
              for (var e in mflBoxNflGameStatus) {
                var t = mflBoxNflGameStatus[e].score ?? 0;
                (delete mflBoxNflGameStatus[e].clock,
                  (mflBoxNflGameStatus[e].secs_left = 0),
                  (mflBoxNflGameStatus[e].status = "OVER"),
                  mflBoxLiveStatsTeam[e] || (mflBoxLiveStatsTeam[e] = {}),
                  (mflBoxLiveStatsTeam[e].TPS = t),
                  (mflBoxLiveStatsTeam[e].TPA = ""));
              }
              return (doMFLBoxArrays(), doMFLBoxHTML(), doMFLBoxArrows(), doMFLBoxLiveStats());
            })
            .then(() => {
              doMFLBoxHTML(!1);
              try {
                var e = document.getElementById("MFLBoxMatchups");
                if (e && e.innerHTML && window.MFLCache) {
                  var t = window.MFLCache.KEY.mflBoxMatchups(year, league_id);
                  window.MFLCache.set(t, e.innerHTML, window.MFLCache.TTL.SIX_HOUR).catch(
                    function () {},
                  );
                }
              } catch (e) {}
            })));
    });
  } catch {
    console.log("MFL CACHE DID NOT LOAD");
  }
}

  /* ---------- END verbatim TOS source ---------- */
})();
