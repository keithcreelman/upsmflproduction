/* UPS Mobile — app shell + data layer.
   Mirrors site/team_operations/team_operations.js fetch + cap patterns
   exactly so mobile and desktop produce the same numbers from the same
   MFL exports. CTA parity rule (memory: feedback_cta_parity_and_canonical_rules).
*/
(function () {
  "use strict";

  // ---------- Constants ----------
  var WORKER_BASE_DEFAULT = "https://upsmflproduction.keith-creelman.workers.dev";
  var LEAGUE_ID_DEFAULT = "74598";

  function workerBase() {
    var override = (window.UPS_MOBILE_API_BASE || window.UPS_TEAMOPS_API_BASE || "").trim();
    return (override || WORKER_BASE_DEFAULT).replace(/\/+$/, "");
  }
  function workerUrl(p) { return workerBase() + p; }

  // ---------- Helpers (mirror team_operations.js:19-43) ----------
  function safeStr(v) { return v == null ? "" : String(v).trim(); }
  function pad4(v) {
    var d = String(v || "").replace(/\D/g, "");
    return d ? d.padStart(4, "0").slice(-4) : "";
  }
  function escapeHtml(v) {
    return safeStr(v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function fmtUsd(n) {
    var x = Number(n || 0);
    if (!isFinite(x)) return "$0";
    if (Math.abs(x) >= 1000) return "$" + Math.round(x / 1000) + "K";
    return "$" + Math.round(x);
  }
  function asArray(v) {
    if (Array.isArray(v)) return v;
    if (v == null || v === "") return [];
    return [v];
  }
  function readCookie(name) {
    try {
      var m = document.cookie.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
      return m ? decodeURIComponent(m[1]) : "";
    } catch (e) { return ""; }
  }

  // ---------- State ----------
  var state = {
    ctx: { leagueId: LEAGUE_ID_DEFAULT, year: String(new Date().getUTCFullYear()) },
    league: null,
    franchises: [],
    viewerFranchiseId: "",
    viewerFranchise: null,
    rosters: null,
    salaries: null,
    salaryAdjustments: null,
    players: null,
    tradeBait: null,
    capAmount: 0,
    loaded: false,
    loadingPromise: null,
    loadErrors: [],
    busyActionKey: ""
  };

  // ---------- Context detection ----------
  function detectContext() {
    var qs = new URLSearchParams(window.location.search);
    var leagueId = qs.get("L") || window.UPS_M_LEAGUE_ID || LEAGUE_ID_DEFAULT;
    var year = qs.get("YEAR") || qs.get("year") || window.UPS_M_YEAR || "";
    if (!year) {
      var now = new Date();
      year = String(now.getUTCFullYear());
    }
    state.ctx.leagueId = String(leagueId).replace(/\D/g, "") || LEAGUE_ID_DEFAULT;
    state.ctx.year = String(year).replace(/\D/g, "") || String(new Date().getUTCFullYear());
    // Optional explicit franchise via URL: ?FRANCHISE_ID=0008 — useful for
    // testing and for the "Switch team" flow from the More tab.
    var fidQs = qs.get("FRANCHISE_ID") || qs.get("franchise_id");
    if (fidQs) {
      try { window.localStorage && window.localStorage.setItem("rdh_my_fid", pad4(fidQs)); } catch (e) {}
    }
  }

  // ---------- Data fetch ----------
  function mflExportUrl(type, extra) {
    var url = workerUrl("/api/mfl-export") +
      "?TYPE=" + encodeURIComponent(type) +
      "&L=" + encodeURIComponent(state.ctx.leagueId) +
      "&YEAR=" + encodeURIComponent(state.ctx.year) +
      "&JSON=1";
    if (extra && typeof extra === "object") {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k) && extra[k] != null && extra[k] !== "") {
          url += "&" + encodeURIComponent(k) + "=" + encodeURIComponent(extra[k]);
        }
      }
    }
    return url;
  }

  function fetchJson(url) {
    var controller = ("AbortController" in window) ? new AbortController() : null;
    var timeout = setTimeout(function () { if (controller) controller.abort(); }, 10000);
    var opts = { credentials: "omit", mode: "cors" };
    if (controller) opts.signal = controller.signal;
    return fetch(url, opts)
      .then(function (r) {
        clearTimeout(timeout);
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .catch(function (err) {
        clearTimeout(timeout);
        var tag = (url.split("TYPE=")[1] || url).split("&")[0];
        state.loadErrors.push(tag + ": " + (err && err.message ? err.message : String(err)));
        return null;
      });
  }

  function fetchMe() {
    // /api/me — viewer franchise resolution via MFL_USER_ID cookie.
    // Same endpoint team_operations.js uses for the same purpose.
    return fetch(workerUrl("/api/me"), { credentials: "include", mode: "cors" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  function loadAllData() {
    if (state.loadingPromise) return state.loadingPromise;
    var p = Promise.all([
      fetchJson(mflExportUrl("league")),
      fetchJson(mflExportUrl("rosters")),
      fetchJson(mflExportUrl("salaries")),
      fetchJson(mflExportUrl("salaryAdjustments")),
      fetchJson(mflExportUrl("players", { DETAILS: 1 })),
      fetchJson(mflExportUrl("tradeBait")),
      fetchMe()
    ]).then(function (results) {
      state.league = results[0];
      state.rosters = results[1];
      state.salaries = results[2];
      state.salaryAdjustments = results[3];
      state.players = results[4];
      state.tradeBait = results[5];
      parseLeague();
      resolveViewerFranchise(results[6]);
      state.loaded = true;
      return state;
    });
    state.loadingPromise = p;
    return p;
  }

  // Re-fetch league data after a roster mutation. Same shape as loadAllData
  // but skips the franchise resolution (we already know the viewer).
  function reloadData() {
    state.loadingPromise = null;
    state.loaded = false;
    return loadAllData();
  }

  function parseLeague() {
    if (!state.league || !state.league.league) return;
    var lg = state.league.league;
    state.capAmount = Number(lg.salaryCapAmount || 0) || 0;
    state.franchises = asArray(lg.franchises && lg.franchises.franchise).map(function (f) {
      return {
        id: pad4(f.id),
        name: safeStr(f.name),
        icon: safeStr(f.icon),
        logo: safeStr(f.logo),
        owner: safeStr(f.owner_name)
      };
    });
  }

  function resolveViewerFranchise(meResp) {
    // Priority: (1) /api/me, (2) localStorage rdh_my_fid (shared with desktop hubs),
    // (3) MFL_LAST_LOGIN_FRANCHISE_ID cookie, (4) MFL_USER_ID cookie match.
    var fid = "";
    if (meResp && meResp.configured && meResp.franchise_id) fid = pad4(meResp.franchise_id);
    if (!fid) {
      try {
        var ls = window.localStorage && window.localStorage.getItem("rdh_my_fid");
        if (ls) fid = pad4(ls);
      } catch (e) {}
    }
    if (!fid) {
      var lastLogin = readCookie("MFL_LAST_LOGIN_FRANCHISE_ID");
      if (lastLogin) fid = pad4(lastLogin);
    }
    if (!fid && state.league) {
      var fr = asArray(state.league.league && state.league.league.franchises && state.league.league.franchises.franchise);
      var userId = readCookie("MFL_USER_ID");
      if (userId) {
        for (var i = 0; i < fr.length; i++) {
          var owner = safeStr(fr[i].username || fr[i].owner_id || fr[i].owner_name);
          if (owner && owner.indexOf(userId) !== -1) {
            fid = pad4(fr[i].id);
            break;
          }
        }
      }
    }
    state.viewerFranchiseId = fid;
    state.viewerFranchise = state.franchises.find(function (f) { return f.id === fid; }) || null;
    if (fid) {
      try { window.localStorage && window.localStorage.setItem("rdh_my_fid", fid); } catch (e) {}
    }
  }

  // ---------- Contract helpers (ported from site/shared/player_profile_master.js:88-167) ----------
  function parseContractMoney(s) {
    if (s == null) return 0;
    s = String(s).trim().replace(/[$,]/g, "");
    var mult = 1;
    if (/K$/i.test(s)) { mult = 1000; s = s.slice(0, -1); }
    else if (/M$/i.test(s)) { mult = 1000000; s = s.slice(0, -1); }
    var n = Number(s);
    return isFinite(n) ? Math.round(n * mult) : 0;
  }
  function parseContractInfo(info) {
    var s = String(info || "");
    var out = { tcv: 0, length: 0, yearVals: {}, aav: 0, gtd: 0 };
    if (!s) return out;
    var m;
    if ((m = s.match(/(?:^|\|)\s*TCV\s+([^|]+)/i))) out.tcv = parseContractMoney(m[1]);
    if ((m = s.match(/(?:^|\|)\s*CL\s*:?\s*(\d+)/i))) out.length = parseInt(m[1], 10) || 0;
    if ((m = s.match(/(?:^|\|)\s*AAV\s+([^|]+)/i))) out.aav = parseContractMoney(m[1]);
    if ((m = s.match(/(?:^|\|)\s*GTD\s*:?\s*([^|]+)/i))) out.gtd = parseContractMoney(m[1]);
    var yearRe = /(?:^|\|)\s*Y(\d+)\s*[=:]\s*([^|]+)/gi;
    while ((m = yearRe.exec(s))) {
      var idx = parseInt(m[1], 10);
      if (idx > 0) out.yearVals[idx] = parseContractMoney(m[2]);
    }
    return out;
  }
  function earnedToDate(rosterRow, info) {
    info = info || parseContractInfo(rosterRow && rosterRow.contractInfo);
    var len = info.length || 0;
    var cy = parseInt(rosterRow && rosterRow.contractYear, 10) || 0;
    var played = Math.max(0, len - cy);
    var earned = 0;
    for (var i = 1; i <= played; i++) {
      earned += info.yearVals[i] || 0;
    }
    return earned;
  }
  // Era-aware dead-cap if dropped today. (TCV × 75%) − Earned, 2019+. Returns
  // null for pre-2019 (formula differs, see league_context_v1.md). Identical
  // to player_profile_master.js:159 dropPenalty.
  function dropPenaltyFor(rosterRow, season) {
    if (!rosterRow) return null;
    var cy = parseInt(rosterRow.contractYear, 10);
    if (cy <= 0) return { amount: 0, note: "Expired contract — no penalty." };
    if (/taxi/i.test(rosterRow.status || "")) return { amount: 0, note: "Taxi — no penalty." };
    var info = parseContractInfo(rosterRow.contractInfo);
    if (!info.tcv) return null;
    var seasonNum = Number(season) || (new Date().getUTCFullYear());
    if (seasonNum < 2019) return null;
    var earned = earnedToDate(rosterRow, info);
    var amount = Math.max(0, Math.round(info.tcv * 0.75) - earned);
    return { amount: amount, note: amount === 0 ? "No dead-cap penalty." : "" };
  }

  // ---------- Trade Bait helpers ----------
  function getMyTradeBaitIds() {
    // MFL tradeBait export shape: { tradeBait: { tradeBait: [{ franchise_id, willGiveUp, willTake/... }, ...] } }
    // or singular tradeBait if only one franchise has it. Return Set of pids
    // belonging to viewer's franchise.
    var ids = new Set();
    var fid = state.viewerFranchiseId;
    if (!fid || !state.tradeBait) return ids;
    var root = state.tradeBait.tradeBait || state.tradeBait;
    var entries = asArray(root && (root.tradeBait || root.franchise || root));
    entries.forEach(function (e) {
      if (!e) return;
      var rowFid = pad4(e.franchise_id || e.id || "");
      if (rowFid !== fid) return;
      var ids_csv = safeStr(e.willGiveUp || e.will_give_up || "");
      ids_csv.split(",").forEach(function (id) {
        var t = id.trim();
        if (t) ids.add(t);
      });
    });
    return ids;
  }
  function getMyTradeBaitLookingFor() {
    var fid = state.viewerFranchiseId;
    if (!fid || !state.tradeBait) return "";
    var root = state.tradeBait.tradeBait || state.tradeBait;
    var entries = asArray(root && (root.tradeBait || root.franchise || root));
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (!e) continue;
      if (pad4(e.franchise_id || e.id || "") === fid) {
        return safeStr(e.willTake || e.willTakeText || e.WILL_TAKE_TEXT || e.lookingFor || "");
      }
    }
    return "";
  }

  // ---------- Submit actions (mirror desktop endpoints exactly) ----------
  function postJson(url, payload) {
    return fetch(url, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {})
    }).then(function (r) {
      return r.text().then(function (body) {
        var parsed = null;
        try { parsed = body ? JSON.parse(body) : null; } catch (e) {}
        if (!r.ok) {
          var msg = (parsed && (parsed.error || parsed.message)) || ("HTTP " + r.status);
          throw new Error(msg);
        }
        return parsed || {};
      });
    });
  }

  // Drop — mirrors roster_workbench.js:10794 submitRosterMove.
  // POST {worker}/roster-workbench/action with action=drop_player.
  function submitDrop(playerId, playerName) {
    var fid = state.viewerFranchiseId;
    if (!fid) return Promise.reject(new Error("No franchise"));
    if (state.busyActionKey) return Promise.reject(new Error("Another action is in progress"));
    state.busyActionKey = "drop:" + playerId;
    var url = workerUrl("/roster-workbench/action");
    return postJson(url, {
      action: "drop_player",
      league_id: state.ctx.leagueId,
      season: state.ctx.year,
      franchise_id: fid,
      player_id: String(playerId)
    }).then(function (resp) {
      state.busyActionKey = "";
      return resp;
    }).catch(function (e) {
      state.busyActionKey = "";
      throw e;
    });
  }

  // Toggle a player on/off the On-the-Block list.
  // /api/submit-trade-bait is a BULK OVERWRITE — we read the current list,
  // flip the player, and re-submit. Preserves lookingFor + other players.
  function submitOTBToggle(playerId, playerName) {
    var fid = state.viewerFranchiseId;
    if (!fid) return Promise.reject(new Error("No franchise"));
    if (state.busyActionKey) return Promise.reject(new Error("Another action is in progress"));
    state.busyActionKey = "otb:" + playerId;
    var current = getMyTradeBaitIds();
    var willBeOn = !current.has(String(playerId));
    if (willBeOn) current.add(String(playerId));
    else current.delete(String(playerId));
    var willGiveUp = [];
    current.forEach(function (id) { willGiveUp.push(id); });
    var playerNames = {};
    willGiveUp.forEach(function (id) {
      var p = playerById(id);
      playerNames[id] = safeStr(p && p.name) || id;
    });
    var franchiseName = state.viewerFranchise && state.viewerFranchise.name || "";
    var lookingFor = getMyTradeBaitLookingFor();
    return postJson(workerUrl("/api/submit-trade-bait"), {
      franchiseId: fid,
      franchiseName: franchiseName,
      willGiveUp: willGiveUp,
      lookingFor: lookingFor,
      notes: {},
      playerNames: playerNames
    }).then(function (resp) {
      state.busyActionKey = "";
      return { resp: resp, isOnBlock: willBeOn };
    }).catch(function (e) {
      state.busyActionKey = "";
      throw e;
    });
  }

  // ---------- Data shaping (mirror team_operations.js) ----------
  function playerById(id) {
    if (!state.players || !state.players.players) return null;
    var list = asArray(state.players.players.player);
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].id) === String(id)) return list[i];
    }
    return null;
  }

  function getRosterFor(fid) {
    if (!state.rosters || !state.rosters.rosters) return [];
    var fr = asArray(state.rosters.rosters.franchise);
    var f = fr.find(function (x) { return pad4(x.id) === pad4(fid); });
    if (!f) return [];
    return asArray(f.player).map(function (p) {
      return {
        id: String(p.id),
        status: safeStr(p.status),
        salary: Number(p.salary || 0),
        contractYear: safeStr(p.contractYear),
        contractStatus: safeStr(p.contractStatus),
        contractInfo: safeStr(p.contractInfo)
      };
    });
  }

  function getAdjustmentTotalFor(fid) {
    var f = pad4(fid);
    if (!f) return 0;
    var root = state.salaryAdjustments && state.salaryAdjustments.salaryAdjustments;
    if (!root) return 0;
    var rows = asArray(root.salaryAdjustment || root.adjustment);
    var total = 0;
    rows.forEach(function (row) {
      if (!row) return;
      var rowFid = pad4(row.franchise_id || row.franchise || row.id || "");
      if (rowFid !== f) return;
      total += Number(row.amount || 0);
    });
    return total;
  }

  // Cap math — mirrors team_operations.js:670-708 exactly.
  // Returns { playerSalaryUsed, taxiSalary, irSalaryFull, expiredSalary,
  //          adjustmentTotal, capTotal, capRoom, pct, capAmount,
  //          rosterCount, activeCount, irCount, taxiCount }
  function computeCap(fid) {
    var roster = getRosterFor(fid);
    var playerSalaryUsed = 0, taxiSalary = 0, irSalaryFull = 0, expiredSalary = 0;
    roster.forEach(function (r) {
      var amt = Number(r.salary || 0);
      var cy = parseInt(r.contractYear, 10);
      if (cy === 0) {
        expiredSalary += amt;
      } else if (/taxi/i.test(r.status)) {
        taxiSalary += amt;
      } else if (/ir|injured/i.test(r.status)) {
        irSalaryFull += amt;
        playerSalaryUsed += Math.round(amt * 0.5);
      } else {
        playerSalaryUsed += amt;
      }
    });
    var adjustmentTotal = getAdjustmentTotalFor(fid);
    var cap = state.capAmount;
    function roundToK(n) { return Math.round(Number(n || 0) / 1000) * 1000; }
    var playerSalaryUsedR = roundToK(playerSalaryUsed);
    var adjustmentTotalR = roundToK(adjustmentTotal);
    var capTotalR = playerSalaryUsedR + adjustmentTotalR;
    var capRoom = cap - capTotalR;
    var pct = cap > 0 ? Math.min(100, Math.round((capTotalR / cap) * 100)) : 0;
    var rosterCount = roster.length;
    var irCount = roster.filter(function (p) { return /ir|injured/i.test(p.status); }).length;
    var taxiCount = roster.filter(function (p) { return /taxi/i.test(p.status); }).length;
    var activeCount = rosterCount - irCount - taxiCount;
    return {
      playerSalaryUsed: playerSalaryUsedR,
      taxiSalary: taxiSalary,
      irSalaryFull: irSalaryFull,
      expiredSalary: expiredSalary,
      adjustmentTotal: adjustmentTotalR,
      capTotal: capTotalR,
      capRoom: capRoom,
      pct: pct,
      capAmount: cap,
      rosterCount: rosterCount,
      activeCount: activeCount,
      irCount: irCount,
      taxiCount: taxiCount
    };
  }

  // ---------- Router ----------
  var routes = {};
  function registerView(name, renderFn) { routes[name] = renderFn; }

  function currentRoute() {
    var hash = (window.location.hash || "").replace(/^#/, "");
    return hash || "myteam/contracts";
  }
  function navigate(hash) {
    if (hash[0] !== "#") hash = "#" + hash;
    if (window.location.hash !== hash) window.location.hash = hash;
    else renderRoute();
  }

  function updateNavActive(route) {
    var top = route.split("/")[0];
    var items = document.querySelectorAll(".ups-m-nav-item");
    for (var i = 0; i < items.length; i++) {
      var r = items[i].getAttribute("data-route");
      if (r === top) items[i].classList.add("active");
      else items[i].classList.remove("active");
    }
  }

  function renderFranchisePicker(main) {
    // Shown when no viewer franchise can be resolved (the common case when
    // the mobile site is hit directly on github.io — MFL cookies are
    // cross-origin and unreadable). User picks once; the fid persists in
    // localStorage (same key team_operations.js uses).
    var opts = state.franchises.map(function (f) {
      return '<button class="ups-m-pick-row" data-fid="' + escapeHtml(f.id) + '">' +
        '<span class="num">' + escapeHtml(f.id) + '</span>' +
        '<span class="name">' + escapeHtml(f.name || "Franchise " + f.id) + '</span>' +
        (f.owner ? '<span class="owner">' + escapeHtml(f.owner) + '</span>' : '') +
        '</button>';
    }).join("");
    main.innerHTML =
      '<div class="ups-m-card">' +
        '<div class="ups-m-card-title">Choose your team</div>' +
        '<div style="font-size:12px;color:var(--fg-muted);margin-bottom:10px">' +
        'We can\'t read MFL\'s session from this device. Pick your franchise once — we\'ll remember it.' +
        '</div>' +
        '<div class="ups-m-pick-list">' + opts + '</div>' +
      '</div>';
    var btns = main.querySelectorAll(".ups-m-pick-row");
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener("click", function () {
        var fid = pad4(this.getAttribute("data-fid"));
        if (!fid) return;
        try { window.localStorage && window.localStorage.setItem("rdh_my_fid", fid); } catch (e) {}
        state.viewerFranchiseId = fid;
        state.viewerFranchise = state.franchises.find(function (f) { return f.id === fid; }) || null;
        renderRoute();
      });
    }
  }

  function renderRoute() {
    var route = currentRoute();
    updateNavActive(route);
    var main = document.getElementById("ups-m-main");
    if (!main) return;
    var parts = route.split("/");
    var top = parts[0];
    var renderFn = routes[top];
    if (!renderFn) {
      main.innerHTML = '<div class="ups-m-stub"><h3>Coming soon</h3><div>' + escapeHtml(top) + '</div></div>';
      return;
    }
    if (!state.loaded) {
      main.innerHTML = '<div class="ups-m-loading">Loading…</div>';
      loadAllData().then(function () { renderRoute(); }).catch(function (e) {
        main.innerHTML = '<div class="ups-m-error">Failed to load: ' + escapeHtml(e && e.message || String(e)) + '</div>';
      });
      return;
    }
    // Franchise gate: every view (except "more") requires viewerFranchiseId.
    if (!state.viewerFranchiseId && top !== "more") {
      renderFranchisePicker(main);
      updateHeader();
      return;
    }
    try {
      renderFn(main, parts.slice(1));
    } catch (e) {
      main.innerHTML = '<div class="ups-m-error">Render error: ' + escapeHtml(e && e.message || String(e)) + '</div>';
    }
    updateHeader();
  }

  function switchTeam() {
    try { window.localStorage && window.localStorage.removeItem("rdh_my_fid"); } catch (e) {}
    state.viewerFranchiseId = "";
    state.viewerFranchise = null;
    renderRoute();
  }

  function updateHeader() {
    var title = document.getElementById("ups-m-header-title");
    var meta = document.getElementById("ups-m-header-meta");
    if (title) {
      title.textContent = state.viewerFranchise
        ? state.viewerFranchise.name
        : "UPS Mobile";
    }
    if (meta) {
      meta.textContent = state.ctx.year;
    }
  }

  function showToast(text, kind) {
    var el = document.getElementById("ups-m-toast");
    if (!el) return;
    el.textContent = text;
    el.className = "ups-m-toast show " + (kind || "");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () {
      el.className = "ups-m-toast " + (kind || "");
    }, 2400);
  }

  // ---------- Stub renderers for views not yet built (Phase 2+) ----------
  function stubView(label, sub) {
    return function (mount) {
      mount.innerHTML =
        '<div class="ups-m-stub">' +
        '<h3>' + escapeHtml(label) + '</h3>' +
        '<div>' + escapeHtml(sub || "Coming in a later phase.") + '</div>' +
        '</div>';
    };
  }
  registerView("players", stubView("Players", "Free-agent browser ships in Phase 3."));
  registerView("league", stubView("League", "Rosters, standings, and On the Block ship in Phase 4."));
  registerView("more", function (mount) {
    var accountLine = state.viewerFranchise
      ? escapeHtml(state.viewerFranchise.name) + (state.viewerFranchise.owner ? ' · ' + escapeHtml(state.viewerFranchise.owner) : '')
      : "No team selected";
    mount.innerHTML =
      '<div class="ups-m-card">' +
        '<div class="ups-m-card-title">Your team</div>' +
        '<div style="font-size:14px;margin-bottom:10px">' + accountLine + '</div>' +
        '<button class="ups-m-pick-row" id="ups-m-switch-team" style="width:100%;justify-content:center"><span class="name">Switch team</span></button>' +
      '</div>' +
      '<a class="ups-m-desktop-link" href="https://www48.myfantasyleague.com/' + escapeHtml(state.ctx.year) + '/home/' + escapeHtml(state.ctx.leagueId) + '">Switch to Pro Site</a>' +
      '<div class="ups-m-stub"><div>UPS Mobile · Phase 1</div><div style="font-size:11px;margin-top:6px">League ' + escapeHtml(state.ctx.leagueId) + ' · ' + escapeHtml(state.ctx.year) + '</div></div>';
    var btn = document.getElementById("ups-m-switch-team");
    if (btn) btn.addEventListener("click", switchTeam);
  });

  // ---------- Boot ----------
  function boot() {
    detectContext();
    window.addEventListener("hashchange", renderRoute);
    renderRoute();
  }

  // ---------- Public API ----------
  window.UPS_MOBILE = {
    boot: boot,
    state: state,
    util: {
      safeStr: safeStr,
      pad4: pad4,
      escapeHtml: escapeHtml,
      fmtUsd: fmtUsd,
      asArray: asArray,
      readCookie: readCookie
    },
    api: {
      workerBase: workerBase,
      workerUrl: workerUrl,
      mflExportUrl: mflExportUrl,
      fetchJson: fetchJson,
      loadAllData: loadAllData
    },
    data: {
      playerById: playerById,
      getRosterFor: getRosterFor,
      getAdjustmentTotalFor: getAdjustmentTotalFor,
      computeCap: computeCap,
      parseContractInfo: parseContractInfo,
      earnedToDate: earnedToDate,
      dropPenaltyFor: dropPenaltyFor,
      getMyTradeBaitIds: getMyTradeBaitIds,
      getMyTradeBaitLookingFor: getMyTradeBaitLookingFor
    },
    actions: {
      submitDrop: submitDrop,
      submitOTBToggle: submitOTBToggle,
      reloadData: reloadData
    },
    route: {
      registerView: registerView,
      navigate: navigate,
      currentRoute: currentRoute,
      renderRoute: renderRoute
    },
    ui: {
      showToast: showToast,
      updateHeader: updateHeader
    }
  };
})();
