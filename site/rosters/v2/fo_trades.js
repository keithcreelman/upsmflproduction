/* Front Office → Trades → Trade finder (#1338). Read-only: every team's lineup
   strength side by side, and a team view with where it is strong and short, its
   cap room and future picks, and bench players who would start elsewhere. It
   never grades a trade, ranks partners, proposes a swap or sends anything
   (Keith 2026-10-22: partner rankings and suggested swaps are held back until
   they're improved).

   THE TABLE IS THE OVERVIEW'S CARD FOR ALL 12 TEAMS. Same controls (By
   Position / By Lineup Slot; PPG / Rank / Above Replacement / Index), same
   default (By Position, PPG), and every cell is lineup_strength.cell() on the
   same model object (H.leagueModel), so a team's number here equals the
   Overview's for the same view. Starter Mix is a separate view: recorded starts
   from the lineups submitted to MFL (site/shared/starter_mix.js via
   H.starterMix), not the modeled lineup.

   TEAM VIEW: a popup (a bottom sheet on phones) over the table, which never
   moves; closing returns focus to the same View button (Keith 2026-10-22).
     Standing by position: PPG, league average, the gap and rank (Top 3 /
       Bottom 3); each position expands to its modeled starters (RB1, RB2,
       Flex…), an order by season PPG — not slots MFL recorded.
     Cap room: the Front Office cap engine (UPS_FO.capFor), as on Overview.
     Picks: MFL's futureDraftPicks, grouped by year and round. "Well stocked"
       is said only when MFL's list for the year is complete (teams × rounds)
       and that team's lineup-penalty forfeits were checked (today: the
       viewer's own team, /api/franchise-assets) — otherwise the counts and the
       league comparison are shown without the label.
     Surplus: trade_fit's surplus (a healthy bench player who would start for
       another team, with that team's lineup gain). Analysis only — it says
       nothing about whether the owner would move the player.

   LINEUP GAINS (Keith 2026-10-28): under the table, for the viewer's team,
   trade_fit.lineupGains on the same model: players on other teams whose
   addition alone would raise MY modeled lineup, and my available players
   whose addition alone would raise another team's, each with the team, season
   PPG and the gain in points a week (lineup with − lineup without). Only gains
   of GAIN_MIN (1.0 pt a week) or more. Lineup math only: no exchange is
   suggested and nothing says an owner would deal. Computed once per model.
   "How to use this page" is a collapsed guide at the top of the finder.
*/
(function (root) {
  "use strict";

  var H, FO, DATA, TF, LS;
  // Same defaults as the Overview's card (Keith 2026-10-21): By Position, PPG.
  var view = { by: "position", measure: "ppg", sort: "ALL", mixSort: "" };
  var sel = { team: "" };
  // Trades has two views: the Trade builder (default; fo_trade_builder.js) and the Trade finder (unchanged).
  var mode = "builder";
  var MODES = [["builder", "Trade builder"], ["finder", "Trade finder"]];
  function modeChips() { return '<div class="fo-choice-row"><div class="fo-choice-group"><div class="fo-choice-label" id="fo-lbl-trmode">Trades view</div><div class="fo-subview-chips fo-choice fo-tf-mode" role="group" aria-labelledby="fo-lbl-trmode">' + chips(MODES, "data-tf-mode", mode) + "</div></div></div>"; }
  var tableMemo = { model: null, tables: {} };
  var GLABEL = { PK: "K", PN: "P" };
  var BY = [["position", "By Position"], ["slot", "By Lineup Slot"], ["mix", "Starter Mix"]];
  var MEASURES = [["ppg", "PPG"], ["rank", "Rank"], ["above", "Above Replacement"], ["index", "Index"]];
  var MEASURE_TEXT = {
    ppg: "Modeled starters’ points a week (season PPG).",
    rank: "1st–12th among the league by those points a week.",
    above: "Points a week above the replacement-level free agent (0 = replacement level).",
    index: "Points a week ÷ the league average × 100 (100 = average)."
  };
  var BY_TEXT = {
    position: "Modeled lineup, each starter at his own position (a TE in Flex counts as TE).",
    slot: "Modeled lineup by the slot each starter fills in MFL’s lineup settings (a second TE is Flex, a second QB is Superflex)."
  };
  var STRONG_RANK = 3;   // Top 3 / Bottom 3 by PPG

  function gl(g) { return GLABEL[g] || g; }
  function myFid() {
    var me = FO.viewerFid();
    return me && FO.teams().some(function (t) { return t.fid === me; }) ? me : "";
  }
  function strengthTable(m, by) {
    if (tableMemo.model !== m) tableMemo = { model: m, tables: {} };
    return tableMemo.tables[by] || (tableMemo.tables[by] = LS.build(m, { by: by }));
  }
  function median(list) {
    var a = list.slice().sort(function (x, y) { return x - y; });
    if (!a.length) return null;
    var k = Math.floor(a.length / 2);
    return a.length % 2 ? a[k] : (a[k - 1] + a[k]) / 2;
  }
  function baitPlayers() {
    var e = DATA.get("tradeBait"), out = {};
    if (!e || e.state !== "ok") return out;
    H.asArray(e.data.tradeBaits && e.data.tradeBaits.tradeBait).forEach(function (tb) {
      String(tb.willGiveUp || "").split(",").forEach(function (id) { id = id.trim(); if (/^\d+$/.test(id)) out[id] = H.pad4(tb.franchise_id); });
    });
    return out;
  }
  function chips(list, attr, current) {
    return list.map(function (x) {
      return '<button type="button" class="fo-subview-chip' + (x[0] === current ? " active" : "") + '" ' + attr + '="' + x[0] + '" aria-pressed="' + (x[0] === current) + '">' + H.esc(x[1]) + "</button>";
    }).join("");
  }
  function viewButton(f, name) {
    return '<button type="button" class="fo-tf-view" data-tf-view="' + H.esc(f) + '" aria-label="View ' + H.esc(name) + '"' + (sel.team === f ? ' aria-pressed="true"' : "") + ">View</button>";
  }

  // ── The all-team strength table (modeled lineup) ───────────────────
  // A sortable value for one cell: higher is better for every measure (rank is inverted).
  function sortValue(c, measure) {
    if (!c) return -Infinity;
    if (measure === "rank") return -c.rank;
    if (measure === "index") return c.index == null ? -Infinity : c.index;
    return measure === "above" ? c.above : c.ppg;
  }
  // The league-average reference for one column in the current measure (the table's footer row).
  function leagueRef(tb, r) {
    var L = tb.league[r];
    if (view.measure === "index") return "100";
    if (view.measure === "rank") return "—";
    var v = view.measure === "above" ? L.meanAbove : L.meanPpg;
    if (v == null) return "—";
    var x = Math.round(v * 10) / 10;
    return view.measure === "above" ? (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x).toFixed(1) : x.toFixed(1);
  }
  function playerName(pid) { var r = H.rosterIndex()[String(pid)]; return r ? r.p.name : String(pid); }
  function strengthHtml(m, me) {
    var tb = strengthTable(m, view.by);
    var cols = tb.rows;
    if (cols.indexOf(view.sort) === -1) view.sort = "ALL";
    var order = tb.order.slice().sort(function (a, b) {
      return (sortValue(tb.teams[b][view.sort], view.measure) - sortValue(tb.teams[a][view.sort], view.measure)) || (m.teams[b].total - m.teams[a].total);
    });
    var head = '<tr><th scope="col" class="fo-tf-teamcol">Team</th>' + cols.map(function (r) {
      return '<th scope="col" class="num' + (r === "PK" || r === "PN" ? " fo-tf-kp" : "") + (view.sort === r ? " fo-tf-sorted" : "") + '" aria-sort="' + (view.sort === r ? "descending" : "none") + '"><button type="button" class="fo-tf-sort" data-tf-sort="' + r + '" title="Sort by ' + H.esc(tb.labels[r]) + '">' +
        H.esc(tb.labels[r]) + (view.sort === r ? ' <span aria-hidden="true">▾</span>' : "") + "</button></th>";
    }).join("") + '</tr>';
    var body = order.map(function (f) {
      var tr = tb.teams[f], name = m.teams[f].name;
      return '<tr class="' + (f === me ? "fo-tf-me" : "") + (f === sel.team ? " fo-tf-sel" : "") + '" data-tf-team="' + H.esc(f) + '">' +
        '<th scope="row" class="fo-tf-teamcol"><span class="fo-tf-name">' + H.esc(name) + (f === me ? ' <span class="fo-muted">(you)</span>' : "") + "</span>" + viewButton(f, name) + "</th>" +
        cols.map(function (r) {
          var c = LS.cell(tb, f, r, view.measure), n = tr[r].replacementStarters;
          return '<td class="num fo-tf-cell' + (r === "ALL" ? " fo-tf-overall" : "") + (r === "PK" || r === "PN" ? " fo-tf-kp" : "") + (view.sort === r ? " fo-tf-sorted" : "") + '" data-tf-row="' + r + '" title="' + H.esc(tb.labels[r] + ": " + c.title +
            (n ? ". Includes " + n + " replacement-filled slot" + (n === 1 ? "" : "s") : "")) + '">' + H.esc(c.text) + (n ? '<span class="fo-ov-rep" aria-label="includes a replacement-filled slot">*</span>' : "") + "</td>";
        }).join("") +
        "</tr>";
    }).join("");
    var foot = '<tr class="fo-tf-ref"><th scope="row" class="fo-tf-teamcol">League average' + (view.measure === "index" ? " = 100" : "") + "</th>" +
      cols.map(function (r) { return '<td class="num">' + H.esc(leagueRef(tb, r)) + "</td>"; }).join("") + "</tr>";
    var refNote = view.measure === "index" ? " Index: 100 = the league average for that column (the bottom row); 110 = 10% above it." :
      view.measure === "rank" ? "" : " The bottom row is the league average for each column.";
    var aboveNote = view.measure === "above" ? " Overall Above Replacement can differ between By Position (each starter against his own position’s replacement level) and By Lineup Slot (each Flex or Superflex slot’s eligible-player baseline)." : "";
    return '<p class="fo-ov-sub">' + H.esc(BY_TEXT[view.by] + " " + MEASURE_TEXT[view.measure] + refNote + aboveNote) + "</p>" +
      '<div class="fo-table-scroll fo-tf-scroll"><table class="fo-table fo-tf-strength"><thead>' + head + "</thead><tbody>" + body + "</tbody><tfoot>" + foot + "</tfoot></table></div>" +
      '<p class="fo-basis">Every team’s modeled lineup, side by side. Each lineup is the team’s own current roster; <span class="fo-ov-rep">*</span> = a slot no available rostered player can fill, counted at a replacement free agent’s points. Tap a column to sort; <b>View</b> opens a team. On a narrow screen, swipe the table sideways for each position.</p>';
  }

  // ── How to use this page (collapsed by default) ────────────────────
  var guideOpen = false;
  function guideHtml() {
    return '<div class="fo-tf-guidewrap"><button type="button" class="fo-tf-guidebtn" data-tf-guide aria-expanded="' + guideOpen + '" aria-controls="fo-tf-guide">' +
      '<span class="fo-tf-caret" aria-hidden="true">' + (guideOpen ? "▾" : "▸") + "</span> How to use this page</button>" +
      '<div class="fo-tf-guide" id="fo-tf-guide"' + (guideOpen ? "" : " hidden") + "><ul>" +
      "<li><b>The table</b> shows each team’s modeled lineup: its best legal lineup from its own available players, on season PPG. Pick a breakdown and a measure; tap a column to sort. <b>Starter Mix</b> shows the lineups owners actually submitted.</li>" +
      "<li><b>View</b> opens a team: standing by position, cap room, future picks and possible roster surplus.</li>" +
      "<li><b>Possible roster surplus</b> = healthy bench players outside that team’s modeled lineup who would start for another team, on season PPG. It doesn’t mean the owner would move them.</li>" +
      "<li><b>Lineup gains</b> (below the table) = players whose addition would raise your modeled lineup, and your players who would raise another team’s, at +" + H.fmt1(TF.GAIN_MIN) + " pt/week or more.</li>" +
      "</ul></div></div>";
  }

  // ── Lineup gains for the viewer's team (trade_fit.lineupGains, once per model) ──
  var GAIN_ROWS = 10;
  var gainsView = { all: { mine: false, theirs: false }, more: {} };
  var gainsMemo = { model: null, fid: "", out: null };
  function gainsFor(m, me) {
    if (gainsMemo.model !== m || gainsMemo.fid !== me) gainsMemo = { model: m, fid: me, out: TF.lineupGains(m, me) };
    return gainsMemo.out;
  }
  // The player cell: name (opens the player panel), then a second line — so the gain column fits a 320 px phone.
  function gainPlayer(pid, fid, sub, extra) {
    var r = H.rosterIndex()[String(pid)];
    return H.playerButton(pid, fid, H.displayName(playerName(pid))) + (r ? H.injuryChip(r.p) : "") + (extra || "") + '<div class="fo-tf-gsub">' + sub + "</div>";
  }
  function gainGames(pid) { var line = H.seasonLine(pid, 0), g = line && line.games; return g ? " · " + g + " g" : ""; }
  function moreButton(key, attr, open, n) {
    return '<button type="button" class="fo-tf-more" ' + attr + '="' + H.esc(key) + '" aria-expanded="' + open + '">' + (open ? "Show fewer" : n) + "</button>";
  }
  function gainsHtml(m, me) {
    var head = '<div class="fo-card fo-tf-gainscard"><div class="fo-card-head"><h2>Lineup gains for your team</h2><span class="small fo-muted">season PPG · lineup math only</span></div>';
    if (!me) return head + '<p class="fo-ov-empty">Lineup gains are for your own team, and Front Office couldn’t tell which team is yours.</p></div>';
    var G = gainsFor(m, me);
    if (!G) return "";
    var min = H.fmt1(G.minGain);
    var mine = gainsView.all.mine ? G.forMe : G.forMe.slice(0, GAIN_ROWS);
    var rowsA = mine.map(function (x) {
      var g = gainGames(x.pid);
      return '<tr data-tf-gain="' + H.esc(x.pid) + '"><th scope="row">' + gainPlayer(x.pid, x.fid, H.esc(gl(x.group)) + ' · <span class="fo-tf-gfrom">' + H.esc(H.teamName(x.fid)) + "</span>") + '</th><td class="num">' + H.fmt1(x.v) +
        (g ? '<div class="fo-tf-gsub">' + g.slice(3) + "</div>" : "") + '</td><td class="num fo-tf-gain" title="' + H.esc("Would add about +" + H.fmt1(x.gain) + " pts/week to your modeled lineup") + '">+' + H.fmt1(x.gain) + "</td></tr>";
    }).join("");
    var theirs = gainsView.all.theirs ? G.fromMe : G.fromMe.slice(0, GAIN_ROWS);
    var rowsB = theirs.map(function (x) {
      var open = !!gainsView.more[x.pid];
      var list = (open ? x.gains : x.gains.slice(0, 3)).map(function (g) { return '<span class="fo-tf-gteam">' + H.esc(H.teamName(g.fid)) + " <b>+" + H.fmt1(g.gain) + "</b></span>"; }).join(" ");
      var more = x.gains.length > 3 ? " " + moreButton(x.pid, "data-tf-gmore", open, "+" + (x.gains.length - 3) + " more") : "";
      return '<tr data-tf-gain="' + H.esc(x.pid) + '"><th scope="row">' + gainPlayer(x.pid, me, H.esc(gl(x.group)) + ' · <span class="fo-tf-gppg">' + H.fmt1(x.v) + "</span> PPG" + gainGames(x.pid), x.starter ? ' <span class="fo-tf-tag">in your lineup</span>' : "") +
        '</th><td class="fo-tf-gteams">' + list + more + "</td></tr>";
    }).join("");
    var allBtn = function (key, n, open) { return n > GAIN_ROWS ? '<p class="fo-tf-showall">' + moreButton(key, "data-tf-gall", open, "Show all " + n) + "</p>" : ""; };
    return head +
      '<p class="fo-ov-sub">Each gain = your modeled lineup with one player added minus without him, on season PPG (the table’s lineup). Points a week; only +' + min + " or more.</p>" +
      '<h3 class="fo-tf-gh">Players who would improve your lineup</h3>' +
      (rowsA ? '<div class="fo-table-scroll fo-tf-gscroll"><table class="fo-table fo-tf-gt" data-tf-gains="mine"><thead><tr><th scope="col">Player · team</th><th scope="col" class="num">Season PPG</th><th scope="col" class="num" title="Points a week your modeled lineup would gain">Your gain</th></tr></thead><tbody>' + rowsA + "</tbody></table></div>" + allBtn("mine", G.forMe.length, gainsView.all.mine)
        : '<p class="fo-ov-empty">No available player on another team would add +' + min + " pt/week or more to your modeled lineup.</p>") +
      '<h3 class="fo-tf-gh">Your players who would improve theirs</h3>' +
      (rowsB ? '<div class="fo-table-scroll fo-tf-gscroll"><table class="fo-table fo-tf-gt" data-tf-gains="theirs"><thead><tr><th scope="col">Your player · season PPG</th><th scope="col" title="Points a week each team’s modeled lineup would gain">Their gain</th></tr></thead><tbody>' + rowsB + "</tbody></table></div>" + allBtn("theirs", G.fromMe.length, gainsView.all.theirs)
        : '<p class="fo-ov-empty">None of your available players would add +' + min + " pt/week or more to another team’s modeled lineup.</p>") +
      '<p class="fo-basis">Lineup math only: one player added, nothing sent back. It isn’t a trade suggestion and doesn’t say any owner would deal. IR, taxi, Out, K and P aren’t listed; gains under +' + min + " are left out as too small to matter.</p></div>";
  }

  // ── Starter Mix: recorded starts, a separate view ──────────────────
  var MIX_SORTS = { avg: 1, sfqb: 1, weeks: 1 };
  function mixHtml(m, me) {
    var SM = root.UPS_STARTER_MIX, e = DATA.get("weeklyResults"), ss = H.scoring();
    if (!e) { DATA.load("weeklyResults").then(rerender); return '<p class="fo-ov-empty">Reading the lineups MFL has on file…</p>'; }
    if (e.state !== "ok") return H.banner("MFL’s weekly lineups couldn’t be read. Reload to retry.", "warn");
    if (ss && !ss.finalKnown) return '<p class="fo-ov-empty">MFL hasn’t confirmed a completed week yet.</p>';
    var mix = H.starterMix();
    if (!mix || !SM) return '<p class="fo-ov-empty">Reading MFL’s players…</p>';
    if (!mix.weeks.length) return '<p class="fo-ov-empty">No completed weeks yet.</p>';
    var G = SM.GROUPS;
    var wk = mix.weeks.length === 1 ? "Week 1" : "Weeks 1–" + mix.weeks[mix.weeks.length - 1];
    var sfQbN = function (x) { return x.SFLEX && x.SFLEX.total ? (x.SFLEX.by.QB || 0) / x.SFLEX.total * 100 : -1; };
    var sfQb = function (x) { var l = SM.mixList(x.SFLEX).filter(function (y) { return y.g === "QB"; })[0]; return x.SFLEX && x.SFLEX.total ? (l ? l.whole : 0) + "%" : "—"; };
    var flexible = function (x) { return SM.mixList(x.FLEXIBLE).map(function (y) { return y.whole + "% " + SM.label(y.g); }).join(" · ") || "—"; };
    var flexTitle = function (x) {
      var F = x.FLEXIBLE;
      return F && F.total ? "Of " + F.total + " extra RB/WR/TE starts: " + Object.keys(F.by).sort().map(function (g) { return SM.label(g) + " " + F.by[g]; }).join(", ") : "No extra RB/WR/TE starts";
    };
    var key = view.mixSort || "";
    var val = function (f) {
      var t = mix.teams[f];
      if (!t || !t.validWeeks.length) return -Infinity;
      if (key === "sfqb") return sfQbN(t.mix);
      if (key === "weeks") return t.validWeeks.length;
      if (G.indexOf(key) !== -1) return t.avg[key];
      return 0;
    };
    var order = m.order.slice().sort(function (a, b) {
      return (key ? val(b) - val(a) : 0) || (a === me ? -1 : b === me ? 1 : m.teams[a].name.localeCompare(m.teams[b].name));
    });
    var th = function (k, label, title) {
      return '<th scope="col" class="num' + (key === k ? " fo-tf-sorted" : "") + '" aria-sort="' + (key === k ? "descending" : "none") + '"><button type="button" class="fo-tf-sort" data-tf-msort="' + k + '"' + (title ? ' title="' + H.esc(title) + '"' : "") + ">" + H.esc(label) + (key === k ? ' <span aria-hidden="true">▾</span>' : "") + "</button></th>";
    };
    var rows = order.map(function (f) {
      var t = mix.teams[f], name = m.teams[f].name;
      if (!t) return "";
      var ok = t.validWeeks.length;
      return '<tr class="' + (f === me ? "fo-tf-me" : "") + (f === sel.team ? " fo-tf-sel" : "") + '" data-tf-team="' + H.esc(f) + '"><th scope="row" class="fo-tf-teamcol"><span class="fo-tf-name">' + H.esc(name) + (f === me ? ' <span class="fo-muted">(you)</span>' : "") + "</span>" + viewButton(f, name) + "</th>" +
        G.map(function (g) { return '<td class="num' + (key === g ? " fo-tf-sorted" : "") + '">' + (ok ? t.avg[g].toFixed(1) : "—") + "</td>"; }).join("") +
        '<td class="num' + (key === "sfqb" ? " fo-tf-sorted" : "") + '" title="' + H.esc(t.mix.SFLEX ? (t.mix.SFLEX.by.QB || 0) + " of " + t.mix.SFLEX.total + " Superflex starts were a second QB" : "") + '">' + (ok ? sfQb(t.mix) : "—") + "</td>" +
        '<td title="' + H.esc(flexTitle(t.mix)) + '">' + (ok ? H.esc(flexible(t.mix)) : "—") + "</td>" +
        '<td class="num' + (t.issues.length ? " fo-tf-warn" : "") + (key === "weeks" ? " fo-tf-sorted" : "") + '" title="' + H.esc(t.issues.map(function (x) { return "Week " + x.week + ": " + x.text; }).join("; ")) + '">' + ok + " of " + t.weeks + "</td></tr>";
    }).join("");
    var lg = mix.league;
    var leagueRow = '<tr class="fo-tf-ref"><th scope="row" class="fo-tf-teamcol">League average</th>' + G.map(function (g) { return '<td class="num">' + (lg.avg[g] == null ? "—" : lg.avg[g].toFixed(1)) + "</td>"; }).join("") +
      '<td class="num">' + sfQb(lg.mix) + '</td><td title="' + H.esc(flexTitle(lg.mix)) + '">' + H.esc(flexible(lg.mix)) + "</td><td></td></tr>";
    var issues = order.filter(function (f) { return mix.teams[f] && mix.teams[f].issues.length; }).map(function (f) {
      return H.esc(m.teams[f].name) + ": " + mix.teams[f].issues.map(function (x) { return "Week " + x.week + " — " + H.esc(x.text); }).join("; ");
    });
    return '<p class="fo-ls-actual"><b>Actual starter mix</b> · ' + H.esc(wk) + "</p>" +
      '<p class="fo-ov-sub">Starters per week from the lineups submitted to MFL, by each player’s own position: what was started, not the modeled lineup. MFL records who started, not which slot: a second QB can only be Superflex, while extra RB/WR/TE starters count together as <b>Flexible slots</b>.</p>' +
      '<div class="fo-table-scroll fo-tf-scroll"><table class="fo-table fo-tf-strength fo-tf-mix"><thead><tr><th scope="col" class="fo-tf-teamcol">Team</th>' +
      G.map(function (g) { return th(g, SM.label(g), "Sort by " + SM.label(g) + " starters per week"); }).join("") +
      th("sfqb", "Superflex QB", "Share of Superflex starts that were a second QB") +
      '<th scope="col" title="Extra RB/WR/TE starts — those beyond the 2 RB, 2 WR and 1 TE slots, i.e. the Flex starts plus Superflex starts that weren’t a QB. Each position’s share of those starts.">Flexible slots</th>' +
      th("weeks", "Weeks", "Weeks whose lineup filled every slot") + "</tr></thead><tbody>" +
      rows + "</tbody><tfoot>" + leagueRow + "</tfoot></table></div>" +
      '<p class="fo-basis"><b>Flexible slots</b> = each position’s share of a team’s extra RB/WR/TE starts: starters beyond the 2 RB, 2 WR and 1 TE slots, so the Flex starts plus Superflex starts that weren’t a QB (hover a cell for the counts). Tap a column to sort; the league average row stays at the bottom.</p>' +
      (issues.length ? '<div class="fo-ls-issues"><b>Not counted:</b> ' + issues.join(" · ") + "</div>" : "");
  }

  // ── Team view ──────────────────────────────────────────────────────
  // Future picks: { years: [{year, rounds:[1..R], complete, leagueTotal, expected, byFid:{fid:{count, byRound}}}], ok }.
  function pickBook() {
    var e = DATA.get("picks");
    if (!e) return { state: "" };
    if (e.state !== "ok") return { state: "error" };
    var fr = H.asArray(e.data.futureDraftPicks && e.data.futureDraftPicks.franchise);
    var teams = FO.teams().map(function (t) { return t.fid; });
    var years = {};
    fr.forEach(function (row) {
      var fid = H.pad4(row.id);
      H.asArray(row.futureDraftPick).forEach(function (p) {
        var y = String(p.year), r = parseInt(p.round, 10);
        if (!y || !(r >= 1)) return;
        var Y = years[y] = years[y] || { year: y, rounds: {}, byFid: {}, leagueTotal: 0 };
        Y.rounds[r] = 1; Y.leagueTotal += 1;
        var b = Y.byFid[fid] = Y.byFid[fid] || { count: 0, byRound: {} };
        b.count += 1;
        (b.byRound[r] = b.byRound[r] || []).push(H.pad4(p.originalPickFor || fid));
      });
    });
    var list = Object.keys(years).sort().map(function (y) {
      var Y = years[y];
      var rounds = Object.keys(Y.rounds).map(Number).sort(function (a, b) { return a - b; });
      var maxR = rounds.length ? rounds[rounds.length - 1] : 0;
      Y.rounds = []; for (var r = 1; r <= maxR; r++) Y.rounds.push(r);
      Y.expected = teams.length * maxR;
      Y.complete = Y.leagueTotal === Y.expected;
      teams.forEach(function (f) { if (!Y.byFid[f]) Y.byFid[f] = { count: 0, byRound: {} }; });
      return Y;
    });
    return { state: "ok", years: list, teams: teams };
  }
  // The viewer's own forfeits (the only team the Front Office checks; Activity does the same).
  function forfeitsFor(f) {
    var me = myFid();
    if (!me || f !== me) return { known: false, marks: {} };
    var fa = DATA.get("franchiseAssets", me);
    if (!fa || fa.state !== "ok" || !fa.data || fa.data.forfeit_check !== "ok") return { known: false, marks: {} };
    var marks = {};
    H.asArray(fa.data.future_picks).forEach(function (p) { if (p && p.forfeited) marks[String(p.year) + "|" + H.pad4(p.original_fid || p.originalPickFor) + "|" + String(p.round)] = p.forfeit_label || "Forfeited"; });
    return { known: true, marks: marks };
  }
  // Is this team unusually well stocked? Said only on complete data with forfeits checked.
  function pickStock(book, f) {
    var totals = book.teams.map(function (x) { return tot(book, x); });
    var earlyCounts = book.teams.map(function (x) { return early(book, x); });
    var i = book.teams.indexOf(f);
    var med = median(totals), medEarly = median(earlyCounts);
    var mine = totals[i], mineEarly = earlyCounts[i];
    var complete = book.years.length > 0 && book.years.every(function (Y) { return Y.complete; });
    var ff = forfeitsFor(f);
    var high = mine >= med + 2 && mine >= med * 1.5;
    var rank = 1 + totals.filter(function (x) { return x > mine; }).length;
    return { total: mine, early: mineEarly, median: med, medianEarly: medEarly, min: Math.min.apply(null, totals), max: Math.max.apply(null, totals), rank: rank,
      complete: complete, forfeitsKnown: ff.known, high: high, wellStocked: high && complete && ff.known };
  }
  function picksHtml(f) {
    var book = pickBook();
    if (!book.state) return '<p class="fo-ov-empty">Reading MFL’s future picks…</p>';
    if (book.state === "error") return H.banner("MFL’s future picks couldn’t be read.", "warn");
    if (!book.years.length) return '<p class="fo-ov-empty">MFL lists no future picks.</p>';
    var ff = forfeitsFor(f);
    var grid = book.years.map(function (Y) {
      var b = Y.byFid[f];
      return '<div class="fo-tf-pickyear"><div class="fo-tf-pickyr"><b>' + H.esc(Y.year) + "</b> · " + b.count + " pick" + (b.count === 1 ? "" : "s") + "</div>" + Y.rounds.map(function (r) {
        var list = b.byRound[r] || [];
        return '<div class="fo-tf-pickrd"><span class="fo-tf-rd">R' + r + "</span> " + (list.length ? list.map(function (orig) {
          var fk = ff.marks[Y.year + "|" + orig + "|" + r];
          return '<span class="fo-tf-pick">' + (orig === f ? "Own" : "via " + H.esc(H.teamName(orig))) + (fk ? ' <span class="fo-tf-flag bad" title="' + H.esc(fk) + '">forfeited</span>' : "") + "</span>";
        }).join(" ") : '<span class="fo-muted">—</span>') + "</div>";
      }).join("") + (Y.complete ? "" : '<p class="fo-basis warn">MFL’s ' + H.esc(Y.year) + " list has " + Y.leagueTotal + " of " + Y.expected + " picks (" + book.teams.length + " teams × " + Y.rounds.length + " rounds), so these are the known picks only.</p>") + "</div>";
    }).join("");
    var s = pickStock(book, f);
    var verdict;
    if (s.wellStocked) verdict = "<b>Well stocked:</b> " + s.total + " picks, " + (s.rank === 1 ? "the most in the league" : H.esc(rankWord(s.rank)) + " in the league") + " (league median " + fmtN(s.median) + ").";
    else if (s.high && !s.complete) verdict = s.total + " known picks against a league median of " + fmtN(s.median) + ". MFL’s pick list is incomplete, so this isn’t called well stocked.";
    else if (s.high && !s.forfeitsKnown) verdict = s.total + " picks listed by MFL against a league median of " + fmtN(s.median) + ". Lineup-penalty forfeits are only checked for your own team, so this isn’t called well stocked.";
    else verdict = s.total + " picks (league median " + fmtN(s.median) + ", range " + s.min + "–" + s.max + ").";
    var compare = '<details class="fo-tf-compare"><summary>Compare all teams’ picks</summary><div class="fo-table-scroll"><table class="fo-table fo-tf-pickcmp"><thead><tr><th scope="col">Team</th>' +
      book.years.map(function (Y) { return '<th scope="col" class="num">' + H.esc(Y.year) + "</th>"; }).join("") + '<th scope="col" class="num">R1–R2</th><th scope="col" class="num">Total</th></tr></thead><tbody>' +
      book.teams.slice().sort(function (a, b) { return tot(book, b) - tot(book, a) || H.teamName(a).localeCompare(H.teamName(b)); }).map(function (x) {
        return '<tr class="' + (x === f ? "fo-tf-sel" : "") + '"><th scope="row">' + H.esc(H.teamName(x)) + "</th>" + book.years.map(function (Y) { return '<td class="num">' + Y.byFid[x].count + "</td>"; }).join("") +
          '<td class="num">' + early(book, x) + '</td><td class="num"><b>' + tot(book, x) + "</b></td></tr>";
      }).join("") + "</tbody></table></div><p class=\"fo-basis\">Picks MFL lists for each future year. League median " + fmtN(s.median) + " (R1–R2: " + fmtN(s.medianEarly) +
      "). “Well stocked” = at least 2 more than the median and 1.5× it, said only when MFL’s list is complete and the team’s lineup-penalty forfeits were checked.</p></details>";
    return grid + '<p class="fo-tf-verdict">' + verdict + "</p>" + compare;
  }
  function tot(book, x) { return book.years.reduce(function (a, Y) { return a + Y.byFid[x].count; }, 0); }
  function early(book, x) { return book.years.reduce(function (a, Y) { return a + (Y.byFid[x].byRound[1] || []).length + (Y.byFid[x].byRound[2] || []).length; }, 0); }
  function fmtN(n) { return n == null ? "—" : (Math.round(n * 10) / 10).toString(); }
  function rankWord(n) { return LS.ordinal(n); }

  // The team popup's body: standing by position (expandable to the modeled starters), what one addition would do,
  // cap, picks and possible surplus. Rendered into the hub's dialog (a popup on desktop, a bottom sheet on phones).
  function teamHtml(m, f) {
    var tm = m.teams[f];
    if (!tm) return "";
    var pos = strengthTable(m, "position");
    var tr = pos.teams[f], n = pos.order.length;
    var groups = LS.POSITIONS;
    var posRows = groups.map(function (g) {
      var c = tr[g], L = pos.league[g];
      var avg = L.meanPpg || 0, gap = c.ppg - avg;
      var tag = TF.FIT_EXCLUDED_GROUPS[g] ? "" : c.rank <= STRONG_RANK ? ' <span class="fo-tf-tag ok">Top 3</span>' : c.rank > n - STRONG_RANK ? ' <span class="fo-tf-tag need">Bottom 3</span>' : "";
      var starters = LS.modeledStarters(m, f, g);
      var multi = starters.length > 0;
      var detail = starters.map(function (s) {
        return '<li><span class="fo-tf-depth">' + H.esc(s.depth) + "</span> " + (s.rep ? '<span class="fo-muted">replacement free agent</span><span class="fo-ov-rep">*</span>' : '<button type="button" class="fo-plink" data-tf-player="' + H.esc(s.pid) + '" data-tf-fid="' + H.esc(f) + '">' + H.esc(H.displayName(playerName(s.pid))) + "</button>") +
          ' <span class="fo-muted">' + H.fmt1(s.v) + " PPG</span></li>";
      }).join("");
      return '<tr class="' + (TF.FIT_EXCLUDED_GROUPS[g] ? "fo-tf-kp" : "") + '"><th scope="row">' +
        (multi ? '<button type="button" class="fo-tf-expand" data-tf-pos="' + g + '" aria-expanded="false" aria-controls="fo-tf-pos-' + g + '"><span class="fo-tf-caret" aria-hidden="true">▸</span> ' + gl(g) + "</button>" : gl(g)) + tag + "</th>" +
        '<td class="num">' + H.fmt1(c.ppg) + '</td><td class="num">' + H.fmt1(avg) + '</td><td class="num">' + (gap > 0.05 ? "+" : gap < -0.05 ? "−" : "") + Math.abs(Math.round(gap * 10) / 10).toFixed(1) + '</td><td class="num">' + LS.ordinal(c.rank) + "</td></tr>" +
        (multi ? '<tr class="fo-tf-posdetail" id="fo-tf-pos-' + g + '" hidden><td colspan="5"><ul class="fo-tf-depthlist">' + detail + "</ul></td></tr>" : "");
    }).join("");
    var cap = FO.capFor(f);
    var capLine = cap ? '<div class="fo-ov-cap"><div class="fo-ov-capline space ' + (cap.capSpace < 0 ? "neg" : "pos") + '"><span>Cap room</span><span class="fo-ov-capnum">' + H.esc(H.money(cap.capSpace)) + "</span></div>" +
      '<div class="fo-ov-capline"><span>Total allocated</span><span class="fo-ov-capnum">' + H.esc(H.money(cap.capAlloc)) + ' <span class="fo-ov-of">of ' + H.esc(H.money(FO.capCeiling)) + "</span></span></div></div>"
      : '<p class="fo-ov-empty">Cap not loaded.</p>';
    var bait = baitPlayers();
    var surplus = (tm.surplus || []).slice(0, 8).map(function (s) {
      var r = H.rosterIndex()[String(s.pid)];
      var p = r ? r.p : null;
      var line = H.seasonLine(s.pid, 0);
      var helps = s.gains.slice(0, 3).map(function (x) { return H.esc(H.teamName(x.fid)) + " <b>+" + H.fmt1(x.gain) + "</b>"; }).join(", ") + (s.gains.length > 3 ? ' <span class="fo-muted">+' + (s.gains.length - 3) + " more</span>" : "");
      return '<li><button type="button" class="fo-plink" data-tf-player="' + H.esc(s.pid) + '" data-tf-fid="' + H.esc(f) + '">' + H.esc(H.displayName(playerName(s.pid))) + "</button>" + (p ? H.injuryChip(p) : "") + ' <span class="fo-muted">' + H.esc(gl(s.group)) + (line && line.ppg != null ? " · " + H.fmt1(line.ppg) + " PPG" : "") + "</span>" +
        (bait[s.pid] === f ? ' <span class="fo-av fo-av-bait" title="Listed by the owner on MFL’s trading block">On MFL trading block</span>' : "") +
        '<div class="fo-perf-sub">Would start for ' + s.teamsHelped + " team" + (s.teamsHelped === 1 ? "" : "s") + ": " + helps + "</div></li>";
    }).join("");
    var me = myFid();
    return '<div class="fo-tf-team" data-tf-team-view="' + H.esc(f) + '">' +
      '<p class="fo-ov-sub">Modeled lineup: <b>' + H.esc(LS.cell(pos, f, "ALL", "ppg").text) + "</b> pts a week, " + LS.ordinal(tr.ALL.rank) + " of " + n + " (season PPG). " +
      '<a class="fo-go" href="' + H.esc(FO.warRoomUrl(me && me !== f ? { twb_left_team: me, twb_right_team: f } : { twb_left_team: f })) + '" target="_top">Trade War Room ↗</a></p>' +
      '<div class="fo-tf-cols">' +
        "<div><h4>Standing by position</h4>" +
          '<div class="fo-table-scroll"><table class="fo-table fo-tf-pos"><thead><tr><th scope="col">Pos</th><th scope="col" class="num">PPG</th><th scope="col" class="num" title="League average starters’ PPG at the position">Lg avg</th><th scope="col" class="num" title="This team’s PPG minus the league average, points a week">vs avg</th><th scope="col" class="num">Rank</th></tr></thead><tbody>' + posRows + "</tbody></table></div>" +
          '<p class="fo-basis">Modeled lineup, by each starter’s own position, in points a week. Tap a position for its modeled starters (RB1, RB2, Flex…): an order by season PPG, not slots MFL recorded — Starter Mix shows the lineups actually submitted.</p>' +
        "<div><h4>Cap</h4>" + capLine +
          "<h4>Future picks</h4>" + picksHtml(f) + "</div>" +
      "</div>" +
      '<h4 class="fo-tf-h">Possible roster surplus <span class="fo-muted">(analysis)</span></h4>' +
      (surplus ? '<ul class="fo-tf-list">' + surplus + "</ul>" : '<p class="fo-ov-empty">No bench player who would start for another team on today’s numbers.</p>') +
      '<p class="fo-basis">Analysis, not an offer: healthy bench players outside this team’s modeled lineup who would start for another team on season PPG, with how many points a week that team’s lineup would gain. It says nothing about whether the owner would move them; “On MFL trading block” appears only where the owner listed the player on MFL.</p>' +
      "</div>";
  }

  // Open a team in the popup / bottom sheet. Nothing on the page moves; closing returns focus to the same View button.
  function openTeam(m, f) {
    sel.team = f;
    markSelected();
    var me = myFid();
    H.openDialog(m.teams[f].name + (f === me ? " (you)" : ""), teamHtml(m, f), {
      variant: "team",
      returnFocus: function () { var el = document.getElementById("fo-trades-body"); return el ? el.querySelector('[data-tf-view="' + f + '"]') : null; },
      onClose: function () { sel.team = ""; markSelected(); }
    });
  }
  // The selected-team state on the table rows, without re-rendering (the table keeps its scroll position).
  function markSelected() {
    var el = document.getElementById("fo-trades-body");
    if (!el) return;
    Array.prototype.forEach.call(el.querySelectorAll("tr[data-tf-team]"), function (tr) {
      var on = tr.getAttribute("data-tf-team") === sel.team;
      tr.classList.toggle("fo-tf-sel", on);
      var b = tr.querySelector("[data-tf-view]");
      if (b) b.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }
  // Clicks inside the popup: expand a position; open a player (the popup steps aside while the player panel is open
  // and comes back, with focus on the same name, when it closes).
  function wireDialog() {
    var body = document.getElementById("fo-about-body");
    if (!body || body.__tfWired) return;
    body.__tfWired = true;
    body.addEventListener("click", function (e) {
      var t = e.target && e.target.closest ? e.target.closest("[data-tf-pos],[data-tf-player]") : null;
      if (!t || !body.querySelector("[data-tf-team-view]")) return;
      if (t.hasAttribute("data-tf-pos")) {
        var row = document.getElementById("fo-tf-pos-" + t.getAttribute("data-tf-pos"));
        var open = t.getAttribute("aria-expanded") !== "true";
        t.setAttribute("aria-expanded", open ? "true" : "false");
        if (row) row.hidden = !open;
        var caret = t.querySelector(".fo-tf-caret");
        if (caret) caret.textContent = open ? "▾" : "▸";
        return;
      }
      openPlayerFromDialog(t.getAttribute("data-tf-player"), t.getAttribute("data-tf-fid"), t);
    });
  }
  function openPlayerFromDialog(pid, fid, btn) {
    var wrap = document.getElementById("fo-about"), so = document.getElementById("fo-slideover");
    if (!wrap || !FO.openPlayer) return;
    wrap.hidden = true;
    FO.openPlayer(pid, fid, "stats");
    if (!so || typeof MutationObserver === "undefined") return;
    var mo = new MutationObserver(function () {
      if (!so.hidden) return;
      mo.disconnect();
      if (sel.team) { wrap.hidden = false; try { btn.focus({ preventScroll: true }); } catch (e) { btn.focus(); } }
    });
    mo.observe(so, { attributes: true, attributeFilter: ["hidden"] });
  }

  function render() {
    var el = document.getElementById("fo-trades-body");
    if (!el) return;
    H.wireClicks(el);
    if (mode === "builder") { renderBuilder(el); return; }
    var se = DATA.get("scores");
    if (!se || !DATA.get("players")) { H.loading(el, "Reading MFL’s scores and players…"); return; }
    var ss = H.scoring();
    if (!ss) { el.innerHTML = H.banner("MFL’s scores couldn’t be read, so the Trade finder is off. Reload to retry.", "warn"); return; }
    // Never this season's numbers before MFL has scored a week (standing rule for anything citing player value).
    if (!ss.seasonWeeks.length) { el.innerHTML = H.banner("The Trade finder starts once MFL has scored a week this season.", "info"); return; }
    var slotState = H.lineupSlotsState();
    if (!slotState) { H.loading(el, "Reading MFL’s lineup settings…"); return; }
    if (slotState === "error") { el.innerHTML = H.banner("MFL’s lineup settings couldn’t be read, so the Trade finder is off. Reload to retry.", "warn"); return; }
    var m = H.leagueModel(0);
    if (!m) { H.loading(el, "Building the league model…"); return; }
    var me = myFid();
    var F = root.UPS_PLAYER_FACTS, basis = F ? F.basis(ss) : { text: "" };
    var controls = '<div class="fo-choice-row"><div class="fo-choice-group"><div class="fo-choice-label" id="fo-lbl-tfby">Compare by</div>' +
      '<div class="fo-subview-chips fo-choice fo-ls-by" role="group" aria-labelledby="fo-lbl-tfby">' + chips(BY, "data-tf-by", view.by) + "</div></div>" +
      (view.by === "mix" ? "" : '<div class="fo-choice-group"><div class="fo-choice-label" id="fo-lbl-tfms">Measure</div>' +
        '<div class="fo-subview-chips fo-choice fo-ls-views" role="group" aria-labelledby="fo-lbl-tfms">' + chips(MEASURES, "data-tf-measure", view.measure) + "</div></div>") + "</div>";
    // Re-rendering keeps the scroll position of the table box (sorting or a data refresh never jumps the table).
    var box = el.querySelector(".fo-tf-scroll"), sx = box ? box.scrollLeft : 0;
    el.innerHTML = modeChips() + '<div class="fo-card fo-tf-main"><div class="fo-card-head"><h2>Lineup strength, all teams</h2>' +
      '<span class="small fo-muted">Trade finder · values = season PPG per MFL week</span></div>' + guideHtml() +
      '<p class="fo-basis">' + H.esc(basis.text) + "</p>" + controls +
      (view.by === "mix" ? mixHtml(m, me) : strengthHtml(m, me)) + "</div>" + gainsHtml(m, me);
    var nb = el.querySelector(".fo-tf-scroll");
    if (nb && sx) nb.scrollLeft = sx;
    H.setFreshness("MFL read " + H.clock(ss.fetchedAt));
  }

  // The builder keeps its own draft: mount once, then only refresh it when data (picks, rosters) arrives.
  function renderBuilder(el) {
    var TB = root.UPS_FO_TRADE_BUILDER;
    var host = el.querySelector("#fo-tb-host");
    if (host && host.__tbHandle) { host.__tbHandle.refresh(); return; }
    el.innerHTML = modeChips() + '<div id="fo-tb-host"></div>';
    host = el.querySelector("#fo-tb-host");
    if (!TB) { host.innerHTML = H.banner("The trade builder didn’t load. Reload to retry.", "warn"); return; }
    if (!FO.teams().length) { H.loading(host, "Reading rosters…"); return; }
    host.__tbHandle = TB.mount(host);
  }

  function wire() {
    var el = document.getElementById("fo-trades-body");
    if (!el || el.__tfWired) return;
    el.__tfWired = true;
    wireDialog();
    el.addEventListener("click", function (e) {
      var t = e.target && e.target.closest ? e.target.closest("[data-tf-mode],[data-tf-by],[data-tf-measure],[data-tf-sort],[data-tf-msort],[data-tf-view],[data-tf-guide],[data-tf-gall],[data-tf-gmore]") : null;
      if (!t) return;
      // The guide opens and closes in place (no re-render, the table keeps its scroll).
      if (t.hasAttribute("data-tf-guide")) {
        guideOpen = !guideOpen;
        t.setAttribute("aria-expanded", guideOpen ? "true" : "false");
        var gd = document.getElementById("fo-tf-guide"), gc = t.querySelector(".fo-tf-caret");
        if (gd) gd.hidden = !guideOpen;
        if (gc) gc.textContent = guideOpen ? "▾" : "▸";
        return;
      }
      if (t.hasAttribute("data-tf-gall")) { var k = t.getAttribute("data-tf-gall"); gainsView.all[k] = !gainsView.all[k]; render(); return; }
      if (t.hasAttribute("data-tf-gmore")) { var gp = t.getAttribute("data-tf-gmore"); gainsView.more[gp] = !gainsView.more[gp]; render(); return; }
      if (t.hasAttribute("data-tf-mode")) {
        var nm = t.getAttribute("data-tf-mode");
        if (nm !== mode) { mode = nm; var h = el.querySelector("#fo-tb-host"); if (h) el.innerHTML = ""; render(); }
        return;
      }
      if (t.hasAttribute("data-tf-view")) { var m = H.leagueModel(0); if (m && m.teams[t.getAttribute("data-tf-view")]) openTeam(m, t.getAttribute("data-tf-view")); return; }
      if (t.hasAttribute("data-tf-by")) view.by = t.getAttribute("data-tf-by");
      else if (t.hasAttribute("data-tf-measure")) view.measure = t.getAttribute("data-tf-measure");
      else if (t.hasAttribute("data-tf-sort")) view.sort = t.getAttribute("data-tf-sort");
      else if (t.hasAttribute("data-tf-msort")) view.mixSort = view.mixSort === t.getAttribute("data-tf-msort") ? "" : t.getAttribute("data-tf-msort");
      render();
    });
  }
  function load() {
    ["scores", "players", "league", "tradeBait", "picks"].forEach(function (k) { DATA.load(k).then(rerender); });
    var me = FO.viewerFid();
    if (me) DATA.load("franchiseAssets", me).then(rerender);
  }
  function rerender() {
    var a = document.querySelector(".fo-section.active");
    if (a && a.getAttribute("data-section") === "trades") render();
  }

  if (root.UPS_FO_HUB) root.UPS_FO_HUB.registerView("trades");
  // Test seam: the view state and the team view's pick and stock logic.
  root.UPS_FO_TRADES = { _setMode: function (m) { mode = m; }, _view: view, _sel: sel, _gainsView: gainsView, _pickBook: function () { return pickBook(); }, _pickStock: function (book, f) { return pickStock(book, f); },
    _gains: function (f) { return gainsFor(H.leagueModel(0), f); },
    _teamHtml: function (f) { return teamHtml(H.leagueModel(0), f); }, _openTeam: function (f) { openTeam(H.leagueModel(0), f); } };
  document.addEventListener("fo:ready", function () {
    H = root.UPS_FO_HUB; FO = root.UPS_FO; DATA = root.UPS_FO_DATA; TF = root.UPS_TRADE_FIT; LS = root.UPS_LINEUP_STRENGTH;
    if (!H || !FO || !DATA || !TF || !LS) return;
    wire();
    H.registerAbout("trades", "<h3>Trade finder</h3>" +
      "<p><b>Every team’s lineup strength side by side, and a closer look at any team.</b> It doesn’t grade trades, rank partners or suggest swaps, and it never sends anything.</p><ul>" +
      "<li><b>The table</b> compares all 12 teams’ current rosters: <b>By Position</b> or <b>By Lineup Slot</b>, measured as <b>PPG</b> (the default), <b>Rank</b>, <b>Above Replacement</b> or <b>Index</b>. Each lineup is the team’s best legal lineup from its <b>own available rostered players</b> in the slots MFL’s lineup settings define; a free agent fills a slot only when no rostered player can play it, at replacement level, and is marked <b>*</b>. Values are season points per MFL-scored week.</li>" +
      "<li><b>Measures:</b> <b>PPG</b> (the default) = modeled starters’ points a week. <b>Rank</b> = 1st–12th by that PPG. <b>Above Replacement</b> = the raw points a week above replacement: Σ(starter PPG − replacement-level PPG), 0 = replacement level. Replacement level is the 3rd-best free agent at QB/RB/WR/TE, 6th at K/P, 12th at IDP; By Lineup Slot, a Flex or Superflex slot uses the best of those the slot accepts, so Overall Above Replacement can differ between the two breakdowns: one measures each starter against his own position’s baseline, the other against the slot’s eligible-player baseline. Rank and Index are the league-relative measures. Shown values are rounded so each breakdown’s rows add up to its Overall.<b>Index</b> = PPG ÷ the league <b>mean</b> × 100: 100 = average.<b>Starter Mix</b> is different: the <b>actual</b> starters per week from the lineups submitted to MFL in completed weeks, by each player’s own position. MFL records who started, not which slot: a second QB can only be Superflex and an extra DL/LB/DB only IDP Flex, while extra RB/WR/TE starters are shown together as Flexible slots. A week whose lineup doesn’t fill every slot is listed and left out, never averaged in.</li>" +
      "<li><b>Starter Mix</b> is separate: the starts recorded in the lineups owners submitted to MFL, not the modeled lineup.</li>" +
      "<li><b>View</b> opens a team in a popup (a bottom sheet on phones): standing by position, with each position expanding to its modeled starters; cap room; future picks by year and round with a league comparison; and bench players who would start for other teams. “Well stocked” is said only when MFL’s pick list is complete and the team’s lineup-penalty forfeits were checked. The surplus list is analysis, not a sign the owner would move anyone.</li>" +
      "<li><b>Lineup gains</b> (your team, under the table): players on other teams whose addition alone would raise your modeled lineup, and your available players who would raise another team’s, each with season PPG and the gain in points a week (lineup with the player − without). Only +1.0 pt a week or more; IR, taxi, Out, K and P aren’t listed. Lineup math only: nothing is sent back, no trade is suggested, and it doesn’t say any owner would deal.</li>" +
      "<li>Not scored: contract length, salary value, age, dynasty value. Kickers and punters are shown, never called strong or short.</li></ul>");
  });
  document.addEventListener("fo:tab", function (e) { if (H && e.detail && e.detail.section === "trades") { render(); load(); } });
  document.addEventListener("fo:injury", rerender);
})(typeof window !== "undefined" ? window : this);
