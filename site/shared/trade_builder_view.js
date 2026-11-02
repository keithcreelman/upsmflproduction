/* Trade Builder view (Front Office → Trades → Trade builder; plan #1385), in the Front Office's own look (fo-card / fo-table / btn;
   the layout rules are .fo-tb-* in front_office.css). Three disclosures, ALL CLOSED at first, each a real button (aria-expanded,
   keyboard operable) with a one-line summary, then the review that is always visible:
     1 Build trade       the teams side by side: what each sends and receives, cap money (− / + / typed, held to the rule's maximum)
     2 Cap & contracts   cap and contract table, loaded contracts, proposed pre-trade extensions
     3 Lineup impact     what each lineup gains or loses
     Review              validation (calculated here vs the server's check), summary, note, and a Send offer button that is ALWAYS disabled
   The draft lives in this closure (and the adapter keeps a copy through onDraft), never in the markup: opening or closing a section,
   or a data refresh, only re-renders it.
   The server's verdict (POST /api/trades/compliance-preview) is the only authority on whether a trade is allowed.
   SEND IS NOT AVAILABLE FROM THE FRONT OFFICE. Whatever the verdict, Send offer renders disabled with a plain reason, and
   no click opens a confirmation or sends anything. A live Send is a separate, separately approved change. No write route is
   named or called from this file. The ONE exception is `sender` below, which the Front Office passes only behind its
   off-by-default write flag (FO_TRADE_BUILDER_SEND, defined by no production config): only `sender.enabled === true`
   enables the button, and the send itself is the sender's (site/rosters/v2/fo_trade_offers.js, the War Room's requests).
   Without it the Review card is exactly #1419's.
     mount(el, { teams:[{fid,name,abbrev?}], ctx:{leagueId,season,viewerFid},
                 assets(fid) -> {players:[{id,name,pos,salary,years,type,taxi,ir,elig?}], picks:[{token,label,elig?}]},
                   (elig = UPS_TRADE_RULES.tradeAssetEligibility's answer: an untradeable asset can't be added and its reason is shown beside it)
                 ineligibleOf(item) -> reason|"" , capBasis(item, draft) -> dollars|null|undefined (ruling 3, the 50% cap-money basis),
                 impact(draft) -> { cap:{fid:{r}}|null, lineup:{state,message,teams:{fid:{...}}}, ext:[...], loadedMoving? },
                 extensionOptions(item) -> [option] (the shared pre-trade extension rule; [] = not eligible),
                 playerLink(pid, fid, label) -> html (opens the Front Office player panel),
                 openDialog(title, html) / closeDialog() (the Front Office dialog; the choice popup for an eligible player),
                 preview(body) -> Promise<json>, sources:{data,verdict}, warRoomUrl?, debounceMs,
                 initial?: { draft, label, dropped }   a draft to start from (kept by the adapter; ignored unless the viewer is its first team),
                 onDraft?(draft, { label, dropped })  called after every change, so the adapter can keep the draft across re-mounts,
                 sender?: { enabled: true, send(draft, note) -> Promise<{ state, message, done }>, noteLimit(teamCount) -> n, label?() -> text,
                           ready?() -> bool (false: Send disabled, "Loading…"),
                           counter?() -> { tradeId, from } | null (a counter is being built), cancelCounter?() (Cancel counter: nothing sent or declined) }
                          (behind the Front Office write flag only; any other value is ignored) })
     handle: { loadDraft({ draft, label, dropped }), isEmpty(), draft(), state(), refresh(), factsChanged(), dialogAction(target) } */
