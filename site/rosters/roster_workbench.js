(function () {
  "use strict";

  var BUILD = "2026.03.01.5";
  var BOOT_FLAG = "__ups_roster_workbench_boot_" + BUILD;
  if (window[BOOT_FLAG]) {
    if (typeof window.UPS_RWB_INIT === "function") window.UPS_RWB_INIT();
    return;
  }
  window[BOOT_FLAG] = true;

  var POS_ORDER = ["QB", "RB", "WR", "TE", "PK", "PN", "DT", "DE", "LB", "CB", "S", "DL", "DB"];
  var SORT_OPTIONS = [
    { value: "default", label: "Default" },
    { value: "salary_desc", label: "Salary" },
    { value: "years_desc", label: "Years Remaining" },
    { value: "points_desc", label: "Total Points" },
    { value: "name_asc", label: "Player Name" }
  ];

  var state = {
    ctx: null,
    teams: [],
    pointsYear: "",
    globalSort: "default",
    search: "",
    filterPosition: "",
    filterType: "",
    teamSort: {},
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

  function shortNumber(n) {
    var value = safeNum(n, 0);
    if (!isFinite(value) || value === 0) return "0";
    if (Math.abs(value) >= 1000) {
      return (Math.round(value / 100) / 10).toFixed(1).replace(/\.0$/, "") + "K";
    }
    return String(Math.round(value));
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

  function normType(t) {
    return safeStr(t).toLowerCase();
  }

  function typeTone(type) {
    var t = normType(type);
    if (!t) return "is-veteran";
    if (t.indexOf("rookie") !== -1 || t === "r") return "is-rookie";
    if (t.indexOf("fl") !== -1 || t.indexOf("bl") !== -1 || t.indexOf("tag") !== -1 || t.indexOf("front") !== -1 || t.indexOf("back") !== -1 || t.indexOf("loaded") !== -1) {
      return "is-loaded";
    }
    return "is-veteran";
  }

  function positionSortValue(pos) {
    var key = safeStr(pos).toUpperCase();
    var idx = POS_ORDER.indexOf(key);
    return idx === -1 ? 999 : idx;
  }

  function sortLabel(mode) {
    for (var i = 0; i < SORT_OPTIONS.length; i += 1) {
      if (SORT_OPTIONS[i].value === mode) return SORT_OPTIONS[i].label;
    }
    return "Default";
  }

  function isCurrentMobile() {
    return !!(window.matchMedia && window.matchMedia("(max-width: 760px)").matches);
  }

  function parseBool(v, fallback) {
    if (typeof v === "boolean") return v;
    var s = safeStr(v).toLowerCase();
    if (!s) return !!fallback;
    if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
    if (s === "0" || s === "false" || s === "no" || s === "off") return false;
    return !!fallback;
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
      var score = safeNum(row.score, 0);
      map[id] = score;
    }
    return map;
  }

  function mapSize(map) {
    return Object.keys(map || {}).length;
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

  function normalizeStatus(s) {
    var raw = safeStr(s).toUpperCase();
    if (!raw) return "ROSTER";
    if (raw === "TS" || raw.indexOf("TAXI") !== -1) return "TAXI_SQUAD";
    if (raw === "IR" || raw.indexOf("INJURED") !== -1) return "INJURED_RESERVE";
    return raw;
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
    if (!capAmount) {
      return {
        ok: true,
        label: "Compliant"
      };
    }
    if (capTotal <= capAmount) {
      return {
        ok: true,
        label: "Compliant"
      };
    }
    return {
      ok: false,
      label: "Over " + money(capTotal - capAmount)
    };
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

        players.push({
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
          isIr: isIr
        });
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
    return {
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
      isIr: isIr
    };
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

  function getTeamSort(teamId) {
    var mode = safeStr(state.teamSort[teamId] || "");
    return mode || state.globalSort || "default";
  }

  function sortPlayers(list, mode) {
    var rows = list.slice();
    switch (mode) {
      case "salary_desc":
        rows.sort(function (a, b) {
          return b.salary - a.salary || a.order - b.order;
        });
        break;
      case "years_desc":
        rows.sort(function (a, b) {
          return b.years - a.years || a.order - b.order;
        });
        break;
      case "points_desc":
        rows.sort(function (a, b) {
          return b.points - a.points || a.order - b.order;
        });
        break;
      case "name_asc":
        rows.sort(function (a, b) {
          return safeStr(a.name).localeCompare(safeStr(b.name)) || a.order - b.order;
        });
        break;
      default:
        rows.sort(function (a, b) {
          return a.order - b.order;
        });
        break;
    }
    return rows;
  }

  function isTeamCollapsed(teamId) {
    var saved = state.collapsed[teamId];
    if (typeof saved === "boolean") return saved;
    return isCurrentMobile();
  }

  function groupByPosition(players, mode) {
    var map = Object.create(null);
    var i;
    for (i = 0; i < players.length; i += 1) {
      var p = players[i] || {};
      var pos = safeStr(p.position).toUpperCase() || "OTHER";
      if (!map[pos]) map[pos] = [];
      map[pos].push(p);
    }

    var keys = Object.keys(map);
    keys.sort(function (a, b) {
      var av = positionSortValue(a);
      var bv = positionSortValue(b);
      if (av !== bv) return av - bv;
      return a.localeCompare(b);
    });

    var out = [];
    for (i = 0; i < keys.length; i += 1) {
      var key = keys[i];
      out.push({
        key: key,
        players: sortPlayers(map[key], mode)
      });
    }
    return out;
  }

  function matchesFilters(player) {
    if (!player) return false;

    if (state.search) {
      var hay = [
        player.name,
        player.position,
        player.nflTeam,
        player.type,
        player.special,
        player.teamName
      ].join(" ").toLowerCase();
      if (hay.indexOf(state.search) === -1) return false;
    }

    if (state.filterPosition && safeStr(player.position).toUpperCase() !== state.filterPosition) {
      return false;
    }

    if (state.filterType) {
      var t = normType(player.type);
      if (t !== state.filterType) return false;
    }

    return true;
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
              '<p class="rwb-kicker">UPS Contract Command Center</p>' +
              '<h1 class="rwb-title">Roster Workbench</h1>' +
              '<p class="rwb-subtitle">API-powered roster view with team cards, sorting, filters, and export tools.</p>' +
            '</div>' +
            '<div class="rwb-hero-status"><span class="rwb-status-label">Status</span><span class="rwb-status-value" id="rwbLoadStatus">Loading…</span></div>' +
          '</header>' +
          '<section class="rwb-toolbar" aria-label="Roster toolbar">' +
            '<div class="rwb-toolbar-main">' +
              '<label class="rwb-field"><span>Jump To Team</span><select id="rwbJumpTeam" class="rwb-select"><option value="">Select team…</option></select></label>' +
              '<label class="rwb-field"><span>Sort By</span><select id="rwbGlobalSort" class="rwb-select"></select></label>' +
              '<label class="rwb-field"><span>Search</span><input id="rwbSearch" class="rwb-input" type="search" placeholder="Player, team, position, contract"></label>' +
              '<button type="button" id="rwbToggleFilters" class="rwb-btn rwb-btn-ghost" aria-expanded="false">Filters</button>' +
              '<div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;">' +
                '<button type="button" id="rwbExportCsv" class="rwb-btn rwb-btn-ghost">Download CSV</button>' +
                '<button type="button" id="rwbCopyJson" class="rwb-btn rwb-btn-primary">Copy JSON</button>' +
              '</div>' +
            '</div>' +
            '<div id="rwbAdvancedFilters" class="rwb-toolbar-advanced" hidden>' +
              '<label class="rwb-field"><span>Position</span><select id="rwbFilterPosition" class="rwb-select"><option value="">All Positions</option></select></label>' +
              '<label class="rwb-field"><span>Contract Type</span><select id="rwbFilterType" class="rwb-select"><option value="">All Types</option></select></label>' +
              '<a class="rwb-btn rwb-btn-link rwb-btn-ghost" id="rwbOldRosterLink" href="#" target="_self" rel="noopener">Old Roster</a>' +
            '</div>' +
            '<div class="rwb-toolbar-note" id="rwbToolbarNote">Loading roster data…</div>' +
          '</section>' +
          '<section id="rwbTeamList" class="rwb-team-list" aria-live="polite"><div class="rwb-loading">Loading roster data…</div></section>' +
        '</div>' +
      '</div>';

    els.app = document.getElementById("rwbApp");
    els.loadStatus = document.getElementById("rwbLoadStatus");
    els.jumpTeam = document.getElementById("rwbJumpTeam");
    els.globalSort = document.getElementById("rwbGlobalSort");
    els.search = document.getElementById("rwbSearch");
    els.toggleFilters = document.getElementById("rwbToggleFilters");
    els.advanced = document.getElementById("rwbAdvancedFilters");
    els.filterPosition = document.getElementById("rwbFilterPosition");
    els.filterType = document.getElementById("rwbFilterType");
    els.exportCsv = document.getElementById("rwbExportCsv");
    els.copyJson = document.getElementById("rwbCopyJson");
    els.note = document.getElementById("rwbToolbarNote");
    els.teamList = document.getElementById("rwbTeamList");
    els.oldRosterLink = document.getElementById("rwbOldRosterLink");
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
    var posMap = Object.create(null);
    var typeMap = Object.create(null);

    for (var i = 0; i < state.teams.length; i += 1) {
      var team = state.teams[i] || {};
      var players = team.players || [];
      for (var j = 0; j < players.length; j += 1) {
        var p = players[j] || {};
        var pos = safeStr(p.position).toUpperCase();
        if (pos) posMap[pos] = true;

        var typeRaw = safeStr(p.type);
        var typeKey = normType(typeRaw);
        if (typeKey) typeMap[typeKey] = typeRaw;
      }
    }

    var posKeys = Object.keys(posMap);
    posKeys.sort(function (a, b) {
      var av = positionSortValue(a);
      var bv = positionSortValue(b);
      if (av !== bv) return av - bv;
      return a.localeCompare(b);
    });

    var typeKeys = Object.keys(typeMap).sort();

    return {
      positions: [{ value: "", label: "All Positions" }].concat(
        posKeys.map(function (pos) {
          return { value: pos, label: pos };
        })
      ),
      types: [{ value: "", label: "All Types" }].concat(
        typeKeys.map(function (k) {
          return { value: k, label: typeMap[k] || k };
        })
      )
    };
  }

  function renderToolbar() {
    if (!els.jumpTeam) return;

    var jumpOptions = [{ value: "", label: "Select team…" }];
    for (var i = 0; i < state.teams.length; i += 1) {
      jumpOptions.push({ value: state.teams[i].id, label: state.teams[i].name });
    }
    renderSelectOptions(els.jumpTeam, jumpOptions, "");

    renderSelectOptions(els.globalSort, SORT_OPTIONS, state.globalSort);
    els.search.value = state.search;

    var sets = buildFilterOptionSets();
    renderSelectOptions(els.filterPosition, sets.positions, state.filterPosition);
    renderSelectOptions(els.filterType, sets.types, state.filterType);

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

    var oldRosterHref =
      window.location.origin +
      "/" + encodeURIComponent(state.ctx.year) +
      "/options?L=" + encodeURIComponent(state.ctx.leagueId) +
      "&O=07";
    if (els.oldRosterLink) els.oldRosterLink.setAttribute("href", oldRosterHref);
  }

  function renderToolbarNote(visiblePlayers, totalPlayers) {
    if (!els.note) return;

    var parts = [];
    parts.push("Showing " + visiblePlayers + " of " + totalPlayers + " players");
    if (state.filterPosition) parts.push("Pos " + state.filterPosition);
    if (state.filterType) parts.push("Type " + state.filterType);
    if (state.search) parts.push('Search "' + state.search + '"');
    parts.push("Points " + (state.pointsYear || state.ctx.year));

    els.note.textContent = parts.join(" • ");
  }

  function renderStatus(text, isError) {
    if (!els.loadStatus) return;
    els.loadStatus.textContent = text;
    els.loadStatus.style.color = isError ? "#ffb3b3" : "";
  }

  function teamCardHtml(team) {
    var sortMode = getTeamSort(team.id);
    var filtered = [];
    var i;
    for (i = 0; i < team.players.length; i += 1) {
      if (matchesFilters(team.players[i])) filtered.push(team.players[i]);
    }

    var grouped = groupByPosition(filtered, sortMode);
    var collapsed = isTeamCollapsed(team.id);

    var complianceClass = team.summary.compliance.ok ? "is-good" : "is-bad";
    var complianceText = team.summary.compliance.label;

    var logo = safeStr(team.logo);
    var logoHtml = logo
      ? '<img class="rwb-team-logo" src="' + escapeHtml(logo) + '" alt="' + escapeHtml(team.name) + ' logo">'
      : '<span class="rwb-team-logo-fallback" aria-hidden="true">' + escapeHtml(team.fid) + "</span>";

    var sortOptions = SORT_OPTIONS.map(function (opt) {
      return (
        '<option value="' + escapeHtml(opt.value) + '"' +
        (opt.value === sortMode ? " selected" : "") +
        '>' + escapeHtml(opt.label) + "</option>"
      );
    }).join("");

    var bodyHtml = "";
    if (!grouped.length) {
      bodyHtml = '<div class="rwb-empty">No players match the current filters for this team.</div>';
    } else {
      var groups = [];
      for (i = 0; i < grouped.length; i += 1) {
        var group = grouped[i];
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
                    '<span class="rwb-pos-pill">' + escapeHtml(p.position || "-") + '</span>' +
                    '<span class="rwb-player-name">' + escapeHtml(p.name) + '</span>' +
                    tags.join("") +
                    '<button type="button" class="rwb-row-more" data-action="row-more" aria-expanded="false">More</button>' +
                  '</div>' +
                  '<dl class="rwb-mobile-details">' +
                    '<div><dt>Type</dt><dd>' + escapeHtml(p.type) + '</dd></div>' +
                    '<div><dt>Special</dt><dd>' + escapeHtml(p.special) + '</dd></div>' +
                  '</dl>' +
                '</div>' +
              '</td>' +
              '<td class="rwb-cell-num rwb-col-secondary">' + escapeHtml(String((Math.round(p.points * 10) / 10).toFixed(1))) + '</td>' +
              '<td class="rwb-cell-num rwb-col-secondary">' + escapeHtml(p.bye || "-") + '</td>' +
              '<td class="rwb-cell-num">' + escapeHtml(money(p.salary)) + '</td>' +
              '<td class="rwb-cell-num">' + escapeHtml(String(p.years)) + '</td>' +
              '<td><span class="rwb-type-pill ' + typeTone(p.type) + '">' + escapeHtml(p.type) + '</span></td>' +
              '<td class="rwb-col-secondary">' + escapeHtml(p.special) + '</td>' +
            '</tr>'
          );
        }

        groups.push(
          '<details class="rwb-group"' + (i < 2 ? " open" : "") + '>' +
            '<summary>' +
              '<span class="rwb-group-label"><span>' + escapeHtml(group.key) + '</span><span class="rwb-group-count">' + escapeHtml(String(group.players.length)) + '</span></span>' +
              '<span class="rwb-group-count">' + escapeHtml(sortLabel(sortMode)) + '</span>' +
            '</summary>' +
            '<div class="rwb-table-wrap">' +
              '<table class="rwb-table" aria-label="' + escapeHtml(team.name + " " + group.key + " roster") + '">' +
                '<thead>' +
                  '<tr>' +
                    '<th>Player</th>' +
                    '<th class="rwb-col-secondary">Pts ' + escapeHtml(String(state.pointsYear || state.ctx.year)) + '</th>' +
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
      bodyHtml = groups.join("");
    }

    return (
      '<article class="rwb-team-card" id="rwb-team-' + escapeHtml(team.id) + '" data-team-id="' + escapeHtml(team.id) + '">' +
        '<header class="rwb-team-head">' +
          '<div class="rwb-team-brand">' +
            logoHtml +
            '<div>' +
              '<h2 class="rwb-team-name">' + escapeHtml(team.name) + '</h2>' +
              '<p class="rwb-team-sort-note">Sort: ' + escapeHtml(sortLabel(sortMode)) + '</p>' +
            '</div>' +
          '</div>' +
          '<div class="rwb-chip-row">' +
            '<span class="rwb-chip"><span class="rwb-chip-label">Players</span><span class="rwb-chip-value">' + escapeHtml(String(filtered.length)) + '/' + escapeHtml(String(team.summary.players)) + '</span></span>' +
            '<span class="rwb-chip"><span class="rwb-chip-label">Cap Total</span><span class="rwb-chip-value">' + escapeHtml(money(team.summary.capTotal)) + '</span></span>' +
            '<span class="rwb-chip"><span class="rwb-chip-label">Taxi</span><span class="rwb-chip-value">' + escapeHtml(String(team.summary.taxi)) + '</span></span>' +
            '<span class="rwb-chip ' + complianceClass + '"><span class="rwb-chip-label">Compliance</span><span class="rwb-chip-value">' + escapeHtml(complianceText) + '</span></span>' +
          '</div>' +
          '<div class="rwb-team-actions">' +
            '<label class="rwb-visually-hidden" for="rwb-sort-' + escapeHtml(team.id) + '">Sort ' + escapeHtml(team.name) + '</label>' +
            '<select id="rwb-sort-' + escapeHtml(team.id) + '" class="rwb-select rwb-team-sort" data-action="team-sort" data-team-id="' + escapeHtml(team.id) + '">' + sortOptions + '</select>' +
            '<button type="button" class="rwb-btn rwb-btn-ghost" data-action="team-collapse" data-team-id="' + escapeHtml(team.id) + '" aria-expanded="' + (collapsed ? "false" : "true") + '">' + (collapsed ? "Expand" : "Collapse") + '</button>' +
          '</div>' +
        '</header>' +
        '<div class="rwb-team-body"' + (collapsed ? ' hidden' : '') + '>' +
          bodyHtml +
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

    if (!html.length) {
      els.teamList.innerHTML = '<div class="rwb-empty">No roster teams found.</div>';
    } else {
      els.teamList.innerHTML = html.join("");
    }

    renderToolbarNote(visiblePlayers, totalPlayers);
  }

  function collectExportRows() {
    var rows = [];
    for (var i = 0; i < state.teams.length; i += 1) {
      var team = state.teams[i] || {};
      var players = team.players || [];
      for (var j = 0; j < players.length; j += 1) {
        var p = players[j] || {};
        rows.push({
          team_id: team.id,
          team_name: team.name,
          player_id: p.id,
          player_name: p.name,
          position: p.position,
          points_year: state.pointsYear || state.ctx.year,
          points: p.points,
          bye: p.bye,
          salary: p.salary,
          years: p.years,
          contract_type: p.type,
          special: p.special,
          status: p.status
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
      "points_year",
      "points",
      "bye",
      "salary",
      "years",
      "contract_type",
      "special",
      "status"
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

  function copyJson(rows) {
    var json = JSON.stringify(rows, null, 2);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(json).catch(function () {
        download("ups-rosters.json", json, "application/json;charset=utf-8");
      });
    }
    download("ups-rosters.json", json, "application/json;charset=utf-8");
    return Promise.resolve();
  }

  function persistState() {
    writeStorage("globalSort", state.globalSort);
    writeStorage("search", state.search);
    writeStorage("filterPosition", state.filterPosition);
    writeStorage("filterType", state.filterType);
    writeStorage("teamSort", state.teamSort);
    writeStorage("collapsed", state.collapsed);
    writeStorage("filtersOpen", state.filtersOpen);
  }

  function restoreState() {
    state.globalSort = safeStr(readStorage("globalSort", "default")) || "default";
    state.search = safeStr(readStorage("search", "")).toLowerCase();
    state.filterPosition = safeStr(readStorage("filterPosition", "")).toUpperCase();
    state.filterType = normType(readStorage("filterType", ""));
    state.teamSort = readStorage("teamSort", {});
    state.collapsed = readStorage("collapsed", {});
    state.filtersOpen = !!readStorage("filtersOpen", false);

    var allowedSort = Object.create(null);
    for (var i = 0; i < SORT_OPTIONS.length; i += 1) {
      allowedSort[SORT_OPTIONS[i].value] = true;
    }

    if (!allowedSort[state.globalSort]) state.globalSort = "default";

    Object.keys(state.teamSort || {}).forEach(function (teamId) {
      if (!allowedSort[state.teamSort[teamId]]) delete state.teamSort[teamId];
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

    var collapseBtn = target.closest("[data-action='team-collapse']");
    if (collapseBtn) {
      var teamId = safeStr(collapseBtn.getAttribute("data-team-id"));
      if (!teamId) return;
      state.collapsed[teamId] = !isTeamCollapsed(teamId);
      persistState();
      renderTeams();
      return;
    }

    if (target === els.exportCsv) {
      var rowsCsv = collectExportRows();
      var csv = toCsv(rowsCsv);
      var stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
      download("ups-rosters-" + stamp + ".csv", csv, "text/csv;charset=utf-8");
      return;
    }

    if (target === els.copyJson) {
      var rowsJson = collectExportRows();
      copyJson(rowsJson).then(function () {
        renderStatus("JSON copied", false);
        setTimeout(function () {
          renderStatus("Live", false);
        }, 1400);
      });
      return;
    }

    if (target === els.toggleFilters) {
      state.filtersOpen = !state.filtersOpen;
      persistState();
      renderToolbar();
      return;
    }
  }

  function onChange(evt) {
    var el = evt.target;
    if (!el) return;

    if (el === els.globalSort) {
      state.globalSort = safeStr(el.value || "default");
      persistState();
      renderTeams();
      return;
    }

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
      state.collapsed[teamId] = false;
      persistState();
      renderTeams();
      setTimeout(function () {
        var node = document.getElementById("rwb-team-" + teamId);
        if (node && node.scrollIntoView) {
          node.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }, 0);
      return;
    }

    var teamSort = el.closest("[data-action='team-sort']");
    if (teamSort) {
      var tid = safeStr(teamSort.getAttribute("data-team-id"));
      if (!tid) return;
      var mode = safeStr(teamSort.value || "default");
      if (mode === state.globalSort) {
        delete state.teamSort[tid];
      } else {
        state.teamSort[tid] = mode;
      }
      persistState();
      renderTeams();
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

  function fetchPointsWithFallback(ctx) {
    var primaryYear = safeInt(ctx.year, new Date().getFullYear());
    var years = [String(primaryYear), String(primaryYear - 1)];

    function attempt(idx) {
      if (idx >= years.length) {
        return Promise.resolve({ year: String(primaryYear), map: Object.create(null) });
      }

      var y = years[idx];
      var url = buildExportUrl(ctx.hostOrigin, y, "playerScores", {
        L: ctx.leagueId,
        W: "YTD"
      });

      return fetchJson(url).then(function (payload) {
        var map = toScoreMap(payload);
        if (mapSize(map) > 0) return { year: y, map: map };
        return attempt(idx + 1);
      }).catch(function () {
        return attempt(idx + 1);
      });
    }

    return attempt(0);
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

    return Promise.all([
      fetchJson(leagueUrl),
      fetchJson(rostersUrl),
      fetchJson(salariesUrl).catch(function () { return {}; }),
      fetchPointsWithFallback(ctx),
      fetchByesWithFallback(ctx)
    ]).then(function (parts) {
      var leaguePayload = parts[0] || {};
      var rostersPayload = parts[1] || {};
      var salariesPayload = parts[2] || {};
      var pointsResult = parts[3] || { year: ctx.year, map: {} };
      var byeResult = parts[4] || { year: ctx.year, map: {} };

      var playerIds = collectRosterPlayerIds(rostersPayload);
      return fetchPlayersMap(ctx.year, playerIds).then(function (playersMap) {
        var leagueMeta = parseLeagueMeta(leaguePayload);
        var salaryMap = toSalaryMap(salariesPayload);

        var teams = buildTeams(
          rostersPayload,
          leagueMeta,
          playersMap,
          pointsResult.map || {},
          byeResult.map || {},
          salaryMap
        );

        return {
          teams: teams,
          pointsYear: pointsResult.year || ctx.year,
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
      if (!teams.length) {
        throw new Error("Worker API returned no teams");
      }
      return {
        teams: teams,
        pointsYear: safeStr(payload.points_year || ctx.year) || ctx.year,
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
    if (useDirectMflMode()) {
      return loadDataFromDirectExports(ctx);
    }
    return loadDataFromWorkerApi(ctx).catch(function (workerErr) {
      return loadDataFromDirectExports(ctx).catch(function (directErr) {
        throw new Error(
          "Worker API failed (" + summarizeError(workerErr) + "). " +
          "Direct export fallback failed (" + summarizeError(directErr) + ")."
        );
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
    renderStatus("Load failed", true);
    if (els.note) els.note.textContent = message;
  }

  function init() {
    state.ctx = detectContext();

    if (!state.ctx.leagueId) {
      renderSkeleton();
      renderError("Roster Workbench could not determine league id from this page URL.");
      return;
    }

    storagePrefix = "ups:rwb:" + state.ctx.leagueId + ":" + state.ctx.year;
    restoreState();

    renderSkeleton();
    bindEvents();
    renderToolbar();
    renderStatus("Loading", false);

    loadData(state.ctx)
      .then(function (result) {
        state.teams = result.teams || [];
        state.pointsYear = safeStr(result.pointsYear || state.ctx.year);
        renderToolbar();
        renderTeams();
        renderStatus("Live", false);
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
