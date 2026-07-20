/* Auction Hub — state machine + renderers
 *
 * MVP scope (2026-05-18):
 *  - Expired Rookie Pool tab: eligible-player table from /api/auction/era-eligible
 *  - Filters: position chips, prior-owner, min Y3 salary, search
 *  - Sort: every column
 *  - Action popover: current bid, your proxy bid, cap delta @ $1K/$5K/$10K
 *  - "Why eligible" tooltip per row
 *
 * Other tabs are placeholders, wired later.
 */
(function () {
  "use strict";

  // ── Worker resolution ───────────────────────────────────────────────
  // Precedence: ?worker_base override → MFL HPM loader inject
  // (UPS_AUCTION_HUB_API_BASE) → hardcoded prod fallback.
  const WORKER_BASE = (function () {
    try {
      const u = new URL(window.location.href);
      const override = u.searchParams.get("worker_base");
      if (override) return override.replace(/\/$/, "");
    } catch (e) {}
    if (typeof window.UPS_AUCTION_HUB_API_BASE === "string" && window.UPS_AUCTION_HUB_API_BASE) {
      return String(window.UPS_AUCTION_HUB_API_BASE).replace(/\/$/, "");
    }
    return "https://upsmflproduction.keith-creelman.workers.dev";
  })();
  const apiUrl = (p) => WORKER_BASE + p;
  const fetchJSON = (url, _retried) =>
    fetch(url, { cache: "no-store" }).then((r) => {
      if (!r.ok) {
        // One retry on a 5xx: the eager boot fires several requests at once
        // and a cold worker / transient D1 contention can briefly 500. The
        // same request succeeds a beat later, so a single backoff-retry keeps
        // a tab from booting empty.
        if (r.status >= 500 && !_retried) {
          return new Promise((res) => setTimeout(res, 700)).then(() => fetchJSON(url, true));
        }
        throw new Error("HTTP " + r.status + " " + url);
      }
      return r.json();
    });

  // ── League ID resolution ────────────────────────────────────────────
  // The embed loader injects window.UPS_AUCTION_HUB_LEAGUE_ID from the
  // MFL URL (e.g. /2026/home/25625/... → "25625"). When viewed standalone
  // (not iframed), falls back to ?L= query param, then production.
  function _leagueId() {
    try {
      if (window.UPS_AUCTION_HUB_LEAGUE_ID) return String(window.UPS_AUCTION_HUB_LEAGUE_ID).replace(/\D/g, "") || "74598";
      const u = new URL(window.location.href);
      const fromQuery = String(u.searchParams.get("L") || "").replace(/\D/g, "");
      if (fromQuery) return fromQuery;
    } catch (e) {}
    return "74598";
  }
  const LEAGUE_ID = _leagueId();

  // ── HPM franchise injection (MFL-only signal of who is viewing) ────
  // The auction loader injects window.UPS_AUCTION_HUB_FRANCHISE_ID before
  // the iframe renders — that's the most trustworthy "who is viewing".
  function _hpmFranchiseId() {
    try {
      if (window.UPS_AUCTION_HUB_FRANCHISE_ID) return String(window.UPS_AUCTION_HUB_FRANCHISE_ID).padStart(4, "0");
      if (window.UPS_HPM_FRANCHISE_ID) return String(window.UPS_HPM_FRANCHISE_ID).padStart(4, "0");
      const u = new URL(window.location.href);
      const f = u.searchParams.get("franchise_id");
      if (f) return String(f).padStart(4, "0");
    } catch (e) {}
    return null;
  }

  // The viewer's MFL session token, injected by the embed loader (which runs on
  // the MFL page where document.cookie is readable; the hub itself is served from
  // jsDelivr's origin and cannot read that cookie). Forwarding it lets the worker
  // read the VIEWER's own proxy off O=43 — same as mobile — so Available Funds and
  // the YOUR PROXY column match the phone instead of showing the public-current
  // over-statement. Undefined ⇒ no token ⇒ the worker falls back to public-only.
  function _mflUserId() {
    try {
      var t = window.UPS_AUCTION_HUB_MFL_USER_ID;
      return t ? String(t) : "";
    } catch (e) { return ""; }
  }
  function _withUserId(url) {
    var t = _mflUserId();
    return t ? url + (url.indexOf("?") === -1 ? "?" : "&") + "MFL_USER_ID=" + encodeURIComponent(t) : url;
  }

  // The FA pool + ADP board are large and near-static; the 30s live refresh
  // doesn't need them. Re-pull at most this often (live lots/board still tick
  // every 30s).
  const FA_POOL_TTL_MS = 5 * 60 * 1000;

  const STATE = {
    version: null,
    me: null,
    era: null,                   // payload from /api/auction/era-eligible
    // Mirrors the mobile app: a top tab per auction + a sub-section pill.
    //   tab: "faa" | "era"
    //   sub: "summary" | "players" | "lots" | "history" | "tracker"
    tab: "faa",                  // FA Auction is the default landing tab
    sub: "summary",
    era_filters: { pos: "ALL", owner: "" },
    fapool_filters: { pos: "ALL", team: "", q: "" },   // FA-pool: position / NFL team / name search
    faAdp: {},                   // mfl_id → { ovr, pos, posRank } from /api/adp-board (stats-workbench consensus)
    _faPoolAt: 0,                // last successful fa-pool load (ms) — slow-refresh gate
    _faAdpAt: 0,                 // last successful adp-board load (ms) — slow-refresh gate
    era_sort: "ppg_weighted",
    era_sort_dir: -1,            // desc
    lots: null,                  // payload from /api/auction/lots
    nom_filters: { status: "open" },
    nom_sort: "time_remaining",
    // Test lots (ups_auction_lots.is_test) are hidden by default on the prod
    // league; this chip reveals them (and the commish delete button).
    show_test: false,
  };

  // Sub-sections (pills) — identical set under both auctions.
  const SUBS = [
    { key: "summary", label: "Summary" },
    { key: "players", label: "Players" },
    { key: "lots", label: "Lots" },
    { key: "history", label: "History" },
    { key: "tracker", label: "Tracker" },
  ];

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const escapeHtml = (s) =>
    String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  const fmtK = (n) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return "—";
    return "$" + Math.round(v) + "K";
  };
  // Display a K-denominated bid as actual dollars with thousands separator
  // (e.g. high_bid_k=1 → "$1,000", high_bid_k=5 → "$5,000"). Keith 2026-05-25
  // wants the High Bid column readable as dollars, not the $1K shorthand.
  const fmtDollarsFromK = (k) => {
    const v = Number(k);
    if (!Number.isFinite(v) || v <= 0) return "—";
    return "$" + Math.round(v * 1000).toLocaleString("en-US");
  };
  const fmtDate = (iso) => {
    if (!iso) return "—";
    try {
      const d = new Date(iso);
      return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    } catch (e) { return iso; }
  };
  // Full-dollar formatter (desktop has room for the whole number).
  const usd = (n) => {
    const v = Number(n);
    return Number.isFinite(v) && v > 0 ? "$" + Math.round(v).toLocaleString("en-US") : "—";
  };
  // The FAA /live high-bid value may arrive as a number or a pre-formatted
  // "$5,000" string from the O=43 scrape — render either cleanly.
  const money = (v) => {
    if (v == null || v === "") return "—";
    const s = String(v);
    if (/\$/.test(s)) return escapeHtml(s);
    const n = Number(s.replace(/[^0-9.\-]/g, ""));
    return Number.isFinite(n) && n > 0 ? "$" + Math.round(n).toLocaleString("en-US") : escapeHtml(s);
  };
  // Deep-link to MFL's native auction page (O=43) for a player — kept as the
  // SECONDARY path ("Bid ↗") alongside in-app bidding (below), and the fallback
  // whenever the viewer isn't eligible to bid in-app or a kill switch is on.
  function mflBidUrl(pid) {
    const fid = (STATE.me && STATE.me.franchise_id) || _hpmFranchiseId() || "0000";
    const year = new Date().getUTCFullYear();
    return `https://www48.myfantasyleague.com/${year}/options?LEAGUE_ID=${LEAGUE_ID}` +
      `&FRANCHISE=${fid}&O=43&PLAYER_ID=${encodeURIComponent(pid)}`;
  }

  // ── In-app bidding (desktop parity with mobile submitBid) ─────────────────
  // The viewer's own franchise (never the "0000" commish fallback that
  // mflBidUrl tolerates for a read-only deep-link — a real POST attributed to
  // 0000 would record the bid against the commish).
  function _viewerFid() {
    return (STATE.me && STATE.me.franchise_id) || _hpmFranchiseId() || null;
  }
  // The session TOKEN is the identity that matters: the worker resolves the
  // bidding franchise from it server-side (MFL myfranchise), and MFL renders the
  // O=43 bid form scoped to whoever the token authenticates. The injected
  // FRANCHISE_ID is unreliable on desktop (commish views resolve as 0000 even
  // though the token is a real owner), so gating on fid !== "0000" wrongly
  // locked the commish out of in-app bidding on his own team. Gate on the token
  // ONLY; without it we can't attribute a bid, so render the deep-link instead.
  function _canBidInApp() {
    return !!_mflUserId();
  }
  // The live FA payload's active_auctions carry the O=43 overlay (fresh current
  // bid + the viewer's proxy); the Lots board reads the staler /api/auction/lots.
  // Look up a lot's overlaid twin by player_id so the board can prefer it.
  function _overlaidLot(pid) {
    const arr = (STATE.fa && STATE.fa.active_auctions) || [];
    const key = String(pid);
    for (let i = 0; i < arr.length; i++) if (String(arr[i].player_id) === key) return arr[i];
    return null;
  }
  // Raw fetch (NOT fetchJSON, which throws on non-2xx and would swallow the 503
  // kill-switch fallback). Mirrors mobile postAuction: returns {status, ok, body}.
  function postAuctionBid(payload) {
    const url = _withUserId(apiUrl("/api/auction/bid?L=" + LEAGUE_ID + "&YEAR=" + new Date().getUTCFullYear()));
    return fetch(url, {
      method: "POST", mode: "cors", credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    }).then((r) => r.text().then((t) => {
      let p = null; try { p = t ? JSON.parse(t) : null; } catch (e) {}
      return { status: r.status, ok: r.ok, body: p || {} };
    }));
  }
  function closeBidModal() {
    const ov = document.getElementById("ah-bid-overlay");
    if (ov) ov.remove();
  }
  // opts: { player_id, player_name, auction_type, high_k }
  // ── Cap + roster pre-flight (2026-07-15) ────────────────────────────
  // Mirrors worker auctionEligibility + the mobile sheet. The board already
  // rendered every number this needs (team_budget_rows: available funds, the
  // $1K-per-need reserve, per-position max, lineup deficits) and the bid modal
  // never read them — so a bid the cap can't cover went to MFL and came back as
  // "auction_post_failed" with no explanation.
  const AH_MAX_ROSTER = 35;
  function _myBudgetRow() {
    const fid = _viewerFid();
    if (!fid || fid === "0000") return null;
    const rows = (STATE.fa && STATE.fa.team_budget_rows) || [];
    const p4 = (v) => String(v == null ? "" : v).replace(/\D/g, "").padStart(4, "0");
    return rows.find((r) => p4(r.franchise_id) === p4(fid)) || null;
  }
  // { maxK, locked, lockMsg, needsMsg } — maxK 0 = unknown ⇒ no clamp.
  function bidLimits(pos) {
    const out = { maxK: 0, locked: false, lockMsg: "", needsMsg: "" };
    const row = _myBudgetRow();
    if (!row) return out;
    let P = String(pos || "").toUpperCase();
    if (P === "K") P = "PK";
    if (P === "P") P = "PN";
    const deficits = row.lineup_deficits || {};
    let totalDeficit = 0;
    const needList = [];
    Object.keys(deficits).forEach((k) => {
      const n = Number(deficits[k]) || 0;
      if (n > 0) { totalDeficit += n; needList.push(k + "\u00d7" + n); }
    });
    const rosterCount = Number(row.roster_count) || 0;
    if (rosterCount >= AH_MAX_ROSTER) {
      out.locked = true;
      out.lockMsg = "Your roster is full (" + rosterCount + "/" + AH_MAX_ROSTER + "). Cut someone first.";
      return out;
    }
    // Slot lock — money is irrelevant when the spots are already spoken for.
    const deficitAfter = totalDeficit - ((Number(deficits[P]) || 0) > 0 ? 1 : 0);
    const slotsAfter = AH_MAX_ROSTER - (rosterCount + 1);
    if (deficitAfter > slotsAfter) {
      out.locked = true;
      out.lockMsg = "You can\u2019t add a " + P + " \u2014 every roster spot you have left is owed to a position you still need (" +
        needList.join(", ") + "). Fill those first.";
      return out;
    }
    const entry = (row.max_bid_by_position || {})[P];
    const maxDollars = entry ? Number(entry.scenario_27) : Number(row.scenario_27_max_bid);
    if (maxDollars > 0) out.maxK = Math.floor(maxDollars / 1000);
    if (needList.length) {
      out.needsMsg = "still owed " + needList.join(", ") + ", " +
        fmtK(Math.round((Number(row.reserve_cost_27) || 0) / 1000)) + " held in reserve";
    }
    return out;
  }
  function _posForPid(pid) {
    const key = String(pid);
    const pool = (STATE.faPool || []).concat((STATE.fa && STATE.fa.available_players) || []);
    for (let i = 0; i < pool.length; i++) {
      if (String(pool[i].player_id) === key) return pool[i].position || "";
    }
    const lots = (STATE.lots && STATE.lots.lots) || [];
    for (let i = 0; i < lots.length; i++) {
      if (String(lots[i].player_id) === key) return lots[i].position || "";
    }
    return "";
  }

  function openBidModal(opts) {
    if (!_canBidInApp()) { window.open(mflBidUrl(opts.player_id), "_blank", "noopener"); return; }
    const highK = Number(opts.high_k) || 0;
    // If YOU already lead, MFL shows you your proxy (max), and submitting BELOW
    // that max is a max REDUCTION — which is how a $42K Burrow max became $7K.
    //
    // The first fix floored at myProxy+1 so a bid could only RAISE. That was
    // wrong: MFL lets you adjust a max down, and we mirror MFL (Keith 2026-07-14:
    // "if you can do it on MFL we should keep it consistent"). Forbidding it here
    // just pushes owners onto MFL's own page to do the same thing.
    //
    // So the floor is MFL's minimum (high + 1) and lowering stays possible — but
    // the PRE-FILL is your current max, not high+1, so the dangerous action can
    // only happen on purpose. The accident was never that lowering was allowed;
    // it was that the default value silently did it for you.
    const _ov = _overlaidLot(opts.player_id);
    const myProxyK = (_ov && _ov.your_proxy_bid_amount != null) ? Math.round(Number(_ov.your_proxy_bid_amount) / 1000) : 0;
    const iLead = myProxyK > 0;
    const minK = highK + 1;
    let startK = iLead ? Math.max(myProxyK, minK) : minK;
    // Pre-flight: a locked position never opens a modal, and the ceiling is
    // clamped before the field is ever rendered.
    const lim = bidLimits(opts.position || _posForPid(opts.player_id));
    if (lim.locked) { window.alert(lim.lockMsg); return; }
    if (lim.maxK > 0 && minK > lim.maxK) {
      window.alert("You can\u2019t reach the " + fmtK(minK) + " minimum on this player \u2014 your max is " + fmtK(lim.maxK) +
        (lim.needsMsg ? " (" + lim.needsMsg + ")" : "") + ".");
      return;
    }
    if (lim.maxK > 0 && startK > lim.maxK) startK = lim.maxK;
    closeBidModal();
    const deepLink = mflBidUrl(opts.player_id);
    const html =
      '<div class="ah-bid-overlay" id="ah-bid-overlay" role="dialog" aria-modal="true" aria-label="Place bid">' +
        '<div class="ah-bid-modal">' +
          '<div class="ah-bid-head">' +
            '<div class="ah-bid-title">Bid — ' + escapeHtml(opts.player_name || ("Player #" + opts.player_id)) + '</div>' +
            '<button type="button" class="ah-bid-close" id="ah-bid-close" aria-label="Close">×</button>' +
          '</div>' +
          '<div class="ah-bid-sub">' + (iLead
              ? "You lead · your max " + fmtK(myProxyK) + " — lower it only if you mean to"
              : (highK > 0 ? "High " + fmtK(highK) : "No bids yet")) + '</div>' +
          '<label class="ah-bid-lbl" for="ah-bid-amt">Your max bid ($K)</label>' +
          '<div class="ah-bid-input">' +
            '<button type="button" class="btn small secondary ah-bid-step" data-step="-1" aria-label="Lower bid">−</button>' +
            '<input type="number" id="ah-bid-amt" min="' + minK + '"' + (lim.maxK > 0 ? ' max="' + lim.maxK + '"' : '') + ' step="1" inputmode="numeric" value="' + startK + '" />' +
            '<button type="button" class="btn small secondary ah-bid-step" data-step="1" aria-label="Raise bid">+</button>' +
          '</div>' +
          '<div class="ah-bid-status" id="ah-bid-status" aria-live="polite"></div>' +
          '<div class="ah-bid-foot">' +
            '<a class="btn small secondary" href="' + deepLink + '" target="_blank" rel="noopener">On MFL ↗</a>' +
            '<button type="button" class="btn small" id="ah-bid-submit">Place bid</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.insertAdjacentHTML("beforeend", html);
    const amt = document.getElementById("ah-bid-amt");
    const overlay = document.getElementById("ah-bid-overlay");
    // Place the modal at the clicked row (anchor_y), clamped so it never runs off
    // the bottom of the document. Ask the parent (which owns the scrollbar) to
    // bring it into view too — belt and braces for a click near the fold.
    const modalEl = overlay.querySelector(".ah-bid-modal");
    if (modalEl) {
      const y = Number(opts.anchor_y) || 8;
      const maxTop = Math.max(8, document.documentElement.scrollHeight - modalEl.offsetHeight - 12);
      modalEl.style.top = Math.min(y, maxTop) + "px";
      try { parent.postMessage({ type: "auction-hub-scroll-into-view", y: Math.min(y, maxTop) }, "*"); } catch (e) {}
    }
    document.getElementById("ah-bid-close").addEventListener("click", closeBidModal);
    // Click on the backdrop (not the modal) closes.
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeBidModal(); });
    Array.prototype.forEach.call(overlay.querySelectorAll(".ah-bid-step"), (b) => {
      b.addEventListener("click", function () {
        const step = parseInt(this.getAttribute("data-step"), 10) || 0;
        const floor = parseInt(amt.getAttribute("min"), 10) || minK;
        amt.value = String(Math.max(floor, (parseInt(amt.value, 10) || floor) + step));
      });
    });
    document.getElementById("ah-bid-submit").addEventListener("click", function () {
      // Lowering is allowed (MFL allows it) but never silent: MFL reduces your
      // proxy and there is no undo once it lands.
      const v = parseInt((document.getElementById("ah-bid-amt") || {}).value, 10) || 0;
      if (iLead && v < myProxyK && !window.confirm(
        "This LOWERS your max on " + (opts.player_name || "this player") + " from " +
        fmtK(myProxyK) + " to " + fmtK(v) + ".\n\nMFL will reduce your proxy. Continue?")) return;
      submitDesktopBid(opts, this, minK);
    });
  }
  function submitDesktopBid(opts, btn, minK) {
    const amt = document.getElementById("ah-bid-amt");
    const statusEl = document.getElementById("ah-bid-status");
    const amountK = parseInt(amt && amt.value, 10) || 0;
    // Effective floor = higher of the modal-open min and the input's live min
    // attr (the outbid branch bumps that to the fresh current-high + 1), so a
    // manual down-edit after an outbid is rejected.
    const floorK = Math.max(minK, parseInt(amt && amt.getAttribute("min"), 10) || minK);
    if (amountK < floorK) { if (statusEl) { statusEl.className = "ah-bid-status err"; statusEl.textContent = "Bid must be at least " + fmtK(floorK) + "."; } return; }
    // Ceiling. Recomputed rather than closed over — submitDesktopBid is its own
    // function, so the modal-open `lim` is not in scope here.
    const ceilK = parseInt(amt && amt.getAttribute("max"), 10) || 0;
    if (ceilK > 0 && amountK > ceilK) {
      const lim2 = bidLimits(opts.position || _posForPid(opts.player_id));
      if (statusEl) {
        statusEl.className = "ah-bid-status err";
        statusEl.textContent = "Max " + fmtK(ceilK) + " on this player \u2014 " +
          (lim2.needsMsg || "the rest of your cap is reserved for the roster spots you still owe") + ".";
      }
      return;
    }
    if (statusEl) { statusEl.className = "ah-bid-status"; statusEl.textContent = ""; }
    btn.disabled = true; btn.textContent = "Submitting…";
    postAuctionBid({
      player_id: String(opts.player_id),
      amount: amountK * 1000,                          // $K → dollars (MFL form unit)
      // Deliberately omit franchise_id: the injected desktop fid can be 0000
      // (commish view), and the worker echoes an explicit franchise_id — sending
      // 0000 would fetch/POST the wrong franchise's form. With it empty the worker
      // resolves the bidder from the forwarded MFL_USER_ID token (myfranchise),
      // which is the same identity MFL scopes the O=43 bid form to. Real fid only.
      franchise_id: (function () { const f = _viewerFid(); return f && f !== "0000" ? f : ""; })(),
      auction_type: opts.auction_type || "free-agent",
    }).then((resp) => {
      if (resp.status === 503) {                        // auction off / in-app off → fall back to MFL
        if (statusEl) { statusEl.className = "ah-bid-status"; statusEl.textContent = (resp.body && resp.body.message) || "Use MFL's auction page."; }
        window.open((resp.body && resp.body.native_link) || mflBidUrl(opts.player_id), "_blank", "noopener");
        closeBidModal();
        return;
      }
      if (resp.ok && resp.body && resp.body.ok) {
        // Trust the server's verified outcome (read from MFL's own page
        // post-submit), not a hardcoded ✓ — same contract mobile consumes.
        const outcome = resp.body.outcome;
        const msg = resp.body.message || "Bid placed ✓";
        if (outcome === "outbid") {
          // Pre-step to the fresh current-high + 1 so re-bidding is one click.
          // Prefer the server's current_bid_dollars (its post-submit O=43 re-read)
          // over the live board's D1-sourced high (up to ~5 min stale).
          const freshCur = Number(resp.body.current_bid_dollars) || 0;
          const newHighK = freshCur > 0 ? Math.round(freshCur / 1000) : 0;
          if (newHighK > 0 && amt) { amt.value = String(newHighK + 1); amt.setAttribute("min", String(newHighK + 1)); }
          if (statusEl) { statusEl.className = "ah-bid-status err"; statusEl.textContent = msg; }
          btn.disabled = false; btn.textContent = "Place bid";
          reloadBoardAfterBid();                         // refresh the High line (modal stays open)
          return;
        }
        closeBidModal();
        reloadBoardAfterBid();                           // re-read → verified board (funds/proxy)
      } else {
        const emsg = (resp.body && (resp.body.message || resp.body.error)) || ("HTTP " + resp.status);
        if (statusEl) { statusEl.className = "ah-bid-status err"; statusEl.textContent = emsg; }
        btn.disabled = false; btn.textContent = "Place bid";
      }
    }).catch((e) => {
      const emsg = (e && e.message) || String(e);
      if (statusEl) { statusEl.className = "ah-bid-status err"; statusEl.textContent = emsg; }
      btn.disabled = false; btn.textContent = "Place bid";
    });
  }
  // Re-pull the board so proxy/funds/high-bid reflect the just-placed bid (the
  // worker verifies from MFL — no 5-min lag). Best-effort; a failed refresh
  // must not surface as a bid error.
  function reloadBoardAfterBid() {
    Promise.all([loadFa(), loadLots(), loadBidHistory()]).then(paint).catch(() => paint());
  }
  // One delegated listener (bound once in init, like the player-modal one) so
  // the per-paint re-render of the lots tables doesn't need re-wiring.
  function setupBidModalDelegation() {
    document.addEventListener("click", (e) => {
      const btn = e.target.closest('[data-action="open-bid-modal"]');
      if (!btn) return;
      e.preventDefault();
      // Anchor the modal to the clicked row's Y. No internal iframe scroll, so
      // getBoundingClientRect().top is the button's document Y = where the user
      // is looking. Nudge up ~24px so the modal opens over the row, not below it.
      const rect = btn.getBoundingClientRect();
      const anchorY = Math.max(8, rect.top + (window.scrollY || 0) - 24);
      openBidModal({
        player_id: btn.getAttribute("data-player-id"),
        player_name: btn.getAttribute("data-player-name") || "",
        auction_type: btn.getAttribute("data-auction-type") || "free-agent",
        high_k: Number(btn.getAttribute("data-high-k")) || 0,
        anchor_y: anchorY,
      });
    });
  }

  // Map MFL position codes to display buckets (matches rookie hub convention)
  // MFL emits fine-grained defensive positions (DE/DT/NT, OLB/ILB/MLB, CB/S/FS/SS).
  // They used to collapse into one "IDP" bucket, which is useless for shopping:
  // the lineup needs DL, LB and DB SEPARATELY (see the positions matrix), so a
  // filter that can't tell them apart can't answer "who fills my DL hole".
  const DL_POS = ["DL", "DE", "DT", "NT", "EDGE"];
  const LB_POS = ["LB", "OLB", "ILB", "MLB"];
  const DB_POS = ["DB", "CB", "S", "FS", "SS"];
  function posBucket(p) {
    p = String(p || "").toUpperCase();
    if (["QB", "RB", "WR", "TE"].includes(p)) return p;
    if (p === "K") return "PK";
    if (p === "P") return "PN";
    if (["PK", "PN"].includes(p)) return p;
    if (DL_POS.includes(p)) return "DL";
    if (LB_POS.includes(p)) return "LB";
    if (DB_POS.includes(p)) return "DB";
    // An unrecognised code still needs a home — bucket as DL rather than let the
    // player vanish from every filter. There is no "IDP" bucket any more.
    return "DL";
  }

  // ════════════════════════════════════════════════════════════════════
  // BOOTSTRAP
  // ════════════════════════════════════════════════════════════════════
  async function init() {
    // Reflect the active league in the header subtitle so test-league
    // sessions visibly differ from production.
    const subtitle = document.getElementById("ah-subtitle");
    if (subtitle) {
      const isTest = LEAGUE_ID !== "74598";
      subtitle.textContent = `${isTest ? "TEST" : "UPS"} League ${LEAGUE_ID} · ${new Date().getUTCFullYear()}`;
      if (isTest) subtitle.style.color = "var(--warn)";
    }

    // The top tabs (two auctions) + the sub-nav pills persist across
    // paints, so their click handlers bind ONCE here (delegation for the
    // pills, since their inner buttons re-render). Everything else re-wires
    // per-mount inside paint() → renderSub().
    setupTabs();
    setupSubNav();
    setupPlayerModalDelegation();
    setupBidModalDelegation();

    // Version badge — best-effort, doesn't block render
    fetchJSON("VERSION.json?_=" + Date.now()).then((v) => {
      STATE.version = v;
      const el = $("#ah-version-badge");
      if (el && v && v.version) el.textContent = "v" + v.version;
    }).catch(() => {
      const el = $("#ah-version-badge");
      if (el) el.textContent = "v0.1.0";
    });

    // Eager-load everything once (mirrors the mobile app's single load()).
    // The desktop is read-only, so a couple extra fetches up front buys a
    // snappy tab/sub experience with no lazy-load flashes. Each loader only
    // fetches + stores into STATE; paint() does ALL the DOM rendering.
    await Promise.all([
      loadMe(),
      loadEraEligible(),
      loadLots(),
      loadFa(),
      loadBidHistory(),
    ]);
    paint();

    // Adaptive auto-refresh: normally every 30s, but 15s whenever any open lot is
    // in its final 15 minutes — "can't have anyone miss out on a timing difference"
    // (Keith). Self-rescheduling (not setInterval) so the cadence is recomputed
    // from freshly-loaded lots each tick, and so two refreshes never overlap.
    const REFRESH_FAST_MS = 15000, REFRESH_SLOW_MS = 30000, FINAL_WINDOW_SEC = 900;
    function nextRefreshMs() {
      const lots = (STATE.lots && STATE.lots.lots) || [];
      let minLeft = Infinity;
      for (const l of lots) {
        if (l.status !== "open") continue;
        // Prefer MFL's overlaid countdown over D1's (which can over-state via a
        // forced-increase reset) so we speed up when the REAL clock is short.
        const ov = _overlaidLot(l.player_id);
        const s = (ov && Number.isFinite(Number(ov.seconds_remaining)))
          ? Number(ov.seconds_remaining) : Number(l.seconds_remaining);
        if (isFinite(s) && s > 0 && s < minLeft) minLeft = s;
      }
      return minLeft <= FINAL_WINDOW_SEC ? REFRESH_FAST_MS : REFRESH_SLOW_MS;
    }
    async function refreshTick() {
      try {
        // Self-heal the once-loaded bid history if it failed at boot.
        await Promise.all([loadLots(), loadFa(), loadBidHistory()]);
        paint();
      } catch (e) {
        console.error("[auction-hub] refresh tick failed:", e);
      } finally {
        setTimeout(refreshTick, nextRefreshMs());
      }
    }
    setTimeout(refreshTick, nextRefreshMs());

    // And tick the time-remaining countdowns every second.
    setInterval(updateNominationCountdowns, 1000);
  }

  async function loadMe() {
    const hpmFid = _hpmFranchiseId();
    const qs = "?L=" + LEAGUE_ID + (hpmFid ? "&franchise_id=" + hpmFid : "");
    try {
      const r = await fetch(apiUrl("/api/me") + qs, { cache: "no-store" });
      STATE.me = r.ok ? await r.json() : { configured: false };
    } catch (e) {
      STATE.me = { configured: false };
    }
    if (hpmFid) {
      STATE.me = Object.assign({}, STATE.me || {}, {
        configured: true,
        franchise_id: hpmFid,
        source: "hpm",
      });
    }
  }

  async function loadEraEligible() {
    const season = new Date().getUTCFullYear();
    const tbody = $("#era-tbody");
    try {
      const data = await fetchJSON(apiUrl("/api/auction/era-eligible") + "?L=" + LEAGUE_ID + "&YEAR=" + season);
      STATE.era = data;
    } catch (e) {
      console.error("[auction-hub] era-eligible fetch failed:", e);
      STATE.era = { players: [], error: String(e && e.message || e) };
      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="13" style="text-align:center;color:var(--err);padding:24px;">
          Failed to load eligible players: ${escapeHtml(STATE.era.error)}
        </td></tr>`;
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // TABS
  // ════════════════════════════════════════════════════════════════════
  // Top tabs = the two auctions. Switching tabs keeps the same sub-section
  // (Summary stays Summary, etc.) and repaints. Bound once in init().
  function setupTabs() {
    $$("#ah-tabs button").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.disabled) return;
        const tab = btn.dataset.tab;
        if (!tab || tab === STATE.tab) return;
        STATE.tab = tab;
        paint();
      });
    });
  }

  // Sub-nav pills (Summary · Players · Lots · History · Tracker). Their inner
  // buttons re-render every paint, so we delegate from the persistent #ah-subnav.
  function setupSubNav() {
    const nav = $("#ah-subnav");
    if (!nav) return;
    nav.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-sub]");
      if (!btn) return;
      const sub = btn.dataset.sub;
      if (!sub || sub === STATE.sub) return;
      STATE.sub = sub;
      paint();
    });
  }

  function renderTabs() {
    $$("#ah-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === STATE.tab));
  }
  function renderSubNav() {
    const nav = $("#ah-subnav");
    if (!nav) return;
    nav.innerHTML = SUBS.map((s) =>
      `<button type="button" data-sub="${s.key}" class="${s.key === STATE.sub ? "active" : ""}">${escapeHtml(s.label)}</button>`
    ).join("");
  }

  // The single banner above the content reflects the ACTIVE auction's switch.
  function renderBanner() {
    const el = $("#ah-banner");
    if (!el) return;
    const f = STATE.lots || {};
    const isEra = STATE.tab === "era";
    const enabled = isEra ? !!f.era_enabled : !!f.faa_enabled;
    if (enabled) { el.style.display = "none"; el.innerHTML = ""; return; }
    const name = isEra ? "The Expired-Rookie Auction" : "The FA Auction";
    const when = isEra ? "Runs Memorial Day weekend." : "Opens the last weekend of July.";
    el.style.display = "";
    el.innerHTML = `<strong>${escapeHtml(name)} isn't running right now.</strong> ` +
      escapeHtml(when) + " Browse the pool below — bidding opens on MFL when the commissioner turns it on.";
  }

  // Set of player_ids in the ERA-eligible pool. A lot/bid belongs to the ERA
  // iff its player is in this set, else it's an FA-auction lot (lots/bids
  // aren't kind-tagged in D1). Mirrors the mobile app's eraPoolIds().
  function eraPoolIds() {
    const s = new Set();
    const players = (STATE.era && STATE.era.players) || [];
    for (const p of players) if (p.player_id != null) s.add(String(p.player_id));
    return s;
  }

  // Classify a lot's auction. Prefer the server flag is_era_eligible
  // (populated from the SEASON-PERSISTENT ups_era_pool, so a WON ERA player
  // still reads true); fall back to current-pool membership only when the
  // flag is absent (older payloads). Without this, a won ERA player drops out
  // of STATE.era.players and its lot leaks into the FAA KPIs.
  function lotIsEra(l, eraIds) {
    if (l && l.is_era_eligible === true) return true;
    if (l && l.is_era_eligible === false) return false;
    return eraIds.has(String(l.player_id));
  }

  // ════════════════════════════════════════════════════════════════════
  // PAINT — mount the (tab, sub) skeleton, fill it, re-wire its controls
  // ════════════════════════════════════════════════════════════════════
  function paint() {
    renderHeaderMeta();
    renderTabs();
    renderSubNav();
    renderBanner();
    renderSub(STATE.tab, STATE.sub);
  }

  // Header meta line (#ah-meta) — set on every paint regardless of tab, so it
  // never sticks on "Loading…" when the default (FAA) tab is showing.
  function renderHeaderMeta() {
    const el = $("#ah-meta");
    if (!el) return;
    const me = STATE.me || {};
    const youAre = me.configured && me.franchise_name
      ? `You: ${me.franchise_name}`
      : me.configured && me.franchise_id
        ? `You: franchise ${me.franchise_id}`
        : "Viewer (not logged in)";
    const season = (STATE.era && STATE.era.season) || new Date().getUTCFullYear();
    const lots = STATE.lots || {};
    const gen = lots.generated_at
      ? new Date(lots.generated_at).toLocaleTimeString()
      : (STATE.era && STATE.era.generated_at ? new Date(STATE.era.generated_at).toLocaleTimeString() : "—");
    el.textContent = `${youAre} · Season ${season} · Updated ${gen}`;
  }

  function renderSub(tab, sub) {
    const content = $("#ah-content");
    if (!content) return;
    switch (sub) {
      case "players": content.innerHTML = skeletonPlayers(tab); fillPlayers(tab); break;
      case "lots":    content.innerHTML = skeletonLots(tab);    fillLots(tab);    break;
      case "history": content.innerHTML = skeletonHistory(tab); fillHistory(tab); break;
      case "tracker": content.innerHTML = skeletonTracker(tab); fillTracker(tab); break;
      case "summary":
      default:        content.innerHTML = skeletonSummary(tab); fillSummary(tab); break;
    }
  }

  // ── Headline KPIs (top of every Summary) ──────────────────────────────
  function renderKpis(tab) {
    const el = $("#ah-kpis");
    if (!el) return;
    const lots = (STATE.lots && STATE.lots.lots) || [];
    const eraIds = eraPoolIds();
    const tabLots = lots.filter((l) => lotIsEra(l, eraIds) === (tab === "era"));
    const open = tabLots.filter((l) => l.status === "open").length;
    const won = tabLots.filter((l) => l.status === "won").length;
    const f = STATE.lots || {};
    const enabled = tab === "era" ? !!f.era_enabled : !!f.faa_enabled;
    // "1833 free agents" is a fact about the database, not about you — it never
    // changed what anyone did next (Keith 2026-07-15: "1833 means nothing").
    // Replaced with YOUR roster and the two numbers that actually bound your
    // auction: how many you MUST still add, and how many you MAY.
    //
    // Canon §A2: max roster 35 DURING the auction; min roster 27 at its CLOSE —
    // the roster floats below 27 while it runs, so "min to add" is a
    // by-the-end obligation, not a right-now violation. The tooltip has to say
    // that or the number reads as an accusation.
    // LEAGUE-WIDE, not yours (Keith 2026-07-15). The Summary is the state of the
    // auction, not of one team — and league-wide these answer the only question
    // "1833 free agents" pretended to: how much demand is still in the room. MIN
    // is the floor of players that MUST still be bought before the auction can
    // close legally; MAX is the ceiling the league can absorb.
    //
    // (This shipped viewer-scoped by mistake — the league-wide edit was made but
    // never made it into the commit that merged as #715.)
    const ROSTER_MIN_AT_CLOSE = 27, ROSTER_MAX_DURING = 35;
    const budgetRows = (STATE.fa && STATE.fa.team_budget_rows) || [];

    let firstTile;
    if (budgetRows.length) {
      let rostered = 0, minAdd = 0, maxAdd = 0;
      for (const r of budgetRows) {
        const n = Number(r.roster_count) || 0;
        rostered += n;
        minAdd += Math.max(0, ROSTER_MIN_AT_CLOSE - n);
        maxAdd += Math.max(0, ROSTER_MAX_DURING - n);
      }
      // Canon §A2: 35 max DURING, 27 min at the CLOSE — rosters float below 27
      // while it runs, so "min to add" is a by-the-end obligation, not a
      // violation right now. Say that, or the number reads as an accusation.
      const tip =
        `League-wide across ${budgetRows.length} teams. Rostered: ${rostered}. ` +
        `Every team must be at ${ROSTER_MIN_AT_CLOSE} when the auction CLOSES — rosters float below while it runs — ` +
        `so at least ${minAdd} more players must still be bought. ` +
        `${ROSTER_MAX_DURING} is the hard cap during the auction, so the league can absorb at most ${maxAdd}.`;
      firstTile =
        `<div class="ah-kpi ah-kpi-roster" title="${escapeHtml(tip)}">` +
          `<div class="ah-kpi-triple">` +
            `<span><b>${rostered}</b><i>Rostered</i></span>` +
            `<span><b>+${minAdd}</b><i>Min to add</i></span>` +
            `<span><b>+${maxAdd}</b><i>Max to add</i></span>` +
          `</div>` +
        `</div>`;
    } else {
      firstTile =
        `<div class="ah-kpi" title="Waiting on the live board.">` +
          `<div class="ah-kpi-val">—</div><div class="ah-kpi-label">Rostered</div></div>`;
    }

    const kpis = [
      ["Open lots", open],
      ["Won", won],
      ["Status", enabled ? "LIVE" : "Not running"],
    ];
    el.innerHTML = firstTile + kpis.map(([label, val]) =>
      `<div class="ah-kpi"><div class="ah-kpi-val">${escapeHtml(String(val))}</div>` +
      `<div class="ah-kpi-label">${escapeHtml(label)}</div></div>`
    ).join("");
  }

  // ════════════════════════════════════════════════════════════════════
  // SKELETONS — card/table markup with the ids each renderer writes into.
  // Lifted from the old static .ah-section blocks so the existing renderers
  // keep working unchanged (lowest-risk path for the ERA sortable table).
  // ════════════════════════════════════════════════════════════════════
  function kpisSkeleton() {
    return `<div class="ah-kpis" id="ah-kpis"></div>`;
  }
  function faBudgetsSkeleton() {
    return `
      <div class="ah-card">
        <div class="ah-card-head">
          <h2>Team Budgets</h2>
          <span class="small">Most you can spend on one player and still afford a legal roster — filling to the 27-man minimum vs a full 35-man roster (§B1). Available Funds is net of cap penalties, traded-salary settlements, and money committed to lots you're leading. Your own row counts your proxy (max) bid; every other team shows only their public current bid.</span>
        </div>
        <div id="fa-budgets-warn" class="small" style="display:none;color:var(--warn,#e0a030);padding:0 0 8px;"></div>
        <table class="ah-table" id="fa-budgets-table">
          <thead>
            <tr>
              <th>Team</th>
              <th class="num">Salary + Adjustments</th>
              <th class="num">Allocated to High Bids</th>
              <th class="num">Available Funds</th>
              <th class="num">Max Bid → 27-man</th>
              <th class="num">Max Bid → 35-man</th>
            </tr>
          </thead>
          <tbody id="fa-budgets-tbody">
            <tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px;">Loading budgets…</td></tr>
          </tbody>
        </table>
      </div>`;
  }
  function faNeedsSkeleton() {
    return `
      <div class="ah-card">
        <div class="ah-card-head">
          <h2>Roster Needs</h2>
          <span class="small">Starters still needed to field a legal lineup.</span>
        </div>
        <table class="ah-table" id="fa-needs-table">
          <thead>
            <tr>
              <th>Team</th>
              <th class="num">Roster</th>
              <th class="num">Total Need</th>
              <th>Lineup Deficits</th>
            </tr>
          </thead>
          <tbody id="fa-needs-tbody">
            <tr><td colspan="4" style="text-align:center;color:var(--muted);padding:24px;">Loading needs…</td></tr>
          </tbody>
        </table>
      </div>`;
  }
  function faPoolSkeleton() {
    return `
      <div class="ah-card">
        <div class="ah-card-head">
          <h2>Available Players</h2>
          <span class="small" id="fa-pool-summary">—</span>
        </div>
        <div class="ah-filters" id="fa-pool-filters">
          <label>
            <span>Position</span>
            <div class="ah-pos-chips" id="fapool-pos-chips">
              <button type="button" class="ah-pos-chip active" data-pos="ALL">All</button>
              <button type="button" class="ah-pos-chip" data-pos="QB">QB</button>
              <button type="button" class="ah-pos-chip" data-pos="RB">RB</button>
              <button type="button" class="ah-pos-chip" data-pos="WR">WR</button>
              <button type="button" class="ah-pos-chip" data-pos="TE">TE</button>
              <button type="button" class="ah-pos-chip" data-pos="PK">PK</button>
              <button type="button" class="ah-pos-chip" data-pos="PN">PN</button>
              <button type="button" class="ah-pos-chip" data-pos="DL">DL</button>
            <button type="button" class="ah-pos-chip" data-pos="LB">LB</button>
            <button type="button" class="ah-pos-chip" data-pos="DB">DB</button>
            </div>
          </label>
          <label><span>NFL Team</span><select id="fapool-team"><option value="">All</option></select></label>
          <label><span>Search</span><input type="text" id="fapool-search" placeholder="Player name or ID…" autocomplete="off" /></label>
        </div>
        <table class="ah-table" id="fa-pool-table">
          <thead>
            <tr>
              <th>Player</th>
              <th>Pos</th>
              <th class="col-md">NFL</th>
              <th title="Multi-source ADP (same board as the Stats workbench). Leads with POSITIONAL rank (QB4 / WR12 / DE7). Offense = redraft consensus of FantasyCalc + KeepTradeCut (SF), with FFC + Sleeper reference; IDP ranked independently on FantasyPros dynasty ECR. Hover the 'N src' chip for each source's positional rank.">ADP</th>
              <th title="Prior season: per-game PPG (and total points once the points pipeline deploys)">Prior season</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="fa-pool-tbody">
            <tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px;">Loading free agents…</td></tr>
          </tbody>
        </table>
      </div>`;
  }
  function eraContextSkeleton() {
    return `
      <div class="ah-context-banner">
        <strong>Expired Rookie Auction (ERA)</strong> — players whose rookie contract expired and were
        not extended by the rookie extension deadline (Thu before Memorial Day weekend). Starting bid
        <strong>$1K</strong>, 36-hour lock window, $1K increments. Each owner may submit
        <strong>1 nomination per 12-hour window</strong> (anchored to 6 AM / 6 PM ET). Opens Memorial Day
        Mon 6 AM ET; nominations close at the end of the Wed 6 PM → Thu 6 AM ET window. Forced retention
        through FA Auction close.
        <div class="meta" id="era-context-meta">Eligibility deadline: loading…</div>
      </div>`;
  }
  function eraFiltersSkeleton() {
    return `
      <div class="ah-filters" id="era-filters">
        <label>
          <span>Position</span>
          <div class="ah-pos-chips" id="era-pos-chips">
            <button type="button" class="ah-pos-chip active" data-pos="ALL">All</button>
            <button type="button" class="ah-pos-chip" data-pos="QB">QB</button>
            <button type="button" class="ah-pos-chip" data-pos="RB">RB</button>
            <button type="button" class="ah-pos-chip" data-pos="WR">WR</button>
            <button type="button" class="ah-pos-chip" data-pos="TE">TE</button>
            <button type="button" class="ah-pos-chip" data-pos="PK">PK</button>
            <button type="button" class="ah-pos-chip" data-pos="PN">PN</button>
            <button type="button" class="ah-pos-chip" data-pos="DL">DL</button>
              <button type="button" class="ah-pos-chip" data-pos="LB">LB</button>
              <button type="button" class="ah-pos-chip" data-pos="DB">DB</button>
          </div>
        </label>
        <label>
          <span>Prior Owner</span>
          <select id="era-filter-owner"><option value="">All</option></select>
        </label>
        <span class="ah-filters-summary" id="era-filters-summary">— eligible</span>
      </div>`;
  }
  function eraTableSkeleton() {
    return `
      <div class="ah-card">
        <div class="ah-card-head">
          <h2>ERA-Eligible Players</h2>
          <span class="small" id="era-table-summary">Loading…</span>
        </div>
        <table class="ah-table" id="era-table">
          <thead>
            <tr>
              <th data-sort="name">Player</th>
              <th data-sort="position">Pos</th>
              <th data-sort="nfl_team" class="col-md">NFL</th>
              <th data-sort="origin_label">Origin</th>
              <th data-sort="ppg_2023" class="num col-lo">2023 PPG</th>
              <th data-sort="ppg_2024" class="num col-lo">2024 PPG</th>
              <th data-sort="ppg_2025" class="num col-lo">2025 PPG</th>
              <th data-sort="ppg_weighted" class="num">Wtd PPG</th>
              <th data-sort="high_bid_k" class="num col-md">High Bid</th>
              <th data-sort="high_bid_team" class="col-md">High Bidder</th>
              <th data-sort="total_bids" class="num col-lo">Bids</th>
              <th data-sort="time_remaining" class="col-md">Time Left</th>
              <th data-sort="lot_status">Actions</th>
            </tr>
          </thead>
          <tbody id="era-tbody">
            <tr><td colspan="13" style="text-align:center;color:var(--muted);padding:24px;">Loading eligible players…</td></tr>
          </tbody>
        </table>
      </div>`;
  }
  function nominationsSkeleton() {
    const isEra = STATE.tab === "era";
    const note = isEra
      ? "ERA lots — 36-hour lock window resets from the most recent high bid (§A3)."
      : "FA Auction lots — 24-hour lock window resets from the most recent high bid (§A1).";
    return `
      <div class="ah-context-banner">
        <strong>Lots</strong> — ${note} Use the status chips to switch between open lots and completed wins.
        Your private proxy bid shows only when you're signed in as that franchise.
        <div class="meta" id="nominations-meta">Loading…</div>
      </div>
      <div class="ah-filters" id="nominations-filters">
        <label>
          <span>Status</span>
          <div class="ah-pos-chips" id="nominations-status-chips">
            <button type="button" class="ah-pos-chip" data-nstatus="open">Open</button>
            <button type="button" class="ah-pos-chip" data-nstatus="won">Completed</button>
            <button type="button" class="ah-pos-chip" data-nstatus="all">All</button>
          </div>
        </label>
        <label>
          <span>Sort</span>
          <select id="nominations-sort">
            <option value="time_remaining">Time remaining (asc)</option>
            <option value="current_high_bid_k">Current high bid (desc)</option>
            <option value="bid_count">Bid count (desc)</option>
            <option value="opened_at_unix">Most recently opened</option>
          </select>
        </label>
        <label>
          <span>Test lots</span>
          <div class="ah-pos-chips">
            <button type="button" class="ah-pos-chip" id="nominations-test-toggle" style="display:none;">Show test (0)</button>
            <button type="button" class="ah-pos-chip" id="nominations-test-delete" style="display:none;color:#e06b5e;" title="Permanently delete ALL test lots + their bids from the board (commish only)">🗑 Delete test lots</button>
          </div>
        </label>
        <span class="ah-filters-summary" id="nominations-summary">— lots</span>
      </div>
      <div class="ah-card">
        <div class="ah-card-head">
          <h2>Lots</h2>
          <span class="small" id="nominations-table-summary">Loading…</span>
        </div>
        <table class="ah-table" id="nominations-table">
          <thead>
            <tr>
              <th>Player</th>
              <th>Pos</th>
              <th class="col-md">NFL</th>
              <th>Nominator</th>
              <th class="num">High Bid</th>
              <th>High Bidder</th>
              <th class="num col-md">Bids</th>
              <th class="num col-md">Bidders</th>
              <th>Time Remaining</th>
              <th class="col-md">Your Proxy</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="nominations-tbody">
            <tr><td colspan="11" style="text-align:center;color:var(--muted);padding:24px;">Loading lots…</td></tr>
          </tbody>
        </table>
      </div>`;
  }
  function historySkeleton() {
    return `
      <div class="ah-context-banner">
        <strong>Bid History</strong> — chronological feed from <code>ups_auction_bids</code>, grouped by lot.
        Latest bid surfaces; click a thread to expand the full sequence with timestamps.
        <span class="ah-legend">
          <span class="ah-legend-item">🆕 Nom</span>
          <span class="ah-legend-item ah-help" title="Same franchise as the previous high bidder — MFL walked their hidden max up because someone else bid into their proxy range.">⬆ Forced Increase <span class="ah-help-q">ⓘ</span></span>
          <span class="ah-legend-item">💰 Overtake</span>
        </span>
      </div>
      <div class="ah-filters" id="history-filters">
        <label>
          <span>Filter by player</span>
          <input type="text" id="history-player-filter" placeholder="Player name or ID…" />
        </label>
        <label>
          <span>Filter by franchise</span>
          <select id="history-franchise-filter"><option value="">All franchises</option></select>
        </label>
        <label>
          <span>Event type</span>
          <select id="history-kind-filter">
            <option value="">All</option>
            <option value="nomination">Nominations</option>
            <option value="overtake">Overtakes (different franchise)</option>
            <option value="forced_increase">Forced Increases (same franchise)</option>
          </select>
        </label>
      </div>
      <div class="ah-card">
        <div class="ah-card-head">
          <h2>Recent Activity</h2>
          <span class="small" id="history-count">—</span>
        </div>
        <div id="history-feed">
          <div class="ah-placeholder">Loading bid history…</div>
        </div>
      </div>`;
  }
  function trackerSkeleton(tab) {
    const auc = tab === "era" ? "Expired Rookie Auction" : "FA Auction";
    // ERA is optional participation with no missed-nomination fine (§A3); the
    // old copy said owners "owe … 2 a day", the exact inverse of canon.
    const cadence = tab === "era"
      ? "at most 1 nomination per 12-hour window (6 AM / 6 PM ET) — participation is optional, no missed-nomination fine (§A3)"
      : "exactly 2 nominations per ET day — a minimum (missed noms carry escalating fines) and a maximum (a 3rd is a violation) (§A2)";
    const verb = tab === "era" ? "Each owner may make" : "Each owner owes";
    return `
      <div class="ah-context-banner">
        <strong>Nominations Tracker</strong> — daily nomination compliance + the full audit trail for the
        ${escapeHtml(auc)}. ${escapeHtml(verb)} <strong>${escapeHtml(cadence)}</strong>. Click any owner to see
        exactly which players they nominated and when.
        <div class="meta" id="ah-noms-meta">Loading…</div>
      </div>
      <div id="ah-noms-audit"><div class="ah-placeholder">Loading nominations…</div></div>`;
  }

  // ── Skeleton composers per (tab, sub) ─────────────────────────────────
  function skeletonSummary(tab) {
    return tab === "faa"
      ? kpisSkeleton() + faBudgetsSkeleton() + faNeedsSkeleton()
      : kpisSkeleton() + eraContextSkeleton();
  }
  function skeletonPlayers(tab) {
    return tab === "faa"
      ? faPoolSkeleton()
      : eraFiltersSkeleton() + eraTableSkeleton();
  }
  function skeletonLots() { return nominationsSkeleton(); }
  function skeletonHistory() { return historySkeleton(); }
  function skeletonTracker(tab) { return trackerSkeleton(tab); }

  // ── Fill + re-wire per (tab, sub) ─────────────────────────────────────
  function fillSummary(tab) {
    renderKpis(tab);
    if (tab === "faa") {
      const fa = STATE.fa || {};
      renderFaBudgets(fa.team_budget_rows || []);
      renderFaNeeds(fa.team_need_rows || []);
    } else {
      renderEraMeta();
    }
  }
  function fillPlayers(tab) {
    if (tab === "faa") {
      renderFaPool(STATE.faPool || []);
      setupFaPoolFilters();   // re-wire — the filter controls are new DOM each mount
      return;
    }
    renderEraMeta();        // (re)populates the prior-owner dropdown
    syncEraFilterChips();   // reflect STATE.era_filters on the fresh chips/select
    renderEraTable();
    setupFilters();         // re-wire — the chips/select are new DOM each mount
    setupSorting();
  }
  function fillLots() {
    syncNomStatusChips();   // reflect STATE.nom_filters/nom_sort on fresh controls
    renderNominations();    // reads STATE.tab for the per-auction split
    setupNominationsControls();
  }
  function fillHistory() {
    populateHistoryFranchiseFilter();
    renderBidHistory();     // reads STATE.tab for the per-auction split
    setupHistoryFilters();
  }
  function fillTracker(tab) {
    renderNominationsAudit(tab);
  }

  // ── Nominations audit (Tracker) ───────────────────────────────────────
  // Daily nomination compliance + a click-to-expand audit trail, per auction.
  // Source: the nomination-tagged bids in STATE.bidHistory, grouped by ET day.
  const _p4 = (v) => String(v == null ? "" : v).replace(/\D/g, "").padStart(4, "0");
  function etDayParts(unix) {
    const ms = Number(unix) * 1000;
    return {
      key: new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" }), // YYYY-MM-DD
      label: new Date(ms).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" }),
    };
  }
  function etTimeOnly(unix) {
    return new Date(Number(unix) * 1000).toLocaleString("en-US", {
      timeZone: "America/New_York", hour: "numeric", minute: "2-digit", hour12: true,
    });
  }
  // The viewer's FAA nominations on the current ET day (§A2 cap = 2). Counts
  // client-side off bid history; the authoritative count lives server-side in
  // /api/auction/nominate, which also sees nominations made natively on MFL.
  function myFaaNomsToday() {
    const myFid = STATE.me && STATE.me.franchise_id ? _p4(STATE.me.franchise_id) : null;
    if (!myFid) return 0;
    const today = etDayParts(Math.floor(Date.now() / 1000)).key;
    const eraIds = eraPoolIds();
    return ((STATE.bidHistory && STATE.bidHistory.bids) || [])
      .filter((b) => b.is_nomination)
      .filter((b) => !eraIds.has(String(b.player_id)))
      .filter((b) => _p4(b.fid) === myFid)
      .filter((b) => etDayParts(b.bid_at_unix).key === today)
      .length;
  }

  function renderNominationsAudit(tab) {
    const host = $("#ah-noms-audit");
    if (!host) return;
    const REQ = 2;
    const myFid = STATE.me && STATE.me.franchise_id ? _p4(STATE.me.franchise_id) : null;
    const live = tab === "era"
      ? !!(STATE.lots && STATE.lots.era_enabled)
      : !!(STATE.lots && STATE.lots.faa_enabled);

    // Full owner list (so we can audit who DIDN'T nominate too), from the FA
    // live budget rows — those carry all franchises regardless of auction.
    const owners = ((STATE.fa && STATE.fa.team_budget_rows) || [])
      .map((r) => ({ fid: _p4(r.franchise_id), name: r.franchise_name || franchiseName(r.franchise_id) }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));

    // Nominations for this auction (per-auction split on the ERA pool).
    const eraIds = eraPoolIds();
    const noms = ((STATE.bidHistory && STATE.bidHistory.bids) || [])
      .filter((b) => b.is_nomination)
      .filter((b) => eraIds.has(String(b.player_id)) === (tab === "era"))
      .map((b) => { const d = etDayParts(b.bid_at_unix); return { fid: _p4(b.fid), player: b.player_name, unix: b.bid_at_unix, dayKey: d.key, dayLabel: d.label }; });

    const byDay = new Map();
    noms.forEach((n) => { if (!byDay.has(n.dayKey)) byDay.set(n.dayKey, { label: n.dayLabel, items: [] }); byDay.get(n.dayKey).items.push(n); });
    const dayKeysDesc = [...byDay.keys()].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

    const meta = $("#ah-noms-meta");
    if (meta) {
      meta.textContent = noms.length
        ? `${noms.length} nomination${noms.length === 1 ? "" : "s"} across ${dayKeysDesc.length} day${dayKeysDesc.length === 1 ? "" : "s"} · latest ${byDay.get(dayKeysDesc[0]).label}`
        : "No nominations recorded yet.";
    }

    // One day card: per-owner X/REQ, each owner expandable to the players
    // they nominated that day.
    function dayCard(label, items, isToday, openByDefault) {
      const ownerRows = owners.map((o) => {
        const mine = items.filter((n) => n.fid === o.fid).sort((a, b) => a.unix - b.unix);
        const c = mine.length;
        // c > REQ is a violation, not a clean day — `c >= REQ` used to paint it
        // green, which is how a 3-nomination day read as compliant.
        const cls = c > REQ ? "ah-nom-over" : (c === REQ ? "ah-nom-met" : (c > 0 ? "ah-nom-partial" : "ah-nom-zero"));
        const body = c > 0
          ? `<ul class="ah-nom-players">${mine.map((n) => `<li>${escapeHtml(n.player || "—")} <span class="ah-nom-when">${escapeHtml(etTimeOnly(n.unix))}</span></li>`).join("")}</ul>`
          : `<div class="ah-nom-empty">No nominations this day.</div>`;
        return `<details class="ah-nom-owner ${cls}${o.fid === myFid ? " ah-nom-me" : ""}">
          <summary><span class="ah-nom-oname">${escapeHtml(o.name)}</span><span class="ah-nom-count">${c}/${REQ}${c > REQ ? " ⚠" : ""}</span></summary>
          ${body}
        </details>`;
      }).join("");
      const total = items.length;
      // Exactly REQ — an over-cap franchise is not a franchise that "met" it.
      const metCount = owners.filter((o) => items.filter((n) => n.fid === o.fid).length === REQ).length;
      const overCount = owners.filter((o) => items.filter((n) => n.fid === o.fid).length > REQ).length;
      return `<details class="ah-card ah-nom-day"${openByDefault ? " open" : ""}>
        <summary class="ah-nom-day-head">
          <strong>${escapeHtml(label)}${isToday ? " · Today" : ""}</strong>
          <span class="small ah-nom-day-sum">${total} nom${total === 1 ? "" : "s"} · ${metCount}/${owners.length} owners met${overCount ? ` · <span class="ah-nom-over-tag">${overCount} over cap ⚠</span>` : ""}</span>
        </summary>
        <div class="ah-nom-grid">${ownerRows}</div>
      </details>`;
    }

    let html = "";
    // While the auction is live, lead with Today's compliance scoreboard (even
    // if 0 noms so far). Off-season we skip it — no point nagging 0/2 when the
    // auction isn't running (Keith 2026-06-20).
    if (live && owners.length) {
      const today = etDayParts(Math.floor(Date.now() / 1000));
      const todayItems = (byDay.get(today.key) || { items: [] }).items;
      html += dayCard(today.label, todayItems, true, true);
    }
    const todayKey = etDayParts(Math.floor(Date.now() / 1000)).key;
    dayKeysDesc.filter((k) => !(live && k === todayKey)).forEach((k) => {
      const v = byDay.get(k);
      html += dayCard(v.label, v.items, k === todayKey, !live && k === dayKeysDesc[0]);
    });

    if (!html) {
      host.innerHTML = `<div class="ah-placeholder"><strong>No nominations yet</strong>
        Once the auction is running, each owner's daily nominations (X/${REQ}) show here —
        click any owner to audit exactly which players they nominated and when.</div>`;
      return;
    }
    host.innerHTML = html;
  }

  // ── Sync freshly-mounted controls to persisted STATE ──────────────────
  function syncEraFilterChips() {
    $$("#era-pos-chips .ah-pos-chip").forEach((c) =>
      c.classList.toggle("active", (c.dataset.pos || "ALL") === STATE.era_filters.pos));
    const sel = $("#era-filter-owner");
    if (sel && STATE.era_filters.owner) sel.value = STATE.era_filters.owner;
  }
  function syncNomStatusChips() {
    $$("#nominations-status-chips .ah-pos-chip").forEach((c) =>
      c.classList.toggle("active", (c.dataset.nstatus || "open") === STATE.nom_filters.status));
    const sel = $("#nominations-sort");
    if (sel) sel.value = STATE.nom_sort;
  }
  // Populate the History franchise dropdown from the loaded bid set (league-wide).
  function populateHistoryFranchiseFilter() {
    const sel = $("#history-franchise-filter");
    if (!sel) return;
    const data = STATE.bidHistory || {};
    const seen = new Set();
    const opts = [];
    for (const b of (data.bids || [])) {
      if (!b.fid || seen.has(b.fid)) continue;
      seen.add(b.fid);
      opts.push({ fid: b.fid, name: b.franchise_name });
    }
    opts.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    sel.innerHTML = `<option value="">All franchises</option>` +
      opts.map((o) => `<option value="${escapeHtml(o.fid)}">${escapeHtml(o.name)}</option>`).join("");
  }

  // ════════════════════════════════════════════════════════════════════
  // FA AUCTION POOL  (+ ERA / FA "is it live" banners)
  // ════════════════════════════════════════════════════════════════════
  // The commish ERA/FAA switches (surfaced on /api/auction/lots as
  // era_enabled / faa_enabled) gate each auction. OFF → the tab shows a
  // read-only "not running" banner over a browsable pool; ON → a live board.
  // Mirrors the mobile app: one set of switches drives both surfaces.
  function setAuctionBanner(elId, name, enabled, whenText) {
    const el = document.getElementById(elId);
    if (!el) return;
    if (enabled) { el.style.display = "none"; el.innerHTML = ""; return; }
    el.style.display = "";
    el.innerHTML = `<strong>${escapeHtml(name)} isn't running right now.</strong> ` +
      (whenText ? escapeHtml(whenText) + " " : "") +
      "Browse the pool below — bidding opens on MFL when the commissioner turns it on.";
  }
  // Legacy entrypoint (renderFa still calls it) → now drives the single
  // #ah-banner for the active auction. setAuctionBanner is retained above
  // for reference but no longer wired to per-auction banner elements.
  function refreshAuctionBanners() {
    renderBanner();
  }

  async function loadFa() {
    const season = new Date().getUTCFullYear();
    const hpmFid = (STATE.me && STATE.me.franchise_id) || _hpmFranchiseId();
    let url = apiUrl("/acquisition-hub/free-agent-auction/live") + "?L=" + LEAGUE_ID + "&YEAR=" + season;
    if (hpmFid) url += "&F=" + encodeURIComponent(hpmFid);
    url = _withUserId(url);   // forward the viewer's token so the worker overlays THEIR proxy
    const meta = $("#fa-context-meta");
    // The live board (budgets/needs/lots) + the full FA nominate pool (every
    // unrostered player, enriched). available_players is empty off-season, so
    // the pool comes from /api/auction/fa-pool.
    const poolUrl = apiUrl("/api/auction/fa-pool") + "?L=" + LEAGUE_ID + "&YEAR=" + season;
    // The pool (~1800 enriched players) and the ADP board are HEAVY and change
    // slowly; loadFa() runs on the 30s refresh, so re-pulling them every tick
    // was both wasteful and the main source of transient failures. Refresh them
    // on a slow cadence (or whenever we don't have them yet); the 30s tick still
    // always refreshes the live board (`url`) + lots, which is what moves.
    const nowMs = Date.now();
    const havePool = Array.isArray(STATE.faPool) && STATE.faPool.length > 0;
    const haveAdp = STATE.faAdp && Object.keys(STATE.faAdp).length > 0;
    const poolStale = !havePool || (nowMs - (STATE._faPoolAt || 0)) > FA_POOL_TTL_MS;
    const adpStale = !haveAdp || (nowMs - (STATE._faAdpAt || 0)) > FA_POOL_TTL_MS;
    let boardErr = null;
    try {
      // Each fetch catches its OWN failure. The board used to be unguarded, so a
      // single 502 from it rejected the whole Promise.all — skipping every
      // assignment below, including the pool's, EVEN THOUGH the pool request had
      // succeeded. STATE.faPool stayed undefined and the Players tab read "FA
      // pool unavailable right now" while /api/auction/fa-pool was serving 1833
      // players just fine. The live board reaches MFL (O=43), so it is the most
      // failure-prone of the three; it must not be able to take the other two
      // down with it (Keith 2026-07-14).
      const [data, pool, adpRes] = await Promise.all([
        fetchJSON(url).catch((e) => { boardErr = e; return null; }),
        poolStale ? fetchJSON(poolUrl).catch(() => null) : Promise.resolve(null),
        adpStale ? fetchJSON(apiUrl("/api/adp-board")).catch(() => null) : Promise.resolve(null),   // SAME multi-source consensus as the Stats workbench
      ]);
      // Preserve last-good, same lesson as the pool below: the live board runs on
      // the 30s refresh, and a transient failure (worker 502, ok:false, empty)
      // used to overwrite a good board with {ok:false}, which has no
      // team_budget_rows — so the Summary tab would flash "No budget data yet"
      // and the KPIs would drop to 0 mid-auction. Only replace on a genuinely
      // successful read; otherwise keep what we had.
      if (data && data.ok !== false) {
        STATE.fa = data;
      } else if (!STATE.fa) {
        STATE.fa = data || { ok: false };
      }
      // NEVER wipe an already-loaded pool because one refresh hiccuped. A failed
      // (or empty) fetch used to blow STATE.faPool away to [], so the Players
      // tab would populate and then go blank ~30s later (Keith 2026-07-14).
      // Keep last-good; only replace on a genuinely successful, non-empty read.
      if (pool && pool.ok && Array.isArray(pool.players) && pool.players.length) {
        STATE.faPool = pool.players;
        STATE._faPoolAt = nowMs;
      } else if (!Array.isArray(STATE.faPool)) {
        STATE.faPool = [];
      }
      if (adpRes && adpRes.board) {
        STATE.faAdp = buildFaAdpMap(adpRes.board);
        STATE._faAdpAt = nowMs;
      } else if (!STATE.faAdp) {
        STATE.faAdp = {};
      }
      // The board failing no longer implies the pool failed — say only what's
      // actually broken, and keep reporting the pool we DO have.
      if (meta) {
        const poolTxt = `${(STATE.faPool || []).length} free agents`;
        if (boardErr || (data && data.ok === false)) {
          meta.textContent = `${poolTxt} · FA board unavailable right now (retrying)`;
        } else {
          meta.textContent = `${poolTxt} · ${(data.active_auctions || []).length} live lots · generated ${data.generated_at ? new Date(data.generated_at).toLocaleTimeString() : "—"}`;
        }
      }
      if (boardErr) {
        console.error("[auction-hub] FA live board failed (pool/ADP unaffected):", boardErr);
        // Don't clobber a good board with an error object — only record the
        // error if we never had a board to begin with.
        if (!STATE.fa) STATE.fa = { ok: false, error: String(boardErr.message || boardErr) };
      }
    } catch (e) {
      console.error("[auction-hub] FA render failed:", e);
      if (!STATE.fa) STATE.fa = { ok: false, error: String(e && e.message || e) };
      if (meta) meta.textContent = "Failed to load the FA board: " + (e && e.message || e);
    }
    renderFa();
  }

  function renderFa() {
    refreshAuctionBanners();
    const fa = STATE.fa || {};
    renderFaLots(fa.active_auctions || []);
    renderFaBudgets(fa.team_budget_rows || []);
    renderFaNeeds(fa.team_need_rows || []);
    renderFaPool(STATE.faPool || []);
  }

  function playerNameCell(pid, name) {
    return `<button type="button" class="ah-player-open player-link" data-action="open-player-modal" ` +
      `data-player-id="${escapeHtml(String(pid))}">${escapeHtml(name || ("Player #" + pid))}</button>`;
  }

  // Bid affordance for a lots row. When the viewer can bid in-app (real fid +
  // token) we render an in-app "Bid" button (opens the modal) PLUS a small "↗"
  // deep-link as the secondary path. Otherwise just the MFL deep-link — bidding
  // always works via MFL even when in-app isn't available. highK is $K.
  function bidActionCell(pid, name, auctionType, highK) {
    const link = `<a href="${mflBidUrl(pid)}" target="_blank" rel="noopener" class="btn small" title="Open MFL auction to bid/raise">Bid ↗</a>`;
    if (!_canBidInApp()) return link;
    // No row-level "↗" deep-link: clicking Bid opens the modal, which already
    // carries an "On MFL ↗" option — the extra arrow was redundant noise.
    return `<button type="button" class="btn small" data-action="open-bid-modal" ` +
      `data-player-id="${escapeHtml(String(pid))}" data-player-name="${escapeHtml(String(name || ""))}" ` +
      `data-auction-type="${escapeHtml(String(auctionType || "free-agent"))}" data-high-k="${Number(highK) || 0}">Bid</button>`;
  }

  function renderFaLots(rows) {
    const tbody = $("#fa-lots-tbody");
    const summary = $("#fa-lots-summary");
    if (summary) summary.textContent = rows.length + (rows.length === 1 ? " lot" : " lots");
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:24px;">No open FA lots right now.</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map((r) => {
      // high_bid_amount here is DOLLARS (money() renders it; may arrive as a
      // "$5,000" string from the O=43 scrape) — convert to $K for the modal min.
      const highK = Math.round((Number(String(r.high_bid_amount == null ? "" : r.high_bid_amount).replace(/[^0-9.\-]/g, "")) || 0) / 1000);
      return `<tr>
        <td>${playerNameCell(r.player_id, r.player_name)}</td>
        <td>${escapeHtml(String(r.position || "").toUpperCase() || "—")}</td>
        <td class="col-md">${escapeHtml(r.nfl_team || r.team || "—")}</td>
        <td class="num">${money(r.high_bid_amount)}</td>
        <td>${escapeHtml(r.high_bidder_label || "—")}</td>
        <td>${escapeHtml(r.timer_text || "—")}</td>
        <td>${bidActionCell(r.player_id, r.player_name, "free-agent", highK)}</td>
      </tr>`;
    }).join("");
  }

  function renderFaBudgets(rows) {
    const tbody = $("#fa-budgets-tbody");
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px;">No budget data yet.</td></tr>`;
      return;
    }
    // When the adjustments export is down we still show funds, but we say so —
    // an unflagged number here silently overstates every penalized team.
    const warn = $("#fa-budgets-warn");
    if (warn) {
      const known = STATE.fa ? STATE.fa.adjustments_ok !== false : true;
      warn.style.display = known ? "none" : "";
      warn.textContent = known ? "" : "⚠️ Cap penalties couldn't be loaded from MFL — Available Funds below may be overstated.";
    }
    const meFid = (STATE.me && STATE.me.franchise_id) || _hpmFranchiseId();
    const sorted = rows.slice().sort((a, b) => Number(b.available_funds_dollars || 0) - Number(a.available_funds_dollars || 0));
    tbody.innerHTML = sorted.map((r) => {
      const isMe = meFid && String(r.franchise_id).padStart(4, "0") === String(meFid).padStart(4, "0");
      const alloc = Number(r.allocated_to_high_bids_dollars || 0);
      // Only the viewer's own row reflects their proxy (max) bid — everyone
      // else's shows the current bid, so no one can read your ceiling.
      const allocCell = alloc > 0
        ? `${usd(alloc)}${isMe ? ' <span class="small" style="opacity:.7;">(your max)</span>' : ""}`
        : "—";
      return `<tr${isMe ? ' class="ah-row-me"' : ""}>
        <td>${escapeHtml(r.franchise_name || franchiseName(r.franchise_id))}</td>
        <td class="num">${usd(r.salary_plus_adjustments_dollars != null ? r.salary_plus_adjustments_dollars : r.cap_total_dollars)}</td>
        <td class="num">${allocCell}</td>
        <td class="num">${usd(r.available_funds_dollars)}</td>
        <td class="num">${usd(r.scenario_27_max_bid)}</td>
        <td class="num">${usd(r.scenario_35_max_bid)}</td>
      </tr>`;
    }).join("");
  }

  function renderFaNeeds(rows) {
    const tbody = $("#fa-needs-tbody");
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:24px;">No roster-need data yet.</td></tr>`;
      return;
    }
    const meFid = (STATE.me && STATE.me.franchise_id) || _hpmFranchiseId();
    const sorted = rows.slice().sort((a, b) => Number(b.total_deficit || 0) - Number(a.total_deficit || 0));
    tbody.innerHTML = sorted.map((r) => {
      const isMe = meFid && String(r.franchise_id).padStart(4, "0") === String(meFid).padStart(4, "0");
      const d = r.lineup_deficits || {};
      const deficits = Object.keys(d).filter((k) => d[k]).map((k) => `${k}:${d[k]}`).join(" ") || "Ready";
      return `<tr${isMe ? ' class="ah-row-me"' : ""}>
        <td>${escapeHtml(r.franchise_name || franchiseName(r.franchise_id))}</td>
        <td class="num">${Number(r.roster_count) || 0}</td>
        <td class="num">${Number(r.total_deficit) || 0}</td>
        <td>${escapeHtml(deficits)}</td>
      </tr>`;
    }).join("");
  }

  // mfl_id → multi-source ADP from /api/adp-board — the SAME board the Stats workbench consumes, and
  // mirroring its logic: SPLIT UNIVERSES. Offense is ranked by a REDRAFT consensus (FantasyCalc + KTC
  // redraft SF) — an auction is for THIS season, so an aging starter (Dak) out-ranks role players and
  // never falls under IDP. IDP is ranked INDEPENDENTLY on FantasyPros dynasty ECR (the only source that
  // covers IDP — FC/KTC/DP/Sleeper are offense-only), so a startable DL/LB/DB gets a real positional
  // rank instead of being dumped valueless at the bottom. Each player carries a POSITIONAL rank
  // (QB4 / WR12 / DE7) as the headline plus per-source positional ranks for a tooltip. Keith 2026-06-27.
  var _PID = function (r) { return String((r && (r.pid || r.player_id)) || ""); };
  // RANK-CONSENSUS redraft value (Keith 2026-07-13, mirrors trade_grader.
  // fetch_adp_board() / adpBuildRankConsensus() in stats_workbench.html — keep
  // in sync). KTC rarely publishes rsf at all, AND where it DOES, its redraft
  // $-scale isn't comparable to FC's (a KTC rsf ~4700-4800 can be only KTC's
  // own ~104th-110th-best redraft player) — faOffVal was averaging raw values
  // across incompatible scales. Fix: rank each source against only its own
  // reporting population, average available ranks across {fc.rsf desc,
  // ktc.rsf desc, ffcAdp asc (real live-draft ADP)}, map the consensus rank
  // back onto FC's rsf $-scale.
  function faRankMap(board, keyFn, ascending) {
    var scored = [];
    board.forEach(function (p) { var v = keyFn(p); if (v != null) scored.push([v, p]); });
    scored.sort(function (a, b) { return ascending ? a[0] - b[0] : b[0] - a[0]; });
    var m = new Map();
    scored.forEach(function (x, i) { m.set(x[1], i + 1); });
    return m;
  }
  function faRankToFcValueCurve(board, fcRank) {
    var pairs = [];
    board.forEach(function (p) { var r = fcRank.get(p), v = p.fc && p.fc.rsf; if (r && v) pairs.push([r, Number(v)]); });
    pairs.sort(function (a, b) { return a[0] - b[0]; });
    return pairs;
  }
  function faValueAtRank(r, curve) {
    if (!curve || !curve.length) return null;
    if (r <= curve[0][0]) return curve[0][1];
    if (r >= curve[curve.length - 1][0]) return curve[curve.length - 1][1];
    for (var i = 1; i < curve.length; i++) {
      if (curve[i][0] >= r) {
        var r0 = curve[i - 1][0], v0 = curve[i - 1][1], r1 = curve[i][0], v1 = curve[i][1];
        var f = r1 !== r0 ? (r - r0) / (r1 - r0) : 0;
        return v0 + (v1 - v0) * f;
      }
    }
    return curve[curve.length - 1][1];
  }
  function faBuildRankConsensus(board) {
    var fcRank = faRankMap(board, function (p) { return p.fc && p.fc.rsf > 0 ? p.fc.rsf : null; }, false);
    var ktcRank = faRankMap(board, function (p) { return p.ktc && p.ktc.rsf > 0 ? p.ktc.rsf : null; }, false);
    var ffcRank = faRankMap(board, function (p) { return p.ffcAdp; }, true);
    return { fcRank: fcRank, ktcRank: ktcRank, ffcRank: ffcRank, curve: faRankToFcValueCurve(board, fcRank) };
  }
  function faOffVal(r, rc) {   // offense redraft consensus value (higher = better)
    if (!rc) return null;
    var ranks = [];
    if (rc.fcRank.has(r)) ranks.push(rc.fcRank.get(r));
    if (rc.ktcRank.has(r)) ranks.push(rc.ktcRank.get(r));
    if (rc.ffcRank.has(r)) ranks.push(rc.ffcRank.get(r));
    if (!ranks.length) return null;
    var avg = ranks.reduce(function (a, b) { return a + b; }, 0) / ranks.length;
    return faValueAtRank(avg, rc.curve);
  }
  function faIdpVal(r) {   // IDP value off FantasyPros ECR (higher = better)
    if (r.idpVal != null && r.idpVal > 0) return r.idpVal;
    if (r.fpEcr != null && r.fpEcr > 0) return Math.max(0, 10000 - r.fpEcr * 45);
    return null;
  }
  // Positional rank within a universe by a metric. higherBetter=false ⇒ lower value ranks first (ADP/ECR/search_rank).
  function faPosRanks(univ, metric, higherBetter) {
    var byPos = {};
    univ.forEach(function (r) {
      var v = metric(r);
      if (v == null || !(v > 0)) return;
      var pos = String(r.pos || "").toUpperCase();
      (byPos[pos] = byPos[pos] || []).push({ pid: _PID(r), v: v });
    });
    var out = {};
    Object.keys(byPos).forEach(function (pos) {
      byPos[pos].sort(function (a, b) { return higherBetter ? (b.v - a.v) : (a.v - b.v); });
      byPos[pos].forEach(function (x, i) { if (x.pid) out[x.pid] = i + 1; });
    });
    return out;
  }
  // Overall rank within a universe by a value (higher = better).
  function faOvrRanks(univ, valFn) {
    var out = {};
    univ.slice().filter(function (r) { return valFn(r) != null; })
      .sort(function (a, b) { return valFn(b) - valFn(a); })
      .forEach(function (r, i) { var pid = _PID(r); if (pid) out[pid] = i + 1; });
    return out;
  }
  function buildFaAdpMap(board) {
    var m = {};
    if (!Array.isArray(board)) return m;
    var offense = board.filter(function (r) { return !r.isIdp; });
    var idp = board.filter(function (r) { return !!r.isIdp; });

    // OFFENSE — redraft consensus drives the rank; per-source positional ranks for the tooltip.
    var rankConsensus = faBuildRankConsensus(offense);
    var offValFn = function (r) { return faOffVal(r, rankConsensus); };
    var offConsPos = faPosRanks(offense, offValFn, true);
    var offOvr = faOvrRanks(offense, offValFn);
    var fcPos = faPosRanks(offense, function (r) { return r.fc && r.fc.rsf; }, true);
    var ktcPos = faPosRanks(offense, function (r) { return r.ktc && r.ktc.rsf; }, true);
    var ffcPos = faPosRanks(offense, function (r) { return r.ffcAdp; }, false);  // lower ADP = earlier
    var slpPos = faPosRanks(offense, function (r) { return r.slp; }, false);     // lower search_rank = better
    offense.forEach(function (r) {
      var pid = _PID(r); if (!pid) return;
      var pos = String(r.pos || "").toUpperCase();
      var srcs = [];
      if (fcPos[pid]) srcs.push("FantasyCalc " + pos + fcPos[pid]);
      if (ktcPos[pid]) srcs.push("KeepTradeCut " + pos + ktcPos[pid]);
      if (ffcPos[pid]) srcs.push("FFC redraft ADP " + pos + ffcPos[pid]);
      if (slpPos[pid]) srcs.push("Sleeper " + pos + slpPos[pid]);
      m[pid] = {
        isIdp: false, pos: pos,
        posRank: offConsPos[pid] || null,
        ovr: offOvr[pid] || null,
        val: offValFn(r),
        srcs: srcs, srcCount: srcs.length,
      };
    });

    // IDP — FantasyPros dynasty ECR only; ranked in its own universe.
    var idpPos = faPosRanks(idp, faIdpVal, true);
    var idpOvr = faOvrRanks(idp, faIdpVal);
    idp.forEach(function (r) {
      var pid = _PID(r); if (!pid) return;
      var pos = String(r.pos || "").toUpperCase();
      m[pid] = {
        isIdp: true, pos: pos,
        posRank: idpPos[pid] || null,
        ovr: idpOvr[pid] || null,
        ecr: (r.fpEcr != null ? r.fpEcr : null),
        val: faIdpVal(r),
        srcs: (r.fpEcr != null ? ["FantasyPros dynasty IDP ECR #" + r.fpEcr] : []),
        srcCount: (r.fpEcr != null ? 1 : 0),
      };
    });
    return m;
  }
  function renderFaPool(rows) {
    const tbody = $("#fa-pool-tbody");
    const summary = $("#fa-pool-summary");
    const adpMap = STATE.faAdp || {};
    rows = (rows || []).slice();
    // Drop players who are ALREADY an open lot — you can't nominate an active
    // auction, so showing them here with a "Nominate" button is misleading. They
    // live on the Lots tab (bid there). Recomputed each render so a player
    // reappears if their lot closes without a winner. Keyed by player_id (string).
    const openLotIds = new Set(
      ((STATE.lots && STATE.lots.lots) || [])
        .filter((l) => l.status === "open")
        .map((l) => String(l.player_id))
    );
    if (openLotIds.size) rows = rows.filter((r) => !openLotIds.has(String(r.player_id || r.id)));
    // (re)populate the NFL-team dropdown from the pool, preserving the current selection
    const teamSel = $("#fapool-team");
    if (teamSel) {
      const teams = Array.from(new Set(rows.map((r) => String(r.team || r.nfl_team || "").toUpperCase()).filter(Boolean))).sort();
      const cur = STATE.fapool_filters.team;
      teamSel.innerHTML = '<option value="">All</option>' + teams.map((t) => `<option value="${t}"${t === cur ? " selected" : ""}>${escapeHtml(t)}</option>`).join("");
    }
    // FILTER — position bucket / NFL team / name-or-id search
    const f = STATE.fapool_filters, q = (f.q || "").trim().toLowerCase();
    const filtered = rows.filter((r) => {
      if (f.pos !== "ALL" && posBucket(r.position) !== f.pos) return false;
      if (f.team && String(r.team || r.nfl_team || "").toUpperCase() !== f.team) return false;
      if (q) {
        const nm = String(r.name || r.player_name || "").toLowerCase();
        if (nm.indexOf(q) < 0 && String(r.player_id).indexOf(q) < 0) return false;
      }
      return true;
    });
    // SORT: startable OFFENSE first (by its redraft-consensus overall rank), then IDP (by its own
    // FantasyPros-ECR overall rank), then anyone not on the board (raw pool ADP). Each universe is
    // ranked independently so an IDP role player never out-ranks a startable QB, but IDP is still
    // properly ordered within its block. Tiebreak on prior-season PPG.
    filtered.sort((a, b) => {
      const A = adpMap[String(a.player_id)], B = adpMap[String(b.player_id)];
      const at = A ? (A.isIdp ? 1 : 0) : 2, bt = B ? (B.isIdp ? 1 : 0) : 2;
      if (at !== bt) return at - bt;
      const ar = A ? (A.ovr || 1e9) : (a.adp == null ? 1e9 : a.adp);
      const br = B ? (B.ovr || 1e9) : (b.adp == null ? 1e9 : b.adp);
      return ar - br || (Number(b.ppg) || 0) - (Number(a.ppg) || 0);
    });
    if (summary) summary.textContent = filtered.length + (filtered.length === 1 ? " player" : " players") + (filtered.length !== rows.length ? " of " + rows.length : "") + " · by ADP";
    if (!tbody) return;
    if (!filtered.length) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px;">${rows.length ? "No players match your filters." : "FA pool unavailable right now."}</td></tr>`;
      return;
    }
    const faaLive = !!(STATE.lots && STATE.lots.faa_enabled);
    // Desktop nomination is a deep-link to MFL's O=43 page — there's no worker
    // call in this path, so disabling the link IS the app-side gate here. It's
    // a guardrail against an honest mistake, not a wall: MFL itself has no
    // nomination-limit setting, so the page remains reachable directly.
    const myNomsToday = myFaaNomsToday();
    const nomCapped = faaLive && myNomsToday >= 2;
    const CAP = 400;
    tbody.innerHTML = filtered.slice(0, CAP).map((r) => {
      const name = r.name || r.player_name;
      const a = adpMap[String(r.player_id)];
      // ADP cell LEADS with the positional rank (QB4 / WR12 / DE7) per Keith's ask; overall rank
      // (offense) or FantasyPros ECR (IDP) is the muted second; a "N src" chip carries the per-source
      // positional ranks in its tooltip so you can see where the consensus comes from.
      let adpTxt;
      if (a && a.posRank) {
        const posLabel = escapeHtml(a.pos) + a.posRank;
        const second = a.isIdp ? (a.ecr != null ? "ECR " + a.ecr : "") : (a.ovr ? "#" + a.ovr : "");
        const tip = (a.srcs && a.srcs.length) ? a.srcs.join(" · ") : "";
        adpTxt = '<b style="color:var(--accent)">' + posLabel + "</b>"
          + (second ? ' <span class="small" style="color:var(--muted)">' + second + "</span>" : "")
          + (a.srcCount ? ' <span class="small" title="' + escapeHtml(tip) + '" style="color:var(--muted);cursor:help;border-bottom:1px dotted var(--muted)">' + a.srcCount + " src</span>" : "");
      } else {
        adpTxt = r.adp ? "ADP " + r.adp : "—";
      }
      // worker shape: NEW returns gp + per-game ppg + total pts → "<ppg> PPG · <total> pts". OLD returns only
      // `ppg` that is really the season TOTAL (no gp) → label it "pts", never "PPG" (the bug Keith flagged).
      const ppg = Number(r.ppg) || 0, pts = Number(r.pts) || 0, hasGp = (r.gp != null);
      const seasonTxt = hasGp
        ? (ppg ? ("<b>" + ppg + "</b> PPG" + (pts ? ' <span class="small" style="color:var(--muted)">· ' + Math.round(pts) + " pts</span>" : "")) : "—")
        : (ppg ? ("<b>" + Math.round(ppg) + "</b> pts") : "—");
      const action = !faaLive
        ? `<span class="small" style="color:var(--muted)">—</span>`
        : nomCapped
          ? `<button type="button" class="btn small secondary" disabled title="${escapeHtml(myNomsToday + " of 2 nominations used today (resets midnight ET) — a 3rd is a rules violation.")}">Nominate</button>`
          : `<a href="${mflBidUrl(r.player_id)}" target="_blank" rel="noopener" class="btn small">Nominate ↗</a>`;
      return `<tr>
        <td>${playerNameCell(r.player_id, name)}</td>
        <td>${escapeHtml(String(r.position || "").toUpperCase() || "—")}</td>
        <td class="col-md">${escapeHtml(r.team || r.nfl_team || "—")}</td>
        <td>${adpTxt}</td>
        <td>${seasonTxt}</td>
        <td>${action}</td>
      </tr>`;
    }).join("") + (filtered.length > CAP ? `<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:14px;">Showing top ${CAP} of ${filtered.length} — narrow with the filters above.</td></tr>` : "");
  }
  function setupFaPoolFilters() {
    // reflect persisted filter state on the freshly-mounted controls
    $$("#fapool-pos-chips .ah-pos-chip").forEach((c) => c.classList.toggle("active", (c.dataset.pos || "ALL") === STATE.fapool_filters.pos));
    const sq0 = $("#fapool-search"); if (sq0 && STATE.fapool_filters.q) sq0.value = STATE.fapool_filters.q;
    $$("#fapool-pos-chips .ah-pos-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        STATE.fapool_filters.pos = chip.dataset.pos || "ALL";
        $$("#fapool-pos-chips .ah-pos-chip").forEach((c) => c.classList.toggle("active", c === chip));
        renderFaPool(STATE.faPool || []);
      });
    });
    const ts = $("#fapool-team");
    if (ts) ts.addEventListener("change", (e) => { STATE.fapool_filters.team = e.target.value; renderFaPool(STATE.faPool || []); });
    const sq = $("#fapool-search");
    if (sq) sq.addEventListener("input", (e) => { STATE.fapool_filters.q = e.target.value; clearTimeout(STATE._faqT); STATE._faqT = setTimeout(() => renderFaPool(STATE.faPool || []), 160); });
  }

  // ════════════════════════════════════════════════════════════════════
  // BID HISTORY
  // ════════════════════════════════════════════════════════════════════
  async function loadBidHistory() {
    const season = new Date().getUTCFullYear();
    const qs = "?L=" + LEAGUE_ID + "&YEAR=" + season + "&limit=500";
    const metaEl = $("#history-meta");
    const feed = $("#history-feed");
    const filterEl = $("#history-filters");
    if (metaEl) metaEl.textContent = "Loading…";
    try {
      const data = await fetchJSON(apiUrl("/api/auction/bid-history") + qs);
      STATE.bidHistory = data;
      // Populate franchise filter dropdown
      const franchiseSelect = $("#history-franchise-filter");
      if (franchiseSelect) {
        const seen = new Set();
        const opts = [];
        for (const b of (data.bids || [])) {
          if (!b.fid || seen.has(b.fid)) continue;
          seen.add(b.fid);
          opts.push({ fid: b.fid, name: b.franchise_name });
        }
        opts.sort((a, b) => a.name.localeCompare(b.name));
        franchiseSelect.innerHTML = `<option value="">All franchises</option>` +
          opts.map((o) => `<option value="${escapeHtml(o.fid)}">${escapeHtml(o.name)}</option>`).join("");
      }
      if (filterEl) filterEl.style.display = "";
      renderBidHistory();
      if (metaEl) {
        metaEl.textContent = "Showing most recent " + (data.bids || []).length + " bids.";
      }
    } catch (e) {
      console.error("[auction-hub] bid history load failed:", e);
      if (feed) {
        feed.innerHTML = `<div class="ah-placeholder" style="color:var(--err);">
          Failed to load bid history: ${escapeHtml(String(e && e.message || e))}</div>`;
      }
      if (metaEl) metaEl.textContent = "Failed to load.";
    }
  }

  function setupHistoryFilters() {
    const rerender = () => renderBidHistory();
    ["history-player-filter", "history-franchise-filter", "history-kind-filter"].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("input", rerender);
      el.addEventListener("change", rerender);
    });
  }

  function renderBidHistory() {
    const feed = $("#history-feed");
    const countEl = $("#history-count");
    if (!feed) return;
    const data = STATE.bidHistory || {};
    let bids = Array.isArray(data.bids) ? data.bids.slice() : [];

    // Per-auction split (bids aren't kind-tagged): a bid belongs to the ERA
    // iff its player is in the ERA-eligible pool, else it's an FA-auction bid.
    const eraIds = eraPoolIds();
    bids = bids.filter((b) => eraIds.has(String(b.player_id)) === (STATE.tab === "era"));

    const pFilter = ($("#history-player-filter")?.value || "").trim().toLowerCase();
    const fFilter = ($("#history-franchise-filter")?.value || "").trim();
    const kFilter = ($("#history-kind-filter")?.value || "").trim();
    if (pFilter) {
      bids = bids.filter((b) =>
        (b.player_name || "").toLowerCase().includes(pFilter) ||
        String(b.player_id || "").includes(pFilter)
      );
    }
    if (fFilter) bids = bids.filter((b) => b.fid === fFilter);
    // Observer-side kind filter (nomination / overtake / forced_increase).
    // Computed by walking the per-lot thread chronologically: a bid is a
    // forced_increase when same fid as the immediately-prior bid in its
    // lot, otherwise overtake. is_nomination wins regardless.
    if (kFilter) {
      const lotPrevByLot = new Map();
      // First pass: sort chronologically then walk
      const chrono = bids.slice().sort((a, b) => (a.bid_at_unix || 0) - (b.bid_at_unix || 0));
      const obsKindById = new Map();
      for (const b of chrono) {
        const lot = b.lot_id || String(b.player_id);
        const prevFid = lotPrevByLot.get(lot);
        let cls;
        if (b.is_nomination) cls = "nomination";
        else if (prevFid == null) cls = "overtake";
        else cls = b.fid === prevFid ? "forced_increase" : "overtake";
        obsKindById.set(b.bid_id, cls);
        lotPrevByLot.set(lot, b.fid);
      }
      bids = bids.filter((b) => obsKindById.get(b.bid_id) === kFilter);
    }

    if (bids.length === 0) {
      if (countEl) countEl.textContent = "0 events";
      feed.innerHTML = `<div class="ah-placeholder">No bids match the current filters.</div>`;
      return;
    }

    // Thread view — group by lot_id (= same player lot). Newest activity
    // surfaces the thread; click to expand the full bid sequence inside.
    const threadsByLot = new Map();
    for (const b of bids) {
      const key = b.lot_id || String(b.player_id);
      if (!threadsByLot.has(key)) threadsByLot.set(key, []);
      threadsByLot.get(key).push(b);
    }
    // Each thread sorted chronologically inside; threads themselves sorted by
    // latest-event timestamp desc (most recently active lot first).
    const threads = [...threadsByLot.values()].map((arr) => {
      arr.sort((a, b) => (a.bid_at_unix || 0) - (b.bid_at_unix || 0));
      return arr;
    });
    threads.sort((a, b) => {
      const aLatest = a[a.length - 1]?.bid_at_unix || 0;
      const bLatest = b[b.length - 1]?.bid_at_unix || 0;
      return bLatest - aLatest;
    });

    if (countEl) {
      const evCount = bids.length;
      const lotCount = threads.length;
      countEl.textContent = evCount + " event" + (evCount === 1 ? "" : "s") +
        " across " + lotCount + " lot" + (lotCount === 1 ? "" : "s");
    }

    feed.innerHTML = threads.map((thread) => {
      // Reclassify each bid in observer terms (Nom / Forced Increase / Overtake)
      // based on its position in the chronological thread:
      //   - is_nomination       → "nom"
      //   - same fid as prior   → "forced_increase" (MFL walked their proxy)
      //   - different fid       → "overtake" (new franchise dethroned the leader)
      const classified = thread.map((b, i) => {
        let cls;
        if (b.is_nomination) cls = "nom";
        else if (i === 0)    cls = "overtake";  // first non-nom bid in thread
        else                 cls = (b.fid === thread[i - 1].fid) ? "forced_increase" : "overtake";
        return { ...b, _obs_kind: cls };
      });
      const latest = classified[classified.length - 1];
      const expandable = classified.length > 1;
      const forcedCount = classified.filter((b) => b._obs_kind === "forced_increase").length;
      const overtakeCount = classified.filter((b) => b._obs_kind === "overtake").length;

      const obsIcon = (k) => k === "nom" ? "🆕" : k === "forced_increase" ? "⬆" : "💰";
      const obsLabel = (k) => k === "nom" ? "NOM" : k === "forced_increase" ? "FORCED INCREASE" : "OVERTAKE";
      const obsLabelShort = (k) => k === "nom" ? "Nominated" : k === "forced_increase" ? "Forced increase" : "Overtake";

      const summaryIcon = obsIcon(latest._obs_kind);
      const summaryKindLabel = obsLabel(latest._obs_kind);

      const expandedRows = classified.map((b, i) => {
        const isLast = i === classified.length - 1;
        return `
          <div class="ah-thread-step ah-thread-step-${b._obs_kind} ${isLast ? "ah-thread-step-latest" : ""}">
            <div class="ah-thread-icon">${obsIcon(b._obs_kind)}</div>
            <div class="ah-thread-step-body">
              <div class="ah-thread-step-head">
                <span class="ah-thread-step-action">${escapeHtml(obsLabelShort(b._obs_kind))}</span>
                <strong class="ah-thread-step-team">${escapeHtml(b.franchise_name || "")}</strong>
                <span class="ah-thread-step-amount">$${b.bid_k}K</span>
                <span class="ah-thread-step-when" title="${escapeHtml(formatBidWhen(b.bid_at_unix))}">${escapeHtml(formatBidWhenET(b.bid_at_unix))}</span>
              </div>
              ${b.note ? `<div class="ah-thread-step-note">${escapeHtml(b.note)}</div>` : ""}
            </div>
          </div>`;
      }).join("");

      const metaBreakdownParts = [];
      if (expandable) metaBreakdownParts.push(`${classified.length} bids`);
      if (forcedCount > 0)   metaBreakdownParts.push(`${forcedCount} forced`);
      if (overtakeCount > 1) metaBreakdownParts.push(`${overtakeCount} overtake${overtakeCount === 1 ? "" : "s"}`);
      const metaBreakdown = metaBreakdownParts.length > 0 ? `<span class="ah-thread-count">· ${metaBreakdownParts.join(" · ")}</span>` : "";

      return `
        <details class="ah-bid-thread ah-bid-${latest._obs_kind}" ${expandable ? "" : "open"}>
          <summary class="ah-bid-thread-summary">
            <span class="ah-bid-icon">${summaryIcon}</span>
            <div class="ah-bid-body">
              <div class="ah-bid-head">
                <strong>${escapeHtml(latest.franchise_name || "")}</strong>
                <span class="ah-bid-kind">${summaryKindLabel}</span>
                <span class="ah-bid-amount">$${latest.bid_k}K</span>
              </div>
              <div class="ah-bid-meta">
                <span class="ah-bid-player">${escapeHtml(latest.player_name || "")}</span>
                ${latest.position ? ` · ${escapeHtml(latest.position)}` : ""}
                ${latest.nfl_team ? ` · ${escapeHtml(latest.nfl_team)}` : ""}
                ${metaBreakdown}
                <span class="ah-bid-when">${formatBidWhen(latest.bid_at_unix)}</span>
              </div>
            </div>
            ${expandable ? `<span class="ah-thread-toggle" aria-hidden="true">▾</span>` : ""}
          </summary>
          ${expandable ? `<div class="ah-thread-steps">${expandedRows}</div>` : ""}
        </details>`;
    }).join("");
  }

  function formatBidWhen(unix) {
    if (!unix) return "";
    const ms = Number(unix) * 1000;
    const diffSec = Math.max(0, (Date.now() - ms) / 1000);
    if (diffSec < 60) return Math.floor(diffSec) + "s ago";
    if (diffSec < 3600) return Math.floor(diffSec / 60) + "m ago";
    if (diffSec < 86400) return Math.floor(diffSec / 3600) + "h ago";
    return new Date(ms).toLocaleDateString();
  }

  // Absolute Eastern-time timestamp to the second. Used on thread-step
  // rows (the expanded bid sequence) so auctioneers can pin down exact
  // moments without doing relative-time math. Format: "May 20, 2:35:17 PM ET"
  function formatBidWhenET(unix) {
    if (!unix) return "";
    const ms = Number(unix) * 1000;
    try {
      const datePart = new Date(ms).toLocaleString("en-US", {
        timeZone: "America/New_York",
        month: "short", day: "numeric",
      });
      const timePart = new Date(ms).toLocaleString("en-US", {
        timeZone: "America/New_York",
        hour: "numeric", minute: "2-digit", second: "2-digit",
        hour12: true,
      });
      return `${datePart}, ${timePart} ET`;
    } catch (e) {
      // Fallback if Intl/timeZone unsupported — just dump ISO.
      return new Date(ms).toISOString();
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // FILTERS + SORTING
  // ════════════════════════════════════════════════════════════════════
  function setupFilters() {
    // Position chips
    $$("#era-pos-chips .ah-pos-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const pos = chip.dataset.pos || "ALL";
        STATE.era_filters.pos = pos;
        $$("#era-pos-chips .ah-pos-chip").forEach((c) => c.classList.toggle("active", c === chip));
        renderEraTable();
      });
    });

    $("#era-filter-owner").addEventListener("change", (e) => {
      STATE.era_filters.owner = e.target.value;
      renderEraTable();
    });
  }

  function setupSorting() {
    $$("#era-table thead th[data-sort]").forEach((th) => {
      th.addEventListener("click", () => {
        const col = th.dataset.sort;
        if (STATE.era_sort === col) {
          STATE.era_sort_dir *= -1;
        } else {
          STATE.era_sort = col;
          // Numeric columns default desc, text columns default asc
          const numeric = ["ppg_2023", "ppg_2024", "ppg_2025", "ppg_weighted", "high_bid_k", "total_bids", "age", "y3_salary", "current_bid", "rookie_slot", "time_remaining"];
          STATE.era_sort_dir = numeric.includes(col) ? -1 : 1;
        }
        renderEraTable();
      });
    });
  }

  // ════════════════════════════════════════════════════════════════════
  // RENDER — context banner meta + owner dropdown population
  // ════════════════════════════════════════════════════════════════════
  function renderEraMeta() {
    const meta = $("#era-context-meta");
    const headerMeta = $("#ah-meta");
    if (!STATE.era) return;
    const total = (STATE.era.players || []).length;
    const deadline = STATE.era.extension_deadline_iso || STATE.era.deadline_iso;
    let deadlineTxt;
    if (deadline) {
      const passed = new Date(deadline).getTime() < Date.now();
      deadlineTxt = `${fmtDate(deadline)}${passed ? " (passed — pool locked)" : ""}`;
    } else {
      deadlineTxt = "TBD";
    }
    if (meta) meta.textContent = `Rookie extension deadline: ${deadlineTxt} · ${total} players in ERA pool.`;
    if (headerMeta) {
      const me = STATE.me || {};
      const youAre = me.configured && me.franchise_name
        ? `You: ${me.franchise_name}`
        : me.configured && me.franchise_id
          ? `You: franchise ${me.franchise_id}`
          : "Viewer (not logged in)";
      headerMeta.textContent = `${youAre} · Season ${STATE.era.season || new Date().getUTCFullYear()} · Generated ${STATE.era.generated_at ? new Date(STATE.era.generated_at).toLocaleString() : "—"}`;
    }

    // Populate prior-owner dropdown
    const ownerSet = new Map(); // fid → name
    for (const p of (STATE.era.players || [])) {
      if (p.prior_owner_fid) ownerSet.set(p.prior_owner_fid, p.prior_owner || p.prior_owner_fid);
    }
    const sel = $("#era-filter-owner");
    if (sel) {
      const cur = sel.value;
      const opts = ['<option value="">All</option>'];
      const sorted = Array.from(ownerSet.entries()).sort((a, b) => String(a[1]).localeCompare(String(b[1])));
      for (const [fid, name] of sorted) {
        opts.push(`<option value="${escapeHtml(fid)}">${escapeHtml(name)}</option>`);
      }
      sel.innerHTML = opts.join("");
      if (cur) sel.value = cur;
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // RENDER — ERA table
  // ════════════════════════════════════════════════════════════════════
  function applyFilters(players) {
    const f = STATE.era_filters;
    return (players || []).filter((p) => {
      if (f.pos !== "ALL") {
        if (posBucket(p.position) !== f.pos) return false;
      }
      if (f.owner && String(p.prior_owner_fid || "") !== f.owner) return false;
      return true;
    });
  }

  function applySort(rows) {
    const col = STATE.era_sort;
    const dir = STATE.era_sort_dir;
    // Numeric whitelist must match both sort-handler + click-handler.
    // Bug fix (Keith 2026-05-22): ppg_weighted was falling through to
    // the string sort branch and producing lexicographic ordering
    // ("10.6" > "11" > "2.1" — Charbonnet should be on top with 10.6).
    const numeric = [
      "ppg_2023", "ppg_2024", "ppg_2025", "ppg_weighted",
      "high_bid_k", "total_bids",
      "age", "y3_salary", "current_bid", "rookie_slot",
      "time_remaining",
    ];
    // Status priority (lot_status sort key). Open auctions surface first
    // on asc; won auctions last. "not_yet_open" => never nominated.
    const STATUS_RANK = { open: 0, locked: 1, not_yet_open: 2, won: 3 };
    const nowUnix = Math.floor(Date.now() / 1000);
    const getVal = (row, key) => {
      if (key === "time_remaining") {
        // Compute remaining lock seconds. Rows with no lot or already
        // won → NaN so they sink to the bottom via the +/-Infinity
        // fallback below.
        const locks = Number(row.lot_locks_at_unix || 0);
        if (!locks || row.lot_status === "won") return NaN;
        return Math.max(0, locks - nowUnix);
      }
      if (key === "lot_status") {
        const s = String(row.lot_status || "not_yet_open");
        return STATUS_RANK[s] != null ? STATUS_RANK[s] : 99;
      }
      return row[key];
    };
    return rows.slice().sort((a, b) => {
      let va = getVal(a, col), vb = getVal(b, col);
      if (numeric.includes(col) || col === "lot_status") {
        va = Number(va);
        vb = Number(vb);
        // For descending sort (dir = -1), null/missing should sink to
        // the bottom. -Infinity makes them sort LOW, which means they
        // end up at the top of a descending order — wrong. Use
        // +/-Infinity based on dir so nulls always go last.
        if (!Number.isFinite(va)) va = dir < 0 ? -Infinity : Infinity;
        if (!Number.isFinite(vb)) vb = dir < 0 ? -Infinity : Infinity;
        return (va - vb) * dir;
      }
      va = String(va || "").toLowerCase();
      vb = String(vb || "").toLowerCase();
      return va < vb ? -dir : va > vb ? dir : 0;
    });
  }

  function renderEraTable() {
    const tbody = $("#era-tbody");
    if (!tbody) return;
    const all = STATE.era && STATE.era.players ? STATE.era.players : [];
    const filtered = applyFilters(all);
    const sorted = applySort(filtered);

    $("#era-filters-summary").textContent = `${filtered.length} of ${all.length} eligible`;
    $("#era-table-summary").textContent = filtered.length === 0
      ? "No players match the filters."
      : `Showing ${filtered.length} player${filtered.length === 1 ? "" : "s"}.`;

    // Sort arrows on headers
    $$("#era-table thead th[data-sort]").forEach((th) => {
      const arrow = th.dataset.sort === STATE.era_sort ? (STATE.era_sort_dir > 0 ? " ▲" : " ▼") : "";
      const base = th.textContent.replace(/[ ▲▼]+$/, "");
      th.textContent = base + arrow;
    });

    if (sorted.length === 0) {
      tbody.innerHTML = `<tr><td colspan="13" style="text-align:center;color:var(--muted);padding:24px;">
        No players match the current filters.
      </td></tr>`;
      return;
    }

    const myFid = STATE.me && STATE.me.franchise_id ? STATE.me.franchise_id : null;
    const rows = sorted.map((p) => renderRow(p, myFid)).join("");
    tbody.innerHTML = rows;
  }

  function renderRow(p, myFid) {
    const pos = String(p.position || "").toUpperCase();

    // Player cell — opens the unified UPS player profile modal (same one
    // used by Roster Workbench, Rookie Draft Hub, etc.). Falls back to the
    // MFL profile page if the shared module hasn't loaded.
    const playerName = escapeHtml(p.name || ("Player #" + p.player_id));
    const playerCell = p.player_id
      ? `<button type="button" class="ah-player-open player-link" data-action="open-player-modal" data-player-id="${escapeHtml(p.player_id)}">${playerName}</button>`
      : playerName;

    const currentBid = Number(p.current_bid || 0);
    const yourProxy = Number(p.your_proxy_bid || 0);
    const currentBidCell = currentBid > 0
      ? `<span class="num">${fmtK(currentBid)}</span><div class="small">by ${escapeHtml(p.current_high_bidder || "—")}</div>`
      : `<span class="small">no bids yet</span>`;

    // Proxy bid is private — only render the row when the viewer is
    // signed in (any franchise). Worker already scopes `your_proxy_bid`
    // to the requesting franchise, so this is belt-and-suspenders.
    const viewerIsOwner = !!(STATE.me && STATE.me.configured && STATE.me.franchise_id);
    const proxyRow = viewerIsOwner
      ? `<div class="pop-row"><span class="lbl">Your proxy</span><span class="val">${yourProxy > 0 ? fmtK(yourProxy) : "—"}</span></div>`
      : "";

    // Cap deltas (offseason — no $300K ceiling per §6.A1; informational only)
    const cap1 = renderCapDelta(1);
    const cap5 = renderCapDelta(5);
    const cap10 = renderCapDelta(10);

    const popover = `
      <div class="ah-popover">
        <div class="pop-head">Bid State</div>
        <div class="pop-row"><span class="lbl">Current high bid</span><span class="val">${currentBid > 0 ? fmtK(currentBid) : "—"}</span></div>
        <div class="pop-row"><span class="lbl">High bidder</span><span class="val">${escapeHtml(p.current_high_bidder || "—")}</span></div>
        ${proxyRow}
        <div class="pop-divider"></div>
        <div class="pop-head">Your cap impact (offseason — no ceiling)</div>
        <div class="pop-row"><span class="lbl">If you win @ $1K</span><span class="val">${cap1}</span></div>
        <div class="pop-row"><span class="lbl">If you win @ $5K</span><span class="val">${cap5}</span></div>
        <div class="pop-row"><span class="lbl">If you win @ $10K</span><span class="val">${cap10}</span></div>
      </div>`;

    // Nomination eligibility — when next allowed (server-side enforcement
    // canonical; client just hints if the rule is reachable).
    // Nominate button — UPS-side nominate endpoint is parked in
    // CROSS_CODEBASE_ALIGNMENT §4.1. Until built, deep-link to MFL's
    // native auction nomination page (O=43) with the player + viewer's
    // franchise prefilled. Opens in a new tab so the hub view stays.
    //
    // URL shape (confirmed against Keith's 2026-05-20 sample):
    //   /<year>/options?LEAGUE_ID=<L>&FRANCHISE=<fid>&O=43
    //     &PLAYER_ID=<pid>
    // (Removed &SELECT=Select+Franchise per Keith 2026-05-25 —
    // it was triggering MFL's franchise-picker interstitial instead
    // of going straight to the bid form. With just FRANCHISE +
    // PLAYER_ID, MFL renders the bid form preselected to that player.)
    const nominateEligible = !p.nominate_blocked;
    const viewerFidForMfl = (STATE.me && STATE.me.franchise_id) || "0000";
    const mflAuctionUrl =
      `https://www48.myfantasyleague.com/${p.season || new Date().getUTCFullYear()}` +
      `/options?LEAGUE_ID=${LEAGUE_ID}&FRANCHISE=${encodeURIComponent(viewerFidForMfl)}&O=43` +
      `&PLAYER_ID=${encodeURIComponent(p.player_id)}`;
    // CTA logic — cross-reference STATE.lots to surface the right action:
    //   - lot.status === "won"            → "Won by <team>" (disabled)
    //   - lot exists but locks_at passed  → "Closed" (disabled; pending
    //                                       resolution into a won row)
    //   - lot exists and still open       → "Bid ↗"
    //   - no lot but high_bid_k>0 (data-
    //     layer-only signal of activity)  → "Bid ↗" (fallback)
    //   - nothing                         → "Nominate ↗"
    // (Keith 2026-05-25 / 2026-05-27.)
    const eraLive = !!(STATE.lots && STATE.lots.era_enabled);
    const lotsArr = (STATE.lots && Array.isArray(STATE.lots.lots)) ? STATE.lots.lots : [];
    const lotForPlayer = lotsArr.find((l) => String(l.player_id) === String(p.player_id));
    const nowUnix = Math.floor(Date.now() / 1000);
    const lotIsWon = !!lotForPlayer && lotForPlayer.status === "won";
    const lotIsLocked = !!lotForPlayer && !lotIsWon && Number(lotForPlayer.locks_at_unix || 0) > 0 && Number(lotForPlayer.locks_at_unix) <= nowUnix;
    const lotIsOpen = !!lotForPlayer && !lotIsWon && !lotIsLocked;
    const alreadyNominated = lotIsOpen || lotIsWon || lotIsLocked || (Number(p.high_bid_k) > 0) || (Number(p.total_bids) > 0);

    let nominateBtn;
    if (lotIsWon) {
      const winner = lotForPlayer.winner_name
        || (typeof franchiseName === "function" ? franchiseName(lotForPlayer.winner_fid) : "")
        || p.high_bid_team
        || "—";
      nominateBtn = `<button type="button" class="btn small secondary" disabled title="${escapeHtml("Auction closed — won by " + winner)}" data-mode="won">Won · ${escapeHtml(winner)}</button>`;
    } else if (lotIsLocked) {
      nominateBtn = `<button type="button" class="btn small secondary" disabled title="Lock window expired — pending resolution into a won row." data-mode="closed">Closed</button>`;
    } else if (!nominateEligible) {
      nominateBtn = `<button type="button" class="btn small secondary" disabled title="${escapeHtml(p.nominate_block_reason || "Nomination blocked")}">Blocked</button>`;
    } else if (!alreadyNominated && !eraLive) {
      // Auction isn't running — browse-only, no Nominate (Keith 2026-06-20).
      nominateBtn = `<span class="small" style="color:var(--muted)">—</span>`;
    } else {
      const ctaLabel = alreadyNominated ? "Bid ↗" : "Nominate ↗";
      const ctaTitle = alreadyNominated
        ? "Already nominated — opens MFL's auction page to raise the bid."
        : "Opens MFL's native auction page in a new tab. UPS-side nominate endpoint is parked (see CROSS_CODEBASE_ALIGNMENT §4.1).";
      nominateBtn = `<a href="${mflAuctionUrl}" target="_blank" rel="noopener" class="btn small ah-nominate-btn" data-pid="${escapeHtml(p.player_id)}" data-mode="${alreadyNominated ? "bid" : "nominate"}" title="${escapeHtml(ctaTitle)}">${ctaLabel}</a>`;
    }

    const origin = p.origin_label || "Unknown";
    // Map labels → CSS class slug (no spaces/hyphens)
    const ORIGIN_CLASS = {
      "Rookie Draft": "RookieDraft",
      "MYM-Rookie": "MYMRookie",
      "WW": "WW",
      "Rookie - FA Auction": "FAAuction",
      "Trade": "Trade",
      "Unknown": "Unknown",
    };
    const originClass = ORIGIN_CLASS[origin] || "Unknown";
    const originLabel = origin === "Rookie - FA Auction" ? "FA Auction" : origin;
    const originChip = `<span class="ah-origin ${originClass}" title="Contract origin: ${escapeHtml(origin)}">${escapeHtml(originLabel)}</span>`;

    // PPG cell formatter — show "—" for null, otherwise 1 decimal with
    // a games count subscript when low (< 8 games) so users can spot
    // small-sample noise.
    const ppgCell = (ppg, games) => {
      if (ppg == null) return "—";
      const val = Number(ppg).toFixed(1);
      const sub = (games != null && games > 0 && games < 8)
        ? ` <span class="ah-ppg-games" title="${games} games">(${games}g)</span>`
        : "";
      return `${val}${sub}`;
    };

    const highBidCell = (p.high_bid_k != null && p.high_bid_k > 0)
      ? fmtDollarsFromK(p.high_bid_k)
      : "—";
    const highBidderCell = p.high_bid_team
      ? escapeHtml(p.high_bid_team)
      : "—";
    const totalBidsCell = Number(p.total_bids || 0);

    // Time Remaining cell — counts down to the lot's 36hr lock window.
    // Live (per-second tick handled by updateEraCountdowns()).
    const locksAtUnix = Number(p.lot_locks_at_unix || 0);
    const lotIsWonHere = String(p.lot_status || "") === "won";
    let timeRemainingCell;
    if (lotIsWonHere) {
      timeRemainingCell = `<span class="small" style="color:var(--muted)">—</span>`;
    } else if (locksAtUnix > 0) {
      const remaining = Math.max(0, locksAtUnix - Math.floor(Date.now() / 1000));
      timeRemainingCell = `<span class="ah-countdown" data-locks-at="${locksAtUnix}">${formatCountdown(remaining)}</span>`;
    } else {
      timeRemainingCell = `<span class="small" style="color:var(--muted)">—</span>`;
    }

    return `
      <tr data-pid="${escapeHtml(p.player_id || "")}">
        <td>${playerCell}</td>
        <td><span class="ah-pos ${pos}">${escapeHtml(pos)}</span></td>
        <td class="col-md">${escapeHtml(p.nfl_team || "—")}</td>
        <td>${originChip}</td>
        <td class="num col-lo">${ppgCell(p.ppg_2023, p.games_2023)}</td>
        <td class="num col-lo">${ppgCell(p.ppg_2024, p.games_2024)}</td>
        <td class="num col-lo">${ppgCell(p.ppg_2025, p.games_2025)}</td>
        <td class="num"><strong>${p.ppg_weighted != null ? Number(p.ppg_weighted).toFixed(1) : "—"}</strong></td>
        <td class="num col-md">${highBidCell}</td>
        <td class="col-md">${highBidderCell}</td>
        <td class="num col-lo">${totalBidsCell}</td>
        <td class="col-md">${timeRemainingCell}</td>
        <td>
          <div class="ah-nominate-wrap">
            ${nominateBtn}
            ${popover}
          </div>
        </td>
      </tr>`;
  }

  // Cap delta = winning bid (current-year salary impact). Offseason has no
  // $300K ceiling (§6.A1) so this is informational only — no warn/error
  // colors, just the delta.
  function renderCapDelta(bidK) {
    return `+${fmtK(bidK)}`;
  }

  // ════════════════════════════════════════════════════════════════════
  // NOMINATIONS — live auction feed
  // ════════════════════════════════════════════════════════════════════

  async function loadLots() {
    const fidQs = STATE.me && STATE.me.franchise_id
      ? "&franchise_id=" + encodeURIComponent(STATE.me.franchise_id)
      : "";
    const season = new Date().getUTCFullYear();
    try {
      const data = await fetchJSON(apiUrl("/api/auction/lots") +
        "?L=" + LEAGUE_ID + "&YEAR=" + season + fidQs);
      STATE.lots = data;
    } catch (e) {
      console.error("[auction-hub] /api/auction/lots fetch failed:", e);
      STATE.lots = { lots: [], error: String(e && e.message || e) };
    }
  }

  // Delegated click handler for player-name buttons in any auction-hub
  // table. Opens the unified UPS player profile modal (same one used by
  // Roster Workbench / Rookie Draft Hub) via window.UPS_openPlayerProfile.
  // Falls back to the MFL profile page if the shared module is missing.
  // Resolve a player's known metadata (name / pos / NFL team) from our
  // local STATE so the unified modal can render its header eagerly
  // instead of showing "Player #<id>" until the async MFL fetch resolves.
  // Mirrors the playerInfo shape player_profile_master.js consumes.
  function resolvePlayerInfo(pid) {
    const idStr = String(pid);
    if (STATE.era && Array.isArray(STATE.era.players)) {
      for (const p of STATE.era.players) {
        if (String(p.player_id) === idStr) {
          return {
            name: p.name || "",
            position: p.position || "",
            team: p.nfl_team || "",
          };
        }
      }
    }
    if (STATE.lots && Array.isArray(STATE.lots.lots)) {
      for (const l of STATE.lots.lots) {
        if (String(l.player_id) === idStr) {
          return {
            name: l.player_name || "",
            position: l.position || "",
            team: l.nfl_team || "",
          };
        }
      }
    }
    // FA board (live lots) + the full FA nominate pool — so FA player headers
    // resolve eagerly too, not just ERA/lots players.
    var faRows = ((STATE.fa && STATE.fa.active_auctions) || []).concat(STATE.faPool || []);
    for (const r of faRows) {
      if (String(r.player_id) === idStr) {
        return {
          name: r.name || r.player_name || "",
          position: r.position || "",
          team: r.team || r.nfl_team || "",
        };
      }
    }
    return null;
  }

  function setupPlayerModalDelegation() {
    document.addEventListener("click", (e) => {
      const btn = e.target.closest('[data-action="open-player-modal"]');
      if (!btn) return;
      const pid = btn.getAttribute("data-player-id");
      if (!pid) return;
      e.preventDefault();
      if (typeof window.UPS_openPlayerProfile === "function") {
        try {
          // Pass playerInfo so the master modal's header is correct
          // immediately (same pattern Roster Workbench / Rookie Draft Hub
          // use). Without this the header sits on "Player #<id>" until
          // the MFL bundle fetch resolves.
          const playerInfo = resolvePlayerInfo(pid);
          window.UPS_openPlayerProfile(pid, {
            apiBase: WORKER_BASE || "",
            leagueId: LEAGUE_ID,
            year: String(new Date().getUTCFullYear()),
            mode: "auction_hub",
            playerInfo: playerInfo || undefined,
          });
          return;
        } catch (err) {
          console.warn("[auction-hub] UPS_openPlayerProfile failed, falling back:", err);
        }
      }
      // Fallback — open MFL's native player profile in a new tab.
      const url = `https://www.myfantasyleague.com/${new Date().getUTCFullYear()}/options?L=${LEAGUE_ID}&O=04&P=${encodeURIComponent(pid)}`;
      window.open(url, "_blank", "noopener");
    });
  }

  function setupNominationsControls() {
    $$("#nominations-status-chips .ah-pos-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const status = chip.dataset.nstatus || "open";
        STATE.nom_filters.status = status;
        $$("#nominations-status-chips .ah-pos-chip").forEach((c) =>
          c.classList.toggle("active", c === chip));
        renderNominations();
      });
    });
    const sortSel = $("#nominations-sort");
    if (sortSel) {
      sortSel.addEventListener("change", (e) => {
        STATE.nom_sort = e.target.value;
        renderNominations();
      });
    }
    const testToggle = $("#nominations-test-toggle");
    if (testToggle) {
      testToggle.addEventListener("click", () => {
        STATE.show_test = !STATE.show_test;
        renderNominations();
      });
    }
    const testDelete = $("#nominations-test-delete");
    if (testDelete) {
      testDelete.addEventListener("click", async () => {
        if (!window.confirm("Permanently delete ALL test lots and their bids from the board?\n\nReal (non-test) lots are untouched. Cannot be undone.")) return;
        testDelete.disabled = true;
        try {
          const url = _withUserId(`${WORKER_BASE}/admin/auction/delete-test-lots?L=${encodeURIComponent(LEAGUE_ID)}&YEAR=${new Date().getUTCFullYear()}`);
          const r = await fetch(url, { method: "POST", mode: "cors", credentials: "omit", headers: { "Content-Type": "application/json" }, body: "{}" });
          const j = await r.json().catch(() => ({}));
          if (r.ok && j.ok) {
            alert(`Deleted ${j.deleted_lots} test lot(s) + ${j.deleted_bids} bid(s).`);
            await loadLots();
          } else {
            alert(`Delete failed: ${j.error || ("HTTP " + r.status)}`);
          }
        } catch (e) {
          alert("Delete failed: " + e.message);
        } finally {
          testDelete.disabled = false;
          renderNominations();
        }
      });
    }
  }

  function formatCountdown(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    if (s === 0) return "LOCKED";
    const days = Math.floor(s / 86400);
    const hrs = Math.floor((s % 86400) / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    if (days > 0) return `${days}d ${hrs}h ${mins}m`;
    if (hrs > 0) return `${hrs}h ${mins}m`;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
  }

  // Resolve franchise display name from /api/me payload or fall back to id.
  // The auction lots route returns fids; we want names in the table.
  function franchiseName(fid) {
    if (!fid) return "—";
    // Try ERA-eligible payload (it has prior_owner_fid → prior_owner mapping)
    if (STATE.era && STATE.era.players) {
      for (const p of STATE.era.players) {
        if (p.prior_owner_fid === fid && p.prior_owner) return p.prior_owner;
      }
    }
    return fid;
  }

  function playerInfo(pid) {
    // Prefer ERA payload (richer — includes rookie slot etc.). Falls
    // back to "Player #pid" if not in the ERA list AND the lot row
    // doesn't carry enriched name fields (it should, per worker).
    if (STATE.era && STATE.era.players) {
      for (const p of STATE.era.players) {
        if (p.player_id === pid) return p;
      }
    }
    return { name: "Player #" + pid, position: "", nfl_team: "" };
  }

  function renderNominations() {
    const tbody = $("#nominations-tbody");
    if (!tbody) return;
    const allLots = (STATE.lots && STATE.lots.lots) || [];
    // Per-auction split (lots aren't kind-tagged): a lot belongs to the ERA
    // iff its player is in the ERA-eligible pool, else it's an FA-auction lot.
    const eraIds = eraPoolIds();
    const lots = allLots.filter((l) => lotIsEra(l, eraIds) === (STATE.tab === "era"));
    // Test-lot visibility: hidden by default on the prod league. The chip in
    // the filters row toggles them (its label carries the hidden count).
    const isTestLeague = LEAGUE_ID !== "74598";
    const testCount = lots.filter((l) => Number(l.is_test) === 1).length;
    const showTest = STATE.show_test || isTestLeague;
    const testToggle = $("#nominations-test-toggle");
    if (testToggle) {
      testToggle.textContent = showTest ? `Hide test (${testCount})` : `Show test (${testCount})`;
      testToggle.classList.toggle("active", showTest);
      testToggle.style.display = testCount > 0 ? "" : "none";
    }
    const delBtn = $("#nominations-test-delete");
    if (delBtn) delBtn.style.display = showTest && testCount > 0 ? "" : "none";
    const filtered = lots.filter((l) => {
      if (!showTest && Number(l.is_test) === 1) return false;
      if (STATE.nom_filters.status === "all") return true;
      return l.status === STATE.nom_filters.status;
    });
    const sorted = filtered.slice().sort((a, b) => {
      switch (STATE.nom_sort) {
        case "current_high_bid_k": return (b.current_high_bid_k || 0) - (a.current_high_bid_k || 0);
        case "bid_count":          return (b.bid_count || 0) - (a.bid_count || 0);
        case "opened_at_unix":     return (b.opened_at_unix || 0) - (a.opened_at_unix || 0);
        case "time_remaining":
        default:
          return (a.seconds_remaining || 0) - (b.seconds_remaining || 0);
      }
    });

    $("#nominations-summary").textContent = `${sorted.length} of ${lots.length} lots`;
    $("#nominations-table-summary").textContent = sorted.length === 0
      ? "No lots match the current filters."
      : `Showing ${sorted.length} lot${sorted.length === 1 ? "" : "s"}.`;

    const meta = $("#nominations-meta");
    if (meta) {
      const generated = STATE.lots && STATE.lots.generated_at
        ? new Date(STATE.lots.generated_at).toLocaleTimeString()
        : "—";
      meta.textContent = `Last refreshed: ${generated} · Polled every 5 min by worker cron · Auto-refresh every 30s.`;
    }

    if (sorted.length === 0) {
      tbody.innerHTML = `<tr><td colspan="11" style="text-align:center;color:var(--muted);padding:24px;">
        No lots match the current filters.
      </td></tr>`;
      return;
    }

    const viewerFid = STATE.me && STATE.me.franchise_id ? STATE.me.franchise_id : null;
    tbody.innerHTML = sorted.map((l) => {
      // Prefer worker-enriched fields on the lot row; fall back to
      // ERA payload metadata; final fallback to "Player #pid".
      const fromEra = playerInfo(l.player_id);
      const pi = {
        name: l.player_name || fromEra.name,
        position: l.position || fromEra.position,
        nfl_team: l.nfl_team || fromEra.nfl_team,
      };
      const pos = String(pi.position || "").toUpperCase();
      // TEST badge from the real per-lot flag (ups_auction_lots.is_test).
      // The old "not in ERA list ⇒ TEST" heuristic would have mislabeled
      // every genuine FAA win once the real auction opened.
      const testBadge = Number(l.is_test) === 1
        ? ` <span class="ah-origin Trade" title="Test lot — hidden by default; commish can delete via the filters row">TEST</span>`
        : "";
      const nflProfileUrl = `https://www.myfantasyleague.com/${new Date().getUTCFullYear()}/options?L=${LEAGUE_ID}&O=04&P=${encodeURIComponent(l.player_id)}`;
      const isWon = l.status === "won";
      // This board reads /api/auction/lots (D1, up to ~5 min behind the */5
      // poll). The live FA payload carries the SAME lots with an O=43 overlay
      // (fresh current bid + the viewer's real proxy), so prefer that when it's
      // higher — otherwise a lot reads cheaper than it is the moment you open
      // the bid modal. Keyed by player_id; only ever raises.
      const ov = _overlaidLot(l.player_id);
      const freshHighK = Math.max(
        Number(l.current_high_bid_k) || 0,
        ov ? Math.round((Number(ov.high_bid_amount) || 0) / 1000) : 0
      );
      // The O=43 overlay is the ONLY source of a max: MFL emits no transaction
      // when you change one, so D1 cannot know it. l.your_proxy_bid_k is always
      // null by design — no overlay (no MFL session) means we genuinely don't
      // know your max, and 0 says exactly that.
      const freshProxyK = (ov && ov.your_proxy_bid_amount != null)
        ? Math.round(Number(ov.your_proxy_bid_amount) / 1000)
        : 0;
      // MFL's price is ahead of D1's, so D1's leader belongs to the old price and
      // the worker blanked it. Say that plainly — a name we know is wrong is far
      // worse than an admission, because the reader acts on it. (2026-07-15: the
      // board told Keith he led Josh Allen at $4,000 while Pure Greatness had
      // actually taken it 26 minutes earlier.)
      // Prefer MFL's leader over D1's. The overlay reads it off O=43 (the fid is
      // in the markup), so it is right even when the */5 poll is behind — which
      // it was by 19 hours on 2026-07-15, showing Keith as the leader of a lot he
      // had already lost.
      const freshBidder = (ov && ov.high_bidder_label)
        ? ov.high_bidder_label
        : (l.current_high_bidder_name || franchiseName(l.current_high_bidder_fid) || "—");
      // Prefer MFL's own countdown (overlaid from O=43) over D1's lock, which
      // recomputes from bid timestamps and resets on a forced increase — MFL
      // doesn't, so D1 can over-state and someone could miss the real lock.
      const freshSeconds = (ov && Number.isFinite(Number(ov.seconds_remaining)))
        ? Number(ov.seconds_remaining) : (Number(l.seconds_remaining) || 0);
      const freshLocksAt = (ov && Number(ov.locks_at_unix)) ? Number(ov.locks_at_unix) : l.locks_at_unix;
      // "—" and "?" are NOT the same claim. "—" asserts you have no max on this
      // lot; "?" admits we couldn't read it. They rendered identically before, so
      // a broken overlay looked exactly like valid data and cost a day of chasing
      // a phantom "Burrow reset itself" bug (2026-07-15).
      const proxyBlind = !!(STATE.fa && STATE.fa.proxy_overlay_ok === false);
      const proxyCell = (viewerFid && freshProxyK)
        ? `${fmtK(freshProxyK)}`
        : (proxyBlind
            ? `<span class="small ah-proxy-blind" title="Can't read your max — no live MFL session. Open the auction on MFL once to refresh it. This is NOT '$0'; we simply can't see it.">?</span>`
            : `<span class="small" style="color:var(--muted)" title="No max above the current bid on this lot.">—</span>`);
      // current_high_bid_k is already $K here (unlike the FAA row's dollars).
      // renderNominations paints BOTH auctions' lots (filtered by the active
      // tab), so the bid must be routed to the tab's auction — hardcoding ERA
      // would POST free-agent bids to the expired-rookie form (wrong auction /
      // 503 when ERA is off). Mirrors mobile's isEra ? "expired-rookie" : "free-agent".
      const auctionType = STATE.tab === "era" ? "expired-rookie" : "free-agent";
      const actionCell = isWon
        ? `<span class="ah-origin Rookie">WON by ${escapeHtml((l.winner_name && !/^\d{4}$/.test(l.winner_name)) ? l.winner_name : franchiseName(l.winner_fid))}</span>`
        : bidActionCell(l.player_id, pi.name, auctionType, freshHighK);
      return `
        <tr data-lot-id="${escapeHtml(l.lot_id)}" data-seconds="${l.seconds_remaining}" data-status="${l.status}">
          <td><button type="button" class="ah-player-open player-link" data-action="open-player-modal" data-player-id="${escapeHtml(l.player_id)}">${escapeHtml(pi.name || ("Player #" + l.player_id))}</button>${testBadge}</td>
          <td><span class="ah-pos ${pos}">${escapeHtml(pos)}</span></td>
          <td class="col-md">${escapeHtml(pi.nfl_team || "—")}</td>
          <td>${escapeHtml(l.nominator_name || franchiseName(l.nominator_fid))}</td>
          <td class="num">${fmtDollarsFromK(freshHighK)}</td>
          <td>${escapeHtml(freshBidder)}</td>
          <td class="num col-md">${l.bid_count}</td>
          <td class="num col-md">${l.unique_bidder_count}</td>
          <td class="ah-countdown" data-locks-at="${freshLocksAt}">${isWon ? "—" : formatCountdown(freshSeconds)}</td>
          <td class="col-md num">${proxyCell}</td>
          <td>${actionCell}</td>
        </tr>`;
    }).join("");
  }

  // Tick down the time-remaining cells without re-fetching from the worker.
  // Ticks BOTH the Nominations table and the ERA table (same .ah-countdown
  // + data-locks-at pattern).
  function updateNominationCountdowns() {
    const now = Math.floor(Date.now() / 1000);
    $$("#nominations-tbody tr, #era-tbody tr").forEach((tr) => {
      const cell = tr.querySelector(".ah-countdown");
      if (!cell || tr.dataset.status === "won") return;
      const locksAt = Number(cell.dataset.locksAt || 0);
      if (!locksAt) return;
      const remaining = Math.max(0, locksAt - now);
      cell.textContent = formatCountdown(remaining);
      if (remaining === 0) cell.style.color = "var(--err)";
    });
  }

  // ════════════════════════════════════════════════════════════════════
  // GO
  // ════════════════════════════════════════════════════════════════════
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
