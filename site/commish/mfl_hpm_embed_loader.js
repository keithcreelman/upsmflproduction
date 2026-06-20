/* Commish Settings — MFL HPM embed loader (mirrors site/auction/).
 *
 * Mounted by the header's MESSAGE19 hub container when ?hub=commish-settings.
 * Fetches commish_settings.html from jsDelivr at the release SHA, injects the
 * league/year/host + commish context + a height beacon, renders via srcdoc.
 * Commish-only: if the viewer isn't the commish, the page itself shows a gate.
 */
(function () {
  "use strict";
  function pad4(v) { var d = String(v || "").replace(/\D/g, ""); return d ? d.padStart(4, "0").slice(-4) : ""; }
  function safeStr(v) { return String(v == null ? "" : v).trim(); }
  function getUrl() { try { return new URL(window.location.href); } catch (e) { return null; } }
  var u = getUrl();

  function getLeagueId() {
    var q = u ? safeStr(u.searchParams.get("L")) : "";
    if (q) return q;
    var g = safeStr(window.league_id || window.LEAGUE_ID);
    if (g) return g;
    var m = safeStr(window.location.pathname).match(/\/home\/(\d+)(?:\/|$)/i);
    return (m && m[1]) || "74598";
  }
  function getYear() {
    var q = u ? safeStr(u.searchParams.get("YEAR")) : "";
    if (q) return q;
    var g = safeStr(window.year || window.YEAR);
    if (g) return g;
    var m = safeStr(window.location.pathname).match(/\/(\d{4})\//);
    return (m && m[1]) || String(new Date().getFullYear());
  }
  function getFranchiseId() {
    var ids = [window.FRANCHISE_ID, window.franchise_id, window.fid];
    for (var i = 0; i < ids.length; i++) { var p = pad4(ids[i]); if (p) return p; }
    if (u) { var p2 = pad4(u.searchParams.get("FRANCHISE_ID") || u.searchParams.get("FRANCHISE") || u.searchParams.get("F")); if (p2) return p2; }
    return "";
  }
  function detectIsCommish(fid) {
    try { if (/(?:^|;\s*)ISMFLCOMMISH\s*=\s*(1|Y|true)/i.test(String(document.cookie || ""))) return true; } catch (e) {}
    // Honor the header's view-as-owner toggle so "Become Owner" view hides commish UI.
    try { if (localStorage.getItem("ups_view_as_owner") === "1") return false; } catch (e) {}
    return fid === "0000" || fid === "0008";
  }

  var L = getLeagueId(), YEAR = getYear(), FID = getFranchiseId();
  var IS_COMMISH = detectIsCommish(FID);
  var HOST = safeStr(window.location && window.location.host) || "www48.myfantasyleague.com";
  var SHA = safeStr(window.UPS_RELEASE_SHA) || "main";
  var ASSET_BASE = "https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@" + encodeURIComponent(SHA) + "/site/commish/";
  var HTML_URL = ASSET_BASE + "commish_settings.html?v=" + encodeURIComponent(SHA);

  var mount = document.getElementById("commishSettingsMount") || (function () {
    var d = document.createElement("div"); d.id = "commishSettingsMount"; document.body.appendChild(d); return d;
  })();
  mount.innerHTML = "";
  var frame = document.createElement("iframe");
  frame.setAttribute("loading", "eager");
  frame.style.cssText = "width:100%;min-height:700px;border:0;background:#0b0f18;display:block;border-radius:8px;overflow:hidden";
  frame.title = "UPS Commish Settings";
  mount.appendChild(frame);

  function escAttr(v) { return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/"/g, "&quot;"); }
  function buildHead(base, ctx) {
    return '<base href="' + escAttr(base) + '">' +
      '<script>' +
      'window.UPS_COMMISH_LEAGUE_ID=' + JSON.stringify(ctx.leagueId) + ';' +
      'window.UPS_COMMISH_YEAR=' + JSON.stringify(ctx.year) + ';' +
      'window.UPS_COMMISH_HOST=' + JSON.stringify(ctx.host) + ';' +
      'window.UPS_COMMISH_IS_COMMISH=' + JSON.stringify(!!ctx.isCommish) + ';' +
      '(function(){function post(){try{var h=Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0);parent.postMessage({type:"commish-settings-height",height:h},"*");}catch(e){}}' +
      'window.addEventListener("load",post);window.addEventListener("resize",post);' +
      'if(typeof ResizeObserver==="function"){try{new ResizeObserver(post).observe(document.documentElement);}catch(e){}}' +
      'setInterval(post,800);})();' +
      '<\/script>';
  }

  fetch(HTML_URL, { cache: "no-store" })
    .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
    .then(function (html) {
      var head = buildHead(ASSET_BASE, { leagueId: L, year: YEAR, host: HOST, isCommish: IS_COMMISH });
      html = /<head[^>]*>/i.test(html) ? html.replace(/<head([^>]*)>/i, '<head$1>' + head) : head + html;
      frame.srcdoc = html;
    })
    .catch(function (err) {
      mount.innerHTML = '<div style="padding:24px;color:#f88;font-family:sans-serif">Commish Settings failed to load: ' + escAttr(err.message) + '</div>';
    });

  window.addEventListener("message", function (ev) {
    if (ev && ev.data && ev.data.type === "commish-settings-height") {
      var h = Number(ev.data.height); if (h && h > 100) frame.style.minHeight = h + "px";
    }
  });
})();
