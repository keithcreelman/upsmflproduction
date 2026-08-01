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
 *   3. Build the chapter rail and page between sections.
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

  var prevBtn = mk("button", "wire-rail-nav", "\u2039 Prev");
  var nextBtn = mk("button", "wire-rail-nav", "Next \u203A");
  var count = mk("span", "wire-rail-count", "");
  var allBtn = mk("button", "wire-rail-all", "Read all");

  rail.appendChild(prevBtn);
  secs.forEach(function (sec, i) {
    // textContent, not innerHTML -- a section title is prose and may contain
    // anything. Falls back to a number so a missing data-title is visible
    // rather than silently blank.
    var label = sec.getAttribute("data-title") || ("Section " + (i + 1));
    var pill = mk("button", "wire-rail-pill", (i + 1) + ". " + label);
    pill.setAttribute("type", "button");
    pill.addEventListener("click", function () { show(i, true); });
    pills.push(pill);
    rail.appendChild(pill);
  });
  rail.appendChild(nextBtn);
  rail.appendChild(count);
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

  function show(i, userInitiated) {
    if (i < 0 || i >= secs.length) return;
    idx = i;
    secs.forEach(function (sec, n) { sec.classList.toggle("wire-on", n === i); });
    pills.forEach(function (p, n) {
      if (n === i) p.setAttribute("aria-current", "true");
      else p.removeAttribute("aria-current");
    });
    count.textContent = (i + 1) + " / " + secs.length;
    prevBtn.disabled = i === 0;
    nextBtn.disabled = i === secs.length - 1;

    if (!userInitiated) return;

    var id = secs[i].id || "";
    // 4. Report upward so the MFL address bar tracks the section. The loader
    //    composes the full route because it is the thing that knows which
    //    article is loaded -- the article does not need to know its own id.
    if (embedded) { post({ type: "wire-section", sectionId: id }); }
    else if (id) {
      try { history.replaceState(null, "", "#" + id); } catch (e) {}
    }
    // Paging is a page turn; land at the top of the new section.
    try { window.scrollTo(0, 0); } catch (e) {}
  }

  docEl.classList.add("wire-js");
  docEl.classList.add("wire-paged");

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
