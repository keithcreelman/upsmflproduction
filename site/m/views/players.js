/* Players tab — Free-agent browser + add/drop intent.
   Free agents = anyone in players export NOT on any roster (exempts taxi/IR
   since those ARE on rosters). Rows show Name / POS / NFL team / YTD Pts /
   PPG. Tap row opens player sheet; tap Add opens "drop which player?"
   bottom sheet with cap-impact preview.

   Add/drop submit deep-links to MFL's native /add_drop form (parity with
   desktop, which does the same — no UPS worker route exists for adds and
   the canonical claim is MFL's BB Waiver / FCFS UI). Form params:
     /{year}/add_drop?L={lid}&PLAYER_ID={addPid}&CUT_PLAYER={dropPid}
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
    sort: "ppg",    // "ppg" | "pts"
    debounceTimer: null,
    dropSheetFor: null   // pid of player being added (drop-sheet open)
  };

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
    var fidByPid = (view.scope === "all") ? rosteredFidByPid() : null;
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
      if (view.scope !== "all" && isRostered) continue;
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

  function renderToolbar() {
    var chips = POSITIONS.map(function (p) {
      var label = p === "ALL" ? "All" : p;
      return '<button class="ups-m-pos-chip' + (view.pos === p ? " on" : "") +
        '" data-pos="' + U.escapeHtml(p) + '">' + U.escapeHtml(label) + '</button>';
    }).join("");
    var scopeToggle = '<div class="ups-m-seg-toggle">' +
      '<button class="ups-m-seg-btn' + (view.scope !== "all" ? " on" : "") + '" data-scope="fa">Free Agents</button>' +
      '<button class="ups-m-seg-btn' + (view.scope === "all" ? " on" : "") + '" data-scope="all">All Players</button>' +
    '</div>';
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
    '</div>';
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
      var ownerTag = "", actionBtn = "";
      if (r.rosteredFid) {
        if (r.rosteredFid === myFid) {
          ownerTag = '<span class="owned you">Your team</span>';
        } else {
          ownerTag = '<span class="owned">' + U.escapeHtml(franchiseName(r.rosteredFid)) + '</span>';
          actionBtn = '<button class="ups-m-fa-trade" data-act="propose-trade" data-fid="' + U.escapeHtml(r.rosteredFid) + '" data-pid="' + U.escapeHtml(r.id) + '">Propose trade</button>';
        }
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
      // Add button removed per Keith 2026-05-15 — FA acquisition stays on
      // desktop for now. The drop sheet flow (handleAddDropConfirm) is
      // still wired for future use; just no UI entry from mobile yet.
    });
    if (rows.length > capped.length) {
      html += '<div class="ups-m-fa-more">Showing top ' + capped.length + ' of ' + rows.length + ' — refine your search to see more.</div>';
    }
    html += '</div>';
    return html;
  }

  // Drop sheet — full-roster list with dead-cap preview per row, sorted
  // by lowest penalty first.
  function renderDropSheet(addPid) {
    var fid = M.state.viewerFranchiseId;
    if (!fid) return "";
    var addPlayer = DATA.playerById(addPid);
    var addName = nameFor(addPlayer) || ("Player " + addPid);
    var cap = DATA.computeCap(fid);
    var rosterRows = DATA.getRosterFor(fid).map(function (r) {
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
        penaltyNote: penalty && penalty.note || ""
      };
    }).sort(function (a, b) { return a.penaltyAmt - b.penaltyAmt; });

    var rows = rosterRows.map(function (r) {
      // What cap room would look like AFTER drop + add. For the add side we
      // don't know the new player's contract terms yet (FA auction salary
      // TBD), so the "after" reflects only the drop side: capRoom + (player
      // salary recovered) − (penalty applied).
      var roomAfter = cap.capRoom + Math.max(0, r.salary) - r.penaltyAmt;
      var pLabel = r.penaltyAmt > 0
        ? '<span class="penalty">' + U.fmtUsd(r.penaltyAmt) + ' penalty</span>'
        : '<span class="penalty ok">no penalty</span>';
      return '<button class="ups-m-drop-row" data-drop-pid="' + U.escapeHtml(r.id) + '">' +
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

    return '<div class="ups-m-drop-overlay" id="ups-m-drop-overlay">' +
      '<div class="ups-m-drop-sheet">' +
        '<div class="ups-m-drop-head">' +
          '<button class="ups-m-drop-close" id="ups-m-drop-close" aria-label="Close">×</button>' +
          '<div class="grip"></div>' +
          '<div class="title">Drop which player?</div>' +
          '<div class="sub">Adding <strong>' + U.escapeHtml(addName) + '</strong>. Tap a player to drop.</div>' +
        '</div>' +
        '<div class="ups-m-drop-body">' + rows + '</div>' +
      '</div>' +
    '</div>';
  }

  function closeDropSheet() {
    view.dropSheetFor = null;
    var ov = document.getElementById("ups-m-drop-overlay");
    if (ov) ov.remove();
    document.body.style.overflow = "";
  }

  function openDropSheet(addPid) {
    closeDropSheet();
    view.dropSheetFor = addPid;
    var html = renderDropSheet(addPid);
    var mount = document.getElementById("ups-m-app");
    if (!mount) return;
    mount.insertAdjacentHTML("beforeend", html);
    document.body.style.overflow = "hidden";
    var overlay = document.getElementById("ups-m-drop-overlay");
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) closeDropSheet();
    });
    document.getElementById("ups-m-drop-close").addEventListener("click", closeDropSheet);
    var rows = overlay.querySelectorAll(".ups-m-drop-row");
    for (var i = 0; i < rows.length; i++) {
      rows[i].addEventListener("click", function () {
        var dropPid = this.getAttribute("data-drop-pid");
        handleAddDropConfirm(addPid, dropPid);
      });
    }
  }

  function handleAddDropConfirm(addPid, dropPid) {
    var addPlayer = DATA.playerById(addPid);
    var dropPlayer = DATA.playerById(dropPid);
    var rosterRow = DATA.getRosterFor(M.state.viewerFranchiseId)
      .filter(function (r) { return r.id === dropPid; })[0];
    var penalty = rosterRow ? DATA.dropPenaltyFor(rosterRow, M.state.ctx.year) : null;
    var penaltyLine = penalty
      ? (penalty.amount > 0 ? "\n\nDead-cap penalty: " + U.fmtUsd(penalty.amount) : "\n\nNo dead-cap penalty.")
      : "\n\nCap penalty: unknown.";
    var msg = "Add " + (nameFor(addPlayer) || addPid) + "?\n" +
              "Drop " + (nameFor(dropPlayer) || dropPid) + "." +
              penaltyLine + "\n\n" +
              "We can't submit add/drop directly yet — opens MFL's native form pre-filled.";
    if (!window.confirm(msg)) return;
    // Deep-link to MFL's native add/drop form pre-filled. Parity with
    // desktop (team_operations.js:1562) which also links to MFL native.
    var url = "https://www48.myfantasyleague.com/" + encodeURIComponent(M.state.ctx.year) +
              "/add_drop?L=" + encodeURIComponent(M.state.ctx.leagueId) +
              "&PLAYER_ID=" + encodeURIComponent(addPid) +
              "&CUT_PLAYER=" + encodeURIComponent(dropPid);
    closeDropSheet();
    window.open(url, "_blank");
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
    var scopeBtns = mount.querySelectorAll(".ups-m-seg-btn");
    for (var sc = 0; sc < scopeBtns.length; sc++) {
      scopeBtns[sc].addEventListener("click", function () {
        view.scope = this.getAttribute("data-scope");
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
    var rows = mount.querySelectorAll(".ups-m-fa-row");
    for (var k = 0; k < rows.length; k++) {
      rows[k].addEventListener("click", function () {
        var pid = this.getAttribute("data-pid");
        if (pid && M.sheet) M.sheet.open(pid);
      });
    }
  }

  function renderRoute() { M.route.renderRoute(); }

  function render(mount) {
    var all = buildFreeAgents();
    var filtered = filterAndSort(all);
    mount.innerHTML = renderToolbar() + renderRows(filtered);
    bind(mount);
  }

  M.route.registerView("players", render);
})();
