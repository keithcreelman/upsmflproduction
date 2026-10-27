/* Trade Builder view (Front Office → Trades → Trade builder; plan #1385, phase P3/P4 shape).
   One self-contained flow: Build → Review (note, effects, the server's verdict) → Send (confirmation).
   The server's verdict (POST /api/trades/compliance-preview) is the only authority; this view never decides
   that a trade is allowed. The Send step is WIRED but takes an injected `send(plan)`: when none is given (every
   build today) it says plainly that sending is not available and nothing leaves the page. No write route is
   named or called from this file.
     mount(el, { teams:[{fid,name}], assets(fid) -> {players:[{id,name,pos,salary,years,taxi}], picks:[{token,label}]},
                 ctx:{leagueId,season,viewerFid}, preview(body) -> Promise<json>,
                 send(plan) -> Promise<{ok,message}>   (optional),
                 sendNotice: "why sending is off" (shown on the Review step), warRoomUrl (optional secondary link),
                 note: { placeholder }, debounceMs }) */
(function (root) {
  "use strict";
  var C = root.UPS_TRADE_BUILDER_CORE || (typeof require === "function" ? require("./trade_builder_core.js") : null);

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function money(d) { return "$" + (Math.round(Number(d) || 0) / 1000).toFixed(0) + "K"; }

  var CSS = ".tb-root{display:grid;gap:12px;max-width:720px;color:var(--text,#14181f)}.tb-root *{box-sizing:border-box}" +
    ".tb-readonly,.tb-note,.tb-fine{margin:0;color:var(--muted,#566170);font-size:13px}" +
    ".tb-steps{display:flex;gap:6px;list-style:none;margin:0;padding:0;font-size:12px;color:var(--muted,#566170)}.tb-steps li{padding:2px 8px;border:1px solid var(--border,#d5dae1);border-radius:999px}.tb-steps li.on{color:var(--text,#14181f);border-color:var(--accent,#1d4ed8);background:var(--accent-soft,#e8eefc)}" +
    ".tb-pick{display:grid;gap:8px}.tb-root label{display:grid;gap:4px;font-size:13px;color:var(--muted,#566170)}" +
    ".tb-root select,.tb-root input,.tb-root textarea{min-height:44px;font:inherit;font-size:16px;padding:6px 8px;border:1px solid var(--border,#d5dae1);border-radius:8px;background:var(--panel-alt,#fff);color:var(--text,#14181f);width:100%}.tb-root textarea{min-height:88px;resize:vertical}" +
    ".tb-team{background:var(--panel,#fff);border:1px solid var(--border,#d5dae1);border-radius:10px;padding:10px}.tb-team h3{margin:0 0 8px;font-size:15px}" +
    ".tb-assets{list-style:none;margin:0 0 8px;padding:0;display:grid;gap:6px}" +
    ".tb-asset,.tb-btn{min-height:44px;font:inherit;color:var(--text,#14181f);background:var(--panel-alt,#f6f7f9);border:1px solid var(--border,#d5dae1);border-radius:8px;padding:6px 12px;cursor:pointer}" +
    ".tb-asset{width:100%;display:flex;justify-content:space-between;gap:8px;align-items:center;text-align:left}.tb-asset.on{border-color:var(--accent,#1d4ed8);box-shadow:inset 0 0 0 1px var(--accent,#1d4ed8);background:var(--accent-soft,#e8eefc)}" +
    ".tb-ameta{color:var(--muted,#566170);font-size:12px;white-space:nowrap}.tb-dest{margin-top:4px}" +
    ".tb-verdict{background:var(--panel,#fff);border:2px solid var(--border,#d5dae1);border-radius:10px;padding:10px}.tb-pill{margin:0 0 6px;font-weight:700}" +
    ".tb-provisional{border-color:var(--ok,#14653a)}.tb-blocked{border-color:var(--err,#a11d1d)}.tb-needs_ack,.tb-unavailable{border-color:var(--warn,#8a5a00)}" +
    ".tb-verdict ul,.tb-sum{margin:0 0 8px;padding-left:20px}.tb-lock{margin:6px 0;font-weight:600}.tb-lock.tb-ok{color:var(--ok,#14653a)}.tb-lock.tb-warn{color:var(--warn,#8a5a00)}.tb-lock.tb-bad{color:var(--err,#a11d1d)}" +
    ".tb-actions{display:flex;gap:8px;flex-wrap:wrap}.tb-btn.primary{background:var(--accent,#1d4ed8);border-color:var(--accent,#1d4ed8);color:#fff;font-weight:600}.tb-btn[disabled]{opacity:.5;cursor:not-allowed}" +
    ".tb-off{border:2px dashed var(--warn,#8a5a00);border-radius:10px;padding:10px;font-weight:600}.tb-confirm{border:2px solid var(--accent,#1d4ed8);border-radius:10px;padding:12px;background:var(--panel,#fff)}.tb-confirm p{margin:0 0 8px}" +
    ".tb-open{color:var(--accent,#1d4ed8);font-size:13px}";

  function mount(el, opt) {
    if (typeof document !== "undefined" && !document.getElementById("tb-style")) {
      var sty = document.createElement("style"); sty.id = "tb-style"; sty.textContent = CSS; document.head.appendChild(sty);
    }
    var teams = opt.teams, ctx = opt.ctx, me = C.pad4(ctx.viewerFid);
    var delay = opt.debounceMs == null ? 600 : opt.debounceMs;
    var draft = C.emptyDraft([me]);
    var st = { phase: "idle", resp: null, seq: 0, timer: null, stage: "build", note: "", confirm: false, sent: null };
    var names = {}; teams.forEach(function (t) { names[C.pad4(t.fid)] = t.name; });
    function nm(f) { return names[f] || "Team " + f; }
    function others() { return draft.teams.filter(function (f) { return f !== me; }); }
    function setPartners(list) { draft = C.withTeams(draft, [me].concat(list.filter(Boolean))); changed(); }

    function readiness() { return C.readiness(C.gaps(draft), st.phase, st.resp); }
    function changed() {
      var gaps = C.gaps(draft), sig = gaps.length ? "" : C.signature(draft, ctx);
      clearTimeout(st.timer);
      st.seq++;                          // any answer still in flight is now stale
      st.confirm = false; st.sent = null;
      if (!sig) { st.phase = "idle"; st.resp = null; st.stage = "build"; render(); return; }
      st.phase = "checking"; st.resp = null; render();
      var mine = st.seq;
      st.timer = setTimeout(function () {
        Promise.resolve().then(function () { return opt.preview(C.request(draft, ctx)); }).then(function (j) { return j; }, function () { return null; })
          .then(function (j) { if (mine !== st.seq) return; st.phase = "done"; st.resp = j; render(); });
      }, delay);
    }

    function dest(from) {
      var t = draft.teams, i = t.indexOf(from);
      return t.length === 2 ? t[1 - i] : t[(i + 1) % t.length];
    }
    function assetRow(from, a) {
      var on = C.hasItem(draft, a.token, from);
      var item = draft.items.filter(function (i) { return i.token === a.token && i.from === from; })[0];
      var sel = "";
      if (on && draft.teams.length === 3) {
        sel = '<label class="tb-dest">to <select data-dest="' + esc(a.token) + '" data-from="' + from + '">' + draft.teams.filter(function (f) { return f !== from; }).map(function (f) {
          return '<option value="' + f + '"' + (item.to === f ? " selected" : "") + ">" + esc(nm(f)) + "</option>"; }).join("") + "</select></label>";
      }
      return '<li><button type="button" class="tb-asset' + (on ? " on" : "") + '" aria-pressed="' + on + '" data-tok="' + esc(a.token) + '" data-from="' + from + '">' +
        '<span class="tb-aname">' + esc(a.label) + '</span><span class="tb-ameta">' + esc(a.meta || "") + "</span></button>" + sel + "</li>";
    }
    function teamBlock(f) {
      var a = opt.assets(f) || { players: [], picks: [] };
      var rows = a.players.map(function (p) {
        return assetRow(f, { token: "P_" + p.id, label: p.name, meta: [p.pos, money(p.salary), p.taxi ? "taxi" : (p.years != null ? p.years + " yr" : "")].filter(Boolean).join(" · ") });
      }).concat(a.picks.map(function (k) { return assetRow(f, { token: k.token, label: k.label, meta: "pick" }); })).join("");
      var cap = draft.teams.filter(function (x) { return x !== f; }).map(function (to) {
        return '<label class="tb-cap">Cap money to ' + esc(nm(to)) + ' ($K, up to about ' + C.capMoneyHintK(draft, f) + 'K)<input type="number" min="0" step="1" inputmode="numeric" data-cap-from="' + f + '" data-cap-to="' + to + '" value="' + (draft.capK[f + ">" + to] || "") + '"></label>';
      }).join("");
      return '<section class="tb-team" aria-label="' + esc(nm(f)) + '"><h3>' + esc(nm(f)) + (f === me ? " (you send)" : " sends") + '</h3><ul class="tb-assets">' + (rows || "<li>No assets listed.</li>") + "</ul>" + cap + "</section>";
    }
    function verdictPanel(r) {
      var reasons = r.reasons.map(function (x) { return "<li>" + esc(x.text) + "</li>"; }).join("");
      return '<section class="tb-verdict tb-' + r.state + '" aria-live="polite"><p class="tb-pill">' + esc(r.label) + "</p>" + (reasons ? "<ul>" + reasons + "</ul>" : "") +
        (r.lock ? '<p class="tb-lock tb-' + r.lock.tone + '">' + esc(r.lock.text) + "</p>" : "") +
        '<p class="tb-note">This comes from the server’s live checks. “Looks fine so far” is not an acceptance: sending runs more checks, and MFL decides.</p></section>';
    }
    function steps() {
      var order = [["build", "1 Build"], ["review", "2 Review"], ["send", "3 Send"]], at = st.stage === "build" ? 0 : st.stage === "review" ? 1 : 2;
      return '<ol class="tb-steps" aria-label="Steps">' + order.map(function (s, i) { return '<li class="' + (i === at ? "on" : "") + '"' + (i === at ? ' aria-current="step"' : "") + ">" + s[1] + "</li>"; }).join("") + "</ol>";
    }

    function buildScreen() {
      var picker = '<div class="tb-pick"><label>Trade with <select data-partner="0"><option value="">Choose a team</option>' +
        teams.filter(function (t) { return C.pad4(t.fid) !== me; }).map(function (t) { var f = C.pad4(t.fid); return '<option value="' + f + '"' + (others()[0] === f ? " selected" : "") + ">" + esc(t.name) + "</option>"; }).join("") + "</select></label>";
      if (others().length) {
        picker += '<label>Third team (optional) <select data-partner="1"><option value="">None</option>' +
          teams.filter(function (t) { var f = C.pad4(t.fid); return f !== me && f !== others()[0]; }).map(function (t) { var f = C.pad4(t.fid); return '<option value="' + f + '"' + (others()[1] === f ? " selected" : "") + ">" + esc(t.name) + "</option>"; }).join("") + "</select></label>";
      }
      picker += "</div>";
      var r = readiness();
      return picker + (others().length ? draft.teams.map(teamBlock).join("") : "<p>Choose a team to start.</p>") + verdictPanel(r) +
        '<div class="tb-actions"><button type="button" class="tb-btn primary" data-go="review"' + (r.canAttempt ? "" : " disabled") + ">Review trade</button></div>" +
        (r.canAttempt ? "" : '<p class="tb-fine">Review opens once the server says the trade looks fine (or only needs an acknowledgment).</p>');
    }
    function reviewScreen() {
      var r = readiness();
      var lines = C.summary(draft, nm).map(function (l) { return "<li>" + esc(l.text) + "</li>"; }).join("");
      var sendNote = opt.send ? "" : '<p class="tb-off" role="status">' + esc(opt.sendNotice || "Sending is not available here.") + "</p>";
      var confirm = "";
      if (st.confirm) {
        var to = others().map(nm).join(" and ");
        confirm = '<div class="tb-confirm" role="alertdialog" aria-label="Confirm sending"><p><b>Send this offer to ' + esc(to) + '?</b></p><p class="tb-fine">An offer that has been sent can’t be pulled back from here.</p>' +
          '<div class="tb-actions"><button type="button" class="tb-btn" data-go="cancel-send">Cancel</button><button type="button" class="tb-btn primary" data-go="confirm-send">Yes, send</button></div></div>';
      }
      var result = st.sent ? '<p class="' + (st.sent.ok ? "tb-lock tb-ok" : "tb-off") + '" role="status">' + esc(st.sent.message) + "</p>" : "";
      return '<section class="tb-team"><h3>What this offer says</h3><ul class="tb-sum">' + lines + "</ul>" +
        '<label>Note to the other owner' + (others().length > 1 ? "s" : "") + ' (optional)<textarea data-note maxlength="500" placeholder="' + esc((opt.note && opt.note.placeholder) || "Say why this works for both teams") + '">' + esc(st.note) + "</textarea></label></section>" +
        verdictPanel(r) + sendNote + confirm + result +
        '<div class="tb-actions"><button type="button" class="tb-btn" data-go="build">Back to edit</button>' +
        '<button type="button" class="tb-btn primary" data-go="send"' + (r.canAttempt && !st.confirm ? "" : " disabled") + ">Send offer</button></div>" +
        (opt.warRoomUrl ? '<p class="tb-fine"><a class="tb-open" href="' + esc(opt.warRoomUrl) + '">Prefer the Trade War Room? Open it (optional)</a></p>' : "");
    }
    function render() {
      var keepNote = el.querySelector && el.querySelector("[data-note]");
      if (keepNote) st.note = keepNote.value;
      el.innerHTML = '<div class="tb-root">' + steps() + (st.stage === "review" && readiness().canAttempt ? reviewScreen() : (st.stage = "build", buildScreen())) + "</div>";
    }

    el.addEventListener("click", function (e) {
      var g = e.target.closest && e.target.closest("[data-go]");
      if (g) {
        var go = g.getAttribute("data-go"), keep = el.querySelector("[data-note]"); if (keep) st.note = keep.value;
        if (go === "review") { if (readiness().canAttempt) st.stage = "review"; st.sent = null; }
        else if (go === "build") { st.stage = "build"; st.confirm = false; st.sent = null; }
        else if (go === "send") { if (readiness().canAttempt) st.confirm = true; }
        else if (go === "cancel-send") st.confirm = false;
        else if (go === "confirm-send") {
          st.confirm = false;
          if (!readiness().canAttempt) { st.sent = { ok: false, message: "The check changed. Review the trade again." }; }
          else if (typeof opt.send !== "function") { st.sent = { ok: false, message: "Nothing was sent. Sending is not available here." }; }
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
        var a = opt.assets(from) || { players: [], picks: [] }, p = a.players.filter(function (x) { return "P_" + x.id === tok; })[0], k = a.picks.filter(function (x) { return x.token === tok; })[0];
        draft = C.addItem(draft, { from: from, to: dest(from), token: tok, label: p ? p.name : k ? k.label : tok, salary: p ? p.salary : 0, taxi: p ? p.taxi : false });
      }
      changed();
    });
    el.addEventListener("change", function (e) {
      var t = e.target;
      if (t.hasAttribute("data-partner")) {
        var cur = others(), idx = Number(t.getAttribute("data-partner"));
        cur[idx] = t.value; if (idx === 0 && !t.value) cur = []; setPartners(cur.filter(Boolean).filter(function (v, i, a) { return a.indexOf(v) === i; }));
      } else if (t.hasAttribute("data-dest")) {
        var tok = t.getAttribute("data-dest"), from = t.getAttribute("data-from"), old = draft.items.filter(function (i) { return i.token === tok && i.from === from; })[0];
        draft = C.removeItem(draft, tok, from); draft = C.addItem(draft, { from: from, to: t.value, token: tok, label: old.label, salary: old.salary, taxi: old.taxi }); changed();
      } else if (t.hasAttribute("data-cap-from")) {
        draft = C.setCapK(draft, t.getAttribute("data-cap-from"), t.getAttribute("data-cap-to"), t.value); changed();
      }
    });
    render();
    return { refresh: render, draft: function () { return draft; }, state: function () { return { phase: st.phase, stage: st.stage, resp: st.resp, sent: st.sent }; } };
  }

  var api = { mount: mount };
  root.UPS_TRADE_BUILDER_VIEW = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : this);
