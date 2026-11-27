/* UPS 2027 Preview 0: small display helpers. Plain script (browser) and CommonJS (tests).
   Nothing here touches the network or storage. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.UPS2027 = root.UPS2027 || {}; root.UPS2027.format = api; }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function str(v) { return v == null ? "" : String(v).trim(); }

  // Whole dollars with a thousands separator. Never called with an unknown value:
  // callers show "Not available" / "Not recorded" instead of a made-up $0.
  function money(n) {
    var v = Math.round(Number(n));
    if (!isFinite(v)) return "";
    var sign = v < 0 ? "-" : "";
    var s = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return sign + "$" + s;
  }

  // Keith 2026-11-26: "Get rid of the B3 nonsense across the entire app." No owner-facing text carries a rulebook reference: the worker's
  // messages and reasons ("Player placed on IR in MFL (§B3: 50% cap relief …)", "… final year (§D2).", "(league_context_v1.md §A3)") are shown
  // without them. Every piece of text the app draws goes through esc(), so it is done once, here.
  function plain(s) {
    var t = String(s == null ? "" : s);
    if (t.indexOf("§") < 0 && !/league_context/i.test(t)) return t;   // anything without a reference is left exactly as it is
    return t
      .replace(/\s*\([^()]*league_context[^()]*\)/gi, "")                                  // "(league_context_v1.md §A3)"
      .replace(/\s*\((?:canon\s+)?(?:§\s?[\w.]+(?:\/§?\s?[\w.]+)*[\s,;]*)+\)/gi, "")       // "(§D2)", "(canon §B2/§D2)", "(§D1, §D2)"
      .replace(/\((?:canon\s+)?§\s?[\w.\/§]+\s*[:,—–-]\s*/gi, "(")                           // "(§B3: 50% cap relief" -> "(50% cap relief"
      .replace(/(?:\bcanon\s+)?§\s?[\w.]+(?:\/§?\s?[\w.]+)*\s*[:,—–-]?\s*/gi, "")            // any other "§X" or "canon §X"
      .replace(/\(\s*\)/g, "").replace(/[ \t]{2,}/g, " ").replace(/\s+([.,;:)])/g, "$1").trim();
  }
  function esc(s) {
    return plain(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // MFL writes "Last, First". "Smith-Njigba, Jaxon" -> "Jaxon Smith-Njigba". Anything else is left alone.
  function flipName(n) {
    var s = str(n);
    var i = s.indexOf(",");
    if (i < 1) return s;
    var last = s.slice(0, i).trim(), first = s.slice(i + 1).trim();
    return first ? first + " " + last : last;
  }

  // MFL's IDP positions are DE/DT/CB/S; UPS lineups and the approved screens group them as DL and DB.
  var POS_GROUP = { QB: "QB", RB: "RB", WR: "WR", TE: "TE", PK: "PK", PN: "PN", DE: "DL", DT: "DL", DL: "DL", LB: "LB", CB: "DB", S: "DB", DB: "DB" };
  var POS_ORDER = ["QB", "RB", "WR", "TE", "PK", "PN", "DL", "LB", "DB"];
  function posGroup(p) { var k = str(p).toUpperCase(); return POS_GROUP[k] || k || "?"; }

  // "Fri 10:03 PM ET" in the league's time zone, or "" if the time cannot be read.
  function etStamp(iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return "";
    try {
      var parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }).formatToParts(new Date(t));
      var m = {}; parts.forEach(function (p) { m[p.type] = p.value; });
      return m.weekday + " " + m.hour + ":" + m.minute + " " + (m.dayPeriod || "") + " ET";
    } catch (e) { return ""; }
  }

  // "Sun Nov 22, 2026, 10:22 AM ET" in the league's time zone: when the recorded snapshot was taken. "" if the time cannot be read.
  function etRecorded(iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return "";
    try {
      var parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).formatToParts(new Date(t));
      var m = {}; parts.forEach(function (p) { m[p.type] = p.value; });
      return m.weekday + " " + m.month + " " + m.day + ", " + m.year + ", " + m.hour + ":" + m.minute + " " + (m.dayPeriod || "") + " ET";
    } catch (e) { return ""; }
  }

  // R7: a capture window in the league's time zone, "10:11–10:14 PM ET" ("Sun 10:13–10:14 PM ET" with the weekday), or "" if either time cannot be read.
  function etRange(fromIso, toIso, weekday) {
    var a = Date.parse(fromIso), b = Date.parse(toIso);
    if (!isFinite(a) || !isFinite(b)) return "";
    try {
      var fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" });
      var pa = {}, pb = {};
      fmt.formatToParts(new Date(Math.min(a, b))).forEach(function (p) { pa[p.type] = p.value; });
      fmt.formatToParts(new Date(Math.max(a, b))).forEach(function (p) { pb[p.type] = p.value; });
      var x = pa.hour + ":" + pa.minute, y = pb.hour + ":" + pb.minute, d = weekday ? pa.weekday + " " : "";
      if (x === y && pa.dayPeriod === pb.dayPeriod) return d + x + " " + (pa.dayPeriod || "") + " ET";
      return d + x + (pa.dayPeriod !== pb.dayPeriod ? " " + (pa.dayPeriod || "") : "") + "–" + y + " " + (pb.dayPeriod || "") + " ET";
    } catch (e) { return ""; }
  }

  // "Sun 1:00 PM" in the league's time zone, from a Unix time in seconds, or "" if it cannot be read.
  function etKickoff(unix) {
    var n = Number(unix);
    if (!isFinite(n) || n <= 0) return "";
    try {
      var parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }).formatToParts(new Date(n * 1000));
      var m = {}; parts.forEach(function (p) { m[p.type] = p.value; });
      return m.weekday + " " + m.hour + ":" + m.minute + " " + (m.dayPeriod || "");
    } catch (e) { return ""; }
  }

  // "2025-10-04" (a calendar date already in Eastern Time) -> "Oct 4, 2025", or "" when it is not a real date. No time zone is applied here:
  // the date is written out exactly as given, so it can never shift by a day.
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function dateLabel(ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof ymd === "string" ? ymd : "");
    if (!m) return "";
    var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    var last = new Date(Date.UTC(y, mo, 0)).getUTCDate();   // days in that month (UTC, so the zone cannot matter)
    if (mo < 1 || mo > 12 || d < 1 || d > last) return "";
    return MONTHS[mo - 1] + " " + d + ", " + y;
  }

  // The common NFL abbreviation (KC, GB, SF), not MFL's spelling (KCC, GBP, SFO).
  var COMMON = { GBP: "GB", KCC: "KC", LVR: "LV", NEP: "NE", NOS: "NO", SFO: "SF", TBB: "TB", JAC: "JAX", WSH: "WAS" };
  function commonCode(code) {
    var c = String(code == null ? "" : code).trim().toUpperCase();
    return COMMON[c] || c;
  }

  return { str: str, money: money, esc: esc, plain: plain, flipName: flipName, posGroup: posGroup, POS_ORDER: POS_ORDER, etStamp: etStamp, etRecorded: etRecorded, etRange: etRange, etKickoff: etKickoff, dateLabel: dateLabel, commonCode: commonCode };
});
