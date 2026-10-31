/* Front Office → Overview (#1338): only what needs the owner's attention,
   each item linked to the exact place to act. Read-only.

   Sources (one read each per visit, all through fo_data.js): the rosters,
   contracts and cap Front Office already loaded; MFL's season scores and
   players; MFL bye weeks and future picks; the league's waiver state,
   availability and (signed in) MFL's held claims; the shared injury chip.
   Models: site/shared/bye_planner.js (lineup holes), site/shared/trade_fit.js
   + site/shared/lineup_strength.js (lineup strength: By Position and
   By Lineup Slot over one modeled lineup per team, four measures; shown in Trade finder, not on the Overview), on the
   slots MFL's league settings define; site/shared/starter_mix.js (the
   Actual starter mix, from the lineups owners submitted). Cap: the Front Office's own cap
   engine (UPS_FO.capFor / capLedger). Trade deadline: MFL's own trade lock as the
   worker reads it (trade_lock on /api/league-events) — the one source every surface uses.
*/
(function (root) {
  "use strict";

  var H, FO, DATA;
  var BLOCKING = { waivers_later: 1, game_locked: 1, not_before_kickoff: 1, closed: 1, unknown: 1 };
  var rendering = false, queued = false;

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
  // When MFL stops accepting trades: the worker's read of MFL's own lock (trade_lock on /api/league-events — the earliest
  // "No Trades Allowed" event in force, week-based locks where MFL places them). The same read drives the phone, Team
  // Operations, the reminders and Rules. Closed from the second after the start, as MFL enforces it. → {state, startMs,
  // days, label} | {state: "unresolved"|"none"} | null (not read yet).
  function tradeDeadlineFromLock(lock, nowMs) {
    if (!lock) return null;
    if (lock.state !== "upcoming" && lock.state !== "closed") return { state: lock.state === "none" ? "none" : "unresolved" };
    var t = Number(lock.start_unix) * 1000;
    if (!(t > 0)) return { state: "unresolved" };
    var d0 = etParts(nowMs), d1 = etParts(t);
    var v = Date.parse(lock.verified_at_utc || "");
    return { state: nowMs >= t + 1000 ? "closed" : "upcoming", startMs: t,
      days: d0 != null && d1 != null ? Math.round((d1 - d0) / 86400000) : null, label: lock.label || etLabel(t),
      verified: isFinite(v) ? etLabel(v) : "" };
  }

  // ── Attention checks: loaded / unavailable / found items → one summary (pure; tested) ──
  // Each check runs on named sources. A source is { name, state: "ok"|"unavailable"|"loading", at, note }: at = the ms
  // that source's answer arrived (fo_data entry.at / the Front Office's own read time / the worker's MFL-verified time).
  // A DATA entry (fo_data.js: { state: "ok"|"error", at }) → a source; no entry yet = still loading.
  function sourceFromEntry(name, entry) {
    if (!entry) return { name: name, state: "loading", at: 0 };
    return { name: name, state: entry.state === "ok" ? "ok" : "unavailable", at: Number(entry.at) || 0 };
  }
  // Sources → one check state: any unavailable → unavailable; else any not yet read → loading; else ok. "Checked" is the
  // OLDEST source read, so the time never claims fresher data than the check used.
  function combineSources(parts) {
    var bad = [], wait = 0, at = 0, notes = [];
    (parts || []).forEach(function (p) {
      if (!p) return;
      if (p.state === "unavailable") { bad.push(p); if (p.note) notes.push(p.note); }
      else if (p.state !== "ok") wait++;
      if (p.at > 0 && (!at || p.at < at)) at = p.at;
    });
    var plain = bad.filter(function (p) { return !p.note; }).map(function (p) { return p.name; });
    if (plain.length) notes.unshift(plain.join(" and ") + " didn’t load");
    return { state: bad.length ? "unavailable" : wait ? "loading" : "ok", at: bad.length || wait ? 0 : at, note: notes.join("; ") };
  }
  // "checked 9:42 AM" (viewer's clock); a read from another day adds the date.
  function checkedLabel(at, nowMs) {
    if (!(at > 0)) return "checked";
    var d = new Date(at), n = new Date(nowMs || Date.now()), h = d.getHours(), m = d.getMinutes();
    var t = ((h % 12) || 12) + ":" + (m < 10 ? "0" : "") + m + " " + (h < 12 ? "AM" : "PM");
    var sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
    return "checked " + (sameDay ? "" : ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()] + " " + d.getDate() + ", ") + t;
  }
  // checks: [{ id, label, state, at, note, items: [html] }] in display order → { items, allClear, unavailable, loading, rows }.
  // All clear ONLY when every check loaded and found nothing; an unavailable or still-loading check is never all clear.
  function summarizeChecks(checks, nowMs) {
    var items = [], unavailable = [], loading = [], rows = [];
    (checks || []).forEach(function (c) {
      var st = c.state === "ok" ? "ok" : c.state === "unavailable" ? "unavailable" : "loading";
      (c.items || []).forEach(function (x) { items.push(x); });
      if (st === "unavailable") unavailable.push(c.label);
      if (st === "loading") loading.push(c.label);
      rows.push({ id: c.id, label: c.label, state: st, note: st === "unavailable" ? (c.note || "") : "",
        status: st === "ok" ? checkedLabel(c.at, nowMs) : st === "unavailable" ? "check unavailable" : "checking…" });
    });
    return { items: items, unavailable: unavailable, loading: loading, rows: rows,
      allClear: rows.length > 0 && !items.length && !unavailable.length && !loading.length };
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

  // Waiver claims check: MFL's held claims are the viewer's own (a 401 = not signed in to MFL: the check can't run,
  // never "no claims"); the league's availability says which of them MFL will refuse.
  function claimsCheck() {
    var pend = DATA.get("waiverPending"), av = DATA.get("waiverAvailability"), items = [];
    var ps = sourceFromEntry("MFL’s claims", pend);
    if (pend && (pend.state !== "ok" ? /HTTP 40[13]/.test(String(pend.error || "")) : !pend.data || pend.data.known !== true)) {
      ps = { name: ps.name, state: "unavailable", at: 0, note: "sign in to MFL" };
    }
    var parts = [ps];
    if (ps.state === "ok") {
      var picks = [];
      H.asArray(pend.data.rounds).forEach(function (r) { H.asArray(r && r.picks).forEach(function (pk) { picks.push(pk); }); });
      if (picks.length) {
        var as = sourceFromEntry("waiver availability", av);
        if (as.state === "unavailable") as.note = "couldn’t check whether MFL will refuse them";
        parts.push(as);
        var pidx = H.playerIndex(), refuse = [];
        var a = av && av.state === "ok" ? av.data : null;
        picks.forEach(function (pk) {
          var pid = String(pk.add_pid || pk.add || pk.player_id || "");
          var pl = pidx[pid] || {};
          var st = a && a.known ? ((a.players && a.players[pid]) || (a.by_team && a.by_team[pl.team]) || a.no_game) : null;
          if (st && BLOCKING[st.code]) refuse.push(H.displayName(pl.name || pid) + " (" + (st.badge || st.headline || st.code) + ")");
        });
        items.push(item(refuse.length ? "warn" : "info",
          H.esc(picks.length + " claim" + (picks.length === 1 ? "" : "s") + " held at MFL") +
          (refuse.length ? ' · <b>MFL will refuse ' + refuse.length + "</b>: " + H.esc(refuse.join(", ")) : ""), H.goLink("moves", "Claims")));
      }
    }
    return makeCheck("claims", "Waiver claims", parts, items);
  }
  function makeCheck(id, label, parts, items) {
    var c = combineSources(parts);
    return { id: id, label: label, state: c.state, at: c.at, note: c.note, items: items || [] };
  }
  // A read the Front Office makes itself (rosters, league events) as a source.
  function foSource(name, key) {
    var r = FO.readState ? FO.readState(key) : null;
    return r ? { name: name, state: r.state === "ok" ? "ok" : "unavailable", at: Number(r.at) || 0 } : { name: name, state: "loading", at: 0 };
  }
  // MFL's trade lock as the cards read it: the worker's trade_lock, or "unresolved" once the league-events read
  // finished without one (never "reading…" forever).
  function tradeLockNow() {
    var lock = FO.tradeLock ? FO.tradeLock() : null;
    var r = FO.readState ? FO.readState("leagueEvents") : null;
    return lock || (r ? { state: "unresolved" } : null);
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
    var wk = currentWeek(ss);
    var vals = H.values(0);
    var checks = [];

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

    // ── needs attention: one check per kind of item, each knowing whether its data loaded and when ──
    // Sources' "checked" times: rosters / league events = when this page's read of them arrived (front_office.js
    // STATE.reads); MFL scores, bye weeks, claims, availability = fo_data.js entry.at (when the read finished);
    // the injury report = the shared loader's at; the trade lock = the worker's verified_at_utc when it sends one.
    var rosters = foSource("rosters", "rosters"), events = foSource("the league calendar", "leagueEvents");
    var capItems = [];
    if (cap) {
      if (cap.capSpace < 0) capItems.push(item("bad", "Over the cap by <b>" + H.money(-cap.capSpace) + "</b>.", H.goLink("cap", "Cap plan")));
      if (cap.activeN > cap.activeMax) capItems.push(item("bad", "<b>" + (cap.activeN - cap.activeMax) + "</b> over the active-roster max (" + cap.activeMax + ").", H.goLink("roster", "Players")));
      if (cap.activeN < cap.activeMin) capItems.push(item("bad", "<b>" + (cap.activeMin - cap.activeN) + "</b> under the active-roster minimum (" + cap.activeMin + "). Adds happen in the phone app’s Market.", H.goLink("market", "Market")));
    }
    checks.push(makeCheck("cap", "Cap and roster size", [cap ? rosters : { name: "the cap", state: rosters.state === "loading" ? "loading" : "unavailable", at: 0 }], capItems));

    var BP = root.UPS_BYE_PLANNER;
    var teams = H.modelTeams();
    var mine = teams.filter(function (t) { return t.fid === fid; })[0];
    var scoresEntry = DATA.get("scores"), byesEntry = DATA.get("byes");
    // The lineup model needs MFL's scores (known, with a lineup week) and MFL's bye weeks.
    var scoresSrc = sourceFromEntry("MFL scores", scoresEntry);
    if (scoresSrc.state === "ok" && (!ss || !wk)) scoresSrc = { name: "MFL scores", state: "unavailable", at: 0 };
    var lineupParts = [scoresSrc, sourceFromEntry("bye weeks", byesEntry)];
    if (!BP || !mine) lineupParts.push({ name: "the lineup model", state: rosters.state === "loading" ? "loading" : "unavailable", at: 0 });
    var plan = null;
    if (combineSources(lineupParts).state === "ok") {
      plan = BP.plan({ players: mine.players, values: vals, byeWeekByTeam: BP.byesFromMfl(byesEntry.data),
        fromWeek: wk, toWeek: Math.min(17, wk + 2), currentWeek: wk });
    }
    // Players in the best lineup by season PPG who carry an injury designation (the selection is unchanged; the alert no longer calls them starters).
    var injItems = [];
    if (plan && team) {
      var hurt = [];
      Object.keys(plan.fullStarters).forEach(function (pid) {
        var p = team.players.filter(function (x) { return String(x.id) === pid; })[0];
        if (!p) return;
        var chip = H.injuryChip(p);
        if (chip) hurt.push(H.playerButton(p.id, fid, H.displayName(p.name)) + chip);
      });
      if (hurt.length) injItems.push(item("warn", "Check injury status before setting your lineup: " + hurt.join(", "), H.goLink("roster", "Players")));
    }
    if (team) {
      var disagree = team.players.filter(function (p) { var r = FO.injury(p); return r && r.warning; });
      if (disagree.length) injItems.push(item("warn", "Injury sources disagree for " + disagree.map(function (p) { return H.playerButton(p.id, fid, H.displayName(p.name)); }).join(", ") + ".", ""));
    }
    var inj = DATA.injuryState ? DATA.injuryState() : null;
    var injSrc = !inj || inj.state === "idle" || inj.state === "loading" ? { name: "the injury report", state: "loading", at: 0 }
      : { name: "the injury report", state: inj.state === "ok" ? "ok" : "unavailable", at: Number(inj.at) || 0 };
    checks.push(makeCheck("injury", "Injuries", lineupParts.concat([injSrc]), injItems));

    var lineupItems = [];
    if (plan) {
      plan.weeks.forEach(function (w) {
        if (w.empty.length) {
          var labels = Object.keys(w.emptyGroups).map(function (g) { return w.emptyGroups[g] + " " + g; });
          lineupItems.push(item("bad", "<b>Week " + w.week + "</b>: no eligible player for " + H.esc(labels.join(", ")) + " (an empty lineup slot).", H.goLink("bye", "Bye planner")));
        }
      });
    }
    checks.push(makeCheck("lineup", "Lineup and byes", lineupParts, lineupItems));

    // Contract windows that close soon (the same eligibility the Contracts lists use; the windows come from the
    // league calendar the Front Office reads with /api/league-events).
    var mym = [], ctItems = [];
    if (team) {
      team.players.forEach(function (p) {
        var e = FO.eligibility(p);
        if (!e) return;
        if (e.extensionEligible) {
          var dl = FO.extensionDeadline(p);
          if (dl && dl.days_until != null && dl.days_until <= 14) {
            ctItems.push(item(dl.days_until <= 3 ? "bad" : "warn", "Extension window for " + H.playerButton(p.id, fid, H.displayName(p.name), "") +
              " closes in <b>" + dl.days_until + " day" + (dl.days_until === 1 ? "" : "s") + "</b>" + (dl.date ? " (" + H.esc(H.dayLabel(dl.date.getTime ? dl.date.getTime() : dl.date)) + ")" : "") + ".", H.goLink("extensions", "Extensions")));
          }
        }
        if (e.mymEligible) mym.push(H.playerButton(p.id, fid, H.displayName(p.name)) + (e.mymDaysSinceAcq != null ? ' <span class="fo-ov-via">day ' + e.mymDaysSinceAcq + " of 14</span>" : ""));
      });
    }
    if (mym.length) ctItems.push(item("warn", "Mid-Year Multi window open for " + mym.length + " player" + (mym.length === 1 ? "" : "s") + ": " + mym.join(", ") + ".", H.goLink("mym", "MYM")));
    checks.push(makeCheck("contracts", "Contract windows", [team ? rosters : { name: "rosters", state: rosters.state === "loading" ? "loading" : "unavailable", at: 0 }, events], ctItems));

    checks.push(claimsCheck());

    var lock = tradeLockNow(), tdl = mflDeadline(), dlItems = [];
    if (tdl && tdl.state === "upcoming" && tdl.days != null && tdl.days <= 14) {
      dlItems.push(item("warn", "MFL stops accepting trades in <b>" + tdl.days + " day" + (tdl.days === 1 ? "" : "s") + "</b> (" + H.esc(tdl.label) + ").", H.goLink("trades", "Trade finder")));
    }
    var lockSrc = events;
    if (events.state === "ok") {
      var vAt = Date.parse((lock && lock.verified_at_utc) || "");
      lockSrc = !lock || lock.state === "unresolved" || !(lock.state === "none" || tdl)
        ? { name: "MFL’s trade lock", state: "unavailable", at: 0, note: "MFL’s trade lock couldn’t be read" }
        : { name: "MFL’s trade lock", state: "ok", at: isFinite(vAt) ? vAt : events.at };
    }
    checks.push(makeCheck("deadline", "Trade deadline", [lockSrc], dlItems));

    var sum = summarizeChecks(checks, Date.now());
    var needs = '<section class="fo-ov-card fo-ov-needs"><h3>Needs attention</h3>' +
      (sum.items.length ? '<ul class="fo-ov-list">' + sum.items.join("") + "</ul>" : "") +
      (sum.allClear ? '<p class="fo-ov-empty">Nothing needs you right now.</p>'
        : !sum.items.length && !sum.unavailable.length ? '<p class="fo-ov-empty">Checking…</p>' : "") +
      (sum.unavailable.length ? H.banner("Couldn’t check " + sum.unavailable.join(", ") + ", so this list may be incomplete.", "warn") : "") +
      checksHtml(sum.rows) +
      "</section>";

    // Draft picks sits beside Needs attention, one card wide (Keith 2026-10-26: the strength card is off the Overview
    // for launch; every team's lineup strength lives in Trade finder).
    var side = picksCard(fid);

    el.innerHTML = row + '<div class="fo-ov-grid"><div class="fo-ov-main">' + needs + '</div><div class="fo-ov-side">' + side + "</div></div>";
    if (ss) H.setFreshness("MFL read " + H.clock(ss.fetchedAt));
  }
  // Every check, compact: "Lineup and byes · checked 9:42 AM" or "· check unavailable (bye weeks didn't load)".
  function checksHtml(rows) {
    return '<ul class="fo-ov-checks" aria-label="Checks">' + rows.map(function (r) {
      return '<li class="fo-ov-ck is-' + r.state + '" data-ov-check="' + H.esc(r.id) + '"><span class="fo-ov-ck-lbl">' + H.esc(r.label) +
        '</span> <span class="fo-ov-ck-st">' + H.esc(r.status) + (r.note ? " (" + H.esc(r.note) + ")" : "") + "</span></li>";
    }).join("") + "</ul>";
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
    var td = tradeDeadlineFromLock(tradeLockNow(), Date.now());
    return td && td.startMs ? td : null;
  }
  function deadlineCard() {
    var td = tradeDeadlineFromLock(tradeLockNow(), Date.now()), body;
    if (!td) body = stat("…", "reading MFL’s trade lock");
    else if (td.state === "unresolved") body = stat("—", "MFL’s trade lock couldn’t be read right now");
    else if (td.state === "none") body = stat("—", "no “No Trades Allowed” event on MFL’s calendar");
    else if (td.state === "closed") body = stat("Closed", "MFL enforcement: trading stopped " + td.label);
    else body = stat(td.days === 0 ? "Today" : td.days + " day" + (td.days === 1 ? "" : "s"), "MFL enforcement: trading stops " + td.label);
    // The worker's read can be a few minutes old (it caches MFL's answer); say when it was verified.
    var verified = td && td.verified ? '<p class="fo-ov-sub">Verified with MFL ' + H.esc(td.verified) + ".</p>" : "";
    return card("Trade deadline", '<div class="fo-ov-stats">' + body + "</div>" + verified,
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
    var keys = ["scores", "players", "league", "byes", "picks", "waiverState", "waiverAvailability", "waiverPending"];
    keys.forEach(function (k) { DATA.load(k).then(render); });
    var f = root.UPS_FO_DATA;
    if (f) f.injury(render);
  }

  function boot() {
    H = root.UPS_FO_HUB; FO = root.UPS_FO; DATA = root.UPS_FO_DATA;
    if (!H || !FO || !DATA) return;
    H.setupAbout();
    H.registerAbout("overview",
      "<h3>Overview</h3><p>Only items that need you, each with a link to where you act. Lineup and bye checks use your best legal 18-player lineup by season points per MFL week. Draft picks are MFL’s own list. Lineup strength for every team is in Trade finder.</p>" +
      "<p><b>Cap:</b> player salaries + salary adjustments = total allocated, the contract ledger’s own math. <b>Trade deadline:</b> when MFL actually stops accepting trades (its “No Trades Allowed” lock, read by the league’s server), in Eastern time; “Closed” from the second MFL refuses.</p>");
    var el = document.getElementById("fo-overview-body");
    if (el && !el.__foLedger) {
      el.__foLedger = true;
      el.addEventListener("click", function (ev) {
        var b = ev.target && ev.target.closest ? ev.target.closest("[data-ov-ledger]") : null;
        if (!b) return;
        if (b.hasAttribute("data-ov-ledger")) openLedger(b.getAttribute("data-ov-ledger"));
      });
    }
    render();
    load();
  }
  if (root.UPS_FO_HUB) root.UPS_FO_HUB.registerView("overview");
  root.UPS_FO_OVERVIEW = { tradeDeadlineFromLock: tradeDeadlineFromLock, sourceFromEntry: sourceFromEntry, combineSources: combineSources,
    checkedLabel: checkedLabel, summarizeChecks: summarizeChecks };
  document.addEventListener("fo:ready", boot);
  document.addEventListener("fo:tab", function (e) { if (e.detail && e.detail.section === "overview") render(); });
  document.addEventListener("fo:events", render);
  document.addEventListener("fo:injury", render);
})(typeof window !== "undefined" ? window : this);
