(function () {
  "use strict";

  var registry = [];
  var registryById = Object.create(null);
  var activeInstance = null;
  var activeStyleHrefs = [];
  var bootCtx = null;
  var hashHandlerAttached = false;

  function safeStr(value) {
    return value == null ? "" : String(value).trim();
  }

  function normalizeStatus(status) {
    var value = safeStr(status).toLowerCase();
    return value === "live" ? "live" : "planned";
  }

  function register(definition) {
    if (!definition || !safeStr(definition.id) || registryById[safeStr(definition.id)]) return;
    var report = {
      id: safeStr(definition.id),
      title: safeStr(definition.title) || safeStr(definition.id),
      familyId: safeStr(definition.familyId) || "other",
      familyTitle: safeStr(definition.familyTitle) || "Other Reports",
      description: safeStr(definition.description),
      kicker: safeStr(definition.kicker) || safeStr(definition.familyTitle) || "Reports",
      status: normalizeStatus(definition.status || "planned"),
      familyOrder: Number(definition.familyOrder),
      styles: Array.isArray(definition.styles) ? definition.styles.slice() : [],
      render: typeof definition.render === "function" ? definition.render : null
    };
    if (!isFinite(report.familyOrder)) report.familyOrder = 999;
    registry.push(report);
    registryById[report.id] = report;
  }

  function list() {
    return registry.slice();
  }

  function getRouteId() {
    var hash = safeStr(window.location.hash).replace(/^#/, "");
    if (hash) return hash;
    try {
      var url = new URL(window.location.href);
      return safeStr(url.searchParams.get("report"));
    } catch (e) {
      return "";
    }
  }

  function getDefaultReport() {
    var live = registry.filter(function (report) { return report.status === "live"; });
    return live[0] || registry[0] || null;
  }

  function resolveReport() {
    var requestedId = getRouteId();
    return registryById[requestedId] || getDefaultReport();
  }

  function navigate(reportId, replace) {
    if (!registryById[reportId]) return;
    var targetHash = "#" + reportId;
    if (replace && window.history && typeof window.history.replaceState === "function") {
      window.history.replaceState(null, "", targetHash);
      renderCurrentReport();
      return;
    }
    if (window.location.hash === targetHash) {
      renderCurrentReport();
      return;
    }
    window.location.hash = targetHash;
  }

  function getStyleLink(path) {
    return document.querySelector('link[data-ups-report-style="' + path.replace(/"/g, '\\"') + '"]');
  }

  function loadStyles(report) {
    var next = {};
    var head = document.head || document.getElementsByTagName("head")[0];
    var styles = Array.isArray(report.styles) ? report.styles : [];
    var i;
    for (i = 0; i < styles.length; i += 1) next[styles[i]] = true;

    for (i = activeStyleHrefs.length - 1; i >= 0; i -= 1) {
      if (next[activeStyleHrefs[i]]) continue;
      var stale = getStyleLink(activeStyleHrefs[i]);
      if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
    }

    for (i = 0; i < styles.length; i += 1) {
      if (getStyleLink(styles[i])) continue;
      var link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = styles[i];
      link.setAttribute("data-ups-report-style", styles[i]);
      head.appendChild(link);
    }
    activeStyleHrefs = styles.slice();
  }

  function groupReports() {
    var grouped = [];
    var groupById = Object.create(null);
    list()
      .sort(function (left, right) {
        if (left.familyOrder !== right.familyOrder) return left.familyOrder - right.familyOrder;
        if (left.familyTitle !== right.familyTitle) return left.familyTitle.localeCompare(right.familyTitle);
        return left.title.localeCompare(right.title);
      })
      .forEach(function (report) {
        var group = groupById[report.familyId];
        if (!group) {
          group = {
            familyId: report.familyId,
            familyTitle: report.familyTitle,
            familyOrder: report.familyOrder,
            reports: []
          };
          groupById[report.familyId] = group;
          grouped.push(group);
        }
        group.reports.push(report);
      });
    return grouped;
  }

  function renderNavigation(activeReport) {
    if (!bootCtx || !bootCtx.nav) return;
    var groups = groupReports();
    var html = groups.map(function (group) {
      var reportsHtml = group.reports.map(function (report) {
        var classes = ["reports-nav-link"];
        if (report.id === activeReport.id) classes.push("is-active");
        if (report.status !== "live") classes.push("is-planned");
        return (
          '<button type="button" class="' + classes.join(" ") + '" data-report-nav="' + report.id + '">' +
            '<span class="reports-nav-link-copy">' +
              '<span class="reports-nav-link-title">' + bootCtx.common.escapeHtml(report.title) + "</span>" +
              '<span class="reports-nav-link-desc">' + bootCtx.common.escapeHtml(report.description || "Report module") + "</span>" +
            "</span>" +
            '<span class="reports-nav-link-status ' + (report.status === "live" ? "is-live" : "is-planned") + '">' +
              (report.status === "live" ? "Live" : "Planned") +
            "</span>" +
          "</button>"
        );
      }).join("");
      return (
        '<section class="reports-nav-group">' +
          '<h3 class="reports-nav-group-title">' + bootCtx.common.escapeHtml(group.familyTitle) + "</h3>" +
          reportsHtml +
        "</section>"
      );
    }).join("");
    bootCtx.nav.innerHTML = html;
    Array.prototype.forEach.call(bootCtx.nav.querySelectorAll("[data-report-nav]"), function (button) {
      button.addEventListener("click", function () {
        navigate(button.getAttribute("data-report-nav"));
      });
    });
  }

  function updateHeader(report) {
    if (!bootCtx) return;
    bootCtx.kicker.textContent = report.kicker;
    bootCtx.title.textContent = report.title;
    bootCtx.subtitle.textContent = report.description || "Centralized report module.";
    bootCtx.status.textContent = report.status === "live" ? "Live Report" : "Planned Report";
    bootCtx.status.className = "reports-hero-status " + (report.status === "live" ? "is-live" : "is-planned");
    bootCtx.route.textContent = "#" + report.id;
  }

  function renderCurrentReport() {
    if (!bootCtx) return;
    var report = resolveReport();
    if (!report) {
      bootCtx.mount.innerHTML = '<section class="reports-panel reports-empty-state"><h3>No reports registered</h3><p>Add a report module to begin.</p></section>';
      return;
    }
    if (activeInstance && typeof activeInstance.destroy === "function") activeInstance.destroy();
    activeInstance = null;
    loadStyles(report);
    renderNavigation(report);
    updateHeader(report);
    bootCtx.mount.innerHTML = "";
    if (typeof report.render === "function") {
      activeInstance = report.render({
        root: bootCtx.mount,
        report: report,
        router: api,
        common: bootCtx.common
      }) || null;
    }
  }

  function boot(context) {
    bootCtx = context || null;
    if (!bootCtx) return;
    if (!hashHandlerAttached) {
      window.addEventListener("hashchange", renderCurrentReport);
      hashHandlerAttached = true;
    }
    if (!getRouteId()) {
      var fallback = getDefaultReport();
      if (fallback) {
        navigate(fallback.id, true);
        return;
      }
    }
    renderCurrentReport();
  }

  var api = {
    register: register,
    list: list,
    boot: boot,
    navigate: navigate,
    resolveReport: resolveReport
  };

  window.UPSReports = api;
})();
