/*!
 * playoff_bracket_polish.js — cosmetic seeding labels on the playoff bracket
 * Stage 6 of docs/mfl_native/tos_removal_plan.md
 * Verbatim port of TOS's 4-liner (theeohiostate_intel.md §4.2.10).
 *
 * MFL's stock bracket labels future opponent cells "Winner of Game #N".
 * Because UPS reseeds at every round, those labels are misleading — TOS
 * renames them to "Best Remaining Seed" / "Worst Remaining Seed" so the
 * bracket reads correctly under reseeding.
 *
 * Idempotent: re-runs on DOMContentLoaded and after a 1500ms settle window
 * to catch MFL's late-bracket repaint without depending on jQuery's ready.
 */
(function (root) {
  "use strict";
  if (!root || !root.document) return;
  if (root.__UPS_PLAYOFF_BRACKET_POLISH_INSTALLED__) return;
  root.__UPS_PLAYOFF_BRACKET_POLISH_INSTALLED__ = true;

  function findCells(playoff, needle) {
    if (!playoff) return [];
    var tds = playoff.querySelectorAll("td");
    var out = [];
    for (var i = 0; i < tds.length; i += 1) {
      if (tds[i].textContent && tds[i].textContent.indexOf(needle) !== -1) out.push(tds[i]);
    }
    return out;
  }

  function rename(td, label) {
    td.textContent = label;
    var s = td.getAttribute("style") || "";
    if (s.indexOf("justify-content") === -1) {
      td.setAttribute("style", s + (s ? ";" : "") + "justify-content:center");
    }
  }

  function polish() {
    var playoff = document.getElementById("playoff1");
    if (!playoff) return;
    findCells(playoff, "Winner of Game #2").forEach(function (td) { rename(td, "Worst Remaining Seed"); });
    findCells(playoff, "Winner of Game #1").forEach(function (td) { rename(td, "Best Remaining Seed"); });
    findCells(playoff, "Winner of Game #3").forEach(function (td) { rename(td, "Winner"); });
    findCells(playoff, "Winner of Game #4").forEach(function (td) { rename(td, "Winner"); });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", polish);
  } else {
    polish();
  }
  // Re-run after MFL's late repaint settles.
  setTimeout(polish, 1500);
})(typeof window !== "undefined" ? window : null);
