/* ============================================================
   UPS Extension Assistant — MVP Help Panel
   Self-contained IIFE. No dependencies on ccc.js.
   Injects a Help button into the CCC hero and opens a
   tabbed help panel covering: How To, Terms, Warnings, FAQ.
   ============================================================ */
(function () {
  "use strict";

  var MODAL_ID   = "extHelpModal";
  var TRIGGER_ID = "extHelpTrigger";

  /* ── Modal HTML ─────────────────────────────────────────── */
  var MODAL_HTML = [
    '<div id="' + MODAL_ID + '" class="ccc-modal" aria-hidden="true">',
      '<div class="ccc-modal-backdrop" id="extHelpBackdrop"></div>',

      '<div class="ccc-modal-card ext-help-card"',
           ' role="dialog" aria-modal="true"',
           ' aria-labelledby="extHelpTitle">',

        /* ── Head ── */
        '<div class="ccc-modal-head">',
          '<div>',
            '<div id="extHelpTitle" class="ccc-modal-title">Extension Assistant</div>',
            '<div class="ccc-modal-sub muted">How to extend a player — step by step</div>',
          '</div>',
          '<button class="ccc-modal-x" id="extHelpClose" type="button"',
                  ' aria-label="Close help panel">&#x2715;</button>',
        '</div>',

        /* ── Tab row ── */
        '<div class="ext-help-tabs" role="tablist">',
          '<button class="ext-help-tab is-active" type="button"',
                  ' data-panel="howto" role="tab" aria-selected="true">How To</button>',
          '<button class="ext-help-tab" type="button"',
                  ' data-panel="terms" role="tab" aria-selected="false">Terms</button>',
          '<button class="ext-help-tab" type="button"',
                  ' data-panel="warnings" role="tab" aria-selected="false">Warnings</button>',
          '<button class="ext-help-tab" type="button"',
                  ' data-panel="faq" role="tab" aria-selected="false">FAQ</button>',
        '</div>',

        /* ── Scrollable body ── */
        '<div class="ext-help-body">',

          /* ┌── HOW TO ──────────────────────────────────── */
          '<div class="ext-help-panel is-active" id="extHelpHowto">',
            '<p class="ext-help-intro">Follow these steps to extend a player.',
              ' The whole process takes about two minutes.</p>',
            '<ol class="ext-help-steps">',

              '<li>',
                '<span class="ext-step-num">1</span>',
                '<div>',
                  '<strong>Open Contract Command Center</strong>',
                  '<p>Find it in the league navigation menu.</p>',
                '</div>',
              '</li>',

              '<li>',
                '<span class="ext-step-num">2</span>',
                '<div>',
                  '<strong>Select Extend Player</strong>',
                  '<p>Choose <em>Extend Player</em> from the action selector at the top of the page.</p>',
                '</div>',
              '</li>',

              '<li>',
                '<span class="ext-step-num">3</span>',
                '<div>',
                  '<strong>Find your player</strong>',
                  '<p>Use the team filter, position filter, or search field.',
                  ' Only eligible players appear in this list.</p>',
                '</div>',
              '</li>',

              '<li>',
                '<span class="ext-step-num">4</span>',
                '<div>',
                  '<strong>Select the player</strong>',
                  '<p>Click the player\'s row to open the extension options.',
                  ' If a player does not appear, they are not currently eligible.</p>',
                '</div>',
              '</li>',

              '<li>',
                '<span class="ext-step-num">5</span>',
                '<div>',
                  '<strong>Choose the extension term</strong>',
                  '<p>Select <em>+1 Year</em> or <em>+2 Years</em> if both are available.',
                  ' If only one option shows, that is the only available term.</p>',
                '</div>',
              '</li>',

              '<li>',
                '<span class="ext-step-num">6</span>',
                '<div>',
                  '<strong>Review the contract summary</strong>',
                  '<p>Check the updated AAV, TCV, and years remaining.',
                  ' These values are calculated automatically — you cannot change them.</p>',
                '</div>',
              '</li>',

              '<li>',
                '<span class="ext-step-num">7</span>',
                '<div>',
                  '<strong>Submit the extension</strong>',
                  '<p>Click <em>Submit Extension</em> when you are satisfied with the contract summary.</p>',
                '</div>',
              '</li>',

              '<li>',
                '<span class="ext-step-num">8</span>',
                '<div>',
                  '<strong>Confirm in Finalized Submissions</strong>',
                  '<p>Open the <em>Finalized Submissions</em> tab.',
                  ' Your extension should appear there. If it does, the action is complete.</p>',
                '</div>',
              '</li>',

            '</ol>',
            '<div class="ext-help-note">',
              '<strong>Note:</strong> Extensions affect future seasons only.',
              ' Your current-year salary stays unchanged.',
            '</div>',
          '</div>',
          /* └── END HOW TO ─────────────────────────────── */

          /* ┌── TERMS ───────────────────────────────────── */
          '<div class="ext-help-panel" id="extHelpTerms">',
            '<p class="ext-help-intro">Plain-English definitions for extension-related terms.</p>',
            '<dl class="ext-help-glossary">',

              '<div class="ext-gloss-item">',
                '<dt>Extension</dt>',
                '<dd>A contract action that adds more years to a player\'s existing deal.',
                ' The contract is recalculated with the new term and updated salary values.</dd>',
              '</div>',

              '<div class="ext-gloss-item">',
                '<dt>AAV <span class="ext-gloss-abbr">Average Annual Value</span></dt>',
                '<dd>The average salary per year across the full contract.',
                ' A four-year, $20M contract has an AAV of $5M per year.',
                ' This is the number used most often for cap planning.</dd>',
              '</div>',

              '<div class="ext-gloss-item">',
                '<dt>TCV <span class="ext-gloss-abbr">Total Contract Value</span></dt>',
                '<dd>The total dollars across all years of the contract.',
                ' A player earning $4M, $5M, and $6M over three years has a TCV of $15M.</dd>',
              '</div>',

              '<div class="ext-gloss-item">',
                '<dt>Years Remaining</dt>',
                '<dd>The seasons left on a player\'s contract after the current year.',
                ' This matters for eligibility because some extension rules depend on',
                ' where a player is in their contract.</dd>',
              '</div>',

              '<div class="ext-gloss-item">',
                '<dt>Eligible Player</dt>',
                '<dd>A player who qualifies for an extension under current league rules.',
                ' Only eligible players appear in the Extend Player list.',
                ' If a player is not listed, they are not eligible right now.</dd>',
              '</div>',

              '<div class="ext-gloss-item">',
                '<dt>Submitted Extension</dt>',
                '<dd>An extension that has been sent through the system but may still be',
                ' pending review or processing. You can see these in the submissions area.</dd>',
              '</div>',

              '<div class="ext-gloss-item">',
                '<dt>Finalized Submission</dt>',
                '<dd>An extension that has been recorded and confirmed.',
                ' When your extension appears in the Finalized Submissions tab,',
                ' the action is complete.</dd>',
              '</div>',

            '</dl>',
          '</div>',
          /* └── END TERMS ──────────────────────────────── */

          /* ┌── WARNINGS ────────────────────────────────── */
          '<div class="ext-help-panel" id="extHelpWarnings">',
            '<p class="ext-help-intro">Common issues and what to do about them.</p>',
            '<ul class="ext-help-warnings">',

              '<li class="ext-warn-item ext-warn-bad">',
                '<div class="ext-warn-label">Player not in the eligible list</div>',
                '<div class="ext-warn-body">That player is not currently eligible for an extension.',
                ' This could be because of their contract type, years remaining, or roster status.',
                ' You cannot override this in the system.',
                ' If you believe it is an error, contact the commissioner.</div>',
              '</li>',

              '<li class="ext-warn-item ext-warn-bad">',
                '<div class="ext-warn-label">No extension term available</div>',
                '<div class="ext-warn-body">The player appears in the list but has no valid extension',
                ' lengths available right now. You cannot submit without a term option.',
                ' Wait for an eligible window to open,',
                ' or ask the commissioner about that player\'s timing.</div>',
              '</li>',

              '<li class="ext-warn-item ext-warn-warn">',
                '<div class="ext-warn-label">Submission not showing after you submit</div>',
                '<div class="ext-warn-body">Refresh the page and check Finalized Submissions again.',
                ' If it still does not appear, do not resubmit.',
                ' Contact the commissioner with the player\'s name and the date',
                ' and time you submitted.</div>',
              '</li>',

              '<li class="ext-warn-item ext-warn-warn">',
                '<div class="ext-warn-label">Contract values look unexpected</div>',
                '<div class="ext-warn-body">Values are calculated automatically by the system',
                ' based on the extension term and league rules.',
                ' You cannot change them manually.',
                ' If the numbers look wrong, do not submit.',
                ' Contact the commissioner to clarify before you proceed.</div>',
              '</li>',

              '<li class="ext-warn-item ext-warn-warn">',
                '<div class="ext-warn-label">You are on the wrong page</div>',
                '<div class="ext-warn-body">Extensions are only processed in',
                ' <strong>Contract Command Center</strong>',
                ' under the <strong>Extend Player</strong> action.',
                ' Navigate back to Contract Command Center.</div>',
              '</li>',

            '</ul>',
          '</div>',
          /* └── END WARNINGS ───────────────────────────── */

          /* ┌── FAQ ─────────────────────────────────────── */
          '<div class="ext-help-panel" id="extHelpFaq">',
            '<p class="ext-help-intro">Quick answers to the most common extension questions.</p>',
            '<div class="ext-help-faq">',

              '<details class="ext-faq-item">',
                '<summary>How do I extend a player?</summary>',
                '<div class="ext-faq-body">Go to <strong>Contract Command Center</strong>',
                ' and select <strong>Extend Player</strong>.',
                ' Find your player, select them, choose the extension term,',
                ' review the contract summary, and submit.',
                ' After submitting, check <strong>Finalized Submissions</strong>',
                ' to confirm the action is recorded.</div>',
              '</details>',

              '<details class="ext-faq-item">',
                '<summary>Where do I go to submit an extension?</summary>',
                '<div class="ext-faq-body">All extensions are handled in',
                ' <strong>Contract Command Center</strong>.',
                ' Open it from the league navigation,',
                ' then choose the <strong>Extend Player</strong> action at the top of the page.',
                ' Extensions cannot be submitted from any other page.</div>',
              '</details>',

              '<details class="ext-faq-item">',
                '<summary>Why can\'t I extend this player?</summary>',
                '<div class="ext-faq-body">If a player does not appear in the Extend Player list,',
                ' they are not currently eligible.',
                ' This could be their contract type, years remaining, or roster status.',
                ' If you believe it is a mistake, contact the commissioner.</div>',
              '</details>',

              '<details class="ext-faq-item">',
                '<summary>My player shows up but there is no term to select. What do I do?</summary>',
                '<div class="ext-faq-body">No valid extension terms are available for that player',
                ' right now. You cannot submit without a term option.',
                ' Wait for an eligible window, or ask the commissioner',
                ' about that player\'s extension timing.</div>',
              '</details>',

              '<details class="ext-faq-item">',
                '<summary>How do I know if my extension went through?</summary>',
                '<div class="ext-faq-body">After submitting, open the',
                ' <strong>Finalized Submissions</strong> tab inside Contract Command Center.',
                ' If your extension appears there, it has been recorded.',
                ' If it does not appear, refresh the page and check again.',
                ' Do not resubmit without checking first.</div>',
              '</details>',

              '<details class="ext-faq-item">',
                '<summary>What does AAV mean?</summary>',
                '<div class="ext-faq-body">AAV stands for Average Annual Value.',
                ' It is the average salary per year across the full contract.',
                ' A $12M contract over three years has an AAV of $4M per year.',
                ' It is the most common number used for comparing cap impact.</div>',
              '</details>',

              '<details class="ext-faq-item">',
                '<summary>What does TCV mean?</summary>',
                '<div class="ext-faq-body">TCV stands for Total Contract Value.',
                ' It is the full dollar amount of the contract across all years.',
                ' A player earning $3M, $4M, and $5M over three years has a TCV of $12M.</div>',
              '</details>',

              '<details class="ext-faq-item">',
                '<summary>What does years remaining mean?</summary>',
                '<div class="ext-faq-body">Years remaining is the number of seasons left',
                ' on a player\'s contract after the current year.',
                ' This matters for extension eligibility because some rules depend',
                ' on where a player is in their contract.</div>',
              '</details>',

              '<details class="ext-faq-item">',
                '<summary>I submitted but it is not showing up. What do I do?</summary>',
                '<div class="ext-faq-body">Refresh the page and check',
                ' <strong>Finalized Submissions</strong> again.',
                ' If it still does not appear, do not submit again.',
                ' Contact the commissioner with the player\'s name',
                ' and the date and time you submitted.</div>',
              '</details>',

              '<details class="ext-faq-item">',
                '<summary>The contract values look different than I expected. Is that normal?</summary>',
                '<div class="ext-faq-body">Yes. The system calculates contract values automatically',
                ' based on the extension term and league rules.',
                ' You cannot change these values manually.',
                ' If the numbers look wrong, do not submit.',
                ' Contact the commissioner to clarify before you proceed.</div>',
              '</details>',

              '<details class="ext-faq-item">',
                '<summary>I am on the wrong page. Where do I go?</summary>',
                '<div class="ext-faq-body">Go back to the navigation and open',
                ' <strong>Contract Command Center</strong>.',
                ' Once there, choose <strong>Extend Player</strong>.',
                ' Extensions cannot be submitted from any other page.</div>',
              '</details>',

            '</div>',/* /.ext-help-faq */
            '<div class="ext-help-contact">',
              'For questions outside of extensions, contact the commissioner.',
            '</div>',
          '</div>',
          /* └── END FAQ ────────────────────────────────── */

        '</div>',/* /.ext-help-body */
      '</div>',  /* /.ccc-modal-card */
    '</div>'     /* /#extHelpModal */
  ].join("");

  /* ── Helpers ────────────────────────────────────────────── */
  function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  function openHelp() {
    var modal = document.getElementById(MODAL_ID);
    if (!modal) return;
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("ccc-modalOpen");
    // Return focus to close button when panel opens
    var closeBtn = document.getElementById("extHelpClose");
    if (closeBtn) { setTimeout(function () { closeBtn.focus(); }, 50); }
  }

  function closeHelp() {
    var modal = document.getElementById(MODAL_ID);
    if (!modal) return;
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    // Only remove body class if no other CCC modal is currently open
    var othersOpen = document.querySelectorAll(".ccc-modal.is-open:not(#" + MODAL_ID + ")");
    if (othersOpen.length === 0) {
      document.body.classList.remove("ccc-modalOpen");
    }
    // Return focus to trigger button
    var trigger = document.getElementById(TRIGGER_ID);
    if (trigger) trigger.focus();
  }

  /* ── Init ───────────────────────────────────────────────── */
  function init() {
    // 1. Inject modal into DOM
    document.body.insertAdjacentHTML("beforeend", MODAL_HTML);

    // 2. Add Help button to .ccc-heroLinks (before the Settings button)
    var heroLinks = document.querySelector(".ccc-heroLinks");
    if (heroLinks) {
      var btn = document.createElement("button");
      btn.type       = "button";
      btn.className  = "ccc-heroLink ext-help-trigger";
      btn.id         = TRIGGER_ID;
      btn.innerHTML  = "&#x3F;&nbsp;Help";
      btn.setAttribute("aria-label", "Open Extension Assistant");
      heroLinks.insertBefore(btn, heroLinks.firstChild);
      btn.addEventListener("click", openHelp);
    }

    // 3. Close controls
    document.getElementById("extHelpBackdrop")
      .addEventListener("click", closeHelp);
    document.getElementById("extHelpClose")
      .addEventListener("click", closeHelp);

    // 4. Escape key closes the panel
    document.addEventListener("keydown", function (e) {
      var modal = document.getElementById(MODAL_ID);
      if (e.key === "Escape" && modal && modal.classList.contains("is-open")) {
        closeHelp();
      }
    });

    // 5. Tab switching
    var modal = document.getElementById(MODAL_ID);
    var tabs  = modal.querySelectorAll(".ext-help-tab");
    var panels = modal.querySelectorAll(".ext-help-panel");

    tabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        var panelId = "extHelp" + capitalize(this.dataset.panel);

        tabs.forEach(function (t) {
          t.classList.remove("is-active");
          t.setAttribute("aria-selected", "false");
        });
        panels.forEach(function (p) {
          p.classList.remove("is-active");
        });

        this.classList.add("is-active");
        this.setAttribute("aria-selected", "true");

        var target = document.getElementById(panelId);
        if (target) {
          target.classList.add("is-active");
          // Scroll body back to top when switching tabs
          target.closest(".ext-help-body").scrollTop = 0;
        }
      });
    });
  }

  /* ── Boot ───────────────────────────────────────────────── */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
