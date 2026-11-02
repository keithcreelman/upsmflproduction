/* Front Office → Trades → Trade builder (#1385 P3). The adapter between the Front Office's data and the shared
   builder (site/shared/trade_builder_view.js): who the teams are, what each can send (players and MFL's future
   picks), and how the server's verdict is asked for.

   READ-ONLY. Send offer is always disabled in the view (whatever the verdict) and no click reaches a confirmation or a
   send; nothing here, in the view or in the config below can turn it on. No write route is named here. A live Send is a
   separate, separately approved change (Keith's go, an authz and behavior review, and parity with every two- and three-team
   War Room rule). The Trade War Room link stays for sending.

   The draft is kept HERE (onDraft), so it survives the builder being re-mounted (Trade builder ↔ Trade finder) and opening/closing sections.

   PUBLIC ENTRY POINT for other pages (the Trade finder): UPS_FO_TRADE_BUILDER.openDraft(draft, options) -> result. Exact contract:
     draft   = { source: "Trade finder",                                 // shown as "Draft from Trade finder (not sent)"; blank -> "another page"
                 movements: [ { from: "0008", to: "0010",                // franchise ids (padded to 4 digits)
                                tokens: ["P_16614", "FP_0008_2027_1"],   // "P_<MFL player id>" | "FP_<ORIGINAL owner fid>_<year>_<round>" | "DP_<year>_<round>_<slot>"
                                cap_k: 0 } ] }                           // optional cap money from -> to, whole $K, held to the rule's maximum
               (the core's movement shape: UPS_TRADE_BUILDER_CORE.movements() / the compliance-preview request). The viewer must be a party;
               2 or 3 teams; a token is kept only if it is on the `from` team's LOADED roster or pick list. No extension choices are carried.
     options = { confirm(message) -> boolean }   optional; replaces window.confirm for "replace the current draft?" (must answer synchronously)
     result  = { ok: true, dropped: [{ from, to, token, reason }], clamped: [{ from, to, asked_k, max_k }] }
             | { ok: false, reason, dropped, clamped: [] }      nothing changed
       dropped reason: "not_on_roster" | "bad_token" | "duplicate" | "bad_team"
       ok:false reason: "not_ready" | "bad_shape" | "viewer_not_in_trade" | "too_many_teams" | "no_valid_assets" | "kept_current"
   It asks before replacing a non-empty draft, loads an editable UNSENT draft labeled "Draft from <source> (not sent)", and switches to
   Trades → Trade builder. It never sends, saves or writes, and makes no network call itself. Send offer stays disabled.
   (Also written up in the hand-off notes: builder_opendraft_api.md.)

   Optional test/preview seam: window.UPS_FO_TRADE_BUILDER_CONFIG = { preview(body) -> json, warRoomUrl, sources, extensionFacts, debounceMs,
     workbench (a /trade-workbench answer, or a function returning one, used instead of fetching it), nowMs (the eligibility clock) }.
   A build that blocks every POST (the preview) answers the verdict from recorded examples through it. */
