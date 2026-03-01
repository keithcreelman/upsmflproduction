// Compatibility alias: load canonical embed loader from /site path.
(function () {
  "use strict";

  function resolveCanonicalUrl() {
    var current = document.currentScript;
    if (!current || !current.src) return "";
    try {
      var u = new URL(current.src, window.location.href);
      var path = String(u.pathname || "");
      if (/\/ups_options_widget_embed_loader\.js$/i.test(path)) {
        u.pathname = path.replace(
          /\/ups_options_widget_embed_loader\.js$/i,
          "/site/ups_options_widget_embed_loader.js"
        );
      } else if (!/\/site\/ups_options_widget_embed_loader\.js$/i.test(path)) {
        u.pathname = "/site/ups_options_widget_embed_loader.js";
      }
      return u.toString();
    } catch (e) {
      return "";
    }
  }

  var src = resolveCanonicalUrl();
  if (!src) return;
  var s = document.createElement("script");
  s.src = src;
  s.async = false;
  (document.head || document.documentElement || document.body).appendChild(s);
})();
