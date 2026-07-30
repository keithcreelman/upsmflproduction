/* Players tab — Free-agent browser + in-app waiver acquisition.
   Free agents = anyone in players export NOT on any roster (exempts taxi/IR
   since those ARE on rosters). Rows show Name / POS / NFL team / YTD Pts /
   PPG. Tap row opens player sheet.

   ACQUISITION (2026-07-30 — in-app waivers, Phase 3):
   This file used to deep-link out to MFL's native /add_drop form because no
   UPS worker route existed. It now drives the real thing:
     POST /api/waivers/bbid-plan   — blind-bid rounds (see §2 below)
     POST /api/waivers/fcfs        — a one-shot first-come add
   The window (blind-bid vs FCFS vs blackout vs not-yet-open) is NEVER derived
   here: it comes from GET /api/waivers/state, which mirrors MFL's own league
   calendar (WAIVER_BBID runs, WAIVER_NONE blackout spans). See
   docs/ups_v2/V2_GOVERNED/requirements/actions/add_action_rule.md — the rule
   that a player either gets a real Add, a real Bid, or context text, but
   never a dead/disabled button.

   CONTRACT v2 (the rules this file must not break):
     §1 pending/verified claims arrive as { known, rounds }. Adopt server
        state ONLY when known === true. known:false = "we couldn't read MFL",
        which is NOT "you have no claims" — keep the local plan, warn visibly.
     §2 clearing a round is EXPLICIT: a round sent with picks:[] is cleared, a
        round left OUT of the payload is untouched. `rounds: []` therefore
        means "change nothing". Withdrawing = sending the round back empty.
     §3 a dry run writes nothing, so it is never truth: render would_write as
        a preview and leave the local plan alone.
     §4 the mode is window.mode from the server. Never re-derived here.
     §5 write_enabled false → read-only view + the MFL link, no submit CTA.
     §6 roster/cap headroom is ADVISORY. Never hard-block on our own math.

   The drop sheet that was parked here in 2026-05-15 is resurrected as a
   general-purpose drop PICKER (openDropPicker) and now serves three callers:
   the FCFS drop list, the BBID conditional drop, and re-editing a staged pick.
*/
(function () {
  "use strict";
  if (!window.UPS_MOBILE) return;
  var M = window.UPS_MOBILE;
  var U = M.util;
  var DATA = M.data;

  var POSITIONS = ["ALL", "QB", "RB", "WR", "TE", "PK", "PN", "DL", "LB", "DB"];
  var POS_GROUP = {
    DT: "DL", DE: "DL",
    LB: "LB",
    CB: "DB", S: "DB"
  };
  var REGULAR_SEASON_WEEKS = 17;

  // Volatile UI state — survives between renders within one session.
  var view = {
    query: "",
    pos: "ALL",
    scope: "fa",    // "fa" (default) | "all" — Keith 2026-06-08: allow browsing ALL players
    teamFilter: "", // "" = none | franchise id — filter list to one team (Keith 2026-06-10)
    sort: "ppg",    // "ppg" | "pts"
    debounceTimer: null,
    dropSheetFor: null   // pid of player being added (drop-sheet open)
  };

  // Bid-sheet working state. `editRef` is set when re-opening an already
  // staged pick so Confirm replaces it in place instead of appending.
  var bidView = null;
  // Drop-picker callback for the currently open picker.
  var dropPicker = null;

  function franchiseName(fid) {
    var f = (M.state.franchises || []).find(function (x) { return x.id === U.pad4(fid); });
    return f ? f.name : ("Franchise " + fid);
  }
  // pid → owning franchise id (for "All players" scope → propose-trade).
  function rosteredFidByPid() {
    var map = {};
    var rs = M.state.rosters && M.state.rosters.rosters;
    if (rs) {
      U.asArray(rs.franchise).forEach(function (fr) {
        var fid = U.pad4(fr.id);
        U.asArray(fr.player).forEach(function (p) { if (p && p.id) map[String(p.id)] = fid; });
      });
    }
    return map;
  }

  function nameFor(player) {
    var raw = U.safeStr(player && player.name);
    if (!raw) return "";
    if (raw.indexOf(",") >= 0) {
      var parts = raw.split(",");
      var last = (parts[0] || "").trim();
      var rest = (parts[1] || "").trim();
      return rest ? rest + " " + last : last;
    }
    return raw;
  }
  function nameForPid(pid) {
    return nameFor(DATA.playerById(pid)) || ("Player " + pid);
  }
  function posTeamForPid(pid) {
    var p = DATA.playerById(pid);
    var pos = U.safeStr(p && p.position).toUpperCase();
    var team = U.safeStr(p && p.team);
    return pos + (team ? " · " + team : "");
  }

  // Approximate games played in the current season = completed NFL weeks.
  // Bench/IR weeks count, but for FA browsing this is good enough as a
  // common denominator. League_context §6.B uses regular-season weeks.
  function approxGamesPlayed() {
    var ctx = M.state.ctx;
    var seasonNum = parseInt(ctx.year, 10) || (new Date().getUTCFullYear());
    // NFL_WEEK1_KICKOFF table lives in app.js; mirror it minimally here.
    var KICKOFF = {
      2024: new Date(2024, 8, 5),
      2025: new Date(2025, 8, 4),
      2026: new Date(2026, 8, 10),
      2027: new Date(2027, 8, 9)
    };
    var kickoff = KICKOFF[seasonNum];
    if (!kickoff) return 0;
    var now = new Date();
    var diffMs = now.getTime() - kickoff.getTime();
    if (diffMs < 0) return 0;
    return Math.max(0, Math.min(REGULAR_SEASON_WEEKS,
      Math.floor(diffMs / (7 * 24 * 60 * 60 * 1000))));
  }

  function buildFreeAgents() {
    var rostered = DATA.getAllRosteredPids();
    // "All Players" OR a specific team filter both need rostered players in
    // the list + their owner mapping.
    var showAll = (view.scope === "all") || !!view.teamFilter;
    var fidByPid = showAll ? rosteredFidByPid() : null;
    // Canonical UPS-scored stats — from Advanced Stats Workbench leaderboard.
    // Falls back to MFL YTD playerScores if the leaderboard didn't return
    // a row for this pid (rare; usually means the player didn't play this season).
    var advStats = DATA.getAdvancedStatsMap ? DATA.getAdvancedStatsMap() : {};
    var ytdScores = DATA.getYtdScoresMap();
    var fallbackGames = Math.max(1, approxGamesPlayed());
    var players = (M.state.players && M.state.players.players) || null;
    if (!players) return [];
    var list = U.asArray(players.player);
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!p || !p.id) continue;
      var pid = String(p.id);
      var isRostered = rostered.has(pid);
      if (!showAll && isRostered) continue;
      var pos = U.safeStr(p.position).toUpperCase();
      if (!pos) continue;
      var group = POS_GROUP[pos] || pos;
      var stats = advStats[pid] || null;
      var pts = stats ? stats.mfl_points : Number(ytdScores[pid] || 0);
      var ppg = stats ? stats.mfl_ppg : (fallbackGames > 0 ? pts / fallbackGames : 0);
      var rank = stats ? stats.posRank : 0;
      var keep = pts > 0 || ["QB", "RB", "WR", "TE", "PK", "PN"].indexOf(group) !== -1
                 || ["DL", "LB", "DB"].indexOf(group) !== -1;
      if (!keep) continue;
      out.push({
        id: pid,
        name: nameFor(p) || ("Player " + pid),
        pos: pos,
        group: group,
        team: U.safeStr(p.team),
        ytdPts: pts,
        ppg: ppg,
        posRank: rank,
        rosteredFid: (isRostered && fidByPid) ? (fidByPid[pid] || "") : ""
      });
    }
    return out;
  }

  function filterAndSort(all) {
    var q = view.query.trim().toLowerCase();
    var pos = view.pos;
    var filtered = all.filter(function (r) {
      if (view.teamFilter && r.rosteredFid !== view.teamFilter) return false;
      if (pos !== "ALL" && r.group !== pos) return false;
      if (q) {
        var hay = (r.name + " " + r.team + " " + r.pos).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
    if (view.sort === "pts") {
      filtered.sort(function (a, b) { return b.ytdPts - a.ytdPts; });
    } else {
      filtered.sort(function (a, b) { return b.ppg - a.ppg; });
    }
    return filtered;
  }

  // ══ Waiver window / CTA resolution ═════════════════════════════════════
  // Everything below reads M.waivers (app.js), which reads
  // GET /api/waivers/state. No waiver timing is computed in this file, and
  // per contract v2 §4 the MODE is not re-derived either — `window.mode` is
  // the server's answer and we render off it verbatim.

  function waiverModeInfo() {
    return (M.waivers && M.waivers.mode)
      ? M.waivers.mode()
      : { mode: "unknown", label: "", detail: "", writeEnabled: false, nativeLink: "" };
  }
  // §5: no submit/add control may render while the server says writes are off.
  function writeEnabled() {
    return !!(M.waivers && M.waivers.writeEnabled && M.waivers.writeEnabled());
  }
  function nativeLink() {
    return (M.waivers && M.waivers.nativeLink) ? M.waivers.nativeLink() : "";
  }
  function waiverLimits() {
    return (M.waivers && M.waivers.limits) ? M.waivers.limits() : null;
  }
  function stagedPlan() {
    return (M.waivers && M.waivers.getPlan) ? M.waivers.getPlan() : [];
  }
  function stagedCount() {
    return (M.waivers && M.waivers.pickCount) ? M.waivers.pickCount() : 0;
  }
  // Rounds staged for an explicit clear (a pending withdrawal). Submittable
  // work that carries no picks — see contract v2 §2.
  function clearCount() {
    return (M.waivers && M.waivers.clearCount) ? M.waivers.clearCount() : 0;
  }
  function planIsDirty() {
    return !!(M.waivers && M.waivers.isDirty && M.waivers.isDirty());
  }
  // What MFL last told us it is holding. `known:false` means the read failed
  // — the count is not zero, it is UNKNOWN, and the UI must say so rather
  // than implying an empty slate (contract v2 §1).
  function pendingInfo() {
    var p = (M.waivers && M.waivers.getPending) ? M.waivers.getPending() : null;
    var known = !!(p && p.known === true && Array.isArray(p.rounds));
    var rounds = known ? p.rounds : [];
    var count = rounds.reduce(function (n, g) { return n + ((g.picks || []).length); }, 0);
    return { known: known, count: count, rounds: rounds };
  }
  // The read-only escape hatch. Offered instead of a write whenever the kill
  // switch is dark — never a button whose only outcome is a 503.
  function openNativeWaiverPage() {
    var link = nativeLink();
    if (!link) {
      M.ui.showToast("In-app waiver moves are switched off right now.", "err");
      return;
    }
    if (window.confirm("In-app waiver moves are switched off right now.\n\nOpen MFL's own add/drop page?")) {
      window.open(link, "_blank");
    }
  }
  // Which groups is this player already claimed in? (Same player in multiple
  // priority groups is legal — we surface it, we don't block it.)
  function stagedRoundsFor(pid) {
    var rounds = [];
    stagedPlan().forEach(function (g) {
      (g.picks || []).forEach(function (p) {
        if (String(p.add_pid) === String(pid)) rounds.push(g.round);
      });
    });
    return rounds;
  }

  // The one place that decides which acquisition control an unrostered
  // player gets. Three outcomes, per add_action_rule.md:
  //   bbid → "Bid"      fcfs → "Add"      anything else → NO button.
  // A missing waiver state, missing limits, or no signed-in franchise all
  // collapse to "no button", because the spec would rather show nothing
  // than a control that can't work.
  //
  // §5 adds one more: `write_enabled:false` from the server means NO submit
  // control renders at all — the surfaces show the read-only view plus the
  // MFL native link instead. `info.writeEnabled` already folds the kill
  // switch together with the window, so this is the whole check.
  function acquisitionCta(pid, opts) {
    opts = opts || {};
    var info = waiverModeInfo();
    if (!M.state.viewerFranchiseId) return { mode: "unknown", html: "" };
    if (!info.writeEnabled) return { mode: info.mode, html: "", readOnly: true };
    if (info.mode === "bbid") {
      if (!waiverLimits()) return { mode: "unknown", html: "" };
      var rounds = stagedRoundsFor(pid);
      var label = rounds.length
        ? ("Bid ✓" + (rounds.length > 1 ? " ×" + rounds.length : ""))
        : "Bid";
      return {
        mode: "bbid",
        html: '<button class="ups-m-fa-add bid' + (rounds.length ? " staged" : "") +
          '" data-act="waiver-bid" data-pid="' + U.escapeHtml(String(pid)) + '">' +
          U.escapeHtml(label) + '</button>'
      };
    }
    if (info.mode === "fcfs") {
      return {
        mode: "fcfs",
        html: '<button class="ups-m-fa-add" data-act="waiver-add" data-pid="' +
          U.escapeHtml(String(pid)) + '">' +
          (opts.longLabel ? "Add now — $1K, 1-yr WW" : "Add") + '</button>'
      };
    }
    return { mode: info.mode, html: "" };
  }

  // Context strip above the list: what window are we in, and a Claims entry
  // point. When there's no button to show, this line IS the answer.
  function renderWaiverStrip() {
    var info = waiverModeInfo();
    if (info.mode === "unknown" && !stagedCount() && !clearCount()) return "";
    var cls = "ups-m-waiver-strip " + info.mode + (info.writeEnabled ? "" : " readonly");
    var w = (M.state.waiverState && M.state.waiverState.window) || null;
    var detail = info.detail || "";
    if (info.mode === "bbid" && w && w.next_bbid_run_unix && M.waivers.countdown) {
      var cd = M.waivers.countdown(w.next_bbid_run_unix);
      if (cd) detail += " (" + cd + ")";
    }
    var n = stagedCount() + clearCount();
    // The viewer block's count is only a number when the server could READ
    // MFL. Unknown is NOT zero, so this takes the count only on an explicit
    // known:true. The worker emits the flag under BOTH `known` (canonical) and
    // `pending_known` (alias, identical value) — grep-verified in
    // /api/waivers/state — and pending_pick_count is null whenever it is false.
    var pendingN = 0;
    var viewer = M.state.waiverState && M.state.waiverState.viewer;
    var viewerKnown = !!viewer && (viewer.known === true || viewer.pending_known === true);
    if (viewerKnown && viewer.pending_pick_count != null) {
      pendingN = U.safeInt(viewer.pending_pick_count, 0);
    }
    var chipN = n || pendingN;
    var chip = (info.mode === "bbid" || chipN > 0)
      ? '<button class="ups-m-waiver-claims-chip' + (planIsDirty() && n ? " dirty" : "") +
          '" data-act="open-claims">Claims' + (chipN ? " (" + chipN + ")" : "") + '</button>'
      : "";
    // §5: when writes are dark in an otherwise-live window, the link out to
    // MFL replaces the CTA that would only have 503'd.
    var link = "";
    if (!info.writeEnabled && (info.mode === "bbid" || info.mode === "fcfs") && info.nativeLink) {
      link = ' <a class="ups-m-waiver-native" href="' + U.escapeHtml(info.nativeLink) +
        '" target="_blank" rel="noopener">Add/drop on MFL</a>';
    }
    return '<div class="' + cls + '">' +
      '<span class="txt">' + U.escapeHtml(detail) + link + '</span>' + chip +
    '</div>';
  }

  function renderToolbar() {
    var chips = POSITIONS.map(function (p) {
      var label = p === "ALL" ? "All" : p;
      return '<button class="ups-m-pos-chip' + (view.pos === p ? " on" : "") +
        '" data-pos="' + U.escapeHtml(p) + '">' + U.escapeHtml(label) + '</button>';
    }).join("");
    // One filter for team/FA (Keith 2026-06-10): Free Agents · All Players ·
    // then each franchise. Replaces the old FA/All toggle + the redundant
    // Market hub tiles.
    var teamOpts = (M.state.franchises || []).slice().sort(function (a, b) {
      return U.safeStr(a.name).localeCompare(U.safeStr(b.name));
    }).map(function (f) {
      return '<option value="team:' + U.escapeHtml(f.id) + '"' + (view.teamFilter === f.id ? ' selected' : '') + '>' +
        U.escapeHtml(f.name || f.abbrev || f.id) + '</option>';
    }).join("");
    var scopeToggle = '<select class="ups-m-players-filter" id="ups-m-players-filter" aria-label="Filter players by team or free-agent status">' +
      '<option value="fa"' + (view.scope !== "all" && !view.teamFilter ? ' selected' : '') + '>Free Agents</option>' +
      '<option value="all"' + (view.scope === "all" && !view.teamFilter ? ' selected' : '') + '>All Players</option>' +
      '<optgroup label="By team">' + teamOpts + '</optgroup>' +
    '</select>';
    return '<div class="ups-m-players-toolbar">' +
      scopeToggle +
      '<input type="search" class="ups-m-players-search" id="ups-m-players-search" ' +
        'placeholder="' + (view.scope === "all" ? "Search all players…" : "Search free agents…") + '" autocomplete="off" autocorrect="off" ' +
        'value="' + U.escapeHtml(view.query) + '" />' +
      '<div class="ups-m-pos-chips">' + chips + '</div>' +
      '<div class="ups-m-sort-row">' +
        '<button class="ups-m-sort-btn' + (view.sort === "ppg" ? " on" : "") + '" data-sort="ppg">PPG</button>' +
        '<button class="ups-m-sort-btn' + (view.sort === "pts" ? " on" : "") + '" data-sort="pts">YTD Pts</button>' +
      '</div>' +
    '</div>' + renderWaiverStrip();
  }

  function renderRows(rows) {
    if (!rows.length) {
      return '<div class="ups-m-stub"><div>No matching ' + (view.scope === "all" ? "players" : "free agents") + '.</div></div>';
    }
    var capped = rows.slice(0, 200); // limit DOM cost on mobile
    var myFid = U.pad4(M.state.viewerFranchiseId);
    var html = '<div class="ups-m-fa-list">';
    capped.forEach(function (r, idx) {
      var posClass = r.group.toLowerCase();
      // Rostered player (All-players scope): show the owner; offer Propose
      // trade for players on OTHER teams (Keith 2026-06-08).
      // Unrostered player: the acquisition CTA for the CURRENT waiver window
      // (Bid / Add / nothing) — see acquisitionCta.
      var ownerTag = "", actionBtn = "";
      if (r.rosteredFid) {
        if (r.rosteredFid === myFid) {
          ownerTag = '<span class="owned you">Your team</span>';
        } else {
          ownerTag = '<span class="owned">' + U.escapeHtml(franchiseName(r.rosteredFid)) + '</span>';
          actionBtn = '<button class="ups-m-fa-trade" data-act="propose-trade" data-fid="' + U.escapeHtml(r.rosteredFid) + '" data-pid="' + U.escapeHtml(r.id) + '">Propose trade</button>';
        }
      } else {
        actionBtn = acquisitionCta(r.id).html;
      }
      html += '<div class="ups-m-fa-row' + (actionBtn ? ' has-act' : '') + '" data-pid="' + U.escapeHtml(r.id) + '">' +
        '<div class="rank">' + (idx + 1) + '</div>' +
        '<div class="pos ' + posClass + '">' + U.escapeHtml(r.pos) + '</div>' +
        '<div class="body">' +
          '<div class="name">' + U.escapeHtml(r.name) + '</div>' +
          '<div class="sub">' +
            ownerTag +
            (r.team ? '<span>' + U.escapeHtml(r.team) + '</span>' : '') +
            '<span>YTD ' + (Math.round(r.ytdPts * 10) / 10).toFixed(1) + '</span>' +
            '<span>PPG ' + (Math.round(r.ppg * 10) / 10).toFixed(1) + '</span>' +
            (r.posRank > 0 ? '<span>#' + r.posRank + ' ' + U.escapeHtml(r.group) + '</span>' : '') +
          '</div>' +
        '</div>' +
        actionBtn +
      '</div>';
    });
    if (rows.length > capped.length) {
      html += '<div class="ups-m-fa-more">Showing top ' + capped.length + ' of ' + rows.length + ' — refine your search to see more.</div>';
    }
    html += '</div>';
    return html;
  }

  // ══ Drop picker ════════════════════════════════════════════════════════
  // Full-roster list, cheapest cap penalty first. Penalties come from
  // DATA.dropPenaltyFor, which prefers the worker's authoritative
  // /api/cap-penalty/preview batch (state.capPenaltyByPid) and only falls
  // back to local math when that hasn't landed.
  function dropCandidateRows() {
    var fid = M.state.viewerFranchiseId;
    if (!fid) return [];
    return DATA.getRosterFor(fid).map(function (r) {
      var p = DATA.playerById(r.id);
      var penalty = DATA.dropPenaltyFor(r, M.state.ctx.year);
      var pAmt = (penalty && typeof penalty.amount === "number") ? penalty.amount : 0;
      return {
        id: r.id,
        name: nameFor(p) || ("Player " + r.id),
        pos: U.safeStr(p && p.position).toUpperCase(),
        team: U.safeStr(p && p.team),
        salary: r.salary,
        contractYear: r.contractYear,
        penaltyAmt: pAmt,
        // authoritative === straight from the worker; false means we're
        // showing the offline estimate and should say so.
        authoritative: !!(penalty && penalty.authoritative),
        penaltyNote: (penalty && penalty.note) || ""
      };
    }).sort(function (a, b) { return a.penaltyAmt - b.penaltyAmt; });
  }

  function renderDropSheet(opts) {
    var fid = M.state.viewerFranchiseId;
    if (!fid) return "";
    var cap = DATA.computeCap(fid);
    var rosterRows = dropCandidateRows();
    var anyEstimate = rosterRows.some(function (r) { return !r.authoritative; });

    var rows = rosterRows.map(function (r) {
      // What cap room would look like AFTER the drop. The add side is not
      // included — a blind bid's price isn't settled until the run, and an
      // FCFS add is the league-default $1K WW.
      var roomAfter = cap.capRoom + Math.max(0, r.salary) - r.penaltyAmt;
      var pLabel = r.penaltyAmt > 0
        ? '<span class="penalty">' + U.fmtUsd(r.penaltyAmt) + ' penalty</span>'
        : '<span class="penalty ok">no penalty</span>';
      var selected = opts.selectedPid && String(opts.selectedPid) === String(r.id);
      return '<button class="ups-m-drop-row' + (selected ? " on" : "") + '" data-drop-pid="' + U.escapeHtml(r.id) + '">' +
        '<div class="body">' +
          '<div class="name">' + U.escapeHtml(r.name) + '</div>' +
          '<div class="sub">' +
            U.escapeHtml(r.pos) + (r.team ? ' · ' + U.escapeHtml(r.team) : '') +
            ' · ' + U.fmtUsd(r.salary) + (r.contractYear ? ' (' + U.escapeHtml(r.contractYear) + 'yr)' : '') +
          '</div>' +
        '</div>' +
        '<div class="right">' +
          pLabel +
          '<div class="after">Cap room after: ' + U.fmtUsd(roomAfter) + '</div>' +
        '</div>' +
      '</button>';
    }).join("");

    var noneRow = opts.allowNone
      ? '<button class="ups-m-drop-row none' + (!opts.selectedPid ? " on" : "") + '" data-drop-pid="">' +
          '<div class="body"><div class="name">No drop</div>' +
          '<div class="sub">' + U.escapeHtml(opts.noneSub || "Only add if there is room.") + '</div></div>' +
        '</button>'
      : "";

    return '<div class="ups-m-drop-overlay" id="ups-m-drop-overlay">' +
      '<div class="ups-m-drop-sheet">' +
        '<div class="ups-m-drop-head">' +
          '<button class="ups-m-drop-close" id="ups-m-drop-close" aria-label="Close">×</button>' +
          '<div class="grip"></div>' +
          '<div class="title">' + U.escapeHtml(opts.title || "Drop which player?") + '</div>' +
          '<div class="sub">' + (opts.sub || "") + '</div>' +
        '</div>' +
        '<div class="ups-m-drop-body">' + noneRow + rows + '</div>' +
        (anyEstimate
          ? '<div class="ups-m-drop-foot">Penalties are estimates until the cap service responds — MFL charges the league-canonical amount.</div>'
          : '') +
      '</div>' +
    '</div>';
  }

  function closeDropSheet() {
    view.dropSheetFor = null;
    dropPicker = null;
    var ov = document.getElementById("ups-m-drop-overlay");
    if (ov) ov.remove();
    // The bid sheet / claims screen may still be open underneath — only
    // release the page scroll when nothing modal is left.
    if (!document.getElementById("ups-m-bid-overlay") &&
        !document.getElementById("ups-m-claims-overlay")) {
      document.body.style.overflow = "";
    }
  }

  // opts: { title, sub, allowNone, noneSub, selectedPid, onPick(pidOrEmpty) }
  // NOTE: `sub` is injected as HTML so callers can bold a player name; every
  // caller in this file escapes the dynamic part with U.escapeHtml first.
  // `title` / `noneSub` are escaped for you.
  function openDropPicker(opts) {
    opts = opts || {};
    closeDropSheet();
    if (!M.state.viewerFranchiseId) return;
    dropPicker = opts;
    view.dropSheetFor = opts.addPid || null;
    var mount = document.getElementById("ups-m-app");
    if (!mount) return;
    mount.insertAdjacentHTML("beforeend", renderDropSheet(opts));
    document.body.style.overflow = "hidden";
    var overlay = document.getElementById("ups-m-drop-overlay");
    if (!overlay) return;
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) closeDropSheet();
    });
    var closeBtn = document.getElementById("ups-m-drop-close");
    if (closeBtn) closeBtn.addEventListener("click", closeDropSheet);
    var rows = overlay.querySelectorAll(".ups-m-drop-row");
    for (var i = 0; i < rows.length; i++) {
      rows[i].addEventListener("click", function () {
        var dropPid = this.getAttribute("data-drop-pid") || "";
        var cb = dropPicker && dropPicker.onPick;
        closeDropSheet();
        if (cb) cb(dropPid);
      });
    }
  }

  // ══ Bid sheet (BBID) ═══════════════════════════════════════════════════
  // Stages one pick into the LOCAL plan. Nothing is written to MFL here —
  // the Claims screen submits the staged rounds in one POST. Rounds the owner
  // never touched are not in that payload and are left alone at MFL (§2).
  function openBidSheet(addPid, editRef) {
    // §5 — the Bid button doesn't render while writes are dark, but the player
    // sheet also calls in here, so the gate lives at the entry point too.
    if (!writeEnabled()) { openNativeWaiverPage(); return; }
    var lim = waiverLimits();
    if (!lim) {
      M.ui.showToast("Bid limits unavailable — try again in a moment.", "err");
      return;
    }
    var existing = null;
    if (editRef) {
      var g = stagedPlan().filter(function (x) { return x.round === editRef.round; })[0];
      existing = g && g.picks[editRef.index];
    }
    bidView = {
      addPid: String(addPid),
      amount: existing ? U.safeInt(existing.bid_dollars, lim.min) : lim.min,
      round: editRef ? editRef.round : 1,
      dropPid: existing && existing.drop_pid ? String(existing.drop_pid) : "",
      editRef: editRef || null
    };
    renderBidSheet();
  }

  function closeBidSheet() {
    bidView = null;
    var ov = document.getElementById("ups-m-bid-overlay");
    if (ov) ov.remove();
    if (!document.getElementById("ups-m-claims-overlay")) document.body.style.overflow = "";
  }

  function bidSheetHtml() {
    var lim = waiverLimits();
    if (!lim || !bidView) return "";
    var info = waiverModeInfo();
    var fid = M.state.viewerFranchiseId;
    var cap = fid ? DATA.computeCap(fid) : null;

    // Cap room is ADVISORY ONLY. MFL enforces the real $300K cap at award
    // time; we never block a bid on our own arithmetic.
    var advisory = "";
    if (cap && cap.capAmount) {
      var roomAfterDrop = cap.capRoom + (bidView.dropPid ? Math.max(0, dropSalary(bidView.dropPid)) - dropPenalty(bidView.dropPid) : 0);
      var over = bidView.amount > roomAfterDrop;
      advisory = '<div class="ups-m-bid-advisory' + (over ? " warn" : "") + '">' +
        'Cap room ' + (bidView.dropPid ? "after that drop" : "today") + ': <strong>' + U.fmtUsd(roomAfterDrop) + '</strong>' +
        (over ? ' — this bid is above it. MFL enforces the cap when the claim is awarded.' : '') +
      '</div>';
    }
    // Roster headroom is advisory too (§6). No ceiling is quoted: the active
    // limit is 30 after the September contract deadline and 35 before it, and
    // IR/taxi players never occupy an active spot — any number we printed
    // would be wrong some of the time. MFL owns the limit.
    if (cap && cap.rosterCount > 0 && cap.activeCount != null) {
      advisory += '<div class="ups-m-bid-advisory">Active roster: ' + cap.activeCount +
        ((cap.irCount || cap.taxiCount)
          ? ' (' + (cap.irCount || 0) + ' IR · ' + (cap.taxiCount || 0) + ' taxi, not counted)'
          : '') +
        '. MFL enforces the roster limit when a claim is awarded.</div>';
    }

    var groupChips = "";
    var plan = stagedPlan();
    for (var rd = 1; rd <= lim.maxRounds; rd++) {
      var cnt = (plan.filter(function (g) { return g.round === rd; })[0] || { picks: [] }).picks.length;
      groupChips += '<button class="ups-m-bid-round' + (bidView.round === rd ? " on" : "") +
        '" data-round="' + rd + '">' + rd + (cnt ? '<span class="n">' + cnt + '</span>' : '') + '</button>';
    }

    var dropLabel = bidView.dropPid
      ? (nameForPid(bidView.dropPid) + " · " + U.fmtUsd(dropPenalty(bidView.dropPid)) + " penalty")
      : "No conditional drop";

    return '<div class="ups-m-bid-overlay" id="ups-m-bid-overlay">' +
      '<div class="ups-m-bid-sheet">' +
        '<div class="ups-m-bid-head">' +
          '<button class="ups-m-bid-close" id="ups-m-bid-close" aria-label="Close">×</button>' +
          '<div class="title">Bid on ' + U.escapeHtml(nameForPid(bidView.addPid)) + '</div>' +
          '<div class="sub">' + U.escapeHtml(posTeamForPid(bidView.addPid)) +
            (info.detail ? ' · ' + U.escapeHtml(info.detail) : '') + '</div>' +
        '</div>' +
        '<div class="ups-m-bid-body">' +
          '<div class="ups-m-bid-label">Bid amount</div>' +
          '<div class="ups-m-bid-stepper">' +
            '<button class="step" data-act="bid-minus" aria-label="Lower bid">−</button>' +
            '<div class="amt" id="ups-m-bid-amt">' + U.fmtUsd(bidView.amount) + '</div>' +
            '<button class="step" data-act="bid-plus" aria-label="Raise bid">+</button>' +
          '</div>' +
          '<div class="ups-m-bid-hint">Minimum ' + U.fmtUsd(lim.min) + ', in ' + U.fmtUsd(lim.step) + ' steps. ' +
            'A winning bid becomes this season’s salary on a 1-year WW contract.</div>' +
          advisory +
          '<div class="ups-m-bid-label">Priority group</div>' +
          '<div class="ups-m-bid-rounds">' + groupChips + '</div>' +
          '<div class="ups-m-bid-hint">Group 1 is processed first. Within a group, your claims run in the order you set on the Claims screen.</div>' +
          // Shown unless MFL explicitly reported conditional bidding OFF.
          // `conditional` is now a tri-state — true / false / null ("MFL did not
          // say") — and null must not collapse to "off": the drop rider is part
          // of MFL's blindBidWaiverRequest on every claim (the worker accepts
          // drop_pid unconditionally and MFL enforces at award time), so hiding
          // it on an unread setting would remove a capability the league uses.
          (lim.conditional || !lim.conditionalKnown
            ? '<div class="ups-m-bid-label">Conditional drop</div>' +
              '<button class="ups-m-bid-droppick" data-act="pick-drop">' + U.escapeHtml(dropLabel) + '</button>' +
              '<div class="ups-m-bid-hint">Only dropped if this claim is awarded.</div>'
            : '') +
        '</div>' +
        '<div class="ups-m-bid-foot">' +
          '<button class="ups-m-bid-btn ghost" data-act="bid-cancel">Cancel</button>' +
          '<button class="ups-m-bid-btn primary" data-act="bid-confirm">' +
            (bidView.editRef ? "Save claim" : "Add to claims") + '</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function dropSalary(pid) {
    var fid = M.state.viewerFranchiseId;
    if (!fid || !pid) return 0;
    var row = DATA.getRosterFor(fid).filter(function (r) { return String(r.id) === String(pid); })[0];
    return row ? (Number(row.salary) || 0) : 0;
  }
  function dropPenalty(pid) {
    var fid = M.state.viewerFranchiseId;
    if (!fid || !pid) return 0;
    var row = DATA.getRosterFor(fid).filter(function (r) { return String(r.id) === String(pid); })[0];
    if (!row) return 0;
    var p = DATA.dropPenaltyFor(row, M.state.ctx.year);
    return (p && typeof p.amount === "number") ? p.amount : 0;
  }

  function renderBidSheet() {
    var existing = document.getElementById("ups-m-bid-overlay");
    if (existing) existing.remove();
    var mount = document.getElementById("ups-m-app");
    if (!mount || !bidView) return;
    mount.insertAdjacentHTML("beforeend", bidSheetHtml());
    document.body.style.overflow = "hidden";
    var overlay = document.getElementById("ups-m-bid-overlay");
    if (!overlay) return;
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) closeBidSheet();
    });
    var closeBtn = document.getElementById("ups-m-bid-close");
    if (closeBtn) closeBtn.addEventListener("click", closeBidSheet);
    overlay.addEventListener("click", onBidSheetClick);
  }

  function onBidSheetClick(e) {
    var t = e.target && e.target.closest ? e.target.closest("[data-act],[data-round]") : null;
    if (!t || !bidView) return;
    var lim = waiverLimits();
    if (!lim) return;
    var rd = t.getAttribute("data-round");
    if (rd) {
      bidView.round = U.safeInt(rd, 1);
      renderBidSheet();
      return;
    }
    var act = t.getAttribute("data-act");
    if (act === "bid-minus") {
      bidView.amount = Math.max(lim.min, bidView.amount - lim.step);
      renderBidSheet();
    } else if (act === "bid-plus") {
      bidView.amount = bidView.amount + lim.step;
      renderBidSheet();
    } else if (act === "pick-drop") {
      var keep = { addPid: bidView.addPid, amount: bidView.amount, round: bidView.round,
                   dropPid: bidView.dropPid, editRef: bidView.editRef };
      openDropPicker({
        title: "Conditional drop",
        sub: 'Dropped only if the claim on <strong>' + U.escapeHtml(nameForPid(bidView.addPid)) + '</strong> wins.',
        allowNone: true,
        noneSub: "Claim is only awarded if you already have room.",
        selectedPid: bidView.dropPid,
        addPid: bidView.addPid,
        onPick: function (pid) {
          bidView = keep;
          bidView.dropPid = pid || "";
          renderBidSheet();
        }
      });
    } else if (act === "bid-cancel") {
      closeBidSheet();
    } else if (act === "bid-confirm") {
      confirmBid();
    }
  }

  function confirmBid() {
    var lim = waiverLimits();
    if (!lim || !bidView) return;
    // Snap to a legal amount: at/above minimum and on an increment boundary.
    var amt = Math.max(lim.min, bidView.amount);
    amt = lim.min + Math.round((amt - lim.min) / lim.step) * lim.step;

    var plan = clonePlan();
    // Editing: pull the old pick out first so the round move is a real move.
    if (bidView.editRef) {
      plan.forEach(function (g) {
        if (g.round === bidView.editRef.round) g.picks.splice(bidView.editRef.index, 1);
      });
    }
    var group = plan.filter(function (g) { return g.round === bidView.round; })[0];
    if (!group) { group = { round: bidView.round, picks: [] }; plan.push(group); }
    // One claim per player per group — the same player across DIFFERENT
    // groups is fine and intentional (that's how you ladder a bid).
    var dupe = group.picks.filter(function (p) { return String(p.add_pid) === String(bidView.addPid); })[0];
    if (dupe) {
      M.ui.showToast(nameForPid(bidView.addPid) + " is already claimed in group " + bidView.round + ".", "err");
      return;
    }
    group.picks.push({
      add_pid: String(bidView.addPid),
      bid_dollars: amt,
      drop_pid: bidView.dropPid ? String(bidView.dropPid) : null
    });
    commitPlan(plan);
    var wasEdit = !!bidView.editRef;
    closeBidSheet();
    M.ui.showToast(wasEdit ? "Claim updated — not submitted yet." : "Staged in group " + group.round + " — not submitted yet.", "ok");
    if (document.getElementById("ups-m-claims-overlay")) renderClaimsScreen();
    else renderRoute();
  }

  function clonePlan() {
    try { return JSON.parse(JSON.stringify(stagedPlan())); } catch (e) { return []; }
  }
  function commitPlan(plan) {
    plan.sort(function (a, b) { return U.safeInt(a.round, 0) - U.safeInt(b.round, 0); });
    // CONTRACT v2 §2 — a round the owner just emptied has to STAY in the plan
    // carrying an explicit clear. Drop it and the round is simply absent from
    // the payload, which now means "leave it alone" — i.e. the claim they just
    // deleted would still be live at MFL, still spending cap, while the Claims
    // screen cheerfully read "No claims staged".
    plan.forEach(function (g) {
      if (!g.picks || !g.picks.length) { g.picks = []; g.clear = true; }
      else { g.clear = false; }
    });
    if (M.waivers && M.waivers.setPlan) M.waivers.setPlan(plan);
  }

  // ══ Claims screen ══════════════════════════════════════════════════════
  // Full-screen overlay. Groups 1..N, each an ORDERED list of picks (MFL
  // honours order inside a round). Reorder with ▲/▼ buttons — drag on mobile
  // is unreliable inside a scrolling overlay, so it's deliberately not used.
  var claimsBusy = false;
  // A sticky banner rather than a toast: when the server couldn't read our
  // claims (`known:false`) the owner has to keep seeing that what's on screen
  // is their LOCAL draft, not MFL's truth — a toast that fades away is not
  // good enough for that. { tone:"warn"|"ok", text }.
  var claimsNotice = null;
  // Dry-run result: `would_write` from the server, rendered as a preview.
  // Never adopted into the plan (contract v2 §3).
  var claimsPreview = null;

  function claimsScreenHtml() {
    var lim = waiverLimits();
    var plan = stagedPlan();
    var dirty = planIsDirty();
    var total = stagedCount();
    var clears = clearCount();
    var info = waiverModeInfo();
    var pend = pendingInfo();

    var body = "";
    if (!plan.length) {
      // Honest empty state. "No claims staged" is only safe to say alongside
      // what we actually know about MFL's side — when the pending read failed,
      // an empty local plan proves nothing about what MFL is holding.
      var emptySub = pend.known
        ? 'Find a player in the Market and tap <strong>Bid</strong>. ' +
          'Claims stay here until you submit them.'
        : 'Find a player in the Market and tap <strong>Bid</strong>. ' +
          'We haven’t been able to read your live claims from MFL, so this ' +
          'screen shows your local draft only — check MFL if you think a claim is out there.';
      body = '<div class="ups-m-claims-empty">' +
        '<div class="t">No claims staged.</div>' +
        '<div class="s">' + emptySub + '</div>' +
      '</div>';
    } else {
      body = plan.map(function (g) {
        // A cleared round: no picks, an explicit "withdraw everything in this
        // group" that gets sent as picks:[]. Rendered as its own row so the
        // destructive thing on the screen is the thing the owner asked for.
        if (!g.picks || !g.picks.length) {
          return '<section class="ups-m-claim-group cleared">' +
            '<h3>Group ' + g.round + '<span class="n">withdrawing</span></h3>' +
            '<div class="ups-m-claim-clearrow">' +
              '<div class="body">' +
                '<div class="name">Clear every claim in group ' + g.round + '</div>' +
                '<div class="sub">Submits this group empty — MFL drops whatever it is holding for it.</div>' +
              '</div>' +
              '<button class="lnk" data-act="claim-unclear" data-round="' + g.round + '">Undo</button>' +
            '</div>' +
          '</section>';
        }
        var picks = (g.picks || []).map(function (p, i) {
          var moveOpts = "";
          if (lim) {
            for (var rd = 1; rd <= lim.maxRounds; rd++) {
              moveOpts += '<option value="' + rd + '"' + (rd === g.round ? ' selected' : '') + '>Group ' + rd + '</option>';
            }
          }
          return '<div class="ups-m-claim-row" data-round="' + g.round + '" data-index="' + i + '">' +
            '<div class="ord">' + (i + 1) + '</div>' +
            '<div class="body">' +
              '<div class="name">' + U.escapeHtml(nameForPid(p.add_pid)) + '</div>' +
              '<div class="sub">' + U.escapeHtml(posTeamForPid(p.add_pid)) +
                ' · <strong>' + U.escapeHtml(U.fmtUsd(p.bid_dollars)) + '</strong>' +
                (p.drop_pid ? ' · drop ' + U.escapeHtml(nameForPid(p.drop_pid)) : ' · no drop') +
              '</div>' +
            '</div>' +
            '<div class="ctl">' +
              '<button class="mv" data-act="claim-up" ' + (i === 0 ? 'disabled' : '') + ' aria-label="Move up">▲</button>' +
              '<button class="mv" data-act="claim-down" ' + (i === g.picks.length - 1 ? 'disabled' : '') + ' aria-label="Move down">▼</button>' +
            '</div>' +
            '<div class="ctl2">' +
              (lim ? '<select class="ups-m-claim-move" data-act="claim-move" aria-label="Move to group">' + moveOpts + '</select>' : '') +
              '<button class="lnk" data-act="claim-edit">Edit</button>' +
              '<button class="lnk danger" data-act="claim-remove">Remove</button>' +
            '</div>' +
          '</div>';
        }).join("");
        return '<section class="ups-m-claim-group">' +
          '<h3>Group ' + g.round + '<span class="n">' + g.picks.length +
            (g.picks.length === 1 ? " claim" : " claims") + '</span>' +
            '<button class="gclear" data-act="claim-clear-group" data-round="' + g.round +
              '">Clear group</button>' +
          '</h3>' +
          picks +
        '</section>';
      }).join("");
    }

    var pendingWork = total + clears;
    var status = dirty && pendingWork
      ? '<span class="ups-m-claims-dirty">Edited — not submitted</span>'
      : (total ? '<span class="ups-m-claims-clean">Submitted &amp; verified</span>' : "");

    var notice = claimsNotice
      ? '<div class="ups-m-claims-notice ' + (claimsNotice.tone === "ok" ? "ok" : "warn") + '">' +
          U.escapeHtml(claimsNotice.text) +
          (claimsNotice.tone !== "ok" && info.nativeLink
            ? ' <a href="' + U.escapeHtml(info.nativeLink) + '" target="_blank" rel="noopener">Check on MFL</a>'
            : '') +
        '</div>'
      : "";

    // §3: a dry run wrote nothing, so it can only ever be shown as a preview
    // of what a live submit WOULD send. It never touches the plan.
    var preview = "";
    if (claimsPreview) {
      var pw = (claimsPreview.rounds || []).map(function (g) {
        return "Group " + U.safeInt(g.round, 0) + ": " + ((g.picks || []).length) +
          ((g.picks || []).length === 1 ? " claim" : " claims");
      });
      var pc = (claimsPreview.cleared_rounds || []).map(function (r) {
        return "Group " + U.safeInt(r, 0) + ": cleared";
      });
      var plines = pw.concat(pc);
      preview = '<div class="ups-m-claims-preview">' +
        '<div class="t">Dry run — what a live submit would send</div>' +
        (plines.length
          ? '<ul>' + plines.map(function (l) { return '<li>' + U.escapeHtml(l) + '</li>'; }).join("") + '</ul>'
          : '<div class="s">Nothing — no round would change.</div>') +
        '<div class="s">Groups not listed are left exactly as they are at MFL.</div>' +
      '</div>';
    }

    // "Withdraw all" is offered whenever MFL might be holding something: a
    // known pending count, our own staged claims, or a pending read we could
    // NOT complete (in which case we clear every legal round to be sure).
    var offerWithdraw = info.writeEnabled && (total > 0 || pend.count > 0 || !pend.known);
    var withdrawRow = offerWithdraw
      ? '<div class="ups-m-claims-withdraw">' +
          '<button class="lnk danger" data-act="claims-withdraw-all"' + (claimsBusy ? ' disabled' : '') + '>' +
            'Withdraw all claims' + '</button>' +
          '<div class="s">Sends every group empty, which cancels whatever MFL is holding for you.</div>' +
        '</div>'
      : "";

    // §5: while write_enabled is false NO submit CTA renders — read-only view
    // plus the link out to MFL, never a button that can only 503.
    var submitLabel = claimsBusy
      ? "Submitting…"
      : (total
          ? ("Submit " + total + (total === 1 ? " claim" : " claims") +
             (clears ? " + " + clears + (clears === 1 ? " clear" : " clears") : ""))
          : ("Submit " + clears + (clears === 1 ? " clear" : " clears")));
    var foot = '<div class="ups-m-claims-foot">' +
      '<button class="ups-m-bid-btn ghost" data-act="claims-refresh">Reload from MFL</button>' +
      (info.writeEnabled && pendingWork
        ? '<button class="ups-m-bid-btn ghost" data-act="claims-preview"' + (claimsBusy ? ' disabled' : '') + '>Preview</button>' +
          '<button class="ups-m-bid-btn primary" data-act="claims-submit"' + (claimsBusy ? ' disabled' : '') + '>' +
            U.escapeHtml(submitLabel) + '</button>'
        : (!info.writeEnabled && info.nativeLink
            ? '<a class="ups-m-bid-btn primary" href="' + U.escapeHtml(info.nativeLink) +
              '" target="_blank" rel="noopener">Add/drop on MFL</a>'
            : '')) +
    '</div>';

    return '<div class="ups-m-claims-overlay" id="ups-m-claims-overlay">' +
      '<div class="ups-m-claims-screen">' +
        '<header class="ups-m-claims-head">' +
          '<button class="ups-m-claims-back" data-act="claims-close" aria-label="Back">‹</button>' +
          '<div class="ttl"><div class="t">Waiver claims</div>' +
            '<div class="s">' + U.escapeHtml(info.detail || "") + '</div></div>' +
        '</header>' +
        '<div class="ups-m-claims-body" id="ups-m-claims-body">' +
          (status ? '<div class="ups-m-claims-status">' + status + '</div>' : '') +
          notice +
          preview +
          body +
          withdrawRow +
        '</div>' +
        foot +
      '</div>' +
    '</div>';
  }

  function renderClaimsScreen() {
    var existing = document.getElementById("ups-m-claims-overlay");
    var scrollTop = 0;
    if (existing) {
      var b = document.getElementById("ups-m-claims-body");
      scrollTop = b ? b.scrollTop : 0;
      existing.remove();
    }
    var mount = document.getElementById("ups-m-app");
    if (!mount) return;
    mount.insertAdjacentHTML("beforeend", claimsScreenHtml());
    document.body.style.overflow = "hidden";
    var overlay = document.getElementById("ups-m-claims-overlay");
    if (!overlay) return;
    overlay.addEventListener("click", onClaimsClick);
    overlay.addEventListener("change", onClaimsChange);
    var body2 = document.getElementById("ups-m-claims-body");
    if (body2 && scrollTop) body2.scrollTop = scrollTop;
  }

  function closeClaimsScreen() {
    var ov = document.getElementById("ups-m-claims-overlay");
    if (ov) ov.remove();
    if (!document.getElementById("ups-m-bid-overlay") &&
        !document.getElementById("ups-m-drop-overlay")) {
      document.body.style.overflow = "";
    }
    // Arrived via the #players/claims deep link (Home card)? Drop back to
    // plain #players first, otherwise render() would immediately re-open it.
    if (M.route.currentRoute() === "players/claims") M.route.navigate("#players");
    else renderRoute();
  }

  function claimRefFrom(el) {
    var row = el.closest ? el.closest(".ups-m-claim-row") : null;
    if (!row) return null;
    return {
      round: U.safeInt(row.getAttribute("data-round"), 0),
      index: U.safeInt(row.getAttribute("data-index"), -1)
    };
  }

  function onClaimsChange(e) {
    var sel = e.target;
    if (!sel || sel.getAttribute("data-act") !== "claim-move") return;
    var ref = claimRefFrom(sel);
    if (!ref) return;
    var toRound = U.safeInt(sel.value, 0);
    if (!toRound || toRound === ref.round) return;
    var plan = clonePlan();
    var from = plan.filter(function (g) { return g.round === ref.round; })[0];
    if (!from) return;
    var pick = from.picks.splice(ref.index, 1)[0];
    if (!pick) return;
    var to = plan.filter(function (g) { return g.round === toRound; })[0];
    if (!to) { to = { round: toRound, picks: [] }; plan.push(to); }
    var dupe = to.picks.filter(function (p) { return String(p.add_pid) === String(pick.add_pid); })[0];
    if (dupe) {
      M.ui.showToast(nameForPid(pick.add_pid) + " is already claimed in group " + toRound + ".", "err");
      renderClaimsScreen();
      return;
    }
    to.picks.push(pick);
    commitPlan(plan);
    renderClaimsScreen();
  }

  function onClaimsClick(e) {
    var t = e.target && e.target.closest ? e.target.closest("[data-act]") : null;
    if (!t) return;
    var act = t.getAttribute("data-act");
    if (act === "claims-close") { closeClaimsScreen(); return; }
    if (act === "claims-submit") { submitClaims({}); return; }
    if (act === "claims-preview") { submitClaims({ dryRun: true, skipConfirm: true }); return; }
    if (act === "claims-withdraw-all") { withdrawAllClaims(); return; }
    if (act === "claims-refresh") { reloadClaimsFromServer(); return; }
    // Explicit clears (contract v2 §2). "Clear group" stages the round with
    // picks:[]; "Undo" takes the round back out of the payload entirely, which
    // leaves whatever MFL holds for it untouched.
    if (act === "claim-clear-group" || act === "claim-unclear") {
      var roundAttr = U.safeInt(t.getAttribute("data-round"), 0);
      if (!roundAttr) return;
      var cp = clonePlan().filter(function (g) { return U.safeInt(g.round, 0) !== roundAttr; });
      if (act === "claim-clear-group") cp.push({ round: roundAttr, picks: [], clear: true });
      commitPlan(cp);
      claimsPreview = null;
      renderClaimsScreen();
      return;
    }

    var ref = claimRefFrom(t);
    if (!ref) return;
    var plan = clonePlan();
    var group = plan.filter(function (g) { return g.round === ref.round; })[0];
    if (!group) return;

    if (act === "claim-up" && ref.index > 0) {
      var a = group.picks.splice(ref.index, 1)[0];
      group.picks.splice(ref.index - 1, 0, a);
      commitPlan(plan);
      renderClaimsScreen();
    } else if (act === "claim-down" && ref.index < group.picks.length - 1) {
      var b = group.picks.splice(ref.index, 1)[0];
      group.picks.splice(ref.index + 1, 0, b);
      commitPlan(plan);
      renderClaimsScreen();
    } else if (act === "claim-remove") {
      group.picks.splice(ref.index, 1);
      commitPlan(plan);
      renderClaimsScreen();
    } else if (act === "claim-edit") {
      openBidSheet(group.picks[ref.index].add_pid, ref);
    }
  }

  // Pull the server's view of our claims. CONTRACT v2 §1: adopt ONLY when the
  // envelope says `known:true`. A failed or unparseable MFL read comes back
  // `known:false / rounds:null` and we keep the owner's local plan, with a
  // sticky banner saying so — adopting an "empty" unknown is exactly the bug
  // that used to wipe live, cap-spending claims off this screen.
  // "We couldn't read MFL" banner text, with the worker's own explanation
  // appended when it sent one.
  //
  // FIELD NAMES, grep-verified against /api/waivers/pending: the explanation is
  // emitted as `normalize_warning` (canonical) AND `warning` (retained alias,
  // always the identical string); `unknown_reason` is the machine-readable code
  // and `mfl_status` / `mfl_response` carry the upstream detail when the export
  // itself never answered. `message` is NOT part of this envelope — reading it
  // (and nothing else) is why the explanation was empty on every single unknown
  // read, leaving the owner with generic text and no idea what had gone wrong.
  function unknownClaimsText(resp) {
    var why = U.safeStr(resp && (resp.normalize_warning || resp.warning));
    if (!why) {
      var mr = U.safeStr(resp && resp.mfl_response).replace(/<\/?error>/gi, "");
      if (mr) why = mr;
      else if (resp && U.safeInt(resp.mfl_status, 0)) {
        why = "MFL answered HTTP " + U.safeInt(resp.mfl_status, 0) + ".";
      }
      // Last resort: `message` only exists on the ERROR envelopes (the 401
      // MISSING_VIEWER_COOKIE body), which is how this function can be reached
      // from the .catch path with err.body.
      else if (resp && resp.message) why = U.safeStr(resp.message);
    }
    return "Couldn't read your claims from MFL — showing your local draft." +
      (why ? " (" + why + ")" : "");
  }

  function reloadClaimsFromServer() {
    if (!M.waivers || !M.waivers.fetchPending) return;
    M.waivers.fetchPending().then(function (resp) {
      claimsPreview = null;
      if (M.waivers.adoptVerified(resp)) {
        var n = stagedCount();
        claimsNotice = { tone: "ok", text: n
          ? ("Loaded " + n + (n === 1 ? " claim" : " claims") + " from MFL.")
          : "MFL is holding no claims for you." };
      } else {
        claimsNotice = { tone: "warn", text: unknownClaimsText(resp) };
      }
      renderClaimsScreen();
    }).catch(function (err) {
      claimsNotice = { tone: "warn",
        text: "Couldn't read your claims from MFL — showing your local draft. " +
              ((err && err.message) || String(err)) };
      renderClaimsScreen();
    });
  }

  // Withdraw EVERYTHING: stage every round we have reason to think is live
  // with picks:[] and submit that. This is the explicit, user-asked-for
  // destructive operation contract v2 §2 requires — as opposed to v1, where
  // "withdraw" was inexpressible (empty groups were filtered out, the Submit
  // button hid itself at zero claims, and submitClaims early-returned) so an
  // owner's last claim could never be pulled from the app at all.
  function withdrawAllClaims() {
    if (claimsBusy) return;
    if (!writeEnabled()) { openNativeWaiverPage(); return; }
    var rounds = (M.waivers && M.waivers.withdrawAllPlan) ? M.waivers.withdrawAllPlan() : [];
    if (!rounds.length) { M.ui.showToast("Nothing to withdraw.", "ok"); return; }
    var pend = pendingInfo();
    var stagedNow = stagedCount();
    var msg = "Withdraw every waiver claim?\n\nGroup" + (rounds.length === 1 ? " " : "s ") +
      rounds.map(function (g) { return g.round; }).join(", ") +
      " will be sent to MFL empty, which cancels whatever they hold.";
    if (!pend.known) {
      msg += "\n\nWe couldn't read your live claims from MFL, so every group is cleared to be sure.";
    }
    if (stagedNow) {
      msg += "\n\nThe " + stagedNow + (stagedNow === 1 ? " claim" : " claims") +
        " staged on this screen will be discarded too.";
    }
    if (!window.confirm(msg)) return;
    commitPlan(rounds);
    claimsPreview = null;
    renderClaimsScreen();
    submitClaims({ skipConfirm: true });
  }

  // opts: { dryRun, skipConfirm }
  function submitClaims(opts) {
    opts = opts || {};
    if (claimsBusy) return;
    // §5 — belt and braces; no submit control renders while writes are dark.
    if (!writeEnabled()) { openNativeWaiverPage(); return; }
    var plan = stagedPlan();
    // An empty plan now genuinely means "change nothing" (§2), so there is
    // nothing to send. Rounds staged for an explicit clear are NOT empty —
    // they're in the plan carrying picks:[] and they submit like any other.
    if (!plan.length) return;
    var total = stagedCount();
    var clears = clearCount();
    if (!opts.dryRun && !opts.skipConfirm) {
      var lines = [];
      lines.push(total
        ? ("Submit " + total + (total === 1 ? " claim" : " claims") + " to MFL?")
        : "Withdraw your claims?");
      if (clears) {
        lines.push("", clears + (clears === 1 ? " group" : " groups") +
          " will be sent empty, cancelling whatever MFL holds for " +
          (clears === 1 ? "it" : "them") + ".");
      }
      lines.push("", "Groups you haven't touched here are left exactly as they are.");
      if (!window.confirm(lines.join("\n"))) return;
    }
    claimsBusy = true;
    renderClaimsScreen();
    M.waivers.submitPlan(plan, { dryRun: !!opts.dryRun }).then(function (resp) {
      claimsBusy = false;
      // §3 — a dry run wrote NOTHING, so `verified` is always known:false and
      // there is nothing to adopt. Show what a live run would send and leave
      // the local plan completely alone.
      if (opts.dryRun || (resp && resp.dry_run)) {
        claimsPreview = (resp && resp.would_write) || { rounds: [], cleared_rounds: [] };
        claimsNotice = { tone: "ok", text: "Preview only — nothing was sent to MFL." };
        renderClaimsScreen();
        return;
      }
      claimsPreview = null;
      // §1 — adopt the verified block ONLY when it says known:true. Otherwise
      // MFL wrote (or may have written) but we could not read it back: keep
      // the local plan and say so, rather than silently blanking the screen.
      var adopted = M.waivers.adoptVerified(resp && resp.verified);
      var warn = ((resp && resp.warnings) || []).map(function (w) {
        return U.safeStr(w && (w.message || w.code));
      }).filter(function (x) { return !!x; });
      if (adopted) {
        claimsNotice = warn.length
          ? { tone: "warn", text: warn.join(" · ") }
          : { tone: "ok", text: "Claims submitted and verified against MFL." };
      } else {
        claimsNotice = { tone: "warn",
          text: "Submitted, but we couldn't read your claims back from MFL — showing your local draft. " +
                (warn.length ? warn.join(" · ") + " " : "") + "Check MFL before the run." };
      }
      renderClaimsScreen();
      M.ui.showToast(warn.length ? warn.join(" · ") : "Claims submitted ✓", warn.length ? "err" : "ok");
    }).catch(function (err) {
      claimsBusy = false;
      // P2 — "not submitted" is a claim about MFL's state, so it may only be
      // made when nothing landed. Two ways that is false even on an error:
      //   - verify_mismatch: MFL ACCEPTED the writes; its read-back disagrees.
      //   - mfl_reject MID-SEQUENCE: rounds post one at a time, so a refusal on
      //     round 3 leaves rounds 1-2 live at MFL as real, cap-spending claims.
      //     The worker reports exactly which in rounds_written/rounds_cleared.
      // Telling an owner "not submitted" there is how they resubmit on top of
      // claims that already exist.
      var eb = (err && err.body) || {};
      var wrote = (eb.rounds_written || []).concat(eb.rounds_cleared || []);
      var partial = wrote.length > 0;
      var wasSent = eb.error === "verify_mismatch" || partial;
      var partialTxt = partial
        ? "Round" + (wrote.length > 1 ? "s " : " ") + wrote.sort(function (a, b) { return a - b; }).join(", ") +
          " already went through at MFL" +
          (eb.failed_round ? " before round " + eb.failed_round + " was refused" : "") + ". "
        : "";
      claimsNotice = { tone: "warn",
        text: (partial ? "Partly submitted. " + partialTxt
                       : (wasSent ? "Sent, but MFL's copy doesn't match what was submitted: " : "Not submitted: ")) +
              ((err && err.message) || String(err)) +
              (partial ? " Check MFL before resubmitting — the rounds above are already live."
                       : " Your staged claims are still here.") };
      renderClaimsScreen();
      showWaiverError(partial ? "Claims partly submitted"
                              : (wasSent ? "Claims sent but not verified" : "Claims not submitted"), err);
    });
  }

  // MFL's own reject text is surfaced verbatim (app.js waiverErrorMessage
  // already unwraps it); a 503 hands back native_link so the owner can still
  // do it on MFL's site.
  function showWaiverError(prefix, err) {
    var msg = (err && err.message) || String(err);
    M.ui.showToast(prefix + ": " + msg, "err");
    // The 503 envelope carries native_link; fall back to the same URL we
    // already know from /api/waivers/state so the owner is never stranded.
    var link = (err && err.nativeLink) || nativeLink();
    if (link && window.confirm(prefix + ".\n\n" + msg + "\n\nOpen MFL's own waiver page instead?")) {
      window.open(link, "_blank");
    }
  }

  // ══ FCFS one-shot add ══════════════════════════════════════════════════
  // No bid, no plan: the league default salary row already makes this a
  // 1-year WW at $1K, so we never write salary or contract fields.
  function startFcfsAdd(pid) {
    if (!M.state.viewerFranchiseId) return;
    if (!writeEnabled()) { openNativeWaiverPage(); return; }
    var fid = M.state.viewerFranchiseId;
    var cap = DATA.computeCap(fid);
    // CONTRACT v2 §6 — roster headroom is ADVISORY. "No drop" is ALWAYS
    // offered; we never hard-block an add on our own arithmetic. v1 set
    // `allowNone: !(rosterCount >= 35)`, which meant an owner physically
    // could not add without naming a cut — and the arithmetic was wrong twice
    // over: `rosterCount` is roster.length (IR and taxi players are in there,
    // and they do not occupy active spots), and 35 is only the pre-deadline
    // ceiling (it is 30 once the September contract deadline passes).
    // MFL enforces the real limit at award time and its rejection text is
    // what the owner sees — we do not predict it.
    // rosterCount 0 means the cap mirror hasn't loaded — say nothing rather
    // than advertise "Active roster: 0".
    var headroom = "";
    if (cap && cap.rosterCount > 0 && cap.activeCount != null) {
      headroom = "Active roster: " + cap.activeCount +
        ((cap.irCount || cap.taxiCount)
          ? " (" + (cap.irCount || 0) + " IR · " + (cap.taxiCount || 0) + " taxi, not counted)"
          : "") +
        ". MFL enforces the roster limit when the add lands.";
    }
    openDropPicker({
      title: "Drop a player? (optional)",
      sub: 'Adding <strong>' + U.escapeHtml(nameForPid(pid)) + '</strong> — $1K, 1-year WW.' +
        (headroom ? '<br>' + U.escapeHtml(headroom) : ''),
      allowNone: true,
      noneSub: "Add straight into an open roster spot.",
      addPid: pid,
      onPick: function (dropPid) {
        confirmFcfsAdd(pid, dropPid ? [dropPid] : []);
      }
    });
  }

  function confirmFcfsAdd(addPid, dropPids) {
    var lines = ["Add " + nameForPid(addPid) + " now?", "", "$1,000 · 1-year WW contract."];
    if (dropPids.length) {
      dropPids.forEach(function (d) {
        var pen = dropPenalty(d);
        lines.push("Drop " + nameForPid(d) + (pen > 0 ? " — " + U.fmtUsd(pen) + " cap penalty" : " — no cap penalty"));
      });
    }
    lines.push("", "This writes to MFL immediately.");
    if (!window.confirm(lines.join("\n"))) return;
    M.ui.showToast("Adding " + nameForPid(addPid) + "…", "ok");
    M.waivers.submitFcfs({ addPid: addPid, dropPids: dropPids }).then(function (resp) {
      return M.actions.reloadData().then(function () {
        // P2 — "submitted" and "confirmed" are different facts, and this route
        // now tells us which one we have. A 200 with `verified:false` means MFL
        // ACCEPTED the write and the roster read-back that confirms it failed
        // (`verified` / `verify_known` / `retry_safe:false`, grep-verified in
        // /api/waivers/fcfs; `roster_verified` is the retained alias). A failed
        // READ is never evidence the WRITE failed — so this is not an error, but
        // it is not a tick either, and it must never read as "try again": an
        // add/cut is not idempotent, and a resend cuts a second player.
        var confirmed = !!(resp && (resp.verified === true || resp.roster_verified === true));
        if (!confirmed) {
          M.ui.showToast(
            U.safeStr(resp && resp.message) ||
            "Sent to MFL, but we couldn't confirm it on your roster. Check MFL's add/drop page — don't send it again.",
            "err"
          );
          renderRoute();
          return;
        }
        var note = (resp && resp.contract_note) || "$1,000 · 1-yr WW";
        M.ui.showToast(nameForPid(addPid) + " added ✓ — " + note, "ok");
        renderRoute();
      });
    }).catch(function (err) {
      // "Failed" is only honest when nothing landed — i.e. MFL itself rejected
      // the import (`mfl_reject`, retry_safe:true). On a `verify_mismatch` MFL
      // took the request and part of it may have applied, so the prefix must not
      // read as "nothing happened, do it again".
      var eb = (err && err.body) || {};
      showWaiverError(eb.error === "verify_mismatch" ? "Add not confirmed" : "Add failed", err);
    });
  }

  // ══ Public surface for the other mobile views ══════════════════════════
  // player_sheet.js (unrostered players) and views/home.js both drive the
  // waiver UI through this rather than duplicating window logic.
  M.waiverUI = {
    cta: acquisitionCta,
    modeInfo: waiverModeInfo,
    // §5 — surfaces ask this before drawing any write control of their own.
    writeEnabled: writeEnabled,
    nativeLink: nativeLink,
    openBid: function (pid) { openBidSheet(pid, null); },
    startFcfs: startFcfsAdd,
    openClaims: openClaimsScreen,
    stagedRoundsFor: stagedRoundsFor,
    stagedCount: stagedCount,
    clearCount: clearCount,
    isDirty: planIsDirty
  };

  function openClaimsScreen() {
    claimsNotice = null;
    claimsPreview = null;
    renderClaimsScreen();
    // Nothing staged locally? Seed from the server so an owner who bid on
    // desktop (or last week) sees their real claims, not an empty screen.
    // §1 again: only a `known:true` envelope may seed anything. A failed read
    // leaves the screen as-is and says the count is unknown, because "we
    // couldn't ask" must never be drawn as "you have none".
    if (!stagedCount() && !clearCount() && M.waivers && M.waivers.fetchPending) {
      M.waivers.fetchPending().then(function (resp) {
        if (!M.waivers.adoptVerified(resp)) {
          claimsNotice = { tone: "warn", text: unknownClaimsText(resp) };
        }
        if (document.getElementById("ups-m-claims-overlay")) renderClaimsScreen();
      }).catch(function (err) {
        // Signed-out is a normal cold-start case; anything else still has to
        // be visible rather than reading as an empty slate.
        if (!(err && err.ownerAuthExpired)) {
          claimsNotice = { tone: "warn", text: unknownClaimsText(err && err.body) };
          if (document.getElementById("ups-m-claims-overlay")) renderClaimsScreen();
        }
      });
    }
  }

  function bind(mount) {
    var search = document.getElementById("ups-m-players-search");
    if (search) {
      search.addEventListener("input", function (e) {
        var val = e.target.value;
        clearTimeout(view.debounceTimer);
        view.debounceTimer = setTimeout(function () {
          view.query = val;
          renderRoute();
          // Re-focus the input after re-render (DOM was replaced).
          var s = document.getElementById("ups-m-players-search");
          if (s) {
            s.focus();
            try { s.setSelectionRange(val.length, val.length); } catch (e) {}
          }
        }, 250);
      });
    }
    var chips = mount.querySelectorAll(".ups-m-pos-chip");
    for (var i = 0; i < chips.length; i++) {
      chips[i].addEventListener("click", function () {
        view.pos = this.getAttribute("data-pos");
        renderRoute();
      });
    }
    var sortBtns = mount.querySelectorAll(".ups-m-sort-btn");
    for (var j = 0; j < sortBtns.length; j++) {
      sortBtns[j].addEventListener("click", function () {
        view.sort = this.getAttribute("data-sort");
        renderRoute();
      });
    }
    var filterSel = document.getElementById("ups-m-players-filter");
    if (filterSel) {
      filterSel.addEventListener("change", function () {
        var v = this.value;
        if (v === "fa") { view.scope = "fa"; view.teamFilter = ""; }
        else if (v === "all") { view.scope = "all"; view.teamFilter = ""; }
        else if (v.indexOf("team:") === 0) { view.teamFilter = v.slice(5); view.scope = "all"; }
        renderRoute();
      });
    }
    var tradeBtns = mount.querySelectorAll(".ups-m-fa-trade");
    for (var t = 0; t < tradeBtns.length; t++) {
      tradeBtns[t].addEventListener("click", function (e) {
        e.stopPropagation();
        var tfid = this.getAttribute("data-fid");
        var tpid = this.getAttribute("data-pid");
        if (M.tradeView && M.tradeView.openBuilder) M.tradeView.openBuilder({ toFid: tfid, preGetPid: tpid });
        else M.route.navigate("#league/trade");
      });
    }
    // Waiver controls: Bid / Add on a row, and the Claims chip in the strip.
    var waiverBtns = mount.querySelectorAll('[data-act="waiver-bid"],[data-act="waiver-add"],[data-act="open-claims"]');
    for (var wI = 0; wI < waiverBtns.length; wI++) {
      waiverBtns[wI].addEventListener("click", function (e) {
        e.stopPropagation();
        var act = this.getAttribute("data-act");
        var wpid = this.getAttribute("data-pid");
        if (act === "waiver-bid") openBidSheet(wpid, null);
        else if (act === "waiver-add") startFcfsAdd(wpid);
        else openClaimsScreen();
      });
    }
    var rows = mount.querySelectorAll(".ups-m-fa-row");
    for (var k = 0; k < rows.length; k++) {
      rows[k].addEventListener("click", function () {
        var pid = this.getAttribute("data-pid");
        if (pid && M.sheet) M.sheet.open(pid);
      });
    }
  }

  function renderRoute() { M.route.renderRoute(); }

  function render(mount, parts) {
    var all = buildFreeAgents();
    var filtered = filterAndSort(all);
    mount.innerHTML = renderToolbar() + renderRows(filtered);
    bind(mount);
    // #players/claims — deep link from the Home waiver card.
    if (parts && parts[0] === "claims" && !document.getElementById("ups-m-claims-overlay")) {
      openClaimsScreen();
    }
  }

  M.route.registerView("players", render);
})();
