/* Trade Builder view (Front Office, READ-ONLY; plan #1385, phase P3).
   Builds a two- or three-team trade from the rosters it is given and shows the SERVER's verdict
   (POST /api/trades/compliance-preview). It has no send path: no propose, accept, counter or
   create call exists here, and the only way on is a link that opens the Trade War Room.
   Needs UPS_TRADE_BUILDER_CORE. Inputs are injected so tests and previews run on recorded data:
     mount(el, { teams:[{fid,name}], assets(fid) -> {players:[{id,name,pos,salary,years,taxi}], picks:[{token,label}]},
                 ctx:{leagueId,season,viewerFid}, preview(body) -> Promise<json>, warRoomUrl, debounceMs }) */
(function (root) {
  "use strict";
  var C = root.UPS_TRADE_BUILDER_CORE || (typeof require === "function" ? require("./trade_builder_core.js") : null);

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function money(d) { return "$" + (Math.round(Number(d) || 0) / 1000).toFixed(0) + "K"; }

  function mount(el, opt) {
    var teams = opt.teams, ctx = opt.ctx, me = C.pad4(ctx.viewerFid);
    var delay = opt.debounceMs == null ? 600 : opt.debounceMs;
    var draft = C.emptyDraft([me]);
    var st = { phase: "idle", resp: null, seq: 0, timer: null, sig: "", open: {} };
    var names = {}; teams.forEach(function (t) { names[C.pad4(t.fid)] = t.name; });
    function nm(f) { return names[f] || "Team " + f; }

    function others() { return draft.teams.filter(function (f) { return f !== me; }); }
    function setPartners(list) { draft = C.withTeams(draft, [me].concat(list.filter(Boolean))); changed(); }

    function changed() {
      var gaps = C.gaps(draft), sig = gaps.length ? "" : C.signature(draft, ctx);
      clearTimeout(st.timer);
      st.seq++;                          // any answer still in flight is now stale
      if (!sig) { st.phase = "idle"; st.resp = null; st.sig = ""; render(); return; }
      st.phase = "checking"; st.resp = null; st.sig = sig; render();
      var mine = st.seq;
      st.timer = setTimeout(function () {
        Promise.resolve().then(function () { return opt.preview(C.request(draft, ctx)); }).then(function (j) { return j; }, function () { return null; })
          .then(function (j) { if (mine !== st.seq) return; st.phase = "done"; st.resp = j; render(); });
      }, delay);
    }

    function dest(from) {
      // Two teams: the other one. Three: the next team in the ring unless the owner picked another.
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
        '<span class="tb-aname">' + esc(a.label) + "</span><span class=\"tb-ameta\">" + esc(a.meta || "") + "</span></button>" + sel + "</li>";
    }
    function teamBlock(f) {
      var a = opt.assets(f) || { players: [], picks: [] };
      var rows = a.players.map(function (p) {
        return assetRow(f, { token: "P_" + p.id, label: p.name, meta: [p.pos, money(p.salary), p.taxi ? "taxi" : (p.years != null ? p.years + " yr" : "")].filter(Boolean).join(" · "), salary: p.salary, taxi: p.taxi });
      }).concat(a.picks.map(function (k) { return assetRow(f, { token: k.token, label: k.label, meta: "pick" }); })).join("");
      var recv = draft.teams.filter(function (x) { return x !== f; });
      var cap = recv.map(function (to) {
        return '<label class="tb-cap">Cap money to ' + esc(nm(to)) + ' ($K, up to about ' + C.capMoneyHintK(draft, f) + 'K)<input type="number" min="0" step="1" inputmode="numeric" data-cap-from="' + f + '" data-cap-to="' + to + '" value="' + (draft.capK[f + ">" + to] || "") + '"></label>';
      }).join("");
      return '<section class="tb-team" aria-label="' + esc(nm(f)) + '"><h3>' + esc(nm(f)) + (f === me ? " (you send)" : " sends") + '</h3><ul class="tb-assets">' + (rows || "<li>No assets listed.</li>") + "</ul>" + cap + "</section>";
    }
    function panel() {
      var r = C.readiness(C.gaps(draft), st.phase, st.resp);
      var reasons = r.reasons.map(function (x) { return "<li>" + esc(x.text) + "</li>"; }).join("");
      return '<section class="tb-verdict tb-' + r.state + '" aria-live="polite"><p class="tb-pill">' + esc(r.label) + "</p>" + (reasons ? "<ul>" + reasons + "</ul>" : "") +
        (r.lock ? '<p class="tb-lock tb-' + r.lock.tone + '">' + esc(r.lock.text) + "</p>" : "") +
        '<p class="tb-note">This is a preview from the server’s live checks. It never sends a trade, and “looks fine” is not an acceptance: sending still runs more checks, and MFL decides.</p>' +
        (opt.warRoomUrl ? '<a class="tb-open" href="' + esc(opt.warRoomUrl) + '">Open in Trade War Room to send</a>' : "") + "</section>";
    }
    function render() {
      var picker = '<div class="tb-pick"><label>Trade with <select data-partner="0"><option value="">Choose a team</option>' +
        teams.filter(function (t) { return C.pad4(t.fid) !== me; }).map(function (t) { var f = C.pad4(t.fid); return '<option value="' + f + '"' + (others()[0] === f ? " selected" : "") + ">" + esc(t.name) + "</option>"; }).join("") + "</select></label>";
      if (others().length) {
        picker += '<label>Third team (optional) <select data-partner="1"><option value="">None</option>' +
          teams.filter(function (t) { var f = C.pad4(t.fid); return f !== me && f !== others()[0]; }).map(function (t) { var f = C.pad4(t.fid); return '<option value="' + f + '"' + (others()[1] === f ? " selected" : "") + ">" + esc(t.name) + "</option>"; }).join("") + "</select></label>";
      }
      picker += "</div>";
      el.innerHTML = '<div class="tb-root"><p class="tb-readonly">Read-only builder: nothing here sends, saves or changes a trade.</p>' + picker +
        (others().length ? draft.teams.map(teamBlock).join("") : "<p>Choose a team to start.</p>") + panel() + "</div>";
    }

    el.addEventListener("click", function (e) {
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
    return { draft: function () { return draft; }, state: function () { return { phase: st.phase, resp: st.resp }; } };
  }

  var api = { mount: mount };
  root.UPS_TRADE_BUILDER_VIEW = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : this);
