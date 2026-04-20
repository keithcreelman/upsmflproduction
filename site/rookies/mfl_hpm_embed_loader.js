(function () {
  "use strict";

  // Utilities ──────────────────────────────────────────────────────────
  function pad4(v) {
    const d = String(v || "").replace(/\D/g, "");
    return d ? d.padStart(4, "0").slice(-4) : "";
  }
  function getUrl() { try { return new URL(window.location.href); } catch (e) { return null; } }
  function safeStr(v) { return String(v == null ? "" : v).trim(); }

  function getLeagueId(u) {
    const q = u ? safeStr(u.searchParams.get("L")) : "";
    if (q) return q;
    const g = safeStr(window.league_id || window.LEAGUE_ID);
    if (g) return g;
    const m = safeStr(window.location.pathname).match(/\/home\/(\d+)(?:\/|$)/i);
    if (m && m[1]) return m[1];
    return "74598";
  }
  function getYear(u) {
    const q = u ? safeStr(u.searchParams.get("YEAR")) : "";
    if (q) return q;
    const g = safeStr(window.year || window.YEAR);
    if (g) return g;
    const m = safeStr(window.location.pathname).match(/\/(\d{4})\//);
    return (m && m[1]) || String(new Date().getFullYear());
  }
  function getFranchiseId(u) {
    for (const g of [window.FRANCHISE_ID, window.franchise_id, window.fid]) {
      const p = pad4(g);
      if (p) return p;
    }
    if (u) {
      const p = pad4(u.searchParams.get("FRANCHISE_ID") || u.searchParams.get("FRANCHISE") || u.searchParams.get("F"));
      if (p) return p;
    }
    const m = safeStr(window.location.pathname).match(/\/home\/\d+\/(\d{1,4})(?:\/|$)/i);
    return m ? pad4(m[1]) : "";
  }

  const u = getUrl();
  const L = getLeagueId(u);
  const YEAR = getYear(u);
  const FRANCHISE_ID = getFranchiseId(u);

  const SHA = safeStr(window.UPS_DRAFT_HUB_RELEASE_SHA || window.UPS_RELEASE_SHA) || "main";
  const BASE = "https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@" + SHA + "/site/rookies/rookie_draft_hub.html";

  // Mount point ────────────────────────────────────────────────────────
  const mount = document.getElementById("draftHubMount") || (function () {
    const d = document.createElement("div");
    d.id = "draftHubMount";
    document.body.appendChild(d);
    return d;
  })();

  // Clear + build iframe with runtime context passed as URL params.
  mount.innerHTML = "";
  const frame = document.createElement("iframe");
  const src = new URL(BASE);
  src.searchParams.set("L", L);
  src.searchParams.set("YEAR", YEAR);
  if (FRANCHISE_ID) src.searchParams.set("FRANCHISE_ID", FRANCHISE_ID);
  // Cache-bust on SHA change
  src.searchParams.set("v", SHA);
  frame.src = src.toString();
  frame.setAttribute("loading", "eager");
  frame.setAttribute("allow", "clipboard-read; clipboard-write");
  frame.style.cssText = [
    "width:100%",
    "min-height:1600px",
    "border:0",
    "background:#0b0f18",
    "display:block",
    "border-radius:8px",
    "overflow:hidden",
  ].join(";");
  frame.title = "UPS Rookie Draft Hub";
  mount.appendChild(frame);

  // Auto-resize iframe to content height (when same-origin or jsDelivr-served)
  window.addEventListener("message", function (ev) {
    if (!ev || !ev.data || ev.data.type !== "draft-hub-height") return;
    const h = Number(ev.data.height);
    if (h && h > 100) frame.style.minHeight = h + "px";
  });
})();
