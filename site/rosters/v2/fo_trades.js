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

   YOUR TEAM FIRST (Keith 2026-10-28 review; reworked 2026-10-30: the per-position
   "best available" table was dropped as not useful): the finder opens on the
   viewer's team with two ways in. EXPLORE A POSITION (the default): where you're
   weak (trade_finder_core.weakSpots: Bottom 3 or below the league average), each
   with a button that opens that position's options (positionOptions + groupOptions):
   one list by team, each player with You (my gain) and Them (what his team's lineup
   would lose, 0 for a bench player), lowest cost first. Each team card's
   Explore team opens its popup, ticking the player if only one is listed. EXPLORE A TEAM:
   the team picker and, only here, the league table (Keith 2026-10-30: hidden until
   Explore a team is tapped; shown anyway when the viewer's team isn't known). Basis is
   stated up top: season PPG, not projections, unless the owner picks Projected ROS
   PPG (Keith 2026-10-30): the same screens on H.rosModel(), the same teams, slots and
   free agents valued by the rest-of-season file. A missing or old file never shows.
   BETWEEN YOU AND A TEAM: the team popup for another team lists its players
   with the gain each would give MY lineup and my players with the gain each
   would give THEIRS (trade_finder_core.pairGains, the same numbers). Ticked
   players copy into the Trade builder as an editable UNSENT draft through the
   builder's own UPS_FO_TRADE_BUILDER.openDraft (#1419); without it the button
   is disabled and says why. Exploration only: nothing says a trade is fair.

   LINEUP GAINS (Keith 2026-10-28; the two full lists were removed from Your team
   2026-10-30): trade_fit.lineupGains on the same model feeds the position options
   and the team popup: the gain in points a week from one player added (lineup with
   − lineup without), only GAIN_MIN (1.0 pt a week) or more. Lineup math only: no
   exchange is suggested and nothing says an owner would deal. Computed once per model.
   "How to use this page" is a collapsed guide at the top of the finder.
