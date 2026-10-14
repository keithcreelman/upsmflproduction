/* UPS injury status — the ONE resolver for what an owner is told about a player's
 * injury, on mobile Lineup, the mobile player sheet and desktop Game Day.
 *
 * KEITH'S RULES (2026-10-14, ruling on #1285):
 *   • MFL's current Q / D / OUT (its injuries export: status, description, expected
 *     return, the export's week and time) is the PRIMARY owner-facing status.
 *   • The official NFL injury report (nflverse via the worker: this week's, plus last
 *     week's final for teams that haven't reported yet) is SUPPORTING information:
 *     the tag when MFL has nothing, and always a line in Details.
 *   • IR / IR-R / PUP / NFI / SUSP / RET / HOLD stay MFL's roster designations.
 *   • Every tag and line names its source and week ("MFL: Q (Wk 6)", "NFL: OUT (Wk 6)",
 *     "NFL: OUT (Wk 5 final)"), so an old designation never reads as current; a tag
 *     from a week before the screen's week is drawn dashed. MFL's description and
 *     expected return are shown; a return date already past says so.
 *   • When MFL and this week's posted official report disagree (MFL Q but he isn't on
 *     his team's posted report; MFL nothing but the report says Out; Q vs Out), BOTH
 *     are shown — a second tag ("NFL Wk 6: not listed", "MFL: none", or the report's
 *     own tag) and a Details line. Neither is ever hidden.
 *   • No tag is never "healthy": the lines and the screen note say which source is
 *     missing, stale or unread.
 *   • Booking a lineup violation is NOT this file's business: the worker's §G3 code
 *     keeps using the official evidence and notice rules (it never reads this).
 *
 * INPUT is one read of the worker's GET /api/player-status (worker/src/player_status.js):
 *   { report_feed, roster_feed, mfl_feed, players: { mflId: { mfl, report, prior, roster } },
 *     mapped_mfl_ids }, held as { state: "idle"|"loading"|"ok"|"error", data, at }.
 * A read older than TTL is never shown as current. When there's no fresh read, the
 * surface may pass its own read of MFL's export (fallbackMfl) so MFL's designation
 * still shows, labeled as such.
 *
 * Everything here is PURE (no DOM, no fetch except the optional loader): every surface
 * passes the same read and gets the same tags and lines, word for word. Plain script;
 * attaches window.UPSInjuryStatus.
 */
