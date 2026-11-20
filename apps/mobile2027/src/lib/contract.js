/* UPS 2027 Preview 0: contract facts for one player. Pure functions, no network, no storage.

   Two sources, never mixed up:
   1. The recorded contract (the Front Office read): salary now, YEARS REMAINING, type and the contract text
      ("CL 3|TCV 18K|AAV 6K|Y1-6K, Y2-6K, Y3-6K|GTD: 13.5K"). That gives the salary for each remaining year.
   2. The worker's cap-penalty answer (/api/cap-penalty/preview): earned to date, guarantee and the cost of a cut.
      Preview 0 shows those numbers exactly as the worker states them. It does not recompute them.

   A missing fact is shown as "Not recorded" or "Not available". It is never shown as $0. */
(function (root, factory) {
  var api = factory(typeof require === "function" ? require("./format.js") : root.UPS2027.format);
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.UPS2027 = root.UPS2027 || {}; root.UPS2027.contract = api; }
})(typeof self !== "undefined" ? self : this, function (F) {
  "use strict";

  // "13.5K" -> 13500, "$1,000" -> 1000, "2M" -> 2000000. Not a number -> null.
  function moneyToken(t) {
    var s = F.str(t).toUpperCase().replace(/[$,\s]/g, "");
    if (!s) return null;
    var mult = 1;
    if (/K$/.test(s)) { mult = 1000; s = s.slice(0, -1); }
    else if (/M$/.test(s)) { mult = 1000000; s = s.slice(0, -1); }
    if (!/^\d+(\.\d+)?$/.test(s)) return null;
    return Math.round(Number(s) * mult);
  }

  // Parses the recorded contract text. Year tokens are in thousands even when the K is missing ("Y1-50" is $50,000),
  // which is how the Front Office and the worker read them. A token followed by "Option" is an unexercised rookie option year.
  function parseSpecial(text) {
    var s = F.str(text);
    var out = { raw: s, cl: null, tcv: null, gtd: null, aav: [], y: {}, option: null };
    if (!s) return out;
    var m;
    if ((m = s.match(/(?:^|\|)\s*CL\s*:?\s*(\d+)/i))) out.cl = parseInt(m[1], 10);
    if ((m = s.match(/(?:^|\|)\s*TCV\s*:?\s*([^|]+)/i))) out.tcv = moneyToken(m[1]);
    if ((m = s.match(/(?:^|\|)\s*GTD\s*:?\s*([^|]+)/i))) out.gtd = moneyToken(m[1]);
    if ((m = s.match(/(?:^|\|)\s*AAV\s*:?\s*([^|]+)/i))) {
      out.aav = m[1].split(",").map(moneyToken).filter(function (v) { return v != null; });
    }
    var re = /Y(\d+)\s*-\s*([0-9]+(?:\.[0-9]+)?)\s*K?(\s*Option)?/gi;
    while ((m = re.exec(s))) {
      var idx = parseInt(m[1], 10);
      if (!(idx > 0)) continue;
      var amt = Math.round(parseFloat(m[2]) * 1000);
      if (m[3]) out.option = { idx: idx, amount: amt };
      else out.y[idx] = amt;
    }
    return out;
  }

  // The remaining seasons of one contract. `player` carries salary (this season), years (years remaining), special.
  // Row k is the season (season + k). This season's amount is the salary on the roster; later seasons come from the
  // recorded year tokens, and are null ("Not recorded") when the text has no token for them.
  function schedule(player, season) {
    var c = parseSpecial(player.special);
    var years = Math.max(0, parseInt(player.years, 10) || 0);
    var salary = Number(player.salary);
    var cl = c.cl || 0;
    var idx0 = (cl >= years && years > 0) ? cl - years + 1 : null; // 1-based contract year that is this season
    var out = { parsed: c, cl: cl || null, yearsLeft: years, through: years ? season + years - 1 : null, yearsPlayed: idx0 ? idx0 - 1 : null, rows: [], option: null, notes: [] };
    for (var k = 0; k < years; k++) {
      var amount = null;
      if (k === 0) amount = isFinite(salary) && player.salary !== "" && player.salary != null ? salary : null;
      else if (idx0 != null && c.y[idx0 + k] != null) amount = c.y[idx0 + k];
      out.rows.push({ year: season + k, amount: amount });
    }
    if (c.option && idx0 != null) out.option = { year: season + (c.option.idx - idx0), amount: c.option.amount };
    if (idx0 != null && c.y[idx0] != null && isFinite(salary) && c.y[idx0] !== salary) out.notes.push("current_year_token_differs");
    return out;
  }

  // ---- the worker's answer (one row of /api/cap-penalty/preview .players[pid]) ----
  function finite(n) { return typeof n === "number" && isFinite(n); }

  // kind: amount | rule | na | unavailable
  function earned(row) {
    if (!row) return { kind: "unavailable", why: "The worker’s answer is not available" };
    if (row.needs_review) return { kind: "unavailable", why: F.str(row.review_reason) || "The worker flagged this contract for review" };
    var rule = row.earned_rule;
    if (rule === "full_year_sub_5k") return { kind: "rule", label: "Full-year rule" };
    if (rule === "ww_earned_na") return { kind: "na", label: "Not applicable" };
    if (rule) return { kind: "unavailable", why: "An earned rule this preview does not know" };
    if (finite(row.earned)) return { kind: "amount", amount: row.earned };
    return { kind: "unavailable", why: "No earned amount from the worker" };
  }

  function remainingGuarantee(row) {
    var e = earned(row);
    if (e.kind !== "amount" || !finite(row.guaranteed)) return null;
    return Math.max(0, row.guaranteed - e.amount);
  }

  function cutNow(row) {
    if (!row) return { kind: "unavailable", why: "The worker’s cut-cost answer is not available" };
    if (row.needs_review) return { kind: "unavailable", why: F.str(row.review_reason) || "Needs review" };
    if (!finite(row.penalty)) return { kind: "unavailable", why: "No cut cost from the worker" };
    var why = F.str(row.exempt_reason);
    if (!why && row.basis === "guarantee_minus_earned" && finite(row.guaranteed) && finite(row.earned)) {
      why = "Guarantee " + F.money(row.guaranteed) + " minus earned " + F.money(row.earned);
    }
    return { kind: "amount", amount: row.penalty, why: why };
  }

  return { moneyToken: moneyToken, parseSpecial: parseSpecial, schedule: schedule, earned: earned, remainingGuarantee: remainingGuarantee, cutNow: cutNow };
});
