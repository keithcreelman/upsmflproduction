(function () {
  "use strict";

  function pad4(v) {
    const d = String(v || "").replace(/\D/g, "");
    return d ? d.padStart(4, "0").slice(-4) : "";
  }

  function getUrl() {
    try {
      return new URL(window.location.href);
    } catch (e) {
      return null;
    }
  }

  const RUNTIME_DEFAULTS = {
    leagueId: String(window.UPS_CCC_DEFAULT_LEAGUE_ID || "").trim(),
    year: String(window.UPS_CCC_DEFAULT_YEAR || new Date().getFullYear()).trim(),
  };

  function getLeagueId(u) {
    const q = u ? String(u.searchParams.get("L") || "").trim() : "";
    if (q) return q;
    const globalLeague = String(window.league_id || window.LEAGUE_ID || "").trim();
    if (globalLeague) return globalLeague;
    const m = String(window.location.pathname || "").match(/\/home\/(\d+)(?:\/|$)/i);
    if (m && m[1]) return m[1];
    return RUNTIME_DEFAULTS.leagueId;
  }

  function getYear(u) {
    const q = u ? String(u.searchParams.get("YEAR") || "").trim() : "";
    if (q) return q;
    const globalYear = String(window.year || window.YEAR || "").trim();
    if (globalYear) return globalYear;
    const m = String(window.location.pathname || "").match(/\/(\d{4})\//);
    if (m && m[1]) return m[1];
    return RUNTIME_DEFAULTS.year;
  }

  function getFranchiseId(u) {
    const globals = [
      window.FRANCHISE_ID,
      window.franchise_id,
      window.franchiseId,
      window.fid,
    ];
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

  function normalizeMode(v) {
    return String(v || "").toLowerCase() === "light" ? "light" : "dark";
  }

  function normalizeExplicitMode(v) {
    const mode = String(v || "").toLowerCase();
    return mode === "light" || mode === "dark" ? mode : "";
  }

  const u = getUrl();
  function resolveRuntimeContext(urlObj) {
    return {
      L: getLeagueId(urlObj),
      YEAR: getYear(urlObj),
      FRANCHISE_ID: getFranchiseId(urlObj),
    };
  }
  const runtime = resolveRuntimeContext(u);
  const L = runtime.L;
  const YEAR = runtime.YEAR;
  const FRANCHISE_ID = runtime.FRANCHISE_ID;
  const MFL_USER_ID = (function () {
    try {
      const c = String(document.cookie || "");
      const m = c.match(/(?:^|;\s*)MFL_USER_ID=([^;]+)/i);
      return m && m[1] ? decodeURIComponent(String(m[1])) : "";
    } catch (e) {
      return "";
    }
  })();
  const MODE_KEY = "ups_mode_" + YEAR + "_" + L;
  const DEBUG_ADMIN =
    (u && (u.searchParams.get("DEBUG_ADMIN") || u.searchParams.get("DEBUG"))) || "";

  const DEFAULT_CCC_IFRAME_URL =
    "https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@main/site/ccc/mfl_hpm16_contractcommandcenter.html";

  function getScriptBaseUrl() {
    try {
      const s = document.currentScript;
      if (!s || !s.src) return "";
      const su = new URL(s.src, window.location.href);
      const parts = String(su.pathname || "").split("/");
      parts.pop();
      su.pathname = parts.join("/") + "/";
      su.search = "";
      su.hash = "";
      return su.toString();
    } catch (e) {}
    return "";
  }

  function jsDelivrScriptToRawGithackHtml(scriptSrc) {
    try {
      const su = new URL(scriptSrc, window.location.href);
      if (!/cdn\.jsdelivr\.net$/i.test(String(su.hostname || ""))) return "";
      const parts = String(su.pathname || "").split("/").filter(Boolean);
      if (parts.length < 5 || parts[0] !== "gh") return "";

      const owner = parts[1];
      const repoRef = parts[2];
      const at = repoRef.lastIndexOf("@");
      if (at <= 0 || at >= repoRef.length - 1) return "";
      const repo = repoRef.slice(0, at);
      const ref = repoRef.slice(at + 1);
      const dirParts = parts.slice(3, -1);
      if (!dirParts.length) return "";

      // jsDelivr often serves this HTML with text/plain + nosniff.
      // Keep loader JS on jsDelivr, but force HTML document via rawcdn.githack.
      return (
        "https://rawcdn.githack.com/" +
        encodeURIComponent(owner) +
        "/" +
        encodeURIComponent(repo) +
        "/" +
        encodeURIComponent(ref) +
        "/" +
        dirParts.map(encodeURIComponent).join("/") +
        "/mfl_hpm16_contractcommandcenter.html"
      );
    } catch (e) {}
    return "";
  }

  function resolveIframeUrl() {
    const explicit = String(window.UPS_CCC_IFRAME_URL || "").trim();
    if (explicit) return explicit;
    try {
      const s = document.currentScript;
      if (s && s.src) {
        const fromJsDelivr = jsDelivrScriptToRawGithackHtml(s.src);
        if (fromJsDelivr) return fromJsDelivr;
      }
    } catch (e) {}
    const base = getScriptBaseUrl();
    if (base) return base + "mfl_hpm16_contractcommandcenter.html";
    return DEFAULT_CCC_IFRAME_URL;
  }
  const CCC_IFRAME_URL = resolveIframeUrl();
  const ALLOWED_IFRAME_ORIGINS = (function () {
    const out = ["https://cdn.jsdelivr.net", "https://keithcreelman.github.io"];
    try {
      const u = new URL(CCC_IFRAME_URL, window.location.href);
      if (u.origin && out.indexOf(u.origin) === -1) out.push(u.origin);
    } catch (e) {}
    return out;
  })();

  function inferModeFromSystem() {
    // Default to dark so CCC blends with the league's blue/dark shell.
    if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
    return "dark";
  }

  function getHostMode() {
    if (typeof window.getUPSMode === "function") return normalizeMode(window.getUPSMode());
    const attr = document.documentElement.getAttribute("data-ups-mode");
    if (attr) return normalizeMode(attr);
    try {
      const stored = localStorage.getItem(MODE_KEY);
      if (stored) return normalizeMode(stored);
    } catch (e) {}
    return inferModeFromSystem();
  }

  function setHostMode(mode, persist) {
    const next = normalizeExplicitMode(mode);
    if (!next) return;
    if (typeof window.setUPSMode === "function") {
      window.setUPSMode(next);
      return;
    }
    document.documentElement.setAttribute("data-ups-mode", next);
    document.documentElement.style.colorScheme = next;
    if (persist) {
      try {
        localStorage.setItem(MODE_KEY, next);
      } catch (e) {}
    }
    try {
      document.dispatchEvent(new CustomEvent("ups-theme-change", { detail: { mode: next } }));
    } catch (e) {}
  }

  let mount = document.getElementById("cccMount");
  if (!mount) {
    mount = document.createElement("div");
    mount.id = "cccMount";
    document.body.appendChild(mount);
  }

  function getScriptCacheKey() {
    try {
      const s = document.currentScript;
      if (!s || !s.src) return "";
      const su = new URL(s.src, window.location.href);
      return String(su.searchParams.get("v") || su.searchParams.get("cache") || "");
    } catch (e) {}
    return "";
  }

  function buildSrc(cacheKey, mode) {
    const cache = cacheKey || getScriptCacheKey() || String(Date.now());
    const theme = normalizeMode(mode || getHostMode());
    return (
      CCC_IFRAME_URL +
      "?cache=" +
      encodeURIComponent(cache) +
      "&L=" +
      encodeURIComponent(L) +
      "&YEAR=" +
      encodeURIComponent(YEAR) +
      "&FRANCHISE_ID=" +
      encodeURIComponent(FRANCHISE_ID) +
      (MFL_USER_ID ? "&MFL_USER_ID=" + encodeURIComponent(MFL_USER_ID) : "") +
      "&THEME=" +
      encodeURIComponent(theme) +
      (DEBUG_ADMIN ? "&DEBUG_ADMIN=" + encodeURIComponent(DEBUG_ADMIN) : "")
    );
  }

  mount.innerHTML = "";
  const iframe = document.createElement("iframe");
  iframe.style.width = "100%";
  iframe.style.height = "1400px";
  iframe.style.border = "0";
  iframe.setAttribute("loading", "lazy");
  iframe.setAttribute("scrolling", "no");
  mount.appendChild(iframe);

  iframe.src = buildSrc(getScriptCacheKey(), getHostMode());

  function syncIframeTheme(mode) {
    const nextMode = normalizeMode(mode || getHostMode());
    const srcAttr = iframe.getAttribute("src");
    if (srcAttr) {
      try {
        const src = new URL(srcAttr, window.location.href);
        const before = src.toString();
        src.searchParams.set("THEME", nextMode);
        src.searchParams.set("theme", nextMode);
        const after = src.toString();
        if (after !== before) iframe.src = after;
      } catch (e) {}
    }
    if (iframe.contentWindow) {
      try {
        iframe.contentWindow.postMessage({ type: "ups-theme", mode: nextMode }, "*");
      } catch (e) {}
    }
  }

  iframe.addEventListener("load", () => {
    syncIframeTheme(getHostMode());
  });

  function onMessage(e) {
    if (!iframe.contentWindow || e.source !== iframe.contentWindow) return;
    if (ALLOWED_IFRAME_ORIGINS.indexOf(String(e.origin || "")) === -1) return;
    const data = e.data || {};
    if (!data) return;
    if (data.type === "ccc-height") {
      const next = Number(data.height);
      if (!Number.isFinite(next) || next <= 0) return;
      const clamped = Math.max(600, Math.min(20000, Math.ceil(next)));
      iframe.style.height = String(clamped) + "px";
      return;
    }
    if (data.type === "ccc-theme") return;
  }

  window.addEventListener("message", onMessage, false);
  document.addEventListener("ups-theme-change", function (ev) {
    const mode = normalizeMode(ev && ev.detail ? ev.detail.mode : getHostMode());
    syncIframeTheme(mode);
  });
})();
