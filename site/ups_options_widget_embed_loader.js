(function () {
  "use strict";

  function getUrl() {
    try {
      return new URL(window.location.href);
    } catch (e) {
      return null;
    }
  }

  function safeLower(v) {
    return String(v || "").toLowerCase();
  }

  function getLeagueId(u) {
    if (!u) return "74598";
    var q = u.searchParams.get("L");
    if (q) return q;
    var m = String(window.location.pathname || "").match(/\/home\/(\d+)(?:\/|$)/i);
    return m ? m[1] : "74598";
  }

  function getYear(u) {
    if (!u) return String(new Date().getFullYear());
    var q = u.searchParams.get("YEAR");
    if (q) return q;
    var m = String(window.location.pathname || "").match(/\/(\d{4})\//);
    return m ? m[1] : String(new Date().getFullYear());
  }

  function getOrigin() {
    try {
      return String(window.location.origin || "").replace(/\/+$/, "");
    } catch (e) {
      return "https://www48.myfantasyleague.com";
    }
  }

  function getModuleName(u) {
    if (!u) return "";
    return safeLower(u.searchParams.get("MODULE"));
  }

  function getOwnerActivityWeek(u) {
    if (u) {
      var q = Number(u.searchParams.get("W"));
      if (Number.isFinite(q) && q > 0) return String(Math.floor(q));
    }
    var live = Number(window.liveScoringWeek);
    if (Number.isFinite(live) && live > 0) return String(Math.floor(live));
    var completed = Number(window.completedWeek);
    if (Number.isFinite(completed) && completed >= 0) return String(Math.floor(completed + 1));
    return "1";
  }

  function isMflContext() {
    return /myfantasyleague\.com$/i.test(String(window.location.hostname || ""));
  }

  function normalizeMode(v) {
    return safeLower(v) === "light" ? "light" : "dark";
  }

  function normalizeExplicitMode(v) {
    var mode = safeLower(v);
    return mode === "light" || mode === "dark" ? mode : "";
  }

  var u = getUrl();
  var L = getLeagueId(u);
  var YEAR = getYear(u);
  var MODE_KEY = "ups_mode_" + YEAR + "_" + L;
  var MODULE_NAME = getModuleName(u);

  var LATEST_JSON_URL = "https://keithcreelman.github.io/upsmflproduction/ups_options_widget_latest.json";
  var LATEST_JS_URL = "https://keithcreelman.github.io/upsmflproduction/ups_options_widget_latest.js";
  var DEFAULT_CACHE = "20260214a";

  function inferModeFromSystem() {
    if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
    return "light";
  }

  function getHostMode() {
    if (typeof window.getUPSMode === "function") return normalizeMode(window.getUPSMode());
    var attr = document.documentElement.getAttribute("data-ups-mode");
    if (attr) return normalizeMode(attr);
    try {
      var stored = localStorage.getItem(MODE_KEY);
      if (stored) return normalizeMode(stored);
    } catch (e) {}
    return inferModeFromSystem();
  }

  function setHostMode(mode, persist) {
    var next = normalizeExplicitMode(mode);
    if (!next) return;
    if (typeof window.setUPSMode === "function") {
      window.setUPSMode(next);
      return;
    }
    document.documentElement.setAttribute("data-ups-mode", next);
    document.documentElement.style.colorScheme = next;
    if (persist) {
      try {
        localStorage.setItem(MODE_KEY, next);
      } catch (e) {}
    }
    try {
      document.dispatchEvent(new CustomEvent("ups-theme-change", { detail: { mode: next } }));
    } catch (e) {}
  }

  function ensureMount() {
    var mount = document.getElementById("uowMount");
    if (!mount) {
      mount = document.createElement("div");
      mount.id = "uowMount";
      (document.body || document.documentElement).appendChild(mount);
    }
    return mount;
  }

  function resolveLatestCache(cb) {
    var done = false;
    function finish(cacheKey) {
      if (done) return;
      done = true;
      cb(cacheKey || DEFAULT_CACHE);
    }

    try {
      fetch(LATEST_JSON_URL, { cache: "no-store" })
        .then(function (res) { return res && res.ok ? res.json() : null; })
        .then(function (data) {
          var v = data && (data.cache || data.version || data.v);
          if (v) finish(String(v));
          else throw new Error("Missing version");
        })
        .catch(function () {
          var s = document.createElement("script");
          s.src = LATEST_JS_URL + "?v=" + Date.now();
          s.onload = function () {
            finish(window.UOW_LATEST_VERSION || "");
          };
          s.onerror = function () { finish(DEFAULT_CACHE); };
          (document.head || document.documentElement).appendChild(s);
        });
    } catch (e) {
      finish(DEFAULT_CACHE);
    }

    setTimeout(function () { finish(DEFAULT_CACHE); }, 3000);
  }

  function buildLegacySrc(cacheKey, mode) {
    var cache = cacheKey || DEFAULT_CACHE;
    var theme = normalizeMode(mode || getHostMode());
    return (
      "https://keithcreelman.github.io/upsmflproduction/ups_options_widget.html" +
      "?cache=" + encodeURIComponent(cache) +
      "&L=" + encodeURIComponent(L) +
      "&YEAR=" + encodeURIComponent(YEAR) +
      "&THEME=" + encodeURIComponent(theme)
    );
  }

  function postThemeToWidget(iframe, mode) {
    if (!iframe || !iframe.contentWindow) return;
    try {
      iframe.contentWindow.postMessage({ type: "ups-theme", mode: normalizeMode(mode) }, "*");
    } catch (e) {}
  }

  function syncLegacyIframeTheme(iframe, mode) {
    if (!iframe) return;
    var nextMode = normalizeMode(mode || getHostMode());
    var srcAttr = iframe.getAttribute("src");
    if (srcAttr) {
      try {
        var src = new URL(srcAttr, window.location.href);
        var before = src.toString();
        src.searchParams.set("THEME", nextMode);
        src.searchParams.set("theme", nextMode);
        var after = src.toString();
        if (after !== before) iframe.src = after;
      } catch (e) {}
    }
    postThemeToWidget(iframe, nextMode);
  }

  function mountLegacyCountdown(mount) {
    mount.innerHTML = "";
    var iframe = document.createElement("iframe");
    iframe.style.width = "100%";
    iframe.style.height = "480px";
    iframe.style.border = "0";
    iframe.setAttribute("loading", "lazy");
    iframe.setAttribute("scrolling", "no");
    mount.appendChild(iframe);

    resolveLatestCache(function (cacheKey) {
      iframe.src = buildLegacySrc(cacheKey, getHostMode());
    });

    iframe.addEventListener("load", function () {
      syncLegacyIframeTheme(iframe, getHostMode());
    });

    function onMessage(e) {
      if (!iframe.contentWindow || e.source !== iframe.contentWindow) return;
      if (e.origin !== "https://keithcreelman.github.io") return;
      var data = e.data || {};
      if (!data) return;

      if (data.type === "uow-height") {
        var next = Number(data.height);
        if (!Number.isFinite(next) || next <= 0) return;
        var clamped = Math.max(280, Math.min(20000, Math.ceil(next)));
        iframe.style.height = String(clamped) + "px";
        return;
      }
    }

    window.addEventListener("message", onMessage, false);
    document.addEventListener("ups-theme-change", function (ev) {
      var mode = normalizeMode(ev && ev.detail ? ev.detail.mode : getHostMode());
      syncLegacyIframeTheme(iframe, mode);
    });
  }

  function injectModuleStyles() {
    if (document.getElementById("ups-owner-hub-module-stack-styles")) return;
    var css = [
      "#uowMount.ups-owner-hub-modules{width:100%}",
      "#uowMount .uow-mod-stack{display:grid;gap:12px}",
      "#uowMount .uow-mod-card{border:1px solid rgba(231,190,89,.45);border-radius:12px;background:linear-gradient(180deg,rgba(11,26,50,.95),rgba(8,18,34,.95));overflow:hidden;box-shadow:0 8px 20px rgba(0,0,0,.18)}",
      "#uowMount .uow-mod-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border-bottom:1px solid rgba(231,190,89,.2)}",
      "#uowMount .uow-mod-head-main{display:flex;align-items:center;gap:8px;min-width:0}",
      "#uowMount .uow-mod-toggle{width:28px;height:28px;border-radius:8px;border:1px solid rgba(231,190,89,.35);background:rgba(255,255,255,.04);color:#e7be59;font-weight:700;cursor:pointer;line-height:1}",
      "#uowMount .uow-mod-title{font-weight:800;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--ups-text,#e8effa)}",
      "#uowMount .uow-mod-open{font-size:11px;font-weight:700;text-decoration:none;color:var(--ups-gold,#e7be59);white-space:nowrap}",
      "#uowMount .uow-mod-open:hover{text-decoration:underline}",
      "#uowMount .uow-mod-body{padding:0}",
      "#uowMount .uow-mod-frame{display:block;width:100%;border:0;min-height:220px;background:transparent}",
      "#uowMount .uow-mod-placeholder{padding:14px 12px;color:var(--ups-muted,#b9c8e2);font-size:12px}",
      "#uowMount .uow-mod-card[data-collapsed='1'] .uow-mod-body{display:none}",
      "#uowMount .uow-mod-card[data-collapsed='1'] .uow-mod-head{border-bottom:0}",
      "@media (max-width:900px){#uowMount .uow-mod-head{padding:9px 10px}#uowMount .uow-mod-title{font-size:12px}}"
    ].join("");
    var style = document.createElement("style");
    style.id = "ups-owner-hub-module-stack-styles";
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  function readPref(key) {
    try { return sessionStorage.getItem(key) || ""; } catch (e) { return ""; }
  }

  function writePref(key, collapsed) {
    try { sessionStorage.setItem(key, collapsed ? "1" : "0"); } catch (e) {}
  }

  function safeText(v) {
    return String(v == null ? "" : v);
  }

  function buildModuleUrl(config) {
    var base = getOrigin() + "/" + YEAR + "/home/" + L;
    if (config.type === "message17") {
      return base + "?MODULE=MESSAGE17&PRINTER=1&UPS_UOW_EMBED=1";
    }
    if (config.type === "owner_activity") {
      return base + "?MODULE=OWNER_ACTIVITY&W=" + encodeURIComponent(getOwnerActivityWeek(u)) + "&PRINTER=1&UPS_UOW_EMBED=1";
    }
    return base;
  }

  function buildModuleOpenUrl(config) {
    var base = getOrigin() + "/" + YEAR + "/home/" + L;
    if (config.type === "message17") return base + "?MODULE=MESSAGE17";
    if (config.type === "owner_activity") return base + "?MODULE=OWNER_ACTIVITY&W=" + encodeURIComponent(getOwnerActivityWeek(u));
    return base;
  }

  function setCollapsed(card, collapsed, persist) {
    if (!card) return;
    var next = !!collapsed;
    card.setAttribute("data-collapsed", next ? "1" : "0");
    var btn = card.querySelector(".uow-mod-toggle");
    if (btn) {
      btn.textContent = next ? "▸" : "▾";
      btn.setAttribute("aria-expanded", next ? "false" : "true");
      btn.setAttribute("title", next ? "Expand module" : "Collapse module");
    }
    if (persist) writePref("ups_uow_mod_" + safeText(card.getAttribute("data-key")), next);
  }

  function clampHeight(n) {
    var v = Number(n);
    if (!Number.isFinite(v) || v <= 0) return 320;
    return Math.max(220, Math.min(2200, Math.ceil(v)));
  }

  function tryInjectIframeCleanup(iframe) {
    try {
      var doc = iframe.contentDocument;
      if (!doc || !doc.documentElement) return;
      if (!doc.getElementById("ups-uow-iframe-cleanup")) {
        var st = doc.createElement("style");
        st.id = "ups-uow-iframe-cleanup";
        st.textContent = [
          "html,body{margin:0!important;padding:0!important;background:transparent!important;}",
          "h2{display:none!important;}",
          ".pagebody{margin:0!important;padding:0!important;}",
          "body > .pagefooter, body > .myfantasyleague_menu, body > .pageheader {display:none!important;}"
        ].join("");
        (doc.head || doc.documentElement).appendChild(st);
      }
    } catch (e) {}
  }

  function measureIframeHeight(iframe) {
    try {
      var doc = iframe.contentDocument;
      if (!doc) return 0;
      var b = doc.body;
      var d = doc.documentElement;
      var pageBody = doc.querySelector(".pagebody") || doc.getElementById("home") || b;
      return Math.max(
        pageBody && pageBody.scrollHeight || 0,
        b && b.scrollHeight || 0,
        d && d.scrollHeight || 0,
        pageBody && pageBody.offsetHeight || 0,
        b && b.offsetHeight || 0,
        d && d.offsetHeight || 0
      );
    } catch (e) {
      return 0;
    }
  }

  function detectRecursiveMessage17(iframe) {
    try {
      var doc = iframe.contentDocument;
      if (!doc) return false;
      var html = safeText(doc.documentElement ? doc.documentElement.innerHTML : "");
      if (!html) return false;
      return /id=["']uowMount["']/i.test(html) && /ups_options_widget_embed_loader/i.test(html);
    } catch (e) {
      return false;
    }
  }

  function mountLegacyCountdownInside(container) {
    container.innerHTML = "";
    var tempMount = document.createElement("div");
    tempMount.className = "uow-legacy-inline";
    container.appendChild(tempMount);
    mountLegacyCountdown(tempMount);
  }

  function createModuleCard(config) {
    var card = document.createElement("section");
    card.className = "uow-mod-card";
    card.setAttribute("data-key", config.key);
    card.innerHTML =
      '<div class="uow-mod-head">' +
        '<div class="uow-mod-head-main">' +
          '<button type="button" class="uow-mod-toggle" aria-label="Toggle module"></button>' +
          '<div class="uow-mod-title"></div>' +
        "</div>" +
        '<a class="uow-mod-open" target="_top" rel="noopener">Open</a>' +
      "</div>" +
      '<div class="uow-mod-body"><div class="uow-mod-placeholder">Loading…</div></div>';
    card.querySelector(".uow-mod-title").textContent = config.title;
    card.querySelector(".uow-mod-open").href = buildModuleOpenUrl(config);
    return card;
  }

  function wireModuleCard(card, config) {
    var body = card.querySelector(".uow-mod-body");
    var head = card.querySelector(".uow-mod-head");
    var toggleBtn = card.querySelector(".uow-mod-toggle");
    var loaded = false;
    var loaderRan = false;

    function syncFrameHeight(iframe) {
      tryInjectIframeCleanup(iframe);
      var h = clampHeight(measureIframeHeight(iframe));
      iframe.style.height = String(h) + "px";
    }

    function startHeightSync(iframe) {
      syncFrameHeight(iframe);
      var ticks = 0;
      var timer = setInterval(function () {
        ticks += 1;
        syncFrameHeight(iframe);
        if (ticks >= 20) clearInterval(timer);
      }, 300);
    }

    function loadContent() {
      if (loaderRan || !body) return;
      loaderRan = true;
      body.innerHTML = "";

      if (config.type === "message17-legacy") {
        mountLegacyCountdownInside(body);
        loaded = true;
        return;
      }

      var iframe = document.createElement("iframe");
      iframe.className = "uow-mod-frame";
      iframe.setAttribute("loading", "lazy");
      iframe.setAttribute("scrolling", "no");
      iframe.src = buildModuleUrl(config);
      body.appendChild(iframe);

      iframe.addEventListener("load", function () {
        if (config.type === "message17" && detectRecursiveMessage17(iframe)) {
          // MESSAGE17 page contains the widget snippet; render the stable countdown widget inline instead.
          body.innerHTML = "";
          mountLegacyCountdownInside(body);
          loaded = true;
          return;
        }
        loaded = true;
        startHeightSync(iframe);
      });
    }

    function toggle(nextCollapsed, persist) {
      setCollapsed(card, nextCollapsed, persist);
      if (!nextCollapsed && !loaded) loadContent();
    }

    var defaultCollapsed = !!config.defaultCollapsed;
    var saved = readPref("ups_uow_mod_" + config.key);
    if (saved === "1") defaultCollapsed = true;
    if (saved === "0") defaultCollapsed = false;
    toggle(defaultCollapsed, false);

    if (toggleBtn && !toggleBtn.dataset.wired) {
      toggleBtn.dataset.wired = "1";
      toggleBtn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        var collapsed = card.getAttribute("data-collapsed") === "1";
        toggle(!collapsed, true);
      });
    }

    if (head && !head.dataset.wired) {
      head.dataset.wired = "1";
      head.addEventListener("click", function (e) {
        var t = e.target;
        if (t && (t.closest && t.closest(".uow-mod-open"))) return;
        var collapsed = card.getAttribute("data-collapsed") === "1";
        toggle(!collapsed, true);
      });
    }

    if (!defaultCollapsed) loadContent();
  }

  function mountModuleStack(mount) {
    injectModuleStyles();
    mount.classList.add("ups-owner-hub-modules");
    mount.innerHTML = "";

    var stack = document.createElement("div");
    stack.className = "uow-mod-stack";
    mount.appendChild(stack);

    var modules = [
      { key: "message17", title: "Countdown Timer", type: "message17", defaultCollapsed: false },
      { key: "owner_activity", title: "Owner Activity", type: "owner_activity", defaultCollapsed: true }
    ];

    modules.forEach(function (config) {
      var card = createModuleCard(config);
      stack.appendChild(card);
      wireModuleCard(card, config);
    });
  }

  function shouldUseModuleStack() {
    if (!isMflContext()) return false;
    if (!u) return false;
    // Preserve standalone MESSAGE17 page behavior; use countdown widget there to avoid module recursion.
    if (MODULE_NAME === "message17") return false;
    // If this loader is executing inside an embedded module page, do not create nested module stacks.
    if (window.top !== window.self && u.searchParams.get("UPS_UOW_EMBED") === "1") return false;
    return true;
  }

  var mount = ensureMount();

  if (shouldUseModuleStack()) {
    mountModuleStack(mount);
    return;
  }

  // Legacy countdown widget fallback:
  // - standalone MESSAGE17 page
  // - non-MFL contexts
  // - embedded module page recursion guard
  mountLegacyCountdown(mount);
})();
