/* UPS 2027 R3: the bodies of Team › Contracts and Team › Performance, and the profile's game log. Pure functions of the state object
   (no network, no storage, no DOM), drawn as HTML strings like views.js. Every piece of text that comes from a data source goes through esc().

   Rules this file keeps (owner rulings, 2026-11-21; scope record on #1475):
   - Contracts: labels and sorts follow the season the roster read reports (no year is written in this file); the salary columns are as many as
     the longest contract left; no points per game and no position rank anywhere; no link into Cap & picks. R6 (Keith, 2026-11-22/23): ONE cap card
     (Available cap space, Total cap, a closed Breakdown, the later years' Total committed cap); the separate recorded-salary card is gone.
   - The Remaining guarantee column holds ONLY guarantee values (Loading, an amount, $0 with "Fully earned" from a calculated zero, Not applicable,
     Under review, Unavailable). A cut charge is drawn only under "If cut now". A missing or failed read never draws $0.
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
  function pcx(pos) { return '<span class="pc ' + esc(pos) + '">' + esc(pos) + "</span>"; }
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
  function injuryChip(S, p) { var c = R.injuryChip(S, p); return c ? chip(c.cls, esc(c.text)) : ""; }

  // ============================== Contracts ==============================
  var CT_FILTERS = [["all", "All"], ["active", "Active"], ["ir", "IR"], ["taxi", "Taxi"]];
  // The sort: one control with three segments (Salary | Contract exp. | Name). Each starts in its own direction (1 = ascending, -1 = descending); tapping the
  // sort that is already active reverses it. The salary year (0 = this season to 2) matters only while Salary is the sort.
  var CT_SORTS = [["sal", "Salary", "salary"], ["exp", "Contract exp.", "contract expiration"], ["name", "Name", "name"]];
  var POS_LABEL = { PK: "K", PN: "P" };
  var CT_DIR = { exp: 1, sal: -1, name: 1 };
  function isSort(s) { return s === "sal" || s === "exp" || s === "name"; }
  function ctState(S) {
    var c = S.ct || {}, s = isSort(c.s) ? c.s : "exp";
    return { f: c.f || "all", s: s, y: c.y === 1 || c.y === 2 ? c.y : 0, d: c.d === 1 || c.d === -1 ? c.d : CT_DIR[s], open: c.open || {} };
  }
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

  // The Remaining guarantee cell: guarantee values only. { kind, text } with kind in loading | amount | zero | untracked | review | unavailable.
  // Presentation only: how the Worker's numbers and rules are worded. No figure is recomputed and no source record changes.
  function guarantee(S, p) {
    var st = S.penalty ? S.penalty.state : "idle";
    if (st === "idle" || st === "loading") return { kind: "loading", text: "Loading…" };
    if (st !== "ok") return { kind: "unavailable", text: "Unavailable" };
    var row = penaltyOf(S, p.id);
    if (!row) return { kind: "unavailable", text: "Unavailable" };
    if (row.needs_review) return { kind: "review", text: "Under review", why: F.str(row.review_reason) };
    var e = C.earned(row);
    if (e.kind === "rule" || e.kind === "na") return { kind: "untracked", text: "Not applicable", rule: e.kind, basis: F.str(row.basis) };
    var rg = C.remainingGuarantee(row);
    if (rg == null) return { kind: "unavailable", text: "Unavailable", noFigure: true }; // the read worked but gave no remaining-guarantee figure for this contract
    return rg === 0 ? { kind: "zero", text: "$0", sub: "Fully earned", rg: 0, row: row, earned: e.amount } : { kind: "amount", text: money(rg), rg: rg, row: row, earned: e.amount };
  }
  function gcell(g) {
    if (g.kind === "loading") return '<span class="mu">' + esc(g.text) + "</span>";
    if (g.kind === "unavailable" || g.kind === "review") return '<span class="wn">' + esc(g.text) + "</span>";
    if (g.kind === "untracked") return '<span class="mu">' + esc(g.text) + "</span>";
    return "<b>" + esc(g.text) + "</b>" + (g.sub ? '<small class="mu">' + esc(g.sub) + "</small>" : "");
  }

  // Why a contract has no weekly guarantee, in plain words, chosen from the Worker's own basis for that row (the small-contract rules it reports).
  // A basis this file does not know gets the general sentence: no rule is invented.
  var RULE_WORDS = {
    ww_under_5k_earned_na: "A waiver pickup of $4K or less in its final year has no weekly guarantee.",
    ww_under_5k_exempt: "A waiver pickup of $4K or less in its final year has no weekly guarantee.",
    one_year_under_5k_exempt: "A one-year original contract under $5K has no weekly guarantee.",
    full_year_1k_contract: "A contract paying the same small amount every year has no weekly guarantee (the full-year rule).",
    tcv_under_5k_final_year_exempt: "A contract with a total value under $5K, in its final year or a one-year deal, has no weekly guarantee."
  };
  function ruleWords(g) {
    var b = g && g.basis;
    return b && Object.prototype.hasOwnProperty.call(RULE_WORDS, b) ? RULE_WORDS[b] : "Not applicable under the league’s small-contract rules.";
  }

  // The expanded line for the guarantee: { label, html } (label is "Remaining guarantee", or "Weekly guarantee" when the small-contract rules apply).
  function guaranteeWords(S, p, g) {
    var wk = S.penalty && S.penalty.meta ? S.penalty.meta.earnedThroughWeek : null, label = "Remaining guarantee";
    if (g.kind === "loading") return { label: label, html: "Loading…" };
    if (g.kind === "unavailable") return { label: label, html: g.noFigure ? "No remaining-guarantee figure for this contract." : "Couldn’t load this." };
    if (g.kind === "review") return { label: label, html: "Under review." + (g.why ? " " + esc(g.why) + "." : "") };
    if (g.kind === "untracked") return { label: "Weekly guarantee", html: "Not applicable<small>" + esc(ruleWords(g)) + "</small>" };
    var of = isFinite(g.row.guaranteed) ? " of " + money(g.row.guaranteed) + " guaranteed" : "";
    var earned = isFinite(g.earned) ? ", " + money(g.earned) + " earned" + (wk != null ? " through Week " + wk : "") : "";
    if (g.kind === "zero") {
      var facts = (isFinite(g.row.guaranteed) ? money(g.row.guaranteed) + " guaranteed" : "") + (isFinite(g.earned) ? (isFinite(g.row.guaranteed) ? ", " : "") + money(g.earned) + " earned" + (wk != null ? " through Week " + wk : "") : "");
      return { label: label, html: "$0<small>Guaranteed portion fully earned</small>" + (facts ? "<small>" + esc(facts) + "</small>" : "") };
    }
    return { label: label, html: money(g.rg) + of + earned };
  }
  // The cut charge, with its reason in owner language. Never $0 unless the worker calculated $0.
  function cutWords(S, p) {
    var st = S.penalty ? S.penalty.state : "idle";
    if (st === "idle" || st === "loading") return "Loading…";
    var row = st === "ok" ? penaltyOf(S, p.id) : null;
    if (!row) return "Unavailable";
    if (row.needs_review) return "Under review" + (F.str(row.review_reason) ? ": " + esc(F.str(row.review_reason)) : "");
    var cut = C.cutNow(row), e = C.earned(row);
    if (cut.kind !== "amount") return "Unavailable";
    var why;
    // R6: a $0 cut under a small-contract rule points at the rule already named on the Weekly guarantee line (no worker shorthand such as "Sub-5K TCV")
    if (e.kind === "rule") why = cut.amount > 0 ? "Flat rule: a contract paying the same small amount every year costs a fixed amount to cut." : "No charge: the small-contract rule above applies";
    else if (e.kind === "na") why = "Waiver pickup of $4K or less, in its final year" + (cut.why ? " (" + String(cut.why).replace(/[.\s]+$/, "") + ")" : "");   // no ".)." from the worker's own period
    else why = cut.why ? cut.why : "The remaining guarantee";
    why = why.replace(/\s*\(§[^)]*\)/g, "").replace(/[.\s]+$/, "") + ".";   // R6: no rulebook section codes on the screen
    return "<b>" + money(cut.amount) + "</b> · " + esc(why);
  }

  // R6 Details: the full salary schedule of the CURRENT contract (completed years included, lib/contract.js history), then the contract length, years
  // remaining, the guarantee and the cut cost, each on its own line, so salary, remaining guarantee and cut cost are never mixed. A year with no
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
    var len = h.length ? plural(h.length, "year", "years") + ", " + h.start + (h.end !== h.start ? "–" + h.end : "") : h.earlier === "restructured" && h.end ? "Start not recorded, ends " + h.end : "Not recorded";
    var left = h.yearsLeft ? h.yearsLeft + " (through " + h.end + ")" : "Not recorded";
    var sch = C.schedule(p, season), gtd = g.row && isFinite(g.row.guaranteed) ? money(g.row.guaranteed) : sch.parsed.gtd != null ? money(sch.parsed.gtd) : "Not recorded";
    var gw = guaranteeWords(S, p, g);
    return '<div class="det"><div class="sec2 first">Salary schedule</div>' + (extLine ? '<div class="ext">' + esc(extLine) + "</div>" : "") + '<div class="yrl">' + (rows || '<span class="mu">No years recorded</span>') + "</div>" + (note ? '<div class="ex">' + esc(note) + "</div>" : "") +
      taxiLine(S, p) + '<div class="kv"><b>Contract</b><span>' + esc(len) + "</span><b>Years remaining</b><span>" + esc(left) + "</span><b>Type</b><span>" + esc(p.type || "Not recorded") + "</span><b>Recorded guarantee</b><span>" + gtd + "</span><b>" + gw.label + "</b><span>" + gw.html + "</span><b>If cut now</b><span>" + cutWords(S, p) + "</span></div></div>";
  }

  function contractsBody(S) {
    var t = teamOf(S), m = S.model, season = m.season, c = ctState(S), out = "";
    var ny = Math.max(1, longest(t));
    var list = t.players.filter(function (p) { return c.f === "all" || p.status === c.f; });
    function sal(p, k) { var v = salaryAt(p, season, k); return v; }
    // Each sort is written in its own starting direction (Expiration soonest first, Salary highest first, Name A to Z); the direction multiplies the
    // whole comparison, so a reversed list is the exact reverse of the first (groups and the order inside them).
    var base = {
      exp: function (a, b) { return ((a.years || 0) - (b.years || 0)) || ((sal(b, 0) || 0) - (sal(a, 0) || 0)) || a.name.localeCompare(b.name); },
      sal: function (a, b) { return ((sal(b, c.y) || 0) - (sal(a, c.y) || 0)) || ((sal(b, 0) || 0) - (sal(a, 0) || 0)) || a.name.localeCompare(b.name); },
      name: function (a, b) { return a.name.localeCompare(b.name); }
    }[c.s], dir = c.d * CT_DIR[c.s];   // CT_DIR[s] is the sort's own starting direction; c.d is the direction now in use
    list = list.slice().sort(function (a, b) { return dir * base(a, b); });

    // R6: ONE cap card (the separate recorded-salary summary card is gone; Total committed cap by year is inside the cap card)
    var cols = "g" + (ny + 1), yrs = [];
    for (var k = 0; k < ny; k++) yrs.push(season + k);
    out += capCard(S, t);

    out += '<div class="lbl">Show</div><div class="chs" role="group" aria-label="Show">' + CT_FILTERS.map(function (o) { return '<button class="ch" data-act="ctf" data-v="' + o[0] + '" aria-pressed="' + (c.f === o[0]) + '">' + o[1] + "</button>"; }).join("") + "</div>";
    // ONE sort control: Salary | Contract exp. | Name. The active segment shows its direction (▲ ascending, ▼ descending) and says it in words; tapping it again reverses.
    var DIRW = { sal: ["lowest first", "highest first"], exp: ["soonest first", "latest first"], name: ["A to Z", "Z to A"] };   // [ascending, descending]
    out += '<div class="lbl">Sort</div><div class="seg" role="group" aria-label="Sort">' + CT_SORTS.map(function (o) {
      var on = c.s === o[0], shown = on ? DIRW[o[0]][c.d === 1 ? 0 : 1] : "";
      return '<button data-act="cts" data-v="' + o[0] + '" aria-pressed="' + on + '" aria-label="' + (on ? "Sorted by " + o[2] + ", " + shown + ". Tap to reverse." : "Sort by " + o[2]) + '">' + o[1] + (on ? ' <span aria-hidden="true">' + (c.d === 1 ? "▲" : "▼") + "</span>" : "") + "</button>";
    }).join("") + "</div>";
    if (c.s === "sal") out += '<div class="chs" role="group" aria-label="Salary year">' + [0, 1, 2].map(function (i) { return '<button class="ch" data-act="cty" data-v="' + i + '" aria-pressed="' + (c.y === i) + '" aria-label="' + (season + i) + ' salary">' + (season + i) + "</button>"; }).join("") + "</div>";

    out += '<div class="thead ' + cols + '"><span>Remaining guarantee</span>' + yrs.map(function (y) { return "<span>" + y + "</span>"; }).join("") + "</div>";

    function rowHtml(p) {
      var open = !!c.open[p.id], g = guarantee(S, p);
      var exp = p.years > 0 ? "Expires " + (season + p.years - 1) : "Expiration not recorded";
      var meta = esc(F.commonCode(p.nflTeam) || "No NFL team") + " · " + esc(exp);
      var cells = '<span class="g">' + gcell(g) + "</span>";
      for (var i = 0; i < ny; i++) { var v = sal(p, i); cells += "<span>" + (v === undefined ? '<span class="mu">' + DASH + "</span>" : v == null ? '<span class="wn">n/r</span>' : kmoney(v)) + "</span>"; }
      // Two separate controls: the player's NAME (with his position badge) opens his profile; a quiet "Details" control opens or closes the contract details.
      var h = '<div class="rw"><div class="rwh"><button class="nmb" data-act="card" data-pid="' + esc(p.id) + '" aria-label="Open ' + esc(p.name) + ' profile"><span class="l1">' + pcx(POS_LABEL[p.pos] || p.pos) + ' <span class="nmt">' + esc(p.name) + "</span>" + (p.status === "ir" ? " " + chip("", "IR") : p.status === "taxi" ? " " + chip("", "Taxi") : "") + '</span></button>' +
        '<button class="rb dtl" data-act="ctx" data-v="' + esc(p.id) + '" aria-expanded="' + open + '" aria-label="' + (open ? "Hide" : "Show") + " contract details for " + esc(p.name) + '">Details <span aria-hidden="true">' + (open ? "▾" : "▸") + "</span></button></div>" +
        '<div class="l2">' + meta + '</div><div class="cells ' + cols + '">' + cells + "</div>";
      if (open) h += detailsHtml(S, p, g);
      return h + "</div>";
    }
    if (!list.length) out += '<div class="ex pad">No players in this group.</div>';
    else if (c.s === "exp") {
      // the groups follow the direction too: soonest expiring first, or latest first when reversed (the players inside each group are already in the reversed order)
      for (var gi = 1; gi <= ny; gi++) {
        var yl = c.d === 1 ? gi : ny + 1 - gi;
        var grp = list.filter(function (p) { return (p.years || 0) === yl; });
        if (!grp.length) continue;
        var sum = 0, any = false; grp.forEach(function (p) { var v = sal(p, 0); if (v != null) { sum += v; any = true; } });
        out += '<div class="gh2"><span>Expires <b>' + (season + yl - 1) + "</b> · " + plural(grp.length, "player", "players") + "</span><span>" + (any ? kmoney(sum) + " " + season + " salary" : DASH) + '</span></div><div class="card rows">' + grp.map(rowHtml).join("") + "</div>";
      }
      var none = list.filter(function (p) { return !(p.years > 0); });
      if (none.length) out += '<div class="gh2"><span>Expiration not recorded · ' + plural(none.length, "player", "players") + '</span><span></span></div><div class="card rows">' + none.map(rowHtml).join("") + "</div>";
    } else out += '<div class="card rows">' + list.map(rowHtml).join("") + "</div>";

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
  // "Taxi-eligible · $0 cut charge", once per player, only when both facts are known (the sentence that explains it is in Help).
  function taxiLine(S, p) {
    var row = penaltyOf(S, p.id), cut = row && !row.needs_review ? C.cutNow(row) : null;
    if (p.taxi && p.taxi.eligible === true) return '<div class="ex"><b class="ok">Taxi-eligible' + (cut && cut.kind === "amount" && cut.amount === 0 ? " · $0 cut charge" : "") + "</b></div>";
    return "";
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
        h("Extensions", "An extension starts a new current contract in the season it is made: it keeps that season’s salary and adds one or two years, so a player extended this season for two years shows this season and the next two. “Extended by” names the team that made that extension, from the contract’s own extension record, even if he has changed teams since. When the record does not name a current team, no team is shown. A restructure keeps the contract but MFL then records only the years from the restructure on, so earlier years can be missing.") +
        h("Taxi", "A taxi-eligible player can be released with a $0 cut charge while taxi eligibility applies. Releasing ends eligibility.") +
        h("Where the numbers come from", "Contracts as recorded on MFL" + (asOf ? " (as of " + esc(asOf) + ")" : "") + ". Earned, guarantee and cut charge: the UPS cap calculation" + (wk != null ? " through Week " + esc(wk) : "") + ".") +
        h("Symbols", esc(DASH) + " contract ended · n/r no amount recorded.") +
        h("Adjustments", "Cut penalties, Traded salary (including three-team trades), Other, Rounding. Other holds every fine, FA auction fines included, each named in its row, and any posted adjustment that fits no category; its reason is not guessed. Adjustments are charged to the season in the heading (the charge season); a cut date can be in an earlier season.") +
        h("Player names", "A name comes from the player ID on the charge, looked up in MFL’s complete player list (so it works whether or not he is on a roster now), or, for older add/drop records that carry no player ID, from UPS’s reviewed list. If neither names him it reads “Player Unknown”. A fine, rounding or settlement has no player.") +
        h("Cut dates", "Dates are Eastern Time and shown only when verified: the date comes from the drop time recorded on the charge, from UPS’s reviewed list, or, for next season, from the ledger’s drop time. Otherwise the row says “Cut date not recorded”. Waiver drops process at 9:00 AM ET, so only the date is shown.") +
        h("Remaining guarantee", "The guaranteed part of a contract that has not been earned yet. $0 with “Fully earned” means the whole guaranteed portion has been earned, so nothing remains.") +
        h("Weekly guarantee: Not applicable", "Small contracts have no weekly guarantee: a waiver pickup of $4K or less in its final year, a one-year original contract under $5K, a contract with a total value under $5K in its final year, and a contract paying the same small amount every year (the full-year rule). The expanded row says which one applies.") +
        h("Next-season adjustments", esc(G.completeness) + " " + esc(G.reconciliation) + " " + esc(G.calculation));
    }
    if (sub === "performance") {
      return h("Through Week", "Every season figure and both ranks run through one week: the last week in which every NFL game is final and the team history the PPG rank needs is settled. If the scores are complete through Week 10 but the history only through Week 9 (or an earlier week), everything shows that week until the history catches up; newer scores appear in each player’s game log. When no team history is available at all, the figures that do not need it (Tot. Pts., Actual PPG, scored games, the Tot. Pts. rank) run through the last all-final week and the PPG rank is " + esc(DASH) + " for everyone.") +
        h("Tot. Pts., Actual PPG, scored games", "Tot. Pts. is the player’s official MFL scores added up. Actual PPG is Tot. Pts. divided by scored games, the games with a recorded score (0.0 and negative scores count; a game with no recorded score does not). A 0.0 is a score MFL recorded; it is not proof that he played.") +
        h("Ranks", "QB2 is the player’s place among players at his position (tied players share a place). QB2–4 means some players cannot be placed yet (no position on file, a score that could not be read, or a PPG eligibility that is not settled), so he could be anywhere from 2nd to 4th. Ranges can narrow as weeks complete. " + esc(DASH) + " means no supported rank. The PPG rank needs scores in at least half of the team’s games and needs team history; until that is available it is " + esc(DASH) + " for everyone. For a range, the Breakdown says why and how large the group could be. The game log’s Rank column is the player’s exact place at his position that week (WR3), shown only for completed weeks and only when it is exact; otherwise " + esc(DASH) + ".") +
        h("xFP PPG and Over Expectations", "Not Available until the expected-points model is approved.") +
        h("Projection", "MFL’s projection for the lineup week, as last captured before the player’s own kickoff; it is frozen at kickoff, and a capture after kickoff is never used. Not Available when there is none. The Breakdown shows when it was captured.") +
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
      } else if (it.category === "Traded Salary") who = it.detail && it.detail.kind === "three_team" ? "Three-team trade" : "Trade";
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
  // Tot. Pts. and Actual PPG with their own compact positional ranks, xFP PPG and Over Expectations beneath (both "Not Available": the hard gate below),
  // the week-labeled projection (secondary), and a quiet "Breakdown" text control. Every player of the team is listed, grouped by position (no
  // All / Starters / Bench filter). Every season figure runs through ONE week (seasonCutoff), said once at the top.
  var PF_SORTS = [["pos", "By position"], ["tot", "Tot. Pts."], ["ppg", "Actual PPG"]];
  var NOT_AVAILABLE = "Not Available";
  function pfState(S) { var c = S.pf || {}, s = c.s === "avg" ? "ppg" : c.s; return { s: s === "tot" || s === "ppg" ? s : "pos", open: c.open || {}, res: c.res || {} }; }

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
    var ev = CH.evaluate(inp), byeOf = ctx.input.byeOf, entries = [], elig = {};
    var sameBase = ev.state !== "ok" || ev.cutoff === L;   // by construction; if it ever failed, no eligibility would be built on two bases
    ids.forEach(function (id) {
      var g = groupOf(id), n = sf.totals[id].n, row = ev.rows[id], e;
      if (!row || sf.invalid[id]) e = K.eligibility(n, null, null, "missing");
      else if (row.elig.hist !== "ok") e = K.eligibility(n, null, null, row.elig.hist);
      else if (!sameBase) e = K.eligibility(n, null, null, "incomplete");
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
      if (g) entries.push({ id: id, group: g, total: sf.totals[id].total, n: n, status: e.status, usable: !sf.invalid[id] });
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
    var v = { state: "ok", cutoff: L, sf: sf, ev: ev, entries: entries, elig: elig, seasonEntries: seasonEntries, groupOf: groupOf, unplacedGame: unplacedGame, bad: bad, weekRank: weekRank };
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
    if (pg) { o.gameRank = K.compactRank(pg); o.gameRankLong = K.rankText(pg); o.detail.push(rankLine("Actual PPG rank", pg, "ppg")); if (!pg.exact) o.range = true; }
    else if (e) {
      var why = histOff && /^Team history/.test(e.why || "") ? "" : e.why;   // a reason about this player goes to his Breakdown; "no team history" is said once, at the top
      o.gameWhy = why; if (why) o.detail.push(["Actual PPG rank", DASH, "Not shown: " + why + "."]);
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
    if (!list || !c || c === "FA") return { ko: null, why: "no_kickoff" };
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
  // The Breakdown's projection line: provider and capture time (ET), or why it is Not Available.
  function projectionDetail(g) {
    if (g.value == null) return [g.label, NOT_AVAILABLE, PROJ_WHY[g.why] ? PROJ_WHY[g.why] + "." : ""];
    return [g.label, g.text, "MFL projection, captured " + F.etStamp(new Date(g.capturedAt).toISOString()) + ", before his kickoff (" + F.etStamp(new Date(g.kickoff).toISOString()) + "). Frozen at kickoff."];
  }

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
  // The main card's Breakdown, opened in place: the rank detail the card abbreviates (r6p: the pool and bounds, or why a rank is not shown), then the
  // Breakdown itself (lib/breakdown.js: season stats, the weekly game log, each game's detail) WITHOUT its summary line, because the card above already
  // shows Tot. Pts. and the scored games. Same cutoff W* as the card (the Breakdown reads seasonCutoff).
  function breakdown(S, id, ctx) {
    ctx = ctx || perfCtx(S, [id]);
    var p = S.model && S.model.byId[id];
    var f = ctx && ctx.read === "ok" ? statFigures(S, id, ctx.rank, !!ctx.histOff) : null;
    var lines = (f ? f.detail : []).slice();
    if (p) lines.push(projectionDetail(projectionSlot(S, p)));   // R7: provider and capture time live here, not on the card
    return '<div class="det pfbd">' + (lines.length ? '<div class="kv">' + lines.map(function (d) { return "<b>" + esc(d[0]) + "</b><span>" + esc(d[1]) + (d[2] ? '<small class="mu">' + esc(d[2]) + "</small>" : "") + "</span>"; }).join("") + "</div>" : "") +
      (p ? gameLog(S, p, { summary: false }) : "") + "</div>";
  }
  function perfRow(S, p, ctx) {
    var open = !!pfState(S).open[p.id], nm = esc(p.name), g = figs(S, p, ctx), lc = liveChip(S, p, ctx);
    var meta = [esc(F.commonCode(p.nflTeam) || "No NFL team")];
    if (g.n != null) meta.push(plural(g.n, "scored game", "scored games"));
    var h = '<div class="rw pfc"><button class="nmb" data-act="card" data-pid="' + esc(p.id) + '" aria-label="Open ' + nm + ' profile"><span class="l1">' + nm + " " + pcx(p.pos) + "</span></button>" +
      '<div class="pfm">' + meta.join(" · ") + (startingTag(p) + injuryChip(S, p) + lc.html ? ' <span class="fl">' + startingTag(p) + injuryChip(S, p) + lc.html + "</span>" : "") + "</div>" +
      '<div class="pf1">' + metric("Tot. Pts.", f1(g.total), g.totRank, "pfv") + metric("Actual PPG", f1(g.ppg), g.ppgRank, "pfv") + "</div>" +
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
    ctx.histOff = ctx.ev.state !== "ok";   // no team history for the whole screen: the PPG rank is "—" for everyone, said ONCE in the header card
    ctx.rank = rankData(S, ctx);
    return ctx;
  }
  function performanceBody(S) {
    var t = teamOf(S), c = pfState(S), out = "";
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
    var lag = SC.reason === "history_behind" && SC.gap >= 2 ? "Team history is " + SC.gap + " weeks behind, so every figure waits at Week " + W + ". Newer scores are in each Breakdown." : "";
    var warn = !!(hl && hl.warn) || !!lag || vr.state === "unverified" || vr.state === "problems" || ctx.failed;
    out += '<div class="card pfh' + (warn ? " warnc" : "") + '"><b>Through Week ' + W + "</b>" + verifyNote(vr, W) +
      (hl ? '<div class="ex' + (hl.warn ? " wn" : "") + '">' + esc(hl.text) + "</div>" : "") + (lag ? '<div class="ex wn">' + esc(lag) + "</div>" : "") +
      (ctx.failed ? '<div class="ex wn mt4">Some weeks of scores could not be read. <button class="link" data-act="retryperf">Try again</button></div>' : ctx.loading ? '<div class="ex mt4">Loading the latest weeks…</div>' : "") + "</div>";

    // R8: "Search players" narrows THIS team's list by name (no network, no other team, no free agents); the sort and grouping apply to what matches.
    out += pfSearchBox(S) + '<div class="lbl">Sort</div><div class="chs" role="group" aria-label="Sort">' + PF_SORTS.map(function (o) { return '<button class="ch" data-act="pfs" data-v="' + o[0] + '" aria-pressed="' + (c.s === o[0]) + '">' + o[1] + "</button>"; }).join("") + "</div>";
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
    return perfList(S, t, pfState(S), ctx);
  }
  function perfList(S, t, c, ctx) {
    var out = "", match = pfMatcher(pfQuery(S)), pool = match ? t.players.filter(match) : t.players;
    var act = pool.filter(function (p) { return p.status === "active"; });
    function rowOf(p) { return perfRow(S, p, ctx); }
    function val(p, key) { var g = figs(S, p, ctx), v = key === "tot" ? g.total : g.ppg; return v == null ? -1e9 : v; }
    if (match && !pool.length) return '<div class="card"><div class="big2"><b>No players match</b></div><div class="ex">No player on ' + esc(t.name) + " has a name containing “" + esc(pfQuery(S).trim()) + "”. The search covers this team only.</div></div>";
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
      out += '<div class="gh2"><span>' + (c.s === "tot" ? "Tot. Pts., highest first" : "Actual PPG, highest first") + "</span><span>" + act.length + '</span></div><div class="card rows">' + act.map(rowOf).join("") + "</div>";
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
    if (ev.state === "ok") return null;
    if (ev.reason === "absent") return { text: "PPG ranks aren’t available yet.", warn: false };
    if (ev.reason === "stale") return { text: ev.banner.text + ", so PPG ranks are not shown.", warn: true };
    return { text: "Team history unavailable" + (HIST_WHY[ev.reason] ? ": " + HIST_WHY[ev.reason] : "") + ". PPG ranks are not shown.", warn: true };
  }
  // The exports the Breakdown and the tests read (merged into this file's API below).
  var PERF_API = { seasonCutoff: seasonCutoff, statFigures: statFigures, projectionRequest: projectionRequest, kickoffOf: kickoffOf, perfCtx: perfCtx, perfFigures: function (S, id) { var p = S.model && S.model.byId[id], ctx = p ? perfCtx(S, [id]) : null; return ctx && ctx.read === "ok" && ctx.input.latestFinal ? figs(S, p, ctx) : null; }, modelSlots: modelSlots, projectionSlot: projectionSlot, breakdown: breakdown };

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
  var API = mixApi({ rankData: rankData, completion: completion, contractsBody: contractsBody, performanceBody: performanceBody, performanceList: performanceList, pfMatcher: pfMatcher,gameLog: gameLog, screenHelp: screenHelp, failCard: failCard, capCard: capCard, ctNextSort: ctNextSort, guarantee: guarantee, cutWords: cutWords, perfInput: perfInput, weeksFor: weeksFor, logWeeks: logWeeks, throughOf: throughOf, kmoney: kmoney, coverFor: coverFor, verification: verification, staleScores: staleScores }, PERF_API);
  return API;
});
