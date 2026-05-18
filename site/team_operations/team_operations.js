(function () {
  "use strict";

  var BUILD = "2026.05.14.apikey-auth";
  var BOOT_FLAG = "__ups_team_operations_boot_" + BUILD;
  if (window[BOOT_FLAG]) {
    if (typeof window.UPS_TEAMOPS_INIT === "function") window.UPS_TEAMOPS_INIT();
    return;
  }
  window[BOOT_FLAG] = true;

  // HARD SCOPE: only render when the HPM mount is present. Prevents cross-page bleed.
  if (!document.getElementById("teamOpsMount")) {
    return;
  }

  // ---------- Helpers ----------

  function safeStr(v) { return v == null ? "" : String(v).trim(); }
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
  function fmtInt(n) {
    var x = Number(n || 0);
    return isFinite(x) ? String(Math.round(x)) : "0";
  }
  function asArray(v) {
    if (Array.isArray(v)) return v;
    if (v == null || v === "") return [];
    return [v];
  }
  function daysUntil(iso) {
    if (!iso) return null;
    try {
      var target = new Date(iso + "T00:00:00");
      var now = new Date();
      var ms = target.getTime() - now.getTime();
      return Math.ceil(ms / (1000 * 60 * 60 * 24));
    } catch (e) { return null; }
  }

  // ---------- State ----------

  var state = {
    ctx: null,
    league: null,
    franchises: [],
    viewerFranchiseId: "",
    viewerFranchise: null,
    salaries: null,
    rosters: null,
    transactions: null,
    pendingTrades: null,
    tradeBait: null,
    futureDraftPicks: null,
    schedule: null,
    nflByeWeeks: null,
    liveScoring: null,
    calendar: null,
    players: null,
    injuries: null,
    playerNews: null,
    salaryAdjustments: null,
    capAmount: 0,
    loadErrors: [],
    lastLoaded: null,
    // Per-player bundle cache populated lazily via /api/player-bundle on
    // the Cloudflare worker. Same endpoint Draft Hub + Front Office use,
    // so once any hub primes a player, all three benefit (worker edge cache).
    playerBundles: {},
    teamNewsItems: null,
    teamNewsLoading: false,
    // Lineup builder draft (Set of player IDs currently picked as starters).
    // Mutated as the user toggles checkboxes in the roster card; cleared
    // on successful submit. Phase 2 — Keith 2026-05-15.
    lineupDraft: null,         // Set<string> | null
    lineupSubmitting: false,
    lineupMessage: null,       // { kind: "ok"|"err", text: string } | null
    // Roster card mode toggle: "lineup" (default, edit starting lineup) or
    // "tradeBait" (mark players available for trade + a "what I'm looking
    // for" comment). Keith 2026-05-15 phase 3.
    rosterMode: "lineup",
    tradeBaitDraft: null,      // Set<string> | null — pid -> available
    tradeBaitLookingFor: "",   // free text submitted as WILL_TAKE_TEXT
    tradeBaitSubmitting: false,
    tradeBaitMessage: null,
    // Per-player notes — pid → "free text". UPS-side only; persisted in
    // D1 via /api/submit-trade-bait + read via /api/trade-bait-notes on
    // first render of the trade bait tab.
    tradeBaitNotes: null,      // { [pid]: string } | null
    tradeBaitNotesLoaded: false,
  };

  // Cloudflare worker base for /api/player-bundle calls. Override via
  // window.UPS_TEAMOPS_API_BASE for local dev / preview deploys.
  function workerBase() {
    var override = (window.UPS_TEAMOPS_API_BASE || window.UPS_DRAFT_HUB_API_BASE || "").trim();
    if (override) return override.replace(/\/+$/, "");
    return "https://upsmflproduction.keith-creelman.workers.dev";
  }
  function workerUrl(path) {
    return workerBase() + path;
  }

  var els = {};

  // ---------- MFL API ----------

  function mflHost() {
    // Prefer the SAME-ORIGIN host the page is on. MFL serves league data
    // from a sharded sub-domain (www48 for league 74598). The legacy
    // api.myfantasyleague.com host 302-redirects to that shard, but the
    // 302 doesn't carry CORS headers — combined with credentials:"include"
    // the browser drops the entire fetch chain BEFORE it ever reaches
    // the redirect target. Net result: 12/12 endpoint errors and an
    // all-zero My Team page.
    //
    // Fix: when the page is already on a *.myfantasyleague.com host,
    // use that exact origin so the fetch is same-origin and bypasses
    // the redirect entirely. Fallback to the canonical www host
    // when running outside MFL (local dev, where CORS will block
    // anyway — the empty-state picker handles that case).
    try {
      var loc = window.location || {};
      var host = String(loc.hostname || "").toLowerCase();
      if (host && /\.myfantasyleague\.com$/.test(host)) {
        return loc.protocol + "//" + host;
      }
    } catch (e) {}
    // Local-dev fallback. Will CORS-fail; renderViewerEmptyState surfaces
    // a clear diagnostic so we know what's happening.
    return "https://www48.myfantasyleague.com";
  }

  function mflExportUrl(type, extra) {
    var ctx = state.ctx || {};
    // When the page is NOT on an MFL host (local dev, workers.dev preview,
    // anywhere cross-origin), MFL's CORS blocks direct fetches. Route
    // through the worker's /api/mfl-export proxy which serves the same
    // payload with CORS-friendly headers.
    var onMflHost = false;
    try {
      var h = String(window.location && window.location.hostname || "").toLowerCase();
      onMflHost = /\.myfantasyleague\.com$/.test(h);
    } catch (e) {}
    var base = onMflHost
      ? mflHost() + "/" + encodeURIComponent(ctx.year) + "/export"
      : workerUrl("/api/mfl-export");
    var url = base + "?TYPE=" + encodeURIComponent(type) +
              "&L=" + encodeURIComponent(ctx.leagueId) +
              "&YEAR=" + encodeURIComponent(ctx.year) +
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

  function fetchJson(url) {
    var controller = ("AbortController" in window) ? new AbortController() : null;
    var timeout = setTimeout(function () { if (controller) controller.abort(); }, 7000);
    // credentials:"include" is only needed for same-origin MFL calls (so
    // MFL's session cookies authenticate). For the worker proxy, omit
    // credentials — the worker is public-read and including credentials
    // forces stricter CORS.
    var sameOriginMfl = false;
    try {
      var u = new URL(url, window.location.href);
      sameOriginMfl = /\.myfantasyleague\.com$/i.test(u.hostname);
    } catch (e) {}
    var opts = { credentials: sameOriginMfl ? "include" : "omit", mode: "cors" };
    if (controller) opts.signal = controller.signal;
    return fetch(url, opts)
      .then(function (r) {
        clearTimeout(timeout);
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .catch(function (err) {
        clearTimeout(timeout);
        var tag = url.split("TYPE=")[1] || url;
        state.loadErrors.push(tag.split("&")[0] + ": " + (err && err.message ? err.message : String(err)));
        return null;
      });
  }

  function loadAllData() {
    var ctx = state.ctx;
    if (!ctx || !ctx.leagueId || !ctx.year) {
      return Promise.reject(new Error("Missing league/year context"));
    }

    var calls = [
      ["league", fetchJson(mflExportUrl("league"))],
      ["rosters", fetchJson(mflExportUrl("rosters"))],
      ["salaries", fetchJson(mflExportUrl("salaries"))],
      // salaryAdjustments — trade adjustments, cut/drop penalties, manual
      // commish adjustments. Signed integers — positive amounts INCREASE
      // effective cap usage. Front Office shows these explicitly in its
      // Cap Summary; we just need the viewer's franchise total here so
      // the Cap Used / Cap Room cards display the same number FO shows.
      ["salaryAdjustments", fetchJson(mflExportUrl("salaryAdjustments")).catch(function () { return null; })],
      ["players", fetchJson(mflExportUrl("players", { DETAILS: "1" }))],
      ["transactions", fetchJson(mflExportUrl("transactions", { DAYS: 14 }))],
      ["pendingTrades", fetchJson(mflExportUrl("pendingTrades"))],
      ["tradeBait", fetchJson(mflExportUrl("tradeBait"))],
      ["futureDraftPicks", fetchJson(mflExportUrl("futureDraftPicks"))],
      ["schedule", fetchJson(mflExportUrl("schedule"))],
      ["nflByeWeeks", fetchJson(mflExportUrl("nflByeWeeks"))],
      ["injuries", fetchJson(mflExportUrl("injuries"))],
      ["calendar", fetchJson(mflExportUrl("calendar"))],
      // myfranchise — authoritative user-identity lookup via APIKEY.
      // MFL exposes window._apiKey_ on authenticated pages; we pass
      // that key as ?APIKEY=... and route through the worker proxy to
      // api.myfantasyleague.com (where this TYPE is accepted). The
      // response includes the logged-in user's franchise for the
      // current league — no cookies needed. See docs/MFL_API.md
      // "User identity via _apiKey_".
      ["myfranchise", (function () {
        var apiKey = "";
        try { apiKey = String(window._apiKey_ || "").trim(); } catch (e) {}
        if (!apiKey) return Promise.resolve(null);
        return fetchJson(mflExportUrl("myfranchise", { APIKEY: apiKey })).catch(function () { return null; });
      })()],
      // UPS deadline calendar from our own D1 (league_events). 404s
      // gracefully when the worker doesn't have the endpoint yet —
      // renderEvents handles missing data.
      ["leagueEvents", fetchJson(workerUrl("/api/league-events?season=" + encodeURIComponent(ctx.year) + "&from=today&limit=10")).catch(function () { return null; })]
    ];

    return Promise.all(calls.map(function (pair) { return pair[1]; })).then(function (results) {
      calls.forEach(function (pair, i) { state[pair[0]] = results[i]; });
      state.lastLoaded = new Date();
      parseLeague();
      resolveViewerFranchise();
      return state;
    });
  }

  function parseLeague() {
    if (!state.league || !state.league.league) return;
    var lg = state.league.league;
    state.capAmount = Number((lg.salaryCapAmount || 0)) || 0;
    state.franchises = asArray(lg.franchises && lg.franchises.franchise).map(function (f) {
      return {
        id: pad4(f.id),
        name: safeStr(f.name),
        icon: safeStr(f.icon),
        logo: safeStr(f.logo),
        owner: safeStr(f.owner_name)
      };
    });
  }

  function resolveViewerFranchise() {
    var ctx = state.ctx;
    var fid = pad4(ctx.franchiseId);

    // ── Fallback chain (in priority order) ──
    // 1. Already-set ctx.franchiseId (from URL ?FRANCHISE_ID= or window.FRANCHISE_ID)
    // 2. MFL TYPE=myfranchise authenticated lookup via APIKEY (2026-05-14)
    //    Most authoritative: api.myfantasyleague.com returns the
    //    logged-in user's franchise for this league when we pass
    //    window._apiKey_ as ?APIKEY=. No cookies needed.
    // 3. MFL_LAST_LOGIN_FRANCHISE_ID cookie — MFL sets this for any
    //    logged-in user. Most reliable cookie-based signal.
    // 4. localStorage rdh_my_fid — persists once picked.
    // 5. URL path /home/<league>/<franchise>.
    // 6. MFL_USER_ID cookie matched against league franchise records.
    if (!fid && state.myfranchise) {
      // Response shape from api.* TYPE=myfranchise:
      //   { myfranchise: { id: "0008", name: "Real Deal Creel", ... } }
      // The single object is THIS league's franchise for the user.
      try {
        var mf = (state.myfranchise && state.myfranchise.myfranchise) || null;
        if (mf) {
          var f = pad4(mf.id || mf.franchise_id);
          if (f) fid = f;
        }
      } catch (e) {}
    }
    if (!fid) {
      var lastLogin = readCookie("MFL_LAST_LOGIN_FRANCHISE_ID");
      if (lastLogin) fid = pad4(lastLogin);
    }
    if (!fid) {
      try {
        var lsFid = window.localStorage && window.localStorage.getItem("rdh_my_fid");
        if (lsFid) fid = pad4(lsFid);
      } catch (e) {}
    }
    if (!fid) {
      try {
        var pathMatch = String(window.location.pathname || "").match(/\/home\/\d+\/(\d{1,4})(?:\/|$)/i);
        if (pathMatch && pathMatch[1]) fid = pad4(pathMatch[1]);
      } catch (e) {}
    }
    if (!fid && state.league) {
      var lg = state.league.league || {};
      var fr = asArray(lg.franchises && lg.franchises.franchise);
      var cookie = readCookie("MFL_USER_ID");
      if (cookie) {
        for (var i = 0; i < fr.length; i++) {
          var owner = safeStr(fr[i].username || fr[i].owner_id || fr[i].owner_name);
          if (owner && owner.indexOf(cookie) !== -1) {
            fid = pad4(fr[i].id);
            break;
          }
        }
      }
    }

    state.viewerFranchiseId = fid;
    state.viewerFranchise = state.franchises.find(function (f) { return f.id === fid; }) || null;

    // Persist for cross-hub reuse so the Draft Hub + future hubs share
    // the same identity without re-resolving every page load.
    if (fid) {
      try { window.localStorage && window.localStorage.setItem("rdh_my_fid", fid); } catch (e) {}
    }
  }

  function readCookie(name) {
    try {
      var m = document.cookie.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
      return m ? decodeURIComponent(m[1]) : "";
    } catch (e) { return ""; }
  }

  // ---------- Data shaping ----------

  function playerById(id) {
    if (!state.players || !state.players.players) return null;
    var list = asArray(state.players.players.player);
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].id) === String(id)) return list[i];
    }
    return null;
  }

  function getMyRoster() {
    if (!state.rosters || !state.rosters.rosters) return [];
    var fr = asArray(state.rosters.rosters.franchise);
    var mine = fr.find(function (f) { return pad4(f.id) === state.viewerFranchiseId; });
    if (!mine) return [];
    return asArray(mine.player).map(function (p) {
      return {
        id: String(p.id),
        status: safeStr(p.status),
        salary: Number(p.salary || 0),
        contractYear: safeStr(p.contractYear),
        contractStatus: safeStr(p.contractStatus),
        contractInfo: safeStr(p.contractInfo)
      };
    });
  }

  // Sum of salaryAdjustments for the viewer's franchise. Signed integer
  // — positive means INCREASES effective cap usage (the standard MFL
  // convention; Front Office uses the same sum in calculateCapSpace).
  // Returns 0 when no adjustments / no viewer franchise resolved.
  function getMyAdjustmentTotal() {
    var fid = pad4(state.viewerFranchiseId || (state.viewerFranchise && state.viewerFranchise.id) || "");
    if (!fid) return 0;
    var root = state.salaryAdjustments && state.salaryAdjustments.salaryAdjustments;
    if (!root) return 0;
    var rows = asArray(root.salaryAdjustment || root.adjustment);
    var total = 0;
    rows.forEach(function (row) {
      if (!row) return;
      var rowFid = pad4(row.franchise_id || row.franchise || row.id || "");
      if (rowFid !== fid) return;
      total += Number(row.amount || 0);
    });
    return total;
  }

  function getMySalaries() {
    // MFL's salaries export with unit=LEAGUE returns every player league-wide
    // with no franchise attribution (sample player has id+salary+contractInfo
    // only). The roster export, however, includes salary + contract fields
    // per franchise's player. Source cap math from roster; back-fill any
    // missing fields from the salaries export keyed by player id.
    var roster = getMyRoster();
    if (!roster.length) return [];

    var salaryById = {};
    if (state.salaries && state.salaries.salaries) {
      var units = asArray(state.salaries.salaries.leagueUnit);
      units.forEach(function (u) {
        asArray(u.player).forEach(function (p) {
          if (p && p.id) salaryById[String(p.id)] = p;
        });
      });
    }

    return roster.map(function (r) {
      var sp = salaryById[r.id] || {};
      return {
        id: r.id,
        salary: Number(r.salary || sp.salary || 0),
        contractYear: r.contractYear || safeStr(sp.contractYear),
        contractInfo: r.contractInfo || safeStr(sp.contractInfo),
        contractStatus: r.contractStatus || safeStr(sp.contractStatus)
      };
    });
  }

  function getInjuryFor(playerId) {
    if (!state.injuries || !state.injuries.injuries) return null;
    var list = asArray(state.injuries.injuries.injury);
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].id) === String(playerId)) return list[i];
    }
    return null;
  }

  // ---------- Rendering ----------

  function tpl(strings) {
    return strings.join("");
  }

  // Inner-page tabs: Overview (default = the cards) · Front Office (iframes
  // roster_workbench) · Player Stats (iframes stats_workbench). The hub URLs
  // resolve relative to /upsmflproduction/site/ since both target hubs live
  // there. iframes are lazy: src is set the first time the tab activates.
  // Iframe URLs use GitHub Pages — serves HTML with correct text/html
  // content-type (jsDelivr forces text/plain on HTML by policy, and 403s
  // when the repo exceeds 50MB). Pages has no size limit and a much
  // shorter cache TTL than jsDelivr (~10 min vs ~12hr). See #88.
  //
  // Pages artifact root = site/ (see .github/workflows/pages-deploy.yml),
  // so paths DROP the "/site/" prefix and live directly under the repo's
  // Pages root.
  //
  // Falls back to the /api/repo-html worker proxy if Pages is unreachable.
  // Wiring deferred until staged rollout PR 3.
  function hubUrl(relPath) {
    return "https://keithcreelman.github.io/upsmflproduction/" + relPath;
  }
  function hubUrlFallback(relPath) {
    var ref = (window.UPS_RELEASE_SHA && String(window.UPS_RELEASE_SHA).trim()) || "main";
    return workerUrl("/api/repo-html?ref=" + encodeURIComponent(ref) + "&path=" + encodeURIComponent("site/" + relPath));
  }
  // Tab definitions:
  //   iframe  — the URL the embedded iframe loads (Pages so content-type
  //             headers stay correct and assets cache cleanly).
  //   message — the MFL MESSAGEnn module the "Open in new tab" link
  //             routes to, so owners pop out to the league's own hosted
  //             page (with header chrome, hotlinks, etc.) instead of
  //             a bare Pages URL.
  var TAB_DEFS = [
    { id: "overview",     label: "Overview" },
    { id: "front-office", label: "Front Office",   iframe: hubUrl("rosters/roster_workbench.html"),     message: "MESSAGE7" },
    { id: "player-stats", label: "Player Stats",   iframe: hubUrl("stats_workbench/stats_workbench.html"), message: "MESSAGE13" },
    { id: "trade-room",   label: "Trade War Room", iframe: hubUrl("trades/trade_workbench.html"),       message: "MESSAGE6=N" },
    // Standings v2 — the new Playoff Preview + Division Race +
    // H2H matrix module promoted via 0913829. Legacy non-v2 file
    // (mfl_hpm_standings.html) stays in repo for now in case anything
    // links to it externally, but Team Ops uses v2.
    { id: "standings",    label: "Standings",      iframe: hubUrl("standings/mfl_hpm_standings_v2.html"), message: "MESSAGE4" }
  ];

  // Build the MFL-hosted MESSAGEnn URL for the given tab def. Falls back
  // to the iframe URL when we're not on MFL (e.g., local dev preview)
  // because the MFL host/path heuristics won't resolve.
  function popOutUrlForTab(def) {
    if (!def || !def.message) return def && def.iframe || "";
    var host = "";
    try { host = window.location.host || ""; } catch (e) {}
    if (!/myfantasyleague\.com$/i.test(host)) {
      // Not on MFL — best we can do is the bare Pages iframe URL.
      return def.iframe || "";
    }
    var leagueId = state.ctx && state.ctx.leagueId;
    var year = (state.ctx && state.ctx.year) || String(new Date().getFullYear());
    if (!leagueId) return def.iframe || "";
    return "//" + host + "/" + encodeURIComponent(year) +
      "/home/" + encodeURIComponent(leagueId) + "?MODULE=" + def.message;
  }

  function readActiveTab() {
    try {
      var m = String(window.location.hash || "").match(/tab=([a-z0-9-]+)/i);
      if (m && TAB_DEFS.some(function (t) { return t.id === m[1]; })) return m[1];
    } catch (e) {}
    return "overview";
  }

  function switchTab(id) {
    if (!els.tabPanels) return;
    Object.keys(els.tabPanels).forEach(function (k) {
      var on = (k === id);
      var panel = els.tabPanels[k];
      var btn = els.tabBtns && els.tabBtns[k];
      panel.setAttribute("data-active", on ? "1" : "0");
      if (btn) btn.setAttribute("data-active", on ? "1" : "0");
      // Lazy-load iframe src on first activation.
      var ifrm = panel.querySelector("iframe[data-lazysrc]");
      if (on && ifrm && !ifrm.getAttribute("src")) {
        ifrm.setAttribute("src", ifrm.getAttribute("data-lazysrc"));
      }
    });
    // Reflect in URL hash (no scroll jump).
    try {
      var u = new URL(window.location.href);
      u.hash = "tab=" + id;
      window.history.replaceState(null, "", u.toString());
    } catch (e) {}
  }

  function renderShell() {
    var mount = document.getElementById("teamOpsMount");
    if (!mount) return;

    var viewerName = state.viewerFranchise ? state.viewerFranchise.name : "My Team";
    var viewerIcon = state.viewerFranchise ? state.viewerFranchise.icon : "";

    // Iframe context-forwarding: pass L, YEAR, FRANCHISE_ID through.
    var ctxQs = "?L=" + encodeURIComponent(state.ctx.leagueId)
              + "&YEAR=" + encodeURIComponent(state.ctx.year)
              + (state.viewerFranchiseId ? "&FRANCHISE_ID=" + encodeURIComponent(state.viewerFranchiseId) : "");

    // Trade War Room needs api= + APIKEY= to load the live trade payload
    // (worker /trade-workbench endpoint with all 12 franchises). Without
    // these the workbench falls back to its bundled sample which only
    // ships 3 teams — that's why the partner picker only listed
    // LA Looks + Ulterior Warrior. mfl_hpm_embed_loader does this for
    // the standalone HPM mount; team-ops needs to do it inline since
    // we skip that loader.
    var twbApiKey = "";
    try { twbApiKey = String(window._apiKey_ || "").trim(); } catch (e) {}
    var twbExtraQs = "&api=" + encodeURIComponent("https://upsmflproduction.keith-creelman.workers.dev/trade-workbench")
                   + "&embed=1"
                   + (twbApiKey ? "&APIKEY=" + encodeURIComponent(twbApiKey) : "");

    var activeTab = readActiveTab();
    // Tabs:
    //   • In-page tab (Overview): rendered as <button data-tab>.
    //   • External tab (has .message): rendered as <a href> hyperlink
    //     to the MFL MESSAGE page. Clicking navigates same-window.
    //     No iframe rendered — Keith 2026-05-14, ditched embeds since
    //     each target module is already a polished standalone page
    //     and embedding made modals + scroll behavior awkward.
    var tabsHtml = '<nav class="tops-tabs" role="tablist">'
      + TAB_DEFS.map(function (t) {
          var on = (t.id === activeTab) ? '1' : '0';
          if (t.message) {
            var href = popOutUrlForTab(t);
            return '<a class="tops-tab tops-tab-link" href="' + escapeHtml(href || "#") + '" role="tab" data-tab-link="' + t.id + '" rel="noopener">'
              + escapeHtml(t.label) + ' <span class="tops-tab-link-arrow" aria-hidden="true">↗</span></a>';
          }
          return '<button type="button" class="tops-tab" data-tab="' + t.id + '" data-active="' + on + '" role="tab">' + escapeHtml(t.label) + '</button>';
        }).join("")
      + '</nav>';

    var overviewPanelHtml = ''
      + '<div class="tops-wip-banner" role="status">'
      +   '<strong>Heads up:</strong> this page and the Team Ops module are actively being built.'
      +   ' Expect rough edges, missing data, and frequent changes — not a finished product yet.'
      +   ' <span class="tops-wip-subline">Historical data (standings, contract history, player stints) is still being reviewed for accuracy and may not be fully correct yet.</span>'
      + '</div>'
      + '<main class="tops-grid">'
      // Next Decision pinned at top, full-width — most important card.
      + '  <section data-card="nextDecision" class="tops-card tops-card-highlight tops-card-wide"></section>'
      + '  <section data-card="summary" class="tops-card tops-card-summary"></section>'
      + '  <section data-card="matchup" class="tops-card"></section>'
      // Lineup + roster merged into a single position-grouped card (Keith
      // 2026-05-15). The old standalone lineup stub is gone; the new
      // roster card carries the Submit Lineup CTA + position group view.
      + '  <section data-card="roster" class="tops-card tops-card-wide"></section>'
      + '  <section data-card="allPlayerNews" class="tops-card tops-card-wide"></section>'
      + '  <section data-card="pendingTrades" class="tops-card"></section>'
      + '  <section data-card="waivers" class="tops-card"></section>'
      + '  <section data-card="transactions" class="tops-card"></section>'
      + '  <section data-card="futurePicks" class="tops-card"></section>'
      + '  <section data-card="schedule" class="tops-card"></section>'
      + '  <section data-card="calendar" class="tops-card"></section>'
      + '</main>';

    // hubPanels intentionally empty — external tabs (Front Office,
    // Player Stats, Trade War Room, Standings) are now hyperlinks in
    // the tab strip above, not embedded iframes (Keith 2026-05-14).
    // Overview is the only real panel rendered below.
    var hubPanels = "";

    mount.innerHTML = [
      '<div class="tops-shell">',
      '  <header class="tops-header">',
      '    <div class="tops-header-identity">',
      viewerIcon ? '<img class="tops-logo" src="' + escapeHtml(viewerIcon) + '" alt="">' : '',
      '      <div class="tops-title-block">',
      '        <div class="tops-title">My Team</div>',
      '        <div class="tops-subtitle">' + escapeHtml(viewerName) + '</div>',
      '      </div>',
      '    </div>',
      '  </header>',
      // Inner Team Ops tab strip removed — the header's "My Hub" sub-nav
      // (Overview / Front Office / Trade War Room / Rookie Hub /
      // Standings / Player Stats / Player Acquisition / Game Day)
      // already covers this navigation across every page, so the
      // duplicate strip just added clutter (Keith 2026-05-15).
      '  <section class="tops-tab-panel" data-tab-panel="overview" data-active="1" role="tabpanel">',
           overviewPanelHtml,
      '  </section>',
      '  <footer class="tops-footer">',
      '    <span class="tops-meta">Build ' + BUILD + '</span>',
      '    <span class="tops-meta">' + (state.lastLoaded ? 'Refreshed ' + state.lastLoaded.toLocaleTimeString() : 'Loading…') + '</span>',
      '    ' + (state.loadErrors.length ? '<span class="tops-meta tops-meta-error">' + state.loadErrors.length + ' endpoint issue(s)</span>' : ''),
      '  </footer>',
      '</div>'
    ].join("\n");

    els.mount = mount;
    els.cards = {};
    mount.querySelectorAll("[data-card]").forEach(function (node) {
      els.cards[node.getAttribute("data-card")] = node;
    });
    els.tabPanels = {};
    els.tabBtns = {};
    mount.querySelectorAll("[data-tab-panel]").forEach(function (n) { els.tabPanels[n.getAttribute("data-tab-panel")] = n; });
    mount.querySelectorAll("[data-tab]").forEach(function (n) {
      els.tabBtns[n.getAttribute("data-tab")] = n;
      n.addEventListener("click", function () { switchTab(n.getAttribute("data-tab")); });
    });
    // React to back/forward navigation that changes the hash.
    window.addEventListener("hashchange", function () { switchTab(readActiveTab()); });
  }

  // ----- Card: Franchise Summary -----
  function renderSummary() {
    var el = els.cards.summary;
    if (!el) return;

    var salaries = getMySalaries();
    var roster = getMyRoster();
    // Index roster status by player_id so we can flag taxi salaries.
    var statusById = {};
    roster.forEach(function (r) { statusById[r.id] = safeStr(r.status); });

    // Cap hit rules (must match Roster Workbench's currentCapHit):
    //   • Expired contract (contractYear <= 0): 0% — player is on roster
    //     awaiting Expired Rookie Auction / cut, but contract has lapsed
    //     so no cap charge. (Roster Workbench: `if (y <= 0) return 0;`.)
    //   • Taxi: 0% — taxi salary is real money but DOES NOT count vs cap.
    //   • IR:   50% — half of salary counts toward cap.
    //   • All other roster states: 100%.
    //
    // Without the cy<=0 rule, Team Ops Cap Used ran higher than Front
    // Office Cap Summary by the sum of any expired-contract salaries on
    // roster (Keith 2026-05-15: Long Haulers, Will Levis cy=0 / $6K).
    // Without IR 50%, same kind of mismatch for any team with IR players.
    var playerSalaryUsed = 0;     // active + IR×0.5 (cap-charging player salary)
    var taxiSalary = 0;           // off-cap
    var irSalaryFull = 0;         // raw IR salary before 50% factor, for transparency
    var expiredSalary = 0;        // raw cy<=0 salary, off-cap, for transparency
    salaries.forEach(function (s) {
      var amt = Number(s.salary || 0);
      var status = statusById[s.id] || "";
      var cy = parseInt(s.contractYear, 10);
      if (cy === 0) {
        // Expired contract — keep raw amount for transparency, charge $0.
        expiredSalary += amt;
      } else if (/taxi/i.test(status)) {
        taxiSalary += amt;
      } else if (/ir|injured/i.test(status)) {
        irSalaryFull += amt;
        playerSalaryUsed += Math.round(amt * 0.5);
      } else {
        playerSalaryUsed += amt;
      }
    });
    // Salary adjustments — cap penalties (positive = cap-charging, e.g.
    // drop penalties; negative = cap credit). Folded into the headline
    // total so Team Ops matches Front Office.
    var adjustmentTotal = getMyAdjustmentTotal();
    var cap = state.capAmount;

    // Round each component to the nearest $1K, then derive Cap Total
    // and Cap Room from those rounded values so all four displayed
    // numbers add up consistently:
    //   displayed salary + displayed adj   = displayed cap total
    //   displayed cap     − displayed total = displayed cap room
    // Without this, $272.5K used + $27.5K free both round UP to
    // $273K + $28K = $301K, breaking the tie (Keith 2026-05-14).
    function roundToK(n) { return Math.round(Number(n || 0) / 1000) * 1000; }
    var playerSalaryUsedR = roundToK(playerSalaryUsed);
    var adjustmentTotalR  = roundToK(adjustmentTotal);
    var capTotalR         = playerSalaryUsedR + adjustmentTotalR;
    var remainR           = cap - capTotalR;
    var pct = cap > 0 ? Math.min(100, Math.round((capTotalR / cap) * 100)) : 0;

    var rosterCount = roster.length;
    var irCount = roster.filter(function (p) { return /ir/i.test(p.status); }).length;
    var taxiCount = roster.filter(function (p) { return /taxi/i.test(p.status); }).length;
    var activeCount = rosterCount - irCount - taxiCount;

    // Card 1 explicit split (Keith 2026-05-14): Salary + Adjustments = big
    // total. Color-code the adjustments line so positive (cap-charging)
    // reads warm, negative (cap credit) reads green.
    var adjClass = adjustmentTotalR > 0 ? 'tops-kv-split-warn'
                  : adjustmentTotalR < 0 ? 'tops-kv-split-ok'
                  : 'tops-kv-split-zero';
    var adjPrefix = adjustmentTotalR > 0 ? "+" : (adjustmentTotalR < 0 ? "−" : "");
    var adjAmtR = Math.abs(adjustmentTotalR);

    el.innerHTML = [
      '<div class="tops-card-title">Franchise Summary</div>',
      '<div class="tops-summary-grid">',
      '  <div class="tops-kv">',
      '    <div class="tops-kv-label">Cap Total</div>',
      '    <div class="tops-kv-value">' + fmtUsd(capTotalR) + '</div>',
      '    <div class="tops-kv-split">',
      '      <span class="tops-kv-split-line"><span class="tops-kv-split-k">Salary</span><span class="tops-kv-split-v">' + fmtUsd(playerSalaryUsedR) + '</span></span>',
      '      <span class="tops-kv-split-line ' + adjClass + '">',
      '        <span class="tops-kv-split-k">Adjustments</span>',
      '        <span class="tops-kv-split-v">' + adjPrefix + fmtUsd(adjAmtR) + '</span>',
      '      </span>',
      '    </div>',
      '    <div class="tops-kv-note">' + pct + '% of ' + fmtUsd(cap) +
        (irSalaryFull > 0 ? ' · <span style="opacity:0.75;">IR ' + fmtUsd(irSalaryFull) + ' @ 50%</span>' : '') +
        (taxiSalary > 0 ? ' · <span style="opacity:0.75;">+ ' + fmtUsd(taxiSalary) + ' taxi (off-cap)</span>' : '') +
        '</div>',
      '    <div class="tops-bar"><div class="tops-bar-fill" style="width:' + pct + '%"></div></div>',
      '  </div>',
      '  <div class="tops-kv">',
      '    <div class="tops-kv-label">Cap Room</div>',
      '    <div class="tops-kv-value">' + fmtUsd(remainR) + '</div>',
      '    <div class="tops-kv-note">' + fmtUsd(cap) + ' cap − ' + fmtUsd(playerSalaryUsedR) + ' salary' +
        (adjustmentTotalR !== 0 ? ' − ' + adjPrefix + fmtUsd(adjAmtR) + ' adj' : '') +
        '</div>',
      '  </div>',
      '  <div class="tops-kv">',
      '    <div class="tops-kv-label">Roster</div>',
      '    <div class="tops-kv-value">' + rosterCount + '</div>',
      '    <div class="tops-kv-note">' + activeCount + ' active · ' + taxiCount + ' taxi · ' + irCount + ' IR</div>',
      '  </div>',
      '</div>'
    ].join("");
  }

  // ----- Card: Matchup -----
  function renderMatchup() {
    var el = els.cards.matchup;
    if (!el) return;

    // UPS pod format: each franchise plays 2 (Divisional) or 3 (Intra-pod)
    // matchups per week. Surface ALL of them — same logic as renderSchedule.
    var week = "—";
    var opponents = [];      // array of franchise names
    var weekType = "";       // "Divisional" | "Intra" | ""
    if (state.schedule && state.schedule.schedule) {
      var weeks = asArray(state.schedule.schedule.weeklySchedule);
      var upcoming = weeks.find(function (w) {
        var matchups = asArray(w.matchup);
        return matchups.some(function (m) {
          return asArray(m.franchise).some(function (f) { return pad4(f.id) === state.viewerFranchiseId; });
        });
      });
      if (upcoming) {
        week = upcoming.week;
        asArray(upcoming.matchup).forEach(function (m) {
          var frs = asArray(m.franchise).map(function (f) { return pad4(f.id); });
          if (frs.indexOf(state.viewerFranchiseId) === -1) return;
          var other = frs.find(function (id) { return id !== state.viewerFranchiseId; });
          var opp = state.franchises.find(function (f) { return f.id === other; });
          opponents.push(opp ? opp.name : ("F" + other));
        });
        weekType = opponents.length === 3 ? "Intra" : (opponents.length === 2 ? "Divisional" : "");
      }
    }

    var typeBadge = weekType
      ? '<span class="tops-sched-type tops-sched-type--' + weekType.toLowerCase() + '">' + escapeHtml(weekType) + '</span>'
      : '';

    // "vs A & B" (2 opps) or "vs A, B & C" (3 opps).
    var oppHtml;
    if (!opponents.length) {
      oppHtml = '<strong>—</strong>';
    } else if (opponents.length === 1) {
      oppHtml = '<strong>' + escapeHtml(opponents[0]) + '</strong>';
    } else if (opponents.length === 2) {
      oppHtml = '<strong>' + escapeHtml(opponents[0]) + '</strong> &amp; <strong>' + escapeHtml(opponents[1]) + '</strong>';
    } else {
      var head = opponents.slice(0, -1).map(function (n) { return '<strong>' + escapeHtml(n) + '</strong>'; }).join(", ");
      oppHtml = head + ' &amp; <strong>' + escapeHtml(opponents[opponents.length - 1]) + '</strong>';
    }

    el.innerHTML = [
      '<div class="tops-card-title">This Week</div>',
      '<div class="tops-matchup">',
      '  <div class="tops-matchup-week">Week ' + escapeHtml(week) + ' ' + typeBadge + '</div>',
      '  <div class="tops-matchup-vs">vs ' + oppHtml + '</div>',
      '  <div class="tops-matchup-hint">' +
            (opponents.length > 1 ? opponents.length + ' games this week · ' : '') +
            'Live scores will appear here on game day' +
      '  </div>',
      '</div>'
    ].join("");
  }

  // ----- Card: Lineup stub (deprecated 2026-05-15) -----
  // Replaced by the merged roster-by-position card below. Keeping the
  // function as a no-op so any straggler callers in renderAll don't crash.
  function renderLineup() { /* merged into renderRoster */ }

  // League starting-lineup formation (per /api/league config; verified
  // 2026-05-15 against 2026 league data — see TYPE=league for L=74598).
  // Each group: required starting slots (min, max) + label + ordered list
  // of MFL position codes that count. Order matches the on-screen render.
  var LINEUP_GROUPS = [
    { key: "QB", label: "QB",   min: 1, max: 1, positions: ["QB"] },
    { key: "RB", label: "RB",   min: 1, max: 3, positions: ["RB"] },
    { key: "WR", label: "WR",   min: 2, max: 4, positions: ["WR"] },
    { key: "TE", label: "TE",   min: 1, max: 3, positions: ["TE"] },
    { key: "PK", label: "PK",   min: 1, max: 1, positions: ["PK"] },
    { key: "PN", label: "PN",   min: 1, max: 1, positions: ["PN"] },
    { key: "DL", label: "DT/DE",min: 1, max: 3, positions: ["DT", "DE"] },
    { key: "LB", label: "LB",   min: 1, max: 3, positions: ["LB"] },
    { key: "DB", label: "CB/S", min: 1, max: 3, positions: ["CB", "S"] },
    // Catch-all bucket — anything else that ended up on roster.
    { key: "OTH", label: "Other", min: 0, max: 0, positions: [] }
  ];
  function lineupGroupForPos(pos) {
    var p = safeStr(pos).toUpperCase();
    for (var i = 0; i < LINEUP_GROUPS.length - 1; i += 1) {
      if (LINEUP_GROUPS[i].positions.indexOf(p) !== -1) return LINEUP_GROUPS[i];
    }
    return LINEUP_GROUPS[LINEUP_GROUPS.length - 1];
  }

  // Lineup builder helpers.
  // - lineupEligibleRow(r): row is a valid candidate for "start" (not
  //   taxi, not IR, not expired-contract, has a known position group).
  // - lineupValidate(draftSet, rowsByPid): aggregate per-group counts vs
  //   LINEUP_GROUPS min/max + total = 14. Returns { ok, total, byGroup,
  //   errors[] }.
  function lineupEligibleRow(r) {
    if (!r) return false;
    if (r.isTaxi || r.isIr || r.isExpired) return false;
    if (!r.group || !r.group.positions || !r.group.positions.length) return false;
    return true;
  }
  function lineupValidate(draftSet, rowsByPid) {
    var byGroup = {};
    LINEUP_GROUPS.forEach(function (g) { byGroup[g.key] = { count: 0, min: g.min, max: g.max, label: g.label }; });
    var total = 0;
    var ineligibleCount = 0;
    draftSet.forEach(function (pid) {
      var r = rowsByPid[pid];
      if (!r || !lineupEligibleRow(r)) { ineligibleCount += 1; return; }
      byGroup[r.group.key].count += 1;
      total += 1;
    });
    var errors = [];
    Object.keys(byGroup).forEach(function (k) {
      var g = byGroup[k];
      if (!g.max && !g.min) return;
      if (g.count < g.min) errors.push(g.label + " needs " + (g.min - g.count) + " more");
      else if (g.count > g.max) errors.push(g.label + " over by " + (g.count - g.max));
    });
    if (ineligibleCount) errors.push(ineligibleCount + " ineligible (taxi/IR/expired) selected");
    if (total !== 14) errors.push(total < 14 ? "Need " + (14 - total) + " more starter(s)" : (total - 14) + " over 14");
    return { ok: errors.length === 0, total: total, byGroup: byGroup, errors: errors };
  }

  // Extract the most specific MFL error message we can from a worker
  // response. Order of preference:
  //   1. resp.body.error                                   (worker's structured error)
  //   2. resp.body.mfl_response.error.$t                   (MFL wrapped JSON error)
  //   3. resp.body.mfl_response.error                      (MFL plain-string error)
  //   4. resp.body.mfl_response (if string, first 200 chars)
  //   5. fallback "<msg> (HTTP <status>)"
  // The "(HTTP X)" suffix gets appended when we have anything else, so
  // we still log the status code for diagnostics without burying it.
  function extractMflError(resp, fallbackMsg) {
    var body = resp && resp.body;
    var stat = resp && resp.status;
    var statSfx = stat ? " (HTTP " + stat + ")" : "";
    if (body) {
      if (body.error) return String(body.error) + statSfx;
      var mr = body.mfl_response;
      if (mr) {
        if (mr.error) {
          if (typeof mr.error === "object" && mr.error.$t) return String(mr.error.$t) + statSfx;
          if (typeof mr.error === "string") return mr.error + statSfx;
        }
        if (typeof mr === "string" && mr.length) return mr.slice(0, 200) + statSfx;
      }
    }
    return fallbackMsg + statSfx;
  }

  // Read a cookie value WITHOUT decodeURIComponent — needed for forwarding
  // MFL session tokens that contain literal %-escaped bytes in storage
  // (e.g. aRBv1sCXvrLtj1DnZQifOg%3D%3D). MFL stores + sends the cookie
  // with literal %3D%3D and rejects sessions that come back decoded.
  // Keith 2026-05-15: with the round-trip decode, MFL returned
  // "not a member of league 74598" because we were forwarding the
  // wrong-encoded value.
  function readCookieRaw(name) {
    try {
      var m = document.cookie.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
      return m ? m[1] : "";
    } catch (e) { return ""; }
  }

  // Append MFL_USER_ID as a query param. encodeURIComponent re-escapes the
  // raw cookie value (so any literal % in the stored value becomes %25),
  // the worker URLSearchParams unwraps one layer, and the final Cookie
  // header to MFL carries the SAME bytes the browser had stored.
  function withMflUserParam(url) {
    var uid = readCookieRaw("MFL_USER_ID");
    if (!uid) return url;
    return url + (url.indexOf("?") === -1 ? "?" : "&") + "MFL_USER_ID=" + encodeURIComponent(uid);
  }

  // POST the lineup draft to the worker. Allow saving incomplete lineups
  // (Keith 2026-05-15) — MFL accepts partial lineups; in-app validation
  // remains informational. Worker validates caller via MFL_USER_ID param.
  function submitLineupDraft() {
    if (state.lineupSubmitting) return;
    var fid = pad4(state.viewerFranchiseId || (state.ctx && state.ctx.franchiseId));
    if (!fid) return;
    var starters = state.lineupDraft ? Array.from(state.lineupDraft) : [];
    state.lineupSubmitting = true;
    state.lineupMessage = { kind: "info", text: "Submitting lineup to MFL…" };
    renderRoster();
    fetch(withMflUserParam(workerBase() + "/api/submit-lineup"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ franchiseId: fid, starters: starters }),
    })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
      .then(function (resp) {
        if (resp.body && resp.body.ok) {
          state.lineupMessage = { kind: "ok", text: "Lineup saved to MFL ✓" };
        } else {
          var err = extractMflError(resp, "MFL rejected lineup");
          state.lineupMessage = { kind: "err", text: String(err) };
        }
      })
      .catch(function (e) {
        state.lineupMessage = { kind: "err", text: "Submit failed: " + (e && e.message || e) };
      })
      .then(function () {
        state.lineupSubmitting = false;
        renderRoster();
      });
  }

  // Load this franchise's persisted per-player trade-bait notes from D1.
  // Idempotent: only fires once per page load. Used to pre-fill the per-
  // row notes inputs when the user lands on the Trade Bait tab.
  function loadTradeBaitNotes() {
    if (state.tradeBaitNotesLoaded) return;
    var fid = pad4(state.viewerFranchiseId || (state.ctx && state.ctx.franchiseId));
    if (!fid) return;
    state.tradeBaitNotesLoaded = true;
    fetch(workerBase() + "/api/trade-bait-notes?franchiseId=" + encodeURIComponent(fid))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) return;
        var notes = {};
        (j.notes || []).forEach(function (n) { notes[String(n.player_id)] = String(n.note || ""); });
        state.tradeBaitNotes = notes;
        // Seed the bait set with players that have notes — owner cared
        // enough to annotate them, so they're presumed still available.
        if (!state.tradeBaitDraft) state.tradeBaitDraft = new Set();
        Object.keys(notes).forEach(function (pid) { state.tradeBaitDraft.add(pid); });
        if (state.rosterMode === "tradeBait") renderRoster();
      })
      .catch(function () { /* non-fatal — UI just shows blank notes */ });
  }

  // POST the trade bait draft to the worker. Worker validates caller via
  // cookie and relays to MFL import?TYPE=tradeBait. WILL_GIVE_UP is the
  // CSV of player IDs marked available; WILL_TAKE_TEXT is the free-text
  // "what I'm looking for" comment. notes={} is persisted in D1.
  function submitTradeBaitDraft() {
    if (state.tradeBaitSubmitting) return;
    var fid = pad4(state.viewerFranchiseId || (state.ctx && state.ctx.franchiseId));
    if (!fid) return;
    var willGiveUp = state.tradeBaitDraft ? Array.from(state.tradeBaitDraft) : [];
    var lookingForRaw = String(state.tradeBaitLookingFor || "").trim();
    // Only send notes for currently-checked players. Unchecking a player
    // prunes their note via the worker's delete-then-insert pattern.
    var notesPayload = {};
    if (state.tradeBaitNotes) {
      Object.keys(state.tradeBaitNotes).forEach(function (pid) {
        if (state.tradeBaitDraft && state.tradeBaitDraft.has(pid)) {
          notesPayload[pid] = state.tradeBaitNotes[pid];
        }
      });
    }
    // Build playerNames map for the worker — used for both MFL comment
    // concat AND the OTB Discord announcement. Send raw inputs; worker
    // does MFL truncation + Discord formatting.
    var roster = getMyRoster();
    var playerNames = {};
    roster.forEach(function (r) {
      var p = playerById(r.id) || {};
      playerNames[String(r.id)] = safeStr(p.name) || String(r.id);
    });
    var franchiseName = state.viewerFranchise && state.viewerFranchise.name
      || (state.ctx && state.ctx.franchiseName)
      || "";

    state.tradeBaitSubmitting = true;
    state.tradeBaitMessage = { kind: "info", text: "Submitting trade bait to MFL…" };
    renderRoster();
    fetch(withMflUserParam(workerBase() + "/api/submit-trade-bait"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        franchiseId: fid,
        franchiseName: franchiseName,
        willGiveUp: willGiveUp,
        lookingFor: lookingForRaw,    // raw "what I'm looking for" — worker does MFL concat + truncate
        notes: notesPayload,
        playerNames: playerNames,
      }),
    })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
      .then(function (resp) {
        if (resp.body && resp.body.ok) {
          state.tradeBaitMessage = { kind: "ok", text: "Trade bait saved to MFL ✓" };
        } else {
          var err = extractMflError(resp, "MFL rejected trade bait");
          state.tradeBaitMessage = { kind: "err", text: String(err) };
        }
      })
      .catch(function (e) {
        state.tradeBaitMessage = { kind: "err", text: "Submit failed: " + (e && e.message || e) };
      })
      .then(function () {
        state.tradeBaitSubmitting = false;
        renderRoster();
      });
  }

  // ----- Card: My Roster + Lineup (position-grouped, with submit CTA) -----
  function renderRoster() {
    var el = els.cards.roster;
    if (!el) return;

    var roster = getMyRoster();
    var salaryMap = {};
    getMySalaries().forEach(function (s) { salaryMap[s.id] = s; });

    var rows = roster.map(function (r) {
      var p = playerById(r.id) || {};
      var sal = salaryMap[r.id] || r;
      var injury = getInjuryFor(r.id);
      var injuryBadge = injury
        ? '<span class="tops-inj tops-inj-' + escapeHtml(injury.status || "?") + '" title="' + escapeHtml(injury.details || "") + '">' + escapeHtml(injury.status || "") + '</span>'
        : '';
      var pos = safeStr(p.position);
      var cy = parseInt(sal.contractYear, 10);
      return {
        id: String(r.id),
        pos: pos,
        group: lineupGroupForPos(pos),
        name: safeStr(p.name) || r.id,
        team: safeStr(p.team),
        salary: Number(sal.salary || 0),
        status: r.status,
        isTaxi: /taxi/i.test(safeStr(r.status)),
        isIr: /ir/i.test(safeStr(r.status)),
        isExpired: cy === 0,
        contract: safeStr(sal.contractInfo || sal.contractStatus),
        injuryBadge: injuryBadge
      };
    });

    if (!rows.length) {
      el.innerHTML = '<div class="tops-card-title">My Roster + Lineup</div><div class="tops-empty">No roster data loaded yet.</div>';
      return;
    }

    // Group rows by lineup position. Within each group, sort eligible
    // starters (active, not taxi/IR/expired) by salary desc — top of the
    // depth chart up top. Taxi / IR / expired / non-position go to the
    // bottom of their group (or into "Other").
    var byGroup = {};
    LINEUP_GROUPS.forEach(function (g) { byGroup[g.key] = []; });
    rows.forEach(function (r) { byGroup[r.group.key].push(r); });
    Object.keys(byGroup).forEach(function (k) {
      byGroup[k].sort(function (a, b) {
        var aSidelined = a.isTaxi || a.isIr || a.isExpired;
        var bSidelined = b.isTaxi || b.isIr || b.isExpired;
        if (aSidelined !== bSidelined) return aSidelined ? 1 : -1;
        return b.salary - a.salary;
      });
    });

    // Lineup builder state — index rows by pid for O(1) eligibility lookup.
    var rowsByPid = {};
    rows.forEach(function (r) { rowsByPid[r.id] = r; });
    // Initialize draft once: seed with the salary-desc top picks per group
    // up to each group's `min` so the user starts with a sane baseline.
    // Future iteration: fetch the franchise's current lineup from MFL and
    // seed from that instead. For now this matches what an owner would
    // pick if they did nothing — top of the depth chart by salary.
    if (!state.lineupDraft) {
      var seed = new Set();
      LINEUP_GROUPS.forEach(function (g) {
        if (!g.min) return;
        var picks = (byGroup[g.key] || []).filter(lineupEligibleRow).slice(0, g.min);
        picks.forEach(function (r) { seed.add(r.id); });
      });
      state.lineupDraft = seed;
    }
    var validation = lineupValidate(state.lineupDraft, rowsByPid);

    // Active mode (Lineup vs Trade Bait) — drives which checkbox state
    // each row binds to + which Save button renders in the card title.
    // Native MFL deep link CTA was removed (Keith 2026-05-15) since the
    // in-app Save button handles submission directly.
    var mode = state.rosterMode === "tradeBait" ? "tradeBait" : "lineup";
    if (!state.tradeBaitDraft) state.tradeBaitDraft = new Set();
    if (!state.tradeBaitNotes)  state.tradeBaitNotes  = {};
    // Lazily fetch persisted notes the first time we render so the per-
    // row note inputs land pre-populated on the Trade Bait tab.
    if (!state.tradeBaitNotesLoaded) loadTradeBaitNotes();

    // Per-group section HTML.
    var sections = LINEUP_GROUPS.map(function (g) {
      var groupRows = byGroup[g.key] || [];
      if (!groupRows.length) return "";
      var slotHint = g.min === 0
        ? ""
        : (g.min === g.max
            ? '<span class="tops-roster-slot-hint">Start ' + g.min + '</span>'
            : '<span class="tops-roster-slot-hint">Start ' + g.min + '–' + g.max + '</span>');
      var groupValidation = validation.byGroup[g.key] || { count: 0, min: g.min, max: g.max };
      var groupOver  = g.max > 0 && groupValidation.count > g.max;
      var groupUnder = g.min > 0 && groupValidation.count < g.min;
      var groupStatusClass = groupOver ? "is-over" : (groupUnder ? "is-under" : (groupValidation.count > 0 ? "is-ok" : ""));
      // Trade bait mode shows "N available" per group; lineup mode shows
      // the original starter-count + min/max status colors.
      var groupCountHud;
      if (mode === "tradeBait") {
        var groupBaitCount = groupRows.reduce(function (acc, r) {
          return acc + ((state.tradeBaitDraft && state.tradeBaitDraft.has(r.id)) ? 1 : 0);
        }, 0);
        groupCountHud = groupBaitCount > 0
          ? '<span class="tops-roster-group-status is-ok">' + groupBaitCount + ' available</span>'
          : "";
      } else {
        groupCountHud = g.min === 0
          ? ""
          : '<span class="tops-roster-group-status ' + groupStatusClass + '">'
              + groupValidation.count + ' starting</span>';
      }
      var bodyRows = groupRows.map(function (r) {
        var taxiBadge = r.isTaxi ? '<span class="taxi-pill" title="Taxi — off-cap, real for trade math">TAXI</span>' : '';
        var expiredBadge = r.isExpired ? '<span class="taxi-pill" style="background:rgba(239,68,68,0.18); color:#ef4444; border-color:rgba(239,68,68,0.45);" title="Contract expired (cy=0) — awaiting Expired Rookie Auction">EXP</span>' : '';
        var statusLabel = r.isTaxi ? 'TAXI' : (r.isIr ? 'IR' : (r.isExpired ? 'EXPIRED' : (r.status || 'ACTIVE')));
        var salaryCell = r.isTaxi
          ? '<span style="color:var(--warn,#fbbf24); opacity:0.9;">' + fmtUsd(r.salary) + '</span>'
          : (r.salary > 0 ? fmtUsd(r.salary) : '—');
        var lineupEligible = lineupEligibleRow(r);
        var lineupChecked  = state.lineupDraft && state.lineupDraft.has(r.id);
        var baitChecked    = state.tradeBaitDraft && state.tradeBaitDraft.has(r.id);
        // Trade bait eligibility: any rostered player not on taxi (taxi
        // players can't be traded). IR + expired CAN still be marked
        // available — owners may shop expiring rookies before ERA.
        // Trade bait eligibility — taxi NOW allowed (Keith 2026-05-15:
        // taxi players are tradeable; MFL's tradeBait accepts them).
        // Only ineligible state today is no-player-id (shouldn't happen).
        var baitEligible = true;
        var checkboxCell;
        if (mode === "tradeBait") {
          checkboxCell = baitEligible
            ? '<td class="tops-roster-check"><input type="checkbox" class="tops-bait-cbx" data-pid="' + escapeHtml(r.id) + '"' + (baitChecked ? ' checked' : '') + ' aria-label="Mark ' + escapeHtml(r.name) + ' available for trade"></td>'
            : '<td class="tops-roster-check"><span class="tops-lineup-cbx-disabled" title="Taxi — can\'t trade">—</span></td>';
        } else {
          checkboxCell = lineupEligible
            ? '<td class="tops-roster-check"><input type="checkbox" class="tops-lineup-cbx" data-pid="' + escapeHtml(r.id) + '"' + (lineupChecked ? ' checked' : '') + ' aria-label="Start ' + escapeHtml(r.name) + '"></td>'
            : '<td class="tops-roster-check"><span class="tops-lineup-cbx-disabled" title="' + (r.isTaxi ? "Taxi — can\'t start" : r.isIr ? "On IR — can\'t start" : "Expired contract — can\'t start") + '">—</span></td>';
        }
        var rowChecked = mode === "tradeBait" ? baitChecked : lineupChecked;
        var modeStateClass = mode === "tradeBait"
          ? (baitChecked ? ' is-trade-bait' : '')
          : (lineupChecked ? ' is-starting' : '');
        var mainRow = '<tr class="tops-roster-row' + (r.isTaxi ? ' is-taxi' : '') + (r.isIr ? ' is-ir' : '') + (r.isExpired ? ' is-expired' : '') + modeStateClass + '" data-pid="' + escapeHtml(r.id) + '">' +
          checkboxCell +
          '<td><span class="tops-pos tops-pos-' + escapeHtml(r.pos) + '">' + escapeHtml(r.pos) + '</span></td>' +
          '<td><span class="tops-roster-name" tabindex="0" role="button" aria-label="Open ' + escapeHtml(r.name) + ' profile" data-action="profile">' + escapeHtml(r.name) + '</span> ' + r.injuryBadge + taxiBadge + expiredBadge + '</td>' +
          '<td>' + escapeHtml(r.team) + '</td>' +
          '<td class="num">' + salaryCell + '</td>' +
          '<td>' + escapeHtml(r.contract) + '</td>' +
          '<td>' + escapeHtml(statusLabel) + '</td>' +
          '</tr>';
        // In Trade Bait mode, append a per-player note row underneath
        // when the player is checked. Hidden when unchecked to keep the
        // table compact; the note persists in state and is re-shown on
        // re-check (and on D1 reload).
        if (mode === "tradeBait" && baitChecked && baitEligible) {
          var noteVal = state.tradeBaitNotes && state.tradeBaitNotes[r.id] || "";
          var noteRow = '<tr class="tops-roster-note-row" data-pid="' + escapeHtml(r.id) + '">' +
            '<td colspan="7" class="tops-roster-note-cell">' +
              '<label class="tops-bait-note-label">Note for ' + escapeHtml(r.name) + ':</label>' +
              '<input type="text" class="tops-bait-note-input" data-pid="' + escapeHtml(r.id) + '" maxlength="500" placeholder="why available · floor price · package piece · etc." value="' + escapeHtml(noteVal) + '">' +
            '</td>' +
            '</tr>';
          return mainRow + noteRow;
        }
        return mainRow;
      }).join("");
      return '<div class="tops-roster-group">'
        + '<div class="tops-roster-group-head">'
        +   '<span class="tops-roster-group-label">' + escapeHtml(g.label) + '</span>'
        +   '<span class="tops-roster-group-count">' + groupRows.length + ' player' + (groupRows.length === 1 ? '' : 's') + '</span>'
        +   slotHint
        +   groupCountHud
        + '</div>'
        + '<table class="tops-roster-table">'
        +   '<thead><tr><th aria-label="Start"></th><th>Pos</th><th>Player</th><th>Team</th><th class="num">Salary</th><th>Contract</th><th>Status</th></tr></thead>'
        +   '<tbody>' + bodyRows + '</tbody>'
        + '</table>'
        + '</div>';
    }).join("");

    // Validation HUD + Save button. Save is no longer gated on full
    // validation (Keith 2026-05-15) — MFL accepts partial lineups, and
    // owners may want to save mid-edit. The HUD stays informational so
    // it's still obvious how far from a complete lineup the draft is.
    var hudStatusClass = validation.ok ? "is-ok" : (validation.total === 0 ? "" : "is-warn");
    var hudMessage = validation.ok
      ? '<strong>14 / 14</strong> starters · ready to submit'
      : '<strong>' + validation.total + ' / 14</strong> · ' + (validation.errors.length ? escapeHtml(validation.errors.join(" · ")) : "draft in progress");
    var baitCount = state.tradeBaitDraft ? state.tradeBaitDraft.size : 0;
    var baitHud = baitCount + " player" + (baitCount === 1 ? "" : "s") + " marked available";
    var lineupSaveBtn = '<button type="button" class="tops-link-pill tops-lineup-save"'
      + (state.lineupSubmitting ? " disabled" : "")
      + '>' + (state.lineupSubmitting ? "Submitting…" : "Save Lineup") + '</button>';
    var baitSaveBtn = '<button type="button" class="tops-link-pill tops-bait-save"'
      + (state.tradeBaitSubmitting ? " disabled" : "")
      + '>' + (state.tradeBaitSubmitting ? "Submitting…" : "Save Trade Bait") + '</button>';

    function modeMsgHtml(kind, msg) {
      if (!msg) return "";
      var cls = msg.kind === "ok" ? "is-ok" : msg.kind === "err" ? "is-err" : "";
      return '<div class="tops-lineup-msg ' + cls + '">' + escapeHtml(msg.text) + '</div>';
    }
    var msgHtml = mode === "tradeBait"
      ? modeMsgHtml("bait", state.tradeBaitMessage)
      : modeMsgHtml("lineup", state.lineupMessage);

    // Mode tabs.
    var tabsHtml = '<div class="tops-roster-tabs" role="tablist">'
      + '<button type="button" class="tops-roster-tab' + (mode === "lineup" ? " is-active" : "") + '" data-mode="lineup" role="tab" aria-selected="' + (mode === "lineup" ? "true" : "false") + '">Lineup</button>'
      + '<button type="button" class="tops-roster-tab' + (mode === "tradeBait" ? " is-active" : "") + '" data-mode="tradeBait" role="tab" aria-selected="' + (mode === "tradeBait" ? "true" : "false") + '">Trade Bait</button>'
      + '</div>';

    // Active mode HUD + Save button.
    var modeHudHtml, modeSaveBtn, modeHint;
    if (mode === "tradeBait") {
      modeHudHtml = '<div class="tops-lineup-hud">' + baitHud + '</div>';
      modeSaveBtn = baitSaveBtn;
      modeHint = 'mark players available · per-player notes get published with your "looking for" line · save anytime';
    } else {
      modeHudHtml = '<div class="tops-lineup-hud ' + hudStatusClass + '">' + hudMessage + '</div>';
      modeSaveBtn = lineupSaveBtn;
      modeHint = 'grouped by position · check starters · save any time (incomplete OK)';
    }

    // Trade Bait "what I'm looking for" textarea — only renders in bait mode.
    var lookingForHtml = mode === "tradeBait"
      ? '<div class="tops-bait-comment-wrap">'
        + '<label class="tops-bait-comment-label" for="topsBaitLookingFor">What I\'m looking for</label>'
        + '<textarea id="topsBaitLookingFor" class="tops-bait-comment" rows="2" placeholder="e.g. WR2 with starter upside, 2027 1st rd pick, anything at TE…">'
        +   escapeHtml(state.tradeBaitLookingFor || "")
        + '</textarea>'
        + '</div>'
      : "";

    el.innerHTML = [
      '<div class="tops-card-title">My Roster + Lineup '
        + '<span class="tops-count">' + rows.length + '</span> '
        + '<span class="tops-card-hint">' + escapeHtml(modeHint) + '</span>'
        + '<span class="tops-card-actions">' + modeSaveBtn + '</span>'
      + '</div>',
      tabsHtml,
      modeHudHtml,
      msgHtml,
      lookingForHtml,
      '<div class="tops-roster-grouped">',
      sections,
      '</div>'
    ].join("");

    // Wire mode tabs.
    el.querySelectorAll(".tops-roster-tab").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var next = btn.getAttribute("data-mode");
        if (next !== state.rosterMode) {
          state.rosterMode = next;
          renderRoster();
        }
      });
    });

    // Wire lineup checkboxes.
    el.querySelectorAll(".tops-lineup-cbx").forEach(function (cbx) {
      cbx.addEventListener("change", function () {
        var pid = cbx.getAttribute("data-pid");
        if (!state.lineupDraft) state.lineupDraft = new Set();
        if (cbx.checked) state.lineupDraft.add(pid);
        else state.lineupDraft.delete(pid);
        state.lineupMessage = null;
        renderRoster();
      });
    });
    // Wire trade bait checkboxes.
    el.querySelectorAll(".tops-bait-cbx").forEach(function (cbx) {
      cbx.addEventListener("change", function () {
        var pid = cbx.getAttribute("data-pid");
        if (!state.tradeBaitDraft) state.tradeBaitDraft = new Set();
        if (cbx.checked) state.tradeBaitDraft.add(pid);
        else state.tradeBaitDraft.delete(pid);
        state.tradeBaitMessage = null;
        renderRoster();
      });
    });
    // Wire "What I'm looking for" textarea — persist on input without
    // re-rendering (so the cursor doesn't jump on each keystroke).
    var lookingForEl = el.querySelector("#topsBaitLookingFor");
    if (lookingForEl) {
      lookingForEl.addEventListener("input", function () {
        state.tradeBaitLookingFor = lookingForEl.value;
        state.tradeBaitMessage = null;
      });
    }
    // Per-player note inputs — same no-re-render-on-input pattern as the
    // looking-for textarea. Notes ride along on the next Save Trade Bait.
    el.querySelectorAll(".tops-bait-note-input").forEach(function (inp) {
      inp.addEventListener("input", function () {
        var pid = inp.getAttribute("data-pid");
        if (!pid) return;
        if (!state.tradeBaitNotes) state.tradeBaitNotes = {};
        state.tradeBaitNotes[pid] = inp.value;
        state.tradeBaitMessage = null;
      });
    });
    // Save buttons.
    var saveLineupEl = el.querySelector(".tops-lineup-save");
    if (saveLineupEl) saveLineupEl.addEventListener("click", function () {
      if (saveLineupEl.hasAttribute("disabled")) return;
      submitLineupDraft();
    });
    var saveBaitEl = el.querySelector(".tops-bait-save");
    if (saveBaitEl) saveBaitEl.addEventListener("click", function () {
      if (saveBaitEl.hasAttribute("disabled")) return;
      submitTradeBaitDraft();
    });
    // Player name click → profile modal. Keyboard actionable.
    el.querySelectorAll('[data-action="profile"]').forEach(function (node) {
      var row = node.closest(".tops-roster-row");
      var pid = row && row.getAttribute("data-pid");
      if (!pid) return;
      node.addEventListener("click", function (e) { e.stopPropagation(); openPlayerProfileModal(pid); });
      node.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPlayerProfileModal(pid); }
      });
    });
  }

  // ----- Card: News (skeleton) -----
  // Old injury-only renderNews removed in v1.7.36. The full news-feed
  // implementation lives further down (uses /api/player-bundle for real
  // headlines, not just injury statuses) and is wired through renderAll
  // via the same name. Search for "News Feed for owned players".

  // ----- Differentiator cards (skeletons) -----
  function renderNextDecision() {
    var el = els.cards.nextDecision;
    if (!el) return;
    // Pull real upcoming events from /api/league-events when present (state.leagueEvents).
    // Falls back to a hardcoded preview row when the endpoint isn't deployed
    // yet so the card still telegraphs its purpose.
    var events = (state.leagueEvents && state.leagueEvents.ok && Array.isArray(state.leagueEvents.events))
      ? state.leagueEvents.events.slice(0, 4)
      : [];

    var itemsHtml;
    if (events.length) {
      itemsHtml = events.map(function (ev, i) {
        var d = daysUntil(ev.date);
        var label = (typeof eventLabel === "function") ? eventLabel(ev.event) : String(ev.event || "");
        var dateLbl = (typeof fmtEventDate === "function") ? fmtEventDate(ev.date) : ev.date;
        var soon = (d != null && d <= 14);
        var nextChip = (i === 0) ? ' <span class="tops-nd-next">NEXT</span>' : '';
        var when = (d == null) ? '' : (d <= 0 ? 'today' : (d === 1 ? 'tomorrow' : 'in ' + d + ' days'));
        return '<li' + (soon ? ' class="tops-nd-soon"' : '') + '>'
          + '<div class="tops-nd-main">'
          +   '<span class="tops-nd-label">' + escapeHtml(label) + '</span>' + nextChip
          +   '<span class="tops-nd-sub">' + escapeHtml(dateLbl) + '</span>'
          + '</div>'
          + (when ? '<span class="tops-nd-when">' + escapeHtml(when) + '</span>' : '')
          + '</li>';
      }).join("");
    } else {
      itemsHtml = '<li class="tops-nd-pending"><div class="tops-nd-main"><span class="tops-nd-label muted">Calendar loading…</span></div>'
        + '<div class="tops-nd-sub">If this persists, the <code>/api/league-events</code> worker endpoint hasn\'t deployed yet.</div></li>';
    }

    el.innerHTML = [
      '<div class="tops-card-title">Next Decision</div>',
      '<ul class="tops-nd-list">',
      itemsHtml,
      '</ul>'
    ].join("");
  }

  function renderRiskHeatmap() {
    var el = els.cards.riskHeatmap;
    if (!el) return;
    var roster = getMyRoster();
    var positions = {};
    roster.forEach(function (r) {
      var p = playerById(r.id) || {};
      var pos = p.position || "?";
      positions[pos] = (positions[pos] || 0) + 1;
    });
    var posList = Object.keys(positions).sort();

    el.innerHTML = [
      '<div class="tops-card-title">Roster Risk Heatmap</div>',
      '<div class="tops-heatmap-hint">Preview — scoring wires up in Phase 1b</div>',
      '<div class="tops-heatmap">',
      posList.map(function (pos) {
        return '<div class="tops-heat-cell"><div class="tops-heat-pos">' + escapeHtml(pos) + '</div><div class="tops-heat-count">' + positions[pos] + '</div></div>';
      }).join(""),
      '</div>'
    ].join("");
  }

  function renderCapTrajectory() {
    var el = els.cards.capTrajectory;
    if (!el) return;
    el.innerHTML = [
      '<div class="tops-card-title">Cap Trajectory</div>',
      '<div class="tops-empty">Phase 1b will plot year-by-year obligations from CCC contract data, with what-if overlays for extend/tag/drop.</div>'
    ].join("");
  }

  // ----- MFL-parity cards (skeleton + real data where simple) -----
  //
  // Trade War Room URL builder — drops the reader into MFL MESSAGE6
  // (our trade_workbench iframe) with FRANCHISE_ID pre-selected so they
  // can directly propose a trade to that team. Used for both "ID Trade
  // Offers" links AND each OTB row.
  function tradeWarRoomUrlForFranchise(fid) {
    var year = (state.ctx && state.ctx.year) || "";
    var leagueId = (state.ctx && state.ctx.leagueId) || "";
    var f = pad4(fid);
    if (!year || !leagueId || !f) return "";
    return "//www.myfantasyleague.com/" + encodeURIComponent(year)
      + "/home/" + encodeURIComponent(leagueId)
      + "?MODULE=MESSAGE6=N&FRANCHISE_ID=" + encodeURIComponent(f);
  }
  function franchiseDisplayName(fid) {
    var f = pad4(fid);
    var fr = (state.franchises || []).find(function (x) { return pad4(x.id) === f; });
    return (fr && fr.name) || ("Franchise " + f);
  }

  function renderPendingTrades() {
    var el = els.cards.pendingTrades;
    if (!el) return;
    var trades = (state.pendingTrades && state.pendingTrades.pendingTrades && asArray(state.pendingTrades.pendingTrades.pendingTrade)) || [];
    var mine = trades.filter(function (t) {
      return pad4(t.offeredTo) === state.viewerFranchiseId || pad4(t.offeringFranchise) === state.viewerFranchiseId;
    });
    var bait = (state.tradeBait && state.tradeBait.tradeBaits && asArray(state.tradeBait.tradeBaits.tradeBait)) || [];

    // Resolve a comma-separated PID/draft-pick list into readable labels
    // (uses existing playerById helper). Falls back to raw id if unknown.
    function labelAssets(csv) {
      var ids = String(csv || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
      return ids.map(function (id) {
        var p = playerById(id);
        if (p && p.name) return safeStr(p.name);
        if (/^DP_/i.test(id)) return id;  // draft pick id; keep raw for now
        return id;
      });
    }

    // Pending trades involving me — each row clickable → Trade War Room
    // with the OTHER franchise pre-selected.
    var pendingRows = mine.length ? mine.map(function (t) {
      var fromFid = pad4(t.offeringFranchise);
      var toFid = pad4(t.offeredTo);
      var iAmFrom = fromFid === state.viewerFranchiseId;
      var otherFid = iAmFrom ? toFid : fromFid;
      var url = tradeWarRoomUrlForFranchise(otherFid);
      var direction = iAmFrom ? "→ " : "← ";
      var role = iAmFrom ? "offered" : "incoming";
      return '<a class="tops-trade-row" href="' + escapeHtml(url) + '" target="_top">'
        + '<span class="tops-trade-dir">' + direction + '</span>'
        + '<span class="tops-trade-team">' + escapeHtml(franchiseDisplayName(otherFid)) + '</span>'
        + '<span class="tops-trade-role">' + role + '</span>'
        + '</a>';
    }).join("") : '<div class="tops-empty tops-empty--inline">No pending offers.</div>';

    // Whole-league OTB list grouped by franchise.
    var baitRows = bait.length ? bait.map(function (b) {
      var fid = pad4(b.franchise_id);
      var url = tradeWarRoomUrlForFranchise(fid);
      var assets = labelAssets(b.willGiveUp);
      var comment = safeStr(b.inExchangeFor).trim();
      return '<a class="tops-otb-row" href="' + escapeHtml(url) + '" target="_top">'
        + '<div class="tops-otb-team">' + escapeHtml(franchiseDisplayName(fid)) + '</div>'
        + '<div class="tops-otb-assets">' + assets.map(function (a) { return escapeHtml(a); }).join(" · ") + '</div>'
        + (comment ? '<div class="tops-otb-comment">' + escapeHtml(comment) + '</div>' : "")
        + '</a>';
    }).join("") : '<div class="tops-empty tops-empty--inline">Nobody on the block right now.</div>';

    el.innerHTML = [
      '<div class="tops-card-title">Trades '
        + '<span class="tops-count">' + mine.length + ' pending</span> '
        + '<span class="tops-count">' + bait.length + ' OTB</span>'
      + '</div>',
      '<div class="tops-trade-subsection">',
      '  <div class="tops-trade-subhead">ID Trade Offers</div>',
      '  <div class="tops-trade-list">' + pendingRows + '</div>',
      '</div>',
      '<div class="tops-trade-subsection">',
      '  <div class="tops-trade-subhead">OTB · League-wide Trade Bait</div>',
      '  <div class="tops-otb-list">' + baitRows + '</div>',
      '</div>'
    ].join("");
  }

  function renderWaivers() {
    var el = els.cards.waivers;
    if (!el) return;
    el.innerHTML = [
      '<div class="tops-card-title">Waivers / Blind Bids</div>',
      '<div class="tops-empty">Pulls in Phase 1b. Requires <code>TYPE=pendingWaivers</code> with franchise auth.</div>',
      '<a class="tops-link" href="//www.myfantasyleague.com/' + escapeHtml(state.ctx.year) + '/add_drop?L=' + escapeHtml(state.ctx.leagueId) + '">Open Add/Drop →</a>'
    ].join("");
  }

  // Resolve a comma-separated MFL transaction asset string into readable
  // labels. Token formats observed in the UPS league:
  //   12345                 → player_id (look up name+pos via playerById)
  //   DP_<round>_<pick>     → current-year draft pick
  //   FP_<fid>_<year>_<rd>  → future draft pick (round from franchise <fid>)
  //   BB_<amount>           → blind-bid amount in BBID transactions
  function decodeAssetTokens(raw) {
    var tokens = String(raw || "").split(",").map(function (t) { return t.trim(); }).filter(Boolean);
    return tokens.map(function (tok) {
      var m;
      if (/^\d+$/.test(tok)) {
        var p = playerById(tok);
        if (p) {
          var pos = p.position ? " (" + p.position + ")" : "";
          return safeStr(p.name).replace(/^([^,]+),\s*(.+)$/, "$2 $1") + pos;
        }
        return "Player #" + tok;
      }
      if ((m = tok.match(/^DP_(\d+)_(\d+)$/))) {
        return state.ctx.year + " R" + m[1] + ".P" + m[2];
      }
      if ((m = tok.match(/^FP_(\d{4})_(\d+)_(\d+)$/))) {
        var fr = state.franchises.find(function (f) { return f.id === pad4(m[1]); });
        return m[2] + " R" + m[3] + (fr ? " (from " + fr.name + ")" : "");
      }
      if ((m = tok.match(/^BB_(\d+)$/))) {
        return "$" + Number(m[1]).toLocaleString() + " BB";
      }
      return tok;
    });
  }

  function renderTransactions() {
    var el = els.cards.transactions;
    if (!el) return;
    var txns = (state.transactions && state.transactions.transactions && asArray(state.transactions.transactions.transaction)) || [];
    // Include transactions where viewer is either side of a TRADE.
    var mine = txns.filter(function (t) {
      var fa = pad4(t.franchise);
      var fb = pad4(t.franchise2);
      return fa === state.viewerFranchiseId || fb === state.viewerFranchiseId;
    }).slice(0, 10);

    el.innerHTML = [
      '<div class="tops-card-title">Recent Transactions <span class="tops-count">' + mine.length + '</span></div>',
      mine.length
        ? '<ul class="tops-txn-list">' + mine.map(function (t) {
            var when = new Date(Number(t.timestamp || 0) * 1000);
            var dateStr = when.toLocaleDateString();
            var typ = String(t.type || "").toUpperCase();
            var lines = [];

            if (typ === "TRADE") {
              var fa = pad4(t.franchise);
              var fb = pad4(t.franchise2);
              var iAmFa = (fa === state.viewerFranchiseId);
              var counterFid = iAmFa ? fb : fa;
              var counter = state.franchises.find(function (f) { return f.id === counterFid; });
              var myAssetsRaw = iAmFa ? t.franchise1_gave_up : t.franchise2_gave_up;
              var theirAssetsRaw = iAmFa ? t.franchise2_gave_up : t.franchise1_gave_up;
              var gave = decodeAssetTokens(myAssetsRaw);
              var got  = decodeAssetTokens(theirAssetsRaw);
              lines.push('<div class="tops-txn-line"><span class="tops-txn-arrow">vs</span> ' + escapeHtml(counter ? counter.name : ("F" + counterFid)) + '</div>');
              if (gave.length)  lines.push('<div class="tops-txn-line"><span class="tops-txn-arrow tops-txn-arrow--gave">▶</span> ' + gave.map(escapeHtml).join(", ") + '</div>');
              if (got.length)   lines.push('<div class="tops-txn-line"><span class="tops-txn-arrow tops-txn-arrow--got">◀</span> '   + got.map(escapeHtml).join(", ") + '</div>');
            } else if (typ === "BBID_WAIVER" || typ === "FREE_AGENT") {
              // Add/drop tokens: t.transaction is "ADD:pid|DROP:pid|..." or
              // similar — print whatever players are referenced if possible.
              var raw = safeStr(t.transaction);
              var pidsAdded = (raw.match(/\d+/g) || []).slice(0, 4);
              var labels = decodeAssetTokens(pidsAdded.join(","));
              if (labels.length) lines.push('<div class="tops-txn-line">' + labels.map(escapeHtml).join(", ") + '</div>');
              if (t.salary)      lines.push('<div class="tops-txn-line tops-txn-sub">Salary $' + Number(t.salary).toLocaleString() + '</div>');
            }
            if (t.comments) lines.push('<div class="tops-txn-line tops-txn-sub">' + escapeHtml(t.comments) + '</div>');

            return '<li>'
              + '<div class="tops-txn-head">'
              +   '<span class="tops-txn-type">' + escapeHtml(typ) + '</span>'
              +   '<span class="tops-txn-when">' + escapeHtml(dateStr) + '</span>'
              + '</div>'
              + lines.join("")
              + '</li>';
          }).join("") + '</ul>'
        : '<div class="tops-empty">No transactions in the last 14 days.</div>'
    ].join("");
  }

  function renderFuturePicks() {
    var el = els.cards.futurePicks;
    if (!el) return;
    var picks = (state.futureDraftPicks && state.futureDraftPicks.futureDraftPicks && asArray(state.futureDraftPicks.futureDraftPicks.franchise)) || [];
    var mine = picks.find(function (p) { return pad4(p.id) === state.viewerFranchiseId; });
    var items = mine ? asArray(mine.futureDraftPick) : [];

    function originLabel(p) {
      // originalPickFor is the franchise_id that ORIGINALLY held this pick.
      // If it's still our own, hide the "(from)" suffix — redundant noise.
      // Otherwise resolve the id → team name via state.franchises so the
      // user sees "(from C-Town Chivalry)" not "(from 0005)".
      var fid = pad4(p.originalPickFor);
      if (!fid || fid === state.viewerFranchiseId) return "";
      var fr = state.franchises.find(function (f) { return f.id === fid; });
      return ' <span class="tops-pick-origin">(from ' + escapeHtml(fr ? fr.name : ("F" + fid)) + ')</span>';
    }

    el.innerHTML = [
      '<div class="tops-card-title">Future Draft Picks <span class="tops-count">' + items.length + '</span></div>',
      items.length
        ? '<ul class="tops-picks-list">' + items.slice(0, 10).map(function (p) {
            return '<li><strong>' + escapeHtml(p.year) + '</strong> Rd ' + escapeHtml(p.round) + originLabel(p) + '</li>';
          }).join("") + '</ul>'
        : '<div class="tops-empty">No future picks data available.</div>'
    ].join("");
  }

  function renderSchedule() {
    var el = els.cards.schedule;
    if (!el) return;
    var weeks = (state.schedule && state.schedule.schedule && asArray(state.schedule.schedule.weeklySchedule)) || [];
    // UPS pod format: each franchise plays 2 or 3 matchups per week.
    // Divisional weeks = 2 games (vs each pod-mate). Intra-pod weeks = 3 games.
    // Filter (not find) so all of viewer's matchups for the week surface.
    var mine = weeks.map(function (w) {
      var matchups = asArray(w.matchup);
      var myMatches = matchups.filter(function (m) {
        return asArray(m.franchise).some(function (f) { return pad4(f.id) === state.viewerFranchiseId; });
      });
      if (!myMatches.length) return null;
      var opps = myMatches.map(function (m) {
        var oppId = asArray(m.franchise).map(function (f) { return pad4(f.id); })
                      .find(function (id) { return id !== state.viewerFranchiseId; });
        var opp = state.franchises.find(function (f) { return f.id === oppId; });
        return opp ? opp.name : "—";
      });
      return {
        week: w.week,
        opps: opps,
        type: opps.length === 3 ? "Intra" : (opps.length === 2 ? "Divisional" : "")
      };
    }).filter(Boolean).slice(0, 4);

    el.innerHTML = [
      '<div class="tops-card-title">Upcoming Schedule</div>',
      mine.length
        ? '<ul class="tops-sched-list">' + mine.map(function (w) {
            var typeBadge = w.type
              ? '<span class="tops-sched-type tops-sched-type--' + w.type.toLowerCase() + '">' + escapeHtml(w.type) + '</span>'
              : '';
            return '<li>'
              + '<span class="tops-sched-wk">Wk ' + escapeHtml(w.week) + '</span> '
              + typeBadge
              + '<span class="tops-sched-opps"> vs ' + w.opps.map(escapeHtml).join(' &amp; ') + '</span>'
              + '</li>';
          }).join("") + '</ul>'
        : '<div class="tops-empty">Schedule not yet published.</div>'
    ].join("");
  }

  // Map raw league_events.event tokens to human-readable labels.
  var EVENT_LABEL = {
    ups_contract_deadline:             "Contract Deadline",
    ups_rookieextension_deadline:      "Rookie Extension Deadline",
    ups_tag_deadline:                  "Tag Deadline",
    ups_expired_rookie_auction_start:  "Expired Rookie Auction",
    ups_rookie_draft:                  "Rookie Draft",
    ups_last_day_for_cuts:             "Last Day for Cuts",
    ups_fa_auction_start:              "FA Auction",
    ups_trade_deadline:                "Trade Deadline",
    preseason_mymdeadline:             "MYM Deadline",
    preseason_extensiondeadline:       "Extension Deadline",
    nfl_kickoff:                       "NFL Kickoff",
    ups_season_complete:               "UPS Season End"
  };
  function eventLabel(ev) {
    if (!ev) return "—";
    if (EVENT_LABEL[ev]) return EVENT_LABEL[ev];
    // Fallback: snake_case → Title Case
    return String(ev).replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }
  function fmtEventDate(iso) {
    if (!iso) return "TBD";
    var m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return iso;
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  function renderEvents() {
    var el = els.cards.calendar;
    if (!el) return;
    var src = (state.leagueEvents && state.leagueEvents.ok && Array.isArray(state.leagueEvents.events))
      ? state.leagueEvents.events
      : [];

    var listHtml;
    if (!src.length) {
      // Endpoint not deployed yet or no upcoming events — explicit empty state.
      listHtml = '<div class="tops-empty">No upcoming events. <span style="opacity:0.7;">(Calendar source: <code>league_events</code> D1 table.)</span></div>';
    } else {
      listHtml = '<ul class="tops-cal-list">' + src.map(function (ev, i) {
        var d = daysUntil(ev.date);
        var soon = (d != null && d <= 14);
        var nextBadge = (i === 0) ? '<span class="tops-cal-next">NEXT</span>' : '';
        var inDays = (d == null) ? '' : (d === 0 ? 'today' : (d === 1 ? 'tomorrow' : (d + ' days')));
        return '<li' + (soon ? ' class="tops-cal-soon"' : '') + '>'
          + '<span class="tops-cal-date">' + escapeHtml(fmtEventDate(ev.date)) + '</span>'
          + '<span class="tops-cal-lbl">' + escapeHtml(eventLabel(ev.event)) + nextBadge + '</span>'
          + (inDays ? '<span class="tops-cal-when">' + escapeHtml(inDays) + '</span>' : '')
          + '</li>';
      }).join("") + '</ul>';
    }

    el.innerHTML = '<div class="tops-card-title">Events &amp; Deadlines</div>' + listHtml;
  }

  function renderAll() {
    renderShell();
    // If we couldn't figure out who the viewer is, render a clear "pick
    // your franchise" empty state rather than silently zeroing every
    // card. Common causes: HPM mounted on a page MFL doesn't inject
    // FRANCHISE_ID for; cross-origin local testing where MFL fetches
    // are CORS-blocked; user not logged in.
    if (!state.viewerFranchiseId || !state.viewerFranchise) {
      renderViewerEmptyState();
      return;
    }
    renderSummary();
    renderMatchup();
    renderLineup();
    renderRoster();
    renderNextDecision();
    // renderRiskHeatmap + renderCapTrajectory removed in v1.7.32 — were
    // placeholder cards. Functions kept below as no-ops in case anything
    // else still calls them; safe to delete in a future cleanup pass.
    renderPendingTrades();
    renderWaivers();
    renderTransactions();
    renderFuturePicks();
    renderSchedule();
    renderEvents();
    renderAllPlayerNews();
    wireCollapsible();
  }

  // ── Collapsible cards (Wave 2b) ────────────────────────────────────────
  // Adds a chevron button to each opt-in card's title; clicking toggles
  // `data-collapsed` on the card. State persists in sessionStorage so a
  // reload keeps the user's preference. Cards opted in below have
  // long, secondary, or scrollable content; always-on operational cards
  // (Summary / Matchup / Lineup) are excluded so the headline data stays
  // visible.
  var COLLAPSIBLE_CARDS = [
    "allPlayerNews", "transactions", "pendingTrades", "waivers",
    "futurePicks", "schedule", "calendar"
  ];
  var COLLAPSE_STORAGE_PREFIX = "ups_teamops_collapsed_";

  function setCardCollapsed(node, collapsed, persist) {
    node.setAttribute("data-collapsed", collapsed ? "1" : "0");
    var btn = node.querySelector(".tops-collapse-btn");
    if (btn) {
      btn.textContent = collapsed ? "▸" : "▾";
      btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    }
    if (persist !== false) {
      try {
        var key = COLLAPSE_STORAGE_PREFIX + node.getAttribute("data-card");
        window.sessionStorage.setItem(key, collapsed ? "1" : "0");
      } catch (e) {}
    }
  }

  function wireCollapsible() {
    if (!els.cards) return;
    COLLAPSIBLE_CARDS.forEach(function (id) {
      var node = els.cards[id];
      if (!node) return;
      var title = node.querySelector(".tops-card-title");
      if (!title) return;
      // Idempotency — skip if already wired (renderers may re-run without
      // a full renderShell when only sub-cards refresh).
      if (title.querySelector(".tops-collapse-btn")) return;

      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tops-collapse-btn";
      btn.setAttribute("aria-expanded", "true");
      btn.setAttribute("aria-controls", "card-" + id);
      btn.title = "Collapse / expand";
      btn.textContent = "▾";
      title.appendChild(btn);
      // Make title click-to-toggle for an easier hit-target, but ignore
      // clicks on real interactive children (links, inputs).
      title.style.cursor = "pointer";
      title.addEventListener("click", function (ev) {
        if (ev.target && ev.target.closest("a,input,select,button:not(.tops-collapse-btn)")) return;
        var isCollapsed = node.getAttribute("data-collapsed") === "1";
        setCardCollapsed(node, !isCollapsed, true);
      });

      // Restore persisted state.
      try {
        var saved = window.sessionStorage.getItem(COLLAPSE_STORAGE_PREFIX + id);
        if (saved === "1") setCardCollapsed(node, true, false);
      } catch (e) {}
    });
  }

  // ── Player Bundle (worker /api/player-bundle) ──
  // Cached per-pid. Returns the same shape Draft Hub + Front Office consume:
  // { player_id, profile (MFL playerProfile + DETAILS merge), news, injuries, ... }
  function fetchPlayerBundle(pid) {
    var key = String(pid);
    if (state.playerBundles[key]) return Promise.resolve(state.playerBundles[key]);
    var url = workerUrl("/api/player-bundle?L=" + encodeURIComponent(state.ctx.leagueId) +
                        "&YEAR=" + encodeURIComponent(state.ctx.year) +
                        "&pid=" + encodeURIComponent(pid));
    return fetch(url, { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data) state.playerBundles[key] = data;
        return data;
      })
      .catch(function () { return null; });
  }

  // ── Player Profile Modal (click any player to open) ──
  // Uses /api/player-bundle for live MFL data (career stats, news, injury,
  // headshot URL). Mirrors the Bio + News surfaces from the Front Office
  // profile but is intentionally lighter than Front Office's 4-tab modal —
  // owners on My Team need quick context, not the full editing surface.
  // For anything more, the modal links out to the Front Office page.
  // ── Contract helpers (mirror Front Office's parsers so My Team can
  //    render the same Bio metrics: TCV / AAV / SALARY / YRS REMAIN /
  //    EARNED TO DATE / CAP PENALTY / ACQUIRE DATE / HOW ACQUIRED). ──
  function tops_parseContractMoney(token) {
    var s = String(token || "").trim().toUpperCase();
    if (!s) return 0;
    s = s.replace(/[$,]/g, "");
    var mult = 1;
    if (/K$/.test(s)) { mult = 1000; s = s.slice(0, -1); }
    else if (/M$/.test(s)) { mult = 1000000; s = s.slice(0, -1); }
    var n = Number(s);
    return Number.isFinite(n) ? Math.round(n * mult) : 0;
  }
  function tops_parseContractInfo(info) {
    var s = String(info || "");
    var out = { tcv: 0, length: 0, yearVals: {}, aav: 0, gtd: 0 };
    if (!s) return out;
    var m;
    if ((m = s.match(/(?:^|\|)\s*TCV\s+([^|]+)/i))) out.tcv = tops_parseContractMoney(m[1]);
    if ((m = s.match(/(?:^|\|)\s*CL\s*:?\s*(\d+)/i))) out.length = parseInt(m[1], 10) || 0;
    if ((m = s.match(/(?:^|\|)\s*AAV\s+([^|]+)/i))) out.aav = tops_parseContractMoney(m[1]);
    if ((m = s.match(/(?:^|\|)\s*GTD\s*:?\s*([^|]+)/i))) out.gtd = tops_parseContractMoney(m[1]);
    // Y-token regex matches the dash format used in UPS contractInfo
    // (e.g. "Y1-10K, Y2-40K"). Front Office uses the same shape via
    // parseContractYearValues at roster_workbench.js:1677. Fix
    // 2026-05-18 — was previously looking for "Y1=" or "Y1:" which
    // never appeared in production, so yearVals was always empty and
    // tops_earnedToDate always returned 0 → wrong $11K penalty.
    var yearRe = /Y(\d+)\s*-\s*([0-9]+(?:\.[0-9]+)?K?)/gi;
    while ((m = yearRe.exec(s))) {
      var idx = parseInt(m[1], 10);
      if (idx > 0) out.yearVals[idx] = tops_parseContractMoney(m[2]);
    }
    return out;
  }
  function tops_yearsRemain(sal) {
    var info = tops_parseContractInfo(sal && sal.contractInfo);
    var cy = parseInt(sal && sal.contractYear, 10) || 0;
    var len = info.length;
    if (len > 0 && cy > 0) return Math.max(0, len - cy + 1);
    if (len > 0) return len;
    return 0;
  }
  function tops_earnedToDate(sal) {
    // Canon §D1: prior-year salaries are 100% earned post-rollover.
    // `contractYear` from MFL is YEARS REMAINING (cy=1 = last year).
    // current-year-index = length - cy + 1. Earned years = 1..idx-1.
    //
    // Fix 2026-05-18 — was using `cy` as if it were the year index
    // (off-by-direction). For Coleman R2.1 2024 with cy=1, the old
    // loop ran 0 times → earned=0 → cap penalty = $11.25K (wrong).
    // Correct: idx=3, sum Y1+Y2 = $10K → penalty = $1,250.
    var info = tops_parseContractInfo(sal && sal.contractInfo);
    var cy = parseInt(sal && sal.contractYear, 10) || 0; // years remaining
    var len = info.length;
    if (len <= 0 || cy <= 0) return 0;
    var contractYearIdx = Math.max(1, len - cy + 1);
    // Sum explicit Y-values for years 1..idx-1.
    var earned = 0;
    var hasYearVals = false;
    for (var i = 1; i < contractYearIdx; i++) {
      if (info.yearVals[i] > 0) {
        earned += info.yearVals[i];
        hasYearVals = true;
      }
    }
    if (hasYearVals) return earned;
    // Fallback when contractInfo lacks Y-tokens (most rookie contracts
    // store only "CL N| TCV M| AAV K" — no per-year breakdown). Front
    // Office handles this at roster_workbench.js:1808-1810: when in
    // final year (idx >= length), earned = TCV - currentYearSalary.
    if (contractYearIdx >= len && info.tcv > 0) {
      var currentSal = Math.max(0, parseInt(sal && sal.salary, 10) || 0);
      return Math.max(0, info.tcv - currentSal);
    }
    // For non-final-year players without Y-tokens, assume even split:
    // each prior year earned = TCV / length.
    if (info.tcv > 0 && len > 0) {
      var perYear = Math.round(info.tcv / len);
      return perYear * (contractYearIdx - 1);
    }
    return 0;
  }
  function tops_dropPenalty(sal) {
    // Modern UPS rule: cap penalty on cut = (TCV × 75%) − Earned. Floor 0.
    var info = tops_parseContractInfo(sal && sal.contractInfo);
    var tcv = info.tcv;
    if (!tcv) return 0;
    var earned = tops_earnedToDate(sal);
    return Math.max(0, Math.round(tcv * 0.75) - earned);
  }
  function tops_findAcquisition(pid) {
    // Walk transactions for the most recent acquisition of this player by
    // the viewer. Returns { date: ISO, method: humanized, amount } or null.
    var pidStr = String(pid);
    var txns = (state.transactions && state.transactions.transactions && asArray(state.transactions.transactions.transaction)) || [];
    var fid = state.viewerFranchiseId;
    var found = null;
    txns.forEach(function (t) {
      if (pad4(t.franchise) !== fid) return;
      var typ = safeStr(t.type).toUpperCase();
      // FREE_AGENT, AUCTION_DRAFT, BBID_AUCTION, TAXI_PROMOTION, IR, TRADE etc.
      // The transaction structure varies; check several fields for the pid.
      var hits = [t.transaction, t.added, t.player_added, t.promoted, t.activated, t.demoted];
      for (var i = 0; i < hits.length; i++) {
        var raw = safeStr(hits[i]);
        if (!raw) continue;
        // Some MFL fields are comma-separated player IDs; others have
        // pipe-separated `id,salary,etc` tuples per player.
        if (raw.indexOf(pidStr) === -1) continue;
        var ts = Number(t.timestamp) || 0;
        if (!found || ts > found.ts) {
          found = {
            ts: ts,
            type: typ,
            method: typ.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, function (c) { return c.toUpperCase(); })
          };
        }
        break;
      }
    });
    return found;
  }

  function openPlayerProfileModal(pid) {
    if (!pid) return;
    // Delegate to the unified master modal when available (v1.7.43+).
    // The master handles its own overlay; we just hand it the Front Office
    // context so the cap-math strip, transactions lookup, and viewer-
    // franchise filter all work. Fall through to the legacy in-file
    // implementation only if the master script didn't load.
    if (typeof window.UPS_openPlayerProfile === "function") {
      try {
        var pInfo0 = playerById(pid) || {};
        var sal0 = (getMySalaries() || []).find(function (s) { return String(s.id) === String(pid); }) || null;
        window.UPS_openPlayerProfile(pid, {
          apiBase: workerBase(),
          leagueId: state.ctx.leagueId,
          year: state.ctx.year,
          mode: "front_office",
          viewerFranchise: state.viewerFranchise ? {
            id: state.viewerFranchiseId || (state.viewerFranchise && state.viewerFranchise.id) || "",
            name: state.viewerFranchise.name || ""
          } : null,
          contractSalary: sal0,
          transactions: state.transactions,
          injury: getInjuryFor(String(pid)),
          playerInfo: { name: pInfo0.name, position: pInfo0.position, team: pInfo0.team }
        });
        return;
      } catch (e) {
        // fall through to legacy modal
        if (window.console) console.warn("[tops] master profile modal failed, falling back:", e);
      }
    }
    closePlayerProfileModal();  // collapse any prior open
    var pInfo = playerById(pid) || {};
    var name = safeStr(pInfo.name) || ("Player #" + pid);
    var pos = safeStr(pInfo.position);
    var team = safeStr(pInfo.team);
    var headshotUrl = "https://www55.myfantasyleague.com/fflnetdynamic" +
      encodeURIComponent(state.ctx.year) + "/players/" + encodeURIComponent(pid) + ".jpg";

    var overlay = document.createElement("div");
    overlay.id = "topsProfileOverlay";
    overlay.className = "tops-profile-overlay";
    overlay.innerHTML =
      '<div class="tops-profile-modal" role="dialog" aria-modal="true" aria-labelledby="topsProfileTitle">' +
      '  <button class="tops-profile-close" aria-label="Close">×</button>' +
      '  <header class="tops-profile-header">' +
      '    <img class="tops-profile-photo" src="' + escapeHtml(headshotUrl) + '" alt="" onerror="this.style.visibility=\'hidden\'">' +
      '    <div class="tops-profile-id">' +
      '      <div class="tops-profile-pos-row">' +
      (pos ? '<span class="tops-profile-pos-pill">' + escapeHtml(pos) + '</span>' : '') +
      '        <h3 id="topsProfileTitle" class="tops-profile-name">' + escapeHtml(name) + '</h3>' +
      '      </div>' +
      '      <div class="tops-profile-sub">' +
        escapeHtml((state.viewerFranchise && state.viewerFranchise.name) || "") +
        (pos ? ' | ' + escapeHtml(pos) : '') +
        (team ? ' | ' + escapeHtml(team) : '') +
      '      </div>' +
      '    </div>' +
      '  </header>' +
      '  <nav class="tops-profile-tabs" role="tablist">' +
      '    <button class="tops-profile-tab is-active" role="tab" data-topstab="bio" aria-selected="true">BIO</button>' +
      '    <button class="tops-profile-tab" role="tab" data-topstab="stats" aria-selected="false">STATS</button>' +
      '    <button class="tops-profile-tab" role="tab" data-topstab="gamelog" aria-selected="false">GAME LOG</button>' +
      '    <button class="tops-profile-tab" role="tab" data-topstab="news" aria-selected="false">NEWS</button>' +
      '  </nav>' +
      '  <div class="tops-profile-panels">' +
      '    <div class="tops-profile-panel" data-topspanel="bio">' + renderProfileBio(pid) + '</div>' +
      '    <div class="tops-profile-panel" data-topspanel="stats" hidden><div class="tops-empty">Loading stats…</div></div>' +
      '    <div class="tops-profile-panel" data-topspanel="gamelog" hidden><div class="tops-empty">Loading game log…</div></div>' +
      '    <div class="tops-profile-panel" data-topspanel="news" hidden><div class="tops-empty">Loading news…</div></div>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) closePlayerProfileModal();
    });
    overlay.querySelector(".tops-profile-close").addEventListener("click", closePlayerProfileModal);
    document.addEventListener("keydown", _topsProfileEsc);

    // Tab switcher.
    overlay.querySelectorAll(".tops-profile-tab").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var tab = btn.getAttribute("data-topstab");
        overlay.querySelectorAll(".tops-profile-tab").forEach(function (b) {
          var active = b === btn;
          b.classList.toggle("is-active", active);
          b.setAttribute("aria-selected", active ? "true" : "false");
        });
        overlay.querySelectorAll(".tops-profile-panel").forEach(function (p) {
          p.hidden = p.getAttribute("data-topspanel") !== tab;
        });
      });
    });

    // Lazy-fetch the bundle for Stats / Game Log / News.
    fetchPlayerBundle(pid).then(function (bundle) {
      if (!document.getElementById("topsProfileOverlay")) return;  // closed already
      var statsEl = overlay.querySelector('[data-topspanel="stats"]');
      var glEl    = overlay.querySelector('[data-topspanel="gamelog"]');
      var newsEl  = overlay.querySelector('[data-topspanel="news"]');
      if (statsEl) statsEl.innerHTML = renderProfileStats(bundle, pid);
      if (glEl)    glEl.innerHTML    = renderProfileGameLog(bundle, pid);
      if (newsEl)  newsEl.innerHTML  = renderProfileNews(bundle, pid);
    });
  }
  function renderProfileBio(pid) {
    var pInfo = playerById(pid) || {};
    var sal = (getMySalaries() || []).find(function (s) { return String(s.id) === String(pid); }) || {};
    var info = tops_parseContractInfo(sal.contractInfo);
    var tcv = info.tcv || (function () {
      var sum = 0;
      for (var k in info.yearVals) sum += info.yearVals[k] || 0;
      return sum;
    })();
    var aav = info.aav || (info.length > 0 ? Math.round(tcv / info.length) : Number(sal.salary || 0));
    var salary = Number(sal.salary || 0);
    var yrsRemain = tops_yearsRemain(sal);
    var earned = tops_earnedToDate(sal);
    var penalty = tops_dropPenalty(sal);
    var acq = tops_findAcquisition(pid);
    var acqDate = acq && acq.ts ? new Date(acq.ts * 1000).toLocaleDateString() : "—";
    var acqMethod = acq && acq.method ? acq.method : "—";
    var inj = getInjuryFor(String(pid));
    var injHtml = inj
      ? '<div class="tops-profile-injury"><strong>' + escapeHtml(inj.status || "") + '</strong> — ' + escapeHtml(safeStr(inj.details) || "no detail") + '</div>'
      : "";
    return [
      injHtml,
      '<div class="tops-profile-grid">',
      '  <div class="tops-profile-metric"><span>TCV</span><strong>' + (tcv > 0 ? fmtUsd(tcv) : '—') + '</strong></div>',
      '  <div class="tops-profile-metric"><span>AAV</span><strong>' + (aav > 0 ? fmtUsd(aav) : '—') + '</strong></div>',
      '  <div class="tops-profile-metric"><span>Salary</span><strong>' + (salary > 0 ? fmtUsd(salary) : '—') + '</strong></div>',
      '  <div class="tops-profile-metric"><span>Yrs Remain</span><strong>' + (yrsRemain > 0 ? String(yrsRemain) : '—') + '</strong></div>',
      '  <div class="tops-profile-metric"><span>Earned to Date</span><strong>' + (earned > 0 ? fmtUsd(earned) : '$0') + '</strong></div>',
      '  <div class="tops-profile-metric"><span>Cap Penalty</span><strong>' + (penalty > 0 ? fmtUsd(penalty) : '$0') + '</strong></div>',
      '  <div class="tops-profile-metric"><span>Acquire Date</span><strong>' + escapeHtml(acqDate) + '</strong></div>',
      '  <div class="tops-profile-metric"><span>How Acquired</span><strong>' + escapeHtml(acqMethod) + '</strong></div>',
      '</div>'
    ].join("");
  }
  function renderProfileStats(bundle, pid) {
    // Bundle uses UPS-flavored career_summary[] — season-by-season fantasy
    // performance with UPS-specific ranks (win_chunks, elite_pct, dud_pct).
    // Most recent season first.
    var rows = asArray(bundle && bundle.career_summary).slice().sort(function (a, b) {
      return Number(b.season || 0) - Number(a.season || 0);
    });
    if (!rows.length) {
      return '<div class="tops-empty">No season stats on file (player may be a rookie or hasn\'t recorded a fantasy week yet).</div>';
    }
    var html = rows.slice(0, 10).map(function (s) {
      return '<tr>' +
        '<td>' + escapeHtml(safeStr(s.season)) + '</td>' +
        '<td>' + escapeHtml(safeStr(s.pos_group)) + '</td>' +
        '<td class="num">' + escapeHtml(safeStr(s.games_played)) + '</td>' +
        '<td class="num">' + escapeHtml(safeStr(s.season_points)) + '</td>' +
        '<td class="num">' + escapeHtml(safeStr(s.avg_ppg)) + '</td>' +
        '<td class="num">' + (s.pos_rank != null ? '#' + escapeHtml(safeStr(s.pos_rank)) : '—') + '</td>' +
        '<td class="num">' + (s.elite_pct != null ? escapeHtml(safeStr(s.elite_pct)) + '%' : '—') + '</td>' +
        '<td class="num">' + (s.dud_pct != null ? escapeHtml(safeStr(s.dud_pct)) + '%' : '—') + '</td>' +
        '</tr>';
    }).join("");
    return '<table class="tops-profile-table"><thead><tr>' +
      '<th>Season</th><th>Pos</th><th class="num">GP</th><th class="num">Pts</th>' +
      '<th class="num">PPG</th><th class="num">Pos #</th>' +
      '<th class="num">Elite</th><th class="num">Dud</th>' +
      '</tr></thead><tbody>' + html + '</tbody></table>';
  }
  function renderProfileGameLog(bundle, pid) {
    // Bundle stores weekly_by_season as an object keyed by year. Flatten
    // to a list, newest season first, all weeks within. Cap at 24 rows
    // so the modal stays readable.
    var byYear = (bundle && bundle.weekly_by_season) || {};
    var years = Object.keys(byYear).sort(function (a, b) { return Number(b) - Number(a); });
    var games = [];
    years.forEach(function (yr) {
      asArray(byYear[yr]).forEach(function (g) { games.push(g); });
    });
    if (!games.length) {
      return '<div class="tops-empty">No weekly results on file for this player.</div>';
    }
    var rows = games.slice(0, 24).map(function (g) {
      var rosterFid = safeStr(g.roster_franchise_name || g.status);
      return '<tr>' +
        '<td>' + escapeHtml(safeStr(g.season)) + '</td>' +
        '<td class="num">' + escapeHtml(safeStr(g.week)) + '</td>' +
        '<td class="num">' + escapeHtml(safeStr(g.score)) + '</td>' +
        '<td class="num">' + (g.pos_rank != null ? '#' + escapeHtml(safeStr(g.pos_rank)) : '—') + '</td>' +
        '<td>' + escapeHtml(safeStr(g.week_tier || g.status)) + '</td>' +
        '<td>' + escapeHtml(rosterFid) + '</td>' +
        '</tr>';
    }).join("");
    return '<table class="tops-profile-table"><thead><tr>' +
      '<th>Season</th><th class="num">Wk</th><th class="num">Pts</th>' +
      '<th class="num">Pos #</th><th>Tier</th><th>Roster</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
  }
  // News tab now uses the worker's /api/player-news multi-source aggregator
  // (Sleeper structured info + ESPN team articles fuzzy-matched to player
  // last name). The MFL playerProfile.news bundle field is deprecated and
  // returns empty for everyone — that was the v1.7.36 mistake.
  function renderProfileNews(bundle, pid) {
    // Render a placeholder + lazy fetch from /api/player-news.
    // Using a stable id on the container so we can target it after fetch.
    var nid = "topsProfileNewsBody-" + pid;
    setTimeout(function () { _topsLoadProfileNews(pid, nid); }, 0);
    return '<div id="' + nid + '"><div class="tops-empty">Loading news…</div></div>';
  }
  function _topsLoadProfileNews(pid, containerId) {
    var url = workerUrl("/api/player-news?L=" + encodeURIComponent(state.ctx.leagueId) +
                        "&YEAR=" + encodeURIComponent(state.ctx.year) +
                        "&pids=" + encodeURIComponent(pid));
    fetch(url, { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        var el = document.getElementById(containerId);
        if (!el) return;
        var items = (data && data.items_by_pid && data.items_by_pid[String(pid)]) || [];
        if (!items.length) {
          el.innerHTML = '<div class="tops-empty">No recent news, injury notes, or depth-chart info for this player.</div>';
          return;
        }
        el.innerHTML = '<ul class="tops-profile-news">' + items.map(function (n) {
          var when = n.timestamp ? new Date(Number(n.timestamp) * 1000).toLocaleDateString() : "";
          var typeClass = n.type === "status" ? " is-status" : (n.type === "depth" ? " is-depth" : "");
          var typeBadge = n.type === "status" ? '<span class="tops-news-type-badge is-status">INJURY</span>'
                       : n.type === "depth" ? '<span class="tops-news-type-badge is-depth">DEPTH</span>'
                       : '';
          var src = safeStr(n.source);
          var headline = safeStr(n.headline);
          var body = safeStr(n.body);
          var linkHtml = n.url
            ? '<a class="tops-profile-news-link" href="' + escapeHtml(n.url) + '" target="_blank" rel="noopener">Read full →</a>'
            : '';
          return '<li class="tops-profile-news-item' + typeClass + '">' +
            '<div class="tops-profile-news-meta">' + typeBadge + escapeHtml(when) + (src ? ' · ' + escapeHtml(src) : '') + '</div>' +
            (headline ? '<div class="tops-profile-news-head">' + escapeHtml(headline) + '</div>' : '') +
            (body ? '<div class="tops-profile-news-body">' + escapeHtml(body.slice(0, 800)) + '</div>' : '') +
            linkHtml +
            '</li>';
        }).join("") + '</ul>';
      })
      .catch(function () {
        var el = document.getElementById(containerId);
        if (el) el.innerHTML = '<div class="tops-empty" style="color:var(--tops-bad,#7de8d9); font-weight:700;">News fetch failed. Refresh to retry.</div>';
      });
  }
  function closePlayerProfileModal() {
    var ov = document.getElementById("topsProfileOverlay");
    if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
    document.removeEventListener("keydown", _topsProfileEsc);
  }
  function _topsProfileEsc(e) { if (e.key === "Escape") closePlayerProfileModal(); }

  function renderProfileBundle(bundle, pid) {
    var profile = (bundle && bundle.profile && bundle.profile.playerProfile) || {};
    var player = profile.player || {};
    var name = safeStr(player.name || profile.name || "Player #" + pid);
    var pos = safeStr(player.position || "");
    var team = safeStr(player.team || "");
    var jersey = safeStr(player.jersey || player.jersey_number || "");
    var hgt = safeStr(player.height || "");
    var wgt = safeStr(player.weight || "");
    var dob = safeStr(player.birthdate || "");
    var college = safeStr(player.college || "");
    var newsItems = asArray(bundle && bundle.news);
    if (!newsItems.length && bundle && bundle.profile && bundle.profile.playerProfile) {
      newsItems = asArray(bundle.profile.playerProfile.news);
    }
    // Sort newest first (timestamp may be unix seconds string).
    newsItems = newsItems.slice().sort(function (a, b) {
      return Number(b.timestamp || 0) - Number(a.timestamp || 0);
    });
    // Injury overlay
    var inj = getInjuryFor(String(pid));
    var injHtml = inj
      ? '<div class="tops-profile-injury"><strong>' + escapeHtml(inj.status || "") + '</strong> — ' + escapeHtml(safeStr(inj.details) || "no detail") + '</div>'
      : "";
    var bioBits = [];
    if (jersey) bioBits.push("#" + jersey);
    if (pos) bioBits.push(pos);
    if (team) bioBits.push(team);
    if (hgt) bioBits.push(hgt);
    if (wgt) bioBits.push(wgt + " lbs");
    if (college) bioBits.push(college);
    if (dob) bioBits.push("DOB " + dob);
    var fullProfileHref = "https://www.myfantasyleague.com/" + encodeURIComponent(state.ctx.year) +
      "/options?L=" + encodeURIComponent(state.ctx.leagueId) +
      "&O=04&P=" + encodeURIComponent(pid);
    var newsHtml = newsItems.length
      ? '<ul class="tops-profile-news">' + newsItems.slice(0, 12).map(function (n) {
          var when = n.timestamp ? new Date(Number(n.timestamp) * 1000).toLocaleDateString() : "";
          var src = safeStr(n.source) || safeStr(n.author);
          var headline = safeStr(n.headline) || safeStr(n.title);
          var body = safeStr(n.story) || safeStr(n.body);
          return '<li class="tops-profile-news-item">' +
            '<div class="tops-profile-news-meta">' + escapeHtml(when) + (src ? ' · ' + escapeHtml(src) : '') + '</div>' +
            (headline ? '<div class="tops-profile-news-head">' + escapeHtml(headline) + '</div>' : '') +
            (body ? '<div class="tops-profile-news-body">' + escapeHtml(body.slice(0, 600)) + '</div>' : '') +
            '</li>';
        }).join("") + '</ul>'
      : '<div class="tops-empty">No recent news for this player.</div>';
    return [
      '<div class="tops-profile-head">',
      '  <h3 class="tops-profile-name">' + escapeHtml(name) + '</h3>',
      bioBits.length ? '  <div class="tops-profile-bio">' + escapeHtml(bioBits.join(" · ")) + '</div>' : '',
      injHtml,
      '</div>',
      '<div class="tops-profile-section-title">Recent News</div>',
      newsHtml,
      '<div class="tops-profile-actions">',
      '  <a class="tops-link-pill" href="' + fullProfileHref + '" target="_top">Open in MFL →</a>',
      '</div>'
    ].join("");
  }

  // ── News Feed for owned players (LAZY — don't auto-fetch) ──
  // Default state: list MFL injury designations (free — already in
  // state.injuries from the initial load). News headlines are LAZY:
  // user clicks "Load news feed" to trigger ~25 parallel
  // /api/player-bundle calls. Avoids slowing every page load when
  // most owners just want to see their roster + cap.
  // ── News helpers (shared with All-Player News card) ───────────────────
  var NEWS_PAGE_SIZE = 12;
  var NEWS_SORT_KEY = "ups_teamops_news_sort"; // 'newest' (default) or 'oldest'

  function getNewsSortPref() {
    try {
      var v = window.sessionStorage.getItem(NEWS_SORT_KEY);
      if (v === "oldest" || v === "newest") return v;
    } catch (e) {}
    return "newest";
  }
  function setNewsSortPref(v) {
    try { window.sessionStorage.setItem(NEWS_SORT_KEY, v); } catch (e) {}
  }

  // Unix-seconds → "5m ago" / "3h ago" / "2d ago" / "Mar 5" / "Mar 5, 2023".
  // Falls back to ISO date when timestamp is missing or in the future.
  function relativeTime(secs) {
    var t = Number(secs || 0);
    if (!t || !isFinite(t)) return "";
    var now = Math.floor(Date.now() / 1000);
    var diff = now - t;
    if (diff < 0) return new Date(t * 1000).toLocaleDateString();
    if (diff < 60) return diff + "s ago";
    if (diff < 3600) return Math.floor(diff / 60) + "m ago";
    if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
    if (diff < 7 * 86400) return Math.floor(diff / 86400) + "d ago";
    // Older — show absolute date; include year if not current year.
    var d = new Date(t * 1000);
    var sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString("en-US",
      sameYear ? { month: "short", day: "numeric" }
               : { month: "short", day: "numeric", year: "numeric" });
  }

  // Articles get matched to multiple players by the news handler (e.g., an
  // SFO team article matches every SFO team-pseudo: TMWR / TMRB / Def / ST
  // / etc.). Without dedup we render the same headline 10+ times.
  // Strategy: collapse rows that share (headline + first 80 chars of body),
  // keeping the first occurrence (after sort, that's the newest representative).
  // Per-player STATUS / DEPTH entries are NOT deduped across players — each
  // player legitimately has their own status row even if the headline is "Q".
  function dedupeNewsItems(items) {
    var seen = {};
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var n = items[i];
      var typ = String(n.type || "").toLowerCase();
      // Keep per-player rows for status/depth — those are legitimate per-player.
      if (typ === "status" || typ === "depth") {
        out.push(n);
        continue;
      }
      var hk = (n.headline || "").trim();
      var bk = (n.body || "").trim().slice(0, 80);
      var key = hk + "||" + bk;
      if (!hk && !bk) { out.push(n); continue; }   // nothing to key on
      if (seen[key]) continue;
      seen[key] = true;
      out.push(n);
    }
    return out;
  }

  function filterAndSortNews(items, searchStr, sortOrder) {
    var q = String(searchStr || "").trim().toLowerCase();
    var filtered = q
      ? items.filter(function (n) {
          var hay = (n.player + " " + (n.position || "") + " " + (n.team || "") + " " + (n.headline || "")).toLowerCase();
          return hay.indexOf(q) !== -1;
        })
      : items.slice();
    filtered.sort(function (a, b) {
      return sortOrder === "oldest" ? (a.when - b.when) : (b.when - a.when);
    });
    return dedupeNewsItems(filtered);
  }

  // Format MFL's "Last, First" player names as "First Last" — easier to
  // scan. Team defenses come as "Bills, Buffalo" → render "Buffalo Bills".
  function prettyPlayerName(raw) {
    var s = safeStr(raw);
    if (!s) return "";
    var m = s.match(/^([^,]+),\s*(.+)$/);
    return m ? (m[2].trim() + " " + m[1].trim()) : s;
  }

  // Lookup an active injury status for a player (Q/D/O/IR/etc.) so news
  // rows can flash a small badge inline next to the name.
  function newsInjStatusForPid(pid) {
    if (!pid) return "";
    var inj = (typeof getInjuryFor === "function") ? getInjuryFor(pid) : null;
    return inj && inj.status ? String(inj.status).trim() : "";
  }

  function newsItemHtml(n) {
    var pid = String(n.pid);
    var typeBadge = n.type === "status"   ? '<span class="tops-news-type-badge is-status">Injury</span>'
                 : n.type === "depth"     ? '<span class="tops-news-type-badge is-depth">Depth</span>'
                 : n.type === "headline"  ? '<span class="tops-news-type-badge is-headline">News</span>'
                 : '';
    var when = relativeTime(n.when);
    var bodyTrim = n.body ? escapeHtml(n.body.slice(0, 220)) + (n.body.length > 220 ? '…' : '') : "";

    // Inline injury badge: small Q/D/O chip next to the name when the
    // player has an active designation. Uses the same .tops-inj-* palette
    // as the always-on Injuries panel for visual consistency.
    var injStatus = newsInjStatusForPid(pid);
    var injMini = injStatus
      ? '<span class="tops-news-inj-mini tops-inj tops-inj-' + escapeHtml(injStatus) + '" title="Injury status: ' + escapeHtml(injStatus) + '">' + escapeHtml(injStatus) + '</span>'
      : '';

    // Player name = its own click target → opens master profile modal.
    var displayName = prettyPlayerName(n.player);
    var nameLink = '<button type="button" class="tops-news-player-link" data-pid="' + escapeHtml(pid) + '" title="Open player profile">' + escapeHtml(displayName) + '</button>';

    // Headline + body wrap in an <a> ONLY if we have an article URL.
    var headBodyInner =
      (n.headline ? '<div class="tops-news-head">' + escapeHtml(n.headline) + '</div>' : '') +
      (bodyTrim ? '<div class="tops-news-body">' + bodyTrim + '</div>' : '');
    var headBody = '';
    if (headBodyInner) {
      headBody = n.url
        ? '<a class="tops-news-article-link" href="' + escapeHtml(n.url) + '" target="_blank" rel="noopener noreferrer" title="Open article in new tab">' + headBodyInner + '</a>'
        : '<div class="tops-news-article-static">' + headBodyInner + '</div>';
    }

    return '<li class="tops-news-item' + (n.url ? ' has-article' : '') + '">' +
      '<div class="tops-news-row1">' +
        typeBadge +
        injMini +
        nameLink +
        (n.position ? '<span class="tops-news-pos">' + escapeHtml(n.position) + '</span>' : '') +
        (n.team ? '<span class="tops-news-team">' + escapeHtml(n.team) + '</span>' : '') +
        (when ? '<span class="tops-news-when" title="' + escapeHtml(new Date(Number(n.when || 0) * 1000).toISOString()) + '">' + escapeHtml(when) + '</span>' : '') +
      '</div>' +
      headBody +
      '</li>';
  }

  // Renders just the dynamic list portion of the news card. Called on
  // every search/sort/show-more so the controls (input/sort toggle) above
  // it don't get re-built and lose focus.
  // Only the player-name button opens the master profile modal. The
  // headline/body region is its own <a> (article link, when present) and
  // handles its own navigation. Re-binds after list re-renders.
  function rewireNewsItemClicks(rootEl) {
    rootEl.querySelectorAll(".tops-news-player-link").forEach(function (btn) {
      if (btn.__topsBound) return; // idempotent
      btn.__topsBound = true;
      btn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        openPlayerProfileModal(btn.getAttribute("data-pid"));
      });
    });
  }

  // ── All-Player News (Wave 3b) ──────────────────────────────────────────
  // League-wide news search. Filters: name (substring) · position pills
  // (QB/RB/WR/TE/K/DEF) · NFL team dropdown. Resolves the filter into a
  // list of player IDs (max 50, /api/player-news batch limit) and calls the
  // same news endpoint the per-roster card uses. Shares the sort
  // preference with the team news card (newest/oldest).
  // Offensive skill + kicker + team-defense + IDP. UPS-confirmed player
  // positions (live count from MFL): WR/LB/CB/RB/DT/DE/S/TE/QB/PK/PN/Def.
  // IDP grouping mirrors the MFL position values directly.
  var ALL_NEWS_POSITIONS = ["QB", "RB", "WR", "TE", "PK", "Def", "DT", "DE", "LB", "CB", "S"];
  var ALL_NEWS_MAX_PIDS = 50;

  // Lazily build a player index { pid → {name, position, team} } from the
  // already-loaded TYPE=players export. Cached for the session.
  var _allPlayerIndexCache = null;
  function getAllPlayerIndex() {
    if (_allPlayerIndexCache) return _allPlayerIndexCache;
    var out = { byPid: {}, teams: {}, posCounts: {} };
    if (state.players && state.players.players) {
      asArray(state.players.players.player).forEach(function (p) {
        var pid = String(p.id || "");
        if (!pid) return;
        var rec = {
          pid: pid,
          name: safeStr(p.name),
          position: safeStr(p.position),
          team: safeStr(p.team)
        };
        out.byPid[pid] = rec;
        if (rec.team) out.teams[rec.team] = (out.teams[rec.team] || 0) + 1;
        if (rec.position) out.posCounts[rec.position] = (out.posCounts[rec.position] || 0) + 1;
      });
    }
    _allPlayerIndexCache = out;
    return out;
  }

  // Build the candidate player pool based on scope + filters.
  //   scope === "myteam"  → starts from viewer's roster (the old per-roster
  //                          News card behavior, with no /api/player-news
  //                          batch cap since rosters are ≤25 players).
  //   scope === "all"      → starts from the full NFL player index.
  // Position / NFL team / name filters then narrow the result.
  function resolveAllPlayerNewsCandidates() {
    var f = state.allPlayerNewsFilters || {};
    var scope = (f.scope === "all") ? "all" : "myteam";
    var name = String(f.name || "").trim().toLowerCase();
    var pos  = String(f.position || "").trim();
    var team = String(f.team || "").trim().toUpperCase();
    var idx = getAllPlayerIndex();

    var pool;
    if (scope === "myteam") {
      var roster = getMyRoster();
      pool = roster.map(function (r) {
        return idx.byPid[r.id] || { pid: r.id, name: "Player #" + r.id, position: "", team: "" };
      });
    } else {
      pool = Object.keys(idx.byPid).map(function (pid) { return idx.byPid[pid]; });
    }

    var out = pool.filter(function (r) {
      if (pos  && r.position !== pos)  return false;
      if (team && String(r.team || "").toUpperCase() !== team) return false;
      if (name && r.name.toLowerCase().indexOf(name) === -1) return false;
      return true;
    });

    // For All scope, order NFL-active first then alphabetic; for My Team
    // keep roster order (which is already meaningful — starters first etc).
    if (scope === "all") {
      out.sort(function (a, b) {
        var aFA = !a.team || a.team === "FA";
        var bFA = !b.team || b.team === "FA";
        if (aFA !== bFA) return aFA ? 1 : -1;
        return a.name.localeCompare(b.name);
      });
    }
    return out;
  }

  function renderAllPlayerNewsList(container) {
    if (!container) return;
    if (state.allPlayerNewsLoading) {
      container.innerHTML = '<div class="tops-empty">Searching news for ' + (state.allPlayerNewsBatchSize || "…") + ' players…</div>';
      return;
    }
    if (!state.allPlayerNewsItems) {
      var scope = (state.allPlayerNewsFilters && state.allPlayerNewsFilters.scope) || "myteam";
      var hint = (scope === "myteam")
        ? 'Loading your team\'s news automatically…'
        : 'Pick a position / team / name above, then <strong>Find News</strong>.';
      container.innerHTML = '<div class="tops-empty" style="font-size:11px; padding:6px 0;">' + hint + '</div>';
      return;
    }
    var sortOrder = getNewsSortPref();
    var sorted = filterAndSortNews(state.allPlayerNewsItems, "", sortOrder);
    // Client-side type filter (Injury / Depth / News / All). Maps to the
    // worker's type field: status / depth / headline.
    var itype = (state.allPlayerNewsFilters && state.allPlayerNewsFilters.itemType) || "";
    if (itype) {
      sorted = sorted.filter(function (n) { return String(n.type || "") === itype; });
    }
    var showN = Math.min(sorted.length, state.allPlayerNewsShowN || NEWS_PAGE_SIZE);
    var visible = sorted.slice(0, showN);
    if (!visible.length) {
      var emptyMsg = itype
        ? 'No "' + (itype === "status" ? "Injury" : itype === "depth" ? "Depth" : "News") + '" items for these filters.'
        : 'No news for these filters in the last few weeks.';
      container.innerHTML = '<div class="tops-empty" style="font-size:11px; padding:6px 0;">' + emptyMsg + '</div>';
      return;
    }
    var more = sorted.length > showN
      ? '<button class="tops-news-more" data-news-card="all">Show ' + Math.min(NEWS_PAGE_SIZE, sorted.length - showN) + ' more <span class="muted">(' + (sorted.length - showN) + ' remaining)</span></button>'
      : '';
    container.innerHTML = '<ul class="tops-news-list">' + visible.map(newsItemHtml).join("") + '</ul>' + more;
  }

  function renderAllPlayerNews() {
    var el = els.cards.allPlayerNews;
    if (!el) return;
    if (!state.players || !state.players.players) {
      el.innerHTML = '<div class="tops-card-title">Player News & Injuries</div><div class="tops-empty">Player index still loading…</div>';
      return;
    }
    // Default scope is My Team — opens straight to the user's roster news
    // with no extra clicks. Other pills switch to League-wide scope.
    state.allPlayerNewsFilters = state.allPlayerNewsFilters || { scope: "myteam", name: "", position: "", team: "", itemType: "" };
    if (!state.allPlayerNewsFilters.scope) state.allPlayerNewsFilters.scope = "myteam";
    if (state.allPlayerNewsFilters.itemType == null) state.allPlayerNewsFilters.itemType = "";
    state.allPlayerNewsShowN   = state.allPlayerNewsShowN   || NEWS_PAGE_SIZE;
    var f = state.allPlayerNewsFilters;
    var sortOrder = getNewsSortPref();
    var idx = getAllPlayerIndex();

    // Always-on injuries panel (cheap — already loaded). Only shown when
    // the viewer is looking at their own team (scope=myteam), since
    // injuries are filtered to roster players.
    var injHtml = "";
    var myInjsCount = 0;
    if (f.scope === "myteam") {
      var roster = getMyRoster();
      var injs = (state.injuries && asArray(state.injuries.injuries && state.injuries.injuries.injury)) || [];
      var rosterIds = {};
      roster.forEach(function (r) { rosterIds[String(r.id)] = true; });
      var myInjs = injs.filter(function (i) { return rosterIds[String(i.id)]; });
      myInjsCount = myInjs.length;
      injHtml = myInjs.length
        ? '<div class="tops-news-section-title">Active Injuries</div>'
          + '<ul class="tops-news-list">' + myInjs.slice(0, 8).map(function (i) {
            var p = playerById(i.id) || {};
            var name = prettyPlayerName(p.name) || ("Player #" + i.id);
            var stat = String(i.status || "?");
            return '<li class="tops-news-item">'
              + '<div class="tops-news-row1">'
              +   '<span class="tops-news-inj-mini tops-inj tops-inj-' + escapeHtml(stat) + '" title="' + escapeHtml(stat) + '">' + escapeHtml(stat) + '</span>'
              +   '<button type="button" class="tops-news-player-link" data-pid="' + escapeHtml(String(i.id)) + '" title="Open player profile">' + escapeHtml(name) + '</button>'
              +   (p.position ? '<span class="tops-news-pos">' + escapeHtml(p.position) + '</span>' : '')
              +   (p.team ? '<span class="tops-news-team">' + escapeHtml(p.team) + '</span>' : '')
              + '</div>'
              + (i.details ? '<div class="tops-news-body">' + escapeHtml(i.details) + '</div>' : '')
              + '</li>';
          }).join("") + '</ul>'
          + '<div class="tops-news-divider"></div>'
        : '';
    }

    // Build NFL team dropdown options — alphabetized, with FA last.
    var teams = Object.keys(idx.teams).filter(function (t) { return t && t !== "FA"; }).sort();
    var teamOptions = '<option value="">All NFL teams</option>'
      + teams.map(function (t) { return '<option value="' + escapeHtml(t) + '"' + (t === f.team ? ' selected' : '') + '>' + escapeHtml(t) + ' (' + idx.teams[t] + ')</option>'; }).join("")
      + '<option value="FA"' + (f.team === "FA" ? ' selected' : '') + '>Free Agents</option>';

    // Pill bar: My Team is a "scope" pill (yellow accent), followed by a
    // divider, then position pills (All / QB / RB / WR / TE / PK / Def +
    // IDP DT/DE/LB/CB/S). Clicking My Team → scope=myteam, clears position
    // filter. Clicking any position pill → scope=all + sets position.
    var myTeamOn = (f.scope === "myteam") ? "1" : "0";
    var pillBar = '<div class="tops-pos-pills">'
      + '<button type="button" class="tops-pos-pill tops-pos-pill--scope" data-scope="myteam" data-active="' + myTeamOn + '">My Team</button>'
      + '<span class="tops-pill-divider" aria-hidden="true"></span>'
      + '<button type="button" class="tops-pos-pill" data-pos="" data-active="' + ((f.scope === "all" && !f.position) ? "1" : "0") + '">All</button>'
      + ALL_NEWS_POSITIONS.map(function (p) {
          var on = (f.scope === "all" && f.position === p) ? "1" : "0";
          return '<button type="button" class="tops-pos-pill" data-pos="' + escapeHtml(p) + '" data-active="' + on + '">' + escapeHtml(p) + '</button>';
        }).join("")
      + '</div>';

    // Item-type pills (client-side display filter on already-loaded items —
    // no refetch). All / Injury / Depth / News map to the news handler's
    // type field: status / depth / headline.
    var ITYPES = [
      { id: "",         label: "All" },
      { id: "status",   label: "Injury" },
      { id: "depth",    label: "Depth" },
      { id: "headline", label: "News" }
    ];
    var typeBar = '<div class="tops-pos-pills tops-itype-pills">'
      + '<span class="tops-itype-label">Type</span>'
      + ITYPES.map(function (t) {
          var on = (f.itemType === t.id) ? "1" : "0";
          return '<button type="button" class="tops-pos-pill" data-itype="' + escapeHtml(t.id) + '" data-active="' + on + '">' + escapeHtml(t.label) + '</button>';
        }).join("")
      + '</div>';

    var candidates = resolveAllPlayerNewsCandidates();
    var candCount = candidates.length;
    var capped = Math.min(candCount, ALL_NEWS_MAX_PIDS);
    var statusLine;
    if (f.scope === "myteam") {
      statusLine = candCount + ' player' + (candCount === 1 ? '' : 's') + ' on your roster' +
        (f.position ? ' (' + escapeHtml(f.position) + ')' : '') +
        (f.team ? ' on ' + escapeHtml(f.team) : '') +
        (f.name ? ' matching "' + escapeHtml(f.name) + '"' : '') + '.';
    } else if (candCount === 0) {
      statusLine = 'No players match these filters.';
    } else if (candCount > ALL_NEWS_MAX_PIDS) {
      statusLine = candCount + ' matches — narrowing to top <strong>' + capped + '</strong> (alphabetical, NFL-active first).';
    } else {
      statusLine = candCount + ' matching player' + (candCount === 1 ? '' : 's') + '.';
    }

    var titleCount = (f.scope === "myteam" && myInjsCount > 0)
      ? ' <span class="tops-count">' + myInjsCount + '</span>'
      : '';

    el.innerHTML = [
      '<div class="tops-card-title">Player News & Injuries' + titleCount + '</div>',
      injHtml,
      '<div class="tops-allnews-controls">',
      pillBar,
      '  <select class="tops-allnews-team">' + teamOptions + '</select>',
      '  <input type="text" class="tops-allnews-name" placeholder="Search player name…" value="' + escapeHtml(f.name) + '">',
      '  <button type="button" class="tops-allnews-go" data-disabled="' + (candCount === 0 ? "1" : "0") + '">Find News</button>',
      '  <button type="button" class="tops-news-sort" data-allnews-sort title="Toggle sort order">' + (sortOrder === "newest" ? '↓ Newest' : '↑ Oldest') + '</button>',
      '</div>',
      typeBar,
      '<div class="tops-allnews-status">' + statusLine + '</div>',
      '<div class="tops-allnews-list-mount"></div>'
    ].join("");

    var listMount = el.querySelector(".tops-allnews-list-mount");
    renderAllPlayerNewsList(listMount);

    // ── Wire interactions ──
    // My Team scope pill — switches to roster-scoped view.
    el.querySelectorAll("[data-scope]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.allPlayerNewsFilters.scope = "myteam";
        state.allPlayerNewsFilters.position = "";
        state.allPlayerNewsItems = null;
        state.allPlayerNewsShowN = NEWS_PAGE_SIZE;
        renderAllPlayerNews();
        // Auto-fetch since roster pool is small.
        setTimeout(doAllPlayerNewsSearch, 0);
      });
    });

    // Item-type pills (Injury / Depth / News / All) — purely client-side
    // display filter, no refetch. Just re-renders the list mount.
    el.querySelectorAll("[data-itype]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.allPlayerNewsFilters.itemType = btn.getAttribute("data-itype");
        state.allPlayerNewsShowN = NEWS_PAGE_SIZE; // reset pagination
        // Update the pill-active state without a full re-render so the
        // search input keeps focus.
        el.querySelectorAll("[data-itype]").forEach(function (b) {
          b.setAttribute("data-active", b === btn ? "1" : "0");
        });
        renderAllPlayerNewsList(listMount);
        rewireNewsItemClicks(el);
      });
    });

    // Position pills — flip scope to "all" since position-filter implies
    // league-wide search.
    el.querySelectorAll("[data-pos]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.allPlayerNewsFilters.scope = "all";
        state.allPlayerNewsFilters.position = btn.getAttribute("data-pos");
        state.allPlayerNewsItems = null;
        state.allPlayerNewsShowN = NEWS_PAGE_SIZE;
        renderAllPlayerNews();
      });
    });

    // Team dropdown
    var teamSel = el.querySelector(".tops-allnews-team");
    if (teamSel) teamSel.addEventListener("change", function () {
      state.allPlayerNewsFilters.team = teamSel.value || "";
      state.allPlayerNewsItems = null;
      state.allPlayerNewsShowN = NEWS_PAGE_SIZE;
      renderAllPlayerNews();
    });

    // Name input — debounced
    var nameInput = el.querySelector(".tops-allnews-name");
    if (nameInput) {
      var deb = null;
      nameInput.addEventListener("input", function () {
        if (deb) clearTimeout(deb);
        deb = setTimeout(function () {
          state.allPlayerNewsFilters.name = nameInput.value || "";
          state.allPlayerNewsItems = null;
          state.allPlayerNewsShowN = NEWS_PAGE_SIZE;
          renderAllPlayerNews();
        }, 250);
      });
      nameInput.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter") {
          state.allPlayerNewsFilters.name = nameInput.value || "";
          ev.preventDefault();
          doAllPlayerNewsSearch();
        }
      });
    }

    // Find News button
    var goBtn = el.querySelector(".tops-allnews-go");
    if (goBtn) {
      goBtn.addEventListener("click", function () {
        if (goBtn.getAttribute("data-disabled") === "1") return;
        doAllPlayerNewsSearch();
      });
    }

    // Sort toggle
    var sortBtn = el.querySelector("[data-allnews-sort]");
    if (sortBtn) sortBtn.addEventListener("click", function () {
      var next = getNewsSortPref() === "newest" ? "oldest" : "newest";
      setNewsSortPref(next);
      sortBtn.textContent = next === "newest" ? "↓ Newest" : "↑ Oldest";
      renderAllPlayerNewsList(listMount);
      rewireNewsItemClicks(el);
    });

    // Show-more (delegated)
    el.addEventListener("click", function (ev) {
      var more = ev.target.closest('.tops-news-more[data-news-card="all"]');
      if (!more) return;
      state.allPlayerNewsShowN = (state.allPlayerNewsShowN || NEWS_PAGE_SIZE) + NEWS_PAGE_SIZE;
      renderAllPlayerNewsList(listMount);
      rewireNewsItemClicks(el);
    });

    rewireNewsItemClicks(el);

    // Auto-fetch for My Team scope on first render when no items loaded yet.
    if (f.scope === "myteam" && !state.allPlayerNewsItems && !state.allPlayerNewsLoading) {
      setTimeout(doAllPlayerNewsSearch, 0);
    }
  }

  function doAllPlayerNewsSearch() {
    var el = els.cards && els.cards.allPlayerNews;
    if (!el) return;
    var candidates = resolveAllPlayerNewsCandidates();
    if (!candidates.length) return;
    // My Team scope: send the full roster pool (rosters are small, well
    // under the 50 cap). All scope: respect the cap.
    var scope = (state.allPlayerNewsFilters && state.allPlayerNewsFilters.scope) || "myteam";
    var capped = (scope === "myteam") ? candidates : candidates.slice(0, ALL_NEWS_MAX_PIDS);
    state.allPlayerNewsLoading = true;
    state.allPlayerNewsBatchSize = capped.length;
    var listMount = el.querySelector(".tops-allnews-list-mount");
    if (listMount) renderAllPlayerNewsList(listMount);

    var pids = capped.map(function (r) { return r.pid; });
    var url = workerUrl("/api/player-news?L=" + encodeURIComponent(state.ctx.leagueId) +
                        "&YEAR=" + encodeURIComponent(state.ctx.year) +
                        "&pids=" + encodeURIComponent(pids.join(",")));
    fetch(url, { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        var items = [];
        var byPid = (data && data.items_by_pid) || {};
        var idx = getAllPlayerIndex();
        Object.keys(byPid).forEach(function (pid) {
          var rec = idx.byPid[pid] || {};
          (byPid[pid] || []).forEach(function (n) {
            items.push({
              pid: pid,
              player: rec.name || ("Player #" + pid),
              position: rec.position || "",
              team: rec.team || "",
              when: Number(n.timestamp || 0),
              headline: safeStr(n.headline),
              body: safeStr(n.body),
              source: safeStr(n.source),
              type: safeStr(n.type),
              url: safeStr(n.url)
            });
          });
        });
        state.allPlayerNewsItems = items;
        state.allPlayerNewsLoading = false;
        renderAllPlayerNews();
      })
      .catch(function () {
        state.allPlayerNewsItems = [];
        state.allPlayerNewsLoading = false;
        renderAllPlayerNews();
      });
  }

  // [v1.7.40 cleanup] The old openMflPlayerProfile redirect-to-MFL
  // function previously lived here. v1.7.38's global rename
  // accidentally renamed it to openPlayerProfileModal, creating a
  // duplicate that overrode the new 4-tab modal — JavaScript takes the
  // last declaration so clicks went to window.open(...) instead of the
  // modal. Function removed entirely.

  // Friendly empty state when no franchise could be resolved. Surfaces a
  // dropdown of league franchises so the viewer can pick manually rather
  // than staring at all zeros. Selection is persisted to localStorage
  // so future loads remember.
  function renderViewerEmptyState() {
    var summaryEl = els.cards.summary;
    if (!summaryEl) return;
    var franchises = (state.franchises || []).slice().sort(function (a, b) {
      return safeStr(a.name).localeCompare(safeStr(b.name));
    });
    var diagnostics = [];
    if (!state.league) diagnostics.push("league fetch failed (CORS or network)");
    if (!franchises.length) diagnostics.push("no franchises in league data");
    if (state.loadErrors && state.loadErrors.length) {
      diagnostics.push(state.loadErrors.length + " endpoint error(s)");
    }
    var optsHtml = franchises.map(function (f) {
      return '<option value="' + escapeHtml(f.id) + '">' + escapeHtml(f.name) + '</option>';
    }).join("");
    var diagHtml = diagnostics.length
      ? '<div class="tops-empty" style="margin-top:8px; color:var(--tops-bad,#7de8d9); font-weight:700;">' +
        '⚠ ' + escapeHtml(diagnostics.join(" · ")) + '</div>'
      : "";
    summaryEl.innerHTML = [
      '<div class="tops-card-title">Pick Your Franchise</div>',
      '<div class="tops-empty" style="margin-bottom:10px; line-height:1.5;">',
      "  We couldn't figure out which franchise is yours from this page.",
      "  Pick from the list below — we'll remember it for next time.",
      '</div>',
      franchises.length
        ? '<div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">' +
          '  <select id="topsViewerPicker" style="flex:1; min-width:180px; padding:8px 10px; font-size:14px; background:#0f1116; color:#fff; border:1px solid rgba(255,255,255,0.15); border-radius:6px;">' +
          '    <option value="">— Pick franchise —</option>' +
          optsHtml +
          '  </select>' +
          '  <button id="topsViewerPickerSave" class="tops-link-pill" style="cursor:pointer; border:none; font-size:13px;">Use this</button>' +
          '</div>'
        : '<div class="tops-empty">League data hasn\'t loaded — refresh to retry.</div>',
      diagHtml,
    ].join("");
    var btn = document.getElementById("topsViewerPickerSave");
    if (btn) {
      btn.addEventListener("click", function () {
        var sel = document.getElementById("topsViewerPicker");
        var pickedFid = sel && sel.value;
        if (!pickedFid) return;
        try { window.localStorage && window.localStorage.setItem("rdh_my_fid", pickedFid); } catch (e) {}
        state.viewerFranchiseId = pickedFid;
        state.viewerFranchise = state.franchises.find(function (f) { return f.id === pickedFid; }) || null;
        renderAll();
      });
    }
    // Blank out the rest of the cards so the page doesn't look broken.
    Object.keys(els.cards).forEach(function (k) {
      if (k === "summary") return;
      var el = els.cards[k];
      if (el) el.innerHTML = '<div class="tops-empty">Pick your franchise above to populate.</div>';
    });
  }

  function renderLoadingShell() {
    var mount = document.getElementById("teamOpsMount");
    if (!mount) return;
    mount.innerHTML = '<div class="tops-shell"><div class="tops-loading"><div class="tops-spinner"></div><div>Loading My Team…</div></div></div>';
  }

  function renderError(msg) {
    var mount = document.getElementById("teamOpsMount");
    if (!mount) return;
    mount.innerHTML = '<div class="tops-shell"><div class="tops-error"><strong>My Team failed to load.</strong><br>' + escapeHtml(msg) + '</div></div>';
  }

  // ---------- Init ----------

  function buildContext() {
    return {
      leagueId: safeStr(window.UPS_TEAMOPS_LEAGUE_ID || ""),
      year: safeStr(window.UPS_TEAMOPS_YEAR || String(new Date().getFullYear())),
      franchiseId: pad4(window.UPS_TEAMOPS_FRANCHISE_ID || "")
    };
  }

  function init() {
    if (!document.getElementById("teamOpsMount")) return;
    state.ctx = buildContext();
    if (!state.ctx.leagueId) {
      renderError("Could not resolve league ID from URL or globals.");
      return;
    }
    renderLoadingShell();
    loadAllData()
      .then(function () { renderAll(); })
      .catch(function (err) { renderError(err && err.message ? err.message : String(err)); });
  }

  window.UPS_TEAMOPS_INIT = init;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
