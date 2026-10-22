/* Front Office → Overview (#1338): only what needs the owner's attention,
   each item linked to the exact place to act. Read-only.

   Sources (one read each per visit, all through fo_data.js): the rosters,
   contracts and cap Front Office already loaded; MFL's season scores and
   players; MFL bye weeks and future picks; the league's waiver state,
   availability and (signed in) MFL's held claims; the shared injury chip.
   Models: site/shared/bye_planner.js (lineup holes), site/shared/trade_fit.js
   + site/shared/lineup_strength.js (strength vs the league: By Position and
   By Lineup Slot over one modeled lineup per team, four measures), on the
   slots MFL's league settings define; site/shared/starter_mix.js (the
   Actual starter mix, from the lineups owners submitted). Cap: the Front Office's own cap
   engine (UPS_FO.capFor / capLedger). Trade deadline: MFL's league calendar
   ("No Trades Allowed"), read with the viewer's MFL session.
*/
(function (root) {
  "use strict";

  var H, FO, DATA;
  var BLOCKING = { waivers_later: 1, game_locked: 1, not_before_kickoff: 1, closed: 1, unknown: 1 };
  var rendering = false, queued = false;
  var lsView = "ppg";        // Lineup strength measure for this visit (Keith 2026-10-21: PPG is the default)
  var lsBy = "position";     // breakdown: "position" | "slot" | "mix" (Actual starter mix)

  function smoney(v) {   // signed dollars: +$9,000 / −$27,000 / $0
    var n = Math.round(Number(v) || 0);
    return (n > 0 ? "+" : n < 0 ? "−" : "") + H.money(Math.abs(n));
  }
  function etParts(ms) {
    try {
      var f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
      var o = {}; f.forEach(function (x) { o[x.type] = x.value; });
      return Date.UTC(+o.year, +o.month - 1, +o.day);
    } catch (e) { return null; }
  }
  // "Tue, Nov 24, 12:00 PM ET" in every browser (Safari's toLocaleString says "Tue, Nov 24 at 12:00 PM").
  function etLabel(ms) {
    try {
      var o = {};
      new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })
        .formatToParts(new Date(ms)).forEach(function (x) { o[x.type] = x.value; });
      return o.weekday + ", " + o.month + " " + o.day + ", " + o.hour + ":" + o.minute + " " + String(o.dayPeriod || "").toUpperCase() + " ET";
    } catch (e) { return new Date(ms).toISOString(); }
  }
  // When MFL stops accepting trades: its calendar's "No Trades Allowed" (TRADE) events that haven't ended; the
  // earliest start wins (an event with no end runs for the rest of the season). → {state, startMs, days} or null.
  function tradeDeadlineFrom(cal, nowMs) {
    var root_ = (cal && cal.calendar) || cal || {};
    var evs = root_.event; evs = !evs ? [] : (Array.isArray(evs) ? evs : [evs]);
    var trade = evs.map(function (e) {
      return { type: String((e && (e.type || e.event_type)) || "").toUpperCase(), start: Number(e && e.start_time) * 1000 || null, end: Number(e && e.end_time) * 1000 || null };
    }).filter(function (e) { return e.type === "TRADE" && e.start && (!e.end || e.end > nowMs); })
      .sort(function (a, b) { return a.start - b.start; });
    if (!trade.length) return null;
    var t = trade[0];
    var d0 = etParts(nowMs), d1 = etParts(t.start);
    return { state: t.start <= nowMs ? "closed" : "upcoming", startMs: t.start, endMs: t.end, events: trade.length,
      days: d0 != null && d1 != null ? Math.round((d1 - d0) / 86400000) : null, label: etLabel(t.start) };
  }

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
    // fo:injury / fo:events can arrive before fo:ready on a slow network; boot renders once the hub is there.
    if (!H || !FO || !DATA) return;
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
    var row = '<div class="fo-ov-row">' +
      capCard(fid, cap) +
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
    var tdl = mflDeadline();
    if (tdl && tdl.state === "upcoming" && tdl.days != null && tdl.days <= 14) {
      out.list.push(item("warn", "MFL stops accepting trades in <b>" + tdl.days + " day" + (tdl.days === 1 ? "" : "s") + "</b> (" + H.esc(tdl.label) + ").", H.goLink("trades", "Trade finder")));
    }

    var needs = '<section class="fo-ov-card fo-ov-needs"><h3>Needs attention</h3>' +
      (out.list.length ? '<ul class="fo-ov-list">' + out.list.join("") + "</ul>" : '<p class="fo-ov-empty">Nothing needs you right now.</p>') +
      (out.info.length ? '<ul class="fo-ov-list fo-ov-info">' + out.info.join("") + "</ul>" : "") +
      (!ss ? H.banner(scoresEntry && scoresEntry.state === "error" ? "MFL’s scores couldn’t be read, so lineup and bye checks are off." : "Reading MFL’s scores…", scoresEntry && scoresEntry.state === "error" ? "warn" : "info") : "") +
      "</section>";

    // ── strength vs the league ──
    var side = "";
    if (TF && ss && teams.length) side += strengthCard(fid, TF);
    side += picksCard(fid);

    el.innerHTML = row + '<div class="fo-ov-grid"><div>' + needs + "</div><div>" + side + "</div></div>";
    if (ss) H.setFreshness("MFL read " + H.clock(ss.fetchedAt));
  }

  var VIEW_TEXT = {
    ppg: ["PPG", "Modeled starters’ points a week (season PPG). Bars: against the league average."],
    rank: ["Rank", "1st–12th among the league by the same points a week."],
    above: ["Above Replacement", "Points a week above the replacement-level free agent: Σ(starter PPG − replacement PPG). 0 = replacement level."],
    index: ["Index", "Points a week ÷ the league average × 100 (100 = average)."]
  };
  var BY_TEXT = {
    position: ["By Position", "Modeled lineup, each starter at his own position: a TE in Flex counts as TE."],
    slot: ["By Lineup Slot", "Modeled lineup by the slot each starter fills in MFL’s lineup settings: a second TE is Flex, a second QB is Superflex."],
    mix: ["Starter Mix", ""]
  };
  function strengthCard(fid, TF) {
    var LS = root.UPS_LINEUP_STRENGTH;
    var byChips = '<div class="fo-subview-chips fo-ls-by" role="group" aria-label="Break lineup strength down">' + ["position", "slot", "mix"].map(function (b) {
      return '<button type="button" class="fo-subview-chip' + (b === lsBy ? " active" : "") + '" data-ls-by="' + b + '" aria-pressed="' + (b === lsBy) + '">' + H.esc(BY_TEXT[b][0]) + "</button>";
    }).join("") + "</div>";
    var slotState = H.lineupSlotsState();
    if (slotState !== "ok") {
      return card("Lineup strength vs the league", byChips + (slotState === "error" ? H.banner("MFL’s lineup settings couldn’t be read. Reload to retry.", "warn")
        : '<p class="fo-ov-empty">Reading MFL’s lineup settings…</p>'), H.goLink("trades", "Trade finder"), "fo-ls");
    }
    if (lsBy === "mix") return card("Lineup strength vs the league", byChips + starterMixHtml(fid), H.goLink("trades", "Trade finder"), "fo-ls");
    var model = H.leagueModel(0);
    var tm = model && model.teams[fid];
    if (!tm || !LS) return "";
    var table = strengthTable(model, lsBy);
    var chips = '<div class="fo-subview-chips fo-ls-views" role="group" aria-label="Measure">' + LS.VIEWS.map(function (v) {
      return '<button type="button" class="fo-subview-chip' + (v === lsView ? " active" : "") + '" data-ls-view="' + v + '" aria-pressed="' + (v === lsView) + '">' + H.esc(VIEW_TEXT[v][0]) + "</button>";
    }).join("") + "</div>";
    var mine = table.teams[fid];
    var minor = { PK: 1, PN: 1 };
    var bars = table.rows.map(function (r) {
      var c = LS.cell(table, fid, r, lsView);
      if (!c) return "";
      var w = Math.round(Math.abs(c.frac) * 50), pos = c.frac >= 0;
      var nRep = mine[r].replacementStarters;
      var cls = r === "ALL" ? " fo-ov-bar-total" : (minor[r] ? " fo-ov-bar-minor" : "");
      var tip = c.title + (nRep ? ". Includes " + nRep + " replacement-filled slot" + (nRep === 1 ? "" : "s") + " (no available rostered player)" : "") +
        (minor[r] ? ". Kickers and punters are shown, never used for trade fits." : "");
      return '<div class="fo-ov-bar' + cls + '" data-ls-row="' + r + '" title="' + H.esc(tip) + '"><span class="fo-ov-bar-lbl">' + H.esc(LS.LABELS[r]) + (nRep ? '<span class="fo-ov-rep" aria-label="includes a replacement-filled slot">*</span>' : "") +
        '</span><span class="fo-ov-bar-track"><span class="fo-ov-bar-fill ' + (pos ? "pos" : "neg") +
        '" style="' + (pos ? "left:50%;" : "right:50%;") + "width:" + w + '%"></span></span><span class="fo-ov-bar-val">' + H.esc(c.text) + "</span></div>";
    }).join("");
    var repl = mine.replacementSlots.map(function (x) { return LS.LABELS[lsBy === "slot" ? x.slotRow : x.group] || x.group; });
    var replNote = repl.length ? '<p class="fo-ov-sub">* No available rostered player for ' + H.esc(repl.join(", ")) +
      " this week, so a replacement free agent’s points fill " + (repl.length === 1 ? "that slot" : "those slots") + ".</p>" : "";
    var need = mine.biggestNeed;
    return card("Lineup strength vs the league", byChips + chips + '<p class="fo-ov-sub">' + H.esc(BY_TEXT[lsBy][1] + " " + VIEW_TEXT[lsView][1]) + "</p>" + bars + replNote +
      (need ? '<p class="fo-ov-sub">Biggest need: <b>' + (LS.LABELS[need] || need) + "</b> (+" + H.fmt1(mine.need[need]) + " pts a week from a typical starter).</p>" : ""),
      H.goLink("trades", "Trade finder"), "fo-ls");
  }
  var lsMemo = { model: null, tables: {} };
  function strengthTable(model, by) {
    if (lsMemo.model !== model) lsMemo = { model: model, tables: {} };
    return lsMemo.tables[by] || (lsMemo.tables[by] = root.UPS_LINEUP_STRENGTH.build(model, { by: by }));
  }

  // Actual starter mix: the lineups the team submitted in completed weeks (not the strength model).
  var mixMemo = { key: "", mix: null };
  function starterMix() {
    var SM = root.UPS_STARTER_MIX, ss = H.scoring(), e = DATA.get("weeklyResults"), slots = H.lineupSlots(), pe = DATA.get("players");
    if (!SM || !ss || !slots || !e || e.state !== "ok" || !pe || pe.state !== "ok" || !ss.finalKnown) return null;
    var key = [e.at, pe.at, ss.finalThrough, FO.teams().length].join("|");
    if (mixMemo.key !== key) {
      mixMemo = { key: key, mix: SM.build({ weeklyResults: e.data, completedWeek: ss.finalThrough, slots: slots, groupOf: H.playerGroup,
        fids: FO.teams().map(function (t) { return t.fid; }) }) };
    }
    return mixMemo.mix;
  }
  function pct(n) { return n + "%"; }
  function starterMixHtml(fid) {
    var SM = root.UPS_STARTER_MIX, e = DATA.get("weeklyResults"), ss = H.scoring();
    if (!e) { DATA.load("weeklyResults").then(render); return '<p class="fo-ov-empty">Reading the lineups MFL has on file…</p>'; }
    if (e.state !== "ok") return H.banner("MFL’s weekly lineups couldn’t be read. Reload to retry.", "warn");
    if (ss && !ss.finalKnown) return '<p class="fo-ov-empty">MFL hasn’t confirmed a completed week yet.</p>';
    var pe = DATA.get("players");
    if (pe && pe.state === "error") return H.banner("MFL’s players list couldn’t be read, so starters’ positions are unknown. Reload to retry.", "warn");
    var mix = starterMix();
    if (!mix) return '<p class="fo-ov-empty">Reading MFL’s players…</p>';
    var t = mix.teams[fid];
    if (!t || !mix.weeks.length) return '<p class="fo-ov-empty">No completed weeks yet.</p>';
    var wkLabel = mix.weeks.length === 1 ? "Week 1" : "Weeks 1–" + mix.weeks[mix.weeks.length - 1];
    var head = '<p class="fo-ls-actual"><b>Actual starter mix</b> · ' + H.esc(wkLabel) + " · " + t.validWeeks.length + " of " + t.weeks + " weeks counted</p>" +
      '<p class="fo-ov-sub">Starters per week from the lineups submitted to MFL, by each player’s own position. This is what was started; By Position and By Lineup Slot are the modeled lineup.</p>';
    if (!t.validWeeks.length) {
      return head + issuesHtml(t) + '<p class="fo-ov-empty">No complete lineup to average.</p>';
    }
    var rows = SM.GROUPS.map(function (g) {
      return '<tr><th scope="row">' + H.esc(SM.label(g)) + '</th><td class="num">' + t.avg[g].toFixed(1) + '</td><td class="num fo-muted">' + (mix.league.avg[g] != null ? mix.league.avg[g].toFixed(1) : "—") + "</td></tr>";
    }).join("");
    var sum = SM.GROUPS.reduce(function (a, g) { return a + t.avg[g]; }, 0);
    var lsum = SM.GROUPS.reduce(function (a, g) { return a + (mix.league.avg[g] || 0); }, 0);
    var table = '<table class="fo-table fo-ls-mix"><thead><tr><th scope="col">Position</th><th scope="col" class="num">Per week</th><th scope="col" class="num">League</th></tr></thead><tbody>' +
      rows + '<tr class="fo-led-total"><th scope="row">Starters</th><td class="num">' + sum.toFixed(1) + '</td><td class="num fo-muted">' + lsum.toFixed(1) + "</td></tr></tbody></table>";
    var flex = flexLines(mix, t);
    return head + table + flex + issuesHtml(t) +
      '<p class="fo-ov-sub">MFL records who started, not which slot each starter filled. A second QB can only be Superflex (Flex doesn’t take a QB) and an extra DL/LB/DB can only be IDP Flex; an extra RB, WR or TE could be in Flex or Superflex, so those count together as <b>Flexible slots</b>. Points are never used to assign a slot.</p>';
  }
  // The actual mix's slot lines: rows MFL's record proves (Superflex QBs, IDP Flex) and Flexible slots for the rest.
  function flexLines(mix, t) {
    var SM = root.UPS_STARTER_MIX, LS = root.UPS_LINEUP_STRENGTH;
    function parts(row, ofWhat) {
      return SM.mixList(row).map(function (x) { return pct(x.whole) + " " + (x.g ? SM.label(x.g) : ofWhat); }).join(" · ") || "—";
    }
    var lines = [];
    var amb = mix.ambiguousRows.map(function (r) { return LS.LABELS[r] || r; });
    mix.flexRows.forEach(function (r) {
      var row = t.mix[r], lg = mix.league.mix[r];
      if (!Object.keys(row.by).length && !Object.keys(lg.by).length) return;   // nothing in this row is provable: it's all Flexible
      var rest = r === "SFLEX" ? "non-QB (in Flexible slots)" : "in Flexible slots";
      lines.push('<div class="fo-ls-flex" data-ls-flex="' + r + '"><b>' + H.esc(LS.LABELS[r] || r) + ":</b> " + H.esc(parts(row, rest)) +
        ' <span class="fo-muted">(league ' + H.esc(parts(lg, rest)) + ")</span></div>");
    });
    if (amb.length) {
      lines.unshift('<div class="fo-ls-flex" data-ls-flex="FLEXIBLE"><b>Flexible slots</b> <span class="fo-muted">(' + H.esc(amb.join(" + ")) + ", not a QB)</span>: " +
        H.esc(parts(t.mix.FLEXIBLE, "")) + ' <span class="fo-muted">(league ' + H.esc(parts(mix.league.mix.FLEXIBLE, "")) + ")</span></div>");
    }
    return lines.join("");
  }
  function issuesHtml(t) {
    if (!t.issues.length) return "";
    return '<div class="fo-ls-issues"><b>Not counted:</b> ' + t.issues.map(function (x) { return "Week " + x.week + " — " + H.esc(x.text); }).join("; ") + "</div>";
  }

  // ── Cap card + its two ledgers ─────────────────────────────────────
  function capCard(fid, cap) {
    var led = FO.capLedger ? FO.capLedger(fid) : null;
    if (!cap) return card("Cap", '<p class="fo-ov-empty">Cap not loaded.</p>', H.goLink("cap", "Cap plan"));
    var sal = led ? led.players.total : cap.salaryCap, adj = led ? led.adjustments.total : cap.adjTotal;
    var line = function (label, value, attrs, cls) {
      var tag = attrs ? "button" : "div";
      return "<" + tag + (attrs ? ' type="button" ' + attrs : "") + ' class="fo-ov-capline' + (cls ? " " + cls : "") + '"><span>' + H.esc(label) + '</span><span class="fo-ov-capnum">' + value + (attrs ? ' <span aria-hidden="true">›</span>' : "") + "</span></" + tag + ">";
    };
    return card("Cap", '<div class="fo-ov-cap">' +
      line("Player salaries", H.esc(H.money(sal)), 'data-ov-ledger="players" aria-haspopup="dialog" title="How player salaries add up"') +
      line("Salary adjustments", H.esc(smoney(adj)), 'data-ov-ledger="adjustments" aria-haspopup="dialog" title="Cap penalties, traded salary and other adjustments"') +
      line("Total allocated", H.esc(H.money(cap.capAlloc)) + ' <span class="fo-ov-of">of ' + H.esc(H.money(FO.capCeiling)) + "</span>", "", "total") +
      line("Cap space", H.esc(H.money(cap.capSpace)), "", cap.capSpace < 0 ? "space neg" : "space pos") +
      "</div>", H.goLink("cap", "Cap plan"));
  }
  function ledgerRow(label, amount, cls, signed) {
    return '<tr class="' + (cls || "") + '"><th scope="row">' + label + '</th><td class="num">' + H.esc(signed ? smoney(amount) : H.money(amount)) + "</td></tr>";
  }
  function playersLedgerHtml(led) {
    var P = led.players;
    var rows = '<tr class="fo-led-head"><th scope="rowgroup" colspan="2">Salary on the roster</th></tr>' +
      P.groups.filter(function (g) { return g.players.length || g.key !== "taxi"; }).map(function (g) {
        return ledgerRow(H.esc(g.label) + ' <span class="fo-muted">(' + g.players.length + ")</span>", g.salary);
      }).join("") +
      ledgerRow("Total salary on the roster", P.grossSalary, "fo-led-sub") +
      '<tr class="fo-led-head"><th scope="rowgroup" colspan="2">Salary relief</th></tr>' +
      (P.relief.length ? P.relief.map(function (r) { return ledgerRow(H.esc(r.label) + ' <span class="fo-muted">(' + r.n + ")</span>", r.amount, "", true); }).join("")
        : ledgerRow('<span class="fo-muted">None</span>', 0, "", true)) +
      ledgerRow("Total cap-counting player salary", P.total, "fo-led-total");
    var detail = P.groups.filter(function (g) { return g.players.length; }).map(function (g) {
      return "<details><summary>" + H.esc(g.label) + " · " + g.players.length + " · counts " + H.esc(H.money(g.capHit)) + "</summary>" +
        '<table class="fo-table fo-led-players"><thead><tr><th scope="col">Player</th><th scope="col" class="num">Salary</th><th scope="col" class="num">Counts on cap</th></tr></thead><tbody>' +
        g.players.map(function (p) { return "<tr><td>" + H.esc(H.displayName(p.name)) + ' <span class="fo-muted">' + H.esc(p.position || "") + '</span></td><td class="num">' + H.esc(H.money(p.salary)) + '</td><td class="num">' + H.esc(H.money(p.capHit)) + "</td></tr>"; }).join("") +
        "</tbody></table></details>";
    }).join("");
    return '<p class="fo-ov-sub">How ' + H.esc(led.name) + "’s player salary on the cap adds up. Same cap rules as the contract ledger: taxi salaries don’t count, IR counts half.</p>" +
      '<table class="fo-table fo-led">' + rows + "</table>" + check(P.reconciles && P.total === led.capSnapshot.salaryCap, "Adds up, and equals the cap card’s player salaries.") +
      '<h4 class="fo-tf-h">Players</h4>' + detail;
  }
  var CAT_NOTE = {
    Drop: "Dead money from drops (canon §6). + counts against your cap.",
    Trade: "Salary moved in trades. + you carry it; − another team carries it for you.",
    Other: "Commissioner entries. + is a charge; − is a credit."
  };
  function adjustmentsLedgerHtml(led) {
    var A = led.adjustments;
    var rows = A.categories.map(function (c) {
      var lines = '<tr class="fo-led-head"><th scope="rowgroup" colspan="2">' + H.esc(c.label) + ' <span class="fo-led-note">' + H.esc(CAT_NOTE[c.kind]) + "</span></th></tr>";
      if (A.itemized) {
        lines += c.items.length ? c.items.map(function (it) {
          return ledgerRow((c.kind === "Drop" ? "Drop" : c.kind === "Trade" ? "Trade" : "Adjustment") + (it.player ? " · " + H.esc(H.displayName(it.player)) : "") + (it.when ? ' <span class="fo-muted">' + H.esc(it.when) + "</span>" : ""), it.amount, "", true);
        }).join("") : ledgerRow('<span class="fo-muted">None</span>', 0, "", true);
      } else {
        lines += ledgerRow('<span class="fo-muted">Itemized list unavailable (MFL’s adjustments feed didn’t load); total from the worker</span>', c.exact, "", true);
      }
      if (c.kind === "Drop" && c.rounding) lines += ledgerRow("Rounding to the nearest $1,000 (canon §6)", c.rounding, "fo-led-round", true);
      return lines + ledgerRow("Total " + H.esc(c.label.toLowerCase()), c.total, "fo-led-sub", true);
    }).join("") + ledgerRow("Total adjustments", A.total, "fo-led-total", true);
    var ns = led.nextSeason && (led.nextSeason.items || []).length ? '<h4 class="fo-tf-h">' + H.esc(String(led.nextSeasonYear || "Next season")) + " cap — not in this total</h4>" +
      '<p class="fo-ov-sub">Drops after the FA Auction start count on next season’s cap and reach MFL at the rollover.</p><table class="fo-table fo-led">' +
      led.nextSeason.items.map(function (it) { return ledgerRow((/rule ?2/i.test(String(it.kind || "")) ? "RULE 2 fine" : "Drop") + (it.player ? " · " + H.esc(H.displayName(it.player)) : ""), Number(it.amount) || 0, "", true); }).join("") + "</table>" : "";
    return '<p class="fo-ov-sub">' + H.esc(led.name) + "’s " + H.esc(String(FO.season)) + " cap adjustments, from MFL’s salary adjustments. A + amount adds to your cap total; a − amount frees cap.</p>" +
      '<table class="fo-table fo-led">' + rows + "</table>" + check(A.reconciles && A.total === led.capSnapshot.adjTotal, "Adds up, and equals the cap card’s salary adjustments.") + ns;
  }
  function check(ok, text) {
    return ok ? '<p class="fo-led-check ok">✓ ' + H.esc(text) + "</p>" : '<p class="fo-led-check bad">These lines don’t add up to the cap card. Reload; if it persists, the cap card is the source of truth.</p>';
  }
  function openLedger(kind) {
    var fid = focusFid(), led = fid && FO.capLedger ? FO.capLedger(fid) : null;
    if (!led) return;
    if (kind === "players") H.openDialog("Player salaries · " + H.money(led.players.total), playersLedgerHtml(led));
    else H.openDialog("Salary adjustments · " + smoney(led.adjustments.total), adjustmentsLedgerHtml(led));
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

  function mflDeadline() {
    var e = DATA.get("mflCalendar");
    return e && e.state === "ok" ? tradeDeadlineFrom(e.data, Date.now()) : null;
  }
  function deadlineCard() {
    var e = DATA.get("mflCalendar"), td = mflDeadline(), body;
    if (!e) body = stat("…", "reading MFL’s calendar");
    else if (e.state !== "ok") body = stat("—", "Sign in to MFL to see when MFL stops trades");
    else if (!td) body = stat("—", "no “No Trades Allowed” event on MFL’s calendar");
    else if (td.state === "closed") body = stat("Closed", "MFL stopped trades " + td.label);
    else body = stat(td.days === 0 ? "Today" : td.days + " day" + (td.days === 1 ? "" : "s"), "MFL stops trades " + td.label);
    return card("Trade deadline", '<div class="fo-ov-stats">' + body + "</div>",
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

  function load() {
    var keys = ["scores", "players", "league", "byes", "picks", "waiverState", "waiverAvailability", "waiverPending", "mflCalendar"];
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
      "<b>Lineup strength</b> is built from each team’s own roster: the best legal lineup, in the slots MFL’s lineup settings define, from its available rostered players. A replacement free agent fills a slot only when no rostered player can play it, and the card marks that row with *.</p>" +
      "<p><b>By Position</b> counts each starter at his own position (a TE in Flex is TE). <b>By Lineup Slot</b> shows the same lineup by slot: QB, RB, WR, TE, Flex, Superflex, DL, LB, DB, IDP Flex, K, P; a second TE who starts is Flex, a second QB is Superflex. Each starter counts once, and each breakdown’s rows add up to Overall. " +
      "Biggest need is always by position: that is the trade to look for.</p>" +
      "<p><b>PPG</b> (the default) = modeled starters’ points a week. <b>Rank</b> = 1st–12th by that PPG. <b>Above Replacement</b> = the raw points a week above replacement: Σ(starter PPG − replacement-level PPG), 0 = replacement level. Replacement level is the 3rd-best free agent at QB/RB/WR/TE, 6th at K/P, 12th at IDP; By Lineup Slot, a Flex or Superflex slot uses the best of those the slot accepts. Rank and Index are the league-relative measures. " +
      "<b>Index</b> = PPG ÷ the league <b>mean</b> × 100: 100 = average. The Trade finder’s matrix reads the same lineups, so its position cells match By Position, Above Replacement.</p>" +
      "<p><b>Starter Mix</b> is different: the <b>actual</b> starters per week from the lineups submitted to MFL in completed weeks, by each player’s own position. MFL records who started, not which slot: a second QB can only be Superflex and an extra DL/LB/DB only IDP Flex, while extra RB/WR/TE starters are shown together as Flexible slots. A week whose lineup doesn’t fill every slot is listed and left out, never averaged in.</p>" +
      "<p><b>Cap:</b> player salaries + salary adjustments = total allocated, the contract ledger’s own math. <b>Trade deadline:</b> MFL’s calendar (“No Trades Allowed”), shown in Eastern time.</p>");
    var el = document.getElementById("fo-overview-body");
    if (el && !el.__foLedger) {
      el.__foLedger = true;
      el.addEventListener("click", function (ev) {
        var b = ev.target && ev.target.closest ? ev.target.closest("[data-ov-ledger],[data-ls-view],[data-ls-by]") : null;
        if (!b) return;
        if (b.hasAttribute("data-ov-ledger")) { openLedger(b.getAttribute("data-ov-ledger")); return; }
        if (b.hasAttribute("data-ls-by")) lsBy = b.getAttribute("data-ls-by");
        else lsView = b.getAttribute("data-ls-view");
        render();
      });
    }
    render();
    load();
  }
  if (root.UPS_FO_HUB) root.UPS_FO_HUB.registerView("overview");
  root.UPS_FO_OVERVIEW = { tradeDeadlineFrom: tradeDeadlineFrom,
    // Test seam: render the Lineup strength card with given hub/data stand-ins, breakdown and measure.
    _strengthCard: function (fid, deps, by, view) {
      H = deps.H; FO = deps.FO; DATA = deps.DATA;
      if (by) lsBy = by;
      if (view) lsView = view;
      return strengthCard(fid, root.UPS_TRADE_FIT);
    } };
  document.addEventListener("fo:ready", boot);
  document.addEventListener("fo:tab", function (e) { if (e.detail && e.detail.section === "overview") render(); });
  document.addEventListener("fo:events", render);
  document.addEventListener("fo:injury", render);
})(typeof window !== "undefined" ? window : this);
