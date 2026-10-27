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
  function extAsset(p) {
    var info = String(p.special || ""), cl = /(?:^|\|)\s*CL\s*(\d+)/i.exec(info);
    return { type: "PLAYER", position: p.position, salary: p.salary, years: p.years, contract_type: p.type, contract_info: info,
      contract_length: cl ? parseInt(cl[1], 10) : 0, taxi: !!p.isTaxi };
  }
  function extensionOptions(item) {
    var X = root.UPS_PRETRADE_EXT, pid = String(item.token || "").replace(/^P_/, "");
    var p = playerRec(item.from, pid);
    if (!X || !p) return [];
    var key = item.from + "|" + pid + "|" + p.years + "|" + p.salary + "|" + p.type + "|" + p.special;
    return extMemo[key] || (extMemo[key] = X.buildSyntheticExtensionOptions(extAsset(p)));
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
      teamsOut[f] = { before: tm.total, after: after.total, delta: after.total - tm.total, slots: slots, byPos: byPos,
        leaving: outPids.map(nameOf), entering: inPlayers.map(function (p) { return nameOf(p.pid); }),
        notCounted: after.notCounted.map(nameOf), repBefore: rep(before), repAfter: rep(after) };
    });
    return { state: "ok", teams: teamsOut };
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

  function mount(host) {
    var c = cfg();
    return root.UPS_TRADE_BUILDER_VIEW.mount(host, {
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
  }

  root.UPS_FO_TRADE_BUILDER = { mount: mount, _picksOf: picksOf, _impact: impact, _playersOf: playersOf };
  document.addEventListener("fo:ready", function () { FO = root.UPS_FO; DATA = root.UPS_FO_DATA; H = root.UPS_FO_HUB; });
})(typeof window !== "undefined" ? window : this);
