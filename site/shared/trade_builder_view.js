/* Trade Builder view (Front Office → Trades → Trade builder; plan #1385). One page, three cards (no numbered step headings;
   each card is a region with an accessible name), in the Front Office's own look (fo-card / fo-table / btn / fo-subview-chip;
   the layout rules are .fo-tb-* in front_office.css):
     Trade proposal   each team side by side: what it sends, what it receives, cap money, and its roster to add from
     Trade impact     cap and contract table · lineup impact · validation (calculated vs the server's check)
     Review           summary, note, and a Send offer button that is ALWAYS disabled
   The server's verdict (POST /api/trades/compliance-preview) is the only authority on whether a trade is allowed.
   SEND IS NOT AVAILABLE FROM THE FRONT OFFICE. Whatever the verdict, Send offer renders disabled with a plain reason, and
   no click opens a confirmation or sends anything: there is no send handler, no confirmation markup and no option or flag
   that turns one on. A live Send is a separate, separately approved change. No write route is named or called from this file.
     mount(el, { teams:[{fid,name,abbrev?}], ctx:{leagueId,season,viewerFid},
                 assets(fid) -> {players:[{id,name,pos,salary,years,type,taxi,ir}], picks:[{token,label}]},
                 impact(draft) -> { cap:{fid:{r}}|null, lineup:{state,message,teams:{fid:{...}}} },
                 extensionOptions(item) -> [option] (the shared pre-trade extension rule; [] = not eligible),
                 playerLink(pid, fid, label) -> html (opens the Front Office player panel),
                 openDialog(title, html) / closeDialog() (the Front Office dialog; the choice popup for an eligible player),
                 preview(body) -> Promise<json>, sources:{data,verdict}, warRoomUrl?, debounceMs }) */
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
    var st = { phase: "idle", resp: null, seq: 0, timer: null, note: "", open: {}, q: {}, memo: { sig: "", imp: null }, capNote: {}, dlg: null, prompted: {} };
    var info = {}; teams.forEach(function (t) { info[C.pad4(t.fid)] = t; });
    function nm(f) { return (info[f] && info[f].name) || "Team " + f; }
    function others() { return draft.teams.filter(function (f) { return f !== me; }); }
    function gapsNow() { return C.gaps(draft, nm); }
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
      var held = C.clampCap(draft); if (held.clamped.length) { draft = held.draft; held.clamped.forEach(function (key) { st.capNote[key] = true; }); }
      var gaps = C.gaps(draft), sig = gaps.length ? "" : C.signature(draft, ctx);
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
    function itemRow(i, withControls) {
      var p = /^P_/.test(i.token) ? playerOf(i.from, i.token) : null;
      var cells = p ? '<td>' + pname(p, i.from) + ' <span class="fo-muted">' + esc(p.pos) + '</span><div class="fo-tb-sub">' + esc(contractLine(p)) + '</div></td><td class="num">' + k(p.salary) + "</td>"
        : '<td><b>' + esc(i.label) + '</b> <span class="fo-muted">draft pick</span></td><td class="num">—</td>';
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
    function addBtn(on, tok, f, label) {
      return '<button type="button" class="btn small" aria-pressed="' + on + '" data-tok="' + esc(tok) + '" data-from="' + f + '" aria-label="' + (on ? "Remove " : "Add ") + esc(label) + '">' + (on ? "Added" : "Add") + "</button>";
    }
    function rosterPicker(f) {
      var a = opt.assets(f) || { players: [], picks: [] };
      var q = (st.q[f] || "").toLowerCase();
      var rows = a.players.filter(function (p) { return !q || (p.name + " " + p.pos).toLowerCase().indexOf(q) !== -1; }).map(function (p) {
        var eligible = extOpts({ from: f, token: "P_" + p.id, label: p.name }).length > 0;
        return '<tr><td>' + pname(p, f) + ' <span class="fo-muted">' + esc(p.pos) + '</span><div class="fo-tb-sub">' + esc(contractLine(p)) + (eligible ? ' <span class="fo-tf-tag ok" title="Eligible for a pre-trade extension under the league rule">Extension eligible</span>' : "") + '</div></td><td class="num">' + k(p.salary) + '</td><td class="fo-tb-ctl">' + addBtn(C.hasItem(draft, "P_" + p.id, f), "P_" + p.id, f, p.name) + "</td></tr>";
      }).concat(a.picks.filter(function (p) { return !q || p.label.toLowerCase().indexOf(q) !== -1; }).map(function (p) {
        return '<tr><td><b>' + esc(p.label) + '</b> <span class="fo-muted">draft pick</span></td><td class="num">—</td><td class="fo-tb-ctl">' + addBtn(C.hasItem(draft, p.token, f), p.token, f, p.label) + "</td></tr>";
      })).join("");
      return '<details class="fo-tb-roster"' + (st.open[f] ? " open" : "") + ' data-open="' + f + '"><summary>Add from ' + esc(nm(f)) + '’s roster</summary>' +
        '<input type="search" class="fo-tb-q" data-q="' + f + '" placeholder="Find a player or pick" value="' + esc(st.q[f] || "") + '" aria-label="Find in ' + esc(nm(f)) + ' roster">' +
        '<div class="fo-table-scroll fo-tb-scroll fo-tb-pick"><table class="fo-table fo-tb-table"><tbody>' + (rows || '<tr><td class="fo-muted">Nothing matches.</td></tr>') + "</tbody></table></div></details>";
    }
    function moneyBlock(f, imp) {
      var tos = draft.teams.filter(function (x) { return x !== f; });
      var space = imp && imp.cap && imp.cap[f] ? imp.cap[f].r.before.space : null;
      return '<div class="fo-tb-money"><h4>Cap money</h4>' + tos.map(function (to) {
        var key = f + ">" + to, max = C.capMoneyMaxK(draft, f, to), cur = draft.capK[key] || 0;
        return '<div class="fo-tb-moneyrow"><div class="fo-tb-moneyfig"><span class="fo-muted">Cap money available' + (tos.length > 1 ? " to " + esc(nm(to)) : "") + '</span><b class="fo-tb-figure">' + dol(max * 1000) + "</b></div>" +
          '<label class="fo-tb-moneyin">Amount to include ($K)<input type="number" min="0" max="' + max + '" step="1" inputmode="numeric" data-cap-from="' + f + '" data-cap-to="' + to + '" value="' + (cur || "") + '"' + (max === 0 ? " disabled" : "") + ' aria-label="Cap money from ' + esc(nm(f)) + ' to ' + esc(nm(to)) + ' in thousands, at most ' + max + '"></label>' +
          '<div class="fo-tb-moneynow">Included now <b>' + dol(cur * 1000) + "</b></div></div>" +
          (max === 0 ? '<p class="fo-muted fo-tb-moneyhint">Send a player with a salary to make cap money available.</p>' : st.capNote[key] ? '<p class="fo-tb-moneyhint neg">Held to the most this team can include.</p>' : "");
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
    // A small line of where the card's figures come from (no heading: the card is named by its aria-label).
    function cardMeta(extra) { return '<p class="fo-tb-cardmeta">' + extra + "</p>"; }
    function proposalCard() {
      var imp = impactNow();
      var pick = '<div class="fo-tb-pickrow"><label>Trade with <select data-partner="0"><option value="">Choose a team</option>' +
        teams.filter(function (t) { return C.pad4(t.fid) !== me; }).map(function (t) { var f = C.pad4(t.fid); return '<option value="' + f + '"' + (others()[0] === f ? " selected" : "") + ">" + esc(t.name) + "</option>"; }).join("") + "</select></label>";
      if (others().length) pick += '<label>Third team (optional) <select data-partner="1"><option value="">None</option>' +
        teams.filter(function (t) { var f = C.pad4(t.fid); return f !== me && f !== others()[0]; }).map(function (t) { var f = C.pad4(t.fid); return '<option value="' + f + '"' + (others()[1] === f ? " selected" : "") + ">" + esc(t.name) + "</option>"; }).join("") + "</select></label>";
      pick += "</div>";
      return '<section class="fo-card fo-tb-stage" id="fo-tb-s1" aria-label="Trade proposal">' + cardMeta(src("data", S.data || "Recorded rosters")) + pick +
        (others().length ? '<div class="fo-tb-teams fo-tb-n' + draft.teams.length + '">' + draft.teams.map(function (f) { return teamColumn(f, imp); }).join("") + "</div>" : '<p class="fo-ov-empty">Choose a team to start.</p>') + "</section>";
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
        block("1 Structure", "", structure) + block("2 Financial compliance", src("calc", "Calculated here"), fin) +
        block("3 Server validation", gaps.length ? "" : src("verdict", S.verdict || "Server check"), srv) + "</div>";
    }
    function impactCard() {
      var imp = impactNow();
      return '<section class="fo-card fo-tb-stage" id="fo-tb-s2" aria-label="Trade impact">' + cardMeta(src("calc", "Calculated from the rosters above")) +
        '<div class="fo-tb-impact"><section class="fo-tb-im-cap"><h3>Salary cap and contracts</h3>' + capSection(imp) + "</section>" +
        '<section class="fo-tb-im-val"><h3>Validation</h3>' + validationSection(imp) + "</section>" +
        '<section class="fo-tb-im-lu"><h3>Lineup impact</h3>' + lineupSection(imp) + "</section></div></section>";
    }

    // ── Review ────────────────────────────────────────────────────────
    // Send offer is disabled for EVERY verdict (provisional, needs an acknowledgment, blocked, can't be checked, none): the Front
    // Office has no send connection. Its data-go attribute is inert (no click handler reads it); it stays so checks can find it.
    var SEND_OFF = "Sending from the Front Office is not available yet.";
    function reviewCard() {
      var gaps = gapsNow();
      var lines = C.summary(draft, nm).map(function (l) { return "<li>" + esc(l.text) + "</li>"; }).join("");
      return '<section class="fo-card fo-tb-stage" id="fo-tb-s3" aria-label="Review">' +
        (gaps.length ? '<p class="fo-ov-empty">' + (draft.items.length ? "Finish the trade above to review it." : "Build a trade above to review it.") + "</p>" : '<ul class="fo-tb-sum">' + lines + "</ul>") +
        '<label class="fo-tb-note">Note to the other owner' + (others().length > 1 ? "s" : "") + ' (optional)<textarea data-note maxlength="500"' + (gaps.length ? " disabled" : "") + ' placeholder="' + esc((opt.note && opt.note.placeholder) || "Say why this works for both teams") + '">' + esc(st.note) + "</textarea></label>" +
        '<p class="fo-tb-actions"><button type="button" class="btn fo-tb-send" data-go="send" disabled aria-disabled="true" aria-describedby="fo-tb-send-off">Send offer</button> ' +
        '<span class="fo-tb-send-off" id="fo-tb-send-off">' + esc(SEND_OFF) + "</span></p>" +
        (opt.warRoomUrl ? '<p class="fo-basis"><a class="fo-go" href="' + esc(opt.warRoomUrl) + '">Trade War Room ↗</a> to send a trade.</p>' : "") + "</section>";
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
      var focus = document.activeElement, fq = focus && focus.getAttribute && focus.getAttribute("data-q"), pos = focus && focus.selectionStart;
      el.innerHTML = '<div class="fo-tb">' + proposalCard() + impactCard() + reviewCard() + "</div>";
      if (fq) { var n = el.querySelector('[data-q="' + fq + '"]'); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) {} } }
    }

    el.addEventListener("click", function (e) {
      var xo = e.target.closest && e.target.closest("[data-tbx-open]");
      if (xo) { openExtDialog(xo.getAttribute("data-from"), xo.getAttribute("data-tbx-open")); return; }
      var b = e.target.closest && e.target.closest("[data-tok]"); if (!b) return;
      var tok = b.getAttribute("data-tok"), from = b.getAttribute("data-from");
      var adding = !C.hasItem(draft, tok, from);
      if (!adding) { draft = C.removeItem(draft, tok, from); delete st.prompted[from + "|" + tok]; }
      else {
        var a = opt.assets(from) || { players: [], picks: [] }, p = a.players.filter(function (x) { return "P_" + x.id === tok; })[0], kk = a.picks.filter(function (x) { return x.token === tok; })[0];
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
    render();
    function dialogAction(target) {
      var b = target && target.closest ? target.closest("[data-tbx-pick]") : null;
      if (!b || !st.dlg) return false;
      draft = C.setExt(draft, st.dlg.from, st.dlg.token, b.getAttribute("data-tbx-pick")); st.dlg = null;
      if (opt.closeDialog) opt.closeDialog();
      changed(); return true;
    }
    return { factsChanged: function () { st.memo = { sig: "", imp: null }; render(); promptExtensions(); }, dialogAction: dialogAction, refresh: function () { st.memo = { sig: "", imp: null }; render(); }, draft: function () { return draft; }, state: function () { return { phase: st.phase, resp: st.resp }; } };
  }

  var api = { mount: mount };
  root.UPS_TRADE_BUILDER_VIEW = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : this);
