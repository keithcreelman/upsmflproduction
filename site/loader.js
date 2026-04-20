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
    "hpm-standings": "/site/hpm-standings.html",
    "hpm-issue-report": "/site/hpm-issue-report.html",
    "hpm-ccc": "/site/hpm-ccc.html",
    "hpm-widget": "/site/hpm-widget.html",
    "hpm-reports": "/site/hpm-reports.html",
    "hpm-ext-assist": "/site/hpm-ext-assist.html",
    "hpm-draft-hub": "/site/hpm-draft-hub.html"
  };

  function safeStr(value) {
    return (value == null ? "" : String(value)).trim();
  }

  function safeLower(value) {
    return (value || "").toString().trim().toLowerCase();
  }

  function initLaunchOverlay() {
    if (window.__UPS_LAUNCH_OVERLAY_INIT) return;
    window.__UPS_LAUNCH_OVERLAY_INIT = true;

    var targetTime = new Date("2026-03-09T20:00:00-04:00").getTime();
    var dismissKey = "ups_launch_overlay_dismissed_20260309_2000_et";
    var styleId = "upsLaunchOverlayStyle";
    var rootId = "upsLaunchOverlayRoot";
    var intervalId = 0;
    var root = null;
    var overlay = null;
    var reopen = null;
    var summaryNodes = [];
    var countdownNodes = {
      days: null,
      hours: null,
      minutes: null,
      seconds: null
    };

    function pad(value) {
      var n = Math.max(0, Math.floor(Number(value) || 0));
      return n < 10 ? "0" + n : String(n);
    }

    function computeParts(ms) {
      var totalSeconds = Math.max(0, Math.floor(ms / 1000));
      return {
        days: Math.floor(totalSeconds / 86400),
        hours: Math.floor((totalSeconds % 86400) / 3600),
        minutes: Math.floor((totalSeconds % 3600) / 60),
        seconds: totalSeconds % 60
      };
    }

    function setText(node, value) {
      if (node) node.textContent = value;
    }

    function ensureStyles() {
      var css = "";
      var head = document.head || document.documentElement;
      var styleNode = document.getElementById(styleId);
      if (styleNode || !head) return;
      styleNode = document.createElement("style");
      styleNode.id = styleId;
      css += ".ups-launch-overlay[hidden],.ups-launch-chip[hidden]{display:none!important;}";
      css += ".ups-launch-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:1rem;}";
      css += ".ups-launch-overlay__scrim{position:absolute;inset:0;background:rgba(4,10,20,.82);backdrop-filter:blur(8px);}";
      css += ".ups-launch-overlay__panel{position:relative;z-index:1;width:min(100%,720px);padding:clamp(1.5rem,3vw,2.4rem);border:1px solid rgba(155,196,255,.3);border-radius:28px;background:linear-gradient(145deg,rgba(8,18,35,.98) 0%,rgba(17,38,72,.98) 100%);box-shadow:0 32px 80px rgba(0,0,0,.45);color:#fff;text-align:center;}";
      css += ".ups-launch-overlay__eyebrow{margin:0 0 .9rem;color:#f0c465;font-size:.78rem;font-weight:900;letter-spacing:.18em;text-transform:uppercase;}";
      css += ".ups-launch-overlay__title{margin:0;color:#fff;font-size:clamp(2rem,5vw,3.6rem);line-height:.95;text-transform:uppercase;}";
      css += ".ups-launch-overlay__lead{margin:.9rem 0 0;color:#f0c465;font-size:clamp(1rem,2.4vw,1.3rem);font-weight:900;letter-spacing:.04em;}";
      css += ".ups-launch-overlay__copy,.ups-launch-overlay__status{margin:.85rem auto 0;max-width:38rem;color:#e8effa;font-size:1rem;line-height:1.45;}";
      css += ".ups-launch-overlay__status strong,.ups-launch-chip__time{color:#f0c465;}";
      css += ".ups-launch-countdown{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.8rem;margin:1.5rem 0 0;}";
      css += ".ups-launch-countdown__segment{border:1px solid rgba(142,196,255,.18);border-radius:20px;background:rgba(8,18,35,.72);padding:1rem .65rem .9rem;}";
      css += ".ups-launch-countdown__segment span{display:block;color:#fff;font-size:clamp(1.8rem,4vw,2.8rem);font-weight:900;line-height:1;}";
      css += ".ups-launch-countdown__segment small{display:block;margin-top:.45rem;color:#9fb3d1;font-size:.72rem;font-weight:800;letter-spacing:.16em;text-transform:uppercase;}";
      css += ".ups-launch-overlay__button,.ups-launch-chip{border:1px solid #4a75b7;background:linear-gradient(180deg,#1f4d93 0%,#1f3f78 100%);color:#fff;box-shadow:0 12px 28px rgba(0,0,0,.35);font-weight:900;cursor:pointer;}";
      css += ".ups-launch-overlay__button{margin-top:1.35rem;min-width:11rem;padding:.9rem 1.35rem;border-radius:999px;font-size:.92rem;letter-spacing:.08em;text-transform:uppercase;}";
      css += ".ups-launch-chip{position:fixed;right:1rem;bottom:1rem;z-index:2147482900;display:inline-flex;align-items:center;gap:.45rem;padding:.8rem 1rem;border-radius:999px;font-size:.82rem;}";
      css += ".ups-launch-chip__label{opacity:.82;text-transform:uppercase;letter-spacing:.08em;}";
      css += "@media (max-width:720px){.ups-launch-overlay{padding:.75rem;}.ups-launch-overlay__panel{border-radius:22px;}.ups-launch-countdown{grid-template-columns:repeat(2,minmax(0,1fr));}.ups-launch-chip{left:.75rem;right:.75rem;bottom:.75rem;justify-content:center;border-radius:16px;}}";
      styleNode.textContent = css;
      head.appendChild(styleNode);
    }

    function teardown() {
      if (intervalId) {
        window.clearInterval(intervalId);
        intervalId = 0;
      }
      try {
        window.sessionStorage.removeItem(dismissKey);
      } catch (e) {}
      if (root && root.parentNode) root.parentNode.removeChild(root);
      root = null;
      overlay = null;
      reopen = null;
      summaryNodes = [];
      countdownNodes.days = null;
      countdownNodes.hours = null;
      countdownNodes.minutes = null;
      countdownNodes.seconds = null;
    }

    function renderCountdown() {
      var compact = "";
      var i = 0;
      var parts = null;
      var remaining = targetTime - Date.now();

      if (!(remaining > 0)) {
        teardown();
        return;
      }

      parts = computeParts(remaining);
      setText(countdownNodes.days, pad(parts.days));
      setText(countdownNodes.hours, pad(parts.hours));
      setText(countdownNodes.minutes, pad(parts.minutes));
      setText(countdownNodes.seconds, pad(parts.seconds));

      compact = parts.days > 0
        ? parts.days + "d " + pad(parts.hours) + "h " + pad(parts.minutes) + "m"
        : pad(parts.hours) + ":" + pad(parts.minutes) + ":" + pad(parts.seconds);

      for (i = 0; i < summaryNodes.length; i += 1) {
        setText(summaryNodes[i], compact);
      }
    }

    function hideOverlay(persistDismissal) {
      if (overlay) overlay.setAttribute("hidden", "hidden");
      if (reopen) reopen.removeAttribute("hidden");
      if (persistDismissal) {
        try {
          window.sessionStorage.setItem(dismissKey, "1");
        } catch (e) {}
      }
    }

    function showOverlay() {
      if (overlay) overlay.removeAttribute("hidden");
      if (reopen) reopen.setAttribute("hidden", "hidden");
    }

    function bindActions() {
      if (!root) return;
      root.addEventListener("click", function (evt) {
        var node = evt && evt.target ? evt.target : null;
        while (node && node !== root) {
          if (node.id === "upsLaunchDismiss") {
            hideOverlay(true);
            return;
          }
          if (node.id === "upsLaunchReopen") {
            showOverlay();
            return;
          }
          node = node.parentNode;
        }
      });
    }

    function buildMarkup() {
      var dismissed = false;
      var host = document.body || document.documentElement;
      if (!host || document.getElementById(rootId)) return;

      ensureStyles();
      root = document.createElement("div");
      root.id = rootId;
      root.innerHTML =
        '<div id="upsLaunchOverlay" class="ups-launch-overlay" role="dialog" aria-modal="true" aria-labelledby="upsLaunchTitle">' +
          '<div class="ups-launch-overlay__scrim"></div>' +
          '<div class="ups-launch-overlay__panel">' +
            '<div class="ups-launch-overlay__eyebrow">UPS Fantasy Football League</div>' +
            '<h2 id="upsLaunchTitle" class="ups-launch-overlay__title">Official Website Launch</h2>' +
            '<p class="ups-launch-overlay__lead">Monday, March 9, 2026 at 8:00 PM ET</p>' +
            '<p class="ups-launch-overlay__copy">The site officially opens when this countdown reaches zero.</p>' +
            '<div class="ups-launch-countdown" aria-live="polite" aria-atomic="true">' +
              '<div class="ups-launch-countdown__segment"><span data-ups-launch-days>00</span><small>Days</small></div>' +
              '<div class="ups-launch-countdown__segment"><span data-ups-launch-hours>00</span><small>Hours</small></div>' +
              '<div class="ups-launch-countdown__segment"><span data-ups-launch-minutes>00</span><small>Minutes</small></div>' +
              '<div class="ups-launch-countdown__segment"><span data-ups-launch-seconds>00</span><small>Seconds</small></div>' +
            '</div>' +
            '<p class="ups-launch-overlay__status">Time remaining: <strong data-ups-launch-summary>00:00:00</strong></p>' +
            '<button type="button" id="upsLaunchDismiss" class="ups-launch-overlay__button">Enter Site</button>' +
          '</div>' +
        '</div>' +
        '<button type="button" id="upsLaunchReopen" class="ups-launch-chip" hidden>' +
          '<span class="ups-launch-chip__label">Official launch:</span>' +
          '<span class="ups-launch-chip__time" data-ups-launch-summary>00:00:00</span>' +
        '</button>';
      host.appendChild(root);

      overlay = document.getElementById("upsLaunchOverlay");
      reopen = document.getElementById("upsLaunchReopen");
      countdownNodes.days = root.querySelector("[data-ups-launch-days]");
      countdownNodes.hours = root.querySelector("[data-ups-launch-hours]");
      countdownNodes.minutes = root.querySelector("[data-ups-launch-minutes]");
      countdownNodes.seconds = root.querySelector("[data-ups-launch-seconds]");
      summaryNodes = Array.prototype.slice.call(root.querySelectorAll("[data-ups-launch-summary]"));

      bindActions();
      try {
        dismissed = window.sessionStorage.getItem(dismissKey) === "1";
      } catch (e) {}
      if (dismissed) {
        hideOverlay(false);
      } else {
        showOverlay();
      }
    }

    function start() {
      if (!(targetTime > Date.now())) return;
      buildMarkup();
      if (!root) return;
      renderCountdown();
      intervalId = window.setInterval(renderCountdown, 1000);
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }
  }

  initLaunchOverlay();

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

  function loadExtAssistAssets() {
    var sha = window.UPS_RELEASE_SHA || "main";
    var base = "https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@" + sha;

    /* CSS — append to <head> once */
    if (!document.getElementById("extAssistCss")) {
      var link = document.createElement("link");
      link.id = "extAssistCss";
      link.rel = "stylesheet";
      link.href = base + "/site/ccc/extension_assistant.css";
      (document.head || document.documentElement).appendChild(link);
    }

    /* JS — append to <body> once; wire launcher button on load */
    if (!document.getElementById("extAssistJs")) {
      var s = document.createElement("script");
      s.id = "extAssistJs";
      s.src = base + "/site/ccc/extension_assistant.js";
      s.async = false;
      s.addEventListener("load", function () {
        var btn = document.getElementById("extAssistLaunchBtn");
        if (btn && typeof window.openExtensionAssistant === "function") {
          btn.addEventListener("click", window.openExtensionAssistant);
        }
      });
      document.body.appendChild(s);
    }
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
      if (partial === "hpm-ext-assist") {
        loadExtAssistAssets();
      }
    })
    .catch(function (err) {
      mount.innerHTML =
        '<div style="padding:0.6rem;border:1px solid #8b1f2f;background:#2a0f19;color:#ffe4ea;font-weight:700;">' +
        "Hosted include load failed: " +
        String(err && err.message ? err.message : err) +
        "</div>";
    });
})();
