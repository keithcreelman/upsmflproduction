/* Auction Hub — MFL HPM (Home Page Manager) embed loader.
 *
 * Mirrors site/rookies/mfl_hpm_embed_loader.js. Mount it from the MFL
 * MESSAGE page that hosts the Auction Hub:
 *
 *   <div id="auctionHubMount"></div>
 *   <script src="https://keithcreelman.github.io/upsmflproduction/auction/mfl_hpm_embed_loader.js"></script>
 *
 * The loader fetches auction_hub.html from GitHub Pages, injects context
 * globals + a height-beacon script into <head>, and renders it via
 * iframe.srcdoc so relative .css/.js/.json paths resolve against the
 * GitHub Pages base.
 */
(function () {
  "use strict";

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

  function detectIsCommish() {
    try {
      const c = String(document.cookie || "");
      if (/(?:^|;\s*)ISMFLCOMMISH\s*=\s*(1|Y|true)/i.test(c)) return true;
    } catch (e) {}
    if (FRANCHISE_ID === "0000") return true;
    return false;
  }
  const IS_COMMISH = detectIsCommish();

  const SHA = safeStr(window.UPS_AUCTION_HUB_RELEASE_SHA || window.UPS_RELEASE_SHA) || "main";
  // Resolve assets through jsDelivr so feature-branch SHAs work without
  // a main merge. GitHub Pages only serves main; jsDelivr serves any
  // commit on demand. Same pattern as header_custom_v2.html's hub
  // container auto-bootstrap.
  const ASSET_BASE = "https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@" +
    encodeURIComponent(SHA) + "/site/auction/";
  const HTML_URL = ASSET_BASE + "auction_hub.html?v=" + encodeURIComponent(SHA);
  const API_BASE = safeStr(window.UPS_AUCTION_HUB_API_BASE) || "https://upsmflproduction.keith-creelman.workers.dev";

  const mount = document.getElementById("auctionHubMount") || (function () {
    const d = document.createElement("div");
    d.id = "auctionHubMount";
    document.body.appendChild(d);
    return d;
  })();

  mount.innerHTML = "";
  const frame = document.createElement("iframe");
  frame.setAttribute("loading", "eager");
  frame.setAttribute("allow", "clipboard-read; clipboard-write");
  frame.style.cssText = [
    "width:100%",
    "min-height:1200px",
    "border:0",
    "background:#0b0f18",
    "display:block",
    "border-radius:8px",
    "overflow:hidden",
  ].join(";");
  frame.title = "UPS Auction Hub";
  mount.appendChild(frame);

  function escapeAttr(v) {
    return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  }

  function buildHead(baseHref, ctx) {
    return (
      '<base href="' + escapeAttr(baseHref) + '">' +
      '<script>' +
      'window.UPS_AUCTION_HUB_LEAGUE_ID=' + JSON.stringify(ctx.leagueId) + ';' +
      'window.UPS_AUCTION_HUB_YEAR=' + JSON.stringify(ctx.year) + ';' +
      'window.UPS_AUCTION_HUB_FRANCHISE_ID=' + JSON.stringify(ctx.franchiseId) + ';' +
      'window.UPS_AUCTION_HUB_IS_COMMISH=' + JSON.stringify(!!ctx.isCommish) + ';' +
      'window.UPS_AUCTION_HUB_RELEASE_SHA=' + JSON.stringify(ctx.sha) + ';' +
      'window.UPS_AUCTION_HUB_API_BASE=' + JSON.stringify(ctx.apiBase) + ';' +
      'window.UPS_AUCTION_HUB_PARENT_URL=' + JSON.stringify(ctx.parentUrl || "") + ';' +
      // Height beacon — outer page resizes the iframe to match content.
      '(function(){function post(){try{var h=Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0);parent.postMessage({type:"auction-hub-height",height:h},"*");}catch(e){}}' +
      'window.addEventListener("load",post);window.addEventListener("resize",post);' +
      'if(typeof ResizeObserver==="function"){try{new ResizeObserver(post).observe(document.documentElement);}catch(e){}}' +
      // Tab nav click → re-post on the NEXT animation frame.
      'document.addEventListener("click",function(e){var t=e.target&&e.target.closest&&e.target.closest("#ah-tabs button[data-tab]");if(t){requestAnimationFrame(function(){requestAnimationFrame(post);});}},true);' +
      'setInterval(post,600);' +
      '})();' +
      '<\/script>'
    );
  }

  fetch(HTML_URL, { cache: "no-store" })
    .then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.text();
    })
    .then(function (html) {
      const headInject = buildHead(ASSET_BASE, {
        leagueId: L, year: YEAR, franchiseId: FRANCHISE_ID,
        isCommish: IS_COMMISH, sha: SHA, apiBase: API_BASE,
        parentUrl: safeStr(window.location && window.location.href),
      });
      if (/<head[^>]*>/i.test(html)) {
        html = html.replace(/<head([^>]*)>/i, '<head$1>' + headInject);
      } else {
        html = headInject + html;
      }
      frame.srcdoc = html;
    })
    .catch(function (err) {
      mount.innerHTML = '<div style="padding:24px;color:#f88;font-family:sans-serif">Auction Hub failed to load: ' + escapeAttr(err.message) + '</div>';
    });

  window.addEventListener("message", function (ev) {
    if (!ev || !ev.data) return;
    if (ev.data.type === "auction-hub-height") {
      const h = Number(ev.data.height);
      if (h && h > 100) frame.style.minHeight = h + "px";
    }
  });
})();
