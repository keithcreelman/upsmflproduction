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

  // 2. Back bar. Only visible when embedded (CSS: .wire-embedded .wire-topbar).
  var back = document.querySelector("[data-wire-back]");
  if (back) {
    back.addEventListener("click", function () {
      if (embedded) { post({ type: "wire-route", route: "/" }); return; }
      // Standalone: UPS_WIRE_PAGES_BASE is the one place the Pages path shape
      // is written down. The relative fallback covers an Artifact or any host
      // that never set it.
      window.location.href = String(window.UPS_WIRE_PAGES_BASE || "../../");
    });
  }

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
  secs.forEach(function (sec, i) {
    var pill = mk("button", "wire-rail-pill", String(i + 1));
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
  var canLeave = embedded || /^https?:$/.test(String(window.location.protocol || ""));
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
    //    Embedded, the loader also does the scrolling: the frame is sized to
    //    its content, so a scrollTo in here does nothing.
    if (embedded) { post({ type: "wire-section", sectionId: id, top: Math.round(railTop) }); return; }
    if (id) {
      try { history.replaceState(null, "", "#" + id); } catch (e) {}
    }
    // Only ever scroll UP to the rail: a reader who clicked a pill is already
    // looking at it.
    try {
      var y = Math.max(0, railTop - 8);
      if (y < (window.pageYOffset || 0)) window.scrollTo(0, y);
    } catch (e) {}
  }


  // ---- game deck: flip through one full game page at a time ----
  // The games section carries a page per matchup, ordered so the biggest
  // billing leads. Showing them all at once is a wall; this pages them the same
  // way the section rail pages the article.
  function initGameDeck() {
    var deck = document.querySelector("[data-wire-gamedeck]");
    if (!deck) return;
    var pages = [].slice.call(deck.querySelectorAll(".wire-gamepage"));
    var rail = deck.querySelector("[data-wire-gamerail]");
    if (pages.length < 2 || !rail) return;

    var gi = 0, pills = [];
    var prev = mk("button", "wire-rail-nav", "\u2039");
    var next = mk("button", "wire-rail-nav", "\u203A");
    var count = mk("span", "wire-rail-count", "");
    [prev, next].forEach(function (b) { b.setAttribute("type", "button"); });

    rail.appendChild(prev);
    pages.forEach(function (pg, i) {
      var p = mk("button", "wire-gamepill", pg.getAttribute("data-title") || ("Game " + (i + 1)));
      p.setAttribute("type", "button");
      p.addEventListener("click", function () { showGame(i); });
      pills.push(p);
      rail.appendChild(p);
    });
    rail.appendChild(next);
    rail.appendChild(count);

    prev.addEventListener("click", function () { showGame(gi - 1); });
    next.addEventListener("click", function () { showGame(gi + 1); });

    function showGame(i) {
      if (i < 0 || i >= pages.length) return;
      gi = i;
      pages.forEach(function (pg, n) { pg.classList.toggle("wire-on", n === i); });
      pills.forEach(function (p, n) {
        if (n === i) p.setAttribute("aria-current", "true");
        else p.removeAttribute("aria-current");
      });
      count.textContent = (i + 1) + " / " + pages.length;
      prev.disabled = i === 0;
      next.disabled = i === pages.length - 1;
    }
    deck.classList.add("wire-deck-on");
    showGame(0);
  }

  // ---- video: upgrade a verified link into a real player, where one runs ----
  // STANDALONE ONLY, and that is the whole design. An article renders in three
  // places. In a Claude Artifact the CSP blocks every external host. In the MFL
  // hub the article is sandboxed WITHOUT allow-same-origin -- the thing that
  // stops model-written HTML running with MFL-origin privileges -- and a
  // YouTube player cannot function inside that. Both of those keep the named
  // link, which works. Only the standalone page, which is a real origin with no
  // such constraint, gets the iframe. Nothing is weakened to make video happen.
  function initVideos() {
    if (embedded) return;
    var slots = [].slice.call(document.querySelectorAll("[data-wire-video]"));
    for (var i = 0; i < slots.length; i++) {
      var slot = slots[i];
      var id = slot.getAttribute("data-wire-video") || "";
      if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) continue;   // never interpolate junk
      var frame = document.createElement("iframe");
      frame.className = "wire-video-frame";
      frame.setAttribute("src", "https://www.youtube-nocookie.com/embed/" + id);
      frame.setAttribute("title", "Highlights");
      frame.setAttribute("loading", "lazy");
      frame.setAttribute("allowfullscreen", "");
      frame.setAttribute(
        "allow", "accelerometer; encrypted-media; gyroscope; picture-in-picture");
      frame.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
      slot.insertBefore(frame, slot.firstChild);
      slot.classList.add("wire-video-live");
    }
  }

  docEl.classList.add("wire-js");
  docEl.classList.add("wire-paged");
  initGameDeck();
  initVideos();

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
