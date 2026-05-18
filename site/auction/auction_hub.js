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
    setupTabs();
    setupFilters();
    setupSorting();

    // Version badge — best-effort, doesn't block render
    fetchJSON("VERSION.json?_=" + Date.now()).then((v) => {
      STATE.version = v;
      const el = $("#ah-version-badge");
      if (el && v && v.version) el.textContent = "v" + v.version;
    }).catch(() => {
      const el = $("#ah-version-badge");
      if (el) el.textContent = "v0.1.0";
    });

    await Promise.all([loadMe(), loadEraEligible()]);
    renderEraMeta();
    renderEraTable();
  }

  async function loadMe() {
    const hpmFid = _hpmFranchiseId();
    const qs = "?L=74598" + (hpmFid ? "&franchise_id=" + hpmFid : "");
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
      const data = await fetchJSON(apiUrl("/api/auction/era-eligible") + "?L=74598&YEAR=" + season);
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
      ? `https://www.myfantasyleague.com/${p.season || new Date().getUTCFullYear()}/options?L=74598&O=04&P=${encodeURIComponent(p.player_id)}`
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
    const nominateEligible = !p.nominate_blocked;
    const nominateBtn = nominateEligible
      ? `<button type="button" class="btn small ah-nominate-btn" data-pid="${escapeHtml(p.player_id)}" disabled title="Nomination endpoint not wired yet">Nominate</button>`
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
  // GO
  // ════════════════════════════════════════════════════════════════════
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
