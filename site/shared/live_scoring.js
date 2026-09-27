/* UPS live-scoring core — the ONE implementation.
 *
 * WHY THIS FILE EXISTS
 *   site/gameday/gameday.html and site/m/views/scores.js were independent
 *   hand-copies of the same scoreboard. On 2026-09-09 that cost four separate
 *   fixes for one bug each, because every defect had to be found twice:
 *     • the source selector read liveScoring.franchise[] and missed
 *       matchup[].franchise[], so both boards showed 0.0 for all twelve teams;
 *     • the weekly branch never read the top-level franchise[], so the four
 *       teams without a head-to-head game in weeks 15/17 vanished from All-Play;
 *     • "0000" (MFL's commissioner id, not a team) passed as a franchise;
 *     • injuryFactor had DRIFTED between the copies — desktop compared
 *       === "OUT" and so paid a HOLDOUT full projection, while mobile's
 *       substring version was the more correct of the two.
 *
 *   Everything here is PURE: no DOM, no globals, no ambient state. Callers pass
 *   what they have and render the result however their surface renders. The
 *   markup stays per-surface; only the arithmetic and the classification are
 *   shared, because those are what silently drifted.
 *
 * LOADING
 *   Plain script, attaches window.UPSLive. site/shared/ is already how mobile
 *   loads cap_math.js, and gameday resolves it through the <base href> its MFL
 *   embed injects, so one relative path works on both surfaces.
 */
