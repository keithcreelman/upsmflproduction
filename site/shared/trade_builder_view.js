/* Trade Builder view (Front Office → Trades → Trade builder; plan #1385). One page, three cards, in the Front Office's own
   look (fo-card / fo-table / btn / fo-subview-chip; the layout rules are .fo-tb-* in front_office.css):
     Trade proposal   each team side by side: what it sends, what it receives, cap money, and its roster to add from
     Trade impact     cap and contract table · lineup impact · validation (calculated vs the server's check)
     Review and send  summary, note, Send (a confirmation step)
   The server's verdict (POST /api/trades/compliance-preview) is the only authority on whether a trade is allowed. The Send
   step is WIRED but takes an injected `send(plan)`; with none (every build today) a confirmed send says plainly that nothing
   was sent. No write route is named or called from this file.
     mount(el, { teams:[{fid,name,abbrev?}], ctx:{leagueId,season,viewerFid},
                 assets(fid) -> {players:[{id,name,pos,salary,years,type,taxi,ir}], picks:[{token,label}]},
                 impact(draft) -> { cap:{fid:{r}}|null, lineup:{state,message,teams:{fid:{...}}} },
                 preview(body) -> Promise<json>, send(plan)? , sendNotice, sources:{data,verdict}, warRoomUrl?, debounceMs }) */
