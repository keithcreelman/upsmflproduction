/* League → Trade view (mobile mirror of Trade War Room offer list).
 *
 * Phase 1: surfaces the viewer's incoming + outgoing offers from
 * /api/trades/proposals, with inline Accept / Decline / Cancel
 * controls. Building NEW offers from scratch on mobile is deferred
 * (the desktop Trade War Room has a complex player/pick picker
 * across two columns; mobile gets a deep-link to the desktop view
 * for now).
 *
 * Worker endpoints used (verbatim from desktop trade_workbench.js):
 *   GET  /api/trades/proposals?L=<lid>&franchise_id=<fid>
 *   POST /api/trades/proposals/action  (accept / decline / cancel)
 */
(function () {
  "use strict";
  if (!window.UPS_MOBILE) return;
  var M = window.UPS_MOBILE;
  var U = M.util;

  var state = { offers: null, loading: false, error: null };

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
    var f = (M.state.franchises || []).find(function (x) { return x.id === U.pad4(fid); });
    return f ? f.name : ("Team " + fid);
  }

  function loadOffers() {
    if (state.loading) return Promise.resolve();
    if (!M.state.viewerFranchiseId) return Promise.resolve();
    state.loading = true; state.error = null;
    // Listing offers reads MFL's pendingTrades AS THE OWNER — forward
    // MFL_USER_ID + YEAR or the worker returns 401/empty (the just-created
    // offer is in MFL but won't render). Same pattern as the write paths.
    var url = M.api.workerUrl("/api/trades/proposals?L=" +
      encodeURIComponent(M.state.ctx.leagueId) +
      "&YEAR=" + encodeURIComponent(M.state.ctx.year) +
      "&franchise_id=" + encodeURIComponent(M.state.viewerFranchiseId));
    var stored = M.api.getStoredMflUserId && M.api.getStoredMflUserId();
    if (stored) url += "&MFL_USER_ID=" + encodeURIComponent(stored);
    return fetch(url, { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        state.offers = data || { incoming: [], outgoing: [] };
        state.loading = false;
      })
      .catch(function (err) {
        state.error = (err && err.message) || String(err);
        state.loading = false;
      });
  }

  // Render a list of offer rows.
  function renderOffersList(offers, direction) {
    if (!offers || !offers.length) {
      return '<div class="ups-m-stub"><div>No ' + direction + ' offers.</div></div>';
    }
    return offers.map(function (o) {
      return renderOfferCard(o, direction);
    }).join("");
  }

  // Parse the trade-asset CSV (same shape as tradeBait — pids + DP_/FP_/BB_).
  function describeAssetCsv(csv) {
    var tokens = U.safeStr(csv).split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    return tokens.map(function (t) {
      return M.data.describeTradeBaitToken
        ? M.data.describeTradeBaitToken(t)
        : t;
    });
  }

  function renderOfferCard(offer, direction) {
    // offer fields (defensive against shape drift):
    //   trade_id / id
    //   offered_by / from_franchise_id, offered_to / to_franchise_id
    //   offered_assets / will_give_up_a (CSV)
    //   requested_assets / will_give_up_b (CSV)
    //   note / message / comments
    //   timestamp / submitted_at
    var tradeId = U.safeStr(offer.trade_id || offer.id || "");
    var fromFid = U.pad4(offer.offered_by || offer.from_franchise_id || offer.franchise_id || "");
    var toFid = U.pad4(offer.offered_to || offer.to_franchise_id || "");
    // The worker (normalizePendingProposal) sends `will_give_up` / `will_receive`
    // CSVs from the OFFERING franchise's perspective. Outgoing: you = the
    // offerer, so you give `will_give_up` and get `will_receive`. Incoming: you
    // = the recipient, so it flips. (Older `*_assets`/`*_give` names kept as
    // fallbacks in case the shape ever changes.)
    var myAssetsCsv = direction === "incoming"
      ? (offer.will_receive || offer.requested_assets || offer.will_give_up_b || offer.you_give || "")
      : (offer.will_give_up || offer.offered_assets || offer.will_give_up_a || offer.you_give || "");
    var theirAssetsCsv = direction === "incoming"
      ? (offer.will_give_up || offer.offered_assets || offer.will_give_up_a || offer.they_give || "")
      : (offer.will_receive || offer.requested_assets || offer.will_give_up_b || offer.they_give || "");
    var note = U.safeStr(offer.note || offer.message || offer.comments || "");
    var other = direction === "incoming" ? fromFid : toFid;

    var myAssets = describeAssetCsv(myAssetsCsv);
    var theirAssets = describeAssetCsv(theirAssetsCsv);

    var actionsHtml = '';
    if (direction === "incoming") {
      actionsHtml = '<div class="ups-m-trade-actions">' +
        '<button class="btn-act otb on" data-act="accept" data-trade-id="' + U.escapeHtml(tradeId) + '">Accept</button>' +
        '<button class="btn-act drop" data-act="decline" data-trade-id="' + U.escapeHtml(tradeId) + '">Decline</button>' +
      '</div>';
    } else {
      actionsHtml = '<div class="ups-m-trade-actions">' +
        '<button class="btn-act" data-act="cancel" data-trade-id="' + U.escapeHtml(tradeId) + '">Cancel offer</button>' +
      '</div>';
    }

    return '<div class="ups-m-card">' +
      '<div class="ups-m-card-title">' +
        (direction === "incoming" ? "From: " : "To: ") + U.escapeHtml(franchiseName(other)) +
      '</div>' +
      '<div class="ups-m-trade-cols">' +
        '<div class="ups-m-trade-col">' +
          '<div class="lbl">' + (direction === "incoming" ? "You give" : "You give") + '</div>' +
          (myAssets.length
            ? '<ul>' + myAssets.map(function (a) { return '<li>' + U.escapeHtml(a) + '</li>'; }).join("") + '</ul>'
            : '<div class="muted">—</div>') +
        '</div>' +
        '<div class="ups-m-trade-col">' +
          '<div class="lbl">You get</div>' +
          (theirAssets.length
            ? '<ul>' + theirAssets.map(function (a) { return '<li>' + U.escapeHtml(a) + '</li>'; }).join("") + '</ul>'
            : '<div class="muted">—</div>') +
        '</div>' +
      '</div>' +
      (note ? '<div class="ups-m-trade-note"><span class="lbl">Note:</span> ' + U.escapeHtml(note) + '</div>' : '') +
      actionsHtml +
    '</div>';
  }

  // Deep-link to desktop Trade War Room (MFL home MODULE=MESSAGE6=N with
  // twb_* params). Retained as an escape hatch for trades that include a
  // CURRENT-YEAR draft pick (DP_), which the native builder intentionally
  // doesn't offer (see the builder header comment).
  function buildTradeWarRoomUrl() {
    var ctx = M.state.ctx;
    var fid = U.pad4(M.state.viewerFranchiseId);
    var base = "https://www48.myfantasyleague.com/" + encodeURIComponent(ctx.year) +
               "/home/" + encodeURIComponent(ctx.leagueId);
    var qs = "MODULE=MESSAGE6%3DN";
    var hash = "twb_left_team=" + encodeURIComponent(fid) + "&twb_side=left";
    return base + "?" + qs + "#" + hash;
  }

  // ════════════════════ Native trade offer builder ════════════════════
  // Builds a proposal IN-APP and POSTs the SAME /api/trades/proposals payload
  // the desktop Trade War Room uses. Asset → MFL-token mapping mirrors the
  // worker's buildTradeProposalAssetLists (worker/src/index.js:18858):
  //   • Player        → token is the bare player_id  (type:"PLAYER")
  //   • Future pick   → FP_<origfid>_<year>_<round>   (type:"PICK")
  //   • Cap money     → set traded_salary_adjustment_k; the worker derives the
  //                     BB_ blind-bid token from the per-side net.
  // The two sides are role:"left" (me, giving) and role:"right" (them, giving
  // to me) — the worker keys on `role`.
  //
  // IMPORTANT: this creates a REAL, cancellable pending MFL offer — there is
  // NO dry-run for trade proposals. CURRENT-YEAR draft picks (DP_) are
  // deliberately NOT selectable: their MFL token is a 0-indexed re-encoding
  // that can't be safely confirmed without a dry-run, and a wrong-but-valid
  // token would silently propose the WRONG pick. Trade those on desktop via
  // the Trade War Room link instead.
  var builderState = null;
  function freshBuilderState() {
    return {
      step: 1, counterpartyFid: "",
      inv: {}, loadingInv: false, invError: "",
      giveIds: {}, getIds: {},
      myCapK: 0, theirCapK: 0,
      comment: "", submitting: false, error: ""
    };
  }

  function inventoryUrl(fid) {
    return M.api.workerUrl("/api/franchise-assets?L=" +
      encodeURIComponent(M.state.ctx.leagueId) + "&YEAR=" +
      encodeURIComponent(M.state.ctx.year) + "&fid=" + encodeURIComponent(U.pad4(fid)));
  }
  function loadInventoryFor(fid) {
    var key = U.pad4(fid);
    if (builderState.inv[key]) return Promise.resolve(builderState.inv[key]);
    return fetch(inventoryUrl(key), { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        var inv = {
          players: (data && data.players) || [],
          future_picks: (data && data.future_picks) || []
        };
        builderState.inv[key] = inv;
        return inv;
      });
  }

  function playerToSelectedAsset(p) {
    return {
      asset_id: "P_" + p.player_id, type: "PLAYER",
      player_id: String(p.player_id), player_name: p.display || null,
      description: null, position: p.position || null, nfl_team: p.nfl_team || null,
      salary: U.safeInt(p.salary, 0),
      years: (p.contract_year == null ? null : p.contract_year),
      contract_type: p.contract_status || null, contract_info: null,
      taxi: !!p.taxi,
      pick_key: null, pick_season: null, pick_round: null, pick_slot: null
    };
  }
  function futurePickToken(fp) {
    return "FP_" + U.pad4(fp.original_fid) + "_" + fp.year + "_" + fp.round;
  }
  function futurePickToSelectedAsset(fp) {
    var token = futurePickToken(fp);
    return {
      asset_id: token, type: "PICK",
      player_id: null, player_name: null,
      description: fp.display || (fp.year + " R" + fp.round),
      position: null, nfl_team: null, salary: 0, years: null,
      contract_type: null, contract_info: null, taxi: false,
      pick_key: token, pick_season: U.safeInt(fp.year, 0),
      pick_round: U.safeInt(fp.round, 0), pick_slot: null
    };
  }
  function selectedAssetsFor(fid, idMap) {
    var inv = builderState.inv[U.pad4(fid)] || { players: [], future_picks: [] };
    var out = [];
    (inv.players || []).forEach(function (p) {
      if (idMap["P_" + p.player_id]) out.push(playerToSelectedAsset(p));
    });
    (inv.future_picks || []).forEach(function (fp) {
      if (idMap[futurePickToken(fp)]) out.push(futurePickToSelectedAsset(fp));
    });
    return out;
  }
  function countSelected(idMap) {
    var n = 0; for (var k in idMap) { if (idMap[k]) n += 1; } return n;
  }

  // §A6 — the cap money a side may attach is ≤ 50% of the summed salary of the
  // NON-TAXI PLAYERS it trades away: floor(sumNonTaxiSalary / 2000) in $K.
  // Picks and taxi players don't unlock cap money, so a side with no non-taxi
  // player can attach $0 (this also enforces "can't send money-only / money +
  // pick only", league_context §A6). Mirrors the worker backstop
  // (worker/src/index.js:24939) and desktop getTradeSalaryMaxK.
  function maxCapKFor(fid, idMap) {
    var inv = builderState.inv[U.pad4(fid)] || { players: [] };
    var sum = 0;
    (inv.players || []).forEach(function (p) {
      if (idMap["P_" + p.player_id] && !p.taxi) sum += U.safeInt(p.salary, 0);
    });
    return Math.floor(sum / 2000);
  }

  // ── Overlay shell ──
  function openBuilder() {
    if (!M.state.viewerFranchiseId) { M.ui.showToast("Pick your franchise first.", "err"); return; }
    builderState = freshBuilderState();
    var existing = document.getElementById("ups-m-tb-overlay");
    if (existing) existing.remove();
    var html =
      '<div class="ups-m-drop-overlay" id="ups-m-tb-overlay">' +
        '<div class="ups-m-drop-sheet ups-m-tb-sheet">' +
          '<div class="ups-m-drop-head">' +
            '<button class="ups-m-drop-close" id="ups-m-tb-close" aria-label="Close">×</button>' +
            '<div class="grip"></div>' +
            '<div class="title">Build trade offer</div>' +
            '<div class="sub" id="ups-m-tb-stepsub"></div>' +
          '</div>' +
          '<div class="ups-m-drop-body" id="ups-m-tb-body"></div>' +
        '</div>' +
      '</div>';
    var mount = document.getElementById("ups-m-app");
    if (!mount) return;
    mount.insertAdjacentHTML("beforeend", html);
    document.body.style.overflow = "hidden";
    document.getElementById("ups-m-tb-close").addEventListener("click", closeBuilder);
    renderBuilder();
  }
  function closeBuilder() {
    var ov = document.getElementById("ups-m-tb-overlay");
    if (ov) ov.remove();
    document.body.style.overflow = "";
    builderState = null;
  }

  function renderBuilder() {
    var sub = document.getElementById("ups-m-tb-stepsub");
    var body = document.getElementById("ups-m-tb-body");
    if (!body) return;
    if (sub) sub.textContent = "Step " + builderState.step + " of 4";
    if (builderState.step === 1) return renderStepCounterparty(body);
    if (builderState.step === 2) return renderStepAssets(body, "get");
    if (builderState.step === 3) return renderStepAssets(body, "give");
    return renderStepReview(body);
  }

  // ── Step 1: counterparty ──
  function renderStepCounterparty(body) {
    var myFid = U.pad4(M.state.viewerFranchiseId);
    var others = (M.state.franchises || []).filter(function (f) { return f.id !== myFid; });
    body.innerHTML =
      '<div class="ups-m-tb-steptitle">Who are you trading with?</div>' +
      '<div class="ups-m-tb-flist">' +
        others.map(function (f) {
          return '<button class="ups-m-tb-frow" data-fid="' + U.escapeHtml(f.id) + '">' +
            U.escapeHtml(f.name) + '</button>';
        }).join("") +
      '</div>';
    var rows = body.querySelectorAll(".ups-m-tb-frow");
    for (var i = 0; i < rows.length; i++) {
      rows[i].addEventListener("click", function () {
        builderState.counterpartyFid = this.getAttribute("data-fid");
        builderState.step = 2;
        builderState.loadingInv = true;
        renderBuilder();
        Promise.all([
          loadInventoryFor(M.state.viewerFranchiseId),
          loadInventoryFor(builderState.counterpartyFid)
        ]).then(function () {
          builderState.loadingInv = false;
          renderBuilder();
        }).catch(function (e) {
          builderState.loadingInv = false;
          builderState.invError = (e && e.message) || String(e);
          renderBuilder();
        });
      });
    }
  }

  // ── Steps 2 & 3: asset picker (get = their assets, give = my assets) ──
  function renderStepAssets(body, mode) {
    var isGet = mode === "get";
    var fid = isGet ? builderState.counterpartyFid : M.state.viewerFranchiseId;
    var idMap = isGet ? builderState.getIds : builderState.giveIds;
    var capLabel = isGet ? "Cap money you receive" : "Cap money you give";
    var capVal = isGet ? builderState.theirCapK : builderState.myCapK;
    var who = franchiseName(fid);
    if (builderState.loadingInv) {
      body.innerHTML = '<div class="ups-m-loading">Loading rosters…</div>';
      return;
    }
    if (builderState.invError) {
      body.innerHTML = '<div class="ups-m-sheet-empty">Couldn\'t load assets: ' + U.escapeHtml(builderState.invError) + '</div>';
      return;
    }
    var inv = builderState.inv[U.pad4(fid)] || { players: [], future_picks: [] };
    var players = inv.players || [];
    var picks = inv.future_picks || [];
    var rowsHtml = players.map(function (p) {
      var id = "P_" + p.player_id;
      var on = !!idMap[id];
      var meta = [p.position, p.nfl_team, (U.safeInt(p.salary, 0) > 0 ? U.fmtUsd(p.salary) : null), (p.taxi ? "Taxi" : null)]
        .filter(Boolean).join(" · ");
      return '<button class="ups-m-tb-asset' + (on ? ' on' : '') + '" data-id="' + U.escapeHtml(id) +
        '" data-name="' + U.escapeHtml(String(p.display || "").toLowerCase()) + '">' +
        '<span class="nm">' + U.escapeHtml(p.display || ("Player #" + p.player_id)) + '</span>' +
        '<span class="mt">' + U.escapeHtml(meta) + '</span></button>';
    }).join("");
    var pickHtml = picks.map(function (fp) {
      var id = futurePickToken(fp);
      var on = !!idMap[id];
      return '<button class="ups-m-tb-asset' + (on ? ' on' : '') + '" data-id="' + U.escapeHtml(id) +
        '" data-name="pick ' + U.escapeHtml(String(fp.year)) + '">' +
        '<span class="nm">' + U.escapeHtml(fp.display || (fp.year + " R" + fp.round)) + '</span>' +
        '<span class="mt">Future pick</span></button>';
    }).join("");
    body.innerHTML =
      '<div class="ups-m-tb-steptitle">' + (isGet ? "Select " : "Select your ") +
        U.escapeHtml(isGet ? who + "'s" : "") + ' assets <span class="cnt" id="ups-m-tb-cnt">' + countSelected(idMap) + ' selected</span></div>' +
      '<input class="ups-m-tb-search" id="ups-m-tb-search" type="search" placeholder="Search players…" autocomplete="off" />' +
      '<div class="ups-m-tb-assets">' +
        (rowsHtml || '<div class="ups-m-auc-empty">No players.</div>') +
        (pickHtml ? '<div class="ups-m-tb-subhead">Future picks</div>' + pickHtml : '') +
      '</div>' +
      '<div class="ups-m-tb-cap">' +
        '<label>' + capLabel + ' ($000s) <span class="mx" id="ups-m-tb-capmax"></span></label>' +
        '<input type="number" min="0" step="1" inputmode="numeric" id="ups-m-tb-cap" value="' + (capVal || 0) + '" />' +
        '<div class="hint" id="ups-m-tb-caphint"></div>' +
      '</div>' +
      '<div class="ups-m-tb-nav">' +
        '<button class="btn-act" id="ups-m-tb-back">Back</button>' +
        '<button class="btn-act otb on" id="ups-m-tb-next">Next</button>' +
      '</div>';

    // Keep the cap-money input bounded by §A6 (50% of selected non-taxi
    // salary) and refresh the max/hint as players are toggled.
    function syncCapUi(clamp) {
      var mx = maxCapKFor(fid, idMap);
      var capInput = document.getElementById("ups-m-tb-cap");
      var maxEl = document.getElementById("ups-m-tb-capmax");
      var hintEl = document.getElementById("ups-m-tb-caphint");
      if (maxEl) maxEl.textContent = "· max $" + mx + "K";
      if (hintEl) hintEl.textContent = mx > 0
        ? "Up to 50% of the non-taxi salary you " + (isGet ? "receive" : "give") + " (§A6)."
        : "Pick a non-taxi player on this side to attach cap money (§A6).";
      if (capInput) {
        capInput.max = String(mx);
        capInput.disabled = mx <= 0;
        var cur = Math.max(0, parseInt(capInput.value, 10) || 0);
        if (cur > mx) { cur = mx; if (clamp) capInput.value = String(mx); }
        if (isGet) builderState.theirCapK = cur; else builderState.myCapK = cur;
      }
    }

    var assetBtns = body.querySelectorAll(".ups-m-tb-asset");
    for (var i = 0; i < assetBtns.length; i++) {
      assetBtns[i].addEventListener("click", function () {
        var id = this.getAttribute("data-id");
        if (idMap[id]) { delete idMap[id]; this.classList.remove("on"); }
        else { idMap[id] = true; this.classList.add("on"); }
        var cnt = document.getElementById("ups-m-tb-cnt");
        if (cnt) cnt.textContent = countSelected(idMap) + " selected";
        syncCapUi(true);
      });
    }
    var search = document.getElementById("ups-m-tb-search");
    if (search) search.addEventListener("input", function () {
      var q = this.value.toLowerCase();
      var all = body.querySelectorAll(".ups-m-tb-asset");
      for (var j = 0; j < all.length; j++) {
        var nm = all[j].getAttribute("data-name") || "";
        all[j].style.display = (!q || nm.indexOf(q) !== -1) ? "" : "none";
      }
    });
    var cap = document.getElementById("ups-m-tb-cap");
    if (cap) cap.addEventListener("input", function () {
      var mx = maxCapKFor(fid, idMap);
      var v = Math.max(0, parseInt(this.value, 10) || 0);
      if (v > mx) { v = mx; this.value = String(mx); }
      if (isGet) builderState.theirCapK = v; else builderState.myCapK = v;
    });
    syncCapUi(true);
    document.getElementById("ups-m-tb-back").addEventListener("click", function () {
      builderState.step = isGet ? 1 : 2; renderBuilder();
    });
    document.getElementById("ups-m-tb-next").addEventListener("click", function () {
      builderState.step = isGet ? 3 : 4; renderBuilder();
    });
  }

  // ── Step 4: review + submit ──
  function renderStepReview(body) {
    var myFid = U.pad4(M.state.viewerFranchiseId);
    var theirFid = U.pad4(builderState.counterpartyFid);
    var give = selectedAssetsFor(myFid, builderState.giveIds);
    var get = selectedAssetsFor(theirFid, builderState.getIds);
    // §A6-clamped cap values — match exactly what buildOfferPayload sends.
    var myCapK = Math.min(U.safeInt(builderState.myCapK, 0), maxCapKFor(myFid, builderState.giveIds));
    var theirCapK = Math.min(U.safeInt(builderState.theirCapK, 0), maxCapKFor(theirFid, builderState.getIds));
    function assetLine(a) {
      return '<li>' + U.escapeHtml(a.type === "PLAYER" ? (a.player_name || a.player_id) : (a.description || a.asset_id)) +
        (a.type === "PLAYER" && U.safeInt(a.salary, 0) > 0 ? ' <span class="sal">' + U.fmtUsd(a.salary) + '</span>' : '') + '</li>';
    }
    function colList(assets, capK) {
      var items = assets.map(assetLine).join("");
      if (capK > 0) items += '<li class="cap">+ ' + U.fmtUsd(capK * 1000) + ' cap money</li>';
      return items || '<li class="muted">—</li>';
    }
    var canSubmit = (give.length || myCapK > 0) && (get.length || theirCapK > 0);
    body.innerHTML =
      '<div class="ups-m-tb-steptitle">Review offer</div>' +
      '<div class="ups-m-tb-review">' +
        '<div class="col"><div class="lbl">You give → ' + U.escapeHtml(franchiseName(theirFid)) + '</div>' +
          '<ul>' + colList(give, myCapK) + '</ul></div>' +
        '<div class="col"><div class="lbl">You get</div>' +
          '<ul>' + colList(get, theirCapK) + '</ul></div>' +
      '</div>' +
      '<textarea class="ups-m-tb-comment" id="ups-m-tb-comment" rows="2" maxlength="2000" placeholder="Optional message to ' + U.escapeHtml(franchiseName(theirFid)) + '…">' + U.escapeHtml(builderState.comment) + '</textarea>' +
      (builderState.error ? '<div class="ups-m-rstr-err">' + U.escapeHtml(builderState.error) + '</div>' : '') +
      '<div class="ups-m-tb-warn">Submitting creates a real pending offer in MFL (' + U.escapeHtml(franchiseName(theirFid)) + ' can accept it). You can cancel it from the offers list.</div>' +
      '<div class="ups-m-tb-nav">' +
        '<button class="btn-act" id="ups-m-tb-back"' + (builderState.submitting ? ' disabled' : '') + '>Back</button>' +
        '<button class="btn-act otb on" id="ups-m-tb-submit"' + (canSubmit && !builderState.submitting ? '' : ' disabled') + '>' +
          (builderState.submitting ? "Submitting…" : "Send offer") + '</button>' +
      '</div>';
    var c = document.getElementById("ups-m-tb-comment");
    if (c) c.addEventListener("input", function () { builderState.comment = this.value; });
    document.getElementById("ups-m-tb-back").addEventListener("click", function () {
      if (builderState.submitting) return;
      builderState.step = 3; renderBuilder();
    });
    var submit = document.getElementById("ups-m-tb-submit");
    if (submit) submit.addEventListener("click", function () {
      if (!canSubmit || builderState.submitting) return;
      submitOffer();
    });
  }

  function buildOfferPayload() {
    var ctx = M.state.ctx;
    var myFid = U.pad4(M.state.viewerFranchiseId);
    var theirFid = U.pad4(builderState.counterpartyFid);
    var giveAssets = selectedAssetsFor(myFid, builderState.giveIds);
    var getAssets = selectedAssetsFor(theirFid, builderState.getIds);
    function nonTaxi(assets) {
      return assets.reduce(function (s, a) {
        return (a.type === "PLAYER" && !a.taxi) ? s + U.safeInt(a.salary, 0) : s;
      }, 0);
    }
    // §A6 final guard — cap money never exceeds 50% of that side's traded
    // non-taxi salary, regardless of any UI state drift.
    var myCapK = Math.min(U.safeInt(builderState.myCapK, 0), maxCapKFor(myFid, builderState.giveIds));
    var theirCapK = Math.min(U.safeInt(builderState.theirCapK, 0), maxCapKFor(theirFid, builderState.getIds));
    return {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      source: "ups-mobile-trade-builder",
      league_id: ctx.leagueId,
      season: ctx.year,
      teams: [
        {
          role: "left", franchise_id: myFid, franchise_name: franchiseName(myFid),
          selected_assets: giveAssets,
          traded_salary_adjustment_dollars: myCapK * 1000,
          traded_salary_adjustment_k: myCapK,
          traded_salary_adjustment_max_k: 999,
          selected_non_taxi_salary_dollars: nonTaxi(giveAssets)
        },
        {
          role: "right", franchise_id: theirFid, franchise_name: franchiseName(theirFid),
          selected_assets: getAssets,
          traded_salary_adjustment_dollars: theirCapK * 1000,
          traded_salary_adjustment_k: theirCapK,
          traded_salary_adjustment_max_k: 999,
          selected_non_taxi_salary_dollars: nonTaxi(getAssets)
        }
      ],
      extension_requests: [],
      filters: { search: "" },
      ui: { left_team_id: myFid, right_team_id: theirFid }
    };
  }

  function submitOffer() {
    builderState.submitting = true; builderState.error = ""; renderBuilder();
    var myFid = U.pad4(M.state.viewerFranchiseId);
    var theirFid = U.pad4(builderState.counterpartyFid);
    var payload = buildOfferPayload();
    var body = {
      league_id: M.state.ctx.leagueId,
      season: M.state.ctx.year,
      from_franchise_id: myFid,
      to_franchise_id: theirFid,
      from_franchise_name: franchiseName(myFid),
      to_franchise_name: franchiseName(theirFid),
      message: builderState.comment || "",
      payload: payload
    };
    var url = M.api.workerUrl("/api/trades/proposals?L=" +
      encodeURIComponent(M.state.ctx.leagueId) + "&YEAR=" + encodeURIComponent(M.state.ctx.year));
    var stored = M.api.getStoredMflUserId && M.api.getStoredMflUserId();
    if (stored) url += "&MFL_USER_ID=" + encodeURIComponent(stored);
    fetch(url, {
      method: "POST", mode: "cors", credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.text().then(function (txt) {
        var parsed = null; try { parsed = txt ? JSON.parse(txt) : null; } catch (e) {}
        return { ok: r.ok, status: r.status, body: parsed };
      });
    }).then(function (resp) {
      builderState.submitting = false;
      if (resp.ok && resp.body && resp.body.ok !== false) {
        M.ui.showToast("Offer sent ✓", "ok");
        closeBuilder();
        state.offers = null;
        if (M.actions && M.actions.reloadData) {
          return M.actions.reloadData().then(function () { M.route.renderRoute(); });
        }
        return loadOffers().then(function () { M.route.renderRoute(); });
      }
      builderState.error = (resp.body && (resp.body.error || resp.body.message)) || ("HTTP " + resp.status);
      renderBuilder();
    }).catch(function (err) {
      builderState.submitting = false;
      builderState.error = (err && err.message) || String(err);
      renderBuilder();
    });
  }

  function postTradeAction(action, tradeId) {
    // Forward the viewer's MFL_USER_ID — the action route writes to MFL as the
    // acting franchise and rejects with "Missing MFL owner session" without it
    // (worker viewerCookieHeader gate). Same query-param pattern as the builder.
    var url = M.api.workerUrl("/api/trades/proposals/action");
    var stored = M.api.getStoredMflUserId && M.api.getStoredMflUserId();
    if (stored) url += "?MFL_USER_ID=" + encodeURIComponent(stored);
    return fetch(url, {
      method: "POST", mode: "cors", credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: action,
        trade_id: tradeId,
        league_id: M.state.ctx.leagueId,
        franchise_id: M.state.viewerFranchiseId,
        year: M.state.ctx.year
      })
    }).then(function (r) {
      return r.text().then(function (txt) {
        var parsed = null;
        try { parsed = txt ? JSON.parse(txt) : null; } catch (e) {}
        return { ok: r.ok, status: r.status, body: parsed };
      });
    });
  }

  function handleAction(action, tradeId) {
    var prompt = action === "accept" ? "Accept this trade?\n\nWrites to MFL." :
                 action === "decline" ? "Decline this trade?" :
                 "Cancel this outgoing offer?";
    if (!window.confirm(prompt)) return;
    M.ui.showToast(action[0].toUpperCase() + action.slice(1) + "ing…", "info");
    postTradeAction(action, tradeId).then(function (resp) {
      if (resp.ok) {
        M.ui.showToast("Done ✓", "ok");
        state.offers = null;
        // Reload everything: trade actions can mutate roster + cap, and we
        // need fresh trade offers + nav badge count.
        if (M.actions && M.actions.reloadData) {
          return M.actions.reloadData().then(function () { M.route.renderRoute(); });
        }
        return loadOffers().then(function () { M.route.renderRoute(); });
      }
      var err = (resp.body && (resp.body.error || resp.body.message)) || ("HTTP " + resp.status);
      M.ui.showToast("Failed: " + err, "err");
    }).catch(function (err) {
      M.ui.showToast("Failed: " + (err && err.message || err), "err");
    });
  }

  function render(mount) {
    // Pre-load: loadAllData fetches trade offers as part of its
    // post-franchise-resolve step, so the badge on the League nav can
    // appear before the user navigates here. Always prefer the global
    // M.state.tradeOffers copy so reloadData() bust-invalidates the cache.
    if (M.state.tradeOffers) {
      state.offers = M.state.tradeOffers;
    } else if (!state.offers && !state.loading) {
      loadOffers().then(function () { M.route.renderRoute(); });
      mount.innerHTML = subTabs("trade") + '<div class="ups-m-loading">Loading offers…</div>';
      return;
    }
    if (state.loading) {
      mount.innerHTML = subTabs("trade") + '<div class="ups-m-loading">Loading offers…</div>';
      return;
    }
    if (state.error) {
      mount.innerHTML = subTabs("trade") +
        '<div class="ups-m-error">Failed to load: ' + U.escapeHtml(state.error) + '</div>';
      return;
    }
    var data = state.offers || {};
    var incoming = data.incoming || [];
    var outgoing = data.outgoing || [];

    var html = subTabs("trade");
    // CTA — native in-app builder (players + future picks + cap money).
    // Desktop link retained for current-year draft-pick trades (see builder note).
    html += '<div class="ups-m-card">' +
      '<div class="ups-m-card-title">Build a new offer</div>' +
      '<div style="font-size:12px;color:var(--fg-muted);margin-bottom:10px">' +
        'Trade players, future picks, and cap money right here. Including a current-year rookie pick? Use the desktop War Room.' +
      '</div>' +
      '<button class="btn-act otb on" id="ups-m-tb-open" style="width:100%;margin-bottom:8px">+ Build offer</button>' +
      '<a class="ups-m-desktop-link" style="margin:0" href="' + buildTradeWarRoomUrl() + '" target="_blank">Open Trade War Room (desktop)</a>' +
    '</div>';

    html += '<div class="ups-m-pos-group">Incoming · ' + incoming.length + '</div>';
    html += renderOffersList(incoming, "incoming");
    html += '<div class="ups-m-pos-group" style="margin-top:18px">Outgoing · ' + outgoing.length + '</div>';
    html += renderOffersList(outgoing, "outgoing");

    mount.innerHTML = html;

    var openBtn = mount.querySelector("#ups-m-tb-open");
    if (openBtn) openBtn.addEventListener("click", openBuilder);

    var btns = mount.querySelectorAll(".btn-act[data-act]");
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener("click", function () {
        handleAction(this.getAttribute("data-act"), this.getAttribute("data-trade-id"));
      });
    }
  }

  M.tradeView = { render: render };
})();
