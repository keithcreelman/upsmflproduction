/* UPS 2027 beta (PR A): cap adjustments. Pure functions: no network, no storage, no DOM.

   What an owner may see about an adjustment is five things: the player (only when an authoritative player id resolves, or the charge is on UPS's frozen
   reviewed list (lib/reviewed_names.js, kept apart from direct resolution; Keith's ruling 2026-11-22), otherwise "Player Unknown"), the season, the signed
   amount, the category and, for a cut penalty, the CUT DATE (an Eastern Time calendar date, only from a verified source: the drop time inside a player-id key, the
   reviewed list, or the 2027 ledger's drop time; otherwise null). Everything else a source sends (descriptions, notes, other
   teams) is read here, used to decide those things, and discarded: this file never returns a source string. A row's player id is always kept when the row
   carries one, so the screen can name him from MFL's complete player list (by id, never by roster membership).

   Categories (owner ruling 2026-11-21): Cut Penalty, Traded Salary, FA Auction Fine, Rounding, Other.
   - A category is assigned only by an EXACT, full match of a machine-written pattern (a keyword such as "trade" or "drop" inside other
     text is not evidence), or, for 2027, by the kind of ledger row the Worker returns.
   - "Other" means a VERIFIED adjustment (valid signed amount, team and season) whose category matches nothing. A malformed record is
     "unverified": it is counted, kept out of every category and total, and never treated as $0 or as Other.
   - The season is the year of the read that carried the row. It is never taken from text: 31 of 41 recorded cut penalties carry a 2025
     add/drop id yet are 2026 charges.
   - A player is named in exactly two ways, never from description text. DIRECT: the first part of the ledger key (<player id>_<10-digit time>),
     accepted only in exactly that form and only when the id resolves to a name through `resolveName` (item.nameSource "direct"). REVIEWED MAPPING: an
     add/drop id (adddrop2025_...) carries no player id; if its token, team, season and posted amount all match a row of the reviewed list, that row names
     him (item.nameSource "reviewed_mapping"). Anything else: Player Unknown. */