(function (root) {
  "use strict";
  var C = root.UPS_TRADE_BUILDER_CORE || (typeof require === "function" ? require("./trade_builder_core.js") : null);

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function k(d) { var v = Math.round((Number(d) || 0) / 100) / 10; return "$" + (v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)) + "K"; }
  function sk(d) { var v = Math.round(Number(d) || 0); return v === 0 ? "$0K" : (v > 0 ? "+" : "−") + k(Math.abs(v)); }
  function f1(x) { return (Math.round((Number(x) || 0) * 10) / 10).toFixed(1); }
  function sf1(x) { var v = Math.round((Number(x) || 0) * 10) / 10; return v === 0 ? "0.0" : (v > 0 ? "+" : "−") + Math.abs(v).toFixed(1); }
  function src(kind, text) { return '<span class="fo-tb-src fo-tb-src-' + kind + '">' + esc(text) + "</span>"; }

  function mount(el, opt) {
    var teams = opt.teams, ctx = opt.ctx, me = C.pad4(ctx.viewerFid);
    var delay = opt.debounceMs == null ? 600 : opt.debounceMs;
    var S = opt.sources || {};
    var draft = C.emptyDraft([me]);
    var st = { phase: "idle", resp: null, seq: 0, timer: null, note: "", confirm: false, sent: null, open: {}, q: {} };
    var info = {}; teams.forEach(function (t) { info[C.pad4(t.fid)] = t; });
    function nm(f) { return (info[f] && info[f].name) || "Team " + f; }
    function others() { return draft.teams.filter(function (f) { return f !== me; }); }
    function readiness() { return C.readiness(C.gaps(draft), st.phase, st.resp); }

    function changed() {
      var gaps = C.gaps(draft), sig = gaps.length ? "" : C.signature(draft, ctx);
      clearTimeout(st.timer);
      st.seq++;                          // any answer still in flight is now stale
      st.confirm = false; st.sent = null;
      if (!sig) { st.phase = "idle"; st.resp = null; render(); return; }
      st.phase = "checking"; st.resp = null; render();
      var mine = st.seq;
      st.timer = setTimeout(function () {
        Promise.resolve().then(function () { return opt.preview(C.request(draft, ctx)); }).then(function (j) { return j; }, function () { return null; })
          .then(function (j) { if (mine !== st.seq) return; st.phase = "done"; st.resp = j; render(); });
      }, delay);
    }
    function dest(from) { var t = draft.teams, i = t.indexOf(from); return t.length === 2 ? t[1 - i] : t[(i + 1) % t.length]; }
    function playerOf(fid, tok) { var a = opt.assets(fid) || { players: [] }; return a.players.filter(function (x) { return "P_" + x.id === tok; })[0]; }

    // ── Trade proposal ────────────────────────────────────────────────
    function contractLine(p) { return [p.years != null ? p.years + " yr" : "", p.type || "", p.taxi ? "taxi" : "", p.ir ? "IR" : ""].filter(Boolean).join(" · "); }
    function itemRow(i, withControls) {
      var p = /^P_/.test(i.token) ? playerOf(i.from, i.token) : null;
      var cells = p ? '<td><b>' + esc(p.name) + '</b> <span class="fo-muted">' + esc(p.pos) + '</span></td><td class="num">' + k(p.salary) + '</td><td>' + esc(contractLine(p)) + "</td>"
        : '<td><b>' + esc(i.label) + '</b> <span class="fo-muted">draft pick</span></td><td class="num">—</td><td class="fo-muted">no salary</td>';
      var ctl = "";
      if (withControls) {
        ctl = '<td class="fo-tb-ctl">' + (draft.teams.length === 3 ? '<select aria-label="Send ' + esc(i.label) + ' to" data-dest="' + esc(i.token) + '" data-from="' + i.from + '">' + draft.teams.filter(function (f) { return f !== i.from; }).map(function (f) {
          return '<option value="' + f + '"' + (i.to === f ? " selected" : "") + ">to " + esc(nm(f)) + "</option>"; }).join("") + "</select> " : "") +
          '<button type="button" class="btn secondary small" data-tok="' + esc(i.token) + '" data-from="' + i.from + '" aria-label="Remove ' + esc(i.label) + '">Remove</button></td>';
      }
      return "<tr>" + cells + ctl + "</tr>";
    }
    function listTable(rows, empty, cols) {
      return rows ? '<div class="fo-table-scroll fo-tb-scroll"><table class="fo-table fo-tb-table"><thead><tr><th>Asset</th><th class="num">Salary</th><th>Contract</th>' + (cols ? "<th></th>" : "") + "</tr></thead><tbody>" + rows + "</tbody></table></div>" : '<p class="fo-ov-empty">' + empty + "</p>";
    }
    function addBtn(on, tok, f, label) {
      return '<button type="button" class="btn small' + (on ? " secondary" : "") + '" aria-pressed="' + on + '" data-tok="' + esc(tok) + '" data-from="' + f + '" aria-label="' + (on ? "Remove " : "Add ") + esc(label) + '">' + (on ? "Added" : "Add") + "</button>";
    }
    function rosterPicker(f) {
      var a = opt.assets(f) || { players: [], picks: [] };
      var q = (st.q[f] || "").toLowerCase();
      var rows = a.players.filter(function (p) { return !q || (p.name + " " + p.pos).toLowerCase().indexOf(q) !== -1; }).map(function (p) {
        return '<tr><td><b>' + esc(p.name) + '</b> <span class="fo-muted">' + esc(p.pos) + '</span></td><td class="num">' + k(p.salary) + "</td><td>" + esc(contractLine(p)) + '</td><td class="fo-tb-ctl">' + addBtn(C.hasItem(draft, "P_" + p.id, f), "P_" + p.id, f, p.name) + "</td></tr>";
      }).concat(a.picks.filter(function (p) { return !q || p.label.toLowerCase().indexOf(q) !== -1; }).map(function (p) {
        return '<tr><td><b>' + esc(p.label) + '</b> <span class="fo-muted">draft pick</span></td><td class="num">—</td><td class="fo-muted">no salary</td><td class="fo-tb-ctl">' + addBtn(C.hasItem(draft, p.token, f), p.token, f, p.label) + "</td></tr>";
      })).join("");
      return '<details class="fo-tb-roster"' + (st.open[f] ? " open" : "") + ' data-open="' + f + '"><summary>Add from ' + esc(nm(f)) + '’s roster</summary>' +
        '<input type="search" class="fo-tb-q" data-q="' + f + '" placeholder="Find a player or pick" value="' + esc(st.q[f] || "") + '" aria-label="Find in ' + esc(nm(f)) + ' roster">' +
        '<div class="fo-table-scroll fo-tb-scroll fo-tb-pick"><table class="fo-table fo-tb-table"><tbody>' + (rows || '<tr><td class="fo-muted">Nothing matches.</td></tr>') + "</tbody></table></div></details>";
    }
    function teamColumn(f) {
      var sends = draft.items.filter(function (i) { return i.from === f; }), recv = draft.items.filter(function (i) { return i.to === f; });
      var cap = draft.teams.filter(function (x) { return x !== f; }).map(function (to) {
        return '<label class="fo-tb-cap">Cap money to ' + esc(nm(to)) + ' <span class="fo-muted">($K, up to about ' + C.capMoneyHintK(draft, f) + 'K; the server checks the limit)</span><input type="number" min="0" step="1" inputmode="numeric" data-cap-from="' + f + '" data-cap-to="' + to + '" value="' + (draft.capK[f + ">" + to] || "") + '" aria-label="Cap money from ' + esc(nm(f)) + ' to ' + esc(nm(to)) + ' in thousands"></label>';
      }).join("");
      var t = info[f] || {};
      return '<section class="fo-tb-team" aria-label="' + esc(nm(f)) + '"><header><h3>' + esc(nm(f)) + (f === me ? ' <span class="fo-tf-tag ok">You</span>' : "") + '</h3>' + (t.abbrev ? '<span class="fo-muted">' + esc(t.abbrev) + "</span>" : "") + "</header>" +
        '<h4>Sends</h4>' + listTable(sends.map(function (i) { return itemRow(i, true); }).join(""), "Nothing yet. Add players or picks below.", true) + cap +
        '<h4>Receives</h4>' + listTable(recv.map(function (i) { return itemRow(i, false); }).join(""), "Nothing yet.", false) +
        rosterPicker(f) + "</section>";
    }
    function proposalCard() {
      var pick = '<div class="fo-tb-pickrow"><label>Trade with <select data-partner="0"><option value="">Choose a team</option>' +
        teams.filter(function (t) { return C.pad4(t.fid) !== me; }).map(function (t) { var f = C.pad4(t.fid); return '<option value="' + f + '"' + (others()[0] === f ? " selected" : "") + ">" + esc(t.name) + "</option>"; }).join("") + "</select></label>";
      if (others().length) pick += '<label>Third team (optional) <select data-partner="1"><option value="">None</option>' +
        teams.filter(function (t) { var f = C.pad4(t.fid); return f !== me && f !== others()[0]; }).map(function (t) { var f = C.pad4(t.fid); return '<option value="' + f + '"' + (others()[1] === f ? " selected" : "") + ">" + esc(t.name) + "</option>"; }).join("") + "</select></label>";
      pick += "</div>";
      return '<div class="fo-card"><div class="fo-card-head"><h2>Trade proposal</h2><span class="small">' + src("data", S.data || "Recorded rosters") + "</span></div>" + pick +
        (others().length ? '<div class="fo-tb-teams fo-tb-n' + draft.teams.length + '">' + draft.teams.map(teamColumn).join("") + "</div>" : '<p class="fo-ov-empty">Choose a team to start.</p>') + "</div>";
    }

    // ── Trade impact ──────────────────────────────────────────────────
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
        (flags ? '<ul class="fo-tb-flags">' + flags + "</ul>" : "") +
        '<p class="fo-basis">Same cap engine as the Overview: taxi $0, IR 50% on the sending side; a traded player arrives active at his full salary; cap money is charged to the sender and credited to the receiver this season only. The server check is the authority.</p>';
    }
    function lineupSection(imp) {
      var L = imp && imp.lineup;
      if (!L || L.state !== "ok") return '<p class="fo-ov-empty">' + esc((L && L.message) || "Lineup impact isn’t available yet.") + "</p>";
      var any = draft.items.length > 0;
      return '<div class="fo-tb-lu">' + draft.teams.map(function (f) {
        var t = L.teams[f]; if (!t) return "";
        var changes = t.byPos.filter(function (g) { return Math.abs(g.delta) >= 0.05; }).map(function (g) { return '<li><span class="fo-tf-tag ' + (g.delta > 0 ? "ok" : "need") + '">' + esc(g.g) + " " + sf1(g.delta) + "</span> " + f1(g.before) + " → " + f1(g.after) + "</li>"; }).join("");
        var slots = t.slots.filter(function (s) { return s.before.key !== s.after.key; }).map(function (s) {
          return '<tr><th scope="row">' + esc(s.label) + "</th><td>" + esc(s.before.name) + ' <span class="fo-muted">' + f1(s.before.v) + "</span></td><td>" + esc(s.after.name) + ' <span class="fo-muted">' + f1(s.after.v) + "</span></td></tr>";
        }).join("");
        return '<div class="fo-tb-lu-team"><h4>' + esc(nm(f)) + "</h4>" +
          '<p class="fo-tb-big">' + f1(t.before) + " → <b>" + f1(t.after) + '</b> <span class="fo-tf-tag ' + (t.delta > 0.05 ? "ok" : t.delta < -0.05 ? "need" : "") + '">' + sf1(t.delta) + " pts a week</span></p>" +
          (any ? "" : '<p class="fo-muted">Add players or picks to see the change.</p>') +
          (t.leaving.length ? '<p class="fo-tb-line"><b>Leaving the roster:</b> ' + esc(t.leaving.join(", ")) + "</p>" : "") +
          (t.entering.length ? '<p class="fo-tb-line"><b>Entering:</b> ' + esc(t.entering.join(", ")) + "</p>" : "") +
          (t.notCounted.length ? '<p class="fo-tb-line fo-muted">Not counted in the lineup (unavailable now): ' + esc(t.notCounted.join(", ")) + "</p>" : "") +
          (changes ? '<ul class="fo-tb-chg">' + changes + "</ul>" : "") +
          (slots ? '<div class="fo-table-scroll"><table class="fo-table fo-tb-table"><thead><tr><th>Slot</th><th>Now</th><th>After</th></tr></thead><tbody>' + slots + "</tbody></table></div>" : "") +
          (t.repAfter > t.repBefore ? '<p class="fo-tb-line neg">Shortage: ' + (t.repAfter - t.repBefore) + " more lineup slot" + (t.repAfter - t.repBefore === 1 ? "" : "s") + " would be filled by a replacement-level free agent.</p>" : "") +
          "</div>";
      }).join("") + '</div><p class="fo-basis">Modeled lineup from the Trade finder: each team’s best legal lineup by season points a week (MFL’s scores), same slots and replacement level. It is not a projection and is not MFL’s submitted lineup.</p>';
    }
    function validationSection(imp) {
      var r = readiness(), calc = [];
      if (imp && imp.cap) draft.teams.forEach(function (f) { var c = imp.cap[f]; if (c && c.r.overCap) calc.push(nm(f) + ": over the cap, needs an acknowledgment"); if (c && c.r.loadedOver) calc.push(nm(f) + ": over five loaded contracts"); });
      var rs = r.reasons.map(function (x) { return "<li>" + esc(x.text) + "</li>"; }).join("");
      var gaps = C.gaps(draft);
      var stages = [
        ["Structure", gaps.length ? "Not finished: " + gaps[0].message : "Complete: at least one asset, two or three teams"],
        ["Calculated here", calc.length ? calc.join("; ") : (imp && imp.cap ? "No cap or loaded-contract problem found" : "Waiting for cap data")],
        ["Server check", r.state === "draft" ? "Not run yet" : r.state === "checking" ? "Checking with MFL…" : r.label],
        ["Still required", "The other owner’s acceptance, then MFL’s own confirmation"]
      ];
      return '<div class="fo-tb-verdict fo-tb-' + r.state + '" aria-live="polite"><p class="fo-tb-pill">' + esc(r.label) + "</p>" + (rs ? "<ul>" + rs + "</ul>" : "") +
        (r.lock ? '<p class="fo-tb-lock fo-tb-' + r.lock.tone + '">' + esc(r.lock.text) + "</p>" : "") + "</div>" +
        '<dl class="fo-tb-stages">' + stages.map(function (s) { return "<dt>" + esc(s[0]) + "</dt><dd>" + esc(s[1]) + "</dd>"; }).join("") + "</dl>" +
        '<p class="fo-basis">' + src("verdict", S.verdict || "Server check") + ' “Looks fine so far” means the trade passes the checks run before sending. It is not an acceptance: sending runs more checks, the other owner must accept, and MFL decides.</p>';
    }
    function impactCard() {
      var imp = others().length ? opt.impact(draft) : null;
      return '<div class="fo-card"><div class="fo-card-head"><h2>Trade impact</h2><span class="small">' + src("calc", "Calculated from the rosters above") + "</span></div>" +
        '<div class="fo-tb-impact"><section><h3>Salary cap and contracts</h3>' + capSection(imp) + "</section>" +
        "<section><h3>Lineup impact</h3>" + lineupSection(imp) + "</section>" +
        "<section><h3>Validation and approval</h3>" + validationSection(imp) + "</section></div></div>";
    }

    // ── Review and send ───────────────────────────────────────────────
    function reviewCard() {
      var r = readiness();
      var lines = C.summary(draft, nm).map(function (l) { return "<li>" + esc(l.text) + "</li>"; }).join("");
      var off = opt.send ? "" : '<p class="fo-banner warn" role="status">' + esc(opt.sendNotice || "Sending is not available here.") + "</p>";
      var confirm = "";
      if (st.confirm) confirm = '<div class="fo-banner info fo-tb-confirm" role="alertdialog" aria-label="Confirm sending"><p><b>Send this offer to ' + esc(others().map(nm).join(" and ")) + '?</b> An offer that has been sent can’t be pulled back from here.</p>' +
        '<button type="button" class="btn secondary" data-go="cancel-send">Cancel</button> <button type="button" class="btn" data-go="confirm-send">Yes, send</button></div>';
      var result = st.sent ? '<p class="fo-banner ' + (st.sent.ok ? "info" : "warn") + '" role="status">' + esc(st.sent.message) + "</p>" : "";
      return '<div class="fo-card"><div class="fo-card-head"><h2>Review and send</h2></div>' +
        (draft.items.length ? '<ul class="fo-tb-sum">' + lines + "</ul>" : '<p class="fo-ov-empty">Build a trade above to review it.</p>') +
        '<label class="fo-tb-note">Note to the other owner' + (others().length > 1 ? "s" : "") + ' (optional)<textarea data-note maxlength="500" placeholder="' + esc((opt.note && opt.note.placeholder) || "Say why this works for both teams") + '">' + esc(st.note) + "</textarea></label>" +
        off + confirm + result +
        '<p class="fo-tb-actions"><button type="button" class="btn" data-go="send"' + (r.canAttempt && !st.confirm ? "" : " disabled") + ">Send offer</button> " +
        (r.canAttempt ? "" : '<span class="fo-muted">Available once the server says the trade looks fine or only needs an acknowledgment.</span>') + "</p>" +
        (opt.warRoomUrl ? '<p class="fo-basis"><a class="fo-go" href="' + esc(opt.warRoomUrl) + '">Trade War Room ↗</a> (optional; not needed to finish a trade here)</p>' : "") + "</div>";
    }

    function render() {
      var keep = el.querySelector && el.querySelector("[data-note]"); if (keep) st.note = keep.value;
      var focus = document.activeElement, fq = focus && focus.getAttribute && focus.getAttribute("data-q"), pos = focus && focus.selectionStart;
      el.innerHTML = '<div class="fo-tb">' + proposalCard() + impactCard() + reviewCard() + "</div>";
      if (fq) { var n = el.querySelector('[data-q="' + fq + '"]'); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) {} } }
    }

    el.addEventListener("click", function (e) {
      var g = e.target.closest && e.target.closest("[data-go]");
      if (g) {
        var go = g.getAttribute("data-go"), keepN = el.querySelector("[data-note]"); if (keepN) st.note = keepN.value;
        if (go === "send") { if (readiness().canAttempt) st.confirm = true; }
        else if (go === "cancel-send") st.confirm = false;
        else if (go === "confirm-send") {
          st.confirm = false;
          if (!readiness().canAttempt) st.sent = { ok: false, message: "The check changed. Review the trade again." };
          else if (typeof opt.send !== "function") st.sent = { ok: false, message: "Nothing was sent. Sending is not available here." };
          else {
            st.sent = { ok: false, message: "Sending…" };
            var mine = st.seq;
            Promise.resolve().then(function () { return opt.send(C.sendPlan(draft, ctx, st.note)); }).then(function (r) { return r || { ok: false, message: "No answer. Nothing is confirmed." }; }, function () { return { ok: false, message: "The send did not go through. Nothing is confirmed." }; })
              .then(function (r) { if (mine !== st.seq) return; st.sent = r; render(); });
          }
        }
        render(); return;
      }
      var b = e.target.closest && e.target.closest("[data-tok]"); if (!b) return;
      var tok = b.getAttribute("data-tok"), from = b.getAttribute("data-from");
      if (C.hasItem(draft, tok, from)) draft = C.removeItem(draft, tok, from);
      else {
        var a = opt.assets(from) || { players: [], picks: [] }, p = a.players.filter(function (x) { return "P_" + x.id === tok; })[0], kk = a.picks.filter(function (x) { return x.token === tok; })[0];
        draft = C.addItem(draft, { from: from, to: dest(from), token: tok, label: p ? p.name : kk ? kk.label : tok, salary: p ? p.salary : 0, taxi: p ? p.taxi : false });
      }
      changed();
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
        draft = C.setCapK(draft, t.getAttribute("data-cap-from"), t.getAttribute("data-cap-to"), t.value); changed();
      }
    });
    render();
    return { refresh: render, draft: function () { return draft; }, state: function () { return { phase: st.phase, resp: st.resp, sent: st.sent }; } };
  }

  var api = { mount: mount };
  root.UPS_TRADE_BUILDER_VIEW = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : this);
