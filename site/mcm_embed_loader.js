/* Iframe loader for the MCM HPM module. */
(function () {
  "use strict";

  function safeStr(v) {
    return String(v == null ? "" : v).trim();
  }

  function normalizeMode(v) {
    return safeStr(v).toLowerCase() === "light" ? "light" : "dark";
  }

  function pad4(v) {
    const d = safeStr(v).replace(/\D/g, "");
    return d ? d.padStart(4, "0").slice(-4) : "";
  }

  function getUrl() {
    try {
      return new URL(window.location.href);
    } catch (_) {
      return null;
    }
  }

  function detectYear(u) {
    if (u) {
      const q = u.searchParams.get("YEAR");
      if (q) return safeStr(q);
    }
    const m = String(window.location.pathname || "").match(/\/(\d{4})\//);
    return m ? m[1] : String(new Date().getFullYear());
  }

  function detectLeagueId(u) {
    if (u) {
      const q = u.searchParams.get("L");
      if (q) return safeStr(q);
    }
    const m = String(window.location.pathname || "").match(/\/home\/(\d+)(?:\/|$)/i);
    return m ? m[1] : "";
  }

  function detectFranchiseId(u) {
    const globals = [window.FRANCHISE_ID, window.franchise_id, window.franchiseId, window.fid];
    for (const g of globals) {
      const p = pad4(g);
      if (p) return p;
    }
    if (u) {
      const q = pad4(
        u.searchParams.get("FRANCHISE_ID") ||
          u.searchParams.get("FRANCHISE") ||
          u.searchParams.get("F") ||
          u.searchParams.get("FR")
      );
      if (q) return q;
    }
    const m = String(window.location.pathname || "").match(/\/home\/\d+\/(\d{1,4})(?:\/|$)/i);
    return m ? pad4(m[1]) : "";
  }

  function getHostMode() {
    if (typeof window.getUPSMode === "function") return normalizeMode(window.getUPSMode());
    const attr = document.documentElement.getAttribute("data-ups-mode");
    return normalizeMode(attr || "dark");
  }

  const script = document.currentScript;
  const targetId = script ? safeStr(script.getAttribute("data-mcm-target-id")) : "";
  const mount = targetId ? document.getElementById(targetId) : null;
  if (!mount) return;

  const u = getUrl();
  const L = detectLeagueId(u);
  const YEAR = detectYear(u);
  const FRANCHISE_ID = detectFranchiseId(u);
  const THEME = getHostMode();

  const DEFAULT_API = "https://upsmflproduction.keith-creelman.workers.dev";
  const apiBase = u && u.searchParams.get("MCM_API") ? safeStr(u.searchParams.get("MCM_API")) : DEFAULT_API;

  // Hosted frame is served from this same repo via jsDelivr.
  const frameBase =
    "https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@dev/site/mcm/mcm_frame.html";

  const frameUrl = new URL(frameBase);
  frameUrl.searchParams.set("api", apiBase.replace(/\/+$/, ""));
  if (L) frameUrl.searchParams.set("L", L);
  if (YEAR) frameUrl.searchParams.set("YEAR", YEAR);
  if (FRANCHISE_ID) frameUrl.searchParams.set("FRANCHISE_ID", FRANCHISE_ID);
  frameUrl.searchParams.set("THEME", THEME);

  mount.innerHTML = "";
  const iframe = document.createElement("iframe");
  iframe.className = "ups-mcm-frame";
  iframe.style.width = "100%";
  iframe.style.height = "1500px";
  iframe.setAttribute("loading", "lazy");
  iframe.setAttribute("scrolling", "no");
  iframe.src = frameUrl.toString();
  mount.appendChild(iframe);

  function onMessage(e) {
    if (!iframe.contentWindow || e.source !== iframe.contentWindow) return;
    const data = e.data || {};
    if (!data || data.type !== "mcm-height") return;
    const next = Number(data.height);
    if (!Number.isFinite(next) || next <= 0) return;
    const clamped = Math.max(800, Math.min(20000, Math.ceil(next)));
    iframe.style.height = String(clamped) + "px";
  }

  window.addEventListener("message", onMessage);

  // Keep theme in sync.
  document.addEventListener("ups-theme-change", function () {
    const nextMode = getHostMode();
    try {
      iframe.contentWindow && iframe.contentWindow.postMessage({ type: "ups-theme", mode: nextMode }, "*");
    } catch (_) {}
  });
})();
