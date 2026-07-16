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
      // Suppress MFL's own (mis-positioned, gold, floating) responsive
      // hamburger — UPS provides the single button below. (Also hidden in the
      // header <style> so there's no flash before this loads.)
      "#menu-trigger,.hamburger.hamburger--spin{display:none!important;visibility:hidden!important;}",
      // The one UPS hamburger — top-right, themed, above MFL's own z-index:99999.
      "#" + BTN_ID + "{",
      "  display:none;position:fixed;",
      "  top:calc(env(safe-area-inset-top,0px) + 0.5rem);right:0.5rem;z-index:100001!important;",
      "  width:2.75rem;height:2.75rem;border-radius:0.55rem;",
      "  background:var(--ups-accent,#f3b61f);color:var(--ups-accent-ink,#0e1320);",
      "  border:1px solid rgba(0,0,0,0.25);",
      "  font-size:1.5rem;line-height:1;cursor:pointer;",
      "  align-items:center;justify-content:center;",
      "  box-shadow:0 0.3rem 0.7rem rgba(0,0,0,0.4);",
      "}",
      "@media (max-width:768px){",
      "  #" + BTN_ID + "{display:inline-flex;}",
      // Dim the page behind the open drawer (scrim) so the menu reads as a
      // focused overlay and the busy banner/page doesn't show through the side
      // gaps. Sits below the drawer/button, above page content. A pseudo-element
      // can't be a click target, so outside-tap-to-close (onDocClick) still works.
      "  body." + OPEN_CLASS + "::before{content:'';position:fixed;inset:0;background:rgba(8,12,22,0.55);z-index:99990;}",
      // Closed: hide the whole native menu so there's no empty bar/gap.
      "  body:not(." + OPEN_CLASS + ") .myfantasyleague_menu{display:none!important;}",
      // The .myfantasyleague_menu is a <div> whose box won't grow around its
      // <ul> (the <ul>'s siblings are position:absolute), so styling the div as
      // the drawer leaves the rows transparent. Instead: neutralize the div and
      // promote its <ul> to the fixed drawer panel.
      "  body." + OPEN_CLASS + " .myfantasyleague_menu{",
      "    display:block!important;position:static!important;background:transparent!important;",
      "    border:0!important;box-shadow:none!important;padding:0!important;margin:0!important;",
      "    max-height:none!important;min-height:0!important;overflow:visible!important;",
      "  }",
      // Hide MFL's own menu chrome: the logo <span> AND every checkbox-hamburger
      // <label>/<input> — not just the top-level one. Each dropdown has its own
      // <label>/<input> sub-menu toggle (an absolutely-positioned red +/- box);
      // since we flatten everything open, all of these toggles are noise.
      "  body." + OPEN_CLASS + " .myfantasyleague_menu > span,",
      "  body." + OPEN_CLASS + " .myfantasyleague_menu label,",
      "  body." + OPEN_CLASS + " .myfantasyleague_menu input{display:none!important;}",
      // The <ul> IS the drawer: a themed, fixed, scrollable panel under the
      // button, above MFL's own menu z-index.
      "  body." + OPEN_CLASS + " .myfantasyleague_menu > ul{",
      "    display:block!important;position:fixed!important;",
      "    top:calc(env(safe-area-inset-top,0px) + 3.6rem)!important;left:0.5rem!important;right:0.5rem!important;",
      "    z-index:100000!important;background:var(--ups-surface,#111b2e)!important;",
      "    border:1px solid var(--ups-border,rgba(255,255,255,0.18))!important;border-radius:0.6rem!important;",
      "    padding:0.4rem!important;margin:0!important;list-style:none!important;",
      "    box-shadow:0 0.8rem 1.8rem rgba(0,0,0,0.65)!important;",
      "    height:auto!important;max-height:calc(100vh - env(safe-area-inset-top,0px) - 4.6rem)!important;overflow-y:auto!important;",
      "  }",
      // Fallback label so it's clear this is the MFL-native legacy menu, not
      // the primary (custom) pages.
      "  body." + OPEN_CLASS + " .myfantasyleague_menu > ul::before{",
      "    content:'MFL Legacy Links — fallback';display:block;",
      "    padding:0.45rem 0.65rem 0.5rem;margin-bottom:0.25rem;",
      "    font:600 0.7rem/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;",
      "    letter-spacing:0.05em;text-transform:uppercase;color:#8a97ad;",
      "    border-bottom:1px solid var(--ups-border,rgba(255,255,255,0.14));",
      "  }",
      // Flatten every nested sub-menu fully open + theme rows. MFL collapses
      // dropdowns with height:0;overflow:hidden (expanded on :hover, which touch
      // can't do); force them open so the kept links aren't clipped.
      "  body." + OPEN_CLASS + " .myfantasyleague_menu ul ul,",
      "  body." + OPEN_CLASS + " .myfantasyleague_menu li{",
      "    display:block!important;position:static!important;float:none!important;width:auto!important;",
      "    height:auto!important;max-height:none!important;overflow:visible!important;",
      "    list-style:none!important;background:var(--ups-surface,#111b2e)!important;",
      "  }",
      "  body." + OPEN_CLASS + " .myfantasyleague_menu li{",
      "    border-bottom:1px solid var(--ups-border,rgba(255,255,255,0.08))!important;",
      "  }",
      // Links: strip MFL's white bg, red text, underline, and the ▸ border-
      // triangle (a::before); re-theme to the UPS palette, readable on dark.
      "  body." + OPEN_CLASS + " .myfantasyleague_menu a{",
      "    display:block!important;padding:0.6rem 0.75rem!important;",
      "    background:transparent!important;color:var(--ups-text,#e8effa)!important;",
      "    text-decoration:none!important;border:0!important;font-weight:500!important;",
      "  }",
      "  body." + OPEN_CLASS + " .myfantasyleague_menu a::before,",
      "  body." + OPEN_CLASS + " .myfantasyleague_menu a::after{display:none!important;}",
      "  body." + OPEN_CLASS + " .myfantasyleague_menu a:hover,",
      "  body." + OPEN_CLASS + " .myfantasyleague_menu a:active{",
      "    background:rgba(255,255,255,0.06)!important;",
      "  }",
      // Top-level dropdown names become muted section labels; nested leaf links
      // indent under them so the grouping reads clearly.
      "  body." + OPEN_CLASS + " .myfantasyleague_menu > ul > li > a{",
      "    color:#8a97ad!important;font-size:0.7rem!important;font-weight:700!important;",
      "    text-transform:uppercase!important;letter-spacing:0.05em!important;",
      "  }",
      "  body." + OPEN_CLASS + " .myfantasyleague_menu > ul > li > ul > li > a{",
      "    padding-left:1.5rem!important;",
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

  // Barebones entry in the mobile drawer (docs/mfl_native/barebones_mode.md).
  // Guarded on the setter existing so this file stays safe loaded standalone;
  // in barebones this whole script is gate-skipped and the fixed pill covers
  // the way back, so this row only ever renders in FULL mode.
  function injectLiteModeRow() {
    try {
      if (typeof root.UPS_BAREBONES_SET !== "function") return;
      var menu = document.querySelector(".myfantasyleague_menu > ul");
      if (!menu || menu.querySelector(".ups-mm-lite")) return;
      var li = document.createElement("li");
      var a = document.createElement("a");
      a.className = "ups-mm-lite";
      a.href = "#";
      a.textContent = "\ud83d\udd0c Lite Mode (no-frills fallback)";
      a.addEventListener("click", function (ev) {
        ev.preventDefault();
        root.UPS_BAREBONES_SET(true);
      });
      li.appendChild(a);
      menu.appendChild(li);
    } catch (e) {}
  }

  function init() {
    if (!document.querySelector(".myfantasyleague_menu")) return;
    injectStyle();
    injectButton();
    injectLiteModeRow();
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
