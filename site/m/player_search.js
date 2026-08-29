/* UPS Mobile — global player search.
 *
 * WHY THIS EXISTS (Keith 2026-08-29: "we do need a player search function to
 * find any player, whether they're a FA or what not"). Before this the app had
 * two places to look a player up and NEITHER could answer "where is Purdy?":
 *
 *   • #league/stats — its search box filters WITHIN the selected position chip.
 *     Typing "Bijan" while the QB tab is up rendered the empty state "No QB data
 *     for 2025." A real, rostered player reported as missing data.
 *   • #players — defaults to the Free Agents scope, so searching a rostered star
 *     returned zero rows until you first noticed and changed a dropdown.
 *
 * Both also re-rendered the entire view per keystroke, which DESTROYED AND
 * RECREATED the <input> each time. Measured on the stats page 2026-08-29: five
 * keystrokes produced five new input nodes and removed 140 DOM nodes, and focus
 * was lost on EVERY character — on a phone the keyboard dismisses itself
 * mid-word. That is the whole reason searching felt broken rather than merely
 * limited.
 *
 * So: one overlay, reachable from the header on every screen, over the WHOLE MFL
 * player universe — rostered, taxi, IR and free agents alike — opening the
 * existing player sheet on tap. The input is created ONCE and never re-rendered;
 * only the results list is repainted.
 */
