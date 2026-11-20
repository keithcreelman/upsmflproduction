/* UPS 2027 Preview 0: the controller. Loads the public reads, draws the screens, handles taps.
   The only things stored on the phone are two display choices (skin, position colors) and the last team viewed. */
(function () {
  "use strict";
  var U = window.UPS2027, cfg = window.UPS2027_CONFIG;
  var appEl = document.getElementById("app");
  var loader = U.data.createLoader(cfg, window.fetch.bind(window));
  var known = {}; // photo addresses that already loaded this visit

  function pref(k, d) { try { var v = localStorage.getItem("ups2027-p0-" + k); return v === null ? d : v; } catch (e) { return d; } }
  function setPref(k, v) { try { localStorage.setItem("ups2027-p0-" + k, v); } catch (e) { /* private window or blocked storage: the choice just is not remembered */ } }

  var S = {
    model: null, load: { core: "loading", coreNotes: [], error: "" }, penalty: { state: "idle" },
    teamId: pref("team", ""), tab: "team", sub: "roster", view: "lineup", open: {}, flags: {},
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
  // While Sample mode is on the page makes no request at all: every read goes through these two guards.
  function loadCore() {
    if (S.sample.on) return Promise.resolve();
    S.load = { core: "loading", coreNotes: [], error: "" };
    render();
    return loader.loadCore().then(function (r) {
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
      var h = hashState();
      var ids = S.model.teams.map(function (t) { return t.id; });
      if (h.t && ids.indexOf(h.t) >= 0) S.teamId = h.t;
      if (ids.indexOf(S.teamId) < 0) S.teamId = ids[0];
      if (h.p) openProfile(h.p, true); else render();
    });
  }

  function loadPenalty(force) {
    if (S.sample.on) return;
    if (!force && (S.penalty.state === "loading" || S.penalty.state === "ok")) return;
    S.penalty = { state: "loading" };
    loader.loadPenalty().then(function (r) { S.penalty = r; render(true); });
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
  appEl.addEventListener("click", function (ev) {
    var el = ev.target.closest ? ev.target.closest("[data-act]") : null;
    if (!el || !appEl.contains(el)) return;
    var act = el.getAttribute("data-act"), v = el.getAttribute("data-v");
    if (act === "nav") { S.tab = v; S.profile = null; S.sheet = null; render(); }
    else if (act === "sub") { S.sub = v; render(); }
    else if (act === "view") { S.view = v; render(); }
    else if (act === "grp") { var g = el.getAttribute("data-g"); S.open[g] = !S.open[g]; render(true); }
    else if (act === "expall") { var keys = groupKeys(), all = keys.every(function (k) { return S.open[k]; }); keys.forEach(function (k) { S.open[k] = !all; }); render(true); }
    else if (act === "card") openProfile(el.getAttribute("data-pid"), false);
    else if (act === "close") closeLayer();
    else if (act === "teams") { S.sheet = "teams"; render(); }
    else if (act === "pickteam") { S.teamId = el.getAttribute("data-fid"); setPref("team", S.teamId); S.open = {}; S.sheet = null; render(); }
    else if (act === "about") { S.sheet = "about"; render(); }
    else if (act === "sample") { S.sample.toggle(); render(true); }
    else if (act === "skin") { S.skin = v; setPref("skin", v); applySkin(); render(true); }
    else if (act === "vib") { S.vib = v; setPref("vib", v); applySkin(); render(true); }
    else if (act === "tog") { S.flags[v] = !S.flags[v]; render(true); }
    else if (act === "ptab") { if (S.profile) { S.profile.tab = v; render(true); } }
    else if (act === "retry") { S.sheet = null; S.penalty = { state: "idle" }; loadCore(); }
    else if (act === "retrypen") loadPenalty(true);
  });
  appEl.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape" && (S.profile || S.sheet)) closeLayer();
  });

  applySkin();
  loadCore();
})();
