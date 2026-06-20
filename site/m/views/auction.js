/* League → Auction view — two auctions (FA · Expired Rookie), each with a
 * sub-nav (best-in-class redesign).
 *
 * Top tabs: FA Auction | Expired Rookie. Each auction has a segmented sub-nav:
 *   Summary  — KPIs + (FAA) team budgets + roster needs
 *   Lots     — live board (active_auctions) with in-app Bid
 *   Players  — eligible/available pool + search + Nominate
 *   Cadence  — per-franchise nomination windows for THIS auction
 *   Schedule — (FAA only) compliance scoreboard: noms made/required, roster met,
 *              reset countdown, out-of-compliance — from /api/auction/fa-schedule
 * Board data: /acquisition-hub/{free-agent,expired-rookie}-auction/live. Cadence:
 * /api/auction/nomination-status. In-app Bid/Nominate (Phase 1 sheet) only when
 * the commish switch is on (payload.enabled) AND in-app bidding is on; else the
 * pool is read-only under a "not running" banner. Payload amounts are DOLLARS;
 * the bid sheet takes $K and sends ×1000.
 */
(function () {
  "use strict";
  if (!window.UPS_MOBILE) return;
  var M = window.UPS_MOBILE;
  var U = M.util;

  // tab: "faa" | "era" (the auction). sub: "summary"|"lots"|"players"|"cadence"|"schedule".
  var state = { faa: null, era: null, eraPool: null, nom: null, schedule: null, lots: null, bidHistory: null, freeAgents: null, faPool: null, loading: false, error: null, loadedFor: "", tab: "", sub: "summary", lotsView: "open", search: "" };

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
      get(M.api.workerUrl("/api/auction/nomination-status?L=" + L + "&YEAR=" + Y)),
      get(M.api.workerUrl("/api/auction/fa-schedule?L=" + L + "&YEAR=" + Y)),
      // The rich ERA eligible pool (D1 snapshot — same source the desktop hub
      // uses). The /live eligible_players walks live rosters and returns 0
      // post-deadline, so this is the canonical pool.
      get(M.api.workerUrl("/api/auction/era-eligible?L=" + L + "&YEAR=" + Y)),
      // Lots (open + completed) and the bid-history feed.
      get(M.api.workerUrl("/api/auction/lots?L=" + L + "&YEAR=" + Y)),
      get(M.api.workerUrl("/api/auction/bid-history?L=" + L + "&YEAR=" + Y)),
      // Every free agent in the league (MFL export). Enriched client-side from
      // the already-loaded player DB → the "all players" nominate pool.
      get(M.api.mflExportUrl("freeAgents"))
    ]).then(function (res) {
      state.faa = res[0] || { ok: false };
      state.era = res[1] || { ok: false };
      state.nom = res[2] || { franchises: [] };
      state.schedule = res[3] || { ok: false };
      state.eraPool = res[4] || { players: [] };
      state.lots = res[5] || { lots: [] };
      state.bidHistory = res[6] || { bids: [] };
      state.freeAgents = res[7] || null;
      state.faPool = null;  // memoized enrichment, rebuilt lazily
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
  // Which sub-pills each auction shows (ERA has no compliance Schedule).
  function subsFor(tab) {
    return tab === "faa"
      ? [["summary", "Summary"], ["players", "Players"], ["lots", "Lots"], ["history", "History"], ["cadence", "Cadence"], ["schedule", "Schedule"]]
      : [["summary", "Summary"], ["players", "Players"], ["lots", "Lots"], ["history", "History"], ["cadence", "Cadence"]];
  }

  function paint() {
    var body = document.getElementById("ups-m-auction-body");
    if (!body) return;
    if (state.error) {
      body.innerHTML = '<div class="ups-m-sheet-empty">Auction failed to load: ' + U.escapeHtml(state.error) + '</div>';
      return;
    }
    // Keep the sub-pill valid for the active auction.
    if (subsFor(state.tab).map(function (s) { return s[0]; }).indexOf(state.sub) === -1) state.sub = "summary";
    body.innerHTML =
      innerTabs() +
      bannerFor(state.tab) +
      subNav(state.tab) +
      '<div class="ups-m-auc-tabbody">' + renderSub(state.tab, state.sub) + '</div>';
    wireTabs();
    wireSubNav();
    wireLotsToggle();
    wireSearch();
    wireBidButtons();
  }
  function wireLotsToggle() {
    Array.prototype.forEach.call(document.querySelectorAll(".ups-m-auc-lottab"), function (b) {
      b.addEventListener("click", function () {
        var v = this.getAttribute("data-lotview");
        if (v === state.lotsView) return;
        state.lotsView = v;
        paint();
      });
    });
  }

  function innerTabs() {
    function live(p) { return p && p.enabled ? ' <span class="ups-m-auc-live">● live</span>' : ''; }
    function tab(key, label, p) {
      return '<button type="button" class="ups-m-auc-itab' + (state.tab === key ? ' active' : '') + '" data-itab="' + key + '">' + label + live(p) + '</button>';
    }
    return '<div class="ups-m-auc-itabs">' +
      tab("faa", "FA Auction", state.faa) +
      tab("era", "Expired Rookie", state.era) +
      '</div>';
  }

  function subNav(tab) {
    return '<div class="ups-m-auc-subnav">' + subsFor(tab).map(function (s) {
      return '<button type="button" class="ups-m-auc-subpill' + (state.sub === s[0] ? ' active' : '') + '" data-sub="' + s[0] + '">' + s[1] + '</button>';
    }).join("") + '</div>';
  }

  function bannerFor(tab) {
    var p = tab === "era" ? state.era : state.faa;
    if (p && p.enabled) return '';
    var name = tab === "era" ? "The Expired-Rookie Auction" : "The FA Auction";
    var when = tab === "era" ? "Runs Memorial Day weekend." : "Opens the last weekend of July.";
    return '<div class="ups-m-auc-banner"><strong>' + name + ' isn\'t running right now.</strong> ' + when +
      ' Browse the pool; bidding opens when the commish flips it on.</div>';
  }

  // Dispatch the active sub-view for an auction.
  function renderSub(tab, sub) {
    var p = (tab === "era" ? state.era : state.faa) || {};
    if (p.ok === false && sub !== "history" && sub !== "lots") return '<div class="ups-m-auc-empty">' + (tab === "era" ? "ERA" : "FAA") + ' board unavailable right now.</div>';
    if (sub === "players") return tab === "era" ? eraPool() : faaPool();
    if (sub === "lots") return renderLots(tab);
    if (sub === "history") return renderHistory(tab);
    if (sub === "cadence") return renderCadence(tab);
    if (sub === "schedule") return renderSchedule();
    return renderSummary(tab, p);
  }

  function renderSummary(tab, p) {
    if (tab === "era") {
      var eligCount = ((state.eraPool && state.eraPool.players) || []).length || (p.eligible_players || []).length;
      return kpis([["Live lots", (p.active_auctions || []).length], ["Eligible", eligCount], ["Markers", (p.extension_markers || []).length]]) +
        '<div class="ups-m-auc-note">The Expired-Rookie Auction claims players whose rookie deals expired. <strong>Players</strong> browses the eligible pool · <strong>Lots</strong> is the live board · <strong>Cadence</strong> shows nomination windows.</div>';
    }
    return kpis([["Live lots", (p.active_auctions || []).length], ["Available", (p.available_players || []).length], ["Your team", franchiseName(M.state.viewerFranchiseId)]]) +
      budgetsBlock(p) + needsBlock(p);
  }

  function flipName(n) { n = String(n || ""); var i = n.indexOf(", "); return i > 0 ? (n.slice(i + 2) + " " + n.slice(0, i)) : n; }
  var POS_ORDER = { QB: 1, RB: 2, WR: 3, TE: 4, PK: 5, K: 5, PN: 6, DL: 7, LB: 8, DB: 9 };
  // The full free-agent pool — every unrostered player (MFL freeAgents export),
  // enriched from the boot-loaded player DB. Memoized in state.faPool.
  function faAllPlayers() {
    if (state.faPool) return state.faPool;
    var lu = state.freeAgents && state.freeAgents.freeAgents && state.freeAgents.freeAgents.leagueUnit;
    var list = U.asArray(lu && lu.player);
    var dbArr = U.asArray(M.state.players && M.state.players.players && M.state.players.players.player);
    var byId = {};
    for (var i = 0; i < dbArr.length; i++) byId[String(dbArr[i].id)] = dbArr[i];
    var modelById = {};
    var avail = (state.faa && state.faa.available_players) || [];
    for (var j = 0; j < avail.length; j++) modelById[String(avail[j].player_id)] = avail[j].upcoming_auction_value;
    var rows = [];
    for (var k = 0; k < list.length; k++) {
      var id = String(list[k].id || "");
      var pl = byId[id];
      if (!pl || !pl.name) continue;
      var pos = String(pl.position || "").toUpperCase();
      if (!pos) continue;
      rows.push({ player_id: id, player_name: flipName(pl.name), position: pos, team: pl.team || "", model_value: modelById[id] || 0 });
    }
    rows.sort(function (a, b) {
      var ao = POS_ORDER[a.position] || 50, bo = POS_ORDER[b.position] || 50;
      return ao - bo || a.player_name.localeCompare(b.player_name);
    });
    state.faPool = rows;
    return rows;
  }
  function faaPool() {
    var p = state.faa || {};
    return poolBlock(faAllPlayers(), "free-agent", {
      title: "Free Agents", enabled: !!p.enabled, teamKey: "team",
      subOf: function (r) { return r.model_value ? 'Model ' + usd(r.model_value) : ''; }
    });
  }
  // Player ids in the ERA eligible pool — used to split lots/bids by auction
  // (expired rookies → ERA, everyone else → FA), since lots aren't kind-tagged.
  function eraPoolIds() {
    var ids = {}, ps = (state.eraPool && state.eraPool.players) || [];
    for (var i = 0; i < ps.length; i++) ids[String(ps[i].player_id)] = true;
    return ids;
  }
  // ERA eligible pool — prefer the rich D1 snapshot (/api/auction/era-eligible,
  // the same source the desktop hub uses; the /live walk returns 0 post-deadline).
  function eraPool() {
    var enabled = !!(state.era && state.era.enabled);
    var snap = (state.eraPool && state.eraPool.players) || [];
    if (snap.length) {
      var rows = snap.map(function (r) {
        return {
          player_id: r.player_id, player_name: r.name, position: r.position, team: r.nfl_team,
          origin_label: r.origin_label, ppg_weighted: r.ppg_weighted, high_bid_k: r.high_bid_k, prior_owner: r.prior_owner
        };
      });
      return poolBlock(rows, "expired-rookie", {
        title: "Eligible Pool", enabled: enabled, teamKey: "team",
        subOf: function (r) {
          var bits = [];
          if (r.origin_label) bits.push(U.escapeHtml(r.origin_label));
          if (r.ppg_weighted) bits.push((Math.round(Number(r.ppg_weighted) * 10) / 10) + " PPG");
          if (toNum(r.high_bid_k) > 0) bits.push("High " + fmtK(r.high_bid_k));
          else if (r.prior_owner) bits.push("was " + U.escapeHtml(r.prior_owner));
          return bits.join(" · ");
        }
      });
    }
    return poolBlock((state.era && state.era.eligible_players) || [], "expired-rookie", {
      title: "Eligible Pool", enabled: enabled, teamKey: "franchise_name",
      subOf: function (r) { return r.franchise_name ? 'On ' + U.escapeHtml(r.franchise_name) : ''; }
    });
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
    if (filtered.length > 80) html += '<div class="ups-m-auc-empty">Showing 80 of ' + filtered.length + ' — search to find a specific player.</div>';
    html += '</div>';
    return html;
  }

  function kpis(items) {
    return '<div class="ups-m-auc-kpis">' + items.map(function (it) {
      return '<div class="ups-m-auc-kpi"><span class="lbl">' + U.escapeHtml(it[0]) + '</span><strong>' + U.escapeHtml(String(it[1])) + '</strong></div>';
    }).join("") + '</div>';
  }

  // FAA compliance scoreboard (from /api/auction/fa-schedule). Per team: noms
  // made/required today, roster-requirement status, and who still owes — the
  // same data that drives the nightly Discord nudge.
  function renderSchedule() {
    var sc = state.schedule || {};
    if (sc.ok === false) return '<div class="ups-m-auc-empty">Compliance data unavailable right now.</div>';
    var rows = (sc.rows || []).slice();
    if (!rows.length) return '<div class="ups-m-auc-empty">No compliance data yet — opens with the FA Auction.</div>';
    var viewerFid = U.pad4(M.state.viewerFranchiseId);
    rows.sort(function (a, b) {
      var av = U.pad4(a.franchise_id) === viewerFid ? 0 : 1, bv = U.pad4(b.franchise_id) === viewerFid ? 0 : 1;
      return (av - bv) || (Number(b.out_of_compliance) - Number(a.out_of_compliance)) || (Number(b.total_deficit) - Number(a.total_deficit));
    });
    var ooc = sc.out_of_compliance_count || 0;
    var req = sc.noms_required || 2;
    var head =
      '<div class="ups-m-auc-sec-head">Nomination Schedule <span class="ct">' + ooc + ' owe noms</span></div>' +
      '<div class="ups-m-auc-note">During the FA Auction every team makes <strong>' + req + ' nominations a day</strong> until it can field a legal lineup. Met the roster requirement? You can stop — but keep nominating daily if you want to keep adding.</div>';
    var rowsHtml = rows.map(function (r) {
      var me = U.pad4(r.franchise_id) === viewerFid;
      var maxed = !r.roster_met && Number(r.noms_remaining) === 0;
      var nomsCell = (Number(r.noms_made) || 0) + '/' + (Number(r.noms_required) || req) +
        (maxed && Number(r.seconds_until_reset) > 0 ? ' <span class="rst">· ' + countdown(r.seconds_until_reset) + '</span>' : '');
      var status = r.roster_met
        ? '<span class="rdy">Met ✓</span>'
        : r.out_of_compliance
          ? '<span class="bad">Owes ' + (Number(r.noms_remaining) || 0) + '</span>'
          : '<span class="cd">In window</span>';
      return '<div class="ups-m-auc-trow' + (me ? ' me' : '') + (r.out_of_compliance ? ' ooc' : '') + '">' +
        '<span class="tn">' + U.escapeHtml(r.franchise_name || franchiseName(r.franchise_id)) + '</span>' +
        '<span>' + nomsCell + '</span>' +
        '<span>' + (r.roster_met ? '✓' : (Number(r.total_deficit) || 0)) + '</span>' +
        '<span>' + status + '</span>' +
      '</div>';
    }).join("");
    return head +
      '<div class="ups-m-auc-table sched">' +
        '<div class="ups-m-auc-trow head"><span>Team</span><span>Noms</span><span>Gap</span><span>Status</span></div>' +
        rowsHtml +
      '</div>';
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

  // Lots — Open (live board) / Completed (won) toggle. Completed + history are
  // split by auction via the ERA-eligible intersection (lots aren't kind-tagged).
  function renderLots(tab) {
    var isEra = tab === "era";
    var live = (isEra ? state.era : state.faa) || {};
    var openCount = (live.active_auctions || []).length;
    var eIds = eraPoolIds();
    var completed = ((state.lots && state.lots.lots) || []).filter(function (l) {
      var done = l.status === "won" || l.status === "expired" || l.status === "closed";
      return done && (!!eIds[String(l.player_id)] === isEra);
    });
    var view = state.lotsView || "open";
    var toggle = '<div class="ups-m-auc-lotstoggle">' +
      '<button type="button" class="ups-m-auc-lottab' + (view === "open" ? " active" : "") + '" data-lotview="open">Open <span class="ct">' + openCount + '</span></button>' +
      '<button type="button" class="ups-m-auc-lottab' + (view === "completed" ? " active" : "") + '" data-lotview="completed">Completed <span class="ct">' + completed.length + '</span></button>' +
    '</div>';
    if (view === "completed") return toggle + completedLotsBlock(completed);
    return toggle + lotsBlock(live, isEra ? "expired-rookie" : "free-agent", isEra ? "36h lock" : "24h lock");
  }
  function completedLotsBlock(rows) {
    var head = '<div class="ups-m-auc-sec-head">Completed Lots <span class="ct">' + rows.length + '</span></div>';
    if (!rows.length) return head + '<div class="ups-m-auc-empty">No completed lots yet.</div>';
    rows = rows.slice().sort(function (a, b) { return (Number(b.won_at_unix) || 0) - (Number(a.won_at_unix) || 0); });
    return head + rows.map(function (l) {
      var won = l.status === "won";
      return '<div class="ups-m-auc-card">' +
        '<div class="ups-m-auc-card-main">' +
          '<div class="ups-m-auc-name">' + posChip(l.position) + U.escapeHtml(l.player_name || ("Player #" + l.player_id)) +
            (l.nfl_team ? ' <span class="ups-m-auc-team">' + U.escapeHtml(l.nfl_team) + '</span>' : '') + '</div>' +
          '<div class="ups-m-auc-meta">' + (won
            ? 'Won by <strong>' + U.escapeHtml(l.winner_name || l.current_high_bidder_name || "—") + '</strong> · ' + fmtK(l.current_high_bid_k) + ' · ' + (Number(l.bid_count) || 0) + ' bids'
            : '<span class="ups-m-auc-won">' + U.escapeHtml((l.status || "closed").replace(/^\w/, function (c) { return c.toUpperCase(); })) + '</span>') + '</div>' +
        '</div>' +
      '</div>';
    }).join("");
  }
  // Bid History — chronological feed, split by auction.
  function renderHistory(tab) {
    var isEra = tab === "era";
    var eIds = eraPoolIds();
    var bids = ((state.bidHistory && state.bidHistory.bids) || []).filter(function (b) { return !!eIds[String(b.player_id)] === isEra; });
    var head = '<div class="ups-m-auc-sec-head">Bid History <span class="ct">' + bids.length + '</span></div>';
    if (!bids.length) return head + '<div class="ups-m-auc-empty">No bids yet.</div>';
    bids = bids.slice().sort(function (a, b) { return (Number(b.bid_at_unix) || 0) - (Number(a.bid_at_unix) || 0); });
    return head + '<div class="ups-m-auc-hist">' + bids.slice(0, 120).map(function (b) {
      var when = b.bid_at_iso ? new Date(b.bid_at_iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
      var kind = b.is_nomination ? '<span class="nom">Nom</span>' : '<span class="bid">Bid</span>';
      return '<div class="ups-m-auc-hrow">' +
        '<div class="hp">' + posChip(b.position) + U.escapeHtml(b.player_name || ("#" + b.player_id)) + '</div>' +
        '<div class="hb">' + kind + ' <strong>' + fmtK(b.bid_k) + '</strong> · ' + U.escapeHtml(b.franchise_name || "—") + (when ? ' <span class="hw">' + when + '</span>' : '') + '</div>' +
      '</div>';
    }).join("") + '</div>';
  }

  // Per-franchise nomination windows for ONE auction (ERA = 1/12h anchored,
  // FAA = 2/24h rolling). Data: /api/auction/nomination-status.
  function renderCadence(tab) {
    var rows = (state.nom && state.nom.franchises) || [];
    if (!rows.length) return '<div class="ups-m-auc-empty">No nomination data right now.</div>';
    var isEra = tab === "era";
    var viewerFid = U.pad4(M.state.viewerFranchiseId);
    function rowFid(f) { return U.pad4(f.fid || f.id || f.franchise_id); }
    rows = rows.slice().sort(function (a, b) { return (rowFid(a) === viewerFid ? 0 : 1) - (rowFid(b) === viewerFid ? 0 : 1); });
    var rule = isEra ? "1 nomination per 12-hour window — windows anchored to 6 AM / 6 PM ET."
                     : "2 nominations per rolling 24-hour window.";
    return '<div class="ups-m-auc-sec-head">Nomination Cadence</div>' +
      '<div class="ups-m-auc-note">' + rule + '</div>' +
      '<div class="ups-m-auc-nom">' + rows.map(function (f) {
        var fid = rowFid(f), era = f.era || {}, fa = f.fa_auction || {};
        var status;
        if (isEra) {
          status = era.can_nominate_now ? '<span class="rdy">Can nominate</span>'
            : (era.window_open === false && era.window_reason === "after_close") ? '<span class="cd">Closed</span>'
            : '<span class="cd">Next ' + countdown(era.seconds_until_next) + '</span>';
        } else {
          status = fa.can_nominate_now
            ? '<span class="rdy">' + (fa.remaining != null ? fa.remaining : "?") + ' of ' + (fa.max_in_window != null ? fa.max_in_window : "?") + ' left</span>'
            : '<span class="cd">Next ' + countdown(fa.seconds_until_next) + '</span>';
        }
        return '<div class="ups-m-auc-nom-row single' + (fid === viewerFid ? ' me' : '') + '">' +
          '<div class="fn">' + U.escapeHtml(f.franchise_name || f.name || franchiseName(fid)) + (fid === viewerFid ? ' <span class="you">you</span>' : '') + '</div>' +
          '<div class="ns"><span class="lbl">' + (isEra ? "ERA" : "FA") + '</span> ' + status + '</div>' +
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
        // Keep the current sub-pill if the new auction has it, else Summary.
        if (subsFor(t).map(function (s) { return s[0]; }).indexOf(state.sub) === -1) state.sub = "summary";
        paint();
      });
    });
  }
  function wireSubNav() {
    Array.prototype.forEach.call(document.querySelectorAll(".ups-m-auc-subpill"), function (b) {
      b.addEventListener("click", function () {
        var s = this.getAttribute("data-sub");
        if (s === state.sub) return;
        state.sub = s; state.search = "";
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
      var fresh = (state.tab === "era") ? eraPool() : faaPool();
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
