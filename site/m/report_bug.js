/* report_bug.js -- the owner's "Report bug" sheet (test-only slice; NOT loaded by the mobile app yet).
 *
 * A signed-in owner reports a failed page to the commissioner. The sheet shows exactly what
 * will be sent before it is sent, explains every refusal (especially a failed MFL sign-in), and
 * keeps the owner's note on screen when something goes wrong.
 *
 *   UPSReportBug.install({ build })                       start remembering the last error (memory only)
 *   UPSReportBug.noteFailure({ message, endpoint, status })   a failed request the app already knows about
 *   UPSReportBug.open({ apiBase, leagueId, season, getUserId, screen, error?, build?, fetch? })
 *
 * Privacy rules this file keeps (the server enforces them again, see worker/src/bug_report_core.js):
 *   - nothing is stored in localStorage / sessionStorage / cookies; the error buffer lives in memory
 *   - request addresses are reduced to a path: no host, query string or fragment
 *   - no page text, no screenshots, no cookies, no passwords or keys
 *   - the owner's MFL sign-in goes in the request body (never the address) and is not shown or kept
 *
 * Styling uses the app's own CSS variables (--bg-elev, --fg, --line, --accent ...) with fallbacks,
 * so it follows whatever skin the host page defines.
 */
(function (root) {
  "use strict";

  var LIMITS = { summaryMax: 120, summaryMin: 3, noteMax: 1000, errMessageMax: 500, errNameMax: 60, endpointMax: 160 };
  var RECENT_ERROR_MS = 10 * 60 * 1000;
  var SEND_TIMEOUT_MS = 15000;

  // Same wording as the server (worker/src/bug_report_core.js MESSAGES). Used only when the
  // phone can tell without asking: no MFL sign-in on this device, or the network is unreachable.
  var LOCAL_MESSAGES = {
    unauthenticated: { state: "signin", title: "Sign in to MFL first", message: "We couldn't find your MFL sign-in, so we can't tell which team this is from. Open UPS from MFL, then tap Report bug again. Nothing was sent, and your note is still here." },
    network: { state: "retry", title: "Couldn't reach UPS", message: "Check your connection and try again. Nothing was sent, and your note is still here." },
  };

  // ------------------------------------------------------------------ pure helpers (unit-tested)

  function str(v) { return v == null ? "" : String(v); }
  function cap(s, n) { s = str(s); return s.length > n ? s.slice(0, n) : s; }
  function squeeze(s) { return str(s).replace(/\s+/g, " ").trim(); }
  function esc(s) { return str(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  /** A request address reduced to a bare path. "" when there is nothing safe to show. */
  function cleanEndpoint(input) {
    var s = str(input).trim();
    if (!s) return "";
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "");
    var cut = s.search(/[?#]/);
    if (cut !== -1) s = s.slice(0, cut);
    if (s.charAt(0) !== "/") return "";
    s = s.replace(/[^A-Za-z0-9/_\-.:%~]/g, "");
    s = s.split("/").map(function (seg) { return seg.length >= 24 && /[0-9]/.test(seg) && /[A-Za-z]/.test(seg) ? ":id" : seg; }).join("/");
    return s.slice(0, LIMITS.endpointMax);
  }

  /** Light client-side scrub so the preview shows what will be kept. The server does the authoritative pass. */
  function scrubText(input) {
    var s = str(input).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g, "");
    s = s.replace(/\bhttps?:\/\/[^\s"'<>)]+/gi, function (u) { var i = u.search(/[?#]/); return i === -1 ? u : u.slice(0, i); });
    s = s.replace(/\bBearer\s+[A-Za-z0-9._~+\/=-]{6,}/gi, "Bearer [removed]");
    s = s.replace(/\b(api[_-]?key|apikey|mfl[_-]?user[_-]?id|mfl[_-]?cookie|set-cookie|cookie|access[_-]?token|refresh[_-]?token|id[_-]?token|token|session(?:[_-]?id)?|passwd|password|secret|authorization|signature)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s&;,"']+)/gi, "$1$2[removed]");
    s = s.replace(/[A-Za-z0-9+\/_=-]{32,}/g, "[removed]");
    return s;
  }

  /** What was captured about the failure, in the shape the server accepts. null when nothing usable. */
  function normalizeError(e) {
    if (!e) return null;
    var out = {
      name: cap(squeeze(scrubText(e.name)), LIMITS.errNameMax),
      message: cap(squeeze(scrubText(e.message)), LIMITS.errMessageMax),
      endpoint: cleanEndpoint(e.endpoint),
      status: null,
    };
    var st = Math.round(Number(e.status));
    if (isFinite(st) && st >= 100 && st <= 599) out.status = st;
    if (!out.name && !out.message && !out.endpoint && out.status == null) return null;
    return out;
  }

  /** The exact JSON an owner submits (minus the MFL sign-in, which `buildPayload` adds last). */
  function buildPayload(ctx, form) {
    var p = {
      client_request_id: ctx.requestId,
      summary: cap(squeeze(form.summary), LIMITS.summaryMax),
      screen: cap(squeeze(ctx.screen), 80),
      build: cap(squeeze(ctx.build), 40),
      client_time: ctx.now,
      viewport: ctx.viewport,
      online: ctx.online,
    };
    var note = str(form.note).trim();
    if (note) p.note = cap(note, LIMITS.noteMax);
    var err = normalizeError(ctx.error);
    if (err) p.error = err;
    return p;
  }

  /** Rows for the "What we'll send" list. Same facts as the payload, in words. */
  function previewRows(ctx, form, locale) {
    var rows = [];
    rows.push(["Page", ctx.screen || "Unknown page"]);
    var when = ctx.now ? new Date(ctx.now) : null;
    rows.push(["When", when && !isNaN(when) ? when.toLocaleString(locale || undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Now"]);
    rows.push(["App version", ctx.build || "Unknown"]);
    rows.push(["Screen size", ctx.viewport ? ctx.viewport.w + " × " + ctx.viewport.h : "Unknown"]);
    rows.push(["Connection", ctx.online === false ? "Offline" : ctx.online === true ? "Online" : "Unknown"]);
    var err = normalizeError(ctx.error);
    if (err && (err.name || err.message)) rows.push(["Error message", [err.name, err.message].filter(Boolean).join(": ")]);
    else rows.push(["Error message", "No error message was captured"]);
    if (err && err.endpoint) rows.push(["Failed request", err.endpoint + (err.status != null ? " (HTTP " + err.status + ")" : "")]);
    rows.push(["Your team", "Taken from your MFL sign-in"]);
    return rows;
  }

  /** What the sheet does with a server answer. */
  function viewForResponse(status, json) {
    json = json && typeof json === "object" ? json : null;
    if (json && json.ok === true) {
      if (json.duplicate) return { kind: "duplicate", code: json.report && json.report.code, message: json.message, redactions: json.redactions || 0 };
      return { kind: "sent", code: json.report && json.report.code, replay: !!json.replay, redactions: json.redactions || 0 };
    }
    if (json && json.code && json.title && json.message) {
      return { kind: "blocked", state: json.state || "error", code: json.code, title: json.title, message: json.message, retryAfter: json.retry_after_seconds || 0, fields: json.fields || null };
    }
    return { kind: "blocked", state: "retry", code: "server_error", title: "Something went wrong on our side", message: "The report wasn't saved. Try again in a minute. Your note is still here.", retryAfter: 0 };
  }

  function humanWait(seconds) {
    seconds = Math.max(1, Math.round(seconds));
    if (seconds < 90) return seconds + " second" + (seconds === 1 ? "" : "s");
    var minutes = Math.round(seconds / 60);
    if (minutes < 90) return minutes + " minutes";
    var hours = Math.round(seconds / 3600);
    return "about " + hours + " hour" + (hours === 1 ? "" : "s");
  }

  /** Plain text the owner can paste to the commissioner when the report can't be sent. */
  function copyText(payload) {
    var lines = ["UPS bug report (not sent)", "Problem: " + payload.summary, "Page: " + payload.screen, "Time: " + payload.client_time, "App version: " + (payload.build || "unknown")];
    if (payload.viewport) lines.push("Screen: " + payload.viewport.w + " x " + payload.viewport.h);
    if (payload.error) {
      var e = payload.error;
      lines.push("Error: " + [e.name, e.message].filter(Boolean).join(": "));
      if (e.endpoint) lines.push("Request: " + e.endpoint + (e.status != null ? " (HTTP " + e.status + ")" : ""));
    }
    if (payload.note) lines.push("Notes: " + payload.note);
    return lines.join("\n");
  }

  function newRequestId() {
    try { if (root.crypto && root.crypto.randomUUID) return "r-" + root.crypto.randomUUID(); } catch (e) { /* fall through */ }
    return "r-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  // ------------------------------------------------------------------ error memory (never persisted)

  var recent = [];
  var installedBuild = "";
  var installed = false;

  function remember(e) {
    var n = normalizeError(e);
    if (!n) return;
    n.at = Date.now();
    recent.push(n);
    if (recent.length > 5) recent.shift();
  }
  function lastError() {
    for (var i = recent.length - 1; i >= 0; i--) {
      if (Date.now() - recent[i].at <= RECENT_ERROR_MS) return { name: recent[i].name, message: recent[i].message, endpoint: recent[i].endpoint, status: recent[i].status };
    }
    return null;
  }
  function install(opts) {
    installedBuild = cap(str(opts && opts.build), 40);
    if (installed || !root.addEventListener) return;
    installed = true;
    root.addEventListener("error", function (ev) {
      if (!ev || /ResizeObserver loop/i.test(str(ev.message))) return;
      remember({ name: (ev.error && ev.error.name) || "Error", message: ev.message || (ev.error && ev.error.message) });
    });
    root.addEventListener("unhandledrejection", function (ev) {
      var r = ev && ev.reason;
      remember({ name: (r && r.name) || "UnhandledRejection", message: (r && r.message) || str(r) });
    });
  }
  function noteFailure(e) { remember(e); }

  // ------------------------------------------------------------------ the sheet

  var CSS = [
    ".ups-rb-back{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.55);display:flex;align-items:flex-end;justify-content:center}",
    ".ups-rb{box-sizing:border-box;width:100%;max-width:560px;max-height:92vh;max-height:92dvh;overflow-y:auto;overscroll-behavior:contain;background:var(--bg-elev,#141a26);color:var(--fg,#e8edf5);border:1px solid var(--line,#2a3446);border-bottom:0;border-radius:16px 16px 0 0;padding:16px 16px calc(16px + env(safe-area-inset-bottom,0px));font:14px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}",
    ".ups-rb *{box-sizing:border-box}",
    ".ups-rb h2{margin:0 0 4px;font-size:18px;font-weight:700;line-height:1.25;text-transform:none;letter-spacing:normal;color:inherit}",
    ".ups-rb .sub{margin:0 0 12px;color:var(--fg-muted,#8a97ad)}",
    ".ups-rb label{display:block;margin:12px 0 4px;font-weight:600}",
    ".ups-rb .opt{font-weight:400;color:var(--fg-muted,#8a97ad)}",
    ".ups-rb input,.ups-rb textarea{width:100%;min-height:44px;padding:10px 12px;font:inherit;font-size:16px;color:var(--fg,#e8edf5);background:var(--bg,#0e1320);border:2px solid var(--line-soft,#3a455c);border-radius:10px}",
    ".ups-rb textarea{min-height:88px;resize:vertical}",
    ".ups-rb input:focus,.ups-rb textarea:focus,.ups-rb button:focus-visible{outline:3px solid var(--accent,#5b8dff);outline-offset:2px}",
    ".ups-rb .count{margin-top:2px;text-align:right;font-size:12px;color:var(--fg-muted,#8a97ad)}",
    ".ups-rb .box{margin-top:12px;padding:10px 12px;border:1px solid var(--line,#2a3446);border-radius:10px;background:var(--bg,#0e1320)}",
    ".ups-rb .box h3{margin:0 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--fg-muted,#8a97ad)}",
    ".ups-rb dl{margin:0}",
    ".ups-rb dt{margin-top:6px;font-size:12px;color:var(--fg-muted,#8a97ad)}",
    ".ups-rb dd{margin:0;overflow-wrap:anywhere}",
    ".ups-rb ul.no{margin:0;padding-left:18px}",
    ".ups-rb .row{display:flex;gap:8px;margin-top:14px}",
    ".ups-rb .row>button{flex:1}",
    ".ups-rb button{min-height:44px;padding:10px 14px;font:inherit;font-weight:600;color:var(--fg,#e8edf5);background:transparent;border:2px solid var(--line-soft,#3a455c);border-radius:10px;cursor:pointer}",
    ".ups-rb button.pri{background:var(--accent,#5b8dff);border-color:var(--accent,#5b8dff);color:var(--on-accent,#06101f)}",
    ".ups-rb button[disabled]{opacity:.55;cursor:not-allowed}",
    ".ups-rb .alert{display:flex;gap:10px;margin:0 0 12px;padding:12px;border:2px solid var(--warn,#ffb86b);border-radius:12px;background:var(--bg,#0e1320)}",
    ".ups-rb .alert .ic{flex:0 0 auto;width:24px;height:24px;font-weight:700;text-align:center;line-height:24px;border:2px solid var(--warn,#ffb86b);border-radius:50%}",
    ".ups-rb .alert b{display:block;margin-bottom:2px}",
    ".ups-rb .alert.signin{border-color:var(--danger,#ff6b6b)}.ups-rb .alert.signin .ic{border-color:var(--danger,#ff6b6b)}",
    ".ups-rb .alert.limit{border-color:var(--accent,#5b8dff)}.ups-rb .alert.limit .ic{border-color:var(--accent,#5b8dff)}",
    ".ups-rb .done{text-align:center;padding:8px 0 0}",
    ".ups-rb .done .big{display:inline-block;width:48px;height:48px;line-height:44px;font-size:26px;border:3px solid var(--ok,#8be58b);border-radius:50%;color:var(--ok,#8be58b)}",
    ".ups-rb .done .code{display:inline-block;margin:8px 0;padding:4px 10px;font:600 15px ui-monospace,Menlo,monospace;border:1px solid var(--line,#2a3446);border-radius:8px}",
    ".ups-rb .err{margin-top:4px;color:var(--danger,#ff6b6b);font-size:13px}",
    ".ups-rb .sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}",
    "@media (prefers-reduced-motion:no-preference){.ups-rb{animation:ups-rb-up .18s ease-out}@keyframes ups-rb-up{from{transform:translateY(24px);opacity:.6}to{transform:none;opacity:1}}}",
  ].join("\n");

  function ensureCss(doc) {
    if (doc.getElementById("ups-report-bug-css")) return;
    var st = doc.createElement("style");
    st.id = "ups-report-bug-css";
    st.textContent = CSS;
    doc.head.appendChild(st);
  }

  function open(opts) {
    var doc = root.document;
    if (!doc) return null;
    ensureCss(doc);
    var prior = doc.activeElement;
    var ctx = {
      requestId: newRequestId(),
      screen: cap(squeeze(opts.screen), 80),
      build: cap(str(opts.build || installedBuild), 40),
      now: new Date().toISOString(),
      viewport: { w: Math.round(root.innerWidth || 0), h: Math.round(root.innerHeight || 0) },
      online: typeof root.navigator !== "undefined" && typeof root.navigator.onLine === "boolean" ? root.navigator.onLine : null,
      error: opts.error || lastError(),
    };
    var form = { summary: str(opts.summary), note: "" };
    var view = { mode: "compose", banner: null, fieldError: "" };
    var sending = false;

    var back = doc.createElement("div");
    back.className = "ups-rb-back";
    var sheet = doc.createElement("div");
    sheet.className = "ups-rb";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-labelledby", "ups-rb-title");
    back.appendChild(sheet);
    doc.body.appendChild(back);

    function close() {
      back.remove();
      doc.removeEventListener("keydown", onKey, true);
      if (prior && prior.focus) try { prior.focus(); } catch (e) { /* ignore */ }
      if (opts.onClose) opts.onClose();
    }
    function onKey(ev) { if (ev.key === "Escape") { ev.stopPropagation(); close(); } }
    doc.addEventListener("keydown", onKey, true);
    back.addEventListener("click", function (ev) { if (ev.target === back) close(); });

    function payloadNow() { return buildPayload(ctx, form); }
    function canSend() { return squeeze(form.summary).length >= LIMITS.summaryMin && !sending && !(view.banner && view.banner.state === "off"); }

    function draw(focusSel) {
      var h = "";
      if (view.mode === "sent" || view.mode === "duplicate") {
        var d = view.result;
        h += '<div class="done" role="status"><span class="big" aria-hidden="true">✓</span>';
        h += '<h2 id="ups-rb-title">' + (view.mode === "duplicate" ? "Already reported" : "Report sent") + "</h2>";
        h += '<div class="code">' + esc(d.code || "") + "</div>";
        h += '<p class="sub">' + (view.mode === "duplicate" ? esc(d.message || "") : "The commissioner will see it. Only you and the commissioner can read it.") + "</p>";
        if (d.redactions) h += '<p class="sub">We removed ' + d.redactions + " item" + (d.redactions === 1 ? "" : "s") + " that looked like a password, key or address detail before saving.</p>";
        h += '<div class="row"><button class="pri" data-act="close">Done</button></div></div>';
        sheet.innerHTML = h;
        focusFirst("[data-act=close]");
        return;
      }
      h += '<h2 id="ups-rb-title">Report a problem</h2>';
      h += '<p class="sub">Goes to the commissioner. Other members can’t see it.</p>';
      if (view.banner) {
        var b = view.banner;
        h += '<div class="alert ' + esc(b.state) + '" role="alert"><span class="ic" aria-hidden="true">' + (b.state === "signin" ? "!" : b.state === "limit" ? "i" : "!") + '</span><div><b>' + esc(b.title) + "</b>" + esc(b.message) +
          (b.retryAfter ? " You can send another in " + esc(humanWait(b.retryAfter)) + "." : "") + "</div></div>";
      }
      h += '<label for="ups-rb-sum">What went wrong?</label>';
      h += '<input id="ups-rb-sum" type="text" maxlength="' + LIMITS.summaryMax + '" autocomplete="off" placeholder="e.g. Waiver window won’t load" value="' + esc(form.summary) + '"' + (view.fieldError ? ' aria-describedby="ups-rb-sum-err" aria-invalid="true"' : "") + ">";
      if (view.fieldError) h += '<div class="err" id="ups-rb-sum-err">' + esc(view.fieldError) + "</div>";
      h += '<label for="ups-rb-note">What were you doing? <span class="opt">(optional)</span></label>';
      h += '<textarea id="ups-rb-note" maxlength="' + LIMITS.noteMax + '" placeholder="Anything that helps us find it">' + esc(form.note) + "</textarea>";
      h += '<div class="count" id="ups-rb-count">' + form.note.length + " / " + LIMITS.noteMax + "</div>";
      h += '<div class="box"><h3>What we’ll send</h3><dl>';
      previewRows(ctx, form).forEach(function (r) { h += "<dt>" + esc(r[0]) + "</dt><dd>" + esc(r[1]) + "</dd>"; });
      h += "</dl></div>";
      h += '<div class="box"><h3>Never sent</h3><ul class="no"><li>Passwords, keys or cookies</li><li>Web addresses beyond the page path</li><li>What’s on your screen, or a screenshot</li></ul></div>';
      h += '<div class="box"><h3>Who can see it</h3>You and the commissioner. Not other members, not Discord, not public.</div>';
      var label = sending ? "Sending…" : view.banner && view.banner.state !== "limit" ? "Try again" : "Send report";
      h += '<div class="row"><button data-act="close">Cancel</button>';
      if (view.banner && (view.banner.state === "signin" || view.banner.state === "retry")) h += '<button data-act="copy">Copy details</button>';
      h += '<button class="pri" data-act="send"' + (canSend() ? "" : " disabled") + ">" + label + "</button></div>";
      h += '<div class="sr" aria-live="polite" id="ups-rb-live"></div>';
      sheet.innerHTML = h;
      if (focusSel) focusFirst(focusSel);
    }
    function focusFirst(sel) { var el = sheet.querySelector(sel); if (el && el.focus) try { el.focus(); } catch (e) { /* ignore */ } }
    function live(msg) { var el = sheet.querySelector("#ups-rb-live"); if (el) el.textContent = msg; }

    function setSendEnabled() { var b = sheet.querySelector("[data-act=send]"); if (b) b.disabled = !canSend(); }

    sheet.addEventListener("input", function (ev) {
      if (ev.target.id === "ups-rb-sum") { form.summary = ev.target.value; setSendEnabled(); }
      if (ev.target.id === "ups-rb-note") { form.note = ev.target.value; var c = sheet.querySelector("#ups-rb-count"); if (c) c.textContent = form.note.length + " / " + LIMITS.noteMax; }
    });

    sheet.addEventListener("click", function (ev) {
      var btn = ev.target.closest ? ev.target.closest("[data-act]") : null;
      if (!btn || btn.disabled) return;
      var act = btn.getAttribute("data-act");
      if (act === "close") close();
      else if (act === "send") send();
      else if (act === "copy") copy(btn);
    });

    function copy(btn) {
      var text = copyText(payloadNow());
      var done = function () { btn.textContent = "Copied"; live("Details copied"); };
      try {
        if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) {
          root.navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
          return;
        }
      } catch (e) { /* fall through */ }
      fallbackCopy(text); done();
    }
    function fallbackCopy(text) {
      var ta = doc.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
      doc.body.appendChild(ta); ta.select();
      try { doc.execCommand("copy"); } catch (e) { /* ignore */ }
      ta.remove();
    }

    function block(v) {
      view.banner = { state: v.state, title: v.title, message: v.message, retryAfter: v.retryAfter };
      view.fieldError = v.code === "summary_required" ? v.message : "";
      sending = false;
      draw(v.state === "fix" ? "#ups-rb-sum" : "[data-act=send]");
      live(v.title + ". " + v.message);
    }

    function send() {
      if (!canSend()) return;
      var userId = str(opts.getUserId && opts.getUserId()).trim();
      if (!userId) { block({ state: LOCAL_MESSAGES.unauthenticated.state, code: "unauthenticated", title: LOCAL_MESSAGES.unauthenticated.title, message: LOCAL_MESSAGES.unauthenticated.message, retryAfter: 0 }); return; }
      sending = true; view.banner = null; view.fieldError = "";
      draw(); live("Sending");
      var body = payloadNow();
      body.mfl_user_id = userId;
      var q = "?L=" + encodeURIComponent(opts.leagueId || "74598") + "&YEAR=" + encodeURIComponent(opts.season || String(new Date().getFullYear()));
      var f = opts.fetch || (root.fetch && root.fetch.bind(root));
      var ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
      var timer = ctl ? setTimeout(function () { ctl.abort(); }, SEND_TIMEOUT_MS) : null;
      Promise.resolve().then(function () {
        return f(str(opts.apiBase).replace(/\/+$/, "") + "/api/bug-reports" + q, {
          method: "POST", credentials: "omit", cache: "no-store",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctl ? ctl.signal : undefined,
        });
      }).then(function (res) {
        return res.text().then(function (t) { var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { j = null; } return { status: res.status, json: j }; });
      }).then(function (r) {
        if (timer) clearTimeout(timer);
        var v = viewForResponse(r.status, r.json);
        if (v.kind === "sent" || v.kind === "duplicate") { sending = false; view.mode = v.kind; view.result = v; draw(); return; }
        block(v);
      }, function () {
        if (timer) clearTimeout(timer);
        block({ state: LOCAL_MESSAGES.network.state, code: "network", title: LOCAL_MESSAGES.network.title, message: LOCAL_MESSAGES.network.message, retryAfter: 0 });
      });
    }

    draw("#ups-rb-sum");
    return { close: close, element: sheet, context: ctx };
  }

  var api = {
    install: install, noteFailure: noteFailure, open: open, lastError: lastError,
    // pure parts (unit tests, preview)
    cleanEndpoint: cleanEndpoint, scrubText: scrubText, normalizeError: normalizeError, buildPayload: buildPayload,
    previewRows: previewRows, viewForResponse: viewForResponse, humanWait: humanWait, copyText: copyText,
    LIMITS: LIMITS, LOCAL_MESSAGES: LOCAL_MESSAGES,
  };
  root.UPSReportBug = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : this);
