/* UPS Wire -- article runtime. CANONICAL SOURCE.
 *
 * This file is INLINED verbatim into every article by the builder. It is
 * byte-identical across every article and contains ZERO article prose -- that
 * is deliberate and load-bearing:
 *
 *   scripts/check_inline_js.mjs syntax-checks every inline <script> under
 *   site/**\/*.html. It exists because one unescaped apostrophe in a tooltip
 *   string shipped Commish Settings broken for hours. A hub full of league
 *   prose is exactly the thing that breaks it. So: prose lives in markup and
 *   in index.json, never in a JS string. Section titles are read from
 *   data-title attributes and written with textContent, never concatenated
 *   into HTML.
 *
 * Non-ASCII is written as \u escapes (same convention as header_custom_v2.html)
 * because jsDelivr serves .html as text/plain and the charset round-trip
 * through fetch() -> srcdoc is not worth trusting. See docs: MFL mojibake.
 *
 * Responsibilities (four, and only these):
 *   1. Flag embedded vs standalone, and apply the theme the loader chose.
 *   2. Wire the Back bar (embedded: postMessage; standalone: navigate).
 *   3. Build the chapter rail and the end-of-section pager, and page between
 *      sections.
 *   4. Report section changes upward so the MFL hash tracks what you're reading.
 *
 * The height beacon is NOT here -- the loader injects one beacon that serves
 * both the shell and articles, so there is a single implementation.
 *
 * Graceful degradation is the default state, not a fallback: without JS every
 * section is display:block and the article reads as one continuous scroll.
 * That covers printing, a locked-down Artifact sandbox, and a failed fetch.
 */
