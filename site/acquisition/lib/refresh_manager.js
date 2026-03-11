(function () {
  "use strict";

  function safeInt(value, fallback) {
    var n = parseInt(String(value == null ? "" : value), 10);
    return isFinite(n) ? n : (fallback == null ? 0 : fallback);
  }

  function createRefreshManager(options) {
    var cfg = options && typeof options === "object" ? options : {};
    var entries = {};
    var activeKey = "";
    var destroyed = false;

    function emit(key) {
      if (destroyed) return;
      if (typeof cfg.onStateChange === "function") {
        try {
          cfg.onStateChange(key, api.getState(key));
        } catch (e) {}
      }
    }

    function clearTimer(key) {
      var entry = entries[key];
      if (!entry || !entry.timerId) return;
      window.clearTimeout(entry.timerId);
      entry.timerId = 0;
    }

    function schedule(key) {
      if (destroyed || key !== activeKey) return;
      var entry = entries[key];
      if (!entry) return;
      clearTimer(key);
      var delay = document.hidden
        ? safeInt(entry.hiddenIntervalMs, safeInt(entry.visibleIntervalMs, 30000))
        : safeInt(entry.visibleIntervalMs, 30000);
      entry.timerId = window.setTimeout(function () {
        api.refresh(key, "poll");
      }, Math.max(1000, delay));
    }

    function markResult(key, ok) {
      var entry = entries[key];
      if (!entry) return;
      entry.inFlight = false;
      entry.lastAttemptAt = new Date().toISOString();
      if (ok) {
        entry.failureCount = 0;
        entry.lastSuccessAt = entry.lastAttemptAt;
        entry.status = "live";
      } else {
        entry.failureCount += 1;
        entry.status = entry.failureCount >= 2 ? "stale" : "updating";
      }
      emit(key);
      schedule(key);
    }

    function applyResultHints(key, result) {
      var entry = entries[key];
      if (!entry || !result || typeof result !== "object") return;
      var visibleMs = safeInt(result.next_refresh_recommended_ms, 0);
      var hiddenMs = safeInt(result.hidden_refresh_recommended_ms, 0);
      if (visibleMs > 0) entry.visibleIntervalMs = Math.max(1000, visibleMs);
      if (hiddenMs > 0) {
        entry.hiddenIntervalMs = Math.max(1000, hiddenMs);
      } else if (visibleMs > 0) {
        entry.hiddenIntervalMs = Math.max(Math.max(1000, visibleMs), visibleMs * 3);
      }
    }

    function run(key, reason) {
      var entry = entries[key];
      if (!entry || entry.inFlight || destroyed) return Promise.resolve(null);
      entry.inFlight = true;
      entry.status = "updating";
      emit(key);
      return Promise.resolve()
        .then(function () {
          return entry.loader({ key: key, reason: reason || "manual" });
        })
        .then(function (result) {
          applyResultHints(key, result);
          markResult(key, true);
          return result;
        })
        .catch(function (err) {
          entry.lastError = err && err.message ? err.message : String(err || "Refresh failed");
          markResult(key, false);
          throw err;
        });
    }

    function onVisibilityChange() {
      if (!activeKey) return;
      if (!document.hidden) {
        api.refresh(activeKey, "visibility");
        return;
      }
      schedule(activeKey);
    }

    var api = {
      register: function (key, entryOptions) {
        var opts = entryOptions && typeof entryOptions === "object" ? entryOptions : {};
        entries[key] = {
          key: key,
          loader: opts.loader,
          visibleIntervalMs: safeInt(opts.visibleIntervalMs, 30000),
          hiddenIntervalMs: safeInt(opts.hiddenIntervalMs, safeInt(opts.visibleIntervalMs, 30000)),
          status: "idle",
          inFlight: false,
          failureCount: 0,
          lastSuccessAt: "",
          lastAttemptAt: "",
          lastError: "",
          timerId: 0
        };
      },
      activate: function (key) {
        if (!entries[key]) return;
        if (activeKey && activeKey !== key) clearTimer(activeKey);
        activeKey = key;
        schedule(key);
      },
      deactivate: function (key) {
        if (activeKey === key) activeKey = "";
        clearTimer(key);
      },
      refresh: function (key, reason) {
        return run(key, reason);
      },
      invalidate: function (key) {
        var entry = entries[key];
        if (!entry) return;
        entry.failureCount = 0;
        entry.lastError = "";
        entry.status = "idle";
        emit(key);
      },
      getState: function (key) {
        var entry = entries[key];
        if (!entry) {
          return {
            key: key,
            status: "idle",
            inFlight: false,
            failureCount: 0,
            lastSuccessAt: "",
            lastAttemptAt: "",
            lastError: ""
          };
        }
        return {
          key: entry.key,
          status: entry.status,
          inFlight: entry.inFlight,
          failureCount: entry.failureCount,
          lastSuccessAt: entry.lastSuccessAt,
          lastAttemptAt: entry.lastAttemptAt,
          lastError: entry.lastError
        };
      },
      destroy: function () {
        destroyed = true;
        Object.keys(entries).forEach(clearTimer);
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return api;
  }

  window.UPS_ACQ_REFRESH = {
    createRefreshManager: createRefreshManager
  };
})();
