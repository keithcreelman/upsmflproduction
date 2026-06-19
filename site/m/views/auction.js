/* League → Auction view (mobile mirror of site/auction/auction_hub.js).
 *
 * READ-ONLY board + DEEP-LINK bidding. There is NO programmatic bid-write
 * path anywhere in UPS — even the desktop auction hub opens MFL's native
 * auction page to bid; the worker only READS auction state. Mobile mirrors
 * that exactly: render lots / ERA-eligible / nomination cadence from
 * /api/auction/*, and the "Bid ↗ / Nominate ↗" buttons deep-link to MFL's
 * O=43 auction page (no new write route — Keith decision, this session).
 *
 * Worker endpoints (verbatim from auction_hub.js):
 *   GET /api/auction/lots?L=<lid>&YEAR=<yr>[&franchise_id=<fid>]   (1204)
 *   GET /api/auction/era-eligible?L=<lid>&YEAR=<yr>                (188)
 *   GET /api/auction/nomination-status?L=<lid>&YEAR=<yr>           (242)
 * Deep-link (O=43), copied from auction_hub.js (1076-1079 / 1394-1397):
 *   https://www48.myfantasyleague.com/<yr>/options
 *     ?LEAGUE_ID=<lid>&FRANCHISE=<viewerFid>&O=43&PLAYER_ID=<pid>
 *
 * Data is lazy-fetched on view open (NOT in loadAllData) to keep boot light.
 */
