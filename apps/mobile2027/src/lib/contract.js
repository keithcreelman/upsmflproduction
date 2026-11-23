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
    // only a real number is a recorded salary: null, "", whitespace, booleans and text are unknown, never $0
    var raw = player.salary;
    var known = raw != null && typeof raw !== "boolean" && !(typeof raw === "string" && raw.trim() === "") && isFinite(Number(raw));
    var salary = known ? Number(raw) : null;
    var cl = c.cl || 0;
    var idx0 = (cl >= years && years > 0) ? cl - years + 1 : null; // 1-based contract year that is this season
    var out = { parsed: c, cl: cl || null, yearsLeft: years, through: years ? season + years - 1 : null, yearsPlayed: idx0 ? idx0 - 1 : null, rows: [], option: null, notes: [] };
    for (var k = 0; k < years; k++) {
      var amount = null;
      if (k === 0) amount = salary;
      else if (idx0 != null && c.y[idx0 + k] != null) amount = c.y[idx0 + k];
      out.rows.push({ year: season + k, amount: amount });
    }
    if (c.option && idx0 != null) out.option = { year: season + (c.option.idx - idx0), amount: c.option.amount };
    if (idx0 != null && c.y[idx0] != null && salary != null && c.y[idx0] !== salary) out.notes.push("current_year_token_differs");
    return out;
  }

  // R6: the full salary schedule of the CURRENT contract, completed years included, from that contract's own recorded terms only: CL is its length
  // in years and Y<k> the salary of its k-th year. This season is year CL - (years remaining) + 1, so the completed years are Y1 .. that year - 1.
  // Nothing comes from an earlier contract or from a later snapshot: a completed year with no Y token is null ("Not recorded"); when the length is
  // not recorded (or is shorter than the years remaining) the earlier years are unknown and none is listed; when this season's token disagrees with
  // the salary MFL charges now, the completed-year tokens are not trusted and are null. The later years are the same as schedule() (the columns).
  // -> { length, start, end, yearsLeft, rows: [{ year, amount, phase: "done" | "now" | "left" }], option, earlier, missing, complete }
  //    earlier: "none" (no completed years) | "recorded" | "partial" | "conflict" | "unknown"
  //
  // R7 (Keith, 2026-11-23): the schedule is the contract IN FORCE NOW. An extension starts the current contract (canon §C4: the extension keeps the
  // current year's salary as its Y1 and adds one or two years, and its TCV is forward-looking only), so an extended contract's first year is the
  // season the extension was made in: extended in 2026 for two more years -> 2026/2027/2028; the years before belong to the earlier contract and
  // are never stitched in. A restructure is NOT a new contract, but it RE-BASES the recorded length to the remaining years (canon §C5.1), so after
  // one the text no longer holds the contract's earlier years. When the restructure year is the first recorded year, the start of the contract is
  // established only by evidence (restructure() below); otherwise the earlier years are "unknown" ("restructured"): no start, no length, nothing
  // filled in.
  //    earlier adds: "restructured" (the recorded terms begin at a restructure and nothing shows the contract's real start)
  //    restructured: the restructure year or null; startWhy: "terms" | "extension" | "auction" | null
  function history(player, season) {
    var sch = schedule(player, season), c = sch.parsed, years = sch.yearsLeft, cl = sch.cl;
    var out = { length: null, start: null, end: sch.through, yearsLeft: years, rows: [], option: sch.option, earlier: "unknown", missing: 0, complete: false, restructured: restructureYear(c.raw), startWhy: null };
    if (!years) return out;
    var idx0 = cl && cl >= years ? cl - years + 1 : null, conflict = sch.notes.indexOf("current_year_token_differs") >= 0, gap = 0;
    if (idx0 != null) {
      var first = season - (idx0 - 1), rs = out.restructured;
      if (rs != null && rs === first) {
        // the recorded terms begin at the restructure (§C5.1 re-base); find the contract's real start from evidence, or leave it unknown
        var ev = restructuredStart(player, season, first, out.end);
        if (ev == null) {
          // the years from the restructure on are recorded and are listed; what came before is unknown, so no start and no length are claimed
          out.earlier = "restructured";
          for (var j = 1; j < idx0; j++) out.rows.push({ year: first + j - 1, amount: !conflict && c.y[j] != null ? c.y[j] : null, phase: "done" });
          sch.rows.forEach(function (r, k) { out.rows.push({ year: r.year, amount: r.amount, phase: k === 0 ? "now" : "left" }); });
          out.missing = out.rows.filter(function (r) { return r.amount == null; }).length;
          return out;   // complete stays false: the contract's start is not known
        }
        out.start = ev.start; out.startWhy = ev.why; out.length = out.end - ev.start + 1;
        // years between the evidenced start and the restructure are not in the re-based terms: listed, and Not recorded (never copied from today's salary)
        for (var yb = ev.start; yb < first; yb++) { gap++; out.rows.push({ year: yb, amount: null, phase: "done" }); }
      } else {
        out.length = cl; out.start = first; out.startWhy = "terms";
      }
      for (var i = 1; i < idx0; i++) {
        var a = !conflict && c.y[i] != null ? c.y[i] : null;
        if (a == null) gap++;
        out.rows.push({ year: first + i - 1, amount: a, phase: "done" });
      }
      out.earlier = out.start === season ? "none" : conflict ? "conflict" : gap ? "partial" : "recorded";
    }
    sch.rows.forEach(function (r, k) { out.rows.push({ year: r.year, amount: r.amount, phase: k === 0 ? "now" : "left" }); });
    out.missing = out.rows.filter(function (r) { return r.amount == null; }).length;
    out.complete = out.earlier !== "unknown" && out.missing === 0;
    return out;
  }

  // "Restructured 2026" (the current writers) or "restructure: 2025" (older text) -> 2026 / 2025; none -> null. The latest one wins.
  function restructureYear(text) {
    var re = /restructur(?:ed|e)\s*:?\s*(\d{4})/gi, m, y = null;
    while ((m = re.exec(F.str(text)))) { var v = parseInt(m[1], 10); if (y == null || v > y) y = v; }
    return y;
  }

  // How many years an extension added: "Vet-Ext1", "Rookie-Ext2-BL" -> 1 / 2. Not an extension -> null. (EXT3 is legacy per canon and is not read.)
  function extYears(type) {
    var m = F.str(type).match(/(?:^|-)Ext([12])(?:-|$)/i);
    return m ? parseInt(m[1], 10) : null;
  }

  // The real start of a contract whose recorded terms begin at a restructure (first === the restructure year), from evidence only. -> { start, why } | null
  //  - an extension contract: canon §C4 lets a player be extended only in his final year (the contract is then that year plus N added years) or as an
  //    expired rookie (then just the N added years); §C5 lets a contract be restructured only with 2+ years left. So when the recorded terms run exactly
  //    N years past the restructure year, the restructure came in the extension's own first season, and that season is the start. Anything else is
  //    ambiguous (an Ext2 restructured with one year after it: extended that season or the season before) and stays unknown.
  //  - a contract won at auction and not extended since: the roster read's acquisition "Auction $X (YYYY)" is the year that contract began.
  function restructuredStart(player, season, first, end) {
    var n = extYears(player.type);
    if (n) return end != null && end - first === n ? { start: first, why: "extension" } : null;
    var acq = F.str(player.acquisition).match(/^Auction\b[^()]*\((\d{4})\)\s*$/i);
    if (acq && /(?:^|-)(?:FAA|ERA)(?:-|$)/i.test(F.str(player.type))) {
      var y = parseInt(acq[1], 10);
      if (y <= first && y <= season) return { start: y, why: "auction" };
    }
    return null;
  }

  // ---- R7: "Extended by [UPS team] · [year]", from evidence only ----
  // The evidence is the contract text MFL holds now. Its "Ext:" segment lists the franchises that granted extensions on this player, oldest first; each
  // new extension APPENDS its franchise and a restructure adds none (worker/src/extension_pricing.js lineageWithExtender; canon §C5.1 keeps the token
  // verbatim). So for a contract whose type is an extension, the LAST name is the franchise that made the extension in force now — whoever owns the
  // player today. A name is matched to a team only through (1) a current team's own abbreviation or name in the same roster read, (2) the same text
  // as MFL's Latin-1 rendering of it (an emoji abbreviation reaches the text as "ð¨ â°"), or (3) the worker's table of older nicknames
  // (LEGACY_EXT_NAMES, a copy of worker/src/index.js EXT_OWNER_BY_NICKNAME pinned by tests/mobile2027_r7_contracts.test.mjs). A name that matches no
  // team, or two different teams, is "unknown": the line then reads "Extended · 2026" with no team. It is never the current owner by default.
  var LEGACY_EXT_NAMES = { uw: "0001", lh: "0006", cbp: "0002", cleon: "0011", sex: "0007", gride: "0003", hammer: "0005", bb: "0010", ctown: "0009", chivalry: "0009", pg: "0004", creel: "0008", hawks: "0012", hood: "0099", mafia: "0099", blake: "0010" };
  function asciiKey(s) { return F.str(s).toLowerCase().replace(/[^a-z0-9]/g, ""); }
  // keeps every printable character (accented letters included) but drops spaces and the control characters MFL strips from Latin-1 text
  function looseKey(s) { return F.str(s).toLowerCase().replace(/[\s\x00-\x1f\x80-\x9f]+/g, ""); }
  // the UTF-8 bytes of s read as Latin-1 characters (what MFL shows for text it stored from a UTF-8 page)
  function latin1Of(s) {
    var out = "", t = F.str(s);
    for (var i = 0; i < t.length; i++) {
      var cp = t.charCodeAt(i), lo = i + 1 < t.length ? t.charCodeAt(i + 1) : 0;
      if (cp >= 0xd800 && cp <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff) { cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00); i++; }
      var b = cp < 0x80 ? [cp] : cp < 0x800 ? [0xc0 | (cp >> 6), 0x80 | (cp & 63)] : cp < 0x10000 ? [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)] : [0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)];
      for (var j = 0; j < b.length; j++) out += String.fromCharCode(b[j]);
    }
    return out;
  }
  function extLineage(text) {
    var m = F.str(text).match(/(?:^|\|)\s*Ext\s*:\s*([^|]*)/i);
    if (!m) return [];
    return m[1].split(",").map(function (x) { return x.replace(/\s{2,}/g, " ").trim(); }).filter(Boolean);
  }
  // one Ext: name -> the fid of the one current team it names, or null
  function teamForName(name, teams) {
    var hits = {}, a = asciiKey(name), l = looseKey(name);
    (teams || []).forEach(function (t) {
      [t.abbrev, t.name].forEach(function (v) {
        if (!F.str(v)) return;
        if ((a && asciiKey(v) === a) || (l && (looseKey(v) === l || looseKey(latin1Of(v)) === l))) hits[t.id] = true;
      });
    });
    if (a && Object.prototype.hasOwnProperty.call(LEGACY_EXT_NAMES, a)) hits[LEGACY_EXT_NAMES[a]] = true;
    var ids = Object.keys(hits);
    if (ids.length !== 1) return null;
    var cur = (teams || []).filter(function (t) { return t.id === ids[0]; })[0];
    return cur ? cur : null;   // a franchise that is not one of today's teams ("Mafia", "Hood") is not a UPS team to name
  }
  // -> null (the current contract is not an extension) | { years: 1|2, year, yearWhy, by: { id, name } | null, byName, traded, lineage }
  //    year: the season the extension was made (its first contract year), or null when the recorded terms cannot show it
  function extension(player, season, teams) {
    var n = extYears(player.type);
    if (!n) return null;
    var h = history(player, season), year = null, why = null;
    if (h.start != null && h.startWhy === "terms") {
      var cl = h.length;   // an extension contract is N added years (expired rookie) or this year plus N (final-year extension): anything else is not one we can read
      if (cl === n || cl === n + 1) { year = h.start; why = "terms"; }
    } else if (h.start != null && h.startWhy === "extension") { year = h.start; why = "restructure_bound"; }
    var lin = extLineage(player.special), last = lin.length ? lin[lin.length - 1] : "";
    var t = last ? teamForName(last, teams) : null;
    return { years: n, year: year, yearWhy: why, by: t ? { id: t.id, name: t.name } : null, byName: last || null, traded: !!(t && player.franchiseId && t.id !== player.franchiseId), lineage: lin };
  }
  // "Extended by The Long Haulers · 2025" | "Extended · 2026" | "Extended by Pure Greatness" | "Extended"
  function extensionLine(e) {
    if (!e) return "";
    return "Extended" + (e.by ? " by " + e.by.name : "") + (e.year != null ? " · " + e.year : "");
  }

  // ---- the worker's answer (one row of /api/cap-penalty/preview .players[pid]) ----
  function finite(n) { return typeof n === "number" && isFinite(n); }

  // kind: amount | rule | na | unavailable
  function earned(row) {
    if (!row) return { kind: "unavailable", why: "The UPS cap calculation is not available" };
    if (row.needs_review) return { kind: "unavailable", why: F.str(row.review_reason) || "This contract is flagged for review" };
    var rule = row.earned_rule;
    if (rule === "full_year_sub_5k") return { kind: "rule", label: "Full-year rule" };
    if (rule === "ww_earned_na") return { kind: "na", label: "Not applicable" };
    if (rule) return { kind: "unavailable", why: "An earned rule this preview does not know" };
    if (finite(row.earned)) return { kind: "amount", amount: row.earned };
    return { kind: "unavailable", why: "No earned amount in the calculation" };
  }

  function remainingGuarantee(row) {
    var e = earned(row);
    if (e.kind !== "amount" || !finite(row.guaranteed)) return null;
    return Math.max(0, row.guaranteed - e.amount);
  }

  function cutNow(row) {
    if (!row) return { kind: "unavailable", why: "The cut-cost calculation is not available" };
    if (row.needs_review) return { kind: "unavailable", why: F.str(row.review_reason) || "Needs review" };
    if (!finite(row.penalty)) return { kind: "unavailable", why: "No cut cost in the calculation" };
    var why = F.str(row.exempt_reason);
    if (!why && row.basis === "guarantee_minus_earned" && finite(row.guaranteed) && finite(row.earned)) {
      why = "Guarantee " + F.money(row.guaranteed) + " minus earned " + F.money(row.earned);
    }
    return { kind: "amount", amount: row.penalty, why: why };
  }

  return { moneyToken: moneyToken, parseSpecial: parseSpecial, schedule: schedule, history: history, restructureYear: restructureYear, extYears: extYears,
    extLineage: extLineage, teamForName: teamForName, extension: extension, extensionLine: extensionLine, LEGACY_EXT_NAMES: LEGACY_EXT_NAMES, earned: earned, remainingGuarantee: remainingGuarantee, cutNow: cutNow };
});
