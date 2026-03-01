(function () {
  "use strict";

  function safeStr(v) {
    return v === null || v === undefined ? "" : String(v);
  }

  function detectLeagueId(urlObj) {
    try {
      if (typeof window.getLeagueContext === "function") {
        const ctx = window.getLeagueContext();
        const leagueFromCtx = safeStr(ctx && (ctx.leagueId || ctx.league_id));
        if (leagueFromCtx) return leagueFromCtx;
      }
    } catch (eCtx) {}
    if (!urlObj) return "";
    const q = safeStr(urlObj.searchParams.get("L"));
    if (q) return q;
    const m = safeStr(window.location.pathname).match(/\/home\/(\d+)(?:\/|$)/i);
    return m ? m[1] : "";
  }

  function detectSourceLeagueId(urlObj, scriptEl) {
    const scriptPref = safeStr(scriptEl && scriptEl.getAttribute("data-standings-source-league-id"));
    if (scriptPref) return scriptPref;
    const currentLeague = detectLeagueId(urlObj);
    if (!urlObj) return currentLeague;
    const q = safeStr(urlObj.searchParams.get("SOURCE_L") || urlObj.searchParams.get("DATA_L"));
    if (q) return q;
    return currentLeague;
  }

  function detectYear(urlObj) {
    try {
      if (typeof window.getLeagueContext === "function") {
        const ctx = window.getLeagueContext();
        const seasonFromCtx = safeStr(ctx && (ctx.season || ctx.year));
        if (seasonFromCtx) return seasonFromCtx;
      }
    } catch (eCtx) {}
    if (!urlObj) return String(new Date().getUTCFullYear());
    const q = safeStr(urlObj.searchParams.get("YEAR"));
    if (q) return q;
    const m = safeStr(window.location.pathname).match(/\/(\d{4})\//);
    return m ? m[1] : String(new Date().getUTCFullYear());
  }

  function scriptBaseHtml(scriptSrc) {
    try {
      const su = new URL(scriptSrc, window.location.href);

      // jsDelivr serves this .html as text/plain+nosniff, which renders source text
      // in iframes. Keep loader JS on jsDelivr, but fetch HTML via rawcdn.githack.
      const jsd = safeStr(su.pathname).match(
        /^\/gh\/keithcreelman\/upsmflproduction@([^/]+)\/site\/standings\/mfl_hpm_embed_loader\.js$/i
      );
      if (/cdn\.jsdelivr\.net$/i.test(safeStr(su.hostname)) && jsd) {
        return (
          "https://rawcdn.githack.com/keithcreelman/upsmflproduction/" +
          jsd[1] +
          "/site/standings/mfl_hpm_standings.html"
        );
      }

      const parts = safeStr(su.pathname).split("/");
      parts.pop();
      su.pathname = parts.join("/") + "/mfl_hpm_standings.html";
      su.search = "";
      su.hash = "";
      return su.toString();
    } catch (e) {
      return "https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@main/site/standings/mfl_hpm_standings.html";
    }
  }

  const script = document.currentScript;
  const hostUrl = (function () {
    try {
      return new URL(window.location.href);
    } catch (e) {
      return null;
    }
  })();
  const L = detectLeagueId(hostUrl);
  const SOURCE_L = detectSourceLeagueId(hostUrl, script);
  const YEAR = detectYear(hostUrl);
  const cacheKey = (function () {
    try {
      if (!script || !script.src) return "";
      const su = new URL(script.src, window.location.href);
      return safeStr(su.searchParams.get("v") || su.searchParams.get("cache"));
    } catch (e) {
      return "";
    }
  })();

  let mount = null;
  const targetId = script ? safeStr(script.getAttribute("data-standings-target-id")) : "";
  if (targetId) mount = document.getElementById(targetId);
  if (!mount) mount = document.getElementById("upsStandingsMount");
  if (!mount) {
    mount = document.createElement("div");
    mount.id = "upsStandingsMount";
    document.body.appendChild(mount);
  }

  const iframe = document.createElement("iframe");
  iframe.style.width = "100%";
  iframe.style.maxWidth = "100%";
  iframe.style.height = "960px";
  iframe.style.border = "0";
  iframe.setAttribute("loading", "lazy");
  iframe.setAttribute("scrolling", "auto");

  const src = new URL(scriptBaseHtml(script && script.src ? script.src : ""), window.location.href);
  src.searchParams.set("L", L);
  src.searchParams.set("SOURCE_L", SOURCE_L);
  src.searchParams.set("YEAR", YEAR);
  if (cacheKey) src.searchParams.set("v", cacheKey);
  iframe.src = src.toString();

  mount.innerHTML = "";
  mount.appendChild(iframe);

  window.addEventListener("message", function (e) {
    if (e.data && e.data.type === "ups-standings-height" && typeof e.data.height === "number") {
      iframe.style.height = Math.max(400, e.data.height) + "px";
    }
  });
})();
