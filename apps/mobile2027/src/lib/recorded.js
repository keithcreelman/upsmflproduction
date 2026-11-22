/* UPS 2027 Preview: the recorded-data answer. Plain script (browser) and CommonJS (tests and the bundle generator).

   In recorded mode (config.js: data "recorded") the page answers every data read from the snapshot bundled with it
   (recorded_data.js, window.UPS2027_RECORDED). createFetch(bundle) returns a function with the contract the loader
   (lib/data.js) expects of a request function: it takes (address, options) and gives back a promise of
   { ok, status, text(), json() }. It never touches the network: nothing here can reach one.
   - A read is found by its CANONICAL ROUTE: the path, then "?", then the query parameters sorted by name and URL-encoded.
     The origin is ignored. The generator (scripts/record_bundle.mjs) uses this same function to key the bundle.
   - A route that was not recorded answers { ok: false, status: 404 } so the screen's normal "couldn't load" path runs, and it
     is counted in `misses` (nothing is ignored silently). `served` lists the routes that were answered.
   - Only GET exists. Any other method is refused (and counted as a miss). */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.UPS2027 = root.UPS2027 || {}; root.UPS2027.recorded = api; }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function dec(s) {
    try { return decodeURIComponent(String(s).replace(/\+/g, " ")); } catch (e) { return String(s); }
  }
  // "https://host/api/x?W=1&TYPE=a" and "/api/x?TYPE=a&W=1" both give "/api/x?TYPE=a&W=1".
  function canonical(address) {
    var s = String(address == null ? "" : address);
    var h = s.indexOf("#");
    if (h >= 0) s = s.slice(0, h);
    s = s.replace(/^[A-Za-z][A-Za-z0-9+.\-]*:\/\/[^\/?#]*/, "");
    var q = s.indexOf("?");
    var path = q < 0 ? s : s.slice(0, q), qs = q < 0 ? "" : s.slice(q + 1);
    var pairs = [];
    if (qs) qs.split("&").forEach(function (part) {
      if (!part) return;
      var e = part.indexOf("=");
      pairs.push([dec(e < 0 ? part : part.slice(0, e)), dec(e < 0 ? "" : part.slice(e + 1))]);
    });
    pairs.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0; });
    return path + "?" + pairs.map(function (p) { return encodeURIComponent(p[0]) + "=" + encodeURIComponent(p[1]); }).join("&");
  }

  // Every unrecorded route any answer function made, in order (a test reads it; an empty list means nothing was missing).
  var misses = [];

  function createFetch(bundle) {
    var routes = bundle && typeof bundle === "object" && bundle.routes && typeof bundle.routes === "object" && !Array.isArray(bundle.routes) ? bundle.routes : null;
    var texts = {};
    var own = [];
    var served = [];
    function miss(key) { own.push(key); misses.push(key); }
    function answer(url, opts) {
      var verb = opts && opts.method != null ? String(opts.method).toUpperCase() : "GET";
      var key = canonical(url);
      if (verb !== "GET") { miss(verb + " " + key); return Promise.reject(new Error("Recorded data answers GET only")); }
      if (!routes || !Object.prototype.hasOwnProperty.call(routes, key)) {
        miss(key);
        return Promise.resolve({ ok: false, status: 404, text: function () { return Promise.resolve(""); }, json: function () { return Promise.reject(new Error("Not in the recorded snapshot")); } });
      }
      served.push(key);
      if (texts[key] === undefined) texts[key] = JSON.stringify(routes[key]);
      var body = texts[key];
      return Promise.resolve({ ok: true, status: 200, text: function () { return Promise.resolve(body); }, json: function () { return Promise.resolve(JSON.parse(body)); } });
    }
    answer.misses = own;
    answer.served = served;
    answer.routeCount = routes ? Object.keys(routes).length : 0;
    return answer;
  }

  return { canonical: canonical, createFetch: createFetch, misses: misses };
});
