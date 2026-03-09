(function () {
  "use strict";

  if (!window.UPSReports) return;

  var MANIFEST_URL = "./player_scoring/player_scoring_manifest.json";
  var DEFAULT_PAGE_SIZE = 50;
  var MIN_COMPARE_PLAYERS = 2;
  var MAX_COMPARE_PLAYERS = 4;
  var TABLE_COLUMNS = [
    { key: "player_name", label: "Player", type: "text", align: "left" },
    { key: "position_group", label: "Pos", type: "text", align: "left" },
    { key: "team", label: "NFL", type: "text", align: "left" },
    { key: "roster_status", label: "Roster Status", type: "text", align: "left" },
    { key: "games_played", label: "Games", type: "number", digits: 0 },
    { key: "games_started", label: "Starts", type: "number", digits: 0 },
    { key: "games_benched", label: "Benched", type: "number", digits: 0 },
    { key: "total_points", label: "Total", type: "number", digits: 1 },
    { key: "points_per_game", label: "PPG", type: "number", digits: 3 },
    { key: "trend_view", sortKey: "recent_trend_delta", label: "Trend", type: "trend", align: "left" },
    { key: "median_points", label: "Median", type: "number", digits: 3 },
    { key: "max_points", label: "Max", type: "number", digits: 1 },
    { key: "min_points", label: "Min", type: "number", digits: 1 },
    { key: "standard_deviation", label: "Std Dev", type: "number", digits: 3 },
    { key: "elite_weeks", label: "Elite", type: "number", digits: 0 },
    { key: "neutral_weeks", label: "Neutral", type: "number", digits: 0 },
    { key: "dud_weeks", label: "Dud", type: "number", digits: 0 },
    { key: "elite_week_rate", label: "Elite %", type: "percent", digits: 1 },
    { key: "dud_week_rate", label: "Dud %", type: "percent", digits: 1 },
    { key: "positional_rank", label: "Pos Rk", type: "number", digits: 0 },
    { key: "percentile_rank", label: "Percentile", type: "percent", digits: 1 },
    { key: "vam", label: "VAM", type: "signed", digits: 3 },
    { key: "consistency_index", label: "Consistency", type: "number", digits: 1 }
  ];
  var MOBILE_METRICS = [
    { key: "points_per_game", label: "PPG", type: "number", digits: 3 },
    { key: "games_started", label: "Starts", type: "number", digits: 0 },
    { key: "games_benched", label: "Benched", type: "number", digits: 0 },
    { key: "elite_week_rate", label: "Elite %", type: "percent", digits: 1 },
    { key: "dud_week_rate", label: "Dud %", type: "percent", digits: 1 },
    { key: "vam", label: "VAM", type: "signed", digits: 3 },
    { key: "consistency_index", label: "Consistency", type: "number", digits: 1 },
    { key: "positional_rank", label: "Pos Rk", type: "number", digits: 0 }
  ];
  var COMPARE_METRICS = [
    { key: "total_points", label: "Total", type: "number", digits: 1 },
    { key: "points_per_game", label: "PPG", type: "number", digits: 3 },
    { key: "elite_weeks", label: "Elite", type: "number", digits: 0 },
    { key: "neutral_weeks", label: "Neutral", type: "number", digits: 0 },
    { key: "dud_weeks", label: "Dud", type: "number", digits: 0 },
    { key: "vam", label: "VAM", type: "signed", digits: 3 },
    { key: "consistency_index", label: "Consistency", type: "number", digits: 1 },
    { key: "last_3_avg", label: "Last 3 Avg", type: "number", digits: 1 },
    { key: "last_5_avg", label: "Last 5 Avg", type: "number", digits: 1 },
    { key: "best_streak", label: "Best Elite Streak", type: "number", digits: 0 },
    { key: "dud_streak", label: "Dud Streak", type: "number", digits: 0 },
    { key: "rolling_volatility", label: "Rolling Volatility", type: "number", digits: 1 },
    { key: "percentile_rank", label: "Percentile", type: "percent", digits: 1 },
    { key: "positional_rank", label: "Pos Rank", type: "number", digits: 0 }
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
          if (!response.ok) throw new Error("Unable to load player scoring manifest.");
          return response.json().then(function (payload) {
            payload._sourceUrl = response.url || MANIFEST_URL;
            manifestCache = payload;
            return payload;
          });
        });
    }
    return manifestPromise;
  }

  function prepareSeasonData(payload) {
    if (!payload || typeof payload !== "object") return null;
    if (!payload._weeklyIndex) {
      payload._weeklyIndex = Object.create(null);
      var schema = (((payload || {}).lookups || {}).weekly_schema) || [];
      schema.forEach(function (key, index) {
        payload._weeklyIndex[key] = index;
      });
      payload._classificationCache = Object.create(null);
      payload._trendCache = Object.create(null);
      payload._weeklyDetailCache = Object.create(null);
    }
    return payload;
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
          if (!response.ok) throw new Error("Unable to load season data for " + season + ".");
          return response.json();
        })
        .then(function (payload) {
          seasonCache[season] = prepareSeasonData(payload);
          return seasonCache[season];
        });
    }
    return seasonPromises[season];
  }

  function renderPlayerScoring(ctx) {
    var common = ctx.common;
    var requestToken = 0;
    var disposed = false;
    var state = {
      manifest: null,
      seasonData: null,
      loading: true,
      error: "",
      season: "",
      search: "",
      position: "",
      team: "",
      rosterStatus: "",
      currentStatus: "",
      usage: "",
      minGames: 0,
      minStarts: 0,
      minPpg: 0,
      eliteThreshold: 75,
      dudThreshold: 25,
      sortKey: "points_per_game",
      sortDir: "desc",
      comparePlayerIds: [],
      compareMessage: "",
      expandedPlayerId: "",
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE
    };

    function defaultThresholds() {
      var meta = ((state.manifest || {}).meta || {}).default_thresholds || {};
      return {
        elite: common.safeInt(meta.elite_percentile, 75),
        dud: common.safeInt(meta.dud_percentile, 25)
      };
    }

    function applyThresholdGuard(source) {
      state.eliteThreshold = common.clamp(common.safeInt(state.eliteThreshold, 75), 50, 99);
      state.dudThreshold = common.clamp(common.safeInt(state.dudThreshold, 25), 1, 49);
      if (state.dudThreshold >= state.eliteThreshold) {
        if (source === "elite") state.dudThreshold = Math.max(1, state.eliteThreshold - 1);
        else state.eliteThreshold = Math.min(99, state.dudThreshold + 1);
      }
    }

    function resetFilters() {
      var thresholds = defaultThresholds();
      state.search = "";
      state.position = "";
      state.team = "";
      state.rosterStatus = "";
      state.currentStatus = "";
      state.usage = "";
      state.minGames = 0;
      state.minStarts = 0;
      state.minPpg = 0;
      state.eliteThreshold = thresholds.elite;
      state.dudThreshold = thresholds.dud;
      state.expandedPlayerId = "";
      applyThresholdGuard("");
      state.page = 1;
    }

    function formatCurrentStatus(status) {
      if (!common.safeStr(status)) return "All statuses";
      if (status === "FREE_AGENT") return "Free Agent";
      return common.titleCase(String(status).replace(/_/g, " "));
    }

    function getPositionLabel(player) {
      if (player.position && player.position !== player.position_group) {
        return player.position + " / " + player.position_group;
      }
      return player.position_group || player.position || "OTHER";
    }

    function getRosterLabel(player) {
      if (player.free_agent_ind) return "Free Agent";
      if (player.franchise_name) return player.franchise_name;
      return formatCurrentStatus(player.current_roster_status);
    }

    function columnSortKey(column) {
      return column && column.sortKey ? column.sortKey : (column ? column.key : "");
    }

    function getSortLabel(column) {
      var sortKey = columnSortKey(column);
      if (state.sortKey !== sortKey) return column.label;
      return column.label + (state.sortDir === "asc" ? " ^" : " v");
    }

    function formatColumnValue(value, column) {
      if (column.type === "signed") return common.formatSigned(value, column.digits);
      if (column.type === "percent") return common.formatPercent(value, column.digits);
      if (column.type === "number") return common.formatNumber(value, column.digits);
      return common.safeStr(value || "-");
    }

    function compareButtonLabel(isSelected) {
      return isSelected ? "Remove from Compare" : "Add to Compare";
    }

    function isCompareSelected(playerId) {
      return state.comparePlayerIds.indexOf(String(playerId)) !== -1;
    }

    function syncCompareSelections(allRows) {
      var available = Object.create(null);
      allRows.forEach(function (entry) {
        available[String(entry.player.player_id)] = true;
      });
      state.comparePlayerIds = state.comparePlayerIds.filter(function (playerId) {
        return !!available[String(playerId)];
      });
    }

    function toggleComparePlayer(playerId) {
      var normalizedId = String(playerId || "");
      if (!normalizedId) return;
      var currentIndex = state.comparePlayerIds.indexOf(normalizedId);
      if (currentIndex !== -1) {
        state.comparePlayerIds.splice(currentIndex, 1);
        state.compareMessage = "";
        return;
      }
      if (state.comparePlayerIds.length >= MAX_COMPARE_PLAYERS) {
        state.compareMessage = "Comparison tray is full. Remove a player before adding another.";
        return;
      }
      state.comparePlayerIds = state.comparePlayerIds.concat(normalizedId);
      state.compareMessage = "";
    }

    function detailDomId(prefix, playerId) {
      return prefix + "-" + common.safeStr(playerId).replace(/[^a-zA-Z0-9_-]+/g, "-");
    }

    function classifyWeeklyPercentile(percentile) {
      var value = common.safeNum(percentile, 0);
      if (value >= state.eliteThreshold) return "elite";
      if (value <= state.dudThreshold) return "dud";
      return "neutral";
    }

    function classificationLabel(classification) {
      if (classification === "elite") return "Elite";
      if (classification === "dud") return "Dud";
      return "Neutral";
    }

    function classificationToneClass(classification) {
      return "is-" + (classification || "neutral");
    }

    function usageStatusLabel(code) {
      var lookup = ((((state.seasonData || {}).lookups || {}).usage_statuses) || []);
      var raw = lookup[common.safeInt(code, -1)] || "";
      if (raw === "starter") return "Starter";
      if (raw === "nonstarter") return "Benched";
      if (raw === "fa") return "Free Agent";
      return raw ? common.titleCase(raw) : "Unknown";
    }

    function roundMetric(value, digits) {
      var precision = Math.pow(10, digits == null ? 3 : digits);
      return Math.round(common.safeNum(value, 0) * precision) / precision;
    }

    function average(values) {
      if (!values || !values.length) return 0;
      return values.reduce(function (sum, value) {
        return sum + common.safeNum(value, 0);
      }, 0) / values.length;
    }

    function standardDeviation(values) {
      if (!values || !values.length) return 0;
      var mean = average(values);
      var variance = values.reduce(function (sum, value) {
        var delta = common.safeNum(value, 0) - mean;
        return sum + (delta * delta);
      }, 0) / values.length;
      return Math.sqrt(Math.max(variance, 0));
    }

    function classifyTrendDirection(delta, reference) {
      var threshold = Math.max(1.25, Math.abs(common.safeNum(reference, 0)) * 0.08);
      if (delta >= threshold) return "up";
      if (delta <= -threshold) return "down";
      return "flat";
    }

    function formatTrendDirection(direction) {
      if (direction === "up") return "Rising";
      if (direction === "down") return "Cooling";
      return "Stable";
    }

    function trendToneClass(direction) {
      if (direction === "up") return "is-up";
      if (direction === "down") return "is-down";
      return "is-flat";
    }

    function emptyTrendMetrics() {
      return {
        weekly: [],
        scores: [],
        last_3_avg: 0,
        last_5_avg: 0,
        recent_trend_delta: 0,
        recent_trend_direction: "flat",
        best_streak: 0,
        dud_streak: 0,
        rolling_volatility: 0
      };
    }

    function buildWeeklyDetailMap() {
      var seasonData = state.seasonData;
      if (!seasonData) return Object.create(null);
      var cacheKey = String(state.eliteThreshold) + ":" + String(state.dudThreshold);
      if (seasonData._weeklyDetailCache[cacheKey]) return seasonData._weeklyDetailCache[cacheKey];
      var idx = seasonData._weeklyIndex || Object.create(null);
      var weekIndex = idx.week;
      var scoreIndex = idx.score;
      var vamIndex = idx.weekly_vam;
      var usageIndex = idx.usage_status_code;
      var percentileIndex = idx.position_week_percentile;
      var byPlayer = Object.create(null);

      Object.keys(seasonData.weekly_scores_by_player || {}).forEach(function (playerId) {
        var entries = (seasonData.weekly_scores_by_player[playerId] || []).map(function (entry) {
          return {
            week: common.safeInt(entry[weekIndex], 0),
            score: common.safeNum(entry[scoreIndex], 0),
            weekly_vam: common.safeNum(entry[vamIndex], 0),
            weekly_position_percentile: common.safeNum(entry[percentileIndex], 0),
            usage_status: usageStatusLabel(entry[usageIndex]),
            weekly_classification: classifyWeeklyPercentile(entry[percentileIndex]),
            classification_streak_count: 0,
            streak_marker: "",
            is_recent_week: false
          };
        }).sort(function (left, right) {
          return left.week - right.week;
        });

        var recentStart = Math.max(0, entries.length - 3);
        var eliteRun = 0;
        var dudRun = 0;
        entries.forEach(function (item, index) {
          item.is_recent_week = index >= recentStart;
          if (item.weekly_classification === "elite") {
            eliteRun += 1;
            dudRun = 0;
            item.classification_streak_count = eliteRun;
            if (eliteRun > 1) item.streak_marker = "Elite x" + eliteRun;
          } else if (item.weekly_classification === "dud") {
            dudRun += 1;
            eliteRun = 0;
            item.classification_streak_count = dudRun;
            if (dudRun > 1) item.streak_marker = "Dud x" + dudRun;
          } else {
            eliteRun = 0;
            dudRun = 0;
          }
        });

        byPlayer[playerId] = entries;
      });

      seasonData._weeklyDetailCache[cacheKey] = byPlayer;
      return byPlayer;
    }

    function buildClassificationMap() {
      var seasonData = state.seasonData;
      if (!seasonData) return Object.create(null);
      var cacheKey = String(state.eliteThreshold) + ":" + String(state.dudThreshold);
      if (seasonData._classificationCache[cacheKey]) return seasonData._classificationCache[cacheKey];
      var weeklyDetailByPlayer = buildWeeklyDetailMap();
      var byPlayer = Object.create(null);
      Object.keys(weeklyDetailByPlayer).forEach(function (playerId) {
        var weekly = weeklyDetailByPlayer[playerId] || [];
        var elite = 0;
        var dud = 0;
        weekly.forEach(function (item) {
          if (item.weekly_classification === "elite") elite += 1;
          else if (item.weekly_classification === "dud") dud += 1;
        });
        byPlayer[playerId] = {
          elite: elite,
          dud: dud,
          neutral: Math.max(0, weekly.length - elite - dud)
        };
      });
      seasonData._classificationCache[cacheKey] = byPlayer;
      return byPlayer;
    }

    function buildTrendMap() {
      var seasonData = state.seasonData;
      if (!seasonData) return Object.create(null);
      var cacheKey = String(state.eliteThreshold) + ":" + String(state.dudThreshold);
      if (seasonData._trendCache[cacheKey]) return seasonData._trendCache[cacheKey];
      var weeklyDetailByPlayer = buildWeeklyDetailMap();
      var byPlayer = Object.create(null);

      Object.keys(weeklyDetailByPlayer).forEach(function (playerId) {
        var weekly = weeklyDetailByPlayer[playerId] || [];
        var scores = weekly.map(function (item) { return item.score; });
        var lastThreeScores = scores.slice(-Math.min(3, scores.length));
        var lastFiveScores = scores.slice(-Math.min(5, scores.length));
        var comparisonScores = scores.slice(
          Math.max(0, scores.length - (lastThreeScores.length * 2)),
          Math.max(0, scores.length - lastThreeScores.length)
        );
        if (!comparisonScores.length) {
          comparisonScores = scores.slice(0, Math.max(0, scores.length - lastThreeScores.length));
        }

        var bestStreak = 0;
        var dudStreak = 0;
        weekly.forEach(function (item) {
          if (item.weekly_classification === "elite") bestStreak = Math.max(bestStreak, item.classification_streak_count);
          if (item.weekly_classification === "dud") dudStreak = Math.max(dudStreak, item.classification_streak_count);
        });

        var last3Avg = roundMetric(average(lastThreeScores), 3);
        var last5Avg = roundMetric(average(lastFiveScores), 3);
        var comparisonAvg = comparisonScores.length ? average(comparisonScores) : average(lastThreeScores);
        var recentTrendDelta = roundMetric(last3Avg - comparisonAvg, 3);

        byPlayer[playerId] = {
          weekly: weekly,
          scores: scores,
          last_3_avg: last3Avg,
          last_5_avg: last5Avg,
          recent_trend_delta: recentTrendDelta,
          recent_trend_direction: classifyTrendDirection(recentTrendDelta, last5Avg || last3Avg),
          best_streak: bestStreak,
          dud_streak: dudStreak,
          rolling_volatility: roundMetric(standardDeviation(lastFiveScores.length ? lastFiveScores : scores), 3)
        };
      });

      seasonData._trendCache[cacheKey] = byPlayer;
      return byPlayer;
    }

    function buildBaseRows() {
      if (!state.seasonData) return [];
      var countsByPlayer = buildClassificationMap();
      var trendByPlayer = buildTrendMap();
      var weeklyDetailByPlayer = buildWeeklyDetailMap();
      return (state.seasonData.players || []).map(function (player) {
        var counts = countsByPlayer[player.player_id] || {
          elite: common.safeInt(player.elite_weeks),
          dud: common.safeInt(player.dud_weeks),
          neutral: common.safeInt(player.neutral_weeks)
        };
        var trend = trendByPlayer[player.player_id] || emptyTrendMetrics();
        var weeklyDetail = weeklyDetailByPlayer[player.player_id] || [];
        var gamesPlayed = common.safeInt(player.games_played);
        var metrics = {
          player_name: player.player_name,
          position_group: getPositionLabel(player),
          team: player.team || "",
          roster_status: getRosterLabel(player),
          games_played: gamesPlayed,
          games_started: common.safeInt(player.games_started != null ? player.games_started : player.starter_count),
          games_benched: common.safeInt(player.games_benched != null ? player.games_benched : player.bench_count),
          total_points: common.safeNum(player.total_points, 0),
          points_per_game: common.safeNum(player.points_per_game, 0),
          median_points: common.safeNum(player.median_points, 0),
          max_points: common.safeNum(player.max_points, 0),
          min_points: common.safeNum(player.min_points, 0),
          standard_deviation: common.safeNum(player.standard_deviation != null ? player.standard_deviation : player.std_dev, 0),
          elite_weeks: counts.elite,
          neutral_weeks: counts.neutral,
          dud_weeks: counts.dud,
          elite_week_rate: gamesPlayed > 0 ? (100 * counts.elite / gamesPlayed) : common.safeNum(player.elite_week_rate != null ? player.elite_week_rate : player.boom_rate, 0),
          dud_week_rate: gamesPlayed > 0 ? (100 * counts.dud / gamesPlayed) : common.safeNum(player.dud_week_rate != null ? player.dud_week_rate : player.bust_rate, 0),
          positional_rank: common.safeInt(player.positional_rank, 0),
          percentile_rank: common.safeNum(player.percentile_rank, 0),
          vam: common.safeNum(player.vam, 0),
          consistency_index: common.safeNum(player.consistency_index, 0),
          last_3_avg: common.safeNum(trend.last_3_avg, 0),
          last_5_avg: common.safeNum(trend.last_5_avg, 0),
          recent_trend_delta: common.safeNum(trend.recent_trend_delta, 0),
          recent_trend_direction: trend.recent_trend_direction,
          best_streak: common.safeInt(trend.best_streak, 0),
          dud_streak: common.safeInt(trend.dud_streak, 0),
          rolling_volatility: common.safeNum(trend.rolling_volatility, 0)
        };
        return {
          player: player,
          counts: counts,
          trend: trend,
          weeklyDetail: weeklyDetail,
          metrics: metrics,
          rosterLabel: metrics.roster_status,
          rosterTone: player.free_agent_ind ? "free-agent" : "rostered",
          usageLabel: metrics.games_started > 0 ? "Started" : (metrics.games_benched > 0 ? "Benched" : "No lineup usage"),
          profileLabel: "Elite " + counts.elite + " | Neutral " + counts.neutral + " | Dud " + counts.dud,
          searchBlob: [
            player.player_name,
            player.team,
            player.position,
            player.position_group,
            player.franchise_name,
            player.owner_name,
            metrics.roster_status
          ].join(" ").toLowerCase()
        };
      });
    }

    function rowMatchesFilters(entry) {
      var metrics = entry.metrics;
      var player = entry.player;
      if (state.search && entry.searchBlob.indexOf(state.search.toLowerCase()) === -1) return false;
      if (state.position && player.position_group !== state.position) return false;
      if (state.team && player.team !== state.team) return false;
      if (state.rosterStatus === "rostered" && !player.rostered_ind) return false;
      if (state.rosterStatus === "free-agent" && !player.free_agent_ind) return false;
      if (state.currentStatus && player.current_roster_status !== state.currentStatus) return false;
      if (state.usage === "started" && metrics.games_started <= 0) return false;
      if (state.usage === "benched" && metrics.games_benched <= 0) return false;
      if (state.minGames > 0 && metrics.games_played < state.minGames) return false;
      if (state.minStarts > 0 && metrics.games_started < state.minStarts) return false;
      if (state.minPpg > 0 && metrics.points_per_game < state.minPpg) return false;
      return true;
    }

    function sortRows(rows) {
      rows.sort(function (left, right) {
        var key = state.sortKey;
        var a = left.metrics[key];
        var b = right.metrics[key];
        if (key === "player_name" || key === "position_group" || key === "team" || key === "roster_status") {
          a = common.safeStr(a).toLowerCase();
          b = common.safeStr(b).toLowerCase();
        } else {
          a = common.safeNum(a, 0);
          b = common.safeNum(b, 0);
        }
        if (a < b) return state.sortDir === "asc" ? -1 : 1;
        if (a > b) return state.sortDir === "asc" ? 1 : -1;
        return common.safeStr(left.player.player_name).localeCompare(common.safeStr(right.player.player_name));
      });
      return rows;
    }

    function buildCsvRows(rows) {
      return rows.map(function (entry) {
        return {
          Player: entry.player.player_name,
          Position: getPositionLabel(entry.player),
          Team: entry.player.team,
          "Roster Status": entry.rosterLabel,
          Games: entry.metrics.games_played,
          Starts: entry.metrics.games_started,
          Benched: entry.metrics.games_benched,
          "Total Points": entry.metrics.total_points,
          "Points Per Game": entry.metrics.points_per_game,
          Median: entry.metrics.median_points,
          Max: entry.metrics.max_points,
          Min: entry.metrics.min_points,
          "Std Dev": entry.metrics.standard_deviation,
          "Elite Weeks": entry.metrics.elite_weeks,
          "Neutral Weeks": entry.metrics.neutral_weeks,
          "Dud Weeks": entry.metrics.dud_weeks,
          "Elite Week Rate": entry.metrics.elite_week_rate,
          "Dud Week Rate": entry.metrics.dud_week_rate,
          "Positional Rank": entry.metrics.positional_rank,
          "Percentile Rank": entry.metrics.percentile_rank,
          VAM: entry.metrics.vam,
          "Consistency Index": entry.metrics.consistency_index,
          "Last 3 Avg": entry.metrics.last_3_avg,
          "Last 5 Avg": entry.metrics.last_5_avg,
          "Trend Direction": entry.metrics.recent_trend_direction,
          "Trend Delta": entry.metrics.recent_trend_delta,
          "Best Streak": entry.metrics.best_streak,
          "Dud Streak": entry.metrics.dud_streak,
          "Rolling Volatility": entry.metrics.rolling_volatility
        };
      });
    }

    function activeFilterChips() {
      var chips = [];
      var defaults = defaultThresholds();
      if (state.search) chips.push({ key: "search", label: 'Search: "' + state.search + '"' });
      if (state.position) chips.push({ key: "position", label: "Position: " + state.position });
      if (state.team) chips.push({ key: "team", label: "NFL Team: " + state.team });
      if (state.rosterStatus === "rostered") chips.push({ key: "rosterStatus", label: "Roster Status: Rostered" });
      if (state.rosterStatus === "free-agent") chips.push({ key: "rosterStatus", label: "Roster Status: Free Agent" });
      if (state.currentStatus) chips.push({ key: "currentStatus", label: "Snapshot Status: " + formatCurrentStatus(state.currentStatus) });
      if (state.usage === "started") chips.push({ key: "usage", label: "Usage: Started" });
      if (state.usage === "benched") chips.push({ key: "usage", label: "Usage: Benched" });
      if (state.minGames > 0) chips.push({ key: "minGames", label: "Min Games: " + state.minGames });
      if (state.minStarts > 0) chips.push({ key: "minStarts", label: "Min Starts: " + state.minStarts });
      if (state.minPpg > 0) chips.push({ key: "minPpg", label: "Min PPG: " + common.formatNumber(state.minPpg, 2) });
      if (state.eliteThreshold !== defaults.elite || state.dudThreshold !== defaults.dud) {
        chips.push({ key: "thresholds", label: "Thresholds: " + state.eliteThreshold + " / " + state.dudThreshold });
      }
      return chips;
    }

    function renderChips(chips) {
      if (!chips.length) {
        return '<p class="reports-helper-text psr-chip-helper">No active filters beyond the selected season.</p>';
      }
      return (
        '<div class="psr-chip-row">' +
          chips.map(function (chip) {
            return (
              '<button type="button" class="psr-filter-chip" data-psr-chip="' + common.escapeHtml(chip.key) + '">' +
                '<span>' + common.escapeHtml(chip.label) + "</span>" +
                '<span class="psr-filter-chip-x" aria-hidden="true">x</span>' +
              "</button>"
            );
          }).join("") +
        "</div>"
      );
    }

    function renderSparklineSvg(trend, variant) {
      var scores = trend && trend.scores ? trend.scores : [];
      if (!scores.length) {
        return '<div class="psr-sparkline-empty">No weekly data</div>';
      }

      var width = variant === "card" ? 196 : 132;
      var height = variant === "card" ? 42 : 30;
      var padding = variant === "card" ? 4 : 3;
      var minScore = Math.min.apply(null, scores);
      var maxScore = Math.max.apply(null, scores);
      if (minScore === maxScore) {
        minScore -= 1;
        maxScore += 1;
      }
      var xStep = scores.length > 1 ? (width - (padding * 2)) / (scores.length - 1) : 0;
      var yScale = (height - (padding * 2)) / (maxScore - minScore);
      var points = scores.map(function (score, index) {
        var x = padding + (xStep * index);
        var y = height - padding - ((score - minScore) * yScale);
        return {
          x: roundMetric(x, 2),
          y: roundMetric(y, 2)
        };
      });
      var polylinePoints = points.map(function (point) {
        return point.x + "," + point.y;
      }).join(" ");
      var firstPoint = points[0];
      var lastPoint = points[points.length - 1];
      var toneClass = trendToneClass(trend.recent_trend_direction);
      return (
        '<svg class="psr-sparkline ' + toneClass + '" viewBox="0 0 ' + width + " " + height + '" role="img" aria-label="' + common.escapeHtml("Weekly scoring trend") + '">' +
          '<polyline class="psr-sparkline-baseline" points="' + padding + "," + (height - padding) + " " + (width - padding) + "," + (height - padding) + '"></polyline>' +
          '<polyline class="psr-sparkline-line" points="' + polylinePoints + '"></polyline>' +
          '<circle class="psr-sparkline-start" cx="' + firstPoint.x + '" cy="' + firstPoint.y + '" r="1.8"></circle>' +
          '<circle class="psr-sparkline-end" cx="' + lastPoint.x + '" cy="' + lastPoint.y + '" r="2.5"></circle>' +
        "</svg>"
      );
    }

    function renderTrendPanel(entry, variant) {
      var trend = entry.trend || emptyTrendMetrics();
      var directionLabel = formatTrendDirection(trend.recent_trend_direction);
      var toneClass = trendToneClass(trend.recent_trend_direction);
      var detailTitle = [
        "Last 3 avg " + common.formatNumber(trend.last_3_avg, 1),
        "Last 5 avg " + common.formatNumber(trend.last_5_avg, 1),
        "Trend delta " + common.formatSigned(trend.recent_trend_delta, 1),
        "Best elite streak " + common.formatNumber(trend.best_streak, 0),
        "Dud streak " + common.formatNumber(trend.dud_streak, 0),
        "Rolling volatility " + common.formatNumber(trend.rolling_volatility, 1)
      ].join(" | ");

      if (variant === "card") {
        return (
          '<section class="psr-card-trend" title="' + common.escapeHtml(detailTitle) + '">' +
            '<div class="psr-card-trend-head">' +
              '<span class="psr-card-metric-label">Recent Trend</span>' +
              '<span class="psr-trend-pill ' + toneClass + '">' + common.escapeHtml(directionLabel) + "</span>" +
            "</div>" +
            renderSparklineSvg(trend, "card") +
            '<div class="psr-card-trend-grid">' +
              '<div class="psr-card-trend-stat"><span>L3 Avg</span><strong>' + common.escapeHtml(common.formatNumber(trend.last_3_avg, 1)) + "</strong></div>" +
              '<div class="psr-card-trend-stat"><span>L5 Avg</span><strong>' + common.escapeHtml(common.formatNumber(trend.last_5_avg, 1)) + "</strong></div>" +
              '<div class="psr-card-trend-stat"><span>Elite Streak</span><strong>' + common.escapeHtml(common.formatNumber(trend.best_streak, 0)) + "</strong></div>" +
              '<div class="psr-card-trend-stat"><span>Volatility</span><strong>' + common.escapeHtml(common.formatNumber(trend.rolling_volatility, 1)) + "</strong></div>" +
            "</div>" +
          "</section>"
        );
      }

      return (
        '<div class="psr-trend-block" title="' + common.escapeHtml(detailTitle) + '">' +
          '<div class="psr-trend-head">' +
            renderSparklineSvg(trend, "table") +
            '<span class="psr-trend-pill ' + toneClass + '">' + common.escapeHtml(directionLabel) + "</span>" +
          "</div>" +
          '<div class="psr-trend-metrics">' +
            '<span>L3 ' + common.escapeHtml(common.formatNumber(trend.last_3_avg, 1)) + "</span>" +
            '<span>L5 ' + common.escapeHtml(common.formatNumber(trend.last_5_avg, 1)) + "</span>" +
            '<span>Vol ' + common.escapeHtml(common.formatNumber(trend.rolling_volatility, 1)) + "</span>" +
          "</div>" +
        "</div>"
      );
    }

    function renderDetailSummary(entry, variant) {
      var summaryItems = [
        { label: "Last 3 Avg", value: common.formatNumber(entry.metrics.last_3_avg, 1) },
        { label: "Last 5 Avg", value: common.formatNumber(entry.metrics.last_5_avg, 1) },
        { label: "Best Elite Streak", value: common.formatNumber(entry.metrics.best_streak, 0) },
        { label: "Dud Streak", value: common.formatNumber(entry.metrics.dud_streak, 0) },
        { label: "Rolling Volatility", value: common.formatNumber(entry.metrics.rolling_volatility, 1) }
      ];
      return (
        '<div class="psr-detail-summary-grid ' + (variant === "card" ? "is-card" : "is-table") + '">' +
          summaryItems.map(function (item) {
            return (
              '<article class="psr-detail-stat">' +
                '<span class="psr-detail-stat-label">' + common.escapeHtml(item.label) + "</span>" +
                '<strong>' + common.escapeHtml(item.value) + "</strong>" +
              "</article>"
            );
          }).join("") +
        "</div>"
      );
    }

    function renderClassificationBadge(classification) {
      return '<span class="psr-week-badge ' + classificationToneClass(classification) + '">' + common.escapeHtml(classificationLabel(classification)) + "</span>";
    }

    function renderDesktopWeeklyDetail(entry) {
      var detailRows = entry.weeklyDetail || [];
      if (!detailRows.length) {
        return '<p class="reports-helper-text">No weekly detail available for this player in the selected season.</p>';
      }
      return (
        '<div class="psr-detail-table-wrap">' +
          '<table class="psr-detail-table">' +
            '<thead><tr><th>Week</th><th>Score</th><th>VAM</th><th>Pos %</th><th>Class</th><th>Usage</th><th>Streak</th></tr></thead>' +
            '<tbody>' +
              detailRows.map(function (item) {
                var vamClass = common.safeNum(item.weekly_vam, 0) >= 0 ? "psr-positive" : "psr-negative";
                return (
                  '<tr class="' + (item.is_recent_week ? "is-recent-week" : "") + '">' +
                    '<td><span class="psr-week-label">Week ' + common.escapeHtml(common.formatNumber(item.week, 0)) + "</span></td>" +
                    '<td class="psr-num-cell">' + common.escapeHtml(common.formatNumber(item.score, 1)) + "</td>" +
                    '<td class="psr-num-cell ' + vamClass + '">' + common.escapeHtml(common.formatSigned(item.weekly_vam, 1)) + "</td>" +
                    '<td class="psr-num-cell">' + common.escapeHtml(common.formatPercent(item.weekly_position_percentile, 1)) + "</td>" +
                    '<td>' + renderClassificationBadge(item.weekly_classification) + "</td>" +
                    '<td><span class="psr-week-usage">' + common.escapeHtml(item.usage_status) + "</span></td>" +
                    '<td>' + (item.streak_marker ? '<span class="psr-streak-chip ' + classificationToneClass(item.weekly_classification) + '">' + common.escapeHtml(item.streak_marker) + "</span>" : '<span class="psr-week-muted">-</span>') + "</td>" +
                  "</tr>"
                );
              }).join("") +
            "</tbody>" +
          "</table>" +
        "</div>"
      );
    }

    function renderDesktopDetailRow(entry) {
      var detailId = detailDomId("psr-row-detail", entry.player.player_id);
      return (
        '<tr class="psr-detail-row">' +
          '<td colspan="' + TABLE_COLUMNS.length + '">' +
            '<section id="' + common.escapeHtml(detailId) + '" class="psr-detail-panel">' +
              '<div class="psr-detail-panel-head">' +
                '<div>' +
                  '<p class="reports-section-kicker">Weekly Detail</p>' +
                  '<h4>Threshold-aware weekly breakdown</h4>' +
                "</div>" +
                '<p class="reports-helper-text">Elite ' + common.escapeHtml(common.formatNumber(state.eliteThreshold, 0)) + " / Dud " + common.escapeHtml(common.formatNumber(state.dudThreshold, 0)) + "</p>" +
              "</div>" +
              renderDetailSummary(entry, "table") +
              renderDesktopWeeklyDetail(entry) +
            "</section>" +
          "</td>" +
        "</tr>"
      );
    }

    function renderMobileWeeklyDetail(entry) {
      var detailRows = entry.weeklyDetail || [];
      if (!detailRows.length) {
        return '<p class="reports-helper-text">No weekly detail available for this player in the selected season.</p>';
      }
      return (
        '<div class="psr-card-week-list">' +
          detailRows.map(function (item) {
            var vamClass = common.safeNum(item.weekly_vam, 0) >= 0 ? "psr-positive" : "psr-negative";
            return (
              '<article class="psr-card-week-item ' + (item.is_recent_week ? "is-recent-week" : "") + '">' +
                '<div class="psr-card-week-head">' +
                  '<strong>Week ' + common.escapeHtml(common.formatNumber(item.week, 0)) + "</strong>" +
                  renderClassificationBadge(item.weekly_classification) +
                "</div>" +
                '<div class="psr-card-week-metrics">' +
                  '<span>Score <strong>' + common.escapeHtml(common.formatNumber(item.score, 1)) + "</strong></span>" +
                  '<span>VAM <strong class="' + vamClass + '">' + common.escapeHtml(common.formatSigned(item.weekly_vam, 1)) + "</strong></span>" +
                  '<span>Pos % <strong>' + common.escapeHtml(common.formatPercent(item.weekly_position_percentile, 1)) + "</strong></span>" +
                "</div>" +
                '<div class="psr-card-week-foot">' +
                  '<span class="psr-week-usage">' + common.escapeHtml(item.usage_status) + "</span>" +
                  (item.streak_marker ? '<span class="psr-streak-chip ' + classificationToneClass(item.weekly_classification) + '">' + common.escapeHtml(item.streak_marker) + "</span>" : "") +
                "</div>" +
              "</article>"
            );
          }).join("") +
        "</div>"
      );
    }

    function renderMobileDetail(entry) {
      if (state.expandedPlayerId !== entry.player.player_id) return "";
      var detailId = detailDomId("psr-card-detail", entry.player.player_id);
      return (
        '<section id="' + common.escapeHtml(detailId) + '" class="psr-card-detail">' +
          '<div class="psr-detail-panel-head">' +
            '<div>' +
              '<p class="reports-section-kicker">Weekly Detail</p>' +
              '<h4>Weekly breakdown</h4>' +
            "</div>" +
            '<p class="reports-helper-text">Elite ' + common.escapeHtml(common.formatNumber(state.eliteThreshold, 0)) + " / Dud " + common.escapeHtml(common.formatNumber(state.dudThreshold, 0)) + "</p>" +
          "</div>" +
          renderDetailSummary(entry, "card") +
          renderMobileWeeklyDetail(entry) +
        "</section>"
      );
    }

    function renderCompareToggle(entry, variant) {
      var isSelected = isCompareSelected(entry.player.player_id);
      var isDisabled = !isSelected && state.comparePlayerIds.length >= MAX_COMPARE_PLAYERS;
      var classes = "reports-btn-ghost psr-compare-toggle";
      if (variant === "card") classes += " psr-compare-toggle-card";
      if (isSelected) classes += " is-selected";
      return (
        '<button type="button" class="' + classes + '" data-psr-compare-toggle="' + common.escapeHtml(entry.player.player_id) + '"' +
          ' aria-pressed="' + (isSelected ? "true" : "false") + '"' +
          (isDisabled ? " disabled" : "") +
          '>' + common.escapeHtml(compareButtonLabel(isSelected)) + "</button>"
      );
    }

    function renderCompareTray(compareRows) {
      if (!compareRows.length) return "";
      var compareReady = compareRows.length >= MIN_COMPARE_PLAYERS;
      var statusCopy = compareReady
        ? common.formatNumber(compareRows.length, 0) + " players in active comparison mode."
        : "Select at least 2 players to compare side-by-side.";
      var helperCopy = state.compareMessage
        ? state.compareMessage
        : (compareReady
          ? "Filters, sorting, and pagination remain live while the comparison tray stays pinned."
          : "Add up to 4 players from the report. Selected players stay pinned here even if you change filters.");
      return (
        '<section class="reports-panel psr-compare-panel">' +
          '<div class="psr-compare-head">' +
            '<div>' +
              '<p class="reports-section-kicker">Phase 4 Compare Mode</p>' +
              '<h3 class="psr-panel-title">Player comparison tray</h3>' +
              '<p class="reports-helper-text">' + common.escapeHtml(statusCopy) + "</p>" +
            "</div>" +
            '<div class="psr-inline-actions">' +
              '<span class="psr-compare-count">' + common.formatNumber(compareRows.length, 0) + " / " + common.formatNumber(MAX_COMPARE_PLAYERS, 0) + " selected</span>" +
              '<button type="button" class="reports-btn-ghost" data-psr-compare-clear>Clear compare</button>' +
            "</div>" +
          "</div>" +
          '<p class="reports-helper-text psr-compare-helper">' + common.escapeHtml(helperCopy) + "</p>" +
          '<div class="psr-compare-grid">' +
            compareRows.map(function (entry) {
              var metricsHtml = COMPARE_METRICS.map(function (metric) {
                var toneClass = metric.key === "vam"
                  ? (common.safeNum(entry.metrics.vam, 0) >= 0 ? "psr-positive" : "psr-negative")
                  : "";
                return (
                  '<div class="psr-compare-metric">' +
                    '<span class="psr-compare-metric-label">' + common.escapeHtml(metric.label) + "</span>" +
                    '<strong class="' + toneClass + '">' + common.escapeHtml(formatColumnValue(entry.metrics[metric.key], metric)) + "</strong>" +
                  "</div>"
                );
              }).join("");
              return (
                '<article class="psr-compare-card">' +
                  '<div class="psr-compare-card-head">' +
                    '<div class="psr-compare-card-copy">' +
                      '<h4>' + common.escapeHtml(entry.player.player_name) + "</h4>" +
                      '<p class="psr-player-card-subhead">' + common.escapeHtml(getPositionLabel(entry.player)) + " | " + common.escapeHtml(entry.player.team || "-") + "</p>" +
                    "</div>" +
                    '<span class="psr-roster-pill is-' + entry.rosterTone + '">' + common.escapeHtml(entry.rosterLabel) + "</span>" +
                  "</div>" +
                  '<div class="psr-compare-card-actions">' +
                    '<span class="psr-inline-chip">' + common.escapeHtml(entry.profileLabel) + "</span>" +
                    renderCompareToggle(entry, "compare") +
                  "</div>" +
                  '<div class="psr-compare-trend">' +
                    '<div class="psr-card-trend-head">' +
                      '<span class="psr-card-metric-label">Trend</span>' +
                      '<span class="psr-trend-pill ' + trendToneClass(entry.metrics.recent_trend_direction) + '">' + common.escapeHtml(formatTrendDirection(entry.metrics.recent_trend_direction)) + "</span>" +
                    "</div>" +
                    renderSparklineSvg(entry.trend || emptyTrendMetrics(), "card") +
                  "</div>" +
                  '<div class="psr-compare-metrics-grid">' + metricsHtml + "</div>" +
                "</article>"
              );
            }).join("") +
          "</div>" +
        "</section>"
      );
    }

    function renderTable(rows) {
      var headers = TABLE_COLUMNS.map(function (column) {
        var thClass = column.align === "left" ? "psr-text-col" : "psr-num-col";
        return (
          '<th class="' + thClass + '">' +
            '<button type="button" class="psr-sort-btn" data-psr-sort="' + common.escapeHtml(columnSortKey(column)) + '">' +
              common.escapeHtml(getSortLabel(column)) +
            "</button>" +
          "</th>"
        );
      }).join("");

      var body = rows.map(function (entry) {
        var rowClass = entry.rosterTone === "free-agent" ? "is-free-agent" : "is-rostered";
        var detailToggleId = detailDomId("psr-row-detail", entry.player.player_id);
        var isExpanded = state.expandedPlayerId === entry.player.player_id;
        var isCompared = isCompareSelected(entry.player.player_id);
        var cells = TABLE_COLUMNS.map(function (column) {
          if (column.key === "player_name") {
            return (
              '<td class="psr-col-player psr-text-cell">' +
                '<div class="psr-player-cell">' +
                  '<strong>' + common.escapeHtml(entry.player.player_name) + "</strong>" +
                  '<span class="psr-player-meta">' + common.escapeHtml(entry.player.owner_name || entry.player.last_transaction_franchise_name || "No recent franchise move") + "</span>" +
                  '<span class="psr-profile-meta">' + common.escapeHtml(entry.profileLabel) + "</span>" +
                  '<div class="psr-player-actions">' +
                    renderCompareToggle(entry, "table") +
                    '<button type="button" class="reports-btn-ghost psr-detail-toggle" data-psr-detail-toggle="' + common.escapeHtml(entry.player.player_id) + '" aria-expanded="' + (isExpanded ? "true" : "false") + '" aria-controls="' + common.escapeHtml(detailToggleId) + '">' + (isExpanded ? "Hide Weekly Detail" : "Weekly Detail") + "</button>" +
                  "</div>" +
                "</div>" +
              "</td>"
            );
          }
          if (column.key === "roster_status") {
            return (
              '<td class="psr-text-cell">' +
                '<span class="psr-roster-pill is-' + entry.rosterTone + '">' + common.escapeHtml(entry.rosterLabel) + "</span>" +
              "</td>"
            );
          }
          if (column.type === "trend") {
            return (
              '<td class="psr-text-cell psr-col-trend">' +
                renderTrendPanel(entry, "table") +
              "</td>"
            );
          }
          var value = entry.metrics[column.key];
          var className = column.align === "left" ? "psr-text-cell" : "psr-num-cell";
          if (column.key === "vam") {
            className += " " + (common.safeNum(value, 0) >= 0 ? "psr-positive" : "psr-negative");
          }
          return '<td class="' + className + '">' + common.escapeHtml(formatColumnValue(value, column)) + "</td>";
        }).join("");
        return '<tr class="' + rowClass + (isExpanded ? " is-expanded" : "") + (isCompared ? " is-compare-selected" : "") + '">' + cells + "</tr>" + (isExpanded ? renderDesktopDetailRow(entry) : "");
      }).join("");

      return (
        '<div class="psr-table-wrap">' +
          '<table class="psr-table">' +
            "<thead><tr>" + headers + "</tr></thead>" +
            "<tbody>" + body + "</tbody>" +
          "</table>" +
        "</div>"
      );
    }

    function renderMobileCards(rows) {
      if (!rows.length) {
        return (
          '<section class="psr-mobile-list">' +
            '<article class="reports-panel psr-empty-panel">' +
              '<h4>No players matched the current filter set</h4>' +
              '<p class="reports-helper-text">Broaden the thresholds, lower the minimums, or reset filters to reopen the player pool.</p>' +
            "</article>" +
          "</section>"
        );
      }
      return (
        '<section class="psr-mobile-list">' +
          rows.map(function (entry) {
            var isCompared = isCompareSelected(entry.player.player_id);
            var metricHtml = MOBILE_METRICS.map(function (metric) {
              var toneClass = metric.key === "vam"
                ? (common.safeNum(entry.metrics.vam, 0) >= 0 ? "psr-positive" : "psr-negative")
                : "";
              return (
                '<div class="psr-card-metric">' +
                  '<span class="psr-card-metric-label">' + common.escapeHtml(metric.label) + "</span>" +
                  '<strong class="' + toneClass + '">' + common.escapeHtml(formatColumnValue(entry.metrics[metric.key], metric)) + "</strong>" +
                "</div>"
              );
            }).join("");
            return (
              '<article class="reports-panel psr-player-card is-' + entry.rosterTone + (isCompared ? " is-compare-selected" : "") + '">' +
                '<header class="psr-player-card-head">' +
                  '<div class="psr-player-card-copy">' +
                    '<h4>' + common.escapeHtml(entry.player.player_name) + "</h4>" +
                    '<p class="psr-player-card-subhead">' + common.escapeHtml(getPositionLabel(entry.player)) + " | " + common.escapeHtml(entry.player.team || "-") + "</p>" +
                  "</div>" +
                  '<span class="psr-roster-pill is-' + entry.rosterTone + '">' + common.escapeHtml(entry.rosterLabel) + "</span>" +
                "</header>" +
                '<div class="psr-player-card-chips">' +
                  '<span class="psr-inline-chip">' + common.escapeHtml(entry.usageLabel) + "</span>" +
                  '<span class="psr-inline-chip">' + common.escapeHtml(entry.profileLabel) + "</span>" +
                "</div>" +
                renderTrendPanel(entry, "card") +
                '<div class="psr-card-actions">' +
                  renderCompareToggle(entry, "card") +
                  '<button type="button" class="reports-btn-ghost psr-detail-toggle psr-detail-toggle-card" data-psr-detail-toggle="' + common.escapeHtml(entry.player.player_id) + '" aria-expanded="' + (state.expandedPlayerId === entry.player.player_id ? "true" : "false") + '" aria-controls="' + common.escapeHtml(detailDomId("psr-card-detail", entry.player.player_id)) + '">' + (state.expandedPlayerId === entry.player.player_id ? "Hide Weekly Detail" : "Weekly Detail") + "</button>" +
                "</div>" +
                renderMobileDetail(entry) +
                '<div class="psr-card-grid">' + metricHtml + "</div>" +
              "</article>"
            );
          }).join("") +
        "</section>"
      );
    }

    function renderLoading() {
      ctx.root.innerHTML =
        '<section class="reports-panel psr-loading-card">' +
          '<p class="reports-section-kicker">Player Research</p>' +
          '<h3>Loading player scoring data</h3>' +
          '<p class="reports-helper-text">Pulling the manifest and season export for the report.</p>' +
        '</section>';
    }

    function renderError() {
      ctx.root.innerHTML =
        '<section class="reports-panel psr-loading-card">' +
          '<p class="reports-section-kicker">Player Research</p>' +
          '<h3>Player scoring report failed to load</h3>' +
          '<p class="reports-helper-text">' + common.escapeHtml(state.error || "Unknown error.") + '</p>' +
          '<div class="psr-inline-actions">' +
            '<button type="button" class="reports-btn" data-psr-retry>Retry</button>' +
          '</div>' +
        '</section>';
      var retry = ctx.root.querySelector("[data-psr-retry]");
      if (retry) retry.addEventListener("click", initialize);
    }

    function bindHandlers(allRows, totalPages) {
      function bind(selector, eventName, handler) {
        var element = ctx.root.querySelector(selector);
        if (element) element.addEventListener(eventName, handler);
      }

      bind("[data-psr-season]", "change", function (event) {
        state.season = event.target.value;
        state.comparePlayerIds = [];
        state.compareMessage = "";
        state.expandedPlayerId = "";
        state.page = 1;
        fetchSeason();
      });
      bind("[data-psr-search]", "input", function (event) {
        state.search = event.target.value;
        state.page = 1;
        renderView();
      });
      bind("[data-psr-position]", "change", function (event) {
        state.position = event.target.value;
        state.page = 1;
        renderView();
      });
      bind("[data-psr-team]", "change", function (event) {
        state.team = event.target.value;
        state.page = 1;
        renderView();
      });
      bind("[data-psr-roster-status]", "change", function (event) {
        state.rosterStatus = event.target.value;
        state.page = 1;
        renderView();
      });
      bind("[data-psr-current-status]", "change", function (event) {
        state.currentStatus = event.target.value;
        state.page = 1;
        renderView();
      });
      bind("[data-psr-usage]", "change", function (event) {
        state.usage = event.target.value;
        state.page = 1;
        renderView();
      });
      bind("[data-psr-min-games]", "change", function (event) {
        state.minGames = Math.max(0, common.safeInt(event.target.value, 0));
        state.page = 1;
        renderView();
      });
      bind("[data-psr-min-starts]", "change", function (event) {
        state.minStarts = Math.max(0, common.safeInt(event.target.value, 0));
        state.page = 1;
        renderView();
      });
      bind("[data-psr-min-ppg]", "change", function (event) {
        state.minPpg = Math.max(0, common.safeNum(event.target.value, 0));
        state.page = 1;
        renderView();
      });
      bind("[data-psr-elite]", "change", function (event) {
        state.eliteThreshold = common.safeInt(event.target.value, state.eliteThreshold);
        applyThresholdGuard("elite");
        state.page = 1;
        renderView();
      });
      bind("[data-psr-dud]", "change", function (event) {
        state.dudThreshold = common.safeInt(event.target.value, state.dudThreshold);
        applyThresholdGuard("dud");
        state.page = 1;
        renderView();
      });
      bind("[data-psr-page-size]", "change", function (event) {
        state.pageSize = common.safeInt(event.target.value, state.pageSize);
        state.page = 1;
        renderView();
      });
      bind("[data-psr-clear]", "click", function () {
        resetFilters();
        state.compareMessage = "";
        renderView();
      });
      bind("[data-psr-export]", "click", function () {
        common.downloadCsv("ups_player_scoring_" + state.season + ".csv", buildCsvRows(allRows));
      });
      bind("[data-psr-compare-clear]", "click", function () {
        state.comparePlayerIds = [];
        state.compareMessage = "";
        renderView();
      });

      Array.prototype.forEach.call(ctx.root.querySelectorAll("[data-psr-sort]"), function (button) {
        button.addEventListener("click", function () {
          var key = button.getAttribute("data-psr-sort");
          if (state.sortKey === key) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
          else {
            state.sortKey = key;
            state.sortDir = (key === "player_name" || key === "position_group" || key === "team" || key === "roster_status") ? "asc" : "desc";
          }
          renderView();
        });
      });

      Array.prototype.forEach.call(ctx.root.querySelectorAll("[data-psr-page]"), function (button) {
        button.addEventListener("click", function () {
          var direction = button.getAttribute("data-psr-page");
          if (direction === "prev" && state.page > 1) state.page -= 1;
          if (direction === "next" && state.page < totalPages) state.page += 1;
          renderView();
        });
      });

      Array.prototype.forEach.call(ctx.root.querySelectorAll("[data-psr-chip]"), function (button) {
        button.addEventListener("click", function () {
          var key = button.getAttribute("data-psr-chip");
          if (key === "search") state.search = "";
          else if (key === "position") state.position = "";
          else if (key === "team") state.team = "";
          else if (key === "rosterStatus") state.rosterStatus = "";
          else if (key === "currentStatus") state.currentStatus = "";
          else if (key === "usage") state.usage = "";
          else if (key === "minGames") state.minGames = 0;
          else if (key === "minStarts") state.minStarts = 0;
          else if (key === "minPpg") state.minPpg = 0;
          else if (key === "thresholds") {
            var defaults = defaultThresholds();
            state.eliteThreshold = defaults.elite;
            state.dudThreshold = defaults.dud;
            applyThresholdGuard("");
          }
          state.page = 1;
          renderView();
        });
      });

      Array.prototype.forEach.call(ctx.root.querySelectorAll("[data-psr-detail-toggle]"), function (button) {
        button.addEventListener("click", function () {
          var playerId = button.getAttribute("data-psr-detail-toggle") || "";
          state.expandedPlayerId = state.expandedPlayerId === playerId ? "" : playerId;
          renderView();
        });
      });

      Array.prototype.forEach.call(ctx.root.querySelectorAll("[data-psr-compare-toggle]"), function (button) {
        button.addEventListener("click", function () {
          var playerId = button.getAttribute("data-psr-compare-toggle") || "";
          toggleComparePlayer(playerId);
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
      var manifest = state.manifest || { meta: {}, seasons: [] };
      var seasonData = state.seasonData;
      if (!seasonData) {
        state.loading = true;
        renderLoading();
        return;
      }

      var allRows = buildBaseRows();
      syncCompareSelections(allRows);
      var rows = sortRows(allRows.filter(rowMatchesFilters));
      var compareLookup = Object.create(null);
      allRows.forEach(function (entry) {
        compareLookup[String(entry.player.player_id)] = entry;
      });
      var compareRows = state.comparePlayerIds.map(function (playerId) {
        return compareLookup[String(playerId)] || null;
      }).filter(Boolean);
      var totalPlayers = (seasonData.players || []).length;
      var filteredFreeAgents = rows.filter(function (entry) { return entry.player.free_agent_ind; }).length;
      var filteredRostered = rows.filter(function (entry) { return entry.player.rostered_ind; }).length;
      var averagePpg = rows.length
        ? rows.reduce(function (sum, entry) { return sum + common.safeNum(entry.metrics.points_per_game, 0); }, 0) / rows.length
        : 0;
      var averageVam = rows.length
        ? rows.reduce(function (sum, entry) { return sum + common.safeNum(entry.metrics.vam, 0); }, 0) / rows.length
        : 0;
      var totalPages = Math.max(1, Math.ceil(rows.length / state.pageSize));
      state.page = Math.min(Math.max(1, state.page), totalPages);
      var startIndex = (state.page - 1) * state.pageSize;
      var pagedRows = rows.slice(startIndex, startIndex + state.pageSize);
      if (state.expandedPlayerId && !pagedRows.some(function (entry) {
        return entry.player.player_id === state.expandedPlayerId;
      })) {
        state.expandedPlayerId = "";
      }
      var chips = activeFilterChips();
      var seasonOptions = (manifest.seasons || []).map(function (entry) {
        return '<option value="' + common.escapeHtml(entry.season) + '"' + (String(entry.season) === String(state.season) ? " selected" : "") + '>' + entry.season + "</option>";
      }).join("");
      var positionOptions = ['<option value="">All positions</option>']
        .concat(((seasonData.filters || {}).positions || []).map(function (position) {
          return '<option value="' + common.escapeHtml(position) + '"' + (state.position === position ? " selected" : "") + '>' + common.escapeHtml(position) + "</option>";
        }))
        .join("");
      var teamOptions = ['<option value="">All NFL teams</option>']
        .concat(((seasonData.filters || {}).teams || []).map(function (team) {
          return '<option value="' + common.escapeHtml(team) + '"' + (state.team === team ? " selected" : "") + '>' + common.escapeHtml(team) + "</option>";
        }))
        .join("");
      var currentStatusOptions = ['<option value="">All snapshot statuses</option>']
        .concat(((seasonData.filters || {}).current_roster_statuses || []).map(function (status) {
          return '<option value="' + common.escapeHtml(status) + '"' + (state.currentStatus === status ? " selected" : "") + '>' + common.escapeHtml(formatCurrentStatus(status)) + "</option>";
        }))
        .join("");

      ctx.root.innerHTML =
        '<section class="reports-panel psr-summary-panel">' +
          '<div class="psr-summary-copy">' +
            '<p class="reports-section-kicker">Phase 4 Report</p>' +
            '<h3>Player scoring research table</h3>' +
            '<p class="reports-helper-text">Player-first analytics with configurable weekly classification, lightweight trend strips, expandable weekly detail, side-by-side comparison mode, current availability context, and exportable filtered results.</p>' +
          '</div>' +
          '<div class="psr-summary-grid">' +
            '<article class="psr-stat-card"><span class="psr-stat-label">Filtered Pool</span><strong>' + common.formatNumber(rows.length, 0) + '</strong><span class="psr-stat-detail">of ' + common.formatNumber(totalPlayers, 0) + ' players</span></article>' +
            '<article class="psr-stat-card"><span class="psr-stat-label">Free Agents</span><strong>' + common.formatNumber(filteredFreeAgents, 0) + '</strong><span class="psr-stat-detail">current snapshot</span></article>' +
            '<article class="psr-stat-card"><span class="psr-stat-label">Avg PPG</span><strong>' + common.formatNumber(averagePpg, 3) + '</strong><span class="psr-stat-detail">filtered results</span></article>' +
            '<article class="psr-stat-card"><span class="psr-stat-label">Avg VAM</span><strong>' + common.formatSigned(averageVam, 3) + '</strong><span class="psr-stat-detail">' + common.formatNumber(filteredRostered, 0) + ' rostered in view</span></article>' +
          "</div>" +
        "</section>" +

        '<section class="reports-panel psr-toolbar-panel">' +
          '<div class="psr-toolbar-head">' +
            '<div>' +
              '<h3 class="psr-panel-title">Filters</h3>' +
              '<p class="reports-helper-text">Elite and dud weeks are recalculated from stored weekly position percentiles whenever the thresholds change. Trend, weekly detail, and comparison views are derived client-side from the weekly export.</p>' +
            "</div>" +
            '<div class="psr-inline-actions">' +
              '<button type="button" class="reports-btn-ghost" data-psr-clear>Reset filters</button>' +
              '<button type="button" class="reports-btn" data-psr-export>Export filtered CSV</button>' +
            "</div>" +
          "</div>" +
          '<div class="psr-filter-grid">' +
            '<label class="reports-field"><span class="reports-field-label">Season</span><select class="reports-select" data-psr-season>' + seasonOptions + "</select></label>" +
            '<label class="reports-field"><span class="reports-field-label">Search</span><input class="reports-input" type="search" value="' + common.escapeHtml(state.search) + '" placeholder="Player, team, franchise" data-psr-search></label>' +
            '<label class="reports-field"><span class="reports-field-label">Position</span><select class="reports-select" data-psr-position>' + positionOptions + "</select></label>" +
            '<label class="reports-field"><span class="reports-field-label">NFL Team</span><select class="reports-select" data-psr-team>' + teamOptions + "</select></label>" +
            '<label class="reports-field"><span class="reports-field-label">Roster Status</span><select class="reports-select" data-psr-roster-status>' +
              '<option value=""' + (state.rosterStatus === "" ? " selected" : "") + '>All players</option>' +
              '<option value="rostered"' + (state.rosterStatus === "rostered" ? " selected" : "") + '>Rostered</option>' +
              '<option value="free-agent"' + (state.rosterStatus === "free-agent" ? " selected" : "") + '>Free Agent</option>' +
            "</select></label>" +
            '<label class="reports-field"><span class="reports-field-label">Usage Status</span><select class="reports-select" data-psr-usage>' +
              '<option value=""' + (state.usage === "" ? " selected" : "") + '>Any</option>' +
              '<option value="started"' + (state.usage === "started" ? " selected" : "") + '>Started</option>' +
              '<option value="benched"' + (state.usage === "benched" ? " selected" : "") + '>Benched</option>' +
            "</select></label>" +
            '<label class="reports-field"><span class="reports-field-label">Min Games</span><input class="reports-input" type="number" min="0" max="25" step="1" value="' + common.escapeHtml(state.minGames) + '" data-psr-min-games></label>' +
            '<label class="reports-field"><span class="reports-field-label">Min Starts</span><input class="reports-input" type="number" min="0" max="25" step="1" value="' + common.escapeHtml(state.minStarts) + '" data-psr-min-starts></label>' +
            '<label class="reports-field"><span class="reports-field-label">Min PPG</span><input class="reports-input" type="number" min="0" max="99" step="0.1" value="' + common.escapeHtml(state.minPpg) + '" data-psr-min-ppg></label>' +
            '<label class="reports-field"><span class="reports-field-label">Snapshot Status</span><select class="reports-select" data-psr-current-status>' + currentStatusOptions + "</select></label>" +
            '<label class="reports-field"><span class="reports-field-label">Elite Threshold</span><input class="reports-input" type="number" min="50" max="99" step="1" value="' + common.escapeHtml(state.eliteThreshold) + '" data-psr-elite></label>' +
            '<label class="reports-field"><span class="reports-field-label">Dud Threshold</span><input class="reports-input" type="number" min="1" max="49" step="1" value="' + common.escapeHtml(state.dudThreshold) + '" data-psr-dud></label>' +
          "</div>" +
          '<div class="psr-chip-wrap">' + renderChips(chips) + "</div>" +
          '<div class="psr-toolbar-foot">' +
            '<p class="reports-helper-text">Snapshot: current rosters from season ' + common.formatNumber(seasonData.meta.current_roster_season, 0) + ", week " + common.formatNumber(seasonData.meta.current_roster_week, 0) + ".</p>" +
            '<p class="reports-helper-text"><a href="./player_scoring/player_scoring_data_dictionary.md" target="_blank" rel="noreferrer">Data dictionary</a> and <a href="./player_scoring/player_scoring_sql.sql" target="_blank" rel="noreferrer">SQL definitions</a>.</p>' +
          "</div>" +
        "</section>" +

        renderCompareTray(compareRows) +

        '<section class="reports-panel psr-table-panel">' +
          '<div class="psr-table-head">' +
            '<div><h3 class="psr-panel-title">Results</h3><p class="reports-helper-text">' +
              common.formatNumber(rows.length, 0) + " matching players, page " + common.formatNumber(state.page, 0) + " of " + common.formatNumber(totalPages, 0) + ". Select up to " + common.formatNumber(MAX_COMPARE_PLAYERS, 0) + " players to compare." +
            '</p></div>' +
            '<label class="reports-field psr-page-size"><span class="reports-field-label">Rows per page</span><select class="reports-select" data-psr-page-size>' +
              [25, 50, 100, 250].map(function (size) { return '<option value="' + size + '"' + (state.pageSize === size ? " selected" : "") + ">" + size + "</option>"; }).join("") +
            "</select></label>" +
          "</div>" +
          (pagedRows.length ? renderTable(pagedRows) : '<article class="reports-panel psr-empty-panel"><h4>No players matched the current filter set</h4><p class="reports-helper-text">Try lowering the minimums, broadening roster status, or resetting the thresholds.</p></article>') +
          (pagedRows.length ? renderMobileCards(pagedRows) : "") +
          '<div class="psr-pagination">' +
            '<button type="button" class="reports-btn-ghost" data-psr-page="prev"' + (state.page <= 1 ? " disabled" : "") + '>Previous</button>' +
            '<div class="psr-pagination-status">Showing ' + common.formatNumber(rows.length ? (startIndex + 1) : 0, 0) + " to " + common.formatNumber(Math.min(startIndex + state.pageSize, rows.length), 0) + " of " + common.formatNumber(rows.length, 0) + "</div>" +
            '<button type="button" class="reports-btn-ghost" data-psr-page="next"' + (state.page >= totalPages ? " disabled" : "") + '>Next</button>' +
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
          state.comparePlayerIds = [];
          state.compareMessage = "";
          resetFilters();
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
    id: "player-scoring",
    title: "Player Scoring",
    familyId: "players",
    familyTitle: "Player Reports",
    familyOrder: 1,
    kicker: "Player Research",
    description: "Player-first scoring analytics with configurable weekly classifications, usage filters, positional value, lightweight trend strips, expandable weekly detail, comparison mode, and exportable results.",
    status: "live",
    styles: ["./player_scoring/player_scoring.css"],
    render: renderPlayerScoring
  });
})();
