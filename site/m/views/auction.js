/* League → Auction view — ERA + FAA tabs (best-in-class redesign).
 *
 * Two inner tabs (FAA · ERA) + Cadence, each fed by the rich live payload
 * (/acquisition-hub/{free-agent,expired-rookie}-auction/live → buildAuctionLivePayload):
 *   FAA: active lots + team budgets + roster needs + available pool + search
 *   ERA: active lots + eligible pool (current team) + search
 * Live board + in-app Bid/Nominate (reusing the Phase 1 bid sheet) only when the
 * commish switch is on (payload.enabled) AND in-app bidding is on; otherwise the
 * pool renders read-only under a "not running" banner. Amounts in the payload are
 * DOLLARS (the O=43 scrape / cap math); the bid sheet takes $K and sends ×1000.
 *
 * Cadence (nomination windows) stays on its own tab from /api/auction/nomination-status.
 */
(function () {
  "use strict";
  if (!window.UPS_MOBILE) return;
  var M = window.UPS_MOBILE;
  var U = M.util;

  // tab: "faa" | "era" | "cadence". search: per-pool filter text.
  var state = { faa: null, era: null, nom: null, loading: false, error: null, loadedFor: "", tab: "", search: "" };

  function subTabs(active) {
    function tab(href, label, key) {
      return '<a class="ups-m-subtab' + (key === active ? ' active' : '') +
             '" href="#league/' + href + '">' + label + '</a>';
    }
    return '<div class="ups-m-subtabs">' +
      tab("standings", "Standings", "standings") +
      tab("rosters", "Rosters", "rosters") +
      tab("trade", "Trade", "trade") +
      tab("otb", "On the Block", "otb") +
      tab("draft", "Draft", "draft") +
      tab("auction", "Auction", "auction") +
      '</div>';
  }

  function franchiseName(fid) {
    if (!fid) return "—";
    var f = (M.state.franchises || []).find(function (x) { return x.id === U.pad4(fid); });
    return f ? f.name : ("Team " + U.pad4(fid));
  }

  // O=43 deep-link (the always-available fallback).
  function mflAuctionUrl(pid) {
    var viewerFid = M.state.viewerFranchiseId || "0000";
    var season = M.state.ctx.year;
    return "https://www48.myfantasyleague.com/" + encodeURIComponent(season) +
      "/options?LEAGUE_ID=" + encodeURIComponent(M.state.ctx.leagueId) +
      "&FRANCHISE=" + encodeURIComponent(viewerFid) +
      "&O=43&PLAYER_ID=" + encodeURIComponent(pid);
  }

  function toNum(v) { var n = Number(String(v == null ? "" : v).replace(/[^0-9.\-]/g, "")); return isFinite(n) ? n : 0; }
  function usd(v) { var n = toNum(v); return n > 0 ? "$" + Math.round(n).toLocaleString() : "—"; }
  function usdK(v) { var n = toNum(v); return n > 0 ? "$" + Math.round(n / 1000) + "k" : "—"; }   // compact for tables
  // Scraped high-bid value may already be "$5,000" or a bare number.
  function money(v) {
    if (v == null || v === "") return "—";
    var s = String(v);
    if (/\$/.test(s)) return U.escapeHtml(s);
    var n = toNum(s);
    return n > 0 ? "$" + Math.round(n).toLocaleString() : U.escapeHtml(s);
  }
  function fmtK(k) { var n = Number(k); if (!isFinite(n) || n <= 0) return "—"; var t = Math.round(n * 10) / 10; return "$" + String(t).replace(/\.0$/, "") + "K"; }
  function countdown(secs) {
    var s = Math.max(0, Number(secs) || 0);
    if (s <= 0) return "Locked";
    var d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60);
    if (d > 0) return d + "d " + h + "h";
    if (h > 0) return h + "h " + m + "m";
    return m + "m";
  }
  function posChip(pos) { return '<span class="ups-m-auc-pos">' + U.escapeHtml(String(pos || "").toUpperCase() || "—") + '</span>'; }

  // ── In-app bid / nominate sheet (reused from Phase 1) ────────────────
  function postAuction(action, payload) {
    var url = M.api.workerUrl("/api/auction/" + action +
      "?L=" + encodeURIComponent(M.state.ctx.leagueId) +
      "&YEAR=" + encodeURIComponent(M.state.ctx.year));
    var stored = M.api.getStoredMflUserId && M.api.getStoredMflUserId();
    if (stored) url += "&MFL_USER_ID=" + encodeURIComponent(stored);
    return fetch(url, {
      method: "POST", mode: "cors", credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {})
    }).then(function (r) {
      return r.text().then(function (t) {
        var p = null; try { p = t ? JSON.parse(t) : null; } catch (e) {}
        return { status: r.status, ok: r.ok, body: p || {} };
      });
    });
  }
  function closeBidSheet() {
    var ov = document.getElementById("ups-m-auc-bid-overlay");
    if (ov) ov.remove();
    document.body.style.overflow = "";
  }
  // opts: { action, player_id, player_name, auction_type, high_k }
  function openBidSheet(opts) {
    if (!M.state.viewerFranchiseId) { M.ui.showToast("Pick your franchise first.", "err"); return; }
    var isNom = opts.action === "nominate";
    var highK = Number(opts.high_k) || 0;
    var minK = isNom ? 1 : highK + 1;
    var deepLink = mflAuctionUrl(opts.player_id);
    closeBidSheet();
    var html =
      '<div class="ups-m-drop-overlay" id="ups-m-auc-bid-overlay">' +
        '<div class="ups-m-drop-sheet ups-m-auc-bid-sheet">' +
          '<div class="ups-m-drop-head">' +
            '<button class="ups-m-drop-close" id="ups-m-auc-bid-close" aria-label="Close">×</button>' +
            '<div class="grip"></div>' +
            '<div class="title">' + (isNom ? "Nominate" : "Bid") + ' — ' + U.escapeHtml(opts.player_name || ("Player #" + opts.player_id)) + '</div>' +
            '<div class="sub">' + (highK > 0 ? "High " + fmtK(highK) : (isNom ? "Starting bid " + fmtK(1) : "")) + '</div>' +
          '</div>' +
          '<div class="ups-m-drop-body">' +
            '<label class="ups-m-auc-bid-lbl">Your ' + (isNom ? "nominating" : "max") + ' bid ($K)</label>' +
            '<div class="ups-m-auc-bid-input">' +
              '<button type="button" class="ups-m-auc-step" data-step="-1" aria-label="Lower">−</button>' +
              '<input type="number" id="ups-m-auc-bid-amt" min="' + minK + '" step="1" inputmode="numeric" value="' + minK + '" />' +
              '<button type="button" class="ups-m-auc-step" data-step="1" aria-label="Raise">+</button>' +
            '</div>' +
            '<div class="ups-m-auc-bid-note">Submitted to MFL on your behalf, then confirmed by re-reading the board.</div>' +
            '<div class="ups-m-auc-bid-err" id="ups-m-auc-bid-err"></div>' +
          '</div>' +
          '<div class="ups-m-auc-bid-foot">' +
            '<a class="btn-act" href="' + deepLink + '" target="_blank" rel="noopener">On MFL ↗</a>' +
            '<button type="button" class="btn-act otb on" id="ups-m-auc-bid-submit">' + (isNom ? "Nominate" : "Place bid") + '</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    var mount = document.getElementById("ups-m-app");
    if (!mount) return;
    mount.insertAdjacentHTML("beforeend", html);
    document.body.style.overflow = "hidden";
    var amt = document.getElementById("ups-m-auc-bid-amt");
    document.getElementById("ups-m-auc-bid-close").addEventListener("click", closeBidSheet);
    Array.prototype.forEach.call(document.querySelectorAll("#ups-m-auc-bid-overlay .ups-m-auc-step"), function (b) {
      b.addEventListener("click", function () {
        var step = parseInt(this.getAttribute("data-step"), 10) || 0;
        amt.value = String(Math.max(minK, (parseInt(amt.value, 10) || minK) + step));
      });
    });
    document.getElementById("ups-m-auc-bid-submit").addEventListener("click", function () { submitBid(opts, this, minK); });
  }
  function submitBid(opts, btn, minK) {
    var amt = document.getElementById("ups-m-auc-bid-amt");
    var errEl = document.getElementById("ups-m-auc-bid-err");
    var amountK = parseInt(amt && amt.value, 10) || 0;
    if (amountK < minK) { if (errEl) errEl.textContent = "Bid must be at least " + fmtK(minK) + "."; return; }
    if (errEl) errEl.textContent = "";
    var label = opts.action === "nominate" ? "Nominate" : "Place bid";
    btn.disabled = true; btn.textContent = "Submitting…";
    M.ui.showToast((opts.action === "nominate" ? "Nominating" : "Bidding") + " " + fmtK(amountK) + "…", "info");
    postAuction(opts.action, {
      player_id: String(opts.player_id),
      amount: amountK * 1000,            // $K → dollars (MFL form unit)
      franchise_id: M.state.viewerFranchiseId,
      auction_type: opts.auction_type || "free-agent"
    }).then(function (resp) {
      if (resp.status === 503) {            // auction off / in-app off → fall back to MFL
        M.ui.showToast((resp.body && resp.body.message) || "Use MFL's auction page.", "info");
        window.open((resp.body && resp.body.native_link) || mflAuctionUrl(opts.player_id), "_blank", "noopener");
        closeBidSheet();
        return;
      }
      if (resp.ok && resp.body && resp.body.ok) {
        M.ui.showToast((opts.action === "nominate" ? "Nominated" : "Bid placed") + " ✓", "ok");
        closeBidSheet();
        state.loadedFor = ""; load().then(paint);   // re-read → verified board
      } else {
        var msg = (resp.body && (resp.body.message || resp.body.error)) || ("HTTP " + resp.status);
        if (errEl) errEl.textContent = msg;
        M.ui.showToast("Failed: " + msg, "err");
        btn.disabled = false; btn.textContent = label;
      }
    }).catch(function (e) {
      var msg = (e && e.message) || String(e);
      if (errEl) errEl.textContent = msg;
      M.ui.showToast("Failed: " + msg, "err");
      btn.disabled = false; btn.textContent = label;
    });
  }

  // ── Data load (per view-open): both /live payloads + the cadence ────
  function liveUrl(kind) {
    var ctx = M.state.ctx;
    var url = M.api.workerUrl("/acquisition-hub/" + kind + "/live?L=" + encodeURIComponent(ctx.leagueId) + "&YEAR=" + encodeURIComponent(ctx.year));
    if (M.state.viewerFranchiseId) url += "&F=" + encodeURIComponent(M.state.viewerFranchiseId);
    var stored = M.api.getStoredMflUserId && M.api.getStoredMflUserId();
    if (stored) url += "&MFL_USER_ID=" + encodeURIComponent(stored);
    return url;
  }
  function load() {
    var ctx = M.state.ctx;
    var key = ctx.leagueId + ":" + ctx.year + ":" + (M.state.viewerFranchiseId || "");
    if (state.loadedFor === key && (state.faa || state.era)) return Promise.resolve();
    state.loading = true; state.error = null; state.loadedFor = key;
    var L = encodeURIComponent(ctx.leagueId), Y = encodeURIComponent(ctx.year);
    var get = function (url) { return M.api.fetchJson(url).catch(function () { return null; }); };
    return Promise.all([
      get(liveUrl("free-agent-auction")),
      get(liveUrl("expired-rookie-auction")),
      get(M.api.workerUrl("/api/auction/nomination-status?L=" + L + "&YEAR=" + Y))
    ]).then(function (res) {
      state.faa = res[0] || { ok: false };
      state.era = res[1] || { ok: false };
      state.nom = res[2] || { franchises: [] };
      // Default tab: whichever auction is live, else FAA.
      if (!state.tab) {
        state.tab = (state.era && state.era.enabled && !(state.faa && state.faa.enabled)) ? "era" : "faa";
      }
      state.loading = false;
    }).catch(function (e) {
      state.loading = false; state.error = String((e && e.message) || e);
    });
  }

  // ── Render ──────────────────────────────────────────────────────────
  function render(mount) {
    mount.innerHTML = subTabs("auction") +
      '<div class="ups-m-auction" id="ups-m-auction-body"><div class="ups-m-loading">Loading auction…</div></div>';
    load().then(paint);
  }
  function paint() {
    var body = document.getElementById("ups-m-auction-body");
    if (!body) return;
    if (state.error) {
      body.innerHTML = '<div class="ups-m-sheet-empty">Auction failed to load: ' + U.escapeHtml(state.error) + '</div>';
      return;
    }
    body.innerHTML = innerTabs() +
      '<div class="ups-m-auc-tabbody">' +
        (state.tab === "era" ? renderEra() : state.tab === "cadence" ? renderCadence() : renderFaa()) +
      '</div>';
    wireTabs();
    wireSearch();
    wireBidButtons();
  }
  function innerTabs() {
    function live(p) { return p && p.enabled ? ' <span class="ups-m-auc-live">● live</span>' : ''; }
    function tab(key, label, extra) {
      return '<button type="button" class="ups-m-auc-itab' + (state.tab === key ? ' active' : '') + '" data-itab="' + key + '">' + label + (extra || '') + '</button>';
    }
    return '<div class="ups-m-auc-itabs">' +
      tab("faa", "FA Auction", live(state.faa)) +
      tab("era", "Expired Rookie", live(state.era)) +
      tab("cadence", "Cadence", "") +
      '</div>';
  }

  function banner(p, name, when) {
    if (p && p.enabled) return '';
    return '<div class="ups-m-auc-banner"><strong>' + name + ' isn\'t running right now.</strong> ' +
      (when ? when + ' ' : '') + 'Browse the pool below; bidding opens when the commish flips it on.</div>';
  }

  // Active-lot card list (live board) with in-app Bid when enabled.
  function lotsBlock(p, kind, lockLabel) {
    var rows = (p && p.active_auctions) || [];
    var html = '<div class="ups-m-auc-sec-head">Live Lots <span class="ct">' + rows.length + '</span>' +
      (lockLabel ? ' <span class="ups-m-auc-lock">' + lockLabel + '</span>' : '') + '</div>';
    if (!rows.length) { return html + '<div class="ups-m-auc-empty">No open lots right now.</div>'; }
    html += rows.map(function (r) {
      var highK = Math.round(toNum(r.high_bid_amount) / 1000);
      var canBid = !!(p && p.enabled);
      var cta = canBid
        ? '<button type="button" class="btn-act myac ups-m-auc-bid-btn" data-action="bid" data-pid="' + U.escapeHtml(String(r.player_id || "")) +
            '" data-name="' + U.escapeHtml(r.player_name || "") + '" data-kind="' + kind + '" data-high="' + highK + '">Bid</button>' +
          '<a class="ups-m-auc-mfl" href="' + mflAuctionUrl(r.player_id) + '" target="_blank" rel="noopener" title="Bid on MFL">↗</a>'
        : '<a class="ups-m-auc-mfl" href="' + mflAuctionUrl(r.player_id) + '" target="_blank" rel="noopener" title="Open on MFL">↗</a>';
      return '<div class="ups-m-auc-card">' +
        '<div class="ups-m-auc-card-main">' +
          '<div class="ups-m-auc-name">' + posChip(r.position) + U.escapeHtml(r.player_name || ("Player #" + r.player_id)) + '</div>' +
          '<div class="ups-m-auc-meta">High <strong>' + money(r.high_bid_amount) + '</strong>' +
            (r.high_bidder_label ? ' · ' + U.escapeHtml(r.high_bidder_label) : '') +
            (r.timer_text ? ' · ' + U.escapeHtml(r.timer_text) : '') + '</div>' +
        '</div>' +
        '<div class="ups-m-auc-card-cta">' + cta + '</div>' +
      '</div>';
    }).join("");
    return html;
  }

  // Pool list (eligible/available) with search + Nominate (when enabled).
  function poolBlock(rows, kind, cfg) {
    var s = (state.search || "").toLowerCase();
    var filtered = rows.filter(function (r) {
      if (!s) return true;
      return [r.player_name, r.position, cfg.teamKey ? r[cfg.teamKey] : "", r.player_id].join(" ").toLowerCase().indexOf(s) !== -1;
    });
    var canNom = !!(cfg.enabled);
    var html = '<div class="ups-m-auc-sec-head">' + cfg.title + ' <span class="ct">' + rows.length + '</span></div>' +
      '<input type="search" class="ups-m-auc-search" id="ups-m-auc-search" placeholder="Search ' + cfg.title.toLowerCase() + '…" value="' + U.escapeHtml(state.search || "") + '" />' +
      '<div class="ups-m-auc-pool" id="ups-m-auc-pool">';
    if (!filtered.length) { html += '<div class="ups-m-auc-empty">' + (s ? "No players match your search." : "No players in the pool yet — check back when the auction nears.") + '</div>'; }
    else html += filtered.slice(0, 80).map(function (r) {
      var sub = cfg.subOf(r);
      var cta = canNom
        ? '<button type="button" class="btn-act myac ups-m-auc-bid-btn" data-action="nominate" data-pid="' + U.escapeHtml(String(r.player_id || "")) +
            '" data-name="' + U.escapeHtml(r.player_name || "") + '" data-kind="' + kind + '" data-high="0">Nominate</button>'
        : '<a class="ups-m-auc-mfl" href="' + mflAuctionUrl(r.player_id) + '" target="_blank" rel="noopener" title="Open on MFL">↗</a>';
      return '<div class="ups-m-auc-card">' +
        '<div class="ups-m-auc-card-main">' +
          '<div class="ups-m-auc-name">' + posChip(r.position) + U.escapeHtml(r.player_name || ("Player #" + r.player_id)) +
            (r.nfl_team || r.team ? ' <span class="ups-m-auc-team">' + U.escapeHtml(r.nfl_team || r.team) + '</span>' : '') + '</div>' +
          (sub ? '<div class="ups-m-auc-meta">' + sub + '</div>' : '') +
        '</div>' +
        '<div class="ups-m-auc-card-cta">' + cta + '</div>' +
      '</div>';
    }).join("");
    html += '</div>';
    return html;
  }

  function kpis(items) {
    return '<div class="ups-m-auc-kpis">' + items.map(function (it) {
      return '<div class="ups-m-auc-kpi"><span class="lbl">' + U.escapeHtml(it[0]) + '</span><strong>' + U.escapeHtml(String(it[1])) + '</strong></div>';
    }).join("") + '</div>';
  }

  function renderFaa() {
    var p = state.faa || {};
    if (p.ok === false) return '<div class="ups-m-auc-empty">FAA board unavailable right now.</div>';
    var avail = p.available_players || [];
    return banner(p, "The FA Auction", "Opens the last weekend of July.") +
      kpis([["Live lots", (p.active_auctions || []).length], ["Available", avail.length], ["Your team", franchiseName(M.state.viewerFranchiseId)]]) +
      lotsBlock(p, "free-agent", "24h lock") +
      budgetsBlock(p) +
      needsBlock(p) +
      poolBlock(avail, "free-agent", {
        title: "Available Players", enabled: !!p.enabled, teamKey: "team",
        subOf: function (r) { return r.upcoming_auction_value ? 'Model ' + usd(r.upcoming_auction_value) : ''; }
      });
  }

  function renderEra() {
    var p = state.era || {};
    if (p.ok === false) return '<div class="ups-m-auc-empty">ERA board unavailable right now.</div>';
    var pool = p.eligible_players || [];
    return banner(p, "The Expired-Rookie Auction", "Runs Memorial Day weekend.") +
      kpis([["Live lots", (p.active_auctions || []).length], ["Eligible", pool.length], ["Markers", (p.extension_markers || []).length]]) +
      lotsBlock(p, "expired-rookie", "36h lock") +
      poolBlock(pool, "expired-rookie", {
        title: "Eligible Pool", enabled: !!p.enabled, teamKey: "franchise_name",
        subOf: function (r) { return r.franchise_name ? 'On ' + U.escapeHtml(r.franchise_name) : ''; }
      });
  }

  function budgetsBlock(p) {
    var rows = (p && p.team_budget_rows) || [];
    if (!rows.length) return '';
    var viewerFid = U.pad4(M.state.viewerFranchiseId);
    rows = rows.slice().sort(function (a, b) { return (U.pad4(a.franchise_id) === viewerFid ? 0 : 1) - (U.pad4(b.franchise_id) === viewerFid ? 0 : 1); });
    return '<div class="ups-m-auc-sec-head">Team Budgets <span class="ct">max legal bid</span></div>' +
      '<div class="ups-m-auc-table">' +
        '<div class="ups-m-auc-trow head"><span>Team</span><span>Funds</span><span>@27</span><span>@35</span></div>' +
        rows.map(function (r) {
          return '<div class="ups-m-auc-trow' + (U.pad4(r.franchise_id) === viewerFid ? ' me' : '') + '">' +
            '<span class="tn">' + U.escapeHtml(r.franchise_name || franchiseName(r.franchise_id)) + '</span>' +
            '<span>' + usdK(r.available_funds_dollars) + '</span>' +
            '<span>' + usdK(r.scenario_27_max_bid) + '</span>' +
            '<span>' + usdK(r.scenario_35_max_bid) + '</span>' +
          '</div>';
        }).join("") +
      '</div>';
  }
  function needsBlock(p) {
    var rows = (p && p.team_need_rows) || [];
    if (!rows.length) return '';
    var viewerFid = U.pad4(M.state.viewerFranchiseId);
    rows = rows.slice().sort(function (a, b) { return (U.pad4(a.franchise_id) === viewerFid ? 0 : 1) - (U.pad4(b.franchise_id) === viewerFid ? 0 : 1); });
    return '<div class="ups-m-auc-sec-head">Roster Needs <span class="ct">lineup deficits</span></div>' +
      '<div class="ups-m-auc-table">' +
        '<div class="ups-m-auc-trow head"><span>Team</span><span>Roster</span><span>Need</span><span>Deficits</span></div>' +
        rows.map(function (r) {
          var d = r.lineup_deficits || {};
          var txt = Object.keys(d).filter(function (k) { return d[k]; }).map(function (k) { return k + ":" + d[k]; }).join(" ") || "Ready";
          return '<div class="ups-m-auc-trow' + (U.pad4(r.franchise_id) === viewerFid ? ' me' : '') + '">' +
            '<span class="tn">' + U.escapeHtml(r.franchise_name || franchiseName(r.franchise_id)) + '</span>' +
            '<span>' + (Number(r.roster_count) || 0) + '</span>' +
            '<span>' + (Number(r.total_deficit) || 0) + '</span>' +
            '<span class="def">' + U.escapeHtml(txt) + '</span>' +
          '</div>';
        }).join("") +
      '</div>';
  }

  function renderCadence() {
    var rows = (state.nom && state.nom.franchises) || [];
    if (!rows.length) return '<div class="ups-m-auc-empty">No nomination data right now.</div>';
    var viewerFid = U.pad4(M.state.viewerFranchiseId);
    function rowFid(f) { return U.pad4(f.fid || f.id || f.franchise_id); }
    rows = rows.slice().sort(function (a, b) { return (rowFid(a) === viewerFid ? 0 : 1) - (rowFid(b) === viewerFid ? 0 : 1); });
    return '<div class="ups-m-auc-sec-head">Nomination Cadence</div>' +
      '<div class="ups-m-auc-nom">' + rows.map(function (f) {
        var fid = rowFid(f), era = f.era || {}, fa = f.fa_auction || {};
        var eraStatus = era.can_nominate_now ? '<span class="rdy">Can nominate</span>'
          : (era.window_open === false && era.window_reason === "after_close") ? '<span class="cd">Closed</span>'
          : '<span class="cd">Next ' + countdown(era.seconds_until_next) + '</span>';
        var faStatus = fa.can_nominate_now
          ? '<span class="rdy">' + (fa.remaining != null ? fa.remaining : "?") + ' of ' + (fa.max_in_window != null ? fa.max_in_window : "?") + ' left</span>'
          : '<span class="cd">Next ' + countdown(fa.seconds_until_next) + '</span>';
        return '<div class="ups-m-auc-nom-row' + (fid === viewerFid ? ' me' : '') + '">' +
          '<div class="fn">' + U.escapeHtml(f.franchise_name || f.name || franchiseName(fid)) + (fid === viewerFid ? ' <span class="you">you</span>' : '') + '</div>' +
          '<div class="ns"><span class="lbl">ERA</span> ' + eraStatus + '</div>' +
          '<div class="ns"><span class="lbl">FA</span> ' + faStatus + '</div>' +
        '</div>';
      }).join("") + '</div>';
  }

  // ── Wiring ──────────────────────────────────────────────────────────
  function wireTabs() {
    Array.prototype.forEach.call(document.querySelectorAll(".ups-m-auc-itab"), function (b) {
      b.addEventListener("click", function () {
        var t = this.getAttribute("data-itab");
        if (t === state.tab) return;
        state.tab = t; state.search = "";
        paint();
      });
    });
  }
  function wireSearch() {
    var inp = document.getElementById("ups-m-auc-search");
    if (!inp) return;
    inp.addEventListener("input", function () {
      state.search = this.value || "";
      // Re-render just the pool list (preserve the input + focus).
      var pool = document.getElementById("ups-m-auc-pool");
      if (!pool) { paint(); return; }
      var fresh = (state.tab === "era")
        ? poolBlock((state.era && state.era.eligible_players) || [], "expired-rookie", { title: "Eligible Pool", enabled: !!(state.era && state.era.enabled), teamKey: "franchise_name", subOf: function (r) { return r.franchise_name ? 'On ' + U.escapeHtml(r.franchise_name) : ''; } })
        : poolBlock((state.faa && state.faa.available_players) || [], "free-agent", { title: "Available Players", enabled: !!(state.faa && state.faa.enabled), teamKey: "team", subOf: function (r) { return r.upcoming_auction_value ? 'Model ' + usd(r.upcoming_auction_value) : ''; } });
      var tmp = document.createElement("div"); tmp.innerHTML = fresh;
      var newPool = tmp.querySelector("#ups-m-auc-pool");
      if (newPool && pool.parentNode) { pool.parentNode.replaceChild(newPool, pool); wireBidButtons(); }
    });
  }
  function wireBidButtons() {
    Array.prototype.forEach.call(document.querySelectorAll(".ups-m-auc-bid-btn"), function (b) {
      if (b.__wired) return; b.__wired = true;
      b.addEventListener("click", function () {
        openBidSheet({
          action: b.getAttribute("data-action"),
          player_id: b.getAttribute("data-pid"),
          player_name: b.getAttribute("data-name"),
          auction_type: b.getAttribute("data-kind"),
          high_k: Number(b.getAttribute("data-high")) || 0
        });
      });
    });
  }

  M.auctionView = { render: render };
})();
