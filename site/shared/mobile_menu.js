/*!
 * mobile_menu.js — hamburger toggle for the MFL main menu on narrow viewports
 * Stage 6 of docs/mfl_native/tos_removal_plan.md
 * Replaces TOS's header.js load_mobileMenu_script (lessons §2 row 1).
 *
 * MFL renders its main nav inside .myfantasyleague_menu. On wide screens it's
 * a horizontal bar; on narrow it's unusable. TOS clones the menu into
 * .myfantasyleague_menuMobile and binds a hamburger. We do the simpler thing:
 * leave the original menu in place, inject a hamburger button + a thin
 * stylesheet, and toggle a class on <body> that flips the menu to a stacked
 * drawer below 768px.
 *
 * Pure native — no jQuery dependency. Works regardless of what MFL renders
 * inside the menu (sub-menus, login items, etc).
 *
 * Notes:
 *   - On UPS most mobile users get bounced to /m/ via the "Switch to App View"
 *     button in footer (see footer_custom_v2.html). This module is the
 *     fallback for users who explicitly stay on the desktop site on a phone.
 *   - Independent of UPS_USE_NATIVE_* flags; additive. Flip TOS's
 *     load_mobileMenu_script=false in Stage 6 cutover to retire TOS's clone.
 */
(function (root) {
  "use strict";
  if (!root || !root.document) return;
  if (root.__UPS_MOBILE_MENU_INSTALLED__) return;
  root.__UPS_MOBILE_MENU_INSTALLED__ = true;

  var BTN_ID = "ups-mobile-menu-btn";
  var OPEN_CLASS = "ups-mm-open";

  function injectStyle() {
    if (document.getElementById("ups-mobile-menu-style")) return;
    var css = [
      "#" + BTN_ID + "{",
      "  display:none;position:fixed;top:0.5rem;right:0.5rem;z-index:9999;",
      "  width:2.5rem;height:2.5rem;border-radius:0.4rem;",
      "  background:var(--ups-surface,#0e1a30);color:var(--ups-text,#e8eefb);",
      "  border:1px solid var(--ups-border,rgba(255,255,255,0.18));",
      "  font-size:1.4rem;line-height:1;cursor:pointer;",
      "  display:none;align-items:center;justify-content:center;",
      "  box-shadow:0 0.25rem 0.6rem rgba(0,0,0,0.45);",
      "}",
      "@media (max-width:768px){",
      "  #" + BTN_ID + "{display:inline-flex;}",
      "  body:not(." + OPEN_CLASS + ") .myfantasyleague_menu{display:none!important;}",
      "  body." + OPEN_CLASS + " .myfantasyleague_menu{",
      "    display:block!important;position:fixed;top:3.2rem;right:0.5rem;left:0.5rem;",
      "    z-index:9998;background:var(--ups-surface,#0e1a30);",
      "    border:1px solid var(--ups-border,rgba(255,255,255,0.18));",
      "    border-radius:0.5rem;padding:0.5rem;",
      "    box-shadow:0 0.8rem 1.6rem rgba(0,0,0,0.6);",
      "    max-height:calc(100vh - 4rem);overflow-y:auto;",
      "  }",
      "  body." + OPEN_CLASS + " .myfantasyleague_menu ul,",
      "  body." + OPEN_CLASS + " .myfantasyleague_menu li{",
      "    display:block!important;float:none!important;width:auto!important;",
      "  }",
      "  body." + OPEN_CLASS + " .myfantasyleague_menu a{",
      "    display:block!important;padding:0.55rem 0.7rem!important;",
      "  }",
      "}"
    ].join("\n");
    var s = document.createElement("style");
    s.id = "ups-mobile-menu-style";
    s.textContent = css;
    document.head.appendChild(s);
  }

  function injectButton() {
    if (document.getElementById(BTN_ID)) return;
    var b = document.createElement("button");
    b.id = BTN_ID;
    b.type = "button";
    b.setAttribute("aria-label", "Toggle menu");
    b.setAttribute("aria-expanded", "false");
    b.textContent = "☰"; // hamburger glyph
    b.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      toggle();
    });
    document.body.appendChild(b);
  }

  function toggle(force) {
    var open = typeof force === "boolean"
      ? force
      : !document.body.classList.contains(OPEN_CLASS);
    document.body.classList.toggle(OPEN_CLASS, open);
    var b = document.getElementById(BTN_ID);
    if (b) b.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function onDocClick(ev) {
    if (!document.body.classList.contains(OPEN_CLASS)) return;
    var menu = document.querySelector(".myfantasyleague_menu");
    var btn = document.getElementById(BTN_ID);
    if (!menu) return;
    if (menu.contains(ev.target)) return;
    if (btn && btn.contains(ev.target)) return;
    toggle(false);
  }

  function init() {
    if (!document.querySelector(".myfantasyleague_menu")) return;
    injectStyle();
    injectButton();
    document.addEventListener("click", onDocClick, true);
    root.addEventListener("resize", function () {
      if (root.innerWidth > 768) toggle(false);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})(typeof window !== "undefined" ? window : null);