(function (root) {
  "use strict";
  var C = root.UPS_TRADE_BUILDER_CORE || (typeof require === "function" ? require("./trade_builder_core.js") : null);

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function k(d) { var v = Math.round((Number(d) || 0) / 100) / 10; return "$" + (v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)) + "K"; }
  function sk(d) { var v = Math.round(Number(d) || 0); return v === 0 ? "$0K" : (v > 0 ? "+" : "−") + k(Math.abs(v)); }
  function f1(x) { return (Math.round((Number(x) || 0) * 10) / 10).toFixed(1); }
  function sf1(x) { var v = Math.round((Number(x) || 0) * 10) / 10; return v === 0 ? "0.0" : (v > 0 ? "+" : "−") + Math.abs(v).toFixed(1); }
  function dol(d) { return "$" + Math.round(Number(d) || 0).toLocaleString("en-US"); }
  function src(kind, text) { return '<span class="fo-tb-src fo-tb-src-' + kind + '">' + esc(text) + "</span>"; }

  function mount(el, opt) {
    var teams = opt.teams, ctx = opt.ctx, me = C.pad4(ctx.viewerFid);
    var delay = opt.debounceMs == null ? 600 : opt.debounceMs;
    var S = opt.sources || {};
    var draft = C.emptyDraft([me]);
    var st = { phase: "idle", resp: null, seq: 0, timer: null, note: "", open: {}, q: {}, memo: { sig: "", imp: null }, capNote: {}, dlg: null, prompted: {},
      disc: { 1: false, 2: false, 3: false }, label: "", dropped: [], sending: false, outcome: null };
    var SENDER = opt.sender && opt.sender.enabled === true && typeof opt.sender.send === "function" ? opt.sender : null;
    // A draft handed in (kept by the adapter, or loaded from another page): only one that starts with the viewer's own team.
    function adopt(init) {
      if (!init || !init.draft || !Array.isArray(init.draft.teams) || init.draft.teams[0] !== me) return false;
      draft = C.clampCap(C.withTeams(init.draft, init.draft.teams), basis).draft;
      st.label = init.label || ""; st.dropped = (init.dropped || []).slice();
      // Players already in the draft are not "just added": no extension popup jumps open for them ("Choose extension" stays on the row).
      st.prompted = {}; draft.items.forEach(function (i) { st.prompted[i.from + "|" + i.token] = 1; });
      return true;
    }
    function isEmpty() { return !draft.items.length && !Object.keys(draft.capK).length; }
    var info = {}; teams.forEach(function (t) { info[C.pad4(t.fid)] = t; });
    function nm(f) { return (info[f] && info[f].name) || "Team " + f; }
    function others() { return draft.teams.filter(function (f) { return f !== me; }); }
    // Eligibility (rulings 2/3) and the cap-money basis come from the adapter, which runs the shared rule (UPS_TRADE_RULES).
    function basis(item, d) { return opt.capBasis ? opt.capBasis(item, d || draft) : undefined; }
    function whyNot(item) { return opt.ineligibleOf ? opt.ineligibleOf(item) || "" : ""; }
    function gapsNow() { return C.gaps(draft, nm, whyNot); }
    function extOpts(item) { return opt.extensionOptions ? (opt.extensionOptions(item) || []) : []; }
    // The page's own cap / loaded-contract / lineup math, computed once per draft state (and again when data refreshes).
    function impactNow() {
      if (!others().length || !draft.items.length) return null;
      var key = JSON.stringify([draft.teams, draft.items.map(function (i) { return [i.from, i.to, i.token]; }), draft.capK, draft.ext]);
      if (st.memo.sig !== key || !st.memo.imp) st.memo = { sig: key, imp: opt.impact(draft) };
      return st.memo.imp;
    }
    function calcFlags(imp) {
      var out = { blocked: [], ack: [] };
      if (!imp || !imp.cap) return out;
      draft.teams.forEach(function (f) {
        var c = imp.cap[f]; if (!c) return;
        if (c.r.overCap) out.ack.push(nm(f) + " would be " + k(c.r.after.alloc - c.r.ceiling) + " over the cap: the owner must acknowledge the exact figure before it can be sent.");
        if (c.r.loadedOver) out.blocked.push(nm(f) + " would have " + c.r.after.loaded + " loaded contracts (the limit is " + c.r.loadedMax + ").");
      });
      return out;
    }
    function readiness() { return C.readiness(gapsNow(), st.phase, st.resp, calcFlags(impactNow())); }
    function extReqs() { return C.extensionRequests(draft, extOpts); }

    function changed() {
      var held = C.clampCap(draft, basis); if (held.clamped.length) { draft = held.draft; held.clamped.forEach(function (key) { st.capNote[key] = true; }); }
      if (isEmpty()) { st.label = ""; st.dropped = []; }       // an emptied draft is no longer "from" anywhere
      if (opt.onDraft) opt.onDraft(draft, { label: st.label, dropped: st.dropped.slice() });
      var gaps = C.gaps(draft, null, whyNot), sig = gaps.length ? "" : C.signature(draft, ctx);
      st.memo = { sig: "", imp: null };
      clearTimeout(st.timer);
      st.seq++;                          // any answer still in flight is now stale
      if (!sig) { st.phase = "idle"; st.resp = null; render(); return; }
      st.phase = "checking"; st.resp = null; render();
      var mine = st.seq;
      st.timer = setTimeout(function () {
        Promise.resolve().then(function () { return opt.preview(C.request(draft, ctx, extReqs())); }).then(function (j) { return j; }, function () { return null; })
          .then(function (j) { if (mine !== st.seq) return; st.phase = "done"; st.resp = j; render(); });
      }, delay);
    }
    function dest(from) { var t = draft.teams, i = t.indexOf(from); return t.length === 2 ? t[1 - i] : t[(i + 1) % t.length]; }
    function playerOf(fid, tok) { var a = opt.assets(fid) || { players: [] }; return a.players.filter(function (x) { return "P_" + x.id === tok; })[0]; }

    // ── Trade proposal ────────────────────────────────────────────────
    function pname(p, fid) { return opt.playerLink ? opt.playerLink(p.id, fid, p.name) : "<b>" + esc(p.name) + "</b>"; }
    function contractLine(p) { return [p.years != null ? p.years + " yr" : "", p.type || "", p.taxi ? "taxi" : "", p.ir ? "IR" : ""].filter(Boolean).join(" · "); }
    // The eligibility line shown BESIDE an asset (never only on hover): why it can't be traded, or a notice (a locked tag can't be extended,
    // an expired rookie's window, a forfeit list that couldn't be read).
    function eligLine(e) {
      if (!e) return "";
      if (!e.tradeable) return '<div class="fo-tb-why bad" data-why>' + esc(e.reason) + "</div>";
      var notes = [e.extension_reason, e.warning].filter(Boolean);
      return notes.length ? '<div class="fo-tb-why" data-note-elig>' + esc(notes.join(" ")) + "</div>" : "";
    }
    function pickOf(fid, tok) { var a = opt.assets(fid) || { picks: [] }; return (a.picks || []).filter(function (x) { return x.token === tok; })[0]; }
    function itemRow(i, withControls) {
      var p = /^P_/.test(i.token) ? playerOf(i.from, i.token) : null;
      var kk = p ? null : pickOf(i.from, i.token);
      var cells = p ? '<td>' + pname(p, i.from) + ' <span class="fo-muted">' + esc(p.pos) + '</span><div class="fo-tb-sub">' + esc(contractLine(p)) + '</div>' + eligLine(p.elig) + '</td><td class="num">' + k(p.salary) + "</td>"
        : '<td><b>' + esc(i.label) + '</b> <span class="fo-muted">draft pick</span>' + eligLine(kk && kk.elig) + '</td><td class="num">—</td>';
      var ctl = "";
      if (withControls) {
        ctl = '<td class="fo-tb-ctl">' + (draft.teams.length === 3 ? '<select aria-label="Send ' + esc(i.label) + ' to" data-dest="' + esc(i.token) + '" data-from="' + i.from + '">' + draft.teams.filter(function (f) { return f !== i.from; }).map(function (f) {
          return '<option value="' + f + '"' + (i.to === f ? " selected" : "") + ">to " + esc(nm(f)) + "</option>"; }).join("") + "</select> " : "") +
          '<button type="button" class="btn secondary small" data-tok="' + esc(i.token) + '" data-from="' + i.from + '" aria-label="Remove ' + esc(i.label) + '">Remove</button></td>';
      }
      return "<tr>" + cells + ctl + "</tr>" + (withControls && p ? extensionRow(i, p) : "");
    }
    // ── Pre-trade extension (a SCENARIO: nothing is saved to the player's contract) ──
    function extCompare(i, p, o) {
      var Xt = root.UPS_PRETRADE_EXT, y = Xt ? Xt.parseContractInfoSummary(o.preview_contract_info_string).y_by_year_dollars : {}, ys = Object.keys(y).sort(function (a, b) { return a - b; }).map(function (n) { return k(y[n]); });
      return '<span class="fo-tb-cur">Current: ' + esc(p.years) + ' yr left · ' + k(p.salary) + (p.type ? " · " + esc(p.type) : "") + '</span> → <span class="fo-tb-prop">Proposed (not yet approved): ' + esc(o.new_contract_length) + " yr · " + ys.join(" then ") + " · total " + k(o.new_TCV) + " · " + esc(o.new_contract_status || "") + "</span>";
    }
    function extensionRow(i, p) {
      var opts = extOpts(i); if (!opts.length) return "";
      var chosen = (draft.ext || {})[i.from + "|" + i.token] || "", o = opts.filter(function (x) { return x.option_key === chosen; })[0];
      return '<tr class="fo-tb-extrow"><td colspan="3"><div class="fo-tb-extbar"><span class="fo-tf-tag ok">Extension eligible</span> ' + (S.extensions ? src("verdict", S.extensions) + " " : "") +
        (o ? "<b>" + esc(o.extension_term.replace("YR", "-year")) + ' extension</b> <span class="fo-tf-tag need">Proposed · not yet approved</span>' : '<span class="fo-muted">Not extended</span>') +
        ' <button type="button" class="btn small' + (o ? " secondary" : "") + '" data-tbx-open="' + esc(i.token) + '" data-from="' + i.from + '">' + (o ? "Change extension" : "Choose extension") + "</button></div>" +
        (o ? '<p class="fo-tb-extline">' + extCompare(i, p, o) + "</p>" : "") + "</td></tr>";
    }
    // The popup (the Front Office's own dialog) that opens when an eligible player is ADDED, and again from "Choose / Change extension".
    function extDialogHtml(i, p) {
      var opts = extOpts(i), chosen = (draft.ext || {})[i.from + "|" + i.token] || "", recv = i.to;
      var cardFor = function (key, title, o) {
        var d2 = C.setExt(draft, i.from, i.token, key), im = opt.impact(d2), c = im && im.cap && im.cap[recv], r = c && c.r;
        var lines = o ? [
          "Contract: " + esc(o.new_contract_length) + " yr, total " + k(o.new_TCV) + " · " + esc(o.new_contract_status || ""),
          "This season: " + k(extY1(o, p)) + (extY1(o, p) === Number(p.salary) ? " (unchanged)" : " (was " + k(p.salary) + ")"),
          "Added future years: " + k(extAdded(o))
        ] : ["Contract stays: " + esc(p.years) + " yr left · " + k(p.salary)];
        if (r) lines.push(esc(nm(recv)) + " cap after: " + k(r.after.alloc) + " (" + (r.after.space < 0 ? "−" + k(-r.after.space) + " over" : k(r.after.space) + " space") + ")");
        return '<div class="fo-tb-xopt' + (chosen === key ? " on" : "") + '"><h4>' + esc(title) + "</h4><ul>" + lines.map(function (x) { return "<li>" + x + "</li>"; }).join("") + "</ul>" +
          '<button type="button" class="btn" data-tbx-pick="' + esc(key) + '" aria-pressed="' + (chosen === key) + '">' + (!key ? "Continue without extending" : chosen === key ? "Chosen" : "Choose " + esc(o.extension_term.replace("YR", "-year"))) + "</button></div>";
      };
      return '<div class="fo-tb-xd"><p><b>' + esc(p.name) + '</b> is eligible for a pre-trade extension. <span class="fo-tf-tag need">Proposed · not yet approved</span></p>' +
        '<p class="fo-tb-cur">Current: ' + esc(p.years) + " yr left · " + k(p.salary) + (p.type ? " · " + esc(p.type) : "") + '</p><div class="fo-tb-xopts">' +
        cardFor("", "No extension", null) + opts.map(function (o) { return cardFor(o.option_key, o.extension_term.replace("YR", "-year") + " extension", o); }).join("") + "</div></div>";
    }
    function extY1(o, p) { var X = root.UPS_PRETRADE_EXT, y = X ? X.parseContractInfoSummary(o.preview_contract_info_string).y_by_year_dollars : {}; return y["1"] != null ? y["1"] : Number(p.salary); }
    function extAdded(o) { var X = root.UPS_PRETRADE_EXT, y = X ? X.parseContractInfoSummary(o.preview_contract_info_string).y_by_year_dollars : {}; return Object.keys(y).filter(function (n) { return n !== "1"; }).reduce(function (a, n) { return a + y[n]; }, 0); }
    // Open the choice popup ONCE for each extension-eligible player in the trade, when he is added or when the server's facts about him arrive
    // (they can arrive after he is added). Never on a click of his row or from his player panel.
    function promptExtensions() {
      var it = draft.items.filter(function (i) { return !st.prompted[i.from + "|" + i.token] && extOpts(i).length; })[0];
      if (it) { st.prompted[it.from + "|" + it.token] = 1; openExtDialog(it.from, it.token); }
    }
    function openExtDialog(from, token) {
      var item = draft.items.filter(function (i) { return i.from === from && i.token === token; })[0], p = item && playerOf(from, token);
      if (!item || !p || !opt.openDialog) return;
      st.dlg = { from: from, token: token };
      opt.openDialog("Pre-trade extension", extDialogHtml(item, p));
    }
    function listTable(rows, empty, cols) {
      return rows ? '<div class="fo-table-scroll fo-tb-scroll"><table class="fo-table fo-tb-table"><thead><tr><th>Asset</th><th class="num">Salary</th>' + (cols ? "<th></th>" : "") + "</tr></thead><tbody>" + rows + "</tbody></table></div>" : '<p class="fo-ov-empty">' + empty + "</p>";
    }
    // An asset the shared rule refuses can't be added (it can still be removed if a draft from another page brought it in).
    function addBtn(on, tok, f, label, e) {
      var off = !on && e && !e.tradeable;
      return '<button type="button" class="btn small" aria-pressed="' + on + '" data-tok="' + esc(tok) + '" data-from="' + f + '"' + (off ? ' disabled aria-disabled="true"' : "") +
        ' aria-label="' + (on ? "Remove " : off ? "Can’t add " : "Add ") + esc(label) + (off ? ": " + esc(e.reason) : "") + '">' + (on ? "Added" : off ? "Can’t add" : "Add") + "</button>";
    }
    function rosterPicker(f) {
      var a = opt.assets(f) || { players: [], picks: [] };
      var q = (st.q[f] || "").toLowerCase();
      var rows = a.players.filter(function (p) { return !q || (p.name + " " + p.pos).toLowerCase().indexOf(q) !== -1; }).map(function (p) {
        var eligible = extOpts({ from: f, token: "P_" + p.id, label: p.name }).length > 0;
        return '<tr' + (p.elig && !p.elig.tradeable ? ' class="fo-tb-off"' : "") + '><td>' + pname(p, f) + ' <span class="fo-muted">' + esc(p.pos) + '</span><div class="fo-tb-sub">' + esc(contractLine(p)) + (eligible ? ' <span class="fo-tf-tag ok" title="Eligible for a pre-trade extension under the league rule">Extension eligible</span>' : "") + "</div>" + eligLine(p.elig) + '</td><td class="num">' + k(p.salary) + '</td><td class="fo-tb-ctl">' + addBtn(C.hasItem(draft, "P_" + p.id, f), "P_" + p.id, f, p.name, p.elig) + "</td></tr>";
      }).concat(a.picks.filter(function (p) { return !q || p.label.toLowerCase().indexOf(q) !== -1; }).map(function (p) {
        return '<tr' + (p.elig && !p.elig.tradeable ? ' class="fo-tb-off"' : "") + '><td><b>' + esc(p.label) + '</b> <span class="fo-muted">draft pick</span>' + eligLine(p.elig) + '</td><td class="num">—</td><td class="fo-tb-ctl">' + addBtn(C.hasItem(draft, p.token, f), p.token, f, p.label, p.elig) + "</td></tr>";
      })).join("");
      return '<details class="fo-tb-roster"' + (st.open[f] ? " open" : "") + ' data-open="' + f + '"><summary>Add from ' + esc(nm(f)) + '’s roster</summary>' +
        '<input type="search" class="fo-tb-q" data-q="' + f + '" placeholder="Find a player or pick" value="' + esc(st.q[f] || "") + '" aria-label="Find in ' + esc(nm(f)) + ' roster">' +
        '<div class="fo-table-scroll fo-tb-scroll fo-tb-pick"><table class="fo-table fo-tb-table"><tbody>' + (rows || '<tr><td class="fo-muted">Nothing matches.</td></tr>') + "</tbody></table></div></details>";
    }
    // Cap money this team sends, one row per destination (two-team: one row in each team's panel, so both directions; three-team: one row
    // per destination). − / + step $1K (the core's whole-$K unit) and are disabled at $0 and at the rule's maximum (C.capMoneyMaxK); a typed
    // amount is held to the same maximum by C.clampCap in changed(). The rule itself lives in the core and the shared rules.
    function moneyBlock(f, imp) {
      var tos = draft.teams.filter(function (x) { return x !== f; });
      var space = imp && imp.cap && imp.cap[f] ? imp.cap[f].r.before.space : null;
      return '<div class="fo-tb-money"><h4>Cap money ' + esc(nm(f)) + " sends</h4>" + tos.map(function (to) {
        var key = f + ">" + to, max = C.capMoneyMaxK(draft, f, to, basis), cur = draft.capK[key] || 0, who = nm(f) + " sends to " + nm(to);
        var step = function (d, sign, label, off) {
          return '<button type="button" class="btn secondary fo-tb-step" data-cap-step="' + d + '" data-step-from="' + f + '" data-step-to="' + to + '"' + (off ? " disabled" : "") + ' aria-label="' + label + " cap money " + esc(who) + '">' + sign + "</button>";
        };
        return '<div class="fo-tb-moneyrow"><p class="fo-tb-moneyline"><b>' + esc(nm(f)) + " → " + esc(nm(to)) + ": " + k(cur * 1000) + '</b> <span class="fo-muted">up to ' + k(max * 1000) + "</span></p>" +
          '<div class="fo-tb-stepper">' + step(-1, "−", "Decrease", cur <= 0) +
          '<input type="number" min="0" max="' + max + '" step="1" inputmode="numeric" data-cap-from="' + f + '" data-cap-to="' + to + '" value="' + cur + '"' + (max === 0 ? " disabled" : "") + ' aria-label="Cap money ' + esc(who) + ", in thousands, 0 to " + max + '">' +
          step(1, "+", "Increase", cur >= max) + '<span class="fo-muted fo-tb-unit">$K</span></div>' +
          (max === 0 ? '<p class="fo-muted fo-tb-moneyhint">Send a player with a salary to make cap money available.</p>' : st.capNote[key] ? '<p class="fo-tb-moneyhint neg">Held to the most this team can include.</p>' : "") + "</div>";
      }).join("") + '<p class="fo-tb-space"><span class="fo-muted">Cap space (room under the cap), separate from cap money</span> <b>' + (space == null ? "—" : space < 0 ? "−" + dol(-space) : dol(space)) + "</b></p></div>";
    }
    function teamColumn(f, imp) {
      var sends = draft.items.filter(function (i) { return i.from === f; }), recv = draft.items.filter(function (i) { return i.to === f; });
      var t = info[f] || {};
      return '<section class="fo-tb-team" aria-label="' + esc(nm(f)) + '"><header><h3>' + esc(nm(f)) + (f === me ? ' <span class="fo-tf-tag ok">You</span>' : "") + '</h3>' + (t.abbrev ? '<span class="fo-muted">' + esc(t.abbrev) + "</span>" : "") + "</header>" +
        moneyBlock(f, imp) +
        '<h4>Sends</h4>' + listTable(sends.map(function (i) { return itemRow(i, true); }).join(""), "Nothing yet. Add players or picks below.", true) +
        '<h4>Receives</h4>' + listTable(recv.map(function (i) { return itemRow(i, false); }).join(""), "Nothing yet.", false) +
        rosterPicker(f) + "</section>";
    }
    // A small line of where the section's figures come from.
    function cardMeta(extra) { return '<p class="fo-tb-cardmeta">' + extra + "</p>"; }
    // One disclosure: a heading holding a real button (aria-expanded / aria-controls), a summary line that is always shown, and a panel
    // that is rendered only while open. Toggling changes st.disc and nothing else.
    function disc(n, title, summary, body) {
      var open = !!st.disc[n];
      return '<section class="fo-card fo-tb-stage fo-tb-disc' + (open ? " open" : "") + '" id="fo-tb-s' + n + '" aria-label="' + esc(title) + '">' +
        '<h2 class="fo-tb-dh"><button type="button" class="fo-tb-dbtn" data-disc="' + n + '" aria-expanded="' + open + '" aria-controls="fo-tb-p' + n + '">' +
        '<span class="fo-tb-dnum" aria-hidden="true">' + n + '</span><span class="fo-tb-dtext"><span class="fo-tb-dtitle">' + esc(title) + '</span><span class="fo-tb-dsum">' + esc(summary) + "</span></span>" +
        '<span class="fo-tb-chev" aria-hidden="true"></span></button></h2>' +
        '<div class="fo-tb-dpanel" id="fo-tb-p' + n + '"' + (open ? "" : " hidden") + ">" + (open ? body() : "") + "</div></section>";
    }
    var plural = function (n, w) { return n + " " + w + (n === 1 ? "" : "s"); };
    function moneyK() { return Object.keys(draft.capK).reduce(function (a, key) { return a + (draft.capK[key] || 0); }, 0); }
    function buildSummary() {
      if (!others().length) return "Choose a team to start";
      var pl = draft.items.filter(function (i) { return /^P_/.test(i.token); }).length, pk = draft.items.length - pl, parts = [plural(draft.teams.length, "team")];
      if (!draft.items.length) parts.push("nothing added yet");
      if (pl) parts.push(plural(pl, "player")); if (pk) parts.push(plural(pk, "pick"));
      if (moneyK()) parts.push("$" + moneyK() + "K cap money");
      return parts.join(" · ");
    }
    function capSummary(imp) {
      if (!draft.items.length || !others().length) return "Add players or picks to see the cap effect";
      if (!imp || !imp.cap) return "Salary cap data isn’t loaded yet";
      var over = draft.teams.filter(function (f) { return imp.cap[f] && imp.cap[f].r.overCap; }), lo = draft.teams.filter(function (f) { return imp.cap[f] && imp.cap[f].r.loadedOver; });
      var parts = [over.length ? "Over the cap: " + over.map(nm).join(", ") : "Cap OK"];
      if (lo.length) parts.push("Loaded-contract limit: " + lo.map(nm).join(", "));
      if (moneyK()) parts.push("$" + moneyK() + "K money");
      if (imp.loadedMoving) parts.push(plural(imp.loadedMoving, "loaded contract"));
      if (imp.ext && imp.ext.length) parts.push(plural(imp.ext.length, "proposed extension"));
      return parts.join(" · ");
    }
    function lineupSummary(imp) {
      if (!draft.items.length || !others().length) return "Add players to see the lineup change";
      var L = imp && imp.lineup;
      if (!L || L.state !== "ok") return (L && L.message) || "Lineup impact isn’t available yet.";
      return draft.teams.filter(function (f) { return L.teams[f]; }).map(function (f) { return sf1(L.teams[f].delta) + " pts/wk " + (f === me ? "for you" : "for " + nm(f)); }).join(" · ");
    }
    function proposalCard() {
      var imp = impactNow();
      var pick = '<div class="fo-tb-pickrow"><label>Trade with <select data-partner="0"><option value="">Choose a team</option>' +
        teams.filter(function (t) { return C.pad4(t.fid) !== me; }).map(function (t) { var f = C.pad4(t.fid); return '<option value="' + f + '"' + (others()[0] === f ? " selected" : "") + ">" + esc(t.name) + "</option>"; }).join("") + "</select></label>";
      if (others().length) pick += '<label>Third team (optional) <select data-partner="1"><option value="">None</option>' +
        teams.filter(function (t) { var f = C.pad4(t.fid); return f !== me && f !== others()[0]; }).map(function (t) { var f = C.pad4(t.fid); return '<option value="' + f + '"' + (others()[1] === f ? " selected" : "") + ">" + esc(t.name) + "</option>"; }).join("") + "</select></label>";
      pick += "</div>";
      return disc(1, "Build trade", buildSummary(), function () {
        return cardMeta(src("data", S.data || "Recorded rosters")) + pick +
          (others().length ? '<div class="fo-tb-teams fo-tb-n' + draft.teams.length + '">' + draft.teams.map(function (f) { return teamColumn(f, imp); }).join("") + "</div>" : '<p class="fo-ov-empty">Choose a team to start.</p>');
      });
    }

    function capSection(imp) {
      if (!imp || !imp.cap) return '<p class="fo-ov-empty">Salary cap data isn’t loaded yet.</p>';
      var cols = draft.teams, cell = function (fn) { return cols.map(function (f) { var c = imp.cap[f]; return c ? fn(c.r) : "<td>—</td>"; }).join(""); };
      var rows = [
        ["Cap allocation now", function (r) { return '<td class="num">' + k(r.before.alloc) + "</td>"; }],
        ["Salaries sent (cap hit)", function (r) { return '<td class="num">' + (r.sending ? "−" + k(r.sending) : "$0K") + "</td>"; }],
        ["Salaries received", function (r) { return '<td class="num">' + (r.receiving ? "+" + k(r.receiving) : "$0K") + "</td>"; }],
        ["Cap money (sent / received)", function (r) { return '<td class="num">' + (r.moneySent ? "+" + k(r.moneySent) : "$0K") + " / " + (r.moneyReceived ? "−" + k(r.moneyReceived) : "$0K") + "</td>"; }],
        ["Net cap impact", function (r) { return '<td class="num"><b>' + sk(r.net) + "</b></td>"; }],
        ["Cap allocation after", function (r) { return '<td class="num ' + (r.overCap ? "neg" : "") + '"><b>' + k(r.after.alloc) + "</b></td>"; }],
        ["Cap space now → after", function (r) { return '<td class="num ' + (r.overCap ? "neg" : "") + '">' + k(r.before.space) + " → " + (r.after.space < 0 ? "−" + k(-r.after.space) : k(r.after.space)) + "</td>"; }],
        ["Active roster now → after", function (r) { return '<td class="num ' + (r.activeOverMax ? "neg" : "") + '">' + r.before.active + " → " + r.after.active + (r.activeMax != null ? ' <span class="fo-muted">of ' + r.activeMax + "</span>" : "") + "</td>"; }],
        ["Loaded contracts now → after", function (r) { return '<td class="num ' + (r.loadedOver ? "neg" : "") + '">' + (r.before.loaded == null ? "—" : r.before.loaded) + " → " + (r.after.loaded == null ? "?" : r.after.loaded) + ' <span class="fo-muted">of ' + r.loadedMax + "</span></td>"; }]
      ];
      var flags = cols.map(function (f) {
        var c = imp.cap[f]; if (!c) return "";
        var out = [];
        if (c.r.overCap) out.push(nm(f) + " would be " + k(c.r.after.alloc - c.r.ceiling) + " over the cap: the owner must acknowledge the exact figure before it can be sent.");
        if (c.r.loadedOver) out.push(nm(f) + " would have " + c.r.after.loaded + " loaded contracts (the limit is " + c.r.loadedMax + "): blocked.");
        if (!c.r.loadedKnown) out.push("Loaded contracts for " + nm(f) + " can’t be counted from the data here; the server check decides.");
        if (c.r.activeOverMax) out.push(nm(f) + " would be over the active-roster maximum (advisory; MFL doesn’t stop a trade for it).");
        return out.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("");
      }).join("");
      return '<div class="fo-table-scroll"><table class="fo-table fo-tb-table fo-tb-cmp"><thead><tr><th></th>' + cols.map(function (f) { return '<th class="num">' + esc(nm(f)) + "</th>"; }).join("") + "</tr></thead><tbody>" +
        rows.map(function (r) { return '<tr><th scope="row">' + r[0] + "</th>" + cell(r[1]) + "</tr>"; }).join("") + "</tbody></table></div>" +
        (flags ? '<ul class="fo-tb-flags">' + flags + "</ul>" : "") + extTable(imp);
    }
    function extTable(imp) {
      var list = (imp && imp.ext) || []; if (!list.length) return "";
      return '<h4>Pre-trade extensions in this trade <span class="fo-muted">(proposed, not yet approved; nothing is saved)</span></h4><div class="fo-table-scroll"><table class="fo-table fo-tb-table"><thead><tr><th>Player</th><th>Current contract</th><th>Proposed contract</th><th class="num">Added future years</th></tr></thead><tbody>' +
        list.map(function (e) { return "<tr><td><b>" + esc(e.name) + '</b> <span class="fo-muted">' + esc(nm(e.from)) + " → " + esc(nm(e.to)) + "</span></td><td>" + esc(e.current) + "</td><td>" + esc(e.proposed) + '</td><td class="num">' + (e.added ? "+" + k(e.added) : "—") + "</td></tr>"; }).join("") +
        '</tbody></table></div>';
    }
    function lineupSection(imp) {
      var L = imp && imp.lineup;
      if (!L || L.state !== "ok") return '<p class="fo-ov-empty">' + esc((L && L.message) || "Lineup impact isn’t available yet.") + "</p>";
      var roleCell = function (x) { return x.role === "starter" ? '<span class="fo-tf-tag ok">Starter</span> ' + esc(x.slot) : x.role === "bench" ? '<span class="fo-tf-tag">Bench</span> ' + esc(x.depth) : x.role === "left" ? '<span class="fo-muted">Leaves this roster</span>' : '<span class="fo-tf-tag need">Out now</span> not counted'; };
      return '<p class="fo-tb-basis">' + esc(L.basis || "") + '</p><div class="fo-tb-lu">' + draft.teams.map(function (f) {
        var t = L.teams[f]; if (!t) return "";
        var rows = t.players.map(function (x) {
          return "<tr><td>" + (x.dir === "in" ? "<b>In</b> " : "<b>Out</b> ") + esc(x.name) + ' <span class="fo-muted">' + esc(x.pos) + '</span></td><td class="num">' + f1(x.ppg) + "</td><td>" + roleCell(x) + "</td><td>" + (x.displaces || x.note ? esc(x.displaces || x.note) : '<span class="fo-muted">—</span>') +
            '</td><td class="num">' + (x.dir === "in" && x.role !== "starter" ? '<span class="fo-muted">0.0 (bench)</span>' : sf1(x.lineupDelta)) + "</td></tr>";
        }).join("");
        var depth = t.depth.map(function (g) { return "<li><b>" + esc(g.g) + "</b> " + esc(g.before) + " <span aria-hidden=\"true\">→</span><span class=\"fo-sr\"> becomes </span> " + esc(g.after) + "</li>"; }).join("");
        var slots = t.slots.filter(function (s) { return s.before.key !== s.after.key; }).map(function (s) {
          return '<tr><th scope="row">' + esc(s.label) + "</th><td>" + esc(s.before.name) + ' <span class="fo-muted">' + f1(s.before.v) + "</span></td><td>" + esc(s.after.name) + ' <span class="fo-muted">' + f1(s.after.v) + "</span></td></tr>";
        }).join("");
        return '<div class="fo-tb-lu-team"><h4>' + esc(nm(f)) + "</h4>" +
          '<p class="fo-tb-big">Lineup ' + f1(t.before) + " → <b>" + f1(t.after) + '</b> <span class="fo-tf-tag ' + (t.delta > 0.05 ? "ok" : t.delta < -0.05 ? "need" : "") + '">' + sf1(t.delta) + " a week</span> <span class=\"fo-muted\">starters only</span></p>" +
          (rows ? '<div class="fo-table-scroll"><table class="fo-table fo-tb-table"><thead><tr><th>Player</th><th class="num">Pts/wk</th><th>On this team</th><th>Replaces or displaces</th><th class="num">Lineup effect</th></tr></thead><tbody>' + rows + "</tbody></table></div>" : '<p class="fo-muted">Add players or picks to see the change.</p>') +
          (depth ? '<h4>Roster depth by position <span class="fo-muted">(pts/wk, best first)</span></h4><ul class="fo-tb-depth">' + depth + "</ul>" : "") +
          (slots ? '<h4>Starting slots that change</h4><div class="fo-table-scroll"><table class="fo-table fo-tb-table"><thead><tr><th>Slot</th><th>Now</th><th>After</th></tr></thead><tbody>' + slots + "</tbody></table></div>" : "") +
          (t.repAfter > t.repBefore ? '<p class="fo-tb-line neg">Shortage: ' + (t.repAfter - t.repBefore) + " more lineup slot" + (t.repAfter - t.repBefore === 1 ? "" : "s") + " would be filled by a replacement-level free agent.</p>" : "") +
          "</div>";
      }).join("") + "</div>";
    }
    function validationSection(imp) {
      var gaps = gapsNow(), r = readiness(), calc = gaps.length ? { blocked: [], ack: [] } : calcFlags(imp);
      var head = '<div class="fo-tb-verdict fo-tb-' + r.state + '" aria-live="polite"><p class="fo-tb-pill">' + esc(r.label) + "</p>" +
"</div>";
      var block = function (title, tag, body) { return '<div class="fo-tb-vstep"><h4>' + esc(title) + (tag ? " " + tag : "") + "</h4>" + body + "</div>"; };
      var li = function (arr) { return arr.length ? "<ul>" + arr.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul>" : ""; };
      // 1 Structure
      var structure = gaps.length ? '<p class="fo-tb-state">' + (gaps[0].code === "no_assets" ? "No trade proposed" : "Incomplete") + "</p>" + li(gaps.map(function (g) { return g.message; })) : '<p class="fo-tb-state ok">Complete</p><p class="fo-muted">Every team takes part and the assets are readable.</p>';
      // 2 Financial compliance (calculated here)
      var fin;
      if (gaps.length) fin = '<p class="fo-muted">Not evaluated: the trade is not complete yet.</p>';
      else if (!imp || !imp.cap) fin = '<p class="fo-muted">Not evaluated: cap data is not loaded yet.</p>';
      else {
        var lines = draft.teams.map(function (f) { var c = imp.cap[f]; if (!c) return nm(f) + ": not calculated"; var q = c.r;
          return nm(f) + ": cap " + (q.overCap ? "OVER by " + k(q.after.alloc - q.ceiling) : "ok, " + k(q.after.space) + " space") + "; loaded contracts " + (q.after.loaded == null ? "can’t be counted here" : q.after.loaded + " of " + q.loadedMax + (q.loadedOver ? " (over)" : "")); });
        fin = '<p class="fo-tb-state ' + (calc.blocked.length ? "bad" : calc.ack.length ? "warn" : "ok") + '">' + (calc.blocked.length ? "A limit would be broken" : calc.ack.length ? "Needs an acknowledgment" : "No cap or loaded-contract problem found") + "</p>" + li(lines) + li(calc.blocked.concat(calc.ack));
      }
      // 3 Server validation
      var srv;
      if (gaps.length) srv = '<p class="fo-muted">Not run: a trade is only sent to the check once it is complete.</p>';
      else if (st.phase === "checking" || st.phase === "idle") srv = '<p class="fo-tb-state">Checking…</p>';
      else srv = '<p class="fo-tb-state ' + ({ provisional: "ok", needs_ack: "warn", blocked: "bad" }[r.state] || "warn") + '">' + esc(r.label) + "</p>" + li(r.reasons.filter(function (x) { return x.code !== "calculated_block" && x.code !== "calculated_ack"; }).map(function (x) { return x.text; })) +
        (r.lock ? '<p class="fo-tb-lock fo-tb-' + r.lock.tone + '">' + esc(r.lock.text) + "</p>" : "");
      return head + '<div class="fo-tb-vsteps">' +
        block("Structure", "", structure) + block("Financial compliance", src("calc", "Calculated here"), fin) +
        block("Server validation", gaps.length ? "" : src("verdict", S.verdict || "Server check"), srv) + "</div>";
    }
    function capCard() {
      var imp = impactNow();
      return disc(2, "Cap & contracts", capSummary(imp), function () { return cardMeta(src("calc", "Calculated from the rosters")) + capSection(imp); });
    }
    function lineupCard() {
      var imp = impactNow();
      return disc(3, "Lineup impact", lineupSummary(imp), function () { return cardMeta(src("calc", "Calculated from the rosters")) + lineupSection(imp); });
    }
    // The label of a draft loaded from another page (the Trade finder), and anything that could not be loaded.
    function draftBanner() {
      var ct = counterNow();
      if (ct) return '<div class="fo-banner info fo-tb-draftlabel fo-tb-counter" role="status"><b>Countering Trade ' + esc(ct.tradeId) + "</b> from " + esc(ct.from) +
        ". Change it as you like, then Send counter. Nothing is sent or declined until you do." +
        ' <button type="button" class="btn small secondary" data-go="cancel-counter"' + (st.sending ? " disabled" : "") + ">Cancel counter</button>" + droppedLine() + "</div>";
      if (!st.label) return "";
      return '<div class="fo-banner info fo-tb-draftlabel" role="status"><b>' + esc(st.label) + "</b>" +
        droppedLine() + "</div>";
    }
    function droppedLine() { return st.dropped.length ? ' <span class="fo-tb-dropped">Left out (not on the current rosters): ' + esc(st.dropped.map(function (x) { return x.token + " from " + nm(x.from); }).join(", ")) + ".</span>" : ""; }

    // ── Review ────────────────────────────────────────────────────────
    // Send offer is disabled for EVERY verdict (provisional, needs an acknowledgment, blocked, can't be checked, none): the Front
    // Office has no send connection. Its data-go attribute is inert (no click handler reads it); it stays so checks can find it.
    var SEND_OFF = "Sending from the Front Office is not available yet.";
    function reviewCard() {
      var gaps = gapsNow();
      var lines = C.summary(draft, nm).map(function (l) { return "<li>" + esc(l.text) + "</li>"; }).join("");
      return '<section class="fo-card fo-tb-stage fo-tb-review" id="fo-tb-review" aria-label="Review">' +
        '<div class="fo-tb-val"><h3>Validation</h3>' + validationSection(impactNow()) + "</div>" +
        (gaps.length ? '<p class="fo-ov-empty">' + (draft.items.length ? "Finish the trade above to review it." : "Build a trade above to review it.") + "</p>" : '<ul class="fo-tb-sum">' + lines + "</ul>") +
        '<label class="fo-tb-note">Note to the other owner' + (others().length > 1 ? "s" : "") + ' (optional' + (SENDER ? ", up to " + noteMax() + " characters" : "") + ')<textarea data-note maxlength="' + noteMax() + '"' + (gaps.length ? " disabled" : "") + ' placeholder="' + esc((opt.note && opt.note.placeholder) || "Say why this works for both teams") + '">' + esc(st.note) + "</textarea></label>" +
        (SENDER ? sendRow(gaps) :
        '<p class="fo-tb-actions"><button type="button" class="btn fo-tb-send" data-go="send" disabled aria-disabled="true" aria-describedby="fo-tb-send-off">Send offer</button> ' +
        '<span class="fo-tb-send-off" id="fo-tb-send-off">' + esc(SEND_OFF) + "</span></p>") +
        (opt.warRoomUrl ? '<p class="fo-basis"><a class="fo-go" href="' + esc(opt.warRoomUrl) + '">Trade War Room ↗</a> ' + (SENDER ? "stays available for every step." : "to send a trade.") + "</p>" : "") + "</section>";
    }
    // Ruling 6: 2,000 characters for a direct two-team offer, 500 for three-team (and for staged, which the server decides at send).
    // Behind the write flag only: the Offers view says whether this draft is a counter to one of its offers.
    function counterNow() { return SENDER && typeof SENDER.counter === "function" ? SENDER.counter() : null; }
    function noteMax() { return SENDER && typeof SENDER.noteLimit === "function" ? SENDER.noteLimit(draft.teams.length) : 500; }
    // Behind the write flag only: Send offer is enabled when the trade is complete and the server's check allows an attempt.
    function sendRow(gaps) {
      var loading = typeof SENDER.ready === "function" && !SENDER.ready();
      var r = readiness(), can = !loading && !gaps.length && r.canAttempt && !st.sending;
      var why = loading ? "Loading…" : st.sending ? "Sending…" : gaps.length ? "Finish the trade to send it." : !r.canAttempt ? "Send opens once the server's check allows it." : "";
      var label = typeof SENDER.label === "function" ? SENDER.label() : "Send offer";
      return '<p class="fo-tb-actions"><button type="button" class="btn fo-tb-send" data-go="send"' + (can ? "" : ' disabled aria-disabled="true"') + ' aria-describedby="fo-tb-send-off">' + esc(label) + "</button> " +
        (counterNow() ? '<button type="button" class="btn secondary" data-go="cancel-counter"' + (st.sending ? " disabled" : "") + ">Cancel counter</button> " : "") +
        '<span class="fo-tb-send-off" id="fo-tb-send-off">' + esc(why) + "</span></p>" +
        (st.outcome ? '<div class="fo-banner ' + (st.outcome.done ? "good" : "warn") + ' fo-tb-outcome" role="status" data-state="' + esc(st.outcome.state) + '">' + esc(st.outcome.message) + "</div>" : "");
    }
    function doSend() {
      if (!SENDER || st.sending || (typeof SENDER.ready === "function" && !SENDER.ready())) return;
      var noteEl = el.querySelector && el.querySelector("[data-note]"); if (noteEl) st.note = noteEl.value;
      st.sending = true; st.outcome = null; render();
      Promise.resolve(SENDER.send(draft, st.note)).then(function (r) { return r || { state: "refused", message: "Nothing was sent." }; }, function () { return { state: "unconfirmed", message: "The connection dropped before the server answered. Check your sent offers." }; })
        .then(function (r) {
          st.sending = false; st.outcome = { state: r.state, message: r.message, done: !!r.done };
          if (r.done) { draft = C.emptyDraft([me]); st.note = ""; st.label = ""; st.dropped = []; changed(); } else render();
        });
    }

    // Replacing the markup blurs a focused field, which can fire its `change` handler and call render() again mid-write.
    // A nested call is deferred to just after the current one, never run inside it.
    var rendering = false, again = false;
    function render() {
      if (rendering) { again = true; return; }
      rendering = true;
      try { paint(); } finally { rendering = false; }
      if (again) { again = false; Promise.resolve().then(render); }
    }
    function paint() {
      var keep = el.querySelector && el.querySelector("[data-note]"); if (keep) st.note = keep.value;
      // Read which roster lists are open from the page itself (a `toggle` event can arrive after a data refresh re-renders).
      Array.prototype.forEach.call(el.querySelectorAll("details[data-open]"), function (d) { st.open[d.getAttribute("data-open")] = d.open; });
      var focus = document.activeElement, fk = focusKey(focus), pos = focus && focus.selectionStart;
      el.innerHTML = '<div class="fo-tb">' + draftBanner() + proposalCard() + capCard() + lineupCard() + reviewCard() + "</div>";
      if (fk) {
        var n = el.querySelector(fk[0]);
        if (n && n.disabled && fk[1]) n = el.querySelector(fk[1]);     // a − / + that just hit its limit: keep focus on the amount box
        if (n) { n.focus(); if (/data-q/.test(fk[0])) { try { n.setSelectionRange(pos, pos); } catch (e) {} } }
      }
    }

    // Re-rendering replaces the markup, so the focused control is found again by what it is (keyboard users keep their place).
    function focusKey(n) {
      if (!n || !n.getAttribute || !(el.contains && el.contains(n))) return null;
      var a = function (x) { return n.getAttribute(x); };
      if (a("data-q")) return ['[data-q="' + a("data-q") + '"]'];
      if (a("data-disc")) return ['[data-disc="' + a("data-disc") + '"]'];
      if (a("data-cap-step")) return ['[data-cap-step="' + a("data-cap-step") + '"][data-step-from="' + a("data-step-from") + '"][data-step-to="' + a("data-step-to") + '"]', '[data-cap-from="' + a("data-step-from") + '"][data-cap-to="' + a("data-step-to") + '"]'];
      if (a("data-cap-from")) return ['[data-cap-from="' + a("data-cap-from") + '"][data-cap-to="' + a("data-cap-to") + '"]'];
      return null;
    }

    el.addEventListener("click", function (e) {
      var go = SENDER && e.target.closest && e.target.closest("[data-go]");
      if (go && go.getAttribute("data-go") === "send") { if (!go.disabled) doSend(); return; }
      if (go && go.getAttribute("data-go") === "cancel-counter") { if (!go.disabled && !st.sending && typeof SENDER.cancelCounter === "function") { st.outcome = null; SENDER.cancelCounter(); } return; }
      var dz = e.target.closest && e.target.closest("[data-disc]");
      if (dz) { var dn = dz.getAttribute("data-disc"); st.disc[dn] = !st.disc[dn]; render(); return; }   // the draft is untouched
      var sb = e.target.closest && e.target.closest("[data-cap-step]");
      if (sb) {
        if (sb.disabled) return;
        var sf = sb.getAttribute("data-step-from"), stt = sb.getAttribute("data-step-to"), mx = C.capMoneyMaxK(draft, sf, stt, basis), was = draft.capK[sf + ">" + stt] || 0;
        var nv = Math.min(mx, Math.max(0, was + Number(sb.getAttribute("data-cap-step"))));
        if (nv !== was) { delete st.capNote[sf + ">" + stt]; draft = C.setCapK(draft, sf, stt, nv); changed(); }
        return;
      }
      var xo = e.target.closest && e.target.closest("[data-tbx-open]");
      if (xo) { openExtDialog(xo.getAttribute("data-from"), xo.getAttribute("data-tbx-open")); return; }
      var b = e.target.closest && e.target.closest("[data-tok]"); if (!b) return;
      var tok = b.getAttribute("data-tok"), from = b.getAttribute("data-from");
      var adding = !C.hasItem(draft, tok, from);
      if (!adding) { draft = C.removeItem(draft, tok, from); delete st.prompted[from + "|" + tok]; }
      else {
        var a = opt.assets(from) || { players: [], picks: [] }, p = a.players.filter(function (x) { return "P_" + x.id === tok; })[0], kk = a.picks.filter(function (x) { return x.token === tok; })[0];
        var el = (p || kk || {}).elig;
        if (b.disabled || (el && !el.tradeable)) return;          // the shared rule refuses it: never added
        draft = C.addItem(draft, { from: from, to: dest(from), token: tok, label: p ? p.name : kk ? kk.label : tok, salary: p ? p.salary : 0, taxi: p ? p.taxi : false });
      }
      changed();
      // An extension-eligible player has just been ADDED: open the choice popup (not on every click of his row, nor from his player panel).
      if (adding) promptExtensions();
    });
    el.addEventListener("toggle", function (e) { var d = e.target; if (d && d.getAttribute && d.getAttribute("data-open")) st.open[d.getAttribute("data-open")] = d.open; }, true);
    el.addEventListener("input", function (e) {
      var t = e.target; if (t.hasAttribute && t.hasAttribute("data-q")) { st.q[t.getAttribute("data-q")] = t.value; st.open[t.getAttribute("data-q")] = true; render(); }
    });
    el.addEventListener("change", function (e) {
      var t = e.target;
      if (t.hasAttribute("data-partner")) {
        var cur = others(), idx = Number(t.getAttribute("data-partner"));
        cur[idx] = t.value; if (idx === 0 && !t.value) cur = [];
        draft = C.withTeams(draft, [me].concat(cur.filter(Boolean).filter(function (v, i, a) { return a.indexOf(v) === i; }))); changed();
      } else if (t.hasAttribute("data-dest")) {
        var tok = t.getAttribute("data-dest"), from = t.getAttribute("data-from"), old = draft.items.filter(function (i) { return i.token === tok && i.from === from; })[0];
        draft = C.removeItem(draft, tok, from); draft = C.addItem(draft, { from: from, to: t.value, token: tok, label: old.label, salary: old.salary, taxi: old.taxi }); changed();
      } else if (t.hasAttribute("data-cap-from")) {
        delete st.capNote[t.getAttribute("data-cap-from") + ">" + t.getAttribute("data-cap-to")];
        draft = C.setCapK(draft, t.getAttribute("data-cap-from"), t.getAttribute("data-cap-to"), t.value); changed();
      }
    });
    if (adopt(opt.initial) && draft.items.length) changed(); else render();
    function dialogAction(target) {
      var b = target && target.closest ? target.closest("[data-tbx-pick]") : null;
      if (!b || !st.dlg) return false;
      draft = C.setExt(draft, st.dlg.from, st.dlg.token, b.getAttribute("data-tbx-pick")); st.dlg = null;
      if (opt.closeDialog) opt.closeDialog();
      changed(); return true;
    }
    return { factsChanged: function () { st.memo = { sig: "", imp: null }; render(); promptExtensions(); }, dialogAction: dialogAction, refresh: function () { st.memo = { sig: "", imp: null }; render(); },
      draft: function () { return draft; }, isEmpty: isEmpty, state: function () { return { phase: st.phase, resp: st.resp, label: st.label, dropped: st.dropped.slice(), disc: Object.assign({}, st.disc) }; },
      // Replace the draft with one built elsewhere (the adapter's openDraft has already validated it and asked the owner). Sections stay as they are.
      loadDraft: function (init) { if (!adopt(init)) return false; st.capNote = {}; changed(); return true; } };
  }

  var api = { mount: mount };
  root.UPS_TRADE_BUILDER_VIEW = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : this);
