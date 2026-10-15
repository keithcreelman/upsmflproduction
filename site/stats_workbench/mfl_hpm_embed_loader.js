(function () {
  "use strict";
  // MFL message-slot loader for the Advanced Stats Workbench.
  // Mirrors the Rookie Draft Hub pattern: fetch the standalone HTML
  // from rawcdn.githack, inject into an iframe srcdoc so jsDelivr's
  // text/plain-nosniff response doesn't render the source as text.

  function safeStr(v) { return v == null ? "" : String(v); }

  var script = document.currentScript;
  if (!script) return;

  var sha = safeStr(window.UPS_STATS_WORKBENCH_RELEASE_SHA || window.UPS_RELEASE_SHA) || "main";
  // UPS_STATS_WORKBENCH_HTML_URL: a read-only preview can point the loader at its own copy.
  var htmlUrl = safeStr(window.UPS_STATS_WORKBENCH_HTML_URL) ||
                ("https://rawcdn.githack.com/keithcreelman/upsmflproduction/" +
                 encodeURIComponent(sha) +
                 "/site/stats_workbench/stats_workbench.html");

  var mountId = script.getAttribute("data-target-id") || "upsStatsWorkbenchMount";
  var mount = document.getElementById(mountId) || (function () {
    var d = document.createElement("div");
    d.id = mountId;
    script.parentNode.insertBefore(d, script);
    return d;
  })();

  // The frame is an app pane (Keith 2026-10-15, desktop redesign): as tall as the window below
  // MFL's header (at least 600px), shorter only when the page itself is shorter. Inside it the
  // Stats page scrolls, so its table header row stays put and its side drawer opens where you
  // are looking. Until then the frame took its height once, at load, before the table arrived
  // (640px around a 2,670px page at 1280×900), and the rest scrolled in a small inner box.
  function fit(iframe, contentH) {
    try {
      var top = Math.max(0, iframe.getBoundingClientRect().top + (window.pageYOffset || 0));
      var pane = Math.max(600, (window.innerHeight || 900) - Math.min(top, 160) - 8);
      var h = contentH ? Math.min(pane, contentH + 40) : pane;
      iframe.style.height = Math.max(600, Math.round(h)) + "px";
    } catch (e) {}
  }
  function contentHeight(iframe) {
    try { return iframe.contentDocument.documentElement.scrollHeight; } catch (e) { return 0; }
  }

  fetch(htmlUrl, { cache: "no-store", credentials: "omit" })
    .then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.text();
    })
    .then(function (html) {
      var iframe = document.createElement("iframe");
      iframe.setAttribute("data-ups-stats-workbench", "1");
      iframe.setAttribute("title", "UPS Stats");
      iframe.style.cssText = "width:100%;border:0;display:block;min-height:600px;";
      iframe.srcdoc = html;
      iframe.addEventListener("load", function () {
        fit(iframe, contentHeight(iframe));
        // The page grows and shrinks as its data arrives and as views switch: refit then.
        try {
          var RO = iframe.contentWindow.ResizeObserver || window.ResizeObserver;
          if (RO) new RO(function () { fit(iframe, contentHeight(iframe)); }).observe(iframe.contentDocument.documentElement);
        } catch (e) {}
      });
      window.addEventListener("resize", function () { fit(iframe, contentHeight(iframe)); });
      // The page also posts its height after in-iframe sub-tab switches (Stats: Player Stats ⇄
      // Fantasy Points Against …); the pane takes it, capped at the window.
      window.addEventListener("message", function (ev) {
        try {
          if (ev && ev.data && ev.data.type === "ups-asw-height" && ev.data.height) {
            fit(iframe, Number(ev.data.height));
          }
        } catch (e) {}
      });
      mount.innerHTML = "";
      mount.appendChild(iframe);
    })
    .catch(function (e) {
      mount.innerHTML =
        '<div style="padding:10px;border:1px solid #8b1f2f;background:#2a0f19;color:#ffe4ea;font-weight:700;">' +
        "Stats Workbench failed to load: " + safeStr(e && e.message || e) +
        '</div>';
    });
})();
