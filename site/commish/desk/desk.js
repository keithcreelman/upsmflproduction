/* UPS Commissioner Desk: controller.
 *
 * Needs desk_render.js loaded first (window.UPSDeskRender). Talks to the Worker ONLY through one injected `api` object,
 * so the same code runs against the live Worker (commish_settings.html) or fixtures (desk_preview.html):
 *
 *   api.ask({question, as_of}, {onProgress})  -> Promise<{request_id, card}>
 *   api.history()                             -> Promise<{items:[{id, created_at, question, state}]}>
 *   api.question(id)                          -> Promise<{item:{id, created_at, question, state, card}}>
 *   api.report({id, note})                    -> Promise<{ok:true}>
 *   api.status()                              -> Promise<{enabled, live_model_enabled, budget}>   (optional here)
 *
 * The desk is read-only: nothing here posts, sends or changes league data. "Report a problem" and "Copy" are the only writes,
 * and the first goes to the desk's own private eval log through api.report.
 */
(function (global) {
  "use strict";
  var R = global.UPSDeskRender;
  var uid = 0;

  function errCard(err) {
    var d = err && err.data && typeof err.data === "object" ? err.data : {};
    var code = String(d.state || d.error || d.reason || "").toLowerCase();
    var msg = String((err && err.message) || "");
    if (code === "budget_exceeded" || /budget_exceeded/i.test(msg) || (err && err.status === 402)) return R.syntheticCard("budget_exceeded");
    if (code === "not_ready" || /not_ready/i.test(msg) || (err && err.status === 503)) return R.syntheticCard("not_ready");
    return R.syntheticCard("tool_failure", { lead_md: "The desk could not reach its records just now. Nothing was guessed. Try the question again." });
  }

  function mount(root, options) {
    options = options || {};
    var api = options.api;
    if (!api || typeof api.ask !== "function") throw new Error("UPSDesk.mount needs an api object with ask()");
    var doc = root.ownerDocument || global.document;
    var id = "ud" + (++uid);
    var theme = options.theme === "dark" || options.theme === "light" ? options.theme : "";
    var suggestions = R.normalizeSuggestions(options.suggestions);
    var S = { busy: false, card: null, question: "", lastAsk: null, history: [], timer: null, t0: 0, opener: null, tool: 0 };
    var log = typeof options.onLog === "function" ? options.onLog : function (m) { try { global.console && global.console.warn(m); } catch (e) { /* ignore */ } };

    root.classList.add("ud-root");
    if (theme) root.setAttribute("data-theme", theme);
    root.innerHTML =
      (options.banner ? '<p class="ud-fixture-note ud-caveat" role="note"></p>' : "") +
      '<section class="ud-ask" aria-label="Ask the desk"><form class="ud-form" data-role="form" novalidate>' +
        '<label class="ud-label" for="' + id + '-q">Ask a league question</label>' +
        '<textarea id="' + id + '-q" class="ud-input" rows="2" maxlength="600" data-role="q" placeholder="For example: trace a pick, or what a rule says" enterkeyhint="send"></textarea>' +
        '<div class="ud-asof"><label for="' + id + '-a">Data as of</label>' +
          '<select id="' + id + '-a" class="ud-input" data-role="asof"><option value="current">Current data</option><option value="date">A past date</option></select>' +
          '<label class="ud-sr" for="' + id + '-d">Past date</label><input id="' + id + '-d" class="ud-input" type="date" data-role="asof-date" hidden></div>' +
        '<p class="ud-msg" data-role="msg" role="alert"></p>' +
        '<button type="submit" class="ud-btn ud-btn-primary" data-role="ask">Ask</button>' +
      '</form><div class="ud-suggest" data-role="suggest" role="group" aria-label="Suggested questions"></div></section>' +
      '<section class="ud-progress" data-role="progress" role="status" aria-live="polite" hidden></section>' +
      '<section class="ud-result" data-role="result" aria-label="Answer" tabindex="-1"></section>' +
      '<section class="ud-history" aria-labelledby="' + id + '-h"><h2 id="' + id + '-h">Recent questions</h2>' +
        '<p class="ud-note">Private to the desk. Last 50, kept 90 days.</p><ul class="ud-hist-list" data-role="history"></ul></section>' +
      '<div class="ud-drawer" data-role="drawer" hidden><div class="ud-drawer-bg" data-act="close-drawer"></div>' +
        '<div class="ud-drawer-panel" role="dialog" aria-modal="true" aria-labelledby="ud-drawer-t" tabindex="-1">' +
        '<button type="button" class="ud-btn ud-btn-ghost ud-drawer-x" data-act="close-drawer">Close</button><div data-role="drawer-body"></div></div></div>';

    function q(role) { return root.querySelector('[data-role="' + role + '"]'); }
    var el = { form: q("form"), q: q("q"), asof: q("asof"), date: q("asof-date"), msg: q("msg"), ask: q("ask"), suggest: q("suggest"), progress: q("progress"),
      result: q("result"), history: q("history"), drawer: q("drawer"), drawerBody: q("drawer-body") };
    if (options.banner) root.querySelector(".ud-fixture-note").textContent = String(options.banner);
    el.suggest.innerHTML = R.renderSuggestionsHtml(suggestions);
    el.history.innerHTML = R.renderHistoryHtml([]);

    // ── Busy state: the ask button and every action that would start a question are disabled while one is in flight ──
    function setBusy(b) {
      S.busy = b;
      root.setAttribute("aria-busy", b ? "true" : "false");
      el.ask.disabled = b; el.ask.textContent = b ? "Working…" : "Ask";
      var btns = root.querySelectorAll("[data-busy-off]");
      for (var i = 0; i < btns.length; i++) { btns[i].disabled = b; if (b) btns[i].setAttribute("aria-disabled", "true"); else btns[i].removeAttribute("aria-disabled"); }
    }
    function say(m) { el.msg.textContent = m || ""; }

    // ── Progress ──
    var STEPS = ["Understood the question", "Checking the records", "Writing the answer"];
    function drawProgress() {
      var secs = Math.max(0, Math.round((Date.now() - S.t0) / 1000));
      var now = S.tool > 0 || secs >= 2 ? (secs >= 4 ? 2 : 1) : 1;
      var li = STEPS.map(function (s, i) {
        var cls = i < now ? "ud-s-done" : i === now ? "ud-s-now" : "";
        var mark = i < now ? "✓" : i === now ? "…" : "·";
        var word = i < now ? "done" : i === now ? "working" : "waiting";
        var extra = i === 1 && S.tool > 0 ? " (" + S.tool + " tool" + (S.tool === 1 ? "" : "s") + " so far)" : "";
        return '<li class="' + cls + '"><span class="ud-step-m" aria-hidden="true">' + mark + '</span><span>' + R.esc(s + extra) + '</span><span class="ud-sr"> ' + word + "</span></li>";
      }).join("");
      el.progress.innerHTML = '<ol class="ud-steps">' + li + '</ol><p class="ud-elapsed">Working for ' + secs + " s. The desk checks code-built records; it does not guess.</p>";
    }
    function startProgress() {
      S.t0 = Date.now(); S.tool = 0; el.progress.hidden = false; drawProgress();
      S.timer = global.setInterval(drawProgress, 1000);
    }
    function stopProgress() { if (S.timer) { global.clearInterval(S.timer); S.timer = null; } el.progress.hidden = true; el.progress.innerHTML = ""; }
    function onProgress(p) { if (p && typeof p.tools === "number") S.tool = p.tools; drawProgress(); }

    // ── Show a card ──
    function show(card, question, scroll) {
      S.card = card; S.question = question || "";
      el.result.innerHTML = R.renderCardHtml(card, { question: question, onMissing: function (mid) { log("desk: missing fact " + mid + " in card " + (card && card.request_id)); } });
      var bs = el.result.querySelectorAll("[data-busy-off]");
      for (var i = 0; i < bs.length; i++) bs[i].disabled = S.busy;
      if (scroll !== false) { try { el.result.scrollIntoView({ block: "start" }); el.result.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
    }

    function asOfValue() {
      if (el.asof.value !== "date") return "current";
      var v = String(el.date.value || "");
      return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
    }

    function pushHistory(entry) {
      S.history = [entry].concat(S.history.filter(function (h) { return h.id !== entry.id; })).slice(0, 50);
      el.history.innerHTML = R.renderHistoryHtml(S.history);
      setBusy(S.busy);
    }
    function loadHistory() {
      if (typeof api.history !== "function") return Promise.resolve();
      return Promise.resolve().then(function () { return api.history(); }).then(function (r) {
        S.history = (r && Array.isArray(r.items) ? r.items : []).slice(0, 50);
        el.history.innerHTML = R.renderHistoryHtml(S.history);
        setBusy(S.busy);
      }).catch(function () { el.history.innerHTML = '<li class="ud-empty">History is not available right now.</li>'; });
    }

    function ask(question, asOf) {
      question = String(question || "").trim();
      if (S.busy) return Promise.resolve();
      if (!question) { say("Type a question first."); return Promise.resolve(); }
      if (asOf === null) { say("Pick a past date, or switch back to current data."); return Promise.resolve(); }
      say(""); S.lastAsk = { question: question, asOf: asOf || "current" };
      setBusy(true); startProgress();
      return Promise.resolve().then(function () { return api.ask({ question: question, as_of: S.lastAsk.asOf }, { onProgress: onProgress }); })
        .then(function (res) {
          var card = res && res.card && typeof res.card === "object" ? res.card : null;
          if (card && !card.request_id && res.request_id) card.request_id = res.request_id;
          if (!card) card = R.syntheticCard("tool_failure", { lead_md: "The desk got an answer it could not read. Try the question again." });
          return card;
        }, function (err) { return errCard(err); })
        .then(function (card) {
          stopProgress(); setBusy(false);
          show(card, question);
          if (card.request_id) pushHistory({ id: card.request_id, created_at: new Date().toISOString(), question: question, state: card.state });
        });
    }

    // ── Provenance drawer (one tap from any fact chip) ──
    function openDrawer(factId, opener) {
      if (!S.card) return;
      S.opener = opener || null;
      el.drawerBody.innerHTML = R.renderProvenanceHtml(S.card, factId);
      el.drawer.hidden = false;
      var panel = el.drawer.querySelector(".ud-drawer-panel");
      try { (el.drawer.querySelector(".ud-drawer-x") || panel).focus(); } catch (e) { /* ignore */ }
    }
    function closeDrawer() {
      el.drawer.hidden = true; el.drawerBody.innerHTML = "";
      try { if (S.opener && S.opener.focus) S.opener.focus(); } catch (e) { /* ignore */ }
      S.opener = null;
    }
    function trapTab(ev) {
      if (el.drawer.hidden || ev.key !== "Tab") return;
      var f = el.drawer.querySelectorAll("button, a[href], summary, [tabindex]:not([tabindex='-1'])");
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1], active = doc.activeElement;
      if (ev.shiftKey && (active === first || !el.drawer.contains(active))) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && (active === last || !el.drawer.contains(active))) { ev.preventDefault(); first.focus(); }
    }

    // ── Report a problem (private eval case; nothing is posted or sent anywhere else) ──
    function openReport() {
      var box = el.result.querySelector('[data-role="report"]');
      if (!box) return;
      if (!box.hidden) { box.hidden = true; return; }
      box.hidden = false;
      box.innerHTML = '<label class="ud-label" for="' + id + '-n">What was wrong?</label>' +
        '<textarea id="' + id + '-n" class="ud-input" rows="3" maxlength="1000" data-role="note" placeholder="A wrong number, a missing source, a bad refusal"></textarea>' +
        '<p class="ud-note">Saved as a private draft test case with this question and card. Nothing is posted or sent.</p>' +
        '<p class="ud-msg" data-role="rmsg" role="status"></p>' +
        '<div class="ud-actions"><button type="button" class="ud-btn ud-btn-primary" data-act="report-send">Save report</button><button type="button" class="ud-btn ud-btn-ghost" data-act="report-cancel">Cancel</button></div>';
      try { box.querySelector("textarea").focus(); } catch (e) { /* ignore */ }
    }
    function sendReport() {
      var box = el.result.querySelector('[data-role="report"]'); if (!box) return;
      var note = box.querySelector('[data-role="note"]'), msg = box.querySelector('[data-role="rmsg"]'), send = box.querySelector('[data-act="report-send"]');
      var rid = S.card && S.card.request_id;
      if (!rid) { msg.textContent = "This card was not saved, so there is nothing to report against. Ask again first."; return; }
      if (typeof api.report !== "function") { msg.textContent = "Reporting is not available here."; return; }
      send.disabled = true; msg.textContent = "Saving…";
      Promise.resolve().then(function () { return api.report({ id: rid, note: String(note.value || "").trim() }); })
        .then(function (r) { msg.textContent = r && r.ok ? "Saved as a private draft test case. Thank you." : "Could not save the report. Try again."; send.disabled = !!(r && r.ok); })
        .catch(function () { msg.textContent = "Could not save the report. Try again."; send.disabled = false; });
    }

    // ── History item ──
    function openHistory(hid) {
      if (S.busy || typeof api.question !== "function") return;
      say(""); setBusy(true);
      Promise.resolve().then(function () { return api.question(hid); }).then(function (r) {
        var it = r && r.item; if (!it || !it.card) throw new Error("no card");
        if (!it.card.request_id) it.card.request_id = it.id;
        setBusy(false); show(it.card, it.question);
      }).catch(function () { setBusy(false); say("Could not open that question. Try again."); });
    }

    function copyRuling() {
      var t = el.result.querySelector('[data-role="ruling"]'); if (!t) return;
      var btn = el.result.querySelector('[data-act="copy-ruling"]');
      var done = function (ok) { if (btn) btn.textContent = ok ? "Copied" : "Select the text and copy it"; };
      try {
        if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) { global.navigator.clipboard.writeText(t.value).then(function () { done(true); }, function () { done(false); }); return; }
      } catch (e) { /* fall through */ }
      try { t.focus(); t.select(); done(!!doc.execCommand("copy")); } catch (e2) { done(false); }
    }

    // ── Events (delegated; handlers read data-* attributes only as indexes or ids and look the real value up in state) ──
    root.addEventListener("click", function (ev) {
      var t = ev.target && ev.target.closest ? ev.target.closest("[data-act]") : null;
      if (!t || !root.contains(t)) return;
      var act = t.getAttribute("data-act"), i;
      if (act === "fact") { openDrawer(t.getAttribute("data-fact"), t); return; }
      if (act === "close-drawer") { closeDrawer(); return; }
      if (act === "report") { openReport(); return; }
      if (act === "report-cancel") { var b = el.result.querySelector('[data-role="report"]'); if (b) b.hidden = true; return; }
      if (act === "report-send") { sendReport(); return; }
      if (act === "copy-ruling") { copyRuling(); return; }
      if (S.busy) return;
      if (act === "suggest") { i = Number(t.getAttribute("data-i")); if (suggestions[i]) { el.q.value = suggestions[i].q; ask(suggestions[i].q, asOfValue()); } return; }
      if (act === "followup") { i = Number(t.getAttribute("data-i")); var f = S.card && S.card.follow_ups && S.card.follow_ups[i]; if (typeof f === "string") { el.q.value = f; ask(f, S.lastAsk ? S.lastAsk.asOf : "current"); } return; }
      if (act === "expand") { i = Number(t.getAttribute("data-block")); var bl = S.card && S.card.blocks && S.card.blocks[i]; if (bl && typeof bl.expand_question === "string") { el.q.value = bl.expand_question; ask(bl.expand_question, S.lastAsk ? S.lastAsk.asOf : "current"); } return; }
      if (act === "retry") { if (S.lastAsk) ask(S.lastAsk.question, S.lastAsk.asOf); return; }
      if (act === "hist") { openHistory(t.getAttribute("data-id")); }
    });
    el.form.addEventListener("submit", function (ev) { ev.preventDefault(); ask(el.q.value, asOfValue()); });
    el.q.addEventListener("keydown", function (ev) { if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); ask(el.q.value, asOfValue()); } });
    el.asof.addEventListener("change", function () { el.date.hidden = el.asof.value !== "date"; say(""); });
    root.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && !el.drawer.hidden) { ev.preventDefault(); closeDrawer(); return; }
      trapTab(ev);
    });

    loadHistory();
    return { ask: function (text, asOf) { return ask(text, asOf || "current"); }, showCard: function (card, question) { show(card, question, false); }, history: loadHistory, state: S };
  }

  // ── Fixture api: the same interface as the live Worker, no network. Used by desk_preview.html and tests. ──
  var STOP = { the: 1, a: 1, an: 1, of: 1, to: 1, in: 1, is: 1, was: 1, for: 1, and: 1, or: 1, what: 1, who: 1, did: 1, does: 1, do: 1, my: 1, me: 1, it: 1, on: 1, at: 1, by: 1, with: 1, are: 1, be: 1, i: 1, how: 1 };
  function words(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9\s'-]/g, " ").split(/\s+/).filter(function (w) { return w && !STOP[w]; });
  }
  // Simple keyword scoring: shared distinct words (keywords count double). An exact question match wins outright.
  function matchQuestion(text, entries) {
    var qw = words(text), qset = {}, norm = qw.join(" ");
    qw.forEach(function (w) { qset[w] = 1; });
    var best = null, bestScore = 0;
    (entries || []).forEach(function (e) {
      var ew = words(e.question);
      if (ew.join(" ") === norm && norm) { best = e; bestScore = 1e6; return; }
      var seen = {}, score = 0;
      ew.forEach(function (w) { if (qset[w] && !seen[w]) { seen[w] = 1; score += 1; } });
      (e.keywords || []).forEach(function (k) { words(k).forEach(function (w) { if (qset[w] && !seen[w]) { seen[w] = 1; score += 2; } }); });
      if (score > bestScore) { best = e; bestScore = score; }
    });
    return bestScore >= 3 ? best : null;
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function makeFixtureApi(data, opts) {
    opts = opts || {};
    var delay = typeof opts.delayMs === "number" ? opts.delayMs : 1400;
    var entries = (data && data.questions) || [], cards = (data && data.cards) || {};
    var n = 0, store = [], reports = [];
    var fallbackName = (data && data.fallback) || "out_of_scope_preview";
    // Seed the history with a few older questions so the list is not empty.
    entries.filter(function (e) { return e.seed_history; }).slice(0, 6).forEach(function (e, i) {
      var cid = "demo-seed-" + (i + 1);
      store.push({ id: cid, created_at: "2026-11-1" + (9 - i) + "T1" + i + ":15:00Z", question: e.question, state: cards[e.card] ? cards[e.card].state : "answer", card: cards[e.card], seed: true });
    });
    function pause(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    return {
      ask: function (req, o) {
        var m = matchQuestion(req && req.question, entries);
        var card = clone(cards[m ? m.card : fallbackName] || cards[fallbackName]);
        n += 1; var rid = "demo-" + (1000 + n);
        card.request_id = rid;
        var p = o && typeof o.onProgress === "function" ? o.onProgress : function () {};
        var tools = (card.footer && card.footer.tools && card.footer.tools.length) || 0;
        return pause(delay * 0.3).then(function () { p({ step: "tools", tools: Math.min(1, tools) }); return pause(delay * 0.4); })
          .then(function () { p({ step: "tools", tools: tools }); return pause(delay * 0.3); })
          .then(function () {
            store.unshift({ id: rid, created_at: new Date().toISOString(), question: String(req.question), state: card.state, card: card });
            return { request_id: rid, card: card };
          });
      },
      history: function () { return Promise.resolve({ items: store.slice(0, 50).map(function (s) { return { id: s.id, created_at: s.created_at, question: s.question, state: s.state }; }) }); },
      question: function (id) {
        var s = store.filter(function (x) { return x.id === id; })[0];
        if (!s) return Promise.reject(new Error("not found"));
        return Promise.resolve({ item: { id: s.id, created_at: s.created_at, question: s.question, state: s.state, card: clone(s.card) } });
      },
      report: function (r) { reports.push(r); return Promise.resolve({ ok: true }); },
      status: function () { return Promise.resolve({ enabled: true, live_model_enabled: false, budget: { fixture: true } }); },
      _reports: reports
    };
  }

  global.UPSDesk = { mount: mount, makeFixtureApi: makeFixtureApi, matchQuestion: matchQuestion, errCard: errCard };
})(typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : this);
