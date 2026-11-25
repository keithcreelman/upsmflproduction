/* UPS 2027 R3: the bodies of Team › Contracts and Team › Performance, and the profile's game log. Pure functions of the state object
   (no network, no storage, no DOM), drawn as HTML strings like views.js. Every piece of text that comes from a data source goes through esc().

   Rules this file keeps (owner rulings, 2026-11-21; scope record on #1475):
   - Contracts: labels and sorts follow the season the roster read reports (no year is written in this file); the salary columns are as many as
     the longest contract left; no points per game and no position rank anywhere; no link into Cap & picks. R6 (Keith, 2026-11-22/23): ONE cap card
     (Available cap space, Total cap, a closed Breakdown, the later years' Total committed cap); the separate recorded-salary card is gone.
   - R8 (Keith, 2026-11-23): the first column is "If cut now", the Worker's cut charge under the rule its basis names (guarantee, no guarantee,
     $1K drop rule, taxi), with a short rule label for the exceptions; there is no separate Remaining guarantee column. A missing or failed read
     never draws $0 (Loading, Under review, Unavailable).
   - Performance: a figure is withheld only when the evidence it needs is missing (lib/clubhist.js decides); scores, the season average and the
     scored-game count never wait on team history. A scored game is a recorded score, 0.0 included; the label never says "games played".
     No arrows, no matchup rating, no "allowed per game" line. */