(function (root, factory) {
  var req = typeof require === "function";
  var api = factory(req ? require("./format.js") : root.UPS2027.format, req ? require("./contract.js") : root.UPS2027.contract, req ? require("./reviewed_names.js") : root.UPS2027.reviewedNames);
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.UPS2027 = root.UPS2027 || {}; root.UPS2027.adjust = api; }
})(typeof self !== "undefined" ? self : this, function (F, C, N) {
  "use strict";

  var CATEGORIES = ["Cut Penalty", "Traded Salary", "FA Auction Fine", "Rounding", "Other"];
  var UNKNOWN_PLAYER = "Player Unknown";

  function pad4(v) { var d = String(v == null ? "" : v).trim(); return /^\d{1,4}$/.test(d) ? ("0000" + d).slice(-4) : ""; }
  // A signed amount: a finite number, or a string that is exactly a signed decimal. Anything else (blank, text, null, boolean) is unknown.
  function amountOf(v) {
    if (typeof v === "number") return isFinite(v) ? v : null;
    if (typeof v === "string" && /^-?\d+(?:\.\d+)?$/.test(v.trim())) return Number(v.trim());
    return null;
  }

  // ---- exact, full patterns of the machine-written descriptions (worker/src/index.js saladjClassify documents them) ----
  var P_TRADE = /^UPS traded salary settlement \(([A-Za-z0-9_. -]{1,60})\): net [+-]?\d+(?:\.\d+)?K$/;
  var P_ROUND = /^UPS drop penalty rounding (.+) -?\d+(?:\.\d+)? id:ups_drop_rounding_\d{4}_\d{4}$/;
  var P_RULE2 = /^UPS RULE 2 missed nomination \d{4}-\d{2}-\d{2} offense \d+(?: id:\S+)?$/;
  var P_CUT = /^UPS drop penalty (.+) -?\d+(?:\.\d+)? id:(\S+)$/;
  var K_PLAYER = /^(\d{1,9})_(\d{10})$/, K_ADDDROP = /^adddrop\d{4}_\d+\.\d+$/;

  // text -> { category, idForm: "player" | "adddrop" | null, playerId } or null when no exact pattern matches. The text is not returned.
  function classify(text) {
    var s = typeof text === "string" ? text.trim() : "";
    if (!s) return null;
    if (P_TRADE.test(s)) return { category: "Traded Salary", idForm: null, playerId: null };
    if (P_ROUND.test(s)) return { category: "Rounding", idForm: null, playerId: null };
    if (P_RULE2.test(s)) return { category: "FA Auction Fine", idForm: null, playerId: null };
    var m = P_CUT.exec(s);
    if (m) { // a cut penalty only with one of the two machine-written id forms; any other id means the text is not the exact pattern
      var key = m[2], pm = K_PLAYER.exec(key);
      if (pm) return { category: "Cut Penalty", idForm: "player", playerId: pm[1], key: key };
      if (K_ADDDROP.test(key)) return { category: "Cut Penalty", idForm: "adddrop", playerId: null, key: key };
    }
    return null;
  }

  // ---- cut dates (Eastern Time) ----
  // A Unix time (seconds, or milliseconds) -> the Eastern Time calendar date "YYYY-MM-DD", or null when it is not a plausible whole-number time
  // (seconds between 1,500,000,000 and 2,000,000,000). A date is never guessed: anything else is null and the screen says "Cut date not recorded".
  var ET_DATE = typeof Intl !== "undefined" && Intl.DateTimeFormat ? new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }) : null;
  function etDate(v) {
    var n = typeof v === "number" ? v : typeof v === "string" && /^\d{10,13}$/.test(v.trim()) ? Number(v.trim()) : NaN;
    if (!isFinite(n) || Math.floor(n) !== n) return null;
    var sec = n >= 1e11 ? n / 1000 : n;                    // a 13-digit value is milliseconds
    if (!(sec >= 1500000000 && sec <= 2000000000) || !ET_DATE) return null;
    var m = {};
    try { ET_DATE.formatToParts(new Date(Math.floor(sec) * 1000)).forEach(function (p) { m[p.type] = p.value; }); } catch (e) { return null; }
    return m.year && m.month && m.day ? m.year + "-" + m.month + "-" + m.day : null;
  }
  // An ISO time WITH a time zone ("2026-08-08T13:26:53.000Z") -> the Eastern Time date; a date with no time or no zone is not enough to place it on a day.
  function etDateFromIso(s) {
    if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(s.trim())) return null;
    var ms = Date.parse(s.trim());
    return isFinite(ms) ? etDate(Math.round(ms / 1000) * 1000) : null;
  }

  function zeroByCat() { var o = {}; CATEGORIES.forEach(function (c) { o[c] = 0; }); return o; }
  function newResult(season) {
    return { season: season, items: [], unverified: 0, unverifiedWhy: {}, duplicates: 0, byCategory: zeroByCat(), total: 0, reconciled: false, mismatch: null };
  }
  function addUnverified(res, why) { res.unverified++; res.unverifiedWhy[why] = (res.unverifiedWhy[why] || 0) + 1; }
  function finish(res, expectedTotal) {
    res.items.forEach(function (it) { res.byCategory[it.category] += it.amount; res.total += it.amount; });
    var exp = amountOf(expectedTotal);
    if (exp == null) { res.reconciled = false; res.mismatch = "no total to reconcile to"; }
    else if (res.unverified > 0) { res.reconciled = false; res.mismatch = res.unverified + " record" + (res.unverified === 1 ? "" : "s") + " could not be verified"; }
    else if (Math.abs(res.total - exp) > 0.5) { res.reconciled = false; res.mismatch = "the items do not add up to the total"; }
    else res.reconciled = true;
    return res;
  }

  // ---------- 2026 (the roster read): the team's posted MFL adjustment rows ----------
  // rows: summary.salary_adjustment_raw_rows; o: { fid, season, total (summary.salary_adjustment_total_dollars), resolveName(id) }.
  function parseTeamRows(rows, o) {
    var res = newResult(o.season), seen = {};
    if (!Array.isArray(rows)) { res.unverified = 0; res.reconciled = false; res.mismatch = "no adjustment rows were read"; res.unavailable = true; return res; }
    rows.forEach(function (r) {
      var amt = amountOf(r && r.amount), fid = pad4(r && r.franchise_id);
      if (amt == null) return addUnverified(res, "amount");
      if (!fid || fid !== o.fid) return addUnverified(res, "team");
      if (!(o.season >= 2000)) return addUnverified(res, "season");
      var text = typeof (r && r.explanation) === "string" ? r.explanation.trim() : "";
      var cl = classify(text), tok = cl && cl.key ? cl.key : ((/ id:(\S+)/.exec(text) || [])[1] || null);   // the id classify validated, not just the first " id:" in the text
      if (tok) { // the same machine-written id with the same amount is the same record; rows without an id are never merged
        var k = tok + "|" + amt;
        if (seen[k]) { res.duplicates++; return; }
        seen[k] = true;
      }
      var item = { category: cl ? cl.category : "Other", amount: amt, season: o.season, playerId: null, playerName: null, nameSource: null, cutDate: null };
      if (cl && cl.idForm === "player") {
        // the row's own player id is always kept (the screen can name him later from the complete player list); a roster-resolved name is "direct"
        item.playerId = cl.playerId;
        if (typeof o.resolveName === "function") { var nm = o.resolveName(cl.playerId); if (nm) { item.playerName = nm; item.nameSource = "direct"; } }
        item.cutDate = etDate(Number(K_PLAYER.exec(cl.key)[2]));   // the 10 digits are the drop's Unix time (verified equal to MFL's own drop record, 10 of 10)
      } else if (cl && cl.idForm === "adddrop" && tok && N) { // the reviewed list: token, team, season and posted amount must all match
        var rv = N.lookup(cl.key, fid, o.season, amt);
        if (rv) { item.playerId = rv.id; item.playerName = rv.name; item.nameSource = "reviewed_mapping"; item.cutDate = /^\d{4}-\d{2}-\d{2}$/.test(rv.cutDate || "") ? rv.cutDate : null; }
      }
      res.items.push(item);
    });
    return finish(res, o.total);
  }

  // ---------- 2027 (the next-season ledger): GET /api/cap-adjustments/next-season?YEAR=2026 ----------
  // json: the answer; o: { fid, season (the year the rows apply to), resolveName }. A failed, unparsable or unresolved answer is an ERROR: it is
  // never "no adjustments". An answer with ok and zero rows for the team is "none recorded". Held-unpriced and needs-review rows are counted,
  // never priced, and make the answer incomplete.
  function parseNextSeason(json, o) {
    if (!json || typeof json !== "object" || json.ok !== true || !Array.isArray(json.rows)) {
      return { state: "error", why: json && json.error === "auction_start_unresolved" ? "unresolved_start" : "unexpected" };
    }
    var res = newResult(o.season), seen = {}, ledgerTotal = null;
    var by = json.by_fid && typeof json.by_fid === "object" ? json.by_fid[o.fid] : null;
    if (by && amountOf(by.total) != null) ledgerTotal = amountOf(by.total);
    res.inMfl = 0;
    json.rows.forEach(function (r) {
      if (pad4(r && r.franchise_id) !== o.fid) return;
      var amt = amountOf(r && r.amount);
      if (amt == null) return addUnverified(res, "amount");
      if (Number(r && r.applies_to_season) !== o.season) return addUnverified(res, "season");
      if (r && r.in_mfl === true) { res.inMfl++; return addUnverified(res, "already_on_mfl"); } // may overlap MFL's own rows: not counted until that can be checked
      var kind = r && typeof r.kind === "string" ? r.kind.trim() : "";
      var category = kind === "Drop (next season)" ? "Cut Penalty" : kind === "RULE 2 fine (next season)" ? "FA Auction Fine" : "Other";
      var pid = r && /^\d{1,9}$/.test(String(r.player_id == null ? "" : r.player_id)) ? String(r.player_id) : null;
      var key = category + "|" + String(r && (r.player_id || r.dropped_at_iso || "")) + "|" + amt;
      if (pid && r.dropped_at_iso) { if (seen[key + "|" + r.dropped_at_iso]) { res.duplicates++; return; } seen[key + "|" + r.dropped_at_iso] = true; }
      var item = { category: category, amount: amt, season: o.season, playerId: null, playerName: null, nameSource: null, cutDate: null };
      if (category === "Cut Penalty") {   // only a drop has a player and a cut date; a fine or any other row never does
        if (pid) {
          item.playerId = pid;   // always kept, so the screen can name him from the complete player list
          if (typeof o.resolveName === "function") { var nm = o.resolveName(pid); if (nm) { item.playerName = nm; item.nameSource = "direct"; } }
        }
        item.cutDate = etDateFromIso(r && r.dropped_at_iso);
      }
      res.items.push(item);
    });
    var waiting = Array.isArray(json.held_unpriced) ? json.held_unpriced.filter(function (h) { return pad4(h && h.franchise_id) === o.fid; }).length : 0;
    var review = Array.isArray(json.needs_review) ? json.needs_review.filter(function (h) { return pad4(h && h.franchise_id) === o.fid; }).length : 0;
    finish(res, ledgerTotal == null ? 0 : ledgerTotal);
    if (ledgerTotal == null && res.items.length === 0 && res.unverified === 0) res.reconciled = true; // the ledger names no total for a team with no rows
    res.state = "ok"; res.waiting = waiting; res.review = review;
    res.complete = waiting === 0 && review === 0 && res.unverified === 0;
    return res;
  }

  // What the 2027 figures do and do not establish, kept in three separate parts so one pending check is never read as "the amounts are wrong".
  var NEXT_SEASON_GAP = {
    completeness: "Source completeness is not confirmed: the UPS ledger lists the cuts it recorded, and the check that each one was priced from a complete roster snapshot is still pending, so the list may be missing a charge.",
    reconciliation: "Reconciliation: the listed amounts add up to the ledger’s own team total. They are not on MFL until the rollover, so there is no MFL figure to match yet.",
    calculation: "Calculation: each amount is UPS’s cut-charge calculation, stored when the cut was recorded. This preview does not recompute it, and no per-charge certification exists yet. Nothing here says an amount is wrong."
  };

  // ---------- the 2026 cap charge, built from the roster the page already holds ----------
  // team: a model team (players with status and salary); sum: { capTotal, adjTotal, unresolved } from the roster read. `capTotal` is the Front
  // Office's cap hits (salaries with taxi at $0 and injured reserve at half); the adjustments are a separate total. The cap charge is the two
  // together. The salary lines are shown only if they add up exactly to `capTotal`; otherwise the totals stay and the lines are hidden.
  function capBreakdown(team, sum) {
    var rec = 0, n = 0, taxi = 0, taxiN = 0, ir = 0, irN = 0, missing = 0;
    team.players.forEach(function (p) {
      if (p.status === "gone") return;
      if (p.salary == null) { missing++; return; }
      rec += p.salary; n++;
      if (p.status === "taxi") { taxi += p.salary; taxiN++; }
      else if (p.status === "ir") { ir += p.salary; irN++; }
    });
    var hits = rec - taxi - ir / 2;
    var ok = !!sum && !sum.unresolved && sum.capTotal != null && missing === 0 && Math.abs(hits - sum.capTotal) < 0.5;
    var charge = !!sum && !sum.unresolved && sum.capTotal != null && sum.adjTotal != null ? sum.capTotal + sum.adjTotal : null;
    return { recorded: rec, recordedN: n, taxi: taxi, taxiN: taxiN, ir: ir, irN: irN, irRelief: ir / 2, capHits: hits, missing: missing, ok: ok, capCharge: charge };
  }

  // ---------- adjusted commitments by year ----------
  // Cap hits for the k-th season ahead: active at the scheduled salary, taxi $0 (planning assumption: current taxi players stay on taxi),
  // injured reserve half in the current season and FULL in later seasons (no future injury relief is projected). A year with an unrecorded
  // amount is incomplete, never counted as $0. Adjustments: this season from the roster read; next season from the ledger when it loaded;
  // later seasons are unknown.
  function commitments(team, season, adjThis, adjNext, years) {
    var out = [], n = years || 3;
    for (var k = 0; k < n; k++) {
      var hits = 0, unknown = 0;
      team.players.forEach(function (p) {
        if (p.status === "gone") return;
        var sch = C.schedule(p, season);
        if (!sch.rows.length) { unknown++; return; } // no contract years recorded: his amounts are unknown, never an ended contract
        if (k >= sch.rows.length) return; // that contract has ended
        var amt = sch.rows[k].amount;
        if (amt == null) { unknown++; return; }
        if (p.status === "taxi") return;
        hits += p.status === "ir" && k === 0 ? amt / 2 : amt;
      });
      var adj = k === 0 ? adjThis : k === 1 ? adjNext : null;
      var a = adj && adj.known ? adj.total : null;
      out.push({ year: season + k, hits: hits, hitsIncomplete: unknown > 0, unknownCount: unknown, adj: a, adjState: adj ? adj.state : "unsupported", total: unknown === 0 && a != null ? hits + a : null });
    }
    return out;
  }

  // Resolves a player id to a name from the roster the page holds, then from an optional id -> name map (a read the page makes for another reason).
  function nameResolver(model, extra) {
    return function (id) {
      var p = model && model.byId && model.byId[String(id)];
      if (p && p.name) return p.name;
      var e = extra && extra[String(id)];
      return e ? String(e) : null;
    };
  }

  return {
    CATEGORIES: CATEGORIES, UNKNOWN_PLAYER: UNKNOWN_PLAYER, NEXT_SEASON_GAP: NEXT_SEASON_GAP,
    etDate: etDate, etDateFromIso: etDateFromIso, classify: classify, amountOf: amountOf, parseTeamRows: parseTeamRows, parseNextSeason: parseNextSeason,
    capBreakdown: capBreakdown, commitments: commitments, nameResolver: nameResolver
  };
});
