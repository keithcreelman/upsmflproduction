/* Front Office player news (#1356, Keith 2026-10-22).
 *
 * Reads the ONE shared feed, GET /api/news-feed (contract ups.news.v1, see
 * docs/NEWS_FEED_CONTRACT.md), and draws:
 *   - a small news icon beside a player who has a story: highlighted when the
 *     newest one is ≤ 48 h old, quieter when older (the feed keeps ~7 days);
 *   - a chronological popup (a bottom sheet on a phone) with source credit,
 *     approximate time and links to the original stories;
 *   - the same list in the player slide-over's News tab.
 *
 * Rules:
 *   - News is not the injury designation. Nothing here reads or shows MFL's
 *     injury report; the roster's injury chip owns that.
 *   - Only stories ABOUT the player count (tag / headline / MFL id). A story
 *     that merely mentions him in its summary gets no icon and no row.
 *   - An outage never reads as "no news": a source down → "may be
 *     incomplete"; nothing answered → "unavailable" with a retry.
 *   - MFL Player News (RotoWire / Dynasty League Football / FFToday) is the
 *     provider's licensed text. Inside MFL, the owner's browser reads the
 *     headline from MFL (site/shared/mfl_player_news.js) and it is shown with
 *     the provider's credit. On the standalone UPS site it shows the event
 *     label and "Read on MFL". Credits are shown exactly as the feed names
 *     them (RotoWire is never relabeled; Rotoworld is not a source).
 *
 * Loaded lazily by front_office.js (foNewsReady) so the SHA-pinned embed
 * loader's fixed script list needs no change. Pure helpers are exported for
 * tests/fo_news.test.mjs.
 */