(function () {
  "use strict";
  if (!window.UPS_MOBILE) return;
  var M = window.UPS_MOBILE;
  var U = M.util;

  // Lazy cache, keyed by league:year:viewer so a team-switch re-fetches.
  var state = { lots: null, era: null, nom: null, loading: false, error: null, loadedFor: "" };

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

  // O=43 nominate/bid deep-link — verbatim from auction_hub.js. UPS has no
  // bid-write endpoint; bidding always happens on MFL's native auction page.
  function mflAuctionUrl(pid) {
    var viewerFid = M.state.viewerFranchiseId || "0000";
    var season = M.state.ctx.year;
    return "https://www48.myfantasyleague.com/" + encodeURIComponent(season) +
      "/options?LEAGUE_ID=" + encodeURIComponent(M.state.ctx.leagueId) +
      "&FRANCHISE=" + encodeURIComponent(viewerFid) +
      "&O=43&PLAYER_ID=" + encodeURIComponent(pid);
  }

  // k is in $thousands (e.g. 12 → "$12K"). null/≤0 → "—".
  function fmtK(k) {
    var n = Number(k);
    if (!isFinite(n) || n <= 0) return "—";
    var t = Math.round(n * 10) / 10;
    return "$" + String(t).replace(/\.0$/, "") + "K";
  }

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

  function posChip(pos) {
    var p = String(pos || "").toUpperCase();
    return '<span class="ups-m-auc-pos">' + U.escapeHtml(p || "—") + '</span>';
  }

  // ── Lazy fetch (per view-open) ──────────────────────────────────────
  function load() {
    var ctx = M.state.ctx;
    var key = ctx.leagueId + ":" + ctx.year + ":" + (M.state.viewerFranchiseId || "");
    if (state.loadedFor === key && (state.lots || state.era)) return Promise.resolve();
    state.loading = true; state.error = null; state.loadedFor = key;
    var L = encodeURIComponent(ctx.leagueId), Y = encodeURIComponent(ctx.year);
    var fidQs = M.state.viewerFranchiseId ? "&franchise_id=" + encodeURIComponent(M.state.viewerFranchiseId) : "";
    var get = function (path) { return M.api.fetchJson(M.api.workerUrl(path)).catch(function () { return null; }); };
    return Promise.all([
      get("/api/auction/lots?L=" + L + "&YEAR=" + Y + fidQs),
      get("/api/auction/era-eligible?L=" + L + "&YEAR=" + Y),
      get("/api/auction/nomination-status?L=" + L + "&YEAR=" + Y)
    ]).then(function (res) {
      state.lots = res[0] || { lots: [] };
      state.era = res[1] || { players: [] };
      state.nom = res[2] || { franchises: [] };
      state.loading = false;
    }).catch(function (e) {
      state.loading = false; state.error = String(e && e.message || e);
    });
  }

  // In-app bidding only when the commish kill switch is on (surfaced on the lots
  // payload). Off → the CTAs stay plain MFL deep-links (current behavior).
  function inappEnabled() {
    return !!(state.lots && state.lots.inapp_bid_enabled);
  }

  function lotForPid(pid) {
    var arr = (state.lots && state.lots.lots) || [];
    for (var i = 0; i < arr.length; i++) {
      if (String(arr[i].player_id) === String(pid)) return arr[i];
    }
    return null;
  }

  // ── Render ──────────────────────────────────────────────────────────
  function render(mount) {
    mount.innerHTML = subTabs("auction") +
      '<div class="ups-m-auction" id="ups-m-auction-body">' +
        '<div class="ups-m-loading">Loading auction…</div>' +
      '</div>';
    load().then(paint);
  }

  function paint() {
    var body = document.getElementById("ups-m-auction-body");
    if (!body) return;
    if (state.error) {
      body.innerHTML = '<div class="ups-m-sheet-empty">Auction failed to load: ' + U.escapeHtml(state.error) + '</div>';
      return;
    }
    body.innerHTML = renderHeader() + renderNomination() + renderLots() + renderEra();
    wireBidButtons();
  }

  function renderHeader() {
    var win = (state.nom && state.nom.era_window) || {};
    var banner = "";
    if (win.open) {
      banner = '<div class="ups-m-auc-banner open"><strong>ERA nominations open</strong> — window ' +
        ((win.current_window_index || 0) + 1) + ' of ' + (win.total_windows || 6) +
        '. Each franchise may nominate <strong>1 player this window</strong>.</div>';
    } else if (win.reason === "before_open") {
      banner = '<div class="ups-m-auc-banner"><strong>ERA nominations not yet open</strong>' +
        (win.open_at_iso ? ' — opens ' + U.escapeHtml(String(win.open_at_iso).slice(0, 16).replace("T", " ")) + ' ET' : '') + '.</div>';
    } else if (win.reason === "after_close") {
      banner = '<div class="ups-m-auc-banner"><strong>ERA nominations closed</strong>. Open lots keep bidding on their 36-hour locks until they resolve.</div>';
    }
    var intro = inappEnabled()
      ? 'Live auction board. Tap <strong>Bid</strong> to bid in-app; <strong>↗</strong> opens MFL\'s page.'
      : 'Live auction board. Bidding &amp; nominating open MFL\'s native auction page.';
    return '<div class="ups-m-auc-intro">' + intro + '</div>' + banner;
  }

  function renderLots() {
    var lots = (state.lots && state.lots.lots) || [];
    var open = lots.filter(function (l) { return l.status !== "won"; });
    var won = lots.filter(function (l) { return l.status === "won"; });
    var html = '<div class="ups-m-auc-sec-head">Live Lots <span class="ct">' + open.length + '</span></div>';
    if (!open.length) {
      html += '<div class="ups-m-auc-empty">No open lots right now.</div>';
    } else {
      // Sort by soonest-to-lock first.
      open.sort(function (a, b) { return Number(a.seconds_remaining || 0) - Number(b.seconds_remaining || 0); });
      html += open.map(renderLotCard).join("");
    }
    if (won.length) {
      html += '<div class="ups-m-auc-sec-head sub">Recently Won <span class="ct">' + won.length + '</span></div>';
      html += won.slice(0, 12).map(renderLotCard).join("");
    }
    return html;
  }

  function renderLotCard(l) {
    var isWon = l.status === "won";
    var cta = isWon
      ? '<span class="ups-m-auc-won">Won · ' + U.escapeHtml(l.winner_name || franchiseName(l.winner_fid)) + '</span>'
      : (inappEnabled()
        ? '<button type="button" class="btn-act myac ups-m-auc-bid-btn" data-action="bid" data-pid="' + U.escapeHtml(String(l.player_id)) +
            '" data-name="' + U.escapeHtml(l.player_name || "") + '" data-kind="free-agent" data-high="' + (Number(l.current_high_bid_k) || 0) + '">Bid</button>' +
          '<a class="ups-m-auc-mfl" href="' + mflAuctionUrl(l.player_id) + '" target="_blank" rel="noopener" title="Bid on MFL">↗</a>'
        : '<a class="btn-act myac" href="' + mflAuctionUrl(l.player_id) + '" target="_blank" rel="noopener">Bid ↗</a>');
    var timeCell = isWon ? '' :
      '<span class="ups-m-auc-time" title="Locks in">' + countdown(l.seconds_remaining) + '</span>';
    return '<div class="ups-m-auc-card' + (isWon ? ' won' : '') + '">' +
      '<div class="ups-m-auc-card-main">' +
        '<div class="ups-m-auc-name">' + posChip(l.position) + U.escapeHtml(l.player_name || ("Player #" + l.player_id)) +
          (l.nfl_team ? ' <span class="ups-m-auc-team">' + U.escapeHtml(l.nfl_team) + '</span>' : '') + '</div>' +
        '<div class="ups-m-auc-meta">High <strong>' + fmtK(l.current_high_bid_k) + '</strong>' +
          (l.current_high_bidder_fid ? ' · ' + U.escapeHtml(l.current_high_bidder_name || franchiseName(l.current_high_bidder_fid)) : '') +
          ' · ' + (Number(l.bid_count) || 0) + ' bid' + ((Number(l.bid_count) || 0) === 1 ? '' : 's') +
          (l.nominator_fid ? ' · by ' + U.escapeHtml(l.nominator_name || franchiseName(l.nominator_fid)) : '') +
          (l.your_proxy_bid_k ? ' · <span class="ups-m-auc-proxy">your proxy ' + fmtK(l.your_proxy_bid_k) + '</span>' : '') +
        '</div>' +
      '</div>' +
      '<div class="ups-m-auc-card-cta">' + timeCell + cta + '</div>' +
    '</div>';
  }

  function renderNomination() {
    var rows = (state.nom && state.nom.franchises) || [];
    if (!rows.length) return "";
    var viewerFid = U.pad4(M.state.viewerFranchiseId);
    // nomination-status rows key the franchise as `fid` + `franchise_name`.
    function rowFid(f) { return U.pad4(f.fid || f.id || f.franchise_id); }
    // Viewer's own card first, then the rest.
    rows = rows.slice().sort(function (a, b) {
      var av = rowFid(a) === viewerFid ? 0 : 1;
      var bv = rowFid(b) === viewerFid ? 0 : 1;
      return av - bv;
    });
    var html = '<div class="ups-m-auc-sec-head">Nomination Cadence</div>';
    html += '<div class="ups-m-auc-nom">' + rows.map(function (f) {
      var fid = rowFid(f);
      var era = f.era || {};
      var fa = f.fa_auction || {};
      var eraStatus;
      if (era.window_open === false && era.window_reason === "before_open") {
        eraStatus = '<span class="cd">Opens in ' + countdown(era.seconds_until_next) + '</span>';
      } else if (era.window_open === false && era.window_reason === "after_close") {
        eraStatus = '<span class="cd">Closed</span>';
      } else if (era.can_nominate_now) {
        eraStatus = '<span class="rdy">Can nominate now</span>';
      } else {
        eraStatus = '<span class="cd">Used · next ' + countdown(era.seconds_until_next) + '</span>';
      }
      var faStatus = fa.can_nominate_now
        ? '<span class="rdy">' + (fa.remaining != null ? fa.remaining : "?") + ' of ' + (fa.max_in_window != null ? fa.max_in_window : "?") + ' left</span>'
        : '<span class="cd">Next ' + countdown(fa.seconds_until_next) + '</span>';
      return '<div class="ups-m-auc-nom-row' + (fid === viewerFid ? ' me' : '') + '">' +
        '<div class="fn">' + U.escapeHtml(f.franchise_name || f.name || franchiseName(fid)) + (fid === viewerFid ? ' <span class="you">you</span>' : '') + '</div>' +
        '<div class="ns"><span class="lbl">ERA</span> ' + eraStatus + '</div>' +
        '<div class="ns"><span class="lbl">FA</span> ' + faStatus + '</div>' +
      '</div>';
    }).join("") + '</div>';
    return html;
  }

  function renderEra() {
    var players = (state.era && state.era.players) || [];
    var html = '<div class="ups-m-auc-sec-head">Expired Rookie Pool <span class="ct">' + players.length + '</span></div>';
    if (!players.length) {
      html += '<div class="ups-m-auc-empty">No ERA-eligible players' + (state.era && state.era.error ? ' (load error)' : '') + '.</div>';
      return html;
    }
    // Most valuable first (weighted PPG desc; nulls last).
    var sorted = players.slice().sort(function (a, b) {
      var av = a.ppg_weighted == null ? -1 : Number(a.ppg_weighted);
      var bv = b.ppg_weighted == null ? -1 : Number(b.ppg_weighted);
      return bv - av;
    });
    html += sorted.map(renderEraRow).join("");
    return html;
  }

  function renderEraRow(p) {
    // CTA mirrors auction_hub.js (1089-1114): won → disabled, locked →
    // closed, blocked → blocked, already-nominated → Bid ↗, else Nominate ↗.
    var lot = lotForPid(p.player_id);
    var nowUnix = Math.floor(Date.now() / 1000);
    var lotIsWon = !!lot && lot.status === "won";
    var lotIsLocked = !!lot && !lotIsWon && Number(lot.locks_at_unix || 0) > 0 && Number(lot.locks_at_unix) <= nowUnix;
    var lotIsOpen = !!lot && !lotIsWon && !lotIsLocked;
    var alreadyNominated = lotIsOpen || lotIsWon || lotIsLocked || (Number(p.high_bid_k) > 0) || (Number(p.total_bids) > 0);
    var cta;
    if (lotIsWon) {
      cta = '<span class="ups-m-auc-won">Won · ' + U.escapeHtml(lot.winner_name || franchiseName(lot.winner_fid)) + '</span>';
    } else if (lotIsLocked) {
      cta = '<span class="ups-m-auc-won">Closed</span>';
    } else if (p.nominate_blocked) {
      cta = '<span class="ups-m-auc-won" title="' + U.escapeHtml(p.nominate_block_reason || "Nomination blocked") + '">Blocked</span>';
    } else if (inappEnabled()) {
      cta = '<button type="button" class="btn-act myac ups-m-auc-bid-btn" data-action="' + (alreadyNominated ? "bid" : "nominate") +
          '" data-pid="' + U.escapeHtml(String(p.player_id)) + '" data-name="' + U.escapeHtml(p.name || "") +
          '" data-kind="expired-rookie" data-high="' + (Number(p.high_bid_k) || 0) + '">' + (alreadyNominated ? "Bid" : "Nominate") + '</button>' +
        '<a class="ups-m-auc-mfl" href="' + mflAuctionUrl(p.player_id) + '" target="_blank" rel="noopener" title="Open on MFL">↗</a>';
    } else {
      cta = '<a class="btn-act myac" href="' + mflAuctionUrl(p.player_id) + '" target="_blank" rel="noopener">' +
        (alreadyNominated ? "Bid ↗" : "Nominate ↗") + '</a>';
    }
    var ppg = p.ppg_weighted != null ? Number(p.ppg_weighted).toFixed(1) : "—";
    var bidLine = (Number(p.high_bid_k) > 0)
      ? 'High <strong>' + fmtK(p.high_bid_k) + '</strong>' + (p.high_bid_team ? ' · ' + U.escapeHtml(p.high_bid_team) : '')
      : '<span class="ups-m-auc-noopen">Not yet nominated</span>';
    var origin = p.origin_label && p.origin_label !== "Rookie - FA Auction" ? p.origin_label : (p.origin_label ? "FA Auction" : "");
    return '<div class="ups-m-auc-card">' +
      '<div class="ups-m-auc-card-main">' +
        '<div class="ups-m-auc-name">' + posChip(p.position) + U.escapeHtml(p.name || ("Player #" + p.player_id)) +
          (p.nfl_team ? ' <span class="ups-m-auc-team">' + U.escapeHtml(p.nfl_team) + '</span>' : '') + '</div>' +
        '<div class="ups-m-auc-meta">' +
          (origin ? '<span class="ups-m-auc-origin">' + U.escapeHtml(origin) + '</span> · ' : '') +
          'wPPG <strong>' + ppg + '</strong> · ' + bidLine +
        '</div>' +
      '</div>' +
      '<div class="ups-m-auc-card-cta">' + cta + '</div>' +
    '</div>';
  }

  // ── In-app bid / nominate (Phase 1) ─────────────────────────────────
  // Submits through the worker (POST /api/auction/{bid,nominate}), which places
  // the bid on MFL via the owner's forwarded MFL_USER_ID, then re-reads the live
  // board (verify-after-submit). Gated server-side by AUCTION_INAPP_BID_ENABLED:
  // when off the route 503s and we fall back to MFL's O=43 page (deep-link).
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

  // opts: { action:"bid"|"nominate", player_id, player_name, auction_type, high_k }
  function openBidSheet(opts) {
    if (!M.state.viewerFranchiseId) { M.ui.showToast("Pick your franchise first.", "err"); return; }
    var isNom = opts.action === "nominate";
    var highK = Number(opts.high_k) || 0;
    var minK = isNom ? 1 : highK + 1;     // ERA/FA start $1K; a bid beats the high by the $1K increment
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
    document.getElementById("ups-m-auc-bid-submit").addEventListener("click", function () {
      submitBid(opts, this, minK);
    });
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
      amount: amountK * 1000,            // $K → dollars (MFL form unit; archived module used dollars)
      franchise_id: M.state.viewerFranchiseId,
      auction_type: opts.auction_type || "free-agent"
    }).then(function (resp) {
      if (resp.status === 503) {            // kill switch off → fall back to MFL
        M.ui.showToast("In-app bidding is off — opening MFL.", "info");
        window.open((resp.body && resp.body.native_link) || mflAuctionUrl(opts.player_id), "_blank", "noopener");
        closeBidSheet();
        return;
      }
      if (resp.ok && resp.body && resp.body.ok) {
        M.ui.showToast((opts.action === "nominate" ? "Nominated" : "Bid placed") + " ✓", "ok");
        closeBidSheet();
        state.loadedFor = ""; load().then(paint);   // re-read → shows the verified high bid
      } else {
        var msg = (resp.body && (resp.body.message || resp.body.error)) || ("HTTP " + resp.status);
        if (errEl) errEl.textContent = msg;
        M.ui.showToast("Bid failed: " + msg, "err");
        btn.disabled = false; btn.textContent = label;
      }
    }).catch(function (e) {
      var msg = (e && e.message) || String(e);
      if (errEl) errEl.textContent = msg;
      M.ui.showToast("Bid failed: " + msg, "err");
      btn.disabled = false; btn.textContent = label;
    });
  }

  function wireBidButtons() {
    var body = document.getElementById("ups-m-auction-body");
    if (!body) return;
    Array.prototype.forEach.call(body.querySelectorAll(".ups-m-auc-bid-btn"), function (b) {
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
