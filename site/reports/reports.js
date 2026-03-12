(function () {
  "use strict";

  function safeStr(value) {
    return value == null ? "" : String(value).trim();
  }

  function safeNum(value, fallback) {
    var num = Number(value);
    return isFinite(num) ? num : (fallback == null ? 0 : fallback);
  }

  function safeInt(value, fallback) {
    var num = parseInt(value, 10);
    return isFinite(num) ? num : (fallback == null ? 0 : fallback);
  }

  function clamp(value, min, max) {
    var num = safeNum(value, min);
    if (num < min) return min;
    if (num > max) return max;
    return num;
  }

  function escapeHtml(value) {
    return safeStr(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatNumber(value, digits) {
    var num = safeNum(value, 0);
    var fractionDigits = digits == null ? 0 : digits;
    try {
      return num.toLocaleString("en-US", {
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits
      });
    } catch (e) {
      return String(Math.round(num * Math.pow(10, fractionDigits)) / Math.pow(10, fractionDigits));
    }
  }

  function formatSigned(value, digits) {
    var num = safeNum(value, 0);
    var formatted = formatNumber(Math.abs(num), digits);
    if (num > 0) return "+" + formatted;
    if (num < 0) return "-" + formatted;
    return formatted;
  }

  function formatPercent(value, digits) {
    return formatNumber(value, digits == null ? 1 : digits) + "%";
  }

  function titleCase(text) {
    return safeStr(text)
      .toLowerCase()
      .split(/[\s_]+/)
      .filter(Boolean)
      .map(function (part) { return part.charAt(0).toUpperCase() + part.slice(1); })
      .join(" ");
  }

  function downloadCsv(filename, rows) {
    if (!rows || !rows.length) return;
    var headers = Object.keys(rows[0]);
    var csv = [headers.join(",")];
    rows.forEach(function (row) {
      var line = headers.map(function (key) {
        var value = row[key];
        if (value == null) return "";
        var text = String(value).replace(/"/g, '""');
        return /[",\n]/.test(text) ? '"' + text + '"' : text;
      }).join(",");
      csv.push(line);
    });
    var blob = new Blob([csv.join("\n")], { type: "text/csv;charset=utf-8" });
    var href = URL.createObjectURL(blob);
    var anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(function () {
      URL.revokeObjectURL(href);
    }, 250);
  }

  function renderPlaceholder(root, config) {
    var title = safeStr(config && config.title) || "Report queued";
    var body = safeStr(config && config.body) || "This report family is reserved for a future phase.";
    var bullets = Array.isArray(config && config.items) ? config.items : [];
    root.innerHTML =
      '<section class="reports-panel reports-placeholder-card">' +
        '<p class="reports-section-kicker">Future Module</p>' +
        '<h3>' + escapeHtml(title) + '</h3>' +
        '<p class="reports-placeholder-copy">' + escapeHtml(body) + '</p>' +
        (bullets.length
          ? '<ul class="reports-placeholder-list">' +
              bullets.map(function (item) { return "<li>" + escapeHtml(item) + "</li>"; }).join("") +
            "</ul>"
          : "") +
      "</section>";
  }

  function summarizeRegistry() {
    var reports = (window.UPSReports && typeof window.UPSReports.list === "function")
      ? window.UPSReports.list()
      : [];
    var familyLookup = Object.create(null);
    var liveCount = 0;
    var plannedCount = 0;
    reports.forEach(function (report) {
      if (report && report.familyId) familyLookup[report.familyId] = true;
      if (report && report.status === "live") liveCount += 1;
      else plannedCount += 1;
    });
    return {
      familyCount: Object.keys(familyLookup).length,
      liveCount: liveCount,
      plannedCount: plannedCount
    };
  }

  function init() {
    var root = document.getElementById("upsReportsApp");
    if (!root) return;
    var summary = summarizeRegistry();
    root.innerHTML =
      '<div class="reports-shell">' +
        '<header class="reports-masthead reports-panel">' +
          '<div class="reports-masthead-copy">' +
            '<p class="reports-kicker">UPS Dynasty League</p>' +
            '<h1>Reports</h1>' +
            '<p class="reports-brand-copy">League research, cap accounting, and historical review now live in one report workspace with isolated modules and shared exports.</p>' +
          '</div>' +
          '<div class="reports-shell-stats">' +
            '<article class="reports-shell-stat">' +
              '<span class="reports-shell-stat-label">Live Reports</span>' +
              '<strong>' + formatNumber(summary.liveCount, 0) + '</strong>' +
              '<span class="reports-shell-stat-detail">ready now</span>' +
            '</article>' +
            '<article class="reports-shell-stat">' +
              '<span class="reports-shell-stat-label">Report Families</span>' +
              '<strong>' + formatNumber(summary.familyCount, 0) + '</strong>' +
              '<span class="reports-shell-stat-detail">grouped by workflow</span>' +
            '</article>' +
            '<article class="reports-shell-stat">' +
              '<span class="reports-shell-stat-label">Queued Modules</span>' +
              '<strong>' + formatNumber(summary.plannedCount, 0) + '</strong>' +
              '<span class="reports-shell-stat-detail">visible in place</span>' +
            '</article>' +
          '</div>' +
        '</header>' +
        '<div class="reports-workspace">' +
          '<section class="reports-selector reports-panel">' +
            '<div class="reports-selector-head">' +
              '<div>' +
                '<p class="reports-section-kicker">Select A Report</p>' +
                '<h2>Choose the module, then work inside the active report.</h2>' +
              '</div>' +
              '<p class="reports-helper-text">Use family tabs to narrow the selector, then open the report you want. The active report stays isolated in its own workspace.</p>' +
            '</div>' +
            '<nav id="reportsNav" class="reports-nav" aria-label="Reports navigation"></nav>' +
          '</section>' +
          '<main class="reports-content">' +
            '<header class="reports-hero reports-panel">' +
              '<div class="reports-hero-copy">' +
                '<p id="reportsHeroKicker" class="reports-section-kicker">Reports</p>' +
                '<h2 id="reportsHeroTitle">Reports Module</h2>' +
                '<p id="reportsHeroSubtitle" class="reports-hero-subtitle">League analytics and research live here.</p>' +
              '</div>' +
              '<div class="reports-hero-side">' +
                '<div id="reportsHeroStatus" class="reports-hero-status">Live Report</div>' +
                '<div class="reports-hero-meta">' +
                  '<span id="reportsHeroFamily" class="reports-hero-pill">Reports</span>' +
                  '<span id="reportsRouteHint" class="reports-hero-pill reports-hero-route">#player-scoring</span>' +
                '</div>' +
              '</div>' +
            '</header>' +
            '<div id="reportsMount" class="reports-mount"></div>' +
          '</main>' +
        '</div>' +
      '</div>';

    var common = {
      safeStr: safeStr,
      safeNum: safeNum,
      safeInt: safeInt,
      clamp: clamp,
      escapeHtml: escapeHtml,
      formatNumber: formatNumber,
      formatSigned: formatSigned,
      formatPercent: formatPercent,
      titleCase: titleCase,
      downloadCsv: downloadCsv,
      renderPlaceholder: renderPlaceholder
    };

    window.UPSReportsCommon = common;

    if (window.UPSReports && typeof window.UPSReports.boot === "function") {
      window.UPSReports.boot({
        nav: document.getElementById("reportsNav"),
        mount: document.getElementById("reportsMount"),
        kicker: document.getElementById("reportsHeroKicker"),
        title: document.getElementById("reportsHeroTitle"),
        subtitle: document.getElementById("reportsHeroSubtitle"),
        status: document.getElementById("reportsHeroStatus"),
        family: document.getElementById("reportsHeroFamily"),
        route: document.getElementById("reportsRouteHint"),
        common: common
      });
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
