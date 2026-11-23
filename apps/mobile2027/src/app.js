/* UPS 2027 Preview 0: the controller. Loads the public reads, draws the screens, handles taps.
   The only things stored on the phone are two display choices (skin, position colors) and the last team viewed. */
(function () {
  "use strict";
  var U = window.UPS2027, cfg = window.UPS2027_CONFIG;
  var appEl = document.getElementById("app");
  // Recorded-data mode (config.js: data "recorded", the committed default): every read is answered from the snapshot bundled with the page
  // (recorded_data.js), by lib/recorded.js, and nothing is requested. `recordedInfo` carries the snapshot's time for the marker at the top.
  var recordedFeed = null, recordedInfo = null;
  if (cfg.data === "recorded") {
    var bundle = window.UPS2027_RECORDED;
    recordedFeed = U.recorded ? U.recorded.createFetch(bundle) : null;
    var recAt = bundle && bundle.meta ? bundle.meta.recordedAt : "";
    recordedInfo = { at: String(recAt || ""), label: U.format.etRecorded(recAt) || "at a time that could not be read", later: "", box: "" };
    // R7: the parts recorded after the league data (game stats, season totals, projections) and their own capture window, from meta.parts
    var parts = bundle && bundle.meta && Array.isArray(bundle.meta.parts) ? bundle.meta.parts.slice(1) : [];
    var lo = null, hi = null;
    parts.forEach(function (pt) {
      if (pt && pt.from && (lo === null || Date.parse(pt.from) < Date.parse(lo))) lo = pt.from;
      if (pt && pt.to && (hi === null || Date.parse(pt.to) > Date.parse(hi))) hi = pt.to;
      if (pt && pt.label === "game stats") recordedInfo.box = U.format.etRange(pt.from, pt.to, true);
    });
    if (lo && hi) recordedInfo.later = U.format.etRange(lo, hi, false);
  }
  // The page's one fetch. It is the loader's only way out, and it refuses outright while Sample mode is on (a third guard,
  // behind the two in loadCore/loadPenalty). In recorded mode it answers from the snapshot and NEVER reaches the network, even when the snapshot
  // is missing (the read then fails like any other failed read). Any data mode but the two known ones is refused. The build scan allows exactly the one
  // network line below and no other reference to fetch.
  function guardedFetch(url, opts) {
    if (S.sample.on) return Promise.reject(new Error("Sample mode: no requests are made"));
    if (cfg.data === "recorded") return recordedFeed ? recordedFeed(url, opts) : Promise.reject(new Error("The recorded data did not load"));
    if (cfg.data !== "live") return Promise.reject(new Error("Unknown data mode: no request is made"));
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
    intel: { status: null, mu: {}, wk: {}, scores: {}, sched: {}, players: null }, // reads added in R2/R3/PR B, by their own address: injury status, NFL games and team history, weekly lineups, weekly player scores, NFL schedules, MFL’s complete player list (positions, clubs and names)
    live: null, // PR B: when every game of the lineup week was first seen final (starts the quiet period of the Final · updating chip)
    ct: { f: "all", s: "exp", y: 0, d: 1, open: {}, bd: false, cat: {}, ns: false }, // Team › Contracts: which group; the sort (exp | sal | name), its salary year (0 to 2) and direction (1 or -1); which rows are open; the cap Breakdown, an open adjustment category, the next-season row
    ns: { state: "idle" }, // next season's recorded cut charges and fines (PR A): read only when the next-season row is opened
    pf: { s: "pos", open: {}, res: {} }, // Team › Performance: the sort (pos | diff | avg), which rows are open, which reserve groups are open
    profile: null, sheet: null, skin: pref("skin", "system"), vib: pref("vib", "1"), build: cfg.build,
    requestLog: loader.log, requestSummary: loader.summary(), recorded: recordedInfo, // recorded: null in live mode, else { at, label } for the marker, Help and About
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
    ensureBreakdowns();
    ensureProjections(false);
    ensureStatPools();
  }

  // ---- R7: the position pool behind the Breakdown's season stat ranks (draft #1515 /api/position-season-stats) ----
  // A drawn season rollup names the pool it needs in data-pss ("2026|10|WR": season, W*, the OPENED player's group). Each pool is asked for once and
  // kept in S.intel.pss[key] = { state, data, at } (the loader keeps it an hour); competitors are never read one by one. A failed pool is asked again
  // only on Try again (Retry). In recorded mode only the Week-10 pools exist; any other is "absent" and the Rank cells read "—".
  function ensureStatPools(force) {
    if (S.sample.on || !S.model || !U.statranks || !U.breakdown) return;
    var keys = {}, C = U.breakdown.cutoffOf(S);
    // the open Breakdowns whose game stats are in (only those draw a season rollup), by the same state ensureBreakdowns reads
    if (C && C.state === "ok" && C.week >= 1) Object.keys(breakdownPids()).forEach(function (pid) {
      var p = S.model.byId[pid], b = S.intel.box && S.intel.box[pid], g = p ? U.statranks.groupOf(p.pos) : "";
      if (g && b && b.state === "ok") keys[U.breakdown.statKey(S, C, g)] = true;
    });
    Array.prototype.forEach.call(appEl.querySelectorAll("[data-pss]") || [], function (el) { var k = el.getAttribute("data-pss"); if (k) keys[k] = true; });   // any other call site
    Object.keys(keys).forEach(function (k) { ensureStatPool(k, force); });
  }
  function ensureStatPool(key, force) {
    var m = /^(\d{4})\|(\d{1,2})\|([A-Z]{2})$/.exec(key);
    if (!m) return;
    S.intel.pss = S.intel.pss || {};
    var rec = S.intel.pss[key];
    if (rec && !(force && rec.state === "error")) return;
    S.intel.pss[key] = { state: "loading" };
    var mine = gen;
    loader.positionSeasonStats(m[1], parseInt(m[2], 10), m[3], !!force).then(function (r) {
      if (mine !== gen || S.sample.on || !S.intel.pss) return;
      S.intel.pss[key] = r.state === "ok" ? { state: "ok", data: r.data, at: r.at || Date.now() } : r.state === "absent" ? { state: "absent" } : { state: "error", error: r.error || "" };
      render(true);
    });
  }

  // ---- R7: the week-labeled projection (draft #1515 /api/player-projections) ----
  // Asked once per team view: the lineup week and this team's ids (tabviews.projectionRequest; the loader splits them into groups of at most 80 and keeps
  // each group's answer for its freshness window). Kept as S.intel.proj[week] = { state, data, at } for tabviews.projectionSlot, which alone decides the
  // value (latest capture before HIS kickoff). Only Team › Performance and a profile's Performance tab draw it. In recorded mode the read is answered
  // from the recording; a route that is not deployed or not recorded comes back "absent" and every card says Not Available.
  function ensureProjections(force) {
    if (S.sample.on || !S.model || !U.tabviews || !U.tabviews.projectionRequest) return;
    if (!((S.tab === "team" && S.sub === "performance") || (S.profile && S.profile.tab === "perf"))) return;
    var q = U.tabviews.projectionRequest(S);
    if (!q || !q.ids.length) return;
    S.intel.proj = S.intel.proj || {};
    var tag = S.teamId + "|" + q.season + "|" + q.week, rec = S.intel.proj[q.week];
    if (rec && S.intel.projTag === tag && !(force && rec.state === "error")) return;
    S.intel.projTag = tag; S.intel.proj[q.week] = { state: "loading" };
    var mine = gen;
    loader.projections(q.season, q.week, q.ids, !!force).then(function (r) {
      if (mine !== gen || S.sample.on || S.intel.projTag !== tag || !S.intel.proj) return;
      S.intel.proj[q.week] = r.state === "ok" ? { state: "ok", data: { ok: true, season: r.data.season, week: r.data.week, provider: r.data.provider, projections: r.data.projections }, at: Date.now() }
        : r.state === "absent" ? { state: "absent" } : { state: "error", error: r.error || "" };
      render(true);
    });
  }

  // ---- R6: the Breakdown's game-stats read (one per player and season) ----
  // Every Breakdown on the screen carries data-bdpid; its player's read is asked for once, kept by the loader and in S.intel.box, and reused across views,
  // tabs and reopening the profile. A failed read is asked again only on Try again. In recorded-data mode the loader answers "absent" with no request.
  function ensureBreakdowns() {
    if (S.sample.on || !S.model) return;
    Object.keys(breakdownPids()).forEach(function (pid) { ensureBox(pid, false); });
  }
  function breakdownPids() {
    var ids = {};
    if (S.profile && S.profile.tab === "perf" && S.profile.pid) ids[S.profile.pid] = true;   // the profile's Performance tab is a Breakdown
    if (S.tab === "team" && S.sub === "performance" && S.pf && S.pf.open) Object.keys(S.pf.open).forEach(function (pid) { if (S.pf.open[pid]) ids[pid] = true; });   // an open Breakdown on a Team › Performance card
    Array.prototype.forEach.call(appEl.querySelectorAll("[data-bdpid]") || [], function (el) { var v = el.getAttribute("data-bdpid"); if (v) ids[v] = true; });   // any other call site
    return ids;
  }
  function ensureBox(pid, force) {
    if (S.sample.on || !S.model || !U.boxlog || !pid) return;
    S.intel.box = S.intel.box || {};
    var rec = S.intel.box[pid];
    if (rec && !(force && rec.state === "error")) return;
    S.intel.box[pid] = { state: "loading" };
    var mine = gen;
    loader.loadWeeklyBox(pid, !!force).then(function (r) {
      if (mine !== gen || S.sample.on) return;
      var next;
      if (r.state === "absent") next = { state: "absent" };
      else if (r.state !== "ok") next = { state: "error", error: r.error || "" };
      else {
        var pb = U.boxlog.parseBox(r.data, pid, parseInt(cfg.season, 10));
        next = pb.state === "ok" ? { state: "ok", data: pb, at: r.at || Date.now() } : { state: "error", error: pb.why || "" };
      }
      S.intel.box = S.intel.box || {};
      S.intel.box[pid] = next;
      render(true);
    });
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
      S.intel = { status: null, mu: {}, wk: {}, scores: {}, sched: {}, players: null, cal: null, reread: {} }; S.wk = null; S.ns = { state: "idle" }; S.live = null;
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
      // Two callers can share one memoized read: the first to resolve fills the holder, and the second finds nothing changed. The follow-up
      // must still run for the second (the owner may have opened Performance while the boot read was in flight), so it is not skipped.
      if (!same(holder[key], next)) { holder[key] = next; render(true); }
      if (after) after(holder[key]);
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
  function ensureScores(L, through, force) {
    if (!(L >= 1) || !U.tabviews) return;
    U.tabviews.weeksFor(L, through).forEach(function (w) {
      intelRead(S.intel.scores, w, function (f) { return loader.loadScores(w, f); }, force && S.intel.scores[w] && S.intel.scores[w].state === "error");
    });
  }
  // The full-season game log reads the weeks the screen did not need, on demand ("Show earlier weeks"), and reuses every read already in memory.
  function ensureLog(force) {
    if (S.sample.on || !S.model || !S.model.week || !U.tabviews) return;
    var C0 = U.tabviews.completion(S); if (C0.state !== "ok") return;   // the log runs through the last all-final week, never the Worker's latestFinalWeek
    var L = C0.week; if (!(L >= 1)) return;
    U.tabviews.logWeeks(L).forEach(function (w) {
      intelRead(S.intel.scores, w, function (f) { return loader.loadScores(w, f); }, force && S.intel.scores[w] && S.intel.scores[w].state === "error");
    });
  }
  // PR B: Team › Performance needs, in order: the matchup read (the Worker's lastCompleteWeek and the team history), the NFL schedule of that week (and of the
  // lineup week) to establish per game which week is complete, then the weekly scores Weeks 1..N for the season totals and the players read for the position
  // pools. Each step asks for its read once (the loader reuses it), and the next step starts when the one before it has arrived. A failed read is asked again
  // only on Retry.
  function ensureSched(w, force) {
    var rec = S.intel.sched[w];
    if (rec && !(force && rec.state === "error")) return; // asked once; the loader keeps the answer. Only Retry asks again after a failure
    intelRead(S.intel.sched, w, function (f) { return loader.loadSchedule(w, U.complete.parseSchedule, f); }, force && rec && rec.state === "error", function () { ensurePerformance(false); });
  }
  function ensureWeekScores(w, force) {
    var rec = S.intel.scores[w], sc = S.intel.sched[w];
    // scores read while the week was still being played (the lineup week, read for its Live chip) are read again once the schedule shows the week final
    if (rec && rec.state === "ok" && sc && sc.state === "ok" && rec.at != null && sc.at != null && rec.at < sc.at && S.intel.reread[w] !== sc.at) {
      S.intel.reread[w] = sc.at;
      intelRead(S.intel.scores, w, function () { return loader.loadScores(w, true); }, true, function () { ensurePerformance(false); });
      return;
    }
    if (rec && !(force && rec.state === "error")) return;
    intelRead(S.intel.scores, w, function (f) { return loader.loadScores(w, f); }, force && rec && rec.state === "error", function () { ensurePerformance(false); });
  }
  function ensureCalendar(force) {
    var rec = S.intel.cal;
    if (rec && !(force && rec.state === "error")) return;
    intelRead(S.intel, "cal", function (f) { return loader.loadCalendar(U.complete.parseCalendar, f); }, force && rec && rec.state === "error", function () { ensurePerformance(false); });
  }
  // MFL's complete player list: names the player on a cap adjustment (Team › Contracts, PR A) and gives the position pools of the ranks (Team › Performance, PR B).
  // One shared read, kept six hours. A failed read is asked again only on Retry (Performance) or, at most once a minute (the loader's own limit), the next time
  // Contracts is opened (`again`).
  function ensurePlayers(force, again) {
    if (S.sample.on || !S.model) return;
    var rec = S.intel.players;
    if (rec && rec.state !== "error") return;
    if (rec && !force && !again) return;
    intelRead(S.intel, "players", function (f) { return loader.loadPlayers(f); }, !!force && !!rec, null);
  }
  function ensurePerformance(force) {
    if (S.sample.on || !S.model || !S.model.week) return;
    var cur = S.model.week, rec = S.intel.mu[cur];
    if (!rec || rec.state !== "ok") {
      // (a read another caller already started is joined, not repeated: the loader shares it, and this follow-up still runs when it arrives)
      intelRead(S.intel.mu, cur, function (f) { return loader.loadMatchups(cur, f); }, force && rec && rec.state === "error", function (next) { if (next && next.state === "ok") ensurePerformance(false); });
      return;
    }
    var lc = rec.data.lastComplete;
    if (!(lc >= 1)) return;
    ensureCalendar(force);   // MFL's club list, byes and the whole season's schedule: what every week is checked against
    ensureSched(lc, force);
    if (cur !== lc) ensureSched(cur, force);
    var C0 = U.tabviews.completion(S);
    if (C0.state === "loading" && C0.need) ensureSched(C0.need, force);   // the week before is read only when the cutoff has to step back (the schedule and the Worker's statuses together say so)
    if (C0.state === "ok") {
      for (var w = 1; w <= C0.week; w++) ensureWeekScores(w, force);
      if (cur > C0.week) ensureWeekScores(cur, force);
      ensurePlayers(force);
      var sc = S.intel.sched[cur];
      if (sc && sc.state === "ok" && U.complete.weekComplete(sc.data.games, null, U.tabviews.coverFor(S, cur)) && !(S.live && S.live.allFinalAt != null)) S.live = { allFinalAt: Date.now() }; // the first time every game of the lineup week is seen final (the quiet period starts here)
    }
  }
  // Retry. When a read failed, only the reads that failed are asked again. When nothing failed (a "Final · not yet in season totals" chip has nothing to
  // re-ask), the answers the display waits on (the matchup, the schedule of the lineup week and the calendar) are asked again; the lineup week's scores are then
  // read again once, after the new schedule (ensureWeekScores), never in parallel with it.
  function anyFailedRead() {
    var any = false;
    [S.intel.mu, S.intel.sched, S.intel.scores].forEach(function (h) { Object.keys(h || {}).forEach(function (k) { if (h[k] && h[k].state === "error") any = true; }); });
    return any || !!(S.intel.players && S.intel.players.state === "error") || !!(S.intel.cal && S.intel.cal.state === "error");
  }
  function refreshPerformance() {
    if (S.sample.on || !S.model || !S.model.week) return;
    ensureProjections(true); ensureStatPools(true);   // only a failed projection read or pool is asked again
    if (anyFailedRead()) { ensurePerformance(true); return; }
    var cur = S.model.week, after = function () { ensurePerformance(false); };
    intelRead(S.intel.mu, cur, function () { return loader.loadMatchups(cur, true); }, true, after);
    intelRead(S.intel.sched, cur, function () { return loader.loadSchedule(cur, U.complete.parseSchedule, true); }, true, after);
    intelRead(S.intel, "cal", function () { return loader.loadCalendar(U.complete.parseCalendar, true); }, true, after);   // an unfinished older game may have been played since
    ensurePerformance(true);
  }
  function ensureIntel(force) {
    if (S.sample.on || !S.model || S.tab !== "team") return;
    if (S.sub === "contracts") { // the table paints first; the guarantee column loads second; a failed read is asked again only on Try again
      if (S.ct && S.ct.ns && S.ns.state === "idle") loadNext(false); // the row is open and nothing is in flight (a reload or Sample mode dropped the answer)
      if (S.penalty.state === "idle") loadPenalty(false); else if (force && S.penalty.state === "error") loadPenalty(true);
      ensurePlayers(false, true);
      return;
    }
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

  // Next season's ledger: parsed the moment it arrives, for every team, keeping only the allowlisted fields (category, signed amount, season, and a
  // player only when his id resolves). The answer itself is dropped; nothing from it is stored on the phone.
  function loadNext(force) {
    if (S.sample.on || !S.model) return;
    if (!force && (S.ns.state === "loading" || S.ns.state === "ok")) return;
    S.ns = { state: "loading" }; render(true);
    var mine = gen;
    loader.loadNextSeason(!!force).then(function (r) {
      if (mine !== gen || S.sample.on) { if (S.ns.state === "loading") S.ns = { state: "idle" }; return; }
      if (r.state !== "ok") { S.ns = { state: "error", why: "read" }; return render(true); }
      var season = S.model.season + 1, resolveName = U.adjust.nameResolver(S.model, null), by = {}, bad = false;
      S.model.teams.forEach(function (t) {
        var p = U.adjust.parseNextSeason(r.data, { fid: t.id, season: season, resolveName: resolveName });
        if (p.state !== "ok") bad = p.why || "unexpected"; else by[t.id] = p;
      });
      S.ns = bad ? { state: "error", why: bad } : { state: "ok", at: r.at, by: by };
      render(true);
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
  // R6: the Lineup view's three section cards (Bench, Injured reserve, Taxi squad), each collapsed or expanded by its own heading
  function groupKeys() {
    var t = S.model && S.model.teams.filter(function (x) { return x.id === S.teamId; })[0];
    return t ? ["bench", "ir", "taxi"] : [];
  }
  // Sample mode: turning it on drops anything in flight and closes an open profile (no league data is drawn);
  // turning it off reloads whatever the real screens still need, so nothing is left loading or empty.
  // A read that Sample mode dropped leaves its holder at "loading" with nothing in flight: forget those records so the screen asks again.
  function dropLoading() {
    Object.keys(S.intel || {}).forEach(function (k) {
      var v = S.intel[k];
      if (v && v.state === "loading") S.intel[k] = null;
      else if (v && typeof v === "object" && !v.state) Object.keys(v).forEach(function (w) { if (v[w] && v[w].state === "loading") delete v[w]; });
    });
    if (S.ns && S.ns.state === "loading") S.ns = { state: "idle" };
  }
  function toggleSample() {
    gen++;
    dropLoading();
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
    else if (act === "cts") { var nx = U.tabviews.ctNextSort(S.ct, v); S.ct.s = nx.s; S.ct.d = nx.d; render(true); }   // a new sort starts in its own direction; the same sort again reverses it
    else if (act === "cty") { var yy = parseInt(v, 10); if (yy >= 0 && yy <= 2) { S.ct.y = yy; render(true); } }
    else if (act === "ctx") { S.ct.open[v] = !S.ct.open[v]; render(true); }
    else if (act === "ctbd") { S.ct.bd = !S.ct.bd; render(true); }
    else if (act === "ctcat") { S.ct.cat[v] = !S.ct.cat[v]; render(true); }
    else if (act === "nsx") { S.ct.ns = !S.ct.ns; render(true); if (S.ct.ns) loadNext(false); }
    else if (act === "retryns") { loadNext(true); }
    else if (act === "help") { S.sheet = "help"; render(); }
    else if (act === "pfs") { S.pf.s = v; render(true); }
    else if (act === "pfx") { S.pf.open[v] = !S.pf.open[v]; render(true); }
    else if (act === "pfres") { S.pf.res[v] = !S.pf.res[v]; render(true); }
    else if (act === "retryperf") { refreshPerformance(); }
    else if (act === "logmore") { if (S.profile) { S.profile.all = true; render(true); ensurePerformance(); ensureLog(); } }
    else if (act === "logless") { if (S.profile) { S.profile.all = false; render(true); } }
    else if (act === "retrylog") { ensureLog(true); }
    else if (act === "bdv") { var bp = el.getAttribute("data-pid"); S.bd = S.bd || { v: {}, g: {} }; if (bp && /^[a-z]+$/.test(v || "")) { S.bd.v[bp] = v; render(true); } }   // R6: a Breakdown view
    else if (act === "bdg") { var gp = el.getAttribute("data-pid"), gw = parseInt(v, 10); S.bd = S.bd || { v: {}, g: {} }; if (gp && gw >= 1) { S.bd.g[gp] = S.bd.g[gp] === gw ? null : gw; render(true); } }   // R6: one game's detail opens or closes
    else if (act === "retrybox") { ensureBox(el.getAttribute("data-pid"), true); }
    else if (act === "pickweek") {
      var n = parseInt(v, 10), wi0 = U.roster.weekInfo(S);
      if (isFinite(n) && wi0.cur && n >= 1 && n <= wi0.cur) { var again = n === wi0.sel; S.wk = n === wi0.cur ? null : n; S.sheet = null; render(); ensureIntel(again); }
    }
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