(function (root) {
  "use strict";
  var FO, DATA, H;
  function cfg() { return root.UPS_FO_TRADE_BUILDER_CONFIG || {}; }
  function ord(n) { return n + (["th", "st", "nd", "rd"][(n % 100 > 10 && n % 100 < 14) ? 0 : Math.min(n % 10, 4) % 4] || "th"); }

  function teams() { return FO.teams().map(function (t) { return { fid: t.fid, name: t.name, abbrev: t.abbrev }; }); }

  // ── Trade ELIGIBILITY of each asset (Keith's rulings 2 and 3, 2026-10-28): the ONE shared rule, UPS_TRADE_RULES.tradeAssetEligibility,
  // which the worker also enforces at the preview, every create and every accept. The page only gathers its inputs:
  //   players  years + contract status (the Front Office's MFL rosters) and the TAG STATE the worker stamps on /trade-workbench
  //            (none | provisional | early_locked | deadline_locked | unavailable, from D1's tag rows). Before that answer arrives, a
  //            Tag contract is "unavailable" (disabled) unless the tag deadline has passed (then every tag is locked);
  //   picks    MFL's future picks (round, year) plus /trade-workbench's lineup-penalty forfeit marks; this year's picks (DP_) come from
  //            /trade-workbench (MFL's assets export). A forfeit list that couldn't be read leaves FP_ picks addable with a visible notice
  //            (the War Room's rule, Keith 2026-10-12); the server refuses a forfeited pick at every send and accept.
  // The reason is always shown BESIDE a disabled item (not only on hover).
  function nowMs() { var c = cfg(); return typeof c.nowMs === "number" ? c.nowMs : Date.now(); }
  function workbench() { var c = cfg(); if (c.workbench) return typeof c.workbench === "function" ? c.workbench() : c.workbench; return fx.histState === "done" ? fx.hist : null; }
  function wbAssets(fid) {
    var wb = workbench(), team = wb && (wb.teams || []).filter(function (t) { return H.pad4(t && t.franchise_id) === fid; })[0];
    return team ? (team.assets || []) : null;
  }
  function wbPlayer(fid, pid) { return (wbAssets(fid) || []).filter(function (a) { return a && a.type === "PLAYER" && String(a.player_id) === String(pid); })[0] || null; }
  function rules() { return root.UPS_TRADE_RULES; }
  function playerElig(fid, p) {
    var R = rules(), season = DATA.config().season, now = nowMs(), deadline = R.tagDeadlineUtcMs(season), wb = workbench();
    var w = wbPlayer(fid, p.id), tagState;
    if (w && wb.meta && wb.meta.tag_status && typeof w.tag_state === "string") tagState = w.tag_state;
    else if (/(^|[^a-z])tag(ged)?([^a-z]|$)/i.test(String(p.type || ""))) tagState = now > deadline ? "deadline_locked" : "unavailable";
    else tagState = "none";
    var e = R.tradeAssetEligibility({ kind: "player", years: p.years, contract_status: p.type, tag_state: tagState }, { season: season, nowMs: now, rookieDeadlineMs: deadline });
    e.tag_state = tagState; e.prior_salary = w && w.prior_season_salary != null ? Number(w.prior_season_salary) : null;
    return e;
  }
  function playersOf(fid) {
    var t = FO.teams().filter(function (x) { return x.fid === fid; })[0];
    return t ? (t.players || []).map(function (p) {
      return { id: p.id, name: p.name, pos: p.position, salary: p.salary, years: p.years, type: p.type && p.type !== "-" ? p.type : "", taxi: !!p.isTaxi, ir: !!p.isIr, elig: playerElig(fid, p) };
    }) : [];
  }
  function pickElig(year, round, forfeit, label) {
    return rules().tradeAssetEligibility({ kind: "pick", year: year, round: round, forfeit: forfeit, forfeit_label: label || "" }, { season: DATA.config().season });
  }
  // MFL's future picks held by this team: FP_<original owner>_<year>_<round>, the token the server reads; then this year's picks
  // (DP_<year>_<round>_<slot>, before the rookie draft) from /trade-workbench. Each carries its eligibility.
  function picksOf(fid) {
    var e = DATA.get("picks"), wb = workbench(), wa = wbAssets(fid), out = [];
    var marksOk = !!(wb && wb.meta && wb.meta.forfeit_marks && wb.meta.forfeit_marks.ok === true);
    var wbPick = function (tok) { return (wa || []).filter(function (a) { return a && a.type === "PICK" && String(a.pick_key || "").toUpperCase() === tok; })[0]; };
    if (e && e.state === "ok") {
      H.asArray(e.data.futureDraftPicks && e.data.futureDraftPicks.franchise).forEach(function (row) {
        if (H.pad4(row.id) !== fid) return;
        H.asArray(row.futureDraftPick).forEach(function (p) {
          var y = String(p.year), r = parseInt(p.round, 10), orig = H.pad4(p.originalPickFor || fid);
          if (!y || !(r >= 1)) return;
          var tok = "FP_" + orig + "_" + y + "_" + r, w = wbPick(tok);
          out.push({ year: y, round: r, token: tok, label: y + " " + ord(r) + (orig !== fid ? " (" + H.teamName(orig) + ")" : ""),
            elig: pickElig(y, r, marksOk ? !!(w && w.forfeited) : null, w && w.forfeit_label) });
        });
      });
    }
    (wa || []).forEach(function (a) {
      var m = a && a.type === "PICK" ? /^DP_(\d+)_(\d+)$/.exec(String(a.pick_key || "").toUpperCase()) : null;
      if (!m) return;
      var y = String(a.pick_season || DATA.config().season), r = Number(m[1]) + 1, slot = Number(m[2]) + 1;
      // A current-year pick is never on the lineup-penalty forfeit list (that list holds future picks), so forfeit = false.
      out.push({ year: y, round: r, slot: slot, token: "DP_" + y + "_" + r + "_" + slot, label: y + " " + r + "." + (slot < 10 ? "0" : "") + slot + " (this year)",
        elig: pickElig(y, r, false, "") });
    });
    return out.sort(function (a, b) { return a.year === b.year ? (a.round - b.round) || ((a.slot || 0) - (b.slot || 0)) : a.year < b.year ? -1 : 1; });
  }
  // Why an asset in the draft can't be traded ("" = it can), for the builder's structure check.
  function ineligibleOf(item) {
    var list = /^P_/.test(item.token) ? playersOf(item.from).filter(function (x) { return "P_" + x.id === item.token; }) : picksOf(item.from).filter(function (x) { return x.token === item.token; });
    var a = list[0];
    return a && a.elig && !a.elig.tradeable ? a.elig.reason : "";
  }
  // Ruling 3: what a sent player counts toward the 50% cap-money limit. An expired rookie: his chosen extension's new salary,
  // else last season's salary (null ⇒ unavailable ⇒ $0 here; the server re-verifies). Everyone else: undefined (his own salary).
  function capBasis(item, draft) {
    var pid = pidOf(item.token); if (!pid) return undefined;
    var p = playerRec(item.from, pid); if (!p) return undefined;
    var R = rules(), yrs = R.contractYearsLeft(p.years);
    if (yrs == null || yrs >= 1 || !R.isRookieContractStatus(p.type)) return undefined;
    var key = ((draft && draft.ext) || {})[item.from + "|" + item.token], o = key ? extensionOptions(item).filter(function (x) { return x.option_key === key; })[0] : null;
    return R.capMoneyBasisDollars({ years: p.years, contract_status: p.type, taxi: !!p.isTaxi }, o ? { extensionYear1: y1(o) } : { priorSeasonSalary: playerElig(item.from, p).prior_salary });
  }

  // ── Pre-trade extension: the shared rule (shared/pretrade_extension.js), fed this player's own contract ──
  var extMemo = {};
  // ── Authoritative extension facts (read-only). An extension badge and choices need ALL of: the worker's extension history was readable
  // (`/trade-workbench` meta.counts.extension_history_ok === true), this franchise has not already extended the player, AND the worker's own full
  // eligibility check (owner, final year, tag, MYAC lock, September deadline, acquisition window, history, restructure, price) accepted a probe
  // request for him (the compliance preview). The history flag alone is not eligibility. Anything missing keeps them hidden.
  // A build may supply finished facts through window.UPS_FO_TRADE_BUILDER_CONFIG.extensionFacts(fid, pid) (the preview does, labeled simulated).
  var fx = { hist: null, histState: "idle", probes: {}, queue: [], timer: null, handle: null };
  function apiUrl(path, extra) {
    var c = DATA.config(), u = c.apiBase + path + "?L=" + encodeURIComponent(c.leagueId) + "&YEAR=" + encodeURIComponent(c.season) + (extra || "");
    return c.sessionQuery ? c.sessionQuery(u) : u;
  }
  function loadHistory() {
    if (fx.histState !== "idle") return;
    fx.histState = "loading";
    fetch(apiUrl("/trade-workbench"), { credentials: "omit", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; }, function () { return null; })
      .then(function (j) { fx.hist = j; fx.histState = j ? "done" : "error"; if (fx.handle) fx.handle.factsChanged(); });
  }
  function probeKey(item, pid) { return item.from + "|" + pid + "|" + item.to; }
  function runProbes() {
    fx.timer = null;
    var batch = fx.queue.splice(0, fx.queue.length);
    batch.reduce(function (chain, job) {
      return chain.then(function () {
        var body = { league_id: DATA.config().leagueId, season: DATA.config().season, from_franchise_id: FO.viewerFid(),
          movements: [{ from: job.item.from, to: job.item.to, tokens: [job.item.token] }], extension_requests: [job.row] };
        return fetch(apiUrl("/api/trades/compliance-preview"), { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "omit", body: JSON.stringify(body) })
          .then(function (r) { return r.json(); }, function () { return null; })
          .then(function (resp) { fx.probes[job.key] = { state: "done", result: root.UPS_TRADE_BUILDER_CORE.probeResult(resp, job.pid) }; if (fx.handle) fx.handle.factsChanged(); });
      });
    }, Promise.resolve());
  }
  // Ask the worker about ONE player (read-only: the compliance preview never writes). Needs the viewer to be a party to the movement.
  function scheduleProbe(item, pid, p) {
    var X = root.UPS_PRETRADE_EXT, C = root.UPS_TRADE_BUILDER_CORE, key = probeKey(item, pid);
    if (fx.probes[key] || !item.to || (item.from !== FO.viewerFid() && item.to !== FO.viewerFid())) return;
    var a = C.probeAsset(p), cand = a && X.buildSyntheticExtensionOptions(a)[0];
    if (!cand) { fx.probes[key] = { state: "done", result: { confirmed: false, reason: "not_eligible_by_contract" } }; return; }
    fx.probes[key] = { state: "queued" };
    fx.queue.push({ key: key, pid: pid, item: item, row: C.extensionRow(item, cand) });
    if (!fx.timer) fx.timer = setTimeout(runProbes, 300);
  }
  function serverFacts(item, pid, p) {
    var C = root.UPS_TRADE_BUILDER_CORE;
    loadHistory();
    var hist = fx.histState === "done" ? C.historyFacts(fx.hist, item.from, pid) : null;
    if (!hist) return null;                                           // history unreadable or not loaded: nothing is shown
    scheduleProbe(item, pid, p);
    var pr = fx.probes[probeKey(item, pid)];
    return C.extensionFacts(hist, pr && pr.state === "done" ? pr.result : null);
  }
  function extensionOptions(item) {
    var X = root.UPS_PRETRADE_EXT, pid = String(item.token || "").replace(/^P_/, "");
    var p = playerRec(item.from, pid);
    if (!X || !p) return [];
    var el = playerElig(item.from, p);
    if (!el.tradeable || el.extendable === false) return [];          // a locked tag (or an untradeable player) is never offered an extension
    var c = cfg(), facts = typeof c.extensionFacts === "function" ? c.extensionFacts(item.from, pid) : serverFacts(item, pid, p);
    var asset = root.UPS_TRADE_BUILDER_CORE.extensionInput(p, facts);
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
  function capImpacts(draft, tally) {
    var I = root.UPS_TRADE_IMPACT, out = {}, ok = false;
    var ms = root.UPS_TRADE_BUILDER_CORE.movements(draft);
    draft.teams.forEach(function (f) {
      var snap = FO.capFor(f);
      if (!snap || !I) { out[f] = null; return; }
      ok = true;
      var send = [], recv = [], sentK = 0, gotK = 0;
      draft.items.forEach(function (i) {
        var pid = pidOf(i.token); if (!pid) return;
        if (i.from === f) { var p = playerRec(f, pid); if (p) { send.push({ salary: p.salary, hit: FO.capHit(p), isTaxi: !!p.isTaxi, isIr: !!p.isIr, loaded: FO.isLoaded(p) }); if (tally && FO.isLoaded(p)) tally.loaded++; } }
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
  // loadedMoving: how many loaded contracts change teams in this trade (the "Cap & contracts" summary line).
  function impact(draft) { var tally = { loaded: 0 }, cap = capImpacts(draft, tally); return { cap: cap, lineup: lineupImpacts(draft), ext: extImpacts(draft), loadedMoving: cap ? tally.loaded : null }; }

  function preview(body) {
    var c = cfg();
    if (typeof c.preview === "function") return Promise.resolve(c.preview(body));
    var url = DATA.config().sessionQuery(DATA.config().apiBase + "/api/trades/compliance-preview?L=" + encodeURIComponent(DATA.config().leagueId) + "&YEAR=" + encodeURIComponent(DATA.config().season));
    // The server's read-only compliance preview. Any failure is "can't be checked", never a pass.
    return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "omit", body: JSON.stringify(body) })
      .then(function (r) { return r.json(); }, function () { return null; });
  }

  // The extension choice popup is the Front Office's own dialog; its buttons are handled here and handed to the builder.
  var current = null, mountedHost = null, keep = null;     // keep = { draft, label, dropped }: the builder's draft, outside its markup
  function wireDialog() {
    var body = document.getElementById("fo-about-body");
    if (!body || body.__tbWired) return;
    body.__tbWired = true;
    body.addEventListener("click", function (e) { if (current) current.dialogAction(e.target); });
  }
  function mount(host) {
    var c = cfg();
    wireDialog();
    fx = { hist: null, histState: "idle", probes: {}, queue: [], timer: null, handle: null };
    mountedHost = host;
    current = root.UPS_TRADE_BUILDER_VIEW.mount(host, {
      initial: keep,
      onDraft: function (d, meta) { keep = { draft: d, label: meta.label, dropped: meta.dropped }; },
      openDialog: function (title, html) { H.openDialog(title, html, { variant: "team" }); },
      closeDialog: function () { H.closeAbout(); },
      teams: teams(),
      assets: function (fid) { return { players: playersOf(fid), picks: picksOf(fid) }; },
      ineligibleOf: ineligibleOf,
      capBasis: capBasis,
      ctx: { leagueId: DATA.config().leagueId, season: DATA.config().season, viewerFid: FO.viewerFid() },
      impact: impact,
      extensionOptions: extensionOptions,
      playerLink: function (pid, fid, label) { return H.playerButton ? H.playerButton(pid, fid, label) : "<b>" + label + "</b>"; },
      preview: preview,
      sources: c.sources,
      debounceMs: c.debounceMs,                     // undefined = the view's default (tests set 0)
      // No send option exists: see the header.
      warRoomUrl: ("warRoomUrl" in c) ? c.warRoomUrl : (FO.warRoomUrl ? FO.warRoomUrl({}) : "")
    });
    fx.handle = current;
    // /trade-workbench carries the tag states, this year's picks and the forfeit marks the asset list needs (one read per mount).
    if (!c.workbench) loadHistory();
    return current;
  }

  // ── openDraft: a draft from another page (contract in the header) ──
  function assetOf(fid, token) {
    if (/^P_/.test(token)) { var p = playersOf(fid).filter(function (x) { return "P_" + x.id === token; })[0]; return p ? { label: p.name, salary: p.salary, taxi: p.taxi } : null; }
    var k = picksOf(fid).filter(function (x) { return x.token === token; })[0];
    return k ? { label: k.label, salary: 0, taxi: false } : null;
  }
  function live() { return !!(current && mountedHost && mountedHost.isConnected && mountedHost.__tbHandle === current); }
  function showBuilder() {
    var T = root.UPS_FO_TRADES;
    if (T && typeof T._setMode === "function") T._setMode("builder");
    if (FO && typeof FO.show === "function") FO.show("trades");
    var body = document.getElementById("fo-trades-body"), chip = body && !body.querySelector("#fo-tb-host") ? body.querySelector('[data-tf-mode="builder"]') : null;
    if (chip) chip.click();
  }
  function openDraft(input, options) {
    var C = root.UPS_TRADE_BUILDER_CORE;
    var fail = function (reason, dropped) { return { ok: false, reason: reason, dropped: dropped || [], clamped: [] }; };
    if (!FO || !DATA || !H || !C || !root.UPS_TRADE_BUILDER_VIEW || !FO.teams().length) return fail("not_ready");
    if (!input || typeof input !== "object" || !Array.isArray(input.movements) || !input.movements.length) return fail("bad_shape");
    var me = FO.viewerFid(), league = {}, source = String(input.source == null ? "" : input.source).trim() || "another page";
    FO.teams().forEach(function (t) { league[t.fid] = 1; });
    var dropped = [], items = [], cap = [], seen = {}, order = [];
    input.movements.forEach(function (m) {
      var from = C.pad4(m && m.from), to = C.pad4(m && m.to), toks = m && Array.isArray(m.tokens) ? m.tokens : [];
      var drop = function (token, reason) { dropped.push({ from: from, to: to, token: String(token == null ? "" : token), reason: reason }); };
      if (!league[from] || !league[to] || from === to) { toks.forEach(function (t) { drop(t, "bad_team"); }); return; }
      toks.forEach(function (t) {
        var token = String(t == null ? "" : t).trim();
        if (!/^(P_\d+|FP_\d{4}_\d{4}_\d+|DP_\d{4}_\d+_\d+)$/.test(token)) return drop(token, "bad_token");
        if (seen[from + "|" + token]) return drop(token, "duplicate");
        var a = assetOf(from, token); if (!a) return drop(token, "not_on_roster");
        seen[from + "|" + token] = 1;
        items.push({ from: from, to: to, token: token, label: a.label, salary: a.salary, taxi: a.taxi });
        [from, to].forEach(function (f) { if (order.indexOf(f) === -1) order.push(f); });
      });
      var ck = Math.floor(Number(m && m.cap_k) || 0); if (ck > 0) cap.push({ from: from, to: to, k: ck });
    });
    if (!items.length) return fail("no_valid_assets", dropped);
    if (order.indexOf(me) === -1) return fail("viewer_not_in_trade", dropped);
    if (order.length > 3) return fail("too_many_teams", dropped);
    var d = C.emptyDraft([me].concat(order.filter(function (f) { return f !== me; })));
    items.forEach(function (i) { d = C.addItem(d, i); });
    var clamped = [];
    cap.forEach(function (c) {
      if (d.teams.indexOf(c.from) === -1 || d.teams.indexOf(c.to) === -1) { clamped.push({ from: c.from, to: c.to, asked_k: c.k, max_k: 0 }); return; }   // money between teams with no asset in the trade
      d = C.setCapK(d, c.from, c.to, c.k);
    });
    var held = C.clampCap(d, capBasis); d = held.draft;
    held.clamped.forEach(function (key) { var p = key.split(">"), asked = cap.filter(function (c) { return c.from === p[0] && c.to === p[1]; })[0]; clamped.push({ from: p[0], to: p[1], asked_k: asked ? asked.k : 0, max_k: C.capMoneyMaxK(d, p[0], p[1], capBasis) }); });
    var cur = live() ? current.draft() : keep && keep.draft;
    if (cur && (cur.items.length || Object.keys(cur.capK || {}).length)) {
      var ask = options && typeof options.confirm === "function" ? options.confirm : typeof root.confirm === "function" ? function (q) { return root.confirm(q); } : null;
      if (!ask || !ask("Replace the trade you are building with the draft from " + source + "?")) return fail("kept_current", dropped);
    }
    keep = { draft: d, label: "Draft from " + source + " (not sent)", dropped: dropped.slice() };
    if (live()) current.loadDraft(keep);
    showBuilder();
    return { ok: true, dropped: dropped, clamped: clamped };
  }

  root.UPS_FO_TRADE_BUILDER = { _extensionOptions: extensionOptions, mount: mount, openDraft: openDraft, _picksOf: picksOf, _impact: impact, _playersOf: playersOf, _ineligibleOf: ineligibleOf, _capBasis: capBasis };
  document.addEventListener("fo:ready", function () { FO = root.UPS_FO; DATA = root.UPS_FO_DATA; H = root.UPS_FO_HUB; });
})(typeof window !== "undefined" ? window : this);
