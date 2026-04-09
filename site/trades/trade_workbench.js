(function () {
  "use strict";

  var SAMPLE_DATA_URL = "./trade_workbench_sample.json";
  var STORAGE_KEY_PREFIX = "ups-trade-workbench-state-v9";
  var GROUP_ORDER = ["QB", "RB", "WR", "TE", "PK", "PN", "DT", "DE", "LB", "CB", "S", "DL", "DB", "PICKS", "OTHER"];
  var PICK_SALARY_ROUND_ONE_START_DOLLARS = 15000;
  var PICK_SALARY_ROUND_ONE_FLOOR_DOLLARS = 5000;
  var PICK_SALARY_ROUND_ONE_STEP_DOLLARS = 1000;
  var PICK_SALARY_ROUND_ONE_AVERAGE_DOLLARS = 10000;
  var PRETRADE_EXTENSION_RAISES = {
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
  var heightSyncInstalled = false;
  var heightPostTimer = 0;
  var lastPostedHeight = 0;

  var state = {
    data: null,
    uiReady: false,
    activeFranchiseId: "",
    leftTeamId: "",
    rightTeamId: "",
    selections: {},
    extensions: {},
    tradeSalaryK: {},
    assetView: {},
    filters: {
      search: ""
    },
    collapsed: {},
    submit: {
      busy: false,
      message: "No offer submitted yet.",
      tone: "",
      lastRequestBody: null,
      lastRequestUrl: "",
      canRetry: false,
      acceptDebug: null
    },
    offers: {
      busy: false,
      actionBusy: false,
      actionBusyKey: "",
      error: "",
      offered: [],
      received: [],
      key: ""
    },
    reviewContext: {
      kind: "draft",
      offerBucket: "",
      offerId: "",
      tradeId: "",
      offer: null
    },
    mobileTab: "your",
    counterMode: false,
    counterSourceOffer: null,
    extensionModal: {
      teamId: "",
      assetId: "",
      optionKey: ""
    }
  };

  var els = {};

  function getLeagueContext() {
    var ctx = {
      host: "",
      season: "",
      leagueId: "",
      baseUrl: ""
    };
    try {
      if (typeof window.getLeagueContext === "function") {
        var upstream = window.getLeagueContext();
        if (upstream && typeof upstream === "object") {
          ctx.host = safeStr(upstream.host || window.location.host || "");
          ctx.season = safeStr(upstream.season).replace(/\D/g, "");
          ctx.leagueId = safeStr(upstream.leagueId || upstream.league_id).replace(/\D/g, "");
          ctx.baseUrl = safeStr(upstream.baseUrl || upstream.base_url);
          if (!ctx.baseUrl && ctx.host) {
            var upstreamProtocol = safeStr(window.location.protocol || "https:");
            ctx.baseUrl = upstreamProtocol + "//" + ctx.host + (ctx.season ? ("/" + ctx.season) : "");
          }
          if (ctx.host || ctx.season || ctx.leagueId || ctx.baseUrl) return ctx;
        }
      }
    } catch (eUpstream) {
      // fall through to local parsing
    }
    try {
      var u = new URL(window.location.href || "");
      ctx.host = safeStr(u.host || window.location.host || "");
      var season = safeStr(
        u.searchParams.get("YEAR") ||
          u.searchParams.get("season") ||
          (safeStr(u.pathname).match(/\/(\d{4})(?:\/|$)/) || [])[1] ||
          ""
      ).replace(/\D/g, "");
      var leagueId = safeStr(
        u.searchParams.get("L") ||
          u.searchParams.get("league_id") ||
          u.searchParams.get("leagueId") ||
          (safeStr(u.pathname).match(/\/home\/(\d+)(?:\/|$)/i) || [])[1] ||
          ""
      ).replace(/\D/g, "");
      ctx.season = season;
      ctx.leagueId = leagueId;
      if (ctx.host) {
        var protocol = safeStr(u.protocol || window.location.protocol || "https:");
        ctx.baseUrl = protocol + "//" + ctx.host + (ctx.season ? ("/" + ctx.season) : "");
      }
    } catch (e) {
      var path = safeStr(window.location.pathname);
      ctx.host = safeStr(window.location.host || "");
      ctx.season = safeStr((path.match(/\/(\d{4})(?:\/|$)/) || [])[1]).replace(/\D/g, "");
      ctx.leagueId = safeStr((path.match(/\/home\/(\d+)(?:\/|$)/i) || [])[1]).replace(/\D/g, "");
      if (ctx.host) {
        var protocolFallback = safeStr(window.location.protocol || "https:");
        ctx.baseUrl = protocolFallback + "//" + ctx.host + (ctx.season ? ("/" + ctx.season) : "");
      }
    }
    return ctx;
  }

  function computeStorageKey() {
    var leagueCtx = getLeagueContext();
    var leagueId = leagueCtx.leagueId || "unknown";
    var season = leagueCtx.season || "unknown";
    var route = "page";
    try {
      var u = new URL(window.location.href || "");
      var moduleName = safeStr(u.searchParams.get("MODULE")).toUpperCase();
      var optionName = safeStr(u.searchParams.get("O")).replace(/\D/g, "");
      if (moduleName) route = "module_" + moduleName;
      else if (optionName) route = "option_" + optionName;
    } catch (e) {
      // use defaults
    }
    return [STORAGE_KEY_PREFIX, leagueId, season, route].join(":");
  }

  var STORAGE_KEY = computeStorageKey();

  function q(id) {
    return document.getElementById(id);
  }

  function safeStr(v) {
    return v == null ? "" : String(v).trim();
  }

  function safeInt(v, fallback) {
    var n = parseInt(v, 10);
    return isFinite(n) ? n : (fallback == null ? 0 : fallback);
  }

  function safeMoneyInt(v, fallback) {
    if (typeof v === "number" && isFinite(v)) return Math.round(v);
    var s = safeStr(v);
    if (!s) return fallback == null ? null : fallback;
    var cleaned = s.replace(/[^0-9.-]/g, "");
    if (!cleaned || cleaned === "-" || cleaned === ".") return fallback == null ? null : fallback;
    var n = Number(cleaned);
    if (!isFinite(n)) return fallback == null ? null : fallback;
    return Math.round(n);
  }

  function parseContractMoneyTokenToDollars(token) {
    var raw = safeStr(token);
    if (!raw) return null;
    var hasK = /k/i.test(raw);
    var cleaned = raw.replace(/[^0-9.-]/gi, "");
    if (!cleaned || cleaned === "-" || cleaned === ".") return null;
    var n = Number(cleaned);
    if (!isFinite(n)) return null;
    if (hasK || Math.abs(n) < 1000) return Math.round(n * 1000);
    return Math.round(n);
  }

  function parseContractMoneyListToDollars(text) {
    var src = safeStr(text);
    if (!src) return [];
    var out = [];
    var re = /-?\d+(?:\.\d+)?\s*K?/ig;
    var m;
    while ((m = re.exec(src)) !== null) {
      var val = parseContractMoneyTokenToDollars(m[0]);
      if (val != null) out.push(val);
    }
    return out;
  }

  function parseContractInfoSummary(contractInfo) {
    var text = safeStr(contractInfo);
    var summary = {
      contract_length: null,
      aav_values_dollars: [],
      aav_current_dollars: null,
      y_by_year_dollars: {},
      extension_tokens: [],
      last_extension_token: ""
    };
    if (!text) return summary;

    var clMatch = text.match(/(?:^|\|)\s*CL\s*(\d+)/i);
    if (clMatch) {
      var cl = parseInt(clMatch[1], 10);
      if (isFinite(cl) && cl > 0) summary.contract_length = cl;
    }

    var aavMatch = text.match(/(?:^|\|)\s*AAV\s*([^|]+)/i);
    if (aavMatch) {
      summary.aav_values_dollars = parseContractMoneyListToDollars(aavMatch[1]);
      if (summary.aav_values_dollars.length) {
        summary.aav_current_dollars = summary.aav_values_dollars[0];
      }
    }

    var yRe = /Y\s*(\d+)\s*-\s*([0-9]+(?:\.[0-9]+)?\s*K?)/ig;
    var ym;
    while ((ym = yRe.exec(text)) !== null) {
      var yearNum = parseInt(ym[1], 10);
      var sal = parseContractMoneyTokenToDollars(ym[2]);
      if (isFinite(yearNum) && yearNum > 0 && sal != null) {
        summary.y_by_year_dollars[String(yearNum)] = sal;
      }
    }

    var extMatch = text.match(/(?:^|\|)\s*Ext:\s*([^|]+)/i);
    if (extMatch) {
      summary.extension_tokens = extMatch[1].split(/[,/;&]|\band\b/i).map(function (part) {
        return safeStr(part);
      }).filter(Boolean);
      if (summary.extension_tokens.length) {
        summary.last_extension_token = summary.extension_tokens[summary.extension_tokens.length - 1];
      }
    }
    return summary;
  }

  function normalizeExtensionHistoryToken(token) {
    return safeStr(token).toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function tradeTeamIdentityTokenMap(asset) {
    var map = Object.create(null);

    function add(raw) {
      var text = safeStr(raw);
      if (!text) return;
      var normalized = normalizeExtensionHistoryToken(text);
      if (normalized) map[normalized] = true;
      var parts = text.split(/[\s/,&().-]+/);
      for (var i = 0; i < parts.length; i += 1) {
        var token = normalizeExtensionHistoryToken(parts[i]);
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

    add(asset && asset.franchise_name);
    add(asset && asset.franchise_abbrev);
    add(asset && asset.team_name);
    return map;
  }

  function extensionHistoryTokenMatchesCurrentTeam(token, asset) {
    var rawToken = safeStr(token);
    var normalized = normalizeExtensionHistoryToken(rawToken);
    var rawNeedle = rawToken.replace(/\s+/g, "");
    if (!normalized && !rawNeedle) return false;
    var identity = tradeTeamIdentityTokenMap(asset);
    if (normalized && identity[normalized]) return true;
    var keys = Object.keys(identity);
    for (var i = 0; i < keys.length; i += 1) {
      var key = keys[i];
      if (!key) continue;
      if (normalized) {
        if (normalized.length >= 4 && key.indexOf(normalized) === 0) return true;
        if (key.length >= 4 && normalized.indexOf(key) === 0) return true;
      }
    }
    if (rawNeedle) {
      var rawValues = [
        safeStr(asset && asset.franchise_name),
        safeStr(asset && asset.franchise_abbrev),
        safeStr(asset && asset.team_name)
      ];
      for (var j = 0; j < rawValues.length; j += 1) {
        var rawHaystack = rawValues[j].replace(/\s+/g, "");
        if (rawHaystack && rawHaystack.indexOf(rawNeedle) !== -1) return true;
      }
    }
    return false;
  }

  function assetLastExtensionHeldByCurrentTeam(asset) {
    var info = parseContractInfoSummary(asset && asset.contract_info);
    var lastToken = info.last_extension_token;
    if (!lastToken) return false;
    return extensionHistoryTokenMatchesCurrentTeam(lastToken, asset);
  }

  function assetHasExtensionHistory(asset) {
    var info = parseContractInfoSummary(asset && asset.contract_info);
    return Array.isArray(info.extension_tokens) && info.extension_tokens.length > 0;
  }

  function roundToNearestK(v) {
    return Math.round(safeInt(v, 0) / 1000) * 1000;
  }

  function formatContractKToken(amount) {
    var dollars = Math.round(safeInt(amount, 0));
    if (dollars <= 0) return "0K";
    var k = dollars / 1000;
    var text = Math.round(k * 10) / 10;
    return (String(text).replace(/\.0$/, "")) + "K";
  }

  function tradePositionGroupKey(pos) {
    var p = safeStr(pos).toUpperCase();
    if (!p) return "OTHER";
    if (p === "DE" || p === "DT" || p === "DL" || p === "NT" || p === "EDGE" || p === "ED") return "DL";
    if (p === "CB" || p === "S" || p === "FS" || p === "SS" || p === "DB") return "DB";
    if (p === "K" || p === "PK") return "PK";
    if (p === "P" || p === "PN") return "PN";
    if (p === "QB" || p === "RB" || p === "WR" || p === "TE" || p === "LB") return p;
    return "OTHER";
  }

  function rookieLikeTradeContractStatus(value) {
    var status = safeStr(value).toLowerCase();
    return status === "r" || status.indexOf("r-") === 0 || status.indexOf("rookie") !== -1;
  }

  function tradeExtensionRaiseForAsset(asset, yearsToAdd) {
    var years = safeInt(yearsToAdd, 0);
    if (years !== 1 && years !== 2) return 0;
    var group = tradePositionGroupKey(asset && asset.position);
    var rec = PRETRADE_EXTENSION_RAISES[group] || PRETRADE_EXTENSION_RAISES.OTHER;
    return safeInt(rec && rec[years], 0);
  }

  function fallbackTaxiContractInfo(asset) {
    var salary = Math.max(1000, roundToNearestK(asset && asset.salary));
    var contractLength = Math.max(1, safeInt(asset && asset.contract_length, 0) || 3);
    if (!salary) return "";
    var yearParts = [];
    for (var i = 1; i <= contractLength; i += 1) {
      yearParts.push("Y" + i + "-" + formatContractKToken(salary));
    }
    return [
      "CL " + contractLength,
      "TCV " + formatContractKToken(salary * contractLength),
      "AAV " + formatContractKToken(salary),
      yearParts.join(", ")
    ].join("| ");
  }

  function assetAllowsSyntheticExtension(asset, metrics) {
    if (!asset || safeStr(asset.type).toUpperCase() !== "PLAYER") return false;
    var type = safeStr(asset.contract_type).toLowerCase();
    var info = safeStr(asset.contract_info).toLowerCase();
    var yearsRemaining = metrics && metrics.years_remaining != null
      ? safeInt(metrics.years_remaining, 0)
      : safeInt(asset.years, 0);
    if (type.indexOf("tag") !== -1) return false;
    if (assetHasExtensionHistory(asset)) return false;
    if (assetLastExtensionHeldByCurrentTeam(asset)) return false;
    if (info.indexOf("no further extensions") !== -1 || info.indexOf("not eligible for tag or extension") !== -1) {
      return false;
    }
    return yearsRemaining === 1 || (rookieLikeTradeContractStatus(type) && yearsRemaining <= 0);
  }

  function buildSyntheticExtensionOptions(asset) {
    if (!asset || safeStr(asset.type).toUpperCase() !== "PLAYER") return [];
    var metrics = resolveAssetDisplayContractMetrics(asset);
    if (!assetAllowsSyntheticExtension(asset, metrics)) return [];

    var currentYears = Math.max(1, safeInt(metrics && metrics.years_remaining, 0) || 1);
    var currentSalary = Math.max(1000, roundToNearestK(asset.salary));
    if (currentSalary <= 0) return [];

    var out = [];
    for (var yearsToAdd = 1; yearsToAdd <= 2; yearsToAdd += 1) {
      var futureSalary = Math.max(1000, roundToNearestK(currentSalary + tradeExtensionRaiseForAsset(asset, yearsToAdd)));
      var totalLength = currentYears + yearsToAdd;
      var yearParts = [];
      for (var yearIdx = 1; yearIdx <= totalLength; yearIdx += 1) {
        yearParts.push(
          "Y" + yearIdx + "-" + formatContractKToken(yearIdx <= currentYears ? currentSalary : futureSalary)
        );
      }
      var tcv = currentSalary * currentYears + futureSalary * yearsToAdd;
      var previewInfo = [
        "CL " + totalLength,
        "TCV " + formatContractKToken(tcv),
        "AAV " + formatContractKToken(currentSalary) + ", " + formatContractKToken(futureSalary),
        yearParts.join(", ")
      ].join("| ");
      out.push({
        option_key: String(yearsToAdd) + "YR|NONE",
        extension_term: String(yearsToAdd) + "YR",
        loaded_indicator: "NONE",
        preview_id: null,
        preview_contract_info_string: previewInfo,
        new_contract_status: yearsToAdd === 1 ? "EXT1" : "EXT2",
        new_contract_length: totalLength,
        new_TCV: tcv,
        new_aav_current: currentSalary,
        new_aav_future: futureSalary,
        synthesized: true
      });
    }
    return out;
  }

  function rookieTaxiYearsRemainingFromDraftSeason(draftSeason, season) {
    var drafted = safeInt(draftSeason, 0);
    var current = safeInt(season, 0);
    if (drafted <= 0 || current <= 0) return 0;
    return Math.max(0, 3 - Math.max(0, current - drafted));
  }

  function pad4(v) {
    var digits = safeStr(v).replace(/\D/g, "");
    if (!digits) return "";
    return ("0000" + digits).slice(-4);
  }

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function resolveTwbDataCacheKey() {
    var leagueCtx = getLeagueContext();
    return "twb:lastData:" + (leagueCtx.leagueId || "unknown") + ":" + (leagueCtx.season || "unknown");
  }

  function readCachedTwbData() {
    try {
      var key = resolveTwbDataCacheKey();
      var raw = localStorage.getItem(key);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  function writeCachedTwbData(data) {
    try {
      if (!data || typeof data !== "object") return;
      var key = resolveTwbDataCacheKey();
      localStorage.setItem(key, JSON.stringify(data));
    } catch (e) {
      // noop
    }
  }

  function moneyFmt(n) {
    var value = safeInt(n, 0);
    try {
      return "$" + value.toLocaleString("en-US");
    } catch (e) {
      return "$" + String(value);
    }
  }

  function kFmtFromDollars(n) {
    var k = Math.round(safeInt(n, 0) / 1000);
    try {
      return "$" + k.toLocaleString("en-US") + "K";
    } catch (e) {
      return "$" + String(k) + "K";
    }
  }

  function getCurrentTradeSeason(currentSeasonHintOverride) {
    var hinted = safeInt(currentSeasonHintOverride, 0);
    if (hinted) return hinted;
    var stateSeason = safeInt(state.data && state.data.meta ? state.data.meta.season : 0, 0);
    if (stateSeason) return stateSeason;
    return safeInt(getLeagueContext().season, 0);
  }

  function getMemorialDayUtc(season) {
    var year = safeInt(season, 0);
    if (year <= 0) return null;
    var d = new Date(Date.UTC(year, 4, 31));
    var weekday = d.getUTCDay();
    var offset = (weekday + 6) % 7;
    d.setUTCDate(d.getUTCDate() - offset);
    return d;
  }

  function getTagDeadlineUtc(season) {
    var memorial = getMemorialDayUtc(season);
    if (!memorial) return null;
    var tagDeadline = new Date(memorial.getTime());
    tagDeadline.setUTCDate(tagDeadline.getUTCDate() - 4);
    tagDeadline.setUTCHours(23, 59, 59, 999);
    return tagDeadline;
  }

  function hasTradeTagDeadlinePassed(seasonHintOverride) {
    var season = getCurrentTradeSeason(seasonHintOverride);
    var deadline = getTagDeadlineUtc(season);
    if (!deadline) return false;
    return Date.now() > deadline.getTime();
  }

  function parsePickSlotMeta(value) {
    var raw = safeStr(value).toUpperCase();
    var out = {
      round: 0,
      pick: 0
    };
    if (!raw) return out;

    var dotted = raw.match(/(?:^|[^0-9])([1-9]\d?)\.(\d{1,2})(?:[^0-9]|$)/);
    if (dotted) {
      out.round = safeInt(dotted[1], 0);
      out.pick = safeInt(dotted[2], 0);
      return out;
    }

    var roundPick = raw.match(/ROUND\s*([1-9]\d?).*?PICK\s*0*([1-9]\d?)/i);
    if (roundPick) {
      out.round = safeInt(roundPick[1], 0);
      out.pick = safeInt(roundPick[2], 0);
      return out;
    }

    var roundOnly = raw.match(/^R(?:OUND)?\s*([1-9]\d?)$/i);
    if (roundOnly) {
      out.round = safeInt(roundOnly[1], 0);
      return out;
    }

    return out;
  }

  function resolveFirstRoundPickSalaryDollars(pick) {
    var slot = safeInt(pick, 0);
    if (slot <= 0) return PICK_SALARY_ROUND_ONE_AVERAGE_DOLLARS;
    return Math.max(
      PICK_SALARY_ROUND_ONE_FLOOR_DOLLARS,
      PICK_SALARY_ROUND_ONE_START_DOLLARS - ((slot - 1) * PICK_SALARY_ROUND_ONE_STEP_DOLLARS)
    );
  }

  function resolvePickSalaryInfo(asset, currentSeasonHintOverride) {
    var meta = resolvePickMeta(asset);
    var round = safeInt(meta.round, 0);
    var year = safeInt(meta.year, 0);
    var currentSeason = getCurrentTradeSeason(currentSeasonHintOverride);
    var isCurrentSeasonPick = !year || !currentSeason || year === currentSeason;
    var roundText = round > 0 ? "Round " + String(round) + " pick" : "Pick";
    var pick = safeInt(meta.pick, 0);

    if (round === 1 && isCurrentSeasonPick) {
      return {
        salary_dollars: resolveFirstRoundPickSalaryDollars(pick),
        meta_label: "Round 1 rookie salary",
        is_average: !pick
      };
    }

    if (round === 1) {
      return {
        salary_dollars: 0,
        meta_label: "Future round 1 pick",
        is_average: false
      };
    }

    if (round >= 2) {
      return {
        salary_dollars: 0,
        meta_label: roundText + " · no current cap impact",
        is_average: false
      };
    }

    return {
      salary_dollars: 0,
      meta_label: "Rookie pick",
      is_average: false
    };
  }

  function shortPickLabel(desc, assetId, seasonHint) {
    var raw = safeStr(desc);
    var currentSeason = safeInt(seasonHint, 0);
    var token = normalizePickKey(assetId || "");
    var meta = resolvePickMeta({
      asset_id: assetId || "",
      description: raw,
      pick_season: currentSeason
    }, currentSeason);
    var round = safeInt(meta.round, 0);
    var pick = safeInt(meta.pick, 0);
    var year = safeInt(meta.year, 0);

    if (round && pick) {
      var y = year || currentSeason;
      var yText = y ? String(y) + " " : "";
      return yText + "Rookie " + round + "." + String(pick).padStart(2, "0");
    }

    if (round) {
      var yr = year || currentSeason;
      var yrText = yr ? String(yr) + " " : "";
      return yrText + "Rookie Round " + String(round);
    }

    if (!raw) return currentSeason ? String(currentSeason) + " Rookie Pick" : "Rookie Pick";
    var cleaned = raw
      .replace(/\s*\([^)]*drafted[^)]*\)\s*/ig, " ")
      .replace(/\s*[-|]\s*drafted.*$/ig, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned && currentSeason) return String(currentSeason) + " Rookie Pick";
    if (token.indexOf("DP_") === 0 || token.indexOf("FP_") === 0) {
      return currentSeason ? String(currentSeason) + " Rookie Pick" : "Rookie Pick";
    }
    return cleaned || raw;
  }

  function resolvePickMeta(asset, seasonHintOverride) {
    var ref = asset || {};
    var token = normalizePickKey(
      ref.asset_id || ref.pick_key || ref.pick || ref.description || ref.pick_display || ""
    );
    var description = safeStr(ref.description || ref.pick_display || "");
    var seasonHint = safeInt(
      seasonHintOverride != null
        ? seasonHintOverride
        : (ref.pick_season != null ? ref.pick_season : ref.season),
      0
    );
    var slotText = safeStr(
      ref.pick_slot != null
        ? ref.pick_slot
        : (ref.slot != null ? ref.slot : ref.pick)
    );
    var slotMeta = parsePickSlotMeta(slotText);
    var round = safeInt(ref.pick_round != null ? ref.pick_round : ref.round, 0) || safeInt(slotMeta.round, 0);
    var pick = safeInt(slotMeta.pick, 0);
    if (!pick) {
      pick = safeInt(
        ref.pick_slot != null
          ? ref.pick_slot
          : (ref.slot != null ? ref.slot : ref.pick),
        0
      );
    }
    var year = seasonHint;

    if ((!round || !pick || !year) && token.indexOf("DP_") === 0) {
      var dp = token.match(/^DP_(\d+)_(\d+)$/i);
      if (dp) {
        round = round || (safeInt(dp[1], 0) + 1);
        pick = pick || (safeInt(dp[2], 0) + 1);
        year = year || safeInt((description.match(/(\d{4})/) || [])[1], 0);
      }
    }

    if ((!round || !year) && token.indexOf("FP_") === 0) {
      var fp = token.match(/^FP_[A-Z0-9]+_(\d{4})_(\d+)$/i);
      if (fp) {
        year = year || safeInt(fp[1], 0);
        round = round || safeInt(fp[2], 0);
      }
    }

    if (!round || !pick || !year) {
      var yearDraft = description.match(/Year\s*(\d{4})\s*Draft Pick\s*(\d+)\.(\d+)/i);
      if (yearDraft) {
        year = year || safeInt(yearDraft[1], 0);
        round = round || safeInt(yearDraft[2], 0);
        pick = pick || safeInt(yearDraft[3], 0);
      }
    }

    if (!round || !pick || !year) {
      var dottedPick = description.match(/(\d{4}).*?(\d+)\.(\d+)/i);
      if (dottedPick) {
        year = year || safeInt(dottedPick[1], 0);
        round = round || safeInt(dottedPick[2], 0);
        pick = pick || safeInt(dottedPick[3], 0);
      }
    }

    if (!round || !pick || !year) {
      var roundPick = description.match(/(\d{4}).*?(?:Round|Rookie)\s*(\d+).*?(?:Pick|\.)(?:\s*|0*)(\d+)/i);
      if (roundPick) {
        year = year || safeInt(roundPick[1], 0);
        round = round || safeInt(roundPick[2], 0);
        pick = pick || safeInt(roundPick[3], 0);
      }
    }

    if (!round || !year) {
      var rookieRound = description.match(/(\d{4}).*?Rookie\s*Round\s*(\d+)/i);
      if (rookieRound) {
        year = year || safeInt(rookieRound[1], 0);
        round = round || safeInt(rookieRound[2], 0);
      }
    }

    return {
      token: token,
      year: year,
      round: round,
      pick: pick
    };
  }

  function describeTradeAsset(asset) {
    if (!asset) return "";
    if (safeStr(asset.type).toUpperCase() === "PLAYER") return safeStr(asset.player_name || asset.asset_id);
    return safeStr(asset.pick_display || asset.description || asset.asset_id);
  }

  function isUntradeableSixthRoundPick(asset) {
    if (!asset || safeStr(asset.type).toUpperCase() !== "PICK") return false;
    return safeInt(resolvePickMeta(asset).round, 0) === 6;
  }

  function escapeHtml(text) {
    return safeStr(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function compareText(a, b) {
    a = safeStr(a).toLowerCase();
    b = safeStr(b).toLowerCase();
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }

  function uniqueSorted(list) {
    var seen = {};
    var out = [];
    var i;
    for (i = 0; i < list.length; i += 1) {
      var key = safeStr(list[i]);
      if (!key || seen[key]) continue;
      seen[key] = true;
      out.push(key);
    }
    out.sort(compareText);
    return out;
  }

  function parseBool(v, fallback) {
    if (typeof v === "boolean") return v;
    var s = safeStr(v).toLowerCase();
    if (!s) return !!fallback;
    if (s === "1" || s === "true" || s === "yes") return true;
    if (s === "0" || s === "false" || s === "no") return false;
    return !!fallback;
  }

  function getDirectMflFromQuery() {
    try {
      var params = new URLSearchParams(window.location.search || "");
      return safeStr(
        params.get("DIRECT_MFL") ||
        params.get("direct_mfl") ||
        params.get("UPS_TWB_DIRECT_MFL")
      );
    } catch (e) {
      return "";
    }
  }

  function isDirectMflMode() {
    // Queue mode is retired: always submit directly to MFL.
    return true;
  }

  function assetGroupKey(asset) {
    if (!asset) return "OTHER";
    if (asset.type === "PICK") return "PICKS";
    var pos = safeStr(asset.position).toUpperCase();
    if (!pos) return "OTHER";
    return pos;
  }

  function groupSortValue(groupKey) {
    var idx = GROUP_ORDER.indexOf(groupKey);
    return idx === -1 ? 999 : idx;
  }

  function isRookieContractType(contractType) {
    var s = safeStr(contractType).toLowerCase();
    return s.indexOf("rookie") !== -1 || s === "r" || s.indexOf("mym - rookie") !== -1;
  }

  function isTradeEligibleAsset(asset) {
    if (!asset) return false;
    if (isTaggedTradeIneligibleAsset(asset)) return false;
    if (safeStr(asset.type).toUpperCase() === "PICK") return !isUntradeableSixthRoundPick(asset);
    return true;
  }

  function isTaggedTradeIneligibleAsset(asset) {
    if (!asset || safeStr(asset.type).toUpperCase() !== "PLAYER") return false;
    if (hasTradeTagDeadlinePassed()) return false;
    var contractType = safeStr(asset.contract_type).toLowerCase();
    var contractInfo = safeStr(asset.contract_info).toLowerCase();
    return contractType.indexOf("tag") !== -1 || contractInfo.indexOf("tag") !== -1;
  }

  function getTradeIneligibleReason(asset) {
    if (!asset) return "";
    if (isTaggedTradeIneligibleAsset(asset)) {
      return "Ineligible: tagged players cannot be traded";
    }
    if (safeStr(asset.type).toUpperCase() === "PICK" && isUntradeableSixthRoundPick(asset)) {
      return "Ineligible: 6th-round picks cannot be traded";
    }
    return "";
  }

  function collectInvalidTradeAssets(payload) {
    var teams = Array.isArray(payload && payload.teams) ? payload.teams : [];
    var invalid = [];
    var seen = {};
    var i;
    for (i = 0; i < teams.length; i += 1) {
      var assets = Array.isArray(teams[i] && teams[i].selected_assets) ? teams[i].selected_assets : [];
      var j;
      for (j = 0; j < assets.length; j += 1) {
        var asset = assets[j];
        if (!asset || isTradeEligibleAsset(asset)) continue;
        var key = safeStr(asset.asset_id || describeTradeAsset(asset));
        if (!key || seen[key]) continue;
        seen[key] = true;
        invalid.push({
          label: describeTradeAsset(asset),
          reason: getTradeIneligibleReason(asset)
        });
      }
    }
    return invalid;
  }

  function buildExtensionIndex(rows) {
    var index = {};
    var i;
    var byKey = {};
    rows = Array.isArray(rows) ? rows : [];

    for (i = 0; i < rows.length; i += 1) {
      var row = rows[i] || {};
      if (safeInt(row.success, 0) !== 1) continue;
      if (safeInt(row.reverted, 0) === 1) continue;

      var franchiseId = pad4(row.franchise_id);
      var playerId = safeStr(row.player_id).replace(/\D/g, "");
      if (!franchiseId || !playerId) continue;

      var term = safeStr(row.extension_term || row.term).toUpperCase() || "1YR";
      var loaded = safeStr(row.loaded_indicator || "NONE").toUpperCase() || "NONE";
      var previewTs = safeStr(row.preview_ts);

      var optionKey = [term, loaded].join("|");
      var compositeKey = [franchiseId, playerId].join("|");
      if (!byKey[compositeKey]) byKey[compositeKey] = {};

      var prev = byKey[compositeKey][optionKey];
      if (!prev || compareText(prev.preview_ts, previewTs) < 0) {
        byKey[compositeKey][optionKey] = {
          preview_id: row.id == null ? null : row.id,
          preview_ts: previewTs,
          extension_term: term,
          loaded_indicator: loaded,
          new_contract_status: safeStr(row.new_contract_status),
          preview_contract_info_string: safeStr(row.preview_contract_info_string),
          y1_salary: row.y1_salary == null ? null : safeInt(row.y1_salary, 0),
          y2_salary: row.y2_salary == null ? null : safeInt(row.y2_salary, 0),
          y3_salary: row.y3_salary == null ? null : safeInt(row.y3_salary, 0),
          new_contract_length: row.new_contract_length == null ? null : safeInt(row.new_contract_length, 0),
          new_TCV: row.new_TCV == null ? null : safeInt(row.new_TCV, 0),
          new_aav_current: row.new_aav_current == null ? null : safeInt(row.new_aav_current, 0),
          new_aav_future: row.new_aav_future == null ? null : safeInt(row.new_aav_future, 0)
        };
      }
    }

    var compositeKeys = Object.keys(byKey);
    for (i = 0; i < compositeKeys.length; i += 1) {
      var ck = compositeKeys[i];
      var optionsMap = byKey[ck];
      var keys = Object.keys(optionsMap);
      keys.sort(function (a, b) {
        return compareText(a, b);
      });
      index[ck] = [];
      var j;
      for (j = 0; j < keys.length; j += 1) {
        var option = optionsMap[keys[j]];
        var loadedLabel = option.loaded_indicator === "NONE" ? "" : " " + option.loaded_indicator;
        var detail = option.new_contract_status ? " · " + option.new_contract_status : "";
        option.option_key = keys[j];
        option.label = option.extension_term + loadedLabel + detail;
        index[ck].push(option);
      }
    }

    return index;
  }

  function normalizeAsset(raw, teamId, extensionIndex, currentSeasonHint, teamMeta) {
    raw = raw || {};
    teamMeta = teamMeta || {};
    var type = safeStr(raw.type || (raw.player_id ? "PLAYER" : "PICK")).toUpperCase();
    var asset = {
      asset_id: safeStr(raw.asset_id),
      type: type,
      franchise_id: pad4(raw.franchise_id || teamId),
      franchise_name: safeStr(teamMeta.franchise_name || raw.franchise_name || raw.team_name || raw.teamName),
      franchise_abbrev: safeStr(teamMeta.franchise_abbrev || raw.franchise_abbrev || raw.abbrev || raw.team_abbrev || raw.teamAbbrev),
      team_name: safeStr(teamMeta.franchise_name || raw.team_name || raw.teamName || raw.franchise_name),
      selected_default: parseBool(raw.selected_default, false)
    };

    if (type === "PICK") {
      asset.asset_id = asset.asset_id || ("pick:" + safeStr(raw.pick_key || raw.description || raw.asset_id));
      asset.description = safeStr(raw.description || raw.label || "Draft Pick");
      var pickMeta = resolvePickMeta({
        asset_id: asset.asset_id || raw.asset_id || raw.pick_key,
        description: asset.description,
        pick_round: raw.pick_round || raw.round,
        pick_slot: raw.pick_slot || raw.slot || raw.pick,
        pick_season: raw.pick_season || raw.season
      });
      asset.pick_display = shortPickLabel(
        asset.description,
        asset.asset_id || raw.pick_key || raw.asset_id,
        raw.pick_season || raw.season || currentSeasonHint
      );
      asset.pick_key = pickMeta.token || normalizePickKey(asset.asset_id || raw.pick_key || raw.asset_id);
      asset.pick_season = pickMeta.year || safeInt(raw.pick_season || raw.season, 0);
      asset.pick_round = pickMeta.round || safeInt(raw.pick_round || raw.round, 0);
      asset.pick_slot = pickMeta.pick ? String(pickMeta.pick) : safeStr(raw.pick_slot || raw.slot || raw.pick);
      var pickSalaryInfo = resolvePickSalaryInfo({
        asset_id: asset.asset_id,
        description: asset.description,
        pick_season: asset.pick_season,
        pick_round: asset.pick_round,
        pick_slot: asset.pick_slot
      }, currentSeasonHint);
      asset.salary = safeInt(pickSalaryInfo.salary_dollars, 0);
      asset.pick_salary_note = safeStr(pickSalaryInfo.meta_label);
      asset.pick_salary_is_average = !!pickSalaryInfo.is_average;
      asset.years = null;
      asset.contract_type = "Pick";
      asset.contract_info = safeStr(raw.contract_info || "");
      asset.taxi = false;
      asset.extension_options = [];
      asset.extension_eligible = false;
      asset.position = "";
      asset.search_text = (asset.description + " " + asset.pick_display + " " + asset.contract_info).toLowerCase();
      return asset;
    }

    var playerId = safeStr(raw.player_id || raw.id || "").replace(/\D/g, "");
    asset.asset_id = asset.asset_id || ("player:" + playerId);
    asset.player_id = playerId;
    asset.player_name = safeStr(raw.player_name || raw.name);
    asset.nfl_team = safeStr(raw.nfl_team || raw.team);
    asset.position = safeStr(raw.position || raw.pos).toUpperCase();
    asset.salary = safeInt(raw.salary, 0);
    asset.aav_current = safeMoneyInt(
      raw.aav_current != null
        ? raw.aav_current
        : (raw.aav != null
            ? raw.aav
            : (raw.aavCurrent != null ? raw.aavCurrent : raw.current_aav)),
      null
    );
    asset.contract_year = null;
    if (raw.contract_year != null || raw.contractYear != null) {
      var cy = safeInt(raw.contract_year != null ? raw.contract_year : raw.contractYear, 0);
      asset.contract_year = cy > 0 ? cy : null;
    }
    asset.contract_length = null;
    if (raw.contract_length != null || raw.contractLength != null) {
      var cl = safeInt(raw.contract_length != null ? raw.contract_length : raw.contractLength, 0);
      asset.contract_length = cl > 0 ? cl : null;
    }
    asset.years = raw.years == null || raw.years === "" ? null : safeInt(raw.years, 0);
    asset.contract_type = safeStr(raw.contract_type || raw.contractstatus || raw.contractStatus || raw.type_label || raw.contract);
    asset.contract_info = safeStr(raw.contract_info || raw.contractInfo || raw.details);
    asset.taxi = parseBool(raw.taxi, false);
    asset.roster_status = safeStr(raw.roster_status || raw.rosterStatus || raw.status).toUpperCase();
    asset.injury = safeStr(raw.injury || raw.status || "");
    asset.notes = safeStr(raw.notes || "");

    if (safeStr(asset.contract_type).toLowerCase() === "taxi" && safeInt(asset.salary, 0) > 0) {
      asset.contract_type = "Rookie";
    }
    if (!asset.contract_info && asset.taxi && safeInt(asset.salary, 0) > 0) {
      if (!asset.contract_length) asset.contract_length = 3;
      asset.contract_info = fallbackTaxiContractInfo(asset);
    }
    var contractInfoSummary = parseContractInfoSummary(asset.contract_info);
    if (!asset.contract_length && contractInfoSummary.contract_length) {
      asset.contract_length = safeInt(contractInfoSummary.contract_length, 0);
    }
    if (asset.aav_current == null && contractInfoSummary.aav_current_dollars != null) {
      asset.aav_current = safeInt(contractInfoSummary.aav_current_dollars, 0);
    }
    if (asset.aav_current == null && asset.taxi && safeInt(asset.salary, 0) > 0) {
      asset.aav_current = safeInt(asset.salary, 0);
    }

    var extOptions = Array.isArray(raw.extension_options) ? clone(raw.extension_options) : null;
    if (!extOptions) {
      var extKey = [asset.franchise_id, asset.player_id].join("|");
      extOptions = extensionIndex[extKey] ? clone(extensionIndex[extKey]) : [];
    }
    var blockExtensionHistory = assetHasExtensionHistory(asset);
    var blockCurrentOwnerExtension = assetLastExtensionHeldByCurrentTeam(asset);
    if (blockExtensionHistory || blockCurrentOwnerExtension) {
      extOptions = [];
    }
    if (!extOptions.length) {
      extOptions = buildSyntheticExtensionOptions(asset);
    }
    asset.extension_options = extOptions;
    asset.extension_eligible = !blockExtensionHistory && !blockCurrentOwnerExtension && (extOptions.length > 0 || parseBool(raw.extension_eligible, false));

    var searchParts = [
      asset.player_name,
      asset.nfl_team,
      asset.position,
      asset.contract_type,
      asset.contract_info,
      asset.notes,
      asset.taxi ? "taxi" : ""
    ];
    asset.search_text = searchParts.join(" ").toLowerCase();
    return asset;
  }

  function normalizeData(raw) {
    raw = raw || {};
    var extensionIndex = buildExtensionIndex(raw.extension_previews || raw.extensionPreviews || []);
    var currentSeason = safeInt(raw.meta && raw.meta.season != null ? raw.meta.season : raw.season, 0);
    var teams = [];
    var i;

    if (Array.isArray(raw.teams)) {
      for (i = 0; i < raw.teams.length; i += 1) {
        var rt = raw.teams[i] || {};
        var teamId = pad4(rt.franchise_id || rt.id);
        if (!teamId) continue;
        var team = {
          franchise_id: teamId,
          franchise_name: safeStr(rt.franchise_name || rt.name || teamId),
          franchise_abbrev: safeStr(rt.franchise_abbrev || rt.abbrev || teamId),
          icon_url: safeStr(rt.icon_url || rt.franchise_logo || rt.logo || ""),
          is_default: parseBool(rt.is_default || rt.my_team, false),
          salary_adjustment_total_dollars: safeMoneyInt(
            rt.salary_adjustment_total_dollars != null
              ? rt.salary_adjustment_total_dollars
              : (rt.summary && (
                  rt.summary.salary_adjustment_total_dollars != null
                    ? rt.summary.salary_adjustment_total_dollars
                    : rt.summary.salaryAdjustmentTotal
                )),
            0
          ),
          available_salary_dollars: safeMoneyInt(
            rt.available_salary_dollars != null
              ? rt.available_salary_dollars
              : (rt.salary_cap_amount_dollars != null ? rt.salary_cap_amount_dollars : rt.salaryCapAmount),
            null
          ),
          assets: []
        };
        var assets = Array.isArray(rt.assets) ? rt.assets : [];
        var j;
        for (j = 0; j < assets.length; j += 1) {
          var asset = normalizeAsset(assets[j], teamId, extensionIndex, currentSeason, {
            franchise_name: team.franchise_name,
            franchise_abbrev: team.franchise_abbrev
          });
          if (asset.asset_id) team.assets.push(asset);
        }
        teams.push(team);
      }
    } else if (Array.isArray(raw.franchises) && Array.isArray(raw.rosters)) {
      var rostersByTeam = {};
      for (i = 0; i < raw.rosters.length; i += 1) {
        var rr = raw.rosters[i] || {};
        var rrId = pad4(rr.franchise_id || rr.id);
        if (!rrId) continue;
        rostersByTeam[rrId] = Array.isArray(rr.assets) ? rr.assets : [];
      }
      for (i = 0; i < raw.franchises.length; i += 1) {
        var rf = raw.franchises[i] || {};
        var fId = pad4(rf.franchise_id || rf.id);
        if (!fId) continue;
        var t2 = {
          franchise_id: fId,
          franchise_name: safeStr(rf.franchise_name || rf.name || fId),
          franchise_abbrev: safeStr(rf.franchise_abbrev || rf.abbrev || fId),
          icon_url: safeStr(rf.icon_url || rf.logo || ""),
          is_default: parseBool(rf.is_default || rf.my_team, false),
          salary_adjustment_total_dollars: safeMoneyInt(
            rf.salary_adjustment_total_dollars != null
              ? rf.salary_adjustment_total_dollars
              : (rf.summary && (
                  rf.summary.salary_adjustment_total_dollars != null
                    ? rf.summary.salary_adjustment_total_dollars
                    : rf.summary.salaryAdjustmentTotal
                )),
            0
          ),
          available_salary_dollars: safeMoneyInt(
            rf.available_salary_dollars != null
              ? rf.available_salary_dollars
              : (rf.salary_cap_amount_dollars != null ? rf.salary_cap_amount_dollars : rf.salaryCapAmount),
            null
          ),
          assets: []
        };
        var rosterAssets = rostersByTeam[fId] || [];
        var k;
        for (k = 0; k < rosterAssets.length; k += 1) {
          t2.assets.push(normalizeAsset(rosterAssets[k], fId, extensionIndex, currentSeason, {
            franchise_name: t2.franchise_name,
            franchise_abbrev: t2.franchise_abbrev
          }));
        }
        teams.push(t2);
      }
    }

    teams.sort(function (a, b) {
      if (!!a.is_default !== !!b.is_default) return a.is_default ? -1 : 1;
      return compareText(a.franchise_name, b.franchise_name);
    });

    var allPositions = [];
    var allContractTypes = [];
    var maxYears = 0;
    var allAssetsCount = 0;
    for (i = 0; i < teams.length; i += 1) {
      var teamAssets = teams[i].assets || [];
      var m;
      for (m = 0; m < teamAssets.length; m += 1) {
        var a = teamAssets[m];
        allAssetsCount += 1;
        if (a.type === "PLAYER") {
          if (a.position) allPositions.push(a.position);
          if (a.contract_type) allContractTypes.push(a.contract_type);
          if (a.years != null && a.years > maxYears) maxYears = a.years;
        }
      }
    }

    var salaryCapDollars = safeMoneyInt(
      (raw.meta && (
        raw.meta.salary_cap_dollars ||
        raw.meta.salary_cap_amount_dollars ||
        raw.meta.auction_start_amount ||
        raw.meta.auctionStartAmount
      )) ||
      raw.salary_cap_dollars ||
      raw.salary_cap_amount_dollars ||
      raw.auction_start_amount ||
      raw.auctionStartAmount,
      0
    );

    return {
      meta: {
        league_id: safeStr(raw.league_id || raw.leagueId),
        season: safeInt(raw.season || raw.year, 0),
        generated_at: safeStr(raw.generated_at || raw.generatedAt || ""),
        source: safeStr(raw.source || "sample"),
        salary_cap_dollars: salaryCapDollars,
        default_franchise_id: pad4(
          (raw.meta && (
            raw.meta.default_franchise_id ||
            raw.meta.defaultFranchiseId
          )) ||
          raw.default_franchise_id ||
          raw.defaultFranchiseId
        ),
        active_franchise_id: pad4(
          (raw.meta && (
            raw.meta.active_franchise_id ||
            raw.meta.activeFranchiseId
          )) ||
          raw.active_franchise_id ||
          raw.activeFranchiseId
        ),
        logged_in_franchise_id: pad4(
          (raw.meta && (
            raw.meta.logged_in_franchise_id ||
            raw.meta.loggedInFranchiseId
          )) ||
          raw.logged_in_franchise_id ||
          raw.loggedInFranchiseId
        ),
        commissioner_lockout: safeStr(
          (raw.meta && (
            raw.meta.commissioner_lockout ||
            raw.meta.commissionerLockout
          )) ||
          raw.commissioner_lockout ||
          raw.commissionerLockout ||
          ""
        ).toUpperCase() === "N" ? "N" : "Y"
      },
      teams: teams,
      extension_previews: raw.extension_previews || raw.extensionPreviews || [],
          filtersMeta: {
            positions: uniqueSorted(allPositions),
            contractTypes: uniqueSorted(allContractTypes),
            maxYears: 3
          },
      stats: {
        teamCount: teams.length,
        assetCount: allAssetsCount
      }
    };
  }

  function getDataUrlFromQuery() {
    var params = new URLSearchParams(window.location.search || "");
    return safeStr(params.get("data"));
  }

  function getApiUrlFromQuery() {
    var params = new URLSearchParams(window.location.search || "");
    return safeStr(params.get("api"));
  }

  function readCookieValue(name) {
    var needle = safeStr(name);
    if (!needle) return "";
    try {
      var raw = safeStr(document.cookie || "");
      if (!raw) return "";
      var parts = raw.split(";");
      var i;
      for (i = 0; i < parts.length; i += 1) {
        var part = safeStr(parts[i]);
        if (!part) continue;
        var eq = part.indexOf("=");
        var key = eq >= 0 ? safeStr(part.slice(0, eq)) : part;
        if (key !== needle) continue;
        var value = eq >= 0 ? safeStr(part.slice(eq + 1)) : "";
        if (!value) return "";
        try {
          return decodeURIComponent(value);
        } catch (eDecode) {
          return value;
        }
      }
    } catch (e) {
      return "";
    }
    return "";
  }

  function getBrowserSessionParams() {
    var out = {};
    var params = null;
    try {
      params = new URLSearchParams(window.location.search || "");
    } catch (e) {
      params = null;
    }

    var mflUserId = readCookieValue("MFL_USER_ID");
    if (!mflUserId && params) {
      mflUserId = safeStr(
        params.get("MFL_USER_ID") ||
        params.get("MFLUSERID") ||
        ""
      );
    }
    if (mflUserId) out.MFL_USER_ID = mflUserId;

    var apiKey = "";
    try {
      apiKey = safeStr(
        (params ? params.get("APIKEY") : "") ||
        (params ? params.get("apikey") : "") ||
        window.APIKEY ||
        window.apiKey ||
        ""
      );
    } catch (e) {
      apiKey = safeStr(window.APIKEY || window.apiKey || "");
    }
    if (apiKey) out.APIKEY = apiKey;
    return out;
  }

  function withBrowserSessionParams(rawUrl) {
    var resolved = resolveRelativeUrl(rawUrl);
    try {
      var u = new URL(resolved, window.location.href);
      var sessionParams = getBrowserSessionParams();
      var keys = Object.keys(sessionParams);
      var i;
      for (i = 0; i < keys.length; i += 1) {
        var key = keys[i];
        if (u.searchParams.has(key)) continue;
        var value = safeStr(sessionParams[key]);
        if (value) u.searchParams.set(key, value);
      }
      return u.toString();
    } catch (e) {
      return resolved;
    }
  }

  function buildApiRequestUrlFromQuery() {
    var apiUrl = getApiUrlFromQuery();
    if (!apiUrl) return "";

    var params = new URLSearchParams(window.location.search || "");
    var leagueCtx = getLeagueContext();
    var finalUrl = resolveRelativeUrl(apiUrl);
    try {
      var u = new URL(finalUrl, window.location.href);
      var forwardKeys = ["L", "YEAR", "F", "FRANCHISE_ID", "franchise_id", "acting_franchise_id", "ACTING_FRANCHISE_ID", "EXT_URL", "extension_previews_url"];
      var i;
      for (i = 0; i < forwardKeys.length; i += 1) {
        var k = forwardKeys[i];
        if (u.searchParams.has(k)) continue;
        var v = safeStr(params.get(k));
        if (v) u.searchParams.set(k, v);
      }
      if (!u.searchParams.get("L") && leagueCtx.leagueId) u.searchParams.set("L", leagueCtx.leagueId);
      if (!u.searchParams.get("YEAR") && leagueCtx.season) u.searchParams.set("YEAR", leagueCtx.season);
      finalUrl = u.toString();
    } catch (e) {
      // ignore URL parsing issues and use the raw value
    }
    return withBrowserSessionParams(finalUrl);
  }

  function resolveRelativeUrl(url) {
    try {
      return new URL(url, window.location.href).toString();
    } catch (e) {
      return url;
    }
  }

  async function fetchJson(url) {
    var res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
    return res.json();
  }

  function resolveTradeAcquisitionLookupUrl(season) {
    var seasonText = safeStr(season || "");
    if (!seasonText) return "";
    return resolveRelativeUrl("../rosters/player_acquisition_lookup_" + encodeURIComponent(seasonText) + ".json");
  }

  async function loadTradeAcquisitionLookupRows(season) {
    var url = resolveTradeAcquisitionLookupUrl(season);
    if (!url) return [];
    try {
      var payload = await fetchJson(url);
      if (Array.isArray(payload)) return payload;
      if (payload && Array.isArray(payload.rows)) return payload.rows;
      return [];
    } catch (err) {
      return [];
    }
  }

  function resolveTradeSalaryAdjustmentLedgerUrl(season) {
    var candidates = [
      window.UPS_TWB_SALARY_ADJUSTMENTS_URL,
      window.UPS_TRADE_WORKBENCH_SALARY_ADJUSTMENTS_URL
    ];
    var seasonText = safeStr(season || "");
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

    return resolveRelativeUrl("../reports/salary_adjustments/salary_adjustments_" + encodeURIComponent(seasonText) + ".json");
  }

  async function loadTradeSalaryAdjustmentLedgerRows(season) {
    var url = resolveTradeSalaryAdjustmentLedgerUrl(season);
    if (!url) return [];
    try {
      var payload = await fetchJson(url);
      if (Array.isArray(payload)) return payload;
      if (payload && Array.isArray(payload.rows)) return payload.rows;
      return [];
    } catch (err) {
      return [];
    }
  }

  function summarizeTradeSalaryAdjustmentRows(rows) {
    var byFranchise = {};
    var list = Array.isArray(rows) ? rows : [];
    var i;
    for (i = 0; i < list.length; i += 1) {
      var row = list[i] || {};
      var franchiseId = pad4(row.franchise_id || row.franchiseId);
      if (!franchiseId) continue;
      if (row.import_eligible === false) continue;
      byFranchise[franchiseId] = safeInt(byFranchise[franchiseId], 0) + safeInt(row.amount, 0);
    }
    return byFranchise;
  }

  function applySalaryAdjustmentLedgerToTradeData(data, rows) {
    var teams = Array.isArray(data && data.teams) ? data.teams : [];
    if (!teams.length) return data;

    var byFranchise = summarizeTradeSalaryAdjustmentRows(rows);
    var i;
    for (i = 0; i < teams.length; i += 1) {
      var team = teams[i] || {};
      var franchiseId = pad4(team.franchise_id);
      team.salary_adjustment_total_dollars = safeInt(
        byFranchise[franchiseId],
        safeInt(team.salary_adjustment_total_dollars, 0)
      );
    }
    return data;
  }

  function applyAcquisitionLookupToTradeData(data, rows) {
    var teams = Array.isArray(data && data.teams) ? data.teams : [];
    var season = safeInt(data && data.meta && data.meta.season, 0);
    var list = Array.isArray(rows) ? rows : [];
    if (!teams.length || !list.length) return data;

    var byPlayerId = {};
    var i;
    for (i = 0; i < list.length; i += 1) {
      var row = list[i] || {};
      var playerId = safeStr(row.player_id || row.id).replace(/\D/g, "");
      if (!playerId) continue;
      byPlayerId[playerId] = row;
    }

    for (i = 0; i < teams.length; i += 1) {
      var assets = Array.isArray(teams[i] && teams[i].assets) ? teams[i].assets : [];
      for (var j = 0; j < assets.length; j += 1) {
        var asset = assets[j];
        if (!asset || safeStr(asset.type).toUpperCase() !== "PLAYER") continue;
        var match = byPlayerId[safeStr(asset.player_id).replace(/\D/g, "")];
        if (!match) continue;

        asset.original_draft_season = safeInt(match.original_draft_season || match.originalDraftSeason, 0);
        if (!asset.taxi) continue;

        if (asset.aav_current == null && safeInt(asset.salary, 0) > 0) {
          asset.aav_current = safeInt(asset.salary, 0);
        }
        if (!asset.contract_info && safeInt(asset.salary, 0) > 0) {
          asset.contract_length = asset.contract_length || 3;
          asset.contract_info = fallbackTaxiContractInfo(asset);
        }
        if ((asset.years == null || safeInt(asset.years, 0) <= 0) && asset.original_draft_season > 0) {
          var years = rookieTaxiYearsRemainingFromDraftSeason(asset.original_draft_season, season);
          if (years > 0) asset.years = years;
        }
        if (safeStr(asset.contract_type).toLowerCase() === "taxi" && asset.original_draft_season > 0) {
          asset.contract_type = "Rookie";
        }
        if (!Array.isArray(asset.extension_options) || !asset.extension_options.length) {
          asset.extension_options = buildSyntheticExtensionOptions(asset);
        }
        if (asset.extension_options.length) asset.extension_eligible = true;
      }
    }

    return data;
  }

  async function normalizeDataWithFallbacks(raw) {
    var data = normalizeData(raw);
    var season = data && data.meta && data.meta.season;
    var results = await Promise.all([
      loadTradeAcquisitionLookupRows(season),
      loadTradeSalaryAdjustmentLedgerRows(season)
    ]);
    applyAcquisitionLookupToTradeData(data, results[0]);
    applySalaryAdjustmentLedgerToTradeData(data, results[1]);
    return data;
  }

  function getDocHeight() {
    var doc = document.documentElement;
    var body = document.body;
    var h = 0;
    if (doc) {
      h = Math.max(h, doc.scrollHeight || 0, doc.offsetHeight || 0, doc.clientHeight || 0);
    }
    if (body) {
      h = Math.max(h, body.scrollHeight || 0, body.offsetHeight || 0, body.clientHeight || 0);
    }
    if (els && els.app) {
      h = Math.max(h, els.app.scrollHeight || 0, els.app.offsetHeight || 0);
    }
    return Math.max(320, Math.ceil(h));
  }

  function postParentHeight(force) {
    if (window.parent === window) return;
    var h = getDocHeight();
    if (!force && h === lastPostedHeight) return;
    lastPostedHeight = h;
    try {
      window.parent.postMessage({ type: "twb-height", height: h }, "*");
    } catch (e) {
      // ignore cross-window messaging errors
    }
  }

  function scheduleParentHeightPost() {
    if (window.parent === window) return;
    if (heightPostTimer) return;
    heightPostTimer = window.setTimeout(function () {
      heightPostTimer = 0;
      postParentHeight(false);
    }, 0);
  }

  function installHeightSync() {
    if (heightSyncInstalled) return;
    heightSyncInstalled = true;
    if (window.parent === window) return;

    if (window.addEventListener) {
      window.addEventListener("resize", scheduleParentHeightPost, false);
      window.addEventListener("load", function () {
        postParentHeight(true);
      }, false);
    }

    if (window.MutationObserver && document.body) {
      try {
        var mo = new MutationObserver(function () {
          scheduleParentHeightPost();
        });
        mo.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true
        });
      } catch (e) {
        // noop
      }
    }

    if (window.ResizeObserver) {
      try {
        var ro = new ResizeObserver(function () {
          scheduleParentHeightPost();
        });
        if (document.body) ro.observe(document.body);
        if (document.documentElement) ro.observe(document.documentElement);
      } catch (e) {
        // noop
      }
    }

    postParentHeight(true);
    window.setTimeout(function () { postParentHeight(true); }, 150);
    window.setTimeout(function () { postParentHeight(true); }, 700);
    window.setTimeout(function () { postParentHeight(true); }, 2000);
  }

  function withNoCacheUrl(rawUrl) {
    var resolved = resolveRelativeUrl(rawUrl);
    try {
      var u = new URL(resolved, window.location.href);
      u.searchParams.set("NO_CACHE", "1");
      u.searchParams.set("_twb_refresh", String(Date.now()));
      return u.toString();
    } catch (e) {
      var sep = resolved.indexOf("?") === -1 ? "?" : "&";
      return resolved + sep + "NO_CACHE=1&_twb_refresh=" + encodeURIComponent(String(Date.now()));
    }
  }

  async function loadData(options) {
    options = options || {};
    var forceReload = !!options.forceReload;
    if (!forceReload && window.UPS_TRADE_WORKBENCH_DATA) return window.UPS_TRADE_WORKBENCH_DATA;

    var fetchWithFallback = async function (url) {
      try {
        var payload = await fetchJson(url);
        writeCachedTwbData(payload);
        return payload;
      } catch (err) {
        var cached = readCachedTwbData();
        if (cached) {
          console.warn("[TWB] Falling back to cached payload after fetch error:", err);
          return cached;
        }
        throw err;
      }
    };

    var queryDataUrl = getDataUrlFromQuery();
    if (queryDataUrl) {
      return fetchWithFallback(forceReload ? withNoCacheUrl(queryDataUrl) : resolveRelativeUrl(queryDataUrl));
    }

    var queryApiUrl = buildApiRequestUrlFromQuery();
    if (queryApiUrl) {
      return fetchWithFallback(forceReload ? withNoCacheUrl(queryApiUrl) : queryApiUrl);
    }

    return fetchWithFallback(forceReload ? withNoCacheUrl(SAMPLE_DATA_URL) : resolveRelativeUrl(SAMPLE_DATA_URL));
  }

  function resolveAfterTradeRefreshApiUrl() {
    var explicit = safeStr(window.UPS_TRADE_AFTER_REFRESH_API || window.UPS_TRADE_WORKBENCH_AFTER_REFRESH_API);
    if (explicit) return withBrowserSessionParams(explicit);

    var actionUrl = resolveTradeOffersActionApiUrl();
    try {
      var u = new URL(actionUrl, window.location.href);
      u.search = "";
      u.hash = "";
      var path = String(u.pathname || "");
      if (/\/trade-offers\/action\/?$/i.test(path)) {
        u.pathname = path.replace(/\/trade-offers\/action\/?$/i, "/refresh/after-trade");
      } else if (/\/api\/trades\/proposals\/action\/?$/i.test(path)) {
        u.pathname = path.replace(/\/api\/trades\/proposals\/action\/?$/i, "/api/trades/refresh-after-trade");
      } else {
        u.pathname = "/refresh/after-trade";
      }
      return withBrowserSessionParams(u.toString());
    } catch (e) {
      return "";
    }
  }

  async function triggerAfterTradeRefresh(args) {
    args = args && typeof args === "object" ? args : {};
    var leagueCtx = getLeagueContext();
    var meta = state.data && state.data.meta ? state.data.meta : {};
    var body = {
      league_id: safeStr(args.league_id || meta.league_id || leagueCtx.leagueId),
      season: safeStr(args.season || meta.season || leagueCtx.season),
      trade_id: safeStr(args.trade_id || args.tradeId || ""),
      acting_franchise_id: getActiveFranchiseId(),
      dispatch_refresh_mym_json: true,
      reconcile_extensions: false
    };
    var url = resolveAfterTradeRefreshApiUrl();
    if (!body.league_id || !body.season || !url) return null;
    try {
      var u = new URL(url, window.location.href);
      if (!u.searchParams.get("L")) u.searchParams.set("L", body.league_id);
      if (!u.searchParams.get("YEAR")) u.searchParams.set("YEAR", body.season);
      url = u.toString();
    } catch (e) {
      // noop
    }
    return fetchJsonRequest(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  }

  async function refreshWorkbenchDataAfterTrade(options) {
    options = options || {};
    var previousActiveId = getActiveFranchiseId();
    var previousRightId = safeStr(state.rightTeamId);
    var raw = await loadData({ forceReload: true });
    state.data = await normalizeDataWithFallbacks(raw);
    if (!state.data.teams || !state.data.teams.length) {
      throw new Error("No teams in refreshed payload.");
    }

    seedInitialTeams();
    if (previousActiveId && getTeamById(previousActiveId)) {
      setActiveFranchiseId(previousActiveId, { syncLeft: true });
    }
    if (
      previousRightId &&
      previousRightId !== state.leftTeamId &&
      getTeamById(previousRightId)
    ) {
      state.rightTeamId = previousRightId;
    }
    initTeamSelectors();
    setReviewContext("draft", {});
    state.counterMode = false;
    state.counterSourceOffer = null;
  }

  function resolveTradeOffersApiUrl() {
    var explicit = safeStr(window.UPS_TRADE_OFFERS_API || window.UPS_TRADE_WORKBENCH_OFFERS_API);
    if (explicit) return withBrowserSessionParams(explicit);

    var apiUrl = buildApiRequestUrlFromQuery();
    if (apiUrl) {
      try {
        var u = new URL(apiUrl, window.location.href);
        u.search = "";
        u.hash = "";
        u.pathname = String(u.pathname || "").replace(/\/trade-workbench\/?$/i, "/trade-offers");
        return withBrowserSessionParams(u.toString());
      } catch (e) {
        // ignore
      }
    }

    return withBrowserSessionParams("https://upsmflproduction.keith-creelman.workers.dev/trade-offers");
  }

  function resolveTradeOffersActionApiUrl() {
    var explicit = safeStr(window.UPS_TRADE_OFFERS_ACTION_API || window.UPS_TRADE_WORKBENCH_OFFERS_ACTION_API);
    if (explicit) return resolveRelativeUrl(explicit);

    var listUrl = resolveTradeOffersApiUrl();
    try {
      var u = new URL(listUrl, window.location.href);
      u.search = "";
      u.hash = "";
      u.pathname = String(u.pathname || "").replace(/\/trade-offers\/?$/i, "/trade-offers/action");
      return withBrowserSessionParams(u.toString());
    } catch (e) {
      return withBrowserSessionParams("https://upsmflproduction.keith-creelman.workers.dev/trade-offers/action");
    }
  }

  function resolveTradeOutboxReplayApiUrl() {
    var explicit = safeStr(window.UPS_TRADE_OUTBOX_REPLAY_API || window.UPS_TRADE_WORKBENCH_OUTBOX_REPLAY_API);
    if (explicit) return resolveRelativeUrl(explicit);
    var actionUrl = resolveTradeOffersActionApiUrl();
    try {
      var u = new URL(actionUrl, window.location.href);
      u.search = "";
      u.hash = "";
      u.pathname = String(u.pathname || "").replace(/\/trade-offers\/action\/?$/i, "/trade-outbox/replay");
      return withBrowserSessionParams(u.toString());
    } catch (e) {
      return withBrowserSessionParams("https://upsmflproduction.keith-creelman.workers.dev/trade-outbox/replay");
    }
  }

  function normalizeOfferStatus(v) {
    var s = safeStr(v).toUpperCase();
    return s || "PENDING";
  }

  function isOfferLivePending(offer) {
    var status = normalizeOfferStatus(offer && offer.status);
    if (status !== "PENDING") return false;
    return offer && offer.mfl_present === true;
  }

  function stripTradeMetaTag(text) {
    return safeStr(text)
      .replace(/\[UPS_TWB_INTENT_BEGIN\][\s\S]*?\[UPS_TWB_INTENT_END\]/gi, " ")
      .replace(/\s*\[UPS_TWB_META:[A-Za-z0-9_-]+\]\s*/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function decodeBase64UrlToUtf8(raw) {
    var source = safeStr(raw).replace(/-/g, "+").replace(/_/g, "/");
    if (!source) return "";
    while (source.length % 4) source += "=";
    try {
      return decodeURIComponent(escape(window.atob(source)));
    } catch (e) {
      return "";
    }
  }

  function parseTradeMetaFromComment(commentText) {
    var text = safeStr(commentText);
    var m = text.match(/\[UPS_TWB_META:([A-Za-z0-9_-]+)\]/);
    if (!m || !m[1]) return null;
    var decoded = decodeBase64UrlToUtf8(m[1]);
    if (!decoded) return null;
    try {
      var parsed = JSON.parse(decoded);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  function normalizePlayerNameKey(value) {
    return safeStr(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
  }

  function playerNameVariants(value) {
    var raw = safeStr(value);
    if (!raw) return [];
    var out = {};
    var direct = normalizePlayerNameKey(raw);
    if (direct) out[direct] = 1;
    var parts = raw.split(",");
    if (parts.length >= 2) {
      var last = safeStr(parts[0]);
      var first = safeStr(parts.slice(1).join(" "));
      var flipped = normalizePlayerNameKey(first + " " + last);
      if (flipped) out[flipped] = 1;
    }
    return Object.keys(out);
  }

  function parsePreTradeExtensionCommentLines(commentText) {
    var text = safeStr(commentText);
    if (!text) return [];
    var normalizedText = text.replace(/\r/g, "\n");
    var re = /pre[\s-]*trade\s*extension\s*:\s*extend\s+(.+?)\s+([0-9]{1,2})\s*(?:-|–|—|‑|\s)?\s*year(?:s)?\b/gi;
    var out = [];
    var match;
    while ((match = re.exec(normalizedText))) {
      var years = safeInt(match[2], 0);
      out.push({
        player_name: safeStr(match[1]),
        extension_term: years > 0 ? String(years) + "YR" : "",
        raw_line: safeStr(match[0]),
        parse_error: !years || !safeStr(match[1])
      });
    }
    return out;
  }

  function parseTradeTokenList(csv) {
    return safeStr(csv)
      .split(",")
      .map(function (s) { return safeStr(s).toUpperCase(); })
      .filter(Boolean);
  }

  function parseBlindBidKFromToken(token) {
    var m = safeStr(token).toUpperCase().match(/^BB_([0-9]+(?:\.[0-9]+)?)$/);
    if (!m || !m[1]) return 0;
    var n = Number(m[1]);
    if (!isFinite(n) || n <= 0) return 0;
    return Math.round(n);
  }

  function assetToPayloadAsset(asset) {
    if (!asset) return null;
    var isPick = safeStr(asset.type).toUpperCase() === "PICK";
    var pickMeta = isPick ? resolvePickMeta(asset) : null;
    return {
      asset_id: asset.asset_id,
      type: asset.type,
      player_id: asset.player_id || null,
      player_name: asset.player_name || null,
      description: isPick ? safeStr(asset.pick_display || asset.description) : null,
      position: asset.position || null,
      nfl_team: asset.nfl_team || null,
      salary: safeInt(asset.salary, 0),
      years: isPick ? null : (asset.years == null ? null : asset.years),
      contract_type: asset.contract_type || null,
      contract_info: asset.contract_info || null,
      taxi: !!asset.taxi,
      pick_key: isPick ? (asset.pick_key || pickMeta.token || null) : null,
      pick_season: isPick ? (pickMeta.year || null) : null,
      pick_round: isPick ? (pickMeta.round || null) : null,
      pick_slot: isPick ? (pickMeta.pick || null) : null
    };
  }

  function findTeamAssetByTradeToken(teamId, token) {
    var team = getTeamById(teamId);
    if (!team) return null;
    var upper = safeStr(token).toUpperCase();
    if (!upper || upper.indexOf("BB_") === 0) return null;
    var assets = team.assets || [];
    var i;
    if (/^[0-9]+$/.test(upper)) {
      for (i = 0; i < assets.length; i += 1) {
        var pid = safeStr(assets[i] && assets[i].player_id).replace(/\D/g, "");
        if (pid && pid === upper) return assets[i];
      }
    }
    var pickKey = normalizePickKey(upper);
    if (pickKey) {
      for (i = 0; i < assets.length; i += 1) {
        if (assets[i].type !== "PICK") continue;
        if (normalizePickKey(assets[i].asset_id) === pickKey) return assets[i];
      }
    }
    return null;
  }

  function extensionPreviewForAssetOption(asset, optionKey, termHint) {
    if (!asset || asset.type !== "PLAYER") return null;
    var options = Array.isArray(asset.extension_options) ? asset.extension_options : [];
    var key = safeStr(optionKey);
    var i;
    if (key) {
      for (i = 0; i < options.length; i += 1) {
        if (safeStr(options[i].option_key) === key) return options[i];
      }
    }
    var term = safeStr(termHint).toUpperCase();
    if (term) {
      for (i = 0; i < options.length; i += 1) {
        if (safeStr(options[i].extension_term).toUpperCase() === term) return options[i];
      }
    }
    return options[0] || null;
  }

  function buildExtensionRequestsFromMeta(extMetaList, leftTeamId, rightTeamId, leftSelectedAssets, rightSelectedAssets) {
    var reqs = Array.isArray(extMetaList) ? extMetaList : [];
    if (!reqs.length) return [];
    var out = [];
    var leftByPlayerId = {};
    var rightByPlayerId = {};
    var i;
    for (i = 0; i < leftSelectedAssets.length; i += 1) {
      if (leftSelectedAssets[i].type !== "PLAYER") continue;
      leftByPlayerId[safeStr(leftSelectedAssets[i].player_id).replace(/\D/g, "")] = leftSelectedAssets[i];
    }
    for (i = 0; i < rightSelectedAssets.length; i += 1) {
      if (rightSelectedAssets[i].type !== "PLAYER") continue;
      rightByPlayerId[safeStr(rightSelectedAssets[i].player_id).replace(/\D/g, "")] = rightSelectedAssets[i];
    }

    for (i = 0; i < reqs.length; i += 1) {
      var ext = reqs[i] || {};
      var playerId = safeStr(ext.player_id).replace(/\D/g, "");
      if (!playerId) continue;
      var fromTeamId = pad4(ext.from || ext.from_franchise_id);
      if (!fromTeamId) {
        if (leftByPlayerId[playerId]) fromTeamId = leftTeamId;
        else if (rightByPlayerId[playerId]) fromTeamId = rightTeamId;
      }
      var toTeamId = pad4(ext.to || ext.to_franchise_id);
      if (!toTeamId && fromTeamId) {
        toTeamId = fromTeamId === leftTeamId ? rightTeamId : leftTeamId;
      }
      var fromAsset = fromTeamId === leftTeamId
        ? leftByPlayerId[playerId]
        : (fromTeamId === rightTeamId ? rightByPlayerId[playerId] : null);
      if (!fromAsset) continue;
      var option = extensionPreviewForAssetOption(fromAsset, ext.option_key, ext.extension_term);
      out.push({
        player_id: playerId,
        player_name: safeStr(fromAsset.player_name),
        from_franchise_id: fromTeamId,
        to_franchise_id: toTeamId || (fromTeamId === leftTeamId ? rightTeamId : leftTeamId),
        applies_to_acquirer: true,
        option_key: safeStr((option && option.option_key) || ext.option_key),
        extension_term: safeStr((option && option.extension_term) || ext.extension_term),
        loaded_indicator: safeStr((option && option.loaded_indicator) || ext.loaded_indicator || "NONE"),
        preview_id: option && option.preview_id != null ? option.preview_id : (ext.preview_id == null ? null : safeInt(ext.preview_id, 0)),
        preview_contract_info_string: safeStr((option && option.preview_contract_info_string) || ext.preview_contract_info_string),
        new_contract_status: safeStr((option && option.new_contract_status) || ext.new_contract_status),
        new_contract_length: option && option.new_contract_length != null
          ? safeInt(option.new_contract_length, 0)
          : (ext.new_contract_length == null ? null : safeInt(ext.new_contract_length, 0)),
        new_TCV: option && option.new_TCV != null ? safeInt(option.new_TCV, 0) : (ext.new_TCV == null ? null : safeInt(ext.new_TCV, 0)),
        new_aav_future: option && option.new_aav_future != null
          ? safeInt(option.new_aav_future, 0)
          : (ext.new_aav_future == null ? null : safeInt(ext.new_aav_future, 0))
      });
    }
    return out;
  }

  function buildExtensionRequestsFromComment(commentText, leftTeamId, rightTeamId, leftSelectedAssets, rightSelectedAssets) {
    var parsed = parsePreTradeExtensionCommentLines(commentText);
    if (!parsed.length) return [];
    var leftByName = {};
    var rightByName = {};
    var i;
    for (i = 0; i < leftSelectedAssets.length; i += 1) {
      if (!leftSelectedAssets[i] || leftSelectedAssets[i].type !== "PLAYER") continue;
      var leftVariants = playerNameVariants(leftSelectedAssets[i].player_name);
      var lv;
      for (lv = 0; lv < leftVariants.length; lv += 1) {
        leftByName[leftVariants[lv]] = leftSelectedAssets[i];
      }
    }
    for (i = 0; i < rightSelectedAssets.length; i += 1) {
      if (!rightSelectedAssets[i] || rightSelectedAssets[i].type !== "PLAYER") continue;
      var rightVariants = playerNameVariants(rightSelectedAssets[i].player_name);
      var rv;
      for (rv = 0; rv < rightVariants.length; rv += 1) {
        rightByName[rightVariants[rv]] = rightSelectedAssets[i];
      }
    }

    var out = [];
    var seenPlayer = {};
    for (i = 0; i < parsed.length; i += 1) {
      var row = parsed[i];
      if (!row || row.parse_error) continue;
      var variants = playerNameVariants(row.player_name);
      var asset = null;
      var fromTeamId = "";
      var j;
      for (j = 0; j < variants.length; j += 1) {
        if (!asset && leftByName[variants[j]]) {
          asset = leftByName[variants[j]];
          fromTeamId = leftTeamId;
        }
        if (!asset && rightByName[variants[j]]) {
          asset = rightByName[variants[j]];
          fromTeamId = rightTeamId;
        }
        if (asset) break;
      }
      if (!asset) continue;
      var playerId = safeStr(asset.player_id).replace(/\D/g, "");
      if (!playerId || seenPlayer[playerId]) continue;
      var option = extensionPreviewForAssetOption(asset, "", row.extension_term);
      if (!option) continue;
      var toTeamId = fromTeamId === leftTeamId ? rightTeamId : leftTeamId;
      seenPlayer[playerId] = 1;
      out.push({
        player_id: playerId,
        player_name: safeStr(asset.player_name),
        from_franchise_id: fromTeamId,
        to_franchise_id: toTeamId,
        applies_to_acquirer: true,
        option_key: safeStr(option.option_key || row.extension_term + "|NONE"),
        extension_term: safeStr(option.extension_term || row.extension_term),
        loaded_indicator: safeStr(option.loaded_indicator || "NONE"),
        preview_id: option.preview_id == null ? null : safeInt(option.preview_id, 0),
        preview_contract_info_string: safeStr(option.preview_contract_info_string),
        new_contract_status: safeStr(option.new_contract_status),
        new_contract_length: option.new_contract_length == null ? null : safeInt(option.new_contract_length, 0),
        new_TCV: option.new_TCV == null ? null : safeInt(option.new_TCV, 0),
        new_aav_future: option.new_aav_future == null ? null : safeInt(option.new_aav_future, 0)
      });
    }
    return out;
  }

  function buildPayloadFromOfferTokens(offer, options) {
    options = options || {};
    var fromId = pad4(offer && offer.from_franchise_id);
    var toId = pad4(offer && offer.to_franchise_id);
    if (!fromId || !toId || !getTeamById(fromId) || !getTeamById(toId) || fromId === toId) return null;

    var actingTeamId = pad4(options.actingTeamId || getActiveFranchiseId() || state.leftTeamId);
    var keepOriginal = !!options.keepOriginalOrientation;
    var leftId = keepOriginal
      ? fromId
      : (actingTeamId === fromId || actingTeamId === toId ? actingTeamId : fromId);
    var rightId = leftId === fromId ? toId : fromId;

    var giveTokensRaw = parseTradeTokenList(offer && offer.will_give_up);
    var receiveTokensRaw = parseTradeTokenList(offer && offer.will_receive);
    var leftTokens = leftId === fromId ? giveTokensRaw.slice() : receiveTokensRaw.slice();
    var rightTokens = leftId === fromId ? receiveTokensRaw.slice() : giveTokensRaw.slice();

    var leftAssets = [];
    var rightAssets = [];
    var leftTradeK = 0;
    var rightTradeK = 0;
    var i;
    for (i = 0; i < leftTokens.length; i += 1) {
      var lt = leftTokens[i];
      if (lt.indexOf("BB_") === 0) {
        leftTradeK += parseBlindBidKFromToken(lt);
        continue;
      }
      var leftAsset = findTeamAssetByTradeToken(leftId, lt);
      if (leftAsset) leftAssets.push(leftAsset);
    }
    for (i = 0; i < rightTokens.length; i += 1) {
      var rt = rightTokens[i];
      if (rt.indexOf("BB_") === 0) {
        rightTradeK += parseBlindBidKFromToken(rt);
        continue;
      }
      var rightAsset = findTeamAssetByTradeToken(rightId, rt);
      if (rightAsset) rightAssets.push(rightAsset);
    }

    if (!leftAssets.length || !rightAssets.length) return null;

    var offerComment = safeStr(offer && (offer.raw_comment || offer.comment || offer.message || offer.notes));
    var meta = (offer && offer.twb_meta) || parseTradeMetaFromComment(offerComment);
    var extensionReqs = buildExtensionRequestsFromMeta(
      meta && Array.isArray(meta.ext) ? meta.ext : [],
      leftId,
      rightId,
      leftAssets,
      rightAssets
    );
    if (!extensionReqs.length && offerComment) {
      extensionReqs = buildExtensionRequestsFromComment(
        offerComment,
        leftId,
        rightId,
        leftAssets,
        rightAssets
      );
    }
    var payload = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      source: "ups-trade-workbench-counter-rebuild",
      league_id: safeStr(state.data && state.data.meta ? state.data.meta.league_id : ""),
      season: state.data && state.data.meta ? state.data.meta.season : null,
      teams: [
        {
          role: "left",
          franchise_id: leftId,
          franchise_name: safeStr((getTeamById(leftId) || {}).franchise_name),
          selected_assets: leftAssets.map(assetToPayloadAsset),
          traded_salary_adjustment_dollars: leftTradeK * 1000,
          traded_salary_adjustment_k: leftTradeK,
          traded_salary_adjustment_max_k: 999,
          selected_non_taxi_salary_dollars: leftAssets.reduce(function (sum, a) {
            if (!a || a.type !== "PLAYER" || a.taxi) return sum;
            return sum + safeInt(a.salary, 0);
          }, 0)
        },
        {
          role: "right",
          franchise_id: rightId,
          franchise_name: safeStr((getTeamById(rightId) || {}).franchise_name),
          selected_assets: rightAssets.map(assetToPayloadAsset),
          traded_salary_adjustment_dollars: rightTradeK * 1000,
          traded_salary_adjustment_k: rightTradeK,
          traded_salary_adjustment_max_k: 999,
          selected_non_taxi_salary_dollars: rightAssets.reduce(function (sum, a) {
            if (!a || a.type !== "PLAYER" || a.taxi) return sum;
            return sum + safeInt(a.salary, 0);
          }, 0)
        }
      ],
      extension_requests: extensionReqs,
      filters: { search: "" },
      ui: {
        left_team_id: leftId,
        right_team_id: rightId
      }
    };

    payload.validation = buildValidationSummary(payload);

    return payload;
  }

  function getOfferPayloadForWorkbench(offer, options) {
    options = options || {};
    var keepOriginalOrientation = !!options.keepOriginalOrientation;
    var actingTeamId = pad4(options.actingTeamId || getActiveFranchiseId() || state.leftTeamId);
    if (options.forcePerspective) {
      var rebuiltForced = buildPayloadFromOfferTokens(offer, options);
      if (rebuiltForced) {
        return orientPayloadForWorkbench(rebuiltForced, actingTeamId, keepOriginalOrientation);
      }
    }
    if (offer && offer.payload && typeof offer.payload === "object") {
      var directPayload = getTradePayloadFromInput(offer.payload);
      if (directPayload) {
        return orientPayloadForWorkbench(directPayload, actingTeamId, keepOriginalOrientation);
      }
    }
    if (offer && offer._twb_payload_cache && typeof offer._twb_payload_cache === "object") {
      return orientPayloadForWorkbench(offer._twb_payload_cache, actingTeamId, keepOriginalOrientation);
    }
    var rebuilt = buildPayloadFromOfferTokens(offer, options);
    if (offer && rebuilt) offer._twb_payload_cache = rebuilt;
    return orientPayloadForWorkbench(rebuilt, actingTeamId, keepOriginalOrientation);
  }

  function offerCanHydratePayload(offer) {
    if (!offer) return false;
    if (offer.payload && typeof offer.payload === "object") return true;
    return !!getOfferPayloadForWorkbench(offer, { keepOriginalOrientation: false });
  }

  function shortDateLabel(iso) {
    var s = safeStr(iso);
    if (!s) return "Unknown";
    var d = new Date(s);
    if (!isFinite(d.getTime())) return "Unknown";
    try {
      return new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric"
      }).format(d);
    } catch (e) {
      return d.toISOString().slice(0, 10);
    }
  }

  function getPayloadSideByRole(payload, role) {
    var teams = Array.isArray((payload || {}).teams) ? payload.teams : [];
    var i;
    for (i = 0; i < teams.length; i += 1) {
      if (safeStr(teams[i] && teams[i].role).toLowerCase() === safeStr(role).toLowerCase()) return teams[i];
    }
    return null;
  }

  function getPayloadSideById(payload, franchiseId) {
    var teams = Array.isArray((payload || {}).teams) ? payload.teams : [];
    var id = pad4(franchiseId);
    var i;
    for (i = 0; i < teams.length; i += 1) {
      if (pad4(teams[i] && teams[i].franchise_id) === id) return teams[i];
    }
    return null;
  }

  function getTradePayloadFromInput(offerPayload) {
    if (!offerPayload || typeof offerPayload !== "object") return null;
    if (offerPayload.payload && typeof offerPayload.payload === "object") return offerPayload.payload;
    return offerPayload;
  }

  function swapPayloadSides(payload) {
    var out = clone(payload);
    var teams = Array.isArray(out.teams) ? out.teams : [];
    var leftIndex = -1;
    var rightIndex = -1;
    var i;
    for (i = 0; i < teams.length; i += 1) {
      var role = safeStr(teams[i] && teams[i].role).toLowerCase();
      if (role === "left" && leftIndex === -1) leftIndex = i;
      else if (role === "right" && rightIndex === -1) rightIndex = i;
    }
    if (leftIndex === -1 || rightIndex === -1) return out;

    var leftTeam = clone(teams[leftIndex] || {});
    var rightTeam = clone(teams[rightIndex] || {});
    leftTeam.role = "right";
    rightTeam.role = "left";
    teams[leftIndex] = rightTeam;
    teams[rightIndex] = leftTeam;
    out.teams = teams;

    if (!out.ui || typeof out.ui !== "object") out.ui = {};
    out.ui.left_team_id = safeStr(rightTeam.franchise_id || out.ui.left_team_id);
    out.ui.right_team_id = safeStr(leftTeam.franchise_id || out.ui.right_team_id);
    return out;
  }

  function orientPayloadForWorkbench(payloadInput, actingTeamId, keepOriginalOrientation) {
    var payload = getTradePayloadFromInput(payloadInput);
    if (!payload || typeof payload !== "object") return null;
    var out = clone(payload);
    if (keepOriginalOrientation) return out;

    var actorId = pad4(actingTeamId || getActiveFranchiseId());
    if (!actorId) return out;
    var leftSide = getPayloadSideByRole(out, "left");
    var rightSide = getPayloadSideByRole(out, "right");
    var leftId = pad4(leftSide && leftSide.franchise_id);
    var rightId = pad4(rightSide && rightSide.franchise_id);
    if (!leftId || !rightId || !leftSide || !rightSide) return out;
    if (actorId === rightId) return swapPayloadSides(out);
    return out;
  }

  function normalizePickKey(value) {
    var s = safeStr(value);
    if (!s) return "";
    var key = s.toUpperCase().replace(/^PICK:/, "").replace(/[^A-Z0-9_.-]/g, "");
    return key;
  }

  function resolveSelectedAssetId(teamId, selectedAsset) {
    var team = getTeamById(teamId);
    if (!team) return "";
    var assets = team.assets || [];
    var assetId = safeStr(selectedAsset && selectedAsset.asset_id);
    var i;
    if (assetId) {
      for (i = 0; i < assets.length; i += 1) {
        if (safeStr(assets[i].asset_id) === assetId) return assets[i].asset_id;
      }
    }

    var selectedType = safeStr(selectedAsset && selectedAsset.type).toUpperCase();
    var selectedPlayerId = safeStr(selectedAsset && selectedAsset.player_id).replace(/\D/g, "");
    if (selectedType === "PLAYER" || selectedPlayerId) {
      for (i = 0; i < assets.length; i += 1) {
        if (assets[i].type !== "PLAYER") continue;
        if (safeStr(assets[i].player_id).replace(/\D/g, "") === selectedPlayerId) return assets[i].asset_id;
      }
      var selectedPlayerName = safeStr(selectedAsset && selectedAsset.player_name).toLowerCase();
      if (selectedPlayerName) {
        for (i = 0; i < assets.length; i += 1) {
          if (assets[i].type !== "PLAYER") continue;
          if (safeStr(assets[i].player_name).toLowerCase() === selectedPlayerName) return assets[i].asset_id;
        }
      }
    }

    var selectedDesc = safeStr(selectedAsset && selectedAsset.description).toLowerCase();
    var selectedKey = normalizePickKey(assetId || selectedDesc);
    if (selectedType === "PICK" || selectedDesc || selectedKey) {
      for (i = 0; i < assets.length; i += 1) {
        var a = assets[i];
        if (a.type !== "PICK") continue;
        if (selectedKey && normalizePickKey(a.asset_id) === selectedKey) return a.asset_id;
        if (selectedDesc && safeStr(a.description).toLowerCase() === selectedDesc) return a.asset_id;
      }
    }

    return "";
  }

  function hydrateTeamSelectionsFromPayload(teamId, payloadSide) {
    if (!teamId || !payloadSide) return;
    ensureSelectionMaps(teamId);
    var selectedAssets = Array.isArray(payloadSide.selected_assets) ? payloadSide.selected_assets : [];
    var i;
    for (i = 0; i < selectedAssets.length; i += 1) {
      var selectedAssetId = resolveSelectedAssetId(teamId, selectedAssets[i]);
      if (!selectedAssetId) continue;
      state.selections[teamId][selectedAssetId] = true;
    }

    var tradeK = safeInt(payloadSide.traded_salary_adjustment_k, NaN);
    if (!isFinite(tradeK)) {
      var dollars = safeInt(payloadSide.traded_salary_adjustment_dollars, NaN);
      tradeK = isFinite(dollars) ? Math.round(dollars / 1000) : 0;
    }
    state.tradeSalaryK[teamId] = tradeK > 0 ? String(tradeK) : "";
    clampTradeSalaryForTeam(teamId);
  }

  function hydrateExtensionsFromPayload(payload) {
    var reqs = Array.isArray((payload || {}).extension_requests) ? payload.extension_requests : [];
    var i;
    for (i = 0; i < reqs.length; i += 1) {
      var req = reqs[i] || {};
      var fromTeamId = pad4(req.from_franchise_id);
      if (!fromTeamId || !getTeamById(fromTeamId)) continue;
      ensureSelectionMaps(fromTeamId);

      var teamAssets = (getTeamById(fromTeamId) || {}).assets || [];
      var targetPlayerId = safeStr(req.player_id).replace(/\D/g, "");
      var asset = null;
      var j;
      for (j = 0; j < teamAssets.length; j += 1) {
        if (teamAssets[j].type !== "PLAYER") continue;
        if (safeStr(teamAssets[j].player_id).replace(/\D/g, "") !== targetPlayerId) continue;
        asset = teamAssets[j];
        break;
      }
      if (!asset) continue;

      state.selections[fromTeamId][asset.asset_id] = true;

      var optionKey = safeStr(req.option_key);
      if (!optionKey) {
        var term = safeStr(req.extension_term).toUpperCase();
        var loaded = safeStr(req.loaded_indicator || "NONE").toUpperCase();
        if (term) optionKey = term + "|" + (loaded || "NONE");
      }

      if (!optionKey && Array.isArray(asset.extension_options) && asset.extension_options[0]) {
        optionKey = safeStr(asset.extension_options[0].option_key);
      }

      state.extensions[fromTeamId][asset.asset_id] = {
        enabled: true,
        option_key: optionKey
      };
    }
  }

  function selectAssetByPlayerId(teamId, playerId) {
    var cleanTeamId = pad4(teamId);
    var cleanPlayerId = safeStr(playerId).replace(/\D/g, "");
    if (!cleanTeamId || !cleanPlayerId) return false;
    var team = getTeamById(cleanTeamId);
    if (!team) return false;
    var assets = Array.isArray(team.assets) ? team.assets : [];
    var i;
    ensureSelectionMaps(cleanTeamId);
    for (i = 0; i < assets.length; i += 1) {
      var asset = assets[i] || {};
      if (safeStr(asset.type).toUpperCase() !== "PLAYER") continue;
      if (safeStr(asset.player_id).replace(/\D/g, "") !== cleanPlayerId) continue;
      state.selections[cleanTeamId][asset.asset_id] = true;
      clampTradeSalaryForTeam(cleanTeamId);
      return true;
    }
    return false;
  }

  function clearRosterDeepLinkParams() {
    try {
      var u = new URL(window.location.href || "");
      var keys = ["twb_player_id", "twb_team_id", "twb_source_team", "twb_left_team", "twb_right_team", "twb_side"];
      var changed = false;
      var i;
      for (i = 0; i < keys.length; i += 1) {
        if (!u.searchParams.has(keys[i])) continue;
        u.searchParams.delete(keys[i]);
        changed = true;
      }
      if (changed && window.history && window.history.replaceState) {
        window.history.replaceState({}, document.title, u.toString());
      }
    } catch (e) {
      // noop
    }
  }

  function applyRosterDeepLinkSelection() {
    var playerId = safeStr(getUrlParam("twb_player_id")).replace(/\D/g, "");
    if (!playerId) return false;

    var sourceTeamId = pad4(getUrlParam("twb_team_id") || getUrlParam("twb_source_team"));
    var leftTeamId = pad4(getUrlParam("twb_left_team"));
    var rightTeamId = pad4(getUrlParam("twb_right_team"));
    var side = safeStr(getUrlParam("twb_side")).toLowerCase();
    var resolvedSide = side;

    if (leftTeamId && getTeamById(leftTeamId)) {
      setActiveFranchiseId(leftTeamId, { syncLeft: true });
    }

    if (!resolvedSide) {
      if (sourceTeamId && state.leftTeamId && sourceTeamId === state.leftTeamId) {
        resolvedSide = "left";
      } else if (sourceTeamId && getTeamById(sourceTeamId)) {
        resolvedSide = "partner";
      } else {
        resolvedSide = "left";
      }
    }

    if (resolvedSide === "partner" || resolvedSide === "right") {
      var partnerTeamId = rightTeamId || sourceTeamId;
      if (partnerTeamId && partnerTeamId !== state.leftTeamId && getTeamById(partnerTeamId)) {
        state.rightTeamId = partnerTeamId;
      }
      if (partnerTeamId) selectAssetByPlayerId(partnerTeamId, playerId);
      state.mobileTab = "partner";
    } else {
      var ownTeamId = sourceTeamId || state.leftTeamId;
      if (ownTeamId && ownTeamId !== state.leftTeamId && getTeamById(ownTeamId)) {
        setActiveFranchiseId(ownTeamId, { syncLeft: true });
      }
      if (state.leftTeamId) selectAssetByPlayerId(state.leftTeamId, playerId);
      if (rightTeamId && rightTeamId !== state.leftTeamId && getTeamById(rightTeamId)) {
        state.rightTeamId = rightTeamId;
      }
      state.mobileTab = "your";
    }

    clearRosterDeepLinkParams();
    return true;
  }

  function resetSubmitUiState(message, tone) {
    state.submit.busy = false;
    state.submit.message = safeStr(message) || "No offer submitted yet.";
    state.submit.tone = safeStr(tone) || "";
    state.submit.lastRequestBody = null;
    state.submit.lastRequestUrl = "";
    state.submit.canRetry = false;
    state.submit.acceptDebug = null;
  }

  function setReviewContext(kind, options) {
    options = options || {};
    var offer = options.offer || null;
    state.reviewContext = {
      kind: safeStr(kind) || "draft",
      offerBucket: safeStr(options.offerBucket),
      offerId: safeStr(options.offerId || (offer && offer.id)),
      tradeId: safeStr(options.tradeId || (offer && getOfferTradeId(offer))),
      offer: offer || null
    };
  }

  function getPrimarySubmitIntent(payload) {
    var ready = !!(payload && payload.validation && payload.validation.status === "ready");
    var ctx = state.reviewContext || {};
    var kind = safeStr(ctx.kind) || (state.counterMode ? "counter" : "draft");
    var intent = {
      kind: kind,
      label: "Submit Offer",
      busyLabel: "Submitting…",
      disabled: !ready || !state.rightTeamId,
      mode: "submit"
    };
    if (kind === "counter") {
      intent.label = "Submit Counter";
      intent.busyLabel = "Submitting Counter…";
      intent.disabled = !ready || !state.rightTeamId;
      intent.mode = "submit";
      return intent;
    }
    if (kind === "incoming") {
      intent.label = "Accept Offer";
      intent.busyLabel = "Accepting…";
      intent.disabled = !safeStr(ctx.tradeId) || state.offers.actionBusy;
      intent.mode = "accept";
      return intent;
    }
    if (kind === "outgoing") {
      intent.label = "Revoke Offer";
      intent.busyLabel = "Revoking…";
      intent.disabled = !safeStr(ctx.tradeId) || state.offers.actionBusy;
      intent.mode = "revoke";
      return intent;
    }
    return intent;
  }

  function getSecondarySubmitActions() {
    var ctx = state.reviewContext || {};
    var kind = safeStr(ctx.kind) || (state.counterMode ? "counter" : "draft");
    if (kind !== "incoming") return [];
    var tradeId = safeStr(ctx.tradeId);
    return [
      {
        mode: "counter",
        label: "Counter Offer",
        disabled: !tradeId || state.offers.actionBusy
      },
      {
        mode: "reject",
        label: "Decline Offer",
        disabled: !tradeId || state.offers.actionBusy
      }
    ];
  }

  function moveToOfferReview() {
    state.mobileTab = "review";
    window.setTimeout(function () {
      if (els.offerCart && els.offerCart.scrollIntoView) {
        try {
          els.offerCart.scrollIntoView({ behavior: "smooth", block: "start" });
        } catch (e) {
          els.offerCart.scrollIntoView(true);
        }
      }
    }, 0);
  }

  function loadOfferIntoWorkbench(offerPayload, options) {
    options = options || {};
    var payload = getTradePayloadFromInput(offerPayload);
    if (!payload || typeof payload !== "object") {
      setSubmitStatus("Could not load offer payload.", "bad");
      renderSummary();
      return false;
    }

    var ui = payload.ui || {};
    var teams = Array.isArray(payload.teams) ? payload.teams : [];
    var leftId = pad4(ui.left_team_id);
    var rightId = pad4(ui.right_team_id);

    var leftSide = leftId ? getPayloadSideById(payload, leftId) : getPayloadSideByRole(payload, "left");
    var rightSide = rightId ? getPayloadSideById(payload, rightId) : getPayloadSideByRole(payload, "right");
    if (!leftSide && teams[0]) leftSide = teams[0];
    if (!rightSide) {
      if (teams[1] && teams[1] !== leftSide) rightSide = teams[1];
      else if (teams[0] && teams[0] !== leftSide) rightSide = teams[0];
    }

    leftId = pad4(leftId || (leftSide && leftSide.franchise_id) || state.leftTeamId);
    rightId = pad4(rightId || (rightSide && rightSide.franchise_id) || state.rightTeamId);

    if (!getTeamById(leftId)) leftId = state.leftTeamId;
    if (!getTeamById(rightId) || rightId === leftId) {
      rightId = rightSide && getTeamById(pad4(rightSide.franchise_id))
        ? pad4(rightSide.franchise_id)
        : (state.rightTeamId !== leftId ? state.rightTeamId : "");
    }

    state.leftTeamId = leftId;
    state.rightTeamId = rightId;
    state.counterMode = !!options.counterMode;
    state.counterSourceOffer = state.counterMode ? (options.counterSourceOffer || state.counterSourceOffer || null) : null;
    if (state.counterMode) {
      setReviewContext("counter", {
        offer: options.sourceOffer || options.counterSourceOffer || null,
        offerBucket: safeStr(options.offerBucket || "received"),
        tradeId: safeStr(options.tradeId)
      });
    } else {
      var loadedKind = safeStr(options.reviewKind);
      if (!loadedKind) {
        var bucket = safeStr(options.offerBucket).toLowerCase();
        if (bucket === "received") loadedKind = "incoming";
        else if (bucket === "offered") loadedKind = "outgoing";
        else loadedKind = "draft";
      }
      setReviewContext(loadedKind, {
        offer: options.sourceOffer || null,
        offerBucket: safeStr(options.offerBucket),
        tradeId: safeStr(options.tradeId)
      });
    }

    resetFilterState();
    state.selections = {};
    state.extensions = {};
    state.tradeSalaryK = {};
    state.collapsed = {};
    resetSubmitUiState(
      safeStr(options.loadedMessage) || (state.counterMode ? "Counter Offer Draft loaded." : "Offer loaded. Review and submit."),
      ""
    );
    if (els.offerMessageInput) els.offerMessageInput.value = "";

    ensureSelectionMaps(state.leftTeamId);
    ensureSelectionMaps(state.rightTeamId);
    if (leftSide) hydrateTeamSelectionsFromPayload(state.leftTeamId, leftSide);
    if (rightSide) hydrateTeamSelectionsFromPayload(state.rightTeamId, rightSide);
    hydrateExtensionsFromPayload(payload);

    initTeamSelectors();
    moveToOfferReview();
    rerender();
    refreshBannerOffers(true);
    return true;
  }

  function offerAssetCount(offer, side) {
    var summary = (offer || {}).summary || {};
    var key = side === "left" ? "from_asset_count" : "to_asset_count";
    var summaryCount = safeInt(summary[key], NaN);
    if (isFinite(summaryCount)) return summaryCount;
    var payload = getTradePayloadFromInput(offer || {});
    var teams = Array.isArray((payload || {}).teams) ? payload.teams : [];
    var i;
    for (i = 0; i < teams.length; i += 1) {
      if (safeStr(teams[i].role).toLowerCase() === (side === "left" ? "left" : "right")) {
        var selected = Array.isArray(teams[i].selected_assets) ? teams[i].selected_assets : [];
        return selected.length;
      }
    }
    return 0;
  }

  function getFranchiseNameById(franchiseId) {
    var id = pad4(franchiseId);
    if (!id) return "";
    var team = getTeamById(id);
    return safeStr(team && team.franchise_name);
  }

  function getFranchiseDisplayLabel(franchiseId) {
    var id = pad4(franchiseId);
    var name = getFranchiseNameById(id);
    if (name) return name;
    if (id) return "Franchise " + id;
    return "Opponent";
  }

  function isLikelyFranchiseIdName(rawName) {
    var s = safeStr(rawName);
    if (!s) return false;
    return /^[0-9]{1,4}$/.test(s) || /^franchise\s*[0-9]{1,4}$/i.test(s);
  }

  function getOfferOpponentLabel(offer, bucket) {
    var o = offer || {};
    var opponentName = "";
    var opponentId = "";
    if (bucket === "offered") {
      opponentName = safeStr(o.to_franchise_name);
      opponentId = pad4(o.to_franchise_id);
    } else {
      opponentName = safeStr(o.from_franchise_name);
      opponentId = pad4(o.from_franchise_id);
    }
    if (opponentName && !isLikelyFranchiseIdName(opponentName)) return opponentName;
    return getFranchiseDisplayLabel(opponentId);
  }

  function getFranchiseLabelFromOfferFields(nameValue, idValue, fallbackLabel) {
    var explicitName = safeStr(nameValue);
    var id = pad4(idValue);
    if (explicitName && !isLikelyFranchiseIdName(explicitName)) return explicitName;
    if (id) return getFranchiseDisplayLabel(id);
    return safeStr(fallbackLabel || "Opponent");
  }

  function getOfferTradeId(offer) {
    return safeStr(
      (offer || {}).mfl_trade_id ||
      (offer || {}).trade_id ||
      (((offer || {}).mfl || {}).trade_id)
    ).replace(/\D/g, "");
  }

  function getUrlParam(name) {
    try {
      var u = new URL(window.location.href || "");
      return safeStr(u.searchParams.get(name));
    } catch (e) {
      return "";
    }
  }

  function stripOfferLoadParamsFromUrl() {
    try {
      var u = new URL(window.location.href || "");
      var before = u.toString();
      u.searchParams.delete("twb_load_offer");
      u.searchParams.delete("twb_mode");
      var after = u.toString();
      if (after !== before && window.history && window.history.replaceState) {
        window.history.replaceState({}, "", after);
      }
    } catch (e) {
      // noop
    }
  }

  function flattenOfferCollections(res) {
    var pools = [];
    if (res && Array.isArray(res.incoming)) pools = pools.concat(res.incoming);
    if (res && Array.isArray(res.outgoing)) pools = pools.concat(res.outgoing);
    if (res && Array.isArray(res.offers)) pools = pools.concat(res.offers);
    if (res && Array.isArray(res.proposals)) pools = pools.concat(res.proposals);
    return pools;
  }

  function findOfferByLoadKey(rows, loadKey) {
    var list = Array.isArray(rows) ? rows : [];
    var exact = safeStr(loadKey);
    var digits = exact.replace(/\D/g, "");
    var i;
    for (i = 0; i < list.length; i += 1) {
      var o = list[i] || {};
      if (safeStr(o.id) === exact) return o;
      if (digits) {
        var mflId = safeStr(o.mfl_trade_id || o.trade_id || ((o.mfl || {}).trade_id)).replace(/\D/g, "");
        if (mflId && mflId === digits) return o;
      }
    }
    return null;
  }

  async function fetchOfferById(loadKey) {
    var leagueCtx = getLeagueContext();
    var leagueId = safeStr(state.data && state.data.meta ? state.data.meta.league_id : "") || leagueCtx.leagueId;
    var season = safeStr(state.data && state.data.meta ? state.data.meta.season : "") || leagueCtx.season;
    var franchiseId = getActiveFranchiseId();
    if (!leagueId || !season || !safeStr(loadKey)) {
      return { ok: false, reason: "Offer lookup is missing league context." };
    }

    async function requestOffers(scoped) {
      var url = new URL(resolveTradeOffersApiUrl(), window.location.href);
      url.searchParams.set("L", leagueId);
      url.searchParams.set("YEAR", season);
      url.searchParams.set("status", "PENDING");
      url.searchParams.set("include_payload", "1");
      url.searchParams.set("limit", "300");
      if (scoped && franchiseId) {
        url.searchParams.set("FRANCHISE_ID", franchiseId);
        url.searchParams.set("acting_franchise_id", franchiseId);
      }
      return fetchJsonRequest(url.toString());
    }

    var scopedRes = await requestOffers(true);
    var match = findOfferByLoadKey(flattenOfferCollections(scopedRes), loadKey);
    if (!match) {
      var globalRes = await requestOffers(false);
      match = findOfferByLoadKey(flattenOfferCollections(globalRes), loadKey);
    }
    if (!match) return { ok: false, reason: "Offer no longer available in MFL." };
    if (!isOfferLivePending(match)) return { ok: false, reason: "Offer no longer available in MFL." };
    if (!offerCanHydratePayload(match)) {
      return { ok: false, reason: "Offer payload is unavailable." };
    }
    return { ok: true, offer: match };
  }

  async function hydrateOfferFromUrlIfNeeded() {
    var loadKey = getUrlParam("twb_load_offer");
    if (!loadKey) {
      try {
        loadKey = safeStr(sessionStorage.getItem("twb_redirect_from_o5") || sessionStorage.getItem("twb_redirected_from_o5"));
      } catch (e) {
        loadKey = "";
      }
    }
    if (!loadKey) return;
    var mode = safeStr(getUrlParam("twb_mode")).toLowerCase();
    if (!mode) {
      try {
        mode = safeStr(sessionStorage.getItem("twb_mode"));
      } catch (e2) {
        mode = "";
      }
    }

    setSubmitStatus("Loading trade offer…", "");
    renderSummary();
    try {
      var out = await fetchOfferById(loadKey);
      if (!out.ok || !out.offer) {
        setSubmitStatus(out && out.reason ? out.reason : "Offer no longer available in MFL.", "warn");
        renderSummary();
        return;
      }
      var payloadForLoad = getOfferPayloadForWorkbench(out.offer, {
        actingTeamId: getActiveFranchiseId(),
        keepOriginalOrientation: false,
        forcePerspective: mode === "counter"
      });
      if (!payloadForLoad) {
        setSubmitStatus("Offer payload is unavailable.", "bad");
        renderSummary();
        return;
      }
      var activeId = getActiveFranchiseId();
      var offerBucket = "";
      if (activeId && pad4(out.offer.to_franchise_id) === activeId) offerBucket = "received";
      else if (activeId && pad4(out.offer.from_franchise_id) === activeId) offerBucket = "offered";
      loadOfferIntoWorkbench(payloadForLoad, {
        counterMode: mode === "counter",
        loadedMessage: mode === "counter" ? "Counter Offer Draft loaded." : "Offer loaded in Trade War Room.",
        counterSourceOffer: mode === "counter" ? out.offer : null,
        sourceOffer: out.offer,
        offerBucket: offerBucket,
        tradeId: getOfferTradeId(out.offer),
        reviewKind: mode === "counter"
          ? "counter"
          : (offerBucket === "received" ? "incoming" : (offerBucket === "offered" ? "outgoing" : "draft"))
      });
      if (mode === "counter") {
        setSubmitStatus("Counter Offer Draft loaded.", "");
      } else {
        setSubmitStatus("Offer loaded in Trade War Room.", "");
      }
      renderSummary();
    } catch (err) {
      setSubmitStatus(friendlyOfferError("Offer load failed", err), "bad");
      renderSummary();
    } finally {
      try {
        sessionStorage.removeItem("twb_redirect_from_o5");
        sessionStorage.removeItem("twb_redirected_from_o5");
        sessionStorage.removeItem("twb_mode");
      } catch (e3) {
        // noop
      }
      stripOfferLoadParamsFromUrl();
    }
  }

  function normalizeOffersForBanner(rows) {
    var src = Array.isArray(rows) ? rows : [];
    var out = [];
    var i;
    for (i = 0; i < src.length; i += 1) {
      var offer = src[i] || {};
      if (!isOfferLivePending(offer)) continue;
      out.push(offer);
    }
    return out;
  }

  function offerActionBusyKey(action, offerId, bucket) {
    return [safeStr(action), safeStr(bucket), safeStr(offerId)].join("|");
  }

  function createOfferActionButton(action, label, offerId, bucket, bad) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "twb-banner-offer-action-btn" + (bad ? " is-bad" : "");
    var busyKey = offerActionBusyKey(action, offerId, bucket);
    var isBusyThis = state.offers.actionBusy && state.offers.actionBusyKey === busyKey;
    btn.textContent = isBusyThis ? "Working…" : label;
    btn.setAttribute("data-action", action);
    btn.setAttribute("data-offer-id", offerId);
    btn.setAttribute("data-offer-bucket", bucket);
    btn.setAttribute("data-offer-action-key", busyKey);
    if (state.offers.actionBusy) btn.disabled = true;
    return btn;
  }

  function summarizePostAcceptResult(res) {
    var salaryAdj = res && res.salary_adjustments ? res.salary_adjustments : {};
    var ext = res && res.extensions ? res.extensions : {};
    var extPrep = res && res.extension_preparation ? res.extension_preparation : {};
    var taxiSync = res && res.taxi_sync ? res.taxi_sync : {};
    var verification = ext && ext.verification ? ext.verification : {};
    var parts = [];
    var tone = "good";
    if (salaryAdj && salaryAdj.skipped) {
      parts.push("Salary adjustments: skipped");
    } else if (salaryAdj && salaryAdj.ok) {
      parts.push("Salary adjustments: posted " + String((salaryAdj.rows || []).length));
    } else {
      tone = "warn";
      parts.push("Salary adjustments: failed");
    }

    if (ext && ext.skipped) {
      var skipReason = safeStr(ext.reason);
      var skipRows = Array.isArray(ext.skipped_rows) ? ext.skipped_rows : [];
      var firstSkip = skipRows[0] || {};
      var firstSkipReason = safeStr(firstSkip.reason || firstSkip.parse_error);
      var expectedCount = safeInt(ext.expected_extension_count, safeInt(extPrep.expected_extension_count, 0));
      var detailBits = [];
      if (expectedCount > 0) detailBits.push(String(expectedCount) + " expected");
      if (firstSkipReason) detailBits.push(firstSkipReason);
      if (skipReason) detailBits.push(skipReason);
      parts.push("Extensions: skipped" + (detailBits.length ? " (" + detailBits.join(" · ") + ")" : ""));
      tone = tone === "good" ? "warn" : tone;
    } else if (ext && ext.ok) {
      var checked = safeInt(verification.checked_players, (ext.applied || []).length);
      var matched = safeInt(verification.matched_players, checked);
      var verifyPending = verification && verification.ok === false;
      if (verifyPending) {
        tone = tone === "good" ? "warn" : tone;
        var verifyReason = safeStr(verification.reason || ext.reason);
        parts.push(
          "Extensions posted; verification pending" +
            (verifyReason ? " (" + verifyReason + ")" : "")
        );
      } else {
        parts.push("Extensions verified: " + String(matched) + "/" + String(checked));
      }
    } else {
      tone = "warn";
      parts.push("Extensions: failed");
    }

    var outbox = res && res.outbox ? res.outbox : {};
    var outboxId = safeStr(outbox.outbox_id);
    var outboxStatus = safeStr(outbox.status);
    var outboxHash = safeStr(outbox.payload_hash);
    if (outboxId || outboxHash) {
      var outboxBits = [];
      if (outboxStatus) outboxBits.push(outboxStatus);
      if (outboxId) outboxBits.push("id " + outboxId);
      if (outboxHash) outboxBits.push("hash " + outboxHash.slice(0, 10));
      parts.push("Outbox: " + outboxBits.join(" · "));
    }

    var taxiRows = Array.isArray(taxiSync.rows) ? taxiSync.rows : [];
    var taxiVerification = taxiSync && taxiSync.verification ? taxiSync.verification : {};
    var taxiReason = safeStr(taxiSync.reason);
    if (!taxiSync.skipped) {
      if (taxiSync.ok) {
        parts.push("Taxi sync: " + String(safeInt(taxiVerification.matched_count, taxiRows.length)));
      } else if (taxiSync.request_ok && taxiSync.verification_ok === false) {
        tone = tone === "good" ? "warn" : tone;
        parts.push("Taxi sync: verification pending");
      } else {
        tone = tone === "good" ? "warn" : tone;
        parts.push("Taxi sync: failed");
      }
    } else if (taxiReason && taxiReason !== "not_run" && taxiReason !== "no_traded_taxi_players") {
      tone = tone === "good" ? "warn" : tone;
      parts.push("Taxi sync: " + taxiReason);
    }

    return {
      tone: tone,
      text: parts.join(" · ")
    };
  }

  function loadCounterDraftFromOffer(meta) {
    var offer = meta && meta.offer ? meta.offer : null;
    if (!offer) {
      setSubmitStatus("Counter Offer Draft is unavailable for this offer payload.", "bad");
      renderSummary();
      return;
    }
    var payload = getOfferPayloadForWorkbench(offer, {
      actingTeamId: getActiveFranchiseId(),
      keepOriginalOrientation: false,
      forcePerspective: true
    });
    if (!payload) {
      setSubmitStatus("Counter Offer Draft is unavailable for this offer payload.", "bad");
      renderSummary();
      return;
    }
    var loaded = loadOfferIntoWorkbench(payload, {
      counterMode: true,
      loadedMessage: "Counter Offer Draft loaded.",
      counterSourceOffer: offer,
      sourceOffer: offer,
      offerBucket: "received",
      tradeId: getOfferTradeId(offer),
      reviewKind: "counter"
    });
    if (loaded) setSubmitStatus("Counter Offer Draft loaded.", "");
  }

  async function performOfferAction(action, meta) {
    var normalizedAction = normalizeOfferStatus(action);
    if (!normalizedAction || state.offers.actionBusy) return;
    if (normalizedAction !== "ACCEPT") setAcceptDebug(null);
    var offer = meta && meta.offer ? meta.offer : null;
    var bucket = safeStr(meta && meta.bucket);
    if (!offer) {
      setSubmitStatus("Offer action failed: offer not found.", "bad");
      renderSummary();
      return;
    }

    if (normalizedAction === "COUNTER") {
      loadCounterDraftFromOffer({ offer: offer, bucket: bucket });
      return;
    }

    var leagueId = safeStr(state.data && state.data.meta ? state.data.meta.league_id : "");
    var season = safeStr(state.data && state.data.meta ? state.data.meta.season : "");
    var actingFranchiseId = getActiveFranchiseId();
    var tradeId = getOfferTradeId(offer);
    if (!leagueId || !season || !actingFranchiseId || !tradeId) {
      setSubmitStatus("Offer action failed: missing trade routing fields.", "bad");
      renderSummary();
      return;
    }

    state.offers.actionBusy = true;
    state.offers.actionBusyKey = offerActionBusyKey(
      normalizedAction === "ACCEPT"
        ? "offer-accept"
        : normalizedAction === "REJECT"
          ? "offer-reject"
          : normalizedAction === "REVOKE"
            ? "offer-revoke"
            : normalizedAction === "COUNTER"
              ? "offer-counter"
              : "",
      safeStr(offer.id),
      bucket
    );
    var actionLabel = "Processing";
    if (normalizedAction === "REVOKE") actionLabel = "Revoking";
    else if (normalizedAction === "REJECT") actionLabel = "Rejecting";
    else if (normalizedAction === "ACCEPT") actionLabel = "Accepting";
    setSubmitStatus(actionLabel + " offer in MFL…", "");
    if (normalizedAction === "ACCEPT") {
      showFeedbackModal(
        "Processing Trade",
        "Processing... Trading contracts are being processed.",
        "warn"
      );
    }
    renderSummary();
    renderBannerOffers();

    try {
      var actionUrl = resolveTradeOffersActionApiUrl();
      var actionPayload = getOfferPayloadForWorkbench(offer, { keepOriginalOrientation: true }) || null;
      if (normalizedAction === "ACCEPT" && actionPayload && typeof actionPayload === "object") {
        var acceptValidation = buildValidationSummary(actionPayload);
        if (acceptValidation.status !== "ready") {
          var acceptIssue = safeStr((acceptValidation.issues || [])[0]) || "Trade payload is not ready.";
          setSubmitStatus("Offer action blocked: " + acceptIssue, "warn");
          showFeedbackModal("Trade Blocked", acceptIssue, "warn");
          return;
        }
      }
      var reviewPayload = null;
      if (normalizedAction === "ACCEPT") {
        reviewPayload = buildTradePayload();
        if (reviewPayload && typeof reviewPayload === "object") {
          var reviewExtReqs = Array.isArray(reviewPayload.extension_requests) ? reviewPayload.extension_requests : [];
          var actionExtReqs = actionPayload && Array.isArray(actionPayload.extension_requests)
            ? actionPayload.extension_requests
            : [];
          if (reviewExtReqs.length && !actionExtReqs.length) {
            if (!actionPayload || typeof actionPayload !== "object") {
              actionPayload = {};
            } else {
              actionPayload = clone(actionPayload);
            }
            actionPayload.extension_requests = clone(reviewExtReqs);
          }
          if (actionPayload && typeof actionPayload === "object") {
            if (!safeStr(actionPayload.comment) && safeStr(reviewPayload.comment)) {
              actionPayload.comment = safeStr(reviewPayload.comment);
            }
            if (!safeStr(actionPayload.comments) && safeStr(reviewPayload.comments)) {
              actionPayload.comments = safeStr(reviewPayload.comments);
            }
            if (!safeStr(actionPayload.raw_comment) && safeStr(reviewPayload.raw_comment)) {
              actionPayload.raw_comment = safeStr(reviewPayload.raw_comment);
            }
          }
        }
      }
      var offerRawCommentText = safeStr(
        offer.raw_comment || offer.comments || offer.comment || offer.message || offer.notes
      );
      var offerMeta = offer && offer.twb_meta ? offer.twb_meta : null;
      if (!offerMeta && offerRawCommentText) {
        offerMeta = parseTradeMetaFromComment(offerRawCommentText);
      }
      var explicitOfferExtensionRequests = [];
      if (normalizedAction === "ACCEPT") {
        if (reviewPayload && Array.isArray(reviewPayload.extension_requests) && reviewPayload.extension_requests.length) {
          explicitOfferExtensionRequests = clone(reviewPayload.extension_requests);
        } else if (actionPayload && Array.isArray(actionPayload.extension_requests) && actionPayload.extension_requests.length) {
          explicitOfferExtensionRequests = clone(actionPayload.extension_requests);
        } else if (offerMeta && Array.isArray(offerMeta.ext) && offerMeta.ext.length) {
          explicitOfferExtensionRequests = clone(offerMeta.ext);
        }
      }
      var body = {
        league_id: leagueId,
        season: season,
        offer_id: safeStr(offer.id),
        proposal_id: safeStr(offer.proposal_id || offer.trade_id || offer.id),
        trade_id: tradeId,
        action: normalizedAction,
        acting_franchise_id: actingFranchiseId,
        payload: actionPayload,
        offer_comment: offerRawCommentText,
        offer_comments: safeStr(offer.comments || offer.comment || offer.raw_comment || offer.message || offer.notes),
        offer_notes: safeStr(offer.notes || offer.comment || offer.comments || offer.raw_comment || offer.message),
        offer_raw_comment: offerRawCommentText,
        offer_message: safeStr(offer.message || offer.comment || offer.comments || offer.raw_comment || offer.notes),
        offer_twb_meta: offerMeta,
        offer_extension_requests: explicitOfferExtensionRequests,
        offer_from_franchise_id: safeStr(offer.from_franchise_id),
        offer_to_franchise_id: safeStr(offer.to_franchise_id),
        offer_will_give_up: safeStr(offer.will_give_up),
        offer_will_receive: safeStr(offer.will_receive),
        direct_mfl: true
      };
      if (normalizedAction === "ACCEPT") {
        try {
          console.log("[TWB][accept][request]", {
            url: actionUrl,
            league_id: body.league_id,
            season: body.season,
            trade_id: body.trade_id,
            acting_franchise_id: body.acting_franchise_id,
            has_payload: !!body.payload,
            payload_extension_requests: Array.isArray(body.payload && body.payload.extension_requests)
              ? body.payload.extension_requests.length
              : 0,
            explicit_extension_requests: Array.isArray(body.offer_extension_requests)
              ? body.offer_extension_requests.length
              : 0,
            has_offer_twb_meta: !!body.offer_twb_meta,
            offer_twb_meta_ext: Array.isArray(body.offer_twb_meta && body.offer_twb_meta.ext)
              ? body.offer_twb_meta.ext.length
              : 0,
            has_offer_comment: !!safeStr(body.offer_comment)
          });
        } catch (eLogReq) {
          // noop
        }
      }
      var res = await fetchJsonRequest(actionUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      var okText = "Offer processed in MFL.";
      if (normalizedAction === "REVOKE") okText = "Offer revoked in MFL.";
      else if (normalizedAction === "REJECT") okText = "Offer rejected in MFL.";
      else if (normalizedAction === "ACCEPT") okText = "Offer accepted in MFL.";
      if (normalizedAction === "ACCEPT") {
        try {
          console.log("[TWB][accept][response]", {
            ok: !!(res && res.ok),
            action: safeStr(res && res.action),
            trade_id: safeStr(res && res.trade_id),
            extensions_reason: safeStr(res && res.extensions && res.extensions.reason),
            extensions_ok: !!(res && res.extensions && res.extensions.ok),
            salary_ok: !!(res && res.salary_adjustments && res.salary_adjustments.ok),
            outbox_id: safeStr(res && res.outbox && res.outbox.outbox_id),
            outbox_status: safeStr(res && res.outbox && res.outbox.status),
            outbox_hash: safeStr(res && res.outbox && res.outbox.payload_hash)
          });
        } catch (eLogRes) {
          // noop
        }
        var postSummary = summarizePostAcceptResult(res);
        if (postSummary.text) okText += " " + postSummary.text + ".";
        setSubmitStatus(okText, postSummary.tone || "good");
        showFeedbackModal("Offer Accepted", okText, postSummary.tone || "good");
        setAcceptDebug(res && res.accept_debug ? res.accept_debug : null);
        if (res && res.accept_debug) {
          try {
            console.log("[TWB][accept][debug]", res.accept_debug);
          } catch (e0) {
            // noop
          }
        }
        try {
          var afterRefreshRes = await triggerAfterTradeRefresh({
            trade_id: safeStr(res && res.trade_id)
          });
          if (afterRefreshRes && afterRefreshRes.ok === false) {
            console.warn("[TWB] After-trade refresh hook returned non-ok payload:", afterRefreshRes);
          }
        } catch (afterRefreshErr) {
          console.warn("[TWB] After-trade refresh hook failed:", afterRefreshErr);
        }
        try {
          await refreshWorkbenchDataAfterTrade();
        } catch (refreshErr) {
          console.error("[TWB] Post-accept roster refresh failed:", refreshErr);
          setSubmitStatus(okText + " Roster refresh failed; reload page.", "warn");
        }
      } else {
        setSubmitStatus(okText, "good");
        if (normalizedAction === "REVOKE") {
          showFeedbackModal("Offer Revoked", okText, "good");
        } else if (normalizedAction === "REJECT") {
          showFeedbackModal("Offer Rejected", okText, "good");
        } else {
          showFeedbackModal("Trade Update", okText, "good");
        }
      }
      await refreshBannerOffers(true);
      if (res && res.mode && safeStr(res.mode).toLowerCase() !== "direct_mfl") {
        setSubmitStatus(okText + " (non-direct mode response)", "warn");
      }
    } catch (err) {
      if (normalizedAction === "ACCEPT") {
        var debugFromErr = err && err.data && err.data.accept_debug ? err.data.accept_debug : null;
        setAcceptDebug(debugFromErr);
        if (debugFromErr) {
          try {
            console.log("[TWB][accept][debug][error]", debugFromErr);
          } catch (e00) {
            // noop
          }
        }
      }
      try {
        console.error("[TWB] Offer action failed diagnostics:", {
          action: normalizedAction,
          message: err && err.message,
          status: err && err.status,
          data: err && err.data,
          responseText: err && err.responseText
        });
      } catch (e) {
        // noop
      }
      setSubmitStatus(friendlyOfferError("Offer action failed", err), "bad");
      if (normalizedAction === "ACCEPT") {
        showFeedbackModal(
          "Trade Failed",
          friendlyOfferError("Offer action failed", err),
          "bad"
        );
      }
    } finally {
      state.offers.actionBusy = false;
      state.offers.actionBusyKey = "";
      renderSummary();
      renderBannerOffers();
    }
  }

  function renderBannerOfferList(listEl, offers, bucket) {
    if (!listEl) return;
    listEl.innerHTML = "";

    if (state.offers.busy) {
      var loading = document.createElement("div");
      loading.className = "twb-banner-offers-empty";
      loading.textContent = "Loading…";
      listEl.appendChild(loading);
      return;
    }

    if (state.offers.error) {
      var err = document.createElement("div");
      err.className = "twb-banner-offers-empty";
      err.textContent = state.offers.error;
      listEl.appendChild(err);
      return;
    }

    if (!offers.length) {
      var empty = document.createElement("div");
      empty.className = "twb-banner-offers-empty";
      empty.textContent = "No pending trades";
      listEl.appendChild(empty);
      return;
    }

    var i;
    for (i = 0; i < offers.length; i += 1) {
      var offer = offers[i] || {};
      var hasPayload = offerCanHydratePayload(offer);
      var card = document.createElement("article");
      card.className = "twb-banner-offer-item";

      var title = document.createElement("div");
      title.className = "twb-banner-offer-title";
      var opponentLabel = getOfferOpponentLabel(offer, bucket);
      title.textContent = bucket === "offered"
        ? ("Pending vs " + opponentLabel)
        : ("Pending from " + opponentLabel);

      var meta = document.createElement("div");
      meta.className = "twb-banner-offer-meta";
      meta.textContent =
        shortDateLabel(offer.created_at) +
        " · " +
        offerAssetCount(offer, "left") +
        " assets for " +
        offerAssetCount(offer, "right") +
        " assets";

      var openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "twb-banner-offer-main";
      openBtn.setAttribute("data-action", "load-offer");
      openBtn.setAttribute("data-offer-id", safeStr(offer.id));
      openBtn.setAttribute("data-offer-bucket", bucket);
      openBtn.disabled = !hasPayload || !!state.offers.actionBusy;
      openBtn.appendChild(title);
      openBtn.appendChild(meta);
      card.appendChild(openBtn);

      var actions = document.createElement("div");
      actions.className = "twb-banner-offer-actions";
      if (bucket === "received") {
        var counterBtn = createOfferActionButton(
          "offer-counter",
          "Counter",
          safeStr(offer.id),
          bucket,
          false
        );
        counterBtn.disabled = !hasPayload || !!state.offers.actionBusy;
        actions.appendChild(counterBtn);
        actions.appendChild(
          createOfferActionButton("offer-accept", "Accept", safeStr(offer.id), bucket, false)
        );
        actions.appendChild(
          createOfferActionButton("offer-reject", "Decline", safeStr(offer.id), bucket, true)
        );
      } else {
        actions.appendChild(
          createOfferActionButton("offer-revoke", "Revoke", safeStr(offer.id), bucket, true)
        );
      }
      card.appendChild(actions);
      listEl.appendChild(card);
    }
  }

  function renderBannerOffers() {
    if (els.offeredCount) els.offeredCount.textContent = String((state.offers.offered || []).length);
    if (els.receivedCount) els.receivedCount.textContent = String((state.offers.received || []).length);
    renderBannerOfferList(els.offeredList, state.offers.offered || [], "offered");
    renderBannerOfferList(els.receivedList, state.offers.received || [], "received");
  }

  function summarizeOfferFeedError(err) {
    var data = err && err.data && typeof err.data === "object" ? err.data : null;
    var pendingLookup = data && data.pending_lookup && typeof data.pending_lookup === "object"
      ? data.pending_lookup
      : null;
    var raw = safeStr(
      (pendingLookup && pendingLookup.error) ||
      (data && (data.reason || data.error)) ||
      (err && err.message) ||
      ""
    );
    if (!raw) return "Offer feed unavailable";
    if (
      /logged in user/i.test(raw) ||
      /impersonate another franchise/i.test(raw) ||
      /missing mfl owner session/i.test(raw)
    ) {
      return "Offer feed needs your owner session. Refresh the page and try again.";
    }
    return raw.length > 140 ? (raw.slice(0, 137) + "...") : raw;
  }

  async function refreshBannerOffers(force) {
    var meta = state.data && state.data.meta ? state.data.meta : {};
    var leagueCtx = getLeagueContext();
    var leagueId = safeStr(meta.league_id) || leagueCtx.leagueId;
    var season = safeStr(meta.season) || leagueCtx.season;
    var franchiseId = getActiveFranchiseId();
    if (!leagueId || !season || !franchiseId) {
      state.offers.offered = [];
      state.offers.received = [];
      state.offers.error = "";
      state.offers.key = "";
      renderBannerOffers();
      return;
    }

    var key = [leagueId, season, franchiseId].join("|");
    if (!force && state.offers.key === key) {
      renderBannerOffers();
      return;
    }

    state.offers.busy = true;
    state.offers.error = "";
    renderBannerOffers();

    try {
      var offerUrl = new URL(resolveTradeOffersApiUrl(), window.location.href);
      offerUrl.searchParams.set("L", leagueId);
      offerUrl.searchParams.set("YEAR", season);
      offerUrl.searchParams.set("FRANCHISE_ID", franchiseId);
      offerUrl.searchParams.set("acting_franchise_id", franchiseId);
      offerUrl.searchParams.set("status", "PENDING");
      offerUrl.searchParams.set("include_payload", "1");
      offerUrl.searchParams.set("limit", "300");
      var res = await fetchJsonRequest(offerUrl.toString());
      state.offers.offered = normalizeOffersForBanner(res && res.outgoing);
      state.offers.received = normalizeOffersForBanner(res && res.incoming);
      state.offers.key = key;
    } catch (err) {
      state.offers.offered = [];
      state.offers.received = [];
      state.offers.error = summarizeOfferFeedError(err);
      state.offers.key = "";
    } finally {
      state.offers.busy = false;
      renderBannerOffers();
      scheduleParentHeightPost();
    }
  }

  function getOfferFromBannerState(bucket, offerId) {
    var list = bucket === "offered" ? state.offers.offered : state.offers.received;
    list = Array.isArray(list) ? list : [];
    var i;
    for (i = 0; i < list.length; i += 1) {
      if (safeStr(list[i] && list[i].id) === safeStr(offerId)) return list[i];
    }
    return null;
  }

  async function fetchJsonRequest(url, options) {
    var res = await fetch(url, options || {});
    var text = await res.text();
    var data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      data = null;
    }
    if (!res.ok) {
      var textSummary = safeStr(text)
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .slice(0, 220);
      var errMsg = (data && (data.error || data.reason)) ||
        (textSummary ? ("HTTP " + res.status + ": " + textSummary) : ("HTTP " + res.status));
      var err = new Error(errMsg);
      err.status = res.status;
      err.data = data;
      err.responseText = text;
      throw err;
    }
    return data;
  }

  async function replayOutbox(criteria) {
    var body = criteria && typeof criteria === "object" ? clone(criteria) : {};
    if (!safeStr(body.league_id) && state.data && state.data.meta) body.league_id = safeStr(state.data.meta.league_id);
    if (!safeStr(body.season) && state.data && state.data.meta) body.season = safeStr(state.data.meta.season);
    var replayUrl = resolveTradeOutboxReplayApiUrl();
    return fetchJsonRequest(replayUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  }

  function setSubmitStatus(message, tone) {
    state.submit.message = safeStr(message) || "";
    state.submit.tone = safeStr(tone) || "";
  }

  function closeFeedbackModal() {
    if (!els.feedbackModal) return;
    if (typeof els.feedbackModal.close === "function") {
      try {
        els.feedbackModal.close();
      } catch (e) {
        // noop
      }
    } else {
      els.feedbackModal.removeAttribute("open");
    }
  }

  function showFeedbackModal(title, message, tone) {
    if (!els.feedbackModal || !els.feedbackModalMessage || !els.feedbackModalTitle) return;
    els.feedbackModalTitle.textContent = safeStr(title) || "Trade Update";
    els.feedbackModalMessage.textContent = safeStr(message) || "";
    var shell = els.feedbackModalShell;
    if (shell) {
      shell.classList.remove("is-good", "is-bad", "is-warn");
      var safeTone = safeStr(tone);
      if (safeTone) shell.classList.add("is-" + safeTone);
    }
    if (typeof els.feedbackModal.showModal === "function") {
      try {
        els.feedbackModal.showModal();
        return;
      } catch (e) {
        // noop
      }
    }
    els.feedbackModal.setAttribute("open", "open");
  }

  function setAcceptDebug(debugObj) {
    state.submit.acceptDebug = debugObj && typeof debugObj === "object" ? debugObj : null;
  }

  function friendlyOfferError(prefix, err) {
    var msg = err && err.message ? String(err.message) : String(err);
    var data = err && err.data && typeof err.data === "object" ? err.data : null;
    var errorType = safeStr(data && data.error_type).toLowerCase();
    if (errorType === "trade_proposal_import_failed") {
      var diag = data && data.diagnostics ? data.diagnostics : {};
      var mflResp = diag && diag.mfl_response ? diag.mfl_response : {};
      var reason = safeStr(data.reason || mflResp.reason_snippet || msg || "MFL rejected the proposal");
      var httpStatus = safeInt(mflResp.http_status || data.upstreamStatus || err.status, 0);
      var ts = safeStr(diag.timestamp_utc || data.timestamp_utc);
      var out = prefix + ": Trade proposal rejected by MFL.";
      if (reason) out += " Reason: " + reason;
      if (httpStatus) out += " (HTTP " + httpStatus + (ts ? " @ " + ts : "") + ")";
      return out;
    }
    if (errorType === "validation_pre_post") {
      var valReason = safeStr(
        (data && data.diagnostics && data.diagnostics.reason) ||
        data.reason ||
        msg
      );
      if (valReason === "invalid_trade_assets_for_mfl") {
        return prefix + ": Remove ineligible trade assets before submitting.";
      }
      if (valReason === "trade_payload_not_ready") {
        return prefix + ": Trade payload is not ready to submit.";
      }
      return prefix + ": Validation failed before POST: " + valReason;
    }
    if (errorType === "salary_contract_import_failure") {
      var details = data && data.diagnostics ? data.diagnostics : {};
      var ts2 = safeStr(details.timestamp_utc || data.timestamp_utc);
      var extReason = safeStr((details.extensions || {}).reason);
      var salaryReason = safeStr((details.salary_adjustments || {}).error);
      var reason2 = safeStr(msg || data.error || "salary/contract import failure");
      var detail = extReason || salaryReason;
      if ((extReason + " " + salaryReason).toLowerCase().indexOf("requires_commish_cookie") !== -1) {
        return prefix + ": Commissioner MFL cookie is required for salary adjustments/extensions.";
      }
      return prefix + ": Salary/contract import failure after trade response: " +
        reason2 +
        (detail ? " (" + detail + ")" : "") +
        (ts2 ? " @ " + ts2 : "");
    }
    if (/bad credentials/i.test(msg)) {
      return prefix + ": invalid GITHUB_PAT worker secret (GitHub returned Bad credentials).";
    }
    if (/missing github_pat/i.test(msg)) {
      return prefix + ": Missing GITHUB_PAT worker secret.";
    }
    if (/missing mfl_cookie/i.test(msg)) {
      return prefix + ": Missing MFL_COOKIE worker secret.";
    }
    return prefix + ": " + msg;
  }

  function extensionYearsCount(termRaw) {
    var term = safeStr(termRaw).toUpperCase();
    var m = term.match(/(\d+)/);
    return m ? safeInt(m[1], 0) : 0;
  }

  function dollarsToKInt(v) {
    if (v == null) return null;
    return Math.round(safeInt(v, 0) / 1000);
  }

  function buildExtensionSummaryLines(payload) {
    var out = [];
    var extReqs = Array.isArray((payload || {}).extension_requests) ? payload.extension_requests : [];
    var i;
    for (i = 0; i < extReqs.length; i += 1) {
      var req = extReqs[i] || {};
      var years = extensionYearsCount(req.extension_term || req.option_key || "");
      if (!years) years = 1;
      var newLen = req.new_contract_length == null ? "—" : String(safeInt(req.new_contract_length, 0));
      var aavK = dollarsToKInt(req.new_aav_future);
      var tcvK = dollarsToKInt(req.new_TCV);
      var player = safeStr(req.player_name || "Player");
      out.push(
        "Pre-trade extension: Extend " +
          player +
          " " +
          years +
          "-year | New length " +
          newLen +
          " | New AAV " +
          (aavK == null ? "—" : String(aavK) + "K") +
          " | New TCV " +
          (tcvK == null ? "—" : String(tcvK) + "K")
      );
    }
    return out;
  }

  function composeTradeMessage(userComment, extensionLines) {
    var user = safeStr(userComment);
    var lines = Array.isArray(extensionLines) ? extensionLines.filter(function (v) { return !!safeStr(v); }) : [];
    if (user && lines.length) return lines.join("\n") + "\n\n" + user;
    if (user) return user;
    return lines.join("\n");
  }

  async function submitOfferToQueue() {
    if (state.submit.busy) return;
    setAcceptDebug(null);
    var payload = buildTradePayload();
    var leftTeam = getTeamById(state.leftTeamId);
    var rightTeam = getTeamById(state.rightTeamId);
    var activeFranchiseId = getActiveFranchiseId();
    if (activeFranchiseId && state.leftTeamId !== activeFranchiseId && getTeamById(activeFranchiseId)) {
      state.leftTeamId = activeFranchiseId;
      leftTeam = getTeamById(state.leftTeamId);
      if (state.rightTeamId === state.leftTeamId) state.rightTeamId = "";
      rightTeam = getTeamById(state.rightTeamId);
      payload = buildTradePayload();
    }
    if (!payload.validation || payload.validation.status !== "ready") {
      setSubmitStatus("Trade is not ready. Select assets on both sides and keep traded salary within max.", "warn");
      renderSummary();
      return;
    }
    if (!leftTeam || !rightTeam) {
      setSubmitStatus("Select both teams before submitting.", "warn");
      renderSummary();
      return;
    }

    state.submit.busy = true;
    setSubmitStatus("Submitting offer to MFL…", "");
    renderSummary();

    try {
      var userMessage = els.offerMessageInput ? safeStr(els.offerMessageInput.value).slice(0, 2000) : "";
      var extensionLines = buildExtensionSummaryLines(payload);
      var finalMessage = composeTradeMessage(userMessage, extensionLines);
      payload.comment = finalMessage;
      console.log("[TWB] Final message sent to MFL:", finalMessage);
      var apiUrl = new URL(resolveTradeOffersApiUrl(), window.location.href);
      var body = {
        league_id: safeStr(state.data.meta.league_id),
        season: state.data.meta.season || null,
        from_franchise_id: safeStr(activeFranchiseId || state.leftTeamId),
        to_franchise_id: safeStr(state.rightTeamId),
        from_franchise_name: leftTeam.franchise_name,
        to_franchise_name: rightTeam.franchise_name,
        message: finalMessage,
        comment: finalMessage,
        payload: payload,
        source: "trade-workbench-ui",
        direct_mfl: true,
        submit_mode: "mfl"
      };
      state.submit.lastRequestBody = body;
      state.submit.lastRequestUrl = apiUrl.toString();
      state.submit.canRetry = false;
      console.log("[TWB] Submit payload summary:", {
        from_franchise_id: body.from_franchise_id,
        to_franchise_id: body.to_franchise_id,
        left_asset_count: (payload.teams && payload.teams[0] && payload.teams[0].selected_assets || []).length,
        right_asset_count: (payload.teams && payload.teams[1] && payload.teams[1].selected_assets || []).length,
        left_trade_salary_k: payload.teams && payload.teams[0] ? safeInt(payload.teams[0].traded_salary_adjustment_k, 0) : 0,
        right_trade_salary_k: payload.teams && payload.teams[1] ? safeInt(payload.teams[1].traded_salary_adjustment_k, 0) : 0
      });
      var res = await fetchJsonRequest(apiUrl.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      var echoedMessage = safeStr(
        (res && res.proposal && res.proposal.comments) ||
        (res && res.offer && res.offer.message) ||
        (res && res.comment) ||
        (res && res.message)
      );
      console.log("[TWB] Submit response message echo:", echoedMessage);
      if (finalMessage && (!echoedMessage || echoedMessage.indexOf(finalMessage) === -1)) {
        console.error("[TWB] Comment verification failed. MFL echo did not contain the submitted message.", {
          sent: finalMessage,
          echoed: echoedMessage,
          response: res
        });
      }
      var mflTradeId = safeStr((res.mfl || {}).trade_id);
      resetTrade({
        resetPartnerTeam: true,
        resetMessage: true,
        resetExtensions: true,
        resetSalary: true
      });
      state.submit.lastRequestBody = null;
      state.submit.lastRequestUrl = "";
      state.submit.canRetry = false;
      var outbox = res && res.outbox ? res.outbox : {};
      var outboxId = safeStr(outbox.outbox_id);
      var outboxHash = safeStr(outbox.payload_hash);
      var outboxStatus = safeStr(outbox.status);
      var outboxText = "";
      if (outboxId || outboxHash) {
        outboxText =
          " Outbox: " +
          [outboxStatus, outboxId ? ("id " + outboxId) : "", outboxHash ? ("hash " + outboxHash.slice(0, 10)) : ""]
            .filter(Boolean)
            .join(" · ");
      }
      var submitOkMessage = "Offer submitted to MFL" + (mflTradeId ? " (Trade ID " + mflTradeId + ")." : ".") + outboxText;
      setSubmitStatus(submitOkMessage, "good");
      showFeedbackModal("Offer Submitted", submitOkMessage, "good");
      initTeamSelectors();
      await refreshBannerOffers(true);
      rerender();
    } catch (err) {
      try {
        console.error("[TWB] Submit failed diagnostics:", {
          message: err && err.message,
          status: err && err.status,
          data: err && err.data,
          responseText: err && err.responseText
        });
      } catch (e) {
        // noop
      }
      setSubmitStatus(friendlyOfferError("Submit failed", err), "bad");
      state.submit.canRetry = !!state.submit.lastRequestBody;
    } finally {
      state.submit.busy = false;
      renderSummary();
    }
  }

  async function retryLastSubmitRequest() {
    if (state.submit.busy) return;
    setAcceptDebug(null);
    if (!state.submit.lastRequestBody || !state.submit.lastRequestUrl) {
      submitOfferToQueue();
      return;
    }

    state.submit.busy = true;
    setSubmitStatus("Retrying submit to MFL…", "");
    renderSummary();
    try {
      var body = state.submit.lastRequestBody;
      var res = await fetchJsonRequest(state.submit.lastRequestUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      var sentMessage = safeStr(body.comment || body.message);
      var echoedMessage = safeStr(
        (res && res.proposal && res.proposal.comments) ||
        (res && res.offer && res.offer.message) ||
        (res && res.comment) ||
        (res && res.message)
      );
      console.log("[TWB] Retry response message echo:", echoedMessage);
      if (sentMessage && (!echoedMessage || echoedMessage.indexOf(sentMessage) === -1)) {
        console.error("[TWB] Retry comment verification failed.", {
          sent: sentMessage,
          echoed: echoedMessage,
          response: res
        });
      }
      var mflTradeId = safeStr((res.mfl || {}).trade_id);
      resetTrade({
        resetPartnerTeam: true,
        resetMessage: true,
        resetExtensions: true,
        resetSalary: true
      });
      state.submit.lastRequestBody = null;
      state.submit.lastRequestUrl = "";
      state.submit.canRetry = false;
      var retryOkMessage = "Offer submitted to MFL" + (mflTradeId ? " (Trade ID " + mflTradeId + ")." : ".");
      setSubmitStatus(retryOkMessage, "good");
      showFeedbackModal("Offer Submitted", retryOkMessage, "good");
      initTeamSelectors();
      await refreshBannerOffers(true);
      rerender();
    } catch (err) {
      try {
        console.error("[TWB] Retry failed diagnostics:", {
          message: err && err.message,
          status: err && err.status,
          data: err && err.data,
          responseText: err && err.responseText
        });
      } catch (e) {
        // noop
      }
      setSubmitStatus(friendlyOfferError("Submit failed", err), "bad");
      state.submit.canRetry = !!state.submit.lastRequestBody;
    } finally {
      state.submit.busy = false;
      renderSummary();
    }
  }

  function runPrimarySubmitAction() {
    var payload = buildTradePayload();
    var intent = getPrimarySubmitIntent(payload);
    if (intent.mode === "accept" || intent.mode === "revoke") {
      runReviewContextAction(intent.mode);
      return;
    }
    submitOfferToQueue();
  }

  function promoteCurrentReviewToCounterDraft() {
    var ctx = state.reviewContext || {};
    var bucket = safeStr(ctx.offerBucket) || "received";
    var offer = ctx.offer || getOfferFromBannerState(bucket, ctx.offerId);
    if (!offer) {
      setSubmitStatus("Offer no longer available in MFL.", "warn");
      renderSummary();
      return;
    }
    state.counterMode = true;
    state.counterSourceOffer = offer;
    setReviewContext("counter", {
      offer: offer,
      offerBucket: bucket,
      tradeId: safeStr(ctx.tradeId || getOfferTradeId(offer))
    });
    resetSubmitUiState("Counter Offer Draft loaded.", "");
    moveToOfferReview();
    rerender();
  }

  function runReviewContextAction(mode) {
    var normalizedMode = safeStr(mode).toLowerCase();
    if (!normalizedMode) return;
    if (normalizedMode === "counter") {
      promoteCurrentReviewToCounterDraft();
      return;
    }

    var ctx = state.reviewContext || {};
    var bucket = safeStr(ctx.offerBucket) || (normalizedMode === "revoke" ? "offered" : "received");
    var offer = ctx.offer || getOfferFromBannerState(bucket, ctx.offerId);
    if (!offer) {
      setSubmitStatus("Offer no longer available in MFL.", "warn");
      renderSummary();
      return;
    }

    var action = normalizedMode === "accept"
      ? "ACCEPT"
      : normalizedMode === "reject"
        ? "REJECT"
        : normalizedMode === "revoke"
          ? "REVOKE"
          : "";
    if (!action) return;
    performOfferAction(action, {
      bucket: bucket,
      offer: offer
    });
  }


  function getTeamById(teamId) {
    var teams = (state.data && state.data.teams) || [];
    var i;
    for (i = 0; i < teams.length; i += 1) {
      if (teams[i].franchise_id === teamId) return teams[i];
    }
    return null;
  }

  function getAssetById(teamId, assetId) {
    var team = getTeamById(teamId);
    if (!team) return null;
    var assets = team.assets || [];
    var i;
    for (i = 0; i < assets.length; i += 1) {
      if (assets[i].asset_id === assetId) return assets[i];
    }
    return null;
  }

  function getOtherTeamId(teamId) {
    if (teamId === state.leftTeamId) return state.rightTeamId;
    if (teamId === state.rightTeamId) return state.leftTeamId;
    return "";
  }

  function isCommissionerLockoutOff() {
    var lockout = safeStr(state.data && state.data.meta ? state.data.meta.commissioner_lockout : "").toUpperCase();
    return lockout === "N";
  }

  function getActiveFranchiseId() {
    var teams = (state.data && state.data.teams) || [];
    var active = pad4(state.activeFranchiseId);
    if (active && getTeamById(active)) return active;
    active = pad4(state.leftTeamId);
    if (active && getTeamById(active)) return active;

    var meta = (state.data && state.data.meta) || {};
    var candidates = [
      meta.active_franchise_id,
      meta.default_franchise_id,
      meta.logged_in_franchise_id
    ];
    var i;
    for (i = 0; i < candidates.length; i += 1) {
      var id = pad4(candidates[i]);
      if (id && getTeamById(id)) return id;
    }
    return teams[0] ? teams[0].franchise_id : "";
  }

  function setActiveFranchiseId(teamId, opts) {
    opts = opts || {};
    var id = pad4(teamId);
    if (!id || !getTeamById(id)) return false;
    state.activeFranchiseId = id;
    if (opts.syncLeft !== false) {
      state.leftTeamId = id;
      if (state.rightTeamId === id) state.rightTeamId = "";
    }
    state.offers.key = "";
    return true;
  }

  function getLockedLeftTeamId() {
    if (isCommissionerLockoutOff()) return "";
    var meta = (state.data && state.data.meta) || {};
    var loggedIn = pad4(meta.logged_in_franchise_id || "");
    if (loggedIn && getTeamById(loggedIn)) return loggedIn;
    if (!loggedIn) return "";
    var teams = (state.data && state.data.teams) || [];
    var i;
    for (i = 0; i < teams.length; i += 1) {
      if (teams[i] && teams[i].is_default) return teams[i].franchise_id;
    }
    return "";
  }

  function ensureSelectionMaps(teamId) {
    if (!state.selections[teamId]) state.selections[teamId] = {};
    if (!state.extensions[teamId]) state.extensions[teamId] = {};
    if (!state.collapsed[teamId]) state.collapsed[teamId] = {};
    if (state.tradeSalaryK[teamId] == null) state.tradeSalaryK[teamId] = "";
  }

  function restoreState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return;

      if (parsed.filters && typeof parsed.filters === "object") {
        state.filters = Object.assign(state.filters, parsed.filters);
        if (state.filters.activePositions) delete state.filters.activePositions;
        if (state.filters.activeContractTypes) delete state.filters.activeContractTypes;
        if (state.filters.yearsMin) delete state.filters.yearsMin;
        if (state.filters.yearsMax) delete state.filters.yearsMax;
        if (state.filters.showTaxi != null) delete state.filters.showTaxi;
        if (state.filters.showPicks != null) delete state.filters.showPicks;
        if (state.filters.onlyExtensionEligible != null) delete state.filters.onlyExtensionEligible;
      }
      state.selections = parsed.selections && typeof parsed.selections === "object" ? parsed.selections : state.selections;
      state.extensions = parsed.extensions && typeof parsed.extensions === "object" ? parsed.extensions : state.extensions;
      state.tradeSalaryK = parsed.tradeSalaryK && typeof parsed.tradeSalaryK === "object" ? parsed.tradeSalaryK : state.tradeSalaryK;
      state.assetView = parsed.assetView && typeof parsed.assetView === "object" ? parsed.assetView : state.assetView;
      state.collapsed = parsed.collapsed && typeof parsed.collapsed === "object" ? parsed.collapsed : state.collapsed;
      state.activeFranchiseId = safeStr(parsed.activeFranchiseId);
      if (!state.activeFranchiseId) {
        state.activeFranchiseId = safeStr(localStorage.getItem("twb_active_franchise_id"));
      }
      state.leftTeamId = safeStr(parsed.leftTeamId);
      state.rightTeamId = safeStr(parsed.rightTeamId);
      state.mobileTab = safeStr(parsed.mobileTab) || state.mobileTab;
    } catch (e) {
      // ignore corrupt state
    }
  }

  function persistState() {
    if (!state.uiReady) return;
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          activeFranchiseId: state.activeFranchiseId,
          leftTeamId: state.leftTeamId,
          rightTeamId: state.rightTeamId,
          selections: state.selections,
          extensions: state.extensions,
          tradeSalaryK: state.tradeSalaryK,
          assetView: state.assetView,
          collapsed: state.collapsed,
          filters: state.filters,
          mobileTab: state.mobileTab
        })
      );
      localStorage.setItem("twb_active_franchise_id", safeStr(state.activeFranchiseId));
    } catch (e) {
      // ignore quota errors
    }
  }

  function clampTradeSalaryForTeam(teamId) {
    ensureSelectionMaps(teamId);
    var maxK = getTradeSalaryMaxK(teamId);
    var raw = safeStr(state.tradeSalaryK[teamId]).replace(/[^0-9]/g, "");
    if (!raw) {
      state.tradeSalaryK[teamId] = "";
      return;
    }
    var value = safeInt(raw, 0);
    if (value > maxK) value = maxK;
    state.tradeSalaryK[teamId] = String(value);
  }

  function assetHasActiveCurrentContract(asset) {
    return !!(
      asset &&
      safeStr(asset.type).toUpperCase() === "PLAYER" &&
      !asset.taxi &&
      safeInt(asset.years, 0) > 0
    );
  }

  function assetCountsAsCurrentIr(asset) {
    var status = safeStr(asset && (asset.roster_status || asset.injury)).toUpperCase();
    if (!status) return false;
    return status.indexOf("INJURED") !== -1 || status.indexOf("_IR") !== -1 || status === "IR";
  }

  function getAssetTradeSalaryBasisDollars(asset) {
    if (!assetHasActiveCurrentContract(asset)) return 0;
    return safeInt(asset.salary, 0);
  }

  function getAssetCurrentCapHitDollars(asset) {
    if (!assetHasActiveCurrentContract(asset)) return 0;
    var salary = safeInt(asset.salary, 0);
    if (salary <= 0) return 0;
    if (assetCountsAsCurrentIr(asset)) return Math.round(salary * 0.5);
    return salary;
  }

  function getAssetCapSalaryDollars(asset) {
    return getAssetCurrentCapHitDollars(asset);
  }

  function getTeamTotals(teamId) {
    ensureSelectionMaps(teamId);
    var team = getTeamById(teamId);
    var out = {
      selectedCount: 0,
      selectedPlayers: 0,
      selectedPicks: 0,
      selectedTaxiPlayers: 0,
      selectedNonTaxiSalary: 0,
      selectedCapSalary: 0,
      selectedVisibleCount: 0
    };
    if (!team) return out;

    var selectedMap = state.selections[teamId] || {};
    var assets = team.assets || [];
    var i;
    for (i = 0; i < assets.length; i += 1) {
      var a = assets[i];
      if (!selectedMap[a.asset_id]) continue;
      if (!isTradeEligibleAsset(a)) {
        delete selectedMap[a.asset_id];
        continue;
      }
      out.selectedCount += 1;
      if (a.type === "PICK") {
        out.selectedPicks += 1;
        continue;
      }
      out.selectedPlayers += 1;
      if (a.taxi) {
        out.selectedTaxiPlayers += 1;
      }
      out.selectedNonTaxiSalary += getAssetTradeSalaryBasisDollars(a);
      out.selectedCapSalary += getAssetCapSalaryDollars(a);
    }
    return out;
  }

  function getTradeSalaryMaxK(teamId) {
    var totals = getTeamTotals(teamId);
    return Math.floor(safeInt(totals.selectedNonTaxiSalary, 0) / 2000);
  }

  function getNetTradeSalaryK(teamId) {
    var thisEntered = safeInt(state.tradeSalaryK[teamId], 0);
    var otherId = getOtherTeamId(teamId);
    if (!otherId) return thisEntered;
    var otherEntered = safeInt(state.tradeSalaryK[otherId], 0);
    return thisEntered - otherEntered;
  }

  function assetMatchesFilters(asset) {
    var f = state.filters;
    if (!asset) return false;

    var search = safeStr(f.search).toLowerCase();
    if (search && asset.search_text.indexOf(search) === -1) return false;

    return true;
  }

  function getAssetView(teamId) {
    var view = safeStr(state.assetView && state.assetView[teamId]).toLowerCase();
    if (view === "picks") return view;
    return "players";
  }

  function setAssetView(teamId, view) {
    if (!teamId) return;
    var normalized = safeStr(view).toLowerCase();
    if (normalized !== "picks") normalized = "players";
    if (!state.assetView || typeof state.assetView !== "object") state.assetView = {};
    state.assetView[teamId] = normalized;
  }

  function getVisibleAssetsForTeam(teamId) {
    var team = getTeamById(teamId);
    if (!team) return [];
    var assets = team.assets || [];
    var view = getAssetView(teamId);
    var out = [];
    var i;
    for (i = 0; i < assets.length; i += 1) {
      var asset = assets[i];
      if (!isTradeEligibleAsset(asset)) continue;
      if (view === "picks") {
        if (asset.type === "PICK" && assetMatchesFilters(asset)) out.push(asset);
        continue;
      }
      if (view === "players" && asset.type === "PICK") continue;
      if (assetMatchesFilters(asset)) out.push(asset);
    }
    return out;
  }

  function groupAssets(assets) {
    var groups = {};
    var i;
    for (i = 0; i < assets.length; i += 1) {
      var a = assets[i];
      var key = assetGroupKey(a);
      if (!groups[key]) groups[key] = [];
      groups[key].push(a);
    }

    var groupKeys = Object.keys(groups);
    groupKeys.sort(function (a, b) {
      var av = groupSortValue(a);
      var bv = groupSortValue(b);
      if (av !== bv) return av - bv;
      return compareText(a, b);
    });

    var out = [];
    for (i = 0; i < groupKeys.length; i += 1) {
      var gk = groupKeys[i];
      groups[gk].sort(function (x, y) {
        if (x.type !== y.type) return x.type === "PLAYER" ? -1 : 1;
        if (x.type === "PICK") return compareText(x.description, y.description);
        var posCmp = compareText(x.position, y.position);
        if (posCmp) return posCmp;
        return compareText(x.player_name, y.player_name);
      });
      out.push({ key: gk, label: gk === "PICKS" ? "Draft Picks" : gk, assets: groups[gk] });
    }
    return out;
  }

  function optionEl(value, label) {
    var opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    return opt;
  }

  function initTeamSelectors() {
    var left = els.leftTeamSelect;
    var right = els.rightTeamSelect;
    if (!left || !right || !state.data) return;

    left.innerHTML = "";
    right.innerHTML = "";
    var teams = state.data.teams || [];
    var lockedLeftId = getLockedLeftTeamId();
    var activeId = getActiveFranchiseId();
    var leftTeam = null;
    var i;
    if (lockedLeftId) {
      setActiveFranchiseId(lockedLeftId, { syncLeft: true });
      leftTeam = getTeamById(lockedLeftId);
      left.appendChild(optionEl(lockedLeftId, leftTeam ? leftTeam.franchise_name : lockedLeftId));
      left.disabled = true;
    } else {
      left.disabled = false;
      for (i = 0; i < teams.length; i += 1) {
        left.appendChild(optionEl(teams[i].franchise_id, teams[i].franchise_name));
      }
      if (!activeId || !getTeamById(activeId)) {
        activeId = state.leftTeamId && getTeamById(state.leftTeamId)
          ? state.leftTeamId
          : (teams[0] ? teams[0].franchise_id : "");
      }
      setActiveFranchiseId(activeId, { syncLeft: true });
    }

    right.appendChild(optionEl("", "Select Team..."));
    for (i = 0; i < teams.length; i += 1) {
      var t = teams[i];
      if (t.franchise_id === state.leftTeamId) continue;
      right.appendChild(optionEl(t.franchise_id, t.franchise_name));
    }

    if (!state.rightTeamId || !getTeamById(state.rightTeamId) || state.rightTeamId === state.leftTeamId) {
      state.rightTeamId = "";
    }

    left.value = state.leftTeamId;
    right.value = state.rightTeamId;
  }

  function initializeControlsFromState() {
    els.searchInput.value = safeStr(state.filters.search);
    initTeamSelectors();
  }

  function syncControlsLightweight() {
    if (els.leftTeamSelect) els.leftTeamSelect.value = state.leftTeamId;
    if (els.rightTeamSelect) els.rightTeamSelect.value = state.rightTeamId;
    if (els.searchInput && els.searchInput.value !== safeStr(state.filters.search)) {
      els.searchInput.value = safeStr(state.filters.search);
    }
  }

  function renderBoard() {
    var boardLeft = els.board;
    var boardRight = els.partnerBoard;
    if (boardLeft) boardLeft.innerHTML = "";
    if (boardRight) boardRight.innerHTML = "";

    var leftTeam = getTeamById(state.leftTeamId);
    var rightTeam = getTeamById(state.rightTeamId);
    if (!leftTeam) {
      var empty = document.createElement("div");
      empty.className = "twb-empty-state";
      empty.textContent = "Select your team to begin building a trade.";
      if (boardLeft) boardLeft.appendChild(empty);
      if (boardRight) boardRight.appendChild(empty.cloneNode(true));
      return;
    }

    if (boardLeft) boardLeft.appendChild(renderTeamPanel(leftTeam, "left"));
    if (!boardRight) return;
    if (rightTeam) boardRight.appendChild(renderTeamPanel(rightTeam, "right"));
    else boardRight.appendChild(renderDiscoveryPanel(leftTeam));
  }

  function collectDiscoverableMatches(leftTeamId) {
    var out = [];
    var teams = (state.data && state.data.teams) || [];
    var i;
    for (i = 0; i < teams.length; i += 1) {
      var team = teams[i];
      if (!team || team.franchise_id === leftTeamId) continue;
      var assets = team.assets || [];
      var j;
      for (j = 0; j < assets.length; j += 1) {
        var a = assets[j];
        if (!a || !isTradeEligibleAsset(a)) continue;
        if (!assetMatchesFilters(a, team.franchise_id)) continue;
        out.push({ team: team, asset: a });
      }
    }
    out.sort(function (x, y) {
      var tCmp = compareText(x.team.franchise_name, y.team.franchise_name);
      if (tCmp) return tCmp;
      if (x.asset.type !== y.asset.type) return x.asset.type === "PLAYER" ? -1 : 1;
      if (x.asset.type === "PLAYER") return compareText(x.asset.player_name, y.asset.player_name);
      return compareText(x.asset.description, y.asset.description);
    });
    return out;
  }

  function renderDiscoveryPanel(leftTeam) {
    var searchVal = safeStr(state.filters.search);
    if (!searchVal) {
      var empty = document.createElement("div");
      empty.className = "twb-empty-state";
      empty.textContent = "Select a trade partner to view assets.";
      return empty;
    }

    var panel = document.createElement("section");
    panel.className = "twb-team-panel twb-card twb-discovery-panel";

    var helper = document.createElement("div");
    helper.className = "twb-summary-note";
    var matches = collectDiscoverableMatches(leftTeam.franchise_id);
    if (!matches.length) {
      helper.textContent = "No matching assets found across other teams for this search/filter.";
      panel.appendChild(helper);
      return panel;
    }

    var cap = 120;
    var shown = matches.slice(0, cap);
    helper.textContent =
      "Search results across all teams: " + shown.length + (matches.length > cap ? " of " + matches.length : "") +
      ". Click one to set the trade partner and add it to the offer.";
    panel.appendChild(helper);

    var list = document.createElement("div");
    list.className = "twb-discovery-list";
    var i;
    for (i = 0; i < shown.length; i += 1) {
      var m = shown[i];
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "twb-discovery-item";
      btn.setAttribute("data-action", "choose-discovery-match");
      btn.setAttribute("data-team-id", m.team.franchise_id);
      btn.setAttribute("data-asset-id", m.asset.asset_id);

      var title = m.asset.type === "PLAYER"
        ? buildPlayerLabel(m.asset)
        : safeStr(m.asset.pick_display || m.asset.description || "Rookie Pick");
      var meta = m.team.franchise_name + " · " +
        (m.asset.type === "PLAYER"
          ? moneyFmt(m.asset.salary) + " · Yrs " + (m.asset.years == null ? "-" : m.asset.years)
          : "Draft Pick");
      btn.innerHTML = '<span class="twb-discovery-item-title">' + escapeHtml(title) + '</span>' +
        '<span class="twb-discovery-item-meta">' + escapeHtml(meta) + "</span>";
      list.appendChild(btn);
    }
    panel.appendChild(list);
    return panel;
  }

  function renderTeamPanel(team, side) {
    ensureSelectionMaps(team.franchise_id);
    clampTradeSalaryForTeam(team.franchise_id);

    var tpl = q("twbTeamPanelTemplate");
    var node = tpl.content.firstElementChild.cloneNode(true);
    node.setAttribute("data-team-id", team.franchise_id);
    node.setAttribute("data-side", side);

    var logo = node.querySelector(".twb-team-logo");
    var logoFallback = node.querySelector(".twb-team-logo-fallback");
    var logoShell = node.querySelector(".twb-team-logo-shell");
    var teamNameA11y = node.querySelector(".twb-team-name-a11y");
    var assetToggle = node.querySelector(".twb-asset-toggle");
    var groupsWrap = node.querySelector(".twb-team-groups");
    var salaryInput = node.querySelector(".twb-trade-salary-input");
    var salaryMaxValue = node.querySelector(".twb-trade-salary-max-value");

    if (teamNameA11y) teamNameA11y.textContent = team.franchise_name;
    if (logoShell) logoShell.setAttribute("aria-label", team.franchise_name);

    if (logoFallback) {
      logoFallback.textContent = "No Logo";
    }
    if (logo && safeStr(team.icon_url)) {
      logo.src = safeStr(team.icon_url);
      logo.alt = team.franchise_name + " logo";
      logo.loading = "lazy";
      logo.referrerPolicy = "no-referrer";
      logo.hidden = false;
      logo.addEventListener("error", function () {
        this.hidden = true;
        if (logoShell) logoShell.classList.add("twb-team-logo-missing");
      }, { once: true });
      logo.addEventListener("load", function () {
        this.hidden = false;
        if (logoShell) logoShell.classList.remove("twb-team-logo-missing");
      }, { once: true });
    } else if (logo) {
      logo.removeAttribute("src");
      logo.hidden = true;
      if (logoShell) logoShell.classList.add("twb-team-logo-missing");
    }

    salaryInput.value = safeStr(state.tradeSalaryK[team.franchise_id]);
    salaryInput.setAttribute("data-action", "set-trade-salary");
    salaryInput.setAttribute("data-team-id", team.franchise_id);
    salaryInput.setAttribute("max", String(getTradeSalaryMaxK(team.franchise_id)));

    var maxK = getTradeSalaryMaxK(team.franchise_id);
    if (salaryMaxValue) salaryMaxValue.textContent = String(maxK) + "K";

    bindAssetViewToggle(assetToggle, team.franchise_id);
    bindTeamToolbarButtons(node, team.franchise_id);

    var currentView = getAssetView(team.franchise_id);
    var visibleAssets = getVisibleAssetsForTeam(team.franchise_id);
    if (!visibleAssets.length) {
      var empty = document.createElement("div");
      empty.className = "twb-empty-state";
      if (currentView === "picks") {
        empty.textContent = "No draft picks match your search.";
      } else {
        empty.textContent = "No assets match your search.";
      }
      groupsWrap.appendChild(empty);
      return node;
    }

    var grouped = groupAssets(visibleAssets);
    var i;
    for (i = 0; i < grouped.length; i += 1) {
      groupsWrap.appendChild(renderAssetGroup(team, grouped[i]));
    }

    return node;
  }

  function bindTeamToolbarButtons(panel, teamId) {
    var expandAll = panel.querySelector(".twb-team-expand-all");
    var collapseAll = panel.querySelector(".twb-team-collapse-all");

    if (expandAll) {
      expandAll.setAttribute("data-action", "team-expand-all");
      expandAll.setAttribute("data-team-id", teamId);
    }
    if (collapseAll) {
      collapseAll.setAttribute("data-action", "team-collapse-all");
      collapseAll.setAttribute("data-team-id", teamId);
    }
  }

  function bindAssetViewToggle(toggleWrap, teamId) {
    if (!toggleWrap || !toggleWrap.querySelectorAll) return;
    var currentView = getAssetView(teamId);
    var buttons = toggleWrap.querySelectorAll(".twb-asset-toggle-btn");
    var i;
    for (i = 0; i < buttons.length; i += 1) {
      var btn = buttons[i];
      var view = safeStr(btn.getAttribute("data-view")).toLowerCase();
      var active = view === currentView;
      btn.setAttribute("data-team-id", teamId);
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    }
  }

  function renderAssetGroup(team, group) {
    var tpl = q("twbGroupTemplate");
    var details = tpl.content.firstElementChild.cloneNode(true);
    var teamId = team.franchise_id;
    ensureSelectionMaps(teamId);

    details.setAttribute("data-team-id", teamId);
    details.setAttribute("data-group-key", group.key);
    var hasStoredCollapsedState = Object.prototype.hasOwnProperty.call(state.collapsed[teamId], group.key);
    details.open = hasStoredCollapsedState ? !state.collapsed[teamId][group.key] : false;

    details.querySelector(".twb-group-label").textContent = group.label + " (" + group.assets.length + ")";

    var tbody = details.querySelector("tbody");
    var i;
    for (i = 0; i < group.assets.length; i += 1) {
      tbody.appendChild(renderAssetRow(team, group.assets[i]));
    }

    details.addEventListener("toggle", function (evt) {
      var d = evt.currentTarget;
      var tId = d.getAttribute("data-team-id");
      var gKey = d.getAttribute("data-group-key");
      ensureSelectionMaps(tId);
      state.collapsed[tId][gKey] = !d.open;
      persistState();
    });

    return details;
  }

  function buildPlayerLabel(asset) {
    var name = safeStr(asset.player_name);
    var teamPos = [safeStr(asset.nfl_team), safeStr(asset.position)].join(" ").trim();
    return teamPos ? name + " " + teamPos : name;
  }

  function resolveAssetDisplayContractMetrics(asset) {
    var info = parseContractInfoSummary(asset && asset.contract_info);
    var contractLength = safeInt(asset && asset.contract_length, 0);
    if (!contractLength && info.contract_length) contractLength = safeInt(info.contract_length, 0);

    var contractYear = safeInt(asset && asset.contract_year, 0);
    if (contractYear <= 0) contractYear = 0;

    var yearsRemaining = asset && asset.years != null ? safeInt(asset.years, 0) : null;
    if (contractLength > 0) {
      if (contractYear > 0 && contractYear <= contractLength) {
        yearsRemaining = Math.max(contractLength - contractYear, 0);
      }
    }

    var currentAav = asset && asset.aav_current != null ? safeInt(asset.aav_current, 0) : null;
    if (currentAav == null && info.aav_current_dollars != null) {
      currentAav = safeInt(info.aav_current_dollars, 0);
    }
    if (currentAav == null && asset && safeInt(asset.salary, 0) > 0) {
      currentAav = safeInt(asset.salary, 0);
    }

    return {
      years_remaining: yearsRemaining,
      current_aav_dollars: currentAav,
      contract_type: safeStr(asset && asset.contract_type) || "—"
    };
  }

  function renderAssetRow(team, asset) {
    var teamId = team.franchise_id;
    var selected = !!(state.selections[teamId] && state.selections[teamId][asset.asset_id]);
    var eligible = isTradeEligibleAsset(asset);
    var tr = document.createElement("tr");
    tr.setAttribute("data-asset-id", asset.asset_id);
    tr.setAttribute("data-team-id", teamId);
    if (selected) tr.className = "twb-row-selected";
    if (asset.taxi) tr.className = (tr.className ? tr.className + " " : "") + "twb-row-taxi";
    if (!eligible) tr.className = (tr.className ? tr.className + " " : "") + "twb-row-ineligible";

    var tdSelect = document.createElement("td");
    tdSelect.className = "twb-col-select";
    tdSelect.setAttribute("data-label", "In Trade");
    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "twb-asset-select";
    cb.checked = selected;
    cb.disabled = !eligible;
    cb.setAttribute("data-action", "toggle-asset");
    cb.setAttribute("data-team-id", teamId);
    cb.setAttribute("data-asset-id", asset.asset_id);
    tdSelect.appendChild(cb);
    tr.appendChild(tdSelect);

    var tdPlayer = document.createElement("td");
    tdPlayer.className = "twb-col-player";
    tdPlayer.setAttribute("data-label", "Player / Asset");
    var main = document.createElement("div");
    main.className = "twb-asset-cell-main";

    var line = document.createElement("div");
    line.className = "twb-asset-name-line";

    if (asset.type === "PICK") {
      var pillPick = document.createElement("span");
      pillPick.className = "twb-pill twb-pill-pick";
      pillPick.textContent = "ROOKIE PICK";
      line.appendChild(pillPick);
    } else if (asset.position) {
      var pillPos = document.createElement("span");
      pillPos.className = "twb-pill twb-pill-position";
      pillPos.textContent = asset.position;
      line.appendChild(pillPos);
    }

    if (asset.taxi) {
      var taxi = document.createElement("span");
      taxi.className = "twb-pill twb-pill-taxi";
      taxi.textContent = "Taxi";
      line.appendChild(taxi);
    }

    var name = document.createElement("span");
    name.className = "twb-asset-name";
    name.textContent = asset.type === "PICK" ? safeStr(asset.pick_display || asset.description || "Rookie Pick") : buildPlayerLabel(asset);
    line.appendChild(name);

    if (asset.type === "PLAYER" && asset.extension_eligible && asset.extension_options.length) {
      var extBtn = document.createElement("button");
      extBtn.type = "button";
      extBtn.className = "twb-ext-inline-btn";
      extBtn.setAttribute("data-action", "open-extension-modal");
      extBtn.setAttribute("data-team-id", teamId);
      extBtn.setAttribute("data-asset-id", asset.asset_id);
      var extOption = getAssetExtensionOption(teamId, asset);
      extBtn.textContent = extOption
        ? "Pre-trade extension: " + extensionTypeLabel(extOption.extension_term)
        : "Pre-trade extension";
      extBtn.disabled = !selected;
      if (!selected) extBtn.setAttribute("title", "Select player first");
      line.appendChild(extBtn);
    }

    main.appendChild(line);
    var ineligibleReason = getTradeIneligibleReason(asset);
    if (ineligibleReason) {
      var ruleNote = document.createElement("div");
      ruleNote.className = "twb-asset-sub twb-asset-sub-warn";
      ruleNote.textContent = ineligibleReason;
      main.appendChild(ruleNote);
    }

    tdPlayer.appendChild(main);
    tr.appendChild(tdPlayer);

    var tdSalary = document.createElement("td");
    tdSalary.className = "twb-col-salary";
    tdSalary.setAttribute("data-label", "Salary");
    if (asset.type === "PLAYER") {
      var contractMetrics = resolveAssetDisplayContractMetrics(asset);
      var moneyStack = document.createElement("div");
      moneyStack.className = "twb-money-stack";
      var moneyMain = document.createElement("div");
      moneyMain.className = "twb-money-main";
      moneyMain.textContent = moneyFmt(asset.salary);
      var metaLine = document.createElement("div");
      metaLine.className = "twb-money-meta";
      var yearsText = contractMetrics.years_remaining == null ? "—" : String(contractMetrics.years_remaining);
      var contractType = contractMetrics.contract_type;
      metaLine.textContent = "Years: " + yearsText + " · " + contractType;
      moneyStack.appendChild(moneyMain);
      moneyStack.appendChild(metaLine);
      tdSalary.appendChild(moneyStack);
    } else {
      var pickSalaryInfo = resolvePickSalaryInfo(asset);
      var pickMoney = document.createElement("div");
      pickMoney.className = "twb-money-stack";
      var pickMain = document.createElement("div");
      pickMain.className = "twb-money-main";
      pickMain.textContent = safeInt(asset.salary, 0) > 0 ? moneyFmt(asset.salary) : "—";
      var pickMeta = document.createElement("div");
      pickMeta.className = "twb-money-meta";
      pickMeta.textContent = safeStr(asset.pick_salary_note || pickSalaryInfo.meta_label || "Rookie pick");
      pickMoney.appendChild(pickMain);
      pickMoney.appendChild(pickMeta);
      tdSalary.appendChild(pickMoney);
    }
    tr.appendChild(tdSalary);

    return tr;
  }

  function getSelectedAssets(teamId) {
    var team = getTeamById(teamId);
    if (!team) return [];
    ensureSelectionMaps(teamId);
    var map = state.selections[teamId] || {};
    var out = [];
    var assets = team.assets || [];
    var i;
    for (i = 0; i < assets.length; i += 1) {
      if (!map[assets[i].asset_id]) continue;
      if (!isTradeEligibleAsset(assets[i])) {
        delete map[assets[i].asset_id];
        continue;
      }
      out.push(assets[i]);
    }
    return out;
  }

  function getChosenExtensionRequests(teamId) {
    var out = [];
    var extMap = state.extensions[teamId] || {};
    var keys = Object.keys(extMap);
    var i;
    for (i = 0; i < keys.length; i += 1) {
      var assetId = keys[i];
      var cfg = extMap[assetId];
      if (!cfg || !cfg.enabled) continue;
      if (!(state.selections[teamId] && state.selections[teamId][assetId])) continue;
      var asset = getAssetById(teamId, assetId);
      if (!asset || asset.type !== "PLAYER") continue;
      var option = null;
      var j;
      for (j = 0; j < asset.extension_options.length; j += 1) {
        if (safeStr(asset.extension_options[j].option_key) === safeStr(cfg.option_key)) {
          option = asset.extension_options[j];
          break;
        }
      }
      if (!option && asset.extension_options[0]) option = asset.extension_options[0];
      if (!option) continue;
      out.push({
        team_id: teamId,
        applies_to_team_id: getOtherTeamId(teamId),
        asset: asset,
        option: option
      });
    }
    return out;
  }

  function sumTeamCommittedSalary(teamId) {
    var team = getTeamById(teamId);
    if (!team) return 0;
    var assets = team.assets || [];
    var total = 0;
    var i;
    for (i = 0; i < assets.length; i += 1) {
      var asset = assets[i];
      total += getAssetCapSalaryDollars(asset);
    }
    return total;
  }

  function resolveTeamAvailableSalaryDollars(teamId) {
    var team = getTeamById(teamId);
    if (!team) return null;
    if (team.available_salary_dollars != null) {
      return safeInt(team.available_salary_dollars, 0);
    }
    var cap = safeInt(state.data && state.data.meta ? state.data.meta.salary_cap_dollars : 0, 0);
    if (cap > 0) {
      return cap - sumTeamCommittedSalary(teamId);
    }
    return null;
  }

  function resolveTeamSalaryAdjustmentTotalDollars(teamId) {
    var team = getTeamById(teamId);
    if (!team) return 0;
    return safeInt(team.salary_adjustment_total_dollars, 0);
  }

  function buildSalaryReconciliation(leftTeam, rightTeam, leftTotals, rightTotals, leftTradeK, rightTradeK) {
    var salaryCap = safeInt(state.data && state.data.meta ? state.data.meta.salary_cap_dollars : 0, 0);
    var leftOutgoing = safeInt(leftTotals.selectedCapSalary, 0);
    var rightOutgoing = safeInt(rightTotals.selectedCapSalary, 0);
    var leftIncoming = rightOutgoing;
    var rightIncoming = leftOutgoing;
    var leftSalaryTradeAdjustmentDollars = (leftTradeK - rightTradeK) * 1000;
    var rightSalaryTradeAdjustmentDollars = (rightTradeK - leftTradeK) * 1000;
    var leftStartingSalary = sumTeamCommittedSalary(state.leftTeamId);
    var rightStartingSalary = sumTeamCommittedSalary(state.rightTeamId);
    var leftAdjustmentTotal = resolveTeamSalaryAdjustmentTotalDollars(state.leftTeamId);
    var rightAdjustmentTotal = resolveTeamSalaryAdjustmentTotalDollars(state.rightTeamId);
    var leftAvailableBefore = salaryCap > 0
      ? salaryCap - (leftStartingSalary + leftAdjustmentTotal)
      : resolveTeamAvailableSalaryDollars(state.leftTeamId);
    var rightAvailableBefore = salaryCap > 0
      ? salaryCap - (rightStartingSalary + rightAdjustmentTotal)
      : resolveTeamAvailableSalaryDollars(state.rightTeamId);

    var leftNetSalaryAdjustment = leftIncoming - leftOutgoing + leftSalaryTradeAdjustmentDollars;
    var rightNetSalaryAdjustment = rightIncoming - rightOutgoing + rightSalaryTradeAdjustmentDollars;
    var leftNewSalary = safeInt(leftStartingSalary, 0) + leftNetSalaryAdjustment;
    var rightNewSalary = safeInt(rightStartingSalary, 0) + rightNetSalaryAdjustment;

    var leftAvailableAfter = salaryCap > 0
      ? salaryCap - (leftNewSalary + leftAdjustmentTotal)
      : (leftAvailableBefore == null ? null : safeInt(leftAvailableBefore, 0) - leftNetSalaryAdjustment);
    var rightAvailableAfter = salaryCap > 0
      ? salaryCap - (rightNewSalary + rightAdjustmentTotal)
      : (rightAvailableBefore == null ? null : safeInt(rightAvailableBefore, 0) - rightNetSalaryAdjustment);

    var leftNetChange = -leftNetSalaryAdjustment;
    var rightNetChange = -rightNetSalaryAdjustment;
    var leftOverCap = leftAvailableAfter != null && leftAvailableAfter < 0 ? Math.abs(leftAvailableAfter) : 0;
    var rightOverCap = rightAvailableAfter != null && rightAvailableAfter < 0 ? Math.abs(rightAvailableAfter) : 0;

    return {
      left: {
        franchise_id: leftTeam ? leftTeam.franchise_id : "",
        franchise_name: leftTeam ? leftTeam.franchise_name : "",
        salary_cap_dollars: salaryCap > 0 ? salaryCap : null,
        starting_salary_dollars: leftStartingSalary,
        salary_adjustment_total_dollars: leftAdjustmentTotal,
        outgoing_dollars: leftOutgoing,
        incoming_dollars: leftIncoming,
        salary_trade_adjustment_dollars: leftSalaryTradeAdjustmentDollars,
        net_salary_adjustment_dollars: leftNetSalaryAdjustment,
        new_salary_dollars: leftNewSalary,
        trade_salary_adjustment_k: leftTradeK,
        trade_salary_adjustment_max_k: getTradeSalaryMaxK(state.leftTeamId),
        net_trade_salary_k: safeInt(leftSalaryTradeAdjustmentDollars / 1000, 0),
        net_cap_change_dollars: leftNetChange,
        available_salary_before_dollars: leftAvailableBefore,
        available_salary_after_dollars: leftAvailableAfter,
        over_cap_dollars: leftOverCap
      },
      right: {
        franchise_id: rightTeam ? rightTeam.franchise_id : "",
        franchise_name: rightTeam ? rightTeam.franchise_name : "",
        salary_cap_dollars: salaryCap > 0 ? salaryCap : null,
        starting_salary_dollars: rightStartingSalary,
        salary_adjustment_total_dollars: rightAdjustmentTotal,
        outgoing_dollars: rightOutgoing,
        incoming_dollars: rightIncoming,
        salary_trade_adjustment_dollars: rightSalaryTradeAdjustmentDollars,
        net_salary_adjustment_dollars: rightNetSalaryAdjustment,
        new_salary_dollars: rightNewSalary,
        trade_salary_adjustment_k: rightTradeK,
        trade_salary_adjustment_max_k: getTradeSalaryMaxK(state.rightTeamId),
        net_trade_salary_k: safeInt(rightSalaryTradeAdjustmentDollars / 1000, 0),
        net_cap_change_dollars: rightNetChange,
        available_salary_before_dollars: rightAvailableBefore,
        available_salary_after_dollars: rightAvailableAfter,
        over_cap_dollars: rightOverCap
      },
      has_over_cap: leftOverCap > 0 || rightOverCap > 0
    };
  }

  function inferAssetCurrentContractYear(asset, contractLength, yearsRemaining) {
    var contractYear = safeInt(asset && asset.contract_year, 0);
    if (contractLength > 0) {
      if (contractYear <= 0 && yearsRemaining != null) {
        contractYear = contractLength - safeInt(yearsRemaining, 0);
      }
      if (contractYear <= 0) contractYear = 1;
      if (contractYear > contractLength) contractYear = contractLength;
      return contractYear;
    }
    return contractYear > 0 ? contractYear : 1;
  }

  function resolveExtensionFutureYears(req) {
    var newLength = safeInt(req && req.new_contract_length, 0);
    if (newLength > 0) return Math.max(newLength - 1, 0);
    return Math.max(extensionYearsCount(req && (req.extension_term || req.option_key || "")), 0);
  }

  function resolvePlayerSeasonSalaryDollars(asset, seasonOffset) {
    if (!asset || asset.type !== "PLAYER" || asset.taxi || seasonOffset < 0) return 0;
    if (seasonOffset === 0) return getAssetCurrentCapHitDollars(asset);
    if (safeInt(asset && asset.years, 0) <= 0) return 0;
    var info = parseContractInfoSummary(asset.contract_info);
    var metrics = resolveAssetDisplayContractMetrics(asset);
    var contractLength = safeInt(asset.contract_length, 0);
    if (!contractLength && info.contract_length) contractLength = safeInt(info.contract_length, 0);
    var yearsRemaining = metrics.years_remaining == null ? null : safeInt(metrics.years_remaining, 0);
    var contractYear = inferAssetCurrentContractYear(asset, contractLength, yearsRemaining);

    var targetContractYear = contractYear + seasonOffset;
    if (contractLength > 0 && targetContractYear > contractLength) return 0;
    if (targetContractYear > 0 && info.y_by_year_dollars && info.y_by_year_dollars[String(targetContractYear)] != null) {
      return safeInt(info.y_by_year_dollars[String(targetContractYear)], 0);
    }

    var fallback = metrics.current_aav_dollars != null
      ? safeInt(metrics.current_aav_dollars, 0)
      : safeInt(asset.salary, 0);
    if (fallback <= 0) return 0;

    if (contractLength > 0) {
      return targetContractYear >= 1 && targetContractYear <= contractLength ? fallback : 0;
    }
    if (yearsRemaining != null) {
      return seasonOffset <= yearsRemaining ? fallback : 0;
    }
    return seasonOffset === 0 ? fallback : 0;
  }

  function resolveAssetSeasonSalaryDollars(asset, season, currentSeason, extensionReq) {
    var offset = safeInt(season, 0) - safeInt(currentSeason, 0);
    if (offset < 0 || !asset) return 0;
    if (safeStr(asset.type).toUpperCase() === "PICK") {
      return offset === 0 ? safeInt(resolvePickSalaryInfo(asset, currentSeason).salary_dollars, 0) : 0;
    }
    if (asset.type !== "PLAYER" || asset.taxi) return 0;
    if (extensionReq && offset > 0 && extensionReq.new_aav_future != null) {
      var extFutureYears = resolveExtensionFutureYears(extensionReq);
      if (extFutureYears > 0) {
        return offset <= extFutureYears ? safeInt(extensionReq.new_aav_future, 0) : 0;
      }
    }
    return resolvePlayerSeasonSalaryDollars(asset, offset);
  }

  function buildExtensionRequestIndex(extReqs) {
    var index = {};
    var rows = Array.isArray(extReqs) ? extReqs : [];
    var i;
    for (i = 0; i < rows.length; i += 1) {
      var req = rows[i] || {};
      var toTeamId = pad4(req.to_franchise_id || req.to || req.applies_to_team_id);
      var playerId = safeStr(req.player_id).replace(/\D/g, "");
      if (!toTeamId || !playerId) continue;
      index[[toTeamId, playerId].join("|")] = req;
    }
    return index;
  }

  function sumAssetListSeasonSalary(assets, season, currentSeason, extIndex, toTeamId) {
    var total = 0;
    var list = Array.isArray(assets) ? assets : [];
    var i;
    for (i = 0; i < list.length; i += 1) {
      var asset = list[i];
      var extReq = null;
      if (asset && asset.type === "PLAYER" && extIndex && toTeamId) {
        extReq = extIndex[[safeStr(toTeamId), safeStr(asset.player_id).replace(/\D/g, "")].join("|")] || null;
      }
      total += resolveAssetSeasonSalaryDollars(asset, season, currentSeason, extReq);
    }
    return total;
  }

  function buildMultiYearSalaryImpact(payload, seasonCount) {
    var leftTeam = getTeamById(state.leftTeamId);
    var rightTeam = getTeamById(state.rightTeamId);
    if (!leftTeam || !rightTeam) return null;

    var currentSeason = safeInt(payload && payload.season, 0) || getCurrentTradeSeason();
    if (!currentSeason) return null;

    var count = Math.max(1, safeInt(seasonCount, 3));
    var leftSelected = getSelectedAssets(state.leftTeamId);
    var rightSelected = getSelectedAssets(state.rightTeamId);
    var extIndex = buildExtensionRequestIndex(payload && payload.extension_requests);
    var recon = payload && payload.salary_reconciliation ? payload.salary_reconciliation : {};
    var leftTradeAdjCurrent = safeInt((recon.left || {}).salary_trade_adjustment_dollars, 0);
    var rightTradeAdjCurrent = safeInt((recon.right || {}).salary_trade_adjustment_dollars, 0);
    var rows = [];
    var i;

    for (i = 0; i < count; i += 1) {
      var season = currentSeason + i;
      var leftBefore = sumAssetListSeasonSalary(leftTeam.assets, season, currentSeason, null, "");
      var rightBefore = sumAssetListSeasonSalary(rightTeam.assets, season, currentSeason, null, "");
      var leftOutgoing = sumAssetListSeasonSalary(leftSelected, season, currentSeason, null, "");
      var rightOutgoing = sumAssetListSeasonSalary(rightSelected, season, currentSeason, null, "");
      var leftIncoming = sumAssetListSeasonSalary(rightSelected, season, currentSeason, extIndex, state.leftTeamId);
      var rightIncoming = sumAssetListSeasonSalary(leftSelected, season, currentSeason, extIndex, state.rightTeamId);
      var leftAfter = leftBefore - leftOutgoing + leftIncoming + (i === 0 ? leftTradeAdjCurrent : 0);
      var rightAfter = rightBefore - rightOutgoing + rightIncoming + (i === 0 ? rightTradeAdjCurrent : 0);

      rows.push({
        season: season,
        left_before_dollars: leftBefore,
        left_after_dollars: leftAfter,
        left_change_dollars: leftAfter - leftBefore,
        right_before_dollars: rightBefore,
        right_after_dollars: rightAfter,
        right_change_dollars: rightAfter - rightBefore
      });
    }

    return {
      current_season: currentSeason,
      left_franchise_name: safeStr(leftTeam.franchise_name) || "Your Team",
      right_franchise_name: safeStr(rightTeam.franchise_name) || "Trade Partner",
      rows: rows
    };
  }

  function buildTradePayload() {
    var leftTeam = getTeamById(state.leftTeamId);
    var rightTeam = getTeamById(state.rightTeamId);
    var leftTotals = getTeamTotals(state.leftTeamId);
    var rightTotals = getTeamTotals(state.rightTeamId);
    var leftMaxK = getTradeSalaryMaxK(state.leftTeamId);
    var rightMaxK = getTradeSalaryMaxK(state.rightTeamId);
    clampTradeSalaryForTeam(state.leftTeamId);
    clampTradeSalaryForTeam(state.rightTeamId);

    var leftTradeK = safeInt(state.tradeSalaryK[state.leftTeamId], 0);
    var rightTradeK = safeInt(state.tradeSalaryK[state.rightTeamId], 0);
    if (leftTradeK > leftMaxK) leftTradeK = leftMaxK;
    if (rightTradeK > rightMaxK) rightTradeK = rightMaxK;

    var payload = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      source: "ups-trade-workbench",
      league_id: safeStr(state.data.meta.league_id),
      season: state.data.meta.season || null,
      teams: [
        {
          role: "left",
          franchise_id: leftTeam ? leftTeam.franchise_id : "",
          franchise_name: leftTeam ? leftTeam.franchise_name : "",
          selected_assets: serializeSelectedAssets(state.leftTeamId),
          traded_salary_adjustment_dollars: leftTradeK * 1000,
          traded_salary_adjustment_k: leftTradeK,
          traded_salary_adjustment_max_k: leftMaxK,
          selected_non_taxi_salary_dollars: leftTotals.selectedNonTaxiSalary
        },
        {
          role: "right",
          franchise_id: rightTeam ? rightTeam.franchise_id : "",
          franchise_name: rightTeam ? rightTeam.franchise_name : "",
          selected_assets: serializeSelectedAssets(state.rightTeamId),
          traded_salary_adjustment_dollars: rightTradeK * 1000,
          traded_salary_adjustment_k: rightTradeK,
          traded_salary_adjustment_max_k: rightMaxK,
          selected_non_taxi_salary_dollars: rightTotals.selectedNonTaxiSalary
        }
      ],
      extension_requests: serializeExtensionRequests(),
      filters: clone(state.filters),
      ui: {
        left_team_id: state.leftTeamId,
        right_team_id: state.rightTeamId
      }
    };

    payload.salary_reconciliation = buildSalaryReconciliation(
      leftTeam,
      rightTeam,
      leftTotals,
      rightTotals,
      leftTradeK,
      rightTradeK
    );
    payload.multi_year_salary_impact = buildMultiYearSalaryImpact(payload, 3);
    payload.validation = buildValidationSummary(payload);
    return payload;
  }

  function serializeSelectedAssets(teamId) {
    var selected = getSelectedAssets(teamId);
    var out = [];
    var i;
    for (i = 0; i < selected.length; i += 1) {
      var payloadAsset = assetToPayloadAsset(selected[i]);
      if (payloadAsset) out.push(payloadAsset);
    }
    return out;
  }

  function serializeExtensionRequests() {
    var requests = [];
    var all = getChosenExtensionRequests(state.leftTeamId).concat(getChosenExtensionRequests(state.rightTeamId));
    var i;
    for (i = 0; i < all.length; i += 1) {
      var req = all[i];
      requests.push({
        player_id: req.asset.player_id,
        player_name: req.asset.player_name,
        from_franchise_id: req.team_id,
        to_franchise_id: req.applies_to_team_id,
        applies_to_acquirer: true,
        option_key: req.option.option_key,
        extension_term: req.option.extension_term,
        loaded_indicator: req.option.loaded_indicator,
        preview_id: req.option.preview_id,
        preview_contract_info_string: req.option.preview_contract_info_string || null,
        new_contract_status: req.option.new_contract_status || null,
        new_contract_length: req.option.new_contract_length == null ? null : req.option.new_contract_length,
        new_TCV: req.option.new_TCV == null ? null : req.option.new_TCV,
        new_aav_future: req.option.new_aav_future == null ? null : req.option.new_aav_future
      });
    }
    return requests;
  }

  function buildValidationSummary(payload) {
    var issues = [];
    var teams = payload.teams || [];
    if (teams.length === 2) {
      var leftId = safeStr(teams[0].franchise_id);
      var rightId = safeStr(teams[1].franchise_id);
      if (!leftId) issues.push("Your team is not selected.");
      if (!rightId) issues.push("Select a trade partner.");
      if (leftId && !(teams[0].selected_assets || []).length) issues.push("Your side has no selected assets.");
      if (rightId && !(teams[1].selected_assets || []).length) issues.push("Trade partner side has no selected assets.");
      if (teams[0].traded_salary_adjustment_k > teams[0].traded_salary_adjustment_max_k) issues.push("Left traded salary exceeds max.");
      if (teams[1].traded_salary_adjustment_k > teams[1].traded_salary_adjustment_max_k) issues.push("Right traded salary exceeds max.");
    }
    var invalidAssets = collectInvalidTradeAssets(payload);
    if (invalidAssets.length === 1) {
      var first = invalidAssets[0];
      var reason = safeStr(first.reason).replace(/^Ineligible:\s*/i, "");
      issues.push("Invalid asset selected: " + safeStr(first.label) + (reason ? " (" + reason + ")" : ""));
    } else if (invalidAssets.length > 1) {
      issues.push("Remove ineligible assets before submitting.");
    }
    return {
      status: issues.length ? "draft" : "ready",
      issues: issues
    };
  }

  function formatSignedK(v) {
    var n = safeInt(v, 0);
    if (n > 0) return "+" + n + "K";
    if (n < 0) return n + "K";
    return "0K";
  }

  function setTextIf(el, text) {
    if (!el) return;
    el.textContent = text;
  }

  function formatKLabel(k) {
    return String(safeInt(k, 0)) + "K";
  }

  function formatDollarsAsKLabel(dollars) {
    if (dollars == null) return "—";
    return formatKLabel(Math.round(safeInt(dollars, 0) / 1000));
  }

  function getAssetExtensionOption(teamId, asset) {
    if (!asset || asset.type !== "PLAYER") return null;
    var extState = state.extensions[teamId] && state.extensions[teamId][asset.asset_id];
    if (!extState || !extState.enabled) return null;
    var options = Array.isArray(asset.extension_options) ? asset.extension_options : [];
    if (!options.length) return null;
    var optionKey = safeStr(extState.option_key);
    var i;
    for (i = 0; i < options.length; i += 1) {
      if (safeStr(options[i].option_key) === optionKey) return options[i];
    }
    return options[0];
  }

  function extensionTypeLabel(termRaw) {
    var term = safeStr(termRaw).toUpperCase();
    var match = term.match(/(\d+)/);
    var years = match ? safeInt(match[1], 0) : 0;
    if (!years) return safeStr(termRaw) || "Extension";
    return String(years) + "-Year Extension";
  }

  function getExtensionModalAsset() {
    if (!state.extensionModal) return null;
    var teamId = safeStr(state.extensionModal.teamId);
    var assetId = safeStr(state.extensionModal.assetId);
    if (!teamId || !assetId) return null;
    return getAssetById(teamId, assetId);
  }

  function renderExtensionModalPreview(teamId, asset, optionKey) {
    if (!els.extModalPreview) return;
    if (!asset || asset.type !== "PLAYER") {
      els.extModalPreview.textContent = "";
      return;
    }

    var options = Array.isArray(asset.extension_options) ? asset.extension_options : [];
    var option = null;
    var i;
    for (i = 0; i < options.length; i += 1) {
      if (safeStr(options[i].option_key) === safeStr(optionKey)) {
        option = options[i];
        break;
      }
    }

    if (!option) {
      els.extModalPreview.textContent = "Pre-trade extension is off.";
      return;
    }

    var lines = [];
    lines.push("Pre-trade extension: " + extensionTypeLabel(option.extension_term));
    lines.push("New length " + (option.new_contract_length == null ? "—" : String(option.new_contract_length)));
    lines.push("New AAV " + (option.new_aav_future == null ? "—" : formatDollarsAsKLabel(option.new_aav_future)));
    lines.push("New TCV " + (option.new_TCV == null ? "—" : formatDollarsAsKLabel(option.new_TCV)));
    els.extModalPreview.textContent = lines.join(" | ");
  }

  function openExtensionModal(teamId, assetId) {
    ensureSelectionMaps(teamId);
    var asset = getAssetById(teamId, assetId);
    if (!asset || asset.type !== "PLAYER") return;
    if (!asset.extension_eligible || !Array.isArray(asset.extension_options) || !asset.extension_options.length) return;
    if (!(state.selections[teamId] && state.selections[teamId][assetId])) return;
    if (!els.extensionModal || !els.extModalOptionSelect || !els.extModalSaveBtn) return;

    state.extensionModal.teamId = teamId;
    state.extensionModal.assetId = assetId;

    if (els.extModalPlayer) {
      els.extModalPlayer.textContent = safeStr(asset.player_name || "Player");
    }

    var extState = (state.extensions[teamId] && state.extensions[teamId][assetId]) || { enabled: false, option_key: "" };
    var defaultKey = extState.enabled ? safeStr(extState.option_key) : "";
    if (!defaultKey && asset.extension_options[0]) defaultKey = safeStr(asset.extension_options[0].option_key || "");

    els.extModalOptionSelect.innerHTML = "";
    els.extModalOptionSelect.appendChild(optionEl("", "Off"));
    var i;
    for (i = 0; i < asset.extension_options.length; i += 1) {
      var opt = asset.extension_options[i];
      var label = extensionTypeLabel(opt.extension_term);
      if (opt.new_aav_future != null) label += " · New AAV " + formatDollarsAsKLabel(opt.new_aav_future);
      if (opt.new_TCV != null) label += " · New TCV " + formatDollarsAsKLabel(opt.new_TCV);
      els.extModalOptionSelect.appendChild(optionEl(safeStr(opt.option_key), label));
    }

    els.extModalOptionSelect.value = extState.enabled ? defaultKey : "";
    state.extensionModal.optionKey = safeStr(els.extModalOptionSelect.value);
    renderExtensionModalPreview(teamId, asset, state.extensionModal.optionKey);

    if (typeof els.extensionModal.showModal === "function") {
      els.extensionModal.showModal();
    } else {
      els.extensionModal.setAttribute("open", "open");
    }
    window.setTimeout(function () {
      try {
        els.extModalOptionSelect.focus();
      } catch (e) {
        // noop
      }
    }, 0);
  }

  function closeExtensionModal() {
    if (!els.extensionModal) return;
    if (typeof els.extensionModal.close === "function") {
      try {
        els.extensionModal.close();
      } catch (e) {
        // noop
      }
    } else {
      els.extensionModal.removeAttribute("open");
    }
    state.extensionModal.teamId = "";
    state.extensionModal.assetId = "";
    state.extensionModal.optionKey = "";
  }

  function saveExtensionModal() {
    var teamId = safeStr(state.extensionModal.teamId);
    var assetId = safeStr(state.extensionModal.assetId);
    var optionKey = safeStr(els.extModalOptionSelect ? els.extModalOptionSelect.value : "");
    if (!teamId || !assetId) {
      closeExtensionModal();
      return;
    }
    if (!optionKey) {
      setExtensionEnabled(teamId, assetId, false);
      if (state.extensions[teamId] && state.extensions[teamId][assetId]) {
        state.extensions[teamId][assetId].option_key = "";
      }
    } else {
      setExtensionOption(teamId, assetId, optionKey);
      setExtensionEnabled(teamId, assetId, true);
    }
    closeExtensionModal();
    rerender();
  }

  function renderOfferCartPlayerCard(teamId, asset) {
    var contractMetrics = resolveAssetDisplayContractMetrics(asset);
    var item = document.createElement("article");
    item.className = "twb-offer-cart-item twb-offer-cart-item-player";

    var head = document.createElement("div");
    head.className = "twb-offer-cart-item-head";

    var copy = document.createElement("div");
    copy.className = "twb-offer-cart-item-copy";

    var name = document.createElement("div");
    name.className = "twb-offer-cart-item-name";
    name.textContent = safeStr(asset.player_name || "Player");
    copy.appendChild(name);

    var meta = document.createElement("div");
    meta.className = "twb-offer-cart-item-meta";
    meta.textContent = [safeStr(asset.nfl_team), safeStr(asset.position)].join(" ").trim() || "Player";
    copy.appendChild(meta);
    head.appendChild(copy);

    var remove = document.createElement("button");
    remove.type = "button";
    remove.className = "twb-offer-cart-item-remove";
    remove.setAttribute("data-action", "cart-remove-asset");
    remove.setAttribute("data-team-id", teamId);
    remove.setAttribute("data-asset-id", asset.asset_id);
    remove.setAttribute("aria-label", "Remove " + safeStr(asset.player_name || "player"));
    remove.textContent = "Remove";
    head.appendChild(remove);
    item.appendChild(head);

    var contract = document.createElement("div");
    contract.className = "twb-offer-player-grid";
    contract.appendChild(offerPlayerMetric("Current Salary", formatDollarsAsKLabel(asset.salary)));
    contract.appendChild(
      offerPlayerMetric(
        "Current AAV",
        contractMetrics.current_aav_dollars == null ? "—" : formatDollarsAsKLabel(contractMetrics.current_aav_dollars)
      )
    );
    contract.appendChild(
      offerPlayerMetric(
        "Years Remaining",
        contractMetrics.years_remaining == null ? "—" : String(contractMetrics.years_remaining)
      )
    );
    contract.appendChild(offerPlayerMetric("Contract Type", contractMetrics.contract_type));
    item.appendChild(contract);

    if (asset.taxi) {
      var taxi = document.createElement("div");
      taxi.className = "twb-offer-player-note";
      taxi.textContent = "Taxi";
      item.appendChild(taxi);
    }

    var option = getAssetExtensionOption(teamId, asset);
    if (option) {
      var ext = document.createElement("div");
      ext.className = "twb-offer-extension";
      var extTitle = document.createElement("div");
      extTitle.className = "twb-offer-extension-title";
      extTitle.textContent = "Pre-trade extension · " + extensionTypeLabel(option.extension_term);
      ext.appendChild(extTitle);
      if (option.new_aav_future != null) {
        ext.appendChild(offerPlayerMetric("New AAV", formatDollarsAsKLabel(option.new_aav_future)));
      }
      if (option.new_TCV != null) {
        ext.appendChild(offerPlayerMetric("New TCV", formatDollarsAsKLabel(option.new_TCV)));
      }
      item.appendChild(ext);
    }

    return item;
  }

  function offerPlayerMetric(label, value) {
    var row = document.createElement("div");
    row.className = "twb-offer-player-metric";
    var l = document.createElement("span");
    l.className = "twb-offer-player-metric-label";
    l.textContent = label;
    var v = document.createElement("span");
    v.className = "twb-offer-player-metric-value";
    v.textContent = value;
    row.appendChild(l);
    row.appendChild(v);
    return row;
  }

  function renderOfferCartPickCard(teamId, asset) {
    var pickSalaryInfo = resolvePickSalaryInfo(asset);
    var item = document.createElement("article");
    item.className = "twb-offer-cart-item twb-offer-cart-item-pick";

    var head = document.createElement("div");
    head.className = "twb-offer-cart-item-head";
    var name = document.createElement("div");
    name.className = "twb-offer-cart-item-name";
    name.textContent = safeStr(asset.pick_display || asset.description || "Rookie Pick");
    head.appendChild(name);

    var remove = document.createElement("button");
    remove.type = "button";
    remove.className = "twb-offer-cart-item-remove";
    remove.setAttribute("data-action", "cart-remove-asset");
    remove.setAttribute("data-team-id", teamId);
    remove.setAttribute("data-asset-id", asset.asset_id);
    remove.setAttribute("aria-label", "Remove draft pick");
    remove.textContent = "Remove";
    head.appendChild(remove);
    item.appendChild(head);

    var meta = document.createElement("div");
    meta.className = "twb-offer-cart-item-meta";
    meta.textContent = safeStr(asset.pick_salary_note || pickSalaryInfo.meta_label || "Rookie pick");
    item.appendChild(meta);

    if (safeInt(asset.salary, 0) > 0) {
      item.appendChild(
        offerPlayerMetric(
          "Draft Salary",
          formatDollarsAsKLabel(asset.salary)
        )
      );
    }
    return item;
  }

  function renderOfferCartSide(teamId, listEl) {
    if (!listEl) return;
    listEl.innerHTML = "";
    var selected = getSelectedAssets(teamId);
    if (!selected.length) {
      var empty = document.createElement("div");
      empty.className = "twb-offer-cart-empty";
      empty.textContent = "No assets selected yet.";
      listEl.appendChild(empty);
      return;
    }

    var i;
    for (i = 0; i < selected.length; i += 1) {
      var asset = selected[i];
      var item = asset.type === "PICK"
        ? renderOfferCartPickCard(teamId, asset)
        : renderOfferCartPlayerCard(teamId, asset);
      listEl.appendChild(item);
    }
  }

  function offerTokenAssetCount(csv) {
    var tokens = parseTradeTokenList(csv);
    var count = 0;
    var i;
    for (i = 0; i < tokens.length; i += 1) {
      if (tokens[i].indexOf("BB_") === 0) continue;
      count += 1;
    }
    return count;
  }

  function renderCounterSourcePanel() {
    if (!els.counterSourcePanel || !els.counterSourceContent) return;
    var offer = state.counterSourceOffer;
    if (!state.counterMode || !offer) {
      els.counterSourcePanel.hidden = true;
      els.counterSourceContent.innerHTML = "";
      return;
    }
    els.counterSourcePanel.hidden = false;
    els.counterSourceContent.innerHTML = "";

    var summary = document.createElement("p");
    var opponent = getFranchiseLabelFromOfferFields(
      offer.from_franchise_name,
      offer.from_franchise_id,
      "Opponent"
    );
    var destination = getFranchiseLabelFromOfferFields(
      offer.to_franchise_name,
      offer.to_franchise_id,
      "Your Team"
    );
    var tradeId = safeStr(offer.proposal_id || offer.trade_id || offer.mfl_trade_id || "").replace(/\D/g, "");
    summary.textContent =
      opponent +
      " to " +
      destination +
      (tradeId ? " · Trade ID " + tradeId : "");
    els.counterSourceContent.appendChild(summary);

    var assetsLine = document.createElement("p");
    assetsLine.textContent =
      offerTokenAssetCount(offer.will_give_up) +
      " assets for " +
      offerTokenAssetCount(offer.will_receive) +
      " assets";
    els.counterSourceContent.appendChild(assetsLine);

    var commentText = stripTradeMetaTag(offer.comment || offer.raw_comment || offer.message);
    if (commentText) {
      var commentLine = document.createElement("p");
      commentLine.textContent = commentText;
      els.counterSourceContent.appendChild(commentLine);
    }
  }

  function renderOfferCart(payload) {
    if (!els.offerCart) return;
    var leftTeam = getTeamById(state.leftTeamId);
    var rightTeam = getTeamById(state.rightTeamId);
    setTextIf(els.offerCartLeftTitle, leftTeam ? ("You Send · " + leftTeam.franchise_name) : "You Send");
    setTextIf(els.offerCartRightTitle, rightTeam ? ("You Receive · " + rightTeam.franchise_name) : "You Receive");

    renderCounterSourcePanel();
    renderOfferCartSide(state.leftTeamId, els.offerCartLeftList);
    renderOfferCartSide(state.rightTeamId, els.offerCartRightList);

    if (els.offerCartStatus) {
      var ready = payload.validation.status === "ready";
      if (ready) {
        els.offerCartStatus.textContent = state.counterMode ? "Counter Ready" : "Ready";
      } else {
        els.offerCartStatus.textContent = state.counterMode ? "Counter Offer Draft" : "Draft";
      }
      els.offerCartStatus.className = "twb-status-pill " + (ready ? "is-ready" : "is-draft");
    }
  }

  function updateMobileTabVisibility(payload) {
    var isMobile = !!(window.matchMedia && window.matchMedia("(max-width: 760px)").matches);
    if (!els.app) return;
    if (!isMobile) {
      els.app.setAttribute("data-mobile-tab", "");
      if (els.offerCartMobileTray) els.offerCartMobileTray.hidden = true;
      return;
    }
    var tab = safeStr(state.mobileTab) || "your";
    if (tab !== "your" && tab !== "partner" && tab !== "review") tab = "your";
    state.mobileTab = tab;
    els.app.setAttribute("data-mobile-tab", tab);
    if (els.mobileTabButtons && els.mobileTabButtons.length) {
      var i;
      for (i = 0; i < els.mobileTabButtons.length; i += 1) {
        var btn = els.mobileTabButtons[i];
        var active = safeStr(btn.getAttribute("data-mobile-tab")) === tab;
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-selected", active ? "true" : "false");
      }
    }

    if (els.offerCartMobileTray) {
      if (tab === "review") {
        els.offerCartMobileTray.hidden = true;
      } else {
        var leftTotals = getTeamTotals(state.leftTeamId);
        var rightTotals = getTeamTotals(state.rightTeamId);
        var leftEnteredK = safeInt(state.tradeSalaryK[state.leftTeamId], 0);
        var rightEnteredK = safeInt(state.tradeSalaryK[state.rightTeamId], 0);
        var readyLabel = payload && payload.validation && payload.validation.status === "ready" ? "Ready" : "Draft";
        els.offerCartMobileTray.hidden = false;
        els.offerCartMobileTray.textContent =
          "Review Offer · " +
          (leftTotals.selectedPlayers + rightTotals.selectedPlayers) +
          " players / " +
          (leftTotals.selectedPicks + rightTotals.selectedPicks) +
          " picks · " +
          leftEnteredK +
          "K/" +
          rightEnteredK +
          "K · " +
          readyLabel;
      }
    }
  }

  function renderSalaryLine(label, value, tone) {
    var row = document.createElement("div");
    row.className = "twb-summary-row";
    var l = document.createElement("div");
    l.className = "label";
    l.textContent = label;
    var v = document.createElement("div");
    v.className = "value" + (tone ? " " + tone : "");
    v.textContent = value;
    row.appendChild(l);
    row.appendChild(v);
    return row;
  }

  function formatDollarsPlainLabel(dollars) {
    if (dollars == null) return "—";
    try {
      return safeInt(dollars, 0).toLocaleString("en-US");
    } catch (e) {
      return String(safeInt(dollars, 0));
    }
  }

  function formatSignedDollarsPlainLabel(dollars) {
    if (dollars == null) return "—";
    var n = safeInt(dollars, 0);
    var abs = Math.abs(n);
    var base;
    try {
      base = abs.toLocaleString("en-US");
    } catch (e) {
      base = String(abs);
    }
    if (n > 0) return "+" + base;
    if (n < 0) return "-" + base;
    return "0";
  }

  function renderSalaryTeamBlock(title, sideData) {
    var block = document.createElement("section");
    block.className = "twb-salary-side";
    var overCap = safeInt(sideData.over_cap_dollars, 0) > 0;
    if (overCap) block.className += " is-over-cap";

    var h = document.createElement("h4");
    h.className = "twb-salary-side-title";
    h.textContent = title;
    block.appendChild(h);

    block.appendChild(
      renderSalaryLine(
        "Starting Salary",
        formatDollarsPlainLabel(sideData.starting_salary_dollars)
      )
    );
    block.appendChild(
      renderSalaryLine(
        "Cap Adjustments",
        formatDollarsPlainLabel(sideData.salary_adjustment_total_dollars)
      )
    );
    block.appendChild(renderSalaryLine("Incoming Salary", formatDollarsPlainLabel(sideData.incoming_dollars)));
    block.appendChild(renderSalaryLine("Exiting Salary", formatDollarsPlainLabel(sideData.outgoing_dollars)));
    block.appendChild(
      renderSalaryLine("Salary Trade Adjustment", formatSignedDollarsPlainLabel(sideData.salary_trade_adjustment_dollars))
    );
    if (safeInt(sideData.salary_trade_adjustment_dollars, 0) < 0) {
      var adjHint = document.createElement("div");
      adjHint.className = "twb-salary-adjustment-hint";
      adjHint.textContent = "Negative implies receiving salary relief.";
      block.appendChild(adjHint);
    }
    block.appendChild(
      renderSalaryLine("Net Adjustment", formatDollarsPlainLabel(sideData.net_salary_adjustment_dollars))
    );
    block.appendChild(renderSalaryLine("New Salary", formatDollarsPlainLabel(sideData.new_salary_dollars)));
    block.appendChild(
      renderSalaryLine(
        "Available Salary",
        sideData.available_salary_after_dollars == null ? "—" : formatDollarsPlainLabel(sideData.available_salary_after_dollars),
        overCap ? "bad" : "good"
      )
    );

    if (overCap) {
      var overCapEl = document.createElement("div");
      overCapEl.className = "twb-salary-over-cap-indicator";
      overCapEl.textContent = "OVER CAP BY $" + formatDollarsPlainLabel(sideData.over_cap_dollars);
      block.appendChild(overCapEl);
    }

    return block;
  }

  function renderMultiYearImpactCell(afterDollars, changeDollars) {
    var cell = document.createElement("td");
    cell.className = "twb-season-impact-cell";

    var main = document.createElement("div");
    main.className = "twb-season-impact-main";
    main.textContent = formatDollarsPlainLabel(afterDollars);
    cell.appendChild(main);

    var delta = document.createElement("div");
    delta.className = "twb-season-impact-delta";
    var change = safeInt(changeDollars, 0);
    if (change > 0) delta.className += " is-up";
    else if (change < 0) delta.className += " is-down";
    delta.textContent = (change === 0 ? "No change" : formatSignedDollarsPlainLabel(change)) + " vs current";
    cell.appendChild(delta);

    return cell;
  }

  function renderMultiYearImpactTable(impact) {
    if (!impact || !Array.isArray(impact.rows) || !impact.rows.length) return null;

    var wrap = document.createElement("section");
    wrap.className = "twb-season-impact-card";

    var head = document.createElement("div");
    head.className = "twb-card-head-inline";
    var title = document.createElement("h3");
    title.textContent = "Current + 2 Seasons";
    head.appendChild(title);
    wrap.appendChild(head);

    var note = document.createElement("p");
    note.className = "twb-summary-note";
    note.textContent = "Trade salary adjustments only apply to " + String(safeInt(impact.current_season, 0)) + ".";
    wrap.appendChild(note);

    var tableWrap = document.createElement("div");
    tableWrap.className = "twb-season-impact-table-wrap";
    var table = document.createElement("table");
    table.className = "twb-season-impact-table";

    var thead = document.createElement("thead");
    var headRow = document.createElement("tr");
    var seasonTh = document.createElement("th");
    seasonTh.textContent = "Season";
    headRow.appendChild(seasonTh);
    var leftTh = document.createElement("th");
    leftTh.textContent = impact.left_franchise_name || "Your Team";
    headRow.appendChild(leftTh);
    var rightTh = document.createElement("th");
    rightTh.textContent = impact.right_franchise_name || "Trade Partner";
    headRow.appendChild(rightTh);
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = document.createElement("tbody");
    var i;
    for (i = 0; i < impact.rows.length; i += 1) {
      var row = impact.rows[i] || {};
      var tr = document.createElement("tr");
      var seasonTd = document.createElement("td");
      seasonTd.className = "twb-season-impact-season";
      seasonTd.textContent = String(safeInt(row.season, 0));
      tr.appendChild(seasonTd);
      tr.appendChild(renderMultiYearImpactCell(row.left_after_dollars, row.left_change_dollars));
      tr.appendChild(renderMultiYearImpactCell(row.right_after_dollars, row.right_change_dollars));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    wrap.appendChild(tableWrap);
    return wrap;
  }

  function renderTradeSummaryColumn(title, items) {
    var wrap = document.createElement("section");
    wrap.className = "twb-trade-summary-side";
    var h = document.createElement("h4");
    h.className = "twb-trade-summary-side-title";
    h.textContent = title;
    wrap.appendChild(h);

    var list = document.createElement("ul");
    list.className = "twb-trade-summary-list";
    var rows = Array.isArray(items) ? items : [];
    if (!rows.length) {
      var liEmpty = document.createElement("li");
      liEmpty.className = "twb-trade-summary-item is-empty";
      liEmpty.textContent = "None";
      list.appendChild(liEmpty);
    } else {
      var i;
      for (i = 0; i < rows.length; i += 1) {
        var li = document.createElement("li");
        li.className = "twb-trade-summary-item";
        li.textContent = rows[i];
        list.appendChild(li);
      }
    }
    wrap.appendChild(list);
    return wrap;
  }

  function summarizeAssetForTradeSummary(asset) {
    if (!asset || typeof asset !== "object") return "";
    if (safeStr(asset.type).toUpperCase() === "PLAYER") return safeStr(asset.player_name);
    if (safeStr(asset.type).toUpperCase() === "PICK") return safeStr(asset.pick_display || asset.description || asset.asset_id);
    return safeStr(asset.player_name || asset.description || asset.asset_id);
  }

  function renderTradeSummary(payload) {
    if (!els.tradeSummaryContent) return;
    els.tradeSummaryContent.innerHTML = "";

    var teams = Array.isArray((payload || {}).teams) ? payload.teams : [];
    var leftTeam = teams[0] || {};
    var rightTeam = teams[1] || {};
    var reconLeft = ((payload || {}).salary_reconciliation || {}).left || {};

    var sendItems = [];
    var receiveItems = [];
    var i;
    var leftAssets = Array.isArray(leftTeam.selected_assets) ? leftTeam.selected_assets : [];
    var rightAssets = Array.isArray(rightTeam.selected_assets) ? rightTeam.selected_assets : [];

    for (i = 0; i < leftAssets.length; i += 1) {
      var sendLabel = summarizeAssetForTradeSummary(leftAssets[i]);
      if (sendLabel) sendItems.push(sendLabel);
    }
    for (i = 0; i < rightAssets.length; i += 1) {
      var receiveLabel = summarizeAssetForTradeSummary(rightAssets[i]);
      if (receiveLabel) receiveItems.push(receiveLabel);
    }

    var salaryAdj = safeInt(reconLeft.salary_trade_adjustment_dollars, 0);
    if (salaryAdj > 0) {
      sendItems.push("Trade Salary: " + moneyFmt(salaryAdj));
    } else if (salaryAdj < 0) {
      receiveItems.push("Salary Relief: " + moneyFmt(Math.abs(salaryAdj)));
    }

    var grid = document.createElement("div");
    grid.className = "twb-trade-summary-grid";
    grid.appendChild(renderTradeSummaryColumn("You Send", sendItems));
    grid.appendChild(renderTradeSummaryColumn("You Receive", receiveItems));
    els.tradeSummaryContent.appendChild(grid);
  }

  function renderOfferAlerts(payload) {
    if (!els.offerAlerts) return;
    els.offerAlerts.innerHTML = "";
    var alerts = [];
    var i;
    for (i = 0; i < alerts.length; i += 1) {
      var alert = document.createElement("div");
      alert.className = "twb-offer-alert twb-offer-alert-bad";
      alert.textContent = alerts[i];
      els.offerAlerts.appendChild(alert);
    }

    if (!alerts.length && payload.validation && Array.isArray(payload.validation.issues) && payload.validation.issues.length) {
      for (i = 0; i < payload.validation.issues.length && i < 2; i += 1) {
        var note = document.createElement("div");
        note.className = "twb-offer-alert";
        note.textContent = payload.validation.issues[i];
        els.offerAlerts.appendChild(note);
      }
    }
  }

  function renderSubmitArea(payload) {
    if (!els.submitOfferBtn || !els.submitOfferStatus) return;
    var intent = getPrimarySubmitIntent(payload);
    var secondaryActions = getSecondarySubmitActions();
    var isBusy = !!state.submit.busy || !!state.offers.actionBusy;
    els.submitOfferBtn.disabled = isBusy || !!intent.disabled;
    els.submitOfferBtn.textContent = isBusy ? intent.busyLabel : intent.label;
    els.submitOfferBtn.setAttribute("data-submit-intent", intent.mode);
    if (els.submitSecondaryRow && els.submitCounterBtn && els.submitRejectBtn) {
      els.submitSecondaryRow.hidden = !secondaryActions.length;
      var actionMap = {};
      var i;
      for (i = 0; i < secondaryActions.length; i += 1) {
        actionMap[secondaryActions[i].mode] = secondaryActions[i];
      }
      var counterAction = actionMap.counter || null;
      var rejectAction = actionMap.reject || null;
      els.submitCounterBtn.hidden = !counterAction;
      els.submitCounterBtn.disabled = isBusy || !!(counterAction && counterAction.disabled);
      if (counterAction) els.submitCounterBtn.textContent = counterAction.label;
      els.submitRejectBtn.hidden = !rejectAction;
      els.submitRejectBtn.disabled = isBusy || !!(rejectAction && rejectAction.disabled);
      if (rejectAction) els.submitRejectBtn.textContent = rejectAction.label;
    }
    if (els.submitRetryBtn) {
      var showRetry = !!state.submit.canRetry;
      els.submitRetryBtn.hidden = !showRetry;
      els.submitRetryBtn.disabled = isBusy;
    }
    els.submitOfferStatus.textContent = state.submit.message || "No offer submitted yet.";
    els.submitOfferStatus.className = "twb-summary-note";
    if (state.submit.tone) {
      els.submitOfferStatus.className += " twb-submit-status-" + state.submit.tone;
    }
    if (els.submitDebugWrap && els.submitDebugPre) {
      var debugObj = state.submit.acceptDebug;
      var hasDebug = !!(debugObj && typeof debugObj === "object");
      els.submitDebugWrap.hidden = !hasDebug;
      if (hasDebug) {
        els.submitDebugPre.textContent = JSON.stringify(debugObj, null, 2);
      } else {
        els.submitDebugPre.textContent = "";
      }
    }
  }

  function renderSummary() {
    var summaryEl = els.summaryContent;
    if (!summaryEl) return;
    summaryEl.innerHTML = "";

    var payload = buildTradePayload();
    var statusPill = els.summaryStatus;
    var ready = payload.validation.status === "ready";
    if (ready) {
      statusPill.textContent = state.counterMode ? "Counter Ready" : "Ready";
    } else {
      statusPill.textContent = state.counterMode ? "Counter Offer Draft" : "Draft";
    }
    statusPill.className = "twb-status-pill " + (ready ? "is-ready" : "is-draft");

    var recon = payload.salary_reconciliation || {};
    var salaryGrid = document.createElement("div");
    salaryGrid.className = "twb-salary-grid";
    salaryGrid.appendChild(
      renderSalaryTeamBlock(
        safeStr((recon.left || {}).franchise_name) || "Your Team",
        recon.left || {}
      )
    );
    salaryGrid.appendChild(
      renderSalaryTeamBlock(
        safeStr((recon.right || {}).franchise_name) || "Trade Partner",
        recon.right || {}
      )
    );
    summaryEl.appendChild(salaryGrid);

    var multiYearImpact = renderMultiYearImpactTable(payload.multi_year_salary_impact);
    if (multiYearImpact) summaryEl.appendChild(multiYearImpact);

    renderTradeSummary(payload);
    renderOfferCart(payload);
    renderOfferAlerts(payload);
    renderSubmitArea(payload);
    updateMobileTabVisibility(payload);
    if (els.payloadPreview) els.payloadPreview.textContent = JSON.stringify(payload, null, 2);
  }

  function rerender() {
    syncControlsLightweight();
    renderBoard();
    renderSummary();
    persistState();
    scheduleParentHeightPost();
  }

  function toggleAsset(teamId, assetId, checked) {
    ensureSelectionMaps(teamId);
    if (checked) {
      var asset = getAssetById(teamId, assetId);
      if (!isTradeEligibleAsset(asset)) return;
      state.selections[teamId][assetId] = true;
    }
    else {
      delete state.selections[teamId][assetId];
      if (state.extensions[teamId]) delete state.extensions[teamId][assetId];
    }
    clampTradeSalaryForTeam(teamId);
  }

  function setExtensionEnabled(teamId, assetId, enabled) {
    ensureSelectionMaps(teamId);
    var asset = getAssetById(teamId, assetId);
    if (!asset || !asset.extension_eligible) return;
    if (!state.extensions[teamId][assetId]) state.extensions[teamId][assetId] = { enabled: false, option_key: "" };
    state.extensions[teamId][assetId].enabled = !!enabled;
    if (!state.extensions[teamId][assetId].option_key && asset.extension_options[0]) {
      state.extensions[teamId][assetId].option_key = safeStr(asset.extension_options[0].option_key);
    }
    if (!enabled) {
      state.extensions[teamId][assetId].enabled = false;
    }
  }

  function setExtensionOption(teamId, assetId, optionKey) {
    ensureSelectionMaps(teamId);
    if (!state.extensions[teamId][assetId]) state.extensions[teamId][assetId] = { enabled: false, option_key: "" };
    state.extensions[teamId][assetId].option_key = safeStr(optionKey);
    if (safeStr(optionKey)) state.extensions[teamId][assetId].enabled = true;
  }

  function setTradeSalary(teamId, value) {
    ensureSelectionMaps(teamId);
    state.tradeSalaryK[teamId] = safeStr(value).replace(/[^0-9]/g, "");
    clampTradeSalaryForTeam(teamId);
  }

  function getRenderedTeamPanels() {
    var out = [];
    var scopes = [els.board, els.partnerBoard];
    var i;
    for (i = 0; i < scopes.length; i += 1) {
      var root = scopes[i];
      if (!root || !root.querySelectorAll) continue;
      var panels = root.querySelectorAll(".twb-team-panel");
      var j;
      for (j = 0; j < panels.length; j += 1) out.push(panels[j]);
    }
    return out;
  }

  function clearTeamSelections(teamId) {
    ensureSelectionMaps(teamId);
    var map = state.selections[teamId] || {};
    var keys = Object.keys(map);
    var i;
    for (i = 0; i < keys.length; i += 1) delete map[keys[i]];
    if (state.extensions[teamId]) {
      var extKeys = Object.keys(state.extensions[teamId]);
      for (i = 0; i < extKeys.length; i += 1) delete state.extensions[teamId][extKeys[i]];
    }
    state.tradeSalaryK[teamId] = "";
    clampTradeSalaryForTeam(teamId);
  }

  function teamSetAllGroups(teamId, openValue) {
    ensureSelectionMaps(teamId);
    var panel = null;
    var panels = getRenderedTeamPanels();
    var p;
    for (p = 0; p < panels.length; p += 1) {
      if (safeStr(panels[p].getAttribute("data-team-id")) === teamId) {
        panel = panels[p];
        break;
      }
    }
    if (!panel) return;
    var groups = panel.querySelectorAll('.twb-group');
    var i;
    for (i = 0; i < groups.length; i += 1) {
      var g = groups[i];
      var gk = g.getAttribute("data-group-key");
      if (!gk) continue;
      state.collapsed[teamId][gk] = !openValue;
    }
  }

  function resetFilterState() {
    state.filters.search = "";
  }

  function clearFilters() {
    resetFilterState();
    state.rightTeamId = "";
  }

  function resetTrade(options) {
    options = options || {};
    var resetPartnerTeam = options.resetPartnerTeam !== false;
    var resetMessage = options.resetMessage !== false;
    var resetExtensions = options.resetExtensions !== false;
    var resetSalary = options.resetSalary !== false;

    state.selections = {};
    if (resetExtensions) state.extensions = {};
    if (resetSalary) state.tradeSalaryK = {};
    state.collapsed = {};
    if (resetPartnerTeam) state.rightTeamId = "";
    state.counterMode = false;
    state.counterSourceOffer = null;
    setReviewContext("draft", {});
    state.mobileTab = "your";
    resetSubmitUiState("No offer submitted yet.", "");
    if (resetMessage && els.offerMessageInput) els.offerMessageInput.value = "";
    closeExtensionModal();
    closeFeedbackModal();
  }

  function copyPayloadToClipboard() {
    var text = els.payloadPreview ? els.payloadPreview.textContent || "" : JSON.stringify(buildTradePayload(), null, 2);
    if (!text) return;

    function done() {
      var prev = els.summaryStatus.textContent;
      els.summaryStatus.textContent = "Copied";
      window.setTimeout(function () {
        renderSummary();
      }, 800);
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () {
        fallbackCopy(text, done);
      });
      return;
    }
    fallbackCopy(text, done);
  }

  function fallbackCopy(text, onDone) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand("copy");
      if (onDone) onDone();
    } catch (e) {
      // ignore
    }
    document.body.removeChild(ta);
  }

  function bindEvents() {
    els.leftTeamSelect.addEventListener("change", function () {
      setActiveFranchiseId(safeStr(this.value), { syncLeft: true });
      initTeamSelectors();
      rerender();
      refreshBannerOffers(true);
    });

    els.rightTeamSelect.addEventListener("change", function () {
      state.rightTeamId = safeStr(this.value);
      if (state.rightTeamId === state.leftTeamId) state.rightTeamId = "";
      initTeamSelectors();
      rerender();
    });

    els.searchInput.addEventListener("input", function () {
      state.filters.search = this.value || "";
      rerender();
    });

    els.clearFiltersBtn.addEventListener("click", function () {
      clearFilters();
      rerender();
    });

    if (els.copyPayloadBtn) els.copyPayloadBtn.addEventListener("click", copyPayloadToClipboard);
    if (els.copyPayloadBtn2) els.copyPayloadBtn2.addEventListener("click", copyPayloadToClipboard);

    if (els.resetBtn) {
      els.resetBtn.addEventListener("click", function () {
        resetTrade({
          resetPartnerTeam: true,
          resetMessage: true,
          resetExtensions: true,
          resetSalary: true
        });
        initTeamSelectors();
        rerender();
      });
    }
    if (els.resetTradeReviewBtn) {
      els.resetTradeReviewBtn.addEventListener("click", function () {
        resetTrade({
          resetPartnerTeam: true,
          resetMessage: true,
          resetExtensions: true,
          resetSalary: true
        });
        initTeamSelectors();
        rerender();
      });
    }

    if (els.submitOfferBtn) {
      els.submitOfferBtn.addEventListener("click", function () {
        runPrimarySubmitAction();
      });
    }
    if (els.submitCounterBtn) {
      els.submitCounterBtn.addEventListener("click", function () {
        runReviewContextAction("counter");
      });
    }
    if (els.submitRejectBtn) {
      els.submitRejectBtn.addEventListener("click", function () {
        runReviewContextAction("reject");
      });
    }
    if (els.submitRetryBtn) {
      els.submitRetryBtn.addEventListener("click", function () {
        retryLastSubmitRequest();
      });
    }

    if (els.extModalOptionSelect) {
      els.extModalOptionSelect.addEventListener("change", function () {
        state.extensionModal.optionKey = safeStr(this.value);
        renderExtensionModalPreview(
          safeStr(state.extensionModal.teamId),
          getExtensionModalAsset(),
          state.extensionModal.optionKey
        );
      });
    }

    if (els.extModalSaveBtn) {
      els.extModalSaveBtn.addEventListener("click", function () {
        saveExtensionModal();
      });
    }

    if (els.extensionModal) {
      els.extensionModal.addEventListener("click", function (evt) {
        var node = evt.target;
        while (node && node !== els.extensionModal) {
          var act = node.getAttribute && node.getAttribute("data-action");
          if (act === "ext-modal-cancel") {
            evt.preventDefault();
            closeExtensionModal();
            return;
          }
          node = node.parentNode;
        }
        if (evt.target === els.extensionModal) {
          closeExtensionModal();
        }
      });
      els.extensionModal.addEventListener("cancel", function (evt) {
        evt.preventDefault();
        closeExtensionModal();
      });
    }

    if (els.feedbackModalCloseBtn) {
      els.feedbackModalCloseBtn.addEventListener("click", function (evt) {
        evt.preventDefault();
        closeFeedbackModal();
      });
    }
    if (els.feedbackModal) {
      els.feedbackModal.addEventListener("cancel", function (evt) {
        evt.preventDefault();
        closeFeedbackModal();
      });
      els.feedbackModal.addEventListener("click", function (evt) {
        if (evt.target === els.feedbackModal) closeFeedbackModal();
      });
    }

    function handleBoardChange(target) {
      if (!target) return;
      var action = target.getAttribute("data-action");
      var teamId;
      var assetId;
      if (action === "toggle-asset") {
        teamId = safeStr(target.getAttribute("data-team-id"));
        assetId = safeStr(target.getAttribute("data-asset-id"));
        toggleAsset(teamId, assetId, !!target.checked);
        rerender();
        return;
      }
      if (action === "set-trade-salary") {
        teamId = safeStr(target.getAttribute("data-team-id"));
        setTradeSalary(teamId, target.value);
        rerender();
      }
    }

    function handleBoardInput(target) {
      if (!target) return;
      var action = target.getAttribute("data-action");
      if (action === "set-trade-salary") {
        var teamId = safeStr(target.getAttribute("data-team-id"));
        setTradeSalary(teamId, target.value);
        renderSummary();
        persistState();
      }
    }

    function handleBoardClick(evt, root) {
      var target = evt.target;
      var action = "";
      while (target && target !== root) {
        action = target.getAttribute && target.getAttribute("data-action");
        if (action) break;
        target = target.parentNode;
      }
      if (!action) return;
      var teamId = safeStr(target.getAttribute("data-team-id"));
      if (action === "team-expand-all") {
        teamSetAllGroups(teamId, true);
        rerender();
      } else if (action === "team-collapse-all") {
        teamSetAllGroups(teamId, false);
        rerender();
      } else if (action === "open-extension-modal") {
        evt.preventDefault();
        evt.stopPropagation();
        openExtensionModal(
          safeStr(target.getAttribute("data-team-id")),
          safeStr(target.getAttribute("data-asset-id"))
        );
      } else if (action === "asset-view") {
        var view = safeStr(target.getAttribute("data-view"));
        setAssetView(teamId, view);
        rerender();
      } else if (action === "choose-discovery-match") {
        var pickedTeamId = safeStr(target.getAttribute("data-team-id"));
        var pickedAssetId = safeStr(target.getAttribute("data-asset-id"));
        if (!pickedTeamId || pickedTeamId === state.leftTeamId) return;
        resetFilterState();
        state.rightTeamId = pickedTeamId;
        ensureSelectionMaps(pickedTeamId);
        if (pickedAssetId) {
          var pickedAsset = getAssetById(pickedTeamId, pickedAssetId);
          if (pickedAsset && isTradeEligibleAsset(pickedAsset)) {
            state.selections[pickedTeamId][pickedAssetId] = true;
          }
        }
        clampTradeSalaryForTeam(pickedTeamId);
        initTeamSelectors();
        rerender();
      }
    }

    function bindBoardSurface(root) {
      if (!root) return;
      root.addEventListener("change", function (evt) { handleBoardChange(evt.target); });
      root.addEventListener("input", function (evt) { handleBoardInput(evt.target); });
      root.addEventListener("click", function (evt) { handleBoardClick(evt, root); });
    }

    bindBoardSurface(els.board);
    bindBoardSurface(els.partnerBoard);

    if (els.offerCart) {
      els.offerCart.addEventListener("click", function (evt) {
        var node = evt.target;
        while (node && node !== els.offerCart) {
          var action = node.getAttribute && node.getAttribute("data-action");
          if (action === "cart-remove-asset") {
            evt.preventDefault();
            toggleAsset(safeStr(node.getAttribute("data-team-id")), safeStr(node.getAttribute("data-asset-id")), false);
            rerender();
            return;
          }
          if (action === "cart-clear-side") {
            evt.preventDefault();
            var side = safeStr(node.getAttribute("data-side"));
            var teamId = side === "left" ? state.leftTeamId : state.rightTeamId;
            if (teamId) {
              clearTeamSelections(teamId);
              rerender();
            }
            return;
          }
          node = node.parentNode;
        }
      });
    }

    if (els.summary) {
      els.summary.addEventListener("toggle", function () {
        scheduleParentHeightPost();
      });
    }

    if (els.mobileTabs) {
      els.mobileTabs.addEventListener("click", function (evt) {
        var node = evt.target;
        while (node && node !== els.mobileTabs) {
          var action = node.getAttribute && node.getAttribute("data-action");
          if (action === "mobile-tab") {
            evt.preventDefault();
            state.mobileTab = safeStr(node.getAttribute("data-mobile-tab")) || "your";
            updateMobileTabVisibility(buildTradePayload());
            scheduleParentHeightPost();
            return;
          }
          node = node.parentNode;
        }
      });
    }

    if (els.offerCartMobileTray) {
      els.offerCartMobileTray.addEventListener("click", function () {
        state.mobileTab = "review";
        updateMobileTabVisibility(buildTradePayload());
        scheduleParentHeightPost();
      });
    }

    if (els.app) {
      els.app.addEventListener("click", function (evt) {
        var node = evt.target;
        while (node && node !== els.app) {
          var action = node.getAttribute && node.getAttribute("data-action");
          if (!action) {
            node = node.parentNode;
            continue;
          }
          if (
            action === "load-offer" ||
            action === "build-counter" ||
            action === "counter-offer" ||
            action === "offer-counter" ||
            action === "offer-accept" ||
            action === "offer-reject" ||
            action === "offer-revoke"
          ) {
            evt.preventDefault();
            evt.stopPropagation();
            if (evt.stopImmediatePropagation) evt.stopImmediatePropagation();
            var bucket = safeStr(node.getAttribute("data-offer-bucket")) || "received";
            var offerId = safeStr(node.getAttribute("data-offer-id"));
            var offer = getOfferFromBannerState(bucket, offerId);
            if (!offer) {
              setSubmitStatus("Offer no longer available in MFL.", "warn");
              renderSummary();
              return;
            }
            if (!offerCanHydratePayload(offer) && (action === "offer-counter" || action === "build-counter" || action === "counter-offer" || action === "load-offer")) {
              setSubmitStatus("Could not load that offer payload.", "bad");
              renderSummary();
              return;
            }

            if (action === "offer-accept") {
              performOfferAction("ACCEPT", { bucket: bucket, offer: offer });
            } else if (action === "offer-reject") {
              performOfferAction("REJECT", { bucket: bucket, offer: offer });
            } else if (action === "offer-revoke") {
              performOfferAction("REVOKE", { bucket: bucket, offer: offer });
            } else if (action === "offer-counter" || action === "build-counter" || action === "counter-offer") {
              try {
                sessionStorage.setItem("twb_counter_offer_id", safeStr(offerId));
                sessionStorage.setItem("twb_mode", "counter");
              } catch (e) {
                // noop
              }
              performOfferAction("COUNTER", { bucket: bucket, offer: offer });
            } else {
              var payload = getOfferPayloadForWorkbench(offer, {
                actingTeamId: getActiveFranchiseId(),
                keepOriginalOrientation: false
              });
              if (!payload) {
                setSubmitStatus("Could not load that offer payload.", "bad");
                renderSummary();
                return;
              }
              loadOfferIntoWorkbench(payload, {
                sourceOffer: offer,
                offerBucket: bucket,
                tradeId: getOfferTradeId(offer),
                reviewKind: bucket === "received" ? "incoming" : (bucket === "offered" ? "outgoing" : "draft"),
                loadedMessage: bucket === "received"
                  ? "Incoming offer loaded. Review and accept."
                  : (bucket === "offered" ? "Offered trade loaded. You can revoke it." : "Offer loaded.")
              });
            }
            var dd = node.closest && node.closest("details");
            if (dd) dd.removeAttribute("open");
            return;
          }
          node = node.parentNode;
        }
      });
    }

    if (window.addEventListener) {
      window.addEventListener("resize", function () {
        updateMobileTabVisibility(buildTradePayload());
      });
    }
  }

  function collectDomRefs() {
    els.app = q("twbApp");
    els.toolbar = q("twbApp");
    els.leftTeamSelect = q("twbLeftTeamSelect");
    els.rightTeamSelect = q("twbRightTeamSelect");
    els.searchInput = q("twbSearchInput");
    els.clearFiltersBtn = q("twbClearFiltersBtn");
    els.copyPayloadBtn = q("twbCopyPayloadBtn");
    els.copyPayloadBtn2 = q("twbCopyPayloadBtn2");
    els.resetBtn = q("twbResetBtn");
    els.resetTradeReviewBtn = q("twbResetTradeReviewBtn");
    els.offeredCount = q("twbOfferedCount");
    els.receivedCount = q("twbReceivedCount");
    els.offeredList = q("twbOfferedList");
    els.receivedList = q("twbReceivedList");
    els.board = q("twbBoard");
    els.partnerBoard = q("twbPartnerBoard");
    els.yourAssetsPanel = q("twbYourAssetsPanel");
    els.partnerAssetsPanel = q("twbPartnerAssetsPanel");
    els.offerCart = q("twbOfferCart");
    els.offerCartLeftList = q("twbOfferCartLeftList");
    els.offerCartRightList = q("twbOfferCartRightList");
    els.offerCartLeftTitle = q("twbOfferCartLeftTitle");
    els.offerCartRightTitle = q("twbOfferCartRightTitle");
    els.offerCartStatus = q("twbOfferCartStatus");
    els.counterSourcePanel = q("twbCounterSourcePanel");
    els.counterSourceContent = q("twbCounterSourceContent");
    els.offerAlerts = q("twbOfferAlerts");
    els.offerSalaryPanel = q("twbOfferSalaryPanel");
    els.offerCartMobileTray = q("twbOfferCartMobileTray");
    els.mobileTabs = q("twbMobileTabs");
    els.mobileTabButtons = els.mobileTabs ? els.mobileTabs.querySelectorAll('[data-action="mobile-tab"]') : [];
    els.summary = q("twbSummary");
    els.summaryContent = q("twbSummaryContent");
    els.summaryStatus = q("twbSummaryStatus");
    els.tradeSummaryPanel = q("twbTradeSummaryPanel");
    els.tradeSummaryContent = q("twbTradeSummaryContent");
    els.payloadPreview = q("twbPayloadPreview");
    els.offerMessageInput = q("twbOfferMessageInput");
    els.submitOfferBtn = q("twbSubmitOfferBtn");
    els.submitRetryBtn = q("twbSubmitRetryBtn");
    els.submitSecondaryRow = q("twbSubmitSecondaryRow");
    els.submitCounterBtn = q("twbSubmitCounterBtn");
    els.submitRejectBtn = q("twbSubmitRejectBtn");
    els.submitOfferStatus = q("twbSubmitOfferStatus");
    els.submitDebugWrap = q("twbSubmitDebugWrap");
    els.submitDebugPre = q("twbSubmitDebugPre");
    els.extensionModal = q("twbExtensionModal");
    els.extModalPlayer = q("twbExtModalPlayer");
    els.extModalOptionSelect = q("twbExtModalOptionSelect");
    els.extModalPreview = q("twbExtModalPreview");
    els.extModalSaveBtn = q("twbExtModalSaveBtn");
    els.feedbackModal = q("twbFeedbackModal");
    els.feedbackModalShell = els.feedbackModal ? els.feedbackModal.querySelector(".twb-feedback-modal-shell") : null;
    els.feedbackModalTitle = q("twbFeedbackModalTitle");
    els.feedbackModalMessage = q("twbFeedbackModalMessage");
    els.feedbackModalCloseBtn = q("twbFeedbackModalCloseBtn");
  }

  function seedInitialTeams() {
    var teams = state.data.teams || [];
    if (!teams.length) return;
    var lockedLeft = getLockedLeftTeamId();
    var meta = (state.data && state.data.meta) || {};
    var preferredFromMeta = pad4(
      meta.active_franchise_id ||
      meta.default_franchise_id ||
      meta.logged_in_franchise_id ||
      ""
    );
    var preferredActive = pad4(
      preferredFromMeta ||
      state.activeFranchiseId ||
      state.leftTeamId ||
      ""
    );
    if (!preferredActive || !getTeamById(preferredActive)) {
      preferredActive = teams[0].franchise_id;
    }
    if (lockedLeft) {
      setActiveFranchiseId(lockedLeft, { syncLeft: true });
    } else {
      setActiveFranchiseId(preferredActive, { syncLeft: true });
    }
    if (!state.rightTeamId || !getTeamById(state.rightTeamId) || state.rightTeamId === state.leftTeamId) {
      state.rightTeamId = "";
    }
  }

  function showError(err) {
    var errorHtml = '<div class="twb-error-state">Could not load Trade War Room data. ' + escapeHtml(err && err.message ? err.message : String(err)) + '</div>';
    if (els.board) els.board.innerHTML = errorHtml;
    if (els.partnerBoard) els.partnerBoard.innerHTML = errorHtml;
    if (els.summaryContent) {
      els.summaryContent.innerHTML = '<div class="twb-error-state">Load failed.</div>';
    }
    if (els.payloadPreview) {
      els.payloadPreview.textContent = "{}";
    }
    scheduleParentHeightPost();
  }

  async function boot() {
    collectDomRefs();
    if (!els.app) return;
    installHeightSync();
    restoreState();

    if (els.board) els.board.innerHTML = '<div class="twb-loading">Loading Trade War Room…</div>';
    if (els.partnerBoard) els.partnerBoard.innerHTML = '<div class="twb-loading">Loading partner assets…</div>';

    try {
      var raw;
      try {
        raw = await loadData();
      } catch (firstErr) {
        await new Promise(function (resolve) { setTimeout(resolve, 350); });
        raw = await loadData();
      }
      state.data = await normalizeDataWithFallbacks(raw);
      if (!state.data.teams.length) throw new Error("No teams in data payload.");

      seedInitialTeams();
      if (!getUrlParam("twb_load_offer")) {
        resetTrade({
          resetPartnerTeam: true,
          resetMessage: true,
          resetExtensions: true,
          resetSalary: true
        });
      }
      applyRosterDeepLinkSelection();
      initializeControlsFromState();
      bindEvents();
      state.uiReady = true;
      rerender();
      await refreshBannerOffers(true);
      await hydrateOfferFromUrlIfNeeded();

      window.upsTradeWorkbench = {
        state: state,
        normalizeData: normalizeData,
        buildTradePayload: buildTradePayload,
        rerender: rerender,
        submitOfferToQueue: submitOfferToQueue,
        replayOutbox: replayOutbox,
        loadOfferIntoWorkbench: loadOfferIntoWorkbench,
        refreshBannerOffers: refreshBannerOffers,
        hydrateOfferFromUrlIfNeeded: hydrateOfferFromUrlIfNeeded
      };
      window.loadOfferIntoWorkbench = loadOfferIntoWorkbench;
      postParentHeight(true);
    } catch (err) {
      showError(err);
      console.error("Trade War Room load failed", err);
      postParentHeight(true);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
