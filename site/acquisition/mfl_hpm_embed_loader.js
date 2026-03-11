(function () {
  "use strict";

  var BUILD = "2026.03.11.01";
  if (window.__ups_acq_embed_loader === BUILD) {
    if (typeof window.UPS_ACQ_INIT === "function") window.UPS_ACQ_INIT();
    return;
  }
  window.__ups_acq_embed_loader = BUILD;

  function safeStr(value) {
    return value == null ? "" : String(value).trim();
  }

  function getContext() {
    var out = { leagueId: "", year: "" };
    try {
      var u = new URL(window.location.href || "");
      out.leagueId = safeStr(u.searchParams.get("L") || window.league_id || window.LEAGUE_ID || "").replace(/\D/g, "");
      out.year = safeStr(u.searchParams.get("YEAR") || window.year || window.YEAR || "").replace(/\D/g, "");
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

  function getScriptBaseUrl() {
    try {
      var s = document.currentScript;
      if (!s || !s.src) return "";
      var u = new URL(s.src, window.location.href);
      u.pathname = safeStr(u.pathname).replace(/[^/]+$/, "");
      u.search = "";
      u.hash = "";
      return u.toString();
    } catch (e) {
      return "";
    }
  }

  function ensureMount() {
    var mount = document.getElementById("acquisition-hub");
    if (mount) return mount;
    mount = document.createElement("div");
    mount.id = "acquisition-hub";
    var anchor = document.querySelector(".ups-hotlinks-shell") || document.getElementById("container-wrap") || document.body;
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(mount, anchor.nextSibling);
    } else {
      document.body.appendChild(mount);
    }
    return mount;
  }

  function injectCss(candidates) {
    var id = "ups-acq-css";
    if (document.getElementById(id)) return;
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

  function injectScripts(candidates, done) {
    var queue = candidates.slice();
    function next() {
      if (!queue.length) {
        if (typeof done === "function") done();
        return;
      }
      var src = queue.shift();
      var script = document.createElement("script");
      script.src = src;
      script.async = false;
      script.defer = true;
      script.onerror = next;
      script.onload = next;
      (document.body || document.documentElement).appendChild(script);
    }
    next();
  }

  function boot() {
    var ctx = getContext();
    window.UPS_ACQ_LEAGUE_ID = ctx.leagueId;
    window.UPS_ACQ_YEAR = ctx.year;
    ensureMount();

    if (typeof window.UPS_ACQ_INIT === "function") {
      window.UPS_ACQ_INIT();
      return;
    }

    var base = getScriptBaseUrl();
    var releaseRef = safeStr(window.UPS_RELEASE_SHA || "main") || "main";
    var cacheKey = encodeURIComponent(String(Date.now()));
    var cssCandidates = [];
    var scriptPaths = [
      "lib/refresh_manager.js",
      "modules/rookie_draft.js",
      "modules/free_agent_auction.js",
      "modules/expired_rookie_auction.js",
      "modules/waiver_lab.js",
      "acquisition_hub.js"
    ];
    var scriptCandidates = [];

    if (base) {
      cssCandidates.push(base + "acquisition_hub.css?v=" + cacheKey);
      scriptPaths.forEach(function (path) {
        scriptCandidates.push(base + path + "?v=" + cacheKey);
      });
    }

    cssCandidates.push("https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@" + releaseRef + "/site/acquisition/acquisition_hub.css?v=" + cacheKey);
    cssCandidates.push("https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@main/site/acquisition/acquisition_hub.css?v=" + cacheKey);

    scriptPaths.forEach(function (path) {
      scriptCandidates.push("https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@" + releaseRef + "/site/acquisition/" + path + "?v=" + cacheKey);
    });

    injectCss(cssCandidates);
    injectScripts(scriptCandidates, function () {});
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
