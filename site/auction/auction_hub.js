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
  const fetchJSON = (url) =>
    fetch(url, { cache: "no-store" }).then((r) => {
      if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
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

  const STATE = {
    version: null,
    me: null,
    era: null,                   // payload from /api/auction/era-eligible
    activeTab: "era",
    era_filters: { pos: "ALL", owner: "" },
    era_sort: "y3_salary",
    era_sort_dir: -1,            // desc
    lots: null,                  // payload from /api/auction/lots
    nom_filters: { status: "open" },
    nom_sort: "time_remaining",
  };

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
  const fmtDate = (iso) => {
    if (!iso) return "—";
    try {
      const d = new Date(iso);
      return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    } catch (e) { return iso; }
  };

  // Map MFL position codes to display buckets (matches rookie hub convention)
  function posBucket(p) {
    p = String(p || "").toUpperCase();
    if (["QB", "RB", "WR", "TE"].includes(p)) return p;
    if (p === "K") return "PK";
    if (p === "P") return "PN";
    if (["PK", "PN"].includes(p)) return p;
    // Everything else (DL, LB, DB, S, CB, DT, DE, ...) collapses to IDP for filtering
    return "IDP";
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

    setupTabs();
    setupFilters();
    setupSorting();
    setupNominationsControls();

    // Version badge — best-effort, doesn't block render
    fetchJSON("VERSION.json?_=" + Date.now()).then((v) => {
      STATE.version = v;
      const el = $("#ah-version-badge");
      if (el && v && v.version) el.textContent = "v" + v.version;
    }).catch(() => {
      const el = $("#ah-version-badge");
      if (el) el.textContent = "v0.1.0";
    });

    await Promise.all([loadMe(), loadEraEligible(), loadLots()]);
    renderEraMeta();
    renderEraTable();
    renderNominations();

    // Auto-refresh nominations every 30s.
    setInterval(async () => {
      await loadLots();
      renderNominations();
    }, 30000);

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
        tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--err);padding:24px;">
          Failed to load eligible players: ${escapeHtml(STATE.era.error)}
        </td></tr>`;
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // TABS
  // ════════════════════════════════════════════════════════════════════
  function setupTabs() {
    $$("#ah-tabs button").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.disabled) return;
        const tab = btn.dataset.tab;
        if (!tab || tab === STATE.activeTab) return;
        STATE.activeTab = tab;
        $$("#ah-tabs button").forEach((b) => b.classList.toggle("active", b === btn));
        $$(".ah-section").forEach((s) => s.classList.toggle("active", s.dataset.section === tab));
      });
    });
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
          const numeric = ["age", "y3_salary", "current_bid", "rookie_slot"];
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
    const deadlineTxt = deadline ? fmtDate(deadline) : "TBD (MFL calendar)";
    if (meta) meta.textContent = `Rookie extension deadline: ${deadlineTxt} · ${total} players currently ERA-eligible.`;
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
    const numeric = ["age", "y3_salary", "current_bid", "rookie_slot"];
    return rows.slice().sort((a, b) => {
      let va = a[col], vb = b[col];
      if (numeric.includes(col)) {
        va = Number(va);
        vb = Number(vb);
        if (!Number.isFinite(va)) va = -Infinity;
        if (!Number.isFinite(vb)) vb = -Infinity;
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
      tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--muted);padding:24px;">
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
    const why = p.eligibility_reason || "Rookie contract expired — no extension submitted.";
    const deadline = p.deadline_iso ? ` Extension deadline: ${fmtDate(p.deadline_iso)}.` : "";
    const whyTooltip = `${why}${deadline}`;

    const mflProfileUrl = p.player_id
      ? `https://www.myfantasyleague.com/${p.season || new Date().getUTCFullYear()}/options?L=${LEAGUE_ID}&O=04&P=${encodeURIComponent(p.player_id)}`
      : null;

    const playerCell = mflProfileUrl
      ? `<a href="${mflProfileUrl}" target="_blank" rel="noopener" class="player-link">${escapeHtml(p.name || ("Player #" + p.player_id))}</a><span class="ah-why" title="${escapeHtml(whyTooltip)}">?</span>`
      : `${escapeHtml(p.name || ("Player #" + p.player_id))}<span class="ah-why" title="${escapeHtml(whyTooltip)}">?</span>`;

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
    //     &PLAYER_ID=<pid>&SELECT=Select+Franchise
    // SELECT=Select+Franchise is the UI default-state marker MFL
    // includes when navigating directly to the nominate flow.
    const nominateEligible = !p.nominate_blocked;
    const viewerFidForMfl = (STATE.me && STATE.me.franchise_id) || "0000";
    const mflAuctionUrl =
      `https://www48.myfantasyleague.com/${p.season || new Date().getUTCFullYear()}` +
      `/options?LEAGUE_ID=${LEAGUE_ID}&FRANCHISE=${encodeURIComponent(viewerFidForMfl)}&O=43` +
      `&PLAYER_ID=${encodeURIComponent(p.player_id)}&SELECT=Select+Franchise`;
    const nominateBtn = nominateEligible
      ? `<a href="${mflAuctionUrl}" target="_blank" rel="noopener" class="btn small ah-nominate-btn" data-pid="${escapeHtml(p.player_id)}" title="Opens MFL's native auction page in a new tab. UPS-side nominate endpoint is parked (see CROSS_CODEBASE_ALIGNMENT §4.1).">Nominate ↗</a>`
      : `<button type="button" class="btn small secondary" disabled title="${escapeHtml(p.nominate_block_reason || "Nomination blocked")}">Blocked</button>`;

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

    return `
      <tr data-pid="${escapeHtml(p.player_id || "")}">
        <td>${playerCell}</td>
        <td><span class="ah-pos ${pos}">${escapeHtml(pos)}</span></td>
        <td class="col-md">${escapeHtml(p.nfl_team || "—")}</td>
        <td class="num col-lo">${p.age != null ? escapeHtml(String(p.age)) : "—"}</td>
        <td class="col-md">${escapeHtml(p.prior_owner || "—")}</td>
        <td class="col-lo">${escapeHtml(p.rookie_slot || "—")}</td>
        <td>${originChip}</td>
        <td class="num">${p.y3_salary != null ? fmtK(p.y3_salary) : "—"}</td>
        <td class="num col-md">${currentBidCell}</td>
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
    const lots = (STATE.lots && STATE.lots.lots) || [];
    const filtered = lots.filter((l) => {
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
      // Test/TEST badge: lot's player is not in our ERA list — Keith
      // can test the auction flow with arbitrary FAs without polluting
      // real ERA reporting.
      const isInEra = !!(STATE.era && STATE.era.players && STATE.era.players.some((p) => p.player_id === l.player_id));
      const testBadge = isInEra ? "" : ` <span class="ah-origin Trade" title="Not in ERA-eligible list — likely a test or off-pool auction">TEST</span>`;
      const nflProfileUrl = `https://www.myfantasyleague.com/${new Date().getUTCFullYear()}/options?L=${LEAGUE_ID}&O=04&P=${encodeURIComponent(l.player_id)}`;
      const viewerFidForMfl = (STATE.me && STATE.me.franchise_id) || "0000";
      const mflAuctionUrl =
        `https://www48.myfantasyleague.com/${new Date().getUTCFullYear()}` +
        `/options?LEAGUE_ID=${LEAGUE_ID}&FRANCHISE=${encodeURIComponent(viewerFidForMfl)}&O=43` +
        `&PLAYER_ID=${encodeURIComponent(l.player_id)}&SELECT=Select+Franchise`;
      const isWon = l.status === "won";
      const proxyCell = (viewerFid && l.your_proxy_bid_k)
        ? `${fmtK(l.your_proxy_bid_k)}`
        : `<span class="small" style="color:var(--muted)">—</span>`;
      const actionCell = isWon
        ? `<span class="ah-origin Rookie">WON by ${escapeHtml(franchiseName(l.winner_fid))}</span>`
        : `<a href="${mflAuctionUrl}" target="_blank" rel="noopener" class="btn small" title="Open MFL auction to bid/raise">Bid ↗</a>`;
      return `
        <tr data-lot-id="${escapeHtml(l.lot_id)}" data-seconds="${l.seconds_remaining}" data-status="${l.status}">
          <td><a href="${nflProfileUrl}" target="_blank" rel="noopener" class="player-link">${escapeHtml(pi.name || ("Player #" + l.player_id))}</a>${testBadge}</td>
          <td><span class="ah-pos ${pos}">${escapeHtml(pos)}</span></td>
          <td class="col-md">${escapeHtml(pi.nfl_team || "—")}</td>
          <td>${escapeHtml(franchiseName(l.nominator_fid))}</td>
          <td class="num">${fmtK(l.current_high_bid_k)}</td>
          <td>${escapeHtml(franchiseName(l.current_high_bidder_fid))}</td>
          <td class="num col-md">${l.bid_count}</td>
          <td class="num col-md">${l.unique_bidder_count}</td>
          <td class="ah-countdown" data-locks-at="${l.locks_at_unix}">${isWon ? "—" : formatCountdown(l.seconds_remaining)}</td>
          <td class="col-md num">${proxyCell}</td>
          <td>${actionCell}</td>
        </tr>`;
    }).join("");
  }

  // Tick down the time-remaining cells without re-fetching from the worker.
  function updateNominationCountdowns() {
    const now = Math.floor(Date.now() / 1000);
    $$("#nominations-tbody tr").forEach((tr) => {
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