(function (root) {
  "use strict";

  function asArray(v) { return Array.isArray(v) ? v : (v ? [v] : []); }
  function pad4(v) {
    var d = String(v == null ? "" : v).replace(/\D/g, "");
    return d ? ("0000" + d).slice(-4) : "";
  }
  function num(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }

  /* ---- injury -------------------------------------------------------- */

  // Zero means "expect nothing more from him this week". Covers every shape MFL
  // actually serves — verified against 389 live rows on 2026-09-09: Out,
  // Questionable, Doubtful, Holdout, Suspended, RETIRED, IR, IR-PUP, IR-NFI,
  // IR-R. RETIRED is spelled out rather than left to the coincidence that
  // "reTIRed" contains "IR"; the OUT test is a SUBSTRING because an equality
  // test paid a Holdout in full.
  function injuryFactor(status) {
    var st = injuryToken(status);
    if (!st) return 1;
    if (st.indexOf("OUT") >= 0 ||
        st.indexOf("IR") >= 0 ||
        st.indexOf("PUP") >= 0 ||
        st.indexOf("NFI") >= 0 ||
        st.indexOf("SUSP") >= 0 ||
        st.indexOf("RETIRED") >= 0 ||
        st === "NA") return 0;
    if (st.indexOf("DOUB") >= 0) return 0.40;
    if (st.indexOf("QUES") >= 0) return 0.75;
    return 1;
  }

  function injuryShort(status) {
    var st = injuryToken(status);
    if (!st) return "";
    if (st.indexOf("DOUB") >= 0) return "D";
    if (st.indexOf("QUES") >= 0) return "Q";
    if (st.indexOf("RETIRED") >= 0) return "RET";
    if (st.indexOf("IR") >= 0) return "IR";
    if (st.indexOf("PUP") >= 0) return "PUP";
    if (st.indexOf("SUSP") >= 0) return "SUS";
    if (st.indexOf("OUT") >= 0) return "OUT";
    return st.slice(0, 3);
  }

  // The ONE normalizer for an injury status token, used by every parser and
  // renderer on desktop AND mobile so they can never disagree about what a
  // status "is". Whitespace collapses, the case folds to upper, and stray
  // separators at either EDGE are dropped -- a status is a word ("OUT",
  // "IR-PUP"), and a leading ":" / "-" / quote is never part of it (an
  // interior hyphen, as in IR-PUP, is kept). Missing / null / blank / all
  // punctuation is "" -- UNAVAILABLE -- and never any other status: nothing
  // here can turn an absent value into "OUT".
  function injuryToken(raw) {
    var st = String(raw == null ? "" : raw).replace(/\s+/g, " ").trim();
    st = st.replace(/^[\s:;,.\-–—|"'`()\[\]]+|[\s:;,.\-–—|"'`()\[\]]+$/g, "");
    return st.toUpperCase();
  }
  // MFL's free-text injury description ("Concussion", "Hamstring"): trimmed,
  // whitespace collapsed, and the same stray edge punctuation dropped so a
  // description that arrives as ": Concussion" or "Concussion:" joins cleanly.
  function injuryDetail(raw) {
    var d = String(raw == null ? "" : raw).replace(/\s+/g, " ").trim();
    return d.replace(/^[\s:;,.\-–—|"'`()\[\]]+|[\s:;,.\-–—|"'`()\[\]]+$/g, "");
  }
  // The label for a status and (optionally) its description, punctuation
  // rendered EXACTLY once: "OUT", or "OUT: Concussion". A missing status is ""
  // whatever the description says (a description alone is not a designation),
  // and an empty description never leaves a dangling or LEADING separator.
  function injuryLabel(status, description) {
    var st = injuryToken(status);
    if (!st) return "";
    var d = injuryDetail(description);
    return d ? st + ": " + d : st;
  }

  // MFL's TYPE=injuries payload: { injuries: { week, timestamp, injury: [...] } }.
  // It reports the CURRENT designation only and carries the week it was written
  // for, so the week and timestamp travel with the rows -- a status without its
  // week is exactly how a prior-week "Out" leaks into the next one.
  function parseInjuriesMeta(payload) {
    var node = payload && payload.injuries;
    var week = parseInt(node && node.week, 10), ts = parseInt(node && node.timestamp, 10);
    return { ok: !!node, week: week > 0 ? week : 0, timestamp: ts > 0 ? ts : 0 };
  }
  function parseInjuries(payload) {
    var map = {}, inj = payload && payload.injuries && payload.injuries.injury;
    asArray(inj).forEach(function (i) {
      if (!i || i.id == null) return;
      var tok = injuryToken(i.status);
      if (tok) map[String(i.id)] = tok;      // an entry with no status is no designation
    });
    return map;
  }
  function parseInjuryDetails(payload) {
    var map = {}, inj = payload && payload.injuries && payload.injuries.injury;
    asArray(inj).forEach(function (i) {
      if (!i || i.id == null || !injuryToken(i.status)) return;
      var d = injuryDetail(i.details);
      if (d) map[String(i.id)] = d;
    });
    return map;
  }

  // The injury feed as the shared client model: ONE store per page, KEYED BY
  // SEASON AND THE WEEK THE PAYLOAD WAS WRITTEN FOR, and queried by
  // (season, week, player). Nothing in one week's bucket can answer a query for
  // another week, so a designation held over from an earlier week simply is not
  // there to be found. put() refuses a payload it cannot attribute to a week,
  // and never lets an older payload replace a newer one for the same
  // season+week (a slow, cached or replayed response can't roll a status back).
  // Player ids are keyed as strings, so 14056 and "14056" are the same player.
  function createInjuryStore() {
    var buckets = {};   // "season:week" -> { ts, byPid, detail }
    function key(season, week) {
      return String(parseInt(season, 10) || 0) + ":" + String(parseInt(week, 10) || 0);
    }
    var api = {
      put: function (payload, ctx) {
        var meta = parseInjuriesMeta(payload);
        if (!meta.ok) return { accepted: false, reason: "unreadable" };
        var season = ctx && ctx.season;
        if (!(parseInt(season, 10) > 0)) return { accepted: false, reason: "season_unknown" };
        if (!meta.week) return { accepted: false, reason: "week_unknown" };
        var k = key(season, meta.week), prev = buckets[k];
        if (prev && meta.timestamp && prev.ts && meta.timestamp < prev.ts) return { accepted: false, reason: "stale", week: meta.week };
        buckets[k] = { ts: meta.timestamp, byPid: parseInjuries(payload), detail: parseInjuryDetails(payload) };
        return { accepted: true, reason: "", week: meta.week };
      },
      // Was an authoritative payload for THIS season+week ever accepted? (An
      // empty bucket that was READ means "nobody has a designation"; a missing
      // bucket means "unknown" -- callers must not treat the two alike.)
      known: function (season, week) { return !!buckets[key(season, week)]; },
      status: function (season, week, pid) {
        var b = buckets[key(season, week)];
        return (b && b.byPid[String(pid)]) || "";
      },
      detail: function (season, week, pid) {
        var b = buckets[key(season, week)];
        return (b && b.detail[String(pid)]) || "";
      },
      label: function (season, week, pid) { return injuryLabel(api.status(season, week, pid), api.detail(season, week, pid)); }
    };
    return api;
  }

  // MFL's own injuries export can lag real, widely-reported news, so
  // site/shared/injury_overrides.js is the standing patch list for that gap: a
  // real player id, a real status, a real source, confirmed by hand. An entry
  // is a statement about ONE game week -- it must name the season and week it
  // applies to, and it applies to exactly that week: the moment the calendar
  // moves on it stops applying, so a designation made for one week can never
  // outlive it and show up in the next. An entry with no season/week (the old
  // shape), or a caller that cannot say what week it is showing, gets NO
  // override -- the export's own value stands, or the status is simply blank.
  function overrideApplies(o, ctx) {
    if (!o || !injuryToken(o.status)) return false;
    var os = parseInt(o.season, 10), ow = parseInt(o.week, 10);
    var cs = parseInt(ctx && ctx.season, 10), cw = parseInt(ctx && ctx.week, 10);
    return os > 0 && ow > 0 && cs > 0 && cw > 0 && os === cs && ow === cw;
  }
  // ctx = { season, week } -- the season/week the caller is displaying.
  function withInjuryOverride(overrides, pid, mflStatus, ctx) {
    var o = overrides && overrides[String(pid)];
    return overrideApplies(o, ctx) ? injuryToken(o.status) : injuryToken(mflStatus);
  }
  // The designation to SHOW for a player: an in-week override, else the store's
  // value for exactly this season+week, else "" (unavailable, never "OUT").
  // opts = { store, overrides, season, week }.
  function injuryStatusFor(opts, pid) {
    var o = opts || {};
    var mfl = o.store ? o.store.status(o.season, o.week, pid) : "";
    return withInjuryOverride(o.overrides, pid, mfl, { season: o.season, week: o.week });
  }
  function injuryLabelFor(opts, pid) {
    var o = opts || {};
    var st = injuryStatusFor(o, pid);
    var mfl = o.store ? o.store.status(o.season, o.week, pid) : "";
    // The description belongs to MFL's designation; when an override supplied
    // a DIFFERENT status the description is not about that status, so omit it.
    return injuryLabel(st, (o.store && st === mfl) ? o.store.detail(o.season, o.week, pid) : "");
  }

  /* ---- which payload are we reading? ---------------------------------- */

  // Teams arrive in ONE of two shapes depending on the week: a top-level
  // franchise[], or nested in matchup[].franchise[]. Counting only the former
  // reported zero for a normal week.
  function countLiveFranchises(live) {
    var ls = live && live.liveScoring;
    if (!ls) return 0;
    var n = asArray(ls.franchise).filter(function (f) { return f && f.id; }).length;
    if (n) return n;
    asArray(ls.matchup).forEach(function (m) {
      n += asArray(m.franchise).filter(function (f) { return f && f.id; }).length;
    });
    return n;
  }

  // weeklyResults for a week IN PROGRESS is not empty — it is a full set of
  // matchups with every score at 0.0, indistinguishable from a real result by
  // shape alone. So prefer it only when it holds an actually SCORED week.
  function pickSource(live, weekly) {
    var hasMatchup = !!(weekly && weekly.weeklyResults && asArray(weekly.weeklyResults.matchup).length);
    var scored = hasMatchup && asArray(weekly.weeklyResults.matchup).some(function (m) {
      return asArray(m.franchise).some(function (f) { return Math.abs(num(f && f.score)) > 0.001; });
    });
    if (scored) return "weekly";
    return countLiveFranchises(live) ? "live" : (hasMatchup ? "weekly" : "live");
  }

  // Both shapes, both sources. The weekly top-level franchise[] holds the teams
  // with no head-to-head game that week — all twelve field a lineup in weeks
  // 15-17 (toilet bowl + the league-wide weekly high-score prize) though the
  // schedule pairs only eight.
  function franchiseRaw(source, live, weekly, fid) {
    fid = pad4(fid);
    if (!fid) return null;
    if (source === "weekly") {
      var wr = weekly && weekly.weeklyResults;
      if (!wr) return null;
      var found = null;
      asArray(wr.matchup).forEach(function (m) {
        asArray(m.franchise).forEach(function (f) { if (pad4(f.id) === fid && !found) found = f; });
      });
      if (!found) found = asArray(wr.franchise).filter(function (f) { return pad4(f.id) === fid; })[0] || null;
      return found;
    }
    var ls = live && live.liveScoring;
    if (!ls) return null;
    var direct = asArray(ls.franchise).filter(function (f) { return pad4(f.id) === fid; })[0];
    if (direct) return direct;
    var f2 = null;
    asArray(ls.matchup).forEach(function (m) {
      asArray(m.franchise).forEach(function (f) { if (pad4(f.id) === fid) f2 = f; });
    });
    return f2;
  }

  // liveScoring nests starters under players.player[]; weeklyResults puts them
  // straight on player[].
  function starterRows(raw) {
    return asArray((raw && raw.players && raw.players.player) || (raw && raw.player) || []);
  }

  /* ---- the per-franchise line ----------------------------------------- */

  // opts: { source, live, weekly, injuryOf(pid), projOf(pid), metaOf(pid) }
  // metaOf returns { name, pos, nfl } and is the only surface-specific part.
  function computeTeam(fid, name, opts) {
    fid = pad4(fid);
    var raw = franchiseRaw(opts.source, opts.live, opts.weekly, fid);
    if (!raw) {
      return { fid: fid, name: name, live: 0, projFinal: 0, origProj: 0, remaining: 0,
               secRem: 0, slots: 0, starters: [], bench: [], hasData: false };
    }
    var isLive = opts.source === "live";
    var teamScore = num(raw.score), remaining = 0, secRem = 0, origTot = 0, starters = [], bench = [];
    starterRows(raw).forEach(function (p) {
      // MFL's own status vocabulary for this export is exactly two values:
      // "starter" | "nonstarter" (verified live, weeklyResults + liveScoring
      // both, 2026-09-13) -- unrelated to playerRosterStatus's S/NS/IR/TS/R,
      // which is a different export entirely (see lineup_wiring.js).
      var isStarter = String(p.status) === "starter";
      var pid = String(p.id), pts = num(p.score);
      var gsr = isLive ? (parseInt(p.gameSecondsRemaining, 10) || 0) : 0;
      var status = isLive ? (opts.injuryOf ? opts.injuryOf(pid) : "") : "";
      var origProj = opts.projOf ? (opts.projOf(pid) || 0) : 0;
      var factor = injuryFactor(status);
      // A player ruled out contributes nothing further, however much clock is
      // left; otherwise the remainder decays with the clock.
      var rem = (!isLive || factor === 0) ? 0 : origProj * factor * (gsr / 3600);
      var meta = (opts.metaOf && opts.metaOf(pid)) || {};
      var row = {
        pid: pid, name: meta.name || pid, pos: meta.pos || "", nfl: meta.nfl || "",
        live: pts, gsr: gsr, status: status, origProj: origProj, projFinal: pts + rem,
        playing: isLive && gsr > 0 && gsr < 3600,
        done: !isLive || gsr <= 0,
        yet: isLive && gsr >= 3600
      };
      if (isStarter) {
        remaining += rem; secRem += gsr; origTot += origProj;
        starters.push(row);
      } else {
        // Team totals (score/remaining/secRem/origProj) are STARTERS ONLY --
        // the bench never counted and still doesn't. It exists here purely so
        // a viewer can compare "what I started" against "what I had on the
        // bench" without it touching a single number that decides anything.
        bench.push(row);
      }
    });
    starters.sort(function (a, b) { return b.projFinal - a.projFinal; });
    bench.sort(function (a, b) { return b.projFinal - a.projFinal; });
    return { fid: fid, name: name, live: teamScore, remaining: remaining,
             projFinal: teamScore + remaining, origProj: origTot, secRem: secRem,
             slots: starters.length, starters: starters, bench: bench, hasData: true };
  }

  /* ---- matchup state + odds ------------------------------------------- */

  function normCdf(z) {
    var t = 1 / (1 + 0.2316419 * Math.abs(z));
    var d = 0.3989422804 * Math.exp(-z * z / 2);
    var p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - p : p;
  }

  function winProb(a, b, sigmaBase) {
    var diff = a.projFinal - b.projFinal;
    var slots = (a.slots + b.slots) || 1;
    var frac = Math.max(0, Math.min(1, (a.secRem + b.secRem) / (slots * 3600)));
    var sigma = (sigmaBase || 30) * Math.sqrt(frac);
    if (sigma < 0.5) return diff > 0 ? 1 : (diff < 0 ? 0 : 0.5);
    return normCdf(diff / sigma);
  }

  // "pre" | "live" | "final". Historical is always final.
  function matchupState(source, me, o) {
    if (source === "weekly") return "final";
    var ss = (me.starters || []).concat(o.starters || []);
    if (!ss.length) return "pre";
    if (!ss.some(function (x) { return x.done || x.playing; })) return "pre";
    return ss.every(function (x) { return x.done; }) ? "final" : "live";
  }

  // A verdict TOKEN, not markup: "" | "tied" | "won" | "lost" | "winning" | "losing".
  function outcome(source, me, o) {
    var st = matchupState(source, me, o);
    if (st === "pre") return "";
    if (Math.abs(me.live - o.live) < 0.001) return "tied";
    var ahead = me.live > o.live;
    if (st === "final") return ahead ? "won" : "lost";
    return ahead ? "winning" : "losing";
  }

  function h2hRecord(source, me, opps) {
    var w = 0, l = 0, t = 0;
    (opps || []).forEach(function (o) {
      var r = outcome(source, me, o);
      if (!r) return;
      if (r === "tied") t += 1;
      else if (r === "won" || r === "winning") w += 1;
      else l += 1;
    });
    var str = w + "-" + l + (t ? "-" + t : "");
    return { w: w, l: l, t: t, str: str };
  }

  /* ---- the player breakdown's projection note -------------------------- */

  // Mid-game, points-so-far against a FULL-GAME projection reads as a miss for
  // every player until the fourth quarter — a defender on 4.1 early in the
  // second showed "-6.5 below expectation" against a 10.6 projection he was
  // never meant to have yet. While the clock runs, report the UPDATED
  // projection; the expectation verdict only means something once it stops.
  // Returns { kind, text, good } — the caller supplies markup and formatting.
  function projectionNote(p, subtotal, fmt) {
    var f = fmt || function (n) { return (Math.round((Number(n) || 0) * 10) / 10).toFixed(1); };
    var op = (p && p.origProj) || 0;
    var rem = Math.max(0, ((p && p.projFinal) || 0) - ((p && p.live) || 0));
    if (p && p.done) {
      if (!(op > 0)) return null;
      var diff = subtotal - op, above = diff >= 0;
      return { kind: "final", good: above,
               text: "vs proj " + f(op) + " · " + (above ? "+" : "") + f(diff) + " " +
                     (above ? "above" : "below") + " expectation" };
    }
    if (p && p.playing) {
      var nowProj = subtotal + rem, moved = nowProj - op, up = moved >= 0;
      return { kind: "live", good: up,
               text: "projected " + f(nowProj) + " · started at " + f(op) + " · " +
                     (up ? "+" : "") + f(moved) + " with " + Math.ceil(((p && p.gsr) || 0) / 60) + "' left" };
    }
    if (!(op > 0)) return null;
    return { kind: "pre", good: true, text: "projected " + f(op) + " · has not played yet" };
  }

  /* ---- position grouping --------------------------------------------- */

  // One mapping for both scoreboards. Desktop Game Day keeps its OWN copy of
  // this for Submit Lineup, deliberately: that panel must keep working even if
  // this file fails to load, whereas the scoreboard already depends on it.
  function posGroup(pos) {
    var p = String(pos == null ? "" : pos).trim().toUpperCase();
    if (p === "QB") return "QB";
    if (p === "RB" || p === "FB" || p === "HB") return "RB";
    if (p === "WR") return "WR";
    if (p === "TE") return "TE";
    if (p === "PK" || p === "K") return "PK";
    if (p === "PN" || p === "P") return "PN";
    if (p === "DT" || p === "DE" || p === "NT" || p === "DL") return "DL";
    if (p === "LB" || p === "OLB" || p === "ILB" || p === "MLB") return "LB";
    if (p === "CB" || p === "S" || p === "FS" || p === "SS" || p === "DB") return "DB";
    return "OTH";
  }
  // Lineup-card order, so a grouped table reads top to bottom like a lineup.
  var POS_ORDER = ["QB", "RB", "WR", "TE", "PK", "PN", "DL", "LB", "DB", "OTH"];
  var POS_LABEL = { PK: "K", PN: "P", OTH: "Other" };
  // starters -> [{ group, label, rows, live }] in lineup order. Rows keep the
  // order they arrive in -- computeTeam sorts by projected finish -- so inside
  // each group the best-projected player still comes first. `live` is the
  // group's points so far.
  function groupStarters(starters) {
    var by = {};
    (starters || []).forEach(function (p) {
      var g = posGroup(p && p.pos);
      (by[g] = by[g] || []).push(p);
    });
    return POS_ORDER.filter(function (g) { return by[g]; }).map(function (g) {
      var live = 0;
      by[g].forEach(function (p) { live += num(p && p.live); });
      return { group: g, label: POS_LABEL[g] || g, rows: by[g], live: live };
    });
  }

  /* ---- kickoff times --------------------------------------------------- */

  // MFL export?TYPE=nflSchedule -> { TEAM: kickoffUnix }. Team codes are MFL's
  // own (NEP, SFO, LAR) -- the same codes the players export uses -- so a
  // starter's p.nfl looks straight up. An unreadable schedule returns {} and
  // callers keep "Yet": this is display-only and never gates anything.
  function parseKickoffs(json) {
    var out = {};
    try {
      asArray(json && json.nflSchedule && json.nflSchedule.matchup).forEach(function (m) {
        var k = parseInt(m && m.kickoff, 10);
        if (!(k > 0)) return;
        asArray(m.team).forEach(function (t) { if (t && t.id) out[String(t.id).toUpperCase()] = k; });
      });
    } catch (e) {}
    return out;
  }
  // "Sun 1:00 PM" in the VIEWER's own time zone; "" when unknown so the caller
  // keeps its old label rather than printing something wrong.
  function kickoffLabel(unix) {
    if (!(unix > 0)) return "";
    try {
      return new Date(unix * 1000).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
    } catch (e) { return ""; }
  }

  /* ---- identity -------------------------------------------------------- */

  // MFL hands a commissioner "0000" — the league id, not a team — and
  // pad4("0000") is truthy, so an unvalidated id sails through as a franchise
  // that does not exist. Every candidate is checked against the real list.
  function resolveViewFid(candidates, franchises) {
    var all = franchises || [];
    for (var i = 0; i < (candidates || []).length; i++) {
      var f = pad4(candidates[i]);
      if (f && all.some(function (x) { return pad4(x.id) === f; })) return f;
    }
    return all.length ? pad4(all[0].id) : "";
  }

  root.UPSLive = {
    asArray: asArray, pad4: pad4,
    injuryFactor: injuryFactor, injuryShort: injuryShort, parseInjuries: parseInjuries,
    injuryToken: injuryToken, injuryDetail: injuryDetail, injuryLabel: injuryLabel,
    parseInjuriesMeta: parseInjuriesMeta, parseInjuryDetails: parseInjuryDetails,
    createInjuryStore: createInjuryStore, overrideApplies: overrideApplies,
    injuryStatusFor: injuryStatusFor, injuryLabelFor: injuryLabelFor,
    withInjuryOverride: withInjuryOverride,
    countLiveFranchises: countLiveFranchises, pickSource: pickSource,
    franchiseRaw: franchiseRaw, starterRows: starterRows,
    computeTeam: computeTeam,
    normCdf: normCdf, winProb: winProb,
    matchupState: matchupState, outcome: outcome, h2hRecord: h2hRecord,
    projectionNote: projectionNote, resolveViewFid: resolveViewFid,
    posGroup: posGroup, groupStarters: groupStarters, POS_ORDER: POS_ORDER,
    parseKickoffs: parseKickoffs, kickoffLabel: kickoffLabel
  };
})(typeof window !== "undefined" ? window : this);
