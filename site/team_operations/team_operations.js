(function () {
  "use strict";

  var BUILD = "2026.05.11.12";
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
    capAmount: 0,
    loadErrors: [],
    lastLoaded: null,
    // Per-player bundle cache populated lazily via /api/player-bundle on
    // the Cloudflare worker. Same endpoint Draft Hub + Front Office use,
    // so once any hub primes a player, all three benefit (worker edge cache).
    playerBundles: {},
    teamNewsItems: null,
    teamNewsLoading: false
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
      ["players", fetchJson(mflExportUrl("players", { DETAILS: "1" }))],
      ["transactions", fetchJson(mflExportUrl("transactions", { DAYS: 14 }))],
      ["pendingTrades", fetchJson(mflExportUrl("pendingTrades"))],
      ["tradeBait", fetchJson(mflExportUrl("tradeBait"))],
      ["futureDraftPicks", fetchJson(mflExportUrl("futureDraftPicks"))],
      ["schedule", fetchJson(mflExportUrl("schedule"))],
      ["nflByeWeeks", fetchJson(mflExportUrl("nflByeWeeks"))],
      ["injuries", fetchJson(mflExportUrl("injuries"))],
      ["calendar", fetchJson(mflExportUrl("calendar"))]
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
    // 2. MFL_LAST_LOGIN_FRANCHISE_ID cookie — MFL sets this for any
    //    logged-in user. Most reliable signal on MFL pages where
    //    window.FRANCHISE_ID isn't injected (e.g. some custom HPMs).
    // 3. localStorage rdh_my_fid — set by the Draft Hub when it figures
    //    out the user. Survives across hubs.
    // 4. URL path /home/<league>/<franchise> — already handled by the
    //    embed loader but re-check in case ctx wasn't populated.
    // 5. MFL_USER_ID cookie matched against league franchise records.
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

  function getMySalaries() {
    if (!state.salaries || !state.salaries.salaries) return [];
    var lg = state.salaries.salaries.leagueUnit;
    var units = asArray(lg);
    var out = [];
    units.forEach(function (u) {
      asArray(u.player).forEach(function (p) {
        if (pad4(p.franchise_id || u.id) === state.viewerFranchiseId) {
          out.push({
            id: String(p.id),
            salary: Number(p.salary || 0),
            contractYear: safeStr(p.contractYear),
            contractInfo: safeStr(p.contractInfo),
            contractStatus: safeStr(p.contractStatus)
          });
        }
      });
    });
    return out;
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

  function renderShell() {
    var mount = document.getElementById("teamOpsMount");
    if (!mount) return;

    var viewerName = state.viewerFranchise ? state.viewerFranchise.name : "My Team";
    var viewerIcon = state.viewerFranchise ? state.viewerFranchise.icon : "";

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
      '    <div class="tops-header-actions">',
      '      <a class="tops-link-pill" href="//www.myfantasyleague.com/' + escapeHtml(state.ctx.year) + '/lineup?L=' + escapeHtml(state.ctx.leagueId) + '">Submit Lineup</a>',
      '      <a class="tops-link-pill" href="//www.myfantasyleague.com/' + escapeHtml(state.ctx.year) + '/options?L=' + escapeHtml(state.ctx.leagueId) + '&O=07">Full Rosters</a>',
      '      <a class="tops-link-pill" href="//www.myfantasyleague.com/' + escapeHtml(state.ctx.year) + '/options?L=' + escapeHtml(state.ctx.leagueId) + '&O=05">Trade Room</a>',
      '    </div>',
      '  </header>',
      '  <main class="tops-grid">',
      '    <section data-card="summary" class="tops-card tops-card-summary"></section>',
      '    <section data-card="matchup" class="tops-card"></section>',
      '    <section data-card="lineup" class="tops-card"></section>',
      '    <section data-card="roster" class="tops-card tops-card-wide"></section>',
      '    <section data-card="news" class="tops-card"></section>',
      '    <section data-card="nextDecision" class="tops-card tops-card-highlight"></section>',
      // Risk Heatmap + Cap Trajectory placeholder cards removed in
      // v1.7.32 — they explicitly said "Phase 1b" which confused owners
      // about what was real. Real implementations live on the post-draft
      // backlog (heatmap = depth × games × injury risk; trajectory =
      // year-by-year obligations from CCC contract data).
      '    <section data-card="whatChanged" class="tops-card"></section>',
      '    <section data-card="pendingTrades" class="tops-card"></section>',
      '    <section data-card="waivers" class="tops-card"></section>',
      '    <section data-card="transactions" class="tops-card"></section>',
      '    <section data-card="futurePicks" class="tops-card"></section>',
      '    <section data-card="schedule" class="tops-card"></section>',
      '    <section data-card="calendar" class="tops-card"></section>',
      '  </main>',
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

    // Universal taxi rule: salary is real money but DOES NOT count vs the
    // cap. Split the totals so the headline "Cap Used" is cap-relevant
    // only; taxi $ surfaces as a secondary callout.
    var capUsed = 0;
    var taxiSalary = 0;
    salaries.forEach(function (s) {
      var amt = Number(s.salary || 0);
      if (/taxi/i.test(statusById[s.id] || "")) taxiSalary += amt;
      else capUsed += amt;
    });
    var cap = state.capAmount;
    var remain = cap - capUsed;
    var pct = cap > 0 ? Math.min(100, Math.round((capUsed / cap) * 100)) : 0;

    var rosterCount = roster.length;
    var irCount = roster.filter(function (p) { return /ir/i.test(p.status); }).length;
    var taxiCount = roster.filter(function (p) { return /taxi/i.test(p.status); }).length;
    var activeCount = rosterCount - irCount - taxiCount;

    var nextDeadlineIso = "2026-09-06";
    var days = daysUntil(nextDeadlineIso);

    el.innerHTML = [
      '<div class="tops-card-title">Franchise Summary</div>',
      '<div class="tops-summary-grid">',
      '  <div class="tops-kv">',
      '    <div class="tops-kv-label">Cap Used</div>',
      '    <div class="tops-kv-value">' + fmtUsd(capUsed) + '</div>',
      '    <div class="tops-kv-note">' + pct + '% of ' + fmtUsd(cap) +
        (taxiSalary > 0 ? ' · <span style="opacity:0.75;">+ ' + fmtUsd(taxiSalary) + ' taxi (off-cap)</span>' : '') +
        '</div>',
      '    <div class="tops-bar"><div class="tops-bar-fill" style="width:' + pct + '%"></div></div>',
      '  </div>',
      '  <div class="tops-kv">',
      '    <div class="tops-kv-label">Cap Room</div>',
      '    <div class="tops-kv-value">' + fmtUsd(remain) + '</div>',
      '    <div class="tops-kv-note">Projected remaining</div>',
      '  </div>',
      '  <div class="tops-kv">',
      '    <div class="tops-kv-label">Roster</div>',
      '    <div class="tops-kv-value">' + rosterCount + '</div>',
      '    <div class="tops-kv-note">' + activeCount + ' active · ' + taxiCount + ' taxi · ' + irCount + ' IR</div>',
      '  </div>',
      '  <div class="tops-kv">',
      '    <div class="tops-kv-label">Next Deadline</div>',
      '    <div class="tops-kv-value">' + (days == null ? '—' : days + ' days') + '</div>',
      '    <div class="tops-kv-note">Contract lock ' + nextDeadlineIso + '</div>',
      '  </div>',
      '</div>'
    ].join("");
  }

  // ----- Card: Matchup -----
  function renderMatchup() {
    var el = els.cards.matchup;
    if (!el) return;

    var opponent = "—";
    var week = "—";
    if (state.schedule && state.schedule.schedule) {
      var weeks = asArray(state.schedule.schedule.weeklySchedule);
      var now = Math.floor(Date.now() / 1000);
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
          if (frs.indexOf(state.viewerFranchiseId) !== -1) {
            var other = frs.find(function (id) { return id !== state.viewerFranchiseId; });
            var opp = state.franchises.find(function (f) { return f.id === other; });
            if (opp) opponent = opp.name;
          }
        });
      }
    }

    el.innerHTML = [
      '<div class="tops-card-title">This Week</div>',
      '<div class="tops-matchup">',
      '  <div class="tops-matchup-week">Week ' + escapeHtml(week) + '</div>',
      '  <div class="tops-matchup-vs">vs <strong>' + escapeHtml(opponent) + '</strong></div>',
      '  <div class="tops-matchup-hint">Live score will appear here on game day</div>',
      '</div>'
    ].join("");
  }

  // ----- Card: Lineup stub -----
  function renderLineup() {
    var el = els.cards.lineup;
    if (!el) return;
    el.innerHTML = [
      '<div class="tops-card-title">Starting Lineup</div>',
      '<div class="tops-empty">Lineup card coming in Phase 1b — requires MFL <code>TYPE=lineup</code> franchise-auth handshake via the worker.</div>'
    ].join("");
  }

  // ----- Card: Roster -----
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
      return {
        id: String(r.id),
        pos: safeStr(p.position),
        name: safeStr(p.name) || r.id,
        team: safeStr(p.team),
        salary: Number(sal.salary || 0),
        status: r.status,
        isTaxi: /taxi/i.test(safeStr(r.status)),
        isIr: /ir/i.test(safeStr(r.status)),
        contract: safeStr(sal.contractInfo || sal.contractStatus),
        injuryBadge: injuryBadge
      };
    }).sort(function (a, b) {
      // Non-taxi first by salary desc, then taxi at the bottom (also salary desc).
      if (a.isTaxi !== b.isTaxi) return a.isTaxi ? 1 : -1;
      return b.salary - a.salary;
    });

    if (!rows.length) {
      el.innerHTML = '<div class="tops-card-title">My Roster</div><div class="tops-empty">No roster data loaded yet.</div>';
      return;
    }

    el.innerHTML = [
      '<div class="tops-card-title">My Roster <span class="tops-count">' + rows.length + '</span> <span class="tops-card-hint">tap a player for profile + news</span></div>',
      '<div class="tops-roster-table-wrap">',
      '<table class="tops-roster-table">',
      '  <thead><tr><th>Pos</th><th>Player</th><th>Team</th><th class="num">Salary</th><th>Contract</th><th>Status</th></tr></thead>',
      '  <tbody>',
      rows.map(function (r) {
        // Universal taxi pill — same convention as Draft Hub + Front Office.
        // Salary always rendered (even if 0) for taxi rows so the trade-value
        // math is visible.
        var taxiBadge = r.isTaxi ? '<span class="taxi-pill" title="Taxi squad — salary doesn\'t count vs cap, but real for trade math">TAXI</span>' : '';
        var statusLabel = r.isTaxi ? 'TAXI' : (r.isIr ? 'IR' : (r.status || 'ACTIVE'));
        var salaryCell = r.isTaxi
          ? '<span style="color:var(--warn,#fbbf24); opacity:0.9;">' + fmtUsd(r.salary) + '</span>'
          : (r.salary > 0 ? fmtUsd(r.salary) : '—');
        // data-pid powers the click → profile-modal handler below. tabindex+role
        // make the row keyboard-actionable (Enter/Space).
        return '<tr class="tops-roster-row' + (r.isTaxi ? ' is-taxi' : '') + '" data-pid="' + escapeHtml(r.id) + '" tabindex="0" role="button" aria-label="Open ' + escapeHtml(r.name) + ' profile">' +
          '<td><span class="tops-pos tops-pos-' + escapeHtml(r.pos) + '">' + escapeHtml(r.pos) + '</span></td>' +
          '<td>' + escapeHtml(r.name) + ' ' + r.injuryBadge + taxiBadge + '</td>' +
          '<td>' + escapeHtml(r.team) + '</td>' +
          '<td class="num">' + salaryCell + '</td>' +
          '<td>' + escapeHtml(r.contract) + '</td>' +
          '<td>' + escapeHtml(statusLabel) + '</td>' +
          '</tr>';
      }).join(""),
      '  </tbody>',
      '</table>',
      '</div>'
    ].join("");
    // Roster row click → MFL native player profile (new tab). Stopgap
    // until Front Office's 4-tab modal is extracted into a shared module.
    el.querySelectorAll(".tops-roster-row").forEach(function (tr) {
      tr.addEventListener("click", function () { openPlayerProfileModal(tr.getAttribute("data-pid")); });
      tr.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPlayerProfileModal(tr.getAttribute("data-pid")); }
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
    el.innerHTML = [
      '<div class="tops-card-title">Next Decision</div>',
      '<div class="tops-empty">Phase 1b will hydrate this with contract-eligibility + deadline math from CCC. Example preview:</div>',
      '<ul class="tops-bullets">',
      '  <li><strong>Extension window opens in 14 days</strong> — 3 eligible players on your roster.</li>',
      '  <li><strong>Tag deadline</strong> — 23 days. You have 1 tag available.</li>',
      '  <li><strong>Roster lock</strong> — ' + (daysUntil("2026-09-06") || "—") + ' days.</li>',
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

  function renderWhatChanged() {
    var el = els.cards.whatChanged;
    if (!el) return;
    var txns = (state.transactions && state.transactions.transactions && asArray(state.transactions.transactions.transaction)) || [];
    var mine = txns.filter(function (t) { return pad4(t.franchise) === state.viewerFranchiseId; }).slice(0, 6);
    if (!mine.length) {
      el.innerHTML = '<div class="tops-card-title">What Changed (14d)</div><div class="tops-empty">No transactions affecting your team in the last 14 days.</div>';
      return;
    }
    el.innerHTML = [
      '<div class="tops-card-title">What Changed (14d) <span class="tops-count">' + mine.length + '</span></div>',
      '<ul class="tops-changes">',
      mine.map(function (t) {
        var when = new Date(Number(t.timestamp || 0) * 1000);
        return '<li><span class="tops-change-type">' + escapeHtml(t.type || "TXN") + '</span>' +
               '<span class="tops-change-when">' + when.toLocaleDateString() + '</span></li>';
      }).join(""),
      '</ul>'
    ].join("");
  }

  // ----- MFL-parity cards (skeleton + real data where simple) -----
  function renderPendingTrades() {
    var el = els.cards.pendingTrades;
    if (!el) return;
    var trades = (state.pendingTrades && state.pendingTrades.pendingTrades && asArray(state.pendingTrades.pendingTrades.pendingTrade)) || [];
    var mine = trades.filter(function (t) {
      return pad4(t.offeredTo) === state.viewerFranchiseId || pad4(t.offeringFranchise) === state.viewerFranchiseId;
    });
    var bait = (state.tradeBait && state.tradeBait.tradeBaits && asArray(state.tradeBait.tradeBaits.tradeBait)) || [];
    var myBait = bait.filter(function (b) { return pad4(b.franchise_id) === state.viewerFranchiseId; });

    el.innerHTML = [
      '<div class="tops-card-title">Trades</div>',
      '<div class="tops-stat-row">',
      '  <div class="tops-stat"><span class="tops-stat-num">' + mine.length + '</span><span class="tops-stat-lbl">Pending</span></div>',
      '  <div class="tops-stat"><span class="tops-stat-num">' + myBait.length + '</span><span class="tops-stat-lbl">My Bait</span></div>',
      '</div>',
      '<a class="tops-link" href="//www.myfantasyleague.com/' + escapeHtml(state.ctx.year) + '/options?L=' + escapeHtml(state.ctx.leagueId) + '&O=05">Open Trade Room →</a>'
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

  function renderTransactions() {
    var el = els.cards.transactions;
    if (!el) return;
    var txns = (state.transactions && state.transactions.transactions && asArray(state.transactions.transactions.transaction)) || [];
    var mine = txns.filter(function (t) { return pad4(t.franchise) === state.viewerFranchiseId; }).slice(0, 10);
    el.innerHTML = [
      '<div class="tops-card-title">Recent Transactions <span class="tops-count">' + mine.length + '</span></div>',
      mine.length
        ? '<ul class="tops-txn-list">' + mine.map(function (t) {
            var when = new Date(Number(t.timestamp || 0) * 1000);
            return '<li><span class="tops-txn-type">' + escapeHtml(t.type || "") + '</span><span class="tops-txn-when">' + when.toLocaleDateString() + '</span></li>';
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

    el.innerHTML = [
      '<div class="tops-card-title">Future Draft Picks <span class="tops-count">' + items.length + '</span></div>',
      items.length
        ? '<ul class="tops-picks-list">' + items.slice(0, 10).map(function (p) {
            return '<li><strong>' + escapeHtml(p.year) + '</strong> Rd ' + escapeHtml(p.round) + (p.originalPickFor ? ' <span class="tops-pick-origin">(from ' + escapeHtml(p.originalPickFor) + ')</span>' : '') + '</li>';
          }).join("") + '</ul>'
        : '<div class="tops-empty">No future picks data available.</div>'
    ].join("");
  }

  function renderSchedule() {
    var el = els.cards.schedule;
    if (!el) return;
    var weeks = (state.schedule && state.schedule.schedule && asArray(state.schedule.schedule.weeklySchedule)) || [];
    var mine = weeks.map(function (w) {
      var matchups = asArray(w.matchup);
      var myMatch = matchups.find(function (m) {
        return asArray(m.franchise).some(function (f) { return pad4(f.id) === state.viewerFranchiseId; });
      });
      if (!myMatch) return null;
      var oppId = asArray(myMatch.franchise).map(function (f) { return pad4(f.id); }).find(function (id) { return id !== state.viewerFranchiseId; });
      var opp = state.franchises.find(function (f) { return f.id === oppId; });
      return { week: w.week, opp: opp ? opp.name : "—" };
    }).filter(Boolean).slice(0, 4);

    el.innerHTML = [
      '<div class="tops-card-title">Upcoming Schedule</div>',
      mine.length
        ? '<ul class="tops-sched-list">' + mine.map(function (w) {
            return '<li><span class="tops-sched-wk">Wk ' + escapeHtml(w.week) + '</span> vs ' + escapeHtml(w.opp) + '</li>';
          }).join("") + '</ul>'
        : '<div class="tops-empty">Schedule not yet published.</div>'
    ].join("");
  }

  function renderCalendar() {
    var el = els.cards.calendar;
    if (!el) return;
    el.innerHTML = [
      '<div class="tops-card-title">Deadlines &amp; Events</div>',
      '<ul class="tops-cal-list">',
      '  <li><span class="tops-cal-date">Sep 6, 2026</span><span class="tops-cal-lbl">Contract Lock</span></li>',
      '  <li><span class="tops-cal-date">TBD</span><span class="tops-cal-lbl">Tag Deadline</span></li>',
      '  <li><span class="tops-cal-date">TBD</span><span class="tops-cal-lbl">Rookie Draft</span></li>',
      '</ul>'
    ].join("");
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
    renderNews();
    renderNextDecision();
    // renderRiskHeatmap + renderCapTrajectory removed in v1.7.32 — were
    // placeholder cards. Functions kept below as no-ops in case anything
    // else still calls them; safe to delete in a future cleanup pass.
    renderWhatChanged();
    renderPendingTrades();
    renderWaivers();
    renderTransactions();
    renderFuturePicks();
    renderSchedule();
    renderCalendar();
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
    var yearRe = /(?:^|\|)\s*Y(\d+)\s*[=:]\s*([^|]+)/gi;
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
    var info = tops_parseContractInfo(sal && sal.contractInfo);
    var cy = parseInt(sal && sal.contractYear, 10) || 1;
    var earned = 0;
    for (var i = 1; i < cy; i++) {
      earned += info.yearVals[i] || 0;
    }
    return earned;
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
    // The master handles its own overlay; we just hand it the
    // Front Office context so the cap-math strip, transactions
    // lookup, and viewer-franchise filter all work. Fall through
    // to the legacy in-file implementation only if the master
    // script didn't load.
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
        if (el) el.innerHTML = '<div class="tops-empty" style="color:var(--tops-bad,#ff6b6b);">News fetch failed. Refresh to retry.</div>';
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
  function renderNews() {
    var el = els.cards.news;
    if (!el) return;
    var roster = getMyRoster();
    if (!roster.length) {
      el.innerHTML = '<div class="tops-card-title">News & Injuries</div><div class="tops-empty">No roster loaded.</div>';
      return;
    }

    // Always-on injuries panel (cheap — already loaded).
    var injs = (state.injuries && asArray(state.injuries.injuries && state.injuries.injuries.injury)) || [];
    var rosterIds = {};
    roster.forEach(function (r) { rosterIds[String(r.id)] = true; });
    var myInjs = injs.filter(function (i) { return rosterIds[String(i.id)]; });
    var injHtml = myInjs.length
      ? '<ul class="tops-news-list">' + myInjs.slice(0, 8).map(function (i) {
          var p = playerById(i.id) || {};
          var name = safeStr(p.name) || ("Player #" + i.id);
          return '<li class="tops-news-item" data-pid="' + escapeHtml(String(i.id)) + '">' +
            '<div class="tops-news-row1">' +
              '<span class="tops-inj tops-inj-' + escapeHtml(i.status || "?") + '">' + escapeHtml(i.status || "?") + '</span> ' +
              '<span class="tops-news-player">' + escapeHtml(name) + '</span>' +
            '</div>' +
            (i.details ? '<div class="tops-news-body">' + escapeHtml(i.details) + '</div>' : '') +
            '</li>';
        }).join("") + '</ul>'
      : '<div class="tops-empty" style="font-size:11px; padding:6px 0;">No injury designations on your roster.</div>';

    // News feed section — three states: idle (button), loading, loaded.
    // Uses /api/player-news (single batched call for the whole roster) which
    // joins Sleeper structured info (injury/depth/practice) with ESPN team
    // articles fuzzy-matched by last name. Cached on the worker edge.
    var newsSectionHtml;
    if (state.teamNewsLoading) {
      newsSectionHtml = '<div class="tops-empty">Loading news for ' + roster.length + ' players… (one batch call, then cached)</div>';
    } else if (state.teamNewsItems) {
      var top = state.teamNewsItems.slice(0, 12);
      newsSectionHtml = top.length
        ? '<ul class="tops-news-list">' + top.map(function (n) {
            var when = n.when ? new Date(n.when * 1000).toLocaleDateString() : "";
            var pid = String(n.pid);
            var typeBadge = n.type === "status" ? '<span class="tops-news-type-badge is-status">INJURY</span>'
                         : n.type === "depth" ? '<span class="tops-news-type-badge is-depth">DEPTH</span>'
                         : '';
            return '<li class="tops-news-item" data-pid="' + escapeHtml(pid) + '">' +
              '<div class="tops-news-row1">' +
                typeBadge +
                '<span class="tops-news-player">' + escapeHtml(n.player) + '</span>' +
                (n.position ? '<span class="tops-news-pos">' + escapeHtml(n.position) + '</span>' : '') +
                (when ? '<span class="tops-news-when">' + escapeHtml(when) + '</span>' : '') +
              '</div>' +
              (n.headline ? '<div class="tops-news-head">' + escapeHtml(n.headline) + '</div>' : '') +
              (n.body ? '<div class="tops-news-body">' + escapeHtml(n.body.slice(0, 220)) + (n.body.length > 220 ? '…' : '') + '</div>' : '') +
              '</li>';
          }).join("") + '</ul>'
        : '<div class="tops-empty" style="font-size:11px; padding:6px 0;">No recent news / injury notes on your roster.</div>';
    } else {
      newsSectionHtml = '<button id="topsLoadNews" class="tops-link-pill" style="cursor:pointer; border:none; font-size:12px; margin-top:6px;">Load news feed (' + roster.length + ' players)</button>';
    }

    el.innerHTML = [
      '<div class="tops-card-title">News & Injuries' +
        (myInjs.length ? ' <span class="tops-count">' + myInjs.length + '</span>' : '') +
      '</div>',
      injHtml,
      '<div class="tops-news-divider"></div>',
      '<div class="tops-news-section-title">Latest Headlines</div>',
      newsSectionHtml
    ].join("");

    // Wire the load-news button — single batched /api/player-news call
    // for the whole roster. Worker fans out to Sleeper + ESPN per-team
    // and dedupes per pid.
    var loadBtn = document.getElementById("topsLoadNews");
    if (loadBtn) {
      loadBtn.addEventListener("click", function () {
        state.teamNewsLoading = true;
        renderNews();
        var pids = roster.map(function (r) { return r.id; }).filter(Boolean);
        var url = workerUrl("/api/player-news?L=" + encodeURIComponent(state.ctx.leagueId) +
                            "&YEAR=" + encodeURIComponent(state.ctx.year) +
                            "&pids=" + encodeURIComponent(pids.join(",")));
        fetch(url, { cache: "no-store" })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (data) {
            var items = [];
            var byPid = (data && data.items_by_pid) || {};
            Object.keys(byPid).forEach(function (pid) {
              var pInfo = playerById(pid) || {};
              (byPid[pid] || []).forEach(function (n) {
                items.push({
                  pid: pid,
                  player: safeStr(pInfo.name) || ("Player #" + pid),
                  position: safeStr(pInfo.position),
                  team: safeStr(pInfo.team),
                  when: Number(n.timestamp || 0),
                  headline: safeStr(n.headline),
                  body: safeStr(n.body),
                  source: safeStr(n.source),
                  type: safeStr(n.type),
                });
              });
            });
            items.sort(function (a, b) { return b.when - a.when; });
            state.teamNewsItems = items;
            state.teamNewsLoading = false;
            renderNews();
          })
          .catch(function () {
            state.teamNewsLoading = false;
            state.teamNewsItems = [];
            renderNews();
          });
      });
    }
    // Item clicks → MFL native player profile (until Front Office's
    // 4-tab modal is properly extracted into a shared module).
    el.querySelectorAll(".tops-news-item").forEach(function (li) {
      li.addEventListener("click", function () { openPlayerProfileModal(li.getAttribute("data-pid")); });
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
      ? '<div class="tops-empty" style="margin-top:8px; color:var(--tops-bad,#ff6b6b);">' +
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
