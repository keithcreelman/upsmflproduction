/* Central partial loader for MFL Header/Footer/HPM includes. */
(function () {
  "use strict";

  var script = document.currentScript;
  if (!script) return;

  var PARTIAL_MAP = {
    header: "/apps/mfl_site/header_custom_v2.html",
    footer: "/apps/mfl_site/footer_custom_v2.html",
    "hpm-default": "/site/hpm-default.html"
  };

  function safeLower(value) {
    return (value || "").toString().trim().toLowerCase();
  }

  function normalizeHtml(partial, html) {
    var out = html || "";

    // These files were authored for direct MFL header/footer fields where one
    // side opens/closes a shared wrapper. Hosted partial injection should not
    // carry those unmatched tags.
    if (partial === "header") {
      out = out.replace(
        /<div id="container-wrap"><!--\s*ENTER ALL HPMS AFTER THIS AND CLOSE IN FOOTER\s*-->/i,
        ""
      );
    }
    if (partial === "footer") {
      out = out.replace(/<\/div><!--\s*CLOSE CONTAINER WRAP FROM HEADER\s*-->/i, "");
    }
    return out;
  }

  function executeScripts(root) {
    var scripts = Array.prototype.slice.call(root.querySelectorAll("script"));
    scripts.forEach(function (oldScript) {
      var newScript = document.createElement("script");
      Array.prototype.slice.call(oldScript.attributes).forEach(function (attr) {
        newScript.setAttribute(attr.name, attr.value);
      });

      if (oldScript.src) {
        newScript.src = oldScript.src;
        newScript.async = false;
      } else {
        newScript.text = oldScript.textContent || "";
      }

      oldScript.parentNode.replaceChild(newScript, oldScript);
    });
  }

  function ensureMountNode() {
    var explicitId = script.getAttribute("data-ups-target-id");
    if (explicitId) {
      var found = document.getElementById(explicitId);
      if (found) return found;
    }

    var prev = script.previousElementSibling;
    if (prev && prev.getAttribute("data-ups-partial")) return prev;

    var node = document.createElement("div");
    node.setAttribute("data-ups-generated-slot", "1");
    script.parentNode.insertBefore(node, script);
    return node;
  }

  var mount = ensureMountNode();
  var partial = safeLower(script.getAttribute("data-ups-partial") || mount.getAttribute("data-ups-partial") || "hpm-default");
  if (!PARTIAL_MAP[partial]) partial = "hpm-default";

  var sourcePath = script.getAttribute("data-ups-path") || PARTIAL_MAP[partial];
  var scriptUrl = new URL(script.src, window.location.href);
  var sourceUrl = new URL(sourcePath, scriptUrl.origin);
  var version = script.getAttribute("data-ups-v") || scriptUrl.searchParams.get("v") || "";
  if (version) sourceUrl.searchParams.set("v", version);

  fetch(sourceUrl.toString(), { cache: "no-store", credentials: "omit" })
    .then(function (response) {
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.text();
    })
    .then(function (html) {
      mount.innerHTML = normalizeHtml(partial, html);
      executeScripts(mount);
    })
    .catch(function (err) {
      mount.innerHTML =
        '<div style="padding:0.6rem;border:1px solid #8b1f2f;background:#2a0f19;color:#ffe4ea;font-weight:700;">' +
        "Hosted include load failed: " +
        String(err && err.message ? err.message : err) +
        "</div>";
    });
})();