(function (root) {
  "use strict";
  var TTL = 5 * 60 * 1000;
  var SHORT = { Out: "OUT", Doubtful: "D", Questionable: "Q" };
  var SEV = { Out: "out", Doubtful: "d", Questionable: "q" };
  var GAME_TOKEN = { OUT: "Out", DOUBTFUL: "Doubtful", QUESTIONABLE: "Questionable" };
  // MFL roster kinds: export token → [chip, label].
  var ROSTER = { "IR": ["IR", "Injured reserve"], "IR-R": ["IR-R", "Injured reserve – designated to return"], "IR-PUP": ["PUP", "Physically unable to perform"],
    "IR-NFI": ["NFI", "Non-football injury list"], "SUSPENDED": ["SUSP", "Suspended"], "HOLDOUT": ["HOLD", "Holdout"], "RETIRED": ["RET", "Retired"] };
  // MFL and nflverse spell some teams differently; either is accepted.
  var NFLV_TO_MFL = { GB: "GBP", JAX: "JAC", KC: "KCC", LA: "LAR", LV: "LVR", NE: "NEP", NO: "NOS", SF: "SFO", TB: "TBB" };
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function str(v) { return v == null ? "" : String(v).trim(); }
  function int(v) { var n = parseInt(v, 10); return isFinite(n) ? n : 0; }
  // Lineup resolves every player for every dropdown on each paint, so the formatted times,
  // today's date and the matched-id set are computed once per value / per read.
  var memo = { clock: {}, clockN: 0, day: {}, data: null, mapped: null };
  function clockEt(iso) {
    if (!iso) return "";
    if (memo.clock[iso] != null) return memo.clock[iso];
    var d = new Date(iso), out = "";
    if (!isNaN(d.getTime())) {
      try { out = d.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }) + " ET"; }
      catch (e) { out = d.toISOString().slice(0, 16).replace("T", " ") + " UTC"; }
    }
    if (++memo.clockN > 200) { memo.clock = {}; memo.clockN = 0; }
    return (memo.clock[iso] = out);
  }
  function todayEt(now) {
    var k = Math.floor(now / 60000);
    if (memo.day.k === k) return memo.day.v;
    var v;
    try { v = new Date(now).toLocaleDateString("en-CA", { timeZone: "America/New_York" }); }
    catch (e) { v = new Date(now).toISOString().slice(0, 10); }
    memo.day = { k: k, v: v };
    return v;
  }
  function mappedOf(d) {
    if (memo.data === d) return memo.mapped;
    var m = null;
    if (d && d.mapped_mfl_ids) { m = {}; d.mapped_mfl_ids.forEach(function (id) { m[String(id)] = 1; }); }
    memo.data = d; memo.mapped = m;
    return m;
  }
  // "Oct 18" from "2026-10-18" (or MFL's own text when it couldn't be read as a date).
  function dayText(iso, raw) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(iso));
    return m ? MONTHS[int(m[2]) - 1] + " " + int(m[3]) : str(raw);
  }
  function returnText(m, now) {
    if (!m || !(m.return_date || m.exp_return)) return "";
    var past = m.return_date && m.return_date < todayEt(now);
    return "expected back " + dayText(m.return_date, m.exp_return) + (past ? " (already past)" : "");
  }
  function why(feed) {
    var r = str(feed && feed.reason);
    if (/not out yet/.test(r) || /has no Wk \d+ rows/.test(r)) return r;
    if (/id map/.test(r)) return "players couldn’t be matched to it (the NFL id map couldn’t be read)";
    if (/not updated for/.test(r)) return "the report hasn’t been updated for " + r.replace(/^.*not updated for /, "");
    if (/current NFL week unknown/.test(r)) return "the current NFL week couldn’t be read";
    return "it couldn’t be read";
  }
  function practiceText(p) {
    return str(p).replace(/ (Participation )?in Practice$/i, "").replace(/^Did Not Participate$/i, "did not practice").toLowerCase();
  }
  function fresh(read, now) {
    return !!(read && read.state === "ok" && read.data && (now - (read.at || 0)) <= TTL);
  }
  // The page's own read of MFL's export (live_scoring.js createInjuryStore) as an `mfl` /
  // roster pair, for when the status read isn't available. Same words as the worker's.
  function fromMflStore(store, season, week, pid) {
    if (!store || !store.status || !(int(week) > 0) || !store.known || !store.known(season, week)) return null;
    var tok = str(store.status(season, week, pid)).toUpperCase(), det = str(store.detail ? store.detail(season, week, pid) : "") || null;
    if (GAME_TOKEN[tok]) return { mfl: { status: GAME_TOKEN[tok], week: int(week), details: det, exp_return: null, return_date: null } };
    if (ROSTER[tok]) return { roster: { chip: ROSTER[tok][0], label: ROSTER[tok][1], detail: det } };
    return { none: true, week: int(week) };
  }

  function chip(t, cls, title, extra) {
    var c = { t: t, cls: cls, title: title };
    if (extra) for (var k in extra) c[k] = extra[k];
    return c;
  }
  function rosterChip(ro) {
    return chip("MFL: " + ro.chip, ro.chip === "HOLD" ? "ho" : "res", "MFL roster: " + ro.label + (ro.detail ? " (" + ro.detail + ")" : ""), { src: "roster" });
  }
  function rosterLine(ro, when, now) {
    return "MFL roster: " + ro.label + (ro.detail ? " (" + ro.detail + ")" : "") +
      (returnText(ro, now) ? "; " + returnText(ro, now) : "") + (when ? " (updated " + when + ")" : "") + ".";
  }
  function mflChip(m, week, now) {
    var rt = returnText(m, now);
    return chip("MFL: " + SHORT[m.status] + " (Wk " + m.week + ")", SEV[m.status],
      "MFL Wk " + m.week + ": " + m.status + (m.details ? " — " + m.details : "") + (rt ? "; " + rt : ""),
      { src: "mfl", prior: !!(week && m.week && m.week < week) });
  }
  function mflLine(m, when, now) {
    var rt = returnText(m, now);
    return "MFL Wk " + m.week + ": " + m.status + (m.details ? " — " + m.details : "") + (rt ? "; " + rt : "") +
      (when ? " (updated " + when + ")" : "") + ".";
  }

  /* resolve(read, pid, team, opts) → { chips, lines, disagree, label }
   *   read  { state, data, at } — one /api/player-status read (see the header)
   *   team  the player's MFL team code
   *   opts  { week: the week the screen is for (default: the read's own week),
   *           now: ms, fallback: fromMflStore(...) for when the read isn't fresh }
   * chips: [{ t, cls: out|d|q|res|ho|na, title, src: mfl|nfl|nfl-final|roster|note, prior }] */
  function resolve(read, pid, team, opts) {
    opts = opts || {};
    var now = opts.now != null ? opts.now : Date.now();
    pid = str(pid); team = str(team).toUpperCase(); team = NFLV_TO_MFL[team] || team;
    var out = { chips: [], lines: [], disagree: false, label: "" };
    if (!fresh(read, now)) {
      out.lines.push(read && read.state === "error" ? "Injury status couldn’t be loaded. No tag doesn’t mean healthy." : "Checking injury status…");
      var fb = opts.fallback;
      if (fb && fb.mfl) { out.chips.push(mflChip(fb.mfl, int(opts.week), now)); out.lines.push(mflLine(fb.mfl, "", now).replace(/\.$/, "") + " (this page’s MFL read)."); }
      if (fb && fb.roster) { out.chips.unshift(rosterChip(fb.roster)); out.lines.push(rosterLine(fb.roster, "", now).replace(/\.$/, "") + " (this page’s MFL read)."); }
      if (fb && fb.none) out.lines.push("MFL Wk " + fb.week + ": no designation (this page’s MFL read).");
      out.label = out.chips.map(function (c) { return c.t; }).join(" ");
      return out;
    }
    var d = read.data, p = (d.players || {})[pid] || {};
    var rf = d.report_feed || {}, rof = d.roster_feed || {}, mf = d.mfl_feed || null;
    var dataWeek = int((mf && mf.week) || rof.week || rf.current_week);
    var week = int(opts.week) || dataWeek;
    var mapped = mappedOf(d);
    var m = p.mfl || null, r = rf.current ? (p.report || null) : null, pr = p.prior || null, ro = p.roster || null;
    var rWeek = int(rf.week), nflWhen = clockEt(rf.updated_utc);
    var teamReported = rf.current && (rf.teams_mfl || []).indexOf(team) >= 0;
    var canMatch = !!(mapped && mapped[pid]) && team && team !== "FA" && team !== "FA*";
    var notListed = rf.current && teamReported && canMatch && !p.report;

    // ── tags ──
    if (ro) out.chips.push(rosterChip(ro));
    if (m) {
      var mc = mflChip(m, week, now);
      if (r && r.status === m.status) mc.title += " · the NFL Wk " + rWeek + " report agrees";
      out.chips.push(mc);
      if (r && r.status && r.status !== m.status) {
        out.disagree = true;
        out.chips.push(chip("NFL: " + SHORT[r.status] + " (Wk " + rWeek + ")", SEV[r.status], "NFL Wk " + rWeek + " report: " + r.status + " (MFL says " + m.status + ")",
          { src: "nfl", prior: !!(week && rWeek < week) }));
      } else if (notListed) {
        out.disagree = true;
        out.chips.push(chip("NFL Wk " + rWeek + ": not listed", "na", "Not on " + team + "’s NFL Wk " + rWeek + " injury report (MFL says " + m.status + ")", { src: "nfl" }));
      }
    } else if (r && r.status) {
      // MFL has no game designation: the official report's, labeled as the NFL's.
      out.chips.push(chip("NFL: " + SHORT[r.status] + " (Wk " + rWeek + ")", SEV[r.status], "NFL Wk " + rWeek + " report: " + r.status + (r.injury ? " — " + r.injury : ""),
        { src: "nfl", prior: !!(week && rWeek < week) }));
      if (mf && mf.ok && !ro) {   // (an MFL roster designation is MFL saying something)
        out.disagree = true;
        out.chips.push(chip("MFL: none", "na", "MFL’s Wk " + (mf.week || "") + " export has no designation for him (the NFL report says " + r.status + ")", { src: "note" }));
      }
    } else if (pr && !(r && r.status)) {
      // Nothing from MFL and nothing current from the NFL: his last final official designation.
      out.chips.push(chip("NFL: " + SHORT[pr.status] + " (Wk " + pr.week + " final)", SEV[pr.status], "NFL Wk " + pr.week + " injury report (final): " + pr.status + (pr.injury ? " — " + pr.injury : ""),
        { src: "nfl-final", prior: true }));
    }

    // ── lines (Details / the sheet): MFL first, then the NFL report, always ──
    var mflWhen = clockEt(mf ? mf.updated_utc : rof.updated_utc);
    if (m) out.lines.push(mflLine(m, mflWhen, now));
    else if (mf && mf.ok) out.lines.push("MFL Wk " + mf.week + ": no designation" + (mflWhen ? " (updated " + mflWhen + ")" : "") + ".");
    else if (mf) out.lines.push("MFL’s injury designations couldn’t be read, so MFL’s is unknown.");
    else out.lines.push("MFL’s designation isn’t available from this server yet.");
    if (ro) out.lines.push(rosterLine(ro, clockEt(rof.updated_utc), now));
    else if (rof && rof.ok === false) out.lines.push("MFL roster designations (IR, PUP …) couldn’t be read.");
    if (!rf.ok && !rf.reason) out.lines.push("NFL injury report: unavailable.");
    else if (!rf.current) out.lines.push("NFL injury report unavailable: " + why(rf) + ".");
    else if (p.report) {
      out.lines.push("NFL Wk " + rWeek + " report: " + (p.report.status || "listed, no game status yet") + (p.report.injury ? " — " + p.report.injury : "") +
        (p.report.practice ? " · practice: " + practiceText(p.report.practice) : "") + (nflWhen ? " (updated " + nflWhen + ")" : "") + ".");
    }
    else if (!mapped) out.lines.push("NFL Wk " + rWeek + " report: couldn’t tell whether he’s on it.");
    else if (!mapped[pid]) out.lines.push("NFL report: no verified NFL id, so he can’t be matched to it.");
    else if (!team || team === "FA" || team === "FA*") out.lines.push("NFL report: free agent, not on a team’s report.");
    else if (teamReported) out.lines.push("NFL Wk " + rWeek + " report: not listed (" + team + "’s report" + (nflWhen ? ", updated " + nflWhen : "") + ").");
    else out.lines.push("NFL Wk " + rWeek + " report: not out yet for " + team + " (or a bye).");
    if (pr) out.lines.push("NFL Wk " + pr.week + " final: " + pr.status + (pr.injury ? " — " + pr.injury : "") + ".");
    if (out.disagree) {
      out.lines.push("MFL and the NFL Wk " + rWeek + " report disagree: " +
        (m ? "MFL says " + m.status : "MFL has no game designation") + "; " +
        (r && r.status ? "the report says " + r.status : "the report doesn’t list him") + ".");
    }
    out.label = out.chips.map(function (c) { return c.t; }).join(" ");
    return out;
  }

  // " · MFL: Q (Wk 6)" for plain text (a dropdown choice); "" when there's no tag.
  function optText(res) {
    return res && res.chips.length ? "  ·  " + res.chips.map(function (c) { return c.t; }).join(" ") : "";
  }

  // The one line on a screen that says where the tags come from (≤ 3 short sentences).
  function noteText(read, opts) {
    opts = opts || {};
    var now = opts.now != null ? opts.now : Date.now();
    if (!fresh(read, now)) {
      if (read && read.state === "error") return opts.fallback ? "Injury status couldn’t be loaded; tags are MFL’s from this page’s own read. No tag doesn’t mean healthy."
        : "Injury status couldn’t be loaded. No tag doesn’t mean healthy.";
      return "Checking injury status…";
    }
    var d = read.data, rf = d.report_feed || {}, mf = d.mfl_feed || null, rof = d.roster_feed || {};
    var wk = int(opts.week) || int((mf && mf.week) || rof.week || rf.current_week);
    var a;
    if (mf && mf.ok) a = "Tags: MFL’s Wk " + mf.week + " designations first (updated " + clockEt(mf.updated_utc) + ")";
    else if (mf) a = "Tags: MFL’s designations couldn’t be read";
    else a = "Tags: MFL’s designations aren’t available from this server yet";
    var b;
    if (rf.current) {
      var n = (rf.teams_mfl || []).length;
      b = "; where MFL has none, the NFL report — Wk " + rf.week + "’s for " + n + (n === 1 ? " team" : " teams") + " so far" +
        ((rf.prior_weeks || []).length ? ", otherwise the last final (Wk " + rf.prior_weeks.join("/") + ")" : "") + ".";
    } else if (rf.ok || rf.reason) {
      b = (rf.prior_weeks || []).length ? "; where MFL has none, the NFL’s last final report (Wk " + rf.prior_weeks.join("/") + "): Wk " + wk + "’s isn’t out yet." : "; the NFL report is unavailable (" + why(rf) + ").";
    } else b = "; the NFL report is unavailable.";
    return a + b + " Details shows both. No tag doesn’t mean healthy.";
  }

  // A small loader for a page that has no status loader of its own (desktop Game Day).
  // url(season) → the GET; fetchImpl defaults to fetch. Same freshness rule as resolve().
  function createLoader(url, fetchImpl) {
    var st = { season: "", state: "idle", data: null, at: 0, loading: false };
    function load(season, onChange) {
      season = str(season);
      if (!season || st.loading) return;
      var now = Date.now();
      if (st.season === season && st.state === "ok" && now - st.at < TTL) return;
      if (st.season === season && st.state === "error" && now - st.at < 60 * 1000) return;
      if (st.season !== season) { st.data = null; st.state = "loading"; }
      st.season = season; st.loading = true;
      (fetchImpl || root.fetch)(url(season), { mode: "cors", credentials: "omit" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { st.data = j && j.ok ? j : null; st.state = st.data ? "ok" : "error"; },
              function () { st.data = null; st.state = "error"; })
        .then(function () { st.at = Date.now(); st.loading = false; if (onChange) onChange(); });
    }
    return { load: load, read: function () { return st; } };
  }

  root.UPSInjuryStatus = { TTL: TTL, resolve: resolve, optText: optText, noteText: noteText, fromMflStore: fromMflStore,
    createLoader: createLoader, fresh: fresh, _clockEt: clockEt };
})(typeof window !== "undefined" ? window : this);
