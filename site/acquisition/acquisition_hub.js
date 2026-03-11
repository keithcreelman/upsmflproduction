(function () {
  "use strict";

  var BUILD = "2026.03.11.01";
  var BOOT_FLAG = "__ups_acq_hub_boot_" + BUILD;
  if (window[BOOT_FLAG]) {
    if (typeof window.UPS_ACQ_INIT === "function") window.UPS_ACQ_INIT();
    return;
  }
  window[BOOT_FLAG] = true;

  var MODULES = window.UPS_ACQ_MODULES || {};
  var REFRESH = window.UPS_ACQ_REFRESH || {};

  var state = {
    ctx: null,
    bootstrap: null,
    bootstrapError: "",
    activeKey: "rookie-draft",
    shared: {
      teamId: "",
      search: ""
    },
    modules: {},
    busyAction: false
  };

  var root = null;
  var refreshManager = null;
  var bootstrapTimer = 0;

  function safeStr(value) {
    return value == null ? "" : String(value).trim();
  }

  function safeInt(value, fallback) {
    var n = parseInt(String(value == null ? "" : value), 10);
    return isFinite(n) ? n : (fallback == null ? 0 : fallback);
  }

  function escapeHtml(value) {
    return safeStr(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function readCookie(name) {
    try {
      var parts = String(document.cookie || "").split(";");
      for (var i = 0; i < parts.length; i += 1) {
        var part = String(parts[i] || "").trim();
        if (!part) continue;
        var eq = part.indexOf("=");
        var key = eq >= 0 ? part.slice(0, eq).trim() : part;
        if (key !== name) continue;
        var value = eq >= 0 ? part.slice(eq + 1) : "";
        try {
          return decodeURIComponent(value);
        } catch (e) {
          return value;
        }
      }
    } catch (e) {}
    return "";
  }

  function getUrl() {
    try {
      return new URL(window.location.href);
    } catch (e) {
      return null;
    }
  }

  function detectContext() {
    var url = getUrl();
    var out = { leagueId: "", year: "", apiUrl: "", viewerUserId: "", apiKey: "" };
    if (url) {
      out.leagueId = safeStr(url.searchParams.get("L")).replace(/\D/g, "");
      out.year = safeStr(url.searchParams.get("YEAR")).replace(/\D/g, "");
      out.apiUrl = safeStr(url.searchParams.get("api"));
      out.viewerUserId = safeStr(url.searchParams.get("MFL_USER_ID"));
      out.apiKey = safeStr(url.searchParams.get("APIKEY"));
    }
    if (!out.year) {
      var yearMatch = safeStr(window.location.pathname).match(/\/(\d{4})\//);
      if (yearMatch && yearMatch[1]) out.year = yearMatch[1];
    }
    if (!out.leagueId) {
      var leagueMatch = safeStr(window.location.pathname).match(/\/home\/(\d+)(?:\/|$)/i);
      if (leagueMatch && leagueMatch[1]) out.leagueId = leagueMatch[1];
    }
    if (!out.leagueId) out.leagueId = safeStr(window.league_id || window.LEAGUE_ID).replace(/\D/g, "");
    if (!out.year) out.year = safeStr(window.year || window.YEAR).replace(/\D/g, "");
    if (!out.year) out.year = String(new Date().getFullYear());
    if (!out.apiUrl) {
      out.apiUrl = safeStr(window.UPS_ACQ_API || "https://upsmflproduction.keith-creelman.workers.dev");
    }
    if (!out.viewerUserId) out.viewerUserId = safeStr(readCookie("MFL_USER_ID"));
    return out;
  }

  function getHashRoute() {
    var hash = safeStr(window.location.hash).replace(/^#/, "");
    var params = new URLSearchParams(hash);
    var route = safeStr(params.get("acq")).toLowerCase();
    return MODULES[route] ? route : "rookie-draft";
  }

  function setHashRoute(route) {
    var params = new URLSearchParams(safeStr(window.location.hash).replace(/^#/, ""));
    params.set("acq", route);
    window.location.hash = params.toString();
  }

  function resolveApiUrl(path, extraParams) {
    var base = safeStr(state.ctx && state.ctx.apiUrl).replace(/\/+$/, "");
    var url = new URL(base + safeStr(path), window.location.href);
    if (!url.searchParams.get("L")) url.searchParams.set("L", safeStr(state.ctx.leagueId));
    if (!url.searchParams.get("YEAR")) url.searchParams.set("YEAR", safeStr(state.ctx.year));
    if (state.ctx.viewerUserId && !url.searchParams.get("MFL_USER_ID")) url.searchParams.set("MFL_USER_ID", state.ctx.viewerUserId);
    if (state.ctx.apiKey && !url.searchParams.get("APIKEY")) url.searchParams.set("APIKEY", state.ctx.apiKey);
    var params = extraParams && typeof extraParams === "object" ? extraParams : {};
    Object.keys(params).forEach(function (key) {
      if (params[key] == null || params[key] === "") return;
      url.searchParams.set(key, params[key]);
    });
    return url.toString();
  }

  function formatMoney(value) {
    var n = Number(value);
    if (!isFinite(n)) return escapeHtml(safeStr(value));
    return "$" + Math.round(n).toLocaleString("en-US");
  }

  function formatTime(value) {
    var src = safeStr(value);
    if (!src) return "Waiting";
    return src;
  }

  function formatAge(iso) {
    var ts = Date.parse(safeStr(iso));
    if (!isFinite(ts)) return "Never";
    var diff = Math.max(0, Date.now() - ts);
    if (diff < 60000) return Math.round(diff / 1000) + "s ago";
    if (diff < 3600000) return Math.round(diff / 60000) + "m ago";
    return Math.round(diff / 3600000) + "h ago";
  }

  function renderTable(columns, rows, emptyMessage) {
    var cols = Array.isArray(columns) ? columns : [];
    var list = Array.isArray(rows) ? rows : [];
    if (!list.length) {
      return '<div class="acq-empty">' + escapeHtml(emptyMessage || "No rows available.") + "</div>";
    }
    var head = cols.map(function (col) {
      return "<th>" + escapeHtml(col.label || col.key) + "</th>";
    }).join("");
    var body = list.map(function (row) {
      return "<tr>" + cols.map(function (col) {
        var raw = row && row[col.key];
        var text = raw;
        if (col.key && /(amount|value|aav|max_bid|reserve_cost|funds|salary|\$\$)/i.test(col.key) && raw !== "" && raw != null) {
          text = formatMoney(raw);
        } else if (/datetime|generated_at|fetched_at/i.test(col.key)) {
          text = formatTime(raw);
        }
        return "<td>" + escapeHtml(text) + "</td>";
      }).join("") + "</tr>";
    }).join("");
    return '' +
      '<div class="acq-table-wrap">' +
        '<table class="acq-table">' +
          "<thead><tr>" + head + "</tr></thead>" +
          "<tbody>" + body + "</tbody>" +
        "</table>" +
      "</div>";
  }

  function fetchJson(path, extraParams) {
    return fetch(resolveApiUrl(path, extraParams), { cache: "no-store" }).then(function (res) {
      return res.json().then(function (payload) {
        if (!res.ok || !payload || payload.ok === false) {
          var err = new Error((payload && (payload.error || payload.reason)) || ("Request failed: " + res.status));
          err.payload = payload;
          throw err;
        }
        return payload;
      });
    });
  }

  function postJson(path, body) {
    return fetch(resolveApiUrl(path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(body || {})
    }).then(function (res) {
      return res.json().then(function (payload) {
        if (!res.ok || !payload || payload.ok === false) {
          var err = new Error((payload && (payload.error || payload.reason)) || ("Request failed: " + res.status));
          err.payload = payload;
          throw err;
        }
        return payload;
      });
    });
  }

  function ensureModuleState(key) {
    if (!state.modules[key]) {
      state.modules[key] = {
        live: null,
        history: null,
        error: "",
        historyLoaded: false
      };
    }
    return state.modules[key];
  }

  function loadBootstrap() {
    return fetchJson("/acquisition-hub/bootstrap").then(function (payload) {
      state.bootstrap = payload;
      state.bootstrapError = "";
      render();
      return payload;
    }).catch(function (err) {
      state.bootstrapError = err && err.message ? err.message : "Bootstrap failed";
      render();
      throw err;
    });
  }

  function scheduleBootstrapRefresh() {
    if (bootstrapTimer) window.clearInterval(bootstrapTimer);
    bootstrapTimer = window.setInterval(function () {
      if (document.hidden) return;
      loadBootstrap().catch(function () {});
    }, 60000);
  }

  function loadModuleHistory(key, force) {
    var moduleConfig = MODULES[key];
    var moduleState = ensureModuleState(key);
    if (!moduleConfig || !moduleConfig.historyPath) return Promise.resolve(null);
    if (moduleState.historyLoaded && !force) return Promise.resolve(moduleState.history);
    return fetchJson(moduleConfig.historyPath).then(function (payload) {
      moduleState.history = payload;
      moduleState.historyLoaded = true;
      moduleState.error = "";
      render();
      return payload;
    }).catch(function (err) {
      moduleState.error = err && err.message ? err.message : "History load failed";
      render();
      throw err;
    });
  }

  function loadModuleLive(key, reason) {
    var moduleConfig = MODULES[key];
    var moduleState = ensureModuleState(key);
    if (!moduleConfig || !moduleConfig.livePath) return Promise.resolve(null);
    return fetchJson(moduleConfig.livePath, { F: state.shared.teamId || "" }).then(function (payload) {
      moduleState.live = payload;
      moduleState.error = "";
      render();
      return payload;
    }).catch(function (err) {
      moduleState.error = err && err.message ? err.message : "Live load failed";
      render();
      throw err;
    });
  }

  function buildNavItems() {
    return [
      { key: "rookie-draft", label: "Rookie Draft" },
      { key: "free-agent-auction", label: "FA Auction" },
      { key: "expired-rookie-auction", label: "Expired Rookies" },
      { key: "waiver-lab", label: "Waiver Lab" }
    ];
  }

  function getRefreshStatus() {
    if (!refreshManager) return { status: "idle", lastSuccessAt: "", lastError: "" };
    return refreshManager.getState(state.activeKey);
  }

  function refreshActive() {
    var key = state.activeKey;
    var moduleConfig = MODULES[key];
    if (!moduleConfig) return Promise.resolve();
    var historyPromise = loadModuleHistory(key, true).catch(function () {});
    if (!moduleConfig.livePath || !refreshManager) return historyPromise;
    refreshManager.invalidate(key);
    return Promise.all([
      historyPromise,
      refreshManager.refresh(key, "manual")
    ]);
  }

  function render() {
    if (!root) return;
    var moduleConfig = MODULES[state.activeKey];
    if (!moduleConfig) return;
    var moduleState = ensureModuleState(state.activeKey);
    var refreshState = getRefreshStatus();
    var teamOptions = ((state.bootstrap && state.bootstrap.league && state.bootstrap.league.franchises) || []).map(function (team) {
      return '<option value="' + escapeHtml(safeStr(team.franchise_id)) + '"' + (safeStr(team.franchise_id) === safeStr(state.shared.teamId) ? " selected" : "") + '>' + escapeHtml(team.franchise_name) + "</option>";
    }).join("");
    var pageHtml = moduleConfig.render({
      bootstrap: state.bootstrap,
      moduleState: moduleState,
      shared: state.shared,
      helpers: {
        escapeHtml: escapeHtml,
        formatMoney: formatMoney,
        formatAge: formatAge,
        renderTable: renderTable
      }
    });

    root.innerHTML = '' +
      '<div id="acqApp" class="acq-shell">' +
        '<header class="acq-hero">' +
          '<div>' +
            '<p class="acq-kicker">UPS Acquisition Hub</p>' +
            '<h1>Acquisition Hub</h1>' +
            '<p class="acq-subtitle">Live rookie draft, free-agent auction, expired rookies, and waiver research in one owner module.</p>' +
          '</div>' +
          '<div class="acq-status-panel">' +
            '<div class="acq-status-badge is-' + escapeHtml(refreshState.status || "idle") + '">' + escapeHtml(refreshState.status || "idle") + '</div>' +
            '<div class="acq-status-meta">Last updated: ' + escapeHtml(formatAge((moduleState.live && moduleState.live.fetched_at) || (state.bootstrap && state.bootstrap.fetched_at) || "")) + '</div>' +
            '<button type="button" id="acqRefreshBtn" class="acq-btn acq-btn-primary">Refresh Now</button>' +
          '</div>' +
        '</header>' +

        '<section class="acq-toolbar acq-card">' +
          '<nav class="acq-nav">' +
            buildNavItems().map(function (item) {
              return '<button type="button" class="acq-nav-btn' + (item.key === state.activeKey ? " is-active" : "") + '" data-acq-route="' + escapeHtml(item.key) + '">' + escapeHtml(item.label) + "</button>";
            }).join("") +
          '</nav>' +
          '<div class="acq-toolbar-grid">' +
            '<label class="acq-field"><span>Team</span><select id="acqTeamSelect"><option value="">All Teams</option>' + teamOptions + "</select></label>" +
            '<label class="acq-field"><span>Player Search</span><input id="acqSearchInput" type="search" value="' + escapeHtml(state.shared.search) + '" placeholder="Search player, team, auction"></label>' +
          '</div>' +
          '<div class="acq-toolbar-meta">' +
            '<span>Route: ' + escapeHtml(moduleConfig.title) + "</span>" +
            '<span>Season: ' + escapeHtml(safeStr(state.ctx && state.ctx.year)) + "</span>" +
            '<span>League: ' + escapeHtml(safeStr(state.ctx && state.ctx.leagueId)) + "</span>" +
          '</div>' +
          (state.bootstrapError ? ('<div class="acq-error">' + escapeHtml(state.bootstrapError) + "</div>") : "") +
          (moduleState.error ? ('<div class="acq-error">' + escapeHtml(moduleState.error) + "</div>") : "") +
        '</section>' +

        '<main id="acqPageRoot">' + pageHtml + "</main>" +
      "</div>";

    bindUi();
    if (typeof moduleConfig.bind === "function") {
      moduleConfig.bind(root.querySelector("#acqPageRoot"), {
        postAction: function (path, body) {
          state.busyAction = true;
          return postJson(path, body).then(function (payload) {
            var current = ensureModuleState(state.activeKey);
            if (payload && payload.live) current.live = payload.live;
            render();
            if (refreshManager && MODULES[state.activeKey] && MODULES[state.activeKey].livePath) {
              refreshManager.invalidate(state.activeKey);
              refreshManager.refresh(state.activeKey, "action").catch(function () {});
            }
            return payload;
          }).finally(function () {
            state.busyAction = false;
          });
        }
      });
    }
  }

  function bindUi() {
    Array.prototype.forEach.call(root.querySelectorAll("[data-acq-route]"), function (button) {
      button.addEventListener("click", function () {
        var route = safeStr(button.getAttribute("data-acq-route"));
        if (!MODULES[route] || route === state.activeKey) return;
        var previousKey = state.activeKey;
        state.activeKey = route;
        setHashRoute(route);
        loadModuleHistory(route, false).catch(function () {});
        if (refreshManager) {
          refreshManager.deactivate(previousKey);
          if (MODULES[route] && MODULES[route].livePath) {
            refreshManager.activate(route);
            refreshManager.refresh(route, "route").catch(function () {});
          }
        }
        render();
      });
    });

    var refreshBtn = root.querySelector("#acqRefreshBtn");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", function () {
        refreshActive().catch(function () {});
      });
    }

    var teamSelect = root.querySelector("#acqTeamSelect");
    if (teamSelect) {
      teamSelect.addEventListener("change", function () {
        state.shared.teamId = safeStr(teamSelect.value);
        if (refreshManager && MODULES[state.activeKey] && MODULES[state.activeKey].livePath) {
          refreshManager.refresh(state.activeKey, "filter").catch(function () {});
        }
        render();
      });
    }

    var searchInput = root.querySelector("#acqSearchInput");
    if (searchInput) {
      searchInput.addEventListener("input", function () {
        state.shared.search = safeStr(searchInput.value);
        render();
      });
    }
  }

  function ensureMount() {
    var mount = document.getElementById("acquisition-hub");
    if (mount) return mount;
    mount = document.createElement("div");
    mount.id = "acquisition-hub";
    var anchor = document.querySelector(".ups-hotlinks-shell") || document.getElementById("container-wrap") || document.body;
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(mount, anchor.nextSibling);
    } else {
      document.body.appendChild(mount);
    }
    return mount;
  }

  function init() {
    state.ctx = detectContext();
    state.activeKey = getHashRoute();
    root = ensureMount();
    Object.keys(MODULES).forEach(function (key) {
      ensureModuleState(key);
    });

    if (REFRESH && typeof REFRESH.createRefreshManager === "function") {
      refreshManager = REFRESH.createRefreshManager({
        onStateChange: function () {
          render();
        }
      });
      Object.keys(MODULES).forEach(function (key) {
        var mod = MODULES[key];
        if (!mod || !mod.livePath || !mod.refresh) return;
        refreshManager.register(key, {
          visibleIntervalMs: safeInt(mod.refresh.visibleMs, 30000),
          hiddenIntervalMs: safeInt(mod.refresh.hiddenMs, safeInt(mod.refresh.visibleMs, 30000)),
          loader: function (meta) {
            return loadModuleLive(key, meta && meta.reason);
          }
        });
      });
    }

    render();
    loadBootstrap().catch(function () {});
    loadModuleHistory(state.activeKey, false).catch(function () {});
    if (refreshManager && MODULES[state.activeKey] && MODULES[state.activeKey].livePath) {
      refreshManager.activate(state.activeKey);
      refreshManager.refresh(state.activeKey, "init").catch(function () {});
    }
    window.addEventListener("hashchange", function () {
      var route = getHashRoute();
      if (!MODULES[route] || route === state.activeKey) return;
      var previousKey = state.activeKey;
      state.activeKey = route;
      loadModuleHistory(route, false).catch(function () {});
      if (refreshManager) {
        refreshManager.deactivate(previousKey);
        if (MODULES[route] && MODULES[route].livePath) {
          refreshManager.activate(route);
          refreshManager.refresh(route, "hash").catch(function () {});
        }
      }
      render();
    });
    scheduleBootstrapRefresh();
  }

  window.UPS_ACQ_INIT = init;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
