(function () {
  "use strict";

  if (!window.UPSReports) return;

  var MANIFEST_URL = "./salary_adjustments/salary_adjustments_manifest.json";
  var DEFAULT_PAGE_SIZE = 50;
  var TABLE_COLUMNS = [
    { key: "adjustment_season", label: "Adj Season", type: "number", digits: 0, align: "left" },
    { key: "franchise", sortKey: "franchise_name", label: "Franchise", type: "franchise", align: "left" },
    { key: "adjustment_type", label: "Type", type: "type", align: "left" },
    { key: "player", sortKey: "player_name", label: "Player", type: "player", align: "left" },
    { key: "source_season", label: "Source Season", type: "number", digits: 0, align: "left" },
    { key: "transaction_datetime_et", label: "Datetime ET", type: "datetime", align: "left" },
    { key: "amount", label: "Amount", type: "signed", digits: 0, align: "right" },
    { key: "direction", label: "Direction", type: "direction", align: "left" },
    { key: "status", label: "Status", type: "status", align: "left" },
    { key: "source_table", label: "Source", type: "source", align: "left" },
    { key: "source_id", label: "Source ID", type: "sourceId", align: "left" },
    { key: "description", label: "Description", type: "text", align: "left" }
  ];

  var manifestCache = null;
  var manifestPromise = null;
  var seasonCache = Object.create(null);
  var seasonPromises = Object.create(null);

  function loadManifest() {
    if (manifestCache) return Promise.resolve(manifestCache);
    if (!manifestPromise) {
      manifestPromise = fetch(MANIFEST_URL, { cache: "no-store" })
        .then(function (response) {
          if (!response.ok) throw new Error("Unable to load salary adjustments manifest.");
          return response.json().then(function (payload) {
            payload._sourceUrl = response.url || MANIFEST_URL;
            manifestCache = payload;
            return payload;
          });
        });
    }
    return manifestPromise;
  }

  function loadSeasonData(manifest, season) {
    if (seasonCache[season]) return Promise.resolve(seasonCache[season]);
    if (!seasonPromises[season]) {
      var seasonEntry = ((manifest.seasons || []).filter(function (entry) {
        return Number(entry.season) === Number(season);
      })[0]) || null;
      if (!seasonEntry) return Promise.reject(new Error("Season " + season + " is not available in the manifest."));
      var seasonUrl = new URL(seasonEntry.path, manifest._sourceUrl || MANIFEST_URL).toString();
      seasonPromises[season] = fetch(seasonUrl, { cache: "no-store" })
        .then(function (response) {
          if (!response.ok) throw new Error("Unable to load salary adjustments season data for " + season + ".");
          return response.json();
        })
        .then(function (payload) {
          seasonCache[season] = payload;
          return payload;
        });
    }
    return seasonPromises[season];
  }

  function renderSalaryAdjustments(ctx) {
    var common = ctx.common;
    var requestToken = 0;
    var disposed = false;
    var state = {
      manifest: null,
      seasonData: null,
      loading: true,
      error: "",
      season: "",
      franchiseId: "",
      adjustmentType: "",
      sourceSeason: "",
      playerId: "",
      status: "",
      search: "",
      sortKey: "transaction_datetime_et",
      sortDir: "desc",
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE
    };

    function sortKeyFor(column) {
      return column && column.sortKey ? column.sortKey : (column ? column.key : "");
    }

    function sortLabel(column) {
      var key = sortKeyFor(column);
      if (state.sortKey !== key) return column.label;
      return column.label + (state.sortDir === "asc" ? " ^" : " v");
    }

    function typeLabel(value) {
      if (value === "TRADED_SALARY") return "Traded Salary";
      if (value === "DROP_PENALTY_CANDIDATE") return "Drop Candidate";
      return common.titleCase(String(value).replace(/_/g, " "));
    }

    function statusLabel(value) {
      if (value === "recorded") return "Recorded";
      if (value === "review_required") return "Review";
      if (value === "candidate") return "Candidate";
      return common.titleCase(value);
    }

    function directionLabel(value) {
      if (value === "charge") return "Charge";
      if (value === "relief") return "Relief";
      if (value === "review") return "Review";
      return common.titleCase(value);
    }

    function pillTone(prefix, value) {
      return prefix + " is-" + common.safeStr(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
    }

    function columnValue(row, key) {
      if (key === "franchise_name") return common.safeStr(row.franchise_name);
      if (key === "player_name") return common.safeStr(row.player_name);
      return row[key];
    }

    function formatColumnValue(value, column) {
      if (column.type === "signed") return common.formatSigned(value, column.digits);
      if (column.type === "number") return common.formatNumber(value, column.digits);
      return common.safeStr(value || "-");
    }

    function normalizeRow(row) {
      var searchBlob = [
        row.franchise_id,
        row.franchise_name,
        row.adjustment_type,
        row.source_table,
        row.source_id,
        row.source_season,
        row.player_id,
        row.player_name,
        row.transaction_datetime_et,
        row.direction,
        row.description,
        row.status
      ].join(" ").toLowerCase();

      return {
        adjustment_season: common.safeInt(row.adjustment_season, 0),
        franchise_id: common.safeStr(row.franchise_id),
        franchise_name: common.safeStr(row.franchise_name),
        adjustment_type: common.safeStr(row.adjustment_type),
        source_table: common.safeStr(row.source_table),
        source_id: common.safeStr(row.source_id),
        source_season: common.safeInt(row.source_season, 0),
        player_id: common.safeStr(row.player_id),
        player_name: common.safeStr(row.player_name),
        transaction_datetime_et: common.safeStr(row.transaction_datetime_et),
        amount: common.safeInt(row.amount, 0),
        direction: common.safeStr(row.direction),
        description: common.safeStr(row.description),
        status: common.safeStr(row.status),
        status_detail: common.safeStr(row.status_detail),
        event_source: common.safeStr(row.event_source),
        drop_method: common.safeStr(row.drop_method),
        pre_drop_salary: common.safeInt(row.pre_drop_salary, 0),
        pre_drop_contract_length: common.safeInt(row.pre_drop_contract_length, 0),
        pre_drop_tcv: common.safeInt(row.pre_drop_tcv, 0),
        pre_drop_contract_year: common.safeInt(row.pre_drop_contract_year, 0),
        pre_drop_contract_status: common.safeStr(row.pre_drop_contract_status),
        pre_drop_contract_info: common.safeStr(row.pre_drop_contract_info),
        candidate_rule: common.safeStr(row.candidate_rule),
        searchBlob: searchBlob
      };
    }

    function buildRows() {
      var sourceRows = ((state.seasonData || {}).rows || []).map(normalizeRow).filter(function (row) {
        if (state.franchiseId && row.franchise_id !== state.franchiseId) return false;
        if (state.adjustmentType && row.adjustment_type !== state.adjustmentType) return false;
        if (state.sourceSeason && String(row.source_season) !== String(state.sourceSeason)) return false;
        if (state.playerId && row.player_id !== state.playerId) return false;
        if (state.status && row.status !== state.status) return false;
        if (state.search && row.searchBlob.indexOf(state.search.toLowerCase()) === -1) return false;
        return true;
      });

      sourceRows.sort(function (left, right) {
        var key = state.sortKey;
        var a = columnValue(left, key);
        var b = columnValue(right, key);
        if (key === "amount" || key === "adjustment_season" || key === "source_season") {
          a = common.safeNum(a, 0);
          b = common.safeNum(b, 0);
        } else {
          a = common.safeStr(a).toLowerCase();
          b = common.safeStr(b).toLowerCase();
        }
        if (a < b) return state.sortDir === "asc" ? -1 : 1;
        if (a > b) return state.sortDir === "asc" ? 1 : -1;
        return common.safeStr(left.source_id).localeCompare(common.safeStr(right.source_id));
      });

      return sourceRows;
    }

    function buildCsvRows(rows) {
      return rows.map(function (row) {
        return {
          "Adjustment Season": row.adjustment_season,
          "Franchise ID": row.franchise_id,
          "Franchise Name": row.franchise_name,
          "Adjustment Type": row.adjustment_type,
          "Source Table": row.source_table,
          "Source ID": row.source_id,
          "Source Season": row.source_season,
          "Player ID": row.player_id,
          "Player Name": row.player_name,
          "Transaction Datetime ET": row.transaction_datetime_et,
          Amount: row.amount,
          Direction: row.direction,
          Description: row.description,
          Status: row.status,
          "Status Detail": row.status_detail,
          "Event Source": row.event_source,
          "Drop Method": row.drop_method,
          "Pre-Drop Salary": row.pre_drop_salary,
          "Pre-Drop Contract Length": row.pre_drop_contract_length,
          "Pre-Drop TCV": row.pre_drop_tcv,
          "Pre-Drop Contract Year": row.pre_drop_contract_year,
          "Pre-Drop Contract Status": row.pre_drop_contract_status,
          "Pre-Drop Contract Info": row.pre_drop_contract_info,
          "Candidate Rule": row.candidate_rule
        };
      });
    }

    function renderSummary(rows) {
      var chargeTotal = rows.reduce(function (sum, row) {
        return sum + Math.max(0, common.safeNum(row.amount, 0));
      }, 0);
      var reliefTotal = rows.reduce(function (sum, row) {
        return sum + Math.abs(Math.min(0, common.safeNum(row.amount, 0)));
      }, 0);
      var candidateCount = rows.filter(function (row) { return row.status === "candidate"; }).length;
      return (
        '<section class="reports-panel sar-summary-panel">' +
          '<div class="sar-summary-copy">' +
            '<p class="reports-section-kicker">Report 2</p>' +
            '<h3>Salary adjustment ledger</h3>' +
            '<p class="reports-helper-text">Recorded traded salary settlements and auditable drop-penalty candidates, organized for franchise and season review.</p>' +
          "</div>" +
          '<div class="sar-summary-grid">' +
            '<article class="sar-stat-card"><span class="sar-stat-label">Filtered Rows</span><strong>' + common.formatNumber(rows.length, 0) + '</strong><span class="sar-stat-detail">season ledger entries</span></article>' +
            '<article class="sar-stat-card"><span class="sar-stat-label">Charges</span><strong>' + common.formatSigned(chargeTotal, 0) + '</strong><span class="sar-stat-detail">positive cap burden</span></article>' +
            '<article class="sar-stat-card"><span class="sar-stat-label">Relief</span><strong>' + common.formatNumber(reliefTotal, 0) + '</strong><span class="sar-stat-detail">absolute relief volume</span></article>' +
            '<article class="sar-stat-card"><span class="sar-stat-label">Candidates</span><strong>' + common.formatNumber(candidateCount, 0) + '</strong><span class="sar-stat-detail">drop rows pending confirmation</span></article>' +
          "</div>" +
        "</section>"
      );
    }

    function renderTable(rows) {
      var headers = TABLE_COLUMNS.map(function (column) {
        var thClass = column.align === "right" ? "sar-num-col" : "sar-text-col";
        return (
          '<th class="' + thClass + '">' +
            '<button type="button" class="sar-sort-btn" data-sar-sort="' + common.escapeHtml(sortKeyFor(column)) + '">' +
              common.escapeHtml(sortLabel(column)) +
            "</button>" +
          "</th>"
        );
      }).join("");

      var body = rows.map(function (row) {
        return (
          "<tr>" +
            TABLE_COLUMNS.map(function (column) {
              if (column.type === "franchise") {
                return (
                  '<td class="sar-text-cell sar-col-franchise">' +
                    '<strong>' + common.escapeHtml(row.franchise_name || "Unknown franchise") + "</strong>" +
                    '<span class="sar-cell-meta">' + common.escapeHtml(row.franchise_id || "-") + "</span>" +
                  "</td>"
                );
              }
              if (column.type === "player") {
                return (
                  '<td class="sar-text-cell sar-col-player">' +
                    '<strong>' + common.escapeHtml(row.player_name || "League-wide") + "</strong>" +
                    '<span class="sar-cell-meta">' + common.escapeHtml(row.player_id || "No player link") + "</span>" +
                  "</td>"
                );
              }
              if (column.type === "type") {
                return '<td class="sar-text-cell"><span class="' + pillTone("sar-type-pill", row.adjustment_type) + '">' + common.escapeHtml(typeLabel(row.adjustment_type)) + "</span></td>";
              }
              if (column.type === "status") {
                return '<td class="sar-text-cell"><span class="' + pillTone("sar-status-pill", row.status) + '">' + common.escapeHtml(statusLabel(row.status)) + "</span></td>";
              }
              if (column.type === "direction") {
                return '<td class="sar-text-cell"><span class="' + pillTone("sar-direction-pill", row.direction) + '">' + common.escapeHtml(directionLabel(row.direction)) + "</span></td>";
              }
              if (column.type === "source") {
                return (
                  '<td class="sar-text-cell">' +
                    '<span class="sar-source-chip">' + common.escapeHtml(row.source_table) + "</span>" +
                  "</td>"
                );
              }
              var className = column.align === "right" ? "sar-num-cell" : "sar-text-cell";
              if (column.key === "amount") {
                className += " " + (common.safeNum(row.amount, 0) >= 0 ? "sar-positive" : "sar-negative");
              }
              return '<td class="' + className + '">' + common.escapeHtml(formatColumnValue(row[column.key], column)) + "</td>";
            }).join("") +
          "</tr>"
        );
      }).join("");

      return (
        '<div class="sar-table-wrap">' +
          '<table class="sar-table">' +
            "<thead><tr>" + headers + "</tr></thead>" +
            "<tbody>" + body + "</tbody>" +
          "</table>" +
        "</div>"
      );
    }

    function renderCards(rows) {
      if (!rows.length) {
        return (
          '<section class="sar-mobile-list">' +
            '<article class="reports-panel sar-empty-panel">' +
              '<h4>No salary adjustment rows matched the current filter set</h4>' +
              '<p class="reports-helper-text">Broaden the franchise, player, or status filters to reopen the ledger.</p>' +
            "</article>" +
          "</section>"
        );
      }

      return (
        '<section class="sar-mobile-list">' +
          rows.map(function (row) {
            return (
              '<article class="reports-panel sar-card">' +
                '<header class="sar-card-head">' +
                  '<div>' +
                    '<h4>' + common.escapeHtml(row.franchise_name || "Unknown franchise") + "</h4>" +
                    '<p class="sar-card-subhead">' + common.escapeHtml("Season " + row.adjustment_season + " | " + (row.player_name || "League-wide")) + "</p>" +
                  "</div>" +
                  '<strong class="' + (common.safeNum(row.amount, 0) >= 0 ? "sar-positive" : "sar-negative") + '">' + common.escapeHtml(common.formatSigned(row.amount, 0)) + "</strong>" +
                "</header>" +
                '<div class="sar-card-chip-row">' +
                  '<span class="' + pillTone("sar-type-pill", row.adjustment_type) + '">' + common.escapeHtml(typeLabel(row.adjustment_type)) + "</span>" +
                  '<span class="' + pillTone("sar-status-pill", row.status) + '">' + common.escapeHtml(statusLabel(row.status)) + "</span>" +
                  '<span class="' + pillTone("sar-direction-pill", row.direction) + '">' + common.escapeHtml(directionLabel(row.direction)) + "</span>" +
                "</div>" +
                '<dl class="sar-card-grid">' +
                  '<div><dt>Franchise ID</dt><dd>' + common.escapeHtml(row.franchise_id || "-") + "</dd></div>" +
                  '<div><dt>Player ID</dt><dd>' + common.escapeHtml(row.player_id || "-") + "</dd></div>" +
                  '<div><dt>Source</dt><dd>' + common.escapeHtml(row.source_table) + "</dd></div>" +
                  '<div><dt>Source ID</dt><dd>' + common.escapeHtml(row.source_id) + "</dd></div>" +
                  '<div><dt>Source Season</dt><dd>' + common.escapeHtml(common.formatNumber(row.source_season, 0)) + "</dd></div>" +
                  '<div><dt>Datetime ET</dt><dd>' + common.escapeHtml(row.transaction_datetime_et || "-") + "</dd></div>" +
                "</dl>" +
                '<p class="sar-card-copy">' + common.escapeHtml(row.description || "No description available.") + "</p>" +
              "</article>"
            );
          }).join("") +
        "</section>"
      );
    }

    function renderLoading() {
      ctx.root.innerHTML =
        '<section class="reports-panel sar-loading-card">' +
          '<p class="reports-section-kicker">Cap Accounting</p>' +
          '<h3>Loading salary adjustment data</h3>' +
          '<p class="reports-helper-text">Pulling the manifest and static season ledger for the report.</p>' +
        "</section>";
    }

    function renderError() {
      ctx.root.innerHTML =
        '<section class="reports-panel sar-loading-card">' +
          '<p class="reports-section-kicker">Cap Accounting</p>' +
          '<h3>Salary adjustments report failed to load</h3>' +
          '<p class="reports-helper-text">' + common.escapeHtml(state.error || "Unknown error.") + "</p>" +
          '<div class="sar-inline-actions"><button type="button" class="reports-btn" data-sar-retry>Retry</button></div>' +
        "</section>";
      var retry = ctx.root.querySelector("[data-sar-retry]");
      if (retry) retry.addEventListener("click", initialize);
    }

    function bindHandlers(allRows, totalPages) {
      function bind(selector, eventName, handler) {
        var node = ctx.root.querySelector(selector);
        if (node) node.addEventListener(eventName, handler);
      }

      bind("[data-sar-season]", "change", function (event) {
        state.season = event.target.value;
        state.page = 1;
        fetchSeason();
      });
      bind("[data-sar-search]", "input", function (event) {
        state.search = event.target.value;
        state.page = 1;
        renderView();
      });
      bind("[data-sar-franchise]", "change", function (event) {
        state.franchiseId = event.target.value;
        state.page = 1;
        renderView();
      });
      bind("[data-sar-type]", "change", function (event) {
        state.adjustmentType = event.target.value;
        state.page = 1;
        renderView();
      });
      bind("[data-sar-source-season]", "change", function (event) {
        state.sourceSeason = event.target.value;
        state.page = 1;
        renderView();
      });
      bind("[data-sar-player]", "change", function (event) {
        state.playerId = event.target.value;
        state.page = 1;
        renderView();
      });
      bind("[data-sar-status]", "change", function (event) {
        state.status = event.target.value;
        state.page = 1;
        renderView();
      });
      bind("[data-sar-page-size]", "change", function (event) {
        state.pageSize = common.safeInt(event.target.value, state.pageSize);
        state.page = 1;
        renderView();
      });
      bind("[data-sar-clear]", "click", function () {
        state.franchiseId = "";
        state.adjustmentType = "";
        state.sourceSeason = "";
        state.playerId = "";
        state.status = "";
        state.search = "";
        state.page = 1;
        renderView();
      });
      bind("[data-sar-export]", "click", function () {
        common.downloadCsv("ups_salary_adjustments_" + state.season + ".csv", buildCsvRows(allRows));
      });

      Array.prototype.forEach.call(ctx.root.querySelectorAll("[data-sar-sort]"), function (button) {
        button.addEventListener("click", function () {
          var key = button.getAttribute("data-sar-sort");
          if (state.sortKey === key) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
          else {
            state.sortKey = key;
            state.sortDir = (key === "amount" || key === "transaction_datetime_et") ? "desc" : "asc";
          }
          renderView();
        });
      });

      Array.prototype.forEach.call(ctx.root.querySelectorAll("[data-sar-page]"), function (button) {
        button.addEventListener("click", function () {
          var direction = button.getAttribute("data-sar-page");
          if (direction === "prev" && state.page > 1) state.page -= 1;
          if (direction === "next" && state.page < totalPages) state.page += 1;
          renderView();
        });
      });
    }

    function renderView() {
      if (disposed) return;
      if (state.loading) {
        renderLoading();
        return;
      }
      if (state.error) {
        renderError();
        return;
      }
      var manifest = state.manifest || { seasons: [] };
      var seasonData = state.seasonData;
      if (!seasonData) {
        state.loading = true;
        renderLoading();
        return;
      }

      var rows = buildRows();
      var totalRows = ((seasonData || {}).rows || []).length;
      var totalPages = Math.max(1, Math.ceil(rows.length / state.pageSize));
      state.page = Math.min(Math.max(1, state.page), totalPages);
      var startIndex = (state.page - 1) * state.pageSize;
      var pagedRows = rows.slice(startIndex, startIndex + state.pageSize);
      var filters = seasonData.filters || {};
      var seasonOptions = (manifest.seasons || []).map(function (entry) {
        return '<option value="' + common.escapeHtml(entry.season) + '"' + (String(entry.season) === String(state.season) ? " selected" : "") + ">" + entry.season + "</option>";
      }).join("");
      var franchiseOptions = ['<option value="">All franchises</option>']
        .concat((filters.franchises || []).map(function (entry) {
          return '<option value="' + common.escapeHtml(entry.id) + '"' + (state.franchiseId === entry.id ? " selected" : "") + ">" + common.escapeHtml(entry.name) + "</option>";
        }))
        .join("");
      var typeOptions = ['<option value="">All adjustment types</option>']
        .concat((filters.adjustment_types || []).map(function (entry) {
          return '<option value="' + common.escapeHtml(entry) + '"' + (state.adjustmentType === entry ? " selected" : "") + ">" + common.escapeHtml(typeLabel(entry)) + "</option>";
        }))
        .join("");
      var sourceSeasonOptions = ['<option value="">All source seasons</option>']
        .concat((filters.source_seasons || []).map(function (entry) {
          return '<option value="' + common.escapeHtml(entry) + '"' + (String(state.sourceSeason) === String(entry) ? " selected" : "") + ">" + common.escapeHtml(String(entry)) + "</option>";
        }))
        .join("");
      var playerOptions = ['<option value="">All players</option>']
        .concat((filters.players || []).map(function (entry) {
          return '<option value="' + common.escapeHtml(entry.id) + '"' + (state.playerId === entry.id ? " selected" : "") + ">" + common.escapeHtml(entry.name || entry.id) + "</option>";
        }))
        .join("");
      var statusOptions = ['<option value="">All statuses</option>']
        .concat((filters.statuses || []).map(function (entry) {
          return '<option value="' + common.escapeHtml(entry) + '"' + (state.status === entry ? " selected" : "") + ">" + common.escapeHtml(statusLabel(entry)) + "</option>";
        }))
        .join("");

      ctx.root.innerHTML =
        renderSummary(rows) +
        '<section class="reports-panel sar-toolbar-panel">' +
          '<div class="sar-toolbar-head">' +
            '<div>' +
              '<h3 class="sar-panel-title">Filters</h3>' +
              '<p class="reports-helper-text">Recorded trade settlements come from normalized accepted trade history. Drop rows are candidate penalties derived from add/drop events plus the pre-drop contract snapshot.</p>' +
            "</div>" +
            '<div class="sar-inline-actions">' +
              '<button type="button" class="reports-btn-ghost" data-sar-clear>Reset filters</button>' +
              '<button type="button" class="reports-btn" data-sar-export>Export filtered CSV</button>' +
            "</div>" +
          "</div>" +
          '<div class="sar-filter-grid">' +
            '<label class="reports-field"><span class="reports-field-label">Season</span><select class="reports-select" data-sar-season>' + seasonOptions + "</select></label>" +
            '<label class="reports-field"><span class="reports-field-label">Search</span><input class="reports-input" type="search" value="' + common.escapeHtml(state.search) + '" placeholder="Description, source, player, franchise" data-sar-search></label>' +
            '<label class="reports-field"><span class="reports-field-label">Franchise</span><select class="reports-select" data-sar-franchise>' + franchiseOptions + "</select></label>" +
            '<label class="reports-field"><span class="reports-field-label">Adjustment Type</span><select class="reports-select" data-sar-type>' + typeOptions + "</select></label>" +
            '<label class="reports-field"><span class="reports-field-label">Source Season</span><select class="reports-select" data-sar-source-season>' + sourceSeasonOptions + "</select></label>" +
            '<label class="reports-field"><span class="reports-field-label">Player</span><select class="reports-select" data-sar-player>' + playerOptions + "</select></label>" +
            '<label class="reports-field"><span class="reports-field-label">Status</span><select class="reports-select" data-sar-status>' + statusOptions + "</select></label>" +
          "</div>" +
          '<div class="sar-toolbar-foot">' +
            '<p class="reports-helper-text">' + common.formatNumber(rows.length, 0) + " filtered rows from " + common.formatNumber(totalRows, 0) + " total ledger entries for the selected season.</p>" +
            '<p class="reports-helper-text"><a href="./salary_adjustments/salary_adjustments_data_dictionary.md" target="_blank" rel="noreferrer">Data dictionary</a> and <a href="./salary_adjustments/salary_adjustments_sql.sql" target="_blank" rel="noreferrer">SQL definitions</a>.</p>' +
          "</div>" +
        "</section>" +
        '<section class="reports-panel sar-table-panel">' +
          '<div class="sar-table-head">' +
            '<div><h3 class="sar-panel-title">Results</h3><p class="reports-helper-text">Page ' + common.formatNumber(state.page, 0) + " of " + common.formatNumber(totalPages, 0) + ".</p></div>" +
            '<label class="reports-field sar-page-size"><span class="reports-field-label">Rows per page</span><select class="reports-select" data-sar-page-size>' +
              [25, 50, 100, 250].map(function (size) {
                return '<option value="' + size + '"' + (state.pageSize === size ? " selected" : "") + ">" + size + "</option>";
              }).join("") +
            "</select></label>" +
          "</div>" +
          (pagedRows.length ? renderTable(pagedRows) : '<article class="reports-panel sar-empty-panel"><h4>No salary adjustment rows matched the current filter set</h4><p class="reports-helper-text">Try broadening the franchise, player, or status filters.</p></article>') +
          (pagedRows.length ? renderCards(pagedRows) : "") +
          '<div class="sar-pagination">' +
            '<button type="button" class="reports-btn-ghost" data-sar-page="prev"' + (state.page <= 1 ? " disabled" : "") + '>Previous</button>' +
            '<div class="sar-pagination-status">Showing ' + common.formatNumber(rows.length ? (startIndex + 1) : 0, 0) + " to " + common.formatNumber(Math.min(startIndex + state.pageSize, rows.length), 0) + " of " + common.formatNumber(rows.length, 0) + "</div>" +
            '<button type="button" class="reports-btn-ghost" data-sar-page="next"' + (state.page >= totalPages ? " disabled" : "") + '>Next</button>' +
          "</div>" +
        "</section>";

      bindHandlers(rows, totalPages);
    }

    function fetchSeason() {
      if (!state.manifest || !state.season) return;
      state.loading = true;
      state.error = "";
      renderView();
      var token = requestToken += 1;
      loadSeasonData(state.manifest, state.season)
        .then(function (seasonData) {
          if (disposed || token !== requestToken) return;
          state.seasonData = seasonData;
          state.loading = false;
          renderView();
        })
        .catch(function (error) {
          if (disposed || token !== requestToken) return;
          state.loading = false;
          state.error = error && error.message ? error.message : "Unknown season load error.";
          renderView();
        });
    }

    function initialize() {
      state.loading = true;
      state.error = "";
      renderView();
      var token = requestToken += 1;
      loadManifest()
        .then(function (manifest) {
          if (disposed || token !== requestToken) return;
          state.manifest = manifest;
          if (!state.season) state.season = String((((manifest || {}).seasons || [])[0] || {}).season || "");
          return loadSeasonData(manifest, state.season);
        })
        .then(function (seasonData) {
          if (disposed || token !== requestToken) return;
          state.seasonData = seasonData;
          state.loading = false;
          renderView();
        })
        .catch(function (error) {
          if (disposed || token !== requestToken) return;
          state.loading = false;
          state.error = error && error.message ? error.message : "Unknown manifest load error.";
          renderView();
        });
    }

    initialize();

    return {
      destroy: function () {
        disposed = true;
      }
    };
  }

  window.UPSReports.register({
    id: "salary-adjustments",
    title: "Salary Adjustments",
    familyId: "salary",
    familyTitle: "Salary Adjustment Reports",
    familyOrder: 3,
    kicker: "Cap Accounting",
    description: "Recorded traded salary settlements and drop-penalty candidate rows with franchise and season filtering.",
    status: "live",
    styles: ["./salary_adjustments/salary_adjustments.css"],
    render: renderSalaryAdjustments
  });
})();
