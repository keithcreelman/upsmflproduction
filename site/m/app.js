/* UPS Mobile — app shell + data layer.
   Mirrors site/team_operations/team_operations.js fetch + cap patterns
   exactly so mobile and desktop produce the same numbers from the same
   MFL exports. CTA parity rule (memory: feedback_cta_parity_and_canonical_rules).
*/
(function () {
  "use strict";

  // ---------- Constants ----------
  // Single source of truth for the running build. MUST match version.json.build
  // and the ?v= cache-buster in index.html — bump all three together on each
  // ship. The boot-time checkForUpdate() compares this to the DEPLOYED
  // version.json and surfaces a reload banner when a stale cache is detected.
  var BUILD = "2026.06.22.7";
  var WORKER_BASE_DEFAULT = "https://upsmflproduction.keith-creelman.workers.dev";
  var LEAGUE_ID_DEFAULT = "74598";

  function workerBase() {
    var override = (window.UPS_MOBILE_API_BASE || window.UPS_TEAMOPS_API_BASE || "").trim();
    return (override || WORKER_BASE_DEFAULT).replace(/\/+$/, "");
  }
  function workerUrl(p) { return workerBase() + p; }

  // ---------- Helpers (mirror team_operations.js:19-43) ----------
  function safeStr(v) { return v == null ? "" : String(v).trim(); }
  function safeInt(v, dflt) {
    var n = parseInt(v, 10);
    return isFinite(n) ? n : (dflt == null ? 0 : dflt);
  }
  function pad4(v) {
    var d = String(v || "").replace(/\D/g, "");
    return d ? d.padStart(4, "0").slice(-4) : "";
  }
  function escapeHtml(v) {
    return safeStr(v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function fmtUsd(n) {
    var x = Number(n || 0);
    if (!isFinite(x)) return "$0";
    if (Math.abs(x) >= 1000) return "$" + Math.round(x / 1000) + "K";
    return "$" + Math.round(x);
  }
  // Rookie salary derivation — verbatim from league_context_v1.md §A1.4.
  // Returns the per-year salary for a given UPS draft pick. Flat across
  // all 3 contract years; option-year salary for 1st-rounders is computed
  // separately (Y3 + $5K per §C6).
  //
  // §A1.4 table:
  //   1.01           → $15K
  //   1.02 – 1.12    → decrements by $1K per slot, floor $5K
  //                    (1.02 = $14K, 1.03 = $13K, ..., 1.11 = $5K, 1.12 = $5K)
  //   2.01 – 2.12    → $5K  (TCV $15K)
  //   3.01 – 5.12    → $2K  (TCV $6K)
  //   6.01 – 6.12    → $1K  (TCV $3K, IDP only)
  function rookieSalaryForPick(round, pick) {
    var r = parseInt(round, 10);
    var p = parseInt(pick, 10);
    if (!isFinite(r) || !isFinite(p) || r < 1 || p < 1) return 0;
    if (r === 1) {
      // 1.01 = $15K; each subsequent slot drops $1K; floor at $5K.
      var sal = 15000 - (p - 1) * 1000;
      return Math.max(5000, sal);
    }
    if (r === 2) return 5000;
    if (r >= 3 && r <= 5) return 2000;
    if (r === 6) return 1000;
    return 0;
  }

  // Parse a roster row's `drafted` field. MFL stores UPS draft slot for
  // players the franchise selected directly ("R.PP (YYYY)"), trade
  // origination ("Trade (YYYY)"), or FA acquisition ("FA (YYYY)").
  // Returns { round, pick, year } when parseable as a direct pick,
  // { tradeYear } for trade-acquired, or null otherwise.
  function parseDraftedField(s) {
    var str = safeStr(s);
    if (!str) return null;
    var m = str.match(/^(\d+)\.(\d+)\s*\((\d{4})\)/);
    if (m) {
      return { round: parseInt(m[1], 10), pick: parseInt(m[2], 10), year: parseInt(m[3], 10) };
    }
    var t = str.match(/^Trade\s*\((\d{4})\)/i);
    if (t) return { tradeYear: parseInt(t[1], 10) };
    return null;
  }

  // Derive the contracted salary for a taxi player. MFL strips the
  // salary field for taxi-status players in both rosters + salaries
  // exports (verified 2026-05-16 against pid 16212), so we fall back
  // to the rookie salary table when the player's draft slot is known.
  //
  // Two derivation paths:
  //   1. `drafted: "R.PP (YYYY)"` → direct parse of own franchise's pick
  //   2. `drafted: "Trade (YYYY)"` → look up the player in the historical
  //      draft index (past 3 years of draftResults across all franchises)
  //      to find the original UPS draft slot. Per §A1.4 the salary is
  //      identical regardless of which franchise made the original pick.
  function deriveTaxiSalary(rosterRow) {
    if (!rosterRow) return { ok: false, salary: 0, reason: "no_row" };
    var parsed = parseDraftedField(rosterRow.drafted);
    if (parsed && parsed.round && parsed.pick) {
      var sal = rookieSalaryForPick(parsed.round, parsed.pick);
      return {
        ok: sal > 0,
        salary: sal,
        round: parsed.round,
        pick: parsed.pick,
        year: parsed.year,
        source: "rookie-table-direct"
      };
    }
    // Trade-acquired or unknown origin — consult the historical draft
    // index keyed by player_id.
    var pid = String(rosterRow.id || "");
    var idx = state.historicalDraftByPid || {};
    if (pid && idx[pid]) {
      var hit = idx[pid];
      var sal2 = rookieSalaryForPick(hit.round, hit.pick);
      return {
        ok: sal2 > 0,
        salary: sal2,
        round: hit.round,
        pick: hit.pick,
        year: hit.year,
        source: "rookie-table-historical"
      };
    }
    if (parsed && parsed.tradeYear) {
      return { ok: false, salary: 0, reason: "trade_acquired_unfound", tradeYear: parsed.tradeYear };
    }
    return { ok: false, salary: 0, reason: "unknown_origin" };
  }

  // Precise USD — preserves sub-$1K resolution so a $1,500 penalty
  // displays as "$1.5K" instead of being rounded to "$2K". Used by
  // the drop/extension/restructure confirm modals where the difference
  // between $1K and $2K is material.
  function fmtUsdPrecise(n) {
    var x = Number(n || 0);
    if (!isFinite(x)) return "$0";
    var abs = Math.abs(x);
    if (abs >= 10000) return "$" + Math.round(x / 1000) + "K";
    if (abs >= 1000) return "$" + (Math.round(x / 100) / 10) + "K";
    if (abs >= 100) return "$" + (Math.round(x / 100) / 10) + "K";
    return "$" + Math.round(x);
  }
  function asArray(v) {
    if (Array.isArray(v)) return v;
    if (v == null || v === "") return [];
    return [v];
  }
  function readCookie(name) {
    try {
      var m = document.cookie.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
      return m ? decodeURIComponent(m[1]) : "";
    } catch (e) { return ""; }
  }
  // Inline icon helper — UPS_ICONS svg string (or "" before icons.js loads).
  // For leading icons in static view markup; tinted via currentColor.
  function ic(name, size) {
    if (!window.UPS_ICONS) return "";
    return window.UPS_ICONS.svg(name, { size: size || 16, cls: "ups-ic-inline" });
  }

  // ---------- State ----------
  var state = {
    ctx: { leagueId: LEAGUE_ID_DEFAULT, year: String(new Date().getUTCFullYear()) },
    league: null,
    franchises: [],
    viewerFranchiseId: "",
    viewerFranchise: null,
    rosters: null,
    salaries: null,
    salaryAdjustments: null,
    players: null,
    tradeBait: null,
    tradeBaitNotes: null,     // { [pid]: "note text" } for viewer's franchise
    tradeOffers: null,        // { incoming: [], outgoing: [] } for viewer's franchise
    playerScoresYtd: null,    // MFL playerScores W=YTD export
    tagTracking: null,        // site/ccc/tag_tracking.json rows
    tagSubmissions: null,     // site/ccc/tag_submissions.json rows
    optimisticTagSubmissions: null, // pending tag/untag pushes that survive reloadData() until ETL JSON confirms them
    salaryAdjustmentReport: null, // site/reports/salary_adjustments/<year>.json — overlays the MFL feed
    advancedStatsByPid: null,  // map for the most recent year with real leaderboard data (FA browser display)
    advancedStatsByYear: null, // { [year]: { [pid]: { mfl_points, mfl_ppg, games, pos, posRank } } }
    advancedStatsLatestYear: 0, // most recent season with rows; equals ctx.year during the season, ctx.year-1 in offseason
    rookieProspects: null,     // site/rookies/rookie_prospects_<year>.json rows
    draftResults: null,        // /api/mfl-export?TYPE=draftResults
    historicalDraftByPid: null, // { [pid]: { year, round, pick } } — past 3 years for taxi salary derivation
    leagueEvents: null,        // /api/league-events?season=<year>&from=today (UPS deadline calendar)
    contractDeadline: "",      // §C2 MYAC window-close date (ISO yyyy-mm-dd) from /api/league-events?from=all; mirrors desktop v2/front_office.js STATE.contractDeadline
    acquisitionByKey: null,    // { "fid:pid": { label, date } } from player_acquisition_lookup_<year>.json — gates the MYAC fresh-FA-auction branch (desktop mergeAcquisitionLookupRows)
    injuriesByPid: null,       // { pid: "IR"|"OUT"|"PUP"|"SUSPENDED"|... } from MFL injuries export — IR view §B3 "eligible to option down" bucket
    capAmount: 0,
    loaded: false,
    loadingPromise: null,
    loadingPromiseFid: "",  // fid active when current loadAllData started; race guard
    loadErrors: [],
    meConfigured: false,    // true when /api/me resolved a real session; gates mutating UI
    busyActionKey: ""
  };

  // ---------- Context detection ----------
  function detectContext() {
    var qs = new URLSearchParams(window.location.search);
    var leagueId = qs.get("L") || window.UPS_M_LEAGUE_ID || LEAGUE_ID_DEFAULT;
    var year = qs.get("YEAR") || qs.get("year") || window.UPS_M_YEAR || "";
    if (!year) {
      var now = new Date();
      year = String(now.getUTCFullYear());
    }
    state.ctx.leagueId = String(leagueId).replace(/\D/g, "") || LEAGUE_ID_DEFAULT;
    state.ctx.year = String(year).replace(/\D/g, "") || String(new Date().getUTCFullYear());
    // Optional explicit franchise via URL: ?FRANCHISE_ID=0008 — useful for
    // testing and for the "Switch team" flow from the More tab.
    var fidQs = qs.get("FRANCHISE_ID") || qs.get("franchise_id");
    if (fidQs) {
      try { window.localStorage && window.localStorage.setItem("rdh_my_fid", pad4(fidQs)); } catch (e) {}
    }
    // MFL identity bootstrap (Keith 2026-05-16: "shouldn't need to pick
    // franchise — should auto-auth"). The Switch-to-App-View button on
    // the desktop MFL site reads document.cookie["MFL_USER_ID"] (same-
    // origin from myfantasyleague.com) and forwards it here as a URL
    // param. We persist it in localStorage so subsequent visits skip
    // the picker too. fetchMe() forwards it to /api/me which resolves
    // the owning franchise via MFL's myleagues lookup.
    var mflUserIdQs = qs.get("MFL_USER_ID") || qs.get("mfl_user_id");
    if (mflUserIdQs) {
      try {
        window.localStorage && window.localStorage.setItem("ups_mfl_user_id", String(mflUserIdQs));
      } catch (e) {}
      // Security: once captured into localStorage, strip the session token
      // from the visible URL/history so it doesn't linger in the address
      // bar, bookmarks, PWA recents, or any outbound Referer. Guarded so a
      // failure here never blocks boot.
      try {
        if (window.history && window.history.replaceState) {
          var cleanUrl = new URL(window.location.href);
          cleanUrl.searchParams.delete("MFL_USER_ID");
          cleanUrl.searchParams.delete("mfl_user_id");
          window.history.replaceState(null, "", cleanUrl.toString());
        }
      } catch (e) {}
    }
    // Trade-DM deep-link: a Discord DM button lands here with
    // ?focus_trade=<id>&intent=view|decline|counter to open the Trades view
    // straight to that offer. Capture + scrub (mirror the MFL_USER_ID scrub),
    // then ensure the trade route. Acts with the owner's OWN stored session.
    var focusTrade = qs.get("focus_trade");
    if (focusTrade) {
      state.pendingTradeFocus = {
        tradeId: String(focusTrade).replace(/\D/g, ""),
        intent: String(qs.get("intent") || "view").toLowerCase()
      };
      try {
        if (window.history && window.history.replaceState) {
          var ctUrl = new URL(window.location.href);
          ctUrl.searchParams.delete("focus_trade");
          ctUrl.searchParams.delete("intent");
          window.history.replaceState(null, "", ctUrl.toString());
        }
      } catch (e) {}
      try {
        if (!/^#?league\/trade/.test(window.location.hash || "")) {
          window.location.hash = "#league/trade";
        }
      } catch (e) {}
    }
  }
  function getStoredMflUserId() {
    try {
      var v = window.localStorage && window.localStorage.getItem("ups_mfl_user_id");
      return v ? String(v) : "";
    } catch (e) { return ""; }
  }

  // ---------- Data fetch ----------
  function mflExportUrl(type, extra) {
    return mflExportUrlForYear(type, state.ctx.year, extra);
  }
  function mflExportUrlForYear(type, year, extra) {
    var url = workerUrl("/api/mfl-export") +
      "?TYPE=" + encodeURIComponent(type) +
      "&L=" + encodeURIComponent(state.ctx.leagueId) +
      "&YEAR=" + encodeURIComponent(year) +
      "&JSON=1";
    if (extra && typeof extra === "object") {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k) && extra[k] != null && extra[k] !== "") {
          url += "&" + encodeURIComponent(k) + "=" + encodeURIComponent(extra[k]);
        }
      }
    }
    return url;
  }

  // Build pid → { year, round, pick } from a draftResults JSON response.
  function indexDraftPicks(draftResults, year) {
    var out = {};
    if (!draftResults) return out;
    var unit = draftResults.draftResults && draftResults.draftResults.draftUnit;
    if (Array.isArray(unit)) unit = unit[0];
    var picks = unit && unit.draftPick ? unit.draftPick : [];
    if (!Array.isArray(picks)) picks = [picks];
    picks.forEach(function (pk) {
      if (!pk || !pk.player) return;
      out[String(pk.player)] = {
        year: year,
        round: parseInt(pk.round, 10),
        pick: parseInt(pk.pick, 10)
      };
    });
    return out;
  }

  // Build the historical pid→pick map by fetching past 3 years of
  // draftResults (the taxi-eligibility window) and merging. Used to
  // derive salary for trade-acquired taxi players whose `drafted` field
  // only carries the trade year, not the original pick.
  function fetchHistoricalDraftIndex(curYear) {
    var seasonInt = parseInt(curYear, 10) || (new Date().getUTCFullYear());
    var years = [seasonInt, seasonInt - 1, seasonInt - 2, seasonInt - 3];
    var fetches = years.map(function (y) {
      return fetchJson(mflExportUrlForYear("draftResults", y))
        .then(function (j) { return indexDraftPicks(j, y); })
        .catch(function () { return {}; });
    });
    return Promise.all(fetches).then(function (maps) {
      // Merge — later years overwrite earlier, but a pid only appears
      // in ONE year's draftResults so this is effectively a union.
      var merged = {};
      maps.forEach(function (m) {
        Object.keys(m).forEach(function (pid) { merged[pid] = m[pid]; });
      });
      return merged;
    });
  }

  function fetchJson(url) {
    var controller = ("AbortController" in window) ? new AbortController() : null;
    var timeout = setTimeout(function () { if (controller) controller.abort(); }, 10000);
    var opts = { credentials: "omit", mode: "cors" };
    if (controller) opts.signal = controller.signal;
    return fetch(url, opts)
      .then(function (r) {
        clearTimeout(timeout);
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .catch(function (err) {
        clearTimeout(timeout);
        var tag = (url.split("TYPE=")[1] || url).split("&")[0];
        state.loadErrors.push(tag + ": " + (err && err.message ? err.message : String(err)));
        return null;
      });
  }

  function fetchMe() {
    // /api/me — viewer franchise resolution via the MFL_USER_ID URL param
    // (forwarded by the Switch-to-App-View button from MFL's cookie, then
    // persisted to localStorage). The worker reads it off the query string
    // and resolves franchise_id + franchise_name via _rdhDetectFranchise.
    //
    // MUST be credentials:"omit". This is a CROSS-ORIGIN call (github.io ->
    // workers.dev) and the worker replies Access-Control-Allow-Origin: *.
    // A wildcard ACAO is illegal on a credentialed request, so
    // credentials:"include" makes the browser BLOCK the response ("Failed
    // to fetch") -> fetchMe returns null -> meConfigured never flips true
    // -> the app is stuck on "Sign in" even with a valid token. (Bug
    // shipped 2026-06-10; only reproduces cross-origin, so same-origin
    // localhost testing missed it.) The app authenticates purely via the
    // URL param, never a worker-domain cookie, so omit costs nothing.
    var url = workerUrl("/api/me");
    var stored = getStoredMflUserId();
    if (stored) url += "?MFL_USER_ID=" + encodeURIComponent(stored);
    return fetch(url, { credentials: "omit", mode: "cors" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  // Tag-plan data — mirrors what Front Office loads via loadTagPlanData
  // (roster_workbench.js:3097). Same JSON files Pages serves, no auth.
  function fetchTagTracking() {
    return fetch("/upsmflproduction/ccc/tag_tracking.json", { mode: "cors", credentials: "omit", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j) return [];
        if (Array.isArray(j)) return j;
        if (Array.isArray(j.rows)) return j.rows;
        return [];
      })
      .catch(function () { return []; });
  }
  // Advanced Stats Workbench leaderboard — canonical UPS-scored fantasy
  // points + PPG + game count per player. Mirrors stats_workbench.html's
  // /api/advanced-stats-leaderboard usage. The worker accepts pos-group
  // aliases (qb / skill / idp / kicker), NOT individual MFL positions —
  // sending pos=RB returns HTTP 400. We fetch by alias and bucket-then-rank
  // by row.position so each player's posRank is within their own position.
  var LEADERBOARD_ALIASES = ["qb", "skill", "idp", "kicker"];
  // Fetch one season's leaderboard across all alias groups. Returns a
  // pid-keyed map of { mfl_points, mfl_ppg, games, pos, posRank }.
  function fetchAdvancedStatsLeaderboardForSeason(seasonInt) {
    var fetches = LEADERBOARD_ALIASES.map(function (pos) {
      var url = workerUrl("/api/advanced-stats-leaderboard?season=" + encodeURIComponent(seasonInt) +
                          "&pos=" + encodeURIComponent(pos) + "&min_games=1");
      return fetch(url, { mode: "cors", credentials: "omit" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { return (j && Array.isArray(j.rows)) ? j.rows : []; })
        .catch(function () { return []; });
    });
    return Promise.all(fetches).then(buildLeaderboardMap);
  }

  // Fetch a 4-year window of leaderboards (curYear + 3 prior) so the player
  // sheet's year-by-year table has real games/pts/PPG/rank for the last 3
  // real seasons even during the offseason when curYear has no rows yet.
  //
  // Returns { byYear: { [year]: pidMap }, latestYearWithData: <int> }.
  // - byYear preserves per-year keys verbatim (no silent aliasing — earlier
  //   versions copied byYear[curYear] = byYear[curYear-1] in preseason,
  //   which caused the player sheet to render two identical rows. See the
  //   2026-05-16 bug fix.)
  // - latestYearWithData lets the FA browser fall back to prior-season
  //   ranks without conflating years.
  function fetchAdvancedStatsLeaderboard(year) {
    var seasonInt = parseInt(year, 10) || (new Date().getUTCFullYear());
    var years = [seasonInt, seasonInt - 1, seasonInt - 2, seasonInt - 3];
    var fetches = years.map(function (y) {
      return fetchAdvancedStatsLeaderboardForSeason(y).then(function (m) {
        return { year: y, map: m };
      });
    });
    return Promise.all(fetches).then(function (results) {
      var byYear = {};
      results.forEach(function (r) { byYear[r.year] = r.map; });
      var latest = seasonInt;
      while (latest >= seasonInt - 3 && (!byYear[latest] || Object.keys(byYear[latest]).length === 0)) {
        latest--;
      }
      return { byYear: byYear, latestYearWithData: latest };
    });
  }

  // Rookie prospects JSON — consensus rankings from rookie_draft_hub.
  // Use this list as the "Available" rookie pool ordering on Draft view.
  function fetchRookieProspects(year) {
    var url = "/upsmflproduction/rookies/rookie_prospects_" + encodeURIComponent(year) + ".json";
    return fetch(url, { mode: "cors", credentials: "omit", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j) return [];
        if (Array.isArray(j)) return j;
        if (Array.isArray(j.prospects)) return j.prospects;
        return [];
      })
      .catch(function () { return []; });
  }

  // §C2 MYAC contract deadline — the September date that closes the MYAC
  // window. Verbatim mirror of v2/front_office.js loadContractDeadline (2004):
  // pulls the `contract_deadline` row from the D1 league-events calendar with
  // from=all. NOTE: this is a SEPARATE fetch from state.leagueEvents (which
  // uses from=today for the upcoming-deadlines display) — from=today drops the
  // event once it passes, which would wrongly reopen the MYAC window. Returns
  // ISO yyyy-mm-dd, or "" (unknown → treated as within-window per desktop so a
  // load failure never blocks the option).
  function fetchContractDeadline(year) {
    var url = workerUrl("/api/league-events?season=" + encodeURIComponent(year) + "&from=all&limit=50");
    return fetch(url, { mode: "cors", credentials: "omit", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        var evs = (data && data.events) || [];
        var cd = evs.find(function (e) { return String(e.event || "").toLowerCase().indexOf("contract_deadline") >= 0; });
        return (cd && cd.date) ? String(cd.date).slice(0, 10) : "";
      })
      .catch(function () { return ""; });
  }

  // Acquisition lookup — the commish-maintained
  // player_acquisition_lookup_<year>.json asset desktop Front Office consumes.
  // Mobile needs each player's acquisition LABEL + DATE to gate the MYAC
  // fresh-FA-auction branch (§C2): a 1-yr Veteran auctioned THIS season can
  // MYAC, a HELD final-year Veteran cannot — the date is what separates them.
  // Returns a map keyed "paddedFid:pid" → { label, date }. Mirror of
  // v2/front_office.js loadAcquisitionLookup (780) + mergeAcquisitionLookupRows.
  function fetchAcquisitionLookup(year) {
    var url = "/upsmflproduction/rosters/player_acquisition_lookup_" + encodeURIComponent(year) + ".json";
    return fetch(url, { mode: "cors", credentials: "omit", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var rows = j ? (Array.isArray(j) ? j : (Array.isArray(j.rows) ? j.rows : [])) : [];
        var map = {};
        rows.forEach(function (row) {
          if (!row) return;
          var fid = pad4(row.franchise_id || row.franchiseId);
          var pid = safeStr(row.player_id || row.playerId).replace(/\D/g, "");
          if (!fid || !pid) return;
          map[fid + ":" + pid] = {
            label: safeStr(row.acquisition_label || row.label),
            date: safeStr(row.acquisition_date || row.date_et).slice(0, 10)
          };
        });
        return map;
      })
      .catch(function () { return {}; });
  }

  // NFL injury designations (MFL injuries export) → { pid: STATUS }.
  // The IR view (§B3) uses this to surface active players who are
  // IR-eligible (NFL IR / PUP / suspended / holdout). Fail-open → {}.
  function fetchInjuries() {
    return fetchJson(mflExportUrl("injuries")).then(function (j) {
      var map = {};
      var root = j && j.injuries && j.injuries.injury;
      asArray(root).forEach(function (it) {
        if (it && it.id != null) map[String(it.id)] = safeStr(it.status).toUpperCase();
      });
      return map;
    }).catch(function () { return {}; });
  }

  function buildLeaderboardMap(perAliasArrays) {
    // Each alias response (skill / idp) returns multiple positions
    // (RB+WR+TE, or DB+LB+DL etc.). Bucket by row.position FIRST so a WR's
    // rank is among WRs, not among all skill players combined. Then sort
    // each bucket by mfl_ppg descending and assign posRank.
    var map = {};
    var buckets = {};
    perAliasArrays.forEach(function (rows) {
      rows.forEach(function (row) {
        if (!row || !row.mfl_pid) return;
        // Rank within the IDP/offense GROUP (DL/LB/DB/QB/RB/WR/TE/PK), not the
        // raw nflverse position — otherwise DT/DE/OLB each get their own #1 and
        // a "DL" shows four rank-1s (Keith 2026-06-20). pos_group is clean.
        var pos = String(row.pos_group || row.position || "").toUpperCase();
        if (!buckets[pos]) buckets[pos] = [];
        buckets[pos].push(row);
      });
    });
    Object.keys(buckets).forEach(function (pos) {
      var sorted = buckets[pos].slice().sort(function (a, b) {
        return Number(b.mfl_ppg || 0) - Number(a.mfl_ppg || 0);
      });
      sorted.forEach(function (row, idx) {
        map[String(row.mfl_pid)] = {
          mfl_points: Number(row.mfl_points || 0),
          mfl_ppg: Number(row.mfl_ppg || 0),
          games: Number(row.games || 0),
          pos: pos,
          posRank: idx + 1
        };
      });
    });
    return map;
  }

  // Salary-adjustments report ledger. Front Office overlays this on top
  // of the live MFL salaryAdjustments feed (see roster_workbench.js
  // loadSalaryAdjustmentLedgerRows + mergeReportSalaryAdjustmentsIntoTeams).
  // LH's −$16K cap credit lives in this file, not the MFL feed.
  function fetchSalaryAdjustmentReport(year) {
    var url = "/upsmflproduction/reports/salary_adjustments/salary_adjustments_" + encodeURIComponent(year) + ".json";
    return fetch(url, { mode: "cors", credentials: "omit", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j) return [];
        if (Array.isArray(j)) return j;
        if (Array.isArray(j.rows)) return j.rows;
        return [];
      })
      .catch(function () { return []; });
  }

  function fetchTagSubmissions() {
    return fetch("/upsmflproduction/ccc/tag_submissions.json", { mode: "cors", credentials: "omit", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j) return [];
        if (Array.isArray(j)) return j;
        if (Array.isArray(j.rows)) return j.rows;
        if (Array.isArray(j.submissions)) return j.submissions;
        return [];
      })
      .catch(function () { return []; });
  }

  function fetchTradeBaitNotes(fid) {
    if (!fid) return Promise.resolve(null);
    return fetch(workerUrl("/api/trade-bait-notes?franchiseId=" + encodeURIComponent(fid)), { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (resp) {
        if (!resp) return {};
        // Worker returns { ok, franchiseId, notes: [{ player_id, note }, ...] }
        // OR { ok, notes: { [pid]: text } }. Normalize to a flat map.
        if (resp.notes && Array.isArray(resp.notes)) {
          var map = {};
          resp.notes.forEach(function (row) {
            if (row && row.player_id) map[String(row.player_id)] = safeStr(row.note);
          });
          return map;
        }
        if (resp.notes && typeof resp.notes === "object") {
          var m = {};
          Object.keys(resp.notes).forEach(function (k) { m[String(k)] = safeStr(resp.notes[k]); });
          return m;
        }
        return {};
      })
      .catch(function () { return {}; });
  }

  // Taxi-contract repair (canon §A1; mirror of desktop's
  // repairTaxiContractFallbacks in site/rosters/roster_workbench.js).
  //
  // MFL's API suppresses contract metadata (contractYear, contractStatus,
  // contractInfo) for TAXI-squad players. Without a fallback, taxi
  // rookies surface as "expired" (contractYear=0). This walks the
  // rosters payload, looks up each taxi player's draft_year in the
  // players export, and infers years remaining on their 3yr rookie
  // contract. Synthesizes a flat Y-array contractInfo string when
  // salary is known so the contracts view has something to render.
  //
  // Mutates rostersPayload in place — all downstream consumers
  // (front_office_cap.js, contracts view, etc.) benefit.
  function repairTaxiContractsInPlace(rostersPayload, playersPayload, currentSeason) {
    if (!rostersPayload || !rostersPayload.rosters) return;
    if (!playersPayload || !playersPayload.players) return;
    var seasonInt = parseInt(currentSeason, 10) || 0;
    if (seasonInt <= 0) return;
    var draftYearById = {};
    asArray(playersPayload.players.player).forEach(function (p) {
      if (!p || p.id == null) return;
      var dy = parseInt(p.draft_year || p.draftYear, 10);
      if (!isNaN(dy) && dy > 0) draftYearById[String(p.id)] = dy;
    });
    asArray(rostersPayload.rosters.franchise).forEach(function (fr) {
      asArray(fr && fr.player).forEach(function (p) {
        if (!p || p.id == null) return;
        var dy = draftYearById[String(p.id)];
        // Apply whenever the player has empty contract data AND is in
        // their rookie window — covers both taxi players (MFL suppresses)
        // and just-promoted rookies (MFL doesn't restore contract data
        // on TAXI→ROSTER). Keith 2026-05-18.
        var inRookieWindow = !!dy && (seasonInt - dy) < 3;
        if (!inRookieWindow) return;
        var cy = parseInt(p.contractYear, 10);
        var hasYear = !isNaN(cy) && cy > 0;
        var hasInfo = !!(p.contractInfo && p.contractInfo !== "-");
        if (hasYear && hasInfo) return; // MFL data is complete; skip.
        var yearsRemaining = hasYear
          ? cy
          : Math.max(0, 3 - Math.max(0, seasonInt - dy));
        if (!hasYear && yearsRemaining > 0) {
          p.contractYear = String(yearsRemaining);
        }
        if (!p.contractStatus) {
          p.contractStatus = "Rookie";
        }
        var salaryNum = parseInt(p.salary, 10) || 0;
        if (yearsRemaining > 0 && salaryNum > 0 && !hasInfo) {
          var sK = Math.max(1, Math.round(salaryNum / 1000));
          var yearParts = [];
          for (var i = 1; i <= yearsRemaining; i += 1) {
            yearParts.push("Y" + i + "-" + sK + "K");
          }
          p.contractInfo =
            "CL " + yearsRemaining +
            "|TCV " + (sK * yearsRemaining) + "K" +
            "|AAV " + sK + "K" +
            "|" + yearParts.join(", ");
        }
      });
    });
  }

  // Trade offers (incoming + outgoing) — used both by views/trade.js for
  // the offer list and by the bottom-nav badge counter on the League tab.
  // Returns { incoming: [], outgoing: [] } even on error so the count is
  // safe to read unconditionally.
  function fetchTradeOffers(fid) {
    if (!fid) return Promise.resolve({ incoming: [], outgoing: [] });
    // Listing offers pulls MFL's pendingTrades export AS THE OWNER — the
    // worker returns 401 "missing_owner_session_mfl_user_id" (empty in/out)
    // without it. Forward MFL_USER_ID + YEAR, same as the write/action paths.
    var url = workerUrl("/api/trades/proposals?L=" +
      encodeURIComponent(state.ctx.leagueId) +
      "&YEAR=" + encodeURIComponent(state.ctx.year) +
      "&franchise_id=" + encodeURIComponent(fid) +
      // include_payload=1 → offers carry payload.extension_requests so the trade
      // cards can show pre-trade extensions (the comment-tag isn't written in prod).
      "&include_payload=1");
    var stored = getStoredMflUserId && getStoredMflUserId();
    if (stored) url += "&MFL_USER_ID=" + encodeURIComponent(stored);
    return fetch(url, { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        return {
          incoming: (j && Array.isArray(j.incoming)) ? j.incoming : [],
          outgoing: (j && Array.isArray(j.outgoing)) ? j.outgoing : []
        };
      })
      .catch(function () { return { incoming: [], outgoing: [] }; });
  }

  function loadAllData() {
    if (state.loadingPromise) return state.loadingPromise;
    // Reset error tag list so long-lived sessions don't grow it unbounded
    // and so the surface-banner only reflects the current reload's failures.
    state.loadErrors = [];
    // Snapshot the fid active at load start. The trade-bait-notes resolve
    // (the only fid-dependent step) will bail if the user switched teams
    // mid-flight to avoid applying the wrong team's notes.
    var startFid = state.viewerFranchiseId;
    state.loadingPromiseFid = startFid;
    var p = Promise.all([
      fetchJson(mflExportUrl("league")),
      fetchJson(mflExportUrl("rosters")),
      fetchJson(mflExportUrl("salaries")),
      fetchJson(mflExportUrl("salaryAdjustments")),
      fetchJson(mflExportUrl("players", { DETAILS: 1 })),
      fetchJson(mflExportUrl("tradeBait", { INCLUDE_DRAFT_PICKS: 1 })),
      fetchJson(mflExportUrl("playerScores", { W: "YTD" })).catch(function () { return null; }),
      fetchTagTracking(),
      fetchTagSubmissions(),
      fetchSalaryAdjustmentReport(state.ctx.year),
      fetchAdvancedStatsLeaderboard(state.ctx.year),
      fetchRookieProspects(state.ctx.year),
      fetchJson(mflExportUrl("draftResults")),
      fetch(workerUrl("/api/league-events?season=" + encodeURIComponent(state.ctx.year) + "&from=today&limit=30"))
        .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
      fetchMe(),
      fetchHistoricalDraftIndex(state.ctx.year),
      // Taxi call-up counter (canon §B2 + tracker Q10). One row per
      // player-with-callups; empty entries (used=0) are omitted by the
      // worker. Failure → empty object → chips render as plain "Taxi"
      // (no degradation).
      fetch(workerUrl("/api/taxi-callups"))
        .then(function (r) { return r.ok ? r.json() : { players: {} }; })
        .catch(function () { return { players: {} }; }),
      // [17] §C2 MYAC window-close date; [18] acquisition label/date map.
      // Both gate MYAC eligibility (front_office_actions.js). Fail-open:
      // "" / {} keep the app fully functional (MYAC just falls back to its
      // unknown-deadline / ERA-only behavior).
      fetchContractDeadline(state.ctx.year),
      fetchAcquisitionLookup(state.ctx.year),
      fetchInjuries()
    ]).then(function (results) {
      state.league = results[0];
      state.rosters = results[1];
      state.salaries = results[2];
      state.salaryAdjustments = results[3];
      state.players = results[4];
      // Taxi-contract fallback (mirror of
      // site/rosters/roster_workbench.js repairTaxiContractFallbacks).
      // MFL suppresses contractYear / contractInfo for TAXI-squad
      // players in its rosters payload; without this fallback Tre
      // Harris, Isaac TeSlaa, and ~20 other 2024-2025 rookies surface
      // as "expired" (contractYear=0). Compute years remaining from
      // draft_year per canon §A1 (3yr rookie deals).
      repairTaxiContractsInPlace(state.rosters, state.players, state.ctx.year);
      state.tradeBait = results[5];
      state.playerScoresYtd = results[6];
      state.tagTracking = results[7] || [];
      // Merge: canonical JSON rows + any unratified optimistic entries.
      // An optimistic entry is "ratified" when the canonical list shows
      // the same (player_id, season, submission_kind); after that we
      // drop the optimistic copy. Until then it lives alongside.
      var canonical = results[8] || [];
      var pending = Array.isArray(state.optimisticTagSubmissions) ? state.optimisticTagSubmissions : [];
      var canonKey = {};
      canonical.forEach(function (r) {
        if (!r) return;
        var k = String(r.player_id || "") + "|" + String(r.season || r.year || "") + "|" +
                String(r.submission_kind || r.kind || "tag").toLowerCase();
        canonKey[k] = true;
      });
      var stillPending = [];
      pending.forEach(function (r) {
        var k = String(r.player_id || "") + "|" + String(r.season || r.year || "") + "|" +
                String(r.submission_kind || r.kind || "tag").toLowerCase();
        if (!canonKey[k]) stillPending.push(r);
      });
      state.optimisticTagSubmissions = stillPending;
      state.tagSubmissions = canonical.concat(stillPending);
      state.salaryAdjustmentReport = results[9] || [];
      // results[10] is now { byYear, latestYearWithData } from the
      // expanded leaderboard fetcher. Older callers (FA browser) read
      // state.advancedStatsByPid which points at the latest year that
      // actually has data — so the FA list still shows meaningful PPG
      // ranks during the offseason without conflating year labels.
      var leaderboardResult = results[10] || { byYear: {}, latestYearWithData: 0 };
      state.advancedStatsByYear = leaderboardResult.byYear || {};
      state.advancedStatsLatestYear = leaderboardResult.latestYearWithData || 0;
      state.advancedStatsByPid = state.advancedStatsLatestYear
        ? (state.advancedStatsByYear[state.advancedStatsLatestYear] || {})
        : {};
      state.rookieProspects = results[11] || [];
      state.draftResults = results[12] || null;
      state.leagueEvents = results[13] || null;
      state.historicalDraftByPid = results[15] || {};
      var taxiCallupsResp = results[16] || { players: {} };
      state.taxiCallupsByPid = (taxiCallupsResp && taxiCallupsResp.players) || {};
      state.contractDeadline = results[17] || "";
      state.acquisitionByKey = results[18] || {};
      state.injuriesByPid = results[19] || {};
      parseLeague();
      resolveViewerFranchise(results[14]);
      // Now that we know the viewer franchise, fetch their UPS-side trade
      // bait notes (D1-backed). Keep state.loaded=true regardless so a
      // notes-endpoint failure doesn't gate the rest of the app.
      var notesFid = state.viewerFranchiseId;
      return Promise.all([
        fetchTradeBaitNotes(notesFid),
        fetchTradeOffers(notesFid)
      ]).then(function (pair) {
        // Race guard: if user switched teams while these were in flight,
        // discard the responses — a fresh reload is or will be running.
        if (state.viewerFranchiseId === notesFid) {
          state.tradeBaitNotes = pair[0] || {};
          state.tradeOffers = pair[1] || { incoming: [], outgoing: [] };
        }
        state.loaded = true;
        return state;
      });
    });
    state.loadingPromise = p;
    return p;
  }

  // Re-fetch league data after a roster mutation. Same shape as loadAllData
  // but skips the franchise resolution (we already know the viewer).
  function reloadData() {
    state.loadingPromise = null;
    state.loaded = false;
    state._rosteredCache = null;
    state._ytdScoresCache = null;
    // Invalidate the player sheet's bundleCache so stats reflect any
    // contract changes that just happened. The sheet module exposes
    // clearCache() once player_sheet.js has loaded.
    if (window.UPS_MOBILE && window.UPS_MOBILE.sheet && window.UPS_MOBILE.sheet.clearCache) {
      window.UPS_MOBILE.sheet.clearCache();
    }
    return loadAllData();
  }

  function parseLeague() {
    if (!state.league || !state.league.league) return;
    var lg = state.league.league;
    state.capAmount = Number(lg.salaryCapAmount || 0) || 0;
    state.franchises = asArray(lg.franchises && lg.franchises.franchise).map(function (f) {
      return {
        id: pad4(f.id),
        name: safeStr(f.name),
        // abbrev is REQUIRED for the extension-block helpers — teamIdentityTokenMap
        // reads team.name AND team.abbrev to build the matching token set. For
        // HammerTime, abbrev is the emoji "🔨 ⏰" which IS the literal Ext: token
        // appearing in contractInfo, so omitting it leaks RULE-EXT-003.
        abbrev: safeStr(f.abbrev),
        icon: safeStr(f.icon),
        logo: safeStr(f.logo),
        owner: safeStr(f.owner_name)
      };
    });
  }

  // findFranchiseById — mobile equivalent of desktop's findTeamById.
  // Used by extensionBlockedByCurrentOwner to resolve player.fid to the
  // current owning franchise's identity tokens.
  function findFranchiseById(fid) {
    var id = pad4(fid);
    if (!id) return null;
    for (var i = 0; i < state.franchises.length; i += 1) {
      if (pad4(state.franchises[i] && state.franchises[i].id) === id) return state.franchises[i];
    }
    return null;
  }

  // acquisitionForPlayer — resolve a roster player to their acquisition
  // { label, date } from the lookup loaded in loadAllData. front_office_actions.js
  // reads this to gate the MYAC fresh-FA-auction branch. Returns null when the
  // lookup is absent or the player isn't in it (→ MYAC's ERA branch still works).
  function acquisitionForPlayer(fid, pid) {
    var map = state.acquisitionByKey;
    if (!map) return null;
    var key = pad4(fid) + ":" + safeStr(pid).replace(/\D/g, "");
    return map[key] || null;
  }

  function resolveViewerFranchise(meResp) {
    // Priority: (1) /api/me, (2) localStorage rdh_my_fid (shared with desktop hubs),
    // (3) MFL_LAST_LOGIN_FRANCHISE_ID cookie, (4) MFL_USER_ID cookie match.
    var fid = "";
    if (meResp && meResp.configured && meResp.franchise_id) fid = pad4(meResp.franchise_id);
    // The commish login (0000) isn't a playing team — pinning the viewer to it
    // makes every roster / trade / offer fetch come back empty. Drop it so we
    // fall through to the remembered team (rdh_my_fid) or the franchise picker;
    // the commish then picks which team to act as (Keith 2026-06-11, mirrors the
    // desktop FO "Acting as" switcher). switchTeam() already re-opens the picker.
    if (fid === "0000") fid = "";
    if (!fid) {
      try {
        var ls = window.localStorage && window.localStorage.getItem("rdh_my_fid");
        if (ls) fid = pad4(ls);
      } catch (e) {}
    }
    if (!fid) {
      var lastLogin = readCookie("MFL_LAST_LOGIN_FRANCHISE_ID");
      if (lastLogin) fid = pad4(lastLogin);
    }
    if (!fid && state.league) {
      var fr = asArray(state.league.league && state.league.league.franchises && state.league.league.franchises.franchise);
      var userId = readCookie("MFL_USER_ID");
      if (userId) {
        for (var i = 0; i < fr.length; i++) {
          var owner = safeStr(fr[i].username || fr[i].owner_id || fr[i].owner_name);
          if (owner && owner.indexOf(userId) !== -1) {
            fid = pad4(fr[i].id);
            break;
          }
        }
      }
    }
    // Validate the resolved fid against this league's franchise list.
    // Stored rdh_my_fid persists across leagues and across reloads — if the
    // user opened a different ?L=... that fid won't exist here, so drop it
    // and fall through to the franchise picker rather than rendering an
    // empty roster + broken cap card.
    var match = fid ? state.franchises.find(function (f) { return f.id === fid; }) : null;
    if (fid && !match) {
      try { window.localStorage && window.localStorage.removeItem("rdh_my_fid"); } catch (e) {}
      fid = "";
    }
    state.viewerFranchiseId = fid;
    state.viewerFranchise = match || null;
    state.meConfigured = !!(meResp && meResp.configured);
    if (fid) {
      try { window.localStorage && window.localStorage.setItem("rdh_my_fid", fid); } catch (e) {}
    }
  }

  // Drop-penalty: delegate to the verbatim Front Office mirror so mobile
  // shows the exact same number a UPS owner sees on the desktop Roster
  // Workbench Front Office tab. Source-of-truth lives in
  // site/m/front_office_penalty.js (verbatim from roster_workbench.js).
  // Never reimplement the rules here — fix in the mirror file (and keep
  // it in sync with desktop).
  function dropPenaltyFor(rosterRow, season) {
    if (!rosterRow) return null;
    if (!window.UPS_FRONT_OFFICE || !window.UPS_FRONT_OFFICE.dropPenaltyFor) return null;
    return window.UPS_FRONT_OFFICE.dropPenaltyFor(rosterRow, season);
  }

  // ---------- Trade Bait helpers ----------
  // Canonical MFL shape (verified 2026-05-15):
  //   { tradeBaits: { tradeBait: [{ franchise_id, willGiveUp, inExchangeFor, timestamp }, ...] } }
  // willGiveUp is a CSV that can include:
  //   - player IDs (e.g. "13113")
  //   - DP_RR_PP for current-year picks (round-1, pick-1 from MFL convention)
  //   - FP_FFFF_YYYY_R for future picks (franchise, year, round)
  //   - BB_NN for blind-bid dollars
  function _tradeBaitEntries() {
    if (!state.tradeBait) return [];
    // Be defensive about both pluralized and singular root keys, since some
    // MFL endpoints return the data wrapped differently across years.
    var t = state.tradeBait;
    var root = (t.tradeBaits && t.tradeBaits.tradeBait) ||
               (t.tradeBait && t.tradeBait.tradeBait) ||
               (t.tradeBait) ||
               t;
    return asArray(root);
  }
  function getMyTradeBaitIds() {
    // Returns Set of player-id-only entries (excludes draft picks + BB$).
    var ids = new Set();
    var fid = state.viewerFranchiseId;
    if (!fid) return ids;
    _tradeBaitEntries().forEach(function (e) {
      if (!e) return;
      if (pad4(e.franchise_id || e.id || "") !== fid) return;
      var csv = safeStr(e.willGiveUp || e.will_give_up || "");
      csv.split(",").forEach(function (id) {
        var t = id.trim();
        // Skip draft pick + blind-bid tokens — they're not real player IDs.
        if (t && t.indexOf("DP_") !== 0 && t.indexOf("FP_") !== 0 && t.indexOf("BB_") !== 0) {
          ids.add(t);
        }
      });
    });
    return ids;
  }
  // Roster-level contract limits — verbatim mirror of desktop's
  // contractLimitSummaryForPlayers (roster_workbench.js:814-830). Per §6G:
  //   loaded ≤ 5 (FL/BL combined: MYAC + Ext2 + Restructure)
  //   threeYearNonRookie ≤ 6 (excludes rookie 3-yr deals)
  //
  // Per Keith 2026-05-16: the 3-year cap counts contracts with YEARS
  // REMAINING == 3 (i.e. newly-signed 3-year MYACs that haven't played
  // a year yet), not original contract length. A 3-year MYAC signed in
  // 2025 has years=2 going into 2026 and stops counting. Pre-FA-auction
  // in any given year the count is always 0 (no fresh 3-year deals yet).
  // This is the intended behavior — the cap exists to throttle MYAC
  // submissions in a single window, not to count every multi-year deal
  // in the league's history.
  function contractLimitsFor(fid) {
    var rows = getRosterFor(fid);
    var threeYearNonRookie = 0;
    var loaded = 0;
    rows.forEach(function (r) {
      if (!r) return;
      var t = safeStr(r.contractStatus).toLowerCase().replace(/[^a-z0-9]/g, "");
      var isRookie = t.indexOf("rookie") !== -1 || t === "r" || /^r-/.test(t);
      var isLoaded =
        t === "fl" ||
        t === "bl" ||
        // New canonical vocab loads contracts via a `-FL`/`-BL` SUFFIX on
        // the base type (e.g. `Vet-FAA-FL`). `t` has non-alnums stripped
        // above, so the suffix collapses to a TRAILING `fl`/`bl`. Mirror
        // of roster_workbench.js contractBucket() -fl/-bl suffix matching.
        /fl$/.test(t) ||
        /bl$/.test(t) ||
        t.indexOf("frontloaded") !== -1 ||
        t.indexOf("backloaded") !== -1;
      if (safeInt(r.contractYear, 0) === 3 && !isRookie) threeYearNonRookie += 1;
      if (isLoaded) loaded += 1;
    });
    return { loaded: loaded, threeYearNonRookie: threeYearNonRookie };
  }

  // Build a Set of all pids on ANY franchise's roster (used to identify FAs).
  // Cached on state to avoid re-scanning roster export on every render.
  function getAllRosteredPids() {
    if (state._rosteredCache) return state._rosteredCache;
    var ids = new Set();
    if (state.rosters && state.rosters.rosters) {
      var fr = asArray(state.rosters.rosters.franchise);
      fr.forEach(function (f) {
        asArray(f.player).forEach(function (p) {
          if (p && p.id) ids.add(String(p.id));
        });
      });
    }
    state._rosteredCache = ids;
    return ids;
  }

  // Build a map of pid → YTD score (number).
  function getYtdScoresMap() {
    if (state._ytdScoresCache) return state._ytdScoresCache;
    var map = {};
    if (state.playerScoresYtd && state.playerScoresYtd.playerScores) {
      asArray(state.playerScoresYtd.playerScores.playerScore).forEach(function (ps) {
        if (!ps || !ps.id) return;
        var n = Number(ps.score);
        map[String(ps.id)] = isFinite(n) ? n : 0;
      });
    }
    state._ytdScoresCache = map;
    return map;
  }

  function getMyTradeBaitNoteFor(pid) {
    if (!state.tradeBaitNotes) return "";
    return safeStr(state.tradeBaitNotes[String(pid)] || "");
  }

  function getMyTradeBaitLookingFor() {
    var fid = state.viewerFranchiseId;
    if (!fid) return "";
    var entries = _tradeBaitEntries();
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (!e) continue;
      if (pad4(e.franchise_id || e.id || "") === fid) {
        // MFL field is `inExchangeFor`; older legacy aliases kept as fallbacks.
        return safeStr(e.inExchangeFor || e.willTake || e.willTakeText || e.WILL_TAKE_TEXT || e.lookingFor || "");
      }
    }
    return "";
  }

  // Format a willGiveUp token for display:
  //   "13113"               → player name (looked up)
  //   "DP_02_05"            → "2026 R3.06" (MFL uses round-1/pick-1)
  //   "FP_0005_2027_2"      → "2027 R2 (from 0005)"
  //   "BB_10"               → "$10 BB$"
  function describeTradeBaitToken(token, year) {
    var t = safeStr(token);
    if (!t) return "";
    if (t.indexOf("DP_") === 0) {
      var parts = t.split("_");
      var r = parseInt(parts[1], 10) + 1;
      var p = parseInt(parts[2], 10) + 1;
      return safeStr(year) + " R" + r + (isFinite(p) ? "." + (p < 10 ? "0" : "") + p : "");
    }
    if (t.indexOf("FP_") === 0) {
      var p2 = t.split("_");
      // FP_FFFF_YYYY_R — round IS actual round here. Show the originating
      // franchise's NAME, not the raw id (Keith 2026-06-11) — mirrors
      // team_operations.js. Falls back to the id if the franchise isn't found.
      var fromFr = findFranchiseById(p2[1]);
      var fromLabel = (fromFr && fromFr.name) ? fromFr.name : p2[1];
      return p2[2] + " R" + p2[3] + " (from " + fromLabel + ")";
    }
    if (t.indexOf("BB_") === 0) {
      return "$" + t.slice(3) + " BB$";
    }
    // Player ID — look up name.
    var p = playerById(t);
    if (!p) return "Player " + t;
    var raw = safeStr(p.name);
    if (raw.indexOf(",") >= 0) {
      var nameParts = raw.split(",");
      return ((nameParts[1] || "").trim() + " " + (nameParts[0] || "").trim()).trim();
    }
    return raw;
  }

  // ---------- Submit actions (mirror desktop endpoints exactly) ----------
  function postJson(url, payload) {
    return fetch(url, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {})
    }).then(function (r) {
      return r.text().then(function (body) {
        var parsed = null;
        try { parsed = body ? JSON.parse(body) : null; } catch (e) {}
        if (!r.ok) {
          var msg = (parsed && (parsed.error || parsed.message)) || ("HTTP " + r.status);
          throw new Error(msg);
        }
        return parsed || {};
      });
    });
  }

  // Drop — mirrors roster_workbench.js:10794 submitRosterMove.
  // POST {worker}/roster-workbench/action with action=drop_player.
  function submitDrop(playerId, playerName) {
    var fid = state.viewerFranchiseId;
    if (!fid) return Promise.reject(new Error("No franchise"));
    if (state.busyActionKey) return Promise.reject(new Error("Another action is in progress"));
    state.busyActionKey = "drop:" + playerId;
    // Forward viewer's MFL_USER_ID via query param — required for
    // owner-restricted writes (drop_player, taxi_squad, ir). Without
    // this the worker can only use env.MFL_COOKIE (commish) which
    // silently no-ops. Same pattern desktop uses via appendViewerSessionQuery.
    var url = workerUrl("/roster-workbench/action");
    var stored = getStoredMflUserId();
    if (stored) url += (url.indexOf("?") >= 0 ? "&" : "?") + "MFL_USER_ID=" + encodeURIComponent(stored);
    return postJson(url, {
      action: "drop_player",
      league_id: state.ctx.leagueId,
      season: state.ctx.year,
      franchise_id: fid,
      player_id: String(playerId)
    }).then(function (resp) {
      state.busyActionKey = "";
      return resp;
    }).catch(function (e) {
      state.busyActionKey = "";
      throw e;
    });
  }

  // Toggle a player on/off the On-the-Block list.
  // /api/submit-trade-bait is a BULK OVERWRITE — we read the current list,
  // flip the player, and re-submit. Preserves lookingFor + other players'
  // notes. Accepts an optional per-player note when adding/updating.
  //
  // Args:
  //   playerId — pid to toggle
  //   playerName — display name (used in toast/Discord)
  //   opts.action — "add" | "remove" | undefined (auto-toggle based on current state)
  //   opts.note — string note to attach when adding/updating. Empty string = clear.
  function submitOTBToggle(playerId, playerName, opts) {
    opts = opts || {};
    var fid = state.viewerFranchiseId;
    if (!fid) return Promise.reject(new Error("No franchise"));
    if (state.busyActionKey) return Promise.reject(new Error("Another action is in progress"));
    state.busyActionKey = "otb:" + playerId;
    var pid = String(playerId);
    var current = getMyTradeBaitIds();
    var willBeOn;
    if (opts.action === "add") willBeOn = true;
    else if (opts.action === "remove") willBeOn = false;
    else willBeOn = !current.has(pid);
    if (willBeOn) current.add(pid);
    else current.delete(pid);
    var willGiveUp = [];
    current.forEach(function (id) { willGiveUp.push(id); });
    var playerNames = {};
    willGiveUp.forEach(function (id) {
      var p = playerById(id);
      playerNames[id] = safeStr(p && p.name) || id;
    });
    // Preserve existing notes for OTHER players. Only mutate the toggled
    // player's entry. If removing, drop the entry. If adding with no new
    // note text supplied, retain any existing note for that pid.
    var notes = {};
    var existing = state.tradeBaitNotes || {};
    Object.keys(existing).forEach(function (k) {
      if (k !== pid && current.has(k)) notes[k] = existing[k];
    });
    if (willBeOn) {
      if (typeof opts.note === "string") {
        // Caller passed an explicit note (possibly empty string to clear).
        if (opts.note) notes[pid] = opts.note;
      } else if (existing[pid]) {
        // No new note supplied — retain prior note if any.
        notes[pid] = existing[pid];
      }
    }
    var franchiseName = state.viewerFranchise && state.viewerFranchise.name || "";
    var lookingFor = getMyTradeBaitLookingFor();
    return postJson(workerUrl("/api/submit-trade-bait"), {
      franchiseId: fid,
      franchiseName: franchiseName,
      willGiveUp: willGiveUp,
      lookingFor: lookingFor,
      notes: notes,
      playerNames: playerNames
    }).then(function (resp) {
      state.busyActionKey = "";
      return { resp: resp, isOnBlock: willBeOn, note: notes[pid] || "" };
    }).catch(function (e) {
      state.busyActionKey = "";
      throw e;
    });
  }

  // ---------- Data shaping (mirror team_operations.js) ----------
  function playerById(id) {
    if (!state.players || !state.players.players) return null;
    var list = asArray(state.players.players.player);
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].id) === String(id)) return list[i];
    }
    return null;
  }

  // Roster + cap math: delegate to the verbatim Front Office mirror so
  // mobile shows identical numbers to desktop Team Operations.
  // Source-of-truth: site/m/front_office_cap.js (verbatim from
  // site/team_operations/team_operations.js). Never reimplement here.
  function getRosterFor(fid) {
    if (!window.UPS_FRONT_OFFICE_CAP) return [];
    return window.UPS_FRONT_OFFICE_CAP.getRosterRowsFor(state.rosters, fid);
  }
  function getAdjustmentTotalFor(fid) {
    if (!window.UPS_FRONT_OFFICE_CAP) return 0;
    return window.UPS_FRONT_OFFICE_CAP.getAdjustmentTotalFor(state.salaryAdjustments, fid);
  }
  function computeCap(fid) {
    if (!window.UPS_FRONT_OFFICE_CAP) {
      return { capAmount: 0, playerSalaryUsed: 0, adjustmentTotal: 0, capTotal: 0,
               capRoom: 0, pct: 0, taxiSalary: 0, irSalaryFull: 0, expiredSalary: 0,
               rosterCount: 0, activeCount: 0, irCount: 0, taxiCount: 0 };
    }
    return window.UPS_FRONT_OFFICE_CAP.computeCapFor(state, fid);
  }

  // ---------- Router ----------
  var routes = {};
  function registerView(name, renderFn) { routes[name] = renderFn; }

  function currentRoute() {
    var hash = (window.location.hash || "").replace(/^#/, "");
    // Default landing is the Home command center (Owner Actions), not a raw
    // roster table — the mobile redesign makes Home the front door.
    return hash || "home";
  }
  function navigate(hash) {
    if (hash[0] !== "#") hash = "#" + hash;
    if (window.location.hash !== hash) window.location.hash = hash;
    else renderRoute();
  }

  function updateNavActive(route) {
    // Match the FULL sub-route via data-subroute (longest prefix wins) so
    // #myteam/lineup vs #myteam/contracts and #league/rosters vs
    // #league/standings light the correct single tab. Routes with no nav
    // entry (e.g. #myteam/taxi, #market) leave the bar un-highlighted.
    var items = document.querySelectorAll(".ups-m-nav-item");
    var best = null, bestLen = -1;
    for (var i = 0; i < items.length; i++) {
      items[i].classList.remove("active");
      var sub = items[i].getAttribute("data-subroute") || items[i].getAttribute("data-route") || "";
      if (sub && (route === sub || route.indexOf(sub + "/") === 0) && sub.length > bestLen) {
        best = items[i];
        bestLen = sub.length;
      }
    }
    if (best) best.classList.add("active");
  }

  function renderFranchisePicker(main) {
    // Shown ONLY when /api/me couldn't resolve a franchise (no
    // MFL_USER_ID forwarded via the Switch-to-App-View button on the
    // desktop site, and no MFL session cookie on the worker domain).
    // The clean path is: log into MFL → tap "Switch to App View" → land
    // here pre-authenticated. This picker is the fallback for cold
    // visits that bypassed the desktop entry.
    // MFL-only sign-in (Keith 2026-06-08): no manual team picker — the owner
    // signs in via MFL's "Switch to App View" bounce, which forwards
    // MFL_USER_ID (one-and-done; persisted in localStorage thereafter).
    var mflHome = "https://www48.myfantasyleague.com/" +
      encodeURIComponent(state.ctx.year) + "/home/" + encodeURIComponent(state.ctx.leagueId);
    var loginIcon = window.UPS_ICONS ? window.UPS_ICONS.svg("log-in", { size: 18 }) : "";
    main.innerHTML =
      '<div class="ups-m-card">' +
        '<div class="ups-m-card-title">Sign in</div>' +
        '<div style="font-size:13px;color:var(--fg-muted);margin-bottom:12px;line-height:1.5">' +
          'Sign in through MyFantasyLeague so the app knows your franchise. Open the UPS league on MFL while logged in, then tap <b>"📱 Switch to App View."</b> You stay signed in after that.' +
        '</div>' +
        '<a class="ups-m-signin-btn" href="' + mflHome + '" target="_blank" rel="noopener">' +
          loginIcon + '<span>Sign in with MFL</span>' +
        '</a>' +
      '</div>';
  }

  function renderRoute() {
    var route = currentRoute();
    updateNavActive(route);
    var main = document.getElementById("ups-m-main");
    if (!main) return;
    var parts = route.split("/");
    var top = parts[0];
    var renderFn = routes[top];
    if (!renderFn) {
      main.innerHTML = '<div class="ups-m-stub"><h3>Coming soon</h3><div>' + escapeHtml(top) + '</div></div>';
      return;
    }
    if (!state.loaded) {
      main.innerHTML = renderSkeletonForRoute(top);
      loadAllData().then(function () { renderRoute(); }).catch(function (e) {
        main.innerHTML = '<div class="ups-m-error">Failed to load: ' + escapeHtml(e && e.message || String(e)) + '</div>';
      });
      return;
    }
    // Franchise gate: every view (except "more") requires viewerFranchiseId.
    if (!state.viewerFranchiseId && top !== "more") {
      renderFranchisePicker(main);
      updateHeader();
      return;
    }
    try {
      renderFn(main, parts.slice(1));
    } catch (e) {
      main.innerHTML = '<div class="ups-m-error">Render error: ' + escapeHtml(e && e.message || String(e)) + '</div>';
    }
    renderLoadErrorsBanner(main);
    updateHeader();
    updateNavBadges();
  }

  // Skeleton placeholder while loadAllData is in flight. Replaces the
  // generic "Loading…" with a grey-shimmer shape that roughly matches the
  // target route's content, so perceived speed feels closer to native.
  function renderSkeletonForRoute(top) {
    function row() {
      return '<div class="ups-m-skel-row">' +
        '<div class="pos ups-m-skeleton"></div>' +
        '<div class="body">' +
          '<div class="ln1 ups-m-skeleton"></div>' +
          '<div class="ln2 ups-m-skeleton"></div>' +
        '</div>' +
        '<div class="right ups-m-skeleton"></div>' +
      '</div>';
    }
    var rows = "";
    for (var i = 0; i < 7; i++) rows += row();
    var topCard = (top === "myteam")
      ? '<div class="ups-m-skel-card ups-m-skeleton"></div>'
      : '';
    return topCard + rows;
  }

  // Surface any silently-failed parallel fetches from loadAllData so a
  // half-rendered view isn't mistaken for a complete one. Inserts above
  // whatever the route already rendered.
  function renderLoadErrorsBanner(main) {
    if (!state.loadErrors || !state.loadErrors.length) return;
    var existing = main.querySelector(".ups-m-load-err-banner");
    if (existing) existing.remove();
    var banner = document.createElement("div");
    banner.className = "ups-m-load-err-banner";
    banner.innerHTML = '<span class="ico">⚠️</span>' +
      '<span class="msg">' + state.loadErrors.length + ' data source' +
      (state.loadErrors.length === 1 ? '' : 's') + ' failed — pull to retry</span>' +
      '<button class="dismiss" type="button" aria-label="Dismiss">×</button>';
    banner.title = state.loadErrors.join("\n");
    main.insertBefore(banner, main.firstChild);
    var dismiss = banner.querySelector(".dismiss");
    if (dismiss) {
      dismiss.addEventListener("click", function () {
        state.loadErrors = [];
        banner.remove();
      });
    }
  }

  function switchTeam() {
    try { window.localStorage && window.localStorage.removeItem("rdh_my_fid"); } catch (e) {}
    state.viewerFranchiseId = "";
    state.viewerFranchise = null;
    renderRoute();
  }

  // Full sign-out — clears BOTH the remembered franchise and the persisted
  // MFL session (ups_mfl_user_id). Sign-in is one-and-done (the MFL "Switch to
  // App View" bounce stores MFL_USER_ID, reused every open); this is the only
  // thing that ends it, dropping the user back to the picker / sign-in.
  function signOut() {
    try {
      window.localStorage && window.localStorage.removeItem("rdh_my_fid");
      window.localStorage && window.localStorage.removeItem("ups_mfl_user_id");
    } catch (e) {}
    state.viewerFranchiseId = "";
    state.viewerFranchise = null;
    state.meConfigured = false;
    renderRoute();
  }

  function updateHeader() {
    var title = document.getElementById("ups-m-header-title");
    var meta = document.getElementById("ups-m-header-meta");
    if (title) {
      title.textContent = state.viewerFranchise
        ? state.viewerFranchise.name
        : "UPS Mobile";
    }
    if (meta) {
      meta.textContent = state.ctx.year;
    }
  }

  function showToast(text, kind) {
    var el = document.getElementById("ups-m-toast");
    if (!el) return;
    el.textContent = text;
    el.className = "ups-m-toast show " + (kind || "");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () {
      el.className = "ups-m-toast " + (kind || "");
    }, 2400);
    // Haptic on success/error so submits feel grounded on Android.
    // (iOS Safari ignores vibrate by Apple policy — no-op there.)
    if (window.navigator && navigator.vibrate) {
      try {
        if (kind === "ok") navigator.vibrate(10);
        else if (kind === "err") navigator.vibrate([10, 40, 10]);
      } catch (e) {}
    }
    // U4 — submit-button busy state. When the "…ing" toast fires (kind=info),
    // disable every visible sheet-footer submit button so a double-tap can't
    // fire a duplicate write while the network round-trip is in flight.
    // Re-enable on kind=ok or kind=err. Safety timer guarantees we never
    // strand a stuck-disabled UI longer than 8s.
    if (kind === "info") {
      setSubmitButtonsBusy(true);
      clearTimeout(showToast._busyTimer);
      showToast._busyTimer = setTimeout(function () { setSubmitButtonsBusy(false); }, 8000);
    } else if (kind === "ok" || kind === "err") {
      clearTimeout(showToast._busyTimer);
      setSubmitButtonsBusy(false);
    }
  }

  function setSubmitButtonsBusy(busy) {
    // Targets all submit-style buttons in any open sheet, plus inline
    // confirm buttons on the trade tab (.btn-act). disabled+aria-busy
    // + a CSS class for the spinner.
    var sel = ".ups-m-sheet-foot .btn, .btn-act, .ups-m-pick-row.ups-m-busy-target";
    var btns = document.querySelectorAll(sel);
    for (var i = 0; i < btns.length; i++) {
      btns[i].disabled = !!busy;
      btns[i].setAttribute("aria-busy", busy ? "true" : "false");
      btns[i].classList.toggle("ups-m-busy", !!busy);
    }
  }

  // ---------- Stub renderers for views not yet built (Phase 2+) ----------
  function stubView(label, sub) {
    return function (mount) {
      mount.innerHTML =
        '<div class="ups-m-stub">' +
        '<h3>' + escapeHtml(label) + '</h3>' +
        '<div>' + escapeHtml(sub || "Coming in a later phase.") + '</div>' +
        '</div>';
    };
  }
  registerView("players", stubView("Players", "Free-agent browser ships in Phase 3."));
  registerView("league", stubView("League", "Rosters, standings, and On the Block ship in Phase 4."));
  registerView("more", function (mount, subParts) {
    var sub = (subParts && subParts[0]) || "";
    if (sub === "rules") {
      var header = '<div class="ups-m-card" style="margin-bottom:0">' +
        '<a href="#more" style="color:var(--accent);text-decoration:none;font-size:13px">← Back to More</a>' +
      '</div>';
      mount.innerHTML = header;
      if (window.UPS_MOBILE.rulesView && window.UPS_MOBILE.rulesView.render) {
        var slot = document.createElement("div");
        mount.appendChild(slot);
        window.UPS_MOBILE.rulesView.render(slot);
      }
      return;
    }
    var accountLine = state.viewerFranchise
      ? escapeHtml(state.viewerFranchise.name) + (state.viewerFranchise.owner ? ' · ' + escapeHtml(state.viewerFranchise.owner) : '')
      : "No team selected";
    // When /api/me resolved a real session, hide Switch Team — the worker
    // will rebind us to the authoritative fid on next load anyway, and
    // letting the picker reopen would confuse "whose data am I looking at?"
    // MFL-only auth: signed in → Sign out; signed out → Sign in with MFL.
    var mflHomeUrl = "https://www48.myfantasyleague.com/" +
      encodeURIComponent(state.ctx.year) + "/home/" + encodeURIComponent(state.ctx.leagueId);
    // Signed in (franchise resolved OR a stored token) → Sign out; only a
    // truly signed-out user sees "Sign in with MFL". Keeps this in lockstep
    // with the Home Sign-in pill so the two never disagree.
    var authBtn = (state.viewerFranchiseId || getStoredMflUserId())
      ? '<button class="ups-m-desktop-link" id="ups-m-sign-out" style="margin:8px 0 0;cursor:pointer;background:none;font-size:14px;color:var(--danger)">Sign out</button>'
      : '<a class="ups-m-signin-btn" href="' + mflHomeUrl + '" target="_blank" rel="noopener" style="margin-top:8px">' + ic("log-in", 18) + '<span>Sign in with MFL</span></a>';
    mount.innerHTML =
      '<div class="ups-m-card">' +
        '<div class="ups-m-card-title">Your team</div>' +
        '<div style="font-size:14px;margin-bottom:10px">' + accountLine + '</div>' +
        authBtn +
      '</div>' +
      '<a class="ups-m-desktop-link" href="#more/rules">' + ic("book-open") + 'Rules</a>' +
      // Explicit refresh button (Keith MobileNotesV1: previously the only
      // refresh affordance was the pull-to-refresh gesture, which Keith
      // noted "doesn't do anything" — likely because it's only visible
      // mid-pull. This button reloads everything via reloadData(). Text-only
      // (no icon) because the handler swaps its textContent during refresh.
      '<button class="ups-m-desktop-link" id="ups-m-refresh-data" style="cursor:pointer;background:none;font-size:14px">Refresh data</button>' +
      '<a class="ups-m-desktop-link" href="https://www48.myfantasyleague.com/' + escapeHtml(state.ctx.year) + '/home/' + escapeHtml(state.ctx.leagueId) + '" target="_blank" rel="noopener">' + ic("external-link") + 'Switch to Desktop View</a>' +
      '<div class="ups-m-stub"><div>UPS Mobile · ' + escapeHtml(BUILD) + '</div><div style="font-size:11px;margin-top:6px">League ' + escapeHtml(state.ctx.leagueId) + ' · ' + escapeHtml(state.ctx.year) + '</div></div>';
    var soBtn = document.getElementById("ups-m-sign-out");
    if (soBtn) soBtn.addEventListener("click", function () {
      if (window.confirm("Sign out? You'll need to sign in via MFL again to make changes.")) signOut();
    });
    var refreshBtn = document.getElementById("ups-m-refresh-data");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", function () {
        refreshBtn.disabled = true;
        var originalText = refreshBtn.textContent;
        refreshBtn.textContent = "Refreshing…";
        reloadData().then(function () {
          refreshBtn.textContent = "✓ Refreshed";
          renderRoute();
          setTimeout(function () {
            if (document.getElementById("ups-m-refresh-data")) {
              document.getElementById("ups-m-refresh-data").textContent = originalText;
              document.getElementById("ups-m-refresh-data").disabled = false;
            }
          }, 1200);
        }).catch(function () {
          refreshBtn.textContent = "Refresh failed — try again";
          refreshBtn.disabled = false;
        });
      });
    }
  });

  // ---------- Pull-to-refresh ----------
  // Touch-handler attached at boot. When the user drags the page down past
  // the threshold while scrollTop=0, fire reloadData() + re-render. Mirrors
  // the platform-standard gesture so users don't reach for browser reload.
  function installPullToRefresh() {
    if (!document.getElementById("ups-m-ptr")) {
      var ind = document.createElement("div");
      ind.id = "ups-m-ptr";
      ind.className = "ups-m-ptr";
      ind.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>';
      document.body.appendChild(ind);
    }
    var ind = document.getElementById("ups-m-ptr");
    var startY = 0, dragging = false, ready = false, busy = false;
    var THRESHOLD = 70;
    var main = document.getElementById("ups-m-main");
    if (!main) return;
    main.addEventListener("touchstart", function (e) {
      if (busy) return;
      if (window.scrollY > 0) return;
      startY = e.touches[0].clientY;
      dragging = true;
      ready = false;
    }, { passive: true });
    main.addEventListener("touchmove", function (e) {
      if (!dragging || busy) return;
      var dy = e.touches[0].clientY - startY;
      if (dy <= 0) { ind.classList.remove("show"); ready = false; return; }
      if (dy >= THRESHOLD) {
        if (!ready) {
          ind.classList.add("show");
          ready = true;
        }
      } else if (ready) {
        ind.classList.remove("show");
        ready = false;
      }
    }, { passive: true });
    main.addEventListener("touchend", function () {
      if (!dragging) return;
      dragging = false;
      if (ready && !busy) {
        busy = true;
        ind.classList.add("show", "spin");
        reloadData().then(function () {
          renderRoute();
        }).catch(function () {}).then(function () {
          setTimeout(function () {
            ind.classList.remove("show", "spin");
            busy = false;
            ready = false;
          }, 300);
        });
      } else {
        ind.classList.remove("show");
      }
    });
  }

  // ---------- Nav badges ----------
  // Red-dot indicator on the League tab when there are pending incoming
  // trade offers for the viewer. Re-computed on each render + after reload.
  function updateNavBadges() {
    // Incoming-offer indicator rides the HOME tab now — Trades lives on the
    // Home command center, and the Trades card carries the in-page alert.
    var homeAnchor = document.querySelector(".ups-m-nav-item[data-route='home'] .ups-m-nav-icon");
    if (!homeAnchor) return;
    var existing = homeAnchor.querySelector(".ups-m-nav-badge");
    if (existing) existing.remove();
    var count = countIncomingOffers();
    if (count > 0) {
      var b = document.createElement("span");
      b.className = "ups-m-nav-badge";
      b.textContent = count > 9 ? "9+" : String(count);
      homeAnchor.appendChild(b);
    }
  }
  function countIncomingOffers() {
    // pendingTrades from MFL is on state.pendingTrades — but it isn't
    // currently in loadAllData. Use the trade-bait incoming proxy: trade
    // offers live in /api/mfl-export?TYPE=pendingTrades. Cheap fallback —
    // count tradeBait entries from other franchises that mention the
    // viewer's roster pids (i.e. offers TO the viewer).
    var fid = state.viewerFranchiseId;
    if (!fid) return 0;
    if (state.tradeOffers && Array.isArray(state.tradeOffers.incoming)) {
      return state.tradeOffers.incoming.length;
    }
    return 0;
  }

  // ---------- Update check ----------
  // The mobile shell has no service worker, so a browser/Pages can serve a STALE
  // cached app.js after a deploy. Fetch the DEPLOYED version.json (no-store); if
  // its build differs from the BUILD baked into this running code, show a
  // dismissible "Update available — Reload" banner (Keith 2026-06-07).
  function checkForUpdate() {
    try {
      fetch("./version.json?_=" + Date.now(), { cache: "no-store", credentials: "omit" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (v) {
          if (!v || !v.build || String(v.build) === String(BUILD)) return;
          showUpdateBanner(String(v.build));
        })
        .catch(function () {});
    } catch (_) {}
  }
  function showUpdateBanner(newBuild) {
    if (document.getElementById("ups-m-update-banner")) return;
    var bar = document.createElement("div");
    bar.id = "ups-m-update-banner";
    bar.className = "ups-m-update-banner";
    bar.innerHTML =
      '<span class="ups-m-update-msg">⬆️ New version available</span>' +
      '<button type="button" id="ups-m-update-reload">Reload</button>' +
      '<button type="button" id="ups-m-update-dismiss" aria-label="Dismiss">✕</button>';
    document.body.appendChild(bar);
    var reload = document.getElementById("ups-m-update-reload");
    if (reload) reload.addEventListener("click", function () {
      // Bust the HTML cache too: a fresh query forces Pages to serve the newest
      // index.html (and thus the newest ?v= asset URLs). Hash is preserved.
      try { var u = new URL(window.location.href); u.searchParams.set("_v", newBuild); window.location.replace(u.toString()); }
      catch (_) { window.location.reload(); }
    });
    var dismiss = document.getElementById("ups-m-update-dismiss");
    if (dismiss) dismiss.addEventListener("click", function () { bar.remove(); });
  }

  // ---------- Boot ----------
  function boot() {
    detectContext();
    window.addEventListener("ups-cap-penalty-ready", function () { try { renderRoute(); } catch (_) {} });
    window.addEventListener("hashchange", function () {
      renderRoute();
      updateNavBadges();
    });
    renderRoute();
    installPullToRefresh();
    setTimeout(updateNavBadges, 0);
    setTimeout(checkForUpdate, 1500);   // after first paint
  }

  // ---------- Public API ----------
  window.UPS_MOBILE = {
    boot: boot,
    state: state,
    util: {
      safeStr: safeStr,
      safeInt: safeInt,
      pad4: pad4,
      escapeHtml: escapeHtml,
      fmtUsd: fmtUsd,
      fmtUsdPrecise: fmtUsdPrecise,
      asArray: asArray,
      readCookie: readCookie
    },
    api: {
      workerBase: workerBase,
      workerUrl: workerUrl,
      mflExportUrl: mflExportUrl,
      fetchJson: fetchJson,
      loadAllData: loadAllData,
      // Returns the viewer's MFL_USER_ID for URL-param forwarding on
      // owner-restricted worker writes. Stored in localStorage by the
      // mobile bootstrap (set from ?MFL_USER_ID= URL param when the
      // user clicks "Switch to App View" on the MFL site).
      getStoredMflUserId: getStoredMflUserId
    },
    data: {
      playerById: playerById,
      getRosterFor: getRosterFor,
      findFranchiseById: findFranchiseById,
      acquisitionForPlayer: acquisitionForPlayer,
      getAdjustmentTotalFor: getAdjustmentTotalFor,
      computeCap: computeCap,
      contractLimitsFor: contractLimitsFor,
      rookieSalaryForPick: rookieSalaryForPick,
      parseDraftedField: parseDraftedField,
      deriveTaxiSalary: deriveTaxiSalary,
      // Taxi call-up counter lookup (canon §B2 + tracker Q10). Returns
      // { used, max, permanent_promotion } or null if no call-ups have
      // been recorded for the player. Views use this to render the
      // "Taxi · N/3" chip + the "Promoted" indicator.
      taxiCallupsFor: function (playerId) {
        var map = state.taxiCallupsByPid || {};
        return map[String(playerId)] || null;
      },
      // Taxi-eligibility check (canon §A1 R2-5 + §B2 3yr window).
      // Returns true if the player is in their taxi-eligibility window:
      // drafted R2-5, within 3 league years of their draft, and not
      // permanently promoted. Used to gate the eligibility chip on
      // active-roster rookies + the Demote button.
      isTaxiEligibleFor: function (playerId) {
        var pid = String(playerId || "");
        if (!pid) return false;
        var callup = (state.taxiCallupsByPid || {})[pid];
        if (callup && callup.permanent_promotion) return false;
        // FAITHFUL MIRROR of the worker's taxi_eligible (worker/src/index.js
        // ~28470-28476, the value desktop trusts verbatim): use the UPS ROOKIE
        // DRAFT round/year (NOT the NFL round), R2-5 only, inside the 3-league-
        // year window. `historicalDraftByPid` (results[15]) is the merged 3-year
        // UPS draft index keyed by pid — the mobile equivalent of the worker's
        // `upsDraftByPlayer`. Trey Benson is NFL R3 but UPS R1.10 → R1 NOT
        // taxi-eligible (§A1); the old NFL-round check wrongly passed him. A
        // player absent from the index has no UPS rookie-draft record → not
        // draft-taxi-eligible.
        var ups = (state.historicalDraftByPid || {})[pid];
        if (!ups) return false;
        var draftYear = parseInt(ups.year, 10);
        var draftRound = parseInt(ups.round, 10);
        var currentSeason = parseInt(state.ctx && state.ctx.year, 10);
        if (!draftYear || !currentSeason) return false;
        if (!draftRound || draftRound < 2 || draftRound > 5) return false;  // R1 + R6 not taxi-eligible
        return (currentSeason - draftYear) < 3;
      },
      // Optimistic-update helpers — after a successful tag/untag the
      // static tag_submissions.json (ETL-regenerated on a schedule) AND
      // MFL salaries export are stale for ~minutes. Without this the UI
      // shows "Open" slot / "Tag" button even though we JUST submitted.
      // Pushes a synthetic row into BOTH the live state.tagSubmissions
      // (for the immediate render after this call) AND a sidecar list
      // (state.optimisticTagSubmissions) that survives reloadData()
      // overwrites until the canonical JSON confirms the change.
      pushOptimisticTagSubmission: function (entry) {
        if (!entry) return;
        entry.__optimistic = 1;
        if (!Array.isArray(state.tagSubmissions)) state.tagSubmissions = [];
        if (!Array.isArray(state.optimisticTagSubmissions)) state.optimisticTagSubmissions = [];
        state.tagSubmissions.push(entry);
        state.optimisticTagSubmissions.push(entry);
      },
      // Drop-penalty + contract math: delegated entirely to
      // window.UPS_FRONT_OFFICE (site/m/front_office_penalty.js).
      // Callers that need contract math should use UPS_FRONT_OFFICE.* directly
      // so we don't fork copies of the formulas across the mobile codebase.
      dropPenaltyFor: dropPenaltyFor,
      getMyTradeBaitIds: getMyTradeBaitIds,
      getMyTradeBaitLookingFor: getMyTradeBaitLookingFor,
      getMyTradeBaitNoteFor: getMyTradeBaitNoteFor,
      getAllRosteredPids: getAllRosteredPids,
      getYtdScoresMap: getYtdScoresMap,
      getAdvancedStatsFor: function (pid, year) {
        // year-specific lookup. Defaults to current year.
        var byYear = state.advancedStatsByYear || {};
        if (year != null) {
          var m = byYear[Number(year)];
          return (m && m[String(pid)]) || null;
        }
        if (!state.advancedStatsByPid) return null;
        return state.advancedStatsByPid[String(pid)] || null;
      },
      getAdvancedStatsMap: function (year) {
        if (year != null) {
          return (state.advancedStatsByYear && state.advancedStatsByYear[Number(year)]) || {};
        }
        return state.advancedStatsByPid || {};
      },
      getAdvancedStatsLatestYear: function () { return state.advancedStatsLatestYear || 0; },
      getRookieProspects: function () { return state.rookieProspects || []; },
      tradeBaitEntries: function () { return _tradeBaitEntries(); },
      describeTradeBaitToken: function (token) {
        return describeTradeBaitToken(token, state.ctx && state.ctx.year);
      }
    },
    actions: {
      submitDrop: submitDrop,
      submitOTBToggle: submitOTBToggle,
      reloadData: reloadData
    },
    route: {
      registerView: registerView,
      navigate: navigate,
      currentRoute: currentRoute,
      renderRoute: renderRoute
    },
    ui: {
      showToast: showToast,
      updateHeader: updateHeader
    }
  };
})();
