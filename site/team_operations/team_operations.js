(function () {
  "use strict";

  var BUILD = "2026.04.18.01";
  var BOOT_FLAG = "__ups_team_operations_boot_" + BUILD;
  if (window[BOOT_FLAG]) {
    if (typeof window.UPS_TEAMOPS_INIT === "function") window.UPS_TEAMOPS_INIT();
    return;
  }
  window[BOOT_FLAG] = true;

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
    lastLoaded: null
  };

  var els = {};

  // ---------- MFL API ----------

  function mflHost() {
    return "https://api.myfantasyleague.com";
  }

  function mflExportUrl(type, extra) {
    var ctx = state.ctx || {};
    var url = mflHost() + "/" + encodeURIComponent(ctx.year) + "/export?TYPE=" + encodeURIComponent(type) + "&L=" + encodeURIComponent(ctx.leagueId) + "&JSON=1";
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
    var opts = { credentials: "include", mode: "cors" };
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
      '    <section data-card="riskHeatmap" class="tops-card"></section>',
      '    <section data-card="capTrajectory" class="tops-card tops-card-wide"></section>',
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
    var used = salaries.reduce(function (s, p) { return s + p.salary; }, 0);
    var cap = state.capAmount;
    var remain = cap - used;
    var pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;

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
      '    <div class="tops-kv-value">' + fmtUsd(used) + '</div>',
      '    <div class="tops-kv-note">' + pct + '% of ' + fmtUsd(cap) + '</div>',
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
        pos: safeStr(p.position),
        name: safeStr(p.name) || r.id,
        team: safeStr(p.team),
        salary: Number(sal.salary || 0),
        status: r.status,
        contract: safeStr(sal.contractInfo || sal.contractStatus),
        injuryBadge: injuryBadge
      };
    }).sort(function (a, b) { return b.salary - a.salary; });

    if (!rows.length) {
      el.innerHTML = '<div class="tops-card-title">My Roster</div><div class="tops-empty">No roster data loaded yet.</div>';
      return;
    }

    el.innerHTML = [
      '<div class="tops-card-title">My Roster <span class="tops-count">' + rows.length + '</span></div>',
      '<div class="tops-roster-table-wrap">',
      '<table class="tops-roster-table">',
      '  <thead><tr><th>Pos</th><th>Player</th><th>Team</th><th class="num">Salary</th><th>Contract</th><th>Status</th></tr></thead>',
      '  <tbody>',
      rows.map(function (r) {
        return '<tr>' +
          '<td><span class="tops-pos tops-pos-' + escapeHtml(r.pos) + '">' + escapeHtml(r.pos) + '</span></td>' +
          '<td>' + escapeHtml(r.name) + ' ' + r.injuryBadge + '</td>' +
          '<td>' + escapeHtml(r.team) + '</td>' +
          '<td class="num">' + fmtUsd(r.salary) + '</td>' +
          '<td>' + escapeHtml(r.contract) + '</td>' +
          '<td>' + escapeHtml(r.status || 'ACTIVE') + '</td>' +
          '</tr>';
      }).join(""),
      '  </tbody>',
      '</table>',
      '</div>'
    ].join("");
  }

  // ----- Card: News (skeleton) -----
  function renderNews() {
    var el = els.cards.news;
    if (!el) return;
    var inj = (state.injuries && asArray(state.injuries.injuries && state.injuries.injuries.injury)) || [];
    var mine = getMyRoster();
    var mineIds = {};
    mine.forEach(function (p) { mineIds[p.id] = true; });
    var myInj = inj.filter(function (i) { return mineIds[String(i.id)]; });

    var items = myInj.slice(0, 8).map(function (i) {
      var p = playerById(i.id) || {};
      return '<li class="tops-news-item">' +
        '<span class="tops-inj tops-inj-' + escapeHtml(i.status || "?") + '">' + escapeHtml(i.status || "?") + '</span> ' +
        '<strong>' + escapeHtml(p.name || i.id) + '</strong> — ' + escapeHtml(i.details || "") +
        '</li>';
    }).join("");

    el.innerHTML = [
      '<div class="tops-card-title">News &amp; Injuries <span class="tops-count">' + myInj.length + '</span></div>',
      myInj.length ? '<ul class="tops-news-list">' + items + '</ul>'
        : '<div class="tops-empty">No injury designations on your roster. Full news feed ships in Phase 2 (Sleeper integration).</div>'
    ].join("");
  }

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
    renderSummary();
    renderMatchup();
    renderLineup();
    renderRoster();
    renderNews();
    renderNextDecision();
    renderRiskHeatmap();
    renderCapTrajectory();
    renderWhatChanged();
    renderPendingTrades();
    renderWaivers();
    renderTransactions();
    renderFuturePicks();
    renderSchedule();
    renderCalendar();
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
