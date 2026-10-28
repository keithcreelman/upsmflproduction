/* Front Office → Contracts & Cap → Draft picks, and → Activity (#1338). Read-only.

   Draft picks: who holds every future pick (MFL futureDraftPicks). The viewer's
   own picks are checked for lineup-penalty forfeits (#1229) through
   /api/franchise-assets (one read, the viewer's team only); other teams'
   forfeits are marked in the Trade War Room. Round 6 picks can't be traded
   (canon §A6). Pick slots are not projected here (how future picks are valued
   is an open decision, #1337).

   Activity: the claims MFL holds for the viewer (signed in; each checked
   against the league's waiver resolver: "MFL will refuse this claim" when
   the player can't be awarded at that run) and the season's moves and
   contracts: MFL's transaction log (adds, drops, waivers, auction wins,
   trades, IR/taxi) merged with the UPS contract log (the static
   contract_activity_<season>.json snapshot; 0 D1 rows), each row labeled
   with its source, filtered by team (default: the viewer's) and type. Only
   the current season: earlier years appear once their records are checked.
   Claims are edited in the phone app; nothing here changes them.
*/
(function (root) {
  "use strict";

  var H, FO, DATA;
  var moves = { team: null, type: "", limit: 50 };   // team null = not chosen yet (defaults to the viewer's team)
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
  // One list for the season: MFL's transaction log (roster moves) and the UPS contract log (contract terms). Each row
  // carries its source, its own timestamp in Eastern time, the teams and players it touches, and its kinds (the type
  // filter). Pure: the names come in through `nm` / `team`, so tests run it without a page.
  var PAGE = 50;
  var MFL_KINDS = [["add", "Adds"], ["drop", "Drops"], ["waiver", "Waiver claims (blind bid)"], ["auction", "Auction wins"], ["trade", "Trades"], ["ir", "IR moves"], ["taxi", "Taxi moves"]];
  // The contract log's own activity types, in plain words. A type the log adds later shows under its own name.
  // [log type, filter label, row label]
  var UPS_KINDS = [["Multi-Year Contract", "Multi-year contracts (MYAC)", "Multi-year contract (MYAC)"], ["Extension", "Extensions", "Extension"], ["Restructure", "Restructures", "Restructure"],
    ["Tag", "Tags", "Tag"], ["MYM", "Mid-year multis (MYM)", "Mid-year multi (MYM)"], ["FA Contract", "FA contracts", "FA contract"]];
  var SRC_LABEL = { mfl: "MFL transaction", ups: "Contract log (UPS)" };
  // The one pair that can be a single event in both logs: MFL's add (free agent, waiver award, auction win) and the contract
  // log's "FA Contract" for that same team and player within 2 minutes. Anything else is two events, even when close in time
  // (an IR move and an MYM on the same player minutes apart are both real).
  var SAME_EVENT_MS = 120000, SAME_EVENT_MFL = ["add", "waiver", "auction"], SAME_EVENT_UPS = "c:FA Contract";

  function upsKey(type) { return "c:" + String(type || "Other"); }
  function upsLabel(type, one) { var k = UPS_KINDS.filter(function (x) { return x[0] === type; })[0]; return k ? k[one ? 2 : 1] : String(type || "Other"); }
  // "Tue Oct 27, 9:14 PM ET" — the row's own timestamp, Eastern time (the league's clock, like the rest of Front Office).
  function fmtEt(ms) {
    if (!(ms > 0)) return "";
    try {
      var p = {};
      new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })
        .formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
      return p.weekday + " " + p.month + " " + p.day + ", " + p.hour + ":" + p.minute + " " + String(p.dayPeriod || "").toUpperCase() + " ET";
    } catch (e) { return ""; }
  }
  // MFL's transaction log → rows. Shown: adds, drops, blind-bid waiver awards, auction wins, trades, IR and taxi moves.
  // Not shown: auction bids and nominations, commissioner roster loads, lock/unlock and waiver-run markers.
  // A trade's owner comments are never read (privacy): only who gave what.
  function mflRows(tx, nm, team) {
    H = H || root.UPS_FO_HUB;
    var ids = function (csv) { return String(csv || "").split(",").map(function (x) { return x.trim(); }).filter(Boolean); };
    var names = function (list) { return H.esc(list.map(nm).join(", ")); };
    var out = [];
    H.asArray(tx && tx.transactions && tx.transactions.transaction).forEach(function (t) {
      var ts = parseInt(t.timestamp, 10) * 1000;
      var f = H.pad4(t.franchise), f2 = H.pad4(t.franchise2);
      var row = null;
      if (t.type === "TRADE") {
        var g1 = ids(t.franchise1_gave_up), g2 = ids(t.franchise2_gave_up);
        row = { kinds: ["trade"], fids: [f, f2], pids: g1.concat(g2),
          html: "<b>Trade</b>: " + H.esc(team(f)) + " gave " + (names(g1) || "—") + "; " + H.esc(team(f2)) + " gave " + (names(g2) || "—") };
      } else if (t.type === "FREE_AGENT" || t.type === "BBID_WAIVER") {
        var parts = String(t.transaction || "").split("|");
        var adds = ids(parts[0]), drops = parts.length > 1 ? ids(parts[parts.length - 1]) : [];
        var bbid = t.type === "BBID_WAIVER";
        var bid = bbid && parts.length === 3 && parts[1] !== "" ? " ($" + Number(parts[1]).toLocaleString("en-US") + ")" : "";
        var kinds = (bbid ? ["waiver"] : adds.length ? ["add"] : []).concat(drops.length ? ["drop"] : []);
        if (kinds.length) row = { kinds: kinds, fids: [f], pids: adds.concat(drops),
          html: "<b>" + H.esc(team(f)) + "</b>" + (adds.length ? " added " + names(adds) + bid + (bbid ? " on waivers" : "") : "") +
            (drops.length ? (adds.length ? "; " : " ") + "dropped " + names(drops) : "") };
      } else if (t.type === "AUCTION_WON") {
        var ap = String(t.transaction || "").split("|"), won = ids(ap[0]);
        var price = ap.length > 1 && ap[1] !== "" ? " for $" + Number(ap[1]).toLocaleString("en-US") : "";
        if (won.length) row = { kinds: ["auction"], fids: [f], pids: won, html: "<b>" + H.esc(team(f)) + "</b> won " + names(won) + " at auction" + price };
      } else if (t.type === "IR") {
        // MFL: deactivated = moved to IR, activated = back from IR.
        var toIr = ids(t.deactivated), fromIr = ids(t.activated);
        if (toIr.length || fromIr.length) row = { kinds: ["ir"], fids: [f], pids: toIr.concat(fromIr),
          html: "<b>" + H.esc(team(f)) + "</b>" + (toIr.length ? " placed " + names(toIr) + " on IR" : "") +
            (fromIr.length ? (toIr.length ? ";" : "") + " activated " + names(fromIr) + " from IR" : "") };
      } else if (t.type === "TAXI") {
        var up = ids(t.promoted), down = ids(t.demoted);
        if (up.length || down.length) row = { kinds: ["taxi"], fids: [f], pids: up.concat(down),
          html: "<b>" + H.esc(team(f)) + "</b>" + (up.length ? " promoted " + names(up) + " from the taxi squad" : "") +
            (down.length ? (up.length ? ";" : "") + " moved " + names(down) + " to the taxi squad" : "") };
      }
      if (row) { row.ts = ts; row.src = ["mfl"]; out.push(row); }
    });
    return out;
  }
  // The UPS contract log (contract_activity_<season>.json) → rows. Test rows never show: the log's own test flag, and the
  // Contract log's test-franchise cutoffs (contract_log_test_<season>.json, `before` = events strictly before it are test).
  function contractRows(activity, testCfg, nm, team) {
    H = H || root.UPS_FO_HUB;
    var tests = H.asArray(testCfg && testCfg.test_franchises);
    var isTest = function (a, fid) {
      if (Number(a.test_flag) === 1) return true;
      return tests.some(function (x) { return H.pad4(x.franchise_id) === fid && (x.before ? String(a.submitted_at_utc || "") < String(x.before) : true); });
    };
    var out = [];
    H.asArray(activity && activity.activities).forEach(function (a) {
      if (!a) return;
      var fid = H.pad4(a.franchise_id);
      if (!fid || isTest(a, fid)) return;
      var pid = String(a.player_id || "");
      var who = a.player_name ? H.displayName(String(a.player_name)) : (pid ? nm(pid) : "");
      var terms = String(a.contract_info || "").trim() || [a.contract_status, a.contract_year != null ? a.contract_year + " yr" : "", a.salary != null ? "$" + Number(a.salary).toLocaleString("en-US") : ""].filter(Boolean).join(" · ");
      out.push({ ts: Date.parse(String(a.submitted_at_utc || "")), src: ["ups"], kinds: [upsKey(a.activity_type)], fids: [fid], pids: pid ? [pid] : [],
        html: "<b>" + H.esc(team(fid)) + "</b> " + H.esc(upsLabel(a.activity_type, true)) + (who ? ": " + H.esc(who) : "") + (terms ? ' <span class="fo-act-terms">' + H.esc(terms) + "</span>" : "") });
    });
    return out;
  }
  // Both logs, newest first. A contract-log row that is the same event as an MFL row (see SAME_EVENT_*) joins that row
  // (both source labels) instead of showing twice. Rows without a readable time sort last.
  function mergeRows(mfl, ups) {
    var rows = (mfl || []).map(function (r) { return Object.assign({}, r, { src: r.src.slice(), kinds: r.kinds.slice() }); });
    (ups || []).forEach(function (c) {
      var hit = null, best = SAME_EVENT_MS + 1;
      if (c.kinds.indexOf(SAME_EVENT_UPS) >= 0) rows.forEach(function (r) {
        if (r.src.indexOf("ups") >= 0 || !(r.ts > 0) || !(c.ts > 0) || !r.kinds.some(function (k) { return SAME_EVENT_MFL.indexOf(k) >= 0; })) return;
        var d = Math.abs(r.ts - c.ts);
        if (d <= SAME_EVENT_MS && d < best && r.fids.indexOf(c.fids[0]) >= 0 && c.pids.some(function (p) { return r.pids.indexOf(p) >= 0; })) { hit = r; best = d; }
      });
      if (hit) { hit.src.push("ups"); hit.kinds = hit.kinds.concat(c.kinds); hit.html += '<br><span class="fo-act-also">Contract log: ' + c.html + "</span>"; }
      else rows.push(Object.assign({}, c, { src: c.src.slice(), kinds: c.kinds.slice() }));
    });
    return rows.sort(function (a, b) { return ((b.ts > 0 ? b.ts : -1) - (a.ts > 0 ? a.ts : -1)); });
  }
  // The type filter's choices, from the rows themselves: "src:mfl" / "src:ups" (everything from one source), then each kind
  // present, in a fixed plain order. n = how many of `counted` (the team-filtered rows) carry it.
  function typeOptions(rows, counted) {
    var seen = {}, n = {};
    (rows || []).forEach(function (r) { r.kinds.forEach(function (k) { seen[k] = 1; }); r.src.forEach(function (s) { seen["src:" + s] = 1; }); });
    (counted || rows || []).forEach(function (r) { r.kinds.concat(r.src.map(function (s) { return "src:" + s; })).forEach(function (k) { n[k] = (n[k] || 0) + 1; }); });
    var groups = [];
    if (seen["src:mfl"]) groups.push({ label: SRC_LABEL.mfl, options: [{ key: "src:mfl", label: "All MFL transactions", n: n["src:mfl"] || 0 }].concat(
      MFL_KINDS.filter(function (k) { return seen[k[0]]; }).map(function (k) { return { key: k[0], label: k[1], n: n[k[0]] || 0 }; })) });
    if (seen["src:ups"]) {
      var known = UPS_KINDS.map(function (k) { return upsKey(k[0]); });
      var extra = Object.keys(seen).filter(function (k) { return k.indexOf("c:") === 0 && known.indexOf(k) < 0; }).sort();
      groups.push({ label: SRC_LABEL.ups, options: [{ key: "src:ups", label: "All contract log", n: n["src:ups"] || 0 }].concat(
        known.concat(extra).filter(function (k) { return seen[k]; }).map(function (k) { return { key: k, label: upsLabel(k.slice(2)), n: n[k] || 0 }; })) });
    }
    return groups;
  }
  // team "" = all teams; type "" = all types, "src:<source>" = one source, else one kind.
  function filterRows(rows, team, type) {
    return (rows || []).filter(function (r) {
      if (team && r.fids.indexOf(team) < 0) return false;
      if (!type) return true;
      if (type.indexOf("src:") === 0) return r.src.indexOf(type.slice(4)) >= 0;
      return r.kinds.indexOf(type) >= 0;
    });
  }
  function rowHtml(r) {
    var when = fmtEt(r.ts);
    return '<li class="fo-act-row"><div class="fo-act-when">' + (when ? '<time datetime="' + H.esc(new Date(r.ts).toISOString()) + '">' + H.esc(when) + "</time>" : '<span class="fo-muted">Time not recorded</span>') +
      r.src.map(function (s) { return ' <span class="fo-tf-flag fo-act-src ' + s + '">' + H.esc(SRC_LABEL[s]) + "</span>"; }).join("") + "</div>" +
      '<div class="fo-act-text">' + r.html + "</div></li>";
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
  function nameFn() {
    var pidx = H.playerIndex();
    return function (id) { var p = pidx[id]; return p ? H.displayName(p.name) : (/^FP_|^DP_/.test(id) ? id.replace(/^FP_(\d{4})_(\d{4})_(\d)$/, function (_, f, y, r) { return y + " R" + r + " (" + H.teamName(f) + ")"; }) : id); };
  }
  function renderMoves() {
    var el = document.getElementById("fo-moves-body");
    if (!el) return;
    H.wireClicks(el);
    var me = myFid();
    if (moves.team == null) moves.team = me;   // first visit: my team (All teams when the viewer has no team)
    var season = String(FO.season || "");
    var tx = DATA.get("transactions"), cl = DATA.get("contractLog");
    var nm = nameFn(), tn = function (f) { return H.teamName(f); };
    var all = mergeRows(tx && tx.state === "ok" ? mflRows(tx.data, nm, tn) : [], cl && cl.state === "ok" ? contractRows(cl.data.activity, cl.data.test, nm, tn) : []);
    var mine = filterRows(all, moves.team, "");
    var groups = typeOptions(all, mine);
    if (moves.type && !groups.some(function (g) { return g.options.some(function (o) { return o.key === moves.type; }); })) moves.type = "";
    var list = filterRows(mine, "", moves.type);
    var opt = function (v, label, on) { return '<option value="' + H.esc(v) + '"' + (on ? " selected" : "") + ">" + H.esc(label) + "</option>"; };
    var teams = FO.teams().slice().sort(function (a, b) { return a.fid === me ? -1 : b.fid === me ? 1 : a.name.localeCompare(b.name); });
    var controls = '<div class="fo-act-controls">' +
      '<label class="fo-field fo-inline">Team <select data-mv-team>' + opt("", "All teams", !moves.team) +
        teams.map(function (t) { return opt(t.fid, t.name + (t.fid === me ? " (you)" : ""), moves.team === t.fid); }).join("") + "</select></label>" +
      '<label class="fo-field fo-inline">Type <select data-mv-type>' + opt("", "All types", !moves.type) + groups.map(function (g) {
        return '<optgroup label="' + H.esc(g.label) + '">' + g.options.map(function (o) { return opt(o.key, o.label + " (" + o.n + ")", moves.type === o.key); }).join("") + "</optgroup>";
      }).join("") + "</select></label>" +
      '<label class="fo-field fo-inline">Season <select data-mv-year>' + opt(season, season, true) + "</select></label></div>" +
      '<p class="fo-basis">Earlier seasons appear here after their transaction and contract records are checked.</p>';
    var loadingAny = !tx || !cl;
    var warn = (tx && tx.state !== "ok" ? H.banner("MFL’s transaction log couldn’t be read; only the contract log is listed.", "warn") : "") +
      (cl && cl.state !== "ok" ? H.banner("The UPS contract log couldn’t be read; only MFL transactions are listed.", "warn") : "");
    var shown = list.slice(0, moves.limit);
    var who = moves.team ? " for " + H.esc(H.teamName(moves.team)) : "";
    var listHtml = !list.length ? (loadingAny ? '<p class="fo-muted">Reading MFL’s transaction log and the contract log…</p>' : '<p class="fo-ov-empty">Nothing matches' + who + " in " + H.esc(season) + ".</p>") :
      '<p class="fo-muted fo-act-count">' + (shown.length < list.length ? "Newest " + shown.length + " of " + list.length : list.length + (list.length === 1 ? " entry" : " entries")) + who + ".</p>" +
      '<ul class="fo-tf-list fo-act-list">' + shown.map(rowHtml).join("") + "</ul>" +
      (shown.length < list.length ? '<button type="button" class="btn small secondary" data-mv-more>Show ' + Math.min(PAGE, list.length - shown.length) + " more</button>" : "");
    var asOf = cl && cl.state === "ok" && cl.data.activity.meta && cl.data.activity.meta.generated_at ? fmtEt(Date.parse(String(cl.data.activity.meta.generated_at).replace(" ", "T") + "Z")) : "";
    el.innerHTML = '<div class="fo-tf-grid fo-act-grid">' +
      '<div class="fo-card"><h3 class="fo-tf-h">Claims MFL holds' + (me ? " for " + H.esc(H.teamName(me)) : "") + "</h3>" + claimsHtml(me) + "</div>" +
      '<div class="fo-card"><div class="fo-card-head"><h2>Moves and contracts</h2></div>' + controls + warn +
        '<p class="fo-basis">MFL transaction = MFL’s log (adds, drops, waivers, auction wins, trades, IR, taxi). Contract log (UPS) = contract terms submitted through UPS' + (asOf ? ", as of " + H.esc(asOf) : "") + ". Times are Eastern.</p>" +
        listHtml + "</div></div>";
  }
  function wire() {
    var el = document.getElementById("fo-moves-body");
    if (!el || el.__mvWired) return;
    el.__mvWired = true;
    el.addEventListener("change", function (e) {
      var t = e.target;
      if (!t || !t.matches) return;
      if (t.matches("[data-mv-team]")) moves.team = t.value;
      else if (t.matches("[data-mv-type]")) moves.type = t.value;
      else return;
      moves.limit = PAGE;
      renderMoves();
    });
    el.addEventListener("click", function (e) {
      var t = e.target && e.target.closest ? e.target.closest("[data-mv-more]") : null;
      if (!t) return;
      moves.limit += PAGE;
      renderMoves();
    });
  }
  function active() { var a = document.querySelector(".fo-section.active"); return a ? a.getAttribute("data-section") : ""; }

  if (root.UPS_FO_HUB) { root.UPS_FO_HUB.registerView("picks"); root.UPS_FO_HUB.registerView("moves"); }
  root.UPS_FO_ACTIVITY = { holders: holders, roundsOf: roundsOf, fmtEt: fmtEt, mflRows: mflRows, contractRows: contractRows, mergeRows: mergeRows, typeOptions: typeOptions, filterRows: filterRows };
  document.addEventListener("fo:ready", function () {
    H = root.UPS_FO_HUB; FO = root.UPS_FO; DATA = root.UPS_FO_DATA;
    if (!H || !FO || !DATA) return;
    wire();
    H.registerAbout("picks", "<h3>Draft picks</h3><p>MFL’s future picks: whose pick each is (the row) and who holds it now. Future picks can be traded through next season; round 6 picks can’t (§A6). Your own picks are checked for lineup-penalty forfeits; other teams’ forfeits are greyed in the Trade War Room. Pick positions aren’t projected here.</p>");
    H.registerAbout("moves", "<h3>Activity</h3><p><b>Claims MFL holds</b> are read with your MFL session and checked against the league’s waiver check; “MFL will refuse this claim” means the player can’t be awarded at that run (dropped-player lock or the player’s game has started). Claims are edited in the phone app. <b>Moves and contracts</b> lists the season from two logs, each row labeled: MFL’s transaction log and the UPS contract log. Pick a team and a type; times are Eastern. Earlier seasons appear after their records are checked.</p>");
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
      ["transactions", "contractLog", "players", "waiverPending", "waiverAvailability"].forEach(function (k) { DATA.load(k).then(function () { if (active() === "moves") renderMoves(); }); });
    }
  });
})(typeof window !== "undefined" ? window : this);
