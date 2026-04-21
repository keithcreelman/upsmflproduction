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
  // jsDelivr serves .html with Content-Type: text/plain (+ nosniff), so an iframe
  // src pointing directly at the HTML would render the markup as text. Work
  // around that by fetching the HTML as text, injecting a <base> (so relative
  // .css/.js/.json paths resolve against jsDelivr) plus context globals, and
  // feeding it to the iframe via srcdoc — which renders regardless of the
  // source's Content-Type.
  const ASSET_BASE = "https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@" + SHA + "/site/rookies/";
  const HTML_URL = ASSET_BASE + "rookie_draft_hub.html?v=" + encodeURIComponent(SHA);
  // Live MFL enrichment (/api/player-bundle etc.) is served by the
  // Cloudflare Worker so every league member gets it — no local bridge
  // required. Host page can override via window.UPS_DRAFT_HUB_API_BASE.
  const API_BASE = safeStr(window.UPS_DRAFT_HUB_API_BASE) || "https://upsmflproduction.keith-creelman.workers.dev";

  // Mount point ────────────────────────────────────────────────────────
  const mount = document.getElementById("draftHubMount") || (function () {
    const d = document.createElement("div");
    d.id = "draftHubMount";
    document.body.appendChild(d);
    return d;
  })();

  mount.innerHTML = "";
  const frame = document.createElement("iframe");
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

  function escapeAttr(v) {
    return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  }

  function buildHead(baseHref, ctx) {
    return (
      '<base href="' + escapeAttr(baseHref) + '">' +
      '<script>' +
      'window.UPS_DRAFT_HUB_LEAGUE_ID=' + JSON.stringify(ctx.leagueId) + ';' +
      'window.UPS_DRAFT_HUB_YEAR=' + JSON.stringify(ctx.year) + ';' +
      'window.UPS_DRAFT_HUB_FRANCHISE_ID=' + JSON.stringify(ctx.franchiseId) + ';' +
      'window.UPS_DRAFT_HUB_RELEASE_SHA=' + JSON.stringify(ctx.sha) + ';' +
      'window.UPS_DRAFT_HUB_API_BASE=' + JSON.stringify(ctx.apiBase) + ';' +
      // Post height back to host for auto-resize.
      '(function(){function post(){try{var h=Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0);parent.postMessage({type:"draft-hub-height",height:h},"*");}catch(e){}}' +
      'window.addEventListener("load",post);window.addEventListener("resize",post);' +
      'if(typeof ResizeObserver==="function"){try{new ResizeObserver(post).observe(document.documentElement);}catch(e){}}' +
      'setInterval(post,1500);' +
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
      const headInject = buildHead(ASSET_BASE, { leagueId: L, year: YEAR, franchiseId: FRANCHISE_ID, sha: SHA, apiBase: API_BASE });
      if (/<head[^>]*>/i.test(html)) {
        html = html.replace(/<head([^>]*)>/i, '<head$1>' + headInject);
      } else {
        html = headInject + html;
      }
      frame.srcdoc = html;
    })
    .catch(function (err) {
      mount.innerHTML = '<div style="padding:24px;color:#f88;font-family:sans-serif">Rookie Draft Hub failed to load: ' + escapeAttr(err.message) + '</div>';
    });

  // Auto-resize iframe to content height.
  window.addEventListener("message", function (ev) {
    if (!ev || !ev.data || ev.data.type !== "draft-hub-height") return;
    const h = Number(ev.data.height);
    if (h && h > 100) frame.style.minHeight = h + "px";
  });
})();
