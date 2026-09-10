/* UPS Wire - MFL HPM embed loader + router.
 *
 * Mounted by the header's MESSAGE19 hub container when ?hub=wire.
 * Mirrors site/gameday/mfl_hpm_embed_loader.js for context resolution and the
 * fetch-then-srcdoc trick, then adds the router on top.
 *
 * WHY FETCH-THEN-SRCDOC AND NOT iframe.src: jsDelivr serves .html as
 * text/plain with nosniff, so a direct src= renders the page as source text.
 * Documented at site/stats_workbench/mfl_hpm_embed_loader.js:4-6.
 *
 * WHY ONE IFRAME AND NOT TWO: an earlier design nested the article inside the
 * shell. Swapping what the single frame holds does the same job with one
 * height beacon instead of a relay, no cross-frame settling, and no Safari
 * srcdoc-reuse workaround at two levels. The shell and each article are both
 * complete documents, so either can be what the frame holds.
 *
 * WHY THE FRAME IS SANDBOXED (no allow-same-origin): article HTML will be
 * model-generated from Phase 3 on. Sandboxed, it cannot read MFL cookies or
 * act as the logged-in owner. UPS Wire is public read-only content and is
 * deliberately NOT given IS_COMMISH or MFL_USER_ID, so it gives up nothing.
 * The cost is that the frame has an opaque origin: no localStorage, no
 * history. Both live here instead, on the MFL page, where we are same-origin.
 *
 * ROUTE lives in the top-level URL hash:
 *   ...?MODULE=MESSAGE19&hub=wire#/a/2026-preseason-review/s3
 * The hash never reaches MFL's server, so it cannot be stripped or normalized
 * by a redirect. ?wire=<route> is accepted as a secondary input for
 * hand-written links but is never what we write.
 */
