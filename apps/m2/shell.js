// MFL 2.0 Release 1: the app frame. ONE navigation definition (NAV) drives the bottom bar, the sub-tabs and the
// router. Skins are remembered per viewer (localStorage, wrapped: the page works without it).
(function () {
  "use strict";
  var ICON = {
    team: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><circle cx="17.5" cy="9" r="2.5"/><path d="M16 14.6c2.6.1 4.6 1.8 5.4 4.9"/></svg>',
    market: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 5 5"/></svg>',
    league: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M7 4h10v4a5 5 0 0 1-10 0V4Z"/><path d="M7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4M12 13v4M8 20h8"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  };
  // The one navigation definition. `built: false` areas say what will be there.
  var NAV = [
    { id: "team", label: "Team", icon: ICON.team, sub: [
      { id: "roster", label: "Roster" }, { id: "contracts", label: "Contracts" }, { id: "cap", label: "Cap & picks" } ] },
    { id: "market", label: "Market", icon: ICON.market, built: false,
      coming: "Free agents, waiver bids and trade targets. The Market design is still in review, so it isn't in this release." },
    { id: "league", label: "League", icon: ICON.league, built: false,
      coming: "Standings, scores, schedule and the rules. Planned for the league-at-a-glance release." },
    { id: "more", label: "More", icon: ICON.more },
  ];

  var SKINS = [{ id: "light", label: "Light" }, { id: "dark", label: "Dark" }, { id: "contrast", label: "High contrast" }];
  function store(k, v) { try { if (v === undefined) return window.localStorage.getItem(k); window.localStorage.setItem(k, v); } catch (e) { return null; } return null; }
  function applySkin(id) {
    if (!SKINS.some(function (s) { return s.id === id; })) id = null;
    if (!id) id = (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
    document.documentElement.setAttribute("data-skin", id);
    return id;
  }
  function setSkin(id) { store("ups2_skin", id); applySkin(id); }
  applySkin(store("ups2_skin"));

  // Route = #area or #area/sub (plain hash names only).
  function route() {
    var h = (window.location.hash || "").replace(/^#/, "").split("/");
    var area = NAV.filter(function (n) { return n.id === h[0]; })[0] || NAV[0];
    var sub = area.sub ? (area.sub.filter(function (s) { return s.id === h[1]; })[0] || area.sub[0]) : null;
    return { area: area, sub: sub };
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  function renderTabs(r) {
    document.getElementById("tabs").innerHTML = NAV.map(function (n) {
      return '<a href="#' + n.id + '"' + (n === r.area ? ' aria-current="page"' : "") + ">" + n.icon + "<span>" + esc(n.label) + "</span></a>";
    }).join("");
  }
  function subTabs(r) {
    if (!r.area.sub) return "";
    return '<nav class="seg" aria-label="' + esc(r.area.label) + '">' + r.area.sub.map(function (s) {
      return '<a href="#' + r.area.id + "/" + s.id + '"' + (s === r.sub ? ' aria-current="page"' : "") + ">" + esc(s.label) + "</a>";
    }).join("") + "</nav>";
  }
  function comingView(area) {
    return '<div class="card coming"><h2>' + esc(area.label) + " is coming</h2><p>" + esc(area.coming) + "</p></div>";
  }
  function skinPicker() {
    var cur = document.documentElement.getAttribute("data-skin");
    return '<div class="card"><h2>Skin</h2><div class="skins">' + SKINS.map(function (s) {
      return '<button type="button" data-skin-pick="' + s.id + '" aria-pressed="' + (s.id === cur) + '">' + esc(s.label) + "</button>";
    }).join("") + "</div></div>";
  }

  window.UPS2_SHELL = { NAV: NAV, SKINS: SKINS, route: route, renderTabs: renderTabs, subTabs: subTabs, comingView: comingView,
    skinPicker: skinPicker, setSkin: setSkin, esc: esc, store: store };

  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-skin-pick]");
    if (!b) return;
    setSkin(b.getAttribute("data-skin-pick"));
    document.querySelectorAll("[data-skin-pick]").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
  });
})();
