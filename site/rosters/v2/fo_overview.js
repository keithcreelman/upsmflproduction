/* Front Office → Overview (#1338): only what needs the owner's attention,
   each item linked to the exact place to act. Read-only.

   Sources (one read each per visit, all through fo_data.js): the rosters,
   contracts and cap Front Office already loaded; MFL's season scores and
   players; MFL bye weeks and future picks; the league's waiver state,
   availability and (signed in) MFL's held claims; the shared injury chip.
   Models: site/shared/bye_planner.js (lineup holes) and site/shared/
   trade_fit.js (strength vs the league), both on the released 18-slot engine.
*/
(function (root) {
  "use strict";

  var H, FO, DATA;
  var BLOCKING = { waivers_later: 1, game_locked: 1, not_before_kickoff: 1, closed: 1, unknown: 1 };
  var rendering = false, queued = false;

  function focusFid() {
    var me = FO.viewerFid();
    var teams = FO.teams();
    if (me && teams.some(function (t) { return t.fid === me; })) return me;
    var sel = document.getElementById("fo-team-select");
    if (sel && sel.value && sel.value !== "__all__") return sel.value;
    return "";
  }

  function card(title, body, foot, cls) {
    return '<section class="fo-ov-card' + (cls ? " " + cls : "") + '"><h3>' + H.esc(title) + "</h3>" + body + (foot ? '<div class="fo-ov-foot">' + foot + "</div>" : "") + "</section>";
  }
  function stat(value, label, cls) {
    return '<div class="fo-ov-stat"><div class="fo-ov-val ' + (cls || "") + '">' + value + '</div><div class="fo-ov-lbl">' + H.esc(label) + "</div></div>";
  }
  function item(sev, html, action) {
    return '<li class="fo-ov-item sev-' + sev + '"><span class="fo-ov-dot" aria-hidden="true"></span><span class="fo-ov-text">' + html + "</span>" + (action || "") + "</li>";
  }

  function currentWeek(ss) {
    if (ss && ss.lineupWeek) return ss.lineupWeek;
    if (ss && ss.latestWeek) return ss.latestWeek + (ss.liveWeeks && ss.liveWeeks.length ? 0 : 1);
    return null;
  }

  function event(name) {
    var evs = FO.leagueEvents() || [];
    for (var i = 0; i < evs.length; i++) if (String(evs[i].event || "") === name) return evs[i];
    return null;
  }

  function claimsItems(fid, out) {
    var pend = DATA.get("waiverPending"), av = DATA.get("waiverAvailability");
    if (!pend) return;
    if (pend.state !== "ok" || !pend.data || pend.data.known !== true) {
      out.info.push(item("info", "Claims MFL holds for you show here when you’re signed in to MFL.", H.goLink("moves", "Activity")));
      return;
    }
    var picks = [];
    H.asArray(pend.data.rounds).forEach(function (r) { H.asArray(r && r.picks).forEach(function (pk) { picks.push(pk); }); });
    if (!picks.length) return;
    var pidx = H.playerIndex(), refuse = [];
    var a = av && av.state === "ok" ? av.data : null;
    picks.forEach(function (pk) {
      var pid = String(pk.add_pid || pk.add || pk.player_id || "");
      var pl = pidx[pid] || {};
      var st = a && a.known ? ((a.players && a.players[pid]) || (a.by_team && a.by_team[pl.team]) || a.no_game) : null;
      if (st && BLOCKING[st.code]) refuse.push(H.displayName(pl.name || pid) + " (" + (st.badge || st.headline || st.code) + ")");
    });
    out.list.push(item(refuse.length ? "warn" : "info",
      H.esc(picks.length + " claim" + (picks.length === 1 ? "" : "s") + " held at MFL") +
      (refuse.length ? ' · <b>MFL will refuse ' + refuse.length + "</b>: " + H.esc(refuse.join(", ")) : ""), H.goLink("moves", "Claims")));
  }

  function render() {
    var el = document.getElementById("fo-overview-body");
    if (!el) return;
    if (rendering) { queued = true; return; }
    rendering = true;
    try { paint(el); } finally { rendering = false; }
    if (queued) { queued = false; setTimeout(render, 0); }
  }

  function paint(el) {
    H.wireClicks(el);
    var fid = focusFid();
    if (!fid) {
      el.innerHTML = H.banner("Pick a team (Roster → Team) to see its overview. The commissioner login isn't a team.", "info");
      return;
    }
    var team = FO.teams().filter(function (t) { return t.fid === fid; })[0];
    var cap = FO.capFor(fid);
    var ss = H.scoring();
    var scoresEntry = DATA.get("scores");
    var wk = currentWeek(ss);
    var vals = H.values(0);
    var out = { list: [], info: [] };

    // ── status row ──
    var capCls = cap && cap.capSpace < 0 ? "neg" : "pos";
    var row = '<div class="fo-ov-row">' +
      card("Cap", '<div class="fo-ov-stats">' + stat(cap ? H.money(cap.capSpace) : "—", "cap space", capCls) +
        stat(cap ? H.money(cap.capAlloc) : "—", "allocated of " + H.money(FO.capCeiling)) + "</div>", H.goLink("cap", "Cap plan")) +
      card("Roster", '<div class="fo-ov-stats">' + stat(cap ? cap.activeN + '<span class="fo-ov-of"> / ' + cap.activeMax + "</span>" : "—", "active (min " + (cap ? cap.activeMin : 27) + ")",
        cap && (cap.activeN > cap.activeMax || cap.activeN < cap.activeMin) ? "neg" : "") +
        stat(cap ? cap.taxiN + '<span class="fo-ov-of"> / ' + cap.taxiMax + "</span>" : "—", "taxi") +
        stat(cap ? String(cap.irN) : "—", "on IR") + "</div>", H.goLink("roster", "Players")) +
      weekCard(wk) +
      deadlineCard() +
      "</div>";

    // ── needs attention ──
    if (cap) {
      if (cap.capSpace < 0) out.list.push(item("bad", "Over the cap by <b>" + H.money(-cap.capSpace) + "</b>.", H.goLink("cap", "Cap plan")));
      if (cap.activeN > cap.activeMax) out.list.push(item("bad", "<b>" + (cap.activeN - cap.activeMax) + "</b> over the active-roster max (" + cap.activeMax + ").", H.goLink("roster", "Players")));
      if (cap.activeN < cap.activeMin) out.list.push(item("bad", "<b>" + (cap.activeMin - cap.activeN) + "</b> under the active-roster minimum (" + cap.activeMin + "). Adds happen in the phone app’s Market.", H.goLink("market", "Market")));
    }

    var BP = root.UPS_BYE_PLANNER, TF = root.UPS_TRADE_FIT;
    var teams = H.modelTeams();
    var mine = teams.filter(function (t) { return t.fid === fid; })[0];
    var byesEntry = DATA.get("byes");
    var plan = null;
    if (BP && mine && ss && wk && byesEntry && byesEntry.state === "ok") {
      plan = BP.plan({ players: mine.players, values: vals, byeWeekByTeam: BP.byesFromMfl(byesEntry.data),
        fromWeek: wk, toWeek: Math.min(17, wk + 2), currentWeek: wk });
    }
    // Likely starters with an injury designation (best lineup by season PPG).
    if (plan && team) {
      var hurt = [];
      Object.keys(plan.fullStarters).forEach(function (pid) {
        var p = team.players.filter(function (x) { return String(x.id) === pid; })[0];
        if (!p) return;
        var chip = H.injuryChip(p);
        if (chip) hurt.push(H.playerButton(p.id, fid, H.displayName(p.name)) + chip);
      });
      if (hurt.length) out.list.push(item("warn", "Likely starters with an injury designation: " + hurt.join(", "), H.goLink("roster", "Players")));
      var disagree = team.players.filter(function (p) { var r = FO.injury(p); return r && r.warning; });
      if (disagree.length) out.list.push(item("warn", "Injury sources disagree for " + disagree.map(function (p) { return H.playerButton(p.id, fid, H.displayName(p.name)); }).join(", ") + ".", ""));
    }
    if (plan) {
      plan.weeks.forEach(function (w) {
        if (w.empty.length) {
          var labels = Object.keys(w.emptyGroups).map(function (g) { return w.emptyGroups[g] + " " + g; });
          out.list.push(item("bad", "<b>Week " + w.week + "</b>: no eligible player for " + H.esc(labels.join(", ")) + " (an empty lineup slot).", H.goLink("bye", "Bye planner")));
        } else if (w.startersOut.length >= 3) {
          out.list.push(item("warn", "<b>Week " + w.week + "</b>: " + w.startersOut.length + " likely starters on a bye (−" + H.fmt1(w.cost) + " pts vs full strength).", H.goLink("bye", "Bye planner")));
        }
      });
    }
    // Contract windows that close soon (the same eligibility the Contracts lists use).
    var mym = [];
    if (team) {
      team.players.forEach(function (p) {
        var e = FO.eligibility(p);
        if (!e) return;
        if (e.extensionEligible) {
          var dl = FO.extensionDeadline(p);
          if (dl && dl.days_until != null && dl.days_until <= 14) {
            out.list.push(item(dl.days_until <= 3 ? "bad" : "warn", "Extension window for " + H.playerButton(p.id, fid, H.displayName(p.name), "") +
              " closes in <b>" + dl.days_until + " day" + (dl.days_until === 1 ? "" : "s") + "</b>" + (dl.date ? " (" + H.esc(H.dayLabel(dl.date.getTime ? dl.date.getTime() : dl.date)) + ")" : "") + ".", H.goLink("extensions", "Extensions")));
          }
        }
        if (e.mymEligible) mym.push(H.playerButton(p.id, fid, H.displayName(p.name)) + (e.mymDaysSinceAcq != null ? ' <span class="fo-ov-via">day ' + e.mymDaysSinceAcq + " of 14</span>" : ""));
      });
    }
    if (mym.length) out.list.push(item("warn", "Mid-Year Multi window open for " + mym.length + " player" + (mym.length === 1 ? "" : "s") + ": " + mym.join(", ") + ".", H.goLink("mym", "MYM")));
    claimsItems(fid, out);
    var td = event("ups_trade_deadline");
    if (td && td.date) {
      var days = Math.ceil((Date.parse(td.date + "T12:00:00-05:00") - Date.now()) / 86400000);
      if (days >= 0 && days <= 14) out.list.push(item("warn", "Trade deadline in <b>" + days + " days</b> (league calendar: " + H.esc(td.date) + ").", H.goLink("trades", "Trade finder")));
    }

    var needs = '<section class="fo-ov-card fo-ov-needs"><h3>Needs attention</h3>' +
      (out.list.length ? '<ul class="fo-ov-list">' + out.list.join("") + "</ul>" : '<p class="fo-ov-empty">Nothing needs you right now.</p>') +
      (out.info.length ? '<ul class="fo-ov-list fo-ov-info">' + out.info.join("") + "</ul>" : "") +
      (!ss ? H.banner(scoresEntry && scoresEntry.state === "error" ? "MFL’s scores couldn’t be read, so lineup and bye checks are off." : "Reading MFL’s scores…", scoresEntry && scoresEntry.state === "error" ? "warn" : "info") : "") +
      "</section>";

    // ── strength vs the league ──
    var side = "";
    if (TF && ss && teams.length) {
      var model = H.leagueModel(0);
      var tm = model && model.teams[fid];
      if (tm) {
        var groups = TF.GROUPS.filter(function (g) { return !TF.FIT_EXCLUDED_GROUPS[g]; });
        var max = Math.max.apply(null, groups.map(function (g) { return Math.abs(tm.vsMedian[g]); }).concat([1]));
        var bars = groups.map(function (g) {
          var v = tm.vsMedian[g], w = Math.round(Math.abs(v) / max * 50);
          return '<div class="fo-ov-bar"><span class="fo-ov-bar-lbl">' + g + '</span><span class="fo-ov-bar-track"><span class="fo-ov-bar-fill ' + (v >= 0 ? "pos" : "neg") +
            '" style="' + (v >= 0 ? "left:50%;" : "right:50%;") + "width:" + w + '%"></span></span><span class="fo-ov-bar-val">' + H.signed1(v) + "</span></div>";
        }).join("");
        var sum = TF.teamSummary(model, fid);
        var need = sum.needs[0];
        side += card("Lineup strength vs the league",
          '<p class="fo-ov-sub">Starters’ points a week above replacement, against the league median (season PPG).</p>' + bars +
          (need ? '<p class="fo-ov-sub">Biggest need: <b>' + need + "</b> (+" + H.fmt1(tm.need[need]) + " pts a week from a typical starter).</p>" : ""),
          H.goLink("trades", "Trade finder"));
      }
    }
    side += picksCard(fid);
    side += expiringCard(team, fid);

    el.innerHTML = row + '<div class="fo-ov-grid"><div>' + needs + "</div><div>" + side + "</div></div>";
    if (ss) H.setFreshness("MFL read " + H.clock(ss.fetchedAt));
  }

  function weekCard(wk) {
    var st = DATA.get("waiverState"), av = DATA.get("waiverAvailability");
    var a = av && av.state === "ok" ? av.data : null;
    var next = a && a.next_run_label ? a.next_run_label : "";
    var mode = st && st.state === "ok" && st.data && st.data.window ? st.data.window.mode : "";
    var modeText = { bbid: "Blind bids", fcfs: "First come, first served", blackout: "No add/drops right now", closed: "Waivers closed" }[mode] || "";
    return card("This week", '<div class="fo-ov-stats">' + stat(wk ? "Week " + wk : "—", "lineup week") +
      '<div class="fo-ov-stat"><div class="fo-ov-val fo-ov-small">' + H.esc(next || "—") + '</div><div class="fo-ov-lbl">' + H.esc(modeText ? modeText + " · next run" : "next waiver run") + "</div></div></div>",
      H.goLink("bye", "Bye planner") + " " + H.goLink("market", "Market"));
  }

  function deadlineCard() {
    var td = event("ups_trade_deadline");
    var days = td && td.date ? Math.ceil((Date.parse(td.date + "T12:00:00-05:00") - Date.now()) / 86400000) : null;
    return card("Trade deadline", '<div class="fo-ov-stats">' + stat(days == null ? "—" : (days < 0 ? "Passed" : days + " days"), td && td.date ? "league calendar · " + td.date : "not in the league calendar") + "</div>",
      '<a class="fo-go" href="' + H.esc(FO.warRoomUrl({})) + '" target="_top">Trade War Room ›</a>');
  }

  function picksCard(fid) {
    var e = DATA.get("picks");
    if (!e) return "";
    if (e.state !== "ok") return card("Draft picks", H.banner("MFL’s future picks couldn’t be read.", "warn"), H.goLink("picks", "Draft picks"));
    var mineRow = H.asArray(e.data.futureDraftPicks && e.data.futureDraftPicks.franchise).filter(function (f) { return f.id === fid; })[0];
    var picks = H.asArray(mineRow && mineRow.futureDraftPick);
    var byYear = {};
    picks.forEach(function (p) { (byYear[p.year] = byYear[p.year] || []).push(p); });
    var lines = Object.keys(byYear).sort().map(function (y) {
      var list = byYear[y].sort(function (a, b) { return Number(a.round) - Number(b.round); }).map(function (p) {
        return "R" + p.round + (p.originalPickFor !== fid ? ' <span class="fo-ov-via">via ' + H.esc(H.teamName(p.originalPickFor)) + "</span>" : "");
      });
      return "<div><b>" + H.esc(y) + "</b> · " + list.join(", ") + "</div>";
    }).join("");
    return card("Draft picks", lines || '<p class="fo-ov-empty">No future picks.</p>', H.goLink("picks", "Draft picks"));
  }

  function expiringCard(team, fid) {
    if (!team) return "";
    var exp = team.players.filter(function (p) { return !p.isTaxi && Number(p.years) === 1; })
      .sort(function (a, b) { return (b.salary || 0) - (a.salary || 0); });
    if (!exp.length) return "";
    var top = exp.slice(0, 6).map(function (p) { return H.playerButton(p.id, fid, H.displayName(p.name)) + ' <span class="fo-ov-via">' + H.esc(H.money(p.salary)) + "</span>"; }).join(", ");
    return card("Contracts ending this season", '<p class="fo-ov-sub">' + exp.length + " player" + (exp.length === 1 ? "" : "s") + " in the final year: " + top + (exp.length > 6 ? ", …" : "") + "</p>",
      H.goLink("extensions", "Extensions"));
  }

  function load() {
    var keys = ["scores", "players", "byes", "picks", "waiverState", "waiverAvailability", "waiverPending"];
    keys.forEach(function (k) { DATA.load(k).then(render); });
    var f = root.UPS_FO_DATA;
    if (f) f.injury(render);
  }

  function boot() {
    H = root.UPS_FO_HUB; FO = root.UPS_FO; DATA = root.UPS_FO_DATA;
    if (!H || !FO || !DATA) return;
    H.setupAbout();
    H.registerAbout("overview",
      "<h3>Overview</h3><p>Only items that need you, each with a link to where you act. Lineup and bye checks use your best legal 18-player lineup by season points per MFL week. " +
      "Strength = your starters’ points a week above replacement (the 3rd-best free agent at QB/RB/WR/TE, 6th at K/P, 12th at IDP), against the league median.</p>");
    render();
    load();
  }
  if (root.UPS_FO_HUB) root.UPS_FO_HUB.registerView("overview");
  document.addEventListener("fo:ready", boot);
  document.addEventListener("fo:tab", function (e) { if (e.detail && e.detail.section === "overview") render(); });
  document.addEventListener("fo:events", render);
  document.addEventListener("fo:injury", render);
})(typeof window !== "undefined" ? window : this);
