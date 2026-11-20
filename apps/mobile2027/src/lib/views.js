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
    req ? require("./sample.js") : root.UPS2027.sample
  );
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.UPS2027 = root.UPS2027 || {}; root.UPS2027.views = api; }
})(typeof self !== "undefined" ? self : this, function (F, C, M, P, SM) {
  "use strict";

  var esc = F.esc, money = F.money;
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

  function pcx(pos) { return '<span class="pc ' + esc(pos) + '">' + esc(pos) + "</span>"; }
  function chip(cls, text) { return '<span class="chip ' + cls + '">' + text + "</span>"; }
  function team(S) { return S.model && S.model.teams.filter(function (t) { return t.id === S.teamId; })[0] || (S.model && S.model.teams[0]) || null; }

  function skeletonRows(n) {
    var s = "";
    for (var i = 0; i < n; i++) s += '<div class="rx"><div class="in"><div class="sk w60"></div><div class="sk w40"></div></div><div class="sk w20"></div></div>';
    return s;
  }

  function header(title, asof) {
    return '<div class="hd"><h1>' + esc(title) + '</h1><button class="ib" data-act="about" aria-label="About this preview and display settings">ⓘ</button></div><div class="asof">' + asof + "</div>";
  }

  function asOfLine(S) {
    var m = S.model;
    if (!m) return S.load.core === "error" ? '<span class="wn">▲</span> Couldn’t reach the league data' : "Loading…";
    var t = F.etStamp(m.asOf);
    return '<span class="ok">✓</span> Data as of ' + esc(t || "just now") + (m.week ? " · Week " + m.week : "");
  }

  // ---------- Team screen ----------
  function teamPicker(t) {
    return '<button class="tp" data-act="teams" aria-label="Viewing ' + esc(t.name) + '. Change team">' +
      '<span class="tpi"><img alt="" data-chain="' + esc(JSON.stringify(t.icon ? [t.icon] : [])) + '" referrerpolicy="no-referrer"></span>' +
      '<span class="tpt"><small>Viewing</small><b>' + esc(t.name) + "</b></span><span class=\"go\" aria-hidden=\"true\">▾</span></button>";
  }

  function countsLine(t, lim) {
    function of(n, l) { return n + (l ? " of " + l : ""); }
    return '<div class="cap"><b>Active ' + of(t.counts.active, lim.roster) + "</b> · Taxi " + of(t.counts.taxi, lim.taxi) + " · IR " + of(t.counts.ir, lim.ir) + "</div>";
  }

  function seg(view) {
    return '<div class="seg" role="group" aria-label="Roster view">' +
      [["lineup", "Lineup"], ["contracts", "Contracts"]].map(function (o) {
        return '<button data-act="view" data-v="' + o[0] + '" aria-pressed="' + (view === o[0]) + '">' + o[1] + "</button>";
      }).join("") + "</div>";
  }

  function row(p, S) {
    var small, right = "";
    if (S.view === "contracts") {
      var through = p.years ? "through " + (S.model.season + p.years - 1) : "no years recorded";
      small = esc(p.type || "Type not recorded") + " · " + through;
      var sal = p.salary == null ? '<b class="wn">Not recorded</b>' : "<b>" + money(p.salary) + "</b>";
      right = '<div class="rt">' + sal + (p.years === 1 ? chip("wn", "▲ Final year") : p.years ? '<span class="mu sm">' + p.years + " yrs left</span>" : "") + "</div>";
    } else {
      small = esc(p.nflTeam || "No NFL team") + (p.bye && p.bye === S.model.week ? " · Bye week" : "");
      right = p.bye && p.bye === S.model.week && p.status === "active" ? '<div class="rt">' + chip("wn", "▲ Bye week") + "</div>" : "";
    }
    return '<div class="rx"><span class="tag pp">' + pcx(p.pos) + '</span><div class="in"><button class="nm" data-act="card" data-pid="' + esc(p.id) + '" aria-label="' + esc(p.name) + ', open player profile"><span class="n1">' + esc(p.name) + "</span><small>" + small + "</small></button></div>" + right + '<span class="go" aria-hidden="true">›</span></div>';
  }

  function group(key, label, players, S, badge) {
    var open = !!S.open[key];
    return '<button class="gh" data-act="grp" data-g="' + esc(key) + '" aria-expanded="' + open + '"><span class="chev" aria-hidden="true">' + (open ? "▾" : "▸") + "</span>" + badge + '<span class="t"><b>' + players.length + " " + esc(label) + "</b></span></button>" +
      (open ? '<div class="card rows">' + players.map(function (p) { return row(p, S); }).join("") + "</div>" : "");
  }

  function rosterBody(S) {
    var t = team(S), m = S.model, out = "";
    out += teamPicker(t) + countsLine(t, m.limits) + seg(S.view);
    if (S.load.core !== "ok" && S.load.coreNotes && S.load.coreNotes.length) {
      out += '<div class="card warnc"><h2>Not everything loaded</h2>' + S.load.coreNotes.map(function (n) { return '<div class="ex">' + esc(n) + "</div>"; }).join("") + "</div>";
    }
    // starters, as the lineup MFL holds for this week
    var st = M.starters(t);
    if (t.lineup.state === "ok") {
      out += '<div class="grp"><span>Week ' + m.week + " starters · " + st.length + (m.limits.starters ? " of " + m.limits.starters : "") + '</span></div><div class="card rows">' +
        (st.length ? st.map(function (p) { return row(p, S); }).join("") : '<div class="rx"><div class="in"><b>No starters set on MFL</b></div></div>') + "</div>";
      out += '<div class="ex pad">The lineup as MFL has it for Week ' + m.week + ". Nothing here can change it.</div>";
    } else {
      out += '<div class="card warnc"><h2>Lineup not available</h2><div class="ex">MFL’s submitted lineup could not be read, so no starters are shown. Every active player is under Bench. This is not an empty lineup.</div></div>';
    }
    // bench
    var groups = M.benchGroups(t);
    var benchN = groups.reduce(function (n, g) { return n + g.players.length; }, 0);
    var allOpen = groups.every(function (g) { return S.open["b" + g.pos]; }) && !!S.open.ir && !!S.open.taxi;
    out += '<div class="grp"><span>Bench · ' + benchN + '</span><button class="link" data-act="expall">' + (allOpen ? "Collapse all" : "Expand all") + "</button></div>";
    out += groups.map(function (g) { return group("b" + g.pos, "on bench", g.players, S, pcx(g.pos)); }).join("");
    // reserves
    var ir = M.reserve(t, "ir"), tx = M.reserve(t, "taxi");
    out += '<div class="grp"><span>Injured reserve · ' + ir.length + (m.limits.ir ? " of " + m.limits.ir : "") + "</span></div>";
    out += ir.length ? group("ir", ir.length === 1 ? "player" : "players", ir, S, '<span class="pc">IR</span>') : '<div class="ex pad">No one on injured reserve.</div>';
    out += '<div class="grp"><span>Taxi squad · ' + tx.length + (m.limits.taxi ? " of " + m.limits.taxi : "") + "</span></div>";
    out += tx.length ? group("taxi", tx.length === 1 ? "player" : "players", tx, S, '<span class="pc">TX</span>') : '<div class="ex pad">No one on the taxi squad.</div>';
    return out;
  }

  function later(name, text) {
    return '<div class="card"><h2>' + esc(name) + "</h2><p class=\"m0\">" + esc(text) + "</p></div>";
  }

  function teamScreen(S) {
    var body;
    var tabs = '<div class="tabs" role="tablist">' + [["roster", "Roster"], ["contracts", "Contracts"], ["cap", "Cap & picks"]].map(function (o) {
      return '<button role="tab" data-act="sub" data-v="' + o[0] + '" aria-selected="' + (S.sub === o[0]) + '">' + esc(o[1]) + "</button>";
    }).join("") + "</div>";
    if (S.load.core === "loading") body = '<div class="card rows" aria-busy="true">' + skeletonRows(7) + '</div><div class="mu ctr sm">Loading the league…</div>';
    else if (S.load.core === "error" || !S.model) body = '<div class="card hl"><h2>Roster</h2><div class="big2"><b>Couldn’t read the league data. Try again.</b></div><div class="ex">' + esc(S.load.error || "") + '</div><button class="btn pri blk" data-act="retry">Try again</button></div>';
    else if (S.sub === "contracts") body = later("Team › Contracts", "The all-years contracts table is approved as a concept but is not in Preview 0. Open any player for his contract.");
    else if (S.sub === "cap") body = later("Cap & picks", "Not in Preview 0. Cap space is left out on purpose until it can be checked against the Front Office number.");
    else body = rosterBody(S);
    return header("Team", asOfLine(S)) + tabs + '<div id="screen">' + body + "</div>";
  }

  function placeholderScreen(id) {
    var name = NAVS.filter(function (n) { return n[0] === id; })[0][1];
    return header(name, "") + '<div id="screen">' + later(name, LATER[id]) + "</div>";
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
    var e = C.earned(row), rg = C.remainingGuarantee(row), cut = C.cutNow(row);
    var wk = ok && S.penalty.meta ? S.penalty.meta.earnedThroughWeek : null;
    var out = "";

    var salary = p.salary == null ? '<b class="wn">Not recorded</b>' : "<b>" + money(p.salary) + "</b>";
    var left = !p.years ? "—" : p.years === 1 ? "1 (final)" : String(p.years);
    var earnedCell, guarCell;
    if (pstate === "loading" || pstate === "idle") { earnedCell = guarCell = '<b class="mu">Loading…</b>'; }
    else if (pstate === "error") { earnedCell = guarCell = '<b class="wn">Not available</b>'; }
    else {
      earnedCell = e.kind === "amount" ? "<b>" + money(e.amount) + "</b>" : e.kind === "rule" || e.kind === "na" ? "<b>" + esc(e.label) + "</b>" : '<b class="wn">Not available</b>';
      guarCell = rg == null ? (e.kind === "unavailable" ? '<b class="wn">Not available</b>' : "<b>—</b>") : "<b>" + money(rg) + "</b>";
    }
    var blank = p.salaryUnresolved ? '<div class="ex wn mt4">MFL has no salary recorded for this player, so none is shown.</div>' : "";
    out += blank + '<div class="k2"><div>' + salary + "<small>Salary " + season + "</small></div><div><b>" + esc(left) + "</b><small>Years left</small></div><div>" + earnedCell + "<small>Earned to date</small></div><div>" + guarCell + "<small>Remaining guarantee</small></div></div>";
    if (ok && wk != null) out += '<div class="ex mt4">Earned counts through Week ' + wk + ".</div>";
    if (pstate === "error") out += '<div class="ex mt4 wn">The worker’s calculation could not be read: ' + esc(S.penalty.error || "") + '. Nothing is guessed in its place. <button class="link" data-act="retrypen">Try again</button></div>';
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
    var tcv = sched.parsed.tcv, gtd = ok && row && isFinite(row.guaranteed) && !row.needs_review ? row.guaranteed : null;
    var aav = sched.parsed.aav.length ? sched.parsed.aav.map(money).join(" · ") : "Not recorded";
    out += tog(S, "rules", "Rules and totals");
    if (S.flags && S.flags.rules) {
      out += '<div class="xb">' + kv([
        ["Type", esc(p.type || "Not recorded")],
        ["Total value", tcv == null ? "Not recorded" : money(tcv)],
        ["Guaranteed", gtd != null ? money(gtd) : pstate === "ok" ? "Not available" : sched.parsed.gtd != null ? money(sched.parsed.gtd) + " (as recorded)" : "Not recorded"],
        ["AAV (as recorded)", esc(aav)],
        ["Contract length", sched.cl ? sched.cl + (sched.cl === 1 ? " year" : " years") : "Not recorded"],
        ["Years played", sched.yearsPlayed == null ? "Not recorded" : String(sched.yearsPlayed)]
      ]) + "</div>";
    }
    // earned breakdown
    out += tog(S, "earned", "How earned is counted");
    if (S.flags && S.flags.earned) {
      var eb;
      if (!ok || !row) eb = "Not available until the worker’s calculation loads.";
      else if (e.kind === "amount") eb = "<b>" + money(e.amount) + "</b> = " + money(row.prior_earned) + " from played years + " + money(row.current_year_earned) + " this season (" + (row.acquisition_week ? "picked up Week " + esc(row.acquisition_week) + ", " : "") + esc(row.eligible_weeks) + " eligible weeks).";
      else if (e.kind === "rule") eb = "<b>Full-year rule.</b> A contract paying the minimum every year has no weekly earned amount.";
      else if (e.kind === "na") eb = "<b>Not applicable.</b> A one-year waiver pickup of $4K or less has no earned amount.";
      else eb = "<b>Not available.</b> " + esc(e.why);
      out += '<div class="xb">' + eb + "</div>";
    }
    // cut cost
    out += tog(S, "cut", "If cut now");
    if (S.flags && S.flags.cut) {
      var cb;
      if (!ok) cb = "<b>Not available</b> until the worker’s calculation loads.";
      else if (cut.kind === "amount") cb = "<b>" + money(cut.amount) + "</b>" + (cut.why ? '<div class="ex">' + esc(cut.why) + "</div>" : "");
      else cb = '<b>Not available</b><div class="ex">' + esc(cut.why) + "</div>";
      out += '<div class="xb">' + cb + '<div class="ex mt6">A read-only figure from the worker. Nothing can be cut from here.</div></div>';
    }
    // recorded text
    out += tog(S, "raw", "Recorded contract text");
    if (S.flags && S.flags.raw) out += '<div class="xb"><code>' + esc(sched.parsed.raw || "Nothing recorded") + "</code></div>";

    out += '<div class="sec2">Where these numbers come from</div><div class="ex">Salary, years and the year-by-year amounts: the contract recorded on MFL, as the Front Office reads it (' + esc(F.etStamp(S.model.asOf) || "just now") + "). Earned, guarantee and the cost of a cut: the worker’s calculation" + (ok && S.penalty.meta && S.penalty.meta.calculatedAt ? " at " + esc(F.etStamp(S.penalty.meta.calculatedAt) || S.penalty.meta.calculatedAt) : "") + ". Closed actions and their deadlines are not in Preview 0.</div>";
    return out;
  }

  function performanceTab(p) {
    return '<div class="k2"><div><b>' + (p.points == null ? "Not available" : p.points.toFixed(1)) + "</b><small>Season points so far</small></div><div><b>—</b><small>Last week</small></div></div>" +
      '<div class="ex mt6">Points are MFL’s league-scored total. The game log, Start / Boom / Bust percentages and projections are not in Preview 0.</div>';
  }
  function scheduleTab() { return '<div class="ex">The schedule and matchup view is not in Preview 0.</div>'; }
  function moreTab(S, p) {
    return '<div class="sec2 first">Status</div>' + kv([
      ["Roster spot", p.status === "ir" ? "Injured reserve" : p.status === "taxi" ? "Taxi squad" : p.starter ? "Starter, Week " + S.model.week : "Bench"],
      ["Team", esc(p.franchiseName)],
      ["Acquired", esc(p.acquisition || "Not recorded")]
    ]) +
      (p.status === "taxi" ? '<div class="sec2">Taxi</div>' + kv([["Call-ups used", p.taxi.used == null ? "Not available" : p.taxi.used + (p.taxi.max ? " of " + p.taxi.max : "")], ["Eligibility", esc(p.taxi.text || "Not available")]]) : "") +
      '<div class="ex mt6">Injury status, news and bio are not in Preview 0.</div>';
  }

  function profile(S) {
    var p = S.model && S.model.byId[S.profile.pid];
    if (!p) {
      return '<div class="layer"><div class="scrim" data-act="close"></div><div class="sheet full" role="dialog" aria-modal="true" aria-label="Player profile" tabindex="-1"><div class="grab"></div><div class="top"><h3>Player not found</h3></div><div class="ex">This player is not on a roster in the data that loaded.</div><button class="btn blk" data-act="close">Close</button></div></div>';
    }
    var tab = S.profile.tab || "contract";
    var pills = (p.status === "ir" ? pill("IR") : p.status === "taxi" ? pill("Taxi") : "") + (p.bye && p.bye === S.model.week ? pill("▲ Bye week") : "");
    var tabs = [["perf", "Performance"], ["sched", "Schedule"], ["contract", "Contract"], ["more", "More"]];
    var body = tab === "perf" ? performanceTab(p) : tab === "sched" ? scheduleTab() : tab === "more" ? moreTab(S, p) : contractTab(S, p);
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
  var COMMON = { GBP: "GB", KCC: "KC", LVR: "LV", NEP: "NE", NOS: "NO", SFO: "SF", TBB: "TB", JAC: "JAX", WSH: "WAS" };
  function commonCode(code) {
    var c = String(code == null ? "" : code).trim().toUpperCase();
    return COMMON[c] || c;
  }
  function nameParts(n) {
    var s = String(n == null ? "" : n).trim(), i = s.indexOf(" ");
    return i < 0 ? ["", s] : [s.slice(0, i), s.slice(i + 1)];
  }
  // The demo's labeled placeholder where a team helmet would sit. No helmet art exists, and none is drawn or implied (Decision 3).
  function helmetPlaceholder() {
    return '<div class="hm ph" role="img" aria-label="Team helmet placeholder: verified team art is not available"><span>Helmet</span><span>TBD</span></div>';
  }
  function pill(text) { return '<span class="hp">' + esc(text) + "</span>"; }
  function hero(p, pills) {
    var np = nameParts(p.name), urls = require_photo(p);
    return '<div class="hero' + teamCls(p.nflTeam) + '"><div class="grab"></div>' +
      '<div class="top"><span class="hlb">Player profile</span><button class="hx" data-act="close" aria-label="Close player profile"><span>Close</span></button></div>' +
      '<div class="hrow"><div class="pfw"><div class="av2" aria-hidden="false"><span class="avpos">' + esc(p.pos) + '</span><img alt="' + esc(p.name) + ' headshot" data-chain="' + esc(JSON.stringify(urls)) + '" referrerpolicy="no-referrer" decoding="async"></div>' + helmetPlaceholder() + "</div>" +
      '<div class="htx"><h3 class="hnm">' + (np[0] ? '<span class="hfn">' + esc(np[0]) + "</span> " : "") + '<span class="hln">' + esc(np[1]) + "</span></h3>" +
      '<div class="hsub"><b>' + esc(commonCode(p.nflTeam) || "No NFL team") + "</b><span>" + esc(p.pos) + "</span><span>" + esc(p.type || "Type not recorded") + "</span></div></div></div>" +
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

  function aboutSheet(S) {
    var log = S.requestLog || [], sum = S.requestSummary || { requests: 0, ok: 0, failed: 0, refused: 0, nonGet: 0 };
    var rows = log.map(function (e) {
      var what = e.path + (e.type ? " · " + e.type : "");
      var res = e.refused ? "Refused" : e.status ? String(e.status) : "…";
      return '<div class="lg"><span class="lgw">' + esc(e.label || "") + "<small>" + esc(what) + '</small></span><span class="lgr">' + esc(e.method) + " " + esc(res) + (e.bytes != null ? "<small>" + Math.round(e.bytes / 1024) + " KB · " + (e.ms || 0) + " ms</small>" : "") + "</span></div>";
    }).join("");
    return '<div class="layer"><div class="scrim" data-act="close"></div><div class="sheet full" role="dialog" aria-modal="true" aria-label="About Preview 0" tabindex="-1"><div class="grab"></div><div class="top"><h3>About Preview 0</h3><button class="btn" data-act="close">Close</button></div>' +
      '<div class="card"><h2>What this is</h2><div class="ex">A read-only preview of two redesigned screens: Team roster and Player profile. It shows real, public league data. It cannot sign in, save, drop, trade or change anything on MFL. The current app is untouched.</div></div>' +
      '<div class="card"><h2>Data</h2><div class="ex">Read from the league when this page opened' + (S.model ? " (" + esc(F.etStamp(S.model.asOf) || "just now") + ")" : "") + '. The worker keeps each answer for up to a minute.</div>' + (sampleOn(S) ? '<div class="ex">Reloading is paused while Sample mode is on.</div>' : '<button class="btn blk" data-act="retry">Reload the data</button>') + "</div>" +
      '<div class="card"><h2>Display</h2>' + chipRow("skin", [["system", "Match my phone"], ["light", "Light"], ["dark", "Dark"], ["hc", "High contrast"]], S.skin, "Skin") + chipRow("vib", [["1", "Vibrant"], ["0", "Plain"]], S.vib, "Position colors") + "</div>" +
      '<div class="card"><h2>Sample mode</h2><div class="ex">For trying screens without league data. Labeled, local to this phone, never remembered, and it starts no new request (data or photos) while it is on.</div><button class="btn blk" data-act="sample" data-v="about">' + (sampleOn(S) ? "Turn Sample mode off" : "Turn Sample mode on") + "</button></div>" +
      '<div class="card"><h2>Requests this page made</h2><div class="ex"><b>' + sum.requests + "</b> data requests: <b>" + sum.ok + "</b> succeeded, <b>" + sum.failed + "</b> failed, <b>" + sum.refused + "</b> refused. Methods other than GET: <b>" + sum.nonGet + '</b>. No cookie, session or key is ever sent.</div>' + rows +
      '<div class="ex mt6">Player photos load straight from ESPN, then MFL, as the current app does. They are images, not data requests.</div></div>' +
      '<div class="card"><h2>Not in Preview 0</h2><ul class="pl"><li>Any action: lineup changes, drops, extensions, bids, trades</li><li>Cap space and the Contracts and Cap &amp; picks tabs</li><li>Injury status, projections, game log, schedule, news, bio</li><li>Helmet badge and team colors (not approved)</li><li>Sign-in: you are not signed in as anyone</li></ul></div>' +
      '<div class="ex">Build ' + esc(S.build || "") + "</div></div></div>";
  }

  // The marker at the top of every screen: "Preview: view only", or the Sample label while Sample mode is on.
  function sampleOn(S) { return !!(S.sample && S.sample.on); }
  function envBar(S) {
    var on = sampleOn(S);
    return '<div class="envbar' + (on ? " sample" : "") + '"><span>' + esc(SM.envText(on)) + "</span></div>";
  }
  function sampleScreen() {
    return header("Sample mode", "") + '<div id="screen"><div class="card hl"><h2>Sample mode</h2><div class="big2"><b>Nothing here is real, and nothing is sent.</b></div>' +
      '<div class="ex">Sample scenarios let a screen be tried without any league data. They live on this phone only, and this page starts no new request, for data or for photos, while Sample mode is on. A request already on its way when you turn it on is not recalled; its answer is thrown away. No scenario is installed yet: they arrive with the screens that use them.</div>' +
      '<button class="btn pri blk" data-act="sample" data-v="screen">Turn Sample mode off</button></div></div>';
  }

  function app(S) {
    var on = sampleOn(S);
    var screen = on ? sampleScreen() : S.tab === "team" ? teamScreen(S) : placeholderScreen(S.tab);
    var layer = "";
    if (S.sheet === "about") layer = aboutSheet(S);
    else if (!on && S.profile && S.model) layer = profile(S);
    else if (!on && S.sheet === "teams" && S.model) layer = teamSheet(S);
    return envBar(S) + screen + nav(S) + layer;
  }

  return { app: app, teamScreen: teamScreen, profile: profile, contractTab: contractTab, aboutSheet: aboutSheet, teamSheet: teamSheet, rosterBody: rosterBody, NAVS: NAVS };
});