*/
(function (root) {
  "use strict";

  var H, FO, DATA, TF, LS, TFC;
  // Same defaults as the Overview's card (Keith 2026-10-21): By Position, PPG.
  var view = { by: "position", measure: "ppg", sort: "ALL", mixSort: "" };
  var sel = { team: "" };
  // Trades has two views: the Trade builder (default; fo_trade_builder.js) and the Trade finder (unchanged).
  var mode = "builder";
  var MODES = [["builder", "Trade builder"], ["finder", "Trade finder"]];
  // A third view, Offers (fo_trade_offers.js), exists ONLY when the Front Office write flag is on (it is off everywhere today).
  function offersOn() { var O = root.UPS_FO_TRADE_OFFERS; return !!(O && O.enabled()); }
  function modes() { return offersOn() ? MODES.concat([["offers", "Offers"]]) : MODES; }
  function modeChips() { return '<div class="fo-choice-row"><div class="fo-choice-group"><div class="fo-choice-label" id="fo-lbl-trmode">Trades view</div><div class="fo-subview-chips fo-choice fo-tf-mode" role="group" aria-labelledby="fo-lbl-trmode">' + chips(modes(), "data-tf-mode", mode) + "</div></div></div>"; }
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
  var BASIS_LINE = "Based on season points per game, not projections.";
  // Projected ROS PPG (Keith 2026-10-30, #1433): the owner's choice, on the rest-of-season file. What's on screen follows
  // basisNow(): choosing it before a usable file is loaded leaves every number on season PPG, and the screen says so.
  function basisNow() { return xview.basis === "ros" && H.rosFile() ? "ros" : "ppg"; }
  function activeModel() { return basisNow() === "ros" ? H.rosModel() : H.leagueModel(0); }
  function ppgWord() { return basisNow() === "ros" ? "ROS PPG" : "PPG"; }
  function onBasis(html) { return basisNow() === "ros" ? html.replace(/season PPG/g, "projected ROS PPG").replace(/Season PPG/g, "Projected ROS PPG") : html; }
  function basisChips() {
    var cur = basisNow(), e = DATA.get("ros");
    var note = xview.basis === "ros" && cur !== "ros" ? '<p class="fo-tf-basisnote" role="status">' + (e && e.state === "ok" || e && e.state === "error" ? "Rest-of-season projection unavailable. These numbers stay on season PPG." : "Reading the rest-of-season projection…") + "</p>" : "";
    return '<div class="fo-choice-row"><div class="fo-choice-group"><div class="fo-choice-label" id="fo-lbl-tfbasis">Based on</div><div class="fo-subview-chips fo-choice fo-tf-basis" role="group" aria-labelledby="fo-lbl-tfbasis">' +
      chips([["ppg", "Season PPG"], ["ros", "Projected ROS PPG"]], "data-tf-basis", cur) + "</div></div></div>" + note;
  }
  function basisHeadline(basis) {
    if (basisNow() !== "ros") return "<b>" + BASIS_LINE + "</b> " + H.esc(basis);
    var f = H.rosFile(), on = String(f.asOf).slice(5, 10).replace("-", "/");
    return "<b>Based on projected points per remaining week, Weeks " + f.weeks[0] + "–" + f.weeks[1] + ".</b> " + H.esc(f.label) + ", updated " + on + ". Byes and listed absences count as 0. IR, taxi and Out players aren’t counted.";
  }
  function guideHtml() {
    return '<div class="fo-tf-guidewrap"><button type="button" class="fo-tf-guidebtn" data-tf-guide aria-expanded="' + guideOpen + '" aria-controls="fo-tf-guide">' +
      '<span class="fo-tf-caret" aria-hidden="true">' + (guideOpen ? "▾" : "▸") + "</span> How to use this page</button>" +
      '<div class="fo-tf-guide" id="fo-tf-guide"' + (guideOpen ? "" : " hidden") + "><ul>" +
      "<li><b>Explore a position</b> (the default) lists where you’re weak: Bottom 3 or below the league average. <b>Explore … options</b> shows, team by team, the players who would improve your lineup: <b>You</b> = points a week you’d gain, <b>Them</b> = points a week his team would lose (0 for a bench player). The lowest cost to their team comes first. <b>Explore team</b> opens that team.</li>" +
      "<li><b>Explore a team</b> (or <b>View</b> in the table) opens it: its players with the gain each would give your lineup, your players who would help theirs, its standing, cap, picks and possible roster surplus. Tick players to copy them to the Trade builder as an unsent draft.</li>" +
      "<li><b>Possible roster surplus</b> = healthy bench players outside that team’s modeled lineup who would start for another team, on season PPG. It doesn’t mean the owner would move them.</li>" +
      "<li><b>The league table</b> (under Explore a team) shows every team’s modeled lineup: its best legal lineup from its own available players. Pick a breakdown and a measure; tap a column to sort. <b>Starter Mix</b> shows the lineups owners actually submitted.</li>" +
      "<li>Every number follows the <b>Based on</b> choice above; neither says what a trade is worth. Gains are listed at +" + H.fmt1(TF.GAIN_MIN) + " pts/wk or more.</li>" +
      "</ul></div></div>";
  }

  // ── Gains for the viewer's team (trade_fit.lineupGains, once per model): the position options and the team popup ──
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
  function gainGames(pid) { if (basisNow() === "ros") return ""; var line = H.seasonLine(pid, 0), g = line && line.games; return g ? " · " + g + " g" : ""; }
  // One gain, always with its unit and basis beside it: "+2.4 pts/wk" over "season PPG".
  function gainCell(gain, title) {
    return '<td class="num fo-tf-gain" title="' + H.esc(title) + '"><span class="fo-tf-gnum">+' + H.fmt1(gain) + '</span> <span class="fo-tf-unit">pts/wk</span><div class="fo-tf-gsub">season PPG</div></td>';
  }
  // ── Your team first (Keith 2026-10-30): Explore a position (where you're weak → other teams' bench help) or Explore a team ──
  var XBY = [["position", "Explore a position"], ["team", "Explore a team"]];
  var TEAM_ROWS = 5;
  var xview = { by: "position", pos: "", allTeams: false, basis: "ppg" };
  var posMemo = { model: null, fid: "", out: {} };
  function optionsFor(m, me, G, g) {
    if (posMemo.model !== m || posMemo.fid !== me) posMemo = { model: m, fid: me, out: {} };
    return posMemo.out[g] || (posMemo.out[g] = TFC.positionOptions(m, strengthTable(m, "position"), G, g, TF));
  }
  function gapText(gap) { return (gap > 0.05 ? "+" : gap < -0.05 ? "−" : "") + Math.abs(Math.round(gap * 10) / 10).toFixed(1); }
  function tagHtml(r) { return r.tag === "strong" ? ' <span class="fo-tf-tag ok">Top 3</span>' : r.tag === "short" ? ' <span class="fo-tf-tag need">Bottom 3</span>' : ""; }
  // One-line summary of the help at a position: bench players first (they cost their team nothing), else starters.
  function helpLine(O) {
    var lbl = gl(O.g);
    if (O.surplus.length) return O.surplus.length + " bench " + lbl + (O.surplus.length === 1 ? "" : "s") + " on " + O.teams.length + " other team" + (O.teams.length === 1 ? "" : "s") + " would help · best +" + H.fmt1(O.surplus[0].gain) + " pts/wk";
    if (O.starters.length) return "No bench " + lbl + " elsewhere would help; " + O.starters.length + " starter" + (O.starters.length === 1 ? "" : "s") + " would";
    return "No " + lbl + " on another team would add +" + H.fmt1(O.minGain) + " pts/wk";
  }
  function exploreButton(g, label) {
    var open = xview.pos === g;
    return '<button type="button" class="fo-tf-posbtn' + (open ? " active" : "") + '" data-tf-xpos="' + g + '" aria-expanded="' + open + '" aria-controls="fo-tf-posx">' + H.esc(label) + "</button>";
  }
  // Explore team is one button per team card. With one player listed it ticks him; with several, the owner picks in the popup.
  function exploreTeamButton(T) {
    var name = H.teamName(T.fid), one = T.players.length === 1 ? T.players[0].pid : "";
    return '<button type="button" class="fo-tf-xteam" data-tf-xteam="' + H.esc(T.fid) + '"' + (one ? ' data-tf-xpid="' + H.esc(one) + '"' : "") +
      ' aria-label="' + H.esc("Explore " + name + (one ? " with " + H.displayName(playerName(one)) + " ticked" : "")) + '">Explore team</button>';
  }
  function optionPlayer(x, fid) {
    var them = x.bench ? '<span class="fo-tf-them">Them 0 (bench)</span>' : '<span class="fo-tf-them fo-tf-loss">Them −' + H.fmt1(x.loss) + "</span>";
    return '<div class="fo-tf-optp" data-tf-opt="' + H.esc(x.pid) + '" data-tf-optkind="' + (x.bench ? "bench" : "starter") + '"><div class="fo-tf-optname">' +
      gainPlayer(x.pid, fid, H.fmt1(x.v) + " " + ppgWord() + gainGames(x.pid)) + '</div><div class="fo-tf-optnums" title="' + H.esc("Your lineup would gain about " + H.fmt1(x.gain) + " pts/week; his team’s would lose about " + H.fmt1(x.loss) + " (season PPG)") + '">' +
      '<span class="fo-tf-you">You <b>+' + H.fmt1(x.gain) + "</b></span> " + them + ' <span class="fo-tf-unit">pts/wk</span></div></div>';
  }
  function optionCard(T, g, n) {
    return '<li class="fo-tf-optcard" data-tf-card="' + H.esc(T.fid) + '"><div class="fo-tf-opthead"><b>' + H.esc(H.teamName(T.fid)) + "</b>" +
      (T.rank ? ' <span class="fo-muted">' + H.esc(gl(g)) + " rank " + LS.ordinal(T.rank) + " of " + n + "</span>" : "") + "</div>" +
      T.players.map(function (x) { return optionPlayer(x, T.fid); }).join("") + '<div class="fo-tf-optfoot">' + exploreTeamButton(T) + "</div></li>";
  }
  // "Your weakest QB starter: Jacoby Brissett, 19.4 PPG." A slot no rostered player can fill says so instead of naming anyone.
  function weakestLine(m, me, g) {
    var list = LS.modeledStarters(m, me, g), low = null;
    list.forEach(function (s) { if (!low || s.v < low.v) low = s; });
    if (!low) return "You have no " + gl(g) + " in your lineup.";
    return "Your weakest " + gl(g) + " starter: " + (low.rep ? "a replacement free agent" : H.displayName(playerName(low.pid))) + ", " + H.fmt1(low.v) + " " + ppgWord() + ".";
  }
  function positionPanel(m, me, G, g) {
    var O = optionsFor(m, me, G, g);
    if (!O) return "";
    var lbl = gl(g), min = H.fmt1(O.minGain), teams = TFC.groupOptions(O);
    var shown = xview.allTeams ? teams : teams.slice(0, TEAM_ROWS);
    var benchNote = !O.surplus.length && teams.length ? '<p class="fo-tf-gsub">No bench ' + H.esc(lbl) + " would add +" + min + " pts/wk.</p>" : "";
    return '<div class="fo-tf-posx" id="fo-tf-posx" data-tf-posx="' + g + '" tabindex="-1">' +
      '<div class="fo-tf-posxhead"><h3 class="fo-tf-gh">' + H.esc(lbl) + " options</h3>" +
      '<button type="button" class="fo-tf-more" data-tf-xpos="' + g + '" aria-expanded="true" aria-controls="fo-tf-posx">Close</button></div>' +
      '<p class="fo-tf-optsum">' + H.esc(weakestLine(m, me, g)) + " Each row adds one player: what you’d gain and what his team would lose, lowest cost first.</p>" +
      '<p class="fo-tf-gsub">Your ' + H.esc(lbl) + " starters combined: " + H.fmt1(O.ppg) + " pts/wk, " + LS.ordinal(O.rank) + " of " + O.n + ".</p>" +
      (teams.length ? benchNote + '<ul class="fo-tf-optcards">' + shown.map(function (T) { return optionCard(T, g, O.n); }).join("") + "</ul>" +
        (teams.length > TEAM_ROWS ? '<p class="fo-tf-showall"><button type="button" class="fo-tf-more" data-tf-xall aria-expanded="' + xview.allTeams + '">' + (xview.allTeams ? "Show fewer" : "Show all " + teams.length + " teams") + "</button></p>" : "")
        : '<p class="fo-ov-empty">No ' + H.esc(lbl) + " on another team would add +" + min + " pts/wk.</p>") +
      '<p class="fo-basis">Only +' + min + " pts/wk or more. Costs are one player at a time; they don’t add up. Season PPG: it doesn’t say a trade is fair or that an owner would move anyone. <b>Explore team</b> opens that team; nothing is sent.</p></div>";
  }
  function positionHtml(m, me, G) {
    var W = TFC.weakSpots(TFC.standing(strengthTable(m, "position"), me, { forMe: G.forMe }));
    if (!W) return "";
    var panelFor = function (g) { return xview.pos === g ? positionPanel(m, me, G, g) : ""; };
    var weak = W.weak.map(function (r) {
      var O = optionsFor(m, me, G, r.g);
      return '<li class="fo-tf-weakrow" data-tf-weak="' + r.g + '"><div class="fo-tf-weakhead"><b class="fo-tf-weakpos">' + gl(r.g) + "</b>" + tagHtml(r) +
        ' <span class="fo-tf-weakrank">' + LS.ordinal(r.rank) + " of " + W.n + "</span></div>" +
        '<div class="fo-tf-gsub">Your starters: ' + H.fmt1(r.ppg) + " pts/wk combined · league " + H.fmt1(r.avg) + " · " + gapText(r.gap) + "</div>" +
        '<div class="fo-tf-weakhelp">' + H.esc(helpLine(O)) + "</div>" +
        exploreButton(r.g, "Explore " + gl(r.g) + " options") + panelFor(r.g) + "</li>";
    }).join("");
    var others = W.others.map(function (r) { return exploreButton(r.g, gl(r.g) + " " + LS.ordinal(r.rank)); }).join(" ");
    var otherOpen = W.others.some(function (r) { return r.g === xview.pos; });
    return '<h3 class="fo-tf-gh">Where you’re weak</h3>' +
      (weak ? '<ul class="fo-tf-weak">' + weak + "</ul>" : '<p class="fo-ov-empty">No position is below the league average or in the Bottom 3.</p>') +
      (others ? '<div class="fo-tf-others"><span class="fo-muted">Other positions:</span> ' + others + "</div>" + (otherOpen ? positionPanel(m, me, G, xview.pos) : "") : "") +
      '<p class="fo-basis">Weak = Bottom 3 at the position, or below the league average. K and P aren’t listed.</p>';
  }
  function exploreHtml(m, me) {
    var opts = m.order.filter(function (f) { return f !== me; }).slice().sort(function (a, b) { return m.teams[a].name.localeCompare(m.teams[b].name); })
      .map(function (f) { return '<option value="' + H.esc(f) + '">' + H.esc(m.teams[f].name) + "</option>"; }).join("");
    return '<div class="fo-tf-explore"><label for="fo-tf-explore"><b>Explore a team</b></label> <select id="fo-tf-explore" data-tf-explore><option value="">Choose a team…</option>' + opts + "</select>" +
      '<span class="fo-muted"> its players’ gains to your lineup, and yours to theirs</span></div>';
  }
  function mineHtml(m, me, basis) {
    var head = '<div class="fo-card fo-tf-mine"><div class="fo-card-head"><h2>Your team: find help</h2><span class="small fo-muted">Trade finder</span></div>' + guideHtml() +
      basisChips() + '<p class="fo-tf-basisline">' + basisHeadline(basis) + "</p>";
    if (!me) return head + '<p class="fo-ov-empty">Your team’s view needs to know which team is yours, and Front Office couldn’t tell. The league table is below.</p></div>';
    var G = gainsFor(m, me);
    if (!G) return head + "</div>";
    var xby = '<div class="fo-choice-row"><div class="fo-choice-group"><div class="fo-choice-label" id="fo-lbl-tfx">Explore</div><div class="fo-subview-chips fo-choice fo-tf-xby" role="group" aria-labelledby="fo-lbl-tfx">' + chips(XBY, "data-tf-xby", xview.by) + "</div></div></div>";
    return head + xby + (xview.by === "team" ? exploreHtml(m, me) : positionHtml(m, me, G)) + "</div>";
  }

  // ── Between you and another team (the team popup): pair gains, tick players, copy to the builder unsent ──
  var picks = { other: "", theirs: {}, mine: {} };
  function builderApi() { var B = root.UPS_FO_TRADE_BUILDER; return B && typeof B.openDraft === "function" ? B : null; }
  function pickedList(side) { return Object.keys(picks[side]).filter(function (k) { return picks[side][k]; }); }
  function copyState() {
    var n = pickedList("theirs").length + pickedList("mine").length;
    if (!builderApi()) return { ok: false, n: n, why: "The Trade builder in this build can’t take a copied draft yet." };
    if (!n) return { ok: false, n: n, why: "Tick at least one player to copy." };
    return { ok: true, n: n, why: "Opens an editable draft in the Trade builder. Nothing is sent." };
  }
  function pickBarHtml() {
    var c = copyState(), t = pickedList("theirs").length, y = pickedList("mine").length;
    return '<span class="fo-tf-pickn" data-tf-pickn>' + (c.n ? "Selected: " + t + " of theirs, " + y + " of yours" : "Nothing selected") + "</span> " +
      '<button type="button" class="fo-tf-copy" data-tf-copy' + (c.ok ? "" : " disabled") + ">Copy to Trade builder (not sent)</button>" +
      '<p class="fo-basis" data-tf-copywhy>' + H.esc(c.why) + "</p>";
  }
  function pairHtml(m, me, f) {
    var P = TFC.pairGains(gainsFor(m, me), f);
    if (!P) return "";
    var min = H.fmt1(P.minGain), name = m.teams[f].name;
    var row = function (side, x, fid) {
      var on = !!picks[side][x.pid];
      return '<tr data-tf-pair="' + side + '"><td class="fo-tf-pickcell"><input type="checkbox" data-tf-pick="' + side + '" value="' + H.esc(x.pid) + '"' + (on ? " checked" : "") + ' aria-label="' + H.esc("Select " + H.displayName(playerName(x.pid))) + '"></td>' +
        "<th scope=\"row\">" + gainPlayer(x.pid, fid, H.esc(gl(x.group)) + ' · <span class="fo-tf-gppg">' + H.fmt1(x.v) + "</span> " + ppgWord() + gainGames(x.pid), side === "mine" && x.starter ? ' <span class="fo-tf-tag">in your lineup</span>' : "") + "</th>" +
        gainCell(x.gain, side === "theirs" ? "Would add about +" + H.fmt1(x.gain) + " pts/week to your modeled lineup (season PPG)" : "Would add about +" + H.fmt1(x.gain) + " pts/week to " + name + "’s modeled lineup (season PPG)") + "</tr>";
    };
    var table = function (side, list, fid, head, empty) {
      return list.length ? '<div class="fo-table-scroll fo-tf-gscroll"><table class="fo-table fo-tf-gt fo-tf-pair" data-tf-pairs="' + side + '"><thead><tr><th scope="col"><span class="fo-sr">Select</span></th><th scope="col">Player · season PPG</th><th scope="col" class="num">' + head + "</th></tr></thead><tbody>" +
        list.map(function (x) { return row(side, x, fid); }).join("") + "</tbody></table></div>" : '<p class="fo-ov-empty">' + empty + "</p>";
    };
    return '<div class="fo-tf-between"><h4 class="fo-tf-h">Between you and ' + H.esc(name) + "</h4>" +
      '<p class="fo-tf-basisline"><b>' + (basisNow() === "ros" ? "Based on projected ROS PPG." : BASIS_LINE) + "</b> Each gain adds one player alone, nothing sent back. Exploration only: it doesn’t say a trade is fair or that an owner would accept.</p>" +
      '<h5 class="fo-tf-gh">Their players who would improve your lineup</h5>' +
      table("theirs", P.theirs, f, "Your gain", "None of their available players would add +" + min + " pts/wk or more to your modeled lineup.") +
      '<h5 class="fo-tf-gh">Your players who would improve theirs</h5>' +
      table("mine", P.mine, me, "Their gain", "None of your available players would add +" + min + " pts/wk or more to their modeled lineup.") +
      '<div class="fo-tf-pickbar" data-tf-pickbar>' + pickBarHtml() + "</div></div>";
  }
  function refreshPickBar() {
    var bar = document.querySelector("[data-tf-pickbar]");
    if (bar) bar.innerHTML = pickBarHtml();
  }
  // Copy the ticked players into the Trade builder as an editable, unsent draft through the builder's own openDraft
  // (#1419 contract: it validates against the loaded rosters, asks before replacing a non-empty draft, switches to the
  // builder and never sends). A refusal leaves the popup open and says why.
  var COPY_FAIL = { not_ready: "The Trade builder isn’t ready yet. Try again in a moment.", kept_current: "Kept the trade you’re building; nothing was copied.",
    no_valid_assets: "None of the ticked players are on the loaded rosters now.", viewer_not_in_trade: "Your team must be in the draft.",
    too_many_teams: "The builder takes two or three teams.", bad_shape: "The draft couldn’t be read by the Trade builder." };
  function copyToBuilder() {
    var me = myFid(), B = builderApi();
    var draft = TFC.selectionToDraft({ me: me, other: picks.other, mine: pickedList("mine"), theirs: pickedList("theirs") });
    if (!B || !draft) return null;
    var r = B.openDraft(draft) || {};
    if (!r.ok) {
      var why = document.querySelector("[data-tf-copywhy]");
      if (why) why.textContent = COPY_FAIL[r.reason] || "The Trade builder didn’t take the draft.";
      return r;
    }
    H.closeAbout();
    // openDraft sets the builder mode and shows Trades; make sure the builder is actually mounted here.
    mode = "builder";
    var el = document.getElementById("fo-trades-body");
    if (el && !el.querySelector("#fo-tb-host")) { el.innerHTML = ""; render(); }
    return r;
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
      var line = basisNow() === "ros" ? { ppg: s.v } : H.seasonLine(s.pid, 0);
      var helps = s.gains.slice(0, 3).map(function (x) { return H.esc(H.teamName(x.fid)) + " <b>+" + H.fmt1(x.gain) + "</b>"; }).join(", ") + (s.gains.length > 3 ? ' <span class="fo-muted">+' + (s.gains.length - 3) + " more</span>" : "");
      return '<li><button type="button" class="fo-plink" data-tf-player="' + H.esc(s.pid) + '" data-tf-fid="' + H.esc(f) + '">' + H.esc(H.displayName(playerName(s.pid))) + "</button>" + (p ? H.injuryChip(p) : "") + ' <span class="fo-muted">' + H.esc(gl(s.group)) + (line && line.ppg != null ? " · " + H.fmt1(line.ppg) + " PPG" : "") + "</span>" +
        (bait[s.pid] === f ? ' <span class="fo-av fo-av-bait" title="Listed by the owner on MFL’s trading block">On MFL trading block</span>' : "") +
        '<div class="fo-perf-sub">Would start for ' + s.teamsHelped + " team" + (s.teamsHelped === 1 ? "" : "s") + ": " + helps + "</div></li>";
    }).join("");
    var me = myFid();
    return '<div class="fo-tf-team" data-tf-team-view="' + H.esc(f) + '">' +
      '<p class="fo-ov-sub">Modeled lineup: <b>' + H.esc(LS.cell(pos, f, "ALL", "ppg").text) + "</b> pts a week, " + LS.ordinal(tr.ALL.rank) + " of " + n + " (season PPG). " +
      '<a class="fo-go" href="' + H.esc(FO.warRoomUrl(me && me !== f ? { twb_left_team: me, twb_right_team: f } : { twb_left_team: f })) + '" target="_top">Trade War Room ↗</a></p>' +
      (me && me !== f ? pairHtml(m, me, f) : "") +
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
  // opts.tick: a player on that team to tick on their side (Explore a position's Explore team); opts.returnTo: the button
  // that opened it (focus goes back there on close).
  function openTeam(m, f, opts) {
    opts = opts || {};
    sel.team = f;
    if (picks.other !== f) picks = { other: f, theirs: {}, mine: {} };
    if (opts.tick) picks.theirs[opts.tick] = true;
    markSelected();
    var me = myFid();
    H.openDialog(m.teams[f].name + (f === me ? " (you)" : ""), onBasis(teamHtml(m, f)), {
      variant: "team",
      returnFocus: function () {
        var el = document.getElementById("fo-trades-body");
        if (!el) return null;
        return (opts.returnTo && el.contains(opts.returnTo) ? opts.returnTo : null) || el.querySelector('[data-tf-view="' + f + '"]');
      },
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
      var t = e.target && e.target.closest ? e.target.closest("[data-tf-pos],[data-tf-player],[data-tf-copy]") : null;
      if (!t || !body.querySelector("[data-tf-team-view]")) return;
      if (t.hasAttribute("data-tf-copy")) { if (!t.disabled) copyToBuilder(); return; }
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
    // Ticking a player updates only the selection bar (the popup never re-renders under the owner's thumb).
    body.addEventListener("change", function (e) {
      var t = e.target;
      if (!t || !t.hasAttribute || !t.hasAttribute("data-tf-pick")) return;
      picks[t.getAttribute("data-tf-pick")][t.value] = !!t.checked;
      refreshPickBar();
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
    if (mode === "offers" && !offersOn()) mode = "builder";
    if (mode === "builder") { renderBuilder(el); return; }
    if (mode === "offers") { root.UPS_FO_TRADE_OFFERS.render(el, modeChips()); return; }
    var se = DATA.get("scores");
    if (!se || !DATA.get("players")) { H.loading(el, "Reading MFL’s scores and players…"); return; }
    var ss = H.scoring();
    if (!ss) { el.innerHTML = H.banner("MFL’s scores couldn’t be read, so the Trade finder is off. Reload to retry.", "warn"); return; }
    // Never this season's numbers before MFL has scored a week (standing rule for anything citing player value).
    if (!ss.seasonWeeks.length) { el.innerHTML = H.banner("The Trade finder starts once MFL has scored a week this season.", "info"); return; }
    var slotState = H.lineupSlotsState();
    if (!slotState) { H.loading(el, "Reading MFL’s lineup settings…"); return; }
    if (slotState === "error") { el.innerHTML = H.banner("MFL’s lineup settings couldn’t be read, so the Trade finder is off. Reload to retry.", "warn"); return; }
    var m = activeModel();
    if (!m) { H.loading(el, "Building the league model…"); return; }
    var me = myFid();
    var F = root.UPS_PLAYER_FACTS, basis = F ? F.basis(ss) : { text: "" };
    var controls = '<div class="fo-choice-row"><div class="fo-choice-group"><div class="fo-choice-label" id="fo-lbl-tfby">Compare by</div>' +
      '<div class="fo-subview-chips fo-choice fo-ls-by" role="group" aria-labelledby="fo-lbl-tfby">' + chips(BY, "data-tf-by", view.by) + "</div></div>" +
      (view.by === "mix" ? "" : '<div class="fo-choice-group"><div class="fo-choice-label" id="fo-lbl-tfms">Measure</div>' +
        '<div class="fo-subview-chips fo-choice fo-ls-views" role="group" aria-labelledby="fo-lbl-tfms">' + chips(MEASURES, "data-tf-measure", view.measure) + "</div></div>") + "</div>";
    // Re-rendering keeps the scroll position of the table box (sorting or a data refresh never jumps the table).
    var box = el.querySelector(".fo-tf-scroll"), sx = box ? box.scrollLeft : 0;
    // Your team first (Explore a position or a team); the league table only under Explore a team (or when there's no
    // viewer team, so no Explore choice to tap).
    var showTable = xview.by === "team" || !me;
    el.innerHTML = onBasis(modeChips() + mineHtml(m, me, basis.text) + (showTable ? '<div class="fo-card fo-tf-main"><div class="fo-card-head"><h2>Lineup strength, all teams</h2>' +
      '<span class="small fo-muted">' + (basisNow() === "ros" ? "values = projected points per remaining week" : "values = season PPG per MFL week, not projections") + "</span></div>" + controls +
      (view.by === "mix" ? mixHtml(m, me) : strengthHtml(m, me)) + "</div>" : ""));
    var nb = el.querySelector(".fo-tf-scroll");
    if (nb && sx) nb.scrollLeft = sx;
    H.setFreshness("MFL read " + H.clock(ss.fetchedAt));
  }

  // The builder keeps its own draft: mount once, then only refresh it when data (picks, rosters) arrives.
  function renderBuilder(el) {
    var TB = root.UPS_FO_TRADE_BUILDER;
    var host = el.querySelector("#fo-tb-host");
    if (host && host.__tbHandle) {
      // The Offers chip can appear after the first paint (the write flag's code loads late): refresh the chip row only, never the builder.
      var row = el.querySelector(".fo-choice-row");
      if (row && !!row.querySelector('[data-tf-mode="offers"]') !== offersOn()) row.outerHTML = modeChips();
      host.__tbHandle.refresh(); return;
    }
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
    el.addEventListener("change", function (e) {
      var t = e.target;
      if (!t || !t.hasAttribute || !t.hasAttribute("data-tf-explore") || !t.value) return;
      var m = activeModel(), f = t.value;
      t.value = "";
      if (m && m.teams[f]) openTeam(m, f);
    });
    el.addEventListener("click", function (e) {
      var t = e.target && e.target.closest ? e.target.closest("[data-tf-mode],[data-tf-by],[data-tf-measure],[data-tf-sort],[data-tf-msort],[data-tf-view],[data-tf-guide],[data-tf-xby],[data-tf-xpos],[data-tf-xall],[data-tf-xteam],[data-tf-basis]") : null;
      if (!t) return;
      // Explore a position / a team (Keith 2026-10-30).
      if (t.hasAttribute("data-tf-basis")) { setBasis(t.getAttribute("data-tf-basis")); return; }
      if (t.hasAttribute("data-tf-xby")) { xview.by = t.getAttribute("data-tf-xby"); render(); return; }
      if (t.hasAttribute("data-tf-xall")) { xview.allTeams = !xview.allTeams; render(); return; }
      if (t.hasAttribute("data-tf-xpos")) {
        var xg = t.getAttribute("data-tf-xpos"), opening = xview.pos !== xg;
        xview.pos = opening ? xg : ""; xview.allTeams = false;
        render();
        var after = opening ? el.querySelector("#fo-tf-posx") : el.querySelector('[data-tf-xpos="' + xg + '"]');
        if (after) { try { after.focus({ preventScroll: !opening }); } catch (x) { after.focus(); } }
        return;
      }
      if (t.hasAttribute("data-tf-xteam")) {
        var xm = activeModel(), xf = t.getAttribute("data-tf-xteam");
        if (xm && xm.teams[xf]) openTeam(xm, xf, { tick: t.getAttribute("data-tf-xpid") || "", returnTo: t });
        return;
      }
      // The guide opens and closes in place (no re-render, the table keeps its scroll).
      if (t.hasAttribute("data-tf-guide")) {
        guideOpen = !guideOpen;
        t.setAttribute("aria-expanded", guideOpen ? "true" : "false");
        var gd = document.getElementById("fo-tf-guide"), gc = t.querySelector(".fo-tf-caret");
        if (gd) gd.hidden = !guideOpen;
        if (gc) gc.textContent = guideOpen ? "▾" : "▸";
        return;
      }
      if (t.hasAttribute("data-tf-mode")) {
        var nm = t.getAttribute("data-tf-mode");
        if (nm !== mode) { mode = nm; var h = el.querySelector("#fo-tb-host"); if (h) el.innerHTML = ""; render(); }
        return;
      }
      if (t.hasAttribute("data-tf-view")) { var m = activeModel(); if (m && m.teams[t.getAttribute("data-tf-view")]) openTeam(m, t.getAttribute("data-tf-view")); return; }
      if (t.hasAttribute("data-tf-by")) view.by = t.getAttribute("data-tf-by");
      else if (t.hasAttribute("data-tf-measure")) view.measure = t.getAttribute("data-tf-measure");
      else if (t.hasAttribute("data-tf-sort")) view.sort = t.getAttribute("data-tf-sort");
      else if (t.hasAttribute("data-tf-msort")) view.mixSort = view.mixSort === t.getAttribute("data-tf-msort") ? "" : t.getAttribute("data-tf-msort");
      render();
    });
  }
  // Choosing Projected ROS PPG reads the file once; a failed read is read again on the next tap.
  function setBasis(b) {
    xview.basis = b === "ros" ? "ros" : "ppg";
    if (xview.basis === "ros") {
      var e = DATA.get("ros");
      if (!e) DATA.load("ros").then(rerender);
      else if (e.state === "error" && DATA.refresh) DATA.refresh("ros").then(rerender);
    }
    render();
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
  root.UPS_FO_TRADES = { _setMode: function (m) { mode = m; }, _rerender: function () { rerender(); }, _view: view, _sel: sel, _pickBook: function () { return pickBook(); }, _pickStock: function (book, f) { return pickStock(book, f); },
    _gains: function (f) { return gainsFor(activeModel(), f); }, _picks: function () { return picks; }, _copyState: function () { return copyState(); }, _copy: function () { return copyToBuilder(); },
    _teamHtml: function (f) { return onBasis(teamHtml(activeModel(), f)); }, _openTeam: function (f, o) { openTeam(activeModel(), f, o); }, _setBasis: setBasis, _xview: xview };
  document.addEventListener("fo:ready", function () {
    H = root.UPS_FO_HUB; FO = root.UPS_FO; DATA = root.UPS_FO_DATA; TF = root.UPS_TRADE_FIT; LS = root.UPS_LINEUP_STRENGTH; TFC = root.UPS_TRADE_FINDER;
    if (!H || !FO || !DATA || !TF || !LS || !TFC) return;
    wire();
    H.registerAbout("trades", "<h3>Trade finder</h3>" +
      "<p><b>Your team first (explore a weak position or a team), then every team’s lineup strength side by side, and a closer look at any team.</b> Based on season points per game, not projections. It doesn’t grade trades, rank partners or suggest swaps, and it never sends anything.</p><ul>" +
      "<li><b>Explore a position</b>: your weak positions (Bottom 3 by PPG, or below the league average; K and P aren’t listed), each with your PPG, the league average and your rank. Its button lists the players at that position on other teams who alone would add +1.0 pt a week or more to your modeled lineup: grouped by team, with <b>You</b> (the gain) and <b>Them</b> (what his team’s lineup would lose; 0 for a bench player, who is outside it). The lowest cost to their team comes first. Each cost is one player at a time, so they don’t add up. <b>Explore team</b> opens that team, with the player ticked when only one is listed. The other positions are buttons too.</li>" +
      "<li><b>Based on</b>: <b>Season PPG</b> (the default) or <b>Projected ROS PPG</b>: projected points per remaining week through MFL’s last week, from the UPS Center projection (RotoWire for offense, with MFL deciding who plays; MFL for DL, LB, DB, K and P). A week with no projection, such as a bye or a listed absence, counts as 0. Every You, Them, rank and lineup number here recalculates on the choice. If the projection is missing or more than 8 days old the screen says so and stays on season PPG.</li>" +
      "<li><b>Explore a team</b> (or <b>View</b>): their players with the gain each would give your lineup, and your available players with the gain each would give theirs. Tick players on either side and <b>Copy to Trade builder (not sent)</b> opens them as an editable draft there; nothing is sent. It is exploration, not a claim that a trade is fair or that an owner would accept.</li>" +
      "<li><b>The table</b> (under Explore a team) compares all 12 teams’ current rosters: <b>By Position</b> or <b>By Lineup Slot</b>, measured as <b>PPG</b> (the default), <b>Rank</b>, <b>Above Replacement</b> or <b>Index</b>. Each lineup is the team’s best legal lineup from its <b>own available rostered players</b> in the slots MFL’s lineup settings define; a free agent fills a slot only when no rostered player can play it, at replacement level, and is marked <b>*</b>. Values are season points per MFL-scored week.</li>" +
      "<li><b>Measures:</b> <b>PPG</b> (the default) = modeled starters’ points a week. <b>Rank</b> = 1st–12th by that PPG. <b>Above Replacement</b> = the raw points a week above replacement: Σ(starter PPG − replacement-level PPG), 0 = replacement level. Replacement level is the 3rd-best free agent at QB/RB/WR/TE, 6th at K/P, 12th at IDP; By Lineup Slot, a Flex or Superflex slot uses the best of those the slot accepts, so Overall Above Replacement can differ between the two breakdowns: one measures each starter against his own position’s baseline, the other against the slot’s eligible-player baseline. Rank and Index are the league-relative measures. Shown values are rounded so each breakdown’s rows add up to its Overall.<b>Index</b> = PPG ÷ the league <b>mean</b> × 100: 100 = average.<b>Starter Mix</b> is different: the <b>actual</b> starters per week from the lineups submitted to MFL in completed weeks, by each player’s own position. MFL records who started, not which slot: a second QB can only be Superflex and an extra DL/LB/DB only IDP Flex, while extra RB/WR/TE starters are shown together as Flexible slots. A week whose lineup doesn’t fill every slot is listed and left out, never averaged in.</li>" +
      "<li><b>Starter Mix</b> is separate: the starts recorded in the lineups owners submitted to MFL, not the modeled lineup.</li>" +
      "<li><b>View</b> opens a team in a popup (a bottom sheet on phones): standing by position, with each position expanding to its modeled starters; cap room; future picks by year and round with a league comparison; and bench players who would start for other teams. “Well stocked” is said only when MFL’s pick list is complete and the team’s lineup-penalty forfeits were checked. The surplus list is analysis, not a sign the owner would move anyone.</li>" +
      "<li>Not scored: contract length, salary value, age, dynasty value. Kickers and punters are shown, never called strong or short.</li></ul>");
  });
  document.addEventListener("fo:tab", function (e) { if (H && e.detail && e.detail.section === "trades") { render(); load(); } });
  document.addEventListener("fo:injury", rerender);
})(typeof window !== "undefined" ? window : this);
