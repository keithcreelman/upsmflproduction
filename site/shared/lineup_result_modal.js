/* lineup_result_modal.js — the big "Lineup submitted" / "Lineup NOT submitted" pop-up (phone app and Game Day).
   Keith 2026-11-13: a lineup result must be impossible to miss, say why it failed, and need an OK.
   - Success (green check) or failure (red cross) with the reason in plain words and, for a failure, what to do.
   - One OK button; it is focused, so Enter or Space closes it. Escape closes it too. A tap on the dimmed background does NOT:
     the owner has to acknowledge it.
   - Phone app: a fixed overlay over the screen. Game Day (opts.anchor): the page lives in an iframe grown to full height, so a fixed
     overlay would sit off-screen; the dialog is placed beside the Submit button and scrolled into view instead.
   Self-contained: its CSS is added once, so no page edits its own stylesheet.
   show({ ok, title, body, reason, hint, anchor }) -> { close() }.  onClose runs after OK. */
(function (global) {
  "use strict";
  var STYLE_ID = "ups-lineup-result-style";
  var CSS = [
    ".ups-lrm-back{position:fixed;inset:0;z-index:2147483000;background:rgba(5,9,18,.72);display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}",
    ".ups-lrm-back.anchored{position:absolute;left:0;right:0;top:0;bottom:0;align-items:flex-start;z-index:2147483000}",
    ".ups-lrm{box-sizing:border-box;width:min(100%,480px);background:#101a2e;color:#eef3ff;border:2px solid #2f9e6f;border-radius:18px;padding:28px 24px 22px;text-align:center;box-shadow:0 18px 60px rgba(0,0,0,.6);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}",
    ".ups-lrm.err{border-color:#e5484d}",
    ".ups-lrm.anchored{position:absolute;left:50%;transform:translateX(-50%);margin:0}",
    ".ups-lrm-ic{width:76px;height:76px;margin:0 auto 12px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:46px;font-weight:800;line-height:1;background:#1f7a55;color:#fff}",
    ".ups-lrm.err .ups-lrm-ic{background:#c93a3f}",
    ".ups-lrm h2{margin:0 0 8px;font-size:26px;line-height:1.2;font-weight:800;color:#fff}",
    ".ups-lrm p{margin:0 0 10px;font-size:17px;line-height:1.45}",
    ".ups-lrm .reason{margin:6px 0 10px;padding:12px 14px;border-radius:10px;background:rgba(229,72,77,.14);border:1px solid rgba(229,72,77,.5);font-size:16px;font-weight:600;text-align:left;overflow-wrap:anywhere}",
    ".ups-lrm.ok .reason{background:rgba(47,158,111,.14);border-color:rgba(47,158,111,.5)}",
    ".ups-lrm .hint{margin:0 0 14px;font-size:15px;color:#b9c7e4}",
    ".ups-lrm button{display:block;width:100%;min-height:54px;margin-top:8px;border:0;border-radius:12px;background:#2f9e6f;color:#fff;font-size:20px;font-weight:800;cursor:pointer}",
    ".ups-lrm.err button{background:#e5484d}",
    ".ups-lrm button:focus-visible{outline:3px solid #fff;outline-offset:2px}"
  ].join("\n");

  var open = null;

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  function close() {
    if (!open) return;
    var o = open; open = null;
    try { document.removeEventListener("keydown", o.onKey, true); } catch (e) {}
    try { if (o.back.parentNode) o.back.parentNode.removeChild(o.back); } catch (e) {}
    if (o.onClose) { try { o.onClose(); } catch (e) {} }
  }

  function show(opts) {
    opts = opts || {};
    close();
    if (!document.getElementById(STYLE_ID)) {
      var st = document.createElement("style"); st.id = STYLE_ID; st.textContent = CSS; (document.head || document.body).appendChild(st);
    }
    var ok = !!opts.ok, anchor = opts.anchor || null;
    var back = document.createElement("div");
    back.className = "ups-lrm-back" + (anchor ? " anchored" : "");
    back.innerHTML =
      '<div class="ups-lrm ' + (ok ? "ok" : "err") + (anchor ? " anchored" : "") + '" role="alertdialog" aria-modal="true" aria-labelledby="ups-lrm-title" aria-describedby="ups-lrm-body">' +
        '<div class="ups-lrm-ic" aria-hidden="true">' + (ok ? "✓" : "✕") + '</div>' +
        '<h2 id="ups-lrm-title">' + esc(opts.title || (ok ? "Lineup submitted" : "Lineup NOT submitted")) + '</h2>' +
        '<p id="ups-lrm-body">' + esc(opts.body || "") + '</p>' +
        (opts.reason ? '<div class="reason"><span class="sr">' + (ok ? "" : "Why: ") + '</span>' + esc(opts.reason) + '</div>' : "") +
        (opts.hint ? '<div class="hint">' + esc(opts.hint) + '</div>' : "") +
        '<button type="button" class="ups-lrm-ok">OK</button>' +
      '</div>';
    document.body.appendChild(back);
    var dlg = back.querySelector(".ups-lrm");
    if (anchor) {
      var scrollY = global.scrollY || global.pageYOffset || 0;
      var top = anchor.getBoundingClientRect().top + scrollY;
      var above = Math.round(top - dlg.offsetHeight - 12);
      var y = above >= 8 ? above : Math.round(top + (anchor.offsetHeight || 0) + 12);
      dlg.style.top = Math.max(8, y) + "px";
    }
    var okBtn = back.querySelector(".ups-lrm-ok");
    function onKey(e) { if (e.key === "Escape" || e.key === "Esc") { e.preventDefault(); close(); } }
    open = { back: back, onKey: onKey, onClose: opts.onClose };
    okBtn.addEventListener("click", close);
    document.addEventListener("keydown", onKey, true);
    try { okBtn.focus(); } catch (e) {}
    if (anchor) { try { dlg.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) { try { dlg.scrollIntoView(); } catch (e2) {} } }
    return { close: close };
  }

  // What the worker / MFL said, in plain words (the raw text is always kept as the reason).
  function explain(raw) {
    var t = String(raw == null ? "" : raw).trim();
    if (/bye week/i.test(t)) return { reason: t, hint: "Bench the player on a bye and submit again." };
    if (/HTTP 401|HTTP 403|not logged|log in|login|unauthor|forbidden|MFL_USER_ID/i.test(t)) return { reason: t, hint: "Sign in to MFL again, then submit." };
    if (/locked|kickoff|already started|substitut/i.test(t)) return { reason: t, hint: "A player whose game has started can't be moved. Change the others and submit again." };
    return { reason: t || "MFL did not say why.", hint: "Your lineup on MFL is unchanged. Fix the issue and submit again." };
  }

  var api = { show: show, close: close, explain: explain };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.UPS_LINEUP_RESULT_MODAL = api;
})(typeof window !== "undefined" ? window : this);
