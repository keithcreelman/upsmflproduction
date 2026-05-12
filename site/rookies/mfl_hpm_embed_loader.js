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
  // ── Detect MFL commish session ──
  // Runs on the OUTER MFL page where myfantasyleague.com cookies are
  // readable. MFL sets ISMFLCOMMISH on accounts with commissioner
  // privileges; it's also visible when an admin logs in as franchise
  // 0000 (the special "league owner" pseudo-franchise that doesn't have
  // its own roster). We sniff the cookie here and forward an explicit
  // is_commish signal into the iframe — the inner hub then forces the
  // Go LIVE toggle visible without depending on franchise_id matching
  // an allowlist.
  function detectIsCommish() {
    try {
      const c = String(document.cookie || "");
      // ISMFLCOMMISH=1 is the canonical MFL commish marker. Also catch
      // ISMFLCOMMISH=Y / true for safety.
      if (/(?:^|;\s*)ISMFLCOMMISH\s*=\s*(1|Y|true)/i.test(c)) return true;
    } catch (e) {}
    // Franchise 0000 is MFL's commish pseudo-franchise — owners never
    // see this fid because it's not a real team.
    if (FRANCHISE_ID === "0000") return true;
    return false;
  }
  const IS_COMMISH = detectIsCommish();

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
      'window.UPS_DRAFT_HUB_IS_COMMISH=' + JSON.stringify(!!ctx.isCommish) + ';' +
      'window.UPS_DRAFT_HUB_RELEASE_SHA=' + JSON.stringify(ctx.sha) + ';' +
      'window.UPS_DRAFT_HUB_API_BASE=' + JSON.stringify(ctx.apiBase) + ';' +
      // Parent URL — the iframe runs as srcdoc which makes window.location
      // resolve to about:srcdoc. Anywhere we want a "click here to open the
      // hub" link (e.g. R6 Discord announcements), we need the OUTER MFL
      // page URL. Loader sees it; iframe doesn't.
      'window.UPS_DRAFT_HUB_PARENT_URL=' + JSON.stringify(ctx.parentUrl || "") + ';' +
      // Post height back to host for auto-resize.
      // Inner-iframe height beacon. The OUTER MFL page sets the iframe
      // min-height from these messages. Without this the iframe can be
      // taller than its content (empty space below) OR shorter than its
      // content (content clipped, user can't scroll to the bottom of
      // long tabs like Future Picks or game logs).
      //
      // Triggers (priority order):
      //   1. window.load — initial sizing
      //   2. window.resize — viewport changes
      //   3. ResizeObserver on <html> — DOM mutations
      //   4. Tab clicks — immediate re-post so tab switches don't wait
      //      for the next setInterval tick (was 1.5s lag, enough to
      //      clip the visible content on a fast tab change)
      //   5. setInterval 600ms — safety net (was 1500ms; tightened to
      //      catch async content like fetched table rows faster)
      '(function(){function post(){try{var h=Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0);parent.postMessage({type:"draft-hub-height",height:h},"*");}catch(e){}}' +
      'window.addEventListener("load",post);window.addEventListener("resize",post);' +
      'if(typeof ResizeObserver==="function"){try{new ResizeObserver(post).observe(document.documentElement);}catch(e){}}' +
      // Tab nav click → re-post on the NEXT animation frame so the new
      // section is laid out before we measure.
      'document.addEventListener("click",function(e){var t=e.target&&e.target.closest&&e.target.closest("#rdh-tabs button[data-tab]");if(t){requestAnimationFrame(function(){requestAnimationFrame(post);});}},true);' +
      // Paginator clicks (next/prev) — same idea, content changes height.
      'document.addEventListener("click",function(e){var b=e.target&&e.target.closest&&e.target.closest("[data-page-action]");if(b){requestAnimationFrame(function(){requestAnimationFrame(post);});}},true);' +
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
      const headInject = buildHead(ASSET_BASE, { leagueId: L, year: YEAR, franchiseId: FRANCHISE_ID, isCommish: IS_COMMISH, sha: SHA, apiBase: API_BASE, parentUrl: safeStr(window.location && window.location.href) });
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

  // Auto-resize iframe to content height + scroll iframe into view when the
  // hub opens a modal (modals are positioned fixed inside the iframe; if the
  // iframe is taller than the parent viewport, the modal lands off-screen).
  window.addEventListener("message", function (ev) {
    if (!ev || !ev.data) return;
    if (ev.data.type === "draft-hub-height") {
      const h = Number(ev.data.height);
      if (h && h > 100) frame.style.minHeight = h + "px";
    } else if (ev.data.type === "draft-hub-modal-open") {
      try {
        // Scroll the iframe to top of the parent's viewport so the modal
        // (centered inside the iframe) lands in the visible area.
        frame.scrollIntoView({ behavior: "smooth", block: "start" });
      } catch (e) {}
    }
  });
})();
