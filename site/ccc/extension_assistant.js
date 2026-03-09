/* ============================================================
   UPS Extension Assistant — Natural Language Chat
   v2.0 — Replaces the static FAQ panel.

   - Slide-in chat drawer (right side)
   - Live player data from mym_dashboard.json
   - AI answers via the UPS Cloudflare Worker (/extension-assistant)
   - window.openExtensionAssistant() exposed globally for Hot Links button
   - Auto-opens when ?ext=chat is in the URL
   ============================================================ */
(function () {
  "use strict";

  /* ── Config ──────────────────────────────────────────────── */
  var PANEL_ID    = "extAssistPanel";
  var WORKER_URL  = "https://upsmflproduction.keith-creelman.workers.dev/extension-assistant";
  var DATA_URL    = "https://keithcreelman.github.io/upsmflproduction/site/ccc/mym_dashboard.json";

  var STARTERS = [
    "How do I extend a player?",
    "Who on my team can I extend?",
    "Why is this player not eligible?",
    "What does AAV mean?",
    "Where do I confirm my extension submitted?",
    "What does TCV mean?",
  ];

  /* ── State ───────────────────────────────────────────────── */
  var state = {
    messages:  [],    // { role: "user"|"bot"|"system", text: "..." }
    context:   "",    // built from mym_dashboard data
    loading:   false,
    dataReady: false,
    startersShown: true,
  };

  /* ── Panel HTML ──────────────────────────────────────────── */
  var PANEL_HTML = [
    '<div id="' + PANEL_ID + '" class="ext-chat-panel" aria-hidden="true" role="dialog"',
         ' aria-labelledby="extChatTitle">',

      '<div class="ext-chat-overlay" id="extChatOverlay"></div>',

      '<div class="ext-chat-drawer">',

        /* Head */
        '<div class="ext-chat-head">',
          '<div class="ext-chat-identity">',
            '<div class="ext-chat-avatar" aria-hidden="true">&#x26A1;</div>',
            '<div>',
              '<div id="extChatTitle" class="ext-chat-title">Extension Assistant</div>',
              '<div class="ext-chat-sub">UPS Dynasty League &middot; Extensions only</div>',
            '</div>',
          '</div>',
          '<button class="ext-chat-close" id="extChatClose" type="button"',
                  ' aria-label="Close Extension Assistant">&#x2715;</button>',
        '</div>',

        /* Messages */
        '<div class="ext-chat-messages" id="extChatMessages">',
          /* Populated by JS */
        '</div>',

        /* Input area */
        '<div class="ext-chat-input-area">',
          '<div class="ext-chat-starters" id="extChatStarters">',
            /* Starter chips populated by JS */
          '</div>',
          '<div class="ext-chat-input-row">',
            '<textarea class="ext-chat-input" id="extChatInput"',
                      ' placeholder="Ask about extensions&#x2026;" rows="1"',
                      ' aria-label="Extension question"></textarea>',
            '<button class="ext-chat-send" id="extChatSend" type="button"',
                    ' aria-label="Send question">',
              '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="18" height="18">',
                '<path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z"/>',
              '</svg>',
            '</button>',
          '</div>',
          '<div class="ext-chat-disclaimer">',
            'Extension-scope only &middot; UPS Dynasty League',
          '</div>',
        '</div>',

      '</div>',/* /.ext-chat-drawer */
    '</div>'  /* /#extAssistPanel */
  ].join("");

  /* ── DOM helpers ─────────────────────────────────────────── */
  function qs(sel, root) { return (root || document).querySelector(sel); }

  function setLoading(on) {
    state.loading = on;
    var inp  = qs("#extChatInput");
    var btn  = qs("#extChatSend");
    if (inp) inp.disabled = on;
    if (btn) btn.disabled = on;
  }

  /* ── Render helpers ──────────────────────────────────────── */
  function formatBotText(text) {
    /* Convert **bold** and line breaks for display */
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\n/g, "<br>");
  }

  function appendMessage(role, text) {
    state.messages.push({ role: role, text: text });
    renderMessages();
  }

  function renderMessages() {
    var container = qs("#extChatMessages");
    if (!container) return;

    /* Hide starters once user has sent a message */
    if (state.messages.some(function(m) { return m.role === "user"; })) {
      state.startersShown = false;
      var starters = qs("#extChatStarters");
      if (starters) starters.style.display = "none";
    }

    /* Build message HTML */
    var html = "";

    if (state.messages.length === 0) {
      html = [
        '<div class="ext-chat-welcome">',
          '<div class="ext-chat-welcome-icon" aria-hidden="true">&#x26A1;</div>',
          '<div class="ext-chat-welcome-text">',
            '<strong>Extension Assistant</strong><br>',
            'Ask me anything about extending players in the UPS Dynasty League.',
          '</div>',
        '</div>'
      ].join("");
    }

    state.messages.forEach(function (msg) {
      if (msg.role === "user") {
        html += [
          '<div class="ext-msg ext-msg-user">',
            '<div class="ext-msg-bubble">' + escHtml(msg.text) + '</div>',
          '</div>'
        ].join("");
      } else if (msg.role === "bot") {
        html += [
          '<div class="ext-msg ext-msg-bot">',
            '<div class="ext-msg-avatar" aria-hidden="true">&#x26A1;</div>',
            '<div class="ext-msg-bubble">' + formatBotText(msg.text) + '</div>',
          '</div>'
        ].join("");
      } else if (msg.role === "error") {
        html += [
          '<div class="ext-msg ext-msg-error">',
            '<div class="ext-msg-bubble">' + escHtml(msg.text) + '</div>',
          '</div>'
        ].join("");
      }
    });

    if (state.loading) {
      html += [
        '<div class="ext-msg ext-msg-bot ext-msg-loading">',
          '<div class="ext-msg-avatar" aria-hidden="true">&#x26A1;</div>',
          '<div class="ext-msg-bubble">',
            '<span class="ext-typing-dot"></span>',
            '<span class="ext-typing-dot"></span>',
            '<span class="ext-typing-dot"></span>',
          '</div>',
        '</div>'
      ].join("");
    }

    container.innerHTML = html;
    container.scrollTop = container.scrollHeight;
  }

  function renderStarters() {
    var container = qs("#extChatStarters");
    if (!container) return;
    var html = STARTERS.map(function (s) {
      return '<button class="ext-starter-chip" type="button">' + escHtml(s) + '</button>';
    }).join("");
    container.innerHTML = html;

    container.querySelectorAll(".ext-starter-chip").forEach(function (chip) {
      chip.addEventListener("click", function () {
        sendMessage(this.textContent.trim());
      });
    });
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* ── Data layer ──────────────────────────────────────────── */
  function fetchPlayerContext() {
    var bust = "?t=" + Math.floor(Date.now() / 60000); /* 1-min buckets */
    fetch(DATA_URL + bust, { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return;
        state.context = buildContext(data);
        state.dataReady = true;
      })
      .catch(function () { /* context stays empty — bot still works */ });
  }

  function buildContext(data) {
    var eligibility = data.eligibility || [];

    /* Group all players by franchise */
    var byFranchise = {};
    eligibility.forEach(function (p) {
      if (!byFranchise[p.franchise_id]) {
        byFranchise[p.franchise_id] = { name: p.franchise_name, eligible: [], count: 0 };
      }
      byFranchise[p.franchise_id].count++;
      if (p.extension_eligible) {
        byFranchise[p.franchise_id].eligible.push(p);
      }
    });

    var lines = [];

    /* Extension-eligible players by team */
    var teamsWithEligible = Object.keys(byFranchise)
      .filter(function (id) { return byFranchise[id].eligible.length > 0; })
      .sort();

    if (teamsWithEligible.length === 0) {
      lines.push("EXTENSION ELIGIBLE PLAYERS: None currently eligible.");
    } else {
      lines.push("EXTENSION ELIGIBLE PLAYERS:");
      teamsWithEligible.forEach(function (id) {
        var f = byFranchise[id];
        lines.push("\n" + f.name + " (ID: " + id + "):");
        f.eligible.forEach(function (p) {
          var sal = "$" + (p.salary / 1000).toFixed(0) + "K";
          var info = (p.contract_info || "").replace(/\s*\|\s*/g, " | ");
          lines.push("  \u2713 " + p.player_name + " | " + p.position + " | " + sal + " | " + info);
        });
      });
    }

    /* Teams with no eligible players */
    var noEligible = Object.keys(byFranchise)
      .filter(function (id) { return byFranchise[id].eligible.length === 0; })
      .map(function (id) { return byFranchise[id].name; })
      .sort();
    if (noEligible.length > 0) {
      lines.push("\nTEAMS WITH NO ELIGIBLE PLAYERS: " + noEligible.join(", "));
    }

    var ts = (data.meta && data.meta.extension_overlay_refreshed_at_utc)
      ? data.meta.extension_overlay_refreshed_at_utc.slice(0, 10)
      : "unknown";
    lines.push("\nData refreshed: " + ts);

    return lines.join("\n").slice(0, 3500);
  }

  /* ── API call ────────────────────────────────────────────── */
  function sendMessage(text) {
    if (state.loading) return;
    text = text.trim();
    if (!text) return;

    /* Clear input */
    var inp = qs("#extChatInput");
    if (inp) { inp.value = ""; inp.style.height = ""; }

    appendMessage("user", text);
    setLoading(true);
    renderMessages();

    fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: text,
        context:  state.context,
      }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        setLoading(false);
        if (data.ok && data.answer) {
          appendMessage("bot", data.answer);
        } else {
          appendMessage("error", data.error || "Something went wrong. Please try again.");
        }
      })
      .catch(function () {
        setLoading(false);
        appendMessage("error", "Could not reach the assistant. Check your connection and try again.");
      });
  }

  /* ── Open / Close ────────────────────────────────────────── */
  function openPanel() {
    var panel = qs("#" + PANEL_ID);
    if (!panel) return;
    panel.classList.add("is-open");
    panel.setAttribute("aria-hidden", "false");
    document.body.classList.add("ext-chat-open");

    /* Focus the input */
    var inp = qs("#extChatInput");
    if (inp) setTimeout(function () { inp.focus(); }, 120);

    /* Fetch data lazily on first open */
    if (!state.dataReady && !state._fetching) {
      state._fetching = true;
      fetchPlayerContext();
    }

    renderMessages();
  }

  function closePanel() {
    var panel = qs("#" + PANEL_ID);
    if (!panel) return;
    panel.classList.remove("is-open");
    panel.setAttribute("aria-hidden", "true");
    document.body.classList.remove("ext-chat-open");
  }

  /* ── Init ────────────────────────────────────────────────── */
  function init() {
    /* Inject into #cccApp for CSS variable inheritance (theme support),
       falling back to document.body if CCC is not present */
    var host = qs("#cccApp") || document.body;
    host.insertAdjacentHTML("beforeend", PANEL_HTML);

    /* Wire overlay + close button */
    qs("#extChatOverlay").addEventListener("click", closePanel);
    qs("#extChatClose").addEventListener("click", closePanel);

    /* Escape key */
    document.addEventListener("keydown", function (e) {
      var panel = qs("#" + PANEL_ID);
      if (e.key === "Escape" && panel && panel.classList.contains("is-open")) {
        closePanel();
      }
    });

    /* Send on button click */
    qs("#extChatSend").addEventListener("click", function () {
      sendMessage(qs("#extChatInput").value);
    });

    /* Send on Enter (Shift+Enter = newline) */
    qs("#extChatInput").addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage(this.value);
      }
    });

    /* Auto-grow textarea */
    qs("#extChatInput").addEventListener("input", function () {
      this.style.height = "auto";
      this.style.height = Math.min(this.scrollHeight, 120) + "px";
    });

    renderStarters();
    renderMessages();

    /* Auto-open if URL contains ?ext=chat */
    if (new URLSearchParams(window.location.search).get("ext") === "chat") {
      openPanel();
    }
  }

  /* ── Global API ──────────────────────────────────────────── */
  window.openExtensionAssistant  = openPanel;
  window.closeExtensionAssistant = closePanel;

  /* ── Boot ────────────────────────────────────────────────── */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
