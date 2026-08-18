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
  var BUILD = "2026.08.17.5";
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

  // ── decodeEntities — ONLY for text the upstream news feed already encoded ──
  // Ported verbatim from site/team_operations/team_operations.js:84 (the
  // desktop Player News surface) when mobile's player sheet grew a News tab.
  // Same feed, same bug, so deliberately the same code rather than a second
  // dialect of it.
  //
  // The /api/player-news aggregator hands us HTML-entity-encoded prose (ESPN
  // article bodies and Sleeper notes arrive as "&#39;", "&quot;", "&amp;").
  // escapeHtml() re-encodes the ampersand first, so "&#39;" became "&amp;#39;"
  // and the browser painted the literal characters &#39; on screen:
  //   Todd Monken calls debate &#39;really silly&#39;
  // The fix is to decode ONCE, then escape. escapeHtml still runs last, so a
  // literal <script> in the feed decodes to <script> and is escaped right back
  // to &lt;script&gt; — inert.
  //
  // SECURITY: this decodes with a plain regex over an explicit ALLOWLIST and
  // never touches the DOM. Decoding via innerHTML / a detached element /
  // DOMParser parses markup, which would let a feed carrying
  // <img src=x onerror=...> turn a display fix into an injection vector on a
  // surface that renders untrusted third-party text. Nothing below builds or
  // parses a node.
  //
  // Unknown or malformed tokens ("&notanentity;", "&#999999999;") are returned
  // EXACTLY as they arrived — never dropped, never guessed at.
  // NOTE for the next editor: this literal is module-level and carries /g.
  // That is safe HERE because String.prototype.replace resets lastIndex on
  // every call — but .test()/.exec() on a /g regex do NOT, and would return
  // alternating results across calls. Use it only with .replace().
  var ENTITY_TOKEN_RE = /&(#[0-9]{1,10}|#[xX][0-9a-fA-F]{1,8}|lt|gt|quot|apos|amp);/g;
  function decodeEntities(v) {
    var s = safeStr(v);
    if (!s || s.indexOf("&") === -1) return s;
    // ONE pass, and `amp` is deliberately the LAST alternative. Order is
    // load-bearing: a decoder that resolves &amp; before the others (or that
    // chains sequential .replace() calls with &amp; anywhere but last) turns
    // "&amp;lt;" into "&lt;" and then into "<" — double-decoding, which is
    // exactly how an escaped tag climbs back out of its escaping. String
    // .replace() never re-scans the text a replacement produced, so this single
    // pass cannot double-decode: "&amp;#39;" yields the literal text "&#39;".
    return s.replace(ENTITY_TOKEN_RE, function (whole, token) {
      if (token.charAt(0) === "#") {
        var isHex = token.charAt(1) === "x" || token.charAt(1) === "X";
        var cp = parseInt(isHex ? token.slice(2) : token.slice(1), isHex ? 16 : 10);
        // Reject anything that is not a real, lone code point: NaN, zero,
        // beyond Unicode's ceiling, or a surrogate half.
        if (!isFinite(cp) || cp <= 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return whole;
        try { return String.fromCodePoint(cp); } catch (e) { return whole; }
      }
      if (token === "lt") return "<";
      if (token === "gt") return ">";
      if (token === "quot") return '"';
      if (token === "apos") return "'";
      if (token === "amp") return "&";
      return whole;
    });
  }

  // Is this a URL we are willing to put in an href?
  //
  // escapeHtml() encodes & < > " ' — it does NOT neutralise a URL SCHEME, so
  // escaping alone lets `javascript:...` through as a clickable, same-origin
  // script link. The news feed is genuinely third-party and partly
  // user-submitted (the worker aggregates six upstreams including reddit's
  // /r/nfl/new.json), and the item url is passed along unvalidated, so the
  // scheme has to be checked at the sink. http/https only; anything else
  // renders as plain text instead of a link. Protocol-relative "//host" is
  // deliberately NOT allowed — it inherits the page's scheme and reads as a
  // path to a careless reader.
  function safeHttpUrl(v) {
    // .trim() matches the desktop copy exactly. It is safe BEFORE an anchored
    // test, not after: " javascript:x" trims to "javascript:x", which still
    // fails ^https?:// and still renders as no link. Without the trim a
    // legitimate url with stray feed whitespace would silently lose its link.
    var s = safeStr(v).trim();
    return /^https?:\/\//i.test(s) ? s : "";
  }

  // Whole-K rounding here silently ate real money on the cap hero card: a
  // team at $279,500 (a $1,000 IR player contributing its rounded-DOWN half
  // salary — see front_office_cap.js) displayed as "$280K", $500 too high,
  // even after computeCapMath itself was fixed (PR #901) to stop rounding
  // the underlying total. The bug had moved from computation to display.
  // One decimal place whenever the value isn't a clean multiple of $1K —
  // same rule already proven correct for the Discord drop-penalty messages
  // (worker/src/lib/waiver_run_post.js fmtK) — fixes it without truncating
  // at some upper magnitude the way fmtUsdPrecise does. Individual player
  // salaries are always set in whole $1K per canon, so this only ever
  // surfaces on aggregates (cap totals, adjustments, penalties) — nowhere
  // does a normal salary chip start showing decimals.
  function fmtUsd(n) {
    var x = Number(n || 0);
    if (!isFinite(x)) return "$0";
    var neg = x < 0;
    var abs = Math.abs(x);
    var out;
    if (abs >= 1000) {
      var k = abs / 1000;
      out = "$" + (Number.isInteger(k) ? k : Math.round(k * 10) / 10) + "K";
    } else {
      out = "$" + Math.round(abs);
    }
    // Sign leads the whole string ("-$20.5K"), not stuck between the $ and
    // the number ("$-20.5K") — a pre-existing bug in the old whole-K path
    // too (Math.round(-20500/1000) = -20 -> "$-20K"), just never noticed
    // because capRoom rarely if ever posted as a fraction until this fix.
    return neg ? "-" + out : out;
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
    ctx: { leagueId: LEAGUE_ID_DEFAULT, year: String(new Date().getUTCFullYear()), embed: false },
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
    contractLadder: null,      // pre-season MYAC→MYM→Extension ladder boundaries. contractDeadline is an ISO day from the league calendar; seasonStartMs / mymWindowEndMs / extensionWindowEndMs are NFL Week 1/3/5 first-kickoff INSTANTS (epoch ms) from MFL's nflSchedule, with ISO twins for display only. null/"" = unknown, which is never "open". See fetchContractCalendar.
    acquisitionByKey: null,    // { "fid:pid": { label, date } } from player_acquisition_lookup_<year>.json — gates the MYAC fresh-FA-auction branch (desktop mergeAcquisitionLookupRows)
    acquisitionFromTxByKey: null, // { "fid:pid": { label, date, unix } } — waiver/FA adds parsed from MFL's live transaction log; leads the static lookup when newer (see acquisitionForPlayer)
    injuriesByPid: null,       // { pid: "IR"|"IR-PUP"|"IR-NFI"|"SUSPENDED"|"HOLDOUT"|"QUESTIONABLE"|"OUT"|"RETIRED" } from MFL injuries export — IR view §B3 "eligible to option down" bucket. Values are MFL's own strings, uppercased; do NOT assume canon's prose names appear here (there is no bare "PUP"/"NFI").
    injuriesFeedOk: false,     // did the injuries export actually READ? false ⇒ injuriesByPid is UNKNOWN, not "nobody is hurt". Never collapse the two — see fetchInjuries.
    injuriesRowCount: 0,       // rows the export returned (339 league-wide on 2026-08-15). Meaningful only when injuriesFeedOk — it distinguishes "read it, genuinely nobody" from "never got to look".
    capAmount: 0,
    // ── Waivers (in-app BBID / FCFS) ──────────────────────────────────────
    // MFL runs this league as BBID_FCFS. The worker mirrors MFL's own
    // calendar (WAIVER_BBID runs / WAIVER_NONE blackout spans) — we never
    // re-derive waiver timing locally, we only read /api/waivers/state.
    waiverState: null,          // GET /api/waivers/state payload (whole envelope)
    waiverStateAt: 0,           // ms epoch of the last successful state fetch
    waiverStatePromise: null,   // in-flight guard so tab-focus can't stampede
    waiverPending: null,        // GET /api/waivers/pending — { known, rounds }.
                                // `known:false` means we could NOT read MFL;
                                // it is never the same as "no claims".
    waiverPlan: null,           // LOCAL staged plan:
                                //   [{round, picks:[{add_pid,bid_dollars,drop_pid}], clear}]
                                // clear:true + picks:[] = "clear this round at MFL"
    waiverPlanVerified: "",     // signature of the last plan the server verified
                                // (THIS SESSION only — a plan restored from
                                // storage deliberately reads as dirty)
    waiverMflSig: null,         // mflHoldingsSignature() of what MFL was holding
                                // when this plan was last hydrated from it.
                                // PERSISTED with the plan; null = never seen,
                                // which is UNKNOWN, not "MFL holds nothing".
    waiverTargetRun: null,      // unix SECONDS of the BBID run this plan aims at
                                // to be AT MFL — set only by adoptVerifiedPlan
                                // (a submit MFL echoed back, or a /pending read
                                // of what MFL is holding), never by a local
                                // edit. PERSISTED with the plan; null = never
                                // submitted / unknown, which is NOT 0 and NOT
                                // "now". Paired with /api/waivers/state's
                                // last_run to notice that a real waiver run has
                                // since processed this plan.
    capPenaltyByPid: null,      // /api/cap-penalty/preview BATCH — authoritative drop penalties
    // ── Hot/Cold (MFL platform-wide add/drop trend, Market screen sort) ────
    // GET /api/hot-cold — MFL's own topAdds ("Who's Hot?") / topDrops
    // ("Who's Cold?") export, free agents only. Lazy: fetched only when the
    // Market screen's Hot or Cold sort tab is first tapped (see players.js),
    // never on the Market screen's default render.
    hotCold: null,               // { hot: {pid:percent}|null, cold: {pid:percent}|null,
                                  //   hotError, coldError, fetchedAt } — a null side means
                                  //   UNKNOWN (fetch failed / MFL export unreadable), never "no players"
    hotColdAt: 0,                // ms epoch of the last successful fetch
    hotColdPromise: null,        // in-flight guard so two taps can't stampede
    loaded: false,
    loadingPromise: null,
    loadingPromiseFid: "",  // fid active when current loadAllData started; race guard
    loadErrors: [],
    meConfigured: false,    // true when /api/me resolved a real session; gates mutating UI
    busyActionKey: "",
    isCommish: false,       // true iff the REAL logged-in identity is a commish franchise
    realFranchiseId: "",    // the true logged-in fid (often "0000" for commish, never used to view/roster)
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
    // Embed mode: a stripped-down chrome for one-off deep links (e.g. the
    // desktop header's Add/Drop link) opened in their own tab. Left in the
    // URL on purpose (unlike MFL_USER_ID below, embed=1 is not sensitive) so
    // a manual refresh preserves it.
    state.ctx.embed = qs.get("embed") === "1";
    if (state.ctx.embed) document.body.classList.add("ups-m-embed");
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
  // event once it passes, which would wrongly reopen the MYAC window.
  //
  // The SAME from=all read also resolves the rest of the pre-season contract
  // ladder (canon ~379 / ~1211 / ~1214, and the ladder the Discord waiver post
  // prints for exactly these players):
  //   Multi-Year Contract (MYAC)  now              → contract deadline
  //   Mid-Year Multi (MYM)        contract deadline → NFL Week 3 kickoff
  //   Extension                   Week 3 kickoff    → NFL Week 5 kickoff
  //
  // SOURCES, and why they differ:
  //   • the September contract deadline is COMMISH-OWNED — it is a league
  //     decision, it lives in the league calendar (`ups_contract_deadline`),
  //     and it is read from there.
  //   • Week 1 / Week 3 / Week 5 are NFL KICKOFFS. They are facts about the NFL
  //     schedule, not league decisions, and they come from MFL's own
  //     nflSchedule via `&kickoffs=1,3,5` on this same request — the SAME
  //     worker helper the Discord waiver post uses to print these players'
  //     windows.
  //
  // This used to read the calendar's hand-entered `nfl_kickoff`,
  // `preseason_mymdeadline` and `preseason_extensiondeadline` rows instead, and
  // they DRIFT from the real schedule: for 2026 the calendar says Week 5 = Oct 7
  // (real first kickoff Oct 8) and Week 1 = Sep 10 (Week 1 actually opens
  // WEDNESDAY Sep 9). Mobile therefore printed a different ladder than Discord
  // did for the same player, which is precisely what the feature exists to
  // prevent. The client does not fetch nflSchedule itself: TYPE=nflSchedule is
  // not on the /api/mfl-export allowlist, and adding it there would not work
  // anyway — that proxy sends league 74598 to the www48 shard, and www48
  // rejects nflSchedule. A worker-side field on a request mobile already makes
  // is both cheaper and drift-proof.
  //
  // Returns:
  //   contractDeadline                      ISO yyyy-mm-dd | ""   (calendar)
  //   seasonStartMs / mymWindowEndMs /
  //     extensionWindowEndMs                epoch ms | null       (kickoffs)
  //   seasonStart / mymWindowEnd /
  //     extensionWindowEnd                  ISO yyyy-mm-dd | ""   (the ET day
  //                                         of that kickoff — DISPLAY ONLY; the
  //                                         windows are compared against the ms
  //                                         instants, never the day)
  // A boundary that does not resolve is null/"" and the window it bounds is
  // treated as UNRESOLVED by front_office_actions.js — never as open, never
  // with a guessed date.
  function ladderEventDate(events, matches, notBefore) {
    // Events arrive date-ASC from the worker. Take the first match that is not
    // before `notBefore`.
    for (var i = 0; i < events.length; i += 1) {
      var e = events[i] || {};
      var key = String(e.event || "").toLowerCase().replace(/^ups_/, "").replace(/^preseason_/, "");
      var date = String(e.date || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      if (!matches(key)) continue;
      if (notBefore && date < notBefore) continue;
      return date;
    }
    return "";
  }
  function emptyContractLadder() {
    return {
      contractDeadline: "",
      seasonStart: "", seasonStartMs: null,
      mymWindowEnd: "", mymWindowEndMs: null,
      extensionWindowEnd: "", extensionWindowEndMs: null
    };
  }
  function kickoffMsFrom(map, week) {
    var v = map ? map[String(week)] : null;
    var n = typeof v === "number" ? v : parseInt(v, 10);
    return isFinite(n) && n > 0 ? n * 1000 : null;
  }
  function fetchContractCalendar(year) {
    var url = workerUrl("/api/league-events?season=" + encodeURIComponent(year) +
      "&from=all&limit=50&kickoffs=1,3,5");
    return fetch(url, { mode: "cors", credentials: "omit", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        var out = emptyContractLadder();
        if (!data) return out;
        var evs = data.events || [];
        out.contractDeadline = ladderEventDate(evs, function (k) {
          return k.indexOf("contract_deadline") >= 0;
        }, "");
        var ko = data.week_kickoffs || null;
        out.seasonStartMs = kickoffMsFrom(ko, 1);          // pre-season / in-season line
        out.mymWindowEndMs = kickoffMsFrom(ko, 3);         // MYM window closes
        out.extensionWindowEndMs = kickoffMsFrom(ko, 5);   // Extension window closes
        out.seasonStart = out.seasonStartMs ? isoEtDayFromUnix(out.seasonStartMs / 1000) : "";
        out.mymWindowEnd = out.mymWindowEndMs ? isoEtDayFromUnix(out.mymWindowEndMs / 1000) : "";
        out.extensionWindowEnd = out.extensionWindowEndMs ? isoEtDayFromUnix(out.extensionWindowEndMs / 1000) : "";
        return out;
      })
      .catch(function () { return emptyContractLadder(); });
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

  // LIVE waiver / free-agent acquisitions, straight from MFL's transaction log
  // → { "paddedFid:pid": { label, date, unix } }.
  //
  // Why this exists: player_acquisition_lookup_<year>.json (above) is a static
  // commish-maintained asset. The 2026 file was generated 2026-03-10, so every
  // player claimed since — including the whole August waiver run — resolves to
  // NO acquisition at all, and any rule keyed off the acquisition label or date
  // silently took the wrong branch for them. MFL's own log is authoritative and
  // current, so it leads and the static file backfills.
  //
  // Only the two ADD shapes are parsed, because they are the only ones that are
  // unambiguous from the string alone:
  //   BBID_WAIVER  "16594,|1000|16252,"  → added | bid | dropped
  //   FREE_AGENT   "16594,|16252,"       → added | dropped   (added may be
  //                                         empty — that row is a DROP, not an
  //                                         acquisition, and is skipped)
  // AUCTION_WON and TRADE are deliberately left alone: auction acquisition is
  // already resolved off contractStatus (Vet-FAA / Vet-ERA), and a trade's
  // asset lists mix players with draft picks and BBID dollars.
  //
  // Keyed by FRANCHISE + player, so an add by a PREVIOUS owner is not read as
  // the current owner's acquisition (a player waiver-claimed in March and
  // traded in June was acquired by TRADE, on trade rules).
  //
  // NOT fail-soft. Once NFL Week 1 has kicked off, an entire class of contract
  // — every WW pickup — can only be placed on the right ladder by knowing WHEN
  // it was acquired, and the static lookup cannot help: it holds ZERO rows dated
  // this season. If this read fails after Week 1 the classifier answers
  // "unknown" and withholds the action (correct), but the owner would otherwise
  // see a silently emptier Contracts tab with no indication anything was wrong.
  // A failure is pushed to state.loadErrors so the reload banner says so.
  function fetchWaiverAcquisitionIndex(year) {
    return fetchJson(mflExportUrlForYear("transactions", year))
      .then(function (j) {
        // fetchJson already recorded a transport failure (it returns null and
        // pushes to loadErrors), so don't double-count it — just stop.
        if (!j) return {};
        if (!j.transactions) throw new Error("transactions export had no transactions");
        var rows = asArray(j.transactions.transaction);
        var map = {};
        rows.forEach(function (t) {
          if (!t) return;
          var type = safeStr(t.type).toUpperCase();
          var label;
          if (type === "BBID_WAIVER") label = "WW blind-bid waiver claim";
          else if (type === "FREE_AGENT") label = "WW free-agent add (FCFS)";
          else return;
          var fid = pad4(t.franchise);
          var unix = safeInt(t.timestamp, 0);
          if (!fid || unix <= 0) return;
          var added = safeStr(t.transaction).split("|")[0];
          if (!added) return;                       // drop-only row
          var iso = isoEtDayFromUnix(unix);
          if (!iso) return;                         // unreadable → no entry, not a guess
          added.split(",").forEach(function (raw) {
            var pid = safeStr(raw).replace(/\D/g, "");
            if (!pid) return;
            var key = fid + ":" + pid;
            // Latest add for this franchise+player wins (claimed, dropped,
            // re-claimed → the re-claim is the acquisition).
            if (map[key] && map[key].unix >= unix) return;
            map[key] = { label: label, date: iso, unix: unix };
          });
        });
        return map;
      })
      .catch(function (err) {
        state.loadErrors.push("waiver acquisitions (transactions): " +
          (err && err.message ? err.message : String(err)));
        return {};
      });
  }
  // Unix seconds → the ISO calendar day in Eastern time (the timezone every UPS
  // deadline is expressed in). Returns "" rather than a fallback date.
  function isoEtDayFromUnix(unix) {
    try {
      var parts = new Date(unix * 1000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      return /^\d{4}-\d{2}-\d{2}$/.test(parts) ? parts : "";
    } catch (e) { return ""; }
  }

  // NFL injury designations (MFL injuries export) → { byPid: { pid: STATUS }, ok, rows }.
  //
  // This used to end `.catch(function () { return {}; })` and hand back a bare
  // map. That was benign while the IR view (§B3) was DISPLAY-only — an empty map
  // just meant an empty bucket. It stopped being benign the moment a WRITE hung
  // off it (Place on IR), because {} then reads as the confident statement
  // "nobody on your roster is IR-eligible" when what actually happened was that
  // we never got to look. That is precisely the fail-open shape this codebase
  // has been burned by (see rule_no_fail_open_guards): an unreadable input is
  // never "empty".
  //
  // So the three states stay distinguishable all the way to the screen:
  //   ok:true,  rows>0  — real designations, gate on them
  //   ok:true,  rows=0  — the export read fine and is genuinely empty
  //   ok:false          — UNKNOWN. Show it as unknown; do not render it as zero.
  //
  // ⚠️ THE L= TRAP — why this view showed "nobody eligible" for its whole life.
  // `injuries` is one of MFL's LEAGUE-AGNOSTIC exports and MFL rejects it when
  // L= is present at all. The rejection arrives as an HTTP **200** carrying
  // `{"error":{"$t":"Invalid request. This API request must go to
  // api.myfantasyleague.com"}}` — it parses fine, it just has no `injuries`
  // node — so nothing threw and every player read as "no designation".
  // Verified live 2026-08-15, season 2026: with L= → 0 rows; without → 339
  // (IR 32, IR-PUP 2, IR-NFI 1, Suspended 8, Holdout 2, RETIRED 19,
  // Questionable 234, Out 41). Dropping `&L=` from the URL built here does NOT
  // fix it — the worker's global pre-handler guard 400s "Missing L param"
  // first, and /api/mfl-export re-appended L= upstream regardless. The strip
  // therefore lives in the worker (`leagueAgnosticTypes`, /api/mfl-export).
  // We keep sending L= so that guard stays satisfied.
  //
  // The `!j.injuries` check below is what makes the two halves safe to deploy
  // in EITHER order: against a worker that hasn't picked up the strip yet, the
  // error envelope lands as ok:false (UNKNOWN, said out loud) instead of
  // silently reverting to the old "0 eligible" lie.
  //
  // Callers must go through DATA.irEligibilityFor(), which returns `known` so
  // "not eligible" and "we couldn't tell" can never be confused at the call
  // site. The worker re-checks §B3 server-side and fails CLOSED on its own
  // unreadable feed (IR_ELIGIBILITY_UNKNOWN), so this is honesty, not the gate.
  function fetchInjuries() {
    return fetchJson(mflExportUrl("injuries")).then(function (j) {
      // fetchJson returns null on any transport/HTTP/parse failure (and has
      // already pushed the reason onto state.loadErrors for the banner).
      // A payload with no `injuries` node at all is equally unreadable — MFL
      // error envelopes look like that — so it is UNKNOWN, not empty.
      if (!j || !j.injuries) return { byPid: {}, ok: false, rows: 0 };
      var map = {};
      var rows = asArray(j.injuries.injury);
      rows.forEach(function (it) {
        if (it && it.id != null) map[String(it.id)] = safeStr(it.status).toUpperCase();
      });
      return { byPid: map, ok: true, rows: rows.length };
    }).catch(function () { return { byPid: {}, ok: false, rows: 0 }; });
  }

  // Authoritative drop cap-penalties — /api/cap-penalty/preview in BATCH mode
  // (no player_id) returns { players: { "<pid>": { penalty, guaranteed, earned,
  // exempt, exempt_reason, ... } } } for every rostered player in the league,
  // computed by the SAME _computeDropPenalty the drop-penalty cron uses to post
  // real charges. This is the SSOT for every penalty number mobile shows —
  // the drop picker, the player-sheet Drop label, the waiver conditional-drop
  // list. site/m/front_office_penalty.js reads state.capPenaltyByPid first and
  // only falls back to its local estimate when this hasn't landed (offline /
  // worker down). Fetched once per load; fail-open to {} so a worker blip never
  // blocks boot. (Keith: the owner-facing preview must equal the actual charge.)
  function fetchCapPenaltyPreview() {
    var url = workerUrl("/api/cap-penalty/preview") +
      "?L=" + encodeURIComponent(state.ctx.leagueId) +
      "&YEAR=" + encodeURIComponent(state.ctx.year);
    return fetch(url, { mode: "cors", credentials: "omit", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { return (j && j.ok && j.players) ? j.players : {}; })
      .catch(function () { return {}; });
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
          // "Rookie-Draft" exactly — not bare "Rookie". Found by a full
          // session regression audit (2026-08-03): isTaxiEligibleFor and the
          // server's _checkR1RookieDemoteGate both require an exact
          // /^rookie-draft$/i match (a cut permanently forfeits taxi
          // eligibility, so "still on the original entry contract" has to be
          // checked precisely — see commit 394948d9). A player MFL leaves
          // blank here (this whole repair fires only when MFL suppressed the
          // contract fields, e.g. right after a taxi promotion) is by
          // definition still on that untouched entry contract, so the
          // synthesized value has to say so exactly, or this repair silently
          // hides the Demote-to-Taxi option for a genuinely eligible rookie.
          // Currently dormant (verified against live rosters: nobody is in
          // this suppressed-data state today), but a real gap the moment MFL
          // does suppress a promoted rookie's fields again.
          p.contractStatus = "Rookie-Draft";
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
      // [17] the contract-ladder calendar (§C2 MYAC close + the Week 3 / Week 5
      // boundaries + NFL Week 1); [18] acquisition label/date map. Both gate
      // contract-action eligibility (front_office_actions.js). A missing
      // boundary is UNRESOLVED, not open — see fetchContractCalendar.
      fetchContractCalendar(state.ctx.year),
      fetchAcquisitionLookup(state.ctx.year),
      fetchInjuries(),
      // [20] authoritative drop cap-penalties (batch). [21] waiver window —
      // both READ-only and fail-open; the waiver READ routes stay live even
      // when the WAIVERS_INAPP_ENABLED write flag is dark, so the UI can
      // always tell the owner what window they're in.
      fetchCapPenaltyPreview(),
      fetchWaiverState(true).catch(function () { return null; }),
      // [22] LIVE waiver/FA acquisitions from MFL's own transaction log. The
      // static lookup at [18] is regenerated by hand (the 2026 file was built
      // in March) and therefore cannot know about a claim made this week —
      // which is exactly the population whose contract window we have to get
      // right. Fail-soft to {}: the lookup + the pre-Week-1 inference still
      // answer, and an unresolvable window is refused, never widened.
      fetchWaiverAcquisitionIndex(state.ctx.year)
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
      state.contractLadder = results[17] || emptyContractLadder();
      state.contractDeadline = state.contractLadder.contractDeadline || "";
      state.acquisitionByKey = results[18] || {};
      state.acquisitionFromTxByKey = results[22] || {};
      // results[19] is { byPid, ok, rows } — the readable/empty/unknown split.
      // No `|| {}` shortcut on the envelope: a missing envelope is unknown, and
      // unknown must NOT land in state as ok:true with an empty map.
      var injuriesResp = results[19] || { byPid: {}, ok: false, rows: 0 };
      state.injuriesByPid = injuriesResp.byPid || {};
      state.injuriesFeedOk = injuriesResp.ok === true;
      state.injuriesRowCount = safeInt(injuriesResp.rows, 0);
      state.capPenaltyByPid = results[20] || {};
      // Repaint anything already on screen that was showing a fallback
      // penalty estimate before the authoritative batch landed.
      try { window.dispatchEvent(new Event("ups-cap-penalty-ready")); } catch (_) {}
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
  // { label, date }. front_office_actions.js reads this to gate the MYAC
  // fresh-FA-auction branch and the pre-season waiver ladder; null when neither
  // source knows the player (→ MYAC's ERA/FAA status branches still work).
  //
  // Two sources, newest wins: MFL's live transaction log (waiver / FA adds,
  // always current) and the static commish lookup (every acquisition KIND,
  // including trades and auctions, but only as fresh as its last rebuild).
  // Comparing ISO dates is enough — a trade recorded after a waiver claim is
  // the later acquisition and must take precedence, and vice versa.
  function acquisitionForPlayer(fid, pid) {
    var key = pad4(fid) + ":" + safeStr(pid).replace(/\D/g, "");
    var stat = (state.acquisitionByKey || {})[key] || null;
    var live = (state.acquisitionFromTxByKey || {})[key] || null;
    if (live && stat) return safeStr(live.date) >= safeStr(stat.date) ? live : stat;
    return live || stat || null;
  }

  function resolveViewerFranchise(meResp) {
    // Priority: (1) /api/me, (2) localStorage rdh_my_fid (shared with desktop hubs),
    // (3) MFL_LAST_LOGIN_FRANCHISE_ID cookie, (4) MFL_USER_ID cookie match.
    //
    // isCommish / realFranchiseId (Keith 2026-08-03, "can I as commish act on
    // mobile on behalf of another owner"): captured from the RAW /api/me
    // response BEFORE the "drop 0000" logic below, so they reflect the true
    // logged-in identity regardless of which team is currently being viewed.
    //
    // = meResp.is_commish, i.e. the server's commish ALLOWLIST check
    // ("0008,0000" — Keith's own playing team + the dedicated MFL commish
    // pseudo-login). This was ORIGINALLY narrowed to require realFranchiseId
    // === "0000" exactly, to honor Keith's separate standing rule that his
    // regular 0008 login should behave as a plain owner elsewhere in the app
    // ("when im 0008 I dont want commish functionality, i want to be a
    // regular owner" — desktop's viewerIsAdmin makes the same distinction).
    // Keith then asked specifically for Switch Team to work "whether logged
    // in as commish or not" (2026-08-03) — i.e. reachable from 0008 too, so
    // he isn't forced to log out and back in as 0000 just to help another
    // owner. That widens ONLY this one capability back to the full allowlist;
    // it does not reopen any other commish-gated behavior, since isCommish
    // has no other consumer in this file.
    state.realFranchiseId = meResp && meResp.franchise_id ? pad4(meResp.franchise_id) : "";
    state.isCommish = !!(meResp && meResp.is_commish);
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

  // Authoritative penalty row for one player straight from the cached
  // /api/cap-penalty/preview batch, or null if the batch hasn't landed.
  // Callers that just need "is this number trustworthy?" check truthiness;
  // dropPenaltyFor() already prefers this internally and only falls back to
  // the local estimate when it's null.
  function capPenaltyFor(playerId) {
    var map = state.capPenaltyByPid;
    if (!map) return null;
    return map[String(playerId).replace(/\D/g, "")] || null;
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

  // Build a Set of pids on the VIEWER'S OWN roster only — contrast with
  // getAllRosteredPids just above, which spans every franchise. Feeds the
  // Claims screen's roster-membership sweep (players.js sweepResolvedPicks):
  // a player can't simultaneously be "still awaiting a bid result" and
  // "already on my own roster", so this is an independent, unambiguous
  // signal that a staged claim already resolved.
  //
  // CORRECTION (2026-08-09, supersedes the note this replaces). The original
  // comment here claimed MFL's pendingWaivers export "keeps echoing an
  // already-processed round back". That is FALSE and was never verified: a
  // live authenticated read of TYPE=pendingWaivers for this league, taken
  // hours after a processed run, returned literally
  // {"version":"1.0","pendingWaivers":{},"encoding":"utf-8"} — MFL had
  // correctly cleared the round and was holding nothing.
  //
  // The stale thing is entirely on OUR side: the LOCAL draft plan persisted
  // under waiverPlanKey(), which outlives the run, plus two client guards that
  // between them stop it ever being reconciled away —
  //   1. players.js openClaimsScreen() only seed-fetches /pending when NOTHING
  //      is staged locally, so a stale staged claim suppresses the very read
  //      that would correct it; and
  //   2. players.js checkMflHoldingsChanged() returns early when the stored
  //      basis is null — which is exactly what a plan restored from a v1/v2
  //      on-disk record has (see getWaiverPlan below) — and even with a basis,
  //      a cold-restored plan reads as dirty (waiverPlanVerified is
  //      session-only), and the dirty branch only shows a banner.
  //
  // So this Set is a complementary FAST PATH for the WIN case: it can clear a
  // won pick the instant roster data shows it, without waiting on anything
  // else. It cannot see a LOST bid at all — the player never lands on the
  // roster — which is why the authoritative signal is the league-wide
  // last-run marker (waiverLastRun below), and this is the useful shortcut
  // beside it, not the primary mechanism.
  //
  // Reads the same state.rosters loadAllData() already fetched — no new
  // network call for the common case. Deliberately uncached (unlike
  // getAllRosteredPids): called rarely, and a stale cached Set would defeat
  // the point right after a reload.
  function getOwnRosteredPids() {
    var ids = new Set();
    if (!state.rosters || !state.rosters.rosters || !state.viewerFranchiseId) return ids;
    var fr = asArray(state.rosters.rosters.franchise);
    fr.forEach(function (f) {
      if (!f || pad4(f.id) !== pad4(state.viewerFranchiseId)) return;
      asArray(f.player).forEach(function (p) {
        if (p && p.id) ids.add(String(p.id));
      });
    });
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
          // Expired/absent app sign-in: the worker can't act as this owner, so
          // every owner write (drop/taxi/IR/lineup/trade/OTB) 4xx's with
          // MISSING_VIEWER_COOKIE. Translate that ONE technical error into a
          // mobile-actionable message — the fix is re-doing "Switch to App
          // View", not "refresh the page" as the raw worker text says. (Keith
          // 2026-07-20: HammerTime's drop button "didn't work" = a stale token.)
          var rawErr = String((parsed && (parsed.error || parsed.message)) || "");
          if ((parsed && parsed.error_code === "MISSING_VIEWER_COOKIE") ||
              /missing mfl owner session|forwards your mfl_user_id/i.test(rawErr)) {
            var authErr = new Error("Your app sign-in expired. Open the MFL site and tap “Switch to App View” to refresh your session, then try again.");
            authErr.ownerAuthExpired = true;
            throw authErr;
          }
          var msg = rawErr || ("HTTP " + r.status);
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
    // Forward the stored sign-in token — the worker's owner-identity gate
    // 401s without it ("MFL_USER_ID cookie required"). Every other mobile
    // write appends this; its absence here is why Add-to-Block always
    // failed on mobile (Shawn Blake / Puka, 2026-07-20).
    var otbUrl = workerUrl("/api/submit-trade-bait");
    var storedTok = getStoredMflUserId();
    if (storedTok) otbUrl += "?MFL_USER_ID=" + encodeURIComponent(storedTok);
    return postJson(otbUrl, {
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

  // ---------- Waivers: in-app BBID claims + FCFS adds ----------
  // Contract: worker owns ALL waiver truth. We never re-derive run times,
  // blackout spans, bid minimums or round counts — they come from
  // GET /api/waivers/state, which itself mirrors MFL's league calendar.
  //
  // Auth: owner identity is the stored MFL_USER_ID forwarded as a query param,
  // exactly like submitDrop. Mobile never uses an APIKEY. Every fetch is
  // credentials:"omit" — the worker answers with ACAO `*`, which the browser
  // rejects outright on a credentialed cross-origin request.
  function waiverUrl(path) {
    var url = workerUrl(path) +
      "?L=" + encodeURIComponent(state.ctx.leagueId) +
      "&YEAR=" + encodeURIComponent(state.ctx.year);
    var stored = getStoredMflUserId();
    // /state is public but returns the `viewer` block when it can identify us;
    // /pending and the two writes REQUIRE it.
    if (stored) url += "&MFL_USER_ID=" + encodeURIComponent(stored);
    return url;
  }

  var WAIVER_STATE_TTL_MS = 60 * 1000;

  // GET /api/waivers/state — window + limits + raw WAIVER_* calendar events.
  // Cached for a minute; refreshed on tab focus (see boot). Fail-open: on
  // error we keep whatever we had, and a null state means "unknown", which
  // renders as NO action button at all (never a dead one).
  function fetchWaiverState(force) {
    if (!force && state.waiverState && (Date.now() - state.waiverStateAt) < WAIVER_STATE_TTL_MS) {
      return Promise.resolve(state.waiverState);
    }
    if (state.waiverStatePromise) return state.waiverStatePromise;
    var p = fetch(waiverUrl("/api/waivers/state"), { mode: "cors", credentials: "omit", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        state.waiverStatePromise = null;
        if (j && j.ok) {
          state.waiverState = j;
          state.waiverStateAt = Date.now();
        }
        return state.waiverState;
      })
      .catch(function () { state.waiverStatePromise = null; return state.waiverState; });
    state.waiverStatePromise = p;
    return p;
  }

  // GET /api/waivers/pending — the claims MFL currently holds for this owner.
  //
  // CONTRACT v2 §1 — "empty" and "unknown" are DIFFERENT values:
  //   { known:true,  rounds:[...] }  we read and parsed MFL. `[]` here really
  //                                  does mean "no claims on file".
  //   { known:false, rounds:null  }  the export failed / came back in a shape
  //                                  the normalizer couldn't read. NOTHING in
  //                                  here may be adopted as truth.
  // The v1 client took `rounds:[]` as gospel either way, which silently wiped
  // owners' live, cap-spending claims off the Claims screen. Never again.
  function fetchPendingClaims() {
    return fetch(waiverUrl("/api/waivers/pending"), { mode: "cors", credentials: "omit", cache: "no-store" })
      .then(function (r) {
        return r.text().then(function (body) {
          var j = null;
          try { j = body ? JSON.parse(body) : null; } catch (e) {}
          if (!r.ok || !j || !j.ok) {
            var err = new Error(waiverErrorMessage(r.status, j));
            err.status = r.status;
            err.body = j || {};
            err.ownerAuthExpired = !!(j && j.error === "MISSING_VIEWER_COOKIE");
            throw err;
          }
          // Belt and braces: `known` is true only when the server SAYS true and
          // actually handed us an array. A degraded/older worker that omits the
          // flag therefore reads as unknown — never as "you have no claims".
          j.known = (j.known === true) && Array.isArray(j.rounds);
          if (!j.known) j.rounds = null;
          state.waiverPending = j;
          return j;
        });
      });
  }

  // Turn a waiver-route error envelope into owner-readable text.
  // MFL's own rejection string (e.g. the WAIVER_NONE blackout message) is
  // authoritative and is surfaced VERBATIM — we never paraphrase or invent
  // a reason of our own.
  function waiverErrorMessage(status, parsed) {
    if (!parsed) return "HTTP " + status;
    // ORDER IS LOAD-BEARING (P2). `mfl_response` used to be read first, but on a
    // `verify_mismatch` the write was ACCEPTED — so that field holds MFL's raw
    // SUCCESS body, which we would have shown the owner as the reason their move
    // "failed". Worse, it hid the one sentence that says whether a resend is
    // safe. The worker's own `message` (grep-verified on the fcfs
    // verify_mismatch envelope and the 401) now outranks MFL's raw body; MFL's
    // verbatim words still win for a genuine mfl_reject, which carries no
    // `message` and is the only envelope that means "nothing landed, try again".
    if (parsed.error === "MISSING_VIEWER_COOKIE") {
      return "Your app sign-in expired. Open the MFL site and tap “Switch to App View” to refresh your session, then try again.";
    }
    if (parsed.error === "waivers_inapp_disabled") {
      return "In-app waiver claims are switched off right now.";
    }
    if (parsed.error === "FRANCHISE_MISMATCH") {
      return "That claim belongs to a different franchise" +
        (parsed.detected_franchise ? " (" + parsed.detected_franchise + ")" : "") + ".";
    }
    if (parsed.error === "validation" && parsed.details && parsed.details.length) {
      return parsed.details.map(function (d) { return safeStr(d && (d.message || d.code)); })
        .filter(function (x) { return !!x; }).join(" · ");
    }
    // The worker's own owner-facing sentence — the only text that knows whether
    // a resend is safe (it distinguishes "nothing took effect" from "part of it
    // landed, do NOT resend").
    if (parsed.message) return safeStr(parsed.message);
    if (parsed.error === "verify_mismatch") {
      return "MFL accepted the write but the read-back didn't match. Check MFL before sending it again.";
    }
    // MFL's own words, verbatim — an mfl_reject means nothing landed.
    if (parsed.mfl_response) {
      return safeStr(String(parsed.mfl_response).replace(/<\/?error>/gi, "")) ||
             ("MFL rejected the request (HTTP " + (parsed.mfl_status || status) + ").");
    }
    return safeStr(parsed.error) || ("HTTP " + status);
  }

  // Waiver writes need the FULL error envelope surfaced (MFL's verbatim reject
  // text in `mfl_response`; a 503's `native_link` fallback), so they use their
  // own poster instead of postJson's message-only throw.
  function postWaiverJson(path, payload) {
    return fetch(waiverUrl(path), {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {})
    }).then(function (r) {
      return r.text().then(function (body) {
        var parsed = null;
        try { parsed = body ? JSON.parse(body) : null; } catch (e) {}
        if (r.ok && parsed && parsed.ok) return parsed;
        var err = new Error(waiverErrorMessage(r.status, parsed));
        err.status = r.status;
        err.body = parsed || {};
        err.nativeLink = safeStr(parsed && parsed.native_link);
        err.ownerAuthExpired = !!(parsed && parsed.error === "MISSING_VIEWER_COOKIE");
        throw err;
      });
    });
  }

  // POST /api/waivers/bbid-plan — CONTRACT v2 §2. This is NOT a full replace:
  //   round present with picks [...]  → written at MFL
  //   round present with picks []     → EXPLICITLY cleared at MFL
  //   round absent from `rounds`      → left exactly as it is
  // So `rounds: []` means "change nothing", and withdrawing a claim means
  // sending that round back with an empty picks list (see withdrawAllPlan).
  // v1's "absent means clear" turned every incomplete client view into a
  // silent mass-withdrawal.
  function submitWaiverPlan(plan, opts) {
    opts = opts || {};
    var fid = state.viewerFranchiseId;
    if (!fid) return Promise.reject(new Error("No franchise"));
    // Empty groups are KEPT — they ARE the clear instruction. The local-only
    // `clear` marker is not part of the wire shape.
    var rounds = (plan || []).filter(function (g) {
      return g && safeInt(g.round, 0) > 0;
    }).map(function (g) {
      return { round: safeInt(g.round, 0), picks: (g.picks || []) };
    });
    return postWaiverJson("/api/waivers/bbid-plan", {
      franchise_id: fid,
      rounds: rounds,
      dry_run: !!opts.dryRun
    });
  }

  // POST /api/waivers/fcfs — one-shot add (+ optional drops). $1K / 1-yr WW
  // comes from MFL's own league default salary row; we never write salary.
  function submitFcfs(payload) {
    payload = payload || {};
    var fid = state.viewerFranchiseId;
    if (!fid) return Promise.reject(new Error("No franchise"));
    return postWaiverJson("/api/waivers/fcfs", {
      franchise_id: fid,
      add_pid: String(payload.addPid || payload.add_pid || ""),
      drop_pids: payload.dropPids || payload.drop_pids || [],
      dry_run: !!payload.dryRun
    });
  }

  // ── The kill switch, straight from the server ─────────────────────────
  // CONTRACT v2 §5: /api/waivers/state carries `write_enabled` — the live
  // value of WAIVERS_INAPP_ENABLED. STRICT true: false, missing, or "we never
  // loaded state" all resolve to read-only, because the only thing a submit
  // button can produce in those cases is a 503.
  function waiverWriteEnabled() {
    return !!(state.waiverState && state.waiverState.write_enabled === true);
  }

  // MFL's own add/drop page — the escape hatch every read-only waiver surface
  // links to. The worker hands the same URL back as `native_link` on a dark
  // 503; we mirror it so a surface can offer the way out WITHOUT having to
  // fail a write first.
  function waiverNativeLink() {
    var st = state.waiverState;
    var fromServer = safeStr(st && st.native_link);
    if (fromServer) return fromServer;
    return "https://www48.myfantasyleague.com/" + encodeURIComponent(state.ctx.year) +
      "/add_drop?L=" + encodeURIComponent(state.ctx.leagueId);
  }

  // ── Which acquisition CTA is legal right now? ──────────────────────────
  // CONTRACT v2 §4: the SERVER decides the mode. `window.mode` is exactly one
  // of "bbid" | "fcfs" | "blackout" | "closed", mirrored from MFL's own
  // calendar. We render off that string and infer NOTHING locally.
  //
  // v1 derived the mode here and got it wrong: it returned "bbid" whenever a
  // future blind-bid run existed — which is ALWAYS true during the real FCFS
  // window (after one run, before the next) — so the FCFS branch was
  // unreachable and the league's immediate-add window was never offered.
  // That derivation is deleted, not patched.
  //
  //   bbid     → a Bid button (claim goes into the next blind-bid run)
  //   fcfs     → an Add button (immediate, one-shot)
  //   blackout / closed / unknown → NO button, context line only.
  // A mode we don't recognise, or a state we never loaded, is "unknown": a
  // dead button is worse than no button (docs/ups_v2/.../add_action_rule.md).
  //
  // Returns { mode, label, detail, writeEnabled, nativeLink }. `writeEnabled`
  // is the §5 gate: even in a live bbid/fcfs window, a dark flag means the
  // surfaces render read-only with the MFL link and no submit CTA at all.
  function waiverMode() {
    var st = state.waiverState;
    var w = st && st.window;
    var link = waiverNativeLink();
    var out = { mode: "unknown", label: "", detail: "Waiver window unavailable.",
                writeEnabled: false, nativeLink: link };
    if (!st || !w) return out;

    var mode = safeStr(w.mode);
    if (mode === "bbid") {
      out.mode = "bbid";
      out.label = "Bid";
      out.detail = "Blind bids run " +
        (w.next_bbid_run_label || waiverWhen(w.next_bbid_run_unix) || "at MFL's next scheduled run");
    } else if (mode === "fcfs") {
      out.mode = "fcfs";
      out.label = "Add";
      out.detail = "First come, first served — adds are immediate.";
    } else if (mode === "blackout") {
      out.mode = "blackout";
      var until = (w.blackout && w.blackout.end_unix) ? waiverWhen(w.blackout.end_unix) : "";
      out.detail = "No add/drops right now" + (until ? " — league blackout until " + until : "") + ".";
    } else if (mode === "closed") {
      out.mode = "closed";
      var opensAt = w.next_bbid_run_label ||
        (w.waivers_open_at_unix ? waiverWhen(w.waivers_open_at_unix) : "");
      out.detail = opensAt ? ("Waivers open " + opensAt) : "Waivers haven't opened yet.";
    } else {
      // Server sent a mode we don't know (or none at all) — stay silent
      // rather than guessing our way back into the v1 bug.
      return out;
    }

    var acquisitionWindow = (out.mode === "bbid" || out.mode === "fcfs");
    out.writeEnabled = acquisitionWindow && waiverWriteEnabled();
    if (acquisitionWindow && !out.writeEnabled) {
      out.label = "";
      out.detail += " In-app waiver moves are switched off — use MFL's own add/drop page.";
    }
    return out;
  }

  function waiverLimits() {
    var lim = state.waiverState && state.waiverState.limits;
    if (!lim) return null;
    // `limits.known` is the server's own answer to "did MFL's league export
    // actually give us these numbers?" — grep-verified in /api/waivers/state,
    // where every unread limit is NULL rather than a plausible default. The
    // numbers alone can't distinguish read from invented, so the flag is the
    // gate: known:false → null → NO bid UI (never a hardcoded minimum).
    if (lim.known !== true) return null;
    var min = safeInt(lim.bbid_minimum, 0);
    var step = safeInt(lim.bbid_increment, 0);
    var rounds = safeInt(lim.max_rounds, 0);
    // Belt and braces on the shape: a missing/zero limit means we can't build a
    // legal bid — callers treat null as "no bid UI".
    if (min <= 0 || step <= 0 || rounds <= 0) return null;
    // `conditional` is null when MFL did not say, which is not "off": pass the
    // tri-state through so a surface can stay quiet instead of asserting.
    return {
      min: min, step: step, maxRounds: rounds,
      conditional: lim.conditional === true,
      conditionalKnown: lim.conditional === true || lim.conditional === false
    };
  }

  // ── The last waiver run MFL can PROVE happened ─────────────────────────
  // Mirrors /api/waivers/state's `last_run` envelope, derived server-side from
  // MFL's own BBID_WAIVER transaction log (never from the calendar — a run TIME
  // passing says nothing about whether MFL processed anything).
  //
  // Returns { known, unix, unknown_reason }, normalised so a caller only ever
  // has to check two things:
  //   known:true  + unix:<number>  a run demonstrably happened at that second.
  //   known:true  + unix:null      the log was read and holds no run in the
  //                                lookback window — an observed absence.
  //   known:false + unix:null      unreadable, OR we are talking to a worker
  //                                that predates the field, OR we never loaded
  //                                state at all. NOT "no run happened".
  // Callers MUST do nothing at all on anything but the first case. This is the
  // fail-closed half of the Claims screen's run-based clear: an unreadable
  // input is never an empty one (rule_no_fail_open_guards).
  function waiverLastRun() {
    var lr = state.waiverState && state.waiverState.last_run;
    if (!lr || typeof lr !== "object" || lr.known !== true) {
      return {
        known: false,
        unix: null,
        unknown_reason: safeStr((lr && lr.unknown_reason) || "") ||
          (lr ? "unknown" : (state.waiverState ? "field_absent" : "state_unavailable"))
      };
    }
    var n = safeInt(lr.unix, 0);
    // `label` is the worker's ET rendering. Carried through rather than
    // re-derived: this is a league-wide 9:00 AM ET event, and formatting it
    // with the device's timezone would show a Pacific owner "6:00 AM".
    return { known: true, unix: n > 0 ? n : null, label: safeStr(lr.label), unknown_reason: "" };
  }

  // MFL's next scheduled BBID run instant (window.next_bbid_run_unix), or null
  // when the calendar has none upcoming / the state hasn't loaded. This is what
  // a freshly staged or freshly adopted plan is aiming at, and it is stamped
  // onto the plan so the plan carries its own "which run am I waiting for".
  function waiverNextRunUnix() {
    var w = state.waiverState && state.waiverState.window;
    var n = safeInt(w && w.next_bbid_run_unix, 0);
    return n > 0 ? n : null;
  }

  // NOTE (2026-08-08): there is deliberately no waiver-specific roster-ceiling
  // accessor here. `limits.roster_size` carries MFL's `rosterSize` setting,
  // which is NOT the UPS active-roster ceiling — see rosterCapMax() below and
  // the block above it. Anything needing the ceiling calls rosterCapMax().

  var WAIVER_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  // Absolute label for a unix second. Only used when the worker didn't hand us
  // a pre-formatted label (it owns ET formatting; we don't guess a timezone).
  function waiverWhen(unixSec) {
    var n = safeInt(unixSec, 0);
    if (!n) return "";
    var d = new Date(n * 1000);
    if (isNaN(d.getTime())) return "";
    var h = d.getHours();
    var ampm = h >= 12 ? "PM" : "AM";
    var h12 = h % 12; if (h12 === 0) h12 = 12;
    var mm = d.getMinutes();
    return WAIVER_MONTHS[d.getMonth()] + " " + d.getDate() + ", " + h12 +
      (mm ? ":" + (mm < 10 ? "0" + mm : mm) : ":00") + " " + ampm;
  }
  // Relative countdown, anchored to the SERVER clock (now_unix) so a skewed
  // phone clock can't show "in -3h".
  function waiverCountdown(unixSec) {
    var target = safeInt(unixSec, 0);
    if (!target) return "";
    var st = state.waiverState;
    var serverNow = safeInt(st && st.now_unix, 0);
    var base = serverNow || Math.floor(Date.now() / 1000);
    var drift = serverNow ? Math.floor((Date.now() - state.waiverStateAt) / 1000) : 0;
    var secs = target - (base + Math.max(0, drift));
    if (secs <= 0) return "now";
    var days = Math.floor(secs / 86400);
    var hours = Math.floor((secs % 86400) / 3600);
    var mins = Math.floor((secs % 3600) / 60);
    if (days > 0) return "in " + days + "d " + hours + "h";
    if (hours > 0) return "in " + hours + "h " + mins + "m";
    return "in " + Math.max(1, mins) + "m";
  }

  // ── Local staged plan ─────────────────────────────────────────────────
  // Picks are staged locally first (the Bid sheet never writes), then the
  // Claims screen submits the whole plan in one POST. Persisted per
  // league+season+franchise so closing the PWA doesn't lose staged work.
  function waiverPlanKey() {
    return "ups_waiver_plan_" + state.ctx.leagueId + "_" + state.ctx.year + "_" +
      (state.viewerFranchiseId || "none");
  }
  function planSignature(plan) {
    // Order-sensitive: reordering picks inside a group IS a real change
    // (MFL honours claim order within a round). A pending CLEAR is part of the
    // signature too — "withdraw group 2" is an unsubmitted edit like any other.
    return JSON.stringify((plan || []).map(function (g) {
      return [safeInt(g.round, 0), g.clear ? 1 : 0, (g.picks || []).map(function (p) {
        return [String(p.add_pid || ""), safeInt(p.bid_dollars, 0), String(p.drop_pid || "")];
      })];
    }));
  }
  // Signature of what MFL ITSELF is holding, taken from a `{known, rounds}`
  // envelope (/pending, or a submit's `verified` block). This is the basis the
  // Claims screen compares against to notice that MFL's copy moved underneath
  // it — a waiver run processing, another device, the commish.
  //
  // Returns null — not "", not "[]" — for anything that is not `known:true`.
  // An unreadable MFL read is UNKNOWN and must compare neither equal nor
  // unequal to anything (contract v2 §1); callers check for a string.
  //
  // Deliberately NOT planSignature. Rounds are a SET keyed by round number, so
  // they are sorted: two reads of an unchanged MFL that come back in a
  // different round order must not read as a change. Pick order INSIDE a round
  // is left alone — that order is MFL's claim priority, so a reshuffle there
  // is a genuine change. planSignature answers "did the owner edit" and stays
  // fully order-sensitive; this one answers "is MFL holding the same thing".
  function mflHoldingsSignature(block) {
    if (!block || block.known !== true || !Array.isArray(block.rounds)) return null;
    var rounds = (block.rounds || []).map(function (g) {
      return [safeInt(g.round, 0), (g.picks || []).map(function (p) {
        return [String(p.add_pid || ""), safeInt(p.bid_dollars, 0), String(p.drop_pid || "")];
      })];
    }).filter(function (g) { return g[0] > 0 && g[1].length; });
    rounds.sort(function (a, b) { return a[0] - b[0]; });
    return JSON.stringify(rounds);
  }
  // The in-memory copy is keyed so a team switch (or a season/league change)
  // can never surface the previous franchise's staged claims.
  var _waiverPlanCacheKey = "";
  function getWaiverPlan() {
    var key = waiverPlanKey();
    if (state.waiverPlan && _waiverPlanCacheKey === key) return state.waiverPlan;
    var stored = null;
    try {
      var raw = window.localStorage && window.localStorage.getItem(key);
      if (raw) stored = JSON.parse(raw);
    } catch (e) { stored = null; }
    // Three on-disk shapes, read in one place so they can't drift:
    //   { plan:[...], mfl:"<sig>", target_run:<unix|null> }
    //                                current — the plan, the MFL holdings it
    //                                was hydrated against, and WHICH BBID RUN
    //                                it is aiming at, stored together so a
    //                                restored plan can never be paired with a
    //                                basis (or a target) from some other read.
    //   { plan:[...], mfl:"<sig>" }  v2, written before target_run existed.
    //   [...]                        v1, written before the basis existed.
    // A missing/blank basis stays null: UNKNOWN, never "MFL was holding
    // nothing". Callers do nothing at all with null rather than infer a change
    // that may not have happened. Same for target_run — a record without one
    // reads as null (we do not know which run this plan was for), NEVER 0.
    // 0 would sit before every run in history, so the run-based clear would
    // read any run at all as having processed this plan, and wipe a live one.
    if (stored && !Array.isArray(stored) && Array.isArray(stored.plan)) {
      state.waiverPlan = stored.plan;
      state.waiverMflSig = (typeof stored.mfl === "string") ? stored.mfl : null;
      state.waiverTargetRun =
        (typeof stored.target_run === "number" && isFinite(stored.target_run) && stored.target_run > 0)
          ? stored.target_run : null;
    } else {
      state.waiverPlan = Array.isArray(stored) ? stored : [];
      state.waiverMflSig = null;
      state.waiverTargetRun = null;
    }
    _waiverPlanCacheKey = key;
    // A plan loaded from storage was never echoed back by the server in THIS
    // session, so it reads as "edited — not submitted" until a submit or a
    // /pending fetch establishes a clean baseline. That's the safe default:
    // better to prompt a redundant submit than to imply MFL has claims it
    // doesn't.
    return state.waiverPlan;
  }
  // A group in the plan is one of two things:
  //   picks:[...]              → claims to write for that round
  //   picks:[] + clear:true    → an EXPLICIT "clear this round at MFL"
  // The second kind MUST survive here. v1 filtered every empty group out, so
  // an owner who deleted their only claim produced a plan the round was simply
  // ABSENT from — which under contract v2 §2 means "leave it alone", i.e. the
  // claim they just withdrew would quietly stay live and keep spending cap.
  //
  // `opts.targetRun` is the ONLY way to move the target-run marker from
  // outside this module, and it is deliberately opt-in: an ordinary
  // setPlan(plan) — notably the Claims screen's resolved-pick sweep — leaves
  // the target exactly where it was, because filtering already-won picks out
  // of a plan does not change WHICH RUN the rest of it is waiting for. Pass
  // `{ targetRun: null }` to forget it (the run-based clear does this: the
  // board it leaves behind is empty and aimed at nothing). It rides in the
  // same single write as plan + mfl.
  function setWaiverPlan(plan, opts) {
    _waiverPlanCacheKey = waiverPlanKey();
    if (opts && Object.prototype.hasOwnProperty.call(opts, "targetRun")) {
      var tr = opts.targetRun;
      state.waiverTargetRun =
        (typeof tr === "number" && isFinite(tr) && tr > 0) ? Math.floor(tr) : null;
    }
    state.waiverPlan = (Array.isArray(plan) ? plan : []).filter(function (g) {
      if (!g || safeInt(g.round, 0) <= 0) return false;
      if (g.picks && g.picks.length) return true;
      return g.clear === true;
    }).map(function (g) {
      var picks = (g.picks || []);
      return { round: safeInt(g.round, 0), picks: picks, clear: !picks.length };
    });
    try {
      if (window.localStorage) {
        // The MFL basis AND the submitted-at stamp ride in the SAME record as
        // the plan — one key, one write, so the three can never be restored out
        // of step with each other. Local edits do not disturb either one: "what
        // MFL was holding when we last looked" and "when this plan was last at
        // MFL" are facts about MFL, not about the draft on top of it.
        window.localStorage.setItem(waiverPlanKey(), JSON.stringify({
          plan: state.waiverPlan,
          mfl: (typeof state.waiverMflSig === "string") ? state.waiverMflSig : null,
          target_run:
            (typeof state.waiverTargetRun === "number" && isFinite(state.waiverTargetRun) &&
             state.waiverTargetRun > 0)
              ? state.waiverTargetRun : null
        }));
      }
    } catch (e) {}
    return state.waiverPlan;
  }
  function waiverPickCount() {
    return getWaiverPlan().reduce(function (n, g) { return n + ((g.picks || []).length); }, 0);
  }
  // How many rounds are staged for an explicit clear (a pending withdrawal).
  // These carry no picks, so pickCount() can't see them — but they ARE
  // submittable work, and the Submit CTA has to know that.
  function waiverClearCount() {
    return getWaiverPlan().filter(function (g) {
      return g.clear && !(g.picks && g.picks.length);
    }).length;
  }
  // The payload that withdraws EVERYTHING: every round we have reason to think
  // is live, sent with picks:[] (contract v2 §2 — clearing is explicit, never
  // implied by absence). Prefers the rounds MFL actually reported; when the
  // pending read is UNKNOWN we fall back to every legal round, so nothing can
  // hide behind a failed read.
  function waiverWithdrawAllPlan() {
    var seen = {};
    var pend = state.waiverPending;
    if (pend && pend.known === true && Array.isArray(pend.rounds)) {
      pend.rounds.forEach(function (g) {
        var r = safeInt(g.round, 0);
        if (r > 0 && (g.picks || []).length) seen[r] = true;
      });
    } else {
      var lim = waiverLimits();
      var max = lim ? lim.maxRounds : 0;
      for (var i = 1; i <= max; i++) seen[i] = true;
    }
    getWaiverPlan().forEach(function (g) {
      var r = safeInt(g.round, 0);
      if (r > 0) seen[r] = true;
    });
    return Object.keys(seen).map(function (k) { return safeInt(k, 0); })
      .sort(function (a, b) { return a - b; })
      .map(function (r) { return { round: r, picks: [], clear: true }; });
  }
  // "edited — not submitted": the staged plan differs from whatever the server
  // last echoed back in its `verified` block.
  function waiverPlanDirty() {
    return planSignature(getWaiverPlan()) !== state.waiverPlanVerified;
  }
  // Adopt the server's block as both the local plan and the clean baseline.
  //
  // CONTRACT v2 §1/§3 — takes the WHOLE block, `{ known, rounds }`, never a
  // bare array, and adopts ONLY when `known === true`:
  //   known:false (failed or unparseable MFL read)  → keep the local plan,
  //                                                   caller shows a warning
  //   dry runs (verified is always known:false)     → nothing to adopt; the
  //                                                   caller renders would_write
  // v1 called this with `resp.verified.rounds || []` and treated the resulting
  // `[]` as truth — so one unreadable MFL response erased an owner's live
  // claims from their screen. Returns true only when the plan was replaced.
  function adoptVerifiedPlan(block) {
    if (!block || block.known !== true || !Array.isArray(block.rounds)) return false;
    var rounds = block.rounds;
    var normalized = (rounds || []).map(function (g) {
      return {
        round: safeInt(g.round, 0),
        picks: (g.picks || []).map(function (p) {
          return {
            add_pid: String(p.add_pid || ""),
            bid_dollars: safeInt(p.bid_dollars, 0),
            drop_pid: p.drop_pid ? String(p.drop_pid) : null
          };
        })
      };
    }).filter(function (g) { return g.round > 0 && g.picks.length; });
    // Record what MFL was holding at THIS hydration before the plan is written
    // — setWaiverPlan persists the three together. This is the basis the Claims
    // screen later re-reads MFL against to notice its copy has moved.
    state.waiverMflSig = mflHoldingsSignature(block);
    // …and WHEN. This is the only place the stamp is ever set, and it is set
    // here rather than at the submit call site because this is the function
    // that runs when the SERVER has echoed back what it actually wrote (a
    // submit's `verified` block) or what it is actually holding (a /pending
    // read). Either way the plan below is, as of this instant, MFL's own copy.
    //
    // A purely local edit (staging a bid, reordering, Remove) never reaches
    // here — those go through commitPlan → setWaiverPlan(plan) with no opts —
    // so an unsubmitted draft never acquires a stamp and can never be mistaken
    // for something a waiver run has processed.
    // Which run is this plan waiting for? MFL's own next scheduled BBID
    // instant, straight off the calendar the server already read — NOT a
    // device clock reading. Both sides of the staleness test (this, and
    // last_run.unix) then come from the same MFL calendar, so a skewed phone
    // clock cannot make a live plan look processed. There is no arithmetic on
    // "now" anywhere in the comparison.
    setWaiverPlan(normalized, { targetRun: waiverNextRunUnix() });
    state.waiverPlanVerified = planSignature(state.waiverPlan);
    return true;
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

  // THE mobile active-roster ceiling. Every mobile surface that needs one
  // calls this — displays (home.js, contracts.js) and the waiver "No drop"
  // gate (views/players.js rosterHeadroom()) alike. Do not add a second.
  //
  // 35 pre-deadline, 30 after (canon docs/league_context_v1.md §B1 ~302:
  // "Size: 27 (min, at close of auction) – 30 (max, after contract deadline)",
  // "Auction window: 27 (close min) – 35 (max)"). The boundary is the
  // September contract deadline — the SAME date state.contractDeadline already
  // carries for the MYAC window. Mirrors team_operations.js rosterCaps()
  // (~1020), which resolves the identical boundary off its own desktop-only
  // findEvent(["ups_contract_deadline"]) helper; this reads the ISO string
  // mobile already has instead, since that's simpler here than porting
  // desktop's calendar-event lookup. ISO dates ("YYYY-MM-DD") compare
  // correctly as plain strings — no Date parsing/TZ handling needed. Falls
  // back to a fixed Sept 6 boundary if the deadline hasn't loaded yet, same
  // fallback team_operations.js uses.
  //
  // This is an ACTIVE ceiling, so it may only ever be compared against an
  // ACTIVE count (computeCap().activeCount = roster − IR − taxi). Neither IR
  // nor taxi bodies occupy an active spot. team_operations.js ~3198 has the
  // scar from getting that wrong: an owner with 28 active + 3 IR + 7 taxi was
  // told "38 rostered · max 30".
  //
  // NOT MFL's `rosterSize` (league export → worker _wvRosterLimit →
  // limits.roster_size). That number is not the UPS rule and never was:
  // team_operations.js ~1020 records it reading "50" — offseason trading
  // headroom — which is why desktop stopped trusting it. It happens to read 35
  // right now, and it will NOT fall to 30 on its own when the contract
  // deadline passes, so anything gated on it silently stops working from
  // September onward. If you are here to "restore" it: don't.
  function rosterCapMax() {
    var dl = state.contractDeadline;
    var afterDeadline;
    if (dl) {
      var today = new Date().toISOString().slice(0, 10);
      afterDeadline = today >= dl;
    } else {
      var now = new Date();
      afterDeadline = (now.getUTCMonth() > 8) || (now.getUTCMonth() === 8 && now.getUTCDate() >= 6);
    }
    return afterDeadline ? 30 : 35;
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

  // Select which franchise the commish is currently acting as. Same-object
  // fields resolveViewerFranchise sets, updated in place so every view that
  // already reads state.viewerFranchiseId picks the change up on the very
  // next renderRoute() — no data reload needed, since loadAllData already
  // pulled league-wide rosters/salaries/etc., not a per-franchise slice.
  function selectTeamAsCommish(fid) {
    var padded = pad4(fid);
    var match = state.franchises.find(function (f) { return f.id === padded; });
    if (!match) return;
    state.viewerFranchiseId = padded;
    state.viewerFranchise = match;
    try { window.localStorage && window.localStorage.setItem("rdh_my_fid", padded); } catch (e) {}
    renderRoute();
  }

  function renderFranchisePicker(main) {
    // Shown ONLY when /api/me couldn't resolve a franchise (no
    // MFL_USER_ID forwarded via the Switch-to-App-View button on the
    // desktop site, and no MFL session cookie on the worker domain) —
    // OR (below) when a real commish session has no team selected yet.
    // The clean path is: log into MFL → tap "Switch to App View" → land
    // here pre-authenticated. This picker is the fallback for cold
    // visits that bypassed the desktop entry.
    // MFL-only sign-in (Keith 2026-06-08): no manual team picker for a
    // REGULAR owner — they sign in via MFL's "Switch to App View" bounce,
    // which forwards MFL_USER_ID (one-and-done; persisted in localStorage
    // thereafter), and /api/me always resolves back to their own exact team.
    //
    // The COMMISH is the one case that genuinely needs a manual list (Keith
    // 2026-08-03, "can I as commish act on mobile on behalf of another
    // owner... whether logged in as commish or not"): reachable from EITHER
    // of Keith's logins — the dedicated 0000 pseudo-account (whose /api/me
    // can never hand back a specific playing fid at all) or his own 0008 —
    // so he isn't forced to log out and back in as 0000 just to help another
    // owner. state.isCommish/realFranchiseId are set in resolveViewerFranchise
    // from the raw /api/me response, independent of whatever team is (or isn't)
    // currently selected, so this branch is reachable even with no
    // viewerFranchiseId yet.
    if (state.isCommish) {
      var rows = (state.franchises || []).slice().sort(function (a, b) {
        return String(a.name).localeCompare(String(b.name));
      }).map(function (f) {
        return '<button class="ups-m-team-pick" data-fid="' + escapeHtml(f.id) + '">' +
          escapeHtml(f.name) + (f.owner ? ' <span class="owner">· ' + escapeHtml(f.owner) + '</span>' : '') +
        '</button>';
      }).join("");
      main.innerHTML =
        '<div class="ups-m-card">' +
          '<div class="ups-m-card-title">Act as which team?</div>' +
          '<div style="font-size:13px;color:var(--fg-muted);margin-bottom:10px;line-height:1.5">' +
            'You\'re signed in as commish. Pick a franchise to view its roster and submit contract moves on its behalf — every submission is recorded as a commish action.' +
          '</div>' +
          '<div class="ups-m-team-pick-list">' + rows + '</div>' +
        '</div>';
      Array.prototype.forEach.call(main.querySelectorAll("[data-fid]"), function (btn) {
        btn.addEventListener("click", function () { selectTeamAsCommish(btn.getAttribute("data-fid")); });
      });
      return;
    }
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
      // Embed mode's Close/fallback affordance must not wait on data load --
      // the nav is already hidden by boot() the instant embed=1 is seen, so
      // without this the user has zero way out during the load window.
      if (state.ctx.embed) updateHeader();
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
    // Navigate OFF "more" rather than re-rendering in place. The franchise
    // gate in renderRoute() deliberately exempts the "more" route (so a
    // signed-out user can still reach Sign in / Sign out from it) — which is
    // exactly the route this button lives on, so a bare renderRoute() here
    // would just repaint "more" with "No team selected" and never show the
    // team picker at all. "#home" hits the gate and renderFranchisePicker
    // branches to the commish team list since state.isCommish is still true.
    navigate("#home");
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
    if (state.ctx.embed) {
      if (title) title.textContent = "Add / Drop";
      if (meta && !document.getElementById("ups-m-embed-close")) {
        meta.textContent = "";
        var wrap = document.createElement("div");
        wrap.className = "ups-m-embed-actions";
        var closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.id = "ups-m-embed-close";
        closeBtn.className = "ups-m-embed-close";
        closeBtn.setAttribute("aria-label", "Close");
        closeBtn.title = "Close, back to MFL";
        closeBtn.textContent = "✕ Close";
        closeBtn.addEventListener("click", function () { window.close(); });
        wrap.appendChild(closeBtn);
        // Fallback for browsers that refuse to script-close a tab they did
        // not open via window.open() -- notably Safari (desktop + every
        // iOS browser, which all run on WebKit). Verified this session:
        // window.close() DOES work in Chromium here, including after an
        // in-app hash route change, but Safari has long been stricter about
        // this regardless of history length. A one-tap way back must not
        // depend on Close actually working.
        var mflLink = document.createElement("a");
        mflLink.className = "ups-m-embed-desktop-link";
        mflLink.href = "https://www48.myfantasyleague.com/" +
          encodeURIComponent(state.ctx.year) + "/home/" + encodeURIComponent(state.ctx.leagueId);
        mflLink.textContent = "MFL";
        mflLink.title = "If Close didn't work, open MFL here";
        wrap.appendChild(mflLink);
        meta.appendChild(wrap);
      }
      return;
    }
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
        // subParts[1] is a rule anchor — #more/rules/s1-b2 opens the rulebook
        // scrolled to B2 Taxi Squad. That's what the per-rule "Copy link"
        // button hands out, so a link pasted into Discord lands on the rule.
        window.UPS_MOBILE.rulesView.render(slot, (subParts && subParts[1]) || "");
      }
      return;
    }
    var accountLine = state.viewerFranchise
      ? escapeHtml(state.viewerFranchise.name) + (state.viewerFranchise.owner ? ' · ' + escapeHtml(state.viewerFranchise.owner) : '')
      : "No team selected";
    // Switch Team stays hidden for a REGULAR owner — the worker rebinds them
    // to their one authoritative fid on next load regardless, so reopening the
    // picker would just confuse "whose data am I looking at?" with no real
    // choice behind it. The COMMISH is the one real exception, and shows this
    // from EITHER of Keith's logins (2026-08-03: "whether logged in as
    // commish or not") — same as desktop's "Acting as" switcher.
    var switchTeamBtn = state.isCommish
      ? '<button class="ups-m-desktop-link" id="ups-m-switch-team" style="margin:4px 0 0;cursor:pointer;background:none;font-size:14px">Switch team (commish)</button>'
      : "";
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
        switchTeamBtn +
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
    var stBtn = document.getElementById("ups-m-switch-team");
    if (stBtn) stBtn.addEventListener("click", switchTeam);
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
  function registerServiceWorker() {
    // Cache the app shell so opens don't pay 27 network round-trips against GitHub Pages'
    // 10-min cache. Registered after `load` so it never competes with the first paint.
    if (!("serviceWorker" in navigator)) return;
    window.addEventListener("load", function () {
      try { navigator.serviceWorker.register("./sw.js").catch(function () {}); } catch (_) {}
    });
  }
  function boot() {
    registerServiceWorker();
    detectContext();
    window.addEventListener("ups-cap-penalty-ready", function () { try { renderRoute(); } catch (_) {} });
    window.addEventListener("hashchange", function () {
      // The waiver overlays are appended to #ups-m-app, a SIBLING of the
      // #ups-m-main that renderRoute() repaints — so navigating (Android Back,
      // a nav-bar tap) used to swap the route silently UNDERNEATH a still-open
      // full-screen overlay. Back appeared to do nothing, and the overlay's ‹
      // then dropped you on a screen you never chose. Dismiss them first.
      // #players/claims is the one route that legitimately owns an overlay.
      if (currentRoute() !== "players/claims" &&
          window.UPS_MOBILE && window.UPS_MOBILE.waiverUI &&
          window.UPS_MOBILE.waiverUI.dismissOverlays) {
        window.UPS_MOBILE.waiverUI.dismissOverlays();
      }
      renderRoute();
      updateNavBadges();
    });
    // Waiver windows move on their own (a 9:00 AM BBID run flips the CTA from
    // Bid to Add; a WAIVER_NONE span opens/closes). Re-check whenever the PWA
    // comes back to the foreground, and repaint if anything actually changed
    // so nobody taps a button the league no longer allows.
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState !== "visible") return;
      var before = JSON.stringify((state.waiverState && state.waiverState.window) || null);
      fetchWaiverState(true).then(function (st) {
        var after = JSON.stringify((st && st.window) || null);
        if (before !== after) { try { renderRoute(); } catch (_) {} }
      });
    });
    renderRoute();
    installPullToRefresh();
    setTimeout(updateNavBadges, 0);
    setTimeout(checkForUpdate, 1500);   // after first paint
  }

  // Is the CURRENT submission a commish acting on someone else's behalf?
  // FAITHFUL MIRROR of desktop's `commish_override_flag = !!me.isAdmin &&
  // me.franchise_id !== p.fid` (site/rosters/v2/front_office.js:2956/4369).
  // One shared helper rather than repeating the expression at every submit
  // call site — every mobile submit used to hardcode commishOverride:false,
  // which under-reported every commish-on-behalf-of action in the audit
  // trail (Keith 2026-08-03).
  function isCommishOverride() {
    return !!state.isCommish && !!state.viewerFranchiseId && state.viewerFranchiseId !== state.realFranchiseId;
  }

  // ---------- Hot/Cold (MFL platform-wide "who's trending" sort) ----------
  // GET /api/hot-cold mirrors MFL's own topAdds/topDrops exports — free
  // agents only, most-added ("Hot") / most-dropped ("Cold") across every
  // MFL-hosted league this week. The worker already caches this for 30
  // minutes at the edge, so this client cache just avoids re-fetching on
  // every tab tap within a session; it does not need to be tight.
  var HOT_COLD_TTL_MS = 5 * 60 * 1000;

  // Lazy on purpose — only called from players.js when the owner actually
  // taps the Hot or Cold sort button, never from the Market screen's
  // unconditional render/boot path (this is not needed for the default view).
  function fetchHotCold(force) {
    if (!force && state.hotCold && (Date.now() - state.hotColdAt) < HOT_COLD_TTL_MS) {
      return Promise.resolve(state.hotCold);
    }
    if (state.hotColdPromise) return state.hotColdPromise;
    var reqUrl = workerUrl("/api/hot-cold") +
      "?L=" + encodeURIComponent(state.ctx.leagueId) +
      "&YEAR=" + encodeURIComponent(state.ctx.year);
    var p = fetch(reqUrl, { mode: "cors", credentials: "omit", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        state.hotColdPromise = null;
        // Contract (worker /api/hot-cold): hot/cold are independently
        // known/unknown. known:true + players:[...] → a real map, [] included.
        // known:false + players:null → UNKNOWN — never fall back to {} here,
        // an empty map would read to the UI as "nobody is trending" instead
        // of "couldn't read MFL".
        var hotMap = null, coldMap = null, hotError = "", coldError = "";
        if (j && j.hot && j.hot.known === true && Array.isArray(j.hot.players)) {
          hotMap = {};
          j.hot.players.forEach(function (row) {
            var pid = safeStr(row && row.id);
            var pct = Number(row && row.percent);
            if (pid && isFinite(pct)) hotMap[pid] = pct;
          });
        } else {
          hotError = safeStr(j && j.hot && j.hot.error) || "Couldn't read MFL's most-added list.";
        }
        if (j && j.cold && j.cold.known === true && Array.isArray(j.cold.players)) {
          coldMap = {};
          j.cold.players.forEach(function (row) {
            var pid = safeStr(row && row.id);
            var pct = Number(row && row.percent);
            if (pid && isFinite(pct)) coldMap[pid] = pct;
          });
        } else {
          coldError = safeStr(j && j.cold && j.cold.error) || "Couldn't read MFL's most-dropped list.";
        }
        state.hotCold = { hot: hotMap, cold: coldMap, hotError: hotError, coldError: coldError, fetchedAt: Date.now() };
        // Only stamp the TTL clock on a FULLY successful read (both sides
        // known). Stamping it unconditionally (as an earlier version of this
        // did) meant a transient MFL/worker hiccup left the UI showing
        // "couldn't read MFL's list" for the full 5-minute TTL -- the Hot/Cold
        // buttons stay enabled the whole time (they only disable while a
        // fetch is actually in flight), so tapping one again silently
        // no-ops via the TTL short-circuit above instead of retrying. Leaving
        // hotColdAt at its prior value (0 on first failure) means the very
        // next tap -- Hot, Cold, either -- attempts a fresh fetch instead of
        // serving stale failure state. Mirrors fetchWaiverState's own
        // "only stamp on success" rule directly above in this file.
        if (hotMap != null && coldMap != null) state.hotColdAt = Date.now();
        return state.hotCold;
      })
      .catch(function () { state.hotColdPromise = null; return state.hotCold; });
    state.hotColdPromise = p;
    return p;
  }

  // ---------- Public API ----------
  window.UPS_MOBILE = {
    boot: boot,
    isCommishOverride: isCommishOverride,
    state: state,
    // BUILD lets a view cache-bust its own lazily-injected assets in lockstep
    // with the app release. Toasts go through ui.showToast below.
    BUILD: BUILD,
    util: {
      safeStr: safeStr,
      safeInt: safeInt,
      pad4: pad4,
      escapeHtml: escapeHtml,
      // Feed-text pair — decodeEntities THEN escapeHtml, never one without the
      // other, and safeHttpUrl at every href sink. See their definitions above.
      decodeEntities: decodeEntities,
      safeHttpUrl: safeHttpUrl,
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
      rosterCapMax: rosterCapMax,
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
      // contractStatus: the player's CURRENT contract label (rosterRow.contractStatus).
      // Optional param for back-compat with any caller not yet updated, but
      // every real caller now passes it — see the note below on why.
      isTaxiEligibleFor: function (playerId, contractStatus) {
        var pid = String(playerId || "");
        if (!pid) return false;
        var callup = (state.taxiCallupsByPid || {})[pid];
        if (callup && callup.permanent_promotion) return false;
        // FAITHFUL MIRROR of the worker's taxi_eligible (isTaxiEligible in
        // worker/src/index.js, the value desktop trusts verbatim): use the UPS
        // ROOKIE DRAFT round/year (NOT the NFL round), Round 2 OR LATER, inside
        // the 3-league-year window. `historicalDraftByPid` (results[15]) is the
        // merged 3-year UPS draft index keyed by pid — the mobile equivalent of
        // the worker's `upsDraftByPlayer`. Trey Benson is NFL R3 but UPS R1.10 →
        // R1 NOT taxi-eligible (§A1); the old NFL-round check wrongly passed him.
        // A player absent from the index has no UPS rookie-draft record → not
        // draft-taxi-eligible. R6 (IDP-only since 2025) IS eligible — canon §B2
        // "Round 2 or later" (ratified Keith 2026-07-17; the old `> 5` cap
        // wrongly benched R6 rookies like A.J. Haulcy).
        var ups = (state.historicalDraftByPid || {})[pid];
        if (!ups) return false;
        var draftYear = parseInt(ups.year, 10);
        var draftRound = parseInt(ups.round, 10);
        var currentSeason = parseInt(state.ctx && state.ctx.year, 10);
        if (!draftYear || !currentSeason) return false;
        if (!draftRound || draftRound < 2) return false;  // only R1 excluded; R2+ (incl. R6 IDP) taxi-eligible
        if ((currentSeason - draftYear) >= 3) return false;
        // Trade preserves eligibility; a CUT forfeits it permanently (Keith
        // 2026-08-03: "if a player is traded they can be demoted...but once cut
        // that player is no longer cap eligible"). MFL never rewrites
        // contractStatus on a trade, but a drop wipes it and re-acquisition
        // always assigns a fresh one — so anything other than exactly
        // "Rookie-Draft" means the original entry contract is gone, no matter
        // how recent the UPS draft record is. Mirrors the worker's
        // stillOnEntryContract check. Found via a real case: Demetrius Knight
        // (UPS R6 2025, drafted by Blake Bombers) was cut and bought back by a
        // DIFFERENT team at the 2026 auction — now "Vet-FAA" — and this check
        // hadn't noticed, because it only ever looked at draft history.
        if (!/^rookie-draft$/i.test(safeStr(contractStatus))) return false;
        return true;
      },
      // §B3 IR eligibility — the ONE copy on the mobile side.
      //
      // Canon §B3 / T2.1: IR is for a player holding an NFL IR-type
      // designation. IR carries 50% cap relief (MFL includeIRWithSalary=50)
      // and takes the player off the active-roster max, so who qualifies is a
      // real cap question, not cosmetics.
      //
      // ⚠️ The predicate is matched against the strings MFL ACTUALLY SENDS, not
      // against canon's prose names. Observed live 2026-08-15 across all 339
      // rows: IR (32), IR-PUP (2), IR-NFI (1), Suspended (8), Holdout (2),
      // RETIRED (19), Questionable (234), Out (41). The version this replaces
      // tested `s === "PUP"` / `s === "NFI"`, which can NEVER match, because
      // MFL prefixes both — the real strings are "IR-PUP" / "IR-NFI". It also
      // had no HOLDOUT branch although canon T2.1 lists holdouts explicitly.
      //
      // `indexOf("IR") === 0`, anchored, is doing real work: RETIRED contains
      // "IR" at index 3, and retirees are deliberately NOT IR-eligible — canon
      // D2 handles them with the cap-free-cut rule, a different mechanic with a
      // different cap consequence. A `>= 0` here would quietly hand 19 retired
      // players 50% cap relief.
      //
      // This is character-for-character the expression in worker/src/index.js
      // (the deactivate_ir §B3 gate). Keep them identical: the client decides
      // what to OFFER and the server decides what to ALLOW, and an owner shown
      // a button the server then refuses is the drift we are avoiding.
      //
      // Returns { known, eligible, designation }. `known` is the whole point:
      // when MFL's injuries export didn't read, eligible:false means "we could
      // not tell", NOT "no". Callers must branch on `known` before they say
      // anything to the owner, and must never treat unknown as permission —
      // the worker re-checks server-side and refuses on its own unknown
      // (IR_ELIGIBILITY_UNKNOWN, 502).
      irEligibilityFor: function (playerId) {
        var pid = String(playerId == null ? "" : playerId);
        if (!pid) return { known: false, eligible: false, designation: "" };
        if (!state.injuriesFeedOk) return { known: false, eligible: false, designation: "" };
        var s = (state.injuriesByPid || {})[pid] || "";
        return {
          known: true,
          eligible: s.indexOf("IR") === 0        // IR, IR-PUP, IR-NFI
                 || s.indexOf("SUSPEND") === 0   // Suspended
                 || s.indexOf("HOLDOUT") === 0   // canon T2.1
                 || s.indexOf("COVID") >= 0,     // legacy §B3
          designation: s
        };
      },
      // Read-state of the MFL injuries export, for views that must explain WHY
      // an IR bucket is empty. ok:false = unreadable (unknown); ok:true with
      // rows:0 = read fine and genuinely empty.
      injuryFeedState: function () {
        return { ok: state.injuriesFeedOk === true, rows: safeInt(state.injuriesRowCount, 0) };
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
      // Authoritative /api/cap-penalty/preview row for one pid (or null).
      capPenaltyFor: capPenaltyFor,
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
    // Waiver plumbing — read state/pending, submit a BBID plan or an FCFS
    // add, plus the shared window/limit/plan helpers every waiver surface
    // (Market rows, player sheet, Claims screen, Home card) reads from.
    waivers: {
      fetchState: fetchWaiverState,
      fetchPending: fetchPendingClaims,
      submitPlan: submitWaiverPlan,
      submitFcfs: submitFcfs,
      mode: waiverMode,
      // §5 kill switch + the read-only escape hatch every surface links to.
      writeEnabled: waiverWriteEnabled,
      nativeLink: waiverNativeLink,
      limits: waiverLimits,
      when: waiverWhen,
      countdown: waiverCountdown,
      getPlan: getWaiverPlan,
      setPlan: setWaiverPlan,
      pickCount: waiverPickCount,
      clearCount: waiverClearCount,
      withdrawAllPlan: waiverWithdrawAllPlan,
      // Last /pending envelope, `{ known, rounds }` — read `known` before
      // treating `rounds` as anything (contract v2 §1).
      getPending: function () { return state.waiverPending; },
      isDirty: waiverPlanDirty,
      // What MFL was holding the last time this plan was hydrated from it, and
      // the function that puts a fresh /pending envelope in the same terms.
      // Compare the two to learn that MFL's copy moved. Either can be null =
      // UNKNOWN; a caller that gets null must do nothing rather than guess.
      // getPlan() first, so a plan (and basis) still on disk is hydrated.
      mflBasis: function () { getWaiverPlan(); return state.waiverMflSig; },
      // WHICH BBID run this plan is waiting on, unix seconds — or null, which
      // is UNKNOWN ("restored from a record written before this field
      // existed", or written while the calendar had no upcoming run). Never 0.
      // getPlan() first, for the same reason mflBasis does: a plan (and its
      // target) still on disk has to be hydrated before the field is read.
      targetRun: function () { getWaiverPlan(); return state.waiverTargetRun; },
      // MFL's next scheduled BBID run, for stamping a plan's target.
      nextRun: waiverNextRunUnix,
      // The most recent BBID run that has already passed. Pair it with
      // targetRun() to learn that MFL has already processed what is staged
      // here. See waiverLastRun above for the known/unknown contract.
      lastRun: waiverLastRun,
      mflSignature: mflHoldingsSignature,
      adoptVerified: adoptVerifiedPlan,
      errorMessage: waiverErrorMessage,
      // Ground-truth roster-membership check (contract v2's "already resolved"
      // signal) — the viewer's own rostered pids, independent of MFL's
      // pendingWaivers export. See getOwnRosteredPids above.
      getOwnRosterPids: getOwnRosteredPids
    },
    // MFL platform-wide "who's trending" (topAdds/topDrops, FA only). Lazy —
    // fetch() is only ever called from players.js on the first Hot/Cold tap.
    hotCold: {
      fetch: fetchHotCold,
      get: function () { return state.hotCold; },
      isLoading: function () { return !!state.hotColdPromise; }
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
