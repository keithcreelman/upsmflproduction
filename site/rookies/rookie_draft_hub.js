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
    // Which sources to blend into the user-defined consensus rank. Defaults to
    // ALL — user can de-select via the rank-by-picker dropdown to build their
    // own consensus (e.g. just KTC + FantasyCalc, or MFL + FP only).
    rankSourceFilter: (function () {
      try {
        const v = sessionStorage.getItem("rdh_rank_sources");
        if (v) return new Set(JSON.parse(v));
      } catch (e) {}
      return new Set(["mfl_rookie", "fantasycalc", "ktc", "sleeper", "fantasypros"]);
    })(),
    // My Queue — array of prospect player_ids in priority order. Persisted
    // per franchise so a refresh keeps the stack intact. Drafted prospects
    // are auto-trimmed in renderMyQueue.
    myQueue: [],
    // LIVE DRAFT MODE — defaults to simulate so nothing hits MFL or live Discord
    // until the commish flips it. Persisted in sessionStorage so a refresh
    // doesn't accidentally land in LIVE mid-draft.
    simulationMode: (function () {
      try {
        const v = sessionStorage.getItem("rdh_sim_mode");
        return v == null ? true : v === "true";
      } catch (e) { return true; }
    })(),
    // ── Commish toggle: silence trade Discord announcements in LIVE ──
    // When ON, /api/trade/process won't post to the live #draft channel
    // (picks still announce). Useful for testing in production or when
    // you're processing a flurry of trades and don't want to spam
    // Discord. Persisted in localStorage. Commish-only UI.
    silenceTradeAnnouncements: (function () {
      try { return localStorage.getItem("rdh_silence_trade_announce") === "true"; }
      catch (e) { return false; }
    })(),
    // ── DRY-RUN mode ──
    // Activated by ?dryrun=1 in the URL (or sessionStorage). Lets the commish
    // exercise the FULL LIVE-mode UI flow (red banner, confirm dialogs, success
    // toasts, board updates) without the worker actually POSTing to MFL or to
    // the live #draft Discord channel. Worker still validates the request,
    // builds the MFL payload, posts a [DRY-RUN] preview to the test Discord
    // channel, and returns ok:true with `dry_run: true` in the response.
    // Use case: Keith rehearses draft-day flow on the test site without risking
    // a real pick on the real league.
    dryRun: (function () {
      try {
        const u = new URL(window.location.href);
        const fromUrl = u.searchParams.get("dryrun");
        if (fromUrl === "1" || fromUrl === "true") {
          sessionStorage.setItem("rdh_dry_run", "true");
          return true;
        }
        if (fromUrl === "0" || fromUrl === "false") {
          sessionStorage.setItem("rdh_dry_run", "false");
          return false;
        }
        const stored = sessionStorage.getItem("rdh_dry_run");
        return stored === "true";
      } catch (e) { return false; }
    })(),
    // Per-pick clock (real-time draft pacing). Persisted across refreshes so
    // the commish doesn't have to re-set it. 0 = clock OFF (no countdown
    // displayed). Default 10 minutes (UPS slow-draft cadence).
    pickClockMins: (function () {
      try {
        const v = localStorage.getItem("rdh_pick_clock_mins");
        const n = v == null ? 10 : parseInt(v, 10);
        return Number.isFinite(n) ? Math.max(0, n) : 10;
      } catch (e) { return 10; }
    })(),
    // Wall-clock epoch (ms) when the current active_pick went on the clock.
    // - LIVE: derived from MFL picks_made[-1].timestamp (the moment the
    //   previous pick was recorded, which IS when the next slot started).
    //   Falls back to "first time we observed this slot" if MFL doesn't
    //   give us a timestamp.
    // - SIM: stamped to Date.now() whenever the auto-sim or a manual pick
    //   advances active_pick.
    // - Reset by the ↺ button if the commish needs to give the on-clock
    //   owner a do-over after a delay.
    // Restored from sessionStorage on every page load so a LIVE-mode refresh
    // doesn't reset the on-clock owner's countdown to a fresh 10:00. The
    // poller's MFL-pick-timestamp seed will overwrite this on next refresh
    // if it differs, but the restored value keeps the clock running smoothly
    // through the brief moment before the worker responds.
    activePickStartedAt: (function () {
      try {
        const v = sessionStorage.getItem("rdh_clock_started_at");
        const n = v ? Number(v) : 0;
        return Number.isFinite(n) && n > 0 ? n : null;
      } catch (e) { return null; }
    })(),
    activePickClockKey: (function () {
      try { return sessionStorage.getItem("rdh_clock_slot_key") || null; }
      catch (e) { return null; }
    })(),
  };

  // MFL HPM context — the embed loader injects window.UPS_DRAFT_HUB_FRANCHISE_ID
  // when the visiting user is authenticated to MFL on this league. We trust
  // that as the auto-login signal (no cookie paste required in the happy path).
  function _hpmFranchiseId() {
    try {
      const fid = String(window.UPS_DRAFT_HUB_FRANCHISE_ID || "").trim();
      // pad to 4 chars to match MFL's franchise_id format
      if (fid && /^\d+$/.test(fid)) return fid.padStart(4, "0").slice(-4);
      // Fallback: parse from current URL (?F=, ?FRANCHISE=, ?FRANCHISE_ID=)
      const u = new URL(window.location.href);
      const q = u.searchParams.get("FRANCHISE_ID") || u.searchParams.get("FRANCHISE") || u.searchParams.get("F") || "";
      const cleaned = String(q).replace(/\D/g, "");
      return cleaned ? cleaned.padStart(4, "0").slice(-4) : null;
    } catch (e) { return null; }
  }

  const fetchJSON = (path) => fetch(path + "?v=" + Date.now(), { cache: "no-store" }).then(r => r.json());

  // ══════════════════════════════════════════════════════════════════════
  // MOBILE APP SHELL (v1.7.25)
  // ══════════════════════════════════════════════════════════════════════
  // Single MQ at 768px toggles body.is-mobile. CSS handles 99% of the
  // mobile layout from there (single-column, full-screen modals, sticky
  // bottom nav, 44px touch targets). JS only:
  //   1. Mirrors the desktop top-tabs into a bottom-pinned nav (one source
  //      of truth: the existing #rdh-tabs HTML; we generate icons/labels
  //      from data-tab attribute).
  //   2. Listens to viewport changes so flipping orientation between
  //      portrait phone and landscape iPad updates without reload.
  //
  // Tab → icon/short-label map. Order is intentional: most-used first
  // (Live), draft-day-relevant next (R6, Future Picks), reference at end.
  const MOBILE_TAB_META = {
    "live":         { icon: "🎯", label: "Live" },
    "history":      { icon: "📜", label: "History" },
    "teams":        { icon: "👥", label: "Teams" },
    "r6-order":     { icon: "🎲", label: "R6" },
    "future-picks": { icon: "📅", label: "Picks" },
    "calcs":        { icon: "📊", label: "Calcs" },
  };
  function _initMobileShell(setActiveTab) {
    const topNav = document.getElementById("rdh-tabs");
    if (!topNav) return;

    // Stash desktop label text on each tab so we can swap to icon-style
    // labels on mobile and restore on resize back to desktop.
    topNav.querySelectorAll("button[data-tab]").forEach(srcBtn => {
      if (!srcBtn.dataset.desktopLabel) {
        srcBtn.dataset.desktopLabel = srcBtn.textContent.trim();
      }
    });
    // No mobile-hidden tabs at the moment — Draft-Day Trades was removed
    // entirely in v1.7.30. Add tab keys to this Set if you ever want to
    // hide one only on mobile.
    const MOBILE_HIDE_TABS = new Set();
    function applyTopNavMobileLabels(isMobile) {
      topNav.querySelectorAll("button[data-tab]").forEach(srcBtn => {
        const tab = srcBtn.dataset.tab;
        const meta = MOBILE_TAB_META[tab] || { icon: "•", label: tab };
        if (isMobile) {
          srcBtn.hidden = MOBILE_HIDE_TABS.has(tab);
          srcBtn.innerHTML = `<span class="mbn-icon" aria-hidden="true">${meta.icon}</span><span class="mbn-label">${meta.label}</span>`;
        } else {
          srcBtn.hidden = false;
          srcBtn.textContent = srcBtn.dataset.desktopLabel || tab;
        }
      });
    }

    // Viewport observer: toggle .is-mobile at ≤768px + swap top-nav labels.
    // Per Keith: keep the icon-style labels on the TOP nav on mobile (the
    // bottom nav stays hidden — DOM unused).
    const mq = window.matchMedia("(max-width: 768px)");
    const apply = () => {
      const isMobile = mq.matches;
      document.body.classList.toggle("is-mobile", isMobile);
      applyTopNavMobileLabels(isMobile);
    };
    apply();
    if (mq.addEventListener) mq.addEventListener("change", apply);
    else if (mq.addListener) mq.addListener(apply);  // legacy Safari
  }


  // ── Per-pick clock helpers ─────────────────────────────────────────
  // The clock runs entirely client-side off STATE.activePickStartedAt. The
  // 1Hz tick updates the banner display; it does NOT auto-submit picks
  // (MFL is still the authority on what happens when time runs out — owner
  // gets a warning and the commish can intervene).
  function _pickClockSlotKey(active) {
    if (!active) return null;
    return `${active.round}.${active.pick}.${active.franchise_id || active.owned_by_franchise_id || ""}`;
  }
  function _pickClockPersist() {
    try {
      if (STATE.activePickStartedAt) {
        sessionStorage.setItem("rdh_clock_started_at", String(STATE.activePickStartedAt));
        sessionStorage.setItem("rdh_clock_slot_key", STATE.activePickClockKey || "");
      } else {
        sessionStorage.removeItem("rdh_clock_started_at");
        sessionStorage.removeItem("rdh_clock_slot_key");
      }
    } catch (e) {}
  }
  function _pickClockEnsureStarted(opts) {
    // Called whenever active_pick may have changed. Stamps started_at if
    // (a) we have no started_at, or (b) the slot key changed.
    // `opts.startedAtMs` is AUTHORITATIVE — when provided, we always prefer
    // it over Date.now() AND over any previously stored value (the MFL pick
    // timestamp poll-seed beats wall-clock stamps every time).
    //
    // The clock is a LIVE-mode-only feature — don't stamp anything in SIM
    // so the clock stays cleanly off until the commish flips to LIVE.
    if (STATE.simulationMode) {
      STATE.activePickStartedAt = null;
      STATE.activePickClockKey = null;
      _pickClockPersist();
      return;
    }
    const active = STATE.live && STATE.live.active_pick;
    const key = _pickClockSlotKey(active);
    if (!active || !key) {
      STATE.activePickStartedAt = null;
      STATE.activePickClockKey = null;
      _pickClockPersist();
      return;
    }
    const slotChanged = STATE.activePickClockKey !== key;
    const authoritative = opts && Number.isFinite(opts.startedAtMs) && opts.startedAtMs > 0;
    if (slotChanged) {
      // New slot (trade, new pick made, draft advance) → restart from
      // authoritative MFL timestamp if provided, otherwise from now.
      STATE.activePickStartedAt = authoritative ? opts.startedAtMs : Date.now();
      STATE.activePickClockKey = key;
      _pickClockPersist();
    } else if (authoritative && opts.startedAtMs !== STATE.activePickStartedAt) {
      // Same slot, but caller has an authoritative timestamp (MFL pick
      // timestamp from the poller). Always honor it — corrects any
      // stale Date.now() stamp from a previous bootstrap.
      STATE.activePickStartedAt = opts.startedAtMs;
      _pickClockPersist();
    } else if (!STATE.activePickStartedAt) {
      // No stamp yet and no authoritative value — stamp now as a fallback.
      STATE.activePickStartedAt = Date.now();
      STATE.activePickClockKey = key;
      _pickClockPersist();
    }
  }
  function _pickClockReset() {
    // Commish ↺ button — restart the current pick's clock from now.
    if (!STATE.live || !STATE.live.active_pick) return;
    STATE.activePickStartedAt = Date.now();
    STATE.activePickClockKey = _pickClockSlotKey(STATE.live.active_pick);
    _pickClockPersist();
    renderPickClock();
    showToast("Pick clock reset to full time", "ok");
  }
  function _pickClockSetMinutes(mins) {
    const n = Math.max(0, parseInt(mins, 10) || 0);
    STATE.pickClockMins = n;
    try { localStorage.setItem("rdh_pick_clock_mins", String(n)); } catch (e) {}
    renderPickClock();
  }
  function renderPickClock() {
    const el = document.getElementById("pick-clock-display");
    if (!el) return;
    const mins = STATE.pickClockMins;
    const active = STATE.live && STATE.live.active_pick;
    // The pick clock is a LIVE-mode feature only — it shouldn't tick during
    // SIM (the auto-sim has its own per-tick countdown). Hide the display
    // entirely in SIM so owners aren't watching a phantom clock during
    // mock drafts.
    if (STATE.simulationMode || !mins || mins <= 0 || !active || !STATE.activePickStartedAt) {
      el.textContent = "";
      el.className = "lmb-clock";
      el.removeAttribute("data-state");
      return;
    }
    const totalSec = mins * 60;
    const elapsedSec = Math.floor((Date.now() - STATE.activePickStartedAt) / 1000);
    const remainSec = totalSec - elapsedSec;
    let state, label;
    if (remainSec <= 0) {
      state = "expired";
      // Show how far over they are — e.g. "OT 1:23"
      const over = -remainSec;
      label = `⏰ OT ${Math.floor(over / 60)}:${String(over % 60).padStart(2, "0")}`;
    } else {
      const m = Math.floor(remainSec / 60);
      const s = remainSec % 60;
      label = `${m}:${String(s).padStart(2, "0")}`;
      if (remainSec <= 60) state = "danger";
      else if (remainSec <= 120) state = "warn";
      else state = "ok";
    }
    el.textContent = label;
    el.setAttribute("data-state", state);
  }
  // 1Hz tick — repaint the clock every second while a pick is on the
  // clock. Cheap (one DOM textContent write); we don't gate it behind
  // visibility because owners may have the tab in a side window.
  let _pickClockTickTimer = null;
  function _startPickClockTick() {
    if (_pickClockTickTimer) return;
    _pickClockTickTimer = setInterval(renderPickClock, 1000);
  }


  // Resolve a worker /api/* path through the configured API_BASE so iframe-
  // embedded hubs (HPM) hit the Cloudflare worker instead of the MFL origin.
  // Local-dev override: ?api=http://localhost:8787 in the URL points the
  // hub at a local `wrangler dev` (no rebuild required). Persists for the
  // session so subsequent loads in the same tab keep using it.
  (function _resolveApiBaseFromUrl() {
    try {
      const u = new URL(window.location.href);
      const fromQs = u.searchParams.get("api");
      if (fromQs) {
        window.UPS_DRAFT_HUB_API_BASE = fromQs.replace(/\/$/, "");
        sessionStorage.setItem("rdh_api_base", window.UPS_DRAFT_HUB_API_BASE);
      } else if (!window.UPS_DRAFT_HUB_API_BASE) {
        const cached = sessionStorage.getItem("rdh_api_base");
        if (cached) window.UPS_DRAFT_HUB_API_BASE = cached;
      }
    } catch (e) {}
  })();
  function apiUrl(path) {
    const base = (typeof window.UPS_DRAFT_HUB_API_BASE === "string" && window.UPS_DRAFT_HUB_API_BASE) || "";
    if (!base) return path;
    return base.replace(/\/$/, "") + path;
  }

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
      fetch(apiUrl("/api/me") + (apiUrl("/api/me").includes("?") ? "&" : "?") + "L=74598" + (_hpmFranchiseId() ? "&franchise_id=" + _hpmFranchiseId() : ""))
        .then(r => r.ok ? r.json() : { configured: false }).catch(() => ({ configured: false })),
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
    // Overlay HPM-injected franchise_id when present — that's the most
    // trustworthy "who is this owner" signal because MFL only injects it
    // for an authenticated visitor.
    const hpmFid = _hpmFranchiseId();
    if (hpmFid) {
      const fname = (live && live.franchises && live.franchises[hpmFid]) || (STATE.me && STATE.me.franchise_name) || hpmFid;
      STATE.me = Object.assign({}, STATE.me || {}, {
        configured: true,
        franchise_id: hpmFid,
        franchise_name: fname,
        source: "hpm",
      });
    }
    // ── Defensive commish detection ──
    // The worker's /api/me sets is_commish based on COMMISH_FRANCHISE_IDS env
    // var, but a) the call may have raced HPM injection so franchise_id
    // wasn't sent, b) workers.dev preview / direct page loads have no
    // franchise context, c) Keith logs in as MFL pseudo-franchise 0000
    // (commish view) which doesn't match any real-team allowlist.
    // Three signals (any one is enough to flip is_commish:true):
    //   1. Outer HPM loader sniffed ISMFLCOMMISH cookie + injected
    //      window.UPS_DRAFT_HUB_IS_COMMISH=true. Cleanest signal because
    //      the cookie is only set by MFL for accounts with commish privs.
    //   2. franchise_id matches client-side allowlist (0008/0001/0000).
    //   3. URL ?commish=1 override (testing on workers.dev preview).
    const COMMISH_FIDS_CLIENT = ["0008", "0001", "0000"];  // Keith / legacy / MFL pseudo
    try {
      const u = new URL(window.location.href);
      const override = u.searchParams.get("commish");
      const hpmCommish = !!window.UPS_DRAFT_HUB_IS_COMMISH;
      // Inside the iframe MFL cookies aren't typically readable, but if
      // the hub is loaded same-origin (e.g. proxied) we still try.
      let cookieCommish = false;
      try { cookieCommish = /(?:^|;\s*)ISMFLCOMMISH\s*=\s*(1|Y|true)/i.test(String(document.cookie || "")); } catch (e) {}
      if (override === "1" || override === "true") {
        STATE.me = Object.assign({}, STATE.me || {}, { is_commish: true, configured: true });
      } else if (override === "0" || override === "false") {
        STATE.me = Object.assign({}, STATE.me || {}, { is_commish: false });
      } else if (hpmCommish || cookieCommish) {
        STATE.me = Object.assign({}, STATE.me || {}, { is_commish: true, configured: true });
        if (!STATE.me.franchise_name) STATE.me.franchise_name = "Commissioner";
      } else if (STATE.me && STATE.me.franchise_id && COMMISH_FIDS_CLIENT.includes(STATE.me.franchise_id)) {
        STATE.me.is_commish = true;
      }
    } catch (e) {}
    // Surface what the hub thinks "I am" so Keith can debug from console
    // when the Go LIVE button doesn't appear: `STATE.me` in DevTools.
    try {
      console.info("[draft-hub] me:", JSON.stringify(STATE.me), "hpmFid:", hpmFid, "hpmCommish:", !!window.UPS_DRAFT_HUB_IS_COMMISH);
    } catch (e) {}
    try {
      STATE.future_picks = await fetchJSON("rookie_future_picks.json");
    } catch (e) {
      STATE.future_picks = { picks: [], meta: {} };
    }
    // Optional static snapshot of every franchise's roster + future picks +
    // current-year picks — used by the trade modal in local preview when the
    // worker isn't reachable. Generated by snapshot_franchise_assets.py.
    // Loaded lazily so a missing file doesn't block the rest of the hub.
    STATE.franchise_assets_snapshot = null;
    fetchJSON("franchise_assets_2026.json")
      .then(d => { STATE.franchise_assets_snapshot = d; })
      .catch(() => {});
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
    // After the initial render with the static snapshot, fetch live MFL
    // state and overlay. Always fires at startup so even SIM users see
    // accurate as-of-now picks. Polling continues only in LIVE mode.
    _refreshLiveDraftState({ initial: true });
  }

  // Hit the worker for live MFL draft state and overlay onto STATE.live.
  // We REPLACE draft_order + picks_made + active_pick + franchises (those
  // are MFL's source of truth) but PRESERVE meta.season + meta.league_id
  // from the snapshot for back-compat. Local sim picks are kept ONLY in
  // SIM mode — LIVE mode trusts MFL completely.
  let _liveStatePollTimer = null;
  async function _refreshLiveDraftState({ initial } = {}) {
    if (!STATE.live) return;
    try {
      const r = await fetch(apiUrl("/api/draft-state") + "?L=74598", { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const ct = r.headers.get("content-type") || "";
      if (!ct.includes("json")) throw new Error("not JSON");
      const live = await r.json();
      if (!live || !Array.isArray(live.draft_order)) throw new Error("bad shape");
      // Merge: replace authoritative fields, preserve metadata
      const prevMeta = STATE.live.meta || {};
      // SIM mode: merge picks_made — the user may have local sim picks
      //   we don't want to lose. LIVE mode: trust MFL completely.
      const localSimPicks = STATE.simulationMode
        ? (STATE.live.picks_made || []).filter(p => !live.picks_made.find(lp =>
            Number(lp.round) === Number(p.round) && Number(lp.pick) === Number(p.pick)))
        : [];
      STATE.live.franchises = Object.keys(live.franchises || {}).length
        ? live.franchises : STATE.live.franchises;
      STATE.live.draft_order = live.draft_order;
      STATE.live.picks_made = live.picks_made.concat(localSimPicks);
      STATE.live.active_pick = live.active_pick || _autoSimNextSlot();
      STATE.live.meta = Object.assign({}, prevMeta, live.meta);
      // Seed the per-pick clock: in LIVE, the previous pick's MFL timestamp
      // IS when the next slot started. In SIM, we stamp "now" inside the
      // helper. This re-runs every poll, but the helper no-ops when the
      // slot key hasn't changed, so the clock keeps ticking from its
      // original start time across polls.
      const lastPick = (live.picks_made || []).slice().reverse().find(p => Number(p.timestamp));
      const startedAtMs = lastPick && Number(lastPick.timestamp) ? Number(lastPick.timestamp) * 1000 : null;
      _pickClockEnsureStarted({ startedAtMs });
      renderLive();
      renderPickClock();
      if (initial && !STATE.simulationMode) {
        showToast(`Live draft state loaded — ${live.meta.n_picks_made}/${live.meta.n_picks_total} picks made`, "ok");
      }
    } catch (e) {
      if (initial) {
        // Worker unreachable — silent in SIM, log a hint in LIVE
        if (!STATE.simulationMode) console.warn("[draft-state] LIVE refresh failed, falling back to static snapshot:", e);
      }
    }
    // Schedule next poll only in LIVE mode (every 5s — aligns with the
    // worker's 5s CF edge cache TTL on the MFL draftResults fetch, so we
    // don't pummel MFL but still surface picks on other devices within
    // ~5–10s of the write).
    if (_liveStatePollTimer) clearTimeout(_liveStatePollTimer);
    if (!STATE.simulationMode) {
      _liveStatePollTimer = setTimeout(() => _refreshLiveDraftState({}), 5000);
    }
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
    // Draft-Day Trades tab removed in v1.7.30 — guard the dd-season
    // populate so loadAll doesn't NPE when the element is gone.
    const ddSeason = document.getElementById("dd-season");
    if (ddSeason && STATE.day_trades && STATE.day_trades.trades_by_season) {
      for (const s of Object.keys(STATE.day_trades.trades_by_season).sort((a, b) => b - a)) {
        ddSeason.insertAdjacentHTML("beforeend", `<option value="${s}">${s}</option>`);
      }
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
    // Shared tab-switch logic — invoked by BOTH the desktop top nav and
    // the mobile bottom nav so they stay in sync.
    function _setActiveTab(tab) {
      if (!tab) return;
      document.querySelectorAll("#rdh-tabs button").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
      document.querySelectorAll(".mobile-bottom-nav button").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
      document.querySelectorAll(".rdh-section").forEach(s => {
        s.classList.toggle("active", s.dataset.section === tab);
      });
      STATE.activeTab = tab;
      // On mobile, scroll to top when changing tabs so the user lands at the
      // start of the new section instead of mid-scroll from where they were.
      if (document.body.classList.contains("is-mobile")) {
        try { window.scrollTo({ top: 0, behavior: "instant" }); } catch (e) { window.scrollTo(0, 0); }
      }
    }
    document.getElementById("rdh-tabs").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-tab]");
      if (!btn) return;
      _setActiveTab(btn.dataset.tab);
    });

    // ── Mobile app shell setup ──
    // Build the bottom tab nav by mirroring the existing top tabs (so any
    // future tab additions in HTML automatically show up here too). Toggle
    // body.is-mobile based on viewport width — CSS handles all the layout
    // changes from there.
    _initMobileShell(_setActiveTab);

    // Historical filters
    const hBindings = [["h-season", "season"], ["h-team", "team"], ["h-round", "round"],
      ["h-slot", "slot"], ["h-pos", "pos"], ["h-pg", "pg"], ["h-tier", "tier"],
      ["h-active", "active"]];
    for (const [id, key] of hBindings) {
      document.getElementById(id).addEventListener("change", (e) => {
        STATE.h_filters[key] = e.target.value;
        // Reset to first page on any filter change so user doesn't end up
        // on an empty page after narrowing the result set.
        STATE.h_page = 0;
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
      if (el) el.addEventListener("change", e => { FP_STATE[key] = e.target.value; STATE.fp_page = 0; renderFuturePicks(); });
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
    const announceBtn = document.getElementById("r6-announce-btn");
    if (announceBtn) {
      announceBtn.addEventListener("click", () => _r6OpenKickoffAnnounceModal());
    }
    // Enable Official button + show Announce button once we know the user is commish
    _refreshCommishGating();
    // Start countdown timer to event
    _startR6EventCountdown();

    // Modal close on overlay click
    document.getElementById("rdh-modal-overlay").addEventListener("click", (e) => {
      if (e.target.id === "rdh-modal-overlay") closeModal();
    });

    // Live Draft tab — chip groups, mode banner, keyboard shortcuts
    wireLiveDraftListeners();

    // Load saved queue (per-franchise) from sessionStorage
    _loadMyQueue();

    // Wire Clear-queue button
    const clearBtn = document.getElementById("my-queue-clear");
    if (clearBtn) clearBtn.addEventListener("click", () => {
      if (!STATE.myQueue.length) return;
      if (!confirm(`Clear all ${STATE.myQueue.length} queued prospects?`)) return;
      STATE.myQueue = [];
      _saveMyQueue();
      renderMyQueue();
      renderProspects();
    });

    // Wire the auto-pick toggle (off by default; persists per franchise)
    const autoCb = document.getElementById("my-queue-autopick");
    if (autoCb) {
      const key = `rdh_queue_autopick_${_myFid() || "default"}`;
      try { autoCb.checked = sessionStorage.getItem(key) === "1"; } catch (e) {}
      autoCb.addEventListener("change", () => {
        try { sessionStorage.setItem(key, autoCb.checked ? "1" : "0"); } catch (e) {}
        if (autoCb.checked) {
          showToast("Auto-pick ON — top of queue will be selected on your turn", "ok");
        } else {
          showToast("Auto-pick OFF — you'll confirm every pick yourself", "ok");
        }
      });
    }
  }

  // ── Live-draft UI wiring (mode banner, chips, segmented controls, shortcuts) ──
  function wireLiveDraftListeners() {
    // Status chip group ↔ #prospect-status (hidden mirror)
    const statusChipGroup = document.querySelector('.live-prospects-card .chip-group');
    const statusSelect = document.getElementById("prospect-status");
    if (statusChipGroup && statusSelect) {
      statusChipGroup.addEventListener("click", (e) => {
        const btn = e.target.closest("button.chip");
        if (!btn) return;
        statusChipGroup.querySelectorAll(".chip").forEach(b => b.setAttribute("aria-pressed", "false"));
        btn.setAttribute("aria-pressed", "true");
        statusSelect.value = btn.dataset.status || "";
        statusSelect.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }

    // Custom-consensus picker — checkbox dropdown that drives STATE.rankSourceFilter
    const picker = document.getElementById("rank-by-picker");
    const adpSelect = document.getElementById("prospect-adp-source");
    if (picker && adpSelect) {
      const checks = picker.querySelectorAll('input[type="checkbox"]');
      const updateFromUI = () => {
        const sources = new Set();
        checks.forEach(cb => { if (cb.checked) sources.add(cb.dataset.source); });
        if (sources.size === 0) {
          // Don't allow empty — re-tick the one that was just unchecked
          // (caller's last-action). Simpler: re-tick all and show a toast.
          checks.forEach(cb => { cb.checked = true; sources.add(cb.dataset.source); });
          showToast("At least one source required — re-enabled all.", "err");
        }
        STATE.rankSourceFilter = sources;
        try { sessionStorage.setItem("rdh_rank_sources", JSON.stringify([...sources])); } catch (e) {}
        // Update the summary label
        const lbl = document.getElementById("rank-by-summary-label");
        if (lbl) {
          const TOTAL = 5;
          const SF_SET = new Set(["fantasycalc", "ktc", "fantasypros"]);
          const isSfOnly = sources.size === SF_SET.size
                          && [...sources].every(s => SF_SET.has(s));
          if (sources.size === TOTAL)        lbl.textContent = "Consensus · all 5 sources";
          else if (isSfOnly)                 lbl.textContent = "SF only · 3 SF-native sources";
          else if (sources.size === 1)       lbl.textContent = `Single · ${[...sources][0]}`;
          else                                lbl.textContent = `Custom · ${sources.size} of ${TOTAL} sources`;
        }
        adpSelect.value = "consensus";
        adpSelect.dispatchEvent(new Event("change", { bubbles: true }));
      };
      // Initialise the checks from STATE
      checks.forEach(cb => { cb.checked = STATE.rankSourceFilter.has(cb.dataset.source); });
      updateFromUI();
      checks.forEach(cb => cb.addEventListener("change", updateFromUI));
      const allBtn = document.getElementById("rank-by-all");
      const sfBtn = document.getElementById("rank-by-sf-only");
      if (allBtn) allBtn.addEventListener("click", () => {
        checks.forEach(cb => cb.checked = true); updateFromUI();
      });
      if (sfBtn) sfBtn.addEventListener("click", () => {
        // SF-native sources only — exclude 1QB-leaning aggregates so QBs
        // are ranked the way UPS (SuperFlex) actually drafts them.
        const SF_SOURCES = new Set(["fantasycalc", "ktc", "fantasypros"]);
        checks.forEach(cb => cb.checked = SF_SOURCES.has(cb.dataset.source));
        updateFromUI();
      });
      // Close the dropdown on outside click
      document.addEventListener("click", (e) => {
        if (picker.open && !picker.contains(e.target)) picker.open = false;
      });
    }

    // Live mode banner: render greeting + commish toggle
    renderLiveModeBanner();
    const toggle = document.getElementById("live-mode-toggle");
    if (toggle) toggle.addEventListener("click", flipLiveMode);
    const pill = document.getElementById("live-mode-pill");
    if (pill) pill.addEventListener("click", showModeHelp);

    // Per-pick clock controls (shown to everyone — visible reference even
    // for non-commish owners watching the draft go).
    const clockSel = document.getElementById("pick-clock-mins");
    if (clockSel) {
      clockSel.value = String(STATE.pickClockMins);
      clockSel.addEventListener("change", (e) => _pickClockSetMinutes(e.target.value));
    }
    const clockReset = document.getElementById("pick-clock-reset");
    if (clockReset) clockReset.addEventListener("click", _pickClockReset);

    // Commish-only Discord trade-announcement toggle. Rendered hidden by
    // default; renderLiveModeBanner unhides for commish.
    const tradeDmBtn = document.getElementById("trade-discord-toggle");
    if (tradeDmBtn) {
      tradeDmBtn.addEventListener("click", () => {
        STATE.silenceTradeAnnouncements = !STATE.silenceTradeAnnouncements;
        try { localStorage.setItem("rdh_silence_trade_announce", String(STATE.silenceTradeAnnouncements)); } catch (e) {}
        renderLiveModeBanner();
        showToast(
          STATE.silenceTradeAnnouncements
            ? "🔕 Discord announcements OFF — picks AND trades won't post. MFL writes still happen."
            : "📢 Discord announcements ON — picks and trades will post to live Discord",
          "ok"
        );
      });
    }
    // Stamp the clock immediately for whatever's currently on the board
    // (auto-sim default first slot etc.) and start the 1Hz repaint.
    _pickClockEnsureStarted();
    renderPickClock();
    _startPickClockTick();


    // Esc-to-close modal works on EVERY tab now (was only Live). If a
    // modal locks up for any reason, Esc gets the user out.
    document.addEventListener("keydown", (e) => {
      const overlay = document.getElementById("rdh-modal-overlay");
      const overlayOpen = overlay && overlay.classList.contains("open");
      if (e.key === "Escape" && overlayOpen) { closeModal(); return; }
      // Live-tab-only shortcuts (don't interfere with typing)
      if (STATE.activeTab !== "live") return;
      const tag = (document.activeElement && document.activeElement.tagName) || "";
      const isInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (isInput) return;
      if (e.key === "/") {
        const s = document.getElementById("prospect-search");
        if (s) { e.preventDefault(); s.focus(); s.select(); }
      } else if (e.key === "?") {
        e.preventDefault();
        showLiveHelp();
      }
    });

    // Backdrop click to dismiss any modal — important on mobile where the
    // user might miss a small ✕ button. Only fires when clicking the
    // overlay itself, not anything inside the modal panel.
    const overlayEl = document.getElementById("rdh-modal-overlay");
    if (overlayEl) {
      overlayEl.addEventListener("click", (e) => {
        if (e.target === overlayEl) closeModal();
      });
    }
  }

  function renderLiveModeBanner() {
    const banner = document.getElementById("live-mode-banner");
    if (!banner) return;
    const mode = STATE.simulationMode ? "simulate" : "live";
    banner.dataset.mode = mode;
    const pill = document.getElementById("live-mode-pill");
    if (pill) {
      // When dry-run is active AND we're in LIVE mode, label the pill
      // "LIVE • DRY-RUN" so it's impossible to mistake the test site for
      // production. The data-mode attribute also gets a "live-dry" variant
      // for CSS to render an unmistakable amber+red striped background.
      if (mode === "live" && STATE.dryRun) {
        pill.textContent = "LIVE • 🧪 DRY-RUN";
        banner.dataset.mode = "live-dry";
      } else {
        pill.textContent = mode === "live" ? "LIVE" : "SIMULATE";
      }
    }
    const greet = document.getElementById("live-mode-greeting");
    if (greet) {
      const me = STATE.me || {};
      if (me.configured && me.franchise_name) {
        greet.innerHTML = `<strong>${escapeHtml(me.franchise_name)}</strong>`;
      } else {
        greet.textContent = "Not signed in";
      }
    }
    // Commish-only LIVE toggle
    const toggle = document.getElementById("live-mode-toggle");
    const isCommish = !!(STATE.me && STATE.me.is_commish);
    if (toggle) {
      if (isCommish) {
        toggle.hidden = false;
        toggle.textContent = STATE.simulationMode ? "Go LIVE" : "Back to SIMULATE";
        toggle.className = STATE.simulationMode ? "btn danger" : "btn warn";
      } else {
        toggle.hidden = true;
      }
    }
    // Commish-only master Discord toggle (covers picks AND trades)
    const tradeDmBtn = document.getElementById("trade-discord-toggle");
    if (tradeDmBtn) {
      if (isCommish) {
        tradeDmBtn.hidden = false;
        const off = !!STATE.silenceTradeAnnouncements;
        tradeDmBtn.textContent = off ? "🔕 DM: OFF" : "📢 DM: ON";
        tradeDmBtn.title = off
          ? "Commish only — Discord announcements are OFF for picks AND trades. MFL writes still happen. Click to re-enable."
          : "Commish only — Discord announcements are ON. Click to silence ALL live Discord posts (picks + trades).";
        tradeDmBtn.className = off ? "btn warn" : "btn secondary";
      } else {
        tradeDmBtn.hidden = true;
      }
    }
    // On-the-clock headline
    const headline = document.getElementById("on-clock-headline");
    if (headline) {
      const live = STATE.live;
      const active = live && live.active_pick;
      if (active) {
        const slot = `R${active.round}.${String(active.pick).padStart(2, "0")}`;
        const fid = active.franchise_id || active.owned_by_franchise_id;
        const fname = (live.franchises && live.franchises[fid]) || fid || "—";
        headline.innerHTML = `On the clock: <strong>${escapeHtml(slot)}</strong> · ${escapeHtml(fname)}`;
      } else {
        headline.textContent = live && live.picks_made && live.picks_made.length
          ? "Draft complete"
          : "Draft has not started";
      }
    }
  }

  function flipLiveMode() {
    if (STATE.simulationMode) {
      const dryNote = STATE.dryRun
        ? "🧪 DRY-RUN MODE IS ACTIVE — submissions will be VALIDATED and PREVIEWED in test Discord, but NOT written to MFL or live Discord. Safe to rehearse.\n\n"
        : "";
      const baseCopy = STATE.dryRun
        ? "Submitting a pick will:\n" +
          "  • Validate the MFL request (no actual write)\n" +
          "  • Post a [DRY-RUN] preview to the TEST Discord channel\n" +
          "  • Show the same success UI you'll see on draft day\n\n" +
          "Continue?"
        : "Submitting a pick will:\n" +
          "  • POST to MFL's live draft (the player is drafted for real, " +
          "with the slot's rookie contract applied)\n" +
          "  • Post an announcement to the #live draft Discord channel\n\n" +
          "Both are recoverable if you mess up:\n" +
          "  • MFL pick → undo via Commissioner → Modify Draft Results\n" +
          "  • Discord post → delete the message\n\n" +
          "...but the hub itself has no \"undo\" button, so be deliberate.\n" +
          "Only do this on draft day. Continue?";
      const ok = confirm("Switch to LIVE mode?\n\n" + dryNote + baseCopy);
      if (!ok) return;
    }
    STATE.simulationMode = !STATE.simulationMode;
    try { sessionStorage.setItem("rdh_sim_mode", String(STATE.simulationMode)); } catch (e) {}
    renderLiveModeBanner();
    showToast(STATE.simulationMode ? "Switched to SIMULATE — picks won't hit MFL" : "🔴 LIVE MODE — picks will be submitted to MFL", STATE.simulationMode ? "ok" : "err");
    // Mode flip toggles inbox visibility + polling + the pick clock.
    if (STATE.simulationMode) {
      if (TRADE_INBOX.pollTimer) clearInterval(TRADE_INBOX.pollTimer);
      // Drop any leftover items from a previous LIVE session.
      TRADE_INBOX.items = [];
      // Stop live-state polling — keep showing whatever's currently on the board.
      if (typeof _liveStatePollTimer !== "undefined" && _liveStatePollTimer) {
        clearTimeout(_liveStatePollTimer);
        _liveStatePollTimer = null;
      }
      // Pick clock OFF in SIM — clear state so we don't carry over a stale
      // started_at if we flip back to LIVE later.
      STATE.activePickStartedAt = null;
      STATE.activePickClockKey = null;
      _pickClockPersist();
      renderPickClock();
    } else {
      _inboxStartPolling();
      // Kick off live-state polling immediately and pull a fresh state so the
      // commissioner sees real picks the moment they flip to LIVE. The
      // refresh handler will seed the clock from MFL's pick timestamp.
      _refreshLiveDraftState({ initial: true });
      // Stamp NOW as a fallback — the live-state refresh above will
      // overwrite with the MFL timestamp if available, but if it races
      // we still want the clock running from the moment of the flip.
      _pickClockEnsureStarted();
      renderPickClock();
    }
    _refreshInboxVisibility();
    _inboxRender();
  }

  function showModeHelp() {
    openModal(`
      <h3>Draft Modes</h3>
      <p style="line-height:1.6;">
        <strong style="color:var(--warn);">SIMULATE</strong> (default) — every "Draft Player" or "Submit Trade"
        click is validated and previewed, but <em>nothing is sent to MFL</em>.
        Discord announcements go to the test channel only. Use this to rehearse
        the entire flow risk-free.
      </p>
      <p style="line-height:1.6; margin-top: 10px;">
        <strong style="color:var(--err);">LIVE</strong> (commissioner only) — picks POST to MFL's <code>draftResults</code>
        endpoint and announce in the official Discord channel. Only flip during
        the real draft on Memorial Day Sunday.
      </p>
      <p style="line-height:1.6; margin-top: 10px; color: var(--muted);">
        <strong>What if I make a mistake in LIVE?</strong> Picks are recoverable —
        the hub itself doesn't have an undo button, but you can:
      </p>
      <ul style="line-height:1.6; color: var(--muted); margin-top: 4px;">
        <li>Undo a pick via <em>Commissioner → Modify Draft Results</em> in MFL.</li>
        <li>Delete the Discord post manually.</li>
        <li>Reverse a processed trade by punching in the opposite trade.</li>
      </ul>
      <p style="line-height:1.6; margin-top: 6px; color: var(--muted);">
        So it's deliberate, not irreversible. Click carefully — but don't panic if you fat-finger.
      </p>
      <div class="actions">
        <button class="btn" onclick="document.getElementById('rdh-modal-overlay').classList.remove('open')">Got it</button>
      </div>
    `);
  }

  function showLiveHelp() {
    openModal(`
      <h3>Live Draft — Keyboard & UI</h3>
      <table class="rdh-table" style="margin-top: 8px;">
        <tbody>
          <tr><td><kbd>/</kbd></td><td>Focus prospect search</td></tr>
          <tr><td><kbd>Esc</kbd></td><td>Close modal</td></tr>
          <tr><td><kbd>?</kbd></td><td>This help</td></tr>
          <tr><td>Click prospect</td><td>Queue them on the clock</td></tr>
          <tr><td>Click <strong>ⓘ</strong></td><td>Open full player profile</td></tr>
          <tr><td>Draft Player button</td><td>Confirm pick (always shows salary preview first)</td></tr>
          <tr><td>Propose Trade button</td><td>Open trade builder with both rosters</td></tr>
        </tbody>
      </table>
      <div class="actions">
        <button class="btn" onclick="document.getElementById('rdh-modal-overlay').classList.remove('open')">Close</button>
      </div>
    `);
  }

  // Lightweight non-blocking toast — auto-fades after 3.5s
  function showToast(msg, kind) {
    const old = document.querySelector(".live-toast");
    if (old) old.remove();
    const t = document.createElement("div");
    t.className = "live-toast toast-" + (kind || "ok");
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => { try { t.remove(); } catch (e) {} }, 3500);
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
    // Strip per-modal modifier classes (re-applied by callers like trade modal)
    modal.className = "";
    modal.id = "rdh-modal";
    modal.innerHTML = html;
    document.getElementById("rdh-modal-overlay").classList.add("open");
    // When rendered inside an iframe (HPM embed), the modal's centered
    // position fixes to the IFRAME's viewport, not the parent page's. If
    // the iframe is taller than the visible parent viewport (common for
    // a 1600px+ hub on a phone or laptop), the modal lands off-screen.
    // Two-pronged fix:
    //   1. Scroll the iframe's own viewport to top (no-op outside iframe).
    //   2. postMessage the parent to scroll the iframe into view.
    try {
      window.scrollTo(0, 0);
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: "draft-hub-modal-open" }, "*");
      }
    } catch (e) {}
    // Always center via the overlay's flexbox — no click-anchored positioning.
    // (The trade modal applies its own fixed centering on top of this for
    //  consistency in tall-content cases.)
    modal.style.position = "";
    modal.style.top = "";
    modal.style.left = "";
    modal.style.transform = "";
    modal.style.margin = "";
    // MFL embed fix (Keith 2026-05-24): when the hub is rendered inside
    // MFL's MESSAGE module, MFL's outer page has a CSS `transform` on an
    // ancestor which breaks `position: fixed` (it becomes positioned
    // relative to the transformed ancestor instead of the viewport).
    // Result: modal renders at the TOP of MFL's content frame instead of
    // the user's current viewport — they have to scroll to find it.
    // Workaround: scrollIntoView() on the modal box forces the browser
    // to scroll its containing block until the modal is visible. Works
    // regardless of whether `fixed` is honored or has degraded to `absolute`.
    requestAnimationFrame(() => {
      const overlay = document.getElementById("rdh-modal-overlay");
      if (!overlay || !overlay.classList.contains("open")) return;
      const box = overlay.querySelector(".rdh-modal");
      try {
        (box || overlay).scrollIntoView({ behavior: "auto", block: "center", inline: "center" });
      } catch (e) {}
    });
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
        const revertable = pick && _canRevert();
        const revertIcon = revertable
          ? `<button class="pk-revert" title="Revert this pick" data-round="${round}" data-slot="${slot}" type="button">↶</button>`
          : "";
        div.innerHTML = `
          <div class="pk-slot">${round}.${String(slot).padStart(2, "0")}${revertIcon}</div>
          <div class="pk-name">${name || "<em>on deck</em>"}</div>
          <div class="pk-team">${team}</div>
          ${chips}
        `;
        if (revertable) {
          div.querySelector(".pk-revert").addEventListener("click", (e) => {
            e.stopPropagation();
            openRevertModal(round, slot);
          });
        }
        board.appendChild(div);
      }
    }
    const madeCount = live.picks_made ? live.picks_made.length : 0;
    const queuedCount = live.draft_order ? live.draft_order.length : 0;
    // Source label: 'live' if we successfully overlaid MFL data, else fall
    // back to 'snapshot' tagged with the static-build timestamp.
    const isLive = live.meta && live.meta.source === "mfl_live" && live.meta.as_of;
    const stamp = isLive
      ? `live from MFL ${new Date(live.meta.as_of).toLocaleTimeString()}`
      : `snapshot ${new Date(live.meta.generated_at_utc).toLocaleString()}`;
    document.getElementById("live-board-summary").textContent =
      `${madeCount} picks made · ${queuedCount - madeCount} on the clock · ${stamp}`;

    renderMyTeam();
    renderMyQueue();
    _maybeAutoSelectFromQueue();
    renderProspects();
    renderSalarySchedule();
    renderOnClockPanel();
    renderLiveModeBanner();
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
    const adpSource = adpSourceEl ? adpSourceEl.value : "consensus";
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

    // Resolve the displayed value per prospect for the selected source.
    // For consensus + per-source picks we display a RANK (lower = better).
    // For mfl_rookie we have a real avg-pick number; for FC/KTC we display
    // the source's rookie rank (already an integer).
    const adpOf = (p) => {
      if (adpSource === "consensus") return _customConsensusFor(p);
      if (adpSource === "mfl_rookie") return p.adp_sources?.mfl_rookie ?? p.rookie_adp ?? null;
      if (adpSource === "fantasycalc") return p.source_ranks?.fantasycalc ?? null;
      if (adpSource === "ktc_sf") return p.source_ranks?.ktc ?? null;
      if (adpSource === "sleeper") return p.source_ranks?.sleeper ?? null;
      if (adpSource === "fantasypros") return p.source_ranks?.fantasypros ?? null;
      // Legacy fallbacks
      if (p.adp_sources && p.adp_sources[adpSource] != null) return p.adp_sources[adpSource];
      return null;
    };

    // _customConsensusFor — recompute the median rank using ONLY the sources
    // the user has checked. If all 5 sources are checked, this matches the
    // pre-computed p.consensus_rank exactly.
    function _customConsensusFor(p) {
      const sr = p.source_ranks || {};
      const filt = STATE.rankSourceFilter;
      const ranks = [];
      for (const src of ["mfl_rookie", "fantasycalc", "ktc", "sleeper", "fantasypros"]) {
        if (!filt.has(src)) continue;
        const v = sr[src];
        if (typeof v === "number" && v > 0) ranks.push(v);
      }
      if (!ranks.length) return null;
      ranks.sort((a, b) => a - b);
      const mid = Math.floor(ranks.length / 2);
      return ranks.length % 2 ? ranks[mid] : (ranks[mid - 1] + ranks[mid]) / 2;
    }
    rows.sort((a, b) => {
      const av = adpOf(a); const bv = adpOf(b);
      if (av == null) return 1;
      if (bv == null) return -1;
      return av - bv;  // all rank-based now → ascending
    });
    list.innerHTML = rows.slice(0, 150).map(p => {
      const d = drafted[String(p.player_id)];
      // Display "Last, First" → "First Last" inline
      const dispName = (p.name || "").includes(",")
        ? p.name.split(",").reverse().map(s => s.trim()).join(" ")
        : p.name;
      const draftedTag = d
        ? `<div class="small" style="color:var(--accent); font-size:10px;">Pick ${d.round}.${String(d.pick).padStart(2,"0")} · ${d.franchise_name}</div>`
        : "";
      // NFL draft summary badge — UDFA gets a distinct color
      let nflBadge = "";
      if (p.nfl_draft_summary) {
        const isUdfa = !!p.is_udfa;
        const color = isUdfa ? "var(--muted)" : "var(--ok)";
        const bg = isUdfa ? "rgba(138,151,173,0.15)" : "rgba(74,222,128,0.15)";
        nflBadge = `<span class="nfl-pick-badge" style="background:${bg}; color:${color}; padding:1px 6px; border-radius:3px; font-size:10px; font-weight:600; margin-left:6px;">${escapeHtml(p.nfl_draft_summary)}</span>`;
      }
      const collegeBit = p.college
        ? ` <span class="small" style="color:var(--muted); font-size:10px;">· ${escapeHtml(p.college)}${p.age ? " · " + p.age + "yo" : ""}</span>`
        : (p.age ? ` <span class="small" style="color:var(--muted); font-size:10px;">· ${p.age}yo</span>` : "");
      return `
        <div class="prospect-row" data-pid="${p.player_id}"
             style="display:flex; justify-content:space-between; align-items:flex-start; padding:6px 8px; border-bottom:1px solid var(--border); font-size:12px; ${d ? 'opacity:0.55;' : ''}">
          <div style="flex:1; cursor:pointer; min-width: 0;" class="prospect-select">
            <div style="display:flex; align-items:center; flex-wrap:wrap; gap:2px;">
              <strong>${escapeHtml(dispName)}</strong>${nflBadge}
            </div>
            <div class="small" style="color:var(--muted); font-size:10px; margin-top:1px;">
              ${POS_COMBINED(p.position) || "-"}${p.nfl_team && p.nfl_team !== "FA" ? " · " + escapeHtml(p.nfl_team) : ""}${collegeBit}
            </div>
            ${draftedTag}
          </div>
          <button class="prospect-queue-btn ${STATE.myQueue.includes(String(p.player_id)) ? 'is-queued' : ''}"
                  data-pid="${p.player_id}"
                  title="${STATE.myQueue.includes(String(p.player_id)) ? 'Already queued' : 'Add to my queue'}"
                  ${d ? 'style="opacity:0.3; cursor:not-allowed;"' : ''}
                  ${d ? 'disabled' : ''}>${STATE.myQueue.includes(String(p.player_id)) ? '✓' : '+'}</button>
          <button class="prospect-profile-btn" data-pid="${p.player_id}"
                  style="background:transparent; border:0; color:var(--muted); font-size:14px; cursor:pointer; margin: 0 6px; align-self:center;"
                  title="View profile">ⓘ</button>
          <div class="num prospect-rank-cell" style="color:var(--muted); font-size:11px; width: 86px; text-align: right; align-self:center;"
               title="${adpSource === 'consensus'
                       ? `Custom consensus rank · median across ${[...STATE.rankSourceFilter].length} selected source(s)\nMFL: ${p.source_ranks?.mfl_rookie ?? '—'} · FC: ${p.source_ranks?.fantasycalc ?? '—'} · KTC: ${p.source_ranks?.ktc ?? '—'} · SLP: ${p.source_ranks?.sleeper ?? '—'} · FP: ${p.source_ranks?.fantasypros ?? '—'}`
                       : adpSource === 'mfl_rookie' ? 'MFL avg pick across cross-league rookie drafts'
                       : adpSource === 'fantasycalc' ? 'FantasyCalc SF rookie rank'
                       : adpSource === 'ktc_sf' ? 'KeepTradeCut SF rookie rank'
                       : adpSource === 'sleeper' ? 'Sleeper SF rookie rank'
                       : adpSource === 'fantasypros' ? 'FantasyPros rookie ADP rank' : ''}">
            ${(() => {
              const v = adpOf(p);
              if (v == null) return '<span style="color:var(--muted); opacity:0.6;">—</span>';
              if (adpSource === "consensus") {
                // Count of sources actually contributing to THIS prospect's
                // custom consensus (intersection of filter and source_ranks).
                const sr = p.source_ranks || {};
                let n = 0;
                for (const src of STATE.rankSourceFilter) {
                  if (typeof sr[src] === "number" && sr[src] > 0) n++;
                }
                return `<strong style="color:var(--text);">#${Number.isInteger(v) ? v : v.toFixed(1)}</strong>` +
                       (n ? ` <span style="opacity:0.7; font-size:10px;">${n}src</span>` : "");
              }
              if (adpSource === "mfl_rookie") return `ADP ${(typeof v === 'number' ? v.toFixed(1) : v)}`;
              return `#${v}`;
            })()}
          </div>
        </div>
      `;
    }).join("");
    list.querySelectorAll(".prospect-select").forEach(el => {
      el.addEventListener("click", () => {
        const row = el.closest(".prospect-row");
        const pid = row.getAttribute("data-pid");
        // Block queueing an already-drafted prospect — they can't be picked again.
        if (drafted[String(pid)]) {
          showToast("That prospect is already drafted.", "err");
          return;
        }
        const p = STATE.prospects.prospects.find(x => x.player_id === pid);
        STATE.selectedProspect = p;
        // Manually picking a prospect cancels any pending auto-pick from queue
        // — this prospect overrides the queue head.
        _cancelAutoPick(typeof _autoPickTimer !== "undefined" && _autoPickTimer
          ? "Auto-pick cancelled — you picked a different prospect" : null);
        renderOnClockPanel();
      });
    });
    list.querySelectorAll(".prospect-profile-btn").forEach(el => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        showPlayerProfileCard(el.dataset.pid);
      });
    });
    list.querySelectorAll(".prospect-queue-btn").forEach(el => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        if (el.disabled) return;
        const pid = el.dataset.pid;
        if (STATE.myQueue.includes(String(pid))) return;  // already queued
        _addToQueue(pid);
        showToast("Added to your queue", "ok");
      });
    });
    // Update visible-count chip + empty-state
    const countEl = document.getElementById("prospect-count");
    if (countEl) {
      const total = STATE.prospects.prospects.length;
      countEl.textContent = `${rows.length} of ${total} shown`;
    }
    if (!rows.length && list) {
      list.innerHTML = `<div class="ap-empty" style="padding:24px 12px; text-align:center; color:var(--muted);">No prospects match — try clearing filters.</div>`;
    }
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
    // Show "First Last" for the on-clock-card readability
    const prospectDisplayName = prospect && prospect.name && prospect.name.includes(",")
      ? prospect.name.split(",").reverse().map(s => s.trim()).join(" ")
      : (prospect && prospect.name) || "";
    // Per-source rank breakdown — surfaces "groupthink" transparency.
    const sr = (prospect && prospect.source_ranks) || {};
    const srcBits = [];
    if (sr.mfl_rookie != null) srcBits.push(`<span title="MFL cross-league rookie ADP rank">MFL #${sr.mfl_rookie}</span>`);
    if (sr.fantasycalc != null) srcBits.push(`<span title="FantasyCalc SF rookie rank">FC #${sr.fantasycalc}</span>`);
    if (sr.ktc != null) srcBits.push(`<span title="KeepTradeCut SF rookie rank">KTC #${sr.ktc}</span>`);
    if (sr.sleeper != null) srcBits.push(`<span title="Sleeper SF rookie rank (re-ranked from search_rank)">SLP #${sr.sleeper}</span>`);
    if (sr.dp != null) srcBits.push(`<span title="DynastyProcess SF rookie rank">DP #${sr.dp}</span>`);
    const consensusLine = prospect && prospect.consensus_rank != null
      ? `<div class="small" style="color: var(--text); margin-top: 4px; font-weight:500;">
           Consensus <strong style="color:var(--accent);">#${Number.isInteger(prospect.consensus_rank) ? prospect.consensus_rank : prospect.consensus_rank.toFixed(1)}</strong>
           <span class="small" style="color:var(--muted); margin-left:4px;">across ${prospect.consensus_n_sources || 0} src${(prospect.consensus_rank_min && prospect.consensus_rank_max && prospect.consensus_rank_min !== prospect.consensus_rank_max) ? ` (#${prospect.consensus_rank_min}–#${prospect.consensus_rank_max})` : ""}</span>
         </div>
         ${srcBits.length ? `<div class="small" style="color: var(--muted); font-size: 10px; margin-top: 2px; display:flex; flex-wrap:wrap; gap:6px;">${srcBits.join("·")}</div>` : ""}`
      : "";
    // Is the *user's* franchise on the clock? Show a clear banner so they
    // know they need to act (esp. after a trade swap brings their pick up).
    const myFid = (STATE.me && STATE.me.franchise_id) || (AUTO_SIM && AUTO_SIM.playAsFid) || null;
    const userOnClock = myFid && String(fid) === String(myFid);
    const yourTurnBanner = userOnClock ? `
      <div style="background:rgba(74,222,128,0.12); border:1px solid rgba(74,222,128,0.5); border-radius:6px; padding:10px 12px; margin-bottom:10px;">
        <div style="font-size:11px; color:var(--ok); text-transform:uppercase; letter-spacing:0.6px; font-weight:700;">👉 You're on the clock</div>
        <div style="font-size:13px; color:var(--text); margin-top:2px;">${prospect ? "Confirm your pick below ↓" : "Click a prospect from the left rail to queue your selection."}</div>
      </div>` : "";
    const prospectHtml = prospect ? `
      <div style="background: var(--panel-alt); padding: 10px; border-radius: 4px; margin-bottom: 10px;">
        <a href="#" class="player-link" id="otc-profile" data-pid="${prospect.player_id}"><strong>${escapeHtml(prospectDisplayName)}</strong></a>
        <span class="small">${escapeHtml(prospect.position || "")}${prospect.nfl_team && prospect.nfl_team !== "FA" ? " · " + escapeHtml(prospect.nfl_team) : ""}${prospect.nfl_draft_summary ? ` <span class="small" style="color:${prospect.is_udfa ? 'var(--muted)' : 'var(--ok)'}; margin-left:4px;">· ${escapeHtml(prospect.nfl_draft_summary)}</span>` : ""}</span>
        ${prospect.college || prospect.age ? `<div class="small" style="color: var(--muted); margin-top: 2px;">${prospect.college ? escapeHtml(prospect.college) : ""}${prospect.college && prospect.age ? " · " : ""}${prospect.age ? prospect.age + "yo" : ""}${prospect.height ? " · " + escapeHtml(prospect.height) : ""}${prospect.weight ? " · " + prospect.weight + "lb" : ""}</div>` : ""}
        ${consensusLine}
      </div>
    ` : `<div class="small" style="color: var(--muted); margin-bottom: 10px;">${userOnClock ? "" : "Click a prospect to queue up a pick."}</div>`;
    // If an auto-pick is pending (queue + opt-in checkbox + user on clock),
    // surface a clearly-labeled inline panel with a Cancel button. The
    // toast alone is too easy to miss.
    const autoPickPending = (typeof _autoPickTimer !== "undefined" && _autoPickTimer)
      && prospect && _autoPickPid && String(_autoPickPid) === String(prospect.player_id);
    const autoPickBanner = autoPickPending ? `
      <div class="auto-pick-pending">
        <span class="auto-pick-pending-label">🤖 Auto-picking <strong>${escapeHtml(prospectDisplayName)}</strong> in <span id="auto-pick-countdown">3</span>s…</span>
        <button class="btn warn" id="auto-pick-cancel" type="button">Cancel</button>
      </div>` : "";
    panel.innerHTML = `
      <div style="font-size: 20px; font-weight: 600;">${slotLabel}</div>
      <div style="color: var(--muted); margin-bottom: 10px;">${fname} on the clock</div>
      ${yourTurnBanner}
      ${tierHtml}
      ${prospectHtml}
      ${autoPickBanner}
      <button class="btn" id="submit-pick-btn" ${prospect ? "" : "disabled style='opacity:0.5; cursor: not-allowed;'"}>
        Draft Player
      </button>
      <button class="btn secondary" id="propose-trade-btn" style="margin-left: 6px;">Propose Trade</button>
    `;
    if (autoPickPending) {
      const cancelBtn = document.getElementById("auto-pick-cancel");
      if (cancelBtn) cancelBtn.addEventListener("click", () => {
        _cancelAutoPick("Auto-pick cancelled — confirm your pick manually");
        renderOnClockPanel();
      });
      // Visible 3-2-1 countdown
      let remaining = 3;
      const cdEl = document.getElementById("auto-pick-countdown");
      const cdTimer = setInterval(() => {
        remaining -= 1;
        if (cdEl) cdEl.textContent = String(Math.max(0, remaining));
        if (remaining <= 0 || !_autoPickTimer) clearInterval(cdTimer);
      }, 1000);
    }
    panel.querySelectorAll(".tier-click").forEach(el => {
      el.addEventListener("click", () => showTierPopup(el.dataset.tier));
    });
    const submitBtn = document.getElementById("submit-pick-btn");
    if (submitBtn && prospect) {
      // Disable the button if this prospect is already drafted somewhere else.
      const draftedNow = ((STATE.live && STATE.live.picks_made) || [])
        .find(p => String(p.player_id) === String(prospect.player_id));
      if (draftedNow) {
        submitBtn.disabled = true;
        submitBtn.style.opacity = "0.5";
        submitBtn.style.cursor = "not-allowed";
        submitBtn.title = `Already drafted at ${draftedNow.round}.${String(draftedNow.pick).padStart(2,"0")}`;
        STATE.selectedProspect = null;  // clear so user picks fresh
      } else {
        submitBtn.addEventListener("click", () => openPickConfirmModal(active, prospect));
      }
    }
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

  // ── Rookie slot → contract terms (UPS league rules, league_context_v1.md A1) ──
  // Returns { aav, tcv, length, notes[], optionYearSalary?, optionDecisionYear? }
  // for any (round, slot). Used by the pick-confirm modal to show owners exactly
  // what salary/contract MFL will apply when the pick is recorded.
  function rookieSlotContract(round, slot) {
    const r = Number(round) || 0;
    const s = Number(slot) || 0;
    const length = 3;
    let aav = 0;
    const notes = [];
    let optionYearSalary = null;
    let optionDecisionYear = null;

    if (r === 1) {
      // 1.01 = $15K, linear $1K decrement through 1.10 = $6K, 1.11–1.12 = $5K floor
      aav = s <= 10 ? Math.max(6, 16 - s) : 5;
      // Round 1 picks (2025+) get a 4th-year team option = Y3 + $5K
      optionYearSalary = aav + 5;
      // Decision: Sept of the player's final original-contract season (=draft year + 2)
      const draftYear = (STATE.live && STATE.live.meta && STATE.live.meta.season)
        ? Number(STATE.live.meta.season) : new Date().getFullYear();
      optionDecisionYear = draftYear + 2;
      notes.push(`+ 4th-year team option @ $${optionYearSalary}K (decide by Sept ${optionDecisionYear})`);
      notes.push("Active roster only — NOT taxi-eligible");
    } else if (r === 2) {
      aav = 5;
      notes.push("Taxi-eligible for first 3 league years");
    } else if (r >= 3 && r <= 5) {
      aav = 2;
      notes.push("Taxi-eligible for first 3 league years");
    } else if (r === 6) {
      aav = 1;
      notes.push("IDP only — pick not tradeable");
    }

    return { aav, tcv: aav * length, length, notes, optionYearSalary, optionDecisionYear };
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
    // Delegate to the unified master modal when available (v1.7.43+).
    // Falls through to the legacy inline implementation if the master
    // module didn't load (jsDelivr lag, local preview without the
    // shared script, etc.) so the hub is never left with a dead
    // click-handler.
    if (typeof window.UPS_openPlayerProfile === "function") {
      try {
        window.UPS_openPlayerProfile(pid, {
          apiBase: (typeof window.UPS_DRAFT_HUB_API_BASE === "string" && window.UPS_DRAFT_HUB_API_BASE) || "",
          leagueId: (typeof window.UPS_DRAFT_HUB_LEAGUE_ID === "string" && window.UPS_DRAFT_HUB_LEAGUE_ID) || "",
          year: (typeof window.UPS_DRAFT_HUB_YEAR === "string" && window.UPS_DRAFT_HUB_YEAR) || "",
          mode: "rookie_draft",
          prospects: STATE.prospects,
          history: STATE.history,
          leverageCoefs: STATE.leverageCoefs || (STATE.history && STATE.history.leverage_coefs) || null
        });
        return;
      } catch (e) {
        // fall through to legacy inline render
        console.warn("[rdh] master profile modal failed, falling back:", e);
      }
    }
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
    // Headshot priority: MFL icon_url → ESPN college (for fresh rookies who
    // haven't played NFL yet; we have espn_id from the prospect board) →
    // ESPN NFL → MFL stable archive. The <img onerror> chain falls through
    // each in order, hiding to placeholder if all 4 404.
    const _prospectRowHS = (STATE.prospects && STATE.prospects.prospects || [])
      .find(x => String(x.player_id) === String(pid)) || {};
    const espnId = _prospectRowHS.espn_id || pp.espn_id || null;
    const photoFallbacks = [];
    if (pp.icon_url) photoFallbacks.push(pp.icon_url);
    if (espnId) {
      photoFallbacks.push(`https://a.espncdn.com/i/headshots/college-football/players/full/${espnId}.png`);
      photoFallbacks.push(`https://a.espncdn.com/i/headshots/nfl/players/full/${espnId}.png`);
    }
    if (pid) photoFallbacks.push(`https://www48.myfantasyleague.com/player_photos_2014/${pid}_thumb.jpg`);
    const photoUrl = photoFallbacks[0] || "";
    // Build the onerror chain: walk to next URL on failure, hide to placeholder when out
    const photoOnError = photoFallbacks.length > 1
      ? `(function(img,urls){let i=0;img.onerror=function(){i++;if(i<urls.length){img.src=urls[i];}else{img.replaceWith(Object.assign(document.createElement('div'),{className:'profile-photo-placeholder'}));}};})(this, ${JSON.stringify(photoFallbacks).replace(/"/g, '&quot;')})`
      : `this.replaceWith(Object.assign(document.createElement('div'), {className: 'profile-photo-placeholder'}))`;
    // Most-recent contract from D1 contract_history (used for critical-
    // salary strip on Bio tab). contract_history is ordered season DESC.
    const ch = Array.isArray(bundle.contract_history) ? bundle.contract_history : [];
    const currentContract = ch[0] || null;
    const leverageCoefs = bundle.leverage_coefs || {};

    // ── Bio tab ──────────────────────────────────────────────────────
    // Prospect-board fallback — when the MFL bundle returns nothing (local
    // preview, or for fresh rookies MFL hasn't enriched yet), fill in
    // height/weight/college/age/draft from the prospect record we already
    // have loaded. This is what makes the profile non-empty for current-year
    // rookies without needing the live worker.
    const prospectFallback = (STATE.prospects && STATE.prospects.prospects || [])
      .find(p => String(p.player_id) === String(pid)) || {};
    const bioHeight = pp.height || prospectFallback.height || "";
    const bioWeight = pp.weight || (prospectFallback.weight ? prospectFallback.weight + " lb" : "");
    const bioCollege = pp.college || prospectFallback.college || "";
    const bioBornStr = pp.birthdate
      ? formatMflDate(pp.birthdate)
      : (prospectFallback.age ? `~${prospectFallback.age} years old` : "");
    const bioDraft = pp.draft_year
      ? `${pp.draft_year}${pp.draft_team ? " · " + pp.draft_team : ""}${pp.draft_round ? " · R" + pp.draft_round + ", P" + (pp.draft_pick || "?") : ""}`
      : (prospectFallback.nfl_draft_summary || "");
    const bioJersey = pp.jersey || "";
    // Pre-NFL summary banner for fresh rookies (no career stats yet)
    const isFreshRookie = String(prospectFallback.player_id || "") === String(pid)
      && (!career.length);
    const freshRookieBanner = isFreshRookie ? `
      <div style="background:rgba(91,141,255,0.10); border-left:3px solid var(--accent); padding:10px 14px; border-radius:4px; margin-bottom:14px;">
        <div style="font-size:11px; color:var(--accent); text-transform:uppercase; letter-spacing:0.5px; font-weight:700;">2026 Rookie Class · Pre-NFL prospect</div>
        <div style="font-size:13px; color:var(--text); margin-top:4px; line-height:1.5;">
          ${prospectFallback.is_udfa ? "UDFA — undrafted free agent" : (prospectFallback.nfl_draft_summary || "Draft details TBD")}
          ${prospectFallback.nfl_team ? " · signed with <strong>" + escapeHtml(prospectFallback.nfl_team) + "</strong>" : ""}
        </div>
        ${prospectFallback.consensus_rank ? `
          <div style="font-size:12px; color:var(--muted); margin-top:6px;">
            UPS rookie consensus rank <strong style="color:var(--text);">#${prospectFallback.consensus_rank}</strong>
            ${prospectFallback.consensus_n_sources ? ` <span style="opacity:0.7;">across ${prospectFallback.consensus_n_sources} sources</span>` : ""}
            ${prospectFallback.source_ranks ? `
              <span style="opacity:0.8; margin-left:8px;">
                ${prospectFallback.source_ranks.mfl_rookie != null ? "MFL #" + prospectFallback.source_ranks.mfl_rookie : ""}
                ${prospectFallback.source_ranks.fantasycalc != null ? " · FC #" + prospectFallback.source_ranks.fantasycalc : ""}
                ${prospectFallback.source_ranks.ktc != null ? " · KTC #" + prospectFallback.source_ranks.ktc : ""}
                ${prospectFallback.source_ranks.sleeper != null ? " · SLP #" + prospectFallback.source_ranks.sleeper : ""}
              </span>
            ` : ""}
          </div>` : ""}
      </div>` : "";
    const bioHtml = `
      ${freshRookieBanner}
      <div class="profile-bio">
        ${photoUrl ? `<img src="${photoUrl}" alt="${escapeHtml(name)}" class="profile-photo" onerror="${photoOnError}">` : '<div class="profile-photo-placeholder"></div>'}
        <div class="profile-bio-text">
          ${bioHeight ? `<div><span class="lbl">Height</span>${escapeHtml(bioHeight)}</div>` : ""}
          ${bioWeight ? `<div><span class="lbl">Weight</span>${escapeHtml(String(bioWeight))}</div>` : ""}
          ${bioCollege ? `<div><span class="lbl">College</span>${escapeHtml(bioCollege)}</div>` : ""}
          ${bioBornStr ? `<div><span class="lbl">${pp.birthdate ? "Born" : "Age"}</span>${escapeHtml(bioBornStr)}</div>` : ""}
          ${bioDraft ? `<div><span class="lbl">NFL Draft</span>${escapeHtml(bioDraft)}</div>` : ""}
          ${bioJersey ? `<div><span class="lbl">Jersey</span>#${escapeHtml(bioJersey)}</div>` : ""}
          ${prospectFallback.espn_id ? `<div><span class="lbl">ESPN ID</span><a href="https://www.espn.com/college-football/player/_/id/${escapeHtml(prospectFallback.espn_id)}" target="_blank" rel="noopener" style="color:var(--accent);">${escapeHtml(prospectFallback.espn_id)}</a></div>` : ""}
        </div>
      </div>

      ${(() => {
        // One highlight link per player — opens a YouTube search in a new tab.
        // Rookies → College highlights. Veterans → NFL highlights.
        // No embedding (would need YouTube API + quota for video IDs).
        const yt = (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
        const college = bioCollege || "";
        const team = nflTeam || prospectFallback.nfl_team || pp.team || "";
        let link = null;
        if (isFreshRookie && college) {
          link = { label: "🎬 College highlights", url: yt(`${name} ${college} highlights`) };
        } else if (team && team !== "FA") {
          link = { label: "🏈 NFL highlights", url: yt(`${name} ${team} highlights`) };
        }
        if (!link) return "";
        return `
          <div class="profile-block">
            <div class="profile-watch-links">
              <a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer" class="profile-watch-link yt">${link.label}</a>
            </div>
          </div>`;
      })()}

      ${currentContract ? `
      <div class="upm-salary-strip">
        <div class="upm-salary-card"><span class="lbl">Years Remaining</span><span class="val">${currentContract.contract_length ? currentContract.contract_length - (currentContract.contract_year || 1) + 1 : "—"}</span></div>
        <div class="upm-salary-card"><span class="lbl">AAV</span><span class="val">${currentContract.aav ? "$" + Number(currentContract.aav).toLocaleString() : "—"}</span></div>
        <div class="upm-salary-card"><span class="lbl">TCV</span><span class="val">${currentContract.tcv ? "$" + Number(currentContract.tcv).toLocaleString() : "—"}</span></div>
        <div class="upm-salary-card"><span class="lbl">Contract</span><span class="val" style="font-size:13px;">${escapeHtml(currentContract.contract_status || (currentContract.extension_flag ? "Extended" : "Active"))}${(currentContract.taxi || currentContract.is_taxi || /TAXI/i.test(String(currentContract.contract_status || currentContract.roster_status || ""))) ? '<span class="taxi-pill">TAXI</span>' : ''}</span></div>
      </div>` : ""}

      ${(() => {
        // Show LEAGUE STATUS only when there's something meaningful to say.
        // Hide it for fresh rookies (Status=Unknown + Hub Tier=Unclassified is just noise).
        const hasMeaningfulStatus = bundle.is_free_agent || bundle.is_not_rostered || cr.team_name;
        const hasInjury = inj.status && !bundle.is_free_agent && !bundle.is_not_rostered;
        const hasAcq = !bundle.is_free_agent && !bundle.is_not_rostered && add.datetime_et;
        const hasMeaningfulTier = hist.tier && hist.tier !== "Unclassified";
        if (!hasMeaningfulStatus && !hasInjury && !hasAcq && !hasMeaningfulTier) return "";
        return `
        <div class="profile-block">
          <h4>League Status</h4>
          <div class="profile-kv">
            ${bundle.is_free_agent
              ? `<div><span class="lbl">Status</span><span style="color: var(--warn); font-weight:600">Free Agent</span></div>`
              : bundle.is_not_rostered
              ? `<div><span class="lbl">Status</span><span style="color: var(--muted); font-weight:600">Not on any roster</span> <span class="small" style="color:var(--muted)">(retired / out of league)</span></div>`
              : cr.team_name
                ? `<div><span class="lbl">Owner</span>${escapeHtml(cr.team_name)}</div>${cr.status ? `<div><span class="lbl">Roster</span>${escapeHtml(cr.status)}</div>` : ""}`
                : ""}
            ${hasInjury ? `<div><span class="lbl">Injury</span><span style="color: var(--warn)">${escapeHtml(inj.status)}${inj.details ? " — " + escapeHtml(inj.details) : ""}</span></div>` : ""}
            ${hasAcq ? `<div><span class="lbl">Acquired</span>${escapeHtml(add.method || "")} ${add.salary ? "$" + Number(add.salary).toLocaleString() : ""} · ${escapeHtml(add.datetime_et.slice(0, 10))} by ${escapeHtml(add.franchise_name || "")}</div>` : ""}
            ${hasMeaningfulTier ? `<div><span class="lbl">Hub Tier</span><span class="tier ${tierSlug(hist.tier)}">${hist.tier}</span>${hist.best_ep_rate != null ? ` · Best E+P ${(hist.best_ep_rate * 100).toFixed(0)}%` : ""}</div>` : ""}
          </div>
        </div>`;
      })()}

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
    })() : (() => {
      // No NFL career on record. For current-year rookies (just drafted),
      // render a richer "Pre-NFL prospect" panel instead of an empty message.
      const draftYear = String(pp.draft_year || "");
      const currentYear = String(window.UPS_DRAFT_HUB_YEAR || new Date().getFullYear());
      const isFreshRookie = draftYear === currentYear;
      // Try to find this player in our prospect board for the enriched fields
      // (age, NFL pick summary, college, height/weight). Falls back to the raw
      // MFL playerProfile fields when the prospect board doesn't have them.
      const pData = (STATE.prospects && STATE.prospects.prospects) || [];
      const prospectRow = pData.find(x => String(x.player_id) === String(pid)) || {};
      const college = prospectRow.college || pp.college || null;
      const age = prospectRow.age || null;
      const height = prospectRow.height || pp.height || null;
      const weight = prospectRow.weight || pp.weight || null;
      const nflTeamCur = prospectRow.nfl_team || pp.team || null;
      let draftSummary = prospectRow.nfl_draft_summary;
      if (!draftSummary && pp.draft_round && pp.draft_pick) {
        draftSummary = `R${pp.draft_round}.${pp.draft_pick}${pp.draft_team ? " · " + pp.draft_team : ""}`;
      } else if (!draftSummary && pp.team && draftYear) {
        draftSummary = `UDFA · ${pp.team}`;
      }
      if (!isFreshRookie) {
        return `<p class="small" style="color:var(--muted)">No career data yet — this player has no scored weeks on record.</p>`;
      }
      const facts = [];
      if (draftSummary) facts.push(`<div><span class="lbl">${prospectRow.is_udfa ? "Status" : "NFL Draft"}</span><strong style="color:${prospectRow.is_udfa ? "var(--muted)" : "var(--ok)"};">${escapeHtml(draftSummary)}</strong></div>`);
      else if (nflTeamCur) facts.push(`<div><span class="lbl">NFL Team</span><strong>${escapeHtml(nflTeamCur)}</strong></div>`);
      if (college) facts.push(`<div><span class="lbl">College</span>${escapeHtml(college)}</div>`);
      if (age) facts.push(`<div><span class="lbl">Age</span>${age}</div>`);
      if (height) facts.push(`<div><span class="lbl">Height</span>${escapeHtml(String(height))}</div>`);
      if (weight) facts.push(`<div><span class="lbl">Weight</span>${weight} lbs</div>`);
      const adpLine = (prospectRow.rookie_adp != null)
        ? `<div class="small" style="color:var(--muted); margin-top:6px;">UPS rookie ADP <strong>${prospectRow.rookie_adp.toFixed(1)}</strong>${prospectRow.rookie_adp_rank ? " (#" + prospectRow.rookie_adp_rank + ")" : ""} across ${prospectRow.rookie_adp_n_drafts || "—"} mocks</div>`
        : "";
      return `
        <div class="profile-block">
          <h4>Pre-NFL Prospect — ${escapeHtml(currentYear)} Rookie Class</h4>
          <p class="small" style="color:var(--muted); margin: 0 0 10px;">
            ${escapeHtml(name)} hasn't logged an NFL game yet. Below is the
            scouting-relevant snapshot from the MFL profile + UPS prospect board.
            College stats aren't pulled in (yet) — kept off the hub by design.
          </p>
          <div class="profile-kv" style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:8px;">
            ${facts.join("\n")}
          </div>
          ${adpLine}
        </div>
        <div class="profile-block">
          <h4>What you'll see here once games start</h4>
          <ul class="small" style="color:var(--muted); margin:6px 0 0; padding-left:18px; line-height:1.7;">
            <li>Weekly score + tier classification (Elite / Plus / Neutral / Dud)</li>
            <li>Season-by-season totals: games, points, PPG, positional ranks</li>
            <li>Adjusted All-Play Wins (APW) — who the player actually wins matchups for</li>
            <li>Snap counts + advanced stats (rushing/receiving/passing/IDP templates)</li>
          </ul>
        </div>`;
    })();

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
    // Client-side aggregator — supports UPS / Full scope toggle
    // without an extra Worker round-trip. Ignores
    // bundle.nfl_season_totals (Worker pre-aggregated regular-only)
    // and recomputes from bundle.nfl_weekly + bundle.nfl_snaps_by_week.
    const aggregateNflSeasons = (scope) => {
      const weeks = Array.isArray(bundle.nfl_weekly) ? bundle.nfl_weekly : [];
      const snapBy = bundle.nfl_snaps_by_week || {};
      const isReg = (w) => {
        // UPS Season = NFL weeks 1-17 (Keith 2026-04-23: MFL's
        // regular-season scoring window caps at 17 for all eras).
        const wk = Number(w.week) || 0;
        return wk >= 1 && wk <= 17;
      };
      const fields = [
        "rush_att","rush_yds","rush_tds","rush_fumbles","rush_fumbles_lost",
        "targets","receptions","rec_yds","rec_tds",
        "pass_att","pass_cmp","pass_yds","pass_tds","pass_ints","pass_sacks",
        "def_tackles_ast","def_tfl","def_sacks","def_ff","def_fr","def_ints",
        "def_pass_def","def_tds",
        "fg_att","fg_made","fg_att_0_39","fg_made_0_39",
        "fg_att_40_49","fg_made_40_49","fg_att_50plus","fg_made_50plus",
        "xp_att","xp_made","punts","punt_yds","punt_inside20",
        "receiving_drops","receiving_broken_tackles",
        "rushing_broken_tackles","passing_drops",
        "rushing_yards_before_contact","rushing_yards_after_contact"
      ];
      const bySeason = {};
      for (const w of weeks) {
        if (scope === "ups" && !isReg(w)) continue;
        const key = String(w.season);
        let tgt = bySeason[key];
        if (!tgt) {
          tgt = { season: Number(w.season), games: 0,
                  _off_snaps: 0, _def_snaps: 0,
                  _off_rate_sum: 0, _def_rate_sum: 0, _snap_weeks: 0,
                  def_tackles_solo: 0 };
          for (const f of fields) tgt[f] = 0;
          bySeason[key] = tgt;
        }
        tgt.games += 1;
        for (const f of fields) tgt[f] += Number(w[f]) || 0;
        tgt.def_tackles_solo += Number(w.def_tackles_solo) || 0;
        const snap = snapBy[`${w.season}-${w.week}`];
        if (snap) {
          tgt._off_snaps += Number(snap.off_snaps) || 0;
          tgt._def_snaps += Number(snap.def_snaps) || 0;
          tgt._off_rate_sum += Number(snap.off_snap_pct) || 0;
          tgt._def_rate_sum += Number(snap.def_snap_pct) || 0;
          tgt._snap_weeks += 1;
        }
      }
      return Object.values(bySeason).map(r => ({
        ...r,
        def_tackles_total: r.def_tackles_solo,
        off_snaps_total: r._off_snaps || null,
        def_snaps_total: r._def_snaps || null,
        off_snap_rate: r._snap_weeks ? r._off_rate_sum / r._snap_weeks : null,
        def_snap_rate: r._snap_weeks ? r._def_rate_sum / r._snap_weeks : null,
      })).sort((a, b) => b.season - a.season);
    };

    const buildRawStatsHtml = () => {
      const scope = (() => {
        try { return sessionStorage.getItem("upm.stats.scope") || "ups"; } catch (e) { return "ups"; }
      })();
      const totals = aggregateNflSeasons(scope);
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
      const scopeToggle = `
        <div style="display:flex; gap:6px; margin-bottom:8px;">
          <button type="button" class="rdh-chip" data-raw-scope="ups"  aria-pressed="${scope === "ups" ? "true" : "false"}" title="NFL regular season only — matches PFR season totals.">UPS Season</button>
          <button type="button" class="rdh-chip" data-raw-scope="full" aria-pressed="${scope === "full" ? "true" : "false"}" title="Include NFL playoff weeks.">Full Season</button>
        </div>`;
      const scopeNote = scope === "full" ? "Full NFL Season (incl. playoffs)." : "UPS Season (NFL regular season).";
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
          { label: "YBC/A", compute: r => r.rush_att ? (r.rushing_yards_before_contact || 0) / r.rush_att : null, format: "dec2",
                            title: "Rushing yards before contact per attempt (PFR, 2018+)" },
          { label: "YAC/A", compute: r => r.rush_att ? (r.rushing_yards_after_contact || 0) / r.rush_att : null, format: "dec2",
                            title: "Rushing yards after contact per attempt (PFR, 2018+)" },
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
      <div class="profile-block" data-raw-panel-root>
        <h4>Raw Stats — ${tmpl.label}</h4>
        ${scopeToggle}
        <div class="small" style="color:var(--muted); margin-bottom:6px;">${scopeNote} Real NFL on-field counts + derived rates. Independent of MFL fantasy scoring.</div>
        <table class="rdh-table"><thead><tr>${thRow}</tr></thead><tbody>${bodyRows}</tbody></table>
        ${confNote}
      </div>`;
    };
    const rawStatsHtml = buildRawStatsHtml();

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

    // Assemble the modal body. For fresh rookies (no career stats yet), the
    // Stats / Game Log / News tabs are all empty noise — strip them entirely
    // and show only the Bio. Veterans get the full tab strip.
    if (isFreshRookie) {
      body.innerHTML = bundleErrorBanner + bioHtml +
        `<div class="small" style="color: var(--muted); margin-top: 10px; text-align:right;">MFL ID: ${pid}</div>`;
    } else {
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
    }

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

    // UPS Season / Full Season scope toggle inside Raw Stats.
    // Re-render just the Raw panel in place — no modal reopen.
    const rebindRawScope = () => {
      body.querySelectorAll("[data-raw-scope]").forEach(sbtn => {
        sbtn.addEventListener("click", () => {
          try { sessionStorage.setItem("upm.stats.scope", sbtn.dataset.rawScope); } catch (e) {}
          const rawBody = body.querySelector("[data-stats-body='raw']");
          if (rawBody) {
            rawBody.innerHTML = buildRawStatsHtml();
            rebindRawScope();  // re-bind since buttons got replaced
          }
        });
      });
    };
    rebindRawScope();

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
          { label: "YBC/A", compute: r => r.rush_att ? (r.rushing_yards_before_contact || 0) / r.rush_att : null, format: "dec2",
                            title: "Rushing yards before contact per attempt (PFR, 2018+)" },
          { label: "YAC/A", compute: r => r.rush_att ? (r.rushing_yards_after_contact || 0) / r.rush_att : null, format: "dec2",
                            title: "Rushing yards after contact per attempt (PFR, 2018+)" },
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
    // Paginate at 20/page (was hard-cap 500). Page state persists in
    // STATE.h_page until filters change (those handlers reset it to 0).
    const pager = paginate(rows, "h_page", { size: 20 });
    const shown = pager.visible;
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
    document.getElementById("h-summary").innerHTML =
      `Showing ${shown.length} of ${rows.length} picks` +
      (pager.totalPages > 1 ? ` · page ${pager.page + 1}/${pager.totalPages}` : "");
    // Mount paginator below the table — find the parent .rdh-card or fallback.
    const tableEl = document.getElementById("h-table");
    let pagBox = document.getElementById("h-paginator");
    if (!pagBox && tableEl && tableEl.parentNode) {
      pagBox = document.createElement("div");
      pagBox.id = "h-paginator";
      tableEl.parentNode.insertBefore(pagBox, tableEl.nextSibling);
    }
    if (pagBox) {
      pagBox.innerHTML = pager.html;
      pager.attach(pagBox, renderHistory);
    }
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
    const announceBtn = document.getElementById("r6-announce-btn");
    const isCommish = !!(STATE.me && STATE.me.is_commish);
    if (btn) {
      btn.disabled = !isCommish;
      btn.title = isCommish ? "Start the official R6 order drawing" : "Only the commissioner can run the official drawing";
    }
    if (announceBtn) announceBtn.hidden = !isCommish;
  }

  // ── R6 Discord announcement modals ──
  // Two-step flow: dry-run preview from worker (so we display the EXACT text
  // Discord will see), commish confirms, then a second call posts for real.
  // Worker is idempotent (scans channel for marker tag), so even if the user
  // double-clicks we won't double-post.
  async function _r6CallAnnounce(endpoint, extraBody = {}, dryRun = false) {
    const me = STATE.me || {};
    const requestedBy = me.franchise_id;
    // Hub URL precedence:
    //   1. window.UPS_DRAFT_HUB_PARENT_URL — set by the HPM loader on the
    //      OUTER MFL page (the only place that can read window.location
    //      without about:srcdoc nonsense).
    //   2. window.location.href if it's a real http(s) URL (direct loads,
    //      workers.dev preview).
    //   3. Hardcoded fallback to the league's options page.
    // Never send "about:srcdoc" — the iframe srcdoc URL is meaningless to
    // users who click it from Discord.
    const parentUrl = (typeof window !== "undefined" && window.UPS_DRAFT_HUB_PARENT_URL) || "";
    const ownUrl = (window.location && window.location.href) || "";
    const isUsable = (u) => /^https?:\/\//i.test(String(u || ""));
    const hubUrl = isUsable(parentUrl) ? parentUrl
                 : isUsable(ownUrl) ? ownUrl
                 : "https://www48.myfantasyleague.com/2026/options?L=74598&O=07";
    const r = await fetch(apiUrl(endpoint) + "?L=74598", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requested_by: requestedBy, hub_url: hubUrl, dry_run: dryRun, ...extraBody }),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok || !data || data.ok === false) {
      throw new Error((data && (data.error || data.detail)) || `worker returned ${r.status}`);
    }
    return data;
  }

  async function _r6OpenKickoffAnnounceModal() {
    if (!STATE.me || !STATE.me.is_commish) return;
    openModal(`
      <h3>📢 Announce R6 Kickoff to Discord</h3>
      <p class="small" style="color: var(--muted)">Loading message preview from worker…</p>
      <div id="r6-announce-preview" style="margin-top:8px;"></div>
      <div class="actions">
        <button class="btn secondary" onclick="document.getElementById('rdh-modal-overlay').classList.remove('open')">Cancel</button>
        <button class="btn warn" id="r6-announce-confirm" disabled>Post to #live Discord</button>
      </div>
      <div id="r6-announce-result" class="small" style="margin-top:8px;"></div>
    `);
    let preview = "";
    let alreadyPosted = false;
    try {
      const dry = await _r6CallAnnounce("/api/r6/announce-kickoff", {}, true);
      preview = dry.preview || "";
      // If the worker's idempotency check already finds an existing post,
      // surface it so we don't pretend we're about to post fresh.
      alreadyPosted = !!dry.already_posted;
    } catch (e) {
      document.getElementById("r6-announce-preview").innerHTML =
        `<div style="color:var(--err)">Preview failed: ${escapeHtml(String(e.message || e))}</div>`;
      return;
    }
    document.getElementById("r6-announce-preview").innerHTML =
      (alreadyPosted ? `<div class="small" style="color:var(--ok); margin-bottom:6px;">✓ Already posted — re-clicking will be a no-op.</div>` : "") +
      `<div style="background:var(--panel-alt); padding:10px; border-radius:6px; white-space:pre-wrap; font-family: var(--font-base); border:1px solid var(--border);">${escapeHtml(preview)}</div>`;
    const btn = document.getElementById("r6-announce-confirm");
    btn.disabled = false;
    btn.textContent = alreadyPosted ? "Already posted — close" : "Post to #live Discord";
    btn.addEventListener("click", async () => {
      const result = document.getElementById("r6-announce-result");
      if (alreadyPosted) {
        document.getElementById("rdh-modal-overlay").classList.remove("open");
        return;
      }
      btn.disabled = true;
      result.innerHTML = `<div style="color: var(--muted)">Posting…</div>`;
      try {
        const data = await _r6CallAnnounce("/api/r6/announce-kickoff", {}, false);
        result.innerHTML = data.already_posted
          ? `<div style="color: var(--warn)">⚠ Already posted earlier — no duplicate sent.</div>`
          : `<div style="color: var(--ok)">✓ Posted to #live Discord.</div>`;
        showToast(data.already_posted ? "Already posted earlier" : "📢 R6 kickoff announced in Discord", "ok");
        setTimeout(() => document.getElementById("rdh-modal-overlay").classList.remove("open"), 1500);
      } catch (e) {
        result.innerHTML = `<div style="color: var(--err)">Failed: ${escapeHtml(String(e.message || e))}</div>`;
        btn.disabled = false;
      }
    });
  }

  async function _r6OpenApplyOrderModal(orderArray) {
    if (!STATE.me || !STATE.me.is_commish) return;
    // Render the ordered list inline so the commish can see what's about to
    // hit MFL. No Discord post — the on-screen R6 table is the record.
    const sorted = orderArray.slice().sort((a, b) => Number(a.pick) - Number(b.pick));
    const tableRows = sorted.map(p =>
      `<tr><td style="padding:4px 8px;">${Number(p.pick)}</td><td style="padding:4px 8px;">${escapeHtml(p.franchise_name || p.franchise_id || "—")}</td></tr>`
    ).join("");
    openModal(`
      <h3>🔧 Apply R6 Order to MFL</h3>
      <p class="small" style="color: var(--muted)">The official drawing finished. Below is the order that will be written to MFL's draft setup. The on-screen R6 table stays as the visible record.</p>
      <div style="background:var(--panel-alt); padding:8px; border-radius:6px; margin-top:8px; border:1px solid var(--border); max-height:280px; overflow:auto;">
        <table class="rdh-table" style="margin:0;"><thead><tr><th style="text-align:left; padding:4px 8px;">Pick</th><th style="text-align:left; padding:4px 8px;">Franchise</th></tr></thead><tbody>${tableRows}</tbody></table>
      </div>
      <p class="small" style="color: var(--muted); margin-top: 8px;">
        ⚠ This uses MFL's <code>draftResults</code> import. It will <strong>preserve all R1-R5 slot
        assignments</strong> and only update R6. The worker refuses to run if any picks have
        already been made anywhere (MFL would wipe them).
      </p>
      <div class="actions">
        <button class="btn secondary" onclick="document.getElementById('rdh-modal-overlay').classList.remove('open')">Skip — Apply Manually</button>
        <button class="btn warn" id="r6-apply-confirm">Apply R6 Order to MFL</button>
      </div>
      <div id="r6-apply-result" class="small" style="margin-top:8px;"></div>
    `);
    const btn = document.getElementById("r6-apply-confirm");
    btn.addEventListener("click", async () => {
      const result = document.getElementById("r6-apply-result");
      btn.disabled = true;
      result.innerHTML = `<div style="color: var(--muted)">Writing R6 order to MFL…</div>`;
      try {
        const me = STATE.me || {};
        const r = await fetch(apiUrl("/api/r6/apply-order") + "?L=74598", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requested_by: me.franchise_id, order: orderArray }),
        });
        const data = await r.json().catch(() => null);
        if (!r.ok || !data || data.ok === false) {
          const hint = data && data.hint ? `⚠ ${data.hint}` : "";
          const made = data && data.made_count ? ` · ${data.made_count} picks already made — refusing to wipe.` : "";
          const mfl = data && data.mfl_response ? ` · MFL: ${String(data.mfl_response).slice(0, 200)}` : "";
          throw new Error([hint, (data && data.error) || `worker ${r.status}`, made, mfl].filter(Boolean).join(" · "));
        }
        result.innerHTML = `<div style="color: var(--ok);">✓ R6 order written to MFL. Verify in <strong>MFL → Commissioner → Draft Setup</strong>.</div>`;
        showToast("✓ R6 order applied to MFL", "ok");
      } catch (e) {
        result.innerHTML = `<div style="color: var(--err)">Failed: ${escapeHtml(String(e.message || e))}<br><span class="small" style="color:var(--muted);">You can still update R6 order manually in MFL Commissioner Tools — the on-screen table is the canonical record.</span></div>`;
        btn.disabled = false;
      }
    });
  }

  function _startR6EventCountdown() {
    // Target: May 11, 2026 at 9:00 PM ET. ET = UTC-4 in May (DST), so
    // 9PM ET = 01:00 UTC the NEXT day (May 12, 01:00 UTC).
    const target = Date.UTC(2026, 4, 12, 1, 0, 0);
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
    // Reverse order of selection: pick 12 first, down to pick 1.
    // BOTH simulate AND official drawings must shuffle the pool — UPS rule
    // is a RANDOM order drawing. v1.7.23 only shuffled in simulate mode,
    // which produced an identity order in the 2026-05-11 official run
    // (pick 1→0001, pick 2→0002, ...). Fixed in v1.7.43: shuffle always.
    const pool = franchises.slice();
    pool.sort(() => Math.random() - 0.5);
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
    // After the OFFICIAL drawing finishes, offer to write the order
    // directly to MFL (no Discord post — the on-screen table is the
    // record per Keith). Worker preserves R1-R5 ownership and refuses if
    // any picks have been made anywhere.
    if (!isSimulate && STATE.me && STATE.me.is_commish) {
      const orderForApply = STATE.r6_order
        .slice()
        .sort((a, b) => Number(a.pick) - Number(b.pick))
        .map(o => ({
          pick: Number(o.pick),
          franchise_id: o.franchise_id,
          franchise_name: o.franchise_name,
        }));
      setTimeout(() => _r6OpenApplyOrderModal(orderForApply), 800);
    }
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
    const slot = `${active.round}.${String(active.pick).padStart(2, "0")}`;
    const contract = rookieSlotContract(active.round, active.pick);
    const isSim = !!STATE.simulationMode;
    const me = STATE.me || {};
    const hpmKnown = me.configured && me.source === "hpm";

    const modeBadge = isSim
      ? `<span class="lmb-pill" style="background:rgba(251,191,36,0.22); color:var(--warn); border-color: rgba(251,191,36,0.5);">SIMULATE</span>`
      : `<span class="lmb-pill" style="background:rgba(239,68,68,0.22); color:var(--err); border-color: rgba(239,68,68,0.6);">LIVE</span>`;

    openModal(`
      <h3 style="display:flex; align-items:center; gap:10px;">
        Confirm Pick ${modeBadge}
      </h3>
      <p style="font-size:14px; line-height:1.6; margin: 6px 0 8px;">
        <strong>${escapeHtml(fname)}</strong> selects
        <strong>${escapeHtml(prospect.name)}</strong>
        <span class="small" style="color:var(--muted);">(${escapeHtml(prospect.position)}${prospect.nfl_team ? " · " + escapeHtml(prospect.nfl_team) : ""})</span>
        at <strong>${escapeHtml(slot)}</strong>.
      </p>

      <div class="pick-cost-block">
        <h4>Contract MFL will apply</h4>
        <div class="pick-cost-grid">
          <div><div class="pcg-lbl">Year 1 AAV</div><div class="pcg-val">$${contract.aav}K</div></div>
          <div><div class="pcg-lbl">${contract.length}-yr TCV</div><div class="pcg-val">$${contract.tcv}K</div></div>
          <div><div class="pcg-lbl">Length</div><div class="pcg-val">${contract.length} yr</div></div>
        </div>
        ${contract.notes.length ? `<div class="pcg-notes">${contract.notes.map(n => `• ${escapeHtml(n)}`).join("<br>")}</div>` : ""}
      </div>

      ${hpmKnown
        ? `<p class="small" style="color:var(--muted); margin: 0 0 4px;">Submitting as <strong>${escapeHtml(me.franchise_name || me.franchise_id)}</strong> (auto-detected from your MFL session).</p>`
        : `<label style="display:flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--muted); margin-top: 6px;">
            MFL_USER_ID cookie (optional — only needed if not signed in)
            <input type="text" id="pick-user-id" placeholder="blank = use league API key">
           </label>`
      }

      <div class="actions">
        <button class="btn secondary" onclick="document.getElementById('rdh-modal-overlay').classList.remove('open')">Cancel</button>
        <button class="btn ${isSim ? "warn" : "danger"}" id="confirm-pick-go">${isSim ? "Simulate Pick" : "🔴 Submit Pick LIVE"}</button>
      </div>
      <div id="pick-result" style="margin-top: 10px;"></div>
    `);
    document.getElementById("confirm-pick-go").addEventListener("click", async () => {
      const userIdEl = document.getElementById("pick-user-id");
      const userId = userIdEl ? userIdEl.value.trim() : "";
      const result = document.getElementById("pick-result");
      result.innerHTML = `<div class="small" style="color: var(--muted)">${isSim ? "Validating…" : "Submitting to MFL…"}</div>`;
      try {
        if (!prospect.player_id) {
          result.innerHTML = `<div style="color: var(--err)">Prospect has no MFL player_id — rebuild the prospect board.</div>`;
          return;
        }
        const payload = {
          franchise_id: fid,
          player_id: String(prospect.player_id),
          simulate: isSim,
          // Dry-run is meaningful only when NOT simulating — it lets the
          // commish exercise the full LIVE flow without the worker hitting
          // MFL or live Discord. Worker treats it as "validate + preview".
          dry_run: !isSim && !!STATE.dryRun,
          // Master commish DM toggle — silences Discord post for this pick
          // (worker still writes to MFL). Picks AND trades both honor it.
          silence_discord: !isSim && !!STATE.silenceTradeAnnouncements,
        };
        if (userId) payload.user_id = userId;
        const r = await fetch(apiUrl("/api/pick") + "?L=74598", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await r.json();
        if (data.ok) {
          if (isSim) {
            result.innerHTML = `<div style="color: var(--warn);">✓ Simulated — no MFL write, no Discord post.</div>`;
            showToast(`Simulated R${slot} → ${prospect.name}`, "ok");
          } else if (data.dry_run) {
            result.innerHTML = `<div style="color: var(--warn);">🧪 DRY-RUN — MFL request validated and previewed (no write). Test Discord posted.</div>`;
            showToast(`🧪 DRY-RUN R${slot} → ${prospect.name} — no MFL write`, "ok");
          } else {
            const discordBit = data.discord_silenced
              ? " · 🔕 Discord muted (per your DM toggle)"
              : (data.discord_posted ? " · announced in Discord" : "");
            result.innerHTML = `<div style="color: var(--ok);">✅ Pick submitted to MFL${discordBit}.</div>`;
            showToast(`LIVE pick: R${slot} → ${prospect.name}${data.discord_silenced ? " · Discord muted" : ""}`, "ok");
          }
        } else {
          result.innerHTML = `<div style="color: var(--err)">Failed: ${escapeHtml(data.error || data.mfl_response || JSON.stringify(data)).slice(0, 400)}</div>`;
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
          const r = await fetch(apiUrl("/api/settings") + "?L=74598", {
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

    // Commish broker mode — pick BOTH sides as a third party (e.g. process a
    // trade between Team A and Team B verbally agreed on draft day). For
    // regular owners, the from-side is always their own franchise.
    const isCommishBroker = !!(STATE.me && STATE.me.is_commish);
    // Preserve the commish's true franchise_id for audit fields (requested_by)
    // — myFid below gets reassigned when the from-selector changes, but
    // `commishOwnFid` always points at whoever's actually running the modal.
    const commishOwnFid = me.franchise_id;
    let myFid = me.franchise_id;
    let myName = franchises[myFid] || myFid || "—";
    // Sorted franchise list for dropdowns (used by both from + to selectors).
    const allFranchises = Object.entries(franchises)
      .sort((a,b) => String(a[1]).localeCompare(String(b[1])));
    function _tradeOpts(excludeFid) {
      return allFranchises
        .filter(([id]) => id !== excludeFid)
        .map(([id, name]) => `<option value="${id}">${escapeHtml(name)}</option>`).join("");
    }
    function _tradeFromOpts(selectedFid) {
      return allFranchises
        .map(([id, name]) => `<option value="${id}"${id === selectedFid ? " selected" : ""}>${escapeHtml(name)}</option>`).join("");
    }
    // For commish: default the from-side to whoever the commish is (0008
    // when logged in as own team, or first franchise alphabetically when
    // logged in as 0000 pseudo-franchise).
    if (isCommishBroker && (!myFid || myFid === "0000" || !franchises[myFid])) {
      const firstReal = allFranchises[0];
      if (firstReal) { myFid = firstReal[0]; myName = firstReal[1]; }
    }
    const toOptions = _tradeOpts(myFid);
    // Header: keep it ONE compact row when commish-broker (From → To → ✕)
    // instead of stacked rows with their own labels. Saves vertical space
    // and reads as a single direction-of-trade statement at a glance.
    const headerHtml = isCommishBroker
      ? `<div style="font-size:10px; color:var(--muted); text-transform:uppercase; letter-spacing:0.5px;">🔨 Commish Broker</div>
         <div style="display:flex; align-items:center; gap:6px; margin-top:2px;">
           <select id="trade-from" style="flex:1; min-width:0; padding:6px 8px; font-size:13px; background:var(--panel-alt); color:var(--text); border:1px solid var(--accent-soft); border-radius:4px;">${_tradeFromOpts(myFid)}</select>
           <span style="color:var(--muted); font-size:14px; font-weight:600;">→</span>
           <select id="trade-to" style="flex:1; min-width:0; padding:6px 8px; font-size:13px; background:var(--panel-alt); color:var(--text); border:1px solid var(--accent-soft); border-radius:4px;">${toOptions}</select>
           <button class="btn secondary" type="button" aria-label="Close" onclick="document.getElementById('rdh-modal-overlay').classList.remove('open')" style="padding:6px 10px; flex-shrink:0;">✕</button>
         </div>`
      : `<div style="font-size:10px; color:var(--muted); text-transform:uppercase; letter-spacing:0.5px;">Propose Trade · You = ${escapeHtml(myName)}</div>
         <div style="display:flex; align-items:center; gap:8px; margin-top:2px;">
           <strong style="font-size:13px; color:var(--text); white-space:nowrap;">↔ With:</strong>
           <select id="trade-to" style="flex:1; min-width:0; padding:6px 8px; font-size:13px; background:var(--panel-alt); color:var(--text); border:1px solid var(--accent-soft); border-radius:4px;">${toOptions}</select>
           <button class="btn secondary" type="button" aria-label="Close" onclick="document.getElementById('rdh-modal-overlay').classList.remove('open')" style="padding:6px 10px; flex-shrink:0;">✕</button>
         </div>`;
    openModal(`
      <div class="trade-modal-shell">
        <header class="trade-modal-header">
          <div>
            ${headerHtml}
          </div>
        </header>

        <div class="trade-baskets-strip">
          <div class="trade-basket-card give">
            <div class="trade-basket-title"><span id="trade-give-label">${isCommishBroker ? escapeHtml(myName).toUpperCase() + " OFFERS" : "YOU OFFER"}</span> <span class="trade-basket-count" id="trade-give-count">0 assets</span></div>
            <div id="trade-give-basket" class="trade-basket"></div>
          </div>
          <div class="trade-basket-divider">⇄</div>
          <div class="trade-basket-card receive">
            <div class="trade-basket-title"><span id="trade-receive-label">${isCommishBroker ? "PARTNER RECEIVES" : "YOU RECEIVE"}</span> <span class="trade-basket-count" id="trade-receive-count">0 assets</span></div>
            <div id="trade-receive-basket" class="trade-basket"></div>
          </div>
        </div>

        <div class="trade-pickers-body">
          <div class="trade-picker-col">
            <h4 class="trade-col-h4">Pick from <strong id="trade-give-picker-name">${escapeHtml(myName)}</strong>'s assets</h4>
            <div id="trade-give-picker" class="trade-asset-picker"></div>
          </div>
          <div class="trade-picker-col">
            <h4 class="trade-col-h4">Pick from <strong id="trade-receive-picker-name">partner</strong>'s assets</h4>
            <div id="trade-receive-picker" class="trade-asset-picker"></div>
          </div>
        </div>

        <footer class="trade-modal-footer">
          <div class="trade-bb-row">
            <span class="small" style="color:var(--muted); text-transform:uppercase; letter-spacing:0.4px; margin-right:6px;">Cap $ (BB)</span>
            <input type="number" id="trade-bb-amt" placeholder="" min="0" step="100" style="width:110px; padding:6px;" autocomplete="off">
            <select id="trade-bb-side" style="padding:6px;">
              <option value="give">to OFFER side</option>
              <option value="receive">to RECEIVE side</option>
            </select>
            <button class="btn secondary" id="trade-bb-add" type="button" style="padding:6px 12px;">+ Add</button>
            <input type="text" id="trade-comments" placeholder="" style="flex:1; min-width:120px; padding:6px;" autocomplete="off">
          </div>
          <div id="trade-bb-helper" class="small" style="color:var(--muted); margin: 4px 0 6px; font-size:11px; line-height:1.4;">
            <span title="UPS Rule E1 — each side's max cap money sent = 50% of the sum of THAT side's traded-away player salaries. Cannot send only money — at least one player or pick required.">
              Max cap $ = 50% of your outgoing player salaries · trade must include at least one player or pick on each side.
            </span>
          </div>
          <div id="trade-result" class="trade-result"></div>
          <div class="trade-actions">
            <button class="btn secondary" type="button" onclick="document.getElementById('rdh-modal-overlay').classList.remove('open')">Cancel</button>
            <button class="btn" id="propose-trade-go" type="button">${
              STATE.simulationMode ? "Simulate Trade"
              : (STATE.me && STATE.me.is_commish) ? "🔨 Process Trade (Commish)"
              : "🔴 Submit Proposal LIVE"
            }</button>
          </div>
        </footer>
      </div>
    `);
    // Tag the modal so the wider trade-specific CSS applies (vs the bio modal default).
    const _modal = document.getElementById("rdh-modal");
    if (_modal) _modal.classList.add("rdh-modal-trade");

    const basket = { give: [], receive: [] };
    // Counter-offer prepopulation — when openTradeModal is called via the
    // "Counter" button in the trade-detail modal, STATE._counterPrepopulate
    // carries swapped baskets + the partner_fid we should target.
    let _counterFromOffer = null;
    if (STATE._counterPrepopulate) {
      _counterFromOffer = STATE._counterPrepopulate;
      STATE._counterPrepopulate = null;  // consume once
      // Pre-populate baskets
      basket.give = (_counterFromOffer.give || []).map(a => ({ ...a, extension_term: a.extension_term || "" }));
      basket.receive = (_counterFromOffer.receive || []).map(a => ({ ...a, extension_term: a.extension_term || "" }));
    }

    async function loadAndRender(side) {
      const fid = side === "give" ? myFid : document.getElementById("trade-to").value;
      const pickerEl = document.getElementById(`trade-${side}-picker`);
      pickerEl.innerHTML = `<div class="small" style="color:var(--muted)">Loading ${franchises[fid] || fid}'s assets…</div>`;
      let data;
      let isStub = false;
      // 15s hard timeout via AbortController — without this, a CF worker
      // cold-start or MFL hang leaves the picker spinning forever and the
      // user has no way to recover except closing the modal.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      try {
        const r = await fetch(apiUrl(`/api/franchise-assets`) + `?L=74598&fid=${encodeURIComponent(fid)}`, { signal: ctrl.signal });
        const ct = r.headers.get("content-type") || "";
        if (!r.ok || !ct.includes("json")) throw new Error(`api returned ${r.status} ${ct}`);
        data = await r.json();
      } catch (e) {
        // Local-preview / no-worker fallback — synthesize the asset list from
        // already-loaded STATE so the trade flow is testable in dev too.
        data = _localFranchiseAssetsStub(fid);
        isStub = true;
        // If even the stub returns nothing usable, surface a retry button so
        // the user can try again instead of staring at empty columns.
        if (!data || (!data.players?.length && !data.current_picks?.length && !data.future_picks?.length)) {
          pickerEl.innerHTML = `
            <div class="small" style="color:var(--err); padding:6px;">
              Failed to load ${franchises[fid] || fid}'s assets (${escapeHtml(String(e && e.message || e))}).
            </div>
            <button class="btn secondary" type="button" data-trade-retry="${side}" style="margin-top:6px;">↻ Retry</button>`;
          pickerEl.querySelector('[data-trade-retry]')?.addEventListener('click', () => loadAndRender(side));
          clearTimeout(timer);
          return;
        }
      } finally {
        clearTimeout(timer);
      }
      try {
        // Combined picks list: current-year + future, sorted (current first by round/slot, then future by year/round).
        // R6 picks are league-rule untradeable (UPS rule: no R6 trades) so we
        // filter them out before the picker even renders. Both current_picks
        // and future_picks may carry round=6 so apply to both.
        const _isR6 = (p) => Number(p && p.round) === 6;
        const allPicks = []
          .concat((data.current_picks || []).filter(p => !_isR6(p)).map(p => ({ ...p, _kind: "dp" })))
          .concat((data.future_picks || []).filter(p => !_isR6(p)).map(p => ({ ...p, _kind: "fp" })));
        const renderGroup = (label, items, kind) => {
          if (!items || !items.length) return "";
          return `
            <div style="margin-top:8px;">
              <div style="font-size:10px; text-transform:uppercase; color:var(--muted); letter-spacing:0.3px;">${label}</div>
              <input type="search" placeholder="Filter ${label.toLowerCase()}..."
                     data-filter-target="asset-${side}-${kind}"
                     style="width:100%; padding:4px 6px; margin-top:3px; font-size:12px;">
              <div data-asset-list="asset-${side}-${kind}" style="border:1px solid var(--border); border-radius:4px; padding:2px; margin-top:2px;">
                ${items.map(it => {
                  const k = it._kind || kind;
                  // TAXI badge: universal site logic — wherever a player is
                  // displayed, taxi status is surfaced. Salary still shown
                  // (taxi salary doesn't count vs cap but is real money for
                  // trade-value comparisons).
                  const taxiPill = it.taxi
                    ? `<span class="taxi-pill" title="Taxi squad — salary doesn't count vs cap, but real for trade math">TAXI</span>`
                    : "";
                  return `
                  <div class="trade-asset-row${it.taxi ? " is-taxi" : ""}" data-asset-id="${escapeHtml(it.asset_id)}" data-display="${escapeHtml(it.display)}" data-kind="${k}"
                       data-player-id="${escapeHtml(it.player_id || '')}"
                       data-position="${escapeHtml(it.position || '')}"
                       data-salary="${escapeHtml(String(it.salary || ''))}"
                       data-taxi="${it.taxi ? '1' : '0'}"
                       style="cursor:pointer; font-size:12px; border-bottom:1px solid var(--border);">
                    <div style="padding:4px 8px; display:flex; justify-content:space-between; align-items:center; gap:8px;">
                      <div style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                        ${escapeHtml(it.display)}
                        ${it.position ? `<span class="small" style="color:var(--muted); margin-left:6px;">${escapeHtml(it.position)}</span>` : ""}
                        ${taxiPill}
                      </div>
                      ${it.salary ? `<span class="small" style="color:var(--muted); white-space:nowrap;">$${Math.round(it.salary).toLocaleString()}</span>` : ""}
                    </div>
                  </div>`;
                }).join("")}
              </div>
            </div>`;
        };
        const stubBanner = isStub
          ? (() => {
              const snap = STATE.franchise_assets_snapshot;
              const asOf = snap && snap.meta && snap.meta.generated_at_utc
                ? new Date(snap.meta.generated_at_utc).toLocaleString() : "n/a";
              const src = snap ? `static snapshot (${asOf})` : "live state only — no roster snapshot";
              return `<div class="small" style="color:var(--warn); margin-bottom:6px; padding:4px 6px; background:rgba(251,191,36,0.10); border-radius:3px;">
                ⚠ Local preview · using ${escapeHtml(src)}. Real-time worker call will replace this in production.
              </div>`;
            })() : "";
        // Draft picks first — they're the most-traded asset on draft day,
        // so prioritize them visually. Players follow below.
        pickerEl.innerHTML = stubBanner +
          renderGroup("Draft Picks", allPicks, "pick") +
          renderGroup("Players", data.players, "player");

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
            basket[side].push({
              asset_id: row.dataset.assetId,
              display: row.dataset.display,
              kind: row.dataset.kind,
              player_id: row.dataset.playerId || "",
              position: row.dataset.position || "",
              salary: Number(row.dataset.salary || 0),
              taxi: row.dataset.taxi === "1",  // surface in basket so the TAXI pill shows there too
              extension_term: "",  // none by default — basket UI lets user choose
            });
            renderBasket(side);
          });
        });
      } catch (e) {
        pickerEl.innerHTML = `<div class="small" style="color:var(--err)">Failed to load assets: ${escapeHtml(String(e))}</div>`;
      }
    }

    // Pre-trade extension options — mirrors site/trades/trade_workbench.js
    // exactly. UPS rules (docs/league_context_v1.md §C4):
    //   • Only Ext1 (1YR) and Ext2 (2YR) exist. No Ext3, no loaded.
    //   • AAV escalator depends on position:
    //       Schedule 1 (QB/RB/WR/TE): +$10K (1yr) / +$20K (2yr)
    //       Schedule 2 (DL/LB/DB/PK/PN/OTHER): +$3K (1yr) / +$5K (2yr)
    //   • Current-year salary stays the same; bump applies to extension years only.
    //   • Eligibility: 1yr remaining (or expired rookie before deadline). Tags
    //     and "no further extensions" players are blocked. We rely on the worker
    //     for the authoritative eligibility check; this UI just offers the option.
    const _PRETRADE_EXTENSION_RAISES = {
      QB: { 1: 10000, 2: 20000 },
      RB: { 1: 10000, 2: 20000 },
      WR: { 1: 10000, 2: 20000 },
      TE: { 1: 10000, 2: 20000 },
      DL: { 1: 3000,  2: 5000 },
      DE: { 1: 3000,  2: 5000 },
      DT: { 1: 3000,  2: 5000 },
      LB: { 1: 3000,  2: 5000 },
      DB: { 1: 3000,  2: 5000 },
      CB: { 1: 3000,  2: 5000 },
      S:  { 1: 3000,  2: 5000 },
      PK: { 1: 3000,  2: 5000 },
      PN: { 1: 3000,  2: 5000 },
      OTHER: { 1: 3000, 2: 5000 },
    };
    function _extRaise(position, years) {
      const p = String(position || "").toUpperCase();
      const rec = _PRETRADE_EXTENSION_RAISES[p] || _PRETRADE_EXTENSION_RAISES.OTHER;
      return rec[years] || 0;
    }
    function _extOptionsForAsset(asset) {
      const sal = Math.max(0, Math.round(Number(asset.salary || 0) / 1000) * 1000);
      const pos = (asset.position || "").toUpperCase();
      const fmt$ = (v) => "$" + (v / 1000).toFixed(0) + "K";
      const opts = [{ value: "", label: "No pre-trade extension" }];
      [1, 2].forEach(years => {
        const newSalary = sal > 0 ? sal + _extRaise(pos, years) : 0;
        const term = years === 1 ? "Ext1" : "Ext2";
        const label = sal > 0
          ? `+${years}yr (${term}) · new AAV ${fmt$(newSalary)}`
          : `+${years}yr (${term})`;
        opts.push({ value: years === 1 ? "1YR" : "2YR", label });
      });
      return opts;
    }

    function renderBasket(side) {
      const el = document.getElementById(`trade-${side}-basket`);
      const countEl = document.getElementById(`trade-${side}-count`);
      const items = basket[side];
      if (countEl) countEl.textContent = items.length === 1 ? "1 asset" : `${items.length} assets`;
      if (!items.length) {
        el.innerHTML = '<div class="trade-basket-empty">Click assets below to add them here</div>';
        return;
      }
      el.innerHTML = items.map((a, i) => {
        const isPlayer = a.kind === "player" && a.player_id;
        const opts = isPlayer ? _extOptionsForAsset(a) : [];
        const selected = opts.find(o => o.value === (a.extension_term || ""));
        const extPill = a.extension_term
          ? `<span class="trade-basket-ext-pill" title="${escapeHtml((selected && selected.label) || a.extension_term)}">+ ${escapeHtml(a.extension_term === "1YR" ? "Ext1" : "Ext2")}</span>`
          : "";
        const taxiBadge = a.taxi
          ? `<span class="taxi-pill" title="Taxi squad — salary doesn't count vs cap, but real for trade math">TAXI</span>`
          : "";
        // Salary chip on basket rows so trade math is visible at a glance
        // (especially important for taxi players whose value isn't obvious).
        const salaryChip = (a.kind === "player" && a.salary)
          ? `<span class="small" style="color:var(--muted); margin-left:6px;">$${Math.round(a.salary).toLocaleString()}${a.taxi ? ' <span style="opacity:0.6">(taxi)</span>' : ''}</span>`
          : "";
        const extDropdown = isPlayer
          ? `<div class="trade-basket-ext-row">
              <label class="small" style="color:var(--muted); font-size:10px;">Pre-trade extension <span style="opacity:0.6;">· eligibility checked at submit</span></label>
              <select class="trade-basket-ext-select" data-side="${side}" data-idx="${i}">
                ${opts.map(o =>
                  `<option value="${escapeHtml(o.value)}"${o.value === (a.extension_term || "") ? " selected" : ""}>${escapeHtml(o.label)}</option>`
                ).join("")}
              </select>
            </div>` : "";
        return `
        <div class="trade-basket-row${a.taxi ? " is-taxi" : ""}" data-kind="${escapeHtml(a.kind || "")}">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:6px;">
            <span class="trade-basket-display">${escapeHtml(a.display)}${taxiBadge}${extPill}${salaryChip}</span>
            <button class="trade-basket-remove" data-side="${side}" data-idx="${i}" title="Remove">✕</button>
          </div>
          ${extDropdown}
        </div>`;
      }).join("");
      el.querySelectorAll(".trade-basket-remove").forEach(b => b.addEventListener("click", () => {
        basket[b.dataset.side].splice(parseInt(b.dataset.idx, 10), 1);
        renderBasket(b.dataset.side);
      }));
      el.querySelectorAll(".trade-basket-ext-select").forEach(sel => sel.addEventListener("change", () => {
        const i = parseInt(sel.dataset.idx, 10);
        basket[sel.dataset.side][i].extension_term = sel.value;
        renderBasket(sel.dataset.side);
      }));
    }

    document.getElementById("trade-to").addEventListener("change", () => {
      basket.receive = [];
      _refreshReceiveLabel();
      renderBasket("receive");
      loadAndRender("receive");
    });
    // Commish broker mode: changing the FROM side rebuilds everything —
    // basket clears, partner dropdown re-options excluding new from, and
    // the give-side picker reloads with the new franchise's assets.
    function _refreshReceiveLabel() {
      const toSel = document.getElementById("trade-to");
      const toFid = toSel && toSel.value;
      const toName = toFid && (franchises[toFid] || toFid) || "PARTNER";
      const lbl = document.getElementById("trade-receive-label");
      if (lbl) lbl.textContent = isCommishBroker ? `${String(toName).toUpperCase()} RECEIVES` : "YOU RECEIVE";
      const pn = document.getElementById("trade-receive-picker-name");
      if (pn) pn.textContent = toName;
    }
    function _refreshGiveLabel() {
      const lbl = document.getElementById("trade-give-label");
      if (lbl) lbl.textContent = isCommishBroker ? `${String(myName).toUpperCase()} OFFERS` : "YOU OFFER";
      const pn = document.getElementById("trade-give-picker-name");
      if (pn) pn.textContent = myName;
    }
    if (isCommishBroker) {
      const fromSel = document.getElementById("trade-from");
      if (fromSel) fromSel.addEventListener("change", () => {
        myFid = fromSel.value;
        myName = franchises[myFid] || myFid;
        // Rebuild the to-options to exclude the new from-fid (preserve
        // current selection if it's still valid).
        const toSel = document.getElementById("trade-to");
        const prevTo = toSel ? toSel.value : "";
        if (toSel) {
          toSel.innerHTML = _tradeOpts(myFid);
          if (prevTo && prevTo !== myFid && franchises[prevTo]) {
            toSel.value = prevTo;
          }
        }
        // Clear both baskets — assets belong to a different franchise now.
        basket.give = [];
        basket.receive = [];
        _refreshGiveLabel();
        _refreshReceiveLabel();
        renderBasket("give");
        renderBasket("receive");
        loadAndRender("give");
        loadAndRender("receive");
      });
    }
    // Initial label paint (covers the case where receive-side label needs
    // the to-fid name on first render).
    _refreshReceiveLabel();
    // If we're countering, set the partner select + comments + render baskets immediately.
    if (_counterFromOffer) {
      const toSel = document.getElementById("trade-to");
      if (toSel && _counterFromOffer.partner_fid) toSel.value = _counterFromOffer.partner_fid;
      const commentsEl = document.getElementById("trade-comments");
      if (commentsEl) commentsEl.value = _counterFromOffer.comments || "";
      _refreshReceiveLabel();
      renderBasket("give"); renderBasket("receive");
    }

    // ── Cap-$ (BB) rule per docs/league_context_v1.md §E1 ──────────────
    // Each side's outgoing cap money is capped at 50% of THAT side's
    // outgoing player salaries. Cannot send only money — at least one
    // player or pick required. Multi-player: 50% of SUM of salaries.
    function _bbMaxFor(side) {
      const players = basket[side].filter(a => a.kind === "player");
      const totalSalary = players.reduce((sum, p) => sum + Number(p.salary || 0), 0);
      return Math.floor(totalSalary * 0.5);
    }
    function _bbCurrentFor(side) {
      return basket[side].filter(a => a.kind === "bb")
        .reduce((sum, a) => sum + Number(a.amount || 0), 0);
    }
    function _bbHasNonCash(side) {
      return basket[side].some(a => a.kind && a.kind !== "bb");
    }
    function _refreshBbHelper() {
      const el = document.getElementById("trade-bb-helper");
      if (!el) return;
      const sideSel = document.getElementById("trade-bb-side");
      const side = (sideSel && sideSel.value) || "give";
      const sideLabel = isCommishBroker
        ? (side === "give" ? `${String(myName).toUpperCase()} OFFERS` : `PARTNER RECEIVES`)
        : (side === "give" ? "YOU OFFER" : "YOU RECEIVE");
      const maxBb = _bbMaxFor(side);
      const currentBb = _bbCurrentFor(side);
      const remaining = Math.max(0, maxBb - currentBb);
      const players = basket[side].filter(a => a.kind === "player");
      const breakdown = players.length
        ? `${players.length} player${players.length === 1 ? "" : "s"} · combined salary $${players.reduce((s,p)=>s+Number(p.salary||0),0).toLocaleString()}`
        : "no players on this side";
      el.innerHTML = `
        <strong style="color:var(--text);">Cap $ rule:</strong>
        <strong>${sideLabel}</strong> max = $${maxBb.toLocaleString()}
        <span style="opacity:0.7;">(${breakdown})</span>
        ${currentBb ? ` · already added $${currentBb.toLocaleString()} · ${remaining > 0 ? "$" + remaining.toLocaleString() + " left" : "AT MAX"}` : ""}
      `;
    }
    document.getElementById("trade-bb-side").addEventListener("change", _refreshBbHelper);
    _refreshBbHelper();

    document.getElementById("trade-bb-add").addEventListener("click", () => {
      const amtRaw = document.getElementById("trade-bb-amt").value;
      const amt = parseInt(amtRaw, 10);
      const side = document.getElementById("trade-bb-side").value;
      if (!(amt > 0)) {
        showToast("Enter a positive cap-$ amount before adding.", "err");
        return;
      }
      const maxBb = _bbMaxFor(side);
      const currentBb = _bbCurrentFor(side);
      const remaining = Math.max(0, maxBb - currentBb);
      if (maxBb === 0) {
        showToast("Add at least one player to that side first — cap-$ max is 50% of outgoing player salary.", "err");
        return;
      }
      if (amt > remaining) {
        showToast(`Cap-$ exceeds the rule limit. Max remaining for that side: $${remaining.toLocaleString()}.`, "err");
        return;
      }
      basket[side].push({
        asset_id: `BB_${amt}`,
        display: `Cap $${amt.toLocaleString()}`,
        kind: "bb",
        amount: amt,
      });
      document.getElementById("trade-bb-amt").value = "";
      renderBasket(side);
      _refreshBbHelper();
    });

    // Re-run helper whenever the basket changes (player added/removed
    // changes the max). Wrap renderBasket once so we don't loop on add.
    const _origRenderBasket = renderBasket;
    renderBasket = function(side) {
      _origRenderBasket(side);
      _refreshBbHelper();
    };

    // Initial load
    renderBasket("give"); renderBasket("receive");
    loadAndRender("give"); loadAndRender("receive");

    document.getElementById("propose-trade-go").addEventListener("click", async () => {
      const toFid = document.getElementById("trade-to").value;
      const give = basket.give.map(a => a.asset_id);
      const receive = basket.receive.map(a => a.asset_id);
      const comments = document.getElementById("trade-comments").value;
      const result = document.getElementById("trade-result");
      const isSim = !!STATE.simulationMode;
      if (!give.length && !receive.length) {
        result.innerHTML = `<div style="color:var(--err)">Select at least one asset on either side.</div>`;
        return;
      }
      // Cap-$ (BB) rule §E1: must include at least one non-cash asset on each
      // side that has cap-$ on it. ("Cannot send only money.")
      const _giveLbl = isCommishBroker ? `${String(myName).toUpperCase()} OFFERS` : "YOU OFFER";
      const _recvLbl = isCommishBroker
        ? `${String(franchises[document.getElementById("trade-to").value] || "PARTNER").toUpperCase()} RECEIVES`
        : "YOU RECEIVE";
      if (basket.give.length && !_bbHasNonCash("give") && basket.give.some(a => a.kind === "bb")) {
        result.innerHTML = `<div style="color:var(--err)">${_giveLbl} side has cap $ but no player or pick — at least one non-cash asset is required.</div>`;
        return;
      }
      if (basket.receive.length && !_bbHasNonCash("receive") && basket.receive.some(a => a.kind === "bb")) {
        result.innerHTML = `<div style="color:var(--err)">${_recvLbl} side has cap $ but no player or pick — at least one non-cash asset is required.</div>`;
        return;
      }
      // Re-validate cap-$ totals (might have changed if user added a BB then removed players).
      for (const side of ["give", "receive"]) {
        const cur = _bbCurrentFor(side);
        const max = _bbMaxFor(side);
        if (cur > max) {
          const sideLabel = side === "give" ? _giveLbl : _recvLbl;
          result.innerHTML = `<div style="color:var(--err)">${sideLabel} cap $ ($${cur.toLocaleString()}) exceeds the rule limit ($${max.toLocaleString()} = 50% of outgoing player salaries). Remove a BB or add more salary.</div>`;
          return;
        }
      }
      // Build payload with extension info per asset (mirrors trade_workbench.js).
      const _packAssets = (basketSide) => basketSide.map(a => ({
        asset_id: a.asset_id,
        kind: a.kind,
        player_id: a.player_id || undefined,
        extension_term: a.extension_term || undefined,
      }));
      // Commish-only LIVE-mode "process" path: hits /api/trade/process which
      // proposes + auto-accepts on behalf of the partner via MFL APIKEY. Two
      // owners agree verbally during the draft → commish punches it in →
      // trade is done. Big confirm dialog because it executes immediately —
      // recoverable only by punching in a reverse trade, which is messy.
      const isCommishProcess = !isSim && STATE.me && STATE.me.is_commish;
      if (isCommishProcess) {
        const partnerName = franchises[toFid] || toFid;
        const giveSummaryC = basket.give.map(a => a.display).join(" + ") || "—";
        const receiveSummaryC = basket.receive.map(a => a.display).join(" + ") || "—";
        const ok = confirm(
          `🔨 PROCESS TRADE (Commish Action)\n\n` +
          `${myName} ↔ ${partnerName}\n\n` +
          `${myName} sends:\n  ${giveSummaryC}\n\n` +
          `${partnerName} sends:\n  ${receiveSummaryC}\n\n` +
          `This will execute IMMEDIATELY in MFL on behalf of both teams.\n` +
          `Recovery requires punching in a reverse trade manually. Continue?`
        );
        if (!ok) {
          result.innerHTML = `<div class="small" style="color: var(--muted)">Cancelled.</div>`;
          return;
        }
      }
      const payload = {
        from_fid: myFid,
        to_fid: toFid,
        // Legacy flat arrays — back-compat with existing worker handler
        give, receive,
        // Rich asset arrays — used when the worker supports extensions
        give_assets: _packAssets(basket.give),
        receive_assets: _packAssets(basket.receive),
        comments,
        simulate: isSim,
        // Dry-run only meaningful in LIVE flows — propagates to /api/trade
        // and /api/trade/process. Worker validates + previews the MFL
        // request without firing the actual POST.
        dry_run: !isSim && !!STATE.dryRun,
        // Commish-only opt-in: silence the Discord post on /api/trade/process
        // (only relevant for the LIVE commish-process path). Picks still
        // announce; this is just a per-action override.
        silence_discord: !isSim && !!STATE.silenceTradeAnnouncements,
        // requested_by tracks WHO ran the action (the commish), not which
        // franchise is the from-side of the trade. In commish-broker mode
        // myFid is the from-team, so use commishOwnFid instead.
        ...(isCommishProcess ? { requested_by: commishOwnFid || myFid } : {}),
      };
      const endpoint = isCommishProcess ? "/api/trade/process" : "/api/trade";
      result.innerHTML = `<div class="small" style="color: var(--muted)">${
        isSim ? "Validating trade…"
        : isCommishProcess ? "🔨 Processing trade in MFL (propose + accept)…"
        : "Submitting trade to MFL…"
      }</div>`;
      try {
        let r, data;
        try {
          r = await fetch(apiUrl(endpoint) + "?L=74598", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          const ct = r.headers.get("content-type") || "";
          // Always try to read the body — the worker returns structured
          // {ok:false, step, mfl_response} JSON even on 502. Throwing
          // before reading the body (the previous behavior) was hiding
          // the MFL error message that explains what actually broke
          // (e.g. commish lockout, invalid asset, trade-deadline).
          let bodyText = "";
          try { bodyText = await r.text(); } catch (_) {}
          if (ct.includes("json") && bodyText) {
            try { data = JSON.parse(bodyText); } catch (_) {}
          }
          if (!r.ok && data && data.ok === false) {
            // Build a clear, surface-the-actual-cause message rather than
            // a generic "502 application/json". The worker tries to sniff
            // common MFL failure modes (commish lockout, deadline, bad
            // asset_id) and ship a one-line `hint` — surface that first
            // since it's actionable.
            const parts = [];
            if (data.hint) parts.push("⚠ " + data.hint);
            if (data.step) parts.push(`step: ${data.step}`);
            if (data.error) parts.push(data.error);
            if (data.mfl_response) parts.push(`MFL: ${String(data.mfl_response).slice(0, 400)}`);
            // propose_response is included on extract_trade_id failures —
            // shows MFL's actual response body so we can see why no regex
            // matched a trade_id.
            if (data.propose_response) parts.push(`propose_resp: ${String(data.propose_response).slice(0, 500)}`);
            if (data.mfl_status) parts.push(`MFL HTTP ${data.mfl_status}`);
            // Surface recovery / pendingTrades diagnostics if present —
            // tells us what MFL had vs. what we tried to match.
            if (data.recovery) {
              parts.push(`recovery: ${JSON.stringify(data.recovery).slice(0, 1200)}`);
            }
            throw new Error(parts.join(" · ") || `api returned ${r.status}`);
          }
          if (!r.ok || !ct.includes("json")) {
            throw new Error(`api returned ${r.status} ${ct || "(no content-type)"} · body: ${(bodyText || "").slice(0, 200)}`);
          }
          if (!data) data = JSON.parse(bodyText);
        } catch (apiErr) {
          // Local-preview / no-worker fallback — pretend the trade was
          // accepted by the simulator. No MFL write happens here in dev.
          if (isSim) {
            data = { ok: true, simulated: true, _local_stub: true };
          } else {
            throw apiErr;
          }
        }
        if (data.ok) {
          const stubNote = data._local_stub ? " <em>(local stub — worker not reachable)</em>" : "";
          if (isSim) {
            // SIM mode — auto-applies (no real "other side"). v1.7.1 behavior.
            const swap = _applySimTradeToState(basket.give, basket.receive, myFid, toFid);
            const extCount = [...basket.give, ...basket.receive].filter(a => a.extension_term).length;
            const extBit = extCount ? ` · ${extCount} pre-trade extension${extCount === 1 ? "" : "s"} attached` : "";
            const swapBit = swap.swappedCount
              ? ` · <strong>${swap.swappedCount} pick${swap.swappedCount === 1 ? "" : "s"} swapped on the board</strong>`
              : "";
            result.innerHTML = `<div style="color: var(--warn);">✓ Trade simulated${extBit}${swapBit}${stubNote}</div>`;
            const giveSummary = basket.give.map(a => a.display).join(" + ") || "—";
            const receiveSummary = basket.receive.map(a => a.display).join(" + ") || "—";
            showTradePopup({
              fromName: myName, toName: franchises[toFid] || toFid,
              fromGives: giveSummary, toGives: receiveSummary,
              source: "sim-user",
            });
          } else if (isCommishProcess) {
            // LIVE commish-process: trade was proposed AND accepted on the
            // server. Discord was posted to live channel. Show popup.
            // Dry-run path: same UI but with a 🧪 prefix and a clear
            // "no MFL write" message so Keith knows nothing landed.
            const giveSummary = basket.give.map(a => a.display).join(" + ") || "—";
            const receiveSummary = basket.receive.map(a => a.display).join(" + ") || "—";
            if (data.dry_run) {
              result.innerHTML = `<div style="color: var(--warn);">🧪 DRY-RUN — trade validated, MFL request previewed (no write). Test Discord posted.${stubNote}</div>`;
              showToast(`🧪 DRY-RUN trade: ${myName} ↔ ${franchises[toFid] || toFid} — no MFL write`, "ok");
            } else {
              const recoveredNote = data.recovered_from_duplicate
                ? " · <em>recovered from previous incomplete attempt (accepted existing pending offer)</em>"
                : "";
              const discordNote = data.discord_posted
                ? " · Discord posted to live channel"
                : (STATE.silenceTradeAnnouncements ? " · 🔕 Discord muted (per your toggle)" : "");
              result.innerHTML = `<div style="color: var(--ok);">🔨 Trade processed — completed in MFL${discordNote}${recoveredNote}.${stubNote}</div>`;
              showToast(`🔨 Trade processed: ${myName} ↔ ${franchises[toFid] || toFid}${data.recovered_from_duplicate ? " (recovered duplicate)" : ""}${STATE.silenceTradeAnnouncements ? " · Discord muted" : ""}`, "ok");
              // A trade may have changed on-clock ownership (pick swap) → pull
              // fresh MFL state immediately so the pick clock resets to the
              // new owner's full time instead of waiting for the 20s poll.
              if (typeof _refreshLiveDraftState === "function") {
                _refreshLiveDraftState({ initial: false }).catch(() => {});
              }
            }
            showTradePopup({
              fromName: myName, toName: franchises[toFid] || toFid,
              fromGives: giveSummary, toGives: receiveSummary,
              source: data.dry_run ? "sim-user" : "live",
            });
            setTimeout(() => document.getElementById("rdh-modal-overlay").classList.remove("open"), 1800);
          } else if (data.dry_run) {
            // LIVE non-commish dry-run: proposal would have been sent, but
            // wasn't. Frame it that way.
            result.innerHTML = `<div style="color: var(--warn);">🧪 DRY-RUN — proposal validated and previewed (no MFL write).${stubNote}</div>`;
            showToast(`🧪 DRY-RUN proposal to ${franchises[toFid] || toFid} — no MFL write`, "ok");
          } else {
            // LIVE mode (non-commish): trade is a PROPOSAL — the other team
            // has to accept in MFL. No Discord announcement yet, no popup.
            result.innerHTML = `<div style="color: var(--ok);">📤 Proposal sent to ${escapeHtml(franchises[toFid] || toFid)} — awaits their acceptance in MFL.${stubNote}</div>`;
            showToast(`Proposal sent to ${franchises[toFid] || toFid} — waiting for them to accept`, "ok");
          }
        } else {
          result.innerHTML = `<div style="color: var(--err)">Failed: ${escapeHtml(data.error || data.mfl_response || JSON.stringify(data)).slice(0, 400)}</div>`;
        }
      } catch (e) {
        result.innerHTML = `<div style="color: var(--err)">Error: ${escapeHtml(String(e && e.message || e))}</div>`;
      }
    });
  }

  // ── Generic pagination helper ─────────────────────────────────────
  // Slices rows[] for the current page + builds a Prev/Next/page-N control
  // strip. Returns { visible, html, attach }. Caller stamps html into a
  // container then calls attach(container, onChange) to wire buttons.
  // Page state stored on STATE under keyName so it persists across renders
  // (until filters change — caller can reset via STATE[keyName] = 0).
  const PAGE_SIZE_DEFAULT = 20;
  function paginate(rows, keyName, opts = {}) {
    const size = opts.size || PAGE_SIZE_DEFAULT;
    const total = rows.length;
    const totalPages = Math.max(1, Math.ceil(total / size));
    let page = Number(STATE[keyName] || 0);
    if (page < 0) page = 0;
    if (page >= totalPages) page = totalPages - 1;
    STATE[keyName] = page;
    const start = page * size;
    const end = Math.min(start + size, total);
    const visible = rows.slice(start, end);
    const disabledPrev = page === 0 ? "disabled" : "";
    const disabledNext = page >= totalPages - 1 ? "disabled" : "";
    const html = total <= size
      ? ""  // single-page: no controls needed
      : `<div class="rdh-paginator" data-key="${keyName}" style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin: 8px 0; padding: 6px 4px; font-size: 12px; color: var(--muted);">
           <button class="btn secondary" data-page-action="prev" ${disabledPrev} style="padding:6px 14px; min-height:32px;">‹ Prev</button>
           <span style="font-variant-numeric: tabular-nums;">
             <strong style="color: var(--text);">${start + 1}–${end}</strong> of ${total} · page ${page + 1} of ${totalPages}
           </span>
           <button class="btn secondary" data-page-action="next" ${disabledNext} style="padding:6px 14px; min-height:32px;">Next ›</button>
         </div>`;
    function attach(container, onChange) {
      if (!container) return;
      container.querySelectorAll('[data-page-action]').forEach(b => {
        b.addEventListener("click", () => {
          if (b.disabled) return;
          STATE[keyName] = page + (b.dataset.pageAction === "next" ? 1 : -1);
          if (typeof onChange === "function") onChange();
        });
      });
    }
    return { visible, html, attach, page, totalPages, total };
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

    // Paginate at 20/page so the report scrolls cleanly on mobile + desktop.
    // Page state persists on STATE.fp_page; reset to 0 on filter changes.
    const fpPager = paginate(rows, "fp_page", { size: 20 });
    tbody.innerHTML = fpPager.visible.map(p => {
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
    const tradedCount = rows.filter(r => r.current_owner_fid !== r.original_owner_fid).length;
    summary.textContent = `${rows.length} future picks · ${tradedCount} traded` +
      (fpPager.totalPages > 1 ? ` · page ${fpPager.page + 1}/${fpPager.totalPages}` : "");
    // Mount paginator below the table.
    const fpTable = tbody.closest("table");
    let fpPagBox = document.getElementById("fp-paginator");
    if (!fpPagBox && fpTable && fpTable.parentNode) {
      fpPagBox = document.createElement("div");
      fpPagBox.id = "fp-paginator";
      fpTable.parentNode.insertBefore(fpPagBox, fpTable.nextSibling);
    }
    if (fpPagBox) {
      fpPagBox.innerHTML = fpPager.html;
      fpPager.attach(fpPagBox, renderFuturePicks);
    }

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

  // ══════════════════════════════════════════════════════════════════════
  // MY TEAM + MY QUEUE (v1.5.5)
  // ══════════════════════════════════════════════════════════════════════
  // My Team card shows the user's franchise: which picks they own this
  // draft (with the next-up one highlighted), how many roster players + cap
  // load. Sourced from STATE.live (draft order) + the franchise_assets snapshot.
  //
  // My Queue is a priority list of prospects the user wants to draft in
  // order. Persisted per-franchise in sessionStorage. On the user's turn,
  // the top-most non-drafted entry is auto-promoted to STATE.selectedProspect.

  function _myFid() {
    return (STATE.me && STATE.me.franchise_id) || (AUTO_SIM && AUTO_SIM.playAsFid) || null;
  }
  function _queueStorageKey() {
    const fid = _myFid();
    return fid ? `rdh_queue_${fid}` : "rdh_queue_default";
  }
  function _loadMyQueue() {
    try {
      const raw = sessionStorage.getItem(_queueStorageKey());
      STATE.myQueue = raw ? JSON.parse(raw) : [];
    } catch (e) { STATE.myQueue = []; }
    if (!Array.isArray(STATE.myQueue)) STATE.myQueue = [];
  }
  function _saveMyQueue() {
    try { sessionStorage.setItem(_queueStorageKey(), JSON.stringify(STATE.myQueue)); } catch (e) {}
  }
  function _addToQueue(playerId) {
    const pid = String(playerId);
    if (!pid) return;
    if (STATE.myQueue.includes(pid)) return;
    STATE.myQueue.push(pid);
    _saveMyQueue();
    renderMyQueue();
    renderProspects();   // refresh "+" → "✓ queued" indicators
  }
  function _removeFromQueue(playerId) {
    const pid = String(playerId);
    STATE.myQueue = STATE.myQueue.filter(x => x !== pid);
    _saveMyQueue();
    renderMyQueue();
    renderProspects();
  }
  function _moveInQueue(playerId, dir) {
    const pid = String(playerId);
    const i = STATE.myQueue.indexOf(pid);
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= STATE.myQueue.length) return;
    const tmp = STATE.myQueue[i];
    STATE.myQueue[i] = STATE.myQueue[j];
    STATE.myQueue[j] = tmp;
    _saveMyQueue();
    renderMyQueue();
  }

  function renderMyTeam() {
    const card = document.getElementById("my-team-card");
    if (!card) return;
    const fid = _myFid();
    if (!fid) { card.hidden = true; return; }
    card.hidden = false;
    const franchises = (STATE.live && STATE.live.franchises) || {};
    const fname = franchises[fid] || fid;
    document.getElementById("my-team-name").textContent = fname;
    // Cross-link to the My Team HPM page (lives at the league home for
    // the viewer's franchise). Falls back to the league options page if
    // we don't have a franchise context.
    const myTeamLink = document.getElementById("my-team-fullview-link");
    if (myTeamLink) {
      const padFidStr = String(fid).padStart(4, "0").slice(-4);
      myTeamLink.href = `https://www48.myfantasyleague.com/2026/home/74598/${padFidStr}`;
    }

    // Picks owned this draft — split into 'made', 'next up' (earliest unmade
    // owned by us), and the rest as 'future'.
    const order = (STATE.live && STATE.live.draft_order) || [];
    const made = (STATE.live && STATE.live.picks_made) || [];
    const madeKeys = new Set(made.map(p => `${p.round}.${p.pick}`));
    const myPicksAll = order.filter(o => String(o.owned_by_franchise_id) === String(fid));
    const myPicksUnmade = myPicksAll.filter(o => !madeKeys.has(`${o.round}.${o.pick}`));
    // Earliest unmade across the WHOLE order — that's "next on the clock for someone".
    // Then we mark MY earliest unmade as my "next up".
    const myNextUp = myPicksUnmade[0]; // already in draft order

    const pickChip = (o, type) => {
      const slot = `${o.round}.${String(o.pick).padStart(2, "0")}`;
      const cls = type === "next" ? "my-team-pick-chip next-up" : "my-team-pick-chip";
      return `<span class="${cls}" title="${type === 'next' ? 'Your next pick' : ''}">${slot}</span>`;
    };
    const futurePickChips = ((STATE.future_picks && STATE.future_picks.picks) || [])
      .filter(fp => String(fp.current_owner_fid || fp.owner_fid) === String(fid))
      .slice(0, 8)
      .map(fp => `<span class="my-team-pick-chip future" title="${fp.year} R${fp.round}">${fp.year} R${fp.round}</span>`)
      .join("");

    // Snapshot for roster summary
    const padFid = String(fid).padStart(4, "0").slice(-4);
    const snap = STATE.franchise_assets_snapshot
              && STATE.franchise_assets_snapshot.by_fid
              && STATE.franchise_assets_snapshot.by_fid[padFid];
    const rosterPlayers = (snap && snap.players) || [];
    // Cap math: taxi salaries are real money but DO NOT count vs the cap
    // (UPS rule). Show both numbers so owners see total payroll AND
    // cap-relevant payroll. Salary always rendered alongside TAXI badge.
    const activeCapSalary = rosterPlayers.filter(p => !p.taxi).reduce((s, p) => s + Number(p.salary || 0), 0);
    const taxiSalary = rosterPlayers.filter(p => p.taxi).reduce((s, p) => s + Number(p.salary || 0), 0);
    const totalSalary = activeCapSalary + taxiSalary;
    const taxiCount = rosterPlayers.filter(p => p.taxi).length;

    // Group roster by position group: Offense (QB/RB/WR/TE), Defense, Special.
    // Sort within each group by salary desc so the most-expensive players
    // surface first. Compact rows: name + salary chip on the right.
    const POS_BUCKET = (pos) => {
      const p = String(pos || "").toUpperCase();
      if (p === "QB") return "QB";
      if (p === "RB") return "RB";
      if (p === "WR") return "WR";
      if (p === "TE") return "TE";
      if (["DL","DE","DT","NT","EDGE"].includes(p)) return "DL";
      if (["LB","ILB","OLB"].includes(p)) return "LB";
      if (["DB","CB","S","FS","SS"].includes(p)) return "DB";
      if (["PK","K"].includes(p)) return "PK";
      if (["P","PN"].includes(p)) return "PN";
      return "—";
    };
    const BUCKET_ORDER = ["QB","RB","WR","TE","DL","LB","DB","PK","PN","—"];
    const rosterByPos = {};
    for (const pl of rosterPlayers) {
      const b = POS_BUCKET(pl.position);
      (rosterByPos[b] = rosterByPos[b] || []).push(pl);
    }
    Object.values(rosterByPos).forEach(arr => arr.sort((a, b) => (b.salary || 0) - (a.salary || 0)));

    const rosterGroupHtml = (bucket) => {
      const players = rosterByPos[bucket] || [];
      if (!players.length) return "";
      // Per-bucket cap-relevant total + taxi-aside callout when applicable.
      const capTotal = players.filter(p => !p.taxi).reduce((s, p) => s + Number(p.salary || 0), 0);
      const bucketTaxi = players.filter(p => p.taxi).reduce((s, p) => s + Number(p.salary || 0), 0);
      const fmtK = (v) => "$" + (v / 1000).toFixed(0) + "K";
      return `
        <details class="my-team-pos-group">
          <summary>
            <span class="my-team-pos-bucket">${bucket}</span>
            <span class="my-team-pos-count">${players.length}</span>
            <span class="my-team-pos-total">${fmtK(capTotal)}${bucketTaxi ? ` <span class="small" style="opacity:0.65; font-weight:400;">+ ${fmtK(bucketTaxi)} taxi</span>` : ''}</span>
            <span class="my-team-pos-caret">▾</span>
          </summary>
          <div class="my-team-pos-body">
            ${players.map(p => `
              <div class="my-team-player-row${p.taxi ? ' is-taxi' : ''}">
                <span class="my-team-player-name" title="${escapeHtml(p.display)}${p.taxi ? ' (TAXI — salary does not count vs cap)' : ''}">${escapeHtml(p.display)}${p.taxi ? '<span class="taxi-pill">TAXI</span>' : ''}</span>
                <span class="my-team-player-meta">${escapeHtml(p.position || '')}${p.contract_year ? ' · Y' + p.contract_year : ''}</span>
                <span class="my-team-player-sal">${fmtK(Number(p.salary || 0))}</span>
              </div>
            `).join("")}
          </div>
        </details>`;
    };

    document.getElementById("my-team-body").innerHTML = `
      ${myPicksUnmade.length ? `
        <div class="my-team-section">
          <div class="my-team-section-head">Picks left this draft (${myPicksUnmade.length})</div>
          <div class="my-team-picks">
            ${myPicksUnmade.map(o => pickChip(o, o === myNextUp ? "next" : "")).join("")}
          </div>
        </div>` : `
        <div class="my-team-section">
          <div class="my-team-section-head">No picks left this draft</div>
        </div>`}

      ${futurePickChips ? `
        <div class="my-team-section">
          <div class="my-team-section-head">Future picks</div>
          <div class="my-team-picks">${futurePickChips}</div>
        </div>` : ""}

      ${rosterPlayers.length ? `
        <details class="my-team-section my-team-roster-section">
          <summary class="my-team-section-summary">
            <span class="my-team-section-head">Roster · ${rosterPlayers.length} players · $${activeCapSalary.toLocaleString()} cap${taxiCount ? ` <span class="small" style="opacity:0.7; font-weight:400;">+ $${taxiSalary.toLocaleString()} taxi (${taxiCount})</span>` : ""}</span>
            <span class="my-team-pos-caret">▾</span>
          </summary>
          <div class="my-team-roster-groups">
            ${BUCKET_ORDER.map(rosterGroupHtml).join("")}
          </div>
        </details>` : ""}
    `;
  }

  function renderMyQueue() {
    const card = document.getElementById("my-queue-card");
    if (!card) return;
    const fid = _myFid();
    if (!fid) { card.hidden = true; return; }
    card.hidden = false;

    const list = document.getElementById("my-queue-list");
    const countEl = document.getElementById("my-queue-count");
    const drafted = _draftedPickIndex();
    const prospects = (STATE.prospects && STATE.prospects.prospects) || [];
    // Auto-trim drafted from queue
    const before = STATE.myQueue.length;
    STATE.myQueue = STATE.myQueue.filter(pid => !drafted[String(pid)]);
    if (STATE.myQueue.length !== before) _saveMyQueue();

    if (countEl) countEl.textContent = STATE.myQueue.length;
    if (!STATE.myQueue.length) {
      list.innerHTML = `<div class="my-queue-empty">No prospects queued yet.</div>`;
      return;
    }

    // The earliest available is the one we'd auto-select on the user's turn.
    const nextAvail = STATE.myQueue.find(pid => !drafted[String(pid)]);

    list.innerHTML = STATE.myQueue.map((pid, i) => {
      const p = prospects.find(x => String(x.player_id) === String(pid));
      if (!p) return "";
      const dispName = (p.name || "").includes(",")
        ? p.name.split(",").reverse().map(s => s.trim()).join(" ")
        : p.name;
      const isNext = (pid === nextAvail);
      return `
        <div class="my-queue-row${isNext ? ' is-next-pick' : ''}" data-pid="${escapeHtml(pid)}">
          <span class="my-queue-pos">${escapeHtml(p.position || '')}</span>
          <span class="my-queue-name" title="${escapeHtml(dispName)}${p.nfl_team ? ' · ' + escapeHtml(p.nfl_team) : ''}">${i + 1}. ${escapeHtml(dispName)}</span>
          <span class="my-queue-meta">${p.consensus_rank ? '#' + p.consensus_rank : ''}</span>
          <div class="my-queue-actions">
            <button class="my-queue-btn move-up" data-pid="${escapeHtml(pid)}" title="Move up" ${i === 0 ? 'disabled style="opacity:0.3;"' : ''}>▲</button>
            <button class="my-queue-btn move-down" data-pid="${escapeHtml(pid)}" title="Move down" ${i === STATE.myQueue.length - 1 ? 'disabled style="opacity:0.3;"' : ''}>▼</button>
            <button class="my-queue-btn remove" data-pid="${escapeHtml(pid)}" title="Remove from queue">✕</button>
          </div>
        </div>`;
    }).join("");

    list.querySelectorAll(".move-up").forEach(b => b.addEventListener("click", () => _moveInQueue(b.dataset.pid, -1)));
    list.querySelectorAll(".move-down").forEach(b => b.addEventListener("click", () => _moveInQueue(b.dataset.pid, +1)));
    list.querySelectorAll(".remove").forEach(b => b.addEventListener("click", () => _removeFromQueue(b.dataset.pid)));
  }

  // Auto-promote the queue's first available prospect to selectedProspect
  // AND auto-submit the pick after a 3-second cancel window — but only if
  // the user has explicitly ticked the auto-pick checkbox. Default is OFF
  // so owners always confirm manually.
  //
  // SIM mode: submits via local _autoSimRecordPick (no worker call).
  // LIVE mode: only sets selectedProspect — user must still confirm via
  //   the modal. (Auto-submitting an MFL write is too risky.)
  function _autoPickFromQueueEnabled() {
    try {
      return sessionStorage.getItem(`rdh_queue_autopick_${_myFid() || "default"}`) === "1";
    } catch (e) { return false; }
  }
  // Module-level state for the pending auto-pick countdown — guards against
  // multiple timers stacking up across re-renders.
  let _autoPickTimer = null;
  let _autoPickPid = null;
  function _cancelAutoPick(reason) {
    if (_autoPickTimer) clearTimeout(_autoPickTimer);
    _autoPickTimer = null;
    _autoPickPid = null;
    if (reason) showToast(reason, "ok");
  }
  function _maybeAutoSelectFromQueue() {
    if (!_autoPickFromQueueEnabled()) return;  // opt-in only
    if (!STATE.myQueue.length) return;
    const fid = _myFid();
    if (!fid) return _cancelAutoPick(null);
    const active = STATE.live && STATE.live.active_pick;
    if (!active || String(active.franchise_id) !== String(fid)) {
      // No longer on the clock — cancel any pending countdown.
      return _cancelAutoPick(null);
    }
    const drafted = _draftedPickIndex();
    const nextPid = STATE.myQueue.find(pid => !drafted[String(pid)]);
    if (!nextPid) return _cancelAutoPick(null);
    const p = (STATE.prospects && STATE.prospects.prospects || [])
      .find(x => String(x.player_id) === String(nextPid));
    if (!p) return _cancelAutoPick(null);

    // Always set selectedProspect so the on-clock card shows the queue head.
    STATE.selectedProspect = p;

    // If a timer is already running for THIS prospect, leave it alone.
    if (_autoPickTimer && _autoPickPid === nextPid) return;
    // Different prospect than the pending one (queue reordered, etc.) — restart.
    if (_autoPickTimer) clearTimeout(_autoPickTimer);
    _autoPickPid = nextPid;

    const isSim = !!STATE.simulationMode;
    if (!isSim) {
      // LIVE mode — don't auto-submit MFL writes. Just keep selectedProspect set.
      // User must click Draft Player → confirm in the modal.
      _autoPickTimer = null;
      _autoPickPid = null;
      return;
    }

    showToast(`🤖 Auto-picking ${p.name.includes(",") ? p.name.split(",").reverse().map(s=>s.trim()).join(" ") : p.name} in 3s — click anywhere on the on-clock card to cancel`, "ok");
    _autoPickTimer = setTimeout(() => {
      // Re-validate everything (queue may have changed, prospect may be drafted, sim may have advanced)
      _autoPickTimer = null;
      _autoPickPid = null;
      const stillActive = STATE.live && STATE.live.active_pick;
      if (!stillActive || String(stillActive.franchise_id) !== String(fid)) return;
      if ((STATE.live.picks_made || []).find(pp => String(pp.player_id) === String(p.player_id))) return;
      // Submit via local sim record + advance the sim if running
      _autoSimRecordPick({
        round: stillActive.round, pick: stillActive.pick,
        franchise_id: stillActive.franchise_id,
      }, p, "user-queue-auto");
      showToast(`✓ Auto-picked ${p.name.includes(",") ? p.name.split(",").reverse().map(s=>s.trim()).join(" ") : p.name} from your queue`, "ok");
      if (AUTO_SIM.running) {
        AUTO_SIM.paused = false;
        _autoSimUiSetState("running");
        _autoSimSchedule();
      }
    }, 3000);
  }

  // ══════════════════════════════════════════════════════════════════════
  // INCOMING TRADES INBOX (v1.4.0)
  // ══════════════════════════════════════════════════════════════════════
  // Each entry: {
  //   id: string (unique),
  //   from_fid, from_name,
  //   to_fid,   to_name,
  //   give:    [{ asset_id, display, kind, player_id?, position?, salary?, extension_term? }],
  //   receive: [...same shape...],
  //   comments: string,
  //   submitted_at_utc: ISO,
  //   source: "live" | "sim",
  // }
  const TRADE_INBOX = {
    items: [],
    pollTimer: null,
  };

  function _inboxAdd(offer) {
    if (!offer || !offer.id) return;
    if (TRADE_INBOX.items.find(o => o.id === offer.id)) return;
    TRADE_INBOX.items.unshift(offer);
    _inboxRender();
    showToast(`📬 New trade offer from ${offer.from_name}`, "ok");
  }

  function _inboxRemove(id) {
    TRADE_INBOX.items = TRADE_INBOX.items.filter(o => o.id !== id);
    _inboxRender();
  }

  function _inboxRender() {
    const list = document.getElementById("trade-inbox-list");
    const badge = document.getElementById("trade-inbox-badge");
    if (!list) return;
    const myFid = STATE.me && STATE.me.franchise_id;
    const visible = TRADE_INBOX.items.filter(o => !myFid || String(o.to_fid) === String(myFid));
    if (badge) {
      if (visible.length) { badge.hidden = false; badge.textContent = String(visible.length); }
      else { badge.hidden = true; }
    }
    if (!visible.length) {
      list.innerHTML = '<div class="trade-inbox-empty">No pending trade offers.</div>';
      return;
    }
    list.innerHTML = visible.map(o => {
      const giveSummary = (o.give || []).map(a => a.display).join(", ") || "—";
      const recvSummary = (o.receive || []).map(a => a.display).join(", ") || "—";
      const when = o.submitted_at_utc ? new Date(o.submitted_at_utc).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
      return `
        <div class="trade-inbox-row" data-id="${escapeHtml(o.id)}" tabindex="0" role="button">
          <div class="trade-inbox-from">From <strong>${escapeHtml(o.from_name || o.from_fid)}</strong></div>
          <div class="trade-inbox-summary">
            <span title="They give you">${escapeHtml(recvSummary)}</span>
            <span class="ti-arrow">⇄</span>
            <span title="You give them">${escapeHtml(giveSummary)}</span>
          </div>
          <div class="trade-inbox-meta">
            <span>${escapeHtml(o.source === "sim" ? "simulated" : when || "")}</span>
            <span>Tap to review →</span>
          </div>
        </div>`;
    }).join("");
    list.querySelectorAll(".trade-inbox-row").forEach(row => {
      row.addEventListener("click", () => {
        const offer = TRADE_INBOX.items.find(o => o.id === row.dataset.id);
        if (offer) openTradeDetailModal(offer);
      });
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          const offer = TRADE_INBOX.items.find(o => o.id === row.dataset.id);
          if (offer) openTradeDetailModal(offer);
        }
      });
    });
  }

  function openTradeDetailModal(offer) {
    const renderBasket = (cls, title, items) => `
      <div class="trade-detail-basket ${cls}">
        <div class="trade-detail-basket-title">${escapeHtml(title)}</div>
        ${(items && items.length) ? items.map(a => `
          <div class="trade-detail-asset-row">
            ${escapeHtml(a.display)}
            ${a.position ? `<span class="small" style="color:var(--muted); margin-left:6px;">${escapeHtml(a.position)}</span>` : ""}
            ${a.salary ? `<span class="small" style="color:var(--muted); margin-left:6px;">$${Math.round(a.salary).toLocaleString()}</span>` : ""}
            ${a.extension_term ? `<span class="trade-basket-ext-pill">+ ${escapeHtml(a.extension_term)}</span>` : ""}
          </div>`).join("") : '<div class="small" style="color:var(--muted)">(empty)</div>'}
      </div>`;
    openModal(`
      <div class="trade-detail-shell">
        <header class="trade-detail-header">
          <div style="font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:0.5px;">Trade offer</div>
          <h3 style="margin:4px 0 0;">${escapeHtml(offer.from_name || offer.from_fid)} → You</h3>
        </header>
        <div class="trade-detail-body">
          <div class="trade-detail-baskets">
            ${renderBasket("receive", "YOU RECEIVE", offer.receive)}
            <div style="display:flex; align-items:center; justify-content:center; font-size:22px; color:var(--accent); font-weight:700;">⇄</div>
            ${renderBasket("give",    "YOU GIVE",    offer.give)}
          </div>
          ${offer.comments ? `<div style="background:var(--panel-alt); border-left:3px solid var(--accent); border-radius:4px; padding:8px 12px; font-size:12px; color:var(--text);"><strong style="color:var(--muted); font-size:10px; text-transform:uppercase; letter-spacing:0.5px; display:block; margin-bottom:4px;">Comments</strong>${escapeHtml(offer.comments)}</div>` : ""}
          <div id="trade-detail-result" style="margin-top:10px; font-size:12px;"></div>
        </div>
        <footer class="trade-detail-footer">
          <button class="btn secondary" type="button" onclick="document.getElementById('rdh-modal-overlay').classList.remove('open')">Close</button>
          <button class="btn decline" id="trade-detail-decline" type="button">✕ Decline</button>
          <button class="btn counter" id="trade-detail-counter" type="button">↻ Counter</button>
          <button class="btn accept"  id="trade-detail-accept"  type="button">✓ Accept</button>
        </footer>
      </div>
    `);
    document.getElementById("trade-detail-accept").addEventListener("click", () => _respondToOffer(offer, "accept"));
    document.getElementById("trade-detail-decline").addEventListener("click", () => _respondToOffer(offer, "decline"));
    document.getElementById("trade-detail-counter").addEventListener("click", () => {
      // Counter = open the trade-compose modal pre-populated with reversed
      // teams + swapped baskets. User edits + resubmits.
      _respondToOffer(offer, "counter");
    });
  }

  async function _respondToOffer(offer, action) {
    const resultEl = document.getElementById("trade-detail-result");
    const isSim = !!STATE.simulationMode || offer.source === "sim";

    if (action === "counter") {
      // Stash the reverse-payload so openTradeModal can pre-populate.
      STATE._counterPrepopulate = {
        partner_fid: offer.from_fid,
        partner_name: offer.from_name,
        give: (offer.receive || []).map(a => ({ ...a })),     // what they'd offer (was "receive")
        receive: (offer.give || []).map(a => ({ ...a })),     // what they'd get (was "give")
        comments: offer.comments ? `Counter to: ${offer.comments}` : "Counter offer",
        original_offer_id: offer.id,
      };
      // Remove the offer from inbox (it's superseded by our counter)
      _inboxRemove(offer.id);
      document.getElementById("rdh-modal-overlay").classList.remove("open");
      setTimeout(() => openTradeModal(), 200);
      return;
    }

    if (resultEl) resultEl.innerHTML = `<span style="color:var(--muted);">${action === "accept" ? "Accepting" : "Declining"} offer…</span>`;

    if (isSim) {
      // Local sim — just remove from inbox + toast
      _inboxRemove(offer.id);
      let extra = "";
      if (action === "accept") {
        // Apply the incoming offer to local STATE. From the recipient's POV,
        // 'their give' (offer.give) is what they send to the proposer, and
        // 'their receive' (offer.receive) is what they get back. Pass myFid
        // (recipient) and from_fid (proposer) to the helper.
        const myFid = STATE.me && STATE.me.franchise_id;
        const swap = _applySimTradeToState(offer.give || [], offer.receive || [], myFid, offer.from_fid);
        if (swap.swappedCount) extra = ` — board updated (${swap.swappedCount} pick${swap.swappedCount === 1 ? "" : "s"} swapped)`;
      }
      showToast(action === "accept" ? `✅ Accepted offer from ${offer.from_name}${extra}` : `✕ Declined offer from ${offer.from_name}`, "ok");
      setTimeout(() => document.getElementById("rdh-modal-overlay").classList.remove("open"), 600);
      return;
    }

    // LIVE — call the existing trade-workbench worker endpoint.
    try {
      const url = apiUrl("/api/trades/proposals/action") + "?L=74598";
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proposal_id: offer.id,
          action: action,                           // 'accept' | 'decline'
          acting_franchise_id: STATE.me.franchise_id,
        }),
      });
      const ct = r.headers.get("content-type") || "";
      if (!r.ok || !ct.includes("json")) throw new Error(`api returned ${r.status}`);
      const data = await r.json();
      if (data.ok) {
        if (resultEl) resultEl.innerHTML = `<span style="color:var(--ok);">${action === "accept" ? "Accepted" : "Declined"}.</span>`;
        showToast(action === "accept" ? "Trade accepted" : "Trade declined", "ok");
        _inboxRemove(offer.id);
        setTimeout(() => document.getElementById("rdh-modal-overlay").classList.remove("open"), 800);
      } else {
        if (resultEl) resultEl.innerHTML = `<span style="color:var(--err);">Failed: ${escapeHtml(data.error || "unknown")}</span>`;
      }
    } catch (e) {
      if (resultEl) resultEl.innerHTML = `<span style="color:var(--err);">Error: ${escapeHtml(String(e && e.message || e))}</span>`;
    }
  }

  // Live-mode polling — fetch /api/trades/proposals every 30s when not in
  // simulate mode. Worker returns proposals; filter to ones addressed to us.
  async function _inboxPollOnce() {
    if (STATE.simulationMode) return;  // inbox is live-mode only
    const myFid = STATE.me && STATE.me.franchise_id;
    if (!myFid) return;
    try {
      const r = await fetch(apiUrl("/api/trades/proposals") + `?L=74598&to_fid=${encodeURIComponent(myFid)}`);
      const ct = r.headers.get("content-type") || "";
      if (!r.ok || !ct.includes("json")) return;
      const data = await r.json();
      const proposals = (data && data.proposals) || (Array.isArray(data) ? data : []) || [];
      // Sync: drop live items not in the new list, add new ones.
      const liveIds = new Set(proposals.map(p => p.id || p.proposal_id));
      TRADE_INBOX.items = TRADE_INBOX.items.filter(o => o.source !== "live" || liveIds.has(o.id));
      for (const p of proposals) {
        const offer = _proposalToOffer(p);
        if (offer && !TRADE_INBOX.items.find(o => o.id === offer.id)) {
          TRADE_INBOX.items.push(offer);
        }
      }
      _inboxRender();
    } catch (e) { /* worker unreachable — silent */ }
  }

  function _proposalToOffer(p) {
    if (!p) return null;
    return {
      id: p.id || p.proposal_id || `live-${Math.random().toString(36).slice(2)}`,
      from_fid: p.from_franchise_id || p.from_fid,
      from_name: p.from_franchise_name || p.from_name || p.from_franchise_id,
      to_fid: p.to_franchise_id || p.to_fid,
      to_name: p.to_franchise_name || p.to_name || "",
      give:    p.give    || (p.payload && p.payload.give)    || [],
      receive: p.receive || (p.payload && p.payload.receive) || [],
      comments: p.comments || (p.payload && p.payload.comments) || "",
      submitted_at_utc: p.submitted_at_utc || p.created_at_utc || "",
      source: "live",
    };
  }

  function _inboxStartPolling() {
    if (TRADE_INBOX.pollTimer) clearInterval(TRADE_INBOX.pollTimer);
    _inboxPollOnce();
    TRADE_INBOX.pollTimer = setInterval(_inboxPollOnce, 30000);
  }

  // Local-preview fallback for /api/franchise-assets. Three signal sources,
  // tried in order:
  //   1) franchise_assets_2026.json snapshot (best — has player names + salary)
  //   2) STATE.future_picks for future picks
  //   3) STATE.live.draft_order for current-year unmade picks
  function _localFranchiseAssetsStub(fid) {
    const padFid = String(fid).padStart(4, "0").slice(-4);
    const snap = STATE.franchise_assets_snapshot
              && STATE.franchise_assets_snapshot.by_fid
              && STATE.franchise_assets_snapshot.by_fid[padFid];
    if (snap) {
      // Snapshot wins — but rebuild current-year picks from the LIVE state so
      // simulated picks made during the session don't appear as available.
      const order = (STATE.live && STATE.live.draft_order) || [];
      const made = (STATE.live && STATE.live.picks_made) || [];
      const madeKeys = new Set(made.map(p => `${p.round}.${p.pick}`));
      const year = (STATE.live && STATE.live.meta && STATE.live.meta.season) || new Date().getFullYear();
      const current_picks = order
        .filter(o => String(o.owned_by_franchise_id) === padFid
                  && !madeKeys.has(`${o.round}.${o.pick}`))
        .map(o => ({
          asset_id: `DP_${year}_${o.round}_${o.pick}`,
          display: `${year} ${o.round}.${String(o.pick).padStart(2, "0")}`,
          round: o.round, slot: o.pick,
        }));
      return {
        players: snap.players || [],
        future_picks: snap.future_picks || [],
        current_picks,
      };
    }
    // Fallback when no snapshot — picks-only.
    const order = (STATE.live && STATE.live.draft_order) || [];
    const made = (STATE.live && STATE.live.picks_made) || [];
    const madeKeys = new Set(made.map(p => `${p.round}.${p.pick}`));
    const year = (STATE.live && STATE.live.meta && STATE.live.meta.season) || new Date().getFullYear();
    const current_picks = order
      .filter(o => String(o.owned_by_franchise_id) === padFid
                && !madeKeys.has(`${o.round}.${o.pick}`))
      .map(o => ({
        asset_id: `DP_${year}_${o.round}_${o.pick}`,
        display: `${year} ${o.round}.${String(o.pick).padStart(2, "0")}`,
        round: o.round, slot: o.pick,
      }));
    const fps = (STATE.future_picks && STATE.future_picks.picks) || [];
    const future_picks = fps
      .filter(fp => String(fp.current_owner_fid || fp.owner_fid) === padFid)
      .map(fp => ({
        asset_id: `FP_${fp.year}_${fp.round}_${fp.original_owner_fid || fp.original_fid || padFid}`,
        display: `${fp.year} R${fp.round}${fp.original_owner_fid && fp.original_owner_fid !== padFid ? " (orig " + fp.original_owner_fid + ")" : ""}`,
        year: fp.year, round: fp.round,
      }));
    return { players: [], future_picks, current_picks };
  }

  // ══════════════════════════════════════════════════════════════════════
  // AUTO-DRAFT ENGINE — simulate non-user picks with a 10s timer
  // ══════════════════════════════════════════════════════════════════════
  // Algorithm:
  //   score = consensus_rank
  //         + gaussian_jitter(σ=2.5)         // small noise
  //         - position_bonus                  // owner.position_mix-driven
  //         - offense_bonus                   // owner.offense_pct vs prospect side
  //         + reach_penalty                   // discourage huge reaches early
  // Top candidates are sorted by score; engine picks the lowest with 80%
  // probability, otherwise samples from the top-3 weighted by softmax for
  // variety. R6 picks are filtered to defense (IDP-only league rule).
  const AUTO_SIM = {
    running: false,
    paused: false,
    pausedByModal: false,
    speedMs: 10000,
    playAsFid: null,
    timer: null,
    tickStart: 0,
    tickRaf: null,
    history: [],   // log of [{round, pick, fid, player_id, name, by: 'engine'|'user'}]
  };

  function _autoSimAvailable() {
    const made = (STATE.live && STATE.live.picks_made) || [];
    const drafted = new Set(made.map(p => String(p.player_id)));
    const all = (STATE.prospects && STATE.prospects.prospects) || [];
    return all.filter(p => p.player_id && !drafted.has(String(p.player_id)));
  }

  function _autoSimNextSlot() {
    // Find the first slot in draft_order that doesn't have a corresponding pick yet.
    const order = (STATE.live && STATE.live.draft_order) || [];
    const made = (STATE.live && STATE.live.picks_made) || [];
    const madeKeys = new Set(made.map(p => `${p.round}.${p.pick}`));
    for (const o of order) {
      if (!madeKeys.has(`${o.round}.${o.pick}`)) {
        return {
          round: o.round, pick: o.pick,
          franchise_id: o.owned_by_franchise_id,
          original_franchise_id: o.original_franchise_id,
        };
      }
    }
    return null;
  }

  function _gauss(sigma) {
    // Box-Muller — gaussian random with stddev sigma, mean 0.
    const u = 1 - Math.random();
    const v = Math.random();
    return sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function _isDefensePos(pos) {
    return ["DL","DE","DT","LB","ILB","OLB","DB","CB","S","SS","FS"].includes((pos || "").toUpperCase());
  }
  function _isOffensePos(pos) {
    return ["QB","RB","WR","TE"].includes((pos || "").toUpperCase());
  }

  function _autoSimChoosePick(fid, round) {
    let pool = _autoSimAvailable();
    // R6 — UPS rule: IDP only.
    if (round === 6) pool = pool.filter(p => _isDefensePos(p.position));
    if (!pool.length) return null;

    // Eligibility filter — until round 5 we ignore players with NO ranking
    // signal (consensus_rank null AND no MFL ADP). They're noise (UDFAs,
    // priority free-agent signings, retired/inactive). At 1.01 nobody is
    // taking Noah Whittington (UDFA, every source null).
    //
    // Careful with the null check: JS quirk — Number(null) === 0, NOT NaN.
    // If we used Number.isFinite(Number(p.consensus_rank)) here, a null
    // consensus_rank would coerce to 0 and pass the filter (and worse,
    // would score AS rank 0, beating the actual #1 player). Compare to
    // null/undefined explicitly.
    const _hasRank = (v) => v != null && Number.isFinite(Number(v));
    const isRanked = (p) => _hasRank(p.consensus_rank) || _hasRank(p.rookie_adp);
    if (round <= 4) {
      const ranked = pool.filter(isRanked);
      if (ranked.length) pool = ranked;
    }

    const tend = (STATE.teams && STATE.teams.teams && STATE.teams.teams[fid]) || {};
    const posMix = tend.position_mix || {};
    const offPct = Number(tend.offense_pct || 0.6);
    const isOffenseOwner = offPct > 0.55;
    const isDefenseOwner = offPct < 0.45;

    // Per-round tuning.
    //   posMul   — strength of owner's position-mix preference
    //   sideMul  — strength of offense/defense owner skew
    //   tierGap  — ADP-gap threshold to start a new tier
    //   tierBleed — chance to reach one tier deeper
    //   defPenalty — score added to every defensive prospect in this round.
    //                Calibrated to UPS history 2020+ (verified via jq on
    //                rookie_draft_history.json):
    //                  R1: 0% def picks  → +80 (effectively never)
    //                  R2: 2% def picks  → +50 (very rare)
    //                  R3: 9% def picks  → +28 (rare)
    //                  R4: 26% def picks → +10 (creeping in)
    //                  R5: 27% def picks → +2  (common)
    //                  R6: IDP only      → 0   (filter already excludes offense)
    //   sameRoundDefPenalty — if this franchise already drafted a defensive
    //                player this round, add this penalty to any defensive
    //                candidates. Historical rate of double-up <2% so this is
    //                effectively a hard block in R1-R3.
    const tune = ({
      1: { posMul: 0,    sideMul: 0,   tierGap: 1.5, tierBleed: 0.00, defPenalty: 80, sameRoundDefPenalty: 100 },
      2: { posMul: 0.5,  sideMul: 0.3, tierGap: 1.8, tierBleed: 0.10, defPenalty: 50, sameRoundDefPenalty: 80 },
      3: { posMul: 1.0,  sideMul: 0.5, tierGap: 2.5, tierBleed: 0.20, defPenalty: 28, sameRoundDefPenalty: 50 },
      4: { posMul: 1.5,  sideMul: 0.7, tierGap: 3.5, tierBleed: 0.30, defPenalty: 26, sameRoundDefPenalty: 30 },
      5: { posMul: 2.0,  sideMul: 1.0, tierGap: 5.0, tierBleed: 0.40, defPenalty: 25, sameRoundDefPenalty: 22 },
      6: { posMul: 1.5,  sideMul: 0.8, tierGap: 6.0, tierBleed: 0.30, defPenalty: 0,  sameRoundDefPenalty: 0 },
    })[round] || { posMul: 1, sideMul: 0.5, tierGap: 3.0, tierBleed: 0.20, defPenalty: 10, sameRoundDefPenalty: 20 };

    // Has this franchise already drafted a defensive player THIS round? If
    // yes, defensive candidates get an extra penalty (history shows teams
    // virtually never double up on defense in the same round, R1-R5).
    const sameRoundPicks = ((STATE.live && STATE.live.picks_made) || [])
      .filter(p => Number(p.round) === round && String(p.franchise_id) === String(fid));
    const tookDefenseThisRound = sameRoundPicks.some(p => {
      const pid = String(p.player_id);
      const prosp = (STATE.prospects && STATE.prospects.prospects || [])
        .find(pp => String(pp.player_id) === pid);
      return prosp && _isDefensePos(prosp.position);
    });

    // Score every prospect (lower = better). Same null-trap care as above.
    // No gaussian jitter on the base — variation comes from the TIER sampler
    // below, which respects the actual ADP/consensus gaps. Position + side
    // bonuses still nudge picks toward an owner's tendencies, and a
    // history-calibrated defense penalty keeps R1-R3 nearly defense-free.
    const scored = pool.map(p => {
      let base;
      if (_hasRank(p.consensus_rank))    base = Number(p.consensus_rank);
      else if (_hasRank(p.rookie_adp))   base = Number(p.rookie_adp);
      else                                base = 999;
      const pos = (p.position || "").toUpperCase();
      const posBonus = (posMix[pos] || 0) * tune.posMul;
      let sideBonus = 0;
      if (isOffenseOwner && _isOffensePos(pos)) sideBonus = tune.sideMul;
      if (isDefenseOwner && _isDefensePos(pos)) sideBonus = tune.sideMul;
      const reachPenalty = round <= 2 ? 0 : Math.max(0, base - (round * 18)) * 0.05;
      // Defense penalty — calibrated to UPS history (see tune table above).
      // Scaled DOWN slightly when the owner is a known defense-heavy drafter.
      let defPenalty = 0;
      if (_isDefensePos(pos)) {
        defPenalty = tune.defPenalty * (isDefenseOwner ? 0.6 : 1.0);
        if (tookDefenseThisRound) defPenalty += tune.sameRoundDefPenalty;
      }
      const score = base + reachPenalty + defPenalty - posBonus - sideBonus;
      return { p, score };
    }).sort((a, b) => a.score - b.score);

    // ── Tier sampling ─────────────────────────────────────────────────
    // Walk the score-sorted list and split into tiers using the prospect's
    // continuous rookie_adp value (much better signal than the integer-spaced
    // consensus_rank — Love 1.46, Tate 3.70, Tyson 5.55 vs Price 6.18 / Lemon
    // 6.34 / Mendoza 6.54 form natural tiers there). Falls back to the
    // computed score gap when ADP isn't available.
    const _adpOf = (item) => {
      const v = Number(item.p.rookie_adp);
      return Number.isFinite(v) && v > 0 ? v : null;
    };
    const tiers = [[scored[0]]];
    for (let i = 1; i < Math.min(scored.length, 12); i++) {
      const prev = scored[i - 1];
      const cur = scored[i];
      const adpPrev = _adpOf(prev);
      const adpCur = _adpOf(cur);
      const adpGap = (adpPrev != null && adpCur != null) ? (adpCur - adpPrev) : null;
      const scoreGap = cur.score - prev.score;
      // Use ADP gap when both have it; else fall back to score gap. Threshold
      // is tune.tierGap interpreted in the units of whichever signal we're using.
      const gap = (adpGap != null) ? adpGap : scoreGap;
      if (gap > tune.tierGap) tiers.push([cur]);
      else tiers[tiers.length - 1].push(cur);
    }
    let currentTier = tiers[0];
    if (tiers.length > 1 && Math.random() < tune.tierBleed) {
      currentTier = tiers[1];  // reach into the next tier
    }
    if (currentTier.length === 1) return currentTier[0].p;
    // Within tier: weight by inverse position (best ~50%, then ~25%, ~17%, ...)
    const weights = currentTier.map((_, i) => 1 / (i + 1));
    const sum = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * sum;
    for (let i = 0; i < currentTier.length; i++) {
      r -= weights[i];
      if (r <= 0) return currentTier[i].p;
    }
    return currentTier[0].p;
  }

  function _autoSimRecordPick(slot, prospect, by) {
    if (!STATE.live) return;
    if (!Array.isArray(STATE.live.picks_made)) STATE.live.picks_made = [];
    if (!prospect || !prospect.player_id) {
      console.error("[draft] refusing to record pick — missing prospect.player_id", { slot, prospect, by });
      return;
    }
    const pid = String(prospect.player_id);
    // HARD GUARD — never let the same player_id be drafted twice. Bails with
    // a console error + toast so the underlying caller bug is visible instead
    // of silently corrupting the board.
    const existing = STATE.live.picks_made.find(p => String(p.player_id) === pid);
    if (existing) {
      console.error("[draft] BLOCKED duplicate pick — player_id already drafted", {
        player_id: pid,
        name: prospect.name,
        existing_at: `${existing.round}.${existing.pick}`,
        existing_by: existing.franchise_id,
        attempted_at: `${slot.round}.${slot.pick}`,
        attempted_by: slot.franchise_id,
        attempted_via: by,
      });
      showToast(`⚠ ${prospect.name || "Player"} is already drafted at ${existing.round}.${String(existing.pick).padStart(2,"0")} — pick blocked.`, "err");
      return;
    }
    // Same-slot guard — never allow two picks at the same round.slot.
    const slotTaken = STATE.live.picks_made.find(p =>
      Number(p.round) === Number(slot.round) && Number(p.pick) === Number(slot.pick));
    if (slotTaken) {
      console.error("[draft] BLOCKED duplicate slot — slot already filled", { slot, slotTaken, by });
      showToast(`⚠ Slot ${slot.round}.${String(slot.pick).padStart(2,"0")} already filled.`, "err");
      return;
    }
    STATE.live.picks_made.push({
      round: slot.round,
      pick: slot.pick,
      franchise_id: slot.franchise_id,
      player_id: pid,
      timestamp: new Date().toISOString(),
      comments: by === "engine" ? "[sim]" : "[sim-user]",
    });
    // Advance active_pick to next slot
    const next = _autoSimNextSlot();
    STATE.live.active_pick = next || null;
    // SIM clock: stamp now so the next slot's countdown starts from this
    // moment. (LIVE clock comes from MFL's pick timestamp via the poller.)
    _pickClockEnsureStarted();
    AUTO_SIM.history.push({
      round: slot.round, pick: slot.pick, fid: slot.franchise_id,
      player_id: pid, name: prospect.name, by,
    });
    renderLive();
    renderPickClock();
  }

  // ── Apply a simulated trade to local STATE.live.draft_order ─────────
  // For SIM trades, mutate the in-memory draft state so the board (and the
  // auto-sim engine) immediately reflect pick swaps. Player swaps and future-
  // pick rebadging are tracked in STATE.live._sim_player_swaps and
  // STATE.live._sim_future_picks for downstream display only — the rookie
  // hub doesn't render rosters so player swaps are noted but not visualised.
  // Returns { swappedCount } for the caller's success message.
  function _applySimTradeToState(giveBasket, receiveBasket, myFid, partnerFid) {
    if (!STATE.live || !Array.isArray(STATE.live.draft_order)) return { swappedCount: 0 };
    const order = STATE.live.draft_order;
    let swapped = 0;
    // Picks YOU give → reassign from myFid to partnerFid
    for (const a of giveBasket) {
      if (a.kind === "dp" || a.kind === "pick") {
        // asset_id format: DP_<year>_<round>_<slot>
        const m = String(a.asset_id || "").match(/^DP_\d+_(\d+)_(\d+)$/);
        if (!m) continue;
        const r = Number(m[1]), s = Number(m[2]);
        const entry = order.find(o => Number(o.round) === r && Number(o.pick) === s);
        if (entry && String(entry.owned_by_franchise_id) === String(myFid)) {
          entry.owned_by_franchise_id = partnerFid;
          swapped += 1;
        }
      }
      // Future picks tracked separately (no current draft_order impact)
      if (a.kind === "fp") {
        STATE.live._sim_future_pick_moves = STATE.live._sim_future_pick_moves || [];
        STATE.live._sim_future_pick_moves.push({ from: myFid, to: partnerFid, asset_id: a.asset_id });
      }
      // Player swaps recorded for the trade-history record but rosters
      // aren't rendered here — mark for future-pickup-display.
      if (a.kind === "player" && a.player_id) {
        STATE.live._sim_player_swaps = STATE.live._sim_player_swaps || [];
        STATE.live._sim_player_swaps.push({
          from: myFid, to: partnerFid,
          player_id: a.player_id, display: a.display,
          extension_term: a.extension_term || "",
        });
      }
    }
    // Picks YOU receive → reassign from partnerFid to myFid
    for (const a of receiveBasket) {
      if (a.kind === "dp" || a.kind === "pick") {
        const m = String(a.asset_id || "").match(/^DP_\d+_(\d+)_(\d+)$/);
        if (!m) continue;
        const r = Number(m[1]), s = Number(m[2]);
        const entry = order.find(o => Number(o.round) === r && Number(o.pick) === s);
        if (entry && String(entry.owned_by_franchise_id) === String(partnerFid)) {
          entry.owned_by_franchise_id = myFid;
          swapped += 1;
        }
      }
      if (a.kind === "fp") {
        STATE.live._sim_future_pick_moves = STATE.live._sim_future_pick_moves || [];
        STATE.live._sim_future_pick_moves.push({ from: partnerFid, to: myFid, asset_id: a.asset_id });
      }
      if (a.kind === "player" && a.player_id) {
        STATE.live._sim_player_swaps = STATE.live._sim_player_swaps || [];
        STATE.live._sim_player_swaps.push({
          from: partnerFid, to: myFid,
          player_id: a.player_id, display: a.display,
          extension_term: a.extension_term || "",
        });
      }
    }
    if (swapped) {
      // Recompute active_pick — it's now whoever owns the next unmade slot.
      STATE.live.active_pick = _autoSimNextSlot();
      _pickClockEnsureStarted();
      renderLive();
      renderPickClock();
    }
    return { swappedCount: swapped };
  }

  // ── Revert / undo a pick ────────────────────────────────────────────
  // SIM mode: anyone can revert (it's local state).
  // LIVE mode: commissioner only — and we warn that MFL must be manually
  // corrected too (MFL has no clean draftResults undo API).
  function _canRevert() {
    if (STATE.simulationMode) return true;
    return !!(STATE.me && STATE.me.is_commish);
  }

  function _findPickAt(round, slot) {
    const made = (STATE.live && STATE.live.picks_made) || [];
    return made.find(p => Number(p.round) === Number(round) && Number(p.pick) === Number(slot)) || null;
  }

  function openRevertModal(round, slot) {
    if (!_canRevert()) {
      showToast("Only the commissioner can revert picks in LIVE mode.", "err");
      return;
    }
    const pick = _findPickAt(round, slot);
    if (!pick) return;
    const slotLabel = `${round}.${String(slot).padStart(2, "0")}`;
    const fname = (STATE.live.franchises && STATE.live.franchises[pick.franchise_id]) || pick.franchise_id;
    const playerName = playerLookup(pick.player_id) || `Player #${pick.player_id}`;
    // Count picks made AFTER this one
    const made = STATE.live.picks_made || [];
    const laterPicks = made.filter(p => {
      if (Number(p.round) > round) return true;
      if (Number(p.round) === round && Number(p.pick) > slot) return true;
      return false;
    });
    const isSim = !!STATE.simulationMode;
    const liveWarning = !isSim
      ? `<div style="background:rgba(239,68,68,0.10); border-left:3px solid var(--err); padding:8px 12px; border-radius:4px; margin:10px 0; font-size:12px;">
          <strong style="color:var(--err);">⚠ LIVE MODE</strong> — this clears the pick from the hub state only. You must <strong>also</strong> remove it manually from MFL admin tools (Commish → Edit Draft Results). The Discord channel will NOT be updated automatically.
        </div>` : "";
    const laterWarning = laterPicks.length
      ? `<div style="background:rgba(251,191,36,0.10); border-left:3px solid var(--warn); padding:8px 12px; border-radius:4px; margin:10px 0; font-size:12px; color:var(--text);">
          <strong style="color:var(--warn);">⚠ ${laterPicks.length} pick${laterPicks.length === 1 ? '' : 's'} made after this one.</strong>
          Reverting only this pick will leave the slot ${slotLabel} as a hole — the on-the-clock cursor stays at whatever's next in draft order.
        </div>` : "";
    openModal(`
      <h3>Revert Pick · ${escapeHtml(slotLabel)}</h3>
      <p style="font-size:14px; line-height:1.6;">
        Remove <strong>${escapeHtml(playerName)}</strong> from <strong>${escapeHtml(fname)}</strong> at <strong>${escapeHtml(slotLabel)}</strong>?
      </p>
      ${liveWarning}
      ${laterWarning}
      <div class="actions">
        <button class="btn secondary" type="button" onclick="document.getElementById('rdh-modal-overlay').classList.remove('open')">Cancel</button>
        ${laterPicks.length ? `<button class="btn warn" id="revert-cascade" type="button">Revert this + ${laterPicks.length} after</button>` : ""}
        <button class="btn danger" id="revert-just-this" type="button">Revert this pick</button>
      </div>
    `);
    document.getElementById("revert-just-this").addEventListener("click", () => _revertPick(round, slot, false));
    const cascadeBtn = document.getElementById("revert-cascade");
    if (cascadeBtn) cascadeBtn.addEventListener("click", () => _revertPick(round, slot, true));
  }

  function _revertPick(round, slot, cascade) {
    if (!_canRevert()) return;
    const made = (STATE.live && STATE.live.picks_made) || [];
    const before = made.length;
    STATE.live.picks_made = made.filter(p => {
      const pr = Number(p.round), ps = Number(p.pick);
      if (cascade) {
        // remove this slot AND anything later
        if (pr > round) return false;
        if (pr === round && ps >= slot) return false;
        return true;
      }
      // remove just this slot
      return !(pr === round && ps === slot);
    });
    const removed = before - STATE.live.picks_made.length;
    // Restore active_pick to the earliest unmade slot in draft_order
    STATE.live.active_pick = _autoSimNextSlot();
    // Revert resets the clock — the on-clock owner is now somebody new
    // (or somebody re-getting the slot), so the timer should restart.
    STATE.activePickClockKey = null;
    _pickClockEnsureStarted();
    // Also drop matching entries from the auto-sim history log
    if (Array.isArray(AUTO_SIM.history)) {
      AUTO_SIM.history = AUTO_SIM.history.filter(h => {
        const hr = Number(h.round), hs = Number(h.pick);
        if (cascade) return !(hr > round || (hr === round && hs >= slot));
        return !(hr === round && hs === slot);
      });
    }
    document.getElementById("rdh-modal-overlay").classList.remove("open");
    renderLive();
    const slotLabel = `${round}.${String(slot).padStart(2, "0")}`;
    showToast(
      cascade
        ? `↶ Reverted ${removed} pick${removed === 1 ? '' : 's'} from ${slotLabel} onward`
        : `↶ Reverted pick ${slotLabel}`,
      "ok"
    );
  }

  function _autoSimUiSetState(state) {
    const el = document.getElementById("auto-sim-status");
    if (!el) return;
    el.dataset.state = state;
    el.textContent = ({
      idle: "Idle",
      running: "Running",
      paused: "Paused",
      userTurn: "Your pick",
      complete: "Draft complete",
    })[state] || state;
    document.getElementById("auto-sim-start").hidden = state !== "idle" && state !== "complete" && state !== "userTurn";
    document.getElementById("auto-sim-pause").hidden = state !== "running";
    document.getElementById("auto-sim-resume").hidden = state !== "paused" && state !== "userTurn";
    document.getElementById("auto-sim-tick").hidden = state !== "running";
  }

  function _autoSimUserOnClock() {
    const slot = STATE.live && STATE.live.active_pick;
    if (!slot) return false;
    return AUTO_SIM.playAsFid && String(slot.franchise_id) === String(AUTO_SIM.playAsFid);
  }

  function _autoSimTick() {
    if (!AUTO_SIM.running || AUTO_SIM.paused) return;
    const slot = STATE.live && STATE.live.active_pick;
    if (!slot) {
      AUTO_SIM.running = false;
      _autoSimUiSetState("complete");
      showToast("Draft simulation complete", "ok");
      return;
    }
    if (_autoSimUserOnClock()) {
      AUTO_SIM.paused = true;
      _autoSimUiSetState("userTurn");
      showToast(`You're up at R${slot.round}.${String(slot.pick).padStart(2,"0")} — make your pick or hit Resume to auto-sim it.`, "ok");
      return;
    }
    const prospect = _autoSimChoosePick(slot.franchise_id, slot.round);
    if (!prospect) {
      AUTO_SIM.running = false;
      _autoSimUiSetState("complete");
      showToast("No more eligible prospects — sim ended.", "err");
      return;
    }
    _autoSimRecordPick(slot, prospect, "engine");
    _autoSimSchedule();
  }

  // On-screen popup banner for user-initiated trades — slides in from the top
  // of the live tab, auto-dismisses after 8s. Source labels:
  //   'sim-user' = user just simulated a trade (proposed + accepted)
  //   'live'     = real MFL trade went through
  function showTradePopup({ fromName, toName, fromGives, toGives, source }) {
    const old = document.querySelector(".trade-popup");
    if (old) old.remove();
    const tag = source === "live" ? "TRADE" : "SIM TRADE";
    const popup = document.createElement("div");
    popup.className = "trade-popup" + (source === "live" ? " is-live" : "");
    popup.innerHTML = `
      <div class="trade-popup-tag">🔄 ${tag}</div>
      <div class="trade-popup-body">
        <div class="trade-popup-row">
          <strong>${escapeHtml(fromName)}</strong>
          <span class="trade-popup-arrow">→</span>
          <span class="trade-popup-asset">${escapeHtml(fromGives)}</span>
        </div>
        <div class="trade-popup-row">
          <strong>${escapeHtml(toName)}</strong>
          <span class="trade-popup-arrow">→</span>
          <span class="trade-popup-asset">${escapeHtml(toGives)}</span>
        </div>
      </div>
      <button class="trade-popup-close" type="button" aria-label="Dismiss">✕</button>
    `;
    document.body.appendChild(popup);
    popup.querySelector(".trade-popup-close").addEventListener("click", () => popup.remove());
    setTimeout(() => { try { popup.remove(); } catch (e) {} }, 8000);
  }

  function _autoSimSchedule() {
    clearTimeout(AUTO_SIM.timer);
    cancelAnimationFrame(AUTO_SIM.tickRaf);
    if (!AUTO_SIM.running || AUTO_SIM.paused) return;
    if (AUTO_SIM.speedMs <= 0) {
      AUTO_SIM.timer = setTimeout(_autoSimTick, 0);
      return;
    }
    AUTO_SIM.tickStart = performance.now();
    const tick = document.getElementById("auto-sim-ticker");
    const fill = document.getElementById("auto-sim-bar-fill");
    const slot = STATE.live && STATE.live.active_pick;
    if (slot) {
      const fname = (STATE.live.franchises && STATE.live.franchises[slot.franchise_id]) || slot.franchise_id;
      tick.textContent = `Next: R${slot.round}.${String(slot.pick).padStart(2,"0")} · ${fname}`;
    }
    function paint() {
      if (!AUTO_SIM.running || AUTO_SIM.paused) return;
      const elapsed = performance.now() - AUTO_SIM.tickStart;
      const pct = Math.min(100, (elapsed / AUTO_SIM.speedMs) * 100);
      if (fill) fill.style.width = pct + "%";
      if (pct < 100) AUTO_SIM.tickRaf = requestAnimationFrame(paint);
    }
    AUTO_SIM.tickRaf = requestAnimationFrame(paint);
    AUTO_SIM.timer = setTimeout(_autoSimTick, AUTO_SIM.speedMs);
  }

  function _autoSimStart() {
    const playAs = document.getElementById("auto-sim-play-as");
    AUTO_SIM.playAsFid = playAs && playAs.value || null;
    const speed = document.getElementById("auto-sim-speed");
    AUTO_SIM.speedMs = Math.max(0, Number(speed && speed.value) || 10000);
    AUTO_SIM.running = true;
    AUTO_SIM.paused = false;
    _autoSimUiSetState("running");
    _autoSimSchedule();
  }
  function _autoSimPause() {
    AUTO_SIM.paused = true;
    clearTimeout(AUTO_SIM.timer);
    cancelAnimationFrame(AUTO_SIM.tickRaf);
    _autoSimUiSetState("paused");
  }
  function _autoSimResume() {
    if (!AUTO_SIM.running) { _autoSimStart(); return; }
    AUTO_SIM.paused = false;
    _autoSimUiSetState("running");
    _autoSimSchedule();
  }
  function _autoSimStep() {
    if (!AUTO_SIM.running) {
      const playAs = document.getElementById("auto-sim-play-as");
      AUTO_SIM.playAsFid = playAs && playAs.value || null;
      AUTO_SIM.running = true;
    }
    AUTO_SIM.paused = true;  // step then halt
    clearTimeout(AUTO_SIM.timer);
    const slot = STATE.live && STATE.live.active_pick;
    if (!slot) { _autoSimUiSetState("complete"); return; }
    if (_autoSimUserOnClock()) {
      // Respect "play as" — Step never picks for your franchise.
      _autoSimUiSetState("userTurn");
      showToast("Your franchise is on the clock — make the pick yourself or change 'Play as'.", "ok");
      return;
    }
    const prospect = _autoSimChoosePick(slot.franchise_id, slot.round);
    if (prospect) _autoSimRecordPick(slot, prospect, "engine");
    _autoSimUiSetState("paused");
  }
  function _autoSimReset() {
    if (AUTO_SIM.running && !confirm("Stop the running sim and clear all simulated picks?")) return;
    AUTO_SIM.running = false;
    AUTO_SIM.paused = false;
    clearTimeout(AUTO_SIM.timer);
    cancelAnimationFrame(AUTO_SIM.tickRaf);
    AUTO_SIM.history = [];
    if (STATE.live) {
      STATE.live.picks_made = [];
      STATE.live.active_pick = _autoSimNextSlot();
      STATE.activePickClockKey = null;
      _pickClockEnsureStarted();
    }
    _autoSimUiSetState("idle");
    renderLive();
    renderPickClock();
    showToast("Sim reset — board cleared", "ok");
  }

  function _autoSimWire() {
    const playAs = document.getElementById("auto-sim-play-as");
    if (!playAs) return;
    // Populate Play-as dropdown from live franchises
    const franchises = (STATE.live && STATE.live.franchises) || {};
    const options = Object.entries(franchises).sort((a, b) => a[1].localeCompare(b[1]))
      .map(([id, name]) => `<option value="${id}">${name} (${id})</option>`).join("");
    playAs.innerHTML = options;
    if (STATE.me && STATE.me.franchise_id) playAs.value = STATE.me.franchise_id;
    AUTO_SIM.playAsFid = playAs.value;
    playAs.addEventListener("change", () => {
      AUTO_SIM.playAsFid = playAs.value;
      // If the user just switched to the on-clock franchise, pause.
      if (AUTO_SIM.running && _autoSimUserOnClock()) {
        AUTO_SIM.paused = true;
        clearTimeout(AUTO_SIM.timer);
        _autoSimUiSetState("userTurn");
      }
    });
    document.getElementById("auto-sim-start").addEventListener("click", _autoSimStart);
    document.getElementById("auto-sim-pause").addEventListener("click", _autoSimPause);
    document.getElementById("auto-sim-resume").addEventListener("click", _autoSimResume);
    document.getElementById("auto-sim-step").addEventListener("click", _autoSimStep);
    document.getElementById("auto-sim-reset").addEventListener("click", _autoSimReset);
    // Pause-on-modal — when any modal is open, pause the sim; resume when closed.
    const overlay = document.getElementById("rdh-modal-overlay");
    if (overlay) {
      const obs = new MutationObserver(() => {
        const isOpen = overlay.classList.contains("open");
        if (isOpen && AUTO_SIM.running && !AUTO_SIM.paused) {
          AUTO_SIM.pausedByModal = true;
          AUTO_SIM.paused = true;
          clearTimeout(AUTO_SIM.timer);
          cancelAnimationFrame(AUTO_SIM.tickRaf);
          _autoSimUiSetState("paused");
        } else if (!isOpen && AUTO_SIM.pausedByModal && AUTO_SIM.running) {
          AUTO_SIM.pausedByModal = false;
          AUTO_SIM.paused = false;
          _autoSimUiSetState("running");
          _autoSimSchedule();
        }
      });
      obs.observe(overlay, { attributes: true, attributeFilter: ["class"] });
    }
    _autoSimUiSetState("idle");
  }

  // Hook the "Submit Pick" button when the user makes their own pick during
  // an auto-sim — record it locally (in addition to the worker call) so the
  // sim resumes from the correct state.
  const _origOpenPickConfirmModal = openPickConfirmModal;
  openPickConfirmModal = function (active, prospect) {
    _origOpenPickConfirmModal(active, prospect);
    const goBtn = document.getElementById("confirm-pick-go");
    if (!goBtn) return;
    goBtn.addEventListener("click", () => {
      // Always record locally for sim continuity (worker call is a no-op in simulate mode).
      if (AUTO_SIM.running || STATE.simulationMode) {
        const slot = { round: active.round, pick: active.pick, franchise_id: active.franchise_id || active.owned_by_franchise_id };
        _autoSimRecordPick(slot, prospect, "user");
        if (AUTO_SIM.running) {
          AUTO_SIM.paused = false;
          _autoSimUiSetState("running");
          setTimeout(() => {
            document.getElementById("rdh-modal-overlay").classList.remove("open");
            _autoSimSchedule();
          }, 400);
        }
      }
    }, { once: true });
  };

  function _wireInbox() {
    const refreshBtn = document.getElementById("trade-inbox-refresh");
    if (refreshBtn) refreshBtn.addEventListener("click", () => {
      if (STATE.simulationMode) {
        showToast("Inbox is live-mode only — propose your own trade in sim instead.", "ok");
      } else {
        _inboxPollOnce();
      }
    });
    _refreshInboxVisibility();
    _inboxRender();
    if (!STATE.simulationMode) _inboxStartPolling();
  }

  // Hide the inbox card entirely in simulate mode — synthetic offers were
  // unrealistic and noisy; the user can propose their own trades to test the
  // flow. The card returns automatically when flipping to LIVE.
  function _refreshInboxVisibility() {
    const card = document.getElementById("trade-inbox-card");
    if (!card) return;
    card.hidden = !!STATE.simulationMode;
  }

  loadAll().then(() => { _autoSimWire(); _wireInbox(); }).catch(err => {
    console.error(err);
    document.getElementById("rdh-meta").textContent = "Failed to load data — check console.";
  });
})();
