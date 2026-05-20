/*!
 * module_collapse.js — expand/collapse toggle on .homepagemodule title bars
 * Stage 6 of docs/mfl_native/tos_removal_plan.md
 * Replaces TOS's footer.js load_moduleExpand_script (lessons §2 row 8).
 *
 * Behavior: click the .reporttitle of any .homepagemodule to toggle the
 * body collapsed/expanded. State persists in localStorage under key
 * MFLRememberModuleStates per league_id+year. Restores on page load.
 *
 * Independent of UPS_USE_NATIVE_* flags — this is purely additive. The TOS
 * version's toggle markup will still render while load_moduleExpand_script=true
 * in HPM #20; flipping that toggle off in Stage 6 cutover is what activates
 * this module as the sole driver.
 */
(function (root) {
  "use strict";
  if (!root || !root.document) return;
  if (root.__UPS_MODULE_COLLAPSE_INSTALLED__) return;
  root.__UPS_MODULE_COLLAPSE_INSTALLED__ = true;

  var STORE_KEY = "MFLRememberModuleStates";
  var COLLAPSED_CLASS = "ups-module-collapsed";
  var TOGGLE_CLASS = "ups-module-toggle";

  function leagueKey() {
    var lid = "";
    var year = "";
    try {
      var u = new URL(root.location.href);
      lid = u.searchParams.get("L") || "";
      var m = String(u.pathname || "").match(/\/(\d{4})\//);
      if (m && m[1]) year = m[1];
    } catch (e) {}
    return (year || "y") + ":" + (lid || "lid");
  }

  function readStates() {
    try {
      var raw = root.localStorage.getItem(STORE_KEY);
      var all = raw ? JSON.parse(raw) : {};
      return all[leagueKey()] || {};
    } catch (e) { return {}; }
  }

  function writeStates(map) {
    try {
      var raw = root.localStorage.getItem(STORE_KEY);
      var all = raw ? JSON.parse(raw) : {};
      all[leagueKey()] = map || {};
      root.localStorage.setItem(STORE_KEY, JSON.stringify(all));
    } catch (e) {}
  }

  function moduleId(mod) {
    if (mod.id) return mod.id;
    // Fall back to title text + dom-order index so anonymous modules persist.
    var title = mod.querySelector(".reporttitle");
    var t = title ? title.textContent.trim().slice(0, 40) : "";
    var sib = mod.parentNode ? Array.prototype.indexOf.call(mod.parentNode.children, mod) : 0;
    return "mod_" + t + "_" + sib;
  }

  function getBody(mod) {
    // Stock MFL uses .reportcontent; some HPM modules use .modulecontent or no inner wrapper.
    return mod.querySelector(".reportcontent")
      || mod.querySelector(".modulecontent")
      || mod.querySelector(".reportbody")
      || null;
  }

  function applyState(mod, collapsed) {
    var body = getBody(mod);
    if (!body) return;
    if (collapsed) {
      mod.classList.add(COLLAPSED_CLASS);
      body.style.display = "none";
    } else {
      mod.classList.remove(COLLAPSED_CLASS);
      body.style.display = "";
    }
    var btn = mod.querySelector("." + TOGGLE_CLASS);
    if (btn) {
      btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
      btn.setAttribute("title", collapsed ? "Expand Report" : "Collapse Report");
      btn.textContent = collapsed ? "+" : "−";
    }
  }

  function decorate(mod) {
    if (mod.__upsCollapseDecorated) return;
    mod.__upsCollapseDecorated = true;

    var title = mod.querySelector(".reporttitle");
    if (!title) return;

    var btn = document.createElement("span");
    btn.className = TOGGLE_CLASS;
    btn.setAttribute("role", "button");
    btn.setAttribute("tabindex", "0");
    btn.setAttribute("aria-expanded", "true");
    btn.setAttribute("title", "Collapse Report");
    btn.textContent = "−";
    btn.style.cssText = "display:inline-block;margin-left:0.5rem;cursor:pointer;font-weight:900;user-select:none;color:var(--ups-muted,#a7c1e6);";
    title.appendChild(btn);

    function toggle(ev) {
      if (ev) { ev.preventDefault(); ev.stopPropagation(); }
      var states = readStates();
      var id = moduleId(mod);
      var nowCollapsed = !mod.classList.contains(COLLAPSED_CLASS);
      states[id] = nowCollapsed ? 1 : 0;
      writeStates(states);
      applyState(mod, nowCollapsed);
    }

    title.style.cursor = "pointer";
    title.addEventListener("click", toggle);
    btn.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " ") toggle(ev);
    });
  }

  function init() {
    var modules = document.querySelectorAll(".homepagemodule");
    if (!modules || !modules.length) return;
    var states = readStates();
    for (var i = 0; i < modules.length; i += 1) {
      decorate(modules[i]);
      var id = moduleId(modules[i]);
      if (states[id]) applyState(modules[i], true);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
  // Re-scan after MFL's late module hydration.
  setTimeout(init, 1200);
})(typeof window !== "undefined" ? window : null);
