(function () {
  "use strict";

  var BUILD = "2026.03.11.01";
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
  var CONTRACT_ACTION_FILTERS = [
    { value: "", label: "All Contract Options" },
    { value: "rookie_option", label: "Exercise Option" },
    { value: "extension", label: "Extension" },
    { value: "restructure", label: "Restructure" },
    { value: "untag", label: "Untag" }
  ];
  var ALL_TEAMS_VALUE = "__all__";
  var BYE_IMPACT_FILTERS = [
    { value: "", label: "All Impact" },
    { value: "heavy", label: "Heavy Only" },
    { value: "medium", label: "Medium Only" },
    { value: "light", label: "Light Only" }
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
  var TAG_EXCLUDED_PLAYER_IDS = { "14056": true };
  var TAG_EXCLUDED_NAME_MATCHES = {
    "kyler murray": true,
    "murray, kyler": true,
    "calamari": true
  };
  var LOCAL_TAG_SUBMISSIONS_KEY = "ccc_tag_submissions_v1";
  var TAG_OFFENSE_POS = {
    QB: 1,
    RB: 1,
    WR: 1,
    TE: 1
  };

  var state = {
    ctx: null,
    teams: [],
    viewerFranchiseId: "",
    viewerIsAdmin: false,
    viewerAdminReason: "",
    viewerAdminReady: false,
    viewerCommishFranchiseId: "",
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
    tagTrackingRows: null,
    tagTrackingMeta: null,
    tagExternalSubmissions: null,
    tagData: null,
    tagDataLoading: false,
    tagDataError: "",
    tagDataPromise: null,
    pointsWeeklyRankCacheKey: "",
    pointsWeeklyRankCache: null,
    pointsYearlyEliteRankCacheKey: "",
    pointsYearlyEliteRankCache: null,
    view: "roster",
    contractSubView: "players",
    tagSubView: "players",
    tagDisplayYear: "",
    selectedTeamId: "",
    filtersOpen: false,
    search: "",
    filterPosition: "",
    filterType: "",
    filterRosterStatus: "",
    filterContractAction: "",
    filterByeImpact: "",
    sorts: {
      roster: { key: "salary", dir: "desc" },
      contract: { key: "player", dir: "asc" },
      franchise: { key: "franchise", dir: "asc" },
      points: { key: "points", dir: "desc" }
    },
    contractPreview: {},
    actionModal: {
      open: false,
      playerId: "",
      franchiseId: "",
      mode: "actions",
      restructureYear1: "",
      restructureYear2: "",
      restructureBaseTcv: 0,
      restructureOriginalAav: 0,
      restructureYears: 2,
      restructureExtSuffix: ""
    },
    busyActionKey: "",
    rosterPointsSummaryCacheKey: "",
    rosterPointsSummaryByPlayer: Object.create(null),
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

  function normContractActionFilter(value) {
    var raw = safeStr(value).toLowerCase();
    if (raw === "rookie_option" || raw === "extension" || raw === "restructure" || raw === "untag") return raw;
    return "";
  }

  function contractActionFilterLabel(value) {
    var normalized = normContractActionFilter(value);
    if (!normalized) return "";
    for (var i = 0; i < CONTRACT_ACTION_FILTERS.length; i += 1) {
      if (CONTRACT_ACTION_FILTERS[i].value === normalized) return safeStr(CONTRACT_ACTION_FILTERS[i].label);
    }
    return "";
  }

  function normalizeTagSideValue(side) {
    var raw = safeStr(side).toUpperCase();
    if (raw === "OFFENSE" || raw === "OFF") return "OFFENSE";
    if (raw === "DEFENSE" || raw === "DEF" || raw === "IDP" || raw === "IDP_K") return "DEFENSE";
    return "";
  }

  function getTagSideFromPos(pos) {
    var key = safeStr(pos).toUpperCase();
    if (!key) return "";
    return TAG_OFFENSE_POS[key] ? "OFFENSE" : "DEFENSE";
  }

  function tagSideLabel(side) {
    var normalized = normalizeTagSideValue(side);
    if (normalized === "OFFENSE") return "Offense";
    if (normalized === "DEFENSE") return "Defense";
    return "—";
  }

  function normalizeCapPlanSubview(value) {
    return safeStr(value).toLowerCase() === "summary" ? "summary" : "players";
  }

  function normalizeTagSubview(value) {
    return safeStr(value).toLowerCase() === "breakdown" ? "breakdown" : "players";
  }

  function capPlanSummaryViewActive() {
    return state.view === "contract" && normalizeCapPlanSubview(state.contractSubView) === "summary";
  }

  function tagBreakdownActive() {
    return state.view === "tag" && normalizeTagSubview(state.tagSubView) === "breakdown";
  }

  function normByeImpactFilter(value) {
    var raw = safeStr(value).toLowerCase();
    if (raw === "heavy" || raw === "medium" || raw === "light") return raw;
    return "";
  }

  function byeImpactFilterLabel(value) {
    var normalized = normByeImpactFilter(value);
    if (normalized === "heavy") return "Heavy impact only";
    if (normalized === "medium") return "Medium impact only";
    if (normalized === "light") return "Light impact only";
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
    var segment = safeStr(match[1]).replace(/\bY\d+\s*-[^|]*$/i, "");
    return segment
      .split(/[\/,]/)
      .map(function (token) {
        var moneyMatch = safeStr(token).match(/-?\d+(?:\.\d+)?K?/i);
        return parseContractMoneyToken(moneyMatch ? moneyMatch[0] : "");
      })
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

  function parseContractLengthValue(contractInfo) {
    var info = safeStr(contractInfo);
    if (!info) return 0;
    var match = info.match(/(?:^|\|)\s*CL\s*:?\s*(\d+)/i);
    return match && safeStr(match[1]) ? Math.max(0, safeInt(match[1], 0)) : 0;
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

  function formatContractYearValuesSegment(yearValues) {
    var values = yearValues && typeof yearValues === "object" ? yearValues : null;
    if (!values) return "";
    var keys = Object.keys(values).map(function (key) {
      return safeInt(key, 0);
    }).filter(function (idx) {
      return idx > 0 && safeInt(values[idx], 0) > 0;
    }).sort(function (a, b) {
      return a - b;
    });
    if (!keys.length) return "";
    return keys.map(function (idx) {
      return "Y" + String(idx) + "-" + formatContractK(values[idx]);
    }).join(", ");
  }

  function appendContractInfoSegment(contractInfo, segment) {
    var info = safeStr(contractInfo).trim();
    var next = safeStr(segment).trim();
    if (!next) return info;
    if (!info) return next;
    return info + (/\|\s*$/.test(info) ? " " : "| ") + next;
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
    var nextInfo = info;
    var priorAavs = parseContractAavValues(priorInfo);
    if (priorAavs.length >= 1) {
      nextInfo = replaceContractInfoAavValue(nextInfo, priorAavs[priorAavs.length - 1]);
    } else {
      var priorAav = safeInt(
        prior.aav != null
          ? prior.aav
          : (prior.currentAav != null ? prior.currentAav : 0),
        0
      );
      if (priorAav > 0) {
        nextInfo = replaceContractInfoAavValue(nextInfo, priorAav);
      }
    }

    if (!Object.keys(parseContractYearValues(nextInfo)).length) {
      var priorYearSegment = formatContractYearValuesSegment(parseContractYearValues(priorInfo));
      if (priorYearSegment) nextInfo = appendContractInfoSegment(nextInfo, priorYearSegment);
    }

    return nextInfo;
  }

  function currentAavForContractInfo(contractInfo) {
    var values = parseContractAavValues(contractInfo);
    return values.length ? safeInt(values[0], 0) : 0;
  }

  function displayAavForPlayer(player) {
    var explicitAav = currentAavForContractInfo(player && player.special);
    if (explicitAav > 0) return explicitAav;
    if (player && player.isTaxi && safeInt(player.salary, 0) > 0) return safeInt(player.salary, 0);
    return Math.max(0, safeInt(player && player.aav, 0));
  }

  function rookieTaxiYearsRemainingFromDraftSeason(draftSeason, season) {
    var drafted = safeInt(draftSeason, 0);
    var current = safeInt(season, 0);
    if (drafted <= 0 || current <= 0) return 0;
    return Math.max(0, 3 - Math.max(0, current - drafted));
  }

  function standardRookieTaxiContractInfo(salary, contractLength) {
    var years = Math.max(1, safeInt(contractLength, 0) || 3);
    var currentSalary = Math.max(1000, roundToK(safeInt(salary, 0)));
    var yearParts = [];
    for (var i = 1; i <= years; i += 1) {
      yearParts.push("Y" + i + "-" + formatContractK(currentSalary));
    }
    return [
      "CL " + years,
      "TCV " + formatContractK(currentSalary * years),
      "AAV " + formatContractK(currentSalary),
      yearParts.join(", ")
    ].join("| ");
  }

  function repairTaxiContractFallbacks(teams, season) {
    var currentSeason = safeInt(season, 0);
    var list = asArray(teams);
    for (var i = 0; i < list.length; i += 1) {
      var players = list[i] && list[i].players ? list[i].players : [];
      for (var j = 0; j < players.length; j += 1) {
        var player = players[j];
        if (!player || !player.isTaxi) continue;

        var salary = Math.max(0, safeInt(player.salary, 0));
        if (salary > 0 && safeInt(player.aav, 0) <= 0) {
          player.aav = salary;
        }

        var special = safeStr(player.special);
        if (special && special !== "-") continue;

        var years = Math.max(0, safeInt(player.years, 0));
        if (years <= 0) {
          years = rookieTaxiYearsRemainingFromDraftSeason(player.originalDraftSeason, currentSeason);
        }
        if (years > 0) {
          player.years = years;
        }

        if (salary > 0) {
          player.special = standardRookieTaxiContractInfo(salary, 3);
        }

        if (!rookieLikeContractStatus(player.type)) {
          player.type = "Rookie";
        }
      }
    }
  }

  function rookieLikeContractStatus(value) {
    var status = safeStr(value).toLowerCase();
    return status === "r" || status.indexOf("r-") === 0 || status.indexOf("rookie") !== -1;
  }

  function rosterContractEligibility(player) {
    var years = Math.max(0, safeInt(player && player.years, 0));
    var salary = safeInt(player && player.salary, 0);
    var status = safeStr(player && player.type).toLowerCase();
    var info = safeStr(player && player.special).toLowerCase();
    var rookieOption = rookieOptionStateForPlayer(player);
    var noFurtherExt =
      info.indexOf("no further extensions") !== -1 ||
      info.indexOf("not eligible for tag or extension") !== -1;
    var expiredRookie =
      info.indexOf("expired rookie") !== -1 ||
      (rookieLikeContractStatus(status) && years <= 0);

    return {
      extensionEligible: !rookieOptionActionEligible(player) && (years === 1 || expiredRookie) && status.indexOf("tag") === -1 && !noFurtherExt,
      rookieOptionEligible: !!(rookieOption && rookieOption.eligible && !rookieOption.exercised),
      restructureEligible: years >= 2 && years <= 3 && salary > 1000 && !rookieLikeContractStatus(status)
    };
  }

  function parseRookieOptionToken(contractInfo) {
    var text = safeStr(contractInfo);
    var match = text.match(/(?:^|\|)\s*ROPT\s+([^|]+)/i);
    if (!match) return null;
    var blob = safeStr(match[1]);
    function parseK(label) {
      var m = blob.match(new RegExp("\\b" + label + "=([0-9]+(?:\\.[0-9]+)?)K\\b", "i"));
      return m ? Math.round(parseFloat(m[1]) * 1000) : 0;
    }
    var statusMatch = blob.match(/\bstatus=([a-z-]+)/i);
    var classMatch = blob.match(/\bclass=(\d{4})\b/i);
    var deadlineMatch = blob.match(/\bdeadline=(\d{4})\b/i);
    return {
      eligible: true,
      exercised: safeStr(statusMatch && statusMatch[1]).toLowerCase() === "exercised",
      classSeason: safeInt(classMatch && classMatch[1]),
      deadlineSeason: safeInt(deadlineMatch && deadlineMatch[1]),
      baseSalary: parseK("base"),
      optionYearSalary: parseK("option")
    };
  }

  function rookieOptionStateForPlayer(player) {
    if (!player) return null;
    if (player.rookieOptionEligible || player.rookie_option_eligible || player.rookieOptionExercised || player.rookie_option_exercised) {
      return {
        eligible: !!(player.rookieOptionEligible || player.rookie_option_eligible),
        exercised: !!(player.rookieOptionExercised || player.rookie_option_exercised),
        classSeason: safeInt(player.rookieOptionClassSeason || player.rookie_option_class_season),
        deadlineSeason: safeInt(player.rookieOptionDeadlineSeason || player.rookie_option_deadline_season),
        baseSalary: safeInt(player.rookieOptionBaseSalary || player.rookie_option_base_salary || player.salary),
        optionYearSalary: safeInt(player.rookieOptionYearSalary || player.rookie_option_year_salary || player.rookie_option_half_raise_salary)
      };
    }
    return parseRookieOptionToken(player.special || player.contract_info || "");
  }

  function rookieOptionActionEligible(player) {
    var option = rookieOptionStateForPlayer(player);
    if (!option || !option.eligible || option.exercised) return false;
    return safeInt(player && player.years, 0) === 1;
  }

  function buildRookieOptionInfoToken(optionState, exercised) {
    if (!optionState || !optionState.eligible) return "";
    return [
      "ROPT",
      "status=" + (exercised ? "exercised" : "eligible"),
      "class=" + String(safeInt(optionState.classSeason)),
      "deadline=" + String(safeInt(optionState.deadlineSeason)),
      "base=" + formatContractK(optionState.baseSalary),
      "option=" + formatContractK(optionState.optionYearSalary)
    ].join(" ");
  }

  function buildRookieOptionContractPayload(player) {
    var option = rookieOptionStateForPlayer(player);
    if (!option || !option.eligible) return null;
    var baseSalary = Math.max(1000, safeInt(option.baseSalary || (player && player.salary), 0));
    var optionSalary = Math.max(baseSalary, safeInt(option.optionYearSalary, baseSalary));
    var total = baseSalary + optionSalary;
    return {
      salary: baseSalary,
      contract_year: 2,
      contract_status: "R-OPT",
      contract_info: [
        "CL 2",
        "TCV " + formatContractK(total),
        "AAV " + formatContractK(Math.round(total / 2)),
        "Y1-" + formatContractK(baseSalary) + ", Y2-" + formatContractK(optionSalary),
        "GTD: " + formatContractK(total > 4000 ? Math.round(total * 0.75) : Math.max(0, total - baseSalary)),
        buildRookieOptionInfoToken(option, true)
      ].filter(Boolean).join("| ")
    };
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

  function playerCountsTowardCurrentAllocation(player) {
    return currentCapHitForPlayer(player) > 0;
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
    if (t === "tag" || t.indexOf("tag") !== -1) return "tag";
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
    if (bucket === "tag") return "is-tag";
    if (bucket === "rookie") return "is-rookie";
    if (bucket === "loaded") return "is-loaded";
    return "is-veteran";
  }

  function isLoadedContractPlayer(player) {
    return contractBucket(player && player.type) === "loaded";
  }

  function activeRosterCountForPlayers(players) {
    var list = Array.isArray(players) ? players : [];
    var count = 0;
    for (var i = 0; i < list.length; i += 1) {
      if (!list[i] || list[i].isTaxi || list[i].isIr) continue;
      count += 1;
    }
    return count;
  }

  function contractLimitSummaryForPlayers(players) {
    var list = Array.isArray(players) ? players : [];
    var threeYearNonRookie = 0;
    var loaded = 0;
    for (var i = 0; i < list.length; i += 1) {
      var player = list[i];
      if (!player) continue;
      if (safeInt(player.years, 0) === 3 && contractBucket(player.type) !== "rookie") {
        threeYearNonRookie += 1;
      }
      if (isLoadedContractPlayer(player)) loaded += 1;
    }
    return {
      threeYearNonRookie: threeYearNonRookie,
      loaded: loaded
    };
  }

  function attentionFilterEnabledForView() {
    return state.view === "roster" || (state.view === "contract" && !capPlanSummaryViewActive());
  }

  function contractActionFilterEnabledForView() {
    return state.view !== "bye" && state.view !== "points" && state.view !== "tag" && !capPlanSummaryViewActive();
  }

  function memorialDayForYear(year) {
    var y = safeInt(year, 0);
    if (!y) return null;
    var d = new Date(y, 4, 31, 12, 0, 0, 0);
    var day = d.getDay();
    var offset = (day + 6) % 7;
    d.setDate(d.getDate() - offset);
    return isNaN(d.getTime()) ? null : d;
  }

  function tagDeadlineDateForSeason(season) {
    var memorial = memorialDayForYear(season);
    if (!memorial) return null;
    var deadline = new Date(memorial.getTime());
    deadline.setDate(deadline.getDate() - 4);
    return deadline;
  }

  function defaultTagDisplayYear() {
    var current = currentYearInt();
    var deadline = endOfDay(tagDeadlineDateForSeason(current));
    var now = new Date();
    if (deadline && now.getTime() <= deadline.getTime()) return String(current);
    return String(current + 1);
  }

  function tagDisplayYearOptions() {
    var current = currentYearInt();
    return [
      { value: String(current), label: String(current) },
      { value: String(current + 1), label: String(current + 1) }
    ];
  }

  function normalizedSelectedTeamId() {
    return safeStr(state.selectedTeamId) === ALL_TEAMS_VALUE ? ALL_TEAMS_VALUE : pad4(state.selectedTeamId);
  }

  function orderedTeamsForDropdown() {
    var viewerTeamId = pad4(state.viewerFranchiseId || (state.ctx && state.ctx.franchiseId));
    var teams = state.teams.slice();
    teams.sort(function (a, b) {
      var aId = pad4(a && a.id);
      var bId = pad4(b && b.id);
      if (viewerTeamId) {
        if (aId === viewerTeamId && bId !== viewerTeamId) return -1;
        if (bId === viewerTeamId && aId !== viewerTeamId) return 1;
      }
      return compareText(a && a.name, b && b.name);
    });
    return teams;
  }

  function tagDisplaySeason() {
    var selected = safeStr(state.tagDisplayYear);
    var options = tagDisplayYearOptions().map(function (row) { return safeStr(row.value); });
    if (options.indexOf(selected) !== -1) return selected;
    state.tagDisplayYear = defaultTagDisplayYear();
    return state.tagDisplayYear;
  }

  function playerContractActionFlags(player) {
    var canManage = canManageRosterPlayer(player);
    var eligibility = rosterContractEligibility(player);
    return {
      rookie_option: canManage && rookieOptionActionEligible(player),
      extension: canManage && playerExtensionOptions(player).length > 0,
      restructure: canManage && !!eligibility.restructureEligible,
      untag: safeStr(player && player.type).toUpperCase() === "TAG" && (canManage || canManageTagForTeam(player && player.fid))
    };
  }

  function playerMatchesContractActionFilter(player, filterValue) {
    var selected = normContractActionFilter(filterValue);
    if (!selected) return true;
    return !!playerContractActionFlags(player)[selected];
  }

  function buildRosterGroupSalarySummaryMap() {
    var out = Object.create(null);
    var allGroups = Object.create(null);
    for (var t = 0; t < state.teams.length; t += 1) {
      var allPlayers = state.teams[t] && state.teams[t].players ? state.teams[t].players : [];
      for (var p = 0; p < allPlayers.length; p += 1) {
        var playerGroup = safeStr(allPlayers[p] && allPlayers[p].positionGroup).toUpperCase() || "OTHER";
        allGroups[playerGroup] = true;
      }
    }

    var groupKeys = Object.keys(allGroups);
    for (var g = 0; g < groupKeys.length; g += 1) {
      var groupKey = groupKeys[g];
      var leaderboard = [];
      for (var i = 0; i < state.teams.length; i += 1) {
        var team = state.teams[i] || {};
        var filtered = filteredPlayersForTeam(team);
        var salaryTotal = 0;
        var count = 0;
        for (var j = 0; j < filtered.length; j += 1) {
          var player = filtered[j];
          if ((safeStr(player && player.positionGroup).toUpperCase() || "OTHER") !== groupKey) continue;
          if (playerCountsTowardCurrentAllocation(player)) {
            salaryTotal += currentCapHitForPlayer(player);
          }
          count += 1;
        }
        leaderboard.push({
          teamId: pad4(team.id),
          name: safeStr(team.name),
          count: count,
          salaryTotal: salaryTotal
        });
      }
      leaderboard.sort(function (a, b) {
        var salaryDelta = safeInt(b.salaryTotal, 0) - safeInt(a.salaryTotal, 0);
        if (salaryDelta !== 0) return salaryDelta;
        var countDelta = safeInt(b.count, 0) - safeInt(a.count, 0);
        if (countDelta !== 0) return countDelta;
        return compareText(a.name, b.name);
      });
      for (var r = 0; r < leaderboard.length; r += 1) {
        var item = leaderboard[r];
        var teamId = pad4(item.teamId);
        if (!out[teamId]) out[teamId] = Object.create(null);
        out[teamId][groupKey] = {
          count: safeInt(item.count, 0),
          salaryTotal: safeInt(item.salaryTotal, 0),
          salaryRank: r + 1,
          leagueTeams: leaderboard.length
        };
      }
    }

    return out;
  }

  function contractPreviewKey(player) {
    return pad4(player && player.fid) + ":" + safeStr(player && player.id);
  }

  function extensionPreviewYears(player) {
    if (!playerExtensionOptions(player).length) return 0;
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

  function parseExtensionHistoryTokens(contractInfo) {
    var info = safeStr(contractInfo);
    if (!info) return [];
    var match = info.match(/(?:^|\|)\s*Ext:\s*([^|]+)/i);
    if (!match || !safeStr(match[1])) return [];
    return safeStr(match[1])
      .split(/[,/;&]|\band\b/i)
      .map(function (token) { return safeStr(token); })
      .filter(Boolean);
  }

  function normalizeIdentityToken(token) {
    return safeStr(token).toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function teamIdentityTokenMap(team) {
    var map = Object.create(null);

    function add(raw) {
      var text = safeStr(raw);
      if (!text) return;
      var normalized = normalizeIdentityToken(text);
      if (normalized) map[normalized] = true;
      var parts = text.split(/[\s/,&().-]+/);
      for (var i = 0; i < parts.length; i += 1) {
        var token = normalizeIdentityToken(parts[i]);
        if (!token) continue;
        map[token] = true;
        if (token.length >= 5 && /ers$/.test(token)) {
          map[token.slice(0, -3)] = true;
        }
        if (token.length >= 5 && /s$/.test(token)) {
          map[token.slice(0, -1)] = true;
        }
      }
    }

    add(team && team.name);
    add(team && team.abbrev);
    return map;
  }

  function lastExtensionIdentityToken(contractInfo) {
    var tokens = parseExtensionHistoryTokens(contractInfo);
    if (!tokens.length) return "";
    return normalizeIdentityToken(tokens[tokens.length - 1]);
  }

  function identityTokenMatchesTeam(token, team) {
    var normalized = normalizeIdentityToken(token);
    if (!normalized) return false;
    var identity = teamIdentityTokenMap(team);
    if (identity[normalized]) return true;
    var keys = Object.keys(identity);
    for (var i = 0; i < keys.length; i += 1) {
      var key = keys[i];
      if (!key) continue;
      if (normalized.length >= 4 && key.indexOf(normalized) === 0) return true;
      if (key.length >= 4 && normalized.indexOf(key) === 0) return true;
    }
    return false;
  }

  function extensionBlockedByCurrentOwner(player) {
    if (!player) return false;
    var team = findTeamById(player.fid);
    if (!team) return false;
    var playerToken = lastExtensionIdentityToken(player.special || player.contract_info || "");
    if (identityTokenMatchesTeam(playerToken, team)) return true;
    return false;
  }

  function extensionBlockedByHistory(player) {
    return parseExtensionHistoryTokens(player && (player.special || player.contract_info || "")).length > 0;
  }

  function extensionBlockedReason(player) {
    if (extensionBlockedByHistory(player)) {
      return "This contract already carries an extension history. No additional extension preview is available.";
    }
    if (!extensionBlockedByCurrentOwner(player)) return "";
    var team = findTeamById(player && player.fid);
    return safeStr(team && team.name || player && player.teamName || "This franchise") + " already used this player's extension on the current contract. No additional extension is available.";
  }

  function extensionOwnerTokenForTeam(team, player) {
    var abbrev = safeStr(team && team.abbrev).trim();
    if (abbrev) return abbrev;
    var teamName = safeStr(team && team.name || player && player.teamName || "").trim();
    if (!teamName) return "";
    return teamName.split(/\s+/)[0];
  }

  function synthesizeExtensionOption(player, yearsToAdd) {
    if (!player) return null;
    var years = safeInt(yearsToAdd, 0);
    if (years !== 1 && years !== 2) return null;

    var currentYears = Math.max(0, safeInt(player && player.years, 0));
    var currentSalary = Math.max(1000, roundToK(safeInt(player && player.salary, 0)));
    var futureSalary = projectedExtensionSalary(player, years);
    if (futureSalary <= 0) return null;

    var totalLength = currentYears + years;
    if (totalLength <= 0) return null;

    var info = safeStr(player && player.special);
    var existingOwners = parseExtensionHistoryTokens(info);
    var team = findTeamById(player && player.fid);
    var ownerToken = extensionOwnerTokenForTeam(team, player);
    var ownerNorm = normalizeIdentityToken(ownerToken);
    if (ownerToken && ownerNorm) {
      var hasOwner = false;
      for (var i = 0; i < existingOwners.length; i += 1) {
        if (normalizeIdentityToken(existingOwners[i]) === ownerNorm) {
          hasOwner = true;
          break;
        }
      }
      if (!hasOwner) existingOwners.push(ownerToken);
    }

    var yearParts = [];
    for (var idx = 1; idx <= totalLength; idx += 1) {
      yearParts.push("Y" + idx + "-" + formatContractK(idx <= currentYears ? currentSalary : futureSalary));
    }
    var tcv = currentSalary * currentYears + futureSalary * years;
    var gtd = tcv > 4000 ? Math.round(tcv * 0.75) : Math.max(0, tcv - currentSalary);
    var aavDisplay = formatContractK(currentSalary) + ", " + formatContractK(futureSalary);
    var contractInfo =
      "CL " + totalLength +
      "|TCV " + formatContractK(tcv) +
      "|AAV " + aavDisplay +
      "|" + yearParts.join(", ") +
      "|GTD: " + formatContractK(gtd);
    if (existingOwners.length) contractInfo += "|Ext: " + existingOwners.join(", ");

    return {
      optionKey: [String(years), "NONE", "EXT" + years, contractInfo].join("|"),
      yearsToAdd: years,
      loadedIndicator: "NONE",
      contractLength: totalLength,
      contractStatus: "EXT" + years,
      contractInfo: contractInfo,
      currentAav: currentSalary,
      futureAav: futureSalary,
      tcv: tcv,
      salaryToSend: futureSalary,
      synthesized: true
    };
  }

  function synthesizedExtensionOptionsForPlayer(player) {
    if (!player) return [];
    var contractEligibility = rosterContractEligibility(player);
    if (!contractEligibility.extensionEligible || extensionBlockedByCurrentOwner(player) || extensionBlockedByHistory(player)) return [];
    var out = [];
    for (var years = 1; years <= 2; years += 1) {
      var option = synthesizeExtensionOption(player, years);
      if (option) out.push(option);
    }
    return out;
  }

  function playerExtensionOptions(player) {
    if (!player || extensionBlockedByCurrentOwner(player) || extensionBlockedByHistory(player)) return [];
    var previews = player.extensionPreviews ? player.extensionPreviews : [];
    return previews.length ? previews : synthesizedExtensionOptionsForPlayer(player);
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

  function extensionTermYearsForStatus(status) {
    var raw = safeStr(status).toUpperCase();
    if (raw === "EXT1") return 1;
    if (raw === "EXT2" || raw === "EXT2-BL" || raw === "EXT2-FL") return 2;
    return 0;
  }

  function rebuiltExtensionContractInfo(termYears, yearAmounts, extSuffix) {
    var years = Math.max(1, safeInt(termYears, 0));
    var amounts = Array.isArray(yearAmounts) ? yearAmounts : [];
    if (!amounts.length) return safeStr(extSuffix);
    var tcv = amounts.reduce(function (sum, amount) {
      return sum + Math.max(0, safeInt(amount, 0));
    }, 0);
    var aav = Math.round(tcv / Math.max(1, years));
    var gtd = tcv > 4000 ? Math.round(tcv * 0.75) : Math.max(0, tcv - Math.max(0, safeInt(amounts[0], 0)));
    var yearParts = [];
    for (var i = 0; i < amounts.length; i += 1) {
      yearParts.push("Y" + String(i + 1) + "-" + formatContractK(amounts[i]));
    }
    var infoParts = [
      "CL " + String(years),
      "TCV " + formatContractK(tcv),
      "AAV " + formatContractK(aav),
      yearParts.join(", "),
      "GTD: " + formatContractK(gtd)
    ];
    if (safeStr(extSuffix)) infoParts.push(safeStr(extSuffix));
    return infoParts.join("| ");
  }

  function normalizeExpiredRookieExtensionPlayer(player) {
    if (!player) return false;
    var termYears = extensionTermYearsForStatus(player.type);
    var draftSeason = safeInt(player.originalDraftSeason || player.original_draft_season, 0);
    var currentSeason = currentYearInt();
    if (!termYears || !draftSeason || !currentSeason || currentSeason < draftSeason + 3) return false;

    var yearValues = parseContractYearValues(player.special || player.contract_info || "");
    var yearKeys = Object.keys(yearValues).map(function (key) { return safeInt(key, 0); }).filter(function (key) {
      return key > 0;
    }).sort(function (a, b) {
      return a - b;
    });
    if (yearKeys.length <= termYears) return false;

    var immediateYears = yearKeys.slice(-termYears).map(function (key) {
      return safeInt(yearValues[key], 0);
    }).filter(function (amount) {
      return amount > 0;
    });
    if (immediateYears.length !== termYears) return false;

    player.salary = immediateYears[0];
    player.years = termYears;
    player.aav = Math.round(immediateYears.reduce(function (sum, amount) {
      return sum + Math.max(0, safeInt(amount, 0));
    }, 0) / Math.max(1, termYears));
    player.special = rebuiltExtensionContractInfo(termYears, immediateYears, extractExtensionSuffix(player.special || player.contract_info || ""));
    return true;
  }

  function applyContractDisplayCorrections(teams) {
    var list = Array.isArray(teams) ? teams : [];
    for (var i = 0; i < list.length; i += 1) {
      var team = list[i] || null;
      if (!team) continue;
      var changed = false;
      var players = team.players || [];
      for (var p = 0; p < players.length; p += 1) {
        if (normalizeExpiredRookieExtensionPlayer(players[p])) changed = true;
      }
      if (changed) recomputeTeamSummary(team);
    }
  }

  function projectSalaryByYear(player, offsets) {
    var years = Math.max(0, safeInt(player && player.years, 0));
    var salary = safeInt(player && player.salary, 0);
    var yearValues = contractYearValueMapForPlayer(player);
    var currentIdx = Math.max(1, contractYearIndexForPlayer(player));
    var extYears = extensionPreviewYears(player);
    var extSalary = projectedExtensionSalary(player, extYears);
    var out = [];
    for (var i = 0; i < offsets; i += 1) {
      if (i < years) {
        var scheduled = safeInt(yearValues[currentIdx + i], 0);
        out.push(scheduled > 0 ? scheduled : salary);
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
    var explicitLength = parseContractLengthValue(player && player.special);
    var parsedLength = 0;
    if (keys.length) {
      parsedLength = keys.reduce(function (max, key) {
        return Math.max(max, safeInt(key, 0));
      }, 0);
    }
    return Math.max(parsedLength, explicitLength, Math.max(0, safeInt(player && player.years, 0)));
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

  function displaySalaryFromContractInfo(contractInfo, years, fallbackSalary) {
    var info = safeStr(contractInfo);
    var fallback = Math.max(0, safeInt(fallbackSalary, 0));
    if (!info) return fallback;
    var yearValues = parseContractYearValues(info);
    var keys = Object.keys(yearValues);
    if (!keys.length) return fallback;
    var length = Math.max(parseContractLengthValue(info), keys.reduce(function (max, key) {
      return Math.max(max, safeInt(key, 0));
    }, 0));
    var yearsInt = Math.max(0, safeInt(years, 0));
    if (length <= 0 || yearsInt <= 0) return fallback;
    var idx = Math.max(1, length - yearsInt + 1);
    if (yearValues[idx] > 0) return safeInt(yearValues[idx], fallback);
    return fallback;
  }

  function contractYearFallbackValue(player, yearIndex) {
    var idx = Math.max(1, safeInt(yearIndex, 1));
    var currentIdx = Math.max(1, contractYearIndexForPlayer(player));
    var length = Math.max(0, contractLengthForPlayer(player));
    var salary = Math.max(0, safeInt(player && player.salary, 0));
    var aavValues = parseContractAavValues(player && player.special);
    var aav = Math.max(0, safeInt(player && player.aav, 0) || currentAavForContractInfo(player && player.special));
    if (idx === currentIdx && salary > 0) return salary;
    if (aavValues[idx - 1] > 0) return safeInt(aavValues[idx - 1], 0);
    if (aavValues.length > 1 && aavValues[aavValues.length - 1] > 0) {
      return safeInt(aavValues[aavValues.length - 1], 0);
    }
    if (aav > 0) return aav;
    var explicitTcv = parseContractTcvValue(player && player.special);
    if (explicitTcv > 0 && length > 0) return Math.round(explicitTcv / Math.max(1, length));
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

    var explicitYearValues = parseContractYearValues(player && player.special);
    if (!Object.keys(explicitYearValues).length) {
      var length = contractLengthForPlayer(player);
      var total = totalContractValueForPlayer(player);
      var currentYearSalary = currentContractYearValue(player);
      if (length > 1 && idx >= length && total > currentYearSalary) {
        return Math.max(0, total - Math.max(0, currentYearSalary));
      }
    }

    var earned = 0;
    var yearValues = contractYearValueMapForPlayer(player);
    for (var i = 1; i < idx; i += 1) {
      earned += safeInt(yearValues[i], contractYearFallbackValue(player, i));
    }
    return earned;
  }

  function earnedToDateBreakdownForPlayer(player, season, now) {
    var years = Math.max(0, safeInt(player && player.years, 0));
    var total = totalContractValueForPlayer(player);
    if (years <= 0) {
      return {
        currentYearSalary: 0,
        priorEarned: total,
        accrued: 0,
        earned: total
      };
    }

    var currentYearSalary = currentContractYearValue(player);
    var priorEarned = earnedBeforeCurrentContractYear(player);
    var accrued = proratedEarnedForDrop(season, currentYearSalary, now);
    return {
      currentYearSalary: currentYearSalary,
      priorEarned: priorEarned,
      accrued: accrued,
      earned: priorEarned + accrued
    };
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
    var totalContractValue = totalContractValueForPlayer(player);
    var earnedBreakdown = earnedToDateBreakdownForPlayer(player, season, now);
    var currentYearSalary = earnedBreakdown.currentYearSalary;
    var priorEarned = earnedBreakdown.priorEarned;
    var accrued = earnedBreakdown.accrued;
    var earned = earnedBreakdown.earned;
    var contractLength = Math.max(0, contractLengthForPlayer(player));
    var explicitGuarantee = parseContractGuaranteeValue(player && player.special);
    var guaranteed = guaranteedContractValueForPlayer(player);

    if (years <= 0) {
      return {
        amount: 0,
        note: "Expired contracts do not carry a projected cap penalty.",
        tcv: totalContractValue,
        guaranteed: guaranteed,
        currentYearSalary: currentYearSalary,
        priorEarned: priorEarned,
        accrued: accrued,
        earned: earned
      };
    }
    if (player && player.isTaxi) {
      return {
        amount: 0,
        note: "Taxi players are shown with salary but do not project a current cap penalty.",
        tcv: totalContractValue,
        guaranteed: guaranteed,
        currentYearSalary: currentYearSalary,
        priorEarned: priorEarned,
        accrued: accrued,
        earned: earned
      };
    }

    if (isTagCutPreAuctionAssumption(player, season, now)) {
      return {
        amount: 0,
        note: "Pre-auction tag cut assumption: projected cap penalty is $0. Once auction opens, standard earned-salary rules apply.",
        tcv: totalContractValue,
        guaranteed: guaranteed,
        currentYearSalary: currentYearSalary,
        priorEarned: priorEarned,
        accrued: accrued,
        earned: earned
      };
    }

    var type = safeStr(player && player.type).toUpperCase();
    if (contractLength === 1 && currentYearSalary < 5000 && (type === "VETERAN" || type === "WW")) {
      return {
        amount: 0,
        note: "One-year veteran/waiver contracts under $5,000 are cap-free cuts under the current rule.",
        tcv: totalContractValue,
        guaranteed: guaranteed,
        currentYearSalary: currentYearSalary,
        priorEarned: priorEarned,
        accrued: accrued,
        earned: earned
      };
    }

    if (isLikelyWaiverPickup(player) && contractLength === 1 && currentYearSalary >= 5000) {
      var waiverAmount = Math.round(currentYearSalary * 0.35);
      return {
        amount: waiverAmount,
        note: "Waiver pickup rule: 35% of current-year salary (" + money(currentYearSalary) + " x 35%).",
        tcv: totalContractValue,
        guaranteed: guaranteed,
        currentYearSalary: currentYearSalary,
        priorEarned: priorEarned,
        accrued: accrued,
        earned: earned
      };
    }

    var penalty = Math.max(0, guaranteed - earned);
    var guaranteeLabel = explicitGuarantee > 0
      ? "contract guarantee"
      : (totalContractValue <= 4000 ? "TCV minus year 1 salary" : "75% of TCV");

    return {
      amount: penalty,
      tcv: totalContractValue,
      guaranteed: guaranteed,
      currentYearSalary: currentYearSalary,
      priorEarned: priorEarned,
      accrued: accrued,
      earned: earned,
      note: penalty === 0
        ? "Current-rule guarantee has already been fully earned."
        : "Projected current-rule penalty: " + guaranteeLabel + " is " + money(guaranteed) + "; earned to date is " + money(earned) + "."
    };
  }

  function playerAttentionProfile(player) {
    var eligibility = rosterContractEligibility(player);
    var years = Math.max(0, safeInt(player && player.years, 0));
    var penalty = dropPenaltyEstimate(player);
    var penaltyAmount = safeInt(penalty && penalty.amount, 0);
    var previewYears = extensionPreviewYears(player);
    var items = [];

    if (years <= 0) {
      items.push({ key: "expired", label: "Expired", tone: "risk" });
    } else if (years === 1) {
      items.push({ key: "expiring", label: "Expiring", tone: "risk" });
    }
    if (eligibility.extensionEligible) {
      items.push({ key: "extension", label: "Extend", tone: "action" });
    }
    if (eligibility.restructureEligible) {
      items.push({ key: "restructure", label: "Restructure", tone: "action" });
    }
    if (isLoadedContractPlayer(player)) {
      items.push({ key: "loaded", label: "Loaded", tone: "loaded" });
    }
    if (penaltyAmount >= 5000) {
      items.push({ key: "penalty", label: "Penalty " + formatContractK(penaltyAmount), tone: "risk" });
    }
    if (previewYears > 0) {
      items.push({ key: "preview", label: "Preview " + String(previewYears) + "Y", tone: "preview" });
    }

    return {
      items: items,
      attentionCount: items.length,
      expiring: years <= 1,
      extensionEligible: !!eligibility.extensionEligible,
      restructureEligible: !!eligibility.restructureEligible,
      loaded: isLoadedContractPlayer(player),
      highPenalty: penaltyAmount >= 5000,
      previewActive: previewYears > 0
    };
  }

  function playerNeedsAttention(player) {
    return !!playerAttentionProfile(player).attentionCount;
  }

  function searchFilterEnabledForView() {
    return state.view !== "bye" && !capPlanSummaryViewActive() && !tagBreakdownActive();
  }

  function browseSearchEnabledForView() {
    return state.view === "points" || (state.view === "tag" && !tagBreakdownActive());
  }

  function contractTypeFilterEnabledForView() {
    return state.view !== "bye" && state.view !== "points" && state.view !== "tag" && !capPlanSummaryViewActive();
  }

  function positionFilterEnabledForView() {
    return !capPlanSummaryViewActive() && !tagBreakdownActive();
  }

  function rosterStatusFilterEnabledForView() {
    return state.view !== "tag" && !capPlanSummaryViewActive();
  }

  function tagPriorAavSubtext(row) {
    var season = safeStr(row && row.prior_basis_season) || safeStr(state.tagData && state.tagData.sourceSeason);
    var amount = Math.max(
      safeInt(row && row.prior_aav_week1, 0),
      safeInt(row && row.prior_aav, 0),
      safeInt(row && row.aav, 0),
      safeInt(row && row.prior_salary_week1, 0)
    );
    var label = season ? (season + " AAV") : "Prior AAV";
    return label + ": " + (amount > 0 ? formatContractK(amount) : "—");
  }

  function teamJumpEnabledForView() {
    return state.view !== "tag" || !tagBreakdownActive();
  }

  function filtersForcedOpenForView() {
    return false;
  }

  function scoringControlEnabledForView() {
    return state.view === "points" || state.view === "bye";
  }

  function capPlanSubviewControlEnabledForView() {
    return state.view === "contract";
  }

  function tagSubviewControlEnabledForView() {
    return state.view === "tag";
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

  function siteIsOffseason() {
    if (typeof window.UPS_IS_OFFSEASON === "boolean") return !!window.UPS_IS_OFFSEASON;
    var season = safeStr(state.ctx && state.ctx.year);
    var year = safeInt(season, new Date().getFullYear());
    var currentYear = new Date().getFullYear();
    var today = new Date();
    if (year < currentYear || year > currentYear) return true;
    var deadlineDate = contractDeadlineDateForSeason(season);
    var seasonComplete = seasonCompleteDateForSeason(season);
    if (!deadlineDate) return true;
    if (today < deadlineDate) return true;
    if (seasonComplete && today > endOfDay(seasonComplete)) return true;
    return false;
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

  function seasonCompleteYmdForSeason(season) {
    var seasonKey = safeStr(season);
    var events = seasonEventsForRosterLimit(seasonKey) || {};
    return safeStr(
      events.ups_season_complete ||
      events.season_complete ||
      events.UPS_SEASON_COMPLETE
    );
  }

  function seasonCompleteDateForSeason(season) {
    return parseYmdDate(seasonCompleteYmdForSeason(season));
  }

  function isSeasonCompleteForRosterPoints(season, now) {
    var seasonKey = safeStr(season);
    if (!seasonKey) return false;
    var year = safeInt(seasonKey, 0);
    var currentSeason = currentYearInt();
    if (year && year < currentSeason) return true;
    if (year && year > currentSeason) return false;
    var completeDate = endOfDay(seasonCompleteDateForSeason(seasonKey));
    var today = now instanceof Date && !isNaN(now.getTime()) ? now : new Date();
    if (completeDate) return today.getTime() > completeDate.getTime();
    return false;
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
    var normalized = safeStr(mode).toLowerCase();
    if (normalized === "cumulative") return "Cumulative";
    if (normalized === "historical") return "Historical";
    return safeStr(mode);
  }

  function viewLabel(view) {
    if (view === "contract") return capPlanSummaryViewActive() ? "Cap Plan Summary" : "Cap Plan";
    if (view === "points") return "Scoring";
    if (view === "bye") return "Bye Chart";
    if (view === "tag") return "Tagging";
    return "Contract View";
  }

  function uniqueSeasonList(values) {
    var seen = Object.create(null);
    var out = [];
    var list = Array.isArray(values) ? values : [];
    for (var i = 0; i < list.length; i += 1) {
      var season = safeStr(list[i]);
      if (!season || seen[season]) continue;
      seen[season] = true;
      out.push(season);
    }
    return out;
  }

  function rosterPointSeasonPoolDescending() {
    var seasons = state.pointsHistory
      ? historySeasonsDescending()
      : (state.pointYears && state.pointYears.length ? state.pointYears.slice() : buildPointYears());
    var liveSeason = liveSeasonKey();
    var includeLiveSeason = !!(liveSeason && !siteIsOffseason());
    seasons = uniqueSeasonList(seasons).filter(function (season) {
      if (safeStr(season) === liveSeason) return includeLiveSeason;
      return isSeasonCompleteForRosterPoints(season, new Date());
    });
    if (seasons.length) return seasons;

    var base = currentYearInt();
    return [String(base - 1), String(base - 2), String(base - 3)].filter(function (season) {
      return safeInt(season, 0) > 0;
    });
  }

  function rosterPointModeOptions() {
    var seasons = rosterPointSeasonPoolDescending();
    var options = seasons.slice(0, 3).map(function (season) {
      return { value: season, label: season };
    });
    options.push({ value: "historical", label: "Historical" });
    return options;
  }

  function normalizeRosterPointMode(mode) {
    var value = safeStr(mode);
    var options = rosterPointModeOptions();
    for (var i = 0; i < options.length; i += 1) {
      if (safeStr(options[i] && options[i].value) === value) return value;
    }
    return options.length ? safeStr(options[0].value) : "historical";
  }

  function rosterPointSeasonsForMode(mode) {
    var value = safeStr(mode);
    var seasons = rosterPointSeasonPoolDescending();
    if (value === "historical") return seasons.slice().reverse();
    if (seasons.indexOf(value) !== -1) return [value];
    return seasons.length ? [seasons[0]] : [];
  }

  function rosterPointsRangeLabel() {
    var value = normalizeRosterPointMode(state.pointsMode);
    if (value === "historical") return "Historical scoring";
    return value + " scoring";
  }

  function clearRosterPointsSummaryCache() {
    state.rosterPointsSummaryCacheKey = "";
    state.rosterPointsSummaryByPlayer = Object.create(null);
  }

  function clearPointsWeeklyRankCache() {
    state.pointsWeeklyRankCacheKey = "";
    state.pointsWeeklyRankCache = null;
    state.pointsYearlyEliteRankCacheKey = "";
    state.pointsYearlyEliteRankCache = null;
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

  function resolveAcquisitionLookupUrl(season) {
    var candidates = [
      window.UPS_RWB_ACQUISITION_LOOKUP_URL,
      window.UPS_ROSTER_WORKBENCH_ACQUISITION_LOOKUP_URL
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
        return new URL("player_acquisition_lookup_" + encodeURIComponent(seasonText) + ".json", SCRIPT_BASE_URL).toString();
      } catch (e) {}
    }
    return "https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@main/site/rosters/player_acquisition_lookup_" + encodeURIComponent(seasonText) + ".json";
  }

  function loadAcquisitionLookupRows(season) {
    var url = resolveAcquisitionLookupUrl(season);
    return fetchJson(url, { credentials: "omit", cache: "no-store" }).then(function (payload) {
      if (Array.isArray(payload)) return payload;
      if (payload && Array.isArray(payload.rows)) return payload.rows;
      return [];
    }).catch(function () {
      return [];
    });
  }

  function resolveSalaryAdjustmentLedgerUrl(season) {
    var candidates = [
      window.UPS_RWB_SALARY_ADJUSTMENTS_URL,
      window.UPS_ROSTER_WORKBENCH_SALARY_ADJUSTMENTS_URL
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
        return new URL("../reports/salary_adjustments/salary_adjustments_" + encodeURIComponent(seasonText) + ".json", SCRIPT_BASE_URL).toString();
      } catch (e) {}
    }
    return "https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@main/site/reports/salary_adjustments/salary_adjustments_" + encodeURIComponent(seasonText) + ".json";
  }

  function loadSalaryAdjustmentLedgerRows(season) {
    var url = resolveSalaryAdjustmentLedgerUrl(season);
    return fetchJson(url, { credentials: "omit", cache: "no-store" }).then(function (payload) {
      if (Array.isArray(payload)) return { loaded: true, rows: payload };
      if (payload && Array.isArray(payload.rows)) return { loaded: true, rows: payload.rows };
      return { loaded: true, rows: [] };
    }).catch(function () {
      return { loaded: false, rows: [] };
    });
  }

  function acquisitionLookupKey(franchiseId, playerId) {
    return pad4(franchiseId) + ":" + safeStr(playerId).replace(/\D/g, "");
  }

  function mergeAcquisitionLookupRows(teams, rows) {
    var list = teams || [];
    var rawRows = asArray(rows);
    if (!list.length || !rawRows.length) return;

    var byKey = Object.create(null);
    for (var i = 0; i < rawRows.length; i += 1) {
      var row = rawRows[i] || {};
      var key = acquisitionLookupKey(row.franchise_id || row.franchiseId, row.player_id || row.playerId);
      if (!key || key === ":") continue;
      byKey[key] = row;
    }

    for (var t = 0; t < list.length; t += 1) {
      var players = list[t] && list[t].players ? list[t].players : [];
      for (var p = 0; p < players.length; p += 1) {
        var player = players[p] || {};
        var match = byKey[acquisitionLookupKey(player.fid, player.id)];
        if (!match) continue;
        player.acquisitionDate = safeStr(match.acquisition_date || match.date_et);
        player.acquisitionDateTime = safeStr(match.acquisition_datetime_et || match.datetime_et);
        player.acquisitionTypeLabel = safeStr(match.acquisition_label || match.label);
        player.acquisitionDetail = safeStr(match.acquisition_detail || match.detail);
        player.originalDraftSeason = safeInt(match.original_draft_season || match.originalDraftSeason, 0);
      }
    }
  }

  function fallbackAcquisitionLabel(rawText) {
    var text = safeStr(rawText);
    var upper = text.toUpperCase();
    if (!upper) return "";
    if (upper.indexOf("TRADE") !== -1) return "Trade";
    if (upper.indexOf("AUCTION") !== -1) return "Auction";
    if (upper.indexOf("BBID") !== -1 || upper.indexOf("WAIVER") !== -1) return "Waiver";
    if (upper.indexOf("FREE_AGENT") !== -1 || upper.indexOf("FREE AGENT") !== -1) return "Free Agent Add";
    if (upper.indexOf("DRAFT") !== -1) return "Rookie Draft";
    return text;
  }

  function formatShortDate(rawDate) {
    var text = safeStr(rawDate);
    var match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return text;
    var dt = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (isNaN(dt.getTime())) return text;
    return dt.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric"
    });
  }

  function extensionDeadlineLabelForSeason(season) {
    return formatShortDate(contractDeadlineYmdForSeason(season));
  }

  function acquisitionDateLabelForPlayer(player) {
    return formatShortDate(player && (player.acquisitionDate || player.acquisition_date)) || "—";
  }

  function acquisitionTypeLabelForPlayer(player) {
    var label = safeStr(player && (player.acquisitionTypeLabel || player.acquisition_type_label));
    if (!label) label = fallbackAcquisitionLabel(acquisitionTextForPlayer(player));
    return label || "—";
  }

  function remapExtensionPreviewRowsToCurrentOwnersFallback(teams, rows) {
    var list = asArray(rows);
    if (!teams || !teams.length || !list.length) return list;

    var ownerByPlayerId = Object.create(null);
    var teamMetaById = Object.create(null);
    for (var i = 0; i < teams.length; i += 1) {
      var team = teams[i] || {};
      var fid = pad4(team.id);
      if (!fid) continue;
      teamMetaById[fid] = {
        name: safeStr(team.name),
        abbrev: safeStr(team.abbrev)
      };
      var players = team.players || [];
      for (var p = 0; p < players.length; p += 1) {
        var pid = safeStr(players[p] && players[p].id).replace(/\D/g, "");
        if (!pid) continue;
        ownerByPlayerId[pid] = fid;
      }
    }

    return list.map(function (row) {
      var next = row && typeof row === "object" ? { ...row } : row;
      var playerId = safeStr(next && (next.player_id || next.id)).replace(/\D/g, "");
      if (!playerId) return next;
      var currentOwner = ownerByPlayerId[playerId] || "";
      var previewOwner = pad4(next && (next.franchise_id || next.franchiseId));
      if (!currentOwner || !previewOwner || currentOwner === previewOwner) return next;
      next.original_franchise_id = previewOwner;
      next.franchise_id = currentOwner;
      if (teamMetaById[currentOwner]) {
        next.franchise_name = teamMetaById[currentOwner].name || safeStr(next.franchise_name);
      }
      return next;
    });
  }

  function mergeExtensionPreviewFallbackRows(teams, rows) {
    var list = teams || [];
    var extRows = remapExtensionPreviewRowsToCurrentOwnersFallback(list, rows);
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

  function resolveTagTrackingUrl() {
    var candidates = [
      window.UPS_RWB_TAG_TRACKING_URL,
      window.UPS_ROSTER_WORKBENCH_TAG_TRACKING_URL
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

    if (SCRIPT_BASE_URL) {
      try {
        return new URL("../ccc/tag_tracking.json", SCRIPT_BASE_URL).toString();
      } catch (e) {}
    }
    return "https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@main/site/ccc/tag_tracking.json";
  }

  function resolveTagSubmissionsUrl() {
    var candidates = [
      window.UPS_RWB_TAG_SUBMISSIONS_URL,
      window.UPS_ROSTER_WORKBENCH_TAG_SUBMISSIONS_URL
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

    if (SCRIPT_BASE_URL) {
      try {
        return new URL("../ccc/tag_submissions.json", SCRIPT_BASE_URL).toString();
      } catch (e) {}
    }
    return "https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@main/site/ccc/tag_submissions.json";
  }

  function loadLocalTagSubmissionStore() {
    return readLocalJson(LOCAL_TAG_SUBMISSIONS_KEY, {}) || {};
  }

  function saveLocalTagSubmissionStore(store) {
    writeLocalJson(LOCAL_TAG_SUBMISSIONS_KEY, store || {});
  }

  function normalizeTagTrackingRow(raw) {
    var row = raw || {};
    var position = safeStr(row.position || row.pos);
    var posGroup = safeStr(row.positional_grouping || row.positionalGrouping || row.pos_group || position).toUpperCase();
    return {
      league_id: safeStr(row.league_id || row.L || row.leagueId || (state.ctx && state.ctx.leagueId)),
      source_season: safeStr(row.season || row.year),
      franchise_id: pad4(row.franchise_id || row.franchiseId),
      franchise_name: safeStr(row.franchise_name || row.franchiseName),
      player_id: safeStr(row.player_id || row.playerId || row.id).replace(/\D/g, ""),
      player_name: normalizePlayerName(row.player_name || row.playerName || row.name),
      position: safeStr(position).toUpperCase(),
      positional_grouping: posGroup || positionGroupKey(position),
      side: getTagSideFromPos(posGroup || position) || normalizeTagSideValue(row.tag_side || row.side) || "OFFENSE",
      points_total: safeNum(row.points_total, 0),
      pos_rank: safeInt(row.pos_rank, 0),
      tag_tier: safeInt(row.tag_tier, 0),
      tag_salary: safeInt(row.tag_salary || row.tag_bid || row.salary, 0),
      tag_formula: safeStr(row.tag_formula),
      is_tag_eligible: safeInt(row.is_tag_eligible, 0),
      contract_status: safeStr(row.contract_status),
      contract_year: safeInt(row.contract_year, 0),
      salary: safeInt(row.salary, 0),
      aav: safeInt(row.aav, 0),
      contract_info: safeStr(row.contract_info),
      prior_aav_week1: safeInt(row.prior_aav_week1 || row.prior_aav, 0),
      prior_salary_week1: safeInt(row.prior_salary_week1 || row.prior_salary || row.prior_contract_salary, 0),
      tag_prev_season: safeInt(row.tag_prev_season, 0),
      tag_prev_season_year: safeInt(row.tag_prev_season_year, 0)
    };
  }

  function tagPlayerExplicitlyExcluded(playerId, playerName) {
    var pid = safeStr(playerId).replace(/\D/g, "");
    if (pid && TAG_EXCLUDED_PLAYER_IDS[pid]) return true;
    var normalized = safeStr(playerName).trim().toLowerCase();
    if (!normalized) return false;
    return !!TAG_EXCLUDED_NAME_MATCHES[normalized];
  }

  function normalizeTagSubmissionEntry(raw) {
    var row = raw || {};
    var payload = row && typeof row.payload === "object" ? row.payload : null;
    var position = safeStr(row.pos || row.position || row.positional_grouping || (payload && payload.position));
    return {
      league_id: safeStr(row.league_id || row.L || row.leagueId || (payload && (payload.league_id || payload.leagueId || payload.L))),
      season: safeStr(row.season || row.year || (payload && (payload.season || payload.year || payload.YEAR))),
      franchise_id: pad4(row.franchise_id || row.franchiseId || (payload && (payload.franchise_id || payload.franchiseId))),
      franchise_name: safeStr(row.franchise_name || row.franchiseName || (payload && (payload.franchise_name || payload.franchiseName))),
      player_id: safeStr(row.player_id || row.playerId || row.id || (payload && (payload.player_id || payload.playerId))).replace(/\D/g, ""),
      player_name: normalizePlayerName(row.player_name || row.playerName || row.name || (payload && (payload.player_name || payload.playerName))),
      pos: safeStr(position).toUpperCase(),
      side: getTagSideFromPos(position) || normalizeTagSideValue(row.side || row.tag_side || (payload && payload.side)) || "OFFENSE",
      tag_salary: safeInt(row.tag_salary || row.tag_bid || row.salary || (payload && payload.salary), 0),
      tag_formula: safeStr(row.tag_formula || (payload && payload.tag_formula)),
      tag_tier: safeInt(row.tag_tier || (payload && payload.tag_tier), 0),
      submitted_at_utc: safeStr(row.submitted_at_utc || row.submitted_at || row.submittedAt || (payload && payload.submitted_at_utc)),
      payload: payload || null,
      row_snapshot: row && typeof row.row_snapshot === "object" ? row.row_snapshot : (payload && payload.row_snapshot) || null
    };
  }

  function buildTagSelectionKey(season, franchiseId, side) {
    var leagueId = safeStr(state.ctx && state.ctx.leagueId);
    var seasonValue = safeStr(season);
    var fid = pad4(franchiseId);
    var tagSide = normalizeTagSideValue(side) || "OFFENSE";
    return [leagueId, seasonValue, fid, tagSide].join("|");
  }

  function effectiveTagSalaryForRow(row) {
    var ref = row || {};
    var baseBid = safeInt(ref.tag_salary, 0);
    var floorBase = Math.max(
      safeInt(ref.prior_aav_week1, 0),
      safeInt(ref.prior_salary_week1, 0),
      safeInt(ref.aav, 0),
      safeInt(ref.salary, 0)
    );
    var bumpFloor = floorBase > 0 ? Math.ceil((floorBase * 1.1) / 1000) * 1000 : 0;
    return Math.max(baseBid, bumpFloor);
  }

  function effectiveTagFormulaForRow(row) {
    var formula = safeStr(row && row.tag_formula);
    var baseBid = safeInt(row && row.tag_salary, 0);
    var effectiveBid = effectiveTagSalaryForRow(row);
    if (effectiveBid > baseBid && formula.toLowerCase().indexOf("10%") === -1) {
      formula += (formula ? " | " : "") + "10% salary floor (rounded up)";
    }
    return formula;
  }

  function pickTagTrackingSourceSeason(rows) {
    var seasons = [];
    var seen = Object.create(null);
    for (var i = 0; i < rows.length; i += 1) {
      var season = safeStr(rows[i] && rows[i].source_season);
      if (!season || seen[season]) continue;
      seen[season] = true;
      seasons.push(season);
    }
    if (!seasons.length) return "";
    seasons.sort(function (a, b) { return safeInt(a, 0) - safeInt(b, 0); });
    var current = safeInt(state.ctx && state.ctx.year, currentYearInt());
    var currentText = String(current);
    var priorText = String(Math.max(0, current - 1));
    if (seasons.indexOf(currentText) !== -1) return currentText;
    if (siteIsOffseason() && seasons.indexOf(priorText) !== -1) return priorText;
    return seasons[seasons.length - 1];
  }

  function effectiveTagCycleSeason(sourceSeason) {
    var current = safeStr(state.ctx && state.ctx.year);
    var source = safeStr(sourceSeason);
    if (!current) return source;
    var defaultTagYear = defaultTagDisplayYear();
    if (source === current) return defaultTagYear;
    if (siteIsOffseason() && safeInt(source, 0) === safeInt(current, 0) - 1) return current;
    return source;
  }

  function buildTagContractInfo(row, salary) {
    var amount = Math.max(0, safeInt(salary, 0));
    var guaranteed = Math.round(amount * 0.75);
    var tier = safeInt(row && row.tag_tier, 0);
    var formula = safeStr(effectiveTagFormulaForRow(row));
    var parts = [
      "CL 1",
      "TCV " + formatContractK(amount),
      "AAV " + formatContractK(amount),
      "GTD " + formatContractK(guaranteed)
    ];
    parts.push("Tag");
    if (tier > 0) parts.push("Tier " + String(tier));
    if (formula) parts.push("Formula: " + formula);
    return parts.join("| ");
  }

  function tagRowKey(franchiseId, playerId) {
    return pad4(franchiseId) + ":" + safeStr(playerId).replace(/\D/g, "");
  }

  function recomputeTeamSummary(team) {
    if (!team) return team;
    var players = team.players || [];
    var taxiCount = 0;
    var irCount = 0;
    var capTotal = 0;
    for (var i = 0; i < players.length; i += 1) {
      var player = players[i] || {};
      if (player.isTaxi) taxiCount += 1;
      if (player.isIr) irCount += 1;
      capTotal += currentCapHitForPlayer(player);
    }
    var adjustmentTotal = safeInt(team.summary && team.summary.salaryAdjustmentTotal, 0);
    var adjustmentRows = asArray(team.summary && team.summary.salaryAdjustmentRows);
    var adjustmentSource = team.summary && team.summary.salaryAdjustmentSource
      ? { ...team.summary.salaryAdjustmentSource }
      : null;
    team.summary = {
      players: players.length,
      rosterPlayers: rosterCountForPlayers(players),
      taxi: taxiCount,
      ir: irCount,
      capTotal: capTotal,
      salaryAdjustmentTotal: adjustmentTotal,
      salaryAdjustmentBreakdown: cloneSalaryAdjustmentBreakdown(team.summary && team.summary.salaryAdjustmentBreakdown),
      compliance: deriveCompliance(capTotal + adjustmentTotal, state.salaryCapAmount),
      salaryAdjustmentRows: adjustmentRows,
      salaryAdjustmentSource: adjustmentSource
    };
    return team;
  }

  function clonePlayerSnapshotForTag(source, team, submission, row) {
    if (!source) return null;
    var ref = row || submission && submission.row_snapshot || {};
    var clone = {
      id: safeStr(source.id || submission && submission.player_id).replace(/\D/g, ""),
      fid: pad4(team && team.id),
      teamName: safeStr(team && team.name),
      order: 100000 + Math.max(0, safeInt(submission && submission.at, 0)),
      name: normalizePlayerName(
        source.name ||
        (submission && submission.player_name) ||
        ref.player_name ||
        ref.name
      ),
      position: safeStr(source.position || ref.position || ref.pos).toUpperCase() || "-",
      nflTeam: safeStr(source.nflTeam || source.nfl_team || ref.nfl_team || ref.team).toUpperCase(),
      points: safeNum(source.points, 0),
      bye: safeStr(source.bye),
      salary: Math.max(0, safeInt(submission && submission.tag_salary, effectiveTagSalaryForRow(ref))),
      years: 1,
      aav: Math.max(0, safeInt(submission && submission.tag_salary, effectiveTagSalaryForRow(ref))),
      type: "TAG",
      special: buildTagContractInfo(ref, Math.max(0, safeInt(submission && submission.tag_salary, effectiveTagSalaryForRow(ref)))),
      acquisitionText: "TAG PLAN",
      status: "ROSTER",
      isTaxi: false,
      isIr: false,
      pointsByYear: source.pointsByYear || Object.create(null),
      gamesByYear: source.gamesByYear || Object.create(null),
      pointsCumulative: safeNum(source.pointsCumulative, 0),
      gamesCumulative: safeInt(source.gamesCumulative, 0),
      extensionPreviews: [],
      isSyntheticTag: true,
      tagCycleSeason: safeStr(submission && submission.season),
      positionGroup: safeStr(source.positionGroup || ref.positional_grouping || positionGroupKey(source.position || ref.position || ref.pos)).toUpperCase() || "OTHER"
    };
    return enrichPlayer(clone);
  }

  function findTaggedPlayerSourceSnapshot(teamId, playerId) {
    var fid = pad4(teamId);
    var pid = safeStr(playerId).replace(/\D/g, "");
    if (!pid) return null;

    for (var t = 0; t < state.teams.length; t += 1) {
      var team = state.teams[t] || {};
      var players = team.players || [];
      for (var p = 0; p < players.length; p += 1) {
        var player = players[p] || {};
        if (safeStr(player.id).replace(/\D/g, "") !== pid) continue;
        if (fid && pad4(team.id) === fid) return player;
        return player;
      }
    }
    return null;
  }

  function buildSyntheticTaggedPlayer(team, submission, row, sourcePlayer) {
    var ref = row || submission && submission.row_snapshot || {};
    var source = clonePlayerSnapshotForTag(sourcePlayer, team, submission, ref);
    if (source) return source;
    var position = safeStr(ref.position || ref.pos || submission && submission.pos).toUpperCase();
    var posGroup = safeStr(ref.positional_grouping || positionGroupKey(position)).toUpperCase();
    var salary = Math.max(0, safeInt(submission && submission.tag_salary, effectiveTagSalaryForRow(ref)));
    return enrichPlayer({
      id: safeStr(submission && submission.player_id).replace(/\D/g, ""),
      fid: pad4(team && team.id),
      teamName: safeStr(team && team.name),
      order: 100000 + Math.max(0, safeInt(submission && submission.at, 0)),
      name: normalizePlayerName((submission && submission.player_name) || ref.player_name || ref.name),
      position: position || "-",
      nflTeam: safeStr(ref.nfl_team || ref.team).toUpperCase(),
      points: 0,
      bye: "",
      salary: salary,
      years: 1,
      aav: salary,
      type: "TAG",
      special: buildTagContractInfo(ref, salary),
      acquisitionText: "TAG PLAN",
      status: "ROSTER",
      isTaxi: false,
      isIr: false,
      pointsByYear: Object.create(null),
      pointsCumulative: 0,
      extensionPreviews: [],
      isSyntheticTag: true,
      tagCycleSeason: safeStr(submission && submission.season),
      positionGroup: posGroup || "OTHER"
    });
  }

  function applyTagOverlayToTeams(teams) {
    var list = Array.isArray(teams) ? teams : [];
    var tagData = state.tagData;
    if (!list.length || !tagData) return list;

    var submissionKeys = Object.keys(tagData.submissionsByKey || {});
    if (!submissionKeys.length) return list;

    var rowMap = tagData.rowMapByPlayer || Object.create(null);
    for (var i = 0; i < list.length; i += 1) {
      var team = list[i];
      if (!team) continue;
      var fid = pad4(team.id);
      var players = Array.isArray(team.players) ? team.players.slice() : [];
      var changed = false;

      for (var s = 0; s < submissionKeys.length; s += 1) {
        var submission = tagData.submissionsByKey[submissionKeys[s]];
        if (!submission || pad4(submission.franchise_id) !== fid) continue;
        var pid = safeStr(submission.player_id).replace(/\D/g, "");
        if (!pid) continue;
        var refRow = rowMap[tagRowKey(fid, pid)] || submission.row_snapshot || null;
        var existingIndex = -1;
        for (var p = 0; p < players.length; p += 1) {
          if (safeStr(players[p] && players[p].id).replace(/\D/g, "") === pid) {
            existingIndex = p;
            break;
          }
        }
        if (existingIndex >= 0) {
          var existing = players[existingIndex];
          var nextSalary = Math.max(0, safeInt(submission.tag_salary, effectiveTagSalaryForRow(refRow)));
          existing.salary = nextSalary;
          existing.years = 1;
          existing.aav = nextSalary;
          existing.type = "TAG";
          existing.special = buildTagContractInfo(refRow, nextSalary);
          existing.status = "ROSTER";
          existing.isTaxi = false;
          existing.isIr = false;
          existing.isSyntheticTag = !!existing.isSyntheticTag;
          existing.tagCycleSeason = safeStr(submission.season);
          existing.positionGroup = positionGroupKey(existing.position);
          players[existingIndex] = enrichPlayer(existing);
        } else {
          players.push(
            buildSyntheticTaggedPlayer(
              team,
              submission,
              refRow,
              findTaggedPlayerSourceSnapshot(fid, pid)
            )
          );
        }
        changed = true;
      }

      if (changed) {
        team.players = players;
        recomputeTeamSummary(team);
      }
    }
    return list;
  }

  function syncTagPlanFromSources() {
    var trackingRows = Array.isArray(state.tagTrackingRows) ? state.tagTrackingRows : [];
    var submissionRows = Array.isArray(state.tagExternalSubmissions) ? state.tagExternalSubmissions : [];
    var sourceSeason = pickTagTrackingSourceSeason(trackingRows);
    var cycleSeason = effectiveTagCycleSeason(sourceSeason || (state.ctx && state.ctx.year));
    var leagueId = safeStr(state.ctx && state.ctx.leagueId);
    var rows = trackingRows.filter(function (row) {
      return safeStr(row.source_season) === safeStr(sourceSeason) &&
        safeInt(row.is_tag_eligible, 0) === 1 &&
        !tagPlayerExplicitlyExcluded(row.player_id, row.player_name) &&
        (!leagueId || !safeStr(row.league_id) || safeStr(row.league_id) === leagueId);
    });
    rows.forEach(function (row) {
      row.cycle_season = cycleSeason;
      row.tag_salary = effectiveTagSalaryForRow(row);
      row.tag_formula = effectiveTagFormulaForRow(row);
    });

    var rowMapByPlayer = Object.create(null);
    rows.forEach(function (row) {
      rowMapByPlayer[tagRowKey(row.franchise_id, row.player_id)] = row;
    });

    var externalSubmissionMap = Object.create(null);
    submissionRows.forEach(function (row) {
      if (!row) return;
      if (safeStr(row.season) !== safeStr(cycleSeason)) return;
      if (leagueId && safeStr(row.league_id) && safeStr(row.league_id) !== leagueId) return;
      var key = buildTagSelectionKey(row.season, row.franchise_id, row.side);
      externalSubmissionMap[key] = row;
    });

    var localStore = loadLocalTagSubmissionStore();
    var localSubmissionMap = Object.create(null);
    Object.keys(localStore || {}).forEach(function (key) {
      var row = normalizeTagSubmissionEntry(localStore[key]);
      if (!row.player_id || !row.franchise_id) return;
      if (leagueId && safeStr(row.league_id) && safeStr(row.league_id) !== leagueId) return;
      if (safeStr(row.season) !== safeStr(cycleSeason)) return;
      localSubmissionMap[buildTagSelectionKey(row.season, row.franchise_id, row.side)] = row;
    });

    var merged = Object.create(null);
    Object.keys(externalSubmissionMap).forEach(function (key) {
      merged[key] = externalSubmissionMap[key];
    });
    Object.keys(localSubmissionMap).forEach(function (key) {
      merged[key] = localSubmissionMap[key];
    });

    state.tagData = {
      sourceSeason: sourceSeason,
      cycleSeason: cycleSeason,
      rows: rows,
      rowMapByPlayer: rowMapByPlayer,
      calcBreakdown: state.tagTrackingMeta && typeof state.tagTrackingMeta.calc_breakdown === "object" ? state.tagTrackingMeta.calc_breakdown : {},
      aavSnapshotWeek: safeStr(state.tagTrackingMeta && state.tagTrackingMeta.aav_snapshot_week),
      externalSubmissionsByKey: externalSubmissionMap,
      localSubmissionsByKey: localSubmissionMap,
      submissionsByKey: merged
    };
    applyTagOverlayToTeams(state.teams);
    assignPositionalContractRanks(state.teams);
  }

  function loadTagPlanData() {
    if (state.tagTrackingRows && state.tagExternalSubmissions) {
      syncTagPlanFromSources();
      return Promise.resolve(state.tagData);
    }
    if (state.tagDataPromise) return state.tagDataPromise;

    state.tagDataLoading = true;
    state.tagDataError = "";
    if (state.view === "tag") {
      renderToolbar();
      renderTeams();
    }

    state.tagDataPromise = Promise.all([
      fetchJson(resolveTagTrackingUrl(), { credentials: "omit", cache: "no-store" }).catch(function () { return {}; }),
      fetchJson(resolveTagSubmissionsUrl(), { credentials: "omit", cache: "no-store" }).catch(function () { return {}; })
    ]).then(function (parts) {
      var trackingPayload = parts[0] || {};
      var submissionsPayload = parts[1] || {};
      var trackingRowsRaw = Array.isArray(trackingPayload)
        ? trackingPayload
        : Array.isArray(trackingPayload.rows)
        ? trackingPayload.rows
        : Array.isArray(trackingPayload.tag_tracking)
        ? trackingPayload.tag_tracking
        : [];
      var submissionsRowsRaw = Array.isArray(submissionsPayload)
        ? submissionsPayload
        : Array.isArray(submissionsPayload.rows)
        ? submissionsPayload.rows
        : Array.isArray(submissionsPayload.submissions)
        ? submissionsPayload.submissions
        : [];

      state.tagTrackingRows = trackingRowsRaw.map(normalizeTagTrackingRow).filter(function (row) {
        return !!(row.player_id && row.franchise_id);
      });
      state.tagTrackingMeta = trackingPayload && trackingPayload.meta ? trackingPayload.meta : {};
      state.tagExternalSubmissions = submissionsRowsRaw.map(normalizeTagSubmissionEntry).filter(function (row) {
        return !!(row.player_id && row.franchise_id);
      });
      syncTagPlanFromSources();
      state.tagDataLoading = false;
      state.tagDataError = "";
      state.tagDataPromise = null;
      if (state.view === "tag") {
        renderToolbar();
        renderTeams();
      }
      return state.tagData;
    }).catch(function (err) {
      state.tagDataLoading = false;
      state.tagDataError = "Unable to load tag plan data. " + summarizeError(err);
      state.tagDataPromise = null;
      if (state.view === "tag") {
        renderToolbar();
        renderTeams();
      }
      throw err;
    });

    return state.tagDataPromise;
  }

  function pointsHistoryMeta() {
    return (state.pointsHistory && state.pointsHistory.meta) || {};
  }

  function historyFieldIndex(fields, name) {
    var list = Array.isArray(fields) ? fields : [];
    for (var i = 0; i < list.length; i += 1) {
      if (safeStr(list[i]) === safeStr(name)) return i;
    }
    return -1;
  }

  function pointsHistoryWeeklyFieldIndex(name) {
    return historyFieldIndex(pointsHistoryMeta().weekly_fields, name);
  }

  function weeklyHistoryFieldValue(row, fieldName, fallbackIndex) {
    if (!Array.isArray(row)) return null;
    var index = pointsHistoryWeeklyFieldIndex(fieldName);
    if (index < 0) index = safeInt(fallbackIndex, -1);
    if (index < 0 || index >= row.length) return null;
    return row[index];
  }

  function weeklyHistoryBucketLabel(row) {
    var bucketValue = weeklyHistoryFieldValue(row, "pos_bucket", -1);
    if (bucketValue == null || bucketValue === "") return "";
    var labelMap = pointsHistoryMeta().pos_bucket_codes || {};
    var mapped = labelMap[safeStr(bucketValue)];
    return safeStr(mapped != null ? mapped : bucketValue).toLowerCase();
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

  function rosteredHistorySeasonBounds() {
    if (!state.pointsHistory || !state.teams.length) return null;
    var minSeason = 0;
    var maxSeason = 0;
    for (var i = 0; i < state.teams.length; i += 1) {
      var players = state.teams[i] && state.teams[i].players ? state.teams[i].players : [];
      for (var j = 0; j < players.length; j += 1) {
        var record = playerPointsHistoryRecord(players[j]);
        if (!record || !record.y) continue;
        var seasons = Object.keys(record.y);
        for (var k = 0; k < seasons.length; k += 1) {
          var season = safeInt(seasons[k], 0);
          if (!season) continue;
          if (!minSeason || season < minSeason) minSeason = season;
          if (!maxSeason || season > maxSeason) maxSeason = season;
        }
      }
    }
    if (!minSeason || !maxSeason) return null;
    if (!siteIsOffseason()) {
      var liveSeason = safeInt(liveSeasonKey(), 0);
      if (liveSeason > maxSeason) maxSeason = liveSeason;
    }
    return {
      min: String(minSeason),
      max: String(maxSeason)
    };
  }

  function historySeasonsAscending() {
    var meta = pointsHistoryMeta();
    var raw = Array.isArray(meta.history_seasons) ? meta.history_seasons.slice() : [];
    if (state.pointYears && state.pointYears.length) {
      raw = raw.concat(state.pointYears);
    }
    var liveSeason = liveSeasonKey();
    if (liveSeason && !siteIsOffseason()) raw.push(liveSeason);
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
    var bounds = rosteredHistorySeasonBounds();
    if (bounds) {
      raw = raw.filter(function (season) {
        var seasonNum = safeInt(season, 0);
        return seasonNum >= safeInt(bounds.min, 0) && seasonNum <= safeInt(bounds.max, 0);
      });
    }
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

  function formatStartRatio(starts, appearances) {
    var startCount = Math.max(0, safeInt(starts, 0));
    var playedCount = Math.max(0, safeInt(appearances, 0));
    if (playedCount <= 0) return "—";
    return String(startCount) + "/" + String(playedCount);
  }

  function formatYesNo(value) {
    if (value === 1 || value === true) return "Yes";
    if (value === 0 || value === false) return "No";
    return "—";
  }

  function formatTier(value) {
    var tier = safeStr(value).toLowerCase();
    if (!tier) return "—";
    if (tier === "elite") return "Elite";
    if (tier === "plus") return "Plus";
    if (tier === "neutral") return "Neutral";
    if (tier === "dud") return "Dud";
    return tier.charAt(0).toUpperCase() + tier.slice(1);
  }

  function historyBadgeHtml(text, toneClass, title) {
    var label = safeStr(text) || "—";
    var cls = "rwb-points-history-badge" + (toneClass ? (" " + toneClass) : "");
    return '<span class="' + escapeHtml(cls) + '"' + (title ? ' title="' + escapeHtml(title) + '"' : "") + '>' + escapeHtml(label) + '</span>';
  }

  function posScoreBadgeHtml(value) {
    if (value == null || value === "") return "—";
    var num = Number(value);
    if (!isFinite(num)) return "—";
    var rounded = Math.round(num * 100) / 100;
    if (Math.abs(rounded) < 0.005) rounded = 0;
    var display = Math.abs(rounded).toFixed(2);
    var toneClass = "is-neutral";
    if (rounded > 0) toneClass = "is-positive";
    else if (rounded < 0) toneClass = "is-negative";
    return historyBadgeHtml(display, toneClass, rounded > 0 ? ("+" + display) : (rounded < 0 ? ("-" + display) : display));
  }

  function startedBadgeHtml(value) {
    if (value == null || value === "") return "—";
    var started = safeInt(value, -1);
    if (started === 1) return historyBadgeHtml("Start", "is-start");
    if (started === 0) return historyBadgeHtml("Bench", "is-bench");
    return "—";
  }

  function tierBadgeHtml(value) {
    var tier = safeStr(value).toLowerCase();
    if (!tier) return "—";
    var toneClass = "is-neutral";
    if (tier === "elite") toneClass = "is-elite";
    else if (tier === "dud") toneClass = "is-dud";
    return historyBadgeHtml(formatTier(tier), toneClass);
  }

  function formatEliteNeutralDudSummary(eliteWeeks, neutralWeeks, dudWeeks) {
    return [
      String(Math.max(0, safeInt(eliteWeeks, 0))),
      String(Math.max(0, safeInt(neutralWeeks, 0))),
      String(Math.max(0, safeInt(dudWeeks, 0)))
    ].join(" / ");
  }

  function pointsStatWithRankHtml(valueText, rank) {
    var text = safeStr(valueText);
    var rankValue = safeInt(rank, 0);
    if (!text || text === "—" || rankValue <= 0) return escapeHtml(text || "—");
    return (
      '<div class="rwb-points-stat-wrap">' +
        '<span class="rwb-points-stat-main">' + escapeHtml(text) + '</span>' +
        '<span class="rwb-points-stat-sub">' + escapeHtml(formatRank(rankValue)) + '</span>' +
      '</div>'
    );
  }

  function compactContractAmount(amount) {
    var dollars = Math.round(safeNum(amount, 0));
    if (dollars <= 0) return "—";
    return formatContractK(dollars);
  }

  function compactContractAmountAllowZero(amount) {
    return formatContractK(Math.max(0, Math.round(safeNum(amount, 0))));
  }

  function compactContractValueWithRankHtml(amount, rank) {
    return pointsStatWithRankHtml(compactContractAmount(amount), rank);
  }

  function compactContractValueWithRankText(amount, rank) {
    var valueText = compactContractAmount(amount);
    var rankValue = safeInt(rank, 0);
    if (valueText === "—") return "—";
    if (rankValue <= 0) return valueText;
    return valueText + " " + formatRank(rankValue);
  }

  function capPenaltyAmountForPlayer(player) {
    return safeInt(dropPenaltyEstimate(player).amount, 0);
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

  function readLocalJson(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function writeLocalJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value || {}));
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

  function resolveWorkerRestructureEndpoint() {
    var candidates = [
      window.UPS_OFFER_RESTRUCTURE_URL,
      window.UPS_RESTRUCTURE_API,
      window.UPS_CCC_RESTRUCTURE_URL
    ];
    for (var i = 0; i < candidates.length; i += 1) {
      var raw = safeStr(candidates[i]);
      if (!raw) continue;
      return raw;
    }
    try {
      var u = new URL(resolveWorkerApiEndpoint(), window.location.href);
      if (/\/roster-workbench(?:\/action)?\/?$/i.test(safeStr(u.pathname))) {
        u.pathname = safeStr(u.pathname).replace(/\/roster-workbench(?:\/action)?\/?$/i, "/offer-restructure");
      } else {
        u.pathname = safeStr(u.pathname).replace(/\/+$/, "") + "/offer-restructure";
      }
      return u.toString();
    } catch (e) {
      var rawApi = safeStr(resolveWorkerApiEndpoint());
      if (/\/roster-workbench(?:\/action)?\/?$/i.test(rawApi)) {
        return rawApi.replace(/\/roster-workbench(?:\/action)?\/?$/i, "/offer-restructure");
      }
      return rawApi.replace(/\/+$/, "") + "/offer-restructure";
    }
  }

  function resolveWorkerAdminStateEndpoint() {
    try {
      var u = new URL(resolveWorkerApiEndpoint(), window.location.href);
      if (/\/roster-workbench(?:\/action)?\/?$/i.test(safeStr(u.pathname))) {
        u.pathname = safeStr(u.pathname).replace(/\/roster-workbench(?:\/action)?\/?$/i, "/roster-workbench/admin-state");
      } else {
        u.pathname = safeStr(u.pathname).replace(/\/+$/, "") + "/roster-workbench/admin-state";
      }
      return u.toString();
    } catch (e) {
      var raw = safeStr(resolveWorkerApiEndpoint());
      if (/\/roster-workbench(?:\/action)?\/?$/i.test(raw)) {
        return raw.replace(/\/roster-workbench(?:\/action)?\/?$/i, "/roster-workbench/admin-state");
      }
      return raw.replace(/\/+$/, "") + "/roster-workbench/admin-state";
    }
  }

  function appendViewerSessionQuery(url) {
    var next = new URL(url.toString(), window.location.href);
    var mflUserId = readCookie("MFL_USER_ID");
    var apiKey = resolveApiKey();
    if (mflUserId) next.searchParams.set("MFL_USER_ID", mflUserId);
    if (apiKey) next.searchParams.set("APIKEY", apiKey);
    return next;
  }

  function loadViewerAdminState(ctx) {
    if (!ctx || !ctx.leagueId || !ctx.year) {
      state.viewerIsAdmin = false;
      state.viewerAdminReason = "";
      state.viewerAdminReady = true;
      state.viewerCommishFranchiseId = "";
      return Promise.resolve({
        ok: false,
        isAdmin: false,
        reason: "Missing league context",
        commishFranchiseId: ""
      });
    }

    var url = appendViewerSessionQuery(resolveWorkerAdminStateEndpoint());
    url.searchParams.set("L", safeStr(ctx.leagueId));
    url.searchParams.set("YEAR", safeStr(ctx.year));
    return fetchJson(url.toString(), { credentials: "omit", cache: "no-store" }).then(function (payload) {
      state.viewerIsAdmin = !!(payload && payload.ok && payload.isAdmin);
      state.viewerAdminReason = safeStr(payload && payload.reason);
      state.viewerAdminReady = true;
      state.viewerCommishFranchiseId = pad4(payload && payload.commishFranchiseId);
      return payload || {};
    }).catch(function (err) {
      state.viewerIsAdmin = false;
      state.viewerAdminReason = "Unable to verify commissioner access. " + summarizeError(err);
      state.viewerAdminReady = true;
      state.viewerCommishFranchiseId = "";
      return {
        ok: false,
        isAdmin: false,
        reason: state.viewerAdminReason,
        commishFranchiseId: ""
      };
    });
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

  function emptySalaryAdjustmentBreakdown() {
    return {
      cutPlayers: 0,
      tradedSalary: 0,
      other: 0
    };
  }

  function cloneSalaryAdjustmentBreakdown(input) {
    var source = input || emptySalaryAdjustmentBreakdown();
    return {
      cutPlayers: safeInt(source.cutPlayers, 0),
      tradedSalary: safeInt(source.tradedSalary, 0),
      other: safeInt(source.other, 0)
    };
  }

  function salaryAdjustmentCategory(explanation) {
    var text = safeStr(explanation).toLowerCase();
    if (!text) return "other";
    if (
      text.indexOf("type=trade") !== -1 ||
      text.indexOf("tradedsalary") !== -1 ||
      text.indexOf("traded salary") !== -1 ||
      text.indexOf("trade salary") !== -1 ||
      text.indexOf("trade settlement") !== -1
    ) {
      return "tradedSalary";
    }
    if (
      text.indexOf("type=cut") !== -1 ||
      text.indexOf("cap_penalt") !== -1 ||
      text.indexOf("cap penalty") !== -1 ||
      text.indexOf("dead cap") !== -1 ||
      text.indexOf("cut") !== -1 ||
      text.indexOf("drop") !== -1
    ) {
      return "cutPlayers";
    }
    return "other";
  }

  function normalizeSalaryAdjustmentBreakdownPayload(payload, totalFallback) {
    var breakdown = emptySalaryAdjustmentBreakdown();
    if (payload && typeof payload === "object") {
      breakdown.cutPlayers = safeInt(
        payload.cutPlayers != null ? payload.cutPlayers :
        (payload.cut_players_dollars != null ? payload.cut_players_dollars :
        (payload.capPenalty != null ? payload.capPenalty : payload.cap_penalty_dollars)),
        0
      );
      breakdown.tradedSalary = safeInt(
        payload.tradedSalary != null ? payload.tradedSalary :
        (payload.traded_salary_dollars != null ? payload.traded_salary_dollars :
        (payload.trade != null ? payload.trade : payload.trade_dollars)),
        0
      );
      breakdown.other = safeInt(
        payload.other != null ? payload.other :
        (payload.other_dollars != null ? payload.other_dollars : payload.misc),
        0
      );
    }
    var total = safeInt(totalFallback, 0);
    var summed = breakdown.cutPlayers + breakdown.tradedSalary + breakdown.other;
    if (summed === 0 && total !== 0) {
      breakdown.other = total;
    } else if (summed !== total) {
      breakdown.other += (total - summed);
    }
    return breakdown;
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

  function toSalaryAdjustmentSummary(payload) {
    var rows = collectSalaryAdjustmentRows(
      (payload && (payload.salaryAdjustments || payload.salaryadjustments)) || payload || {},
      []
    );
    var byFranchise = Object.create(null);
    var breakdownByFranchise = Object.create(null);
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i] || {};
      var fid = pad4(row.franchise_id);
      if (!fid) continue;
      if (!breakdownByFranchise[fid]) breakdownByFranchise[fid] = emptySalaryAdjustmentBreakdown();
      byFranchise[fid] = safeInt(byFranchise[fid], 0) + safeInt(row.amount, 0);
      breakdownByFranchise[fid][salaryAdjustmentCategory(row.explanation)] += safeInt(row.amount, 0);
    }
    return {
      byFranchise: byFranchise,
      breakdownByFranchise: breakdownByFranchise
    };
  }

  function reportSalaryAdjustmentBucket(row) {
    var bucket = safeStr(row && row.bucket).toLowerCase();
    if (bucket === "traded_salary" || bucket === "cut_players" || bucket === "other") return bucket;
    var adjustmentType = safeStr(row && row.adjustment_type).toUpperCase();
    if (adjustmentType === "TRADED_SALARY") return "traded_salary";
    if (adjustmentType === "DROP_PENALTY_CANDIDATE") return "cut_players";
    return "other";
  }

  function reportSalaryAdjustmentImportEligible(row) {
    if (!row || typeof row !== "object") return false;
    if (row.import_eligible != null) {
      var raw = row.import_eligible;
      if (raw === true || raw === 1) return true;
      var text = safeStr(raw).toLowerCase();
      return text === "true" || text === "1" || text === "yes";
    }
    var status = safeStr(row.status).toLowerCase();
    var amount = safeInt(row.amount, 0);
    if (!amount) return false;
    if (status === "review_required") return false;
    return reportSalaryAdjustmentBucket(row) === "traded_salary" || reportSalaryAdjustmentBucket(row) === "cut_players";
  }

  function normalizeReportSalaryAdjustmentRow(row) {
    return {
      ledger_key: safeStr(row && row.ledger_key),
      franchise_id: pad4(row && row.franchise_id),
      franchise_name: safeStr(row && row.franchise_name),
      player_id: safeStr(row && row.player_id),
      player_name: safeStr(row && row.player_name),
      adjustment_type: safeStr(row && row.adjustment_type),
      bucket: reportSalaryAdjustmentBucket(row),
      amount: safeInt(row && row.amount, 0),
      status: safeStr(row && row.status),
      source_id: safeStr(row && row.source_id),
      source_season: safeInt(row && row.source_season, 0),
      import_eligible: reportSalaryAdjustmentImportEligible(row),
      import_explanation: safeStr(row && row.import_explanation),
      import_target_season: safeInt((row && (row.import_target_season != null ? row.import_target_season : row.adjustment_season)), 0),
      description: safeStr(row && row.description)
    };
  }

  function toReportSalaryAdjustmentSummary(rows, season) {
    var out = {
      byFranchise: Object.create(null),
      rowsByFranchise: Object.create(null),
      season: safeInt(season, 0)
    };
    var list = asArray(rows);
    for (var i = 0; i < list.length; i += 1) {
      var row = normalizeReportSalaryAdjustmentRow(list[i]);
      var fid = pad4(row.franchise_id);
      if (!fid || !row.import_eligible) continue;
      var targetSeason = safeInt(row.import_target_season || season, 0);
      if (safeInt(season, 0) > 0 && targetSeason > 0 && targetSeason !== safeInt(season, 0)) continue;
      if (!out.byFranchise[fid]) out.byFranchise[fid] = cloneSalaryAdjustmentBreakdown(emptySalaryAdjustmentBreakdown());
      if (!out.rowsByFranchise[fid]) out.rowsByFranchise[fid] = [];
      if (row.bucket === "traded_salary") out.byFranchise[fid].tradedSalary += safeInt(row.amount, 0);
      else if (row.bucket === "cut_players") out.byFranchise[fid].cutPlayers += safeInt(row.amount, 0);
      else out.byFranchise[fid].other += safeInt(row.amount, 0);
      out.rowsByFranchise[fid].push(row);
    }
    return out;
  }

  function mergeReportSalaryAdjustmentsIntoTeams(teams, reportPayload, season, capAmount) {
    var list = asArray(teams);
    if (!list.length) return;
    var reportLoaded = !!(reportPayload && reportPayload.loaded);
    if (!reportLoaded) return;
    var reportRows = asArray(reportPayload && reportPayload.rows);
    var reportSummary = toReportSalaryAdjustmentSummary(reportRows, season);
    for (var i = 0; i < list.length; i += 1) {
      var team = list[i] || {};
      if (!team.summary) team.summary = {};
      var fid = pad4(team.id || team.fid);
      var existingBreakdown = cloneSalaryAdjustmentBreakdown(team.summary.salaryAdjustmentBreakdown);
      var reportBreakdown = cloneSalaryAdjustmentBreakdown(reportSummary.byFranchise[fid]);
      var mergedBreakdown = {
        tradedSalary: safeInt(reportBreakdown.tradedSalary, 0),
        cutPlayers: safeInt(reportBreakdown.cutPlayers, 0),
        other: safeInt(existingBreakdown.other, 0)
      };
      team.summary.salaryAdjustmentBreakdown = mergedBreakdown;
      team.summary.salaryAdjustmentTotal =
        safeInt(mergedBreakdown.tradedSalary, 0) +
        safeInt(mergedBreakdown.cutPlayers, 0) +
        safeInt(mergedBreakdown.other, 0);
      team.summary.salaryAdjustmentRows = (reportSummary.rowsByFranchise[fid] || []).slice();
      team.summary.salaryAdjustmentSource = {
        reportLoaded: reportLoaded,
        reportSeason: safeInt(season, 0),
        rowCount: team.summary.salaryAdjustmentRows.length,
        manualOtherDollars: safeInt(mergedBreakdown.other, 0)
      };
      team.summary.compliance = deriveCompliance(
        safeInt(team.summary.capTotal, 0) + safeInt(team.summary.salaryAdjustmentTotal, 0),
        capAmount
      );
    }
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
        abbrev: safeStr(f.abbrev),
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

  function buildTeams(rostersPayload, leagueMeta, playersMap, scores, byes, salaryMap, salaryAdjustments, salaryAdjustmentBreakdowns, priorSalaryMap) {
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
        salary = displaySalaryFromContractInfo(special, years, salary);

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
      var salaryAdjustmentBreakdown = normalizeSalaryAdjustmentBreakdownPayload(
        salaryAdjustmentBreakdowns && salaryAdjustmentBreakdowns[fid],
        salaryAdjustmentTotal
      );
      var compliance = deriveCompliance(capTotal + salaryAdjustmentTotal, leagueMeta.capAmount);
      teams.push({
        id: fid,
        fid: fid,
        name: teamMeta.name,
        abbrev: safeStr(teamMeta.abbrev),
        logo: teamMeta.logo || teamMeta.icon || "",
        players: players,
        summary: {
          players: players.length,
          rosterPlayers: rosterCountForPlayers(players),
          taxi: taxiCount,
          ir: irCount,
          capTotal: capTotal,
          salaryAdjustmentTotal: salaryAdjustmentTotal,
          salaryAdjustmentBreakdown: salaryAdjustmentBreakdown,
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
    var special = safeStr(p.special || p.contract_info || "-") || "-";
    var years = safeInt(p.years, 0);
    var salary = displaySalaryFromContractInfo(special, years, safeInt(p.salary, 0));
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
      salary: salary,
      years: years,
      aav: safeInt(p.aav, 0) || currentAavForContractInfo(special),
      type: safeStr(p.type || p.contract_type || "-") || "-",
      special: special,
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
      var salaryAdjustmentBreakdown = normalizeSalaryAdjustmentBreakdownPayload(
        summary.salary_adjustment_breakdown_dollars || summary.salaryAdjustmentBreakdown,
        salaryAdjustmentTotal
      );
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
        abbrev: safeStr(team.franchise_abbrev || team.abbrev || ""),
        logo: safeStr(team.icon_url || team.logo || ""),
        players: players,
        summary: {
          players: summary.players == null ? players.length : safeInt(summary.players, players.length),
          rosterPlayers: summary.rosterPlayers == null ? rosterPlayersFromPlayers : safeInt(summary.rosterPlayers, rosterPlayersFromPlayers),
          taxi: taxiCount,
          ir: summary.ir == null ? irFromPlayers : safeInt(summary.ir, irFromPlayers),
          capTotal: capTotal,
          salaryAdjustmentTotal: salaryAdjustmentTotal,
          salaryAdjustmentBreakdown: salaryAdjustmentBreakdown,
          compliance: compliance
        }
      });
    }

    teams.sort(function (a, b) {
      return safeStr(a.name).localeCompare(safeStr(b.name));
    });
    return teams;
  }

  function assignPositionalContractRanks(teams) {
    var groups = Object.create(null);
    var list = Array.isArray(teams) ? teams : [];
    for (var i = 0; i < list.length; i += 1) {
      var players = list[i] && list[i].players ? list[i].players : [];
      for (var j = 0; j < players.length; j += 1) {
        var player = players[j];
        if (!player) continue;
        player.positionSalaryRank = 0;
        player.positionAavRank = 0;
        var key = safeStr(player.positionGroup).toUpperCase() || "OTHER";
        if (!groups[key]) groups[key] = [];
        groups[key].push(player);
      }
    }

    var keys = Object.keys(groups);
    for (var k = 0; k < keys.length; k += 1) {
      var bucket = groups[keys[k]] || [];
      bucket.slice().sort(function (a, b) {
        var delta = safeInt(b.salary, 0) - safeInt(a.salary, 0);
        if (delta !== 0) return delta;
        return compareText(a.name, b.name);
      }).forEach(function (player, index) {
        player.positionSalaryRank = index + 1;
      });

      bucket.slice().sort(function (a, b) {
        var delta = safeInt(b.aav, 0) - safeInt(a.aav, 0);
        if (delta !== 0) return delta;
        return compareText(a.name, b.name);
      }).forEach(function (player, index) {
        player.positionAavRank = index + 1;
      });
    }

    return list;
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

  function defaultPointsHistoryMode() {
    return "weekly";
  }

  function pointsHistoryDefaultContextKey() {
    return String(currentYearInt()) + ":" + (siteIsOffseason() ? "offseason" : "season") + ":weekly-default-v1";
  }

  function defaultWeeklyHistorySeason(seasons) {
    var list = Array.isArray(seasons) ? seasons : [];
    if (!list.length) return "";
    if (siteIsOffseason()) return safeStr(list[list.length - 1]);
    var liveSeason = liveSeasonKey();
    if (liveSeason && list.indexOf(liveSeason) !== -1) return liveSeason;
    return safeStr(list[list.length - 1]);
  }

  function ensurePointsHistorySelection() {
    var seasons = historySeasonsAscending();
    if (!state.pointsHistoryMode || (state.pointsHistoryMode !== "yearly" && state.pointsHistoryMode !== "weekly")) {
      state.pointsHistoryMode = defaultPointsHistoryMode();
    }
    if (!seasons.length) return;

    if (!state.pointsHistoryYearStart || seasons.indexOf(state.pointsHistoryYearStart) === -1) {
      state.pointsHistoryYearStart = seasons[0];
    }
    if (!state.pointsHistoryYearEnd || seasons.indexOf(state.pointsHistoryYearEnd) === -1) {
      state.pointsHistoryYearEnd = seasons[seasons.length - 1];
    }

    if (!state.pointsHistorySeason || seasons.indexOf(state.pointsHistorySeason) === -1) {
      state.pointsHistorySeason = defaultWeeklyHistorySeason(seasons);
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
    if (state.view === "points" || state.view === "bye") {
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
      clearRosterPointsSummaryCache();
      clearPointsWeeklyRankCache();
      state.pointsMode = normalizeRosterPointMode(state.pointsMode);
      if (state.view === "points" || state.view === "bye") {
        renderToolbar();
        renderTeams();
        if (state.view === "points") ensureLiveSeasonPointsForSelection(false);
      }
      return state.pointsHistory;
    }).catch(function (err) {
      state.pointsHistoryLoading = false;
      state.pointsHistoryError = "Unable to load stored points history. " + summarizeError(err);
      state.pointsHistoryPromise = null;
      clearRosterPointsSummaryCache();
      clearPointsWeeklyRankCache();
      if (state.view === "points" || state.view === "bye") {
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
      weeklyByPlayer[pid][weekKey] = [score, 0, started, null, null, null, null];

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
      clearPointsWeeklyRankCache();
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
      clearPointsWeeklyRankCache();
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
    var eliteWeeks = 0;
    var dudWeeks = 0;

    for (var i = 0; i < years.length; i += 1) {
      var row = playerYearlyHistoryRow(player, years[i]);
      if (!row) continue;
      totalPoints += safeNum(row[0], 0);
      totalGames += safeInt(row[1], 0);
      if (safeInt(row[3], 0) > 0 && (!bestRank || safeInt(row[3], 0) < bestRank)) bestRank = safeInt(row[3], 0);
      if (safeInt(row[4], 0) > 0 && (!bestPpgRank || safeInt(row[4], 0) < bestPpgRank)) bestPpgRank = safeInt(row[4], 0);
      var seasonWeekSummary = seasonEliteWeekSummaryForPlayer(player, years[i]);
      eliteWeeks += safeInt(seasonWeekSummary.eliteWeeks, 0);
      dudWeeks += safeInt(seasonWeekSummary.dudWeeks, 0);
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
      eliteWeeks: eliteWeeks,
      neutralWeeks: 0,
      dudWeeks: dudWeeks,
      hasData: seasonsWithData > 0
    };
  }

  function seasonEliteWeekSummaryForPlayer(player, season) {
    var seasonKey = safeStr(season);
    var maxWeek = historySeasonWeekMax(seasonKey);
    var eliteWeeks = 0;
    var neutralWeeks = 0;
    var dudWeeks = 0;
    var bucketWeeks = 0;
    for (var week = 1; week <= maxWeek; week += 1) {
      var row = playerWeeklyHistoryRow(player, seasonKey, week);
      if (!row) continue;
      var bucket = weeklyHistoryBucketLabel(row);
      if (!bucket) continue;
      bucketWeeks += 1;
      if (bucket === "elite") eliteWeeks += 1;
      else if (bucket === "dud") dudWeeks += 1;
      else neutralWeeks += 1;
    }
    return {
      eliteWeeks: eliteWeeks,
      neutralWeeks: neutralWeeks,
      dudWeeks: dudWeeks,
      bucketWeeks: bucketWeeks
    };
  }

  function summarizeWeeklyPointsSelection(player) {
    var season = safeStr(state.pointsHistorySeason);
    var weeks = selectedHistoryWeeks();
    var totalPoints = 0;
    var appearances = 0;
    var starts = 0;
    var bestRank = 0;
    var eliteWeeks = 0;
    var neutralWeeks = 0;
    var dudWeeks = 0;

    for (var i = 0; i < weeks.length; i += 1) {
      var row = playerWeeklyHistoryRow(player, season, weeks[i]);
      if (!row) continue;
      totalPoints += safeNum(weeklyHistoryFieldValue(row, "points", 0), 0);
      appearances += 1;
      if (safeInt(weeklyHistoryFieldValue(row, "started", 2), 0) === 1) starts += 1;
      var rank = safeInt(weeklyHistoryFieldValue(row, "pos_rank", 1), 0);
      if (rank > 0 && (!bestRank || rank < bestRank)) bestRank = rank;
      var bucket = weeklyHistoryBucketLabel(row);
      if (bucket === "elite") eliteWeeks += 1;
      else if (bucket === "dud") dudWeeks += 1;
      else neutralWeeks += 1;
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
      eliteWeeks: eliteWeeks,
      neutralWeeks: neutralWeeks,
      dudWeeks: dudWeeks,
      hasData: appearances > 0
    };
  }

  function summarizePointsSelection(player) {
    if (state.pointsHistoryMode === "weekly") return summarizeWeeklyPointsSelection(player);
    return summarizeYearlyPointsSelection(player);
  }

  function pointsWeeklyRankCacheKey() {
    if (state.pointsHistoryMode !== "weekly") return "";
    var weeks = selectedHistoryWeeks();
    var overlayStamp = 0;
    if (
      state.liveSeasonPoints &&
      safeStr(state.liveSeasonPoints.season) === safeStr(state.pointsHistorySeason)
    ) {
      overlayStamp = safeInt(state.liveSeasonPoints.fetchedAtMs, 0);
    }
    return [
      safeStr(state.pointsHistorySeason),
      weeks.join(","),
      overlayStamp,
      safeInt(state.teams.length, 0)
    ].join("|");
  }

  function comparePointsSummaryTotals(a, b) {
    var pointsDelta = safeNum(b && b.points, 0) - safeNum(a && a.points, 0);
    if (Math.abs(pointsDelta) > 0.0001) return pointsDelta;
    var ppgDelta = safeNum(b && b.ppg, 0) - safeNum(a && a.ppg, 0);
    if (Math.abs(ppgDelta) > 0.0001) return ppgDelta;
    return compareText(a && a.name, b && b.name);
  }

  function comparePointsSummaryPpg(a, b) {
    var ppgDelta = safeNum(b && b.ppg, 0) - safeNum(a && a.ppg, 0);
    if (Math.abs(ppgDelta) > 0.0001) return ppgDelta;
    var pointsDelta = safeNum(b && b.points, 0) - safeNum(a && a.points, 0);
    if (Math.abs(pointsDelta) > 0.0001) return pointsDelta;
    return compareText(a && a.name, b && b.name);
  }

  function weeklySummaryRanksByPlayer() {
    if (state.pointsHistoryMode !== "weekly") {
      return {
        points: Object.create(null),
        ppg: Object.create(null)
      };
    }

    var cacheKey = pointsWeeklyRankCacheKey();
    if (state.pointsWeeklyRankCache && state.pointsWeeklyRankCacheKey === cacheKey) {
      return state.pointsWeeklyRankCache;
    }

    var byPosition = Object.create(null);
    var seenPlayers = Object.create(null);

    for (var t = 0; t < state.teams.length; t += 1) {
      var players = state.teams[t] && state.teams[t].players ? state.teams[t].players : [];
      for (var p = 0; p < players.length; p += 1) {
        var player = players[p];
        var playerId = safeStr(player && player.id);
        if (!playerId || seenPlayers[playerId]) continue;
        seenPlayers[playerId] = true;
        var summary = summarizeWeeklyPointsSelection(player);
        if (!summary.hasData) continue;
        var groupKey = safeStr(player && player.positionGroup).toUpperCase() || "OTHER";
        if (!byPosition[groupKey]) byPosition[groupKey] = [];
        byPosition[groupKey].push({
          id: playerId,
          name: safeStr(player && player.name),
          points: safeNum(summary.points, 0),
          ppg: safeNum(summary.ppg, 0)
        });
      }
    }

    var pointRanks = Object.create(null);
    var ppgRanks = Object.create(null);
    var groups = Object.keys(byPosition);
    for (var i = 0; i < groups.length; i += 1) {
      var items = byPosition[groups[i]] || [];
      items.slice().sort(comparePointsSummaryTotals).forEach(function (item, index) {
        pointRanks[item.id] = index + 1;
      });
      items.slice().sort(comparePointsSummaryPpg).forEach(function (item, index) {
        ppgRanks[item.id] = index + 1;
      });
    }

    state.pointsWeeklyRankCacheKey = cacheKey;
    state.pointsWeeklyRankCache = {
      points: pointRanks,
      ppg: ppgRanks
    };
    return state.pointsWeeklyRankCache;
  }

  function pointsYearlyEliteRankCacheKey() {
    if (state.pointsHistoryMode !== "yearly") return "";
    var years = selectedHistoryYears();
    var liveSeason = liveSeasonKey();
    var overlayStamp = 0;
    if (
      years.indexOf(liveSeason) !== -1 &&
      state.liveSeasonPoints &&
      safeStr(state.liveSeasonPoints.season) === liveSeason
    ) {
      overlayStamp = safeInt(state.liveSeasonPoints.fetchedAtMs, 0);
    }
    return [years.join(","), overlayStamp, safeInt(state.teams.length, 0)].join("|");
  }

  function yearlyEliteRanksBySeason() {
    if (state.pointsHistoryMode !== "yearly") return Object.create(null);
    var cacheKey = pointsYearlyEliteRankCacheKey();
    if (state.pointsYearlyEliteRankCache && state.pointsYearlyEliteRankCacheKey === cacheKey) {
      return state.pointsYearlyEliteRankCache;
    }

    var years = selectedHistoryYears();
    var bySeason = Object.create(null);
    var seenPlayers = Object.create(null);

    for (var t = 0; t < state.teams.length; t += 1) {
      var players = state.teams[t] && state.teams[t].players ? state.teams[t].players : [];
      for (var p = 0; p < players.length; p += 1) {
        var player = players[p];
        var playerId = safeStr(player && player.id);
        if (!playerId || seenPlayers[playerId]) continue;
        seenPlayers[playerId] = true;
        var groupKey = safeStr(player && player.positionGroup).toUpperCase() || "OTHER";
        for (var y = 0; y < years.length; y += 1) {
          var season = safeStr(years[y]);
          var eliteSummary = seasonEliteWeekSummaryForPlayer(player, season);
          if (safeInt(eliteSummary.bucketWeeks, 0) <= 0) continue;
          if (!bySeason[season]) bySeason[season] = Object.create(null);
          if (!bySeason[season][groupKey]) bySeason[season][groupKey] = [];
          var yearlyRow = playerYearlyHistoryRow(player, season);
          bySeason[season][groupKey].push({
            id: playerId,
            name: safeStr(player && player.name),
            eliteWeeks: safeInt(eliteSummary.eliteWeeks, 0),
            points: yearlyRow ? safeNum(yearlyRow[0], 0) : 0
          });
        }
      }
    }

    var rankMap = Object.create(null);
    var seasons = Object.keys(bySeason);
    for (var i = 0; i < seasons.length; i += 1) {
      var seasonKey = seasons[i];
      rankMap[seasonKey] = Object.create(null);
      var groups = Object.keys(bySeason[seasonKey] || {});
      for (var g = 0; g < groups.length; g += 1) {
        var items = bySeason[seasonKey][groups[g]] || [];
        items.slice().sort(function (a, b) {
          var eliteDelta = safeInt(b.eliteWeeks, 0) - safeInt(a.eliteWeeks, 0);
          if (eliteDelta !== 0) return eliteDelta;
          var pointsDelta = safeNum(b.points, 0) - safeNum(a.points, 0);
          if (Math.abs(pointsDelta) > 0.0001) return pointsDelta;
          return compareText(a.name, b.name);
        }).forEach(function (item, index) {
          rankMap[seasonKey][item.id] = index + 1;
        });
      }
    }

    state.pointsYearlyEliteRankCacheKey = cacheKey;
    state.pointsYearlyEliteRankCache = rankMap;
    return rankMap;
  }

  function rosterPointsSummaryForPlayer(player) {
    var pid = safeStr(player && player.id);
    if (!pid) {
      return {
        overallPoints: 0,
        overallGames: 0,
        overallPpg: 0,
        starterPoints: 0,
        starterGames: 0,
        starterPpg: 0,
        hasOverall: false,
        hasStarter: false
      };
    }

    var cacheKey = normalizeRosterPointMode(state.pointsMode);
    if (state.rosterPointsSummaryCacheKey !== cacheKey) {
      clearRosterPointsSummaryCache();
      state.rosterPointsSummaryCacheKey = cacheKey;
    }
    if (state.rosterPointsSummaryByPlayer[pid]) return state.rosterPointsSummaryByPlayer[pid];

    var seasons = rosterPointSeasonsForMode(cacheKey);
    var overallPoints = 0;
    var overallGames = 0;
    var starterPoints = 0;
    var starterGames = 0;

    for (var i = 0; i < seasons.length; i += 1) {
      var season = seasons[i];
      var yearly = playerYearlyHistoryRow(player, season);
      if (yearly) {
        overallPoints += safeNum(yearly[0], 0);
        overallGames += safeInt(yearly[1], 0);
      }

      var maxWeek = historySeasonWeekMax(season);
      for (var week = 1; week <= maxWeek; week += 1) {
        var weekly = playerWeeklyHistoryRow(player, season, week);
        if (!weekly || safeInt(weekly[2], 0) !== 1) continue;
        starterPoints += safeNum(weekly[0], 0);
        starterGames += 1;
      }
    }

    var summary = {
      overallPoints: overallPoints,
      overallGames: overallGames,
      overallPpg: overallGames > 0 ? (overallPoints / overallGames) : 0,
      starterPoints: starterPoints,
      starterGames: starterGames,
      starterPpg: starterGames > 0 ? (starterPoints / starterGames) : 0,
      hasOverall: overallGames > 0,
      hasStarter: starterGames > 0
    };
    state.rosterPointsSummaryByPlayer[pid] = summary;
    return summary;
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
    if (safeStr(state.pointsMode).toLowerCase() === "historical") {
      return Promise.resolve();
    }
    if (state.pointsMode === "cumulative") {
      var years = state.pointYears && state.pointYears.length ? state.pointYears.slice() : buildPointYears();
      return Promise.all(years.map(ensureGamesLoadedForYear));
    }
    var year = safeStr(state.pointsMode || (state.pointYears[0] || state.ctx.year));
    return ensureGamesLoadedForYear(year);
  }

  function pointsForPlayer(player) {
    if (!player) return 0;
    if (safeStr(state.pointsMode).toLowerCase() === "historical") {
      return safeNum(rosterPointsSummaryForPlayer(player).overallPoints, 0);
    }
    if (state.pointsMode === "cumulative") return safeNum(player.pointsCumulative, 0);

    var key = safeStr(state.pointsMode || (state.pointYears[0] || state.ctx.year));
    if (!key) return 0;

    var map = player.pointsByYear || {};
    if (map[key] == null) return 0;
    return safeNum(map[key], 0);
  }

  function gamesForPlayer(player) {
    if (!player) return 0;
    if (safeStr(state.pointsMode).toLowerCase() === "historical") {
      return safeInt(rosterPointsSummaryForPlayer(player).overallGames, 0);
    }
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
        key: view === "franchise" ? "franchise" : (view === "contract" ? "player" : (view === "points" ? "points" : "salary")),
        dir: view === "roster" || view === "points" ? "desc" : "asc"
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
      if (!!a.isTaxi !== !!b.isTaxi) return a.isTaxi ? 1 : -1;
      var delta = 0;
      switch (sort.key) {
        case "contract_length":
          delta = contractLengthForPlayer(a) - contractLengthForPlayer(b);
          break;
        case "years":
          delta = safeInt(a.years, 0) - safeInt(b.years, 0);
          break;
        case "guarantee":
          delta = guaranteedContractValueForPlayer(a) - guaranteedContractValueForPlayer(b);
          break;
        case "penalty":
          delta = capPenaltyAmountForPlayer(a) - capPenaltyAmountForPlayer(b);
          break;
        case "salary":
          delta = safeInt(a.salary, 0) - safeInt(b.salary, 0);
          break;
        case "salary_rank":
          delta = safeInt(a.positionSalaryRank || 999999, 999999) - safeInt(b.positionSalaryRank || 999999, 999999);
          break;
        case "aav":
          delta = safeInt(a.aav, 0) - safeInt(b.aav, 0);
          break;
        case "aav_rank":
          delta = safeInt(a.positionAavRank || 999999, 999999) - safeInt(b.positionAavRank || 999999, 999999);
          break;
        case "tcv":
          delta = totalContractValueForPlayer(a) - totalContractValueForPlayer(b);
          break;
        case "type":
          delta = compareText(a.type, b.type);
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
        case "position":
          delta = positionSortValue(a.positionGroup) - positionSortValue(b.positionGroup);
          if (delta === 0) delta = compareText(a.positionGroup, b.positionGroup);
          break;
        case "tcv":
          delta = totalContractValueForPlayer(a) - totalContractValueForPlayer(b);
          break;
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
          if (state.pointsHistoryMode === "weekly") {
            delta = safeInt(aSummary.eliteWeeks, 0) - safeInt(bSummary.eliteWeeks, 0);
            if (delta === 0) delta = safeInt(aSummary.neutralWeeks, 0) - safeInt(bSummary.neutralWeeks, 0);
            if (delta === 0) delta = safeInt(bSummary.dudWeeks, 0) - safeInt(aSummary.dudWeeks, 0);
            if (delta === 0) delta = safeNum(aSummary.points, 0) - safeNum(bSummary.points, 0);
          } else {
            var aRank = safeInt(aSummary.bestRank, 999999);
            var bRank = safeInt(bSummary.bestRank, 999999);
            delta = aRank - bRank;
          }
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

  function matchesFilters(player, options) {
    var opts = options && typeof options === "object" ? options : {};
    if (!player) return false;

    if (!opts.skipSearch && searchFilterEnabledForView() && state.search) {
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

    if (contractTypeFilterEnabledForView() && state.filterType && contractBucket(player.type) !== state.filterType) {
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

    if (!opts.skipContractAction && contractActionFilterEnabledForView() && state.filterContractAction && !playerMatchesContractActionFilter(player, state.filterContractAction)) {
      return false;
    }

    return true;
  }

  function renderDatalistOptions(listEl, values) {
    if (!listEl) return;
    var items = Array.isArray(values) ? values : [];
    listEl.innerHTML = items.map(function (value) {
      return '<option value="' + escapeHtml(safeStr(value)) + '"></option>';
    }).join("");
  }

  function searchSuggestionMatches(value, query) {
    var q = safeStr(query).trim().toLowerCase();
    var text = safeStr(value).trim().toLowerCase();
    if (!q || !text) return false;
    if (text.indexOf(q) === 0) return true;
    var parts = text.split(/[\s,./-]+/);
    for (var i = 0; i < parts.length; i += 1) {
      if (parts[i] && parts[i].indexOf(q) === 0) return true;
    }
    return false;
  }

  function currentSearchSuggestions(query) {
    var q = safeStr(query).trim().toLowerCase();
    if (!q) return [];

    var selectedTeam = normalizedSelectedTeamId();
    var seen = Object.create(null);
    var results = [];

    function addSuggestion(value) {
      var label = safeStr(value).trim();
      var key = label.toLowerCase();
      if (!label || seen[key]) return;
      if (!searchSuggestionMatches(label, q)) return;
      seen[key] = true;
      results.push(label);
    }

    if (state.view === "tag" && !tagBreakdownActive()) {
      var tagRows = currentTagPlanRows();
      for (var r = 0; r < tagRows.length; r += 1) {
        var tagRow = tagRows[r] || {};
        if (selectedTeam !== ALL_TEAMS_VALUE && pad4(tagRow.franchise_id) !== selectedTeam) continue;
        if (!tagRowMatchesFilters(tagRow, { skipSearch: true })) continue;
        addSuggestion(tagRow.player_name);
      }
    } else {
      var teams = scopedTeamsForDisplay();
      for (var t = 0; t < teams.length; t += 1) {
        var players = teams[t] && teams[t].players ? teams[t].players : [];
        for (var p = 0; p < players.length; p += 1) {
          var player = players[p] || {};
          if (!matchesFilters(player, { skipSearch: true })) continue;
          addSuggestion(player.name);
        }
      }
    }

    results.sort(compareText);
    return results.slice(0, 12);
  }

  function renderSearchSuggestions() {
    var suggestions = currentSearchSuggestions(state.search);
    renderDatalistOptions(els.searchSuggestions, suggestions);
    renderDatalistOptions(els.browseSearchSuggestions, suggestions);
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
            '<div class="rwb-hero-main">' +
              '<div class="rwb-hero-copy">' +
                '<div class="rwb-hero-eyebrow">UPS League Office</div>' +
                '<h1 class="rwb-title">Front Office</h1>' +
                '<div class="rwb-hero-subtitle">Contracts, cap planning, roster actions, and deadline context in one place.</div>' +
              '</div>' +
            '</div>' +
          '</header>' +
          '<section class="rwb-toolbar" aria-label="Roster toolbar">' +
            '<div class="rwb-toolbar-topline">' +
              '<div class="rwb-toolbar-note" id="rwbToolbarNote">Loading roster data...</div>' +
            '</div>' +
            '<div class="rwb-toolbar-main" id="rwbToolbarMain">' +
              '<div class="rwb-toolbar-panel rwb-toolbar-panel-nav">' +
                '<div class="rwb-toolbar-section-label">Views</div>' +
                '<div class="rwb-view-switch" role="tablist" aria-label="View mode">' +
                  '<button type="button" id="rwbViewRoster" class="rwb-btn rwb-btn-ghost is-active" data-action="view-switch" data-view="roster" role="tab" aria-selected="true">Contract View</button>' +
                  '<button type="button" id="rwbViewContract" class="rwb-btn rwb-btn-ghost" data-action="view-switch" data-view="contract" role="tab" aria-selected="false">Cap Plan</button>' +
                  '<button type="button" id="rwbViewTag" class="rwb-btn rwb-btn-ghost" data-action="view-switch" data-view="tag" role="tab" aria-selected="false">Tagging</button>' +
                  '<button type="button" id="rwbViewPoints" class="rwb-btn rwb-btn-ghost" data-action="view-switch" data-view="points" role="tab" aria-selected="false">Scoring</button>' +
                  '<button type="button" id="rwbViewBye" class="rwb-btn rwb-btn-ghost" data-action="view-switch" data-view="bye" role="tab" aria-selected="false">Bye Chart</button>' +
                '</div>' +
              '</div>' +
              '<div class="rwb-toolbar-panel rwb-toolbar-panel-browse">' +
                '<div class="rwb-toolbar-section-label">Browse</div>' +
                '<div class="rwb-toolbar-browse-grid" id="rwbToolbarBrowseGrid">' +
                  '<label class="rwb-field"><span>Team</span><select id="rwbJumpTeam" class="rwb-select"><option value="">Select team...</option></select></label>' +
                  '<div id="rwbPointsControls" class="rwb-toolbar-points"></div>' +
                '</div>' +
                '<div class="rwb-browse-controls" id="rwbFiltersToggleWrap">' +
                  '<button type="button" id="rwbToggleFilters" class="rwb-btn rwb-btn-ghost rwb-toolbar-disclosure-btn" aria-expanded="false" aria-controls="rwbAdvancedFilters">Filters</button>' +
                  '<button type="button" id="rwbResetFilters" class="rwb-btn rwb-btn-ghost">Clear Filters</button>' +
                '</div>' +
              '</div>' +
            '</div>' +
            '<div id="rwbAdvancedFilters" class="rwb-toolbar-advanced">' +
              '<div class="rwb-toolbar-panel rwb-toolbar-panel-filters">' +
                '<div class="rwb-toolbar-section-label">Filters</div>' +
                '<div class="rwb-toolbar-filter-grid">' +
                  '<label class="rwb-field rwb-field-search"><span>Search</span><input id="rwbSearch" class="rwb-input" type="search" placeholder="Player, team, or contract" autocomplete="off" list="rwbSearchSuggestions"><datalist id="rwbSearchSuggestions"></datalist></label>' +
                  '<label class="rwb-field"><span>Position</span><select id="rwbFilterPosition" class="rwb-select"><option value="">All Groups</option></select></label>' +
                  '<label class="rwb-field"><span>Contract</span><select id="rwbFilterType" class="rwb-select"><option value="">All Contract Types</option></select></label>' +
                  '<label class="rwb-field"><span>Roster Status</span><select id="rwbFilterRosterStatus" class="rwb-select"><option value="">All</option></select></label>' +
                  '<label class="rwb-field"><span>Contract Options</span><select id="rwbFilterContractAction" class="rwb-select"><option value="">All Contract Options</option></select></label>' +
                  '<label class="rwb-field" hidden style="display:none" aria-hidden="true"><span>Impact</span><select id="rwbFilterByeImpact" class="rwb-select" disabled><option value="">All Impact</option></select></label>' +
                '</div>' +
                '<div class="rwb-toolbar-filter-footer"></div>' +
              '</div>' +
            '</div>' +
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
    els.jumpTeamField = els.jumpTeam ? els.jumpTeam.closest(".rwb-field") : null;
    els.browsePanel = els.jumpTeam ? els.jumpTeam.closest(".rwb-toolbar-panel") : null;
    els.browseGrid = document.getElementById("rwbToolbarBrowseGrid");
    els.pointsControls = document.getElementById("rwbPointsControls");
    els.browseSearch = null;
    els.pointsMode = null;
    els.pointsHistoryMode = null;
    els.pointsHistoryYearStart = null;
    els.pointsHistoryYearEnd = null;
    els.pointsHistorySeason = null;
    els.pointsHistoryWeekStart = null;
    els.pointsHistoryWeekEnd = null;
    els.tagDisplayYear = null;
    els.search = document.getElementById("rwbSearch");
    els.searchSuggestions = document.getElementById("rwbSearchSuggestions");
    els.searchField = els.search ? els.search.closest(".rwb-field") : null;
    els.advanced = document.getElementById("rwbAdvancedFilters");
    els.toggleFiltersWrap = document.getElementById("rwbFiltersToggleWrap");
    els.toggleFilters = document.getElementById("rwbToggleFilters");
    els.filterPosition = document.getElementById("rwbFilterPosition");
    els.filterPositionField = els.filterPosition ? els.filterPosition.closest(".rwb-field") : null;
    els.filterType = document.getElementById("rwbFilterType");
    els.filterTypeField = els.filterType ? els.filterType.closest(".rwb-field") : null;
    els.filterRosterStatus = document.getElementById("rwbFilterRosterStatus");
    els.filterRosterStatusField = els.filterRosterStatus ? els.filterRosterStatus.closest(".rwb-field") : null;
    els.filterContractAction = document.getElementById("rwbFilterContractAction");
    els.filterContractActionField = els.filterContractAction ? els.filterContractAction.closest(".rwb-field") : null;
    els.filterByeImpact = document.getElementById("rwbFilterByeImpact");
    els.filterByeImpactField = els.filterByeImpact ? els.filterByeImpact.closest(".rwb-field") : null;
    els.resetFilters = document.getElementById("rwbResetFilters");
    els.note = document.getElementById("rwbToolbarNote");
    els.status = document.getElementById("rwbStatus");
    els.teamList = document.getElementById("rwbTeamList");
    els.viewRoster = document.getElementById("rwbViewRoster");
    els.viewContract = document.getElementById("rwbViewContract");
    els.viewTag = document.getElementById("rwbViewTag");
    els.viewPoints = document.getElementById("rwbViewPoints");
    els.viewBye = document.getElementById("rwbViewBye");
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
    var contractActionCounts = Object.create(null);
    var teamsForFilters = scopedTeamsForDisplay();

    if (state.view === "tag" && state.tagData && state.tagData.rows) {
      for (var t = 0; t < state.tagData.rows.length; t += 1) {
        var tagRow = state.tagData.rows[t] || {};
        var tagGroup = safeStr(tagRow.positional_grouping || tagRow.position).toUpperCase();
        if (!tagGroup) continue;
        groupsMap[tagGroup] = true;
      }
    }

    for (var i = 0; i < teamsForFilters.length; i += 1) {
      var team = teamsForFilters[i] || {};
      var players = team.players || [];
      for (var j = 0; j < players.length; j += 1) {
        var player = players[j];
        var g = safeStr(player.positionGroup).toUpperCase();
        if (!g) continue;
        groupsMap[g] = true;
        if (!contractActionFilterEnabledForView()) continue;
        if (!matchesFilters(player, { skipContractAction: true })) continue;
        var actionFlags = playerContractActionFlags(player);
        for (var a = 1; a < CONTRACT_ACTION_FILTERS.length; a += 1) {
          var actionFilter = CONTRACT_ACTION_FILTERS[a];
          if (actionFlags[actionFilter.value]) {
            contractActionCounts[actionFilter.value] = safeInt(contractActionCounts[actionFilter.value], 0) + 1;
          }
        }
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
      ),
      contractActions: [CONTRACT_ACTION_FILTERS[0]].concat(
        CONTRACT_ACTION_FILTERS.slice(1)
          .filter(function (filterDef) { return safeInt(contractActionCounts[filterDef.value], 0) > 0; })
          .map(function (filterDef) {
            return {
              value: filterDef.value,
              label: filterDef.label + " (" + String(safeInt(contractActionCounts[filterDef.value], 0)) + ")"
            };
          })
      )
    };
  }

  function renderPointsControls() {
    if (!els.pointsControls) return;

    els.browseSearch = null;
    els.browseSearchSuggestions = null;
    els.pointsMode = null;
    els.pointsHistoryMode = null;
    els.pointsHistoryYearStart = null;
    els.pointsHistoryYearEnd = null;
    els.pointsHistorySeason = null;
    els.pointsHistoryWeekStart = null;
    els.pointsHistoryWeekEnd = null;
    els.pointsControls.hidden = !(scoringControlEnabledForView() || capPlanSubviewControlEnabledForView() || tagSubviewControlEnabledForView());

    if (!(scoringControlEnabledForView() || capPlanSubviewControlEnabledForView() || tagSubviewControlEnabledForView())) {
      els.pointsControls.className = "rwb-toolbar-points";
      els.pointsControls.innerHTML = "";
      return;
    }

    var browseSearchHtml =
      '<div class="rwb-toolbar-browse-search-wrap">' +
        '<label class="rwb-field rwb-field-search rwb-toolbar-browse-search">' +
          '<span>Player Search</span>' +
          '<input id="rwbBrowseSearch" class="rwb-input" type="search" placeholder="Search players..." autocomplete="off" list="rwbBrowseSearchSuggestions">' +
          '<datalist id="rwbBrowseSearchSuggestions"></datalist>' +
        '</label>' +
      '</div>';

    if (state.view === "contract") {
      var contractSubview = normalizeCapPlanSubview(state.contractSubView);
      els.pointsControls.className = "rwb-toolbar-points is-contract-view";
      els.pointsControls.hidden = false;
      els.pointsControls.innerHTML =
        '<div class="rwb-subview-switch" role="tablist" aria-label="Cap plan mode">' +
          '<button type="button" class="rwb-btn rwb-btn-ghost' + (contractSubview === "players" ? ' is-active' : '') + '" data-action="contract-subview" data-subview="players" role="tab" aria-selected="' + (contractSubview === "players" ? "true" : "false") + '">Player View</button>' +
          '<button type="button" class="rwb-btn rwb-btn-ghost' + (contractSubview === "summary" ? ' is-active' : '') + '" data-action="contract-subview" data-subview="summary" role="tab" aria-selected="' + (contractSubview === "summary" ? "true" : "false") + '">Summary View</button>' +
        '</div>';
      return;
    }

    if (state.view === "tag") {
      var tagSubview = normalizeTagSubview(state.tagSubView);
      els.pointsControls.className = "rwb-toolbar-points is-tag-view";
      els.pointsControls.hidden = false;
      els.pointsControls.innerHTML =
        '<div class="rwb-subview-switch" role="tablist" aria-label="Tag plan mode">' +
          '<button type="button" class="rwb-btn rwb-btn-ghost' + (tagSubview === "players" ? ' is-active' : '') + '" data-action="tag-subview" data-subview="players" role="tab" aria-selected="' + (tagSubview === "players" ? "true" : "false") + '">Eligible Players</button>' +
          '<button type="button" class="rwb-btn rwb-btn-ghost' + (tagSubview === "breakdown" ? ' is-active' : '') + '" data-action="tag-subview" data-subview="breakdown" role="tab" aria-selected="' + (tagSubview === "breakdown" ? "true" : "false") + '">Calc Breakdown</button>' +
        '</div>' +
        (tagSubview === "breakdown"
          ? '<label class="rwb-field"><span>Tag Year</span><select id="rwbTagDisplayYear" class="rwb-select"></select></label>'
          : "") +
        (tagSubview === "players" ? browseSearchHtml : "");
      els.tagDisplayYear = document.getElementById("rwbTagDisplayYear");
      if (els.tagDisplayYear) {
        renderSelectOptions(els.tagDisplayYear, tagDisplayYearOptions(), tagDisplaySeason());
      }
      els.browseSearch = document.getElementById("rwbBrowseSearch");
      els.browseSearchSuggestions = document.getElementById("rwbBrowseSearchSuggestions");
      return;
    }

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
        browseSearchHtml +
        '<div class="rwb-field rwb-field-mode-toggle">' +
          '<span>View</span>' +
          '<div class="rwb-points-mode-switch" role="tablist" aria-label="Scoring history mode">' +
            '<button type="button" class="rwb-btn rwb-btn-ghost' + (weeklyMode ? ' is-active' : '') + '" data-action="points-history-mode" data-mode="weekly" role="tab" aria-selected="' + (weeklyMode ? 'true' : 'false') + '">Weekly</button>' +
            '<button type="button" class="rwb-btn rwb-btn-ghost' + (!weeklyMode ? ' is-active' : '') + '" data-action="points-history-mode" data-mode="yearly" role="tab" aria-selected="' + (!weeklyMode ? 'true' : 'false') + '">Yearly</button>' +
          '</div>' +
        '</div>' +
        (weeklyMode
          ? '<label class="rwb-field"><span>Season</span><select id="rwbPointsHistorySeason" class="rwb-select"></select></label>' +
            '<label class="rwb-field"><span>Week From</span><select id="rwbPointsHistoryWeekStart" class="rwb-select"></select></label>' +
            '<label class="rwb-field"><span>Week To</span><select id="rwbPointsHistoryWeekEnd" class="rwb-select"></select></label>'
          : '<label class="rwb-field"><span>Year From</span><select id="rwbPointsHistoryYearStart" class="rwb-select"></select></label>' +
            '<label class="rwb-field"><span>Year To</span><select id="rwbPointsHistoryYearEnd" class="rwb-select"></select></label>');

      els.pointsHistoryYearStart = document.getElementById("rwbPointsHistoryYearStart");
      els.pointsHistoryYearEnd = document.getElementById("rwbPointsHistoryYearEnd");
      els.pointsHistorySeason = document.getElementById("rwbPointsHistorySeason");
      els.pointsHistoryWeekStart = document.getElementById("rwbPointsHistoryWeekStart");
      els.pointsHistoryWeekEnd = document.getElementById("rwbPointsHistoryWeekEnd");
      els.browseSearch = document.getElementById("rwbBrowseSearch");
      els.browseSearchSuggestions = document.getElementById("rwbBrowseSearchSuggestions");

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

    if (state.view === "bye") {
      els.pointsControls.className = "rwb-toolbar-points is-bye-view";
      els.pointsControls.hidden = false;
      els.pointsControls.innerHTML =
        '<div class="rwb-bye-legend" aria-label="Bye view legend">' +
          '<span class="rwb-bye-legend-label">Bye Impact</span>' +
          '<span class="rwb-bye-legend-chip is-clear">0 clear</span>' +
          '<span class="rwb-bye-legend-chip is-light">1-2 depth</span>' +
          '<span class="rwb-bye-legend-chip is-medium">3-5 pressure</span>' +
          '<span class="rwb-bye-legend-chip is-heavy">6+ red</span>' +
        '</div>';
      return;
    }

    els.pointsControls.className = "rwb-toolbar-points";
    els.pointsControls.hidden = false;
    els.pointsControls.innerHTML =
      '<label class="rwb-field"><span>Scoring</span><select id="rwbPointsMode" class="rwb-select"></select></label>';
    els.pointsMode = document.getElementById("rwbPointsMode");

    var pointOptions = rosterPointModeOptions();
    state.pointsMode = normalizeRosterPointMode(state.pointsMode);
    renderSelectOptions(els.pointsMode, pointOptions, state.pointsMode);
  }

  function renderToolbar() {
    if (!els.jumpTeam) return;

    ensureSelectedTeamId();
    var jumpOptions = [{ value: ALL_TEAMS_VALUE, label: "All Teams" }];
    var orderedTeams = orderedTeamsForDropdown();
    for (var i = 0; i < orderedTeams.length; i += 1) {
      var team = orderedTeams[i];
      jumpOptions.push({ value: team.id, label: team.name });
    }
    renderSelectOptions(els.jumpTeam, jumpOptions, normalizedSelectedTeamId());
    renderPointsControls();

    els.search.value = state.search;
    if (els.browseSearch) els.browseSearch.value = state.search;
    renderSearchSuggestions();

    var sets = buildFilterOptionSets();
    renderSelectOptions(els.filterPosition, sets.positions, state.filterPosition);
    renderSelectOptions(els.filterType, CONTRACT_FILTERS, state.filterType);
    renderSelectOptions(els.filterRosterStatus, ROSTER_STATUS_FILTERS, state.filterRosterStatus);
    if (contractActionFilterEnabledForView()) {
      var contractActionValues = sets.contractActions.map(function (row) { return safeStr(row.value); });
      if (state.filterContractAction && contractActionValues.indexOf(state.filterContractAction) === -1) {
        state.filterContractAction = "";
      }
    } else {
      state.filterContractAction = "";
    }
    renderSelectOptions(els.filterContractAction, sets.contractActions, state.filterContractAction);
    renderSelectOptions(els.filterByeImpact, BYE_IMPACT_FILTERS, state.filterByeImpact);
    var showByeImpactFilter = state.view === "bye";
    if (els.jumpTeamField) els.jumpTeamField.hidden = !teamJumpEnabledForView();
    var showAdvancedSearch = searchFilterEnabledForView() && !browseSearchEnabledForView();
    if (els.searchField) {
      els.searchField.hidden = !showAdvancedSearch;
      els.searchField.style.display = showAdvancedSearch ? "" : "none";
      els.searchField.setAttribute("aria-hidden", showAdvancedSearch ? "false" : "true");
    }
    if (els.filterPositionField) els.filterPositionField.hidden = !positionFilterEnabledForView();
    if (els.filterTypeField) els.filterTypeField.hidden = !contractTypeFilterEnabledForView();
    if (els.filterRosterStatusField) els.filterRosterStatusField.hidden = !rosterStatusFilterEnabledForView();
    if (els.filterContractActionField) els.filterContractActionField.hidden = !contractActionFilterEnabledForView();
    if (els.filterByeImpact) els.filterByeImpact.disabled = !showByeImpactFilter;
    if (els.filterByeImpactField) {
      els.filterByeImpactField.hidden = !showByeImpactFilter;
      els.filterByeImpactField.style.display = showByeImpactFilter ? "" : "none";
      els.filterByeImpactField.setAttribute("aria-hidden", showByeImpactFilter ? "false" : "true");
    }
    if (els.browsePanel) {
      els.browsePanel.hidden = !(teamJumpEnabledForView() || scoringControlEnabledForView() || capPlanSubviewControlEnabledForView() || tagSubviewControlEnabledForView());
    }
    if (els.browseGrid) {
      els.browseGrid.classList.toggle("is-single-column", !teamJumpEnabledForView());
    }

    var filtersForcedOpen = filtersForcedOpenForView();
    var effectiveFiltersOpen = filtersForcedOpen || state.filtersOpen;
    var showFiltersToggle = !filtersForcedOpen && !capPlanSummaryViewActive() && !tagBreakdownActive();
    var activeFilterCount = 0;
    if (state.search && !browseSearchEnabledForView()) activeFilterCount += 1;
    if (state.filterPosition) activeFilterCount += 1;
    if (contractTypeFilterEnabledForView() && state.filterType) activeFilterCount += 1;
    if (rosterStatusFilterEnabledForView() && state.filterRosterStatus) activeFilterCount += 1;
    if (contractActionFilterEnabledForView() && state.filterContractAction) activeFilterCount += 1;
    if (state.view === "bye" && state.filterByeImpact) activeFilterCount += 1;

    if (els.toggleFiltersWrap) els.toggleFiltersWrap.hidden = !showFiltersToggle;
    if (els.toggleFilters) {
      els.toggleFilters.hidden = !showFiltersToggle;
      els.toggleFilters.textContent = (effectiveFiltersOpen ? "Hide Filters" : "Filters") + (activeFilterCount ? " (" + activeFilterCount + ")" : "");
      els.toggleFilters.setAttribute("aria-expanded", effectiveFiltersOpen ? "true" : "false");
      els.toggleFilters.classList.toggle("is-active", effectiveFiltersOpen);
    }
    if (els.resetFilters) {
      els.resetFilters.disabled = activeFilterCount <= 0;
      els.resetFilters.textContent = activeFilterCount > 0 ? ("Clear Filters (" + activeFilterCount + ")") : "Clear Filters";
    }
    if (els.advanced) {
      els.advanced.hidden = capPlanSummaryViewActive() || tagBreakdownActive() || !effectiveFiltersOpen;
      els.advanced.classList.toggle("is-open", effectiveFiltersOpen && !capPlanSummaryViewActive() && !tagBreakdownActive());
    }

    if (els.toolbarMain) {
      els.toolbarMain.classList.toggle("is-points-view", state.view === "points" || state.view === "tag");
    }
    if (els.viewRoster && els.viewContract && els.viewPoints) {
      var rosterActive = state.view === "roster";
      var contractActive = state.view === "contract";
      var tagActive = state.view === "tag";
      var pointsActive = state.view === "points";
      var byeActive = state.view === "bye";
      els.viewRoster.classList.toggle("is-active", rosterActive);
      els.viewContract.classList.toggle("is-active", contractActive);
      if (els.viewTag) els.viewTag.classList.toggle("is-active", tagActive);
      els.viewPoints.classList.toggle("is-active", pointsActive);
      if (els.viewBye) els.viewBye.classList.toggle("is-active", byeActive);
      els.viewRoster.setAttribute("aria-selected", rosterActive ? "true" : "false");
      els.viewContract.setAttribute("aria-selected", contractActive ? "true" : "false");
      if (els.viewTag) els.viewTag.setAttribute("aria-selected", tagActive ? "true" : "false");
      els.viewPoints.setAttribute("aria-selected", pointsActive ? "true" : "false");
      if (els.viewBye) els.viewBye.setAttribute("aria-selected", byeActive ? "true" : "false");
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

  function renderToolbarNote(visiblePlayers, totalPlayers, visibleTeams, totalTeams) {
    if (!els.note) return;

    var parts = [];
    parts.push(viewLabel(state.view));
    if (capPlanSummaryViewActive()) {
      parts.push("Showing " + visibleTeams + " of " + totalTeams + " teams");
    } else if (state.view === "tag" && tagBreakdownActive()) {
      parts.push("Showing " + visiblePlayers + " of " + totalPlayers + " positions");
    } else if (state.view === "tag") {
      parts.push("Showing " + visiblePlayers + " of " + totalPlayers + " tag candidates");
    } else {
      parts.push("Showing " + visiblePlayers + " of " + totalPlayers + " players");
    }
    if (positionFilterEnabledForView() && state.filterPosition) parts.push(positionGroupLabel(state.filterPosition));
    if (contractTypeFilterEnabledForView() && state.filterType) {
      if (state.filterType === "rookie") parts.push("Rookies");
      else if (state.filterType === "loaded") parts.push("Loaded");
      else if (state.filterType === "other") parts.push("All Other");
    }
    if (rosterStatusFilterEnabledForView() && state.filterRosterStatus) parts.push(rosterStatusFilterLabel(state.filterRosterStatus));
    if (contractActionFilterEnabledForView() && state.filterContractAction) parts.push(contractActionFilterLabel(state.filterContractAction));
    if (searchFilterEnabledForView() && state.search) parts.push('Search "' + state.search + '"');
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
    } else if (state.view === "bye") {
      var byeSeason = latestCompletedSeasonForByeView();
      parts.push("Weighted by " + (byeSeason ? (byeSeason + " PPG rank") : "latest completed-season PPG rank"));
      parts.push("Shows bye-impact score plus players for each week");
      if (state.filterByeImpact) parts.push(byeImpactFilterLabel(state.filterByeImpact));
    } else if (state.view === "tag") {
      if (state.tagData && safeStr(state.tagData.sourceSeason)) {
        parts.push("Prior season " + safeStr(state.tagData.sourceSeason));
      }
      if (state.tagData && safeStr(state.tagData.cycleSeason) && !tagBreakdownActive()) {
        parts.push("Tag cycle " + safeStr(state.tagData.cycleSeason));
      }
      if (tagBreakdownActive()) {
        parts.push("Leaguewide tag cost breakdown");
        if (tagDisplaySeason()) parts.push(tagDisplaySeason() + " tagging");
        if (tagBreakdownUsesProjectedSeason()) parts.push("Projected until contract deadline lock");
      } else {
        parts.push("One offense and one defense tag can be active per team");
      }
      if (state.tagDataLoading) parts.push("Loading tag plan");
      if (state.tagDataError) parts.push("Tag data unavailable");
    }

    els.note.textContent = parts.join(" | ");
  }

  function teamHeaderHtml(team, filteredPlayers) {
    var logo = safeStr(team.logo);
    var allPlayers = team.players || [];
    var visiblePlayers = Array.isArray(filteredPlayers) ? filteredPlayers : allPlayers;
    var totalRosterPlayers = rosterCountForPlayers(allPlayers);
    var activeCount = activeRosterCountForPlayers(allPlayers);
    var irTotal = safeInt(team && team.summary && team.summary.ir, irCountForPlayers(allPlayers));
    var taxiTotal = safeInt(team && team.summary && team.summary.taxi, 0);
    var limit = rosterLimitSummary(totalRosterPlayers, state.ctx && state.ctx.year, new Date());
    var contractLimits = contractLimitSummaryForPlayers(visiblePlayers);
    var limitTitle = "Roster limit " + limit.rangeLabel;
    if (safeStr(limit.deadlineYmd) && limit.max > MAX_ROSTER_PLAYERS) {
      limitTitle += " until " + safeStr(limit.deadlineYmd);
    }
    var logoHtml = logo
      ? '<img class="rwb-team-logo" src="' + escapeHtml(logo) + '" alt="' + escapeHtml(team.name) + ' logo" title="' + escapeHtml(team.name) + '">' 
      : '<span class="rwb-team-logo-fallback" aria-hidden="true" title="' + escapeHtml(team.name) + '">' + escapeHtml(team.fid) + "</span>";
    var chips = [
      '<span class="rwb-chip"><span class="rwb-chip-label">Active</span><span class="rwb-chip-value">' + escapeHtml(String(activeCount)) + '</span></span>',
      '<span class="rwb-chip"><span class="rwb-chip-label">IR</span><span class="rwb-chip-value">' + escapeHtml(String(irTotal)) + '</span></span>',
      '<span class="rwb-chip"><span class="rwb-chip-label">Taxi</span><span class="rwb-chip-value">' + escapeHtml(String(taxiTotal)) + '</span></span>',
      '<span class="rwb-chip' + (limit.outOfRange ? ' is-bad' : '') + '" title="' + escapeHtml(limitTitle) + '"><span class="rwb-chip-label">Roster Min/Max</span><span class="rwb-chip-value">' + escapeHtml(limit.rangeLabel) + '</span></span>',
      '<span class="rwb-chip' + (contractLimits.threeYearNonRookie > 6 ? ' is-bad' : '') + '"><span class="rwb-chip-label">3Y Non-Rookie</span><span class="rwb-chip-value">' + escapeHtml(String(contractLimits.threeYearNonRookie) + '/6') + '</span></span>',
      '<span class="rwb-chip' + (contractLimits.loaded > 5 ? ' is-bad' : '') + '"><span class="rwb-chip-label">Loaded</span><span class="rwb-chip-value">' + escapeHtml(String(contractLimits.loaded) + '/5') + '</span></span>'
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
          '<div class="rwb-cap-summary-note">Trade and cut adjustments come from the salary-adjustments report. Manual other adjustments stay sourced from live MFL salaryAdjustments. Taxi excluded. IR counts at 50%.</div>' +
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
      salaryAdjustmentBreakdown: cloneSalaryAdjustmentBreakdown(team && team.summary && team.summary.salaryAdjustmentBreakdown),
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

  function summarizeCapPlanTeam(team) {
    var players = (team && team.players) || [];
    var summary = {
      salary: safeInt(team && team.summary && team.summary.capTotal, 0),
      capSpaceAvailable: calculateCapSpace(
        safeInt(team && team.summary && team.summary.capTotal, 0),
        safeInt(team && team.summary && team.summary.salaryAdjustmentTotal, 0)
      ),
      oneYearPlayers: 0,
      twoYearPlayers: 0,
      threeYearPlayers: 0,
      loadedContracts: 0,
      taxiPlayers: safeInt(team && team.summary && team.summary.taxi, 0),
      salaryAdjustmentTotal: safeInt(team && team.summary && team.summary.salaryAdjustmentTotal, 0),
      salaryAdjustmentBreakdown: cloneSalaryAdjustmentBreakdown(team && team.summary && team.summary.salaryAdjustmentBreakdown)
    };

    for (var i = 0; i < players.length; i += 1) {
      var player = players[i] || {};
      if (player.isTaxi) continue;
      var years = Math.max(0, safeInt(player.years, 0));
      if (years === 1) summary.oneYearPlayers += 1;
      else if (years === 2) summary.twoYearPlayers += 1;
      else if (years >= 3) summary.threeYearPlayers += 1;
      if (isLoadedContractPlayer(player)) summary.loadedContracts += 1;
    }

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

  function viewerCanManageAnyRoster() {
    return !!state.viewerIsAdmin;
  }

  function canManageRosterPlayer(player) {
    return !!player && (isOwnRosterPlayer(player) || viewerCanManageAnyRoster());
  }

  function canManageTagForTeam(teamId) {
    var fid = pad4(teamId);
    var viewer = pad4(state.viewerFranchiseId || (state.ctx && state.ctx.franchiseId));
    if (!fid) return false;
    return !!(viewerCanManageAnyRoster() || (viewer && viewer === fid));
  }

  function currentTagPlanRows() {
    var selectedSeason = tagDisplaySeason();
    var liveSeason = safeStr(state.tagData && state.tagData.cycleSeason);
    if (selectedSeason && liveSeason && selectedSeason !== liveSeason) {
      return projectedTagPlanRows(selectedSeason);
    }
    return state.tagData && Array.isArray(state.tagData.rows) ? state.tagData.rows : [];
  }

  function projectedTagRowLookupByPlayerId() {
    var lookup = Object.create(null);
    var rows = state.tagTrackingRows || [];
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i] || {};
      var pid = safeStr(row.player_id).replace(/\D/g, "");
      if (!pid || lookup[pid]) continue;
      lookup[pid] = row;
    }
    return lookup;
  }

  function tagProjectionBlockedForPlayer(player) {
    var info = safeStr(player && player.special).toLowerCase();
    return !!(
      rookieLikeContractStatus(player && player.type) ||
      info.indexOf("not eligible for tag or extension") !== -1 ||
      info.indexOf("no further extensions") !== -1
    );
  }

  function projectedTagPointsForPlayer(player, sourceRow) {
    if (sourceRow && safeNum(sourceRow.points_total, 0) > 0) return safeNum(sourceRow.points_total, 0);
    return safeNum(player && player.points, 0);
  }

  function projectedTagCandidates(targetSeason) {
    var season = safeInt(targetSeason, 0);
    var current = currentYearInt();
    var priorOffset = season - current - 1;
    var targetOffset = season - current;
    if (season <= current || priorOffset < 0 || targetOffset < 0) return [];

    var lookup = projectedTagRowLookupByPlayerId();
    var candidates = [];

    for (var t = 0; t < state.teams.length; t += 1) {
      var team = state.teams[t] || {};
      var players = team.players || [];
      for (var p = 0; p < players.length; p += 1) {
        var player = players[p] || {};
        if (!player || player.isTaxi) continue;
        if (tagProjectionBlockedForPlayer(player)) continue;

        var priorSalary = Math.max(0, displayedSalaryForPlan(player, priorOffset));
        var nextSalary = Math.max(0, displayedSalaryForPlan(player, targetOffset));
        if (priorSalary <= 0 || nextSalary > 0) continue;

        var pid = safeStr(player.id).replace(/\D/g, "");
        if (!pid) continue;
        if (tagPlayerExplicitlyExcluded(pid, player.name)) continue;
        var sourceRow = lookup[pid] || null;
        var posGroup = safeStr(player.positionGroup || positionGroupKey(player.position)).toUpperCase() || "OTHER";

        candidates.push({
          league_id: safeStr(state.ctx && state.ctx.leagueId),
          source_season: String(season - 1),
          prior_basis_season: String(season - 1),
          projected_tag_season: String(season),
          franchise_id: pad4(team.id),
          franchise_name: safeStr(team.name),
          player_id: pid,
          player_name: normalizePlayerName(player.name),
          position: safeStr(player.position).toUpperCase(),
          positional_grouping: posGroup,
          side: getTagSideFromPos(posGroup || player.position) || "OFFENSE",
          points_total: projectedTagPointsForPlayer(player, sourceRow),
          pos_rank: safeInt(sourceRow && sourceRow.pos_rank, 0),
          tag_tier: 0,
          tag_salary: 0,
          tag_formula: "",
          is_tag_eligible: 1,
          contract_status: safeStr(player.type),
          contract_year: Math.max(0, safeInt(player.years, 0)),
          salary: priorSalary,
          aav: priorSalary,
          contract_info: safeStr(player.special),
          prior_aav_week1: priorSalary,
          prior_salary_week1: priorSalary
        });
      }
    }

    return candidates;
  }

  function projectedTagTierTemplates() {
    return state.tagTrackingMeta && typeof state.tagTrackingMeta.calc_breakdown === "object"
      ? state.tagTrackingMeta.calc_breakdown
      : {};
  }

  function applyProjectedTagRanksAndTiers(rows, targetSeason) {
    var list = Array.isArray(rows) ? rows.slice() : [];
    var calc = projectedTagTierTemplates();
    var grouped = Object.create(null);

    for (var i = 0; i < list.length; i += 1) {
      var row = list[i] || {};
      var key = safeStr(row.positional_grouping).toUpperCase() || "OTHER";
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(row);
    }

    var groups = Object.keys(grouped);
    for (var g = 0; g < groups.length; g += 1) {
      var groupKey = groups[g];
      var items = grouped[groupKey] || [];
      items.sort(function (a, b) {
        var pointsDelta = safeNum(b.points_total, 0) - safeNum(a.points_total, 0);
        if (Math.abs(pointsDelta) > 0.0001) return pointsDelta;
        var salaryDelta = Math.max(safeInt(b.prior_aav_week1, 0), safeInt(b.prior_salary_week1, 0)) -
          Math.max(safeInt(a.prior_aav_week1, 0), safeInt(a.prior_salary_week1, 0));
        if (salaryDelta !== 0) return salaryDelta;
        return compareText(a.player_name, b.player_name);
      });

      var tiers = calc[groupKey] && Array.isArray(calc[groupKey].tiers)
        ? calc[groupKey].tiers
        : [];

      for (var r = 0; r < items.length; r += 1) {
        var row = items[r];
        var rank = r + 1;
        row.pos_rank = rank;
        row.tag_tier = 0;
        row.tag_salary = 0;
        row.tag_formula = "";

        for (var t = 0; t < tiers.length; t += 1) {
          var tier = tiers[t] || {};
          var minRank = Math.max(1, safeInt(tier.rank_min, 0) || 1);
          var maxRank = Math.max(minRank, safeInt(tier.rank_max, 0) || minRank);
          if (rank < minRank || rank > maxRank) continue;
          row.tag_tier = Math.max(0, safeInt(tier.tier, 0));
          row.tag_salary = Math.max(0, safeInt(tier.base_bid, 0));
          row.tag_formula = row.tag_tier > 0
            ? ("Tier " + String(row.tag_tier) + " base bid")
            : "Base bid";
          break;
        }
      }
    }

    return list;
  }

  function projectedTagPlanRows(targetSeason) {
    return applyProjectedTagRanksAndTiers(projectedTagCandidates(targetSeason), targetSeason);
  }

  function tagSubmissionKeyForPlayer(franchiseId, playerId, side) {
    var fid = pad4(franchiseId);
    var pid = safeStr(playerId).replace(/\D/g, "");
    var tagSide = normalizeTagSideValue(side) || "OFFENSE";
    var key = buildTagSelectionKey(state.tagData && state.tagData.cycleSeason, fid, tagSide);
    var submissions = state.tagData && state.tagData.submissionsByKey ? state.tagData.submissionsByKey : {};
    if (submissions[key] && safeStr(submissions[key].player_id).replace(/\D/g, "") === pid) return key;
    var keys = Object.keys(submissions);
    for (var i = 0; i < keys.length; i += 1) {
      var row = submissions[keys[i]] || {};
      if (pad4(row.franchise_id) !== fid) continue;
      if ((normalizeTagSideValue(row.side) || "OFFENSE") !== tagSide) continue;
      if (safeStr(row.player_id).replace(/\D/g, "") !== pid) continue;
      return keys[i];
    }
    return key;
  }

  function findTagPlanRow(franchiseId, playerId) {
    var fid = pad4(franchiseId);
    var pid = safeStr(playerId).replace(/\D/g, "");
    var rows = currentTagPlanRows();
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i] || {};
      if (pad4(row.franchise_id) !== fid) continue;
      if (safeStr(row.player_id).replace(/\D/g, "") !== pid) continue;
      return row;
    }
    return null;
  }

  function findTagTrackingReferenceRow(franchiseId, playerId) {
    var fid = pad4(franchiseId);
    var pid = safeStr(playerId).replace(/\D/g, "");
    if (!pid) return null;

    var targetSeason = safeStr(state.tagData && state.tagData.cycleSeason) || safeStr(state.ctx && state.ctx.year);
    var rows = Array.isArray(state.tagTrackingRows) ? state.tagTrackingRows : [];
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i] || {};
      if (targetSeason && safeStr(row.source_season) && safeStr(row.source_season) !== targetSeason) continue;
      if (fid && pad4(row.franchise_id) !== fid) continue;
      if (safeStr(row.player_id).replace(/\D/g, "") !== pid) continue;
      return row;
    }

    return findTagPlanRow(fid, pid);
  }

  function trackedTaggedPlayerForFranchiseSide(franchiseId, side) {
    var normalizedSide = normalizeTagSideValue(side) || "OFFENSE";
    var fid = pad4(franchiseId);
    if (!fid) return null;

    var rows = Array.isArray(state.tagTrackingRows) ? state.tagTrackingRows : [];
    var targetSeason = safeStr(state.tagData && state.tagData.cycleSeason) || safeStr(state.ctx && state.ctx.year);
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i] || {};
      if (targetSeason && safeStr(row.source_season) && safeStr(row.source_season) !== targetSeason) continue;
      if (pad4(row.franchise_id) !== fid) continue;
      if (safeStr(row.contract_status).toUpperCase().indexOf("TAG") === -1) continue;
      if (safeInt(row.tag_prev_season, 0)) continue;
      if ((normalizeTagSideValue(row.side) || getTagSideFromPos(row.positional_grouping || row.position) || "OFFENSE") !== normalizedSide) continue;
      return {
        id: safeStr(row.player_id).replace(/\D/g, ""),
        name: safeStr(row.player_name),
        position: safeStr(row.position),
        positionGroup: safeStr(row.positional_grouping || row.position),
        type: "TAG",
        contractStatus: safeStr(row.contract_status),
        source: "tracking"
      };
    }
    return null;
  }

  function activeTaggedPlayerForTeamSide(team, side) {
    var players = team && team.players ? team.players : [];
    var normalizedSide = normalizeTagSideValue(side) || "OFFENSE";
    for (var i = 0; i < players.length; i += 1) {
      var player = players[i] || {};
      if (safeStr(player.type).toUpperCase() !== "TAG") continue;
      if ((getTagSideFromPos(player.positionGroup || player.position) || "OFFENSE") !== normalizedSide) continue;
      return player;
    }
    return trackedTaggedPlayerForFranchiseSide(team && team.id, normalizedSide);
  }

  function conflictingTaggedPlayerForRow(row) {
    if (!row) return null;
    var team = findTeamById(row.franchise_id);
    if (!team) return null;
    var activePlayer = activeTaggedPlayerForTeamSide(team, row.side);
    var activePid = safeStr(activePlayer && activePlayer.id).replace(/\D/g, "");
    var rowPid = safeStr(row.player_id).replace(/\D/g, "");
    if (!activePid || !rowPid || activePid === rowPid) return null;
    return activePlayer;
  }

  function tagRowMatchesFilters(row, options) {
    var opts = options && typeof options === "object" ? options : {};
    if (!row) return false;

    if (!opts.skipSearch && searchFilterEnabledForView() && state.search) {
      var hay = [
        row.player_name,
        row.position,
        row.positional_grouping,
        positionGroupLabel(row.positional_grouping),
        row.franchise_name,
        tagSideLabel(row.side),
        "Tier " + String(safeInt(row.tag_tier, 0)),
        row.tag_formula
      ].join(" ").toLowerCase();
      if (hay.indexOf(state.search) === -1) return false;
    }

    if (state.filterPosition && safeStr(row.positional_grouping).toUpperCase() !== state.filterPosition) {
      return false;
    }

    return true;
  }

  function sortTagRows(rows) {
    return (rows || []).slice().sort(function (a, b) {
      var sideDelta = compareText(tagSideLabel(a.side), tagSideLabel(b.side));
      if (sideDelta !== 0) return sideDelta;
      var posDelta = positionSortValue(a.positional_grouping) - positionSortValue(b.positional_grouping);
      if (posDelta !== 0) return posDelta;
      var salaryDelta = safeInt(b.tag_salary, 0) - safeInt(a.tag_salary, 0);
      if (salaryDelta !== 0) return salaryDelta;
      return compareText(a.player_name, b.player_name);
    });
  }

  function buildLeagueModuleUrl(moduleValue, params) {
    var base =
      window.location.origin +
      "/" + encodeURIComponent(state.ctx.year) +
      "/home/" + encodeURIComponent(state.ctx.leagueId);
    var query = ["MODULE=" + safeStr(moduleValue)];
    var extra = params || {};
    var keys = Object.keys(extra);
    for (var i = 0; i < keys.length; i += 1) {
      var key = safeStr(keys[i]);
      if (!key) continue;
      var value = extra[key];
      if (value == null || value === "") continue;
      query.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(value)));
    }
    return base + "?" + query.join("&");
  }

  function buildLeagueModuleHashUrl(moduleValue, params) {
    var url;
    try {
      url = new URL(buildLeagueModuleUrl(moduleValue), window.location.href);
    } catch (e) {
      return buildLeagueModuleUrl(moduleValue, params);
    }
    var extra = params || {};
    var hash = new URLSearchParams();
    var keys = Object.keys(extra);
    for (var i = 0; i < keys.length; i += 1) {
      var key = safeStr(keys[i]);
      if (!key) continue;
      var value = extra[key];
      if (value == null || value === "") continue;
      hash.set(key, String(value));
    }
    url.hash = hash.toString();
    return url.toString();
  }

  function buildTradeModuleUrl(player) {
    var viewerId = pad4(state.viewerFranchiseId || (state.ctx && state.ctx.franchiseId));
    var playerTeamId = pad4(player && player.fid);
    var actorTeamId = viewerId || playerTeamId;
    var params = {
      twb_player_id: safeStr(player && player.id),
      twb_team_id: playerTeamId
    };
    if (actorTeamId) {
      params.twb_left_team = actorTeamId;
    }
    if (playerTeamId && actorTeamId && playerTeamId !== actorTeamId) {
      params.twb_right_team = playerTeamId;
      params.twb_side = "partner";
    } else {
      params.twb_side = "left";
    }
    return buildLeagueModuleHashUrl("MESSAGE6=N", params);
  }

  function buildContractCenterActionUrl(action, player, years) {
    var params = {
      cccAction: safeStr(action).toLowerCase(),
      cccPlayer: safeStr(player && player.id),
      cccFranchise: pad4(player && player.fid),
      cccSeason: safeStr(state.ctx && state.ctx.year)
    };
    if (safeStr(action).toLowerCase() === "extension") {
      params.cccYears = Math.max(1, Math.min(2, safeInt(years, 1) || 1));
    }
    return buildLeagueModuleHashUrl("MESSAGE2", params);
  }

  function extractExtensionSuffix(contractInfo) {
    var info = safeStr(contractInfo);
    if (!info) return "";
    var match = info.match(/(?:^|\|)\s*(Ext:.*)$/i);
    return match ? safeStr(match[1]) : "";
  }

  function restructureRoundToK(value) {
    var n = safeInt(value, 0);
    if (n <= 0) return 0;
    return Math.ceil(n / 1000) * 1000;
  }

  function restructureRemainingContractAmountsForPlayer(player, years) {
    var yearsInt = safeInt(years, 2) >= 3 ? 3 : 2;
    var fallback = Math.max(1000, restructureRoundToK(safeInt(player && player.salary, 0) || 1000));
    var currentIdx = Math.max(1, contractYearIndexForPlayer(player));
    var yearValues = contractYearValueMapForPlayer(player);
    var amounts = [];
    for (var i = 0; i < yearsInt; i += 1) {
      var yearIdx = currentIdx + i;
      var amount = safeInt(yearValues[yearIdx], 0);
      if (amount <= 0 && i === 0) amount = currentContractYearValue(player);
      if (amount <= 0) amount = contractYearFallbackValue(player, yearIdx);
      amounts.push(Math.max(1000, restructureRoundToK(amount || fallback)));
    }
    var tcv = amounts.reduce(function (sum, amount) {
      return sum + Math.max(0, safeInt(amount, 0));
    }, 0);
    return {
      tcv: Math.max(yearsInt * 1000, tcv),
      y1: Math.max(1000, safeInt(amounts[0], fallback)),
      y2: Math.max(1000, safeInt(amounts[1], fallback)),
      y3: yearsInt === 3 ? Math.max(1000, safeInt(amounts[2], fallback)) : 0
    };
  }

  function isThousandStep(value) {
    var n = safeInt(value, 0);
    return n > 0 && n % 1000 === 0;
  }

  function actionModalResetMode() {
    state.actionModal.mode = "actions";
    state.actionModal.restructureYear1 = "";
    state.actionModal.restructureYear2 = "";
    state.actionModal.restructureBaseTcv = 0;
    state.actionModal.restructureOriginalAav = 0;
    state.actionModal.restructureYears = 2;
    state.actionModal.restructureExtSuffix = "";
  }

  function actionModalRestructureCalc(player) {
    if (!player) return { ok: false, error: "Player not found." };
    var yearsInt = safeInt(state.actionModal.restructureYears, 2) >= 3 ? 3 : 2;
    var tcv = Math.max(0, safeInt(state.actionModal.restructureBaseTcv, 0));
    var aav = yearsInt > 0 ? Math.round((tcv / yearsInt) * 10) / 10 : 0;
    var y1 = safeInt(state.actionModal.restructureYear1, 0);
    var y2Input = safeInt(state.actionModal.restructureYear2, 0);
    var errors = [];

    if (!tcv || tcv < yearsInt * 1000) errors.push("Remaining contract value could not be determined.");
    if (!isThousandStep(y1)) errors.push("Year 1 must be in 1,000 increments.");
    var minY1 = Math.ceil((tcv * 0.2) / 1000) * 1000;
    if (y1 < minY1) errors.push("Year 1 must be at least 20% of TCV (" + money(minY1) + ").");

    var y2 = 0;
    var y3 = 0;
    if (yearsInt === 2) {
      var derivedY2 = tcv - y1;
      y2 = Math.max(0, derivedY2);
      if (!isThousandStep(derivedY2) || derivedY2 < 1000) errors.push("Year 2 must be at least 1,000 after applying Year 1.");
    } else {
      y2 = y2Input;
      if (!isThousandStep(y2) || y2 < 1000) errors.push("Year 2 must be at least 1,000 and in 1,000 increments.");
      y3 = tcv - y1 - y2;
      if (!isThousandStep(y3) || y3 < 1000) errors.push("Year 3 must be at least 1,000 after Year 1 + Year 2.");
    }

    if (errors.length) {
      return {
        ok: false,
        error: errors[0],
        years: yearsInt,
        tcv: tcv,
        y1: y1,
        y2: y2,
        y3: y3,
        aav: aav
      };
    }

    var gtd = tcv > 4000 ? Math.round(tcv * 0.75) : Math.max(0, tcv - y1);
    var yearParts = ["Y1-" + formatContractK(y1), "Y2-" + formatContractK(y2)];
    if (yearsInt === 3) yearParts.push("Y3-" + formatContractK(y3));
    var infoParts = [
      "CL " + yearsInt,
      "TCV " + formatContractK(tcv),
      "AAV " + formatContractK(aav),
      yearParts.join(", "),
      "GTD: " + formatContractK(gtd)
    ];
    if (safeStr(state.actionModal.restructureExtSuffix)) infoParts.push(safeStr(state.actionModal.restructureExtSuffix));

    return {
      ok: true,
      years: yearsInt,
      tcv: tcv,
      y1: y1,
      y2: y2,
      y3: y3,
      aav: aav,
      gtd: gtd,
      contractInfo: infoParts.join("| ")
    };
  }

  function openRestructureEditor(player) {
    if (!player) return;
    var years = safeInt(player && player.years, 0) >= 3 ? 3 : 2;
    var parsed = restructureRemainingContractAmountsForPlayer(player, years);
    var restructureAav = years > 0 ? Math.round((parsed.tcv / years) * 10) / 10 : 0;

    state.actionModal.mode = "restructure";
    state.actionModal.restructureYears = years;
    state.actionModal.restructureBaseTcv = parsed.tcv;
    state.actionModal.restructureOriginalAav = restructureAav;
    state.actionModal.restructureExtSuffix = extractExtensionSuffix(player.special || player.contract_info || "");
    state.actionModal.restructureYear1 = String(parsed.y1);
    state.actionModal.restructureYear2 = String(parsed.y2);
    renderPlayerActionModal();
  }

  function openPlayerActionModal(franchiseId, playerId) {
    state.actionModal.open = true;
    state.actionModal.franchiseId = pad4(franchiseId);
    state.actionModal.playerId = safeStr(playerId).replace(/\D/g, "");
    actionModalResetMode();
    renderPlayerActionModal();
  }

  function closePlayerActionModal() {
    state.actionModal.open = false;
    state.actionModal.franchiseId = "";
    state.actionModal.playerId = "";
    actionModalResetMode();
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
      var canManage = canManageRosterPlayer(player);
      var ownRoster = isOwnRosterPlayer(player);
      var penalty = dropPenaltyEstimate(player);
      var modalTcv = Math.max(0, safeInt(penalty.tcv, totalContractValueForPlayer(player)));
      var modalEarned = Math.max(0, safeInt(penalty.earned, 0));
      var extensionOptions = playerExtensionOptions(player);
      var extensionBlockReason = extensionBlockedReason(player);
      var contractEligibility = rosterContractEligibility(player);
      var rookieOption = rookieOptionStateForPlayer(player);
      var modalBusyKey = "restructure:" + safeStr(player.id);
      var restructureBusy = state.busyActionKey === modalBusyKey;
      var actions = [];
      actions.push(
        '<button type="button" class="rwb-modal-action" data-action="trade-player" data-player-id="' + escapeHtml(player.id) + '" data-franchise-id="' + escapeHtml(player.fid) + '">Trade</button>'
      );
      if (canManage) {
        if (safeStr(player.type).toUpperCase() === "TAG") {
          actions.push(
            '<button type="button" class="rwb-modal-action" data-action="untag-player" data-player-id="' + escapeHtml(player.id) + '" data-franchise-id="' + escapeHtml(player.fid) + '">Untag</button>'
          );
        }
        if (rookieOptionActionEligible(player)) {
          actions.push(
            '<button type="button" class="rwb-modal-action" data-action="exercise-rookie-option" data-player-id="' + escapeHtml(player.id) + '" data-franchise-id="' + escapeHtml(player.fid) + '">Exercise Option</button>'
          );
        }
        for (var i = 0; i < extensionOptions.length; i += 1) {
          var extensionOption = extensionOptions[i];
          actions.push(
            '<button type="button" class="rwb-modal-action" data-action="extend-player" data-option-key="' + escapeHtml(extensionOption.optionKey) + '" data-player-id="' + escapeHtml(player.id) + '" data-franchise-id="' + escapeHtml(player.fid) + '">' + escapeHtml(extensionActionLabel(extensionOption)) + '</button>'
          );
        }
        if (contractEligibility.restructureEligible) {
          actions.push(
            '<button type="button" class="rwb-modal-action" data-action="restructure-player" data-player-id="' + escapeHtml(player.id) + '" data-franchise-id="' + escapeHtml(player.fid) + '">Restructure</button>'
          );
        }
        if (player.isIr) {
          actions.push(
            '<button type="button" class="rwb-modal-action" data-action="activate-ir-player" data-player-id="' + escapeHtml(player.id) + '" data-franchise-id="' + escapeHtml(player.fid) + '">Activate From IR</button>'
          );
        }
        if (player.isTaxi) {
          actions.push(
            '<button type="button" class="rwb-modal-action" data-action="promote-taxi-player" data-player-id="' + escapeHtml(player.id) + '" data-franchise-id="' + escapeHtml(player.fid) + '">Promote From Taxi</button>'
          );
        }
        actions.push(
          '<button type="button" class="rwb-modal-action" data-action="drop-player" data-player-id="' + escapeHtml(player.id) + '" data-franchise-id="' + escapeHtml(player.fid) + '">Drop</button>'
        );
      }

      var extensionSummaryHtml = "";
      var rookieOptionSummaryHtml = "";
      if (rookieOption && rookieOption.eligible) {
        rookieOptionSummaryHtml =
          '<div class="rwb-modal-note"><strong>Rookie Option:</strong> ' +
            escapeHtml(
              rookieOption.exercised
                ? ("Exercised. Option year salary " + formatContractK(rookieOption.optionYearSalary) + ".")
                : ("Eligible. Option year salary " + formatContractK(rookieOption.optionYearSalary) + " before the " + String(safeInt(rookieOption.deadlineSeason || safeInt(state.ctx && state.ctx.year, 0), 0)) + " contract deadline.")
            ) +
          '</div>';
      }
      if (extensionOptions.length) {
        var extensionLines = [];
        var extensionDeadlineLabel = extensionDeadlineLabelForSeason(state.ctx && state.ctx.year);
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
            (extensionDeadlineLabel
              ? '<div class="rwb-extension-preview-line"><strong>Deadline:</strong> ' + escapeHtml(extensionDeadlineLabel) + '</div>'
              : '') +
          '</div>';
        if (player.isTaxi) {
          extensionSummaryHtml +=
            '<div class="rwb-modal-note"><strong>Taxi:</strong> Extending this player ends taxi eligibility.</div>';
        }
      } else if (canManage && contractEligibility.extensionEligible) {
        extensionSummaryHtml =
          '<div class="rwb-modal-note"><strong>Extension:</strong> ' + escapeHtml(extensionBlockReason || "No extension options are available for this player.") + '</div>';
      }
      var modalAav = displayAavForPlayer(player);
      var playerHeaderHtml =
        '<div class="rwb-modal-player">' +
          '<div class="rwb-modal-player-main">' +
            '<span class="rwb-pos-pill">' + escapeHtml(player.positionGroup) + '</span>' +
            '<h3>' + escapeHtml(player.name) + '</h3>' +
            (player.isTaxi ? '<span class="rwb-tag is-taxi">Taxi</span>' : '') +
            (player.isIr ? '<span class="rwb-tag is-ir">IR</span>' : '') +
            (rookieOption && rookieOption.eligible ? '<span class="rwb-tag">Rookie Option</span>' : '') +
          '</div>' +
          '<div class="rwb-modal-player-sub">' + escapeHtml(team.name) + ' | ' + escapeHtml(player.position) + ' | ' + escapeHtml(player.nflTeam || "-") + '</div>' +
        '</div>';

      if (state.actionModal.mode === "restructure") {
        var contractLength = contractLengthForPlayer(player);
        var calc = actionModalRestructureCalc(player);
        var restructureErrorHtml = calc.ok
          ? ""
          : '<div class="rwb-modal-note rwb-restructure-error">' + escapeHtml(calc.error || "Invalid restructure values.") + '</div>';
        var lockedYear2 = state.actionModal.restructureYears < 3;
        var y2Value = lockedYear2 ? String(Math.max(0, safeInt(calc.y2, safeInt(state.actionModal.restructureYear2, 0)))) : safeStr(state.actionModal.restructureYear2);
        var y2FieldHtml =
          '<label class="rwb-restructure-field">' +
            '<span>Year 2</span>' +
            '<input id="rwbRestructureYear2" class="rwb-input rwb-restructure-input" type="text" inputmode="numeric" value="' + escapeHtml(y2Value) + '" autocomplete="off"' + (lockedYear2 ? ' readonly aria-readonly="true" tabindex="-1"' : '') + '>' +
            '<small>' + escapeHtml(lockedYear2 ? "Locked to the remaining TCV after Year 1." : "Must stay in 1K increments.") + '</small>' +
          '</label>';
        var previewInfo = calc.ok ? inlineContractInfoText(calc.contractInfo) : "Waiting for a valid restructure.";

        content =
          playerHeaderHtml +
          '<div class="rwb-modal-grid">' +
            '<div class="rwb-modal-metric"><span>Current Salary</span><strong>' + escapeHtml(money(player.salary)) + '</strong></div>' +
            '<div class="rwb-modal-metric"><span>Remaining AAV</span><strong>' + escapeHtml(state.actionModal.restructureOriginalAav > 0 ? money(state.actionModal.restructureOriginalAav) : "—") + '</strong></div>' +
            '<div class="rwb-modal-metric"><span>TCV</span><strong>' + escapeHtml(modalTcv > 0 ? money(modalTcv) : "—") + '</strong></div>' +
            '<div class="rwb-modal-metric"><span>Earned To Date</span><strong>' + escapeHtml(modalEarned > 0 ? money(modalEarned) : "$0") + '</strong></div>' +
            '<div class="rwb-modal-metric"><span>Years Left</span><strong>' + escapeHtml(String(player.years)) + '</strong></div>' +
            '<div class="rwb-modal-metric"><span>Contract Length</span><strong>' + escapeHtml(contractLength > 0 ? String(contractLength) : "—") + '</strong></div>' +
            '<div class="rwb-modal-metric"><span>Acquired</span><strong>' + escapeHtml(acquisitionDateLabelForPlayer(player)) + '</strong></div>' +
            '<div class="rwb-modal-metric"><span>Via</span><strong>' + escapeHtml(acquisitionTypeLabelForPlayer(player)) + '</strong></div>' +
          '</div>' +
          '<div class="rwb-modal-subnav">' +
            '<button type="button" class="rwb-modal-action rwb-modal-action-secondary" data-action="restructure-back"' + (restructureBusy ? ' disabled' : '') + '>Back</button>' +
            '<div class="rwb-modal-subnav-copy">' +
              '<div class="rwb-modal-subnav-title">Restructure Contract</div>' +
              '<div class="rwb-modal-subnav-text">Keep the remaining contract value and redistribute salary across the remaining years.</div>' +
            '</div>' +
          '</div>' +
          '<div class="rwb-restructure-form">' +
            '<div class="rwb-restructure-grid">' +
              '<label class="rwb-restructure-field">' +
                '<span>Year 1</span>' +
                '<input id="rwbRestructureYear1" class="rwb-input rwb-restructure-input" type="text" inputmode="numeric" value="' + escapeHtml(state.actionModal.restructureYear1) + '" autocomplete="off">' +
                '<small>Minimum 20% of TCV, in 1K increments.</small>' +
              '</label>' +
              y2FieldHtml +
            '</div>' +
            '<div class="rwb-restructure-summary">' +
              '<div class="rwb-restructure-kpis">' +
                '<div class="rwb-restructure-kpi"><span>Years</span><strong>' + escapeHtml(calc.ok ? String(calc.years) : String(state.actionModal.restructureYears)) + '</strong></div>' +
                '<div class="rwb-restructure-kpi"><span>TCV</span><strong>' + escapeHtml(calc.ok ? money(calc.tcv) : "—") + '</strong></div>' +
                '<div class="rwb-restructure-kpi"><span>AAV</span><strong>' + escapeHtml(calc.ok ? money(calc.aav) : "—") + '</strong></div>' +
                '<div class="rwb-restructure-kpi"><span>GTD</span><strong>' + escapeHtml(calc.ok ? money(calc.gtd) : "—") + '</strong></div>' +
              '</div>' +
              '<div class="rwb-restructure-contract"><strong>Contract Info:</strong> ' + escapeHtml(previewInfo) + '</div>' +
              (safeStr(state.actionModal.restructureExtSuffix)
                ? '<div class="rwb-restructure-contract"><strong>Preserved:</strong> ' + escapeHtml(state.actionModal.restructureExtSuffix) + '</div>'
                : '') +
            '</div>' +
            restructureErrorHtml +
            '<div class="rwb-modal-actions-wrap">' +
              '<button type="button" class="rwb-modal-action" data-action="submit-restructure"' + ((restructureBusy || !calc.ok) ? ' disabled' : '') + '>' + escapeHtml(restructureBusy ? "Submitting..." : "Submit Restructure") + '</button>' +
            '</div>' +
          '</div>' +
          (viewerCanManageAnyRoster() && !ownRoster ? '<div class="rwb-modal-note"><strong>Commish:</strong> Acting on behalf of ' + escapeHtml(team.name) + '.</div>' : '');
      } else {
        content =
          playerHeaderHtml +
          '<div class="rwb-modal-grid">' +
            '<div class="rwb-modal-metric"><span>TCV</span><strong>' + escapeHtml(modalTcv > 0 ? money(modalTcv) : "—") + '</strong></div>' +
            '<div class="rwb-modal-metric"><span>AAV</span><strong>' + escapeHtml(modalAav > 0 ? money(modalAav) : "—") + '</strong></div>' +
            '<div class="rwb-modal-metric"><span>Salary</span><strong>' + escapeHtml(money(player.salary)) + '</strong></div>' +
            '<div class="rwb-modal-metric"><span>Yrs Remain</span><strong>' + escapeHtml(String(player.years)) + '</strong></div>' +
            '<div class="rwb-modal-metric"><span>Earned To Date</span><strong>' + escapeHtml(modalEarned > 0 ? money(modalEarned) : "$0") + '</strong></div>' +
            '<div class="rwb-modal-metric"><span>Cap Penalty</span><strong>' + escapeHtml(money(penalty.amount)) + '</strong></div>' +
            '<div class="rwb-modal-metric"><span>Acquire Date</span><strong>' + escapeHtml(acquisitionDateLabelForPlayer(player)) + '</strong></div>' +
            '<div class="rwb-modal-metric"><span>How Acquired</span><strong>' + escapeHtml(acquisitionTypeLabelForPlayer(player)) + '</strong></div>' +
          '</div>' +
          '<div class="rwb-modal-actions-wrap">' + actions.join("") + '</div>' +
          rookieOptionSummaryHtml +
          extensionSummaryHtml +
          (!canManage ? '<div class="rwb-modal-note">Roster-management actions are unavailable for this session. Trade is available from any team.</div>' : '') +
          (viewerCanManageAnyRoster() && !ownRoster ? '<div class="rwb-modal-note"><strong>Commish:</strong> Acting on behalf of ' + escapeHtml(team.name) + '.</div>' : '');
      }
    }

    els.playerModal.hidden = !isOpen;
    els.playerModal.setAttribute("aria-hidden", isOpen ? "false" : "true");
    if (els.playerModalBody) els.playerModalBody.innerHTML = content;
    if (els.playerModalTitle) {
      els.playerModalTitle.textContent = isOpen ? "Player Profile" : "Player Actions";
    }
    if (document.body) {
      document.body.classList.toggle("rwb-modal-open", isOpen);
    }
  }

  function rosterGroupHtml(team, group, rosterGroupSummaryMap) {
    var rows = [];
    var teamGroupSummary = rosterGroupSummaryMap &&
      rosterGroupSummaryMap[pad4(team && team.id)] &&
      rosterGroupSummaryMap[pad4(team && team.id)][safeStr(group && group.key).toUpperCase()]
      ? rosterGroupSummaryMap[pad4(team && team.id)][safeStr(group && group.key).toUpperCase()]
      : {
          count: (group && group.players && group.players.length) || 0,
          salaryTotal: 0,
          salaryRank: 0,
          leagueTeams: state.teams.length
        };
    for (var j = 0; j < group.players.length; j += 1) {
      var p = group.players[j];
      var tags = [];
      if (p.isTaxi) tags.push('<span class="rwb-tag is-taxi">Taxi</span>');
      if (p.isIr) tags.push('<span class="rwb-tag is-ir">IR</span>');
      var contractLength = contractLengthForPlayer(p);
      var totalContractValue = totalContractValueForPlayer(p);
      var contractGuarantee = guaranteedContractValueForPlayer(p);
      var capPenalty = capPenaltyAmountForPlayer(p);
      var contractTypeText = safeStr(p.type) || "-";

      rows.push(
        '<tr class="rwb-player-row' + (p.isTaxi ? ' rwb-player-row-taxi' : '') + (p.isIr ? ' rwb-player-row-ir' : '') + '" data-player-id="' + escapeHtml(p.id) + '">' +
          '<td>' +
            '<div class="rwb-player-name-wrap">' +
              '<div class="rwb-player-line">' +
                '<span class="rwb-pos-pill">' + escapeHtml(safeStr(p.positionGroup)) + '</span>' +
                '<button type="button" class="rwb-player-open rwb-player-open-stack" data-action="open-player-modal" data-player-id="' + escapeHtml(p.id) + '" data-franchise-id="' + escapeHtml(p.fid) + '">' +
                  '<span class="rwb-player-name">' + escapeHtml(p.name) + '</span>' +
                  '<span class="rwb-type-pill ' + typeTone(p.type) + ' rwb-player-contract-pill">' + escapeHtml(contractTypeText) + '</span>' +
                '</button>' +
                tags.join("") +
                '<button type="button" class="rwb-row-more" data-action="row-more" aria-expanded="false">More</button>' +
              '</div>' +
              '<dl class="rwb-mobile-details">' +
                '<div><dt>Contract Length</dt><dd>' + escapeHtml(contractLength > 0 ? String(contractLength) : "—") + '</dd></div>' +
                '<div><dt>Years Left</dt><dd>' + escapeHtml(String(p.years)) + '</dd></div>' +
                '<div><dt>Salary</dt><dd>' + escapeHtml(compactContractValueWithRankText(p.salary, p.positionSalaryRank)) + '</dd></div>' +
                '<div><dt>AAV</dt><dd>' + escapeHtml(compactContractValueWithRankText(p.aav, p.positionAavRank)) + '</dd></div>' +
                '<div><dt>TCV</dt><dd>' + escapeHtml(compactContractAmount(totalContractValue)) + '</dd></div>' +
                '<div><dt>Orig GTD</dt><dd>' + escapeHtml(compactContractAmountAllowZero(contractGuarantee)) + '</dd></div>' +
                '<div><dt>Cap Pen</dt><dd>' + escapeHtml(compactContractAmountAllowZero(capPenalty)) + '</dd></div>' +
              '</dl>' +
            '</div>' +
          '</td>' +
          '<td class="rwb-cell-num">' + escapeHtml(contractLength > 0 ? String(contractLength) : "—") + '</td>' +
          '<td class="rwb-cell-num">' + escapeHtml(String(p.years)) + '</td>' +
          '<td class="rwb-cell-num">' + compactContractValueWithRankHtml(p.salary, p.positionSalaryRank) + '</td>' +
          '<td class="rwb-cell-num">' + compactContractValueWithRankHtml(p.aav, p.positionAavRank) + '</td>' +
          '<td class="rwb-cell-num">' + escapeHtml(compactContractAmount(totalContractValue)) + '</td>' +
          '<td class="rwb-cell-num">' + escapeHtml(compactContractAmountAllowZero(contractGuarantee)) + '</td>' +
          '<td class="rwb-cell-num">' + escapeHtml(compactContractAmountAllowZero(capPenalty)) + '</td>' +
        '</tr>'
      );
    }

    return (
      '<details class="rwb-group" open>' +
        '<summary>' +
          '<span class="rwb-group-copy">' +
            '<span class="rwb-group-title">' + escapeHtml(group.label) + '</span>' +
            '<span class="rwb-group-meta-row">' +
              '<span class="rwb-group-meta-pill"><span class="rwb-group-meta-label">Allocated</span><span class="rwb-group-meta-value">' + escapeHtml(compactContractAmountAllowZero(teamGroupSummary.salaryTotal)) + '</span></span>' +
              '<span class="rwb-group-meta-pill"><span class="rwb-group-meta-label">League Rank</span><span class="rwb-group-meta-value">' + escapeHtml((teamGroupSummary.salaryRank > 0 ? formatRank(teamGroupSummary.salaryRank) : "—") + (teamGroupSummary.leagueTeams > 0 ? ("/" + String(teamGroupSummary.leagueTeams)) : "")) + '</span></span>' +
            '</span>' +
          '</span>' +
          '<span class="rwb-group-count-card"><span class="rwb-group-count-label">Players</span><span class="rwb-group-count-value">' + escapeHtml(String(group.players.length)) + '</span></span>' +
        '</summary>' +
        '<div class="rwb-table-wrap">' +
          '<table class="rwb-table rwb-roster-table" aria-label="' + escapeHtml(team.name + " " + group.label + " roster") + '">' +
            '<thead>' +
              '<tr>' +
                sortableHeader("roster", "name", "Player") +
                sortableHeader("roster", "contract_length", "Contract Length", "rwb-th-num") +
                sortableHeader("roster", "years", "Years Left", "rwb-th-num") +
                sortableHeader("roster", "salary", "Salary", "rwb-th-num") +
                sortableHeader("roster", "aav", "AAV", "rwb-th-num") +
                sortableHeader("roster", "tcv", "TCV", "rwb-th-num") +
                sortableHeader("roster", "guarantee", "Orig GTD", "rwb-th-num") +
                sortableHeader("roster", "penalty", "Cap Pen", "rwb-th-num") +
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
    var nonTaxiRows = [];
    var taxiRows = [];

    for (var i = 0; i < sorted.length; i += 1) {
      var p = sorted[i];
      var proj = [displayedSalaryForPlan(p, 0), displayedSalaryForPlan(p, 1), displayedSalaryForPlan(p, 2)];
      var aav = safeInt(p.aav, 0);
      var tcv = totalContractValueForPlayer(p);
      var contractTypeText = safeStr(p.type) || "-";
      var extensionOptions = playerExtensionOptions(p);
      var previewControlsHtml = extensionOptions.length
        ? '<div class="rwb-contract-toggle-row">' +
            '<button type="button" class="rwb-contract-toggle' + (extensionPreviewYears(p) === 1 ? ' is-active' : '') + '" data-action="contract-preview" data-years="1" data-player-id="' + escapeHtml(p.id) + '" data-franchise-id="' + escapeHtml(p.fid) + '"' + (extensionOptions.length < 1 ? ' disabled' : '') + '>1Y</button>' +
            '<button type="button" class="rwb-contract-toggle' + (extensionPreviewYears(p) === 2 ? ' is-active' : '') + '" data-action="contract-preview" data-years="2" data-player-id="' + escapeHtml(p.id) + '" data-franchise-id="' + escapeHtml(p.fid) + '"' + (extensionOptions.length < 2 ? ' disabled' : '') + '>2Y</button>' +
          '</div>'
        : '<span class="rwb-row-action-placeholder">—</span>';

      var rowHtml =
        '<tr class="rwb-player-row' + (p.isTaxi ? ' rwb-player-row-taxi' : '') + (p.isIr ? ' rwb-player-row-ir' : '') + (extensionPreviewYears(p) ? ' is-projected' : '') + '">' +
          '<td>' +
            '<div class="rwb-player-name-wrap">' +
              '<div class="rwb-player-line">' +
                '<button type="button" class="rwb-player-open rwb-player-open-stack" data-action="open-player-modal" data-player-id="' + escapeHtml(p.id) + '" data-franchise-id="' + escapeHtml(p.fid) + '">' +
                  '<span class="rwb-player-name">' + escapeHtml(p.name) + '</span>' +
                  '<span class="rwb-type-pill ' + typeTone(p.type) + ' rwb-player-contract-pill">' + escapeHtml(contractTypeText) + '</span>' +
                '</button>' +
                (p.isTaxi ? '<span class="rwb-tag is-taxi">Taxi</span>' : '') +
                (p.isIr ? '<span class="rwb-tag is-ir">IR</span>' : '') +
              '</div>' +
            '</div>' +
          '</td>' +
          '<td class="rwb-cell-num">' + escapeHtml(safeStr(p.positionGroup)) + '</td>' +
          '<td class="rwb-cell-num' + (tcv === 0 ? ' rwb-money-zero' : '') + '">' + escapeHtml(tcv > 0 ? money(tcv) : "—") + '</td>' +
          '<td class="rwb-cell-num' + (aav === 0 ? ' rwb-money-zero' : '') + '">' + escapeHtml(aav > 0 ? money(aav) : "—") + '</td>' +
          '<td class="rwb-cell-num">' + escapeHtml(projectedExpiryLabel(p)) + '</td>' +
          '<td class="rwb-cell-num' + (proj[0] === 0 ? ' rwb-money-zero' : '') + '">' + escapeHtml(money(proj[0])) + '</td>' +
          '<td class="rwb-cell-num' + (proj[1] === 0 ? ' rwb-money-zero' : '') + '">' + escapeHtml(money(proj[1])) + '</td>' +
          '<td class="rwb-cell-num' + (proj[2] === 0 ? ' rwb-money-zero' : '') + '">' + escapeHtml(money(proj[2])) + '</td>' +
          '<td>' +
            previewControlsHtml +
          '</td>' +
        '</tr>';
      if (p.isTaxi) taxiRows.push(rowHtml);
      else nonTaxiRows.push(rowHtml);
    }

    if (!nonTaxiRows.length && !taxiRows.length) {
      return '<div class="rwb-empty">No players match the current filters for this team.</div>';
    }

    rows = nonTaxiRows.slice();
    if (taxiRows.length) {
      if (rows.length) {
        rows.push('<tr class="rwb-table-section-row"><td colspan="9"><span class="rwb-table-section-label">Taxi Squad</span></td></tr>');
      }
      rows = rows.concat(taxiRows);
    }

    return (
      '<div class="rwb-table-wrap">' +
          '<table class="rwb-table rwb-contract-table" aria-label="' + escapeHtml(team.name + " plan view") + '">' +
          '<thead>' +
            '<tr>' +
              sortableHeader("contract", "player", "Player") +
              sortableHeader("contract", "position", "Pos") +
              sortableHeader("contract", "tcv", "TCV") +
              sortableHeader("contract", "aav", "AAV") +
              sortableHeader("contract", "expires", "Expires") +
              sortableHeader("contract", "year0", years[0]) +
              sortableHeader("contract", "year1", years[1]) +
              sortableHeader("contract", "year2", years[2]) +
              '<th>Preview</th>' +
            '</tr>' +
          '</thead>' +
          '<tbody>' + rows.join("") + '</tbody>' +
          '<tfoot>' +
            '<tr class="rwb-summary-row rwb-summary-row-primary">' +
              '<th>Non-Taxi</th>' +
              '<th>—</th>' +
              '<th>—</th>' +
              '<th>—</th>' +
              '<th>' + escapeHtml(String(planSummary.nonTaxiPlayersUnderContract)) + ' players</th>' +
              '<th class="rwb-cell-num">' + escapeHtml(money(planSummary.nonTaxiTotals[0])) + '</th>' +
              '<th class="rwb-cell-num">' + escapeHtml(money(planSummary.nonTaxiTotals[1])) + '</th>' +
              '<th class="rwb-cell-num">' + escapeHtml(money(planSummary.nonTaxiTotals[2])) + '</th>' +
              '<th>Salary shown. Cap summary above applies adjustments.</th>' +
            '</tr>' +
            '<tr class="rwb-summary-row rwb-summary-row-taxi">' +
              '<th>Taxi</th>' +
              '<th>—</th>' +
              '<th>—</th>' +
              '<th>—</th>' +
              '<th>' + escapeHtml(String(planSummary.taxiPlayersShown)) + ' players</th>' +
              '<th class="rwb-cell-num">' + escapeHtml(money(planSummary.taxiTotals[0])) + '</th>' +
              '<th class="rwb-cell-num">' + escapeHtml(money(planSummary.taxiTotals[1])) + '</th>' +
              '<th class="rwb-cell-num">' + escapeHtml(money(planSummary.taxiTotals[2])) + '</th>' +
              '<th>Salary shown, excluded from cap totals</th>' +
            '</tr>' +
            (salaryAdj !== 0
              ? '<tr class="rwb-summary-row rwb-summary-row-adjustment">' +
                  '<th>Salary Adj.</th>' +
                  '<th>—</th>' +
                  '<th>—</th>' +
                  '<th>—</th>' +
                  '<th>Current season</th>' +
                  '<th class="rwb-cell-num">' + escapeHtml(money(salaryAdj)) + '</th>' +
                  '<th class="rwb-cell-num">' + escapeHtml(money(0)) + '</th>' +
                  '<th class="rwb-cell-num">' + escapeHtml(money(0)) + '</th>' +
                  '<th>Applied to cap total</th>' +
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

  function defaultSelectedTeamId() {
    var viewerTeamId = pad4(state.viewerFranchiseId || (state.ctx && state.ctx.franchiseId));
    if (viewerTeamId && findTeamById(viewerTeamId)) return viewerTeamId;
    return pad4(state.teams[0] && state.teams[0].id);
  }

  function ensureSelectedTeamId() {
    var selected = normalizedSelectedTeamId();
    if (capPlanSummaryViewActive()) {
      if (selected === ALL_TEAMS_VALUE) return selected;
      state.selectedTeamId = ALL_TEAMS_VALUE;
      return state.selectedTeamId;
    }
    if (selected === ALL_TEAMS_VALUE) return selected;
    if (selected && findTeamById(selected)) return selected;
    state.selectedTeamId = defaultSelectedTeamId();
    return state.selectedTeamId;
  }

  function scopedTeamsForDisplay() {
    var selected = ensureSelectedTeamId();
    if (!selected || selected === ALL_TEAMS_VALUE) return state.teams.slice();
    var team = findTeamById(selected);
    return team ? [team] : state.teams.slice(0, 1);
  }

  function byeWeekForPlayer(player) {
    var week = safeInt(player && player.bye, 0);
    if (week <= 0 || week > MAX_SCORE_WEEKS) return 0;
    return week;
  }

  function collectByeWeeksFromPlayers(players) {
    var seen = Object.create(null);
    var weeks = [];
    var list = Array.isArray(players) ? players : [];
    for (var i = 0; i < list.length; i += 1) {
      var week = byeWeekForPlayer(list[i]);
      if (!week || seen[week]) continue;
      seen[week] = true;
      weeks.push(String(week));
    }
    weeks.sort(function (a, b) { return safeInt(a, 0) - safeInt(b, 0); });
    return weeks;
  }

  function leagueByeWeeks() {
    var players = [];
    for (var i = 0; i < state.teams.length; i += 1) {
      var teamPlayers = (state.teams[i] && state.teams[i].players) || [];
      for (var j = 0; j < teamPlayers.length; j += 1) players.push(teamPlayers[j]);
    }
    var weeks = collectByeWeeksFromPlayers(players);
    if (weeks.length) return weeks;
    var fallback = [];
    for (var week = 5; week <= 14; week += 1) fallback.push(String(week));
    return fallback;
  }

  function latestCompletedSeasonForByeView() {
    var seasons = rosterPointSeasonPoolDescending();
    return seasons.length ? safeStr(seasons[0]) : "";
  }

  function latestAvailablePpgRankHistoryForPlayer(player) {
    var seasons = rosterPointSeasonPoolDescending();
    for (var i = 0; i < seasons.length; i += 1) {
      var row = playerYearlyHistoryRow(player, seasons[i]);
      if (row && safeInt(row[4], 0) > 0) {
        return {
          season: safeStr(seasons[i]),
          rank: safeInt(row[4], 0)
        };
      }
    }
    return { season: "", rank: 0 };
  }

  function byeImpactWeightForRank(rank) {
    var value = safeInt(rank, 0);
    if (value <= 0) return 1;
    if (value <= 3) return 6;
    if (value <= 8) return 5;
    if (value <= 16) return 4;
    if (value <= 24) return 3;
    if (value <= 36) return 2;
    return 1;
  }

  function byeImpactProfileForPlayer(player) {
    var history = latestAvailablePpgRankHistoryForPlayer(player);
    return {
      season: safeStr(history.season),
      rank: safeInt(history.rank, 0),
      weight: byeImpactWeightForRank(history.rank)
    };
  }

  function byePlayerShortName(player) {
    var name = safeStr(player && player.name);
    if (!name) return "";
    if (name.indexOf(",") !== -1) return safeStr(name.split(",")[0]);
    var parts = name.split(/\s+/);
    return safeStr(parts[parts.length - 1] || name);
  }

  function sortByePlayers(players) {
    var list = Array.isArray(players) ? players.slice() : [];
    list.sort(function (a, b) {
      var aProfile = byeImpactProfileForPlayer(a);
      var bProfile = byeImpactProfileForPlayer(b);
      var weightDelta = safeInt(bProfile.weight, 0) - safeInt(aProfile.weight, 0);
      if (weightDelta !== 0) return weightDelta;
      var rankDelta = safeInt(aProfile.rank || 999999, 999999) - safeInt(bProfile.rank || 999999, 999999);
      if (rankDelta !== 0) return rankDelta;
      return compareText(a && a.name, b && b.name);
    });
    return list;
  }

  function byeImpactScoreForPlayers(players) {
    var total = 0;
    var list = Array.isArray(players) ? players : [];
    for (var i = 0; i < list.length; i += 1) {
      total += safeInt(byeImpactProfileForPlayer(list[i]).weight, 0);
    }
    return total;
  }

  function byeCellPlayersHtml(players) {
    var list = sortByePlayers(players);
    if (!list.length) return "";
    var tags = [];
    for (var i = 0; i < list.length && i < 2; i += 1) {
      tags.push('<span class="rwb-bye-player-chip">' + escapeHtml(byePlayerShortName(list[i])) + '</span>');
    }
    if (list.length > 2) {
      tags.push('<span class="rwb-bye-player-chip is-more">+' + escapeHtml(String(list.length - 2)) + '</span>');
    }
    return '<div class="rwb-bye-player-list">' + tags.join("") + '</div>';
  }

  function byeTooltipText(week, players) {
    var list = sortByePlayers(players);
    if (!list.length) return "Week " + safeStr(week) + ": no filtered players on bye";
    var names = [];
    for (var i = 0; i < list.length; i += 1) {
      var profile = byeImpactProfileForPlayer(list[i]);
      var rankText = profile.rank > 0
        ? (safeStr(profile.season) + " PPG rk #" + String(profile.rank))
        : "unranked";
      names.push(
        safeStr(list[i].name) +
        " (" + safeStr(list[i].positionGroup || list[i].position) +
        ", " + rankText +
        ", impact " + String(profile.weight) + ")"
      );
    }
    return "Week " + safeStr(week) + ": " + names.join(", ");
  }

  function byeCellTone(score) {
    var total = Math.max(0, safeInt(score, 0));
    if (total <= 0) return "is-empty";
    if (total >= 6) return "is-heavy";
    if (total >= 3) return "is-medium";
    return "is-light";
  }

  function byeImpactMatchesFilter(score, filterValue) {
    var filter = normByeImpactFilter(filterValue);
    if (!filter) return true;
    return byeCellTone(score) === ("is-" + filter);
  }

  function summarizeTeamByes(filteredPlayers, weeks) {
    var list = Array.isArray(filteredPlayers) ? filteredPlayers : [];
    var weekKeys = Array.isArray(weeks) ? weeks : [];
    var map = Object.create(null);
    var impactByWeek = Object.create(null);
    var peakImpact = 0;
    var peakWeeks = [];
    var withBye = 0;
    var noBye = 0;
    var totalImpact = 0;
    var weekSeen = Object.create(null);

    for (var i = 0; i < weekKeys.length; i += 1) {
      map[safeStr(weekKeys[i])] = [];
      weekSeen[safeStr(weekKeys[i])] = true;
    }

    for (var p = 0; p < list.length; p += 1) {
      var player = list[p];
      var week = String(byeWeekForPlayer(player));
      if (!safeInt(week, 0) || !weekSeen[week]) {
        noBye += 1;
        continue;
      }
      map[week].push(player);
      withBye += 1;
    }

    for (var x = 0; x < weekKeys.length; x += 1) {
      var key = safeStr(weekKeys[x]);
      map[key] = sortByePlayers(map[key] || []);
      var impact = byeImpactScoreForPlayers(map[key]);
      impactByWeek[key] = impact;
      totalImpact += impact;
      if (impact > peakImpact) {
        peakImpact = impact;
        peakWeeks = [key];
      } else if (impact > 0 && impact === peakImpact) {
        peakWeeks.push(key);
      }
    }

    return {
      byWeek: map,
      impactByWeek: impactByWeek,
      withBye: withBye,
      noBye: noBye,
      peakImpact: peakImpact,
      peakWeeks: peakWeeks,
      totalImpact: totalImpact
    };
  }

  function byePeakLabel(summary) {
    var data = summary || {};
    var weeks = Array.isArray(data.peakWeeks) ? data.peakWeeks : [];
    var impact = safeInt(data.peakImpact, 0);
    if (!impact || !weeks.length) return "—";
    return "W" + weeks.join("/W") + " · " + impact;
  }

  function byeSummaryHtml(teamViews) {
    var rows = [];
    var weeks = [];
    var leaguePlayers = [];
    var byeSeason = latestCompletedSeasonForByeView();
    var impactFilter = normByeImpactFilter(state.filterByeImpact);
    for (var i = 0; i < teamViews.length; i += 1) {
      var filteredPlayers = teamViews[i] && teamViews[i].filteredPlayers ? teamViews[i].filteredPlayers : [];
      for (var j = 0; j < filteredPlayers.length; j += 1) leaguePlayers.push(filteredPlayers[j]);
    }
    weeks = collectByeWeeksFromPlayers(leaguePlayers);
    if (!weeks.length) weeks = leagueByeWeeks();

    var leagueCounts = Object.create(null);
    for (var w = 0; w < weeks.length; w += 1) leagueCounts[safeStr(weeks[w])] = 0;
    var leagueNoBye = 0;

    for (var t = 0; t < teamViews.length; t += 1) {
      var row = teamViews[t] || {};
      var team = row.team || {};
      var filtered = row.filteredPlayers || [];
      var summary = summarizeTeamByes(filtered, weeks);
      var logo = safeStr(team.logo);
      var cells = [];
      var hasImpactMatch = !impactFilter;
      var visibleWithBye = 0;

      for (var c = 0; c < weeks.length; c += 1) {
        var weekKey = safeStr(weeks[c]);
        var players = summary.byWeek[weekKey] || [];
        var count = players.length;
        var impact = safeInt(summary.impactByWeek[weekKey], 0);
        var showCell = byeImpactMatchesFilter(impact, impactFilter);
        if (showCell && impact > 0) {
          hasImpactMatch = true;
          visibleWithBye += count;
          leagueCounts[weekKey] = safeInt(leagueCounts[weekKey], 0) + impact;
        }
        cells.push(
          '<td class="rwb-bye-week-col">' +
            '<div class="rwb-bye-cell ' + byeCellTone(showCell ? impact : 0) + '" title="' + escapeHtml(showCell ? byeTooltipText(weekKey, players) : ("Week " + weekKey + ": filtered by impact")) + '">' +
              '<span class="rwb-bye-cell-count">' + escapeHtml(showCell && impact > 0 ? String(impact) : "—") + '</span>' +
              '<span class="rwb-bye-cell-meta">' + escapeHtml(showCell ? (count > 0 ? (String(count) + (count === 1 ? " player" : " players")) : "clear") : "filtered") + '</span>' +
              (showCell ? byeCellPlayersHtml(players) : "") +
            '</div>' +
          '</td>'
        );
      }

      if (!hasImpactMatch) continue;

      var metaText = safeStr(impactFilter ? visibleWithBye : summary.withBye) + " players on bye";
      leagueNoBye += safeInt(summary.noBye, 0);
      rows.push(
        '<tr id="rwb-team-' + escapeHtml(team.id) + '">' +
          '<td>' +
            '<div class="rwb-franchise-cell">' +
              (logo
                ? '<img class="rwb-franchise-icon" src="' + escapeHtml(logo) + '" alt="' + escapeHtml(team.name) + ' logo">'
                : '<span class="rwb-franchise-icon rwb-franchise-icon-fallback">' + escapeHtml(team.fid) + '</span>') +
              '<div class="rwb-franchise-copy">' +
                '<div class="rwb-franchise-name">' + escapeHtml(team.name) + '</div>' +
                '<div class="rwb-franchise-meta">' + escapeHtml(metaText) + '</div>' +
              '</div>' +
            '</div>' +
          '</td>' +
          cells.join("") +
          '<td class="rwb-cell-num">' + escapeHtml(String(summary.noBye)) + '</td>' +
        '</tr>'
      );
    }

    var footerCells = [];
    for (var f = 0; f < weeks.length; f += 1) {
      var footerWeek = safeStr(weeks[f]);
      footerCells.push(
        '<th class="rwb-cell-num">' + escapeHtml(String(safeInt(leagueCounts[footerWeek], 0))) + '</th>'
      );
    }

    if (!rows.length) return "";

    return (
      '<article class="rwb-team-card rwb-bye-summary-card">' +
        '<div class="rwb-bye-summary-head">' +
          '<div>' +
            '<div class="rwb-bye-summary-title">Bye Week Heatmap</div>' +
            '<div class="rwb-bye-summary-sub">Each cell shows weighted bye impact using ' + escapeHtml(byeSeason ? (byeSeason + " PPG rank when available") : "latest completed-season PPG rank") + ', with the actual players listed in the cell.</div>' +
          '</div>' +
          '<div class="rwb-bye-summary-legend">' +
            '<span class="rwb-bye-legend-chip is-clear">0</span>' +
            '<span class="rwb-bye-legend-chip is-light">1-2</span>' +
            '<span class="rwb-bye-legend-chip is-medium">3-5</span>' +
            '<span class="rwb-bye-legend-chip is-heavy">6+</span>' +
          '</div>' +
        '</div>' +
        '<div class="rwb-table-wrap">' +
          '<table class="rwb-table rwb-bye-table" aria-label="Bye week heatmap">' +
            '<thead>' +
              '<tr>' +
                '<th>Franchise</th>' +
                weeks.map(function (week) { return '<th class="rwb-bye-week-col">W' + escapeHtml(week) + '</th>'; }).join("") +
                '<th>No Bye</th>' +
              '</tr>' +
            '</thead>' +
            '<tbody>' + rows.join("") + '</tbody>' +
            '<tfoot>' +
              '<tr class="rwb-summary-row rwb-summary-row-primary">' +
                '<th>League Total</th>' +
                footerCells.join("") +
                '<th class="rwb-cell-num">' + escapeHtml(String(leagueNoBye)) + '</th>' +
              '</tr>' +
            '</tfoot>' +
          '</table>' +
        '</div>' +
      '</article>'
    );
  }

  function capPlanSummaryHtml(teams) {
    var rows = [];
    var rowData = [];
    var leagueCapSpace = 0;
    var hasCapSpace = safeInt(state.salaryCapAmount, 0) > 0;
    var totals = {
      salary: 0,
      capSpace: 0,
      oneYearPlayers: 0,
      twoYearPlayers: 0,
      threeYearPlayers: 0,
      loadedContracts: 0,
      cutPlayers: 0,
      tradedSalary: 0,
      other: 0,
      taxiPlayers: 0
    };
    var showOtherAdjustments = false;

    for (var i = 0; i < teams.length; i += 1) {
      var team = teams[i] || {};
      var planSummary = summarizeCapPlanTeam(team);
      totals.salary += planSummary.salary;
      totals.oneYearPlayers += planSummary.oneYearPlayers;
      totals.twoYearPlayers += planSummary.twoYearPlayers;
      totals.threeYearPlayers += planSummary.threeYearPlayers;
      totals.loadedContracts += planSummary.loadedContracts;
      totals.cutPlayers += safeInt(planSummary.salaryAdjustmentBreakdown.cutPlayers, 0);
      totals.tradedSalary += safeInt(planSummary.salaryAdjustmentBreakdown.tradedSalary, 0);
      totals.other += safeInt(planSummary.salaryAdjustmentBreakdown.other, 0);
      totals.taxiPlayers += planSummary.taxiPlayers;
      showOtherAdjustments = showOtherAdjustments || safeInt(planSummary.salaryAdjustmentBreakdown.other, 0) !== 0;
      if (planSummary.capSpaceAvailable != null) {
        leagueCapSpace += planSummary.capSpaceAvailable;
        totals.capSpace = leagueCapSpace;
      }
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
        case "salary":
          delta = safeInt(left.salary, 0) - safeInt(right.salary, 0);
          break;
        case "one_year":
          delta = safeInt(left.oneYearPlayers, 0) - safeInt(right.oneYearPlayers, 0);
          break;
        case "two_year":
          delta = safeInt(left.twoYearPlayers, 0) - safeInt(right.twoYearPlayers, 0);
          break;
        case "three_year":
          delta = safeInt(left.threeYearPlayers, 0) - safeInt(right.threeYearPlayers, 0);
          break;
        case "loaded":
          delta = safeInt(left.loadedContracts, 0) - safeInt(right.loadedContracts, 0);
          break;
        case "capspace":
          delta = safeInt(left.capSpaceAvailable, 0) - safeInt(right.capSpaceAvailable, 0);
          break;
        case "cut_players":
          delta = safeInt(left.salaryAdjustmentBreakdown.cutPlayers, 0) - safeInt(right.salaryAdjustmentBreakdown.cutPlayers, 0);
          break;
        case "traded_salary":
          delta = safeInt(left.salaryAdjustmentBreakdown.tradedSalary, 0) - safeInt(right.salaryAdjustmentBreakdown.tradedSalary, 0);
          break;
        case "other_adjustments":
          delta = safeInt(left.salaryAdjustmentBreakdown.other, 0) - safeInt(right.salaryAdjustmentBreakdown.other, 0);
          break;
        case "taxi":
          delta = safeInt(left.taxiPlayers, 0) - safeInt(right.taxiPlayers, 0);
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
          '<td class="rwb-summary-team-col">' +
            '<div class="rwb-summary-team-cell" title="' + escapeHtml(teamRow.name) + '">' +
              (logo
                ? '<img class="rwb-franchise-icon" src="' + escapeHtml(logo) + '" alt="' + escapeHtml(teamRow.name) + ' logo">'
                : '<span class="rwb-franchise-icon rwb-franchise-icon-fallback">' + escapeHtml(teamRow.fid) + '</span>') +
              '<span class="rwb-visually-hidden">' + escapeHtml(teamRow.name) + '</span>' +
            '</div>' +
          '</td>' +
          '<td class="rwb-cell-num">' + escapeHtml(money(planSummaryRow.salary)) + '</td>' +
          '<td class="rwb-cell-num">' + escapeHtml(String(planSummaryRow.oneYearPlayers)) + '</td>' +
          '<td class="rwb-cell-num">' + escapeHtml(String(planSummaryRow.twoYearPlayers)) + '</td>' +
          '<td class="rwb-cell-num">' + escapeHtml(String(planSummaryRow.threeYearPlayers)) + '</td>' +
          '<td class="rwb-cell-num">' + escapeHtml(String(planSummaryRow.loadedContracts)) + '</td>' +
          '<td class="rwb-cell-num">' + escapeHtml(money(planSummaryRow.salaryAdjustmentBreakdown.tradedSalary)) + '</td>' +
          '<td class="rwb-cell-num">' + escapeHtml(money(planSummaryRow.salaryAdjustmentBreakdown.cutPlayers)) + '</td>' +
          (showOtherAdjustments ? '<td class="rwb-cell-num">' + escapeHtml(money(planSummaryRow.salaryAdjustmentBreakdown.other)) + '</td>' : '') +
          '<td class="rwb-cell-num' + (planSummaryRow.capSpaceAvailable != null && planSummaryRow.capSpaceAvailable < 0 ? ' rwb-cap-space-negative' : '') + '">' + escapeHtml(planSummaryRow.capSpaceAvailable == null ? "—" : money(planSummaryRow.capSpaceAvailable)) + '</td>' +
          '<td class="rwb-cell-num">' + escapeHtml(String(planSummaryRow.taxiPlayers)) + '</td>' +
        '</tr>'
      );
    }

    return (
      '<article class="rwb-team-card rwb-franchise-summary-card">' +
        '<div class="rwb-bye-summary-head rwb-cap-plan-summary-head">' +
          '<div>' +
            '<div class="rwb-bye-summary-title">Cap Plan Summary</div>' +
            '<div class="rwb-bye-summary-sub">Salary, remaining-year mix, loaded contracts, trade and cap adjustments, then cap space.</div>' +
          '</div>' +
        '</div>' +
        '<div class="rwb-table-wrap">' +
          '<table class="rwb-table rwb-franchise-table rwb-cap-plan-summary-table" aria-label="Cap plan summary">' +
            '<thead>' +
              '<tr>' +
                sortableHeader("franchise", "franchise", "Team") +
                sortableHeader("franchise", "salary", "Salary") +
                sortableHeader("franchise", "one_year", "1 Yr") +
                sortableHeader("franchise", "two_year", "2 Yr") +
                sortableHeader("franchise", "three_year", "3 Yr") +
                sortableHeader("franchise", "loaded", "Loaded") +
                sortableHeader("franchise", "traded_salary", "Trade Adj") +
                sortableHeader("franchise", "cut_players", "Cap Adj") +
                (showOtherAdjustments ? sortableHeader("franchise", "other_adjustments", "Other") : "") +
                sortableHeader("franchise", "capspace", "Cap Space") +
                sortableHeader("franchise", "taxi", "Taxi") +
              '</tr>' +
            '</thead>' +
            '<tbody>' + rows.join("") + '</tbody>' +
            '<tfoot>' +
              '<tr class="rwb-summary-row rwb-summary-row-primary">' +
                '<th>League</th>' +
                '<th class="rwb-cell-num">' + escapeHtml(money(totals.salary)) + '</th>' +
                '<th class="rwb-cell-num">' + escapeHtml(String(totals.oneYearPlayers)) + '</th>' +
                '<th class="rwb-cell-num">' + escapeHtml(String(totals.twoYearPlayers)) + '</th>' +
                '<th class="rwb-cell-num">' + escapeHtml(String(totals.threeYearPlayers)) + '</th>' +
                '<th class="rwb-cell-num">' + escapeHtml(String(totals.loadedContracts)) + '</th>' +
                '<th class="rwb-cell-num">' + escapeHtml(money(totals.tradedSalary)) + '</th>' +
                '<th class="rwb-cell-num">' + escapeHtml(money(totals.cutPlayers)) + '</th>' +
                (showOtherAdjustments ? '<th class="rwb-cell-num">' + escapeHtml(money(totals.other)) + '</th>' : '') +
                '<th class="rwb-cell-num">' + escapeHtml(hasCapSpace ? money(leagueCapSpace) : "—") + '</th>' +
                '<th class="rwb-cell-num">' + escapeHtml(String(totals.taxiPlayers)) + '</th>' +
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
      totalStarts: 0,
      totalAppearances: 0
    };

    for (var i = 0; i < players.length; i += 1) {
      var playerSummary = summarizePointsSelection(players[i]);
      summary.totalPoints += safeNum(playerSummary.points, 0);
      summary.totalStarts += safeInt(playerSummary.starts, 0);
      summary.totalAppearances += safeInt(playerSummary.appearances, 0);
      if (playerSummary.hasData) summary.withData += 1;
    }

    return summary;
  }

  function pointsHistoryToggleKey(team, player) {
    return safeStr(team && team.id) + ":" + safeStr(player && player.id);
  }

  function pointsYearlyHistoryTableHtml(player) {
    var years = selectedHistoryYears();
    var eliteRanks = yearlyEliteRanksBySeason();
    var header = ['<th>Metric</th>'];
    var pointsRow = ['<tr><th>Points</th>'];
    var rankRow = ['<tr><th>Pos Rank</th>'];
    var ppgRow = ['<tr><th>PPG</th>'];
    var ppgRankRow = ['<tr><th>PPG Rank</th>'];
    var eliteWeeksRow = ['<tr><th>Elite Weeks</th>'];
    var eliteRankRow = ['<tr><th>Elite Pos Rk</th>'];
    var dudWeeksRow = ['<tr><th>Dud Weeks</th>'];

    for (var i = 0; i < years.length; i += 1) {
      var year = years[i];
      var row = playerYearlyHistoryRow(player, year);
      var seasonWeekSummary = seasonEliteWeekSummaryForPlayer(player, year);
      var eliteRank = eliteRanks[year] ? safeInt(eliteRanks[year][safeStr(player.id)], 0) : 0;
      header.push('<th>' + escapeHtml(year) + '</th>');
      if (!row) {
        pointsRow.push('<td class="rwb-points-history-missing">—</td>');
        rankRow.push('<td class="rwb-points-history-missing">—</td>');
        ppgRow.push('<td class="rwb-points-history-missing">—</td>');
        ppgRankRow.push('<td class="rwb-points-history-missing">—</td>');
      } else {
        pointsRow.push('<td class="rwb-cell-num">' + escapeHtml(formatPoints(row[0])) + '</td>');
        rankRow.push('<td class="rwb-cell-num">' + escapeHtml(formatRank(row[3])) + '</td>');
        ppgRow.push('<td class="rwb-cell-num">' + escapeHtml(formatPpg(row[2], row[1])) + '</td>');
        ppgRankRow.push('<td class="rwb-cell-num">' + escapeHtml(formatRank(row[4])) + '</td>');
      }
      eliteWeeksRow.push(
        safeInt(seasonWeekSummary.bucketWeeks, 0) > 0
          ? '<td class="rwb-cell-num rwb-points-history-cell">' + historyBadgeHtml(String(safeInt(seasonWeekSummary.eliteWeeks, 0)), safeInt(seasonWeekSummary.eliteWeeks, 0) > 0 ? "is-elite" : "is-neutral") + '</td>'
          : '<td class="rwb-points-history-missing">—</td>'
      );
      eliteRankRow.push(
        safeInt(seasonWeekSummary.bucketWeeks, 0) > 0 && eliteRank > 0
          ? '<td class="rwb-cell-num rwb-points-history-cell">' + historyBadgeHtml(formatRank(eliteRank), "is-neutral") + '</td>'
          : '<td class="rwb-points-history-missing">—</td>'
      );
      dudWeeksRow.push(
        safeInt(seasonWeekSummary.bucketWeeks, 0) > 0
          ? '<td class="rwb-cell-num rwb-points-history-cell">' + historyBadgeHtml(String(safeInt(seasonWeekSummary.dudWeeks, 0)), safeInt(seasonWeekSummary.dudWeeks, 0) > 0 ? "is-dud" : "is-neutral") + '</td>'
          : '<td class="rwb-points-history-missing">—</td>'
      );
    }

    pointsRow.push('</tr>');
    rankRow.push('</tr>');
    ppgRow.push('</tr>');
    ppgRankRow.push('</tr>');
    eliteWeeksRow.push('</tr>');
    eliteRankRow.push('</tr>');
    dudWeeksRow.push('</tr>');

    return (
      '<div class="rwb-points-history-wrap">' +
        '<table class="rwb-table rwb-points-history-table" aria-label="' + escapeHtml(player.name + ' yearly points history') + '">' +
          '<thead><tr>' + header.join("") + '</tr></thead>' +
          '<tbody>' + pointsRow.join("") + rankRow.join("") + ppgRow.join("") + ppgRankRow.join("") + eliteWeeksRow.join("") + eliteRankRow.join("") + dudWeeksRow.join("") + '</tbody>' +
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
    var tierRow = ['<tr><th>Tier</th>'];
    var posScoreRow = ['<tr><th>Pos Score</th>'];

    for (var i = 0; i < weeks.length; i += 1) {
      var week = weeks[i];
      var row = playerWeeklyHistoryRow(player, season, week);
      header.push('<th>' + escapeHtml(String(week)) + '</th>');
      if (!row) {
        pointsRow.push('<td class="rwb-points-history-missing">—</td>');
        rankRow.push('<td class="rwb-points-history-missing">—</td>');
        startedRow.push('<td class="rwb-points-history-missing">—</td>');
        tierRow.push('<td class="rwb-points-history-missing">—</td>');
        posScoreRow.push('<td class="rwb-points-history-missing">—</td>');
        continue;
      }
      var points = weeklyHistoryFieldValue(row, "points", 0);
      var rank = weeklyHistoryFieldValue(row, "pos_rank", 1);
      var started = weeklyHistoryFieldValue(row, "started", 2);
      var bucket = weeklyHistoryBucketLabel(row);
      var posScore = weeklyHistoryFieldValue(row, "pos_week_score", -1);
      pointsRow.push('<td class="rwb-cell-num">' + escapeHtml(formatPoints(points)) + '</td>');
      rankRow.push('<td class="rwb-cell-num">' + escapeHtml(formatRank(rank)) + '</td>');
      startedRow.push('<td class="rwb-cell-num rwb-points-history-cell">' + startedBadgeHtml(started) + '</td>');
      tierRow.push('<td class="rwb-cell-num rwb-points-history-cell">' + tierBadgeHtml(bucket) + '</td>');
      posScoreRow.push('<td class="rwb-cell-num rwb-points-history-cell">' + posScoreBadgeHtml(posScore) + '</td>');
    }

    pointsRow.push('</tr>');
    rankRow.push('</tr>');
    startedRow.push('</tr>');
    tierRow.push('</tr>');
    posScoreRow.push('</tr>');

    return (
      '<div class="rwb-points-history-wrap">' +
        '<table class="rwb-table rwb-points-history-table" aria-label="' + escapeHtml(player.name + ' weekly points history for ' + season) + '">' +
          '<thead><tr>' + header.join("") + '</tr></thead>' +
          '<tbody>' + pointsRow.join("") + rankRow.join("") + startedRow.join("") + tierRow.join("") + posScoreRow.join("") + '</tbody>' +
        '</table>' +
      '</div>'
    );
  }

  function pointsHistoryDetailHtml(team, player, summary) {
    return (
      '<div class="rwb-points-detail">' +
        '<div class="rwb-points-detail-head">' +
          '<div>' +
            '<div class="rwb-points-detail-title">' + escapeHtml(player.name) + '</div>' +
          '</div>' +
        '</div>' +
        (state.pointsHistoryMode === "weekly" ? pointsWeeklyHistoryTableHtml(player) : pointsYearlyHistoryTableHtml(player)) +
      '</div>'
    );
  }

  function pointsPlayerRowHtml(team, player) {
    var summary = summarizePointsSelection(player);
    var weeklyRanks = state.pointsHistoryMode === "weekly" ? weeklySummaryRanksByPlayer() : null;
    var toggleKey = pointsHistoryToggleKey(team, player);
    var expanded = !!state.pointsExpanded[toggleKey];
    var tags = [];
    if (player.isTaxi) tags.push('<span class="rwb-tag is-taxi">Taxi</span>');
    if (player.isIr) tags.push('<span class="rwb-tag is-ir">IR</span>');
    var pointsValue = summary.hasData ? formatPoints(summary.points) : "—";
    var ppgValue = summary.hasData ? formatPpg(summary.ppg, state.pointsHistoryMode === "weekly" ? summary.appearances : summary.games) : "—";
    var pointsCell = state.pointsHistoryMode === "weekly"
      ? pointsStatWithRankHtml(pointsValue, weeklyRanks && weeklyRanks.points ? weeklyRanks.points[safeStr(player.id)] : 0)
      : escapeHtml(pointsValue);
    var ppgCell = state.pointsHistoryMode === "weekly"
      ? pointsStatWithRankHtml(ppgValue, weeklyRanks && weeklyRanks.ppg ? weeklyRanks.ppg[safeStr(player.id)] : 0)
      : escapeHtml(ppgValue);
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
        '<td class="rwb-cell-num">' + pointsCell + '</td>' +
        '<td class="rwb-cell-num">' + ppgCell + '</td>' +
        '<td class="rwb-cell-num">' + escapeHtml(state.pointsHistoryMode === "weekly" ? formatStartRatio(summary.starts, summary.appearances) : formatRank(summary.bestRank)) + '</td>' +
        '<td class="rwb-cell-num">' + escapeHtml(state.pointsHistoryMode === "weekly" ? (summary.hasData ? formatEliteNeutralDudSummary(summary.eliteWeeks, summary.neutralWeeks, summary.dudWeeks) : "—") : formatRank(summary.bestPpgRank)) + '</td>' +
        '<td><button type="button" class="rwb-row-action" data-action="points-toggle" data-franchise-id="' + escapeHtml(team.id) + '" data-player-id="' + escapeHtml(player.id) + '">' + (expanded ? "Hide" : "Details") + '</button></td>' +
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
            (state.pointsHistoryMode === "weekly"
              ? '<span class="rwb-chip"><span class="rwb-chip-label">Starts</span><span class="rwb-chip-value">' + escapeHtml(formatStartRatio(summary.totalStarts, summary.totalAppearances)) + '</span></span>'
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
                  sortableHeader("points", state.pointsHistoryMode === "weekly" ? "starts" : "rank", state.pointsHistoryMode === "weekly" ? "Starts" : "Best Rk") +
                  sortableHeader("points", state.pointsHistoryMode === "weekly" ? "rank" : "ppg_rank", state.pointsHistoryMode === "weekly" ? "Elite / Neutral / Dud" : "Best PPG Rk") +
                  '<th>Details</th>' +
                '</tr>' +
              '</thead>' +
              '<tbody>' + rows.join("") + '</tbody>' +
            '</table>' +
          '</div>' +
        '</div>' +
      '</article>'
    );
  }

  function filteredTagRowsForTeam(team) {
    var fid = pad4(team && team.id);
    var out = [];
    var rows = currentTagPlanRows();
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i] || {};
      if (pad4(row.franchise_id) !== fid) continue;
      if (!tagRowMatchesFilters(row)) continue;
      out.push(row);
    }
    return sortTagRows(out);
  }

  function countTagRowsForTeam(team) {
    var fid = pad4(team && team.id);
    var count = 0;
    var rows = currentTagPlanRows();
    for (var i = 0; i < rows.length; i += 1) {
      if (pad4(rows[i] && rows[i].franchise_id) === fid) count += 1;
    }
    return count;
  }

  function tagStatusChipHtml(team, side) {
    var activePlayer = activeTaggedPlayerForTeamSide(team, side);
    var label = tagSideLabel(side);
    if (!activePlayer) {
      return '<span class="rwb-chip"><span class="rwb-chip-label">' + escapeHtml(label) + ' Tag</span><span class="rwb-chip-value">Open</span></span>';
    }
    return '<span class="rwb-chip is-good" title="' + escapeHtml(activePlayer.name) + '"><span class="rwb-chip-label">' + escapeHtml(label) + ' Tag</span><span class="rwb-chip-value">' + escapeHtml(activePlayer.name) + '</span></span>';
  }

  function tagPlanTeamCardHtml(team, rows) {
    var list = rows || [];
    var totalEligible = countTagRowsForTeam(team);
    var canManage = canManageTagForTeam(team && team.id);
    var bodyRows = [];

    for (var i = 0; i < list.length; i += 1) {
      var row = list[i] || {};
      var activeSidePlayer = activeTaggedPlayerForTeamSide(team, row.side);
      var activePid = safeStr(activeSidePlayer && activeSidePlayer.id).replace(/\D/g, "");
      var rowPid = safeStr(row.player_id).replace(/\D/g, "");
      var isActive = !!activePid && activePid === rowPid;
      var locked = !!activeSidePlayer && !isActive;
      var actionHtml = '<span class="rwb-row-action-placeholder">—</span>';
      if (canManage) {
        if (isActive) {
          actionHtml =
            '<button type="button" class="rwb-row-action" data-action="untag-player" data-player-id="' + escapeHtml(row.player_id) + '" data-franchise-id="' + escapeHtml(team.id) + '">Untag</button>';
        } else if (locked) {
          actionHtml =
            '<button type="button" class="rwb-row-action is-disabled" disabled title="' + escapeHtml(tagSideLabel(row.side) + ' tag already used by ' + safeStr(activeSidePlayer && activeSidePlayer.name)) + '">Locked</button>';
        } else {
          actionHtml =
            '<button type="button" class="rwb-row-action" data-action="tag-player" data-player-id="' + escapeHtml(row.player_id) + '" data-franchise-id="' + escapeHtml(team.id) + '">Tag</button>';
        }
      }

      bodyRows.push(
        '<tr class="' + (isActive ? 'rwb-tag-plan-row is-active' : 'rwb-tag-plan-row') + '">' +
          '<td>' +
            '<div class="rwb-player-name-wrap">' +
              '<div class="rwb-player-line">' +
                '<span class="rwb-pos-pill">' + escapeHtml(row.positional_grouping) + '</span>' +
                '<span class="rwb-player-name">' + escapeHtml(row.player_name) + '</span>' +
                (isActive ? '<span class="rwb-tag is-tagged">Tagged</span>' : '') +
              '</div>' +
              '<div class="rwb-points-player-sub">' + escapeHtml(tagPriorAavSubtext(row)) + '</div>' +
            '</div>' +
          '</td>' +
          '<td><span class="rwb-tag-side-pill is-' + escapeHtml(normalizeTagSideValue(row.side).toLowerCase()) + '">' + escapeHtml(tagSideLabel(row.side)) + '</span></td>' +
          '<td class="rwb-cell-num">' + escapeHtml(formatPoints(row.points_total)) + '</td>' +
          '<td class="rwb-cell-num">' + escapeHtml(formatRank(row.pos_rank)) + '</td>' +
          '<td class="rwb-cell-num">' + escapeHtml(safeInt(row.tag_tier, 0) > 0 ? ('Tier ' + String(safeInt(row.tag_tier, 0))) : '—') + '</td>' +
          '<td class="rwb-cell-num">' + escapeHtml(formatContractK(effectiveTagSalaryForRow(row))) + '</td>' +
          '<td class="rwb-tag-calc-cell">' + escapeHtml(effectiveTagFormulaForRow(row) || "—") + '</td>' +
          '<td class="rwb-cell-num">' + actionHtml + '</td>' +
        '</tr>'
      );
    }

    return (
      '<article class="rwb-team-card rwb-tag-plan-card" id="rwb-team-' + escapeHtml(team.id) + '" data-team-id="' + escapeHtml(team.id) + '">' +
        teamHeaderHtml(team, team.players || []) +
        '<div class="rwb-team-body">' +
          '<div class="rwb-tag-plan-summary">' +
            '<span class="rwb-chip"><span class="rwb-chip-label">Eligible</span><span class="rwb-chip-value">' + escapeHtml(String(list.length) + '/' + String(totalEligible)) + '</span></span>' +
            tagStatusChipHtml(team, "OFFENSE") +
            tagStatusChipHtml(team, "DEFENSE") +
          '</div>' +
          '<div class="rwb-table-wrap">' +
            '<table class="rwb-table rwb-tag-plan-table" aria-label="' + escapeHtml(team.name + ' tag plan') + '">' +
              '<thead>' +
                '<tr>' +
                  '<th>Player</th>' +
                  '<th>Side</th>' +
                  '<th>Prior Pts</th>' +
                  '<th>Pos Rk</th>' +
                  '<th>Tier</th>' +
                  '<th>Tag Cost</th>' +
                  '<th>Tag Calc</th>' +
                  '<th>Action</th>' +
                '</tr>' +
              '</thead>' +
              '<tbody>' + bodyRows.join("") + '</tbody>' +
            '</table>' +
          '</div>' +
        '</div>' +
      '</article>'
    );
  }

  function currentTagCalcBreakdown() {
    var selectedSeason = tagDisplaySeason();
    var liveSeason = safeStr(state.tagData && state.tagData.cycleSeason);
    if (selectedSeason && liveSeason && selectedSeason !== liveSeason) {
      return projectedTagCalcBreakdown(selectedSeason);
    }
    return state.tagData && state.tagData.calcBreakdown && typeof state.tagData.calcBreakdown === "object"
      ? state.tagData.calcBreakdown
      : {};
  }

  function tagBreakdownUsesProjectedSeason() {
    var selectedSeason = tagDisplaySeason();
    var liveSeason = safeStr(state.tagData && state.tagData.cycleSeason);
    return !!(selectedSeason && liveSeason && selectedSeason !== liveSeason);
  }

  function projectedTagBasisForPlayerId(playerId, targetSeason) {
    var season = safeInt(targetSeason, 0);
    var current = currentYearInt();
    if (!season || season < current) return 0;
    var source = findTaggedPlayerSourceSnapshot("", playerId);
    if (!source) return 0;
    return Math.max(0, displayedSalaryForPlan(source, season - current));
  }

  function projectedTagCalcBreakdown(targetSeason) {
    var calcSource = state.tagTrackingMeta && typeof state.tagTrackingMeta.calc_breakdown === "object"
      ? state.tagTrackingMeta.calc_breakdown
      : {};
    var candidateRows = applyProjectedTagRanksAndTiers(projectedTagCandidates(targetSeason), targetSeason);
    var groupedCandidates = Object.create(null);
    for (var c = 0; c < candidateRows.length; c += 1) {
      var candidate = candidateRows[c] || {};
      var candidateKey = safeStr(candidate.positional_grouping).toUpperCase() || "OTHER";
      if (!groupedCandidates[candidateKey]) groupedCandidates[candidateKey] = [];
      groupedCandidates[candidateKey].push(candidate);
    }
    var output = Object.create(null);
    var positions = Object.keys(calcSource);
    for (var i = 0; i < positions.length; i += 1) {
      var posKey = positions[i];
      var ref = calcSource[posKey] || {};
      var tiers = Array.isArray(ref.tiers) ? ref.tiers : [];
      var rankedPlayers = groupedCandidates[posKey] || [];
      var nextTiers = [];
      for (var j = 0; j < tiers.length; j += 1) {
        var tier = tiers[j] || {};
        var nextPlayers = [];
        var total = 0;
        var minRank = Math.max(1, safeInt(tier.rank_min, 0) || 1);
        var maxRank = Math.max(minRank, safeInt(tier.rank_max, 0) || minRank);
        for (var p = 0; p < rankedPlayers.length; p += 1) {
          var player = rankedPlayers[p] || {};
          var rank = safeInt(player.pos_rank, 0);
          if (rank < minRank || rank > maxRank) continue;
          var projectedAav = Math.max(
            safeInt(player.prior_aav_week1, 0),
            safeInt(player.prior_salary_week1, 0),
            safeInt(player.aav, 0),
            safeInt(player.salary, 0)
          );
          total += projectedAav;
          nextPlayers.push({
            rank: rank,
            player_id: safeStr(player.player_id).replace(/\D/g, ""),
            player_name: safeStr(player.player_name),
            aav: projectedAav
          });
        }
        nextPlayers.sort(function (a, b) {
          var rankDelta = safeInt(a && a.rank, 0) - safeInt(b && b.rank, 0);
          if (rankDelta !== 0) return rankDelta;
          return compareText(a && a.player_name, b && b.player_name);
        });
        var avg = nextPlayers.length ? (total / nextPlayers.length) : 0;
        nextTiers.push({
          tier: safeInt(tier.tier, 0),
          label: safeStr(tier.label),
          rank_min: minRank,
          rank_max: maxRank,
          base_bid: avg > 0 ? Math.ceil(avg / 1000) * 1000 : 0,
          players: nextPlayers
        });
      }
      output[posKey] = { tiers: nextTiers };
    }
    return output;
  }

  function tagBreakdownPositionKeys() {
    return Object.keys(currentTagCalcBreakdown()).sort(function (a, b) {
      var av = positionSortValue(a);
      var bv = positionSortValue(b);
      if (av !== bv) return av - bv;
      return safeStr(a).localeCompare(safeStr(b));
    });
  }

  function tagTierLabel(posKey, tier) {
    return safeStr(posKey).toUpperCase() + " Tier " + String(Math.max(1, safeInt(tier, 1)));
  }

  function tagBreakdownPositionCardHtml(posKey, data) {
    var tiers = data && Array.isArray(data.tiers) ? data.tiers : [];
    var tierCards = [];

    for (var i = 0; i < tiers.length; i += 1) {
      var tier = tiers[i] || {};
      var players = Array.isArray(tier.players) ? tier.players : [];
      var rows = [];
      for (var j = 0; j < players.length; j += 1) {
        var player = players[j] || {};
        rows.push(
          '<tr>' +
            '<td class="rwb-cell-num">' + escapeHtml(formatRank(player.rank)) + '</td>' +
            '<td>' + escapeHtml(safeStr(player.player_name) || "—") + '</td>' +
            '<td class="rwb-cell-num">' + escapeHtml(formatContractK(player.aav)) + '</td>' +
          '</tr>'
        );
      }

      var baseBid = safeInt(tier.base_bid, 0);
      var baseLabel = baseBid > 0 ? formatContractK(baseBid) : "Rule Based";
      var ruleLabel = safeStr(tier.label);
      var emptyText = safeStr(posKey).toUpperCase() === "PK"
        ? "No pooled league average is used here. PK tags follow the prior AAV plus $1K rule."
        : "No contributing players were stored for this tier.";

      tierCards.push(
        '<section class="rwb-tag-tier-card">' +
          '<header class="rwb-tag-tier-head">' +
            '<div>' +
              '<div class="rwb-tag-tier-kicker">' + escapeHtml(tagTierLabel(posKey, tier.tier)) + '</div>' +
              '<div class="rwb-tag-tier-rule">' + escapeHtml(ruleLabel || "—") + '</div>' +
            '</div>' +
            '<div class="rwb-tag-tier-base">' +
              '<span class="rwb-tag-tier-base-label">Base Bid</span>' +
              '<span class="rwb-tag-tier-base-value">' + escapeHtml(baseLabel) + '</span>' +
            '</div>' +
          '</header>' +
          (rows.length
            ? '<div class="rwb-table-wrap">' +
                '<table class="rwb-table rwb-tag-breakdown-table" aria-label="' + escapeHtml(positionGroupLabel(posKey) + " " + tagTierLabel(posKey, tier.tier)) + '">' +
                  '<thead>' +
                    '<tr>' +
                      '<th>Rank</th>' +
                      '<th>Player</th>' +
                      '<th>AAV</th>' +
                    '</tr>' +
                  '</thead>' +
                  '<tbody>' + rows.join("") + '</tbody>' +
                '</table>' +
              '</div>'
            : '<div class="rwb-tag-breakdown-empty">' + escapeHtml(emptyText) + '</div>') +
        '</section>'
      );
    }

    return (
      '<article class="rwb-team-card rwb-tag-breakdown-card">' +
        '<header class="rwb-tag-breakdown-head">' +
          '<div>' +
            '<div class="rwb-tag-breakdown-kicker">' + escapeHtml(safeStr(posKey).toUpperCase()) + '</div>' +
            '<h2 class="rwb-tag-breakdown-title">' + escapeHtml(positionGroupLabel(posKey)) + '</h2>' +
          '</div>' +
          '<div class="rwb-tag-breakdown-summary">' +
            '<span class="rwb-chip"><span class="rwb-chip-label">Tag Year</span><span class="rwb-chip-value">' + escapeHtml(tagDisplaySeason() || "—") + '</span></span>' +
            '<span class="rwb-chip"><span class="rwb-chip-label">Tiers</span><span class="rwb-chip-value">' + escapeHtml(String(tiers.length)) + '</span></span>' +
          '</div>' +
        '</header>' +
        (tagBreakdownUsesProjectedSeason()
          ? '<div class="rwb-tag-breakdown-note">Projected year uses scheduled salary for that season. Expiring deals count as $0 until extended, tagged, or replaced at auction. These values remain live until the contract deadline locks them.</div>'
          : '') +
        '<div class="rwb-tag-breakdown-grid">' + tierCards.join("") + '</div>' +
      '</article>'
    );
  }

  function tagBreakdownViewHtml() {
    var keys = tagBreakdownPositionKeys();
    if (!keys.length) return "";
    var sections = [];
    for (var i = 0; i < keys.length; i += 1) {
      sections.push(tagBreakdownPositionCardHtml(keys[i], currentTagCalcBreakdown()[keys[i]]));
    }
    return '<div class="rwb-tag-breakdown-shell">' + sections.join("") + '</div>';
  }

  function teamCardHtml(team, rosterGroupSummaryMap) {
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
          blocks.push(rosterGroupHtml(team, grouped[g], rosterGroupSummaryMap));
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
    ensureSelectedTeamId();
    var teamsToRender = scopedTeamsForDisplay();
    var totalTeams = teamsToRender.length;

    if (state.view === "tag" && tagBreakdownActive()) {
      if (state.tagDataLoading && !state.tagData) {
        els.teamList.innerHTML = '<div class="rwb-loading">Loading tag cost breakdown...</div>';
        renderToolbarNote(0, 0, 0, 0);
        renderPlayerActionModal();
        return;
      }
      if (state.tagDataError && !state.tagData) {
        els.teamList.innerHTML = '<div class="rwb-error">' + escapeHtml(state.tagDataError) + '</div>';
        renderToolbarNote(0, 0, 0, 0);
        renderPlayerActionModal();
        return;
      }
      var breakdownKeys = tagBreakdownPositionKeys();
      var breakdownHtml = tagBreakdownViewHtml();
      if (!breakdownHtml) {
        els.teamList.innerHTML = '<div class="rwb-empty">No tag cost breakdown is available for this season.</div>';
      } else {
        els.teamList.innerHTML = breakdownHtml;
      }
      renderToolbarNote(breakdownKeys.length, breakdownKeys.length, breakdownKeys.length ? 1 : 0, 1);
      renderPlayerActionModal();
      return;
    }

    if (state.view === "tag") {
      if (state.tagDataLoading && !state.tagData) {
        els.teamList.innerHTML = '<div class="rwb-loading">Loading tag plan...</div>';
        renderToolbarNote(0, 0, 0, totalTeams);
        renderPlayerActionModal();
        return;
      }
      if (state.tagDataError && !state.tagData) {
        els.teamList.innerHTML = '<div class="rwb-error">' + escapeHtml(state.tagDataError) + '</div>';
        renderToolbarNote(0, 0, 0, totalTeams);
        renderPlayerActionModal();
        return;
      }
    }

    if (state.view === "points") {
      if (state.pointsHistoryLoading && !state.pointsHistory) {
        els.teamList.innerHTML = '<div class="rwb-loading">Loading stored points history...</div>';
        renderToolbarNote(0, 0, 0, totalTeams);
        renderPlayerActionModal();
        return;
      }
      if (state.pointsHistoryError && !state.pointsHistory) {
        els.teamList.innerHTML = '<div class="rwb-error">' + escapeHtml(state.pointsHistoryError) + '</div>';
        renderToolbarNote(0, 0, 0, totalTeams);
        renderPlayerActionModal();
        return;
      }
      ensurePointsHistorySelection();
    }

    var totalPlayers = 0;
    var visiblePlayers = 0;
    var html = [];
    var visibleTeams = [];
    var rosterGroupSummaryMap = state.view === "roster" ? buildRosterGroupSalarySummaryMap() : null;
    var summaryMode = capPlanSummaryViewActive();

    for (var i = 0; i < teamsToRender.length; i += 1) {
      var team = teamsToRender[i] || {};
      if (state.view === "tag") {
        var teamTagTotal = countTagRowsForTeam(team);
        var tagRows = filteredTagRowsForTeam(team);
        totalPlayers += teamTagTotal;
        visiblePlayers += tagRows.length;
        if (!tagRows.length) continue;
        visibleTeams.push({
          team: team,
          filteredPlayers: tagRows
        });
        html.push(tagPlanTeamCardHtml(team, tagRows));
        continue;
      }

      totalPlayers += (team.players || []).length;
      var filteredPlayers = summaryMode ? (team.players || []) : filteredPlayersForTeam(team);
      visiblePlayers += summaryMode ? (team.players || []).length : filteredPlayers.length;
      if (!filteredPlayers.length && !summaryMode) continue;
      visibleTeams.push({
        team: team,
        filteredPlayers: filteredPlayers
      });
      if (state.view === "points") {
        html.push(pointsTeamCardHtml(team, filteredPlayers));
      } else if (state.view !== "bye" && !summaryMode) {
        html.push(teamCardHtml(team, rosterGroupSummaryMap));
      }
    }

    if (state.view === "contract" && summaryMode && totalTeams) {
      html.push(capPlanSummaryHtml(teamsToRender));
    } else if (state.view === "bye" && visibleTeams.length) {
      var byeHtml = byeSummaryHtml(visibleTeams);
      if (byeHtml) html.push(byeHtml);
    }

    if (!html.length) {
      els.teamList.innerHTML = '<div class="rwb-empty">No players match the current filters.</div>';
    } else {
      els.teamList.innerHTML = html.join("");
    }

    renderToolbarNote(visiblePlayers, totalPlayers, visibleTeams.length, totalTeams);
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
    writeStorage("selectedTeamId", state.selectedTeamId);
    writeStorage("filterPosition", state.filterPosition);
    writeStorage("filterType", state.filterType);
    writeStorage("filterRosterStatus", state.filterRosterStatus);
    writeStorage("filterContractAction", state.filterContractAction);
    writeStorage("filterByeImpact", state.filterByeImpact);
    writeStorage("taxiOnly", state.filterRosterStatus === "taxi");
    writeStorage("contractPreview", state.contractPreview);
    writeStorage("view", state.view);
    writeStorage("contractSubView", state.contractSubView);
    writeStorage("tagSubView", state.tagSubView);
    writeStorage("tagDisplayYear", state.tagDisplayYear);
    writeStorage("pointsMode", state.pointsMode);
    writeStorage("pointsHistoryMode", state.pointsHistoryMode);
    writeStorage("pointsHistoryYearStart", state.pointsHistoryYearStart);
    writeStorage("pointsHistoryYearEnd", state.pointsHistoryYearEnd);
    writeStorage("pointsHistorySeason", state.pointsHistorySeason);
    writeStorage("pointsHistoryWeekStart", state.pointsHistoryWeekStart);
    writeStorage("pointsHistoryWeekEnd", state.pointsHistoryWeekEnd);
    writeStorage("pointsHistoryDefaultContext", pointsHistoryDefaultContextKey());
    writeStorage("pointsExpanded", state.pointsExpanded);
    writeStorage("sorts", state.sorts);
  }

  function restoreState() {
    state.search = safeStr(readStorage("search", "")).toLowerCase();
    state.selectedTeamId = pad4(readStorage("selectedTeamId", ""));
    state.filterPosition = safeStr(readStorage("filterPosition", "")).toUpperCase();
    state.filterType = normType(readStorage("filterType", ""));
    state.filterRosterStatus = normRosterStatusFilter(readStorage("filterRosterStatus", ""));
    state.filterContractAction = normContractActionFilter(readStorage("filterContractAction", ""));
    state.filterByeImpact = normByeImpactFilter(readStorage("filterByeImpact", ""));
    if (!state.filterRosterStatus && !!readStorage("taxiOnly", false)) {
      state.filterRosterStatus = "taxi";
    }
    state.contractPreview = readStorage("contractPreview", {}) || {};
    state.sorts = readStorage("sorts", state.sorts) || state.sorts;
    var storedView = safeStr(readStorage("view", "roster"));
    state.contractSubView = normalizeCapPlanSubview(readStorage("contractSubView", "players"));
    state.tagSubView = normalizeTagSubview(readStorage("tagSubView", "players"));
    state.tagDisplayYear = safeStr(readStorage("tagDisplayYear", ""));
    if (storedView === "franchise") {
      state.view = "contract";
      state.contractSubView = "summary";
    } else {
      state.view = storedView === "contract" || storedView === "points" || storedView === "bye" || storedView === "tag" ? storedView : "roster";
    }
    state.pointsMode = safeStr(readStorage("pointsMode", ""));
    state.pointsHistoryMode = safeStr(readStorage("pointsHistoryMode", defaultPointsHistoryMode()));
    state.pointsHistoryYearStart = safeStr(readStorage("pointsHistoryYearStart", ""));
    state.pointsHistoryYearEnd = safeStr(readStorage("pointsHistoryYearEnd", ""));
    state.pointsHistorySeason = safeStr(readStorage("pointsHistorySeason", ""));
    state.pointsHistoryWeekStart = safeStr(readStorage("pointsHistoryWeekStart", ""));
    state.pointsHistoryWeekEnd = safeStr(readStorage("pointsHistoryWeekEnd", ""));
    state.pointsExpanded = readStorage("pointsExpanded", {}) || {};
    var storedPointsHistoryContext = safeStr(readStorage("pointsHistoryDefaultContext", ""));
    var currentPointsHistoryContext = pointsHistoryDefaultContextKey();
    if (storedPointsHistoryContext !== currentPointsHistoryContext) {
      state.pointsHistoryMode = defaultPointsHistoryMode();
      state.pointsHistoryYearStart = "";
      state.pointsHistoryYearEnd = "";
      state.pointsHistorySeason = "";
      state.pointsHistoryWeekStart = "";
      state.pointsHistoryWeekEnd = "";
    }

    if (["", "rookie", "loaded", "other"].indexOf(state.filterType) === -1) {
      state.filterType = "";
    }
    state.filterRosterStatus = normRosterStatusFilter(state.filterRosterStatus);
    state.filterByeImpact = normByeImpactFilter(state.filterByeImpact);
    if (!state.sorts || typeof state.sorts !== "object") {
      state.sorts = {
        roster: { key: "salary", dir: "desc" },
        contract: { key: "player", dir: "asc" },
        franchise: { key: "franchise", dir: "asc" },
        points: { key: "points", dir: "desc" }
      };
    }
    if (!state.sorts.roster || typeof state.sorts.roster !== "object") {
      state.sorts.roster = { key: "salary", dir: "desc" };
    } else {
      var rosterSortKey = safeStr(state.sorts.roster.key);
      var validRosterSortKeys = {
        name: 1,
        contract_length: 1,
        years: 1,
        tcv: 1,
        salary: 1,
        aav: 1,
        guarantee: 1,
        penalty: 1
      };
      if (!validRosterSortKeys[rosterSortKey]) {
        state.sorts.roster = { key: "salary", dir: "desc" };
      }
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
    clearRosterPointsSummaryCache();
    clearPointsWeeklyRankCache();
    state.gamesLoadedByYear = Object.create(null);
    state.gamesLoadingByYear = Object.create(null);
    state.viewerIsAdmin = false;
    state.viewerAdminReason = "";
    state.viewerAdminReady = false;
    state.viewerCommishFranchiseId = "";
    if (els.teamList) {
      els.teamList.innerHTML = '<div class="rwb-loading">Refreshing roster data...</div>';
    }
    return loadData(state.ctx, { noCache: !!noCache })
      .then(function (result) {
        state.teams = sortTeamsForDisplay(result.teams || []);
        ensureSelectedTeamId();
        state.salaryCapAmount = safeInt(result.leagueMeta && result.leagueMeta.capAmount, 0);
        applyContractDisplayCorrections(state.teams);
        if (state.tagData) {
          applyTagOverlayToTeams(state.teams);
        }
        assignPositionalContractRanks(state.teams);
        state.pointYears = (result.pointYears && result.pointYears.length)
          ? result.pointYears.slice()
          : buildPointYears();
        state.pointsMode = normalizeRosterPointMode(state.pointsMode);

        var historyPromise = (state.view === "points" || state.view === "bye")
          ? loadPointsHistory().catch(function () { return null; })
          : Promise.resolve(null);
        var adminPromise = loadViewerAdminState(state.ctx);
        var tagPromise = loadTagPlanData().catch(function () { return null; });

        return Promise.all([historyPromise, adminPromise, tagPromise]).then(function () {
          state.pointsMode = normalizeRosterPointMode(state.pointsMode);
          renderToolbar();
          renderTeams();
          if (state.view === "points") {
            return ensureGamesLoadedForCurrentMode().then(function () {
              return ensureLiveSeasonPointsForSelection(false);
            }).catch(function () {
              return null;
            }).then(function () {
              persistState();
              return result;
            });
          }
          persistState();
          return result;
        });
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

  function submitWorkerRosterAction(action, franchiseId, playerId) {
    return fetchJsonPost(resolveWorkerActionEndpoint(), {
      action: action,
      league_id: state.ctx && state.ctx.leagueId,
      season: state.ctx && state.ctx.year,
      franchise_id: franchiseId,
      player_id: playerId
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
    var commishOverride = viewerCanManageAnyRoster() && !isOwnRosterPlayer(player);
    var payload = {
      L: leagueId,
      YEAR: season,
      type: "MANUAL_CONTRACT_UPDATE",
      submission_kind: "extension",
      source: "front-office-extension-submit",
      leagueId: leagueId,
      year: season,
      player_id: safeStr(player.id),
      player_name: safeStr(player.name),
      franchise_id: safeStr(player.fid),
      franchise_name: safeStr(player.teamName),
      position: safeStr(player.positionGroup || player.position),
      salary: safeInt(option.salaryToSend, 0),
      contract_year: Math.max(0, safeInt(option.contractLength, 0) - 1),
      contract_status: safeStr(option.contractStatus),
      contract_info: safeStr(option.contractInfo),
      submitted_at_utc: new Date().toISOString(),
      commish_override_flag: commishOverride ? 1 : 0
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

  function submitRookieOptionUpdate(player) {
    if (!player) return Promise.resolve(null);
    var payloadContract = buildRookieOptionContractPayload(player);
    if (!payloadContract) return Promise.resolve(null);

    var confirmLines = [
      "Confirm rookie option exercise for " + safeStr(player.name) + "?",
      "",
      "Current Year Salary: " + money(payloadContract.salary),
      "Option Year Salary: " + money(rookieOptionStateForPlayer(player).optionYearSalary),
      "New Contract Length: 2 years",
      inlineContractInfoText(payloadContract.contract_info)
    ];
    if (!window.confirm(confirmLines.join("\n"))) return Promise.resolve(null);

    var leagueId = safeStr(state.ctx && state.ctx.leagueId);
    var season = safeStr(state.ctx && state.ctx.year);
    var moveKey = "rookie-option:" + safeStr(player.id);
    var commishOverride = viewerCanManageAnyRoster() && !isOwnRosterPlayer(player);
    var payload = {
      L: leagueId,
      YEAR: season,
      type: "MANUAL_CONTRACT_UPDATE",
      source: "front-office-rookie-option-submit",
      leagueId: leagueId,
      year: season,
      player_id: safeStr(player.id),
      player_name: safeStr(player.name),
      franchise_id: safeStr(player.fid),
      franchise_name: safeStr(player.teamName),
      position: safeStr(player.positionGroup || player.position),
      salary: safeInt(payloadContract.salary, 0),
      contract_year: safeInt(payloadContract.contract_year, 0),
      contract_status: safeStr(payloadContract.contract_status),
      contract_info: safeStr(payloadContract.contract_info),
      submitted_at_utc: new Date().toISOString(),
      commish_override_flag: commishOverride ? 1 : 0
    };
    var url = resolveWorkerContractUpdateEndpoint() +
      "?L=" + encodeURIComponent(leagueId) +
      "&YEAR=" + encodeURIComponent(season);

    state.busyActionKey = moveKey;
    setFlash("success", "Submitting rookie option for " + safeStr(player.name) + " to MFL...");
    closePlayerActionModal();
    renderTeams();

    return postContractUpdate(url, payload).then(function (result) {
      state.busyActionKey = "";
      player.type = safeStr(payloadContract.contract_status);
      player.years = safeInt(payloadContract.contract_year, 0);
      player.special = safeStr(payloadContract.contract_info);
      persistState();
      return refreshData(true).then(function () {
        setFlash("success", safeStr(result && result.details && result.details.reason) || (safeStr(player.name) + " rookie option submitted to MFL."));
      });
    }).catch(function (err) {
      state.busyActionKey = "";
      renderTeams();
      setFlash("error", "Rookie option failed: " + summarizeError(err));
    });
  }

  function submitRestructureUpdate(player) {
    if (!player) return Promise.resolve(null);
    var calc = actionModalRestructureCalc(player);
    if (!calc.ok) {
      renderPlayerActionModal();
      setFlash("error", "Restructure failed: " + safeStr(calc.error || "Invalid restructure values."));
      return Promise.resolve(null);
    }

    var confirmLines = [
      "Confirm restructure for " + safeStr(player.name) + "?",
      "",
      "Years: " + String(calc.years),
      "Year 1: " + money(calc.y1),
      "Year 2: " + money(calc.y2)
    ];
    if (calc.years >= 3) confirmLines.push("Year 3: " + money(calc.y3));
    confirmLines.push("TCV: " + money(calc.tcv));
    confirmLines.push("AAV: " + money(calc.aav));
    confirmLines.push("GTD: " + money(calc.gtd));
    if (!window.confirm(confirmLines.join("\n"))) return Promise.resolve(null);

    var leagueId = safeStr(state.ctx && state.ctx.leagueId);
    var season = safeStr(state.ctx && state.ctx.year);
    var moveKey = "restructure:" + safeStr(player.id);
    var commishOverride = viewerCanManageAnyRoster() && !isOwnRosterPlayer(player);
    var payload = {
      L: leagueId,
      YEAR: season,
      leagueId: leagueId,
      year: season,
      type: "RESTRUCTURE",
      player_id: safeStr(player.id),
      player_name: safeStr(player.name),
      franchise_id: safeStr(player.fid),
      franchise_name: safeStr(player.teamName),
      position: safeStr(player.positionGroup || player.position),
      salary: safeInt(calc.y1, 0),
      contract_year: safeInt(calc.years, 0),
      contract_status: safeStr(player.type || "Veteran"),
      contract_info: safeStr(calc.contractInfo),
      tcv: safeInt(calc.tcv, 0),
      aav: safeInt(calc.aav, 0),
      guaranteed: safeInt(calc.gtd, 0),
      submitted_at_utc: new Date().toISOString(),
      commish_override_flag: commishOverride ? 1 : 0
    };
    var url = resolveWorkerRestructureEndpoint() +
      "?L=" + encodeURIComponent(leagueId) +
      "&YEAR=" + encodeURIComponent(season);

    state.busyActionKey = moveKey;
    setFlash("success", "Submitting restructure for " + safeStr(player.name) + " to MFL...");
    renderPlayerActionModal();

    return postContractUpdate(url, payload).then(function (result) {
      state.busyActionKey = "";
      closePlayerActionModal();
      return refreshData(true).then(function () {
        setFlash("success", safeStr(result && result.details && result.details.reason) || (safeStr(player.name) + " restructure submitted to MFL."));
      });
    }).catch(function (err) {
      state.busyActionKey = "";
      renderPlayerActionModal();
      setFlash("error", "Restructure failed: " + summarizeError(err));
    });
  }

  function saveTagSubmissionToLocalStore(row) {
    var store = loadLocalTagSubmissionStore();
    var season = safeStr(state.tagData && state.tagData.cycleSeason);
    var side = normalizeTagSideValue(row && row.side) || "OFFENSE";
    var key = buildTagSelectionKey(season, row && row.franchise_id, side);
    store[key] = {
      league_id: safeStr(state.ctx && state.ctx.leagueId),
      season: season,
      franchise_id: pad4(row && row.franchise_id),
      franchise_name: safeStr(row && row.franchise_name),
      player_id: safeStr(row && row.player_id),
      player_name: safeStr(row && row.player_name),
      pos: safeStr(row && row.position),
      side: side,
      tag_salary: effectiveTagSalaryForRow(row),
      tag_formula: effectiveTagFormulaForRow(row),
      tag_tier: safeInt(row && row.tag_tier, 0),
      submitted_at_utc: new Date().toISOString(),
      row_snapshot: row || null
    };
    saveLocalTagSubmissionStore(store);
    return key;
  }

  function removeTagSubmissionFromLocalStore(key) {
    var store = loadLocalTagSubmissionStore();
    if (safeStr(key) && store && Object.prototype.hasOwnProperty.call(store, key)) {
      delete store[key];
      saveLocalTagSubmissionStore(store);
    }
  }

  function buildTagContractPayload(row) {
    var salary = effectiveTagSalaryForRow(row);
    return {
      L: safeStr(state.ctx && state.ctx.leagueId),
      YEAR: safeStr(state.ctx && state.ctx.year),
      type: "MANUAL_CONTRACT_UPDATE",
      leagueId: safeStr(state.ctx && state.ctx.leagueId),
      year: safeStr(state.ctx && state.ctx.year),
      player_id: safeStr(row && row.player_id),
      player_name: safeStr(row && row.player_name),
      franchise_id: pad4(row && row.franchise_id),
      franchise_name: safeStr(row && row.franchise_name),
      position: safeStr(row && row.position),
      side: normalizeTagSideValue(row && row.side) || "",
      tag_side: normalizeTagSideValue(row && row.side) || "",
      salary: salary,
      contract_year: 1,
      contract_status: "TAG",
      contract_info: buildTagContractInfo(row, salary),
      submitted_at_utc: new Date().toISOString(),
      commish_override_flag: viewerCanManageAnyRoster() ? 1 : 0
    };
  }

  function buildUntagContractPayload(player) {
    var ref = findTagTrackingReferenceRow(player && player.fid, player && player.id);
    if (!ref) return null;

    var salary = Math.max(0, safeInt(ref.salary, 0));
    var contractYear = Math.max(1, safeInt(ref.contract_year, 0));
    var contractStatus = safeStr(ref.contract_status || "WW");
    var contractInfo = safeStr(ref.contract_info || "CL 1|");
    if (!contractStatus || !contractInfo) return null;

    return {
      L: safeStr(state.ctx && state.ctx.leagueId),
      YEAR: safeStr(state.ctx && state.ctx.year),
      type: "MANUAL_CONTRACT_UPDATE",
      leagueId: safeStr(state.ctx && state.ctx.leagueId),
      year: safeStr(state.ctx && state.ctx.year),
      player_id: safeStr(player && player.id),
      player_name: safeStr((player && player.name) || ref.player_name),
      franchise_id: pad4(player && player.fid),
      franchise_name: safeStr((player && player.teamName) || ref.franchise_name),
      position: safeStr((player && player.position) || ref.position),
      salary: salary,
      contract_year: contractYear,
      contract_status: contractStatus,
      contract_info: contractInfo,
      submitted_at_utc: new Date().toISOString(),
      commish_override_flag: viewerCanManageAnyRoster() ? 1 : 0
    };
  }

  function submitTagPlanSelection(row) {
    if (!row) return Promise.resolve(null);
    if (state.busyActionKey) {
      setFlash("error", "Another roster action is already in progress.");
      return Promise.resolve(null);
    }

    var conflictingPlayer = conflictingTaggedPlayerForRow(row);
    if (conflictingPlayer) {
      setFlash(
        "error",
        tagSideLabel(row.side) + " tag already used by " + safeStr(conflictingPlayer.name) + ". Untag that player first."
      );
      renderTeams();
      return Promise.resolve(null);
    }

    var confirmText =
      "Tag " + safeStr(row.player_name) + " for " + formatContractK(effectiveTagSalaryForRow(row)) + "?\n\n" +
      "Side: " + tagSideLabel(row.side) + "\n" +
      "Prior Season Points: " + formatPoints(row.points_total) + "\n" +
      "Positional Rank: " + formatRank(row.pos_rank) + "\n" +
      "Tier: " + (safeInt(row.tag_tier, 0) > 0 ? ("Tier " + String(safeInt(row.tag_tier, 0))) : "—") + "\n" +
      "Tag Calc: " + safeStr(effectiveTagFormulaForRow(row) || "—");
    if (!window.confirm(confirmText)) return Promise.resolve(null);

    var moveKey = "tag:" + safeStr(row.player_id);
    var payload = buildTagContractPayload(row);
    var membershipResult = null;

    state.busyActionKey = moveKey;
    setFlash("success", "Applying tag for " + safeStr(row.player_name) + "...");
    renderTeams();

    return submitWorkerRosterAction("load_player", row.franchise_id, row.player_id).then(function (membershipPayload) {
      membershipResult = membershipPayload || null;
      return postContractUpdate(
        resolveWorkerContractUpdateEndpoint() +
          "?L=" + encodeURIComponent(payload.L) +
          "&YEAR=" + encodeURIComponent(payload.YEAR),
        payload
      );
    }).then(function () {
      saveTagSubmissionToLocalStore(row);
      return loadTagPlanData().catch(function () { return null; }).then(function () {
        state.busyActionKey = "";
        return refreshData(true).then(function () {
          var membershipMessage = safeStr(membershipResult && membershipResult.message);
          setFlash(
            "success",
            membershipMessage
              ? (safeStr(row.player_name) + " tagged. " + membershipMessage)
              : (safeStr(row.player_name) + " tagged and loaded into Front Office.")
          );
        });
      });
    }).catch(function (err) {
      var shouldRollback = !!(membershipResult && membershipResult.ok && !membershipResult.skipped);
      var rollbackPromise = shouldRollback
        ? submitWorkerRosterAction("unload_player", row.franchise_id, row.player_id).catch(function () { return null; })
        : Promise.resolve(null);
      return rollbackPromise.then(function () {
        state.busyActionKey = "";
        renderTeams();
        setFlash(
          "error",
          "Tag failed: " + summarizeError(err) + (shouldRollback ? " Player was unloaded from the roster." : "")
        );
      });
    });
  }

  function submitUntagPlayer(player) {
    if (!player) return Promise.resolve(null);
    var restorePayload = buildUntagContractPayload(player);
    if (!restorePayload) {
      setFlash("error", "Untag failed: unable to resolve the prior contract state for " + safeStr(player.name) + ".");
      return Promise.resolve(null);
    }
    if (!window.confirm(
      "Untag " + safeStr(player.name) + "?\n\n" +
      "Restore: " + safeStr(restorePayload.contract_status) + " at " + formatContractK(restorePayload.salary) + "\n" +
      "Then remove from roster."
    )) return Promise.resolve(null);

    var side = getTagSideFromPos(player.positionGroup || player.position) || "OFFENSE";
    var submissionKey = tagSubmissionKeyForPlayer(player.fid, player.id, side);
    var moveKey = "untag:" + safeStr(player.id);
    var contractRestored = false;

    state.busyActionKey = moveKey;
    setFlash("success", "Removing tag for " + safeStr(player.name) + "...");
    closePlayerActionModal();
    renderTeams();

    return postContractUpdate(
      resolveWorkerContractUpdateEndpoint() +
        "?L=" + encodeURIComponent(restorePayload.L) +
        "&YEAR=" + encodeURIComponent(restorePayload.YEAR),
      restorePayload
    ).then(function () {
      contractRestored = true;
      return submitWorkerRosterAction("unload_player", player.fid, player.id);
    }).then(function (payload) {
      removeTagSubmissionFromLocalStore(submissionKey);
      return loadTagPlanData().catch(function () { return null; }).then(function () {
        state.busyActionKey = "";
        return refreshData(true).then(function () {
          setFlash("success", safeStr(player.name) + " untagged. " + safeStr(payload && payload.message));
        });
      });
    }).catch(function (err) {
      state.busyActionKey = "";
      renderTeams();
      setFlash(
        "error",
        "Untag failed: " + summarizeError(err) +
          (contractRestored ? " Contract was restored before the roster unload failed." : "")
      );
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
      if (nextView !== "contract" && nextView !== "roster" && nextView !== "points" && nextView !== "bye" && nextView !== "tag") return;
      if (state.view !== nextView) {
        state.view = nextView;
        if (nextView === "contract" && normalizeCapPlanSubview(state.contractSubView) === "summary") {
          state.selectedTeamId = ALL_TEAMS_VALUE;
        } else if (normalizedSelectedTeamId() === ALL_TEAMS_VALUE) {
          state.selectedTeamId = defaultSelectedTeamId();
        }
        persistState();
        renderToolbar();
        renderTeams();
        if (state.view === "points" || state.view === "bye" || state.view === "tag") {
          var followUp = state.view === "tag"
            ? loadTagPlanData()
            : loadPointsHistory().then(function () {
                if (state.view === "points") return ensureLiveSeasonPointsForSelection(false);
                return null;
              });
          followUp.catch(function () {});
        }
      }
      return;
    }

    var contractSubviewBtn = target.closest("[data-action='contract-subview']");
    if (contractSubviewBtn) {
      var nextSubview = normalizeCapPlanSubview(contractSubviewBtn.getAttribute("data-subview"));
      if (state.contractSubView === nextSubview) return;
      state.contractSubView = nextSubview;
      if (nextSubview === "summary") {
        state.selectedTeamId = ALL_TEAMS_VALUE;
        state.filtersOpen = false;
      } else if (normalizedSelectedTeamId() === ALL_TEAMS_VALUE) {
        state.selectedTeamId = defaultSelectedTeamId();
      }
      persistState();
      renderToolbar();
      renderTeams();
      return;
    }

    var tagSubviewBtn = target.closest("[data-action='tag-subview']");
    if (tagSubviewBtn) {
      var nextTagSubview = normalizeTagSubview(tagSubviewBtn.getAttribute("data-subview"));
      if (state.tagSubView === nextTagSubview) return;
      state.tagSubView = nextTagSubview;
      persistState();
      renderToolbar();
      renderTeams();
      if (state.view === "tag") {
        loadTagPlanData().catch(function () {});
      }
      return;
    }

    if (target === els.toggleFilters) {
      state.filtersOpen = !state.filtersOpen;
      renderToolbar();
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

    var pointsHistoryModeBtn = target.closest("[data-action='points-history-mode']");
    if (pointsHistoryModeBtn) {
      var nextHistoryMode = safeStr(pointsHistoryModeBtn.getAttribute("data-mode")) === "yearly" ? "yearly" : "weekly";
      if (state.pointsHistoryMode === nextHistoryMode) return;
      state.pointsHistoryMode = nextHistoryMode;
      ensurePointsHistorySelection();
      clearPointsWeeklyRankCache();
      persistState();
      renderToolbar();
      renderTeams();
      if (state.view === "points" && state.pointsHistoryMode === "weekly") {
        ensureLiveSeasonPointsForSelection(false).catch(function () {});
      }
      return;
    }

    var previewBtn = target.closest("[data-action='contract-preview']");
    if (previewBtn) {
      var previewPlayerId = safeStr(previewBtn.getAttribute("data-player-id"));
      var previewFranchiseId = pad4(previewBtn.getAttribute("data-franchise-id"));
      var previewYears = safeInt(previewBtn.getAttribute("data-years"), 0);
      if (!previewPlayerId || !previewFranchiseId || (previewYears !== 1 && previewYears !== 2)) return;
      var previewRecord = findPlayerRecord(previewFranchiseId, previewPlayerId);
      if (!previewRecord || !previewRecord.player || !playerExtensionOptions(previewRecord.player).length) return;
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
          sortKey === "salary_rank" ||
          sortKey === "aav_rank" ||
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
      if (!extensionRecord || !extensionRecord.player || !canManageRosterPlayer(extensionRecord.player)) return;
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

    var rookieOptionBtn = target.closest("[data-action='exercise-rookie-option']");
    if (rookieOptionBtn) {
      if (state.busyActionKey) return;
      var rookieOptionRecord = findPlayerRecord(
        pad4(rookieOptionBtn.getAttribute("data-franchise-id")),
        safeStr(rookieOptionBtn.getAttribute("data-player-id"))
      );
      if (!rookieOptionRecord || !rookieOptionRecord.player || !canManageRosterPlayer(rookieOptionRecord.player)) return;
      if (!rookieOptionActionEligible(rookieOptionRecord.player)) {
        setFlash("error", "Rookie option is not available for this player.");
        return;
      }
      submitRookieOptionUpdate(rookieOptionRecord.player);
      return;
    }

    var restructureBackBtn = target.closest("[data-action='restructure-back']");
    if (restructureBackBtn) {
      if (state.busyActionKey) return;
      state.actionModal.mode = "actions";
      renderPlayerActionModal();
      return;
    }

    var restructureBtn = target.closest("[data-action='restructure-player']");
    if (restructureBtn) {
      var restructureRecord = findPlayerRecord(
        pad4(restructureBtn.getAttribute("data-franchise-id")),
        safeStr(restructureBtn.getAttribute("data-player-id"))
      );
      if (!restructureRecord || !restructureRecord.player) return;
      if (!canManageRosterPlayer(restructureRecord.player)) return;
      if (!rosterContractEligibility(restructureRecord.player).restructureEligible) return;
      openRestructureEditor(restructureRecord.player);
      return;
    }

    var submitRestructureBtn = target.closest("[data-action='submit-restructure']");
    if (submitRestructureBtn) {
      if (state.busyActionKey) return;
      var restructureSubmitRecord = findPlayerRecord(state.actionModal.franchiseId, state.actionModal.playerId);
      if (!restructureSubmitRecord || !restructureSubmitRecord.player) return;
      if (!canManageRosterPlayer(restructureSubmitRecord.player)) return;
      submitRestructureUpdate(restructureSubmitRecord.player);
      return;
    }

    var tagPlanBtn = target.closest("[data-action='tag-player']");
    if (tagPlanBtn) {
      if (state.busyActionKey) return;
      var tagRow = findTagPlanRow(
        pad4(tagPlanBtn.getAttribute("data-franchise-id")),
        safeStr(tagPlanBtn.getAttribute("data-player-id"))
      );
      if (!tagRow || !canManageTagForTeam(tagRow.franchise_id)) return;
      submitTagPlanSelection(tagRow);
      return;
    }

    var untagBtn = target.closest("[data-action='untag-player']");
    if (untagBtn) {
      if (state.busyActionKey) return;
      var untagRecord = findPlayerRecord(
        pad4(untagBtn.getAttribute("data-franchise-id")),
        safeStr(untagBtn.getAttribute("data-player-id"))
      );
      if (!untagRecord || !untagRecord.player) {
        var fallbackRow = findTagPlanRow(
          pad4(untagBtn.getAttribute("data-franchise-id")),
          safeStr(untagBtn.getAttribute("data-player-id"))
        );
        if (!fallbackRow || !canManageTagForTeam(fallbackRow.franchise_id)) return;
        submitUntagPlayer(buildSyntheticTaggedPlayer(findTeamById(fallbackRow.franchise_id) || { id: fallbackRow.franchise_id, name: fallbackRow.franchise_name }, normalizeTagSubmissionEntry({
          franchise_id: fallbackRow.franchise_id,
          franchise_name: fallbackRow.franchise_name,
          player_id: fallbackRow.player_id,
          player_name: fallbackRow.player_name,
          pos: fallbackRow.position,
          side: fallbackRow.side,
          tag_salary: fallbackRow.tag_salary,
          season: state.tagData && state.tagData.cycleSeason
        }), fallbackRow));
        return;
      }
      if (!canManageRosterPlayer(untagRecord.player) && !canManageTagForTeam(untagRecord.player.fid)) return;
      submitUntagPlayer(untagRecord.player);
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
      if (!canManageRosterPlayer(playerRecord.player)) return;
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
      state.filterContractAction = "";
      state.filterByeImpact = "";
      if (!filtersForcedOpenForView()) state.filtersOpen = false;
      if (els.search) els.search.value = "";
      if (els.browseSearch) els.browseSearch.value = "";
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
      renderToolbar();
      renderTeams();
      return;
    }

    if (el === els.filterType) {
      state.filterType = normType(el.value);
      persistState();
      renderToolbar();
      renderTeams();
      return;
    }

    if (el === els.filterRosterStatus) {
      state.filterRosterStatus = normRosterStatusFilter(el.value);
      persistState();
      renderToolbar();
      renderTeams();
      return;
    }

    if (el === els.filterContractAction) {
      state.filterContractAction = normContractActionFilter(el.value);
      persistState();
      renderToolbar();
      renderTeams();
      return;
    }

    if (el === els.filterByeImpact) {
      state.filterByeImpact = normByeImpactFilter(el.value);
      persistState();
      renderToolbar();
      renderTeams();
      return;
    }

    if (elId === "rwbTagDisplayYear") {
      state.tagDisplayYear = safeStr(el.value);
      persistState();
      renderToolbar();
      renderTeams();
      return;
    }

    if (el === els.jumpTeam) {
      state.selectedTeamId = safeStr(el.value) === ALL_TEAMS_VALUE ? ALL_TEAMS_VALUE : pad4(el.value);
      persistState();
      renderToolbar();
      renderTeams();
      return;
    }

    if (el === els.pointsMode) {
      var nextMode = normalizeRosterPointMode(el.value);
      if (!nextMode) return;
      state.pointsMode = nextMode;
      clearRosterPointsSummaryCache();
      persistState();
      renderToolbar();
      renderTeams();
      ensureGamesLoadedForCurrentMode();
      loadPointsHistory().catch(function () {});
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
    var elId = safeStr(el.id);

    function restoreInputFocus(inputId, selectionStart, selectionEnd) {
      requestAnimationFrame(function () {
        var next = document.getElementById(inputId);
        if (!next) return;
        next.focus();
        if (selectionStart == null || !next.setSelectionRange) return;
        var nextStart = Math.min(selectionStart, safeStr(next.value).length);
        var nextEnd = Math.min(selectionEnd == null ? selectionStart : selectionEnd, safeStr(next.value).length);
        next.setSelectionRange(nextStart, nextEnd);
      });
    }

    if (elId === "rwbRestructureYear1" || elId === "rwbRestructureYear2") {
      var sanitized = safeStr(el.value).replace(/[^\d]/g, "");
      var selStart = typeof el.selectionStart === "number" ? el.selectionStart : null;
      var selEnd = typeof el.selectionEnd === "number" ? el.selectionEnd : null;
      if (elId === "rwbRestructureYear1") state.actionModal.restructureYear1 = sanitized;
      if (elId === "rwbRestructureYear2") state.actionModal.restructureYear2 = sanitized;
      renderPlayerActionModal();
      restoreInputFocus(elId, selStart, selEnd);
      return;
    }
    if (el === els.search || elId === "rwbBrowseSearch") {
      var searchSelStart = typeof el.selectionStart === "number" ? el.selectionStart : null;
      var searchSelEnd = typeof el.selectionEnd === "number" ? el.selectionEnd : null;
      state.search = safeStr(el.value || "").toLowerCase();
      persistState();
      if (elId === "rwbBrowseSearch") {
        if (els.search && els.search !== el) els.search.value = state.search;
        renderSearchSuggestions();
        renderTeams();
        return;
      }
      renderToolbar();
      renderTeams();
      restoreInputFocus(elId, searchSelStart, searchSelEnd);
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
        var salaryAdjustmentSummary = toSalaryAdjustmentSummary(salaryAdjustPayload);
        var scores = toScoreMap(pointsPayload);

        var teams = buildTeams(
          rostersPayload,
          leagueMeta,
          playersMap,
          scores,
          byeResult.map || {},
          salaryMap,
          salaryAdjustmentSummary.byFranchise,
          salaryAdjustmentSummary.breakdownByFranchise,
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
      return Promise.all([
        loadExtensionPreviewFallbackRows(ctx && ctx.year),
        loadAcquisitionLookupRows(ctx && ctx.year),
        loadSalaryAdjustmentLedgerRows(ctx && ctx.year)
      ]).then(function (parts) {
        var extRows = parts[0] || [];
        var acquisitionRows = parts[1] || [];
        var salaryAdjustmentReportPayload = parts[2] || { loaded: false, rows: [] };
        mergeExtensionPreviewFallbackRows(teams, extRows);
        mergeAcquisitionLookupRows(teams, acquisitionRows);
        mergeReportSalaryAdjustmentsIntoTeams(
          teams,
          salaryAdjustmentReportPayload,
          ctx && ctx.year,
          safeInt(result && result.leagueMeta && result.leagueMeta.capAmount, 0)
        );
        repairTaxiContractFallbacks(teams, ctx && ctx.year);
        return hydrateTeamsWithPointsHistory(ctx, teams).then(function (years) {
          assignPositionalContractRanks(teams);
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
      renderError("Front Office could not determine league id from this page URL.");
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
