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
  var htmlUrl = "https://rawcdn.githack.com/keithcreelman/upsmflproduction/" +
                encodeURIComponent(sha) +
                "/site/stats_workbench/stats_workbench.html";

  var mountId = script.getAttribute("data-target-id") || "upsStatsWorkbenchMount";
  var mount = document.getElementById(mountId) || (function () {
    var d = document.createElement("div");
    d.id = mountId;
    script.parentNode.insertBefore(d, script);
    return d;
  })();

  fetch(htmlUrl, { cache: "no-store", credentials: "omit" })
    .then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.text();
    })
    .then(function (html) {
      var iframe = document.createElement("iframe");
      iframe.setAttribute("data-ups-stats-workbench", "1");
      iframe.style.cssText = "width:100%;border:0;display:block;min-height:600px;";
      iframe.srcdoc = html;
      // Auto-resize iframe to content height on load (+ a bit of safety)
      iframe.addEventListener("load", function () {
        try {
          var h = iframe.contentDocument.documentElement.scrollHeight;
          iframe.style.height = (h + 40) + "px";
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
