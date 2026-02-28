(function () {
  "use strict";

  var SAMPLE_DATA_URL = "./trade_workbench_sample.json";
  var STORAGE_KEY = "ups-trade-workbench-state-v5";
  var GROUP_ORDER = ["QB", "RB", "WR", "TE", "PK", "PN", "DT", "DE", "LB", "CB", "S", "DL", "DB", "PICKS", "OTHER"];
  var heightSyncInstalled = false;
  var heightPostTimer = 0;
  var lastPostedHeight = 0;

  var state = {
    data: null,
    uiReady: false,
    leftTeamId: "",
    rightTeamId: "",
    selections: {},
    extensions: {},
    tradeSalaryK: {},
    assetView: {},
    filters: {
      search: "",
      activeContractTypes: {},
      yearsMin: "",
      yearsMax: "",
      showTaxi: true,
      showPicks: true,
      onlyExtensionEligible: false
    },
    collapsed: {},
    submit: {
      busy: false,
      message: "No offer submitted yet.",
      tone: ""
    },
    mobileTab: "your"
  };

  var els = {};

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

  function pad4(v) {
    var digits = safeStr(v).replace(/\D/g, "");
    if (!digits) return "";
    return ("0000" + digits).slice(-4);
  }

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
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
    var fromQuery = getDirectMflFromQuery();
    if (fromQuery) return parseBool(fromQuery, true);
    if (window.UPS_TWB_DIRECT_MFL != null) return parseBool(window.UPS_TWB_DIRECT_MFL, true);
    if (window.UPS_TRADE_WORKBENCH_DIRECT_MFL != null) return parseBool(window.UPS_TRADE_WORKBENCH_DIRECT_MFL, true);
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
    if (asset.type !== "PLAYER") return true;
    if (asset.years === 0 && !isRookieContractType(asset.contract_type)) return false;
    return true;
  }

  function getTradeIneligibleReason(asset) {
    if (!asset) return "";
    if (asset.type === "PLAYER" && asset.years === 0 && !isRookieContractType(asset.contract_type)) {
      return "Ineligible: 0 years left and not a rookie contract";
    }
    return "";
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

  function normalizeAsset(raw, teamId, extensionIndex) {
    raw = raw || {};
    var type = safeStr(raw.type || (raw.player_id ? "PLAYER" : "PICK")).toUpperCase();
    var asset = {
      asset_id: safeStr(raw.asset_id),
      type: type,
      franchise_id: pad4(raw.franchise_id || teamId),
      selected_default: parseBool(raw.selected_default, false)
    };

    if (type === "PICK") {
      asset.asset_id = asset.asset_id || ("pick:" + safeStr(raw.pick_key || raw.description || raw.asset_id));
      asset.description = safeStr(raw.description || raw.label || "Draft Pick");
      asset.pick_season = safeInt(raw.pick_season || raw.season, 0);
      asset.pick_round = safeInt(raw.pick_round || raw.round, 0);
      asset.pick_slot = safeStr(raw.pick_slot || raw.slot || raw.pick);
      asset.salary = 0;
      asset.years = null;
      asset.contract_type = "Pick";
      asset.contract_info = safeStr(raw.contract_info || "");
      asset.taxi = false;
      asset.extension_options = [];
      asset.extension_eligible = false;
      asset.position = "";
      asset.search_text = (asset.description + " " + asset.contract_info).toLowerCase();
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
    asset.years = raw.years == null || raw.years === "" ? null : safeInt(raw.years, 0);
    asset.contract_type = safeStr(raw.contract_type || raw.contractstatus || raw.contractStatus || raw.type_label || raw.contract);
    asset.contract_info = safeStr(raw.contract_info || raw.contractInfo || raw.details);
    asset.taxi = parseBool(raw.taxi, false);
    asset.injury = safeStr(raw.injury || raw.status || "");
    asset.notes = safeStr(raw.notes || "");

    var extOptions = Array.isArray(raw.extension_options) ? clone(raw.extension_options) : null;
    if (!extOptions) {
      var extKey = [asset.franchise_id, asset.player_id].join("|");
      extOptions = extensionIndex[extKey] ? clone(extensionIndex[extKey]) : [];
    }
    asset.extension_options = extOptions;
    asset.extension_eligible = extOptions.length > 0 || parseBool(raw.extension_eligible, false);

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
          var asset = normalizeAsset(assets[j], teamId, extensionIndex);
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
          t2.assets.push(normalizeAsset(rosterAssets[k], fId, extensionIndex));
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
        salary_cap_dollars: salaryCapDollars
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

  function buildApiRequestUrlFromQuery() {
    var apiUrl = getApiUrlFromQuery();
    if (!apiUrl) return "";

    var params = new URLSearchParams(window.location.search || "");
    var finalUrl = resolveRelativeUrl(apiUrl);
    try {
      var u = new URL(finalUrl, window.location.href);
      var forwardKeys = ["L", "YEAR", "F", "FRANCHISE_ID", "franchise_id", "EXT_URL", "extension_previews_url"];
      var i;
      for (i = 0; i < forwardKeys.length; i += 1) {
        var k = forwardKeys[i];
        if (u.searchParams.has(k)) continue;
        var v = safeStr(params.get(k));
        if (v) u.searchParams.set(k, v);
      }
      finalUrl = u.toString();
    } catch (e) {
      // ignore URL parsing issues and use the raw value
    }
    return finalUrl;
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

  async function loadData() {
    if (window.UPS_TRADE_WORKBENCH_DATA) return window.UPS_TRADE_WORKBENCH_DATA;

    var queryDataUrl = getDataUrlFromQuery();
    if (queryDataUrl) {
      return fetchJson(resolveRelativeUrl(queryDataUrl));
    }

    var queryApiUrl = buildApiRequestUrlFromQuery();
    if (queryApiUrl) {
      return fetchJson(queryApiUrl);
    }

    return fetchJson(resolveRelativeUrl(SAMPLE_DATA_URL));
  }

  function resolveTradeOffersApiUrl() {
    var explicit = safeStr(window.UPS_TRADE_OFFERS_API || window.UPS_TRADE_WORKBENCH_OFFERS_API);
    if (explicit) return resolveRelativeUrl(explicit);

    var apiUrl = buildApiRequestUrlFromQuery();
    if (apiUrl) {
      try {
        var u = new URL(apiUrl, window.location.href);
        u.search = "";
        u.hash = "";
        u.pathname = String(u.pathname || "").replace(/\/trade-workbench\/?$/i, "/trade-offers");
        return u.toString();
      } catch (e) {
        // ignore
      }
    }

    return "https://upsmflproduction.keith-creelman.workers.dev/trade-offers";
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

  function setSubmitStatus(message, tone) {
    state.submit.message = safeStr(message) || "";
    state.submit.tone = safeStr(tone) || "";
  }

  function friendlyOfferError(prefix, err) {
    var msg = err && err.message ? String(err.message) : String(err);
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

  function extensionYearsText(termRaw) {
    var term = safeStr(termRaw).toUpperCase();
    if (!term) return "unknown term";
    var m = term.match(/(\d+)/);
    if (!m) return termRaw || term;
    var n = safeInt(m[1], 0);
    if (!n) return termRaw || term;
    return String(n) + " year" + (n === 1 ? "" : "s");
  }

  function composeStructuredOfferMessage(payload, userMessage) {
    var parts = [];
    var extReqs = Array.isArray((payload || {}).extension_requests) ? payload.extension_requests : [];
    var i;
    for (i = 0; i < extReqs.length; i += 1) {
      var req = extReqs[i] || {};
      var playerName = safeStr(req.player_name || "Player");
      var yearsText = extensionYearsText(req.extension_term || req.option_key || "");
      var aavText = req.new_aav_future == null ? "n/a" : kFmtFromDollars(req.new_aav_future);
      var tcvText = req.new_TCV == null ? "n/a" : kFmtFromDollars(req.new_TCV);
      var contractInfo = safeStr(req.preview_contract_info_string || req.new_contract_status || "");
      var sentence = "You extend " + playerName + " " + yearsText + ", new AAV " + aavText + ", TCV " + tcvText;
      if (contractInfo) sentence += ", contract info " + contractInfo;
      parts.push(sentence);
    }

    var user = safeStr(userMessage);
    if (user) parts.push('User comments "' + user + '"');
    return parts.join(" | ");
  }

  async function submitOfferToQueue() {
    if (state.submit.busy) return;
    var directMfl = isDirectMflMode();
    var payload = buildTradePayload();
    if (!payload.validation || payload.validation.status !== "ready") {
      setSubmitStatus("Trade is not ready. Select assets on both sides and keep traded salary within max.", "warn");
      renderSummary();
      return;
    }
    var leftTeam = getTeamById(state.leftTeamId);
    var rightTeam = getTeamById(state.rightTeamId);
    if (!leftTeam || !rightTeam) {
      setSubmitStatus("Select both teams before submitting.", "warn");
      renderSummary();
      return;
    }

    state.submit.busy = true;
    setSubmitStatus(directMfl ? "Submitting offer to MFL…" : "Submitting offer…", "");
    renderSummary();

    try {
      var userMessage = els.offerMessageInput ? safeStr(els.offerMessageInput.value).slice(0, 2000) : "";
      var structuredMessage = composeStructuredOfferMessage(payload, userMessage);
      var apiUrl = new URL(resolveTradeOffersApiUrl(), window.location.href);
      var body = {
        league_id: safeStr(state.data.meta.league_id),
        season: state.data.meta.season || null,
        from_franchise_id: safeStr(state.leftTeamId),
        to_franchise_id: safeStr(state.rightTeamId),
        from_franchise_name: leftTeam.franchise_name,
        to_franchise_name: rightTeam.franchise_name,
        message: structuredMessage,
        payload: payload,
        source: "trade-workbench-ui",
        direct_mfl: directMfl,
        submit_mode: directMfl ? "mfl" : "queue"
      };
      var res = await fetchJsonRequest(apiUrl.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (directMfl) {
        var mflTradeId = safeStr((res.mfl || {}).trade_id);
        setSubmitStatus(
          "Offer submitted to MFL" + (mflTradeId ? " (Trade ID " + mflTradeId + ")." : "."),
          "good"
        );
      } else {
        setSubmitStatus("Offer submitted.", "good");
      }
      if (els.offerMessageInput) els.offerMessageInput.value = "";
    } catch (err) {
      setSubmitStatus(friendlyOfferError("Submit failed", err), "bad");
    } finally {
      state.submit.busy = false;
      renderSummary();
    }
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

  function getLockedLeftTeamId() {
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
      }
      state.selections = parsed.selections && typeof parsed.selections === "object" ? parsed.selections : state.selections;
      state.extensions = parsed.extensions && typeof parsed.extensions === "object" ? parsed.extensions : state.extensions;
      state.tradeSalaryK = parsed.tradeSalaryK && typeof parsed.tradeSalaryK === "object" ? parsed.tradeSalaryK : state.tradeSalaryK;
      state.assetView = parsed.assetView && typeof parsed.assetView === "object" ? parsed.assetView : state.assetView;
      state.collapsed = parsed.collapsed && typeof parsed.collapsed === "object" ? parsed.collapsed : state.collapsed;
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

  function getTeamTotals(teamId) {
    ensureSelectionMaps(teamId);
    var team = getTeamById(teamId);
    var out = {
      selectedCount: 0,
      selectedPlayers: 0,
      selectedPicks: 0,
      selectedTaxiPlayers: 0,
      selectedNonTaxiSalary: 0,
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
      } else {
        out.selectedNonTaxiSalary += safeInt(a.salary, 0);
      }
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

  function activeFilterCount(mapObj) {
    var keys = Object.keys(mapObj || {});
    var count = 0;
    var i;
    for (i = 0; i < keys.length; i += 1) if (mapObj[keys[i]]) count += 1;
    return count;
  }

  function assetMatchesFilters(asset, teamId, overrides) {
    var f = state.filters;
    overrides = overrides || {};
    var showPicks = overrides.showPicks != null ? !!overrides.showPicks : !!f.showPicks;
    var showTaxi = overrides.showTaxi != null ? !!overrides.showTaxi : !!f.showTaxi;
    if (!asset) return false;

    if (asset.type === "PICK") {
      if (!showPicks) return false;
      if (f.onlyExtensionEligible) return false;
    }

    if (asset.type === "PLAYER") {
      if (!showTaxi && asset.taxi) return false;
      if (f.onlyExtensionEligible && !asset.extension_eligible) return false;

      if (activeFilterCount(f.activeContractTypes) > 0) {
        if (!f.activeContractTypes[safeStr(asset.contract_type)]) return false;
      }

      var yearsMin = safeStr(f.yearsMin);
      var yearsMax = safeStr(f.yearsMax);
      if (yearsMin && asset.years != null && asset.years < safeInt(yearsMin, 0)) return false;
      if (yearsMax && asset.years != null && asset.years > safeInt(yearsMax, 99)) return false;
      if ((yearsMin || yearsMax) && asset.years == null) return false;
    }

    var search = safeStr(f.search).toLowerCase();
    var skipSearchForTeam = !!teamId && teamId === state.leftTeamId;
    if (!skipSearchForTeam && search && asset.search_text.indexOf(search) === -1) return false;

    return true;
  }

  function getAssetView(teamId) {
    var view = safeStr(state.assetView && state.assetView[teamId]).toLowerCase();
    if (view === "picks" || view === "taxi") return view;
    return "players";
  }

  function setAssetView(teamId, view) {
    if (!teamId) return;
    var normalized = safeStr(view).toLowerCase();
    if (normalized !== "picks" && normalized !== "taxi") normalized = "players";
    if (!state.assetView || typeof state.assetView !== "object") state.assetView = {};
    state.assetView[teamId] = normalized;
  }

  function assetMatchesFiltersWithView(asset, teamId, view) {
    var normalized = safeStr(view).toLowerCase();
    var overrides = {};
    if (normalized === "picks") overrides.showPicks = true;
    if (normalized === "taxi") overrides.showTaxi = true;
    return assetMatchesFilters(asset, teamId, overrides);
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
        if (asset.type === "PICK") out.push(asset);
        continue;
      }
      if (view === "players" && asset.type === "PICK") continue;
      if (view === "taxi" && !(asset.type === "PLAYER" && !!asset.taxi)) continue;
      if (assetMatchesFiltersWithView(asset, teamId, view)) out.push(asset);
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
    var leftTeam = null;
    var i;
    if (lockedLeftId) {
      state.leftTeamId = lockedLeftId;
      leftTeam = getTeamById(lockedLeftId);
      left.appendChild(optionEl(lockedLeftId, leftTeam ? leftTeam.franchise_name : lockedLeftId));
      left.disabled = true;
    } else {
      left.disabled = false;
      for (i = 0; i < teams.length; i += 1) {
        left.appendChild(optionEl(teams[i].franchise_id, teams[i].franchise_name));
      }
      if (!state.leftTeamId || !getTeamById(state.leftTeamId)) {
        state.leftTeamId = teams[0] ? teams[0].franchise_id : "";
      }
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

  function initYearFilters() {
    var maxYears = 3;
    var i;
    var selects = [els.yearsMinSelect, els.yearsMaxSelect];
    for (i = 0; i < selects.length; i += 1) {
      var s = selects[i];
      if (!s) continue;
      s.innerHTML = "";
      s.appendChild(optionEl("", "Any"));
      var y;
      for (y = 0; y <= maxYears; y += 1) {
        s.appendChild(optionEl(String(y), String(y)));
      }
    }
    els.yearsMinSelect.value = safeStr(state.filters.yearsMin);
    els.yearsMaxSelect.value = safeStr(state.filters.yearsMax);
  }

  function initContractTypeFilters() {
    var wrap = els.contractTypeOptions;
    if (!wrap) return;
    wrap.innerHTML = "";
    var types = state.data.filtersMeta.contractTypes || [];
    var i;
    for (i = 0; i < types.length; i += 1) {
      var id = "twb-ct-" + i;
      var label = document.createElement("label");
      label.className = "twb-check";
      label.setAttribute("for", id);
      var input = document.createElement("input");
      input.type = "checkbox";
      input.id = id;
      input.setAttribute("data-action", "toggle-contract-type-filter");
      input.setAttribute("data-contract-type", types[i]);
      input.checked = !!state.filters.activeContractTypes[types[i]];
      var text = document.createElement("span");
      text.textContent = types[i];
      label.appendChild(input);
      label.appendChild(text);
      wrap.appendChild(label);
    }
  }

  function initBooleanToggles() {
    var wrap = els.booleanToggles;
    if (!wrap) return;
    wrap.innerHTML = "";
    var defs = [
      { key: "showTaxi", label: "Show Taxi" },
      { key: "showPicks", label: "Show Picks" },
      { key: "onlyExtensionEligible", label: "Ext Eligible Only" }
    ];
    var i;
    for (i = 0; i < defs.length; i += 1) {
      var def = defs[i];
      var id = "twb-toggle-" + def.key;
      var label = document.createElement("label");
      label.className = "twb-toggle";
      label.setAttribute("for", id);
      var input = document.createElement("input");
      input.type = "checkbox";
      input.id = id;
      input.checked = !!state.filters[def.key];
      input.setAttribute("data-action", "toggle-bool-filter");
      input.setAttribute("data-filter-key", def.key);
      var span = document.createElement("span");
      span.textContent = def.label;
      label.appendChild(input);
      label.appendChild(span);
      wrap.appendChild(label);
    }
  }

  function initializeControlsFromState() {
    els.searchInput.value = safeStr(state.filters.search);
    initTeamSelectors();
    initYearFilters();
    initContractTypeFilters();
    initBooleanToggles();
  }

  function syncControlsLightweight() {
    if (els.leftTeamSelect) els.leftTeamSelect.value = state.leftTeamId;
    if (els.rightTeamSelect) els.rightTeamSelect.value = state.rightTeamId;
    if (els.yearsMinSelect) els.yearsMinSelect.value = safeStr(state.filters.yearsMin);
    if (els.yearsMaxSelect) els.yearsMaxSelect.value = safeStr(state.filters.yearsMax);
    if (els.searchInput && els.searchInput.value !== safeStr(state.filters.search)) {
      els.searchInput.value = safeStr(state.filters.search);
    }
    initContractTypeFilters();
    initBooleanToggles();
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
    var panel = document.createElement("section");
    panel.className = "twb-team-panel twb-card twb-discovery-panel";

    var h = document.createElement("h2");
    h.className = "twb-team-title";
    h.textContent = "Find Trade Partner";
    panel.appendChild(h);

    var searchVal = safeStr(state.filters.search);
    var helper = document.createElement("div");
    helper.className = "twb-summary-note";
    if (!searchVal) {
      helper.textContent = "Select a trade partner above, or type a player/pick in Search to scan all other teams.";
      panel.appendChild(helper);
      return panel;
    }

    var matches = collectDiscoverableMatches(leftTeam.franchise_id);
    if (!matches.length) {
      helper.textContent = "No matching assets found across other teams for this search/filter.";
      panel.appendChild(helper);
      return panel;
    }

    var cap = 120;
    var shown = matches.slice(0, cap);
    helper.textContent =
      "Search matches across all teams: " + shown.length + (matches.length > cap ? " of " + matches.length : "") +
      ". Click one to set Trade Partner and add it to the offer.";
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
        : safeStr(m.asset.description || "Draft Pick");
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

    var title = node.querySelector(".twb-team-title");
    var eyebrow = node.querySelector(".twb-team-eyebrow");
    var meta = node.querySelector(".twb-team-meta");
    var logo = node.querySelector(".twb-team-logo");
    var logoFallback = node.querySelector(".twb-team-logo-fallback");
    var logoShell = node.querySelector(".twb-team-logo-shell");
    var assetToggle = node.querySelector(".twb-asset-toggle");
    var groupsWrap = node.querySelector(".twb-team-groups");
    var salaryInput = node.querySelector(".twb-trade-salary-input");
    var salaryMaxValue = node.querySelector(".twb-trade-salary-max-value");

    eyebrow.textContent = "";
    title.textContent = team.franchise_name;
    meta.textContent = "";

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

    var visibleAssets = getVisibleAssetsForTeam(team.franchise_id);
    if (!visibleAssets.length) {
      var empty = document.createElement("div");
      empty.className = "twb-empty-state";
      empty.textContent = "No assets match current filters for this team.";
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

  function renderExtensionCell(teamId, asset, selected) {
    var td = document.createElement("td");
    td.className = "twb-col-ext";
    td.setAttribute("data-label", "Extend");

    if (asset.type !== "PLAYER") {
      td.innerHTML = '<span class="twb-ext-none">—</span>';
      return td;
    }

    if (!asset.extension_eligible || !asset.extension_options.length) {
      td.innerHTML = '<span class="twb-ext-none">Not eligible</span>';
      return td;
    }

    var extState = (state.extensions[teamId] && state.extensions[teamId][asset.asset_id]) || { enabled: false, option_key: "" };
    var box = document.createElement("div");
    box.className = "twb-ext-box";

    var ctl = document.createElement("label");
    ctl.className = "twb-ext-ctl";
    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!extState.enabled;
    cb.disabled = !selected;
    cb.setAttribute("data-action", "toggle-extension");
    cb.setAttribute("data-team-id", teamId);
    cb.setAttribute("data-asset-id", asset.asset_id);
    var span = document.createElement("span");
    span.textContent = selected ? "Extend for acquirer" : "Select player first";
    ctl.appendChild(cb);
    ctl.appendChild(span);
    box.appendChild(ctl);

    var select = document.createElement("select");
    select.className = "twb-ext-select";
    select.disabled = !selected || !extState.enabled;
    select.setAttribute("data-action", "set-extension-option");
    select.setAttribute("data-team-id", teamId);
    select.setAttribute("data-asset-id", asset.asset_id);

    var defaultKey = safeStr(extState.option_key);
    if (!defaultKey && asset.extension_options[0]) defaultKey = safeStr(asset.extension_options[0].option_key || "");
    select.appendChild(optionEl("", "Choose term"));

    var i;
    for (i = 0; i < asset.extension_options.length; i += 1) {
      var opt = asset.extension_options[i];
      var label = opt.label;
      if (opt.new_aav_future != null) label += " · AAV " + kFmtFromDollars(opt.new_aav_future);
      var option = optionEl(opt.option_key, label);
      if (defaultKey && opt.option_key === defaultKey) option.selected = true;
      select.appendChild(option);
    }

    box.appendChild(select);
    td.appendChild(box);
    return td;
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

    tr.appendChild(renderExtensionCell(teamId, asset, selected));

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
      pillPick.textContent = "PICK";
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
    name.textContent = asset.type === "PICK" ? asset.description : buildPlayerLabel(asset);
    line.appendChild(name);

    main.appendChild(line);

    var subText = "";
    if (asset.type === "PLAYER") {
      var pieces = [];
      if (asset.injury) pieces.push(asset.injury);
      if (asset.notes) pieces.push(asset.notes);
      subText = pieces.join(" · ");
    } else {
      subText = "";
    }
    if (subText) {
      var sub = document.createElement("div");
      sub.className = "twb-asset-sub";
      sub.textContent = subText;
      main.appendChild(sub);
    }
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
    tdSalary.innerHTML = '<span class="twb-money">' + (asset.type === "PLAYER" ? escapeHtml(moneyFmt(asset.salary)) : "—") + '</span>';
    tr.appendChild(tdSalary);

    var tdYears = document.createElement("td");
    tdYears.className = "twb-col-years";
    tdYears.setAttribute("data-label", "Years");
    tdYears.innerHTML = '<span class="twb-years">' + (asset.type === "PLAYER" && asset.years != null ? escapeHtml(String(asset.years)) : "—") + '</span>';
    tr.appendChild(tdYears);

    var tdContract = document.createElement("td");
    tdContract.className = "twb-col-contract";
    tdContract.setAttribute("data-label", "Type");
    tdContract.innerHTML = '<div class="twb-contract-info">' + escapeHtml(asset.type === "PICK" ? "Pick" : (asset.contract_type || "—")) + '</div>';
    tr.appendChild(tdContract);

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
      if (!asset || asset.type !== "PLAYER") continue;
      if (asset.taxi) continue;
      total += safeInt(asset.salary, 0);
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

  function buildSalaryReconciliation(leftTeam, rightTeam, leftTotals, rightTotals, leftTradeK, rightTradeK) {
    var leftAvailableBefore = resolveTeamAvailableSalaryDollars(state.leftTeamId);
    var rightAvailableBefore = resolveTeamAvailableSalaryDollars(state.rightTeamId);
    var leftOutgoing = safeInt(leftTotals.selectedNonTaxiSalary, 0);
    var rightOutgoing = safeInt(rightTotals.selectedNonTaxiSalary, 0);
    var leftIncoming = rightOutgoing;
    var rightIncoming = leftOutgoing;
    var leftNetTradeK = leftTradeK - rightTradeK;
    var rightNetTradeK = rightTradeK - leftTradeK;
    var leftNetChange = leftOutgoing - leftIncoming - (leftNetTradeK * 1000);
    var rightNetChange = rightOutgoing - rightIncoming - (rightNetTradeK * 1000);
    var leftAvailableAfter = leftAvailableBefore == null ? null : leftAvailableBefore + leftNetChange;
    var rightAvailableAfter = rightAvailableBefore == null ? null : rightAvailableBefore + rightNetChange;
    var leftOverCap = leftAvailableAfter != null && leftAvailableAfter < 0 ? Math.abs(leftAvailableAfter) : 0;
    var rightOverCap = rightAvailableAfter != null && rightAvailableAfter < 0 ? Math.abs(rightAvailableAfter) : 0;

    return {
      left: {
        franchise_id: leftTeam ? leftTeam.franchise_id : "",
        franchise_name: leftTeam ? leftTeam.franchise_name : "",
        outgoing_dollars: leftOutgoing,
        incoming_dollars: leftIncoming,
        trade_salary_adjustment_k: leftTradeK,
        trade_salary_adjustment_max_k: getTradeSalaryMaxK(state.leftTeamId),
        net_trade_salary_k: leftNetTradeK,
        net_cap_change_dollars: leftNetChange,
        available_salary_before_dollars: leftAvailableBefore,
        available_salary_after_dollars: leftAvailableAfter,
        over_cap_dollars: leftOverCap
      },
      right: {
        franchise_id: rightTeam ? rightTeam.franchise_id : "",
        franchise_name: rightTeam ? rightTeam.franchise_name : "",
        outgoing_dollars: rightOutgoing,
        incoming_dollars: rightIncoming,
        trade_salary_adjustment_k: rightTradeK,
        trade_salary_adjustment_max_k: getTradeSalaryMaxK(state.rightTeamId),
        net_trade_salary_k: rightNetTradeK,
        net_cap_change_dollars: rightNetChange,
        available_salary_before_dollars: rightAvailableBefore,
        available_salary_after_dollars: rightAvailableAfter,
        over_cap_dollars: rightOverCap
      },
      has_over_cap: leftOverCap > 0 || rightOverCap > 0
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
    payload.validation = buildValidationSummary(payload);
    return payload;
  }

  function serializeSelectedAssets(teamId) {
    var selected = getSelectedAssets(teamId);
    var out = [];
    var i;
    for (i = 0; i < selected.length; i += 1) {
      var a = selected[i];
      out.push({
        asset_id: a.asset_id,
        type: a.type,
        player_id: a.player_id || null,
        player_name: a.player_name || null,
        description: a.type === "PICK" ? a.description : null,
        position: a.position || null,
        nfl_team: a.nfl_team || null,
        salary: a.type === "PLAYER" ? safeInt(a.salary, 0) : 0,
        years: a.type === "PLAYER" ? (a.years == null ? null : a.years) : null,
        contract_type: a.contract_type || null,
        contract_info: a.contract_info || null,
        taxi: !!a.taxi
      });
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
        new_TCV: req.option.new_TCV == null ? null : req.option.new_TCV,
        new_aav_future: req.option.new_aav_future == null ? null : req.option.new_aav_future
      });
    }
    return requests;
  }

  function buildValidationSummary(payload) {
    var issues = [];
    var teams = payload.teams || [];
    var recon = payload.salary_reconciliation || {};
    if (teams.length === 2) {
      var leftId = safeStr(teams[0].franchise_id);
      var rightId = safeStr(teams[1].franchise_id);
      if (!leftId) issues.push("Your team is not selected.");
      if (!rightId) issues.push("Select a trade partner.");
      if (leftId && !(teams[0].selected_assets || []).length) issues.push("Your side has no selected assets.");
      if (rightId && !(teams[1].selected_assets || []).length) issues.push("Trade partner side has no selected assets.");
      if (teams[0].traded_salary_adjustment_k > teams[0].traded_salary_adjustment_max_k) issues.push("Left traded salary exceeds max.");
      if (teams[1].traded_salary_adjustment_k > teams[1].traded_salary_adjustment_max_k) issues.push("Right traded salary exceeds max.");
      if (safeInt((recon.left || {}).over_cap_dollars, 0) > 0) {
        issues.push((safeStr((recon.left || {}).franchise_name) || "Your team") + " is over cap.");
      }
      if (safeInt((recon.right || {}).over_cap_dollars, 0) > 0) {
        issues.push((safeStr((recon.right || {}).franchise_name) || "Partner team") + " is over cap.");
      }
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

  function renderOfferCartPlayerCard(teamId, asset) {
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
    contract.appendChild(offerPlayerMetric("Current AAV", asset.aav_current == null ? "—" : formatDollarsAsKLabel(asset.aav_current)));
    contract.appendChild(offerPlayerMetric("Years Remaining", asset.years == null ? "—" : String(asset.years)));
    contract.appendChild(offerPlayerMetric("Contract Type", safeStr(asset.contract_type) || "—"));
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
      extTitle.textContent = extensionTypeLabel(option.extension_term);
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
    var item = document.createElement("article");
    item.className = "twb-offer-cart-item twb-offer-cart-item-pick";

    var head = document.createElement("div");
    head.className = "twb-offer-cart-item-head";
    var name = document.createElement("div");
    name.className = "twb-offer-cart-item-name";
    name.textContent = safeStr(asset.description || "Draft Pick");
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
    meta.textContent = "Draft Pick";
    item.appendChild(meta);
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

  function renderOfferCart(payload) {
    if (!els.offerCart) return;
    var leftTeam = getTeamById(state.leftTeamId);
    var rightTeam = getTeamById(state.rightTeamId);
    setTextIf(els.offerCartLeftTitle, leftTeam ? ("You Send · " + leftTeam.franchise_name) : "You Send");
    setTextIf(els.offerCartRightTitle, rightTeam ? ("You Receive · " + rightTeam.franchise_name) : "You Receive");

    renderOfferCartSide(state.leftTeamId, els.offerCartLeftList);
    renderOfferCartSide(state.rightTeamId, els.offerCartRightList);

    if (els.offerCartStatus) {
      els.offerCartStatus.textContent = payload.validation.status === "ready" ? "Ready" : "Draft";
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

  function renderSalaryTeamBlock(title, sideData) {
    var block = document.createElement("section");
    block.className = "twb-salary-side";

    var h = document.createElement("h4");
    h.className = "twb-salary-side-title";
    h.textContent = title;
    block.appendChild(h);

    block.appendChild(renderSalaryLine("Going Out", formatDollarsAsKLabel(sideData.outgoing_dollars)));
    block.appendChild(renderSalaryLine("Coming In", formatDollarsAsKLabel(sideData.incoming_dollars)));
    block.appendChild(
      renderSalaryLine(
        "Trade Salary",
        formatKLabel(sideData.trade_salary_adjustment_k) + " / " + formatKLabel(sideData.trade_salary_adjustment_max_k)
      )
    );
    block.appendChild(renderSalaryLine("Net Change", formatSignedK(Math.round(safeInt(sideData.net_cap_change_dollars, 0) / 1000))));
    block.appendChild(
      renderSalaryLine(
        "Available",
        sideData.available_salary_before_dollars == null ? "—" : formatDollarsAsKLabel(sideData.available_salary_before_dollars)
      )
    );
    block.appendChild(
      renderSalaryLine(
        "Post-Trade",
        sideData.available_salary_after_dollars == null ? "—" : formatDollarsAsKLabel(sideData.available_salary_after_dollars),
        safeInt(sideData.over_cap_dollars, 0) > 0 ? "bad" : "good"
      )
    );
    return block;
  }

  function renderOfferAlerts(payload) {
    if (!els.offerAlerts) return;
    els.offerAlerts.innerHTML = "";
    var recon = payload.salary_reconciliation || {};
    var left = recon.left || {};
    var right = recon.right || {};
    var alerts = [];
    if (safeInt(left.over_cap_dollars, 0) > 0) {
      alerts.push((safeStr(left.franchise_name) || "Your team") + " Over Cap by " + formatDollarsAsKLabel(left.over_cap_dollars));
    }
    if (safeInt(right.over_cap_dollars, 0) > 0) {
      alerts.push((safeStr(right.franchise_name) || "Partner team") + " Over Cap by " + formatDollarsAsKLabel(right.over_cap_dollars));
    }

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
    var ready = payload.validation.status === "ready";
    els.submitOfferBtn.disabled = !!state.submit.busy || !ready;
    els.submitOfferBtn.textContent = state.submit.busy ? "Submitting…" : "Submit Offer";
    els.submitOfferStatus.textContent = state.submit.message || "No offer submitted yet.";
    els.submitOfferStatus.className = "twb-summary-note";
    if (state.submit.tone) {
      els.submitOfferStatus.className += " twb-submit-status-" + state.submit.tone;
    }
  }

  function renderSummary() {
    var summaryEl = els.summaryContent;
    if (!summaryEl) return;
    summaryEl.innerHTML = "";

    var payload = buildTradePayload();
    var statusPill = els.summaryStatus;
    var ready = payload.validation.status === "ready";
    statusPill.textContent = ready ? "Ready" : "Draft";
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
    state.filters.activeContractTypes = {};
    state.filters.yearsMin = "";
    state.filters.yearsMax = "";
    state.filters.showTaxi = true;
    state.filters.showPicks = true;
    state.filters.onlyExtensionEligible = false;
  }

  function clearFilters() {
    resetFilterState();
    state.rightTeamId = "";
  }

  function resetTrade() {
    state.selections = {};
    state.extensions = {};
    state.tradeSalaryK = {};
    state.collapsed = {};
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
      state.leftTeamId = safeStr(this.value);
      if (state.leftTeamId === state.rightTeamId) state.rightTeamId = "";
      initTeamSelectors();
      rerender();
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

    els.yearsMinSelect.addEventListener("change", function () {
      state.filters.yearsMin = safeStr(this.value);
      rerender();
    });

    els.yearsMaxSelect.addEventListener("change", function () {
      state.filters.yearsMax = safeStr(this.value);
      rerender();
    });

    els.clearFiltersBtn.addEventListener("click", function () {
      clearFilters();
      rerender();
    });

    els.copyPayloadBtn.addEventListener("click", copyPayloadToClipboard);
    els.copyPayloadBtn2.addEventListener("click", copyPayloadToClipboard);

    els.resetBtn.addEventListener("click", function () {
      resetTrade();
      rerender();
    });

    if (els.submitOfferBtn) {
      els.submitOfferBtn.addEventListener("click", function () {
        submitOfferToQueue();
      });
    }

    els.toolbar.addEventListener("change", function (evt) {
      var target = evt.target;
      if (!target) return;
      var action = target.getAttribute("data-action");
      if (action === "toggle-contract-type-filter") {
        var ct = safeStr(target.getAttribute("data-contract-type"));
        if (target.checked) state.filters.activeContractTypes[ct] = true;
        else delete state.filters.activeContractTypes[ct];
        rerender();
      }
      if (action === "toggle-bool-filter") {
        var key = safeStr(target.getAttribute("data-filter-key"));
        if (key) state.filters[key] = !!target.checked;
        rerender();
      }
    });

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
      if (action === "toggle-extension") {
        teamId = safeStr(target.getAttribute("data-team-id"));
        assetId = safeStr(target.getAttribute("data-asset-id"));
        setExtensionEnabled(teamId, assetId, !!target.checked);
        rerender();
        return;
      }
      if (action === "set-extension-option") {
        teamId = safeStr(target.getAttribute("data-team-id"));
        assetId = safeStr(target.getAttribute("data-asset-id"));
        setExtensionOption(teamId, assetId, target.value);
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
    els.yearsMinSelect = q("twbYearsMinSelect");
    els.yearsMaxSelect = q("twbYearsMaxSelect");
    els.contractTypeOptions = q("twbContractTypeOptions");
    els.booleanToggles = q("twbBooleanToggles");
    els.clearFiltersBtn = q("twbClearFiltersBtn");
    els.copyPayloadBtn = q("twbCopyPayloadBtn");
    els.copyPayloadBtn2 = q("twbCopyPayloadBtn2");
    els.resetBtn = q("twbResetBtn");
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
    els.offerAlerts = q("twbOfferAlerts");
    els.offerSalaryPanel = q("twbOfferSalaryPanel");
    els.offerCartMobileTray = q("twbOfferCartMobileTray");
    els.mobileTabs = q("twbMobileTabs");
    els.mobileTabButtons = els.mobileTabs ? els.mobileTabs.querySelectorAll('[data-action="mobile-tab"]') : [];
    els.summary = q("twbSummary");
    els.summaryContent = q("twbSummaryContent");
    els.summaryStatus = q("twbSummaryStatus");
    els.payloadPreview = q("twbPayloadPreview");
    els.offerMessageInput = q("twbOfferMessageInput");
    els.submitOfferBtn = q("twbSubmitOfferBtn");
    els.submitOfferStatus = q("twbSubmitOfferStatus");
  }

  function seedInitialTeams() {
    var teams = state.data.teams || [];
    if (!teams.length) return;
    var lockedLeft = getLockedLeftTeamId();
    if (lockedLeft) {
      state.leftTeamId = lockedLeft;
    } else if (!state.leftTeamId || !getTeamById(state.leftTeamId)) {
      state.leftTeamId = teams[0].franchise_id;
    }
    if (!state.rightTeamId || !getTeamById(state.rightTeamId) || state.rightTeamId === state.leftTeamId) {
      state.rightTeamId = "";
    }
  }

  function showError(err) {
    var errorHtml = '<div class="twb-error-state">Could not load trade workbench data. ' + escapeHtml(err && err.message ? err.message : String(err)) + '</div>';
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

    if (els.board) els.board.innerHTML = '<div class="twb-loading">Loading trade workbench…</div>';
    if (els.partnerBoard) els.partnerBoard.innerHTML = '<div class="twb-loading">Loading partner assets…</div>';

    try {
      var raw = await loadData();
      state.data = normalizeData(raw);
      if (!state.data.teams.length) throw new Error("No teams in data payload.");

      seedInitialTeams();
      initializeControlsFromState();
      bindEvents();
      state.uiReady = true;
      rerender();

      window.upsTradeWorkbench = {
        state: state,
        normalizeData: normalizeData,
        buildTradePayload: buildTradePayload,
        rerender: rerender,
        submitOfferToQueue: submitOfferToQueue
      };
      postParentHeight(true);
    } catch (err) {
      showError(err);
      console.error("Trade Workbench load failed", err);
      postParentHeight(true);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
