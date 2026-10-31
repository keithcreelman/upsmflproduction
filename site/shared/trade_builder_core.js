/* Trade Builder core (Front Office, READ-ONLY; plan #1385, phase P3).
   Pure functions, no fetch/DOM: a draft of who sends what to whom, the request the
   server's compliance preview takes, and how its VERDICT is shown. The server's verdict
   (POST /api/trades/compliance-preview -> { compliance, verdict }) is the only authority:
   this module never decides that a trade is allowed, and nothing here can send one.
   Token grammar and the cap-money formula come from the shared rules (UPS_TRADE_RULES).
   Attaches window.UPS_TRADE_BUILDER_CORE and module.exports. */
(function (root) {
  "use strict";

  var R = root.UPS_TRADE_RULES || (typeof require === "function" ? require("./trade_rules.js") : null);

  function str(v) { return v == null ? "" : String(v).trim(); }
  function pad4(v) { var s = str(v).replace(/\D/g, ""); return s ? ("0000" + s).slice(-4) : ""; }

  // ── The draft ──────────────────────────────────────────────────────────
  // items: [{ from, to, token, label?, salary?, taxi? }]   capK: { "<from>><to>": whole $K }
  function emptyDraft(teams) { return { teams: (teams || []).map(pad4).filter(Boolean), items: [], capK: {}, ext: {} }; }
  function key(from, to) { return pad4(from) + ">" + pad4(to); }
  function clone(d) { return { teams: d.teams.slice(), items: d.items.slice(), capK: Object.assign({}, d.capK), ext: Object.assign({}, d.ext || {}) }; }

  function withTeams(d, teams) {
    var t = (teams || []).map(pad4).filter(Boolean);
    var n = clone(d);
    n.teams = t;
    // Dropping a team drops every asset and cap amount that touches it.
    n.items = n.items.filter(function (i) { return t.indexOf(i.from) !== -1 && t.indexOf(i.to) !== -1; });
    Object.keys(n.capK).forEach(function (k) { var p = k.split(">"); if (t.indexOf(p[0]) === -1 || t.indexOf(p[1]) === -1) delete n.capK[k]; });
    Object.keys(n.ext).forEach(function (k) { if (!n.items.some(function (i) { return i.from + "|" + i.token === k && t.indexOf(i.to) !== -1; })) delete n.ext[k]; });
    return n;
  }
  function hasItem(d, token, from) { return d.items.some(function (i) { return i.token === token && i.from === pad4(from); }); }
  function addItem(d, item) {
    var from = pad4(item.from), to = pad4(item.to), token = str(item.token);
    if (!from || !to || from === to || !token || hasItem(d, token, from)) return d;
    var n = clone(d);
    n.items.push({ from: from, to: to, token: token, label: item.label || token, salary: Number(item.salary) || 0, taxi: !!item.taxi });
    return n;
  }
  function removeItem(d, token, from) {
    var n = clone(d);
    n.items = n.items.filter(function (i) { return !(i.token === token && i.from === pad4(from)); });
    delete n.ext[pad4(from) + "|" + token];
    return n;
  }
  function setCapK(d, from, to, k) {
    var n = clone(d), v = Math.max(0, Math.floor(Number(k) || 0));
    if (v > 0) n.capK[key(from, to)] = v; else delete n.capK[key(from, to)];
    return n;
  }

  // A pre-trade extension CHOSEN for a player in this draft (a scenario only: nothing is saved to his contract).
  function setExt(d, from, token, optionKey) {
    var n = clone(d), k = pad4(from) + "|" + str(token);
    if (!optionKey || !hasItem(d, token, from)) delete n.ext[k]; else n.ext[k] = str(optionKey);
    return n;
  }
  // The extension_requests rows the server reads (the same row the Trade War Room sends), one per extended player.
  // optionsFor(item) returns that player's options from the shared rule (UPS_PRETRADE_EXT); a choice with no matching option is dropped.
  // One extension_requests row (the row the Trade War Room sends and the server reads) for an item and one of its options.
  function extensionRow(i, opt) {
    return { player_id: i.token.replace(/^P_/, ""), player_name: i.label, from_franchise_id: i.from, to_franchise_id: i.to, applies_to_acquirer: true,
      option_key: opt.option_key, extension_term: opt.extension_term, loaded_indicator: opt.loaded_indicator, preview_id: opt.preview_id == null ? null : opt.preview_id,
      preview_contract_info_string: opt.preview_contract_info_string || null, new_contract_status: opt.new_contract_status || null,
      new_contract_length: opt.new_contract_length == null ? null : opt.new_contract_length, new_TCV: opt.new_TCV == null ? null : opt.new_TCV,
      new_aav_current: opt.new_aav_current == null ? null : opt.new_aav_current, new_aav_future: opt.new_aav_future == null ? null : opt.new_aav_future };
  }
  function extensionRequests(d, optionsFor) {
    var out = [];
    d.items.forEach(function (i) {
      var key = (d.ext || {})[i.from + "|" + i.token]; if (!key || !optionsFor) return;
      var opt = (optionsFor(i) || []).filter(function (o) { return o.option_key === key; })[0];
      if (opt) out.push(extensionRow(i, opt));
    });
    return out;
  }

  // ── Pre-trade extension FACTS. An extension badge and its choices appear only when ALL of these hold for this franchise and player:
  //   history_ok       the worker could READ its extension history (`/trade-workbench` meta.counts.extension_history_ok === true);
  //   already_extended whether this franchise already used its extension on him (a boolean, only known when history_ok);
  //   server_confirmed the worker's own full eligibility check (owner, final year, tag, MYAC lock, September deadline and the acquisition
  //                    window, history, restructure, price) accepted a probe request for him (the compliance preview).
  // The history flag alone is NOT eligibility, and nothing is inferred from contract shape or `Ext:` text. Anything missing = no input.

  // From the worker's /trade-workbench response: this franchise's history fact for one player, or null when the history was not readable
  // (history_ok must be exactly true) or the player is not among that franchise's assets (we do not guess "not extended").
  function historyFacts(wb, fid, pid) {
    var ok = wb && wb.meta && wb.meta.counts && wb.meta.counts.extension_history_ok === true;
    if (!ok) return null;
    var team = ((wb && wb.teams) || []).filter(function (t) { return pad4(t && t.franchise_id) === pad4(fid); })[0];
    var asset = team && (team.assets || []).filter(function (a) { return a && String(a.type).toUpperCase() === "PLAYER" && String(a.player_id || "").replace(/\D/g, "") === String(pid).replace(/\D/g, ""); })[0];
    if (!asset) return null;
    return { history_ok: true, already_extended_by_this_franchise: asset.already_extended_by_this_franchise === true };
  }
  // From the compliance-preview response to a probe carrying ONE extension request for `pid`: did the worker's full eligibility check accept it?
  // Confirmed only when the response says ok === true (a missing or non-true ok is NOT a confirmation), the extension part could be evaluated, and the player is not in `extension_skipped`.
  // Anything else (a refusal, an unreadable authority, an error, a missing field) is NOT confirmed; `reason` carries the worker's own reason.
  function probeResult(resp, pid) {
    var id = String(pid).replace(/\D/g, "");
    if (!resp || typeof resp !== "object" || resp.ok !== true || !resp.compliance || !Array.isArray(resp.compliance.extension_skipped)) return { confirmed: false, reason: "no_answer" };
    if (resp.compliance.cap && resp.compliance.cap.reason === "extension_salaries_unavailable") return { confirmed: false, reason: "extension_salaries_unavailable" };
    var hit = resp.compliance.extension_skipped.filter(function (x) { return String(x && x.player_id || "").replace(/\D/g, "") === id; })[0];
    return hit ? { confirmed: false, reason: String(hit.reason || "refused") } : { confirmed: true, reason: "" };
  }
  // The combined facts the extension input needs, or null when any part is missing.
  function extensionFacts(history, probe) {
    if (!history || history.history_ok !== true || typeof history.already_extended_by_this_franchise !== "boolean") return null;
    if (!probe || probe.confirmed !== true) return null;
    return { history_ok: true, already_extended_by_this_franchise: history.already_extended_by_this_franchise, server_confirmed: true };
  }
  // The input to the shared pre-trade extension rule (UPS_PRETRADE_EXT) for ONE player of the SENDING franchise. Null (no badge, no choices)
  // unless every fact above is present. p is a Front Office player ({ position, salary, years, type, special, isTaxi }).
  function extensionInput(p, facts) {
    if (!p || !facts || facts.history_ok !== true || facts.server_confirmed !== true || typeof facts.already_extended_by_this_franchise !== "boolean") return null;
    var info = str(p.special), cl = /(?:^|\|)\s*CL\s*(\d+)/i.exec(info);
    return { type: "PLAYER", position: p.position, salary: p.salary, years: p.years, contract_type: p.type, contract_info: info,
      contract_length: cl ? parseInt(cl[1], 10) : 0, taxi: !!p.isTaxi, already_extended_by_this_franchise: facts.already_extended_by_this_franchise };
  }
  // The same asset WITHOUT any facts, used only to build a PROBE request for the worker to judge. Never shown; never an eligibility claim.
  function probeAsset(p) {
    var info = str(p && p.special), cl = /(?:^|\|)\s*CL\s*(\d+)/i.exec(info);
    return p ? { type: "PLAYER", position: p.position, salary: p.salary, years: p.years, contract_type: p.type, contract_info: info, contract_length: cl ? parseInt(cl[1], 10) : 0, taxi: !!p.isTaxi, already_extended_by_this_franchise: false } : null;
  }

  // One movement per (from, to) pair: the shape both the two- and three-team server paths read.
  function movements(d) {
    var by = {}, order = [];
    function slot(from, to) { var k = key(from, to); if (!by[k]) { by[k] = { from: pad4(from), to: pad4(to), tokens: [], cap_k: 0 }; order.push(k); } return by[k]; }
    d.items.forEach(function (i) { slot(i.from, i.to).tokens.push(i.token); });
    Object.keys(d.capK).forEach(function (k) { var p = k.split(">"); slot(p[0], p[1]).cap_k = d.capK[k]; });
    return order.map(function (k) { return by[k]; });
  }
  function parties(d) {
    var s = {};
    movements(d).forEach(function (m) { s[m.from] = 1; s[m.to] = 1; });
    return Object.keys(s).sort();
  }

  // The most cap money a team may include: half the NON-TAXI player salary it sends, in whole $K rounded down (canon §A6; the shared
  // rule UPS_TRADE_RULES.capMoneyMaxK). Two-team: counted per side (everything this team sends). Three-team: per movement
  // (only what goes to that destination). Picks carry no salary. The server applies its own basis and is the authority (R2 is undecided),
  // so this is the page's guard against an amount the rule would refuse, never a ruling.
  function capMoneyMaxK(d, from, to) {
    var f = pad4(from), t = pad4(to), three = d.teams.length === 3, total = 0;
    d.items.forEach(function (i) {
      if (i.from !== f || (three && i.to !== t) || i.taxi || !/^P_/.test(i.token)) return;
      total += Number(i.salary) || 0;
    });
    return R.capMoneyMaxK(total);
  }
  function capMoneyHintK(d, from) {          // back-compat: everything this team sends
    var total = 0;
    d.items.forEach(function (i) { if (i.from === pad4(from) && !i.taxi && /^P_/.test(i.token)) total += Number(i.salary) || 0; });
    return R.capMoneyMaxK(total);
  }
  // A draft with every cap-money amount held to its maximum; clamped lists the keys that were reduced.
  function clampCap(d) {
    var n = clone(d), clamped = [];
    Object.keys(n.capK).forEach(function (k) {
      var p = k.split(">"), max = capMoneyMaxK(n, p[0], p[1]);
      if (n.capK[k] > max) { clamped.push(k); if (max > 0) n.capK[k] = max; else delete n.capK[k]; }
    });
    return { draft: n, clamped: clamped };
  }

  // Is the proposal structurally COMPLETE? (Keith 2026-10-27) The same rule for two and three teams: EVERY team in the trade must
  // SEND at least one player or pick AND RECEIVE at least one, so nobody gives an asset away for nothing and nobody takes one for nothing.
  // Cap money never counts toward this (it is not an asset, and "money alone is never a trade"), and every asset must go from a team in the
  // trade to a different team in the trade. This is STRICTER than today's War Room and worker (the War Room's three-team builder only needs all
  // three teams involved; the worker only needs one asset overall), so it is a rules discrepancy to resolve, documented in the PR.
  // nameOf is optional (fid -> team name) for the wording; each gap carries the team it is about.
  function gaps(d, nameOf) {
    var nm = nameOf || function (f) { return "Team " + f; }, out = [], n = d.teams.length;
    if (!d.items.length) return [{ code: "no_assets", message: "Nothing is selected yet. Cap money alone is not a trade." }];
    if (n < 2) out.push({ code: "choose_team", message: "Choose a trade partner." });
    if (n > 3) out.push({ code: "too_many_teams", message: "A trade can include at most three teams." });
    d.items.forEach(function (i) {
      if (d.teams.indexOf(i.from) === -1 || d.teams.indexOf(i.to) === -1 || i.from === i.to) out.push({ code: "bad_destination", message: i.label + " has no valid destination in this trade." });
      if (R.parseAssetToken(i.token).kind === "unknown") out.push({ code: "unknown_asset", message: "An asset could not be read: " + i.token });
    });
    d.teams.forEach(function (f) {
      var sends = d.items.some(function (i) { return i.from === f; }), gets = d.items.some(function (i) { return i.to === f; });
      if (!sends && !gets) out.push({ code: "team_idle", fid: f, message: nm(f) + " is not part of the trade yet: it neither sends nor receives an asset." });
      else if (sends && !gets) out.push({ code: "receives_nothing", fid: f, message: nm(f) + " is sending assets but receiving nothing." });
      else if (!sends && gets) out.push({ code: "sends_nothing", fid: f, message: nm(f) + " is receiving assets but sending nothing." });
    });
    return out;
  }

  function request(d, ctx, extReqs) {
    return {
      league_id: str(ctx && ctx.leagueId), season: str(ctx && ctx.season),
      from_franchise_id: pad4(ctx && ctx.viewerFid),
      movements: movements(d).map(function (m) { return { from: m.from, to: m.to, tokens: m.tokens.slice(), cap_k: m.cap_k }; }),
      extension_requests: extReqs || []
    };
  }
  // Same draft -> same signature, so a late answer for an old draft can be told apart from the current one.
  function signature(d, ctx) {
    var r = request(d, ctx);
    if (!r.movements.length) return "";
    var ms = r.movements.map(function (m) { return m.from + ">" + m.to + ":" + R.tradeTokenSet(m.tokens).join(",") + ":" + m.cap_k; }).sort();
    var ex = Object.keys(d.ext || {}).sort().map(function (k) { return k + "=" + d.ext[k]; }).join(",");
    return r.league_id + "|" + r.season + "|" + r.from_franchise_id + "|" + ms.join("||") + "|" + ex;
  }

  // ── Showing the server's verdict ───────────────────────────────────────
  var WORDING = {
    cap_ack_required: "A team would end up over the salary cap. The affected owner must acknowledge the exact figure before it can be sent.",
    cap_unavailable: "The salary cap could not be checked right now.",
    loaded_contract_limit: "A team would go over five loaded contracts.",
    loaded_contracts_unavailable: "Loaded contracts could not be checked right now.",
    asset_ownership_mismatch: "A player or pick is not on the team listed.",
    pick_not_tradeable: "A draft pick in this trade cannot be traded.",
    cap_money_rule: "Cap money is more than the rule allows.",
    assets_unavailable: "The assets could not be checked with MFL right now.",
    pick_forfeited: "A draft pick in this trade has been forfeited.",
    forfeit_check_unavailable: "Pick forfeitures could not be checked right now.",
    trade_closed: "MFL's trade calendar is closed.",
    trade_lock_unavailable: "MFL's trade calendar could not be read. MFL decides when trades close.",
    extension_unverified: "A pre-trade extension cannot be approved from a preview."
  };
  function reasonText(r) { return WORDING[r && r.code] || str(r && r.message) || "This could not be checked."; }

  function lockView(lock) {
    // A lock marked sample (the preview's canned answer) is always labeled as such, never as MFL's live calendar.
    var pre = lock && lock.sample ? "SAMPLE DATA, not the live trade calendar: " : "";
    if (lock && lock.state === "upcoming" && lock.label) return { tone: "ok", text: pre + "Trades close " + lock.label + "." };
    if (lock && lock.state === "none") return { tone: "ok", text: pre + "No trade lock is scheduled in MFL's calendar." };
    if (lock && lock.state === "closed") return { tone: "bad", text: pre + "MFL's trade calendar is closed" + (lock.label ? " (since " + lock.label + ")" : "") + "." };
    return { tone: "warn", text: "MFL's trade calendar could not be confirmed. MFL decides." };
  }

  // The one object that drives the panel. canSend is ALWAYS false: a preview verdict never promises a send.
  // canAttempt only says the Send step may be OFFERED: the proposal is structurally complete, the server's check ran and came back
  // provisional / needs an acknowledgment, and nothing calculated here blocks it. The write path re-checks everything; MFL decides.
  // A proposal that is empty or incomplete NEVER reads a server answer, so it can never look "fine".
  // calc: { blocked:[text], ack:[text] } from the cap / loaded-contract math the page ran itself.
  function readiness(gapList, phase, resp, calc) {
    var base = { canSend: false, canAttempt: false, reasons: [], lock: null, checks: null };
    calc = calc || { blocked: [], ack: [] };
    if (gapList && gapList.length) {
      var none = gapList.some(function (g) { return g.code === "no_assets"; });
      return Object.assign(base, { state: none ? "none" : "incomplete", label: none ? "No trade proposed" : "Incomplete trade", reasons: gapList.map(function (g) { return { code: g.code, text: g.message }; }) });
    }
    if (phase === "idle") return Object.assign(base, { state: "checking", label: "Not checked yet" });
    if (phase === "checking") return Object.assign(base, { state: "checking", label: "Checking with MFL…" });
    var v = resp && resp.ok !== false && resp.verdict;
    if (!v || typeof v !== "object") return Object.assign(base, { state: "unavailable", label: "Can’t be checked right now", reasons: [{ code: "verdict_unavailable", text: "The server’s check did not come back. Nothing is confirmed." }] });
    var label = { blocked: "Not allowed as built", needs_acknowledgment: "Needs an acknowledgment", unavailable: "Can’t be fully checked", provisional: "Looks fine so far" }[v.status] || "Can’t be fully checked";
    var state = { blocked: "blocked", needs_acknowledgment: "needs_ack", provisional: "provisional" }[v.status] || "unavailable";
    var reasons = (v.reasons || []).filter(function (r) { return r.code !== "trade_closed" && r.code !== "trade_lock_unavailable"; }).map(function (r) { return { code: r.code, text: reasonText(r) }; });
    if (calc.blocked.length) { state = "blocked"; label = "Not allowed as built"; calc.blocked.forEach(function (t) { reasons.push({ code: "calculated_block", text: t }); }); }
    else if (calc.ack.length && state === "provisional") { state = "needs_ack"; label = "Needs an acknowledgment"; calc.ack.forEach(function (t) { reasons.push({ code: "calculated_ack", text: t }); }); }
    return Object.assign(base, { canAttempt: state === "provisional" || state === "needs_ack", state: state, label: label, reasons: reasons, lock: lockView(v.trade_lock), checks: v.checks || null });
  }

  // What a send would carry: the same movements the preview checked, plus the owner's note. The two-team and
  // three-team write routes each have their own body; this is the neutral plan both are built from.
  function sendPlan(d, ctx, note, extReqs) {
    var r = request(d, ctx, extReqs), n = String(note == null ? "" : note).replace(/\s+\n/g, "\n").trim().slice(0, 500);
    return { kind: parties(d).length === 3 ? "three_team" : "two_team", league_id: r.league_id, season: r.season, from_franchise_id: r.from_franchise_id, movements: r.movements, extension_requests: r.extension_requests, note: n };
  }
  // Plain lines for the review step: what each team sends, in the order owners think of it.
  function summary(d, nameOf) {
    var nm = nameOf || function (f) { return "Team " + f; };
    return movements(d).map(function (m) {
      var items = d.items.filter(function (i) { return i.from === m.from && i.to === m.to; }).map(function (i) { var e = (d.ext || {})[i.from + "|" + i.token]; return i.label + (e ? " (with a proposed " + e.split("|")[0].replace("YR", "-year") + " pre-trade extension, not yet approved)" : ""); });
      if (m.cap_k) items.push("$" + m.cap_k + "K cap money");
      return { from: m.from, to: m.to, text: nm(m.from) + " sends " + items.join(", ") + " to " + nm(m.to) };
    });
  }

  var api = {
    extensionRow: extensionRow, extensionInput: extensionInput, extensionFacts: extensionFacts, historyFacts: historyFacts, probeResult: probeResult, probeAsset: probeAsset, sendPlan: sendPlan, summary: summary, setExt: setExt, extensionRequests: extensionRequests,
    emptyDraft: emptyDraft, withTeams: withTeams, addItem: addItem, removeItem: removeItem, setCapK: setCapK, hasItem: hasItem,
    movements: movements, parties: parties, capMoneyHintK: capMoneyHintK, capMoneyMaxK: capMoneyMaxK, clampCap: clampCap, gaps: gaps, request: request, signature: signature,
    readiness: readiness, lockView: lockView, reasonText: reasonText, pad4: pad4
  };
  root.UPS_TRADE_BUILDER_CORE = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : this);