(function (root) {
  "use strict";

  var FRESH_SECONDS = 48 * 3600;
  var WINDOW_SECONDS = 8 * 86400;   // ~7 days of MFL updates, plus MFL's day rounding
  var EVENT_LABEL = {
    retirement: "Retirement", suspension: "Suspension", ir_return: "Return from IR", ir_move: "IR move",
    season_ending: "Season-ending", designation: "Game status", practice: "Practice report",
    starting_role: "Starting role", trade: "Trade", signing: "Signing", release: "Release",
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  // escapeHtml alone doesn't neutralise a URL scheme: only http(s) becomes a link.
  function safeUrl(u) {
    try { var p = new URL(String(u || "")); return (p.protocol === "https:" || p.protocol === "http:") ? p.href : ""; } catch (e) { return ""; }
  }
  function displayName(name) {
    var n = String(name || "");
    return n.indexOf(",") >= 0 ? n.split(",").map(function (x) { return x.trim(); }).reverse().join(" ") : n.trim();
  }
  function nowS(opts) { return Math.floor(((opts && opts.now) || Date.now()) / 1000); }

  // "3 h ago" / "2 d ago". MFL gives floored ages ("5 days" = 5–6 days) and
  // the feed stores the midpoint, so an MFL time is floored back to MFL's own
  // number and reads "about …".
  function ago(ts, precision, now) {
    if (!ts) return "time unknown";
    var s = Math.max(0, now - ts);
    var approx = precision && precision !== "exact";
    var r = approx ? Math.floor : Math.round;
    var txt = s < 3600 ? Math.max(1, r(s / 60)) + " min ago" : s < 86400 ? Math.max(1, r(s / 3600)) + " h ago" : r(s / 86400) + " d ago";
    return (approx ? "about " : "") + txt;
  }

  // Only stories about THIS player (primary), newest first.
  function primaryItems(view, pid) {
    var id = String(pid);
    return ((view && view.items) || []).filter(function (it) {
      var p = (it.players || []).filter(function (x) { return x.mfl_id === id; })[0];
      return p && p.primary;
    }).sort(function (a, b) { return (b.published_ts || 0) - (a.published_ts || 0); });
  }

  // Icon level: "fresh" (≤ 48 h), "older" (in the window), or null.
  function badgeLevel(view, pid, opts) {
    var items = primaryItems(view, pid);
    if (!items.length) return null;
    var age = nowS(opts) - (items[0].published_ts || 0);
    if (!items[0].published_ts || age > WINDOW_SECONDS) return null;
    return age <= FRESH_SECONDS ? "fresh" : "older";
  }

  // The popup / tab model. `view` is one entry of /api/news-feed?pids= →
  // players[pid] (or null when the read failed). `head` is that response's
  // feed-level fields (sources). `mflText` is the in-MFL text by article id.
  function listModel(view, pid, opts) {
    opts = opts || {};
    var now = nowS(opts);
    var name = displayName(opts.name || "");
    var inside = !!opts.insideMfl;
    var links = {
      player: view && view.mfl_news_url ? view.mfl_news_url : null,
      all: opts.leagueId && opts.season ? "https://www48.myfantasyleague.com/" + encodeURIComponent(opts.season) + "/news_articles?L=" + encodeURIComponent(opts.leagueId) + "&PLAYERS=A" : null,
    };
    if (!view || opts.failed) return { state: "unavailable", name: name, note: "News couldn't be loaded: no source answered, so this is not \"no news\".", items: [], links: links };
    if (view.state === "unavailable") return { state: "unavailable", name: name, note: "News couldn't be loaded: no source answered, so this is not \"no news\".", items: [], links: links };
    if (view.state === "unknown_player") return { state: "unknown_player", name: name, note: "This player isn't in MFL's player list.", items: [], links: links };
    var down = (view.unavailable_sources || []).slice();
    var items = primaryItems(view, pid).map(function (it) {
      var mflLed = it.headline_policy === "read_on_mfl";
      var text = mflLed ? (inside && it.mfl_text ? it.mfl_text.headline : null) : it.headline;
      var credit = it.publisher + (it.via ? " via " + it.via : "");
      return {
        id: it.id,
        fresh: (now - (it.published_ts || 0)) <= FRESH_SECONDS,
        text: text,
        label: text ? null : it.publisher + " update" + (EVENT_LABEL[it.event] ? " · " + EVENT_LABEL[it.event] : ""),
        event: EVENT_LABEL[it.event] || null,
        credit: credit,
        time: ago(it.published_ts, it.published_precision, now),
        url: safeUrl(it.url),
        linkText: mflLed ? "Read on MFL" : "Open story",
        also: (it.also_reported_by || []).map(function (a) {
          return { credit: a.publisher + (a.via ? " via " + a.via : ""), url: safeUrl(a.url), text: inside && a.mfl_text ? a.mfl_text.headline : null };
        }),
      };
    });
    var state, note = "";
    if (items.length) {
      state = "items";
      if (down.length) note = "Some sources didn't answer (" + down.join(", ") + "). This list may be incomplete.";
    } else if (down.length) {
      state = "partial";
      note = "Nothing found for " + name + ", but some sources didn't answer (" + down.join(", ") + "). This list may be incomplete.";
    } else {
      state = "empty";
      note = "No stories about " + name + " in the last ~7 days.";
    }
    return { state: state, name: name, note: note, items: items, links: links };
  }

  function itemHtml(m) {
    var main = m.text != null ? esc(m.text) : esc(m.label);
    var head = m.url
      ? '<a class="fo-nw-h" href="' + esc(m.url) + '" target="_blank" rel="noopener noreferrer">' + main + "</a>"
      : '<span class="fo-nw-h">' + main + "</span>";
    var meta = (m.event && m.text != null ? '<span class="fo-nw-ev">' + esc(m.event) + "</span> " : "") +
      '<span class="fo-nw-credit">' + esc(m.credit) + "</span> · " + esc(m.time) +
      (m.url ? ' · <a href="' + esc(m.url) + '" target="_blank" rel="noopener noreferrer">' + esc(m.linkText) + " ↗</a>" : "");
    var also = m.also.length ? '<div class="fo-nw-also">Also: ' + m.also.map(function (a) {
      var t = esc(a.credit) + (a.text ? ": " + esc(a.text) : "");
      return a.url ? '<a href="' + esc(a.url) + '" target="_blank" rel="noopener noreferrer">' + t + "</a>" : t;
    }).join(" · ") + "</div>" : "";
    return '<li class="fo-nw-item' + (m.fresh ? " is-fresh" : "") + '">' + head + '<div class="fo-nw-meta">' + meta + "</div>" + also + "</li>";
  }

  function panelHtml(model) {
    var note = model.note ? '<div class="fo-nw-note fo-nw-note-' + esc(model.state) + '">' + esc(model.note) +
      (model.state === "unavailable" ? ' <button type="button" class="fo-nw-retry" data-fo-nw-retry>Try again</button>' : "") + "</div>" : "";
    var list = model.items.length ? '<ul class="fo-nw-list">' + model.items.map(itemHtml).join("") + "</ul>" : "";
    var foot = '<div class="fo-nw-foot">' +
      (model.links.player ? '<a href="' + esc(model.links.player) + '" target="_blank" rel="noopener noreferrer">MFL Player News for ' + esc(model.name) + " ↗</a>" : "") +
      (model.links.all ? '<a href="' + esc(model.links.all) + '" target="_blank" rel="noopener noreferrer">See all MFL Player News ↗</a>' : "") + "</div>";
    return note + list + foot;
  }

  function badgeHtml(pid, level, name) {
    if (!level) return "";
    var title = level === "fresh" ? "News from the last 48 hours — tap to open" : "Recent news — tap to open";
    return ' <button type="button" class="fo-nw-icon fo-nw-' + level + '" data-fo-news-pid="' + esc(pid) + '" data-fo-news-name="' + esc(name || "") +
      '" aria-label="' + esc(title) + '" title="' + esc(title) + '"><span aria-hidden="true">📰</span></button>';
  }

  // ── DOM / network (browser only) ───────────────────────────────────────────
  var CFG = { apiUrl: function (p) { return p; }, leagueId: "", season: "", fetch: null };
  var VIEWS = {};          // pid → view from the last roster read
  var HEAD = null;         // feed-level fields of the last read
  var LOADED = false;

  function insideMfl() {
    var N = root.UPS_MFL_NEWS;
    return !!(N && root.location && N.isMflOrigin(root.location.hostname));
  }
  function readFeed(pids) {
    var f = CFG.fetch || root.fetch;
    var url = CFG.apiUrl("/api/news-feed") + "?L=" + encodeURIComponent(CFG.leagueId) + "&YEAR=" + encodeURIComponent(CFG.season) +
      "&limit=10&pids=" + encodeURIComponent(pids.join(","));
    // 503 = no source answered: the body still carries the contract and states.
    return f(url, { credentials: "omit", cache: "no-store" }).then(function (r) {
      if (!r.ok && r.status !== 503) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (j) {
      if (!j || j.contract !== "ups.news.v1" || !j.players) throw new Error("unexpected response");
      return j;
    });
  }
  function loadRoster(pids) {
    var ids = (pids || []).map(String).filter(Boolean);
    var chunks = [];
    for (var i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
    return Promise.all(chunks.map(function (c) { return readFeed(c).catch(function () { return null; }); })).then(function (rs) {
      VIEWS = {}; HEAD = null;
      rs.forEach(function (j) {
        if (!j) return;
        HEAD = HEAD || { feed_state: j.feed_state, sources: j.sources };
        Object.keys(j.players).forEach(function (pid) { VIEWS[pid] = j.players[pid]; });
      });
      LOADED = true;
      return VIEWS;
    });
  }
  function rosterBadge(pid, name) { return badgeHtml(String(pid), badgeLevel(VIEWS[String(pid)], pid), name); }
  function hasBadges() { return Object.keys(VIEWS).some(function (pid) { return !!badgeLevel(VIEWS[pid], pid); }); }

  // Fetch one player's view (fresh read), then fill in MFL headlines when
  // running inside MFL. Calls draw(model) once, and again if MFL text arrives.
  function loadModel(pid, name, draw) {
    var base = { name: name, leagueId: CFG.leagueId, season: CFG.season, insideMfl: insideMfl() };
    return readFeed([String(pid)]).then(function (j) {
      var view = j.players[String(pid)];
      draw(listModel(view, pid, base));
      if (!base.insideMfl || !view || !view.items || !view.items.some(function (it) { return it.via === "MFL" || (it.also_reported_by || []).some(function (a) { return a.via === "MFL"; }); })) return;
      return root.UPS_MFL_NEWS.load(CFG.season, [String(pid)]).then(function (r) {
        if (!r || !r.byArticle) return;   // MFL text unavailable: labels + links stay
        var v2 = Object.assign({}, view, { items: root.UPS_MFL_NEWS.attachText(view.items, r.byArticle) });
        draw(listModel(v2, pid, base));
      });
    }).catch(function () { draw(listModel(null, pid, Object.assign(base, { failed: true }))); });
  }

  var lastFocus = null;
  function close() {
    var el = document.getElementById("fo-nw-overlay");
    if (el) el.parentNode.removeChild(el);
    document.removeEventListener("keydown", onKey, true);
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
  }
  function onKey(e) { if (e.key === "Escape") { e.stopPropagation(); close(); } }
  function open(pid, name) {
    close();
    lastFocus = document.activeElement;
    var disp = displayName(name);
    var wrap = document.createElement("div");
    wrap.id = "fo-nw-overlay";
    wrap.innerHTML = '<div class="fo-nw-backdrop" data-fo-nw-close></div>' +
      '<div class="fo-nw-pop" role="dialog" aria-modal="true" aria-labelledby="fo-nw-title">' +
      '<div class="fo-nw-top"><div><div id="fo-nw-title" class="fo-nw-title">' + esc(disp) + '</div><div class="fo-nw-sub">Player news · last ~7 days · newest first</div></div>' +
      '<button type="button" class="fo-nw-x" data-fo-nw-close aria-label="Close">×</button></div>' +
      '<div class="fo-nw-body"><div class="fo-nw-note">Loading news…</div></div></div>';
    document.body.appendChild(wrap);
    var body = wrap.querySelector(".fo-nw-body");
    var draw = function (model) { if (body.isConnected) body.innerHTML = panelHtml(model); };
    wrap.addEventListener("click", function (e) {
      if (e.target.closest("[data-fo-nw-close]")) { close(); return; }
      if (e.target.closest("[data-fo-nw-retry]")) { body.innerHTML = '<div class="fo-nw-note">Loading news…</div>'; loadModel(pid, name, draw); }
    });
    document.addEventListener("keydown", onKey, true);
    var x = wrap.querySelector(".fo-nw-x"); if (x) x.focus();
    return loadModel(pid, name, draw);
  }
  // The slide-over's News tab: same list, inline. stillCurrent() guards a
  // tab the user has left.
  function renderInto(container, pid, name, stillCurrent) {
    var ok = function () { return container.isConnected && (!stillCurrent || stillCurrent()); };
    container.innerHTML = '<div class="fo-card-head"><h2 style="margin:0;">News</h2></div><div class="fo-nw-tab"><div class="fo-nw-note">Loading news…</div></div>';
    var slot = container.querySelector(".fo-nw-tab");
    var draw = function (model) { if (ok()) slot.innerHTML = panelHtml(model); };
    slot.addEventListener("click", function (e) {   // the slot is new on every render: no stacked listeners
      if (e.target.closest("[data-fo-nw-retry]")) { slot.innerHTML = '<div class="fo-nw-note">Loading news…</div>'; loadModel(pid, name, draw); }
    });
    return loadModel(pid, name, draw);
  }

  var CSS = [
    ".fo-nw-icon{display:inline-flex;align-items:center;justify-content:center;min-width:24px;min-height:24px;padding:0 3px;margin-left:4px;border-radius:6px;border:1px solid transparent;background:transparent;cursor:pointer;vertical-align:middle;font-size:13px;line-height:1}",
    ".fo-nw-icon.fo-nw-fresh{background:rgba(91,141,255,.18);border-color:var(--accent,#5b8dff)}",
    ".fo-nw-icon.fo-nw-older{opacity:.55;filter:grayscale(.6)}",
    ".fo-nw-icon:focus-visible{outline:2px solid var(--accent,#5b8dff);outline-offset:1px}",
    "#fo-nw-overlay{position:fixed;inset:0;z-index:10050}",
    ".fo-nw-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.55)}",
    ".fo-nw-pop{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(560px,calc(100vw - 32px));max-height:min(80vh,720px);display:flex;flex-direction:column;background:var(--panel,#141a26);color:var(--text,#e8edf5);border:1px solid var(--border,#2a3446);border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.5)}",
    ".fo-nw-top{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;padding:14px 16px 10px;border-bottom:1px solid var(--border,#2a3446)}",
    ".fo-nw-title{font-size:16px;font-weight:700}",
    ".fo-nw-sub{font-size:12px;color:var(--muted,#8a97ad);margin-top:2px}",
    ".fo-nw-x{min-width:40px;min-height:40px;border:0;background:transparent;color:var(--text,#e8edf5);font-size:24px;line-height:1;cursor:pointer;border-radius:8px}",
    ".fo-nw-body{overflow:auto;padding:10px 16px 14px;-webkit-overflow-scrolling:touch}",
    ".fo-nw-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}",
    ".fo-nw-item{padding:10px 12px;background:var(--panel-alt,#1a2230);border-radius:8px;border-left:3px solid var(--border,#2a3446)}",
    ".fo-nw-item.is-fresh{border-left-color:var(--accent,#5b8dff)}",
    ".fo-nw-h{display:block;font-size:14px;font-weight:600;line-height:1.4;color:var(--text,#e8edf5);text-decoration:none;overflow-wrap:anywhere}",
    "a.fo-nw-h:hover{text-decoration:underline}",
    ".fo-nw-meta,.fo-nw-also{font-size:12px;color:var(--muted,#8a97ad);margin-top:4px;line-height:1.5;overflow-wrap:anywhere}",
    ".fo-nw-meta a,.fo-nw-also a,.fo-nw-foot a{color:var(--accent,#5b8dff);text-decoration:none}",
    ".fo-nw-ev{display:inline-block;font-size:11px;padding:0 7px;border-radius:999px;background:#22304a;color:#c2d3ee;margin-right:4px}",
    ".fo-nw-note{font-size:13px;line-height:1.45;padding:10px 12px;border-radius:8px;background:var(--panel-alt,#1a2230);border-left:3px solid var(--muted,#8a97ad);margin-bottom:10px}",
    ".fo-nw-note-items,.fo-nw-note-partial{border-left-color:var(--warn,#fbbf24)}",
    ".fo-nw-note-unavailable{border-left-color:#f87171}",
    ".fo-nw-retry{margin-left:6px;min-height:32px;padding:4px 10px;border-radius:6px;border:1px solid var(--border,#2a3446);background:var(--panel,#141a26);color:var(--text,#e8edf5);cursor:pointer}",
    ".fo-nw-foot{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:12px;font-size:13px}",
    "@media (max-width:640px){.fo-nw-pop{left:0;right:0;top:auto;bottom:0;transform:none;width:100%;max-height:85vh;border-radius:14px 14px 0 0;border-bottom:0;padding-bottom:env(safe-area-inset-bottom)}.fo-nw-icon{min-width:32px;min-height:32px}}",
  ].join("\n");
  function injectCss() {
    if (!root.document || document.getElementById("fo-nw-css")) return;
    var s = document.createElement("style"); s.id = "fo-nw-css"; s.textContent = CSS;
    (document.head || document.body).appendChild(s);
  }
  function init(cfg) {
    CFG = Object.assign({}, CFG, cfg || {});
    injectCss();
    return api;
  }

  var api = {
    FRESH_SECONDS: FRESH_SECONDS, WINDOW_SECONDS: WINDOW_SECONDS,
    badgeLevel: badgeLevel, badgeHtml: badgeHtml, listModel: listModel, panelHtml: panelHtml, primaryItems: primaryItems, ago: ago,
    init: init, loadRoster: loadRoster, rosterBadge: rosterBadge, hasBadges: hasBadges, open: open, close: close, renderInto: renderInto,
    isLoaded: function () { return LOADED; }, feedHead: function () { return HEAD; },
  };
  root.UPS_FO_NEWS = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
