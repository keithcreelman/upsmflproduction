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
      taxiEligibleNow = !!DATA.isTaxiEligibleFor(rosterRow.id, rosterRow.contractStatus);
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

  // Cap HERO variant for the Home command center — Cap Room is the dominant
  // number. Reuses the same .ups-m-cap-* classes as renderCapCard (the dense
  // ledger on the Roster tab) so the two surfaces never diverge. Exposed via
  // M.components.capHero.
  function renderCapHero(cap) {
    if (!cap) return "";
    var pct = U.safeInt(cap.pct, 0);
    var overCap = cap.capRoom < 0;
    var roomClass = overCap ? "danger" : (pct >= 95 ? "warn" : "ok");
    return '' +
      '<div class="ups-m-cap-card hero">' +
        '<div class="ups-m-cap-hero-room">' +
          '<div class="lbl">Cap Room</div>' +
          '<div class="val ' + roomClass + '">' + U.fmtUsd(cap.capRoom) + '</div>' +
        '</div>' +
        '<div class="ups-m-cap-bar"><div class="ups-m-cap-bar-fill ' + (overCap ? "over" : "") +
          '" style="width:' + Math.min(100, Math.max(0, pct)) + '%"></div></div>' +
        '<div class="ups-m-cap-foot">' +
          '<span class="chip">' + pct + '% used</span>' +
          '<span class="chip">' + U.fmtUsd(cap.capTotal) + ' of ' + U.fmtUsd(cap.capAmount) + '</span>' +
          // ACTIVE count / ACTIVE max — see M.data.rosterCapMax() (app.js).
          // rosterCount (raw total incl. taxi+IR) against a hardcoded /30 read
          // "37/30" for an owner with real taxi bodies, over a limit that both
          // excludes taxi/IR AND is 35 (not 30) before the Sept deadline.
          '<span class="chip">' + U.safeInt(cap.activeCount, 0) + '/' + (DATA.rosterCapMax ? DATA.rosterCapMax() : 30) + ' roster</span>' +
          (cap.taxiCount ? '<span class="chip">' + cap.taxiCount + ' taxi</span>' : '') +
          (cap.irCount ? '<span class="chip">' + cap.irCount + ' IR</span>' : '') +
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
  function ic(name, size) { return window.UPS_ICONS ? window.UPS_ICONS.svg(name, { size: size || 18 }) : ""; }

  function subTabs(active) {
    function tab(href, label, key) {
      return '<a class="ups-m-subtab' + (key === active ? ' active' : '') + '" href="#myteam/' + href + '">' + label + '</a>';
    }
    // Roster section only — Roster · Lineup · Taxi · IR. Contracts is its
    // OWN self-contained section (its own contract-ops nav), reached via the
    // Home "Contracts" card or the bottom nav — no cross-bleed. (Keith
    // 2026-06-10: card-driven, no-bleed sections.)
    return '<div class="ups-m-subtabs">' +
      tab("roster", "Roster", "roster") +
      tab("lineup", "Lineup", "lineup") +
      tab("taxi", "Taxi", "taxi") +
      tab("ir", "IR", "ir") +
      '</div>';
  }

  // Action center — the "what needs my attention now" summary atop My Team
  // (Keith 2026-06-07). Surfaces only ACTIVE prompts (incoming trades,
  // time-sensitive contract windows, over-cap), each tapping through to where
  // the action lives. Eligibility uses the same FO predicates as the hub.
  function renderActionCenter(fid) {
    var items = [];

    // Incoming trade offers (most time-sensitive social action).
    var incoming = (M.state.tradeOffers && M.state.tradeOffers.incoming) || [];
    if (incoming.length) {
      items.push({ icon: ic("inbox"), href: "#league/trade",
        text: incoming.length + " incoming trade offer" + (incoming.length > 1 ? "s" : ""),
        sub: "Review &amp; respond" });
    }

    // Contract action windows — MYM first (hard 14-day clock).
    var prompts = [
      { key: "mym", icon: ic("clock"), label: "MYM-eligible", sub: "Pre-season pickups through Week 3 · in-season pickups 14 days" },
      { key: "myac", icon: ic("file-text"), label: "MYAC-eligible", sub: "Set 1-yr deals to 2 or 3 years" },
      { key: "extend", icon: ic("trending-up"), label: "can be extended", sub: "Final-year contracts" },
      { key: "restructure", icon: ic("sliders"), label: "can restructure", sub: "Offseason · 3 per season" }
    ];
    prompts.forEach(function (p) {
      var n = eligiblePlayersForAction(fid, p.key).length;
      if (!n) return;
      // MYAC no longer means "auction win" — pre-season waiver pickups walk the
      // same ladder (canon ~379), so the alert counts players, not wins.
      var noun = n + " player" + (n > 1 ? "s" : "");
      var text = noun + " " + p.label;
      items.push({ icon: p.icon, href: "#myteam/contracts/" + p.key, text: text, sub: p.sub });
    });

    // IR-eligible (canon §B3). Surfaced here because IR is worth real money —
    // 50% cap relief, and the player comes off the active-roster max — and an
    // owner has no reason to go hunting for it. The action itself lives on the
    // player sheet ("Place on IR"); this alert only points at the list.
    //
    // NO FAIL-OPEN on the feed. DATA.irEligibilityFor returns { known, ... },
    // and `known` is false when MFL's injuries export did not read. An
    // unreadable feed must NOT render as "0 eligible" — that is exactly the bug
    // that kept this bucket silently empty (the export was fetched with L=,
    // which MFL rejects, decoding to an empty list). When we cannot tell, say
    // so rather than show a count we did not earn.
    (function () {
      var roster = DATA.getRosterFor(fid) || [];
      if (!roster.length || !DATA.irEligibilityFor) return;
      var feed = DATA.injuryFeedState ? DATA.injuryFeedState() : null;
      if (feed && feed.ok === false) {
        items.push({
          icon: ic("alert-triangle"),
          href: "#myteam/ir",
          text: "IR eligibility unavailable",
          sub: "Couldn't read MFL's injury report — not the same as nobody being eligible"
        });
        return;
      }
      var n = 0;
      for (var i = 0; i < roster.length; i += 1) {
        var r = roster[i] || {};
        var st = U.safeStr(r.status).toUpperCase();
        // Already on IR, or on taxi — neither is a candidate to option down.
        if (st.indexOf("IR") !== -1 || st.indexOf("INJURED") !== -1 ||
            st.indexOf("RESERVE") !== -1 || st.indexOf("TAXI") !== -1) continue;
        var e = DATA.irEligibilityFor(r.id);
        if (e && e.known && e.eligible) n += 1;
      }
      if (!n) return;
      items.push({
        icon: ic("heart-pulse"),
        href: "#myteam/ir",
        text: n + " player" + (n > 1 ? "s" : "") + " can go on IR",
        sub: "50% cap relief · off the active-roster max · reversible"
      });
    })();

    // Cap compliance.
    var cap = DATA.computeCap(fid);
    if (cap && U.safeInt(cap.capRoom, 0) < 0) {
      items.push({ icon: ic("alert-triangle"), cls: "danger", href: "#myteam/contracts/restructure",
        text: "Over the cap by " + U.fmtUsd(Math.abs(cap.capRoom)),
        sub: "Cut or restructure to get compliant" });
    }

    var html = '<div class="ups-m-action-center"><div class="ups-m-ac-title">Alerts</div>';
    if (!items.length) {
      return html + '<div class="ups-m-ac-allset">✓ You\'re all set — nothing needs action right now.</div></div>';
    }
    items.forEach(function (it) {
      html += '<a class="ups-m-ac-item' + (it.cls ? " " + it.cls : "") + '" href="' + it.href + '">' +
        '<span class="ups-m-ac-icon">' + it.icon + '</span>' +
        '<span class="ups-m-ac-text">' + U.escapeHtml(it.text) +
          (it.sub ? '<span class="sub">' + it.sub + '</span>' : '') + '</span>' +
        '<span class="ups-m-ac-chev">›</span>' +
      '</a>';
    });
    return html + '</div>';
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
      renderActionCenter(fid) +
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
    { key: "myac", label: "MYAC", blurb: "Set a fresh 1-yr auction win or pre-season waiver pickup to a 2- or 3-year deal, through the contract deadline (§C2)." },
    { key: "extend", label: "Extend", blurb: "Add years to a final-year contract before its deadline (§C4)." },
    { key: "restructure", label: "Restructure", blurb: "Reshape salary across the remaining years — offseason, 3/season (§C5)." },
    { key: "mym", label: "MYM", blurb: "Flat 2-/3-yr deal: pre-season pickups from the contract deadline to Week 3 kickoff; in-season pickups within 14 days (§C3)." },
    { key: "tag", label: "Tag", blurb: "Keep an expiring player one more year — 1 offense + 1 defense (§C8)." }
  ];

  function actionChips(active) {
    var chips = CONTRACT_ACTIONS.map(function (a) {
      return '<a class="ups-m-subtab' + (a.key === active ? ' active' : '') +
        '" href="#myteam/contracts/' + a.key + '">' + U.escapeHtml(a.label) + '</a>';
    });
    // Ledger — read-only contract-activity log (audit), self-contained here.
    chips.push('<a class="ups-m-subtab' + ("ledger" === active ? ' active' : '') +
      '" href="#myteam/contracts/ledger">Ledger</a>');
    return '<div class="ups-m-subtabs ups-m-action-chips">' + chips.join("") + '</div>';
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

  // Per-player contract-action deadline. §C4 extension deadlines are a
  // verbatim mirror of desktop extensionDeadlineForPlayer (front_office.js:1525)
  // — Rookie → May of expiry year; in-season WW/FCFS → acq+28d (days 15–28);
  // in-season trade → acq+28d (4 weeks); Veteran → September — and the
  // PRE-SEASON ACQUISITION LADDER (FA auction or pre-season waivers, canon
  // ~379/~1211/~1214) is layered in front of them:
  //   Multi-Year Contract (MYAC)  → September contract deadline
  //   Mid-Year Multi (MYM)        → NFL Week 3 kickoff
  //   Extension                   → NFL Week 5 kickoff
  // Those are the dates the Discord waiver post prints for the very same
  // players, and both surfaces read the same league-calendar rows so they
  // cannot drift apart. Before this, a Vet-WW pre-season claim matched none of
  // the branches below and fell through to "Veteran — September contract
  // deadline", which is a window that never applied to it.
  function rookieLikeStatus(s) {
    s = U.safeStr(s).toLowerCase();
    return s === "r" || s.indexOf("r-") === 0 || s.indexOf("rookie") !== -1;
  }
  function mayRookieDeadline(year) {
    var yr = parseInt(year, 10);
    if (!yr) return null;
    var may31 = new Date(Date.UTC(yr, 4, 31));
    var lastMon = 31 - ((may31.getUTCDay() + 6) % 7);
    var dl = new Date(Date.UTC(yr, 4, lastMon));
    dl.setUTCDate(dl.getUTCDate() - 3);
    dl.setUTCHours(4, 0, 0, 0);
    return dl;
  }
  // Noon UTC of an ISO calendar date — keeps the DISPLAYED date stable (Sep 6,
  // not the UTC-rolled Sep 7 you get from the real 9pm-ET deadline moment),
  // which matches the desktop EXTENSION WINDOW table. Returns null — never a
  // substitute date — when there is no readable ISO value.
  function isoDeadlineDate(iso) {
    var m = U.safeStr(iso).slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12, 0, 0)) : null;
  }
  function septContractDeadline() {
    return isoDeadlineDate(M.state.contractDeadline);
  }
  // The ladder rung this player is on, as a { date, basis } pair. Returns null
  // when they are not on the pre-season ladder, so the desktop-mirror branches
  // below keep running unchanged for everyone else.
  var LADDER_BASIS = {
    myac: "Auction / pre-season waiver pickup — MYAC through the contract deadline",
    mym: "Auction / pre-season waiver pickup — MYM through NFL Week 3 kickoff",
    extension: "Auction / pre-season waiver pickup — Extension through NFL Week 5 kickoff",
    closed: "Auction / pre-season waiver pickup — all contract windows have closed",
    unresolved: "Auction / pre-season waiver pickup — window can't be confirmed (schedule/calendar unavailable)"
  };
  function ladderDeadlineFor(row, fid) {
    var FOA = window.UPS_FRONT_OFFICE_ACTIONS;
    if (!FOA || !FOA.contractWindowForRosterRow) return null;
    var w = FOA.contractWindowForRosterRow(row, fid);
    if (!w.onLadder) return null;
    // endMs is the exact instant the window shuts — a real NFL kickoff for the
    // MYM/Extension rungs. The countdown uses it so "3d left" doesn't round a
    // Thursday-night kickoff up to the whole of Thursday.
    return {
      date: isoDeadlineDate(w.endDate),
      endMs: w.endMs,
      basis: LADDER_BASIS[w.stage] || LADDER_BASIS.unresolved
    };
  }
  function contractActionDeadlineFor(row, fid, action) {
    var seasonInt = parseInt(M.state.ctx.year, 10) || new Date().getUTCFullYear();
    var cy = Math.max(0, U.safeInt(row.contractYear, 0));
    var statusLc = U.safeStr(row.contractStatus).toLowerCase();
    var special = U.safeStr(row.contractInfo).toLowerCase();
    var expiredRookie = special.indexOf("expired rookie") !== -1 || (rookieLikeStatus(statusLc) && cy <= 0);
    var isRookieContract = rookieLikeStatus(statusLc) || expiredRookie;
    var acq = DATA.acquisitionForPlayer ? DATA.acquisitionForPlayer(fid, row.id) : null;
    var acqLabel = U.safeStr(acq && acq.label).toLowerCase();
    var acqDateStr = U.safeStr(acq && acq.date);
    var acquiredThisSeason = acqDateStr.slice(0, 4) === String(seasonInt);
    var acqDate = null;
    try { if (acqDateStr) acqDate = new Date(acqDateStr.slice(0, 10) + "T12:00:00-04:00"); } catch (e) {}
    var isWW = acquiredThisSeason && acqDate && /\b(ww|fcfs|blind|waiver|free agent)\b/.test(acqLabel) && acqLabel.indexOf("auction") === -1;
    var isTradeAcq = acquiredThisSeason && acqDate && acqLabel.indexOf("trade") !== -1;
    var DAY = 86400000, date = null, start = null, basis = "";
    // The ladder answers FIRST for the players it covers — an FA-auction win or
    // a PRE-SEASON waiver claim. It is classified off contractStatus, so it
    // still fires when the acquisition lookup has never heard of the player
    // (which is the normal case for anyone signed after the lookup was last
    // generated) and no unmatched label can quietly demote them to the
    // veteran branch below.
    var ladder = ladderDeadlineFor(row, fid);
    if (ladder) {
      var lNow = Date.now();
      var lEnd = (ladder.endMs != null) ? ladder.endMs
                 : (ladder.date ? ladder.date.getTime() : null);
      return {
        date: ladder.date,
        basis: ladder.basis,
        daysUntil: lEnd != null ? Math.ceil((lEnd - lNow) / DAY) : null,
        inWindow: lEnd != null && lNow < lEnd
      };
    }
    if (isWW && action === "mym") {
      // The IN-SEASON §C3 clock (canon ~391) — untouched by the ladder above.
      date = new Date(acqDate.getTime() + 14 * DAY);
      basis = "In-season WW/FCFS pickup — days 1–14";
    } else if (isWW) {
      start = new Date(acqDate.getTime() + 15 * DAY);
      date = new Date(acqDate.getTime() + 28 * DAY);
      basis = "In-season WW/FCFS pickup — days 15–28";
    } else if (isTradeAcq) {
      date = new Date(acqDate.getTime() + 28 * DAY);
      basis = "Trade-acquired — 4 weeks";
    } else if (isRookieContract) {
      date = mayRookieDeadline(seasonInt + cy);
      basis = "Rookie — May " + (seasonInt + cy);
    } else {
      date = septContractDeadline();
      basis = "Veteran — September contract deadline";
    }
    var now = Date.now();
    var daysUntil = date ? Math.ceil((date.getTime() - now) / DAY) : null;
    var inWindow = !!date && now <= date.getTime() && (!start || now >= start.getTime());
    return { date: date, basis: basis, daysUntil: daysUntil, inWindow: inWindow };
  }
  var DL_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function fmtDeadlineDate(d) {
    return d ? (DL_MONTHS[d.getUTCMonth()] + " " + d.getUTCDate() + ", " + d.getUTCFullYear()) : "—";
  }

  // The pre-season ladder, as a header strip on the MYAC / MYM lists.
  //
  // The contract deadline comes from the commish-owned league calendar; the
  // Week 3 / Week 5 boundaries are the real first kickoffs of those weeks, read
  // from MFL's schedule by the SAME worker helper that prints these players'
  // windows in the Discord waiver post. A boundary that didn't resolve says so
  // out loud instead of borrowing a neighbouring date.
  function renderLadderNote() {
    var FOA = window.UPS_FRONT_OFFICE_ACTIONS;
    if (!FOA || !FOA.contractLadderDates) return "";
    var d = FOA.contractLadderDates();
    if (!d.contractDeadline && !d.mymWindowEnd && !d.extensionWindowEnd) return "";
    // A boundary we could not read prints as an explicit "date unavailable"
    // rather than borrowing the neighbouring rung's date.
    function rung(prefix, iso, missing) {
      var dt = isoDeadlineDate(iso);
      return U.escapeHtml(prefix) + (dt ? " " + U.escapeHtml(fmtDeadlineDate(dt))
                                        : ' <i>(' + U.escapeHtml(missing) + ')</i>');
    }
    return '<div class="ups-m-action-blurb">' +
      '<b>Pre-season ladder</b> (auction wins &amp; pre-season waiver pickups): ' +
      rung("MYAC through", d.contractDeadline, "not on the calendar") + ' · ' +
      rung("MYM through Week 3 kickoff,", d.mymWindowEnd, "kickoff unavailable") + ' · ' +
      rung("Extension through Week 5 kickoff,", d.extensionWindowEnd, "kickoff unavailable") + '.' +
      '</div>';
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
      // Each player has their OWN deadline (Keith 2026-06-08: "extension
      // deadlines vary by player") — shown per-row, not as a generic strip.
      // MYAC and MYM carry one too now: for a player on the pre-season ladder
      // the open window's end date IS the answer to "how long do I have", and
      // it has to read the same on this list as it does in the Discord waiver
      // post that announced the pickup.
      var deadlineLine = "", rightDl = "";
      if (action === "extend" || action === "myac" || action === "mym") {
        var dl = contractActionDeadlineFor(r, fid, action);
        var n = dl.daysUntil;
        var dcls = (n == null) ? "" : (n < 0 ? "past" : n <= 14 ? "now" : n <= 45 ? "soon" : "");
        deadlineLine = '<div class="ups-m-ext-dl ' + dcls + '"><span class="basis">' + U.escapeHtml(dl.basis) + '</span></div>';
        rightDl = '<div class="ext-dl-date">' + U.escapeHtml(fmtDeadlineDate(dl.date)) + '</div>' +
          '<div class="ext-dl-days ' + dcls + '">' + (n == null ? "—" : (n < 0 ? "passed" : n + "d left")) + '</div>';
      }
      html += '<div class="ups-m-player-row rich" data-pid="' + U.escapeHtml(r.id) + '">' +
        '<div class="pos ' + posClass(pos) + '">' + U.escapeHtml(pos) + '</div>' +
        '<div class="body">' +
          '<div class="name">' + U.escapeHtml(name) +
            (team ? '<span class="nfl-team">' + U.escapeHtml(team) + '</span>' : '') + '</div>' +
          '<div class="sub chips-row">' + chips + '</div>' +
          deadlineLine +
        '</div>' +
        '<div class="right">' +
          (rightDl || ('<div class="salary">' + U.fmtUsd(r.salary) + '</div>')) +
        '</div>' +
      '</div>';
    });
    html += '</div>';
    return html;
  }

  // Upcoming contract deadlines (Keith 2026-06-08 — "as we do on web"). Pulls
  // the contract-relevant rows from the league-events calendar via the shared
  // M.eventsUtil helpers so formatting matches the Events tab.
  function renderDeadlinesStrip() {
    var EU = M.eventsUtil;
    if (!EU || !EU.upcomingEvents) return "";
    var CONTRACT_RX = /(contract_deadline|extension|mym|restructure|tag|rookie_extensions)/i;
    var evs = EU.upcomingEvents().filter(function (e) {
      return CONTRACT_RX.test(U.safeStr(e.event));
    }).slice(0, 4);
    if (!evs.length) return "";
    var rows = evs.map(function (e) {
      var nm = EU.eventMeta(e);
      var tone = EU.whenTone(e.date);
      var n = EU.daysUntil(e.date);
      // Always show the date; add a relative countdown only when imminent.
      var when = EU.prettyDate(e.date);
      if (n != null && n >= 0 && n <= 21) when += " · " + EU.whenLabel(e.date);
      return '<a class="ups-m-deadline-row ' + U.escapeHtml(tone) + '" href="' + U.escapeHtml(nm.route) + '">' +
        '<span class="dl-evt">' + U.escapeHtml(nm.label) + '</span>' +
        '<span class="dl-when">' + U.escapeHtml(when) + '</span>' +
      '</a>';
    }).join("");
    return '<div class="ups-m-deadlines">' +
      '<div class="ups-m-deadlines-title">Upcoming deadlines</div>' + rows + '</div>';
  }

  // ── Contract Ledger (read-only audit log) ───────────────────────────
  // League-wide contract-activity feed — the SAME source the desktop FO
  // Misc tab uses: the public read-only /admin/contract-submissions D1
  // endpoint (browser-side, credentials:"omit", no APIKEY). Newest first.
  var LEDGER_KIND = { myac: "MYAC", extension: "Extension", restructure: "Restructure", tag: "Tag", untag: "Untag", mym: "MYM" };
  var LEDGER_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function ledgerTeam(fid) {
    var f = (M.state.franchises || []).find(function (x) { return x.id === U.pad4(fid); });
    return f ? (f.abbrev || f.name || ("Team " + U.pad4(fid))) : ("Team " + U.pad4(fid));
  }
  function ledgerWhen(iso) {
    var m = U.safeStr(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return "";
    return LEDGER_MONTHS[(Number(m[2]) || 1) - 1] + " " + Number(m[3]);
  }
  // AAV display. Only TRUST a raw-dollar AAV (>= $1,000) — the ups_extension
  // submissions column is mixed-unit: most rows store aav in $K (e.g. 33 for
  // $33K, == salary/1000, so falling back to salary renders the same number),
  // while the pre-trade-3way flow stores true raw-dollar AAVs (e.g. 33000 /
  // 43000 for London's dual AAV). Sub-$1K values are $K-units or garbage —
  // return null so the caller falls back to the loaded salary unchanged.
  // Renders one decimal (e.g. $47.5K) and trims a trailing ".0".
  function ledgerAav(n) {
    var x = Number(n || 0);
    if (!isFinite(x) || x < 1000) return null;
    return "$" + (Math.round(x / 100) / 10) + "K";
  }
  function ledgerChange(s) {
    function leg(side) {
      side = side || {};
      var yr = side.contract_year != null ? (side.contract_year + "yr") : null;
      // Prefer a real (raw-dollar) AAV over the loaded year-1 salary — a
      // backloaded/escalating deal's Y1 salary misrepresents the contract
      // (London: current-year AAV $33K → extension-year AAV $43K, not the
      // loaded $52K). K-unit/garbage aav falls through to salary.
      var aavStr = side.aav != null ? ledgerAav(side.aav) : null;
      var sal = aavStr || (side.salary != null ? U.fmtUsd(side.salary) : null);
      return [yr, sal].filter(Boolean).join(" ");
    }
    var a = leg(s.prior), b = leg(s.new);
    if (a && b) return a + " → " + b;
    return b || a || "";
  }
  // Test-event filter — franchises (optionally only before a `before` cutoff)
  // whose contract activity is TEST data, hidden by default. Mirrors the
  // desktop FO Misc Contract Log (front_office.js isTestEvent) and reads the
  // SAME Pages-served config, so desktop + mobile stay in sync. Keith
  // 2026-06-10: "only real, non-test moves in the ledger."
  function buildIsTestEvent(testFranchises) {
    var list = testFranchises || [];
    return function (fid, dateStr) {
      for (var i = 0; i < list.length; i++) {
        var t = list[i];
        if (U.pad4(t.franchise_id) !== fid) continue;
        if (!t.before) return true;                                 // whole franchise = test
        if (String(dateStr || "") < String(t.before)) return true;  // test "thus far"
      }
      return false;
    };
  }
  function renderContractLedger(mount) {
    var box = document.createElement("div");
    box.className = "ups-m-ledger";
    box.innerHTML = '<div class="ups-m-ledger-loading">Loading contract activity…</div>';
    mount.appendChild(box);
    var ctx = M.state.ctx || {};
    var year = ctx.year || "2026", league = ctx.leagueId || "74598";
    var subsUrl = M.api.workerUrl("/admin/contract-submissions") +
      "?L=" + encodeURIComponent(league) + "&YEAR=" + encodeURIComponent(year);
    // Relative path resolves to <pages-root>/contract_submissions/… on both
    // GitHub Pages (/upsmflproduction/m/ → /upsmflproduction/contract_submissions/)
    // and local preview (/m/ → /contract_submissions/).
    var testUrl = "../contract_submissions/contract_log_test_" + encodeURIComponent(year) + ".json";
    Promise.all([
      fetch(subsUrl, { mode: "cors", credentials: "omit", cache: "no-store" }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
      fetch(testUrl, { credentials: "omit", cache: "no-store" }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
    ]).then(function (res) {
      var data = res[0], tcfg = res[1];
      var isTest = buildIsTestEvent(tcfg && tcfg.test_franchises);
      var all = (data && data.submissions) || [];
      // "Anything that was reverted was a test" (Keith 2026-06-10): a contract
      // change that got reverted never became a real standing move — so drop
      // the revert AND every event on that player+franchise.
      var revertChurn = {};
      all.forEach(function (s) {
        if (/revert/i.test(U.safeStr(s.source))) {
          revertChurn[U.pad4(s.franchise_id) + "|" + U.safeStr(s.player_id)] = true;
        }
      });
      // Only real, non-test moves land in the ledger.
      var rows = all.filter(function (s) {
        if (isTest(U.pad4(s.franchise_id), s.submitted_at_utc)) return false;
        if (revertChurn[U.pad4(s.franchise_id) + "|" + U.safeStr(s.player_id)]) return false;
        return true;
      });
      if (!rows.length) {
        box.innerHTML = '<div class="ups-m-stub"><div>No contract activity recorded for ' + U.escapeHtml(String(year)) + ' yet.</div></div>';
        return;
      }
      // Resolve names for submissions that didn't store player_name.
      var nameByPid = {};
      var pf = M.state.players && M.state.players.players;
      if (pf) { U.asArray(pf.player).forEach(function (p) { if (p && p.id) nameByPid[String(p.id)] = U.safeStr(p.name); }); }
      var html = '<div class="ups-m-ledger-note">League-wide contract activity · ' + rows.length + ' move' + (rows.length > 1 ? "s" : "") + ' · ' + U.escapeHtml(String(year)) + ' · newest first</div>';
      rows.forEach(function (s) {
        var kindKey = U.safeStr(s.kind).toLowerCase();
        var change = ledgerChange(s);
        var pname = U.safeStr(s.player_name) || nameByPid[U.safeStr(s.player_id)] || ("Player " + U.safeStr(s.player_id));
        html += '<div class="ups-m-ledger-row">' +
          '<span class="ups-m-ledger-kind k-' + U.escapeHtml(kindKey) + '">' + U.escapeHtml(LEDGER_KIND[kindKey] || U.safeStr(s.kind)) + '</span>' +
          '<div class="ups-m-ledger-body">' +
            '<div class="ups-m-ledger-player">' + U.escapeHtml(pname) +
              (s.position ? ' <span class="pos">' + U.escapeHtml(s.position) + '</span>' : '') + '</div>' +
            '<div class="ups-m-ledger-meta">' + U.escapeHtml(ledgerTeam(s.franchise_id)) +
              (change ? ' · ' + U.escapeHtml(change) : '') + '</div>' +
          '</div>' +
          '<span class="ups-m-ledger-date">' + U.escapeHtml(ledgerWhen(s.submitted_at_utc)) + '</span>' +
        '</div>';
      });
      box.innerHTML = html;
    }).catch(function () {
      box.innerHTML = '<div class="ups-m-stub"><div>Couldn\'t load contract activity. Pull to refresh.</div></div>';
    });
  }

  function renderContractsHub(mount, action) {
    var fid = M.state.viewerFranchiseId;
    if (!fid) {
      mount.innerHTML = '<div class="ups-m-stub"><h3>Sign in to MFL</h3><div>We couldn\'t resolve your franchise.</div></div>';
      return;
    }
    action = action || "myac";
    var valid = action === "ledger" || CONTRACT_ACTIONS.some(function (a) { return a.key === action; });
    if (!valid) action = "myac";
    // Self-contained Contracts section: its OWN contract-ops nav (action
    // chips + Ledger) — no roster tabs bleed in. Reach Roster/Lineup/Taxi/IR
    // via Home or the bottom nav. (Keith 2026-06-10: card-driven sections.)
    if (action === "ledger") {
      mount.innerHTML = actionChips(action);
      renderContractLedger(mount);
      return;
    }
    // Per-player deadlines live in the lists themselves (each player has their
    // own window). The hub header carries the league-wide ladder for context —
    // the same three boundaries the Discord waiver post prints. A boundary the
    // calendar doesn't hold is shown as "not on the calendar", never guessed.
    var deadlineNote = (action === "myac" || action === "mym")
      ? renderLadderNote()
      : "";
    mount.innerHTML = actionChips(action) + deadlineNote;
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

  // ── Taxi + IR bucket helpers ────────────────────────────────────────
  // Per-player call-up counter chip ("N/3 call-ups", +pending). Canon §B2.
  function callupChip(pid) {
    var c = DATA.taxiCallupsFor && DATA.taxiCallupsFor(pid);
    var used = c ? U.safeInt(c.used, 0) : 0;
    var pending = c ? U.safeInt(c.pending, 0) : 0;
    var max = c ? (U.safeInt(c.max, 3) || 3) : 3;
    var label = used + "/" + max + " call-ups";
    if (pending > 0) label += " +" + pending;
    return '<span class="chip' + (used >= max ? " danger" : "") + '">' + label + '</span>';
  }
  // One tappable mini-row (→ player sheet) for the taxi/IR bucket lists.
  function rosterMiniRow(r, chips, right) {
    var p = DATA.playerById(r.id);
    var name = nameFor(p) || ("Player " + r.id);
    var pos = U.safeStr(p && p.position).toUpperCase();
    var team = U.safeStr(p && p.team);
    return '<div class="ups-m-player-row rich" data-pid="' + U.escapeHtml(r.id) + '">' +
      '<div class="pos ' + posClass(pos) + '">' + U.escapeHtml(pos) + '</div>' +
      '<div class="body">' +
        '<div class="name">' + U.escapeHtml(name) +
          (team ? '<span class="nfl-team">' + U.escapeHtml(team) + '</span>' : '') + '</div>' +
        (chips ? '<div class="sub chips-row">' + chips + '</div>' : '') +
      '</div>' +
      '<div class="right">' + (right || "") + '</div>' +
    '</div>';
  }
  function bucketHead(label, n) {
    return '<div class="ups-m-bucket-head"><span>' + U.escapeHtml(label) + '</span><span class="ct">' + n + '</span></div>';
  }

  // Taxi subtab — TWO buckets (Canon §B2). Promote/demote are wired via the
  // player sheet (handleTaxiRosterMove → /roster-workbench/action). Each player
  // shows their call-up counter (N/3); the 4th call-up makes the promotion
  // permanent. Salary is derived from the §A1.4 rookie pay table (MFL nulls
  // taxi salary) and is OFF-CAP while on taxi.
  function renderTaxi(mount) {
    var fid = M.state.viewerFranchiseId;
    if (!fid) {
      mount.innerHTML = subTabs("taxi") + '<div class="ups-m-stub"><h3>Sign in to MFL</h3><div>We couldn\'t resolve your franchise.</div></div>';
      return;
    }
    var roster = DATA.getRosterFor(fid) || [];
    var onTaxi = roster.filter(function (r) { return /taxi/i.test(U.safeStr(r.status)); });
    var demotable = roster.filter(function (r) {
      return !/taxi|ir|injured|reserve/i.test(U.safeStr(r.status)) &&
        DATA.isTaxiEligibleFor && DATA.isTaxiEligibleFor(r.id, r.contractStatus);
    });
    function taxiSal(r) { var d = DATA.deriveTaxiSalary ? DATA.deriveTaxiSalary(r) : null; return (d && d.ok) ? d.salary : (Number(r.salary) || 0); }
    onTaxi.sort(function (a, b) { return taxiSal(b) - taxiSal(a); });
    demotable.sort(function (a, b) { return (Number(b.salary) || 0) - (Number(a.salary) || 0); });

    function taxiRow(r) {
      var d = DATA.deriveTaxiSalary ? DATA.deriveTaxiSalary(r) : null;
      var sal = (d && d.ok) ? d.salary : (Number(r.salary) || 0);
      var slot = (d && d.ok && d.round && d.pick)
        ? '<span class="chip">' + d.round + "." + (d.pick < 10 ? "0" + d.pick : d.pick) + (d.year ? " '" + String(d.year).slice(-2) : "") + '</span>'
        : "";
      var right = sal
        ? '<div class="salary" style="color:var(--teal)">' + U.fmtUsd(sal) + '</div>'
        : '<div class="salary" style="color:var(--fg-muted);font-size:11px">—</div>';
      return rosterMiniRow(r, callupChip(r.id) + " " + slot, right);
    }

    var html = subTabs("taxi") +
      '<div class="ups-m-action-blurb">Canon §B2 — taxi players cost <b>$0</b> against the cap. Each gets <b>3 call-ups</b>; the 4th makes the promotion permanent. Tap a player to promote or demote.</div>';
    html += bucketHead("Available to promote", onTaxi.length);
    html += onTaxi.length
      ? '<div class="ups-m-player-list">' + onTaxi.map(taxiRow).join("") + '</div>'
      : '<div class="ups-m-bucket-empty">No players on the taxi squad.</div>';
    html += bucketHead("Eligible to demote", demotable.length);
    html += demotable.length
      ? '<div class="ups-m-player-list">' + demotable.map(taxiRow).join("") + '</div>'
      : '<div class="ups-m-bucket-empty">No active rookies are taxi-eligible (R2–5, within 3 league years, not yet permanently promoted).</div>';
    mount.innerHTML = html;
    bindRowClicks(mount);
  }

  // IR subtab — TWO buckets (Canon §B3: IR = 50% cap relief, off the active
  // roster max). Both directions are now live: tap a player to open the sheet,
  // which carries "Place on IR" (worker deactivate_ir) and "Activate from IR"
  // (worker activate_ir). Same shape as the Taxi subtab above — the buckets
  // list, the sheet writes — so there is exactly one place in mobile where a
  // roster move is submitted.
  //
  // Eligibility comes from DATA.irEligibilityFor (the single §B3 predicate,
  // app.js). It reports `known` separately from `eligible`, and this view is
  // required to honour that: when MFL's injuries export didn't read we say so
  // instead of printing "0 eligible", which would be a confident lie about a
  // cap-relevant question. The worker re-checks §B3 before writing anything.
  function renderIr(mount) {
    var fid = M.state.viewerFranchiseId;
    if (!fid) {
      mount.innerHTML = subTabs("ir") + '<div class="ups-m-stub"><h3>Sign in to MFL</h3><div>We couldn\'t resolve your franchise.</div></div>';
      return;
    }
    var roster = DATA.getRosterFor(fid) || [];
    var injuries = M.state.injuriesByPid || {};
    var feed = DATA.injuryFeedState ? DATA.injuryFeedState() : { ok: false, rows: 0 };
    // The "on IR" bucket is derived from the ROSTER's own status field, so it
    // stays trustworthy even when the injuries export is down — call-ups are
    // unaffected by an unreadable feed.
    var onIr = roster.filter(function (r) { return /ir|injured|reserve/i.test(U.safeStr(r.status)); });
    // Candidates need the injuries feed. If it didn't read, there is no honest
    // candidate list to build — an empty array here would render as "nobody
    // qualifies" and that is the exact fail-open shape we refuse.
    var candidates = feed.ok ? roster.filter(function (r) {
      if (/ir|injured|reserve|taxi/i.test(U.safeStr(r.status))) return false;
      var e = DATA.irEligibilityFor(r.id);
      return e.known && e.eligible;
    }) : [];
    onIr.sort(function (a, b) { return (Number(b.salary) || 0) - (Number(a.salary) || 0); });
    candidates.sort(function (a, b) { return (Number(b.salary) || 0) - (Number(a.salary) || 0); });

    function irRow(r) {
      var sal = Number(r.salary) || 0;
      var inj = injuries[String(r.id)] || "";
      var chips = inj ? '<span class="chip">' + U.escapeHtml(inj) + '</span>' : "";
      var right = sal ? '<div class="salary">' + U.fmtUsd(sal) + '</div><div class="cy">50% cap</div>' : "";
      return rosterMiniRow(r, chips, right);
    }

    var html = subTabs("ir") +
      '<div class="ups-m-action-blurb">Canon §B3 — IR players get <b>50% cap relief</b> and don\'t count against the active roster max (15 IR slots). Eligible NFL designations: IR / IR-PUP / IR-NFI / Suspended / Holdout. Tap a player to place them on IR or activate them.</div>';
    html += bucketHead("On IR — available to call up", onIr.length);
    html += onIr.length
      ? '<div class="ups-m-player-list">' + onIr.map(irRow).join("") + '</div>'
      : '<div class="ups-m-bucket-empty">No players on IR.</div>';
    html += bucketHead("Eligible to option to IR", feed.ok ? candidates.length : "—");
    if (!feed.ok) {
      // UNKNOWN, stated as unknown. Note the sheet still offers Place on IR
      // here: the worker reads the injury report server-side over its own
      // session, so our read failing says nothing about its read — and if the
      // worker cannot read it either, it refuses (IR_ELIGIBILITY_UNKNOWN, 502)
      // rather than writing. Nothing is being waved through.
      html += '<div class="ups-m-bucket-empty">' +
        '<b>IR eligibility couldn\'t be checked.</b><br>' +
        'MFL\'s injury report didn\'t load, so we don\'t know who qualifies — this list is empty because we couldn\'t look, not because nobody is eligible. ' +
        'Pull to refresh, or open a player from your Roster and use <b>Place on IR</b>; the server verifies §B3 before it writes anything.' +
        '</div>';
    } else if (candidates.length) {
      html += '<div class="ups-m-player-list">' + candidates.map(irRow).join("") + '</div>';
    } else {
      // Read fine, genuinely nobody on THIS roster — and say which of the two
      // it is. rows>0 means the league-wide report is live (339 designations on
      // 2026-08-15) and simply doesn't name anyone you own. rows===0 means the
      // report itself is carrying nothing at all, which is a different thing to
      // tell an owner even though the bucket looks the same.
      html += '<div class="ups-m-bucket-empty">' +
        'No active players currently hold an IR-eligible NFL designation.' +
        (feed.rows > 0
          ? '<br>MFL\'s injury report is live (' + U.escapeHtml(String(feed.rows)) + ' NFL designations league-wide) — none of them are on your active roster.'
          : '<br>MFL\'s injury report is carrying <b>no designations at all</b> right now, so nobody can qualify yet.') +
        '</div>';
    }
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
    if (sub === "ir") return renderIr(mount);
    if (sub === "contracts") return renderContractsHub(mount, subParts[1]);
    if (sub === "tagging") return renderContractsHub(mount, "tag");   // back-compat for the old Tagging tab/links
    return renderRosterTab(mount);   // "roster" or default
  }

  // Shared components — Home + the Roster tab call the SAME functions so
  // the cap card + "needs attention" queue can never diverge.
  M.components = M.components || {};
  M.components.actionCenter = renderActionCenter;
  M.components.eligiblePlayersForAction = eligiblePlayersForAction;
  M.components.capLedger = renderCapCard;
  M.components.capHero = renderCapHero;

  M.route.registerView("myteam", render);
})();
