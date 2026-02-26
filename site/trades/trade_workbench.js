(function () {
  "use strict";

  var SAMPLE_DATA_URL = "./trade_workbench_sample.json";
  var STORAGE_KEY = "ups-trade-workbench-state-v2";
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
    filters: {
      search: "",
      activePositions: {},
      activeContractTypes: {},
      yearsMin: "",
      yearsMax: "",
      showTaxi: true,
      showPicks: true,
      onlyExtensionEligible: false
    },
    collapsed: {}
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

  function positionPillClass(pos) {
    pos = safeStr(pos).toUpperCase();
    if (pos === "QB") return "twb-pill-position-qb";
    if (pos === "RB") return "twb-pill-position-rb";
    if (pos === "WR") return "twb-pill-position-wr";
    if (pos === "TE") return "twb-pill-position-te";
    if (pos === "DT" || pos === "DE" || pos === "LB" || pos === "CB" || pos === "S" || pos === "DL" || pos === "DB") return "twb-pill-position-def";
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

    return {
      meta: {
        league_id: safeStr(raw.league_id || raw.leagueId),
        season: safeInt(raw.season || raw.year, 0),
        generated_at: safeStr(raw.generated_at || raw.generatedAt || ""),
        source: safeStr(raw.source || "sample")
      },
      teams: teams,
      extension_previews: raw.extension_previews || raw.extensionPreviews || [],
      filtersMeta: {
        positions: uniqueSorted(allPositions),
        contractTypes: uniqueSorted(allContractTypes),
        maxYears: Math.max(maxYears, 4)
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
      }
      state.selections = parsed.selections && typeof parsed.selections === "object" ? parsed.selections : state.selections;
      state.extensions = parsed.extensions && typeof parsed.extensions === "object" ? parsed.extensions : state.extensions;
      state.tradeSalaryK = parsed.tradeSalaryK && typeof parsed.tradeSalaryK === "object" ? parsed.tradeSalaryK : state.tradeSalaryK;
      state.collapsed = parsed.collapsed && typeof parsed.collapsed === "object" ? parsed.collapsed : state.collapsed;
      state.leftTeamId = safeStr(parsed.leftTeamId);
      state.rightTeamId = safeStr(parsed.rightTeamId);
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
          collapsed: state.collapsed,
          filters: state.filters
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

  function activeFilterCount(mapObj) {
    var keys = Object.keys(mapObj || {});
    var count = 0;
    var i;
    for (i = 0; i < keys.length; i += 1) if (mapObj[keys[i]]) count += 1;
    return count;
  }

  function assetMatchesFilters(asset) {
    var f = state.filters;
    if (!asset) return false;

    if (asset.type === "PICK") {
      if (!f.showPicks) return false;
      if (f.onlyExtensionEligible) return false;
    }

    if (asset.type === "PLAYER") {
      if (!f.showTaxi && asset.taxi) return false;
      if (f.onlyExtensionEligible && !asset.extension_eligible) return false;

      if (activeFilterCount(f.activePositions) > 0) {
        if (!f.activePositions[safeStr(asset.position).toUpperCase()]) return false;
      }

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
    if (search && asset.search_text.indexOf(search) === -1) return false;

    return true;
  }

  function getVisibleAssetsForTeam(teamId) {
    var team = getTeamById(teamId);
    if (!team) return [];
    var assets = team.assets || [];
    var out = [];
    var i;
    for (i = 0; i < assets.length; i += 1) {
      if (assetMatchesFilters(assets[i])) out.push(assets[i]);
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

  function deriveTeamStats(team) {
    var assets = (team && team.assets) || [];
    var players = 0;
    var picks = 0;
    var extEligible = 0;
    var i;
    for (i = 0; i < assets.length; i += 1) {
      if (assets[i].type === "PICK") picks += 1;
      else {
        players += 1;
        if (assets[i].extension_eligible) extEligible += 1;
      }
    }
    return { players: players, picks: picks, extEligible: extEligible };
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
    var i;
    for (i = 0; i < teams.length; i += 1) {
      var t = teams[i];
      var label = t.franchise_name + " (" + t.franchise_abbrev + ")";
      left.appendChild(optionEl(t.franchise_id, label));
      right.appendChild(optionEl(t.franchise_id, label));
    }

    if (!state.leftTeamId || !getTeamById(state.leftTeamId)) {
      state.leftTeamId = teams[0] ? teams[0].franchise_id : "";
    }
    if (!state.rightTeamId || !getTeamById(state.rightTeamId) || state.rightTeamId === state.leftTeamId) {
      state.rightTeamId = teams[1] ? teams[1].franchise_id : (teams[0] ? teams[0].franchise_id : "");
    }
    if (state.leftTeamId && state.rightTeamId && state.leftTeamId === state.rightTeamId && teams.length > 1) {
      state.rightTeamId = teams[1].franchise_id;
    }

    left.value = state.leftTeamId;
    right.value = state.rightTeamId;
  }

  function initYearFilters() {
    var maxYears = state.data.filtersMeta.maxYears || 4;
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

  function initPositionChips() {
    var wrap = els.positionChips;
    if (!wrap) return;
    wrap.innerHTML = "";
    var positions = state.data.filtersMeta.positions || [];
    if (!positions.length) {
      var empty = document.createElement("div");
      empty.className = "twb-summary-note";
      empty.textContent = "No positions found in loaded data.";
      wrap.appendChild(empty);
      return;
    }
    var i;
    for (i = 0; i < positions.length; i += 1) {
      var pos = positions[i];
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "twb-chip";
      btn.setAttribute("data-action", "toggle-position-filter");
      btn.setAttribute("data-position", pos);
      btn.setAttribute("aria-pressed", state.filters.activePositions[pos] ? "true" : "false");
      btn.textContent = pos;
      wrap.appendChild(btn);
    }
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
    initPositionChips();
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
    initPositionChips();
    initContractTypeFilters();
    initBooleanToggles();
  }

  function renderBoard() {
    var board = els.board;
    board.innerHTML = "";

    var leftTeam = getTeamById(state.leftTeamId);
    var rightTeam = getTeamById(state.rightTeamId);
    if (!leftTeam || !rightTeam) {
      var empty = document.createElement("div");
      empty.className = "twb-empty-state";
      empty.textContent = "Select two teams to begin building a trade.";
      board.appendChild(empty);
      return;
    }

    board.appendChild(renderTeamPanel(leftTeam, "left"));
    board.appendChild(renderTeamPanel(rightTeam, "right"));
  }

  function renderMiniStat(label, value) {
    var div = document.createElement("div");
    div.className = "twb-mini-stat";
    div.innerHTML = '<span class="twb-mini-stat-label">' + escapeHtml(label) + '</span><span class="twb-mini-stat-value">' + escapeHtml(String(value)) + '</span>';
    return div;
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
    var statsWrap = node.querySelector(".twb-team-stats");
    var groupsWrap = node.querySelector(".twb-team-groups");
    var salaryInput = node.querySelector(".twb-trade-salary-input");
    var salaryMax = node.querySelector(".twb-trade-salary-max");

    var teamAbbrev = safeStr(team.franchise_abbrev || team.franchise_id);
    eyebrow.textContent = side === "left" ? "Your Side" : "Trade Partner";
    title.textContent = team.franchise_name;
    meta.textContent = teamAbbrev || team.franchise_id;

    if (logoFallback) {
      logoFallback.textContent = teamAbbrev || safeStr(team.franchise_name).slice(0, 3).toUpperCase();
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

    var teamStats = deriveTeamStats(team);
    statsWrap.appendChild(renderMiniStat("Players", teamStats.players));
    statsWrap.appendChild(renderMiniStat("Picks", teamStats.picks));
    statsWrap.appendChild(renderMiniStat("Ext Eligible", teamStats.extEligible));

    salaryInput.value = safeStr(state.tradeSalaryK[team.franchise_id]);
    salaryInput.setAttribute("data-action", "set-trade-salary");
    salaryInput.setAttribute("data-team-id", team.franchise_id);
    salaryInput.setAttribute("max", String(getTradeSalaryMaxK(team.franchise_id)));

    var totals = getTeamTotals(team.franchise_id);
    var maxK = getTradeSalaryMaxK(team.franchise_id);
    salaryMax.textContent =
      "Max " + maxK + "K based on selected non-Taxi player salary " + kFmtFromDollars(totals.selectedNonTaxiSalary) +
      (totals.selectedTaxiPlayers ? " (Taxi excluded: " + totals.selectedTaxiPlayers + ")" : "");

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
    var selectVisible = panel.querySelector(".twb-team-select-all");
    var clearVisible = panel.querySelector(".twb-team-clear-visible");
    var expandAll = panel.querySelector(".twb-team-expand-all");
    var collapseAll = panel.querySelector(".twb-team-collapse-all");

    selectVisible.setAttribute("data-action", "team-select-visible");
    selectVisible.setAttribute("data-team-id", teamId);
    clearVisible.setAttribute("data-action", "team-clear-visible");
    clearVisible.setAttribute("data-team-id", teamId);
    expandAll.setAttribute("data-action", "team-expand-all");
    expandAll.setAttribute("data-team-id", teamId);
    collapseAll.setAttribute("data-action", "team-collapse-all");
    collapseAll.setAttribute("data-team-id", teamId);
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

    details.querySelector(".twb-group-label").textContent = group.label;

    var selectedMap = state.selections[teamId] || {};
    var selectedCount = 0;
    var extCount = 0;
    var i;
    for (i = 0; i < group.assets.length; i += 1) {
      var asset = group.assets[i];
      if (selectedMap[asset.asset_id]) {
        selectedCount += 1;
        if (state.extensions[teamId] && state.extensions[teamId][asset.asset_id] && state.extensions[teamId][asset.asset_id].enabled) {
          extCount += 1;
        }
      }
    }

    var badgeText = group.assets.length + " visible";
    if (selectedCount) badgeText += " · " + selectedCount + " selected";
    if (extCount) badgeText += " · " + extCount + " ext";
    details.querySelector(".twb-group-badges").textContent = badgeText;

    var tbody = details.querySelector("tbody");
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
    var tr = document.createElement("tr");
    tr.setAttribute("data-asset-id", asset.asset_id);
    tr.setAttribute("data-team-id", teamId);
    if (selected) tr.className = "twb-row-selected";
    if (asset.taxi) tr.className = (tr.className ? tr.className + " " : "") + "twb-row-taxi";

    var tdSelect = document.createElement("td");
    tdSelect.className = "twb-col-select";
    tdSelect.setAttribute("data-label", "In Trade");
    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "twb-asset-select";
    cb.checked = selected;
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
      pillPos.className = "twb-pill " + positionPillClass(asset.position);
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
      if (asset.contract_type) pieces.push(asset.contract_type);
      if (asset.injury) pieces.push(asset.injury);
      if (asset.notes) pieces.push(asset.notes);
      subText = pieces.join(" · ");
    } else {
      subText = asset.contract_info || "Tradeable draft asset";
    }
    if (subText) {
      var sub = document.createElement("div");
      sub.className = "twb-asset-sub";
      sub.textContent = subText;
      main.appendChild(sub);
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
    tdContract.setAttribute("data-label", "Contract Info");
    tdContract.innerHTML = '<div class="twb-contract-info">' + escapeHtml(asset.contract_info || (asset.type === "PICK" ? "Draft pick" : "")) + '</div>';
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
      if (map[assets[i].asset_id]) out.push(assets[i]);
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
    if (teams.length === 2) {
      if (!(teams[0].selected_assets || []).length) issues.push("Left side has no selected assets.");
      if (!(teams[1].selected_assets || []).length) issues.push("Right side has no selected assets.");
      if (teams[0].traded_salary_adjustment_k > teams[0].traded_salary_adjustment_max_k) issues.push("Left traded salary exceeds max.");
      if (teams[1].traded_salary_adjustment_k > teams[1].traded_salary_adjustment_max_k) issues.push("Right traded salary exceeds max.");
    }
    return {
      status: issues.length ? "draft" : "ready",
      issues: issues
    };
  }

  function renderSummary() {
    var summaryEl = els.summaryContent;
    if (!summaryEl) return;
    summaryEl.innerHTML = "";

    var payload = buildTradePayload();
    var statusPill = els.summaryStatus;
    statusPill.textContent = payload.validation.status === "ready" ? "Ready" : "Draft";
    statusPill.style.background = payload.validation.status === "ready" ? "rgba(86, 215, 154, 0.14)" : "rgba(120, 176, 255, 0.12)";
    statusPill.style.borderColor = payload.validation.status === "ready" ? "rgba(86, 215, 154, 0.24)" : "rgba(120, 176, 255, 0.22)";
    statusPill.style.color = payload.validation.status === "ready" ? "#c9ffe5" : "#cae7ff";

    var leftTeam = getTeamById(state.leftTeamId);
    var rightTeam = getTeamById(state.rightTeamId);
    var sideSummaries = [
      { id: state.leftTeamId, team: leftTeam, side: "Your Side" },
      { id: state.rightTeamId, team: rightTeam, side: "Trade Partner" }
    ];
    var i;
    for (i = 0; i < sideSummaries.length; i += 1) {
      summaryEl.appendChild(renderSideSummarySection(sideSummaries[i]));
    }

    summaryEl.appendChild(renderTradeMetaSection(payload));

    els.payloadPreview.textContent = JSON.stringify(payload, null, 2);
  }

  function renderSideSummarySection(item) {
    var section = document.createElement("section");
    section.className = "twb-summary-section";
    var title = document.createElement("h3");
    title.className = "twb-summary-section-title";
    title.textContent = item.side + (item.team ? " · " + item.team.franchise_abbrev : "");
    section.appendChild(title);

    var list = document.createElement("div");
    list.className = "twb-summary-list";
    var totals = getTeamTotals(item.id);
    var maxK = getTradeSalaryMaxK(item.id);
    var enteredK = safeInt(state.tradeSalaryK[item.id], 0);

    list.appendChild(summaryRow("Selected Assets", String(totals.selectedCount)));
    list.appendChild(summaryRow("Selected Players", String(totals.selectedPlayers)));
    list.appendChild(summaryRow("Selected Picks", String(totals.selectedPicks)));
    list.appendChild(summaryRow("Non-Taxi Salary", kFmtFromDollars(totals.selectedNonTaxiSalary)));
    list.appendChild(summaryRow("Taxi Excluded", String(totals.selectedTaxiPlayers), totals.selectedTaxiPlayers ? "warn" : ""));
    list.appendChild(summaryRow("Trade Salary Max", String(maxK) + "K"));
    list.appendChild(summaryRow("Trade Salary Entered", String(enteredK) + "K", enteredK > maxK ? "bad" : "good"));
    section.appendChild(list);

    var extReqs = getChosenExtensionRequests(item.id);
    if (extReqs.length) {
      var noteTitle = document.createElement("div");
      noteTitle.className = "twb-summary-note";
      noteTitle.style.marginTop = "0.55rem";
      noteTitle.textContent = "Extensions selected on this side (apply to acquiring team):";
      section.appendChild(noteTitle);
      var ul = document.createElement("ul");
      ul.className = "twb-ext-list";
      var j;
      for (j = 0; j < extReqs.length; j += 1) {
        var li = document.createElement("li");
        var toTeam = getTeamById(extReqs[j].applies_to_team_id);
        li.textContent = extReqs[j].asset.player_name + " → " + (toTeam ? toTeam.franchise_abbrev : extReqs[j].applies_to_team_id) + " · " + extReqs[j].option.label;
        ul.appendChild(li);
      }
      section.appendChild(ul);
    }

    return section;
  }

  function renderTradeMetaSection(payload) {
    var section = document.createElement("section");
    section.className = "twb-summary-section";
    var title = document.createElement("h3");
    title.className = "twb-summary-section-title";
    title.textContent = "Validation";
    section.appendChild(title);

    if (payload.validation.issues && payload.validation.issues.length) {
      var ul = document.createElement("ul");
      ul.className = "twb-ext-list";
      var i;
      for (i = 0; i < payload.validation.issues.length; i += 1) {
        var li = document.createElement("li");
        li.textContent = payload.validation.issues[i];
        ul.appendChild(li);
      }
      section.appendChild(ul);
    } else {
      var note = document.createElement("div");
      note.className = "twb-summary-note";
      note.textContent = "Trade has assets on both sides and traded salary entries are within the calculated max values. This is a UI-level validation only; roster/cap compliance rules can be added next.";
      section.appendChild(note);
    }

    var submitNote = document.createElement("div");
    submitNote.className = "twb-summary-note";
    submitNote.style.marginTop = "0.55rem";
    submitNote.textContent = "Submission is not wired yet. This screen builds and validates the trade payload that your backend can store, review, and later send to MFL or your custom approval workflow.";
    section.appendChild(submitNote);

    return section;
  }

  function summaryRow(label, value, tone) {
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

  function rerender() {
    syncControlsLightweight();
    renderBoard();
    renderSummary();
    persistState();
    scheduleParentHeightPost();
  }

  function toggleAsset(teamId, assetId, checked) {
    ensureSelectionMaps(teamId);
    if (checked) state.selections[teamId][assetId] = true;
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

  function teamSelectVisible(teamId, shouldSelect) {
    ensureSelectionMaps(teamId);
    var panel = null;
    var panels = els.board.querySelectorAll(".twb-team-panel");
    var p;
    for (p = 0; p < panels.length; p += 1) {
      if (safeStr(panels[p].getAttribute("data-team-id")) === teamId) {
        panel = panels[p];
        break;
      }
    }
    if (!panel) return;
    var checkboxes = panel.querySelectorAll('input[data-action="toggle-asset"]');
    var i;
    for (i = 0; i < checkboxes.length; i += 1) {
      var cb = checkboxes[i];
      var aid = cb.getAttribute("data-asset-id");
      if (!aid) continue;
      if (shouldSelect) state.selections[teamId][aid] = true;
      else {
        delete state.selections[teamId][aid];
        if (state.extensions[teamId]) delete state.extensions[teamId][aid];
      }
    }
    clampTradeSalaryForTeam(teamId);
  }

  function teamSetAllGroups(teamId, openValue) {
    ensureSelectionMaps(teamId);
    var panel = null;
    var panels = els.board.querySelectorAll(".twb-team-panel");
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

  function clearFilters() {
    state.filters.search = "";
    state.filters.activePositions = {};
    state.filters.activeContractTypes = {};
    state.filters.yearsMin = "";
    state.filters.yearsMax = "";
    state.filters.showTaxi = true;
    state.filters.showPicks = true;
    state.filters.onlyExtensionEligible = false;
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
      if (state.leftTeamId === state.rightTeamId) {
        var teams = state.data.teams || [];
        var i;
        for (i = 0; i < teams.length; i += 1) {
          if (teams[i].franchise_id !== state.leftTeamId) {
            state.rightTeamId = teams[i].franchise_id;
            break;
          }
        }
      }
      rerender();
    });

    els.rightTeamSelect.addEventListener("change", function () {
      state.rightTeamId = safeStr(this.value);
      if (state.rightTeamId === state.leftTeamId) {
        var teams = state.data.teams || [];
        var i;
        for (i = 0; i < teams.length; i += 1) {
          if (teams[i].franchise_id !== state.rightTeamId) {
            state.leftTeamId = teams[i].franchise_id;
            break;
          }
        }
      }
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

    els.toolbar.addEventListener("click", function (evt) {
      var target = evt.target;
      if (!target) return;
      var action = target.getAttribute("data-action");
      if (action === "toggle-position-filter") {
        var pos = safeStr(target.getAttribute("data-position")).toUpperCase();
        if (state.filters.activePositions[pos]) delete state.filters.activePositions[pos];
        else state.filters.activePositions[pos] = true;
        rerender();
      }
    });

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

    els.board.addEventListener("change", function (evt) {
      var target = evt.target;
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
        return;
      }
    });

    els.board.addEventListener("input", function (evt) {
      var target = evt.target;
      if (!target) return;
      var action = target.getAttribute("data-action");
      if (action === "set-trade-salary") {
        var teamId = safeStr(target.getAttribute("data-team-id"));
        setTradeSalary(teamId, target.value);
        renderSummary();
        persistState();
      }
    });

    els.board.addEventListener("click", function (evt) {
      var target = evt.target;
      if (!target) return;
      var action = target.getAttribute("data-action");
      if (!action) return;
      var teamId = safeStr(target.getAttribute("data-team-id"));
      if (action === "team-select-visible") {
        teamSelectVisible(teamId, true);
        rerender();
      } else if (action === "team-clear-visible") {
        teamSelectVisible(teamId, false);
        rerender();
      } else if (action === "team-expand-all") {
        teamSetAllGroups(teamId, true);
        rerender();
      } else if (action === "team-collapse-all") {
        teamSetAllGroups(teamId, false);
        rerender();
      }
    });
  }

  function collectDomRefs() {
    els.app = q("twbApp");
    els.toolbar = q("twbApp");
    els.leftTeamSelect = q("twbLeftTeamSelect");
    els.rightTeamSelect = q("twbRightTeamSelect");
    els.searchInput = q("twbSearchInput");
    els.yearsMinSelect = q("twbYearsMinSelect");
    els.yearsMaxSelect = q("twbYearsMaxSelect");
    els.positionChips = q("twbPositionChips");
    els.contractTypeOptions = q("twbContractTypeOptions");
    els.booleanToggles = q("twbBooleanToggles");
    els.clearFiltersBtn = q("twbClearFiltersBtn");
    els.copyPayloadBtn = q("twbCopyPayloadBtn");
    els.copyPayloadBtn2 = q("twbCopyPayloadBtn2");
    els.resetBtn = q("twbResetBtn");
    els.board = q("twbBoard");
    els.summary = q("twbSummary");
    els.summaryContent = q("twbSummaryContent");
    els.summaryStatus = q("twbSummaryStatus");
    els.payloadPreview = q("twbPayloadPreview");
  }

  function seedInitialTeams() {
    var teams = state.data.teams || [];
    if (!teams.length) return;
    if (!state.leftTeamId || !getTeamById(state.leftTeamId)) {
      var defaultTeam = null;
      var i;
      for (i = 0; i < teams.length; i += 1) {
        if (teams[i].is_default) {
          defaultTeam = teams[i];
          break;
        }
      }
      state.leftTeamId = (defaultTeam || teams[0]).franchise_id;
    }
    if (!state.rightTeamId || !getTeamById(state.rightTeamId) || state.rightTeamId === state.leftTeamId) {
      var j;
      for (j = 0; j < teams.length; j += 1) {
        if (teams[j].franchise_id !== state.leftTeamId) {
          state.rightTeamId = teams[j].franchise_id;
          break;
        }
      }
      if (!state.rightTeamId) state.rightTeamId = state.leftTeamId;
    }
  }

  function showError(err) {
    if (!els.board) return;
    els.board.innerHTML = '<div class="twb-error-state">Could not load trade workbench data. ' + escapeHtml(err && err.message ? err.message : String(err)) + '</div>';
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

    els.board.innerHTML = '<div class="twb-loading">Loading trade workbench…</div>';

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
        rerender: rerender
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