(function (root, factory) {
  var req = typeof require === "function";
  var api = factory(
    req ? require("./format.js") : root.UPS2027.format,
    req ? require("./contract.js") : root.UPS2027.contract,
    req ? require("./roster.js") : root.UPS2027.roster,
    req ? require("./clubhist.js") : root.UPS2027.clubhist,
    req ? require("./adjust.js") : root.UPS2027.adjust,
    req ? require("./ranks.js") : root.UPS2027.ranks,
    req ? require("./complete.js") : root.UPS2027.complete,
    req ? require("./statranks.js") : root.UPS2027.statranks
  );
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.UPS2027 = root.UPS2027 || {}; root.UPS2027.tabviews = api; }
})(typeof self !== "undefined" ? self : this, function (F, C, R, CH, A, K, X, SR) {
  "use strict";

  var esc = F.esc, money = F.money;
  var GROUPS = [["QB", "QB"], ["RB", "RB"], ["WR", "WR"], ["TE", "TE"], ["PK", "K"], ["PN", "P"], ["DL", "DL"], ["LB", "LB"], ["DB", "DB"]];
  var DASH = "—", MINUS = "−";

  function chip(cls, text) { return '<span class="chip ' + cls + '">' + text + "</span>"; }
  // R9: the badge reads K and P (MFL's PK and PN stay as the color class only), the same labels as the headings and ranks
  function pcx(pos) { return '<span class="pc ' + esc(pos) + '">' + esc(pos === "PK" ? "K" : pos === "PN" ? "P" : pos) + "</span>"; }
  function nw(text) { return '<span class="nw">' + esc(text) + "</span>"; }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
  function teamOf(S) { return S.model && (S.model.teams.filter(function (t) { return t.id === S.teamId; })[0] || S.model.teams[0]) || null; }
  function skeleton(n) {
    var s = "";
    for (var i = 0; i < n; i++) s += '<div class="rx"><div class="in"><div class="sk w60"></div><div class="sk w40"></div></div><div class="sk w20"></div></div>';
    return s;
  }
  // "$18K", "$4.5K", "$1.25M": exact to the cent-free amounts the league uses; the expanded rows print whole dollars
  function kmoney(n) {
    if (n == null || !isFinite(n)) return DASH;
    var v = Math.round(n);
    if (Math.abs(v) >= 1000000) return "$" + String(Math.round(v / 10000) / 100).replace(/\.0+$/, "") + "M";
    if (Math.abs(v) >= 1000) return "$" + String(Math.round(v / 10) / 100).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "") + "K";
    return "$" + v;
  }
  function f1(v) { return v == null || !isFinite(v) ? DASH : CH.roundHalfUp1(v).toFixed(1); }
  function signed(v) { if (v == null || !isFinite(v)) return DASH; var r = CH.roundHalfUp1(v); return (r > 0 ? "+" : r < 0 ? MINUS : "") + Math.abs(r).toFixed(1); }
  function weekSpan(ws) {
    var out = [], s = ws[0], pv = ws[0];
    for (var i = 1; i <= ws.length; i++) { var w = ws[i]; if (w === pv + 1) { pv = w; continue; } out.push(s === pv ? "Week " + s : "Weeks " + s + " to " + pv); s = w; pv = w; }
    return out.join(", ");
  }
  function startingTag(p) { return p.status === "active" ? (p.starter ? chip("ok", "Starting") : chip("", "Bench")) : ""; }
  function injuryChip(S, p) { var c = R.injuryChip(S, p); return c ? (c.code === "IR" ? R.irBadge() : chip(c.cls, esc(c.text))) : ""; } // R9: the one IR badge

  // ============================== Contracts ==============================
  var CT_FILTERS = [["all", "All"], ["active", "Active"], ["ir", "IR"], ["taxi", "Taxi"]];
  // The sort: one control with four segments (R9, Keith 2026-11-23: Contract exp. | Salary | Position | Name; Contract exp. stays the default). Each starts
  // in its own direction (1 = ascending, -1 = descending); tapping the sort that is already active reverses it. The salary year (0 = this season to 2)
  // matters only while Salary is the sort. Contract exp. and Position draw grouped sections.
  var CT_SORTS = [["exp", "Contract exp.", "contract expiration"], ["sal", "Salary", "salary"], ["pos", "Position", "position"], ["name", "Name", "name"]];
  var POS_LABEL = { PK: "K", PN: "P" };
  var CT_DIR = { exp: 1, sal: -1, pos: 1, name: 1 };
  function isSort(s) { return s === "sal" || s === "exp" || s === "pos" || s === "name"; }
  // R9: the Loading filter (R10 label; it was "Salary structure") reads the rule classification (lib/contract.js describe().structure) only; it is
  // separate from Contract Type. A plain one-year extension is Flat and is in the Flat group.
  // R11 (Keith): the filter heading is "Salary structure" and the choices are All | Flat | Loaded; Loaded combines the supported Front-loaded and
  // Back-loaded classifications. The player's Details keep the detailed "Loading classification" wording.
  var CT_LOADS = [["all", "All", null], ["flat", "Flat", ["Flat"]], ["ld", "Loaded", ["Front-loaded", "Back-loaded"]]];
  function loadOf(v) { var r = CT_LOADS.filter(function (o) { return o[0] === v; })[0]; return r ? r : CT_LOADS[0]; }
  function ctState(S) {
    var c = S.ct || {}, s = isSort(c.s) ? c.s : "exp";
    return { f: c.f || "all", l: loadOf(c.l)[0], s: s, y: c.y === 1 || c.y === 2 ? c.y : 0, d: c.d === 1 || c.d === -1 ? c.d : CT_DIR[s], open: c.open || {}, hist: c.hist || {} };
  }
  // R9: surname order from MFL's own "Last, First" name (rawName), never the last displayed word: "Cooper Jr., Omar" is Cooper / Omar / Jr.,
  // "St. Brown, Amon-Ra" is St. Brown, "Van Ginkel, Andrew" is Van Ginkel. A name without that structure sorts by its whole displayed name.
  var SUFFIX = /^(.*\S)\s+(Jr\.?|Sr\.?|II|III|IV|V)$/i;
  function nameParts(p) {
    var raw = F.str(p && p.rawName), i = raw.indexOf(",");
    if (i < 0) return { last: F.str(p && p.name), first: "", suffix: "" };
    var last = raw.slice(0, i).trim(), first = raw.slice(i + 1).trim(), suffix = "", m = last.match(SUFFIX);
    if (m) { last = m[1]; suffix = m[2]; }
    return { last: last, first: first, suffix: suffix };
  }
  function cmpText(a, b) { return a.localeCompare(b, undefined, { sensitivity: "base" }); }
  function byName(a, b) {
    var x = nameParts(a), y = nameParts(b);
    return cmpText(x.last, y.last) || cmpText(x.first, y.first) || cmpText(x.suffix, y.suffix) || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
  }
  function posIndex(p) { for (var i = 0; i < GROUPS.length; i++) if (GROUPS[i][0] === p.pos) return i; return GROUPS.length; }
  // What a tap on a sort segment does: { s, d }. A different sort starts in its own direction; the same sort again flips the direction.
  function ctNextSort(ct, v) {
    var cur = ctState({ ct: ct }), s = isSort(v) ? v : cur.s;
    return { s: s, d: s === cur.s ? -cur.d : CT_DIR[s] };
  }

  // one player's salary for the k-th remaining year: a number, null (a year with no recorded amount) or undefined (the contract has ended)
  function salaryAt(p, season, k) {
    var sch = C.schedule(p, season);
    return k < sch.rows.length ? sch.rows[k].amount : undefined;
  }
  function longest(team) { return team.players.reduce(function (m, p) { return Math.max(m, p.years || 0); }, 0); }

  function penaltyOf(S, id) { var d = S.penalty && S.penalty.state === "ok" ? S.penalty.data : null; return d ? d[id] || null : null; }

  // R8 (Keith, 2026-11-23): ONE primary amount, "If cut now": the Worker's cut charge (/api/cap-penalty/preview .penalty) under the rule the Worker
  // names in its basis (lib/contract.js cutRule: guarantee, no guarantee, $1K drop rule, taxi). Presentation only: no figure is recomputed.
  // -> { kind: loading | amount | review | unavailable, text, tag (a short rule label or ""), row, rule }. A missing or failed read is never $0.
  function cutCharge(S, p) {
    var st = S.penalty ? S.penalty.state : "idle";
    if (st === "idle" || st === "loading") return { kind: "loading", text: "Loading…" };
    if (st !== "ok") return { kind: "unavailable", text: "Unavailable" };
    var row = penaltyOf(S, p.id);
    if (!row) return { kind: "unavailable", text: "Unavailable" };
    if (row.needs_review) return { kind: "review", text: "Under review", why: F.str(row.review_reason) };
    var cut = C.cutNow(row);
    if (cut.kind !== "amount") return { kind: "unavailable", text: "Unavailable", noFigure: true };   // the read worked but gave no cut charge for this contract
    var r = C.cutRule(row);
    return { kind: "amount", text: money(cut.amount), amount: cut.amount, tag: r.tag, rule: r, row: row };
  }
  function gcell(g) {
    if (g.kind === "loading") return '<span class="mu">' + esc(g.text) + "</span>";
    if (g.kind === "unavailable" || g.kind === "review") return '<span class="wn">' + esc(g.text) + "</span>";
    return "<b>" + esc(g.text) + "</b>" + (g.tag ? '<small class="mu">' + esc(g.tag) + "</small>" : "");
  }
  // The Details line for "If cut now": the amount and one sentence naming the rule (no arithmetic; the guarantee facts are their own line).
  function cutWords(g) {
    if (g.kind === "loading") return "Loading…";
    if (g.kind === "review") return "Under review" + (g.why ? ": " + esc(g.why) : "");
    if (g.kind !== "amount") return g.noFigure ? "Unavailable<small>No cut charge in the cap calculation for this contract.</small>" : "Unavailable";
    return "<b>" + esc(g.text) + "</b><small>" + esc(g.rule.words) + "</small>";
  }
  // The original guarantee and what is earned of it, only under the guarantee rule and only when the Worker gave both figures.
  function guaranteeFacts(S, g) {
    if (g.kind !== "amount" || g.rule.rule !== "guarantee") return "";
    var row = g.row, wk = S.penalty && S.penalty.meta ? S.penalty.meta.earnedThroughWeek : null;
    if (!(typeof row.guaranteed === "number" && isFinite(row.guaranteed))) return "";
    var e = C.earned(row);
    return "<b>Guarantee</b><span>" + money(row.guaranteed) + (e.kind === "amount" ? "<small>" + esc(money(e.amount) + " earned" + (wk != null ? " through Week " + wk : "")) + "</small>" : "") + "</span>";
  }

  // R8: "2025–2027 (3 years) · 2 years left", the contract's dates and years remaining on one line
  function termWords(h) {
    var left = !h.yearsLeft ? "" : h.yearsLeft === 1 ? "Final year" : h.yearsLeft + " years left";
    if (h.length) return h.start + (h.end !== h.start ? "–" + h.end : "") + " (" + plural(h.length, "year", "years") + ")" + (left ? " · " + left : "");
    if (h.end) return "Start not recorded, ends " + h.end + (left ? " · " + left : "");
    return "Not recorded";
  }
  var NR = "Not recorded";

  // R6 Details: the full salary schedule of the CURRENT contract (completed years included, lib/contract.js history), then (R8) the term on one line,
  // Contract Type, Contract Source, later changes, salary structure, If cut now and, under the guarantee rule only, the guarantee. A year with no
  // recorded amount says "Not recorded"; nothing is borrowed from an earlier contract.
  var PHASE = { done: "Completed", now: "This season", left: "Remaining" };
  function detailsHtml(S, p, g) {
    var season = S.model.season, h = C.history(p, season), rows = "";
    h.rows.forEach(function (r) { rows += "<span>" + r.year + '</span><span class="mu">' + PHASE[r.phase] + "</span><span>" + (r.amount == null ? '<span class="wn">Not recorded</span>' : money(r.amount)) + "</span>"; });
    if (h.option) rows += "<span>" + h.option.year + '</span><span class="mu">Option year</span><span>' + money(h.option.amount) + "</span>";
    var note = h.yearsLeft && h.earlier === "unknown" ? "Earlier years of this contract are not recorded." : h.earlier === "conflict" ? "Earlier years are not shown: the recorded terms do not match this season’s salary." :
      h.earlier === "restructured" ? "Restructured in " + h.restructured + ". Years before the restructure are not in the recorded terms." :
      h.restructured != null && h.startWhy === "auction" ? "Restructured in " + h.restructured + ". Salaries before the restructure are not in the recorded terms." : "";
    // R7: who made the extension in force now, from the contract's own Ext: record (lib/contract.js extension); never the current owner by default
    var ext = C.extension(p, season, S.model.teams), extLine = C.extensionLine(ext);
    var hopen = !!ctState(S).hist[p.id];
    // R9: the current contract's schedule and facts come first; the Contract history is below them, collapsed by default
    return '<div class="det"><div class="sec2 first">Salary schedule</div>' + (extLine ? '<div class="ext">' + esc(extLine) + "</div>" : "") + '<div class="yrl">' + (rows || '<span class="mu">No years recorded</span>') + "</div>" + (note ? '<div class="ex">' + esc(note) + "</div>" : "") +
      taxiLine(S, p) + '<div class="kv">' + contractFactsFor(S, p, h, true) + "<b>If cut now</b><span>" + cutWords(g) + "</span>" + guaranteeFacts(S, g) + "</div>" +
      '<button class="rb dtl hsb" data-act="cth" data-v="' + esc(p.id) + '" aria-expanded="' + hopen + '" aria-label="' + (hopen ? "Hide" : "Show") + " contract history for " + esc(p.name) + '">Contract history <span aria-hidden="true">' + (hopen ? "▾" : "▸") + "</span></button>" +
      (hopen ? historyHtml(S, p) : "") + "</div>";
  }
  // R8: Term, Contract Type, Contract Source (its acquisition note when the source is not recorded), Later changes, Loading classification (R10 label;
  // R8/R9 "Salary structure"). Shared with the profile.
  // R9 adds (x, from contractFactsFor): the extension line under Source "Extension", Acquired (how this team got him, kept separate from the
  // contract's source) and the recorded AAV by year. R10 removed R9's "Rule classification; the yearly salaries differ." note.
  function contractFacts(h, d, x) {
    x = x || {};
    var srcNote = d.source === "Extension" ? (d.extended ? d.extended + (d.extended === 1 ? " year added" : " years added") : "") + (x.extLine ? " · " + x.extLine : "") : d.sourceNote || "";
    var acq = x.acq && x.acq.words ? x.acq.words + (x.acq.year != null ? " · " + x.acq.year : "") : "";
    if (acq && d.source !== "Extension") srcNote = "";   // "Acquired by trade" is then the Acquired line itself, not repeated under the source
    return "<b>Term</b><span>" + esc(termWords(h)) + "</span><b>Contract Type</b><span>" + esc(d.type || NR) + "</span><b>Contract Source</b><span>" + esc(d.source || NR) + (srcNote ? "<small>" + esc(srcNote) + "</small>" : "") + "</span>" +
      (acq ? "<b>Acquired</b><span>" + esc(acq) + "</span>" : "") +
      "<b>Later changes</b><span>" + esc(d.changes.length ? d.changes.join(" · ") : "None recorded") + "</span><b>Loading classification</b><span>" + esc(loadingWords(d)) + "</span>" +
      (x.aav ? "<b>AAV</b><span>" + aavWords(x.aav) + "</span>" : "");
  }
  // R10 (Keith, 2026-11-23): "Loading classification: Flat (one-year extension)" for a plain one-year extension (Flat by rule, §C2); otherwise the
  // classification alone (Flat / Front-loaded / Back-loaded) or Not recorded. No note about the yearly salaries.
  function loadingWords(d) {
    if (!d.structure) return NR;
    return d.structure + (d.structureWhy === "one_year_extension" ? " (one-year extension)" : "");
  }
  // "2026 · $15K" / "2027–2028 · $25K", one per line; unmapped tiers: "Recorded: $4K, $24K · years not mapped"; none: Not recorded
  // R10: when only this season is supported, the later years follow as "2027–2028 · not mapped"
  function aavWords(a) {
    if (a.state === "none") return esc(NR);
    if (a.state === "unmapped") return esc("Recorded: " + a.amounts.map(kmoney).join(", ") + " · years not mapped");
    var span = function (f, t) { return f === t ? String(f) : f + "–" + t; }, um = a.unmapped || [];
    return a.lines.map(function (l) { return esc(span(l.from, l.to) + " · " + kmoney(l.amount)); }).join("<br>") +
      (um.length ? "<small>" + esc(span(um[0], um[um.length - 1]) + " · not mapped") + "</small>" : "");
  }
  // inDetails: Team › Contracts Details already print the extension line above the schedule, so the source says only how many years were added
  // (the attribution appears once); the profile, which has no such line, carries it under the source
  function contractFactsFor(S, p, h, inDetails) {
    var season = S.model.season, teams = S.model.teams;
    h = h || C.history(p, season);
    return contractFacts(h, C.describe(p), { extLine: inDetails ? "" : C.extensionLine(C.extension(p, season, teams)), acq: C.acquisitionOf(p.acquisition), aav: C.aavYears(p, season, teams) });
  }
  // R9: Contract history (collapsed by default): dated events by season, then the ones with no season; a season worked out from the contract terms
  // says so. One line says when the history is incomplete; eligibility is not judged here (the app has no extension-eligibility rules).
  var HWHY = { terms: "Season from the contract terms", restructure: "Season from the restructured terms", reviewed: "Team and season from UPS’s reviewed list" };
  function historyHtml(S, p) {
    var hh = C.contractHistory(p, S.model.season, S.model.teams);
    var li = hh.events.map(function (e) {
      return "<li><b>" + (e.year != null ? esc(e.year) : DASH) + "</b><span>" + esc(e.words) + (HWHY[e.why] ? "<small>" + esc(HWHY[e.why]) + "</small>" : "") + "</span></li>";
    }).join("");
    return '<div class="hist">' + (hh.complete ? "" : '<div class="ex">Incomplete: only what the contract record and roster show' + (hh.extTeamsComplete ? "" : ", and the record may not name the team that made the current extension") + (hh.events.some(function (e) { return e.year == null; }) ? "; " + DASH + " season not recorded" : "") + ".</div>") +
      (li ? '<ol class="hil">' + li + "</ol>" : '<div class="ex">No events recorded.</div>') + '<div class="ex">Seasons only, no dates. Extension eligibility is not shown.</div></div>';
  }

  function contractsBody(S) {
    var t = teamOf(S), m = S.model, season = m.season, c = ctState(S), out = "";
    var ny = Math.max(1, longest(t));
    var want = loadOf(c.l)[2];
    var list = t.players.filter(function (p) { return (c.f === "all" || p.status === c.f) && (!want || want.indexOf(C.describe(p).structure) >= 0); });
    function sal(p, k) { var v = salaryAt(p, season, k); return v; }
    // Each sort is written in its own starting direction (Expiration soonest first, Salary highest first, Position QB to DB, Name A to Z by surname); the
    // direction multiplies the whole comparison, so a reversed list is the exact reverse of the first (groups and the order inside them).
    var base = {
      exp: function (a, b) { return ((a.years || 0) - (b.years || 0)) || ((sal(b, 0) || 0) - (sal(a, 0) || 0)) || byName(a, b); },
      sal: function (a, b) { return ((sal(b, c.y) || 0) - (sal(a, c.y) || 0)) || ((sal(b, 0) || 0) - (sal(a, 0) || 0)) || byName(a, b); },
      pos: function (a, b) { return (posIndex(a) - posIndex(b)) || ((sal(b, 0) || 0) - (sal(a, 0) || 0)) || byName(a, b); },
      name: byName
    }[c.s], dir = c.d * CT_DIR[c.s];   // CT_DIR[s] is the sort's own starting direction; c.d is the direction now in use
    list = list.slice().sort(function (a, b) { return dir * base(a, b); });

    // R6: ONE cap card (the separate recorded-salary summary card is gone; Total committed cap by year is inside the cap card)
    var cols = "g" + (ny + 1), yrs = [];
    for (var k = 0; k < ny; k++) yrs.push(season + k);
    out += capCard(S, t);

    out += '<div class="lbl">Roster status</div><div class="chs" role="group" aria-label="Roster status">' + CT_FILTERS.map(function (o) { return '<button class="ch" data-act="ctf" data-v="' + o[0] + '" aria-pressed="' + (c.f === o[0]) + '">' + o[1] + "</button>"; }).join("") + "</div>";
    out += '<div class="lbl">Salary structure</div><div class="chs ldc" role="group" aria-label="Salary structure">' + CT_LOADS.map(function (o) { return '<button class="ch" data-act="ctl" data-v="' + o[0] + '" aria-pressed="' + (c.l === o[0]) + '">' + o[1] + "</button>"; }).join("") + "</div>";
    // ONE sort control: Contract exp. | Salary | Position | Name. The active segment shows its direction (▲ ascending, ▼ descending) and says it in words; tapping it again reverses.
    var DIRW = { sal: ["lowest first", "highest first"], exp: ["soonest first", "latest first"], pos: ["QB first", "DB first"], name: ["A to Z", "Z to A"] };   // [ascending, descending]
    out += '<div class="lbl">Sort</div><div class="seg seg4" role="group" aria-label="Sort">' + CT_SORTS.map(function (o) {
      var on = c.s === o[0], shown = on ? DIRW[o[0]][c.d === 1 ? 0 : 1] : "";
      return '<button data-act="cts" data-v="' + o[0] + '" aria-pressed="' + on + '" aria-label="' + (on ? "Sorted by " + o[2] + ", " + shown + ". Tap to reverse." : "Sort by " + o[2]) + '">' + o[1] + (on ? ' <span aria-hidden="true">' + (c.d === 1 ? "▲" : "▼") + "</span>" : "") + "</button>";
    }).join("") + "</div>";
    if (c.s === "sal") out += '<div class="chs" role="group" aria-label="Salary year">' + [0, 1, 2].map(function (i) { return '<button class="ch" data-act="cty" data-v="' + i + '" aria-pressed="' + (c.y === i) + '" aria-label="' + (season + i) + ' salary">' + (season + i) + "</button>"; }).join("") + "</div>";

    // R9: the column heads sit INSIDE the list container, on the same grid and inset as the row amounts
    var thead = '<div class="thead ' + cols + '"><span>If cut now</span>' + yrs.map(function (y) { return "<span>" + y + "</span>"; }).join("") + "</div>";
    function groupHead(label, grp) {
      var sum = 0, any = false; grp.forEach(function (p) { var v = sal(p, 0); if (v != null) { sum += v; any = true; } });
      return '<div class="gh3"><span>' + label + " · " + plural(grp.length, "player", "players") + "</span><span>" + (any ? kmoney(sum) + " " + season + " salary" : DASH) + "</span></div>";
    }

    function rowHtml(p) {
      var open = !!c.open[p.id], g = cutCharge(S, p);
      var exp = p.years > 0 ? "Expires " + (season + p.years - 1) : "Expiration not recorded";
      var meta = esc(F.commonCode(p.nflTeam) || "No NFL team") + " · " + esc(exp);
      var cells = '<span class="g">' + gcell(g) + "</span>";
      for (var i = 0; i < ny; i++) { var v = sal(p, i); cells += "<span>" + (v === undefined ? '<span class="mu">' + DASH + "</span>" : v == null ? '<span class="wn">n/r</span>' : kmoney(v)) + "</span>"; }
      // Two separate controls: the player's NAME (with his position badge) opens his profile; a quiet "Details" control opens or closes the contract details.
      var h = '<div class="rw"><div class="rwh"><button class="nmb" data-act="card" data-pid="' + esc(p.id) + '" aria-label="Open ' + esc(p.name) + ' profile"><span class="l1">' + pcx(POS_LABEL[p.pos] || p.pos) + ' <span class="nmt">' + esc(p.name) + "</span>" + (p.status === "ir" ? " " + R.irBadge() : p.status === "taxi" ? " " + chip("", "Taxi") : "") + '</span></button>' +
        '<button class="rb dtl" data-act="ctx" data-v="' + esc(p.id) + '" aria-expanded="' + open + '" aria-label="' + (open ? "Hide" : "Show") + " contract details for " + esc(p.name) + '">Details <span aria-hidden="true">' + (open ? "▾" : "▸") + "</span></button></div>" +
        '<div class="l2">' + meta + '</div><div class="cells ' + cols + '">' + cells + "</div>";
      if (open) h += detailsHtml(S, p, g);
      return h + "</div>";
    }
    if (!list.length) out += '<div class="ex pad">No players in this group.</div>';
    else {
      var body = "";
      if (c.s === "exp") {
        // the groups follow the direction too: soonest expiring first, or latest first when reversed (the players inside each group are already in the reversed order)
        for (var gi = 1; gi <= ny; gi++) {
          var yl = c.d === 1 ? gi : ny + 1 - gi;
          var grp = list.filter(function (p) { return (p.years || 0) === yl; });
          if (grp.length) body += groupHead("Expires <b>" + (season + yl - 1) + "</b>", grp) + grp.map(rowHtml).join("");
        }
        var none = list.filter(function (p) { return !(p.years > 0); });
        if (none.length) body += groupHead("Expiration not recorded", none) + none.map(rowHtml).join("");
      } else if (c.s === "pos") {
        // R9: Position draws grouped sections like Contract exp., in the league's position order (reversed with the direction)
        for (var pi = 0; pi <= GROUPS.length; pi++) {
          var ix = c.d === 1 ? pi : GROUPS.length - pi;
          var pg = list.filter(function (p) { return posIndex(p) === ix; });
          if (pg.length) body += groupHead(ix < GROUPS.length ? pcx(GROUPS[ix][1]) : "Position not recorded", pg) + pg.map(rowHtml).join("");
        }
      } else body = list.map(rowHtml).join("");
      out += '<div class="card rows ctl">' + thead + body + "</div>";
    }

    var st = S.penalty ? S.penalty.state : "idle";
    // What the symbols mean and where the figures come from live in the Help control (one per Team screen), not under the table.
    if (st === "error") out += failCard("retrypen");
    return out;
  }

  // The one pattern for a technical failure: a plain sentence, Retry, and a visibly disabled Report bug placeholder. The placeholder has no
  // handler of any kind: it copies nothing, sends nothing, notifies no one and logs nothing.
  function failCard(retryAct, retryV) {
    return '<div class="card warnc"><div class="big2"><b>Couldn’t load this</b></div><div><button class="btn" data-act="' + esc(retryAct) + '"' + (retryV ? ' data-v="' + esc(retryV) + '"' : "") + '>Retry</button> <button class="btn" disabled aria-disabled="true">Report bug</button></div></div>';
  }
  function smoney(n) { return n == null || !isFinite(n) ? DASH : (n > 0 ? "+" : n < 0 ? MINUS : "") + money(Math.abs(n)); }
  // "Taxi-eligible", once per player (R8: the cut charge itself is on the If cut now line, not repeated here; the sentence that explains it is in Help).
  function taxiLine(S, p) {
    return p.taxi && p.taxi.eligible === true ? '<div class="ex"><b class="ok">Taxi-eligible</b></div>' : "";
  }

  // ---- Help: one control per Team screen; this is its text for each tab ----
  function screenHelp(S) {
    var rec = S && S.recorded ? "<h4>Recorded data</h4><p>This preview uses a recorded snapshot taken " + esc(S.recorded.label) + ", so the figures will not move." + (S.recorded.later ? " Game stats, season totals and projections were recorded later that day, " + esc(S.recorded.later) + "." : "") + "</p>" : "";
    return rec + screenHelpBody(S);
  }
  function screenHelpBody(S) {
    var sub = S.sub, m = S.model, wk = S.penalty && S.penalty.meta ? S.penalty.meta.earnedThroughWeek : null, asOf = m ? F.etStamp(m.asOf) : "";
    var G = A.NEXT_SEASON_GAP;
    function h(title, text) { return "<h4>" + esc(title) + "</h4><p>" + text + "</p>"; }
    if (sub === "contracts") {
      return h("Available cap space", "Total cap minus Cap charge. A negative number means the team is over the cap.") +
        h("Total cap", "The salary cap for the season, as the league’s roster read reports it. If it is not reported, no available figure is shown.") +
        h("Total committed cap", "Salaries, less taxi relief (taxi squad players count $0) and injured reserve relief (half of each injured reserve player’s salary). Adjustments are not part of it.") +
        h("Cap charge", "Total committed cap plus or minus the adjustments (Cut penalties, Traded salary, Other, Rounding). It is what counts against the cap, so Available cap space is Total cap minus Cap charge.") +
        h("Later years", "Each later year shows its Total committed cap. This season gives injured reserve players half relief and taxi players $0. <b>Planning assumption for later years:</b> players now on taxi stay on taxi ($0) and injured reserve players count at full scheduled salary. No injury relief is projected. A year’s Details list the adjustments recorded for it; next season’s come from the UPS ledger, and no source records adjustments for the years after that, so none are shown (that is not $0).") +
        h("Salary schedule", "A player’s Details list every year of his current contract as MFL records it, completed years included. A year with no recorded amount says “Not recorded”. Salaries from an earlier contract are never added.") +
        h("Extensions", "An extension starts a new current contract in the season it is made: it keeps that season’s salary and adds one or two years, so a player extended this season for two years shows this season and the next two. “Extended by” names the team that made that extension, from the contract’s own extension record, even if he has changed teams since. When the record does not name a current team, no team is shown. When the extension’s season is known only from restructured terms, the record’s last name may not be the team that made it, so it reads “extending team not verified” and the names appear only in the Contract history, unless UPS’s reviewed list confirms the team and season for that exact contract. A restructure keeps the contract but MFL then records only the years from the restructure on, so earlier years can be missing.") +
        h("Taxi", "A taxi-eligible player can be released with a $0 cut charge while taxi eligibility applies. Releasing ends eligibility.") +
        h("Where the numbers come from", "Contracts as recorded on MFL" + (asOf ? " (as of " + esc(asOf) + ")" : "") + ". Earned, guarantee and cut charge: the UPS cap calculation" + (wk != null ? " through Week " + esc(wk) : "") + ".") +
        h("Symbols", esc(DASH) + " contract ended · n/r no amount recorded.") +
        h("Adjustments", "Cut penalties, Traded salary (including three-team trades), Other, Rounding. Other holds every fine, FA auction fines included, each named in its row, and any posted adjustment that fits no category; its reason is not guessed. Adjustments are charged to the season in the heading (the charge season); a cut date can be in an earlier season. A traded-salary entry names the other team and the trade date only when a trade record links them; this preview has no trade records, so each says “Trade details not recorded”.") +
        h("Player names", "A name comes from the player ID on the charge, looked up in MFL’s complete player list (so it works whether or not he is on a roster now), or, for older add/drop records that carry no player ID, from UPS’s reviewed list. If neither names him it reads “Player Unknown”. A fine, rounding or settlement has no player.") +
        h("Cut dates", "Dates are Eastern Time and shown only when verified: the date comes from the drop time recorded on the charge, from UPS’s reviewed list, or, for next season, from the ledger’s drop time. Otherwise the row says “Cut date not recorded”. Waiver drops process at 9:00 AM ET, so only the date is shown.") +
        h("If cut now", "What cutting the player today would charge against the cap, from the UPS cap calculation. Most contracts use the guarantee rule: the guaranteed amount (75% of the contract’s total value) not yet earned; “Fully earned” means nothing is owed. Small contracts use their own rule instead: <b>No guarantee</b> (a one-year original contract under $5K, or a waiver pickup of $4K or less in its final year, is cut free), <b>$1K rule</b> (a contract worth under $5K costs $1K while two or more years remain and nothing in its final year), or <b>Taxi</b> (a taxi-eligible player is cut free). A player’s Details name the rule, and show the guarantee and what is earned of it only under the guarantee rule.") +
        h("Contract Type and Source", "Contract Type is Veteran or Rookie. Contract Source is how the current contract began (Rookie Draft, FA Auction, Expired Rookie Auction, Waiver Wire, including FCFS, or Extension, with the team that extended him and the season when the record supports it). Acquired is how his current team got him, kept separate. Later changes (Mid-Year Multi, a restructure, a tag) are listed separately. Loading classification is the league’s rule classification, Flat, Front-loaded or Back-loaded; a one-year extension is Flat by rule. A fact the contract record does not state reads “Not recorded”.") +
        h("AAV", "The average annual value as MFL records it, labeled with the years it applies to. After an extension the current season keeps its old AAV and the added years carry the new one. A later year is shown only when the contract’s rules and its recorded total value support it; otherwise only this season is shown and the later years say “not mapped”. When the record does not show which years an amount belongs to, it says “years not mapped”. AAV is never worked out from the total value.") +
        h("Contract history", "Inside a player’s Details: how the contract began, how his team acquired him, every extension in the contract’s extension record (oldest first), restructures and tags, by season. Seasons only, no dates; a season worked out from the contract terms says so. Earlier events never add years to the salary schedule. Extension eligibility is not shown.") +
        h("Next-season adjustments", esc(G.completeness) + " " + esc(G.reconciliation) + " " + esc(G.calculation));
    }
    if (sub === "performance") {
      return h("Through Week", "Every season figure and both ranks run through one week for everyone: the last week in which every NFL game is final. Newer scores appear in each player’s game log, outside the season figures. Missing or late team history does not hold any figure back.") +
        h("Tot. Pts., PPG, scored games", "Tot. Pts. is the player’s official MFL scores added up. PPG is Tot. Pts. divided by scored games, the games with a recorded score (0.0 and negative scores count; a game with no recorded score does not). A 0.0 is a score MFL recorded; it is not proof that he played.") +
        h("Ranks", "QB2 is the player’s place among players at his position (tied players share a place). QB2–4 means some players cannot be placed yet (no position on file, a score that could not be read, or a PPG eligibility that is not settled), so he could be anywhere from 2nd to 4th. Ranges can narrow as weeks complete. " + esc(DASH) + " means no supported rank. The PPG rank needs scores in at least half of the team’s games. For a range, the Breakdown says why and how large the group could be. The game log’s Rank column is the player’s exact place at his position that week (WR3), shown only for completed weeks and only when it is exact; otherwise " + esc(DASH) + ".") +
        h("PPG rank without team history", "Where a player’s NFL team history is available, the half-of-team-games rule uses the games of the club or clubs he was with. Where it is not (this recording has none), his current NFL club’s schedule is used instead: every week through the season cutoff is a team game except his club’s bye. That is a provisional basis, not independently verified, and a player’s Breakdown says so. A known earlier club is never replaced by the current one. A player whose evidence contradicts it (a score in his current club’s bye week, more scores than his club has played, no current club or bye on file, or a recorded club change that history does not yet cover) has no PPG rank, with the reason in his Breakdown; his points and PPG still show, and no one else is affected.") +
        h("xFP PPG and Over Expectations", "Not Available until the expected-points model is approved.") +
        h("Projection", "Provider: MFL. “Week N Proj.” is MFL’s last projection for the lineup week captured before the player’s game kicked off. Not Available when there is none (for example a bye).") +
        h("Position, Search players and Sort", "Position shows one position (All shows everyone); only positions on this team are offered. Search players finds this team’s players by name, within that position. Sort orders what is shown; By position groups it. When no one on this team matches, Search other teams lists rostered players on the other league teams with their team, with its own Position choice covering every position among them; free agents are not searched. Closing a profile returns to the same team, search, position, sort and place in the list.") +
        (SR && SR.helpText ? h("Season stat ranks", esc(SR.helpText())) : "");
    }
    if (sub === "cap") return h("Cap & picks", "Not in this preview.");
    return h("Recorded starters", "A past week shows the starters and scores MFL recorded. Slots, positions, bench, injured reserve, taxi, injuries and contracts are shown for the current week only.") +
      h("Can’t check", "MFL lists this player as a starter but he is not in the roster that loaded. His position, slot and status are unknown, so nothing is checked for him. Everyone else is still checked.") +
      h("Doubtful", "A decision may be needed. It does not mean the player is out.") +
      h("Kickoff", "Every matchup shows its kickoff in Eastern Time.");
  }

  // ---- PR A: the cap charge, its Breakdown, and cap commitments by year ----
  // The name drawn for a cut penalty: a name the row already carries (the roster, or UPS's reviewed list), else the player id looked up in MFL's complete player
  // list (S.intel.players). While that list is loading the name is a quiet "…"; if it failed, "Name unavailable"; "Player Unknown" only when the list loaded
  // and does not hold the id, or when the row has no id and no reviewed-list match. A row with no player (a fine, a rounding, a settlement) never comes here.
  function playerLabel(S, it) {
    if (it.playerName) return { text: F.flipName(it.playerName), cls: "" };   // one display order everywhere: "First Last" (MFL's list and UPS's reviewed list write "Last, First")
    if (!it.playerId) return { text: A.UNKNOWN_PLAYER, cls: "" };
    var pl = S.intel && S.intel.players;
    if (pl && pl.state === "ok" && pl.data && pl.data.byId) { var e = pl.data.byId[it.playerId]; return e && e.name ? { text: F.flipName(e.name), cls: "" } : { text: A.UNKNOWN_PLAYER, cls: "" }; }
    if (pl && pl.state === "error") return { text: "Name unavailable", cls: "wn" };
    return { text: "…", cls: "mu" };
  }
  // R6: the four parent rows of the adjustment Breakdown, in this order. Every fine (FA auction fines included) and any unclassified adjustment sits
  // under Other; the internal categories (lib/adjust.js) are unchanged. [state key, label, internal categories]
  var ADJ_GROUPS = [["cut", "Cut penalties", ["Cut Penalty"]], ["trade", "Traded salary", ["Traded Salary"]], ["other", "Other", ["FA Auction Fine", "Other"]], ["round", "Rounding", ["Rounding"]]];
  var ORD = ["th", "st", "nd", "rd"];
  // R8: a trade date in full ("November 12, 2026"), from a valid YYYY-MM-DD only (F.dateLabel validates it); anything else is ""
  var FULL_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  function fullDate(ymd) { return F.dateLabel(ymd) ? FULL_MONTHS[Number(ymd.slice(5, 7)) - 1] + " " + Number(ymd.slice(8, 10)) + ", " + ymd.slice(0, 4) : ""; }
  function ordinal(n) { var v = n % 100; return n + (v >= 11 && v <= 13 ? "th" : ORD[n % 10] || "th"); }
  // One adjustment entry. The season is in the section heading, so no row repeats it. A cut penalty: the player, the full cut date (ET), the amount.
  // A fine: which fine it is. A trade: a trade or a three-team trade. Anything else: "Other adjustment" (its reason is not guessed).
  function itemRows(S, items) {
    return items.map(function (it) {
      var who, sub = "";
      if (it.category === "Cut Penalty") {
        var pn = playerLabel(S, it);
        who = pn.cls ? '<span class="' + pn.cls + '">' + esc(pn.text) + "</span>" : esc(pn.text);
        sub = it.cutDate && F.dateLabel(it.cutDate) ? "Cut " + F.dateLabel(it.cutDate) : "Cut date not recorded";
      } else if (it.category === "Traded Salary") {
        // R8: the opposing UPS team(s) and the trade date only from a trade transaction linked to this adjustment. No read in this preview carries
        // one (the app's routes exclude MFL transactions), and the settlement text alone is not evidence, so every entry says so.
        var tr = it.trade && it.trade.linked === true && it.trade.teams && it.trade.teams.length && fullDate(it.trade.date) ? it.trade : null;
        who = tr ? "Trade with " + esc(tr.teams.join(" and ")) : it.detail && it.detail.kind === "three_team" ? "Three-team trade" : "Trade";
        sub = tr ? fullDate(tr.date) : "Trade details not recorded";
      }
      else if (it.category === "FA Auction Fine") {
        who = "FA auction fine"; var d = it.detail || {};
        sub = d.kind === "rule2_missed_nomination" ? "Rule 2, missed nomination" + (F.dateLabel(d.date) ? ", " + F.dateLabel(d.date) : "") + (d.nth > 0 ? " (" + ordinal(d.nth) + " offense)" : "") : d.kind === "rule2" ? "Rule 2" : "";
      } else who = "Other adjustment";
      return '<div class="cl"><span class="who">' + who + (sub ? '<span class="ex">' + esc(sub) + "</span>" : "") + "</span><b>" + smoney(it.amount) + "</b></div>";
    }).join("");
  }
  // cut penalties in cut-date order (earliest first; an unrecorded date last); everything else keeps the source order
  function byCutDate(rows) {
    return rows.map(function (it, i) { return { it: it, i: i }; }).sort(function (a, b) {
      var x = a.it.cutDate || "", y = b.it.cutDate || "";
      return x && y ? (x < y ? -1 : x > y ? 1 : a.i - b.i) : x ? -1 : y ? 1 : a.i - b.i;
    }).map(function (o) { return o.it; });
  }
  // The four parent rows with signed totals (a reconciled list, so an empty category is a real $0), Rounding as a plain amount, then Total adjustments.
  function categoryLines(S, adj, pre) {
    var out = "";
    ADJ_GROUPS.forEach(function (g) {
      var rows = adj.items.filter(function (it) { return g[2].indexOf(it.category) >= 0; }), sum = 0;
      rows.forEach(function (it) { sum += it.amount; });
      if (g[0] === "round" || !rows.length) { out += '<div class="cl"><span>' + g[1] + "</span><b>" + smoney(sum) + "</b></div>"; return; }   // nothing to open
      var open = !!(S.ct && S.ct.cat && S.ct.cat[pre + g[0]]);
      out += '<div class="cl pr"><button class="link" data-act="ctcat" data-v="' + esc(pre + g[0]) + '" aria-expanded="' + open + '">' + g[1] + " " + (open ? "▾" : "▸") + "</button><b>" + smoney(sum) + "</b></div>";
      if (open) out += '<div class="det adj">' + itemRows(S, g[0] === "cut" ? byCutDate(rows) : rows) + "</div>";
    });
    return out + '<div class="cl"><b>Total adjustments</b><b>' + smoney(adj.total) + "</b></div>";
  }
  // A signed dollar figure with a real minus sign for a negative ("−$5,000"); a positive one is plain.
  function negmoney(n) { return n < 0 ? MINUS + money(Math.abs(n)) : money(n); }
  // ONE card: this season's cap (Available cap space large, Total cap beside it, the Breakdown) and the later years under it.
  function capCard(S, t) {
    var m = S.model, season = m.season, b = t.cap ? A.capBreakdown(t, t.cap) : null, limit = m.capLimit == null ? null : m.capLimit;
    var out = '<div class="card"><h2>Cap space · ' + season + " season</h2>";
    if (!b || b.capCharge == null) out += '<div class="ex">Unavailable: this roster read did not include the team’s cap total.</div>';
    else {
      var charge = b.capCharge, avail = limit == null ? null : limit - charge, over = avail != null && avail < 0;
      // Available cap space is Total cap minus Cap charge. If the league's cap was not read, no available figure is drawn (the cap is never assumed).
      if (avail != null) out += '<div class="capfig"><div class="capa"><div class="big' + (over ? " wn" : "") + '">' + negmoney(avail) + '</div><div class="ex">Available cap space' + (over ? ' · <b class="wn">Over the cap</b>' : "") + '</div></div><div class="capt"><b>' + money(limit) + '</b><div class="ex">Total cap</div></div></div>';
      else out += '<div class="big">' + money(charge) + '</div><div class="ex">Cap charge</div><div class="ex wn">Total cap unavailable</div>';
      var open = !!(S.ct && S.ct.bd);
      out += '<div><button class="link" data-act="ctbd" aria-expanded="' + open + '">Breakdown ' + (open ? "▾" : "▸") + "</button></div>";
      if (open) {
        var adj = t.adjust, lines = "";
        if (!b.ok) lines = '<div class="ex wn">The salary lines don’t add up to the cap total, so only the total is shown.</div>';
        else {
          // salaries, less the two reliefs, make Total committed cap; the adjustments move it to Cap charge; Cap charge against Total cap gives Available cap space
          lines = '<div class="cl"><span>Salaries, ' + plural(b.recordedN, "player", "players") + "</span><b>" + money(b.recorded) + "</b></div>" +
            (b.taxiN ? '<div class="cl mu"><span>Taxi relief, ' + plural(b.taxiN, "player", "players") + "</span><b>" + MINUS + money(b.taxi) + "</b></div>" : "") +
            (b.irN ? '<div class="cl mu"><span>Injured reserve (50%), ' + plural(b.irN, "player", "players") + "</span><b>" + MINUS + money(b.irRelief) + "</b></div>" : "") +
            '<div class="cl"><b>Total committed cap</b><b>' + money(b.capHits) + "</b></div>";
          if (adj && adj.reconciled && Math.abs(adj.total - t.cap.adjTotal) < 0.5) lines += '<div class="sec2">' + season + " adjustments</div>" + categoryLines(S, adj, "y26");
          else if (t.cap.adjTotal) lines += '<div class="cl"><span>Adjustments</span><b>' + smoney(t.cap.adjTotal) + '</b></div><div class="ex wn">Detail unavailable: ' + esc(adj && adj.mismatch ? adj.mismatch : "the adjustments could not be itemized") + ".</div>";
          lines += '<div class="cl"><b>Cap charge</b><b>' + money(charge) + "</b></div>";
          if (limit != null) lines += '<div class="cl"><span>Total cap</span><b>' + money(limit) + '</b></div><div class="cl"><b>Available cap space</b><b' + (over ? ' class="wn"' : "") + ">" + negmoney(avail) + "</b></div>";
          else lines += '<div class="ex wn">Total cap unavailable</div>';
        }
        out += '<div class="det">' + lines + "</div>";
      }
    }
    return out + laterYears(S, t, b) + "</div>";
  }
  function nextAdj(S, t) {
    var ns = S.ns || { state: "idle" };
    if (ns.state === "ok") {
      var p = ns.by && ns.by[t.id];
      if (!p) return { known: false, total: null, state: "unsupported" };
      return p.reconciled && p.complete ? { known: true, total: p.total, state: "ok", parsed: p } : { known: false, total: null, state: "incomplete", parsed: p };
    }
    return { known: false, total: null, state: ns.state };
  }
  // R6: the later years, inside the cap card: one compact row per year with its Total committed cap (the planning assumption is in Help). Next season
  // opens to its supported adjustments (the UPS ledger: one read, made when the row is first opened and then reused). The year after has no adjustment
  // source, so it has no Details and no adjustment figure (never $0). A year with an unrecorded salary shows no total: an incomplete figure is not
  // drawn as complete.
  function laterYears(S, t) {
    var season = S.model.season;
    var adj0 = t.adjust && t.adjust.reconciled && t.cap && Math.abs(t.adjust.total - t.cap.adjTotal) < 0.5 ? { known: true, total: t.cap.adjTotal, state: "ok" } : { known: false, total: null, state: "unavailable" };
    var adj1 = nextAdj(S, t), ys = A.commitments(t, season, adj0, adj1, 3), out = '<div class="sec2">Total committed cap, later years</div>';
    ys.forEach(function (y, i) {
      if (i === 0) return;   // this season is the figure above
      var fig = y.hitsIncomplete ? DASH : money(y.hits);
      var miss = y.hitsIncomplete ? '<div class="ex wn">' + plural(y.unknownCount, "salary", "salaries") + " not recorded</div>" : "";
      if (i === 1) {
        var open = !!(S.ct && S.ct.ns);
        out += '<button class="link blk fy" data-act="nsx" aria-expanded="' + open + '"><span class="cl"><span>' + y.year + ' <span class="dtw">Details ' + (open ? "▾" : "▸") + "</span></span><b>" + fig + "</b></span></button>" + miss;
        if (open) out += nextDetail(S, t, y);
      } else out += '<div class="cl fy"><span>' + y.year + "</span><b>" + fig + "</b></div>" + miss;
    });
    return out;
  }
  function nextDetail(S, t, y) {
    var ns = S.ns || { state: "idle" }, season = S.model.season + 1;
    if (ns.state === "idle" || ns.state === "loading") return '<div class="det"><div class="ex mu">Loading…</div></div>';
    if (ns.state === "error") return '<div class="det">' + failCard("retryns") + "</div>";
    var p = ns.by && ns.by[t.id];
    if (!p) return '<div class="det"><div class="ex">No ' + season + " adjustments are recorded for this team.</div></div>";
    var out = '<div class="det">';
    if (p.reconciled) {
      if (!p.items.length) out += '<div class="ex">No ' + season + " adjustments recorded yet.</div>";
      else {
        // the same order as this season: Total committed cap, the adjustments, then the year's Cap charge, the last only when every part is known
        // (all salaries recorded and the adjustments complete)
        var whole = y && y.total != null;
        out += (whole ? '<div class="cl"><span>Total committed cap</span><b>' + money(y.hits) + "</b></div>" : "") + '<div class="sec2' + (whole ? "" : " first") + '">' + season + " adjustments</div>" + categoryLines(S, p, "y27");
        if (whole) out += '<div class="cl"><b>Cap charge</b><b>' + money(y.total) + "</b></div>";
      }
    }
    out += '<div class="ex">Recorded by UPS; on MFL after the rollover.</div>';
    if (p.waiting) out += '<div class="ex wn">' + plural(p.waiting, "cut is", "cuts are") + " waiting for a price and not counted.</div>";
    if (p.review) out += '<div class="ex wn">' + plural(p.review, "cut needs", "cuts need") + " review and not counted.</div>";
    var onMfl = (p.unverifiedWhy && p.unverifiedWhy.already_on_mfl) || 0, unv = (p.unverified || 0) - onMfl;
    if (onMfl) out += '<div class="ex wn">' + plural(onMfl, "record is", "records are") + " already on MFL and not counted here.</div>";
    if (unv > 0) out += '<div class="ex wn">' + plural(unv, "record", "records") + " could not be verified and not counted.</div>";
    if (!p.reconciled) out += '<div class="ex wn">Detail unavailable: ' + esc(onMfl && unv <= 0 ? "records already on MFL are not counted, so the total cannot be checked" : p.mismatch || "the items do not add up") + ".</div>";
    return out + "</div>";
  }

  // ============================== Performance ==============================
  // R6 main screen (Keith 2026-11-23, sections 5, 6, 11, 12). One card per player: identity (the name opens the profile), the scored-game count once,
  // Tot. Pts. and PPG with their own compact positional ranks, xFP PPG and Over Expectations beneath (both "Not Available": the hard gate below),
  // the week-labeled projection (secondary), and a quiet "Breakdown" text control. Every player of the team is listed, grouped by position (no
  // All / Starters / Bench filter). Every season figure runs through ONE week (seasonCutoff), said once at the top.
  var PF_SORTS = [["pos", "By position"], ["tot", "Tot. Pts."], ["ppg", "PPG"]];
  var NOT_AVAILABLE = "Not Available";
  // R9: the position filter (All, QB, RB, WR, TE, K, P, DL, LB, DB: the chips the UPS mobile site uses), composed with Search players and the sort.
  // "By position" is a sort (grouping); the filter narrows the list. pos: "all" or an MFL group id (PK, PN for K, P). xt: the owner asked to
  // search the other teams (only offered when nothing on this team matches the typed name).
  var PF_POS = [["all", "All"]].concat(GROUPS);
  function pfPosOk(v) { return PF_POS.some(function (o) { return o[0] === v; }); }
  function pfState(S) {
    var c = S.pf || {}, s = c.s === "avg" ? "ppg" : c.s;
    return { s: s === "tot" || s === "ppg" ? s : "pos", open: c.open || {}, res: c.res || {}, pos: pfPosOk(c.pos) ? c.pos : "all", xt: !!c.xt, xpos: pfPosOk(c.xpos) ? c.xpos : "all" };
  }
  // R10 (Keith: "Show All plus positions represented on the selected team"): the chips are All + the positions on this team's roster (IR and
  // Taxi included), in league order. A filter for a position the team does not have shows everyone (app.js resets it on a team switch and says so once).
  function posOf(players) { return GROUPS.filter(function (g) { return players.some(function (p) { return p.pos === g[0]; }); }); }
  function teamPos(t, pos) { return pos !== "all" && posOf(t.players).some(function (g) { return g[0] === pos; }) ? pos : "all"; }
  function pfStateFor(S, t) { var c = pfState(S); c.pos = teamPos(t, c.pos); return c; }
  function posChips(act, list, on) { return list.map(function (o) { return '<button class="ch" data-act="' + act + '" data-v="' + o[0] + '" aria-pressed="' + (on === o[0]) + '">' + o[1] + "</button>"; }).join(""); }
  // R10: switching to team t keeps the filter when t has that position; otherwise it goes back to All, said once. -> { pos, note } for app.js.
  function pfTeamSwitch(S, t) {
    var pos = pfState(S).pos;
    if (!t || pos === "all" || teamPos(t, pos) === pos) return { pos: pos, note: null };
    return { pos: "all", note: "No " + posWord(pos) + " on " + t.name + ", so Position is back to All." };
  }
  function posWord(g) { var o = GROUPS.filter(function (x) { return x[0] === g; })[0]; return o ? o[1] : g; }

  // The shared season cutoff W* (section 6): { state: "ok", week, allFinal, reason, historyThrough } once the last all-final week is established, else
  // { state, week: null } (the completion state: loading, error, none, unavailable, conflict). The Breakdown and game log use this same week.
  function seasonCutoff(S) {
    var C0 = completion(S);
    if (C0.state !== "ok") return { state: C0.state, week: null, allFinal: null, reason: null };
    var mu = S.intel.mu[S.model.week], sc = CH.seasonCutoff(C0.week, mu.data.hist);
    return { state: "ok", week: sc.week, allFinal: sc.allFinal, reason: sc.reason, historyThrough: sc.historyThrough, gap: sc.gap };
  }

  // everything clubhist needs, from the state, cut at W*. null while the matchup read (latest final week, team history) is not in.
  function perfInput(S, ids) {
    var cur = S.model.week, mu = S.intel && S.intel.mu && S.intel.mu[cur];
    if (!mu || mu.state !== "ok") return { read: mu ? mu.state : "loading" };
    var d = mu.data, clubs = {}, byePlayers = [];
    S.model.teams.forEach(function (t) { t.players.forEach(function (p) { byePlayers.push({ club: p.nflTeam, bye: p.bye }); }); });
    ids.forEach(function (id) { var p = S.model.byId[id]; clubs[id] = p ? p.nflTeam : ""; });
    // PR B: the last week in which EVERY game is final, judged per game (lib/complete.js); the Worker's latestFinalWeek is never used.
    var C0 = completion(S);
    if (C0.state !== "ok") return { read: "completion", completion: C0, mu: d };
    // R6: W* = that week, held back to the history's week when the history is one week behind (clubhist.seasonCutoff). Every figure, both ranks and the
    // eligibility counts (n, S and U) run through W*; a newer final week is outside the settled summary.
    var SC = CH.seasonCutoff(C0.week, d.hist), Lall = C0.week, L = SC.week, scores = {}, weeks = [], loading = false, failed = false, allWeeks = true;
    for (var aw = 1; aw <= L; aw++) {
      weeks.push(aw);
      var ra = scoresOf(S)[aw];
      if (!ra || ra.state === "loading") { allWeeks = false; loading = true; } else if (ra.state !== "ok") { allWeeks = false; failed = true; } else if (staleScores(S, aw)) { allWeeks = false; loading = true; }
    }
    Object.keys(scoresOf(S)).forEach(function (w) { var r = scoresOf(S)[w]; if (r && r.state === "ok") scores[w] = r.data.scores; });
    var through = d.hist && typeof d.hist.teamHistoryThrough === "number" ? d.hist.teamHistoryThrough : null;
    // A week after W* that is over (it is before the lineup week, or W* was held back below an all-final week) is complete: its scores are outside the figures.
    var newerFinal = { complete: !!(L && cur && (L < cur || L < Lall)), clubs: {} };
    Object.keys(d.games || {}).forEach(function (c) { newerFinal.clubs[c] = d.games[c].status === "final"; });
    // Season totals are summed from the weekly reads Weeks 1..W* (MFL's own scores). If any of those weeks is missing or failed they are withheld together.
    var season = null;
    if (allWeeks) {
      season = {};
      var wm = {}; for (var sw = 1; sw <= L; sw++) wm[sw] = scoresOf(S)[sw].data.scores;
      var sf = K.seasonFrom(wm, L, function () { return "x"; });
      ids.forEach(function (id) { var tt = sf.totals[id]; if (tt && !sf.invalid[id]) season[id] = { total: tt.total / 100, games: tt.n }; });
    }
    var badMap = {};   // per player: how many recorded scores (Weeks 1..W*) are not readable (independent of the rank reads)
    if (allWeeks) for (var bw = 1; bw <= L; bw++) { var m1 = scoresOf(S)[bw].data.scores; ids.forEach(function (bid) { if (Object.prototype.hasOwnProperty.call(m1, bid) && typeof m1[bid] === "string") badMap[bid] = (badMap[bid] || 0) + 1; }); }
    return { read: "ok", bad: badMap, mu: d, weeks: weeks, loading: loading, failed: failed, completion: C0, cutoff: SC,
      input: { through: through, latestFinal: L, allFinal: Lall, hist: d.hist, clubs: clubs, byeOf: CH.clubByeMap(byePlayers), season: season, scores: scores, ids: ids, newerFinal: newerFinal } };
  }
  // PR B: the Worker's per-team game statuses for the lineup week, by club (upper case).
  function statusMap(d) { var m = {}; Object.keys(d.games || {}).forEach(function (c) { m[c.toUpperCase()] = d.games[c].status; }); return m; }
  // Scores of a week read BEFORE the schedule read that shows it final may have been read mid-game: they are not used for a "completed games" figure.
  function staleScores(S, w) {
    var s = scoresOf(S)[w], sc = S.intel && S.intel.sched && S.intel.sched[w];
    return !!(s && s.state === "ok" && sc && sc.state === "ok" && s.at != null && sc.at != null && s.at < sc.at);
  }
  // The clubs a week's schedule must account for (every one plays or is on its bye) and their byes. MFL's own list (nflByeWeeks: all 32 clubs, the whole season) when it
  // has been read; only if that read failed, the clubs and byes of the league's rostered players (weaker: a club nobody has rostered is not checked), and then the
  // verification below says it could not be confirmed.
  function coverFor(S, w) {
    var cal = S.intel && S.intel.cal;
    if (cal && cal.state === "ok") return { clubs: cal.data.clubs, byeOf: cal.data.byeOf, week: w, authoritative: true };
    var clubs = {}, byePlayers = [];
    S.model.teams.forEach(function (t) { t.players.forEach(function (p) { var c = String(p.nflTeam || "").trim().toUpperCase(); if (c && c !== "FA") clubs[c] = true; byePlayers.push({ club: p.nflTeam, bye: p.bye }); }); });
    var list = Object.keys(clubs);
    return list.length ? { clubs: list, byeOf: CH.clubByeMap(byePlayers), week: w, authoritative: false } : null;
  }
  // Is every week from 1 to N-1 complete by the schedule (week N is the cutoff's own check)? "ok" | "checking" | "unverified" (the calendar was not read) | "problems".
  function verification(S, N) {
    var cal = S.intel && S.intel.cal;
    if (cal && cal.state === "loading") return { state: "checking" };
    if (!cal || cal.state !== "ok") return { state: "unverified" };
    var problems = X.verifyWeeks(cal.data, N - 1);
    return problems.length ? { state: "problems", problems: problems } : { state: "ok" };
  }
  function verifyNote(vr, N) {
    if (vr.state === "ok" || vr.state === "checking") return "";
    var lines = [];
    if (vr.state === "unverified") lines.push("Game completion unverified: the NFL club list and the schedule of earlier weeks could not be read, so weeks 1 to " + (N - 1) + " were not checked against them. Figures include everything MFL has recorded. " + '<button class="link" data-act="retryperf">Try again</button>');
    else {
      vr.problems.slice(0, 3).forEach(function (p) {
        lines.push(p.state === "not_final" ? "Week " + p.week + " has a game that is not final (" + esc(p.clubs[0]) + " and " + esc(p.clubs[1]) + "). Figures include what MFL has recorded and may change when it is played."
          : p.state === "unavailable" ? "Week " + p.week + "'s NFL schedule could not be read, so that week is not confirmed complete."
          : "Week " + p.week + "'s NFL schedule does not account for every club, so that week is not confirmed complete.");
      });
      if (vr.problems.length > 3) lines.push(plural(vr.problems.length - 3, "more week is", "more weeks are") + " not confirmed complete.");
    }
    return '<div class="ex wn">' + lines.join('</div><div class="ex wn">') + "</div>";
  }
  // The last all-final week: { state: "loading" | "error" | "none" | "unavailable" | "conflict" | "ok", week }. Needs the Worker's lastCompleteWeek and the schedule of that week
  // (and the one before it if that week is not complete by the schedule).
  function completion(S) {
    var cur = S.model.week, mu = S.intel && S.intel.mu && S.intel.mu[cur];
    if (!mu || mu.state === "loading") return { state: "loading" };
    if (mu.state !== "ok") return { state: "error" };
    var d = mu.data, lc = d.lastComplete;
    if (lc == null) return { state: "unavailable" };
    if (!(lc >= 1)) return { state: "none" };
    var cal0 = S.intel && S.intel.cal; if (cal0 && cal0.state === "loading") return { state: "loading" };   // the authoritative club list and byes decide coverage: wait for them
    var sch = {}, sched = (S.intel && S.intel.sched) || {};
    [lc, lc - 1].forEach(function (x) {
      if (x < 1) return;
      var rec = sched[x];
      if (rec && rec.state === "ok") sch[x] = rec.data.games; else if (rec && rec.state === "error") sch[x] = null;
    });
    var r = X.cutoffWeek(lc, sch, statusMap(d), cur, coverFor(S, cur));
    if (r.state === "ok") return { state: "ok", week: r.week };
    if (r.state === "unavailable") return sch[r.need] === null ? { state: "error" } : { state: "loading", need: r.need };   // `need`: the schedule that must still be read
    return { state: r.state, why: r.why || null, week: r.week || null };
  }

  // ---- PR B: league-wide ranks. Season totals come from the weekly reads Weeks 1..W*; positions from the players read; per-game eligibility from the team-history
  // evaluation of EVERY scorer (so each competitor's eligibility is settled, or counted as unsettled, by the same rule). Memoized on the reads' identity.
  var RANK_MEMO = null;
  var RANK_GROUPS = { QB: 1, RB: 1, WR: 1, TE: 1, PK: 1, PN: 1, DL: 1, LB: 1, DB: 1 };
  function posLabel(g) { return g === "PK" ? "K" : g === "PN" ? "P" : g; }
  function rankData(S, ctx) {
    var pl = S.intel && S.intel.players;
    if (!pl || pl.state === "loading") return { state: "loading" };
    if (pl.state !== "ok") return { state: "error" };
    if (ctx.failed) return { state: "weeks" };
    if (ctx.loading || !ctx.input.season) return { state: "loading" };
    // R6: robust to a caller that passes the all-final week with a history one week behind (the confirmed defect): the week every count uses is re-derived
    // here, so the scored games n, the supported games S and the bound U always share ONE base (W*). Idempotent for perfInput's own input.
    var L0 = ctx.input.latestFinal, SC = CH.seasonCutoff(L0, ctx.input.hist), L = SC.week != null ? SC.week : L0, nScores = "";
    for (var sw0 = 1; sw0 <= L; sw0++) { var r0 = scoresOf(S)[sw0]; if (!r0 || r0.state !== "ok") return { state: "loading" }; nScores += (r0.at != null ? r0.at : "-") + ","; }   // the memo key includes when each week was read
    if (RANK_MEMO && RANK_MEMO.d === ctx.mu && RANK_MEMO.pl === pl.data && RANK_MEMO.L === L && RANK_MEMO.n === nScores) return RANK_MEMO.v;
    var wm = {}, w, byId = pl.data.byId;
    for (w = 1; w <= L; w++) wm[w] = scoresOf(S)[w].data.scores;
    // A position is used only when it is reliable: the players read names a rank group AND, for a rostered player, the roster says the same group. If the two
    // disagree (or the players read does not have him), he is unplaced: he could be in any group, so he widens every group's ranks and gets no rank himself.
    function groupOf(id) {
      var p = byId[id]; if (!p) return "";
      var g = F.posGroup(p.pos); if (!RANK_GROUPS[g]) return "";
      var mp = S.model && S.model.byId && S.model.byId[id];
      if (mp && mp.pos && F.posGroup(mp.pos) !== g) return "";
      return posLabel(g);
    }
    var sf = K.seasonFrom(wm, L, groupOf), ids = Object.keys(sf.totals), clubs = {}, season = {};
    ids.forEach(function (id) { clubs[id] = byId[id] ? byId[id].club : ""; if (!sf.invalid[id]) season[id] = { total: sf.totals[id].total / 100, games: sf.totals[id].n }; });
    var inp = {}, k; for (k in ctx.input) if (Object.prototype.hasOwnProperty.call(ctx.input, k)) inp[k] = ctx.input[k];
    inp.ids = ids; inp.clubs = clubs; inp.season = season; inp.scores = wm; inp.latestFinal = L;
    if (L < L0) inp.newerFinal = { complete: true, clubs: {} };   // the weeks after W* are all-final weeks
    // R11 (Keith, revised closeout 2026-11-23): missing or lagging team history never blanks every PPG rank. Three modes, by what the history covers:
    //   full  (history through W*): per-game eligibility from the history, as before;
    //   lag   (history through T < W*): a player the history shows with NO club change ("nochange") is judged on his current club's schedule through W*
    //         (provisional); a player with a known change (or a missing or conflicting record) is unresolved ON HIS OWN, since his known clubs are never replaced
    //         by the current one, and the history is evaluated through T only;
    //   none  (no history at all): every player is judged on his current club's schedule through W* (provisional).
    // A fallback player whose evidence contradicts the schedule (a score in his current club's bye week, more scores than his club has played, no current club,
    // no known bye) is unresolved on his own too. Points, PPG and every other rank stay visible for every player.
    var hmode = SC.reason === "complete" ? "full" : SC.reason === "history_behind" ? "lag" : "none", hT = hmode === "lag" ? SC.historyThrough : L;
    if (hmode === "lag") {
      var sfT = K.seasonFrom(wm, hT, groupOf), seasonT = {};
      Object.keys(sfT.totals).forEach(function (id) { if (!sfT.invalid[id]) seasonT[id] = { total: sfT.totals[id].total / 100, games: sfT.totals[id].n }; });
      inp.season = seasonT; inp.latestFinal = hT; inp.newerFinal = { complete: true, clubs: {} };
    }
    var ev = CH.evaluate(inp), byeOf = ctx.input.byeOf, entries = [], elig = {};
    var cal = S.intel && S.intel.cal, byeAll = cal && cal.state === "ok" && cal.data && cal.data.byeOf ? cal.data.byeOf : byeOf;
    var fb = { mode: hmode, through: hmode === "full" ? L : hmode === "lag" ? hT : null, scorers: 0, fallback: 0, unresolved: 0, reasons: {} };
    function unresolved(key, why) { fb.unresolved++; fb.reasons[key] = (fb.reasons[key] || 0) + 1; return { status: "unsettled", need: null, why: why, local: key }; }
    function fallbackElig(id, n) {   // his CURRENT club's calendar through W*: every week is a game except his bye
      var cur = String(clubs[id] || "").trim().toUpperCase();
      if (!cur || cur === "FA") return unresolved("no_club", "No current NFL club on file");
      var b = Object.prototype.hasOwnProperty.call(byeAll || {}, cur) ? byeAll[cur] : null;
      if (!(typeof b === "number" && b >= 1 && b <= 18)) return unresolved("no_bye", "His club’s bye week is not known");
      if (b <= L && wm[b] && Object.prototype.hasOwnProperty.call(wm[b], id) && K.toCents(wm[b][id]) != null) return unresolved("bye_score", "A score is recorded in his current club’s bye week, so his club may have changed");
      var games = L - (b <= L ? 1 : 0);
      if (n > games) return unresolved("more_scores", "More scored games than his current club has played");
      fb.fallback++;
      var fe = K.eligibility(n, games, games, "ok"); fe.provisional = true; return fe;
    }
    ids.forEach(function (id) {
      var g = groupOf(id), n = sf.totals[id].n, row = ev.rows[id], e;
      fb.scorers++;
      if (!row || sf.invalid[id]) e = K.eligibility(n, null, null, "missing");
      else if (hmode === "none" || (hmode === "lag" && (row.cls === "nochange" || row.cls === "none"))) e = fallbackElig(id, n);
      else if (row.elig.hist !== "ok") e = hmode === "lag" ? unresolved("lag_" + row.elig.hist, row.elig.hist === "conflict" ? "Team history conflict" : "Team history incomplete") : K.eligibility(n, null, null, row.elig.hist);
      else if (hmode === "lag") e = unresolved("lag_changed", "His club changed this season and team history runs only through Week " + hT);
      else {
        var Sg = row.elig.games, cur = String(clubs[id] || "").trim().toUpperCase(), U = Sg;
        row.elig.unknownWeeks.forEach(function (u) {   // an unknown week is a possible game unless EVERY club he could have been with (the history's candidates and his current club) had its bye
          var cs = u.clubs.slice(); if (cur) cs.push(cur);
          var possible = !cs.length || cs.some(function (c) { var b = byeOf[c]; return !(typeof b === "number" && b === u.week); });
          if (possible) U++;
        });
        e = K.eligibility(n, Sg, U, "ok");
      }
      elig[id] = e;
      // R11: a player left unresolved by the fallback (e.local) is handled on his own: no rank for him, and he neither takes a place from anyone nor widens
      // anyone else's rank into a range ("Unresolved cases do not contaminate otherwise supported players"). Status "local" matches no branch in K.perGameRank.
      if (g) entries.push({ id: id, group: g, total: sf.totals[id].total, n: n, status: e.local ? "local" : e.status, usable: !sf.invalid[id] });
    });
    var seasonEntries = sf.entries.map(function (x) { return { id: x.id, group: x.group, value: x.value }; });
    // competitors who cannot be placed (no position group, not in the players read) or whose scores are not all readable: they widen the per-game bounds too
    var unplacedGame = sf.unplaced.map(function (u) { var tt = sf.totals[u.id]; return { id: u.id, group: u.group || "", total: tt ? tt.total : 0, n: tt ? tt.n : 0, usable: u.value != null }; });
    var bad = {}; // scores that are recorded but not readable numbers, per player
    for (w = 1; w <= L; w++) { var m0 = wm[w]; for (var bid in m0) if (Object.prototype.hasOwnProperty.call(m0, bid) && K.toCents(m0[bid]) == null) bad[bid] = (bad[bid] || 0) + 1; }
    // The weekly position rank (for the game log): the player's rank among every scorer in his position group that week, from the same weekly read. Shown only
    // when EXACT. "" when the player has no reliable position group, no readable score that week, or the rank is not exact. Weeks 1..W* only.
    var weekly = {};
    function weekRank(week, id) {
      if (!(week >= 1 && week <= L)) return "";
      var m = weekly[week] || (weekly[week] = K.weekFrom(wm[week] || {}, groupOf)), r = K.totalRank(m.entries, id, m.unplaced);
      return r && r.exact ? r.group + r.best : "";   // R7 (decision 3): "WR3", exact only; no pool count
    }
    var v = { state: "ok", cutoff: L, sf: sf, ev: ev, entries: entries, elig: elig, seasonEntries: seasonEntries, groupOf: groupOf, unplacedGame: unplacedGame, bad: bad, weekRank: weekRank, fb: fb };
    RANK_MEMO = { d: ctx.mu, pl: pl.data, L: L, n: nScores, v: v };
    return v;
  }
  // R7 (decision 4): the Breakdown's rank line reads like the card ("WR1", "WR63–66"); the group size appears only in the expanded reasoning of a RANGE
  // (why it is a range, and how large the group could be). [label, rank text, reasoning or ""].
  function rng(a, b) { return a === b ? String(a) : a + "–" + b; }
  function rankLine(label, r, kind) {
    var c = K.compactRank(r);
    if (r.exact) return [label, c, ""];
    var k = r.worst - r.best;
    var who = "can’t be placed yet (" + (kind === "ppg" ? "no position on file, or not yet known to have scored in enough team games" : "no position on file, or a score that could not be read") + ")";
    return [label, c, "A range: " + plural(k, "player", "players") + " who could rank ahead of him " + who + ". " + r.group + " group: " + rng(r.poolLo, r.poolHi) + " players."];
  }
  // Season points, per scored game, scored games and both ranks for one player. Never a figure from a partial set.
  // seasonRank / gameRank: the compact card text ("QB2", "QB2–4", "—"); seasonRankLong / gameRankLong: with the pool ("QB 3 of 73"), kept for analysis
  // scripts only (no screen shows a pool count). detail: the Breakdown's rank lines (rankLine above).
  // `histOff`: team history is not available for the whole screen, so the per-game rank is "—" for everyone and that one fact is said once at the top.
  function statFigures(S, id, RD, histOff) {
    var o = { total: null, ppg: null, n: null, bad: 0, noPos: false, seasonRank: DASH, gameRank: DASH, seasonRankLong: "", gameRankLong: "", gameWhy: "", detail: [], range: false };
    if (!RD || RD.state !== "ok") return o;
    var t = RD.sf.totals[id];
    o.bad = (RD.bad && RD.bad[id]) || 0;
    o.noPos = !RD.groupOf(id);
    if (!t || RD.sf.invalid[id]) return o;
    o.total = t.total / 100; o.n = t.n; o.ppg = t.total / 100 / t.n;
    var sr = K.totalRank(RD.seasonEntries, id, RD.sf.unplaced);
    if (sr) { o.seasonRank = K.compactRank(sr); o.seasonRankLong = K.rankText(sr); o.detail.push(rankLine("Tot. Pts. rank", sr, "tot")); if (!sr.exact) o.range = true; }
    var pg = K.perGameRank(RD.entries, id, RD.unplacedGame), e = RD.elig[id];
    if (pg) {
      o.gameRank = K.compactRank(pg); o.gameRankLong = K.rankText(pg); o.detail.push(rankLine("PPG rank", pg, "ppg")); if (!pg.exact) o.range = true;
      if (e && e.provisional) o.detail.push(["PPG rank basis", "Provisional", "Counted against his current NFL club’s games, because his team history is not available. See Help."]);   // inside the opened Breakdown only; said once in Help
    }
    else if (e) {
      var why = histOff && /^Team history/.test(e.why || "") ? "" : e.why;   // a reason about this player goes to his Breakdown; "no team history" is said once, at the top
      o.gameWhy = why; if (why) o.detail.push(["PPG rank", DASH, "Not shown: " + why + "."]);
    }
    return o;
  }
  // The Live / Final · updating chip for one player in the lineup week (lib/complete.js decides). "" when there is nothing to say. Judged against the last
  // all-final week (not W*): it is about the lineup week's game, not the settled summary.
  function liveChip(S, p, ctx) {
    var cur = S.model.week, N = ctx.input.allFinal != null ? ctx.input.allFinal : ctx.input.latestFinal;
    if (!(cur > N)) return { html: "", retry: false };
    var sch = S.intel.sched && S.intel.sched[cur], sc = scoresOf(S)[cur], d = ctx.mu, club = String(p.nflTeam || "").toUpperCase();
    if (!sch || sch.state !== "ok") return { html: "", retry: false };
    var games = sch.data.games, st = statusMap(d), g = X.gameOf(games, club), gs = X.gameState(g, g ? (st[club] === undefined ? "missing" : st[club]) : null);
    var score = sc && sc.state === "ok" && typeof sc.data.scores[p.id] === "number" ? sc.data.scores[p.id] : null;
    var all = X.weekComplete(games, st, coverFor(S, cur)), now = S.nowMs != null ? S.nowMs : Date.now();
    var h = X.handoff({ game: gs, score: score, cutoff: N, week: cur, weekAllFinal: all, read: sc && sc.state ? { state: sc.state, at: sc.at } : { state: "loading" }, tries: { startedAt: S.live && S.live.allFinalAt != null ? S.live.allFinalAt : null, now: now } });
    return { html: h.chip ? '<span class="live">' + esc(h.chip) + "</span>" : "", retry: !!(h.chip && h.retry) };
  }
  // The weeks to read for a strip ending at L (kept for callers): L-3..L, and from the history week when it is behind.
  function throughOf(d) { var h = d && d.hist; return h && typeof h.teamHistoryThrough === "number" && h.teamHistoryThrough >= 1 ? h.teamHistoryThrough : null; }
  function weeksFor(L, through) {
    var from = L - 3; if (through != null && through <= L) from = Math.min(from, through - 3);
    var w = []; for (var i = Math.max(1, from); i <= L; i++) w.push(i); return w;
  }

  function scoresOf(S) { return (S.intel && S.intel.scores) || {}; }

  // ---- the hard gates (sections 11 and 12) ----
  // Model figures: until Keith approves activation, both slots are the literal "Not Available" in every view, summary and export. This function reads NOTHING
  // (no state, no player field, no file): there is no code path by which a modeled value can reach the screen. A test enforces it.
  function modelSlots() { return { ppg: null, overExpectations: null, text: NOT_AVAILABLE }; }
  // R7 (decision 5): the secondary projection, labeled with the lineup week ("Week 11 Proj. 14.2"). Source: the stored-projection read (#1515,
  // GET /api/player-projections, loaded by D.projections(season, week, ids) in lib/data.js) kept by the page as
  //   S.intel.proj[week] = { state: "ok" | "loading" | "error" | "absent", data: { ok, season, week, provider, projections: { id: {...} | null } }, at }
  // The value is chosen ONLY by X.pregameProjection: the latest capture strictly before HIS game's kickoff (frozen at kickoff); a capture at or after
  // kickoff, no kickoff, a bye, an answer for another season or week, a failed or missing read, or no row: "Not Available" (never 0, never a guess).
  // Both stored captures are offered to the rule: the latest (captured_at) and the first (first_captured_at with first_projected), so a player whose
  // latest capture landed after kickoff (the pre-2026-10-27 writer) still gets his last pregame value if the first one was before kickoff.
  // The kickoff is his CURRENT club's game in the lineup week, from the whole-season schedule the page already reads (S.intel.cal.data.days).
  var PROJ_WHY = { no_read: "No projection read for this week", loading: "Loading", failed: "The projection read failed", absent: "Not in this recording",
    other_week: "The answer was for another week", no_row: "No projection captured for him", no_kickoff: "His game’s kickoff is not known",
    bye: "His club has a bye", after_kickoff: "Only captures after his kickoff (never used as a pregame projection)", no_capture: "No readable capture" };
  function kickoffOf(S, week, club) {
    var cal = S.intel && S.intel.cal, days = cal && cal.state === "ok" && cal.data ? cal.data.days : null, list = days && Array.isArray(days[week]) ? days[week] : null;
    var c = String(club || "").trim().toUpperCase(), hit = [], byeOf = cal && cal.state === "ok" && cal.data ? cal.data.byeOf : null;
    if (!c || c === "FA") return { ko: null, why: "no_kickoff" };
    if (!list) {   // R11: the Lineup view does not read the whole-season calendar; his club's game in the lineup week, from the matchups read it already has (Unix seconds)
      var mu = S.intel && S.intel.mu && S.intel.mu[week], g = mu && mu.state === "ok" && mu.data && mu.data.games ? mu.data.games[c] : null, k0 = g ? Number(g.kickoff) : NaN;
      return isFinite(k0) && k0 > 0 ? { ko: k0, why: "" } : { ko: null, why: "no_kickoff" };
    }
    list.forEach(function (m) { var t = m && Array.isArray(m.teams) ? m.teams : []; if (t.length === 2 && (String(t[0].id || "").toUpperCase() === c || String(t[1].id || "").toUpperCase() === c)) hit.push(m); });
    if (hit.length === 1) { var ko = Number(hit[0].kickoff); return isFinite(ko) && ko > 0 ? { ko: ko, why: "" } : { ko: null, why: "no_kickoff" }; }
    if (!hit.length && byeOf && byeOf[c] === week) return { ko: null, why: "bye" };
    return { ko: null, why: "no_kickoff" };   // not listed, or listed twice: not trusted
  }
  function projectionSlot(S, p) {
    var wk = S.model && S.model.week, season = S.model && Number(S.model.season), label = (wk ? "Week " + wk + " " : "") + "Proj.";
    var none = function (why) { return { label: label, value: null, text: NOT_AVAILABLE, why: why, provider: null, capturedAt: null, kickoff: null }; };
    var rec = S.intel && S.intel.proj && wk ? S.intel.proj[wk] : null;
    if (!rec) return none("no_read");
    if (rec.state === "loading") return none("loading");
    if (rec.state === "absent") return none("absent");
    if (rec.state !== "ok" || !rec.data || rec.data.ok !== true || !rec.data.projections || typeof rec.data.projections !== "object") return none("failed");
    if (Number(rec.data.week) !== Number(wk) || (season && Number(rec.data.season) !== season)) return none("other_week");
    var k = kickoffOf(S, wk, p.nflTeam);
    if (k.why === "bye") return none("bye");   // a bye explains the missing row; said before "no row"
    var row = Object.prototype.hasOwnProperty.call(rec.data.projections, p.id) ? rec.data.projections[p.id] : null;
    if (!row || typeof row !== "object") return none("no_row");
    if (k.ko == null) return none(k.why);
    var pick = X.pregameProjection([{ projected_score: row.projected_score, captured_at: row.captured_at }, { projected_score: row.first_projected, captured_at: row.first_captured_at }], k.ko);
    if (pick.state !== "ok") return none(pick.why);
    return { label: label, value: pick.value, text: f1(pick.value), why: "", provider: "MFL", capturedAt: pick.capturedAt, kickoff: k.ko * 1000 };
  }
  // What the page must ask for (for app.js: D.projections(season, week, ids)): the lineup week and this team's player ids. null before the roster read.
  function projectionRequest(S) {
    var t = S.model && teamOf(S);
    if (!t || !S.model.week) return null;
    return { season: Number(S.model.season), week: S.model.week, ids: t.players.map(function (p) { return String(p.id); }) };
  }
  // R8: the Breakdown no longer repeats the projection. The card shows only "Week 11 Proj. 4.6"; the capture time and kickoff stay in the slot
  // (capturedAt, kickoff: the pregame rule's evidence) and a Not Available slot keeps its reason code (why); the provider is named in Help.
  // projectionReason: the plain reason for a Not Available slot ("" otherwise), for tests and any later Details line.
  function projectionReason(g) { return g && g.value == null && PROJ_WHY[g.why] ? PROJ_WHY[g.why] : ""; }

  // One player's main-card figures (also what the Breakdown reads, so the two never disagree): { total, n, ppg, totRank, ppgRank, why, nbad, noPos, model, proj }.
  function figs(S, p, ctx) {
    var f = statFigures(S, p.id, ctx.rank, !!ctx.histOff), se = ctx.input.season && ctx.input.season[p.id];
    var total = f.total != null ? f.total : se ? se.total : null, n = f.n != null ? f.n : se ? se.games : null, ppg = f.ppg != null ? f.ppg : (se && se.games > 0 ? se.total / se.games : null);
    var loadingRanks = ctx.rank && ctx.rank.state === "loading", ranksOk = ctx.rank && ctx.rank.state === "ok";
    var tr = loadingRanks ? "…" : ranksOk ? f.seasonRank : DASH, gr = loadingRanks ? "…" : ranksOk ? f.gameRank : DASH;
    var nbad = (ctx.bad && ctx.bad[p.id]) || f.bad, why = f.gameWhy;
    if (nbad) { total = null; ppg = null; tr = DASH; gr = DASH; why = "A recorded score could not be read"; }
    else if (f.noPos && f.total != null) { tr = DASH; gr = DASH; why = "Position not confirmed"; }
    return { f: f, total: total, n: n, ppg: ppg, totRank: tr, ppgRank: gr, why: why, nbad: nbad, noPos: f.noPos, model: modelSlots(), proj: projectionSlot(S, p) };
  }
  function metric(label, value, rank, cls) {
    return '<div class="' + cls + '"><span>' + esc(label) + "</span><b>" + value + "</b>" + (rank == null ? "" : '<em aria-label="' + esc(label) + " rank " + esc(rank === DASH ? "not available" : rank) + '">' + esc(rank) + "</em>") + "</div>";
  }
  // The main card's Breakdown, opened in place (lib/breakdown.js: Season stats | Game log) WITHOUT its summary line. R8: nothing the card already
  // shows is repeated: no Tot. Pts. or exact rank, no projection. A rank line is kept only when it needs explaining (a range, or why it is not
  // shown), drawn under Season stats. Same cutoff W* as the card (the Breakdown reads seasonCutoff).
  function breakdown(S, id, ctx) {
    ctx = ctx || perfCtx(S, [id]);
    var p = S.model && S.model.byId[id];
    var f = ctx && ctx.read === "ok" ? statFigures(S, id, ctx.rank, !!ctx.histOff) : null;
    var lines = (f ? f.detail : []).filter(function (d) { return !!d[2]; });   // an exact rank is already on the card; a range or a withheld rank says why
    return '<div class="det pfbd">' + (p ? gameLog(S, p, { summary: false, rankLines: lines }) : "") + "</div>";
  }
  function perfRow(S, p, ctx) {
    var open = !!pfState(S).open[p.id], nm = esc(p.name), g = figs(S, p, ctx), lc = liveChip(S, p, ctx);
    var meta = [esc(F.commonCode(p.nflTeam) || "No NFL team")];
    if (g.n != null) meta.push(plural(g.n, "scored game", "scored games"));
    var h = '<div class="rw pfc"><button class="nmb" data-act="card" data-pid="' + esc(p.id) + '" aria-label="Open ' + nm + ' profile"><span class="l1">' + nm + " " + pcx(p.pos) + "</span></button>" +
      '<div class="pfm">' + meta.join(" · ") + (startingTag(p) + injuryChip(S, p) + lc.html ? ' <span class="fl">' + startingTag(p) + injuryChip(S, p) + lc.html + "</span>" : "") + "</div>" +
      '<div class="pf1">' + metric("Tot. Pts.", f1(g.total), g.totRank, "pfv") + metric("PPG", f1(g.ppg), g.ppgRank, "pfv") + "</div>" +
      '<div class="pf2">' + metric("xFP PPG", '<span class="na">' + esc(g.model.text) + "</span>", null, "pfv") + metric("Over Expectations", '<span class="na">' + esc(g.model.text) + "</span>", null, "pfv") + "</div>" +
      '<div class="pf3"><span class="pfp">' + esc(g.proj.label) + ' <b' + (g.proj.value == null ? ' class="na"' : "") + ">" + esc(g.proj.text) + "</b></span>" +
      '<button class="link pfb" data-act="pfx" data-v="' + esc(p.id) + '" aria-expanded="' + open + '" aria-label="' + (open ? "Hide" : "Show") + " breakdown for " + nm + '">Breakdown ' + (open ? "▾" : "▸") + "</button></div>" +
      (g.nbad ? '<div class="ex wn">' + plural(g.nbad, "score", "scores") + " could not be read, so his season figures are not shown.</div>" : "") +
      (lc.retry ? '<div class="ex"><button class="link" data-act="retryperf">Retry</button></div>' : "");
    if (open) h += API.breakdown(S, p.id, ctx);
    return h + "</div>";
  }

  // perfInput plus the history evaluation and the ranks: what the card and the Breakdown both read (one cutoff, one set of figures).
  function perfCtx(S, ids) {
    var ctx = perfInput(S, ids);
    if (ctx.read !== "ok" || !ctx.input.latestFinal) return ctx;
    ctx.ev = CH.evaluate(ctx.input);
    ctx.histOff = false;   // R11: missing or lagging team history no longer blanks the PPG rank for everyone (rankData settles each player); each player's own reason is shown
    ctx.rank = rankData(S, ctx);
    return ctx;
  }
  function performanceBody(S) {
    var t = teamOf(S), c = pfStateFor(S, t), out = "";
    var ids = t.players.map(function (p) { return p.id; }), ctx = perfCtx(S, ids);
    if (ctx.read === "loading") return '<div class="card rows" aria-busy="true">' + skeleton(6) + '</div><div class="mu ctr sm">Loading scores…</div>';
    if (ctx.read === "completion") {
      var cs0 = ctx.completion.state;
      if (cs0 === "loading") return '<div class="card rows" aria-busy="true">' + skeleton(6) + '</div><div class="mu ctr sm">Checking which games are final…</div>';
      if (cs0 === "none") return '<div class="card"><h2>Performance</h2><div class="ex">No week has been completed yet, so there are no scores to show.</div></div>';
      if (cs0 === "conflict" && ctx.completion.why) return '<div class="card"><h2>Performance</h2><div class="ex wn">The NFL schedule for Week ' + esc(ctx.completion.week) + ' does not account for every club (games are missing from it), so it cannot be treated as a complete week, and no season figure is shown.</div></div>' + failCard("retryperf");
      return failCard("retryperf"); // no way to say which week is complete: nothing is drawn from the season, nothing is guessed
    }
    if (ctx.read !== "ok") return failCard("retryperf");
    if (!ctx.input.latestFinal) return '<div class="card"><h2>Performance</h2><div class="ex">No week has been completed yet, so there are no scores to show.</div></div>';
    var ev = ctx.ev;
    // ONE compact header: "Through Week N" once, then only real issues (an unverified week, an unavailable history reason, a failed read).
    var W = ctx.input.latestFinal, vr = verification(S, W), hl = histLine(ev), SC = ctx.cutoff || {};
    // R7 (decision 2): history two or more weeks behind holds EVERY figure at its week; that is a real feed issue, said once. One week behind is the
    // expected refresh lag (Help explains it), so it gets no line.
    var lag = "";   // R11: no history notice at any gap; every figure runs through the last all-final week and Help explains how eligibility is settled
    var warn = !!(hl && hl.warn) || !!lag || vr.state === "unverified" || vr.state === "problems" || ctx.failed;
    out += '<div class="card pfh' + (warn ? " warnc" : "") + '"><b>Through Week ' + W + "</b>" + verifyNote(vr, W) +
      (hl ? '<div class="ex' + (hl.warn ? " wn" : "") + '">' + esc(hl.text) + "</div>" : "") + (lag ? '<div class="ex wn">' + esc(lag) + "</div>" : "") +
      (ctx.failed ? '<div class="ex wn mt4">Some weeks of scores could not be read. <button class="link" data-act="retryperf">Try again</button></div>' : ctx.loading ? '<div class="ex mt4">Loading the latest weeks…</div>' : "") + "</div>";

    // R8: "Search players" narrows THIS team's list by name (no network, no free agents); the sort and grouping apply to what matches.
    // R9: the position filter sits under the search; other teams are searched only on the owner's explicit "Search other teams".
    // R10: All + the positions on THIS team; a filter reset by a team switch is said once (S.pf.note, set and cleared by app.js)
    var note = S.pf && S.pf.note ? '<div class="ex" role="status">' + esc(S.pf.note) + "</div>" : "";
    out += pfSearchBox(S) + '<div class="lbl">Position</div><div class="chs pfpos" role="group" aria-label="Position">' + posChips("pfpos", [["all", "All"]].concat(posOf(t.players)), c.pos) + "</div>" + note +
      '<div class="lbl">Sort</div><div class="chs" role="group" aria-label="Sort">' + PF_SORTS.map(function (o) { return '<button class="ch" data-act="pfs" data-v="' + o[0] + '" aria-pressed="' + (c.s === o[0]) + '">' + o[1] + "</button>"; }).join("") + "</div>";
    return out + '<div id="pflist" class="pflist">' + perfList(S, t, c, ctx) + "</div>";
  }
  // The search box. Its value is drawn back from S.pf.q (escaped); app.js keeps focus and the cursor across redraws.
  function pfSearchBox(S) {
    var q = pfQuery(S);
    return '<div class="pfs"><label class="lbl" for="pfq">Search players</label><input id="pfq" class="pfq" type="search" data-inp="pfq" value="' + esc(q) + '" placeholder="Player name" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="search" maxlength="40" aria-controls="pflist"></div>';
  }
  function pfQuery(S) { var q = S.pf && typeof S.pf.q === "string" ? S.pf.q : ""; return q.slice(0, 40); }
  // Name matching: case- and accent-insensitive, every typed word must appear in the name ("ja ch" finds Ja'Marr Chase); punctuation is ignored.
  function foldName(s) {
    var x = String(s == null ? "" : s).toLowerCase();
    if (x.normalize) x = x.normalize("NFD").replace(/[̀-ͯ]/g, "");
    return x.replace(/[^a-z0-9 ]+/g, "");
  }
  function pfMatcher(q) {
    var words = foldName(q).split(/\s+/).filter(Boolean);
    if (!words.length) return null;
    return function (p) { var n = foldName(p.name); return words.every(function (w) { return n.indexOf(w) >= 0; }); };
  }
  // The list under the controls (also redrawn alone by app.js while the owner types). null when the screen is not in its list state.
  function performanceList(S) {
    var t = teamOf(S); if (!t) return null;
    var ctx = perfCtx(S, t.players.map(function (p) { return p.id; }));
    if (ctx.read !== "ok" || !ctx.input.latestFinal) return null;
    return perfList(S, t, pfStateFor(S, t), ctx);
  }
  // R9: the position filter, then the name search, over THIS team (pfPool); the other teams only through crossList, on request.
  function pfPool(players, c, match) {
    var base = c.pos === "all" ? players : players.filter(function (p) { return p.pos === c.pos; });
    return match ? base.filter(match) : base;
  }
  // R9: "Search other teams": the players on the league's OTHER teams, from the roster read already in memory (S.model.teams: every team's roster;
  // no read, no free agents, no route). Same name rule and position filter; each row names his UPS team and opens the same player profile.
  var XT_MAX = 25;
  function crossHits(S, t, c, match) {
    var hits = [];
    (S.model && S.model.teams || []).forEach(function (o) { if (o.id === t.id) return; pfPool(o.players, c, match).forEach(function (p) { hits.push({ p: p, team: o }); }); });
    return hits.sort(function (a, b) { return a.p.name.localeCompare(b.p.name) || a.team.name.localeCompare(b.team.name); });
  }
  // R10 (Keith: "Cross-team search must allow all relevant positions"): the other-teams list has its OWN position control (xpos), whose chips
  // are All + every position among the other teams' players matching the name. It starts at this team's filter (app.js, on the tap); when no
  // matching player has that position, every position is shown and a line says so (never an empty list for a position nobody there has).
  function crossList(S, t, c, match) {
    var any = crossHits(S, t, { pos: "all" }, match), present = posOf(any.map(function (h) { return h.p; }));
    var xp = c.xpos !== "all" && present.some(function (g) { return g[0] === c.xpos; }) ? c.xpos : "all";
    var hits = xp === "all" ? any : any.filter(function (h) { return h.p.pos === xp; }), scope = (xp === "all" ? "" : posWord(xp) + " · ") + "rostered players only";
    var out = '<div class="gh2 xth"><span>Other teams · ' + esc(scope) + '</span><span role="status">' + hits.length + "</span></div>";
    if (!any.length) return out + '<div class="card"><div class="ex">No rostered player on another team matches either. Free agents are not searched.</div></div>';
    if (c.xpos !== "all" && xp === "all") out += '<div class="ex" role="status">No ' + esc(posWord(c.xpos)) + " on another team has a name containing “" + esc(pfQuery(S).trim()) + "”, so every position is shown.</div>";
    out += '<div class="chs pfpos xtp" role="group" aria-label="Position, other teams">' + posChips("pfxpos", [["all", "All"]].concat(present), xp) + "</div>";
    out += '<div class="card rows">' + hits.slice(0, XT_MAX).map(function (h) {
      var p = h.p, nm = esc(p.name), res = p.status === "ir" ? " · IR" : p.status === "taxi" ? " · Taxi" : "";
      return '<div class="rw xtr"><button class="nmb" data-act="card" data-pid="' + esc(p.id) + '" data-x="1" aria-label="Open ' + nm + " profile, " + esc(h.team.name) + '"><span class="l1">' + nm + " " + pcx(p.pos) + "</span></button>" +
        '<div class="pfm">' + esc(F.commonCode(p.nflTeam) || "No NFL team") + esc(res) + ' · <b class="xtt">' + esc(h.team.name) + "</b></div></div>";
    }).join("") + "</div>";
    if (hits.length > XT_MAX) out += '<div class="ex">Showing ' + XT_MAX + " of " + hits.length + ". Type more of the name to narrow it.</div>";
    return out;
  }
  function perfList(S, t, c, ctx) {
    var out = "", q = pfQuery(S).trim(), match = pfMatcher(q), pool = pfPool(t.players, c, match);
    var act = pool.filter(function (p) { return p.status === "active"; });
    function rowOf(p) { return perfRow(S, p, ctx); }
    function val(p, key) { var g = figs(S, p, ctx), v = key === "tot" ? g.total : g.ppg; return v == null ? -1e9 : v; }
    var who = c.pos === "all" ? "player" : posWord(c.pos);
    if (match && !pool.length) {
      out = '<div class="card"><div class="big2"><b>No players match</b></div><div class="ex">No ' + esc(who) + " on " + esc(t.name) + " has a name containing “" + esc(q) + "”.</div>" +
        (c.xt ? "" : '<button class="btn xtb" data-act="pfxt" aria-controls="pflist">Search other teams</button>') + "</div>";
      return c.xt ? out + crossList(S, t, c, match) : out;
    }
    if (!pool.length) return '<div class="card"><div class="ex">No ' + esc(who) + " on " + esc(t.name) + ".</div></div>";
    if (match) out += '<div class="mu sm" role="status">' + plural(pool.length, "player matches", "players match") + "</div>";
    if (!act.length) { /* only reserve players match: their groups follow */ }
    else if (c.s === "pos") {
      GROUPS.forEach(function (g) {
        var grp = act.filter(function (p) { return p.pos === g[0]; });
        if (!grp.length) return;
        grp.sort(function (a, b) { return ((b.starter ? 1 : 0) - (a.starter ? 1 : 0)) || (val(b, "ppg") - val(a, "ppg")) || a.name.localeCompare(b.name); });
        out += '<div class="gh2"><span>' + esc(g[1]) + " · " + plural(grp.length, "player", "players") + "</span><span>" + grp.filter(function (p) { return p.starter; }).length + ' starting</span></div><div class="card rows">' + grp.map(rowOf).join("") + "</div>";
      });
    } else {
      act.sort(function (a, b) { return (val(b, c.s) - val(a, c.s)) || a.name.localeCompare(b.name); });
      out += '<div class="gh2"><span>' + (c.s === "tot" ? "Tot. Pts., highest first" : "PPG, highest first") + "</span><span>" + act.length + '</span></div><div class="card rows">' + act.map(rowOf).join("") + "</div>";
    }
    [["ir", "Injured reserve"], ["taxi", "Taxi squad"]].forEach(function (o) {
      var grp = pool.filter(function (p) { return p.status === o[0]; });
      if (!grp.length) return;
      // while searching, a matching reserve player is shown, not hidden in a closed group
      if (match) { out += '<div class="gh2"><span>' + esc(o[1]) + " · " + plural(grp.length, "player", "players") + '</span></div><div class="card rows">' + grp.map(rowOf).join("") + "</div>"; return; }
      var op = !!c.res[o[0]];
      out += '<button class="gh2 btnrow" data-act="pfres" data-v="' + o[0] + '" aria-expanded="' + op + '"><span>' + esc(o[1]) + " · " + plural(grp.length, "player", "players") + "</span><span>" + (op ? "▾" : "▸") + "</span></button>" + (op ? '<div class="card rows">' + grp.map(rowOf).join("") + "</div>" : "");
    });
    return out;
  }
  // The one line about team history, or null when it is available. "Not served yet" is not a data problem and says so plainly; any other reason is named,
  // once, here. It never says or implies that a player's own data is missing or wrong.
  var HIST_WHY = { malformed: "the answer was not in the expected form", past_season: "it is not for this season", context_failed: "it could not be built", no_history: "none is recorded", crosswalk_failed: "player records could not be matched", crosswalk_suspect: "player records did not match cleanly" };
  function histLine(ev) {
    // R11: no history line. Missing or lagging team history does not stop any figure or rank; how eligibility is settled without it is said once in Help.
    return null;
  }
  // The exports the Breakdown and the tests read (merged into this file's API below).
  var PERF_API = { seasonCutoff: seasonCutoff, statFigures: statFigures, projectionRequest: projectionRequest, kickoffOf: kickoffOf, perfCtx: perfCtx, perfFigures: function (S, id) { var p = S.model && S.model.byId[id], ctx = p ? perfCtx(S, [id]) : null; return ctx && ctx.read === "ok" && ctx.input.latestFinal ? figs(S, p, ctx) : null; }, modelSlots: modelSlots, projectionSlot: projectionSlot, projectionReason: projectionReason, breakdown: breakdown };

  // ============================== profile game log ==============================
  // R6: the game log is the Breakdown (lib/breakdown.js): the season stats, the weekly log in position-specific views and each game's detail.
  // breakdown.js is loaded after this file and depends on it, so it is found when the log is drawn (CommonJS in tests, the page's UPS2027 namespace otherwise).
  // The main card's Breakdown control (breakdown above) calls gameLog(S, p, { summary: false }).
  // The weeks the season needs (Week 1 to the cutoff): every one is a Performance read already, so the log adds no score read of its own.
  function logWeeks(L) { var w = []; for (var i = 1; i <= L; i++) w.push(i); return w; }
  function breakdownApi() {
    if (typeof require === "function") { try { return require("./breakdown.js"); } catch (e) { return null; } }
    return typeof UPS2027 !== "undefined" && UPS2027 && UPS2027.breakdown ? UPS2027.breakdown : null;
  }
  function gameLog(S, p, opts) {
    var BD = breakdownApi();
    return BD ? BD.panel(S, p, opts) : '<div class="ex">The breakdown is not available in this build.</div>';
  }

  function mixApi(a, b) { for (var key in b) if (Object.prototype.hasOwnProperty.call(b, key) && !Object.prototype.hasOwnProperty.call(a, key)) a[key] = b[key]; return a; }
  var API = mixApi({ rankData: rankData, completion: completion, contractsBody: contractsBody, performanceBody: performanceBody, performanceList: performanceList, pfMatcher: pfMatcher, pfPosOk: pfPosOk, PF_POS: PF_POS, crossHits: crossHits, pfTeamSwitch: pfTeamSwitch, posOf: posOf, gameLog: gameLog, screenHelp: screenHelp, failCard: failCard, capCard: capCard, ctNextSort: ctNextSort, cutCharge: cutCharge, cutWords: cutWords, guaranteeFacts: guaranteeFacts, contractFacts: contractFacts, contractFactsFor: contractFactsFor, historyHtml: historyHtml, nameParts: nameParts, byName: byName, termWords: termWords, perfInput: perfInput, weeksFor: weeksFor, logWeeks: logWeeks, throughOf: throughOf, kmoney: kmoney, coverFor: coverFor, verification: verification, staleScores: staleScores }, PERF_API);
  return API;
});
