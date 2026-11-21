/* UPS 2027 Preview 0: the controller. Loads the public reads, draws the screens, handles taps.
   The only things stored on the phone are two display choices (skin, position colors) and the last team viewed. */
(function () {
  "use strict";
  var U = window.UPS2027, cfg = window.UPS2027_CONFIG;
  var appEl = document.getElementById("app");
  // The page's one fetch. It is the loader's only way out, and it refuses outright while Sample mode is on (a third guard,
  // behind the two in loadCore/loadPenalty). The build scan allows exactly this line and no other reference to fetch.
  function guardedFetch(url, opts) {
    if (S.sample.on) return Promise.reject(new Error("Sample mode: no requests are made"));
    return window.fetch(url, opts);
  }
  var loader = U.data.createLoader(cfg, guardedFetch);
  var known = {}; // photo addresses that already loaded this visit
  var gen = 0; // bumped whenever Sample mode changes or a load starts, so a read that finishes late is dropped

  function pref(k, d) { try { var v = localStorage.getItem("ups2027-p0-" + k); return v === null ? d : v; } catch (e) { return d; } }
  function setPref(k, v) { try { localStorage.setItem("ups2027-p0-" + k, v); } catch (e) { /* private window or blocked storage: the choice just is not remembered */ } }

  var S = {
    model: null, load: { core: "loading", coreNotes: [], error: "" }, penalty: { state: "idle" },
    teamId: pref("team", ""), tab: "team", sub: "roster", view: "lineup", open: {}, flags: {},
    wk: null, // the week on screen; null means the current lineup week. Only a past week ever changes it (view-only)
    intel: { status: null, mu: {}, wk: {}, scores: {} }, // reads added in R2/R3, by their own address: injury status, NFL games and season figures, weekly lineups, weekly player scores
    ct: { f: "all", s: "end", open: {} }, // Team › Contracts: which group, sort, and which rows are open
    pf: { f: "all", s: "pos", open: {}, res: {} }, // Team › Performance: the same
    gdef: pref("gdef", "needs"),
    profile: null, sheet: null, skin: pref("skin", "system"), vib: pref("vib", "1"), build: cfg.build,
    requestLog: loader.log, requestSummary: loader.summary(),
    sample: U.sample.create() // Sample mode: client-only, labeled, off at every start (it is never stored)
  };

  // ---- display choices ----
  var mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  function applySkin() {
    var skin = S.skin;
    if (skin === "system") skin = mq && mq.matches ? "dark" : "light";
    document.documentElement.setAttribute("data-skin", skin);
    document.documentElement.setAttribute("data-vib", S.vib === "0" ? "0" : "1");
  }
  if (mq && mq.addEventListener) mq.addEventListener("change", function () { if (S.skin === "system") applySkin(); });

  // ---- drawing ----
  function focusKey() {
    var a = document.activeElement;
    if (!a || !a.getAttribute || !appEl.contains(a)) return null;
    var act = a.getAttribute("data-act");
    if (!act) return null;
    var sel = '[data-act="' + act + '"]';
    ["data-v", "data-g", "data-pid", "data-fid"].forEach(function (k) { var v = a.getAttribute(k); if (v != null) sel += "[" + k + '="' + v + '"]'; });
    return sel;
  }
  function render(keepFocus) {
    var scr = document.getElementById("screen"), sheet = appEl.querySelector(".sheet");
    var scrTop = scr ? scr.scrollTop : 0, sheetTop = sheet ? sheet.scrollTop : 0, hadSheet = !!sheet;
    var again = keepFocus ? focusKey() : null; // a toggle or tab that was just tapped keeps keyboard focus after the redraw
    S.requestSummary = loader.summary();
    appEl.innerHTML = U.views.app(S);
    var scr2 = document.getElementById("screen"); if (scr2) scr2.scrollTop = scrTop;
    var sheet2 = appEl.querySelector(".sheet");
    if (sheet2) { if (hadSheet) sheet2.scrollTop = sheetTop; if (!keepFocus || !hadSheet) sheet2.focus({ preventScroll: true }); }
    if (again) { var f = appEl.querySelector(again); if (f && f.focus) f.focus({ preventScroll: true }); }
    Array.prototype.forEach.call(appEl.querySelectorAll("img[data-chain]"), function (img) {
      var urls = []; try { urls = JSON.parse(img.getAttribute("data-chain")) || []; } catch (e) { urls = []; }
      U.photo.attach(img, urls, function (src) { S.photoSource = S.photoSource || {}; S.photoSource[img.getAttribute("data-chain")] = src; }, known);
    });
    document.title = S.profile && S.model && S.model.byId[S.profile.pid] ? S.model.byId[S.profile.pid].name + " · UPS Preview 0" : "UPS 2027 Preview 0";
  }

  // ---- loading ----
  // While Sample mode is on the page starts no new request: every read goes through these two guards (and Sample screens draw no image,
  // so the browser fetches no photo). A read already out is not recalled; its answer is dropped by the generation check below.
  function loadCore() {
    if (S.sample.on) return Promise.resolve();
    var mine = ++gen;
    S.load = { core: "loading", coreNotes: [], error: "" };
    render();
    return loader.loadCore().then(function (r) {
      if (mine !== gen || S.sample.on) return; // Sample mode was switched on (or a newer load started) while this read was out
      var rw = r.roster.state === "ok" ? r.roster.data : null;
      if (!rw || rw.ok !== true || !Array.isArray(rw.teams) || !rw.teams.length) {
        S.load = { core: "error", coreNotes: [], error: r.roster.state === "ok" ? "The league data came back in an unexpected shape." : r.roster.error };
        return render();
      }
      var notes = [];
      if (r.league.state !== "ok") notes.push("League roster limits did not load, so counts show without limits (" + r.league.error + ").");
      if (!r.week) notes.push("The current lineup week could not be read, so no starters are shown.");
      else if (r.weekly.state !== "ok") notes.push("MFL’s submitted lineups could not be read (" + r.weekly.error + ").");
      S.model = U.model.build(rw, r.league.state === "ok" ? r.league.data : null, r.weekly.state === "ok" ? r.weekly.data : null, r.week, parseInt(cfg.season, 10));
      S.load = { core: notes.length ? "partial" : "ok", coreNotes: notes, error: "" };
      S.intel = { status: null, mu: {}, wk: {}, scores: {} }; S.wk = null;
      if (r.week && r.weekly.state === "ok") S.intel.wk[r.week] = { state: "ok", data: r.weekly.data, at: Date.now() };
      var h = hashState();
      var ids = S.model.teams.map(function (t) { return t.id; });
      if (h.t && ids.indexOf(h.t) >= 0) S.teamId = h.t;
      if (ids.indexOf(S.teamId) < 0) S.teamId = ids[0];
      if (h.p) openProfile(h.p, true); else render();
      ensureIntel();
    });
  }

  // ---- the reads Team › Roster adds (injury status, NFL games, other weeks' lineups and scores) ----
  // Each is asked for by its exact address, once; the loader keeps the answer and gives it back when the view, the week or the
  // team changes. It asks again only after Reload, or when its freshness limit has passed and the screen is used again.
  function same(a, b) { return !!a && !!b && a.state === b.state && a.at === b.at; }
  function intelRead(holder, key, ask, force, after) {
    var mine = gen;
    if (!holder[key]) holder[key] = { state: "loading" };
    ask(force).then(function (r) {
      if (mine !== gen || S.sample.on) return;
      var next = r.state === "ok" ? { state: "ok", data: r.data, at: r.at || Date.now() } : { state: "error", error: r.error || "" };
      if (same(holder[key], next)) return;
      holder[key] = next; render(true);
      if (after) after(next);
    });
  }
  // The injury read is shared by Roster and Performance (the chips on a row). Asked once and reused by the loader.
  function ensureStatus(force) {
    if (!S.intel.status) S.intel.status = { state: "loading" };
    var mine = gen;
    loader.loadStatus(force && S.intel.status.state === "error").then(function (r) {
      if (mine !== gen || S.sample.on) return;
      var next = r.state === "ok" ? { state: "ok", data: r.data, at: r.at } : { state: "error", error: r.error || "" };
      if (same(S.intel.status, next)) return;
      S.intel.status = next; render(true);
    });
  }
  // Team › Performance (and a profile's game log): the current week's matchup read (season totals, latest final week, team history, next three
  // weeks), then the weekly scores of the latest final week and the three before it, at most four reads.
  function ensureScores(L, force) {
    if (!(L >= 1) || !U.tabviews) return;
    U.tabviews.weeksFor(L).forEach(function (w) {
      intelRead(S.intel.scores, w, function (f) { return loader.loadScores(w, f); }, force && S.intel.scores[w] && S.intel.scores[w].state === "error");
    });
  }
  function ensurePerformance(force) {
    if (S.sample.on || !S.model || !S.model.week) return;
    var cur = S.model.week, rec = S.intel.mu[cur];
    intelRead(S.intel.mu, cur, function (f) { return loader.loadMatchups(cur, f); }, force && rec && rec.state === "error", function (next) { if (next.state === "ok") ensureScores(next.data.latestFinal, force); });
    if (rec && rec.state === "ok") ensureScores(rec.data.latestFinal, force);
  }
  function ensureIntel(force) {
    if (S.sample.on || !S.model || S.tab !== "team") return;
    if (S.sub === "contracts") { loadPenalty(!!force && S.penalty.state === "error"); return; } // the table paints first; the guarantee column loads second
    if (S.sub === "performance") { ensureStatus(force); ensurePerformance(force); return; }
    if (S.sub !== "roster") return;
    var wi = U.roster.weekInfo(S);
    if (!wi.cur) return;
    var historical = wi.past && S.view === "lineup";
    if (historical) {
      // a past week needs only its own lineups and scores; its NFL games are not asked for (see MAT-1 in views.js: no read says which club a player was with then)
      intelRead(S.intel.wk, wi.sel, function (f) { return loader.loadWeekly(wi.sel, f); }, force && S.intel.wk[wi.sel] && S.intel.wk[wi.sel].state === "error");
      return;
    }
    // current information: injury status and this week's games
    ensureStatus(force);
    intelRead(S.intel.mu, wi.cur, function (f) { return loader.loadMatchups(wi.cur, f); }, force && S.intel.mu[wi.cur] && S.intel.mu[wi.cur].state === "error");
  }

  function loadPenalty(force) {
    if (S.sample.on) return;
    if (!force && (S.penalty.state === "loading" || S.penalty.state === "ok")) return;
    S.penalty = { state: "loading" };
    var mine = gen;
    loader.loadPenalty().then(function (r) {
      if (mine !== gen || S.sample.on) { if (S.penalty.state === "loading") S.penalty = { state: "idle" }; return; }
      S.penalty = r; render(true);
    });
  }

  // ---- routing: the address only records the open profile, so Back closes it ----
  function hashState() {
    var o = { p: "", t: "" };
    try { var sp = new URLSearchParams(location.hash.replace(/^#/, "")); o.p = (sp.get("p") || "").replace(/\D/g, ""); o.t = (sp.get("t") || "").replace(/\D/g, ""); } catch (e) { /* ignore */ }
    return o;
  }
  function openProfile(pid, fromAddress) {
    var p = S.model && S.model.byId[pid];
    S.lastFocusPid = pid;
    S.profile = { pid: String(pid), tab: "contract" };
    S.flags = {};
    if (p && p.franchiseId) { S.teamId = p.franchiseId; }
    if (!fromAddress) { try { history.pushState({ p: pid }, "", "#p=" + encodeURIComponent(pid)); } catch (e) { /* ignore */ } }
    render();
    loadPenalty(false);
  }
  function closeLayer() {
    var wasProfile = !!S.profile;
    S.profile = null; S.sheet = null;
    render(); // draw now; the popstate that history.back() causes only has to find nothing left to close
    restoreFocus();
    if (wasProfile && history.state && history.state.p) { history.back(); return; }
    if (wasProfile) { try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { /* ignore */ } }
  }
  function restoreFocus() {
    if (!S.lastFocusPid) return;
    var b = appEl.querySelector('[data-act="card"][data-pid="' + S.lastFocusPid + '"]');
    if (b) b.focus({ preventScroll: true });
  }
  window.addEventListener("popstate", function () {
    var h = hashState();
    if (h.p) { if (!S.profile || S.profile.pid !== h.p) { S.profile = { pid: h.p, tab: "contract" }; S.flags = {}; render(); loadPenalty(false); } }
    else { var open = !!(S.profile || S.sheet); S.profile = null; S.sheet = null; if (open) { render(); restoreFocus(); } }
  });

  // ---- taps ----
  function groupKeys() {
    var t = S.model && S.model.teams.filter(function (x) { return x.id === S.teamId; })[0];
    if (!t) return [];
    return U.model.benchGroups(t).map(function (g) { return "b" + g.pos; }).concat(["ir", "taxi"]);
  }
  // Sample mode: turning it on drops anything in flight and closes an open profile (no league data is drawn);
  // turning it off reloads whatever the real screens still need, so nothing is left loading or empty.
  function toggleSample() {
    gen++;
    S.sample.toggle();
    if (S.sample.on) {
      S.profile = null;
      if (S.penalty.state === "loading") S.penalty = { state: "idle" };
      if (S.load.core === "loading") S.load = { core: "loading", coreNotes: [], error: "" };
      render(true);
      return;
    }
    loader.clearErrors();
    if (!S.model || S.load.core === "loading" || S.load.core === "error") { loadCore(); return; }
    render(true);
    ensureIntel();
  }
  appEl.addEventListener("click", function (ev) {
    var el = ev.target.closest ? ev.target.closest("[data-act]") : null;
    if (!el || !appEl.contains(el)) return;
    var act = el.getAttribute("data-act"), v = el.getAttribute("data-v");
    if (act === "nav") { S.tab = v; S.profile = null; S.sheet = null; render(); ensureIntel(); }
    else if (act === "sub") { S.sub = v; render(); ensureIntel(); }
    else if (act === "view") { if (v === "lineup" || v === "byes") { S.view = v; S.sheet = null; render(); ensureIntel(); } }
    else if (act === "weeks") { S.sheet = "weeks"; render(); }
    else if (act === "ctf") { S.ct.f = v; render(true); }
    else if (act === "cts") { S.ct.s = v; render(true); }
    else if (act === "ctx") { S.ct.open[v] = !S.ct.open[v]; render(true); }
    else if (act === "pff") { S.pf.f = v; render(true); }
    else if (act === "pfs") { S.pf.s = v; render(true); }
    else if (act === "pfx") { S.pf.open[v] = !S.pf.open[v]; render(true); }
    else if (act === "pfres") { S.pf.res[v] = !S.pf.res[v]; render(true); }
    else if (act === "retryperf") { ensurePerformance(true); }
    else if (act === "pickweek") {
      var n = parseInt(v, 10), wi0 = U.roster.weekInfo(S);
      if (isFinite(n) && wi0.cur && n >= 1 && n <= wi0.cur) { var again = n === wi0.sel; S.wk = n === wi0.cur ? null : n; S.sheet = null; render(); ensureIntel(again); }
    }
    else if (act === "gdef") { S.gdef = v === "all" ? "all" : "needs"; setPref("gdef", S.gdef); S.open = {}; render(true); }
    else if (act === "grp") { var g = el.getAttribute("data-g"); S.open[g] = !U.views.isOpen(S, g); render(true); }
    else if (act === "expall") { var keys = groupKeys(), all = keys.every(function (k) { return U.views.isOpen(S, k); }); keys.forEach(function (k) { S.open[k] = !all; }); render(true); }
    else if (act === "card") openProfile(el.getAttribute("data-pid"), false);
    else if (act === "close") closeLayer();
    else if (act === "teams") { S.sheet = "teams"; render(); }
    else if (act === "pickteam") { S.teamId = el.getAttribute("data-fid"); setPref("team", S.teamId); S.open = {}; S.sheet = null; render(); }
    else if (act === "about") { S.sheet = "about"; render(); }
    else if (act === "sample") { toggleSample(); }
    else if (act === "skin") { S.skin = v; setPref("skin", v); applySkin(); render(true); }
    else if (act === "vib") { S.vib = v; setPref("vib", v); applySkin(); render(true); }
    else if (act === "tog") { S.flags[v] = !S.flags[v]; render(true); }
    else if (act === "ptab") { if (S.profile) { S.profile.tab = v; render(true); if (v === "perf") ensurePerformance(); } }
    else if (act === "retry") { S.sheet = null; S.penalty = { state: "idle" }; loadCore(); }
    else if (act === "retrypen") loadPenalty(true);
  });
  appEl.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape" && (S.profile || S.sheet)) closeLayer();
  });

  applySkin();
  loadCore();
})();
