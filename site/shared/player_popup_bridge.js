/*!
 * player_popup_bridge.js — replaces TOS's player popup with UPS_openPlayerProfile
 * Stage 4 of docs/mfl_native/tos_removal_plan.md
 *
 * TOS's header.js ships a draggable player-card popup that opens whenever a
 * user clicks any <a class="position_XX_PID"> across MFL native pages. We
 * already have a much richer modal (player_profile_master.js → UPS_openPlayerProfile).
 * This bridge installs a delegated click handler that catches MFL's player
 * links and routes them into our modal instead.
 *
 * Behind UPS_USE_NATIVE_PLAYER_POPUP. While the flag is false the bridge is
 * dormant and TOS's popup keeps working. Stage 5 flips the flag AND sets
 * load_popup=false to prevent double-popup conflicts.
 *
 * Per §5 Q13: KEEP the login icon for anonymous viewers. The bridge does NOT
 * suppress that — TOS's login-icon injection is in header.js's mobile menu
 * code path, not the popup path.
 *
 * Player-link detection patterns (any of these triggers the bridge):
 *   a[class*="position_"]        — MFL's standard CSS class scheme (position_07_1234)
 *   a[data-player-id]            — explicit data attr (used by our own HPM modules)
 *   a[href*="playerprofile?"]    — direct profile links
 *   a[href*="PLAYER_ID="]        — query-param style links (?L=...&PLAYER_ID=1234)
 *
 * Ignored:
 *   - Modifier-key clicks (cmd/ctrl/shift) — user wants to open in new tab
 *   - Right-click / aux clicks
 *   - Links inside our own iframes (Front Office / CCC etc.) — they bring their own modal
 */