(function () {
  "use strict";

  var BUILD = "2026-07-28.1";
  if (window.__ups_wire_loader === BUILD) return;
  window.__ups_wire_loader = BUILD;

  var HEIGHT_SEED = 900;

  function pad4(v) { var d = String(v || "").replace(/\D/g, ""); return d ? d.padStart(4, "0").slice(-4) : ""; }
  function safeStr(v) { return String(v == null ? "" : v).trim(); }
  function getUrl() { try { return new URL(window.location.href); } catch (e) { return null; } }
  var u = getUrl();

  // ---------- context (same resolution chain as gameday) ----------
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
    if (u) {
      var p2 = pad4(u.searchParams.get("FRANCHISE_ID") || u.searchParams.get("FRANCHISE") || u.searchParams.get("F"));
      if (p2) return p2;
    }
    // MFL sets this cookie for any logged-in owner - most reliable identity.
    try {
      var m = String(document.cookie || "").match(/(?:^|;\s*)MFL_LAST_LOGIN_FRANCHISE_ID=([^;]+)/i);
      if (m) { var p3 = pad4(m[1]); if (p3) return p3; }
    } catch (e) {}
    return "";
  }

  var L = getLeagueId(), YEAR = getYear(), FID = getFranchiseId();
  var HOST = safeStr(window.location && window.location.host) || "www48.myfantasyleague.com";
  var SHA = safeStr(window.UPS_RELEASE_SHA) || "main";
  var ASSET_BASE = "https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@" + encodeURIComponent(SHA) + "/site/wire/";
  // The ONE place the GitHub Pages path shape is written down. Note Pages
  // strips the site/ prefix and jsDelivr keeps it - same file, two shapes.
  var PAGES_BASE = "https://keithcreelman.github.io/upsmflproduction/wire/";

  // Theme preference lives here because the sandboxed frame has no storage.
  function readTheme() {
    try { var t = window.localStorage.getItem("ups_wire_theme"); if (t === "dark" || t === "light") return t; } catch (e) {}
    return "dark"; // embedded default: MFL is dark, a cream article looks broken
  }

  // ---------- route grammar (must match wire_shell.js) ----------
  function parseRoute(str) {
    var s = safeStr(str).replace(/^#/, "");
    if (!s || s === "/") return { kind: "home" };
    var parts = s.replace(/^\//, "").split("/").filter(Boolean);
    if (parts[0] === "archive") return { kind: "archive" };
    if (parts[0] === "a") return { kind: "article", id: parts[1] || "", sectionId: parts[2] || "" };
    if (parts[0] === "f") {
      var r = { kind: "family", familyId: parts[1] || "", season: null, page: 1 };
      for (var i = 2; i < parts.length; i++) {
        if (/^p\d+$/.test(parts[i])) r.page = parseInt(parts[i].slice(1), 10) || 1;
        else if (/^\d{4}$/.test(parts[i])) r.season = parseInt(parts[i], 10);
      }
      return r;
    }
    return { kind: "home" };
  }
  function routeToString(r) {
    if (!r || r.kind === "home") return "/";
    if (r.kind === "archive") return "/archive";
    if (r.kind === "article") return "/a/" + r.id + (r.sectionId ? "/" + r.sectionId : "");
    var s = "/f/" + r.familyId;
    if (r.season) s += "/" + r.season;
    if (r.page && r.page > 1) s += "/p" + r.page;
    return s;
  }
  function readRouteFromUrl() {
    var h = safeStr(window.location.hash).replace(/^#/, "");
    if (h) return h;
    var q = u ? safeStr(u.searchParams.get("wire")) : "";
    return q || "/";
  }
  function writeHash(routeStr) {
    try {
      var next = window.location.pathname + window.location.search + "#" + routeStr;
      window.history.replaceState(null, "", next);
    } catch (e) {}
  }

  // ---------- mount ----------
  var mount = document.getElementById("wireMount") || (function () {
    var d = document.createElement("div"); d.id = "wireMount"; document.body.appendChild(d); return d;
  })();

  var frame = null;
  var state = { kind: "", articleId: "", sectionId: "", route: "/" };
  var indexPromise = null;
  var savedScrollY = 0;
  var lastTarget = null;

  function escAttr(v) { return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/"/g, "&quot;"); }
  function escHtml(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function makeFrame() {
    // Recreated on every document swap rather than reassigning srcdoc: Safari
    // retains stale layout height when a live iframe's srcdoc is replaced.
    if (frame && frame.parentNode) frame.parentNode.removeChild(frame);
    frame = document.createElement("iframe");
    frame.setAttribute("loading", "eager");
    // No allow-same-origin: that plus allow-scripts would let the frame remove
    // its own sandbox. allow-popups pair is needed for target="_blank" links.
    frame.setAttribute("sandbox", "allow-scripts allow-popups allow-popups-to-escape-sandbox");
    frame.style.cssText = "width:100%;min-height:" + HEIGHT_SEED +
      "px;border:0;background:#0C1310;display:block;border-radius:8px;overflow:hidden";
    frame.title = "UPS Wire";
    mount.appendChild(frame);
    return frame;
  }

  // ---------- head splice ----------
  function buildHead(base, ctx) {
    var g = "";
    function set(name, val) { g += "window.UPS_WIRE_" + name + "=" + JSON.stringify(val) + ";"; }
    set("LEAGUE_ID", L);
    set("YEAR", YEAR);
    set("HOST", HOST);
    set("FRANCHISE_ID", FID);
    set("SHA", SHA);
    set("ASSET_BASE", ASSET_BASE);
    set("PAGES_BASE", PAGES_BASE);
    set("THEME", ctx.theme);
    set("ROUTE", ctx.route);
    set("SECTION", ctx.sectionId || "");
    set("QUERY", safeStr(window.location.search));

    // Theme is applied HERE, not by the document, because the frame can hold
    // either the shell or an article and only articles run article_runtime.js.
    // Setting it in the injected head covers both with one implementation --
    // otherwise a light-OS reader gets a cream index inside a dark MFL page
    // while the articles stay dark, which reads as a broken page.
    var theme =
      'try{document.documentElement.setAttribute("data-theme",' +
      JSON.stringify(ctx.theme) + ');}catch(e){}';

    // One beacon serves both the shell and articles. Gated on an 8px delta so
    // the 800ms fallback tick is free when nothing is moving. Measured across
    // three properties because documentElement.scrollHeight alone gets sticky
    // when content shrinks (article -> back to a short index).
    var beacon =
      '(function(){var last=0;function post(){try{' +
      'var b=document.body,h=Math.max(document.documentElement.scrollHeight,' +
      'b?b.scrollHeight:0,b?b.offsetHeight:0);' +
      'if(Math.abs(h-last)<=8)return;last=h;' +
      'parent.postMessage({type:"wire-height",height:h},"*");}catch(e){}}' +
      'window.addEventListener("load",post);window.addEventListener("resize",post);' +
      'if(typeof ResizeObserver==="function"){try{new ResizeObserver(post).observe(document.documentElement);}catch(e){}}' +
      'setInterval(post,800);})();';

    return '<base href="' + escAttr(base) + '">' +
      '<script>' + g + theme + beacon + '<\/script>';
  }

  // ---------- index.json (only needed to resolve a cold article deep link) ----------
  function loadIndex() {
    if (indexPromise) return indexPromise;
    indexPromise = fetch(ASSET_BASE + "index.json?v=" + encodeURIComponent(SHA), { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("index.json HTTP " + r.status); return r.json(); });
    return indexPromise;
  }

  // Resolve a route to the document the frame should hold.
  // `hint` is what the shell passed along on a click, which saves the fetch.
  function targetFor(route, hint) {
    var routeStr = routeToString(route);
    if (route.kind !== "article") {
      return Promise.resolve({
        kind: "shell",
        url: ASSET_BASE + "index.html?v=" + encodeURIComponent(SHA),
        base: ASSET_BASE,
        route: routeStr,
        articleId: "",
        sectionId: ""
      });
    }
    function build(path, contentHash) {
      var abs;
      try { abs = new URL(path, ASSET_BASE).href; } catch (e) { abs = ASSET_BASE + path; }
      var dir = abs.replace(/[^/]*$/, "");
      return {
        kind: "article",
        // ?v=<contentHash> is what busts jsDelivr for articles, which is why
        // they are deliberately NOT in purge-jsdelivr.yml (that list is
        // hand-maintained and only matters for @main URLs).
        url: abs + "?v=" + encodeURIComponent(contentHash || SHA),
        base: dir,
        route: routeStr,
        articleId: route.id,
        sectionId: route.sectionId || ""
      };
    }
    if (hint && hint.path) return Promise.resolve(build(hint.path, hint.contentHash));
    return loadIndex().then(function (idx) {
      var hits = (idx.articles || []).filter(function (a) { return a.id === route.id; });
      if (!hits.length) throw new Error("No article with id " + route.id);
      return build(hits[0].path, hits[0].contentHash);
    });
  }

  // ---------- error state, rendered INTO the frame ----------
  function showError(message, url) {
    var f = makeFrame();
    var doc =
      '<!doctype html><html><head><meta charset="utf-8">' +
      '<style>body{margin:0;background:#0C1310;color:#A3AFA8;' +
      'font:16px Georgia,serif;padding:2rem}h1{font:700 0.7rem/1 ui-sans-serif,system-ui;' +
      'letter-spacing:.14em;text-transform:uppercase;color:#C4574A;margin:0 0 .6rem}' +
      'code{font:12px ui-monospace,Menlo,monospace;color:#75837B;word-break:break-all;display:block;margin:.8rem 0}' +
      'button{font:700 0.64rem/1 ui-sans-serif,system-ui;letter-spacing:.12em;text-transform:uppercase;' +
      'color:#D6A24A;background:none;border:1px solid #8A6A31;padding:.45rem .8rem;cursor:pointer}' +
      '</style></head><body>' +
      '<div style="border-left:3px solid #C4574A;background:#141C18;padding:1.5rem">' +
      '<h1>The Wire could not load</h1><div>' + escHtml(message) + '</div>' +
      (url ? '<code>' + escHtml(url) + '</code>' : '') +
      '<button id="r" type="button">Try again</button></div>' +
      '<script>document.getElementById("r").addEventListener("click",function(){' +
      'parent.postMessage({type:"wire-retry"},"*");});<\/script>' +
      '</body></html>';
    f.srcdoc = doc;
  }

  // ---------- render ----------
  function renderTarget(target) {
    lastTarget = target;
    var f = makeFrame();
    return fetch(target.url, { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
      .then(function (html) {
        var head = buildHead(target.base, {
          theme: readTheme(),
          route: target.route,
          sectionId: target.sectionId
        });
        html = /<head[^>]*>/i.test(html)
          ? html.replace(/<head([^>]*)>/i, "<head$1>" + head)
          : head + html;
        f.srcdoc = html;
        state.kind = target.kind;
        state.articleId = target.articleId;
        state.sectionId = target.sectionId;
        state.route = target.route;
      })
      .catch(function (err) { showError(err.message, target.url); });
  }

  function navigate(route, hint) {
    var wantKind = route.kind === "article" ? "article" : "shell";
    var routeStr = routeToString(route);

    // Same document, different view: the shell moved between index views, or
    // the article changed section. Update the address bar and stop -- swapping
    // the document would refetch and flash for nothing.
    var sameDoc = wantKind === state.kind &&
      !(wantKind === "article" && route.id !== state.articleId);
    if (sameDoc) {
      state.route = routeStr;
      if (wantKind === "article") state.sectionId = route.sectionId || "";
      writeHash(routeStr);
      return;
    }

    // Crossing the boundary. Remember where the reader was on the index so
    // Back lands there; the frame auto-sizes, so the thing that scrolls is the
    // MFL page, and that is ours to save.
    if (state.kind === "shell" && wantKind === "article") {
      savedScrollY = window.pageYOffset || 0;
    }

    writeHash(routeStr);
    targetFor(route, hint)
      .then(renderTarget)
      .then(function () {
        if (wantKind === "shell" && savedScrollY) {
          var y = savedScrollY; savedScrollY = 0;
          setTimeout(function () { try { window.scrollTo(0, y); } catch (e) {} }, 60);
        } else if (wantKind === "article") {
          setTimeout(function () {
            try {
              var top = mount.getBoundingClientRect().top + (window.pageYOffset || 0);
              window.scrollTo(0, Math.max(0, top - 12));
            } catch (e) {}
          }, 60);
        }
      })
      .catch(function (err) { showError(err.message, ""); });
  }

  // ---------- messages ----------
  window.addEventListener("message", function (ev) {
    // Only trust our own frame. Origin is "null" (sandboxed, opaque) so it is
    // not usable as a check; the source window identity is.
    if (!frame || !ev || ev.source !== frame.contentWindow) return;
    var d = ev.data;
    if (!d || typeof d.type !== "string") return;

    if (d.type === "wire-height") {
      var h = Number(d.height);
      if (h && h > 100) frame.style.minHeight = h + "px";
      return;
    }
    if (d.type === "wire-route") {
      navigate(parseRoute(d.route), d);
      return;
    }
    if (d.type === "wire-section") {
      // Only the article knows it changed section; only we know which article.
      if (state.kind !== "article" || !state.articleId) return;
      state.sectionId = safeStr(d.sectionId);
      writeHash("/a/" + state.articleId + (state.sectionId ? "/" + state.sectionId : ""));
      return;
    }
    if (d.type === "wire-retry") {
      if (lastTarget) renderTarget(lastTarget);
      else navigate(parseRoute(readRouteFromUrl()), null);
      return;
    }
  });

  // A reader editing the hash by hand, or arriving on a shared deep link that
  // the browser resolves after we booted.
  window.addEventListener("hashchange", function () {
    var r = parseRoute(readRouteFromUrl());
    if (routeToString(r) === state.route) return;
    navigate(r, null);
  });

  navigate(parseRoute(readRouteFromUrl()), null);
})();
