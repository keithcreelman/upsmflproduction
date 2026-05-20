/*!
 * UPSReveal — anti-flicker reveal helpers
 * Stage 2 of docs/mfl_native/tos_removal_plan.md
 * Mirrors lessons_from_theeohiostate.md §3 (double-RAF + setTimeout).
 *
 * Public surface: window.UPSReveal.{ revealOnNextLayout, waitForGlobal,
 *                                    holdUntil, hidePlaceholder }
 *
 * Why: MFL's stylesheet loads async after HPM JS. Without this, every
 * generated table/component flashes unstyled HTML (FOUC) before its CSS
 * lands. Two nested RAFs + a small settleMs let CSS catch up before the
 * user sees the swap.
 */
(function (root) {
  "use strict";
  if (root.UPSReveal && root.UPSReveal.__installed__) return;

  var DEFAULT_SETTLE_MS = 300;

  // applyFn runs after the next two layout commits + settleMs. Returns a Promise
  // resolving once applyFn has executed (any return value of applyFn is forwarded).
  function revealOnNextLayout(applyFn, settleMs) {
    var delay = typeof settleMs === "number" ? settleMs : DEFAULT_SETTLE_MS;
    return new Promise(function (resolve, reject) {
      var raf = root.requestAnimationFrame;
      var run = function () {
        try { resolve(applyFn()); }
        catch (e) { reject(e); }
      };
      if (typeof raf !== "function") {
        setTimeout(run, delay);
        return;
      }
      raf(function () {
        raf(function () {
          if (delay > 0) setTimeout(run, delay);
          else run();
        });
      });
    });
  }

  // Polls for a global to become defined (TOS pattern for chaining script
  // loaders). Resolves when globalName resolves truthy or rejects on timeout.
  // checkFn defaults to `typeof root[globalName] !== "undefined"`.
  function waitForGlobal(globalName, opts) {
    var o = opts || {};
    var timeoutMs = typeof o.timeoutMs === "number" ? o.timeoutMs : 5000;
    var check = typeof o.check === "function" ? o.check : function () {
      return typeof root[globalName] !== "undefined";
    };
    return new Promise(function (resolve, reject) {
      if (check()) { resolve(root[globalName]); return; }
      var done = false;
      var to = setTimeout(function () {
        if (done) return;
        done = true;
        reject(new Error("UPSReveal.waitForGlobal: timed out waiting for " + globalName));
      }, timeoutMs);
      var raf = root.requestAnimationFrame;
      var pollFn = function () {
        if (done) return;
        if (check()) {
          done = true;
          clearTimeout(to);
          resolve(root[globalName]);
          return;
        }
        if (typeof raf === "function") raf(pollFn);
        else setTimeout(pollFn, 16);
      };
      if (typeof raf === "function") raf(pollFn);
      else setTimeout(pollFn, 16);
    });
  }

  // Generic "hold this node off-DOM until layout settles." Useful for swapping
  // a built-up DocumentFragment in once its CSS is ready. The node stays in
  // the fragment until applyFn (typically `mount.appendChild(node)`) fires.
  function holdUntil(node, mount, settleMs) {
    return revealOnNextLayout(function () {
      if (mount && typeof mount.appendChild === "function") {
        mount.appendChild(node);
      }
      return node;
    }, settleMs);
  }

  // Tiny helper for the common "skeleton → real" pattern. Selector points at a
  // placeholder; once revealed, the placeholder is removed and applyFn runs.
  function hidePlaceholder(placeholderSelector, applyFn, settleMs) {
    return revealOnNextLayout(function () {
      var el = document.querySelector(placeholderSelector);
      if (el && el.parentNode) el.parentNode.removeChild(el);
      return applyFn ? applyFn() : undefined;
    }, settleMs);
  }

  root.UPSReveal = {
    __installed__: true,
    DEFAULT_SETTLE_MS: DEFAULT_SETTLE_MS,
    revealOnNextLayout: revealOnNextLayout,
    waitForGlobal: waitForGlobal,
    holdUntil: holdUntil,
    hidePlaceholder: hidePlaceholder
  };
})(typeof window !== "undefined" ? window : this);