(function (root) {
  "use strict";
  if (!root || !root.document) return;
  if (root.__UPS_PLAYER_POPUP_BRIDGE_INSTALLED__) return;

  if (typeof root.UPS_USE_NATIVE_PLAYER_POPUP === "undefined") {
    root.UPS_USE_NATIVE_PLAYER_POPUP = false;
  }

  // Install the listener regardless of flag — flag is re-checked per-click so
  // toggling at runtime (e.g. from a settings panel later) doesn't require a reload.
  root.__UPS_PLAYER_POPUP_BRIDGE_INSTALLED__ = true;

  function isFlagOn() { return root.UPS_USE_NATIVE_PLAYER_POPUP === true; }

  var WORKER_BASE =
    (typeof root.UPS_MOBILE_API_BASE === "string" && root.UPS_MOBILE_API_BASE) ||
    "https://upsmflproduction.keith-creelman.workers.dev";

  // The viewer's FRANCHISE id, resolved async via /api/me (the definitive
  // MFL_USER_ID→franchise map — same source the mobile app trusts first). This
  // is the reliable gate for showing action buttons; the sync cookie/global
  // sources in pageCtx are the immediate fallback for the very first click
  // before this resolves (~200ms after load).
  var __viewerFid = "";
  function resolveViewerFidAsync() {
    try {
      var uid = readCookie("MFL_USER_ID");
      if (!uid) return;
      fetch(WORKER_BASE + "/api/me?MFL_USER_ID=" + encodeURIComponent(uid), { mode: "cors", credentials: "omit" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { if (d && d.configured && d.franchise_id) __viewerFid = String(d.franchise_id); })
        .catch(function () {});
    } catch (e) {}
  }

  function readCookie(name) {
    var parts = (document.cookie || "").split(";");
    for (var i = 0; i < parts.length; i += 1) {
      var kv = parts[i].trim().split("=");
      if (kv[0] === name) return decodeURIComponent(kv[1] || "");
    }
    return "";
  }

  // Page-level context — most MFL native homepage emits these as inline globals.
  // We read defensively because the bridge may load on pages where MFL didn't
  // emit them (e.g. /options).
  function pageCtx() {
    var leagueId = "";
    var year = "";
    try {
      var u = new URL(root.location.href);
      leagueId = u.searchParams.get("L") || "";
      var m = String(u.pathname || "").match(/\/(\d{4})\/(home|options|lineup|add_drop|standings|ajax_ls)/);
      if (m && m[1]) year = m[1];
    } catch (e) {}
    if (!leagueId && root.league_id) leagueId = String(root.league_id);
    if (!year && root.year) year = String(root.year);
    // The VIEWER's franchise id, for the own-vs-not action gate. Resolve the
    // same way the mobile app does (app.js:894). CRUCIAL: MFL_USER_ID is a
    // USER id, NOT a franchise id — using it here made the ownership match
    // always fail (no Actions tab). The franchise id lives in
    // MFL_LAST_LOGIN_FRANCHISE_ID (set on login) / window.franchise_id / the
    // F= URL param. Digitless ⇒ leave empty ⇒ fail-safe (FO link, no writes).
    var viewerFranchiseId = __viewerFid || "";
    if (!viewerFranchiseId && root.franchise_id) viewerFranchiseId = String(root.franchise_id);
    if (!viewerFranchiseId) {
      var lastLogin = readCookie("MFL_LAST_LOGIN_FRANCHISE_ID");
      if (lastLogin) viewerFranchiseId = lastLogin;
    }
    if (!viewerFranchiseId) {
      try { var fq = u.searchParams.get("F") || u.searchParams.get("FRANCHISE_ID"); if (fq) viewerFranchiseId = fq; } catch (e2) {}
    }
    if (!/\d/.test(String(viewerFranchiseId))) viewerFranchiseId = "";
    return {
      apiBase: "",
      leagueId: leagueId,
      year: year,
      mode: "front_office",
      viewerFranchise: viewerFranchiseId ? { id: viewerFranchiseId, name: "" } : null
    };
  }

  // Extract player id from any of the supported link shapes. Returns "" if
  // we can't determine one — the bridge then falls through to default click
  // behavior (browser navigates the link, MFL handles it).
  function extractPid(a) {
    if (!a) return "";
    try {
      var dp = a.getAttribute && a.getAttribute("data-player-id");
      if (dp) return String(dp).replace(/\D/g, "");
    } catch (e) {}

    var cls = (a.className || "") + "";
    var m = cls.match(/(?:^|\s)position_[A-Za-z]+_(\d+)/);
    if (m && m[1]) return m[1];

    var href = a.getAttribute && a.getAttribute("href");
    if (href) {
      try {
        var u = new URL(href, root.location.href);
        var p = u.searchParams.get("PLAYER_ID") || u.searchParams.get("P") || u.searchParams.get("PID");
        if (p) return String(p).replace(/\D/g, "");
      } catch (e2) {}
    }
    return "";
  }

  // Walks up from event.target to the nearest anchor (links sometimes wrap a span/img).
  function closestAnchor(el) {
    while (el && el !== document.body) {
      if (el.tagName === "A") return el;
      el = el.parentNode;
    }
    return null;
  }

  function isPlayerLink(a) {
    if (!a) return false;
    var cls = (a.className || "") + "";
    if (/(?:^|\s)position_[A-Za-z]+_\d+/.test(cls)) return true;
    // STOCK MFL form (exposed by barebones — no TOS to translate): the player-
    // name link carries only a bare position color class (position_qb/_wr/_lb)
    // and links via  player?L=..&P=<digits> . extractPid already reads P=.
    if (/(?:^|\s)position_[a-z]{1,4}(?:\s|$)/i.test(cls)) return true;
    if (a.hasAttribute && a.hasAttribute("data-player-id")) return true;
    var href = a.getAttribute && a.getAttribute("href");
    if (!href) return false;
    if (/\/playerprofile\?/i.test(href)) return true;
    if (/[?&](PLAYER_ID|PID)=/i.test(href)) return true;
    if (/[?&]P=\d+(?:&|$)/.test(href)) return true;   // native player?..&P=NNN
    return false;
  }

  // Rosters cache so the popup can show the live contract strip (TCV/AAV/earned/
  // cap penalty). MFL native pages don't hand us a contract row, so we fetch the
  // league rosters once (same-origin) and look the player up by id on click.
  var __rostersCache = null, __rostersCacheKey = "", __rostersLoading = false;
  function loadRostersCache(leagueId, year) {
    var key = leagueId + ":" + year;
    if (!leagueId || !year || __rostersLoading || (__rostersCache && __rostersCacheKey === key)) return;
    __rostersLoading = true;
    var url = "/" + encodeURIComponent(year) + "/export?TYPE=rosters&L=" + encodeURIComponent(leagueId) + "&JSON=1";
    try {
      fetch(url, { credentials: "include" })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var out = {};
          var frs = d && d.rosters && d.rosters.franchise;
          frs = Array.isArray(frs) ? frs : (frs ? [frs] : []);
          for (var i = 0; i < frs.length; i++) {
            var pls = frs[i] && frs[i].player;
            pls = Array.isArray(pls) ? pls : (pls ? [pls] : []);
            for (var j = 0; j < pls.length; j++) {
              var pl = pls[j];
              var pid = String((pl && pl.id) || "").replace(/\D/g, "");
              if (pid) out[pid] = { id: pid, salary: pl.salary, contractInfo: pl.contractInfo,
                                    contractYear: pl.contractYear, contractStatus: pl.contractStatus, status: pl.status,
                                    // The OWNING franchise — needed to gate "can I act on YOUR players"
                                    // before showing write buttons. Was dropped here before.
                                    ownerFid: String((frs[i] && frs[i].id) || "") };
            }
          }
          __rostersCache = out; __rostersCacheKey = key;
        })
        .catch(function () {})
        .then(function () { __rostersLoading = false; });
    } catch (e) { __rostersLoading = false; }
  }

  function onClick(ev) {
    if (!isFlagOn()) return;
    if (ev.defaultPrevented) return;
    if (ev.button !== 0) return;
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;

    // Skip clicks inside iframes — they're handled by their own context.
    if (root.frameElement) return;

    var a = closestAnchor(ev.target);
    if (!a || !isPlayerLink(a)) return;

    var pid = extractPid(a);
    if (!pid) return;

    if (typeof root.UPS_openPlayerProfile !== "function") {
      // Profile module hasn't loaded yet (rare race). Fall through.
      return;
    }

    ev.preventDefault();
    ev.stopPropagation();

    var ctx = pageCtx();
    if (!ctx.year) ctx.year = String(new Date().getFullYear());
    ctx.viewerFranchiseId = ctx.viewerFranchise && ctx.viewerFranchise.id ? String(ctx.viewerFranchise.id) : "";
    var row = __rostersCache && __rostersCache[pid];
    if (row) ctx.contractSalary = row;       // live cap strip (TCV/AAV/earned/penalty)
    else loadRostersCache(ctx.leagueId, ctx.year);   // warm for next click

    // Real contract ACTIONS in the modal — only for a player the viewer OWNS
    // (mirrors RWB's isOwnRosterPlayer). player_actions_native.js is the "brain"
    // that renders the Actions-tab buttons and owns their clicks + submits.
    // FAIL SAFE: no confident owner match ⇒ no write buttons, just the Front
    // Office deep-link below.
    var pad4 = function (v) { return String(v || "").replace(/\D/g, "").padStart(4, "0").slice(-4); };
    var ownsPlayer = !!(row && ctx.viewerFranchiseId &&
      pad4(ctx.viewerFranchiseId) === pad4(row.ownerFid));
    // Diagnostic — tells you exactly why the Actions tab did/didn't show.
    try {
      console.log("[UPS][actions] pid=" + pid +
        " viewerFid=" + (ctx.viewerFranchiseId || "(none)") +
        " ownerFid=" + ((row && row.ownerFid) || "(no row — cache cold?)") +
        " owns=" + ownsPlayer +
        " brain=" + (typeof root.UPS_PLAYER_ACTIONS_NATIVE === "object"));
    } catch (e) {}
    if (ownsPlayer && typeof root.UPS_PLAYER_ACTIONS_NATIVE === "object" &&
        typeof root.UPS_PLAYER_ACTIONS_NATIVE.prepare === "function") {
      try {
        var linkText = (a && (a.textContent || "")).trim();
        ctx.__playerName = linkText || ("Player #" + pid);
        // Best-effort position for the brain's contract-write payloads (metadata
        // only — the worker derives what it needs; tag/untag read the tag-plan
        // row's position). Stock barebones player links carry a lowercase pos
        // abbrev color class (position_qb / position_wr / position_lb). The
        // numeric class scheme (position_07_1234) isn't an abbrev → leave blank.
        try {
          var pm = String((a && a.className) || "").match(/(?:^|\s)position_([a-z]{1,3})(?:\s|$)/i);
          ctx.position = pm && pm[1] && !/^\d/.test(pm[1]) ? pm[1].toUpperCase() : "";
        } catch (ep) { ctx.position = ""; }
        ctx.actionsHtml = root.UPS_PLAYER_ACTIONS_NATIVE.prepare(pid, row, ctx);
        ctx.openTab = "actions";
      } catch (e) { try { console.warn("[UPS][popup-bridge] actions prepare failed", e); } catch (e2) {} }
    }

    // Front Office deep-link — the fallback (non-owned players, unknown identity)
    // AND the hand-off for actions the native brain doesn't do in-modal yet.
    if (!ctx.bioActionsHtml && ctx.leagueId) {
      // ups_barebones=0: in barebones mode the FO embed is gate-skipped, so a
      // plain MESSAGE7 link would land on an empty stock page. This param makes
      // the guard exit lite mode as part of the SAME navigation — one click
      // from the modal to the real contract machinery. In full mode the param
      // just re-affirms OFF and self-strips. Harmless both ways.
      var foHref = "/" + encodeURIComponent(ctx.year) + "/home/" +
        encodeURIComponent(ctx.leagueId) + "?MODULE=MESSAGE7&ups_barebones=0";
      var foLabel = root.UPS_BAREBONES ? "Open in Front Office (full site) \u2192" : "Open in Front Office \u2192";
      ctx.bioActionsHtml =
        '<a class="upm-fo-link" href="' + foHref + '">' + foLabel + '</a>';
    }
    try { root.UPS_openPlayerProfile(pid, ctx); }
    catch (e) {
      try { console.warn("[UPS][popup-bridge] open failed", e); } catch (e2) {}
      // preventDefault already fired above — without this fallback a THROWING
      // modal leaves the click completely inert. Degrade to native navigation.
      try { if (a && a.href) { root.location.href = a.href; return; } } catch (e3) {}
    }
  }

  // capture=true so we beat TOS's own jQuery handler (TOS binds on document
  // bubble-phase). Returning early without preventDefault when the flag is
  // off lets TOS's handler run unmolested.
  // Warm the rosters cache + resolve the viewer franchise on load so the first
  // popup already has the live strip AND can decide own-vs-not for actions.
  try { var __ic = pageCtx(); loadRostersCache(__ic.leagueId, __ic.year || String(new Date().getFullYear())); } catch (e) {}
  resolveViewerFidAsync();

  document.addEventListener("click", onClick, true);
})(typeof window !== "undefined" ? window : null);
