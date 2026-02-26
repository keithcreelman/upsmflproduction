/* UPS trade offer page patch (loaded via UPS_RELEASE_SHA through mflscripts_rosters_fork.js) */
(function () {
  "use strict";

  var STYLE_ID = "ups-trade-offer-patch-styles";

  function onReady(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn);
    } else {
      fn();
    }
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [
      "body#body_options_05 table.trade-twocolumn-table {",
      "  background: var(--ups-surface, #121b2a) !important;",
      "  border: 1px solid var(--ups-border, rgba(116, 147, 184, 0.35)) !important;",
      "  border-radius: 12px !important;",
      "  overflow: hidden !important;",
      "  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.22);",
      "}",
      "",
      "body#body_options_05 table.trade-twocolumn-table caption {",
      "  position: relative;",
      "}",
      "",
      "body#body_options_05 table.trade-twocolumn-table th {",
      "  background: var(--ups-th-bg, #16253a) !important;",
      "  color: var(--ups-th-color, #e7f0ff) !important;",
      "  border-color: var(--ups-td-border, rgba(116, 147, 184, 0.18)) !important;",
      "  text-shadow: none !important;",
      "  letter-spacing: 0.01em;",
      "}",
      "",
      "body#body_options_05 table.trade-twocolumn-table td {",
      "  border-color: var(--ups-td-border, rgba(116, 147, 184, 0.18)) !important;",
      "  color: var(--ups-report-strong, #e7f0ff) !important;",
      "  text-shadow: none !important;",
      "}",
      "",
      "body#body_options_05 table.trade-twocolumn-table td.trade-player {",
      "  position: relative;",
      "  padding-left: 0.5rem !important;",
      "}",
      "",
      "body#body_options_05 table.trade-twocolumn-table tr:hover td {",
      "  background: rgba(123, 171, 236, 0.07) !important;",
      "}",
      "",
      "body#body_options_05 table.trade-twocolumn-table tr.ups-trade-selected td {",
      "  background: rgba(33, 198, 122, 0.11) !important;",
      "}",
      "",
      "body#body_options_05 table.trade-twocolumn-table tr.ups-trade-selected td.trade-box {",
      "  box-shadow: inset 3px 0 0 rgba(33, 198, 122, 0.65);",
      "}",
      "",
      "body#body_options_05 table.trade-twocolumn-table tr.newposition td {",
      "  border-top: 2px solid rgba(129, 185, 255, 0.55) !important;",
      "  background: linear-gradient(180deg, rgba(129, 185, 255, 0.08), rgba(129, 185, 255, 0.02)) !important;",
      "}",
      "",
      "body#body_options_05 table.trade-twocolumn-table tr.ups-trade-taxi-row td {",
      "  opacity: 0.82;",
      "}",
      "",
      "body#body_options_05 table.trade-twocolumn-table tr.ups-trade-taxi-row td.trade-player::after {",
      "  content: \"Taxi\";",
      "  display: inline-block;",
      "  margin-left: 0.35rem;",
      "  padding: 0.05rem 0.35rem;",
      "  border-radius: 999px;",
      "  border: 1px solid rgba(255, 199, 108, 0.35);",
      "  background: rgba(255, 199, 108, 0.08);",
      "  color: #ffdca7;",
      "  font-size: 0.63rem;",
      "  font-weight: 800;",
      "  letter-spacing: 0.03em;",
      "  text-transform: uppercase;",
      "  vertical-align: middle;",
      "}",
      "",
      "body#body_options_05 table.trade-twocolumn-table td.trade-player a[class*=\"position_\"] {",
      "  display: inline-block;",
      "  padding-left: 0.4rem;",
      "  border-left: 0.28rem solid rgba(143, 183, 239, 0.32);",
      "}",
      "",
      "body#body_options_05 table.trade-twocolumn-table tr[data-ups-pos=\"qb\"] td.trade-player a { border-left-color: rgba(119, 184, 255, 0.8); }",
      "body#body_options_05 table.trade-twocolumn-table tr[data-ups-pos=\"rb\"] td.trade-player a { border-left-color: rgba(37, 195, 125, 0.85); }",
      "body#body_options_05 table.trade-twocolumn-table tr[data-ups-pos=\"wr\"] td.trade-player a { border-left-color: rgba(240, 196, 101, 0.88); }",
      "body#body_options_05 table.trade-twocolumn-table tr[data-ups-pos=\"te\"] td.trade-player a { border-left-color: rgba(208, 124, 255, 0.85); }",
      "body#body_options_05 table.trade-twocolumn-table tr[data-ups-pos=\"pk\"] td.trade-player a,",
      "body#body_options_05 table.trade-twocolumn-table tr[data-ups-pos=\"pn\"] td.trade-player a { border-left-color: rgba(159, 179, 209, 0.85); }",
      "body#body_options_05 table.trade-twocolumn-table tr[data-ups-pos=\"dt\"] td.trade-player a,",
      "body#body_options_05 table.trade-twocolumn-table tr[data-ups-pos=\"de\"] td.trade-player a { border-left-color: rgba(255, 122, 122, 0.9); }",
      "body#body_options_05 table.trade-twocolumn-table tr[data-ups-pos=\"lb\"] td.trade-player a { border-left-color: rgba(255, 184, 107, 0.88); }",
      "body#body_options_05 table.trade-twocolumn-table tr[data-ups-pos=\"cb\"] td.trade-player a,",
      "body#body_options_05 table.trade-twocolumn-table tr[data-ups-pos=\"s\"] td.trade-player a { border-left-color: rgba(126, 240, 255, 0.88); }",
      "",
      "body#body_options_05 .ups-pos-chip {",
      "  display: inline-flex;",
      "  align-items: center;",
      "  justify-content: center;",
      "  min-width: 2.05rem;",
      "  margin-right: 0.45rem;",
      "  padding: 0.12rem 0.38rem;",
      "  border-radius: 999px;",
      "  border: 1px solid rgba(129, 185, 255, 0.35);",
      "  background: rgba(129, 185, 255, 0.08);",
      "  color: #d4e8ff;",
      "  font-size: 0.63rem;",
      "  font-weight: 900;",
      "  letter-spacing: 0.06em;",
      "  vertical-align: middle;",
      "}",
      "",
      "body#body_options_05 .ups-trade-summary {",
      "  margin-top: 0.45rem;",
      "  padding: 0.45rem 0.6rem;",
      "  border-radius: 10px;",
      "  background: rgba(10, 18, 32, 0.75);",
      "  border: 1px solid rgba(116, 147, 184, 0.22);",
      "  color: #cfe1fb;",
      "  font-size: 0.75rem;",
      "  font-weight: 700;",
      "  text-align: center;",
      "}",
      "",
      "body#body_options_05 td.trade-bbid-amt {",
      "  background: rgba(9, 17, 29, 0.85) !important;",
      "  border-top: 1px solid rgba(116, 147, 184, 0.22) !important;",
      "  padding: 0.6rem 0.55rem !important;",
      "}",
      "",
      "body#body_options_05 .ups-trade-salary-row {",
      "  display: flex;",
      "  align-items: center;",
      "  justify-content: center;",
      "  gap: 0.4rem;",
      "  flex-wrap: wrap;",
      "  color: var(--ups-report-strong, #e7f0ff);",
      "  font-weight: 800;",
      "}",
      "",
      "body#body_options_05 .ups-trade-salary-label {",
      "  color: #e7f0ff;",
      "  font-weight: 900;",
      "  letter-spacing: 0.02em;",
      "}",
      "",
      "body#body_options_05 .ups-trade-salary-meta {",
      "  color: #a9bfdc;",
      "  font-size: 0.75rem;",
      "  font-weight: 700;",
      "}",
      "",
      "body#body_options_05 .ups-trade-k-input-wrap {",
      "  display: inline-flex;",
      "  align-items: center;",
      "  gap: 0.25rem;",
      "  padding: 0.15rem 0.3rem;",
      "  border-radius: 8px;",
      "  border: 1px solid rgba(116, 147, 184, 0.28);",
      "  background: rgba(15, 27, 44, 0.95);",
      "}",
      "",
      "body#body_options_05 .ups-trade-k-input-wrap input[name^=\"bbid\"] {",
      "  width: 5.2rem !important;",
      "  text-align: right;",
      "  font-weight: 900;",
      "  background: transparent !important;",
      "  border: 0 !important;",
      "  color: #eef4ff !important;",
      "  box-shadow: none !important;",
      "  outline: none !important;",
      "}",
      "",
      "body#body_options_05 .ups-trade-k-suffix {",
      "  color: #c7d8ef;",
      "  font-weight: 900;",
      "  font-size: 0.78rem;",
      "  letter-spacing: 0.04em;",
      "}",
      "",
      "body#body_options_05 .ups-trade-salary-helper {",
      "  margin-top: 0.35rem;",
      "  color: #a9bfdc;",
      "  font-size: 0.7rem;",
      "  text-align: center;",
      "  line-height: 1.25;",
      "}",
      "",
      "body#body_options_05 input.ups-trade-input-clamped {",
      "  box-shadow: 0 0 0 2px rgba(255, 122, 122, 0.28) !important;",
      "  border-radius: 6px !important;",
      "}",
      "",
      "@media (max-width: 980px) {",
      "  body#body_options_05 .trade-class,",
      "  body#body_options_05 th.week,",
      "  body#body_options_05 td.week {",
      "    display: none;",
      "  }",
      "",
      "  body#body_options_05 .ups-trade-summary {",
      "    font-size: 0.7rem;",
      "  }",
      "}"
    ].join("\n");
    (document.head || document.documentElement).appendChild(style);
  }

  function isTradeOfferPage() {
    if (!document.body || document.body.id !== "body_options_05") return false;
    return !!document.querySelector("form[action*='/trade_offer']");
  }

  function closestTag(node, tagName) {
    tagName = String(tagName || "").toUpperCase();
    while (node && node.nodeType === 1) {
      if (node.tagName === tagName) return node;
      node = node.parentNode;
    }
    return null;
  }

  function parseMoney(text) {
    var digits = String(text || "").replace(/[^0-9]/g, "");
    return digits ? parseInt(digits, 10) : 0;
  }

  function formatK(dollars) {
    var k = Math.round((dollars || 0) / 1000);
    try {
      return k.toLocaleString("en-US");
    } catch (err) {
      return String(k);
    }
  }

  function normalizeText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function isTaxiRow(row) {
    if (!row) return false;
    if (row.getAttribute("data-ups-taxi-row") === "1") return true;
    var playerCell = row.querySelector("td.trade-player");
    if (!playerCell) return false;
    var txt = normalizeText(playerCell.textContent || "");
    return /\(TS\)/i.test(txt);
  }

  function getPositionCode(row) {
    var playerLink = row && row.querySelector("td.trade-player a[class*='position_']");
    if (!playerLink) return "";
    var classes = String(playerLink.className || "").split(/\s+/);
    var i;
    for (i = 0; i < classes.length; i += 1) {
      if (classes[i].indexOf("position_") === 0) {
        return classes[i].slice("position_".length).toLowerCase();
      }
    }
    return "";
  }

  function markRowMeta(row) {
    if (!row || row.getAttribute("data-ups-trade-row-marked") === "1") return;
    row.setAttribute("data-ups-trade-row-marked", "1");

    var pos = getPositionCode(row);
    if (pos) row.setAttribute("data-ups-pos", pos);
    if (isTaxiRow(row)) row.classList.add("ups-trade-taxi-row");

    if (row.classList.contains("newposition")) {
      var playerCell = row.querySelector("td.trade-player");
      if (playerCell && !playerCell.querySelector(".ups-pos-chip") && pos) {
        var chip = document.createElement("span");
        chip.className = "ups-pos-chip";
        chip.textContent = pos.toUpperCase();
        playerCell.insertBefore(chip, playerCell.firstChild);
      }
    }
  }

  function sanitizeKValue(input) {
    if (!input) return "";
    var cleaned = String(input.value || "").replace(/[^0-9]/g, "");
    if (cleaned !== String(input.value || "")) input.value = cleaned;
    return cleaned;
  }

  function clampKValue(input, maxK) {
    var raw = sanitizeKValue(input);
    if (!raw) return;
    var value = parseInt(raw, 10) || 0;
    if (value > maxK) {
      input.value = String(maxK);
      input.classList.add("ups-trade-input-clamped");
      window.setTimeout(function () {
        input.classList.remove("ups-trade-input-clamped");
      }, 350);
    }
  }

  function ensureSummaryNode(table) {
    if (table._upsTradeSummaryNode && table._upsTradeSummaryNode.parentNode) return table._upsTradeSummaryNode;
    var caption = table.querySelector("caption");
    if (!caption) return null;
    var node = document.createElement("div");
    node.className = "ups-trade-summary";
    caption.appendChild(node);
    table._upsTradeSummaryNode = node;
    return node;
  }

  function ensureTradeSalaryUI(table) {
    if (table._upsTradeSalaryInput && table._upsTradeSalaryInput.parentNode) {
      return {
        input: table._upsTradeSalaryInput,
        helper: table._upsTradeSalaryHelper
      };
    }

    var bbidInput = table.querySelector("tr td.trade-bbid-amt input[name^='bbid']");
    if (!bbidInput) return null;

    var cell = closestTag(bbidInput, "TD");
    var legacyWrap = bbidInput.parentNode;
    if (!cell || !legacyWrap) return null;

    legacyWrap.classList.add("ups-trade-k-input-wrap");

    if (bbidInput.getAttribute("data-ups-k-mode") !== "1") {
      bbidInput.setAttribute("data-ups-k-mode", "1");
      bbidInput.setAttribute("inputmode", "numeric");
      bbidInput.setAttribute("pattern", "[0-9]*");
      bbidInput.setAttribute("step", "1");
      bbidInput.setAttribute("min", "0");

      var existing = String(bbidInput.value || "").trim();
      if (/^\d+$/.test(existing)) {
        var asDollars = parseInt(existing, 10) || 0;
        if (asDollars >= 1000 && asDollars % 1000 === 0) {
          bbidInput.value = String(asDollars / 1000);
        }
      }
    }

    while (cell.firstChild) {
      cell.removeChild(cell.firstChild);
    }

    var rowWrap = document.createElement("div");
    rowWrap.className = "ups-trade-salary-row";

    var label = document.createElement("span");
    label.className = "ups-trade-salary-label";
    label.textContent = "Trade Salary";

    var meta = document.createElement("span");
    meta.className = "ups-trade-salary-meta";
    meta.textContent = "($1K units)";

    if (legacyWrap.firstChild && legacyWrap.firstChild.nodeType === Node.TEXT_NODE) {
      legacyWrap.firstChild.nodeValue = "";
    }
    if (!legacyWrap.querySelector(".ups-trade-k-suffix")) {
      var suffix = document.createElement("span");
      suffix.className = "ups-trade-k-suffix";
      suffix.textContent = "K";
      legacyWrap.appendChild(suffix);
    }

    var helper = document.createElement("div");
    helper.className = "ups-trade-salary-helper";
    helper.setAttribute("aria-live", "polite");

    rowWrap.appendChild(label);
    rowWrap.appendChild(meta);
    rowWrap.appendChild(legacyWrap);
    cell.appendChild(rowWrap);
    cell.appendChild(helper);

    table._upsTradeSalaryInput = bbidInput;
    table._upsTradeSalaryHelper = helper;

    bbidInput.addEventListener("input", function () {
      clampKValue(bbidInput, table._upsTradeMaxK || 0);
    });
    bbidInput.addEventListener("change", function () {
      clampKValue(bbidInput, table._upsTradeMaxK || 0);
    });

    return { input: bbidInput, helper: helper };
  }

  function recalcTable(table) {
    var checkboxes = table.querySelectorAll("input[type='checkbox'][name^='drop']");
    var selectedNonTaxiDollars = 0;
    var selectedAll = 0;
    var selectedTaxi = 0;

    Array.prototype.forEach.call(checkboxes, function (cb) {
      var row = closestTag(cb, "TR");
      if (!row) return;
      markRowMeta(row);

      if (cb.checked) row.classList.add("ups-trade-selected");
      else row.classList.remove("ups-trade-selected");

      if (!cb.checked) return;

      selectedAll += 1;

      var salaryCell = row.querySelector("td.salary");
      var salary = parseMoney(salaryCell ? salaryCell.textContent : "");
      if (isTaxiRow(row)) {
        selectedTaxi += 1;
        return;
      }
      selectedNonTaxiDollars += salary;
    });

    var maxK = Math.floor(selectedNonTaxiDollars / 2000);
    if (!isFinite(maxK) || maxK < 0) maxK = 0;
    table._upsTradeMaxK = maxK;

    var ui = ensureTradeSalaryUI(table);
    if (ui && ui.input) {
      ui.input.setAttribute("max", String(maxK));
      clampKValue(ui.input, maxK);
      if (ui.helper) {
        if (selectedAll === 0) {
          ui.helper.textContent = "Select outgoing players to calculate max trade salary.";
        } else {
          var msg = "Max " + formatK(maxK * 1000) + "K";
          msg += " (half of selected non-Taxi salary " + formatK(selectedNonTaxiDollars) + "K";
          if (selectedTaxi > 0) msg += "; Taxi excluded";
          msg += ").";
          ui.helper.textContent = msg;
        }
      }
    }

    var summary = ensureSummaryNode(table);
    if (summary) {
      if (selectedAll === 0) {
        summary.textContent = "No players selected.";
      } else {
        summary.textContent =
          "Selected: " +
          String(selectedAll) +
          " player" +
          (selectedAll === 1 ? "" : "s") +
          " | Non-Taxi Salary: $" +
          formatK(selectedNonTaxiDollars) +
          "K | Trade Salary Max: " +
          formatK(maxK * 1000) +
          "K" +
          (selectedTaxi ? " | Taxi selected (excluded): " + String(selectedTaxi) : "");
      }
    }
  }

  function decorateTradeTable(table) {
    if (!table || table.getAttribute("data-ups-trade-enhanced") === "1") return;
    table.setAttribute("data-ups-trade-enhanced", "1");

    Array.prototype.forEach.call(table.querySelectorAll("tr"), function (row) {
      if (row.querySelector("td.trade-player")) markRowMeta(row);
    });

    table.addEventListener("change", function (evt) {
      var target = evt && evt.target;
      if (!target) return;
      if (target.matches && target.matches("input[type='checkbox'][name^='drop']")) {
        recalcTable(table);
        return;
      }
      if (target.name && /^bbid\d+$/i.test(target.name)) {
        clampKValue(target, table._upsTradeMaxK || 0);
      }
    });

    ensureTradeSalaryUI(table);
    recalcTable(table);
  }

  function installSubmitConversion() {
    var form = document.querySelector("form[action*='/trade_offer']");
    if (!form || form.getAttribute("data-ups-trade-submit-hook") === "1") return;
    form.setAttribute("data-ups-trade-submit-hook", "1");

    form.addEventListener("submit", function () {
      var converted = [];
      var inputs = form.querySelectorAll("input[name^='bbid']");
      Array.prototype.forEach.call(inputs, function (input) {
        if (input.getAttribute("data-ups-k-mode") !== "1") return;
        var rawK = sanitizeKValue(input);
        var k = rawK ? parseInt(rawK, 10) || 0 : 0;
        var displayK = String(k);
        input.setAttribute("data-ups-k-display", displayK);
        input.value = String(k * 1000);
        converted.push(input);
      });

      window.setTimeout(function () {
        Array.prototype.forEach.call(converted, function (input) {
          var displayK = input.getAttribute("data-ups-k-display");
          if (displayK !== null) input.value = displayK;
        });
      }, 1200);
    });
  }

  function initTradeOfferPatch() {
    if (!isTradeOfferPage()) return;
    if (document.body.getAttribute("data-ups-trade-page-enhanced") === "1") return;
    injectStyles();
    document.body.setAttribute("data-ups-trade-page-enhanced", "1");

    var tables = document.querySelectorAll("table.trade-twocolumn-table");
    Array.prototype.forEach.call(tables, decorateTradeTable);
    installSubmitConversion();
  }

  function init() {
    if (!document.body) return;
    if (document.body.id === "body_options_05") {
      initTradeOfferPatch();
      window.setTimeout(initTradeOfferPatch, 500);
    }
  }

  onReady(init);
})();
