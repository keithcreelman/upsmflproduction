/*!
 * MFLCache — UPS three-tier cache for MFL API responses
 * Stage 1 of docs/mfl_native/tos_removal_plan.md
 * Mirrors theeohiostate cache.js architecture (lessons_from_theeohiostate.md §1).
 *
 * Public surface: window.MFLCache.{ get, getSync, set, del, getOrFetch,
 *                                   serveStaleAndRefresh, TTL, KEY, bucket* }
 *
 * Also re-implements the MFL /export 429 guard (was inline in HPM #1) on top
 * of this layer. The guard auto-installs as a fetch wrapper.
 */
(function (root) {
  "use strict";
  if (root.MFLCache && root.MFLCache.__installed__) return;

  var DB_NAME = "MFLCache";
  var DB_VERSION = 1;
  var STORE = "entries";
  var LS_PREFIX = "mfl_c_";
  var LS_LOCK_PREFIX = "mfl_lock_";
  var BC_NAME = "MFLCache_BC";
  var PURGE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
  var TAB_ID = (function () {
    try { return (root.crypto && root.crypto.randomUUID) ? root.crypto.randomUUID() : String(Date.now()) + ":" + Math.random(); }
    catch (e) { return String(Date.now()) + ":" + Math.random(); }
  })();

  function nowMs() { return Date.now(); }
  function nowSec() { return Math.floor(Date.now() / 1000); }

  function safeJsonParse(raw, fallback) {
    try { return JSON.parse(String(raw == null ? "" : raw)); }
    catch (e) { return fallback; }
  }
  function safeJsonStringify(v) {
    try { return JSON.stringify(v); } catch (e) { return null; }
  }

  /* ---------- TTL / KEY canon (lessons §1c, §1d) ---------- */

  var TTL = {
    LIVE: 20,
    FIVE_MIN: 300,
    FIFTEEN_MIN: 900,
    HOUR: 3600,
    SIX_HOUR: 21600,
    DAILY: 86400,
    WEEKLY: 604800,
    NEVER: 2592000
  };

  var KEY = {
    playerDB:      function (y)         { return "global_" + y + "_playerDB"; },
    playerDBTs:    function (y)         { return "global_" + y + "_playerDB_updatedAt"; },
    injuries:      function (y)         { return "global_" + y + "_injuries"; },
    newsBreaker:   function ()          { return "global_newsBreaker"; },
    topStarters:   function (y, w)      { return "global_" + y + "_topStarters_w" + w; },
    nflSchedule:   function (y, w)      { return "global_" + y + "_nflSchedule_" + w; },
    myLeagues:     function (y)         { return "global_" + y + "_myLeagues"; },
    weather:       function ()          { return "global_weather"; },
    rosters:       function (y, lid)    { return "lid_" + y + "_" + lid + "_rosters"; },
    transactions:  function (y, lid)    { return "lid_" + y + "_" + lid + "_transactions"; },
    league:        function (y, lid)    { return "lid_" + y + "_" + lid + "_league"; },
    standings:     function (y, lid)    { return "lid_" + y + "_" + lid + "_standings"; },
    weeklyResults: function (y, lid, w) { return "lid_" + y + "_" + lid + "_weeklyResults_w" + w; },
    projScores:    function (y, lid, w) { return "lid_" + y + "_" + lid + "_projScores_w" + w; },
    customPlayer:  function (y, lid)    { return "lid_" + y + "_" + lid + "_customPlayer"; },
    mflExport:     function (normUrl)   { return "mflexp_" + normUrl; }
  };

  function bucketFiveMin(t) {
    var ms = t || nowMs();
    return Math.floor(ms / 300000) * 300000;
  }
  function bucketSixHour(t) {
    var s = t || nowSec();
    return 21600 * Math.floor(s / 21600);
  }
  // Daily bucket pinned to 9am ET-ish (54000s = 15h offset from UTC midnight).
  // Matches TOS canon so a port of mini-boxscore / news scripts keys identically.
  function bucketDaily(t) {
    var s = t || nowSec();
    return 86400 * Math.floor((s + 54000) / 86400);
  }

  /* ---------- Memory tier ---------- */

  var mem = new Map();

  function makeEntry(data, ttlSeconds) {
    return { data: data, storedAt: nowMs(), ttlMs: 1000 * (ttlSeconds || TTL.FIVE_MIN) };
  }
  function isExpiredEntry(e) {
    return !(e && e.storedAt && e.ttlMs) || (nowMs() - e.storedAt) > e.ttlMs;
  }

  function memGet(k) { return mem.has(k) ? mem.get(k) : null; }
  function memSet(k, e) { mem.set(k, e); }
  function memDel(k) { mem.delete(k); }

  /* ---------- IndexedDB tier ---------- */

  var idbPromise = null;
  var idbBroken = false;

  function openIdb() {
    if (idbBroken) return Promise.resolve(null);
    if (idbPromise) return idbPromise;
    idbPromise = new Promise(function (resolve) {
      var req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); }
      catch (e) { idbBroken = true; resolve(null); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "cacheKey" });
        }
      };
      req.onsuccess = function () {
        var db = req.result;
        db.onerror = function () {};
        resolve(db);
        scheduleIdbPurge(db);
      };
      req.onerror = function () { idbBroken = true; resolve(null); };
      req.onblocked = function () { resolve(null); };
    });
    return idbPromise;
  }

  function idbGet(k) {
    return openIdb().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(STORE, "readonly");
          var req = tx.objectStore(STORE).get(k);
          req.onsuccess = function () { resolve(req.result || null); };
          req.onerror = function () { resolve(null); };
        } catch (e) { resolve(null); }
      });
    });
  }

  function idbSet(k, entry) {
    return openIdb().then(function (db) {
      if (!db) return false;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(STORE, "readwrite");
          var row = Object.assign({ cacheKey: k }, entry);
          tx.objectStore(STORE).put(row);
          tx.oncomplete = function () { resolve(true); };
          tx.onerror = function () { resolve(false); };
        } catch (e) { resolve(false); }
      });
    });
  }

  function idbDel(k) {
    return openIdb().then(function (db) {
      if (!db) return false;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).delete(k);
          tx.oncomplete = function () { resolve(true); };
          tx.onerror = function () { resolve(false); };
        } catch (e) { resolve(false); }
      });
    });
  }

  // 14-day idle purge — runs when the page is otherwise quiet.
  function scheduleIdbPurge(db) {
    var run = function () {
      try {
        var tx = db.transaction(STORE, "readwrite");
        var store = tx.objectStore(STORE);
        var cutoff = nowMs() - PURGE_AFTER_MS;
        var cursorReq = store.openCursor();
        cursorReq.onsuccess = function () {
          var c = cursorReq.result;
          if (!c) return;
          var row = c.value;
          if (row && row.storedAt && row.storedAt < cutoff) c.delete();
          c.continue();
        };
      } catch (e) {}
    };
    if ("requestIdleCallback" in root) {
      try { root.requestIdleCallback(run, { timeout: 10000 }); return; } catch (e) {}
    }
    setTimeout(run, 8000);
  }

  /* ---------- localStorage tier ---------- */

  function lsKey(k) { return LS_PREFIX + k; }

  function lsGet(k) {
    try {
      var raw = root.localStorage.getItem(lsKey(k));
      if (!raw) return null;
      return safeJsonParse(raw, null);
    } catch (e) { return null; }
  }

  function lsSet(k, entry) {
    var raw = safeJsonStringify(entry);
    if (raw == null) return false;
    try {
      root.localStorage.setItem(lsKey(k), raw);
      return true;
    } catch (err) {
      if (isQuotaError(err)) {
        evictLocalStorage();
        try { root.localStorage.setItem(lsKey(k), raw); return true; }
        catch (e2) { return false; }
      }
      return false;
    }
  }

  function lsDel(k) {
    try { root.localStorage.removeItem(lsKey(k)); return true; }
    catch (e) { return false; }
  }

  function isQuotaError(err) {
    return err && (
      err.code === 22 ||
      err.code === 1014 ||
      err.name === "QuotaExceededError" ||
      err.name === "NS_ERROR_DOM_QUOTA_REACHED"
    );
  }

  function evictLocalStorage() {
    try {
      var ls = root.localStorage;
      var rows = [];
      for (var i = 0; i < ls.length; i += 1) {
        var k = ls.key(i);
        if (!k || k.indexOf(LS_PREFIX) !== 0) continue;
        var entry = safeJsonParse(ls.getItem(k), null);
        rows.push({ key: k, storedAt: (entry && entry.storedAt) || 0, expired: isExpiredEntry(entry) });
      }
      rows.sort(function (a, b) {
        if (a.expired !== b.expired) return a.expired ? -1 : 1;
        return a.storedAt - b.storedAt;
      });
      // Drop up to half (expired first, then oldest) — leaves headroom for the retry.
      var n = Math.min(rows.length, Math.max(8, Math.floor(rows.length / 2)));
      for (var j = 0; j < n; j += 1) {
        try { ls.removeItem(rows[j].key); } catch (e) {}
      }
    } catch (e) {}
  }

  /* ---------- BroadcastChannel (cross-tab promotion) ---------- */

  var bc = null;
  function ensureBC() {
    if (bc) return bc;
    if (!("BroadcastChannel" in root)) return null;
    try {
      bc = new BroadcastChannel(BC_NAME);
      bc.addEventListener("message", onBCMessage);
    } catch (e) { bc = null; }
    return bc;
  }

  function onBCMessage(ev) {
    var msg = ev && ev.data;
    if (!msg || msg.type !== "MFLCache" || !msg.cacheKey) return;
    if (msg.tab === TAB_ID) return;
    if (msg.entry) memSet(msg.cacheKey, msg.entry);
    else memDel(msg.cacheKey);
  }

  function broadcast(k, entry) {
    var c = ensureBC();
    if (!c) return;
    try { c.postMessage({ type: "MFLCache", tab: TAB_ID, cacheKey: k, entry: entry }); }
    catch (e) {}
  }

  /* ---------- Stampede locks (navigator.locks → CAS fallback) ---------- */

  var releasers = new Map();
  var locksHeld = new Set();

  function acquireLock(name, timeoutMs) {
    var lockName = "MFLLock_" + name;
    if (root.navigator && root.navigator.locks && root.navigator.locks.request) {
      return new Promise(function (resolve) {
        try {
          root.navigator.locks.request(lockName, { ifAvailable: true }, function (lock) {
            if (!lock) { resolve(false); return; }
            locksHeld.add(lockName);
            resolve(true);
            return new Promise(function (release) { releasers.set(lockName, release); });
          });
        } catch (e) { resolve(false); }
      });
    }
    return Promise.resolve(casAcquire(lockName, timeoutMs || 30000));
  }

  function releaseLock(name) {
    var lockName = "MFLLock_" + name;
    if (releasers.has(lockName)) {
      try { releasers.get(lockName)(); } catch (e) {}
      releasers.delete(lockName);
    }
    locksHeld.delete(lockName);
    casRelease(lockName);
  }

  function casAcquire(lockName, timeoutMs) {
    var k = LS_LOCK_PREFIX + lockName;
    var now = nowMs();
    var existing = safeJsonParse(safeLsGet(k), null);
    if (existing && existing.exp > now && existing.tab !== TAB_ID) return false;
    var token = (root.crypto && root.crypto.randomUUID) ? root.crypto.randomUUID() : String(now) + ":" + Math.random();
    var payload = safeJsonStringify({ tab: TAB_ID, exp: now + timeoutMs, token: token });
    try { root.localStorage.setItem(k, payload); }
    catch (e) { return false; }
    var verify = safeJsonParse(safeLsGet(k), null);
    return !!(verify && verify.token === token);
  }

  function casRelease(lockName) {
    var k = LS_LOCK_PREFIX + lockName;
    try {
      var existing = safeJsonParse(safeLsGet(k), null);
      if (existing && existing.tab === TAB_ID) root.localStorage.removeItem(k);
    } catch (e) {}
  }

  function safeLsGet(k) {
    try { return root.localStorage.getItem(k); } catch (e) { return null; }
  }

  /* ---------- Core operations ---------- */

  function getSync(k) {
    var e = memGet(k);
    return e || null;
  }

  function get(k) {
    var hit = memGet(k);
    if (hit) return Promise.resolve(hit);
    return idbGet(k).then(function (e) {
      if (e) { memSet(k, e); return e; }
      var ls = lsGet(k);
      if (ls) { memSet(k, ls); return ls; }
      return null;
    });
  }

  function set(k, data, ttlSeconds, opts) {
    var entry = makeEntry(data, ttlSeconds);
    memSet(k, entry);
    idbSet(k, entry);
    lsSet(k, entry);
    if (!(opts && opts.silent)) broadcast(k, entry);
    return Promise.resolve(entry);
  }

  function del(k) {
    memDel(k);
    lsDel(k);
    idbDel(k);
    broadcast(k, null);
    return Promise.resolve(true);
  }

  function getFresh(k) {
    return get(k).then(function (e) { return e && !isExpiredEntry(e) ? e : null; });
  }

  // Stampede-safe fetch: only one tab/inflight call per key triggers the fetcher;
  // followers wait on BroadcastChannel for the result.
  function getOrFetch(k, fetcher, ttlSeconds) {
    return get(k).then(function (e) {
      if (e && !isExpiredEntry(e)) return e.data;
      return acquireLock(k, 30000).then(function (got) {
        if (!got) return waitForBroadcast(k, 30000).then(function (e2) {
          return e2 ? e2.data : Promise.resolve(fetcher()).then(function (data) {
            return set(k, data, ttlSeconds).then(function (en) { return en.data; });
          });
        });
        return get(k).then(function (e2) {
          if (e2 && !isExpiredEntry(e2)) {
            releaseLock(k);
            return e2.data;
          }
          return Promise.resolve(fetcher()).then(function (data) {
            return set(k, data, ttlSeconds).then(function (en) {
              releaseLock(k);
              return en.data;
            });
          }, function (err) {
            releaseLock(k);
            throw err;
          });
        });
      });
    });
  }

  function waitForBroadcast(k, timeoutMs) {
    return new Promise(function (resolve) {
      var c = ensureBC();
      if (!c) { resolve(null); return; }
      var done = false;
      var to = setTimeout(function () {
        if (done) return;
        done = true;
        c.removeEventListener("message", h);
        resolve(memGet(k));
      }, timeoutMs);
      function h(ev) {
        var msg = ev && ev.data;
        if (!msg || msg.type !== "MFLCache" || msg.cacheKey !== k) return;
        if (done) return;
        done = true;
        clearTimeout(to);
        c.removeEventListener("message", h);
        resolve(msg.entry);
      }
      c.addEventListener("message", h);
    });
  }

  // Renders cached value (even stale) immediately via `onHit(data, source)`,
  // kicks off a refresh if expired. onHit may be called twice: once with cached,
  // once with refreshed. Returns a Promise that resolves when refresh completes
  // (or immediately if cache was fresh).
  function serveStaleAndRefresh(k, fetcher, ttlSeconds, onHit) {
    var sync = memGet(k);
    if (sync && sync.data !== undefined) {
      try { onHit && onHit(sync.data, "cache"); } catch (e) {}
      if (!isExpiredEntry(sync)) return Promise.resolve(false);
      return Promise.resolve(fetcher()).then(function (data) {
        if (data === undefined || data === null) return false;
        return set(k, data, ttlSeconds, { silent: true }).then(function () {
          try { onHit && onHit(data, "refresh"); } catch (e) {}
          return true;
        });
      }).catch(function () { return false; });
    }
    return get(k).then(function (e) {
      if (e && e.data !== undefined) {
        try { onHit && onHit(e.data, "cache"); } catch (err) {}
        if (!isExpiredEntry(e)) return false;
      }
      return Promise.resolve(fetcher()).then(function (data) {
        if (data === undefined || data === null) return false;
        return set(k, data, ttlSeconds, { silent: true }).then(function () {
          try { onHit && onHit(data, "refresh"); } catch (err) {}
          return true;
        });
      }).catch(function () { return false; });
    });
  }

  /* ---------- MFL /export 429 guard (re-implementation on top of MFLCache) ---------- */

  function isMflExportUrl(urlObj) {
    if (!urlObj) return false;
    var host = String(urlObj.hostname || "").toLowerCase();
    if (host.indexOf("myfantasyleague.com") === -1) return false;
    return /\/export$/i.test(String(urlObj.pathname || ""));
  }

  function normalizeExportKey(urlObj) {
    var p;
    try { p = new URLSearchParams(urlObj.search || ""); }
    catch (e) { return urlObj.origin + urlObj.pathname; }
    var keys = [];
    p.forEach(function (_v, k) {
      if (k === "_" || k === "JSON") return;
      keys.push(k);
    });
    keys.sort();
    var parts = [];
    for (var i = 0; i < keys.length; i += 1) {
      parts.push(keys[i] + "=" + (p.get(keys[i]) || ""));
    }
    return urlObj.origin + urlObj.pathname + "?" + parts.join("&");
  }

  function staleResponse(text, reason) {
    return new Response(String(text == null ? "{}" : text), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-UPS-MFL-Guard": String(reason || "stale-cache")
      }
    });
  }

  var backoffState = new Map();
  var BACKOFF_MS = 45000;

  function installExportGuard() {
    if (root.__UPS_MFL_EXPORT_GUARD_INSTALLED__) return;
    if (typeof root.fetch !== "function") return;
    root.__UPS_MFL_EXPORT_GUARD_INSTALLED__ = true;

    var originalFetch = root.fetch;

    root.fetch = function (input, init) {
      var reqInit = init || {};
      var method = String(reqInit.method || "GET").toUpperCase();
      var urlObj = null;
      try {
        urlObj = new URL(typeof input === "string" ? input : (input && input.url) || "", root.location.href);
      } catch (e) { urlObj = null; }

      if (method !== "GET" || !isMflExportUrl(urlObj)) {
        return originalFetch.apply(this, arguments);
      }

      var normUrl = normalizeExportKey(urlObj);
      var k = KEY.mflExport(normUrl);
      var nowT = nowMs();
      var backoffUntil = backoffState.get(k) || 0;
      var cached = memGet(k);

      if (backoffUntil > nowT && cached && cached.data) {
        return Promise.resolve(staleResponse(cached.data, "backoff-cache"));
      }

      // Warm memory tier from LS/IDB synchronously (best-effort) before the fetch.
      if (!cached) {
        var lsHit = lsGet(k);
        if (lsHit) { memSet(k, lsHit); cached = lsHit; }
      }

      var args = arguments;
      var self = this;
      return originalFetch.apply(self, args).then(function (res) {
        if (res && res.status === 429) {
          backoffState.set(k, nowMs() + BACKOFF_MS);
          if (cached && cached.data) {
            try { console.warn("[UPS][MFL-Guard] 429 on export; serving cached payload for", normUrl); } catch (e) {}
            return staleResponse(cached.data, "429-cache");
          }
          return res;
        }
        if (res && res.ok) {
          try {
            res.clone().text().then(function (txt) {
              if (!txt) return;
              set(k, txt, TTL.SIX_HOUR, { silent: true });
            }).catch(function () {});
          } catch (e) {}
        }
        return res;
      }).catch(function (err) {
        if (cached && cached.data) {
          try { console.warn("[UPS][MFL-Guard] fetch error; serving cached payload for", normUrl, err); } catch (e) {}
          return staleResponse(cached.data, "error-cache");
        }
        throw err;
      });
    };
  }

  /* ---------- Public surface ---------- */

  root.MFLCache = {
    __installed__: true,
    TTL: TTL,
    KEY: KEY,
    bucketFiveMin: bucketFiveMin,
    bucketSixHour: bucketSixHour,
    bucketDaily: bucketDaily,
    get: get,
    getSync: getSync,
    getFresh: getFresh,
    set: set,
    del: del,
    getOrFetch: getOrFetch,
    serveStaleAndRefresh: serveStaleAndRefresh,
    isExpiredEntry: isExpiredEntry,
    _tabId: TAB_ID
  };

  ensureBC();
  installExportGuard();

  // Warm IDB asynchronously so the first real get() doesn't block on schema upgrade.
  openIdb();

})(typeof window !== "undefined" ? window : this);
