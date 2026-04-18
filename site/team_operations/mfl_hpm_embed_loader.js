(function () {
  "use strict";

  var BUILD = "2026.04.18.02";
  if (window.__ups_team_ops_embed_loader === BUILD) {
    if (typeof window.UPS_TEAMOPS_INIT === "function") window.UPS_TEAMOPS_INIT();
    return;
  }
  window.__ups_team_ops_embed_loader = BUILD;

  var SCRIPT_BASE_URL = (function () {
    try {
      var s = document.currentScript;
      if (!s || !s.src) return "";
      var u = new URL(s.src, window.location.href);
      var parts = String(u.pathname || "").split("/");
      parts.pop();
      u.pathname = parts.join("/") + "/";
      u.search = ""; u.hash = "";
      return u.toString();
    } catch (e) { return ""; }
  })();

  function safeStr(v) {
    return v == null ? "" : String(v).trim();
  }

  function pad4(v) {
    var d = String(v || "").replace(/\D/g, "");
    return d ? d.padStart(4, "0").slice(-4) : "";
  }

  function getContext() {
    var out = { leagueId: "", year: "", franchiseId: "" };
    try {
      var u = new URL(window.location.href || "");

      out.leagueId = safeStr(
        u.searchParams.get("L") ||
        window.UPS_TEAMOPS_LEAGUE_ID ||
        window.league_id ||
        window.LEAGUE_ID ||
        ""
      ).replace(/\D/g, "");

      out.year = safeStr(
        u.searchParams.get("YEAR") ||
        window.UPS_TEAMOPS_YEAR ||
        window.year ||
        window.YEAR ||
        ""
      ).replace(/\D/g, "");

      if (!out.year) {
        var py = safeStr(u.pathname).match(/\/(\d{4})\//);
        if (py && py[1]) out.year = py[1];
      }
      if (!out.leagueId) {
        var pl = safeStr(u.pathname).match(/\/home\/(\d+)(?:\/|$)/i);
        if (pl && pl[1]) out.leagueId = pl[1];
      }

      var fidCandidates = [
        window.FRANCHISE_ID,
        window.franchise_id,
        window.franchiseId,
        window.fid,
        u.searchParams.get("FRANCHISE_ID"),
        u.searchParams.get("FRANCHISE"),
        u.searchParams.get("F")
      ];
      for (var i = 0; i < fidCandidates.length; i++) {
        var p = pad4(fidCandidates[i]);
        if (p) { out.franchiseId = p; break; }
      }
      if (!out.franchiseId) {
        var pf = safeStr(u.pathname).match(/\/home\/\d+\/(\d{1,4})(?:\/|$)/i);
        if (pf) out.franchiseId = pad4(pf[1]);
      }
    } catch (e) {}

    if (!out.year) out.year = String(new Date().getFullYear());
    return out;
  }

  function ensureMount() {
    var mount = document.getElementById("teamOpsMount");
    if (mount) return mount;

    mount = document.createElement("div");
    mount.id = "teamOpsMount";

    var anchor =
      document.querySelector(".ups-hotlinks-shell") ||
      document.getElementById("container-wrap");

    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(mount, anchor.nextSibling);
    } else {
      document.body.appendChild(mount);
    }
    return mount;
  }

  function getScriptBaseUrl() {
    return SCRIPT_BASE_URL;
  }

  function injectCssCandidates(candidates) {
    var id = "ups-teamops-css";
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
      s.onload = function () { if (typeof done === "function") done(true); };
      s.onerror = function () { next(); };
      (document.body || document.documentElement).appendChild(s);
    }
    next();
  }

  function boot() {
    var ctx = getContext();
    window.UPS_TEAMOPS_LEAGUE_ID = ctx.leagueId;
    window.UPS_TEAMOPS_YEAR = ctx.year;
    window.UPS_TEAMOPS_FRANCHISE_ID = ctx.franchiseId;

    ensureMount();

    if (typeof window.UPS_TEAMOPS_INIT === "function") {
      window.UPS_TEAMOPS_INIT();
      return;
    }

    var base = getScriptBaseUrl();
    var cacheKey = encodeURIComponent(String(Date.now()));
    var releaseRef = safeStr(window.UPS_RELEASE_SHA || "main") || "main";

    var cssCandidates = [];
    var jsCandidates = [];

    if (base) {
      cssCandidates.push(base + "team_operations.css?v=" + cacheKey);
      jsCandidates.push(base + "team_operations.js?v=" + cacheKey);
    }
    cssCandidates.push("https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@" + releaseRef + "/site/team_operations/team_operations.css?v=" + cacheKey);
    cssCandidates.push("https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@main/site/team_operations/team_operations.css?v=" + cacheKey);
    jsCandidates.push("https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@" + releaseRef + "/site/team_operations/team_operations.js?v=" + cacheKey);
    jsCandidates.push("https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@main/site/team_operations/team_operations.js?v=" + cacheKey);

    injectCssCandidates(cssCandidates);
    injectScript(jsCandidates, function () {});
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
