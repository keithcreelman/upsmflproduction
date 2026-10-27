/* Front Office → Market / Player Explorer (#1338). Read-only: it finds
   players; bids and adds happen in the phone app's Market (the one place that
   submits claims), trades in the Trade War Room.

   Availability comes from the league's ONE waiver resolver
   (worker/src/waiver_availability.js via GET /api/waivers/availability, the
   phone's badges): a free agent's state is players[pid] || by_team[team] ||
   no_game. States are kept apart, word for word:
     available_now        Add now (first come, first served)
     waivers              Claim now — goes to the next run (named)
     waivers_later        Can't claim yet — first run that can award the player, and
                          when a claim can be entered (drop lock)
     game_locked          Game locked until the NFL week rolls over
     not_before_kickoff   No run before the player's game; first eligible run named
     closed / unknown     No add/drops now / couldn't confirm
   Rostered players show their team; MFL's trade-bait list marks "On the block" (not repeated inside the On the block view).
   Points, PPG and rank are the shared (phone) season line.
*/
(function (root) {
  "use strict";

  var H, FO, DATA;
  var view = { scope: "fa", pos: "ALL", team: "", q: "", hideOut: false, sort: { key: "ppg", dir: -1 } };
  var LIMIT = 200;
  var EMPTY = {
    fa: "No free agent matches. Try another position.",
    later: "No free agent is waiting on a later run right now (no drop locks or started games).",
    bait: "No team lists a matching player on MFL’s trade block.",
    rostered: "No player on another team matches.",
    all: "No player matches."
  };
  var POS_CHIPS = ["ALL", "QB", "RB", "WR", "TE", "PK", "PN", "DL", "LB", "DB"];
  var AVAIL = {
    available_now: { cls: "now", label: "Add now" },
    waivers: { cls: "claim", label: "Claim now" },
    waivers_later: { cls: "later", label: "Can't claim yet" },
    game_locked: { cls: "locked", label: "Game locked" },
    not_before_kickoff: { cls: "later", label: "After kickoff" },
    closed: { cls: "locked", label: "Locked" },
    unknown: { cls: "unknown", label: "Can't confirm" }
  };

  function ageOf(birth) {
    var b = parseInt(birth, 10);
    if (!(b > 0)) return null;
    return Math.floor((Date.now() / 1000 - b) / (365.25 * 86400));
  }
  function detailIndex() {
    var e = DATA.get("playersDetail");
    if (!e || e.state !== "ok") return null;
    if (e.__idx) return e.__idx;
    var out = {};
    H.asArray(e.data.players && e.data.players.player).forEach(function (p) { if (p && p.id) out[String(p.id)] = p; });
    e.__idx = out;
    return out;
  }
  function tradeBait() {
    var e = DATA.get("tradeBait");
    if (!e || e.state !== "ok") return null;
    if (e.__bait) return e.__bait;
    var out = {};
    H.asArray(e.data.tradeBaits && e.data.tradeBaits.tradeBait).forEach(function (tb) {
      String(tb.willGiveUp || "").split(",").forEach(function (id) {
        id = id.trim();
        if (/^\d+$/.test(id)) out[id] = H.pad4(tb.franchise_id);
      });
    });
    e.__bait = out;
    return out;
  }
  // One resolver answer → what the Status cell says (pure). "sub" names the run: the run a claim goes to now, or
  // the first run that can award the player when a claim can't go in yet.
  function statusFor(a) {
    var m = AVAIL[a && a.code] || AVAIL.unknown;
    var code = a && a.code;
    var sub = code === "waivers" ? compactRun(a.eligible_run_label) :
      (code === "waivers_later" || code === "game_locked" || code === "not_before_kickoff") ? (a.eligible_run_label ? "first eligible: " + compactRun(a.eligible_run_label) : (a.badge || "")) : "";
    return { label: m.label, cls: m.cls, sub: sub, title: [a && a.headline].concat((a && a.lines) || []).filter(Boolean).join("\n") };
  }
  // "Thursday's run, Oct 22 at 9:00 AM ET" → "Thu Oct 22 run" for the cell (the full label stays in the tooltip).
  function compactRun(label) {
    var m = /^([A-Z][a-z]{2})[a-z]*'s run, ([A-Z][a-z]{2} \d{1,2})/.exec(String(label || ""));
    return m ? m[1] + " " + m[2] + " run" : String(label || "");
  }
  function isLater(code) { return code === "waivers_later" || code === "game_locked" || code === "not_before_kickoff"; }
  function availabilityFor(pid, team) {
    var e = DATA.get("waiverAvailability");
    if (!e) return { pending: true };
    if (e.state !== "ok" || !e.data || e.data.known !== true) return { code: "unknown", badge: "Can't confirm", headline: "The waiver check couldn’t be read.", lines: [] };
    var a = e.data;
    return (a.players && a.players[pid]) || (team && a.by_team && a.by_team[team]) || a.no_game || { code: "unknown", headline: "No answer for this player.", lines: [] };
  }
  function lineupWeek() {
    var ss = H.scoring();
    if (!ss) return null;
    return ss.lineupWeek || (ss.latestWeek ? ss.latestWeek + (ss.liveWeeks && ss.liveWeeks.length ? 0 : 1) : null);
  }
  function projFor(week) {
    var e = week ? DATA.get("projections", week) : null;
    var R = root.UPS_FO_ROSTER;
    return e && e.state === "ok" && R ? R.parseProjections(e.data) : null;
  }

  function rows() {
    var ss = H.scoring();
    if (!ss) return [];
    var pidx = H.playerIndex(), rost = H.rosterIndex(), det = detailIndex(), bait = tradeBait() || {};
    var byes = DATA.get("byes"), BP = root.UPS_BYE_PLANNER;
    var byeMap = byes && byes.state === "ok" && BP ? BP.byesFromMfl(byes.data) : {};
    var week = lineupWeek(), proj = projFor(week);
    var me = FO.viewerFid();
    var pool = {};
    // Every player MFL scored this season, plus every rostered player (a rostered player with no MFL week still lists).
    Object.keys(ss.byPid).forEach(function (pid) { pool[pid] = 1; });
    Object.keys(rost).forEach(function (pid) { pool[pid] = 1; });
    var out = [];
    Object.keys(pool).forEach(function (pid) {
      var r = rost[pid], pl = pidx[pid] || {};
      var name = r ? r.p.name : pl.name;
      if (!name) return;
      var pos = r ? r.p.position : pl.pos;
      var team = String(r ? r.p.nflTeam : pl.team || "").toUpperCase();
      var g = H.groupOf(pid);
      if (!g) return;
      var d = det ? det[pid] : null;
      out.push({
        pid: pid, name: name, pos: pos, group: g, team: team,
        fid: r ? r.fid : "", owner: r ? r.teamName : "", mine: !!r && r.fid === me, p: r ? r.p : null,
        line: H.seasonLine(pid, 4), bait: bait[pid] || "", bye: byeMap[team] || null,
        proj: proj ? (proj[pid] != null ? proj[pid] : null) : undefined,
        age: d ? ageOf(d.birthdate) : undefined
      });
    });
    return out;
  }

  function filter(list) {
    var q = view.q.toLowerCase();
    return list.filter(function (r) {
      if (view.scope === "fa" && r.fid) return false;
      if (view.scope === "later") {
        if (r.fid) return false;
        var a = availabilityFor(r.pid, r.team);
        if (!a || !isLater(a.code)) return false;
      }
      if (view.scope === "bait" && !(r.bait && r.bait === r.fid)) return false;
      if (view.scope === "rostered" && (!r.fid || r.mine)) return false;
      if (view.pos !== "ALL" && r.group !== view.pos) return false;
      if (view.team && r.fid !== view.team) return false;
      if (view.hideOut && r.p) {
        var res = FO.injury(r.p);
        if (res && res.chips[0] && /^(OUT|IR|PUP|NFI|SUSP|HOLD|RET)$/.test(res.chips[0].t)) return false;
      }
      if (q && (r.name + " " + r.team + " " + r.owner).toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
  }
  function sortVal(r, k) {
    switch (k) {
      case "name": return r.name;
      case "pts": return r.line ? r.line.pts : null;
      case "ppg": return r.line && r.line.ppg != null && r.line.games > 0 ? r.line.ppg : null;
      case "rank": return r.line && r.line.rank ? -r.line.rank : null;
      case "l4": return r.line && r.line.last ? r.line.last.ppg : null;
      case "proj": return r.proj == null ? null : r.proj;
      case "age": return r.age == null ? null : -r.age;
      case "salary": return r.p ? r.p.salary : null;
      default: return null;
    }
  }
  // PPG and Rank sort RANKED players first (the phone's rule): a 23.7 from one MFL week isn't a 23.7-PPG player.
  function ranked(r) { return !!(r.line && r.line.rank); }
  function sorted(list) {
    var k = view.sort.key, dir = view.sort.dir;
    return list.slice().sort(function (a, b) {
      if ((k === "ppg" || k === "rank" || k === "l4") && ranked(a) !== ranked(b)) return ranked(a) ? -1 : 1;
      var x = sortVal(a, k), y = sortVal(b, k);
      if (x == null && y == null) return a.name.localeCompare(b.name);
      if (x == null) return 1;
      if (y == null) return -1;
      var c = typeof x === "string" ? x.localeCompare(y) : x - y;
      return dir > 0 ? c : -c;
    });
  }

  function availCell(r) {
    if (r.fid) {
      return '<span class="fo-av fo-av-rostered">' + (r.mine ? "Your team" : H.esc(r.owner)) + "</span>" +
        (r.bait && r.bait === r.fid && view.scope !== "bait" ? ' <span class="fo-av fo-av-bait" title="Listed on MFL’s trade block by the owning team">On the block</span>' : "");   // the On the block view already says it
    }
    var a = availabilityFor(r.pid, r.team);
    if (a.pending) return '<span class="fo-muted">checking…</span>';
    var st = statusFor(a);
    // "Claim now" is not shown as a chip: the row's "Claim in app" action says it. The named run stays.
    if (st.cls === "claim") return '<span class="fo-muted" title="' + H.esc(st.title) + '">' + H.esc(st.sub) + "</span>";
    return '<span class="fo-av fo-av-' + st.cls + '" title="' + H.esc(st.title) + '">' + H.esc(st.label) + "</span>" +
      (st.sub ? '<div class="fo-muted fo-perf-sub">' + H.esc(st.sub) + "</div>" : "");
  }
  function actionCell(r) {
    if (!r.fid) {
      var a = availabilityFor(r.pid, r.team);
      if (a && (a.code === "available_now" || a.code === "waivers")) return '<a class="fo-go" href="' + H.esc(appUrl()) + '" target="_blank" rel="noopener" title="Bids and adds are made in the phone app’s Market">' + (a.code === "available_now" ? "Add in app" : "Bid in app") + " ↗</a>";
      return "";
    }
    if (r.mine) return "";
    var me = FO.viewerFid();
    return '<a class="fo-go" href="' + H.esc(FO.warRoomUrl({ twb_left_team: me, twb_right_team: r.fid, twb_player_id: r.pid, twb_team_id: r.fid, twb_side: "partner" })) + '" target="_top">War Room ↗</a>';
  }
  function appUrl() {
    if (typeof root.upsBuildMobileAppUrl === "function") {
      var u = root.upsBuildMobileAppUrl("players", FO.leagueId, FO.season, { embed: false });
      if (u) return u;
    }
    return "https://keithcreelman.github.io/upsmflproduction/m/?L=" + encodeURIComponent(FO.leagueId) + "&YEAR=" + encodeURIComponent(FO.season) + "#players";
  }

  function th(key, label, title, cls) {
    var on = view.sort.key === key;
    return '<th scope="col" class="' + (cls || "") + '" aria-sort="' + (on ? (view.sort.dir > 0 ? "ascending" : "descending") : "none") + '"' + (title ? ' title="' + H.esc(title) + '"' : "") + ">" +
      (key ? '<button type="button" class="fo-th-sort" data-mk-sort="' + key + '">' + H.esc(label) + (on ? (view.sort.dir > 0 ? " ▲" : " ▼") : "") + "</button>" : H.esc(label)) + "</th>";
  }

  function render() {
    var el = document.getElementById("fo-market-body");
    if (!el) return;
    H.wireClicks(el);
    var ss = H.scoring(), se = DATA.get("scores");
    if (!se || !DATA.get("players")) { H.loading(el, "Reading MFL’s players and scores…"); return; }
    if (!ss) { el.innerHTML = H.banner("MFL’s scores couldn’t be read, so the Market can’t rank players. Reload to retry.", "warn"); return; }
    var all = rows(), list = sorted(filter(all)), shown = list.slice(0, LIMIT);
    var week = lineupWeek();
    var F = root.UPS_PLAYER_FACTS, basis = F ? F.basis(ss) : { text: "" };
    var av = DATA.get("waiverAvailability");
    var avNote = !av ? "Checking waiver timing…" : (av.state !== "ok" || !av.data || av.data.known !== true ? "Waiver timing couldn’t be confirmed, so free agents show “Can’t confirm”." : "");
    var teams = FO.teams();
    var scopes = [["fa", "Free agents"], ["later", "Waivers later"], ["bait", "On the block"], ["rostered", "Other teams"], ["all", "All players"]];
    var controls = '<div class="fo-mk-controls">' +
      '<div class="fo-subview-chips" role="group" aria-label="Who">' + scopes.map(function (s) {
        return '<button type="button" class="fo-subview-chip' + (view.scope === s[0] ? " active" : "") + '" data-mk-scope="' + s[0] + '" aria-pressed="' + (view.scope === s[0]) + '">' + H.esc(s[1]) + "</button>";
      }).join("") + "</div>" +
      '<div class="fo-pos-chips" role="group" aria-label="Position">' + POS_CHIPS.map(function (g) {
        return '<button type="button" class="fo-pos-chip' + (view.pos === g ? " active" : "") + '" data-mk-pos="' + g + '" aria-pressed="' + (view.pos === g) + '">' + (g === "ALL" ? "All" : g === "PK" ? "K" : g === "PN" ? "P" : g) + "</button>";
      }).join("") + "</div>" +
      '<label class="fo-field fo-inline">Team <select data-mk-team><option value="">Any</option>' + teams.map(function (t) {
        return '<option value="' + H.esc(t.fid) + '"' + (view.team === t.fid ? " selected" : "") + ">" + H.esc(t.name) + "</option>";
      }).join("") + "</select></label>" +
      '<button type="button" class="fo-subview-chip' + (view.hideOut ? " active" : "") + '" data-mk-hideout aria-pressed="' + view.hideOut + '">Hide Out / IR</button>' +
      '<label class="fo-field fo-inline fo-mk-search">Find <input type="search" data-mk-q value="' + H.esc(view.q) + '" placeholder="Player, NFL team or owner" autocomplete="off"></label>' +
      "</div>";
    // A free agent has no contract: the Contract column only shows where rostered players can be listed.
    var showContract = view.scope !== "fa" && view.scope !== "later";
    var head = "<thead><tr>" + th("name", "Player", "", "") + th("", "Status", "Free agents: when the player can be added or claimed (the league's waiver check, same as the phone). Rostered: the owning team, and whether it lists the player on the trade block.", "") +
      th("pts", "Pts", "MFL points, league scoring, every week MFL posted", "num") + th("ppg", "PPG", "Points per MFL-scored week", "num") +
      th("rank", "Rank", "PPG rank at the player's position among every player MFL scored with at least half the final weeks", "num") +
      th("l4", "L4", "PPG over the last 4 final weeks (context)", "num col-lo") +
      th("proj", week ? "Wk " + week + " proj" : "Proj", "MFL's projection for this lineup week — a forecast", "num") +
      th("", "Bye", "NFL bye week", "num col-md") + th("age", "Age", "From MFL's birthdate", "num col-md") +
      (showContract ? th("salary", "Contract", "Salary · years left (rostered players)", "num") : "") + th("", "", "", "") + "</tr></thead>";
    var body = shown.map(function (r) {
      var l = r.line;
      return "<tr>" +
        '<td class="fo-perf-player">' + H.playerButton(r.pid, r.fid, r.name) + (r.p ? H.injuryChip(r.p) : "") +
          '<div class="fo-muted fo-perf-sub">' + H.esc(r.pos) + " · " + H.esc(r.team || "FA") + "</div></td>" +
        "<td>" + availCell(r) + "</td>" +
        '<td class="num">' + (l ? H.fmt1(l.pts) : "—") + "</td>" +
        '<td class="num">' + (l && l.ppg != null ? H.fmt1(l.ppg) : "—") + (l ? '<div class="fo-muted fo-perf-sub">' + l.games + " wk" + (l.games === 1 ? "" : "s") + "</div>" : "") + "</td>" +
        '<td class="num">' + (l ? H.esc(l.rankLabel) : "—") + "</td>" +
        '<td class="num col-lo">' + (l && l.last && l.last.ppg != null ? H.fmt1(l.last.ppg) : "—") + "</td>" +
        '<td class="num">' + (week && r.bye === week ? '<span class="fo-bye">BYE</span>' : r.proj === undefined ? '<span class="fo-muted">…</span>' : r.proj == null ? "—" : H.fmt1(r.proj)) + "</td>" +
        '<td class="num col-md">' + (r.bye || "—") + "</td>" +
        '<td class="num col-md">' + (r.age === undefined ? '<span class="fo-muted">…</span>' : r.age == null ? "—" : r.age) + "</td>" +
        (showContract ? '<td class="num">' + (r.p ? H.esc(H.money(r.p.salary)) + '<div class="fo-muted fo-perf-sub">' + (r.p.years > 0 ? r.p.years + " yr" + (r.p.years === 1 ? "" : "s") : "expired") + "</div>" : "—") + "</td>" : "") +
        "<td>" + actionCell(r) + "</td></tr>";
    }).join("");
    el.innerHTML = '<div class="fo-card">' + controls +
      '<p class="fo-basis">' + list.length + " player" + (list.length === 1 ? "" : "s") + (list.length > LIMIT ? " · showing the top " + LIMIT + " — refine the filters" : "") +
        " · " + H.esc(basis.text) + (projFor(week) ? " · Wk " + week + " proj = MFL projection" : "") + "</p>" +
      (avNote ? H.banner(avNote, av && av.state === "error" ? "warn" : "info") : "") +
      '<div class="fo-table-scroll"><table class="fo-table fo-perf-table fo-mk-table">' + head + "<tbody>" +
        (body || '<tr><td colspan="' + (showContract ? 11 : 10) + '" class="fo-table-empty">' + H.esc(EMPTY[view.scope] || "No players match.") + "</td></tr>") + "</tbody></table></div>" +
      '<p class="fo-muted fo-perf-sub">Bids and adds are made in the phone app’s Market; trades in the Trade War Room. Nothing on this page sends a claim, add or offer.</p></div>';
    var q = el.querySelector("[data-mk-q]");
    if (q && view.__focusQ) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); view.__focusQ = false; }
  }

  function wire() {
    var el = document.getElementById("fo-market-body");
    if (!el || el.__mkWired) return;
    el.__mkWired = true;
    el.addEventListener("click", function (e) {
      var t = e.target && e.target.closest ? e.target.closest("[data-mk-scope],[data-mk-pos],[data-mk-sort],[data-mk-hideout]") : null;
      if (!t) return;
      if (t.hasAttribute("data-mk-hideout")) view.hideOut = !view.hideOut;
      if (t.hasAttribute("data-mk-scope")) view.scope = t.getAttribute("data-mk-scope");
      if (t.hasAttribute("data-mk-pos")) view.pos = t.getAttribute("data-mk-pos");
      if (t.hasAttribute("data-mk-sort")) {
        var k = t.getAttribute("data-mk-sort");
        view.sort = view.sort.key === k ? { key: k, dir: -view.sort.dir } : { key: k, dir: k === "name" ? 1 : -1 };
      }
      render();
    });
    el.addEventListener("change", function (e) {
      var t = e.target;
      if (t.hasAttribute("data-mk-team")) view.team = t.value;
      render();
    });
    var timer = null;
    el.addEventListener("input", function (e) {
      if (!e.target.hasAttribute("data-mk-q")) return;
      view.q = e.target.value;
      clearTimeout(timer);
      timer = setTimeout(function () { view.__focusQ = true; render(); }, 180);
    });
  }

  function load() {
    ["scores", "players", "byes", "tradeBait", "waiverAvailability", "playersDetail"].forEach(function (k) { DATA.load(k).then(after); });
  }
  function after() {
    var week = lineupWeek();
    if (week && !DATA.get("projections", week)) DATA.load("projections", week).then(rerender);
    rerender();
  }
  function rerender() {
    var active = document.querySelector(".fo-section.active");
    if (active && active.getAttribute("data-section") === "market") render();
  }

  if (root.UPS_FO_HUB) root.UPS_FO_HUB.registerView("market");
  root.UPS_FO_MARKET = { AVAIL: AVAIL, statusFor: statusFor, isLater: isLater, compactRun: compactRun, _view: view };
  document.addEventListener("fo:ready", function () {
    H = root.UPS_FO_HUB; FO = root.UPS_FO; DATA = root.UPS_FO_DATA;
    if (!H || !FO || !DATA) return;
    wire();
    H.registerAbout("market", "<h3>Market</h3><ul>" +
      "<li><b>Status</b> for a free agent is the league’s one waiver check (the phone’s badges): <b>Add now</b> (first come, first served), the named run (a claim goes to it; the row’s link claims in the app), <b>Can’t claim yet</b> (dropped-player lock: the first run that can award the player is named, and when a claim can be entered), <b>Game locked</b> (the player’s game has started; until the NFL week rolls over), <b>Locked</b> (no add/drops right now).</li>" +
      "<li><b>On the block:</b> the owning team lists the player on MFL’s trade block.</li>" +
      "<li>Points, PPG and rank: MFL’s own scoring, same as the phone. The top 200 rows show; filters narrow the list.</li>" +
      "<li>Nothing here sends a claim, add or offer: bids and adds are made in the phone app, trades in the Trade War Room.</li></ul>");
  });
  document.addEventListener("fo:tab", function (e) { if (H && e.detail && e.detail.section === "market") { render(); load(); } });
  document.addEventListener("fo:injury", rerender);
})(typeof window !== "undefined" ? window : this);
