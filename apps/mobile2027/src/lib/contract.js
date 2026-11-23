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
    // R9 (evidence check 2026-11-23, S/r7notes/r9d_evidence.md): when the extension year is only bound through restructured terms, the last Ext: name is
    // NOT reliably the extender of the contract in force (4 of 10 recorded cases were extended in 2026 by a later owner whose name was never appended).
    // verified: false then; the attribution is not presented, the lineage is shown only as the contract record's extension history.
    var verified = why !== "restructure_bound";
    return { years: n, year: year, yearWhy: why, by: t ? { id: t.id, name: t.name } : null, byName: last || null, verified: verified, traded: !!(verified && t && player.franchiseId && t.id !== player.franchiseId), lineage: lin };
  }
  // "Extended by The Long Haulers · 2025" | "Extended · 2026" | "Extended by Pure Greatness" | "Extended"
  // R9: an unverified attribution (restructure-bound year) reads "Extended · 2026 · extending team not verified"; the Ext: names are in the history only
  function extensionLine(e) {
    if (!e) return "";
    if (e.verified === false) return "Extended" + (e.year != null ? " · " + e.year : "") + " · extending team not verified";
    return "Extended" + (e.by ? " by " + e.by.name : "") + (e.year != null ? " · " + e.year : "");
  }

  // ---- R9 (Keith, 2026-11-23): recorded AAV, labeled by the years it applies to ----
  // The contract text's AAV is a forward-looking list, one tier per remaining stretch, this season first, and it ROLLS: once a tier's year is
  // played it drops off ("AAV 4, 24" -> "AAV 24"; Keith 2026-07-22). Canon §C4: an extension keeps this season at the old AAV and gives the added
  // years the new one. So the mapping is supported only where those rules pin it down:
  //   one tier:  this season through the last year (the whole remaining term). Not for an extension made THIS season, whose current year and added
  //              years must differ (§C4): one tier there cannot be placed.
  //   two tiers: only an extension made this season (its year is known and the term is this season plus the N added years): tier 1 -> this
  //              season, tier 2 -> the added years.
  // Anything else is "unmapped" (the amounts are shown with "years not mapped"). AAV is never computed (never TCV ÷ years).
  // -> { state: "mapped" | "unmapped" | "none", amounts: [..], lines: [{ from, to, amount }] }
  function aavYears(player, season, teams) {
    var c = parseSpecial(player && player.special), a = c.aav, y = Math.max(0, parseInt(player && player.years, 10) || 0);
    var out = { state: "none", amounts: a.slice(), lines: [] };
    if (!a.length) return out;
    out.state = "unmapped";
    if (!y) return out;
    var end = season + y - 1, n = extYears(player.type), e = n ? extension(player, season, teams) : null;
    var extNow = !!(e && e.year === season && y === n + 1);
    if (a.length === 1 && !extNow) out.lines = [{ from: season, to: end, amount: a[0] }];
    else if (a.length === 2 && extNow) out.lines = [{ from: season, to: season, amount: a[0] }, { from: season + 1, to: end, amount: a[1] }];
    if (out.lines.length) out.state = "mapped";
    return out;
  }

  // ---- R9: how this team acquired the player, from the roster read's acquisition text (kept separate from how the current contract began) ----
  // "1.05 (2025)" a Rookie Draft pick · "Auction $19,000 (2025)" · "BB $9,000" a waiver claim · "FCFS" · "Trade (2025)". The year is the one the
  // roster read states (a season, never a date); without one, no year is given. Anything else -> { kind: "other" } and is not described.
  function acquisitionOf(text) {
    var s = F.str(text).trim(), m, yr = null, ym = s.match(/\((\d{4})\)\s*$/);
    if (ym) yr = parseInt(ym[1], 10);
    if (!s) return { kind: "none", words: "", year: null };
    if ((m = s.match(/^(\d{1,2}\.\d{2})(?:\s*\(\d{4}\))?$/))) return { kind: "draft", words: "Rookie Draft, pick " + m[1], year: yr };
    if ((m = s.match(/^Auction\s+(\$[\d,]+)(?:\s*\(\d{4}\))?$/i))) return { kind: "auction", words: "Auction, " + m[1], year: yr };
    if ((m = s.match(/^BB\s+(\$[\d,]+)(?:\s*\(\d{4}\))?$/i))) return { kind: "waiver", words: "Waiver claim, " + m[1], year: yr };
    if (/^FCFS$/i.test(s)) return { kind: "waiver", words: "Waiver pickup (FCFS)", year: null };
    if (/^Trade(?:\s*\(\d{4}\))?$/i.test(s)) return { kind: "trade", words: "Trade", year: yr };
    return { kind: "other", words: "", year: null };
  }

  // ---- R9: Contract history, from the contract text and the roster read only ----
  // Events: how the current contract began (its type's source token, with the season its recorded terms start), how this team acquired him (roster
  // read), every extension in the contract's Ext: record (oldest first; only the extension in force now can carry a season, from extension()), each
  // restructure year written in the text, a tag. A trade or a restructure never adds an extending team (only Ext: names do). Nothing is dated
  // finer than a season, and a season worked out from the contract terms is marked as such (why: "terms" | "restructure"), separate from a season
  // the record states (why: "recorded"). Events with no season are listed after the dated ones, in record order.
  // -> { events: [{ kind, words, year, why, team }], complete, eligibility: "not_shown" }
  //    complete: every event has a season, the acquisition is recorded and is not a trade (a trade means earlier owners' events are not here)
  function contractHistory(player, season, teams) {
    var type = F.str(player && player.type), up = type.toUpperCase().split("-"), ev = [], k;
    var h = history(player, season), n = extYears(type), ext = n ? extension(player, season, teams) : null, acq = acquisitionOf(player && player.acquisition);
    var src = null;
    for (k = 1; k < up.length; k++) if (SOURCE_TOKENS[up[k]]) { src = SOURCE_TOKENS[up[k]]; break; }
    var startYear = h.start != null && (h.startWhy === "terms" || h.startWhy === "auction") ? h.start : null;
    // the contract's origin, when the type names it; folded into the acquisition when that is the same event (an auction or draft by this team)
    var sameAsAcq = src && ((src === "FA Auction" || src === "Expired Rookie Auction") && acq.kind === "auction" || src === "Rookie Draft" && acq.kind === "draft" || src === "Waiver Wire" && acq.kind === "waiver");
    if (src && !sameAsAcq && !n) ev.push({ kind: "origin", words: src + " contract", year: startYear, why: startYear != null ? (h.startWhy === "auction" ? "recorded" : "terms") : null });
    if (acq.kind !== "none" && acq.kind !== "other") {
      var ay = acq.year, aw = ay != null ? "recorded" : null;
      if (ay == null && sameAsAcq && startYear != null) { ay = startYear; aw = h.startWhy === "auction" ? "recorded" : "terms"; }
      ev.push({ kind: acq.kind === "trade" ? "trade" : "acquired", words: acq.kind === "trade" ? "Acquired by trade" : acq.words, year: ay, why: aw });
    }
    var lin = extLineage(player && player.special), added = n ? " (current contract, " + n + (n === 1 ? " year added)" : " years added)") : "";
    var verified = !!(ext && ext.verified !== false);
    // every Ext: name is an extension in the record; only a VERIFIED attribution ties the last one to the contract in force (a restructure-bound year
    // does not: the current extension is then its own event, "team not verified", and the names stay record-only, undated)
    lin.forEach(function (name, i) {
      var t = teamForName(name, teams), cur = verified && i === lin.length - 1;
      ev.push({ kind: "extension", words: "Extended" + (t ? " by " + t.name : " · team not identified") + (cur ? added : n && !verified ? " (in the extension record)" : ""),
        year: cur ? ext.year : null, why: cur && ext.year != null ? "terms" : null, team: t ? { id: t.id, name: t.name } : null });
    });
    if (n && (!lin.length || !verified)) ev.push({ kind: "extension", words: "Extended · " + (lin.length ? "extending team not verified" : "team not recorded") + added, year: ext ? ext.year : null, why: ext && ext.year != null ? (ext.yearWhy === "restructure_bound" ? "restructure" : "terms") : null, team: null, current: true });
    var re = /restructur(?:ed|e)\s*:?\s*(\d{4})/gi, m, seen = {};
    while ((m = re.exec(F.str(player && player.special)))) { if (!seen[m[1]]) { seen[m[1]] = 1; ev.push({ kind: "restructure", words: "Restructured", year: parseInt(m[1], 10), why: "recorded" }); } }
    if (up[0] === "TAG") ev.push({ kind: "tag", words: "Tagged", year: h.start != null && h.startWhy === "terms" ? h.start : null, why: h.start != null && h.startWhy === "terms" ? "terms" : null });
    if (up.indexOf("MYM") >= 0) ev.push({ kind: "mym", words: "Mid-Year Multi", year: null, why: null });
    // dated events by season (ties keep record order), then the undated ones in record order
    var dated = ev.map(function (e, i) { return { e: e, i: i }; }).filter(function (x) { return x.e.year != null; }).sort(function (a, b) { return (a.e.year - b.e.year) || (a.i - b.i); }).map(function (x) { return x.e; });
    var undated = ev.filter(function (e) { return e.year == null; });
    // extTeams: the extending teams the record supports (Ext: names matched to a team); extTeamsComplete is false when the contract in force is an
    // unverified (restructure-bound) extension, whose extender may be missing from the record
    var extTeams = lin.map(function (nm) { return teamForName(nm, teams); }).filter(Boolean).map(function (t) { return { id: t.id, name: t.name }; });
    return { events: dated.concat(undated), complete: !undated.length && acq.kind !== "none" && acq.kind !== "other" && acq.kind !== "trade" && (!n || verified),
      extTeams: extTeams, extTeamsComplete: !n || verified, eligibility: "not_shown" };
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

  // ---- R8 (Keith, 2026-11-23): which cut rule the Worker applied, from its own `basis` (never recomputed here) ----
  // -> { rule: "guarantee" | "none" | "onek" | "taxi" | "unknown", tag: the short column label or "", words: one owner sentence }
  //   guarantee: §D1 (TCV × 75%) − earned (basis guarantee_minus_earned; no_penalty_zero when earned has reached the guarantee)
  //   none:      §D2 no guarantee: a 1-year original contract under $5K, or a waiver pickup of $4K or less in its final year
  //   onek:      §D1 sub-$5K TCV rule: $1K while two or more years remain, $0 in the final year (full_year_1k_contract is its $1K-every-year class)
  //   taxi:      §D2 taxi-eligible cut, cap-free
  // A basis this file does not know is "unknown": the Worker's amount is still shown, and no rule is named for it.
  var CUT_RULES = {
    guarantee_minus_earned: ["guarantee", "", "Guarantee rule: the guaranteed amount not yet earned."],
    no_penalty_zero: ["guarantee", "Fully earned", "Guarantee rule: the guaranteed amount is fully earned, so nothing is owed."],
    one_year_under_5k_exempt: ["none", "No guarantee", "No-guarantee rule: a one-year original contract under $5K is cut free."],
    ww_under_5k_exempt: ["none", "No guarantee", "No-guarantee rule: a waiver pickup of $4K or less in its final year is cut free."],
    ww_under_5k_earned_na: ["none", "No guarantee", "No-guarantee rule: a waiver pickup of $4K or less in its final year is cut free."],
    full_year_1k_contract: ["onek", "$1K rule", "$1K drop rule: a contract worth under $5K costs $1K to cut while two or more years remain, and nothing in its final year."],
    tcv_under_5k_flat: ["onek", "$1K rule", "$1K drop rule: a contract worth under $5K costs $1K to cut while two or more years remain, and nothing in its final year."],
    tcv_under_5k_final_year_exempt: ["onek", "$1K rule", "$1K drop rule: a contract worth under $5K costs $1K to cut while two or more years remain, and nothing in its final year."],
    taxi_exempt: ["taxi", "Taxi", "Taxi rule: a taxi-eligible player is cut cap-free."],
    taxi_callup_exempt: ["taxi", "Taxi", "Taxi rule: a taxi-eligible player is cut cap-free."],
    taxi_eligible_exempt: ["taxi", "Taxi", "Taxi rule: a taxi-eligible player is cut cap-free."]
  };
  function cutRule(row) {
    var b = row && typeof row.basis === "string" ? row.basis : "";
    var r = Object.prototype.hasOwnProperty.call(CUT_RULES, b) ? CUT_RULES[b] : null;
    if (!r) return { rule: "unknown", tag: "", words: "The cap calculation names a rule this preview does not know." };
    // a guarantee-rule charge of $0 that is not no_penalty_zero still reads as fully earned
    var tag = r[0] === "guarantee" && finite(row.penalty) && row.penalty === 0 ? "Fully earned" : r[1];
    return { rule: r[0], tag: tag, words: r[2] };
  }

  // ---- R8: Contract Type, Contract Source, later changes and salary structure, from the recorded type and contract text only ----
  // The MFL contract type is a UPS string ("Vet-FAA-FL", "Rookie-Draft", "Vet-Ext2-BL", "Tag", ...; canon §A3.1, §C). Each part is read only when the
  // data states it; anything else is null (the screen says "Not recorded"). Nothing is guessed from a player's history.
  var SOURCE_TOKENS = { DRAFT: "Rookie Draft", FAA: "FA Auction", ERA: "Expired Rookie Auction", WW: "Waiver Wire" };
  function describe(player) {
    var type = F.str(player && player.type), parts = type.split("-"), up = parts.map(function (x) { return x.toUpperCase(); });
    var acq = F.str(player && player.acquisition).trim();
    var out = { type: null, source: null, sourceNote: null, changes: [], structure: null };
    out.type = up[0] === "VET" ? "Veteran" : up[0] === "ROOKIE" ? "Rookie" : null;
    // the source: the type's own acquisition token, else the roster read's acquisition when it names the path that began this contract
    for (var i = 1; i < up.length; i++) if (SOURCE_TOKENS[up[i]]) { out.source = SOURCE_TOKENS[up[i]]; break; }
    var fcfs = /^FCFS$/i.test(acq), bb = /^BB\s+\$[\d,]+(?:\s*\(\d{4}\))?$/i.test(acq), draft = /^\d{1,2}\.\d{2}(?:\s*\(\d{4}\))?$/.test(acq), auction = /^Auction\s+\$[\d,]+(?:\s*\(\d{4}\))?$/i.test(acq);
    if (!out.source) out.source = draft ? "Rookie Draft" : bb || fcfs ? "Waiver Wire" : auction ? "Auction" : null;
    if (out.source === "Waiver Wire" && fcfs) out.source = "Waiver Wire (FCFS)";
    if (!out.source && /^Trade\b/i.test(acq)) out.sourceNote = "Acquired by trade";
    // R9 (Keith, 2026-11-23): an extension begins the current contract, so its source is "Extension" (how many years it added is `extended`); how
    // this team acquired the player stays a separate fact (acquisitionOf), never folded into the source
    var n = extYears(type);
    out.extended = n || null;
    if (n) { out.source = "Extension"; out.sourceNote = null; }
    // later changes, each only from its own token
    if (up.indexOf("MYM") >= 0) out.changes.push("Mid-Year Multi");
    var rs = restructureYear(player && player.special);
    if (rs != null) out.changes.push("Restructured " + rs);
    if (up[0] === "TAG") out.changes.push("Tag");
    // salary structure: the FL/BL suffix; without one, Flat only where the recorded terms or canon make it so
    var last = up[up.length - 1], c = parseSpecial(player && player.special);
    if (last === "FL") out.structure = "Front-loaded";
    else if (last === "BL") out.structure = "Back-loaded";
    else {
      var ys = [], k;
      for (k = 1; c.y[k] != null; k++) ys.push(c.y[k]);
      if (c.cl === 1 || up.indexOf("MYM") >= 0) out.structure = "Flat";            // §C: a 1-year deal and a MYM are never loaded
      else if (n === 1) out.structure = "Flat";                                       // §C2 (2026-09-29): a plain Ext1 has one new year
      else if (n === 2) {                                                             // §C4: a plain Ext2 compares its own two new years
        var a = ys.length >= 2 && c.cl != null && ys.length === c.cl ? ys.slice(-2) : null;
        out.structure = !a ? null : a[0] === a[1] ? "Flat" : a[0] > a[1] ? "Front-loaded" : "Back-loaded";
      } else if (ys.length && c.cl != null && ys.length === c.cl && ys.every(function (v) { return v === ys[0]; })) out.structure = "Flat";
    }
    return out;
  }

  return { moneyToken: moneyToken, parseSpecial: parseSpecial, schedule: schedule, history: history, restructureYear: restructureYear, extYears: extYears,
    extLineage: extLineage, teamForName: teamForName, extension: extension, extensionLine: extensionLine, aavYears: aavYears, acquisitionOf: acquisitionOf, contractHistory: contractHistory, LEGACY_EXT_NAMES: LEGACY_EXT_NAMES, earned: earned, remainingGuarantee: remainingGuarantee, cutNow: cutNow,
    cutRule: cutRule, CUT_RULES: CUT_RULES, describe: describe };
});
