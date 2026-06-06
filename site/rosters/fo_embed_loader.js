(function () {
  "use strict";

  // Front Office v2 — HPM embed loader. Sibling of mfl_hpm_embed_loader.js
  // (which loads the legacy Roster Workbench). This one injects FO v2
  // (site/rosters/v2/front_office.js) into MFL's "My Team" page instead.
  //
  // ROLLOUT: MFL's HPM homepage code points a <script src> at ONE of these two
  // loaders. To switch the in-MFL embed from Roster Workbench → Front Office,
  // repoint that src at fo_embed_loader.js; to revert instantly, point it back
  // at mfl_hpm_embed_loader.js. roster_workbench.js + its loader are left fully
  // intact as the fallback, so the swap is reversible with a one-line edit.
  //
  // FO v2 self-builds its DOM (window.UPS_FO_INIT → buildShell fetches the same
  // front_office.html shell and injects it) and reads MFL's login cookie for the
  // viewer franchise, so no ?franchise_id= is needed inside the embed.

  var BUILD = "2026.06.05.1";
  if (window.__ups_fo_embed_loader === BUILD) {
    if (typeof window.UPS_FO_INIT === "function") window.UPS_FO_INIT();
    return;
  }
  window.__ups_fo_embed_loader = BUILD;

  // Capture the loader's own dir NOW, during synchronous execution, while
  // document.currentScript is still valid. boot() runs later (on
  // DOMContentLoaded, since a parser-inserted body script fires while
  // readyState === "loading"), by which point currentScript is null. Capturing
  // here lets FO load from the SAME origin the loader was served from (Pages in
  // prod, localhost in dev) instead of always falling back to the hardcoded
  // Pages URLs.
  var SCRIPT_BASE = (function () {
    try {
      var s = document.currentScript;
      if (!s || !s.src) return "";
      var u = new URL(s.src, window.location.href);
      var parts = String(u.pathname || "").split("/");
      parts.pop();
      u.pathname = parts.join("/") + "/";
      u.search = "";
      u.hash = "";
      return u.toString();
    } catch (e) {
      return "";
    }
  })();

  function safeStr(v) {
    return v == null ? "" : String(v).trim();
  }

  function getContext() {
    var out = {
      leagueId: "",
      year: ""
    };
    try {
      var u = new URL(window.location.href || "");
      out.leagueId = safeStr(
        u.searchParams.get("L") ||
        window.UPS_FO_LEAGUE_ID ||
        window.UPS_RWB_LEAGUE_ID ||
        window.league_id ||
        window.LEAGUE_ID ||
        ""
      ).replace(/\D/g, "");

      out.year = safeStr(
        u.searchParams.get("YEAR") ||
        window.UPS_FO_YEAR ||
        window.UPS_RWB_YEAR ||
        window.year ||
        window.YEAR ||
        ""
      ).replace(/\D/g, "");

      if (!out.year) {
        var pathYear = safeStr(u.pathname).match(/\/(\d{4})\//);
        if (pathYear && pathYear[1]) out.year = pathYear[1];
      }

      if (!out.leagueId) {
        var pathLeague = safeStr(u.pathname).match(/\/home\/(\d+)(?:\/|$)/i);
        if (pathLeague && pathLeague[1]) out.leagueId = pathLeague[1];
      }
    } catch (e) {}

    if (!out.year) out.year = String(new Date().getFullYear());
    return out;
  }

  function ensureMount() {
    var mount = document.getElementById("ups-front-office");
    if (mount) return mount;

    mount = document.createElement("div");
    mount.id = "ups-front-office";

    var anchor =
      document.querySelector(".ups-hotlinks-shell") ||
      document.getElementById("container-wrap") ||
      document.body;

    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(mount, anchor.nextSibling);
    } else {
      document.body.appendChild(mount);
    }

    return mount;
  }

  // Hide MFL's native roster view so only FO shows. Identical targets to the
  // Roster Workbench loader (both replace the same "My Team" page).
  function applyLegacyPrehide() {
    var id = "ups-fo-legacy-prehide";
    if (document.getElementById(id)) return;
    var css = [
      "body#body_options_07 #MFLroster{display:none!important;}",
      "body#body_options_07 #pre_load_html{display:none!important;}",
      "body#body_options_07 table.two_column_layout{display:none!important;}",
      "body#body_options_07 .reportnavigation{display:none!important;}",
      "body#body_options_07 .weekly-navbar{display:none!important;}",
      "body#body_options_07 .weekly-navbar-mobile{display:none!important;}"
    ].join("");
    var style = document.createElement("style");
    style.id = id;
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  function hideLegacyNodes() {
    var selectors = [
      "body#body_options_07 #MFLroster",
      "body#body_options_07 #pre_load_html",
      "body#body_options_07 table.two_column_layout",
      "body#body_options_07 .reportnavigation",
      "body#body_options_07 .weekly-navbar",
      "body#body_options_07 .weekly-navbar-mobile"
    ];
    var nodes = document.querySelectorAll(selectors.join(","));
    for (var i = 0; i < nodes.length; i += 1) {
      var n = nodes[i];
      if (!n) continue;
      n.style.display = "none";
      n.setAttribute("aria-hidden", "true");
    }
  }

  function injectCssCandidates(candidates) {
    var id = "ups-fo-css";
    var existing = document.getElementById(id);
    if (existing) return;

    var idx = 0;
    function next() {
      if (idx >= candidates.length) return;
      var link = document.createElement("link");
      link.id = id;
      link.rel = "stylesheet";
      link.href = candidates[idx++];
      link.onerror = function () {
        if (link.parentNode) link.parentNode.removeChild(link);
        next();
      };
      (document.head || document.documentElement).appendChild(link);
    }
    next();
  }

  function injectScript(candidates, done) {
    var idx = 0;

    function next() {
      if (idx >= candidates.length) {
        if (typeof done === "function") done(false);
        return;
      }

      var src = candidates[idx++];
      var s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = function () {
        if (typeof done === "function") done(true);
      };
      s.onerror = function () {
        next();
      };
      (document.body || document.documentElement).appendChild(s);
    }

    next();
  }

  function boot() {
    var ctx = getContext();
    window.UPS_FO_LEAGUE_ID = ctx.leagueId;
    window.UPS_FO_YEAR = ctx.year;
    window.UPS_FO_EMBED = true;

    applyLegacyPrehide();
    ensureMount();
    hideLegacyNodes();

    if (typeof window.UPS_FO_INIT === "function") {
      window.UPS_FO_INIT();
      return;
    }

    var base = SCRIPT_BASE;                   // sits at site/rosters/ (captured at top)
    var cacheKey = encodeURIComponent(String(Date.now()));

    // FO's own asset base (site/rosters/v2/) — front_office.js prefers deriving
    // this from its injected <script> src, but we set the global as a fallback.
    var PAGES_V2 = "https://keithcreelman.github.io/upsmflproduction/rosters/v2/";
    window.UPS_FO_ASSET_BASE = base ? base + "v2/" : PAGES_V2;

    var cssCandidates = [];
    var jsCandidates = [];
    // Master player-profile modal + cap_math, same shared deps the Roster
    // Workbench loader pulls (front_office.js uses window.UPS_openPlayerProfile /
    // window.UPS_CAP_MATH where present). Load order: cap_math → master → FO.
    var masterCandidates = [];
    var capMathCandidates = [];

    if (base) {
      cssCandidates.push(base + "v2/front_office.css?v=" + cacheKey);
      jsCandidates.push(base + "v2/front_office.js?v=" + cacheKey);
      masterCandidates.push(base + "../shared/player_profile_master.js?v=" + cacheKey);
      capMathCandidates.push(base + "../shared/cap_math.js?v=" + cacheKey);
    }

    // GitHub Pages is the canonical CDN (see #88).
    cssCandidates.push(PAGES_V2 + "front_office.css?v=" + cacheKey);
    jsCandidates.push(PAGES_V2 + "front_office.js?v=" + cacheKey);
    masterCandidates.push("https://keithcreelman.github.io/upsmflproduction/shared/player_profile_master.js?v=" + cacheKey);
    capMathCandidates.push("https://keithcreelman.github.io/upsmflproduction/shared/cap_math.js?v=" + cacheKey);

    injectCssCandidates(cssCandidates);

    // cap_math (window.UPS_CAP_MATH) → master modal (window.UPS_openPlayerProfile)
    // → front_office.js. FO self-boots on load (it detects the #ups-front-office
    // mount); we also call UPS_FO_INIT() in onload to cover the cached-build path.
    injectScript(capMathCandidates, function () {
      injectScript(masterCandidates, function () {
        injectScript(jsCandidates, function () {
          if (typeof window.UPS_FO_INIT === "function") window.UPS_FO_INIT();
        });
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
