/* UPS Mobile — Rookie Draft (commish-capable).
   Lets ANY owner watch the live draft on mobile. The COMMISH can submit
   picks on behalf of whichever franchise is on the clock — same authority
   as the desktop hub. Built for Keith 2026-05-24 (night-of draft).

   Data sources:
     - /api/draft-state?fresh=1   → MFL on-the-clock + filled slots
     - /api/draft-status          → server-backed shared LIVE flag
     - rookies/rookie_prospects_2026.json → prospect catalog (CDN)

   Submit:
     - POST /api/pick {franchise_id, player_id, simulate:false}
*/
(function () {
  "use strict";

  // GitHub Pages serves the `site/` directory at the repo root URL, so the
  // prospects JSON lives at /rookies/rookie_prospects_2026.json (NOT
  // /site/rookies/...). Verified 2026-05-24.
  var ROOKIE_PROSPECTS_GHPAGES = "https://keithcreelman.github.io/upsmflproduction/rookies/rookie_prospects_2026.json";
  // When served from the mobile site itself the JSON is sibling — use a
  // relative path first, fall back to the CDN URL if the relative 404s
  // (e.g. when mobile is hosted from MFL HPM and the rookies/ tree isn't
  // alongside the mobile assets).
  var ROOKIE_PROSPECTS_RELATIVE = "../rookies/rookie_prospects_2026.json";

  var state = {
    prospects: [],       // [{player_id, name, position, nfl_team, rookie_adp, ...}]
    draftState: null,    // {franchises, draft_order, picks_made, active_pick, meta}
    serverLive: false,   // /api/draft-status
    posFilter: "ALL",
    search: "",
    loading: false,
    submitting: false,
    pollTimer: null,
  };

  function api() {
    var M = window.UPS_MOBILE || {};
    return (M.api && M.api.workerBase && M.api.workerBase()) || "https://upsmflproduction.keith-creelman.workers.dev";
  }
  function leagueId() {
    var M = window.UPS_MOBILE || {};
    return (M.state && M.state.ctx && M.state.ctx.leagueId) || "74598";
  }
  function escapeHtml(v) {
    return (window.UPS_MOBILE && window.UPS_MOBILE.util && window.UPS_MOBILE.util.escapeHtml(v)) || String(v || "");
  }
  function showToast(text, kind) {
    var el = document.getElementById("ups-m-toast");
    if (!el) return;
    el.textContent = text;
    el.className = "ups-m-toast show " + (kind || "");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () {
      el.className = "ups-m-toast " + (kind || "");
    }, 2400);
  }

  function isCommish() {
    // Mobile has no /api/me wiring yet — defer to URL override (?commish=1)
    // OR the same fid allowlist the desktop hub uses (0000/0001/0008).
    try {
      var qs = new URLSearchParams(window.location.search);
      if (qs.get("commish") === "1" || qs.get("commish") === "true") return true;
    } catch (e) {}
    var M = window.UPS_MOBILE || {};
    var fid = (M.state && M.state.viewerFranchiseId) || "";
    return fid === "0000" || fid === "0001" || fid === "0008";
  }

  // ── Data loaders ────────────────────────────────────────────────────
  function loadProspects() {
    if (state.prospects.length) return Promise.resolve(state.prospects);
    function fetchFrom(url) {
      return fetch(url, { cache: "no-store" })
        .then(function (r) {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.json();
        });
    }
    // Try same-origin relative first (works when mobile is co-hosted), then
    // fall back to GitHub Pages absolute (works from MFL HPM iframe).
    return fetchFrom(ROOKIE_PROSPECTS_RELATIVE)
      .catch(function () { return fetchFrom(ROOKIE_PROSPECTS_GHPAGES); })
      .then(function (data) {
        state.prospects = (data && data.prospects) || [];
        return state.prospects;
      });
  }

  function loadDraftState(fresh) {
    var url = api() + "/api/draft-state?L=" + encodeURIComponent(leagueId()) + (fresh ? "&fresh=1" : "");
    return fetch(url, { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (data) { state.draftState = data; return data; });
  }

  function loadDraftStatus() {
    var url = api() + "/api/draft-status?L=" + encodeURIComponent(leagueId());
    return fetch(url, { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : { live: false }; })
      .then(function (data) { state.serverLive = !!(data && data.live); return data; })
      .catch(function () { return { live: false }; });
  }

  // ── Rendering ───────────────────────────────────────────────────────
  function renderHeader() {
    var ds = state.draftState || {};
    var active = ds.active_pick;
    var liveMode = state.serverLive || (ds.picks_made && ds.picks_made.length > 0);
    var modeBadge = liveMode
      ? '<span class="ups-m-draft-mode live">🔴 LIVE</span>'
      : '<span class="ups-m-draft-mode sim">🟡 SIMULATE</span>';
    var commishBadge = isCommish() ? '<span class="ups-m-draft-commish">COMMISH</span>' : '';
    var onClock = active
      ? 'Pick <strong>' + active.round + '.' + String(active.pick).padStart(2, "0") + '</strong> · ' +
        escapeHtml((ds.franchises && ds.franchises[active.franchise_id]) || active.franchise_id || "—")
      : (ds.picks_made && ds.picks_made.length ? "Draft complete" : "Draft not started");
    var progress = ds.meta
      ? '<div class="ups-m-draft-progress">' + (ds.meta.n_picks_made || 0) + ' / ' + (ds.meta.n_picks_total || 0) + ' picks</div>'
      : '';
    return '' +
      '<div class="ups-m-draft-header">' +
        '<div class="ups-m-draft-meta">' + modeBadge + commishBadge +
          '<button class="ups-m-resync" id="ups-m-draft-resync" title="Re-pull MFL state">↻</button>' +
        '</div>' +
        '<div class="ups-m-draft-onclock">' + onClock + '</div>' +
        progress +
      '</div>';
  }

  function renderFilters() {
    var positions = ["ALL", "QB", "RB", "WR", "TE"];
    var pills = positions.map(function (p) {
      return '<button class="ups-m-pos-pill' + (state.posFilter === p ? " active" : "") + '" data-pos="' + p + '">' + p + '</button>';
    }).join("");
    return '' +
      '<div class="ups-m-draft-filters">' +
        '<input type="search" class="ups-m-search" id="ups-m-draft-search" placeholder="Search by name or college…" value="' + escapeHtml(state.search) + '">' +
        '<div class="ups-m-pos-row">' + pills + '</div>' +
      '</div>';
  }

  function availableProspects() {
    var ds = state.draftState || {};
    var taken = {};
    (ds.picks_made || []).forEach(function (p) { taken[String(p.player_id)] = true; });
    var q = state.search.trim().toLowerCase();
    return state.prospects.filter(function (p) {
      if (taken[String(p.player_id)]) return false;
      if (state.posFilter !== "ALL" && (p.position || "").toUpperCase() !== state.posFilter) return false;
      if (q) {
        var hay = ((p.name || "") + " " + (p.college || "") + " " + (p.nfl_team || "")).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    }).sort(function (a, b) {
      var ar = a.rookie_adp_rank || 9999;
      var br = b.rookie_adp_rank || 9999;
      return ar - br;
    });
  }

  function renderProspects() {
    var rows = availableProspects().slice(0, 80).map(function (p) {
      var name = (p.name || "").includes(",")
        ? p.name.split(",").reverse().map(function (s) { return s.trim(); }).join(" ")
        : p.name;
      var sub = (p.position || "") + (p.nfl_team ? " · " + p.nfl_team : "") + (p.college ? " · " + p.college : "");
      var adpBit = p.rookie_adp ? '<span class="ups-m-prospect-adp">ADP ' + p.rookie_adp.toFixed(1) + '</span>' : '';
      return '<button class="ups-m-prospect-row" data-pid="' + escapeHtml(p.player_id) + '">' +
        '<div class="ups-m-prospect-name">' + escapeHtml(name) + '</div>' +
        '<div class="ups-m-prospect-sub">' + escapeHtml(sub) + '</div>' +
        adpBit +
      '</button>';
    }).join("");
    if (!rows) rows = '<div class="ups-m-stub"><div>No prospects match.</div></div>';
    return '<div class="ups-m-prospect-list">' + rows + '</div>';
  }

  function renderConfirmSheet(prospect) {
    var ds = state.draftState || {};
    var active = ds.active_pick;
    if (!active) return;
    var fname = (ds.franchises && ds.franchises[active.franchise_id]) || active.franchise_id;
    var slot = active.round + "." + String(active.pick).padStart(2, "0");
    var name = (prospect.name || "").includes(",")
      ? prospect.name.split(",").reverse().map(function (s) { return s.trim(); }).join(" ")
      : prospect.name;
    var commish = isCommish();
    var canSubmit = commish; // mobile owner-self-pick not yet wired
    var html = '' +
      '<div class="ups-m-sheet-backdrop" id="ups-m-draft-sheet-bd">' +
        '<div class="ups-m-sheet">' +
          '<div class="ups-m-sheet-title">Confirm Pick ' + escapeHtml(slot) + '</div>' +
          '<div class="ups-m-sheet-body">' +
            '<div><strong>' + escapeHtml(fname) + '</strong> selects</div>' +
            '<div class="ups-m-sheet-player">' + escapeHtml(name) + '</div>' +
            '<div class="ups-m-sheet-sub">' + escapeHtml((prospect.position || "") + (prospect.nfl_team ? " · " + prospect.nfl_team : "")) + '</div>' +
            (canSubmit
              ? '<div class="ups-m-sheet-warn">🔴 This will POST to MFL\'s live draft and announce in Discord.</div>'
              : '<div class="ups-m-sheet-warn">Owner-side submit isn\'t wired on mobile yet — ask the commish to submit, or use the desktop hub.</div>')
          + '</div>' +
          '<div class="ups-m-sheet-actions">' +
            '<button class="ups-m-btn-secondary" id="ups-m-draft-cancel">Cancel</button>' +
            (canSubmit
              ? '<button class="ups-m-btn-danger" id="ups-m-draft-submit">Submit Pick LIVE</button>'
              : '')
          + '</div>' +
        '</div>' +
      '</div>';
    var mount = document.getElementById("ups-m-sheet-mount");
    mount.innerHTML = html;
    document.getElementById("ups-m-draft-cancel").addEventListener("click", function () { mount.innerHTML = ""; });
    document.getElementById("ups-m-draft-sheet-bd").addEventListener("click", function (e) {
      if (e.target.id === "ups-m-draft-sheet-bd") mount.innerHTML = "";
    });
    var submitBtn = document.getElementById("ups-m-draft-submit");
    if (submitBtn) {
      submitBtn.addEventListener("click", function () { submitPick(active, prospect, mount); });
    }
  }

  function submitPick(active, prospect, mount) {
    if (state.submitting) return;
    state.submitting = true;
    var btn = document.getElementById("ups-m-draft-submit");
    if (btn) { btn.disabled = true; btn.textContent = "Submitting…"; }
    var payload = {
      franchise_id: active.franchise_id,
      player_id: String(prospect.player_id),
      simulate: false,
    };
    fetch(api() + "/api/pick?L=" + encodeURIComponent(leagueId()), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        state.submitting = false;
        if (res.ok && res.data && res.data.ok) {
          showToast("✅ Pick submitted: " + (res.data.slot || ""), "ok");
          mount.innerHTML = "";
          // Force-fresh re-pull so the on-the-clock advances instantly.
          return loadDraftState(true).then(renderDraftView);
        }
        var err = (res.data && (res.data.error || res.data.mfl_response)) || ("HTTP " + (res.data && res.data.status));
        showToast("✗ " + String(err).slice(0, 120), "err");
        if (btn) { btn.disabled = false; btn.textContent = "Submit Pick LIVE"; }
      })
      .catch(function (e) {
        state.submitting = false;
        showToast("✗ " + (e && e.message || e), "err");
        if (btn) { btn.disabled = false; btn.textContent = "Submit Pick LIVE"; }
      });
  }

  // ── Top-level render + wire ─────────────────────────────────────────
  function renderDraftView() {
    var main = document.getElementById("ups-m-main");
    if (!main) return;
    if (state.loading) {
      main.innerHTML = '<div class="ups-m-loading">Loading draft…</div>';
      return;
    }
    if (!state.prospects.length || !state.draftState) {
      main.innerHTML = '<div class="ups-m-loading">Loading draft…</div>';
      return;
    }
    main.innerHTML = renderHeader() + renderFilters() + renderProspects();
    // Wire interactions
    var resync = document.getElementById("ups-m-draft-resync");
    if (resync) {
      resync.addEventListener("click", function () {
        resync.textContent = "…";
        Promise.all([loadDraftState(true), loadDraftStatus()])
          .then(function () { showToast("✓ Re-synced from MFL", "ok"); renderDraftView(); })
          .catch(function (e) { showToast("Re-sync failed: " + (e && e.message || e), "err"); });
      });
    }
    var search = document.getElementById("ups-m-draft-search");
    if (search) {
      var debouncer = null;
      search.addEventListener("input", function (e) {
        state.search = e.target.value || "";
        clearTimeout(debouncer);
        debouncer = setTimeout(function () { renderDraftView(); search.focus(); }, 120);
      });
    }
    document.querySelectorAll(".ups-m-pos-pill").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.posFilter = btn.getAttribute("data-pos") || "ALL";
        renderDraftView();
      });
    });
    document.querySelectorAll(".ups-m-prospect-row").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var pid = btn.getAttribute("data-pid");
        var p = state.prospects.find(function (x) { return String(x.player_id) === String(pid); });
        if (p) renderConfirmSheet(p);
      });
    });
  }

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(function () {
      Promise.all([loadDraftState(false), loadDraftStatus()])
        .then(renderDraftView)
        .catch(function () {});
    }, 7000);
  }
  function stopPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  function draftRoute(main) {
    main.innerHTML = '<div class="ups-m-loading">Loading draft…</div>';
    state.loading = true;
    Promise.all([loadProspects(), loadDraftState(true), loadDraftStatus()])
      .then(function () {
        state.loading = false;
        renderDraftView();
        startPolling();
      })
      .catch(function (e) {
        state.loading = false;
        main.innerHTML = '<div class="ups-m-error">Failed to load draft: ' + escapeHtml(e && e.message || String(e)) + '</div>';
      });
  }

  // Unregister polling when navigating away.
  window.addEventListener("hashchange", function () {
    var hash = (window.location.hash || "").replace(/^#/, "");
    if (hash.indexOf("draft") !== 0) stopPolling();
  });

  // Register with the mobile shell once it's booted.
  function register() {
    var M = window.UPS_MOBILE;
    if (!M || !M.route || !M.route.registerView) {
      return setTimeout(register, 20);
    }
    M.route.registerView("draft", draftRoute);
  }
  register();
})();
