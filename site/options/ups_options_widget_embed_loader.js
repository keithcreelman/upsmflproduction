// Compatibility shim for legacy embed paths:
// /site/options/ups_options_widget_embed_loader.js -> /site/ups_options_widget_embed_loader.js
(function () {
  "use strict";

  var src =
    "https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@" +
    encodeURIComponent(String(window.UPS_RELEASE_SHA || "main")) +
    "/site/ups_options_widget_embed_loader.js?v=" +
    encodeURIComponent(String(window.UPS_RELEASE_SHA || Date.now()));

  var s = document.createElement("script");
  s.src = src;
  s.async = false;
  (document.head || document.documentElement || document.body).appendChild(s);
})();
