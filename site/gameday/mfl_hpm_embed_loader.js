/* Game Day — MFL HPM embed loader (mirrors site/commish/).
 *
 * Mounted by the header's MESSAGE19 hub container when ?hub=gameday.
 * Fetches gameday.html from jsDelivr at the release SHA, injects the
 * league/year/host/franchise context + a height beacon, renders via srcdoc.
 * The page itself resolves the viewer's franchise from MFL cookies when
 * FRANCHISE_ID isn't passed.
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
    // MFL sets this cookie for any logged-in owner — most reliable identity.
    try { var m = String(document.cookie || "").match(/(?:^|;\s*)MFL_LAST_LOGIN_FRANCHISE_ID=([^;]+)/i); if (m) { var p3 = pad4(m[1]); if (p3) return p3; } } catch (e) {}
    return "";
  }

  var L = getLeagueId(), YEAR = getYear(), FID = getFranchiseId();
  var HOST = safeStr(window.location && window.location.host) || "www48.myfantasyleague.com";
  // RELEASE SHA — AND WHY IT IS RE-RESOLVED HERE.
  // The header seeds window.UPS_RELEASE_SHA SYNCHRONOUSLY from sessionStorage
  // and only then fetches the current main SHA, so anything opened early in a
  // session loads from whatever commit that session first cached. jsDelivr
  // serves @<sha> immutably, so the stale pin sticks for the whole session:
  // merged fixes were live on Pages and on jsDelivr @main, and the embedded
  // Game Day still ran code from the previous day. Re-resolve it here, cheaply
  // (~one no-store request against GitHub's .sha media type), and fall back to
  // whatever we already had if that fails or is slow.
  var SHA = safeStr(window.UPS_RELEASE_SHA) || "main";
  function baseFor(sha) {
    return "https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@" + encodeURIComponent(sha) + "/site/gameday/";
  }
  function resolveSha() {
    return new Promise(function (done) {
      var settled = false;
      var finish = function (v) { if (!settled) { settled = true; done(v || SHA); } };
      // Never let SHA resolution delay the embed for long.
      setTimeout(function () { finish(SHA); }, 1500);
      try {
        fetch("https://api.github.com/repos/keithcreelman/upsmflproduction/commits/main", {
          headers: { Accept: "application/vnd.github.sha" }, cache: "no-store"
        }).then(function (r) { return r.ok ? r.text() : ""; }).then(function (t) {
          t = safeStr(t).trim();
          if (/^[0-9a-f]{7,40}$/i.test(t)) {
            try { window.UPS_RELEASE_SHA = t; sessionStorage.setItem("ups_release_sha_v1", t); } catch (e) {}
            finish(t);
          } else { finish(SHA); }
        }).catch(function () { finish(SHA); });
      } catch (e) { finish(SHA); }
    });
  }

  var mount = document.getElementById("gameDayMount") || (function () {
    var d = document.createElement("div"); d.id = "gameDayMount"; document.body.appendChild(d); return d;
  })();
  mount.innerHTML = "";
  var frame = document.createElement("iframe");
  frame.setAttribute("loading", "eager");
  frame.style.cssText = "width:100%;min-height:760px;border:0;background:#0b0f18;display:block;border-radius:8px;overflow:hidden";
  frame.title = "UPS Game Day";
  mount.appendChild(frame);

  function escAttr(v) { return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/"/g, "&quot;"); }
  function buildHead(base, ctx) {
    return '<base href="' + escAttr(base) + '">' +
      '<script>' +
      'window.UPS_GAMEDAY_LEAGUE_ID=' + JSON.stringify(ctx.leagueId) + ';' +
      'window.UPS_GAMEDAY_YEAR=' + JSON.stringify(ctx.year) + ';' +
      'window.UPS_GAMEDAY_HOST=' + JSON.stringify(ctx.host) + ';' +
      'window.UPS_GAMEDAY_FRANCHISE_ID=' + JSON.stringify(ctx.franchiseId) + ';' +
      '(function(){function post(){try{var h=Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0);parent.postMessage({type:"gameday-height",height:h},"*");}catch(e){}}' +
      'window.addEventListener("load",post);window.addEventListener("resize",post);' +
      'if(typeof ResizeObserver==="function"){try{new ResizeObserver(post).observe(document.documentElement);}catch(e){}}' +
      'setInterval(post,800);})();' +
      '<\/script>';
  }

  resolveSha().then(function (sha) {
  var ASSET_BASE = baseFor(sha);
  var HTML_URL = ASSET_BASE + "gameday.html?v=" + encodeURIComponent(sha);
  return fetch(HTML_URL, { cache: "no-store" })
    .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
    .then(function (html) {
      var head = buildHead(ASSET_BASE, { leagueId: L, year: YEAR, host: HOST, franchiseId: FID });
      html = /<head[^>]*>/i.test(html) ? html.replace(/<head([^>]*)>/i, '<head$1>' + head) : head + html;
      frame.srcdoc = html;
    })
    .catch(function (err) {
      mount.innerHTML = '<div style="padding:24px;color:#f88;font-family:sans-serif">Game Day failed to load: ' + escAttr(err.message) + '</div>';
    });
  });

  window.addEventListener("message", function (ev) {
    if (ev && ev.data && ev.data.type === "gameday-height") {
      var h = Number(ev.data.height); if (h && h > 100) frame.style.minHeight = h + "px";
    }
  });
})();
