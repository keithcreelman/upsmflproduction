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
    req ? require("./adjust.js") : root.UPS2027.adjust
  );
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.UPS2027 = root.UPS2027 || {}; root.UPS2027.tabviews = api; }
})(typeof self !== "undefined" ? self : this, function (F, C, R, CH, A) {
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
      return h("Season", "Figures are as MFL recorded them. 0.0 is a score MFL recorded. " + esc(DASH) + " is no score recorded.") +
        h("Recent scoring", "Compares the last 3 completed team games with the player’s earlier scored games. It needs team history; without it the comparison says so.");
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
  var PF_FILTERS = [["all", "All"], ["starters", "Starters"], ["bench", "Bench"]];
  var PF_SORTS = [["pos", "By position"], ["diff", "Difference"], ["avg", "Season average"]];
  function pfState(S) { var c = S.pf || {}; return { f: c.f || "all", s: c.s || "pos", open: c.open || {}, res: c.res || {} }; }

  // everything clubhist needs, from the state. null while the matchup read (season figures, latest final week, team history) is not in.
  function perfInput(S, ids) {
    var cur = S.model.week, mu = S.intel && S.intel.mu && S.intel.mu[cur];
    if (!mu || mu.state !== "ok") return { read: mu ? mu.state : "loading" };
    var d = mu.data, clubs = {}, byePlayers = [];
    S.model.teams.forEach(function (t) { t.players.forEach(function (p) { byePlayers.push({ club: p.nflTeam, bye: p.bye }); }); });
    ids.forEach(function (id) { var p = S.model.byId[id]; clubs[id] = p ? p.nflTeam : ""; });
    var L = d.latestFinal, scores = {}, weeks = L ? weeksFor(L, throughOf(d)) : [], loading = false, failed = false;
    weeks.forEach(function (w) {
      var r = scoresOf(S)[w];
      if (!r || r.state === "loading") loading = true; else if (r.state === "ok") scores[w] = r.data.scores; else failed = true;
    });
    Object.keys(scoresOf(S)).forEach(function (w) { var r = scoresOf(S)[w]; if (r && r.state === "ok") scores[w] = r.data.scores; });
    var through = d.hist && typeof d.hist.teamHistoryThrough === "number" ? d.hist.teamHistoryThrough : null;
    // The season totals count a player-game only when his game is FINAL. A newer-week score is in the total when that week is over (the lineup
    // week has moved on) or when his club's game that week is final; otherwise it is a live score the total does not hold.
    var newerFinal = { complete: !!(L && cur && L < cur), clubs: {} };
    Object.keys(d.games || {}).forEach(function (c) { newerFinal.clubs[c] = d.games[c].status === "final"; });
    return { read: "ok", mu: d, weeks: weeks, loading: loading, failed: failed,
      input: { through: through, latestFinal: L, hist: d.hist, clubs: clubs, byeOf: CH.clubByeMap(byePlayers), season: d.season || {}, scores: scores, ids: ids, newerFinal: newerFinal } };
  }
  // The weeks to read: the strip (the latest final week and the three before it) plus the look-back of the comparison, which runs from the history
  // coverage week and may need a bye week skipped (cutoff - 3 .. cutoff). With history current that is four weeks; one week behind, five.
  function throughOf(d) { var h = d && d.hist; return h && typeof h.teamHistoryThrough === "number" && h.teamHistoryThrough >= 1 ? h.teamHistoryThrough : null; }
  function weeksFor(L, through) {
    var from = L - 3; if (through != null && through <= L) from = Math.min(from, through - 3);
    var w = []; for (var i = Math.max(1, from); i <= L; i++) w.push(i); return w;
  }

  function scoresOf(S) { return (S.intel && S.intel.scores) || {}; }
  function cellHtml(c, S) {
    var wk = '<i>W' + c.week + "</i>";
    if (c.kind === "bye") return '<span class="cell by">' + wk + "<b>BYE</b></span>";
    if (c.kind === "live") return '<span class="cell newer" title="Game not final">' + wk + '<b>' + (c.score == null ? DASH : f1(c.score)) + "</b><u>live</u></span>";
    if (c.kind === "newer") return '<span class="cell newer" title="Newer than the comparison cutoff">' + wk + '<b>' + (c.score == null ? DASH : f1(c.score)) + '</b><u>newer</u></span>';
    if (c.kind === "score") return '<span class="cell">' + wk + "<b>" + f1(c.score) + "</b></span>";
    if (c.kind === "unloaded") return '<span class="cell">' + wk + '<b class="mu">' + (scoresOf(S)[c.week] && scoresOf(S)[c.week].state === "error" ? "n/a" : "…") + "</b></span>";
    return '<span class="cell">' + wk + "<b>" + DASH + "</b></span>";
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

  function perfRow(S, p, row, ctx) {
    var open = !!pfState(S).open[p.id], cmp = row.cmp, banner = ctx.ev.banner, shown = cmp.state === "shown";
    var lab = "Last 3 team games" + (row.window && typeof row.window.scoredCount === "number" ? " · " + row.window.scoredCount + " of 3 scored" : "");
    var g3 = '<span><i>Recent</i><b>' + (shown ? f1(row.recent) : DASH) + "</b></span><span><i>Earlier</i><b>" + (shown ? f1(row.earlier) + " <small>(" + row.earlierN + ")</small>" : DASH) + "</b></span><span><i>Difference</i><b>" + (shown ? signed(row.difference) : DASH) + "</b></span>";
    var cells = row.strip.map(function (c) { return cellHtml(c, S); }).join("");
    var h = '<div class="rw"><button class="rb" data-act="pfx" data-v="' + esc(p.id) + '" aria-expanded="' + open + '"><div class="in"><div class="l1">' + esc(p.name) + " " + pcx(p.pos) + '</div><div class="l2">' + esc(F.commonCode(p.nflTeam) || "No NFL team") + '</div><div class="fl">' + startingTag(p) + injuryChip(S, p) + '</div><div class="cells4">' + cells + "</div>" +
      '<div class="cmpl">' + esc(lab) + '</div><div class="rcn">' + g3 + "</div>" + (shown ? "" : '<div class="ex">' + esc(cmp.text) + "</div>") +
      '<div class="ex">' + esc(row.teamGames && row.teamGames.text ? row.teamGames.text : "") + "</div></div></button>";
    if (open) {
      var zero = row.strip.some(function (c) { return c.kind === "score" && c.score === 0; }), newer = row.strip.filter(function (c) { return c.kind === "newer" && c.score != null; });
      h += '<div class="det"><div class="kv"><b>Season</b><span>' + f1(row.seasonAvg) + " · " + esc(row.teamGames && row.teamGames.text ? row.teamGames.text : "") + (row.seasonThrough != null ? " · through Week " + row.seasonThrough : "") + "</span>" +
        "<b>Recent</b><span>" + (shown ? f1(row.recent) + " over " + row.recentN + " of 3 scored" : "Not available") + "</span><b>Earlier</b><span>" + (shown ? f1(row.earlier) + " over " + plural(row.earlierN, "scored game", "scored games") : "Not available") + "</span>" +
        "<b>Range</b><span>" + (row.range ? f1(row.range.lo) + " to " + f1(row.range.hi) + " (Weeks " + row.range.fromWeek + " to " + row.range.toWeek + ")" : DASH) + "</span></div>" +
        (row.teamGames && row.teamGames.of == null && (row.coverage || []).length ? helpHtml(row) : "") +
        '<div class="sec2">Next three weeks</div><div class="nx">' + nextText(S, p, ctx.mu) + "</div>" +
        (p.pos === "PK" || p.pos === "PN" ? '<div class="note">Kicker and punter scores move a lot from week to week; read the difference with care.</div>' : "") +
        (zero ? '<div class="note">A <b>0.0</b> is a score MFL recorded. It is not proof that he played.</div>' : "") +
        (newer.length ? '<div class="note">Newer score: Week ' + newer[0].week + " " + f1(newer[0].score) + ". Shown, but not in any figure here until team history covers Week " + newer[0].week + ".</div>" : "") +
        '<button class="link" data-act="card" data-pid="' + esc(p.id) + '">Open ' + esc(p.name) + "’s profile</button></div>";
    }
    return h + "</div>";
  }

  function performanceBody(S) {
    var t = teamOf(S), c = pfState(S), out = "";
    var ids = t.players.map(function (p) { return p.id; });
    var ctx = perfInput(S, ids);
    if (ctx.read === "loading") return '<div class="card rows" aria-busy="true">' + skeleton(6) + '</div><div class="mu ctr sm">Loading scores…</div>';
    if (ctx.read !== "ok") return '<div class="card warnc"><h2>Performance</h2><div class="ex">Season averages and team history could not be read. Nothing is guessed in their place.</div><button class="btn blk" data-act="retryperf">Try again</button></div>';
    if (!ctx.input.latestFinal) return '<div class="card"><h2>Performance</h2><div class="ex">No week has been completed yet, so there are no scores to show.</div></div>';
    var ev = CH.evaluate(ctx.input);
    ctx.ev = ev; // ctx.mu is the matchup read's data (its horizon gives the next three weeks)
    ctx.cutoffNote = ev.cutoff != null && ev.cutoff !== ev.latestFinal;
    // banner
    var b = ev.banner, why;
    if (ev.state === "ok") why = "Every figure on this screen (season average, scored games and comparisons) is through Week " + ev.cutoff + (ev.cutoff !== ev.latestFinal ? ". A newer score is shown with a dashed cell and is not counted in any figure." : ".");
    else if (ev.reason === "stale") why = "Team history is behind, so no comparison is drawn. Scores and season averages still run through Week " + ev.latestFinal + ".";
    else why = "Without team history the comparison is withheld. Scores, season averages and scored games are shown as MFL recorded them, through Week " + ev.latestFinal + ".";
    var mixed = Object.keys(ev.rows).some(function (id) { return ev.rows[id].mixedBase; });
    if (mixed) why += " For some players a newer or in-progress score could not be separated from the season total, so their season figures run through Week " + ev.latestFinal + "; those rows say so.";
    out += '<div class="card' + (ev.state === "ok" ? " okc" : " warnc") + '"><b>' + esc(b.text) + '</b><div class="ex">' + esc(why) + "</div>" +
      (ctx.failed ? '<div class="ex wn mt4">Some weeks of scores could not be read, so their cells say n/a. <button class="link" data-act="retryperf">Try again</button></div>' : ctx.loading ? '<div class="ex mt4">Loading the latest weeks…</div>' : "") + "</div>";
    out += '<div class="lbl">Show</div><div class="chs" role="group" aria-label="Show">' + PF_FILTERS.map(function (o) { return '<button class="ch" data-act="pff" data-v="' + o[0] + '" aria-pressed="' + (c.f === o[0]) + '">' + o[1] + "</button>"; }).join("") + "</div>";
    out += '<div class="lbl">Sort</div><div class="chs" role="group" aria-label="Sort">' + PF_SORTS.map(function (o) { return '<button class="ch" data-act="pfs" data-v="' + o[0] + '" aria-pressed="' + (c.s === o[0]) + '">' + o[1] + "</button>"; }).join("") + "</div>";

    var act = t.players.filter(function (p) { return p.status === "active"; });
    if (c.f === "starters") act = act.filter(function (p) { return p.starter; });
    if (c.f === "bench") act = act.filter(function (p) { return !p.starter; });
    function rowOf(p) { return perfRow(S, p, ev.rows[p.id], ctx); }
    function val(p, key) { var r = ev.rows[p.id]; var v = key === "diff" ? (r.cmp.state === "shown" ? r.difference : null) : r.seasonAvg; return v == null ? -1e9 : v; }
    if (c.s === "pos") {
      GROUPS.forEach(function (g) {
        var grp = act.filter(function (p) { return p.pos === g[0]; });
        if (!grp.length) return;
        grp.sort(function (a, b) { return ((b.starter ? 1 : 0) - (a.starter ? 1 : 0)) || (val(b, "avg") - val(a, "avg")) || a.name.localeCompare(b.name); });
        out += '<div class="gh2"><span>' + esc(g[1]) + " · " + plural(grp.length, "player", "players") + "</span><span>" + grp.filter(function (p) { return p.starter; }).length + ' starting</span></div><div class="card rows">' + grp.map(rowOf).join("") + "</div>";
      });
    } else {
      act.sort(function (a, b) { return (val(b, c.s) - val(a, c.s)) || a.name.localeCompare(b.name); });
      out += '<div class="gh2"><span>' + (c.s === "diff" ? "Difference (recent minus earlier), highest first" : "Season average, highest first") + "</span><span>" + act.length + '</span></div><div class="card rows">' + act.map(rowOf).join("") + "</div>";
    }
    if (c.f === "all") [["ir", "Injured reserve"], ["taxi", "Taxi squad"]].forEach(function (o) {
      var grp = t.players.filter(function (p) { return p.status === o[0]; });
      if (!grp.length) return;
      var op = !!c.res[o[0]];
      out += '<button class="gh2 btnrow" data-act="pfres" data-v="' + o[0] + '" aria-expanded="' + op + '"><span>' + esc(o[1]) + " · " + plural(grp.length, "player", "players") + "</span><span>" + (op ? "▾" : "▸") + "</span></button>" + (op ? '<div class="card rows">' + grp.map(rowOf).join("") + "</div>" : "");
    });
    out += '<div class="ex pad">Final games only. 0.0 is a recorded score; ' + DASH + " is no score recorded; BYE is a bye. Last 3 team games are the player’s last 3 games his club played; earlier is his scored games before them. The difference is recent minus earlier and needs 4 earlier scored games. This describes scoring; it is not a forecast. Starting is this week’s lineup as MFL has it. A figure is withheld only when the evidence it needs is missing, and the row says why.</div>";
    return out;
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
      var cell = r.kind === "score" ? "<b>" + f1(r.score) + "</b>" : r.kind === "newer" ? (r.score == null ? '<span class="mu">' + DASH + "</span>" : "<b>" + f1(r.score) + '</b> <span class="mu sm">newer</span>') : r.kind === "bye" ? '<span class="mu">BYE</span>' : r.kind === "live" ? (r.score == null ? '<span class="mu">' + DASH + "</span>" : "<b>" + f1(r.score) + '</b> <span class="mu sm">live</span>') : r.kind === "unloaded" ? '<span class="mu">' + (scoresOf(S)[r.week] && scoresOf(S)[r.week].state === "error" ? "n/a" : "…") + "</span>" : '<span class="mu">' + DASH + "</span>";
      return "<tr><td>" + r.week + '</td><td class="n">' + cell + "</td></tr>";
    }).join("");
    // the same season figures, through the same week, as Team › Performance (the evidence rules decide which week they run through)
    var row = CH.evaluate(ctx.input).rows[p.id] || {};
    return '<div class="k3"><div><b>' + f1(row.seasonAvg) + "</b><small>Season average</small></div><div><b>" + (row.scoredGames == null ? DASH : row.scoredGames) + "</b><small>Scored games</small></div><div><b>" + (row.seasonThrough == null ? DASH : row.seasonThrough) + "</b><small>Through week</small></div></div>" +
      '<div class="card tbl"><table><tr><th>Wk</th><th class="n">Pts</th></tr>' + rows + "</table></div>" +
      more + '<div class="ex">' + (all ? "The full season, newest first. " : "The latest four weeks. ") + '0.0 is a score MFL recorded; ' + DASH + " is no score recorded. BYE appears only where the club is known. Opponents, snaps and lineup status are not in this preview.</div>";
  }

  return { contractsBody: contractsBody, performanceBody: performanceBody, gameLog: gameLog, screenHelp: screenHelp, failCard: failCard, capCard: capCard, ctNextSort: ctNextSort, guarantee: guarantee, cutWords: cutWords, perfInput: perfInput, weeksFor: weeksFor, logWeeks: logWeeks, throughOf: throughOf, kmoney: kmoney };
});
