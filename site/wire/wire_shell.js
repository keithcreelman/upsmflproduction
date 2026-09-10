/* UPS Wire -- shell (index) renderer + router.
 *
 * EXTERNAL on purpose. scripts/check_inline_js.mjs syntax-checks every inline
 * <script> under site/**\/*.html because one unescaped apostrophe in a prose
 * string once shipped Commish Settings broken for hours. A hub whose whole
 * point is league prose must keep that prose out of JS entirely: article
 * titles and deks live in index.json, are fetched, and are written with
 * textContent. Nothing here ever concatenates data into an HTML string.
 *
 * WHAT THIS FILE DOES NOT DO: render articles. Crossing the index/article
 * boundary is the loader's job -- it swaps what the single iframe holds. This
 * file only renders the index and tells the loader where the reader wants to
 * go. See site/wire/mfl_hpm_embed_loader.js.
 *
 * Two contexts, one code path:
 *   embedded   (inside MFL) - route comes from window.UPS_WIRE_ROUTE, and
 *                             navigation is postMessage upward. The frame has
 *                             an opaque origin (sandboxed, no allow-same-origin)
 *                             so it has no history and no localStorage.
 *   standalone (Pages URL)  - route comes from location.hash, navigation is
 *                             history.replaceState, and opening an article is
 *                             a real page load.
 */
