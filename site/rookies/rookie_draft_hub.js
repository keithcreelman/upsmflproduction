/* Rookie Draft Hub — state machine + renderers */
(function () {
  "use strict";

  // Convert "Injury Bust" → "InjuryBust" for CSS class (spaces break class selectors)
  const tierSlug = (t) => String(t || "Bust").replace(/\s+/g, "");

  // TIER_DEFS must match the pipeline's classify_tier() thresholds exactly.
  // Current rule: NET = 3yr games-weighted (E+P rate) − 0.5 × (3yr Dud rate)
  const TIER_DEFS = {
    Smash:   { min: "NET ≥ +30",
               basic: "A roster cornerstone. Had way more big weeks than bad ones over 3 years. You'd build around this guy.",
               desc: "Reliably elite — roster cornerstone. Thrilled to have drafted.",
               examples: "Zeke '16, McCaffrey '17, Chase '21, Nacua '23, Bosa '19, Bates '18." },
    Hit:     { min: "NET +15 to +30",
               basic: "A solid starter. More good weeks than bad — helps you win matchups regularly.",
               desc: "More elite weeks than duds — a reliable starter who helps you win.",
               examples: "DK Metcalf '19, Chubb '18, Saquon '18, Freeman '14." },
    Contrib: { min: "NET 0 to +15",
               basic: "Useful rotational piece. Net positive, but not someone you rely on every week.",
               desc: "Useful rotational piece — net positive contribution.",
               examples: "Russell Wilson '12 (by our metric), late-round pleasant surprises." },
    Bust:    { min: "NET < 0",
               basic: "Hurt your team more than helped. More dud weeks than big weeks, or never played enough to matter.",
               desc: "Duds outweigh peaks, or never played enough to build a sample.",
               examples: "Josh Rosen '18, Trent Richardson '12, most late-round picks." },
  };

  const STATE = {
    tiers: null,
    history: null,
    teams: null,
    day_trades: null,
    live: null,
    prospects: null,
    ap_ep: null,
    activeTab: "live",
    h_sort: "_avg",       // sort by the metric's "3yr Avg" column by default
    h_sort_dir: -1,       // descending — best Draft Rating first
    h_filters: { season: "", team: "", round: "", slot: "", pos: "", pg: "", tier: "", search: "", active: "all" },
    h_metric: "draft_rating",  // open Historical on Draft Rating (slot-aware grading)
    t_filters: { active: "active", season: "", round: "", slot: "", pos: "", pg: "" },
    ae_sort: "season",
    ae_sort_dir: -1,
    ae_filters: { season: "", owner: "", active: "all", search: "" },
    selectedProspect: null,
    r6_running: false,
    r6_simulate: false,
    r6_order: [],
  };

  const fetchJSON = (path) => fetch(path + "?v=" + Date.now(), { cache: "no-store" }).then(r => r.json());

  // Position bucketing — all secondaries collapse to "DB", all line collapse to "DL".
  function POS_COMBINED(pos) {
    if (!pos) return "";
    const p = pos.toUpperCase();
    if (["QB","RB","WR","TE"].includes(p)) return p;
    if (["LB"].includes(p)) return "LB";
    if (["PK","PN","P","K"].includes(p)) return p === "K" ? "PK" : (p === "P" ? "PN" : p);
    // Defensive back family
    if (p.includes("DB") || p.includes("CB") || p === "S" || p.includes("SS") || p.includes("FS") || p === "CB+S") return "DB";
    // Defensive line family
    if (p.includes("DL") || p.includes("DE") || p.includes("DT") || p === "DT+DE") return "DL";
    return p;
  }

  async function loadAll() {
    const [tiers, history, teams, dayTrades, live, prospects, apEp, me, version] = await Promise.all([
      fetchJSON("rookie_draft_tiers.json"),
      fetchJSON("rookie_draft_history.json"),
      fetchJSON("rookie_draft_team_tendencies.json"),
      fetchJSON("rookie_draft_day_trades.json"),
      fetchJSON("rookie_draft_hub_2026.json"),
      fetchJSON("rookie_prospects_2026.json"),
      fetchJSON("rookie_ap_vs_ep.json").catch(() => ({ rows: [], season_summary: [] })),
      fetch("/api/me").then(r => r.ok ? r.json() : { configured: false }).catch(() => ({ configured: false })),
      fetchJSON("VERSION.json").catch(() => null),
    ]);
    STATE.version = version;
    STATE.tiers = tiers;
    STATE.history = history;
    STATE.teams = teams;
    STATE.day_trades = dayTrades;
    STATE.live = live;
    STATE.prospects = prospects;
    STATE.ap_ep = apEp;
    STATE.me = me;
    try {
      STATE.future_picks = await fetchJSON("rookie_future_picks.json");
    } catch (e) {
      STATE.future_picks = { picks: [], meta: {} };
    }
    document.getElementById("rdh-meta").textContent =
      `Generated ${new Date(tiers.meta.generated_at_utc).toLocaleString()} · ${history.picks.length} historical picks · ${prospects.prospects.length} 2026 prospects`;
    // Version badge
    const vBadge = document.getElementById("rdh-version-badge");
    if (vBadge) {
      if (STATE.version && STATE.version.version) {
        vBadge.textContent = `v${STATE.version.version}`;
        vBadge.title = STATE.version.label || "View methodology changelog";
        vBadge.addEventListener("click", showVersionChangelog);
      } else {
        vBadge.textContent = "v?";
      }
    }
    hydrateFilters();
    wireListeners();
    renderAll();
  }

  function showVersionChangelog() {
    const v = STATE.version;
    if (!v) return;
    const changes = (v.changes || []).slice().reverse();
    const sig = v.methodology_signature || {};
    const corr = v.correlations_snapshot || {};
    openModal(`
      <h3>Methodology Changelog</h3>
      <div class="profile-block" style="border-top:0; padding-top:0; margin-top:10px; background:rgba(91,141,255,0.08); padding:12px; border-radius:6px;">
        <h4 style="color:var(--accent);">Current: v${v.version} — ${escapeHtml(v.label || "")}</h4>
        <p class="small" style="color:var(--muted); margin:0;">Released ${escapeHtml(v.released || "")}. ${escapeHtml(v.description || "")}</p>
      </div>

      <div class="profile-block">
        <h4>Version scheme</h4>
        <p class="small" style="color:var(--muted);">
          <strong>Major (V1 → V2)</strong> — methodology overhaul (e.g. changing the tier classifier formula).<br>
          <strong>Minor (V1.0 → V1.1)</strong> — threshold tuning or added metric (e.g. tier cutoffs moved).<br>
          <strong>Patch (V1.0.0 → V1.0.1)</strong> — bug fixes that alter outputs (e.g. owner-attribution fix).<br>
          Versions only bump on GitHub commit — local tweaks don't count until shipped.
        </p>
      </div>

      <div class="profile-block">
        <h4>Change history</h4>
        ${changes.map(c => `
          <div style="margin-bottom:14px; padding-bottom:10px; border-bottom:1px solid var(--border);">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <strong>v${escapeHtml(c.version)}</strong>
              <span class="small" style="color:var(--muted)">${escapeHtml(c.date)} · ${escapeHtml(c.type)}</span>
            </div>
            <p style="margin:4px 0;">${escapeHtml(c.summary)}</p>
            ${c.details && c.details.length ? `<ul style="margin:4px 0 0 18px; color:var(--muted); font-size:12px;">
              ${c.details.map(d => `<li>${escapeHtml(d)}</li>`).join("")}
            </ul>` : ""}
          </div>
        `).join("")}
      </div>

      <div class="profile-block">
        <h4>Current methodology signature (v${v.version})</h4>
        <table class="rdh-table">
          <tbody>
            ${Object.entries(sig).map(([k, val]) => `
              <tr>
                <td style="white-space:nowrap;"><code>${escapeHtml(k)}</code></td>
                <td class="small">${escapeHtml(val)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>

      ${corr.n_team_seasons ? `
      <div class="profile-block">
        <h4>Validation snapshot (${corr.span || ""}, n=${corr.n_team_seasons})</h4>
        <table class="rdh-table">
          <tbody>
            <tr><td>Overall NET → AP%</td><td class="num"><strong>${corr.overall_net != null ? (corr.overall_net > 0 ? "+" : "") + corr.overall_net.toFixed(3) : "—"}</strong></td></tr>
            <tr><td>Offense E+P → AP%</td><td class="num">${corr.offense_ep != null ? "+" + corr.offense_ep.toFixed(3) : "—"}</td></tr>
            <tr><td>Offense Dud → AP%</td><td class="num">${corr.offense_dud != null ? corr.offense_dud.toFixed(3) : "—"}</td></tr>
            <tr><td>Defense E+P → AP%</td><td class="num">${corr.defense_ep != null ? "+" + corr.defense_ep.toFixed(3) : "—"}</td></tr>
            <tr><td>Defense Dud → AP%</td><td class="num">${corr.defense_dud != null ? corr.defense_dud.toFixed(3) : "—"}</td></tr>
          </tbody>
        </table>
      </div>` : ""}
      <div class="actions"><button class="btn secondary" onclick="document.getElementById('rdh-modal-overlay').classList.remove('open')">Close</button></div>
    `);
  }

  function hydrateFilters() {
    const seasons = [...new Set(STATE.history.picks.map(p => p.season))].sort((a, b) => b - a);
    for (const sel of ["h-season", "t-season"]) {
      const el = document.getElementById(sel);
      if (el) {
        for (const s of seasons) el.insertAdjacentHTML("beforeend", `<option value="${s}">${s}</option>`);
      }
    }
    const ddSeason = document.getElementById("dd-season");
    for (const s of Object.keys(STATE.day_trades.trades_by_season).sort((a, b) => b - a)) {
      ddSeason.insertAdjacentHTML("beforeend", `<option value="${s}">${s}</option>`);
    }
    // Static slot dropdowns (1..12 — always the same)
    for (const sel of ["h-slot", "t-slot"]) {
      const el = document.getElementById(sel);
      for (let s = 1; s <= 12; s++) el.insertAdjacentHTML("beforeend", `<option value="${s}">${String(s).padStart(2, "0")}</option>`);
    }
    // Initial dynamic hydration of Position Group / Position / Tier dropdowns
    rebuildHistoryDynamicFilters();
    rebuildTeamsDynamicFilters();
    rebuildHistoryOwnerDropdown();
    hydrateApEpFilters();
  }

  // ── Dynamic filter helpers ────────────────────────────────────────────
  // Position Group values used in data. Display labels are title-cased.
  const PG_LABELS = { offense: "Offense", defense: "Defense", special: "Special Teams" };
  // Sub-positions per group (canonical order)
  const PG_POSITIONS = {
    offense: ["QB", "RB", "WR", "TE"],
    defense: ["DB", "DL", "LB"],
    special: ["PK", "PN"],
  };
  // Tier canonical display order
  const TIER_ORDER = ["Smash", "Hit", "Contrib", "Bust"];

  function populateSelect(id, options, currentVal, placeholder = "All") {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = `<option value="">${placeholder}</option>` +
      options.map(o => {
        const v = typeof o === "string" ? o : o.value;
        const l = typeof o === "string" ? o : o.label;
        return `<option value="${v}"${v === currentVal ? " selected" : ""}>${l}</option>`;
      }).join("");
  }

  function currentHistoryRows() {
    // Apply only the active/season/round/slot/owner filters (upstream of pg/pos/tier)
    // so pg/pos/tier options are dynamic against what's currently selectable.
    const f = STATE.h_filters;
    return STATE.history.picks.filter(p =>
      (!f.season || String(p.season) === f.season) &&
      (!f.round || String(p.round) === f.round) &&
      (!f.slot || String(p.slot) === f.slot) &&
      (!f.team || p.owner_name === f.team || p.franchise_id === f.team) &&
      (f.active === "all" ? true :
        f.active === "retired" ? !p.owner_active : p.owner_active)
    );
  }

  function rebuildHistoryDynamicFilters() {
    const pool = currentHistoryRows();
    // Pos Group options (only those present)
    const pgsPresent = new Set(pool.map(p => p.pos_group).filter(Boolean));
    const pgOpts = ["offense", "defense", "special"].filter(g => pgsPresent.has(g))
      .map(g => ({ value: g, label: PG_LABELS[g] }));
    populateSelect("h-pg", pgOpts, STATE.h_filters.pg);
    // Position options (dependent on pg selection)
    const selectedPg = STATE.h_filters.pg;
    let posPool = pool;
    if (selectedPg) posPool = posPool.filter(p => p.pos_group === selectedPg);
    const posPresent = new Set(posPool.map(p => POS_COMBINED(p.position)).filter(Boolean));
    // Grouped positions (optgroups only if no pg filter)
    const hPosEl = document.getElementById("h-pos");
    hPosEl.innerHTML = '<option value="">All</option>';
    for (const group of ["offense", "defense", "special"]) {
      if (selectedPg && selectedPg !== group) continue;
      const groupPositions = PG_POSITIONS[group].filter(p => posPresent.has(p));
      if (!groupPositions.length) continue;
      if (!selectedPg) {
        const og = document.createElement("optgroup");
        og.label = PG_LABELS[group];
        for (const p of groupPositions) {
          const opt = document.createElement("option");
          opt.value = p; opt.textContent = p;
          if (p === STATE.h_filters.pos) opt.selected = true;
          og.appendChild(opt);
        }
        hPosEl.appendChild(og);
      } else {
        for (const p of groupPositions) {
          const opt = document.createElement("option");
          opt.value = p; opt.textContent = p;
          if (p === STATE.h_filters.pos) opt.selected = true;
          hPosEl.appendChild(opt);
        }
      }
    }
    // Tier options (only tiers present in the pool)
    let tierPool = pool;
    if (selectedPg) tierPool = tierPool.filter(p => p.pos_group === selectedPg);
    if (STATE.h_filters.pos) tierPool = tierPool.filter(p => POS_COMBINED(p.position) === STATE.h_filters.pos);
    const tiersPresent = new Set(tierPool.map(p => p.tier).filter(Boolean));
    const tierOpts = TIER_ORDER.filter(t => tiersPresent.has(t));
    populateSelect("h-tier", tierOpts, STATE.h_filters.tier);
  }

  function rebuildTeamsDynamicFilters() {
    const f = STATE.t_filters;
    const pool = STATE.history.picks.filter(p =>
      (!f.season || String(p.season) === f.season) &&
      (!f.round || String(p.round) === f.round) &&
      (!f.slot || String(p.slot) === f.slot) &&
      (f.active === "all" ? true :
        f.active === "retired" ? !p.owner_active : p.owner_active)
    );
    const pgsPresent = new Set(pool.map(p => p.pos_group).filter(Boolean));
    const pgOpts = ["offense", "defense", "special"].filter(g => pgsPresent.has(g))
      .map(g => ({ value: g, label: PG_LABELS[g] }));
    populateSelect("t-pg", pgOpts, STATE.t_filters.pg);
    const selectedPg = STATE.t_filters.pg;
    let posPool = selectedPg ? pool.filter(p => p.pos_group === selectedPg) : pool;
    const posPresent = new Set(posPool.map(p => POS_COMBINED(p.position)).filter(Boolean));
    const tPosEl = document.getElementById("t-pos");
    tPosEl.innerHTML = '<option value="">All</option>';
    for (const group of ["offense", "defense", "special"]) {
      if (selectedPg && selectedPg !== group) continue;
      const groupPositions = PG_POSITIONS[group].filter(p => posPresent.has(p));
      if (!groupPositions.length) continue;
      if (!selectedPg) {
        const og = document.createElement("optgroup");
        og.label = PG_LABELS[group];
        for (const p of groupPositions) {
          const opt = document.createElement("option");
          opt.value = p; opt.textContent = p;
          if (p === STATE.t_filters.pos) opt.selected = true;
          og.appendChild(opt);
        }
        tPosEl.appendChild(og);
      } else {
        for (const p of groupPositions) {
          const opt = document.createElement("option");
          opt.value = p; opt.textContent = p;
          if (p === STATE.t_filters.pos) opt.selected = true;
          tPosEl.appendChild(opt);
        }
      }
    }
  }

  function rebuildHistoryOwnerDropdown() {
    const hTeam = document.getElementById("h-team");
    const currentVal = STATE.h_filters.team;
    hTeam.innerHTML = '<option value="">All</option>';
    const filterActive = STATE.h_filters.active;
    const teamOptions = Object.values(STATE.teams.teams)
      .filter(t => {
        if (filterActive === "active") return t.is_active;
        if (filterActive === "retired") return !t.is_active;
        return true;
      })
      .sort((a, b) => (a.owner_name || "").localeCompare(b.owner_name || ""));
    for (const t of teamOptions) {
      const status = t.is_active ? "" : " [retired]";
      const label = `${t.owner_name}${t.current_team_name ? " (" + t.current_team_name + ")" : ""}${status}`;
      hTeam.insertAdjacentHTML("beforeend",
        `<option value="${t.owner_name}"${t.owner_name === currentVal ? " selected" : ""}>${label}</option>`);
    }
  }

  function wireListeners() {
    document.getElementById("rdh-tabs").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-tab]");
      if (!btn) return;
      document.querySelectorAll("#rdh-tabs button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.dataset.tab;
      document.querySelectorAll(".rdh-section").forEach(s => {
        s.classList.toggle("active", s.dataset.section === tab);
      });
      STATE.activeTab = tab;
    });

    // Historical filters
    const hBindings = [["h-season", "season"], ["h-team", "team"], ["h-round", "round"],
      ["h-slot", "slot"], ["h-pos", "pos"], ["h-pg", "pg"], ["h-tier", "tier"],
      ["h-active", "active"]];
    for (const [id, key] of hBindings) {
      document.getElementById(id).addEventListener("change", (e) => {
        STATE.h_filters[key] = e.target.value;
        // Cascading: pg change may invalidate current pos/tier; pos may invalidate tier.
        if (key === "pg") {
          // Clear pos if it's not in the new group, clear tier if not present
          const newPg = e.target.value;
          if (newPg && STATE.h_filters.pos && !PG_POSITIONS[newPg].includes(STATE.h_filters.pos)) {
            STATE.h_filters.pos = "";
          }
        }
        if (key === "active") rebuildHistoryOwnerDropdown();
        // Rebuild the dynamic dropdowns after any change (except tier, which is leaf)
        if (key !== "tier") rebuildHistoryDynamicFilters();
        renderHistory();
      });
    }
    const hMetricEl = document.getElementById("h-metric");
    hMetricEl.value = STATE.h_metric;
    hMetricEl.addEventListener("change", (e) => {
      STATE.h_metric = e.target.value; renderHistory();
    });

    // "Show all columns" toggle — restores desktop-style table on mobile.
    const showAllBtn = document.getElementById("h-show-all-btn");
    const hTable = document.getElementById("h-table");
    const SHOW_ALL_KEY = "ups_dh_h_show_all_cols";
    function applyShowAll(on) {
      hTable.classList.toggle("show-all", !!on);
      showAllBtn.setAttribute("aria-pressed", on ? "true" : "false");
      showAllBtn.textContent = on ? "Compact view" : "Show all columns";
    }
    try { applyShowAll(localStorage.getItem(SHOW_ALL_KEY) === "1"); } catch (e) { applyShowAll(false); }
    showAllBtn.addEventListener("click", () => {
      const next = !hTable.classList.contains("show-all");
      applyShowAll(next);
      try { localStorage.setItem(SHOW_ALL_KEY, next ? "1" : "0"); } catch (e) {}
    });

    document.getElementById("h-search").addEventListener("input", (e) => {
      STATE.h_filters.search = e.target.value; renderHistory();
    });
    document.querySelectorAll("#h-table th[data-sort]").forEach(th => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (STATE.h_sort === key) STATE.h_sort_dir = -STATE.h_sort_dir;
        else { STATE.h_sort = key; STATE.h_sort_dir = 1; }
        renderHistory();
      });
    });

    // Team tendencies filters
    const tBindings = [["t-active", "active"], ["t-season", "season"], ["t-round", "round"],
      ["t-slot", "slot"], ["t-pg", "pg"], ["t-pos", "pos"]];
    for (const [id, key] of tBindings) {
      document.getElementById(id).addEventListener("change", (e) => {
        STATE.t_filters[key] = e.target.value;
        if (key === "pg") {
          const newPg = e.target.value;
          if (newPg && STATE.t_filters.pos && !PG_POSITIONS[newPg].includes(STATE.t_filters.pos)) {
            STATE.t_filters.pos = "";
          }
        }
        rebuildTeamsDynamicFilters();
        renderTeams();
      });
    }

    // Prospect controls
    for (const id of ["prospect-sort", "prospect-adp-source", "prospect-pos", "prospect-pg",
                      "prospect-nfl", "prospect-owner", "prospect-status"]) {
      const el = document.getElementById(id);
      if (el) el.addEventListener("change", renderProspects);
    }
    const ps = document.getElementById("prospect-search");
    if (ps) ps.addEventListener("input", renderProspects);

    // Draft-day trades filter
    // dd-season exists but tab is Under Construction; listener is harmless
    const ddSeasonEl = document.getElementById("dd-season");
    if (ddSeasonEl) ddSeasonEl.addEventListener("change", renderDayTrades);

    // Future Draft Picks filters
    for (const [id, key] of [["fp-year","year"],["fp-owner","owner"],["fp-original","original"],["fp-round","round"]]) {
      const el = document.getElementById(id);
      if (el) el.addEventListener("change", e => { FP_STATE[key] = e.target.value; renderFuturePicks(); });
    }

    // R6 countdown controls
    document.getElementById("r6-simulate-btn").addEventListener("click", () => r6Start(true));
    document.getElementById("r6-start-btn").addEventListener("click", () => {
      if (!STATE.me || !STATE.me.is_commish) {
        alert("Only the commissioner can start the official drawing.");
        return;
      }
      if (confirm("Start OFFICIAL R6 draft order selection? This is binding.")) r6Start(false);
    });
    document.getElementById("r6-reset-btn").addEventListener("click", r6Reset);
    // Enable Official button once we know the user is commish
    _refreshCommishGating();
    // Start countdown timer to event
    _startR6EventCountdown();

    // Modal close on overlay click
    document.getElementById("rdh-modal-overlay").addEventListener("click", (e) => {
      if (e.target.id === "rdh-modal-overlay") closeModal();
    });
  }

  // When the hub runs inside an iframe sized to content (the production
  // embed), position:fixed modals center in the iframe's coordinate space
  // — which is ~800px down a 1600px iframe, nowhere near where the user
  // clicked. Track the last click's Y and anchor the modal near it.
  let _lastClickY = null;
  document.addEventListener("click", (e) => {
    if (e && typeof e.pageY === "number") _lastClickY = e.pageY;
    else if (e && typeof e.clientY === "number") _lastClickY = e.clientY + (window.scrollY || 0);
  }, true);

  function openModal(html) {
    const modal = document.getElementById("rdh-modal");
    modal.innerHTML = html;
    document.getElementById("rdh-modal-overlay").classList.add("open");
    if (_lastClickY != null) {
      modal.style.position = "absolute";
      modal.style.top = Math.max(16, _lastClickY - 60) + "px";
      modal.style.left = "50%";
      modal.style.transform = "translateX(-50%)";
      modal.style.margin = "0";
    } else {
      modal.style.position = "";
      modal.style.top = "";
      modal.style.left = "";
      modal.style.transform = "";
      modal.style.margin = "";
    }
  }
  function closeModal() {
    const modal = document.getElementById("rdh-modal");
    modal.style.position = "";
    modal.style.top = "";
    modal.style.left = "";
    modal.style.transform = "";
    modal.style.margin = "";
    document.getElementById("rdh-modal-overlay").classList.remove("open");
    _lastClickY = null;
  }

  // ══════════════════════════════════════════════════════════════════════
  // LIVE DRAFT
  // ══════════════════════════════════════════════════════════════════════
  function renderLive() {
    // Live Draft tab is currently Under Construction — bail if DOM elements don't exist.
    const board = document.getElementById("live-board");
    if (!board) return;
    const live = STATE.live;
    board.innerHTML = "";
    const orderMap = {};
    for (const p of live.draft_order || []) orderMap[`${p.round}.${p.pick}`] = p;
    const picksMap = {};
    for (const p of live.picks_made || []) picksMap[`${p.round}.${p.pick}`] = p;
    const activeKey = live.active_pick ? `${live.active_pick.round}.${live.active_pick.pick}` : null;
    const franchises = live.franchises || {};
    const bands = (STATE.tiers && STATE.tiers.bands) || {};
    for (let round = 1; round <= 6; round++) {
      for (let slot = 1; slot <= 12; slot++) {
        const key = `${round}.${slot}`;
        const pick = picksMap[key];
        const queued = orderMap[key];
        const fid = pick ? pick.franchise_id : (queued ? queued.owned_by_franchise_id : null);
        const team = fid ? (franchises[fid] || fid) : "—";
        const name = pick ? (playerLookup(pick.player_id) || `Player #${pick.player_id}`) : "";
        const cls = "pick-cell" + (pick ? " made" : "") + (key === activeKey ? " on-clock" : "");
        // Per-slot tier stats — prefer exact slot (e.g. "1.07"), fallback to band
        const slotKey = `${round}.${String(slot).padStart(2, "0")}`;
        let stats = bands[slotKey] && bands[slotKey].combined;
        let source = "slot";
        if (!stats) {
          // Find the band containing this slot
          for (const bk of Object.keys(bands)) {
            if (bk.startsWith(`${round}.`) && bk.includes("-")) {
              const [lo, hi] = bk.slice(2).split("-").map(n => parseInt(n, 10));
              if (lo <= slot && slot <= hi) { stats = bands[bk].combined; source = "band"; break; }
            }
          }
        }
        const chips = stats ? `
          <div class="pk-chips" style="display:flex; gap:2px; margin-top:2px; font-size:9px;">
            <span style="background:rgba(16,185,129,0.18); color:var(--smash); padding:0 3px; border-radius:2px;"
                  title="${stats.smash}/${stats.n} historical picks in this ${source} hit Smash tier">
              S ${(stats.smash_pct * 100).toFixed(0)}%
            </span>
            <span style="background:rgba(239,68,68,0.18); color:var(--bust); padding:0 3px; border-radius:2px;"
                  title="${stats.bust}/${stats.n} historical picks in this ${source} were Bust tier">
              B ${(stats.bust_pct * 100).toFixed(0)}%
            </span>
          </div>` : "";
        const div = document.createElement("div");
        div.className = cls;
        div.innerHTML = `
          <div class="pk-slot">${round}.${String(slot).padStart(2, "0")}</div>
          <div class="pk-name">${name || "<em>on deck</em>"}</div>
          <div class="pk-team">${team}</div>
          ${chips}
        `;
        board.appendChild(div);
      }
    }
    const madeCount = live.picks_made ? live.picks_made.length : 0;
    const queuedCount = live.draft_order ? live.draft_order.length : 0;
    document.getElementById("live-board-summary").textContent =
      `${madeCount} picks made · ${queuedCount} on the clock · snapshot ${new Date(live.meta.generated_at_utc).toLocaleString()}`;

    renderProspects();
    renderSalarySchedule();
    renderOnClockPanel();
  }

  // Build a pid → pick info map from already-made picks in the live draft
  function _draftedPickIndex() {
    const out = {};
    const picks = (STATE.live && STATE.live.picks_made) || [];
    const franchises = (STATE.live && STATE.live.franchises) || {};
    for (const p of picks) {
      out[String(p.player_id)] = {
        round: p.round, pick: p.pick, fid: p.franchise_id,
        franchise_name: franchises[p.franchise_id] || p.franchise_id,
      };
    }
    return out;
  }

  function _hydrateProspectFiltersDynamic() {
    // NFL Teams + Drafted-by owners, dynamically populated from the current prospect pool
    const prospects = STATE.prospects.prospects || [];
    const drafted = _draftedPickIndex();
    const nflEl = document.getElementById("prospect-nfl");
    if (nflEl && !nflEl.dataset.hydrated) {
      const nfls = [...new Set(prospects.map(p => p.nfl_team).filter(Boolean))].sort();
      for (const t of nfls) nflEl.insertAdjacentHTML("beforeend", `<option value="${t}">${t}</option>`);
      nflEl.dataset.hydrated = "1";
    }
    const ownerEl = document.getElementById("prospect-owner");
    if (ownerEl && !ownerEl.dataset.hydrated) {
      // Owner list pulled from franchises in the live state
      const franchises = (STATE.live && STATE.live.franchises) || {};
      const uniq = [...new Set(Object.values(franchises))].sort();
      for (const o of uniq) ownerEl.insertAdjacentHTML("beforeend", `<option value="${o}">${o}</option>`);
      ownerEl.dataset.hydrated = "1";
    }
    // Position Group dropdown (populate dynamically if not done)
    const pgEl = document.getElementById("prospect-pg");
    if (pgEl && !pgEl.dataset.hydrated) {
      const pgs = new Set(prospects.map(p => p.pos_group).filter(Boolean));
      for (const g of ["offense", "defense", "special"]) {
        if (pgs.has(g)) pgEl.insertAdjacentHTML("beforeend", `<option value="${g}">${PG_LABELS[g]}</option>`);
      }
      pgEl.dataset.hydrated = "1";
    }
    // Position dropdown — cascade based on pg
    const posEl = document.getElementById("prospect-pos");
    if (posEl) {
      const selectedPg = pgEl ? pgEl.value : "";
      let posPool = prospects;
      if (selectedPg) posPool = posPool.filter(p => p.pos_group === selectedPg);
      const posPresent = new Set(posPool.map(p => POS_COMBINED(p.position)).filter(Boolean));
      const cur = posEl.value;
      posEl.innerHTML = '<option value="">All</option>';
      for (const group of ["offense", "defense", "special"]) {
        if (selectedPg && selectedPg !== group) continue;
        const groupPositions = PG_POSITIONS[group].filter(p => posPresent.has(p));
        if (!groupPositions.length) continue;
        if (!selectedPg) {
          const og = document.createElement("optgroup");
          og.label = PG_LABELS[group];
          for (const p of groupPositions) {
            const opt = document.createElement("option");
            opt.value = p; opt.textContent = p;
            if (p === cur) opt.selected = true;
            og.appendChild(opt);
          }
          posEl.appendChild(og);
        } else {
          for (const p of groupPositions) {
            const opt = document.createElement("option");
            opt.value = p; opt.textContent = p;
            if (p === cur) opt.selected = true;
            posEl.appendChild(opt);
          }
        }
      }
    }
  }

  function renderProspects() {
    _hydrateProspectFiltersDynamic();
    const adpSourceEl = document.getElementById("prospect-adp-source");
    const adpSource = adpSourceEl ? adpSourceEl.value : "avg";
    const posFilter = document.getElementById("prospect-pos").value;
    const pgFilter = document.getElementById("prospect-pg").value;
    const nflFilter = document.getElementById("prospect-nfl") ? document.getElementById("prospect-nfl").value : "";
    const ownerFilter = document.getElementById("prospect-owner") ? document.getElementById("prospect-owner").value : "";
    const statusFilter = document.getElementById("prospect-status") ? document.getElementById("prospect-status").value : "";
    const searchEl = document.getElementById("prospect-search");
    const search = searchEl ? (searchEl.value || "").toLowerCase() : "";
    const list = document.getElementById("prospect-list");
    const drafted = _draftedPickIndex();

    let rows = STATE.prospects.prospects.slice();
    if (posFilter) rows = rows.filter(p => POS_COMBINED(p.position) === posFilter);
    if (pgFilter) rows = rows.filter(p => p.pos_group === pgFilter);
    if (nflFilter) rows = rows.filter(p => p.nfl_team === nflFilter);
    if (ownerFilter) rows = rows.filter(p => {
      const d = drafted[String(p.player_id)];
      return d && d.franchise_name === ownerFilter;
    });
    if (statusFilter === "available") rows = rows.filter(p => !drafted[String(p.player_id)]);
    else if (statusFilter === "drafted") rows = rows.filter(p => drafted[String(p.player_id)]);
    if (search) rows = rows.filter(p => (p.name || "").toLowerCase().includes(search));

    // Resolve ADP-source value per prospect (falls back to legacy field if no sources block)
    const adpOf = (p) => {
      if (p.adp_sources && p.adp_sources[adpSource] != null) return p.adp_sources[adpSource];
      if (adpSource === "avg" && p.rookie_adp != null) return p.rookie_adp;
      return null;
    };
    // KTC SF Value — higher is better, so invert for consistent sort
    const sortIsDesc = adpSource === "ktc_sf";
    rows.sort((a, b) => {
      const av = adpOf(a); const bv = adpOf(b);
      if (av == null) return 1;
      if (bv == null) return -1;
      return sortIsDesc ? bv - av : av - bv;
    });
    list.innerHTML = rows.slice(0, 150).map(p => {
      const d = drafted[String(p.player_id)];
      const draftedTag = d
        ? `<div class="small" style="color:var(--accent); font-size:10px;">Pick ${d.round}.${String(d.pick).padStart(2,"0")} · ${d.franchise_name}</div>`
        : "";
      // NFL draft pick if available
      const nflPickTag = p.nfl_draft_pick
        ? `<span class="small" style="color:var(--muted); font-size:10px; margin-left:6px;">NFL ${p.nfl_draft_pick}</span>`
        : "";
      return `
        <div class="prospect-row" data-pid="${p.player_id}"
             style="display:flex; justify-content:space-between; align-items:center; padding:5px 6px; border-bottom:1px solid var(--border); font-size:12px; ${d ? 'opacity:0.55;' : ''}">
          <div style="flex:1; cursor:pointer;" class="prospect-select">
            <strong>${p.name}</strong>${nflPickTag}
            <span class="small" style="color:var(--muted); margin-left:4px">${POS_COMBINED(p.position) || "-"}${p.nfl_team ? " · " + p.nfl_team : ""}</span>
            ${draftedTag}
          </div>
          <button class="prospect-profile-btn" data-pid="${p.player_id}"
                  style="background:transparent; border:0; color:var(--muted); font-size:14px; cursor:pointer; margin: 0 6px;"
                  title="View profile">ⓘ</button>
          <div class="num" style="color:var(--muted); font-size:11px; width: 78px; text-align: right;">
            ${adpSource === "ktc_sf" ? "KTC " : "ADP "}${adpOf(p) != null ? (adpSource === "ktc_sf" ? Math.round(adpOf(p)) : adpOf(p).toFixed(1)) : "-"}
          </div>
        </div>
      `;
    }).join("");
    list.querySelectorAll(".prospect-select").forEach(el => {
      el.addEventListener("click", () => {
        const pid = el.closest(".prospect-row").getAttribute("data-pid");
        const p = STATE.prospects.prospects.find(x => x.player_id === pid);
        STATE.selectedProspect = p;
        renderOnClockPanel();
      });
    });
    list.querySelectorAll(".prospect-profile-btn").forEach(el => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        showPlayerProfileCard(el.dataset.pid);
      });
    });
  }

  function renderOnClockPanel() {
    const panel = document.getElementById("on-clock-panel");
    const active = STATE.live.active_pick;
    const franchises = STATE.live.franchises || {};
    const prospect = STATE.selectedProspect;
    if (!active) {
      panel.innerHTML = `<p class="loading">Draft complete or not live.</p>`;
      return;
    }
    const slotLabel = `${active.round}.${String(active.pick).padStart(2, "0")}`;
    const fid = active.franchise_id || active.owned_by_franchise_id;
    const fname = franchises[fid] || fid || "—";
    // Prefer the exact SLOT when we have per-slot stats (rounds 1-3); fall back to band (rounds 4-6).
    const slotNum = active.pick || active.slot;
    const slotKey = `${active.round}.${String(slotNum).padStart(2, "0")}`;
    const band = slotNum <= 4 ? "01-04" : slotNum <= 8 ? "05-08" : "09-12";
    const bandKey = `${active.round}.${band}`;
    const slotTiers = STATE.tiers.bands[slotKey]?.combined;
    const bandTiers = STATE.tiers.bands[bandKey]?.combined;
    const tierStats = slotTiers || bandTiers;
    const scopeLabel = slotTiers ? `exact slot ${slotKey}` : `band ${bandKey}`;
    const tierHtml = tierStats ? `
      <div class="tier-bar">
        <div class="b-smash" style="flex-basis: ${(tierStats.smash_pct * 100).toFixed(0)}%"></div>
        <div class="b-hit" style="flex-basis: ${(tierStats.hit_pct * 100).toFixed(0)}%"></div>
        <div class="b-contrib" style="flex-basis: ${(tierStats.contrib_pct * 100).toFixed(0)}%"></div>
        <div class="b-bust" style="flex-basis: ${(tierStats.bust_pct * 100).toFixed(0)}%"></div>
      </div>
      <div class="small" style="color: var(--muted); margin-bottom: 10px;">
        Historical ${scopeLabel} (N=${tierStats.n}):
        <span class="tier Smash tier-click" data-tier="Smash">Smash</span> ${(tierStats.smash_pct * 100).toFixed(0)}% ·
        <span class="tier Hit tier-click" data-tier="Hit">Hit</span> ${(tierStats.hit_pct * 100).toFixed(0)}% ·
        <span class="tier Contrib tier-click" data-tier="Contrib">Contrib</span> ${(tierStats.contrib_pct * 100).toFixed(0)}% ·
        <span class="tier Bust tier-click" data-tier="Bust">Bust</span> ${(tierStats.bust_pct * 100).toFixed(0)}%
      </div>
    ` : "";
    const prospectHtml = prospect ? `
      <div style="background: var(--panel-alt); padding: 10px; border-radius: 4px; margin-bottom: 10px;">
        <a href="#" class="player-link" id="otc-profile" data-pid="${prospect.player_id}"><strong>${prospect.name}</strong></a>
        <span class="small">${prospect.position}${prospect.nfl_team ? " · " + prospect.nfl_team : ""}</span>
        <div class="small" style="color: var(--muted); margin-top: 4px;">
          ADP ${prospect.rookie_adp != null ? prospect.rookie_adp.toFixed(1) : "-"}${prospect.rookie_adp_rank ? " (#" + prospect.rookie_adp_rank + ")" : ""}
        </div>
      </div>
    ` : `<div class="small" style="color: var(--muted); margin-bottom: 10px;">Click a prospect to queue up a pick.</div>`;
    panel.innerHTML = `
      <div style="font-size: 20px; font-weight: 600;">${slotLabel}</div>
      <div style="color: var(--muted); margin-bottom: 10px;">${fname} on the clock</div>
      ${tierHtml}
      ${prospectHtml}
      <button class="btn" id="submit-pick-btn" ${prospect ? "" : "disabled style='opacity:0.5; cursor: not-allowed;'"}>
        Draft Player
      </button>
      <button class="btn secondary" id="propose-trade-btn" style="margin-left: 6px;">Propose Trade</button>
    `;
    panel.querySelectorAll(".tier-click").forEach(el => {
      el.addEventListener("click", () => showTierPopup(el.dataset.tier));
    });
    const submitBtn = document.getElementById("submit-pick-btn");
    if (submitBtn && prospect) submitBtn.addEventListener("click", () => openPickConfirmModal(active, prospect));
    document.getElementById("propose-trade-btn").addEventListener("click", openTradeModal);
    const otcProfile = document.getElementById("otc-profile");
    if (otcProfile) otcProfile.addEventListener("click", (e) => {
      e.preventDefault();
      showPlayerProfileCard(otcProfile.dataset.pid);
    });
  }

  function renderSalarySchedule() {
    const list = document.getElementById("salary-schedule");
    const schedule = STATE.live.draft_salaries || [];
    list.innerHTML = `<table class="rdh-table"><thead><tr><th>Slot</th><th class="num">AAV</th><th class="num">3yr TCV</th></tr></thead><tbody>${
      schedule.map(s =>
        `<tr><td>${s.pick_label}</td><td class="num">$${s.rookie_aav.toLocaleString()}</td><td class="num">$${s.rookie_tcv_3yr.toLocaleString()}</td></tr>`
      ).join("")
    }</tbody></table>`;
  }

  let _playerCache = null;
  function playerLookup(pid) {
    if (!_playerCache) {
      _playerCache = {};
      for (const p of STATE.history.picks) _playerCache[p.player_id] = p.player_name;
      for (const p of STATE.prospects.prospects) if (p.player_id) _playerCache[p.player_id] = p.name;
    }
    return _playerCache[String(pid)] || null;
  }

  // ══════════════════════════════════════════════════════════════════════
  // PLAYER PROFILE CARD (MFL playerProfile API via bridge proxy)
  // ══════════════════════════════════════════════════════════════════════
  const _profileCache = new Map();

  async function showPlayerProfileCard(pid) {
    if (!pid) return;
    const hist = STATE.history.picks.find(p => p.player_id === String(pid)) || {};
    const prosp = STATE.prospects.prospects.find(p => p.player_id === String(pid)) || {};
    const name = hist.player_name || prosp.name || `Player #${pid}`;
    const pos = POS_COMBINED(hist.position || prosp.position || "");
    const nflTeam = prosp.nfl_team || "";
    openModal(`
      <h3>${name} <span class="small" style="color: var(--muted); font-weight: 400">${pos}${nflTeam ? " · " + nflTeam : ""}</span></h3>
      <div id="profile-body"><p class="loading">Fetching profile from MFL…</p></div>
      <div class="actions"><button class="btn secondary" onclick="document.getElementById('rdh-modal-overlay').classList.remove('open')">Close</button></div>
    `);
    // Live MFL profile enrichment comes from /api/player-bundle, which
    // only resolves to a real endpoint when the hub is mounted in MFL's
    // page context. Inside the production iframe (srcdoc with jsDelivr
    // base), that request returns jsDelivr HTML/404 and JSON.parse throws.
    // Treat any failure as "no live data" and still render the historical
    // slice instead of replacing the whole modal with a scary SyntaxError.
    let bundle = null;
    let bundleError = null;
    if (_profileCache.has(pid)) {
      bundle = _profileCache.get(pid);
    } else {
      try {
        // Route through the Cloudflare Worker when the loader injects an
        // absolute API base (production iframe). Otherwise the relative path
        // hits whatever served the hub (local bridge in dev).
        const apiBase = (typeof window.UPS_DRAFT_HUB_API_BASE === "string" && window.UPS_DRAFT_HUB_API_BASE) || "";
        const leagueId = (typeof window.UPS_DRAFT_HUB_LEAGUE_ID === "string" && window.UPS_DRAFT_HUB_LEAGUE_ID) || "";
        const year = (typeof window.UPS_DRAFT_HUB_YEAR === "string" && window.UPS_DRAFT_HUB_YEAR) || "";
        const qs = `pid=${encodeURIComponent(pid)}`
          + (leagueId ? `&L=${encodeURIComponent(leagueId)}` : "")
          + (year ? `&YEAR=${encodeURIComponent(year)}` : "");
        const r = await fetch(`${apiBase}/api/player-bundle?${qs}`);
        if (!r.ok) throw new Error("HTTP " + r.status);
        bundle = await r.json();
        _profileCache.set(pid, bundle);
      } catch (e) {
        bundleError = e;
        bundle = {};
        _profileCache.set(pid, bundle);
      }
    }
    const body = document.getElementById("profile-body");
    if (!body) return;
    const bundleErrorBanner = bundleError
      ? `<div class="small" style="color:var(--muted); margin-bottom:8px; padding:6px 8px; background:var(--panel-alt); border-radius:4px;">Live MFL profile data unavailable in this view — showing historical data only.</div>`
      : "";
    const pp = bundle?.profile?.playerProfile?.player || bundle?.profile?.player || {};
    const cr = bundle?.current_roster || {};
    const inj = bundle?.injury || {};
    const add = bundle?.last_add || {};
    const career = bundle?.career_summary || [];
    const trades = bundle?.trade_history || [];

    // Prefer MFL profile-returned icon; fall back to the stable photo archive URL
    // (same pattern we use in the historical-row headshots).
    const photoUrl = pp.icon_url
      || (pid ? `https://www48.myfantasyleague.com/player_photos_2014/${pid}_thumb.jpg` : "");
    // Most-recent contract from D1 contract_history (used for critical-
    // salary strip on Bio tab). contract_history is ordered season DESC.
    const ch = Array.isArray(bundle.contract_history) ? bundle.contract_history : [];
    const currentContract = ch[0] || null;
    const leverageCoefs = bundle.leverage_coefs || {};

    // ── Bio tab ──────────────────────────────────────────────────────
    const bioHtml = `
      <div class="profile-bio">
        ${photoUrl ? `<img src="${photoUrl}" alt="${escapeHtml(name)}" class="profile-photo" onerror="this.replaceWith(Object.assign(document.createElement('div'), {className: 'profile-photo-placeholder'}))">` : '<div class="profile-photo-placeholder"></div>'}
        <div class="profile-bio-text">
          ${pp.height ? `<div><span class="lbl">Height</span>${escapeHtml(pp.height)}</div>` : ""}
          ${pp.weight ? `<div><span class="lbl">Weight</span>${escapeHtml(pp.weight)}</div>` : ""}
          ${pp.college ? `<div><span class="lbl">College</span>${escapeHtml(pp.college)}</div>` : ""}
          ${pp.birthdate ? `<div><span class="lbl">Born</span>${escapeHtml(formatMflDate(pp.birthdate))}</div>` : ""}
          ${pp.draft_year ? `<div><span class="lbl">NFL Draft</span>${escapeHtml(pp.draft_year)}${pp.draft_team ? " · " + escapeHtml(pp.draft_team) : ""}${pp.draft_round ? " · R" + escapeHtml(pp.draft_round) + ", P" + escapeHtml(pp.draft_pick || "?") : ""}</div>` : ""}
          ${pp.jersey ? `<div><span class="lbl">Jersey</span>#${escapeHtml(pp.jersey)}</div>` : ""}
        </div>
      </div>

      ${currentContract ? `
      <div class="upm-salary-strip">
        <div class="upm-salary-card"><span class="lbl">Years Remaining</span><span class="val">${currentContract.contract_length ? currentContract.contract_length - (currentContract.contract_year || 1) + 1 : "—"}</span></div>
        <div class="upm-salary-card"><span class="lbl">AAV</span><span class="val">${currentContract.aav ? "$" + Number(currentContract.aav).toLocaleString() : "—"}</span></div>
        <div class="upm-salary-card"><span class="lbl">TCV</span><span class="val">${currentContract.tcv ? "$" + Number(currentContract.tcv).toLocaleString() : "—"}</span></div>
        <div class="upm-salary-card"><span class="lbl">Contract</span><span class="val" style="font-size:13px;">${escapeHtml(currentContract.contract_status || (currentContract.extension_flag ? "Extended" : "Active"))}</span></div>
      </div>` : ""}

      <div class="profile-block">
        <h4>League Status</h4>
        <div class="profile-kv">
          ${bundle.is_free_agent
            ? `<div><span class="lbl">Status</span><span style="color: var(--warn); font-weight:600">Free Agent</span></div>`
            : bundle.is_not_rostered
            ? `<div><span class="lbl">Status</span><span style="color: var(--muted); font-weight:600">Not on any roster</span> <span class="small" style="color:var(--muted)">(retired / out of league)</span></div>`
            : cr.team_name
              ? `<div><span class="lbl">Owner</span>${escapeHtml(cr.team_name)}</div>${cr.status ? `<div><span class="lbl">Roster</span>${escapeHtml(cr.status)}</div>` : ""}`
              : `<div><span class="lbl">Status</span><span class="small" style="color:var(--muted)">Unknown</span></div>`}
          ${inj.status && !bundle.is_free_agent && !bundle.is_not_rostered ? `<div><span class="lbl">Injury</span><span style="color: var(--warn)">${escapeHtml(inj.status)}${inj.details ? " — " + escapeHtml(inj.details) : ""}</span></div>` : ""}
          ${!bundle.is_free_agent && !bundle.is_not_rostered && add.datetime_et ? `<div><span class="lbl">Acquired</span>${escapeHtml(add.method || "")} ${add.salary ? "$" + Number(add.salary).toLocaleString() : ""} · ${escapeHtml(add.datetime_et.slice(0, 10))} by ${escapeHtml(add.franchise_name || "")}</div>` : ""}
          <div><span class="lbl">Hub Tier</span><span class="tier ${tierSlug(hist.tier)}">${hist.tier || 'Unclassified'}</span>
            ${hist.best_ep_rate != null ? ` · Best E+P ${(hist.best_ep_rate * 100).toFixed(0)}%` : ""}</div>
        </div>
      </div>

      ${ch.length ? (() => {
        // Contract history — owner lineage + deal terms per season.
        // No per-year salary column (MFL-derived, unreliable); AAV is the trustworthy figure.
        const fmt$ = (v) => (v == null || v === 0) ? "—" : "$" + Number(v).toLocaleString();
        const rowsHtml = ch.map((c) => {
          const extBadge = c.extension_flag ? ` <span class="small" style="color:var(--accent); font-weight:600;">EXT</span>` : "";
          return `<tr>
            <td>${c.season}</td>
            <td>${escapeHtml(c.team_name || "")}${extBadge}</td>
            <td class="num">${c.contract_length || "—"}</td>
            <td>${c.contract_year ? "Y" + c.contract_year : "—"}</td>
            <td class="num">${fmt$(c.aav)}</td>
          </tr>`;
        }).join("");
        return `
        <div class="profile-block">
          <h4>Contract History <span class="small" style="color:var(--muted); font-weight:400">(${ch.length} season${ch.length === 1 ? "" : "s"})</span></h4>
          <table class="rdh-table" style="margin-top:6px;">
            <thead><tr>
              <th>Yr</th><th>Team</th>
              <th class="num">Len</th><th>Yr#</th><th class="num">AAV</th>
            </tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>`;
      })() : ""}
    `;

    // ── Stats tab ────────────────────────────────────────────────────
    // Columns (per Keith 2026-04-22, rev2):
    //   Yr | G | MFL Starts | Pts | Pts Rk | PPG | PPG Rk |
    //   Elite% | Plus% | Dud% | APW | APW Rk | APW/G | APW/G Rk
    //
    // "APW" = Adjusted All-Play Wins = win_chunks × positional leverage β.
    //   The quick read: how many All-Play wins this player would be
    //   responsible for if every other lineup slot turned in median
    //   output. Used to be labeled "WC·β" — renamed for clarity.
    //
    // Rank columns:
    //   - Pts Rk / PPG Rk from src_pointssummary (total-points and PPG
    //     rank within pos_group that season).
    //   - APW Rk from the wc_ranked CTE (rank by SUM(win_chunks) within
    //     pos_group — β is constant inside a pos_group so this IS the
    //     APW rank).
    //   - APW/G Rk from the same CTE (rank by win_chunks / games_played).
    const statsHtml = career.length ? (() => {
      const rows = career.slice(0, 20);
      const fmtRank = (r) => (r == null || r <= 0) ? "—" : `#${r}`;
      // Career totals — weighted by games_played for rates
      const tot = rows.reduce((a, c) => {
        a.g += (c.games_played || 0);
        a.starts += (c.mfl_starts || 0);
        a.pts += (c.season_points || 0);
        const wcβ = (leverageCoefs[c.pos_group] || 0);
        a.wcn += (c.win_chunks || 0) * wcβ;
        if (c.ep_pct != null) { a.ep_den += c.games_played; }
        if (c.dud_pct != null) { a.dud_num += c.dud_pct * c.games_played; }
        if (c.elite_pct != null) a.el_num += c.elite_pct * c.games_played;
        if (c.plus_pct != null) a.pl_num += c.plus_pct * c.games_played;
        return a;
      }, { g: 0, starts: 0, pts: 0, wcn: 0, ep_den: 0, dud_num: 0, el_num: 0, pl_num: 0 });
      const careerPPG = tot.g ? tot.pts / tot.g : 0;
      const careerEl = tot.ep_den ? tot.el_num / tot.ep_den : 0;
      const careerPl = tot.ep_den ? tot.pl_num / tot.ep_den : 0;
      const careerDud = tot.ep_den ? tot.dud_num / tot.ep_den : 0;
      return `
      <div class="upm-window-controls">
        <label>Window
          <select id="profile-window-select">
            <option value="season">Current season</option>
            <option value="4">Last 4 weeks</option>
            <option value="6">Last 6 weeks</option>
            <option value="8">Last 8 weeks</option>
          </select>
        </label>
        <span class="small" style="color:var(--muted)">Summarizes the recent weekly window; career table below is full history.</span>
      </div>
      <div id="profile-window-summary" class="upm-window-summary" hidden></div>
      <div class="profile-block">
        <h4>Career Summary (by MFL season)</h4>
        <table class="rdh-table">
          <thead><tr>
            <th>Yr</th>
            <th class="num">G</th>
            <th class="num" title="Weeks in an MFL starting lineup">MFL Starts</th>
            <th class="num">Pts</th>
            <th class="num" title="Positional rank by total points that season">Pts Rk</th>
            <th class="num">PPG</th>
            <th class="num" title="Positional rank by PPG that season">PPG Rk</th>
            <th class="num" title="Elite weeks (z ≥ 1.0) %">Elite%</th>
            <th class="num" title="Plus weeks (0.25 ≤ z &lt; 1.0) %">Plus%</th>
            <th class="num" title="Dud weeks (z &lt; −0.5) %">Dud%</th>
            <th class="num" title="Adjusted All-Play Wins: how many All-Play wins this player would be responsible for if every other lineup slot turned in median output. win_chunks × positional leverage β (QB≈0.88, WR≈0.82, DB≈0.39, LB≈0.38).">APW</th>
            <th class="num" title="Positional rank by APW that season">APW Rk</th>
            <th class="num" title="APW divided by games played — per-game contribution">APW/G</th>
            <th class="num" title="Positional rank by APW per game that season">APW/G Rk</th>
          </tr></thead>
          <tbody>${rows.map(c => {
            const wcβ = leverageCoefs[c.pos_group] || 0;
            const apw = (c.win_chunks || 0) * wcβ;
            const games = Math.max(1, c.games_played || 0);
            const apwPerG = apw / games;
            return `
            <tr>
              <td>${c.season}</td>
              <td class="num">${c.games_played || 0}</td>
              <td class="num">${c.mfl_starts || 0}</td>
              <td class="num">${c.season_points != null ? c.season_points.toFixed(0) : "—"}</td>
              <td class="num" style="color:var(--muted)">${fmtRank(c.pos_rank)}</td>
              <td class="num">${c.avg_ppg != null ? c.avg_ppg.toFixed(1) : "—"}</td>
              <td class="num" style="color:var(--muted)">${fmtRank(c.pos_ppg_rank)}</td>
              <td class="num" style="color:var(--smash)">${c.elite_pct != null ? c.elite_pct.toFixed(0) + "%" : "—"}</td>
              <td class="num" style="color:var(--hit)">${c.plus_pct != null ? c.plus_pct.toFixed(0) + "%" : "—"}</td>
              <td class="num" style="color:var(--bust)">${c.dud_pct != null ? c.dud_pct.toFixed(0) + "%" : "—"}</td>
              <td class="num"><strong>${apw.toFixed(1)}</strong></td>
              <td class="num" style="color:var(--muted)">${fmtRank(c.wc_pos_rank)}</td>
              <td class="num">${apwPerG.toFixed(2)}</td>
              <td class="num" style="color:var(--muted)">${fmtRank(c.wc_per_game_pos_rank)}</td>
            </tr>`;
          }).join("")}
          <tr style="border-top: 2px solid var(--border); font-weight:700;">
            <td>Career</td>
            <td class="num">${tot.g}</td>
            <td class="num">${tot.starts}</td>
            <td class="num">${tot.pts.toFixed(0)}</td>
            <td class="num" style="color:var(--muted)">—</td>
            <td class="num">${careerPPG.toFixed(1)}</td>
            <td class="num" style="color:var(--muted)">—</td>
            <td class="num" style="color:var(--smash)">${careerEl.toFixed(0)}%</td>
            <td class="num" style="color:var(--hit)">${careerPl.toFixed(0)}%</td>
            <td class="num" style="color:var(--bust)">${careerDud.toFixed(0)}%</td>
            <td class="num">${tot.wcn.toFixed(1)}</td>
            <td class="num" style="color:var(--muted)">—</td>
            <td class="num">${tot.g ? (tot.wcn / tot.g).toFixed(2) : "—"}</td>
            <td class="num" style="color:var(--muted)">—</td>
          </tr>
          </tbody>
        </table>
      </div>`;
    })() : `<p class="small" style="color:var(--muted)">No career data yet — this player has no scored weeks on record.</p>`;

    // ── Raw Stats view (per-pos-group templates, Keith 2026-04-22) ──
    // Detects position from career_summary[0].pos_group (MFL) with
    // crosswalk.position fallback. Five templates:
    //   idp    — DL/LB/DB: snaps, tackles, TFL, FF, FR, sacks, PD, Int, DefTD
    //   qb     — snaps, rushing, passing (with Cmp% / Int% derived)
    //   skill  — RB/WR/TE: snaps, targets/routes/recs/yds (+ YPRR, Y/T), rushing
    //   kicker — XPM/Miss, FGM/Miss, Avg FG distance made
    //   punter — Punts, yds, Net avg, Att/G, I20
    //
    // Routes_run column stays NULL until load_pfr_advstats fetcher is
    // added — UI shows "—" for Routes and YPRR in that case.
    const rawStatsHtml = (() => {
      const totals = Array.isArray(bundle.nfl_season_totals) ? bundle.nfl_season_totals : [];
      const crosswalk = bundle.crosswalk || null;
      if (!crosswalk || !crosswalk.gsis_id) {
        return `<p class="small" style="color:var(--muted); padding:10px;">
          No NFL crosswalk for this player yet. Run
          <code>pipelines/etl/scripts/build_player_id_crosswalk.py</code>.</p>`;
      }
      if (!totals.length) {
        return `<p class="small" style="color:var(--muted); padding:10px;">
          NFL raw stats not yet loaded for <code>${escapeHtml(crosswalk.gsis_id)}</code>.
          Run the nflverse fetchers + <code>scripts/load_local_to_d1.py --only nflweekly,nflsnaps,nflredzone</code>.</p>`;
      }
      const detectPg = () => {
        const raw = String((crosswalk.position || "")).toUpperCase();
        if (raw === "P") return "punter";
        const pg = String(
          (bundle.career_summary && bundle.career_summary[0] && bundle.career_summary[0].pos_group) ||
          (bundle.nfl_weekly && bundle.nfl_weekly[0] && bundle.nfl_weekly[0].pos_group) ||
          raw
        ).toUpperCase();
        if (pg === "QB") return "qb";
        if (["RB", "WR", "TE", "FB"].includes(pg)) return "skill";
        if (pg === "PK" || pg === "K") return "kicker";
        if (["DL", "LB", "DB"].includes(pg)) return "idp";
        if (["DE","DT","NT","EDGE","OLB","ILB","MLB","CB","S","SS","FS"].includes(raw)) return "idp";
        if (raw === "K" || raw === "PK") return "kicker";
        return "skill";
      };
      const TMPL = {
        idp: { label: "IDP", cols: [
          { label: "G", key: "games" },
          { label: "Snaps", key: "def_snaps_total" },
          { label: "Snap%", compute: r => r.def_snap_rate, format: "pct0" },
          { label: "Snaps/G", compute: r => r.def_snaps_total && r.games ? r.def_snaps_total / r.games : null, format: "dec1" },
          { label: "Tkl", key: "def_tackles_total" },
          { label: "Ast", key: "def_tackles_ast" },
          { label: "TFL", key: "def_tfl" },
          { label: "FF", key: "def_ff" },
          { label: "FR", key: "def_fr" },
          { label: "Sk", key: "def_sacks", format: "dec1" },
          { label: "PD", key: "def_pass_def" },
          { label: "Int", key: "def_ints" },
          { label: "DefTD", key: "def_tds" }
        ]},
        qb: { label: "QB", cols: [
          { label: "G", key: "games" },
          { label: "Snaps", key: "off_snaps_total" },
          { label: "Snap%", compute: r => r.off_snap_rate, format: "pct0" },
          { label: "Snaps/G", compute: r => r.off_snaps_total && r.games ? r.off_snaps_total / r.games : null, format: "dec1" },
          { label: "RuAtt", key: "rush_att" },
          { label: "RuYd", key: "rush_yds" },
          { label: "RuTD", key: "rush_tds" },
          { label: "Fum", key: "rush_fumbles" },
          { label: "FumL", key: "rush_fumbles_lost" },
          { label: "Att", key: "pass_att" },
          { label: "Cmp", key: "pass_cmp" },
          { label: "Cmp%", compute: r => r.pass_att ? r.pass_cmp / r.pass_att : null, format: "pct" },
          { label: "PaYd", key: "pass_yds" },
          { label: "PaTD", key: "pass_tds" },
          { label: "Int", key: "pass_ints" },
          { label: "Int%", compute: r => r.pass_att ? r.pass_ints / r.pass_att : null, format: "pct" },
          { label: "Drops", key: "passing_drops", title: "Receiver drops on this QB's throws (PFR, 2018+)" }
        ]},
        skill: { label: "RB / WR / TE", cols: [
          { label: "G", key: "games" },
          { label: "Snaps", key: "off_snaps_total" },
          { label: "Snap%", compute: r => r.off_snap_rate, format: "pct0" },
          { label: "Snaps/G", compute: r => r.off_snaps_total && r.games ? r.off_snaps_total / r.games : null, format: "dec1" },
          { label: "Tgt", key: "targets" },
          { label: "Rec", key: "receptions" },
          { label: "RecYd", key: "rec_yds" },
          { label: "RecTD", key: "rec_tds" },
          { label: "Y/T", compute: r => r.targets ? r.rec_yds / r.targets : null, format: "dec2" },
          { label: "Drops", key: "receiving_drops", title: "Dropped passes (PFR, 2018+)" },
          { label: "BrTkl", compute: r => (r.receiving_broken_tackles || 0) + (r.rushing_broken_tackles || 0),
                            title: "Broken tackles combined — receiving + rushing (PFR, 2018+)" },
          { label: "RuAtt", key: "rush_att" },
          { label: "RuYd", key: "rush_yds" },
          { label: "RuTD", key: "rush_tds" },
          { label: "Fum", key: "rush_fumbles" },
          { label: "FumL", key: "rush_fumbles_lost" }
        ]},
        kicker: { label: "Kicker", cols: [
          { label: "G", key: "games" },
          { label: "XPM", key: "xp_made" },
          { label: "XP Miss", compute: r => (r.xp_att || 0) - (r.xp_made || 0) },
          { label: "FGM", key: "fg_made" },
          { label: "FG Miss", compute: r => (r.fg_att || 0) - (r.fg_made || 0) },
          { label: "Avg FG", compute: r => {
              const m = (r.fg_made_0_39 || 0) + (r.fg_made_40_49 || 0) + (r.fg_made_50plus || 0);
              if (!m) return null;
              return ((r.fg_made_0_39 || 0) * 25 + (r.fg_made_40_49 || 0) * 44.5 + (r.fg_made_50plus || 0) * 54) / m;
            }, format: "dec1" }
        ]},
        punter: { label: "Punter", cols: [
          { label: "G", key: "games" },
          { label: "Punts", key: "punts" },
          { label: "PuntYd", key: "punt_yds" },
          { label: "Net Avg", key: "punt_net_avg", format: "dec1" },
          { label: "Att/G", compute: r => r.games ? r.punts / r.games : null, format: "dec1" },
          { label: "I20", key: "punt_inside20" }
        ]}
      };
      const pg = detectPg();
      const tmpl = TMPL[pg] || TMPL.skill;
      const formatCell = (v, fmt) => {
        if (v == null || v === 0) return `<td class="num" style="color:var(--muted)">—</td>`;
        let s;
        if (fmt === "dec1") s = Number(v).toFixed(1);
        else if (fmt === "dec2") s = Number(v).toFixed(2);
        else if (fmt === "pct") s = (Number(v) * 100).toFixed(1) + "%";
        else if (fmt === "pct0") {
          let n = Number(v);
          if (n > 0 && n <= 1) n = n * 100;
          s = n.toFixed(1) + "%";
        } else s = String(v);
        return `<td class="num">${s}</td>`;
      };
      const thRow = [`<th>Yr</th>`, ...tmpl.cols.map(c => `<th class="num"${c.title ? ` title="${c.title.replace(/"/g, "&quot;")}"` : ""}>${c.label}</th>`)].join("");
      const bodyRows = totals.map(r => {
        const tds = [`<td>${r.season}</td>`];
        for (const c of tmpl.cols) {
          const v = c.compute ? c.compute(r) : r[c.key];
          tds.push(formatCell(v, c.format || "int"));
        }
        return `<tr>${tds.join("")}</tr>`;
      }).join("");
      const confNote = crosswalk.confidence && crosswalk.confidence !== "exact"
        ? `<div class="small" style="color:var(--warn); margin-top:4px;">Crosswalk confidence: ${escapeHtml(crosswalk.confidence)}${crosswalk.match_score ? " (" + crosswalk.match_score.toFixed(2) + ")" : ""} — review recommended.</div>`
        : "";
      return `
      <div class="profile-block">
        <h4>Raw Stats — ${tmpl.label}</h4>
        <div class="small" style="color:var(--muted); margin-bottom:6px;">Real NFL on-field counts + derived rates. Independent of MFL fantasy scoring.</div>
        <table class="rdh-table"><thead><tr>${thRow}</tr></thead><tbody>${bodyRows}</tbody></table>
        ${confNote}
      </div>`;
    })();

    const advancedStatsHtml = `<div class="profile-block">
        <h4>Advanced Stats — TBD</h4>
        <div class="small" style="color:var(--muted)">
          Derived / calculated advanced metrics will live here — weighted
          opportunity (e.g. a 1-yd carry worth more than a 50-yd carry),
          expected fantasy points (xFP), fantasy points over expected (FPOE),
          WOPR, ADOT, snap share, etc. See
          <code>docs/nfl_advanced_stats_plan.md</code> §"Future enhancements".
        </div>
      </div>`;

    // Three-way toggle inside the Stats tab.
    const statsPanelHtml = `
      <div class="upm-stats-view-switch" style="display:flex; gap:6px; margin-bottom:10px; flex-wrap:wrap;">
        <button type="button" class="rdh-chip" data-stats-view="scoring" aria-pressed="true">Scoring (MFL)</button>
        <button type="button" class="rdh-chip" data-stats-view="raw" aria-pressed="false">Raw Stats</button>
        <button type="button" class="rdh-chip" data-stats-view="advanced" aria-pressed="false">Advanced</button>
      </div>
      <div data-stats-body="scoring">${statsHtml}</div>
      <div data-stats-body="raw" hidden>${rawStatsHtml}</div>
      <div data-stats-body="advanced" hidden>${advancedStatsHtml}</div>
    `;

    // ── Game Log tab ─────────────────────────────────────────────────
    // Scoring / Raw Stats toggle (Keith 2026-04-23) — same shape as
    // the Stats tab toggle but applies per-week. Raw Stats uses the
    // bundle.nfl_weekly_by_season rows with per-pos-group column set.
    const gameLogSeasons = bundle.weekly_by_season && Object.keys(bundle.weekly_by_season).length
      ? Object.keys(bundle.weekly_by_season)
      : Object.keys(bundle.nfl_weekly_by_season || {});
    const gameLogHtml = gameLogSeasons.length ? `
      <div class="profile-block">
        <h4>Game Log — Every Game, Season-by-Season</h4>
        <div style="display:flex; gap:6px; margin-bottom:10px;">
          <button type="button" class="rdh-chip" data-gamelog-view="scoring" aria-pressed="true">Scoring (MFL)</button>
          <button type="button" class="rdh-chip" data-gamelog-view="raw"     aria-pressed="false">Raw Stats (NFL)</button>
        </div>
        <label style="font-size:11px; color:var(--muted); display:inline-block; margin-bottom:8px;">
          Season
          <select id="profile-season-select" style="margin-left:6px;">
            ${gameLogSeasons.sort((a,b)=>b-a).map(s => `<option value="${s}">${s}</option>`).join("")}
          </select>
        </label>
        <div id="profile-game-log"></div>
      </div>` : `<p class="small" style="color:var(--muted)">No weekly data available.</p>`;

    // ── News tab ─────────────────────────────────────────────────────
    const newsItems = [];
    if (inj.status) {
      newsItems.push(`<div class="profile-block"><h4 style="color:var(--warn)">Injury · ${escapeHtml(inj.status)}</h4><div class="small" style="color:var(--muted)">${escapeHtml(inj.details || "No additional details from MFL.")}</div></div>`);
    }
    if (add.datetime_et) {
      newsItems.push(`<div class="profile-block"><h4>Last Acquired</h4><div class="small">${escapeHtml(add.datetime_et.slice(0,10))} · ${escapeHtml(add.method || "")}${add.salary ? " · $" + Number(add.salary).toLocaleString() : ""} by ${escapeHtml(add.franchise_name || "")}</div></div>`);
    }
    if (trades.length) {
      newsItems.push(`<div class="profile-block"><h4>Recent Trades (${trades.length})</h4><div class="small" style="color:var(--muted)">${trades.slice(0,10).map(t => `<div>${escapeHtml(t.datetime_et?.slice(0,10) || "")} · ${escapeHtml(t.franchise_name || "")} ${escapeHtml(t.asset_role || "")}${t.comments ? " — \"" + escapeHtml(t.comments.slice(0, 80)) + "\"" : ""}</div>`).join("")}</div></div>`);
    }
    const newsHtml = (newsItems.length ? newsItems.join("") : `<p class="small" style="color:var(--muted)">No recent news.</p>`)
      + `<p class="small" style="color:var(--muted); margin-top:10px; font-style:italic;">Richer player-news feed (RotoWire / ESPN) coming in v2.</p>`;

    // Assemble the tabbed modal body.
    body.innerHTML = bundleErrorBanner + `
      <nav class="upm-view-switch" role="tablist" aria-label="Player profile sections">
        <button type="button" role="tab" aria-selected="true"  data-upm-tab="bio">Bio</button>
        <button type="button" role="tab" aria-selected="false" data-upm-tab="stats">Stats</button>
        <button type="button" role="tab" aria-selected="false" data-upm-tab="gamelog">Game Log</button>
        <button type="button" role="tab" aria-selected="false" data-upm-tab="news">News</button>
      </nav>
      <div class="upm-tab-panel" data-upm-panel="bio">${bioHtml}</div>
      <div class="upm-tab-panel" data-upm-panel="stats" hidden>${statsPanelHtml}</div>
      <div class="upm-tab-panel" data-upm-panel="gamelog" hidden>${gameLogHtml}</div>
      <div class="upm-tab-panel" data-upm-panel="news" hidden>${newsHtml}</div>
      <div class="small" style="color: var(--muted); margin-top: 10px; text-align:right;">MFL ID: ${pid}</div>
    `;

    // Tab switching — click a tab button, show its panel, hide siblings.
    body.querySelectorAll(".upm-view-switch button[data-upm-tab]").forEach(btn => {
      btn.addEventListener("click", () => {
        const target = btn.dataset.upmTab;
        body.querySelectorAll(".upm-view-switch button[data-upm-tab]").forEach(b =>
          b.setAttribute("aria-selected", b === btn ? "true" : "false")
        );
        body.querySelectorAll(".upm-tab-panel[data-upm-panel]").forEach(p => {
          if (p.dataset.upmPanel === target) p.removeAttribute("hidden");
          else p.setAttribute("hidden", "");
        });
      });
    });

    // Basic/Advanced toggle inside the Stats tab. Swap which inner
    // div is visible; persist selection in sessionStorage so the
    // default view follows the user's last choice across popups.
    const statsTogglePref = (() => {
      try {
        const v = sessionStorage.getItem("upm.stats.view");
        // Legacy values "basic"/"advanced" from the pre-2026-04-22
        // two-way toggle map onto the new three-way taxonomy.
        if (v === "basic") return "scoring";
        if (v === "advanced") return "raw";
        return v || "scoring";
      } catch (e) { return "scoring"; }
    })();
    body.querySelectorAll("[data-stats-view]").forEach(btn => {
      btn.setAttribute("aria-pressed", btn.dataset.statsView === statsTogglePref ? "true" : "false");
    });
    body.querySelectorAll("[data-stats-body]").forEach(div => {
      if (div.dataset.statsBody === statsTogglePref) div.removeAttribute("hidden");
      else div.setAttribute("hidden", "");
    });
    body.querySelectorAll("[data-stats-view]").forEach(btn => {
      btn.addEventListener("click", () => {
        const view = btn.dataset.statsView;
        try { sessionStorage.setItem("upm.stats.view", view); } catch (e) {}
        body.querySelectorAll("[data-stats-view]").forEach(b =>
          b.setAttribute("aria-pressed", b === btn ? "true" : "false")
        );
        body.querySelectorAll("[data-stats-body]").forEach(d => {
          if (d.dataset.statsBody === view) d.removeAttribute("hidden");
          else d.setAttribute("hidden", "");
        });
      });
    });

    // Trends window-selector — filters bundle.weekly to last-N and
    // renders a compact summary card. No extra fetch; all client-side.
    const winSel = document.getElementById("profile-window-select");
    const winSummary = document.getElementById("profile-window-summary");
    if (winSel && winSummary) {
      const renderWindow = (windowVal) => {
        const all = Array.isArray(bundle.weekly) ? bundle.weekly : [];
        if (!all.length) { winSummary.setAttribute("hidden", ""); return; }
        const seasonMax = Math.max(...all.map(w => w.season || 0));
        let windowWeeks;
        if (windowVal === "season") {
          windowWeeks = all.filter(w => w.season === seasonMax);
        } else {
          const n = parseInt(windowVal, 10);
          windowWeeks = [...all].sort((a, b) => (b.season - a.season) || (b.week - a.week)).slice(0, n);
        }
        if (!windowWeeks.length) { winSummary.setAttribute("hidden", ""); return; }
        const tot = windowWeeks.length;
        const pts = windowWeeks.reduce((s, w) => s + (w.score || 0), 0);
        const elite = windowWeeks.filter(w => w.week_tier === "Elite").length;
        const plus = windowWeeks.filter(w => w.week_tier === "Plus").length;
        const dud = windowWeeks.filter(w => w.week_tier === "Dud").length;
        const zSum = windowWeeks.reduce((s, w) => s + (w.z_score || 0), 0);
        const meanZ = tot ? zSum / tot : 0;
        const ppg = tot ? pts / tot : 0;
        winSummary.removeAttribute("hidden");
        winSummary.innerHTML = `
          <div><span class="lbl">Games</span><div class="val">${tot}</div></div>
          <div><span class="lbl">PPG</span><div class="val">${ppg.toFixed(1)}</div></div>
          <div><span class="lbl">Elite%</span><div class="val" style="color:var(--smash)">${(elite/tot*100).toFixed(0)}%</div></div>
          <div><span class="lbl">Plus%</span><div class="val" style="color:var(--hit)">${(plus/tot*100).toFixed(0)}%</div></div>
          <div><span class="lbl">Dud%</span><div class="val" style="color:var(--bust)">${(dud/tot*100).toFixed(0)}%</div></div>
          <div><span class="lbl">Mean z</span><div class="val">${meanZ >= 0 ? "+" : ""}${meanZ.toFixed(2)}</div></div>
        `;
      };
      winSel.addEventListener("change", e => renderWindow(e.target.value));
      // default: current season
      renderWindow("season");
    }
    // Wire the season dropdown + Scoring/Raw toggle for the game log.
    const seasonSel = document.getElementById("profile-season-select");
    const logEl = document.getElementById("profile-game-log");
    if (seasonSel && logEl) {
      // Per-pos-group Raw Stats templates (weekly granularity).
      // Snap count + snap% look up bundle.nfl_snaps_by_week at render.
      const GL_TMPL = {
        idp: { label: "IDP", snap: "def", cols: [
          { label: "Tkl",   key: "def_tackles_solo" },
          { label: "Ast",   key: "def_tackles_ast" },
          { label: "TFL",   key: "def_tfl" },
          { label: "FF",    key: "def_ff" },
          { label: "FR",    key: "def_fr" },
          { label: "Sk",    key: "def_sacks", format: "dec1" },
          { label: "PD",    key: "def_pass_def" },
          { label: "Int",   key: "def_ints" },
          { label: "DefTD", key: "def_tds" }
        ]},
        qb: { label: "QB", snap: "off", cols: [
          { label: "RuAtt", key: "rush_att" },
          { label: "RuYd",  key: "rush_yds" },
          { label: "RuTD",  key: "rush_tds" },
          { label: "Fum",   key: "rush_fumbles" },
          { label: "FumL",  key: "rush_fumbles_lost" },
          { label: "Att",   key: "pass_att" },
          { label: "Cmp",   key: "pass_cmp" },
          { label: "Cmp%",  compute: r => r.pass_att ? r.pass_cmp / r.pass_att : null, format: "pct" },
          { label: "PaYd",  key: "pass_yds" },
          { label: "PaTD",  key: "pass_tds" },
          { label: "Int",   key: "pass_ints" },
          { label: "Drops", key: "passing_drops", title: "Receiver drops on this QB's throws (PFR, 2018+)" }
        ]},
        skill: { label: "RB / WR / TE", snap: "off", cols: [
          { label: "Tgt",   key: "targets" },
          { label: "Rec",   key: "receptions" },
          { label: "RecYd", key: "rec_yds" },
          { label: "RecTD", key: "rec_tds" },
          { label: "Y/T",   compute: r => r.targets ? r.rec_yds / r.targets : null, format: "dec2" },
          { label: "Drops", key: "receiving_drops", title: "Dropped passes (PFR, 2018+)" },
          { label: "BrTkl", compute: r => (r.receiving_broken_tackles || 0) + (r.rushing_broken_tackles || 0),
                            title: "Broken tackles combined — receiving + rushing (PFR, 2018+)" },
          { label: "RuAtt", key: "rush_att" },
          { label: "RuYd",  key: "rush_yds" },
          { label: "RuTD",  key: "rush_tds" },
          { label: "Fum",   key: "rush_fumbles" },
          { label: "FumL",  key: "rush_fumbles_lost" }
        ]},
        kicker: { label: "Kicker", snap: null, cols: [
          { label: "XPM",     key: "xp_made" },
          { label: "XP Miss", compute: r => (r.xp_att || 0) - (r.xp_made || 0) },
          { label: "FGM",     key: "fg_made" },
          { label: "FG Miss", compute: r => (r.fg_att || 0) - (r.fg_made || 0) }
        ]},
        punter: { label: "Punter", snap: null, cols: [
          { label: "Punts",   key: "punts" },
          { label: "PuntYd",  key: "punt_yds" },
          { label: "Net Avg", key: "punt_net_avg", format: "dec1" },
          { label: "I20",     key: "punt_inside20" }
        ]}
      };
      const formatCell = (v, fmt) => {
        if (v == null || v === 0) return `<td class="num" style="color:var(--muted)">—</td>`;
        let s;
        if (fmt === "dec1") s = Number(v).toFixed(1);
        else if (fmt === "dec2") s = Number(v).toFixed(2);
        else if (fmt === "pct") s = (Number(v) * 100).toFixed(1) + "%";
        else if (fmt === "pct0") {
          let n = Number(v);
          if (n > 0 && n <= 1) n = n * 100;
          s = n.toFixed(1) + "%";
        } else s = String(v);
        return `<td class="num">${s}</td>`;
      };
      const detectPg = () => {
        const raw = String((bundle.crosswalk?.position || "")).toUpperCase();
        if (raw === "P") return "punter";
        const pg = String(
          (bundle.career_summary && bundle.career_summary[0] && bundle.career_summary[0].pos_group) ||
          (bundle.nfl_weekly && bundle.nfl_weekly[0] && bundle.nfl_weekly[0].pos_group) ||
          raw
        ).toUpperCase();
        if (pg === "QB") return "qb";
        if (["RB","WR","TE","FB"].includes(pg)) return "skill";
        if (pg === "PK" || pg === "K") return "kicker";
        if (["DL","LB","DB"].includes(pg)) return "idp";
        if (["DE","DT","NT","EDGE","OLB","ILB","MLB","CB","S","SS","FS"].includes(raw)) return "idp";
        if (raw === "K" || raw === "PK") return "kicker";
        return "skill";
      };

      const renderScoring = (seasonVal) => {
        const weeks = (bundle.weekly_by_season || {})[seasonVal] || [];
        if (!weeks.length) { logEl.innerHTML = '<p class="small" style="color:var(--muted)">No MFL weekly data for this season.</p>'; return; }
        const weekTierClass = t => t === "Elite" ? "Smash" : t === "Plus" ? "Hit" : t === "Neutral" ? "Contrib" : "Bust";
        const sorted = [...weeks].sort((a,b) => a.week - b.week);
        const starts = sorted.filter(w => w.status === "starter").length;
        const elite = sorted.filter(w => w.week_tier === "Elite").length;
        const plus = sorted.filter(w => w.week_tier === "Plus").length;
        const dud = sorted.filter(w => w.week_tier === "Dud").length;
        const tot = sorted.length;
        const pts = sorted.reduce((s, w) => s + (w.score || 0), 0);
        logEl.innerHTML = `
          <div class="small" style="color: var(--muted); margin-bottom: 6px;">
            ${tot} games · ${starts} MFL starts · ${pts.toFixed(1)} pts (${(pts / tot).toFixed(1)} ppg)
            · Elite ${elite} (${(elite/tot*100).toFixed(0)}%) · Plus ${plus} (${(plus/tot*100).toFixed(0)}%) · Dud ${dud} (${(dud/tot*100).toFixed(0)}%)
          </div>
          <table class="rdh-table">
            <thead><tr><th class="num">Wk</th><th class="num">Pts</th><th class="num">z</th><th>Week Tier</th><th>MFL Status</th><th class="small">Team</th><th class="num">Pos Rk</th></tr></thead>
            <tbody>${sorted.map(w => {
              const playoffTag = w.is_reg === 0 ? ` <span class="small" style="color:var(--accent); font-weight:600;" title="Playoffs — tier classifications use regular-season baselines only">P</span>` : "";
              return `
              <tr${w.is_reg === 0 ? ' style="background:rgba(255,158,77,0.06);"' : ""}>
                <td class="num">${w.week}${playoffTag}</td>
                <td class="num">${w.score != null ? w.score.toFixed(1) : "—"}</td>
                <td class="num">${w.z_score != null ? (w.z_score > 0 ? "+" : "") + w.z_score.toFixed(2) : "—"}</td>
                <td>${w.week_tier ? `<span class="tier ${weekTierClass(w.week_tier)}">${w.week_tier}</span>` : "—"}</td>
                <td>${escapeHtml(w.status || "")}</td>
                <td class="small">${escapeHtml(w.roster_franchise_name || "")}</td>
                <td class="num">${w.pos_rank || "—"}</td>
              </tr>`;
            }).join("")}</tbody>
          </table>`;
      };

      const renderRaw = (seasonVal) => {
        const weeks = (bundle.nfl_weekly_by_season || {})[seasonVal] || [];
        if (!weeks.length) { logEl.innerHTML = '<p class="small" style="color:var(--muted)">No NFL weekly data for this season.</p>'; return; }
        const sorted = [...weeks].sort((a,b) => a.week - b.week);
        const pg = detectPg();
        const tmpl = GL_TMPL[pg] || GL_TMPL.skill;
        const snapBy = bundle.nfl_snaps_by_week || {};
        let header = '<th class="num">Wk</th><th>Team</th><th>Opp</th>';
        if (tmpl.snap) header += '<th class="num">Snaps</th><th class="num">Snap%</th>';
        header += tmpl.cols.map(c =>
          `<th class="num"${c.title ? ` title="${c.title.replace(/"/g, "&quot;")}"` : ""}>${c.label}</th>`
        ).join("");
        const rows = sorted.map(w => {
          const snapRow = snapBy[`${w.season}-${w.week}`] || {};
          const snapCount = tmpl.snap === "def" ? snapRow.def_snaps : tmpl.snap === "off" ? snapRow.off_snaps : null;
          const snapPct   = tmpl.snap === "def" ? snapRow.def_snap_pct : tmpl.snap === "off" ? snapRow.off_snap_pct : null;
          let cells = `<td class="num">${w.week}</td><td>${escapeHtml(w.team || "")}</td><td>${escapeHtml(w.opponent || "")}</td>`;
          if (tmpl.snap) {
            cells += formatCell(snapCount, "int");
            cells += formatCell(snapPct, "pct0");
          }
          for (const c of tmpl.cols) {
            const v = c.compute ? c.compute(w) : w[c.key];
            cells += formatCell(v, c.format || "int");
          }
          return `<tr>${cells}</tr>`;
        }).join("");
        logEl.innerHTML = `
          <div class="small" style="color:var(--muted); margin-bottom: 6px;">
            Template: <strong>${tmpl.label}</strong>. ${sorted.length} games · NFL weekly box score via nflverse.
          </div>
          <table class="rdh-table"><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table>`;
      };

      const currentView = () => {
        try { return sessionStorage.getItem("upm.gamelog.view") || "scoring"; } catch (e) { return "scoring"; }
      };
      const applyView = () => {
        const v = currentView();
        document.querySelectorAll("[data-gamelog-view]").forEach(b => {
          b.setAttribute("aria-pressed", b.dataset.gamelogView === v ? "true" : "false");
        });
        if (v === "raw") renderRaw(seasonSel.value);
        else renderScoring(seasonSel.value);
      };
      document.querySelectorAll("[data-gamelog-view]").forEach(b => {
        b.addEventListener("click", () => {
          try { sessionStorage.setItem("upm.gamelog.view", b.dataset.gamelogView); } catch (e) {}
          applyView();
        });
      });
      seasonSel.addEventListener("change", applyView);
      applyView();
    }
  }

  function formatMflDate(ts) {
    // MFL birthdates are unix timestamps
    if (!ts) return "";
    const n = Number(ts);
    if (!isFinite(n)) return String(ts);
    try { return new Date(n * 1000).toLocaleDateString(); } catch { return String(ts); }
  }

  // ══════════════════════════════════════════════════════════════════════
  // TIER POPUP — shows the CALCULATION (formula, threshold, worked example)
  // ══════════════════════════════════════════════════════════════════════
  function showTierPopup(tier) {
    const def = TIER_DEFS[tier];
    if (!def) return;
    // Find a "representative" pick at this tier to use for the worked example —
    // pick closest to the middle of the tier's NET range.
    const candidates = STATE.history.picks.filter(p =>
      p.tier === tier && p.net_score_3yr != null && p.ep_rate_3yr_avg != null && p.dud_rate_3yr_avg != null
    );
    // Target NET near the midpoint of the tier
    const midNet = tier === "Smash" ? 0.45
                 : tier === "Hit" ? 0.22
                 : tier === "Contrib" ? 0.075
                 : -0.15;
    const ex = candidates.sort((a, b) =>
      Math.abs((a.net_score_3yr || 0) - midNet) - Math.abs((b.net_score_3yr || 0) - midNet)
    )[0];

    const total = candidates.length;
    const total_all = STATE.history.picks.filter(p => p.tier === tier).length;

    openModal(`
      <h3><span class="tier ${tierSlug(tier)}">${tier}</span> &nbsp; ${def.desc}</h3>
      ${def.basic ? `
      <div class="profile-block" style="border-top:0; padding-top:0; margin-top:10px; background:rgba(91,141,255,0.08); padding:12px; border-radius:6px;">
        <h4 style="color:var(--accent);">In plain English</h4>
        <p style="margin:0;">${def.basic}</p>
      </div>` : ""}
      <div class="profile-block">
        <h4>How we got here — step by step</h4>
        <ol style="line-height:1.6; padding-left:18px; margin:6px 0;">
          <li>We grade every single week a player started against the typical starter at his position that year.</li>
          <li>Each week gets labeled one of four things:
            <ul style="margin:4px 0;">
              <li><span class="tier Smash">Elite</span> — way better than a typical starter</li>
              <li><span class="tier Hit">Plus</span> — better than a typical starter</li>
              <li><span class="tier Contrib">Neutral</span> — roughly average</li>
              <li><span class="tier Bust">Dud</span> — way worse (he hurt your matchup)</li>
            </ul>
          </li>
          <li><strong>E+P rate</strong> = how often he's Elite or Plus (good weeks).<br>
              <strong>Dud rate</strong> = how often he's a Dud (bad weeks).</li>
          <li>We then combine those two numbers into a single <strong>NET score</strong>:</li>
        </ol>
        <p style="text-align:center; background:var(--panel-alt); padding:10px; border-radius:6px; font-size:14px; margin:8px 0;">
          <code>NET = E+P rate − ½ × Dud rate</code>
        </p>
        <p class="small" style="color:var(--muted); margin:4px 0;">
          Good weeks get full credit. Bad weeks cost half as much because — tested against 14 seasons of league data — hitting peaks is roughly 2× as valuable as avoiding stinkers.
        </p>
      </div>

      <div class="profile-block">
        <h4>This tier's threshold</h4>
        <p style="font-size:18px; text-align:center; padding:8px;">
          <span class="tier ${tierSlug(tier)}">${tier}</span> &nbsp;=&nbsp; <strong>${def.min}</strong>
        </p>
      </div>

      <div class="profile-block">
        <h4>Why NET — it predicts winning better than every alternative</h4>
        <p>We tested every candidate metric against 192 real team-seasons
        (2010-2025) to see which best predicts a team's All-Play winning %:</p>
        <table class="rdh-table" style="margin-top:6px;">
          <thead><tr><th>Metric</th><th class="num">Correlation w/ AP%</th></tr></thead>
          <tbody>
            <tr><td><strong>NET (E+P − ½×Dud)</strong></td><td class="num" style="color:var(--ok); font-weight:700">+0.850</td></tr>
            <tr><td>Offense E+P alone</td><td class="num">+0.844</td></tr>
            <tr><td>E+P alone</td><td class="num">+0.834</td></tr>
            <tr><td>Dud rate alone (inverted)</td><td class="num">+0.763</td></tr>
            <tr><td>Raw Points For</td><td class="num" style="color:var(--muted)">+0.505</td></tr>
          </tbody>
        </table>
        <p class="small" style="color:var(--muted); margin-top:6px;">
          NET beats E+P alone, Dud alone, and raw points.
          It's the most accurate single predictor of winning in this league — which is why
          we use it to label rookie tiers instead of any of the alternatives.
        </p>
      </div>

      ${ex ? `
      <div class="profile-block">
        <h4>Worked example — ${escapeHtml(ex.player_name)} (${ex.season} ${ex.pick_label})</h4>
        <table class="rdh-table" style="margin-top:6px;">
          <tbody>
            <tr>
              <td>3yr E+P rate</td>
              <td class="num"><strong>${(ex.ep_rate_3yr_avg * 100).toFixed(1)}%</strong></td>
              <td class="small" style="color:var(--muted)">of his starts were Elite or Plus weeks</td>
            </tr>
            <tr>
              <td>3yr Dud rate</td>
              <td class="num"><strong>${(ex.dud_rate_3yr_avg * 100).toFixed(1)}%</strong></td>
              <td class="small" style="color:var(--muted)">of his starts were Dud weeks</td>
            </tr>
            <tr>
              <td>NET</td>
              <td class="num"><strong style="color:var(--accent)">
                ${(ex.ep_rate_3yr_avg * 100).toFixed(1)}% − 0.5 × ${(ex.dud_rate_3yr_avg * 100).toFixed(1)}% =
                ${((ex.net_score_3yr) * 100 > 0 ? "+" : "") + (ex.net_score_3yr * 100).toFixed(1)}
              </strong></td>
              <td class="small" style="color:var(--muted)">→ lands in the <strong>${tier}</strong> band</td>
            </tr>
          </tbody>
        </table>
      </div>` : ""}

      <p class="small" style="color:var(--muted); margin-top:10px;">
        ${total_all} historical picks (2012-2025) carry this tier
        ${STATE.history.picks.length ? ` — ${(total_all / STATE.history.picks.length * 100).toFixed(1)}% of all rookie picks.` : "."}
      </p>
      <div class="actions"><button class="btn secondary" onclick="document.getElementById('rdh-modal-overlay').classList.remove('open')">Close</button></div>
    `);
  }

  // ══════════════════════════════════════════════════════════════════════
  // HISTORICAL PICKS
  // ══════════════════════════════════════════════════════════════════════
  function applyHistoryFilters() {
    const f = STATE.h_filters;
    let rows = STATE.history.picks.slice();
    if (f.season) rows = rows.filter(p => String(p.season) === f.season);
    if (f.active === "active") rows = rows.filter(p => p.owner_active);
    else if (f.active === "retired") rows = rows.filter(p => !p.owner_active);
    if (f.team) rows = rows.filter(p => p.owner_name === f.team || p.franchise_id === f.team);
    if (f.round) rows = rows.filter(p => String(p.round) === f.round);
    if (f.slot) rows = rows.filter(p => String(p.slot) === f.slot);
    if (f.pos) rows = rows.filter(p => POS_COMBINED(p.position) === f.pos);
    if (f.pg) rows = rows.filter(p => p.pos_group === f.pg);
    if (f.tier) rows = rows.filter(p => p.tier === f.tier);
    if (f.search) {
      const q = f.search.toLowerCase();
      rows = rows.filter(p => (p.player_name || "").toLowerCase().includes(q));
    }
    const key = STATE.h_sort;
    const dir = STATE.h_sort_dir;
    const isVirtual = key.startsWith("_");
    rows.sort((a, b) => {
      const av = isVirtual ? metricSortValue(a, key) : a[key];
      const bv = isVirtual ? metricSortValue(b, key) : b[key];
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
    return rows;
  }

  // Every metric view uses 6 numeric columns: Y1, Y2, Y3, 3yr Total, 3yr Avg, 3yr vs Exp.
  // Rank views use the same layout but with positional rank numbers.
  const METRIC_LABELS = {
    points: {
      label: "Points", y: "Pts", total: "3yr Total", avg: "3yr Avg/Season", vs: "vs Slot Exp",
      y1: (p) => p.points_y1, y2: (p) => p.points_y2, y3: (p) => p.points_y3,
      tot: (p) => p.points_3yr_total,
      avg_val: (p) => p.avg_season_pts_3yr,
      vs_exp: (p) => p.value_above_expected,
      isRank: false,
    },
    points_rank: {
      label: "Points Rank", y: "Pts Rk", total: "—", avg: "3yr Pts Rk", vs: "vs Exp",
      y1: (p) => p.pts_rank_y1, y2: (p) => p.pts_rank_y2, y3: (p) => p.pts_rank_y3,
      tot: (p) => null,
      avg_val: (p) => p.pts_rank_3yr_avg,
      vs_exp: (p) => p.pos_rank_total_vs_expected,
      isRank: true, rankPrefix: (p) => p.pos_subgroup || p.position || "",
    },
    // Column contract per metric:
    //   y        — short suffix after "Y1"/"Y2"/"Y3" header (e.g. "Pts", "E+P%")
    //   total    — header for 3yr-total column; "—" hides the column
    //   avg      — header for main "3yr" column (always shown)
    //   vs       — header for vs-expected column; "—" hides it
    ppg: {
      label: "PPG", y: "PPG", total: "—", avg: "3yr PPG", vs: "—",
      y1: (p) => p.ppg_y1, y2: (p) => p.ppg_y2, y3: (p) => p.ppg_y3,
      tot: (p) => null, avg_val: (p) => p.avg_ppg_3yr, vs_exp: (p) => null,
      isRank: false,
    },
    ppg_rank: {
      label: "PPG Rank", y: "PPG Rk", total: "—", avg: "3yr PPG Rk", vs: "vs Exp",
      y1: (p) => p.ppg_rank_y1, y2: (p) => p.ppg_rank_y2, y3: (p) => p.ppg_rank_y3,
      tot: (p) => null, avg_val: (p) => p.ppg_rank_3yr_avg,
      vs_exp: (p) => p.pos_rank_ppg_vs_expected,
      isRank: true, rankPrefix: (p) => p.pos_subgroup || p.position || "",
    },
    ep_rate: {
      label: "E+P Rate", y: "E+P%", total: "—", avg: "3yr E+P", vs: "vs Slot Exp",
      y1: (p) => p.ep_y1, y2: (p) => p.ep_y2, y3: (p) => p.ep_y3,
      tot: (p) => null, avg_val: (p) => p.ep_rate_3yr_avg,
      vs_exp: (p) => p.ep_rate_vs_expected,
      isRank: false,
    },
    dud_rate: {
      label: "Dud Rate", y: "Dud%", total: "—", avg: "3yr Dud", vs: "—",
      y1: (p) => p.dud_y1, y2: (p) => p.dud_y2, y3: (p) => p.dud_y3,
      tot: (p) => null, avg_val: (p) => p.dud_rate_3yr_avg, vs_exp: (p) => null,
      isRank: false,
    },
    net_score: {
      label: "NET (E+P − 0.5×Dud)", y: "NET", total: "—", avg: "3yr NET", vs: "Sample",
      y1: (p) => (p.ep_y1 != null && p.dud_y1 != null) ? p.ep_y1 - 0.5 * p.dud_y1 : null,
      y2: (p) => (p.ep_y2 != null && p.dud_y2 != null) ? p.ep_y2 - 0.5 * p.dud_y2 : null,
      y3: (p) => (p.ep_y3 != null && p.dud_y3 != null) ? p.ep_y3 - 0.5 * p.dud_y3 : null,
      tot: (p) => null, avg_val: (p) => p.net_score_3yr,
      vs_exp: (p) => p.years_of_data != null
        ? { _sample: true, years: p.years_of_data, gp: p.total_gp_window }
        : null,
      isRank: false,
    },
    draft_rating: {
      // Per-year NET shown for context; 3yr NET in Total; Draft Rating (Δ) in Avg; Slot-Exp NET in vs col.
      label: "Draft Rating (Δ vs slot-expected NET)",
      y: "NET", total: "3yr NET", avg: "Draft Rating", vs: "Slot-Exp NET",
      y1: (p) => (p.ep_y1 != null && p.dud_y1 != null) ? p.ep_y1 - 0.5 * p.dud_y1 : null,
      y2: (p) => (p.ep_y2 != null && p.dud_y2 != null) ? p.ep_y2 - 0.5 * p.dud_y2 : null,
      y3: (p) => (p.ep_y3 != null && p.dud_y3 != null) ? p.ep_y3 - 0.5 * p.dud_y3 : null,
      tot: (p) => p.net_score_3yr,
      avg_val: (p) => p.draft_rating,
      vs_exp: (p) => p.expected_net_3yr,
      isRank: false,
    },
    ep_rank: {
      label: "E+P Rank", y: "E+P Rk", total: "—", avg: "3yr E+P Rk", vs: "—",
      y1: (p) => p.ep_rank_y1, y2: (p) => p.ep_rank_y2, y3: (p) => p.ep_rank_y3,
      tot: (p) => null, avg_val: (p) => p.ep_rank_3yr_avg, vs_exp: (p) => null,
      isRank: true, rankPrefix: (p) => p.pos_subgroup || p.position || "",
    },
    win_chunks: {
      label: "Win Chunks", y: "WC", total: "3yr Total", avg: "3yr Avg", vs: "vs Slot Exp",
      y1: (p) => p.wc_y1, y2: (p) => p.wc_y2, y3: (p) => p.wc_y3,
      tot: (p) => p.wc_3yr_total, avg_val: (p) => p.wc_3yr_avg,
      vs_exp: (p) => p.wc_3yr_avg_vs_expected,
      isRank: false,
    },
    wc_rank: {
      label: "WC Rank", y: "WC Rk", total: "—", avg: "3yr WC Rk", vs: "—",
      y1: (p) => p.wc_rank_y1, y2: (p) => p.wc_rank_y2, y3: (p) => p.wc_rank_y3,
      tot: (p) => null, avg_val: (p) => p.wc_rank_3yr_avg, vs_exp: (p) => null,
      isRank: true, rankPrefix: (p) => p.pos_subgroup || p.position || "",
    },
  };
  function fmtMetric(v, metric, ml, pick) {
    if (v == null) return "—";
    if (ml && ml.isRank) {
      const prefix = ml.rankPrefix ? ml.rankPrefix(pick) : "";
      return prefix + Math.round(v);
    }
    if (metric === "ep_rate" || metric === "dud_rate") return (v * 100).toFixed(0) + "%";
    if (metric === "net_score") return (v > 0 ? "+" : "") + (v * 100).toFixed(0);
    if (metric === "draft_rating") return (v > 0 ? "+" : "") + (v * 100).toFixed(2);
    if (metric === "points") return v.toFixed(0);
    return v.toFixed(1);
  }
  function fmtVsExp(v, ml) {
    if (v == null) return "—";
    // Special: sample-size marker for NET metric
    if (v && typeof v === "object" && v._sample) {
      return `${v.years}yr · ${v.gp}gp`;
    }
    // For rank metrics, positive delta = player ranked better than slot's median rank → good
    if (ml && ml.isRank) return (v > 0 ? "+" : "") + Math.round(v);
    if (Math.abs(v) < 10) return (v > 0 ? "+" : "") + v.toFixed(1);
    return (v > 0 ? "+" : "") + v.toFixed(0);
  }
  function metricSortValue(p, virtualKey) {
    const ml = METRIC_LABELS[STATE.h_metric];
    switch (virtualKey) {
      case "_y1": return ml.y1(p);
      case "_y2": return ml.y2(p);
      case "_y3": return ml.y3(p);
      case "_tot": return ml.tot(p);
      case "_avg": return ml.avg_val(p);
      case "_vs": return ml.vs_exp(p);
      default: return null;
    }
  }

  function renderHistory() {
    const rows = applyHistoryFilters();
    const tbody = document.querySelector("#h-table tbody");
    const cap = 500;
    const shown = rows.slice(0, cap);
    const m = STATE.h_metric;
    const ml = METRIC_LABELS[m];
    // Dynamically hide Total / vs Exp columns when the metric marks them "—".
    // Also hide Y1/Y2/Y3 if the metric has no per-year value (avoids showing 3 empty cols).
    const hasTotal = ml.total && ml.total !== "—";
    const hasVs    = ml.vs    && ml.vs    !== "—";
    const sampleY1 = typeof ml.y1 === "function";
    const anyYearly = sampleY1;  // All current metrics either have all three years or none

    const colY1 = document.getElementById("h-col-y1");
    const colY2 = document.getElementById("h-col-y2");
    const colY3 = document.getElementById("h-col-y3");
    const colTotal = document.getElementById("h-col-total");
    const colAvg = document.getElementById("h-col-avg");
    const colVs = document.getElementById("h-col-vs");

    // Header labels
    if (anyYearly) {
      colY1.textContent = `Y1 ${ml.y}`;
      colY2.textContent = `Y2 ${ml.y}`;
      colY3.textContent = `Y3 ${ml.y}`;
    }
    colTotal.textContent = ml.total;
    colAvg.textContent = ml.avg || "—";
    colVs.textContent = ml.vs;
    // Visibility: hide the whole <th> when column is unused
    [colY1, colY2, colY3].forEach(th => th.style.display = anyYearly ? "" : "none");
    colTotal.style.display = hasTotal ? "" : "none";
    colVs.style.display    = hasVs    ? "" : "none";

    tbody.innerHTML = shown.map(p => {
      const y1 = anyYearly ? fmtMetric(ml.y1(p), m, ml, p) : "";
      const y2 = anyYearly ? fmtMetric(ml.y2(p), m, ml, p) : "";
      const y3 = anyYearly ? fmtMetric(ml.y3(p), m, ml, p) : "";
      const tot = hasTotal ? fmtMetric(ml.tot(p), m, ml, p) : "";
      const avg = fmtMetric(ml.avg_val(p), m, ml, p);
      const vsVal = hasVs ? ml.vs_exp(p) : null;
      const vsStr = hasVs ? fmtVsExp(vsVal, ml) : "";
      const deltaCls = typeof vsVal === "number" ? (vsVal > 0 ? "ok" : vsVal < 0 ? "err" : "muted") : "muted";
      const tip = (gp, starts) => {
        if (!gp) return "no NFL games";
        return `${starts || 0} MFL starts / ${gp} NFL games played`;
      };
      const headshot = p.icon_url
        ? `<img src="${p.icon_url}" class="headshot-cell" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'), {className: 'headshot-cell headshot-placeholder'}))">`
        : `<div class="headshot-cell headshot-placeholder"></div>`;
      // Click-to-explain: mark cells whose value comes from a calculated metric
      const mcell = (value, col) => `<td class="num col-lo metric-click" data-metric="${m}" data-col="${col}" data-pid="${p.player_id}">${value}</td>`;
      const mcellStrong = (value, col, deltaClass) =>
        `<td class="num metric-click" data-metric="${m}" data-col="${col}" data-pid="${p.player_id}" style="${deltaClass ? `color: var(--${deltaClass})` : ""}"><strong>${value}</strong></td>`;
      return `
        <tr>
          <td class="col-md">${p.season}</td>
          <td class="col-md">${p.pick_label}</td>
          <td class="col-md" title="${(p.franchise_name || '').replace(/"/g, '&quot;')} (team at time of pick)">
            ${p.owner_name || p.franchise_name || "?"}
            ${!p.owner_active ? '<span class="small" style="color:var(--muted); font-size:10px;"> [retired]</span>' : ""}
          </td>
          <td class="col-md">${headshot}</td>
          <td><a href="#" class="player-link" data-pid="${p.player_id}">${p.player_name || "?"}</a></td>
          <td>${POS_COMBINED(p.position) || ""}</td>
          <td class="num col-lo">${p.salary ? "$" + p.salary.toLocaleString() : "-"}</td>
          ${anyYearly ? `
            ${mcell(y1, "y1")}
            ${mcell(y2, "y2")}
            ${mcell(y3, "y3")}
          ` : ""}
          ${hasTotal ? mcell(tot, "tot") : ""}
          ${mcellStrong(avg, "avg")}
          ${hasVs ? mcell(vsStr, "vs", deltaCls) : ""}
          <td><span class="tier ${tierSlug(p.tier)} tier-click" data-tier="${p.tier}">${p.tier}</span></td>
        </tr>
      `;
    }).join("");
    tbody.querySelectorAll(".tier-click").forEach(el => {
      el.addEventListener("click", () => showTierPopup(el.dataset.tier));
    });
    tbody.querySelectorAll(".player-link").forEach(el => {
      el.addEventListener("click", (e) => {
        e.preventDefault();
        showPlayerProfileCard(el.dataset.pid);
      });
    });
    document.getElementById("h-summary").textContent =
      `Showing ${shown.length} of ${rows.length} picks` + (rows.length > cap ? " (cap 500, refine filters)" : "");
  }

  // ══════════════════════════════════════════════════════════════════════
  // TEAM TENDENCIES
  // ══════════════════════════════════════════════════════════════════════
  function renderTeams() {
    const f = STATE.t_filters;
    const allPicks = STATE.history.picks.filter(p =>
      (!f.season || String(p.season) === f.season) &&
      (!f.round || String(p.round) === f.round) &&
      (!f.slot || String(p.slot) === f.slot) &&
      (!f.pg || p.pos_group === f.pg) &&
      (!f.pos || POS_COMBINED(p.position) === f.pos) &&
      (f.active === "all" ? true :
        f.active === "retired" ? !p.owner_active : p.owner_active));

    // League benchmark on filtered set — dynamic: only show tiers that have counts.
    const n = allPicks.length;
    const tiers = allPicks.reduce((acc, p) => { acc[p.tier] = (acc[p.tier] || 0) + 1; return acc; }, {});
    const lb = document.getElementById("t-benchmark");
    if (n === 0) {
      lb.innerHTML = "<p class='small' style='color:var(--muted)'>No picks match filters.</p>";
    } else {
      const avgPts = allPicks.reduce((s, p) => s + (p.points_3yr_total || 0), 0) / n;
      const chips = [`<div class="stat-chip"><span class="label">Picks</span> <span class="value">${n}</span></div>`];
      for (const t of TIER_ORDER) {
        const c = tiers[t] || 0;
        if (c === 0) continue;
        chips.push(`<div class="stat-chip"><span class="label">${t} rate</span> <span class="value">${(c / n * 100).toFixed(0)}%</span></div>`);
      }
      // Off/Def/ST split (only show groups with counts)
      const pgCount = allPicks.reduce((acc, p) => { if (p.pos_group) acc[p.pos_group] = (acc[p.pos_group] || 0) + 1; return acc; }, {});
      const off = pgCount.offense || 0, def = pgCount.defense || 0, sp = pgCount.special || 0;
      const sideChips = [];
      if (off) sideChips.push(`<span style="color:var(--accent)">${(off/n*100).toFixed(0)}% Off</span>`);
      if (def) sideChips.push(`<span style="color:var(--warn)">${(def/n*100).toFixed(0)}% Def</span>`);
      if (sp) sideChips.push(`<span style="color:var(--muted)">${(sp/n*100).toFixed(0)}% ST</span>`);
      if (sideChips.length) {
        chips.push(`<div class="stat-chip"><span class="label">Side split</span> <span class="value">${sideChips.join(" · ")}</span></div>`);
      }
      lb.innerHTML = chips.join("");
    }

    // Bucket picks by OWNER_NAME (franchise_id may be recycled across owners)
    const byTeam = {};
    for (const p of allPicks) {
      const key = p.owner_name || p.franchise_id;
      if (!key) continue;
      (byTeam[key] = byTeam[key] || []).push(p);
    }
    const grid = document.getElementById("teams-grid");
    const teamsSorted = Object.entries(byTeam).map(([ownerKey, picks]) => {
      const team = STATE.teams.teams[ownerKey] || { owner_name: ownerKey, franchise_id: ownerKey };
      const tc = picks.reduce((acc, p) => { acc[p.tier] = (acc[p.tier] || 0) + 1; return acc; }, {});
      const smash = tc.Smash || 0, hit = tc.Hit || 0, contrib = tc.Contrib || 0;
      const bust = tc.Bust || 0, injBust = tc["Injury Bust"] || 0;
      const total = picks.length;
      const avgPts = picks.reduce((s, p) => s + (p.points_3yr_total || 0), 0) / total;
      // Draft Rating — pull shrunk + 0-100 normalized values from the artifact.
      const teamMeta = STATE.teams.teams[ownerKey] || {};
      const drRaw = teamMeta.draft_rating_raw;     // avg actual-NET minus slot-expected-NET
      const drShrunk = teamMeta.draft_rating_shrunk; // after Bayesian shrinkage (prior 20 picks at 0)
      const dr100 = teamMeta.draft_rating_100;     // 0-100 scale anchored to league distribution
      const drN = teamMeta.draft_rating_n_picks || 0;
      const pgc = picks.reduce((acc, p) => { if (p.pos_group) acc[p.pos_group] = (acc[p.pos_group] || 0) + 1; return acc; }, {});
      const off = pgc.offense || 0, defp = pgc.defense || 0, sp = pgc.special || 0;
      const sortedByScore = [...picks].sort((a, b) => (b.overall_score || 0) - (a.overall_score || 0));
      const best = sortedByScore[0];
      const worst = sortedByScore[sortedByScore.length - 1];
      const bang = [...picks].sort((a, b) => (b.value_above_expected || 0) - (a.value_above_expected || 0))[0];
      return {
        team, picks, total, smash, hit, contrib, bust, injBust,
        off, defp, sp,
        smashRate: smash / total,
        hitPlusRate: (smash + hit) / total,
        bustRate: bust / total,
        injBustRate: injBust / total,
        avgPts, drRaw, drShrunk, dr100, drN, ownerKey, best, worst, bang,
      };
    }).sort((a, b) => {
      // Primary sort: Draft Rating (0-100 normalized, shrinkage-adjusted)
      const ar = a.dr100 == null ? -1 : a.dr100;
      const br = b.dr100 == null ? -1 : b.dr100;
      if (br !== ar) return br - ar;
      // Tiebreak by smash rate
      return b.smashRate - a.smashRate;
    });

    grid.innerHTML = teamsSorted.map(t => {
      // Tier bar: Smash → Hit → Contrib → Bust (Injury Bust removed)
      const bar = `
        <div class="tier-bar">
          <div class="b-smash" style="flex-basis: ${(t.smash / t.total * 100)}%"></div>
          <div class="b-hit" style="flex-basis: ${(t.hit / t.total * 100)}%"></div>
          <div class="b-contrib" style="flex-basis: ${(t.contrib / t.total * 100)}%"></div>
          <div class="b-bust" style="flex-basis: ${(t.bust / t.total * 100)}%"></div>
        </div>`;
      const pickRow = (label, p, tip = "", rowKey = "") => p ? `
        <div class="team-row ${rowKey ? "pick-row-click" : ""}" ${rowKey ? `data-row="${rowKey}" style="cursor:help;"` : ""} ${tip ? `title="${tip}"` : ""}>
          <span class="lbl">${label}</span><span>${p.pick_label} ${p.player_name}
          <span class="tier ${tierSlug(p.tier)} tier-click" data-tier="${p.tier}">${p.tier}</span></span>
        </div>` : "";
      const team = t.team;
      const ownerLabel = team.owner_name || team.current_team_name || team.franchise_name || team.franchise_id;
      const tenureLabel = team.tenure || "";
      const nameHistory = (team.team_names || []).join(" → ");
      // Render tier rates in canonical order, only those with counts
      const tierRows = TIER_ORDER.map(tname => {
        const c = { Smash: t.smash, Hit: t.hit, Contrib: t.contrib, Bust: t.bust }[tname] || 0;
        if (!c) return "";
        return `<div class="team-row"><span class="lbl">${tname}</span><span>${(c / t.total * 100).toFixed(0)}%</span></div>`;
      }).join("");
      return `
        <div class="team-card">
          <h3>${ownerLabel}</h3>
          <div class="team-sub">
            ${tenureLabel ? tenureLabel + " · " : ""}${t.total} picks${f.round || f.slot || f.pos || f.pg || f.season ? " (filtered)" : ""}
            ${nameHistory ? `<br><span style="font-size:10px;">${nameHistory}</span>` : ""}
          </div>
          ${bar}
          ${tierRows}
          <div class="team-row" title="Offense / Defense / Special Teams mix">
            <span class="lbl">Side split</span>
            <span>${t.off ? `<span style="color:var(--accent)">${(t.off/t.total*100).toFixed(0)}% O</span>` : ""}${t.off && (t.defp || t.sp) ? " · " : ""}${t.defp ? `<span style="color:var(--warn)">${(t.defp/t.total*100).toFixed(0)}% D</span>` : ""}${t.defp && t.sp ? " · " : ""}${t.sp ? `<span style="color:var(--muted)">${(t.sp/t.total*100).toFixed(0)}% ST</span>` : ""}</span>
          </div>
          ${t.dr100 != null ? (() => {
            const color = t.dr100 >= 70 ? "var(--ok)" : t.dr100 >= 40 ? "var(--text)" : "var(--err)";
            return `<div class="team-row draft-rating-click" data-owner="${escapeHtml(t.ownerKey)}" style="cursor:pointer;" title="Draft Rating: 0-100 normalized from how much each pick outperformed its slot's historical expectation, with small-sample shrinkage. Click for full audit."><span class="lbl">Draft Rating</span><span style="color:${color}; font-weight:700">${t.dr100.toFixed(1)}</span> <span class="small" style="color:var(--muted); font-size:10px;">raw ${t.drRaw > 0 ? '+' : ''}${(t.drRaw * 100).toFixed(1)} · ${t.drN}p</span></div>`;
          })() : ""}
          ${pickRow("Best", t.best, "Highest 3yr NET — the pick with the biggest positive impact on winning. Click for details.", "best")}
          ${pickRow("Bang-for-$", t.bang, "Highest Draft Rating — the pick that outperformed its slot by the biggest margin. A late-round smash beats a 1.01 that merely met expectation. Click for details.", "bang")}
          ${pickRow("Worst", t.worst, "Lowest 3yr NET — the pick with the biggest drag on winning. Click for details.", "worst")}
        </div>
      `;
    }).join("");

    // Wire tier clicks
    grid.querySelectorAll(".tier-click").forEach(el => {
      el.addEventListener("click", () => showTierPopup(el.dataset.tier));
    });
    // Wire Draft Rating click → audit popup
    grid.querySelectorAll(".draft-rating-click").forEach(el => {
      el.addEventListener("click", () => showDraftRatingAudit(el.dataset.owner));
    });
    // Wire Best/Bang/Worst row clicks → explainer popup
    grid.querySelectorAll(".pick-row-click").forEach(el => {
      el.addEventListener("click", (e) => {
        if (e.target.closest(".tier-click")) return;  // tier badges keep their own handler
        showPickRowExplainer(el.dataset.row);
      });
    });
  }

  function showPickRowExplainer(rowKey) {
    const defs = {
      best: {
        title: "Best Pick",
        basic: "The pick that helped this owner's teams win the most. Straight-up highest NET score — the player's good weeks minus bad weeks over 3 years. NET is the single best predictor of All-Play winning %, so this is the pick with the biggest real-world impact.",
        desc: "Highest 3yr games-weighted NET score. NET correlates with AP% at r = +0.850 across 192 team-seasons, which is why we use it (over raw points, tier, or Draft Rating) to identify this owner's most impactful pick. Draft slot doesn't matter here — raw winning impact does.",
      },
      bang: {
        title: "Bang-for-$",
        basic: "The pick where the owner got the most value relative to where they drafted. A late-round smash automatically beats a 1.01 who just met expectations — because hitting from the 6th round is much rarer than hitting from the top.",
        desc: "Highest Draft Rating (actual 3yr NET − slot-expected NET) regardless of tier. Slot-expected NET is low for late slots, so an R5/R6 rookie who becomes a real starter crushes this metric.",
      },
      worst: {
        title: "Worst Pick",
        basic: "The pick that hurt this owner's teams the most. Lowest NET score — the player's dud weeks outweighed his good weeks by the biggest margin.",
        desc: "Lowest 3yr games-weighted NET score. Since NET ties directly to All-Play winning %, this surfaces the pick with the biggest drag on winning — regardless of where in the draft they were taken.",
      },
    };
    const def = defs[rowKey];
    if (!def) return;
    openModal(`
      <h3>${def.title}</h3>
      <div class="profile-block" style="border-top:0; padding-top:0; margin-top:10px; background:rgba(91,141,255,0.08); padding:12px; border-radius:6px;">
        <h4 style="color:var(--accent);">In plain English</h4>
        <p style="margin:0;">${def.basic}</p>
      </div>
      <div class="profile-block">
        <h4>Technical definition</h4>
        <p>${def.desc}</p>
      </div>
      <div class="actions"><button class="btn secondary" onclick="document.getElementById('rdh-modal-overlay').classList.remove('open')">Close</button></div>
    `);
  }

  // ══════════════════════════════════════════════════════════════════════
  // DRAFT RATING AUDIT POPUP — full per-pick breakdown of how the number was built
  // ══════════════════════════════════════════════════════════════════════
  function showDraftRatingAudit(ownerKey) {
    const teamMeta = (STATE.teams.teams || {})[ownerKey] || { owner_name: ownerKey };
    const ownerPicks = STATE.history.picks.filter(p => p.owner_name === ownerKey);
    const audit = ownerPicks
      .filter(p => p.draft_rating != null)
      .sort((a, b) => (b.draft_rating || 0) - (a.draft_rating || 0));
    const drRaw = teamMeta.draft_rating_raw;
    const drShrunk = teamMeta.draft_rating_shrunk;
    const dr100 = teamMeta.draft_rating_100;
    const drN = teamMeta.draft_rating_n_picks || 0;
    const lb = (STATE.teams.league_benchmark || {});
    const shrinkN = lb.draft_rating_shrinkage_n || 20;
    const pct = v => (v == null) ? "—" : (v > 0 ? "+" : "") + (v * 100).toFixed(1);
    openModal(`
      <h3>Draft Rating — ${escapeHtml(ownerKey)}</h3>
      <div class="profile-block" style="border-top:0; padding-top:0; margin-top:10px;">
        <h4>How the number is built</h4>
        <ol style="line-height:1.6; padding-left:18px; margin:6px 0;">
          <li><strong>Per-pick delta</strong>: for each of this owner's ${drN} picks, compute
              <code>actual NET − slot-expected NET</code>. Slot-expected NET = median NET across
              every historical pick at the same (round, slot). Positive delta = the pick outperformed
              the typical pick at that slot.</li>
          <li><strong>Raw Draft Rating</strong> = plain average of those per-pick deltas.</li>
          <li><strong>Shrinkage — plain English:</strong>
              Pretend every owner starts with <strong>${shrinkN} invisible "average" picks already in the books</strong>
              (picks that would have scored exactly 0 — right at slot expectation). Then add their real picks on top.
              This stops a lucky 5-pick streak from looking like a genius draft track record — you need enough
              actual picks to overcome those ${shrinkN} neutral ones. <em>John Richard's +32.7 from 6 picks? The
              ${shrinkN} invisible zeros drag that down to a shrunk value that better reflects what a 6-pick
              sample can realistically prove.</em>
              <br><br>
              <strong>Technical:</strong> Bayesian posterior with an improper prior centered at 0 (the league
              mean) and a pseudo-sample-size of ${shrinkN} picks.
              <code>shrunk = (raw × N) / (N + ${shrinkN})</code> — algebraically equivalent to the posterior
              mean after observing N picks of real data alongside ${shrinkN} picks of zero-effect performance.
              More picks (N) → less shrinkage toward zero.</li>
          <li><strong>0-100 scale</strong>: median shrunk value across all owners = 50; max observed = 100; min = 0; linear in between.</li>
        </ol>
      </div>

      <div class="profile-block">
        <h4>What the values actually mean</h4>
        <ul style="line-height:1.6; padding-left:18px; margin:6px 0;">
          <li><strong>Raw value</strong> (e.g. +${((drRaw || 0) * 100).toFixed(1)} for this owner): their
              picks on average scored <strong>${((drRaw || 0) * 100).toFixed(1)} NET points</strong>
              ${(drRaw || 0) > 0 ? "above" : "below"} what the typical pick at those slots historically produced.
              1 NET point ≈ "1% of starter-weeks shifted between E+P and Dud".</li>
          <li><strong>Shrunk value</strong> (${((drShrunk || 0) * 100).toFixed(1)}): same idea, but conservatively
              corrected for how much data this owner has. Closer to zero than raw.</li>
          <li><strong>0-100 scale</strong> (${dr100 == null ? "—" : dr100.toFixed(1)}): where this owner ranks
              vs the league. 50 = league-median drafter. 100 = best shrunk rating in the league. 0 = worst.
              <em>This is the number the team cards are sorted by.</em></li>
        </ul>
      </div>
      <div class="profile-block">
        <h4>This owner's numbers</h4>
        <table class="rdh-table" style="margin-top:6px;">
          <tbody>
            <tr><td>Picks with measurable outcome</td><td class="num"><strong>${drN}</strong></td></tr>
            <tr><td>Raw Draft Rating (avg Δ vs slot)</td><td class="num"><strong>${drRaw == null ? "—" : (drRaw > 0 ? "+" : "") + (drRaw * 100).toFixed(2)}</strong></td></tr>
            <tr><td>After shrinkage (N + ${shrinkN})</td><td class="num"><strong>${drShrunk == null ? "—" : (drShrunk > 0 ? "+" : "") + (drShrunk * 100).toFixed(2)}</strong></td></tr>
            <tr><td>Normalized 0-100</td><td class="num"><strong style="color:var(--accent); font-size:16px;">${dr100 == null ? "—" : dr100.toFixed(1)}</strong></td></tr>
          </tbody>
        </table>
      </div>
      <div class="profile-block">
        <h4>Per-pick audit (sorted by contribution)</h4>
        <table class="rdh-table">
          <thead><tr>
            <th>Yr</th><th>Pick</th><th>Player</th><th>Pos</th>
            <th class="num">Actual NET</th>
            <th class="num">Slot-Exp NET</th>
            <th class="num">Δ vs slot</th>
            <th>Tier</th>
          </tr></thead>
          <tbody>${audit.map(p => {
            const drColor = p.draft_rating > 0.10 ? "var(--ok)" : p.draft_rating < -0.10 ? "var(--err)" : "";
            return `
            <tr>
              <td>${p.season}</td>
              <td>${p.pick_label}</td>
              <td>${escapeHtml(p.player_name || "?")}</td>
              <td>${POS_COMBINED(p.position) || ""}</td>
              <td class="num">${pct(p.net_score_3yr)}</td>
              <td class="num">${pct(p.expected_net_3yr)}</td>
              <td class="num" style="color:${drColor}">${pct(p.draft_rating)}</td>
              <td><span class="tier ${tierSlug(p.tier)} tier-click" data-tier="${p.tier}">${p.tier}</span></td>
            </tr>`;
          }).join("")}</tbody>
        </table>
      </div>
      <div class="actions"><button class="btn secondary" onclick="document.getElementById('rdh-modal-overlay').classList.remove('open')">Close</button></div>
    `);
  }

  // ══════════════════════════════════════════════════════════════════════
  // DRAFT-DAY TRADES
  // ══════════════════════════════════════════════════════════════════════
  function renderDayTrades() {
    // Draft Day Trades is Under Construction — bail gracefully.
    const list = document.getElementById("day-trades-list");
    if (!list) return;
    const filter = document.getElementById("dd-season").value;
    const by = STATE.day_trades.trades_by_season;
    const seasons = Object.keys(by).filter(s => !filter || s === filter).sort((a, b) => b - a);
    const fragments = [];
    for (const season of seasons) {
      const trades = by[season];
      fragments.push(`<h3 style="margin-top: 18px; border-bottom: 1px solid var(--border); padding-bottom: 6px;">${season} — ${trades.length} trades</h3>`);
      for (const t of trades) {
        const sides = Object.values(t.sides);
        const sideHtml = sides.map(s => `
          <div style="flex: 1; padding: 10px; background: var(--panel-alt); border-radius: 4px;">
            <strong>${s.franchise_name}</strong>
            <div class="small" style="margin-top: 6px;"><span style="color:var(--muted)">Gave:</span> ${s.gave_up.map(formatAsset).join(", ") || "—"}</div>
            <div class="small"><span style="color:var(--muted)">Got:</span> ${s.received.map(formatAsset).join(", ") || "—"}</div>
          </div>
        `).join("");
        fragments.push(`
          <div class="rdh-card" style="margin: 8px 0;">
            <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
              <div class="small" style="color:var(--muted)">${t.datetime_et} · ${t.hours_from_first_pick > 0 ? "+" : ""}${t.hours_from_first_pick}h from draft start</div>
              ${t.comments ? `<div class="small" style="font-style: italic; color:var(--muted)">"${t.comments.slice(0, 120)}"</div>` : ""}
            </div>
            <div style="display: flex; gap: 8px;">${sideHtml}</div>
          </div>
        `);
      }
    }
    list.innerHTML = fragments.join("") || "<p class='loading'>No trades in window</p>";
  }

  function formatAsset(a) {
    if (a.type === "player") return a.player_name || `Player #${a.player_id}`;
    if (a.type === "current_pick") {
      return a.label || (a.slot != null
        ? `${a.season} ${a.round}.${String(a.slot).padStart(2, "0")} pick`
        : `${a.season} R${a.round} pick`);
    }
    if (a.type === "future_pick") {
      const base = a.label || `${a.year} R${a.round} pick`;
      if (a.became) {
        return `${base} <span class="small" style="color:var(--muted)">→ became ${a.became.pick_label} (${a.became.player_name || "?"})</span>`;
      }
      return base;
    }
    return "?";
  }

  // ══════════════════════════════════════════════════════════════════════
  // R6 DRAFT ORDER SELECTION COUNTDOWN
  // ══════════════════════════════════════════════════════════════════════
  function _refreshCommishGating() {
    const btn = document.getElementById("r6-start-btn");
    if (!btn) return;
    if (STATE.me && STATE.me.is_commish) {
      btn.disabled = false;
      btn.title = "Start the official R6 order drawing";
    } else {
      btn.disabled = true;
      btn.title = "Only the commissioner can run the official drawing";
    }
  }

  function _startR6EventCountdown() {
    // Target: May 2, 2026 at 6:00 PM ET. ET = UTC-5 (standard) / UTC-4 (DST);
    // early May is DST so UTC-4 → target = 22:00 UTC.
    const target = Date.UTC(2026, 4, 2, 22, 0, 0);
    const timerEl = document.getElementById("r6-event-countdown");
    const labelEl = document.getElementById("r6-event-countdown-label");
    if (!timerEl) return;
    function tick() {
      const now = Date.now();
      const ms = target - now;
      if (ms <= 0) {
        timerEl.textContent = "LIVE";
        timerEl.style.color = "var(--err)";
        if (labelEl) labelEl.textContent = "Commish: kick off the official drawing above.";
        return;
      }
      const days = Math.floor(ms / 86400000);
      const hrs = Math.floor((ms % 86400000) / 3600000);
      const mins = Math.floor((ms % 3600000) / 60000);
      const secs = Math.floor((ms % 60000) / 1000);
      timerEl.textContent = `${days}d ${String(hrs).padStart(2,"0")}:${String(mins).padStart(2,"0")}:${String(secs).padStart(2,"0")}`;
    }
    tick();
    setInterval(tick, 1000);
  }

  function r6Reset() {
    STATE.r6_running = false;
    STATE.r6_simulate = false;
    STATE.r6_order = [];
    document.getElementById("r6-countdown").innerHTML = "";
    document.querySelector("#r6-order-table tbody").innerHTML = "";
  }

  async function r6Start(isSimulate) {
    if (STATE.r6_running) return;
    r6Reset();
    STATE.r6_running = true;
    STATE.r6_simulate = isSimulate;
    const cd = document.getElementById("r6-countdown");
    const franchises = Object.entries(STATE.live.franchises || {});
    if (franchises.length < 12) {
      cd.innerHTML = `<p class="small" style="color:var(--err)">Need 12 franchises in live state to run selection.</p>`;
      return;
    }
    // Reverse order of selection: pick 12 first, down to pick 1
    // For simulation, use franchises in random order. For official, we'd take
    // the submitted deadline-ordered list. For MVP we cycle franchises shuffled.
    const pool = franchises.slice();
    if (isSimulate) {
      pool.sort(() => Math.random() - 0.5);
    }
    const banner = isSimulate
      ? `<div class="r6-banner r6-sim">SIMULATION MODE · non-binding</div>`
      : `<div class="r6-banner">OFFICIAL SELECTION · May 2, 2026 @ 6:00 PM ET</div>`;
    cd.innerHTML = banner + `<div class="r6-timer" id="r6-timer"></div><div class="r6-now" id="r6-now"></div>`;

    for (let pickIndex = 12; pickIndex >= 1; pickIndex--) {
      // 10-second countdown
      for (let s = 10; s > 0; s--) {
        document.getElementById("r6-timer").textContent = s;
        document.getElementById("r6-now").textContent = `Pick ${pickIndex} coming up…`;
        await sleep(1000);
        if (!STATE.r6_running) return;
      }
      const [fid, fname] = pool[pickIndex - 1];
      STATE.r6_order.unshift({ pick: pickIndex, franchise_id: fid, franchise_name: fname, at: new Date() });
      r6AppendOrder({ pick: pickIndex, franchise_name: fname, at: new Date() });
      document.getElementById("r6-timer").textContent = "";
      document.getElementById("r6-now").innerHTML = `
        <div class="r6-announce">Pick ${pickIndex}: <strong>${fname}</strong></div>
      `;
      await sleep(3000);
      if (!STATE.r6_running) return;
    }
    document.getElementById("r6-now").innerHTML = `<div class="r6-announce">R6 Draft Order Complete ${isSimulate ? "(simulation)" : "✓"}</div>`;
    STATE.r6_running = false;
  }

  function r6AppendOrder(entry) {
    const tbody = document.querySelector("#r6-order-table tbody");
    const row = document.createElement("tr");
    row.innerHTML = `<td>${entry.pick}</td><td>${entry.franchise_name}</td><td class="small">${entry.at.toLocaleTimeString()}</td>`;
    tbody.insertBefore(row, tbody.firstChild);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ══════════════════════════════════════════════════════════════════════
  // PICK + TRADE MODALS (reused from prior wiring)
  // ══════════════════════════════════════════════════════════════════════
  function openPickConfirmModal(active, prospect) {
    const fid = active.franchise_id || active.owned_by_franchise_id;
    const fname = STATE.live.franchises[fid] || fid;
    openModal(`
      <h3>Confirm Pick</h3>
      <p>
        <strong>${fname}</strong> selects <strong>${prospect.name}</strong> (${prospect.position}) at <strong>${active.round}.${String(active.pick).padStart(2, "0")}</strong>.
      </p>
      <p class="small" style="color: var(--muted)">
        POSTs to MFL <code>draftResults</code>. If your API key isn't franchise-authorized, paste your MFL_USER_ID below.
      </p>
      <label style="display:flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--muted); margin-top: 6px;">
        MFL_USER_ID cookie (optional)
        <input type="text" id="pick-user-id" placeholder="blank = use league API key">
      </label>
      <div class="actions">
        <button class="btn secondary" onclick="document.getElementById('rdh-modal-overlay').classList.remove('open')">Cancel</button>
        <button class="btn" id="confirm-pick-go">Submit Pick</button>
      </div>
      <div id="pick-result" style="margin-top: 10px;"></div>
    `);
    document.getElementById("confirm-pick-go").addEventListener("click", async () => {
      const userId = document.getElementById("pick-user-id").value.trim();
      const result = document.getElementById("pick-result");
      result.innerHTML = `<div class="small" style="color: var(--muted)">Submitting…</div>`;
      try {
        if (!prospect.player_id) {
          result.innerHTML = `<div style="color: var(--err)">Prospect has no MFL player_id — rebuild the prospect board.</div>`;
          return;
        }
        const payload = { franchise_id: fid, player_id: String(prospect.player_id) };
        if (userId) payload.user_id = userId;
        const r = await fetch("/api/pick", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await r.json();
        if (data.ok) {
          result.innerHTML = `<div style="color: var(--ok)">Pick submitted to MFL.</div>`;
        } else {
          result.innerHTML = `<div style="color: var(--err)">Failed: HTTP ${data.status}. ${escapeHtml(data.mfl_response || "").slice(0, 400)}</div>`;
        }
      } catch (e) {
        result.innerHTML = `<div style="color: var(--err)">Error: ${escapeHtml(String(e))}</div>`;
      }
    });
  }

  async function openTradeModal() {
    const franchises = STATE.live.franchises || {};
    const me = STATE.me || {};
    if (!me.configured) {
      openModal(`
        <h3>Log in</h3>
        <p class="small" style="color: var(--muted)">
          Paste your MFL_USER_ID cookie. The hub detects your franchise
          automatically from MFL — no manual selection needed.
        </p>
        <label style="font-size:11px; color: var(--muted); display:block; margin-top: 8px;">
          MFL_USER_ID cookie
          <input type="password" id="login-cookie" style="width:100%; padding:6px;" placeholder="paste from your browser cookie jar">
        </label>
        <div class="actions">
          <button class="btn secondary" onclick="document.getElementById('rdh-modal-overlay').classList.remove('open')">Cancel</button>
          <button class="btn" id="login-save">Save</button>
        </div>
        <div id="login-result" class="small" style="margin-top:8px;"></div>
      `);
      document.getElementById("login-save").addEventListener("click", async () => {
        const cookie = document.getElementById("login-cookie").value.trim();
        const res = document.getElementById("login-result");
        if (!cookie) { res.style.color = "var(--err)"; res.textContent = "Cookie required."; return; }
        res.style.color = ""; res.textContent = "Detecting franchise from MFL…";
        try {
          const r = await fetch("/api/settings", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mfl_user_id: cookie }),
          });
          const data = await r.json();
          if (!r.ok || !data.franchise_id) {
            res.style.color = "var(--err)";
            res.textContent = data.error || "MFL did not recognize this cookie.";
            return;
          }
          STATE.me = { configured: true, franchise_id: data.franchise_id, franchise_name: data.franchise_name };
          res.style.color = "var(--ok)";
          res.textContent = `Logged in as ${data.franchise_name}. Re-opening trade dialog…`;
          setTimeout(() => openTradeModal(), 600);
        } catch (e) { res.style.color = "var(--err)"; res.textContent = String(e); }
      });
      return;
    }

    const myFid = me.franchise_id;
    const myName = franchises[myFid] || myFid;
    const toOptions = Object.entries(franchises)
      .filter(([id]) => id !== myFid)
      .sort((a,b) => a[1].localeCompare(b[1]))
      .map(([id, name]) => `<option value="${id}">${name}</option>`).join("");
    openModal(`
      <h3>Propose Trade <span class="small" style="color:var(--muted); font-weight:400;">as ${escapeHtml(myName)} (${myFid})</span></h3>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
        <div>
          <h4 style="font-size:12px; text-transform:uppercase; color:var(--muted); margin:0 0 6px;">Giving up (from your team)</h4>
          <div id="trade-give-picker" class="trade-asset-picker"></div>
          <div id="trade-give-basket" class="trade-basket"></div>
        </div>
        <div>
          <label style="font-size:11px; color: var(--muted);">
            Trade partner
            <select id="trade-to" style="width:100%; padding: 6px;">${toOptions}</select>
          </label>
          <h4 style="font-size:12px; text-transform:uppercase; color:var(--muted); margin:10px 0 6px;">Receiving</h4>
          <div id="trade-receive-picker" class="trade-asset-picker"></div>
          <div id="trade-receive-basket" class="trade-basket"></div>
        </div>
      </div>
      <label style="font-size: 11px; color: var(--muted); display: block; margin-top: 10px;">
        Blind Bid $ (optional)
        <div style="display:flex; gap:6px; margin-top:4px;">
          <input type="number" id="trade-bb-amt" placeholder="5000" style="flex:1; padding: 6px;" min="0" step="100">
          <select id="trade-bb-side" style="padding:6px;"><option value="give">Add to giving</option><option value="receive">Add to receiving</option></select>
          <button class="btn secondary" id="trade-bb-add" style="padding: 4px 10px;">Add BB$</button>
        </div>
      </label>
      <label style="font-size: 11px; color: var(--muted); display: block; margin-top: 10px;">
        Comments <input type="text" id="trade-comments" style="width:100%; padding: 6px;">
      </label>
      <div class="actions">
        <button class="btn secondary" onclick="document.getElementById('rdh-modal-overlay').classList.remove('open')">Cancel</button>
        <button class="btn" id="propose-trade-go">Submit Proposal</button>
      </div>
      <div id="trade-result" style="margin-top: 10px;"></div>
    `);

    const basket = { give: [], receive: [] };

    async function loadAndRender(side) {
      const fid = side === "give" ? myFid : document.getElementById("trade-to").value;
      const pickerEl = document.getElementById(`trade-${side}-picker`);
      pickerEl.innerHTML = `<div class="small" style="color:var(--muted)">Loading ${franchises[fid] || fid}'s assets…</div>`;
      try {
        const r = await fetch(`/api/franchise-assets?fid=${encodeURIComponent(fid)}`);
        const data = await r.json();
        const renderGroup = (label, items, kind) => {
          if (!items || !items.length) return "";
          return `
            <div style="margin-top:8px;">
              <div style="font-size:10px; text-transform:uppercase; color:var(--muted); letter-spacing:0.3px;">${label}</div>
              <input type="search" placeholder="Filter ${label.toLowerCase()}..."
                     data-filter-target="asset-${side}-${kind}"
                     style="width:100%; padding:4px 6px; margin-top:3px; font-size:12px;">
              <div data-asset-list="asset-${side}-${kind}" style="max-height:140px; overflow-y:auto; border:1px solid var(--border); border-radius:4px; padding:2px; margin-top:2px;">
                ${items.map(it => `
                  <div class="trade-asset-row" data-asset-id="${escapeHtml(it.asset_id)}" data-display="${escapeHtml(it.display)}" data-kind="${kind}"
                       style="padding:3px 6px; cursor:pointer; font-size:12px; border-bottom:1px solid var(--border);">
                    ${escapeHtml(it.display)}
                    ${it.position ? `<span class="small" style="color:var(--muted); margin-left:6px;">${escapeHtml(it.position)}</span>` : ""}
                    ${it.salary ? `<span class="small" style="color:var(--muted); margin-left:6px;">$${Math.round(it.salary).toLocaleString()}</span>` : ""}
                  </div>`).join("")}
              </div>
            </div>`;
        };
        pickerEl.innerHTML =
          renderGroup("Players", data.players, "player") +
          renderGroup("Future Picks", data.future_picks, "fp") +
          renderGroup("Current-Year Picks", data.current_picks, "dp");

        // Wire search inputs
        pickerEl.querySelectorAll("input[data-filter-target]").forEach(inp => {
          inp.addEventListener("input", e => {
            const target = pickerEl.querySelector(`[data-asset-list="${inp.dataset.filterTarget}"]`);
            const q = e.target.value.toLowerCase();
            target.querySelectorAll(".trade-asset-row").forEach(row => {
              row.style.display = row.dataset.display.toLowerCase().includes(q) ? "" : "none";
            });
          });
        });
        // Wire click-to-add
        pickerEl.querySelectorAll(".trade-asset-row").forEach(row => {
          row.addEventListener("click", () => {
            const existing = basket[side].find(x => x.asset_id === row.dataset.assetId);
            if (existing) return;
            basket[side].push({ asset_id: row.dataset.assetId, display: row.dataset.display, kind: row.dataset.kind });
            renderBasket(side);
          });
        });
      } catch (e) {
        pickerEl.innerHTML = `<div class="small" style="color:var(--err)">Failed to load assets: ${escapeHtml(String(e))}</div>`;
      }
    }

    function renderBasket(side) {
      const el = document.getElementById(`trade-${side}-basket`);
      if (!basket[side].length) {
        el.innerHTML = '<div class="small" style="color:var(--muted); padding:8px 0;">(no assets selected)</div>';
        return;
      }
      el.innerHTML = basket[side].map((a, i) => `
        <div style="display:flex; justify-content:space-between; align-items:center; background:var(--panel-alt); padding:4px 8px; border-radius:4px; margin-top:4px; font-size:12px;">
          <span>${escapeHtml(a.display)}</span>
          <button class="btn secondary" data-side="${side}" data-idx="${i}" style="padding:0 8px; font-size:11px;">✕</button>
        </div>`).join("");
      el.querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
        basket[b.dataset.side].splice(parseInt(b.dataset.idx, 10), 1);
        renderBasket(b.dataset.side);
      }));
    }

    document.getElementById("trade-to").addEventListener("change", () => { basket.receive = []; renderBasket("receive"); loadAndRender("receive"); });

    // Blind-bid button
    document.getElementById("trade-bb-add").addEventListener("click", () => {
      const amt = parseInt(document.getElementById("trade-bb-amt").value, 10);
      const side = document.getElementById("trade-bb-side").value;
      if (!(amt > 0)) return;
      basket[side].push({ asset_id: `BB_${amt}`, display: `Blind Bid $${amt.toLocaleString()}`, kind: "bb" });
      renderBasket(side);
    });

    // Initial load
    renderBasket("give"); renderBasket("receive");
    loadAndRender("give"); loadAndRender("receive");

    document.getElementById("propose-trade-go").addEventListener("click", async () => {
      const toFid = document.getElementById("trade-to").value;
      const give = basket.give.map(a => a.asset_id);
      const receive = basket.receive.map(a => a.asset_id);
      const comments = document.getElementById("trade-comments").value;
      const result = document.getElementById("trade-result");
      if (!give.length && !receive.length) {
        result.innerHTML = `<div style="color:var(--err)">Select at least one asset on either side.</div>`;
        return;
      }
      result.innerHTML = `<div class="small" style="color: var(--muted)">Submitting…</div>`;
      try {
        const r = await fetch("/api/trade", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from_fid: myFid, to_fid: toFid, give, receive, comments }),
        });
        const data = await r.json();
        if (data.ok) result.innerHTML = `<div style="color: var(--ok)">Trade proposed.</div>`;
        else result.innerHTML = `<div style="color: var(--err)">Failed: ${escapeHtml(data.error || data.mfl_response || JSON.stringify(data)).slice(0, 400)}</div>`;
      } catch (e) {
        result.innerHTML = `<div style="color: var(--err)">Error: ${escapeHtml(String(e))}</div>`;
      }
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"
    }[c]));
  }

  // ══════════════════════════════════════════════════════════════════════
  // Main render pipeline
  // ══════════════════════════════════════════════════════════════════════
  function renderAll() {
    renderLive();
    renderHistory();
    renderTeams();
    renderDayTrades();
    renderApEp();
    renderFuturePicks();
  }

  // ══════════════════════════════════════════════════════════════════════
  // FUTURE DRAFT PICKS
  // ══════════════════════════════════════════════════════════════════════
  const FP_STATE = { year: "", owner: "", original: "", round: "" };

  function renderFuturePicks() {
    const fp = STATE.future_picks;
    const tbody = document.getElementById("fp-tbody");
    const summary = document.getElementById("fp-summary");
    const note = document.getElementById("future-picks-note");
    if (!fp || !fp.picks) { tbody.innerHTML = '<tr><td colspan="6">No data</td></tr>'; return; }
    if (note) note.textContent = fp.meta?.projection_note || "";

    // Hydrate filter dropdowns (once)
    const yearEl = document.getElementById("fp-year");
    const ownerEl = document.getElementById("fp-owner");
    const origEl = document.getElementById("fp-original");
    if (yearEl && !yearEl.dataset.hydrated) {
      const years = [...new Set(fp.picks.map(p => p.year).filter(Boolean))].sort();
      for (const y of years) yearEl.insertAdjacentHTML("beforeend", `<option value="${y}">${y}</option>`);
      yearEl.dataset.hydrated = "1";
    }
    const allOwners = [...new Set(fp.picks.flatMap(p => [p.current_owner_name, p.original_owner_name]).filter(Boolean))].sort();
    if (ownerEl && !ownerEl.dataset.hydrated) {
      for (const o of allOwners) ownerEl.insertAdjacentHTML("beforeend", `<option value="${o}">${o}</option>`);
      ownerEl.dataset.hydrated = "1";
    }
    if (origEl && !origEl.dataset.hydrated) {
      for (const o of allOwners) origEl.insertAdjacentHTML("beforeend", `<option value="${o}">${o}</option>`);
      origEl.dataset.hydrated = "1";
    }

    const f = FP_STATE;
    let rows = fp.picks.filter(p =>
      (!f.year || p.year === f.year) &&
      (!f.round || String(p.round) === f.round) &&
      (!f.owner || p.current_owner_name === f.owner) &&
      (!f.original || p.original_owner_name === f.original)
    );
    // Sort: year asc, round asc, projected slot asc, then owner
    rows.sort((a, b) => {
      if (a.year !== b.year) return (a.year || "").localeCompare(b.year || "");
      if (a.round !== b.round) return (a.round || 0) - (b.round || 0);
      if ((a.projected_slot || 99) !== (b.projected_slot || 99)) return (a.projected_slot || 99) - (b.projected_slot || 99);
      return (a.current_owner_name || "").localeCompare(b.current_owner_name || "");
    });

    tbody.innerHTML = rows.map(p => {
      const traded = p.current_owner_fid !== p.original_owner_fid;
      const nonTradeable = p.tradeable === false;
      return `
        <tr style="${nonTradeable ? 'opacity:0.75;' : ''}">
          <td>${p.year}</td>
          <td>R${p.round}${nonTradeable ? ' <span class="small" style="color:var(--muted); font-size:10px;">(non-tradeable)</span>' : ''}</td>
          <td>${escapeHtml(p.current_owner_name)}</td>
          <td>${escapeHtml(p.original_owner_name)}${traded ? ' <span class="small" style="color:var(--warn)"> (traded)</span>' : ''}</td>
          <td>${p.projected_pick_label || '<span class="small" style="color:var(--muted)">—</span>'}</td>
          <td>${traded ? '<span style="color:var(--warn)">Yes</span>' : '<span class="small" style="color:var(--muted)">No</span>'}</td>
        </tr>`;
    }).join("");
    summary.textContent = `${rows.length} future picks · ${rows.filter(r => r.current_owner_fid !== r.original_owner_fid).length} traded`;

    // Projection Basis table — optional (card was removed in the simplified UI;
    // keep the population logic so if a future version re-adds it, it just works).
    const basisEl = document.getElementById("fp-basis-tbody");
    if (!basisEl) return;  // simplified UI — skip, don't throw
    if (basisEl && fp.projection_basis) {
      // Find the likely Toilet Bowl winner (smallest |Δ 7|)
      const tbWinner = fp.projection_basis.reduce((best, r) => {
        if (r.delta_from_7 == null) return best;
        if (!best || r.delta_from_7 < best.delta_from_7) return r;
        return best;
      }, null);
      basisEl.innerHTML = fp.projection_basis.map(r => {
        const isTB = !!r.is_toilet_bowl;
        // Helper: format Δ (positive is green for rally/try, negative red for shit-bed/tank)
        const fmtDelta = (v) => {
          if (v == null) return `<span class="small" style="color:var(--muted)">—</span>`;
          const pct = (v * 100).toFixed(0);
          const sign = v > 0 ? "+" : "";
          const color = v >= 0.08 ? "var(--ok)" : v <= -0.08 ? "var(--err)" : v < 0 ? "var(--warn)" : "var(--text)";
          return `<span style="color:${color}">${sign}${pct}</span>`;
        };
        const shift = r.rank_shift;
        const shiftColor = shift == null ? "" : shift < -1 ? "color:var(--ok); font-weight:600" : shift > 1 ? "color:var(--err); font-weight:600" : "color:var(--muted)";
        const shiftText = shift == null ? "—" : (shift > 0 ? "+" : "") + shift.toFixed(1);
        let slotLabel = "—";
        if (r.projected_slot_label) {
          const ord = r.projected_ordinal;
          const finishText = ord === 1 ? "proj 1st (champion)"
                           : ord === 7 ? "proj 7th (Toilet Bowl)"
                           : ord === 12 ? "proj 12th (last)"
                           : `proj finish ${ord}`;
          slotLabel = `<strong${isTB ? ' style="color:var(--warn)"' : ''}>${r.projected_slot_label}</strong>
                       <span class="small" style="color:var(--muted)">${finishText}</span>`;
        }
        const appliedNote = r.adjustment_source === "playoff_bracket"
          ? `<span class="small" style="color:var(--muted)">(PO Δ)</span>`
          : r.adjustment_source === "tb_bracket"
          ? `<span class="small" style="color:var(--muted)">(TB Δ)</span>`
          : "";
        return `<tr${isTB ? ' style="background: rgba(251,191,36,0.08)"' : ''}>
          <td>${escapeHtml(r.current_owner || "?")}
            <div class="small" style="color:var(--muted); font-size:10px;">${escapeHtml(r.franchise_name)}</div>
          </td>
          <td class="num"><strong>${r.avg_ap_pct != null ? (r.avg_ap_pct * 100).toFixed(0) : "—"}%</strong></td>
          <td class="num">${r.base_rank != null ? r.base_rank : "—"}</td>
          <td class="num">${fmtDelta(r.playoff_delta)}<br><span class="small" style="color:var(--muted); font-size:10px;">${r.playoff_bracket_years || 0}yr</span></td>
          <td class="num">${fmtDelta(r.tb_delta)}<br><span class="small" style="color:var(--muted); font-size:10px;">${r.tb_bracket_years || 0}yr</span></td>
          <td class="num">${fmtDelta(r.applied_delta)} ${appliedNote}</td>
          <td class="num" style="${shiftColor}">${shiftText}</td>
          <td class="num"><strong>${r.projected_ordinal || "—"}</strong></td>
          <td>${slotLabel}</td>
        </tr>`;
      }).join("");
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // AP vs E+P sub-page (throwaway)
  // ══════════════════════════════════════════════════════════════════════
  function hydrateApEpFilters() {
    const d = STATE.ap_ep;
    if (!d || !d.rows) return;
    const seasons = [...new Set(d.rows.map(r => r.season))].sort((a, b) => b - a);
    const seasonSel = document.getElementById("ae-season");
    for (const s of seasons) seasonSel.insertAdjacentHTML("beforeend", `<option value="${s}">${s}</option>`);
    rebuildApEpOwnerDropdown();

    const bindings = [["ae-season", "season"], ["ae-owner", "owner"], ["ae-active", "active"]];
    for (const [id, key] of bindings) {
      document.getElementById(id).addEventListener("change", e => {
        STATE.ae_filters[key] = e.target.value;
        if (key === "active") rebuildApEpOwnerDropdown();
        renderApEp();
      });
    }
    document.getElementById("ae-search").addEventListener("input", e => {
      STATE.ae_filters.search = e.target.value.toLowerCase();
      renderApEp();
    });
    document.querySelectorAll("#ae-table th[data-sort]").forEach(th => {
      th.addEventListener("click", () => {
        const k = th.dataset.sort;
        if (STATE.ae_sort === k) STATE.ae_sort_dir = -STATE.ae_sort_dir;
        else { STATE.ae_sort = k; STATE.ae_sort_dir = 1; }
        renderApEp();
      });
    });
  }

  function rebuildApEpOwnerDropdown() {
    const d = STATE.ap_ep;
    if (!d || !d.rows) return;
    const sel = document.getElementById("ae-owner");
    const cur = STATE.ae_filters.owner;
    const flt = STATE.ae_filters.active;
    const byOwner = new Map();
    for (const r of d.rows) {
      const key = r.owner_name || "(Unknown)";
      if (!byOwner.has(key)) byOwner.set(key, { owner: key, active: r.owner_active });
      else if (r.owner_active) byOwner.get(key).active = true; // any season active ⇒ treat as active-capable
    }
    const owners = [...byOwner.values()].filter(o => {
      if (flt === "active") return o.active;
      if (flt === "retired") return !o.active;
      return true;
    }).sort((a, b) => a.owner.localeCompare(b.owner));
    sel.innerHTML = '<option value="">All</option>';
    for (const o of owners) {
      const status = o.active ? "" : " [retired]";
      sel.insertAdjacentHTML("beforeend",
        `<option value="${o.owner}"${o.owner === cur ? " selected" : ""}>${o.owner}${status}</option>`);
    }
  }

  function renderApEp() {
    const d = STATE.ap_ep;
    const tbody = document.getElementById("ae-tbody");
    const summaryEl = document.getElementById("ae-summary");
    const seasonBody = document.getElementById("ae-season-summary");
    if (!d || !d.rows) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="14">No AP/EP data</td></tr>';
      return;
    }
    const f = STATE.ae_filters;
    let rows = d.rows.slice();
    if (f.season) rows = rows.filter(r => String(r.season) === f.season);
    if (f.owner) rows = rows.filter(r => (r.owner_name || "") === f.owner);
    if (f.active === "active") rows = rows.filter(r => r.owner_active);
    else if (f.active === "retired") rows = rows.filter(r => !r.owner_active);
    if (f.search) {
      const s = f.search;
      rows = rows.filter(r =>
        (r.owner_name || "").toLowerCase().includes(s) ||
        (r.franchise_name || "").toLowerCase().includes(s));
    }

    // Sort
    const k = STATE.ae_sort, dir = STATE.ae_sort_dir;
    rows.sort((a, b) => {
      const va = a[k], vb = b[k];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "string") return dir * va.localeCompare(vb);
      return dir * (va - vb);
    });

    const pct = v => v == null ? "—" : (v * 100).toFixed(1) + "%";
    const num = (v, dec = 1) => v == null ? "—" : Number(v).toFixed(dec);
    const deltaColor = d => d == null ? "" : d < 0 ? `style="color:var(--ok)"` : d > 0 ? `style="color:var(--err)"` : "";

    const netFmt = (v) => v == null ? "—" : (v > 0 ? "+" : "") + (v * 100).toFixed(0);
    const netColor = (v) => v == null ? "" : v >= 0.30 ? "color:var(--smash)" : v >= 0.15 ? "color:var(--hit)" : v >= 0 ? "color:var(--contrib)" : "color:var(--bust)";
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td>${r.season}</td>
        <td>${r.owner_name || "—"}${r.owner_active ? "" : ' <span class="small" style="color:var(--muted)">[retired]</span>'}</td>
        <td>${r.franchise_name || "—"}</td>
        <td class="num">${r.ap_rank ?? "—"}</td>
        <td class="num">${pct(r.ap_pct)}</td>
        <td class="num">${r.ap_w}-${r.ap_l}</td>
        <td class="num">${r.ep_rank ?? "—"}</td>
        <td class="num">${pct(r.ep_rate)}</td>
        <td class="num" style="color:var(--bust)">${pct(r.dud_rate)}</td>
        <td class="num" style="${netColor(r.net_score)}"><strong>${netFmt(r.net_score)}</strong></td>
        <td class="num">${pct(r.off_ep_rate)}</td>
        <td class="num">${pct(r.def_ep_rate)}</td>
        <td class="num" ${deltaColor(r.rank_delta)}>${r.rank_delta > 0 ? "+" : ""}${r.rank_delta ?? "—"}</td>
        <td class="num">${r.starter_weeks}</td>
        <td class="num">${num(r.pf, 0)}</td>
        <td class="num">${num(r.eff, 1)}</td>
      </tr>
    `).join("");

    // Summary stats on filtered set
    const epVals = rows.map(r => r.ep_rate).filter(v => v != null);
    const apVals = rows.map(r => r.ap_pct).filter(v => v != null);
    const corr = pearson(apVals, epVals);
    summaryEl.textContent =
      `${rows.length} team-seasons · avg E+P ${pct(epVals.reduce((a,b)=>a+b,0)/epVals.length)} · ` +
      `avg AP ${pct(apVals.reduce((a,b)=>a+b,0)/apVals.length)} · ` +
      `Pearson corr(AP%, E+P%) = ${corr.toFixed(3)}`;

    // Season summary table
    seasonBody.innerHTML = (d.season_summary || []).map(s => `
      <tr>
        <td>${s.season}</td>
        <td class="num">${s.n_teams}</td>
        <td class="num">${pct(s.league_avg_ep)}</td>
        <td class="num" style="color:var(--ok)">${pct(s.top3_avg_ep)}</td>
        <td class="num" style="color:var(--err)">${pct(s.bot3_avg_ep)}</td>
      </tr>
    `).join("");

    // Correlations table
    const corrEl = document.getElementById("ae-correlations");
    if (corrEl && d.correlations) {
      const c = d.correlations;
      // PPG correlation is computed client-side from the per-team-season rows
      // (pf / h2h games) — not yet materialized in the backend correlations dict.
      const ppgPairs = (d.rows || []).map(r => {
        const g = (r.h2h_w || 0) + (r.h2h_l || 0);
        const ppg = g > 0 && typeof r.pf === "number" ? r.pf / g : null;
        return [r.ap_pct, ppg];
      }).filter(([ap, ppg]) => typeof ap === "number" && typeof ppg === "number");
      const ppgR = ppgPairs.length >= 2
        ? pearson(ppgPairs.map(p => p[0]), ppgPairs.map(p => p[1]))
        : null;
      const rows = [
        ["Overall NET (E+P − 0.5×Dud)", c.overall_net_score, "Current tier classifier — best single predictor"],
        ["Overall E+P rate", c.overall_ep_rate, "Hitting elite-starter weeks"],
        ["Offense E+P rate", c.offense_ep_rate, "Strongest single signal"],
        ["Overall Dud rate", c.overall_dud_rate, "Negative — avoiding stinkers matters"],
        ["Offense Dud rate", c.offense_dud_rate, "Negative — offense duds cost you"],
        ["Defense Dud rate", c.defense_dud_rate, "Negative — defense duds cost more than defense E+P gains"],
        ["Defense E+P rate", c.defense_ep_rate, "Weak — defense is a threshold/gate, not a linear lever"],
        ["Points For (raw)", c.points_for, "Raw PF — ignores week-matching context"],
        ["PPG", ppgR, "Points per regular-season game (pf ÷ H2H games)"],
      ];
      const fmtR = (r) => r == null ? "—" : (r >= 0 ? "+" : "") + r.toFixed(3);
      const colorR = (r) => r == null ? "" : Math.abs(r) >= 0.7 ? "color:var(--ok); font-weight:600" : Math.abs(r) >= 0.4 ? "color:var(--text)" : "color:var(--muted)";
      const html = rows.map(([label, r, note]) => `
        <tr>
          <td>${label}</td>
          <td class="num" style="${colorR(r)}">${fmtR(r)}</td>
          <td class="small" style="color:var(--muted)">${note}</td>
        </tr>`).join("")
        + `<tr><td colspan="3" class="small" style="color:var(--muted); padding-top:8px;">
             n = ${c.n_team_seasons} team-seasons. |r| ≥ 0.7 = very strong; 0.4-0.7 = moderate; &lt; 0.4 = weak.
           </td></tr>`;
      corrEl.innerHTML = html;
      // Also mirror to Calculations tab
      const calcEl = document.getElementById("calc-correlations");
      if (calcEl) calcEl.innerHTML = html;
    }
  }

  function pearson(x, y) {
    const n = Math.min(x.length, y.length);
    if (n < 2) return 0;
    const mx = x.slice(0, n).reduce((a,b)=>a+b,0) / n;
    const my = y.slice(0, n).reduce((a,b)=>a+b,0) / n;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) {
      const ax = x[i] - mx, ay = y[i] - my;
      num += ax * ay; dx += ax*ax; dy += ay*ay;
    }
    if (dx === 0 || dy === 0) return 0;
    return num / Math.sqrt(dx * dy);
  }

  // Universal tier-click handler via event delegation — any `.tier-click` element
  // anywhere in the hub, present now or inserted later, opens the tier definition popup.
  document.addEventListener("click", (e) => {
    const tierEl = e.target.closest(".tier-click");
    if (tierEl && tierEl.dataset.tier) {
      if (typeof showTierPopup === "function") showTierPopup(tierEl.dataset.tier);
      return;
    }
    const metricEl = e.target.closest(".metric-click");
    if (metricEl && metricEl.dataset.metric) {
      showMetricPopup(metricEl.dataset.metric, metricEl.dataset.col, metricEl.dataset.pid);
      return;
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  // METRIC CELL POPUP — explains what this cell's number means + shows the math
  // ══════════════════════════════════════════════════════════════════════
  // Per-cell SEMANTIC map: what does THIS specific (metric, col) actually measure?
  // This is what the popup should describe, not the metric name. E.g., in the Draft
  // Rating metric view, the Total column holds 3yr NET, not Draft Rating.
  const CELL_SEMANTIC = {
    "net_score:y1": "net_per_year",
    "net_score:y2": "net_per_year",
    "net_score:y3": "net_per_year",
    "net_score:avg": "net_3yr",
    "net_score:vs": "sample_size",
    "draft_rating:y1": "net_per_year",
    "draft_rating:y2": "net_per_year",
    "draft_rating:y3": "net_per_year",
    "draft_rating:tot": "net_3yr",
    "draft_rating:avg": "draft_rating",
    "draft_rating:vs": "slot_expected_net",
    "ep_rate:y1": "ep_per_year",
    "ep_rate:y2": "ep_per_year",
    "ep_rate:y3": "ep_per_year",
    "ep_rate:avg": "ep_3yr",
    "ep_rate:vs": "slot_expected_ep",
    "dud_rate:y1": "dud_per_year",
    "dud_rate:y2": "dud_per_year",
    "dud_rate:y3": "dud_per_year",
    "dud_rate:avg": "dud_3yr",
    "points:y1": "points_per_year",
    "points:y2": "points_per_year",
    "points:y3": "points_per_year",
    "points:tot": "points_3yr_total",
    "points:avg": "points_per_season",
    "points:vs": "value_above_expected_points",
    "ppg:y1": "ppg_per_year",
    "ppg:y2": "ppg_per_year",
    "ppg:y3": "ppg_per_year",
    "ppg:avg": "ppg_3yr",
    "win_chunks:y1": "wc_per_year",
    "win_chunks:y2": "wc_per_year",
    "win_chunks:y3": "wc_per_year",
    "win_chunks:tot": "wc_3yr_total",
    "win_chunks:avg": "wc_3yr_avg",
    "win_chunks:vs": "wc_vs_expected",
    "points_rank:y1": "pts_rank_per_year",
    "points_rank:y2": "pts_rank_per_year",
    "points_rank:y3": "pts_rank_per_year",
    "points_rank:avg": "pts_rank_3yr",
    "points_rank:vs": "pts_rank_vs_expected",
    "ppg_rank:y1": "ppg_rank_per_year",
    "ppg_rank:y2": "ppg_rank_per_year",
    "ppg_rank:y3": "ppg_rank_per_year",
    "ppg_rank:avg": "ppg_rank_3yr",
    "ppg_rank:vs": "ppg_rank_vs_expected",
    "ep_rank:y1": "ep_rank_per_year",
    "ep_rank:y2": "ep_rank_per_year",
    "ep_rank:y3": "ep_rank_per_year",
    "ep_rank:avg": "ep_rank_3yr",
    "wc_rank:y1": "wc_rank_per_year",
    "wc_rank:y2": "wc_rank_per_year",
    "wc_rank:y3": "wc_rank_per_year",
    "wc_rank:avg": "wc_rank_3yr",
  };

  // Definitions indexed by semantic (what the number actually IS, not what view it's in)
  const SEMANTIC_DEFS = {
    net_3yr: {
      title: "3yr NET",
      basic: "Good weeks minus (half of) bad weeks, averaged over 3 years. Our single-number grade on a player — higher = helped your team win more than he hurt it.",
      desc: "NET = (3yr games-weighted E+P rate) − 0.5 × (3yr games-weighted Dud rate). Validated best single predictor of AP% at r = +0.850 (n=192 team-seasons).",
    },
    net_per_year: {
      title: "Per-year NET",
      basic: "NET score for just this one year.",
      desc: "Single-season E+P rate minus half the Dud rate. Rolled into the 3yr avg for tier classification.",
    },
    draft_rating: {
      title: "Draft Rating",
      basic: "How much better (or worse) this pick performed than a typical pick at the same draft slot. A 1.01 who's Smash is expected; a 5.11 who's Smash is a heist.",
      desc: "actual 3yr NET − slot-expected NET (median NET of every historical pick at this same round+slot). Positive = outperformed slot. Scale: raw values run roughly −67 to +90; median pick = 0. See Slot Percentile for a 0-100 version.",
    },
    slot_percentile: {
      title: "Slot Percentile",
      basic: "Where this pick ranks among every historical pick at the exact same draft slot. 100 = best ever at this slot. 50 = median. 0 = worst.",
      desc: "Percentile rank of this pick's 3yr NET within the population of all historical picks at the same (round, slot). E.g. Zeke 2016 1.01 = 100 (best 1.01 ever); TRich 2012 1.01 = 0 (worst 1.01 ever).",
    },
    slot_expected_net: {
      title: "Slot-Expected NET",
      basic: "The NET score the median pick at this draft slot historically produces. A baseline for what to expect from this slot.",
      desc: "Median 3yr NET across every historical pick at this same (round, slot). Not this pick's actual NET — it's the benchmark they're being compared to. Late slots have near-zero expected NET.",
    },
    sample_size: {
      title: "Sample size",
      basic: "How much data we have on this rookie. Recent rookies haven't played 3 full years yet.",
      desc: "Years of NFL data available (1/2/3) plus total NFL games played across the rookie window.",
    },
    ep_3yr: {
      title: "3yr E+P Rate",
      basic: "How often this player had a good week (better than the typical starter).",
      desc: "3yr games-weighted share of starter-weeks that were Elite (z≥1.0) or Plus (0.25≤z<1.0).",
    },
    ep_per_year: {
      title: "Per-year E+P Rate",
      basic: "How often this player had a good week in this specific year.",
      desc: "Single-season share of starter-weeks that were Elite or Plus.",
    },
    slot_expected_ep: {
      title: "Slot-Expected E+P vs Actual",
      basic: "How much better (or worse) this player's E+P rate is vs the typical pick at their draft slot.",
      desc: "Actual 3yr E+P minus median 3yr E+P of all historical picks at the same (round, slot).",
    },
    dud_3yr: {
      title: "3yr Dud Rate",
      basic: "How often this player stunk up a week. Lower is better.",
      desc: "3yr games-weighted share of starter-weeks where z < −0.5 (half a Win Chunk below position median).",
    },
    dud_per_year: {
      title: "Per-year Dud Rate",
      basic: "How often this player stunk up a week in this specific year.",
      desc: "Single-season share of starter-weeks that were dud weeks.",
    },
    points_3yr_total: {
      title: "3yr Total Points",
      basic: "Total raw fantasy points scored across all 3 years.",
      desc: "Sum of Y1 + Y2 + Y3 points in MFL's scoring system.",
    },
    points_per_year: {
      title: "Per-year Points",
      basic: "Fantasy points for this single year.",
      desc: "Raw fantasy points that season.",
    },
    points_per_season: {
      title: "Avg Points per Season",
      basic: "Average of the 3 seasons' point totals.",
      desc: "3yr total divided by 3.",
    },
    value_above_expected_points: {
      title: "Points Above Slot Expected",
      basic: "How many more (or fewer) points this pick scored vs the typical pick at the same draft slot.",
      desc: "3yr total points minus median 3yr total of all historical picks at the same (round, slot). Rewards late-round smashes.",
    },
    ppg_3yr: {
      title: "3yr Avg PPG",
      basic: "Points per game, averaged over 3 years.",
      desc: "Games-weighted 3yr PPG.",
    },
    ppg_per_year: {
      title: "Per-year PPG",
      basic: "Points per game in this single year.",
      desc: "Single-season PPG.",
    },
    wc_3yr_total: {
      title: "3yr Total Win Chunks",
      basic: "Sum of weekly matchup value produced over 3 years.",
      desc: "Sum of (score − p50) / Δ for every starter-week across Y1-Y3.",
    },
    wc_per_year: {
      title: "Per-year Win Chunks",
      basic: "Total matchup value produced this year.",
      desc: "Sum of z-scores across starter-weeks this season.",
    },
    wc_3yr_avg: {
      title: "3yr Avg Win Chunks/Week",
      basic: "Average weekly matchup value across 3 years.",
      desc: "Games-weighted 3yr average.",
    },
    wc_vs_expected: {
      title: "Win Chunks vs Slot Expected",
      basic: "How much more (or less) weekly matchup value this pick produced vs a typical pick at the same slot.",
      desc: "3yr avg Win Chunks minus median 3yr avg of all historical picks at the same (round, slot).",
    },
    pts_rank_per_year: { title: "Per-year Points Rank", basic: "Where this player ranked at their position by total points this year. Lower = better.", desc: "Positional rank by season points." },
    pts_rank_3yr: { title: "3yr Avg Points Rank", basic: "Games-weighted avg positional rank across 3 years.", desc: "Games-weighted average of Y1/Y2/Y3 points ranks." },
    pts_rank_vs_expected: { title: "Rank vs Slot Expected", basic: "How much better the rank is vs typical slot — positive = better rank than slot median.", desc: "Slot-expected rank minus actual rank (positive = outperformed slot)." },
    ppg_rank_per_year: { title: "Per-year PPG Rank", basic: "Where this player ranked at their position by PPG this year.", desc: "Positional PPG rank." },
    ppg_rank_3yr: { title: "3yr Avg PPG Rank", basic: "Games-weighted avg PPG rank.", desc: "Games-weighted avg of per-year PPG ranks." },
    ppg_rank_vs_expected: { title: "PPG Rank vs Slot Expected", basic: "How the PPG rank compares to typical slot.", desc: "Slot-expected PPG rank minus actual." },
    ep_rank_per_year: { title: "Per-year E+P Rank", basic: "Position rank by E+P rate this year.", desc: "Requires min 8 games/season." },
    ep_rank_3yr: { title: "3yr Avg E+P Rank", basic: "Games-weighted avg E+P rank.", desc: "Games-weighted." },
    wc_rank_per_year: { title: "Per-year WC Rank", basic: "Position rank by Win Chunks this year.", desc: "Rank at same position by total weekly matchup value." },
    wc_rank_3yr: { title: "3yr Avg WC Rank", basic: "Games-weighted avg WC rank.", desc: "Games-weighted." },
  };

  const METRIC_COL_DESCRIPTIONS = {
    net_score: {
      title: "NET score",
      basic: "Good weeks minus (half of) bad weeks. Our single-number grade on a player — higher = helped your team win more than he hurt it.",
      desc: "NET = 3yr E+P rate − 0.5 × 3yr Dud rate. NET is our single best predictor of All-Play winning % (r = +0.850 across 192 team-seasons) and it's what drives every rookie tier label.",
      y: "Per-year NET for this season (E+P% − ½×Dud%).",
      avg: "Games-weighted 3yr average NET. This is the value that places the rookie into a tier bucket (+30/+15/0).",
      vs: "Years of data used (1/2/3) + total games played across the rookie window. Recent rookies get smaller samples.",
    },
    draft_rating: {
      title: "Draft Rating",
      basic: "How much better (or worse) this pick performed than a typical pick at the same draft slot. A 1.01 who's Smash is expected; a 5.11 who's Smash is a heist.",
      desc: "Draft Rating = actual 3yr NET minus slot-expected NET. Slot-expected = median NET across every historical pick at the same (round, slot). Positive = this pick outperformed where they were drafted. Late-round smashes score higher because slot-expected NET is near zero there.",
      y: "Per-year NET (not the Draft Rating — context so you can see where production came from).",
      tot: "3yr NET (the player's actual result across all 3 years).",
      avg: "Draft Rating = 3yr NET − slot-expected NET. Positive ≈ outperformed slot.",
      vs: "Slot-expected NET = median NET across all historical picks at this (round, slot). Late slots have low expected NET, which is why smashing from R5 boosts Draft Rating so much.",
    },
    ep_rate: {
      title: "E+P Rate (Elite + Plus %)",
      basic: "How often this player had a good week. A good week = outscored the average starter at his position.",
      desc: "Share of this player's starter-weeks that were Elite (z ≥ 1.0 above position median) or Plus (0.25 ≤ z < 1.0). Elite = top-20% starter week; Plus = better than median.",
      y: "Per-year E+P rate for this season.",
      avg: "Games-weighted 3yr average E+P rate.",
      vs: "3yr E+P minus slot-expected E+P (positive = outperformed slot's historical floor).",
    },
    dud_rate: {
      title: "Dud Rate",
      basic: "How often this player stunk up a week — scored low enough that he probably cost you the matchup. Lower is better.",
      desc: "Share of starter-weeks where the player scored badly enough to cost you the matchup (z < −0.5 — half a Win Chunk below the position median).",
      y: "Per-year Dud rate for this season.",
      avg: "Games-weighted 3yr average Dud rate.",
    },
    win_chunks: {
      title: "Win Chunks",
      basic: "Running total of how much this player was worth to your weekly matchups, above/below a typical starter.",
      desc: "Cumulative z-score production — sum of (score − p50) / Δ for every starter-week. Rewards consistent above-median starts.",
      y: "Per-year Win Chunks.",
      tot: "Total Win Chunks across 3yr window.",
      avg: "Games-weighted 3yr average Win Chunks per week.",
      vs: "3yr avg minus slot-expected 3yr avg.",
    },
    points: {
      title: "Points (raw fantasy scoring)",
      basic: "Straight-up fantasy points. Doesn't care about position or context — just total scoring.",
      desc: "Raw fantasy points in MFL's scoring system.",
      y: "Per-year points.",
      tot: "Total points across 3yr window.",
      avg: "Average points per season (total ÷ 3).",
      vs: "3yr total minus slot-expected 3yr median points. 'Value Above Expected' — rewards late-round smashes.",
    },
    ppg: {
      title: "Points Per Game",
      basic: "Scoring per game. Levels the field between players who missed time due to injury/bench.",
      desc: "Fantasy points per NFL game played.",
      y: "Per-year PPG.",
      avg: "Games-weighted 3yr average PPG.",
    },
    points_rank: {
      title: "Positional Points Rank",
      basic: "Where this player ranked at his position that year. #1 = league leader. Lower = better.",
      desc: "Player's rank at their position by total points that season. Lower = better (1 = the league leader at their position).",
      y: "Per-year rank (e.g. RB12).",
      avg: "Games-weighted average rank across 3 years.",
      vs: "Slot-expected rank minus actual rank. Positive = better than slot's historical median rank.",
    },
    ppg_rank: {
      title: "Positional PPG Rank",
      basic: "Where this player ranked at his position by points-per-game. Lower = better.",
      desc: "Player's rank at their position by PPG. Min 16 games to qualify.",
      y: "Per-year PPG rank.",
      avg: "Games-weighted 3yr average PPG rank.",
      vs: "Slot-expected rank minus actual rank.",
    },
    ep_rank: {
      title: "Positional E+P Rate Rank",
      basic: "Ranks players at the same position by how often they had good weeks. Lower = better.",
      desc: "Player's rank at their position by E+P rate. Min 8 games to qualify.",
      y: "Per-year E+P rank.",
      avg: "Games-weighted 3yr average E+P rank.",
    },
    wc_rank: {
      title: "Positional Win Chunks Rank",
      basic: "Ranks players at the same position by total weekly-matchup value produced. Lower = better.",
      desc: "Player's rank at their position by total Win Chunks accumulated.",
      y: "Per-year WC rank.",
      avg: "Games-weighted 3yr average WC rank.",
    },
  };

  function showMetricPopup(metric, col, pid) {
    // Prefer the per-cell SEMANTIC lookup (accurate to what THIS cell actually
    // measures). Fall back to the metric-wide description only if no semantic mapped.
    const semanticKey = CELL_SEMANTIC[`${metric}:${col}`];
    const semantic = semanticKey ? SEMANTIC_DEFS[semanticKey] : null;
    const fallback = METRIC_COL_DESCRIPTIONS[metric];
    const def = semantic || fallback;
    if (!def) return;
    const pick = STATE.history.picks.find(p => p.player_id === String(pid));
    openModal(`
      <h3>${def.title}</h3>
      ${def.basic ? `
      <div class="profile-block" style="border-top:0; padding-top:0; margin-top:10px; background:rgba(91,141,255,0.08); padding:12px; border-radius:6px;">
        <h4 style="color:var(--accent);">In plain English</h4>
        <p style="margin:0;">${def.basic}</p>
      </div>` : ""}
      <div class="profile-block">
        <h4>Technical definition</h4>
        <p>${def.desc}</p>
      </div>
      ${pick ? `
      <div class="profile-block">
        <h4>This pick — ${escapeHtml(pick.player_name)} (${pick.season} ${pick.pick_label})</h4>
        <table class="rdh-table">
          <tbody>
            <tr><td>Tier</td><td><span class="tier ${tierSlug(pick.tier)} tier-click" data-tier="${pick.tier}">${pick.tier}</span> (click for tier definition)</td></tr>
            <tr><td>3yr E+P rate</td><td class="num">${pick.ep_rate_3yr_avg != null ? (pick.ep_rate_3yr_avg * 100).toFixed(1) + "%" : "—"}</td></tr>
            <tr><td>3yr Dud rate</td><td class="num">${pick.dud_rate_3yr_avg != null ? (pick.dud_rate_3yr_avg * 100).toFixed(1) + "%" : "—"}</td></tr>
            <tr><td>3yr NET</td><td class="num">${pick.net_score_3yr != null ? (pick.net_score_3yr > 0 ? "+" : "") + (pick.net_score_3yr * 100).toFixed(1) : "—"}</td></tr>
            <tr><td>Slot-expected NET</td><td class="num">${pick.expected_net_3yr != null ? (pick.expected_net_3yr > 0 ? "+" : "") + (pick.expected_net_3yr * 100).toFixed(1) : "—"}</td></tr>
            <tr><td>Draft Rating (NET − Slot Exp)</td><td class="num"><strong>${pick.draft_rating != null ? (pick.draft_rating > 0 ? "+" : "") + (pick.draft_rating * 100).toFixed(1) : "—"}</strong></td></tr>
            <tr><td>Slot Percentile</td><td class="num"><strong>${pick.slot_percentile != null ? pick.slot_percentile.toFixed(0) : "—"}</strong></td></tr>
            <tr><td>Games played (3yr)</td><td class="num">${(pick.gp_y1 || 0) + (pick.gp_y2 || 0) + (pick.gp_y3 || 0)}</td></tr>
          </tbody>
        </table>
      </div>` : ""}
      <div class="actions"><button class="btn secondary" onclick="document.getElementById('rdh-modal-overlay').classList.remove('open')">Close</button></div>
    `);
  }

  // When embedded as an iframe (HPM mode), post our content height up so the
  // parent can auto-resize the frame. Idempotent; safe to call repeatedly.
  function _postHeight() {
    try {
      if (window.parent === window) return;
      const h = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      window.parent.postMessage({ type: "draft-hub-height", height: h }, "*");
    } catch (e) {}
  }
  window.addEventListener("load", _postHeight);
  // Also post when our content re-renders (tab switch, filter, etc.)
  const _resizeObs = new ResizeObserver(() => _postHeight());
  _resizeObs.observe(document.body);

  loadAll().catch(err => {
    console.error(err);
    document.getElementById("rdh-meta").textContent = "Failed to load data — check console.";
  });
})();
