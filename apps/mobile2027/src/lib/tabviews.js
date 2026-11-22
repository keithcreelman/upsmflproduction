/* UPS 2027 R3: the bodies of Team › Contracts and Team › Performance, and the profile's game log. Pure functions of the state object
   (no network, no storage, no DOM), drawn as HTML strings like views.js. Every piece of text that comes from a data source goes through esc().

   Rules this file keeps (owner rulings, 2026-11-21; scope record on #1475):
   - Contracts: labels and sorts follow the season the roster read reports (no year is written in this file); the salary columns are as many as
     the longest contract left; no points per game and no position rank anywhere; "Recorded salary, not cap space" and no link into Cap & picks.
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
    req ? require("./complete.js") : root.UPS2027.complete
  );
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.UPS2027 = root.UPS2027 || {}; root.UPS2027.tabviews = api; }
})(typeof self !== "undefined" ? self : this, function (F, C, R, CH, A, K, X) {
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
  // The sort: one control with three segments (Salary, Expiration, Name). Each starts in its own direction (1 = ascending, -1 = descending); tapping the
  // sort that is already active reverses it. The salary year (0 = this season to 2) matters only while Salary is the sort.
  var CT_SORTS = [["sal", "Salary"], ["exp", "Expiration"], ["name", "Name"]];
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
    if (e.kind === "rule") why = cut.amount > 0 ? "Flat rule: a contract paying the same small amount every year costs a fixed amount to cut." : "No charge: " + (cut.why ? cut.why : "exempt under the flat rule");
    else if (e.kind === "na") why = "Waiver pickup of $4K or less, in its final year" + (cut.why ? " (" + cut.why + ")" : "");
    else why = cut.why ? cut.why : "The remaining guarantee";
    why = why.replace(/[.\s]+$/, "") + ".";
    return "<b>" + money(cut.amount) + "</b> · " + esc(why);
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

    // the totals card: recorded salary only
    var tot = [], cnt = [], missing = [], k;
    for (k = 0; k < ny; k++) { tot.push(0); cnt.push(0); missing.push(0); }
    list.forEach(function (p) { for (var i = 0; i < ny; i++) { var v = sal(p, i); if (v === undefined) continue; if (v == null) missing[i]++; else { tot[i] += v; cnt[i]++; } } });
    var cols = "g" + (ny + 1), tcols = "t" + ny;
    out += capCard(S, t);
    out += '<div class="card"><h2>Recorded salary, not cap space</h2><div class="trow ' + tcols + '">' + tot.map(function (v, i) { return "<b>" + (cnt[i] ? kmoney(v) : DASH) + "</b>"; }).join("") + "</div>" +
      '<div class="trow ' + tcols + ' mu">' + tot.map(function (v, i) { return "<span>" + (season + i) + "</span>"; }).join("") + "</div>" +
      '<div class="ex mt4">' + plural(list.length, "player", "players") + " shown." +
      (missing.some(function (n) { return n > 0; }) ? " A year with no recorded amount is left out of its total." : "") + "</div></div>";

    out += '<div class="lbl">Show</div><div class="chs" role="group" aria-label="Show">' + CT_FILTERS.map(function (o) { return '<button class="ch" data-act="ctf" data-v="' + o[0] + '" aria-pressed="' + (c.f === o[0]) + '">' + o[1] + "</button>"; }).join("") + "</div>";
    // ONE sort control: Salary | Expiration | Name. The active segment shows its direction (▲ ascending, ▼ descending) and says it in words; tapping it again reverses.
    var DIRW = { sal: ["lowest first", "highest first"], exp: ["soonest first", "latest first"], name: ["A to Z", "Z to A"] };   // [ascending, descending]
    out += '<div class="lbl">Sort</div><div class="seg" role="group" aria-label="Sort">' + CT_SORTS.map(function (o) {
      var on = c.s === o[0], shown = on ? DIRW[o[0]][c.d === 1 ? 0 : 1] : "";
      return '<button data-act="cts" data-v="' + o[0] + '" aria-pressed="' + on + '" aria-label="' + (on ? "Sorted by " + o[1].toLowerCase() + ", " + shown + ". Tap to reverse." : "Sort by " + o[1].toLowerCase()) + '">' + o[1] + (on ? ' <span aria-hidden="true">' + (c.d === 1 ? "▲" : "▼") + "</span>" : "") + "</button>";
    }).join("") + "</div>";
    if (c.s === "sal") out += '<div class="chs" role="group" aria-label="Salary year">' + [0, 1, 2].map(function (i) { return '<button class="ch" data-act="cty" data-v="' + i + '" aria-pressed="' + (c.y === i) + '" aria-label="' + (season + i) + ' salary">' + (season + i) + "</button>"; }).join("") + "</div>";

    out += '<div class="thead ' + cols + '"><span>Remaining guarantee</span>' + tot.map(function (v, i) { return "<span>" + (season + i) + "</span>"; }).join("") + "</div>";

    function rowHtml(p) {
      var open = !!c.open[p.id], g = guarantee(S, p), sch = C.schedule(p, season);
      var meta = [esc(p.pos), esc(F.commonCode(p.nflTeam) || "No NFL team"), esc(p.type || "Type not recorded"), p.years ? plural(p.years, "yr left", "yrs left") : "no years recorded"].join(" · ") + esc(R.capNote(p));
      var cells = '<span class="g">' + gcell(g) + "</span>";
      for (var i = 0; i < ny; i++) { var v = sal(p, i); cells += "<span>" + (v === undefined ? '<span class="mu">' + DASH + "</span>" : v == null ? '<span class="wn">n/r</span>' : kmoney(v)) + "</span>"; }
      // Two separate controls: the player's NAME opens his profile; the rest of the row (contract facts, the figures and a chevron) opens or closes the contract details.
      var h = '<div class="rw"><button class="nmb" data-act="card" data-pid="' + esc(p.id) + '" aria-label="Open ' + esc(p.name) + ' profile"><span class="l1">' + esc(p.name) + (p.status === "ir" ? " " + chip("", "IR") : p.status === "taxi" ? " " + chip("", "Taxi") : "") + '</span></button>' +
        '<button class="rb" data-act="ctx" data-v="' + esc(p.id) + '" aria-expanded="' + open + '" aria-label="' + (open ? "Hide" : "Show") + " contract details for " + esc(p.name) + '"><span class="l2">' + meta + ' <span class="chv" aria-hidden="true">Details ' + (open ? "▾" : "▸") + '</span></span><span class="cells ' + cols + '">' + cells + "</span></button>";
      if (open) {
        var rows = "";
        for (var j = 0; j < sch.rows.length; j++) rows += "<span>" + sch.rows[j].year + "</span><span>" + (j === 0 ? "this season" : "future") + "</span><span>" + (sch.rows[j].amount == null ? "Not recorded" : money(sch.rows[j].amount)) + "</span>";
        if (sch.option) rows += "<span>" + sch.option.year + "</span><span>option year</span><span>" + money(sch.option.amount) + "</span>";
        var gtd = g.row && isFinite(g.row.guaranteed) ? money(g.row.guaranteed) : sch.parsed.gtd != null ? money(sch.parsed.gtd) + " (as recorded)" : "Not recorded";
        var gw = guaranteeWords(S, p, g);
        h += '<div class="det"><div class="sec2 first">Salary by year</div><div class="yrl">' + (rows || '<span class="mu">No remaining years recorded</span>') + "</div>" +
          taxiLine(S, p) + '<div class="kv"><b>Type</b><span>' + esc(p.type || "Not recorded") + "</span><b>Recorded guarantee</b><span>" + gtd + "</span><b>" + gw.label + "</b><span>" + gw.html + "</span><b>If cut now</b><span>" + cutWords(S, p) + "</span></div></div>";
      }
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
        out += '<div class="gh2"><span>Expiration date <b>' + (season + yl - 1) + "</b> · " + plural(grp.length, "player", "players") + "</span><span>" + (any ? kmoney(sum) + " " + season + " salary" : DASH) + '</span></div><div class="card rows">' + grp.map(rowHtml).join("") + "</div>";
      }
      var none = list.filter(function (p) { return !(p.years > 0); });
      if (none.length) out += '<div class="gh2"><span>No years recorded · ' + plural(none.length, "player", "players") + '</span><span></span></div><div class="card rows">' + none.map(rowHtml).join("") + "</div>";
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
    var rec = S && S.recorded ? "<h4>Recorded data</h4><p>This preview uses a recorded snapshot taken " + esc(S.recorded.label) + ", so the figures will not move.</p>" : "";
    return rec + screenHelpBody(S);
  }
  function screenHelpBody(S) {
    var sub = S.sub, m = S.model, wk = S.penalty && S.penalty.meta ? S.penalty.meta.earnedThroughWeek : null, asOf = m ? F.etStamp(m.asOf) : "";
    var G = A.NEXT_SEASON_GAP;
    function h(title, text) { return "<h4>" + esc(title) + "</h4><p>" + text + "</p>"; }
    if (sub === "contracts") {
      return h("Available cap space", "Total cap minus Cap charge. A negative number means the team is over the cap.") +
        h("Total cap", "The salary cap for the season, as the league’s roster read reports it. If it is not reported, no available figure is shown.") +
        h("Total committed cap", "Recorded salaries, less taxi squad players (they count $0) and half of each injured reserve player’s salary. Adjustments are not part of it.") +
        h("Cap charge", "Total committed cap plus or minus the adjustments (Cut Penalty, Traded Salary, FA Auction Fine, Rounding, Other). It is what counts against the cap, so Available cap space is Total cap minus Cap charge.") +
        h("Later years", "This season gives injured reserve players half relief and taxi players $0. <b>Planning assumption for later years:</b> players now on taxi stay on taxi ($0) and injured reserve players count at full scheduled salary. No injury relief is projected. Adjustments are the ones recorded for that year; “not recorded” is not $0.") +
        h("Taxi", "A taxi-eligible player can be released with a $0 cut charge while taxi eligibility applies. Releasing ends eligibility.") +
        h("Where the numbers come from", "Contracts as recorded on MFL" + (asOf ? " (as of " + esc(asOf) + ")" : "") + ". Earned, guarantee and cut charge: the UPS cap calculation" + (wk != null ? " through Week " + esc(wk) : "") + ".") +
        h("Symbols", esc(DASH) + " contract ended · n/r no amount recorded.") +
        h("Adjustments", "Cut Penalty, Traded Salary (including three-team settlements), FA Auction Fine, Rounding. Other is a posted adjustment that fits none of them; its reason is not guessed. The charge season is the season whose cap is charged; it can differ from the cut date.") +
        h("Player names", "A name comes from the player ID on the charge, looked up in MFL’s complete player list (so it works whether or not he is on a roster now), or, for older add/drop records that carry no player ID, from UPS’s reviewed list. If neither names him it reads “Player Unknown”. A fine, rounding or settlement has no player.") +
        h("Cut dates", "Dates are Eastern Time and shown only when verified: the date comes from the drop time recorded on the charge, from UPS’s reviewed list, or, for next season, from the ledger’s drop time. Otherwise the row says “Cut date not recorded”. Waiver drops process at 9:00 AM ET, so only the date is shown.") +
        h("Remaining guarantee", "The guaranteed part of a contract that has not been earned yet. $0 with “Fully earned” means the whole guaranteed portion has been earned, so nothing remains.") +
        h("Weekly guarantee: Not applicable", "Small contracts have no weekly guarantee: a waiver pickup of $4K or less in its final year, a one-year original contract under $5K, a contract with a total value under $5K in its final year, and a contract paying the same small amount every year (the full-year rule). The expanded row says which one applies.") +
        h("Next-season adjustments", esc(G.completeness) + " " + esc(G.reconciliation) + " " + esc(G.calculation));
    }
    if (sub === "performance") {
      return h("Season points, per scored game, scored games", "Season points are the player’s recorded scores added up through the last week in which every NFL game is final. Per scored game is season points divided by scored games, the games with a recorded score. 0.0 is a score MFL recorded; " + esc(DASH) + " is no score recorded.") +
        h("Ranks", "A rank such as QB 3 of 73 places the player among players at his position. When some players cannot yet be placed (no position on file, a score that could not be read, or an eligibility that is not settled), the rank is a range such as QB 63–66 of 169–209: the best and worst place he could hold, out of the smallest and largest group he could be ranked in. Ranges can narrow as weeks complete. The per-game rank needs scores in at least half of the team’s games.") +
        h("Weekly position rank", "The small line under a weekly score is the player’s rank among players at his position that week. It is shown only when it is exact; otherwise the line is empty.") +
        h("Recent comparison", "Compares the last 3 completed team games with the player’s earlier scored games. The per-game rank and the recent comparison need team history. When it is not available they are not shown, and the top of the screen says so once.");
    }
    if (sub === "cap") return h("Cap & picks", "Not in this preview.");
    return h("Recorded starters", "A past week shows the starters and scores MFL recorded. Slots, positions, bench, injured reserve, taxi, injuries and contracts are shown for the current week only.") +
      h("Can’t check", "MFL lists this player as a starter but he is not in the roster that loaded. His position, slot and status are unknown, so nothing is checked for him. Everyone else is still checked.") +
      h("Doubtful", "A decision may be needed. It does not mean the player is out.") +
      h("Kickoff", "Shown on a row only when it is not Sunday 1:00 PM ET.");
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
  // One adjustment row: who (or the category), what season it is charged to, and for a cut penalty the full cut date, which is a different fact.
  function itemRows(S, items, cname) {
    return items.map(function (it) {
      var cut = cname === "Cut Penalty", who, sub = "Charged to " + it.season;
      if (cut) {
        var pn = playerLabel(S, it);
        who = pn.cls ? '<span class="' + pn.cls + '">' + esc(pn.text) + "</span>" : esc(pn.text);
        sub = (it.cutDate && F.dateLabel(it.cutDate) ? "Cut " + F.dateLabel(it.cutDate) : "Cut date not recorded") + " · " + sub;
      } else who = esc(cname);
      return '<div class="cl"><span class="who">' + who + '<span class="ex">' + esc(sub) + "</span></span><b>" + smoney(it.amount) + "</b></div>";
    }).join("");
  }
  function categoryLines(S, adj, cat) {
    var out = "";
    A.CATEGORIES.forEach(function (cname) {
      var rows = adj.items.filter(function (it) { return it.category === cname; });
      if (!rows.length) return;
      if (cname === "Rounding") { out += '<div class="cl"><span>Rounding</span><b>' + smoney(adj.byCategory[cname]) + "</b></div>"; return; }   // a plain line item: nothing to open
      var open = !!(S.ct && S.ct.cat && S.ct.cat[cat + cname]);
      out += '<div class="cl"><button class="link" data-act="ctcat" data-v="' + esc(cat + cname) + '" aria-expanded="' + open + '">' + esc(cname) + " " + (open ? "▾" : "▸") + "</button><b>" + smoney(adj.byCategory[cname]) + "</b></div>";
      if (open) out += '<div class="det">' + itemRows(S, rows, cname) + '<div class="cl"><span class="mu">Total</span><b>' + smoney(adj.byCategory[cname]) + "</b></div></div>";
    });
    return out;
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
          lines = '<div class="cl"><span>Recorded salaries, ' + plural(b.recordedN, "player", "players") + "</span><b>" + money(b.recorded) + "</b></div>" +
            (b.taxiN ? '<div class="cl mu"><span>Taxi squad, ' + plural(b.taxiN, "player", "players") + "</span><b>" + MINUS + money(b.taxi) + "</b></div>" : "") +
            (b.irN ? '<div class="cl mu"><span>Injured reserve (50%), ' + plural(b.irN, "player", "players") + "</span><b>" + MINUS + money(b.irRelief) + "</b></div>" : "") +
            '<div class="cl"><b>Total committed cap</b><b>' + money(b.capHits) + "</b></div>";
          if (adj && adj.reconciled && Math.abs(adj.total - t.cap.adjTotal) < 0.5) lines += categoryLines(S, adj, "y26");
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
  // The later years, inside the cap card: committed cap per year (cap hits plus or minus that year's adjustments). 2027 opens to its ledger detail
  // (one read, made when it is first opened and then reused); 2028 has no adjustment source, so it says "not recorded", never $0.
  function laterYears(S, t) {
    var season = S.model.season;
    var adj0 = t.adjust && t.adjust.reconciled && t.cap && Math.abs(t.adjust.total - t.cap.adjTotal) < 0.5 ? { known: true, total: t.cap.adjTotal, state: "ok" } : { known: false, total: null, state: "unavailable" };
    var adj1 = nextAdj(S, t), ys = A.commitments(t, season, adj0, adj1, 3), out = '<div class="sec2">Later years</div>';
    ys.forEach(function (y, i) {
      if (i === 0) return;   // this season is the figure above
      var head = '<div class="cl"><span>' + y.year + "</span><b>" + (y.total != null ? money(y.total) : DASH) + "</b></div>";
      var sub = "Total committed cap " + (y.hitsIncomplete ? "incomplete (" + plural(y.unknownCount, "year amount", "year amounts") + " not recorded)" : money(y.hits));
      if (i === 1) {
        var ns = S.ns && S.ns.state;
        sub += " · adjustments " + (adj1.known ? smoney(adj1.total) : ns === "loading" ? "loading…" : ns === "error" ? "couldn’t load" : adj1.state === "incomplete" ? "incomplete" : "not loaded");
      } else sub += " · adjustments not recorded";
      if (i === 1) {
        var open = !!(S.ct && S.ct.ns);
        out += '<button class="link blk" data-act="nsx" aria-expanded="' + open + '">' + head + '<span class="ex">' + sub + " " + (open ? "▾" : "▸") + "</span></button>";
        if (open) out += nextDetail(S, t);
      } else out += head + '<div class="ex">' + sub + "</div>";
    });
    return out + '<div class="ex">Later years assume taxi players stay on taxi and injured reserve counts in full. See Help.</div>';
  }
  function nextDetail(S, t) {
    var ns = S.ns || { state: "idle" }, season = S.model.season + 1;
    if (ns.state === "idle" || ns.state === "loading") return '<div class="det"><div class="ex mu">Loading…</div></div>';
    if (ns.state === "error") return '<div class="det">' + failCard("retryns") + "</div>";
    var p = ns.by && ns.by[t.id];
    if (!p) return '<div class="det"><div class="ex">No ' + season + " adjustments are recorded for this team.</div></div>";
    var out = '<div class="det">';
    if (p.reconciled) {
      if (!p.items.length) out += '<div class="ex">No ' + season + " adjustments recorded yet.</div>";
      else out += categoryLines(S, p, "y27") + '<div class="cl"><b>Total</b><b>' + smoney(p.total) + "</b></div>";
    }
    out += '<div class="ex">UPS ledger amounts, not yet on MFL.</div>';
    if (p.waiting) out += '<div class="ex wn">' + plural(p.waiting, "cut is", "cuts are") + " waiting for a price and not counted.</div>";
    if (p.review) out += '<div class="ex wn">' + plural(p.review, "cut needs", "cuts need") + " review and not counted.</div>";
    var onMfl = (p.unverifiedWhy && p.unverifiedWhy.already_on_mfl) || 0, unv = (p.unverified || 0) - onMfl;
    if (onMfl) out += '<div class="ex wn">' + plural(onMfl, "record is", "records are") + " already on MFL and not counted here.</div>";
    if (unv > 0) out += '<div class="ex wn">' + plural(unv, "record", "records") + " could not be verified and not counted.</div>";
    if (!p.reconciled) out += '<div class="ex wn">Detail unavailable: ' + esc(onMfl && unv <= 0 ? "records already on MFL are not counted, so the total cannot be checked" : p.mismatch || "the items do not add up") + ".</div>";
    return out + "</div>";
  }

  // ============================== Performance ==============================
  // Every player of the team is listed (no Starters / Bench filter); the sort offers only the orders that apply (see performanceBody).
  var PF_SORTS = [["pos", "By position"], ["diff", "Difference"], ["avg", "Season average"]];
  function pfState(S) { var c = S.pf || {}; return { s: c.s || "pos", open: c.open || {}, res: c.res || {} }; }

  // everything clubhist needs, from the state. null while the matchup read (season figures, latest final week, team history) is not in.
  function perfInput(S, ids) {
    var cur = S.model.week, mu = S.intel && S.intel.mu && S.intel.mu[cur];
    if (!mu || mu.state !== "ok") return { read: mu ? mu.state : "loading" };
    var d = mu.data, clubs = {}, byePlayers = [];
    S.model.teams.forEach(function (t) { t.players.forEach(function (p) { byePlayers.push({ club: p.nflTeam, bye: p.bye }); }); });
    ids.forEach(function (id) { var p = S.model.byId[id]; clubs[id] = p ? p.nflTeam : ""; });
    // PR B: every figure runs through the last week in which EVERY game is final, judged per game (lib/complete.js). The Worker's latestFinalWeek
    // ("at least one final game") is not used. Until that week is established nothing is drawn from the season.
    var C0 = completion(S);
    if (C0.state !== "ok") return { read: "completion", completion: C0, mu: d };
    var L = C0.week, scores = {}, weeks = L ? weeksFor(L, throughOf(d)) : [], loading = false, failed = false, allWeeks = true;
    weeks.forEach(function (w) {
      var r = scoresOf(S)[w];
      if (!r || r.state === "loading") loading = true; else if (r.state === "ok") scores[w] = r.data.scores; else failed = true;
    });
    for (var aw = 1; aw <= L; aw++) { var ra = scoresOf(S)[aw]; if (!ra || ra.state === "loading") { allWeeks = false; loading = true; } else if (ra.state !== "ok") { allWeeks = false; failed = true; } else if (staleScores(S, aw)) { allWeeks = false; loading = true; } }
    Object.keys(scoresOf(S)).forEach(function (w) { var r = scoresOf(S)[w]; if (r && r.state === "ok") scores[w] = r.data.scores; });
    var through = d.hist && typeof d.hist.teamHistoryThrough === "number" ? d.hist.teamHistoryThrough : null;
    // The season totals count a player-game only when his game is FINAL. A newer-week score is in the total when that week is over (the lineup
    // week has moved on) or when his club's game that week is final; otherwise it is a live score the total does not hold.
    var newerFinal = { complete: !!(L && cur && L < cur), clubs: {} };
    Object.keys(d.games || {}).forEach(function (c) { newerFinal.clubs[c] = d.games[c].status === "final"; });
    // Season totals are summed from the weekly reads Weeks 1..L (MFL's own scores), never taken from a figure that may include a game in progress.
    // If any week is missing or failed the totals are unavailable (withheld together), never a partial sum.
    var season = null;
    if (allWeeks) {
      season = {};
      var wm = {}; for (var sw = 1; sw <= L; sw++) wm[sw] = scoresOf(S)[sw].data.scores;
      var sf = K.seasonFrom(wm, L, function () { return "x"; });
      ids.forEach(function (id) { var tt = sf.totals[id]; if (tt && !sf.invalid[id]) season[id] = { total: tt.total / 100, games: tt.n }; });
    }
    var badMap = {};   // per player: how many recorded scores are not readable (independent of the rank reads)
    if (allWeeks) for (var bw = 1; bw <= L; bw++) { var m1 = scoresOf(S)[bw].data.scores; ids.forEach(function (bid) { if (Object.prototype.hasOwnProperty.call(m1, bid) && typeof m1[bid] === "string") badMap[bid] = (badMap[bid] || 0) + 1; }); }
    return { read: "ok", bad: badMap, mu: d, weeks: weeks, loading: loading, failed: failed, completion: C0,
      input: { through: through, latestFinal: L, hist: d.hist, clubs: clubs, byeOf: CH.clubByeMap(byePlayers), season: season, scores: scores, ids: ids, newerFinal: newerFinal } };
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
  // The cutoff week: { state: "loading" | "error" | "none" | "unavailable" | "conflict" | "ok", week }. Needs the Worker's lastCompleteWeek and the schedule of that week
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

  // ---- PR B: league-wide ranks. Season totals come from the weekly reads Weeks 1..N; positions from the players read; per-game eligibility from the team-history
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
    var L = ctx.input.latestFinal, nScores = ""; // the memo key includes when each week was read, so a refreshed score read is never served from the memo
    for (var sw0 = 1; sw0 <= L; sw0++) { var r0 = scoresOf(S)[sw0]; nScores += (r0 && r0.at != null ? r0.at : "-") + ","; }
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
    inp.ids = ids; inp.clubs = clubs; inp.season = season; inp.scores = wm;
    var ev = CH.evaluate(inp), byeOf = ctx.input.byeOf, entries = [], elig = {};
    ids.forEach(function (id) {
      var g = groupOf(id), n = sf.totals[id].n, row = ev.rows[id], e;
      if (!row || sf.invalid[id]) e = K.eligibility(n, null, null, "missing");
      else if (row.elig.hist !== "ok") e = K.eligibility(n, null, null, row.elig.hist);
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
    // The weekly position rank (the third line of a weekly cell): the player's rank among every scorer in his position group that week, from the same weekly read
    // the cell's score comes from. Computed once per week and kept with the memo (the memo is replaced when any week is read again). Shown only when EXACT: a
    // competitor who cannot be placed in a group, or whose score cannot be read, and who could be ahead makes it a range, and a range is not shown here.
    // "" when the player has no reliable position group, no readable score that week, or the rank is not exact.
    var weekly = {};
    function weekRank(week, id) {
      var m = weekly[week] || (weekly[week] = K.weekFrom(wm[week] || {}, groupOf)), r = K.totalRank(m.entries, id, m.unplaced);
      return r && r.exact ? r.group + " " + r.best : "";
    }
    var v = { state: "ok", cutoff: L, sf: sf, ev: ev, entries: entries, elig: elig, seasonEntries: seasonEntries, groupOf: groupOf, unplacedGame: unplacedGame, bad: bad, weekRank: weekRank };
    RANK_MEMO = { d: ctx.mu, pl: pl.data, L: L, n: nScores, v: v };
    return v;
  }
  // Season points, per scored game, scored games and both ranks for one player, as text. Never a figure from a partial set.
  // Ranks are the compact text only ("QB 3 of 73", "WR 63–66 of 169–209"); how a rank is bounded is in Help, not on the row. `histOff`: team history is not available for
  // the whole screen, so the per-game rank is withheld for everyone and that one fact is said once at the top, never again on a row.
  function statFigures(S, id, RD, histOff) {
    var o = { total: null, ppg: null, n: null, bad: 0, noPos: false, seasonRank: "", gameRank: "", gameWhy: "", detail: [], range: false };
    if (!RD || RD.state !== "ok") return o;
    var t = RD.sf.totals[id];
    o.bad = (RD.bad && RD.bad[id]) || 0;
    o.noPos = !RD.groupOf(id);
    if (!t || RD.sf.invalid[id]) return o;
    o.total = t.total / 100; o.n = t.n; o.ppg = t.total / 100 / t.n;
    var sr = K.totalRank(RD.seasonEntries, id, RD.sf.unplaced);
    if (sr) { o.seasonRank = K.rankText(sr); o.detail.push(["Season points rank", K.rankText(sr)]); if (!sr.exact) o.range = true; }
    var pg = K.perGameRank(RD.entries, id, RD.unplacedGame), e = RD.elig[id];
    if (pg) { o.gameRank = K.rankText(pg); o.detail.push(["Per-game rank", K.rankText(pg)]); if (!pg.exact) o.range = true; }
    else if (e) {
      var why = histOff && /^Team history/.test(e.why || "") ? "" : e.why;   // a reason that is about this player stays on his row; "no team history" is said once, at the top
      o.gameWhy = why; if (why) o.detail.push(["Per-game rank", "Not shown: " + why + "."]);
    }
    return o;
  }
  // The Live / Final · updating chip for one player in the lineup week (lib/complete.js decides). "" when there is nothing to say.
  function liveChip(S, p, ctx) {
    var cur = S.model.week, N = ctx.input.latestFinal;
    if (!(cur > N)) return { html: "", retry: false };
    var sch = S.intel.sched && S.intel.sched[cur], sc = scoresOf(S)[cur], d = ctx.mu, club = String(p.nflTeam || "").toUpperCase();
    if (!sch || sch.state !== "ok") return { html: "", retry: false };
    var games = sch.data.games, st = statusMap(d), g = X.gameOf(games, club), gs = X.gameState(g, g ? (st[club] === undefined ? "missing" : st[club]) : null);
    var score = sc && sc.state === "ok" && typeof sc.data.scores[p.id] === "number" ? sc.data.scores[p.id] : null;
    var all = X.weekComplete(games, st, coverFor(S, cur)), now = S.nowMs != null ? S.nowMs : Date.now();
    var h = X.handoff({ game: gs, score: score, cutoff: N, week: cur, weekAllFinal: all, read: sc && sc.state ? { state: sc.state, at: sc.at } : { state: "loading" }, tries: { startedAt: S.live && S.live.allFinalAt != null ? S.live.allFinalAt : null, now: now } });
    return { html: h.chip ? '<span class="live">' + esc(h.chip) + "</span>" : "", retry: !!(h.chip && h.retry) };   // Retry is drawn by the row, outside its button (a button cannot sit inside a button)
  }
  // The weeks to read: the strip (the latest final week and the three before it) plus the look-back of the comparison, which runs from the history
  // coverage week and may need a bye week skipped (cutoff - 3 .. cutoff). With history current that is four weeks; one week behind, five.
  function throughOf(d) { var h = d && d.hist; return h && typeof h.teamHistoryThrough === "number" && h.teamHistoryThrough >= 1 ? h.teamHistoryThrough : null; }
  function weeksFor(L, through) {
    var from = L - 3; if (through != null && through <= L) from = Math.min(from, through - 3);
    var w = []; for (var i = Math.max(1, from); i <= L; i++) w.push(i); return w;
  }

  function scoresOf(S) { return (S.intel && S.intel.scores) || {}; }
  // One weekly cell: three lines, Week / Points / position rank. The third line is always there (empty when there is no rank to show, or a label such as "live" or
  // "newer"), so every cell has the same height and the strip stays aligned. `rank` is the exact weekly position rank for a plain score ("QB 12"), else "".
  function cellHtml(c, S, rank) {
    var wk = '<i>W' + c.week + "</i>", none = '<em class="wr"></em>';
    if (c.kind === "unreadable" || c.bad) return '<span class="cell" title="This score could not be read">' + wk + '<b class="mu">?</b>' + none + "</span>";
    if (c.kind === "bye") return '<span class="cell by">' + wk + "<b>BYE</b>" + none + "</span>";
    if (c.kind === "live") return '<span class="cell newer" title="Game not final">' + wk + '<b>' + (c.score == null ? DASH : f1(c.score)) + "</b><u>live</u></span>";
    if (c.kind === "newer") return '<span class="cell newer" title="Newer than the comparison cutoff">' + wk + '<b>' + (c.score == null ? DASH : f1(c.score)) + '</b><u>newer</u></span>';
    if (c.kind === "score") return '<span class="cell">' + wk + "<b>" + f1(c.score) + "</b>" + (rank ? '<em class="wr" title="Rank among players at his position that week">' + esc(rank) + "</em>" : none) + "</span>";
    if (c.kind === "unloaded") return '<span class="cell">' + wk + '<b class="mu">' + (scoresOf(S)[c.week] && scoresOf(S)[c.week].state === "error" ? "n/a" : "…") + "</b>" + none + "</span>";
    return '<span class="cell">' + wk + "<b>" + DASH + "</b>" + none + "</span>";
  }

  var IDENT = { known: "known", unknown_before_first_record: "unknown (before his first record)", one_of_two_clubs: "one of two clubs (he moved)", no_evidence: "unknown (no club evidence for this player)", conflict: "records conflict" };
  function helpHtml(row) {
    var h = '<div class="note"><b>Why there is no “of N” for scored games.</b> ' + plural(row.scoredGames == null ? 0 : row.scoredGames, "scored game is", "scored games are") + " known from recorded scores. The number of team games is not established, so none is shown.";
    (row.coverage || []).forEach(function (c) {
      if (c.identity === "known" && c.opportunity === "known") return;
      var weeks = []; for (var w = c.fromWeek; w <= c.toWeek; w++) weeks.push(w);
      h += '<div class="mt4"><b>' + esc(weekSpan(weeks)) + "</b><br>Club identity: " + esc(IDENT[c.identity] || "unknown") + "<br>Game opportunity: " +
        (c.opportunity === "known" ? "known" : c.identity === "one_of_two_clubs" ? "unknown (one club had a bye, the other played)" : "unknown" + (c.identity === "unknown_before_first_record" ? " (not assumed from a later club)" : "")) + "</div>";
    });
    return h + "</div>";
  }

  function nextText(S, p, mu) {
    var weeks = mu.horizonWeeks || [], hz = mu.horizon && mu.horizon[String(p.nflTeam || "").toUpperCase()];
    if (!weeks.length) return '<span class="mu">Unavailable</span>';
    return weeks.map(function (w) {
      var g = hz ? hz.filter(function (x) { return x.wk === w; })[0] : null;
      var t = g && g.opp ? (g.isHome ? "vs " : "@ ") + g.opp : p.bye === w ? "BYE" : "Unavailable";
      return "<span><i>Wk " + w + "</i>" + esc(t) + "</span>";
    }).join("");
  }

  // Season production first: points, per scored game, scored games, each rank beside its figure (the detail is in the opened row).
  // What one row shows for the season figures: the three figures, the two compact ranks (or why one is withheld) and whether a shown rank is a range.
  function figs(S, p, ctx) {
    var f = statFigures(S, p.id, ctx.rank, !!ctx.histOff), se = ctx.input.season && ctx.input.season[p.id];
    var total = f.total != null ? f.total : se ? se.total : null, n = f.n != null ? f.n : se ? se.games : null, ppg = f.ppg != null ? f.ppg : (se && se.games > 0 ? se.total / se.games : null);
    var rs = ctx.rank && ctx.rank.state === "loading" ? "Loading ranks…" : ctx.rank && ctx.rank.state !== "ok" ? "" : f.seasonRank;
    var gr = f.gameRank || f.gameWhy || (ctx.rank && ctx.rank.state === "loading" ? "…" : "");
    var nbad = (ctx.bad && ctx.bad[p.id]) || f.bad, range = f.range;
    if (nbad) { rs = "Unverified"; gr = "Unverified"; range = false; }
    else if (f.noPos && f.total != null) { rs = "Position not confirmed"; gr = "Position not confirmed"; range = false; }
    return { f: f, total: total, n: n, ppg: ppg, rs: rs, gr: gr, nbad: nbad, range: range };
  }
  function statGrid(S, p, ctx) {
    var g = figs(S, p, ctx);
    return '<div class="stat3"><div><span>Season points</span><b>' + (g.total == null ? DASH : f1(g.total)) + "</b><em>" + esc(g.rs) + "</em></div><div><span>Per scored game</span><b>" + (g.ppg == null ? DASH : f1(g.ppg)) + "</b><em" + (g.f.gameRank ? "" : ' class="no"') + ">" + esc(g.gr) + "</em></div><div><span>Scored games</span><b>" + (g.n == null ? DASH : g.n) + "</b></div></div>" +
      (g.nbad ? '<div class="ex wn">' + plural(g.nbad, "score", "scores") + " could not be read, so his season figures and ranks are not shown.</div>" : "");
  }
  function perfRow(S, p, row, ctx) {
    var open = !!pfState(S).open[p.id], cmp = row.cmp, shown = cmp.state === "shown", nm = esc(p.name);
    var hasBad = row.strip.some(function (c) { return c.kind === "unreadable" || c.bad; });
    var hasCmp = !ctx.histOff;   // with no team history the recent comparison does not exist for anyone: it is not drawn, and the top of the screen says so once
    var lab = "Last 3 team games" + (row.window && typeof row.window.scoredCount === "number" ? " · " + row.window.scoredCount + " of 3 scored" : "") + (hasBad ? " · a score could not be read" : "");
    var g3 = '<span><i>Recent</i><b>' + (shown ? f1(row.recent) : DASH) + "</b></span><span><i>Earlier</i><b>" + (shown ? f1(row.earlier) + " <small>(" + row.earlierN + ")</small>" : DASH) + "</b></span><span><i>Difference</i><b>" + (shown ? signed(row.difference) : DASH) + "</b></span>";
    var cells = row.strip.map(function (c) { return cellHtml(c, S, c.kind === "score" && ctx.rank && ctx.rank.state === "ok" ? ctx.rank.weekRank(c.week, p.id) : ""); }).join(""), lc = liveChip(S, p, ctx);
    // Two separate controls, as on Team › Contracts: the player's NAME opens his profile; the rest of the row (club, chips, figures, the weekly strip) opens or closes the performance details.
    var h = '<div class="rw"><button class="nmb" data-act="card" data-pid="' + esc(p.id) + '" aria-label="Open ' + nm + ' profile"><span class="l1">' + nm + " " + pcx(p.pos) + "</span></button>" +
      '<button class="rb" data-act="pfx" data-v="' + esc(p.id) + '" aria-expanded="' + open + '" aria-label="' + (open ? "Hide" : "Show") + " performance details for " + nm + '"><div class="in"><div class="l2">' + esc(F.commonCode(p.nflTeam) || "No NFL team") + ' <span class="chv" aria-hidden="true">Details ' + (open ? "▾" : "▸") + '</span></div><div class="fl">' + startingTag(p) + injuryChip(S, p) + lc.html + "</div>" + statGrid(S, p, ctx) + '<div class="cells4">' + cells + "</div>" +
      (hasCmp ? '<div class="cmpl">' + esc(lab) + '</div><div class="rcn">' + g3 + "</div>" + (shown ? "" : '<div class="ex">' + esc(cmp.text) + "</div>") : "") +
      '<div class="ex">' + esc(row.teamGames && row.teamGames.text ? row.teamGames.text : "") + "</div></div></button>" + (lc.retry ? '<div class="ex"><button class="link" data-act="retryperf">Retry</button></div>' : "");
    if (open) {
      var zero = row.strip.some(function (c) { return c.kind === "score" && c.score === 0; }), newer = row.strip.filter(function (c) { return c.kind === "newer" && c.score != null; });
      h += '<div class="det"><div class="kv"><b>Season</b><span>' + f1(row.seasonAvg) + " · " + esc(row.teamGames && row.teamGames.text ? row.teamGames.text : "") + (row.seasonThrough != null ? " · through Week " + row.seasonThrough : "") + "</span>" +
        (hasCmp ? "<b>Recent</b><span>" + (shown ? f1(row.recent) + " over " + row.recentN + " of 3 scored" : "Not available") + "</span><b>Earlier</b><span>" + (shown ? f1(row.earlier) + " over " + plural(row.earlierN, "scored game", "scored games") : "Not available") + "</span>" : "") +
        "<b>Range</b><span>" + (hasBad ? "Not shown: a score could not be read" : row.range ? f1(row.range.lo) + " to " + f1(row.range.hi) + " (Weeks " + row.range.fromWeek + " to " + row.range.toWeek + ")" : DASH) +
        statFigures(S, p.id, ctx.rank, !!ctx.histOff).detail.map(function (d) { return "</span><b>" + esc(d[0]) + "</b><span>" + esc(d[1]); }).join("") + "</span></div>" +
        (row.teamGames && row.teamGames.of == null && (row.coverage || []).length ? helpHtml(row) : "") +
        '<div class="sec2">Next three weeks</div><div class="nx">' + nextText(S, p, ctx.mu) + "</div>" +
        (hasCmp && (p.pos === "PK" || p.pos === "PN") ? '<div class="note">Kicker and punter scores move a lot from week to week; read the difference with care.</div>' : "") +
        (zero ? '<div class="note">A <b>0.0</b> is a score MFL recorded. It is not proof that he played.</div>' : "") +
        (newer.length ? '<div class="note">Newer score: Week ' + newer[0].week + " " + f1(newer[0].score) + ". Shown, but not in any figure here until team history covers Week " + newer[0].week + ".</div>" : "") +
        "</div>";
    }
    return h + "</div>";
  }

  function performanceBody(S) {
    var t = teamOf(S), c = pfState(S), out = "";
    var ids = t.players.map(function (p) { return p.id; });    var ctx = perfInput(S, ids);
    if (ctx.read === "loading") return '<div class="card rows" aria-busy="true">' + skeleton(6) + '</div><div class="mu ctr sm">Loading scores…</div>';
    if (ctx.read === "completion") {
      var cs = ctx.completion.state;
      if (cs === "loading") return '<div class="card rows" aria-busy="true">' + skeleton(6) + '</div><div class="mu ctr sm">Checking which games are final…</div>';
      if (cs === "none") return '<div class="card"><h2>Performance</h2><div class="ex">No week has been completed yet, so there are no scores to show.</div></div>';
      if (cs === "conflict" && ctx.completion.why) return '<div class="card"><h2>Performance</h2><div class="ex wn">The NFL schedule for Week ' + esc(ctx.completion.week) + ' does not account for every club (games are missing from it), so it cannot be treated as a complete week, and no season figure is shown.</div></div>' + failCard("retryperf");
      return failCard("retryperf"); // no way to say which week is complete: nothing is drawn from the season, nothing is guessed
    }
    if (ctx.read !== "ok") return failCard("retryperf");
    if (!ctx.input.latestFinal) return '<div class="card"><h2>Performance</h2><div class="ex">No week has been completed yet, so there are no scores to show.</div></div>';
    var ev = CH.evaluate(ctx.input);
    ctx.ev = ev; // ctx.mu is the matchup read's data (its horizon gives the next three weeks)
    ctx.histOff = ev.state !== "ok";   // no team history for the whole screen: the per-game rank and the recent comparison do not exist, and that is said ONCE, in the header card
    ctx.rank = rankData(S, ctx);
    ctx.cutoffNote = ev.cutoff != null && ev.cutoff !== ev.latestFinal;
    // ONE compact header card: the completed-games claim (unchanged), the history line (once), and the read notes. Nothing here repeats on a row.
    var vr = verification(S, ctx.input.latestFinal), claim = vr.state === "ok" ? " · completed games" : vr.state === "checking" ? " · checking earlier weeks" : "";   // the claim is made only when every week is confirmed
    var hl = histLine(ev), mixed = Object.keys(ev.rows).some(function (id) { return ev.rows[id].mixedBase; });
    var warn = !!(hl && hl.warn) || vr.state === "unverified" || vr.state === "problems" || ctx.failed;
    out += '<div class="card' + (warn ? " warnc" : "") + '"><b>Season through Week ' + ctx.input.latestFinal + claim + "</b>" + verifyNote(vr, ctx.input.latestFinal) +
      (hl ? '<div class="ex' + (hl.warn ? " wn" : "") + '">' + esc(hl.text) + "</div>" : '<div class="ex">' + esc(ev.banner.text) + (ctx.cutoffNote ? ". A newer score is shown with a dashed cell and is not counted in any figure." : ".") + "</div>") +
      (mixed ? '<div class="ex">For some players a newer or in-progress score could not be separated from the season total, so their season figures run through Week ' + ctx.input.latestFinal + "; those rows say so.</div>" : "") +
      (ctx.failed ? '<div class="ex wn mt4">Some weeks of scores could not be read, so their cells say n/a. <button class="link" data-act="retryperf">Try again</button></div>' : ctx.loading ? '<div class="ex mt4">Loading the latest weeks…</div>' : "") + "</div>";

    var act = t.players.filter(function (p) { return p.status === "active"; });
    function rowOf(p) { return perfRow(S, p, ev.rows[p.id], ctx); }
    function val(p, key) { var r = ev.rows[p.id]; var v = key === "diff" ? (r.cmp.state === "shown" ? r.difference : null) : r.seasonAvg; return v == null ? -1e9 : v; }
    // The sort offers only what applies: By position and Season average always; Difference only when the recent comparison exists for at least one player. A stored sort
    // that is no longer offered falls back to By position.
    var anyDiff = !ctx.histOff && act.some(function (p) { return ev.rows[p.id] && ev.rows[p.id].cmp.state === "shown"; });
    var sorts = PF_SORTS.filter(function (o) { return o[0] !== "diff" || anyDiff; }), cs = sorts.some(function (o) { return o[0] === c.s; }) ? c.s : "pos";
    out += '<div class="lbl">Sort</div><div class="chs" role="group" aria-label="Sort">' + sorts.map(function (o) { return '<button class="ch" data-act="pfs" data-v="' + o[0] + '" aria-pressed="' + (cs === o[0]) + '">' + o[1] + "</button>"; }).join("") + "</div>";
    // Once, for the whole section: a shown rank that is a range can narrow (never per row).
    var shownPlayers = act.concat(["ir", "taxi"].reduce(function (a, k) { return c.res[k] ? a.concat(t.players.filter(function (p) { return p.status === k; })) : a; }, []));
    if (shownPlayers.some(function (p) { return figs(S, p, ctx).range; })) out += '<div class="ex">Ranges can narrow as weeks complete.</div>';
    if (cs === "pos") {
      GROUPS.forEach(function (g) {
        var grp = act.filter(function (p) { return p.pos === g[0]; });
        if (!grp.length) return;
        grp.sort(function (a, b) { return ((b.starter ? 1 : 0) - (a.starter ? 1 : 0)) || (val(b, "avg") - val(a, "avg")) || a.name.localeCompare(b.name); });
        out += '<div class="gh2"><span>' + esc(g[1]) + " · " + plural(grp.length, "player", "players") + "</span><span>" + grp.filter(function (p) { return p.starter; }).length + ' starting</span></div><div class="card rows">' + grp.map(rowOf).join("") + "</div>";
      });
    } else {
      act.sort(function (a, b) { return (val(b, cs) - val(a, cs)) || a.name.localeCompare(b.name); });
      out += '<div class="gh2"><span>' + (cs === "diff" ? "Difference (recent minus earlier), highest first" : "Season average, highest first") + "</span><span>" + act.length + '</span></div><div class="card rows">' + act.map(rowOf).join("") + "</div>";
    }
    [["ir", "Injured reserve"], ["taxi", "Taxi squad"]].forEach(function (o) {
      var grp = t.players.filter(function (p) { return p.status === o[0]; });
      if (!grp.length) return;
      var op = !!c.res[o[0]];
      out += '<button class="gh2 btnrow" data-act="pfres" data-v="' + o[0] + '" aria-expanded="' + op + '"><span>' + esc(o[1]) + " · " + plural(grp.length, "player", "players") + "</span><span>" + (op ? "▾" : "▸") + "</span></button>" + (op ? '<div class="card rows">' + grp.map(rowOf).join("") + "</div>" : "");
    });
    out += '<div class="ex pad">Final games only. 0.0 is a recorded score; ' + DASH + " is no score recorded; BYE is a bye. Starting is this week’s lineup as MFL has it. See Help for how the figures and ranks work.</div>";
    return out;
  }
  // The one line about team history, or null when it is available. "Not served yet" (the read carries no history fields) is not a data problem and says so plainly;
  // any other reason is named, once, here. It never says or implies that a player's own data is missing or wrong.
  var HIST_WHY = { malformed: "the answer was not in the expected form", past_season: "it is not for this season", context_failed: "it could not be built", no_history: "none is recorded", crosswalk_failed: "player records could not be matched", crosswalk_suspect: "player records did not match cleanly" };
  function histLine(ev) {
    if (ev.state === "ok") return null;
    if (ev.reason === "absent") return { text: "Per-game rank and the recent comparison aren’t available yet.", warn: false };
    if (ev.reason === "stale") return { text: ev.banner.text + ", so the per-game rank and the recent comparison are not shown.", warn: true };
    return { text: "Team history unavailable" + (HIST_WHY[ev.reason] ? ": " + HIST_WHY[ev.reason] : "") + ". The per-game rank and the recent comparison are not shown.", warn: true };
  }

  // ============================== profile game log ==============================
  // The profile's last four weeks: Week and Points, with a BYE only where the club is known. No opponent: the preview loads no past schedule.
  // The weeks the full-season game log needs: every week from Week 1 to the latest final week (the four newest are the Performance reads).
  function logWeeks(L) { var w = []; for (var i = 1; i <= L; i++) w.push(i); return w; }
  function gameLog(S, p) {
    var mu = S.intel && S.intel.mu && S.intel.mu[S.model.week];
    if (!mu || mu.state === "loading") return '<div class="ex">Loading the game log…</div>';
    if (mu.state !== "ok") return '<div class="ex wn">The game log could not be read (' + esc(mu.error || "") + '). <button class="link" data-act="retryperf">Try again</button></div>';
    var ctx = perfInput(S, [p.id]);
    if (ctx.read === "completion") return ctx.completion.state === "loading" ? '<div class="ex">Loading the game log…</div>' : ctx.completion.state === "none" ? '<div class="ex">No week has been completed yet.</div>' : failCard("retryperf");
    if (!ctx.input.latestFinal) return '<div class="ex">No week has been completed yet.</div>';
    var L = ctx.input.latestFinal, all = !!(S.profile && S.profile.all), from = all ? 1 : Math.max(1, L - 3);
    var log = CH.logFor(ctx.input, p.id, { fromWeek: from, toWeek: L }).slice().reverse(); // newest first
    var more = "";
    if (L > 4 && !all) more = '<button class="btn blk" data-act="logmore">Show earlier weeks</button>';
    else if (all) {
      var pend = 0, bad = 0; logWeeks(L - 4).forEach(function (w) { var r = scoresOf(S)[w]; if (!r || r.state === "loading") pend++; else if (r.state !== "ok") bad++; });
      more = pend ? '<div class="ex">Loading earlier weeks… (' + pend + " to go)</div>" : bad ? '<div class="ex wn">' + plural(bad, "earlier week", "earlier weeks") + ' could not be read and show n/a. <button class="link" data-act="retrylog">Try again</button></div>' : '<div class="ex">Showing Weeks 1 to ' + L + ". <button class=\"link\" data-act=\"logless\">Show fewer</button></div>";
    }
    var rows = log.map(function (r) {
      var cell = (r.kind === "unreadable" || r.bad) ? '<span class="mu">unreadable</span>' : r.kind === "score" ? "<b>" + f1(r.score) + "</b>" : r.kind === "newer" ? (r.score == null ? '<span class="mu">' + DASH + "</span>" : "<b>" + f1(r.score) + '</b> <span class="mu sm">newer</span>') : r.kind === "bye" ? '<span class="mu">BYE</span>' : r.kind === "live" ? (r.score == null ? '<span class="mu">' + DASH + "</span>" : "<b>" + f1(r.score) + '</b> <span class="mu sm">live</span>') : r.kind === "unreadable" ? '<span class="mu">unreadable</span>' : r.kind === "unloaded" ? '<span class="mu">' + (scoresOf(S)[r.week] && scoresOf(S)[r.week].state === "error" ? "n/a" : "…") + "</span>" : '<span class="mu">' + DASH + "</span>";
      return "<tr><td>" + r.week + '</td><td class="n">' + cell + "</td></tr>";
    }).join("");
    // the same season figures, through the same week, as Team › Performance (the evidence rules decide which week they run through)
    var row = CH.evaluate(ctx.input).rows[p.id] || {};
    return '<div class="k3"><div><b>' + f1(row.seasonAvg) + "</b><small>Season average</small></div><div><b>" + (row.scoredGames == null ? DASH : row.scoredGames) + "</b><small>Scored games</small></div><div><b>" + (row.seasonThrough == null ? DASH : row.seasonThrough) + "</b><small>Through week</small></div></div>" +
      '<div class="card tbl"><table><tr><th>Wk</th><th class="n">Pts</th></tr>' + rows + "</table></div>" + (((ctx.bad && ctx.bad[p.id]) || 0) ? '<div class="ex wn">' + plural(ctx.bad[p.id], "score", "scores") + " could not be read, so his season figures are not shown.</div>" : "") +
      more + '<div class="ex">' + (all ? "The full season, newest first. " : "The latest four weeks. ") + '0.0 is a score MFL recorded; ' + DASH + " is no score recorded. BYE appears only where the club is known. Opponents, snaps and lineup status are not in this preview.</div>";
  }

  return { rankData: rankData, completion: completion, contractsBody: contractsBody, performanceBody: performanceBody, gameLog: gameLog, screenHelp: screenHelp, failCard: failCard, capCard: capCard, ctNextSort: ctNextSort, guarantee: guarantee, cutWords: cutWords, perfInput: perfInput, weeksFor: weeksFor, logWeeks: logWeeks, throughOf: throughOf, kmoney: kmoney, coverFor: coverFor, verification: verification, staleScores: staleScores };
});
