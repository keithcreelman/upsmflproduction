/* odds_display.js — the ONE display policy for forecast probabilities (Keith 2026-11-24, #1503).
   Pure and side-effect free: a probability and a verified verdict in, text out. No DOM, no fetch.

   THE CERTAINTY RULE
     100%  only when the outcome is VERIFIED clinched by the clinch rules (standings_clinch.js);
     0%    only when the outcome is VERIFIED impossible by the same rules.
     Otherwise a forecast above 99% shows ">99%" and one below 1% shows "<1%" (a simulated 1.000 or 0.000 included);
     exactly 99% is "99%" and exactly 1% is "1%"; anything between rounds to a whole percent from 1% to 99%.
     Rounding never implies certainty.
     A simulation that returns 1.0 or 0.0 is not proof; with no verdict available, certainty is never shown.
   Playoffs, division title and first-round bye are verified SEPARATELY: a playoff clinch says nothing about the
   division or the bye, and being out of the wild-card race says nothing about the division title.

   pct(p, verdict)          -> "100%" | "0%" | ">99%" | "<1%" | "N%" | "—"     verdict: "clinched" | "impossible" | null
   compact(p, verdict)      -> the same text without the % sign ("100", "0", ">99", "<1", "N", "—"), for tight grids
   describe(p, verdict)     -> { text, raw, verdict, conflict }   conflict: the verdict and the forecast disagree
                               (a clinched outcome the simulation sometimes misses, or an impossible one it reaches)
   verdicts(clinchRow)      -> { playoffs, division, bye }        each "clinched" | "impossible" | null
                               clinchRow = standings_clinch.analyze(...).byFid[fid], or null when unavailable
*/
(function (global) {
  'use strict';

  var CLINCHED = 'clinched', IMPOSSIBLE = 'impossible';

  function num(p) {
    if (p == null || p === '') return null;
    var x = Number(p);
    if (!isFinite(x) || x < -1e-9 || x > 1 + 1e-9) return null;   // not a probability: never displayed
    return x;
  }

  function pct(p, verdict) {
    if (verdict === CLINCHED) return '100%';
    if (verdict === IMPOSSIBLE) return '0%';
    var x = num(p);
    if (x == null) return '—';
    if (x > 0.99) return '>99%';
    if (x < 0.01) return '<1%';
    var r = Math.round(x * 100);
    return Math.min(99, Math.max(1, r)) + '%';
  }

  function compact(p, verdict) { return pct(p, verdict).replace('%', ''); }

  function describe(p, verdict) {
    var x = num(p), v = verdict === CLINCHED || verdict === IMPOSSIBLE ? verdict : null;
    return {
      text: pct(p, v), raw: x, verdict: v,
      conflict: x != null && ((v === CLINCHED && x < 1) || (v === IMPOSSIBLE && x > 0))
    };
  }

  // The clinch engine's flags -> one verdict per outcome. Each comes only from flags that hold in EVERY possible
  // finish; a flag the engine didn't set leaves the outcome open (null).
  //   playoffs: X (or Y, Z, a locked seed, which all imply it) / E
  //   division: Y (or Z, or a locked seed 1-2: the byes go only to division winners) / divOut (or E)
  //   bye:      Z (or a locked seed 1-2) / byeOut (or divOut: byes go only to division winners; or E; or a locked seed 3-6)
  function verdicts(c) {
    var out = { playoffs: null, division: null, bye: null };
    if (!c) return out;
    var lock = c.lock == null ? null : Number(c.lock);
    if (c.x || c.y || c.z || lock) out.playoffs = CLINCHED; else if (c.e) out.playoffs = IMPOSSIBLE;
    if (c.y || c.z || lock === 1 || lock === 2) out.division = CLINCHED; else if (c.divOut || c.e) out.division = IMPOSSIBLE;
    if (c.z || lock === 1 || lock === 2) out.bye = CLINCHED; else if (c.byeOut || c.divOut || c.e || lock >= 3) out.bye = IMPOSSIBLE;
    return out;
  }

  var api = { pct: pct, compact: compact, describe: describe, verdicts: verdicts, CLINCHED: CLINCHED, IMPOSSIBLE: IMPOSSIBLE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.UPS_ODDS_DISPLAY = api;
})(typeof window !== 'undefined' ? window : this);
