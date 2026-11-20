/* UPS 2027 Preview 0: the headshot chain the current phone app already uses, in the same order:
   ESPN's player photo (by ESPN id), then MFL's own thumbnail (by MFL player id), then a neutral placeholder.
   The helmet badge is intentionally NOT part of Preview 0. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.UPS2027 = root.UPS2027 || {}; root.UPS2027.photo = api; }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function chain(espnId, mflId) {
    var out = [];
    // An id that is not all digits is not an id: stripping the letters out of it would point at a different player.
    var e = String(espnId == null ? "" : espnId).trim();
    var m = String(mflId == null ? "" : mflId).trim();
    if (!/^\d+$/.test(e)) e = "";
    if (!/^\d+$/.test(m)) m = "";
    if (e) out.push("https://a.espncdn.com/i/headshots/nfl/players/full/" + e + ".png");
    if (m) out.push("https://www48.myfantasyleague.com/player_photos_2014/" + m + "_thumb.jpg");
    return out;
  }

  // Walks the chain on image errors. `onResult(source)` reports where it ended: "espn", "mfl" or "placeholder".
  // `known` (optional) remembers addresses that already loaded, so a re-draw does not flash the badge again.
  function attach(img, urls, onResult, known) {
    var i = 0;
    function names(idx) { return /espncdn/.test(urls[idx] || "") ? "espn" : "mfl"; }
    img.hidden = !(known && urls[0] && known[urls[0]]); // the position badge underneath shows until a photo has actually loaded
    img.addEventListener("load", function () { img.hidden = false; if (known) known[urls[i]] = true; if (onResult) onResult(names(i)); });
    img.addEventListener("error", function () {
      if (img.isConnected === false) return; // the screen was redrawn: do not keep walking the chain for an image nobody sees
      i++;
      if (i < urls.length) img.src = urls[i];
      else { img.removeAttribute("src"); img.hidden = true; if (onResult) onResult("placeholder"); }
    });
    if (urls.length) img.src = urls[0]; else { img.hidden = true; if (onResult) onResult("placeholder"); }
  }

  return { chain: chain, attach: attach };
});
