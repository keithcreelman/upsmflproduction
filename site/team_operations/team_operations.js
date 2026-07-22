(function () {
  "use strict";

  var BUILD = "2026.07.21.home-hub";
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

  // ==========================================================================
  // UPS Home Hub — 5-zone spine (redesign approved 2026-07-21)
  //
  //   identity bar → Zone 1 "Needs You" (the only above-the-fold CTA, and the
  //   ONLY place gold is used) → Zone 2 team-state strip → Zone 3 lineup /
  //   roster-shape against the real 18 slots → Zone 4 League Pulse + Calendar
  //   → Zone 5 demoted nav pills → footer.
  //
  // Authoring surfaces (roster table, trade bait, news search) are demoted to
  // disclosure panels behind Zone 5 pills or linked out to Front Office; the
  // hub itself stays a read-and-decide page.
  // ==========================================================================

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
    var sign = x < 0 ? "-" : "";
    var a = Math.abs(x);
    if (a >= 1000) return sign + "$" + Math.round(a / 1000) + "K";
    return sign + "$" + Math.round(a);
  }
  function asArray(v) {
    if (Array.isArray(v)) return v;
    if (v == null || v === "") return [];
    return [v];
  }
  function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }
  function daysUntil(iso) {
    if (!iso) return null;
    try {
      var target = new Date(iso + "T00:00:00");
      var now = new Date();
      var ms = target.getTime() - now.getTime();
      return Math.ceil(ms / (1000 * 60 * 60 * 24));
    } catch (e) { return null; }
  }
  // "in 4 days" / "tomorrow" / "today" / "3 days ago"
  function whenLabel(d) {
    if (d == null) return "";
    if (d < 0) return Math.abs(d) + "d ago";
    if (d === 0) return "today";
    if (d === 1) return "tomorrow";
    return "in " + d + " days";
  }
  // MFL stores "Last, First". Team defenses come as "Bills, Buffalo".
  function prettyPlayerName(raw) {
    var s = safeStr(raw);
    if (!s) return "";
    var m = s.match(/^([^,]+),\s*(.+)$/);
    return m ? (m[2].trim() + " " + m[1].trim()) : s;
  }
  // "Daniels, Jayden" → "J. Daniels" (fits the lineup chips).
  function shortName(raw) {
    var s = safeStr(raw);
    if (!s) return "";
    var m = s.match(/^([^,]+),\s*(.+)$/);
    if (!m) return s;
    var last = m[1].trim();
    var first = m[2].trim();
    return first ? (first.charAt(0) + ". " + last) : last;
  }
  // Franchise name → up-to-3-letter monogram for the identity mark.
  function monogram(name) {
    var words = safeStr(name).split(/\s+/).filter(Boolean);
    if (!words.length) return "UPS";
    return words.slice(0, 3).map(function (w) { return w.charAt(0).toUpperCase(); }).join("");
  }

  // ---------- State ----------

  var state = {
    ctx: null,
    league: null,
    franchises: [],
    rosterLimit: 0,
    viewerFranchiseId: "",
    viewerFranchise: null,
    salaries: null,
    rosters: null,
    transactions: null,
    pendingTrades: null,
    tradeBait: null,
    futureDraftPicks: null,
    schedule: null,
    leagueStandings: null,
    players: null,
    injuries: null,
    salaryAdjustments: null,
    leagueEvents: null,
    capAmount: 0,
    loadErrors: [],
    lastLoaded: null,
    // Per-player bundle cache populated lazily via /api/player-bundle on
    // the Cloudflare worker. Same endpoint Draft Hub + Front Office use,
    // so once any hub primes a player, all three benefit (worker edge cache).
    playerBundles: {},
    // Lineup builder draft — SLOT MAP { slotId: pid } against LINEUP_SLOTS
    // below. (Was a flat Set<string> under the old, wrong 14-starter model.)
    lineupDraft: null,         // { [slotId]: pid } | null
    lineupSubmitting: false,
    lineupMessage: null,       // { kind: "ok"|"err"|"info", text: string } | null
    // Zone 5 disclosure panels — lazily rendered on first open so a collapsed
    // panel never costs a worker round-trip.
    openPanel: "",             // "" | "news" | "bait"
    tradeBaitDraft: null,      // Set<string> | null — pid -> available
    tradeBaitLookingFor: "",   // free text submitted as WILL_TAKE_TEXT
    tradeBaitSubmitting: false,
    tradeBaitMessage: null,
    // Per-player notes — pid → "free text". UPS-side only; persisted in
    // D1 via /api/submit-trade-bait + read via /api/trade-bait-notes.
    tradeBaitNotes: null,      // { [pid]: string } | null
    tradeBaitNotesLoaded: false
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

  // Native-MFL link builders. Everything the hub links out to is either a
  // MESSAGEnn hub module (our custom pages) or a stock MFL report page.
  // Targets are `_top` because the hub renders inside a height-synced iframe.
  function mflSiteBase() {
    var host = "";
    try { host = window.location.host || ""; } catch (e) {}
    if (!/myfantasyleague\.com$/i.test(host)) host = "www48.myfantasyleague.com";
    return "//" + host + "/" + encodeURIComponent((state.ctx && state.ctx.year) || "");
  }
  // module strings carry their own "=" / "&" (e.g. "MESSAGE6=N",
  // "MESSAGE19&hub=auction-hub") so they are deliberately NOT encoded.
  function mflModuleUrl(module) {
    var lid = (state.ctx && state.ctx.leagueId) || "";
    return mflSiteBase() + "/home/" + encodeURIComponent(lid) + "?MODULE=" + module;
  }
  function mflPageUrl(path) {
    var lid = (state.ctx && state.ctx.leagueId) || "";
    var sep = path.indexOf("?") === -1 ? "?" : "&";
    return mflSiteBase() + path + sep + "L=" + encodeURIComponent(lid);
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
      // the cap tile displays the same number FO shows.
      ["salaryAdjustments", fetchJson(mflExportUrl("salaryAdjustments")).catch(function () { return null; })],
      ["players", fetchJson(mflExportUrl("players", { DETAILS: "1" }))],
      ["transactions", fetchJson(mflExportUrl("transactions", { DAYS: 14 }))],
      ["pendingTrades", fetchJson(mflExportUrl("pendingTrades"))],
      ["tradeBait", fetchJson(mflExportUrl("tradeBait"))],
      ["futureDraftPicks", fetchJson(mflExportUrl("futureDraftPicks"))],
      ["schedule", fetchJson(mflExportUrl("schedule"))],
      // leagueStandings powers the identity bar record + the in-season
      // Record / All-Play tiles. Replaced the two exports nothing read
      // (nflByeWeeks, calendar) — net one FEWER round trip per load.
      ["leagueStandings", fetchJson(mflExportUrl("leagueStandings")).catch(function () { return null; })],
      ["injuries", fetchJson(mflExportUrl("injuries"))],
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
      // the Calendar zone handles missing data.
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
    state.rosterLimit = Number(lg.rosterLimit || 0) || 0;
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

  // Read a cookie value WITHOUT decodeURIComponent — needed for forwarding
  // MFL session tokens that contain literal %-escaped bytes in storage
  // (e.g. aRBv1sCXvrLtj1DnZQifOg%3D%3D). MFL stores + sends the cookie
  // with literal %3D%3D and rejects sessions that come back decoded.
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

  // ---------- Data shaping ----------

  // pid -> MFL player record. Indexed once: the zone renderers each walk the
  // roster, and a linear scan of ~2,500 players per lookup added up fast.
  // state.players never changes after load, so the cache never needs busting.
  var _playerByIdCache = null;
  function playerById(id) {
    if (!state.players || !state.players.players) return null;
    if (!_playerByIdCache) {
      _playerByIdCache = {};
      asArray(state.players.players.player).forEach(function (p) {
        if (p && p.id != null) _playerByIdCache[String(p.id)] = p;
      });
    }
    return _playerByIdCache[String(id)] || null;
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
  function getMyAdjustmentTotal() {
    return getAdjustmentTotals()[pad4(state.viewerFranchiseId || "")] || 0;
  }
  // { fid -> signed adjustment total } for every franchise. Used by both the
  // viewer's cap tile and the league-wide cap-room ranking.
  function getAdjustmentTotals() {
    var out = {};
    var root = state.salaryAdjustments && state.salaryAdjustments.salaryAdjustments;
    if (!root) return out;
    asArray(root.salaryAdjustment || root.adjustment).forEach(function (row) {
      if (!row) return;
      var rowFid = pad4(row.franchise_id || row.franchise || row.id || "");
      if (!rowFid) return;
      out[rowFid] = (out[rowFid] || 0) + Number(row.amount || 0);
    });
    return out;
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

  function franchiseDisplayName(fid) {
    var f = pad4(fid);
    var fr = (state.franchises || []).find(function (x) { return pad4(x.id) === f; });
    return (fr && fr.name) || ("Franchise " + f);
  }

  // ---------- Cap math ----------
  //
  // Cap hit rules (must match Roster Workbench's currentCapHit):
  //   • Expired contract (contractYear <= 0): 0% — player is on roster
  //     awaiting Expired Rookie Auction / cut, but contract has lapsed
  //     so no cap charge. (Roster Workbench: `if (y <= 0) return 0;`.)
  //   • Taxi: 0% — taxi salary is real money but DOES NOT count vs cap.
  //   • IR:   50% — half of salary counts toward cap.
  //   • All other roster states: 100%.
  function roundToK(n) { return Math.round(Number(n || 0) / 1000) * 1000; }

  function playerCapCharge(salary, status, contractYear) {
    var amt = Number(salary || 0);
    var cy = parseInt(contractYear, 10);
    var st = safeStr(status);
    if (cy === 0) return 0;                       // expired — off-cap
    if (/taxi/i.test(st)) return 0;               // taxi — off-cap
    if (/ir|injured/i.test(st)) return Math.round(amt * 0.5);
    return amt;
  }

  function capSummary() {
    var salaries = getMySalaries();
    var roster = getMyRoster();
    var statusById = {};
    roster.forEach(function (r) { statusById[r.id] = safeStr(r.status); });

    var playerSalaryUsed = 0;   // active + IR×0.5 (cap-charging player salary)
    var taxiSalary = 0;         // off-cap
    var irSalaryFull = 0;       // raw IR salary before the 50% factor
    var expiredSalary = 0;      // raw cy<=0 salary, off-cap
    var expiredCount = 0;
    salaries.forEach(function (s) {
      var amt = Number(s.salary || 0);
      var status = statusById[s.id] || "";
      var cy = parseInt(s.contractYear, 10);
      if (cy === 0) { expiredSalary += amt; expiredCount += 1; return; }
      if (/taxi/i.test(status)) { taxiSalary += amt; return; }
      if (/ir|injured/i.test(status)) { irSalaryFull += amt; }
      playerSalaryUsed += playerCapCharge(amt, status, cy);
    });

    var adjustmentTotal = getMyAdjustmentTotal();
    var cap = state.capAmount;

    // Round each component to the nearest $1K, then derive the total and the
    // room from those rounded values so all displayed numbers add up:
    //   displayed salary + displayed adj    = displayed cap total
    //   displayed cap    − displayed total  = displayed cap room
    // Without this, $272.5K used + $27.5K free both round UP to $273K + $28K
    // = $301K, breaking the tie (Keith 2026-05-14).
    var salaryR = roundToK(playerSalaryUsed);
    var adjR = roundToK(adjustmentTotal);
    var totalR = salaryR + adjR;
    var remainR = cap - totalR;

    var irCount = roster.filter(function (p) { return /ir|injured/i.test(p.status); }).length;
    var taxiCount = roster.filter(function (p) { return /taxi/i.test(p.status); }).length;

    return {
      cap: cap,
      salary: salaryR,
      adj: adjR,
      total: totalR,
      remain: remainR,
      pct: cap > 0 ? Math.min(100, Math.round((totalR / cap) * 100)) : 0,
      taxiSalary: taxiSalary,
      irSalary: irSalaryFull,
      expiredSalary: expiredSalary,
      expiredCount: expiredCount,
      rosterCount: roster.length,
      taxiCount: taxiCount,
      irCount: irCount,
      activeCount: roster.length - taxiCount - irCount
    };
  }

  // Where the viewer's cap room ranks league-wide. Derived from the rosters
  // export (which carries per-franchise salaries) using the SAME cap rules as
  // capSummary, so the ranking can't disagree with the headline number.
  function capRoomRank() {
    var frs = asArray(state.rosters && state.rosters.rosters && state.rosters.rosters.franchise);
    if (frs.length < 2 || !state.capAmount) return null;
    var adj = getAdjustmentTotals();
    var rows = frs.map(function (f) {
      var fid = pad4(f.id);
      var used = 0;
      asArray(f.player).forEach(function (p) {
        used += playerCapCharge(p.salary, p.status, p.contractYear);
      });
      return { id: fid, room: state.capAmount - roundToK(used) - roundToK(adj[fid] || 0) };
    });
    rows.sort(function (a, b) { return b.room - a.room; });
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].id === state.viewerFranchiseId) return { rank: i + 1, of: rows.length };
    }
    return null;
  }

  // ---------- The 18-starter slot model ----------
  //
  // The 18 starting slots, in display order (MFL L=74598, verified against
  // export?TYPE=league `starters`). `accepts` = canonical position groups that
  // may fill the slot; `flex` flags multi-position slots; `note` is the
  // eligibility hint shown under flex labels.
  // Offense 11 = 1 QB, 2 RB, 2 WR, 1 TE, 2 O-Flex, 1 SuperFlex, 1 K, 1 P
  // Defense  7 = 2 DL, 2 LB, 2 DB, 1 D-Flex
  //
  // Mirrors site/m/front_office_lineup.js (lines 46-65) and the copy in
  // site/gameday/gameday.html — keep all three in sync.
  var LINEUP_SLOTS = [
    { id: "QB1", label: "QB",        side: "O", accepts: ["QB"] },
    { id: "RB1", label: "RB",        side: "O", accepts: ["RB"] },
    { id: "RB2", label: "RB",        side: "O", accepts: ["RB"] },
    { id: "WR1", label: "WR",        side: "O", accepts: ["WR"] },
    { id: "WR2", label: "WR",        side: "O", accepts: ["WR"] },
    { id: "TE1", label: "TE",        side: "O", accepts: ["TE"] },
    { id: "OF1", label: "Flex",      side: "O", accepts: ["RB", "WR", "TE"],       flex: true, note: "RB/WR/TE" },
    { id: "OF2", label: "Flex",      side: "O", accepts: ["RB", "WR", "TE"],       flex: true, note: "RB/WR/TE" },
    { id: "SF1", label: "SuperFlex", side: "O", accepts: ["QB", "RB", "WR", "TE"], flex: true, note: "QB/RB/WR/TE" },
    { id: "PK1", label: "K",         side: "O", accepts: ["PK"] },
    { id: "PN1", label: "P",         side: "O", accepts: ["PN"] },
    { id: "DL1", label: "DL",        side: "D", accepts: ["DL"], note: "DT/DE" },
    { id: "DL2", label: "DL",        side: "D", accepts: ["DL"], note: "DT/DE" },
    { id: "LB1", label: "LB",        side: "D", accepts: ["LB"] },
    { id: "LB2", label: "LB",        side: "D", accepts: ["LB"] },
    { id: "DB1", label: "DB",        side: "D", accepts: ["DB"], note: "CB/S" },
    { id: "DB2", label: "DB",        side: "D", accepts: ["DB"], note: "CB/S" },
    { id: "DF1", label: "Flex",      side: "D", accepts: ["DL", "LB", "DB"],       flex: true, note: "DL/LB/DB" }
  ];

  var TOTAL_STARTERS = 18;
  var OFFENSE_STARTERS = 11;
  var DEFENSE_STARTERS = 7;

  // Raw MFL/nflverse position -> canonical lineup group. Required companion:
  // the slot model keys off these groups, NOT off raw MFL position codes.
  function posGroup(pos) {
    var p = safeStr(pos).toUpperCase();
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

  function slotAccepts(slot, group) {
    return !!slot && slot.accepts.indexOf(group) !== -1;
  }

  function lineupEligibleRow(r) {
    if (!r) return false;
    if (r.isTaxi || r.isIr || r.isExpired) return false;
    return posGroup(r.pos) !== "OTH";
  }

  // Greedy seed — fill the FIXED slots first (best by `scoreFn`), then the
  // flex slots from the best remaining eligible player. Fixed-first matters:
  // otherwise a flex slot grabs the only TE before the TE slot can claim it.
  // Returns { slotId: pid }.
  function autoFillSlots(rows, scoreFn) {
    var score = (typeof scoreFn === "function") ? scoreFn : function (r) { return r.salary || 0; };
    var byGroup = {};
    rows.forEach(function (r) {
      if (!lineupEligibleRow(r)) return;
      var g = posGroup(r.pos);
      (byGroup[g] = byGroup[g] || []).push(r);
    });
    Object.keys(byGroup).forEach(function (g) {
      byGroup[g].sort(function (a, b) { return score(b) - score(a); });
    });
    var used = {}, draft = {};
    function take(accepts) {
      var best = null;
      accepts.forEach(function (g) {
        (byGroup[g] || []).forEach(function (r) {
          if (!used[r.id] && (!best || score(r) > score(best))) best = r;
        });
      });
      if (best) { used[best.id] = 1; return best.id; }
      return "";
    }
    LINEUP_SLOTS.forEach(function (s) { if (!s.flex) draft[s.id] = take(s.accepts); });
    LINEUP_SLOTS.forEach(function (s) { if (s.flex) draft[s.id] = take(s.accepts); });
    return draft;
  }

  // Validate a slot draft ({ slotId: pid }).
  // `problems` = blocking issues. An INCOMPLETE lineup is not a problem —
  // MFL accepts a valid partial save (bye/injury weeks can leave a slot
  // unfillable), so the UI allows it and just says so.
  function validateSlots(draft, rowsByPid) {
    draft = draft || {};
    rowsByPid = rowsByPid || {};
    var filled = 0, dupes = 0, ineligible = 0, mismatch = 0, seen = {};
    var bySide = { O: 0, D: 0 };
    var emptySlots = [];
    LINEUP_SLOTS.forEach(function (s) {
      var pid = draft[s.id];
      if (!pid) { emptySlots.push(s); return; }
      filled += 1;
      bySide[s.side] += 1;
      if (seen[pid]) dupes += 1; else seen[pid] = 1;
      var r = rowsByPid[pid];
      if (!r || r.isTaxi || r.isIr || r.isExpired) { ineligible += 1; return; }
      if (!slotAccepts(s, posGroup(r.pos))) mismatch += 1;
    });
    var errors = [];
    if (filled < TOTAL_STARTERS) {
      var need = TOTAL_STARTERS - filled;
      errors.push("Fill " + plural(need, "more slot"));
    }
    if (dupes) errors.push(plural(dupes, "player") + " used in two slots");
    if (ineligible) errors.push(ineligible + " ineligible (taxi/IR/expired) selected");
    if (mismatch) errors.push(plural(mismatch, "player") + " in the wrong slot");
    var problems = dupes + ineligible + mismatch;
    return {
      ok: problems === 0 && filled === TOTAL_STARTERS,
      complete: filled === TOTAL_STARTERS,
      problems: problems,
      filled: filled,
      total: TOTAL_STARTERS,
      bySide: bySide,
      emptySlots: emptySlots,
      errors: errors
    };
  }

  // Roster rows in the shape the slot model expects.
  function buildLineupRows() {
    var salaryMap = {};
    getMySalaries().forEach(function (s) { salaryMap[s.id] = s; });
    return getMyRoster().map(function (r) {
      var p = playerById(r.id) || {};
      var sal = salaryMap[r.id] || r;
      var cy = parseInt(sal.contractYear, 10);
      var inj = getInjuryFor(r.id);
      var pos = safeStr(p.position).toUpperCase();
      return {
        id: String(r.id),
        pos: pos,
        group: posGroup(pos),
        name: prettyPlayerName(p.name) || ("Player #" + r.id),
        short: shortName(p.name) || ("#" + r.id),
        team: safeStr(p.team),
        salary: Number(sal.salary || 0),
        contract: safeStr(sal.contractStatus || sal.contractInfo),
        contractYear: isFinite(cy) ? cy : null,
        status: safeStr(r.status),
        isTaxi: /taxi/i.test(safeStr(r.status)),
        isIr: /ir|injured/i.test(safeStr(r.status)),
        isExpired: cy === 0,
        injStatus: inj ? safeStr(inj.status) : ""
      };
    });
  }

  // Everything Zone 3 (and the attention queue) needs about the lineup.
  // The draft is seeded ONCE per page load by autoFillSlots so the owner
  // opens on a legal-as-possible baseline instead of an empty board.
  function lineupState() {
    var rows = buildLineupRows();
    var byPid = {};
    rows.forEach(function (r) { byPid[r.id] = r; });
    if (!state.lineupDraft) state.lineupDraft = autoFillSlots(rows, null);
    return {
      rows: rows,
      byPid: byPid,
      draft: state.lineupDraft,
      validation: validateSlots(state.lineupDraft, byPid)
    };
  }

  // ---------- Season phase / schedule ----------

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
    return String(ev).replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }
  function fmtEventDate(iso) {
    if (!iso) return "TBD";
    var m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return iso;
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  }

  function upcomingEvents() {
    var src = (state.leagueEvents && state.leagueEvents.ok && Array.isArray(state.leagueEvents.events))
      ? state.leagueEvents.events : [];
    return src.map(function (ev) {
      return {
        event: safeStr(ev.event),
        date: safeStr(ev.date),
        label: eventLabel(ev.event),
        days: daysUntil(ev.date)
      };
    }).filter(function (e) { return !!e.date; });
  }
  function findEvent(tokens) {
    var list = upcomingEvents();
    for (var i = 0; i < list.length; i++) {
      if (tokens.indexOf(list[i].event) !== -1) return list[i];
    }
    return null;
  }

  // "in" = NFL regular season underway, "pre" = offseason / preseason.
  // MFL exposes no reliable current-week field on any export we already
  // fetch, so derive it from the calendar: while /api/league-events still
  // lists an UPCOMING nfl_kickoff we are before the season; once kickoff
  // drops off the upcoming list, fall back to the NFL calendar window.
  function seasonPhase() {
    if (findEvent(["nfl_kickoff"])) return "pre";
    var now = new Date();
    var m = now.getMonth();
    if (m >= 8) return "in";                          // Sep–Dec
    if (m === 0 && now.getDate() <= 15) return "in";  // through the UPS final
    return "pre";
  }

  // First week with no scores posted = the week currently being played /
  // set. Falls back to the last scheduled week.
  function currentWeek() {
    var weeks = asArray(state.schedule && state.schedule.schedule && state.schedule.schedule.weeklySchedule);
    for (var i = 0; i < weeks.length; i++) {
      var scored = false;
      asArray(weeks[i].matchup).forEach(function (m) {
        asArray(m.franchise).forEach(function (f) {
          if (Number(f.score || 0) > 0) scored = true;
        });
      });
      if (!scored) return safeStr(weeks[i].week);
    }
    return weeks.length ? safeStr(weeks[weeks.length - 1].week) : "";
  }

  // UPS pod format: each franchise plays 2 (Divisional) or 3 (Intra-pod)
  // matchups per week, so this returns a LIST of opponents.
  function opponentsForWeek(week) {
    var weeks = asArray(state.schedule && state.schedule.schedule && state.schedule.schedule.weeklySchedule);
    var out = [];
    weeks.forEach(function (w) {
      if (safeStr(w.week) !== safeStr(week)) return;
      asArray(w.matchup).forEach(function (m) {
        var ids = asArray(m.franchise).map(function (f) { return pad4(f.id); });
        if (ids.indexOf(state.viewerFranchiseId) === -1) return;
        ids.forEach(function (id) {
          if (id !== state.viewerFranchiseId) out.push(franchiseDisplayName(id));
        });
      });
    });
    return out;
  }

  function myStandings() {
    var root = state.leagueStandings && state.leagueStandings.leagueStandings;
    if (!root) return null;
    var list = asArray(root.franchise);
    if (!list.length) return null;
    for (var i = 0; i < list.length; i++) {
      if (pad4(list[i].id) !== state.viewerFranchiseId) continue;
      var f = list[i];
      return {
        place: i + 1,
        of: list.length,
        w: Number(f.h2hw || 0), l: Number(f.h2hl || 0), t: Number(f.h2ht || 0),
        pf: Number(f.pf || 0),
        allW: Number(f.all_play_w || 0),
        allL: Number(f.all_play_l || 0),
        allT: Number(f.all_play_t || 0)
      };
    }
    return null;
  }

  function ordinal(n) {
    var v = Number(n || 0);
    var s = ["th", "st", "nd", "rd"];
    var m = v % 100;
    return v + (s[(m - 20) % 10] || s[m] || s[0]);
  }
  function recordLabel(w, l, t) {
    return t ? (w + "-" + l + "-" + t) : (w + "-" + l);
  }

  // ---------- Roster size rule (UPS canon) ----------
  //
  // MFL's league export carries no usable roster cap for us — rosterSize:"50"
  // is offseason trading headroom, NOT the real rule — so state.rosterLimit
  // came back 0 and every consumer fell back to a hardcoded 26, flagging legal
  // rosters as "over the limit". The authoritative UPS rule (Keith): a roster
  // holds a MIN of 27 and a MAX of 35 through the Sep 6 Contract Deadline, then
  // a MAX of 30 after it. Under the min you ADD; over the max you CUT.
  function rosterCaps() {
    var MIN = 27;
    // The Contract Deadline (canonically Sep 6) drops the ceiling 35 → 30.
    // Prefer the league calendar's own deadline; fall back to the fixed Sep 6
    // boundary (month index 8 = September) when it isn't published.
    var dl = findEvent(["ups_contract_deadline"]);
    var afterDeadline;
    if (dl && dl.days != null) {
      afterDeadline = dl.days < 0;
    } else {
      var now = new Date();
      afterDeadline = (now.getMonth() > 8) || (now.getMonth() === 8 && now.getDate() >= 6);
    }
    return { min: MIN, max: afterDeadline ? 30 : 35 };
  }

  // ---------- Zone 1: the attention queue ----------
  //
  // Rows are only produced when something is ACTUALLY actionable. If the list
  // comes back empty the whole zone is omitted from the page — an empty gold
  // box that says "nothing to do" is just noise.
  function buildAttentionRows() {
    var rows = [];
    var phase = seasonPhase();
    var cap = capSummary();
    var ls = lineupState();
    var caps = rosterCaps();

    // 1 — FA / Expired-Rookie auction. The auction hub had no link anywhere
    //     on this page before the redesign; during auction season it is the
    //     single most time-critical thing an owner can be doing.
    var auction = findEvent(["ups_fa_auction_start", "ups_expired_rookie_auction_start"]);
    if (auction && auction.days != null && auction.days <= 45) {
      rows.push({
        tone: auction.days <= 7 ? "bad" : "warn",
        title: auction.label + (auction.days <= 0 ? " is open" : " opens " + whenLabel(auction.days)),
        sub: fmtEventDate(auction.date) + " · " + fmtUsd(cap.remain) + " of cap room to bid with",
        when: whenLabel(auction.days),
        whenSub: fmtEventDate(auction.date),
        cta: "Auction Hub",
        href: mflModuleUrl("MESSAGE19&hub=auction-hub"),
        primary: true
      });
    }

    // 2 — Over the cap. Hard-blocking; MFL will reject roster moves.
    if (cap.cap > 0 && cap.remain < 0) {
      rows.push({
        tone: "bad",
        title: "You are " + fmtUsd(Math.abs(cap.remain)) + " over the cap",
        sub: fmtUsd(cap.total) + " committed against a " + fmtUsd(cap.cap) + " cap",
        cta: "Front Office",
        href: mflModuleUrl("MESSAGE7")
      });
    }

    // 3 — Roster size outside the legal window (min 27, max 35 pre-deadline /
    //     30 after). OVER the max is a real cut alarm. UNDER the min means ADD,
    //     not cut — the old hardcoded 26 told a 22-man roster to "cut 4".
    if (cap.rosterCount > caps.max) {
      var over = cap.rosterCount - caps.max;
      rows.push({
        tone: "warn",
        title: "Cut " + plural(over, "player") + " to reach the " + caps.max + " max",
        sub: cap.expiredCount
          ? plural(cap.expiredCount, "expired contract") +
            (cap.expiredCount === 1 ? " charges" : " charge") + " $0 but still hold roster spots"
          : plural(cap.rosterCount, "player") + " on roster",
        cta: "Manage roster",
        href: mflModuleUrl("MESSAGE7")
      });
    } else if (cap.rosterCount < caps.min) {
      var under = caps.min - cap.rosterCount;
      rows.push({
        tone: "warn",
        title: "Add " + plural(under, "player") + " to reach the " + caps.min + " minimum",
        sub: cap.rosterCount + " on roster · league minimum is " + caps.min,
        cta: "Add players",
        href: mflModuleUrl("MESSAGE7")
      });
    }

    // 4 — Can't field a legal 18. Same computation in both phases; only the
    //     framing and the destination change (no lineup CTA in the offseason).
    if (!ls.validation.complete) {
      var short = TOTAL_STARTERS - ls.validation.filled;
      var gaps = ls.validation.emptySlots.map(function (s) { return s.label + (s.note ? " (" + s.note + ")" : ""); });
      if (phase === "in") {
        rows.push({
          tone: "bad",
          title: "Lineup is " + short + " short — " + ls.validation.filled + " of " + TOTAL_STARTERS + " fillable",
          sub: "Unfilled: " + gaps.join(" · ") + " · empty slots score 0",
          cta: "Finish lineup",
          action: "focusLineup",
          primary: true
        });
      } else {
        rows.push({
          tone: "warn",
          title: "Roster can't field a legal 18 yet",
          sub: "Short at " + gaps.join(" · ") + " — auction targets",
          cta: "Auction Hub",
          href: mflModuleUrl("MESSAGE19&hub=auction-hub")
        });
      }
    }

    // 5 — Incoming trade offers (only INCOMING is actionable; offers you sent
    //     are waiting on somebody else).
    var pending = asArray(state.pendingTrades && state.pendingTrades.pendingTrades && state.pendingTrades.pendingTrades.pendingTrade);
    var incoming = pending.filter(function (t) { return pad4(t.offeredTo) === state.viewerFranchiseId; });
    if (incoming.length) {
      rows.push({
        tone: "warn",
        title: incoming.length === 1
          ? "Trade offer from " + franchiseDisplayName(incoming[0].offeringFranchise)
          : incoming.length + " trade offers waiting on you",
        sub: incoming.map(function (t) { return franchiseDisplayName(t.offeringFranchise); }).join(" · "),
        cta: "Review offers",
        href: mflModuleUrl("MESSAGE6=N")
      });
    }

    // 6 — Injured players inside the projected starting 18 (in-season only —
    //     an offseason injury designation isn't something you act on today).
    if (phase === "in") {
      var hurt = [];
      LINEUP_SLOTS.forEach(function (s) {
        var r = ls.byPid[ls.draft[s.id]];
        if (r && r.injStatus) hurt.push(r);
      });
      if (hurt.length) {
        rows.push({
          tone: "warn",
          title: plural(hurt.length, "starter") + " carrying an injury designation",
          sub: hurt.map(function (r) { return r.short + " (" + r.injStatus + ")"; }).join(" · "),
          cta: "Finish lineup",
          action: "focusLineup"
        });
      }
    }

    // 7 — Any other deadline inside a week that we haven't already surfaced.
    upcomingEvents().forEach(function (ev) {
      if (ev.days == null || ev.days > 7) return;
      if (auction && ev.event === auction.event) return;
      rows.push({
        tone: ev.days <= 2 ? "bad" : "ok",
        title: ev.label,
        sub: fmtEventDate(ev.date),
        when: whenLabel(ev.days),
        whenSub: fmtEventDate(ev.date),
        cta: "Front Office",
        href: mflModuleUrl("MESSAGE7")
      });
    });

    return rows;
  }

  function attentionHtml() {
    var rows = buildAttentionRows();
    if (!rows.length) return "";
    var items = rows.map(function (r) {
      var whenHtml = r.when
        ? '<div class="tops-attn-when num">' + escapeHtml(r.when) +
          (r.whenSub ? '<span>' + escapeHtml(r.whenSub) + '</span>' : '') + '</div>'
        : '';
      var ctaCls = "tops-cta" + (r.primary ? "" : " tops-cta--ghost");
      var cta = r.href
        ? '<a class="' + ctaCls + '" href="' + escapeHtml(r.href) + '" target="_top">' + escapeHtml(r.cta) + '</a>'
        : '<button type="button" class="' + ctaCls + '" data-attn-action="' + escapeHtml(r.action || "") + '">' + escapeHtml(r.cta) + '</button>';
      return '<li>'
        + '<span class="tops-dot tops-dot--' + escapeHtml(r.tone) + '"></span>'
        + '<div class="tops-attn-txt">'
        +   '<div class="tops-attn-t">' + escapeHtml(r.title) + '</div>'
        +   '<div class="tops-attn-s">' + escapeHtml(r.sub) + '</div>'
        + '</div>'
        + whenHtml
        + cta
        + '</li>';
    }).join("");
    return '<section class="tops-attn" id="topsZone1" aria-label="Needs you">'
      + '<div class="tops-attn-h">Needs you <span class="tops-attn-cnt">· ' + rows.length + ' open</span></div>'
      + '<ul>' + items + '</ul>'
      + '</section>';
  }

  // ---------- Zone 2: team-state strip ----------

  function stripHtml() {
    var phase = seasonPhase();
    var cap = capSummary();
    var caps = rosterCaps();
    var ls = lineupState();
    var st = myStandings();
    var rank = capRoomRank();

    function tile(k, v, note, noteFlag, bar) {
      return '<div>'
        + '<div class="tops-st-k">' + escapeHtml(k) + '</div>'
        + '<div class="tops-st-v num">' + escapeHtml(v) + '</div>'
        + (note ? '<div class="tops-st-n' + (noteFlag ? ' is-flag' : '') + '">' + note + '</div>' : '')
        + (bar || '')
        + '</div>';
    }

    var capBar = '<div class="tops-st-bar"><i class="' + (cap.pct >= 90 ? 'is-hot' : '') +
      '" style="width:' + Math.max(0, Math.min(100, cap.pct)) + '%"></i></div>';
    var capTile = tile("Cap room", fmtUsd(cap.remain),
      escapeHtml(fmtUsd(cap.total) + " of " + fmtUsd(cap.cap) + " used"),
      cap.remain < 0, capBar);

    var rosterNote;
    if (phase === "in") {
      rosterNote = escapeHtml(cap.activeCount + " active · " + cap.taxiCount + " taxi · " + cap.irCount + " IR");
    } else if (cap.rosterCount > caps.max) {
      rosterNote = escapeHtml((cap.rosterCount - caps.max) + " over the " + caps.max + " max");
    } else if (cap.rosterCount < caps.min) {
      rosterNote = escapeHtml((caps.min - cap.rosterCount) + " under the " + caps.min + " min");
    } else {
      var openToMax = caps.max - cap.rosterCount;
      rosterNote = escapeHtml(openToMax + " spot" + (openToMax === 1 ? "" : "s") + " to the " + caps.max + " max");
    }
    var rosterOff = cap.rosterCount > caps.max || cap.rosterCount < caps.min;
    var rosterTile = tile("Roster", String(cap.rosterCount), rosterNote, rosterOff);

    var tiles;
    if (phase === "in") {
      var week = currentWeek();
      var opps = opponentsForWeek(week);
      tiles = [
        st ? tile("Record", recordLabel(st.w, st.l, st.t),
                  escapeHtml(ordinal(st.place) + " of " + st.of))
           : tile("Record", "—", "standings unavailable"),
        capTile,
        rosterTile,
        tile("Week " + (week || "—"), String(opps.length || "—"),
             opps.length ? escapeHtml(opps.join(" · ")) : "schedule not published"),
        st ? tile("All-play", recordLabel(st.allW, st.allL, st.allT),
                  escapeHtml(Math.round(st.pf).toLocaleString() + " points for"))
           : tile("All-play", "—", "standings unavailable")
      ];
    } else {
      var picks = myFuturePicks();
      var pickNote = picks.length
        ? escapeHtml(picks.slice(0, 5).map(function (p) { return p.year + " R" + p.round; }).join(", "))
        : "none on the books";
      tiles = [
        capTile,
        tile("Committed", fmtUsd(cap.total),
             escapeHtml(fmtUsd(cap.salary) + " salary" + (cap.adj ? " · " + fmtUsd(cap.adj) + " adj" : ""))),
        rosterTile,
        tile("Auction room", fmtUsd(cap.remain),
             rank ? escapeHtml(ordinal(rank.rank) + " of " + rank.of + " in room") : "league room unavailable"),
        tile("Lineup-ready", ls.validation.filled + " / " + TOTAL_STARTERS,
             ls.validation.complete ? "can field a legal 18" : "short of a legal 18",
             !ls.validation.complete)
      ];
    }

    return '<section class="tops-strip" aria-label="Team state">' + tiles.join("") + '</section>';
  }

  function myFuturePicks() {
    var picks = asArray(state.futureDraftPicks && state.futureDraftPicks.futureDraftPicks && state.futureDraftPicks.futureDraftPicks.franchise);
    var mine = picks.find(function (p) { return pad4(p.id) === state.viewerFranchiseId; });
    return mine ? asArray(mine.futureDraftPick).map(function (p) {
      return { year: safeStr(p.year), round: safeStr(p.round), from: pad4(p.originalPickFor) };
    }) : [];
  }

  // ---------- Zone 3: lineup / roster shape ----------

  // The chip's second line. NFL team already rides along in the select label
  // (it's the disambiguator between same-surname players), so the meta line
  // carries the contract instead of repeating it.
  function slotMetaFor(row) {
    if (!row) return "";
    var bits = [];
    if (row.salary > 0) bits.push(fmtUsd(row.salary));
    if (row.contractYear === 0) bits.push("expired");
    else if (row.contractYear != null && row.contractYear > 0) bits.push("cy " + row.contractYear);
    if (!bits.length && row.contract) bits.push(row.contract);
    return bits.join(" · ");
  }

  function slotOptionsHtml(slot, ls) {
    var used = {};
    LINEUP_SLOTS.forEach(function (s) {
      var pid = ls.draft[s.id];
      if (pid && s.id !== slot.id) used[pid] = true;
    });
    var cur = ls.draft[slot.id] || "";
    var cands = ls.rows.filter(function (r) {
      if (!lineupEligibleRow(r)) return false;
      if (!slotAccepts(slot, r.group)) return false;
      return !used[r.id] || r.id === cur;
    }).sort(function (a, b) { return b.salary - a.salary; });
    var html = '<option value="">— empty —</option>';
    cands.forEach(function (r) {
      var lbl = r.short + (r.team ? " · " + r.team : "") + (r.injStatus ? " (" + r.injStatus + ")" : "");
      html += '<option value="' + escapeHtml(r.id) + '"' + (r.id === cur ? ' selected' : '') + '>' + escapeHtml(lbl) + '</option>';
    });
    return html;
  }

  function bankHtml(side, ls, phase) {
    var slots = LINEUP_SLOTS.filter(function (s) { return s.side === side; });
    var target = side === "O" ? OFFENSE_STARTERS : DEFENSE_STARTERS;
    var filled = 0;
    var chips = slots.map(function (s) {
      var pid = ls.draft[s.id];
      var row = pid ? ls.byPid[pid] : null;
      if (row) filled += 1;
      var cls = "tops-slot"
        + (row ? "" : " is-empty")
        + (row && row.injStatus ? " has-inj" : "")
        + (phase === "in" ? "" : " is-proj");
      var key = '<div class="tops-slot-k">' + escapeHtml(s.label)
        + (s.note ? ' <span class="tops-slot-fx">' + escapeHtml(s.note) + '</span>' : '')
        + '</div>';
      var body;
      if (phase === "in") {
        body = '<select class="tops-slot-sel" data-slot="' + escapeHtml(s.id) + '" aria-label="' + escapeHtml(s.label) + ' starter">'
          + slotOptionsHtml(s, ls) + '</select>';
      } else {
        body = '<div class="tops-slot-n">' + escapeHtml(row ? row.short : "No " + s.label) + '</div>';
      }
      var meta = row
        ? slotMetaFor(row)
        : (phase === "in" ? "nobody eligible on the bench" : "roster gap");
      return '<div class="' + cls + '" data-slot-chip="' + escapeHtml(s.id) + '">'
        + key + body
        + '<div class="tops-slot-m">' + escapeHtml(meta) + '</div>'
        + (row && row.injStatus ? '<span class="tops-slot-inj" title="Injury designation">' + escapeHtml(row.injStatus) + '</span>' : '')
        + '</div>';
    }).join("");

    // Bench depth: eligible players for this side who aren't in a slot.
    var inUse = {};
    LINEUP_SLOTS.forEach(function (s) { if (ls.draft[s.id]) inUse[ls.draft[s.id]] = true; });
    var sideGroups = {};
    slots.forEach(function (s) { s.accepts.forEach(function (g) { sideGroups[g] = true; }); });
    var bench = ls.rows.filter(function (r) {
      return lineupEligibleRow(r) && sideGroups[r.group] && !inUse[r.id];
    }).length;

    return '<div class="tops-bank">'
      + '<div class="tops-bank-h">' + (side === "O" ? "Offense" : "Defense")
      +   ' <em>' + filled + ' of ' + target + (bench ? ' · ' + bench + ' deep on the bench' : '') + '</em>'
      + '</div>'
      + '<div class="tops-slots">' + chips + '</div>'
      + '</div>';
  }

  function lineupZoneHtml() {
    var phase = seasonPhase();
    var ls = lineupState();
    var v = ls.validation;

    var pillCls = v.ok ? "tops-pill is-ok" : (v.problems ? "tops-pill is-bad" : "tops-pill is-warn");
    var pillTxt = phase === "in"
      ? (v.complete ? TOTAL_STARTERS + " / " + TOTAL_STARTERS + " set" : v.filled + " / " + TOTAL_STARTERS + " · not legal")
      : (v.complete ? TOTAL_STARTERS + " / " + TOTAL_STARTERS + " fillable" : v.filled + " / " + TOTAL_STARTERS + " fillable");

    var title, sub, headCta;
    if (phase === "in") {
      var wk = currentWeek();
      title = "Starting Lineup";
      sub = (wk ? "Week " + wk + " · " : "") + "seeded from your depth chart — review, then save to MFL";
      headCta = '<a class="tops-cta tops-cta--ghost" href="' + escapeHtml(mflModuleUrl("MESSAGE19&hub=gameday")) + '" target="_top">Game Day</a>';
    } else {
      title = "Roster shape vs the 18-slot lineup";
      sub = "projected Week 1 · lineups open at kickoff";
      headCta = '<a class="tops-cta tops-cta--ghost" href="' + escapeHtml(mflModuleUrl("MESSAGE7")) + '" target="_top">Front Office</a>';
    }

    var msgHtml = "";
    if (state.lineupMessage) {
      var kind = state.lineupMessage.kind === "ok" ? "is-ok" : (state.lineupMessage.kind === "err" ? "is-err" : "");
      msgHtml = '<div class="tops-lineup-msg ' + kind + '">' + escapeHtml(state.lineupMessage.text) + '</div>';
    }

    // D — no lineup submit affordance in the offseason. MFL will not accept a
    // lineup before the season opens, and offering the button implies it will.
    var foot;
    if (phase === "in") {
      foot = '<div class="tops-lineup-foot">'
        + '<span class="tops-note">MFL accepts a partial lineup — but <b>' +
            (v.complete ? "every slot is filled" : plural(TOTAL_STARTERS - v.filled, "empty slot") + " score 0") +
          '</b>. Taxi, IR and expired-contract players can\'t start.</span>'
        + '<button type="button" class="tops-cta tops-cta--ghost" id="topsLineupAuto">Auto-fill best available</button>'
        + '<button type="button" class="tops-cta" id="topsLineupSave"' + (state.lineupSubmitting ? ' disabled' : '') + '>'
        +   (state.lineupSubmitting ? "Saving…" : "Save lineup to MFL")
        + '</button>'
        + '</div>';
    } else {
      foot = '<div class="tops-lineup-foot">'
        + '<span class="tops-note">' + (v.complete
            ? 'Your roster can field a legal 18 today.'
            : 'You can\'t field a legal 18 today — <b>' + escapeHtml(v.emptySlots.map(function (s) { return s.label; }).join(", ")) + '</b> ' +
              (v.emptySlots.length === 1 ? 'has' : 'have') + ' nobody eligible.')
        + ' Lineups can\'t be submitted until the season opens.</span>'
        + '</div>';
    }

    return '<section class="tops-card" id="topsZone3" aria-label="' + escapeHtml(title) + '">'
      + '<div class="tops-card-h">'
      +   '<span class="tops-card-t">' + escapeHtml(title) + '</span>'
      +   '<span class="tops-card-sub">' + escapeHtml(sub) + '</span>'
      +   '<span class="tops-grow"></span>'
      +   '<span class="' + pillCls + ' num">' + escapeHtml(pillTxt) + '</span>'
      +   headCta
      + '</div>'
      + msgHtml
      + bankHtml("O", ls, phase)
      + bankHtml("D", ls, phase)
      + foot
      + '</section>';
  }

  function renderLineupZone() {
    var node = document.getElementById("topsZone3");
    if (!node || !node.parentNode) return;
    var holder = document.createElement("div");
    holder.innerHTML = lineupZoneHtml();
    var next = holder.firstChild;
    node.parentNode.replaceChild(next, node);
    wireLineupZone();
  }

  function wireLineupZone() {
    var zone = document.getElementById("topsZone3");
    if (!zone) return;
    zone.querySelectorAll(".tops-slot-sel").forEach(function (sel) {
      sel.addEventListener("change", function () {
        var slotId = sel.getAttribute("data-slot");
        var pid = sel.value;
        if (!state.lineupDraft) state.lineupDraft = {};
        if (pid) state.lineupDraft[slotId] = pid;
        else delete state.lineupDraft[slotId];
        state.lineupMessage = null;
        renderLineupZone();
        renderAttentionZone();
      });
    });
    var auto = document.getElementById("topsLineupAuto");
    if (auto) auto.addEventListener("click", function () {
      state.lineupDraft = autoFillSlots(buildLineupRows(), null);
      state.lineupMessage = null;
      renderLineupZone();
      renderAttentionZone();
    });
    var save = document.getElementById("topsLineupSave");
    if (save) save.addEventListener("click", function () {
      if (save.hasAttribute("disabled")) return;
      submitLineupDraft();
    });
  }

  // ---------- Zone 4: League Pulse + Calendar ----------

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
          return prettyPlayerName(p.name) + pos;
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

  var TXN_TAG = {
    TRADE:       { label: "Trade", cls: "" },
    THREE_WAY:   { label: "3 Way", cls: "" },
    BBID_WAIVER: { label: "Waiver", cls: "tops-tag--add" },
    FREE_AGENT:  { label: "FA", cls: "tops-tag--add" },
    AUCTION_DRAFT: { label: "Auction", cls: "tops-tag--add" },
    IR:          { label: "IR", cls: "" },
    TAXI:        { label: "Taxi", cls: "" }
  };

  // One League Pulse row. Returns "" for a transaction with nothing to show:
  // TAXI / IR / lock rows carry an EMPTY `transaction` string, which used to
  // render as a bare franchise name plus a dead tag. The caller skips "".
  function pulseRowHtml(t) {
    var typ = safeStr(t.type).toUpperCase();
    var tag = TXN_TAG[typ] || { label: typ.replace(/_/g, " "), cls: "" };
    var when = new Date(Number(t.timestamp || 0) * 1000);
    var dateStr = isNaN(when.getTime()) ? "" : when.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    var salaryHtml = t.salary
      ? ' <span class="tops-feed-who">· $' + escapeHtml(Number(t.salary).toLocaleString()) + '</span>'
      : '';
    var body;

    if (typ === "TRADE") {
      var a = franchiseDisplayName(t.franchise);
      var b = franchiseDisplayName(t.franchise2);
      var gave = decodeAssetTokens(t.franchise1_gave_up).slice(0, 3);
      var got = decodeAssetTokens(t.franchise2_gave_up).slice(0, 3);
      body = '<b>' + escapeHtml(a) + '</b> &harr; <b>' + escapeHtml(b) + '</b>'
        + (gave.length || got.length
            ? ' <span class="tops-feed-who">' + escapeHtml(gave.join(", ")) + ' for ' + escapeHtml(got.join(", ")) + '</span>'
            : '');
    } else if (typ === "FREE_AGENT" || typ === "BBID_WAIVER" || typ === "WAIVER") {
      // MFL's free-agent / waiver `transaction` string is `added|dropped`
      // (pipe-separated, each side a comma list of player ids). A pure DROP has
      // an empty added side — e.g. "|17049," — so the old `\d{3,}` match, which
      // ignored the pipe, rendered a drop identically to a signing under a green
      // "FA" tag. Split on the pipe and label the two sides distinctly.
      // (Auction strings are `pid|price|note`, NOT added|dropped, so they are
      // deliberately excluded here and stay on the neutral path below.)
      var sides = safeStr(t.transaction).split("|");
      var addedNames = decodeAssetTokens((String(sides[0] || "").match(/\d{3,}/g) || []).slice(0, 3).join(","));
      var droppedNames = decodeAssetTokens((String(sides[1] || "").match(/\d{3,}/g) || []).slice(0, 3).join(","));
      if (!addedNames.length && !droppedNames.length) return "";
      // A pure drop must not wear the green "add" tag.
      if (!addedNames.length && droppedNames.length) tag = { label: "Drop", cls: "tops-tag--drop" };
      var segs = [];
      if (addedNames.length) segs.push('<span class="tops-feed-add">+ ' + escapeHtml(addedNames.join(", ")) + '</span>');
      if (droppedNames.length) segs.push('<span class="tops-feed-drop">− ' + escapeHtml(droppedNames.join(", ")) + '</span>');
      body = '<b>' + escapeHtml(franchiseDisplayName(t.franchise)) + '</b> ' + segs.join(' ') + salaryHtml;
    } else {
      var who = franchiseDisplayName(t.franchise);
      var raw = safeStr(t.transaction);
      var pids = (raw.match(/\d{3,}/g) || []).slice(0, 3);
      var names = decodeAssetTokens(pids.join(","));
      // Empty TAXI / IR / lock rows have no player and no salary — a franchise
      // name with a lone tag is a dead row, so drop it entirely.
      if (!names.length && !t.salary) return "";
      body = '<b>' + escapeHtml(who) + '</b>'
        + (names.length ? ' <span class="tops-feed-who">' + escapeHtml(names.join(", ")) + '</span>' : '')
        + salaryHtml;
    }

    return '<li>'
      + '<span class="tops-feed-w">' + escapeHtml(dateStr) + '</span>'
      + '<span class="tops-feed-b">' + body + '</span>'
      + '<span class="tops-feed-tag ' + tag.cls + '">' + escapeHtml(tag.label) + '</span>'
      + '</li>';
  }

  // A commish-processed 3-way executes as 3 separate MFL TRADE legs (MFL is
  // 2-party only), each carrying a "[Commish-processed: 3-way] <uuid>" comment.
  // Return the shared uuid so the pulse can collapse the legs into one row.
  function threeWayUuid(t) {
    if (safeStr(t && t.type).toUpperCase() !== "TRADE") return "";
    var c = safeStr(t && t.comments);
    if (!/commish-processed/i.test(c) || !/3-way/i.test(c)) return "";
    var m = c.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return m ? m[0].toLowerCase() : "";
  }

  // One combined "3 Way" pulse row from all legs of a single 3-way: the three
  // participating franchises + the notable assets that moved, deduped.
  function threeWayRowHtml(legs) {
    if (!legs || !legs.length) return "";
    var when = new Date(Number(legs[0].timestamp || 0) * 1000);
    var dateStr = isNaN(when.getTime()) ? "" : when.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    var seenFid = {}, teams = [];
    legs.forEach(function (t) {
      [t.franchise, t.franchise2].forEach(function (f) {
        var p = pad4(f);
        if (p && !seenFid[p]) { seenFid[p] = 1; teams.push(franchiseDisplayName(p)); }
      });
    });
    var seenA = {}, notable = [];
    legs.forEach(function (t) {
      decodeAssetTokens(t.franchise1_gave_up).concat(decodeAssetTokens(t.franchise2_gave_up)).forEach(function (a) {
        if (!a || /\bBB\b|\$/.test(a)) return;          // skip cap ($..BB) tokens for brevity
        if (seenA[a]) return; seenA[a] = 1; notable.push(a);
      });
    });
    var body = '<b>' + teams.map(escapeHtml).join(" &harr; ") + '</b>'
      + (notable.length ? ' <span class="tops-feed-who">' + escapeHtml(notable.slice(0, 4).join(", ")) + '</span>' : '');
    return '<li>'
      + '<span class="tops-feed-w">' + escapeHtml(dateStr) + '</span>'
      + '<span class="tops-feed-b">' + body + '</span>'
      + '<span class="tops-feed-tag ' + TXN_TAG.THREE_WAY.cls + '">' + escapeHtml(TXN_TAG.THREE_WAY.label) + '</span>'
      + '</li>';
  }

  function pulseHtml() {
    var txns = asArray(state.transactions && state.transactions.transactions && state.transactions.transactions.transaction);
    // League-wide, newest first — the hub's job is "what happened in the
    // league", not "what did I do" (my own moves are in Front Office). Fill up
    // to 8 rows AFTER dropping contentless ones, so skipped taxi/IR rows don't
    // eat a visible slot. A commish-processed 3-way's 3 legs collapse into ONE
    // "3 Way" row (rendered at the newest leg's slot; the other legs skipped).
    var sorted = txns.slice().sort(function (a, b) {
      return Number(b.timestamp || 0) - Number(a.timestamp || 0);
    });
    var rows = [], handledUuid = {};
    for (var i = 0; i < sorted.length && rows.length < 8; i++) {
      var uuid = threeWayUuid(sorted[i]);
      if (uuid) {
        if (handledUuid[uuid]) continue;               // a leg of an already-rendered 3-way
        handledUuid[uuid] = 1;
        var legs = sorted.filter(function (x) { return threeWayUuid(x) === uuid; });
        var rh = threeWayRowHtml(legs);
        if (rh) rows.push(rh);
        continue;
      }
      var rowHtml = pulseRowHtml(sorted[i]);
      if (rowHtml) rows.push(rowHtml);
    }

    var listHtml = rows.length
      ? '<ul class="tops-feed">' + rows.join("") + '</ul>'
      : '<div class="tops-empty">No league transactions in the last 14 days.</div>';

    return '<section class="tops-card">'
      + '<div class="tops-card-h">'
      +   '<span class="tops-card-t">League Pulse</span>'
      +   '<span class="tops-card-sub">last 14 days · all franchises</span>'
      +   '<span class="tops-grow"></span>'
      +   '<a class="tops-card-link" href="' + escapeHtml(mflPageUrl("/options?O=03")) + '" target="_top">All transactions &rsaquo;</a>'
      + '</div>'
      + listHtml
      + '</section>';
  }

  function calendarHtml() {
    var events = upcomingEvents();
    var listHtml;
    if (!events.length) {
      listHtml = '<div class="tops-empty">No upcoming events on the UPS calendar.</div>';
    } else {
      listHtml = '<ul class="tops-cal">' + events.slice(0, 7).map(function (ev, i) {
        return '<li' + (i === 0 ? ' class="is-next"' : '') + '>'
          + '<span class="tops-cal-d">' + escapeHtml(fmtEventDate(ev.date)) + '</span>'
          + '<span class="tops-cal-l"><b>' + escapeHtml(ev.label) + '</b></span>'
          + '<span class="tops-cal-in num">' + escapeHtml(ev.days == null ? "" : (ev.days <= 0 ? "today" : ev.days + " d")) + '</span>'
          + '</li>';
      }).join("") + '</ul>';
    }
    return '<section class="tops-card">'
      + '<div class="tops-card-h">'
      +   '<span class="tops-card-t">Calendar</span>'
      +   '<span class="tops-grow"></span>'
      +   '<span class="tops-pill is-mute">next ' + Math.min(events.length, 7) + '</span>'
      + '</div>'
      + listHtml
      + '</section>';
  }

  // ---------- Zone 5: demoted nav ----------

  function navHtml() {
    var pending = asArray(state.pendingTrades && state.pendingTrades.pendingTrades && state.pendingTrades.pendingTrades.pendingTrade)
      .filter(function (t) { return pad4(t.offeredTo) === state.viewerFranchiseId; }).length;

    var roster = getMyRoster();
    var rosterIds = {};
    roster.forEach(function (r) { rosterIds[String(r.id)] = true; });
    var injCount = asArray(state.injuries && state.injuries.injuries && state.injuries.injuries.injury)
      .filter(function (i) { return rosterIds[String(i.id)]; }).length;

    // On The Block is the VIEWER's own shopping list, so the badge counts only
    // the viewer's players on the block — not every franchise's tradeBait entry
    // (which counted up to 12 and made the badge meaningless). MFL returns one
    // tradeBait entry per franchise with a comma-separated `willGiveUp` pid
    // list, so scope to the viewer's franchise and count its listed players.
    var baitCount = asArray(state.tradeBait && state.tradeBait.tradeBaits && state.tradeBait.tradeBaits.tradeBait)
      .filter(function (b) { return pad4(b.franchise_id) === state.viewerFranchiseId; })
      .reduce(function (n, b) {
        return n + (String(b.willGiveUp || "").match(/\d{3,}/g) || []).length;
      }, 0);

    // C — the Auction Hub had no link on this page at all before the
    // redesign. It gets a permanent nav pill, plus a countdown badge (and an
    // attention row above) whenever an auction is on the calendar.
    var auction = findEvent(["ups_fa_auction_start", "ups_expired_rookie_auction_start"]);
    var auctionBadge = (auction && auction.days != null && auction.days <= 45)
      ? (auction.days <= 0 ? "OPEN" : auction.days + "d")
      : "";

    var links = [
      { label: "Front Office", href: mflModuleUrl("MESSAGE7") },
      { label: "Trade War Room", href: mflModuleUrl("MESSAGE6=N"), badge: pending ? String(pending) : "", warn: true },
      { label: "Auction Hub", href: mflModuleUrl("MESSAGE19&hub=auction-hub"), badge: auctionBadge, warn: true },
      { label: "Game Day", href: mflModuleUrl("MESSAGE19&hub=gameday") },
      { label: "Stats", href: mflModuleUrl("MESSAGE13") },
      { label: "Standings", href: mflModuleUrl("MESSAGE4") },
      { label: "Rookie Draft Hub", href: mflModuleUrl("MESSAGE12") },
      { label: "Add / Drop", href: mflPageUrl("/add_drop") }
    ];

    var linkHtml = links.map(function (l) {
      return '<a href="' + escapeHtml(l.href) + '" target="_top">' + escapeHtml(l.label)
        + (l.badge ? '<span class="tops-badge' + (l.warn ? ' is-warn' : '') + '">' + escapeHtml(l.badge) + '</span>' : '')
        + '</a>';
    }).join("");

    // Two in-hub disclosure panels. These keep the authoring / search
    // surfaces reachable without putting them above the fold.
    var panelHtml = ''
      + '<button type="button" class="tops-nav-toggle" data-panel="news" aria-expanded="false">Player News'
      +   (injCount ? '<span class="tops-badge is-warn">' + injCount + '</span>' : '')
      + '</button>'
      + '<button type="button" class="tops-nav-toggle" data-panel="bait" aria-expanded="false">On The Block'
      +   (baitCount ? '<span class="tops-badge">' + baitCount + '</span>' : '')
      + '</button>';

    return '<nav class="tops-nav" aria-label="Everything else">' + linkHtml + panelHtml + '</nav>'
      + '<section class="tops-panel" id="topsNewsPanel" hidden><div data-card="allPlayerNews"></div></section>'
      + '<section class="tops-panel" id="topsBaitPanel" hidden><div id="topsBaitBody"></div></section>';
  }

  // ---------- Shell ----------

  function identityHtml() {
    var f = state.viewerFranchise || {};
    var st = myStandings();
    var phase = seasonPhase();
    var mark = f.icon
      ? '<img class="tops-idmark tops-idmark--img" src="' + escapeHtml(f.icon) + '" alt="">'
      : '<div class="tops-idmark">' + escapeHtml(monogram(f.name)) + '</div>';

    var metaTop, metaSub;
    if (phase === "in") {
      var wk = currentWeek();
      metaTop = state.ctx.year + (st ? " · " + recordLabel(st.w, st.l, st.t) + " · " + ordinal(st.place) : "");
      var opps = opponentsForWeek(wk);
      metaSub = (wk ? "Week " + wk : "In season") + (opps.length ? " · " + opps.length + "-game pod week" : "");
    } else {
      var next = upcomingEvents()[0];
      metaTop = state.ctx.year + " offseason";
      metaSub = next ? ("Next: " + next.label + " " + whenLabel(next.days)) : "No deadlines on the calendar";
    }

    return '<header class="tops-idbar">'
      + mark
      + '<div>'
      +   '<div class="tops-idname">' + escapeHtml(f.name || "My Team") + '</div>'
      +   '<div class="tops-idsub">' + escapeHtml([f.owner, "Franchise " + state.viewerFranchiseId].filter(Boolean).join(" · ")) + '</div>'
      + '</div>'
      + '<div class="tops-idspacer"></div>'
      + '<div class="tops-idmeta"><b>' + escapeHtml(metaTop) + '</b><br>' + escapeHtml(metaSub) + '</div>'
      + '</header>';
  }

  function footerHtml() {
    return '<div class="tops-foot">'
      + '<span>Build ' + escapeHtml(BUILD) + '</span>'
      + '<span>' + (state.lastLoaded ? 'Refreshed ' + escapeHtml(state.lastLoaded.toLocaleTimeString()) : 'Loading…') + '</span>'
      + '<span>MFL L=' + escapeHtml(state.ctx.leagueId) + ' · franchise ' + escapeHtml(state.viewerFranchiseId) + '</span>'
      + (state.loadErrors.length ? '<span class="is-err">' + state.loadErrors.length + ' endpoint issue(s)</span>' : '')
      + '</div>';
  }

  function renderHub() {
    var mount = document.getElementById("teamOpsMount");
    if (!mount) return;
    mount.innerHTML = '<div class="tops-shell">'
      + identityHtml()
      + '<div id="topsZone1Mount">' + attentionHtml() + '</div>'
      + stripHtml()
      + lineupZoneHtml()
      + '<div class="tops-two">' + pulseHtml() + calendarHtml() + '</div>'
      + navHtml()
      + footerHtml()
      + '</div>';

    els.mount = mount;
    els.cards = {};
    mount.querySelectorAll("[data-card]").forEach(function (node) {
      els.cards[node.getAttribute("data-card")] = node;
    });

    wireLineupZone();
    wireAttentionZone();
    wireNav();
  }

  function renderAttentionZone() {
    var holder = document.getElementById("topsZone1Mount");
    if (!holder) return;
    holder.innerHTML = attentionHtml();
    wireAttentionZone();
  }

  function wireAttentionZone() {
    var zone = document.getElementById("topsZone1");
    if (!zone) return;
    zone.querySelectorAll("[data-attn-action]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (btn.getAttribute("data-attn-action") !== "focusLineup") return;
        var ls = lineupState();
        var firstEmpty = null;
        for (var i = 0; i < LINEUP_SLOTS.length; i++) {
          if (!ls.draft[LINEUP_SLOTS[i].id]) { firstEmpty = LINEUP_SLOTS[i].id; break; }
        }
        var target = firstEmpty
          ? document.querySelector('.tops-slot-sel[data-slot="' + firstEmpty + '"]')
          : document.getElementById("topsZone3");
        if (!target) return;
        // The hub renders in a height-synced, cross-origin iframe, so a
        // programmatic scroll of the PARENT document isn't available to us.
        // focus() is the reliable in-frame affordance; scrollIntoView is a
        // best-effort extra that silently no-ops when the frame can't scroll.
        try { target.scrollIntoView({ block: "center" }); } catch (e) {}
        if (target.focus) target.focus();
      });
    });
  }

  function wireNav() {
    var mount = els.mount;
    if (!mount) return;
    mount.querySelectorAll(".tops-nav-toggle").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var which = btn.getAttribute("data-panel");
        var next = (state.openPanel === which) ? "" : which;
        state.openPanel = next;
        mount.querySelectorAll(".tops-nav-toggle").forEach(function (b) {
          b.setAttribute("aria-expanded", b.getAttribute("data-panel") === next ? "true" : "false");
        });
        var newsPanel = document.getElementById("topsNewsPanel");
        var baitPanel = document.getElementById("topsBaitPanel");
        if (newsPanel) newsPanel.hidden = (next !== "news");
        if (baitPanel) baitPanel.hidden = (next !== "bait");
        // Lazy first render — a collapsed panel never costs a worker call.
        if (next === "news") renderAllPlayerNews();
        if (next === "bait") renderTradeBaitPanel();
      });
    });
  }

  // ---------- Worker writes ----------

  // Extract the most specific MFL error message we can from a worker
  // response. Order of preference:
  //   1. resp.body.error                                   (worker's structured error)
  //   2. resp.body.mfl_response.error.$t                   (MFL wrapped JSON error)
  //   3. resp.body.mfl_response.error                      (MFL plain-string error)
  //   4. resp.body.mfl_response (if string, first 200 chars)
  //   5. fallback "<msg> (HTTP <status>)"
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

  // POST the lineup draft to the worker.
  //
  // SIDE EFFECT — WRITES REAL MFL DATA. The worker verifies the forwarded
  // MFL_USER_ID cookie resolves to this franchise (403 otherwise), then POSTs
  // import?TYPE=lineup to MFL with STARTERS=<csv>, overwriting the franchise's
  // real starting lineup for MFL's CURRENT scoring week (no week param is
  // sent). No Discord post, no D1 write on this path.
  //
  // Wire format is unchanged: a FLAT array of player IDs. MFL re-slots by
  // position server-side; the named slots are a client-side aid. Only the
  // client state shape changed (flat Set → { slotId: pid }), so we walk
  // LINEUP_SLOTS in order and dedupe — same approach as gameday.html.
  function submitLineupDraft() {
    if (state.lineupSubmitting) return;
    var fid = pad4(state.viewerFranchiseId || (state.ctx && state.ctx.franchiseId));
    if (!fid) return;
    var draft = state.lineupDraft || {};
    var seen = {}, starters = [];
    LINEUP_SLOTS.forEach(function (s) {
      var pid = draft[s.id];
      if (pid && !seen[pid]) { seen[pid] = 1; starters.push(pid); }
    });
    state.lineupSubmitting = true;
    state.lineupMessage = { kind: "info", text: "Submitting lineup to MFL…" };
    renderLineupZone();
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
          state.lineupMessage = { kind: "err", text: String(extractMflError(resp, "MFL rejected lineup")) };
        }
      })
      .catch(function (e) {
        state.lineupMessage = { kind: "err", text: "Submit failed: " + (e && e.message || e) };
      })
      .then(function () {
        state.lineupSubmitting = false;
        renderLineupZone();
      });
  }

  // Load this franchise's persisted per-player trade-bait notes from D1.
  // Idempotent: only fires once per page load, and only when the On The
  // Block panel is actually opened.
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
        // Seed the bait set with players that have notes — the owner cared
        // enough to annotate them, so they're presumed still available.
        if (!state.tradeBaitDraft) state.tradeBaitDraft = new Set();
        Object.keys(notes).forEach(function (pid) { state.tradeBaitDraft.add(pid); });
        if (state.openPanel === "bait") renderTradeBaitPanel();
      })
      .catch(function () { /* non-fatal — UI just shows blank notes */ });
  }

  // POST the trade bait draft to the worker.
  //
  // SIDE EFFECT — THIS IS THE LOUD ONE. Three real-world writes per save:
  //   1. MFL import?TYPE=tradeBait with WILL_GIVE_UP + IN_EXCHANGE_FOR, using
  //      the owner's forwarded MFL_USER_ID cookie — publicly changes this
  //      franchise's On-The-Block listing league-wide.
  //   2. DELETE-then-INSERT of D1 ups_trade_bait_notes for
  //      (league, season, franchise) — blank notes prune rows.
  //   3. postOtbDiscord() — a formatted announcement (with a Giphy GIF) to the
  //      real OTB Discord channel, PLUS a discussion thread named
  //      "OTB · <franchise> · <date>". Every save re-announces to the league.
  // The worker's dryRun flag skips 1 and 2 but STILL fires 3; this file never
  // sends dryRun, so a save from here is fully live on all three.
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
    // Build playerNames map for the worker — used for both the MFL comment
    // concat AND the OTB Discord announcement. Send raw inputs; the worker
    // does MFL truncation + Discord formatting.
    var playerNames = {};
    getMyRoster().forEach(function (r) {
      var p = playerById(r.id) || {};
      playerNames[String(r.id)] = safeStr(p.name) || String(r.id);
    });
    var franchiseName = (state.viewerFranchise && state.viewerFranchise.name)
      || (state.ctx && state.ctx.franchiseName)
      || "";

    state.tradeBaitSubmitting = true;
    state.tradeBaitMessage = { kind: "info", text: "Submitting trade bait to MFL…" };
    renderTradeBaitPanel();
    fetch(withMflUserParam(workerBase() + "/api/submit-trade-bait"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        franchiseId: fid,
        franchiseName: franchiseName,
        willGiveUp: willGiveUp,
        lookingFor: lookingForRaw,    // raw — worker does MFL concat + truncate
        notes: notesPayload,
        playerNames: playerNames,
      }),
    })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
      .then(function (resp) {
        if (resp.body && resp.body.ok) {
          state.tradeBaitMessage = { kind: "ok", text: "Trade bait saved + announced ✓" };
        } else {
          state.tradeBaitMessage = { kind: "err", text: String(extractMflError(resp, "MFL rejected trade bait")) };
        }
      })
      .catch(function (e) {
        state.tradeBaitMessage = { kind: "err", text: "Submit failed: " + (e && e.message || e) };
      })
      .then(function () {
        state.tradeBaitSubmitting = false;
        renderTradeBaitPanel();
      });
  }

  // ---------- On The Block panel (position-grouped roster) ----------
  //
  // The trade-bait authoring surface, demoted out of the hub spine into a
  // Zone 5 disclosure panel. Position-grouped (NOT slot-based — slots are a
  // lineup concept and mean nothing here).
  var BAIT_GROUP_ORDER = ["QB", "RB", "WR", "TE", "PK", "PN", "DL", "LB", "DB", "OTH"];
  var BAIT_GROUP_LABEL = {
    QB: "QB", RB: "RB", WR: "WR", TE: "TE", PK: "K", PN: "P",
    DL: "DL (DT/DE)", LB: "LB", DB: "DB (CB/S)", OTH: "Other"
  };

  function renderTradeBaitPanel() {
    var el = document.getElementById("topsBaitBody");
    if (!el) return;
    if (!state.tradeBaitDraft) state.tradeBaitDraft = new Set();
    if (!state.tradeBaitNotes) state.tradeBaitNotes = {};
    if (!state.tradeBaitNotesLoaded) loadTradeBaitNotes();

    var rows = buildLineupRows();
    if (!rows.length) {
      el.innerHTML = '<div class="tops-empty">No roster data loaded yet.</div>';
      return;
    }

    var byGroup = {};
    BAIT_GROUP_ORDER.forEach(function (g) { byGroup[g] = []; });
    rows.forEach(function (r) { (byGroup[r.group] || byGroup.OTH).push(r); });
    Object.keys(byGroup).forEach(function (k) {
      byGroup[k].sort(function (a, b) { return b.salary - a.salary; });
    });

    var sections = BAIT_GROUP_ORDER.map(function (g) {
      var groupRows = byGroup[g] || [];
      if (!groupRows.length) return "";
      var marked = groupRows.reduce(function (acc, r) {
        return acc + (state.tradeBaitDraft.has(r.id) ? 1 : 0);
      }, 0);
      var body = groupRows.map(function (r) {
        var checked = state.tradeBaitDraft.has(r.id);
        var badges = (r.isTaxi ? '<span class="tops-tag-mini">TAXI</span>' : '')
          + (r.isIr ? '<span class="tops-tag-mini">IR</span>' : '')
          + (r.isExpired ? '<span class="tops-tag-mini is-bad">EXP</span>' : '')
          + (r.injStatus ? '<span class="tops-tag-mini is-warn">' + escapeHtml(r.injStatus) + '</span>' : '');
        // Taxi players ARE tradeable (Keith 2026-05-15) — MFL's tradeBait
        // accepts them, so every rostered player is bait-eligible.
        var main = '<tr class="tops-bait-row' + (checked ? ' is-marked' : '') + '" data-pid="' + escapeHtml(r.id) + '">'
          + '<td class="tops-bait-check"><input type="checkbox" class="tops-bait-cbx" data-pid="' + escapeHtml(r.id) + '"'
          +   (checked ? ' checked' : '') + ' aria-label="Mark ' + escapeHtml(r.name) + ' available for trade"></td>'
          + '<td><span class="tops-pos">' + escapeHtml(r.pos) + '</span></td>'
          + '<td><span class="tops-bait-name" tabindex="0" role="button" data-action="profile">' + escapeHtml(r.name) + '</span> ' + badges + '</td>'
          + '<td>' + escapeHtml(r.team) + '</td>'
          + '<td class="num">' + (r.salary > 0 ? escapeHtml(fmtUsd(r.salary)) : '—') + '</td>'
          + '<td>' + escapeHtml(r.contract) + '</td>'
          + '</tr>';
        if (!checked) return main;
        var noteVal = state.tradeBaitNotes[r.id] || "";
        return main + '<tr class="tops-bait-note-row"><td colspan="6">'
          + '<label class="tops-bait-note-label">Note for ' + escapeHtml(r.short) + '</label>'
          + '<input type="text" class="tops-bait-note-input" data-pid="' + escapeHtml(r.id) + '" maxlength="500"'
          +   ' placeholder="why available · floor price · package piece" value="' + escapeHtml(noteVal) + '">'
          + '</td></tr>';
      }).join("");
      return '<div class="tops-bait-group">'
        + '<div class="tops-bait-group-h">' + escapeHtml(BAIT_GROUP_LABEL[g] || g)
        +   '<span class="tops-bait-group-n">' + plural(groupRows.length, "player") + '</span>'
        +   (marked ? '<span class="tops-pill is-ok">' + marked + ' available</span>' : '')
        + '</div>'
        + '<table class="tops-bait-table">'
        +   '<thead><tr><th aria-label="Available"></th><th>Pos</th><th>Player</th><th>Team</th><th class="num">Salary</th><th>Contract</th></tr></thead>'
        +   '<tbody>' + body + '</tbody>'
        + '</table>'
        + '</div>';
    }).join("");

    var msgHtml = "";
    if (state.tradeBaitMessage) {
      var kind = state.tradeBaitMessage.kind === "ok" ? "is-ok" : (state.tradeBaitMessage.kind === "err" ? "is-err" : "");
      msgHtml = '<div class="tops-lineup-msg ' + kind + '">' + escapeHtml(state.tradeBaitMessage.text) + '</div>';
    }

    el.innerHTML = ''
      + '<div class="tops-card-h">'
      +   '<span class="tops-card-t">On The Block</span>'
      +   '<span class="tops-card-sub">' + escapeHtml(plural(state.tradeBaitDraft.size, "player") + " marked available") + '</span>'
      +   '<span class="tops-grow"></span>'
      +   '<a class="tops-card-link" href="' + escapeHtml(mflPageUrl("/options?O=133")) + '" target="_top">League trade block &rsaquo;</a>'
      +   '<button type="button" class="tops-cta" id="topsBaitSave"' + (state.tradeBaitSubmitting ? ' disabled' : '') + '>'
      +     (state.tradeBaitSubmitting ? "Saving…" : "Save + announce")
      +   '</button>'
      + '</div>'
      + '<div class="tops-note tops-note--warn">Saving publishes your block league-wide in MFL <b>and</b> posts an announcement to Discord.</div>'
      + msgHtml
      + '<div class="tops-bait-comment">'
      +   '<label for="topsBaitLookingFor">What I\'m looking for</label>'
      +   '<textarea id="topsBaitLookingFor" rows="2" placeholder="e.g. WR2 with starter upside, 2027 1st, anything at TE…">'
      +     escapeHtml(state.tradeBaitLookingFor || "")
      +   '</textarea>'
      + '</div>'
      + sections;

    el.querySelectorAll(".tops-bait-cbx").forEach(function (cbx) {
      cbx.addEventListener("change", function () {
        var pid = cbx.getAttribute("data-pid");
        if (cbx.checked) state.tradeBaitDraft.add(pid);
        else state.tradeBaitDraft.delete(pid);
        state.tradeBaitMessage = null;
        renderTradeBaitPanel();
      });
    });
    // Free-text inputs persist on input WITHOUT a re-render so the caret
    // doesn't jump on every keystroke.
    var lookingFor = el.querySelector("#topsBaitLookingFor");
    if (lookingFor) lookingFor.addEventListener("input", function () {
      state.tradeBaitLookingFor = lookingFor.value;
      state.tradeBaitMessage = null;
    });
    el.querySelectorAll(".tops-bait-note-input").forEach(function (inp) {
      inp.addEventListener("input", function () {
        var pid = inp.getAttribute("data-pid");
        if (!pid) return;
        state.tradeBaitNotes[pid] = inp.value;
        state.tradeBaitMessage = null;
      });
    });
    var save = document.getElementById("topsBaitSave");
    if (save) save.addEventListener("click", function () {
      if (save.hasAttribute("disabled")) return;
      submitTradeBaitDraft();
    });
    el.querySelectorAll('[data-action="profile"]').forEach(function (node) {
      var row = node.closest(".tops-bait-row");
      var pid = row && row.getAttribute("data-pid");
      if (!pid) return;
      node.addEventListener("click", function (e) { e.stopPropagation(); openPlayerProfileModal(pid); });
      node.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPlayerProfileModal(pid); }
      });
    });
  }

  function renderAll() {
    // If we couldn't figure out who the viewer is, render a clear "pick your
    // franchise" empty state rather than silently zeroing every zone. Common
    // causes: HPM mounted on a page MFL doesn't inject FRANCHISE_ID for;
    // cross-origin local testing where MFL fetches are CORS-blocked; user
    // not logged in.
    if (!state.viewerFranchiseId || !state.viewerFranchise) {
      renderViewerEmptyState();
      return;
    }
    renderHub();
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

  // ── Contract helpers — delegate to the shared cap-math module
  //    (site/shared/cap_math.js, loaded by mfl_hpm_embed_loader.js).
  //    Issue #244 Phase 2B: previously inline; the inline regex bug that
  //    produced Coleman's wrong $11K cap-penalty was fixed in PR #240, but
  //    kept drifting from the Front Office canonical. Now there's one source
  //    of truth; the copies here are thin wrappers preserving the tops_* names.
  function tops_capMath() {
    return (typeof window !== "undefined" && window.UPS_CAP_MATH) || null;
  }
  function tops_parseContractInfo(info) {
    var m = tops_capMath();
    if (m) return m.parseContractInfo(info);
    // Fail-soft if cap_math.js failed to load: return an empty shape so
    // callers don't NPE. The UI degrades to "—" rather than wrong.
    return { tcv: 0, length: 0, yearVals: {}, aav: 0, gtd: 0 };
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
    var m = tops_capMath();
    return m ? m.earnedToDate(sal) : 0;
  }
  function tops_dropPenalty(sal) {
    var m = tops_capMath();
    return m ? (m.dropPenalty(sal) || 0) : 0;
  }
  function tops_findAcquisition(pid) {
    // Walk transactions for the most recent acquisition of this player by
    // the viewer. Returns { ts, type, method } or null.
    var pidStr = String(pid);
    var txns = asArray(state.transactions && state.transactions.transactions && state.transactions.transactions.transaction);
    var fid = state.viewerFranchiseId;
    var found = null;
    txns.forEach(function (t) {
      if (pad4(t.franchise) !== fid) return;
      var typ = safeStr(t.type).toUpperCase();
      var hits = [t.transaction, t.added, t.player_added, t.promoted, t.activated, t.demoted];
      for (var i = 0; i < hits.length; i++) {
        var raw = safeStr(hits[i]);
        if (!raw) continue;
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

  // ── Player Profile Modal (click any player to open) ──
  // Uses /api/player-bundle for live MFL data. Delegates to the unified
  // master modal when available (v1.7.43+) and only falls through to the
  // legacy in-file implementation if the master script didn't load.
  function openPlayerProfileModal(pid) {
    if (!pid) return;
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
        if (window.console) console.warn("[tops] master profile modal failed, falling back:", e);
      }
    }
    closePlayerProfileModal();  // collapse any prior open
    var pInfo = playerById(pid) || {};
    var name = prettyPlayerName(pInfo.name) || ("Player #" + pid);
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

  function renderProfileStats(bundle) {
    // Bundle uses UPS-flavored career_summary[] — season-by-season fantasy
    // performance with UPS-specific ranks. Most recent season first.
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

  function renderProfileGameLog(bundle) {
    // Bundle stores weekly_by_season keyed by year. Flatten newest-first and
    // cap at 24 rows so the modal stays readable.
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
      return '<tr>' +
        '<td>' + escapeHtml(safeStr(g.season)) + '</td>' +
        '<td class="num">' + escapeHtml(safeStr(g.week)) + '</td>' +
        '<td class="num">' + escapeHtml(safeStr(g.score)) + '</td>' +
        '<td class="num">' + (g.pos_rank != null ? '#' + escapeHtml(safeStr(g.pos_rank)) : '—') + '</td>' +
        '<td>' + escapeHtml(safeStr(g.week_tier || g.status)) + '</td>' +
        '<td>' + escapeHtml(safeStr(g.roster_franchise_name || g.status)) + '</td>' +
        '</tr>';
    }).join("");
    return '<table class="tops-profile-table"><thead><tr>' +
      '<th>Season</th><th class="num">Wk</th><th class="num">Pts</th>' +
      '<th class="num">Pos #</th><th>Tier</th><th>Roster</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
  }

  // News tab uses the worker's /api/player-news multi-source aggregator
  // (Sleeper structured info + ESPN team articles fuzzy-matched to player
  // last name). The MFL playerProfile.news bundle field is deprecated and
  // returns empty for everyone — that was the v1.7.36 mistake.
  function renderProfileNews(bundle, pid) {
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
        if (el) el.innerHTML = '<div class="tops-empty is-err">News fetch failed. Refresh to retry.</div>';
      });
  }
  function closePlayerProfileModal() {
    var ov = document.getElementById("topsProfileOverlay");
    if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
    document.removeEventListener("keydown", _topsProfileEsc);
  }
  function _topsProfileEsc(e) { if (e.key === "Escape") closePlayerProfileModal(); }

  // ── Player News panel (Zone 5 disclosure) ─────────────────────────────
  // League-wide news search. Filters: name (substring) · position pills ·
  // NFL team dropdown. Resolves the filter into a list of player IDs (max 50,
  // the /api/player-news batch limit) and calls the news endpoint.
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
    var d = new Date(t * 1000);
    var sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString("en-US",
      sameYear ? { month: "short", day: "numeric" }
               : { month: "short", day: "numeric", year: "numeric" });
  }

  // Articles get matched to multiple players by the news handler (e.g. an SFO
  // team article matches every SFO team-pseudo). Without dedup we render the
  // same headline 10+ times. Collapse rows sharing (headline + first 80 chars
  // of body). Per-player STATUS / DEPTH entries are NOT deduped — each player
  // legitimately has their own status row.
  function dedupeNewsItems(items) {
    var seen = {};
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var n = items[i];
      var typ = String(n.type || "").toLowerCase();
      if (typ === "status" || typ === "depth") { out.push(n); continue; }
      var hk = (n.headline || "").trim();
      var bk = (n.body || "").trim().slice(0, 80);
      var key = hk + "||" + bk;
      if (!hk && !bk) { out.push(n); continue; }
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

  function newsInjStatusForPid(pid) {
    if (!pid) return "";
    var inj = getInjuryFor(pid);
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
    var injStatus = newsInjStatusForPid(pid);
    var injMini = injStatus
      ? '<span class="tops-inj tops-inj-' + escapeHtml(injStatus) + '" title="Injury status: ' + escapeHtml(injStatus) + '">' + escapeHtml(injStatus) + '</span>'
      : '';
    var nameLink = '<button type="button" class="tops-news-player-link" data-pid="' + escapeHtml(pid) + '" title="Open player profile">' + escapeHtml(prettyPlayerName(n.player)) + '</button>';

    var headBodyInner =
      (n.headline ? '<div class="tops-news-head">' + escapeHtml(n.headline) + '</div>' : '') +
      (bodyTrim ? '<div class="tops-news-body">' + bodyTrim + '</div>' : '');
    var headBody = '';
    if (headBodyInner) {
      headBody = n.url
        ? '<a class="tops-news-article-link" href="' + escapeHtml(n.url) + '" target="_blank" rel="noopener noreferrer" title="Open article in new tab">' + headBodyInner + '</a>'
        : '<div class="tops-news-article-static">' + headBodyInner + '</div>';
    }

    return '<li class="tops-news-item">' +
      '<div class="tops-news-row1">' +
        typeBadge +
        injMini +
        nameLink +
        (n.position ? '<span class="tops-news-pos">' + escapeHtml(n.position) + '</span>' : '') +
        (n.team ? '<span class="tops-news-team">' + escapeHtml(n.team) + '</span>' : '') +
        (when ? '<span class="tops-news-when">' + escapeHtml(when) + '</span>' : '') +
      '</div>' +
      headBody +
      '</li>';
  }

  // Only the player-name button opens the master profile modal. The
  // headline/body region is its own <a> and handles its own navigation.
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

  // UPS-confirmed player positions (live count from MFL):
  // WR/LB/CB/RB/DT/DE/S/TE/QB/PK/PN/Def. IDP grouping mirrors MFL directly.
  var ALL_NEWS_POSITIONS = ["QB", "RB", "WR", "TE", "PK", "Def", "DT", "DE", "LB", "CB", "S"];
  var ALL_NEWS_MAX_PIDS = 50;

  var _allPlayerIndexCache = null;
  function getAllPlayerIndex() {
    if (_allPlayerIndexCache) return _allPlayerIndexCache;
    var out = { byPid: {}, teams: {}, posCounts: {} };
    if (state.players && state.players.players) {
      asArray(state.players.players.player).forEach(function (p) {
        var pid = String(p.id || "");
        if (!pid) return;
        var rec = { pid: pid, name: safeStr(p.name), position: safeStr(p.position), team: safeStr(p.team) };
        out.byPid[pid] = rec;
        if (rec.team) out.teams[rec.team] = (out.teams[rec.team] || 0) + 1;
        if (rec.position) out.posCounts[rec.position] = (out.posCounts[rec.position] || 0) + 1;
      });
    }
    _allPlayerIndexCache = out;
    return out;
  }

  //   scope === "myteam" → starts from the viewer's roster (no batch cap
  //                        needed; rosters are ≤ 30 players).
  //   scope === "all"    → starts from the full NFL player index.
  function resolveAllPlayerNewsCandidates() {
    var f = state.allPlayerNewsFilters || {};
    var scope = (f.scope === "all") ? "all" : "myteam";
    var name = String(f.name || "").trim().toLowerCase();
    var pos  = String(f.position || "").trim();
    var team = String(f.team || "").trim().toUpperCase();
    var idx = getAllPlayerIndex();

    var pool;
    if (scope === "myteam") {
      pool = getMyRoster().map(function (r) {
        return idx.byPid[r.id] || { pid: r.id, name: "Player #" + r.id, position: "", team: "" };
      });
    } else {
      pool = Object.keys(idx.byPid).map(function (pid) { return idx.byPid[pid]; });
    }

    var out = pool.filter(function (r) {
      if (pos && r.position !== pos) return false;
      if (team && String(r.team || "").toUpperCase() !== team) return false;
      if (name && r.name.toLowerCase().indexOf(name) === -1) return false;
      return true;
    });

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
      container.innerHTML = '<div class="tops-empty">' + (scope === "myteam"
        ? 'Loading your team\'s news…'
        : 'Pick a position / team / name above, then <strong>Find News</strong>.') + '</div>';
      return;
    }
    var sorted = filterAndSortNews(state.allPlayerNewsItems, "", getNewsSortPref());
    var itype = (state.allPlayerNewsFilters && state.allPlayerNewsFilters.itemType) || "";
    if (itype) {
      sorted = sorted.filter(function (n) { return String(n.type || "") === itype; });
    }
    var showN = Math.min(sorted.length, state.allPlayerNewsShowN || NEWS_PAGE_SIZE);
    var visible = sorted.slice(0, showN);
    if (!visible.length) {
      container.innerHTML = '<div class="tops-empty">' + (itype
        ? 'No "' + (itype === "status" ? "Injury" : itype === "depth" ? "Depth" : "News") + '" items for these filters.'
        : 'No news for these filters in the last few weeks.') + '</div>';
      return;
    }
    var more = sorted.length > showN
      ? '<button type="button" class="tops-news-more" data-news-card="all">Show ' + Math.min(NEWS_PAGE_SIZE, sorted.length - showN) + ' more (' + (sorted.length - showN) + ' remaining)</button>'
      : '';
    container.innerHTML = '<ul class="tops-news-list">' + visible.map(newsItemHtml).join("") + '</ul>' + more;
  }

  function renderAllPlayerNews() {
    var el = els.cards && els.cards.allPlayerNews;
    if (!el) return;
    if (!state.players || !state.players.players) {
      el.innerHTML = '<div class="tops-card-h"><span class="tops-card-t">Player News &amp; Injuries</span></div><div class="tops-empty">Player index still loading…</div>';
      return;
    }
    state.allPlayerNewsFilters = state.allPlayerNewsFilters || { scope: "myteam", name: "", position: "", team: "", itemType: "" };
    if (!state.allPlayerNewsFilters.scope) state.allPlayerNewsFilters.scope = "myteam";
    if (state.allPlayerNewsFilters.itemType == null) state.allPlayerNewsFilters.itemType = "";
    state.allPlayerNewsShowN = state.allPlayerNewsShowN || NEWS_PAGE_SIZE;
    var f = state.allPlayerNewsFilters;
    var idx = getAllPlayerIndex();

    // Always-on injuries block (free — already loaded). Roster-scoped only.
    var injHtml = "";
    var myInjsCount = 0;
    if (f.scope === "myteam") {
      var rosterIds = {};
      getMyRoster().forEach(function (r) { rosterIds[String(r.id)] = true; });
      var myInjs = asArray(state.injuries && state.injuries.injuries && state.injuries.injuries.injury)
        .filter(function (i) { return rosterIds[String(i.id)]; });
      myInjsCount = myInjs.length;
      if (myInjs.length) {
        injHtml = '<div class="tops-news-section-title">Active injuries</div>'
          + '<ul class="tops-news-list">' + myInjs.slice(0, 8).map(function (i) {
            var p = playerById(i.id) || {};
            var stat = String(i.status || "?");
            return '<li class="tops-news-item">'
              + '<div class="tops-news-row1">'
              +   '<span class="tops-inj tops-inj-' + escapeHtml(stat) + '" title="' + escapeHtml(stat) + '">' + escapeHtml(stat) + '</span>'
              +   '<button type="button" class="tops-news-player-link" data-pid="' + escapeHtml(String(i.id)) + '">' + escapeHtml(prettyPlayerName(p.name) || ("Player #" + i.id)) + '</button>'
              +   (p.position ? '<span class="tops-news-pos">' + escapeHtml(p.position) + '</span>' : '')
              +   (p.team ? '<span class="tops-news-team">' + escapeHtml(p.team) + '</span>' : '')
              + '</div>'
              + (i.details ? '<div class="tops-news-body">' + escapeHtml(i.details) + '</div>' : '')
              + '</li>';
          }).join("") + '</ul>';
      }
    }

    var teams = Object.keys(idx.teams).filter(function (t) { return t && t !== "FA"; }).sort();
    var teamOptions = '<option value="">All NFL teams</option>'
      + teams.map(function (t) { return '<option value="' + escapeHtml(t) + '"' + (t === f.team ? ' selected' : '') + '>' + escapeHtml(t) + ' (' + idx.teams[t] + ')</option>'; }).join("")
      + '<option value="FA"' + (f.team === "FA" ? ' selected' : '') + '>Free Agents</option>';

    var pillBar = '<div class="tops-pos-pills">'
      + '<button type="button" class="tops-pos-pill" data-scope="myteam" data-active="' + (f.scope === "myteam" ? "1" : "0") + '">My Team</button>'
      + '<span class="tops-pill-divider" aria-hidden="true"></span>'
      + '<button type="button" class="tops-pos-pill" data-pos="" data-active="' + ((f.scope === "all" && !f.position) ? "1" : "0") + '">All</button>'
      + ALL_NEWS_POSITIONS.map(function (p) {
          return '<button type="button" class="tops-pos-pill" data-pos="' + escapeHtml(p) + '" data-active="' + ((f.scope === "all" && f.position === p) ? "1" : "0") + '">' + escapeHtml(p) + '</button>';
        }).join("")
      + '</div>';

    var ITYPES = [
      { id: "", label: "All" },
      { id: "status", label: "Injury" },
      { id: "depth", label: "Depth" },
      { id: "headline", label: "News" }
    ];
    var typeBar = '<div class="tops-pos-pills">'
      + '<span class="tops-itype-label">Type</span>'
      + ITYPES.map(function (t) {
          return '<button type="button" class="tops-pos-pill" data-itype="' + escapeHtml(t.id) + '" data-active="' + (f.itemType === t.id ? "1" : "0") + '">' + escapeHtml(t.label) + '</button>';
        }).join("")
      + '</div>';

    var candidates = resolveAllPlayerNewsCandidates();
    var candCount = candidates.length;
    var statusLine;
    if (f.scope === "myteam") {
      statusLine = plural(candCount, "player") + ' on your roster.';
    } else if (candCount === 0) {
      statusLine = 'No players match these filters.';
    } else if (candCount > ALL_NEWS_MAX_PIDS) {
      statusLine = candCount + ' matches — narrowing to the top ' + ALL_NEWS_MAX_PIDS + ' (alphabetical, NFL-active first).';
    } else {
      statusLine = plural(candCount, "matching player") + '.';
    }

    el.innerHTML = [
      '<div class="tops-card-h">',
      '  <span class="tops-card-t">Player News &amp; Injuries</span>',
      myInjsCount ? '  <span class="tops-pill is-warn">' + myInjsCount + ' injured</span>' : '',
      '</div>',
      injHtml,
      '<div class="tops-allnews-controls">',
      pillBar,
      '  <select class="tops-allnews-team">' + teamOptions + '</select>',
      '  <input type="text" class="tops-allnews-name" placeholder="Search player name…" value="' + escapeHtml(f.name) + '">',
      '  <button type="button" class="tops-allnews-go" data-disabled="' + (candCount === 0 ? "1" : "0") + '">Find News</button>',
      '  <button type="button" class="tops-news-sort" data-allnews-sort>' + (getNewsSortPref() === "newest" ? '↓ Newest' : '↑ Oldest') + '</button>',
      '</div>',
      typeBar,
      '<div class="tops-allnews-status">' + statusLine + '</div>',
      '<div class="tops-allnews-list-mount"></div>'
    ].join("");

    var listMount = el.querySelector(".tops-allnews-list-mount");
    renderAllPlayerNewsList(listMount);

    el.querySelectorAll("[data-scope]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.allPlayerNewsFilters.scope = "myteam";
        state.allPlayerNewsFilters.position = "";
        state.allPlayerNewsItems = null;
        state.allPlayerNewsShowN = NEWS_PAGE_SIZE;
        renderAllPlayerNews();
        setTimeout(doAllPlayerNewsSearch, 0);   // roster pool is small
      });
    });

    // Item-type pills are a pure client-side display filter — no refetch, and
    // no full re-render so the search input keeps focus.
    el.querySelectorAll("[data-itype]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.allPlayerNewsFilters.itemType = btn.getAttribute("data-itype");
        state.allPlayerNewsShowN = NEWS_PAGE_SIZE;
        el.querySelectorAll("[data-itype]").forEach(function (b) {
          b.setAttribute("data-active", b === btn ? "1" : "0");
        });
        renderAllPlayerNewsList(listMount);
        rewireNewsItemClicks(el);
      });
    });

    el.querySelectorAll("[data-pos]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.allPlayerNewsFilters.scope = "all";
        state.allPlayerNewsFilters.position = btn.getAttribute("data-pos");
        state.allPlayerNewsItems = null;
        state.allPlayerNewsShowN = NEWS_PAGE_SIZE;
        renderAllPlayerNews();
      });
    });

    var teamSel = el.querySelector(".tops-allnews-team");
    if (teamSel) teamSel.addEventListener("change", function () {
      state.allPlayerNewsFilters.team = teamSel.value || "";
      state.allPlayerNewsItems = null;
      state.allPlayerNewsShowN = NEWS_PAGE_SIZE;
      renderAllPlayerNews();
    });

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

    var goBtn = el.querySelector(".tops-allnews-go");
    if (goBtn) goBtn.addEventListener("click", function () {
      if (goBtn.getAttribute("data-disabled") === "1") return;
      doAllPlayerNewsSearch();
    });

    var sortBtn = el.querySelector("[data-allnews-sort]");
    if (sortBtn) sortBtn.addEventListener("click", function () {
      var next = getNewsSortPref() === "newest" ? "oldest" : "newest";
      setNewsSortPref(next);
      sortBtn.textContent = next === "newest" ? "↓ Newest" : "↑ Oldest";
      renderAllPlayerNewsList(listMount);
      rewireNewsItemClicks(el);
    });

    el.addEventListener("click", function (ev) {
      var more = ev.target.closest && ev.target.closest('.tops-news-more[data-news-card="all"]');
      if (!more) return;
      state.allPlayerNewsShowN = (state.allPlayerNewsShowN || NEWS_PAGE_SIZE) + NEWS_PAGE_SIZE;
      renderAllPlayerNewsList(listMount);
      rewireNewsItemClicks(el);
    });

    rewireNewsItemClicks(el);

    if (f.scope === "myteam" && !state.allPlayerNewsItems && !state.allPlayerNewsLoading) {
      setTimeout(doAllPlayerNewsSearch, 0);
    }
  }

  function doAllPlayerNewsSearch() {
    var el = els.cards && els.cards.allPlayerNews;
    if (!el) return;
    var candidates = resolveAllPlayerNewsCandidates();
    if (!candidates.length) return;
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

  // ---------- Empty / loading / error states ----------

  // Friendly empty state when no franchise could be resolved. Surfaces a
  // dropdown of league franchises so the viewer can pick manually rather
  // than staring at all zeros. Selection is persisted to localStorage.
  function renderViewerEmptyState() {
    var mount = document.getElementById("teamOpsMount");
    if (!mount) return;
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

    mount.innerHTML = '<div class="tops-shell">'
      + '<section class="tops-card">'
      +   '<div class="tops-card-h"><span class="tops-card-t">Pick your franchise</span></div>'
      +   '<div class="tops-empty">We couldn\'t work out which franchise is yours from this page.'
      +     ' Pick from the list below — we\'ll remember it next time.</div>'
      +   (franchises.length
            ? '<div class="tops-picker">'
              + '<select id="topsViewerPicker"><option value="">— Pick franchise —</option>' + optsHtml + '</select>'
              + '<button type="button" class="tops-cta" id="topsViewerPickerSave">Use this</button>'
              + '</div>'
            : '<div class="tops-empty">League data hasn\'t loaded — refresh to retry.</div>')
      +   (diagnostics.length ? '<div class="tops-empty is-err">⚠ ' + escapeHtml(diagnostics.join(" · ")) + '</div>' : '')
      + '</section>'
      + footerHtml()
      + '</div>';

    var btn = document.getElementById("topsViewerPickerSave");
    if (btn) {
      btn.addEventListener("click", function () {
        var sel = document.getElementById("topsViewerPicker");
        var pickedFid = sel && sel.value;
        if (!pickedFid) return;
        try { window.localStorage && window.localStorage.setItem("rdh_my_fid", pickedFid); } catch (e) {}
        state.viewerFranchiseId = pickedFid;
        state.viewerFranchise = state.franchises.find(function (f) { return f.id === pickedFid; }) || null;
        state.lineupDraft = null;   // reseed against the newly-picked roster
        renderAll();
      });
    }
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
