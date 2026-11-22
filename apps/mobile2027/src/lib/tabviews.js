/* UPS 2027 R3: the bodies of Team › Contracts and Team › Performance, and the profile's game log. Pure functions of the state object
   (no network, no storage, no DOM), drawn as HTML strings like views.js. Every piece of text that comes from a data source goes through esc().

   Rules this file keeps (owner rulings, 2026-11-21; scope record on #1475):
   - Contracts: labels and sorts follow the season the roster read reports (no year is written in this file); the salary columns are as many as
     the longest contract left; no points per game and no position rank anywhere; "Recorded salary, not cap space" and no link into Cap & picks.
   - The Guarantee left column holds ONLY guarantee values (Loading, an amount, "$0 fully earned" from a calculated zero, Not tracked, Under
     review, Unavailable). A cut charge is drawn only under "If cut now". A missing or failed read never draws $0.
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
  function ctState(S) { var c = S.ct || {}; return { f: c.f || "all", s: c.s || "end", open: c.open || {} }; }

  // one player's salary for the k-th remaining year: a number, null (a year with no recorded amount) or undefined (the contract has ended)
  function salaryAt(p, season, k) {
    var sch = C.schedule(p, season);
    return k < sch.rows.length ? sch.rows[k].amount : undefined;
  }
  function longest(team) { return team.players.reduce(function (m, p) { return Math.max(m, p.years || 0); }, 0); }

  function penaltyOf(S, id) { var d = S.penalty && S.penalty.state === "ok" ? S.penalty.data : null; return d ? d[id] || null : null; }

  // The Guarantee left cell: guarantee values only. { kind, text } with kind in loading | amount | zero | untracked | review | unavailable.
  function guarantee(S, p) {
    var st = S.penalty ? S.penalty.state : "idle";
    if (st === "idle" || st === "loading") return { kind: "loading", text: "Loading…" };
    if (st !== "ok") return { kind: "unavailable", text: "Unavailable" };
    var row = penaltyOf(S, p.id);
    if (!row) return { kind: "unavailable", text: "Unavailable" };
    if (row.needs_review) return { kind: "review", text: "Under review", why: F.str(row.review_reason) };
    var e = C.earned(row);
    if (e.kind === "rule" || e.kind === "na") return { kind: "untracked", text: "Not tracked", rule: e.kind };
    var rg = C.remainingGuarantee(row);
    if (rg == null) return { kind: "unavailable", text: "Unavailable", noFigure: true }; // the read worked but gave no remaining-guarantee figure for this contract
    return rg === 0 ? { kind: "zero", text: "$0 fully earned", rg: 0, row: row, earned: e.amount } : { kind: "amount", text: money(rg), rg: rg, row: row, earned: e.amount };
  }
  function gcell(g) { return g.kind === "loading" ? '<span class="mu">' + esc(g.text) + "</span>" : g.kind === "unavailable" || g.kind === "review" ? '<span class="wn">' + esc(g.text) + "</span>" : "<b>" + esc(g.text) + "</b>"; }

  function guaranteeWords(S, p, g) {
    var wk = S.penalty && S.penalty.meta ? S.penalty.meta.earnedThroughWeek : null;
    if (g.kind === "loading") return "Loading…";
    if (g.kind === "unavailable") return g.noFigure ? "No remaining-guarantee figure for this contract." : "Couldn’t load this.";
    if (g.kind === "review") return "Under review." + (g.why ? " " + esc(g.why) + "." : "");
    if (g.kind === "untracked") return g.rule === "na" ? "Not tracked. A one-year waiver pickup of $4K or less has no weekly guarantee." : "Not tracked. A contract paying the same small amount every year has no weekly guarantee (the full-year rule).";
    var of = isFinite(g.row.guaranteed) ? " of " + money(g.row.guaranteed) + " guaranteed" : "";
    return (g.kind === "zero" ? "$0, fully earned" : money(g.rg)) + of + (isFinite(g.earned) ? ", " + money(g.earned) + " earned" + (wk != null ? " through Week " + wk : "") : "");
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
    var cmp = {
      end: function (a, b) { return ((a.years || 0) - (b.years || 0)) || ((sal(b, 0) || 0) - (sal(a, 0) || 0)) || a.name.localeCompare(b.name); },
      y0: function (a, b) { return ((sal(b, 0) || 0) - (sal(a, 0) || 0)) || a.name.localeCompare(b.name); },
      y1: function (a, b) { return ((sal(b, 1) || 0) - (sal(a, 1) || 0)) || ((sal(b, 0) || 0) - (sal(a, 0) || 0)) || a.name.localeCompare(b.name); },
      name: function (a, b) { return a.name.localeCompare(b.name); }
    }[c.s] || null;
    if (!cmp) cmp = function (a, b) { return a.name.localeCompare(b.name); };
    list = list.slice().sort(cmp);

    // the totals card: recorded salary only
    var tot = [], cnt = [], missing = [], k;
    for (k = 0; k < ny; k++) { tot.push(0); cnt.push(0); missing.push(0); }
    list.forEach(function (p) { for (var i = 0; i < ny; i++) { var v = sal(p, i); if (v === undefined) continue; if (v == null) missing[i]++; else { tot[i] += v; cnt[i]++; } } });
    var cols = "g" + (ny + 1), tcols = "t" + ny;
    out += capCard(S, t) + yearsCard(S, t);
    out += '<div class="card"><h2>Recorded salary, not cap space</h2><div class="trow ' + tcols + '">' + tot.map(function (v, i) { return "<b>" + (cnt[i] ? kmoney(v) : DASH) + "</b>"; }).join("") + "</div>" +
      '<div class="trow ' + tcols + ' mu">' + tot.map(function (v, i) { return "<span>" + (season + i) + "</span>"; }).join("") + "</div>" +
      '<div class="ex mt4">' + plural(list.length, "player", "players") + " shown." +
      (missing.some(function (n) { return n > 0; }) ? " A year with no recorded amount is left out of its total." : "") + "</div></div>";

    out += '<div class="lbl">Show</div><div class="chs" role="group" aria-label="Show">' + CT_FILTERS.map(function (o) { return '<button class="ch" data-act="ctf" data-v="' + o[0] + '" aria-pressed="' + (c.f === o[0]) + '">' + o[1] + "</button>"; }).join("") + "</div>";
    var sorts = [["end", "Ends after"], ["y0", "Salary " + season]]; if (ny > 1) sorts.push(["y1", "Salary " + (season + 1)]); sorts.push(["name", "Name"]);
    out += '<div class="lbl">Sort</div><div class="chs" role="group" aria-label="Sort">' + sorts.map(function (o) { return '<button class="ch" data-act="cts" data-v="' + o[0] + '" aria-pressed="' + (c.s === o[0]) + '">' + o[1] + "</button>"; }).join("") + "</div>";

    out += '<div class="thead ' + cols + '"><span>Guarantee left</span>' + tot.map(function (v, i) { return "<span>" + (season + i) + "</span>"; }).join("") + "</div>";

    function rowHtml(p) {
      var open = !!c.open[p.id], g = guarantee(S, p), sch = C.schedule(p, season);
      var meta = [esc(p.pos), esc(F.commonCode(p.nflTeam) || "No NFL team"), esc(p.type || "Type not recorded"), p.years ? plural(p.years, "yr left", "yrs left") : "no years recorded"].join(" · ") + esc(R.capNote(p));
      var cells = '<span class="g">' + gcell(g) + "</span>";
      for (var i = 0; i < ny; i++) { var v = sal(p, i); cells += "<span>" + (v === undefined ? '<span class="mu">' + DASH + "</span>" : v == null ? '<span class="wn">n/r</span>' : kmoney(v)) + "</span>"; }
      var h = '<div class="rw"><button class="rb" data-act="ctx" data-v="' + esc(p.id) + '" aria-expanded="' + open + '"><span class="l1">' + esc(p.name) + (p.status === "ir" ? " " + chip("", "IR") : p.status === "taxi" ? " " + chip("", "Taxi") : "") + '</span><span class="l2">' + meta + '</span><span class="cells ' + cols + '">' + cells + "</span></button>";
      if (open) {
        var rows = "";
        for (var j = 0; j < sch.rows.length; j++) rows += "<span>" + sch.rows[j].year + "</span><span>" + (j === 0 ? "this season" : "future") + "</span><span>" + (sch.rows[j].amount == null ? "Not recorded" : money(sch.rows[j].amount)) + "</span>";
        if (sch.option) rows += "<span>" + sch.option.year + "</span><span>option year</span><span>" + money(sch.option.amount) + "</span>";
        var gtd = g.row && isFinite(g.row.guaranteed) ? money(g.row.guaranteed) : sch.parsed.gtd != null ? money(sch.parsed.gtd) + " (as recorded)" : "Not recorded";
        h += '<div class="det"><div class="sec2 first">Salary by year</div><div class="yrl">' + (rows || '<span class="mu">No remaining years recorded</span>') + "</div>" +
          taxiLine(S, p) + '<div class="kv"><b>Type</b><span>' + esc(p.type || "Not recorded") + "</span><b>Recorded guarantee</b><span>" + gtd + "</span><b>Remaining guarantee</b><span>" + guaranteeWords(S, p, g) + "</span><b>If cut now</b><span>" + cutWords(S, p) + "</span></div>" +
          '<button class="link" data-act="card" data-pid="' + esc(p.id) + '">Open ' + esc(p.name) + "’s profile</button></div>";
      }
      return h + "</div>";
    }
    if (!list.length) out += '<div class="ex pad">No players in this group.</div>';
    else if (c.s === "end") {
      for (var yl = 1; yl <= ny; yl++) {
        var grp = list.filter(function (p) { return (p.years || 0) === yl; });
        if (!grp.length) continue;
        var sum = 0, any = false; grp.forEach(function (p) { var v = sal(p, 0); if (v != null) { sum += v; any = true; } });
        out += '<div class="gh2"><span>Ends after <b>' + (season + yl - 1) + "</b> · " + plural(grp.length, "player", "players") + "</span><span>" + (any ? kmoney(sum) + " in " + season : DASH) + '</span></div><div class="card rows">' + grp.map(rowHtml).join("") + "</div>";
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
      return h("Cap charge", "What counts against the cap this season. Not cap room.") +
        h("Commitments by year", "This season gives injured-reserve players half relief and taxi players $0. <b>Planning assumption for later years:</b> players now on taxi stay on taxi ($0) and injured-reserve players count at full scheduled salary. No injury relief is projected. Adjustments are the ones recorded for that year; “not recorded” is not $0.") +
        h("Taxi", "A taxi-eligible player can be released with a $0 cut charge while taxi eligibility applies. Releasing ends eligibility.") +
        h("Where the numbers come from", "Contracts as recorded on MFL" + (asOf ? " (as of " + esc(asOf) + ")" : "") + ". Earned, guarantee and cut charge: the UPS cap calculation" + (wk != null ? " through Week " + esc(wk) : "") + ".") +
        h("Symbols", esc(DASH) + " contract ended · n/r no amount recorded.") +
        h("Adjustments", "Cut Penalty, Traded Salary (including three-team settlements), FA Auction Fine, Rounding. Other is a posted adjustment that fits none of them; its reason is not guessed. “Player Unknown” means no authoritative player ID is available for that charge.") +
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
  function itemRows(items, withPlayer) {
    return items.map(function (it) {
      var who = withPlayer ? (it.playerName ? esc(it.playerName) : esc(A.UNKNOWN_PLAYER)) : DASH;
      return '<div class="cl"><span>' + who + " · " + it.season + "</span><b>" + smoney(it.amount) + "</b></div>";
    }).join("");
  }
  function categoryLines(S, adj, cat) {
    var out = "";
    A.CATEGORIES.forEach(function (cname) {
      var rows = adj.items.filter(function (it) { return it.category === cname; });
      if (!rows.length) return;
      var open = !!(S.ct && S.ct.cat && S.ct.cat[cat + cname]);
      out += '<div class="cl"><button class="link" data-act="ctcat" data-v="' + esc(cat + cname) + '" aria-expanded="' + open + '">' + esc(cname) + " " + (open ? "▾" : "▸") + "</button><b>" + smoney(adj.byCategory[cname]) + "</b></div>";
      if (open) out += '<div class="det">' + itemRows(rows, cname === "Cut Penalty") + '<div class="cl"><span class="mu">Total</span><b>' + smoney(adj.byCategory[cname]) + "</b></div></div>";
    });
    return out;
  }
  function capCard(S, t) {
    var season = S.model.season, b = t.cap ? A.capBreakdown(t, t.cap) : null;
    if (!b || b.capCharge == null) return '<div class="card"><h2>Cap charge · ' + season + ' season</h2><div class="ex">Unavailable: this roster read did not include the team’s cap total.</div></div>';
    var open = !!(S.ct && S.ct.bd), out = '<div class="card"><h2>Cap charge · ' + season + ' season</h2><div class="big">' + money(b.capCharge) + '</div><div class="ex">Counts against the cap. Not cap room.</div>' +
      '<div><button class="link" data-act="ctbd" aria-expanded="' + open + '">Breakdown ' + (open ? "▾" : "▸") + "</button></div>";
    if (open) {
      var adj = t.adjust, lines = "";
      if (!b.ok) lines = '<div class="ex wn">The salary lines don’t add up to the cap total, so only the total is shown.</div>';
      else {
        lines = '<div class="cl"><span>Recorded salaries, ' + plural(b.recordedN, "player", "players") + "</span><b>" + money(b.recorded) + "</b></div>" +
          (b.taxiN ? '<div class="cl mu"><span>Taxi squad, ' + plural(b.taxiN, "player", "players") + "</span><b>" + MINUS + money(b.taxi) + "</b></div>" : "") +
          (b.irN ? '<div class="cl mu"><span>Injured reserve, ' + plural(b.irN, "player", "players") + " (half counts)</span><b>" + MINUS + money(b.irRelief) + "</b></div>" : "") +
          '<div class="cl"><b>Cap hits</b><b>' + money(b.capHits) + "</b></div>";
        if (adj && adj.reconciled && Math.abs(adj.total - t.cap.adjTotal) < 0.5) lines += categoryLines(S, adj, "y26");
        else if (t.cap.adjTotal) lines += '<div class="cl"><span>Adjustments</span><b>' + smoney(t.cap.adjTotal) + '</b></div><div class="ex wn">Detail unavailable: ' + esc(adj && adj.mismatch ? adj.mismatch : "the adjustments could not be itemized") + ".</div>";
        lines += '<div class="cl"><b>Cap charge</b><b>' + money(b.capCharge) + "</b></div>";
      }
      out += '<div class="det">' + lines + "</div>";
    }
    return out + "</div>";
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
  function yearsCard(S, t) {
    var season = S.model.season, b = t.cap ? A.capBreakdown(t, t.cap) : null;
    var adj0 = t.adjust && t.adjust.reconciled && t.cap && Math.abs(t.adjust.total - t.cap.adjTotal) < 0.5 ? { known: true, total: t.cap.adjTotal, state: "ok" } : { known: false, total: null, state: "unavailable" };
    var adj1 = nextAdj(S, t), ys = A.commitments(t, season, adj0, adj1, 3), out = '<div class="card"><h2>Cap commitments by year</h2>';
    ys.forEach(function (y, i) {
      var head = '<div class="cl"><span>' + y.year + "</span><b>" + (y.total != null ? money(y.total) : DASH) + "</b></div>";
      var sub = "Cap hits " + (y.hitsIncomplete ? "incomplete (" + plural(y.unknownCount, "year amount", "year amounts") + " not recorded)" : money(y.hits));
      if (i === 0) sub += " · adjustments " + (adj0.known ? smoney(adj0.total) : "unavailable");
      else if (i === 1) {
        var ns = S.ns && S.ns.state;
        sub += " · adjustments " + (adj1.known ? smoney(adj1.total) : ns === "loading" ? "loading…" : ns === "error" ? "couldn’t load" : adj1.state === "incomplete" ? "incomplete" : "not loaded");
      } else sub += " · adjustments not recorded";
      if (i === 1) {
        var open = !!(S.ct && S.ct.ns);
        out += '<button class="link blk" data-act="nsx" aria-expanded="' + open + '">' + head + '<span class="ex">' + sub + " " + (open ? "▾" : "▸") + "</span></button>";
        if (open) out += nextDetail(S, t);
      } else out += head + '<div class="ex">' + sub + "</div>";
    });
    return out + '<div class="ex">Future years: taxi players stay on taxi ($0) and injured reserve counts at full salary. See Help.</div></div>';
  }
  function nextDetail(S, t) {
    var ns = S.ns || { state: "idle" }, season = S.model.season + 1;
    if (ns.state === "idle" || ns.state === "loading") return '<div class="det"><div class="ex mu">Loading…</div></div>';
    if (ns.state === "error") return '<div class="det">' + failCard("retryns") + "</div>";
    var p = ns.by && ns.by[t.id];
    if (!p) return '<div class="det"><div class="ex">No ' + season + " adjustments are recorded for this team.</div></div>";
    var out = '<div class="det">';
    if (!p.items.length) out += '<div class="ex">No ' + season + " adjustments recorded yet.</div>";
    else out += categoryLines(S, p, "y27") + '<div class="cl"><b>Total</b><b>' + smoney(p.total) + "</b></div>";
    out += '<div class="ex">Recorded in the UPS ledger, not yet on MFL.</div>';
    if (p.waiting) out += '<div class="ex wn">' + plural(p.waiting, "cut is", "cuts are") + " waiting for a price and not counted.</div>";
    if (p.review) out += '<div class="ex wn">' + plural(p.review, "cut needs", "cuts need") + " review and not counted.</div>";
    if (p.unverified) out += '<div class="ex wn">' + plural(p.unverified, "record", "records") + " could not be verified and not counted.</div>";
    if (!p.reconciled) out += '<div class="ex wn">Detail unavailable: ' + esc(p.mismatch || "the items do not add up") + ".</div>";
    return out + '<div class="ex">What is and isn’t verified yet is in Help.</div></div>';
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

  return { contractsBody: contractsBody, performanceBody: performanceBody, gameLog: gameLog, screenHelp: screenHelp, failCard: failCard, capCard: capCard, yearsCard: yearsCard, guarantee: guarantee, cutWords: cutWords, perfInput: perfInput, weeksFor: weeksFor, logWeeks: logWeeks, throughOf: throughOf, kmoney: kmoney };
});
