/* My Team → Contracts view.
   Cap card mirrors team_operations.js:670-708 numbers exactly. */
(function () {
  "use strict";
  if (!window.UPS_MOBILE) return;
  var M = window.UPS_MOBILE;
  var U = M.util;
  var DATA = M.data;

  var POS_ORDER = ["QB", "RB", "WR", "TE", "PK", "PN", "DL", "LB", "DB", "DEF", "TMQB", "TMRB", "TMWR", "TMTE", "TMPK"];

  function posClass(pos) {
    var p = (pos || "").toUpperCase();
    if (p === "QB") return "qb";
    if (p === "RB") return "rb";
    if (p === "WR") return "wr";
    if (p === "TE") return "te";
    if (p === "PK") return "pk";
    if (p === "DEF" || p === "DEFENSE") return "def";
    if (p === "DL" || p === "DE" || p === "DT") return "dl";
    if (p === "LB" || p === "ILB" || p === "OLB") return "lb";
    if (p === "DB" || p === "CB" || p === "S" || p === "SAF") return "db";
    return "";
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

  function statusBadges(rosterRow, otbIds, fid) {
    // Contract-type badge (e.g. BL, Rookie) is already rendered as a
    // typed chip in the chips row, so we intentionally skip it here to
    // avoid the duplicate Keith called out (BL/BL, Rookie/Rookie).
    var out = [];
    // safeInt guards against null/undefined contractYear so the strict
    // === 0 / === 1 comparisons can't silently fail on NaN.
    var cy = U.safeInt(rosterRow.contractYear, -1);
    var status = U.safeStr(rosterRow.status);
    if (cy === 0) out.push('<span class="badge exp">Expired</span>');
    // Taxi badge with call-up counter (canon §B2 + tracker Q10).
    // Renders "Taxi · N/3" when N > 0; plain "Taxi" otherwise.
    var callup = DATA.taxiCallupsFor && DATA.taxiCallupsFor(rosterRow.id);
    var isTaxiNow = /taxi/i.test(status);
    // Taxi-eligibility (Keith 2026-05-18): show the call-up budget chip
    // on active-roster rookies who are still in the 3-year window so
    // owners can see how many call-ups remain. Match canon §A1 / §B2:
    // drafted R2-5, season - draft_year < 3.
    var taxiEligibleNow = false;
    if (!isTaxiNow && DATA.isTaxiEligibleFor) {
      taxiEligibleNow = !!DATA.isTaxiEligibleFor(rosterRow.id);
    }
    if (isTaxiNow || taxiEligibleNow) {
      var used = callup ? U.safeInt(callup.used, 0) : 0;
      var pending = callup ? U.safeInt(callup.pending, 0) : 0;
      var max = callup ? U.safeInt(callup.max, 3) || 3 : 3;
      if (isTaxiNow) {
        // Canon §B2 — always show the counter on taxi players (Keith
        // 2026-05-18) so the remaining budget is visible at a glance.
        var label = "Taxi · " + used + "/" + max;
        if (pending > 0) label += " + " + pending + " pending";
        out.push('<span class="badge tx">' + label + '</span>');
      } else if (taxiEligibleNow) {
        var eligLabel = "Taxi-Elig · " + used + "/" + max;
        if (pending > 0) eligLabel += " + " + pending + " pending";
        out.push('<span class="badge tx">' + eligLabel + '</span>');
      }
    }
    if (/ir|injured/i.test(status)) out.push('<span class="badge ir">IR</span>');
    if (otbIds && otbIds.has(String(rosterRow.id))) out.push('<span class="badge otb">On Block</span>');
    // "Ext Eligible" requires more than cy===1 — desktop's rosterContractEligibility
    // gates on tag status + "no further extensions" + rookie-option state, and
    // RULE-EXT-003 blocks the SAME UPS franchise from extending twice. Without
    // this gate, tagged players (Trevor Lawrence on LH) and already-extended-by-
    // current-owner players show false-positive eligibility badges.
    var FOA = window.UPS_FRONT_OFFICE_ACTIONS;
    if (FOA && FOA.extensionAvailableFor) {
      if (FOA.extensionAvailableFor(rosterRow, fid).ok) {
        out.push('<span class="badge ext">Ext Eligible</span>');
      }
    } else if (cy === 1) {
      // Fallback only if the actions mirror failed to load — shouldn't happen.
      out.push('<span class="badge ext">Ext Eligible</span>');
    }
    return out.join(" ");
  }

  function renderCapCard(cap) {
    var pct = cap.pct;
    var overCap = cap.capRoom < 0;
    var capRoomClass = overCap ? "danger" : (pct >= 95 ? "warn" : "ok");
    var adjLine = "";
    if (cap.adjustmentTotal !== 0) {
      var sign = cap.adjustmentTotal > 0 ? "+" : "−";
      adjLine = '<span class="chip">Adj ' + sign + U.fmtUsd(Math.abs(cap.adjustmentTotal)) + '</span>';
    }
    return '' +
      '<div class="ups-m-cap-card">' +
        '<div class="ups-m-cap-grid">' +
          '<div class="ups-m-cap-kv">' +
            '<div class="lbl">Cap Used</div>' +
            '<div class="val">' + U.fmtUsd(cap.capTotal) + '</div>' +
          '</div>' +
          '<div class="ups-m-cap-kv">' +
            '<div class="lbl">Cap Room</div>' +
            '<div class="val ' + capRoomClass + '">' + U.fmtUsd(cap.capRoom) + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="ups-m-cap-bar"><div class="ups-m-cap-bar-fill ' + (overCap ? "over" : "") + '" style="width:' + pct + '%"></div></div>' +
        '<div class="ups-m-cap-foot">' +
          '<span class="chip">' + pct + '% used</span>' +
          '<span class="chip">Cap ' + U.fmtUsd(cap.capAmount) + '</span>' +
          '<span class="chip">' + cap.rosterCount + ' roster · ' + cap.activeCount + ' active</span>' +
          (cap.irCount ? '<span class="chip">' + cap.irCount + ' IR · ' + U.fmtUsd(cap.irSalaryFull) + ' @50%</span>' : '') +
          (cap.taxiCount ? '<span class="chip">' + cap.taxiCount + ' Taxi · ' + U.fmtUsd(cap.taxiSalary) + ' off-cap</span>' : '') +
          adjLine +
        '</div>' +
      '</div>';
  }

  function renderRoster(rosterRows, fid) {
    if (!rosterRows.length) return '<div class="ups-m-stub"><div>No roster found.</div></div>';
    var otbIds = DATA.getMyTradeBaitIds();
    // Group by position using MFL players export
    var byPos = {};
    rosterRows.forEach(function (r) {
      var player = DATA.playerById(r.id);
      var pos = U.safeStr(player && player.position).toUpperCase() || "Other";
      if (!byPos[pos]) byPos[pos] = [];
      byPos[pos].push({ row: r, player: player });
    });

    // Order positions per POS_ORDER, then any remaining alphabetically.
    var seen = {};
    var ordered = [];
    POS_ORDER.forEach(function (p) {
      if (byPos[p]) { ordered.push(p); seen[p] = true; }
    });
    Object.keys(byPos).sort().forEach(function (p) {
      if (!seen[p]) ordered.push(p);
    });

    // Parse contractInfo for CL / TCV. Delegates to the shared
    // cap-math module (issue #244 Phase 2B). Falls back to a 0/0
    // shape if the module hasn't loaded.
    function parseCT(infoStr) {
      var cm = (typeof window !== "undefined" && window.UPS_CAP_MATH) || null;
      if (cm) {
        var info = cm.parseContractInfo(infoStr);
        return { cl: info.length || 0, tcv: info.tcv || 0 };
      }
      return { cl: 0, tcv: 0 };
    }
    function nflLogoUrl(team) {
      var t = U.safeStr(team).toLowerCase();
      if (!t || t.length < 2 || t.length > 4) return "";
      // ESPN team logos — small and cached. Public CDN, CORS-friendly.
      return "https://a.espncdn.com/i/teamlogos/nfl/500/" + t + ".png";
    }

    var html = '<div class="ups-m-player-list">';
    ordered.forEach(function (pos) {
      var list = byPos[pos].slice().sort(function (a, b) {
        return Number(b.row.salary || 0) - Number(a.row.salary || 0);
      });
      html += '<div class="ups-m-pos-group">' + U.escapeHtml(pos) + ' · ' + list.length + '</div>';
      list.forEach(function (entry) {
        var r = entry.row;
        var p = entry.player;
        var name = nameFor(p) || ("Player " + r.id);
        var team = U.safeStr(p && p.team);
        var ct = parseCT(r.contractInfo);
        var cy = U.safeInt(r.contractYear, 0);
        var yr = cy;
        var cl = ct.cl || yr;  // fall back to cy when CL token absent
        var tcv = ct.tcv;
        var typeRaw = U.safeStr(r.contractStatus);
        var logo = nflLogoUrl(team);
        // Skip YR chip when expired — the EXPIRED badge below already
        // conveys it, and "YR 0" is more useful than "YR exp" when
        // someone genuinely has 0 years remaining (the Keith call out).
        var chips = [
          (cl ? '<span class="chip">CL ' + cl + '</span>' : ''),
          (yr > 0 ? '<span class="chip">YR ' + yr + '</span>' : ''),
          (tcv ? '<span class="chip">TCV ' + U.fmtUsd(tcv) + '</span>' : ''),
          (typeRaw ? '<span class="chip type">' + U.escapeHtml(typeRaw) + '</span>' : ''),
          statusBadges(r, otbIds, fid)
        ].filter(Boolean).join(" ");
        html += '' +
          '<div class="ups-m-player-row rich" data-pid="' + U.escapeHtml(r.id) + '">' +
            '<div class="pos ' + posClass(pos) + '">' + U.escapeHtml(pos) + '</div>' +
            '<div class="body">' +
              '<div class="name">' +
                (logo ? '<img class="ups-m-nfl-logo" src="' + U.escapeHtml(logo) + '" alt="" onerror="this.style.display=\'none\'" />' : '') +
                U.escapeHtml(name) +
                (team ? '<span class="nfl-team">' + U.escapeHtml(team) + '</span>' : '') +
              '</div>' +
              '<div class="sub chips-row">' + chips + '</div>' +
            '</div>' +
            '<div class="right">' +
              '<div class="salary">' + U.fmtUsd(r.salary) + '</div>' +
            '</div>' +
          '</div>';
      });
    });
    html += '</div>';
    return html;
  }

  // My Team sub-nav — Roster (cap + roster overview) · Lineup · Taxi ·
  // Contracts (the action hub: MYAC/Extend/Restructure/MYM/Tag). Tagging folded
  // into Contracts › Tag (Keith 2026-06-07: unified Contracts hub, mirrors the
  // desktop FO Contracts tab). NOTE: lineup.js + tagging.js keep their own copy
  // of this nav — keep all three in sync.
  function subTabs(active) {
    function tab(href, label, key) {
      return '<a class="ups-m-subtab' + (key === active ? ' active' : '') + '" href="#myteam/' + href + '">' + label + '</a>';
    }
    return '<div class="ups-m-subtabs">' +
      tab("roster", "Roster", "roster") +
      tab("lineup", "Lineup", "lineup") +
      tab("taxi", "Taxi", "taxi") +
      tab("contracts", "Contracts", "contracts") +
      '</div>';
  }

  function renderRosterTab(mount) {
    var fid = M.state.viewerFranchiseId;
    if (!fid) {
      mount.innerHTML = subTabs("roster") +
        '<div class="ups-m-stub">' +
          '<h3>Sign in to MFL</h3>' +
          '<div>We couldn\'t resolve your franchise. Sign in on the desktop site first, then return here.</div>' +
        '</div>';
      return;
    }
    var cap = DATA.computeCap(fid);
    var roster = DATA.getRosterFor(fid);
    mount.innerHTML =
      subTabs("roster") +
      renderCapCard(cap) +
      renderRoster(roster, fid);
    bindRowClicks(mount);
  }

  // ── Contracts hub (My Team › Contracts) ──────────────────────────────
  // One tab holding all five contract ACTIONS as chips — each lists the
  // viewer's eligible players → tap → player sheet (which carries the action
  // button). Tag delegates to the rich tagging view (slots + tiers), embedded.
  // Mirrors the desktop FO Contracts tab (Keith 2026-06-07).
  var CONTRACT_ACTIONS = [
    { key: "myac", label: "MYAC", blurb: "Set a fresh 1-yr auction win to a 2- or 3-year deal (§C2)." },
    { key: "extend", label: "Extend", blurb: "Add years to a final-year contract before its deadline (§C4)." },
    { key: "restructure", label: "Restructure", blurb: "Reshape salary across the remaining years — offseason, 3/season (§C5)." },
    { key: "mym", label: "MYM", blurb: "Lock an in-season WW/FCFS pickup into a flat 2-/3-yr deal, ≤14 days (§C3)." },
    { key: "tag", label: "Tag", blurb: "Keep an expiring player one more year — 1 offense + 1 defense (§C8)." }
  ];

  function actionChips(active) {
    return '<div class="ups-m-subtabs ups-m-action-chips">' +
      CONTRACT_ACTIONS.map(function (a) {
        return '<a class="ups-m-subtab' + (a.key === active ? ' active' : '') +
          '" href="#myteam/contracts/' + a.key + '">' + U.escapeHtml(a.label) + '</a>';
      }).join("") + '</div>';
  }

  // Eligible roster players for one action, using the FO eligibility mirror
  // (the SAME predicates the player sheet gates on).
  function eligiblePlayersForAction(fid, action) {
    var roster = DATA.getRosterFor(fid) || [];
    var FOA = window.UPS_FRONT_OFFICE_ACTIONS;
    if (!FOA) return [];
    return roster.filter(function (row) {
      if (/taxi|ir/i.test(U.safeStr(row.status)) && action !== "restructure") {
        // taxi/IR can't MYAC/Extend/MYM/Tag; restructure already excludes via eligibility
      }
      if (action === "extend") return FOA.extensionAvailableFor ? FOA.extensionAvailableFor(row, fid).ok : false;
      var e = FOA.eligibilityForRosterRow ? FOA.eligibilityForRosterRow(row, fid) : {};
      if (action === "myac") return !!e.myacEligible;
      if (action === "mym") return !!e.mymEligible;
      if (action === "restructure") return !!e.restructureEligible;
      return false;
    });
  }

  function renderActionList(fid, action) {
    var meta = null;
    for (var i = 0; i < CONTRACT_ACTIONS.length; i++) { if (CONTRACT_ACTIONS[i].key === action) meta = CONTRACT_ACTIONS[i]; }
    var blurb = meta ? meta.blurb : "";
    var players = eligiblePlayersForAction(fid, action);
    var head = '<div class="ups-m-action-blurb">' + U.escapeHtml(blurb) + '</div>';
    if (!players.length) {
      return head + '<div class="ups-m-stub"><div>No players are eligible to ' +
        U.escapeHtml(meta ? meta.label : action) + ' right now.</div>' +
        '<div style="font-size:11px;margin-top:6px;color:var(--fg-muted)">Eligibility follows the same rules as the desktop Front Office. Tap a player anywhere to see their available actions.</div></div>';
    }
    players.sort(function (a, b) { return Number(b.salary || 0) - Number(a.salary || 0); });
    var html = head + '<div class="ups-m-player-list">';
    html += '<div class="ups-m-pos-group">Eligible · ' + players.length + '</div>';
    players.forEach(function (r) {
      var p = DATA.playerById(r.id);
      var name = nameFor(p) || ("Player " + r.id);
      var pos = U.safeStr(p && p.position).toUpperCase();
      var team = U.safeStr(p && p.team);
      var cy = U.safeInt(r.contractYear, 0);
      var chips = [
        (pos ? '<span class="chip">' + U.escapeHtml(pos) + '</span>' : ''),
        (cy > 0 ? '<span class="chip">YR ' + cy + '</span>' : ''),
        (r.contractStatus ? '<span class="chip type">' + U.escapeHtml(U.safeStr(r.contractStatus)) + '</span>' : '')
      ].filter(Boolean).join(" ");
      html += '<div class="ups-m-player-row rich" data-pid="' + U.escapeHtml(r.id) + '">' +
        '<div class="pos ' + posClass(pos) + '">' + U.escapeHtml(pos) + '</div>' +
        '<div class="body">' +
          '<div class="name">' + U.escapeHtml(name) +
            (team ? '<span class="nfl-team">' + U.escapeHtml(team) + '</span>' : '') + '</div>' +
          '<div class="sub chips-row">' + chips + '</div>' +
        '</div>' +
        '<div class="right"><div class="salary">' + U.fmtUsd(r.salary) + '</div></div>' +
      '</div>';
    });
    html += '</div>';
    return html;
  }

  function renderContractsHub(mount, action) {
    var fid = M.state.viewerFranchiseId;
    if (!fid) {
      mount.innerHTML = subTabs("contracts") +
        '<div class="ups-m-stub"><h3>Sign in to MFL</h3><div>We couldn\'t resolve your franchise.</div></div>';
      return;
    }
    action = action || "myac";
    var valid = CONTRACT_ACTIONS.some(function (a) { return a.key === action; });
    if (!valid) action = "myac";
    mount.innerHTML = subTabs("contracts") + actionChips(action);
    if (action === "tag") {
      // Rich tagging view (slots + tiers), embedded without its own sub-nav.
      if (M.taggingView && M.taggingView.render) {
        var slot = document.createElement("div");
        mount.appendChild(slot);
        M.taggingView.render(slot, { embed: true });
      } else {
        mount.insertAdjacentHTML("beforeend", '<div class="ups-m-stub"><div>Tagging is loading…</div></div>');
      }
      return;
    }
    mount.insertAdjacentHTML("beforeend", renderActionList(fid, action));
    bindRowClicks(mount);
  }

  // Taxi subtab — read-only listing of taxi-squad players. Per Keith
  // 2026-05-16, taxi rule changes are pending finalization; no mutating
  // actions (promote / cut) are wired up yet.
  //
  // SALARY DERIVATION (Keith 2026-05-16):
  // MFL nulls salary for taxi players in both rosters + salaries exports.
  // Per §A1.4 rookie salary is deterministic by UPS draft slot, so we
  // derive it via DATA.deriveTaxiSalary which:
  //   1. Parses `drafted: "R.PP (YYYY)"` for players this franchise drafted
  //   2. Falls back to a pid-keyed lookup against past 3 years of
  //      draftResults for trade-acquired taxi players ("Trade (YYYY)")
  //   3. Returns the §A1.4 salary for the resolved pick
  // Coverage in live data (2026-05-16): 63/85 direct + ~22 via historical
  // lookup = effectively 100% of rookie-origin taxi.
  function renderTaxi(mount) {
    var fid = M.state.viewerFranchiseId;
    if (!fid) {
      mount.innerHTML = subTabs("taxi") +
        '<div class="ups-m-stub"><h3>Sign in to MFL</h3><div>We couldn\'t resolve your franchise.</div></div>';
      return;
    }
    var rows = DATA.getRosterFor(fid).filter(function (r) {
      return /taxi/i.test(U.safeStr(r.status));
    });
    var banner =
      '<div class="ups-m-card" style="border-color:var(--warn);background:rgba(255,184,107,0.06)">' +
        '<div class="ups-m-card-title" style="color:var(--warn)">Rule change pending</div>' +
        '<div style="font-size:13px">Due to a change in rule, waiting to apply logic before allowing changes to taxi squad players. This view is read-only for now.</div>' +
        '<div style="font-size:11px;margin-top:8px;color:var(--fg-muted)">Salaries are derived from the §A1.4 rookie pay table using each player\'s UPS draft slot. Off-cap while on taxi.</div>' +
      '</div>';

    if (!rows.length) {
      mount.innerHTML = subTabs("taxi") + banner +
        '<div class="ups-m-stub"><div>No players on taxi.</div></div>';
      return;
    }

    // Derive salaries first so we can sort by them (MFL gives us $0).
    var enriched = rows.map(function (r) {
      var derived = DATA.deriveTaxiSalary ? DATA.deriveTaxiSalary(r) : { ok: false, salary: 0 };
      return { row: r, derived: derived };
    });
    enriched.sort(function (a, b) {
      return Number(b.derived.salary || 0) - Number(a.derived.salary || 0);
    });

    var html = subTabs("taxi") + banner + '<div class="ups-m-player-list">';
    html += '<div class="ups-m-pos-group">Taxi · ' + rows.length + '</div>';
    enriched.forEach(function (entry) {
      var r = entry.row;
      var d = entry.derived;
      var p = DATA.playerById(r.id);
      var rawPos = U.safeStr(p && p.position).toUpperCase();
      var name = U.safeStr(p && p.name) || ("Player " + r.id);
      // Re-orient "Last, First" → "First Last"
      if (name.indexOf(",") >= 0) {
        var parts = name.split(",");
        name = (parts[1] || "").trim() + " " + (parts[0] || "").trim();
        name = name.trim();
      }
      var team = U.safeStr(p && p.team);
      // Chip: show the derived UPS draft slot for clarity. Falls back
      // to the MFL `drafted` string when derivation didn't resolve.
      var slotChip = "";
      if (d.ok && d.round && d.pick) {
        var pickStr = d.round + "." + (d.pick < 10 ? "0" + d.pick : d.pick);
        slotChip = '<span class="chip">' + U.escapeHtml(pickStr) +
          (d.year ? ' \'' + String(d.year).slice(-2) : '') + '</span>';
      } else if (r.drafted) {
        slotChip = '<span class="chip">' + U.escapeHtml(U.safeStr(r.drafted)) + '</span>';
      }
      var salaryHtml = d.ok
        ? '<div class="salary" style="color:var(--teal)">' + U.fmtUsd(d.salary) + '</div>'
        : '<div class="salary" style="color:var(--fg-muted);font-size:11px">—</div>';
      html += '<div class="ups-m-player-row" data-pid="' + U.escapeHtml(r.id) + '">' +
        '<div class="pos">' + U.escapeHtml(rawPos) + '</div>' +
        '<div class="body">' +
          '<div class="name">' + U.escapeHtml(name) +
            (team ? '<span class="nfl-team">' + U.escapeHtml(team) + '</span>' : '') +
          '</div>' +
          '<div class="sub chips-row">' + slotChip + '</div>' +
        '</div>' +
        '<div class="right">' + salaryHtml + '</div>' +
      '</div>';
    });
    html += '</div>';
    mount.innerHTML = html;
    bindRowClicks(mount);
  }

  function renderLineupStub(mount) {
    // Delegate to lineup.js (Phase 2). Falls back to a stub if the view
    // hasn't loaded yet (script-order safety).
    if (M.lineupView && M.lineupView.render) {
      M.lineupView.render(mount);
      return;
    }
    mount.innerHTML =
      subTabs("lineup") +
      '<div class="ups-m-stub">' +
        '<h3>Lineup editor</h3>' +
        '<div>Loading…</div>' +
      '</div>';
  }

  function bindRowClicks(scope) {
    var rows = scope.querySelectorAll(".ups-m-player-row");
    for (var i = 0; i < rows.length; i++) {
      rows[i].addEventListener("click", function () {
        var pid = this.getAttribute("data-pid");
        if (pid && M.sheet) M.sheet.open(pid);
      });
    }
  }

  function render(mount, subParts) {
    var sub = (subParts && subParts[0]) || "roster";
    if (sub === "lineup") return renderLineupStub(mount);
    if (sub === "taxi") return renderTaxi(mount);
    if (sub === "contracts") return renderContractsHub(mount, subParts[1]);
    if (sub === "tagging") return renderContractsHub(mount, "tag");   // back-compat for the old Tagging tab/links
    return renderRosterTab(mount);   // "roster" or default
  }

  M.route.registerView("myteam", render);
})();
