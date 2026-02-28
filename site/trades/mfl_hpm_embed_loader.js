(function () {
  "use strict";

  function safeStr(v) {
    return v == null ? "" : String(v).trim();
  }

  function pad4(v) {
    var d = safeStr(v).replace(/\D/g, "");
    if (!d) return "";
    return ("0000" + d).slice(-4);
  }

  function getUrl() {
    try {
      return new URL(window.location.href);
    } catch (e) {
      return null;
    }
  }

  function getLeagueId(u) {
    var q = u ? safeStr(u.searchParams.get("L")) : "";
    if (q) return q;
    var globals = [window.league_id, window.LEAGUE_ID, window.leagueId];
    var i;
    for (i = 0; i < globals.length; i += 1) {
      var g = safeStr(globals[i]);
      if (g) return g;
    }
    var m = safeStr(window.location.pathname).match(/\/home\/(\d+)(?:\/|$)/i);
    return m && m[1] ? m[1] : "";
  }

  function getYear(u) {
    var q = u ? safeStr(u.searchParams.get("YEAR")) : "";
    if (q) return q;
    var globals = [window.year, window.YEAR];
    var i;
    for (i = 0; i < globals.length; i += 1) {
      var g = safeStr(globals[i]);
      if (g) return g;
    }
    var m = safeStr(window.location.pathname).match(/\/(\d{4})\//);
    if (m && m[1]) return m[1];
    return String(new Date().getFullYear());
  }

  function getCookieString() {
    try {
      return safeStr(document.cookie || "");
    } catch (e) {
      return "";
    }
  }

  function getFranchiseIdFromCookies(leagueId, year) {
    var lid = safeStr(leagueId).replace(/\D/g, "");
    if (!lid) return "";
    var yy = safeStr(year).replace(/\D/g, "");
    var raw = getCookieString();
    if (!raw) return "";

    var re = /(?:^|;\s*)MFLPlayerPopup_(\d{4})_(\d+)_(\d{1,4})=/g;
    var m;
    var hits = [];
    while ((m = re.exec(raw))) {
      var hitYear = safeStr(m[1]);
      var hitLeague = safeStr(m[2]).replace(/\D/g, "");
      var hitFr = pad4(m[3]);
      if (!hitLeague || hitLeague !== lid) continue;
      if (!hitFr || hitFr === "0000") continue;
      hits.push({ year: hitYear, franchise_id: hitFr });
    }
    if (!hits.length) return "";

    var i;
    if (yy) {
      for (i = 0; i < hits.length; i += 1) {
        if (hits[i].year === yy) return hits[i].franchise_id;
      }
    }
    hits.sort(function (a, b) {
      var ay = parseInt(a.year, 10);
      var by = parseInt(b.year, 10);
      if (!isFinite(ay)) ay = 0;
      if (!isFinite(by)) by = 0;
      return by - ay;
    });
    return hits[0].franchise_id;
  }

  function getFranchiseId(u, leagueId, year) {
    var globals = [window.FRANCHISE_ID, window.franchise_id, window.franchiseId, window.fid];
    var i;
    for (i = 0; i < globals.length; i += 1) {
      var p = pad4(globals[i]);
      if (p) return p;
    }
    if (u) {
      var q = pad4(
        u.searchParams.get("FRANCHISE_ID") ||
          u.searchParams.get("FRANCHISE") ||
          u.searchParams.get("F") ||
          u.searchParams.get("FR")
      );
      if (q) return q;
    }
    var m = safeStr(window.location.pathname).match(/\/home\/\d+\/(\d{1,4})(?:\/|$)/i);
    if (m && m[1]) return pad4(m[1]);

    return getFranchiseIdFromCookies(leagueId, year);
  }

  function getScriptBaseUrl() {
    try {
      var s = document.currentScript;
      if (!s || !s.src) return "";
      var su = new URL(s.src, window.location.href);
      var parts = String(su.pathname || "").split("/");
      parts.pop();
      su.pathname = parts.join("/") + "/";
      su.search = "";
      su.hash = "";
      return su.toString();
    } catch (e) {
      return "";
    }
  }

  function getReleaseRefFromScriptSrc(scriptSrc) {
    try {
      var su = new URL(scriptSrc, window.location.href);
      var parts = String(su.pathname || "").split("/").filter(Boolean);
      if (parts.length < 3 || parts[0] !== "gh") return "";
      var repoRef = parts[2];
      var at = repoRef.lastIndexOf("@");
      if (at <= 0 || at >= repoRef.length - 1) return "";
      return safeStr(repoRef.slice(at + 1));
    } catch (e) {
      return "";
    }
  }

  function resolveReleaseRef() {
    var globals = [
      window.UPS_RELEASE_SHA,
      window.UPS_TWB_RELEASE_SHA,
      window.UPS_TRADE_WORKBENCH_RELEASE_SHA
    ];
    var i;
    for (i = 0; i < globals.length; i += 1) {
      var g = safeStr(globals[i]);
      if (g) return g;
    }
    try {
      var s = document.currentScript;
      if (s && s.src) {
        var ref = getReleaseRefFromScriptSrc(s.src);
        if (ref) return ref;
      }
    } catch (e) {
      // noop
    }
    return "";
  }

  function jsDelivrScriptToGithackHtml(scriptSrc) {
    try {
      var su = new URL(scriptSrc, window.location.href);
      if (!/cdn\.jsdelivr\.net$/i.test(String(su.hostname || ""))) return "";
      var parts = String(su.pathname || "").split("/").filter(Boolean);
      if (parts.length < 5 || parts[0] !== "gh") return "";

      var owner = parts[1];
      var repoRef = parts[2];
      var at = repoRef.lastIndexOf("@");
      if (at <= 0 || at >= repoRef.length - 1) return "";
      var repo = repoRef.slice(0, at);
      var ref = repoRef.slice(at + 1);
      var dirParts = parts.slice(3, -1);
      if (!dirParts.length) return "";

      return (
        "https://rawcdn.githack.com/" +
        encodeURIComponent(owner) +
        "/" +
        encodeURIComponent(repo) +
        "/" +
        encodeURIComponent(ref) +
        "/" +
        dirParts.map(encodeURIComponent).join("/") +
        "/trade_workbench.html"
      );
    } catch (e) {
      return "";
    }
  }

  function resolveIframeUrl() {
    var explicit = safeStr(window.UPS_TWB_IFRAME_URL || window.UPS_TRADE_WORKBENCH_IFRAME_URL);
    if (explicit) return explicit;
    var base = getScriptBaseUrl();
    if (base) return base + "trade_workbench.html";
    try {
      var s = document.currentScript;
      if (s && s.src) {
        var fromJsDelivr = jsDelivrScriptToGithackHtml(s.src);
        if (fromJsDelivr) return fromJsDelivr;
      }
    } catch (e) {
      // noop
    }
    return "https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@main/site/trades/trade_workbench.html";
  }

  function resolveApiUrl() {
    return safeStr(window.UPS_TWB_API || window.UPS_TRADE_WORKBENCH_API || "https://upsmflproduction.keith-creelman.workers.dev/trade-workbench");
  }

  function ensureMount() {
    var mount =
      document.getElementById("twbMount") ||
      document.getElementById("tradeWorkbenchMount") ||
      document.getElementById("cccMount");
    if (mount) return mount;
    mount = document.createElement("div");
    mount.id = "twbMount";
    (document.body || document.documentElement).appendChild(mount);
    return mount;
  }

  function buildIframeSrc(iframeUrl, apiUrl, context, pageUrl, releaseRef) {
    var url;
    try {
      url = new URL(iframeUrl, window.location.href);
    } catch (e) {
      return iframeUrl;
    }
    if (apiUrl && !url.searchParams.get("api")) url.searchParams.set("api", apiUrl);
    if (context.L && !url.searchParams.get("L")) url.searchParams.set("L", context.L);
    if (context.YEAR && !url.searchParams.get("YEAR")) url.searchParams.set("YEAR", context.YEAR);
    if (context.F && !url.searchParams.get("F")) url.searchParams.set("F", context.F);

    if (pageUrl) {
      var debug = safeStr(pageUrl.searchParams.get("DEBUG_TWB") || pageUrl.searchParams.get("DEBUG"));
      if (debug) url.searchParams.set("DEBUG_TWB", debug);
    }
    if (releaseRef) url.searchParams.set("v", releaseRef);
    url.searchParams.set("embed", "1");
    return url.toString();
  }

  function clampHeight(h) {
    var n = Number(h);
    if (!isFinite(n) || n <= 0) return 900;
    if (n < 600) return 600;
    if (n > 30000) return 30000;
    return Math.ceil(n);
  }

  var pageUrl = getUrl();
  var releaseRef = resolveReleaseRef();
  var leagueId = getLeagueId(pageUrl);
  var year = getYear(pageUrl);
  var context = {
    L: leagueId,
    YEAR: year,
    F: getFranchiseId(pageUrl, leagueId, year)
  };
  var iframeUrl = resolveIframeUrl();
  var apiUrl = resolveApiUrl();
  var mount = ensureMount();

  mount.innerHTML = "";
  mount.style.width = "100%";
  mount.style.maxWidth = "100%";
  mount.style.overflow = "visible";

  var iframe = document.createElement("iframe");
  iframe.style.width = "100%";
  iframe.style.height = "1100px";
  iframe.style.minHeight = "600px";
  iframe.style.border = "0";
  iframe.style.display = "block";
  iframe.style.background = "transparent";
  iframe.setAttribute("loading", "lazy");
  iframe.setAttribute("scrolling", "no");
  iframe.setAttribute("title", "UPS Trade Workbench");
  iframe.src = buildIframeSrc(iframeUrl, apiUrl, context, pageUrl, releaseRef);
  mount.appendChild(iframe);

  function onMessage(ev) {
    if (!iframe.contentWindow || ev.source !== iframe.contentWindow) return;
    var data = ev.data || {};
    if (!data || data.type !== "twb-height") return;
    iframe.style.height = String(clampHeight(data.height)) + "px";
  }

  if (window.addEventListener) {
    window.addEventListener("message", onMessage, false);
  }
})();
