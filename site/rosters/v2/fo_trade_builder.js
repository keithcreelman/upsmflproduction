/* Front Office → Trades → Trade builder (#1385 P3). The adapter between the Front Office's data and the shared
   builder (site/shared/trade_builder_view.js): who the teams are, what each can send (players and MFL's future
   picks), and how the server's verdict is asked for.

   READ-ONLY TODAY. The Send step is wired in the view but this adapter gives it NO send function, so a confirmed
   send says plainly that sending is not available and nothing leaves the page. No write route is named here.
   Making Send live is a separate decision (needs Keith's go, an authz and behavior review, and parity with every
   two- and three-team War Room rule; see the PR).

   Optional test/preview seam: window.UPS_FO_TRADE_BUILDER_CONFIG = { preview(body) -> json, sendNotice, warRoomUrl }.
   A build that blocks every POST (the preview) answers the verdict from recorded examples through it. */
(function (root) {
  "use strict";
  var FO, DATA, H;
  function cfg() { return root.UPS_FO_TRADE_BUILDER_CONFIG || {}; }
  function ord(n) { return n + (["th", "st", "nd", "rd"][(n % 100 > 10 && n % 100 < 14) ? 0 : Math.min(n % 10, 4) % 4] || "th"); }

  function teams() { return FO.teams().map(function (t) { return { fid: t.fid, name: t.name, abbrev: t.abbrev }; }); }
  function playersOf(fid) {
    var t = FO.teams().filter(function (x) { return x.fid === fid; })[0];
    return t ? (t.players || []).map(function (p) {
      return { id: p.id, name: p.name, pos: p.position, salary: p.salary, years: p.years, type: p.type && p.type !== "-" ? p.type : "", taxi: !!p.isTaxi, ir: !!p.isIr };
    }) : [];
  }
  // MFL's future picks held by this team: FP_<original owner>_<year>_<round>, the token the server reads.
  function picksOf(fid) {
    var e = DATA.get("picks");
    if (!e || e.state !== "ok") return [];
    var out = [];
    H.asArray(e.data.futureDraftPicks && e.data.futureDraftPicks.franchise).forEach(function (row) {
      if (H.pad4(row.id) !== fid) return;
      H.asArray(row.futureDraftPick).forEach(function (p) {
        var y = String(p.year), r = parseInt(p.round, 10), orig = H.pad4(p.originalPickFor || fid);
        if (!y || !(r >= 1)) return;
        out.push({ year: y, round: r, token: "FP_" + orig + "_" + y + "_" + r, label: y + " " + ord(r) + (orig !== fid ? " (" + H.teamName(orig) + ")" : "") });
      });
    });
    return out.sort(function (a, b) { return a.year === b.year ? a.round - b.round : a.year < b.year ? -1 : 1; });
  }

  // ── Pre-trade extension: the shared rule (shared/pretrade_extension.js), fed this player's own contract ──
  var extMemo = {};
  // Authoritative extension facts for the SENDING franchise's player: { already_extended_by_this_franchise: boolean } from the worker's
  // extension history. No such source is wired into the Front Office yet (the Trade War Room gets it from the worker), so by default there
  // are none and every extension badge and choice is suppressed. A build that has the facts supplies them through
  // window.UPS_FO_TRADE_BUILDER_CONFIG.extensionFacts(fid, pid); eligibility is never guessed from the contract or its `Ext:` text.
  function extensionFacts(fid, pid) { var c = cfg(); return typeof c.extensionFacts === "function" ? c.extensionFacts(fid, pid) : null; }
  function extensionOptions(item) {
    var X = root.UPS_PRETRADE_EXT, pid = String(item.token || "").replace(/^P_/, "");
    var p = playerRec(item.from, pid);
    if (!X || !p) return [];
    var asset = root.UPS_TRADE_BUILDER_CORE.extensionInput(p, extensionFacts(item.from, pid));
    if (!asset) return [];
    var key = item.from + "|" + pid + "|" + p.years + "|" + p.salary + "|" + p.type + "|" + p.special + "|" + asset.already_extended_by_this_franchise;
    return extMemo[key] || (extMemo[key] = X.buildSyntheticExtensionOptions(asset));
  }
  function y1(o) { var X = root.UPS_PRETRADE_EXT, y = X ? X.parseContractInfoSummary(o.preview_contract_info_string).y_by_year_dollars : {}; return y["1"] != null ? y["1"] : null; }
  function extImpacts(draft) {
    var X = root.UPS_PRETRADE_EXT, out = [];
    draft.items.forEach(function (i) {
      var key = (draft.ext || {})[i.from + "|" + i.token]; if (!key) return;
      var o = extensionOptions(i).filter(function (x) { return x.option_key === key; })[0], p = playerRec(i.from, pidOf(i.token));
      if (!o || !p) return;
      var y = X.parseContractInfoSummary(o.preview_contract_info_string).y_by_year_dollars, ks = Object.keys(y).sort(function (a, b) { return a - b; });
      var money = function (d) { var v = Math.round(d / 100) / 10; return "$" + (v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)) + "K"; };
      out.push({ name: p.name, from: i.from, to: i.to, current: p.years + " yr left · " + money(p.salary) + (p.type && p.type !== "-" ? " · " + p.type : ""),
        proposed: o.new_contract_length + " yr · " + ks.map(function (n) { return money(y[n]); }).join(" then ") + " · total " + money(o.new_TCV) + " · " + (o.new_contract_status || ""),
        added: ks.slice(1).reduce(function (a, n) { return a + y[n]; }, 0), pid: pidOf(i.token) });
    });
    return out;
  }

  // ── Impact: the Front Office's own engines, never a second reading of the rules ──
  function teamOf(fid) { return FO.teams().filter(function (t) { return t.fid === fid; })[0]; }
  function playerRec(fid, pid) { var t = teamOf(fid); return t ? (t.players || []).filter(function (p) { return String(p.id) === String(pid); })[0] : null; }
  function pidOf(tok) { var m = /^P_(\d+)$/.exec(tok); return m ? m[1] : ""; }
  function capImpacts(draft) {
    var I = root.UPS_TRADE_IMPACT, out = {}, ok = false;
    var ms = root.UPS_TRADE_BUILDER_CORE.movements(draft);
    draft.teams.forEach(function (f) {
      var snap = FO.capFor(f);
      if (!snap || !I) { out[f] = null; return; }
      ok = true;
      var send = [], recv = [], sentK = 0, gotK = 0;
      draft.items.forEach(function (i) {
        var pid = pidOf(i.token); if (!pid) return;
        if (i.from === f) { var p = playerRec(f, pid); if (p) send.push({ salary: p.salary, hit: FO.capHit(p), isTaxi: !!p.isTaxi, isIr: !!p.isIr, loaded: FO.isLoaded(p) }); }
        if (i.to === f) {
          var q = playerRec(i.from, pid);
          if (q) {
            var ek = (draft.ext || {})[i.from + "|" + i.token], eo = ek ? extensionOptions(i).filter(function (x) { return x.option_key === ek; })[0] : null;
            // An accepted pre-trade extension resets the current-year salary to its own Y1 and arrives with the extension's own loaded status (worker rule).
            recv.push({ salary: eo && y1(eo) != null ? y1(eo) : q.salary, isTaxi: !!q.isTaxi, isIr: !!q.isIr, loaded: eo ? (eo.loaded_indicator === "NONE" ? false : true) : FO.isLoaded(q) });
          }
        }
      });
      ms.forEach(function (m) { if (m.from === f) sentK += m.cap_k; if (m.to === f) gotK += m.cap_k; });
      out[f] = { r: I.capImpact({ ceiling: FO.capCeiling, capAlloc: snap.capAlloc, activeN: snap.activeN, taxiN: snap.taxiN, irN: snap.irN, loadedN: snap.loadedN, activeMax: snap.activeMax, activeMin: snap.activeMin, taxiMax: snap.taxiMax }, send, recv, sentK, gotK) };
    });
    return ok ? out : null;
  }
  function lineupImpacts(draft) {
    var TF = root.UPS_TRADE_FIT, ss = H.scoring && H.scoring();
    if (!TF || !TF.tradeLineup) return { state: "off", message: "Lineup impact isn’t available in this build." };
    if (!DATA.get("scores") || !DATA.get("players")) return { state: "loading", message: "Reading MFL’s scores and players…" };
    if (!ss) return { state: "off", message: "MFL’s scores couldn’t be read, so lineup impact is off. Reload to retry." };
    if (!ss.seasonWeeks.length) return { state: "off", message: "Lineup impact starts once MFL has scored a week this season." };
    var slotState = H.lineupSlotsState();
    if (!slotState) return { state: "loading", message: "Reading MFL’s lineup settings…" };
    if (slotState === "error") return { state: "off", message: "MFL’s lineup settings couldn’t be read, so lineup impact is off. Reload to retry." };
    var m = H.leagueModel(0);
    if (!m) return { state: "loading", message: "Building the league model…" };
    var nameOf = function (pid) { var r = H.rosterIndex()[String(pid)]; return r ? H.displayName(r.p.name) : String(pid); };
    var teamsOut = {};
    draft.teams.forEach(function (f) {
      var tm = m.teams[f]; if (!tm) return;
      var outPids = [], inPlayers = [];
      draft.items.forEach(function (i) {
        var pid = pidOf(i.token); if (!pid) return;
        if (i.from === f) outPids.push(pid);
        if (i.to === f) { var src = m.teams[i.from]; var rec = src && src.team.players.filter(function (p) { return String(p.pid) === pid; })[0]; if (rec) inPlayers.push(rec); }
      });
      var after = TF.tradeLineup(m, f, outPids, inPlayers), before = tm.best;
      var slotLabel = {}; (m.slots || []).forEach(function (sl) { slotLabel[sl.id] = sl.label || sl.id; });
      var starter = function (s) { return { key: s.rep ? "REP:" + s.slot : (s.pid || "—"), name: s.rep ? "Replacement level" : s.empty ? "Empty" : nameOf(s.pid), v: s.v || 0 }; };
      var bySlot = {}; after.starters.forEach(function (s) { bySlot[s.slot] = s; });
      var slots = before.starters.map(function (b) { var a = bySlot[b.slot] || { slot: b.slot, empty: true, v: 0 }; return { label: slotLabel[b.slot] || b.slot, before: starter(b), after: starter(a) }; });
      var groups = {}; before.starters.forEach(function (s) { var g = s.group || "—"; (groups[g] = groups[g] || { g: g, before: 0, after: 0 }).before += s.v || 0; });
      after.starters.forEach(function (s) { var g = s.group || "—"; (groups[g] = groups[g] || { g: g, before: 0, after: 0 }).after += s.v || 0; });
      var byPos = Object.keys(groups).map(function (g) { var x = groups[g]; x.delta = x.after - x.before; return x; }).sort(function (a, b) { return Math.abs(b.delta) - Math.abs(a.delta); });
      var rep = function (lu) { return lu.starters.filter(function (s) { return s.rep || s.empty; }).length; };
      // ── every traded player: what he is worth on THIS roster (starter vs bench), who he moves, and his own effect ──
      var val = function (pid) { return Number(m.values[pid]) || 0; };
      var grp = function (pos) { return m.lineup.posGroup(pos); };
      var inSet = {}, outSet = {}; inPlayers.forEach(function (p) { inSet[p.pid] = 1; }); outPids.forEach(function (pid) { outSet[pid] = 1; });
      var afterStart = {}, beforeStart = {};
      after.starters.forEach(function (s) { if (s.pid && !s.rep) afterStart[s.pid] = s.slot; });
      before.starters.forEach(function (s) { if (s.pid && !s.rep) beforeStart[s.pid] = s; });
      var benched = Object.keys(beforeStart).filter(function (pid) { return !outSet[pid] && !(pid in afterStart); });     // starters pushed to the bench
      var rosterAfter = tm.team.players.filter(function (p) { return !outSet[p.pid] && TF.availableNow(p) && grp(p.pos) !== "OTH"; }).concat(inPlayers.filter(function (p) { return after.notCounted.indexOf(p.pid) === -1; }));
      var depthOf = function (g, list) { return list.filter(function (p) { return grp(p.pos) === g; }).sort(function (a, b) { return val(b.pid) - val(a.pid); }); };
      var players = [];
      inPlayers.forEach(function (p) {
        var g = grp(p.pos), x = { pid: p.pid, name: nameOf(p.pid), pos: p.pos, dir: "in", ppg: val(p.pid), role: "bench", slot: "", depth: "", displaces: "", note: "", lineupDelta: 0 };
        if (after.notCounted.indexOf(p.pid) !== -1) { x.role = "out"; players.push(x); return; }
        var without = TF.tradeLineup(m, f, outPids, inPlayers.filter(function (q) { return q.pid !== p.pid; }));
        x.lineupDelta = after.total - without.total;
        if (p.pid in afterStart) {
          x.role = "starter"; x.slot = slotLabel[afterStart[p.pid]] || afterStart[p.pid];
          var held = before.starters.filter(function (s) { return s.slot === afterStart[p.pid]; })[0], parts = [];
          if (held && held.pid && !held.rep) parts.push(outSet[held.pid] ? "Replaces " + nameOf(held.pid) + " (leaving)" : "Takes " + nameOf(held.pid) + "’s slot");
          if (held && held.rep) parts.push("Takes a slot that was at replacement level");
          benched.filter(function (pid) { return grp((tm.team.players.filter(function (q) { return q.pid === pid; })[0] || {}).pos) === g; }).forEach(function (pid) { parts.push("Pushes " + nameOf(pid) + " to the bench"); });
          x.displaces = parts.join("; ");
        } else {
          var list = depthOf(g, rosterAfter), idx = list.map(function (q) { return q.pid; }).indexOf(p.pid);
          x.depth = g + (idx + 1);
          x.displaces = idx > 0 ? "Behind " + list.slice(0, Math.min(idx, 2)).map(function (q) { return nameOf(q.pid); }).join(", ") : "";
        }
        players.push(x);
      });
      outPids.forEach(function (pid) {
        var rec = tm.team.players.filter(function (q) { return q.pid === pid; })[0] || { pid: pid, pos: "" };
        var wasStarter = pid in beforeStart, x = { pid: pid, name: nameOf(pid), pos: rec.pos, dir: "out", ppg: val(pid), role: "left", lineupDelta: 0, displaces: "", note: wasStarter ? "Was a starter (" + (slotLabel[beforeStart[pid].slot] || beforeStart[pid].slot) + ")" : "Was a bench player" };
        if (wasStarter) { x.lineupDelta = TF.tradeLineup(m, f, [pid], []).total - tm.total; var now = bySlot[beforeStart[pid].slot]; if (now) x.displaces = "Slot now: " + (now.rep ? "replacement level" : now.empty ? "empty" : nameOf(now.pid)); }
        players.push(x);
      });
      var touched = {}; players.forEach(function (x) { if (x.pos) touched[grp(x.pos)] = 1; });
      var line = function (list) { return list.slice(0, 4).map(function (q) { return nameOf(q.pid) + " " + (Math.round(val(q.pid) * 10) / 10).toFixed(1); }).join(" · ") || "none"; };
      var depth = Object.keys(touched).filter(function (g) { return g !== "OTH"; }).map(function (g) {
        var b = depthOf(g, tm.team.players.filter(function (p) { return TF.availableNow(p) && grp(p.pos) !== "OTH"; })), a = depthOf(g, rosterAfter);
        return { g: g, before: "(" + b.length + ") " + line(b), after: "(" + a.length + ") " + line(a) };
      });
      teamsOut[f] = { before: tm.total, after: after.total, delta: after.total - tm.total, slots: slots, byPos: byPos, players: players, depth: depth,
        leaving: outPids.map(nameOf), entering: inPlayers.map(function (p) { return nameOf(p.pid); }),
        notCounted: after.notCounted.map(nameOf), repBefore: rep(before), repAfter: rep(after) };
    });
    var F = root.UPS_PLAYER_FACTS;
    return { state: "ok", teams: teamsOut, basis: "Year-to-date points per week, not a projection. " + (F && F.basis ? F.basis(ss).text : "") };
  }
  function impact(draft) { return { cap: capImpacts(draft), lineup: lineupImpacts(draft), ext: extImpacts(draft) }; }

  function preview(body) {
    var c = cfg();
    if (typeof c.preview === "function") return Promise.resolve(c.preview(body));
    var url = DATA.config().sessionQuery(DATA.config().apiBase + "/api/trades/compliance-preview?L=" + encodeURIComponent(DATA.config().leagueId) + "&YEAR=" + encodeURIComponent(DATA.config().season));
    // The server's read-only compliance preview. Any failure is "can't be checked", never a pass.
    return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "omit", body: JSON.stringify(body) })
      .then(function (r) { return r.json(); }, function () { return null; });
  }

  // The extension choice popup is the Front Office's own dialog; its buttons are handled here and handed to the builder.
  var current = null;
  function wireDialog() {
    var body = document.getElementById("fo-about-body");
    if (!body || body.__tbWired) return;
    body.__tbWired = true;
    body.addEventListener("click", function (e) { if (current) current.dialogAction(e.target); });
  }
  function mount(host) {
    var c = cfg();
    wireDialog();
    current = root.UPS_TRADE_BUILDER_VIEW.mount(host, {
      openDialog: function (title, html) { H.openDialog(title, html, { variant: "team" }); },
      closeDialog: function () { H.closeAbout(); },
      teams: teams(),
      assets: function (fid) { return { players: playersOf(fid), picks: picksOf(fid) }; },
      ctx: { leagueId: DATA.config().leagueId, season: DATA.config().season, viewerFid: FO.viewerFid() },
      impact: impact,
      extensionOptions: extensionOptions,
      playerLink: function (pid, fid, label) { return H.playerButton ? H.playerButton(pid, fid, label) : "<b>" + label + "</b>"; },
      preview: preview,
      sources: c.sources,
      // No send(): see the header. The notice is what the owner reads on the Review step.
      sendNotice: c.sendNotice || "Sending from the Front Office is not turned on yet. Nothing here sends a trade; use the Trade War Room to send.",
      warRoomUrl: ("warRoomUrl" in c) ? c.warRoomUrl : (FO.warRoomUrl ? FO.warRoomUrl({}) : "")
    });
    return current;
  }

  root.UPS_FO_TRADE_BUILDER = { mount: mount, _picksOf: picksOf, _impact: impact, _playersOf: playersOf };
  document.addEventListener("fo:ready", function () { FO = root.UPS_FO; DATA = root.UPS_FO_DATA; H = root.UPS_FO_HUB; });
})(typeof window !== "undefined" ? window : this);
