/* Central partial loader for MFL Header/Footer/HPM includes. */
(function () {
  "use strict";

  // Early global shim for legacy scripts that reference bare `is_offseason`.
  (function ensureOffseasonGlobal() {
    function safeStr(v) {
      return v == null ? "" : String(v).trim();
    }
    function parseYmd(s) {
      var raw = safeStr(s);
      var m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) return null;
      var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return Number.isFinite(d.getTime()) ? d : null;
    }

    var m = String(window.location.pathname || "").match(/\/(\d{4})\//);
    var siteSeason = m ? parseInt(m[1], 10) : new Date().getFullYear();
    var currentYear = new Date().getFullYear();
    var today = new Date();
    var events =
      (window.UPS_EVENTS && typeof window.UPS_EVENTS === "object" && window.UPS_EVENTS) ||
      (window.nfs_events && typeof window.nfs_events === "object" && window.nfs_events) ||
      (window.NFS_EVENTS && typeof window.NFS_EVENTS === "object" && window.NFS_EVENTS) ||
      {};
    if (!window.UPS_EVENTS || typeof window.UPS_EVENTS !== "object") {
      window.UPS_EVENTS = events;
    }

    var seasonEvents = (events && events[String(siteSeason)]) || null;
    var deadlineRaw = seasonEvents && (
      seasonEvents.ups_contract_deadline ||
      seasonEvents.contract_deadline ||
      seasonEvents.UPS_CONTRACT_DEADLINE
    );
    var seasonCompleteRaw = seasonEvents && (
      seasonEvents.ups_season_complete ||
      seasonEvents.season_complete ||
      seasonEvents.UPS_SEASON_COMPLETE
    );
    var deadlineDt = parseYmd(deadlineRaw);
    var seasonCompleteDt = parseYmd(seasonCompleteRaw);
    var isOffseason = true;
    if (siteSeason < currentYear) {
      isOffseason = true;
    } else if (siteSeason > currentYear) {
      isOffseason = true;
    } else {
      if (!deadlineDt) {
        isOffseason = true;
      } else if (today < deadlineDt) {
        isOffseason = true;
      } else if (seasonCompleteDt && today > seasonCompleteDt) {
        isOffseason = true;
      } else {
        isOffseason = false;
      }
    }

    window.is_offseason = !!isOffseason;
    window.UPS_IS_OFFSEASON = !!isOffseason;
    if (!window.MFLGlobalCache || typeof window.MFLGlobalCache !== "object") {
      window.MFLGlobalCache = {
        onReady: function (cb) {
          if (typeof cb === "function") {
            try { cb(); } catch (e) {}
          }
        },
        get: function () { return null; },
        set: function () {},
        remove: function () {}
      };
    } else if (typeof window.MFLGlobalCache.onReady !== "function") {
      window.MFLGlobalCache.onReady = function (cb) {
        if (typeof cb === "function") {
          try { cb(); } catch (e) {}
        }
      };
    }
    if (!Array.isArray(window.reportNflByeWeeks_ar)) window.reportNflByeWeeks_ar = [];
    if (!Array.isArray(window.reportNflByeWeeksArray)) window.reportNflByeWeeksArray = window.reportNflByeWeeks_ar;
    try {
      if (typeof window.eval === "function") {
        window.eval("var is_offseason = " + (window.is_offseason ? "true" : "false") + ";");
        window.eval("var reportNflByeWeeks_ar = window.reportNflByeWeeks_ar || [];");
      }
    } catch (e) {}
    if (!window.UPS_IS_OFFSEASON_META || typeof window.UPS_IS_OFFSEASON_META !== "object") {
      window.UPS_IS_OFFSEASON_META = {
        siteSeason: siteSeason,
        currentYear: currentYear,
        todayISO: today.toISOString(),
        deadline: safeStr(deadlineRaw),
        seasonComplete: safeStr(seasonCompleteRaw),
        resolvedFromEvents: !!seasonEvents
      };
    }
  })();

  var script = document.currentScript;
  if (!script) {
    var candidates = Array.prototype.slice.call(
      document.querySelectorAll('script[data-ups-partial][src*="loader.js"]')
    );
    for (var i = candidates.length - 1; i >= 0; i -= 1) {
      if (!candidates[i].getAttribute("data-ups-bound")) {
        script = candidates[i];
        break;
      }
    }
  }
  if (!script) return;
  script.setAttribute("data-ups-bound", "1");

  var PARTIAL_MAP = {
    header: "/apps/mfl_site/header_custom_v2.html",
    footer: "/apps/mfl_site/footer_custom_v2.html",
    "hpm-default": "/site/hpm-default.html",
    "hpm-mcm": "/site/hpm-mcm.html",
    "hpm-standings": "/site/hpm-standings.html"
  };

  function safeStr(value) {
    return (value == null ? "" : String(value)).trim();
  }

  function safeLower(value) {
    return (value || "").toString().trim().toLowerCase();
  }

  function deriveRepoBasePath(scriptPathname) {
    var p = (scriptPathname || "").toString();
    var marker = "/site/loader.js";
    var idx = p.lastIndexOf(marker);
    if (idx >= 0) return p.slice(0, idx);
    return "";
  }

  function getLeagueContext() {
    var ctx = {
      host: safeStr(window.location.host || ""),
      season: "",
      leagueId: "",
      baseUrl: ""
    };
    try {
      var u = new URL(window.location.href || "");
      var path = safeStr(u.pathname);
      var season = safeStr(
        u.searchParams.get("YEAR") ||
          u.searchParams.get("season") ||
          (path.match(/\/(\d{4})(?:\/|$)/) || [])[1] ||
          ""
      ).replace(/\D/g, "");
      var leagueId = safeStr(
        u.searchParams.get("L") ||
          u.searchParams.get("league_id") ||
          (path.match(/\/home\/(\d+)(?:\/|$)/i) || [])[1] ||
          ""
      ).replace(/\D/g, "");
      ctx.host = safeStr(u.host || ctx.host);
      ctx.season = season;
      ctx.leagueId = leagueId;
      if (ctx.host) {
        var protocol = safeStr(u.protocol || window.location.protocol || "https:");
        ctx.baseUrl = protocol + "//" + ctx.host + (ctx.season ? ("/" + ctx.season) : "");
      }
    } catch (e) {
      var pathFallback = safeStr(window.location.pathname);
      ctx.season = safeStr((pathFallback.match(/\/(\d{4})(?:\/|$)/) || [])[1]).replace(/\D/g, "");
      ctx.leagueId = safeStr((pathFallback.match(/\/home\/(\d+)(?:\/|$)/i) || [])[1]).replace(/\D/g, "");
      if (ctx.host) {
        var protocolFallback = safeStr(window.location.protocol || "https:");
        ctx.baseUrl = protocolFallback + "//" + ctx.host + (ctx.season ? ("/" + ctx.season) : "");
      }
    }
    return ctx;
  }

  if (typeof window.getLeagueContext !== "function") {
    window.getLeagueContext = getLeagueContext;
  }

  function detectYear() {
    var ctx = getLeagueContext();
    return ctx.season || String(new Date().getFullYear());
  }

  function detectLeagueId() {
    var ctx = getLeagueContext();
    return ctx.leagueId || "";
  }

  function applyMflTokens(html) {
    var out = html || "";
    var host = window.location.host || "";
    var year = detectYear();
    var leagueId = detectLeagueId();
    out = out.replace(/%HOST%/g, host);
    out = out.replace(/%YEAR%/g, year);
    if (leagueId) out = out.replace(/%LEAGUEID%/g, leagueId);
    return out;
  }

  function normalizeHtml(partial, html) {
    var out = applyMflTokens(html || "");

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
  var repoBasePath = deriveRepoBasePath(scriptUrl.pathname);
  var normalizedSourcePath = sourcePath.charAt(0) === "/" ? sourcePath : "/" + sourcePath;
  var sourceUrl = new URL(repoBasePath + normalizedSourcePath, scriptUrl.origin);
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
