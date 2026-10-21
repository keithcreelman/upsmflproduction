/* Player modal (the Front Office slide-over) — Phase 1 facts (#1338). Pure: no fetch, no DOM.

   BIO
   - ONE UPS Draft record: site/rookies/rookie_draft_history.json (every UPS
     rookie draft 2012–2026, by player id). The worker's in-window fields
     (ups_draft_round / ups_draft_year, only 2024–2026) must agree with it;
     if they don't, or the file didn't load, the record is "unknown", never
     a guess. The UPS Draft line AND the taxi reason both read this record,
     so they can't contradict.
   - Taxi reasons stay distinct (canon §A1 L97/104, §B2 L344/351/358/360):
     not a UPS Rookie Draft pick · Round 1 pick · taxi window ended (3 league
     years) · permanently promoted · no longer on the rookie-draft contract.
     When league records disagree (the worker says eligible but the draft
     record rules it out), the answer is "Unknown", never one side's claim.
   - NFL bio: missing data reads "Unknown" (or "Loading…"), never "Undrafted".
     MFL lists some drafted players' draft team as "FA"; that team is omitted.

   STATS AND GAME LOG
   - The CURRENT season is MFL's own scoring (playerScores W=ALL, the phone's
     source): the headline, the season table's current row and the Game
     Log's current weeks all read it, so they can't disagree. The database
     copy of the current season lags MFL by a sync and is not shown.
   - EARLIER seasons come from the league database (player bundle). A rank
     there is shown only when the rank's own total equals the row's total;
     otherwise "—" with the reason (the rank table counts weeks the database
     is missing).
   - "Highest-scoring season" = most total points among completed seasons,
     by the totals in the table. No z-scores, no tiers, no APW.
   - ONE Game Log schema for every season: Wk (P = UPS playoff week) · Pts
     (or why there is none) · Pos Rk · UPS status · Team, newest week first,
     with the season's coverage gaps said out loud.

   ACTIONS
   - writeSpec(kind, facts): what the confirmation shows before ANY write —
     player, exact action, roster consequence, salary/cap consequence and
     whether it can be undone. Every write path in front_office.js asks for
     one (foConfirmWrite); a kind without a spec cannot be confirmed.
*/
(function (root) {
  "use strict";

  function str(v) { return v == null ? "" : String(v).trim(); }
  function int(v) { var n = parseInt(v, 10); return isFinite(n) ? n : 0; }

  // history = the rookie-history entry for this player (or null); worker = { round, year } from /roster-workbench.
  function upsDraftRecord(history, worker, historyOk) {
    var w = { round: int(worker && worker.round), year: int(worker && worker.year) };
    if (!historyOk) return { state: "unknown", why: "The UPS draft history didn’t load." };
    var h = history && int(history.round) > 0 ? history : null;
    if (h) {
      if (w.round && (w.round !== int(h.round) || (w.year && w.year !== int(h.season)))) {
        return { state: "conflict", why: "The draft history says " + int(h.season) + " Rd " + int(h.round) + "; the roster record says " + (w.year || "?") + " Rd " + w.round + "." };
      }
      return { state: "pick", season: int(h.season), round: int(h.round), pick: int(h.pick) || null };
    }
    if (w.round) return { state: "conflict", why: "The roster record has a " + (w.year || "") + " Rd " + w.round + " pick the draft history doesn’t list." };
    return { state: "none" };
  }

  function upsDraftText(rec) {
    if (!rec) return "Unknown";
    if (rec.state === "pick") return (rec.season ? rec.season + " · " : "") + "Rd " + rec.round + (rec.pick ? ", Pick " + rec.pick : "");
    if (rec.state === "none") return "Not a UPS Rookie Draft pick";
    return "Unknown";
  }

  // p: { taxiEligible, taxiPermanentPromotion, type, isTaxi, isIr, taxiCallupsMax, taxiCallupsUsed }; season = the league year.
  function taxiStatus(p, rec, season) {
    season = int(season);
    if (!rec || rec.state === "unknown" || rec.state === "conflict") {
      return { eligible: null, text: "Unknown", note: (rec && rec.why) || "The UPS draft record couldn’t be confirmed.", reasons: [] };
    }
    var reasons = [];
    if (rec.state === "none") reasons.push("not a UPS Rookie Draft pick");
    else {
      if (rec.round === 1) reasons.push("Round 1 pick");
      if (rec.season && season - rec.season >= 3) reasons.push("taxi window ended (" + rec.season + " draft)");
    }
    if (p.taxiPermanentPromotion) reasons.push("permanently promoted");
    if (reasons.length) {
      if (p.taxiEligible) {
        return { eligible: null, text: "Unknown", note: "League records disagree: the roster record says eligible, the draft record says " + reasons[0] + ".", reasons: reasons };
      }
      return { eligible: false, text: "Not eligible · " + reasons[0], note: reasons.length > 1 ? "Also: " + reasons.slice(1).join("; ") + "." : "", reasons: reasons };
    }
    // A Round 2+ pick inside the window, never promoted.
    if (p.taxiEligible) {
      var max = int(p.taxiCallupsMax) || 3, used = int(p.taxiCallupsUsed), left = Math.max(0, max - used);
      var where = p.isTaxi ? "on taxi" : (p.isIr ? "on IR" : "on the active roster");
      return { eligible: true, text: left + " of " + max + " call-ups left · " + where, reasons: [],
        note: "Each completed week on the active roster uses one; the 4th makes the promotion permanent." + (!p.isTaxi && !p.isIr ? " This week counts once it is over." : "") };
    }
    if (!/^rookie-draft$/i.test(str(p.type))) {
      return { eligible: false, text: "Not eligible · no longer on the rookie-draft contract", note: "Cut and reacquired, or re-signed (a trade keeps eligibility).", reasons: ["no longer on the rookie-draft contract"] };
    }
    return { eligible: false, text: "Not eligible · reason not recorded", note: "League records mark the player ineligible without a reason.", reasons: ["reason not recorded"] };
  }

  // MFL players DETAILS → display text. state: "loading" | "error" | "ok".
  function nflDraftText(d, state) {
    if (state === "loading") return "Loading…";
    if (state !== "ok" || !d) return "Unknown";
    var rd = int(d.draft_round);
    if (rd <= 0) return "Unknown";
    var team = str(d.draft_team).toUpperCase();
    var parts = [];
    if (d.draft_year) parts.push(str(d.draft_year));
    parts.push("Rd " + rd + (d.draft_pick ? ", Pick " + str(d.draft_pick) : ""));
    if (team && team !== "FA") parts.push(team);
    return parts.join(" · ");
  }
  function heightText(inches, state) {
    if (state === "loading") return "Loading…";
    var n = int(inches);
    return n > 0 ? (Math.floor(n / 12) + "'" + (n % 12) + '"') : "Unknown";
  }
  function weightText(w, state) {
    if (state === "loading") return "Loading…";
    return int(w) > 0 ? int(w) + " lbs" : "Unknown";
  }
  function bornText(birthdate, state, nowMs) {
    if (state === "loading") return "Loading…";
    var ts = int(birthdate);
    if (ts <= 0) return "Unknown";
    var d = new Date(ts * 1000);
    var mo = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    var age = Math.floor(((nowMs || Date.now()) - d.getTime()) / (365.25 * 86400000));
    return mo[d.getUTCMonth()] + " " + d.getUTCDate() + ", " + d.getUTCFullYear() + " (age " + age + ")";
  }
  function plainText(v, state) {
    if (state === "loading") return "Loading…";
    return str(v) || "Unknown";
  }

  // ── Write confirmations ────────────────────────────────────────────
  function usd(n) {
    var v = Number(n);
    if (!isFinite(v)) return "not priced";
    return "$" + Math.round(v).toLocaleString("en-US");
  }
  function yearsText(yrs, season) {
    season = int(season);
    return (yrs || []).map(function (v, i) { return (season ? season + i : "Y" + (i + 1)) + " " + usd(v); }).join(" · ");
  }
  var CONTRACT_UNDO = "Not from here. The change is logged, and only the commissioner can revert it.";
  var WRITE_KINDS = ["drop_player", "activate_ir", "deactivate_ir", "promote_taxi", "demote_taxi",
    "myac", "mym", "extension", "extension_loaded", "rookie_option", "restructure", "untag", "tag"];

  // facts: { name, team, salary, capHit, isTaxi, activeN, activeMax, activeMin, taxiN, taxiMax, season, dry,
  //   penalty: { amount, note, nextSeason }, ir: { state, designation, why }, callups: { used, max, pending },
  //   contract: { status, years: [y1, y2, …], tcv, gtd, priorStatus } }
  // → { kind, title, player, action, roster, cap, reversible, details[], confirmLabel, danger } or null (unknown kind).
  function writeSpec(kind, f) {
    f = f || {};
    var name = str(f.name) || "this player", team = str(f.team) || "the team";
    var a = int(f.activeN), amax = int(f.activeMax), amin = int(f.activeMin) || 27, t = int(f.taxiN), tmax = int(f.taxiMax) || 10;
    var salary = Number(f.salary) || 0, hit = Number(f.capHit) || 0, half = Math.round(salary / 2);
    var c = f.contract || {}, yrs = c.years || [], details = [];
    var spec = { kind: kind, player: name + " · " + team, details: details, danger: false };
    function active(delta) { return "active " + a + " → " + (a + delta) + (amax ? " (limit " + amax + ")" : ""); }
    if (kind === "drop_player") {
      var pen = f.penalty || {};
      spec.title = "Drop " + name;
      spec.action = "Drop " + name + " from " + team + ".";
      spec.roster = f.isTaxi ? "Leaves the taxi squad: taxi " + t + " → " + (t - 1) + "." : "Leaves the roster: " + active(-1) + ".";
      spec.cap = (hit ? "This season’s " + usd(hit) + " cap hit comes off. " : "") +
        (isFinite(Number(pen.amount)) ? "Drop penalty " + usd(pen.amount) + (pen.nextSeason ? ", charged to next season’s cap." : ", charged to this season’s cap.")
          : "Drop penalty couldn’t be priced here.");
      spec.reversible = "No. Getting the player back takes a new claim or bid.";
      if (str(pen.note)) details.push(str(pen.note));
      spec.confirmLabel = "Drop"; spec.danger = true;
    } else if (kind === "activate_ir") {
      spec.title = "Activate " + name + " from IR";
      spec.action = "Move " + name + " from IR to the active roster.";
      spec.roster = "IR → active roster: " + active(1) + ".";
      spec.cap = "Cap hit " + usd(half) + " → " + usd(salary) + " (the 50% IR relief ends).";
      spec.reversible = "Yes, while the player has an IR-eligible designation: Place on IR moves the player back.";
      spec.confirmLabel = "Activate";
    } else if (kind === "deactivate_ir") {
      var ir = f.ir || {};
      spec.title = "Place " + name + " on IR";
      spec.action = "Move " + name + " from the active roster to IR.";
      spec.roster = "Active roster → IR: active " + a + " → " + (a - 1) + ". IR doesn’t count toward the active limits" +
        (a - 1 < amin ? "; " + (a - 1) + " is below the " + amin + "-player minimum" : "") + ".";
      spec.cap = "Cap hit " + usd(salary) + " → " + usd(half) + " (50% IR relief).";
      spec.reversible = "Yes. Activate IR brings the player back.";
      details.push(ir.state === "eligible" ? "MFL lists “" + str(ir.designation) + "”, an IR-eligible designation."
        : ir.state === "ineligible" ? "MFL lists no IR-eligible designation; the server will refuse this."
        : "IR eligibility isn’t verified here" + (str(ir.why) ? " (" + str(ir.why) + ")" : "") + "; the server checks it and writes nothing if it refuses.");
      spec.confirmLabel = "Place on IR";
    } else if (kind === "promote_taxi") {
      var cu = f.callups || {}, max = int(cu.max) || 3, nth = int(cu.used) + int(cu.pending) + 1;
      spec.title = "Promote " + name + " from taxi";
      spec.action = "Call " + name + " up from the taxi squad to the active roster.";
      spec.roster = "Taxi → active roster: " + active(1) + "; taxi " + t + " → " + (t - 1) + ".";
      spec.cap = "Cap hit $0 → " + usd(salary) + " (taxi salary is off the cap).";
      spec.reversible = nth > max
        ? "No. This is call-up " + nth + ": the promotion becomes permanent and the player can’t return to taxi."
        : "Yes, as a temporary call-up: Move to Taxi before the next lineup lock sends the player back. This is call-up " + nth + " of " + max + "; a 4th makes it permanent.";
      spec.confirmLabel = "Promote"; spec.danger = nth > max;
    } else if (kind === "demote_taxi") {
      spec.title = "Move " + name + " to taxi";
      spec.action = "Move " + name + " from the active roster to the taxi squad.";
      spec.roster = "Active roster → taxi: active " + a + " → " + (a - 1) + "; taxi " + t + " → " + (t + 1) + " (limit " + tmax + ").";
      spec.cap = "Cap hit " + usd(salary) + " → $0 (taxi salary is off the cap).";
      spec.reversible = "Yes. Promote Taxi brings the player back and uses a call-up.";
      spec.confirmLabel = "Move to taxi";
    } else if (kind === "tag") {
      spec.title = "Tag " + name;
      spec.action = "Tag " + name + " for " + team + " at " + usd(c.tcv || yrs[0]) + ".";
      spec.roster = "Added to " + team + "’s roster.";
      spec.cap = "Tag salary " + usd(c.tcv || yrs[0]) + " this season (1 year).";
      spec.reversible = "Yes, while tagging is open: Untag restores the prior contract and removes the player.";
      spec.confirmLabel = "Tag";
    } else if (kind === "untag") {
      spec.title = "Untag " + name;
      spec.action = "Undo " + name + "’s tag: restore " + (str(c.priorStatus) || "the prior contract") + " at " + usd(yrs[0]) + ", then remove the player from " + team + ".";
      spec.roster = "Leaves " + team + "’s roster.";
      spec.cap = "The " + usd(salary) + " tag salary comes off this season’s cap.";
      spec.reversible = "Not directly. Tagging again from the Tagging tab re-adds the player while tagging is open.";
      details.push("Two writes: the contract is restored first; if removing the player then fails, the restored contract stays.");
      spec.confirmLabel = "Untag"; spec.danger = true;
    } else if (["myac", "mym", "extension", "extension_loaded", "rookie_option", "restructure"].indexOf(kind) !== -1) {
      var label = { myac: "Multi-year contract (MYAC)", mym: "Mid-year multi (MYM)", extension: "Extension",
        extension_loaded: "Loaded extension", rookie_option: "Rookie option", restructure: "Restructure" }[kind];
      var n = yrs.length;
      spec.title = label + " for " + name;
      spec.action = label + ": " + name + " becomes " + (str(c.status) || "a new contract") + (n ? ", " + n + " year" + (n === 1 ? "" : "s") : "") + ".";
      spec.roster = "No roster change.";
      spec.cap = (yrs.length ? "This season " + (Number(yrs[0]) === salary ? "stays " + usd(salary) : usd(salary) + " → " + usd(yrs[0])) + ". " : "") +
        (yrs.length > 1 ? "By season: " + yearsText(yrs, f.season) + ". " : "") +
        (c.tcv ? "Total " + usd(c.tcv) + (c.gtd != null && isFinite(Number(c.gtd)) ? ", guaranteed " + usd(c.gtd) : "") + "." : "");
      spec.reversible = CONTRACT_UNDO;
      spec.confirmLabel = "Submit";
    } else {
      return null;
    }
    if (f.dry) details.push("Dry run requested: the server is asked to validate without writing.");
    return spec;
  }

  // ── Stats ──────────────────────────────────────────────────────────
  function fmt1(v) { return (Math.round((Number(v) || 0) * 10) / 10).toFixed(1); }
  function comma1(v) { var t = fmt1(v).split("."); return t[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "." + t[1]; }
  // UPS season shape: 2021+ = Wks 1–14 regular season, 15–17 playoffs; earlier = 1–13 and 14–16.
  function upsWeeks(season) { return int(season) >= 2021 ? { reg: 14, last: 17 } : { reg: 13, last: 16 }; }

  // Total-points rank inside the lineup group, among every player MFL scored this season (a total needs no
  // games minimum). Ties: PPG, then id — the same tie order as the PPG rank. → { rank, of } | null.
  var ptsMemo = { ss: null, groupOf: null, map: null };
  function pointsRank(ss, pid, groupOf) {
    if (!ss || !ss.known || !groupOf) return null;
    if (ptsMemo.ss !== ss || ptsMemo.groupOf !== groupOf) {
      var buckets = {}, map = {};
      Object.keys(ss.byPid || {}).forEach(function (id) {
        var r = ss.byPid[id], g = groupOf(id);
        if (!r || !(r.games > 0) || !g) return;
        (buckets[g] = buckets[g] || []).push({ pid: id, pts: r.pts, ppg: r.ppg });
      });
      Object.keys(buckets).forEach(function (g) {
        var b = buckets[g];
        b.sort(function (x, y) { return (y.pts - x.pts) || (y.ppg - x.ppg) || (x.pid < y.pid ? -1 : x.pid > y.pid ? 1 : 0); });
        b.forEach(function (x, i) { map[x.pid] = { rank: i + 1, of: b.length, group: g }; });
      });
      ptsMemo = { ss: ss, groupOf: groupOf, map: map };
    }
    return ptsMemo.map[String(pid)] || null;
  }
  // One week's positional rank among every player MFL scored that week in the group: 1 + players with a
  // strictly higher score (the league database's pos_rank rule; checked on Dak Prescott and Jacoby Brissett 2026).
  var wkMemo = { ss: null, groupOf: null, byWeek: {} };
  function weekRank(ss, pid, week, groupOf) {
    if (!ss || !ss.known || !groupOf) return null;
    pid = String(pid);
    var me = ss.byPid[pid], v = me && me.weeks ? me.weeks[week] : undefined, g = groupOf(pid);
    if (v == null || !g) return null;
    if (wkMemo.ss !== ss || wkMemo.groupOf !== groupOf) wkMemo = { ss: ss, groupOf: groupOf, byWeek: {} };
    var key = week + "|" + g, list = wkMemo.byWeek[key];
    if (!list) {
      list = [];
      Object.keys(ss.byPid).forEach(function (id) {
        var r = ss.byPid[id], x = r && r.weeks ? r.weeks[week] : undefined;
        if (x != null && groupOf(id) === g) list.push(x);
      });
      wkMemo.byWeek[key] = list;
    }
    return 1 + list.filter(function (x) { return x > v; }).length;
  }

  // The season table: the current season from MFL (cur = { pts, games, ppg, rank, group, ptsRank }), earlier
  // seasons from the database (career_summary rows). → newest first.
  //   row: { season, current, games, pts, ppg, ptsRank, ppgRank, rankNote }
  function seasonRows(career, cur, season) {
    season = int(season);
    var rows = [];
    if (cur) {
      rows.push({ season: season, current: true, games: int(cur.games), pts: Number(cur.pts) || 0, ppg: cur.ppg,
        ptsRank: cur.ptsRank ? cur.ptsRank.rank : null, ppgRank: cur.rank || null, group: str(cur.group), rankNote: "",
        ppgNote: cur.rank ? "" : "Unranked: a PPG rank needs half the final weeks." });
    }
    (career || []).forEach(function (c) {
      var yr = int(c.season);
      if (!yr || yr === season) return;          // the database copy of the current season lags MFL
      // PPG = the row's own total ÷ its MFL wks (not the database's separately rounded AVG), so the row,
      // the Game Log summary and the career line agree.
      var g = int(c.games_played), pts = Number(c.season_points) || 0;
      var ppg = g ? pts / g : null;
      var hasBasis = c.rank_basis_points != null && c.rank_basis_games != null;
      var same = hasBasis && Math.abs(Number(c.rank_basis_points) - pts) < 0.05 && int(c.rank_basis_games) === g;
      var half = Math.ceil(upsWeeks(yr).last / 2);
      var note = !hasBasis ? "The league’s rank for this season can’t be checked against this total, so it isn’t shown."
        : !same ? "The league’s rank counts " + comma1(c.rank_basis_points) + " pts over " + int(c.rank_basis_games) + " MFL wks, not the " + comma1(pts) + " over " + g + " shown, so it isn’t shown."
        : "";
      rows.push({ season: yr, current: false, games: g, pts: pts, ppg: ppg,
        ptsRank: same && int(c.pos_rank) > 0 ? int(c.pos_rank) : null,
        ppgRank: same && g >= half && int(c.pos_ppg_rank) > 0 ? int(c.pos_ppg_rank) : null,
        group: str(c.pos_group), rankNote: note,
        ppgNote: note || (g < half ? "A PPG rank needs half the season’s weeks (" + half + " of " + upsWeeks(yr).last + "); " + g + " MFL wks." : "") });
    });
    rows.sort(function (a, b) { return b.season - a.season; });
    return rows;
  }
  // Career = every row of the table; highest-scoring season = most total points among COMPLETED seasons.
  function careerSummary(rows) {
    var g = 0, pts = 0, best = null;
    (rows || []).forEach(function (r) {
      g += r.games; pts += r.pts;
      if (!r.current && (!best || r.pts > best.pts)) best = r;
    });
    var yrs = (rows || []).map(function (r) { return r.season; });
    return { games: g, pts: Math.round(pts * 10) / 10, ppg: g ? pts / g : null, seasons: yrs.length,
      first: yrs.length ? Math.min.apply(null, yrs) : null, last: yrs.length ? Math.max.apply(null, yrs) : null,
      best: best ? { season: best.season, pts: best.pts, ppg: best.ppg, games: best.games } : null };
  }

  // ── Game Log: one schema for every season ──────────────────────────
  // ctx: { season, current, ss (current season only), pid, groupOf, dbWeeks (bundle weekly rows for the season),
  //        byeWeek (current season: the NFL team's bye, or 0) }
  // → { rows: [{ week, playoff, pts, label, posRank, status, team }], games, pts, ppg, coverage: [text] }
  var STATUS = { starter: "Started", nonstarter: "Not started", fa: "Free agent" };
  function gameLog(ctx) {
    var season = int(ctx.season), shape = upsWeeks(season), db = {}, coverage = [];
    (ctx.dbWeeks || []).forEach(function (w) { if (w && int(w.week) > 0 && !db[int(w.week)]) db[int(w.week)] = w; });
    var noRoster = season >= 2012 && season <= 2019;  // the database never attached UPS owners for these seasons
    var rows = [], weeks = [];
    if (ctx.current) {
      var ss = ctx.ss;
      if (!ss || !ss.known) return { rows: [], games: 0, pts: 0, ppg: null, coverage: ["MFL’s scoring couldn’t be read, so no weeks are shown."], failed: true };
      weeks = (ss.seasonWeeks || []).slice();
      var live = {}; (ss.liveWeeks || []).forEach(function (w) { live[w] = 1; });
      var me = ss.byPid[String(ctx.pid)] || { weeks: {} };
      var synced = 0;
      Object.keys(db).forEach(function (w) { synced = Math.max(synced, int(w)); });
      weeks.forEach(function (w) {
        var v = me.weeks ? me.weeks[w] : undefined, d = db[w];
        rows.push({ week: w, playoff: w > shape.reg, pts: v == null ? null : v,
          label: v != null ? (live[w] ? "in progress" : "") : (ctx.byeWeek && int(ctx.byeWeek) === w ? "BYE" : live[w] ? "not played yet" : "DNP"),
          posRank: v != null ? weekRank(ss, ctx.pid, w, ctx.groupOf) : null,
          status: d ? (STATUS[str(d.status)] || str(d.status) || "—") : (w > synced ? "not synced yet" : "—"),
          team: d && str(d.status) !== "fa" ? str(d.roster_franchise_name) || "—" : "—" });
      });
      if (synced < (weeks[weeks.length - 1] || 0)) coverage.push("UPS status and team come from the league database, synced through " + (synced ? "Wk " + synced : "no week yet") + ".");
    } else {
      var maxWeek = shape.last;
      Object.keys(db).forEach(function (w) { maxWeek = Math.max(maxWeek, int(w)); });
      for (var w = 1; w <= maxWeek; w++) {
        var d = db[w], po = d ? int(d.is_reg) === 0 : w > shape.reg;
        var has = d && d.score != null && str(d.score) !== "";
        var label = has ? "" : d ? "no MFL score"
          : !po ? "no MFL score"
          : season <= 2020 ? "not loaded" : "unknown";
        rows.push({ week: w, playoff: po, pts: has ? Number(d.score) : null, label: label,
          posRank: has && int(d.pos_rank) > 0 ? int(d.pos_rank) : null,
          status: !d ? "—" : noRoster ? "not recorded" : (STATUS[str(d.status)] || str(d.status) || "—"),
          team: !d || noRoster || str(d.status) === "fa" ? "—" : (str(d.roster_franchise_name) || "—") });
      }
      if (season <= 2020) coverage.push("Playoff weeks " + (shape.reg + 1) + "–" + shape.last + " aren’t in the league database for " + season + " (#1307), so they read “not loaded”.");
      else if (season <= 2025) coverage.push("Free agents’ playoff weeks aren’t in the league database for " + season + " (#1307): a playoff week with no row reads “unknown”.");
      if (noRoster) coverage.push("UPS roster status and team aren’t recorded in the league database for 2012–2019, so they read “not recorded”, never “free agent”.");
    }
    // The summary is the season table's row, computed the same way: total rounded to 0.1, then ÷ MFL wks
    // (season_scoring.js aggregate), so 116.1 over 6 reads 19.3 here, in the table and on the phone.
    var games = 0, pts = 0;
    rows.forEach(function (r) { if (r.pts != null) { games += 1; pts += r.pts; } });
    pts = Math.round(pts * 10) / 10;
    rows.sort(function (a, b) { return b.week - a.week; });   // newest week first, like the phone
    return { rows: rows, games: games, pts: pts, ppg: games ? pts / games : null, coverage: coverage, failed: false };
  }

  var api = { upsDraftRecord: upsDraftRecord, upsDraftText: upsDraftText, taxiStatus: taxiStatus,
    nflDraftText: nflDraftText, heightText: heightText, weightText: weightText, bornText: bornText, plainText: plainText,
    writeSpec: writeSpec, WRITE_KINDS: WRITE_KINDS,
    fmt1: fmt1, comma1: comma1, upsWeeks: upsWeeks, pointsRank: pointsRank, weekRank: weekRank,
    seasonRows: seasonRows, careerSummary: careerSummary, gameLog: gameLog };
  root.UPS_FO_MODAL = Object.assign(root.UPS_FO_MODAL || {}, api);
  if (typeof module !== "undefined" && module.exports) module.exports = root.UPS_FO_MODAL;
})(typeof window !== "undefined" ? window : this);