(function () {
  var M = window.UPS_MOBILE;
  if (!M) return;
  var U = M.util;

  var RECENT_KEY = "ups_m_recent_players";
  var RECENT_MAX = 8;
  var RESULT_CAP = 60;

  /* MFL's player export is not just players. Verified live 2026-08-29 against
   * the production league: of its 2,610 rows, 422 are team units (TMQB/TMRB/
   * TMWR/TMTE/TMPK/TMPN/TMDL/TMLB/TMDB), team defenses (Def), special teams
   * (ST), team offenses (Off) and coaches — and ZERO of them appear on any of
   * the 12 rosters, because UPS is an IDP league that starts individuals.
   * Indexing them would put "Bills, Buffalo" above Josh Allen for "bills".
   *
   * Keys are UPPERCASE because they are compared against an upper-cased
   * position — MFL writes these four in mixed case ("Def", "ST", "Off",
   * "Coach") and a verbatim map silently let all 96 of them through, which is
   * how Kevin O'Connell (a head coach) turned up in a search for "oconnell". */
  var NON_PLAYER_POS = {
    TMQB: 1, TMRB: 1, TMWR: 1, TMTE: 1, TMPK: 1, TMPN: 1,
    TMDL: 1, TMLB: 1, TMDB: 1, DEF: 1, ST: 1, OFF: 1, COACH: 1
  };

  /* MFL's raw position vocabulary is FINER than the league's scoring groups:
   * the universe carries DT, DE, S and CB and never the DL/DB the stats
   * leaderboard groups them into. A search that trusted `position` verbatim
   * would show "DT" on a chip styled for a group that does not exist. */
  var POS_GROUP = { DT: "DL", DE: "DL", S: "DB", CB: "DB" };

  function posGroupOf(pos) {
    pos = U.safeStr(pos).toUpperCase();
    return POS_GROUP[pos] || pos;
  }

  /* MFL stores names "Last, First" — and with real punctuation in them:
   * "O'Connell, Kevin", "Reader, D.J.", "Nunez-Roches, Rakeem", "Smith,
   * Za'Darius". One normalization cannot serve all of those, so we index two:
   *
   *   spaced — punctuation becomes a separator: "Reader, D.J." -> "reader d j"
   *            (so "connell" finds O'Connell)
   *   tight  — punctuation is deleted:          "Reader, D.J." -> "reader dj"
   *            (so "dj" finds D.J. Reader, and "oconnell" finds O'Connell)
   *
   * Indexing the union of both token sets is what makes every one of those
   * queries land. Dropping either one silently loses a class of name. */
  function normSpaced(s) {
    return U.safeStr(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }
  function normTight(s) {
    return U.safeStr(s).toLowerCase().replace(/[^a-z0-9\s]+/g, "").replace(/\s+/g, " ").trim();
  }

  // "Purdy, Brock" -> "Brock Purdy". Same flip the stats leaderboard does.
  function flipName(raw) {
    raw = U.safeStr(raw);
    if (raw.indexOf(",") >= 0) {
      var p = raw.split(",");
      return ((p[1] || "").trim() + " " + (p[0] || "").trim()).trim();
    }
    return raw;
  }
  function lastNameOf(raw) {
    raw = U.safeStr(raw);
    return raw.indexOf(",") >= 0 ? raw.split(",")[0].trim() : raw.split(/\s+/).pop();
  }

  // ── Index ────────────────────────────────────────────────────────────────
  // Built once and memoized. Rebuilt only when the underlying data actually
  // changes size (a refresh, a trade, a waiver claim), never per keystroke —
  // 2,188 real players is cheap to scan but not cheap to re-derive 5x a word.
  var idx = null, idxKey = "";

  function rosterIndex() {
    var byPid = {};
    var franchises = (M.state.rosters && M.state.rosters.rosters && M.state.rosters.rosters.franchise) || [];
    U.asArray(franchises).forEach(function (f) {
      var fid = U.safeStr(f.id);
      U.asArray(f.player).forEach(function (p) {
        byPid[U.safeStr(p.id)] = { fid: fid, status: U.safeStr(p.status).toUpperCase() };
      });
    });
    return byPid;
  }

  function franchiseName(fid) {
    var f = M.data.findFranchiseById ? M.data.findFranchiseById(fid) : null;
    return U.safeStr((f && (f.name || f.abbrev)) || "");
  }

  function buildIndex() {
    var universe = (M.state.players && M.state.players.players && M.state.players.players.player) || [];
    universe = U.asArray(universe);
    var roster = rosterIndex();
    var key = universe.length + ":" + Object.keys(roster).length + ":" + U.safeStr(M.state.ctx && M.state.ctx.year);
    if (idx && idxKey === key) return idx;

    var adv = (M.data.getAdvancedStatsMap && M.data.getAdvancedStatsMap()) || {};
    var out = [];

    universe.forEach(function (p) {
      var pos = U.safeStr(p.position).toUpperCase();
      if (NON_PLAYER_POS[pos]) return;

      var pid = U.safeStr(p.id);
      var raw = U.safeStr(p.name);
      var display = flipName(raw);
      var team = U.safeStr(p.team).toUpperCase();
      var own = roster[pid] || null;
      var ownerName = own ? franchiseName(own.fid) : "";
      var stat = adv[pid] || null;

      // Union of both normalizations, plus team and owner, so you can search
      // "sfo", "brock purdy", "purdy brock", "dj reader" or an owner's name.
      var bag = normSpaced(display) + " " + normTight(display) + " " +
                normSpaced(team) + " " + normSpaced(ownerName);
      var tokens = bag.split(" ").filter(Boolean);
      var seen = {}, uniq = [];
      tokens.forEach(function (t) { if (!seen[t]) { seen[t] = 1; uniq.push(t); } });

      out.push({
        pid: pid,
        name: display,
        last: normTight(lastNameOf(raw)),
        nameTokens: (normSpaced(display) + " " + normTight(display)).split(" ").filter(Boolean),
        tokens: uniq,
        pos: pos,
        group: posGroupOf(pos),
        team: team,
        fid: own ? own.fid : "",
        owner: ownerName,
        // ROSTER / TAXI_SQUAD / INJURED_RESERVE — the roster feed's own words.
        rosterStatus: own ? own.status : "",
        ppg: stat && stat.mfl_ppg != null ? Number(stat.mfl_ppg) : null,
        posRank: stat && stat.posRank != null ? Number(stat.posRank) : null
      });
    });

    idx = out;
    idxKey = key;
    return idx;
  }

  // ── Matching ─────────────────────────────────────────────────────────────
  // Every query token must prefix-match some indexed token. Order-independent,
  // so "brock purdy" and "purdy brock" behave the same.
  function scoreFor(rec, qTokens, qTight) {
    var i, j, t, hit, matchedName = false;
    for (i = 0; i < qTokens.length; i++) {
      t = qTokens[i];
      hit = false;
      for (j = 0; j < rec.tokens.length; j++) {
        if (rec.tokens[j].indexOf(t) === 0) { hit = true; break; }
      }
      if (!hit) return -1;
      for (j = 0; j < rec.nameTokens.length; j++) {
        if (rec.nameTokens[j].indexOf(t) === 0) { matchedName = true; break; }
      }
    }
    // Rank intent, not just membership: a last-name hit beats a first-name hit,
    // which beats matching only on team or owner. Without this, searching
    // "purdy" would let anyone on a roster owned by a "Purdy" outrank Brock.
    if (rec.last && rec.last.indexOf(qTight) === 0) return 3;
    if (matchedName) return 2;
    return 1;
  }

  function search(q) {
    var recs = buildIndex();
    var qTight = normTight(q);
    var qTokens = normSpaced(q).split(" ").filter(Boolean);
    if (!qTokens.length) return [];

    var hits = [];
    for (var i = 0; i < recs.length; i++) {
      var s = scoreFor(recs[i], qTokens, qTight);
      if (s > 0) hits.push({ r: recs[i], s: s });
    }
    hits.sort(function (a, b) {
      if (b.s !== a.s) return b.s - a.s;
      // Then by fantasy relevance. Only ~520 of the 2,188 players carry a PPG;
      // the rest are deep-bench names that should never outrank a starter, so
      // "no PPG" sorts last rather than as zero.
      var ap = a.r.ppg, bp = b.r.ppg;
      if (ap == null && bp == null) return a.r.name.localeCompare(b.r.name);
      if (ap == null) return 1;
      if (bp == null) return -1;
      if (bp !== ap) return bp - ap;
      return a.r.name.localeCompare(b.r.name);
    });
    return hits.map(function (h) { return h.r; });
  }

  // ── Recently viewed ──────────────────────────────────────────────────────
  // Player ids, not query strings: "who did I just look at" is the thing you
  // actually want to reopen.
  function readRecent() {
    try {
      var raw = window.localStorage && window.localStorage.getItem(RECENT_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Object.prototype.toString.call(arr) === "[object Array]" ? arr.map(String) : [];
    } catch (e) { return []; }
  }
  function pushRecent(pid) {
    pid = U.safeStr(pid);
    if (!pid) return;
    try {
      var list = readRecent().filter(function (x) { return x !== pid; });
      list.unshift(pid);
      window.localStorage && window.localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
    } catch (e) {}
  }

  // ── Render ───────────────────────────────────────────────────────────────
  function ownerHtml(r) {
    if (!r.fid) return '<span class="own fa">FA</span>';
    var extra = "";
    if (r.rosterStatus === "TAXI_SQUAD") extra = '<span class="tag taxi">TAXI</span>';
    else if (r.rosterStatus === "INJURED_RESERVE") extra = '<span class="tag ir">IR</span>';
    return '<span class="own">' + U.escapeHtml(r.owner || "Rostered") + "</span>" + extra;
  }

  function rowHtml(r) {
    var rank = (r.posRank != null && r.ppg != null)
      ? '<span class="rk">#' + r.posRank + " " + U.escapeHtml(r.group) + "</span>"
      : "";
    var ppg = r.ppg != null
      ? '<span class="ppg">' + r.ppg.toFixed(1) + '<i>PPG</i></span>'
      : '<span class="ppg none">—</span>';
    return '<button type="button" class="ups-m-psr-row" data-pid="' + U.escapeHtml(r.pid) + '">' +
      '<span class="pos ' + U.escapeHtml(r.group.toLowerCase()) + '">' + U.escapeHtml(r.group) + "</span>" +
      '<span class="body">' +
        '<span class="nm">' + U.escapeHtml(r.name) + "</span>" +
        '<span class="sub">' + (r.team ? U.escapeHtml(r.team) + " · " : "") + ownerHtml(r) + "</span>" +
      "</span>" +
      '<span class="num">' + ppg + rank + "</span>" +
    "</button>";
  }

  function resultsHtml(q) {
    var universe = (M.state.players && M.state.players.players && M.state.players.players.player) || [];
    if (!U.asArray(universe).length) {
      return '<div class="ups-m-psr-empty"><div class="t">Still loading players…</div>' +
        '<div class="s">Give it a second and try again.</div></div>';
    }

    if (!U.safeStr(q).trim()) {
      var recent = readRecent();
      var recs = buildIndex();
      var byPid = {};
      recs.forEach(function (r) { byPid[r.pid] = r; });
      var have = recent.map(function (p) { return byPid[p]; }).filter(Boolean);
      if (!have.length) {
        return '<div class="ups-m-psr-empty">' +
          '<div class="t">Search any player in the league</div>' +
          '<div class="s">Rostered, taxi, IR or free agent — ' + recs.length +
          ' players. Try a name, an NFL team like SFO, or an owner.</div></div>';
      }
      return '<div class="ups-m-psr-sec">Recently viewed</div>' +
        have.map(rowHtml).join("");
    }

    var hits = search(q);
    if (!hits.length) {
      return '<div class="ups-m-psr-empty"><div class="t">No player matches “' +
        U.escapeHtml(q) + '”</div><div class="s">Names are searchable in any order — ' +
        'try just a last name.</div></div>';
    }
    var capped = hits.slice(0, RESULT_CAP);
    var more = hits.length > capped.length
      ? '<div class="ups-m-psr-more">Showing ' + capped.length + " of " + hits.length + " matches</div>"
      : "";
    return capped.map(rowHtml).join("") + more;
  }

  // ── Overlay ──────────────────────────────────────────────────────────────
  var el = null, inputEl = null, listEl = null, pushedHistory = false;

  function isOpen() { return !!el; }

  function repaint() {
    if (!listEl) return;
    // ONLY the list is repainted. inputEl is never touched, which is the entire
    // point of this module — see the header comment.
    listEl.innerHTML = resultsHtml(inputEl ? inputEl.value : "");
    listEl.scrollTop = 0;
  }

  function onResultTap(e) {
    var btn = e.target && e.target.closest ? e.target.closest(".ups-m-psr-row") : null;
    if (!btn) return;
    var pid = btn.getAttribute("data-pid");
    if (!pid) return;
    pushRecent(pid);
    // The sheet sits at z-index 100+ and this overlay at 90, so the sheet opens
    // OVER the results and closing it drops you back on your search rather than
    // back to whatever screen you started from.
    if (M.sheet && M.sheet.open) M.sheet.open(pid);
  }

  /* player_sheet.js:51-53 already listens for Escape on `document`, with no
   * capture and no stopPropagation, so with a sheet open over the results BOTH
   * handlers fire — one Escape closed the sheet AND the search behind it
   * (measured, this session). Escape should peel one layer at a time.
   *
   * The guard has to run BEFORE the sheet's handler clears the `open` class,
   * or it looks up a sheet that has already closed itself and concludes it is
   * safe to close the search too. Hence capture phase: a real keystroke starts
   * at the focused input and reaches this document-level capture listener on
   * the way DOWN, while the sheet's listener only fires on the way back up. */
  function sheetIsOpen() {
    var s = document.querySelector(".ups-m-sheet-overlay");
    return !!(s && s.classList.contains("open"));
  }

  function onKeyDown(e) {
    if (e.key !== "Escape") return;
    if (sheetIsOpen()) return;
    e.preventDefault();
    close();
  }

  function open() {
    if (isOpen()) return;

    el = document.createElement("div");
    el.className = "ups-m-psr";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "Player search");
    el.innerHTML =
      '<div class="ups-m-psr-bar">' +
        '<button type="button" class="ups-m-psr-back" aria-label="Close search">' +
          '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
          'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="m15 18-6-6 6-6"/></svg>' +
        "</button>" +
        '<input type="search" class="ups-m-psr-input" id="ups-m-psr-input" ' +
          'placeholder="Search any player" autocomplete="off" autocorrect="off" ' +
          'autocapitalize="off" spellcheck="false" enterkeyhint="search" />' +
        '<button type="button" class="ups-m-psr-clear" aria-label="Clear">' +
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
          'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>' +
        "</button>" +
      "</div>" +
      '<div class="ups-m-psr-list" id="ups-m-psr-list"></div>';

    document.body.appendChild(el);
    inputEl = el.querySelector(".ups-m-psr-input");
    listEl = el.querySelector(".ups-m-psr-list");

    // Repaint on input — no debounce needed. Scanning ~2,188 prebuilt token
    // bags is sub-millisecond, and a debounce here would only add lag to a
    // list that is already keeping up with the keyboard.
    inputEl.addEventListener("input", repaint);
    listEl.addEventListener("click", onResultTap);
    el.querySelector(".ups-m-psr-back").addEventListener("click", function () { close(); });
    el.querySelector(".ups-m-psr-clear").addEventListener("click", function () {
      inputEl.value = "";
      repaint();
      inputEl.focus();
    });
    document.addEventListener("keydown", onKeyDown, true);

    // Hardware/browser back should dismiss the overlay, not navigate away from
    // the screen underneath it. The app routes on the hash, and this pushes a
    // state WITHOUT touching the hash, so popping it fires popstate and never
    // a hashchange — the view behind is left exactly as it was.
    try {
      if (window.history && window.history.pushState) {
        window.history.pushState({ upsPlayerSearch: 1 }, "");
        pushedHistory = true;
      }
    } catch (e) { pushedHistory = false; }

    repaint();
    // iOS only raises the keyboard for a focus() inside the same gesture that
    // created the element, so this must stay synchronous with the tap.
    inputEl.focus();
  }

  function teardown() {
    document.removeEventListener("keydown", onKeyDown, true);
    if (el && el.parentNode) el.parentNode.removeChild(el);
    el = null; inputEl = null; listEl = null;
  }

  function close() {
    if (!isOpen()) return;
    var hadHistory = pushedHistory;
    pushedHistory = false;
    teardown();
    // Consume the state we pushed so the next Back goes where the user expects
    // instead of silently undoing this one.
    if (hadHistory) { try { window.history.back(); } catch (e) {} }
  }

  window.addEventListener("popstate", function () {
    if (!isOpen()) return;
    pushedHistory = false;   // the pop already consumed it
    teardown();
  });

  /* Any route change must take this overlay with it. app.js:2968-2982 carries
   * the scar tissue for exactly this class of bug — full-screen overlays are
   * appended outside the #ups-m-main that renderRoute() repaints, so a
   * navigation used to swap the screen SILENTLY UNDERNEATH a still-open
   * overlay, and dismissing it dropped you somewhere you never chose.
   *
   * This overlay covers the bottom nav (z-index 90 vs 30), so the user cannot
   * tap their way out of it — but the player sheet CAN navigate (its "Propose
   * trade" action, for one), and that route change would otherwise leave the
   * results sitting on top of the trade screen. Tear down without touching
   * history: the hash has already moved on, and calling back() here would fight
   * the navigation the user just asked for. */
  window.addEventListener("hashchange", function () {
    if (!isOpen()) return;
    pushedHistory = false;
    teardown();
  });

  // ── Header entry point ───────────────────────────────────────────────────
  function bindHeaderButton() {
    var btn = document.getElementById("ups-m-header-search");
    if (!btn || btn.__upsBound) return;
    btn.__upsBound = true;
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      open();
    });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindHeaderButton);
  } else {
    bindHeaderButton();
  }

  M.playerSearch = {
    open: open,
    close: close,
    isOpen: isOpen,
    // Exposed so the stats view can hand its query straight over when the user
    // asks to widen a position-scoped search to the whole league.
    openWith: function (q) {
      open();
      if (inputEl) { inputEl.value = U.safeStr(q); repaint(); }
    },
    search: search,
    _buildIndex: buildIndex
  };
})();
