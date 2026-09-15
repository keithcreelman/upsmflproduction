/* Game Day — MFL HPM embed loader.
 *
 * Mounted by the header's MESSAGE19 hub container when ?hub=gameday.
 * Fetches gameday.html plus every relative <script> it references as one
 * bundle from one source (see SOURCES below), hands the scripts to the frame
 * as blob: URLs, injects
 * the league/year/host/franchise context + a height beacon, renders via
 * srcdoc. The page itself resolves the viewer's franchise from MFL cookies
 * when FRANCHISE_ID isn't passed.
 */
(function () {
  "use strict";
  // One Game Day per page, even if a slow first copy of this script runs
  // after a fallback copy.
  if (window.__ups_gameday_loader) return;
  window.__ups_gameday_loader = true;
  function pad4(v) { var d = String(v || "").replace(/\D/g, ""); return d ? d.padStart(4, "0").slice(-4) : ""; }
  function safeStr(v) { return String(v == null ? "" : v).trim(); }
  function getUrl() { try { return new URL(window.location.href); } catch (e) { return null; } }
  var u = getUrl();

  // Digits only: these values are written into the frame's HTML.
  function getLeagueId() {
    var q = u ? safeStr(u.searchParams.get("L")) : "";
    if (/^\d{1,8}$/.test(q)) return q;
    var g = safeStr(window.league_id || window.LEAGUE_ID);
    if (/^\d{1,8}$/.test(g)) return g;
    var m = safeStr(window.location.pathname).match(/\/home\/(\d+)(?:\/|$)/i);
    return (m && m[1]) || "74598";
  }
  function getYear() {
    var q = u ? safeStr(u.searchParams.get("YEAR")) : "";
    if (/^\d{4}$/.test(q)) return q;
    var g = safeStr(window.year || window.YEAR);
    if (/^\d{4}$/.test(g)) return g;
    var m = safeStr(window.location.pathname).match(/\/(\d{4})\//);
    return (m && m[1]) || String(new Date().getFullYear());
  }
  function getFranchiseId() {
    var ids = [window.FRANCHISE_ID, window.franchise_id, window.fid];
    for (var i = 0; i < ids.length; i++) { var p = pad4(ids[i]); if (p) return p; }
    if (u) { var p2 = pad4(u.searchParams.get("FRANCHISE_ID") || u.searchParams.get("FRANCHISE") || u.searchParams.get("F")); if (p2) return p2; }
    // MFL sets this cookie for any logged-in owner — most reliable identity.
    try { var m = String(document.cookie || "").match(/(?:^|;\s*)MFL_LAST_LOGIN_FRANCHISE_ID=([^;]+)/i); if (m) { var p3 = pad4(m[1]); if (p3) return p3; } } catch (e) {}
    return "";
  }

  var L = getLeagueId(), YEAR = getYear(), FID = getFranchiseId();
  var HOST = safeStr(window.location && window.location.host) || "www48.myfantasyleague.com";
  // RELEASE SHA — AND WHY IT IS RE-RESOLVED HERE.
  // The header seeds window.UPS_RELEASE_SHA SYNCHRONOUSLY from sessionStorage
  // and only then fetches the current main SHA, so anything opened early in a
  // session loads from whatever commit that session first cached. jsDelivr
  // serves @<sha> immutably, so the stale pin sticks for the whole session:
  // merged fixes were live on Pages and on jsDelivr @main, and the embedded
  // Game Day still ran code from the previous day. Re-resolve it here, cheaply
  // (~one no-store request against GitHub's .sha media type), and fall back to
  // whatever we already had if that fails or is slow.
  function resolveSha() {
    // Read at call time, not load time: a Try again should use any SHA the
    // header (or an earlier attempt) learned since.
    var known = safeStr(window.UPS_RELEASE_SHA) || "main";
    return new Promise(function (done) {
      var settled = false;
      var finish = function (v) { if (!settled) { settled = true; done(v || known); } };
      // Never let SHA resolution delay the embed for long.
      setTimeout(function () { finish(known); }, 1500);
      try {
        fetch("https://api.github.com/repos/keithcreelman/upsmflproduction/commits/main", {
          headers: { Accept: "application/vnd.github.sha" }, cache: "no-store"
        }).then(function (r) { return r.ok ? r.text() : ""; }).then(function (t) {
          t = safeStr(t).trim();
          if (/^[0-9a-f]{7,40}$/i.test(t)) {
            try { window.UPS_RELEASE_SHA = t; sessionStorage.setItem("ups_release_sha_v1", t); } catch (e) {}
            finish(t);
          } else { finish(known); }
        }).catch(function () { finish(known); });
      } catch (e) { finish(known); }
    });
  }

  // WHERE THE PAGE COMES FROM — AND WHY NOT JUST jsDelivr.
  // Keith 2026-09-15: "Game Day failed to load: undefined is not an object
  // (evaluating 'LS.parseInjuries')". The repo's tracked files are ~265 MB and
  // jsDelivr's GitHub package limit is 50 MB, so jsDelivr answers a shifting
  // subset of files with "403 Package size exceeded the configured limit of
  // 50 MB" (which files changes per commit; each refusal is cached ~60s).
  // gameday.html came through but ../shared/live_scoring.js was refused, so
  // window.UPSLive never existed. Now the page and every relative <script> it
  // needs are fetched together from ONE source and checked. If any file
  // fails, that whole source is dropped and the next is tried. Each fetched
  // script is handed to the frame as a blob: URL (the srcdoc frame shares
  // this page's origin), so it runs exactly like the original external file —
  // same order, same defer/async — with no JavaScript pasted into HTML.
  //   1. raw.githubusercontent.com @<sha>: exact commit, immutable, live the
  //      moment it's pushed. Its text/plain type doesn't matter behind a blob.
  //   2. jsDelivr @<sha>: also pinned to the commit, and when it refuses a
  //      file it says so (403), so a bad bundle can't slip through.
  //   3. GitHub Pages: no size limit, but its CDN ignores ?v= and caches each
  //      file separately for 10 minutes, so it can pair files from two
  //      deploys. Last resort, and only accepted when every file carries the
  //      same deploy time (Last-Modified).
  var REPO = "keithcreelman/upsmflproduction";
  var PAGE_PATH = "gameday/gameday.html"; // relative to site/
  var PAGES_ROOT = "https://keithcreelman.github.io/upsmflproduction/";
  var SOURCES = [
    {
      name: "github-raw",
      fileUrl: function (p, sha) { return "https://raw.githubusercontent.com/" + REPO + "/" + encodeURIComponent(sha) + "/site/" + p; },
      // raw can't serve subresources with real content types, so anything the
      // page still references relatively besides scripts (nothing today)
      // resolves on Pages.
      baseUrl: function () { return PAGES_ROOT + "gameday/"; }
    },
    {
      name: "jsdelivr",
      fileUrl: function (p, sha) { return "https://cdn.jsdelivr.net/gh/" + REPO + "@" + encodeURIComponent(sha) + "/site/" + p + "?v=" + encodeURIComponent(sha); },
      baseUrl: function (sha) { return "https://cdn.jsdelivr.net/gh/" + REPO + "@" + encodeURIComponent(sha) + "/site/gameday/"; }
    },
    {
      name: "github-pages",
      fileUrl: function (p, sha) { return PAGES_ROOT + p + "?v=" + encodeURIComponent(sha); },
      baseUrl: function () { return PAGES_ROOT + "gameday/"; },
      sameDeploy: true,
      // Not commit-pinned, so the browser must not replay a mixed pair.
      noStore: true
    }
  ];
  var HEADERS_TIMEOUT_MS = 8000;
  var BODY_TIMEOUT_MS = 20000;
  // Files from one Pages deploy are stamped ~1s apart; separate deploys have
  // landed as little as 83s apart.
  var PAGES_DEPLOY_SPREAD_MS = 15 * 1000;
  function isCommitSha(sha) { return /^[0-9a-f]{7,40}$/i.test(sha); }

  // Rejects if `promise` hasn't settled in `ms`. Needed on its own because
  // AbortController is missing in older Safari; with it, the abort also stops
  // the request.
  function withTimeout(promise, ms, ctrl) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        if (ctrl) { try { ctrl.abort(); } catch (e) {} }
        var err = new Error("timed out"); err.name = "AbortError"; reject(err);
      }, ms);
      promise.then(function (v) { clearTimeout(timer); resolve(v); }, function (e) { clearTimeout(timer); reject(e); });
    });
  }

  // Resolves { text, lastModified }. Rejects with a short, owner-readable
  // message ("HTTP 403 on live_scoring.js"); the full URL rides along on
  // err.url for the console.
  function fetchText(url, sha, noStore) {
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    // @<sha> URLs are immutable, so the browser cache is safe to use; an
    // unresolved SHA or a Pages URL is not.
    var opts = { cache: noStore || !isCommitSha(sha) ? "no-store" : "default" };
    if (ctrl) opts.signal = ctrl.signal;
    var file = url.replace(/[?#].*$/, "").replace(/^.*\//, "");
    function fail(reason) { var e = new Error(reason + " on " + file); e.url = url; return e; }
    var lastModified = null;
    return withTimeout(fetch(url, opts), HEADERS_TIMEOUT_MS, ctrl).then(function (r) {
      if (!r.ok) throw fail("HTTP " + r.status);
      lastModified = r.headers.get("last-modified");
      return withTimeout(r.text(), BODY_TIMEOUT_MS, ctrl);
    }).then(function (t) {
      if (!t) throw fail("empty response");
      return { text: t, lastModified: lastModified };
    }, function (e) {
      if (e && e.url) throw e;
      throw fail(e && e.name === "AbortError" ? "timed out" : "network error (" + ((e && e.message) || e) + ")");
    });
  }

  function isAbsolute(src) { return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src); }
  // Relative script paths resolve against the page's folder inside site/.
  // Anything that could point outside site/ is refused, not fetched.
  function sitePathFor(src) {
    if (src.charAt(0) === "/") throw new Error("root-relative script src isn't supported: " + src);
    var dir = PAGE_PATH.replace(/[^/]*$/, "");
    var path = new URL(src, "https://site.invalid/site/" + dir).pathname;
    var decoded;
    try { decoded = decodeURIComponent(path); } catch (e) { decoded = path; }
    if (path.indexOf("/site/") !== 0 || /(^|\/)\.\.(\/|$)|\\/.test(decoded)) {
      throw new Error("script path escapes site/: " + src);
    }
    return path.slice("/site/".length);
  }

  // Parses the page with the browser's own HTML parser (so comments,
  // <template> and odd quoting behave as in a real page load), fetches every
  // relative script, and returns the parsed document plus script bodies.
  function fetchBundle(source, sha) {
    return fetchText(source.fileUrl(PAGE_PATH, sha), sha, source.noStore).then(function (page) {
      var doc = new DOMParser().parseFromString(page.text, "text/html");
      if (!doc.body || !doc.querySelector("script")) {
        throw new Error("not the Game Day page from " + source.name);
      }
      var tags = [].slice.call(doc.querySelectorAll("script[src]"));
      var srcs = [];
      tags.forEach(function (s) {
        var src = safeStr(s.getAttribute("src"));
        if (!isAbsolute(src) && srcs.indexOf(src) === -1) srcs.push(src);
      });
      var paths = srcs.map(sitePathFor);
      return Promise.all(paths.map(function (p) { return fetchText(source.fileUrl(p, sha), sha, source.noStore); })).then(function (files) {
        if (source.sameDeploy) {
          var times = [page].concat(files).map(function (f) { return Date.parse(f.lastModified || ""); });
          if (times.some(function (t) { return !(t > 0); })) {
            throw new Error("missing deploy time, can't confirm files match");
          }
          if (Math.max.apply(null, times) - Math.min.apply(null, times) > PAGES_DEPLOY_SPREAD_MS) {
            throw new Error("files are from different deploys (mid-deploy cache)");
          }
        }
        var bodies = {};
        srcs.forEach(function (src, i) { bodies[src] = files[i].text; });
        return { doc: doc, tags: tags, bodies: bodies, base: source.baseUrl(sha), source: source.name };
      });
    });
  }

  var liveBlobUrls = [];
  // Only called once a whole bundle succeeded, so failed sources leave no blobs.
  function renderDocument(bundle, ctx) {
    var doc = bundle.doc;
    var urls = {};
    Object.keys(bundle.bodies).forEach(function (src) {
      urls[src] = URL.createObjectURL(new Blob([bundle.bodies[src]], { type: "text/javascript" }));
    });
    bundle.tags.forEach(function (s) {
      var src = safeStr(s.getAttribute("src"));
      if (urls[src]) s.setAttribute("src", urls[src]);
    });
    var leftover = [].slice.call(doc.querySelectorAll("script[src]")).filter(function (s) {
      return !isAbsolute(safeStr(s.getAttribute("src")));
    });
    if (leftover.length) throw new Error("a script tag was left unresolved: " + leftover[0].getAttribute("src"));

    var head = doc.head || doc.documentElement.insertBefore(doc.createElement("head"), doc.body);
    var baseEl = doc.createElement("base");
    baseEl.setAttribute("href", bundle.base);
    var ctxScript = doc.createElement("script");
    ctxScript.textContent = contextScript(ctx);
    head.insertBefore(ctxScript, head.firstChild);
    head.insertBefore(baseEl, head.firstChild);

    var old = liveBlobUrls;
    liveBlobUrls = Object.keys(urls).map(function (k) { return urls[k]; });
    // The previous attempt's frame is about to be replaced.
    old.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
    var doctype = doc.doctype ? "<!DOCTYPE " + doc.doctype.name + ">\n" : "";
    return { html: doctype + doc.documentElement.outerHTML, scripts: liveBlobUrls.length };
  }

  function loadFromFirstWorkingSource(sha) {
    var failures = [];
    // Without a real commit SHA, raw /main/ and jsDelivr @main cache each file
    // separately and could pair versions; only Pages can prove its files match.
    var sources = isCommitSha(sha) ? SOURCES : SOURCES.filter(function (s) { return s.sameDeploy; });
    return sources.reduce(function (prev, source) {
      return prev.catch(function () {
        return fetchBundle(source, sha).catch(function (err) {
          failures.push(source.name + ": " + err.message);
          try { console.warn("[gameday-loader] " + source.name + " failed: " + err.message + (err.url ? " (" + err.url + ")" : "")); } catch (e) {}
          throw err;
        });
      });
    }, Promise.reject(new Error("start"))).catch(function () {
      throw new Error("Couldn't reach any of its sources. " + failures.join(" · "));
    });
  }

  var mount = document.getElementById("gameDayMount") || (function () {
    var d = document.createElement("div"); d.id = "gameDayMount"; document.body.appendChild(d); return d;
  })();
  var frame = null;
  function mountFrame() {
    mount.innerHTML = "";
    frame = document.createElement("iframe");
    frame.setAttribute("loading", "eager");
    frame.style.cssText = "width:100%;min-height:760px;border:0;background:#0b0f18;display:block;border-radius:8px;overflow:hidden";
    frame.title = "UPS Game Day";
    mount.appendChild(frame);
    return frame;
  }

  // Script text is serialized raw into srcdoc, so "</script" in a value would
  // end the element. Escape "<" (and the JS line separators) in every value.
  function jsValue(v) {
    return JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  }
  function contextScript(ctx) {
    return 'window.UPS_GAMEDAY_LEAGUE_ID=' + jsValue(ctx.leagueId) + ';' +
      'window.UPS_GAMEDAY_YEAR=' + jsValue(ctx.year) + ';' +
      'window.UPS_GAMEDAY_HOST=' + jsValue(ctx.host) + ';' +
      'window.UPS_GAMEDAY_FRANCHISE_ID=' + jsValue(ctx.franchiseId) + ';' +
      '(function(){function post(){try{var h=Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0);parent.postMessage({type:"gameday-height",height:h},"*");}catch(e){}}' +
      'window.addEventListener("load",post);window.addEventListener("resize",post);' +
      'if(typeof ResizeObserver==="function"){try{new ResizeObserver(post).observe(document.documentElement);}catch(e){}}' +
      'setInterval(post,800);})();';
  }

  function showLoadError(message) {
    mount.innerHTML =
      '<div style="padding:24px;color:#f88;font-family:sans-serif;line-height:1.45">' +
      '<div style="font-weight:700;margin-bottom:6px">Game Day failed to load.</div>' +
      '<div id="gameDayErrorDetail" style="color:#c9d1d9;font-size:13px;word-break:break-word"></div>' +
      '<button type="button" id="gameDayRetry" style="margin-top:14px;padding:8px 14px;border-radius:6px;border:1px solid #5b6b82;background:#161f2e;color:#e6edf3;font-weight:600;cursor:pointer">Try again</button>' +
      '</div>';
    // Text, never markup: the message can quote a script path from the page.
    var detail = document.getElementById("gameDayErrorDetail");
    if (detail) detail.textContent = message;
    var btn = document.getElementById("gameDayRetry");
    if (btn) btn.addEventListener("click", load);
  }

  var loading = false;
  function load() {
    if (loading) return;
    loading = true;
    mount.innerHTML = '<div style="padding:24px;color:#8b949e;font-family:sans-serif">Loading Game Day…</div>';
    return resolveSha().then(function (sha) {
      return loadFromFirstWorkingSource(sha);
    }).then(function (bundle) {
      var out = renderDocument(bundle, { leagueId: L, year: YEAR, host: HOST, franchiseId: FID });
      try { console.info("[gameday-loader] served by " + bundle.source + " (" + out.scripts + " script(s) as blob URLs)"); } catch (e) {}
      mountFrame().srcdoc = out.html;
    }).catch(function (err) {
      showLoadError(err && err.message || String(err));
    }).then(function () { loading = false; });
  }

  window.addEventListener("message", function (ev) {
    if (!frame || !ev || ev.source !== frame.contentWindow) return;
    if (ev.data && ev.data.type === "gameday-height") {
      var h = Number(ev.data.height); if (h && h > 100) frame.style.minHeight = h + "px";
    }
  });

  load();
})();
