/* UPS 2027 beta: Sample mode, a client-only store. (Decision 4, 2026-11-20.)
   Scenarios (a problem week, a closed window, a failed read ...) will live here so the screens can be tried without any
   league data. The rules that go with it are fixed now, before the first scenario exists:
     - it is always labeled: "Sample data · nothing is real and nothing is sent";
     - it never makes a request: while it is on, nothing in the page may call the network, and there is no submit path;
     - it is not remembered: the page starts with it off.
   This file holds no network code and no storage. The tests pin that the page makes zero requests while Sample mode is on. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.UPS2027 = root.UPS2027 || {}; root.UPS2027.sample = api; }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var LABEL = "Sample data · nothing is real and nothing is sent";
  var PREVIEW = "Preview: view only";

  // The store. `scenarios` is filled by the stages that add screens; each entry is plain data (no functions that fetch).
  function create() {
    var s = { on: false, scenarios: {} };
    s.toggle = function () { s.on = !s.on; return s.on; };
    s.register = function (id, scenario) {
      if (!id || typeof id !== "string") throw new Error("A sample scenario needs an id.");
      if (s.scenarios[id]) throw new Error("A sample scenario with that id is already registered: " + id);
      if (!scenario || typeof scenario !== "object" || Array.isArray(scenario)) throw new Error("A sample scenario is plain data.");
      s.scenarios[id] = scenario;
    };
    return s;
  }

  // The marker at the top of every screen. In recorded-data mode `recorded` is the snapshot's time ("Sun Nov 22, 2026, 10:22 AM ET"): the marker then
  // says the page shows a recording, so nobody takes a figure for a live one. Sample mode keeps its own label.
  function envText(on, recorded) {
    if (on) return LABEL;
    return recorded ? "PREVIEW · RECORDED DATA · recorded " + recorded + " · VIEW ONLY" : PREVIEW;
  }

  return { LABEL: LABEL, PREVIEW: PREVIEW, create: create, envText: envText };
});
