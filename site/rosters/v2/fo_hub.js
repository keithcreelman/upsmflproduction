/* Front Office views — shared helpers for the destinations added in #1338
   (Overview, Bye planner, Market, Trades, Draft picks, Activity).

   Reads only: window.UPS_FO (what front_office.js has loaded — rosters,
   contracts, cap, the viewer), window.UPS_FO_DATA (one read per source per
   visit) and the shared pure modules. Nothing here writes or posts.
   Plain script; attaches window.UPS_FO_HUB.
*/
(function (root) {
  "use strict";

  function FO() { return root.UPS_FO || null; }
  function D() { return root.UPS_FO_DATA || null; }
  function str(v) { return v == null ? "" : String(v).trim(); }
  function esc(v) {
    return str(v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  }
  function pad4(v) { var d = str(v).replace(/\D/g, ""); return d ? ("0000" + d).slice(-4) : ""; }
  function fmt1(v) { return v == null || !isFinite(Number(v)) ? "—" : (Math.round(Number(v) * 10) / 10).toFixed(1); }
  function signed1(v) { if (v == null || !isFinite(Number(v))) return "—"; var n = Math.round(Number(v) * 10) / 10; return (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toFixed(1); }
  function money(v) {
    var f = FO();
    if (f && f.fmtUSD) return f.fmtUSD(v);
    var n = Math.round(Number(v) || 0);
    return (n < 0 ? "−$" : "$") + Math.abs(n).toLocaleString("en-US");
  }
  function clock(ms) {
    if (!(ms > 0)) return "";
    var d = new Date(ms), h = d.getHours(), m = d.getMinutes();
    return ((h % 12) || 12) + ":" + (m < 10 ? "0" : "") + m + " " + (h < 12 ? "AM" : "PM");
  }
  function dayLabel(ms) {
    if (!(ms > 0)) return "";
    try { return new Date(ms).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }); } catch (e) { return ""; }
  }
  function asArray(x) { return x == null ? [] : (Array.isArray(x) ? x : [x]); }

  // ── Players and owners ──────────────────────────────────────────────
  var idx = { src: null, byPid: {} };
  // Every MFL player { name, pos, team } from the players export (name "Last, First").
  function playerIndex() {
    var d = D(), e = d && d.get("players");
    var src = e && e.state === "ok" ? e.data : null;
    if (src === idx.src) return idx.byPid;
    var out = {};
    asArray(src && src.players && src.players.player).forEach(function (p) {
      if (p && p.id) out[String(p.id)] = { name: str(p.name), pos: str(p.position).toUpperCase(), team: str(p.team).toUpperCase() };
    });
    idx = { src: src, byPid: out };
    return out;
  }
  // { pid: { fid, teamName, p } } for every rostered player Front Office loaded (all 12 teams).
  function rosterIndex() {
    var f = FO(), out = {};
    ((f && f.teams()) || []).forEach(function (t) {
      (t.players || []).forEach(function (p) { out[String(p.id)] = { fid: t.fid, teamName: t.name, p: p }; });
    });
    return out;
  }
  function teamName(fid) {
    var f = FO(), t = ((f && f.teams()) || []).filter(function (x) { return x.fid === pad4(fid); })[0];
    return t ? t.name : (fid ? "Team " + pad4(fid) : "");
  }
  function groupOf(pid) {
    var L = root.UPS_FRONT_OFFICE_LINEUP;
    var r = rosterIndex()[String(pid)];
    var pos = r ? r.p.position : (playerIndex()[String(pid)] || {}).pos;
    var g = L ? L.posGroup(str(pos).toUpperCase()) : "";
    return g && g !== "OTH" ? g : "";
  }
  function displayName(name) {
    var n = str(name);
    var i = n.indexOf(",");
    return i > 0 ? (n.slice(i + 1).trim() + " " + n.slice(0, i).trim()) : n;
  }

  // ── Values: season PPG per MFL-scored week (the backtested default, #1338) ──
  function scoring() {
    var d = D(), e = d && d.get("scores");
    return e && e.state === "ok" && e.data && e.data.known ? e.data : null;
  }
  // { pid: ppg } for the season (n = 0) or the last n FINAL weeks.
  function values(n) {
    var ss = scoring();
    if (!ss) return {};
    var src = ss.windowFor(n || 0), out = {};
    Object.keys(src).forEach(function (pid) { if (src[pid].games > 0) out[pid] = src[pid].ppg; });
    return out;
  }
  // A PPG rank counts every player MFL scored at the position, free agents included, so it needs MFL's players
  // list. groupFn() is a new function whenever the rosters or that list change, so a rank map built before the
  // list arrived is never reused after it (Market opened after Roster showed every free agent "unranked").
  var gFn = { teams: null, n: -1, players: null, fn: null };
  function groupFn() {
    var f = FO(), teams = (f && f.teams()) || [];
    var n = teams.reduce(function (a, t) { return a + (t.players || []).length; }, 0);
    playerIndex();
    if (!gFn.fn || gFn.teams !== teams || gFn.n !== n || gFn.players !== idx.src) {
      gFn = { teams: teams, n: n, players: idx.src, fn: function (pid) { return groupOf(pid); } };
    }
    return gFn.fn;
  }
  function playersState() { var d = D(), e = d && d.get("players"); return e ? e.state : ""; }
  // Until the players list is read (or if it fails) no rank is shown, never a rank among rostered players only.
  function seasonLine(pid, last) {
    var F = root.UPS_PLAYER_FACTS, ss = scoring();
    if (!F || !ss) return null;
    var line = F.season(ss, pid, groupFn(), { last: last || 0 });
    var ps = playersState();
    if (line && ps !== "ok") {
      line.rank = null;
      line.rankLabel = line.games > 0 && ps !== "error" ? "…" : "—";
      if (line.last) line.last.rank = null;
    }
    return line;
  }

  // Front Office rows → the shapes the shared models take (trade_fit / bye_planner).
  function modelTeams() {
    var f = FO();
    return ((f && f.teams()) || []).map(function (t) {
      return { fid: t.fid, name: t.name, players: (t.players || []).map(function (p) {
        var res = f.injury ? f.injury(p) : null;
        return { pid: String(p.id), name: p.name, pos: p.position, status: p.isTaxi ? "TAXI_SQUAD" : (p.isIr ? "INJURED_RESERVE" : "ROSTER"),
          chip: res && res.chips && res.chips[0] ? res.chips[0].t : "", nflTeam: p.nflTeam, salary: p.salary, years: p.years, type: p.type };
      }) };
    });
  }
  // Every MFL-scored player on no roster (the free-agent pool for replacement level and bye options).
  function freeAgents() {
    var ss = scoring(), rost = rosterIndex(), pidx = playerIndex(), out = [];
    if (!ss) return out;
    Object.keys(ss.byPid).forEach(function (pid) {
      if (rost[pid]) return;
      var pl = pidx[pid];
      if (pl) out.push({ pid: pid, pos: pl.pos, nflTeam: pl.team, name: pl.name });
    });
    return out;
  }

  // The league trade-fit model on season PPG (n = 0) or last-n-weeks values, rebuilt only when an input changed
  // (scores read, players read, rosters, injury read) — Overview and Trades share it.
  var modelMemo = {};
  function leagueModel(n) {
    var TF = root.UPS_TRADE_FIT, ss = scoring(), f = FO(), d = D();
    if (!TF || !ss || !f) return null;
    var teams = f.teams();
    var inj = d && d.injury ? d.injury() : null;
    var key = [ss.fetchedAt, idx.src ? 1 : 0, teams.length, teams.reduce(function (a, t) { return a + (t.players || []).length; }, 0), inj && inj.at || 0, n || 0].join("|");
    if (modelMemo[n || 0] && modelMemo[n || 0].key === key) return modelMemo[n || 0].model;
    playerIndex();
    var model = TF.buildLeague({ teams: modelTeams(), values: values(n || 0), freeAgents: freeAgents() });
    modelMemo[n || 0] = { key: key, model: model };
    return model;
  }

  // ── UI bits ────────────────────────────────────────────────────────
  function playerButton(pid, fid, label, extraClass) {
    return '<button type="button" class="fo-plink' + (extraClass ? " " + extraClass : "") + '" data-fo-player="' + esc(pid) + '" data-fo-fid="' + esc(fid || "") + '">' + esc(label) + "</button>";
  }
  function goLink(section, label) {
    return '<button type="button" class="fo-go" data-fo-go="' + esc(section) + '">' + esc(label) + " ›</button>";
  }
  // One delegated click handler for the new views: players open the same slide-over (rostered) or the shared
  // popup (free agents); "go" buttons switch destination.
  function wireClicks(el) {
    if (!el || el.__foWired) return;
    el.__foWired = true;
    el.addEventListener("click", function (e) {
      var t = e.target && e.target.closest ? e.target.closest("[data-fo-player],[data-fo-go]") : null;
      if (!t) return;
      var f = FO();
      if (t.hasAttribute("data-fo-go")) { if (f && f.show) f.show(t.getAttribute("data-fo-go")); return; }
      var pid = t.getAttribute("data-fo-player"), fid = t.getAttribute("data-fo-fid");
      if (fid && f && f.openPlayer) { f.openPlayer(pid, fid, t.getAttribute("data-fo-tab") || "stats"); return; }
      if (typeof root.UPS_openPlayerProfile === "function") {
        var pl = playerIndex()[pid] || {};
        root.UPS_openPlayerProfile(pid, { apiBase: f ? f.workerBase : "", leagueId: f ? f.leagueId : "", year: f ? f.season : "",
          playerInfo: { name: pl.name, position: pl.pos, team: pl.team }, mode: "front_office" });
      }
    });
  }
  function injuryChip(p) {
    var f = FO(), F = root.UPS_PLAYER_FACTS;
    var res = f && f.injury ? f.injury(p) : null;
    return res && F ? F.chipHtml(res, esc, "fo-inj") : "";
  }
  function setFreshness(text) {
    var el = document.getElementById("fo-freshness");
    if (el) el.textContent = text || "";
  }
  function loading(el, text) { if (el) el.innerHTML = '<div class="fo-table-loading">' + esc(text) + "</div>"; }
  function banner(text, kind) { return text ? '<div class="fo-banner ' + (kind || "") + '" role="note">' + esc(text) + "</div>" : ""; }

  // ── About these numbers ───────────────────────────────────────────
  var about = {};
  function registerAbout(section, html) { about[section] = html; }
  function openAbout(section) {
    var html = about[section] || about["*"] || "";
    openDialog("About these numbers", html + (section !== "*" && about["*"] ? '<hr class="fo-about-hr">' + about["*"] : ""));
  }
  // The About dialog's frame (focus trap, Escape, backdrop) for any read-only detail, e.g. the cap ledgers.
  function openDialog(title, html) {
    var wrap = document.getElementById("fo-about"), body = document.getElementById("fo-about-body"), head = document.getElementById("fo-about-title");
    if (!wrap || !body) return;
    if (head) head.textContent = title || "";
    body.innerHTML = html;
    setupAbout();
    wrap.hidden = false;
    var panel = wrap.querySelector(".fo-about-panel");
    var opener = document.activeElement;
    wrap.__opener = opener;
    if (panel) panel.focus();
  }
  function closeAbout() {
    var wrap = document.getElementById("fo-about");
    if (!wrap || wrap.hidden) return;
    wrap.hidden = true;
    if (wrap.__opener && wrap.__opener.focus) wrap.__opener.focus();
  }
  function setupAbout() {
    var btn = document.getElementById("fo-about-btn"), wrap = document.getElementById("fo-about");
    if (!btn || !wrap || btn.__foWired) return;
    btn.__foWired = true;
    btn.addEventListener("click", function () {
      var active = document.querySelector(".fo-section.active");
      openAbout(active ? active.getAttribute("data-section") : "*");
    });
    wrap.addEventListener("click", function (e) { if (e.target && e.target.closest && e.target.closest("[data-action='close-about']")) closeAbout(); });
    document.addEventListener("keydown", function (e) {
      if (wrap.hidden) return;
      if (e.key === "Escape") { closeAbout(); return; }
      if (e.key === "Tab") { // keep focus inside the dialog
        var f = wrap.querySelectorAll("button, [href], [tabindex]:not([tabindex='-1'])");
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });
  }
  registerAbout("*",
    "<h3>Where the numbers come from</h3><ul>" +
    "<li><b>Points, PPG, rank:</b> MFL's own league scoring (UPS rules), every week MFL has posted. PPG = points per MFL-scored week (a 0.0 week counts; a bye or no score row doesn't). Rank = PPG among every player MFL scored at the lineup position, with at least half the final weeks. Same numbers as the phone app.</li>" +
    "<li><b>Projections:</b> MFL's weekly projection, labelled with its week. A projection is a forecast, never a result.</li>" +
    "<li><b>Injuries:</b> one chip from MFL, checked against the official NFL report; a red box says when they disagree.</li>" +
    "<li><b>Contracts and cap:</b> the same rosters, contracts and cap engine as the contract ledger (Contracts &amp; Cap).</li>" +
    "<li><b>Waiver timing:</b> the league's one waiver-availability check (the phone's badges).</li>" +
    "<li><b>Freshness:</b> MFL is read when a view first needs it; the time at the top is when MFL's scores were read.</li></ul>");

  // Views register themselves; a destination whose view isn't in this build says so instead of loading forever.
  var views = {};
  function registerView(section) { views[section] = true; }
  if (typeof document !== "undefined") {
    document.addEventListener("fo:tab", function (e) {
      var sec = e.detail && e.detail.section;
      if (["overview", "bye", "market", "trades", "picks", "moves"].indexOf(sec) === -1) return; // the ledger's own tabs render themselves
      var el = document.getElementById("fo-" + sec + "-body");
      if (el && !views[sec]) el.innerHTML = banner("This view isn’t in this build yet (#1338).", "info");
    });
  }

  root.UPS_FO_HUB = {
    registerView: registerView,
    esc: esc, pad4: pad4, fmt1: fmt1, signed1: signed1, money: money, clock: clock, dayLabel: dayLabel, asArray: asArray,
    playerIndex: playerIndex, rosterIndex: rosterIndex, teamName: teamName, groupOf: groupOf, displayName: displayName,
    scoring: scoring, values: values, seasonLine: seasonLine, modelTeams: modelTeams, freeAgents: freeAgents, leagueModel: leagueModel,
    playerButton: playerButton, goLink: goLink, wireClicks: wireClicks, injuryChip: injuryChip,
    setFreshness: setFreshness, loading: loading, banner: banner,
    registerAbout: registerAbout, openAbout: openAbout, openDialog: openDialog, closeAbout: closeAbout, setupAbout: setupAbout
  };
})(typeof window !== "undefined" ? window : this);
