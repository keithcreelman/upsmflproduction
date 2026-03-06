(function () {
  "use strict";

  var BUILD = "2026.03.06.1";
  var BOOT_FLAG = "__ups_roster_workbench_boot_" + BUILD;
  if (window[BOOT_FLAG]) {
    if (typeof window.UPS_RWB_INIT === "function") window.UPS_RWB_INIT();
    return;
  }
  window[BOOT_FLAG] = true;

  var POSITION_GROUP_ORDER = ["QB", "RB", "WR", "TE", "DL", "DB", "LB", "PK", "PN", "OTHER"];
  var CONTRACT_FILTERS = [
    { value: "", label: "All Contract Types" },
    { value: "rookie", label: "Rookies" },
    { value: "loaded", label: "Loaded (Front/Back)" },
    { value: "other", label: "All Other" }
  ];

  var state = {
    ctx: null,
    teams: [],
    pointYears: [],
    pointsMode: "",
    view: "roster",
    search: "",
    filterPosition: "",
    filterType: "",
    taxiOnly: false,
    collapsed: {},
    filtersOpen: false,
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

  function pointModeLabel(mode) {
    if (safeStr(mode) === "cumulative") return "Cumulative";
    return safeStr(mode);
  }

  function isCurrentMobile() {
    return !!(window.matchMedia && window.matchMedia("(max-width: 760px)").matches);
  }

  function detectContext() {
    var out = {
      leagueId: "",
      year: "",
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
    } catch (e) {}

    if (!out.year) out.year = String(new Date().getFullYear());

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
    if (out.pointsByYear && Object.keys(out.pointsByYear).length === 0) {
      var py = safeStr(state.ctx && state.ctx.year);
      if (py) out.pointsByYear[py] = safeNum(out.points, 0);
    }
    out.pointsCumulative = safeNum(out.pointsCumulative, 0);
    return out;
  }

  function buildTeams(rostersPayload, leagueMeta, playersMap, scores, byes, salaryMap) {
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
        var special = overlay && overlay.special != null ? safeStr(overlay.special) : safeStr(rp.contractInfo);

        var status = normalizeStatus(rp.status);
        var isTaxi = status === "TAXI_SQUAD";
        var isIr = status === "INJURED_RESERVE";
        if (isTaxi) taxiCount += 1;

        capTotal += salary;

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
          type: contractType || "-",
          special: special || "-",
          status: status,
          isTaxi: isTaxi,
          isIr: isIr,
          pointsByYear: Object.create(null),
          pointsCumulative: 0
        }));
      }

      var compliance = deriveCompliance(capTotal, leagueMeta.capAmount);
      teams.push({
        id: fid,
        fid: fid,
        name: teamMeta.name,
        logo: teamMeta.logo || teamMeta.icon || "",
        players: players,
        summary: {
          players: players.length,
          taxi: taxiCount,
          capTotal: capTotal,
          compliance: compliance
        }
      });
    }

    teams.sort(function (a, b) {
      return safeStr(a.name).localeCompare(safeStr(b.name));
    });

    return teams;
  }

  function toWorkerPlayer(row, fallbackTeamName, orderIndex) {
    var p = row || {};
    var id = safeStr(p.id || p.player_id);
    var nflTeam = safeStr(p.nfl_team || p.nflTeam || p.team).toUpperCase();
    var status = normalizeStatus(p.status || p.roster_status);
    var isTaxi = !!p.is_taxi || !!p.isTaxi || status === "TAXI_SQUAD";
    var isIr = !!p.is_ir || !!p.isIr || status === "INJURED_RESERVE";
    return enrichPlayer({
      id: id,
      teamName: fallbackTeamName,
      order: safeInt(p.order, orderIndex),
      name: normalizePlayerName(p.name || p.player_name || ("Player " + id)),
      position: safeStr(p.position).toUpperCase() || "-",
      nflTeam: nflTeam,
      points: safeNum(p.points, 0),
      bye: safeStr(p.bye),
      salary: safeInt(p.salary, 0),
      years: safeInt(p.years, 0),
      type: safeStr(p.type || p.contract_type || "-") || "-",
      special: safeStr(p.special || p.contract_info || "-") || "-",
      status: status,
      isTaxi: isTaxi,
      isIr: isIr,
      pointsByYear: Object.create(null),
      pointsCumulative: 0
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
        players.push(toWorkerPlayer(playersRaw[x], name, x));
      }

      var capTotalFromPlayers = players.reduce(function (acc, p) {
        return acc + safeInt(p.salary, 0);
      }, 0);
      var taxiFromPlayers = players.reduce(function (acc, p) {
        return acc + (p.isTaxi ? 1 : 0);
      }, 0);

      var summary = team.summary || {};
      var capTotal = summary.cap_total_dollars == null
        ? (summary.capTotal == null ? capTotalFromPlayers : safeInt(summary.capTotal, capTotalFromPlayers))
        : safeInt(summary.cap_total_dollars, capTotalFromPlayers);
      var taxiCount = summary.taxi == null ? taxiFromPlayers : safeInt(summary.taxi, taxiFromPlayers);
      var complianceRaw = summary.compliance || deriveCompliance(capTotal, salaryCap);
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
          taxi: taxiCount,
          capTotal: capTotal,
          compliance: compliance
        }
      });
    }

    teams.sort(function (a, b) {
      return safeStr(a.name).localeCompare(safeStr(b.name));
    });
    return teams;
  }

  function isTeamCollapsed(teamId) {
    return !!state.collapsed[teamId];
  }

  function buildPointYears() {
    var start = currentYearInt();
    return [String(start), String(start - 1), String(start - 2), String(start - 3)];
  }

  function fetchPointsMapForYear(ctx, yearStr) {
    var url = buildApiExportUrl(yearStr, "playerScores", {
      L: ctx.leagueId,
      W: "YTD"
    });
    return fetchJson(url).then(function (payload) {
      return toScoreMap(payload);
    }).catch(function () {
      return Object.create(null);
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
          var cumulative = 0;
          for (var y = 0; y < years.length; y += 1) {
            var year = years[y];
            var score = safeNum(yearIndex[year][player.id], 0);
            player.pointsByYear[year] = score;
            cumulative += score;
          }
          if (safeNum(player.pointsByYear[years[0]], 0) === 0 && safeNum(player.points, 0) !== 0) {
            player.pointsByYear[years[0]] = safeNum(player.points, 0);
            cumulative = player.pointsByYear[years[0]] +
              safeNum(player.pointsByYear[years[1]], 0) +
              safeNum(player.pointsByYear[years[2]], 0) +
              safeNum(player.pointsByYear[years[3]], 0);
          }
          player.pointsCumulative = cumulative;
        }
      }

      return years;
    }).catch(function () {
      for (var t = 0; t < teams.length; t += 1) {
        var players = teams[t].players || [];
        for (var p = 0; p < players.length; p += 1) {
          var player = players[p];
          var fallbackYear = String(currentYearInt());
          player.pointsByYear = Object.create(null);
          player.pointsByYear[fallbackYear] = safeNum(player.points, 0);
          player.pointsCumulative = safeNum(player.points, 0);
        }
      }
      return [String(currentYearInt())];
    });
  }

  function pointsForPlayer(player) {
    if (!player) return 0;
    if (state.pointsMode === "cumulative") return safeNum(player.pointsCumulative, 0);

    var key = safeStr(state.pointsMode || (state.pointYears[0] || state.ctx.year));
    if (!key) return safeNum(player.points, 0);

    var map = player.pointsByYear || {};
    if (map[key] == null) {
      if (key === safeStr(state.ctx && state.ctx.year)) return safeNum(player.points, 0);
      return 0;
    }
    return safeNum(map[key], 0);
  }

  function formatPoints(n) {
    var v = safeNum(n, 0);
    if (Math.abs(v - Math.round(v)) < 0.001) return String(Math.round(v));
    return (Math.round(v * 10) / 10).toFixed(1);
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

    if (state.taxiOnly && !player.isTaxi) {
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
      var rows = map[key].slice().sort(function (a, b) {
        return safeStr(a.name).localeCompare(safeStr(b.name));
      });
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
            '<div class="rwb-toolbar-main">' +
              '<div class="rwb-view-switch" role="tablist" aria-label="View mode">' +
                '<button type="button" id="rwbViewRoster" class="rwb-btn rwb-btn-ghost is-active" data-action="view-switch" data-view="roster" role="tab" aria-selected="true">Roster View</button>' +
                '<button type="button" id="rwbViewContract" class="rwb-btn rwb-btn-ghost" data-action="view-switch" data-view="contract" role="tab" aria-selected="false">Contract View</button>' +
              '</div>' +
              '<label class="rwb-field"><span>Jump To Team</span><select id="rwbJumpTeam" class="rwb-select"><option value="">Select team...</option></select></label>' +
              '<label class="rwb-field"><span>Points</span><select id="rwbPointsMode" class="rwb-select"></select></label>' +
              '<label class="rwb-field"><span>Search</span><input id="rwbSearch" class="rwb-input" type="search" placeholder="Player, team, position, contract" autocomplete="off"></label>' +
              '<button type="button" id="rwbTaxiOnly" class="rwb-btn rwb-btn-ghost">Taxi Only: Off</button>' +
              '<button type="button" id="rwbToggleFilters" class="rwb-btn rwb-btn-ghost" aria-expanded="false">Filters</button>' +
            '</div>' +
            '<div id="rwbAdvancedFilters" class="rwb-toolbar-advanced" hidden>' +
              '<label class="rwb-field"><span>Position Group</span><select id="rwbFilterPosition" class="rwb-select"><option value="">All Groups</option></select></label>' +
              '<label class="rwb-field"><span>Contract Type</span><select id="rwbFilterType" class="rwb-select"><option value="">All Contract Types</option></select></label>' +
              '<button type="button" id="rwbResetFilters" class="rwb-btn rwb-btn-ghost">Reset Filters</button>' +
            '</div>' +
            '<div class="rwb-toolbar-note" id="rwbToolbarNote">Loading roster data...</div>' +
          '</section>' +
          '<section id="rwbTeamList" class="rwb-team-list" aria-live="polite"><div class="rwb-loading">Loading roster data...</div></section>' +
        '</div>' +
      '</div>';

    els.app = document.getElementById("rwbApp");
    els.jumpTeam = document.getElementById("rwbJumpTeam");
    els.pointsMode = document.getElementById("rwbPointsMode");
    els.search = document.getElementById("rwbSearch");
    els.toggleFilters = document.getElementById("rwbToggleFilters");
    els.advanced = document.getElementById("rwbAdvancedFilters");
    els.filterPosition = document.getElementById("rwbFilterPosition");
    els.filterType = document.getElementById("rwbFilterType");
    els.taxiOnly = document.getElementById("rwbTaxiOnly");
    els.resetFilters = document.getElementById("rwbResetFilters");
    els.note = document.getElementById("rwbToolbarNote");
    els.teamList = document.getElementById("rwbTeamList");
    els.viewRoster = document.getElementById("rwbViewRoster");
    els.viewContract = document.getElementById("rwbViewContract");
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

  function renderToolbar() {
    if (!els.jumpTeam) return;

    var jumpOptions = [{ value: "", label: "Select team..." }];
    for (var i = 0; i < state.teams.length; i += 1) {
      var team = state.teams[i];
      jumpOptions.push({ value: team.id, label: team.name });
    }
    renderSelectOptions(els.jumpTeam, jumpOptions, "");

    var pointOptions = [];
    for (var p = 0; p < state.pointYears.length; p += 1) {
      pointOptions.push({ value: state.pointYears[p], label: state.pointYears[p] });
    }
    pointOptions.push({ value: "cumulative", label: "Cumulative" });
    renderSelectOptions(els.pointsMode, pointOptions, state.pointsMode);

    els.search.value = state.search;

    var sets = buildFilterOptionSets();
    renderSelectOptions(els.filterPosition, sets.positions, state.filterPosition);
    renderSelectOptions(els.filterType, CONTRACT_FILTERS, state.filterType);

    var advancedVisible = state.filtersOpen || !isCurrentMobile();
    if (advancedVisible) {
      els.advanced.hidden = false;
      if (isCurrentMobile()) els.advanced.classList.add("is-open");
      else els.advanced.classList.remove("is-open");
    } else {
      els.advanced.hidden = true;
      els.advanced.classList.remove("is-open");
    }
    els.toggleFilters.setAttribute("aria-expanded", advancedVisible ? "true" : "false");

    if (els.taxiOnly) {
      els.taxiOnly.textContent = state.taxiOnly ? "Taxi Only: On" : "Taxi Only: Off";
      els.taxiOnly.classList.toggle("is-active", !!state.taxiOnly);
    }

    if (els.viewRoster && els.viewContract) {
      var rosterActive = state.view !== "contract";
      els.viewRoster.classList.toggle("is-active", rosterActive);
      els.viewContract.classList.toggle("is-active", !rosterActive);
      els.viewRoster.setAttribute("aria-selected", rosterActive ? "true" : "false");
      els.viewContract.setAttribute("aria-selected", !rosterActive ? "true" : "false");
    }
  }

  function renderToolbarNote(visiblePlayers, totalPlayers) {
    if (!els.note) return;

    var parts = [];
    parts.push((state.view === "contract" ? "Contract view" : "Roster view"));
    parts.push("Showing " + visiblePlayers + " of " + totalPlayers + " players");
    if (state.filterPosition) parts.push(positionGroupLabel(state.filterPosition));
    if (state.filterType) {
      if (state.filterType === "rookie") parts.push("Rookies");
      else if (state.filterType === "loaded") parts.push("Loaded");
      else if (state.filterType === "other") parts.push("All Other");
    }
    if (state.taxiOnly) parts.push("Taxi only");
    if (state.search) parts.push('Search "' + state.search + '"');
    parts.push("Points " + pointModeLabel(state.pointsMode));

    els.note.textContent = parts.join(" | ");
  }

  function teamHeaderHtml(team, filteredPlayers) {
    var collapsed = isTeamCollapsed(team.id);
    var complianceClass = team.summary.compliance.ok ? "is-good" : "is-bad";
    var complianceText = team.summary.compliance.label;

    var logo = safeStr(team.logo);
    var logoHtml = logo
      ? '<img class="rwb-team-logo" src="' + escapeHtml(logo) + '" alt="' + escapeHtml(team.name) + ' logo" title="' + escapeHtml(team.name) + '">' 
      : '<span class="rwb-team-logo-fallback" aria-hidden="true" title="' + escapeHtml(team.name) + '">' + escapeHtml(team.fid) + "</span>";

    return (
      '<header class="rwb-team-head">' +
        '<div class="rwb-team-brand" title="' + escapeHtml(team.name) + '">' +
          logoHtml +
          '<span class="rwb-visually-hidden">' + escapeHtml(team.name) + '</span>' +
        '</div>' +
        '<div class="rwb-chip-row">' +
          '<span class="rwb-chip"><span class="rwb-chip-label">Players</span><span class="rwb-chip-value">' + escapeHtml(String(filteredPlayers.length)) + '/' + escapeHtml(String(team.summary.players)) + '</span></span>' +
          '<span class="rwb-chip"><span class="rwb-chip-label">Cap Total</span><span class="rwb-chip-value">' + escapeHtml(money(team.summary.capTotal)) + '</span></span>' +
          '<span class="rwb-chip"><span class="rwb-chip-label">Taxi</span><span class="rwb-chip-value">' + escapeHtml(String(team.summary.taxi)) + '</span></span>' +
          '<span class="rwb-chip ' + complianceClass + '"><span class="rwb-chip-label">Compliance</span><span class="rwb-chip-value">' + escapeHtml(complianceText) + '</span></span>' +
        '</div>' +
        '<div class="rwb-team-actions">' +
          '<button type="button" class="rwb-btn rwb-btn-ghost" data-action="team-collapse" data-team-id="' + escapeHtml(team.id) + '" aria-expanded="' + (collapsed ? "false" : "true") + '">' + (collapsed ? "Expand" : "Collapse") + '</button>' +
        '</div>' +
      '</header>'
    );
  }

  function rosterGroupHtml(team, group) {
    var rows = [];
    for (var j = 0; j < group.players.length; j += 1) {
      var p = group.players[j];
      var tags = [];
      if (p.isTaxi) tags.push('<span class="rwb-tag is-taxi">Taxi</span>');
      if (p.isIr) tags.push('<span class="rwb-tag is-ir">IR</span>');

      rows.push(
        '<tr class="rwb-player-row" data-player-id="' + escapeHtml(p.id) + '">' +
          '<td>' +
            '<div class="rwb-player-name-wrap">' +
              '<div class="rwb-player-line">' +
                '<span class="rwb-pos-pill">' + escapeHtml(safeStr(p.positionGroup)) + '</span>' +
                '<span class="rwb-player-name">' + escapeHtml(p.name) + '</span>' +
                tags.join("") +
                '<button type="button" class="rwb-row-more" data-action="row-more" aria-expanded="false">More</button>' +
              '</div>' +
              '<dl class="rwb-mobile-details">' +
                '<div><dt>Type</dt><dd>' + escapeHtml(p.type) + '</dd></div>' +
                '<div><dt>Special</dt><dd>' + escapeHtml(p.special) + '</dd></div>' +
                '<div><dt>Bye</dt><dd>' + escapeHtml(p.bye || "-") + '</dd></div>' +
              '</dl>' +
            '</div>' +
          '</td>' +
          '<td class="rwb-cell-num">' + escapeHtml(formatPoints(pointsForPlayer(p))) + '</td>' +
          '<td class="rwb-cell-num rwb-col-secondary">' + escapeHtml(p.bye || "-") + '</td>' +
          '<td class="rwb-cell-num">' + escapeHtml(money(p.salary)) + '</td>' +
          '<td class="rwb-cell-num">' + escapeHtml(String(p.years)) + '</td>' +
          '<td><span class="rwb-type-pill ' + typeTone(p.type) + '">' + escapeHtml(p.type) + '</span></td>' +
          '<td class="rwb-col-secondary">' + escapeHtml(p.special) + '</td>' +
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
                '<th>Player</th>' +
                '<th>Pts ' + escapeHtml(pointModeLabel(state.pointsMode)) + '</th>' +
                '<th class="rwb-col-secondary">Bye</th>' +
                '<th>Salary</th>' +
                '<th>Years</th>' +
                '<th>Type</th>' +
                '<th class="rwb-col-secondary">Special</th>' +
              '</tr>' +
            '</thead>' +
            '<tbody>' + rows.join("") + '</tbody>' +
          '</table>' +
        '</div>' +
      '</details>'
    );
  }

  function projectSalaryByYear(player, offsets) {
    var years = safeInt(player && player.years, 0);
    var salary = safeInt(player && player.salary, 0);
    var out = [];
    for (var i = 0; i < offsets; i += 1) {
      out.push(years > i ? salary : 0);
    }
    return out;
  }

  function contractBodyHtml(team, filteredPlayers) {
    var base = currentYearInt();
    var years = [String(base), String(base + 1), String(base + 2)];
    var rows = [];

    var nonTaxiPlayersUnderContract = 0;
    var nonTaxiTotals = [0, 0, 0];
    var taxiPlayersShown = 0;
    var taxiTotals = [0, 0, 0];

    var sorted = filteredPlayers.slice().sort(function (a, b) {
      var av = positionSortValue(a.positionGroup);
      var bv = positionSortValue(b.positionGroup);
      if (av !== bv) return av - bv;
      return safeStr(a.name).localeCompare(safeStr(b.name));
    });

    for (var i = 0; i < sorted.length; i += 1) {
      var p = sorted[i];
      var proj = projectSalaryByYear(p, 3);
      var isUnderContract = proj[0] > 0 || proj[1] > 0 || proj[2] > 0;

      if (p.isTaxi) {
        taxiPlayersShown += 1;
        taxiTotals[0] += proj[0];
        taxiTotals[1] += proj[1];
        taxiTotals[2] += proj[2];
      } else if (isUnderContract) {
        nonTaxiPlayersUnderContract += 1;
        nonTaxiTotals[0] += proj[0];
        nonTaxiTotals[1] += proj[1];
        nonTaxiTotals[2] += proj[2];
      }

      rows.push(
        '<tr class="rwb-player-row' + (p.isTaxi ? ' rwb-player-row-taxi' : '') + '">' +
          '<td>' +
            '<div class="rwb-player-line">' +
              '<span class="rwb-pos-pill">' + escapeHtml(safeStr(p.positionGroup)) + '</span>' +
              '<span class="rwb-player-name">' + escapeHtml(p.name) + '</span>' +
              (p.isTaxi ? '<span class="rwb-tag is-taxi">Taxi</span>' : '') +
            '</div>' +
          '</td>' +
          '<td class="rwb-cell-num' + (proj[0] === 0 ? ' rwb-money-zero' : '') + '">' + escapeHtml(money(proj[0])) + '</td>' +
          '<td class="rwb-cell-num' + (proj[1] === 0 ? ' rwb-money-zero' : '') + '">' + escapeHtml(money(proj[1])) + '</td>' +
          '<td class="rwb-cell-num' + (proj[2] === 0 ? ' rwb-money-zero' : '') + '">' + escapeHtml(money(proj[2])) + '</td>' +
          '<td><span class="rwb-type-pill ' + typeTone(p.type) + '">' + escapeHtml(p.type) + '</span></td>' +
        '</tr>'
      );
    }

    if (!rows.length) {
      return '<div class="rwb-empty">No players match the current filters for this team.</div>';
    }

    var nonTaxiThreeYear = nonTaxiTotals[0] + nonTaxiTotals[1] + nonTaxiTotals[2];
    var taxiThreeYear = taxiTotals[0] + taxiTotals[1] + taxiTotals[2];

    return (
      '<div class="rwb-table-wrap">' +
        '<table class="rwb-table rwb-contract-table" aria-label="' + escapeHtml(team.name + " contract view") + '">' +
          '<thead>' +
            '<tr>' +
              '<th>Player</th>' +
              '<th>' + escapeHtml(years[0]) + '</th>' +
              '<th>' + escapeHtml(years[1]) + '</th>' +
              '<th>' + escapeHtml(years[2]) + '</th>' +
              '<th>Type</th>' +
            '</tr>' +
          '</thead>' +
          '<tbody>' + rows.join("") + '</tbody>' +
        '</table>' +
      '</div>' +
      '<div class="rwb-contract-summary">' +
        '<div class="rwb-contract-summary-row">Under Contract (Non-Taxi): <strong>' +
          escapeHtml(String(nonTaxiPlayersUnderContract)) +
          '</strong> players | ' +
          escapeHtml(years[0]) + ' <strong>' + escapeHtml(money(nonTaxiTotals[0])) + '</strong> | ' +
          escapeHtml(years[1]) + ' <strong>' + escapeHtml(money(nonTaxiTotals[1])) + '</strong> | ' +
          escapeHtml(years[2]) + ' <strong>' + escapeHtml(money(nonTaxiTotals[2])) + '</strong> | 3-Year <strong>' + escapeHtml(money(nonTaxiThreeYear)) + '</strong>' +
        '</div>' +
        '<div class="rwb-contract-summary-row rwb-contract-summary-row-muted">Taxi (excluded from totals): <strong>' +
          escapeHtml(String(taxiPlayersShown)) +
          '</strong> players | ' +
          escapeHtml(years[0]) + ' <strong>' + escapeHtml(money(taxiTotals[0])) + '</strong> | ' +
          escapeHtml(years[1]) + ' <strong>' + escapeHtml(money(taxiTotals[1])) + '</strong> | ' +
          escapeHtml(years[2]) + ' <strong>' + escapeHtml(money(taxiTotals[2])) + '</strong> | 3-Year <strong>' + escapeHtml(money(taxiThreeYear)) + '</strong>' +
        '</div>' +
      '</div>'
    );
  }

  function teamCardHtml(team) {
    var players = team.players || [];
    var filtered = [];
    for (var i = 0; i < players.length; i += 1) {
      if (matchesFilters(players[i])) filtered.push(players[i]);
    }

    var collapsed = isTeamCollapsed(team.id);
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
        '<div class="rwb-team-body"' + (collapsed ? ' hidden' : '') + '>' + bodyHtml + '</div>' +
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

    for (var t = 0; t < state.teams.length; t += 1) {
      var players = state.teams[t].players || [];
      for (var p = 0; p < players.length; p += 1) {
        var player = players[p];
        if (!matchesFilters(player)) continue;
        var proj = projectSalaryByYear(player, 3);
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

    var nonTaxiThree = nonTaxiTotals[0] + nonTaxiTotals[1] + nonTaxiTotals[2];
    var taxiThree = taxiTotals[0] + taxiTotals[1] + taxiTotals[2];

    return (
      '<article class="rwb-team-card rwb-contract-summary-league">' +
        '<div class="rwb-contract-summary rwb-contract-summary--league">' +
          '<div class="rwb-contract-summary-row">League Summary (Non-Taxi): <strong>' + escapeHtml(String(nonTaxiPlayers)) + '</strong> players | ' +
            escapeHtml(String(years[0])) + ' <strong>' + escapeHtml(money(nonTaxiTotals[0])) + '</strong> | ' +
            escapeHtml(String(years[1])) + ' <strong>' + escapeHtml(money(nonTaxiTotals[1])) + '</strong> | ' +
            escapeHtml(String(years[2])) + ' <strong>' + escapeHtml(money(nonTaxiTotals[2])) + '</strong> | 3-Year <strong>' + escapeHtml(money(nonTaxiThree)) + '</strong>' +
          '</div>' +
          '<div class="rwb-contract-summary-row rwb-contract-summary-row-muted">Taxi (excluded): <strong>' + escapeHtml(String(taxiPlayers)) + '</strong> players | ' +
            escapeHtml(String(years[0])) + ' <strong>' + escapeHtml(money(taxiTotals[0])) + '</strong> | ' +
            escapeHtml(String(years[1])) + ' <strong>' + escapeHtml(money(taxiTotals[1])) + '</strong> | ' +
            escapeHtml(String(years[2])) + ' <strong>' + escapeHtml(money(taxiTotals[2])) + '</strong> | 3-Year <strong>' + escapeHtml(money(taxiThree)) + '</strong>' +
          '</div>' +
        '</div>' +
      '</article>'
    );
  }

  function renderTeams() {
    if (!els.teamList) return;

    var totalPlayers = 0;
    var visiblePlayers = 0;
    var html = [];

    for (var i = 0; i < state.teams.length; i += 1) {
      var team = state.teams[i] || {};
      totalPlayers += (team.players || []).length;
      for (var j = 0; j < (team.players || []).length; j += 1) {
        if (matchesFilters(team.players[j])) visiblePlayers += 1;
      }
      html.push(teamCardHtml(team));
    }

    if (state.view === "contract") {
      html.push(summarizeContractLeague());
    }

    if (!html.length) {
      els.teamList.innerHTML = '<div class="rwb-empty">No roster teams found.</div>';
    } else {
      els.teamList.innerHTML = html.join("");
    }

    renderToolbarNote(visiblePlayers, totalPlayers);
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
    writeStorage("taxiOnly", state.taxiOnly);
    writeStorage("collapsed", state.collapsed);
    writeStorage("filtersOpen", state.filtersOpen);
    writeStorage("view", state.view);
    writeStorage("pointsMode", state.pointsMode);
  }

  function restoreState() {
    state.search = safeStr(readStorage("search", "")).toLowerCase();
    state.filterPosition = safeStr(readStorage("filterPosition", "")).toUpperCase();
    state.filterType = normType(readStorage("filterType", ""));
    state.taxiOnly = !!readStorage("taxiOnly", false);
    state.collapsed = readStorage("collapsed", {});
    state.filtersOpen = !!readStorage("filtersOpen", false);
    state.view = safeStr(readStorage("view", "roster")) === "contract" ? "contract" : "roster";
    state.pointsMode = safeStr(readStorage("pointsMode", ""));

    if (["", "rookie", "loaded", "other"].indexOf(state.filterType) === -1) {
      state.filterType = "";
    }
  }

  function jumpToTeam(teamId) {
    if (!teamId) return;
    state.collapsed[teamId] = false;
    persistState();
    renderTeams();

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

  function onClick(evt) {
    var target = evt.target;
    if (!target || !target.closest) return;

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
      if (nextView !== "contract" && nextView !== "roster") return;
      if (state.view !== nextView) {
        state.view = nextView;
        persistState();
        renderToolbar();
        renderTeams();
      }
      return;
    }

    var collapseBtn = target.closest("[data-action='team-collapse']");
    if (collapseBtn) {
      var teamId = safeStr(collapseBtn.getAttribute("data-team-id"));
      if (!teamId) return;
      state.collapsed[teamId] = !isTeamCollapsed(teamId);
      persistState();
      renderTeams();
      return;
    }

    if (target === els.toggleFilters) {
      state.filtersOpen = !state.filtersOpen;
      persistState();
      renderToolbar();
      return;
    }

    if (target === els.taxiOnly) {
      state.taxiOnly = !state.taxiOnly;
      persistState();
      renderToolbar();
      renderTeams();
      return;
    }

    if (target === els.resetFilters) {
      state.search = "";
      state.filterPosition = "";
      state.filterType = "";
      state.taxiOnly = false;
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
      return;
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
    var pointsUrl = buildApiExportUrl(ctx.year, "playerScores", { L: ctx.leagueId, W: "YTD" });

    return Promise.all([
      fetchJson(leagueUrl),
      fetchJson(rostersUrl),
      fetchJson(salariesUrl).catch(function () { return {}; }),
      fetchJson(pointsUrl).catch(function () { return {}; }),
      fetchByesWithFallback(ctx)
    ]).then(function (parts) {
      var leaguePayload = parts[0] || {};
      var rostersPayload = parts[1] || {};
      var salariesPayload = parts[2] || {};
      var pointsPayload = parts[3] || {};
      var byeResult = parts[4] || { year: ctx.year, map: {} };

      var playerIds = collectRosterPlayerIds(rostersPayload);
      return fetchPlayersMap(ctx.year, playerIds).then(function (playersMap) {
        var leagueMeta = parseLeagueMeta(leaguePayload);
        var salaryMap = toSalaryMap(salariesPayload);
        var scores = toScoreMap(pointsPayload);

        var teams = buildTeams(
          rostersPayload,
          leagueMeta,
          playersMap,
          scores,
          byeResult.map || {},
          salaryMap
        );

        return {
          teams: teams,
          leagueMeta: leagueMeta
        };
      });
    });
  }

  function loadDataFromWorkerApi(ctx) {
    var endpoint = resolveWorkerApiEndpoint();
    var url = new URL(endpoint, window.location.href);
    url.searchParams.set("L", String(ctx.leagueId));
    url.searchParams.set("YEAR", String(ctx.year));
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
        }
      };
    });
  }

  function summarizeError(err) {
    if (!err) return "unknown error";
    return safeStr(err.message || err) || "unknown error";
  }

  function loadData(ctx) {
    var baseLoader = useDirectMflMode()
      ? loadDataFromDirectExports(ctx)
      : loadDataFromWorkerApi(ctx).catch(function (workerErr) {
          return loadDataFromDirectExports(ctx).catch(function (directErr) {
            throw new Error(
              "Worker API failed (" + summarizeError(workerErr) + "). " +
              "Direct export fallback failed (" + summarizeError(directErr) + ")."
            );
          });
        });

    return baseLoader.then(function (result) {
      var teams = result.teams || [];
      return hydrateTeamsWithPointsHistory(ctx, teams).then(function (years) {
        result.teams = teams;
        result.pointYears = years && years.length ? years : buildPointYears();
        return result;
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

    if (!state.ctx.leagueId) {
      renderSkeleton();
      renderError("Rosters could not determine league id from this page URL.");
      return;
    }

    storagePrefix = "ups:rwb:" + state.ctx.leagueId + ":" + state.ctx.year;
    restoreState();

    renderSkeleton();
    bindEvents();

    loadData(state.ctx)
      .then(function (result) {
        state.teams = result.teams || [];
        state.pointYears = (result.pointYears && result.pointYears.length)
          ? result.pointYears.slice()
          : buildPointYears();

        var allowedPointModes = state.pointYears.concat(["cumulative"]);
        if (allowedPointModes.indexOf(state.pointsMode) === -1) {
          state.pointsMode = state.pointYears[0] || String(currentYearInt());
        }

        renderToolbar();
        renderTeams();
        persistState();
      })
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
