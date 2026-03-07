(function () {
  "use strict";

  var BUILD = "2026.03.07.1";
  if (window.__ups_rwb_embed_loader === BUILD) {
    if (typeof window.UPS_RWB_INIT === "function") window.UPS_RWB_INIT();
    return;
  }
  window.__ups_rwb_embed_loader = BUILD;

  function safeStr(v) {
    return v == null ? "" : String(v).trim();
  }

  function getContext() {
    var out = {
      leagueId: "",
      year: ""
    };
    try {
      var u = new URL(window.location.href || "");
      out.leagueId = safeStr(
        u.searchParams.get("L") ||
        window.UPS_RWB_LEAGUE_ID ||
        window.league_id ||
        window.LEAGUE_ID ||
        ""
      ).replace(/\D/g, "");

      out.year = safeStr(
        u.searchParams.get("YEAR") ||
        window.UPS_RWB_YEAR ||
        window.year ||
        window.YEAR ||
        ""
      ).replace(/\D/g, "");

      if (!out.year) {
        var pathYear = safeStr(u.pathname).match(/\/(\d{4})\//);
        if (pathYear && pathYear[1]) out.year = pathYear[1];
      }

      if (!out.leagueId) {
        var pathLeague = safeStr(u.pathname).match(/\/home\/(\d+)(?:\/|$)/i);
        if (pathLeague && pathLeague[1]) out.leagueId = pathLeague[1];
      }
    } catch (e) {}

    if (!out.year) out.year = String(new Date().getFullYear());
    return out;
  }

  function ensureMount() {
    var mount = document.getElementById("roster-workbench");
    if (mount) return mount;

    mount = document.createElement("div");
    mount.id = "roster-workbench";

    var anchor =
      document.querySelector(".ups-hotlinks-shell") ||
      document.getElementById("container-wrap") ||
      document.body;

    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(mount, anchor.nextSibling);
    } else {
      document.body.appendChild(mount);
    }

    return mount;
  }

  function applyLegacyPrehide() {
    var id = "ups-rwb-legacy-prehide";
    if (document.getElementById(id)) return;
    var css = [
      "body#body_options_07 #MFLroster{display:none!important;}",
      "body#body_options_07 #pre_load_html{display:none!important;}",
      "body#body_options_07 table.two_column_layout{display:none!important;}",
      "body#body_options_07 .reportnavigation{display:none!important;}",
      "body#body_options_07 .weekly-navbar{display:none!important;}",
      "body#body_options_07 .weekly-navbar-mobile{display:none!important;}"
    ].join("");
    var style = document.createElement("style");
    style.id = id;
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  function hideLegacyNodes() {
    var selectors = [
      "body#body_options_07 #MFLroster",
      "body#body_options_07 #pre_load_html",
      "body#body_options_07 table.two_column_layout",
      "body#body_options_07 .reportnavigation",
      "body#body_options_07 .weekly-navbar",
      "body#body_options_07 .weekly-navbar-mobile"
    ];
    var nodes = document.querySelectorAll(selectors.join(","));
    for (var i = 0; i < nodes.length; i += 1) {
      var n = nodes[i];
      if (!n) continue;
      n.style.display = "none";
      n.setAttribute("aria-hidden", "true");
    }
  }

  function getScriptBaseUrl() {
    try {
      var s = document.currentScript;
      if (!s || !s.src) return "";
      var u = new URL(s.src, window.location.href);
      var parts = String(u.pathname || "").split("/");
      parts.pop();
      u.pathname = parts.join("/") + "/";
      u.search = "";
      u.hash = "";
      return u.toString();
    } catch (e) {
      return "";
    }
  }

  function injectCssCandidates(candidates) {
    var id = "ups-rwb-css";
    var existing = document.getElementById(id);
    if (existing) return;

    var idx = 0;
    function next() {
      if (idx >= candidates.length) return;
      var link = document.createElement("link");
      link.id = id;
      link.rel = "stylesheet";
      link.href = candidates[idx++];
      link.onerror = function () {
        if (link.parentNode) link.parentNode.removeChild(link);
        next();
      };
      (document.head || document.documentElement).appendChild(link);
    }
    next();
  }

  function injectScript(candidates, done) {
    var idx = 0;

    function next() {
      if (idx >= candidates.length) {
        if (typeof done === "function") done(false);
        return;
      }

      var src = candidates[idx++];
      var s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = function () {
        if (typeof done === "function") done(true);
      };
      s.onerror = function () {
        next();
      };
      (document.body || document.documentElement).appendChild(s);
    }

    next();
  }

  function boot() {
    var ctx = getContext();
    window.UPS_RWB_LEAGUE_ID = ctx.leagueId;
    window.UPS_RWB_YEAR = ctx.year;

    applyLegacyPrehide();
    ensureMount();
    hideLegacyNodes();

    if (typeof window.UPS_RWB_INIT === "function") {
      window.UPS_RWB_INIT();
      return;
    }

    var base = getScriptBaseUrl();
    var cacheKey = encodeURIComponent(String(Date.now()));
    var releaseRef = safeStr(window.UPS_RELEASE_SHA || "main") || "main";

    var cssCandidates = [];
    var jsCandidates = [];

    if (base) {
      cssCandidates.push(base + "roster_workbench.css?v=" + cacheKey);
      jsCandidates.push(base + "roster_workbench.js?v=" + cacheKey);
    }

    cssCandidates.push("https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@" + releaseRef + "/site/rosters/roster_workbench.css?v=" + cacheKey);
    cssCandidates.push("https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@main/site/rosters/roster_workbench.css?v=" + cacheKey);

    jsCandidates.push("https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@" + releaseRef + "/site/rosters/roster_workbench.js?v=" + cacheKey);
    jsCandidates.push("https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@main/site/rosters/roster_workbench.js?v=" + cacheKey);

    injectCssCandidates(cssCandidates);

    injectScript(jsCandidates, function () {
      if (typeof window.UPS_RWB_INIT === "function") {
        window.UPS_RWB_INIT();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
