(function () {
  "use strict";

  var BUILD = "2026.03.07.12";
  var BOOT_FLAG = "__ups_roster_workbench_boot_" + BUILD;
  if (window[BOOT_FLAG]) {
    if (typeof window.UPS_RWB_INIT === "function") window.UPS_RWB_INIT();
    return;
  }
  window[BOOT_FLAG] = true;
  var SCRIPT_BASE_URL = (function () {
    try {
      var s = document.currentScript;
      if (!s || !s.src) return "";
      var u = new URL(s.src, window.location.href);
      u.pathname = safeStr(u.pathname).replace(/[^/]+$/, "");
      u.search = "";
      u.hash = "";
      return u.toString();
    } catch (e) {
      return "";
    }
  })();

  var POSITION_GROUP_ORDER = ["QB", "RB", "WR", "TE", "DL", "DB", "LB", "PK", "PN", "OTHER"];
  var MIN_ROSTER_PLAYERS = 27;
  var MAX_ROSTER_PLAYERS = 30;
  var OFFSEASON_MAX_ROSTER_PLAYERS = 35;
  var MAX_SCORE_WEEKS = 18;
  var LIVE_POINTS_TTL_MS = 5 * 60 * 1000;
  var ROSTER_SEASON_EVENTS_FALLBACK = {
    "2024": {
      contract_deadline: "2024-09-01",
      season_complete: "2024-12-30"
    },
    "2025": {
      contract_deadline: "2025-08-31",
      season_complete: "2025-12-29"
    },
    "2026": {
      contract_deadline: "2026-09-06",
      season_complete: "2026-12-29"
    }
  };
  var CONTRACT_FILTERS = [
    { value: "", label: "All Contract Types" },
    { value: "rookie", label: "Rookies" },
    { value: "loaded", label: "Loaded (Front/Back)" },
    { value: "other", label: "All Other" }
  ];
  var ROSTER_STATUS_FILTERS = [
    { value: "", label: "All" },
    { value: "active", label: "Active Roster Only" },
    { value: "taxi", label: "Taxi Only" },
    { value: "ir", label: "IR Only" }
  ];
  var EXTENSION_RATES = {
    QB: { 1: 10000, 2: 20000 },
    RB: { 1: 10000, 2: 20000 },
    WR: { 1: 10000, 2: 20000 },
    TE: { 1: 10000, 2: 20000 },
    DL: { 1: 3000, 2: 5000 },
    DB: { 1: 3000, 2: 5000 },
    LB: { 1: 3000, 2: 5000 },
    PK: { 1: 3000, 2: 5000 },
    PN: { 1: 3000, 2: 5000 },
    OTHER: { 1: 3000, 2: 5000 }
  };

  var state = {
    ctx: null,
    teams: [],
    viewerFranchiseId: "",
    pointYears: [],
    pointsMode: "",
    pointsHistory: null,
    pointsHistoryLoading: false,
    pointsHistoryError: "",
    pointsHistoryPromise: null,
    pointsHistoryMode: "",
    pointsHistoryYearStart: "",
    pointsHistoryYearEnd: "",
    pointsHistorySeason: "",
    pointsHistoryWeekStart: "",
    pointsHistoryWeekEnd: "",
    pointsExpanded: {},
    liveSeasonPoints: null,
    liveSeasonPointsLoading: false,
    liveSeasonPointsError: "",
    liveSeasonPointsPromise: null,
    view: "roster",
    search: "",
    filterPosition: "",
    filterType: "",
    filterRosterStatus: "",
    sorts: {
      roster: { key: "name", dir: "asc" },
      contract: { key: "player", dir: "asc" },
      franchise: { key: "franchise", dir: "asc" },
      points: { key: "points", dir: "desc" }
    },
    contractPreview: {},
    actionModal: {
      open: false,
      playerId: "",
      franchiseId: ""
    },
    busyActionKey: "",
    gamesLoadedByYear: Object.create(null),
    gamesLoadingByYear: Object.create(null),
    salaryCapAmount: 0,
    flash: null,
    loadError: ""
  };

  var els = {};
  var attached = false;
  var storagePrefix = "ups:rwb:unknown";

  function safeStr(v) {
    return v == null ? "" : String(v).trim();
  }

  function asArray(v) {
    if (Array.isArray(v)) return v;
    if (v == null || v === "") return [];
    return [v];
  }

  function escapeHtml(v) {
    return safeStr(v)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function safeNum(v, fallback) {
    var n = Number(v);
    if (!isFinite(n)) return fallback == null ? 0 : fallback;
    return n;
  }

  function safeInt(v, fallback) {
    var n = parseInt(v, 10);
    if (!isFinite(n)) return fallback == null ? 0 : fallback;
    return n;
  }

  function normType(t) {
    return safeStr(t).toLowerCase();
  }

  function normRosterStatusFilter(value) {
    var raw = safeStr(value).toLowerCase();
    if (raw === "active" || raw === "taxi" || raw === "ir") return raw;
    return "";
  }

  function rosterStatusFilterLabel(value) {
    var normalized = normRosterStatusFilter(value);
    if (normalized === "active") return "Active roster only";
    if (normalized === "taxi") return "Taxi only";
    if (normalized === "ir") return "IR only";
    return "";
  }

  function pad4(v) {
    var digits = safeStr(v).replace(/\D/g, "");
    if (!digits) return "";
    return ("0000" + digits).slice(-4);
  }

  function parseMoney(v) {
    var raw = safeStr(v);
    if (!raw) return 0;
    var cleaned = raw.replace(/[^0-9.-]/g, "");
    if (!cleaned) return 0;
    var n = Number(cleaned);
    if (!isFinite(n)) return 0;
    return Math.round(n);
  }

  function money(n) {
    var v = Math.round(safeNum(n, 0));
    var sign = v < 0 ? "-" : "";
    var abs = Math.abs(v);
    try {
      return sign + "$" + abs.toLocaleString("en-US");
    } catch (e) {
      return sign + "$" + String(abs);
    }
  }

  function roundToK(n) {
    return Math.round(safeNum(n, 0) / 1000) * 1000;
  }

  function parseContractMoneyToken(token) {
    var raw = safeStr(token).toUpperCase().replace(/\$/g, "");
    if (!raw) return 0;
    var cleaned = raw.replace(/[^0-9K.\-]/g, "");
    if (!cleaned) return 0;
    var mult = cleaned.indexOf("K") !== -1 ? 1000 : 1;
    cleaned = cleaned.replace(/K/g, "");
    if (!cleaned) return 0;
    var num = Number(cleaned);
    if (!isFinite(num)) return 0;
    var amount = Math.round(num * mult);
    if (mult === 1 && amount > 0 && amount < 1000) amount *= 1000;
    return amount;
  }

  function formatContractK(amount) {
    var dollars = Math.round(safeNum(amount, 0));
    if (dollars <= 0) return "0K";
    var k = dollars / 1000;
    var text = Math.round(k * 10) / 10;
    return String(text).replace(/\.0$/, "") + "K";
  }

  function parseContractAavValues(contractInfo) {
    var info = safeStr(contractInfo);
    if (!info) return [];
    var match = info.match(/(?:^|\|)\s*AAV\s*([^|]+)/i);
    if (!match || !safeStr(match[1])) return [];
    return safeStr(match[1])
      .split(/[\/,]/)
      .map(function (token) { return parseContractMoneyToken(token); })
      .filter(function (amount) { return amount > 0; });
  }

  function parseContractTcvValue(contractInfo) {
    var info = safeStr(contractInfo);
    if (!info) return 0;
    var match = info.match(/(?:^|\|)\s*TCV\s+([^|]+)/i);
    if (!match || !safeStr(match[1])) return 0;
    return parseContractMoneyToken(match[1]);
  }

  function parseContractGuaranteeValue(contractInfo) {
    var info = safeStr(contractInfo);
    if (!info) return 0;
    var match = info.match(/(?:^|\|)\s*GTD\s*:?\s*([^|]+)/i);
    if (!match || !safeStr(match[1])) return 0;
    return parseContractMoneyToken(match[1]);
  }

  function replaceContractInfoAavValue(contractInfo, nextAav) {
    var info = safeStr(contractInfo);
    var aav = Math.round(safeNum(nextAav, 0));
    if (!info || aav <= 0) return info;
    if (/AAV\s+/i.test(info)) {
      return info.replace(/AAV\s+[^|]+/i, "AAV " + formatContractK(aav));
    }
    return info;
  }

  function normalizeContractInfoForDisplay(contractInfo, years, priorContract) {
    var info = safeStr(contractInfo);
    if (!info) return info;
    var prior = priorContract || null;
    if (!prior) return info;

    var currentYears = Math.max(0, safeInt(years, 0));
    var priorYears = Math.max(
      0,
      safeInt(
        prior.years != null ? prior.years :
        (prior.contractYear != null ? prior.contractYear : prior.contract_year),
        0
      )
    );
    if (!currentYears || priorYears !== currentYears + 1) return info;

    var priorInfo = safeStr(prior.special || prior.contractInfo || prior.contract_info || "");
    var priorAavs = parseContractAavValues(priorInfo);
    if (priorAavs.length < 1) return info;

    return replaceContractInfoAavValue(info, priorAavs[priorAavs.length - 1]);
  }

  function currentAavForContractInfo(contractInfo) {
    var values = parseContractAavValues(contractInfo);
    return values.length ? safeInt(values[0], 0) : 0;
  }

  function rosterCountEligible(player) {
    return !!(player && !player.isTaxi);
  }

  function rosterCountForPlayers(players) {
    var list = players || [];
    var count = 0;
    for (var i = 0; i < list.length; i += 1) {
      if (rosterCountEligible(list[i])) count += 1;
    }
    return count;
  }

  function irCountForPlayers(players) {
    var list = players || [];
    var count = 0;
    for (var i = 0; i < list.length; i += 1) {
      if (list[i] && list[i].isIr) count += 1;
    }
    return count;
  }

  function currentCapHit(salary, years, isTaxi, isIr) {
    var amt = safeInt(salary, 0);
    var y = Math.max(0, safeInt(years, 0));
    if (isTaxi) return 0;
    if (y <= 0) return 0;
    if (isIr) return Math.round(amt * 0.5);
    return amt;
  }

  function currentCapHitForPlayer(player) {
    if (!player) return 0;
    return currentCapHit(player.salary, player.years, player.isTaxi, player.isIr);
  }

  function displayedSalaryForPlan(player, offset) {
    var idx = safeInt(offset, 0);
    var proj = projectSalaryByYear(player, Math.max(3, idx + 1));
    if (!proj.length || idx < 0 || idx >= proj.length) return 0;
    return safeInt(proj[idx], 0);
  }

  function calculateCapSpace(capTotal, salaryAdjustmentTotal) {
    var cap = safeInt(state.salaryCapAmount, 0);
    if (cap <= 0) return null;
    return cap - (safeInt(capTotal, 0) + safeInt(salaryAdjustmentTotal, 0));
  }

  function normalizePlayerName(name) {
    var raw = safeStr(name);
    if (!raw) return "Unknown Player";
    if (raw.indexOf(",") === -1) return raw;
    var parts = raw.split(",");
    var last = safeStr(parts[0]);
    var first = safeStr(parts.slice(1).join(" "));
    if (!first) return raw;
    return first + " " + last;
  }

  function parseBool(v, fallback) {
    if (typeof v === "boolean") return v;
    var s = safeStr(v).toLowerCase();
    if (!s) return !!fallback;
    if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
    if (s === "0" || s === "false" || s === "no" || s === "off") return false;
    return !!fallback;
  }

  function normalizeStatus(s) {
    var raw = safeStr(s).toUpperCase();
    if (!raw) return "ROSTER";
    if (raw === "TS" || raw.indexOf("TAXI") !== -1) return "TAXI_SQUAD";
    if (raw === "IR" || raw.indexOf("INJURED") !== -1) return "INJURED_RESERVE";
    return raw;
  }

  function getCookieString() {
    try {
      return safeStr(document.cookie || "");
    } catch (e) {
      return "";
    }
  }

  function getFranchiseIdFromCookies(leagueId, year) {
    var lid = safeStr(leagueId).replace(/\D/g, "");
    if (!lid) return "";
    var yy = safeStr(year).replace(/\D/g, "");
    var raw = getCookieString();
    if (!raw) return "";

    var re = /(?:^|;\s*)MFLPlayerPopup_(\d{4})_(\d+)_(\d{1,4})=/g;
    var match;
    var hits = [];
    while ((match = re.exec(raw))) {
      var hitLeague = safeStr(match[2]).replace(/\D/g, "");
      var hitFranchise = pad4(match[3]);
      if (!hitLeague || hitLeague !== lid) continue;
      if (!hitFranchise || hitFranchise === "0000") continue;
      hits.push({ year: safeStr(match[1]), franchiseId: hitFranchise });
    }
    if (!hits.length) return "";

    if (yy) {
      for (var i = 0; i < hits.length; i += 1) {
        if (hits[i].year === yy) return hits[i].franchiseId;
      }
    }

    hits.sort(function (a, b) {
      return safeInt(b.year, 0) - safeInt(a.year, 0);
    });
    return hits[0].franchiseId;
  }

  function contractBucket(type) {
    var t = normType(type);
    if (!t) return "other";
    if (t.indexOf("rookie") !== -1) return "rookie";
    if (
      t === "fl" ||
      t === "bl" ||
      t.indexOf("frontloaded") !== -1 ||
      t.indexOf("front loaded") !== -1 ||
      t.indexOf("backloaded") !== -1 ||
      t.indexOf("back loaded") !== -1
    ) {
      return "loaded";
    }
    return "other";
  }

  function typeTone(type) {
    var bucket = contractBucket(type);
    if (bucket === "rookie") return "is-rookie";
    if (bucket === "loaded") return "is-loaded";
    return "is-veteran";
  }

  function contractPreviewKey(player) {
    return pad4(player && player.fid) + ":" + safeStr(player && player.id);
  }

  function extensionPreviewYears(player) {
    return safeInt(state.contractPreview[contractPreviewKey(player)], 0);
  }

  function normalizeExtensionTermValue(term) {
    var raw = safeStr(term).toUpperCase();
    if (raw === "2" || raw.indexOf("2YR") === 0) return 2;
    if (raw === "1" || raw.indexOf("1YR") === 0) return 1;
    return 0;
  }

  function normalizeExtensionLoadedIndicator(indicator) {
    var raw = safeStr(indicator).toUpperCase();
    if (!raw || raw === "NONE") return "NONE";
    if (raw === "FL") return "FL";
    if (raw === "BL") return "BL";
    return raw;
  }

  function extensionOptionKey(row) {
    var explicit = safeStr(row && (row.optionKey || row.option_key));
    if (explicit) return explicit;
    var years = safeInt(row && row.yearsToAdd, 0);
    if (years !== 1 && years !== 2) {
      years = normalizeExtensionTermValue(row && (row.extension_term || row.extensionTerm || row.term));
    }
    var loaded = normalizeExtensionLoadedIndicator(row && (row.loadedIndicator || row.loaded_indicator));
    var status = safeStr(
      row && (row.contractStatus || row.new_contract_status || row.contract_status)
    ).toUpperCase();
    var info = safeStr(
      row && (row.contractInfo || row.preview_contract_info_string || row.contract_info)
    );
    return [String(years || 0), loaded || "NONE", status, info].join("|");
  }

  function extensionActionLabel(option) {
    if (!option) return "Extend";
    var label = "Extend " + (safeInt(option.yearsToAdd, 0) === 2 ? "2Y" : "1Y");
    if (safeStr(option.loadedIndicator) !== "NONE") label += " " + safeStr(option.loadedIndicator);
    return label;
  }

  function extensionOptionSummary(option) {
    var parts = [];
    if (safeInt(option && option.contractLength, 0) > 0) {
      parts.push(String(safeInt(option.contractLength, 0)) + " years");
    }
    if (safeInt(option && option.futureAav, 0) > 0) {
      parts.push("Future AAV " + money(option.futureAav));
    }
    if (safeInt(option && option.tcv, 0) > 0) {
      parts.push("TCV " + money(option.tcv));
    }
    if (safeStr(option && option.loadedIndicator) === "FL") parts.push("Front-loaded");
    if (safeStr(option && option.loadedIndicator) === "BL") parts.push("Back-loaded");
    return parts.join(" | ");
  }

  function inlineContractInfoText(contractInfo) {
    return safeStr(contractInfo).replace(/\s*\|\s*/g, " | ");
  }

  function extensionSalaryToSendFromPreview(contractInfo, contractLength, fallbackFutureAav, fallbackCurrentAav) {
    var idx = Math.max(0, safeInt(contractLength, 0));
    var yearValues = parseContractYearValues(contractInfo);
    if (idx > 0 && yearValues[idx] > 0) return safeInt(yearValues[idx], 0);
    var future = safeInt(fallbackFutureAav, 0);
    if (future > 0) return future;
    return Math.max(0, safeInt(fallbackCurrentAav, 0));
  }

  function normalizeExtensionPreviewRow(row) {
    var yearsToAdd = safeInt(row && row.yearsToAdd, 0);
    if (yearsToAdd !== 1 && yearsToAdd !== 2) {
      yearsToAdd = normalizeExtensionTermValue(row && (row.extension_term || row.extensionTerm || row.term));
    }
    var contractLength = safeInt(
      row && (
        row.contractLength != null
          ? row.contractLength
          : (row.new_contract_length != null
              ? row.new_contract_length
              : (row.contract_year != null ? row.contract_year : row.contractYear))
      ),
      0
    );
    var contractInfo = safeStr(
      row && (row.contractInfo || row.preview_contract_info_string || row.contract_info)
    );
    var contractStatus = safeStr(
      row && (row.contractStatus || row.new_contract_status || row.contract_status)
    ).toUpperCase();
    var currentAav = safeInt(
      row && (
        row.currentAav != null
          ? row.currentAav
          : (row.new_aav_current != null ? row.new_aav_current : (row.newAavCurrent != null ? row.newAavCurrent : row.current_salary))
      ),
      0
    );
    var futureAav = safeInt(
      row && (
        row.futureAav != null
          ? row.futureAav
          : (row.new_aav_future != null ? row.new_aav_future : (row.newAavFuture != null ? row.newAavFuture : row.salary))
      ),
      0
    );
    var tcv = safeInt(
      row && (row.tcv != null ? row.tcv : (row.new_TCV != null ? row.new_TCV : row.newTcv)),
      0
    );
    var loadedIndicator = normalizeExtensionLoadedIndicator(
      row && (row.loadedIndicator || row.loaded_indicator)
    );
    var salaryToSend = extensionSalaryToSendFromPreview(contractInfo, contractLength, futureAav, currentAav);

    if (!yearsToAdd || contractLength <= 0 || !contractInfo || !contractStatus || salaryToSend <= 0) {
      return null;
    }

    return {
      optionKey: extensionOptionKey(row),
      yearsToAdd: yearsToAdd,
      loadedIndicator: loadedIndicator,
      contractLength: contractLength,
      contractStatus: contractStatus,
      contractInfo: contractInfo,
      currentAav: currentAav,
      futureAav: futureAav,
      tcv: tcv,
      salaryToSend: salaryToSend
    };
  }

  function normalizeExtensionPreviewRows(rows) {
    var out = [];
    var seen = Object.create(null);
    var list = asArray(rows);
    for (var i = 0; i < list.length; i += 1) {
      var option = normalizeExtensionPreviewRow(list[i]);
      if (!option || seen[option.optionKey]) continue;
      seen[option.optionKey] = true;
      out.push(option);
    }
    out.sort(function (a, b) {
      var delta = safeInt(a && a.yearsToAdd, 0) - safeInt(b && b.yearsToAdd, 0);
      if (delta === 0) delta = safeStr(a && a.loadedIndicator).localeCompare(safeStr(b && b.loadedIndicator));
      if (delta === 0) delta = safeInt(a && a.contractLength, 0) - safeInt(b && b.contractLength, 0);
      return delta;
    });
    return out;
  }

  function playerExtensionOptions(player) {
    return player && player.extensionPreviews ? player.extensionPreviews : [];
  }

  function extensionRaiseForPlayer(player, yearsToAdd) {
    var y = safeInt(yearsToAdd, 0);
    if (y !== 1 && y !== 2) return 0;
    var key = safeStr(player && player.positionGroup).toUpperCase() || "OTHER";
    var rec = EXTENSION_RATES[key] || EXTENSION_RATES.OTHER;
    return safeInt(rec && rec[y], 0);
  }

  function projectedExtensionSalary(player, yearsToAdd) {
    var y = safeInt(yearsToAdd, 0);
    if (y !== 1 && y !== 2) return 0;
    return Math.max(1000, roundToK(safeInt(player && player.salary, 0) + extensionRaiseForPlayer(player, y)));
  }

  function projectSalaryByYear(player, offsets) {
    var years = Math.max(0, safeInt(player && player.years, 0));
    var salary = safeInt(player && player.salary, 0);
    var extYears = extensionPreviewYears(player);
    var extSalary = projectedExtensionSalary(player, extYears);
    var out = [];
    for (var i = 0; i < offsets; i += 1) {
      if (i < years) {
        out.push(salary);
      } else if (extYears > 0 && i < years + extYears) {
        out.push(extSalary);
      } else {
        out.push(0);
      }
    }
    return out;
  }

  function projectedExpiryLabel(player) {
    var baseYear = currentYearInt();
    var totalYears = Math.max(0, safeInt(player && player.years, 0)) + extensionPreviewYears(player);
    if (totalYears <= 0) return "Expired";
    return String(baseYear + totalYears - 1);
  }

  function parseContractYearValues(contractInfo) {
    var info = safeStr(contractInfo);
    var out = Object.create(null);
    if (!info) return out;
    var re = /Y(\d+)\s*-\s*([0-9]+(?:\.[0-9]+)?K?)(?=\s*(?:,|\||Y\d+\s*-|$))/ig;
    var match;
    while ((match = re.exec(info))) {
      var idx = safeInt(match[1], 0);
      var amount = parseContractMoneyToken(match[2]);
      if (idx > 0 && amount > 0) out[idx] = amount;
    }
    return out;
  }

  function contractLengthForPlayer(player) {
    var values = parseContractYearValues(player && player.special);
    var keys = Object.keys(values);
    if (keys.length) {
      return keys.reduce(function (max, key) {
        return Math.max(max, safeInt(key, 0));
      }, 0);
    }
    return Math.max(0, safeInt(player && player.years, 0));
  }

  function contractYearIndexForPlayer(player) {
    var length = contractLengthForPlayer(player);
    var years = Math.max(0, safeInt(player && player.years, 0));
    if (length <= 0 || years <= 0) return 0;
    return Math.max(1, length - years + 1);
  }

  function currentContractYearValue(player) {
    var yearValues = parseContractYearValues(player && player.special);
    var idx = contractYearIndexForPlayer(player);
    if (idx > 0 && yearValues[idx] > 0) return safeInt(yearValues[idx], 0);
    return Math.max(0, safeInt(player && player.salary, 0));
  }

  function contractYearFallbackValue(player, yearIndex) {
    var idx = Math.max(1, safeInt(yearIndex, 1));
    var salary = Math.max(0, safeInt(player && player.salary, 0));
    var aav = Math.max(0, safeInt(player && player.aav, 0) || currentAavForContractInfo(player && player.special));
    if (idx === 1 && salary > 0) return salary;
    if (aav > 0) return aav;
    return salary;
  }

  function contractYearValueMapForPlayer(player) {
    var out = parseContractYearValues(player && player.special);
    var keys = Object.keys(out);
    if (keys.length) return out;

    var length = Math.max(0, contractLengthForPlayer(player));
    for (var i = 1; i <= length; i += 1) {
      var amount = contractYearFallbackValue(player, i);
      if (amount > 0) out[i] = amount;
    }
    return out;
  }

  function totalContractValueForPlayer(player) {
    var explicitTcv = parseContractTcvValue(player && player.special);
    if (explicitTcv > 0) return explicitTcv;

    var yearValues = contractYearValueMapForPlayer(player);
    var keys = Object.keys(yearValues);
    if (keys.length) {
      var total = 0;
      for (var i = 0; i < keys.length; i += 1) {
        total += safeInt(yearValues[keys[i]], 0);
      }
      if (total > 0) return total;
    }

    var length = Math.max(0, contractLengthForPlayer(player));
    return contractYearFallbackValue(player, 1) * length;
  }

  function guaranteedContractValueForPlayer(player) {
    var explicitGuarantee = parseContractGuaranteeValue(player && player.special);
    if (explicitGuarantee > 0) return explicitGuarantee;

    var total = totalContractValueForPlayer(player);
    if (total <= 0) return 0;

    if (total <= 4000) {
      var firstYear = safeInt(contractYearValueMapForPlayer(player)[1], contractYearFallbackValue(player, 1));
      return Math.max(0, total - Math.max(0, firstYear));
    }

    return Math.round(total * 0.75);
  }

  function earnedBeforeCurrentContractYear(player) {
    var idx = contractYearIndexForPlayer(player);
    if (idx <= 1) return 0;

    var earned = 0;
    var yearValues = contractYearValueMapForPlayer(player);
    for (var i = 1; i < idx; i += 1) {
      earned += safeInt(yearValues[i], contractYearFallbackValue(player, i));
    }
    return earned;
  }

  function seasonEndEstimateDate(season) {
    var yr = safeInt(season, 0);
    if (yr <= 0) return null;
    return new Date(yr, 11, 31, 23, 59, 59, 999);
  }

  function proratedEarnedForDrop(season, amount, dropDate) {
    var yr = safeInt(season, 0);
    var salary = Math.max(0, safeInt(amount, 0));
    if (yr <= 0 || salary <= 0 || !(dropDate instanceof Date) || isNaN(dropDate.getTime())) return 0;
    var milestones = [
      new Date(yr, 8, 30, 23, 59, 59, 999),
      new Date(yr, 9, 31, 23, 59, 59, 999),
      new Date(yr, 10, 30, 23, 59, 59, 999),
      seasonEndEstimateDate(yr)
    ];
    var earnedSteps = 0;
    for (var i = 0; i < milestones.length; i += 1) {
      if (milestones[i] && dropDate >= milestones[i]) earnedSteps += 1;
    }
    earnedSteps = Math.max(0, Math.min(earnedSteps, 4));
    return Math.round((salary / 4) * earnedSteps);
  }

  function acquisitionTextForPlayer(player) {
    return safeStr(
      player && (
        player.acquisitionText ||
        player.acquisition_text ||
        player.notes ||
        player.acquired ||
        player.acquiredText
      )
    ).toUpperCase();
  }

  function isLikelyWaiverPickup(player) {
    var type = safeStr(player && player.type).toUpperCase();
    var acquisition = acquisitionTextForPlayer(player);
    return !!(
      type === "WW" ||
      acquisition.indexOf("BBID_WAIVER") !== -1 ||
      acquisition.indexOf("WAIVER") !== -1 ||
      acquisition.indexOf(" BB ") !== -1 ||
      acquisition.indexOf("BB $") !== -1 ||
      acquisition.indexOf("BB$") !== -1
    );
  }

  function isTagCutPreAuctionAssumption(player, season, now) {
    var type = safeStr(player && player.type).toUpperCase();
    if (type !== "TAG") return false;
    var yr = safeInt(season, 0);
    if (yr <= 0 || !(now instanceof Date) || isNaN(now.getTime())) return false;
    if (now.getFullYear() < yr) return true;
    if (now.getFullYear() > yr) return false;
    return now < new Date(yr, 7, 1, 0, 0, 0, 0);
  }

  function dropPenaltyEstimate(player) {
    var years = Math.max(0, safeInt(player && player.years, 0));
    var season = currentYearInt();
    var now = new Date();
    if (years <= 0) {
      return { amount: 0, note: "Expired contracts do not carry a projected cap penalty." };
    }
    if (player && player.isTaxi) {
      return { amount: 0, note: "Taxi players are shown with salary but do not project a current cap penalty." };
    }

    if (isTagCutPreAuctionAssumption(player, season, now)) {
      return {
        amount: 0,
        note: "Pre-auction tag cut assumption: projected cap penalty is $0. Once auction opens, standard earned-salary rules apply."
      };
    }

    var contractLength = Math.max(0, contractLengthForPlayer(player));
    var type = safeStr(player && player.type).toUpperCase();
    var totalContractValue = totalContractValueForPlayer(player);
    var currentYearSalary = currentContractYearValue(player);
    if (contractLength === 1 && currentYearSalary < 5000 && (type === "VETERAN" || type === "WW")) {
      return {
        amount: 0,
        note: "One-year veteran/waiver contracts under $5,000 are cap-free cuts under the current rule."
      };
    }

    if (isLikelyWaiverPickup(player) && contractLength === 1 && currentYearSalary >= 5000) {
      var waiverAmount = Math.round(currentYearSalary * 0.35);
      return {
        amount: waiverAmount,
        note: "Waiver pickup rule: 35% of current-year salary (" + money(currentYearSalary) + " x 35%)."
      };
    }

    var priorEarned = earnedBeforeCurrentContractYear(player);
    var accrued = proratedEarnedForDrop(season, currentYearSalary, now);
    var earned = priorEarned + accrued;
    var explicitGuarantee = parseContractGuaranteeValue(player && player.special);
    var guaranteed = guaranteedContractValueForPlayer(player);
    var penalty = Math.max(0, guaranteed - earned);
    var guaranteeLabel = explicitGuarantee > 0
      ? "contract guarantee"
      : (totalContractValue <= 4000 ? "TCV minus year 1 salary" : "75% of TCV");

    return {
      amount: penalty,
      note: penalty === 0
        ? "Current-rule guarantee has already been fully earned."
        : "Projected current-rule penalty: " + guaranteeLabel + " is " + money(guaranteed) + "; earned to date is " + money(earned) + "."
    };
  }

  function summarizeProjection(proj) {
    var out = [0, 0, 0];
    for (var i = 0; i < proj.length && i < 3; i += 1) out[i] += safeInt(proj[i], 0);
    return out;
  }

  function positionGroupKey(pos) {
    var p = safeStr(pos).toUpperCase();
    if (!p) return "OTHER";

    if (p === "DE" || p === "DT" || p === "DL" || p === "NT" || p === "EDGE" || p === "ED") return "DL";
    if (p === "CB" || p === "S" || p === "FS" || p === "SS" || p === "DB") return "DB";
    if (p === "K" || p === "PK") return "PK";
    if (p === "P" || p === "PN") return "PN";

    if (
      p === "QB" || p === "RB" || p === "WR" || p === "TE" ||
      p === "LB"
    ) {
      return p;
    }

    return "OTHER";
  }

  function positionGroupLabel(key) {
    var k = safeStr(key).toUpperCase();
    if (k === "QB") return "Quarterbacks";
    if (k === "RB") return "Running Backs";
    if (k === "WR") return "Wide Receivers";
    if (k === "TE") return "Tight Ends";
    if (k === "DL") return "Defensive Line";
    if (k === "DB") return "Defensive Backs";
    if (k === "LB") return "Linebackers";
    if (k === "PK") return "Placekickers";
    if (k === "PN") return "Punters";
    return "Other";
  }

  function positionSortValue(groupKey) {
    var idx = POSITION_GROUP_ORDER.indexOf(safeStr(groupKey).toUpperCase());
    return idx === -1 ? 999 : idx;
  }

  function currentYearInt() {
    return safeInt(state.ctx && state.ctx.year, new Date().getFullYear());
  }

  function parseYmdDate(value) {
    var raw = safeStr(value);
    var match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    var dt = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0, 0);
    return isNaN(dt.getTime()) ? null : dt;
  }

  function endOfDay(date) {
    if (!(date instanceof Date) || isNaN(date.getTime())) return null;
    return new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      23,
      59,
      59,
      999
    );
  }

  function seasonEventsForRosterLimit(season) {
    var seasonKey = safeStr(season);
    if (!seasonKey) return null;

    var sources = [
      window.UPS_EVENTS,
      window.nfs_events,
      window.NFS_EVENTS
    ];
    for (var i = 0; i < sources.length; i += 1) {
      var src = sources[i];
      if (src && typeof src === "object" && src[seasonKey] && typeof src[seasonKey] === "object") {
        return src[seasonKey];
      }
    }

    return ROSTER_SEASON_EVENTS_FALLBACK[seasonKey] || null;
  }

  function contractDeadlineYmdForSeason(season) {
    var seasonKey = safeStr(season);
    var metaSeason = safeStr(window.UPS_IS_OFFSEASON_META && window.UPS_IS_OFFSEASON_META.siteSeason);
    var events = seasonEventsForRosterLimit(seasonKey) || {};
    var raw = safeStr(
      events.ups_contract_deadline ||
      events.contract_deadline ||
      events.UPS_CONTRACT_DEADLINE
    );
    if (raw) return raw;
    if (metaSeason && metaSeason === seasonKey) {
      return safeStr(window.UPS_IS_OFFSEASON_META && window.UPS_IS_OFFSEASON_META.deadline);
    }
    return "";
  }

  function contractDeadlineDateForSeason(season) {
    return parseYmdDate(contractDeadlineYmdForSeason(season));
  }

  function activeMaxRosterPlayers(season, now) {
    var today = now instanceof Date && !isNaN(now.getTime()) ? now : new Date();
    var deadline = contractDeadlineDateForSeason(season);
    var deadlineEnd = endOfDay(deadline);
    if (deadlineEnd && today.getTime() <= deadlineEnd.getTime()) {
      return OFFSEASON_MAX_ROSTER_PLAYERS;
    }
    return MAX_ROSTER_PLAYERS;
  }

  function rosterLimitSummary(rosterPlayers, season, now) {
    var count = Math.max(0, safeInt(rosterPlayers, 0));
    var min = MIN_ROSTER_PLAYERS;
    var max = activeMaxRosterPlayers(season, now);
    var delta = 0;
    var status = "";
    var outOfRange = false;

    if (count < min) {
      delta = min - count;
      status = delta + " under min";
      outOfRange = true;
    } else if (count > max) {
      delta = count - max;
      status = delta + " over max";
      outOfRange = true;
    } else if (count === min) {
      status = "At min";
    } else if (count === max) {
      status = "At max";
    } else {
      status = (max - count) + " under max";
    }

    return {
      min: min,
      max: max,
      count: count,
      rangeLabel: min + "-" + max,
      status: status,
      outOfRange: outOfRange,
      deadlineYmd: contractDeadlineYmdForSeason(season)
    };
  }

  function pointModeLabel(mode) {
    if (safeStr(mode) === "cumulative") return "Cumulative";
    return safeStr(mode);
  }

  function viewLabel(view) {
    if (view === "contract") return "Plan view";
    if (view === "franchise") return "Franchise view";
    if (view === "points") return "Points view";
    return "Roster view";
  }

  function resolvePointsHistoryUrl() {
    var candidates = [
      window.UPS_RWB_POINTS_HISTORY_URL,
      window.UPS_ROSTER_WORKBENCH_POINTS_HISTORY_URL
    ];
    for (var i = 0; i < candidates.length; i += 1) {
      var raw = safeStr(candidates[i]);
      if (!raw) continue;
      try {
        return new URL(raw, window.location.href).toString();
      } catch (e) {
        return raw;
      }
    }

    if (SCRIPT_BASE_URL) return SCRIPT_BASE_URL + "player_points_history.json";
    return "https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@main/site/rosters/player_points_history.json";
  }

  function resolveExtensionPreviewFallbackUrl(season) {
    var candidates = [
      window.UPS_RWB_EXTENSION_PREVIEWS_URL,
      window.UPS_ROSTER_WORKBENCH_EXTENSION_PREVIEWS_URL
    ];
    var seasonText = safeStr(season || currentYearInt());
    for (var i = 0; i < candidates.length; i += 1) {
      var raw = safeStr(candidates[i]);
      if (!raw) continue;
      raw = raw.replace(/\{YEAR\}/g, seasonText);
      try {
        return new URL(raw, window.location.href).toString();
      } catch (e) {
        return raw;
      }
    }

    if (SCRIPT_BASE_URL) {
      try {
        return new URL("../trades/extension_previews_" + encodeURIComponent(seasonText) + ".json", SCRIPT_BASE_URL).toString();
      } catch (e) {}
    }
    return "https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@main/site/trades/extension_previews_" + encodeURIComponent(seasonText) + ".json";
  }

  function loadExtensionPreviewFallbackRows(season) {
    var url = resolveExtensionPreviewFallbackUrl(season);
    return fetchJson(url, { credentials: "omit", cache: "no-store" }).then(function (payload) {
      if (Array.isArray(payload)) return payload;
      if (payload && Array.isArray(payload.rows)) return payload.rows;
      if (payload && Array.isArray(payload.extension_previews)) return payload.extension_previews;
      if (payload && Array.isArray(payload.extensionPreviews)) return payload.extensionPreviews;
      return [];
    }).catch(function () {
      return [];
    });
  }

  function mergeExtensionPreviewFallbackRows(teams, rows) {
    var list = teams || [];
    var extRows = asArray(rows);
    if (!list.length || !extRows.length) return;

    var byKey = Object.create(null);
    for (var i = 0; i < extRows.length; i += 1) {
      var row = extRows[i] || {};
      var playerId = safeStr(row.player_id || row.id).replace(/\D/g, "");
      var franchiseId = pad4(row.franchise_id || row.franchiseId);
      if (!playerId || !franchiseId) continue;
      var key = franchiseId + ":" + playerId;
      if (!byKey[key]) byKey[key] = [];
      byKey[key].push(row);
    }

    for (var t = 0; t < list.length; t += 1) {
      var players = list[t] && list[t].players ? list[t].players : [];
      for (var p = 0; p < players.length; p += 1) {
        var player = players[p];
        if (!player || playerExtensionOptions(player).length) continue;
        var mapKey = pad4(player.fid) + ":" + safeStr(player.id).replace(/\D/g, "");
        if (!byKey[mapKey]) continue;
        player.extensionPreviews = normalizeExtensionPreviewRows(byKey[mapKey]);
      }
    }
  }

  function pointsHistoryMeta() {
    return (state.pointsHistory && state.pointsHistory.meta) || {};
  }

  function pointsHistoryPlayers() {
    return (state.pointsHistory && state.pointsHistory.players) || {};
  }

  function liveSeasonKey() {
    return safeStr(state.ctx && state.ctx.year);
  }

  function liveSeasonOverlayIsFresh() {
    var live = state.liveSeasonPoints;
    if (!live || safeStr(live.season) !== liveSeasonKey()) return false;
    return (Date.now() - safeInt(live.fetchedAtMs, 0)) < LIVE_POINTS_TTL_MS;
  }

  function historySeasonsAscending() {
    var meta = pointsHistoryMeta();
    var raw = Array.isArray(meta.history_seasons) ? meta.history_seasons.slice() : [];
    if (state.pointYears && state.pointYears.length) {
      raw = raw.concat(state.pointYears);
    }
    var liveSeason = liveSeasonKey();
    if (liveSeason) raw.push(liveSeason);
    raw = raw
      .map(function (year) { return safeStr(year); })
      .filter(function (year) { return !!year; });
    var seen = Object.create(null);
    raw = raw.filter(function (year) {
      if (seen[year]) return false;
      seen[year] = true;
      return true;
    });
    raw.sort(function (a, b) { return safeInt(a, 0) - safeInt(b, 0); });
    return raw;
  }

  function historySeasonsDescending() {
    return historySeasonsAscending().slice().reverse();
  }

  function historySeasonWeekMax(season) {
    var liveSeason = liveSeasonKey();
    if (
      safeStr(season) === liveSeason &&
      state.liveSeasonPoints &&
      safeStr(state.liveSeasonPoints.season) === liveSeason &&
      safeInt(state.liveSeasonPoints.weekMax, 0) > 0
    ) {
      return safeInt(state.liveSeasonPoints.weekMax, 0);
    }
    var meta = pointsHistoryMeta();
    var seasonKey = safeStr(season);
    var fromMeta = meta && meta.season_week_max ? safeInt(meta.season_week_max[seasonKey], 0) : 0;
    if (fromMeta > 0) return fromMeta;
    return MAX_SCORE_WEEKS;
  }

  function selectedHistoryYears() {
    var seasons = historySeasonsAscending();
    if (!seasons.length) return [];
    var start = safeStr(state.pointsHistoryYearStart || seasons[0]);
    var end = safeStr(state.pointsHistoryYearEnd || seasons[seasons.length - 1]);
    var startNum = safeInt(start, safeInt(seasons[0], 0));
    var endNum = safeInt(end, safeInt(seasons[seasons.length - 1], 0));
    if (startNum > endNum) {
      var swap = startNum;
      startNum = endNum;
      endNum = swap;
    }
    return seasons.filter(function (season) {
      var year = safeInt(season, 0);
      return year >= startNum && year <= endNum;
    });
  }

  function selectedHistoryWeeks() {
    var season = safeStr(state.pointsHistorySeason);
    var maxWeek = historySeasonWeekMax(season);
    var start = Math.max(1, Math.min(maxWeek, safeInt(state.pointsHistoryWeekStart, 1)));
    var end = Math.max(1, Math.min(maxWeek, safeInt(state.pointsHistoryWeekEnd, maxWeek)));
    if (start > end) {
      var swap = start;
      start = end;
      end = swap;
    }
    var weeks = [];
    for (var i = start; i <= end; i += 1) weeks.push(i);
    return weeks;
  }

  function selectionNeedsLiveSeasonOverlay() {
    var liveSeason = liveSeasonKey();
    if (!liveSeason) return false;
    if (state.pointsHistoryMode === "weekly") {
      return safeStr(state.pointsHistorySeason) === liveSeason;
    }
    return selectedHistoryYears().indexOf(liveSeason) !== -1;
  }

  function currentPointsRangeLabel() {
    if (state.pointsHistoryMode === "weekly") {
      var season = safeStr(state.pointsHistorySeason);
      var weeks = selectedHistoryWeeks();
      if (!season || !weeks.length) return "Weekly history";
      if (weeks.length === 1) return season + " Week " + weeks[0];
      return season + " Weeks " + weeks[0] + "-" + weeks[weeks.length - 1];
    }

    var years = selectedHistoryYears();
    if (!years.length) return "Yearly history";
    if (years.length === 1) return years[0] + " season";
    return years[0] + "-" + years[years.length - 1] + " seasons";
  }

  function formatRank(rank) {
    var value = safeInt(rank, 0);
    return value > 0 ? ("#" + value) : "—";
  }

  function formatStarted(value) {
    if (value === 1 || value === true) return "Start";
    if (value === 0 || value === false) return "Bench";
    return "—";
  }

  function isCurrentMobile() {
    return !!(window.matchMedia && window.matchMedia("(max-width: 760px)").matches);
  }

  function detectContext() {
    var out = {
      leagueId: "",
      year: "",
      franchiseId: "",
      hostOrigin: window.location.origin
    };
    try {
      var u = new URL(window.location.href || "");
      out.leagueId = safeStr(
        u.searchParams.get("L") ||
        window.UPS_RWB_LEAGUE_ID ||
        window.league_id ||
        window.LEAGUE_ID ||
        ""
      ).replace(/\D/g, "");
      out.year = safeStr(
        u.searchParams.get("YEAR") ||
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

      out.franchiseId = pad4(
        u.searchParams.get("FRANCHISE_ID") ||
        u.searchParams.get("FRANCHISE") ||
        u.searchParams.get("F") ||
        window.FRANCHISE_ID ||
        window.franchise_id ||
        window.franchiseId ||
        window.fid ||
        ""
      );
    } catch (e) {}

    if (!out.year) out.year = String(new Date().getFullYear());
    if (!out.franchiseId || out.franchiseId === "0000") {
      out.franchiseId = getFranchiseIdFromCookies(out.leagueId, out.year);
    }

    return out;
  }

  function storageKey(name) {
    return storagePrefix + ":" + name;
  }

  function readStorage(name, fallback) {
    try {
      var raw = sessionStorage.getItem(storageKey(name));
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function writeStorage(name, value) {
    try {
      sessionStorage.setItem(storageKey(name), JSON.stringify(value));
    } catch (e) {}
  }

  function readCookie(name) {
    try {
      var raw = safeStr(document.cookie || "");
      if (!raw) return "";
      var parts = raw.split(";");
      for (var i = 0; i < parts.length; i += 1) {
        var p = safeStr(parts[i]);
        if (!p) continue;
        var eq = p.indexOf("=");
        if (eq < 0) continue;
        var key = safeStr(p.slice(0, eq));
        if (key !== name) continue;
        return decodeURIComponent(p.slice(eq + 1));
      }
    } catch (e) {}
    return "";
  }

  function resolveApiKey() {
    var candidates = [
      window.UPS_MFL_APIKEY,
      window.MFL_APIKEY,
      window.APIKEY,
      readCookie("MFL_APIKEY")
    ];
    for (var i = 0; i < candidates.length; i += 1) {
      var k = safeStr(candidates[i]);
      if (k) return k;
    }
    return "";
  }

  function buildExportUrl(origin, year, type, params) {
    var url;
    try {
      url = new URL(String(origin || window.location.origin).replace(/\/$/, "") + "/" + encodeURIComponent(year) + "/export");
    } catch (e) {
      url = new URL(window.location.origin + "/" + encodeURIComponent(year) + "/export");
    }

    url.searchParams.set("TYPE", type);
    url.searchParams.set("JSON", "1");

    var apiKey = resolveApiKey();
    if (apiKey) url.searchParams.set("APIKEY", apiKey);

    var obj = params || {};
    Object.keys(obj).forEach(function (key) {
      var val = obj[key];
      if (val == null || val === "") return;
      url.searchParams.set(key, String(val));
    });

    return url.toString();
  }

  function buildApiExportUrl(year, type, params) {
    return buildExportUrl("https://api.myfantasyleague.com", year, type, params);
  }

  function fetchJson(url) {
    var opts = arguments.length > 1 && arguments[1] ? arguments[1] : {};
    return fetch(url, {
      credentials: opts.credentials || "include",
      cache: opts.cache || "no-store",
      headers: opts.headers || {}
    }).then(function (res) {
      return res.text().then(function (text) {
        if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
        try {
          return JSON.parse(text || "{}");
        } catch (e) {
          throw new Error("Invalid JSON from " + url);
        }
      });
    });
  }

  function fetchLeagueExportWithApiFallback(ctx, seasonStr, type, params) {
    var hostUrl = buildExportUrl(ctx.hostOrigin, seasonStr, type, params);
    var apiUrl = buildApiExportUrl(seasonStr, type, params);

    return fetchJson(hostUrl, { credentials: "include" })
      .catch(function () {
        return fetchJson(apiUrl, { credentials: "omit" });
      });
  }

  function resolveWorkerApiEndpoint() {
    var candidates = [
      window.UPS_RWB_API,
      window.UPS_ROSTER_WORKBENCH_API,
      window.UPS_RWB_API_BASE,
      window.UPS_ROSTER_WORKBENCH_API_BASE
    ];
    for (var i = 0; i < candidates.length; i += 1) {
      var raw = safeStr(candidates[i]);
      if (!raw) continue;
      try {
        var u = new URL(raw, window.location.href);
        if (!/\/roster-workbench\/?$/i.test(safeStr(u.pathname))) {
          u.pathname = safeStr(u.pathname).replace(/\/+$/, "") + "/roster-workbench";
        }
        return u.toString();
      } catch (e) {
        return raw;
      }
    }
    return "https://upsmflproduction.keith-creelman.workers.dev/roster-workbench";
  }

  function resolveWorkerActionEndpoint() {
    try {
      var u = new URL(resolveWorkerApiEndpoint(), window.location.href);
      if (!/\/roster-workbench\/?$/i.test(safeStr(u.pathname))) {
        u.pathname = safeStr(u.pathname).replace(/\/+$/, "") + "/roster-workbench";
      }
      u.pathname = safeStr(u.pathname).replace(/\/roster-workbench\/?$/i, "/roster-workbench/action");
      return u.toString();
    } catch (e) {
      return safeStr(resolveWorkerApiEndpoint()).replace(/\/roster-workbench\/?$/i, "/roster-workbench/action");
    }
  }

  function resolveWorkerContractUpdateEndpoint() {
    var candidates = [
      window.UPS_COMMISH_CONTRACT_UPDATE_URL,
      window.UPS_CONTRACT_UPDATE_API,
      window.UPS_CCC_CONTRACT_UPDATE_URL
    ];
    for (var i = 0; i < candidates.length; i += 1) {
      var raw = safeStr(candidates[i]);
      if (!raw) continue;
      return raw;
    }
    try {
      var u = new URL(resolveWorkerApiEndpoint(), window.location.href);
      if (/\/roster-workbench(?:\/action)?\/?$/i.test(safeStr(u.pathname))) {
        u.pathname = safeStr(u.pathname).replace(/\/roster-workbench(?:\/action)?\/?$/i, "/commish-contract-update");
      } else {
        u.pathname = safeStr(u.pathname).replace(/\/+$/, "") + "/commish-contract-update";
      }
      return u.toString();
    } catch (e) {
      var raw = safeStr(resolveWorkerApiEndpoint());
      if (/\/roster-workbench(?:\/action)?\/?$/i.test(raw)) {
        return raw.replace(/\/roster-workbench(?:\/action)?\/?$/i, "/commish-contract-update");
      }
      return raw.replace(/\/+$/, "") + "/commish-contract-update";
    }
  }

  function useDirectMflMode() {
    var globals = [window.UPS_RWB_DIRECT_MFL, window.UPS_ROSTER_WORKBENCH_DIRECT_MFL];
    for (var i = 0; i < globals.length; i += 1) {
      if (globals[i] == null) continue;
      return parseBool(globals[i], false);
    }
    try {
      var u = new URL(window.location.href || "");
      var q = u.searchParams.get("DIRECT_MFL") ||
        u.searchParams.get("UPS_RWB_DIRECT_MFL") ||
        u.searchParams.get("UPS_ROSTER_WORKBENCH_DIRECT_MFL");
      if (q != null && q !== "") return parseBool(q, false);
    } catch (e) {}
    return false;
  }

  function toScoreMap(payload) {
    var map = Object.create(null);
    var root = payload && payload.playerScores;
    var rows = asArray(root && root.playerScore);
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i] || {};
      var id = safeStr(row.id);
      if (!id) continue;
      map[id] = safeNum(row.score, 0);
    }
    return map;
  }

  function toByeMap(payload) {
    var map = Object.create(null);
    var root = payload && payload.nflByeWeeks;
    var teams = asArray(root && root.team);
    for (var i = 0; i < teams.length; i += 1) {
      var team = teams[i] || {};
      var id = safeStr(team.id).toUpperCase();
      if (!id) continue;
      map[id] = safeStr(team.bye_week);
    }
    return map;
  }

  function toSalaryMap(payload) {
    var map = Object.create(null);
    var root = payload && payload.salaries;
    var unit = root && root.leagueUnit;
    var rows = asArray(unit && unit.player);
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i] || {};
      var id = safeStr(row.id);
      if (!id || id === "0000") continue;
      var rawSalary = safeStr(row.salary);
      var rawYears = safeStr(row.contractYear);
      var rawType = safeStr(row.contractStatus);
      var rawSpecial = safeStr(row.contractInfo);
      if (!rawSalary && !rawYears && !rawType && !rawSpecial) continue;
      map[id] = {
        salary: rawSalary ? parseMoney(rawSalary) : null,
        years: rawYears ? safeInt(rawYears, 0) : null,
        type: rawType || null,
        special: rawSpecial || null
      };
    }
    return map;
  }

  function salaryAdjustmentRowFromNode(node) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return null;
    var hasFranchiseField =
      node.franchise_id != null ||
      node.franchiseId != null ||
      node.franchise != null ||
      node.franchiseid != null;
    var hasAmountField =
      node.amount != null ||
      node.value != null ||
      node.adjustment != null;
    if (!hasFranchiseField || !hasAmountField) return null;

    var rawFranchiseId =
      node.franchise_id != null ? node.franchise_id :
      node.franchiseId != null ? node.franchiseId :
      node.franchise != null ? node.franchise :
      node.franchiseid != null ? node.franchiseid : "";
    var rawAmount =
      node.amount != null ? node.amount :
      node.value != null ? node.value :
      node.adjustment != null ? node.adjustment : "";
    var franchiseId = pad4(rawFranchiseId);
    if (!franchiseId) return null;

    var rawText = safeStr(rawAmount);
    if (!rawText) return null;
    var numeric = Number(rawText.replace(/[^0-9.-]/g, ""));
    if (!isFinite(numeric)) return null;
    var amount = Math.abs(numeric) < 1000 ? Math.round(numeric * 1000) : Math.round(numeric);

    return {
      franchise_id: franchiseId,
      amount: amount,
      explanation: safeStr(node.explanation || node.note || node.notes || node.reason || "")
    };
  }

  function collectSalaryAdjustmentRows(node, out) {
    if (!out) out = [];
    if (!node) return out;
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i += 1) collectSalaryAdjustmentRows(node[i], out);
      return out;
    }
    if (typeof node !== "object") return out;

    var direct = salaryAdjustmentRowFromNode(node);
    if (direct) {
      out.push(direct);
      return out;
    }

    var candidates = [
      node.salary_adjustment,
      node.salaryAdjustment,
      node.salary_adjustments,
      node.salaryAdjustments,
      node.leagueUnit,
      node.franchise,
      node.franchises
    ];
    for (var c = 0; c < candidates.length; c += 1) {
      if (candidates[c] != null) collectSalaryAdjustmentRows(candidates[c], out);
    }
    return out;
  }

  function toSalaryAdjustmentMap(payload) {
    var rows = collectSalaryAdjustmentRows(
      (payload && (payload.salaryAdjustments || payload.salaryadjustments)) || payload || {},
      []
    );
    var map = Object.create(null);
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i] || {};
      var fid = pad4(row.franchise_id);
      if (!fid) continue;
      map[fid] = safeInt(map[fid], 0) + safeInt(row.amount, 0);
    }
    return map;
  }

  function parseLeagueMeta(payload) {
    var root = (payload && payload.league) || {};
    var franchises = asArray(root.franchises && root.franchises.franchise);
    var map = Object.create(null);
    for (var i = 0; i < franchises.length; i += 1) {
      var f = franchises[i] || {};
      var id = safeStr(f.id).padStart(4, "0");
      if (!id) continue;
      map[id] = {
        id: id,
        name: safeStr(f.name) || safeStr(f.abbrev) || ("Team " + id),
        logo: safeStr(f.logo) || safeStr(f.icon),
        icon: safeStr(f.icon),
        division: safeStr(f.division)
      };
    }
    return {
      capAmount: parseMoney(root.salaryCapAmount),
      franchises: map
    };
  }

  function fetchPlayersMap(year, playerIds) {
    var ids = playerIds.slice();
    if (!ids.length) return Promise.resolve(Object.create(null));

    var chunkSize = 250;
    var tasks = [];
    var i;

    for (i = 0; i < ids.length; i += chunkSize) {
      (function (slice) {
        var url = new URL("https://api.myfantasyleague.com/" + encodeURIComponent(year) + "/export");
        url.searchParams.set("TYPE", "players");
        url.searchParams.set("JSON", "1");
        url.searchParams.set("PLAYERS", slice.join(","));
        var apiKey = resolveApiKey();
        if (apiKey) url.searchParams.set("APIKEY", apiKey);
        tasks.push(fetchJson(url.toString()));
      })(ids.slice(i, i + chunkSize));
    }

    return Promise.all(tasks).then(function (responses) {
      var map = Object.create(null);
      for (var x = 0; x < responses.length; x += 1) {
        var payload = responses[x] || {};
        var rows = asArray(payload.players && payload.players.player);
        for (var y = 0; y < rows.length; y += 1) {
          var row = rows[y] || {};
          var id = safeStr(row.id);
          if (!id) continue;
          map[id] = {
            id: id,
            name: normalizePlayerName(row.name),
            position: safeStr(row.position).toUpperCase(),
            team: safeStr(row.team).toUpperCase()
          };
        }
      }
      return map;
    });
  }

  function collectRosterPlayerIds(rostersPayload) {
    var ids = [];
    var seen = Object.create(null);
    var franchises = asArray(rostersPayload && rostersPayload.rosters && rostersPayload.rosters.franchise);
    for (var i = 0; i < franchises.length; i += 1) {
      var players = asArray(franchises[i] && franchises[i].player);
      for (var j = 0; j < players.length; j += 1) {
        var pid = safeStr(players[j] && players[j].id);
        if (!pid || seen[pid]) continue;
        seen[pid] = true;
        ids.push(pid);
      }
    }
    return ids;
  }

  function deriveCompliance(capTotal, capAmount) {
    if (!capAmount) return { ok: true, label: "Compliant" };
    if (capTotal <= capAmount) return { ok: true, label: "Compliant" };
    return { ok: false, label: "Over " + money(capTotal - capAmount) };
  }

  function enrichPlayer(p) {
    var out = p || {};
    out.positionGroup = positionGroupKey(out.position);
    out.typeBucket = contractBucket(out.type);
    if (!out.pointsByYear) out.pointsByYear = Object.create(null);
    if (!out.gamesByYear) out.gamesByYear = Object.create(null);
    if (out.pointsByYear && Object.keys(out.pointsByYear).length === 0) {
      var py = safeStr(state.ctx && state.ctx.year);
      if (py) out.pointsByYear[py] = safeNum(out.points, 0);
    }
    out.pointsCumulative = safeNum(out.pointsCumulative, 0);
    out.gamesCumulative = safeInt(out.gamesCumulative, 0);
    out.aav = safeInt(out.aav, 0) || currentAavForContractInfo(out.special || out.contract_info || "");
    out.extensionPreviews = normalizeExtensionPreviewRows(out.extensionPreviews || out.extension_previews || []);
    return out;
  }

  function buildTeams(rostersPayload, leagueMeta, playersMap, scores, byes, salaryMap, salaryAdjustments, priorSalaryMap) {
    var teams = [];
    var franchises = asArray(rostersPayload && rostersPayload.rosters && rostersPayload.rosters.franchise);

    for (var i = 0; i < franchises.length; i += 1) {
      var fr = franchises[i] || {};
      var fid = safeStr(fr.id).padStart(4, "0");
      if (!fid) continue;

      var teamMeta = leagueMeta.franchises[fid] || {
        id: fid,
        name: "Team " + fid,
        logo: "",
        icon: ""
      };

      var rawPlayers = asArray(fr.player);
      var players = [];
      var taxiCount = 0;
      var irCount = 0;
      var capTotal = 0;

      for (var p = 0; p < rawPlayers.length; p += 1) {
        var rp = rawPlayers[p] || {};
        var pid = safeStr(rp.id);
        if (!pid) continue;

        var info = playersMap[pid] || {
          id: pid,
          name: "Player " + pid,
          position: "",
          team: ""
        };

        var overlay = salaryMap[pid] || null;
        var salary = overlay && overlay.salary != null ? safeInt(overlay.salary, 0) : parseMoney(rp.salary);
        var years = overlay && overlay.years != null ? safeInt(overlay.years, 0) : safeInt(rp.contractYear, 0);
        var contractType = overlay && overlay.type != null ? safeStr(overlay.type) : safeStr(rp.contractStatus);
        var priorContract = priorSalaryMap && priorSalaryMap[pid] ? priorSalaryMap[pid] : null;
        var special = overlay && overlay.special != null ? safeStr(overlay.special) : safeStr(rp.contractInfo);
        special = normalizeContractInfoForDisplay(special, years, priorContract);

        var status = normalizeStatus(rp.status);
        var isTaxi = status === "TAXI_SQUAD";
        var isIr = status === "INJURED_RESERVE";
        var aav = currentAavForContractInfo(special);
        if (isTaxi) {
          taxiCount += 1;
        } else {
          capTotal += currentCapHit(salary, years, isTaxi, isIr);
        }
        if (isIr) irCount += 1;

        players.push(enrichPlayer({
          id: pid,
          fid: fid,
          teamName: teamMeta.name,
          order: p,
          name: info.name,
          position: safeStr(info.position).toUpperCase() || "-",
          nflTeam: safeStr(info.team).toUpperCase(),
          points: safeNum(scores[pid], 0),
          bye: safeStr(byes[safeStr(info.team).toUpperCase()] || ""),
          salary: salary,
          years: years,
          aav: aav,
          type: contractType || "-",
          special: special || "-",
          acquisitionText: safeStr(rp.drafted || rp.acquired || rp.added || ""),
          status: status,
          isTaxi: isTaxi,
          isIr: isIr,
          pointsByYear: Object.create(null),
          pointsCumulative: 0,
          extensionPreviews: []
        }));
      }

      var salaryAdjustmentTotal = safeInt(salaryAdjustments && salaryAdjustments[fid], 0);
      var compliance = deriveCompliance(capTotal + salaryAdjustmentTotal, leagueMeta.capAmount);
      teams.push({
        id: fid,
        fid: fid,
        name: teamMeta.name,
        logo: teamMeta.logo || teamMeta.icon || "",
        players: players,
        summary: {
          players: players.length,
          rosterPlayers: rosterCountForPlayers(players),
          taxi: taxiCount,
          ir: irCount,
          capTotal: capTotal,
          salaryAdjustmentTotal: salaryAdjustmentTotal,
          compliance: compliance
        }
      });
    }

    teams.sort(function (a, b) {
      return safeStr(a.name).localeCompare(safeStr(b.name));
    });

    return teams;
  }

  function toWorkerPlayer(row, franchiseId, fallbackTeamName, orderIndex) {
    var p = row || {};
    var id = safeStr(p.id || p.player_id);
    var nflTeam = safeStr(p.nfl_team || p.nflTeam || p.team).toUpperCase();
    var status = normalizeStatus(p.status || p.roster_status);
    var isTaxi = !!p.is_taxi || !!p.isTaxi || status === "TAXI_SQUAD";
    var isIr = !!p.is_ir || !!p.isIr || status === "INJURED_RESERVE";
    return enrichPlayer({
      id: id,
      fid: pad4(franchiseId),
      teamName: fallbackTeamName,
      order: safeInt(p.order, orderIndex),
      name: normalizePlayerName(p.name || p.player_name || ("Player " + id)),
      position: safeStr(p.position).toUpperCase() || "-",
      nflTeam: nflTeam,
      points: safeNum(p.points, 0),
      bye: safeStr(p.bye),
      salary: safeInt(p.salary, 0),
      years: safeInt(p.years, 0),
      aav: safeInt(p.aav, 0) || currentAavForContractInfo(p.special || p.contract_info || "-"),
      type: safeStr(p.type || p.contract_type || "-") || "-",
      special: safeStr(p.special || p.contract_info || "-") || "-",
      acquisitionText: safeStr(p.acquisition_text || p.notes || p.acquired || ""),
      status: status,
      isTaxi: isTaxi,
      isIr: isIr,
      pointsByYear: Object.create(null),
      pointsCumulative: 0,
      extensionPreviews: p.extension_previews || p.extensionPreviews || []
    });
  }

  function buildTeamsFromWorkerPayload(payload) {
    var rows = asArray(payload && payload.teams);
    var salaryCap = safeInt(payload && payload.salary_cap_dollars, 0);
    var teams = [];

    for (var i = 0; i < rows.length; i += 1) {
      var team = rows[i] || {};
      var id = pad4(team.franchise_id || team.id);
      if (!id) continue;
      var name = safeStr(team.franchise_name || team.name || ("Team " + id));
      var playersRaw = asArray(team.players);
      var players = [];
      var x;
      for (x = 0; x < playersRaw.length; x += 1) {
        players.push(toWorkerPlayer(playersRaw[x], id, name, x));
      }

      var capTotalFromPlayers = players.reduce(function (acc, p) {
        return acc + currentCapHitForPlayer(p);
      }, 0);
      var taxiFromPlayers = players.reduce(function (acc, p) { return acc + (p.isTaxi ? 1 : 0); }, 0);
      var irFromPlayers = players.reduce(function (acc, p) { return acc + (p.isIr ? 1 : 0); }, 0);
      var rosterPlayersFromPlayers = rosterCountForPlayers(players);

      var summary = team.summary || {};
      var capTotal = capTotalFromPlayers;
      var salaryAdjustmentTotal = summary.salary_adjustment_total_dollars == null
        ? safeInt(summary.salaryAdjustmentTotal, 0)
        : safeInt(summary.salary_adjustment_total_dollars, 0);
      var taxiCount = summary.taxi == null ? taxiFromPlayers : safeInt(summary.taxi, taxiFromPlayers);
      var complianceRaw = summary.compliance || deriveCompliance(capTotal + salaryAdjustmentTotal, salaryCap);
      var compliance = {
        ok: complianceRaw.ok == null ? true : !!complianceRaw.ok,
        label: safeStr(complianceRaw.label) || (complianceRaw.ok ? "Compliant" : "Out of compliance")
      };

      teams.push({
        id: id,
        fid: id,
        name: name,
        logo: safeStr(team.icon_url || team.logo || ""),
        players: players,
        summary: {
          players: summary.players == null ? players.length : safeInt(summary.players, players.length),
          rosterPlayers: summary.rosterPlayers == null ? rosterPlayersFromPlayers : safeInt(summary.rosterPlayers, rosterPlayersFromPlayers),
          taxi: taxiCount,
          ir: summary.ir == null ? irFromPlayers : safeInt(summary.ir, irFromPlayers),
          capTotal: capTotal,
          salaryAdjustmentTotal: salaryAdjustmentTotal,
          compliance: compliance
        }
      });
    }

    teams.sort(function (a, b) {
      return safeStr(a.name).localeCompare(safeStr(b.name));
    });
    return teams;
  }

  function buildPointYears() {
    var start = currentYearInt();
    return [String(start), String(start - 1), String(start - 2), String(start - 3)];
  }

  function playerPointsHistoryRecord(player) {
    if (!player) return null;
    var players = pointsHistoryPlayers();
    var id = safeStr(player.id);
    return id && players[id] ? players[id] : null;
  }

  function liveSeasonSummaryForPlayer(player, season) {
    var pid = safeStr(player && player.id);
    var liveSeason = liveSeasonKey();
    if (!pid || safeStr(season) !== liveSeason) return null;
    if (!state.liveSeasonPoints || safeStr(state.liveSeasonPoints.season) !== liveSeason) return null;
    return state.liveSeasonPoints.summaryByPlayer && state.liveSeasonPoints.summaryByPlayer[pid]
      ? state.liveSeasonPoints.summaryByPlayer[pid]
      : null;
  }

  function liveSeasonWeeklyForPlayer(player, season, week) {
    var pid = safeStr(player && player.id);
    var liveSeason = liveSeasonKey();
    var weekKey = safeStr(week);
    if (!pid || !weekKey || safeStr(season) !== liveSeason) return null;
    if (!state.liveSeasonPoints || safeStr(state.liveSeasonPoints.season) !== liveSeason) return null;
    return state.liveSeasonPoints.weeklyByPlayer &&
      state.liveSeasonPoints.weeklyByPlayer[pid] &&
      state.liveSeasonPoints.weeklyByPlayer[pid][weekKey]
      ? state.liveSeasonPoints.weeklyByPlayer[pid][weekKey]
      : null;
  }

  function yearlyHistoryRow(historyRecord, season) {
    var seasonKey = safeStr(season);
    if (!historyRecord || !historyRecord.y || !historyRecord.y[seasonKey]) return null;
    return historyRecord.y[seasonKey];
  }

  function weeklyHistoryRow(historyRecord, season, week) {
    var seasonKey = safeStr(season);
    var weekKey = safeStr(week);
    if (!historyRecord || !historyRecord.w || !historyRecord.w[seasonKey] || !historyRecord.w[seasonKey][weekKey]) return null;
    return historyRecord.w[seasonKey][weekKey];
  }

  function playerYearlyHistoryRow(player, season) {
    var live = liveSeasonSummaryForPlayer(player, season);
    if (live) {
      return [
        Math.round(safeNum(live.points, 0) * 10) / 10,
        safeInt(live.games, 0),
        Math.round(safeNum(live.ppg, 0) * 1000) / 1000,
        safeInt(live.posRank, 0),
        safeInt(live.ppgRank, 0)
      ];
    }
    return yearlyHistoryRow(playerPointsHistoryRecord(player), season);
  }

  function playerWeeklyHistoryRow(player, season, week) {
    var live = liveSeasonWeeklyForPlayer(player, season, week);
    if (live) return live;
    return weeklyHistoryRow(playerPointsHistoryRecord(player), season, week);
  }

  function ensurePointsHistorySelection() {
    var seasons = historySeasonsAscending();
    if (!state.pointsHistoryMode || (state.pointsHistoryMode !== "yearly" && state.pointsHistoryMode !== "weekly")) {
      state.pointsHistoryMode = "yearly";
    }
    if (!seasons.length) return;

    if (!state.pointsHistoryYearStart || seasons.indexOf(state.pointsHistoryYearStart) === -1) {
      state.pointsHistoryYearStart = seasons[0];
    }
    if (!state.pointsHistoryYearEnd || seasons.indexOf(state.pointsHistoryYearEnd) === -1) {
      state.pointsHistoryYearEnd = seasons[seasons.length - 1];
    }

    if (!state.pointsHistorySeason || seasons.indexOf(state.pointsHistorySeason) === -1) {
      state.pointsHistorySeason = seasons[seasons.length - 1];
    }

    var maxWeek = historySeasonWeekMax(state.pointsHistorySeason);
    var weekStart = safeInt(state.pointsHistoryWeekStart, 1);
    var weekEnd = safeInt(state.pointsHistoryWeekEnd, maxWeek);
    if (weekStart < 1 || weekStart > maxWeek) weekStart = 1;
    if (weekEnd < 1 || weekEnd > maxWeek) weekEnd = maxWeek;
    if (weekStart > weekEnd) {
      var swap = weekStart;
      weekStart = weekEnd;
      weekEnd = swap;
    }
    state.pointsHistoryWeekStart = String(weekStart);
    state.pointsHistoryWeekEnd = String(weekEnd);
  }

  function loadPointsHistory() {
    if (state.pointsHistory) {
      ensurePointsHistorySelection();
      return Promise.resolve(state.pointsHistory);
    }
    if (state.pointsHistoryPromise) return state.pointsHistoryPromise;

    state.pointsHistoryLoading = true;
    state.pointsHistoryError = "";
    if (state.view === "points") {
      renderToolbar();
      renderTeams();
    }

    state.pointsHistoryPromise = fetchJson(resolvePointsHistoryUrl(), {
      credentials: "omit",
      cache: "no-store"
    }).then(function (payload) {
      state.pointsHistory = payload || { meta: {}, players: {} };
      state.pointsHistoryLoading = false;
      state.pointsHistoryError = "";
      state.pointsHistoryPromise = null;
      ensurePointsHistorySelection();
      if (state.view === "points") {
        renderToolbar();
        renderTeams();
        ensureLiveSeasonPointsForSelection(false);
      }
      return state.pointsHistory;
    }).catch(function (err) {
      state.pointsHistoryLoading = false;
      state.pointsHistoryError = "Unable to load stored points history. " + summarizeError(err);
      state.pointsHistoryPromise = null;
      if (state.view === "points") {
        renderToolbar();
        renderTeams();
      }
      throw err;
    });

    return state.pointsHistoryPromise;
  }

  function collectLiveWeeklyRows(payload) {
    var rows = [];
    var playerIdsSeen = Object.create(null);
    var root = (payload && (payload.allWeeklyResults || payload)) || {};
    var weeks = asArray(root && root.weeklyResults);
    var weekMax = 0;

    for (var i = 0; i < weeks.length; i += 1) {
      var weekNode = weeks[i] || {};
      var weekNo = safeInt(weekNode.week, 0);
      if (weekNo <= 0) continue;
      if (weekNo > weekMax) weekMax = weekNo;

      var matchups = asArray(weekNode.matchup);
      for (var m = 0; m < matchups.length; m += 1) {
        var franchises = asArray(matchups[m] && matchups[m].franchise);
        for (var f = 0; f < franchises.length; f += 1) {
          var players = asArray(franchises[f] && franchises[f].player);
          for (var p = 0; p < players.length; p += 1) {
            var player = players[p] || {};
            var pid = safeStr(player.id);
            if (!pid) continue;
            playerIdsSeen[pid] = true;
            rows.push({
              week: weekNo,
              playerId: pid,
              playerName: normalizePlayerName(player.name || player.player_name || ("Player " + pid)),
              score: safeNum(player.score, 0),
              started: safeStr(player.status).toLowerCase() === "starter"
            });
          }
        }
      }
    }

    return {
      rows: rows,
      playerIds: Object.keys(playerIdsSeen),
      weekMax: weekMax
    };
  }

  function mergeScoreMaps(maps) {
    var out = Object.create(null);
    for (var i = 0; i < maps.length; i += 1) {
      var map = maps[i] || {};
      var ids = Object.keys(map);
      for (var j = 0; j < ids.length; j += 1) {
        out[ids[j]] = safeNum(map[ids[j]], 0);
      }
    }
    return out;
  }

  function fetchPlayerScoreMapForPlayers(ctx, seasonStr, scoreMode, playerIds) {
    var ids = (playerIds || []).slice();
    if (!ids.length) return Promise.resolve(Object.create(null));

    var chunkSize = 150;
    var tasks = [];
    for (var i = 0; i < ids.length; i += chunkSize) {
      (function (slice) {
        tasks.push(
          fetchLeagueExportWithApiFallback(ctx, seasonStr, "playerScores", {
            L: ctx.leagueId,
            W: scoreMode,
            PLAYERS: slice.join(",")
          }).then(function (payload) {
            return toScoreMap(payload);
          }).catch(function () {
            return Object.create(null);
          })
        );
      })(ids.slice(i, i + chunkSize));
    }

    return Promise.all(tasks).then(mergeScoreMaps);
  }

  function buildLiveSeasonPointsOverlay(seasonStr, weeklyPayload, playersMap, avgMap) {
    var liveRows = collectLiveWeeklyRows(weeklyPayload);
    var weeklyByPlayer = Object.create(null);
    var summaries = Object.create(null);
    var groupedWeekly = Object.create(null);
    var weekMax = safeInt(liveRows.weekMax, 0);

    for (var i = 0; i < liveRows.rows.length; i += 1) {
      var row = liveRows.rows[i] || {};
      var pid = safeStr(row.playerId);
      if (!pid) continue;
      var info = playersMap[pid] || {};
      var playerName = normalizePlayerName(info.name || row.playerName || ("Player " + pid));
      var position = safeStr(info.position).toUpperCase();
      var posGroup = positionGroupKey(position);
      var weekKey = safeStr(row.week);
      var score = Math.round(safeNum(row.score, 0) * 10) / 10;
      var started = row.started ? 1 : 0;

      if (!weeklyByPlayer[pid]) weeklyByPlayer[pid] = Object.create(null);
      weeklyByPlayer[pid][weekKey] = [score, 0, started];

      if (!summaries[pid]) {
        summaries[pid] = {
          playerId: pid,
          playerName: playerName,
          position: position,
          positionGroup: posGroup,
          points: 0,
          games: 0,
          starts: 0,
          ppg: 0,
          posRank: 0,
          ppgRank: 0
        };
      }
      summaries[pid].points += score;
      summaries[pid].games += 1;
      summaries[pid].starts += started;

      if (!groupedWeekly[weekKey]) groupedWeekly[weekKey] = Object.create(null);
      if (!groupedWeekly[weekKey][posGroup]) groupedWeekly[weekKey][posGroup] = [];
      groupedWeekly[weekKey][posGroup].push({
        playerId: pid,
        playerName: playerName,
        score: score
      });
    }

    var weekKeys = Object.keys(groupedWeekly);
    for (var w = 0; w < weekKeys.length; w += 1) {
      var weekKey = weekKeys[w];
      var groups = groupedWeekly[weekKey];
      var posGroups = Object.keys(groups);
      for (var g = 0; g < posGroups.length; g += 1) {
        var posGroupKey = posGroups[g];
        var items = groups[posGroupKey] || [];
        items.sort(function (a, b) {
          var delta = safeNum(b.score, 0) - safeNum(a.score, 0);
          if (Math.abs(delta) > 0.0001) return delta;
          return compareText(a.playerName, b.playerName);
        });
        for (var idx = 0; idx < items.length; idx += 1) {
          if (weeklyByPlayer[items[idx].playerId] && weeklyByPlayer[items[idx].playerId][weekKey]) {
            weeklyByPlayer[items[idx].playerId][weekKey][1] = idx + 1;
          }
        }
      }
    }

    var summaryIds = Object.keys(summaries);
    var minGamesForPpgRank = Math.max(1, Math.ceil(Math.max(1, weekMax) / 2));
    var groupedSummary = Object.create(null);

    for (var s = 0; s < summaryIds.length; s += 1) {
      var summary = summaries[summaryIds[s]];
      var livePpg = avgMap && avgMap[summary.playerId] != null ? safeNum(avgMap[summary.playerId], 0) : null;
      summary.ppg = livePpg == null
        ? (summary.games > 0 ? (summary.points / summary.games) : 0)
        : livePpg;
      if (!groupedSummary[summary.positionGroup]) groupedSummary[summary.positionGroup] = [];
      groupedSummary[summary.positionGroup].push(summary);
    }

    var summaryGroups = Object.keys(groupedSummary);
    for (var sg = 0; sg < summaryGroups.length; sg += 1) {
      var groupKey = summaryGroups[sg];
      var items = groupedSummary[groupKey] || [];
      items.sort(function (a, b) {
        var delta = safeNum(b.points, 0) - safeNum(a.points, 0);
        if (Math.abs(delta) > 0.0001) return delta;
        return compareText(a.playerName, b.playerName);
      });
      for (var rankIdx = 0; rankIdx < items.length; rankIdx += 1) {
        items[rankIdx].posRank = rankIdx + 1;
      }

      var eligible = items.filter(function (item) {
        return safeInt(item.games, 0) >= minGamesForPpgRank;
      });
      eligible.sort(function (a, b) {
        var delta = safeNum(b.ppg, 0) - safeNum(a.ppg, 0);
        if (Math.abs(delta) > 0.0001) return delta;
        var pointsDelta = safeNum(b.points, 0) - safeNum(a.points, 0);
        if (Math.abs(pointsDelta) > 0.0001) return pointsDelta;
        return compareText(a.playerName, b.playerName);
      });
      for (var ppgIdx = 0; ppgIdx < eligible.length; ppgIdx += 1) {
        eligible[ppgIdx].ppgRank = ppgIdx + 1;
      }
    }

    return {
      season: safeStr(seasonStr),
      weekMax: weekMax,
      fetchedAtMs: Date.now(),
      summaryByPlayer: summaries,
      weeklyByPlayer: weeklyByPlayer
    };
  }

  function loadLiveSeasonPoints(force) {
    var seasonStr = liveSeasonKey();
    if (!seasonStr || !state.ctx || !state.ctx.leagueId) return Promise.resolve(null);
    if (!force && liveSeasonOverlayIsFresh()) return Promise.resolve(state.liveSeasonPoints);
    if (!force && state.liveSeasonPointsPromise) return state.liveSeasonPointsPromise;

    state.liveSeasonPointsLoading = true;
    state.liveSeasonPointsError = "";
    if (state.view === "points") {
      renderToolbar();
      renderTeams();
    }

    state.liveSeasonPointsPromise = fetchLeagueExportWithApiFallback(state.ctx, seasonStr, "weeklyResults", {
      L: state.ctx.leagueId,
      W: "YTD",
      MISSING_AS_BYE: 1
    }).then(function (weeklyPayload) {
      var parsed = collectLiveWeeklyRows(weeklyPayload);
      if (!parsed.playerIds.length) {
        return {
          season: seasonStr,
          weekMax: safeInt(parsed.weekMax, 0),
          fetchedAtMs: Date.now(),
          summaryByPlayer: Object.create(null),
          weeklyByPlayer: Object.create(null)
        };
      }

      return Promise.all([
        fetchPlayersMap(seasonStr, parsed.playerIds),
        fetchPlayerScoreMapForPlayers(state.ctx, seasonStr, "AVG", parsed.playerIds)
      ]).then(function (parts) {
        return buildLiveSeasonPointsOverlay(
          seasonStr,
          weeklyPayload,
          parts[0] || Object.create(null),
          parts[1] || Object.create(null)
        );
      });
    }).then(function (overlay) {
      state.liveSeasonPoints = overlay || null;
      state.liveSeasonPointsLoading = false;
      state.liveSeasonPointsError = "";
      state.liveSeasonPointsPromise = null;
      ensurePointsHistorySelection();
      if (state.view === "points") {
        renderToolbar();
        renderTeams();
      }
      return state.liveSeasonPoints;
    }).catch(function (err) {
      state.liveSeasonPointsLoading = false;
      state.liveSeasonPointsError = "Unable to sync live current-season points. " + summarizeError(err);
      state.liveSeasonPointsPromise = null;
      if (state.view === "points") {
        renderToolbar();
        renderTeams();
      }
      throw err;
    });

    return state.liveSeasonPointsPromise;
  }

  function ensureLiveSeasonPointsForSelection(force) {
    if (!selectionNeedsLiveSeasonOverlay() && !force) return Promise.resolve(state.liveSeasonPoints);
    return loadLiveSeasonPoints(!!force).catch(function () {
      return null;
    });
  }

  function summarizeYearlyPointsSelection(player) {
    var years = selectedHistoryYears();
    var totalPoints = 0;
    var totalGames = 0;
    var bestRank = 0;
    var bestPpgRank = 0;
    var seasonsWithData = 0;

    for (var i = 0; i < years.length; i += 1) {
      var row = playerYearlyHistoryRow(player, years[i]);
      if (!row) continue;
      totalPoints += safeNum(row[0], 0);
      totalGames += safeInt(row[1], 0);
      if (safeInt(row[3], 0) > 0 && (!bestRank || safeInt(row[3], 0) < bestRank)) bestRank = safeInt(row[3], 0);
      if (safeInt(row[4], 0) > 0 && (!bestPpgRank || safeInt(row[4], 0) < bestPpgRank)) bestPpgRank = safeInt(row[4], 0);
      seasonsWithData += 1;
    }

    return {
      mode: "yearly",
      points: totalPoints,
      games: totalGames,
      ppg: totalGames > 0 ? (totalPoints / totalGames) : 0,
      bestRank: bestRank,
      bestPpgRank: bestPpgRank,
      starts: 0,
      appearances: seasonsWithData,
      hasData: seasonsWithData > 0
    };
  }

  function summarizeWeeklyPointsSelection(player) {
    var season = safeStr(state.pointsHistorySeason);
    var weeks = selectedHistoryWeeks();
    var totalPoints = 0;
    var appearances = 0;
    var starts = 0;
    var bestRank = 0;

    for (var i = 0; i < weeks.length; i += 1) {
      var row = playerWeeklyHistoryRow(player, season, weeks[i]);
      if (!row) continue;
      totalPoints += safeNum(row[0], 0);
      appearances += 1;
      if (safeInt(row[2], 0) === 1) starts += 1;
      if (safeInt(row[1], 0) > 0 && (!bestRank || safeInt(row[1], 0) < bestRank)) bestRank = safeInt(row[1], 0);
    }

    return {
      mode: "weekly",
      points: totalPoints,
      games: 0,
      ppg: appearances > 0 ? (totalPoints / appearances) : 0,
      bestRank: bestRank,
      bestPpgRank: 0,
      starts: starts,
      appearances: appearances,
      hasData: appearances > 0
    };
  }

  function summarizePointsSelection(player) {
    if (state.pointsHistoryMode === "weekly") return summarizeWeeklyPointsSelection(player);
    return summarizeYearlyPointsSelection(player);
  }

  function sortTeamsForDisplay(teams) {
    var list = Array.isArray(teams) ? teams.slice() : [];
    var viewer = pad4(state.viewerFranchiseId || (state.ctx && state.ctx.franchiseId));
    list.sort(function (a, b) {
      var aOwn = viewer && pad4(a && a.id) === viewer ? 1 : 0;
      var bOwn = viewer && pad4(b && b.id) === viewer ? 1 : 0;
      if (aOwn !== bOwn) return bOwn - aOwn;
      return compareText(a && a.name, b && b.name);
    });
    return list;
  }

  function fetchPointsMapForYear(ctx, yearStr) {
    var hostUrl = buildExportUrl(ctx.hostOrigin, yearStr, "playerScores", {
      L: ctx.leagueId,
      W: "YTD"
    });
    var apiUrl = buildApiExportUrl(yearStr, "playerScores", {
      L: ctx.leagueId,
      W: "YTD"
    });

    function hasAnyScores(map) {
      var keys = Object.keys(map || {});
      for (var i = 0; i < keys.length; i += 1) {
        if (safeNum(map[keys[i]], 0) !== 0) return true;
      }
      return keys.length > 0;
    }

    return fetchJson(hostUrl, { credentials: "include" })
      .then(function (payload) {
        var map = toScoreMap(payload);
        if (hasAnyScores(map)) return map;
        return fetchJson(apiUrl, { credentials: "omit" }).then(function (apiPayload) {
          return toScoreMap(apiPayload);
        });
      })
      .catch(function () {
        return fetchJson(apiUrl, { credentials: "omit" }).then(function (payload) {
          return toScoreMap(payload);
        }).catch(function () {
          return Object.create(null);
        });
      });
  }

  function hydrateTeamsWithPointsHistory(ctx, teams) {
    var years = buildPointYears();
    var requests = years.map(function (y) {
      return fetchPointsMapForYear(ctx, y);
    });

    return Promise.all(requests).then(function (maps) {
      var yearIndex = Object.create(null);
      for (var i = 0; i < years.length; i += 1) yearIndex[years[i]] = maps[i] || Object.create(null);

      for (var t = 0; t < teams.length; t += 1) {
        var players = teams[t].players || [];
        for (var p = 0; p < players.length; p += 1) {
          var player = players[p];
          player.pointsByYear = Object.create(null);
          player.gamesByYear = Object.create(null);
          var cumulative = 0;
          for (var y = 0; y < years.length; y += 1) {
            var year = years[y];
            var score = safeNum(yearIndex[year][player.id], 0);
            player.pointsByYear[year] = score;
            player.gamesByYear[year] = 0;
            cumulative += score;
          }
          player.pointsCumulative = cumulative;
          player.gamesCumulative = 0;
        }
      }

      return years;
    }).catch(function () {
      var fallbackYear = safeStr(ctx && ctx.pointsFallbackYear);
      var fallbackYears = years.length ? years : buildPointYears();
      for (var t = 0; t < teams.length; t += 1) {
        var players = teams[t].players || [];
        for (var p = 0; p < players.length; p += 1) {
          var player = players[p];
          player.pointsByYear = Object.create(null);
          player.gamesByYear = Object.create(null);
          for (var y = 0; y < fallbackYears.length; y += 1) {
            player.pointsByYear[fallbackYears[y]] = 0;
            player.gamesByYear[fallbackYears[y]] = 0;
          }
          if (fallbackYear && player.pointsByYear[fallbackYear] != null) {
            player.pointsByYear[fallbackYear] = safeNum(player.points, 0);
          }
          player.pointsCumulative = fallbackYear && player.pointsByYear[fallbackYear] != null
            ? safeNum(player.pointsByYear[fallbackYear], 0)
            : 0;
          player.gamesCumulative = 0;
        }
      }
      return fallbackYears;
    });
  }

  function mergeGamesMapIntoTeams(yearStr, gamesMap) {
    var year = safeStr(yearStr);
    var map = gamesMap || Object.create(null);
    for (var t = 0; t < state.teams.length; t += 1) {
      var players = state.teams[t].players || [];
      for (var p = 0; p < players.length; p += 1) {
        var player = players[p];
        if (!player.gamesByYear) player.gamesByYear = Object.create(null);
        player.gamesByYear[year] = safeInt(map[player.id], 0);
        var totalGames = 0;
        var gameYears = Object.keys(player.gamesByYear || {});
        for (var i = 0; i < gameYears.length; i += 1) {
          totalGames += safeInt(player.gamesByYear[gameYears[i]], 0);
        }
        player.gamesCumulative = totalGames;
      }
    }
    state.gamesLoadedByYear[year] = true;
    delete state.gamesLoadingByYear[year];
  }

  function fetchWeeklyGamesMapForYear(ctx, yearStr) {
    var weeks = [];
    for (var w = 1; w <= MAX_SCORE_WEEKS; w += 1) weeks.push(w);

    function fetchWeek(weekNo) {
      var hostUrl = buildExportUrl(ctx.hostOrigin, yearStr, "playerScores", {
        L: ctx.leagueId,
        W: String(weekNo)
      });
      var apiUrl = buildApiExportUrl(yearStr, "playerScores", {
        L: ctx.leagueId,
        W: String(weekNo)
      });
      return fetchJson(hostUrl, { credentials: "include" })
        .then(function (payload) { return toScoreMap(payload); })
        .catch(function () {
          return fetchJson(apiUrl, { credentials: "omit" })
            .then(function (payload) { return toScoreMap(payload); })
            .catch(function () { return Object.create(null); });
        });
    }

    return Promise.all(weeks.map(fetchWeek)).then(function (maps) {
      var totals = Object.create(null);
      for (var i = 0; i < maps.length; i += 1) {
        var weekMap = maps[i] || {};
        var ids = Object.keys(weekMap);
        for (var j = 0; j < ids.length; j += 1) {
          var pid = ids[j];
          if (safeNum(weekMap[pid], 0) === 0) continue;
          totals[pid] = safeInt(totals[pid], 0) + 1;
        }
      }
      return totals;
    });
  }

  function ensureGamesLoadedForYear(yearStr) {
    var year = safeStr(yearStr);
    if (!year) return Promise.resolve();
    if (state.gamesLoadedByYear[year]) return Promise.resolve();
    if (state.gamesLoadingByYear[year]) return state.gamesLoadingByYear[year];

    var task = fetchWeeklyGamesMapForYear(state.ctx, year)
      .then(function (gamesMap) {
        mergeGamesMapIntoTeams(year, gamesMap);
        renderTeams();
      })
      .catch(function () {
        mergeGamesMapIntoTeams(year, Object.create(null));
      });

    state.gamesLoadingByYear[year] = task;
    return task;
  }

  function ensureGamesLoadedForCurrentMode() {
    if (state.pointsMode === "cumulative") {
      var years = state.pointYears && state.pointYears.length ? state.pointYears.slice() : buildPointYears();
      return Promise.all(years.map(ensureGamesLoadedForYear));
    }
    var year = safeStr(state.pointsMode || (state.pointYears[0] || state.ctx.year));
    return ensureGamesLoadedForYear(year);
  }

  function pointsForPlayer(player) {
    if (!player) return 0;
    if (state.pointsMode === "cumulative") return safeNum(player.pointsCumulative, 0);

    var key = safeStr(state.pointsMode || (state.pointYears[0] || state.ctx.year));
    if (!key) return 0;

    var map = player.pointsByYear || {};
    if (map[key] == null) return 0;
    return safeNum(map[key], 0);
  }

  function gamesForPlayer(player) {
    if (!player) return 0;
    if (state.pointsMode === "cumulative") return safeInt(player.gamesCumulative, 0);
    var key = safeStr(state.pointsMode || (state.pointYears[0] || state.ctx.year));
    if (!key) return 0;
    var map = player.gamesByYear || {};
    return safeInt(map[key], 0);
  }

  function ppgForPlayer(player) {
    var games = gamesForPlayer(player);
    if (games <= 0) return 0;
    return safeNum(pointsForPlayer(player), 0) / games;
  }

  function formatPoints(n) {
    var v = safeNum(n, 0);
    if (Math.abs(v - Math.round(v)) < 0.001) {
      return Math.round(v).toLocaleString("en-US");
    }
    return (Math.round(v * 10) / 10).toLocaleString("en-US", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1
    });
  }

  function formatPpg(n, games) {
    if (safeInt(games, 0) <= 0) return "—";
    return (Math.round(safeNum(n, 0) * 10) / 10).toLocaleString("en-US", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1
    });
  }

  function compareText(a, b) {
    return safeStr(a).localeCompare(safeStr(b), undefined, { sensitivity: "base" });
  }

  function sortStateForView(view) {
    if (!state.sorts[view]) {
      state.sorts[view] = {
        key: view === "franchise" ? "franchise" : (view === "contract" ? "player" : "name"),
        dir: "asc"
      };
    }
    return state.sorts[view];
  }

  function sortDirMultiplier(view) {
    return sortStateForView(view).dir === "desc" ? -1 : 1;
  }

  function sortArrow(view, key) {
    var sort = sortStateForView(view);
    if (sort.key !== key) return "↕";
    return sort.dir === "desc" ? "▼" : "▲";
  }

  function sortableHeader(view, key, label, extraClass) {
    var sort = sortStateForView(view);
    var isSorted = sort.key === key;
    var cls = "is-sortable" + (isSorted ? " is-sorted" : "") + (extraClass ? " " + extraClass : "");
    return (
      '<th class="' + cls + '" data-action="sort-header" data-sort-view="' + escapeHtml(view) + '" data-sort-key="' + escapeHtml(key) + '">' +
        escapeHtml(label) + ' <span class="rwb-sort-indicator">' + escapeHtml(sortArrow(view, key)) + '</span>' +
      '</th>'
    );
  }

  function sortPlayersForRoster(players) {
    var list = (players || []).slice();
    var sort = sortStateForView("roster");
    var dir = sortDirMultiplier("roster");
    list.sort(function (a, b) {
      var delta = 0;
      switch (sort.key) {
        case "points":
          delta = safeNum(pointsForPlayer(a), 0) - safeNum(pointsForPlayer(b), 0);
          break;
        case "ppg":
          delta = safeNum(ppgForPlayer(a), 0) - safeNum(ppgForPlayer(b), 0);
          break;
        case "bye":
          delta = compareText(a.bye, b.bye);
          break;
        case "salary":
          delta = safeInt(a.salary, 0) - safeInt(b.salary, 0);
          break;
        case "aav":
          delta = safeInt(a.aav, 0) - safeInt(b.aav, 0);
          break;
        case "years":
          delta = safeInt(a.years, 0) - safeInt(b.years, 0);
          break;
        case "type":
          delta = compareText(a.type, b.type);
          break;
        case "special":
          delta = compareText(a.special, b.special);
          break;
        case "action":
          delta = compareText(a.status, b.status);
          break;
        case "name":
        default:
          delta = compareText(a.name, b.name);
          break;
      }
      if (delta === 0) delta = compareText(a.name, b.name);
      return delta * dir;
    });
    return list;
  }

  function sortPlayersForPlan(players) {
    var list = (players || []).slice();
    var sort = sortStateForView("contract");
    var dir = sortDirMultiplier("contract");
    list.sort(function (a, b) {
      var aProj = [displayedSalaryForPlan(a, 0), displayedSalaryForPlan(a, 1), displayedSalaryForPlan(a, 2)];
      var bProj = [displayedSalaryForPlan(b, 0), displayedSalaryForPlan(b, 1), displayedSalaryForPlan(b, 2)];
      var delta = 0;
      switch (sort.key) {
        case "aav":
          delta = safeInt(a.aav, 0) - safeInt(b.aav, 0);
          break;
        case "expires":
          delta = compareText(projectedExpiryLabel(a), projectedExpiryLabel(b));
          break;
        case "year0":
          delta = safeInt(aProj[0], 0) - safeInt(bProj[0], 0);
          break;
        case "year1":
          delta = safeInt(aProj[1], 0) - safeInt(bProj[1], 0);
          break;
        case "year2":
          delta = safeInt(aProj[2], 0) - safeInt(bProj[2], 0);
          break;
        case "type":
          delta = compareText(a.type, b.type);
          break;
        case "player":
        default:
          delta = compareText(a.name, b.name);
          if (delta === 0) delta = positionSortValue(a.positionGroup) - positionSortValue(b.positionGroup);
          break;
      }
      if (delta === 0) delta = compareText(a.name, b.name);
      return delta * dir;
    });
    return list;
  }

  function sortPlayersForPoints(players) {
    var list = (players || []).slice();
    var sort = sortStateForView("points");
    var dir = sortDirMultiplier("points");
    list.sort(function (a, b) {
      var aSummary = summarizePointsSelection(a);
      var bSummary = summarizePointsSelection(b);
      var delta = 0;
      switch (sort.key) {
        case "position":
          delta = positionSortValue(a.positionGroup) - positionSortValue(b.positionGroup);
          if (delta === 0) delta = compareText(a.positionGroup, b.positionGroup);
          break;
        case "ppg":
          delta = safeNum(aSummary.ppg, 0) - safeNum(bSummary.ppg, 0);
          break;
        case "rank":
          var aRank = safeInt(aSummary.bestRank, 999999);
          var bRank = safeInt(bSummary.bestRank, 999999);
          delta = aRank - bRank;
          break;
        case "ppg_rank":
          var aPpgRank = safeInt(aSummary.bestPpgRank, 999999);
          var bPpgRank = safeInt(bSummary.bestPpgRank, 999999);
          delta = aPpgRank - bPpgRank;
          break;
        case "starts":
          delta = safeInt(aSummary.starts, 0) - safeInt(bSummary.starts, 0);
          break;
        case "points":
          delta = safeNum(aSummary.points, 0) - safeNum(bSummary.points, 0);
          break;
        case "player":
        default:
          delta = compareText(a.name, b.name);
          break;
      }
      if (delta === 0) delta = compareText(a.name, b.name);
      return delta * dir;
    });
    return list;
  }

  function matchesFilters(player) {
    if (!player) return false;

    if (state.search) {
      var hay = [
        player.name,
        player.position,
        player.positionGroup,
        positionGroupLabel(player.positionGroup),
        player.nflTeam,
        player.type,
        player.special,
        player.teamName
      ].join(" ").toLowerCase();
      if (hay.indexOf(state.search) === -1) return false;
    }

    if (state.filterPosition && safeStr(player.positionGroup).toUpperCase() !== state.filterPosition) {
      return false;
    }

    if (state.filterType && contractBucket(player.type) !== state.filterType) {
      return false;
    }

    if (state.filterRosterStatus === "active" && (player.isTaxi || player.isIr)) {
      return false;
    }

    if (state.filterRosterStatus === "taxi" && !player.isTaxi) {
      return false;
    }

    if (state.filterRosterStatus === "ir" && !player.isIr) {
      return false;
    }

    return true;
  }

  function groupByPosition(players) {
    var map = Object.create(null);
    for (var i = 0; i < players.length; i += 1) {
      var p = players[i] || {};
      var key = safeStr(p.positionGroup || "OTHER").toUpperCase();
      if (!map[key]) map[key] = [];
      map[key].push(p);
    }

    var keys = Object.keys(map);
    keys.sort(function (a, b) {
      var av = positionSortValue(a);
      var bv = positionSortValue(b);
      if (av !== bv) return av - bv;
      return a.localeCompare(b);
    });

    var out = [];
    for (var x = 0; x < keys.length; x += 1) {
      var key = keys[x];
      var rows = sortPlayersForRoster(map[key]);
      out.push({ key: key, label: positionGroupLabel(key), players: rows });
    }
    return out;
  }

  function ensureMount() {
    var mount = document.getElementById("roster-workbench");
    if (mount) return mount;

    mount = document.createElement("div");
    mount.id = "roster-workbench";

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

  function renderSkeleton() {
    var mount = ensureMount();
    mount.innerHTML =
      '<div id="rwbApp">' +
        '<div class="rwb-shell">' +
          '<header class="rwb-hero">' +
            '<div>' +
              '<h1 class="rwb-title">Rosters</h1>' +
            '</div>' +
          '</header>' +
          '<section class="rwb-toolbar" aria-label="Roster toolbar">' +
            '<div class="rwb-toolbar-main" id="rwbToolbarMain">' +
              '<div class="rwb-toolbar-panel rwb-toolbar-panel-nav">' +
                '<div class="rwb-toolbar-section-label">Views</div>' +
                '<div class="rwb-view-switch" role="tablist" aria-label="View mode">' +
                  '<button type="button" id="rwbViewRoster" class="rwb-btn rwb-btn-ghost is-active" data-action="view-switch" data-view="roster" role="tab" aria-selected="true">Roster View</button>' +
                  '<button type="button" id="rwbViewContract" class="rwb-btn rwb-btn-ghost" data-action="view-switch" data-view="contract" role="tab" aria-selected="false">Plan View</button>' +
                  '<button type="button" id="rwbViewPoints" class="rwb-btn rwb-btn-ghost" data-action="view-switch" data-view="points" role="tab" aria-selected="false">Points View</button>' +
                  '<button type="button" id="rwbViewFranchise" class="rwb-btn rwb-btn-ghost" data-action="view-switch" data-view="franchise" role="tab" aria-selected="false">Franchise View</button>' +
                '</div>' +
              '</div>' +
              '<div class="rwb-toolbar-panel rwb-toolbar-panel-browse">' +
                '<div class="rwb-toolbar-section-label">Browse</div>' +
                '<div class="rwb-toolbar-browse-grid">' +
                  '<label class="rwb-field"><span>Team</span><select id="rwbJumpTeam" class="rwb-select"><option value="">Select team...</option></select></label>' +
                  '<div id="rwbPointsControls" class="rwb-toolbar-points"></div>' +
                '</div>' +
              '</div>' +
            '</div>' +
            '<div id="rwbAdvancedFilters" class="rwb-toolbar-advanced">' +
              '<div class="rwb-toolbar-panel rwb-toolbar-panel-filters">' +
                '<div class="rwb-toolbar-section-label">Filters</div>' +
                '<div class="rwb-toolbar-filter-grid">' +
                  '<label class="rwb-field rwb-field-search"><span>Search</span><input id="rwbSearch" class="rwb-input" type="search" placeholder="Player, team, or contract" autocomplete="off"></label>' +
                  '<label class="rwb-field"><span>Position</span><select id="rwbFilterPosition" class="rwb-select"><option value="">All Groups</option></select></label>' +
                  '<label class="rwb-field"><span>Contract</span><select id="rwbFilterType" class="rwb-select"><option value="">All Contract Types</option></select></label>' +
                  '<label class="rwb-field"><span>Roster Status</span><select id="rwbFilterRosterStatus" class="rwb-select"><option value="">All</option></select></label>' +
                  '<div class="rwb-toolbar-actions">' +
                    '<button type="button" id="rwbResetFilters" class="rwb-btn rwb-btn-ghost">Clear Filters</button>' +
                  '</div>' +
                '</div>' +
              '</div>' +
            '</div>' +
            '<div class="rwb-toolbar-note" id="rwbToolbarNote">Loading roster data...</div>' +
            '<div class="rwb-status" id="rwbStatus" hidden></div>' +
          '</section>' +
          '<section id="rwbTeamList" class="rwb-team-list" aria-live="polite"><div class="rwb-loading">Loading roster data...</div></section>' +
          '<div id="rwbPlayerModal" class="rwb-modal" hidden aria-hidden="true">' +
            '<div class="rwb-modal-backdrop" data-action="close-player-modal"></div>' +
            '<div class="rwb-modal-shell" role="dialog" aria-modal="true" aria-labelledby="rwbPlayerModalTitle">' +
              '<div class="rwb-modal-head">' +
                '<div id="rwbPlayerModalTitle" class="rwb-modal-title">Player Actions</div>' +
                '<button type="button" class="rwb-modal-close" data-action="close-player-modal" aria-label="Close">×</button>' +
              '</div>' +
              '<div id="rwbPlayerModalBody" class="rwb-modal-body"></div>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';

    els.app = document.getElementById("rwbApp");
    els.toolbarMain = document.getElementById("rwbToolbarMain");
    els.jumpTeam = document.getElementById("rwbJumpTeam");
    els.pointsControls = document.getElementById("rwbPointsControls");
    els.pointsMode = null;
    els.pointsHistoryMode = null;
    els.pointsHistoryYearStart = null;
    els.pointsHistoryYearEnd = null;
    els.pointsHistorySeason = null;
    els.pointsHistoryWeekStart = null;
    els.pointsHistoryWeekEnd = null;
    els.search = document.getElementById("rwbSearch");
    els.advanced = document.getElementById("rwbAdvancedFilters");
    els.filterPosition = document.getElementById("rwbFilterPosition");
    els.filterType = document.getElementById("rwbFilterType");
    els.filterRosterStatus = document.getElementById("rwbFilterRosterStatus");
    els.resetFilters = document.getElementById("rwbResetFilters");
    els.note = document.getElementById("rwbToolbarNote");
    els.status = document.getElementById("rwbStatus");
    els.teamList = document.getElementById("rwbTeamList");
    els.viewRoster = document.getElementById("rwbViewRoster");
    els.viewContract = document.getElementById("rwbViewContract");
    els.viewPoints = document.getElementById("rwbViewPoints");
    els.viewFranchise = document.getElementById("rwbViewFranchise");
    els.playerModal = document.getElementById("rwbPlayerModal");
    els.playerModalTitle = document.getElementById("rwbPlayerModalTitle");
    els.playerModalBody = document.getElementById("rwbPlayerModalBody");
  }

  function renderSelectOptions(select, options, selected) {
    if (!select) return;
    var html = [];
    for (var i = 0; i < options.length; i += 1) {
      var opt = options[i] || {};
      var value = safeStr(opt.value);
      var label = safeStr(opt.label);
      html.push(
        '<option value="' + escapeHtml(value) + '"' +
        (value === selected ? " selected" : "") +
        '>' + escapeHtml(label) + '</option>'
      );
    }
    select.innerHTML = html.join("");
  }

  function buildFilterOptionSets() {
    var groupsMap = Object.create(null);

    for (var i = 0; i < state.teams.length; i += 1) {
      var team = state.teams[i] || {};
      var players = team.players || [];
      for (var j = 0; j < players.length; j += 1) {
        var g = safeStr(players[j].positionGroup).toUpperCase();
        if (!g) continue;
        groupsMap[g] = true;
      }
    }

    var keys = Object.keys(groupsMap).sort(function (a, b) {
      var av = positionSortValue(a);
      var bv = positionSortValue(b);
      if (av !== bv) return av - bv;
      return a.localeCompare(b);
    });

    return {
      positions: [{ value: "", label: "All Groups" }].concat(
        keys.map(function (k) { return { value: k, label: positionGroupLabel(k) }; })
      )
    };
  }

  function renderPointsControls() {
    if (!els.pointsControls) return;

    els.pointsMode = null;
    els.pointsHistoryMode = null;
    els.pointsHistoryYearStart = null;
    els.pointsHistoryYearEnd = null;
    els.pointsHistorySeason = null;
    els.pointsHistoryWeekStart = null;
    els.pointsHistoryWeekEnd = null;

    if (state.view === "points") {
      ensurePointsHistorySelection();
      var seasons = historySeasonsDescending();
      if (!seasons.length) seasons = buildPointYears();
      var weeklyMode = state.pointsHistoryMode === "weekly";
      var seasonValue = safeStr(state.pointsHistorySeason || seasons[0]);
      var maxWeek = historySeasonWeekMax(seasonValue);
      var weekOptions = [];
      for (var week = 1; week <= maxWeek; week += 1) {
        weekOptions.push({ value: String(week), label: "Week " + week });
      }

      els.pointsControls.className = "rwb-toolbar-points " + (weeklyMode ? "is-history-weekly" : "is-history-yearly");
      els.pointsControls.innerHTML =
        '<label class="rwb-field"><span>Scoring Mode</span><select id="rwbPointsHistoryMode" class="rwb-select"></select></label>' +
        (weeklyMode
          ? '<label class="rwb-field"><span>Season</span><select id="rwbPointsHistorySeason" class="rwb-select"></select></label>' +
            '<label class="rwb-field"><span>Week From</span><select id="rwbPointsHistoryWeekStart" class="rwb-select"></select></label>' +
            '<label class="rwb-field"><span>Week To</span><select id="rwbPointsHistoryWeekEnd" class="rwb-select"></select></label>'
          : '<label class="rwb-field"><span>Year From</span><select id="rwbPointsHistoryYearStart" class="rwb-select"></select></label>' +
            '<label class="rwb-field"><span>Year To</span><select id="rwbPointsHistoryYearEnd" class="rwb-select"></select></label>');

      els.pointsHistoryMode = document.getElementById("rwbPointsHistoryMode");
      els.pointsHistoryYearStart = document.getElementById("rwbPointsHistoryYearStart");
      els.pointsHistoryYearEnd = document.getElementById("rwbPointsHistoryYearEnd");
      els.pointsHistorySeason = document.getElementById("rwbPointsHistorySeason");
      els.pointsHistoryWeekStart = document.getElementById("rwbPointsHistoryWeekStart");
      els.pointsHistoryWeekEnd = document.getElementById("rwbPointsHistoryWeekEnd");

      renderSelectOptions(els.pointsHistoryMode, [
        { value: "yearly", label: "Yearly" },
        { value: "weekly", label: "Weekly" }
      ], state.pointsHistoryMode || "yearly");

      if (weeklyMode) {
        renderSelectOptions(els.pointsHistorySeason, seasons.map(function (season) {
          return { value: season, label: season };
        }), seasonValue);
        renderSelectOptions(els.pointsHistoryWeekStart, weekOptions, safeStr(state.pointsHistoryWeekStart || "1"));
        renderSelectOptions(els.pointsHistoryWeekEnd, weekOptions, safeStr(state.pointsHistoryWeekEnd || String(maxWeek)));
      } else {
        renderSelectOptions(els.pointsHistoryYearStart, seasons.map(function (season) {
          return { value: season, label: season };
        }), safeStr(state.pointsHistoryYearStart || seasons[seasons.length - 1]));
        renderSelectOptions(els.pointsHistoryYearEnd, seasons.map(function (season) {
          return { value: season, label: season };
        }), safeStr(state.pointsHistoryYearEnd || seasons[0]));
      }
      return;
    }

    els.pointsControls.className = "rwb-toolbar-points";
    els.pointsControls.innerHTML =
      '<label class="rwb-field"><span>Points</span><select id="rwbPointsMode" class="rwb-select"></select></label>';
    els.pointsMode = document.getElementById("rwbPointsMode");

    var pointOptions = [];
    for (var p = 0; p < state.pointYears.length; p += 1) {
      pointOptions.push({ value: state.pointYears[p], label: state.pointYears[p] });
    }
    pointOptions.push({ value: "cumulative", label: "Cumulative" });
    renderSelectOptions(els.pointsMode, pointOptions, state.pointsMode);
  }

  function renderToolbar() {
    if (!els.jumpTeam) return;

    var jumpOptions = [{ value: "", label: "Select team..." }];
    for (var i = 0; i < state.teams.length; i += 1) {
      var team = state.teams[i];
      jumpOptions.push({ value: team.id, label: team.name });
    }
    renderSelectOptions(els.jumpTeam, jumpOptions, "");
    renderPointsControls();

    els.search.value = state.search;

    var sets = buildFilterOptionSets();
    renderSelectOptions(els.filterPosition, sets.positions, state.filterPosition);
    renderSelectOptions(els.filterType, CONTRACT_FILTERS, state.filterType);
    renderSelectOptions(els.filterRosterStatus, ROSTER_STATUS_FILTERS, state.filterRosterStatus);

    if (els.advanced) {
      els.advanced.hidden = false;
      els.advanced.classList.remove("is-open");
    }

    if (els.toolbarMain) {
      els.toolbarMain.classList.toggle("is-points-view", state.view === "points");
    }

    if (els.viewRoster && els.viewContract && els.viewPoints && els.viewFranchise) {
      var rosterActive = state.view === "roster";
      var contractActive = state.view === "contract";
      var pointsActive = state.view === "points";
      var franchiseActive = state.view === "franchise";
      els.viewRoster.classList.toggle("is-active", rosterActive);
      els.viewContract.classList.toggle("is-active", contractActive);
      els.viewPoints.classList.toggle("is-active", pointsActive);
      els.viewFranchise.classList.toggle("is-active", franchiseActive);
      els.viewRoster.setAttribute("aria-selected", rosterActive ? "true" : "false");
      els.viewContract.setAttribute("aria-selected", contractActive ? "true" : "false");
      els.viewPoints.setAttribute("aria-selected", pointsActive ? "true" : "false");
      els.viewFranchise.setAttribute("aria-selected", franchiseActive ? "true" : "false");
    }

    if (els.status) {
      if (state.flash && safeStr(state.flash.text)) {
        els.status.hidden = false;
        els.status.textContent = safeStr(state.flash.text);
        els.status.className = "rwb-status " + (state.flash.type === "error" ? "is-error" : "is-success");
      } else {
        els.status.hidden = true;
        els.status.textContent = "";
        els.status.className = "rwb-status";
      }
    }
  }

  function renderToolbarNote(visiblePlayers, totalPlayers) {
    if (!els.note) return;

    var parts = [];
    parts.push(viewLabel(state.view));
    parts.push("Showing " + visiblePlayers + " of " + totalPlayers + " players");
    if (state.filterPosition) parts.push(positionGroupLabel(state.filterPosition));
    if (state.filterType) {
      if (state.filterType === "rookie") parts.push("Rookies");
      else if (state.filterType === "loaded") parts.push("Loaded");
      else if (state.filterType === "other") parts.push("All Other");
    }
    if (state.filterRosterStatus) parts.push(rosterStatusFilterLabel(state.filterRosterStatus));
    if (state.search) parts.push('Search "' + state.search + '"');
    if (state.view === "points") {
      parts.push(currentPointsRangeLabel());
      var meta = pointsHistoryMeta();
      if (safeStr(meta.history_end_season) && safeStr(meta.history_end_season) !== safeStr(state.ctx && state.ctx.year)) {
        parts.push("Stored history through " + safeStr(meta.history_end_season));
      }
      if (state.pointsHistoryLoading) parts.push("Loading history");
      if (state.pointsHistoryError) parts.push("History unavailable");
      if (selectionNeedsLiveSeasonOverlay()) {
        if (state.liveSeasonPointsLoading) parts.push("Current season syncing live");
        else if (state.liveSeasonPointsError) parts.push("Current season live sync unavailable");
        else if (state.liveSeasonPoints && safeStr(state.liveSeasonPoints.season) === liveSeasonKey()) parts.push("Current season live");
      }
    } else {
      parts.push("Points " + pointModeLabel(state.pointsMode));
    }

    els.note.textContent = parts.join(" | ");
  }

  function teamHeaderHtml(team, filteredPlayers) {
    var logo = safeStr(team.logo);
    var filteredRosterPlayers = rosterCountForPlayers(filteredPlayers);
    var totalRosterPlayers = rosterCountForPlayers(team.players || []);
    var irTotal = safeInt(team && team.summary && team.summary.ir, irCountForPlayers(team.players || []));
    var limit = rosterLimitSummary(totalRosterPlayers, state.ctx && state.ctx.year, new Date());
    var rosterOutOfRange = !!limit.outOfRange;
    var limitTitle = "Roster limit " + limit.rangeLabel;
    if (safeStr(limit.deadlineYmd) && limit.max > MAX_ROSTER_PLAYERS) {
      limitTitle += " until " + safeStr(limit.deadlineYmd);
    }
    var logoHtml = logo
      ? '<img class="rwb-team-logo" src="' + escapeHtml(logo) + '" alt="' + escapeHtml(team.name) + ' logo" title="' + escapeHtml(team.name) + '">' 
      : '<span class="rwb-team-logo-fallback" aria-hidden="true" title="' + escapeHtml(team.name) + '">' + escapeHtml(team.fid) + "</span>";
    var chips = [
      '<span class="rwb-chip' + (rosterOutOfRange ? ' is-bad' : '') + '"><span class="rwb-chip-label">Players</span><span class="rwb-chip-value">' + escapeHtml(String(filteredRosterPlayers)) + '/' + escapeHtml(String(totalRosterPlayers)) + '</span></span>',
      '<span class="rwb-chip' + (limit.outOfRange ? ' is-bad' : '') + '" title="' + escapeHtml(limitTitle) + '"><span class="rwb-chip-label">Limit</span><span class="rwb-chip-value">' + escapeHtml(limit.rangeLabel + " (" + limit.status + ")") + '</span></span>',
      '<span class="rwb-chip"><span class="rwb-chip-label">Taxi</span><span class="rwb-chip-value">' + escapeHtml(String(team.summary.taxi)) + '</span></span>',
      '<span class="rwb-chip"><span class="rwb-chip-label">IR</span><span class="rwb-chip-value">' + escapeHtml(String(irTotal)) + '</span></span>'
    ];
    if (!team.summary.compliance.ok) {
      chips.push(
        '<span class="rwb-chip is-bad"><span class="rwb-chip-label">Compliance</span><span class="rwb-chip-value">' + escapeHtml(team.summary.compliance.label) + '</span></span>'
      );
    }

    return (
      '<header class="rwb-team-head">' +
        '<div class="rwb-team-brand" title="' + escapeHtml(team.name) + '">' +
          logoHtml +
          '<span class="rwb-visually-hidden">' + escapeHtml(team.name) + '</span>' +
        '</div>' +
        '<div class="rwb-team-head-main">' +
          '<div class="rwb-chip-row">' +
            chips.join("") +
          '</div>' +
          teamCapSummaryHtml(team) +
        '</div>' +
      '</header>'
    );
  }

  function teamCapSummaryHtml(team) {
    var totalSalary = safeInt(team && team.summary && team.summary.capTotal, 0);
    var totalAdjustments = safeInt(team && team.summary && team.summary.salaryAdjustmentTotal, 0);
    var capSpace = calculateCapSpace(totalSalary, totalAdjustments);
    var capSpaceClass = capSpace != null && capSpace < 0 ? " is-bad" : "";
    var capSpaceText = capSpace == null ? "—" : money(capSpace);

    return (
      '<div class="rwb-cap-summary">' +
        '<div class="rwb-cap-summary-head">' +
          '<div class="rwb-cap-summary-title">Cap Summary</div>' +
          '<div class="rwb-cap-summary-note">Adjustments from salaryAdjustments export. Taxi excluded. IR counts at 50%.</div>' +
        '</div>' +
        '<table class="rwb-cap-summary-table" aria-label="' + escapeHtml(team.name + ' cap summary') + '">' +
          '<tbody>' +
            '<tr>' +
              '<th>Total Salary</th>' +
              '<td class="rwb-cell-num">' + escapeHtml(money(totalSalary)) + '</td>' +
            '</tr>' +
            '<tr>' +
              '<th>Total Adjustments</th>' +
              '<td class="rwb-cell-num">' + escapeHtml(money(totalAdjustments)) + '</td>' +
            '</tr>' +
            '<tr class="rwb-cap-space-row' + capSpaceClass + '">' +
              '<th>Cap Space Available</th>' +
              '<td class="rwb-cell-num">' + escapeHtml(capSpaceText) + '</td>' +
            '</tr>' +
          '</tbody>' +
        '</table>' +
      '</div>'
    );
  }

  function summarizeTeamPlan(team, playersInput) {
    var players = Array.isArray(playersInput) ? playersInput : (team && team.players) || [];
    var summary = {
      nonTaxiPlayersUnderContract: 0,
      nonTaxiTotals: [0, 0, 0],
      taxiPlayersShown: 0,
      taxiTotals: [0, 0, 0],
      rosterPlayers: rosterCountForPlayers(players),
      totalPlayers: players.length,
      salaryAdjustmentTotal: safeInt(team && team.summary && team.summary.salaryAdjustmentTotal, 0),
      capTotal: safeInt(team && team.summary && team.summary.capTotal, 0)
    };

    for (var i = 0; i < players.length; i += 1) {
      var p = players[i] || {};
      var proj = [displayedSalaryForPlan(p, 0), displayedSalaryForPlan(p, 1), displayedSalaryForPlan(p, 2)];
      var isUnderContract = proj[0] > 0 || proj[1] > 0 || proj[2] > 0;
      if (p.isTaxi) {
        summary.taxiPlayersShown += 1;
        summary.taxiTotals[0] += proj[0];
        summary.taxiTotals[1] += proj[1];
        summary.taxiTotals[2] += proj[2];
      } else {
        if (isUnderContract) summary.nonTaxiPlayersUnderContract += 1;
        summary.nonTaxiTotals[0] += proj[0];
        summary.nonTaxiTotals[1] += proj[1];
        summary.nonTaxiTotals[2] += proj[2];
      }
    }

    summary.capSpaceAvailable = calculateCapSpace(summary.capTotal, summary.salaryAdjustmentTotal);
    return summary;
  }

  function findTeamById(teamId) {
    var id = pad4(teamId);
    if (!id) return null;
    for (var i = 0; i < state.teams.length; i += 1) {
      if (pad4(state.teams[i] && state.teams[i].id) === id) return state.teams[i];
    }
    return null;
  }

  function findPlayerRecord(franchiseId, playerId) {
    var team = findTeamById(franchiseId);
    if (!team) return null;
    var players = team.players || [];
    var pid = safeStr(playerId).replace(/\D/g, "");
    for (var i = 0; i < players.length; i += 1) {
      if (safeStr(players[i] && players[i].id).replace(/\D/g, "") === pid) {
        return { team: team, player: players[i] };
      }
    }
    return null;
  }

  function isOwnRosterPlayer(player) {
    var viewer = pad4(state.viewerFranchiseId || (state.ctx && state.ctx.franchiseId));
    return !!(viewer && player && pad4(player.fid) === viewer);
  }

  function buildTradeModuleUrl(player) {
    var viewerId = pad4(state.viewerFranchiseId || (state.ctx && state.ctx.franchiseId));
    var playerTeamId = pad4(player && player.fid);
    var url = new URL(window.location.origin + "/" + encodeURIComponent(state.ctx.year) + "/home/" + encodeURIComponent(state.ctx.leagueId));
    url.searchParams.set("MODULE", "MESSAGE6=N");
    url.searchParams.set("twb_player_id", safeStr(player && player.id));
    url.searchParams.set("twb_team_id", playerTeamId);
    if (viewerId) {
      url.searchParams.set("twb_left_team", viewerId);
      if (playerTeamId && playerTeamId !== viewerId) {
        url.searchParams.set("twb_right_team", playerTeamId);
        url.searchParams.set("twb_side", "partner");
      } else {
        url.searchParams.set("twb_side", "left");
      }
    }
    return url.toString();
  }

  function openPlayerActionModal(franchiseId, playerId) {
    state.actionModal.open = true;
    state.actionModal.franchiseId = pad4(franchiseId);
    state.actionModal.playerId = safeStr(playerId).replace(/\D/g, "");
    renderPlayerActionModal();
  }

  function closePlayerActionModal() {
    state.actionModal.open = false;
    state.actionModal.franchiseId = "";
    state.actionModal.playerId = "";
    renderPlayerActionModal();
  }

  function renderPlayerActionModal() {
    if (!els.playerModal) return;
    var record = findPlayerRecord(state.actionModal.franchiseId, state.actionModal.playerId);
    var isOpen = !!(state.actionModal.open && record && record.player);
    var content = "";

    if (isOpen) {
      var player = record.player;
      var team = record.team;
      var ownRoster = isOwnRosterPlayer(player);
      var penalty = dropPenaltyEstimate(player);
      var extensionOptions = playerExtensionOptions(player);
      var actions = [];
      for (var i = 0; i < extensionOptions.length; i += 1) {
        var extensionOption = extensionOptions[i];
        actions.push(
          '<button type="button" class="rwb-modal-action' + (ownRoster ? "" : " is-disabled") + '" data-action="extend-player" data-option-key="' + escapeHtml(extensionOption.optionKey) + '" data-player-id="' + escapeHtml(player.id) + '" data-franchise-id="' + escapeHtml(player.fid) + '"' + (ownRoster ? "" : ' disabled') + '>' + escapeHtml(extensionActionLabel(extensionOption)) + '</button>'
        );
      }
      actions.push(
        '<button type="button" class="rwb-modal-action" data-action="trade-player" data-player-id="' + escapeHtml(player.id) + '" data-franchise-id="' + escapeHtml(player.fid) + '">Trade</button>'
      );
      actions.push(
        '<button type="button" class="rwb-modal-action' + (ownRoster && player.isIr ? "" : " is-disabled") + '" data-action="activate-ir-player" data-player-id="' + escapeHtml(player.id) + '" data-franchise-id="' + escapeHtml(player.fid) + '"' + (ownRoster && player.isIr ? "" : ' disabled') + '>Activate From IR</button>'
      );
      actions.push(
        '<button type="button" class="rwb-modal-action' + (ownRoster && player.isTaxi ? "" : " is-disabled") + '" data-action="promote-taxi-player" data-player-id="' + escapeHtml(player.id) + '" data-franchise-id="' + escapeHtml(player.fid) + '"' + (ownRoster && player.isTaxi ? "" : ' disabled') + '>Promote From Taxi</button>'
      );
      actions.push(
        '<button type="button" class="rwb-modal-action' + (ownRoster ? "" : " is-disabled") + '" data-action="drop-player" data-player-id="' + escapeHtml(player.id) + '" data-franchise-id="' + escapeHtml(player.fid) + '"' + (ownRoster ? "" : ' disabled') + '>Drop</button>'
      );

      var extensionSummaryHtml = "";
      if (extensionOptions.length) {
        var extensionLines = [];
        for (var j = 0; j < extensionOptions.length; j += 1) {
          var option = extensionOptions[j];
          extensionLines.push(
            '<div class="rwb-extension-preview-line"><strong>' + escapeHtml(extensionActionLabel(option)) + ':</strong> ' +
              escapeHtml(extensionOptionSummary(option) || inlineContractInfoText(option.contractInfo)) +
            '</div>'
          );
        }
        extensionSummaryHtml =
          '<div class="rwb-modal-note"><strong>Extension Options:</strong>' +
            '<div class="rwb-extension-preview-list">' + extensionLines.join("") + '</div>' +
          '</div>';
      } else if (ownRoster) {
        extensionSummaryHtml =
          '<div class="rwb-modal-note"><strong>Extension:</strong> No extension options are available for this player.</div>';
      }

      content =
        '<div class="rwb-modal-player">' +
          '<div class="rwb-modal-player-main">' +
            '<span class="rwb-pos-pill">' + escapeHtml(player.positionGroup) + '</span>' +
            '<h3>' + escapeHtml(player.name) + '</h3>' +
            (player.isTaxi ? '<span class="rwb-tag is-taxi">Taxi</span>' : '') +
            (player.isIr ? '<span class="rwb-tag is-ir">IR</span>' : '') +
          '</div>' +
          '<div class="rwb-modal-player-sub">' + escapeHtml(team.name) + ' | ' + escapeHtml(player.position) + ' | ' + escapeHtml(player.nflTeam || "-") + '</div>' +
        '</div>' +
        '<div class="rwb-modal-grid">' +
          '<div class="rwb-modal-metric"><span>Salary</span><strong>' + escapeHtml(money(player.salary)) + '</strong></div>' +
          '<div class="rwb-modal-metric"><span>AAV</span><strong>' + escapeHtml(player.aav > 0 ? money(player.aav) : "—") + '</strong></div>' +
          '<div class="rwb-modal-metric"><span>Years</span><strong>' + escapeHtml(String(player.years)) + '</strong></div>' +
          '<div class="rwb-modal-metric"><span>Expires</span><strong>' + escapeHtml(projectedExpiryLabel(player)) + '</strong></div>' +
        '</div>' +
        '<div class="rwb-modal-actions-wrap">' + actions.join("") + '</div>' +
        extensionSummaryHtml +
        '<div class="rwb-modal-note"><strong>Estimated Cap Penalty:</strong> ' + escapeHtml(money(penalty.amount)) + ' | ' + escapeHtml(penalty.note) + '</div>' +
        (!ownRoster ? '<div class="rwb-modal-note">Roster-management actions are enabled only for your franchise. Trade is available from any team.</div>' : '');
    }

    els.playerModal.hidden = !isOpen;
    els.playerModal.setAttribute("aria-hidden", isOpen ? "false" : "true");
    if (els.playerModalBody) els.playerModalBody.innerHTML = content;
    if (els.playerModalTitle) {
      els.playerModalTitle.textContent = isOpen && record && record.player ? record.player.name : "Player Actions";
    }
    if (document.body) {
      document.body.classList.toggle("rwb-modal-open", isOpen);
    }
  }

  function rosterGroupHtml(team, group) {
    var rows = [];
    for (var j = 0; j < group.players.length; j += 1) {
      var p = group.players[j];
      var tags = [];
      if (p.isTaxi) tags.push('<span class="rwb-tag is-taxi">Taxi</span>');
      if (p.isIr) tags.push('<span class="rwb-tag is-ir">IR</span>');
      var points = pointsForPlayer(p);
      var games = gamesForPlayer(p);
      var ppg = ppgForPlayer(p);
      var rowBusy = !!state.busyActionKey && state.busyActionKey.indexOf(":" + p.id) !== -1;
      var actionDisabled = state.busyActionKey ? ' disabled' : '';

      rows.push(
        '<tr class="rwb-player-row' + (p.isTaxi ? ' rwb-player-row-taxi' : '') + (p.isIr ? ' rwb-player-row-ir' : '') + '" data-player-id="' + escapeHtml(p.id) + '">' +
          '<td>' +
            '<div class="rwb-player-name-wrap">' +
              '<div class="rwb-player-line">' +
                '<span class="rwb-pos-pill">' + escapeHtml(safeStr(p.positionGroup)) + '</span>' +
                '<button type="button" class="rwb-player-open" data-action="open-player-modal" data-player-id="' + escapeHtml(p.id) + '" data-franchise-id="' + escapeHtml(p.fid) + '"><span class="rwb-player-name">' + escapeHtml(p.name) + '</span></button>' +
                tags.join("") +
                '<button type="button" class="rwb-row-more" data-action="row-more" aria-expanded="false">More</button>' +
              '</div>' +
              '<dl class="rwb-mobile-details">' +
                '<div><dt>Type</dt><dd>' + escapeHtml(p.type) + '</dd></div>' +
                '<div><dt>AAV</dt><dd>' + escapeHtml(p.aav > 0 ? money(p.aav) : "—") + '</dd></div>' +
                '<div><dt>Contract Info</dt><dd>' + escapeHtml(p.special) + '</dd></div>' +
                '<div><dt>Bye</dt><dd>' + escapeHtml(p.bye || "-") + '</dd></div>' +
              '</dl>' +
            '</div>' +
          '</td>' +
          '<td class="rwb-cell-num">' + escapeHtml(formatPoints(points)) + '</td>' +
          '<td class="rwb-cell-num">' + escapeHtml(formatPpg(ppg, games)) + '</td>' +
          '<td class="rwb-cell-num rwb-col-secondary">' + escapeHtml(p.bye || "-") + '</td>' +
          '<td class="rwb-cell-num">' + escapeHtml(money(p.salary)) + '</td>' +
          '<td class="rwb-cell-num">' + escapeHtml(p.aav > 0 ? money(p.aav) : "—") + '</td>' +
          '<td class="rwb-cell-num">' + escapeHtml(String(p.years)) + '</td>' +
          '<td><span class="rwb-type-pill ' + typeTone(p.type) + '">' + escapeHtml(p.type) + '</span></td>' +
          '<td class="rwb-col-secondary">' + escapeHtml(p.special) + '</td>' +
          '<td>' +
            '<button type="button" class="rwb-row-action" data-action="open-player-modal" data-franchise-id="' + escapeHtml(p.fid) + '" data-player-id="' + escapeHtml(p.id) + '"' + actionDisabled + '>' + escapeHtml(rowBusy ? 'Working...' : ((isOwnRosterPlayer(p) && playerExtensionOptions(p).length) ? 'Actions / Extend' : 'Actions')) + '</button>' +
          '</td>' +
        '</tr>'
      );
    }

    return (
      '<details class="rwb-group" open>' +
        '<summary>' +
          '<span class="rwb-group-label"><span>' + escapeHtml(group.label) + '</span><span class="rwb-group-count">' + escapeHtml(String(group.players.length)) + '</span></span>' +
        '</summary>' +
        '<div class="rwb-table-wrap">' +
          '<table class="rwb-table" aria-label="' + escapeHtml(team.name + " " + group.label + " roster") + '">' +
            '<thead>' +
              '<tr>' +
                sortableHeader("roster", "name", "Player") +
                sortableHeader("roster", "points", "Pts " + pointModeLabel(state.pointsMode)) +
                sortableHeader("roster", "ppg", "PPG") +
                sortableHeader("roster", "bye", "Bye", "rwb-col-secondary") +
                sortableHeader("roster", "salary", "Salary") +
                sortableHeader("roster", "aav", "AAV") +
                sortableHeader("roster", "years", "Years") +
                sortableHeader("roster", "type", "Type") +
                sortableHeader("roster", "special", "Contract Info", "rwb-col-secondary") +
                '<th>Action</th>' +
              '</tr>' +
            '</thead>' +
            '<tbody>' + rows.join("") + '</tbody>' +
          '</table>' +
        '</div>' +
      '</details>'
    );
  }

  function contractBodyHtml(team, filteredPlayers) {
    var base = currentYearInt();
    var years = [String(base), String(base + 1), String(base + 2)];
    var rows = [];
    var planSummary = summarizeTeamPlan(team, filteredPlayers);
    var salaryAdj = safeInt(team.summary.salaryAdjustmentTotal, 0);

    var sorted = sortPlayersForPlan(filteredPlayers);

    for (var i = 0; i < sorted.length; i += 1) {
      var p = sorted[i];
      var proj = [displayedSalaryForPlan(p, 0), displayedSalaryForPlan(p, 1), displayedSalaryForPlan(p, 2)];
      var aav = safeInt(p.aav, 0);

      rows.push(
        '<tr class="rwb-player-row' + (p.isTaxi ? ' rwb-player-row-taxi' : '') + (p.isIr ? ' rwb-player-row-ir' : '') + (extensionPreviewYears(p) ? ' is-projected' : '') + '">' +
          '<td>' +
            '<div class="rwb-player-line">' +
              '<span class="rwb-pos-pill">' + escapeHtml(safeStr(p.positionGroup)) + '</span>' +
              '<button type="button" class="rwb-player-open" data-action="open-player-modal" data-player-id="' + escapeHtml(p.id) + '" data-franchise-id="' + escapeHtml(p.fid) + '"><span class="rwb-player-name">' + escapeHtml(p.name) + '</span></button>' +
              (p.isTaxi ? '<span class="rwb-tag is-taxi">Taxi</span>' : '') +
              (p.isIr ? '<span class="rwb-tag is-ir">IR</span>' : '') +
            '</div>' +
          '</td>' +
          '<td class="rwb-cell-num' + (aav === 0 ? ' rwb-money-zero' : '') + '">' + escapeHtml(aav > 0 ? money(aav) : "—") + '</td>' +
          '<td class="rwb-cell-num">' + escapeHtml(projectedExpiryLabel(p)) + '</td>' +
          '<td class="rwb-cell-num' + (proj[0] === 0 ? ' rwb-money-zero' : '') + '">' + escapeHtml(money(proj[0])) + '</td>' +
          '<td class="rwb-cell-num' + (proj[1] === 0 ? ' rwb-money-zero' : '') + '">' + escapeHtml(money(proj[1])) + '</td>' +
          '<td class="rwb-cell-num' + (proj[2] === 0 ? ' rwb-money-zero' : '') + '">' + escapeHtml(money(proj[2])) + '</td>' +
          '<td><span class="rwb-type-pill ' + typeTone(p.type) + '">' + escapeHtml(p.type) + '</span></td>' +
          '<td>' +
            '<div class="rwb-contract-toggle-row">' +
              '<button type="button" class="rwb-contract-toggle' + (extensionPreviewYears(p) === 1 ? ' is-active' : '') + '" data-action="contract-preview" data-years="1" data-player-id="' + escapeHtml(p.id) + '" data-franchise-id="' + escapeHtml(p.fid) + '">1Y</button>' +
              '<button type="button" class="rwb-contract-toggle' + (extensionPreviewYears(p) === 2 ? ' is-active' : '') + '" data-action="contract-preview" data-years="2" data-player-id="' + escapeHtml(p.id) + '" data-franchise-id="' + escapeHtml(p.fid) + '">2Y</button>' +
            '</div>' +
          '</td>' +
        '</tr>'
      );
    }

    if (!rows.length) {
      return '<div class="rwb-empty">No players match the current filters for this team.</div>';
    }

    return (
      '<div class="rwb-table-wrap">' +
          '<table class="rwb-table rwb-contract-table" aria-label="' + escapeHtml(team.name + " plan view") + '">' +
          '<thead>' +
            '<tr>' +
              sortableHeader("contract", "player", "Player") +
              sortableHeader("contract", "aav", "AAV") +
              sortableHeader("contract", "expires", "Expires") +
              sortableHeader("contract", "year0", years[0]) +
              sortableHeader("contract", "year1", years[1]) +
              sortableHeader("contract", "year2", years[2]) +
              sortableHeader("contract", "type", "Type") +
              '<th>Preview</th>' +
            '</tr>' +
          '</thead>' +
          '<tbody>' + rows.join("") + '</tbody>' +
          '<tfoot>' +
            '<tr class="rwb-summary-row rwb-summary-row-primary">' +
              '<th>Non-Taxi</th>' +
              '<th>—</th>' +
              '<th>' + escapeHtml(String(planSummary.nonTaxiPlayersUnderContract)) + ' players</th>' +
              '<th class="rwb-cell-num">' + escapeHtml(money(planSummary.nonTaxiTotals[0])) + '</th>' +
              '<th class="rwb-cell-num">' + escapeHtml(money(planSummary.nonTaxiTotals[1])) + '</th>' +
              '<th class="rwb-cell-num">' + escapeHtml(money(planSummary.nonTaxiTotals[2])) + '</th>' +
              '<th colspan="2">Salary shown. Cap summary above applies adjustments.</th>' +
            '</tr>' +
            '<tr class="rwb-summary-row rwb-summary-row-taxi">' +
              '<th>Taxi</th>' +
              '<th>—</th>' +
              '<th>' + escapeHtml(String(planSummary.taxiPlayersShown)) + ' players</th>' +
              '<th class="rwb-cell-num">' + escapeHtml(money(planSummary.taxiTotals[0])) + '</th>' +
              '<th class="rwb-cell-num">' + escapeHtml(money(planSummary.taxiTotals[1])) + '</th>' +
              '<th class="rwb-cell-num">' + escapeHtml(money(planSummary.taxiTotals[2])) + '</th>' +
              '<th colspan="2">Salary shown, excluded from cap totals</th>' +
            '</tr>' +
            (salaryAdj !== 0
              ? '<tr class="rwb-summary-row rwb-summary-row-adjustment">' +
                  '<th>Salary Adj.</th>' +
                  '<th>—</th>' +
                  '<th>Current season</th>' +
                  '<th class="rwb-cell-num">' + escapeHtml(money(salaryAdj)) + '</th>' +
                  '<th class="rwb-cell-num">' + escapeHtml(money(0)) + '</th>' +
                  '<th class="rwb-cell-num">' + escapeHtml(money(0)) + '</th>' +
                  '<th colspan="2">Applied to cap total</th>' +
                '</tr>'
              : '') +
          '</tfoot>' +
        '</table>' +
      '</div>'
    );
  }

  function filteredPlayersForTeam(team) {
    var players = (team && team.players) || [];
    var filtered = [];
    for (var i = 0; i < players.length; i += 1) {
      if (matchesFilters(players[i])) filtered.push(players[i]);
    }
    return filtered;
  }

  function franchiseSummaryHtml(teamViews) {
    var base = currentYearInt();
    var years = [String(base), String(base + 1), String(base + 2)];
    var rows = [];
    var rowData = [];
    var leagueNonTaxiTotals = [0, 0, 0];
    var leagueTaxiTotals = [0, 0, 0];
    var leaguePlayers = 0;
    var leagueTaxiPlayers = 0;
    var leagueAdjustments = 0;
    var leagueCapSpace = 0;
    var hasCapSpace = safeInt(state.salaryCapAmount, 0) > 0;

    for (var i = 0; i < teamViews.length; i += 1) {
      var teamView = teamViews[i] || {};
      var team = teamView.team || {};
      var filteredPlayers = teamView.filteredPlayers || [];
      var planSummary = summarizeTeamPlan(team, filteredPlayers);
      leaguePlayers += planSummary.rosterPlayers;
      leagueTaxiPlayers += planSummary.taxiPlayersShown;
      leagueNonTaxiTotals[0] += planSummary.nonTaxiTotals[0];
      leagueNonTaxiTotals[1] += planSummary.nonTaxiTotals[1];
      leagueNonTaxiTotals[2] += planSummary.nonTaxiTotals[2];
      leagueTaxiTotals[0] += planSummary.taxiTotals[0];
      leagueTaxiTotals[1] += planSummary.taxiTotals[1];
      leagueTaxiTotals[2] += planSummary.taxiTotals[2];
      leagueAdjustments += planSummary.salaryAdjustmentTotal;
      if (planSummary.capSpaceAvailable != null) leagueCapSpace += planSummary.capSpaceAvailable;

      rowData.push({
        team: team,
        planSummary: planSummary
      });
    }

    var franchiseSort = sortStateForView("franchise");
    var franchiseDir = sortDirMultiplier("franchise");
    rowData.sort(function (a, b) {
      var left = a.planSummary || {};
      var right = b.planSummary || {};
      var delta = 0;
      switch (franchiseSort.key) {
        case "players":
          delta = safeInt(left.rosterPlayers, 0) - safeInt(right.rosterPlayers, 0);
          break;
        case "year0":
          delta = safeInt(left.nonTaxiTotals[0], 0) - safeInt(right.nonTaxiTotals[0], 0);
          break;
        case "year1":
          delta = safeInt(left.nonTaxiTotals[1], 0) - safeInt(right.nonTaxiTotals[1], 0);
          break;
        case "year2":
          delta = safeInt(left.nonTaxiTotals[2], 0) - safeInt(right.nonTaxiTotals[2], 0);
          break;
        case "adjustments":
          delta = safeInt(left.salaryAdjustmentTotal, 0) - safeInt(right.salaryAdjustmentTotal, 0);
          break;
        case "capspace":
          delta = safeInt(left.capSpaceAvailable, 0) - safeInt(right.capSpaceAvailable, 0);
          break;
        case "taxi":
          delta = safeInt(left.taxiTotals[0], 0) - safeInt(right.taxiTotals[0], 0);
          break;
        case "franchise":
        default:
          delta = compareText(a.team && a.team.name, b.team && b.team.name);
          break;
      }
      if (delta === 0) delta = compareText(a.team && a.team.name, b.team && b.team.name);
      return delta * franchiseDir;
    });

    for (var j = 0; j < rowData.length; j += 1) {
      var row = rowData[j];
      var teamRow = row.team || {};
      var planSummaryRow = row.planSummary || {};
      var logo = safeStr(teamRow.logo);
      rows.push(
        '<tr id="rwb-team-' + escapeHtml(teamRow.id) + '">' +
          '<td>' +
            '<div class="rwb-franchise-cell">' +
              (logo
                ? '<img class="rwb-franchise-icon" src="' + escapeHtml(logo) + '" alt="' + escapeHtml(teamRow.name) + ' logo">'
                : '<span class="rwb-franchise-icon rwb-franchise-icon-fallback">' + escapeHtml(teamRow.fid) + '</span>') +
              '<div class="rwb-franchise-copy">' +
                '<div class="rwb-franchise-name">' + escapeHtml(teamRow.name) + '</div>' +
                '<div class="rwb-franchise-meta">' + escapeHtml(String(planSummaryRow.rosterPlayers)) + ' roster | ' + escapeHtml(String(planSummaryRow.taxiPlayersShown)) + ' taxi</div>' +
              '</div>' +
            '</div>' +
          '</td>' +
          '<td class="rwb-cell-num">' + escapeHtml(String(planSummaryRow.rosterPlayers)) + '</td>' +
          '<td class="rwb-cell-num">' + escapeHtml(money(planSummaryRow.nonTaxiTotals[0])) + '</td>' +
          '<td class="rwb-cell-num">' + escapeHtml(money(planSummaryRow.nonTaxiTotals[1])) + '</td>' +
          '<td class="rwb-cell-num">' + escapeHtml(money(planSummaryRow.nonTaxiTotals[2])) + '</td>' +
          '<td class="rwb-cell-num">' + escapeHtml(money(planSummaryRow.salaryAdjustmentTotal)) + '</td>' +
          '<td class="rwb-cell-num' + (planSummaryRow.capSpaceAvailable != null && planSummaryRow.capSpaceAvailable < 0 ? ' rwb-cap-space-negative' : '') + '">' + escapeHtml(planSummaryRow.capSpaceAvailable == null ? "—" : money(planSummaryRow.capSpaceAvailable)) + '</td>' +
          '<td class="rwb-cell-num">' + escapeHtml(money(planSummaryRow.taxiTotals[0])) + '</td>' +
        '</tr>'
      );
    }

    return (
      '<article class="rwb-team-card rwb-franchise-summary-card">' +
        '<div class="rwb-table-wrap">' +
          '<table class="rwb-table rwb-franchise-table" aria-label="Franchise view summary">' +
            '<thead>' +
              '<tr>' +
                sortableHeader("franchise", "franchise", "Franchise") +
                sortableHeader("franchise", "players", "Players") +
                sortableHeader("franchise", "year0", years[0]) +
                sortableHeader("franchise", "year1", years[1]) +
                sortableHeader("franchise", "year2", years[2]) +
                sortableHeader("franchise", "adjustments", "Adj.") +
                sortableHeader("franchise", "capspace", "Cap Space") +
                sortableHeader("franchise", "taxi", "Taxi") +
              '</tr>' +
            '</thead>' +
            '<tbody>' + rows.join("") + '</tbody>' +
            '<tfoot>' +
              '<tr class="rwb-summary-row rwb-summary-row-primary">' +
                '<th>League</th>' +
                '<th class="rwb-cell-num">' + escapeHtml(String(leaguePlayers)) + '</th>' +
                '<th class="rwb-cell-num">' + escapeHtml(money(leagueNonTaxiTotals[0])) + '</th>' +
                '<th class="rwb-cell-num">' + escapeHtml(money(leagueNonTaxiTotals[1])) + '</th>' +
                '<th class="rwb-cell-num">' + escapeHtml(money(leagueNonTaxiTotals[2])) + '</th>' +
                '<th class="rwb-cell-num">' + escapeHtml(money(leagueAdjustments)) + '</th>' +
                '<th class="rwb-cell-num">' + escapeHtml(hasCapSpace ? money(leagueCapSpace) : "—") + '</th>' +
                '<th class="rwb-cell-num">' + escapeHtml(money(leagueTaxiTotals[0])) + '</th>' +
              '</tr>' +
              '<tr class="rwb-summary-row rwb-summary-row-taxi">' +
                '<th>Taxi Players</th>' +
                '<th class="rwb-cell-num">' + escapeHtml(String(leagueTaxiPlayers)) + '</th>' +
                '<th class="rwb-cell-num">' + escapeHtml(money(leagueTaxiTotals[0])) + '</th>' +
                '<th class="rwb-cell-num">' + escapeHtml(money(leagueTaxiTotals[1])) + '</th>' +
                '<th class="rwb-cell-num">' + escapeHtml(money(leagueTaxiTotals[2])) + '</th>' +
                '<th colspan="3">Taxi salary is shown but excluded from cap totals.</th>' +
              '</tr>' +
            '</tfoot>' +
          '</table>' +
        '</div>' +
      '</article>'
    );
  }

  function summarizeTeamPointsSelection(players) {
    var summary = {
      shown: (players || []).length,
      withData: 0,
      totalPoints: 0,
      totalStarts: 0
    };

    for (var i = 0; i < players.length; i += 1) {
      var playerSummary = summarizePointsSelection(players[i]);
      summary.totalPoints += safeNum(playerSummary.points, 0);
      summary.totalStarts += safeInt(playerSummary.starts, 0);
      if (playerSummary.hasData) summary.withData += 1;
    }

    return summary;
  }

  function pointsHistoryToggleKey(team, player) {
    return safeStr(team && team.id) + ":" + safeStr(player && player.id);
  }

  function pointsYearlyHistoryTableHtml(player) {
    var years = selectedHistoryYears();
    var header = ['<th>Metric</th>'];
    var pointsRow = ['<tr><th>Points</th>'];
    var rankRow = ['<tr><th>Pos Rank</th>'];
    var ppgRow = ['<tr><th>PPG</th>'];
    var ppgRankRow = ['<tr><th>PPG Rank</th>'];

    for (var i = 0; i < years.length; i += 1) {
      var year = years[i];
      var row = playerYearlyHistoryRow(player, year);
      header.push('<th>' + escapeHtml(year) + '</th>');
      if (!row) {
        pointsRow.push('<td class="rwb-points-history-missing">—</td>');
        rankRow.push('<td class="rwb-points-history-missing">—</td>');
        ppgRow.push('<td class="rwb-points-history-missing">—</td>');
        ppgRankRow.push('<td class="rwb-points-history-missing">—</td>');
        continue;
      }
      pointsRow.push('<td class="rwb-cell-num">' + escapeHtml(formatPoints(row[0])) + '</td>');
      rankRow.push('<td class="rwb-cell-num">' + escapeHtml(formatRank(row[3])) + '</td>');
      ppgRow.push('<td class="rwb-cell-num">' + escapeHtml(formatPpg(row[2], row[1])) + '</td>');
      ppgRankRow.push('<td class="rwb-cell-num">' + escapeHtml(formatRank(row[4])) + '</td>');
    }

    pointsRow.push('</tr>');
    rankRow.push('</tr>');
    ppgRow.push('</tr>');
    ppgRankRow.push('</tr>');

    return (
      '<div class="rwb-points-history-wrap">' +
        '<table class="rwb-table rwb-points-history-table" aria-label="' + escapeHtml(player.name + ' yearly points history') + '">' +
          '<thead><tr>' + header.join("") + '</tr></thead>' +
          '<tbody>' + pointsRow.join("") + rankRow.join("") + ppgRow.join("") + ppgRankRow.join("") + '</tbody>' +
        '</table>' +
      '</div>'
    );
  }

  function pointsWeeklyHistoryTableHtml(player) {
    var season = safeStr(state.pointsHistorySeason);
    var weeks = selectedHistoryWeeks();
    var header = ['<th>Metric</th>'];
    var pointsRow = ['<tr><th>Points</th>'];
    var rankRow = ['<tr><th>Pos Rank</th>'];
    var startedRow = ['<tr><th>Started</th>'];

    for (var i = 0; i < weeks.length; i += 1) {
      var week = weeks[i];
      var row = playerWeeklyHistoryRow(player, season, week);
      header.push('<th>' + escapeHtml(String(week)) + '</th>');
      if (!row) {
        pointsRow.push('<td class="rwb-points-history-missing">—</td>');
        rankRow.push('<td class="rwb-points-history-missing">—</td>');
        startedRow.push('<td class="rwb-points-history-missing">—</td>');
        continue;
      }
      pointsRow.push('<td class="rwb-cell-num">' + escapeHtml(formatPoints(row[0])) + '</td>');
      rankRow.push('<td class="rwb-cell-num">' + escapeHtml(formatRank(row[1])) + '</td>');
      startedRow.push('<td class="' + (safeInt(row[2], 0) === 1 ? 'rwb-points-history-started' : 'rwb-points-history-bench') + '">' + escapeHtml(formatStarted(row[2])) + '</td>');
    }

    pointsRow.push('</tr>');
    rankRow.push('</tr>');
    startedRow.push('</tr>');

    return (
      '<div class="rwb-points-history-wrap">' +
        '<table class="rwb-table rwb-points-history-table" aria-label="' + escapeHtml(player.name + ' weekly points history for ' + season) + '">' +
          '<thead><tr>' + header.join("") + '</tr></thead>' +
          '<tbody>' + pointsRow.join("") + rankRow.join("") + startedRow.join("") + '</tbody>' +
        '</table>' +
      '</div>'
    );
  }

  function pointsHistoryDetailHtml(team, player, summary) {
    var rangeLabel = currentPointsRangeLabel();
    var subtitle = state.pointsHistoryMode === "weekly"
      ? (safeInt(summary.starts, 0) + " starts in selected range")
      : (safeInt(summary.games, 0) > 0 ? (safeInt(summary.games, 0) + " games in selected range") : "No games in selected range");

    return (
      '<div class="rwb-points-detail">' +
        '<div class="rwb-points-detail-head">' +
          '<div>' +
            '<div class="rwb-points-detail-title">' + escapeHtml(player.name) + '</div>' +
            '<div class="rwb-points-detail-sub">' + escapeHtml(team.name + " | " + rangeLabel + " | " + subtitle) + '</div>' +
          '</div>' +
        '</div>' +
        (state.pointsHistoryMode === "weekly" ? pointsWeeklyHistoryTableHtml(player) : pointsYearlyHistoryTableHtml(player)) +
      '</div>'
    );
  }

  function pointsPlayerRowHtml(team, player) {
    var summary = summarizePointsSelection(player);
    var toggleKey = pointsHistoryToggleKey(team, player);
    var expanded = !!state.pointsExpanded[toggleKey];
    var tags = [];
    if (player.isTaxi) tags.push('<span class="rwb-tag is-taxi">Taxi</span>');
    if (player.isIr) tags.push('<span class="rwb-tag is-ir">IR</span>');
    var detailRow = expanded
      ? (
          '<tr class="rwb-points-detail-row">' +
            '<td colspan="7">' + pointsHistoryDetailHtml(team, player, summary) + '</td>' +
          '</tr>'
        )
      : "";

    return (
      '<tr class="rwb-player-row' + (player.isTaxi ? ' rwb-player-row-taxi' : '') + (player.isIr ? ' rwb-player-row-ir' : '') + '">' +
        '<td>' +
          '<div class="rwb-player-name-wrap">' +
            '<div class="rwb-player-line">' +
              '<button type="button" class="rwb-player-open" data-action="open-player-modal" data-player-id="' + escapeHtml(player.id) + '" data-franchise-id="' + escapeHtml(player.fid) + '"><span class="rwb-player-name">' + escapeHtml(player.name) + '</span></button>' +
              tags.join("") +
            '</div>' +
            '<div class="rwb-points-player-sub">' + escapeHtml(player.position + " | " + (player.nflTeam || "-")) + '</div>' +
          '</div>' +
        '</td>' +
        '<td><span class="rwb-pos-pill">' + escapeHtml(safeStr(player.positionGroup)) + '</span></td>' +
        '<td class="rwb-cell-num">' + escapeHtml(summary.hasData ? formatPoints(summary.points) : "—") + '</td>' +
        '<td class="rwb-cell-num">' + escapeHtml(summary.hasData ? formatPpg(summary.ppg, state.pointsHistoryMode === "weekly" ? summary.appearances : summary.games) : "—") + '</td>' +
        '<td class="rwb-cell-num">' + escapeHtml(formatRank(summary.bestRank)) + '</td>' +
        '<td class="rwb-cell-num">' + escapeHtml(state.pointsHistoryMode === "weekly" ? String(safeInt(summary.starts, 0)) : formatRank(summary.bestPpgRank)) + '</td>' +
        '<td><button type="button" class="rwb-row-action" data-action="points-toggle" data-franchise-id="' + escapeHtml(team.id) + '" data-player-id="' + escapeHtml(player.id) + '">' + (expanded ? "Hide" : "History") + '</button></td>' +
      '</tr>' +
      detailRow
    );
  }

  function pointsTeamCardHtml(team, filteredPlayers) {
    var logo = safeStr(team.logo);
    var rows = [];
    var summary = summarizeTeamPointsSelection(filteredPlayers);
    var sortedPlayers = sortPlayersForPoints(filteredPlayers);

    for (var i = 0; i < sortedPlayers.length; i += 1) {
      rows.push(pointsPlayerRowHtml(team, sortedPlayers[i]));
    }

    return (
      '<article class="rwb-team-card rwb-points-team-card" id="rwb-team-' + escapeHtml(team.id) + '" data-team-id="' + escapeHtml(team.id) + '">' +
        '<header class="rwb-team-head rwb-points-team-head">' +
          '<div class="rwb-points-team-brand">' +
            (logo
              ? '<img class="rwb-franchise-icon" src="' + escapeHtml(logo) + '" alt="' + escapeHtml(team.name) + ' logo">'
              : '<span class="rwb-franchise-icon rwb-franchise-icon-fallback">' + escapeHtml(team.fid) + '</span>') +
            '<div class="rwb-points-team-copy">' +
              '<div class="rwb-points-team-name">' + escapeHtml(team.name) + '</div>' +
              '<div class="rwb-points-team-range">' + escapeHtml(currentPointsRangeLabel()) + '</div>' +
            '</div>' +
          '</div>' +
          '<div class="rwb-chip-row">' +
            '<span class="rwb-chip"><span class="rwb-chip-label">Shown</span><span class="rwb-chip-value">' + escapeHtml(String(summary.shown)) + '</span></span>' +
            '<span class="rwb-chip"><span class="rwb-chip-label">With Data</span><span class="rwb-chip-value">' + escapeHtml(String(summary.withData)) + '</span></span>' +
            '<span class="rwb-chip"><span class="rwb-chip-label">Range Pts</span><span class="rwb-chip-value">' + escapeHtml(formatPoints(summary.totalPoints)) + '</span></span>' +
            (state.pointsHistoryMode === "weekly"
              ? '<span class="rwb-chip"><span class="rwb-chip-label">Starts</span><span class="rwb-chip-value">' + escapeHtml(String(summary.totalStarts)) + '</span></span>'
              : '') +
          '</div>' +
        '</header>' +
        '<div class="rwb-team-body">' +
          '<div class="rwb-table-wrap">' +
            '<table class="rwb-table rwb-points-table" aria-label="' + escapeHtml(team.name + ' points view') + '">' +
              '<thead>' +
                '<tr>' +
                  sortableHeader("points", "player", "Player") +
                  sortableHeader("points", "position", "Pos") +
                  sortableHeader("points", "points", "Pts") +
                  sortableHeader("points", "ppg", state.pointsHistoryMode === "weekly" ? "Avg" : "PPG") +
                  sortableHeader("points", "rank", "Best Rk") +
                  sortableHeader("points", state.pointsHistoryMode === "weekly" ? "starts" : "ppg_rank", state.pointsHistoryMode === "weekly" ? "Starts" : "Best PPG Rk") +
                  '<th>History</th>' +
                '</tr>' +
              '</thead>' +
              '<tbody>' + rows.join("") + '</tbody>' +
            '</table>' +
          '</div>' +
        '</div>' +
      '</article>'
    );
  }

  function teamCardHtml(team) {
    var filtered = filteredPlayersForTeam(team);

    var bodyHtml;
    if (state.view === "contract") {
      bodyHtml = contractBodyHtml(team, filtered);
    } else {
      var grouped = groupByPosition(filtered);
      if (!grouped.length) bodyHtml = '<div class="rwb-empty">No players match the current filters for this team.</div>';
      else {
        var blocks = [];
        for (var g = 0; g < grouped.length; g += 1) {
          blocks.push(rosterGroupHtml(team, grouped[g]));
        }
        bodyHtml = blocks.join("");
      }
    }

    return (
      '<article class="rwb-team-card" id="rwb-team-' + escapeHtml(team.id) + '" data-team-id="' + escapeHtml(team.id) + '">' +
        teamHeaderHtml(team, filtered) +
        '<div class="rwb-team-body">' + bodyHtml + '</div>' +
      '</article>'
    );
  }

  function summarizeContractLeague() {
    if (state.view !== "contract") return "";

    var years = [currentYearInt(), currentYearInt() + 1, currentYearInt() + 2];
    var nonTaxiPlayers = 0;
    var nonTaxiTotals = [0, 0, 0];
    var taxiPlayers = 0;
    var taxiTotals = [0, 0, 0];
    var salaryAdjTotal = 0;

    for (var t = 0; t < state.teams.length; t += 1) {
      var players = state.teams[t].players || [];
      salaryAdjTotal += safeInt(state.teams[t].summary && state.teams[t].summary.salaryAdjustmentTotal, 0);
      for (var p = 0; p < players.length; p += 1) {
        var player = players[p];
        if (!matchesFilters(player)) continue;
        var proj = [displayedSalaryForPlan(player, 0), displayedSalaryForPlan(player, 1), displayedSalaryForPlan(player, 2)];
        if (player.isTaxi) {
          taxiPlayers += 1;
          taxiTotals[0] += proj[0];
          taxiTotals[1] += proj[1];
          taxiTotals[2] += proj[2];
        } else {
          if (proj[0] > 0 || proj[1] > 0 || proj[2] > 0) nonTaxiPlayers += 1;
          nonTaxiTotals[0] += proj[0];
          nonTaxiTotals[1] += proj[1];
          nonTaxiTotals[2] += proj[2];
        }
      }
    }

    return (
      '<article class="rwb-team-card rwb-contract-summary-league">' +
        '<div class="rwb-table-wrap">' +
          '<table class="rwb-table rwb-contract-table rwb-contract-summary-table" aria-label="League plan summary">' +
            '<thead>' +
              '<tr>' +
                '<th>League Summary</th>' +
                '<th>AAV</th>' +
                '<th>Players</th>' +
                '<th>' + escapeHtml(String(years[0])) + '</th>' +
                '<th>' + escapeHtml(String(years[1])) + '</th>' +
                '<th>' + escapeHtml(String(years[2])) + '</th>' +
                '<th colspan="2">Notes</th>' +
              '</tr>' +
            '</thead>' +
            '<tbody>' +
              '<tr class="rwb-summary-row rwb-summary-row-primary">' +
                '<th>Non-Taxi</th>' +
                '<th>—</th>' +
                '<th>' + escapeHtml(String(nonTaxiPlayers)) + ' players</th>' +
                '<th class="rwb-cell-num">' + escapeHtml(money(nonTaxiTotals[0])) + '</th>' +
                '<th class="rwb-cell-num">' + escapeHtml(money(nonTaxiTotals[1])) + '</th>' +
                '<th class="rwb-cell-num">' + escapeHtml(money(nonTaxiTotals[2])) + '</th>' +
                '<th colspan="2">Salary shown. Cap summaries remain team-level.</th>' +
              '</tr>' +
              '<tr class="rwb-summary-row rwb-summary-row-taxi">' +
                '<th>Taxi</th>' +
                '<th>—</th>' +
                '<th>' + escapeHtml(String(taxiPlayers)) + ' players</th>' +
                '<th class="rwb-cell-num">' + escapeHtml(money(taxiTotals[0])) + '</th>' +
                '<th class="rwb-cell-num">' + escapeHtml(money(taxiTotals[1])) + '</th>' +
                '<th class="rwb-cell-num">' + escapeHtml(money(taxiTotals[2])) + '</th>' +
                '<th colspan="2">Shown separately from cap totals</th>' +
              '</tr>' +
              (salaryAdjTotal !== 0
                ? '<tr class="rwb-summary-row rwb-summary-row-adjustment">' +
                    '<th>Salary Adj.</th>' +
                    '<th>—</th>' +
                    '<th>Current season</th>' +
                    '<th class="rwb-cell-num">' + escapeHtml(money(salaryAdjTotal)) + '</th>' +
                    '<th class="rwb-cell-num">' + escapeHtml(money(0)) + '</th>' +
                    '<th class="rwb-cell-num">' + escapeHtml(money(0)) + '</th>' +
                    '<th colspan="2">League-wide adjustments</th>' +
                  '</tr>'
                : '') +
            '</tbody>' +
          '</table>' +
        '</div>' +
      '</article>'
    );
  }

  function renderTeams() {
    if (!els.teamList) return;

     if (state.view === "points") {
      if (state.pointsHistoryLoading && !state.pointsHistory) {
        els.teamList.innerHTML = '<div class="rwb-loading">Loading stored points history...</div>';
        renderToolbarNote(0, 0);
        renderPlayerActionModal();
        return;
      }
      if (state.pointsHistoryError && !state.pointsHistory) {
        els.teamList.innerHTML = '<div class="rwb-error">' + escapeHtml(state.pointsHistoryError) + '</div>';
        renderToolbarNote(0, 0);
        renderPlayerActionModal();
        return;
      }
      ensurePointsHistorySelection();
    }

    var totalPlayers = 0;
    var visiblePlayers = 0;
    var html = [];
    var visibleTeams = [];

    for (var i = 0; i < state.teams.length; i += 1) {
      var team = state.teams[i] || {};
      totalPlayers += (team.players || []).length;
      var filteredPlayers = filteredPlayersForTeam(team);
      visiblePlayers += filteredPlayers.length;
      if (!filteredPlayers.length) continue;
      visibleTeams.push({
        team: team,
        filteredPlayers: filteredPlayers
      });
      if (state.view === "points") {
        html.push(pointsTeamCardHtml(team, filteredPlayers));
      } else if (state.view !== "franchise") {
        html.push(teamCardHtml(team));
      }
    }

    if (state.view === "contract" && visibleTeams.length) {
      html.push(summarizeContractLeague());
    } else if (state.view === "franchise" && visibleTeams.length) {
      html.push(franchiseSummaryHtml(visibleTeams));
    }

    if (!html.length) {
      els.teamList.innerHTML = '<div class="rwb-empty">No players match the current filters.</div>';
    } else {
      els.teamList.innerHTML = html.join("");
    }

    renderToolbarNote(visiblePlayers, totalPlayers);
    renderPlayerActionModal();
  }

  function collectExportRows() {
    var rows = [];
    var baseYear = currentYearInt();
    for (var i = 0; i < state.teams.length; i += 1) {
      var team = state.teams[i] || {};
      var players = team.players || [];
      for (var j = 0; j < players.length; j += 1) {
        var p = players[j] || {};
        var proj = projectSalaryByYear(p, 3);
        rows.push({
          team_id: team.id,
          team_name: team.name,
          player_id: p.id,
          player_name: p.name,
          position: p.position,
          position_group: p.positionGroup,
          points_mode: state.pointsMode,
          points_value: pointsForPlayer(p),
          salary: p.salary,
          years: p.years,
          year_1: proj[0],
          year_2: proj[1],
          year_3: proj[2],
          salary_year_1_label: String(baseYear),
          salary_year_2_label: String(baseYear + 1),
          salary_year_3_label: String(baseYear + 2),
          contract_type: p.type,
          contract_bucket: contractBucket(p.type),
          special: p.special,
          status: p.status,
          taxi: p.isTaxi ? "Y" : "N"
        });
      }
    }
    return rows;
  }

  function csvEscape(v) {
    var s = safeStr(v);
    if (!/[",\n]/.test(s)) return s;
    return '"' + s.replace(/"/g, '""') + '"';
  }

  function toCsv(rows) {
    var cols = [
      "team_id",
      "team_name",
      "player_id",
      "player_name",
      "position",
      "position_group",
      "points_mode",
      "points_value",
      "salary",
      "years",
      "salary_year_1_label",
      "salary_year_2_label",
      "salary_year_3_label",
      "year_1",
      "year_2",
      "year_3",
      "contract_type",
      "contract_bucket",
      "special",
      "status",
      "taxi"
    ];
    var lines = [cols.join(",")];
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i] || {};
      lines.push(cols.map(function (col) { return csvEscape(row[col]); }).join(","));
    }
    return lines.join("\n");
  }

  function download(filename, text, mime) {
    var blob = new Blob([text], { type: mime || "text/plain;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      if (a.parentNode) a.parentNode.removeChild(a);
    }, 0);
  }

  function persistState() {
    writeStorage("search", state.search);
    writeStorage("filterPosition", state.filterPosition);
    writeStorage("filterType", state.filterType);
    writeStorage("filterRosterStatus", state.filterRosterStatus);
    writeStorage("taxiOnly", state.filterRosterStatus === "taxi");
    writeStorage("contractPreview", state.contractPreview);
    writeStorage("view", state.view);
    writeStorage("pointsMode", state.pointsMode);
    writeStorage("pointsHistoryMode", state.pointsHistoryMode);
    writeStorage("pointsHistoryYearStart", state.pointsHistoryYearStart);
    writeStorage("pointsHistoryYearEnd", state.pointsHistoryYearEnd);
    writeStorage("pointsHistorySeason", state.pointsHistorySeason);
    writeStorage("pointsHistoryWeekStart", state.pointsHistoryWeekStart);
    writeStorage("pointsHistoryWeekEnd", state.pointsHistoryWeekEnd);
    writeStorage("pointsExpanded", state.pointsExpanded);
    writeStorage("sorts", state.sorts);
  }

  function restoreState() {
    state.search = safeStr(readStorage("search", "")).toLowerCase();
    state.filterPosition = safeStr(readStorage("filterPosition", "")).toUpperCase();
    state.filterType = normType(readStorage("filterType", ""));
    state.filterRosterStatus = normRosterStatusFilter(readStorage("filterRosterStatus", ""));
    if (!state.filterRosterStatus && !!readStorage("taxiOnly", false)) {
      state.filterRosterStatus = "taxi";
    }
    state.contractPreview = readStorage("contractPreview", {}) || {};
    state.sorts = readStorage("sorts", state.sorts) || state.sorts;
    var storedView = safeStr(readStorage("view", "roster"));
    state.view = storedView === "contract" || storedView === "franchise" || storedView === "points" ? storedView : "roster";
    state.pointsMode = safeStr(readStorage("pointsMode", ""));
    state.pointsHistoryMode = safeStr(readStorage("pointsHistoryMode", "yearly"));
    state.pointsHistoryYearStart = safeStr(readStorage("pointsHistoryYearStart", ""));
    state.pointsHistoryYearEnd = safeStr(readStorage("pointsHistoryYearEnd", ""));
    state.pointsHistorySeason = safeStr(readStorage("pointsHistorySeason", ""));
    state.pointsHistoryWeekStart = safeStr(readStorage("pointsHistoryWeekStart", ""));
    state.pointsHistoryWeekEnd = safeStr(readStorage("pointsHistoryWeekEnd", ""));
    state.pointsExpanded = readStorage("pointsExpanded", {}) || {};

    if (["", "rookie", "loaded", "other"].indexOf(state.filterType) === -1) {
      state.filterType = "";
    }
    state.filterRosterStatus = normRosterStatusFilter(state.filterRosterStatus);
    if (!state.sorts || typeof state.sorts !== "object") {
      state.sorts = {
        roster: { key: "name", dir: "asc" },
        contract: { key: "player", dir: "asc" },
        franchise: { key: "franchise", dir: "asc" },
        points: { key: "points", dir: "desc" }
      };
    }
  }

  function jumpToTeam(teamId) {
    if (!teamId) return;
    requestAnimationFrame(function () {
      var node = document.getElementById("rwb-team-" + teamId);
      if (!node) return;
      if (node.scrollIntoView) node.scrollIntoView({ behavior: "smooth", block: "start" });
      node.classList.add("rwb-jump-flash");
      setTimeout(function () {
        node.classList.remove("rwb-jump-flash");
      }, 1200);
    });
  }

  function setFlash(type, text) {
    if (!safeStr(text)) {
      state.flash = null;
    } else {
      state.flash = { type: type === "error" ? "error" : "success", text: safeStr(text) };
    }
    renderToolbar();
  }

  function fetchJsonPost(url, payload) {
    return fetch(url, {
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {})
    }).then(function (res) {
      return res.text().then(function (text) {
        var json = {};
        try {
          json = text ? JSON.parse(text) : {};
        } catch (e) {
          json = {};
        }
        if (!res.ok || !json || json.ok !== true) {
          throw new Error(safeStr((json && (json.error || json.reason)) || text || ("HTTP " + res.status)));
        }
        return json;
      });
    });
  }

  function parseMutationResult(text) {
    try {
      var out = text ? JSON.parse(text) : {};
      var details = out && typeof out.details === "object" && out.details ? out.details : {};
      return {
        raw: out || {},
        status: safeStr(out && out.status).toLowerCase(),
        submissionId: safeStr(out && out.submission_id),
        details: details
      };
    } catch (e) {
      return { raw: {}, status: "", submissionId: "", details: {} };
    }
  }

  function isContractMutationSuccessStatus(status) {
    return status === "import_ok_log_dispatched" || status === "import_ok_log_failed";
  }

  function contractMutationErrorMessage(status, details, fallbackText, httpStatus) {
    var reason = safeStr(details && details.reason);
    var upstreamPreview = safeStr(details && details.upstreamPreview).slice(0, 280);
    if (status === "validation_fail") return reason || "Validation failed.";
    if (status === "import_rejected") return reason || upstreamPreview || "MFL import rejected request.";
    if (status === "import_no_change") return reason || "No contract change detected after import.";
    if (status === "verify_unavailable") {
      return reason || "Import submitted but verification export was unavailable.";
    }
    if (reason) return reason;
    if (upstreamPreview) return upstreamPreview;
    if (fallbackText) return safeStr(fallbackText).slice(0, 280);
    return "Request failed (HTTP " + String(httpStatus || 0) + ")";
  }

  function postContractUpdate(url, payload) {
    function readResult(res) {
      return res.text().then(function (text) {
        var parsed = parseMutationResult(text);
        if (!res.ok || !isContractMutationSuccessStatus(parsed.status)) {
          throw new Error(contractMutationErrorMessage(parsed.status, parsed.details, text, res.status));
        }
        return parsed;
      });
    }

    return fetch(url, {
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {})
    }).then(function (res) {
      if (res.ok) return readResult(res);

      var form = new URLSearchParams();
      var body = payload || {};
      var keys = Object.keys(body);
      for (var i = 0; i < keys.length; i += 1) {
        var key = keys[i];
        if (body[key] == null) continue;
        form.set(key, String(body[key]));
      }
      return fetch(url, {
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: form.toString()
      }).then(readResult);
    });
  }

  function clearContractPreviewForPlayer(player) {
    if (!player) return;
    delete state.contractPreview[contractPreviewKey(player)];
  }

  function refreshData(noCache) {
    setFlash("", "");
    state.gamesLoadedByYear = Object.create(null);
    state.gamesLoadingByYear = Object.create(null);
    if (els.teamList) {
      els.teamList.innerHTML = '<div class="rwb-loading">Refreshing roster data...</div>';
    }
    return loadData(state.ctx, { noCache: !!noCache })
      .then(function (result) {
        state.teams = sortTeamsForDisplay(result.teams || []);
        state.salaryCapAmount = safeInt(result.leagueMeta && result.leagueMeta.capAmount, 0);
        state.pointYears = (result.pointYears && result.pointYears.length)
          ? result.pointYears.slice()
          : buildPointYears();
        var allowedPointModes = state.pointYears.concat(["cumulative"]);
        if (allowedPointModes.indexOf(state.pointsMode) === -1) {
          state.pointsMode = state.pointYears[0] || String(currentYearInt());
        }
        renderToolbar();
        renderTeams();
        ensureGamesLoadedForCurrentMode();
        if (state.view === "points") {
          loadPointsHistory().then(function () {
            return ensureLiveSeasonPointsForSelection(false);
          }).catch(function () {});
        }
        persistState();
        return result;
      });
  }

  function submitRosterMove(move, playerId, franchiseId, playerName, options) {
    options = options || {};
    var moveKey = move === "activate_ir" ? "ir:" + playerId : (move === "drop_player" ? "drop:" + playerId : "taxi:" + playerId);
    var verb = move === "activate_ir"
      ? "activate from IR"
      : (move === "drop_player" ? "drop" : "promote from taxi");
    var penaltyText = "";
    if (move === "drop_player" && options.dropPenalty) {
      penaltyText = "\n\nEstimated cap penalty: " + money(options.dropPenalty.amount) + "\n" + safeStr(options.dropPenalty.note);
    }
    if (!window.confirm("Confirm " + verb + " for " + safeStr(playerName) + "?" + penaltyText)) return;

    state.busyActionKey = moveKey;
    setFlash("success", "Submitting " + safeStr(playerName) + " to MFL...");
    if (options.closeModal !== false) closePlayerActionModal();
    renderTeams();

    return fetchJsonPost(resolveWorkerActionEndpoint(), {
      action: move,
      league_id: state.ctx && state.ctx.leagueId,
      season: state.ctx && state.ctx.year,
      franchise_id: franchiseId,
      player_id: playerId
    }).then(function (payload) {
      state.busyActionKey = "";
      return refreshData(true).then(function () {
        setFlash("success", safeStr(payload && payload.message) || (safeStr(playerName) + " updated in MFL."));
      });
    }).catch(function (err) {
      state.busyActionKey = "";
      renderTeams();
      setFlash("error", "Roster move failed: " + summarizeError(err));
    });
  }

  function submitExtensionUpdate(player, option) {
    if (!player || !option) return Promise.resolve(null);

    var confirmText = "Confirm " + extensionActionLabel(option).toLowerCase() + " for " + safeStr(player.name) + "?";
    var optionSummary = extensionOptionSummary(option);
    var contractInfoText = inlineContractInfoText(option.contractInfo);
    if (optionSummary) confirmText += "\n\n" + optionSummary;
    if (contractInfoText) confirmText += "\n" + contractInfoText;
    if (!window.confirm(confirmText)) return Promise.resolve(null);

    var leagueId = safeStr(state.ctx && state.ctx.leagueId);
    var season = safeStr(state.ctx && state.ctx.year);
    var moveKey = "extend:" + safeStr(player.id) + ":" + safeStr(option.optionKey);
    var payload = {
      L: leagueId,
      YEAR: season,
      type: "MANUAL_CONTRACT_UPDATE",
      leagueId: leagueId,
      year: season,
      player_id: safeStr(player.id),
      player_name: safeStr(player.name),
      franchise_id: safeStr(player.fid),
      franchise_name: safeStr(player.teamName),
      position: safeStr(player.positionGroup || player.position),
      salary: safeInt(option.salaryToSend, 0),
      contract_year: safeInt(option.contractLength, 0),
      contract_status: safeStr(option.contractStatus),
      contract_info: safeStr(option.contractInfo),
      submitted_at_utc: new Date().toISOString()
    };
    var url = resolveWorkerContractUpdateEndpoint() +
      "?L=" + encodeURIComponent(leagueId) +
      "&YEAR=" + encodeURIComponent(season);

    state.busyActionKey = moveKey;
    setFlash("success", "Submitting extension for " + safeStr(player.name) + " to MFL...");
    closePlayerActionModal();
    renderTeams();

    return postContractUpdate(url, payload).then(function (result) {
      state.busyActionKey = "";
      clearContractPreviewForPlayer(player);
      persistState();
      return refreshData(true).then(function () {
        setFlash("success", safeStr(result && result.details && result.details.reason) || (safeStr(player.name) + " extension submitted to MFL."));
      });
    }).catch(function (err) {
      state.busyActionKey = "";
      renderTeams();
      setFlash("error", "Extension failed: " + summarizeError(err));
    });
  }

  function onClick(evt) {
    var target = evt.target;
    if (!target || !target.closest) return;

    var closeModalBtn = target.closest("[data-action='close-player-modal']");
    if (closeModalBtn) {
      closePlayerActionModal();
      return;
    }

    var rowMore = target.closest("[data-action='row-more']");
    if (rowMore) {
      var row = rowMore.closest("tr.rwb-player-row");
      if (!row) return;
      var expanded = row.classList.contains("is-expanded");
      row.classList.toggle("is-expanded", !expanded);
      rowMore.setAttribute("aria-expanded", expanded ? "false" : "true");
      rowMore.textContent = expanded ? "More" : "Less";
      return;
    }

    var viewBtn = target.closest("[data-action='view-switch']");
    if (viewBtn) {
      var nextView = safeStr(viewBtn.getAttribute("data-view"));
      if (nextView !== "contract" && nextView !== "roster" && nextView !== "franchise" && nextView !== "points") return;
      if (state.view !== nextView) {
        state.view = nextView;
        persistState();
        renderToolbar();
        renderTeams();
        if (state.view === "points") {
          loadPointsHistory().then(function () {
            return ensureLiveSeasonPointsForSelection(false);
          }).catch(function () {});
        }
      }
      return;
    }

    var pointsToggleBtn = target.closest("[data-action='points-toggle']");
    if (pointsToggleBtn) {
      var pointsTeam = findTeamById(pointsToggleBtn.getAttribute("data-franchise-id"));
      var pointsPlayerId = safeStr(pointsToggleBtn.getAttribute("data-player-id"));
      if (!pointsTeam || !pointsPlayerId) return;
      var toggleKey = pointsHistoryToggleKey(pointsTeam, { id: pointsPlayerId });
      state.pointsExpanded[toggleKey] = !state.pointsExpanded[toggleKey];
      persistState();
      renderTeams();
      return;
    }

    var previewBtn = target.closest("[data-action='contract-preview']");
    if (previewBtn) {
      var previewPlayerId = safeStr(previewBtn.getAttribute("data-player-id"));
      var previewFranchiseId = pad4(previewBtn.getAttribute("data-franchise-id"));
      var previewYears = safeInt(previewBtn.getAttribute("data-years"), 0);
      if (!previewPlayerId || !previewFranchiseId || (previewYears !== 1 && previewYears !== 2)) return;
      var previewKey = previewFranchiseId + ":" + previewPlayerId;
      state.contractPreview[previewKey] = safeInt(state.contractPreview[previewKey], 0) === previewYears ? 0 : previewYears;
      persistState();
      renderTeams();
      return;
    }

    var sortHeaderBtn = target.closest("[data-action='sort-header']");
    if (sortHeaderBtn) {
      var sortView = safeStr(sortHeaderBtn.getAttribute("data-sort-view"));
      var sortKey = safeStr(sortHeaderBtn.getAttribute("data-sort-key"));
      if (!sortView || !sortKey) return;
      var sortState = sortStateForView(sortView);
      if (sortState.key === sortKey) {
        sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
      } else {
        sortState.key = sortKey;
        sortState.dir = sortView === "franchise" ? "asc" : "desc";
        if (
          sortKey === "name" ||
          sortKey === "player" ||
          sortKey === "franchise" ||
          sortKey === "bye" ||
          sortKey === "type" ||
          sortKey === "special" ||
          sortKey === "expires" ||
          sortKey === "position" ||
          sortKey === "rank" ||
          sortKey === "ppg_rank"
        ) {
          sortState.dir = "asc";
        }
      }
      persistState();
      renderTeams();
      return;
    }

    var openPlayerBtn = target.closest("[data-action='open-player-modal']");
    if (openPlayerBtn) {
      openPlayerActionModal(
        pad4(openPlayerBtn.getAttribute("data-franchise-id")),
        safeStr(openPlayerBtn.getAttribute("data-player-id"))
      );
      return;
    }

    var tradePlayerBtn = target.closest("[data-action='trade-player']");
    if (tradePlayerBtn) {
      var tradeRecord = findPlayerRecord(
        pad4(tradePlayerBtn.getAttribute("data-franchise-id")),
        safeStr(tradePlayerBtn.getAttribute("data-player-id"))
      );
      if (!tradeRecord || !tradeRecord.player) return;
      window.location.href = buildTradeModuleUrl(tradeRecord.player);
      return;
    }

    var extensionBtn = target.closest("[data-action='extend-player']");
    if (extensionBtn) {
      if (state.busyActionKey) return;
      var extensionRecord = findPlayerRecord(
        pad4(extensionBtn.getAttribute("data-franchise-id")),
        safeStr(extensionBtn.getAttribute("data-player-id"))
      );
      if (!extensionRecord || !extensionRecord.player || !isOwnRosterPlayer(extensionRecord.player)) return;
      var extensionOptionKeyValue = safeStr(extensionBtn.getAttribute("data-option-key"));
      var extensionOptions = playerExtensionOptions(extensionRecord.player);
      var selectedOption = null;
      for (var i = 0; i < extensionOptions.length; i += 1) {
        if (safeStr(extensionOptions[i] && extensionOptions[i].optionKey) === extensionOptionKeyValue) {
          selectedOption = extensionOptions[i];
          break;
        }
      }
      if (!selectedOption) {
        setFlash("error", "Extension preview could not be resolved for this player.");
        return;
      }
      submitExtensionUpdate(extensionRecord.player, selectedOption);
      return;
    }

    var rosterMoveBtn = target.closest("[data-action='activate-ir-player'],[data-action='promote-taxi-player'],[data-action='drop-player']");
    if (rosterMoveBtn) {
      if (state.busyActionKey) return;
      var actionName = safeStr(rosterMoveBtn.getAttribute("data-action"));
      var playerRecord = findPlayerRecord(
        pad4(rosterMoveBtn.getAttribute("data-franchise-id")),
        safeStr(rosterMoveBtn.getAttribute("data-player-id"))
      );
      if (!playerRecord || !playerRecord.player) return;
      var move = actionName === "activate-ir-player"
        ? "activate_ir"
        : (actionName === "promote-taxi-player" ? "promote_taxi" : "drop_player");
      submitRosterMove(
        move,
        playerRecord.player.id,
        playerRecord.player.fid,
        playerRecord.player.name,
        {
          closeModal: true,
          dropPenalty: move === "drop_player" ? dropPenaltyEstimate(playerRecord.player) : null
        }
      );
      return;
    }

    if (target === els.resetFilters) {
      state.search = "";
      state.filterPosition = "";
      state.filterType = "";
      state.filterRosterStatus = "";
      if (els.search) els.search.value = "";
      persistState();
      renderToolbar();
      renderTeams();
      return;
    }
  }

  function onChange(evt) {
    var el = evt.target;
    if (!el) return;
    var elId = safeStr(el.id);

    if (el === els.filterPosition) {
      state.filterPosition = safeStr(el.value).toUpperCase();
      persistState();
      renderTeams();
      return;
    }

    if (el === els.filterType) {
      state.filterType = normType(el.value);
      persistState();
      renderTeams();
      return;
    }

    if (el === els.filterRosterStatus) {
      state.filterRosterStatus = normRosterStatusFilter(el.value);
      persistState();
      renderTeams();
      return;
    }

    if (el === els.jumpTeam) {
      var teamId = safeStr(el.value);
      if (!teamId) return;
      jumpToTeam(teamId);
      return;
    }

    if (el === els.pointsMode) {
      var nextMode = safeStr(el.value);
      if (!nextMode) return;
      state.pointsMode = nextMode;
      persistState();
      renderTeams();
      ensureGamesLoadedForCurrentMode();
      return;
    }

    if (elId === "rwbPointsHistoryMode") {
      state.pointsHistoryMode = safeStr(el.value) === "weekly" ? "weekly" : "yearly";
      ensurePointsHistorySelection();
      persistState();
      renderToolbar();
      renderTeams();
      ensureLiveSeasonPointsForSelection(false);
      return;
    }

    if (elId === "rwbPointsHistoryYearStart") {
      state.pointsHistoryYearStart = safeStr(el.value);
      ensurePointsHistorySelection();
      persistState();
      renderToolbar();
      renderTeams();
      ensureLiveSeasonPointsForSelection(false);
      return;
    }

    if (elId === "rwbPointsHistoryYearEnd") {
      state.pointsHistoryYearEnd = safeStr(el.value);
      ensurePointsHistorySelection();
      persistState();
      renderToolbar();
      renderTeams();
      ensureLiveSeasonPointsForSelection(false);
      return;
    }

    if (elId === "rwbPointsHistorySeason") {
      state.pointsHistorySeason = safeStr(el.value);
      ensurePointsHistorySelection();
      persistState();
      renderToolbar();
      renderTeams();
      ensureLiveSeasonPointsForSelection(false);
      return;
    }

    if (elId === "rwbPointsHistoryWeekStart") {
      state.pointsHistoryWeekStart = safeStr(el.value);
      ensurePointsHistorySelection();
      persistState();
      renderToolbar();
      renderTeams();
      ensureLiveSeasonPointsForSelection(false);
      return;
    }

    if (elId === "rwbPointsHistoryWeekEnd") {
      state.pointsHistoryWeekEnd = safeStr(el.value);
      ensurePointsHistorySelection();
      persistState();
      renderToolbar();
      renderTeams();
      ensureLiveSeasonPointsForSelection(false);
    }
  }

  function onInput(evt) {
    var el = evt.target;
    if (!el) return;
    if (el === els.search) {
      state.search = safeStr(el.value || "").toLowerCase();
      persistState();
      renderTeams();
    }
  }

  function bindEvents() {
    if (attached || !els.app) return;
    attached = true;

    els.app.addEventListener("click", onClick, true);
    els.app.addEventListener("change", onChange, true);
    els.app.addEventListener("input", onInput, true);

    window.addEventListener("resize", function () {
      renderToolbar();
    });
    window.addEventListener("keydown", function (evt) {
      if (evt && evt.key === "Escape" && state.actionModal.open) {
        closePlayerActionModal();
      }
    });
  }

  function fetchByesWithFallback(ctx) {
    var year = safeInt(ctx.year, new Date().getFullYear());
    var years = [String(year), String(year - 1)];

    function attempt(idx) {
      if (idx >= years.length) return Promise.resolve({ year: String(year), map: Object.create(null) });

      var y = years[idx];
      var url = new URL("https://api.myfantasyleague.com/" + encodeURIComponent(y) + "/export");
      url.searchParams.set("TYPE", "nflByeWeeks");
      url.searchParams.set("JSON", "1");
      var apiKey = resolveApiKey();
      if (apiKey) url.searchParams.set("APIKEY", apiKey);

      return fetchJson(url.toString()).then(function (payload) {
        var map = toByeMap(payload);
        var hasAny = Object.keys(map).some(function (team) {
          return !!safeStr(map[team]);
        });
        if (hasAny) return { year: y, map: map };
        return attempt(idx + 1);
      }).catch(function () {
        return attempt(idx + 1);
      });
    }

    return attempt(0);
  }

  function loadDataFromDirectExports(ctx) {
    var leagueUrl = buildExportUrl(ctx.hostOrigin, ctx.year, "league", { L: ctx.leagueId });
    var rostersUrl = buildExportUrl(ctx.hostOrigin, ctx.year, "rosters", { L: ctx.leagueId });
    var salariesUrl = buildExportUrl(ctx.hostOrigin, ctx.year, "salaries", { L: ctx.leagueId });
    var salaryAdjUrl = buildExportUrl(ctx.hostOrigin, ctx.year, "salaryAdjustments", { L: ctx.leagueId });
    var pointsUrl = buildApiExportUrl(ctx.year, "playerScores", { L: ctx.leagueId, W: "YTD" });

    var priorSeason = String(Math.max(0, safeInt(ctx.year, Number(ctx.year) || 0) - 1));
    var priorSalariesReq = priorSeason && priorSeason !== String(ctx.year)
      ? fetchJson(buildExportUrl(ctx.hostOrigin, priorSeason, "salaries", { L: ctx.leagueId })).catch(function () { return {}; })
      : Promise.resolve({});

    return Promise.all([
      fetchJson(leagueUrl),
      fetchJson(rostersUrl),
      fetchJson(salariesUrl).catch(function () { return {}; }),
      fetchJson(salaryAdjUrl).catch(function () { return {}; }),
      fetchJson(pointsUrl).catch(function () { return {}; }),
      fetchByesWithFallback(ctx),
      priorSalariesReq
    ]).then(function (parts) {
      var leaguePayload = parts[0] || {};
      var rostersPayload = parts[1] || {};
      var salariesPayload = parts[2] || {};
      var salaryAdjustPayload = parts[3] || {};
      var pointsPayload = parts[4] || {};
      var byeResult = parts[5] || { year: ctx.year, map: {} };
      var priorSalariesPayload = parts[6] || {};

      var playerIds = collectRosterPlayerIds(rostersPayload);
      return fetchPlayersMap(ctx.year, playerIds).then(function (playersMap) {
        var leagueMeta = parseLeagueMeta(leaguePayload);
        var salaryMap = toSalaryMap(salariesPayload);
        var priorSalaryMap = toSalaryMap(priorSalariesPayload);
        var salaryAdjustments = toSalaryAdjustmentMap(salaryAdjustPayload);
        var scores = toScoreMap(pointsPayload);

        var teams = buildTeams(
          rostersPayload,
          leagueMeta,
          playersMap,
          scores,
          byeResult.map || {},
          salaryMap,
          salaryAdjustments,
          priorSalaryMap
        );

        return {
          teams: teams,
          leagueMeta: leagueMeta,
          pointsYear: String(ctx.year)
        };
      });
    });
  }

  function loadDataFromWorkerApi(ctx, options) {
    var endpoint = resolveWorkerApiEndpoint();
    var url = new URL(endpoint, window.location.href);
    url.searchParams.set("L", String(ctx.leagueId));
    url.searchParams.set("YEAR", String(ctx.year));
    if (options && options.noCache) url.searchParams.set("NO_CACHE", "1");
    return fetchJson(url.toString(), { credentials: "omit", cache: "no-store" }).then(function (payload) {
      if (!payload || payload.ok !== true) {
        var errMsg = safeStr(payload && payload.error) || "Worker API returned an error payload";
        throw new Error(errMsg);
      }
      var teams = buildTeamsFromWorkerPayload(payload);
      if (!teams.length) throw new Error("Worker API returned no teams");
      return {
        teams: teams,
        leagueMeta: {
          capAmount: safeInt(payload.salary_cap_dollars, 0),
          franchises: Object.create(null)
        },
        pointsYear: safeStr(payload.points_year)
      };
    });
  }

  function summarizeError(err) {
    if (!err) return "unknown error";
    return safeStr(err.message || err) || "unknown error";
  }

  function loadData(ctx, options) {
    var baseLoader = useDirectMflMode()
      ? loadDataFromDirectExports(ctx)
      : loadDataFromWorkerApi(ctx, options).catch(function (workerErr) {
          return loadDataFromDirectExports(ctx).catch(function (directErr) {
            throw new Error(
              "Worker API failed (" + summarizeError(workerErr) + "). " +
              "Direct export fallback failed (" + summarizeError(directErr) + ")."
            );
          });
        });

    return baseLoader.then(function (result) {
      var teams = result.teams || [];
      ctx.pointsFallbackYear = safeStr(result && result.pointsYear);
      return loadExtensionPreviewFallbackRows(ctx && ctx.year).then(function (extRows) {
        mergeExtensionPreviewFallbackRows(teams, extRows);
        return hydrateTeamsWithPointsHistory(ctx, teams).then(function (years) {
          result.teams = teams;
          result.pointYears = years && years.length ? years : buildPointYears();
          return result;
        });
      });
    });
  }

  function renderError(message) {
    if (els.teamList) {
      els.teamList.innerHTML =
        '<div class="rwb-error">' +
          escapeHtml(message) +
          '<br><br>' +
          'If this persists, verify <code>window.UPS_RWB_API</code> points at your Worker <code>/roster-workbench</code> endpoint.' +
        '</div>';
    }
    if (els.note) els.note.textContent = message;
  }

  function init() {
    state.ctx = detectContext();
    state.viewerFranchiseId = pad4(state.ctx && state.ctx.franchiseId);

    if (!state.ctx.leagueId) {
      renderSkeleton();
      renderError("Rosters could not determine league id from this page URL.");
      return;
    }

    storagePrefix = "ups:rwb:" + state.ctx.leagueId + ":" + state.ctx.year;
    restoreState();

    renderSkeleton();
    // Ensure listeners bind to the current freshly-rendered app node.
    attached = false;
    bindEvents();

    refreshData(true)
      .catch(function (err) {
        var msg = "Unable to load roster data from API exports.";
        if (err && err.message) msg += " " + err.message;
        state.loadError = msg;
        renderError(msg);
      });
  }

  window.UPS_RWB_INIT = init;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