(function () {
  "use strict";

  var PAGE_SIZE = 12;

  var embedded = false;
  try { embedded = window.parent !== window; } catch (e) { embedded = true; }

  var els = {
    mast: document.getElementById("wireMast"),
    body: document.getElementById("wireBody")
  };

  var data = null;
  var route = { kind: "home" };

  // ---------- tiny DOM helpers. textContent only; never innerHTML. ----------
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function btn(cls, text) {
    var b = el("button", cls, text);
    b.setAttribute("type", "button");
    return b;
  }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  // ---------- routing ----------
  function parseRoute(str) {
    var s = String(str == null ? "" : str).trim().replace(/^#/, "");
    if (!s || s === "/") return { kind: "home" };
    var parts = s.replace(/^\//, "").split("/").filter(Boolean);
    if (parts[0] === "archive") return { kind: "archive" };
    if (parts[0] === "a") return { kind: "article", id: parts[1] || "", sectionId: parts[2] || "" };
    if (parts[0] === "f") {
      var r = { kind: "family", familyId: parts[1] || "", season: null, page: 1 };
      for (var i = 2; i < parts.length; i++) {
        var p = parts[i];
        if (/^p\d+$/.test(p)) r.page = parseInt(p.slice(1), 10) || 1;
        else if (/^\d{4}$/.test(p)) r.season = parseInt(p, 10);
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

  function post(msg) {
    if (!embedded) return;
    try { window.parent.postMessage(msg, "*"); } catch (e) {}
  }

  // Internal navigation: stays inside the shell document, so the loader is told
  // the new route only so the MFL address bar tracks it -- it must NOT reload.
  function go(r) {
    route = r;
    var str = routeToString(r);
    if (embedded) post({ type: "wire-route", route: str });
    else { try { history.replaceState(null, "", "#" + str); } catch (e) {} }
    render();
    try { window.scrollTo(0, 0); } catch (e) {}
  }

  // Crossing into an article. Embedded, the loader swaps the frame's document.
  // Standalone, it is an ordinary page load to the article's own URL -- which
  // is exactly why articles are self-contained files.
  function openArticle(a) {
    if (embedded) { post({ type: "wire-route", route: "/a/" + a.id }); return; }
    try { window.location.href = new URL(a.path, document.baseURI).href; }
    catch (e) { window.location.href = a.path; }
  }

  // ---------- data selectors ----------
  function visibleArticles() {
    var preview = false;
    try { preview = /(?:^|[?&])preview=1(?:&|$)/.test(String(window.UPS_WIRE_QUERY || "")); } catch (e) {}
    return (data.articles || [])
      .filter(function (a) { return a.status === "live" || (preview && a.status === "draft"); })
      .slice()
      .sort(function (x, y) { return String(y.publishedAt).localeCompare(String(x.publishedAt)); });
  }
  function families() {
    return (data.families || []).slice().sort(function (x, y) { return (x.order || 0) - (y.order || 0); });
  }
  function familyById(id) {
    var f = families().filter(function (x) { return x.id === id; });
    return f.length ? f[0] : null;
  }

  // ---------- pieces ----------
  function articleCard(a, opts) {
    opts = opts || {};
    var card = btn("wire-icard" + (opts.lead ? " wire-lead" : ""), null);
    card.setAttribute("aria-label", a.title);

    card.appendChild(el("span", "wire-icard-kicker", a.kicker || ""));
    card.appendChild(el("h2", "wire-icard-title", a.title || "Untitled"));
    if (a.dek) card.appendChild(el("p", "wire-icard-dek", a.dek));

    if (opts.lead && a.hero && a.hero.value) {
      var hero = el("div", "wire-lead-hero", String(a.hero.value));
      hero.appendChild(el("small", null, String(a.hero.label || "")));
      card.appendChild(hero);
    }

    var meta = el("div", "wire-icard-meta");
    var fam = familyById(a.familyId);
    if (fam) meta.appendChild(el("span", null, fam.title));
    if (a.season) meta.appendChild(el("span", null, a.week ? a.season + " wk " + a.week : String(a.season)));
    if (a.readMinutes) meta.appendChild(el("span", null, a.readMinutes + " min"));
    if (a.sections && a.sections.length) meta.appendChild(el("span", null, a.sections.length + " sections"));
    if (a.status === "draft") meta.appendChild(el("span", "wire-draft", "Draft"));
    card.appendChild(meta);

    if (opts.lead && a.sections && a.sections.length) {
      card.appendChild(el("p", "wire-icard-chapters", a.sections.map(function (s) { return s.title; }).join("  \u00B7  ")));
    }

    card.addEventListener("click", function () { openArticle(a); });
    return card;
  }

  function renderMast() {
    clear(els.mast);
    var mast = el("div", "wire-mast");
    var wm = el("h1", "wire-wordmark", "UPS ");
    wm.appendChild(el("span", null, "Wire"));
    mast.appendChild(wm);
    mast.appendChild(el("p", "wire-tagline",
      "The league paper. Season reviews, weekly recaps and previews, and every trade the bot had something to say about."));

    var nav = el("nav", "wire-nav");
    var home = btn("wire-navbtn", "Front Page");
    if (route.kind === "home") home.setAttribute("aria-current", "true");
    home.addEventListener("click", function () { go({ kind: "home" }); });
    nav.appendChild(home);

    families().forEach(function (f) {
      var b = btn("wire-navbtn", f.title);
      if (route.kind === "family" && route.familyId === f.id) b.setAttribute("aria-current", "true");
      b.addEventListener("click", function () { go({ kind: "family", familyId: f.id, season: null, page: 1 }); });
      nav.appendChild(b);
    });

    var arch = btn("wire-navbtn", "Archive");
    if (route.kind === "archive") arch.setAttribute("aria-current", "true");
    arch.addEventListener("click", function () { go({ kind: "archive" }); });
    nav.appendChild(arch);

    mast.appendChild(nav);
    els.mast.appendChild(mast);
  }

  function renderHome() {
    var all = visibleArticles();
    if (!all.length) { els.body.appendChild(emptyCard("Nothing published yet.")); return; }

    els.body.appendChild(articleCard(all[0], { lead: true }));

    var rest = all.slice(1, 5);
    if (rest.length) {
      var grid = el("div", "wire-grid");
      rest.forEach(function (a) { grid.appendChild(articleCard(a)); });
      els.body.appendChild(grid);
    }

    families().forEach(function (f) {
      var mine = all.filter(function (a) { return a.familyId === f.id; });
      if (!mine.length) return;
      els.body.appendChild(familyRail(f, mine));
    });
  }

  function familyRail(f, mine) {
    var sec = el("section");
    var head = el("div", "wire-railhead");
    var left = el("div");
    left.appendChild(el("h2", null, f.title));
    if (f.blurb) left.appendChild(el("p", null, f.blurb));
    head.appendChild(left);
    if (mine.length > 3) {
      var see = btn("wire-seeall", "See all " + mine.length + " \u203A");
      see.addEventListener("click", function () { go({ kind: "family", familyId: f.id, season: null, page: 1 }); });
      head.appendChild(see);
    }
    sec.appendChild(head);
    var grid = el("div", "wire-grid");
    mine.slice(0, 3).forEach(function (a) { grid.appendChild(articleCard(a)); });
    sec.appendChild(grid);
    return sec;
  }

  function renderFamily() {
    var f = familyById(route.familyId);
    if (!f) { els.body.appendChild(emptyCard("No such section.")); return; }

    var mine = visibleArticles().filter(function (a) { return a.familyId === f.id; });
    var seasons = [];
    mine.forEach(function (a) { if (a.season && seasons.indexOf(a.season) < 0) seasons.push(a.season); });
    seasons.sort(function (x, y) { return y - x; });

    var head = el("div", "wire-railhead");
    var left = el("div");
    left.appendChild(el("h2", null, f.title));
    if (f.blurb) left.appendChild(el("p", null, f.blurb));
    head.appendChild(left);
    els.body.appendChild(head);

    if (seasons.length > 1) {
      var chips = el("nav", "wire-nav");
      var allBtn = btn("wire-navbtn", "All seasons");
      if (!route.season) allBtn.setAttribute("aria-current", "true");
      allBtn.addEventListener("click", function () { go({ kind: "family", familyId: f.id, season: null, page: 1 }); });
      chips.appendChild(allBtn);
      seasons.forEach(function (s) {
        var b = btn("wire-navbtn", String(s));
        if (route.season === s) b.setAttribute("aria-current", "true");
        b.addEventListener("click", function () { go({ kind: "family", familyId: f.id, season: s, page: 1 }); });
        chips.appendChild(b);
      });
      els.body.appendChild(chips);
    }

    if (route.season) mine = mine.filter(function (a) { return a.season === route.season; });
    if (!mine.length) { els.body.appendChild(emptyCard("Nothing here yet.")); return; }

    var pages = Math.max(1, Math.ceil(mine.length / PAGE_SIZE));
    var page = Math.min(Math.max(1, route.page || 1), pages);
    var grid = el("div", "wire-grid");
    mine.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).forEach(function (a) { grid.appendChild(articleCard(a)); });
    els.body.appendChild(grid);

    if (pages > 1) els.body.appendChild(pager(f, page, pages));
  }

  function pager(f, page, pages) {
    var nav = el("div", "wire-pager");
    var newer = btn("wire-pagebtn", "\u2039 Newer");
    newer.disabled = page <= 1;
    newer.addEventListener("click", function () { go({ kind: "family", familyId: f.id, season: route.season, page: page - 1 }); });
    var older = btn("wire-pagebtn", "Older \u203A");
    older.disabled = page >= pages;
    older.addEventListener("click", function () { go({ kind: "family", familyId: f.id, season: route.season, page: page + 1 }); });
    nav.appendChild(newer);
    nav.appendChild(el("span", "wire-pagecount", page + " / " + pages));
    nav.appendChild(older);
    return nav;
  }

  function renderArchive() {
    var all = visibleArticles();
    els.body.appendChild(el("h2", "wire-sechead", "Archive"));

    var filter = document.createElement("input");
    filter.className = "wire-filter";
    filter.setAttribute("type", "text");
    filter.setAttribute("placeholder", "Filter by title, section or tag");
    els.body.appendChild(filter);

    var wrap = el("div", "wire-tablewrap");
    var table = document.createElement("table");
    var thead = document.createElement("thead");
    var hrow = document.createElement("tr");
    ["Title", "Section", "Season", "Week", "Published"].forEach(function (h, i) {
      var th = el("th", i >= 2 ? "wire-num" : null, h);
      hrow.appendChild(th);
    });
    thead.appendChild(hrow);
    table.appendChild(thead);
    var tbody = document.createElement("tbody");
    table.appendChild(tbody);
    wrap.appendChild(table);
    els.body.appendChild(wrap);

    function draw(q) {
      clear(tbody);
      var needle = String(q || "").toLowerCase();
      var rows = all.filter(function (a) {
        if (!needle) return true;
        var hay = [a.title, a.dek, a.kicker, (a.tags || []).join(" "),
                   (a.sections || []).map(function (s) { return s.title; }).join(" ")].join(" ").toLowerCase();
        return hay.indexOf(needle) >= 0;
      });
      if (!rows.length) {
        var tr0 = document.createElement("tr");
        var td0 = el("td", null, "Nothing matches that.");
        td0.setAttribute("colspan", "5");
        tr0.appendChild(td0);
        tbody.appendChild(tr0);
        return;
      }
      rows.forEach(function (a) {
        var tr = el("tr", "wire-arow");
        tr.appendChild(el("td", "wire-owner", a.title));
        var fam = familyById(a.familyId);
        tr.appendChild(el("td", "wire-comp", fam ? fam.title : a.familyId));
        tr.appendChild(el("td", "wire-num", a.season ? String(a.season) : "\u2014"));
        tr.appendChild(el("td", "wire-num", a.week ? String(a.week) : "\u2014"));
        tr.appendChild(el("td", "wire-num", String(a.publishedAt || "").slice(0, 10)));
        tr.addEventListener("click", function () { openArticle(a); });
        tbody.appendChild(tr);
      });
    }

    filter.addEventListener("input", function () { draw(filter.value); });
    draw("");
  }

  function emptyCard(msg) { return el("div", "wire-empty", msg); }

  function errorCard(msg, url, retry) {
    var box = el("div", "wire-error");
    box.appendChild(el("h2", null, "The Wire could not load"));
    box.appendChild(el("p", null, msg));
    if (url) box.appendChild(el("code", null, url));
    if (retry) {
      var b = btn("wire-retry", "Try again");
      b.addEventListener("click", retry);
      box.appendChild(b);
    }
    return box;
  }

  // ---------- render ----------
  function render() {
    renderMast();
    clear(els.body);
    if (!data) return;
    // An article route reaching the shell means the loader did not intercept
    // it. Falling back to the front page beats rendering nothing.
    if (route.kind === "article") route = { kind: "home" };
    if (route.kind === "family") renderFamily();
    else if (route.kind === "archive") renderArchive();
    else renderHome();
  }

  // ---------- boot ----------
  function initialRoute() {
    if (embedded) return parseRoute(window.UPS_WIRE_ROUTE || "/");
    return parseRoute(window.location.hash || "/");
  }

  function load() {
    // document.baseURI, never a hardcoded path: jsDelivr keeps the /site/
    // prefix and GitHub Pages strips it, so the same file has two path shapes.
    // Deriving from the base is what absorbs that.
    var url;
    try { url = new URL("index.json", document.baseURI).href; } catch (e) { url = "index.json"; }

    clear(els.body);
    els.body.appendChild(el("div", "wire-empty", "Loading\u2026"));

    fetch(url, { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (json) {
        data = json;
        route = initialRoute();
        render();
      })
      .catch(function (err) {
        data = null;
        renderMast();
        clear(els.body);
        els.body.appendChild(errorCard(
          "The article index did not load: " + err.message, url, load));
      });
  }

  if (!embedded) {
    window.addEventListener("hashchange", function () {
      if (!data) return;
      route = parseRoute(window.location.hash || "/");
      render();
    });
  }

  load();
})();
