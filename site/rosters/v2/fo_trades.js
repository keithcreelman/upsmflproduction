/* Front Office → Trades → Trade finder (#1338). Read-only discovery: where each
   team is strong or short, who the logical partners are, and 1-for-1 swaps that
   improve BOTH best lineups — never a fairness grade, never a proposal. Every
   swap opens the ONE Trade War Room route (the Home button's) preloaded; the
   owner builds and sends there.

   Model: site/shared/trade_fit.js on season PPG per MFL-scored week (the
   backtested default; method and evidence in docs/FRONT_OFFICE_TRADE_FIT.md).
   Lineups are each team's OWNED roster (Keith 2026-10-21): a replacement free
   agent fills only a slot the roster can't, marked *. The matrix cells come
   from site/shared/lineup_strength.js on the same model object as the
   Overview's Lineup strength, so the two screens show the same values.
   Each fit also says whether it holds on the last 4 final weeks, and flags small
   samples, IDP-only swaps and cap overages (the app refuses a trade that leaves
   a team over the cap). Picks, contract years and age are shown, not scored.
*/
(function (root) {
  "use strict";

  var H, FO, DATA, TF, LS;
  var sel = { partner: "" };
  var partnersMemo = { model: null, alt: null, me: "", list: null };
  var tableMemo = { model: null, table: null };
  var MATRIX_GROUPS = ["QB", "RB", "WR", "TE", "DL", "LB", "DB", "PK", "PN"];
  var GLABEL = { PK: "K", PN: "P" };

  function myFid() {
    var me = FO.viewerFid(), s = FO.selectedTeam();
    if (s && s !== "__all__") return s;
    return me && FO.teams().some(function (t) { return t.fid === me; }) ? me : "";
  }
  function models() {
    var m = H.leagueModel(0);
    var ss = H.scoring();
    var alt = ss && ss.finalKnown ? H.leagueModel(4) : null;
    return { m: m, alt: alt };
  }
  function capRoom() {
    var out = {};
    FO.teams().forEach(function (t) { var c = FO.capFor(t.fid); out[t.fid] = c ? c.capSpace : null; });
    return out;
  }
  function baitMap() {
    var e = DATA.get("tradeBait"), out = { players: {}, notes: {} };
    if (!e || e.state !== "ok") return out;
    H.asArray(e.data.tradeBaits && e.data.tradeBaits.tradeBait).forEach(function (tb) {
      var fid = H.pad4(tb.franchise_id);
      out.notes[fid] = String(tb.inExchangeFor || "").trim();
      String(tb.willGiveUp || "").split(",").forEach(function (id) { id = id.trim(); if (/^\d+$/.test(id)) out.players[id] = fid; });
    });
    return out;
  }

  // Logical partners for my team: each other team's best mutual 1-for-1 gain (and how many such swaps exist).
  function partners(m, alt, me) {
    if (partnersMemo.model === m && partnersMemo.alt === alt && partnersMemo.me === me && partnersMemo.list) return partnersMemo.list;
    var room = capRoom();
    var list = m.order.filter(function (f) { return f !== me; }).map(function (f) {
      var fits = TF.pairFits(m, me, f, { alt: alt, capRoom: room, limit: 50 });
      var ok = fits.filter(function (x) { return !x.overCap; });
      return { fid: f, fits: fits, best: ok[0] || fits[0] || null, count: ok.length };
    }).sort(function (a, b) { return ((b.best ? b.best.mutual : 0) - (a.best ? a.best.mutual : 0)) || (b.count - a.count); });
    partnersMemo = { model: m, alt: alt, me: me, list: list };
    return list;
  }

  function cellStyle(v, max) {
    var a = Math.min(1, Math.abs(v) / (max || 1));
    return v >= 0 ? "background: rgba(91,141,255," + (0.08 + a * 0.42).toFixed(2) + ")" : "background: rgba(245,158,11," + (0.08 + a * 0.42).toFixed(2) + ")";
  }

  // The Overview's Lineup strength table on this same model (one calculation for both screens).
  function strengthTable(m) {
    if (tableMemo.model !== m) tableMemo = { model: m, table: LS.build(m) };
    return tableMemo.table;
  }
  function repMark(n, label) {
    return n ? '<span class="fo-ov-rep" aria-label="' + H.esc(label) + '">*</span>' : "";
  }

  function matrixHtml(m, me) {
    var tb = strengthTable(m);
    var max = 0;
    m.order.forEach(function (f) { MATRIX_GROUPS.forEach(function (g) { max = Math.max(max, Math.abs(tb.teams[f][g].above)); }); });
    var order = m.order.slice().sort(function (a, b) { return a === me ? -1 : b === me ? 1 : m.teams[b].total - m.teams[a].total; });
    var head = '<tr><th scope="col">Team</th><th scope="col" class="num" title="All 18 starters: points a week above replacement (the Overview’s Overall row, By Position, Above Replacement)">Overall</th>' +
      MATRIX_GROUPS.map(function (g) { return '<th scope="col" class="num' + (TF.FIT_EXCLUDED_GROUPS[g] ? " fo-tf-kp" : "") + '">' + (GLABEL[g] || g) + "</th>"; }).join("") + "</tr>";
    var rows = order.map(function (f) {
      var tm = m.teams[f], tr = tb.teams[f];
      // Mark a team's TOP two needs only: a strong-WR team whose Flex is weak gains from a WR too, but "needs WR" would mislead.
      var topNeeds = TF.teamSummary(m, f).needs.slice(0, 2);
      var surByG = {};
      (tm.surplus || []).forEach(function (s) { surByG[s.group] = (surByG[s.group] || 0) + 1; });
      return '<tr class="' + (f === me ? "fo-tf-me" : "") + (f === sel.partner ? " fo-tf-sel" : "") + '">' +
        '<th scope="row">' + (f === me ? H.esc(tm.name) + ' <span class="fo-muted">(you)</span>'
          : '<button type="button" class="fo-plink" data-tf-partner="' + H.esc(f) + '">' + H.esc(tm.name) + "</button>") + "</th>" +
        '<td class="num fo-tf-cell" data-tf-row="ALL">' + H.esc(LS.cell(tb, f, "ALL", "above").text) + repMark(tr.ALL.replacementStarters, "includes a replacement-filled slot") + "</td>" +
        MATRIX_GROUPS.map(function (g) {
          var v = tr[g].above, need = tm.need[g], sur = surByG[g] || 0, nRep = tr[g].replacementStarters;
          var text = LS.cell(tb, f, g, "above").text;
          var title = (GLABEL[g] || g) + ": starters " + text + " pts/wk above replacement" + (need >= 1 ? "; needs +" + H.fmt1(need) + " from a typical starter" : "") +
            (nRep ? "; " + nRep + " slot" + (nRep === 1 ? "" : "s") + " filled by a replacement free agent (no available rostered player)" : "") +
            (sur ? "; " + sur + " bench player" + (sur === 1 ? "" : "s") + " would start elsewhere" : "");
          return '<td class="num fo-tf-cell' + (TF.FIT_EXCLUDED_GROUPS[g] ? " fo-tf-kp" : "") + '" data-tf-row="' + g + '" style="' + cellStyle(v, max) + '" title="' + H.esc(title) + '">' + H.esc(text) + repMark(nRep, "includes a replacement-filled slot") +
            (topNeeds.indexOf(g) !== -1 ? '<span class="fo-tf-need" aria-label="one of the top two needs">▼</span>' : "") +
            (sur && !TF.FIT_EXCLUDED_GROUPS[g] ? '<span class="fo-tf-sur" aria-label="surplus">+' + sur + "</span>" : "") + "</td>";
        }).join("") + "</tr>";
    }).join("");
    return '<div class="fo-table-scroll"><table class="fo-table fo-tf-matrix"><thead>' + head + "</thead><tbody>" + rows + "</tbody></table></div>" +
      '<p class="fo-basis">Cell = starters’ points a week above replacement at that position (Σ starter PPG − replacement-level PPG; 0 = replacement level): the same numbers as the Overview’s Lineup strength (By Position, Above Replacement). Each lineup is the team’s own roster; <span class="fo-ov-rep">*</span> = a slot no available rostered player can fill, counted at a replacement free agent’s points. <span class="fo-tf-need">▼</span> = one of the team’s two biggest needs (what a typical starter would add; 1+ pts/wk). <span class="fo-tf-sur">+n</span> = bench players who would start for another team (surplus). K and P are shown, never used for fits.</p>';
  }

  function playerRef(pid) {
    var r = H.rosterIndex()[String(pid)];
    if (!r) return { name: pid, pos: "", fid: "" };
    return { name: r.p.name, pos: r.p.position, fid: r.fid, p: r.p, team: r.p.nflTeam };
  }
  function ppgOf(pid) { var l = H.seasonLine(pid, 0); return l && l.ppg != null ? H.fmt1(l.ppg) + " PPG" + (l.games ? " · " + l.games + " wk" + (l.games === 1 ? "" : "s") : "") : "no MFL weeks"; }
  function smallSample(pid) {
    var ss = H.scoring(), l = H.seasonLine(pid, 0);
    return ss && l && l.games < ss.rankMinimum(0);
  }

  function partnerHtml(m, alt, me, f, list) {
    var tm = m.teams[f], mine = m.teams[me];
    var sum = TF.teamSummary(m, f), mySum = TF.teamSummary(m, me);
    var bait = baitMap();
    var p = (list || []).filter(function (x) { return x.fid === f; })[0];
    var fits = p ? p.fits : TF.pairFits(m, me, f, { alt: alt, capRoom: capRoom(), limit: 50 });
    var room = FO.capFor(f), myRoom = FO.capFor(me);
    var gl = function (g) { return GLABEL[g] || g; };
    var strong = sum.strong.length ? sum.strong.map(function (g) { return "<b>" + gl(g) + "</b> (" + H.signed1(tm.vsMedian[g]) + " vs the league median)"; }).join(", ") : "nowhere clearly above the median";
    var needs = sum.needs.length ? sum.needs.map(function (g) { return "<b>" + gl(g) + "</b> (+" + H.fmt1(tm.need[g]) + ")"; }).join(", ") : "no position with a 1+ pt/wk gap";
    // What I could offer: my surplus that helps THEM; what they could offer: their surplus that helps ME.
    var myOffer = (mine.surplus || []).map(function (s) { var g = s.gains.filter(function (x) { return x.fid === f; })[0]; return g ? { s: s, gain: g.gain } : null; }).filter(Boolean).sort(function (a, b) { return b.gain - a.gain; });
    var theirOffer = (tm.surplus || []).map(function (s) { var g = s.gains.filter(function (x) { return x.fid === me; })[0]; return g ? { s: s, gain: g.gain } : null; }).filter(Boolean).sort(function (a, b) { return b.gain - a.gain; });
    var offerList = function (arr, ownerFid, whoGains) {
      if (!arr.length) return '<p class="fo-ov-empty">None on today’s numbers.</p>';
      return '<ul class="fo-tf-list">' + arr.slice(0, 6).map(function (x) {
        var r = playerRef(x.s.pid);
        return "<li>" + H.playerButton(x.s.pid, ownerFid, r.name) + (r.p ? H.injuryChip(r.p) : "") + ' <span class="fo-muted">' + H.esc(r.pos) + " · " + H.esc(ppgOf(x.s.pid)) + "</span> — <b>+" + H.fmt1(x.gain) + "</b> pts/wk for " + whoGains +
          (bait.players[x.s.pid] === ownerFid ? ' <span class="fo-av fo-av-bait">On the block</span>' : "") + "</li>";
      }).join("") + "</ul>";
    };
    var fitRows = fits.slice(0, 12).map(function (x) {
      var give = playerRef(x.give), get = playerRef(x.get);
      var notes = [];
      if (x.overCap) notes.push('<span class="fo-tf-flag bad" title="The app refuses a trade that leaves a team over the cap">over the cap</span>');
      if (x.holdsOnAlt === false) notes.push('<span class="fo-tf-flag warn" title="On the last 4 final weeks at least one side no longer gains">not on last 4 wks</span>');
      if (x.idpOnly) notes.push('<span class="fo-tf-flag" title="IDP production is the least predictable (backtest)">IDP only</span>');
      if (smallSample(x.give) || smallSample(x.get)) notes.push('<span class="fo-tf-flag warn">small sample</span>');
      if (bait.players[x.get] === f) notes.push('<span class="fo-av fo-av-bait">their block</span>');
      if (bait.players[x.give] === me) notes.push('<span class="fo-av fo-av-bait">your block</span>');
      var repTitle = function (list, who) {
        return list.length ? who + " would need a replacement free agent at " + list.map(function (r) { return r.slot; }).join(", ") + " (no available rostered player left), counted at " + list.map(function (r) { return H.fmt1(r.v); }).join(", ") + " pts/wk" : "";
      };
      var yrs = function (r) { return r.p ? (r.p.years > 0 ? r.p.years + "y" : "exp") + " · " + H.money(r.p.salary) : ""; };
      var url = FO.warRoomUrl({ twb_left_team: me, twb_right_team: f, twb_give: x.give, twb_get: x.get });
      return "<tr>" +
        "<td>" + H.playerButton(x.give, me, give.name) + (give.p ? H.injuryChip(give.p) : "") + '<div class="fo-muted fo-perf-sub">' + H.esc(give.pos) + " · " + H.esc(ppgOf(x.give)) + " · " + H.esc(yrs(give)) + "</div></td>" +
        "<td>" + H.playerButton(x.get, f, get.name) + (get.p ? H.injuryChip(get.p) : "") + '<div class="fo-muted fo-perf-sub">' + H.esc(get.pos) + " · " + H.esc(ppgOf(x.get)) + " · " + H.esc(yrs(get)) + "</div></td>" +
        '<td class="num"' + (x.repA.length ? ' title="' + H.esc(repTitle(x.repA, "You")) + '"' : "") + "><b>+" + H.fmt1(x.gainA) + "</b>" + repMark(x.repA.length, "your lineup would include a replacement free agent") + "</td>" +
        '<td class="num"' + (x.repB.length ? ' title="' + H.esc(repTitle(x.repB, "They")) + '"' : "") + ">+" + H.fmt1(x.gainB) + repMark(x.repB.length, "their lineup would include a replacement free agent") + "</td>" +
        '<td class="num">' + (x.capAfterA == null ? "—" : H.esc(H.money(x.capAfterA))) + '<div class="fo-muted fo-perf-sub">them ' + (x.capAfterB == null ? "—" : H.esc(H.money(x.capAfterB))) + "</div></td>" +
        "<td>" + notes.join(" ") + "</td>" +
        '<td><a class="fo-go" href="' + H.esc(url) + '" target="_top" title="Opens the Trade War Room with this swap loaded. Nothing is sent until you send it there.">War Room ↗</a></td></tr>';
    }).join("");
    var picks = DATA.get("picks");
    var theirPicks = "";
    if (picks && picks.state === "ok") {
      var row = H.asArray(picks.data.futureDraftPicks && picks.data.futureDraftPicks.franchise).filter(function (x) { return x.id === f; })[0];
      theirPicks = H.asArray(row && row.futureDraftPick).sort(function (a, b) { return (a.year - b.year) || (a.round - b.round); })
        .map(function (pk) { return pk.year + " R" + pk.round + (pk.originalPickFor !== f ? " (via " + H.teamName(pk.originalPickFor) + ")" : ""); }).join(", ");
    }
    var note = bait.notes[f];
    return '<div class="fo-card fo-tf-partner">' +
      '<div class="fo-card-head"><h2>' + H.esc(tm.name) + "</h2>" +
      '<a class="fo-go" href="' + H.esc(FO.warRoomUrl({ twb_left_team: me, twb_right_team: f })) + '" target="_top">Open War Room with ' + H.esc(tm.name) + " ↗</a></div>" +
      '<div class="fo-tf-cols">' +
        '<div><h4>They look strong at</h4><p>' + strong + "</p><h4>They need</h4><p>" + needs + "</p>" +
          "<h4>Cap and picks</h4><p>" + (room ? "Cap room " + H.esc(H.money(room.capSpace)) : "Cap room unknown") + (theirPicks ? " · Picks: " + H.esc(theirPicks) : "") + "</p>" +
          (note ? '<h4>Their trade-block note</h4><p class="fo-tf-note">' + H.esc(note) + "</p>" : "") + "</div>" +
        "<div><h4>You could offer (your surplus that helps them)</h4>" + offerList(myOffer, me, "them") +
          "<h4>They could offer (their surplus that helps you)</h4>" + offerList(theirOffer, f, "you") + "</div>" +
      "</div>" +
      '<h4 class="fo-tf-h">Swaps that improve both lineups</h4>' +
      (fitRows ? '<div class="fo-table-scroll"><table class="fo-table fo-tf-fits"><thead><tr><th scope="col">You give</th><th scope="col">You get</th>' +
        '<th scope="col" class="num" title="Your best lineup, points a week, after the swap minus before">Your gain</th><th scope="col" class="num" title="Their best lineup, points a week">Their gain</th>' +
        '<th scope="col" class="num" title="Cap room after the swap (MFL formula); over the cap is refused by the app">Cap after</th><th scope="col">Checks</th><th scope="col"></th></tr></thead><tbody>' + fitRows + "</tbody></table></div>"
        : '<p class="fo-ov-empty">No 1-for-1 swap improves both lineups on today’s numbers.</p>') +
      '<p class="fo-basis">A swap is listed when both best legal lineups gain points a week (season PPG). <span class="fo-ov-rep">*</span> on a gain = after the swap that team has no available rostered player for a slot, so a replacement free agent’s points fill it (hover for the slot). It says nothing about fairness, contract value, age or picks; those are shown, not scored. Nothing here sends an offer.</p>' +
      "</div>";
  }

  function render() {
    var el = document.getElementById("fo-trades-body");
    if (!el) return;
    H.wireClicks(el);
    var se = DATA.get("scores");
    if (!se || !DATA.get("players")) { H.loading(el, "Reading MFL’s scores and players…"); return; }
    var ss = H.scoring();
    if (!ss) { el.innerHTML = H.banner("MFL’s scores couldn’t be read, so the Trade finder is off. Reload to retry.", "warn"); return; }
    // Never this season's numbers before MFL has scored a week (standing rule for anything citing player value).
    if (!ss.seasonWeeks.length) { el.innerHTML = H.banner("The Trade finder starts once MFL has scored a week this season.", "info"); return; }
    var slotState = H.lineupSlotsState();
    if (!slotState) { H.loading(el, "Reading MFL’s lineup settings…"); return; }
    if (slotState === "error") { el.innerHTML = H.banner("MFL’s lineup settings couldn’t be read, so the Trade finder is off. Reload to retry.", "warn"); return; }
    var mm = models(), m = mm.m;
    if (!m) { H.loading(el, "Building the league model…"); return; }
    var me = myFid();
    var F = root.UPS_PLAYER_FACTS, basis = F ? F.basis(ss) : { text: "" };
    var head = '<div class="fo-card"><div class="fo-card-head"><h2>Trade finder</h2>' +
      '<span class="small fo-muted">Discovery, not a fairness grade · values = season PPG per MFL week</span></div>' +
      '<p class="fo-basis">' + H.esc(basis.text) + "</p>" + matrixHtml(m, me) + "</div>";
    if (!me) { el.innerHTML = head + H.banner("Pick a team (Roster → Team) to see partners and swaps for it.", "info"); return; }
    var list = partners(m, mm.alt, me);
    if (!sel.partner || sel.partner === me) sel.partner = list[0] ? list[0].fid : "";
    var partnersHtml = '<div class="fo-card"><h3 class="fo-tf-h">Logical partners for ' + H.esc(H.teamName(me)) + '</h3><ol class="fo-tf-partners">' + list.map(function (x) {
      var b = x.best;
      return '<li class="' + (x.fid === sel.partner ? "sel" : "") + '"><button type="button" class="fo-plink" data-tf-partner="' + H.esc(x.fid) + '">' + H.esc(H.teamName(x.fid)) + "</button>" +
        ' <span class="fo-muted">' + (b ? x.count + " swap" + (x.count === 1 ? "" : "s") + " · best +" + H.fmt1(b.gainA) + " / +" + H.fmt1(b.gainB) + " pts/wk" : "no mutual swap") + "</span></li>";
    }).join("") + "</ol></div>";
    el.innerHTML = head + '<div class="fo-tf-grid">' + partnersHtml + (sel.partner ? partnerHtml(m, mm.alt, me, sel.partner, list) : "") + "</div>";
    H.setFreshness("MFL read " + H.clock(ss.fetchedAt));
  }

  function wire() {
    var el = document.getElementById("fo-trades-body");
    if (!el || el.__tfWired) return;
    el.__tfWired = true;
    el.addEventListener("click", function (e) {
      var t = e.target && e.target.closest ? e.target.closest("[data-tf-partner]") : null;
      if (!t) return;
      sel.partner = t.getAttribute("data-tf-partner");
      render();
      var pc = document.querySelector(".fo-tf-partner");
      if (pc && pc.scrollIntoView) pc.scrollIntoView({ block: "nearest" });
    });
  }
  function load() {
    ["scores", "players", "league", "tradeBait", "picks"].forEach(function (k) { DATA.load(k).then(rerender); });
  }
  function rerender() {
    var a = document.querySelector(".fo-section.active");
    if (a && a.getAttribute("data-section") === "trades") render();
  }

  if (root.UPS_FO_HUB) root.UPS_FO_HUB.registerView("trades");
  root.UPS_FO_TRADES = { _sel: sel };
  document.addEventListener("fo:ready", function () {
    H = root.UPS_FO_HUB; FO = root.UPS_FO; DATA = root.UPS_FO_DATA; TF = root.UPS_TRADE_FIT; LS = root.UPS_LINEUP_STRENGTH;
    if (!H || !FO || !DATA || !TF || !LS) return;
    wire();
    H.registerAbout("trades", "<h3>Trade finder</h3>" +
      "<p><b>Discovery, not a fairness grade.</b> It shows where each team is strong or short and which one-for-one swaps would improve <b>both</b> teams’ best legal lineups. It never proposes, sends or messages anything; the War Room links open the one Trade War Room with the swap loaded.</p><ul>" +
      "<li><b>Value</b> = season points per MFL-scored week (MFL’s own scoring). In a 2022–2025 backtest it ranked whole lineups better than the last 3–4 weeks (rank correlation .70 vs .62). RotoWire projections did better for offense but aren’t served to the app yet.</li>" +
      "<li><b>Best legal lineup</b> = the league’s 18 slots (QB, 2 RB, 2 WR, TE, 2 Flex, SuperFlex, K, P, 2 DL, 2 LB, 2 DB, D-Flex), filled from the team’s <b>own available rostered players</b>. A free agent fills a slot only when no rostered player can play it, at replacement level (the 3rd-best free agent at QB/RB/WR/TE, 6th at K/P, 12th at DL/LB/DB), and is marked <b>*</b>. A free agent never starts because he outscores someone on the roster. A swap’s gain is marked * when it would leave a slot to a free agent.</li>" +
      "<li><b>Strength</b> = starters’ points a week above replacement (Σ starter PPG − replacement-level PPG): the same numbers as the Overview’s Lineup strength (By Position, Above Replacement), from the same lineups. <b>Need</b> = points a week a typical (median) starter would add. <b>Surplus</b> = a healthy bench player who would start for another team.</li>" +
      "<li><b>Checks</b>: whether the swap still works on the last 4 final weeks; small samples; IDP-only (the least predictable); cap room after (over the cap is refused by the app).</li>" +
      "<li>Not scored: contract length, salary value, age, draft picks, dynasty value. Kickers and punters never drive a swap (they barely predict).</li></ul>");
  });
  document.addEventListener("fo:tab", function (e) { if (H && e.detail && e.detail.section === "trades") { render(); load(); } });
  document.addEventListener("fo:injury", rerender);
})(typeof window !== "undefined" ? window : this);
