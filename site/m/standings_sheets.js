/* Standings drawers (#1329): the full-width bottom sheet that holds the explanations (How seeding works, Why this
   order, About, About weekly) and the playoff / Hawk Tuah Bowl "Tale of the Tape". Same .ups-m-sheet overlay pattern
   as team_sheet.js, with its own mount and ids. Pure view module: every number is computed by
   site/shared/standings_race.js (matchupTape, ownerSeries) and passed in by site/m/views/league.js; this file fetches
   nothing. */
(function () {
  "use strict";
  if (!window.UPS_MOBILE) return;
  var M = window.UPS_MOBILE;
  var U = M.util;
  var lastTrigger = null;

  function ensureMount() {
    var mount = document.getElementById("ups-m-info-sheet-mount");
    if (!mount && document.body && document.createElement) {
      mount = document.createElement("div");
      mount.id = "ups-m-info-sheet-mount";
      document.body.appendChild(mount);
    }
    if (!mount) return null;
    if (!mount.firstChild) {
      mount.innerHTML =
        '<div class="ups-m-sheet-overlay" id="ups-m-info-sheet-overlay">' +
        '  <div class="ups-m-sheet ups-m-info-sheet" id="ups-m-info-sheet" role="dialog" aria-modal="true" aria-labelledby="ups-m-info-sheet-title">' +
        '    <button class="ups-m-sheet-close" id="ups-m-info-sheet-close" aria-label="Close">×</button>' +
        '    <div class="ups-m-sheet-head" id="ups-m-info-sheet-head"></div>' +
        '    <div class="ups-m-sheet-body" id="ups-m-info-sheet-body"></div>' +
        '  </div>' +
        '</div>';
      var overlay = document.getElementById("ups-m-info-sheet-overlay");
      overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
      document.getElementById("ups-m-info-sheet-close").addEventListener("click", close);
      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && overlay.classList.contains("open")) close();
      });
    }
    return mount;
  }
  function close() {
    var overlay = document.getElementById("ups-m-info-sheet-overlay");
    if (overlay) overlay.classList.remove("open");
    document.body.style.overflow = "";
    if (lastTrigger && typeof lastTrigger.focus === "function") { try { lastTrigger.focus(); } catch (e) {} }
    lastTrigger = null;
  }
  // open({ title, sub, body (html), trigger })
  function open(o) {
    if (!ensureMount()) return;
    o = o || {};
    lastTrigger = o.trigger || document.activeElement;
    document.getElementById("ups-m-info-sheet-head").innerHTML =
      '<div class="ups-m-sheet-head-text"><div class="name" id="ups-m-info-sheet-title">' + U.escapeHtml(o.title || "") + '</div>' +
      (o.sub ? '<div class="sub">' + U.escapeHtml(o.sub) + '</div>' : '') + '</div>';
    document.getElementById("ups-m-info-sheet-body").innerHTML = o.body || "";
    document.getElementById("ups-m-info-sheet-overlay").classList.add("open");
    document.body.style.overflow = "hidden";
    var btn = document.getElementById("ups-m-info-sheet-close");
    if (btn && btn.focus) { try { btn.focus(); } catch (e) {} }
  }
  function setBody(html) {
    var b = document.getElementById("ups-m-info-sheet-body");
    var overlay = document.getElementById("ups-m-info-sheet-overlay");
    if (b && overlay && overlay.classList.contains("open")) b.innerHTML = html;
  }

  // ── Tale of the Tape ──────────────────────────────────────────────────
  function ord(n) {
    if (n == null) return "—";
    var s = ["th", "st", "nd", "rd"], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function p1(v) { var n = Number(v); return v == null || !isFinite(n) ? "—" : n.toFixed(1); }
  function rec(r) { return r ? (r.w || 0) + "-" + (r.l || 0) + (r.t ? "-" + r.t : "") : "—"; }
  // One comparison row: A value | label | B value; the stronger side (edge 'a' / 'b') is bold with a ▲ — never color alone.
  function row(label, aHtml, bHtml, edge, note) {
    function cell(html, side) {
      var on = edge === side;
      return '<td class="tape-v' + (on ? ' edge' : '') + '">' + (on ? '<span class="tape-edge" aria-label="edge">▲</span> ' : '') + html + '</td>';
    }
    return '<tr>' + cell(aHtml, "a") + '<th scope="row" class="tape-k">' + U.escapeHtml(label) + (note ? '<span class="tape-note">' + U.escapeHtml(note) + '</span>' : '') + '</th>' + cell(bHtml, "b") + '</tr>';
  }
  function vr(value, rank, suffix) { return '<b>' + value + '</b> <span class="tape-rk">' + ord(rank) + (suffix || "") + '</span>'; }
  // ctx: { kind: 'projected' | 'final' | 'scheduled', roundLabel, aSeed, bSeed (display labels), aOwner, bOwner,
  //        series (R.ownerSeries result, or { status: 'loading' }), offenseIdpLoading, weeksNote }
  function tapeHtml(t, ctx) {
    ctx = ctx || {};
    if (!t || t.status !== "ok") {
      var why = t && t.status === "preseason" ? "No games played yet." : "The weekly results couldn’t be verified, so nothing is compared.";
      return '<div class="ups-m-stub" role="alert"><div>' + why + '</div></div>';
    }
    var a = t.a, b = t.b, e = t.edges || {};
    var aN = U.escapeHtml(a.name), bN = U.escapeHtml(b.name);
    var label = ctx.kind === "projected" ? "Projected matchup — if the season ended today" : ctx.kind === "final" ? "Final" : "Current matchup";
    var head = '<div class="ups-m-card tape-head">' +
      '<div class="tape-kind' + (ctx.kind === "projected" ? " proj" : "") + '">' + U.escapeHtml(label) + (ctx.roundLabel ? ' · ' + U.escapeHtml(ctx.roundLabel) : '') + '</div>' +
      '<div class="tape-teams">' +
        '<div class="tape-team"><span class="tape-seed">' + U.escapeHtml(ctx.aSeed || "") + '</span><span class="tape-name">' + aN + '</span><span class="tape-owner">' + U.escapeHtml(ctx.aOwner || "") + '</span>' +
          '<span class="tape-recs">H2H ' + rec(a.record) + ' · All-Play ' + rec(a.ap) + '</span></div>' +
        '<div class="tape-vs">vs</div>' +
        '<div class="tape-team"><span class="tape-seed">' + U.escapeHtml(ctx.bSeed || "") + '</span><span class="tape-name">' + bN + '</span><span class="tape-owner">' + U.escapeHtml(ctx.bOwner || "") + '</span>' +
          '<span class="tape-recs">H2H ' + rec(b.record) + ' · All-Play ' + rec(b.ap) + '</span></div>' +
      '</div>' +
      '<div class="tape-met">' + metText(t, aN, bN) + '</div>' +
    '</div>';
    var q = t.quickEdges || { a: 0, b: 0, even: 0 };
    var weeks = t.weeks || {};
    var l3 = weeks.last3 && weeks.last3.length ? "Weeks " + weeks.last3[0] + "–" + weeks.last3[weeks.last3.length - 1] : "";
    var quick = '<div class="ups-m-card"><div class="ups-m-card-title">1 · Quick edge</div>' +
      '<div class="tape-sum">Edges: ' + aN + ' ' + q.a + ', ' + bN + ' ' + q.b + (q.even ? ', even ' + q.even : '') + ' (of 5). What has happened so far, not a prediction.</div>' +
      '<table class="tape-table"><tbody>' +
        row("Season scoring average", vr(p1(a.avg.value), a.avg.rank), vr(p1(b.avg.value), b.avg.rank), e.avg, "regular season, per week") +
        row("Last 3 weeks average", vr(p1(a.last3.avg), a.last3.rank), vr(p1(b.last3.avg), b.last3.rank), e.last3, l3) +
        row("Last 3 weeks All-Play", '<b>' + rec(a.last3.ap) + '</b>', '<b>' + rec(b.last3.ap) + '</b>', e.last3ap) +
        row("All-Play wins per week", vr(p1(a.apPerWeek.value), a.apPerWeek.rank), vr(p1(b.apPerWeek.value), b.apPerWeek.rank), e.apPerWeek, "of 11") +
        row("Consistency", '<b>' + ord(a.consistency.rank) + '</b> <span class="tape-rk">±' + p1(a.consistency.spread) + '</span>', '<b>' + ord(b.consistency.rank) + '</b> <span class="tape-rk">±' + p1(b.consistency.spread) + '</span>', e.consistency, "1st = steadiest week to week") +
      '</tbody></table>' +
      '<div class="tape-foot">Ranks are among all 12 teams. Last 3 weeks describes recent results; the full season has predicted the rest of a season better.</div></div>';
    var c = function (s) { return s.ceiling; };
    var ctf = '<div class="ups-m-card"><div class="ups-m-card-title">2 · Ceiling / Typical / Floor</div>' +
      '<table class="tape-table"><tbody>' +
        row("Highest week", vr(p1(c(a).high.value), c(a).high.rank) + wk(c(a).high.week), vr(p1(c(b).high.value), c(b).high.rank) + wk(c(b).high.week), e.high) +
        row("Average of top 3", vr(p1(c(a).top3.value), c(a).top3.rank), vr(p1(c(b).top3.value), c(b).top3.rank), e.top3) +
        row("Median week", vr(p1(c(a).median.value), c(a).median.rank), vr(p1(c(b).median.value), c(b).median.rank), e.median) +
        row("Average of bottom 3", vr(p1(c(a).bottom3.value), c(a).bottom3.rank), vr(p1(c(b).bottom3.value), c(b).bottom3.rank), e.bottom3) +
        row("Lowest week", vr(p1(c(a).low.value), c(a).low.rank) + wk(c(a).low.week), vr(p1(c(b).low.value), c(b).low.rank) + wk(c(b).low.week), e.low) +
      '</tbody></table><div class="tape-foot">Regular-season weekly scores.</div></div>';
    var oi;
    if (a.offense && b.offense) {
      oi = row("Offense points per week", vr(p1(a.offense.perWeek), a.offense.rank), vr(p1(b.offense.perWeek), b.offense.rank), e.offense, "offensive players") +
        row("IDP points per week", vr(p1(a.idp.perWeek), a.idp.rank), vr(p1(b.idp.perWeek), b.idp.rank), e.idp, "defensive players");
    } else {
      var oiWhy = ctx.offenseIdpLoading ? "Loading…" : t.offenseIdpStatus === "mismatch" ? "MFL’s offense / IDP totals don’t add up to the weekly scores, so they aren’t shown." : "Not available for this season.";
      oi = '<tr><td colspan="3" class="tape-na">Offense / IDP points: ' + U.escapeHtml(oiWhy) + '</td></tr>';
    }
    var full = '<div class="ups-m-card"><div class="ups-m-card-title">3 · Full comparison</div>' +
      '<table class="tape-table"><tbody>' + oi +
        row("Points faced per H2H game", '<b>' + p1(a.faced.perGame) + '</b> <span class="tape-rk">' + ord(a.faced.rank) + ' most</span>', '<b>' + p1(b.faced.perGame) + '</b> <span class="tape-rk">' + ord(b.faced.rank) + ' most</span>', null, "schedule experience, not skill") +
      '</tbody></table>' + seriesHtml(ctx.series, aN, bN, ctx.aOwner, ctx.bOwner) + '</div>';
    return head + quick + ctf + full;
  }
  function wk(w) { return w ? ' <span class="tape-rk">Wk ' + w + '</span>' : ''; }
  function metText(t, aN, bN) {
    var m = t.meetings || [];
    if (!m.length) return "They haven’t played each other this season.";
    return "This season: " + m.map(function (g) {
      var who = g.result === "W" ? aN : g.result === "L" ? bN : "Tie";
      return (g.isPlayoff ? "Playoff week " : "Week ") + g.week + " — " + who + (g.result === "T" ? "" : " won") + ", " + p1(g.aScore) + "–" + p1(g.bScore);
    }).join(" · ");
  }
  function seriesHtml(s, aN, bN, aOwner, bOwner) {
    var title = '<div class="tape-series-t">H2H history · ' + U.escapeHtml(aOwner || "") + ' vs ' + U.escapeHtml(bOwner || "") + '</div>';
    if (!s || s.status === "loading") return '<div class="tape-series">' + title + '<div class="tape-na">Loading…</div></div>';
    if (s.status !== "ok") return '<div class="tape-series">' + title + '<div class="tape-na">History unavailable.</div></div>';
    if (!s.games.length) return '<div class="tape-series">' + title + '<div class="tape-na">No recorded games between these two owners.</div></div>';
    var tog = s.seasonsTogether || [];
    var span = tog.length ? tog[0] + (tog.length > 1 ? "–" + tog[tog.length - 1] : "") : "";
    var games = s.games.slice().reverse().slice(0, 12).map(function (g) {
      var res = g.result === "W" ? aN : g.result === "L" ? bN : "Tie";
      return '<li>' + g.season + (g.isPlayoff ? ' playoffs wk ' : ' wk ') + g.week + ': ' + res + ' ' + p1(g.aScore) + '–' + p1(g.bScore) + '</li>';
    }).join("");
    return '<div class="tape-series">' + title +
      '<div class="tape-series-rec">Regular season <b>' + rec(s.regular) + '</b> · Playoffs <b>' + rec(s.playoff) + '</b> <span class="tape-rk">(' + aN + ' first)</span></div>' +
      '<div class="tape-foot">Seasons both were owner of record: ' + U.escapeHtml(span) + '. Regular-season games exist for ' + U.escapeHtml((s.pairingSeasons || []).join(", ") || "no shared season") +
        ' (MFL kept no game-by-game schedule for 2010–2011 and 2013–2019; those seasons count playoff games only). A team’s earlier owners’ games are not included.</div>' +
      '<ul class="tape-series-list">' + games + '</ul>' + (s.games.length > 12 ? '<div class="tape-foot">Latest 12 of ' + s.games.length + ' games.</div>' : '') + '</div>';
  }

  M.standingsSheet = { open: open, setBody: setBody, close: close, tapeHtml: tapeHtml };
})();
