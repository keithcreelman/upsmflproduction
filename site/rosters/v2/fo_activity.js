/* Front Office → Contracts & Cap → Draft picks, and → Activity (#1338). Read-only.

   Draft picks: who holds every future pick (MFL futureDraftPicks). The viewer's
   own picks are checked for lineup-penalty forfeits (#1229) through
   /api/franchise-assets (one read, the viewer's team only); other teams'
   forfeits are marked in the Trade War Room. Round 6 picks can't be traded
   (canon §A6). Pick slots are not projected here (how future picks are valued
   is an open decision, #1337).

   Activity: the claims MFL holds for the viewer (signed in; each checked
   against the league's waiver resolver: "MFL will refuse this claim" when
   the player can't be awarded at that run) and the last 14 days of adds, drops,
   trades and IR/taxi moves from MFL's transaction log. Claims are edited in the
   phone app; nothing here changes them.
*/
(function (root) {
  "use strict";

  var H, FO, DATA;
  var moves = { scope: "mine" };
  var BLOCKING = { waivers_later: 1, game_locked: 1, not_before_kickoff: 1, closed: 1, unknown: 1 };

  function myFid() {
    var me = FO.viewerFid(), s = FO.selectedTeam();
    if (s && s !== "__all__") return s;
    return me && FO.teams().some(function (t) { return t.fid === me; }) ? me : "";
  }
  // A holder's name for a narrow cell: the franchise name without emoji or symbols (MFL abbreviations mix both).
  function short(fid) {
    var t = FO.teams().filter(function (x) { return x.fid === fid; })[0];
    var n = t ? String(t.name || "") : String(fid);
    return n.replace(/[^\p{L}\p{N} .'&$-]/gu, "").replace(/\s+/g, " ").trim() || n;
  }

  // ── Draft picks ───────────────────────────────────────────────────
  // { "2027": { "<original fid>": { "<round>": holder fid } } } from MFL's futureDraftPicks.
  function holders(json) {
    H = H || root.UPS_FO_HUB;   // pure helper: usable before fo:ready (tests)
    var out = {};
    H.asArray(json && json.futureDraftPicks && json.futureDraftPicks.franchise).forEach(function (f) {
      H.asArray(f.futureDraftPick).forEach(function (p) {
        var y = String(p.year), o = H.pad4(p.originalPickFor), r = String(p.round);
        ((out[y] = out[y] || {})[o] = out[y][o] || {})[r] = H.pad4(f.id);
      });
    });
    return out;
  }
  // The rounds MFL lists for one year (Round 6 isn't tradeable, so MFL keeps no future Round 6 picks).
  function roundsOf(yearHold) {
    var seen = {};
    Object.keys(yearHold || {}).forEach(function (o) { Object.keys(yearHold[o]).forEach(function (r) { seen[r] = 1; }); });
    return Object.keys(seen).sort(function (x, y) { return x - y; });
  }
  function renderPicks() {
    var el = document.getElementById("fo-picks-body");
    if (!el) return;
    var e = DATA.get("picks");
    if (!e) { H.loading(el, "Reading MFL’s future picks…"); return; }
    if (e.state !== "ok") { el.innerHTML = H.banner("MFL’s future draft picks couldn’t be read. Reload to retry.", "warn"); return; }
    var me = myFid(), hold = holders(e.data);
    var fa = me ? DATA.get("franchiseAssets", me) : null;
    var forfeited = {}, forfeitKnown = false;
    if (fa && fa.state === "ok" && fa.data && fa.data.forfeit_check === "ok") {
      forfeitKnown = true;
      H.asArray(fa.data.future_picks).forEach(function (p) { if (p && p.forfeited) forfeited[String(p.year) + "|" + H.pad4(p.original_fid || p.originalPickFor) + "|" + String(p.round)] = p.forfeit_label || "Forfeited"; });
    }
    var teams = FO.teams().slice().sort(function (a, b) { return a.fid === me ? -1 : b.fid === me ? 1 : a.name.localeCompare(b.name); });
    var years = Object.keys(hold).sort();
    var mine = [], away = [];
    years.forEach(function (y) {
      Object.keys(hold[y]).forEach(function (o) {
        Object.keys(hold[y][o]).forEach(function (r) {
          var h = hold[y][o][r];
          if (h === me) mine.push({ y: y, o: o, r: r });
          else if (o === me) away.push({ y: y, o: o, r: r, h: h });
        });
      });
    });
    var pickTxt = function (p) {
      var k = p.y + "|" + p.o + "|" + p.r;
      return p.y + " R" + p.r + (p.o !== me ? " (via " + H.esc(H.teamName(p.o)) + ")" : "") +
        (forfeited[k] ? ' <span class="fo-tf-flag bad" title="' + H.esc(forfeited[k]) + '">forfeited</span>' : "") +
        (p.r === "6" ? ' <span class="fo-muted">not tradeable</span>' : "");
    };
    var summary = me ? '<div class="fo-tf-cols"><div><h4>You hold</h4><p>' + (mine.length ? mine.sort(function (a, b) { return (a.y - b.y) || (a.r - b.r); }).map(pickTxt).join(", ") : "no future picks") + "</p></div>" +
      "<div><h4>Your picks held by other teams</h4><p>" + (away.length ? away.map(function (p) { return p.y + " R" + p.r + " → " + H.esc(H.teamName(p.h)); }).join(", ") : "none") + "</p></div></div>" +
      (forfeitKnown ? "" : '<p class="fo-basis warn">Lineup-penalty forfeits couldn’t be checked for your picks right now; the Trade War Room greys any forfeited pick.</p>') : "";
    var tables = years.map(function (y) {
      var rounds = roundsOf(hold[y]);
      var rows = teams.map(function (t) {
        var row = (hold[y] && hold[y][t.fid]) || {};
        return '<tr class="' + (t.fid === me ? "fo-tf-me" : "") + '"><th scope="row">' + H.esc(t.name) + "</th>" + rounds.map(function (r) {
          var h = row[r];
          var k = y + "|" + t.fid + "|" + r;
          if (!h) return '<td class="num fo-muted" title="Not in MFL’s future picks">—</td>';
          var own = h === t.fid;
          return '<td class="num' + (own ? " fo-muted" : " fo-pk-moved") + (h === me ? " fo-pk-mine" : "") + '" title="' + H.esc(y + " round " + r + " of " + t.name + (own ? ": still theirs" : ": held by " + H.teamName(h))) + '">' +
            (own ? "own" : H.esc(short(h))) + (forfeited[k] ? " ✕" : "") + "</td>";
        }).join("") + "</tr>";
      }).join("");
      return '<h4 class="fo-tf-h">' + H.esc(y) + ' picks — whose pick (row) and who holds it now</h4><div class="fo-table-scroll"><table class="fo-table fo-pk-table"><thead><tr><th scope="col">Original team</th>' +
        rounds.map(function (r) { return '<th scope="col" class="num">R' + r + "</th>"; }).join("") + "</tr></thead><tbody>" + rows + "</tbody></table></div>";
    }).join("");
    el.innerHTML = '<div class="fo-card"><div class="fo-card-head"><h2>Draft picks</h2><span class="small fo-muted">MFL future picks · tradeable through next season (§A6)</span></div>' +
      summary + tables + '<p class="fo-basis">Every team keeps its Round 6 pick: it can’t be traded (the player can, once drafted). ✕ = forfeited (your team only). Pick positions (1.01–1.12) aren’t projected here.</p></div>';
  }

  // ── Activity ──────────────────────────────────────────────────────
  function txLines(tx, me, since) {
    H = H || root.UPS_FO_HUB;
    var pidx = H.playerIndex();
    var nm = function (id) { var p = pidx[id]; return p ? H.displayName(p.name) : (/^FP_|^DP_/.test(id) ? id.replace(/^FP_(\d{4})_(\d{4})_(\d)$/, function (_, f, y, r) { return y + " R" + r + " (" + H.teamName(f) + ")"; }) : id); };
    var ids = function (csv) { return String(csv || "").split(",").map(function (x) { return x.trim(); }).filter(Boolean); };
    var out = [];
    H.asArray(tx && tx.transactions && tx.transactions.transaction).forEach(function (t) {
      var ts = parseInt(t.timestamp, 10) * 1000;
      if (!(ts >= since)) return;
      var f = H.pad4(t.franchise), f2 = H.pad4(t.franchise2);
      if (moves.scope === "mine" && f !== me && f2 !== me) return;
      var line = null;
      if (t.type === "TRADE") {
        line = "<b>Trade</b>: " + H.esc(H.teamName(f)) + " gave " + H.esc(ids(t.franchise1_gave_up).map(nm).join(", ") || "—") + "; " + H.esc(H.teamName(f2)) + " gave " + H.esc(ids(t.franchise2_gave_up).map(nm).join(", ") || "—");
      } else if (t.type === "FREE_AGENT" || t.type === "BBID_WAIVER") {
        var parts = String(t.transaction || "").split("|");
        var adds = ids(parts[0]), drops = ids(parts[parts.length - 1]);
        var bid = t.type === "BBID_WAIVER" && parts.length === 3 ? " ($" + Number(parts[1]).toLocaleString("en-US") + ")" : "";
        line = "<b>" + H.esc(H.teamName(f)) + "</b>" + (adds.length ? " added " + H.esc(adds.map(nm).join(", ")) + bid + (t.type === "BBID_WAIVER" ? " on waivers" : "") : "") +
          (drops.length ? (adds.length ? "; " : " ") + "dropped " + H.esc(drops.map(nm).join(", ")) : "");
      } else if (t.type === "IR") {
        // MFL: deactivated = moved to IR, activated = back from IR.
        var toIr = ids(t.deactivated), fromIr = ids(t.activated);
        line = "<b>" + H.esc(H.teamName(f)) + "</b>" + (toIr.length ? " placed " + H.esc(toIr.map(nm).join(", ")) + " on IR" : "") +
          (fromIr.length ? (toIr.length ? ";" : "") + " activated " + H.esc(fromIr.map(nm).join(", ")) + " from IR" : "");
      } else if (t.type === "TAXI") {
        var up = ids(t.promoted), down = ids(t.demoted);
        line = "<b>" + H.esc(H.teamName(f)) + "</b>" + (up.length ? " promoted " + H.esc(up.map(nm).join(", ")) + " from the taxi squad" : "") +
          (down.length ? (up.length ? ";" : "") + " moved " + H.esc(down.map(nm).join(", ")) + " to the taxi squad" : "");
      }
      if (line) out.push({ ts: ts, html: line });
    });
    return out.sort(function (a, b) { return b.ts - a.ts; });
  }
  function claimsHtml(me) {
    var pend = DATA.get("waiverPending"), av = DATA.get("waiverAvailability");
    if (!pend) return '<p class="fo-muted">Reading the claims MFL holds…</p>';
    if (pend.state !== "ok" || !pend.data || pend.data.known !== true) {
      return '<p class="fo-ov-empty">Claims MFL holds for your team show here when you’re signed in to MFL (this page reads them with your MFL session; nothing is changed).</p>';
    }
    var a = av && av.state === "ok" && av.data && av.data.known ? av.data : null;
    var pidx = H.playerIndex();
    var rounds = H.asArray(pend.data.rounds).filter(function (r) { return H.asArray(r && r.picks).length; });
    if (!rounds.length) return '<p class="fo-ov-empty">MFL holds no claims for your team.</p>';
    var next = a && a.next_run_label ? a.next_run_label : "";
    return (next ? '<p class="fo-basis">Next run: ' + H.esc(next) + "</p>" : "") + rounds.map(function (r) {
      return "<h4 class=\"fo-tf-h\">Group " + H.esc(String(r.round || "")) + "</h4><ul class=\"fo-tf-list\">" + H.asArray(r.picks).map(function (pk) {
        var add = String(pk.add_pid || pk.add || ""), drop = String(pk.drop_pid || pk.drop || "");
        var pl = pidx[add] || {}, dl = pidx[drop] || {};
        var st = a ? ((a.players && a.players[add]) || (a.by_team && a.by_team[pl.team]) || a.no_game) : null;
        var warn = st && BLOCKING[st.code] ? ' <span class="fo-tf-flag bad" title="' + H.esc([st.headline].concat(st.lines || []).join("\n")) + '">MFL will refuse this claim at the next run</span>' : "";
        var bid = pk.bid_dollars != null ? " $" + Number(pk.bid_dollars).toLocaleString("en-US") : (pk.bid != null ? " $" + Number(pk.bid).toLocaleString("en-US") : "");
        return "<li>" + H.playerButton(add, "", H.displayName(pl.name || add)) + ' <span class="fo-muted">' + H.esc(pl.pos || "") + bid + "</span>" +
          (drop ? ' · drop ' + H.esc(H.displayName(dl.name || drop)) : "") + warn + "</li>";
      }).join("") + "</ul>";
    }).join("") + '<p class="fo-muted fo-perf-sub">Claims are edited in the phone app’s Market → Claims.</p>';
  }
  function renderMoves() {
    var el = document.getElementById("fo-moves-body");
    if (!el) return;
    H.wireClicks(el);
    var me = myFid();
    var tx = DATA.get("transactions");
    var since = Date.now() - 14 * 86400000;
    var list = tx && tx.state === "ok" ? txLines(tx.data, me, since) : [];
    var byDay = {};
    list.forEach(function (l) { var d = H.dayLabel(l.ts); (byDay[d] = byDay[d] || []).push(l); });
    var movesHtml = !tx ? '<p class="fo-muted">Reading MFL’s transaction log…</p>' :
      tx.state !== "ok" ? H.banner("MFL’s transaction log couldn’t be read.", "warn") :
      !list.length ? '<p class="fo-ov-empty">No moves in the last 14 days' + (moves.scope === "mine" ? " for your team" : "") + ".</p>" :
      Object.keys(byDay).map(function (d) { return '<h4 class="fo-tf-h">' + H.esc(d) + '</h4><ul class="fo-tf-list">' + byDay[d].map(function (l) { return "<li>" + l.html + "</li>"; }).join("") + "</ul>"; }).join("");
    el.innerHTML = '<div class="fo-tf-grid fo-act-grid">' +
      '<div class="fo-card"><h3 class="fo-tf-h">Claims MFL holds' + (me ? " for " + H.esc(H.teamName(me)) : "") + "</h3>" + claimsHtml(me) + "</div>" +
      '<div class="fo-card"><div class="fo-card-head"><h2>Recent moves</h2><div class="fo-choice-group"><div class="fo-choice-label" id="fo-lbl-mv">Show moves for</div><div class="fo-subview-chips fo-choice" role="group" aria-labelledby="fo-lbl-mv">' +
        '<button type="button" class="fo-subview-chip' + (moves.scope === "mine" ? " active" : "") + '" data-mv-scope="mine" aria-pressed="' + (moves.scope === "mine") + '">My team</button>' +
        '<button type="button" class="fo-subview-chip' + (moves.scope === "league" ? " active" : "") + '" data-mv-scope="league" aria-pressed="' + (moves.scope === "league") + '">League</button></div></div></div>' +
        '<p class="fo-basis">Last 14 days from MFL’s transaction log: adds, drops, waiver awards, trades, IR and taxi moves. Contract submissions are in Contracts &amp; Cap → Contract log.</p>' + movesHtml + "</div></div>";
  }
  function wire() {
    var el = document.getElementById("fo-moves-body");
    if (!el || el.__mvWired) return;
    el.__mvWired = true;
    el.addEventListener("click", function (e) {
      var t = e.target && e.target.closest ? e.target.closest("[data-mv-scope]") : null;
      if (!t) return;
      moves.scope = t.getAttribute("data-mv-scope");
      renderMoves();
    });
  }
  function active() { var a = document.querySelector(".fo-section.active"); return a ? a.getAttribute("data-section") : ""; }

  if (root.UPS_FO_HUB) { root.UPS_FO_HUB.registerView("picks"); root.UPS_FO_HUB.registerView("moves"); }
  root.UPS_FO_ACTIVITY = { holders: holders, roundsOf: roundsOf, txLines: function (tx, me, since, scope) { var keep = moves.scope; moves.scope = scope || "league"; try { return txLines(tx, me, since); } finally { moves.scope = keep; } } };
  document.addEventListener("fo:ready", function () {
    H = root.UPS_FO_HUB; FO = root.UPS_FO; DATA = root.UPS_FO_DATA;
    if (!H || !FO || !DATA) return;
    wire();
    H.registerAbout("picks", "<h3>Draft picks</h3><p>MFL’s future picks: whose pick each is (the row) and who holds it now. Future picks can be traded through next season; round 6 picks can’t (§A6). Your own picks are checked for lineup-penalty forfeits; other teams’ forfeits are greyed in the Trade War Room. Pick positions aren’t projected here.</p>");
    H.registerAbout("moves", "<h3>Activity</h3><p><b>Claims MFL holds</b> are read with your MFL session and checked against the league’s waiver check; “MFL will refuse this claim” means the player can’t be awarded at that run (dropped-player lock or the player’s game has started). Claims are edited in the phone app. <b>Recent moves</b> are MFL’s transaction log for the last 14 days.</p>");
  });
  document.addEventListener("fo:tab", function (e) {
    if (!H) return;
    var s = e.detail && e.detail.section;
    if (s === "picks") {
      renderPicks();
      DATA.load("picks").then(function () { if (active() === "picks") renderPicks(); });
      DATA.load("players");
      var me = myFid();
      if (me) DATA.load("franchiseAssets", me).then(function () { if (active() === "picks") renderPicks(); });
    }
    if (s === "moves") {
      renderMoves();
      ["transactions", "players", "waiverPending", "waiverAvailability"].forEach(function (k) { DATA.load(k).then(function () { if (active() === "moves") renderMoves(); }); });
    }
  });
})(typeof window !== "undefined" ? window : this);
