/* UPS injury status — the ONE resolver for what an owner is told about a player's
 * injury: Stats → Players, player search, the mobile player sheet, mobile Lineup and
 * desktop Game Day all show exactly what this returns.
 *
 * KEITH'S RULES
 *   2026-10-14 (#1285 / #1296): MFL's current Q / D / OUT is the PRIMARY status; the official
 *     NFL report (nflverse via the worker) is the check beside it; IR / PUP / SUSP stay MFL's
 *     roster designations; no tag is never "healthy"; booking a lineup violation (§G3) and
 *     Live Scoring's injury projections keep using the official report and never read this.
 *   2026-10-15 (#1311, "the UI is exposing too much source machinery"):
 *   • A chip shows only the designation: Q, D, OUT, IR, PUP, SUSP (NFI / HOLD / RET when MFL
 *     says so). No "MFL:" / "NFL:" prefix, and at most ONE chip per player: MFL's roster
 *     designation first, else MFL's Q / D / OUT, else the current official report's.
 *   • When MFL and the CURRENT official report disagree, lists and search still show one chip;
 *     the player page carries a red "Injury sources disagree" warning that states each source
 *     plainly ("MFL: Questionable" / "Official NFL report: Not listed for Week 6"). It is
 *     information only: it never calls either source wrong, or the player healthy.
 *   • No expected-return dates, "est. return passed", or stale-style (dashed) chips anywhere.
 *     A previous week's final report is a detail line, never a chip.
 *   • One explanation, behind About (aboutText). Read times stay out of rows; a screen shows a
 *     line only when a source is unavailable (noteText).
 *
 * INPUT is one read of the worker's GET /api/player-status (worker/src/player_status.js):
 *   { report_feed, roster_feed, mfl_feed, players: { mflId: { mfl, report, prior, roster } },
 *     mapped_mfl_ids }, held as { state: "idle"|"loading"|"ok"|"error", data, at }.
 * A read older than TTL is never shown as current. When there's no fresh read, the surface may
 * pass its own read of MFL's export (fallback) so MFL's designation still shows.
 *
 * Everything here is PURE (no DOM, no fetch except the optional loader): every surface passes
 * the same read and gets the same chip, warning and lines, word for word. Plain script;
 * attaches window.UPSInjuryStatus.
 */
