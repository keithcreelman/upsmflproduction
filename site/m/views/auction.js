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
  var state = { faa: null, era: null, eraPool: null, nom: null, schedule: null, lots: null, bidHistory: null, freeAgents: null, faPool: null, adp: null, loading: false, error: null, loadedFor: "", tab: "", sub: "summary", lotsView: "open", search: "", poolPos: "ALL", poolTeam: "", poolSort: "name", poolStatus: "all", openThreads: {}, faValue: undefined, favDynW: 0.5, favPos: "ALL", favOwn: "available", favOpen: {}, favTiers: false, favHelp: false,
    favRankOvr: (function () { try { return JSON.parse(localStorage.getItem("ups_fav_rank_ovr") || "{}") || {}; } catch (e) { return {}; } })() };
  // FA Value board (worth vs expected price + inflation) — commish-only.
  function favIsCommish() { return ["0008", "0000"].indexOf(U.pad4(M.state.viewerFranchiseId || "")) !== -1; }

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
      tab("stats", "Stats", "stats") +
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
  // Compact for tables. Cap adjustments land on half-thousands ($27,500), and
  // rounding that to "$28k" overstates funds by $500 and reads as flat wrong to
  // an owner who knows his real number — so keep one decimal when it isn't whole.
  function usdK(v) {
    var n = toNum(v);
    if (!(n > 0)) return "—";
    var k = n / 1000;
    var whole = Math.abs(k - Math.round(k)) < 0.05;
    return "$" + (whole ? String(Math.round(k)) : k.toFixed(1)) + "k";
  }
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
  // Bucket an MFL position into the filter chips (offense kept; defense → IDP).
  function posBucket(p) {
    p = String(p || "").toUpperCase();
    if (p === "QB" || p === "RB" || p === "WR" || p === "TE" || p === "PK" || p === "PN") return p;
    if (p === "K") return "PK";
    if (p === "P") return "PN";
    return "IDP";
  }

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
    // Effective floor = higher of the sheet-open min and the input's current min
    // attr (the outbid branch bumps that to the fresh current-high + 1). Reading the
    // attr — not just the frozen minK — rejects a manual down-edit after an outbid.
    var floorK = Math.max(minK, parseInt(amt && amt.getAttribute("min"), 10) || minK);
    if (amountK < floorK) { if (errEl) errEl.textContent = "Bid must be at least " + fmtK(floorK) + "."; return; }
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
        // Trust the server's outcome (read from MFL's own page post-submit), not a
        // hardcoded ✓. high_bid → success; outbid → keep the sheet open pre-stepped
        // to re-bid; unconfirmed → say so rather than imply a win.
        var outcome = resp.body.outcome;
        var msg = resp.body.message || ((opts.action === "nominate" ? "Nominated" : "Bid placed") + " ✓");
        if (outcome === "outbid") {
          // Pre-step the input to the fresh current-high + 1 so re-bidding is one tap.
          // Prefer the server's current_bid_dollars (its post-submit O=43 re-read);
          // the live board's high_bid_amount is D1-sourced and up to ~5 min stale, so
          // pre-filling off it could seed a re-bid BELOW the real current high.
          var freshCur = Number(resp.body.current_bid_dollars) || 0;
          var newHighK = 0;
          if (freshCur > 0) {
            newHighK = Math.round(freshCur / 1000);
          } else {
            var lot = null, arr = (resp.body.live && resp.body.live.active_auctions) || [];
            for (var i = 0; i < arr.length; i++) { if (String(arr[i].player_id) === String(opts.player_id)) { lot = arr[i]; break; } }
            newHighK = lot ? Math.round((Number(lot.high_bid_amount) || 0) / 1000) : 0;
          }
          if (newHighK > 0 && amt) { amt.value = String(newHighK + 1); amt.setAttribute("min", String(newHighK + 1)); }
          M.ui.showToast(msg, "info");
          if (errEl) errEl.textContent = msg;
          btn.disabled = false; btn.textContent = label;
          state.loadedFor = ""; load().then(paint);   // refresh the High line
          return;
        }
        M.ui.showToast(msg, outcome === "unconfirmed" ? "info" : "ok");
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
      get(M.api.mflExportUrl("freeAgents")),
      // League-wide ADP / dynasty values (FantasyCalc via the worker) — keyed
      // by mfl id, covers every player (not just rookies).
      get(M.api.workerUrl("/api/adp")),
      // PRIOR season fantasy points (this year's YTD is empty in the off-season)
      // → the PPG sort. W=YTD on a completed year = the full-season total.
      get(M.api.workerUrl("/api/mfl-export?TYPE=playerScores&L=" + L + "&YEAR=" +
        encodeURIComponent(String((parseInt(ctx.year, 10) || 2026) - 1)) + "&W=YTD&JSON=1"))
    ]).then(function (res) {
      state.faa = res[0] || { ok: false };
      state.era = res[1] || { ok: false };
      state.nom = res[2] || { franchises: [] };
      state.schedule = res[3] || { ok: false };
      state.eraPool = res[4] || { players: [] };
      state.lots = res[5] || { lots: [] };
      state.bidHistory = res[6] || { bids: [] };
      state.freeAgents = res[7] || null;
      state.adp = res[8] || null;
      state.priorScores = res[9] || null;
      state._ytd = null;        // rebuild the pid→points map
      state._statusIdx = null;  // rebuild the auction-status index
      state.faPool = null;      // memoized enrichment, rebuilt lazily
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
  // Same five pills for both auctions. "Tracker" = the per-team nomination view
  // (FAA: full compliance scoreboard; ERA: nomination windows).
  function subsFor(tab) {
    var base = [["summary", "Summary"], ["players", "Players"], ["lots", "Lots"], ["history", "History"], ["tracker", "Tracker"]];
    if (tab === "faa" && favIsCommish()) base.push(["value", "💎 Value"]);   // commish-only FA value board
    return base;
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
    wirePool();
    wireBidButtons();
    wireThreads();
    wirePlayerModal();
    wireFaValue();
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
    if (sub === "value") return renderFaValue();
    if (sub === "players") return tab === "era" ? eraPool() : faaPool();
    if (sub === "lots") return renderLots(tab);
    if (sub === "history") return renderHistory(tab);
    if (sub === "tracker") return renderTracker(tab);
    return renderSummary(tab, p);
  }

  // ── FA Value board (commish-only): worth (production+dynasty blend) vs expected price + inflation ──
  function favWorthM(r) { var w = state.favDynW; return Math.round((1 - w) * (r.rw || 0) + w * (r.dw || 0)); }
  function favVerdictM(worth, ep, a90) {
    var vr = ep > 0 ? worth / ep : null;
    if (vr == null) return ["—", "fair"];
    if (vr >= 1.5 && worth >= 15) return ["SPLURGE", "sp"];
    if (vr >= 1.2) return ["VALUE", "val"];
    if (vr >= 0.8) return ["FAIR", "fair"];
    if (ep <= 4) return (a90 || 0) >= 5 ? ["DART", "dart"] : ["FAIR", "fair"];
    if (ep < 15) return ["FAIR", "fair"];
    return vr < 0.6 ? ["OVERPAY", "over"] : ["FAIR", "fair"];
  }
  // ── ADP override: re-rank a FA and re-price him. Kernel reproduces build_fa_value.ep_base_k EXACTLY
  // (meta.model = constants + fpros curves). Only the redraft axis + startability + affine move with rank;
  // dynasty worth (dw) is rank-independent. Persisted by player name (same localStorage key as desktop). ──
  function favSaveOvrM() { try { localStorage.setItem("ups_fav_rank_ovr", JSON.stringify(state.favRankOvr)); } catch (e) { } }
  function pyRound(x) { var r = Math.round(x); if (Math.abs(x - Math.trunc(x) - 0.5) < 1e-9 && (r % 2 !== 0)) r -= (x >= 0 ? 1 : -1); return r; }
  function epStartFloorM(pos, rank, EP) { var t = EP && EP.startability && EP.startability[pos]; if (!t || !rank) return 0; for (var i = 0; i < t.length; i++) { if (rank <= t[i][0]) return t[i][1]; } return t[t.length - 1][1]; }
  function favRankIntM(s) { var m = String(s || "").match(/(\d+)/); return m ? +m[1] : null; }
  function epRecomputeM(pos, rank, dw, EP) {
    var C = EP && EP.curves && EP.curves[pos]; if (!C || !rank) return null;
    var idx = Math.min(rank, C.p50.length) - 1, a50f = C.p50[idx];             // FULL 2dp p50 → exact rw
    var rw = pyRound(a50f * EP.dollar_per_apwe), aff = EP.affine_ante + EP.affine_slope * rw, sf = epStartFloorM(pos, rank, EP);
    var pw = (EP.pos_dyn_w[pos] != null ? EP.pos_dyn_w[pos] : (EP.pos_dyn_w._default != null ? EP.pos_dyn_w._default : 0.8));
    return { a50: Math.round(a50f * 10) / 10, a90: Math.round(C.p90[idx] * 10) / 10, rw: rw, ep: pyRound(Math.max(sf, aff, (dw || 0) * pw)) };
  }
  function favEPM(d) { return d && d.meta && d.meta.model; }
  function favCanOvrM(r, EP) { return !r.o && EP && EP.curves && EP.curves[r.p] && r.fr; }
  function favDirChipM(cur, e0) { if (e0 == null) return ""; var d = cur - e0; if (Math.abs(d) < 1) return ""; var up = d > 0; return '<span class="ups-m-fav-dir ' + (up ? "up" : "down") + '">' + (up ? "▲" : "▼") + Math.abs(d) + '</span>'; }
  function favTiersM(tiers) {
    var blendW = function (r) { return Math.round((1 - state.favDynW) * (r.rw || 0) + state.favDynW * (r.dw || 0)); };
    var POS = ["QB", "RB", "WR", "TE"].filter(function (p) { return tiers[p]; });
    if (!POS.length) return '<div class="ups-m-auc-empty">No tier data.</div>';
    return '<div class="ups-m-fav-tiers">' + POS.map(function (pos) {
      var rows = tiers[pos];
      var cells = rows.map(function (r, i) {
        var worth = blendW(r), prevW = i > 0 ? blendW(rows[i - 1]) : null;
        var wdrop = (prevW && prevW > 0) ? Math.round(100 * (1 - worth / prevW)) : null;
        var pdrop = (i > 0 && rows[i - 1].ep > 0) ? Math.round(100 * (1 - r.ep / rows[i - 1].ep)) : null;
        var sweet = (wdrop != null && pdrop != null && pdrop - wdrop >= 18);
        return '<div class="ups-m-fav-tier' + (sweet ? ' sweet' : '') + '"><span class="ups-m-fav-tier-l">' + r.label + ' <i>' + pos + r.lo + '–' + r.hi + '</i></span>' +
          '<span class="ups-m-fav-tier-v">$' + worth + 'K→$' + r.ep + 'K' + (wdrop != null ? ' <b>▼' + wdrop + '%w·' + (pdrop || 0) + '%p</b>' : '') + (sweet ? ' 💡' : '') + '</span></div>';
      }).join("");
      return '<div class="ups-m-fav-tierpos">' + pos + '</div>' + cells;
    }).join("") + '</div>';
  }
  function fetchFaValue() {
    state.faValue = null;
    var fid = U.pad4(M.state.viewerFranchiseId || "0008");
    M.api.fetchJson(M.api.workerUrl("/api/auction/fa-value?franchise_id=" + fid))
      .then(function (d) { state.faValue = (d && d.ok) ? d : false; paint(); })
      .catch(function () { state.faValue = false; paint(); });
  }
  function favHelpExM(r, label) {
    var rw = r.rw || 0, dw = r.dw || 0, worth = Math.round(0.5 * rw + 0.5 * dw), price = r.e || 0, gap = price - worth;
    var read = gap <= -3 ? ('$' + (-gap) + 'K bargain') : gap >= 3 ? ('$' + gap + 'K premium') : 'about right';
    return '<div class="ups-m-fav-help-ex"><b>' + label + ':</b> ' + U.escapeHtml(r.n) + ' <span class="ups-m-fav-rk">' + U.escapeHtml(r.dr) + '</span><br>' +
      'production ' + (r.a50 || 0) + ' wins → $' + rw + 'K · dynasty $' + dw + 'K → <b>worth $' + worth + 'K</b><br>' +
      'price $' + price + 'K → gap ' + (gap > 0 ? '+' : '') + gap + 'K (' + read + ')</div>';
  }
  function favHelpM(d) {
    var ex = ["QB", "RB", "WR", "TE"].map(function (pos) {
      var pool = (d.fas || []).filter(function (r) { return !r.o && r.p === pos; }).sort(function (a, b) { return ((b.rw || 0) + (b.dw || 0)) - ((a.rw || 0) + (a.dw || 0)); });
      if (!pool.length) return "";
      var mid = pool.slice(7, 14)[0] || pool[Math.min(9, pool.length - 1)];
      return '<div class="ups-m-fav-help-pos"><h4>' + pos + '</h4>' + favHelpExM(pool[0], "Best") + favHelpExM(mid, "Mid-tier") + '</div>';
    }).join("");
    return '<button type="button" id="ups-m-fav-help-back" class="ups-m-fav-pospill active" style="width:100%;margin-bottom:10px">← Back to the board</button>' +
      '<div class="ups-m-fav-help">' +
      '<h3>How to read this board</h3>' +
      '<p>Every player has two numbers: what he\'s <b>WORTH</b> and what he\'ll <b>PRICE</b>. The difference is your bargain or overpay.</p>' +
      '<h4>WORTH</h4><p><b>Production</b> = how many "all-play wins" his weekly scores would earn (his score vs all 11 teams, all season). <b>Dynasty</b> = how good an asset he is to own/trade (KTC consensus). The <b>slider</b> mixes them.</p>' +
      '<h4>PRICE</h4><p>Free agents: what they clear for at the auction. Trade targets: their contract <b>AAV</b> (what you take on).</p>' +
      '<h4>GAP</h4><p>price − worth. Green (negative) = bargain. Red (positive) = you pay extra for the position.</p>' +
      '<h4>INFLATION</h4><p>Cheap contracts leave leftover cap chasing few players → prices rise. The gauge tracks it live.</p>' +
      '<h4 style="margin-top:12px">Examples — best vs mid-tier (50/50 blend)</h4>' + ex + '</div>';
  }
  function favnk(s) { return String(s || "").toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim(); }
  // LIVE auction overlay (mobile): reuse the already-loaded state.lots → sold/active + calibration.
  function favLiveStateM(d) {
    var lots = (state.lots && state.lots.lots) || [];
    if (!Array.isArray(lots)) lots = [];
    var sold = {}, active = {}, nSold = 0, nActive = 0, cal = [];
    var epByName = {}; (d.fas || []).forEach(function (p) { if (!p.o) epByName[favnk(p.n)] = p.e || 0; });
    lots.forEach(function (l) {
      var nm = favnk(l.player_name || l.player || l.name || ""), st = String(l.status || "").toLowerCase();
      var price = (l.winning_bid_k != null ? l.winning_bid_k : (l.final_bid_k != null ? l.final_bid_k : l.current_high_bid_k)) || 0;
      if (st === "won" || st === "closed" || st === "expired") { sold[nm] = price; nSold++; var m = epByName[nm]; if (m && price > 0) cal.push(price / m); }
      else if (st === "open" || st === "active") { active[nm] = price; nActive++; }
    });
    cal.sort(function (a, b) { return a - b; });
    var factor = cal.length >= 3 ? Math.round(cal[Math.floor(cal.length / 2)] * 100) / 100 : null;
    var isLive = nActive > 0; if (!isLive) { sold = {}; active = {}; factor = null; }
    return { live: isLive, sold: sold, active: active, nSold: isLive ? nSold : 0, nActive: nActive, factor: factor };
  }
  function renderFaValue() {
    if (state.faValue === undefined) { fetchFaValue(); return '<div class="ups-m-loading">Loading FA value…</div>'; }
    if (state.faValue === null) return '<div class="ups-m-loading">Loading FA value…</div>';
    if (state.faValue === false) return '<div class="ups-m-auc-empty">FA value board unavailable (commish-only).</div>';
    var d = state.faValue, infl = (d.meta || {}).inflation || {};
    if (state.favHelp) return favHelpM(d);
    var live = favLiveStateM(d);
    var owned = state.favOwn === "rostered";
    var rows = (d.fas || []).filter(function (r) { return owned ? r.o : !r.o; });
    if (state.favPos !== "ALL") rows = rows.filter(function (r) { return r.p === state.favPos; });
    // trade targets price off their contract AAV (not in the auction); FAs price off the inflated EP.
    var EP = favEPM(d);
    rows.forEach(function (r) {
      // pristine snapshot (once) so an ADP override is reversible without a re-fetch; restore + re-apply each pass.
      if (r._ep0 == null) { r._ep0 = r.e; r._rw0 = r.rw; r._a500 = r.a50; r._a900 = r.a90; }
      r.rw = r._rw0; r.a50 = r._a500; r.a90 = r._a900;
      // override = YOUR read → moves WORTH only; the expected PRICE (r.e) stays at the MARKET's read, so
      // the widened gap is your edge. r._ovrEP = what he'd cost IF the market agreed with you.
      var ov = favCanOvrM(r, EP) ? state.favRankOvr[r.n] : null; r._ovrEP = null;
      if (ov != null) { var res = epRecomputeM(r.p, ov, r.dw, EP); if (res) { r.rw = res.rw; r.a50 = res.a50; r.a90 = res.a90; r._ovrEP = res.ep; } }
      r._ovr = ov;
      r._w = favWorthM(r); r._price = r.o ? (r.av || 0) : (r.e || 0); r._gap = r._price - r._w;
      var v = favVerdictM(r._w, r._price, r.a90); r._vlab = v[0]; r._vcls = v[1];
      if (!r.o) { var nk = favnk(r.n); r._sold = live.sold[nk]; r._active = live.active[nk]; r._liveEP = (live.factor && r._sold == null && r._active == null) ? Math.round((r.e || 0) * live.factor) : null; }
    });
    rows.sort(function (a, b) { return (b._w || 0) - (a._w || 0); });
    rows = rows.slice(0, 60);
    var pct = Math.round(state.favDynW * 100);
    var liveLine = live.live
      ? '<div class="ups-m-fav-liveline on">🔴 LIVE · ' + live.nSold + ' sold · ' + live.nActive + ' active' + (live.factor ? ' · room ' + live.factor.toFixed(2) + '× model' : '') + '</div>'
      : '<div class="ups-m-fav-liveline">⚪ auction not live — opens late July</div>';
    var inflStrip = liveLine + '<div class="ups-m-fav-infl"><div class="ups-m-fav-infl-x">' + ((infl.board_markup || 1).toFixed(2)) + '×</div>' +
      '<div class="ups-m-fav-infl-t"><b>v4 clearing line</b> · $' + (infl.ante || 0) + 'K + ' + (infl.slope || 0) + '·worth<br>biddable $' + (infl.biddable_money_k || 0) + 'K vs pool $' + (infl.credible_value_k || 0) + 'K · locked surplus $' + (infl.surplus_k || 0) + 'K</div>' +
      '<button type="button" id="ups-m-fav-help-btn" class="ups-m-fav-help-q" title="How does this work?">?</button></div>';
    var blend = '<div class="ups-m-fav-blend"><div class="ups-m-fav-blend-h">Worth blend — win-now <b>' + (100 - pct) + '</b> / dynasty <b>' + pct + '</b></div>' +
      '<input type="range" id="ups-m-fav-blend" min="0" max="100" step="5" value="' + pct + '"></div>';
    var ownToggle = '<div class="ups-m-fav-pos">' + [["available", "Available FAs"], ["rostered", "Trade targets"]].map(function (o) {
      return '<button type="button" class="ups-m-fav-pospill' + (state.favOwn === o[0] ? ' active' : '') + '" data-favown="' + o[0] + '">' + o[1] + '</button>';
    }).join("") + '</div>';
    var pills = '<div class="ups-m-fav-pos">' + ["ALL", "QB", "RB", "WR", "TE"].map(function (p) {
      return '<button type="button" class="ups-m-fav-pospill' + (state.favPos === p ? ' active' : '') + '" data-favpos="' + p + '">' + p + '</button>';
    }).join("") + '<button type="button" class="ups-m-fav-pospill' + (state.favTiers ? ' active' : '') + '" data-favtiers="1">📊</button></div>';
    if (state.favTiers) return inflStrip + blend + ownToggle + pills + favTiersM((d.meta || {}).tiers || {});
    var cards = rows.map(function (r) {
      var gapCls = r._gap <= -3 ? 'pos' : (r._gap >= 3 ? 'neg' : '');
      var rkHtml;
      if (favCanOvrM(r, EP)) {
        var shownRk = r._ovr != null ? (r.p + r._ovr) : r.fr;
        rkHtml = U.escapeHtml(r.dr) + ' · <span class="ups-m-fav-rankchip' + (r._ovr != null ? ' ovr' : '') + '" data-favrankn="' + U.escapeHtml(r.n) + '">' + U.escapeHtml(shownRk) + ' ✎' + (r._ovr != null ? '<span class="ups-m-fav-rankx" data-favrankxn="' + U.escapeHtml(r.n) + '">×</span>' : '') + '</span>';
      } else { rkHtml = U.escapeHtml(r.dr) + (r.fr ? ' · ' + U.escapeHtml(r.fr) : ''); }
      var head = '<div class="ups-m-fav-row' + (r._ovr != null ? ' ovr' : '') + '" data-favn="' + U.escapeHtml(r.n) + '">' +
        '<div class="ups-m-fav-nm"><b>' + U.escapeHtml(r.n) + '</b> <span class="ups-m-fav-rk">' + rkHtml + '</span>' +
        '<span class="ups-m-fav-v ' + r._vcls + '">' + r._vlab + '</span></div>' +
        '<div class="ups-m-fav-nums"><span class="ups-m-fav-w">$' + r._w + 'K</span><span class="ups-m-fav-arrow">→</span>' +
        (r._sold != null ? '<span class="ups-m-fav-e" style="text-decoration:line-through;color:var(--fg-muted)">SOLD $' + r._sold + 'K</span>'
          : r._active != null ? '<span class="ups-m-fav-e" style="color:#fbbf24">🔨 $' + r._active + 'K</span>'
            : r._liveEP != null ? '<span class="ups-m-fav-e">$' + r._liveEP + 'K<i> live</i></span>' + favDirChipM(r._liveEP, r._ep0)
              : '<span class="ups-m-fav-e">$' + r._price + 'K' + (r.o ? '<i> AAV · $' + (r.sl != null ? r.sl : r._price) + 'K now</i>' : '') + '</span>' + (r.o ? '' : favDirChipM(r._price, r._ep0))) +
        '<span class="ups-m-fav-gap ' + gapCls + '">' + (r._gap > 0 ? '+' : '') + r._gap + '</span></div></div>';
      var ct = r.contract || {}, aav = (ct.aav_k != null ? ct.aav_k : r.av), sal = (ct.sal_k != null ? ct.sal_k : r.sl),
        tcv = (ct.tcv_k != null ? ct.tcv_k : r.tcv), cl = (ct.cl != null ? ct.cl : r.cl);
      // back/front-loaded read off this-year cap hit vs the smoothed AAV (JSN $1K now vs $23K AAV = back-loaded)
      var shape = (sal != null && aav) ? (sal < aav * 0.7 ? ' · ⚠ back-loaded' : (sal > aav * 1.3 ? ' · front-loaded' : '')) : '';
      var priceLine = r.o
        ? 'this yr <b>$' + (sal != null ? sal : r._price) + 'K</b> · AAV <b>$' + (aav != null ? aav : r._price) + 'K</b>/yr' + (tcv ? ' · total $' + tcv + 'K' : '') + (cl ? ' / ' + cl + 'yr' : '') + shape + '<br>worth $' + r._w + 'K vs AAV → ' + (r._gap <= 0 ? '<b>$' + (-r._gap) + 'K surplus</b>' : '<b>$' + r._gap + 'K over</b>')
        : 'price <b>$' + r._price + 'K</b> <span style="color:var(--fg-muted)">(market\'s read)</span> · gap <b>' + (r._gap > 0 ? '+' : '') + r._gap + 'K</b>'
          + (r._ovr != null ? '<br><i>✎ your ' + r.p + r._ovr + ' vs market ' + U.escapeHtml(r.fr) + ': worth $' + r._w + 'K, still clears ~$' + r._price + 'K' + (r._gap < 0 ? ' → $' + (-r._gap) + 'K edge' : '') + (r._ovrEP != null ? ' (if market agreed: ~$' + r._ovrEP + 'K)' : '') + '</i>' : '');
      var detail = state.favOpen[r.n] ? '<div class="ups-m-fav-detail">redraft (production) <b>$' + (r.rw || 0) + 'K</b> · dynasty (asset) <b>$' + (r.dw || 0) + 'K</b><br>' +
        'all-play wins: proj <b>' + (r.a50 || 0) + '</b> · ceiling <b>' + (r.a90 || 0) + '</b><br>' + priceLine + '</div>' : '';
      return '<div class="ups-m-fav-card">' + head + detail + '</div>';
    }).join("");
    var nOvr = Object.keys(state.favRankOvr).length;
    var ovrLine = '<div class="ups-m-fav-ovrline">' + (nOvr
      ? '✎ <b>' + nOvr + '</b> ADP edit' + (nOvr > 1 ? 's' : '') + ' <button type="button" id="ups-m-fav-ovr-reset">reset all</button>'
      : 'Tap a FA\'s rank (e.g. <b>WR20 ✎</b>) to set your own ADP — raises his <b>worth</b>; price stays at the market\'s read, so the gap is your edge') + '</div>';
    return inflStrip + blend + ownToggle + pills + ovrLine + '<div class="ups-m-fav-list">' + (cards || '<div class="ups-m-auc-empty">No players.</div>') + '</div>';
  }
  function wireFaValue() {
    var bl = document.getElementById("ups-m-fav-blend");
    if (bl) bl.addEventListener("change", function () { state.favDynW = (+bl.value) / 100; paint(); });
    Array.prototype.forEach.call(document.querySelectorAll("[data-favpos]"), function (b) {
      b.addEventListener("click", function () { state.favPos = this.getAttribute("data-favpos"); paint(); });
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-favown]"), function (b) {
      b.addEventListener("click", function () { state.favOwn = this.getAttribute("data-favown"); paint(); });
    });
    var tt = document.querySelector("[data-favtiers]"); if (tt) tt.addEventListener("click", function () { state.favTiers = !state.favTiers; paint(); });
    var hb = document.getElementById("ups-m-fav-help-btn"); if (hb) hb.addEventListener("click", function () { state.favHelp = true; paint(); });
    var hbk = document.getElementById("ups-m-fav-help-back"); if (hbk) hbk.addEventListener("click", function () { state.favHelp = false; paint(); });
    // ADP override: tap a rank chip → number input → commit re-prices the FA (stopPropagation so the
    // card-expand tap below doesn't also fire). Typing the model's own rank clears the override.
    Array.prototype.forEach.call(document.querySelectorAll(".ups-m-fav-rankchip"), function (chip) {
      chip.addEventListener("click", function (e) {
        e.stopPropagation();
        if (chip.querySelector("input")) return;
        var n = chip.getAttribute("data-favrankn");
        var rr = ((state.faValue && state.faValue.fas) || []).filter(function (x) { return x.n === n; })[0];
        var modelRank = rr ? favRankIntM(rr.fr) : null;
        var cur = state.favRankOvr[n] != null ? state.favRankOvr[n] : modelRank;
        chip.innerHTML = '<input type="number" inputmode="numeric" min="1" max="80" value="' + (cur || "") + '" class="ups-m-fav-rankin" />';
        var inp = chip.querySelector("input"); inp.focus(); inp.select();
        var committed = false;
        var commit = function (apply) {
          if (committed) return; committed = true;
          if (apply) { var v = favRankIntM(inp.value); if (v && v >= 1 && v <= 80) { if (v === modelRank) delete state.favRankOvr[n]; else state.favRankOvr[n] = v; } }
          favSaveOvrM(); paint();
        };
        inp.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); commit(true); } else if (ev.key === "Escape") { ev.preventDefault(); commit(false); } });
        inp.addEventListener("blur", function () { commit(true); });
        inp.addEventListener("click", function (ev) { ev.stopPropagation(); });
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll(".ups-m-fav-rankx"), function (x) { x.addEventListener("click", function (e) { e.stopPropagation(); var n = x.getAttribute("data-favrankxn"); delete state.favRankOvr[n]; favSaveOvrM(); paint(); }); });
    var mra = document.getElementById("ups-m-fav-ovr-reset"); if (mra) mra.addEventListener("click", function () { state.favRankOvr = {}; favSaveOvrM(); paint(); });
    Array.prototype.forEach.call(document.querySelectorAll(".ups-m-fav-row"), function (b) {
      b.addEventListener("click", function () { var n = this.getAttribute("data-favn"); state.favOpen[n] = !state.favOpen[n]; paint(); });
    });
  }

  function renderSummary(tab, p) {
    if (tab === "era") {
      var eligCount = ((state.eraPool && state.eraPool.players) || []).length || (p.eligible_players || []).length;
      return kpis([["Live lots", (p.active_auctions || []).length], ["Eligible", eligCount], ["Your team", franchiseName(M.state.viewerFranchiseId)]]) +
        '<div class="ups-m-auc-note">The Expired-Rookie Auction claims players whose rookie deals expired. <strong>Players</strong> browses the eligible pool · <strong>Lots</strong> is the live board · <strong>Cadence</strong> shows nomination windows.</div>';
    }
    return kpis([["Live lots", (p.active_auctions || []).length], ["Available", (p.available_players || []).length], ["Your team", franchiseName(M.state.viewerFranchiseId)]]) +
      budgetsBlock(p) + needsBlock(p);
  }

  function flipName(n) { n = String(n || ""); var i = n.indexOf(", "); return i > 0 ? (n.slice(i + 2) + " " + n.slice(0, i)) : n; }
  function lastNameKey(name) { var p = String(name || "").trim().split(/\s+/); return (p.length > 1 ? p[p.length - 1] + " " + p[0] : name).toLowerCase(); }
  // Clickable player name → opens the unified player modal (M.sheet.open).
  function pname(pid, name) {
    return '<button type="button" class="ups-m-auc-pname" data-psheet="' + U.escapeHtml(String(pid || "")) + '">' + U.escapeHtml(name || ("Player #" + pid)) + '</button>';
  }
  // pid → prior-season fantasy points (full-season total), memoized. Falls back
  // to the app's current-year YTD if the prior-season fetch failed.
  function ytdScore(pid) {
    if (!state._ytd) {
      var m = {}, ps = state.priorScores || M.state.playerScoresYtd;
      U.asArray(ps && ps.playerScores && ps.playerScores.playerScore).forEach(function (r) { if (r && r.id) m[String(r.id)] = Number(r.score) || 0; });
      state._ytd = m;
    }
    return state._ytd[String(pid)] || 0;
  }
  // pid → ADP rank (FantasyCalc overall dynasty rank; lower = better). null = unranked.
  function adpRank(pid) {
    var m = state.adp && state.adp.by_mfl_id;
    var e = m && m[String(pid)];
    if (!e) return null;
    var r = Number(e.overall_rank);
    return isFinite(r) && r > 0 ? r : null;
  }
  var POS_ORDER = { QB: 1, RB: 2, WR: 3, TE: 4, PK: 5, K: 5, PN: 6, DL: 7, LB: 8, DB: 9 };
  // The full free-agent pool — every unrostered player (MFL freeAgents export),
  // enriched from the boot-loaded player DB + YTD points + ADP. Memoized.
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
      rows.push({ player_id: id, player_name: flipName(pl.name), position: pos, team: pl.team || "", model_value: modelById[id] || 0, ppg: ytdScore(id), adp: adpRank(id) });
    }
    state.faPool = rows;
    return rows;
  }
  function faaPool() {
    var p = state.faa || {};
    return poolBlock(faAllPlayers(), "free-agent", {
      title: "Free Agents", enabled: !!p.enabled, teamKey: "team",
      subOf: function (r) {
        // Show ADP + last-season points consistently, leading with whatever
        // the list is sorted by (so the ADP sort shows ADP for everyone).
        var ppg = r.ppg ? Math.round(r.ppg) + " pts" : "";
        var adp = r.adp ? "ADP " + r.adp : "";
        var arr = state.poolSort === "adp" ? [adp, ppg] : [ppg, adp];
        return arr.filter(Boolean).join(" · ");
      }
    });
  }
  // Player ids in the ERA eligible pool — used to split lots/bids by auction
  // (expired rookies → ERA, everyone else → FA), since lots aren't kind-tagged.
  function eraPoolIds() {
    var ids = {}, ps = (state.eraPool && state.eraPool.players) || [];
    for (var i = 0; i < ps.length; i++) ids[String(ps[i].player_id)] = true;
    return ids;
  }
  // Per-player auction status, from the live board (active) + lots ledger (won).
  function statusIndex() {
    if (state._statusIdx) return state._statusIdx;
    var active = {}, done = {};
    ((state.faa && state.faa.active_auctions) || []).concat((state.era && state.era.active_auctions) || []).forEach(function (l) {
      active[String(l.player_id)] = { high_k: Math.round(toNum(l.high_bid_amount) / 1000) };
    });
    ((state.lots && state.lots.lots) || []).forEach(function (l) {
      if (l.status === "open") { if (!active[String(l.player_id)]) active[String(l.player_id)] = { high_k: Number(l.current_high_bid_k) || 0 }; }
      else if (l.status === "won" || l.status === "expired" || l.status === "closed") done[String(l.player_id)] = l;
    });
    state._statusIdx = { active: active, done: done };
    return state._statusIdx;
  }
  function poolPhase(tab) {
    var p = tab === "era" ? state.era : state.faa;
    if (p && p.enabled) return "live";
    return Object.keys(statusIndex().done).length ? "closed" : "upcoming";
  }
  // → { key, label, high_k }. key ∈ available | active | won | closed.
  function statusOf(pid, phase) {
    var idx = statusIndex(), id = String(pid);
    if (idx.active[id]) return { key: "active", label: "Active", high_k: idx.active[id].high_k || 0 };
    var lot = idx.done[id];
    if (lot) {
      if (lot.status === "won") return { key: "won", label: "Won · " + U.escapeHtml(lot.winner_name || lot.current_high_bidder_name || "—") };
      return { key: "closed", label: "Closed" };
    }
    return { key: "available", label: phase === "closed" ? "Not nominated" : "Available" };
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
          origin_label: r.origin_label, ppg_weighted: r.ppg_weighted, high_bid_k: r.high_bid_k, prior_owner: r.prior_owner,
          ppg: Number(r.ppg_weighted) || ytdScore(r.player_id), adp: adpRank(r.player_id)
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
          '<div class="ups-m-auc-name">' + posChip(r.position) + pname(r.player_id, r.player_name) + '</div>' +
          '<div class="ups-m-auc-meta">High <strong>' + money(r.high_bid_amount) + '</strong>' +
            (r.high_bidder_label ? ' · ' + U.escapeHtml(r.high_bidder_label) : '') +
            (r.timer_text ? ' · ' + U.escapeHtml(r.timer_text) : '') + '</div>' +
        '</div>' +
        '<div class="ups-m-auc-card-cta">' + cta + '</div>' +
      '</div>';
    }).join("");
    return html;
  }

  var POS_CHIPS = ["ALL", "QB", "RB", "WR", "TE", "PK", "PN", "IDP"];
  var STATUS_CHIPS = [["all", "All"], ["available", "Open"], ["active", "Active"], ["won", "Won"]];
  // Pool list with search + position/team/status filters + sort + clickable
  // names. The list ALWAYS shows (browse anytime). Per-player status (Won/Active/
  // Not-nominated) drives the badge + which CTA (Bid / Nominate / none) appears.
  function poolBlock(rows, kind, cfg) {
    var tab = kind === "expired-rookie" ? "era" : "faa";
    var phase = poolPhase(tab);
    var teamKey = cfg.teamKey || "team";
    function teamOf(r) { return String(r.nfl_team || r[teamKey] || r.team || ""); }
    var s = (state.search || "").toLowerCase(), pos = state.poolPos || "ALL", team = state.poolTeam || "", sort = state.poolSort || "name", statusF = state.poolStatus || "all";
    var teamSet = {}; rows.forEach(function (r) { var t = teamOf(r); if (t) teamSet[t] = true; });
    var teamOpts = Object.keys(teamSet).sort();
    var filtered = rows.map(function (r) { r._st = statusOf(r.player_id, phase); return r; }).filter(function (r) {
      if (pos !== "ALL" && posBucket(r.position) !== pos) return false;
      if (team && teamOf(r) !== team) return false;
      if (statusF !== "all" && r._st.key !== statusF) return false;
      if (s && [r.player_name, r.position, teamOf(r), r.player_id].join(" ").toLowerCase().indexOf(s) === -1) return false;
      return true;
    }).sort(function (a, b) {
      if (sort === "ppg") return (Number(b.ppg) || 0) - (Number(a.ppg) || 0) || lastNameKey(a.player_name).localeCompare(lastNameKey(b.player_name));
      if (sort === "adp") return ((a.adp == null ? 1e9 : a.adp) - (b.adp == null ? 1e9 : b.adp)) || lastNameKey(a.player_name).localeCompare(lastNameKey(b.player_name));
      return lastNameKey(a.player_name).localeCompare(lastNameKey(b.player_name));
    });
    var openLbl = phase === "closed" ? "Not nom." : "Open";
    var controls =
      '<input type="search" class="ups-m-auc-search" id="ups-m-auc-search" placeholder="Search players…" value="' + U.escapeHtml(state.search || "") + '" />' +
      '<div class="ups-m-auc-poolctl">' +
        '<select class="ups-m-auc-sel" id="ups-m-auc-sort">' +
          '<option value="name"' + (sort === "name" ? " selected" : "") + '>Sort · Name</option>' +
          '<option value="ppg"' + (sort === "ppg" ? " selected" : "") + '>Sort · PPG</option>' +
          '<option value="adp"' + (sort === "adp" ? " selected" : "") + '>Sort · ADP</option>' +
        '</select>' +
        '<select class="ups-m-auc-sel" id="ups-m-auc-team">' +
          '<option value="">All NFL teams</option>' +
          teamOpts.map(function (t) { return '<option value="' + U.escapeHtml(t) + '"' + (team === t ? " selected" : "") + '>' + U.escapeHtml(t) + '</option>'; }).join("") +
        '</select>' +
      '</div>' +
      '<div class="ups-m-auc-poschips" id="ups-m-auc-poschips">' +
        POS_CHIPS.map(function (pc) { return '<button type="button" class="ups-m-auc-poschip' + (pos === pc ? " active" : "") + '" data-pos="' + pc + '">' + pc + '</button>'; }).join("") +
      '</div>' +
      '<div class="ups-m-auc-poschips" id="ups-m-auc-statuschips">' +
        STATUS_CHIPS.map(function (sc) { var lbl = sc[0] === "available" ? openLbl : sc[1]; return '<button type="button" class="ups-m-auc-poschip' + (statusF === sc[0] ? " active" : "") + '" data-status="' + sc[0] + '">' + lbl + '</button>'; }).join("") +
      '</div>';
    var html = '<div class="ups-m-auc-sec-head">' + cfg.title + ' <span class="ct">' + rows.length + '</span></div>' +
      controls + '<div class="ups-m-auc-pool" id="ups-m-auc-pool">';
    if (!filtered.length) { html += '<div class="ups-m-auc-empty">' + (s || pos !== "ALL" || team || statusF !== "all" ? "No players match." : "No players in the pool yet.") + '</div>'; }
    else html += filtered.slice(0, 80).map(function (r) {
      var st = r._st, metric = cfg.subOf(r);
      var badge =
        st.key === "won" ? '<span class="stb won">' + st.label + '</span>' :
        st.key === "active" ? '<span class="stb active">Active</span>' :
        st.key === "closed" ? '<span class="stb closed">Closed</span>' :
        (phase === "closed" ? '<span class="stb na">Not nominated</span>' : '');
      var metaBits = [];
      if (badge) metaBits.push(badge);
      // Hide the metric once a player is off the board (won/closed) — it's noise.
      if (metric && st.key !== "won" && st.key !== "closed") metaBits.push(metric);
      var cta = "";
      if (st.key === "active") {
        cta = '<button type="button" class="btn-act myac ups-m-auc-bid-btn" data-action="bid" data-pid="' + U.escapeHtml(String(r.player_id || "")) +
          '" data-name="' + U.escapeHtml(r.player_name || "") + '" data-kind="' + kind + '" data-high="' + (st.high_k || 0) + '">Bid</button>';
      } else if (st.key === "available" && cfg.enabled) {
        cta = '<button type="button" class="btn-act myac ups-m-auc-bid-btn" data-action="nominate" data-pid="' + U.escapeHtml(String(r.player_id || "")) +
          '" data-name="' + U.escapeHtml(r.player_name || "") + '" data-kind="' + kind + '" data-high="0">Nominate</button>';
      }
      return '<div class="ups-m-auc-card">' +
        '<div class="ups-m-auc-card-main">' +
          '<div class="ups-m-auc-name">' + posChip(r.position) + pname(r.player_id, r.player_name) +
            (teamOf(r) ? ' <span class="ups-m-auc-team">' + U.escapeHtml(teamOf(r)) + '</span>' : '') + '</div>' +
          (metaBits.length ? '<div class="ups-m-auc-meta">' + metaBits.join(' · ') + '</div>' : '') +
        '</div>' +
        (cta ? '<div class="ups-m-auc-card-cta">' + cta + '</div>' : '') +
      '</div>';
    }).join("");
    if (filtered.length > 80) html += '<div class="ups-m-auc-empty">Showing 80 of ' + filtered.length + ' — refine with search or filters.</div>';
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
      '<div class="ups-m-auc-sec-head">Nomination Tracker <span class="ct">' + ooc + ' owe noms</span></div>' +
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
    return '<div class="ups-m-auc-sec-head">Team Budgets <span class="ct">most you can spend on one player + still field a legal roster</span></div>' +
      '<div class="ups-m-auc-table">' +
        '<div class="ups-m-auc-trow head"><span>Team</span><span>Funds</span><span>27-man</span><span>35-man</span></div>' +
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
          '<div class="ups-m-auc-name">' + posChip(l.position) + pname(l.player_id, l.player_name) +
            (l.nfl_team ? ' <span class="ups-m-auc-team">' + U.escapeHtml(l.nfl_team) + '</span>' : '') + '</div>' +
          '<div class="ups-m-auc-meta">' + (won
            ? 'Won by <strong>' + U.escapeHtml(l.winner_name || l.current_high_bidder_name || "—") + '</strong> · ' + fmtK(l.current_high_bid_k) + ' · ' + (Number(l.bid_count) || 0) + ' bids'
            : '<span class="ups-m-auc-won">' + U.escapeHtml((l.status || "closed").replace(/^\w/, function (c) { return c.toUpperCase(); })) + '</span>') + '</div>' +
        '</div>' +
      '</div>';
    }).join("");
  }
  function fmtDateTime(iso) {
    if (!iso) return "";
    try {
      var d = new Date(iso);
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " +
             d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    } catch (e) { return ""; }
  }
  // Bid History — collapsible per-player threads (split by auction). The summary
  // shows the player + bid count + top bid; tap to expand the full timestamped
  // sequence. Tap the name for the player modal.
  function renderHistory(tab) {
    var isEra = tab === "era";
    var eIds = eraPoolIds();
    var bids = ((state.bidHistory && state.bidHistory.bids) || []).filter(function (b) { return !!eIds[String(b.player_id)] === isEra; });
    var head = '<div class="ups-m-auc-sec-head">Bid History <span class="ct">' + bids.length + '</span></div>';
    if (!bids.length) return head + '<div class="ups-m-auc-empty">No bids yet.</div>';
    var groups = {};
    bids.forEach(function (b) {
      var key = String(b.lot_id || ("p" + b.player_id));
      if (!groups[key]) groups[key] = { key: key, player_id: b.player_id, player_name: b.player_name, position: b.position, bids: [] };
      groups[key].bids.push(b);
    });
    var threads = Object.keys(groups).map(function (k) { return groups[k]; });
    threads.forEach(function (t) {
      t.bids.sort(function (a, b) { return (Number(a.bid_at_unix) || 0) - (Number(b.bid_at_unix) || 0); });
      t.lastUnix = Number(t.bids[t.bids.length - 1].bid_at_unix) || 0;
      t.topK = t.bids.reduce(function (m, x) { return Math.max(m, Number(x.bid_k) || 0); }, 0);
      // Classify by walking the thread: a bid by the SAME franchise as the
      // prior high bid is a "Forced" increase (MFL walked their hidden proxy up
      // because someone bid into it). Different franchise = a normal Bid.
      var prevFid = null;
      t.bids.forEach(function (b) {
        b._cls = b.is_nomination ? "nom" : (prevFid != null && String(prevFid) === String(b.fid) ? "forced" : "bid");
        prevFid = b.fid;
      });
      t.forcedCount = t.bids.filter(function (b) { return b._cls === "forced"; }).length;
    });
    threads.sort(function (a, b) { return b.lastUnix - a.lastUnix; });
    return head + '<div class="ups-m-auc-threads">' + threads.map(function (t) {
      var open = !!state.openThreads[t.key];
      var detail = open ? '<div class="ups-m-auc-thbids">' + t.bids.slice().reverse().map(function (b) {
        var kind = b._cls === "nom" ? '<span class="nom">Nom</span>'
          : b._cls === "forced" ? '<span class="forced" title="Forced increase — their proxy was walked up">Forced ↑</span>'
          : '<span class="bid">Bid</span>';
        return '<div class="thbid">' + kind + ' <strong>' + fmtK(b.bid_k) + '</strong> · ' + U.escapeHtml(b.franchise_name || "—") +
          '<span class="hw">' + fmtDateTime(b.bid_at_iso) + '</span></div>';
      }).join("") + '</div>' : '';
      return '<div class="ups-m-auc-thread' + (open ? " open" : "") + '">' +
        '<div class="ups-m-auc-thsum" data-thread="' + U.escapeHtml(t.key) + '">' +
          '<span class="thtog">' + (open ? "▾" : "▸") + '</span>' +
          posChip(t.position) + pname(t.player_id, t.player_name) +
          '<span class="thmeta">' + t.bids.length + ' ' + (t.bids.length === 1 ? "bid" : "bids") + (t.forcedCount ? ' · ' + t.forcedCount + ' forced' : '') + ' · top ' + fmtK(t.topK) + '</span>' +
        '</div>' + detail +
      '</div>';
    }).join("") + '</div>';
  }

  // One per-team nomination view. FAA = the compliance scoreboard (who still
  // owes noms + roster status); ERA = the nomination windows.
  function renderTracker(tab) {
    return tab === "faa" ? renderSchedule() : renderCadence(tab);
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
    return '<div class="ups-m-auc-sec-head">Nomination Windows</div>' +
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
  function poolHtml() { return state.tab === "era" ? eraPool() : faaPool(); }
  // Search re-renders just the list (preserves input focus); the sort/team/pos
  // controls re-render the whole pool view (so their own state updates too).
  function replacePoolList() {
    var pool = document.getElementById("ups-m-auc-pool");
    if (!pool) { repaintPlayers(); return; }
    var tmp = document.createElement("div"); tmp.innerHTML = poolHtml();
    var np = tmp.querySelector("#ups-m-auc-pool");
    if (np && pool.parentNode) { pool.parentNode.replaceChild(np, pool); wireBidButtons(); }
  }
  function repaintPlayers() {
    var tb = document.querySelector(".ups-m-auc-tabbody");
    if (!tb) { paint(); return; }
    tb.innerHTML = poolHtml();
    wirePool(); wireBidButtons();
  }
  function wirePool() {
    var inp = document.getElementById("ups-m-auc-search");
    if (inp) inp.addEventListener("input", function () { state.search = this.value || ""; replacePoolList(); });
    var sortSel = document.getElementById("ups-m-auc-sort");
    if (sortSel) sortSel.addEventListener("change", function () { state.poolSort = this.value; repaintPlayers(); });
    var teamSel = document.getElementById("ups-m-auc-team");
    if (teamSel) teamSel.addEventListener("change", function () { state.poolTeam = this.value; repaintPlayers(); });
    Array.prototype.forEach.call(document.querySelectorAll(".ups-m-auc-poschip[data-pos]"), function (b) {
      b.addEventListener("click", function () { state.poolPos = this.getAttribute("data-pos"); repaintPlayers(); });
    });
    Array.prototype.forEach.call(document.querySelectorAll(".ups-m-auc-poschip[data-status]"), function (b) {
      b.addEventListener("click", function () { state.poolStatus = this.getAttribute("data-status"); repaintPlayers(); });
    });
  }
  // History thread expand/collapse.
  function wireThreads() {
    Array.prototype.forEach.call(document.querySelectorAll(".ups-m-auc-thsum"), function (b) {
      b.addEventListener("click", function () {
        var k = this.getAttribute("data-thread");
        if (!k) return;
        state.openThreads[k] = !state.openThreads[k];
        paint();
      });
    });
  }
  // Delegated: tap any player name → the unified player modal. stopPropagation
  // so a name inside a history thread doesn't also toggle the thread.
  function wirePlayerModal() {
    var body = document.getElementById("ups-m-auction-body");
    if (!body || body.__modalWired) return; body.__modalWired = true;
    // Capture phase → fires before the thread-row toggle, so stopPropagation
    // keeps a name-tap inside a history thread from also expanding it.
    body.addEventListener("click", function (e) {
      var btn = e.target && e.target.closest ? e.target.closest("[data-psheet]") : null;
      if (!btn) return;
      e.stopPropagation();
      var pid = btn.getAttribute("data-psheet");
      if (pid && M.sheet && M.sheet.open) M.sheet.open(pid);
    }, true);
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