(function () {
  "use strict";

  var docEl = document.documentElement;

  var embedded = false;
  try { embedded = window.parent !== window; } catch (e) { embedded = true; }

  function post(msg) {
    if (!embedded) return;
    try { window.parent.postMessage(msg, "*"); } catch (e) {}
  }

  // 1. Theme -- FALLBACK ONLY. When embedded, the loader already stamped
  //    data-theme into the injected head, because it has to cover the index
  //    shell too and the shell does not run this file. This line matters only
  //    if some other host sets UPS_WIRE_THEME without stamping the attribute.
  //    Standalone, UPS_WIRE_THEME is absent and prefers-color-scheme wins.
  var theme = String(window.UPS_WIRE_THEME || "");
  if (theme === "dark" || theme === "light") docEl.setAttribute("data-theme", theme);
  if (embedded) docEl.classList.add("wire-embedded");

  // 2. Top nav. Only visible when embedded (CSS: .wire-embedded .wire-topbar).
  //    Every button carries data-wire-goto with a shell route ("/", "/f/<id>",
  //    ...) so a reader deep in one article can jump straight to Front Page,
  //    Previews, or The Week without detouring back through "All stories"
  //    first. Embedded, the loader owns navigation and already understands
  //    every route shape the shell does (mfl_hpm_embed_loader.js parseRoute);
  //    standalone, this file has no router of its own, so it hands off to the
  //    shell page's own hash-based one.
  var navBtns = [].slice.call(document.querySelectorAll("[data-wire-goto]"));
  navBtns.forEach(function (b) {
    var goto = b.getAttribute("data-wire-goto") || "/";
    b.addEventListener("click", function () {
      if (embedded) { post({ type: "wire-route", route: goto }); return; }
      // Standalone: UPS_WIRE_PAGES_BASE is the one place the Pages path shape
      // is written down. The relative fallback covers an Artifact or any host
      // that never set it.
      var base = String(window.UPS_WIRE_PAGES_BASE || "../../");
      window.location.href = goto === "/" ? base : base + "#" + goto;
    });
  });

  // 3. Paging.
  var secs = [].slice.call(document.querySelectorAll(".wire-sec"));
  var rail = document.querySelector("[data-wire-rail]");
  if (secs.length < 2 || !rail) return;

  function mk(tag, cls, text) {
    var el = document.createElement(tag);
    el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  var pills = [];
  var idx = 0;

  function titleOf(i) {
    // Read from data-title and only ever written with textContent -- a section
    // title is prose and may contain anything. Falls back to a number so a
    // missing data-title is visible rather than silently blank.
    return secs[i].getAttribute("data-title") || ("Section " + (i + 1));
  }

  // The rail is ONE ROW: numbered pills, with the full title in title and
  // aria-label. Five wrapped titles made a five-row rail on a phone, and the
  // section heading right below it already names the page you are on.
  var prevBtn = mk("button", "wire-rail-nav", "\u2039");
  var nextBtn = mk("button", "wire-rail-nav", "\u203A");
  var allBtn = mk("button", "wire-rail-all", "Read all");
  prevBtn.setAttribute("aria-label", "Previous section");
  nextBtn.setAttribute("aria-label", "Next section");

  rail.appendChild(prevBtn);
  // A rail marked data-wire-rail-named shows each title beside its number
  // (UPS Center's segment buttons); every other rail stays one row of numbers.
  var named = rail.hasAttribute("data-wire-rail-named");
  if (named) rail.classList.add("wire-rail-named");
  secs.forEach(function (sec, i) {
    var pill = mk("button", "wire-rail-pill", named ? null : String(i + 1));
    if (named) {
      pill.appendChild(mk("b", "", String(i + 1)));
      pill.appendChild(document.createTextNode(titleOf(i)));
    }
    pill.setAttribute("type", "button");
    pill.setAttribute("title", titleOf(i));
    pill.setAttribute("aria-label", (i + 1) + ". " + titleOf(i));
    pill.addEventListener("click", function () { show(i, true); });
    pills.push(pill);
    rail.appendChild(pill);
  });
  rail.appendChild(nextBtn);
  rail.appendChild(allBtn);

  [prevBtn, nextBtn, allBtn].forEach(function (b) { b.setAttribute("type", "button"); });

  prevBtn.addEventListener("click", function () { show(idx - 1, true); });
  nextBtn.addEventListener("click", function () { show(idx + 1, true); });

  allBtn.addEventListener("click", function () {
    var nowPaged = docEl.classList.toggle("wire-paged");
    allBtn.textContent = nowPaged ? "Read all" : "Page it";
    if (!nowPaged) return;
    show(idx, false);
  });

  // 3b. End-of-section pager: previous / next by name, at the BOTTOM of every
  //     section, so finishing a long section on a phone does not mean
  //     scrolling back up to the rail. Hidden by CSS unless paged. The last
  //     section offers the way out instead of a dead end.
  function leave() {
    if (embedded) { post({ type: "wire-route", route: "/" }); return; }
    window.location.href = String(window.UPS_WIRE_PAGES_BASE || "../../");
  }
  // Only where there is somewhere to go back TO: the MFL loader (which sets
  // UPS_WIRE_ROUTE when it injects the article) or a real web page. A Claude
  // Artifact is framed too, but nothing is listening, so the button would be dead.
  var canLeave = embedded ? typeof window.UPS_WIRE_ROUTE === "string"
                          : /^https?:$/.test(String(window.location.protocol || ""));
  function navBtn(cls, small, big, onClick) {
    var b = mk("button", cls, null);
    b.setAttribute("type", "button");
    b.appendChild(mk("small", "", small));
    b.appendChild(mk("span", "", big));
    b.addEventListener("click", onClick);
    return b;
  }
  secs.forEach(function (sec, i) {
    var nav = mk("nav", "wire-secnav", null);
    nav.setAttribute("aria-label", "Section navigation");
    if (i > 0) {
      nav.appendChild(navBtn("wire-secnav-back", "\u2039 Previous", titleOf(i - 1),
        function () { show(i - 1, true); }));
    }
    if (i < secs.length - 1) {
      nav.appendChild(navBtn("wire-secnav-fwd", "Next \u203A", titleOf(i + 1),
        function () { show(i + 1, true); }));
    } else if (canLeave) {
      nav.appendChild(navBtn("wire-secnav-fwd", "Finished", "Back to all stories", leave));
    }
    sec.appendChild(nav);
  });

  function show(i, userInitiated) {
    if (i < 0 || i >= secs.length) return;
    idx = i;
    secs.forEach(function (sec, n) { sec.classList.toggle("wire-on", n === i); });
    pills.forEach(function (p, n) {
      if (n === i) p.setAttribute("aria-current", "true");
      else p.removeAttribute("aria-current");
    });
    prevBtn.disabled = i === 0;
    nextBtn.disabled = i === secs.length - 1;

    if (!userInitiated) return;

    var id = secs[i].id || "";
    // Where the rail sits in this document. A page turn lands there -- not at
    // the very top, which would put the headline back between the reader and
    // the section they asked for.
    var railTop = 0;
    try { railTop = rail.getBoundingClientRect().top + (window.pageYOffset || 0); } catch (e) {}
    // 4. Report upward so the MFL address bar tracks the section. The loader
    //    composes the full route because it is the thing that knows which
    //    article is loaded -- the article does not need to know its own id.
    //    Inside MFL the loader also does the scrolling: that frame is sized to
    //    its content, so it never scrolls itself.
    if (embedded) { post({ type: "wire-section", sectionId: id, top: Math.round(railTop) }); }
    else if (id) {
      try { history.replaceState(null, "", "#" + id); } catch (e) {}
    }
    // Only ever scroll UP to the rail: a reader who clicked a pill is already
    // looking at it. A no-op inside the auto-sized MFL frame; in a Claude
    // Artifact -- a fixed-height frame that scrolls itself -- it is the only
    // thing that moves the reader to the new section.
    try {
      var y = Math.max(0, railTop - 8);
      if (y < (window.pageYOffset || 0)) window.scrollTo(0, y);
    } catch (e) {}
  }


  // ---- game deck: flip through one full game page at a time ----
  // The games section carries a page per matchup, ordered so the biggest
  // billing leads. Showing them all at once is a wall; this pages them the same
  // way the section rail pages the article.
  //
  // MULTIPLE RAILS -- Keith 2026-09-16, twice: "having the divisional click
  // links the bottom of the article as well as the top." The deck can carry
  // more than one [data-wire-gamerail] (the renderer puts one before the
  // pages and one after); every rail found gets its own full set of
  // pills/prev/next/count, and showGame() keeps them ALL in sync so either
  // end works identically. A rail change also scrolls the newly-shown page
  // to the top of the viewport -- jumping from the bottom rail should not
  // leave the reader staring at content that just changed above them.
  function initGameDeck() {
    var deck = document.querySelector("[data-wire-gamedeck]");
    if (!deck) return;
    var pages = [].slice.call(deck.querySelectorAll(".wire-gamepage"));
    var rails = [].slice.call(deck.querySelectorAll("[data-wire-gamerail]"));
    if (pages.length < 2 || !rails.length) return;

    var gi = 0;
    var railSets = rails.map(function (rail) {
      var pills = [];
      var prev = mk("button", "wire-rail-nav", "\u2039");
      var next = mk("button", "wire-rail-nav", "\u203A");
      var count = mk("span", "wire-rail-count", "");
      [prev, next].forEach(function (b) { b.setAttribute("type", "button"); });
      rail.appendChild(prev);
      pages.forEach(function (pg, i) {
        var p = mk("button", "wire-gamepill", pg.getAttribute("data-title") || ("Game " + (i + 1)));
        p.setAttribute("type", "button");
        p.addEventListener("click", function () { showGame(i, true); });
        pills.push(p);
        rail.appendChild(p);
      });
      rail.appendChild(next);
      rail.appendChild(count);
      prev.addEventListener("click", function () { showGame(gi - 1, true); });
      next.addEventListener("click", function () { showGame(gi + 1, true); });
      return { prev: prev, next: next, pills: pills, count: count };
    });

    function showGame(i, userInitiated) {
      if (i < 0 || i >= pages.length) return;
      gi = i;
      pages.forEach(function (pg, n) { pg.classList.toggle("wire-on", n === i); });
      railSets.forEach(function (rs) {
        rs.pills.forEach(function (p, n) {
          if (n === i) p.setAttribute("aria-current", "true");
          else p.removeAttribute("aria-current");
        });
        rs.count.textContent = (i + 1) + " / " + pages.length;
        rs.prev.disabled = i === 0;
        rs.next.disabled = i === pages.length - 1;
      });
      if (userInitiated && pages[i].scrollIntoView) {
        pages[i].scrollIntoView({ block: "start" });
      }
    }
    deck.classList.add("wire-deck-on");
    showGame(0, false);
  }

  // ---- video: the named link IS the player ----
  // There is deliberately no inline player anywhere. An article renders in
  // three places -- a Claude Artifact (CSP blocks every external host), the MFL
  // hub (sandboxed without allow-same-origin, and sandbox flags pass down to a
  // player frame) and the standalone page -- and the clips we accept (the NFL's
  // channel or a team's) are NFL footage that YouTube will not play off
  // YouTube. Tested 2026-09-16 when Keith asked to play clips in the page: on
  // www48.myfantasyleague.com, keithcreelman.github.io and localhost, every
  // NFL-channel and team-channel highlight showed "This video contains content
  // from NFL, who has blocked it from display on this website or application"
  // (a non-NFL video played fine in the same frames). An embed would only put a
  // broken box above a link that works, so the link stays and nothing else.

  docEl.classList.add("wire-js");
  docEl.classList.add("wire-paged");
  initGameDeck();

  // Initial section: the loader's choice when embedded, the URL hash when
  // standalone, first section otherwise. One resolution path, no special cases.
  var wanted = embedded
    ? String(window.UPS_WIRE_SECTION || "")
    : String(window.location.hash || "").replace(/^#/, "");

  // STANDALONE DEEP LINK: take the fragment OFF the URL before the browser can
  // act on it, then resolve the section ourselves.
  //
  // Why not just scroll back to the top: the browser native-scrolls to the
  // fragment while every section is still visible -- i.e. deep into a very long
  // document. Paging then collapses that document and the reader is parked in
  // dead space, looking at a blank page. Chasing it with scrollTo does not work;
  // the scroll is re-applied asynchronously after load and after layout settles,
  // so we lost that race repeatedly (landing at 1104px, then 10039px).
  //
  // Removing the fragment removes the race entirely: no fragment, no native
  // scroll. The hash is restored on load via replaceState -- which, unlike
  // assigning location.hash, never scrolls -- so the address bar still holds a
  // copyable deep link.
  var restoreHash = "";
  if (!embedded && wanted) {
    restoreHash = "#" + wanted;
    try {
      if ("scrollRestoration" in history) history.scrollRestoration = "manual";
      history.replaceState(null, "", window.location.pathname + window.location.search);
    } catch (e) { restoreHash = ""; }
  }

  var start = 0;
  for (var n = 0; n < secs.length; n++) { if (secs[n].id && secs[n].id === wanted) { start = n; break; } }
  show(start, false);

  if (restoreHash) {
    window.addEventListener("load", function () {
      try {
        window.scrollTo(0, 0);
        history.replaceState(null, "", window.location.pathname + window.location.search + restoreHash);
      } catch (e) {}
    });
  }
})();