(function (root) {
  "use strict";
  var TTL = 5 * 60 * 1000;
  var SHORT = { Out: "OUT", Doubtful: "D", Questionable: "Q" };
  var SEV = { Out: "out", Doubtful: "d", Questionable: "q" };
  var GAME_TOKEN = { OUT: "Out", DOUBTFUL: "Doubtful", QUESTIONABLE: "Questionable" };
  // MFL roster kinds: export token → [chip, label]. IR and IR-R are both "IR" on a chip.
  var ROSTER = { "IR": ["IR", "Injured reserve"], "IR-R": ["IR", "Injured reserve – designated to return"], "IR-PUP": ["PUP", "Physically unable to perform"],
    "IR-NFI": ["NFI", "Non-football injury list"], "SUSPENDED": ["SUSP", "Suspended"], "HOLDOUT": ["HOLD", "Holdout"], "RETIRED": ["RET", "Retired"] };
  // The worker's roster chip spelled as a plain designation.
  var ROSTER_CHIP = { "IR-R": "IR" };
  // MFL and nflverse spell some teams differently; either is accepted.
  var NFLV_TO_MFL = { GB: "GBP", JAX: "JAC", KC: "KCC", LA: "LAR", LV: "LVR", NE: "NEP", NO: "NOS", SF: "SFO", TB: "TBB" };
  var ABOUT = "Injury status uses MFL for the current designation and checks it against the official NFL report. If they disagree, the player page calls it out.";

  function str(v) { return v == null ? "" : String(v).trim(); }
  function int(v) { var n = parseInt(v, 10); return isFinite(n) ? n : 0; }
  var memo = { data: null, mapped: null };
  function mappedOf(d) {
    if (memo.data === d) return memo.mapped;
    var m = null;
    if (d && d.mapped_mfl_ids) { m = {}; d.mapped_mfl_ids.forEach(function (id) { m[String(id)] = 1; }); }
    memo.data = d; memo.mapped = m;
    return m;
  }
  function why(feed) {
    var r = str(feed && feed.reason);
    if (/not out yet/.test(r) || /has no Wk \d+ rows/.test(r)) return "Not posted yet";
    if (/id map/.test(r)) return "Players couldn’t be matched to it";
    if (/not updated for/.test(r)) return "Not updated recently";
    if (/current NFL week unknown/.test(r)) return "The current NFL week couldn’t be read";
    if (/age unknown/.test(r)) return "Couldn’t confirm it’s current";
    return "Couldn’t be read";
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
    if (GAME_TOKEN[tok]) return { mfl: { status: GAME_TOKEN[tok], week: int(week), details: det } };
    if (ROSTER[tok]) return { roster: { chip: ROSTER[tok][0], label: ROSTER[tok][1], detail: det } };
    return { none: true, week: int(week) };
  }

  function chip(t, cls, title, src) { return { t: t, cls: cls, title: title, src: src }; }
  function rosterChip(ro) {
    var t = ROSTER_CHIP[ro.chip] || ro.chip;
    return chip(t, t === "HOLD" ? "ho" : "res", ro.label + (ro.detail ? " (" + ro.detail + ")" : ""), "roster");
  }
  function gameChip(status, src, detail) {
    return chip(SHORT[status], SEV[status], status + (detail ? " (" + detail + ")" : ""), src);
  }
  function rosterLine(ro) { return "MFL roster: " + ro.label + (ro.detail ? " (" + ro.detail + ")" : ""); }
  function mflLine(m) { return "MFL: " + m.status + (m.details ? " (" + m.details + ")" : ""); }

  /* resolve(read, pid, team, opts) → { chips, warning, lines, disagree, label }
   *   read  { state, data, at } — one /api/player-status read (see the header)
   *   team  the player's MFL team code (nflverse spellings accepted)
   *   opts  { now: ms, fallback: fromMflStore(...) for when the read isn't fresh }
   *         (surfaces still pass week, the screen's week; the chip no longer depends on it)
   * chips:   0 or 1 of { t: "Q"|"D"|"OUT"|"IR"|"PUP"|"SUSP"|…, cls: q|d|out|res|ho, title, src }
   * warning: null, or { title: "Injury sources disagree", lines: [MFL's, the official report's] }
   * lines:   the player page's detail lines (what each source has; never read times or dates). */
  function resolve(read, pid, team, opts) {
    opts = opts || {};
    var now = opts.now != null ? opts.now : Date.now();
    pid = str(pid); team = str(team).toUpperCase(); team = NFLV_TO_MFL[team] || team;
    var out = { chips: [], warning: null, lines: [], disagree: false, label: "" };
    if (!fresh(read, now)) {
      var fb = opts.fallback;
      out.lines.push(read && read.state === "error" ? "Injury status couldn’t be loaded." : "Checking injury status…");
      if (fb && fb.roster) { out.chips.push(rosterChip(fb.roster)); out.lines.push(rosterLine(fb.roster).replace(/^MFL roster:/, "MFL roster (this page’s read):")); }
      else if (fb && fb.mfl) { out.chips.push(gameChip(fb.mfl.status, "mfl", fb.mfl.details)); out.lines.push(mflLine(fb.mfl).replace(/^MFL:/, "MFL (this page’s read):")); }
      else if (fb && fb.none) out.lines.push("MFL (this page’s read): No designation");
      out.label = out.chips.map(function (c) { return c.t; }).join(" ");
      return out;
    }
    var d = read.data, p = (d.players || {})[pid] || {};
    var rf = d.report_feed || {}, rof = d.roster_feed || {}, mf = d.mfl_feed || null;
    var mapped = mappedOf(d);
    var m = p.mfl || null, r = rf.current ? (p.report || null) : null, pr = p.prior || null, ro = p.roster || null;
    var rWeek = int(rf.week);
    var teamReported = rf.current && (rf.teams_mfl || []).indexOf(team) >= 0;
    var canMatch = !!(mapped && mapped[pid]) && team && team !== "FA" && team !== "FA*";
    var notListed = rf.current && teamReported && canMatch && !p.report;

    // ── the chip: MFL's roster designation, else MFL's game status, else the current report's ──
    if (ro) out.chips.push(rosterChip(ro));
    else if (m) out.chips.push(gameChip(m.status, "mfl", m.details));
    else if (r && r.status) out.chips.push(gameChip(r.status, "nfl", r.injury));

    // ── disagreement: MFL's game status vs the CURRENT official report, both known ──
    // MFL: "Questionable" / "" (no designation, its list was read) / null (unknown). The report:
    // a status / "not listed" (his team posted it, verified id, not on it) / null (unknown:
    // not posted, listed without a game status yet, unmatched, unavailable). A roster
    // designation (IR, PUP …) isn't a game status, so it is never compared.
    var mflSays = ro ? null : (m ? m.status : (mf && mf.ok ? "" : null));
    var nflSays = r && r.status ? r.status : (notListed ? "not listed" : null);
    if (mflSays !== null && nflSays !== null && mflSays !== nflSays && !(mflSays === "" && nflSays === "not listed")) {
      out.disagree = true;
      out.warning = { title: "Injury sources disagree", lines: [
        mflSays ? mflLine(m) : "MFL: No designation",
        "Official NFL report: " + (nflSays === "not listed" ? "Not listed for Week " + rWeek : nflSays + " for Week " + rWeek + (r.injury ? " (" + r.injury + ")" : "")),
      ] };
    }

    // ── the player page's lines: what each source has (the warning already says both when they disagree) ──
    if (ro) out.lines.push(rosterLine(ro));
    else if (rof && rof.ok === false && mf && mf.ok) out.lines.push("MFL roster designations (IR, PUP …) couldn’t be read.");
    if (!out.disagree) {
      // (A roster designation is MFL's word on him: never followed by "MFL: No designation".)
      if (m) out.lines.push(mflLine(m));
      else if (ro) { /* said above */ }
      else if (mf && mf.ok) out.lines.push("MFL: No designation");
      else out.lines.push("MFL: Couldn’t be read");
      if (!rf.current) out.lines.push("Official NFL report: " + (rf.ok || rf.reason ? why(rf) : "Unavailable"));
      else if (p.report) {
        out.lines.push("Official NFL report: " + (p.report.status ? p.report.status + " for Week " + rWeek : "Listed for Week " + rWeek + ", no game status yet") +
          (p.report.injury ? " (" + p.report.injury + ")" : "") + (p.report.practice ? " · practice: " + practiceText(p.report.practice) : ""));
      }
      else if (!mapped) out.lines.push("Official NFL report: Couldn’t tell whether he’s on it");
      else if (!mapped[pid]) out.lines.push("Official NFL report: No verified NFL id, so he can’t be matched");
      else if (!team || team === "FA" || team === "FA*") out.lines.push("Official NFL report: Free agent, not on a team’s report");
      else if (teamReported) out.lines.push("Official NFL report: Not listed for Week " + rWeek);
      else out.lines.push("Official NFL report: Week " + rWeek + " not posted yet for " + team + " (or a bye)");
    } else if (p.report && p.report.practice) {
      out.lines.push("Practice (official report): " + practiceText(p.report.practice));
    }
    if (pr) out.lines.push("Official NFL report for Week " + pr.week + " (final): " + pr.status + (pr.injury ? " (" + pr.injury + ")" : ""));
    out.label = out.chips.map(function (c) { return c.t; }).join(" ");
    return out;
  }

  // "  ·  Q" for plain text (a dropdown choice); "" when there's no chip.
  function optText(res) {
    return res && res.chips.length ? "  ·  " + res.chips.map(function (c) { return c.t; }).join(" ") : "";
  }

  // The one explanation, for a screen's About.
  function aboutText() { return ABOUT; }

  // A line for the screen ONLY when a source is unavailable or still loading; "" when all is well.
  function noteText(read, opts) {
    opts = opts || {};
    var now = opts.now != null ? opts.now : Date.now();
    if (!fresh(read, now)) {
      if (read && read.state === "error") return opts.fallback ? "Injury status couldn’t be loaded; tags are MFL’s from this page’s own read." : "Injury status couldn’t be loaded, so no injury tags are shown.";
      return "Checking injury status…";
    }
    // MFL unreadable: the report only stands in for it when it is this week's (the worker
    // takes the current week from MFL, so without MFL the report is never current). The
    // report can't be checked when it's unreadable, too old, of unknown age or can't be
    // matched to players; "not posted yet for this week" is normal and gets no line.
    var rf = read.data.report_feed || {}, mfBad = !(read.data.mfl_feed && read.data.mfl_feed.ok);
    var rfDown = rf.ok === false || (!rf.current && !/not out yet|has no Wk \d+ rows/.test(str(rf.reason)));
    if (mfBad && !rf.current) return "Injury status couldn’t be read, so injury tags may be missing.";
    if (mfBad) return "MFL’s injury list couldn’t be read; tags come from the official NFL report.";
    if (rfDown) return "The official NFL report can’t be checked right now; tags are MFL’s alone.";
    return "";
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

  root.UPSInjuryStatus = { TTL: TTL, resolve: resolve, optText: optText, noteText: noteText, aboutText: aboutText, fromMflStore: fromMflStore,
    createLoader: createLoader, fresh: fresh };
})(typeof window !== "undefined" ? window : this);
