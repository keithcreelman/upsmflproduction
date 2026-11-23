/* UPS 2027 Preview 0: draws the two screens as HTML strings. Pure functions of one state object, so they run the same in
   a phone, in the headless browser check and in the offline tests. Every piece of text that comes from a data source goes
   through esc(). There are no buttons that change anything: a row opens a profile, a chip opens an explanation, and that is all. */
(function (root, factory) {
  var req = typeof require === "function";
  var api = factory(
    req ? require("./format.js") : root.UPS2027.format,
    req ? require("./contract.js") : root.UPS2027.contract,
    req ? require("./model.js") : root.UPS2027.model,
    req ? require("./photo.js") : root.UPS2027.photo,
    req ? require("./sample.js") : root.UPS2027.sample,
    req ? require("./roster.js") : root.UPS2027.roster,
    req ? require("./tabviews.js") : root.UPS2027.tabviews,
    req ? require("./coverage.js") : root.UPS2027.coverage
  );
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.UPS2027 = root.UPS2027 || {}; root.UPS2027.views = api; }
})(typeof self !== "undefined" ? self : this, function (F, C, M, P, SM, R, TV, COV) {
  "use strict";

  var esc = F.esc, money = F.money, commonCode = F.commonCode;
  var NAVS = [
    ["home", "Home", "M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"],
    ["team", "Team", "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20c0-3.3 2.7-5 6-5s6 1.7 6 5M16 11a2.5 2.5 0 1 0 0-5M17 15c2.5.3 4 1.8 4 5"],
    ["market", "Market", "M3 12l9-9h8v8l-9 9zM15 8.5h.01"],
    ["league", "League", "M7 4h10v5a5 5 0 0 1-10 0zM7 6H4v2a3 3 0 0 0 3 3M17 6h3v2a3 3 0 0 1-3 3M12 14v4M8 21h8"]
  ];
  var LATER = {
    home: "Your lineup check, deadlines and what needs you. Home is reviewed last, so it is not in Preview 0.",
    market: "Find players, bids and waivers. Market is still in design review, so it is not in Preview 0.",
    league: "Standings, scores and schedule. Not in Preview 0."
  };

  // R9: K and P on every badge, heading and label (MFL's PK and PN remain the color class only)
  function posText(pos) { return pos === "PK" ? "K" : pos === "PN" ? "P" : pos; }
  function pcx(pos) { return '<span class="pc ' + esc(pos) + '">' + esc(posText(pos)) + "</span>"; }
  function chip(cls, text) { return '<span class="chip ' + cls + '">' + text + "</span>"; }
  function team(S) { return S.model && S.model.teams.filter(function (t) { return t.id === S.teamId; })[0] || (S.model && S.model.teams[0]) || null; }

  function skeletonRows(n) {
    var s = "";
    for (var i = 0; i < n; i++) s += '<div class="rx"><div class="in"><div class="sk w60"></div><div class="sk w40"></div></div><div class="sk w20"></div></div>';
    return s;
  }

  // R8: the heading and the freshness line are the first thing INSIDE the scrolling area (#scroll), so they scroll away; the Team tabs that follow
  // them stick to its top (.tabs.stk), and the marker above it stays one line.
  function header(title, asof) {
    return '<div class="hdw"><div class="hd"><h1>' + esc(title) + '</h1><button class="ib" data-act="about" aria-label="About this preview and display settings">ⓘ</button></div>' + (asof ? '<div class="asof">' + asof + "</div>" : "") + "</div>";
  }

  function asOfLine(S) {
    var m = S.model;
    if (!m) return S.load.core === "error" ? '<span class="wn">▲</span> Couldn’t reach the league data' : "Loading…";
    var t = F.etStamp(m.asOf);
    return '<span class="ok">✓</span> Data as of ' + esc(t || "just now") + (m.week ? " · Week " + m.week : "");
  }

  // ---------- Team screen ----------
  // The team picker row carries the Team screen's ONE help control (ⓘ). Its text depends on the tab (tabviews.helpHtml).
  function teamPicker(t) {
    return '<div class="tprow"><button class="tp" data-act="teams" aria-label="Viewing ' + esc(t.name) + '. Change team">' +
      '<span class="tpi"><img alt="" data-chain="' + esc(JSON.stringify(t.icon ? [t.icon] : [])) + '" referrerpolicy="no-referrer"></span>' +
      '<span class="tpt"><small>Viewing</small><b>' + esc(t.name) + "</b></span><span class=\"go\" aria-hidden=\"true\">▾</span></button>" +
      '<button class="ib" data-act="help" aria-label="Help for this screen">ⓘ</button></div>';
  }
  function helpSheet(S) {
    return '<div class="layer"><div class="scrim" data-act="close"></div><div class="sheet" role="dialog" aria-modal="true" aria-label="Help for this screen" tabindex="-1"><div class="grab"></div><div class="top"><h3>Help</h3><button class="btn" data-act="close">Close</button></div><div class="helpb">' + TV.screenHelp(S) + "</div></div></div>";
  }

  function countsLine(t, lim) {
    function of(n, l) { return n + (l ? " of " + l : ""); }
    return '<div class="cap"><b>Active ' + of(t.counts.active, lim.roster) + "</b> · Taxi " + of(t.counts.taxi, lim.taxi) + " · IR " + of(t.counts.ir, lim.ir) + "</div>";
  }

  var VIEWS = [["lineup", "Lineup"], ["byes", "Byes"]];
  function seg(view) {
    return '<div class="seg" role="group" aria-label="Roster view">' +
      VIEWS.map(function (o) { return '<button data-act="view" data-v="' + o[0] + '" aria-pressed="' + (view === o[0]) + '">' + o[1] + "</button>"; }).join("") + "</div>";
  }

  // ---------- the week on screen ----------
  function weekBar(S, wi) {
    if (!wi.cur) return "";
    var past = wi.past;
    return '<button class="wsel' + (past ? " past" : "") + '" data-act="weeks" aria-label="Week ' + wi.sel + (past ? ", past" : ", current") + '. Change week"><span class="r1"><span class="w1">Week ' + wi.sel +
      '</span><span class="w2">' + (past ? "past" : "current") + '</span><span class="go" aria-hidden="true">▾</span></span>' +
      // R6: the current week carries no "As MFL has it" provenance chip; a past week keeps its "Played" label (it changes what is drawn)
      (past ? '<span class="r2">' + chip("", "Played · as MFL recorded it") + "</span>" : "") + "</button>";
  }
  function weekSheet(S) {
    var wi = R.weekInfo(S);
    return '<div class="layer"><div class="scrim" data-act="close"></div><div class="sheet" role="dialog" aria-modal="true" aria-label="Choose a week" tabindex="-1"><div class="grab"></div><div class="top"><h3>Choose a week</h3><button class="btn" data-act="close">Close</button></div>' +
      '<div class="ex">A past week shows that week’s lineup and scores as MFL recorded them, on Lineup. NFL opponents and bye weeks, injury status, rosters and contracts are only shown for the current week, and Byes always shows today’s data. Later weeks are not available in this preview.</div>' +
      R.weekChoices(wi.cur).map(function (c) {
        var label = c.kind === "current" ? "Current week" : c.kind === "past" ? "Played" : c.kind === "future" ? "Not available in this preview" : "Unavailable";
        var on = c.n === wi.sel, off = c.kind === "future" || c.kind === "unknown";
        return '<button class="so' + (off ? " off" : "") + '" data-act="pickweek" data-v="' + c.n + '"' + (off ? " disabled" : "") + ' aria-pressed="' + on + '"><span class="in"><b>Week ' + c.n + "</b><small>" + label + "</small></span>" + (on ? '<span class="ok">✓</span>' : "") + "</button>";
      }).join("") + "</div></div>";
  }

  // ---------- rows ----------
  function nw(text) { return '<span class="nw">' + esc(text) + "</span>"; } // keeps "@ CHI" or "vs MIA" from breaking in the middle on a narrow phone
  function statusWord(p) { return p.status === "ir" ? "injured reserve" : p.status === "taxi" ? "taxi squad" : "bench"; }

  // `o.wk` is the week the row speaks for; `o.tag` the starter's slot tag. A row in a past week shows only HISTORICAL facts (the recorded
  // lineup order and score); injury chips, opponents, kickoffs and cap notes are CURRENT and are drawn only for the current week.
  function row(p, S, o) {
    o = o || {};
    var wi = R.viewWeek(S), wk = o.wk != null ? o.wk : wi.cur, past = !!o.past;
    var team = p.nflTeam || "No NFL team"; // MFL's own code, as the roster rows have always printed it
    var small = "", right = "", chips = [];
    var view = past ? "past" : S.view;
    if (view === "byes") {
      // a row inside a bye group: the group already says which week, so the row says who he is to today's lineup. R9: the row carries his
      // position badge (the group is by position), never a lineup slot
      small = nw(team) + " · " + (o.starter ? (wi.cur ? "Week " + wi.cur + " starter" : "current starter") : statusWord(p)) + (p.bye && wi.cur && p.bye < wi.cur ? " · bye was Week " + p.bye : "");
      if (p.status === "ir") chips.push(R.irBadge());
    } else {
      var parts = [esc(team)];
      var inPlay = past || p.status === "active";
      if (p.status === "gone") { inPlay = false; parts = []; }
      // An IR row carries no return line: MFL's expected-return text is not shown (ruling 2026-11-20), and R6 drops the repeated
      // "Return: Unavailable" (return information is drawn only when a supported read gives it; none does yet).
      if (!past && p.status === "ir") { /* the section heading already says injured reserve */ }
      else if (!past && p.status === "taxi") parts.push(p.taxi.used == null ? "Call-ups unavailable" : p.taxi.used + "/" + (p.taxi.max || 3) + " call-ups");
      else if (past) {
        // MAT-1 (Codex, review of dc5b35d7): none of the reads says which NFL club a player was with in a past week, and his club today
        // may not be the one he played for then, so today's club cannot be used to look up that week's opponent or bye. The recorded
        // lineup and score stay; the club is labeled "now"; the opponent is Unavailable.
        if (p.status !== "gone") parts = [nw(esc(team) + " now"), nw("Opponent unavailable")];
      } else if (inPlay) {
        var opp = R.oppText(S, p, wk);
        if (opp) parts.push(nw(opp));
        if (S.view === "lineup") {
          // R6: every matchup on the Lineup view shows its kickoff in Eastern Time, Sunday 1:00 PM included; an unknown time says so
          var ko = R.onBye(p, wk) ? { state: "none" } : R.kickoffInfo(S, p, wk); // a bye has no kickoff
          if (ko.state === "known") parts.push(nw(ko.text)); else if (ko.state === "unknown") parts.push("Kickoff unavailable");
        }
      }
      if (p.status === "gone") parts.push("No longer on a UPS roster");
      else if (past && p.franchiseId && S.teamId && p.franchiseId !== S.teamId) parts.push("now on another team");
      if (view === "past") {
        // R2b, P4: the bold number is the recorded score of the past week chosen, labeled "Wk N" right under it. A score that is not recorded,
        // or a read that failed, says so; nothing is filled in.
        var rd = R.scoreRead(S, wk), sc = R.scoreOf(S, p.id, wk);
        right = '<div class="rt"><b>' + (rd === "loading" ? "…" : R.pts(sc)) + '</b><span class="mu sm">' + esc(rd === "error" ? "Unavailable" : "Wk " + wk) + "</span></div>";
      }
      small = parts.join(" · ");
    }
    if (!past) {
      // the same chips on both views (current information); a bye chip only for a starter on the Lineup view
      if (R.onBye(p, wk) && o.tag && S.view === "lineup") chips.push(chip("wn", "▲ Bye week"));
      var ic = R.injuryChip(S, p);
      if (ic) chips.push(ic.code === "IR" ? R.irBadge() : chip(ic.cls, esc(ic.text)));
    }
    // a past week's rows carry the recorded order (1, 2, 3 ...), never a slot or a position: neither is recorded for that week
    var sl = o.tag ? R.slotByTag(o.tag) : null;
    var tag = o.tag ? slotTag(sl || { tag: o.tag }, p) : o.ord ? '<span class="tag sl" role="img" aria-label="Recorded starter number ' + o.ord + '">' + esc(o.ord) + "</span>" : '<span class="tag pp">' + pcx(p.pos) + "</span>";
    return '<div class="rx' + (o.problem ? " prob" : "") + '">' + tag + '<div class="in"><button class="nm" data-act="card" data-pid="' + esc(p.id) + '" aria-label="' + esc(p.name) + ', open player profile"><span class="n1">' + esc(p.name) + "</span><small>" + small + "</small></button>" +
      (chips.length ? '<div class="fl">' + chips.join("") + "</div>" : "") + "</div>" + right + '<span class="go" aria-hidden="true">›</span></div>';
  }
  // R6: a starting slot's badge. A filled badge takes the position color of the player in it (a QB in SFX is QB-colored; the colors are the
  // existing ones, so K and P stay neutral); an empty one is neutral. The text label always stays, so color is never the only identifier, and
  // a flex badge also prints the occupying player's position under its label.
  var POS_CLS = /^(QB|RB|WR|TE|PK|PN|DL|LB|DB)$/;
  function slotTag(slot, p) {
    var pos = p && POS_CLS.test(p.pos) ? p.pos : "";
    var cls = "tag sl" + (pos ? " ps " + pos : "") + (slot.flex ? " fx" : "");
    if (!slot.flex) return '<span class="' + cls + '">' + esc(slot.tag) + "</span>";
    return '<span class="' + cls + '" role="img" aria-label="' + esc(slot.tag + ", " + slot.label + (p ? ", " + (posText(pos) || "position unknown") : ", empty")) + '"><b>' + esc(slot.tag) + "</b>" + (pos ? "<i>" + esc(posText(pos)) + "</i>" : "") + "</span>";
  }
  function emptyRow(slot, current) {
    return '<div class="rx empty' + (current ? " prob" : "") + '">' + slotTag(slot, null) + '<div class="in"><b>Empty</b></div></div>';
  }
  // A starter MFL names who is not in this roster read: no name, position, slot, bye or injury is claimed for him, and no lineup warning is drawn.
  function unresolvedRow(id) {
    return '<div class="rx"><div class="in"><b>Not in this roster read</b><small>Player ID ' + esc(id) + ' · MFL lists him as a starter</small><div class="fl">' + chip("wn", "Can’t check") + "</div></div></div>";
  }
  function unresolvedNote(n) {
    return n ? '<div class="ex wn mt4">' + n + (n === 1 ? " starter couldn’t be matched" : " starters couldn’t be matched") + " to this roster read, so checks that need " + (n === 1 ? "him" : "them") + " are skipped. Everyone else is still checked.</div>" : "";
  }

  // R6: Bench, Injured reserve and Taxi squad are one card each ("bench", "ir", "taxi"), open by default so the full list shows; the heading
  // collapses or expands it. R8: every bye group of the Byes view (bw<week>, bwpast, bwnone) starts collapsed; its heading already says the week and
  // which starters it leaves out.
  function groupDefault(S, key) {
    return !/^bw/.test(key);
  }
  function isOpen(S, key) { return S.open && S.open[key] !== undefined ? !!S.open[key] : groupDefault(S, key); }

  // One section card. `groups` is [{ pos, players }] for the bench (grouped by position, each under a small position label) or one
  // unlabeled group for injured reserve and taxi. An empty section is a heading only, with nothing to open.
  function section(S, key, title, count, groups, reasons) {
    reasons = reasons || [];
    var label = "<b>" + esc(title) + " · " + count + "</b>" + (reasons.length ? " " + chip("wn", "Needs you") : "");
    var n = groups.reduce(function (k, g) { return k + g.players.length; }, 0);
    if (!n) return '<div class="card rows lsec"><div class="lsh"><span class="t">' + label + "</span></div></div>";
    var open = isOpen(S, key);
    var head = '<button class="lsh" data-act="grp" data-g="' + esc(key) + '" aria-expanded="' + open + '"><span class="t">' + label + '</span><span class="chev" aria-hidden="true">' + (open ? "▾" : "▸") + "</span></button>";
    if (!open) return '<div class="card rows lsec">' + head + "</div>";
    var body = groups.map(function (g) {
      return (g.pos ? '<div class="lps">' + esc(posText(g.pos)) + " · " + g.players.length + "</div>" : "") + g.players.map(function (p) { return row(p, S, {}); }).join("");
    }).join("");
    return '<div class="card rows lsec">' + head + body + reasons.map(function (r) { return '<div class="ex lsr">' + esc(r) + ".</div>"; }).join("") + "</div>";
  }

  // ---------- summary lines ----------
  function sumCard(html) { return '<div class="card sumc">' + html + "</div>"; }
  // "n need attention", counted per starting slot (R.attention). R6: no "nothing needs attention" success wording; an injury read that is
  // not usable still says so, so a quiet line never claims injuries were checked.
  function attentionText(a) {
    var base = a.n ? a.n + (a.n === 1 ? " needs" : " need") + " attention" : a.injuriesChecked ? "" : "injuries not checked";
    var un = a.unresolved && a.unresolved.length ? a.unresolved.length + " can’t be checked" : "";
    return [base, un].filter(Boolean).join(" · ");
  }
  // R6: the one starter count, "Starting lineup · 18/18": the starters MFL lists over the slots of the lineup model (R.SLOTS, canon §B4).
  function slotCount() { return R.SLOTS.length; }
  function lineupCount(lineup) { return "Starting lineup · " + lineup.count + "/" + slotCount(); }
  function statusLine(S, lineup, wi, view) {
    var a = R.attention(S, lineup, wi.cur), at = attentionText(a);
    return sumCard("<b>" + lineupCount(lineup) + "</b>" + (at ? " · " + esc(at) : "") +
      (view !== "lineup" ? ' <button class="link" data-act="view" data-v="lineup">Open Lineup</button>' : ""));
  }
  // R6: the lineup warning, drawn ONLY when there is an actual lineup issue (an Out, designated, Doubtful or bye starter, an empty slot, a
  // starter no slot takes, a starter not in the roster read, or MFL listing a different number of starting spots than the slot model). One
  // short line per issue; the name opens the profile. No success box and no read-only explanation (R2b's card is withdrawn).
  function lineupWarn(S, wi, lineup) {
    var cur = wi.cur, a = R.attention(S, lineup, cur), lim = S.model.limits.starters;
    var spots = lim != null && lim !== slotCount();
    if (!a.n && !a.unresolved.length && !spots) return "";
    var items = a.items.map(function (it) {
      var p = it.player, k = R.kickoffInfo(S, p, cur), isBye = it.issues.some(function (x) { return x.kind === "bye"; });
      // a player on a bye has no opponent or kickoff to show: the issue already says "Bye week"
      var rest = isBye ? [] : [nw(R.oppText(S, p, cur) || "Opponent unavailable"), k.state === "known" ? nw(k.text) : "Kickoff unavailable"];
      return '<div class="rx lw"><div class="in"><button class="nm" data-act="card" data-pid="' + esc(p.id) + '" aria-label="' + esc(p.name) + ', open player profile"><span class="n1">' + esc(it.slot.tag) + " · " + esc(p.name) + "</span><small><b class=\"wn\">" +
        esc(it.issues.map(function (x) { return x.text; }).join(" · ")) + "</b>" + (rest.length ? " · " + rest.join(" · ") : "") + "</small></button></div></div>";
    }).join("") + a.empties.map(function (sl) {
      return '<div class="rx lw"><div class="in"><b>' + esc(sl.tag) + ' · Empty</b><small>No starter is set for this slot</small></div></div>';
    }).join("") + (a.emptyCount ? '<div class="rx lw"><div class="in"><b>' + a.emptyCount + (a.emptyCount === 1 ? " slot has" : " slots have") + ' no starter</b><small>Counted even if every unmatched starter fills a slot</small></div></div>' : "") + a.extras.map(function (p) {
      return '<div class="rx lw"><div class="in"><button class="nm" data-act="card" data-pid="' + esc(p.id) + '" aria-label="' + esc(p.name) + ', open player profile"><span class="n1">' + esc(p.name) + "</span><small><b class=\"wn\">Starter fits no lineup slot</b> · " + esc(p.pos) + "</small></button></div></div>";
    }).join("");
    var at = attentionText(a);
    return '<div class="card warnc lwarn" role="status"><div class="lwh"><b class="wn">▲ ' + esc(at || "Check the lineup") + "</b></div>" + items + unresolvedNote(a.unresolved.length) +
      (spots ? '<div class="ex wn mt4">MFL lists ' + esc(lim) + " starting spots; this lineup has " + slotCount() + " slots.</div>" : "") + "</div>";
  }

  function lineupBlock(S, t, wi, lineup, past) {
    var lim = S.model.limits.starters || 18, wk = wi.sel;
    if (lineup.recorded) {
      // the recorded starters, in the recorded order, with the recorded count: no slots, no empty slots, no filled-slot count (MAT-2)
      return '<div class="grp"><span>Recorded starters · Week ' + wk + " · " + lineup.count + (lim ? " of " + lim : "") + '</span></div><div class="card rows">' +
        (lineup.starters.length ? lineup.starters.map(function (p, i) { return row(p, S, { ord: i + 1, wk: wk, past: true }); }).join("") : '<div class="rx"><div class="in"><b>No starters recorded</b></div></div>') + "</div>" +
        '<div class="ex pad">Listed in the order MFL recorded them. Slots and positions are not shown for a past week: no read gives a player’s slot or position in that week.</div>';
    }
    var held = !!(lineup.unresolved && lineup.unresolved.length); // an empty slot cannot be named while unmatched starters may fill it
    var rows = lineup.slots.map(function (x) {
      if (!x.player && held) return "";
      return x.player ? row(x.player, S, { tag: x.slot.tag, wk: wk, past: past, problem: !past && (R.onBye(x.player, wk) || (function () { var c = R.injuryChip(S, x.player); return !!(c && (c.kind === "out" || c.kind === "res")); })()) }) : emptyRow(x.slot, !past);
    }).concat(lineup.extra.map(function (p) { return row(p, S, { wk: wk, past: past }); }), (lineup.unresolved || []).map(unresolvedRow)).join("");
    return '<div class="card rows lsec"><div class="lsh"><span class="t"><b>' + esc(lineupCount(lineup)) + "</b></span></div>" + rows + "</div>";
  }

  // R2b, P6: the Byes view. Players grouped by bye week in week order from this week on; already-played byes are collapsed.
  // `subHtml` is HTML the caller has already escaped.
  function byeGroupHead(S, key, label, count, open, sub, subHtml) {
    return '<button class="gh" data-act="grp" data-g="' + esc(key) + '" aria-expanded="' + open + '"><span class="chev" aria-hidden="true">' + (open ? "▾" : "▸") + '</span><span class="t"><b>' + esc(label) + "</b>" + (sub ? "<small>" + esc(sub) + "</small>" : "") + (subHtml ? "<small>" + subHtml + "</small>" : "") + "</span></button>";
  }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
  // R9 (Keith, 2026-11-23): lineup coverage. Each week says whether the WHOLE legal lineup can still be filled from the active roster
  // (lib/coverage.js: an exact assignment, required slots first, then OFX/SFX/DFX by eligibility, never one player in two slots). Only a bye, or in
  // the current week an Out or an MFL designation, removes a player; Questionable and Doubtful never do. Taxi and IR players are options, kept apart.
  function shortLine(s) { return s.key + (s.flex ? " (" + s.acc.join("/") + ")" : "") + " · " + s.available + " available / " + s.required + " required"; }
  function coverageSub(cv) {
    var bits = [];
    if (cv.short.length) bits.push('<b class="wn">▲ Short ' + (cv.total - cv.filled) + ": " + esc(cv.short.map(function (s) { return s.key + " " + s.available + "/" + s.required; }).join(", ")) + "</b>");
    else bits.push("Full lineup " + cv.filled + "/" + cv.total);
    if (cv.absent.length) bits.push(esc(cv.absent.length + " out or designated"));
    if (!cv.injuriesChecked) bits.push("injuries not checked");
    return bits.join(" · ");
  }
  function pointsText(o) {
    return o.points.length ? "Recent: " + o.points.map(function (x) { return "Wk " + x.week + " " + x.text; }).join(" · ") : "Recent points not available";
  }
  // A taxi or IR option: who he is, the verified facts, and the obstacles that are his alone (chips beside him). No control changes anything.
  function optionRow(p, facts, obstacles, pointsLine) {
    var chips = obstacles.map(function (x) { return chip("wn", "▲ " + esc(x.text)); });
    return '<div class="rx"><span class="tag pp">' + pcx(p.pos) + '</span><div class="in"><button class="nm" data-act="card" data-pid="' + esc(p.id) + '" aria-label="' + esc(p.name) + ', open player profile"><span class="n1">' + esc(p.name) + "</span><small>" + facts + "</small><small>" + esc(pointsLine) + "</small></button>" +
      (chips.length ? '<div class="fl">' + chips.join("") + "</div>" : "") + '</div><span class="go" aria-hidden="true">›</span></div>';
  }
  function teamObstacleLines(list) { return list.map(function (x) { return '<div class="ex wn cvo">▲ ' + esc(x.text) + "</div>"; }).join(""); }
  function optionToggle(S, key, label) {
    var open = isOpen(S, key);
    return { open: open, html: '<button class="lsh cvt" data-act="grp" data-g="' + esc(key) + '" aria-expanded="' + open + '"><span class="t"><b>' + esc(label) + '</b></span><span class="chev" aria-hidden="true">' + (open ? "▾" : "▸") + "</span></button>" };
  }
  function taxiBlock(S, cv) {
    var tx = cv.taxi, tg = optionToggle(S, "bwtx" + cv.week, "Taxi options · " + plural(tx.eligible, "eligible", "eligible") + (tx.options.length > tx.eligible ? " of " + tx.options.length : ""));
    if (!tx.options.length) return '<div class="lsh cvt"><span class="t"><b>Taxi options · none</b><small>No taxi player fits the open slots.</small></span></div>';
    if (!tg.open) return tg.html;
    var head = tx.team.length ? teamObstacleLines(tx.team) : '<div class="ex cvo">An active roster spot is open. Cap room is not checked here.</div>';
    return tg.html + head + tx.options.map(function (o) {
      var facts = esc(F.commonCode(o.player.nflTeam) || "No NFL team") + " · " + esc(o.eligibility) + (o.eligible ? " · " + esc(o.leftText) : "");
      return optionRow(o.player, facts, o.obstacles, pointsText(o));
    }).join("");
  }
  function irBlock(S, cv, cur) {
    var ir = cv.ir;
    if (!ir.options.length) {
      var why = cv.week !== cur ? "The NFL injury report covers Week " + cur + " only." : !ir.checked ? "Injury status isn’t available right now." : "No IR player who fits has return evidence this week.";
      return '<div class="lsh cvt"><span class="t"><b>Possible IR returns · none</b><small>' + esc(why) + "</small></span></div>";
    }
    var tg = optionToggle(S, "bwir" + cv.week, "Possible IR returns · " + ir.options.length);
    if (!tg.open) return tg.html;
    return tg.html + teamObstacleLines(ir.team) + '<div class="ex cvo">Possible, not confirmed: the evidence is this week’s NFL report.</div>' + ir.options.map(function (o) {
      return optionRow(o.player, R.irBadge() + " " + esc(o.evidence), o.obstacles, pointsText(o));
    }).join("");
  }
  // The bye players of one week, grouped by their own position (never by a lineup or flex slot).
  function byPositionRows(S, players, cur, slotOf) {
    var groups = {};
    players.forEach(function (p) { (groups[p.pos] = groups[p.pos] || []).push(p); });
    var order = F.POS_ORDER.concat(Object.keys(groups).filter(function (k) { return F.POS_ORDER.indexOf(k) < 0; }));
    return order.filter(function (k) { return groups[k]; }).map(function (k) {
      return '<div class="lps">' + esc(k) + " · " + groups[k].length + "</div>" + groups[k].map(function (p) { return row(p, S, { starter: slotOf[p.id] !== undefined, wk: cur }); }).join("");
    }).join("");
  }
  function weekCard(S, cv, x, cur, slotOf) {
    var body = "";
    if (cv.short.length) {
      body += '<div class="cvs">' + cv.short.map(function (s) { return '<div class="cvl"><b class="wn">' + esc(shortLine(s)) + "</b></div>"; }).join("") + "</div>";
      body += taxiBlock(S, cv) + irBlock(S, cv, cur);
    }
    if (cv.absent.length) {
      body += '<div class="lps">Not counted · out or designated · ' + cv.absent.length + "</div>" + cv.absent.map(function (a) { return row(a.player, S, { starter: slotOf[a.player.id] !== undefined, wk: cur }); }).join("");
    }
    if (x && x.players.length) body += (cv.short.length || cv.absent.length ? '<div class="lps">On bye · ' + x.players.length + "</div>" : "") + byPositionRows(S, x.players, cur, slotOf);
    else if (!cv.absent.length && !cv.short.length) body += '<div class="rx"><div class="in"><small>No one is on bye this week.</small></div></div>';
    return '<div class="card rows lsec cvc">' + body + "</div>";
  }
  function byesBody(S, t, wi, lineup) {
    var cur = wi.cur, g = R.byeGroups(S, t, cur, lineup), out = "";
    var byWeek = {}; g.groups.forEach(function (x) { byWeek[x.week] = x; });
    var wks = Object.keys(byWeek).map(Number); if (cur && !byWeek[cur]) wks.push(cur);
    wks.sort(function (a, b) { return a - b; });
    var covs = wks.map(function (w) { return COV.week(S, t, w); });
    var shortWks = covs.filter(function (c) { return c.short.length; });
    out += sumCard("<b>Lineup coverage</b> · " + (shortWks.length ? '<span class="wn">▲ Short in ' + esc(shortWks.map(function (c) { return "Week " + c.week + " (" + c.short.map(function (s) { return s.key; }).join(", ") + ")"; }).join(" · ")) + "</span>" : "A full lineup can be set in every week below") +
      (covs.some(function (c) { return !c.injuriesChecked; }) ? " · injuries not checked" : ""));
    covs.forEach(function (cv) {
      var x = byWeek[cv.week], n = x ? x.players.length : 0, key = "bw" + cv.week, open = isOpen(S, key);
      out += byeGroupHead(S, key, (cv.week === cur ? "This week · Week " : "Week ") + cv.week + " · " + (n ? n + " on bye" : "no byes"), n, open, "", coverageSub(cv));
      if (open) out += weekCard(S, cv, x, cur, g.slotOf);
    });
    if (g.past.length) {
      var open2 = isOpen(S, "bwpast");
      out += byeGroupHead(S, "bwpast", "Already played · " + g.past.length + " player" + (g.past.length === 1 ? "" : "s"), g.past.length, open2, "their bye week has passed");
      if (open2) out += '<div class="card rows">' + g.past.map(function (p) { return row(p, S, { starter: g.slotOf[p.id] !== undefined, wk: cur }); }).join("") + "</div>";
    }
    if (g.none.length) {
      var open3 = isOpen(S, "bwnone");
      out += byeGroupHead(S, "bwnone", "Bye week unavailable · " + g.none.length + " player" + (g.none.length === 1 ? "" : "s"), g.none.length, open3, "no bye week on file");
      if (open3) out += '<div class="card rows">' + g.none.map(function (p) { return row(p, S, { starter: g.slotOf[p.id] !== undefined, wk: cur }); }).join("") + "</div>";
    }
    return out;
  }

  // Contracts and Byes are always "as of now" (R2b, P2): a plain line instead of the week bar, so a past week is never shown over today's data.
  function nowLine(wi) {
    return sumCard("<b>As of now" + (wi.cur ? " · Week " + wi.cur : "") + "</b> · This view always shows today’s roster, injuries and lineup.");
  }

  // Roster data that does not hold together is said so, once, in place of everything that would be judged from it (starters, bench, contracts,
  // performance, warnings). Nothing is guessed in its place.
  function dataUnavailableCard(S, t, coh) {
    return '<div class="card warnc" role="alert"><h2>Roster and lineup data don’t match</h2><div class="ex">MFL’s Week ' + esc(S.model.week) + " lineup lists " + coh.total + " starters, but " + coh.unresolved +
      " of them are not on this team’s roster in the data that loaded (the roster has " + coh.active + " active player" + (coh.active === 1 ? "" : "s") + "). The roster read may be incomplete, so starters, bench, contracts, scores and lineup warnings are not shown for this team. Nothing is guessed.</div>" +
      '<button class="btn blk" data-act="retry">Reload the data</button></div>';
  }
  function rosterBody(S) {
    var t = team(S), m = S.model, sel = R.weekInfo(S), wi = R.viewWeek(S), out = "";
    var weekAware = S.view === "lineup";
    out += teamPicker(t) + countsLine(t, m.limits);
    var coh = R.lineupCoherence(S, t);
    if (!coh.ok) return out + dataUnavailableCard(S, t, coh);
    if (S.load.core !== "ok" && S.load.coreNotes && S.load.coreNotes.length) {
      out += '<div class="card warnc"><h2>Not everything loaded</h2>' + S.load.coreNotes.map(function (n) { return '<div class="ex">' + esc(n) + "</div>"; }).join("") + "</div>";
    }
    out += (weekAware ? weekBar(S, sel) : nowLine(wi)) + seg(S.view);

    // A past week (Lineup and Performance only): only what MFL recorded for that week.
    if (weekAware && sel.past) {
      out += sumCard("<b>Week " + sel.sel + " · played</b> · Lineup and scores are from that week. NFL opponents and bye weeks are Unavailable for a past week: no read says which NFL team a player was with then, and his team today could be the wrong one. Injury status, rosters and contracts are as of now, so none of them is drawn here.<div><button class=\"link\" data-act=\"pickweek\" data-v=\"" + sel.cur + "\">Go to Week " + sel.cur + " (current)</button></div>");
      var pl = R.lineupFor(S, t, sel.sel);
      if (pl.state === "loading") return out + '<div class="card rows" aria-busy="true">' + skeletonRows(6) + '</div><div class="mu ctr sm">Loading Week ' + sel.sel + "…</div>";
      if (pl.state !== "ok") return out + '<div class="card warnc"><h2>Week ' + sel.sel + '</h2><div class="ex">' + (pl.state === "missing" ? "MFL has no lineup recorded for this team in that week." : "That week’s lineup could not be read" + (pl.error ? " (" + esc(pl.error) + ")" : "") + ". Nothing is guessed in its place.") + '</div><button class="btn blk" data-act="pickweek" data-v="' + sel.sel + '">Try again</button></div>';
      return out + lineupBlock(S, t, sel, pl, true) + '<div class="ex pad">Bench, injured reserve and taxi are not shown for past weeks: rosters change, and a roster drawn here would be today’s, not that week’s.</div>';
    }

    var cur = wi.cur, lineup = t.lineup.state === "ok" ? R.lineupFor(S, t, cur) : null;
    var inj = R.injuryNote(S);
    if (lineup && lineup.state === "ok") {
      if (S.view === "lineup") out += lineupWarn(S, wi, lineup);
      else out += statusLine(S, lineup, wi, S.view);
      if (inj) out += '<div class="ex pad">' + esc(inj) + "</div>";
      if (S.view === "byes") return out + byesBody(S, t, wi, lineup);
      out += lineupBlock(S, t, wi, lineup, false);
    } else {
      out += '<div class="card warnc"><h2>Lineup not available</h2><div class="ex">MFL’s submitted lineup could not be read, so no starters are shown. Every active player is under Bench. This is not an empty lineup.</div></div>';
      if (S.view === "byes") return out + byesBody(S, t, wi, null);
    }
    // R6: Bench, Injured reserve and Taxi squad, one compact card each; the bench grouped by position inside its card
    var groups = M.benchGroups(t);
    var benchN = groups.reduce(function (n, g) { return n + g.players.length; }, 0);
    var reasons = groups.reduce(function (r, g) { return r.concat(R.groupReasons(S, g.players)); }, []);
    out += section(S, "bench", "Bench", String(benchN), groups, reasons);
    var ir = M.reserve(t, "ir"), tx = M.reserve(t, "taxi");
    out += section(S, "ir", "Injured reserve", ir.length + (m.limits.ir ? " of " + m.limits.ir : ""), [{ pos: "", players: ir }]);
    out += section(S, "taxi", "Taxi squad", tx.length + (m.limits.taxi ? " of " + m.limits.taxi : ""), [{ pos: "", players: tx }]);
    return out;
  }

  function later(name, text) {
    return '<div class="card"><h2>' + esc(name) + "</h2><p class=\"m0\">" + esc(text) + "</p></div>";
  }

  function teamScreen(S) {
    var body;
    var tabs = '<div class="tabs tabs4 stk" role="tablist">' + [["roster", "Roster"], ["contracts", "Contracts"], ["performance", "Performance"], ["cap", "Cap & picks"]].map(function (o) {
      return '<button role="tab" data-act="sub" data-v="' + o[0] + '" aria-selected="' + (S.sub === o[0]) + '">' + esc(o[1]) + "</button>";
    }).join("") + "</div>";
    if (S.load.core === "loading") body = '<div class="card rows" aria-busy="true">' + skeletonRows(7) + '</div><div class="mu ctr sm">Loading the league…</div>';
    else if (S.load.core === "error" || !S.model) body = '<div class="card hl"><h2>Roster</h2><div class="big2"><b>Couldn’t read the league data. Try again.</b></div><div class="ex">' + esc(S.load.error || "") + '</div><button class="btn pri blk" data-act="retry">Try again</button></div>';
    else if ((S.sub === "contracts" || S.sub === "performance") && !R.lineupCoherence(S, team(S)).ok) body = teamPicker(team(S)) + countsLine(team(S), S.model.limits) + dataUnavailableCard(S, team(S), R.lineupCoherence(S, team(S)));
    else if (S.sub === "contracts") body = teamPicker(team(S)) + countsLine(team(S), S.model.limits) + TV.contractsBody(S);
    else if (S.sub === "performance") body = teamPicker(team(S)) + countsLine(team(S), S.model.limits) + TV.performanceBody(S);
    else if (S.sub === "cap") body = later("Cap & picks", "Not in this preview. Cap space is left out on purpose until it can be checked against the Front Office number.");
    else body = rosterBody(S);
    return scroller(header("Team", asOfLine(S)) + tabs, body);
  }
  // R8: one scrolling area (#scroll) holds the heading, the sticky tabs and the screen body (#screen), so the heading scrolls away under the marker.
  function scroller(top, body) { return '<div id="scroll" class="scroll">' + top + '<div id="screen">' + body + "</div></div>"; }

  function placeholderScreen(id) {
    var name = NAVS.filter(function (n) { return n[0] === id; })[0][1];
    return scroller(header(name, ""), later(name, LATER[id]));
  }

  function nav(S) {
    return '<nav class="bar4" aria-label="Main">' + NAVS.map(function (n) {
      return '<button data-act="nav" data-v="' + n[0] + '"' + (S.tab === n[0] ? ' aria-current="page"' : "") + '><svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + n[2] + '"/></svg>' + n[1] + "</button>";
    }).join("") + "</nav>";
  }

  // ---------- Player profile ----------
  function penaltyRow(S, pid) {
    var d = S.penalty && S.penalty.state === "ok" ? S.penalty.data : null;
    return d ? d[pid] || null : null;
  }

  function kv(pairs) {
    return '<div class="kv">' + pairs.map(function (p) { return "<b>" + esc(p[0]) + "</b><span>" + p[1] + "</span>"; }).join("") + "</div>";
  }

  function tog(S, k, label) {
    var on = !!(S.flags && S.flags[k]);
    return '<button class="xt" data-act="tog" data-v="' + k + '" aria-expanded="' + on + '"><span>' + esc(label) + '</span><span class="go" aria-hidden="true">' + (on ? "▾" : "▸") + "</span></button>";
  }

  function contractTab(S, p) {
    var season = S.model.season;
    var sched = C.schedule(p, season);
    var pstate = S.penalty ? S.penalty.state : "idle";
    var row = penaltyRow(S, p.id);
    var ok = pstate === "ok";
    var e = C.earned(row), g = TV.cutCharge(S, p);
    var wk = ok && S.penalty.meta ? S.penalty.meta.earnedThroughWeek : null;
    var out = "";

    var salary = p.salary == null ? '<b class="wn">Not recorded</b>' : "<b>" + money(p.salary) + "</b>";
    var left = !p.years ? "—" : p.years === 1 ? "1 (final)" : String(p.years);
    var earnedCell, cutCell;
    if (pstate === "loading" || pstate === "idle") { earnedCell = cutCell = '<b class="mu">Loading…</b>'; }
    else if (pstate === "error") { earnedCell = cutCell = '<b class="wn">Not available</b>'; }
    else {
      earnedCell = e.kind === "amount" ? "<b>" + money(e.amount) + "</b>" : e.kind === "rule" || e.kind === "na" ? "<b>" + esc(e.label) + "</b>" : '<b class="wn">Not available</b>';
      // R8: the one primary amount is the cut charge (the Worker's, under its own rule); there is no Remaining guarantee tile
      cutCell = g.kind === "amount" ? "<b>" + esc(g.text) + "</b>" : g.kind === "review" ? '<b class="wn">Under review</b>' : '<b class="wn">Not available</b>';
    }
    var blank = p.salaryUnresolved ? '<div class="ex wn mt4">MFL has no salary recorded for this player, so none is shown.</div>' : "";
    out += blank + '<div class="k2"><div>' + salary + "<small>Salary " + season + "</small></div><div><b>" + esc(left) + "</b><small>Years left</small></div><div>" + cutCell + "<small>If cut now" + (g.tag ? " · " + esc(g.tag) : "") + "</small></div><div>" + earnedCell + "<small>Earned to date</small></div></div>";
    if (ok && wk != null) out += '<div class="ex mt4">Earned counts through Week ' + wk + ".</div>";
    if (pstate === "error") out += TV.failCard("retrypen");
    if (ok && e.kind === "unavailable") out += '<div class="ex mt4 wn">' + esc(e.why) + ".</div>";

    // salary by year
    out += '<div class="sec2">Salary by year</div><div class="k3">' + [0, 1, 2].map(function (i) {
      var r = sched.rows[i];
      var v = !r ? "<b>—</b>" : r.amount == null ? '<b class="wn">Not recorded</b>' : "<b>" + money(r.amount) + "</b>";
      return "<div>" + v + "<small>" + (season + i) + "</small></div>";
    }).join("") + "</div>";
    if (sched.rows.length > 3) {
      out += '<div class="ex wn mt6"><b>Beyond ' + (season + 2) + ":</b> " + sched.rows.slice(3).map(function (r) { return r.year + " " + (r.amount == null ? "not recorded" : money(r.amount)); }).join(", ") + "</div>";
    }
    if (sched.option) out += '<div class="ex mt6"><b>Option ' + sched.option.year + ":</b> " + money(sched.option.amount) + ". An unexercised rookie option, not an obligation.</div>";
    if (sched.notes.indexOf("current_year_token_differs") >= 0) out += '<div class="ex wn mt6">The recorded year amount differs from this season’s salary. The salary on the roster is shown.</div>';

    // rules and totals
    // R8: the contract's facts in owner words (Term, Contract Type, Contract Source, Later changes, Salary structure; shared with Team › Contracts), then
    // the totals. The raw contract type code is not shown.
    // R9: the AAV is one of the facts, labeled by the years it applies to (lib/contract.js aavYears); the Contract history follows, collapsed
    var tcv = sched.parsed.tcv;
    out += tog(S, "rules", "Rules and totals");
    if (S.flags && S.flags.rules) {
      out += '<div class="xb"><div class="kv">' + TV.contractFactsFor(S, p) +
        "<b>Total value</b><span>" + (tcv == null ? "Not recorded" : money(tcv)) + "</span></div></div>";
    }
    out += tog(S, "hist", "Contract history");
    if (S.flags && S.flags.hist) out += '<div class="xb">' + TV.historyHtml(S, p) + "</div>";
    // earned breakdown
    out += tog(S, "earned", "How earned is counted");
    if (S.flags && S.flags.earned) {
      var eb;
      if (!ok || !row) eb = "Not available until the UPS cap calculation loads.";
      else if (e.kind === "amount") eb = "<b>" + money(e.amount) + "</b> = " + money(row.prior_earned) + " from played years + " + money(row.current_year_earned) + " this season (" + (row.acquisition_week ? "picked up Week " + esc(row.acquisition_week) + ", " : "") + esc(row.eligible_weeks) + " eligible weeks).";
      else if (e.kind === "rule") eb = "<b>Full-year rule.</b> A contract paying the minimum every year has no weekly earned amount.";
      else if (e.kind === "na") eb = "<b>Not applicable.</b> A one-year waiver pickup of $4K or less has no earned amount.";
      else eb = "<b>Not available.</b> " + esc(e.why);
      out += '<div class="xb">' + eb + "</div>";
    }
    // cut cost
    out += tog(S, "cut", "If cut now");
    if (S.flags && S.flags.cut) {
      // R8: the amount and the rule in one sentence (no arithmetic); the guarantee and what is earned of it only under the guarantee rule
      var cb;
      if (!ok) cb = "<b>Not available</b> until the UPS cap calculation loads.";
      else cb = '<div class="kv"><b>Cut charge</b><span>' + TV.cutWords(g) + "</span>" + TV.guaranteeFacts(S, g) + "</div>";
      out += '<div class="xb">' + cb + '<div class="ex mt6">A read-only figure from the UPS cap calculation. Nothing can be cut from here.</div></div>';
    }
    // (the raw contract text is not shown on any owner screen: its diagnostic destination is deferred, #1496 D6)

    out += '<div class="sec2">Where these numbers come from</div><div class="ex">Salary, years and the year-by-year amounts: the contract recorded on MFL, as the Front Office reads it (' + esc(F.etStamp(S.model.asOf) || "just now") + "). Earned, guarantee and the cost of a cut: the UPS cap calculation" + (ok && S.penalty.meta && S.penalty.meta.calculatedAt ? " at " + esc(F.etStamp(S.penalty.meta.calculatedAt) || S.penalty.meta.calculatedAt) : "") + ". Closed actions and their deadlines are not in Preview 0.</div>";
    return out;
  }

  // R6: the profile's Performance tab is the Breakdown: the settled season line, the season stats, and the weekly game log with each game's detail.
  // Points are MFL's; the stats are the NFL box score. No projection or expected-points figure is drawn here.
  function performanceTab(S, p) {
    return '<div class="sec2 first">Breakdown</div>' + TV.gameLog(S, p);
  }
  function scheduleTab() { return '<div class="ex">The schedule and matchup view is not in Preview 0.</div>'; }
  function moreTab(S, p) {
    return '<div class="sec2 first">Status</div>' + kv([
      ["Roster spot", p.status === "ir" ? "Injured reserve" : p.status === "taxi" ? "Taxi squad" : p.starter ? "Starter, Week " + S.model.week : "Bench"],
      ["Team", esc(p.franchiseName)],
      ["Acquired", esc(p.acquisition || "Not recorded")]
    ]) +
      (p.status === "taxi" ? '<div class="sec2">Taxi</div>' + kv([["Call-ups used", p.taxi.used == null ? "Not available" : p.taxi.used + (p.taxi.max ? " of " + p.taxi.max : "")], ["Eligibility", esc(p.taxi.text || "Not available")]]) : "") +
      '<div class="ex mt6">News and bio are not in Preview 0. Injury tags show on the roster rows; this profile shows no injury detail and no return date yet.</div>';
  }

  function profile(S) {
    var p = S.model && S.model.byId[S.profile.pid];
    if (!p) {
      return '<div class="layer"><div class="scrim" data-act="close"></div><div class="sheet full" role="dialog" aria-modal="true" aria-label="Player profile" tabindex="-1"><div class="grab"></div><div class="top"><h3>Player not found</h3></div><div class="ex">This player is not on a roster in the data that loaded.</div><button class="btn blk" data-act="close">Close</button></div></div>';
    }
    var tab = S.profile.tab || "contract";
    var pills = (p.status === "ir" ? R.irBadge("IR", "hpb") : p.status === "taxi" ? pill("Taxi") : "") + (p.bye && p.bye === S.model.week ? pill("▲ Bye week") : "");
    var tabs = [["perf", "Performance"], ["sched", "Schedule"], ["contract", "Contract"], ["more", "More"]];
    var body = tab === "perf" ? performanceTab(S, p) : tab === "sched" ? scheduleTab() : tab === "more" ? moreTab(S, p) : contractTab(S, p);
    return '<div class="layer"><div class="scrim" data-act="close"></div><div class="sheet full phero" role="dialog" aria-modal="true" aria-label="Player profile: ' + esc(p.name) + '" tabindex="-1">' +
      hero(p, pills) +
      '<div class="ptabs" role="tablist">' + tabs.map(function (t) { return '<button role="tab" data-act="ptab" data-v="' + t[0] + '" aria-selected="' + (tab === t[0]) + '">' + t[1] + "</button>"; }).join("") + "</div>" +
      '<div class="pbody">' + body + "</div></div></div>";
  }
  function require_photo(p) { return P.chain(p.espnId, p.id); }

  // The profile header, colored by the player's NFL team. The color is a CSS class (tm-XXX) answered by the generated
  // team-colors.css, because the page's content policy forbids inline styles. An unknown, blank or free-agent code gets no class
  // and so the neutral palette; the class is only ever 2 or 3 capital letters, so nothing from the data can leave the attribute.
  function teamCls(code) {
    var c = String(code == null ? "" : code).trim().toUpperCase();
    return /^[A-Z]{2,3}$/.test(c) ? " tm-" + c : "";
  }
  // The header prints the common NFL abbreviation, as the prototype does (KC, GB, SF), not MFL's spelling (KCC, GBP, SFO).
  var commonCode = F.commonCode;
  function nameParts(n) {
    var s = String(n == null ? "" : n).trim(), i = s.indexOf(" ");
    return i < 0 ? ["", s] : [s.slice(0, i), s.slice(i + 1)];
  }
  // The demo's labeled placeholder where a team helmet would sit. No helmet art exists, and none is drawn or implied (Decision 3).
  function helmetPlaceholder() {
    return '<div class="hm ph" role="img" aria-label="Team helmet placeholder: verified team art is not available"><span>Helmet</span><span>TBD</span></div>';
  }
  function pill(text) { return '<span class="hp">' + esc(text) + "</span>"; }
  // R8: the readable Contract Type (Veteran / Rookie) from contract.describe, never the internal code ("Rookie-Draft", "Vet-FAA-FL")
  function heroType(p) { var d = null; try { d = C.describe(p); } catch (e) { d = null; } return d && d.type ? d.type : "Contract type not recorded"; }
  function hero(p, pills) {
    var np = nameParts(p.name), urls = require_photo(p);
    return '<div class="hero' + teamCls(p.nflTeam) + '"><div class="grab"></div>' +
      '<div class="top"><span class="hlb">Player profile</span><button class="hx" data-act="close" aria-label="Close player profile"><span>Close</span></button></div>' +
      '<div class="hrow"><div class="pfw"><div class="av2" aria-hidden="false"><span class="avpos">' + esc(posText(p.pos)) + '</span><img alt="' + esc(p.name) + ' headshot" data-chain="' + esc(JSON.stringify(urls)) + '" referrerpolicy="no-referrer" decoding="async"></div>' + helmetPlaceholder() + "</div>" +
      '<div class="htx"><h3 class="hnm">' + (np[0] ? '<span class="hfn">' + esc(np[0]) + "</span> " : "") + '<span class="hln">' + esc(np[1]) + "</span></h3>" +
      '<div class="hsub"><b>' + esc(commonCode(p.nflTeam) || "No NFL team") + "</b><span>" + esc(posText(p.pos)) + "</span><span>" + esc(heroType(p)) + "</span></div></div></div>" +
      (pills ? '<div class="hpills">' + pills + "</div>" : "") + '<div class="hbar"></div></div>';
  }

  // ---------- sheets ----------
  function teamSheet(S) {
    return '<div class="layer"><div class="scrim" data-act="close"></div><div class="sheet" role="dialog" aria-modal="true" aria-label="Choose a team" tabindex="-1"><div class="grab"></div><div class="top"><h3>Choose a team</h3><button class="btn" data-act="close">Close</button></div>' +
      '<div class="ex">Preview 0 shows any team’s public roster. Choosing a team does not sign you in and cannot change anything.</div>' +
      S.model.teams.map(function (t) {
        return '<button class="so" data-act="pickteam" data-fid="' + esc(t.id) + '" aria-pressed="' + (t.id === S.teamId) + '"><span class="tpi"><img alt="" data-chain="' + esc(JSON.stringify(t.icon ? [t.icon] : [])) + '" referrerpolicy="no-referrer"></span><span class="in"><b>' + esc(t.name) + "</b><small>" + t.counts.active + " active · " + t.counts.taxi + " taxi · " + t.counts.ir + " IR</small></span>" + (t.id === S.teamId ? '<span class="ok">✓</span>' : "") + "</button>";
      }).join("") + "</div></div>";
  }

  function chipRow(act, opts, cur, label) {
    return '<div class="lbl">' + esc(label) + '</div><div class="chs" role="group" aria-label="' + esc(label) + '">' + opts.map(function (o) {
      return '<button class="ch" data-act="' + act + '" data-v="' + esc(o[0]) + '" aria-pressed="' + (cur === o[0]) + '">' + esc(o[1]) + "</button>";
    }).join("") + "</div>";
  }

  // The ONE known-issues list of the recorded test build (R7b final): shown in About, reached from the marker's "Known issues" button. Screens say
  // "Not available" or "—" where a figure is missing and Rank details say why; they do not repeat these notes.
  var KNOWN_ISSUES = [
    "Test build: not reviewed or accepted yet. Figures are a recording and will not change.",
    "Many season stat ranks show — while some players’ figures are incomplete. The stat values still show; Rank details under the season stats say why. Two data problems cause most of these: blank defensive stat rows added by a second stats feed, and red-zone records the recorded answers could not prove complete. Fixes are drafted but not released, and this recording was made before them.",
    "Kicking distance bands: a kicker’s attempts from a distance are incomplete when he missed a kick, because missed-kick distances are not in the stats feed, so those band ranks show —.",
    "Points-per-game rank shows — for everyone: team history is not in this recording.",
    "Pass rate over expected, punter inside-20 distance bands, missed-kick distances, longest plays and yards after catch are not in this recording.",
    "The opponent matchup column (points the opponent allowed to this position before the game) is not shown yet: the recording does not have every player’s club for each week. The game log keeps the game result until it does.",
    "Traded salary entries show the amount without the other team and date: the recording has no trade records to link them to.",
    "xFP PPG and Over Expectations are Not Available everywhere.",
    "Minimum attempts, carries, targets or snaps for rate ranks are proposals, not approved yet.",
    "Game stats were recorded for 117 players (three full teams plus examples); other players show their fantasy log only.",
    "Projections cover Week 11 only and were recorded for 342 of 486 rostered players.",
    "Nine extensions show the extending team without a year, because a later restructure hid it.",
    "Not checked on a real iPhone in Safari, or signed in to MFL."
  ];
  function knownIssuesCard() { return '<div class="card" id="known-issues"><h2>Known issues in this test build</h2><ul class="pl">' + KNOWN_ISSUES.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul></div>"; }

  function aboutSheet(S) {
    var log = S.requestLog || [], sum = S.requestSummary || { requests: 0, ok: 0, failed: 0, refused: 0, nonGet: 0 };
    var rows = log.map(function (e) {
      var what = e.path + (e.type ? " · " + e.type : "");
      var res = e.refused ? "Refused" : e.status ? String(e.status) : "…";
      return '<div class="lg"><span class="lgw">' + esc(e.label || "") + "<small>" + esc(what) + '</small></span><span class="lgr">' + esc(e.method) + " " + esc(res) + (e.bytes != null ? "<small>" + Math.round(e.bytes / 1024) + " KB · " + (e.ms || 0) + " ms</small>" : "") + "</span></div>";
    }).join("");
    return '<div class="layer"><div class="scrim" data-act="close"></div><div class="sheet full" role="dialog" aria-modal="true" aria-label="About Preview 0" tabindex="-1"><div class="grab"></div><div class="top"><h3>About Preview 0</h3><button class="btn" data-act="close">Close</button></div>' +
      // R8: the marker no longer prints the capture times, so the Data card (both times) follows the known issues directly
      (S.recorded ? knownIssuesCard() : "") +
      '<div class="card"><h2>Data</h2><div class="ex">' + (S.recorded ? "This preview uses a recorded snapshot taken " + esc(S.recorded.label) + ", not the live league. The figures will not move." + (S.recorded.later ? " Game stats, season totals and projections were recorded later that day, " + esc(S.recorded.later) + "." : "") : "Read from the league when this page opened" + (S.model ? " (" + esc(F.etStamp(S.model.asOf) || "just now") + ")" : "") + ". Each answer is kept for up to a minute.") + "</div>" + (sampleOn(S) ? '<div class="ex">Reloading is paused while Sample mode is on.</div>' : '<button class="btn blk" data-act="retry">' + (S.recorded ? "Reload the recorded data" : "Reload the data") + "</button>") + "</div>" +
      '<div class="card"><h2>What this is</h2><div class="ex">A read-only preview of redesigned screens: Team (Roster with Lineup and Byes and a week selector, Contracts, Performance) and Player profile. It shows real, public league data. It cannot sign in, save, drop, trade or change anything on MFL. The current app is untouched.</div></div>' +
      '<div class="card"><h2>Display</h2>' + chipRow("skin", [["system", "Match my phone"], ["light", "Light"], ["dark", "Dark"], ["hc", "High contrast"]], S.skin, "Skin") + chipRow("vib", [["1", "Vibrant"], ["0", "Plain"]], S.vib, "Position colors") + "</div>" +
      '<div class="card"><h2>Sample mode</h2><div class="ex">For trying screens without league data. Labeled, local to this phone, never remembered, and it starts no new request (data or photos) while it is on.</div><button class="btn blk" data-act="sample" data-v="about">' + (sampleOn(S) ? "Turn Sample mode off" : "Turn Sample mode on") + "</button></div>" +
      '<div class="card"><h2>Requests this page made</h2><div class="ex"><b>' + sum.requests + "</b> data requests: <b>" + sum.ok + "</b> succeeded, <b>" + sum.failed + "</b> failed, <b>" + sum.refused + "</b> refused. Methods other than GET: <b>" + sum.nonGet + '</b>. No cookie, session or key is ever sent.' + (S.recorded ? " In recorded-data mode these reads are answered from the snapshot that ships with the page, so none of them leaves it." : "") + "</div>" + rows +
      '<div class="ex mt6">Player photos load straight from ESPN, then MFL, as the current app does. They are images, not data requests. Injury status, NFL games and weekly scores are read once and reused when you change views or weeks.</div></div>' +
      '<div class="card"><h2>Not in this preview</h2><ul class="pl"><li>Any action: lineup changes, drops, extensions, bids, trades</li><li>Cap space and Cap &amp; picks</li><li>Schedule, news, bio</li><li>Return dates for injured players: MFL lists one, but what it means is not verified, so none is shown</li><li>A real team helmet (a labeled placeholder is shown)</li><li>Sign-in: you are not signed in as anyone</li></ul></div>' +
      '<div class="ex">Build ' + esc(S.build || "") + "</div></div></div>";
  }

  // The marker at the top of every screen: "Preview: view only", or the Sample label while Sample mode is on.
  function sampleOn(S) { return !!(S.sample && S.sample.on); }
  // R8: in recorded mode the marker is one short line, "Test · Recorded data", with the "Known issues" button; the two capture times are in About.
  function envBar(S) {
    var on = sampleOn(S), rec = !on && !!S.recorded;
    return '<div class="envbar' + (on ? " sample" : rec ? " rec" : "") + '"><span>' + esc(SM.envText(on, rec)) + "</span>" + (rec ? ' <button class="link" data-act="about">Known issues</button>' : "") + "</div>";
  }
  function sampleScreen() {
    return '<div id="scroll" class="scroll">' + header("Sample mode", "") + '<div id="screen"><div class="card hl"><h2>Sample mode</h2><div class="big2"><b>Nothing here is real, and nothing is sent.</b></div>' +
      '<div class="ex">Sample scenarios let a screen be tried without any league data. They live on this phone only, and this page starts no new request, for data or for photos, while Sample mode is on. A request already on its way when you turn it on is not recalled; its answer is thrown away. No scenario is installed yet: they arrive with the screens that use them.</div>' +
      '<button class="btn pri blk" data-act="sample" data-v="screen">Turn Sample mode off</button></div></div></div>';
  }

  function app(S) {
    var on = sampleOn(S);
    var screen = on ? sampleScreen() : S.tab === "team" ? teamScreen(S) : placeholderScreen(S.tab);
    var layer = "";
    if (S.sheet === "about") layer = aboutSheet(S);
    else if (!on && S.profile && S.model) layer = profile(S);
    else if (!on && S.sheet === "teams" && S.model) layer = teamSheet(S);
    else if (!on && S.sheet === "weeks" && S.model) layer = weekSheet(S);
    else if (!on && S.sheet === "help" && S.model) layer = helpSheet(S);
    return envBar(S) + screen + nav(S) + layer;
  }

  return { app: app, teamScreen: teamScreen, profile: profile, contractTab: contractTab, aboutSheet: aboutSheet, KNOWN_ISSUES: KNOWN_ISSUES, teamSheet: teamSheet, weekSheet: weekSheet, rosterBody: rosterBody, isOpen: isOpen, NAVS: NAVS };
});
